import { attributeMemoryEvidence, prepareMemoryEvidenceBatch } from "./memory-evidence.js";
import { canonicalMemoryFields, ensureCanonicalMemory, legacyMemoryValues, mergeCanonicalEvidence } from "./memory-integrity.js";

/**
 * applyMemoryExtraction(draftGroup, conversationId, aiPatch, originalBatch,
 *   { redact?: (text) => string, integrity?: object, botUserIds?: id[] })
 * -> { changed, accepted: receipt[], proposed: receipt[], rejected: receipt[], fatalErrors: receipt[] }
 * fatalErrors identify invalid top-level input/schema: retain the source batch.
 * Individual rejected assertions can be acknowledged. Unrelated stored group
 * fields (jobs, archives, other users) are neither validated nor traversed.
 * No IO, services or processing-time fallback. Only the supplied draft mutates.
 * Accepted means evidence was applied, NOT necessarily stable/active. Replays
 * may be accepted with changed=false. AI corrections/bot identity/task requests
 * remain deduplicated memoryProposals; this API never authenticates commands.
 *
 * Group fields accept strings (proposal only) or {value, source_message_ids,
 * confidence?}. Their independent profile wrappers use synthetic subjects
 * conversation:<id>:facts/topics. Group source IDs may span eligible humans;
 * unlike a user self-claim they do not assert that all senders are one person.
 * AI group facts always require independent evidence even if requireEvidence
 * is disabled in user configuration. Trusted management commands are external.
 *
 * groupMemoryValues(group, "facts"|"topics", {integrity?}) is READ-ONLY and
 * must replace direct prompt reads of the raw compatibility arrays. No wrapper
 * means legacy compatibility; once bootstrapped, unknown mirrors are excluded.
 *
 * integrity limits: maxCandidatesPerPatch=128, maxProposalsPerGroup=512,
 * maxSummaryEvidence=512, maxSummaryDeltaLength=800. Overflow is explicitly
 * rejected; existing history is never evicted. Summary strings use the eligible
 * batch only as contextual provenance, never independent canonical evidence.
 * Pass the production privacy policy as redact; the default covers obvious
 * credential/phone patterns only. redaction failures reject the individual item.
 */

const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const KIND_FIELDS = new Map(Object.entries(canonicalMemoryFields).map(([field, kind]) => [kind, field]));
const GROUP_FIELDS = new Map([
  ["group_facts", "facts"], ["groupFacts", "facts"], ["facts", "facts"],
  ["topic_updates", "topics"], ["topicUpdates", "topics"], ["topics", "topics"]
]);
const ROOT_FIELDS = new Set(["confidence", "user_updates", "userUpdates", "canonical_entries", "canonicalEntries",
  "forget_or_correct", "forgetOrCorrect", "corrections", "bot_self_update", "botSelfUpdate", "self_update",
  "summary_delta", "summaryDelta", "group_facts", "groupFacts", "topic_updates", "topicUpdates"]);
const BOT_FIELDS = new Set(["identity", "personality", "speech_style", "speechStyle", "style", "catchphrases",
  "capabilities", "boundaries", "notable_messages", "notableMessages", "quotes", "stances"]);

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every((key) => (
    typeof key === "string" && !BAD_KEYS.has(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")
  ));
}

function container(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function storedSlot(object, field, check) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  return !descriptor || (Object.hasOwn(descriptor, "value") && check(descriptor.value));
}

function arrayState(value) { return Array.isArray(value) && jsonData(value); }
function recordState(value) { return record(value) && jsonData(value); }

function mutationTracker() {
  const slots = new Map();
  return {
    watch(object, field) {
      if (!slots.has(object)) slots.set(object, new Map());
      const fields = slots.get(object);
      if (!fields.has(field)) fields.set(field, { exists: Object.hasOwn(object, field), value: JSON.stringify(object[field]) });
    },
    changed() {
      for (const [object, fields] of slots) for (const [field, before] of fields) {
        if (before.exists !== Object.hasOwn(object, field) || before.value !== JSON.stringify(object[field])) return true;
      }
      return false;
    }
  };
}

function jsonData(value, budget = { left: 100_000 }, ancestors = new Set()) {
  if (--budget.left < 0 || ancestors.size > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1
      || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) return false;
  } else if (!record(value)) return false;
  ancestors.add(value);
  const valid = keys.filter((key) => key !== "length" || !Array.isArray(value)).every((key) => jsonData(value[key], budget, ancestors));
  ancestors.delete(value);
  return valid;
}

function identifier(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !BAD_KEYS.has(value)
    && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function key(value) {
  return value.toLowerCase().replace(/[，。！？!?、；;：:\s"'“”‘’（）()\[\]【】]/g, "");
}

function defaultRedact(value) {
  return value.replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/((?:password|api[_ -]?key|token|密码|验证码)\s*[:=：]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(?<!\d)(?:1[3-9]\d{9}|\d{16,19}[0-9Xx]?)(?!\d)/g, "[REDACTED]");
}

function sanitize(value, redact, max = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_VALUE");
  const output = redact(value);
  if (typeof output !== "string" || !output.trim() || output.length > max) throw new Error("REDACTION_REJECTED");
  const cleaned = output.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("REDACTION_REJECTED");
  return cleaned;
}

function maxTime(...values) {
  const times = values.filter((value) => typeof value === "string").map(Date.parse).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function append(object, field, value) {
  if (!Object.hasOwn(object, field)) object[field] = [];
  if (!Array.isArray(object[field])) return false;
  if (object[field].some((old) => typeof old === "string" && key(old) === key(value))) return false;
  object[field].push(value);
  return true;
}

function pathValue(patch, path) {
  let value = patch;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (!value || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function wrapperField(field) {
  return field === "facts" ? "groupFactMemory" : "groupTopicMemory";
}

function canonicalShape(holder) {
  if (!Object.hasOwn(holder, "canonicalMemory")) return true;
  const canonical = holder.canonicalMemory;
  return record(canonical) && ["entries", "conflicts"].every((field) => !Object.hasOwn(canonical, field)
    || (Array.isArray(canonical[field]) && canonical[field].every(record)));
}

function groupSubject(conversationId, field) {
  return `conversation:${conversationId}:${field}`;
}

function groupWrapper(group, conversationId, field, redact) {
  const slot = wrapperField(field);
  if (!storedSlot(group, field, arrayState) || !storedSlot(group, slot, recordState)) throw new Error("INVALID_GROUP_MEMORY_STATE");
  const subject = groupSubject(conversationId, field);
  if (Object.hasOwn(group, slot)) {
    const wrapper = group[slot];
    if (wrapper.conversationId !== conversationId || wrapper.canonicalMemory?.subjectUserId !== subject
      || !canonicalShape(wrapper) || !Array.isArray(wrapper.profile)) throw new Error("WRAPPER_SUBJECT_MISMATCH");
    return wrapper;
  }
  // Snapshot only pre-existing raw values, before ANY new mirror is appended.
  return { conversationId, profile: (group[field] || []).map((old) => sanitize(old, redact)) };
}

function taskScoped(raw, value = "") {
  return record(raw) && (["taskId", "task_id"].some((field) => Object.hasOwn(raw, field) && raw[field] !== null && raw[field] !== "")
    || ["scope", "memoryScope", "memory_scope"].some((field) => ["task", "session", "temporary"].includes(raw[field]))
    || raw.isTask === true || raw.is_task === true)
    || /(?:本次|这次|当前)(?:任务|授权)|临时(?:参数|要求|授权|路径)|(?:仅|只)(?:限|用于)(?:本次|这次|当前)/u.test(value);
}

function limitsFor(integrity) {
  const defaults = { maxCandidatesPerPatch: 128, maxProposalsPerGroup: 512, maxSummaryEvidence: 512, maxSummaryDeltaLength: 800 };
  for (const name of Object.keys(defaults)) {
    if (Object.hasOwn(integrity, name)) {
      if (!Number.isSafeInteger(integrity[name]) || integrity[name] < 0) return null;
      defaults[name] = integrity[name];
    }
  }
  for (const name of ["minStableConfidence", "promptMinConfidence"]) {
    if (Object.hasOwn(integrity, name) && (typeof integrity[name] !== "number" || integrity[name] < 0 || integrity[name] > 1)) return null;
  }
  if (Object.hasOwn(integrity, "requireEvidence") && typeof integrity.requireEvidence !== "boolean") return null;
  return defaults;
}

function proposalKey(item) {
  return JSON.stringify([item.type, item.subjectUserId || "", item.kind || "", typeof item.value === "string" ? key(item.value) : "",
    item.memoryId || "", item.action || "", item.conversationId]);
}

export function applyMemoryExtraction(group, conversationId, patch, messages, options = {}) {
  const result = { changed: false, accepted: [], proposed: [], rejected: [], fatalErrors: [] };
  const reject = (path, reason, type = "schema") => result.rejected.push({ path, type, reasonCodes: [reason] });
  const fatal = (path, reason) => {
    const receipt = { path, type: "schema", reasonCodes: [reason] };
    result.fatalErrors.push(receipt);
    result.rejected.push(structuredClone(receipt));
  };
  if (!container(group)) { fatal("group", "INVALID_GROUP"); return result; }
  if (!record(patch) || !jsonData(patch)) { fatal("patch", "INVALID_PATCH"); return result; }
  if (!Array.isArray(messages) || !jsonData(messages)) { fatal("messages", "INVALID_BATCH"); return result; }
  if (Object.hasOwn(patch, "confidence") && (typeof patch.confidence !== "number" || patch.confidence < 0 || patch.confidence > 1)) {
    fatal("confidence", "INVALID_CONFIDENCE"); return result;
  }
  if (!record(options) || (Object.hasOwn(options, "redact") && typeof options.redact !== "function")
    || (Object.hasOwn(options, "integrity") && (!record(options.integrity) || !jsonData(options.integrity)))) {
    fatal("options", "INVALID_OPTIONS"); return result;
  }
  const integrity = options.integrity || {};
  const limits = limitsFor(integrity);
  const redact = options.redact || defaultRedact;
  if (!limits) { fatal("integrity", "INVALID_LIMITS"); return result; }
  if (!identifier(conversationId)) { fatal("conversationId", "INVALID_CONVERSATION_ID"); return result; }
  conversationId = String(conversationId);
  for (const name of ["user_updates", "userUpdates", "canonical_entries", "canonicalEntries", "forget_or_correct", "forgetOrCorrect", "corrections", "group_facts", "groupFacts", "topic_updates", "topicUpdates"]) {
    if (Object.hasOwn(patch, name) && !Array.isArray(patch[name])) fatal(name, "INVALID_ARRAY");
  }
  for (const name of ["bot_self_update", "botSelfUpdate", "self_update"]) {
    if (Object.hasOwn(patch, name) && !record(patch[name])) fatal(name, "INVALID_BOT_PATCH");
  }
  for (const name of ["summary_delta", "summaryDelta"]) {
    if (Object.hasOwn(patch, name) && typeof patch[name] !== "string" && !record(patch[name])) fatal(name, "INVALID_SUMMARY");
  }
  if (result.fatalErrors.length) return result;
  const evidenceOptions = { conversationId, ...(Object.hasOwn(options, "botUserIds") ? { botUserIds: options.botUserIds } : {}) };
  const batch = prepareMemoryEvidenceBatch(messages, evidenceOptions);
  if (batch.errors.length) { for (const error of batch.errors) fatal("messages", error); return result; }
  // The normalized eligible batch contains no getters/proto payloads; never read
  // unsafe raw message metadata before validating the corresponding record.
  const eligible = new Map(batch.messages.map((message) => [message.message_id, message]));
  const eligibleUsers = new Set(batch.messages.map((message) => message.user_id));
  const rawById = new Map();
  for (const raw of messages) {
    if (!record(raw) || !jsonData(raw)) continue;
    const id = identifier(raw.message_id ?? raw.messageId);
    const row = eligible.get(id);
    const senderId = identifier(raw.user_id ?? raw.userId ?? raw.senderId ?? (record(raw.sender) ? raw.sender.user_id ?? raw.sender.userId : null));
    if (!row || senderId !== row.user_id) continue;
    if (!rawById.has(id)) rawById.set(id, []);
    rawById.get(id).push(raw);
  }
  const mutations = mutationTracker();
  let seenCandidates = 0;
  function budget(path, type) {
    seenCandidates += 1;
    if (seenCandidates <= limits.maxCandidatesPerPatch) return true;
    reject(path, "CANDIDATE_LIMIT", type);
    return false;
  }
  function propose(item, path, reasons) {
    if (!storedSlot(group, "memoryProposals", arrayState)) { reject(path, "INVALID_PROPOSAL_STATE", item.type); return; }
    const proposal = { ...item, conversationId, reasonCodes: [...new Set(reasons)] };
    const previous = (group.memoryProposals || []).find((old) => record(old) && proposalKey(old) === proposalKey(proposal));
    if (previous) {
      if ((Object.hasOwn(previous, "sourceMessageIds") && !Array.isArray(previous.sourceMessageIds))
        || (Object.hasOwn(previous, "reasonCodes") && !Array.isArray(previous.reasonCodes))) { reject(path, "INVALID_PROPOSAL_STATE", item.type); return; }
      mutations.watch(group, "memoryProposals");
      previous.sourceMessageIds = [...new Set([...(previous.sourceMessageIds || []), ...(proposal.sourceMessageIds || [])])].sort();
      previous.reasonCodes = [...new Set([...(previous.reasonCodes || []), ...proposal.reasonCodes])];
      previous.sentAt = maxTime(previous.sentAt, proposal.sentAt);
    } else {
      if ((group.memoryProposals || []).length >= limits.maxProposalsPerGroup) { reject(path, "PROPOSAL_LIMIT", item.type); return; }
      mutations.watch(group, "memoryProposals");
      if (!group.memoryProposals) group.memoryProposals = [];
      group.memoryProposals.push(proposal);
    }
    result.proposed.push({ path, ...structuredClone(proposal), stored: !previous });
  }
  function sanitizeProposal(item, path, reasons) {
    try {
      if (item.value !== undefined) item.value = sanitize(item.value, redact, item.type === "summary" ? limits.maxSummaryDeltaLength : 240);
      propose(item, path, reasons);
    } catch { reject(path, "REDACTION_REJECTED", item.type); }
  }
  function sources(raw) {
    if (!record(raw)) return { error: "SOURCE_IDS_MISSING" };
    const a = raw.source_message_ids;
    const b = raw.sourceMessageIds;
    if (a === undefined && b === undefined) return { error: "SOURCE_IDS_MISSING" };
    const parse = (value) => Array.isArray(value) && value.length && value.every((id) => identifier(id) !== null)
      ? [...new Set(value.map(identifier))].sort() : null;
    const ids = parse(a !== undefined ? a : b);
    if (!ids || (a !== undefined && b !== undefined && JSON.stringify(ids) !== JSON.stringify(parse(b)))) return { error: "INVALID_SOURCE_IDS" };
    for (const field of ["conversationId", "conversation_id"]) {
      if (Object.hasOwn(raw, field) && raw[field] !== conversationId) return { error: "CONVERSATION_MISMATCH" };
    }
    if (ids.some((id) => !eligible.has(id))) return { error: "SOURCE_NOT_ELIGIBLE" };
    return { context: { conversationId, sourceMessageIds: ids, sourceUserIds: [...new Set(ids.map((id) => eligible.get(id).user_id))].sort(),
      sourceMessageTimes: Object.fromEntries(ids.map(id => [id, eligible.get(id).sent_at])),
      sentAt: maxTime(...ids.map((id) => eligible.get(id).sent_at)), explicit: false } };
  }
  function selectedTask(context, raw, value) {
    return taskScoped(raw, value) || context?.sourceMessageIds.some((id) => (rawById.get(id) || []).some((source) => taskScoped(source, eligible.get(id)?.text || "")));
  }
  function updateName(user, context) {
    const rows = context.sourceMessageIds.map((id) => eligible.get(id)).filter(Boolean)
      .sort((a, b) => a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : a.message_id < b.message_id ? -1 : 1);
    for (const row of rows) {
      const names = new Set();
      for (const source of rawById.get(row.message_id) || []) {
        const name = typeof source.sender === "string" ? source.sender
          : record(source.sender) ? source.sender.card || source.sender.nickname : source.senderName;
        if (typeof name === "string" && name.trim()) {
          try { names.add(sanitize(name, redact, 120)); } catch { /* Failed name redaction never saves the name. */ }
        }
      }
      if (names.size !== 1) continue;
      const name = [...names][0];
      const baseline = maxTime(user.lastNameAt, user.lastSeenAt, user.updatedAt);
      append(user, "names", name);
      if (!baseline || row.sent_at >= baseline) { user.lastName = name; user.lastNameAt = row.sent_at; }
      break;
    }
  }

  const attributed = attributeMemoryEvidence(patch, messages, evidenceOptions);
  for (const error of attributed.errors) reject("patch", error);
  for (const item of attributed.items) {
    if (!budget(item.path, item.type)) continue;
    const candidate = item.candidate;
    if (!eligibleUsers.has(candidate.subjectUserId)) { reject(item.path, "UNKNOWN_SUBJECT", item.type); continue; }
    const raw = pathValue(patch, item.path);
    const missingOnly = item.reasonCodes.length && item.reasonCodes.every((reason) => reason === "SOURCE_IDS_MISSING");
    if (item.status === "rejected" && !missingOnly) {
      result.rejected.push({ path: item.path, type: item.type, reasonCodes: [...item.reasonCodes] }); continue;
    }
    if (item.type === "correction") {
      sanitizeProposal({ type: "correction", subjectUserId: candidate.subjectUserId, memoryId: candidate.memoryId,
        action: candidate.action, value: record(raw) && typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : "待人工核验纠错",
        sourceMessageIds: item.context?.sourceMessageIds || [], sentAt: item.context?.sentAt || null }, item.path,
      ["CORRECTION_REQUIRES_AUTHORIZATION", ...item.reasonCodes]);
      continue;
    }
    if (item.status === "unattributed" || selectedTask(item.context, raw, candidate.value)) {
      sanitizeProposal({ type: "entry", subjectUserId: candidate.subjectUserId, kind: candidate.kind, value: candidate.value,
        confidence: candidate.confidence, sourceMessageIds: item.context?.sourceMessageIds || [], sentAt: item.context?.sentAt || null },
      item.path, item.status === "unattributed" ? ["SOURCE_IDS_MISSING"] : ["TASK_SCOPED"]);
      continue;
    }
    try {
      const value = sanitize(candidate.value, redact, candidate.kind === "notable_quote" ? 180 : 240);
      const field = KIND_FIELDS.get(candidate.kind);
      if (!storedSlot(group, "users", container)) { reject(item.path, "INVALID_USERS_STATE", item.type); continue; }
      if (group.users && !storedSlot(group.users, candidate.subjectUserId, recordState)) { reject(item.path, "INVALID_USER_STATE", item.type); continue; }
      const existing = group.users?.[candidate.subjectUserId];
      if (group.users && Object.hasOwn(group.users, candidate.subjectUserId) && (!record(existing)
        || !canonicalShape(existing)
        || ["user_id", "userId", "subjectUserId", "qq"].some((name) => Object.hasOwn(existing, name) && identifier(existing[name]) !== candidate.subjectUserId)
        || (existing.canonicalMemory?.subjectUserId && String(existing.canonicalMemory.subjectUserId) !== candidate.subjectUserId)
        || (Object.hasOwn(existing, field) && !Array.isArray(existing[field])) || (Object.hasOwn(existing, "names") && !Array.isArray(existing.names)))) {
        reject(item.path, "INVALID_USER_STATE", item.type); continue;
      }
      if (!group.users) { mutations.watch(group, "users"); group.users = {}; }
      else mutations.watch(group.users, candidate.subjectUserId);
      const user = existing || { names: [], confidence: {}, messageCount: 0, firstSeenAt: item.context.sentAt, lastSeenAt: item.context.sentAt };
      ensureCanonicalMemory(user, candidate.subjectUserId, { at: item.context.sentAt, sourceConversationId: "legacy" });
      mergeCanonicalEvidence(user, { user_id: candidate.subjectUserId, canonical_entries: [{ kind: candidate.kind, value, confidence: candidate.confidence, explicit: false }] }, item.context, integrity);
      append(user, field, value);
      updateName(user, item.context);
      user.lastSeenAt = maxTime(user.lastSeenAt, item.context.sentAt);
      user.updatedAt = maxTime(user.updatedAt, item.context.sentAt);
      group.users[candidate.subjectUserId] = user;
      result.accepted.push({ path: item.path, type: "entry", subjectUserId: candidate.subjectUserId, kind: candidate.kind, value,
        context: structuredClone(item.context) });
    } catch { reject(item.path, "APPLICATION_REJECTED", item.type); }
  }

  const defaultConfidence = Object.hasOwn(patch, "confidence") ? patch.confidence : 0.55;
  for (const [name, field] of GROUP_FIELDS) {
    if (!ROOT_FIELDS.has(name) || !Object.hasOwn(patch, name)) continue;
    if (!Array.isArray(patch[name])) { reject(name, "INVALID_ARRAY", field); continue; }
    patch[name].forEach((raw, index) => {
      const path = `${name}[${index}]`;
      if (!budget(path, field)) return;
      const valueRaw = typeof raw === "string" ? raw : record(raw) ? raw.value : null;
      const candidateConfidence = record(raw) && Object.hasOwn(raw, "confidence") ? raw.confidence : defaultConfidence;
      if (typeof candidateConfidence !== "number" || candidateConfidence < 0 || candidateConfidence > 1) { reject(path, "INVALID_CONFIDENCE", field); return; }
      const source = sources(raw);
      try {
        const value = sanitize(valueRaw, redact);
        if (source.error && source.error !== "SOURCE_IDS_MISSING") { reject(path, source.error, field); return; }
        if (source.error === "SOURCE_IDS_MISSING" || selectedTask(source.context, raw, valueRaw)) {
          propose({ type: field, value, confidence: candidateConfidence, sourceMessageIds: source.context?.sourceMessageIds || [],
            sentAt: source.context?.sentAt || null }, path, [source.error || "TASK_SCOPED"]); return;
        }
        const slot = wrapperField(field);
        const subject = groupSubject(conversationId, field);
        const wrapper = groupWrapper(group, conversationId, field, redact);
        mutations.watch(group, slot);
        mutations.watch(group, field);
        ensureCanonicalMemory(wrapper, subject, { at: source.context.sentAt, sourceConversationId: "legacy" });
        mergeCanonicalEvidence(wrapper, { user_id: subject, canonical_entries: [{ kind: "profile", value, confidence: candidateConfidence, explicit: false }] },
          { ...source.context, subjectUserId: subject }, { ...integrity, requireEvidence: true });
        append(wrapper, "profile", value);
        append(group, field, value);
        group[slot] = wrapper;
        result.accepted.push({ path, type: field, value, context: structuredClone(source.context) });
      } catch { reject(path, "APPLICATION_REJECTED", field); }
    });
  }

  for (const name of ["bot_self_update", "botSelfUpdate", "self_update"]) {
    if (!Object.hasOwn(patch, name)) continue;
    if (!record(patch[name])) { reject(name, "INVALID_BOT_PATCH", "bot_self"); continue; }
    const bot = patch[name];
    for (const field of Object.keys(bot)) {
      if (field === "confidence") continue;
      if (!BOT_FIELDS.has(field) || !Array.isArray(bot[field])) { reject(`${name}.${field}`, "UNSUPPORTED_BOT_FIELD", "bot_self"); continue; }
      bot[field].forEach((raw, index) => {
        const path = `${name}.${field}[${index}]`;
        if (!budget(path, "bot_self")) return;
        const value = typeof raw === "string" ? raw : record(raw) ? raw.value || raw.text || (field === "stances" && typeof raw.topic === "string" && typeof (raw.stance ?? raw.view) === "string" ? `${raw.topic}:${raw.stance ?? raw.view}` : null) : null;
        sanitizeProposal({ type: "bot_self", kind: field, value, sourceMessageIds: [], sentAt: null }, path, ["BOT_SELF_REQUIRES_AUTHORIZATION"]);
      });
    }
  }

  for (const name of ["summary_delta", "summaryDelta"]) {
    if (!Object.hasOwn(patch, name)) continue;
    if (!budget(name, "summary")) continue;
    if (!storedSlot(group, "summaryEvidence", arrayState) || !storedSlot(group, "rollingSummary", (value) => typeof value === "string")) {
      reject(name, "INVALID_SUMMARY_STATE", "summary"); continue;
    }
    const raw = patch[name];
    const provenance = typeof raw === "string" ? { context: { conversationId,
      sourceMessageIds: batch.messages.map((message) => message.message_id).sort(), sourceUserIds: [...eligibleUsers].sort(),
      sentAt: maxTime(...batch.messages.map((message) => message.sent_at)) } } : sources(raw);
    try {
      const value = sanitize(typeof raw === "string" ? raw : record(raw) ? raw.value : null, redact, limits.maxSummaryDeltaLength);
      if (provenance.error || !provenance.context?.sentAt) { reject(name, provenance.error || "NO_ELIGIBLE_SOURCE", "summary"); continue; }
      const entry = { value, conversationId, sourceMessageIds: provenance.context.sourceMessageIds, sourceUserIds: provenance.context.sourceUserIds,
        sentAt: provenance.context.sentAt };
      const history = group.summaryEvidence || [];
      const duplicate = history.some((old) => old.value === value && old.conversationId === conversationId
        && JSON.stringify(old.sourceMessageIds) === JSON.stringify(entry.sourceMessageIds));
      if (!duplicate) {
        if (history.length >= limits.maxSummaryEvidence) { reject(name, "SUMMARY_EVIDENCE_LIMIT", "summary"); continue; }
        mutations.watch(group, "rollingSummary");
        mutations.watch(group, "summaryEvidence");
        if (!history.some((old) => old.value === value) && !(group.rollingSummary || "").split("；").includes(value)) {
          group.rollingSummary = [group.rollingSummary, value].filter(Boolean).join("；");
        }
        if (!group.summaryEvidence) group.summaryEvidence = [];
        group.summaryEvidence.push(entry);
      }
      result.accepted.push({ path: name, type: "summary", value, context: structuredClone(provenance.context) });
    } catch { reject(name, "REDACTION_REJECTED", "summary"); }
  }
  for (const name of Object.keys(patch)) if (!ROOT_FIELDS.has(name)) reject(name, "UNSUPPORTED_FIELD");
  result.changed = mutations.changed();
  return result;
}

/**
 * Trusted management command API; NEVER pass model-generated context here.
 * context MUST be built by the authenticated admin command handler from the
 * ORIGINAL human OneBot event, not a processing-time timestamp:
 *   { callerAuthenticated: true,
 *     sourceUserId: "123456",       // positive decimal QQ ID, or safe integer
 *     sourceMessageId: "msg-id",    // one actual event ID (string/safe integer)
 *     sentAt: "2026-01-01T01:00:00.000Z" } // zoned ISO, mandatory
 * An optional conversationId must match the argument. Optional role/isBot/etc
 * are checked as transport metadata. No source arrays, receivedAt/at/time or
 * AI `explicit` flags substitute for the three required source/time fields.
 * The caller attests real-event provenance and performs the actual admin check;
 * this pure module cannot authenticate a QQ session by itself.
 *
 * -> {ok, changed, reasonCodes, field?, context?, memoryId?, status?, value?}
 * ok means recorded, not necessarily current: an older command may legitimately
 * remain superseded by a newer explicit event. Rejected correction tombstones
 * cannot be revived by this API. Existing raw arrays are never compacted.
 */
export function rememberGroupValue(group, conversationId, field, value, context, options = {}) {
  const failure = (reason) => ({ ok: false, changed: false, reasonCodes: [reason] });
  if (!container(group)) return failure("INVALID_GROUP");
  if (!record(context) || !jsonData(context) || context.callerAuthenticated !== true) return failure("CALLER_NOT_AUTHENTICATED");
  if (!record(options) || (Object.hasOwn(options, "redact") && typeof options.redact !== "function")
    || (Object.hasOwn(options, "integrity") && !recordState(options.integrity))) return failure("INVALID_OPTIONS");
  const integrity = options.integrity || {};
  if (!limitsFor(integrity)) return failure("INVALID_LIMITS");
  if (!identifier(conversationId)) return failure("INVALID_CONVERSATION_ID");
  conversationId = String(conversationId);
  if (Object.hasOwn(context, "conversationId") && context.conversationId !== conversationId) return failure("CONVERSATION_MISMATCH");
  field = GROUP_FIELDS.get(field);
  if (!field) return failure("INVALID_GROUP_FIELD");
  const sourceUserId = identifier(context.sourceUserId);
  const sourceMessageId = identifier(context.sourceMessageId);
  if (!sourceUserId || !/^[1-9]\d*$/.test(sourceUserId)) return failure("INVALID_SOURCE_USER_ID");
  if (!sourceMessageId) return failure("INVALID_SOURCE_MESSAGE_ID");
  if (Object.hasOwn(context, "senderUserId") && identifier(context.senderUserId) !== sourceUserId) return failure("CONFLICTING_SOURCE_USER_ID");
  const source = { user_id: sourceUserId, message_id: sourceMessageId, conversation_id: conversationId,
    text: "authenticated remember command", sentAt: context.sentAt };
  for (const name of ["role", "isBot", "is_bot", "isTool", "is_tool", "isSelf", "is_self"]) {
    if (Object.hasOwn(context, name)) source[name] = context[name];
  }
  const prepared = prepareMemoryEvidenceBatch([source], { conversationId });
  if (prepared.errors.length) return failure(prepared.errors[0]);
  if (!prepared.messages.length) return failure(prepared.rejected[0]?.reasonCodes[0] || "INVALID_EVENT_TIME");
  const commandContext = { subjectUserId: groupSubject(conversationId, field), conversationId,
    sourceUserId, sourceMessageIds: [sourceMessageId], sentAt: prepared.messages[0].sent_at, explicit: true };
  const redact = options.redact || defaultRedact;
  try {
    const sanitized = sanitize(value, redact);
    // Work locally until all validation and redaction have succeeded, so failed
    // commands cannot bootstrap state or modify existing correction records.
    const wrapper = structuredClone(groupWrapper(group, conversationId, field, redact));
    const matches = (wrapper.canonicalMemory?.entries || []).filter((entry) => entry.kind === "profile"
      && typeof entry.value === "string" && key(entry.value) === key(sanitized));
    if (matches.some((entry) => String(entry.subjectUserId) !== commandContext.subjectUserId)) return failure("MEMORY_SUBJECT_MISMATCH");
    if (matches.some((entry) => entry.status === "rejected"
      || (entry.correctedAt && (entry.correctionAction === "supersede" || (!entry.correctionAction && entry.status === "superseded"))))) {
      return failure("TERMINAL_CORRECTION");
    }
    ensureCanonicalMemory(wrapper, commandContext.subjectUserId, { at: commandContext.sentAt, sourceConversationId: "legacy" });
    mergeCanonicalEvidence(wrapper, { user_id: commandContext.subjectUserId,
      canonical_entries: [{ kind: "profile", value: sanitized, confidence: 1, explicit: false }] }, commandContext, integrity);
    const entry = wrapper.canonicalMemory.entries.find((item) => item.kind === "profile" && key(item.value || "") === key(sanitized));
    if (!entry || String(entry.subjectUserId) !== commandContext.subjectUserId) return failure("CANONICAL_WRITE_REJECTED");
    const slot = wrapperField(field);
    const mutations = mutationTracker();
    mutations.watch(group, slot);
    mutations.watch(group, field);
    append(wrapper, "profile", sanitized);
    append(group, field, sanitized);
    if (!Object.hasOwn(group, slot) || JSON.stringify(group[slot]) !== JSON.stringify(wrapper)) group[slot] = wrapper;
    return { ok: true, changed: mutations.changed(), reasonCodes: [], field, value: sanitized,
      context: commandContext, memoryId: entry.id, status: entry.status };
  } catch { return failure("REMEMBER_REJECTED"); }
}

export function groupMemoryValues(group, field, options = {}) {
  field = GROUP_FIELDS.get(field);
  if (!field || !container(group) || !record(options)) return [];
  const integrity = options.integrity || {};
  if (options.integrity !== undefined && !record(options.integrity)) return [];
  if (!record(integrity) || !jsonData(integrity) || !limitsFor(integrity)) return [];
  if (!storedSlot(group, field, arrayState) || !storedSlot(group, wrapperField(field), recordState)) return [];
  const wrapper = group[wrapperField(field)];
  const raw = Array.isArray(group[field]) ? group[field].filter((value) => typeof value === "string" && value.trim()) : [];
  if (!Object.hasOwn(group, wrapperField(field))) return [...new Map(raw.map((value) => [key(value), value])).values()];
  if (!record(wrapper) || !identifier(wrapper.conversationId)) return [];
  if (!canonicalShape(wrapper)) return [];
  const subject = groupSubject(wrapper.conversationId, field);
  if (wrapper.canonicalMemory?.subjectUserId !== subject) return [];
  const entries = Array.isArray(wrapper.canonicalMemory?.entries) ? wrapper.canonicalMemory.entries : [];
  const candidates = [...raw, ...(Array.isArray(wrapper.profile) ? wrapper.profile : []),
    ...entries.filter((entry) => entry?.kind === "profile").map((entry) => entry.value)];
  return legacyMemoryValues(wrapper, "profile", candidates, { ...integrity, subjectUserId: subject,
    requireEvidence: true,
    minConfidence: integrity.promptMinConfidence ?? 0.55 });
}
