import { validateQzonePolicy } from './qzone-policy.js';
import { normalizeOwnerNotifications } from './owner-notifications.js';

/** Hermes 3.5, PURE config upgrade: no fs/env/clock/model, runtime, sends or jobs.
 * The host verifies owner/account identity, then supplies IDs that only NARROW
 * privateChats.ownerUserIds (legacy instructionUserIds) and existing registry.
 * Neither config IDs, a group-admin role nor a model assertion authenticates.
 * The host owns CAS, validation, backup and atomic persistence of result.config.
 * Do NOT log result.config: it retains the input's secrets. report has only
 * static paths, numeric indexes, fixed codes/counts; never values or raw IDs.
 *
 * autonomousSocial.version === 1 is the ONE-SHOT installation marker. Re-running
 * never fills a subsequently removed field or re-enables a later opt-out. New
 * accounts use createAutonomousSocialStarter explicitly, not another migration.
 * Defaults are preferences, NOT capabilities/consent/grants or a send queue.
 * Runtime must intersect every flag with current scope/quiet/budget/capability.
 *
 * ONE master only: version/enabled/guidance/delegation/reconstruction/optOut/paused.
 * No ownerSocial/task35 section, second enable switch or new budget. Delegation
 * and reconstruction read this master directly, with existing taskMode/social
 * daily limits and actual capability/scope gates. The host sanitizer can use the
 * independent normalizer below (partial:true for patches). Seven new options.
 * Reconstruction never starts a scan here: the host must also verify original
 * source identities and each historical/current scope. Verified current account
 * IDs are NOT historical access authority or permission to scan all groups.
 *
 * QZone exception is intentional CURRENT migration authority: only an existing
 * enabled + publish.enabled + reviewed policy with EXPLICIT valid ugcRight and
 * allowedAudiences transitions to scoped_autonomy, even if autonomy.enabled was
 * the old default false. It never changes reads/likes/comments/audiences/sources,
 * and never runs for a future account starter or claims protocol availability.
 */
export const AUTONOMOUS_SOCIAL_VERSION = 1;
export const AUTONOMOUS_SOCIAL_NEW_OPTIONS = Object.freeze([
  ...['version', 'enabled', 'guidance', 'delegation', 'reconstruction', 'optOut', 'paused'].map(k => `autonomousSocial.${k}`),
]);
const MASTER_KEYS = ['version', 'enabled', 'guidance', 'delegation', 'reconstruction', 'optOut', 'paused'];
const BAD = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const own = (v, k) => Object.hasOwn(v, k);
const qq = v => typeof v === 'string' && /^[1-9][0-9]{4,19}$/.test(v);
const accountId = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) && !BAD.has(v);
// Config is JSON data. Clone each occurrence separately so a caller's accidental
// shared template object cannot couple two otherwise independent accounts.
const copy = v => v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(copy)
  : Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
class MigrationError extends TypeError {
  constructor(code) { super(`AUTONOMOUS_SOCIAL_${code}`); this.code = this.message; }
}
const demand = (condition, code) => { if (!condition) throw new MigrationError(code); };
function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v))
    && Reflect.ownKeys(v).every(k => typeof k === 'string' && !BAD.has(k)
      && own(Object.getOwnPropertyDescriptor(v, k), 'value') && Object.getOwnPropertyDescriptor(v, k).enumerable);
}
const keys = (v, allowed) => record(v) && Object.keys(v).every(k => allowed.includes(k));
function list(v, max = 128) {
  return Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max
    && Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(k => k === 'length'
      || typeof k === 'string' && /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length
      && own(Object.getOwnPropertyDescriptor(v, k), 'value') && Object.getOwnPropertyDescriptor(v, k).enumerable);
}
function jsonData(value) {
  let nodes = 0;
  const walk = (v, depth) => {
    demand(++nodes <= 100_000 && depth <= 24, 'INPUT_BOUNDS');
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') { demand(v.length <= 65536, 'INPUT_BOUNDS'); return; }
    demand(record(v) || list(v, 4096), 'INVALID_DATA');
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(value, 0);
  demand(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4 * 1024 * 1024, 'INPUT_BOUNDS');
}
function normalize(raw, allowed, defaults, options) {
  demand(keys(options, ['partial']) && (options.partial === undefined || typeof options.partial === 'boolean'), 'NORMALIZE_OPTIONS');
  demand(keys(raw, allowed), 'INVALID_POLICY');
  const result = options.partial === true ? {} : { ...defaults };
  for (const k of allowed) {
    if (!own(raw, k)) continue;
    demand(k === 'version' ? raw[k] === 1 : typeof raw[k] === 'boolean', 'INVALID_POLICY');
    result[k] = raw[k];
  }
  return result;
}
/** Safe read defaults are OFF. Migration, not a normalizer, installs true defaults.
 * Patch mode returns only supplied keys; no unrelated switch can be reset. */
export function normalizeAutonomousSocialPolicy(raw = {}, options = {}) {
  return normalize(raw, MASTER_KEYS, { version: 1, enabled: false, guidance: false, delegation: false,
    reconstruction: false, optOut: false, paused: false }, options);
}
function report(status = 'unchanged') {
  return { version: 1, status, changedPaths: [], keptDisabled: [], unavailable: [], verifiedOwnerCount: 0,
    verifiedAccountCount: 0, warnings: [] };
}
const note = (r, category, path, reason) => {
  if (!r[category].some(x => x.path === path && x.reason === reason)) r[category].push({ path, reason });
};
function missing(target, key, value, path, r) {
  if (own(target, key)) return;
  target[key] = copy(value); r.changedPaths.push(`${path}.${key}`);
}
function container(target, key) {
  if (!own(target, key)) target[key] = {};
  return target[key];
}
function blocker(v) {
  if (v === undefined) return null;
  if (!record(v)) return 'INVALID_POLICY';
  for (const k of ['enabled', 'optOut', 'paused', 'frozen', 'growthFrozen']) {
    if (own(v, k) && typeof v[k] !== 'boolean') return 'INVALID_POLICY';
  }
  if (v.optOut === true) return 'EXPLICIT_OPT_OUT';
  if (v.paused === true || ['paused', 'stopped'].includes(v.status) || v.mode === 'paused') return 'PAUSED';
  if (v.frozen === true || v.growthFrozen === true || v.status === 'frozen' || v.mode === 'frozen') return 'FROZEN';
  if (v.enabled === false || ['off', 'disabled', 'quiet', 'silent'].includes(v.behaviorMode)) return 'EXPLICIT_FALSE';
  return null;
}
function blocked(v, path, r, shadow = false) {
  const reason = blocker(v) || (shadow && own(v || {}, 'shadowMode')
    ? typeof v.shadowMode !== 'boolean' ? 'INVALID_POLICY' : v.shadowMode ? 'OBSERVATION_ONLY' : null : null);
  if (!reason) return false;
  note(r, 'keptDisabled', path, reason); return true;
}
function identities(config, options, r) {
  const chats = record(config.privateChats) ? config.privateChats : {};
  const configured = own(chats, 'ownerUserIds') ? chats.ownerUserIds : chats.instructionUserIds;
  const real = list(configured, 32) ? configured.filter(qq) : [];
  const verified = options.verifiedOwnerIds || [];
  demand(list(verified, 32) && verified.every(qq) && new Set(verified).size === verified.length, 'INVALID_OWNER_IDS');
  const owners = verified.filter(id => real.includes(id));
  if (real.length !== (Array.isArray(configured) ? configured.length : 0)) r.warnings.push('INVALID_CONFIGURED_OWNER_IDS');
  r.verifiedOwnerCount = owners.length;
  return owners;
}
function entries(config, r) {
  if (!record(config.accounts)) return [];
  const a = config.accounts;
  let rows;
  if (own(a, 'items') || a.version === 2) {
    demand(a.version === 2 && list(a.items, 64), 'INVALID_REGISTRY');
    rows = a.items.map((item, i) => ({ item, path: `accounts.items[${i}]` }));
  } else {
    demand(!own(a, 'standbys') || list(a.standbys, 63), 'INVALID_REGISTRY');
    rows = [...(own(a, 'primary') ? [{ item: a.primary, path: 'accounts.primary' }] : []),
      ...(a.standbys || []).map((item, i) => ({ item, path: `accounts.standbys[${i}]` }))];
  }
  const counts = new Map();
  for (const { item } of rows) if (record(item) && accountId(item.id)) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  return rows.filter(row => {
    const valid = record(row.item) && accountId(row.item.id) && counts.get(row.item.id) === 1;
    if (!valid) note(r, 'unavailable', row.path, 'INVALID_OR_DUPLICATE_ACCOUNT_ID');
    return valid;
  });
}
function groups(config, rows) {
  if (!record(config.accounts)) return [];
  const raw = config.accounts.failoverGroups;
  demand(raw === undefined || list(raw, 64), 'INVALID_REGISTRY');
  const members = new Set(), ids = new Set();
  return (raw || []).map((g, i) => {
    demand(record(g) && accountId(g.id) && !ids.has(g.id) && list(g.memberIds, 64) && g.memberIds.length > 0
      && g.memberIds.every(id => accountId(id) && rows.some(row => row.item.id === id) && !members.has(id))
      && new Set(g.memberIds).size === g.memberIds.length && record(g.policy)
      && (!own(g, 'policyAccountId') || g.memberIds.includes(g.policyAccountId)), 'INVALID_FAILOVER_GROUP');
    ids.add(g.id); g.memberIds.forEach(id => members.add(id));
    return { group: g, path: `accounts.failoverGroups[${i}].policy` };
  });
}
function conversationAllowed(value, item, config, starter) {
  if (typeof value !== 'string' || !/^(group|private):[1-9][0-9]{4,19}$/.test(value)) return false;
  const [kind, id] = value.split(':'), scope = item.scope;
  if (scope !== undefined && !record(scope)) return false;
  if (kind === 'private') {
    const pc = config.privateChats;
    if (scope?.private === false || !record(pc) || pc.enabled !== true) return false;
    if (starter && scope?.private !== true) return false;
    return list(pc.targetUsers, 512) && pc.targetUsers.includes(id)
      || !starter && list(pc.targetUsers, 512) && pc.targetUsers.includes('*');
  }
  if (scope?.groups === false) return false;
  const mode = scope?.groupMode;
  if (starter && (mode !== 'allowlist' || scope?.groups !== true)) return false;
  if (mode !== undefined && !['all', 'allowlist'].includes(mode)) return false;
  if (mode === 'allowlist' && (!list(scope.groupIds, 128) || !scope.groupIds.every(qq) || !scope.groupIds.includes(id))) return false;
  if (own(config, 'targetGroups') && (!list(config.targetGroups, 512)
    || !config.targetGroups.includes(id) && !config.targetGroups.includes('*'))) return false;
  if (config.blockedGroups !== undefined) {
    if (!list(config.blockedGroups, 512) || config.blockedGroups.includes(id)) return false;
  }
  return true;
}
function scoped(policy, item, config, starter, path, r, allowed) {
  const values = policy?.conversationIds;
  const valid = list(values, 128) && values.length > 0 && new Set(values).size === values.length
    && values.every(value => conversationAllowed(value, item, config, starter) && (!allowed || allowed.includes(value)));
  if (!valid) note(r, 'unavailable', path, 'NO_VALID_EXISTING_CONVERSATION_SCOPE');
  return valid;
}
function enableLeaf(parent, key, values, path, r) {
  if (blocked(parent[key], `${path}.${key}`, r)) return;
  const leaf = container(parent, key);
  for (const [field, value] of Object.entries(values)) missing(leaf, field, value, `${path}.${key}`, r);
}
function socialDefaults(target, item, config, path, profile, starter, r, only) {
  const shadow = profile === 'observant';
  if (only !== 'socialExperience' && !blocked(target.socialAgent, `${path}.socialAgent`, r, true)
    && scoped(target.socialAgent, item, config, starter, `${path}.socialAgent`, r)) {
    const social = target.socialAgent;
    missing(social, 'enabled', true, `${path}.socialAgent`, r);
    missing(social, 'shadowMode', shadow, `${path}.socialAgent`, r);
    enableLeaf(social, 'roleCard', { enabled: true, autoGrow: !shadow }, `${path}.socialAgent`, r);
    if (item.features?.proactive === false) note(r, 'keptDisabled', `${path}.features.proactive`, 'EXPLICIT_FALSE');
    else enableLeaf(social, 'agency', { enabled: true }, `${path}.socialAgent`, r);
    if (!shadow && !blocked(social.discovery, `${path}.socialAgent.discovery`, r, true)
      && scoped(social.discovery, item, config, starter, `${path}.socialAgent.discovery`, r, social.conversationIds)) {
      missing(social.discovery, 'enabled', true, `${path}.socialAgent.discovery`, r);
      missing(social.discovery, 'shadowMode', false, `${path}.socialAgent.discovery`, r);
    }
  }
  if (only !== 'socialAgent' && !blocked(target.socialExperience, `${path}.socialExperience`, r, true)
    && scoped(target.socialExperience, item, config, starter, `${path}.socialExperience`, r)) {
    const social = target.socialExperience;
    missing(social, 'enabled', true, `${path}.socialExperience`, r);
    missing(social, 'shadowMode', shadow, `${path}.socialExperience`, r);
    missing(social, 'behaviorPreset', profile, `${path}.socialExperience`, r);
    enableLeaf(social, 'expression', { enabled: true }, `${path}.socialExperience`, r);
    enableLeaf(social, 'style', { enabled: true }, `${path}.socialExperience`, r);
    if (item.sendTypes?.image === false) note(r, 'keptDisabled', `${path}.sendTypes.image`, 'EXPLICIT_FALSE');
    else enableLeaf(social, 'stickers', { enabled: !shadow, autoSend: !shadow, groupLearning: !shadow,
      autonomousEligibility: !shadow, autonomousSelection: !shadow }, `${path}.socialExperience`, r);
  }
}
function qzoneUpgrade(target, path, r) {
  const q = target.qzone, base = `${path}.qzone`;
  if (q === undefined) { note(r, 'unavailable', base, 'QZONE_NOT_CONFIGURED'); return; }
  if (blocked(q, base, r) || blocked(q.publish, `${base}.publish`, r)) return;
  if (q.mode === 'draft_only') { note(r, 'keptDisabled', base, 'EXPLICIT_DRAFT_ONLY'); return; }
  if (q.mode !== 'reviewed' || q.enabled !== true || q.publish?.enabled !== true) {
    note(r, 'unavailable', base, 'QZONE_EXISTING_PUBLISH_AUTHORITY_REQUIRED'); return;
  }
  // Unlike the general enabled:false fence, this exact legacy false is covered
  // by the user's current reviewed->scoped_autonomy migration authorization.
  if (q.autonomy !== undefined && (!record(q.autonomy) || q.autonomy.optOut === true || q.autonomy.paused === true
    || q.autonomy.frozen === true || q.autonomy.growthFrozen === true)) {
    note(r, 'keptDisabled', `${base}.autonomy`, 'QZONE_AUTONOMY_FENCED'); return;
  }
  if (!own(q, 'allowedAudiences') || !own(q, 'ugcRight')) {
    note(r, 'unavailable', base, 'QZONE_EXPLICIT_AUDIENCE_REQUIRED'); return;
  }
  try { validateQzonePolicy(q); }
  catch { note(r, 'unavailable', base, 'QZONE_POLICY_INVALID'); return; }
  q.mode = 'scoped_autonomy'; r.changedPaths.push(`${base}.mode`);
  const autonomy = container(q, 'autonomy');
  if (autonomy.enabled !== true) { autonomy.enabled = true; r.changedPaths.push(`${base}.autonomy.enabled`); }
}
function capabilityReport(options, id, path, r) {
  const caps = options.capabilitiesByAccount?.[id];
  for (const [feature, suffix] of Object.entries({ social: 'socialAgent', stickers: 'socialExperience.stickers',
    qzonePublish: 'qzone', delegation: 'features.task' })) {
    if (caps?.[feature] !== true) note(r, 'unavailable', `${path}.${suffix}`,
      caps?.[feature] === false ? 'CAPABILITY_UNAVAILABLE' : 'CAPABILITY_NOT_ATTESTED');
  }
}
function notifications(config, owners, r) {
  if (blocked(config.ownerNotifications, 'ownerNotifications', r)) return;
  const existing = config.ownerNotifications;
  try { normalizeOwnerNotifications(existing); }
  catch { note(r, 'unavailable', 'ownerNotifications', 'INVALID_NOTIFICATION_POLICY'); return; }
  const n = container(config, 'ownerNotifications');
  missing(n, 'times', ['09:00', '21:00'], 'ownerNotifications', r);
  missing(n, 'timezone', 'Asia/Shanghai', 'ownerNotifications', r);
  if (config.privateChats?.enabled !== false && list(n.recipients, 32) && n.recipients.length > 0
    && n.recipients.every(id => owners.includes(id))) missing(n, 'enabled', true, 'ownerNotifications', r);
  else note(r, 'unavailable', 'ownerNotifications', 'EXISTING_VERIFIED_NOTIFICATION_ROUTE_REQUIRED');
}
function taskReadiness(config, r) {
  if (blocked(config.taskMode, 'taskMode', r, true)) return;
  // Readiness remains unknown: no task permissions, models, tools, backend or
  // target scopes are invented by these preference flags.
  if (!list(config.taskMode?.allowedGroupIds, 128) || !config.taskMode.allowedGroupIds.length
    || !config.taskMode.allowedGroupIds.every(qq)) note(r, 'unavailable', 'taskMode', 'NO_EXISTING_TASK_GROUP_SCOPE');
}
function finish(config, r) {
  r.changedPaths = [...new Set(r.changedPaths)].sort();
  return { ok: true, changed: r.changedPaths.length > 0, config, report: r };
}
function run(input, rawOptions, starter) {
  const r = report();
  try {
    demand(record(input), 'INVALID_CONFIG'); jsonData(input);
    demand(keys(rawOptions, ['verifiedOwnerIds', 'verifiedAccountIds', 'capabilitiesByAccount', ...(starter ? ['accountId', 'profile'] : [])]), 'OPTIONS');
    jsonData(rawOptions);
    const options = copy(rawOptions), config = copy(input);
    const ids = options.verifiedAccountIds || [];
    demand(list(ids, 64) && ids.every(accountId) && new Set(ids).size === ids.length, 'INVALID_ACCOUNT_IDS');
    if (options.capabilitiesByAccount !== undefined) demand(record(options.capabilitiesByAccount)
      && Object.keys(options.capabilitiesByAccount).length <= 64 && Object.entries(options.capabilitiesByAccount).every(([id, caps]) => accountId(id)
        && keys(caps, ['social', 'stickers', 'qzonePublish', 'delegation']) && Object.values(caps).every(v => typeof v === 'boolean')), 'CAPABILITIES');
    const owners = identities(config, options, r);
    if (!owners.length) { r.status = 'no-owner'; note(r, 'unavailable', 'autonomousSocial', 'VERIFIED_CONFIGURED_OWNER_REQUIRED'); return finish(config, r); }
    if (starter) demand(accountId(options.accountId) && ['observant', 'balanced', 'engaged'].includes(options.profile), 'STARTER');
    if (blocked(config.autonomousSocial, 'autonomousSocial', r)) { r.status = 'opted-out'; return finish(config, r); }
    try { normalizeAutonomousSocialPolicy(config.autonomousSocial); }
    catch { r.status = 'invalid-policy'; note(r, 'unavailable', 'autonomousSocial', 'UNSUPPORTED_OR_INVALID_POLICY'); return finish(config, r); }
    if (!starter && config.autonomousSocial?.version === 1) { r.status = 'already-migrated'; return finish(config, r); }
    const rows = entries(config, r), shared = groups(config, rows);
    // Legacy failover has no persisted policy object: the registry derives its
    // shared policy from the primary. Mutate that existing owner only, not peers.
    if (!own(config.accounts || {}, 'items') && rows.length > 1 && !shared.length
      && (config.accounts.topology === undefined || config.accounts.topology === 'failover')) {
      shared.push({ group: { memberIds: rows.map(row => row.item.id), policyAccountId: rows[0].item.id,
        policy: rows[0].item }, path: rows[0].path });
    }
    const selected = rows.filter(row => ids.includes(row.item.id) && (!starter || row.item.id === options.accountId));
    r.verifiedAccountCount = selected.length;
    if (!selected.length) { r.status = 'no-account'; note(r, 'unavailable', 'accounts', 'VERIFIED_EXISTING_ACCOUNT_REQUIRED'); return finish(config, r); }
    if (!selected.some(row => row.item.enabled === true && !blocker(row.item)
      && row.item.archived !== true && row.item.protocolEnabled !== false)) {
      r.status = 'no-enabled-account';
      for (const row of selected) note(r, 'keptDisabled', row.path, 'VERIFIED_ENABLED_ACCOUNT_REQUIRED');
      return finish(config, r);
    }
    const selectedIds = new Set(selected.map(row => row.item.id)), visited = new Set();
    for (const row of selected) {
      if (blocked(row.item, row.path, r) || row.item.enabled !== true || row.item.archived === true || row.item.protocolEnabled === false) {
        note(r, 'keptDisabled', row.path, 'ACCOUNT_INACTIVE'); continue;
      }
      const membership = shared.find(g => g.group.memberIds.includes(row.item.id));
      let target = row.item, context = row.item, path = row.path, policySource = row;
      if (membership) {
        if (starter || membership.group.memberIds.some(id => !selectedIds.has(id))) {
          note(r, 'unavailable', membership.path, 'SHARED_IDENTITY_REQUIRES_ALL_MEMBERS_VERIFIED'); continue;
        }
        if (membership.group.memberIds.some(id => {
          const member = rows.find(row => row.item.id === id).item;
          return blocker(member) || member.enabled !== true || member.archived === true || member.protocolEnabled === false;
        })) { note(r, 'keptDisabled', membership.path, 'SHARED_MEMBER_INACTIVE'); continue; }
        target = membership.group.policy; path = membership.path;
        policySource = rows.find(r => r.item.id === membership.group.policyAccountId)
          || rows.find(r => r.item.id === membership.group.memberIds[0]);
        // Match the registry's inherited source policy without ever materializing
        // its prompts/scope/model/budget defaults into the returned config.
        context = { ...policySource.item, ...target };
        for (const key of ['scope', 'features', 'sendTypes']) context[key] = { ...(policySource.item[key] || {}), ...(target[key] || {}) };
      }
      if (blocked(target, path, r)) continue;
      if (!visited.has(path)) {
        if (context.features?.chat === false) note(r, 'keptDisabled', `${path}.features.chat`, 'EXPLICIT_FALSE');
        else if (context.sendTypes?.text === false) note(r, 'keptDisabled', `${path}.sendTypes.text`, 'EXPLICIT_FALSE');
        else if (membership) {
          // Omitted shared sections inherit the source account as a whole. Add
          // defaults at that source instead of copying conversation/contact IDs
          // into a newly materialized shared policy section.
          for (const section of ['socialAgent', 'socialExperience']) {
            const holder = own(target, section) ? { item: target, path } : policySource;
            socialDefaults(holder.item, context, config, holder.path, 'balanced', false, r, section);
          }
        } else socialDefaults(target, context, config, path, options.profile || 'balanced', starter, r);
      }
      if (!starter) {
        if (membership && !own(membership.group.policy, 'qzone')) qzoneUpgrade(row.item, row.path, r);
        else if (!visited.has(path)) qzoneUpgrade(target, path, r);
      }
      visited.add(path);
      capabilityReport(options, row.item.id, path, r);
    }
    if (!starter) {
      const master = container(config, 'autonomousSocial');
      for (const [key, value] of Object.entries({ version: 1, enabled: true, guidance: true, delegation: true,
        reconstruction: true, optOut: false, paused: false })) missing(master, key, value, 'autonomousSocial', r);
      taskReadiness(config, r); notifications(config, owners, r);
    }
    r.status = starter ? 'starter-applied' : 'installed';
    return finish(config, r);
  } catch (e) {
    // Never echo exception text, input, arbitrary keys, identifiers or credentials.
    r.status = 'invalid'; r.changedPaths = [];
    note(r, 'unavailable', 'config', e instanceof MigrationError ? e.code : 'AUTONOMOUS_SOCIAL_INVALID');
    return { ok: false, changed: false, report: r };
  }
}

export function migrateAutonomousSocialConfig(config, options = {}) { return run(config, options, false); }
/** Explicit future-account helper: exact existing account only, no all/wildcard
 * scope derivation, no peer/shared identity changes, no top-level toggles and NO
 * automatic QZone standing-authorization upgrade. Already explicit flags win.
 * Use after the host installs that account's own scope/persona/model settings. */
export function createAutonomousSocialStarter(config, options = {}) { return run(config, options, true); }
