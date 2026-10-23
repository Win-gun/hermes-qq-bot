import { validateReplyPlan } from "./reply-plan.js";

// No queue, network, model, random source or storage. The only timer is the
// replaceable inter-message sleep. A wire adapter must supply its own ACK timeout.
const wait = (ms, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("REPLY_CANCELLED")); return; }
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("REPLY_CANCELLED")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
});
const denied = result => result === false || result?.ok === false;
const messageId = value => {
  if (Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value) ? value : null;
};
// Only this unambiguous no-wire result enables fallback. A mixed skipped/ACK
// result is unknown, not proof that nothing was sent. Never copy host bytes.
const skipped = ack => ack !== null && typeof ack === "object" && !Array.isArray(ack)
  && [Object.prototype, null].includes(Object.getPrototypeOf(ack))
  && Object.keys(ack).length === 1 && Object.hasOwn(ack, "skipped") && ack.skipped === true;

/** Execute ONE host-validated plan ONCE. Never retry the whole result, including
 * sent=0 + uncertain=true. beforeEach owns identity/quiet/revision/quote authority
 * at the wire boundary; sendText/sendSticker must guard internal pre-wire awaits.
 * Quote provenance was validated by parseReplyPlan, not this shape check.
 * Cancellation during send still collects that attempt's ACK and persists it.
 * Receipt persistence runs even after abort; failure stops all remaining sends.
 * sent counts confirmed wire ACKs (not durable receipts); uncertain also covers
 * unknown receipt durability. partial means some, but not all, messages ACKed. */
export async function executeReplyPlan(plan, { sendText, sendSticker, allowedStickerIds = [], beforeEach, onReceipt, signal,
  sleep = wait, minIntervalMs = 800, maxIntervalMs = 2000 } = {}) {
  if (![sendText, beforeEach, onReceipt, sleep].every(fn => typeof fn === "function")) throw new TypeError("INVALID_REPLY_ADAPTER");
  if (![minIntervalMs, maxIntervalMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 60000)
    || minIntervalMs > maxIntervalMs) throw new TypeError("INVALID_REPLY_INTERVAL");
  // Copy before any await, so host/model mutations cannot change later messages.
  const ready = validateReplyPlan(plan, { maxMessages: 4, direct: false,
    allowedStickerIds,
    allowedQuoteIds: plan?.replyToMessageId == null ? [] : [plan.replyToMessageId] });
  if (ready.messages.some(item => item.type === "sticker") && typeof sendSticker !== "function") throw new TypeError("INVALID_REPLY_ADAPTER");
  const receipts = [];
  let sent = 0, uncertain = false;
  const cancelled = () => signal?.aborted === true;
  async function pause(index) {
    // Deterministic reading rhythm, not a per-character typewriter. Short
    // exchanges use the minimum; a longer adjacent semantic bubble approaches
    // the configured maximum. The shared group wire gate may add more delay.
    const length = Math.max([...(receipts.at(-1)?.content || "")].length,
      [...(ready.messages[index]?.content || "")].length);
    const ratio = Math.min(1, Math.max(0, length - 32) / 208);
    const waitMs = minIntervalMs + Math.round((maxIntervalMs - minIntervalMs) * ratio);
    if (!waitMs) return;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new Error("REPLY_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([Promise.resolve().then(() => { if (cancelled()) throw new Error("REPLY_CANCELLED");
      return sleep(waitMs, { signal }); }), interrupted]); }
    finally { signal?.removeEventListener("abort", abort); }
  }
  if (ready.action === "reply") for (let index = 0; index < ready.messages.length; index++) {
    if (cancelled()) break;
    const item = ready.messages[index];
    let type = item.type;
    const content = type === "sticker" ? item.fallbackText || "" : item.content;
    const quoteId = index === 0 ? ready.replyToMessageId : null;
    const guard = async () => !cancelled() && !denied(await beforeEach({ index, content, quoteId, signal, type,
      ...(type === "sticker" ? { stickerId: item.stickerId } : {}) })) && !cancelled();
    try {
      if (index > 0) await pause(index);
      if (!await guard() || cancelled()) break;
    } catch { break; } // No wire attempt; do not invent a failed ACK.
    let receipt;
    try {
      let ack = type === "sticker" ? await sendSticker(item.stickerId, { quoteId, index }) : await sendText(content, { quoteId, index });
      if (type === "sticker" && skipped(ack)) {
        // No wire attempt and therefore no failed/uncertain receipt. A fallback
        // is a NEW text attempt and must pass the current host guard again.
        if (!content) continue;
        type = "text";
        try { if (!await guard() || cancelled()) break; } catch { break; }
        ack = await sendText(content, { quoteId, index });
      }
      const ambiguousSkip = type === "sticker" && ack && typeof ack === "object" && "skipped" in ack;
      const id = !ambiguousSkip && ack && typeof ack === "object" ? messageId(ack.messageId) : null;
      receipt = { index, type, ...(type === "sticker" ? { stickerId: item.stickerId } : {}), content,
        ...(ack === false ? { status: "failed" } : id !== null ? { status: "sent", messageId: id } : { status: "uncertain" }) };
    } catch { receipt = { index, type, ...(type === "sticker" ? { stickerId: item.stickerId } : {}), status: "uncertain", content }; }
    receipts.push(receipt);
    if (receipt.status === "sent") sent++;
    if (receipt.status === "uncertain") uncertain = true;
    try { if (denied(await onReceipt({ ...receipt }))) throw new Error("RECEIPT_NOT_DURABLE"); }
    catch { uncertain = true; break; }
    if (receipt.status !== "sent" || cancelled()) break;
  }
  return { sent, partial: sent > 0 && sent < ready.messages.length, uncertain, receipts };
}
