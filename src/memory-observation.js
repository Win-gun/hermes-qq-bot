// Durable observations are evidence, not a bounded UI ring buffer. Prompt
// windows may be capped independently; persistence refuses unsafe size growth
// rather than evicting facts or correction tombstones behind the user's back.
export function appendMemoryValue(list, value) {
  if (!Array.isArray(list) || typeof value !== "string") return false;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 2 || list.some((item) => typeof item === "string" && item.toLowerCase() === text.toLowerCase())) return false;
  list.push(text);
  return true;
}

const epoch = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : null;
};

// Real sender/conversation IDs and original send time must be provided by the
// event boundary. Missing source IDs never create independent confirmations.
export function observeUserMessage(user, { conversationId, messageId, sentAt, name } = {}) {
  const time = epoch(sentAt);
  if (!user || time === null || !conversationId) return { changed: false, duplicate: false };
  const key = messageId ? JSON.stringify([String(conversationId), String(messageId)]) : "";
  user.observationEvidence ||= [];
  if (key && user.observationEvidence.includes(key)) return { changed: false, duplicate: true };
  if (key) user.observationEvidence.push(key);
  const last = epoch(user.lastSeenAt);
  const first = epoch(user.firstSeenAt);
  // A newly created legacy record may have a wall-clock default. The first
  // sourced observation establishes actual event time; existing seen records
  // keep their known time bounds.
  const initial = Number(user.messageCount || 0) === 0;
  user.firstSeenAt = new Date(initial || first === null ? time : Math.min(first, time)).toISOString();
  user.lastSeenAt = new Date(initial || last === null ? time : Math.max(last, time)).toISOString();
  if (name && (initial || last === null || time >= last)) user.lastName = String(name);
  user.names ||= [];
  appendMemoryValue(user.names, name);
  user.messageCount = Math.max(0, Number.isFinite(Number(user.messageCount)) ? Number(user.messageCount) : 0) + 1;
  user.updatedAt = user.lastSeenAt;
  return { changed: true, duplicate: false };
}
