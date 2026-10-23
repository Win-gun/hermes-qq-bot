import { createHash } from "node:crypto";

/** Pure, synchronous draft writers. Caller owns authentication and durability.
 * Persist claim BEFORE synchronously committing config; settle AFTER commit.
 * Applying after a crash is uncertain: never automatically reclaim or apply it.
 * Nothing here writes (or grants authority to write) the core persona/profile.
 */
const FIELDS = ["identity", "selfName", "expression", "interests", "boundaries", "examples"];
const DAY = 86_400_000, CAPACITY = 32;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === "string" && !FORBIDDEN.has(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const array = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1
  && Reflect.ownKeys(value).every(key => typeof key === "string" && (key === "length" || /^(0|[1-9]\d*)$/.test(key))
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const own = (value, key) => record(value) && Object.hasOwn(value, key);
const copy = value => structuredClone(value);
const fail = reason => ({ ok: false, reason });
const stamp = value => Number.isSafeInteger(value) && value > 0;
const token = value => typeof value === "string" && /^[A-Za-z0-9_:.\-]{1,128}$/.test(value) && !FORBIDDEN.has(value);
const qq = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const logical = value => typeof value === "string" && /^(account|group):[A-Za-z0-9_.:\-]{1,100}$/.test(value);
const conversation = value => typeof value === "string" && /^(group|private):[1-9][0-9]{0,19}$/.test(value);
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const admin = actor => keys(actor, ["id", "authorized"]) && token(actor.id) && actor.authorized === true;

// Hash a fixed field order, not JS insertion order. Missing fields are empty,
// as in socialAgentConfig(). Unknown fields/types are not silently discarded.
function profile(value) {
  if (!keys(value, FIELDS)) return null;
  if (Object.entries(value).some(([key, item]) => typeof item !== "string"
    || item.length > (key === "examples" ? 2000 : 800))) return null;
  return Object.fromEntries(FIELDS.map(key => [key, value[key] ?? ""]));
}
function changesOf(value) {
  if (!array(value) || value.length < 1 || value.length > FIELDS.length) return null;
  const fields = new Set();
  for (const change of value) {
    if (!keys(change, ["field", "value", "evidenceMessageIds"]) || !FIELDS.includes(change.field)
      || fields.has(change.field) || !text(change.value, change.field === "examples" ? 2000 : 800)
      || !array(change.evidenceMessageIds) || !change.evidenceMessageIds.length || change.evidenceMessageIds.length > 32
      || change.evidenceMessageIds.some(id => !token(id))) return null;
    fields.add(change.field);
  }
  return value.map(change => ({ field: change.field, value: change.value,
    evidenceMessageIds: [...new Set(change.evidenceMessageIds)].sort() }))
    .sort((a, b) => FIELDS.indexOf(a.field) - FIELDS.indexOf(b.field));
}
function botAt(root, logicalId) {
  if (!record(root) || !record(root.socialAgents) || root.socialAgents.version !== 1
    || !record(root.socialAgents.bots) || !own(root.socialAgents.bots, logicalId)
    || !record(root.socialAgents.bots[logicalId])) return null;
  return root.socialAgents.bots[logicalId];
}
function validProposal(item, logicalId) {
  if (!record(item) || typeof item.id !== "string" || !/^persona:[a-f0-9]{64}$/.test(item.id) || item.logicalId !== logicalId
    || !conversation(item.conversationId) || !qq(item.userId) || !stamp(item.createdAt)
    || !stamp(item.updatedAt) || item.updatedAt < item.createdAt
    || !["pending", "applying", "approved", "rejected", "failed"].includes(item.status)
    || !Number.isSafeInteger(item.revision) || item.revision < 1) return false;
  const changes = changesOf(item.changes), base = profile(item.baseProfile);
  if (!changes || !base || hash(base) !== item.baseProfileHash || !array(item.evidence)
    || item.evidence.length < 1 || item.evidence.length > 32) return false;
  const ids = [...new Set(changes.flatMap(change => change.evidenceMessageIds))].sort();
  if (ids.length !== item.evidence.length || item.evidence.some((source, i) => !keys(source,
    ["messageId", "userId", "conversationId", "sentAt", "receivedAt", "isBot", "isQuoted", "text"])
    || source.messageId !== ids[i] || source.userId !== item.userId || source.conversationId !== item.conversationId
    || source.isBot !== false || source.isQuoted !== false || !text(source.text, 4000)
    || !stamp(source.sentAt) || !stamp(source.receivedAt) || source.sentAt > source.receivedAt
    || source.receivedAt > item.createdAt || source.sentAt > item.createdAt
    || item.createdAt - source.sentAt > DAY || item.createdAt - source.receivedAt > DAY)) return false;
  if (item.id !== proposalId(logicalId, item.conversationId, item.userId, changes)) return false;
  if (item.status === "pending") return item.revision === 1 && item.claim === undefined && item.resolution === undefined;
  if (item.claim !== undefined) {
    const claim = item.claim, current = profile(claim?.currentProfile);
    if (!record(claim) || !token(claim.actorId) || !stamp(claim.claimedAt) || claim.claimedAt < item.createdAt
      || !current || hash(current) !== item.baseProfileHash || claim.currentProfileHash !== item.baseProfileHash) return false;
  }
  if (item.status === "applying") return item.revision === 2 && record(item.claim)
    && item.updatedAt === item.claim.claimedAt && item.resolution === undefined;
  return record(item.resolution) && token(item.resolution.actorId) && item.resolution.status === item.status
    && item.resolution.settledAt === item.updatedAt
    && (item.claim !== undefined ? item.revision === 3 && item.resolution.actorId === item.claim.actorId
      && item.updatedAt >= item.claim.claimedAt : item.revision === 2 && item.status === "rejected");
}
function proposalsAt(bot, logicalId) {
  if (!bot) return null;
  if (!own(bot, "personaProposals")) return [];
  const items = bot.personaProposals;
  if (!array(items) || items.length > CAPACITY || items.some(item => !validProposal(item, logicalId))
    || new Set(items.map(item => item.id)).size !== items.length) return null;
  return items;
}
function proposalId(logicalId, conversationId, userId, changes) {
  // No now/base hash: replay after a config change cannot resurrect an original.
  return `persona:${hash([logicalId, conversationId, userId, changes])}`;
}
function summary(item) {
  return { id: item.id, logicalId: item.logicalId, conversationId: item.conversationId, userId: item.userId,
    status: item.status, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt,
    baseProfileHash: item.baseProfileHash, changes: copy(item.changes),
    evidence: item.evidence.map(({ messageId, userId, conversationId, sentAt, receivedAt }) =>
      ({ messageId, userId, conversationId, sentAt, receivedAt })),
    ...(item.claim ? { claimedBy: item.claim.actorId, claimedAt: item.claim.claimedAt } : {}),
    ...(item.resolution ? { resolvedBy: item.resolution.actorId, resolvedAt: item.resolution.settledAt } : {}) };
}

/** One atomic batch -> one pending proposal. Evidence is ONLY the current bot's
 * canonical conversation.messages, never caller-supplied message bodies.
 * Changes have exactly {field,value,evidenceMessageIds}; profile fields string.
 */
export function proposePersonaChanges(root, args = {}) {
  if (!record(args) || !logical(args.logicalId) || !conversation(args.conversationId)
    || !qq(args.userId) || !stamp(args.now)
    || (args.conversationId.startsWith("private:") && args.conversationId !== `private:${args.userId}`)) return fail("invalid_args");
  const changes = changesOf(args.changes), baseProfile = profile(args.baseProfile);
  if (!changes) return fail("invalid_changes");
  if (!baseProfile) return fail("invalid_profile");
  const bot = botAt(root, args.logicalId), proposals = proposalsAt(bot, args.logicalId);
  if (!proposals) return fail("invalid_state");
  const conversations = bot.conversations;
  const state = own(conversations, args.conversationId) ? conversations[args.conversationId] : null;
  if (!record(state) || !array(state.messages)) return fail("invalid_source");
  const ids = [...new Set(changes.flatMap(change => change.evidenceMessageIds))].sort();
  if (ids.length > 32) return fail("invalid_source");
  const evidence = [];
  for (const id of ids) {
    const matches = state.messages.filter(item => record(item) && item.messageId === id);
    if (matches.length !== 1) return fail("invalid_source");
    const message = matches[0];
    if (message.userId !== args.userId || message.isBot !== false || message.isQuoted !== false
      || !text(message.text, 4000) || !stamp(message.sentAt) || !stamp(message.receivedAt)
      || message.sentAt > args.now || message.receivedAt > args.now || message.sentAt > message.receivedAt
      || args.now - message.sentAt > DAY || args.now - message.receivedAt > DAY
      || (own(message, "conversationId") && message.conversationId !== args.conversationId)
      || Object.keys(message).some(key => !["seq", "messageId", "userId", "text", "sentAt", "receivedAt",
        "isBot", "isQuoted", "conversationId"].includes(key))) return fail("invalid_source");
    evidence.push({ messageId: id, userId: message.userId, conversationId: args.conversationId,
      sentAt: message.sentAt, receivedAt: message.receivedAt, isBot: false, isQuoted: false, text: message.text });
  }
  const id = proposalId(args.logicalId, args.conversationId, args.userId, changes);
  const original = proposals.find(item => item.id === id);
  if (original) return { ok: true, id, revision: original.revision, duplicate: true, proposal: summary(original) };
  if (proposals.length >= CAPACITY) return fail("backpressure");
  const proposal = { id, logicalId: args.logicalId, conversationId: args.conversationId, userId: args.userId,
    changes, evidence, baseProfile, baseProfileHash: hash(baseProfile), revision: 1, status: "pending",
    createdAt: args.now, updatedAt: args.now };
  bot.personaProposals = [...proposals, proposal];
  return { ok: true, id, revision: 1, duplicate: false, proposal: summary(proposal) };
}

function target(root, args) {
  if (!record(args) || !logical(args.logicalId) || typeof args.id !== "string" || !/^persona:[a-f0-9]{64}$/.test(args.id)
    || !stamp(args.now) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) return fail("invalid_args");
  if (!admin(args.actor)) return fail("unauthorized");
  const bot = botAt(root, args.logicalId), items = proposalsAt(bot, args.logicalId);
  if (!items) return fail("invalid_state");
  const item = items.find(proposal => proposal.id === args.id);
  if (!item) return fail("not_found");
  if (item.revision !== args.expectedRevision) return fail("stale_revision");
  if (args.now < item.updatedAt) return fail("invalid_time");
  return { ok: true, item, bot };
}

/** Requires exact CAS + authenticated actor and base hash. Returns new revision.
 * Another outstanding applying claim blocks all further claims on this bot.
 */
export function claimPersonaProposal(root, args = {}) {
  const found = target(root, args);
  if (!found.ok) return found;
  const { item, bot } = found;
  if (item.status !== "pending") return fail("invalid_status");
  if (bot.personaProposals.some(proposal => proposal.status === "applying")) return fail("application_in_progress");
  const currentProfile = profile(args.currentProfile);
  if (!currentProfile) return fail("invalid_profile");
  if (hash(currentProfile) !== item.baseProfileHash) return fail("stale_profile");
  item.status = "applying";
  item.revision++;
  item.updatedAt = args.now;
  item.claim = { actorId: args.actor.id, claimedAt: args.now, currentProfile,
    currentProfileHash: hash(currentProfile) };
  return { ok: true, id: item.id, revision: item.revision, proposal: summary(item) };
}

/** expectedRevision is REQUIRED even though older callers may mark it optional.
 * Pending -> rejected; applying -> approved/rejected/failed by SAME claim actor.
 * Every terminal original stays intact. No retry/reset/automatic apply path.
 */
export function settlePersonaProposal(root, args = {}) {
  const found = target(root, args);
  if (!found.ok) return found;
  const { item } = found;
  if (!["approved", "rejected", "failed"].includes(args.status)) return fail("invalid_status");
  if (item.status !== "applying" && !(item.status === "pending" && args.status === "rejected")) return fail("invalid_status");
  if (item.status === "applying" && item.claim.actorId !== args.actor.id) return fail("actor_mismatch");
  item.status = args.status;
  item.revision++;
  item.updatedAt = args.now;
  item.resolution = { actorId: args.actor.id, status: args.status, settledAt: args.now };
  return { ok: true, id: item.id, revision: item.revision, proposal: summary(item) };
}

/** Whitelist projection only. No raw source text, base/current profile snapshots,
 * arbitrary internal fields, or mutable references. Parent MUST redact values
 * for UI/API secret policy; this is not a general-purpose secret detector.
 */
export function publicPersonaProposals(root, logicalId) {
  if (!logical(logicalId)) return [];
  const items = proposalsAt(botAt(root, logicalId), logicalId);
  return items ? items.map(summary) : [];
}
