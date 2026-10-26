import { randomUUID } from "node:crypto";
import { socialAgentConfig } from "./social-agent-state.js";
import { validateDiscoveryPolicy } from "./social-discovery-state.js";
import { validateSocialExperiencePolicy } from "./social-experience-policy.js";
import { digitalLifePolicy } from "./digital-life-policy.js";

// Validate writes before normalizing. In particular, never coerce enable flags
// or silently broaden a malformed scope into a working autonomous policy.
export function validateSocialAgentPolicy(value) {
  const plain = x => x && typeof x === "object" && !Array.isArray(x);
  if (!plain(value) || Object.keys(value).some(k => !["enabled", "shadowMode", "conversationIds", "profile", "maxDailyCalls", "maxToolCalls", "turnTimeoutMs", "crossConversation", "discovery"].includes(k))) throw new Error("socialAgent 策略字段无效");
  if (value.discovery !== undefined && !validateDiscoveryPolicy(value.discovery).ok) throw new Error("采风策略无效");
  for (const k of ["enabled", "shadowMode"]) if (value[k] !== undefined && typeof value[k] !== "boolean") throw new Error(`${k} 必须是开关`);
  if (value.conversationIds !== undefined && (!Array.isArray(value.conversationIds) || value.conversationIds.length > 128 || value.conversationIds.some(x => typeof x !== "string" || !/^(group|private):[1-9]\d{0,19}$/.test(x)))) throw new Error("社交范围必须是显式规范会话 ID");
  if (value.profile !== undefined && (!plain(value.profile) || Object.entries(value.profile).some(([k,v]) => !["identity", "selfName", "expression", "interests", "boundaries", "examples"].includes(k) || typeof v !== "string" || v.length > (k === "examples" ? 2000 : 800)))) throw new Error("社交身份字段无效");
  for (const [k,min,max] of [["maxDailyCalls",1,10000],["maxToolCalls",0,8],["turnTimeoutMs",1000,60000]]) if (value[k] !== undefined && (!Number.isInteger(value[k]) || value[k] < min || value[k] > max)) throw new Error(`${k} 超出预算范围`);
  const cross = value.crossConversation;
  if (cross !== undefined && (!plain(cross) || Object.keys(cross).some(k => !["enabled", "groupIds", "userIds"].includes(k)) || (cross.enabled !== undefined && typeof cross.enabled !== "boolean") || [["groupIds",/^group:[1-9]\d{0,19}$/,128],["userIds",/^[1-9]\d{0,19}$/,512]].some(([k,re,max]) => cross[k] !== undefined && (!Array.isArray(cross[k]) || cross[k].length > max || cross[k].some(x => typeof x !== "string" || !re.test(x)))))) throw new Error("跨会话授权策略无效");
  return socialAgentConfig(value);
}

const clone = (value) => structuredClone(value);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
// Account/group IDs also index older plain-object runtime maps. Reject these
// at ingestion, not just API validation, before any inherited-key lookup.
const RESERVED_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
export const ACCOUNT_FEATURES = ["chat", "task", "proactive", "automation", "webSearch", "vision", "asr", "learning"];
export const ACCOUNT_SEND_TYPES = ["text", "image", "record", "video", "file"];
export const ACCOUNT_POLICY_KEYS = ["displayName", "selfName", "style", "styleProfileId", "promptOverride", "features", "sendTypes", "scope", "modelBindings", "voice", "behaviorMode", "socialAgent", "socialExperience", "digitalLife"];
const ITEM_KEYS = new Set(["id", "qq", "displayName", "selfName", "style", "styleProfileId", "promptOverride", "enabled", "protocolEnabled", "archived", "managed", "protocol", "onebotPath", "onebotWsUrl", "napcatContainer", "protocolContainer", "webuiPort", "noVncPort", "vncPort", "snowlumaImage", "snowlumaVolumes", "behaviorMode", "features", "sendTypes", "scope", "modelBindings", "voice"]);
ITEM_KEYS.add("socialAgent");
ITEM_KEYS.add("socialExperience");
ITEM_KEYS.add("digitalLife");
const bools = (keys, values, fallback) => Object.fromEntries(keys.map((key) => [key, values?.[key] ?? fallback]));
const featureDefaults = (config, mode = "all") => ({ chat: mode !== "task", task: mode !== "chat",
  proactive: config.proactive?.enabled !== false, automation: config.automation?.enabled === true,
  webSearch: config.webSearch?.enabled !== false, vision: config.vision?.enabled !== false,
  asr: config.voice?.enabled === true && config.voice?.asr?.enabled !== false, learning: config.learningMode?.enabled === true });

function validateStyle(style) {
  if (!object(style) || Object.keys(style).some((key) => key !== "systemPrompt")
    || typeof style.systemPrompt !== "string" || style.systemPrompt.length > 12000) throw new Error("账号 style 必须是有效的 systemPrompt 文本快照（最多 12000 字符）");
  return clone(style);
}

function validateSelfName(value) {
  if (typeof value !== "string" || value.length > 100 || (value !== "" && !value.trim())
    || /[\x00-\x1f\x7f]/.test(value)) throw new Error("账号 selfName 必须是最多 100 字符的自称文本，可留空使用账号名称");
  return value;
}

// Used only when migrating missing snapshots or explicitly updating legacy
// fields. Empty canonical prompts are intentional, never an inheritance flag.
function legacyStyle(account, config) {
  if (typeof account.promptOverride === "string" && account.promptOverride.trim()) return validateStyle({ systemPrompt: account.promptOverride });
  const profiles = Array.isArray(config.styleProfiles?.profiles) ? config.styleProfiles.profiles : [];
  const selectedId = account.styleProfileId || config.styleProfiles?.activeId || "legacy";
  const profile = profiles.find((item) => item?.id === selectedId) || profiles.find((item) => item?.id === "legacy");
  return validateStyle({ systemPrompt: String(profile?.systemPrompt || config.prompt?.system || "") });
}

function normalizeItem(raw, config, index, legacy = false) {
  const id = String(raw.id || (index === 0 ? "primary" : `standby-${index}`));
  if (RESERVED_IDS.has(id)) throw new Error("账号 ID 不能使用原型保留名称");
  const mode = config.botFeatures?.accountModes?.[id] || config.botFeatures?.defaultMode || "all";
  const protocol = raw.protocol || "napcat";
  const displayName = String(raw.displayName || raw.name || (index === 0 ? config.persona?.displayName : "") || `机器人 ${index + 1}`);
  return { ...clone(raw), id, qq: String(raw.qq || raw.uin || ""),
    displayName,
    // Missing old values freeze the previous name once; explicit blank follows
    // this owner's effective displayName without rewriting the stored field.
    selfName: Object.hasOwn(raw, "selfName") ? validateSelfName(raw.selfName) : displayName,
    enabled: raw.enabled ?? true, protocolEnabled: raw.protocolEnabled ?? true, archived: raw.archived ?? false,
    managed: raw.managed ?? true, protocol,
    ...(legacy && index === 0 && protocol === "napcat" && !raw.napcatStateDir && !raw.napcatDataDir ? { napcatStateDir: "napcat" } : {}),
    onebotPath: raw.onebotPath || config.listen?.path || "/onebot",
    protocolContainer: raw.protocolContainer || raw.snowlumaContainer || raw.napcatContainer || (protocol === "snowluma" ? `snowluma-${id}` : index === 0 ? "napcat" : `napcat-${id}`),
    ...(protocol === "snowluma" ? {
      onebotWsUrl: raw.onebotWsUrl || `ws://127.0.0.1:${index === 0 ? 6303 : 6301 + (index - 1) * 4}`,
      webuiPort: raw.webuiPort ?? (index === 0 ? 6103 : 6101 + (index - 1) * 4),
      noVncPort: raw.noVncPort ?? (index === 0 ? 6104 : 6102 + (index - 1) * 4),
      vncPort: raw.vncPort ?? (index === 0 ? 5902 : index === 1 ? 5901 : 5903 + index - 2),
      snowlumaImage: raw.snowlumaImage || "motricseven7/snowluma:latest"
    } : {}),
    style: Object.hasOwn(raw, "style") ? validateStyle(raw.style) : legacyStyle(raw, config),
    styleProfileId: raw.styleProfileId || "", promptOverride: raw.promptOverride || "",
    behaviorMode: raw.behaviorMode || (legacy && index > 0 ? "normal" : ""),
    features: { ...featureDefaults(config, mode), ...(raw.features || {}) },
    sendTypes: { ...bools(ACCOUNT_SEND_TYPES, raw.sendTypes, true), ...(raw.sendTypes || {}) },
    scope: { groups: true, private: true, groupMode: "all", groupIds: [], ...(raw.scope || {}) },
    modelBindings: { chat: "", task: "", vision: "", asr: "", tts: "", search: "", ...(raw.modelBindings || {}) },
    voice: { mode: "inherit", preset: "", ...(raw.voice || {}) },
    socialAgent: validateSocialAgentPolicy(raw.socialAgent ?? {}),
    ...(raw.digitalLife === undefined ? {} : { digitalLife: digitalLifePolicy(raw.digitalLife) }),
    ...(raw.socialExperience === undefined ? {} : { socialExperience: validateSocialExperiencePolicy(raw.socialExperience) })
  };
}

export function accountPolicy(account) {
  return Object.fromEntries(ACCOUNT_POLICY_KEYS.filter((key) => account[key] !== undefined).map((key) => [key, clone(account[key])]));
}

export function normalizeAccountRegistry(config = {}, { strict = false } = {}) {
  const source = config.accounts || {};
  const isV2 = source.version === 2 && Array.isArray(source.items);
  if (strict && source.version !== undefined && source.version !== 2) throw new Error("不支持的账号配置版本");
  if (strict && source.version === 2 && !Array.isArray(source.items)) throw new Error("账号列表必须是数组");
  const legacy = [source.primary || { id: "primary" }, ...(source.standbys || [])];
  const items = (isV2 ? source.items : legacy).map((raw, index) => normalizeItem(raw, config, index, !isV2));
  let failoverGroups = isV2 ? clone(source.failoverGroups || []) : [];
  if (!isV2 && (source.topology || "failover") === "failover" && items.length > 1) {
    failoverGroups = [{ id: "legacy-failover", name: "原主备机器人", memberIds: items.map((item) => item.id),
      policyAccountId: items[0].id, policy: accountPolicy(items[0]), legacySelfMemory: true,
      settings: { ...(source.failover || {}) } }];
  }
  if (!Array.isArray(failoverGroups)) throw new Error("接管组必须是数组");
  failoverGroups = failoverGroups.map((group) => {
    if (!object(group)) throw new Error("接管组必须是对象");
    if (RESERVED_IDS.has(group.id)) throw new Error("接管组 ID 不能使用原型保留名称");
    const policySource = items.find((item) => item.id === group.policyAccountId);
    if (!policySource || !object(group.policy)) return group;
    const policy = { ...accountPolicy(policySource), ...group.policy };
    // An old group could override its shared name independently of the source
    // account. Resolve that legacy name before inheriting the new source field.
    policy.selfName = Object.hasOwn(group.policy, "selfName") ? validateSelfName(group.policy.selfName)
      : Object.hasOwn(group.policy, "displayName") ? policy.displayName : policySource.selfName;
    // Old group overrides must be resolved before considering the source's
    // new snapshot, or migration would silently discard the shared old prompt.
    policy.style = Object.hasOwn(group.policy, "style") ? validateStyle(group.policy.style)
      : Object.hasOwn(group.policy, "promptOverride") || Object.hasOwn(group.policy, "styleProfileId")
        ? legacyStyle(policy, config) : clone(policySource.style);
    for (const key of ["features", "sendTypes", "scope", "modelBindings", "voice"]) {
      if (object(group.policy[key])) policy[key] = { ...policySource[key], ...group.policy[key] };
    }
    return { ...group, policy };
  });
  const registry = { version: 2, items, failoverGroups,
    legacyPrimaryId: source.legacyPrimaryId || (!isV2 ? items[0]?.id || "" : "") };
  if (strict) validateRegistry(registry);
  return registry;
}

function validateRegistry(registry) {
  const ids = new Set(), qqs = new Set(), containers = new Set(), ports = new Set();
  for (const item of registry.items) {
    if (!ID.test(item.id) || ids.has(item.id)) throw new Error("账号 ID 无效或重复");
    ids.add(item.id);
    if (!["snowluma", "napcat"].includes(item.protocol)) throw new Error("不支持的协议端类型");
    if (item.qq && !/^\d{5,20}$/.test(item.qq)) throw new Error("QQ 号格式无效");
    if (item.qq && !item.archived && qqs.has(item.qq)) throw new Error("该 QQ 已添加，请编辑已有账号");
    if (item.qq && !item.archived) qqs.add(item.qq);
    if (!item.displayName.trim() || item.displayName.length > 100 || typeof item.promptOverride !== "string" || item.promptOverride.length > 12000) throw new Error("账号名称或提示词长度无效");
    validateSelfName(item.selfName);
    validateStyle(item.style);
    for (const key of ["enabled", "protocolEnabled", "archived", "managed"]) if (typeof item[key] !== "boolean") throw new Error(`账号 ${key} 必须是开关`);
    for (const [values, keys] of [[item.features, ACCOUNT_FEATURES], [item.sendTypes, ACCOUNT_SEND_TYPES]]) {
      if (!object(values) || Object.keys(values).some((key) => !keys.includes(key)) || keys.some((key) => typeof values[key] !== "boolean")) throw new Error("账号功能或内容权限无效");
    }
    if (!["all", "allowlist"].includes(item.scope.groupMode) || !Array.isArray(item.scope.groupIds) || item.scope.groupIds.some((id) => !/^\d+$/.test(String(id)))
      || typeof item.scope.groups !== "boolean" || typeof item.scope.private !== "boolean") throw new Error("账号参与范围无效");
    if (!object(item.modelBindings) || Object.entries(item.modelBindings).some(([key, value]) => !["chat", "task", "vision", "asr", "tts", "search"].includes(key)
      || typeof value !== "string" || (value && value !== "inherit-chat" && !ID.test(value)))) throw new Error("账号模型绑定无效");
    if (!["inherit", "off", "mixed", "force"].includes(item.voice.mode) || typeof item.voice.preset !== "string") throw new Error("账号语音设置无效");
    if (item.behaviorMode && !["normal", "lively", "restrained"].includes(item.behaviorMode)) throw new Error("账号活跃度无效");
    if (item.onebotWsUrl) {
      let url;
      try { url = new URL(item.onebotWsUrl); } catch { throw new Error("OneBot WebSocket 地址无效"); }
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("OneBot WebSocket 地址无效");
    }
    if (!item.managed && !item.onebotWsUrl) throw new Error("外部协议端必须配置 WebSocket 地址");
    if (item.archived || !item.managed) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(item.protocolContainer)) throw new Error("协议端容器名无效");
    if (containers.has(item.protocolContainer)) throw new Error("容器已被另一个账号使用");
    containers.add(item.protocolContainer);
    const accountPorts = [item.webuiPort, item.noVncPort, item.vncPort];
    if (item.protocol === "snowluma" && item.onebotWsUrl) accountPorts.push(Number(new URL(item.onebotWsUrl).port));
    for (const value of accountPorts.filter((p) => p != null && p !== "")) {
      if (!Number.isInteger(value) || value < 1024 || value > 65535 || ports.has(value)) throw new Error("账号端口无效或与其他账号冲突");
      ports.add(value);
    }
  }
  const memberships = new Set(), groupIds = new Set();
  for (const group of registry.failoverGroups) {
    if (!ID.test(group.id) || groupIds.has(group.id) || !Array.isArray(group.memberIds) || group.memberIds.length < 2) throw new Error("接管组 ID 或成员无效");
    groupIds.add(group.id);
    if (typeof group.name !== "string" || !group.name.trim() || group.name.length > 100) throw new Error("接管组名称无效");
    for (const id of group.memberIds) {
      if (!ids.has(id) || registry.items.find((item) => item.id === id)?.archived || memberships.has(id)) throw new Error("账号只能加入一个接管组，且必须存在");
      memberships.add(id);
    }
    if (!group.memberIds.includes(group.policyAccountId)) throw new Error("接管组设置来源必须是组内账号");
    if (!object(group.policy) || Object.keys(group.policy).some((key) => !ACCOUNT_POLICY_KEYS.includes(key))) throw new Error("接管组策略无效");
    const policyItem = normalizeItem({ ...registry.items.find((item) => item.id === group.policyAccountId), ...group.policy }, {}, 0);
    // Reuse field validation without transport uniqueness against other members.
    validateRegistry({ items: [policyItem], failoverGroups: [] });
    if (group.settings && (!object(group.settings) || Object.values(group.settings).some((value) => !["boolean", "number", "string"].includes(typeof value)))) throw new Error("接管组规则无效");
  }
}

export function accountItems(config = {}, { includeArchived = false } = {}) {
  return normalizeAccountRegistry(config).items.filter((item) => includeArchived || !item.archived)
    .map((item, index) => ({ ...item, role: index === 0 ? "primary" : "standby" }));
}

export function accountGroup(config = {}, accountId) {
  return normalizeAccountRegistry(config).failoverGroups.find((group) => group.memberIds.includes(accountId)) || null;
}

export function effectiveAccount(config = {}, accountId) {
  const item = accountItems(config).find((entry) => entry.id === accountId);
  if (!item) return null;
  const group = accountGroup(config, accountId);
  return group ? { ...item, ...clone(group.policy), id: item.id, qq: item.qq, enabled: item.enabled,
    groupId: group.id, groupName: group.name, groupPolicyAccountId: group.policyAccountId } : item;
}

export function registryConfig(config = {}, { strict = false } = {}) {
  const next = clone(config);
  const registry = normalizeAccountRegistry(next, { strict });
  next.accounts = { ...(next.accounts || {}), ...registry };
  const active = registry.items.filter((item) => !item.archived);
  next.accounts.primary = active[0] ? { ...clone(active[0]), role: "primary" } : { id: "primary", enabled: false, protocolEnabled: false };
  next.accounts.standbys = active.slice(1).map((item) => ({ ...clone(item), role: "standby" }));
  const soleGroup = registry.failoverGroups.length === 1 && registry.failoverGroups[0].memberIds.length === active.length;
  next.accounts.topology = soleGroup ? "failover" : config.accounts?.topology === "collaboration" ? "collaboration" : "function_split";
  if (soleGroup) next.accounts.failover = { ...registry.failoverGroups[0].settings };
  return next;
}

// Pass the global config when accepting legacy promptOverride/styleProfileId
// edits so clearing/selecting them snapshots the effective legacy text once.
// Explicit canonical style wins if a client supplies both representations.
export function mergeAccountPatch(account, patch, config = {}) {
  if (patch?.digitalLife !== undefined) digitalLifePolicy(patch.digitalLife);
  if (patch?.socialAgent !== undefined) validateSocialAgentPolicy(patch.socialAgent);
  if (patch?.socialExperience !== undefined) validateSocialExperiencePolicy(patch.socialExperience);
  if (!object(patch) || Object.keys(patch).some((key) => !ITEM_KEYS.has(key)) || (patch.id && patch.id !== account.id)) throw new Error("账号设置字段无效");
  for (const key of ["enabled", "protocolEnabled", "archived", "managed"]) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new Error(`账号 ${key} 必须是开关`);
  }
  for (const key of ["displayName", "styleProfileId", "promptOverride", "onebotWsUrl", "protocolContainer", "snowlumaImage"]) {
    if (patch[key] !== undefined && typeof patch[key] !== "string") throw new Error(`账号 ${key} 必须是文本`);
  }
  if (Object.hasOwn(patch, "selfName")) validateSelfName(patch.selfName);
  const merged = { ...account, ...clone(patch), id: account.id };
  if (!Object.hasOwn(merged, "selfName")) merged.selfName = String(account.displayName || merged.displayName || "");
  merged.style = Object.hasOwn(patch, "style") ? validateStyle(patch.style)
    : Object.hasOwn(patch, "promptOverride") || Object.hasOwn(patch, "styleProfileId") || !Object.hasOwn(account, "style")
      ? legacyStyle(merged, config) : validateStyle(account.style);
  for (const key of ["features", "sendTypes", "scope", "modelBindings", "voice", "snowlumaVolumes"]) {
    if (patch[key] !== undefined) {
      if (!object(patch[key])) throw new Error(`账号 ${key} 必须是对象`);
      merged[key] = { ...(account[key] || {}), ...clone(patch[key]) };
    }
  }
  return merged;
}

export function newAccount(config, input = {}, allocatedPorts = []) {
  if (!object(input)) throw new Error("账号设置字段无效");
  const { copyStyleFromAccountId, ...patch } = input;
  let style = { systemPrompt: "" };
  if (copyStyleFromAccountId !== undefined) {
    if (typeof copyStyleFromAccountId !== "string" || !copyStyleFromAccountId) throw new Error("复制风格的源账号 ID 无效");
    const source = effectiveAccount(config, copyStyleFromAccountId);
    if (!source) throw new Error("复制风格的源账号不存在或已归档");
    style = validateStyle(source.style);
  }
  const id = patch.id || `account_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const base = { id, qq: "", displayName: `机器人 ${accountItems(config).length + 1}`, selfName: "", protocol: "snowluma", managed: true,
    enabled: false, protocolEnabled: true, archived: false, protocolContainer: `snowluma-${id}`,
    features: { chat: true, task: false, proactive: false, automation: false, webSearch: true, vision: true, asr: false, learning: false },
    sendTypes: { text: true, image: false, record: false, video: false, file: false },
    scope: { groups: true, private: true, groupMode: "all", groupIds: [] },
    snowlumaImage: "motricseven7/snowluma:latest", modelBindings: {}, voice: {}, style };
  const item = mergeAccountPatch(base, patch, config);
  if (item.managed !== false && allocatedPorts.length === 4) {
    item.webuiPort ??= allocatedPorts[0]; item.noVncPort ??= allocatedPorts[1]; item.vncPort ??= allocatedPorts[2];
    item.onebotWsUrl ||= `ws://127.0.0.1:${allocatedPorts[3]}`;
  }
  if (item.managed === false && !item.onebotWsUrl) throw new Error("接入已有协议端需要 OneBot WebSocket 地址");
  return normalizeItem(item, config, accountItems(config).length);
}

// Translate only fields explicitly supplied by an old client; never replace the
// item list with that client's positional standby array.
export function syncLegacyAccountPatch(current, next, patch = {}) {
  const result = registryConfig(current);
  const changes = patch.accounts || {};
  for (const incoming of [changes.primary, ...(changes.standbys || [])].filter(Boolean)) {
    const id = incoming.id || (incoming === changes.primary ? result.accounts.primary.id : "");
    const index = result.accounts.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("旧接口无法定位账号，请使用账号 ID 更新");
    const clean = Object.fromEntries(Object.entries(incoming).filter(([key]) => ITEM_KEYS.has(key) && key !== "id"));
    result.accounts.items[index] = mergeAccountPatch(result.accounts.items[index], clean, next);
  }
  for (const [id, promptOverride] of Object.entries(changes.promptOverrides || {})) {
    const index = result.accounts.items.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("未知提示词账号");
    result.accounts.items[index] = mergeAccountPatch(result.accounts.items[index], { promptOverride }, next);
  }
  for (const [id, mode] of Object.entries(patch.botFeatures?.accountModes || {})) {
    const item = result.accounts.items.find((entry) => entry.id === id);
    if (item) { item.features.chat = mode !== "task"; item.features.task = mode !== "chat"; }
  }
  if (changes.topology && changes.topology !== current.accounts?.topology) {
    if (result.accounts.failoverGroups.length > 1 || result.accounts.failoverGroups.some((group) => !group.legacySelfMemory)) throw new Error("旧接口不能切换自定义接管组，请在账号功能中管理");
    result.accounts.failoverGroups = changes.topology === "failover" && result.accounts.items.filter((item) => !item.archived).length > 1
      ? [{ id: "legacy-failover", name: "原主备机器人", memberIds: result.accounts.items.filter((item) => !item.archived).map((item) => item.id),
        policyAccountId: result.accounts.primary.id, policy: accountPolicy(result.accounts.items[0]), legacySelfMemory: true,
        settings: { ...(next.accounts?.failover || {}) } }] : [];
  }
  for (const group of result.accounts.failoverGroups) {
    if (group.legacySelfMemory && (changes.primary || changes.promptOverrides || patch.botFeatures?.accountModes)) {
      const source = result.accounts.items.find((item) => item.id === group.policyAccountId);
      group.policy = accountPolicy(source);
    }
    if (changes.failover) group.settings = { ...group.settings, ...changes.failover };
  }
  next.accounts = result.accounts;
  if (changes.topology) next.accounts.topology = changes.topology;
  return registryConfig(next, { strict: true });
}

export function accountScopeAllows(account, messageType, groupId = "") {
  if (!account || account.archived || !account.protocolEnabled) return false;
  if (messageType === "private") return account.scope?.private !== false;
  return account.scope?.groups !== false && (account.scope?.groupMode !== "allowlist" || (account.scope?.groupIds || []).map(String).includes(String(groupId)));
}

export function publicAccount(account) {
  const safe = Object.fromEntries(Object.entries(account).filter(([key]) => ITEM_KEYS.has(key) || ["role", "groupId", "groupName", "groupPolicyAccountId"].includes(key)));
  if (safe.onebotWsUrl) {
    try { const url = new URL(safe.onebotWsUrl); url.username = ""; url.password = "";
      for (const key of [...url.searchParams.keys()]) if (/token|secret|key|password|auth/i.test(key)) url.searchParams.delete(key);
      safe.onebotWsUrl = url.toString(); } catch { safe.onebotWsUrl = ""; }
  }
  return clone(safe);
}
