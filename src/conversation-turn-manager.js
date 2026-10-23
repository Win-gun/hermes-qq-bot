// Pure local completion hints, NOT permission to reply or a queue/timer.
// elapsedMs = quiet time since the latest fragment; sentAtMs = first event time.
// gaps = preceding inter-fragment durations (ms), used when first-event time is
// unavailable. The host must keep that first time stable across fragments.
const DEFAULTS = Object.freeze({ minWaitMs: 300, maxWaitMs: 8000,
  ordinaryWaitMs: 1800, incompleteWaitMs: 4000, maxTurnMs: 12000 });
const duration = (value, fallback) => Number.isFinite(value) && value >= 0
  ? Math.min(120000, Math.floor(value)) : fallback;

export function evaluateConversationTurn({ text = "", mentioned = false, isPrivate = false,
  quotedBot = false, elapsedMs = 0, messageCount = 1, gaps = [], sentAtMs, now, policy = {} } = {}) {
  const raw = policy?.turn || {};
  const maxTurn = duration(raw.maxTurnMs, DEFAULTS.maxTurnMs);
  const maximum = Math.min(maxTurn, duration(raw.maxWaitMs, DEFAULTS.maxWaitMs));
  const minimum = Math.min(maximum, duration(raw.minWaitMs, DEFAULTS.minWaitMs));
  const boundedWait = (key) => Math.max(minimum, Math.min(maximum, duration(raw[key], DEFAULTS[key])));
  const elapsed = duration(elapsedMs, 0);
  const count = Number.isSafeInteger(messageCount) && messageCount > 0 ? Math.min(messageCount, 256) : 1;
  const prior = count > 1 && Array.isArray(gaps) ? gaps.slice(-Math.min(255, count - 1)) : [];
  const gapAge = prior.reduce((sum, gap) => Math.min(120000, sum + duration(gap, 0)), 0);
  const eventAge = Number.isFinite(now) && Number.isFinite(sentAtMs) && sentAtMs >= 0
    ? Math.max(0, now - sentAtMs) : 0;
  const age = Math.max(elapsed, elapsed + gapAge, eventAge);
  const remaining = Math.max(0, maxTurn - age);
  const body = typeof text === "string" ? text.slice(0, 12000).trim() : "";
  const result = (status, confidence, suggestedWaitMs, reason) => ({ status, confidence, suggestedWaitMs, reason });
  if (!body) return result("observe", 1, 0, "empty");
  const command = /^\/[a-z][\w-]*(?:\s|$)/i.test(body);
  const immediate = !/(?:不要|别|不用|无需)\s*(?:立即|马上|现在|立刻|直接)/u.test(body)
    && /(?:立即|马上|现在|立刻|直接)(?:就)?(?:回答|回复|答|说|告诉我)|(?:别等|不用等|无需等)(?:了|待)?[，,。.!！\s]*(?:直接|请)?(?:回答|回复|说)?/u.test(body);
  if (command || immediate) return result("ready", 0.99, 0, command ? "command" : "explicit-immediate");
  if (!remaining) return result("ready", 0.8, 0, "max-turn");
  const incomplete = /[,，;；、:：…]$/u.test(body)
    || /(?:我感觉|我觉得|这个东西|然后|但是|不过|而且|所以|因为|比如|如果|就是|还有|以及|等我说完|还没说完|让我想想)$/u.test(body)
    || /(?:\b(?:and|but|because|if|then)|\b(?:I think|for example))$/iu.test(body);
  const addressed = mentioned === true || isPrivate === true || quotedBot === true;
  // '?' is intentionally absent: other people's questions are not an invitation.
  const target = incomplete ? boundedWait("incompleteWaitMs") : addressed ? minimum : boundedWait("ordinaryWaitMs");
  const wait = Math.min(remaining, Math.max(0, target - elapsed));
  return result(wait > 0 ? "wait" : "ready", incomplete ? 0.65 : addressed ? 0.9 : 0.75,
    wait, incomplete ? "incomplete" : addressed ? "addressed" : "ordinary");
}
