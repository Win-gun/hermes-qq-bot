import { accountItems, accountGroup, effectiveAccount, registryConfig } from './account-registry.js';
import { normalizeAutomationRoutines, publicAutomationRoutines, routineCatalog, patchAutomationRoutines } from './legacy-automation.js';
import { validateAutomationRules } from './automation-rules.js';

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ rules: [], routines: { version: 1 }, legacyRuleIds: [], legacyRoutineLedger: {} });
export const hasOwnedAutomation = entry => Boolean(entry?.rules?.length || entry?.routines?.daily?.schedules?.length || entry?.routines?.hourly);

// Changing topology must not hide a populated account directory or silently
// copy its rules to another bot. A separate explicit transfer is required.
export function assertAutomationOwnershipTransition(current, candidate) {
  const before = normalizeAccountAutomation(current);
  for (const item of accountItems(before)) {
    const oldOwner = ownerFor(before, item.id);
    if (!hasOwnedAutomation(slot(before, oldOwner))) continue;
    let nextOwner;
    try { nextOwner = ownerFor(candidate, item.id); } catch { throw new TypeError('账号仍有自动化，不能移除或归档'); }
    if (oldOwner.key !== nextOwner.key) throw new TypeError('此账号有独立自动化；请先明确迁移规则归属，再修改接管组关系');
  }
}
function ownerFor(config, id) {
  const account = accountItems(config).find(item => item.id === id);
  if (!account) throw new TypeError('账号不存在或已归档');
  const group = accountGroup(config, id);
  return group ? { key: `group:${group.id}`, kind: 'group', id: group.id, memberIds: [...group.memberIds] }
    : { key: `account:${id}`, kind: 'account', id };
}
function slot(config, owner) {
  const map = config.automation[owner.kind === 'group' ? 'groups' : 'accounts'];
  return Object.hasOwn(map, owner.id) ? map[owner.id] : undefined;
}
function target(owner) { return owner.kind === 'group' ? { groupId: owner.id } : { accountId: owner.id }; }
function originalOwner(config) {
  const items = accountItems(config);
  const id = config.accounts?.legacyPrimaryId || config.accounts?.primary?.id || items[0]?.id;
  return items.some(item => item.id === id) ? ownerFor(config, id) : null;
}
function declaredOwner(config, item, fallback) {
  if (item.accountId && item.groupId) throw new TypeError('自动化账号与接管组互斥');
  if (item.accountId) return ownerFor(config, item.accountId);
  if (item.groupId) {
    const group = config.accounts.failoverGroups.find(group => group.id === item.groupId);
    if (!group) throw new TypeError('自动化引用的接管组不存在');
    return { key: `group:${group.id}`, kind: 'group', id: group.id, memberIds: [...group.memberIds] };
  }
  if (!fallback) throw new TypeError('自动化缺少账号归属');
  return fallback;
}
function bindRules(rules, owner, strictTarget = false) {
  if (!Array.isArray(rules)) throw new TypeError('自动化规则必须是数组');
  const bound = rules.map(rule => {
    if (!object(rule)) throw new TypeError('自动化规则格式无效');
    const expected = target(owner);
    if (strictTarget && ((rule.accountId && rule.accountId !== expected.accountId)
      || (rule.groupId && rule.groupId !== expected.groupId))) throw new TypeError('不能在此账号编辑其他账号的自动化');
    const { accountId, groupId, ...rest } = rule;
    return { ...rest, ...expected };
  });
  const result = validateAutomationRules(bound);
  if (!result.valid) throw new TypeError(`自动化规则无效：${result.errors.map(error => error.message).join('; ')}`);
  return result.rules;
}
function setEnabled(config, owner, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('自动化开关必须是布尔值');
  const row = owner.kind === 'group' ? config.accounts.failoverGroups.find(group => group.id === owner.id)?.policy
    : config.accounts.items.find(account => account.id === owner.id);
  if (!row) throw new TypeError('自动化账号归属不存在');
  row.features = { ...row.features, automation: enabled };
}
function ensureEntry(entry) {
  if (!object(entry)) throw new TypeError('账号自动化目录格式无效');
  return { ...clone(entry), rules: clone(entry.rules || []), routines: clone(entry.routines || { version: 1 }),
    legacyRuleIds: [...new Set(entry.legacyRuleIds || [])], legacyRoutineLedger: { ...entry.legacyRoutineLedger } };
}

// Migration is deterministic and read-only. Runtime selection/connection health
// never participates in choosing an owner; missing owners are quarantined.
export function normalizeAccountAutomation(input) {
  let config = registryConfig(input);
  config.automation ||= {};
  const old = clone(config.automation);
  const migrating = old.ownershipVersion !== 1;
  config.automation.accounts = clone(old.accounts || {});
  config.automation.groups = clone(old.groups || {});
  config.automation.unassigned = clone(old.unassigned || []);
  for (const item of accountItems(config)) {
    const owner = ownerFor(config, item.id);
    const map = config.automation[owner.kind === 'group' ? 'groups' : 'accounts'];
    map[owner.id] = ensureEntry(Object.hasOwn(map, owner.id) ? map[owner.id] : empty());
  }
  if (migrating) {
    const fallback = originalOwner(config);
    // Registry migration already supplies defaults for legacy accounts. Existing
    // explicit per-account feature switches must not be reset by a stale global flag.
    for (const rule of old.rules || []) {
      try {
        const owner = declaredOwner(config, rule, fallback), entry = slot(config, owner);
        entry.rules.push(...bindRules([rule], owner));
        entry.legacyRuleIds.push(rule.id);
      } catch (error) { config.automation.unassigned.push({ kind: 'rule', value: clone(rule), reason: error.message }); }
    }
    const legacy = normalizeAutomationRoutines({ ...config, automation: old }).automation.routines;
    for (const kind of ['daily', 'hourly']) if (object(legacy[kind])) {
      try {
        const owner = declaredOwner(config, legacy[kind], fallback), entry = slot(config, owner);
        const { accountId, groupId, ...routine } = legacy[kind];
        entry.routines[kind] = clone(routine);
        entry.legacyRoutineLedger[kind] = true;
      } catch (error) { config.automation.unassigned.push({ kind, value: clone(legacy[kind]), reason: error.message }); }
    }
  }
  config.automation.ownershipVersion = 1;
  // The old fields are disabled views, never another source of runnable rules.
  config.automation.rules = [];
  config.automation.routines = { version: 1 };
  config.dailyMessages = { enabled: false, schedules: [] };
  config.hourlyChat = { enabled: false };
  const owners = new Set();
  for (const item of accountItems(config)) {
    const owner = ownerFor(config, item.id);
    if (owners.has(owner.key)) continue;
    owners.add(owner.key);
    const entry = slot(config, owner);
    entry.rules = bindRules(entry.rules, owner, true);
    entry.legacyRuleIds = [...new Set(entry.legacyRuleIds)];
    if (entry.routines.version !== 1) throw new TypeError('不支持的账号例行规则版本');
  }
  config.automation.enabled = accountItems(config).some(item => effectiveAccount(config, item.id)?.features.automation === true);
  return registryConfig(config);
}

export function automationOwnerEntries(input) {
  const config = normalizeAccountAutomation(input), seen = new Set(), result = [];
  for (const item of accountItems(config)) {
    const owner = ownerFor(config, item.id);
    if (seen.has(owner.key)) continue;
    seen.add(owner.key);
    result.push({ ...clone(slot(config, owner)), key: owner.key, ...target(owner) });
  }
  return result;
}
export function automationForAccount(input, id) {
  const config = normalizeAccountAutomation(input), owner = ownerFor(config, id), entry = slot(config, owner);
  const projected = { ...config, automation: { routines: clone(entry.routines) } };
  return { owner, enabled: effectiveAccount(config, id).features.automation === true,
    rules: clone(entry.rules), routines: publicAutomationRoutines(projected), catalog: routineCatalog(projected),
    shared: owner.kind === 'group', unassignedCount: config.automation.unassigned.length };
}
export function patchAccountAutomation(input, id, patch) {
  if (!object(patch) || Object.keys(patch).some(key => !['enabled', 'rules', 'routines'].includes(key))) throw new TypeError('账号自动化字段无效');
  const config = normalizeAccountAutomation(input), owner = ownerFor(config, id), entry = slot(config, owner);
  if (Object.hasOwn(patch, 'enabled')) setEnabled(config, owner, patch.enabled);
  if (Object.hasOwn(patch, 'rules')) entry.rules = bindRules(patch.rules, owner, true);
  if (Object.hasOwn(patch, 'routines')) {
    for (const kind of ['daily', 'hourly']) if (object(patch.routines?.[kind])
      && ['accountId', 'groupId'].some(key => Object.hasOwn(patch.routines[kind], key))) throw new TypeError('例行规则归属不可在其他账号目录修改');
    const projected = patchAutomationRoutines({ ...config, automation: { routines: entry.routines } }, patch.routines);
    entry.routines = projected.automation.routines;
  }
  return normalizeAccountAutomation(config);
}
export function syncLegacyAutomationPatch(current, next, patch) {
  let config = normalizeAccountAutomation(next);
  if (!object(patch.automation)) return config;
  if (Object.hasOwn(patch.automation, 'enabled')) {
    const seen = new Set();
    for (const item of accountItems(config)) {
      const owner = ownerFor(config, item.id);
      if (!seen.has(owner.key)) { setEnabled(config, owner, patch.automation.enabled); seen.add(owner.key); }
    }
  }
  if (Object.hasOwn(patch.automation, 'rules')) {
    const rules = patch.automation.rules;
    if (!Array.isArray(rules) || !rules.length || rules.some(rule => !rule.accountId && !rule.groupId)) throw new TypeError('请在所选账号的自动化目录保存规则，不支持无归属或全局清空');
    const touched = new Map();
    for (const rule of rules) {
      const owner = declaredOwner(config, rule, null);
      if (!touched.has(owner.key)) touched.set(owner.key, { owner, rules: [] });
      touched.get(owner.key).rules.push(rule);
    }
    for (const { owner, rules: entries } of touched.values()) slot(config, owner).rules = bindRules(entries, owner);
  }
  return normalizeAccountAutomation(config);
}
