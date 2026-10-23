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

/** Execute ONE host-validated plan ONCE. Never retry the whole result, including
 * sent=0 + uncertain=true. beforeEach owns identity/quiet/revision/quote authority
 * at the wire boundary; sendText must also guard its own internal wire awaits.
 * Quote provenance was validated by parseReplyPlan, not this shape check.
 * Cancellation during send still collects that attempt's ACK and persists it.
 * Receipt persistence runs even after abort; failure stops all remaining sends.
 * sent counts confirmed wire ACKs (not durable receipts); uncertain also covers
 * unknown receipt durability. partial means some, but not all, messages ACKed. */
export async function executeReplyPlan(plan, { sendText, beforeEach, onReceipt, signal,
  sleep = wait, minIntervalMs = 800, maxIntervalMs = 2000 } = {}) {
  if (![sendText, beforeEach, onReceipt, sleep].every(fn => typeof fn === "function")) throw new TypeError("INVALID_REPLY_ADAPTER");
  if (![minIntervalMs, maxIntervalMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 60000)
    || minIntervalMs > maxIntervalMs) throw new TypeError("INVALID_REPLY_INTERVAL");
  // Copy before any await, so host/model mutations cannot change later messages.
  const ready = validateReplyPlan(plan, { maxMessages: 4, direct: false,
    allowedQuoteIds: plan?.replyToMessageId == null ? [] : [plan.replyToMessageId] });
  const receipts = [];
  let sent = 0, uncertain = false;
  const cancelled = () => signal?.aborted === true;
  async function pause() {
    if (!minIntervalMs) return;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new Error("REPLY_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([Promise.resolve().then(() => { if (cancelled()) throw new Error("REPLY_CANCELLED");
      return sleep(minIntervalMs, { signal }); }), interrupted]); }
    finally { signal?.removeEventListener("abort", abort); }
  }
  if (ready.action === "reply") for (let index = 0; index < ready.messages.length; index++) {
    if (cancelled()) break;
    const content = ready.messages[index].content;
    const quoteId = index === 0 ? ready.replyToMessageId : null;
    try {
      if (index > 0) await pause();
      if (cancelled() || denied(await beforeEach({ index, content, quoteId, signal })) || cancelled()) break;
    } catch { break; } // No wire attempt; do not invent a failed ACK.
    let receipt;
    try {
      const ack = await sendText(content, { quoteId, index });
      const id = ack && typeof ack === "object" ? messageId(ack.messageId) : null;
      receipt = ack === false ? { index, status: "failed", content }
        : id !== null ? { index, status: "sent", messageId: id, content } : { index, status: "uncertain", content };
    } catch { receipt = { index, status: "uncertain", content }; }
    receipts.push(receipt);
    if (receipt.status === "sent") sent++;
    if (receipt.status === "uncertain") uncertain = true;
    try { if (denied(await onReceipt({ ...receipt }))) throw new Error("RECEIPT_NOT_DURABLE"); }
    catch { uncertain = true; break; }
    if (receipt.status !== "sent" || cancelled()) break;
  }
  return { sent, partial: sent > 0 && sent < ready.messages.length, uncertain, receipts };
}
