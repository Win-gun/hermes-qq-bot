/**
 * Pure, opt-in-adapter helpers. No IO, model calls, wall clock or memory writes.
 * Callers MUST redact sensitive input before prompting and retain the RAW batch
 * for attribution. These projections never replace integrity/subject gates.
 *
 * memoryLearningConfig accepts a full config or the learning block itself.
 * Its defaults are enabled; rollout adapters must separately require explicit
 * config.memory.learning.enabled === true to preserve old installations.
 * All `now` values are injected Unix milliseconds or zoned ISO strings.
 * Waiting uses receivedAt/enqueuedAt (or their Ms forms), NEVER event sentAt.
 * Unknown queue timing flushes a bounded batch instead of inventing a time.
 * The parent config validator must enforce 4 <= minBatchMessages <=
 * maxBatchMessages <= 16. Max-wait flushing may still yield 1–3 messages.
 */

const DEFAULTS = Object.freeze({ enabled: true, maxWaitMs: 120000, minBatchMessages: 4,
  maxBatchMessages: 16, maxMessageChars: 4000, maxBatchChars: 12000, settleMs: 5000 });
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const integer = (value, fallback, min, max) => {
  const number = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(number) ? number : fallback)));
};

export function memoryLearningConfig(config = {}) {
  const root = object(config);
  const memory = object(root.memory);
  const source = object(memory.learning ?? root.learning ?? root);
  const minBatchMessages = integer(source.minBatchMessages ?? memory.aiExtraction?.everyMessages,
    DEFAULTS.minBatchMessages, 4, 16);
  const maxWaitMs = integer(source.maxWaitMs, DEFAULTS.maxWaitMs, 1, 86400000);
  const maxBatchChars = integer(source.maxBatchChars, DEFAULTS.maxBatchChars, 1, 1048576);
  return {
    enabled: source.enabled !== false,
    maxWaitMs, minBatchMessages,
    maxBatchMessages: integer(source.maxBatchMessages, DEFAULTS.maxBatchMessages, minBatchMessages, 16),
    maxMessageChars: Math.min(maxBatchChars, integer(source.maxMessageChars, DEFAULTS.maxMessageChars, 1, 65536)),
    maxBatchChars, settleMs: integer(source.settleMs, DEFAULTS.settleMs, 0, maxWaitMs)
  };
}

// Unzoned dates, relative words and blank strings are unknown, not "now".
function timeMs(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999 ? value : null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/\D/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function queueTimes(message) {
  const times = [message.receivedAt, message.receivedAtMs, message.enqueuedAt, message.enqueuedAtMs]
    .map(timeMs).filter(value => value !== null);
  return times.length ? { first: Math.min(...times), last: Math.max(...times) } : null;
}

const idOf = message => message.message_id ?? message.messageId ?? null;
const userOf = message => message.user_id ?? message.userId ?? message.subjectUserId ?? object(message.sender).user_id ?? null;
function originalTime(message) {
  const times = ["sent_at", "sentAt", "sentAtMs", "time"].filter(key => Object.hasOwn(message, key))
    .map(key => key === "time" ? typeof message.time === "number" ? timeMs(message.time * 1000) : null : timeMs(message[key]));
  return times.length && times.every(time => time !== null && time === times[0]) ? new Date(times[0]).toISOString() : null;
}
function bodyOf(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.raw_message === "string") return message.raw_message;
  if (typeof message.message === "string") return message.message;
  return list(message.message).filter(segment => segment?.type === "text")
    .map(segment => typeof segment.data?.text === "string" ? segment.data.text : "").join("");
}

const QUOTE_FIELDS = ["quote", "quoted", "quotedText", "quoted_text", "quotedMessage", "quoted_message",
  "quotedMessageId", "quoted_message_id", "isQuoted", "is_quoted", "reply", "replyTo", "reply_to",
  "replyToMessageId", "reply_to_message_id", "replyContext", "replyContexts", "reply_contexts",
  "forward", "forwarded", "isForward", "is_forward", "forwardedMessages", "forwarded_messages"];
const nonempty = value => value !== undefined && value !== null && value !== false && value !== "" && value !== 0
  && !(Array.isArray(value) && value.length === 0);
function quoteFlags(message) {
  return Object.fromEntries(QUOTE_FIELDS.filter(field => typeof message[field] === "boolean" || nonempty(message[field]))
    .map(field => [field, typeof message[field] === "boolean" ? message[field] : true]));
}
function quoted(message) {
  return Object.values(quoteFlags(message)).some(Boolean)
    || list(message.message).some(segment => ["reply", "forward", "node", "json", "xml"].includes(segment?.type))
    || /\[CQ:(?:reply|forward|node|json|xml)\b|["“”‘’「」『』`]|^\s*>/mu.test(bodyOf(message));
}

function batchCount(messages, config) {
  let count = 0;
  let chars = 0;
  for (const message of messages.slice(0, config.maxBatchMessages)) {
    const size = Math.min(bodyOf(object(message)).length, config.maxMessageChars);
    if (count && chars + size > config.maxBatchChars) break;
    chars += size;
    count++;
  }
  return { count, chars };
}

function completeTurn(message) {
  if (message.incomplete === true || message.isFragment === true || message.turnComplete === false) return false;
  if (message.turnComplete === true) return true;
  const text = bodyOf(message).trim();
  if (!text || /(?:[,，;；:：、…]|\.{2,}|但是|不过|而且|所以|因为|然后|如果|以及|还有|就是|觉得|感觉|这个东西|一方面|\b(?:and|but|because|if|so))$/iu.test(text)) return false;
  return /[。！？.!?][”」』）)]?$/u.test(text) || text.length >= 6;
}

/** Return an object, not a boolean: callers must check `.ready`. Claim ONLY the
 * first `.batchSize` raw messages; leave the remainder durably queued. Quiet or
 * reply-disabled flags deliberately do not participate in background learning.
 * Parent batchSize(id, admittedRawInputs) adapters must recompute from those
 * freshest admitted inputs, not a cached pre-admission prefix/compatibility queue.
 */
export function shouldExtractMemoryBatch(messages, { now, config } = {}) {
  const options = memoryLearningConfig(config);
  const input = list(messages);
  const { count, chars } = batchCount(input, options);
  const decision = (ready, reason) => ({ ready, reason, batchSize: count });
  if (!options.enabled) return decision(false, "disabled");
  if (!count) return decision(false, "empty");
  const clock = timeMs(now);
  if (clock === null) return decision(false, "invalid-now");
  if (input.length >= options.maxBatchMessages || count < input.length || chars >= options.maxBatchChars) return decision(true, "capacity");
  const times = input.map(message => queueTimes(object(message)));
  if (times.some(time => time === null)) return decision(true, "unknown-queue-time");
  if (clock - Math.min(...times.map(time => time.first)) >= options.maxWaitMs) return decision(true, "max-wait");
  if (count < options.minBatchMessages) return decision(false, "below-minimum");
  if (clock - Math.max(...times.map(time => time.last)) < options.settleMs) return decision(false, "settling");
  // Each participant's last turn must be complete, not just the last row.
  const lastTurns = new Map();
  input.forEach((message, index) => lastTurns.set(String(userOf(object(message)) ?? `unknown:${index}`), object(message)));
  if ([...lastTurns.values()].some(message => !completeTurn(message))) return decision(false, "incomplete-turn");
  return decision(true, "settled-turns");
}

function safeEnd(text, end) {
  return end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end] || "") ? end - 1 : end;
}

// Head + middle + tail excerpts retain context and late negations. Every gap is
// explicit. If even the tail is too long it remains a truncated, ineligible
// source; no partial excerpt is claimed as a complete independent assertion.
function rangesFor(text, cap) {
  if (text.length <= cap) return [[0, text.length]];
  const tailSize = Math.ceil(cap / 2);
  const headSize = Math.ceil((cap - tailSize) / 2);
  const middleSize = cap - tailSize - headSize;
  const ranges = [[0, headSize], [Math.floor((text.length - middleSize) / 2), Math.floor((text.length - middleSize) / 2) + middleSize],
    [text.length - tailSize, text.length]];
  return ranges.map(([start, end]) => [start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) ? start + 1 : start, safeEnd(text, end)])
    .filter(([start, end]) => start < end);
}

function excerptFor(text, cap) {
  // Include omission markers INSIDE the hard text cap, not in addition to it.
  if (text.length <= cap) return { ranges: [[0, text.length]], marker: "" };
  if (cap < 16) return { ranges: rangesFor(text, Math.max(0, cap - 1)).slice(-1), marker: "…" };
  return { ranges: rangesFor(text, cap - 12), marker: "[原文省略]" };
}

function semanticSegments(text, ranges, sourceMessageId) {
  const result = [];
  for (const [start, end] of ranges) {
    let cursor = start;
    while (cursor < end) {
      let next = safeEnd(text, Math.min(cursor + 512, end));
      if (next < end) {
        const candidate = text.slice(cursor, next);
        const boundary = Math.max(...[...candidate.matchAll(/[。！？!?；;\n]/gu)].map(match => match.index + 1), 0);
        if (boundary > 128) next = cursor + boundary;
      }
      result.push({ sourceMessageId, start: cursor, end: next, text: text.slice(cursor, next),
        partial: cursor > 0 && !/[。！？!?；;\n]/u.test(text[cursor - 1]) || next < text.length && !/[。！？!?；;\n]/u.test(text[next - 1]) });
      cursor = next;
    }
  }
  return result;
}

const ACTOR_FLAGS = ["isBot", "is_bot", "isTool", "is_tool", "isSelf", "is_self"];
const SENDER_FIELDS = ["user_id", "role", ...ACTOR_FLAGS];
const PROVENANCE_FIELDS = ["message_id", "messageId", "user_id", "userId", "subjectUserId", "conversation_id", "conversationId",
  "sent_at", "sentAt", "sentAtMs", "time", "at", "receivedAt", "receivedAtMs", "enqueuedAt", "enqueuedAtMs",
  "role", "source", "type", "sourceType", "source_type", "message_type", "post_type", "self_id",
  ...ACTOR_FLAGS];

/**
 * -> {messages, totalChars, sourceCount, deferredMessageCount, nextIndex}.
 * Character budgets bound rendered text INCLUDING gap markers, not JSON. Each row has
 * bounded segments + explicit source offsets/omittedRanges. `.text` includes gap
 * markers; the final tail survives. No invented IDs. Truncated rows have
 * evidenceEligible:false; do NOT pass projections to the attribution layer.
 */
export function prepareLearningMessages(messages, { config } = {}) {
  const input = list(messages);
  const options = memoryLearningConfig(config);
  const { count } = batchCount(input, options);
  let totalChars = 0;
  const prepared = input.slice(0, count).map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Expected a message object");
    const text = bodyOf(raw);
    const { ranges, marker } = excerptFor(text, options.maxMessageChars);
    const sourceMessageId = idOf(raw);
    const segments = semanticSegments(text, ranges, sourceMessageId);
    const omittedRanges = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) omittedRanges.push({ start: cursor, end: start });
      cursor = end;
    }
    if (cursor < text.length) omittedRanges.push({ start: cursor, end: text.length });
    const retainedChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
    totalChars += retainedChars;
    const flags = quoteFlags(raw);
    const isQuoted = quoted(raw);
    const sourceIssues = [];
    if (!text.trim()) sourceIssues.push("empty-text");
    if (list(raw.message).some(segment => !["text", "at"].includes(segment?.type))) sourceIssues.push("non-text-segments");
    if (raw.text !== undefined && typeof raw.text !== "string") sourceIssues.push("invalid-text");
    const provenance = Object.fromEntries(PROVENANCE_FIELDS.filter(field => Object.hasOwn(raw, field))
      .map(field => [field, raw[field]]));
    if (Object.hasOwn(raw, "sender")) provenance.sender = typeof raw.sender === "string" ? raw.sender
      : Object.fromEntries(SENDER_FIELDS.filter(field => Object.hasOwn(object(raw.sender), field)).map(field => [field, raw.sender[field]]));
    const nonHumanActor = [raw, object(raw.sender)].some(actor =>
      (Object.hasOwn(actor, "role") && !["user", "human", "member", "owner", "admin", "normal"].includes(actor.role))
      || ACTOR_FLAGS.some(field => Object.hasOwn(actor, field) && actor[field] !== false));
    // Keep quote booleans (never their possibly unbounded embedded bodies).
    return { ...provenance, ...flags, sourceMessageId, sourceIndex: index, user_id: userOf(raw),
      text: ranges.length ? ranges.map(([start, end], part) => `${part || start ? marker : ""}${text.slice(start, end)}`).join("") : marker,
      segments, quoteFlags: flags, isQuoted, sourceIssues,
      truncated: omittedRanges.length > 0, sourceTextLength: text.length, retainedChars, omittedRanges,
      evidenceEligible: nonempty(sourceMessageId) && nonempty(userOf(raw)) && originalTime(raw) !== null && !isQuoted && !omittedRanges.length && !sourceIssues.length
        && !nonHumanActor
        && !["bot", "assistant", "tool", "system", "function"].includes(raw.source),
      evidenceUnit: "original-message" };
  });
  return { messages: prepared, totalChars, renderedChars: prepared.reduce((sum, row) => sum + row.text.length, 0),
    sourceCount: input.length, deferredMessageCount: input.length - count, nextIndex: count };
}

function metadata(entry, key) {
  return entry[key] ?? object(entry.temporal)[key] ?? object(entry.metadata)[key];
}

// Verification coexistence decisions annotate entries with
// verificationConditions:[{caseId,condition,provenance}]. These are conditional
// context, never self evidence or proof that a condition currently holds.
function conditionsOf(entry) {
  const direct = metadata(entry, "condition");
  const verification = metadata(entry, "verificationConditions");
  const values = [...(nonempty(direct) ? [direct] : []),
    ...(Array.isArray(verification) ? verification.map(item => typeof item === "string" ? item : object(item).condition)
      : nonempty(verification) ? [undefined] : [])];
  const texts = [...new Set(values.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
  return { present: values.length > 0, texts,
    unparsed: values.some(value => typeof value !== "string" || !value.trim()) };
}
function classOf(entry) {
  const value = metadata(entry, "memoryClass");
  if (["stable", "preference", "state", "plan", "event", "meme"].includes(value)) return value;
  return { preference: "preference", meme: "meme", core_meme: "meme", alias: "stable", personality: "stable", boundary: "preference" }[entry.kind] || "unknown";
}
const normalize = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
function terms(text) {
  const result = new Set();
  for (const match of normalize(text).matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu)) {
    const token = match[0];
    if (/\p{Script=Han}/u.test(token)) {
      if (token.length === 1) result.add(token);
      for (const width of [2, 3]) for (let index = 0; index <= token.length - width; index++) result.add(token.slice(index, index + width));
    } else result.add(token);
  }
  return result;
}
function overlap(queryTerms, value) {
  if (!queryTerms.size) return 0;
  const candidates = terms(value);
  let score = 0;
  for (const term of queryTerms) if (candidates.has(term)) score += term.length >= 3 ? 2 : 1;
  return score;
}

/** Unknown chronology remains unknown. No implicit TTL or relative-date parsing.
 * A usable entry is NOT necessarily a current assertion: render `.label` (or the
 * selector's `.displayValue`) for historical/conditional/unknown-time entries.
 */
export function memoryValidity(entry, { now, currentText = "" } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {
    usable: false, expired: false, reason: "invalid-entry", memoryClass: "unknown", label: "无效记录",
    chronologyKnown: false, conditional: false, conditionMatched: false
  };
  const item = object(entry);
  const memoryClass = classOf(item);
  const fromRaw = metadata(item, "validFrom");
  const untilRaw = metadata(item, "validUntil");
  const from = timeMs(fromRaw);
  const until = timeMs(untilRaw);
  const clock = timeMs(now);
  const evidenceTime = timeMs(item.lastConfirmedAt) ?? timeMs(item.firstSeenAt) ?? timeMs(item.sentAt);
  const conditions = conditionsOf(item);
  const hasCondition = conditions.present;
  const conditionText = [...conditions.texts, ...(conditions.unparsed ? ["未解析条件"] : [])].join("；");
  const conditionalLabel = `条件记录（条件未核验：${conditionText}）`;
  const result = (usable, expired, reason, label) => ({ usable, expired, reason, memoryClass, label,
    ...(hasCondition ? { label: label ? `${label}；${conditionalLabel}` : conditionalLabel } : {}),
    chronologyKnown: evidenceTime !== null || from !== null || until !== null,
    conditional: hasCondition, conditionMatched: !conditions.unparsed && conditions.texts.length > 0
      && conditions.texts.every(condition => normalize(currentText).includes(normalize(condition))) });
  if ((nonempty(fromRaw) && from === null) || (nonempty(untilRaw) && until === null) || (from !== null && until !== null && from >= until)) {
    return result(false, false, "invalid-validity", "有效时间无效");
  }
  if ((from !== null || until !== null) && clock === null) return result(false, false, "unknown-now", "无法判断有效期");
  if (from !== null && clock < from) return result(false, false, "not-yet-valid", "尚未生效");
  if (until !== null && clock >= until) return memoryClass === "event"
    ? result(true, true, "historical-event", "历史事件，不代表当前")
    : result(false, true, "expired", "已过期，不代表当前");
  if (hasCondition) return result(true, false, "conditional", "");
  if (memoryClass === "event") return result(true, false, "historical-event", "事件记录，不代表当前");
  if (evidenceTime === null && from === null && until === null) return result(true, false, "unknown-time", "时间未知，不代表当前");
  if (memoryClass === "state" || memoryClass === "plan") return result(true, false, "as-reported", "当时的状态/计划，未确认仍有效");
  return result(true, false, "valid", "");
}

function searchable(entry) {
  return [entry.value, entry.topic, ...list(entry.topics), ...list(entry.aliases), ...conditionsOf(entry).texts]
    .filter(value => typeof value === "string").join(" ");
}

/** Read-only prompt projection AFTER canonical integrity/conflict gates. This
 * additionally rejects explicit non-active/malformed-confidence/foreign entries, but
 * is not an evidence validator. No recency sorting: equal scores keep input order.
 * No hidden confidence threshold: the parent's integrity gate is authoritative.
 * Optional minConfidence repeats the exact caller threshold; omit after gating.
 * Render displayValue; value/id/provenance stay unchanged for correction lookup.
 */
export function selectRelevantMemoryEntries(entries, { now, text = "", maxItems = 8, subjectUserId, minConfidence } = {}) {
  if (minConfidence !== undefined && (typeof minConfidence !== "number" || !Number.isFinite(minConfidence)
    || minConfidence < 0 || minConfidence > 1)) throw new TypeError("minConfidence must be a finite number in [0,1]");
  const query = terms(text);
  const subject = subjectUserId === undefined || subjectUserId === null ? null : String(subjectUserId);
  return list(entries).map((entry, index) => {
    if (!entry || typeof entry.value !== "string" || !entry.value.trim()) return null;
    if (subject !== null && String(entry.subjectUserId ?? "") !== subject) return null;
    if (entry.status !== undefined && entry.status !== "active") return null;
    if (entry.confidence !== undefined && (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) return null;
    if (minConfidence !== undefined && (entry.confidence === undefined || entry.confidence < minConfidence)) return null;
    const validity = memoryValidity(entry, { now, currentText: text });
    if (!validity.usable) return null;
    const relevanceScore = overlap(query, searchable(entry)) * 10 + (validity.conditionMatched ? 3 : 0)
      + (validity.reason === "valid" ? 1 : 0);
    return { index, score: relevanceScore, entry: { ...entry, validity, relevanceScore,
      displayValue: validity.label ? `[${validity.label}] ${entry.value}` : entry.value } };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, integer(maxItems, 8, 0, 256)).map(row => row.entry);
}

/** Compatibility strings must have already passed legacyMemoryValues /
 * groupMemoryValues. Select, never delete/rewrite/deduplicate stored values.
 */
export function selectRelevantMemoryValues(values, { text = "", maxItems = 8 } = {}) {
  const query = terms(text);
  return list(values).map((value, index) => ({ value, index, score: typeof value === "string" ? overlap(query, value) : 0 }))
    .filter(row => typeof row.value === "string" && row.value.trim())
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, integer(maxItems, 8, 0, 256)).map(row => row.value);
}

/** Deterministic excerpts, NOT semantic entailment or a verified AI conclusion.
 * Input order is the sequence; original event time is never replaced by receipt
 * time. maxChars bounds rendered text; structured excerpts share that budget.
 * Omitted rows and partial source text are explicit. No extra model invocation.
 */
export function summarizeMemoryDiscussion(messages, { maxChars = 2000 } = {}) {
  const limit = integer(maxChars, 2000, 1, 65536);
  const input = list(messages);
  const header = "讨论摘录（未核验；线索不等于已作出的决定）：\n";
  const suffix = "\n[有省略；非完整讨论]";
  const count = Math.min(input.length, 16, Math.floor(Math.max(0, limit - header.length - suffix.length) / 40));
  const perMessage = count ? Math.max(1, Math.floor((limit - header.length - suffix.length) / count) - 30) : 1;
  const prepared = prepareLearningMessages(input.slice(0, count), { config: { maxMessageChars: perMessage,
    maxBatchChars: Math.max(1, perMessage * Math.max(count, 1)), maxBatchMessages: 16 } });
  const participants = [];
  const seen = new Set();
  let text = header.slice(0, limit);
  const sequence = [];
  const decisions = [];
  const pending = [];
  for (const row of prepared.messages) {
    const index = row.sourceIndex;
    const raw = input[index];
    const userId = userOf(raw);
    const sentAt = originalTime(raw);
    const excerpt = row.text;
    const cues = [];
    // Only label literal cues; negated decisions remain verbatim, not conclusions.
    if (/(?:决定|确定|定了|就按|达成一致|\bdecid(?:e|ed)|\bagreed\b)/iu.test(excerpt)) cues.push("decision-cue");
    if (/(?:待定|待确认|还没|尚未|未决定|再讨论|再看看|不确定|还需要|\bpending\b|\btodo\b)/iu.test(excerpt)) cues.push("pending-cue");
    const line = `${index + 1}. ${excerpt}\n`;
    if (text.length + line.length + suffix.length > limit) break;
    text += line;
    if (!seen.has(String(userId))) { seen.add(String(userId)); participants.push({ userId }); }
    const item = { sequence: index + 1, sourceMessageId: row.sourceMessageId, userId, sentAt,
      sourceTimeKnown: sentAt !== null, isQuoted: row.isQuoted, excerpt, truncated: row.truncated,
      omittedRanges: row.omittedRanges, cues };
    sequence.push(item);
    if (cues.includes("decision-cue")) decisions.push({ sequence: index + 1, sourceMessageId: row.sourceMessageId });
    if (cues.includes("pending-cue")) pending.push({ sequence: index + 1, sourceMessageId: row.sourceMessageId });
  }
  const omittedMessageCount = input.length - sequence.length;
  const truncated = omittedMessageCount > 0 || sequence.some(row => row.truncated) || text.length < header.length;
  if (truncated) text = text.slice(0, Math.max(0, limit - suffix.length)) + suffix.slice(0, limit);
  return { text, verified: false, kind: "discussion-excerpts", participants, sequence, decisions, pending,
    sourceCount: input.length, omittedMessageCount, truncated };
}
