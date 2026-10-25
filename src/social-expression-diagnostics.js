// Content-free, bounded runtime diagnostics. No chat text, model reasoning,
// credentials or user-supplied error strings are retained here.
const REASONS = new Set(["empty", "command", "explicit-immediate", "max-turn", "other-recipient", "topic-ended",
  "incomplete", "addressed", "ordinary", "interrupted", "separated", "consecutive", "complete",
  "interest-member", "interest-photo", "interest-topic", "interest-reply", "reply", "observe", "wait", "dive", "shadow",
  "concise", "balanced", "AFFECT_MATCH", "USAGE_MATCH", "TOPIC_MATCH", "VISUAL_MATCH", "LITERAL_MATCH",
  "TOPIC_MISMATCH_PENALTY", "ACK_REPEAT_PENALTY"]);
export class ExpressionDiagnostics {
  constructor(limit = 40) { this.limit = limit; this.events = []; this.counts = { turns: 0, plans: 0, watches: 0, decisions: 0, selections: 0, styles: 0 }; }
  record(kind, owner, details = {}) {
    if (!Object.hasOwn(this.counts, kind)) return;
    this.counts[kind] += 1;
    const row = { kind, owner: String(owner || ""), at: Date.now() };
    for (const key of ["waitMs", "messageCount", "confirmed", "partial", "uncertain", "shadow", "fallback", "score"])
      if (typeof details[key] === "boolean" || typeof details[key] === "number" && Number.isFinite(details[key])
        && Math.abs(details[key]) <= 86400000) row[key] = details[key];
    if (REASONS.has(details.reason)) row.reason = details.reason;
    this.events.push(row);
    this.events = this.events.slice(-this.limit);
  }
  snapshot() { return structuredClone({ ...this.counts, recent: this.events }); }
}
