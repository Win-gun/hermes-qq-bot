import { createHash } from "node:crypto";

const FIELD_KIND = {
  aliases: "alias",
  profile: "profile",
  personality: "personality",
  preferences: "preference",
  boundaries: "boundary",
  coreMemes: "core_meme",
  memes: "meme",
  style: "style",
  relationships: "relationship",
  interactionTips: "interaction_tip",
  notableQuotes: "notable_quote"
};

const KIND_FIELD = Object.fromEntries(Object.entries(FIELD_KIND).map(([field, kind]) => [kind, field]));
const snakeField = (field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const FIELD_NAMES = new Map(Object.entries(FIELD_KIND).flatMap(([field, kind]) => (
  [field, snakeField(field), kind].map((name) => [name, field])
)));

function legacyFieldValues(record, field) {
  const snake = snakeField(field);
  return [...asArray(record?.[field]), ...(snake !== field ? asArray(record?.[snake]) : [])];
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function cleanText(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizedKey(value) {
  return cleanText(value, 500)
    .toLowerCase()
    .replace(/[，。！？!?、；;：:\s"'“”‘’（）()\[\]【】]/g, "");
}

function memoryId(subjectUserId, kind, value) {
  return `mem_${createHash("sha256").update(`${subjectUserId}|${kind}|${normalizedKey(value)}`).digest("hex").slice(0, 16)}`;
}

function timestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : null;
}

function iso(value, fallback = new Date().toISOString()) {
  const time = timestamp(value);
  return time === null ? fallback : new Date(time).toISOString();
}

function latest(...values) {
  const times = values.map(timestamp).filter((time) => time !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : "";
}

function sourceIds(value) {
  return Array.from(new Set(asArray(value)
    .filter((item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))
    .map((item) => String(item).trim()).filter(Boolean)));
}

function sourceTime(context, id, ids) {
  if (Object.hasOwn(context, "sourceMessageTimes")) {
    const times = context.sourceMessageTimes;
    const at = times && typeof times === "object" && !Array.isArray(times) && Object.hasOwn(times, id)
      ? timestamp(times[id]) : null;
    return at !== null && at <= timestamp(context.sentAt) ? at : null;
  }
  // Old direct callers may describe ONE event without a time map. A batch's
  // maximum timestamp cannot prove that every referenced event is new.
  return ids.length === 1 ? timestamp(context.sentAt) : null;
}

function confidenceValue(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function subjectMatches(object, subjectUserId, keys = ["user_id", "userId", "subjectUserId"]) {
  return keys.every((key) => object?.[key] === undefined || object[key] === null || String(object[key]) === subjectUserId);
}

function entryBelongs(entry, subjectUserId) {
  return entry && String(entry.subjectUserId || "") === subjectUserId;
}

function evidenceKeys(entry) {
  if (Array.isArray(entry.evidenceKeys)) return sourceIds(entry.evidenceKeys);
  const conversationId = String(entry.sourceConversationId || "");
  return conversationId && conversationId !== "legacy"
    ? sourceIds(entry.sourceMessageIds).map((id) => JSON.stringify([conversationId, id]))
    : [];
}

function contradictionKey(kind, value) {
  if (!["preference", "boundary", "profile", "personality"].includes(kind)) return "";
  const text = normalizedKey(value)
    .replace(/^(我|本人|他|她|ta)/, "")
    .replace(/^(不喜欢|讨厌|不爱|喜欢|爱好|偏好|不是|是)/, "");
  return text.length >= 2 ? `${kind}:${text}` : "";
}

function polarity(value) {
  return /不喜欢|讨厌|不爱|不是|拒绝|雷点|避免/.test(String(value || "")) ? -1 : 1;
}

export function ensureCanonicalMemory(user, subjectUserId, { at = "", sourceConversationId = "legacy" } = {}) {
  const canonical = user.canonicalMemory && typeof user.canonicalMemory === "object"
    ? user.canonicalMemory
    : {};
  const subject = String(subjectUserId || canonical.subjectUserId || "");
  // Never rebind an existing record to a different (or unknown) QQ user.
  if (!subject || (canonical.subjectUserId && String(canonical.subjectUserId) !== subject)) return canonical;
  const now = iso(at);
  canonical.schemaVersion = Math.max(3, Number(canonical.schemaVersion) || 0);
  canonical.subjectUserId = subject;
  canonical.entries = asArray(canonical.entries).filter((entry) => entry && typeof entry === "object");
  canonical.conflicts = asArray(canonical.conflicts).filter((entry) => entry && typeof entry === "object");

  // Bootstrap once, BEFORE the caller writes compatibility mirrors. Later raw
  // arrays are not independent evidence. Existing entries/tombstones always win.
  if (canonical.legacyImported !== true) {
    // Missing the old marker is not proof that a populated canonical store is
    // uninitialized. Never turn later compatibility mirrors into new evidence.
    if (!canonical.entries.length && !canonical.conflicts.length) for (const [field, kind] of Object.entries(FIELD_KIND)) {
      for (const raw of [...legacyFieldValues(canonical, field), ...legacyFieldValues(user, field)]) {
        const value = cleanText(raw, field === "notableQuotes" ? 180 : 240);
        if (!value) continue;
        const id = memoryId(subject, kind, value);
        if (canonical.entries.some((entry) => entry.id === id)) continue;
        canonical.entries.push({
          id,
          kind,
          value,
          subjectUserId: subject,
          confidence: confidenceValue(canonical.confidence) ?? 0.45,
          status: "active",
          sourceMessageIds: [],
          evidenceKeys: [],
          evidenceConfirmations: 0,
          sourceConversationId,
          // Import/rebuild time is not an event time or a confirmation. Keep
          // unknown legacy chronology visibly unknown instead of making it new.
          firstSeenAt: timestamp(user.firstSeenAt) === null ? "" : iso(user.firstSeenAt),
          lastConfirmedAt: timestamp(user.lastSeenAt) === null ? "" : iso(user.lastSeenAt),
          supersedes: "",
          conflictsWith: [],
          source: "legacy-canonical"
        });
      }
    }
    canonical.legacyImported = true;
    canonical.updatedAt = latest(canonical.updatedAt, now);
  }
  user.canonicalMemory = canonical;
  return canonical;
}

function terminalCorrection(entry) {
  return entry.status === "rejected"
    || (entry.correctedAt && ["reject", "supersede"].includes(entry.correctionAction || (entry.status === "superseded" ? "supersede" : "")));
}

function tentativeCorrectionFloor(entry) {
  return entry.correctionAction === "tentative" ? timestamp(entry.correctedAt) : null;
}

function currentExplicit(entry, field = "explicitAt") {
  const value = timestamp(entry[field]), floor = tentativeCorrectionFloor(entry);
  return value !== null && (floor === null || (value > floor && sourceIds(entry.postCorrectionEvidenceKeys).length > 0));
}

function confirmationConfidence(entry) {
  return confidenceValue(tentativeCorrectionFloor(entry) === null ? entry.confidence : entry.postCorrectionConfidence) ?? 0;
}

function baseStatus(entry, minStable, requireEvidence) {
  if (currentExplicit(entry) || currentExplicit(entry, "selfExplicitAt")) return "active";
  const corrected = tentativeCorrectionFloor(entry) !== null;
  if (!corrected && entry.source === "legacy-canonical" && !evidenceKeys(entry).length) return "active";
  const confirmations = corrected ? sourceIds(entry.postCorrectionEvidenceKeys).length : entry.evidenceConfirmations;
  const confidence = confirmationConfidence(entry);
  if (confirmations >= 2 && confidence >= minStable) return "active";
  if (confirmations > 0 && ((!requireEvidence && confidence >= minStable)
    || ["meme", "core_meme", "notable_quote"].includes(entry.kind))) return "active";
  return "tentative";
}

function correctionReadable(entry, options) {
  return tentativeCorrectionFloor(entry) === null
    || baseStatus(entry, confidenceValue(options.minStableConfidence) ?? 0.65, options.requireEvidence !== false) === "active";
}

function resolveConflicts(canonical, subjectUserId, key, minStable, requireEvidence) {
  if (!key) return 0;
  const members = canonical.entries.filter((entry) => entryBelongs(entry, subjectUserId)
    && contradictionKey(entry.kind, entry.value) === key && !terminalCorrection(entry));
  if (!members.some((a) => members.some((b) => polarity(a.value) !== polarity(b.value)))) return 0;
  const explicit = members.filter((entry) => currentExplicit(entry));
  const newestAt = latest(...explicit.map((entry) => entry.explicitAt));
  const newest = explicit.filter((entry) => entry.explicitAt === newestAt);
  // Equal-time contradictory commands are ambiguous: fail closed, not arrival-wins.
  const winner = newest.length && new Set(newest.map((entry) => polarity(entry.value))).size === 1
    ? newest.sort((a, b) => a.id.localeCompare(b.id))[0] : null;
  for (const entry of members) {
    entry.conflictsWith = sourceIds([...asArray(entry.conflictsWith), ...members
      .filter((other) => polarity(other.value) !== polarity(entry.value)).map((other) => other.id)]);
    if (winner) {
      entry.status = polarity(entry.value) === polarity(winner.value) ? baseStatus(entry, minStable, requireEvidence) : "superseded";
      if (entry.status === "superseded") entry.supersededAt = latest(entry.supersededAt, winner.explicitAt);
      entry.supersedes = entry === winner ? entry.conflictsWith[0] || "" : "";
    } else {
      entry.status = "disputed";
      entry.supersedes = "";
    }
  }
  let added = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (const other of members.slice(i + 1)) {
      const entry = members[i];
      if (polarity(entry.value) === polarity(other.value)) continue;
      const ids = [entry.id, other.id].sort();
      const resolvedBy = winner?.id || "";
      const at = winner?.explicitAt || latest(entry.lastConfirmedAt, other.lastConfirmedAt);
      if (canonical.conflicts.some((conflict) => conflict.at === at && conflict.resolvedBy === resolvedBy
        && JSON.stringify(asArray(conflict.entries).slice().sort()) === JSON.stringify(ids))) continue;
      canonical.conflicts.push({ at, subjectUserId, kind: entry.kind, entries: ids, resolvedBy });
      added += 1;
    }
  }
  return added;
}

export function mergeCanonicalEvidence(user, update, context = {}, options = {}) {
  const subjectUserId = String(update?.user_id || update?.userId || context.subjectUserId || "");
  if (!subjectUserId || !subjectMatches(update, subjectUserId) || !subjectMatches(context, subjectUserId, ["subjectUserId"])
    || (canonicalSubject(user) && canonicalSubject(user) !== subjectUserId)) return { changed: false, added: 0, conflicts: 0 };
  const before = JSON.stringify(user.canonicalMemory);
  const validTime = timestamp(context.sentAt) !== null;
  if (!validTime) return { changed: false, added: 0, conflicts: 0 };
  const canonical = ensureCanonicalMemory(user, subjectUserId, {
    at: validTime ? context.sentAt : user.canonicalMemory?.updatedAt || "1970-01-01T00:00:00.000Z",
    sourceConversationId: context.conversationId
  });
  const allowedKinds = new Set(Object.values(FIELD_KIND));
  const minStable = confidenceValue(options.minStableConfidence) ?? 0.65;
  const requireEvidence = options.requireEvidence !== false;
  // context.explicit is reserved for caller-authenticated commands. AI-supplied
  // explicit flags can confirm an uncontested self statement, never a correction.
  const explicit = context.explicit === true && validTime;
  const defaultConfidence = update?.confidence !== undefined ? update.confidence
    : context.confidence !== undefined ? context.confidence : 0.55;
  const incoming = [];
  for (const [field, kind] of Object.entries(FIELD_KIND)) {
    for (const raw of asArray(update?.[field] ?? update?.[snakeField(field)])) {
      incoming.push({ kind, value: raw, confidence: defaultConfidence });
    }
  }
  for (const item of asArray(update?.canonical_entries || update?.canonicalEntries)) {
    if (!item || !allowedKinds.has(String(item.kind || "")) || !subjectMatches(item, subjectUserId)) continue;
    incoming.push({ kind: String(item.kind), value: item.value, confidence: item.confidence !== undefined ? item.confidence : defaultConfidence, explicit: item.explicit === true });
  }

  let added = 0;
  let conflicts = 0;
  const sentAt = iso(context.sentAt, canonical.updatedAt || "1970-01-01T00:00:00.000Z");
  const messageIds = sourceIds(context.sourceMessageIds || context.messageIds);
  const conversationId = String(context.conversationId || "");
  const keys = conversationId ? messageIds.map((id) => JSON.stringify([conversationId, id])) : [];
  const keyTimes = new Map(messageIds.map(id => [JSON.stringify([conversationId, id]), sourceTime(context, id, messageIds)]));
  let firstSourceAt = timestamp(sentAt);
  for (const time of keyTimes.values()) if (time !== null) firstSourceAt = Math.min(firstSourceAt, time);
  const sourceUserId = String(context.sourceUserId || context.senderUserId || "");
  const selfSource = sourceUserId === subjectUserId
    && subjectMatches(context, subjectUserId, ["sourceUserId", "senderUserId"]);
  const touched = new Set();
  const unique = new Map();
  for (const item of incoming) {
    const value = cleanText(item.value, item.kind === "notable_quote" ? 180 : 240);
    if (!value) continue;
    const confidence = confidenceValue(item.confidence);
    if (confidence === null) continue;
    const id = memoryId(subjectUserId, item.kind, value);
    const previous = unique.get(id);
    unique.set(id, {
      ...item, value, confidence: Math.max(previous?.confidence ?? 0, confidence),
      explicit: item.explicit || previous?.explicit
    });
  }
  for (const [id, item] of unique) {
    const { value, confidence } = item;
    let entry = canonical.entries.find((candidate) => candidate.id === id);
    if (entry && (!entryBelongs(entry, subjectUserId) || terminalCorrection(entry))) continue;
    const fresh = !entry;
    if (!entry) {
      entry = {
        id,
        kind: item.kind,
        value,
        subjectUserId,
        confidence,
        status: "tentative",
        sourceMessageIds: [],
        evidenceKeys: [],
        evidenceConfirmations: 0,
        sourceConversationId: conversationId,
        firstSeenAt: sentAt,
        lastConfirmedAt: sentAt,
        supersedes: "",
        conflictsWith: [],
        source: "ai-extraction"
      };
      canonical.entries.push(entry);
      added += 1;
    }
    const previousKeys = evidenceKeys(entry);
    const newKeys = keys.filter((key) => !previousKeys.includes(key));
    const correctionFloor = tentativeCorrectionFloor(entry);
    const postCorrectionKeys = correctionFloor === null ? [] : newKeys.filter(key => {
      const time = keyTimes.get(key);
      return time !== null && time !== undefined && time > correctionFloor;
    });
    const afterCorrection = postCorrectionKeys.length > 0;
    const explicitKeys = sourceIds(entry.explicitEvidenceKeys);
    const freshExplicitKeys = keys.filter((key) => !explicitKeys.includes(key));
    const supersededFloor = timestamp(entry.supersededAt || entry.lastConfirmedAt) ?? -Infinity;
    // Replaying a message with a new invocation time is not a newer event.
    const newExplicit = explicit && (freshExplicitKeys.length > 0 || (!keys.length && timestamp(sentAt) > (timestamp(entry.explicitAt) ?? -Infinity)))
      && (correctionFloor === null || (afterCorrection && newKeys.length > 0))
      && (entry.status !== "superseded" || (keys.length > 0 && timestamp(sentAt) > supersededFloor));
    if (explicit && freshExplicitKeys.length) entry.explicitEvidenceKeys = sourceIds([...explicitKeys, ...freshExplicitKeys]);
    entry.evidenceKeys = sourceIds([...previousKeys, ...newKeys]);
    entry.evidenceConfirmations = entry.evidenceKeys.length;
    if (afterCorrection && newKeys.length) {
      entry.postCorrectionEvidenceKeys = sourceIds([...sourceIds(entry.postCorrectionEvidenceKeys), ...postCorrectionKeys]);
      entry.postCorrectionConfidence = Math.max(confidenceValue(entry.postCorrectionConfidence) ?? 0, confidence);
    }
    if (entry.status === "active") entry.status = baseStatus(entry, minStable, requireEvidence);
    if (fresh || newKeys.length || newExplicit) {
      entry.sourceMessageIds = sourceIds([...asArray(entry.sourceMessageIds), ...messageIds]);
      entry.firstSeenAt = iso(Math.min(timestamp(entry.firstSeenAt) ?? Infinity, firstSourceAt));
      entry.lastConfirmedAt = latest(entry.lastConfirmedAt, sentAt);
      entry.confidence = Math.max(confidenceValue(entry.confidence) ?? 0, confidence);
      if (newKeys.length && validTime && selfSource && (item.explicit || update?.explicit === true)) {
        entry.selfExplicitAt = latest(entry.selfExplicitAt, sentAt);
      }
      if (newExplicit) {
        entry.explicitAt = latest(entry.explicitAt, sentAt);
        entry.source = "explicit";
      } else if (newKeys.length && entry.source === "legacy-canonical") {
        entry.source = "ai-extraction";
      }
      // Superseded values need a genuinely newer trusted command to return.
      if (entry.status !== "superseded" || newExplicit) {
        entry.status = baseStatus(entry, minStable, requireEvidence);
      }
      touched.add(contradictionKey(item.kind, value));
    }
  }
  for (const key of touched) conflicts += resolveConflicts(canonical, subjectUserId, key, minStable, requireEvidence);
  // Durable evidence and tombstones are never FIFO-evicted. Prompt limits are
  // presentation-only; capacity archival requires a separate explicit workflow.
  const changed = JSON.stringify(canonical) !== before;
  if (changed) canonical.updatedAt = latest(canonical.updatedAt, sentAt);
  return { changed, added, conflicts };
}

export function applyCanonicalCorrections(user, corrections, context = {}) {
  // This ID-targeted API is caller-authorized (unlike AI explicit hints).
  // A known subject and a valid event timestamp are intentionally mandatory.
  const subject = String(context.subjectUserId || "");
  if (!subject || (canonicalSubject(user) && canonicalSubject(user) !== subject) || timestamp(context.sentAt) === null) return false;
  const canonical = ensureCanonicalMemory(user, subject, { at: context.sentAt, sourceConversationId: context.conversationId });
  const byId = new Map(canonical.entries.filter((entry) => entryBelongs(entry, subject)).map((entry) => [entry.id, entry]));
  let changed = false;
  for (const correction of asArray(corrections)) {
    if (!correction || typeof correction !== "object" || !subjectMatches(correction, subject)) continue;
    const target = byId.get(String(correction.memory_id || correction.memoryId || ""));
    if (!target) continue;
    const action = String(correction.action || "supersede");
    if (!["reject", "tentative", "supersede"].includes(action) || terminalCorrection(target)) continue;
    const correctionKeys = context.conversationId ? sourceIds(context.sourceMessageIds)
      .map(id => JSON.stringify([String(context.conversationId), id])) : [];
    if (correctionKeys.some(key => sourceIds(target.correctionEvidenceKeys).includes(key))
      || (target.correctedAt === iso(context.sentAt) && target.correctionAction === action)) continue;
    // Newer AI observations must not veto a valid human correction. Compare
    // trusted event times, not extraction arrival/last-observation timestamps.
    if (timestamp(context.sentAt) < Math.max(timestamp(target.explicitAt) ?? -Infinity,
      timestamp(target.supersededAt) ?? -Infinity, timestamp(target.correctedAt) ?? -Infinity)) continue;
    if (action === "reject") target.status = "rejected";
    else if (action === "tentative") target.status = "tentative";
    else target.status = "superseded";
    target.correctedAt = iso(context.sentAt);
    target.correctionAction = action;
    if (correctionKeys.length) target.correctionEvidenceKeys = sourceIds([...sourceIds(target.correctionEvidenceKeys), ...correctionKeys]);
    if (action === "tentative") {
      target.postCorrectionEvidenceKeys = [];
      target.postCorrectionConfidence = 0;
    }
    target.correctionReason = cleanText(correction.reason, 180);
    if (sourceIds(context.sourceMessageIds).length) {
      target.correctionSourceMessageIds = sourceIds(context.sourceMessageIds);
      target.correctionConversationId = String(context.conversationId || "");
      target.correctedBy = String(context.actorUserId || subject);
    }
    changed = true;
  }
  if (changed) canonical.updatedAt = latest(canonical.updatedAt, context.sentAt);
  return changed;
}

function readCanonical(user, subjectUserId) {
  // Reads may synthesize a legacy view, but must not upgrade or timestamp the
  // live object (including legacy arrays and correction state).
  return ensureCanonicalMemory(structuredClone(user || {}), subjectUserId, { at: "1970-01-01T00:00:00.000Z" });
}

// Read-only, per-value compatibility projection. Candidates are NOT evidence:
// genuine imported legacy values may stay usable at .45 without promotion;
// standard entries still need active status and the usual prompt confidence.
// A known subject (options or canonical root) is required. Camel/snake fields
// and canonical kind names are accepted. Omitted values use the stored arrays.
export function legacyMemoryValues(user, field, values, options = {}) {
  const canonicalField = FIELD_NAMES.get(field);
  const subject = String(options.subjectUserId ?? canonicalSubject(user));
  if (!canonicalField || !subject || !subjectMatches(user, subject)
    || (canonicalSubject(user) && canonicalSubject(user) !== subject)) return [];
  const stored = user?.canonicalMemory;
  // Before the first bootstrap, synthesize only existing raw values on a clone.
  // Once canonical entries or the bootstrap marker exist, absent IDs are new
  // mirrors/unknowns and must not be re-imported by a read.
  const canonical = stored?.legacyImported !== true && !asArray(stored?.entries).length && !asArray(stored?.conflicts).length
    ? readCanonical(user, subject) : stored;
  const entries = asArray(canonical?.entries);
  const kind = FIELD_KIND[canonicalField];
  const minConfidence = confidenceValue(options.minConfidence ?? options.promptMinConfidence) ?? 0.55;
  const candidates = values === undefined
    ? [...legacyFieldValues(stored, canonicalField), ...legacyFieldValues(user, canonicalField)] : asArray(values);
  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    const value = cleanText(raw, kind === "notable_quote" ? 180 : 240);
    if (!value) continue;
    const id = memoryId(subject, kind, value);
    if (seen.has(id)) continue;
    seen.add(id);
    const matches = entries.filter((entry) => entry?.id === id
      || (entry?.kind === kind && normalizedKey(entry.value) === normalizedKey(value)));
    if (!matches.length || matches.some((entry) => {
      const confidence = confidenceValue(entry.confidence);
      const compatibilityOnly = entry.source === "legacy-canonical" && !evidenceKeys(entry).length
        && Number(entry.evidenceConfirmations || 0) === 0 && !entry.correctedAt && !entry.explicitAt && !entry.selfExplicitAt;
      return !entryBelongs(entry, subject) || entry.kind !== kind || entry.status !== "active"
        || terminalCorrection(entry) || !correctionReadable(entry, options) || confidence === null
        || (!compatibilityOnly && confirmationConfidence(entry) < minConfidence);
    })) continue;
    const key = contradictionKey(kind, value);
    if (key && entries.some((entry) => entryBelongs(entry, subject) && !terminalCorrection(entry)
      && ["active", "tentative", "disputed"].includes(entry.status)
      && contradictionKey(entry.kind, entry.value) === key && polarity(entry.value) !== polarity(value))) continue;
    result.push(value);
  }
  return result;
}

// A conservative whole-user fallback gate for callers rendering legacy arrays.
// Low-confidence legacy-only snapshots remain usable; standard evidence,
// corrections, foreign subjects or newly added mirrors cannot bypass filtering.
export function legacyMemoryFallbackAllowed(user, options = {}) {
  const subject = String(options.subjectUserId || canonicalSubject(user));
  if (canonicalSubject(user) && subject !== canonicalSubject(user)) return false;
  const canonical = user?.canonicalMemory;
  if (!canonical || typeof canonical !== "object") return true;
  if (asArray(canonical.conflicts).length) return false;
  const entries = asArray(canonical.entries);
  if (entries.some((entry) => !entryBelongs(entry, subject) || entry.status !== "active"
    || entry.correctedAt || entry.source !== "legacy-canonical" || evidenceKeys(entry).length
    || confidenceValue(entry.confidence) === null)) return false;
  if (entries.some((entry) => entries.some((other) => contradictionKey(entry.kind, entry.value)
    && contradictionKey(entry.kind, entry.value) === contradictionKey(other.kind, other.value)
    && polarity(entry.value) !== polarity(other.value)))) return false;
  if (canonical.legacyImported === true || entries.length) {
    for (const [field, kind] of Object.entries(FIELD_KIND)) {
      for (const raw of [...legacyFieldValues(canonical, field), ...legacyFieldValues(user, field)]) {
        if (!cleanText(raw)) continue;
        if (!entries.some((entry) => entry.id === memoryId(subject, kind, cleanText(raw, kind === "notable_quote" ? 180 : 240)))) return false;
      }
    }
  }
  return true;
}

// Shared read gate for prompt and explicit memory-detail consumers. Returned
// entries belong to a detached read view, never the live evidence store.
export function canonicalActiveEntries(user, options = {}) {
  const subject = String(options.subjectUserId || canonicalSubject(user));
  if (!subject || (canonicalSubject(user) && canonicalSubject(user) !== subject)) return [];
  const canonical = readCanonical(user, subject);
  const minConfidence = confidenceValue(options.minConfidence) ?? 0.55;
  return asArray(canonical.entries).filter(entry => entryBelongs(entry, subject) && entry.status === "active"
    && !terminalCorrection(entry) && correctionReadable(entry, options) && confidenceValue(entry.confidence) !== null
    && confirmationConfidence(entry) >= minConfidence).map(entry => ({ ...entry, confidence: confirmationConfidence(entry) }));
}

export function canonicalPromptLines(user, options = {}) {
  const limit = Number.isInteger(options.maxItemsPerField) && options.maxItemsPerField >= 0 ? options.maxItemsPerField : 5;
  const grouped = new Map();
  for (const entry of canonicalActiveEntries(user, options)) {
    const field = KIND_FIELD[entry.kind] || entry.kind;
    if (!grouped.has(field)) grouped.set(field, []);
    grouped.get(field).push(entry.value);
  }
  return limit ? Array.from(grouped.entries()).map(([field, values]) => `${field}:${values.slice(-limit).join("、")}`) : [];
}

function canonicalSubject(user) {
  return String(user?.canonicalMemory?.subjectUserId || "");
}

export function memoryIntegrityReport(memory, options = {}) {
  const groups = {};
  let users = 0;
  let entries = 0;
  let tentative = 0;
  let disputed = 0;
  let invalidSubject = 0;
  let withoutEvidence = 0;
  for (const [groupId, group] of Object.entries(memory?.groups || {})) {
    const summary = { users: 0, entries: 0, tentative: 0, disputed: 0, invalidSubject: 0, withoutEvidence: 0 };
    for (const [userId, user] of Object.entries(group?.users || {})) {
      const canonical = readCanonical(user, userId);
      users += 1;
      summary.users += 1;
      if (canonical.subjectUserId && String(canonical.subjectUserId) !== String(userId)) {
        invalidSubject += 1;
        summary.invalidSubject += 1;
      }
      for (const entry of asArray(canonical.entries)) {
        entries += 1;
        summary.entries += 1;
        if (entry.status === "tentative") { tentative += 1; summary.tentative += 1; }
        if (entry.status === "disputed") { disputed += 1; summary.disputed += 1; }
        if (String(entry.subjectUserId) !== String(userId)) { invalidSubject += 1; summary.invalidSubject += 1; }
        if (!evidenceKeys(entry).length && entry.source !== "legacy-canonical") { withoutEvidence += 1; summary.withoutEvidence += 1; }
      }
    }
    groups[groupId] = summary;
  }
  return {
    ok: invalidSubject === 0,
    generatedAt: new Date().toISOString(),
    minStableConfidence: confidenceValue(options.minStableConfidence) ?? 0.65,
    totals: { groups: Object.keys(groups).length, users, entries, tentative, disputed, invalidSubject, withoutEvidence },
    groups
  };
}

export const canonicalMemoryFields = Object.freeze({ ...FIELD_KIND });
