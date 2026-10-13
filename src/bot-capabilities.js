import { accountGroup, accountItems, effectiveAccount } from "./account-registry.js";
import { applyApiCenterBindings, normalizeApiCenter } from "./api-center.js";

const BOT_MODES = new Set(["chat", "task", "all"]);
const TOPOLOGIES = new Set(["failover", "collaboration", "function_split"]);

export function normalizeBotMode(value) {
  return BOT_MODES.has(value) ? value : "all";
}

export function accountTopology(config = {}) {
  return TOPOLOGIES.has(config.accounts?.topology) ? config.accounts.topology : "failover";
}

const defaultAccountId = (config) => config.__activeAccountId || accountItems(config)[0]?.id || "primary";
const participates = (account) => Boolean(account && account.enabled !== false && account.protocolEnabled !== false && !account.archived);

// Group facts/member profiles remain shared. Identity is shared only inside an
// explicit failover group (including one derived from legacy config).
export function botSelfSlot(gm, config = {}) {
  const accountId = defaultAccountId(config);
  const group = accountGroup(config, accountId);
  if (group?.legacySelfMemory) return (gm.botSelf ||= {});
  if (group) {
    gm.botSelfByGroup ||= {};
    return (gm.botSelfByGroup[group.id] ||= {});
  }
  gm.botSelfByAccount ||= {};
  if (gm.botSelfByAccount[accountId]) return gm.botSelfByAccount[accountId];
  // Preserve the original independent primary's slot; arbitrary new stable IDs
  // must not claim old self memory merely because they moved to index zero.
  const legacyPrimaryId = config.accounts?.legacyPrimaryId
    || (config.accounts?.version === 2 ? "primary" : (config.accounts?.primary?.id || "primary"));
  if (accountId === legacyPrimaryId) return (gm.botSelf ||= {});
  return (gm.botSelfByAccount[accountId] ||= {});
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
  if (typeof account?.promptOverride === "string" && account.promptOverride.trim()) return account.promptOverride;
  const profile = styleProfileForAccount(config, accountId);
  return String(profile?.systemPrompt || config.prompt?.system || "");
}

// The stored prompt is a style preference, not the authority for the current
// account topology. Keep this context separate so switching modes is immediate
// and never rewrites a user's prompt or historical memory.
export function accountIdentityForPrompt(config = {}, accountId = defaultAccountId(config)) {
  const accounts = accountItems(config);
  const current = effectiveAccount(config, accountId);
  if (!current) throw new Error("Unknown or archived bot account");
  const group = accountGroup(config, accountId);
  const topology = accountTopology(config);
  const name = current.displayName || config.persona?.displayName || current.id || "Hermes QQ Bot";
  const qq = current.qq ? `（QQ ${current.qq}）` : "";
  if (group) {
    const isPrimary = current.id === group.memberIds[0];
    return [
      `当前运行方式：主备接管；接管组「${group.name || group.id}」内的 QQ 登录账号代表同一个 bot；本组与其他接管组或独立 bot 互不共享身份和自我记忆。`,
      `本条回复由${isPrimary ? "主账号" : "备用账号"}「${name}」${qq}发送。`,
      isPrimary ? "当前由主账号发言。" : "当前由备用账号接管发言。",
      "只有被问到账号切换时才解释主备关系；不要在普通聊天中主动报运行状态。"
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
    `你是「${name}」${qq}，负责${modeLabel[botModeForAccount(config, current.id)] || modeLabel.all}。`,
    `账号分工：${participants.join("；")}。`,
    "群聊事实和成员记忆可以共享，但身份、人格、自我记忆和各自说过的话不能互认。",
    "不要把自己或另一个 bot 称为主号、备用号、备号、接管者，也不要从内部账号 ID 推断主备关系。",
    "旧提示词、历史消息或自我记忆若提到主备，那是切换前的旧语境；当前身份与职责以本段为准。",
    "回答自己是谁时使用当前昵称与职责；除非被问到，不主动解释账号架构或测试状态。"
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
  const next = structuredClone(config);
  next.__activeAccountId = accountId;
  next.__activeAccountDisplayName = account.displayName;
  applyApiCenterBindings(next, center, accountId);
  if (account.behaviorMode) {
    next.behaviorModes = { ...(next.behaviorModes || {}), default: account.behaviorMode };
    next.__behaviorMode = account.behaviorMode;
    const preset = next.behaviorModes.presets?.[account.behaviorMode] || {};
    for (const key of ["trigger", "discussionParticipation", "proactive", "reply", "implicitReply", "socialPlanner"]) {
      next[key] = { ...(next[key] || {}), ...(preset[key] || {}) };
    }
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
  next.persona = { ...(next.persona || {}), displayName: account.displayName };
  if (account.styleProfileId) next.styleProfiles = { ...(next.styleProfiles || {}), activeId: account.styleProfileId };
  next.prompt = { ...(next.prompt || {}), system: systemPromptForAccount(config, accountId) };
  return next;
}
