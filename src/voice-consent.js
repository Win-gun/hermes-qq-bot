import { randomBytes, timingSafeEqual } from "node:crypto";

/** Ephemeral, one-use consent for cloning only the sender's own quoted QQ voice. */
export class OneShotVoiceConsent {
  constructor({ ttlMs = 120_000, maxPending = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.pending = new Map();
  }

  key(conversationId, senderId) {
    return `${conversationId}:${senderId}`;
  }

  request({ conversationId, senderId, accountId, ref, speech, now = Date.now() }) {
    if (!conversationId || !senderId || !accountId || ref?.source !== "quoted" || ref.senderId !== senderId
      || typeof speech !== "string" || !speech.trim() || speech.length > 200) {
      throw new Error("Voice clone requires the speaker's own quoted voice and short text");
    }
    for (const [key, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(key);
    if (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value);
    const code = randomBytes(4).toString("hex").toUpperCase();
    this.pending.set(this.key(conversationId, senderId), {
      code, ref, speech: speech.trim(), accountId, expiresAt: now + this.ttlMs
    });
    return code;
  }

  confirm({ conversationId, senderId, accountId, code, now = Date.now() }) {
    const key = this.key(conversationId, senderId);
    const item = this.pending.get(key);
    this.pending.delete(key); // One attempt, regardless of outcome.
    if (!item || item.expiresAt <= now || item.accountId !== accountId || !/^[A-F0-9]{8}$/i.test(code || "")) return null;
    if (!timingSafeEqual(Buffer.from(item.code), Buffer.from(code.toUpperCase()))) return null;
    if (item.ref?.source !== "quoted" || item.ref.senderId !== senderId) return null;
    return { ref: item.ref, speech: item.speech };
  }
}
