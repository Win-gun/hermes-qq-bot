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

function iso(value, fallback = new Date().toISOString()) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : fallback;
}

function sourceIds(value) {
  return Array.from(new Set(asArray(value).map(String).filter(Boolean))).slice(-16);
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
  const now = iso(at);
  const canonical = user.canonicalMemory && typeof user.canonicalMemory === "object"
    ? user.canonicalMemory
    : {};
  canonical.schemaVersion = Math.max(2, Number(canonical.schemaVersion || 0));
  canonical.subjectUserId = String(subjectUserId || canonical.subjectUserId || "");
  canonical.entries = asArray(canonical.entries).filter((entry) => entry && typeof entry === "object");
  canonical.conflicts = asArray(canonical.conflicts).filter((entry) => entry && typeof entry === "object");

  for (const [field, kind] of Object.entries(FIELD_KIND)) {
    for (const raw of asArray(canonical[field]).length ? asArray(canonical[field]) : asArray(user[field])) {
      const value = cleanText(raw, field === "notableQuotes" ? 180 : 240);
      if (!value) continue;
      const id = memoryId(canonical.subjectUserId, kind, value);
      if (canonical.entries.some((entry) => entry.id === id)) continue;
      canonical.entries.push({
        id,
        kind,
        value,
        subjectUserId: canonical.subjectUserId,
        confidence: Number(canonical.confidence || 0.45),
        status: "active",
        sourceMessageIds: [],
        evidenceConfirmations: 0,
        sourceConversationId,
        firstSeenAt: user.firstSeenAt || canonical.rebuiltAt || now,
        lastConfirmedAt: user.lastSeenAt || canonical.rebuiltAt || now,
        supersedes: "",
        conflictsWith: [],
        source: "legacy-canonical"
      });
    }
  }
  canonical.updatedAt = now;
  user.canonicalMemory = canonical;
  return canonical;
}

export function mergeCanonicalEvidence(user, update, context = {}, options = {}) {
  const subjectUserId = String(update?.user_id || update?.userId || context.subjectUserId || "");
  if (!subjectUserId) return { changed: false, added: 0, conflicts: 0 };
  const canonical = ensureCanonicalMemory(user, subjectUserId, {
    at: context.sentAt,
    sourceConversationId: context.conversationId
  });
  const allowedKinds = new Set(Object.values(FIELD_KIND));
  const minStable = Number(options.minStableConfidence ?? 0.65);
  const requireEvidence = options.requireEvidence !== false;
  const explicit = update?.explicit === true || context.explicit === true;
  const defaultConfidence = Math.max(0, Math.min(1, Number(update?.confidence ?? context.confidence ?? 0.55)));
  const incoming = [];
  for (const [field, kind] of Object.entries(FIELD_KIND)) {
    for (const raw of asArray(update?.[field] ?? update?.[field.replace(/[A-Z]/g, (x) => `_${x.toLowerCase()}`)])) {
      incoming.push({ kind, value: raw, confidence: defaultConfidence });
    }
  }
  for (const item of asArray(update?.canonical_entries || update?.canonicalEntries)) {
    if (!item || !allowedKinds.has(String(item.kind || ""))) continue;
    incoming.push({ kind: String(item.kind), value: item.value, confidence: Number(item.confidence ?? defaultConfidence), explicit: item.explicit === true });
  }

  let changed = false;
  let added = 0;
  let conflicts = 0;
  const sentAt = iso(context.sentAt);
  const messageIds = sourceIds(context.sourceMessageIds || context.messageIds);
  for (const item of incoming) {
    const value = cleanText(item.value, item.kind === "notable_quote" ? 180 : 240);
    if (!value) continue;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? defaultConfidence)));
    const id = memoryId(subjectUserId, item.kind, value);
    const existing = canonical.entries.find((entry) => entry.id === id);
    if (existing) {
      existing.lastConfirmedAt = sentAt;
      existing.sourceMessageIds = sourceIds([...asArray(existing.sourceMessageIds), ...messageIds]);
      existing.confidence = Math.max(Number(existing.confidence || 0), confidence);
      existing.evidenceConfirmations = Math.max(1, Number(existing.evidenceConfirmations || 1)) + 1;
      if ((explicit || item.explicit) && existing.status !== "active") existing.status = "active";
      else if (existing.status === "tentative" && existing.evidenceConfirmations >= 2 && existing.confidence >= minStable) existing.status = "active";
      changed = true;
      continue;
    }

    const evidenceEnough = explicit || item.explicit || (!requireEvidence && confidence >= minStable);
    const entry = {
      id,
      kind: item.kind,
      value,
      subjectUserId,
      confidence,
      status: evidenceEnough || ["meme", "core_meme", "notable_quote"].includes(item.kind) ? "active" : "tentative",
      sourceMessageIds: messageIds,
      evidenceConfirmations: 1,
      sourceConversationId: String(context.conversationId || ""),
      firstSeenAt: sentAt,
      lastConfirmedAt: sentAt,
      supersedes: "",
      conflictsWith: [],
      source: explicit || item.explicit ? "explicit" : "ai-extraction"
    };

    const conflictKey = contradictionKey(item.kind, value);
    const conflict = conflictKey ? canonical.entries.find((candidate) => (
      candidate.status !== "superseded"
      && candidate.id !== id
      && contradictionKey(candidate.kind, candidate.value) === conflictKey
      && polarity(candidate.value) !== polarity(value)
    )) : null;
    if (conflict) {
      conflicts += 1;
      entry.conflictsWith = [conflict.id];
      if (explicit || item.explicit) {
        entry.status = "active";
        entry.supersedes = conflict.id;
        conflict.status = "superseded";
      } else {
        entry.status = "disputed";
        conflict.status = "disputed";
        conflict.conflictsWith = sourceIds([...asArray(conflict.conflictsWith), entry.id]);
      }
      canonical.conflicts.push({
        at: sentAt,
        subjectUserId,
        kind: item.kind,
        entries: [conflict.id, entry.id],
        resolvedBy: entry.supersedes ? entry.id : ""
      });
    }
    canonical.entries.push(entry);
    added += 1;
    changed = true;
  }
  while (canonical.entries.length > Number(options.maxEntriesPerUser || 180)) canonical.entries.shift();
  while (canonical.conflicts.length > Number(options.maxConflictsPerUser || 40)) canonical.conflicts.shift();
  canonical.updatedAt = sentAt;
  return { changed, added, conflicts };
}

export function applyCanonicalCorrections(user, corrections, context = {}) {
  const canonical = ensureCanonicalMemory(user, context.subjectUserId || "", { at: context.sentAt, sourceConversationId: context.conversationId });
  const byId = new Map(canonical.entries.map((entry) => [entry.id, entry]));
  let changed = false;
  for (const correction of asArray(corrections)) {
    if (!correction || typeof correction !== "object") continue;
    const target = byId.get(String(correction.memory_id || correction.memoryId || ""));
    if (!target) continue;
    const action = String(correction.action || "supersede");
    if (action === "reject") target.status = "rejected";
    else if (action === "tentative") target.status = "tentative";
    else target.status = "superseded";
    target.correctedAt = iso(context.sentAt);
    target.correctionReason = cleanText(correction.reason, 180);
    changed = true;
  }
  return changed;
}

export function canonicalPromptLines(user, options = {}) {
  const canonical = ensureCanonicalMemory(user, options.subjectUserId || canonicalSubject(user), {});
  const minConfidence = Number(options.minConfidence ?? 0.55);
  const grouped = new Map();
  for (const entry of canonical.entries) {
    if (entry.status !== "active" || Number(entry.confidence || 0) < minConfidence) continue;
    const field = KIND_FIELD[entry.kind] || entry.kind;
    if (!grouped.has(field)) grouped.set(field, []);
    grouped.get(field).push(entry.value);
  }
  return Array.from(grouped.entries()).map(([field, values]) => `${field}:${values.slice(-5).join("、")}`);
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
      const canonical = ensureCanonicalMemory(user, userId, { sourceConversationId: groupId });
      users += 1;
      summary.users += 1;
      for (const entry of canonical.entries) {
        entries += 1;
        summary.entries += 1;
        if (entry.status === "tentative") { tentative += 1; summary.tentative += 1; }
        if (entry.status === "disputed") { disputed += 1; summary.disputed += 1; }
        if (String(entry.subjectUserId) !== String(userId)) { invalidSubject += 1; summary.invalidSubject += 1; }
        if (!asArray(entry.sourceMessageIds).length && entry.source !== "legacy-canonical") { withoutEvidence += 1; summary.withoutEvidence += 1; }
      }
    }
    groups[groupId] = summary;
  }
  return {
    ok: invalidSubject === 0,
    generatedAt: new Date().toISOString(),
    minStableConfidence: Number(options.minStableConfidence ?? 0.65),
    totals: { groups: Object.keys(groups).length, users, entries, tentative, disputed, invalidSubject, withoutEvidence },
    groups
  };
}

export const canonicalMemoryFields = Object.freeze({ ...FIELD_KIND });
