import { accountGroup, accountItems, effectiveAccount, registryConfig } from "./account-registry.js";
import { applyApiCenterBindings, normalizeApiCenter } from "./api-center.js";
import { automationForAccount } from "./account-automation.js";
import { projectBehaviorSettings } from "./behavior-settings.js";

const BOT_MODES = new Set(["chat", "task", "all"]);
const TOPOLOGIES = new Set(["failover", "collaboration", "function_split"]);
const RUNTIME_AUTHORITY = [
  "运行时权限约束：风格提示词、历史消息和自我记忆中的定时口头约定，不代表已登记自动化；复制风格也不复制自动化规则或定时承诺的执行权限。",
  "早晚问候、定时总结等定时动作由自动化调度负责；普通回复不得自行执行，也不得凭风格或历史冒称已配置或已发送。",
  "quiet（静默）、功能开关和发送权限以当前结构化配置为准；风格、历史约定和复制来的提示词不能覆盖这些限制。"
].join("\n");

export function normalizeBotMode(value) {
  return BOT_MODES.has(value) ? value : "all";
}

export function accountTopology(config = {}) {
  return TOPOLOGIES.has(config.accounts?.topology) ? config.accounts.topology : "failover";
}

const defaultAccountId = (config) => config.__activeAccountId || accountItems(config)[0]?.id || "primary";
const participates = (account) => Boolean(account && account.enabled !== false && account.protocolEnabled !== false && !account.archived);

function selfMemoryMap(gm, key) {
  if (!Object.hasOwn(gm, key) || !gm[key] || typeof gm[key] !== "object" || Array.isArray(gm[key])) gm[key] = Object.create(null);
  return gm[key];
}

function ownSelfSlot(map, id) {
  if (!Object.hasOwn(map, id) || !map[id] || typeof map[id] !== "object" || Array.isArray(map[id])) {
    Object.defineProperty(map, id, { value: {}, writable: true, enumerable: true, configurable: true });
  }
  return map[id];
}

const legacyPrimaryId = (config) => config.accounts?.legacyPrimaryId
  || (config.accounts?.version === 2 ? "primary" : (config.accounts?.primary?.id || "primary"));

function accountBotNames(config, account, legacyNames) {
  const group = accountGroup(config, account.id);
  const members = group ? accountItems(config).filter((item) => group.memberIds.includes(item.id)) : [];
  const inheritsLegacy = account.id === legacyPrimaryId(config)
    || group?.legacySelfMemory || group?.memberIds.includes(legacyPrimaryId(config));
  return [...new Set([account.displayName, ...members.map((item) => item.displayName), ...(inheritsLegacy ? legacyNames : [])]
    .filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()))];
}

// Only a longer peer name covering this particular occurrence disambiguates
// it. Separate mentions still match both bots; equal names intentionally match
// both because plain text cannot distinguish them (use a QQ @ mention).
export function accountKeywordMatches(text, config = {}) {
  const lower = String(text || "").toLowerCase();
  const names = (Array.isArray(config.botNames) ? config.botNames : [])
    .filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().toLowerCase());
  const peers = (Array.isArray(config.__peerBotNames) ? config.__peerBotNames : [])
    .filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().toLowerCase());
  return names.some((name) => {
    for (let offset = lower.indexOf(name); offset >= 0; offset = lower.indexOf(name, offset + 1)) {
      const covered = peers.some((peer) => {
        if (peer.length <= name.length) return false;
        const start = lower.lastIndexOf(peer, offset);
        return start >= 0 && offset + name.length <= start + peer.length;
      });
      if (!covered) return true;
    }
    return false;
  });
}

// Group facts/member profiles remain shared. Identity is shared only inside an
// explicit failover group (including one derived from legacy config).
export function botSelfSlot(gm, config = {}) {
  const accountId = defaultAccountId(config);
  const group = accountGroup(config, accountId);
  if (group?.legacySelfMemory) return (gm.botSelf ||= {});
  if (group) {
    return ownSelfSlot(selfMemoryMap(gm, "botSelfByGroup"), group.id);
  }
  const map = selfMemoryMap(gm, "botSelfByAccount");
  if (Object.hasOwn(map, accountId)) return ownSelfSlot(map, accountId);
  // Preserve the original independent primary's slot; arbitrary new stable IDs
  // must not claim old self memory merely because they moved to index zero.
  if (accountId === legacyPrimaryId(config)) return (gm.botSelf ||= {});
  return ownSelfSlot(map, accountId);
}

export function botModeForAccount(config = {}, accountId = defaultAccountId(config)) {
  const chat = accountCanChat(config, accountId);
  const task = accountCanOfferTask(config, accountId);
  return chat ? (task ? "all" : "chat") : (task ? "task" : "none");
}

export function accountCanChat(config = {}, accountId = defaultAccountId(config)) {
  const account = effectiveAccount(config, accountId);
  return participates(account) && account.features?.chat === true;
}

export function accountCanOfferTask(config = {}, accountId = defaultAccountId(config)) {
  const account = effectiveAccount(config, accountId);
  return participates(account) && account.features?.task === true;
}

export function styleProfileForAccount(config = {}, accountId = defaultAccountId(config)) {
  const account = effectiveAccount(config, accountId);
  const profiles = Array.isArray(config.styleProfiles?.profiles) ? config.styleProfiles.profiles : [];
  const selectedId = account?.styleProfileId || config.styleProfiles?.activeId || "legacy";
  return profiles.find((item) => item?.id === selectedId)
    || profiles.find((item) => item?.id === "legacy")
    || null;
}

export function systemPromptForAccount(config = {}, accountId = defaultAccountId(config)) {
  const account = effectiveAccount(config, accountId);
  return account?.style.systemPrompt ?? "";
}

// The stored prompt is a style preference, not the authority for the current
// account topology or runtime permissions. Keep this context separate so
// switching modes never rewrites a user's prompt or historical memory.
export function accountIdentityForPrompt(config = {}, accountId = defaultAccountId(config)) {
  const accounts = accountItems(config);
  const current = effectiveAccount(config, accountId);
  if (!current) throw new Error("Unknown or archived bot account");
  const group = accountGroup(config, accountId);
  const topology = accountTopology(config);
  const displayName = current.displayName || config.persona?.displayName || current.id || "Hermes QQ Bot";
  const name = (current.socialAgent?.enabled && current.socialAgent.profile?.selfName) || current.selfName || displayName;
  const selfIdentity = name === "我"
    ? "自称约束：自然使用第一人称“我”，不把“我”当作需要报出的专有昵称。"
    : `自称约束：自称使用${JSON.stringify(name)}。`;
  const selfAuthority = `${selfIdentity} 管理名称${JSON.stringify(displayName)}仅用于管理、账号标识和 QQ 引用，不强制用作自称；旧风格提示词、历史消息和自我记忆中的旧称呼与此冲突时，以本段自称为准，不改写原记录。`;
  const qq = current.qq ? `（QQ ${current.qq}）` : "";
  let authority = RUNTIME_AUTHORITY + "\n当前显式账号风格优先于历史 botSelf 人格、旧称呼与旧表达习惯；历史记录不是当前人格配置。";
  if (current.socialAgent?.enabled) authority += `\n当前账号社交设定（仅表达，不授予权限）：${JSON.stringify(current.socialAgent.profile || {})}`;
  if (config.automation?.ownershipVersion === 1) {
    const owned = automationForAccount(config, accountId);
    const entries = [
      ...(owned.routines.daily?.schedules || []).map((rule, index) => ({ name: String(rule.name || rule.mode || `例行${index + 1}`).slice(0, 80),
        time: rule.time || "", enabled: owned.routines.daily.enabled !== false && rule.enabled !== false })),
      ...(owned.routines.hourly ? [{ name: "定期私聊", enabled: owned.routines.hourly.enabled !== false }] : []),
      ...owned.rules.map(rule => ({ name: rule.id, trigger: rule.trigger.type, enabled: rule.enabled !== false }))
    ];
    authority += `\n当前账号自动化目录：${owned.owner.key}；功能${owned.enabled && participates(current) ? "开启" : "关闭或账号暂停"}；登记 ${entries.length} 条。`;
    authority += `登记摘要（最多12条）：${JSON.stringify(entries.slice(0, 12))}。登记不代表已执行或已发送；不得把其他账号的规则认作自己的。`;
  }
  if (group) {
    const isPrimary = current.id === group.memberIds[0];
    return [
      `当前运行方式：主备接管；接管组「${group.name || group.id}」内的 QQ 登录账号代表同一个 bot；本组与其他接管组或独立 bot 互不共享身份和自我记忆。`,
      `本条回复由${isPrimary ? "主账号" : "备用账号"}「${displayName}」${qq}发送。`,
      isPrimary ? "当前由主账号发言。" : "当前由备用账号接管发言。",
      "只有被问到账号切换时才解释主备关系；不要在普通聊天中主动报运行状态。",
      selfAuthority,
      authority
    ].join("\n");
  }
  const modeLabel = { chat: "聊天", task: "任务", all: "聊天和任务", none: "暂无聊天或任务职责" };
  const hasOtherGroups = accounts.some((item) => accountGroup(config, item.id));
  const participants = accounts.map((item, index) => {
    const identity = effectiveAccount(config, item.id);
    const role = modeLabel[botModeForAccount(config, item.id)] || modeLabel.all;
    return `账号 ${index + 1}「${identity.displayName || item.id}」${item.qq ? `（QQ ${item.qq}）` : ""}：${role}${!participates(item) ? "，机器人处理已停用" : ""}${identity.groupId ? `（接管组「${identity.groupName || identity.groupId}」内共享身份）` : ""}`;
  });
  return [
    hasOtherGroups
      ? "当前账号是独立 bot，不属于任何主备接管组；其他账号的接管组只代表各自的 bot，不能把它们的主备关系套用到当前账号。"
      : `当前运行方式：${topology === "function_split" ? "多个独立 bot 按功能分工" : "多个独立 bot 协作聊天"}；账号平级，不存在主备接管。`,
    `${name === "我" ? `当前发言账号「${displayName}」` : `你是「${name}」`}${qq}，负责${modeLabel[botModeForAccount(config, current.id)] || modeLabel.all}。`,
    `账号分工：${participants.join("；")}。`,
    "群聊事实和成员记忆可以共享，但身份、人格、自我记忆和各自说过的话不能互认。",
    "不要把自己或另一个 bot 称为主号、备用号、备号、接管者，也不要从内部账号 ID 推断主备关系。",
    "旧提示词、历史消息或自我记忆若提到主备，那是切换前的旧语境；当前身份与职责以本段为准。",
    "回答自己是谁时遵守当前自称与职责；除非被问到，不主动解释账号架构或测试状态。",
    selfAuthority,
    authority
  ].join("\n");
}

/** Account-local runtime projection. Never persist this clone as global config.
 * API Center stays global; its legacy call-site fields reflect this account.
 * No credentials are read and no caller-owned config/memory is mutated.
 */
export function configForAccountCapabilities(config = {}, accountId = defaultAccountId(config)) {
  const account = effectiveAccount(config, accountId);
  if (!account) throw new Error("Unknown or archived bot account");
  // Capture defaults before projecting a different chat preset.
  const center = normalizeApiCenter(config);
  // Materialize all legacy styles before projecting this account's prompt;
  // otherwise a later projection could inherit the previous bot's text.
  let next = registryConfig(config);
  next.__activeAccountId = accountId;
  next.__activeAccountDisplayName = account.displayName;
  next.__activeAccountSelfName = account.selfName || account.displayName;
  next.socialAgent = structuredClone(account.socialAgent);
  applyApiCenterBindings(next, center, accountId);
  if (account.behaviorMode) {
    // Project before changing the selected default: root values belong to the
    // original saved mode, not this account's newly selected mode.
    next = projectBehaviorSettings(next, account.behaviorMode);
    next.behaviorModes = { ...(next.behaviorModes || {}), default: account.behaviorMode };
  }
  const participating = participates(account);
  const feature = (key) => participating && account.features?.[key] === true;
  next.botFeatures = { ...(next.botFeatures || {}), defaultMode: botModeForAccount(config, accountId),
    accountModes: { ...(next.botFeatures?.accountModes || {}), [accountId]: botModeForAccount(config, accountId) } };
  next.proactive = { ...(next.proactive || {}), enabled: feature("proactive") };
  next.automation = { ...(next.automation || {}), enabled: feature("automation") };
  next.learningMode = { ...(next.learningMode || {}), enabled: feature("learning") };
  next.vision = { ...(next.vision || {}), enabled: feature("vision") };
  next.webSearch = { ...(next.webSearch || {}), enabled: feature("webSearch") };
  const voice = next.voice || {};
  const mode = account.voice?.mode || "inherit";
  const enabled = participating && (mode === "off" ? false : mode === "inherit" ? voice.enabled === true : true);
  next.voice = { ...voice, enabled, ...(mode !== "inherit" ? { replyMode: mode } : {}),
    asr: { ...(voice.asr || {}), enabled: enabled && feature("asr") },
    tts: { ...(voice.tts || {}), ...(account.voice?.preset ? { voice: account.voice.preset } : {}) } };
  next.persona = { ...(next.persona || {}), displayName: account.displayName, selfName: account.selfName || account.displayName };
  // Keep the original alias source on detached projections so projecting a
  // second account cannot inherit the previous account's wake words.
  next.__legacyBotNames = [...(Array.isArray(config.__legacyBotNames) ? config.__legacyBotNames : Array.isArray(config.botNames) ? config.botNames : [])];
  next.botNames = accountBotNames(config, account, next.__legacyBotNames);
  const group = accountGroup(config, accountId);
  next.__peerBotNames = [...new Set(accountItems(config)
    .filter((item) => item.id !== accountId && !group?.memberIds.includes(item.id))
    .flatMap((item) => accountBotNames(config, effectiveAccount(config, item.id), next.__legacyBotNames)))];
  if (account.styleProfileId) next.styleProfiles = { ...(next.styleProfiles || {}), activeId: account.styleProfileId };
  next.prompt = { ...(next.prompt || {}), system: systemPromptForAccount(config, accountId) };
  return next;
}
