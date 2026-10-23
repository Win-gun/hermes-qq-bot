// Content-free, bounded runtime diagnostics. No chat text, model reasoning,
// credentials or user-supplied error strings are retained here.
export class ExpressionDiagnostics {
  constructor(limit = 40) { this.limit = limit; this.events = []; this.counts = { turns: 0, plans: 0 }; }
  record(kind, owner, details = {}) {
    if (!Object.hasOwn(this.counts, kind)) return;
    this.counts[kind] += 1;
    const row = { kind, owner: String(owner || ""), at: Date.now() };
    for (const key of ["waitMs", "messageCount", "confirmed", "partial", "uncertain", "shadow", "fallback"])
      if (["number", "boolean"].includes(typeof details[key])) row[key] = details[key];
    if (typeof details.reason === "string" && /^[a-z0-9_-]{1,80}$/i.test(details.reason)) row.reason = details.reason;
    this.events.push(row);
    this.events = this.events.slice(-this.limit);
  }
  snapshot() { return structuredClone({ ...this.counts, recent: this.events }); }
}
