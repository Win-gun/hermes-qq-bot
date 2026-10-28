import { createHash } from "node:crypto";

/** Phase 1: synchronous latest-draft builders ONLY, inside mutateMemory.
 * No IO, clock, timers, model calls, permission grants or core-persona edits.
 * Host supplies now and the effective, trusted coreText (never model prose).
 * Host alone may call review/freeze with an authenticated actor; the boolean
 * below is a host assertion, NOT an authentication mechanism or QQ command API.
 *
 * Evidence adapter: bot.conversations[groupId].messages contains ingested human
 * events; .experiences contains outbound ACKs. Self requires confirmed bot_reply
 * AND host-owned agencyEligible === true, attached only after actual autonomous
 * send ACK. Legacy experiences deliberately do not qualify. IDs are messageId,
 * not experience IDs. A label must occur literally in the original source text;
 * this is conservative provenance, not semantic/model verification.
 *
 * Writers return {ok, revision, ...} or {ok:false, code}; readers throw a coded
 * TypeError on invalid arguments/state, never silently return empty corruption.
 * All failed writes are atomic; duplicate evidence is a no-op under exact CAS.
 * Rejected/explicitly expired/TTL-expired entries cannot be auto-resurrected.
 * All tombstones consume capacity; no FIFO eviction or automatic retry.
 */
const DAY = 86_400_000;
const MAX_ENTRIES = 256, MAX_EVIDENCE = 32;
const KINDS = ["self", "group", "member"];
const DIMENSIONS = ["interest", "expression", "humor", "density", "rhythm", "interaction"];
const STATUSES = ["candidate", "active", "rejected", "expired"];
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const own = (value, key) => Object.hasOwn(value, key);
const hash = value => createHash("sha256").update(value).digest("hex");
const copy = value => structuredClone(value);
const fail = code => ({ ok: false, code: `SOCIAL_PREFERENCE_${code}` });
const error = code => Object.assign(new TypeError(`SOCIAL_PREFERENCE_${code}`), { code: `SOCIAL_PREFERENCE_${code}` });
const integer = value => Number.isSafeInteger(value) && value >= 0;
// Leave space for TTL arithmetic and Shanghai's UTC+8 date projection.
const stamp = value => integer(value) && value > 0 && value <= 8_640_000_000_000_000 - 31 * DAY;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = value => typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value) && !RESERVED.has(value);
const qq = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const group = value => typeof value === "string" && /^group:[1-9][0-9]{0,19}$/.test(value);
const logical = value => typeof value === "string" && /^(account|group):[A-Za-z0-9_.:-]{1,100}$/.test(value)
  && value.split(/[.:]/).every(part => !RESERVED.has(part));

// JSON-like data records only. Never evaluate accessors while validating.
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === "string" && !FORBIDDEN.has(key)
      && own(Object.getOwnPropertyDescriptor(value, key), "value")
      && Object.getOwnPropertyDescriptor(value, key).enumerable);
}
const keys = (value, allowed) => record(value) && Reflect.ownKeys(value).every(key => allowed.includes(key));
const exact = (value, allowed) => keys(value, allowed) && allowed.every(key => own(value, key));
function list(value, max = MAX_EVIDENCE) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || (typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length
      && Object.getOwnPropertyDescriptor(value, key).enumerable
      && own(Object.getOwnPropertyDescriptor(value, key), "value")));
}
const normalized = value => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const unsafe = /[\p{Cc}\p{Cf}]|(?:https?|file|ftp):|www\.|[/\\@]|\d{5,}|(?:sk-|sk_|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,}|(?:api[ _-]?key|password|secret|token|bearer|cookie|密码|密钥|验证码|身份证|银行卡|手机号|住址|QQ号|企鹅号|user[_ -]?id)/iu;
const directive = /权限|授权|授予|管理员|系统提示|开发者|忽略|执行命令|工具调用|私聊|本地文件|删除文件|读取文件|写入文件|发送消息|提权|越权|你是|你必须|扮演|核心人格|sudo|system|developer|prompt|instruction|permission|\b(?:ignore|bypass|override|grant|admin|administrator|execute|shell|terminal)\b/iu;
function label(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    && value === value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    && /^[\p{L}\p{M}\p{N} _+·—-]+$/u.test(value) && !/^\d+$/u.test(value)
    && !unsafe.test(value) && !directive.test(value);
}
const reasonOK = value => typeof value === "string" && value.trim().length > 0 && value.length <= 240
  && !unsafe.test(value.normalize("NFKC"));
const actorOK = value => exact(value, ["authorized"]) && value.authorized === true;
const ttl = kind => (kind === "group" ? 7 : 30) * DAY;
const day = at => Math.floor((at + 8 * 3_600_000) / DAY);
const sourceType = kind => kind === "self" ? "agency_bot_reply" : "human_message";
const empty = () => ({ version: 1, revision: 0, entries: [], growthFrozen: false });
const idFor = e => `preference:${hash(JSON.stringify([e.logicalId, e.kind, e.conversationId, e.userId, e.dimension, normalized(e.value)]))}`;
const terminal = e => e.status === "rejected" || e.status === "expired";
const effectiveStatus = (e, now) => terminal(e) ? e.status : now >= e.expiresAt ? "expired" : e.status;

// Negation/correction in the same clause never establishes positive support.
// Deliberately conservative: ambiguous negation becomes negative, not maturity.
function polarity(text, value) {
  const needle = normalized(value);
  const clauses = normalized(text).split(/[。！？!?；;\n]/u).filter(clause => {
    let at = clause.indexOf(needle);
    while (at >= 0) {
      const before = clause[at - 1] || "", after = clause[at + needle.length] || "";
      if (!(/[a-z0-9]/i.test(needle[0]) && /[a-z0-9]/i.test(before))
        && !(/[a-z0-9]/i.test(needle.at(-1)) && /[a-z0-9]/i.test(after))) return true;
      at = clause.indexOf(needle, at + 1);
    }
    return false;
  });
  if (!clauses.length) return null;
  if (clauses.some(s => /更正|纠正|修正|撤回|\b(?:correction|retract|corrected)\b/u.test(s))) return "correction";
  if (clauses.some(s => /不|没|无|讨厌|反感|拒绝|禁止|勿|别再|\b(?:not|never|dislike|hate|avoid|no longer|don't)\b/u.test(s))) return "negative";
  return "positive";
}
function consistency(coreText, value) {
  if (coreText === undefined) return { hash: null, compatible: null, source: "unknown" };
  const compatible = polarity(coreText, value) === "positive";
  return { hash: hash(coreText), compatible: compatible ? true : null, source: compatible ? "literal" : "unknown" };
}
function qualifies(e, now) {
  const refs = e.evidence.filter(ref => ref.polarity === "positive" && now < ref.sentAt + ttl(e.kind));
  return refs.length >= 3 && (e.kind === "group" ? new Set(refs.map(ref => ref.senderId)).size >= 3
    : new Set(refs.map(ref => day(ref.sentAt))).size >= 2);
}
function confidence(e, now) {
  const refs = e.evidence.filter(ref => ref.polarity === "positive" && now < ref.sentAt + ttl(e.kind));
  if (!refs.length || (e.tombstone && e.tombstone.type !== "expired")
    || e.feedback.negativeEvidenceIds.length || e.feedback.correctionEvidenceIds.length) return 0;
  const diversity = e.kind === "group" ? new Set(refs.map(ref => ref.senderId)).size >= 3
    : new Set(refs.map(ref => day(ref.sentAt))).size >= 2;
  // Evidence strength only; neither model input, core prose nor an admin vote
  // manufactures confidence. Compatibility and approval affect status separately.
  return (Math.min(refs.length, 3) * 25 + (diversity ? 10 : 0)) / 100;
}
function computedStatus(e, now) {
  if (e.tombstone) return e.tombstone.type === "expired" ? "expired" : "rejected";
  if (now >= e.expiresAt) return "expired";
  return qualifies(e, now) && (e.kind !== "self" || e.coreConsistency.compatible === true) ? "active" : "candidate";
}

const REF_KEYS = ["messageId", "conversationId", "senderId", "sourceType", "sentAt", "textHash", "polarity"];
const ENTRY_KEYS = ["id", "logicalId", "kind", "conversationId", "userId", "dimension", "value", "sourceType",
  "evidence", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt", "confidence", "coreConsistency", "status",
  "expiresAt", "feedback", "review", "tombstone"];
function validEntry(e, logicalId) {
  if (!exact(e, ENTRY_KEYS) || e.logicalId !== logicalId || !KINDS.includes(e.kind) || !label(e.value)
    || !DIMENSIONS.includes(e.dimension) || !STATUSES.includes(e.status) || e.sourceType !== sourceType(e.kind)
    || (e.kind === "self" ? e.conversationId !== null : !group(e.conversationId))
    || (e.kind === "member" ? !qq(e.userId) : e.userId !== null) || e.id !== idFor(e)
    || !list(e.evidence) || !e.evidence.length || ![e.firstSeenAt, e.lastSeenAt, e.createdAt, e.updatedAt].every(stamp)
    || e.updatedAt < e.createdAt || e.createdAt < e.firstSeenAt || e.updatedAt < e.lastSeenAt
    || e.expiresAt !== e.lastSeenAt + ttl(e.kind)) return false;
  if (!e.evidence.every(ref => exact(ref, REF_KEYS) && token(ref.messageId) && group(ref.conversationId)
    && (e.kind === "self" ? ref.senderId === null : qq(ref.senderId)) && ref.sourceType === e.sourceType
    && (e.kind === "self" || ref.conversationId === e.conversationId)
    && (e.kind !== "member" || ref.senderId === e.userId) && stamp(ref.sentAt) && digest(ref.textHash)
    && ["positive", "negative", "correction"].includes(ref.polarity))) return false;
  if (new Set(e.evidence.map(ref => ref.messageId)).size !== e.evidence.length
    || e.firstSeenAt !== Math.min(...e.evidence.map(ref => ref.sentAt))
    || e.lastSeenAt !== Math.max(...e.evidence.map(ref => ref.sentAt))) return false;
  const c = e.coreConsistency;
  if (!exact(c, ["hash", "compatible", "source"]) || !(c.hash === null || digest(c.hash))
    || ![null, true].includes(c.compatible) || !["unknown", "literal", "admin"].includes(c.source)
    || (c.source === "unknown" ? c.compatible !== null : c.compatible !== true)
    || (c.source === "literal" && c.hash === null)
    || (e.kind !== "self" && (c.hash !== null || c.source !== "unknown"))) return false;
  if (!exact(e.feedback, ["negativeEvidenceIds", "correctionEvidenceIds"])) return false;
  for (const [key, type] of [["negativeEvidenceIds", "negative"], ["correctionEvidenceIds", "correction"]]) {
    if (!list(e.feedback[key]) || JSON.stringify(e.feedback[key]) !== JSON.stringify(e.evidence
      .filter(ref => ref.polarity === type).map(ref => ref.messageId))) return false;
  }
  if (e.review !== null && (!exact(e.review, ["action", "reason", "at", "compatibility"])
    || !["approve", "reject", "expire"].includes(e.review.action) || !reasonOK(e.review.reason)
    || !stamp(e.review.at) || e.review.at > e.updatedAt || e.review.at < e.createdAt
    || (e.kind === "self" && e.review.action === "approve" ? e.review.compatibility !== "compatible" : e.review.compatibility !== null))) return false;
  if ((c.source === "admin") !== (e.kind === "self" && e.review?.action === "approve")) return false;
  if (e.tombstone !== null && (!exact(e.tombstone, ["type", "at", "reason"])
    || !["negative", "correction", "expired"].includes(e.tombstone.type) || !stamp(e.tombstone.at)
    || e.tombstone.at < e.createdAt || e.tombstone.at > e.updatedAt || !reasonOK(e.tombstone.reason))) return false;
  if ((e.feedback.negativeEvidenceIds.length || e.feedback.correctionEvidenceIds.length) && !e.tombstone) return false;
  if ((e.review?.action === "reject" && e.tombstone?.type !== "correction")
    || (e.review?.action === "expire" && e.tombstone?.type !== "expired")) return false;
  return e.confidence === confidence(e, e.updatedAt) && e.status === computedStatus(e, e.updatedAt);
}
function validState(s, id) {
  return exact(s, ["version", "revision", "entries", "growthFrozen"]) && s.version === 1 && integer(s.revision)
    && typeof s.growthFrozen === "boolean" && list(s.entries, MAX_ENTRIES)
    && s.revision >= s.entries.length && (s.revision > 0 || (!s.entries.length && !s.growthFrozen))
    && s.entries.every(e => validEntry(e, id)) && new Set(s.entries.map(e => e.id)).size === s.entries.length;
}

// Find one publication slot: no intermediate containers are written on failure.
function locate(root, id) {
  if (!record(root)) throw error("INVALID_STATE");
  const fallback = { state: empty(), bot: null };
  if (!own(root, "socialAgents")) return { ...fallback, target: root, key: "socialAgents", missing: "social" };
  const social = root.socialAgents;
  if (!record(social) || !own(social, "version") || social.version !== 1
    || !own(social, "bots") || !record(social.bots)) throw error("INVALID_STATE");
  const bots = social.bots;
  if (!own(bots, id)) return { ...fallback, target: bots, key: id, missing: "bot" };
  const bot = bots[id];
  if (!record(bot)) throw error("INVALID_STATE");
  if (!own(bot, "socialPreferences")) return { ...fallback, bot, target: bot, key: "socialPreferences" };
  if (!validState(bot.socialPreferences, id)) throw error("INVALID_STATE");
  return { bot, state: bot.socialPreferences, target: bot, key: "socialPreferences" };
}
function publish(slot, id, state, result) {
  const bot = { socialPreferences: state };
  const value = slot.missing === "social" ? { version: 1, bots: { [id]: bot } }
    : slot.missing === "bot" ? bot : state;
  const descriptor = Object.getOwnPropertyDescriptor(slot.target, slot.key);
  if (descriptor ? !descriptor.writable : !Object.isExtensible(slot.target)) return fail("NOT_WRITABLE");
  try {
    Object.defineProperty(slot.target, slot.key, descriptor ? { ...descriptor, value }
      : { value, enumerable: true, configurable: true, writable: true });
  } catch { return fail("NOT_WRITABLE"); }
  return result;
}
function write(root, args, mutate) {
  let slot;
  try { slot = locate(root, args.logicalId); } catch { return fail("INVALID_STATE"); }
  if (slot.state.revision !== args.expectedRevision) return fail("REVISION_CONFLICT");
  if (slot.state.revision === Number.MAX_SAFE_INTEGER) return fail("BACKPRESSURE");
  if (slot.state.entries.some(e => e.updatedAt > args.now)) return fail("INVALID_TIME");
  const next = copy(slot.state), result = mutate(next, slot.bot);
  if (!result.ok || result.duplicate) return { ...result, ...(result.ok ? { revision: next.revision } : {}) };
  next.revision++;
  if (!validState(next, args.logicalId)) return fail("INVALID_STATE");
  return publish(slot, args.logicalId, next, { ...result, revision: next.revision });
}
const required = (args, names) => names.every(key => own(args, key));
const common = args => required(args, ["logicalId", "expectedRevision", "now"])
  && logical(args.logicalId) && integer(args.expectedRevision) && stamp(args.now);

function resolveEvidence(bot, args) {
  if (!bot || !own(bot, "conversations") || !record(bot.conversations)
    || !own(bot.conversations, args.conversationId)) return fail("INVALID_EVIDENCE");
  const conv = bot.conversations[args.conversationId];
  if (!record(conv)) return fail("INVALID_STATE");
  const poolKey = args.kind === "self" ? "experiences" : "messages";
  if (!own(conv, poolKey)) return fail("INVALID_STATE");
  const pool = conv[poolKey];
  if (!list(pool, args.kind === "self" ? 64 : 256) || !pool.every(record)) return fail("INVALID_STATE");
  const refs = [];
  for (const id of new Set(args.evidenceMessageIds)) {
    const matches = pool.filter(item => item.messageId === id);
    if (matches.length !== 1) return fail("INVALID_EVIDENCE");
    const item = matches[0];
    if (!required(item, ["messageId", "sentAt", "text"])
      || !stamp(item.sentAt) || item.sentAt > args.now || args.now >= item.sentAt + ttl(args.kind)
      || typeof item.text !== "string" || !item.text.trim() || item.text.length > 4000
      || (own(item, "logicalId") && item.logicalId !== args.logicalId)
      || (own(item, "conversationId") && item.conversationId !== args.conversationId)
      || (own(item, "revokedAt") && item.revokedAt !== null && item.revokedAt !== 0)
      || (own(item, "status") && item.status !== "active")
      || (own(item, "isQuoted") && item.isQuoted !== false)) return fail("INVALID_EVIDENCE");
    if (args.kind === "self") {
      if (!required(item, ["kind", "confirmed", "agencyEligible", "createdAt"])
        || item.kind !== "bot_reply" || item.confirmed !== true || item.agencyEligible !== true
        || (own(item, "candidate") && item.candidate !== false) || !stamp(item.createdAt) || item.createdAt < item.sentAt
        || item.createdAt > args.now) return fail("INVALID_EVIDENCE");
    } else if (!required(item, ["isBot", "isQuoted", "userId", "receivedAt"])
      || item.isBot !== false || item.isQuoted !== false || !qq(item.userId)
      || (args.kind === "member" && item.userId !== args.userId) || !stamp(item.receivedAt)
      || item.receivedAt > args.now || item.sentAt > item.receivedAt + 60_000) return fail("INVALID_EVIDENCE");
    const support = polarity(item.text, args.value);
    if (!support) return fail("UNGROUNDED_VALUE");
    refs.push({ messageId: id, conversationId: args.conversationId, senderId: args.kind === "self" ? null : item.userId,
      sourceType: sourceType(args.kind), sentAt: item.sentAt, textHash: hash(item.text), polarity: support });
  }
  return { ok: true, refs };
}

/** Record only grounded labels. self is bot-global; other kinds are group-local.
 * Missing core compatibility leaves self candidate. Duplicate calls never extend
 * evidence times/TTL/confidence. coreText is hashed, never retained verbatim.
 */
export function recordSocialPreference(root, args = {}) {
  if (!keys(args, ["logicalId", "conversationId", "kind", "userId", "dimension", "value", "evidenceMessageIds",
    "expectedRevision", "now", "coreText"]) || !common(args)
    || !required(args, ["conversationId", "kind", "dimension", "value", "evidenceMessageIds"]) || !group(args.conversationId)
    || !KINDS.includes(args.kind) || !DIMENSIONS.includes(args.dimension) || !label(args.value)
    || (args.kind === "member" ? !qq(args.userId) : own(args, "userId"))
    || !list(args.evidenceMessageIds) || !args.evidenceMessageIds.length || !args.evidenceMessageIds.every(token)
    || (own(args, "coreText") && (args.kind !== "self" || typeof args.coreText !== "string"
      || !args.coreText.trim() || args.coreText.length > 32_768))) return fail("INVALID_ARGS");
  return write(root, args, (s, bot) => {
    if (s.growthFrozen) return fail("GROWTH_FROZEN");
    const shape = { logicalId: args.logicalId, kind: args.kind, conversationId: args.kind === "self" ? null : args.conversationId,
      userId: args.kind === "member" ? args.userId : null, dimension: args.dimension, value: args.value };
    const id = idFor(shape);
    let entry = s.entries.find(e => e.id === id);
    if (entry && effectiveStatus(entry, args.now) === "rejected") return fail("TOMBSTONED");
    if (entry && effectiveStatus(entry, args.now) === "expired") return fail("EXPIRED");
    if (!entry && s.entries.length >= MAX_ENTRIES) return fail("BACKPRESSURE");
    const resolved = resolveEvidence(bot, args);
    if (!resolved.ok) return resolved;
    if (!entry) {
      entry = { id, ...shape, sourceType: sourceType(args.kind), evidence: [], firstSeenAt: 0, lastSeenAt: 0,
        createdAt: args.now, updatedAt: args.now, confidence: 0, coreConsistency: consistency(args.coreText, args.value),
        status: "candidate", expiresAt: 0, feedback: { negativeEvidenceIds: [], correctionEvidenceIds: [] },
        review: null, tombstone: null };
      s.entries.push(entry);
    }
    const before = JSON.stringify(entry);
    for (const ref of resolved.refs) {
      const prior = entry.evidence.find(r => r.messageId === ref.messageId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(ref)) return fail("EVIDENCE_CONFLICT");
      if (!prior) entry.evidence.push(ref);
    }
    if (entry.evidence.length > MAX_EVIDENCE) return fail("BACKPRESSURE");
    if (own(args, "coreText")) {
      // An administrator's explicit compatibility is not writable by inference.
      if (entry.coreConsistency.source === "admin") {
        if (entry.coreConsistency.hash !== hash(args.coreText)) return fail("CORE_CHANGED");
      } else entry.coreConsistency = consistency(args.coreText, entry.value);
    }
    entry.firstSeenAt = Math.min(...entry.evidence.map(ref => ref.sentAt));
    entry.lastSeenAt = Math.max(...entry.evidence.map(ref => ref.sentAt));
    entry.expiresAt = entry.lastSeenAt + ttl(entry.kind);
    for (const [key, type] of [["negativeEvidenceIds", "negative"], ["correctionEvidenceIds", "correction"]]) {
      entry.feedback[key] = entry.evidence.filter(ref => ref.polarity === type).map(ref => ref.messageId);
    }
    if (entry.feedback.negativeEvidenceIds.length || entry.feedback.correctionEvidenceIds.length) {
      entry.tombstone = { type: entry.feedback.correctionEvidenceIds.length ? "correction" : "negative",
        at: args.now, reason: "source feedback" };
    }
    entry.confidence = confidence(entry, args.now);
    entry.status = computedStatus(entry, args.now);
    if (JSON.stringify(entry) === before) return { ok: true, id, duplicate: true };
    entry.updatedAt = args.now;
    return { ok: true, id, status: entry.status };
  });
}

/** Detached view, including candidates/tombstones with effective TTL status.
 * Omitted scope returns ONLY self. Group/member always need current group;
 * member additionally needs exact current userId. Private scopes are rejected.
 * Host must supply the actual authorized current scope, never a model's choice.
 * self evidence may span groups; no human message text is ever returned/stored.
 */
export function getSocialPreferences(root, args = {}) {
  if (!keys(args, ["logicalId", "conversationId", "userId", "kind", "now", "limit"])
    || !required(args, ["logicalId", "now"]) || !logical(args.logicalId) || !stamp(args.now)
    || (own(args, "conversationId") && !group(args.conversationId))
    || (own(args, "userId") && (!qq(args.userId) || !group(args.conversationId)))
    || (own(args, "kind") && !KINDS.includes(args.kind))
    || (["group", "member"].includes(args.kind) && !group(args.conversationId))
    || (args.kind === "member" && !qq(args.userId))
    || (own(args, "limit") && (!integer(args.limit) || args.limit < 1 || args.limit > MAX_ENTRIES))) throw error("INVALID_ARGS");
  const s = locate(root, args.logicalId).state;
  if (s.entries.some(e => e.updatedAt > args.now)) throw error("INVALID_TIME");
  const entries = s.entries.filter(e => (!args.kind || args.kind === e.kind)
    && (e.kind === "self" || (e.conversationId === args.conversationId
      && (e.kind === "group" || e.userId === args.userId))))
    .slice(0, args.limit ?? MAX_ENTRIES).map(e => ({ ...copy(e), status: computedStatus(e, args.now),
      confidence: confidence(e, args.now) }));
  return { revision: s.revision, growthFrozen: s.growthFrozen, entries };
}

/** Host-only administrative decision. Self approval MUST explicitly assert
 * compatibility:'compatible'; it resolves unknown compatibility, not evidence
 * maturity, and never changes core. Every kind retains its diversity threshold.
 * No terminal revival.
 * Optional trusted coreText binds self approval to the host's current core hash;
 * omitted legacy calls retain the prior hash (possibly null). Runtime projection
 * MUST require a non-null hash equal to the current effective core hash, even
 * for source:'admin'. A stored compatible flag is not current-core authority.
 * reason is a short, non-sensitive audit label, not free-form model instructions.
 */
export function reviewSocialPreference(root, args = {}) {
  if (!keys(args, ["logicalId", "id", "expectedRevision", "action", "reason", "now", "actor", "compatibility", "coreText"])
    || !common(args) || !required(args, ["id", "action", "reason", "actor"])
    || typeof args.id !== "string" || !/^preference:[a-f0-9]{64}$/.test(args.id)
    || !["approve", "reject", "expire"].includes(args.action) || !reasonOK(args.reason)
    || !actorOK(args.actor) || (own(args, "compatibility") && args.compatibility !== "compatible")
    || (own(args, "coreText") && (args.action !== "approve" || typeof args.coreText !== "string"
      || !args.coreText.trim() || args.coreText.length > 32_768))) return fail("INVALID_ARGS");
  return write(root, args, s => {
    const e = s.entries.find(entry => entry.id === args.id);
    if (!e) return fail("NOT_FOUND");
    if (terminal(e)) return fail("TOMBSTONED");
    if (args.action === "approve" && effectiveStatus(e, args.now) === "expired") return fail("EXPIRED");
    if (args.action === "approve" && e.kind === "self") {
      if (args.compatibility !== "compatible") return fail("COMPATIBILITY_REQUIRED");
      e.coreConsistency = { hash: own(args, "coreText") ? hash(args.coreText) : e.coreConsistency.hash,
        compatible: true, source: "admin" };
    } else if (own(args, "compatibility") || own(args, "coreText")) return fail("INVALID_ARGS");
    if (args.action === "approve" && !qualifies(e, args.now)) return fail("INSUFFICIENT_EVIDENCE");
    // Reject/expire can correct an approved self; compatibility is no longer an
    // active admin assertion once its approval is superseded by a tombstone.
    if (args.action !== "approve" && e.coreConsistency.source === "admin") {
      e.coreConsistency = { ...e.coreConsistency, compatible: null, source: "unknown" };
    }
    e.review = { action: args.action, reason: args.reason, at: args.now,
      compatibility: e.kind === "self" && args.action === "approve" ? "compatible" : null };
    if (args.action !== "approve") e.tombstone = { type: args.action === "reject" ? "correction" : "expired",
      at: args.now, reason: args.reason };
    e.updatedAt = args.now;
    e.confidence = confidence(e, args.now);
    e.status = computedStatus(e, args.now);
    return { ok: true, id: e.id, status: e.status };
  });
}

/** Freezes automatic growth only. Host review/reject/expire remains available.
 * Fixed v1 storage has no freeze-history field; reason is validated and returned
 * for the caller's transaction audit, not persisted as another authority source.
 */
export function setSocialGrowthFrozen(root, args = {}) {
  if (!exact(args, ["logicalId", "expectedRevision", "frozen", "actor", "reason", "now"])
    || !common(args) || typeof args.frozen !== "boolean" || !actorOK(args.actor) || !reasonOK(args.reason)) return fail("INVALID_ARGS");
  return write(root, args, s => {
    if (s.growthFrozen === args.frozen) return { ok: true, duplicate: true };
    s.growthFrozen = args.frozen;
    return { ok: true, growthFrozen: s.growthFrozen, reason: args.reason };
  });
}
