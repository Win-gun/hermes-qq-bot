import { createHash } from "node:crypto";
import { listDiscoveryItems, validateDiscoveryPolicy } from "./social-discovery-state.js";

/** Pure, synchronous latest-draft builders. This is NOT runtime.intent_claimed,
 * a send ledger, scheduler, consent, permission, or an instruction channel.
 * The repository host owns authorization and durable publication. Never call
 * writers on the published MemoryRuntime.value. No IO, clock, tools or timers.
 *
 * expectedRevision is the BOT JOURNAL revision (including other groups), not
 * entry.revision. Success: {ok,id,revision,entry,duplicate}; rejection:
 * {ok:false,reason}, without ANY writes. CAS applies even to duplicate proposals.
 * Missing journal reads as {revision:0,entries:[]} without creating state.
 * get is a detached inventory, INCLUDING terminal records; overdue live records
 * are projected as expired without changing storage/revisions. select returns
 * only related, unexpired CANDIDATES (<=3); pending is never selected/replayed.
 *
 * related_message requires canonical human message IDs. public_discovery is
 * material-backed and only valid for public_share/discovery. Every supplied
 * reference must resolve in this bot/group. Materials use the stored discovery
 * policy, never model URLs or caller-supplied policy/authorization. Reads of
 * candidates recheck material availability. A known group is not a send grant.
 *
 * expressed requires pending + a same-conversation confirmed bot_reply ID,
 * recorded after pending, not already bound in this journal. The trusted host
 * must choose that ID ONLY after confirming this meaning was actually expressed;
 * the module validates the receipt, not semantic entailment. No bare ACK,
 * uncertain receipt, tool result, or model assertion can manufacture a receipt.
 *
 * No pruning: 128 time-valid live records / 256 total, then backpressure.
 * Terminal dedup fences are permanent. Abandonment also blocks ANY reuse of an
 * abandoned source ref in this group (including changed text/kind/source sets).
 */
const DAY = 86_400_000, MAX_TOTAL = 256, MAX_LIVE = 128;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const KINDS = ["opinion", "question", "followup", "public_share", "discovery"];
const TERMINAL = ["expressed", "abandoned", "expired"];
const own = (x, k) => Object.hasOwn(x, k);
const fail = reason => ({ ok: false, reason });
const copy = x => structuredClone(x);
const hash = x => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = x => integer(x) && x > 0 && x <= Number.MAX_SAFE_INTEGER - DAY;
const token = x => typeof x === "string" && /^[A-Za-z0-9_.:\-]{1,160}$/.test(x)
  && !x.split(/[.:\-]/).some(part => FORBIDDEN.has(part));
const logical = x => token(x) && /^(account|group):[A-Za-z0-9_.:\-]{1,100}$/.test(x);
const group = x => typeof x === "string" && /^group:[1-9][0-9]{0,19}$/.test(x);
const qq = x => typeof x === "string" && /^[1-9][0-9]{0,19}$/.test(x);
const live = e => !TERMINAL.includes(e.status);
const normalized = x => x.normalize("NFKC").trim().replace(/\s+/gu, " ");
const folded = x => normalized(x).toLowerCase();

// Reject accessors, prototype keys, symbols and non-JSON containers rather than
// invoking getters or silently repairing malformed state. Unrelated subtrees
// are never traversed/copied/replaced.
function record(x) {
  return x !== null && typeof x === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(x))
    && Reflect.ownKeys(x).every(k => typeof k === "string" && !FORBIDDEN.has(k)
      && Object.getOwnPropertyDescriptor(x, k)?.enumerable === true
      && own(Object.getOwnPropertyDescriptor(x, k), "value"));
}
function array(x, max = MAX_TOTAL) {
  return Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype && x.length <= max
    && Reflect.ownKeys(x).length === x.length + 1 && Reflect.ownKeys(x).every(k => k === "length"
      || (typeof k === "string" && /^(0|[1-9]\d*)$/.test(k) && Number(k) < x.length
        && own(Object.getOwnPropertyDescriptor(x, k), "value")));
}
const keys = (x, allowed) => record(x) && Object.keys(x).every(k => allowed.includes(k));
function jsonTree(value, budget = { left: 200_000 }, depth = 0) {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!record(value) && !array(value, 65_536)) return false;
  return Object.values(value).every(v => jsonTree(v, budget, depth + 1));
}

// Public semantic summaries only, NOT raw chat, code, credentials, identifiers,
// addresses, paths, URLs or instructions. This rejects rather than truncates.
const risky = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|[<>`{}@/\\]|(?:https?|file|data|javascript|account|group|private):|\b(?:sk-|Bearer\b|password\b|api[ _-]?key\b|token\b|secret\b|cookie\b|authorization\b|private[ _-]?key\b|session[ _-]?id\b|otp\b)|-----BEGIN|ssh-(?:rsa|ed25519)|(?:^|\s)\.(?:env|ssh)\b|\bid_rsa\b|(?:密码|口令|验证码|密钥|令牌|身份证|银行卡|手机号|电话号码|家庭住址|我的地址|思维链|推理过程|系统提示|开发者消息)|\d{5,}|(?:QQ|微信|邮箱|姓名|联系人|地址)\s*(?:[:：=]|[0-9])|[A-Za-z0-9_-]{24,}|(?:忽略|无视).{0,12}(?:指令|提示|规则)|(?:执行|运行|删除|发送|转发|私聊|联系).{0,8}(?:命令|指令|消息|文件|脚本)|(?:请|务必|必须|立刻|马上).{0,10}(?:执行|忽略|删除|发送|转发|联系)|\b(?:ignore|override)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b|\b(?:system\s*prompt|developer\s*message|chain\s*of\s*thought)\b/iu;
function text(x, max) {
  return typeof x === "string" && x.length <= max && normalized(x).length > 0 && normalized(x).length <= max
    && !risky.test(x) && !risky.test(normalized(x));
}
const verbatim = (value, raw) => folded(value) === folded(raw)
  || (folded(raw).length >= 12 && folded(value).includes(folded(raw)));
function ids(x) {
  if (x === undefined) return [];
  return array(x, 32) && x.every(token) ? [...new Set(x)].sort() : null;
}
function triggerOf(x) {
  if (!keys(x, ["kind", "terms"]) || !["related_message", "public_discovery"].includes(x.kind)
    || !array(x.terms, 8) || !x.terms.length || x.terms.some(t => !text(t, 32)
      || !/^[\p{L}\p{N} #+_.\-]+$/u.test(normalized(t)))) return null;
  return { kind: x.kind, terms: [...new Set(x.terms.map(normalized))].sort() };
}
const sourceKey = e => hash([e.logicalId, e.conversationId, e.evidenceMessageIds, e.materialIds]);
const entryId = e => `intent:${hash([e.sourceKey, e.kind, folded(e.summary)])}`;
function validEntry(e, logicalId, now) {
  if (!keys(e, ["id", "logicalId", "conversationId", "sourceKey", "kind", "summary", "reason", "trigger",
    "evidenceMessageIds", "materialIds", "evidenceRefs", "materialRefs", "createdAt", "expiresAt", "updatedAt",
    "status", "revision", "settlementReason", "terminalReason", "receiptMessageId"])
    || e.logicalId !== logicalId || !group(e.conversationId) || !KINDS.includes(e.kind)
    || !text(e.summary, 300) || !text(e.reason, 160) || !triggerOf(e.trigger)
    || !stamp(e.createdAt) || !stamp(e.expiresAt) || !stamp(e.updatedAt)
    || e.expiresAt <= e.createdAt || e.expiresAt - e.createdAt > DAY
    || e.updatedAt < e.createdAt || e.updatedAt > now || e.createdAt > now
    || !["candidate", "pending", ...TERMINAL].includes(e.status)) return false;
  const messages = ids(e.evidenceMessageIds), materials = ids(e.materialIds);
  if (!messages || !materials || JSON.stringify(messages) !== JSON.stringify(e.evidenceMessageIds)
    || JSON.stringify(materials) !== JSON.stringify(e.materialIds)
    || !validSourcesForKind(e.kind, e.trigger.kind, messages, materials)
    || !array(e.evidenceRefs, 32) || e.evidenceRefs.length !== messages.length
    || !array(e.materialRefs, 32) || e.materialRefs.length !== materials.length) return false;
  if (e.evidenceRefs.some((r, i) => !keys(r, ["messageId", "userId", "sentAt", "receivedAt"])
    || r.messageId !== messages[i] || !qq(r.userId) || !stamp(r.sentAt) || !stamp(r.receivedAt)
    || r.sentAt > r.receivedAt || r.receivedAt > e.createdAt)
    || e.materialRefs.some((r, i) => !keys(r, ["id", "eventKey", "collectedAt", "expiresAt"])
      || r.id !== materials[i] || !token(r.eventKey) || !stamp(r.collectedAt) || !stamp(r.expiresAt)
      || r.collectedAt > e.createdAt || r.expiresAt < e.expiresAt)
    || e.sourceKey !== sourceKey(e) || e.id !== entryId(e)) return false;
  if ([e.summary, e.reason, ...e.trigger.terms, ...(e.settlementReason === null ? [] : [e.settlementReason])]
    .some(t => typeof t !== "string" || e.evidenceRefs.some(r => t.includes(r.userId)))) return false;
  if (e.status === "candidate") return e.revision === 1 && e.updatedAt === e.createdAt
    && e.settlementReason === null && e.terminalReason === null && e.receiptMessageId === null;
  if (!text(e.settlementReason, 160)) return false;
  if (e.status === "pending") return e.revision === 2 && e.updatedAt < e.expiresAt
    && e.terminalReason === null && e.receiptMessageId === null;
  return [2, 3].includes(e.revision) && e.terminalReason === e.settlementReason
    && (e.status === "expired" ? e.updatedAt >= e.expiresAt : e.updatedAt < e.expiresAt)
    && (e.status === "expressed" ? e.revision === 3 && token(e.receiptMessageId) : e.receiptMessageId === null);
}
function validSourcesForKind(kind, trigger, messages, materials) {
  return (trigger === "related_message" ? messages.length > 0
    : ["public_share", "discovery"].includes(kind) && materials.length > 0)
    && (!["public_share", "discovery"].includes(kind) || materials.length > 0);
}
function stateAt(root, args) {
  if (!record(args) || !logical(args.logicalId) || !group(args.conversationId) || !stamp(args.now)) return fail("invalid_args");
  if (!record(root)) return fail("invalid_state");
  if (!own(root, "socialAgents")) return { ok: true, bot: null, conversation: null, journal: { version: 1, revision: 0, entries: [] } };
  const agents = root.socialAgents;
  if (!record(agents) || agents.version !== 1 || !record(agents.bots)) return fail("invalid_state");
  if (!own(agents.bots, args.logicalId)) return { ok: true, bot: null, conversation: null, journal: { version: 1, revision: 0, entries: [] } };
  const bot = agents.bots[args.logicalId];
  if (!record(bot) || !record(bot.conversations)) return fail("invalid_state");
  const conversation = own(bot.conversations, args.conversationId) ? bot.conversations[args.conversationId] : null;
  if (conversation && (!record(conversation) || !array(conversation.messages) || !array(conversation.experiences, 64)
    || !integer(conversation.nextSeq) || conversation.nextSeq < 1 || !integer(conversation.readThroughSeq)
    || conversation.readThroughSeq >= conversation.nextSeq
    || !jsonTree(conversation.messages) || !jsonTree(conversation.experiences)
    || conversation.messages.some(m => !record(m) || !token(m.messageId) || !qq(m.userId)
      || typeof m.text !== "string" || typeof m.isBot !== "boolean" || typeof m.isQuoted !== "boolean"
      || !stamp(m.sentAt) || !stamp(m.receivedAt)))) return fail("invalid_state");
  if (own(bot.conversations, args.conversationId) && !conversation) return fail("invalid_state");
  const j = own(bot, "socialIntentJournal") ? bot.socialIntentJournal : { version: 1, revision: 0, entries: [] };
  if (!keys(j, ["version", "revision", "entries"]) || j.version !== 1 || !integer(j.revision)
    || !array(j.entries) || j.entries.some(e => !validEntry(e, args.logicalId, args.now))
    || new Set(j.entries.map(e => e.id)).size !== j.entries.length
    || j.entries.reduce((sum, e) => sum + e.revision, 0) !== j.revision
    || j.entries.filter(e => live(e) && e.expiresAt > args.now).length > MAX_LIVE
    || new Set(j.entries.filter(e => e.receiptMessageId !== null).map(e => `${e.conversationId}:${e.receiptMessageId}`)).size
      !== j.entries.filter(e => e.receiptMessageId !== null).length) return fail("invalid_state");
  return { ok: true, bot, conversation, journal: j };
}
function writable(found, args) {
  if (!integer(args.expectedRevision)) return fail("invalid_args");
  if (found.journal.revision !== args.expectedRevision) return fail("stale_revision");
  if (!found.bot || !found.conversation) return fail("invalid_scope");
  if (found.journal.revision === Number.MAX_SAFE_INTEGER) return fail("backpressure");
  const d = Object.getOwnPropertyDescriptor(found.bot, "socialIntentJournal");
  if (d ? !d.writable : !Object.isExtensible(found.bot)) return fail("invalid_state");
  return { ok: true };
}
function evidenceAt(conversation, messageIds, args) {
  const refs = [], raw = [];
  for (const id of messageIds) {
    const matches = conversation.messages.filter(m => record(m) && m.messageId === id);
    if (matches.length !== 1) return null;
    const m = matches[0];
    if (m.isBot !== false || m.isQuoted !== false || !qq(m.userId) || typeof m.text !== "string" || !m.text.trim()
      || !stamp(m.sentAt) || !stamp(m.receivedAt) || m.sentAt > m.receivedAt || m.receivedAt > args.now
      || (own(m, "conversationId") && m.conversationId !== args.conversationId)
      || (own(m, "logicalId") && m.logicalId !== args.logicalId)) return null;
    refs.push({ messageId: id, userId: m.userId, sentAt: m.sentAt, receivedAt: m.receivedAt });
    raw.push(m.text);
  }
  return { refs, raw };
}
function materialsAt(root, bot, materialIds, args) {
  if (!materialIds.length) return [];
  if (!record(bot.discovery) || !jsonTree(bot.discovery) || !record(bot.discovery.policy)) return null;
  const validated = validateDiscoveryPolicy(bot.discovery.policy);
  if (!validated.ok) return null;
  const p = validated.policy;
  // list validates the existing discovery schema and group blocks. It is an
  // inventory, so additionally enforce blockedTopics here (no search/network).
  const items = listDiscoveryItems(root, { logicalId: args.logicalId, conversationId: args.conversationId,
    now: args.now, includeInactive: false });
  const compact = x => folded(x).replace(/[\p{P}\p{Z}\s]/gu, "");
  const refs = [];
  for (const id of materialIds) {
    const matches = items.filter(i => i.id === id);
    if (matches.length !== 1) return null;
    const i = matches[0], hay = compact([i.title, i.meaning, i.applicable, i.avoid].join(" "));
    if (i.status !== "active" || i.expiresAt <= args.now || i.collectedAt > args.now
      || p.blockedTopics.some(t => hay.includes(compact(t)))) return null;
    refs.push({ id, eventKey: i.eventKey, collectedAt: i.collectedAt, expiresAt: i.expiresAt });
  }
  return refs;
}
function projection(e, now) {
  const result = copy(e);
  if (live(e) && e.expiresAt <= now) Object.assign(result, { status: "expired", terminalReason: "ttl_expired" });
  return result;
}
function sourceAbandoned(entries, entry) {
  return entries.some(e => e.conversationId === entry.conversationId && e.status === "abandoned"
    && (e.sourceKey === entry.sourceKey || e.evidenceMessageIds.some(id => entry.evidenceMessageIds.includes(id))
      || e.materialIds.some(id => entry.materialIds.includes(id))));
}
function publish(found, entries, entry) {
  const revision = found.journal.revision + 1;
  const result = { ok: true, id: entry.id, revision, entry: copy(entry), duplicate: false };
  // Single replacement, only after validation and detached output construction.
  const next = { version: 1, revision, entries };
  if (own(found.bot, "socialIntentJournal")) found.bot.socialIntentJournal = next;
  else Object.defineProperty(found.bot, "socialIntentJournal", { value: next, writable: true, enumerable: true, configurable: true });
  return result;
}

export function proposeSocialIntent(root, args = {}) {
  if (!keys(args, ["logicalId", "conversationId", "expectedRevision", "kind", "summary", "reason", "trigger",
    "evidenceMessageIds", "materialIds", "now", "ttlMs"])) return fail("invalid_args");
  const found = stateAt(root, args);
  if (!found.ok) return found;
  const gate = writable(found, args);
  if (!gate.ok) return gate;
  const messages = ids(args.evidenceMessageIds), materials = ids(args.materialIds), trigger = triggerOf(args.trigger);
  if (!KINDS.includes(args.kind) || !text(args.summary, 300) || !text(args.reason, 160) || !trigger
    || !integer(args.ttlMs) || args.ttlMs < 1 || args.ttlMs > DAY || !messages || !materials
    || !validSourcesForKind(args.kind, trigger.kind, messages, materials)) return fail("invalid_proposal");
  const entry = { logicalId: args.logicalId, conversationId: args.conversationId, kind: args.kind,
    summary: normalized(args.summary), reason: normalized(args.reason), trigger,
    evidenceMessageIds: messages, materialIds: materials };
  entry.sourceKey = sourceKey(entry);
  entry.id = entryId(entry);
  const scoped = found.journal.entries.filter(e => e.conversationId === args.conversationId);
  if (sourceAbandoned(scoped, entry)) return fail("source_abandoned");
  const original = scoped.find(e => e.id === entry.id);
  // Keep terminal/idempotency fences even when original evidence has rotated
  // out of the bounded input buffer or material store. Never refresh TTL/reason.
  if (original) return { ok: true, id: original.id, revision: found.journal.revision,
    entry: projection(original, args.now), duplicate: true };
  const evidence = evidenceAt(found.conversation, messages, args);
  if (!evidence) return fail("invalid_evidence");
  const refs = materialsAt(root, found.bot, materials, args);
  if (!refs) return fail("invalid_material");
  const publicTexts = [entry.summary, entry.reason, ...trigger.terms];
  if (publicTexts.some(t => evidence.raw.some(raw => verbatim(t, raw))
    || evidence.refs.some(r => t.includes(r.userId)))) return fail("unsafe_summary");
  if (found.journal.entries.length >= MAX_TOTAL
    || found.journal.entries.filter(e => live(e) && e.expiresAt > args.now).length >= MAX_LIVE) return fail("backpressure");
  Object.assign(entry, { evidenceRefs: evidence.refs, materialRefs: refs, createdAt: args.now,
    expiresAt: Math.min(args.now + args.ttlMs, ...refs.map(r => r.expiresAt)), updatedAt: args.now,
    status: "candidate", revision: 1, settlementReason: null, terminalReason: null, receiptMessageId: null });
  return publish(found, [...found.journal.entries, entry], entry);
}

/** Detached inventory; malformed scope/state fails closed, without defaults writes. */
export function getSocialIntentJournal(root, args = {}) {
  const found = stateAt(root, args);
  if (!found.ok) return { ...found, revision: 0, entries: [] };
  if (args.limit !== undefined && (!integer(args.limit) || args.limit < 1)) return { ...fail("invalid_args"), revision: found.journal.revision, entries: [] };
  return { revision: found.journal.revision, entries: found.journal.entries.filter(e => e.conversationId === args.conversationId)
    .slice(0, Math.min(args.limit ?? MAX_TOTAL, MAX_TOTAL)).map(e => projection(e, args.now)) };
}

export function settleSocialIntent(root, args = {}) {
  if (!keys(args, ["logicalId", "conversationId", "id", "expectedRevision", "status", "reason", "now", "receiptMessageId"])) return fail("invalid_args");
  const found = stateAt(root, args);
  if (!found.ok) return found;
  const gate = writable(found, args);
  if (!gate.ok) return gate;
  if (typeof args.id !== "string" || !/^intent:[a-f0-9]{64}$/.test(args.id)
    || !["pending", ...TERMINAL].includes(args.status) || !text(args.reason, 160)
    || (args.status === "expressed" ? !token(args.receiptMessageId) : args.receiptMessageId !== undefined)) return fail("invalid_args");
  const original = found.journal.entries.find(e => e.id === args.id && e.conversationId === args.conversationId);
  if (!original) return fail("not_found");
  if (original.evidenceRefs.some(r => normalized(args.reason).includes(r.userId))) return fail("unsafe_summary");
  const evidence = evidenceAt(found.conversation, original.evidenceMessageIds, args);
  if (evidence?.raw.some(raw => verbatim(args.reason, raw))) return fail("unsafe_summary");
  if (!live(original) || (args.status === "pending" && original.status !== "candidate")
    || (args.status === "expressed" && original.status !== "pending")) return fail("invalid_transition");
  if ((args.now >= original.expiresAt && args.status !== "expired")
    || (args.now < original.expiresAt && args.status === "expired")) return fail("invalid_expiry");
  if (["pending", "expressed"].includes(args.status) && sourceAbandoned(found.journal.entries, original)) return fail("source_abandoned");
  if (args.status === "expressed") {
    const matches = found.conversation.experiences.filter(e => record(e) && e.messageId === args.receiptMessageId);
    if (matches.length !== 1) return fail("unconfirmed_receipt");
    const receipt = matches[0];
    if (receipt.kind !== "bot_reply" || receipt.confirmed !== true || !qq(receipt.userId) || receipt.revokedAt
      || (receipt.status !== undefined && !["active", "confirmed"].includes(receipt.status)) || receipt.uncertain === true
      || typeof receipt.text !== "string" || !receipt.text.trim() || !stamp(receipt.sentAt) || !stamp(receipt.createdAt)
      || receipt.sentAt < original.updatedAt || receipt.sentAt > receipt.createdAt || receipt.createdAt > args.now
      || (own(receipt, "conversationId") && receipt.conversationId !== args.conversationId)
      || (own(receipt, "logicalId") && receipt.logicalId !== args.logicalId)
      || found.journal.entries.some(e => e.conversationId === args.conversationId && e.receiptMessageId === args.receiptMessageId)) return fail("unconfirmed_receipt");
  }
  const reason = normalized(args.reason);
  const entry = { ...copy(original), status: args.status, updatedAt: args.now, revision: original.revision + 1,
    settlementReason: reason, terminalReason: TERMINAL.includes(args.status) ? reason : null,
    receiptMessageId: args.receiptMessageId ?? null };
  return publish(found, found.journal.entries.map(e => e.id === entry.id ? entry : e), entry);
}

/** Lexical public-topic matching only. No clock, wakeup, claiming or execution. */
export function selectRelevantSocialIntents(root, args = {}) {
  const found = stateAt(root, args);
  if (!found.ok || !text(args.query, 1000) || (args.limit !== undefined && (!integer(args.limit) || args.limit < 1))) return [];
  const query = folded(args.query), limit = Math.min(args.limit ?? 3, 3);
  const matches = term => /^[a-z0-9 _+.#-]+$/i.test(term)
    ? query.includes(term) && (!/^[a-z0-9]+$/i.test(term)
      || query.split(/[^a-z0-9]+/i).includes(term)) : query.includes(term);
  return found.journal.entries.filter(e => e.conversationId === args.conversationId && e.status === "candidate"
    && e.expiresAt > args.now && e.trigger.terms.some(t => matches(folded(t)))
    && !sourceAbandoned(found.journal.entries, e)
    && materialsAt(root, found.bot, e.materialIds, args) !== null)
    .slice(0, limit).map(copy);
}
