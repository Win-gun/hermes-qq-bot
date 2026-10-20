/**
 * Pure attribution boundary for AI memory extraction (no IO or current clock).
 *
 * prepareMemoryEvidenceBatch(rawMessages, { conversationId, botUserIds? })
 *   -> { conversationId, messages, rejected, errors }
 * messages are safe prompt rows: message_id, user_id, conversation_id,
 * sent_at (ISO), text. Keep the ORIGINAL raw batch for attribution diagnostics.
 * Raw sent_at/sentAt must be zoned ISO strings; sentAtMs is numeric Unix ms,
 * time is numeric Unix seconds. If several are present they must agree exactly.
 * receivedAt/at/processing-now are never used as event-time fallbacks.
 *
 * attributeMemoryEvidence(aiPatch, rawMessages, options)
 *   -> { items, batchIssues, errors }
 * Each item: { path, type, status, reasonCodes, candidate, patch, correction,
 * context, requiresAuthorization }. Only status="attributed" has a usable
 * patch/correction and context. Submit entry.patch/context individually to
 * mergeCanonicalEvidence (or the parent's equivalent adapter). Idempotence and
 * durable state remain the integrity module's responsibility.
 * context.sourceMessageTimes maps EACH selected ID to its original event ISO;
 * context.sentAt is only their maximum, never every source's individual time.
 * Keep that generated map through adapters so a mixed old/new batch cannot
 * manufacture multiple confirmations after a human correction.
 *
 * Per-assertion format (sources are NEVER inherited from a user-update/batch):
 * user_updates: [{ user_id, preferences: [{ value, source_message_ids, confidence? }] }]
 * canonical_entries: [{ user_id, kind, value, source_message_ids, confidence? }]
 * forget_or_correct: [{ user_id, memory_id, action, reason?, source_message_ids }]
 * Camel aliases are accepted. Old string arrays are unattributed candidates,
 * NOT executable tentative patches: some canonical kinds activate immediately.
 *
 * AI explicit hints are retained only as candidate.explicitHint. Neither an AI
 * hint nor attribution authenticates a human correction command; context.explicit
 * stays false and corrections require a separate caller authorization gate.
 * Quotes/replies/forwards/code are conservatively ineligible, including comments
 * attached to a quote. Preserve actor/quote metadata upstream: this module cannot
 * recover metadata removed by a flattener, or prove semantic entailment/truth.
 */

const FIELD_KINDS = new Map([
  ["aliases", "alias"], ["nicknames", "alias"], ["aka", "alias"],
  ["profile", "profile"], ["personality", "personality"], ["traits", "personality"],
  ["preferences", "preference"], ["boundaries", "boundary"], ["dislikes", "boundary"],
  ["coreMemes", "core_meme"], ["core_memes", "core_meme"], ["strong_memes", "core_meme"],
  ["memes", "meme"], ["style", "style"], ["relationships", "relationship"],
  ["interactionTips", "interaction_tip"], ["interaction_tips", "interaction_tip"], ["advice", "interaction_tip"],
  ["notableQuotes", "notable_quote"], ["notable_quotes", "notable_quote"], ["quotes", "notable_quote"]
]);
const KINDS = new Set(FIELD_KINDS.values());
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const USER_IDS = ["user_id", "userId", "subjectUserId", "qq"];
const SOURCE_IDS = ["source_message_ids", "sourceMessageIds"];
const MESSAGE_IDS = ["message_id", "messageId"];
const CONVERSATIONS = ["conversation_id", "conversationId"];
const HUMAN_ROLES = new Set(["user", "human", "member", "owner", "admin", "normal"]);
const QUOTE_FIELDS = ["quote", "quoted", "quotedText", "quoted_text", "quotedMessage", "quoted_message",
  "quotedMessageId", "quoted_message_id", "isQuoted", "is_quoted", "reply", "replyTo", "reply_to",
  "reply_to_message_id", "replyToMessageId", "replyContext", "replyContexts", "reply_contexts",
  "forward", "forwarded", "isForward", "is_forward", "forwardedMessages", "forwarded_messages"];

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && !FORBIDDEN_KEYS.has(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

function array(value) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every((key) => typeof key === "string" && (key === "length" || /^(0|[1-9]\d*)$/.test(key))
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

function own(value, key) {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function identifier(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== "string" || !value || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value)
    || FORBIDDEN_KEYS.has(value)) return null;
  return value;
}

function aliases(value, keys, parse = identifier) {
  const present = keys.filter((key) => Object.hasOwn(value, key));
  if (!present.length) return { value: null, error: "missing" };
  const parsed = present.map((key) => parse(own(value, key)));
  if (parsed.some((item) => item === null)) return { value: null, error: "invalid" };
  if (parsed.some((item) => JSON.stringify(item) !== JSON.stringify(parsed[0]))) return { value: null, error: "conflicting" };
  return { value: parsed[0], error: "" };
}

function confidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function text(value, max = 240) {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function isoTime(value, seconds = false) {
  let milliseconds;
  if (typeof value === "number") {
    milliseconds = value * (seconds ? 1000 : 1);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  } else if (!seconds && typeof value === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/\D/).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
    milliseconds = Date.parse(value);
  } else return null;
  if (milliseconds < 0 || milliseconds > 253402300799999) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function eventTime(message) {
  const names = ["sent_at", "sentAt", "sentAtMs", "time"].filter((key) => Object.hasOwn(message, key));
  if (!names.length) return null;
  const times = names.map((key) => {
    const value = own(message, key);
    const expectedType = key === "sentAtMs" || key === "time" ? "number" : "string";
    return typeof value === expectedType ? isoTime(value, key === "time") : null;
  });
  return times.every((time) => time !== null && time === times[0]) ? times[0] : null;
}

function nonempty(value) {
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0
    && !(Array.isArray(value) && value.length === 0);
}

function actorReason(message, botUserIds, userId) {
  const sender = own(message, "sender");
  if (sender !== undefined && typeof sender !== "string" && !record(sender)) return "INVALID_SENDER";
  for (const object of [message, ...(record(sender) ? [sender] : [])]) {
    for (const flag of ["isBot", "is_bot", "isTool", "is_tool", "isSelf", "is_self"]) {
      if (!Object.hasOwn(object, flag)) continue;
      if (typeof own(object, flag) !== "boolean") return "INVALID_ACTOR_FLAG";
      if (own(object, flag)) return "NON_HUMAN_SOURCE";
    }
    if (Object.hasOwn(object, "role") && !HUMAN_ROLES.has(own(object, "role"))) return "NON_HUMAN_SOURCE";
  }
  if (botUserIds.has(userId) || (Object.hasOwn(message, "self_id") && identifier(own(message, "self_id")) === userId)
    || (Object.hasOwn(message, "post_type") && own(message, "post_type") !== "message")) return "NON_HUMAN_SOURCE";
  for (const key of ["type", "sourceType", "source_type", "message_type"]) {
    if (Object.hasOwn(message, key) && !["message", "text", "user", "human", "group", "private", "normal"].includes(own(message, key))) return "NON_HUMAN_SOURCE";
  }
  if (["bot", "assistant", "tool", "system", "function"].includes(own(message, "source"))) return "NON_HUMAN_SOURCE";
  return "";
}

function authoredText(message) {
  if (QUOTE_FIELDS.some((key) => Object.hasOwn(message, key) && nonempty(own(message, key)))) return { error: "QUOTED_SOURCE" };
  const segments = own(message, "message");
  let segmentText;
  if (segments !== undefined) {
    if (typeof segments === "string") segmentText = segments;
    else if (array(segments)) {
      const parts = [];
      for (const segment of segments) {
        if (!record(segment) || !record(own(segment, "data"))) return { error: "INVALID_MESSAGE_BODY" };
        const type = own(segment, "type");
        if (["reply", "forward", "node", "json", "xml"].includes(type)) return { error: "QUOTED_SOURCE" };
        if (type === "text") {
          if (typeof own(segment.data, "text") !== "string") return { error: "INVALID_MESSAGE_BODY" };
          parts.push(segment.data.text);
        } else if (type !== "at") return { error: "NON_TEXT_SOURCE" };
      }
      segmentText = parts.join("");
    } else return { error: "INVALID_MESSAGE_BODY" };
  }
  const raw = own(message, "text");
  if (raw !== undefined && typeof raw !== "string") return { error: "INVALID_MESSAGE_BODY" };
  if (raw !== undefined && segmentText !== undefined && raw !== segmentText) return { error: "CONFLICTING_MESSAGE_BODY" };
  const body = raw ?? segmentText;
  if (typeof body !== "string" || !body.trim()) return { error: "EMPTY_SOURCE_TEXT" };
  if (/\[CQ:(?:reply|forward|node|json|xml)\b|["“”‘’「」『』`]|^\s*>|(?:^|[\s:：])'[^']+'|<\/?(?:quote|blockquote)\b/imu.test(body)) return { error: "QUOTED_SOURCE" };
  return { value: body, error: "" };
}

function prepare(messages, options) {
  const errors = [];
  const index = new Map();
  const rejected = [];
  const validOptions = record(options);
  const conversationId = validOptions ? identifier(own(options, "conversationId")) : null;
  if (!conversationId) errors.push("INVALID_CONVERSATION_ID");
  const botIds = validOptions ? own(options, "botUserIds") : undefined;
  if (botIds !== undefined && (!array(botIds) || botIds.some((id) => identifier(id) === null))) errors.push("INVALID_BOT_USER_IDS");
  if (!array(messages)) errors.push("INVALID_BATCH");
  if (errors.length) return { conversationId, messages: [], rejected, errors, index };
  const botUserIds = new Set((botIds || []).map(identifier));
  const groups = new Map();
  for (let position = 0; position < messages.length; position += 1) {
    const raw = messages[position];
    if (!record(raw)) {
      rejected.push({ index: position, messageId: null, reasonCodes: ["INVALID_MESSAGE"] });
      continue;
    }
    const id = aliases(raw, MESSAGE_IDS).value;
    const conversation = aliases(raw, CONVERSATIONS);
    if (conversation.error !== "missing" && conversation.value !== conversationId) {
      rejected.push({ index: position, messageId: id, reasonCodes: ["CONVERSATION_MISMATCH"] });
      continue;
    }
    const reasonCodes = [];
    const sender = own(raw, "sender");
    const outerUser = aliases(raw, ["user_id", "userId", "senderId"]);
    const nestedUser = record(sender) ? aliases(sender, ["user_id", "userId"]) : { error: "missing", value: null };
    const userId = outerUser.value || nestedUser.value;
    if (!id) reasonCodes.push("INVALID_MESSAGE_ID");
    if (!userId || (outerUser.error && outerUser.error !== "missing") || (nestedUser.error && nestedUser.error !== "missing")
      || (outerUser.value && nestedUser.value && outerUser.value !== nestedUser.value)) reasonCodes.push("INVALID_SENDER_ID");
    const actorError = actorReason(raw, botUserIds, userId);
    if (actorError) reasonCodes.push(actorError);
    const body = authoredText(raw);
    if (body.error) reasonCodes.push(body.error);
    const sentAt = eventTime(raw);
    if (!sentAt) reasonCodes.push("INVALID_EVENT_TIME");
    const row = { message_id: id, user_id: userId, conversation_id: conversationId, sent_at: sentAt, text: body.value || "" };
    const item = { index: position, messageId: id, reasonCodes, row };
    if (!id) rejected.push({ index: position, messageId: null, reasonCodes });
    else {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
  }
  for (const [id, items] of groups) {
    const signatures = new Set(items.map((item) => JSON.stringify([item.row, item.reasonCodes])));
    const reasonCodes = signatures.size > 1 ? ["AMBIGUOUS_SOURCE_ID"] : items[0].reasonCodes;
    index.set(id, { row: items[0].row, reasonCodes });
    if (reasonCodes.length) for (const item of items) rejected.push({ index: item.index, messageId: id, reasonCodes: [...reasonCodes] });
  }
  const rows = [...index.values()].filter((item) => !item.reasonCodes.length).map((item) => item.row)
    .sort((a, b) => a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0);
  return { conversationId, messages: rows, rejected, errors, index };
}

export function prepareMemoryEvidenceBatch(messages, options = {}) {
  const { index, ...result } = prepare(messages, options);
  return result;
}

function selectedSources(claim, subjectUserId, batch) {
  const sources = aliases(claim, SOURCE_IDS, (value) => {
    if (!array(value) || value.some((id) => identifier(id) === null)) return null;
    return [...new Set(value.map(identifier))].sort();
  });
  if (sources.error === "missing" || (!sources.error && !sources.value.length)) return { reasonCodes: ["SOURCE_IDS_MISSING"], missing: true };
  if (sources.error) return { reasonCodes: ["INVALID_SOURCE_IDS"], missing: false };
  const reasonCodes = [];
  const selected = [];
  for (const id of sources.value) {
    const source = batch.index.get(id);
    if (!source) reasonCodes.push("SOURCE_NOT_IN_BATCH");
    else if (source.reasonCodes.length) reasonCodes.push(...source.reasonCodes);
    else if (source.row.user_id !== subjectUserId) reasonCodes.push("SOURCE_SUBJECT_MISMATCH");
    else selected.push(source.row);
  }
  if (reasonCodes.length) return { reasonCodes: [...new Set(reasonCodes)], missing: false };
  const sentAt = selected.map((row) => row.sent_at).sort().at(-1);
  return { reasonCodes: [], context: {
    subjectUserId, sourceUserId: subjectUserId, conversationId: batch.conversationId,
    sourceMessageIds: sources.value,
    sourceMessageTimes: Object.fromEntries(selected.map(row => [row.message_id, row.sent_at])),
    sentAt, explicit: false
  } };
}

/** See the header contract. This function never accepts processing timestamps,
 * infers a subject from a display name, or resolves correction target IDs. */
export function attributeMemoryEvidence(aiPatch, messages, options = {}) {
  const batch = prepare(messages, options);
  const result = { items: [], batchIssues: batch.rejected, errors: [...batch.errors] };
  if (!record(aiPatch)) {
    result.errors.push("INVALID_PATCH");
    return result;
  }
  const rootConfidence = Object.hasOwn(aiPatch, "confidence") ? aiPatch.confidence : 0.55;

  function add(raw, path, type, parent = {}, kind = null) {
    const legacy = typeof raw === "string";
    const claim = record(raw) ? raw : {};
    const reasonCodes = [];
    const subject = aliases(claim, USER_IDS);
    const parentSubject = aliases(parent, [...USER_IDS, "id"]);
    const subjectUserId = subject.value || parentSubject.value;
    if (!subjectUserId || (subject.error && subject.error !== "missing") || (parentSubject.error && parentSubject.error !== "missing")
      || (subject.value && parentSubject.value && subject.value !== parentSubject.value)) reasonCodes.push("INVALID_SUBJECT_ID");
    if (!legacy && !record(raw)) reasonCodes.push("INVALID_CANDIDATE");
    if (legacy && type === "correction") reasonCodes.push("INVALID_CORRECTION");
    const candidate = { subjectUserId };
    let correction = null;
    let normalized;
    if (type === "entry") {
      const itemKind = kind || own(claim, "kind");
      const value = text(legacy ? raw : own(claim, "value"), itemKind === "notable_quote" ? 180 : 240);
      const itemConfidence = confidence(Object.hasOwn(claim, "confidence") ? claim.confidence
        : Object.hasOwn(parent, "confidence") ? parent.confidence : rootConfidence);
      if (!KINDS.has(itemKind)) reasonCodes.push("INVALID_KIND");
      if (kind && Object.hasOwn(claim, "kind") && claim.kind !== kind) reasonCodes.push("KIND_MISMATCH");
      if (!value) reasonCodes.push("INVALID_VALUE");
      if (itemConfidence === null) reasonCodes.push("INVALID_CONFIDENCE");
      if (Object.hasOwn(claim, "explicit") && typeof claim.explicit !== "boolean") reasonCodes.push("INVALID_EXPLICIT_HINT");
      Object.assign(candidate, { kind: KINDS.has(itemKind) ? itemKind : null, value, confidence: itemConfidence, explicitHint: claim.explicit === true });
      normalized = { kind: itemKind, value, confidence: itemConfidence, explicit: false };
    } else {
      const memoryId = aliases(claim, ["memory_id", "memoryId"]).value;
      const action = own(claim, "action");
      const reason = own(claim, "reason");
      if (!memoryId) reasonCodes.push("INVALID_MEMORY_ID");
      if (!["reject", "supersede", "tentative"].includes(action)) reasonCodes.push("INVALID_CORRECTION_ACTION");
      if (reason !== undefined && text(reason, 180) === null) reasonCodes.push("INVALID_CORRECTION_REASON");
      Object.assign(candidate, { memoryId, action: typeof action === "string" ? action : null });
      correction = { user_id: subjectUserId, memory_id: memoryId, action, reason: typeof reason === "string" ? reason.trim() : "" };
    }
    const conversation = aliases(claim, CONVERSATIONS);
    if (conversation.error !== "missing" && conversation.value !== batch.conversationId) reasonCodes.push("CONVERSATION_MISMATCH");
    if (batch.errors.length) reasonCodes.push(...batch.errors);
    const attribution = selectedSources(claim, subjectUserId, batch);
    reasonCodes.push(...attribution.reasonCodes);
    const uniqueReasons = [...new Set(reasonCodes)];
    const status = !uniqueReasons.length ? "attributed"
      : type === "entry" && attribution.missing && uniqueReasons.every((reason) => reason === "SOURCE_IDS_MISSING") ? "unattributed" : "rejected";
    result.items.push({ path, type, status, reasonCodes: uniqueReasons, candidate,
      patch: status === "attributed" && type === "entry" ? { user_id: subjectUserId, canonical_entries: [normalized] } : null,
      correction: status === "attributed" && type === "correction" ? correction : null,
      context: status === "attributed" ? attribution.context : null,
      requiresAuthorization: type === "correction"
    });
  }

  function list(object, key, visit, prefix = "") {
    if (!Object.hasOwn(object, key)) return;
    const value = own(object, key);
    const path = prefix ? `${prefix}.${key}` : key;
    if (!array(value)) {
      result.errors.push(`INVALID_ARRAY:${path}`);
      return;
    }
    value.forEach((item, index) => visit(item, `${path}[${index}]`));
  }

  for (const key of ["user_updates", "userUpdates"]) list(aiPatch, key, (update, path) => {
    if (!record(update)) {
      result.errors.push(`INVALID_USER_UPDATE:${path}`);
      return;
    }
    for (const [field, kind] of FIELD_KINDS) list(update, field, (item, itemPath) => add(item, itemPath, "entry", update, kind), path);
    for (const nested of ["canonical_entries", "canonicalEntries"]) list(update, nested, (item, itemPath) => add(item, itemPath, "entry", update), path);
  });
  for (const key of ["canonical_entries", "canonicalEntries"]) list(aiPatch, key, (item, path) => add(item, path, "entry"));
  for (const key of ["forget_or_correct", "forgetOrCorrect", "corrections"]) list(aiPatch, key, (item, path) => add(item, path, "correction"));
  return result;
}
