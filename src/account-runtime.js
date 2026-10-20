import { createHash } from "node:crypto";
import { accountItems, accountGroup, accountPolicy, effectiveAccount } from "./account-registry.js";
import { configForAccountCapabilities } from "./bot-capabilities.js";
import { automationForAccount } from "./account-automation.js";
import { resolveApiCapability } from "./api-center.js";
import { projectBehaviorSettings, normalizeBehaviorSelection } from "./behavior-settings.js";

const BEHAVIOR_KEYS = ["ai", "prompt", "botNames", "__peerBotNames", "reply", "trigger", "history", "memory", "chatArchive",
  "implicitReply", "discussionParticipation", "proactive", "socialPlanner", "delayedUnderstanding", "negativeFeedback",
  "messageDebounce", "responseQueue", "learningMode", "taskMode", "vision", "voice", "webSearch", "messageTime",
  "privateChats", "send", "commands", "targetGroups", "groups"];
const TRANSPORT_KEYS = ["qq", "enabled", "protocolEnabled", "archived", "protocol", "managed", "onebotPath", "onebotWsUrl", "protocolContainer"];
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  return value;
};
const signature = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const participating = (account) => account && account.enabled !== false && account.protocolEnabled !== false && !account.archived;

export function logicalBotId(config, accountId) {
  const item = accountItems(config).find((account) => account.id === String(accountId));
  if (!item) return "";
  const group = accountGroup(config, item.id);
  return group ? `group:${group.id}` : `account:${item.id}`;
}

export function botConversationKey(logicalId, conversationId) {
  return JSON.stringify([String(logicalId), String(conversationId)]);
}

export function botControlRevision(memory, conversationId, config, accountId, options = {}) {
  const shared = memory?.groups?.[String(conversationId)]?.settings || {};
  const ownerId = options.ownerId || logicalBotId(config, accountId);
  const scoped = shared.botSettings?.[ownerId];
  const settings = { ...shared, ...scoped };
  const projected = options.projected || configForAccountCapabilities(config, accountId);
  const mode = normalizeBehaviorSelection(settings.behaviorMode)
    || normalizeBehaviorSelection(projected.behaviorModes?.default) || "normal";
  const behavior = projectBehaviorSettings(projected, mode);
  return signature({ controls: Object.fromEntries(["quietUntil", "behaviorMode", "voiceReplyMode", "voicePreset", "voicePresetUpdatedAt", "learningMode"]
    .map((key) => [key, key === "behaviorMode" ? mode : settings[key]])), behavior: Object.fromEntries(
      ["trigger", "discussionParticipation", "proactive", "reply", "implicitReply", "socialPlanner"].map((key) => [key, behavior[key]])) });
}

// One authority for logical identities, route epochs and effective policy
// revisions. It owns no sockets, credentials, timers, files or model calls.
// Global UI/default-route fields may mirror this state but cannot select a bot.
export class AccountRuntime {
  #owners = new Map();
  #accounts = new Map();
  #sequence = 0;

  constructor(config = {}) { this.updateConfig(config); }

  updateConfig(config) {
    const owners = new Map(), accounts = new Map();
    const changedOwners = new Set(), routeChangedOwners = new Set();
    for (const item of accountItems(config)) {
      const group = accountGroup(config, item.id);
      const ownerId = group ? `group:${group.id}` : `account:${item.id}`;
      const effective = effectiveAccount(config, item.id);
      const projected = configForAccountCapabilities(config, item.id);
      const automation = automationForAccount(config, item.id);
      const policyHash = signature({ policy: accountPolicy(effective), enabled: group ? undefined : item.enabled,
        behavior: Object.fromEntries(BEHAVIOR_KEYS.map((key) => [key, projected[key]])),
        mode: projected.behaviorModes?.default,
        automation: { enabled: automation.enabled, rules: automation.rules, routines: automation.routines },
        api: Object.fromEntries(["chat", "task", "vision", "asr", "tts", "search"]
          .map((kind) => [kind, resolveApiCapability(config, kind, item.id)])) });
      const transportHash = signature({ listen: config.listen,
        account: Object.fromEntries(TRANSPORT_KEYS.map((key) => [key, item[key]])) });
      const oldAccount = this.#accounts.get(item.id);
      const transportRevision = oldAccount?.transportHash === transportHash && oldAccount.ownerId === ownerId
        ? oldAccount.transportRevision : ++this.#sequence;
      accounts.set(item.id, { ownerId, transportHash, transportRevision, participating: participating(item), projected });
      let owner = owners.get(ownerId);
      if (!owner) {
        const previous = this.#owners.get(ownerId);
        const members = group ? [...group.memberIds] : [item.id];
        const membershipHash = signature(members);
        const routeChanged = !previous || previous.membershipHash !== membershipHash;
        owner = { ownerId, memberIds: members, membershipHash, policyHash,
          policyRevision: previous?.policyHash === policyHash ? previous.policyRevision : ++this.#sequence,
          routeEpoch: routeChanged ? ++this.#sequence : previous.routeEpoch,
          accountId: previous?.accountId || (group ? "" : item.id),
          switchedAt: previous?.switchedAt || 0, unhealthySince: previous?.unhealthySince || 0,
          reasonCode: previous?.reasonCode || "initialized" };
        if (previous && previous.policyHash !== policyHash) changedOwners.add(ownerId);
        if (previous && routeChanged) routeChangedOwners.add(ownerId);
        owners.set(ownerId, owner);
      }
      // A transport change invalidates only this carrier's captured contexts;
      // it need not invalidate a healthy independent peer's policy revision.
      if (oldAccount && oldAccount.ownerId !== ownerId) {
        routeChangedOwners.add(oldAccount.ownerId);
        routeChangedOwners.add(ownerId);
      }
    }
    for (const owner of owners.values()) {
      if (owner.accountId && (!owner.memberIds.includes(owner.accountId) || !accounts.get(owner.accountId)?.participating)) {
        owner.accountId = ""; owner.unhealthySince = 0;
        owner.routeEpoch = ++this.#sequence;
        routeChangedOwners.add(owner.ownerId);
      }
      if (!owner.accountId && owner.ownerId.startsWith("account:")) {
        const id = owner.memberIds[0];
        if (accounts.get(id)?.participating) {
          owner.accountId = id; owner.routeEpoch = ++this.#sequence;
        }
      }
    }
    for (const old of this.#owners.keys()) if (!owners.has(old)) routeChangedOwners.add(old);
    this.#owners = owners; this.#accounts = accounts;
    return { changedOwners: [...changedOwners], routeChangedOwners: [...routeChangedOwners] };
  }

  ownerForAccount(accountId) { return this.#accounts.get(String(accountId))?.ownerId || ""; }
  controlRevision(memory, conversationId, accountId) {
    const account = this.#accounts.get(String(accountId));
    return account ? botControlRevision(memory, conversationId, {}, accountId, { ownerId: account.ownerId, projected: account.projected }) : "";
  }
  route(ownerId) {
    const owner = this.#owners.get(String(ownerId));
    return owner ? Object.freeze({ logicalBotId: owner.ownerId, id: owner.accountId, routeEpoch: owner.routeEpoch,
      switchedAt: owner.switchedAt, unhealthySince: owner.unhealthySince, reasonCode: owner.reasonCode }) : null;
  }
  selectedForAccount(accountId) {
    const account = this.#accounts.get(String(accountId));
    return Boolean(account?.participating && this.#owners.get(account.ownerId)?.accountId === String(accountId));
  }
  select(ownerId, accountId, { now = Date.now(), reasonCode = "route-updated" } = {}) {
    const owner = this.#owners.get(String(ownerId)), account = this.#accounts.get(String(accountId));
    if (!owner || !account?.participating || account.ownerId !== owner.ownerId || !owner.memberIds.includes(String(accountId))) return false;
    if (owner.accountId === String(accountId)) return true;
    owner.accountId = String(accountId); owner.routeEpoch = ++this.#sequence;
    owner.switchedAt = Number.isFinite(now) ? now : Date.now(); owner.unhealthySince = 0;
    owner.reasonCode = /^[a-z0-9._-]{1,64}$/i.test(reasonCode) ? reasonCode : "route-updated";
    return true;
  }
  noteHealth(ownerId, unhealthy, at = Date.now()) {
    const owner = this.#owners.get(String(ownerId));
    if (!owner) return null;
    if (!unhealthy) owner.unhealthySince = 0;
    else if (!owner.unhealthySince) owner.unhealthySince = Number.isFinite(at) ? at : Date.now();
    return this.route(ownerId);
  }
  capture(accountId, { sessionId = "", conversationId = "", controlRevision = "" } = {}) {
    const id = String(accountId), account = this.#accounts.get(id);
    const owner = account && this.#owners.get(account.ownerId);
    if (!owner) return null;
    return Object.freeze({ logicalBotId: owner.ownerId, accountId: id, sessionId: String(sessionId ?? ""),
      routeEpoch: owner.routeEpoch, policyRevision: owner.policyRevision, transportRevision: account.transportRevision,
      conversationId: String(conversationId), controlRevision: String(controlRevision) });
  }
  isCurrent(context, { sessionId, controlRevision, requireSelected = true } = {}) {
    if (!context) return false;
    const current = this.capture(context.accountId, { sessionId: sessionId === undefined ? context.sessionId : sessionId,
      conversationId: context.conversationId, controlRevision: controlRevision === undefined ? context.controlRevision : controlRevision });
    return Boolean(current && Object.keys(current).every((key) => current[key] === context[key])
      && (!requireSelected || this.selectedForAccount(context.accountId)));
  }
  isIdentityCurrent(context, { sessionId } = {}) {
    if (!context) return false;
    const current = this.capture(context.accountId, { sessionId: sessionId === undefined ? context.sessionId : sessionId });
    return Boolean(current && ["logicalBotId", "accountId", "sessionId", "routeEpoch"].every((key) => current[key] === context[key]));
  }
  revision(accountId) {
    const context = this.capture(accountId);
    return context ? JSON.stringify([context.logicalBotId, context.routeEpoch, context.policyRevision, context.transportRevision]) : "";
  }
  snapshot() {
    return [...this.#owners.values()].map((owner) => ({ logicalBotId: owner.ownerId, memberIds: [...owner.memberIds],
      accountId: owner.accountId, routeEpoch: owner.routeEpoch, policyRevision: owner.policyRevision,
      switchedAt: owner.switchedAt, unhealthySince: owner.unhealthySince, reasonCode: owner.reasonCode }));
  }
}
