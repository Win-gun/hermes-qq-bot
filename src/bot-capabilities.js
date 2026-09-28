const BOT_MODES = new Set(["chat", "task", "all"]);
const TOPOLOGIES = new Set(["failover", "collaboration", "function_split"]);

export function normalizeBotMode(value) {
  return BOT_MODES.has(value) ? value : "all";
}

export function accountTopology(config = {}) {
  return TOPOLOGIES.has(config.accounts?.topology) ? config.accounts.topology : "failover";
}

// Group facts and member profiles remain shared. Only the bot's own identity
// diverges when accounts are configured as independent collaborators.
export function botSelfSlot(gm, config = {}) {
  const primaryId = config.accounts?.primary?.id || "primary";
  const accountId = config.__activeAccountId || primaryId;
  if (accountTopology(config) === "failover" || accountId === primaryId) return (gm.botSelf ||= {});
  gm.botSelfByAccount ||= {};
  return (gm.botSelfByAccount[accountId] ||= {});
}

export function botModeForAccount(config = {}, accountId = "primary") {
  const primaryId = config.accounts?.primary?.id || "primary";
  const roleId = accountTopology(config) === "failover" ? primaryId : accountId;
  return normalizeBotMode(config.botFeatures?.accountModes?.[roleId] || config.botFeatures?.defaultMode);
}

export function accountCanChat(config = {}, accountId = "primary") {
  return botModeForAccount(config, accountId) !== "task";
}

export function accountCanOfferTask(config = {}, accountId = "primary") {
  return botModeForAccount(config, accountId) !== "chat";
}

export function styleProfileForAccount(config = {}, accountId = "primary") {
  const accounts = config.accounts || {};
  const identityId = accountTopology(config) === "failover" ? (accounts.primary?.id || "primary") : accountId;
  const account = identityId === (accounts.primary?.id || "primary")
    ? accounts.primary
    : (accounts.standbys || []).find((item) => item?.id === identityId);
  const profiles = Array.isArray(config.styleProfiles?.profiles) ? config.styleProfiles.profiles : [];
  const selectedId = account?.styleProfileId || config.styleProfiles?.activeId || "legacy";
  return profiles.find((item) => item?.id === selectedId)
    || profiles.find((item) => item?.id === "legacy")
    || null;
}

export function systemPromptForAccount(config = {}, accountId = "primary") {
  const accounts = config.accounts || {};
  const identityId = accountTopology(config) === "failover" ? (accounts.primary?.id || "primary") : accountId;
  const account = identityId === (accounts.primary?.id || "primary")
    ? accounts.primary
    : (accounts.standbys || []).find((item) => item?.id === identityId);
  if (typeof account?.promptOverride === "string" && account.promptOverride.trim()) return account.promptOverride;
  const profile = styleProfileForAccount(config, accountId);
  return String(profile?.systemPrompt || config.prompt?.system || "");
}
