/**
 * Pure synchronous MemoryRuntime draft builders; no IO, clock or second writer.
 * Never pass the published runtime.value to a writer. Await durable publication
 * of a NEW claim before transport. Duplicate claims MUST NOT execute again.
 * A persisted pending claim is uncertain after a crash, never a replay queue.
 * Settle it explicitly as uncertain, or retain it as pending/unknown. Terminal
 * records cannot be revised; exact normalized retries alone are idempotent.
 *
 * All times are epoch milliseconds; queries use [from,to), attributed to call
 * startedAt (UTC days). Missing ledger reads empty WITHOUT writing defaults.
 * Writers return {ok,duplicate,revision,entry}, claim also {shouldCall}; failures
 * return {ok:false,reason} without mutation. Optional expectedRevision checks
 * the LEDGER revision; expectedCallRevision checks the entry revision. CAS is
 * checked before dedup. Repository CAS/durability remains MemoryRuntime's job.
 *
 * v2 retention: completed detail/dedup fences survive seven days after endedAt;
 * events survive seven days after time. Pending claims NEVER expire/replay.
 * The watermark is the highest trusted host time supplied to a successful
 * write, not a clock read. Rotation shares the SAME draft/publication as writes.
 * Full detail is retained (no lossy compression); expired global known/unknown
 * totals survive in retention.prunedUsage, NOT as per-scope historical evidence.
 * Reusing an expired ID with a NEW time is outside the dedup contract: stable
 * callId retries MUST retain their original startedAt. Old timestamps fail closed.
 * No within-window eviction: explicit pressure/backpressure at generous caps.
 * Calls includes reservations for pending settlements, so a newly durable claim
 * can settle even at capacity. Failed writes/queries never prune or move time.
 * Queries report coverage and pressure. Counts/knownTokens are recorded lower
 * bounds outside coverage; totalCallCount and token totals are null, NEVER zero
 * for unobserved history/future. Empty-ledger history is unknown. Coverage ends
 * at the last trusted write time + 1ms; queries NEVER invent future completeness.
 * v1 is validated/read without mutation and upgraded on the next successful write.
 * Callers must treat failed claims/settlements as fail-closed, not zero usage.
 * Events are immutable snapshots; resolution uses a NEW eventId + resolved:true.
 * Only host-chosen machine identifiers/enums are accepted, never model prose.
 * Unknown properties (error, prompt, content, etc.) are not persisted.
 *
 * Bounded work (v3.4): persisted rows stay untrusted and are still validated in
 * full on every read. What changed is the constant factor. A single pass over
 * the retained rows both validates each row and builds the derived projection
 * (callId index, pending count, day/scope buckets, time bounds), and a
 * successful write publishes `days` as a delta of that projection instead of
 * re-aggregating every row twice per write. Rotation no longer rebuilds the
 * call/event arrays unless the seven-day floor actually advances past a row.
 * This is an in-draft reduction of repeated work on data that was just checked
 * in the same call; it is NOT a cross-write identity/state cache, does not
 * assume MemoryRuntime mutates a published root in place, and never accepts a
 * shape/corruption that the validating pass rejects.
 *
 * Optional verifiedPrices on record/settle is trusted-host input, NOT model
 * output: {verified:true,model,currency,source,inputMicrosPerMillionTokens,
 * outputMicrosPerMillionTokens,cachedInputMicrosPerMillionTokens?}. Currency is
 * three uppercase letters; prices are nonnegative safe integers in micro-units.
 * Cost needs known input/output and an explicit cached count (0 is valid); if
 * cached>0 it needs a verified cached rate. Round UP once to a micro-unit using
 * integer arithmetic. No fallback prices, currency conversion or invented cost.
 */
const DAY = 86400000;
export const OPERATIONAL_LEDGER_LIMITS = Object.freeze({
  calls: 50000, completedCalls: 50000, pendingCalls: 1024,
  events: 10000, dayAggregates: 20000, retentionMs: 7 * DAY,
});
const LIMITS = OPERATIONAL_LEDGER_LIMITS;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'];
const TOKEN_METRICS = ['knownTokens', 'knownCalls', 'unknownCalls', 'total'];
const COUNT_FIELDS = ['callCount', 'knownCallCount', 'unknownCallCount', 'pendingCallCount',
  'confirmedCallCount', 'failedCallCount', 'uncertainCallCount'];
const SCOPE = ['logicalBotId', 'accountId', 'conversationId', 'kind', 'model'];
const TERMINAL = ['confirmed', 'failed', 'uncertain'];
const SEVERITIES = ['info', 'warning', 'error', 'critical'];
const CALL_FIELDS = ['callId', 'revision', 'startedAt', 'endedAt', ...SCOPE, 'status', 'usage', 'cost'];
const EVENT_FIELDS = ['eventId', 'code', 'severity', 'accountId', 'logicalBotId', 'feature', 'time', 'recoveryAction', 'resolved'];
const DAY_FIELDS = ['day', ...SCOPE, 'stats'];
const RETENTION_FIELDS = ['originAt', 'through', 'prunedUsage', 'prunedEventCount', 'prunedRevisionCount'];
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const fail = reason => ({ ok: false, reason });
const own = (x, key) => Object.hasOwn(x, key);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = x => integer(x) && x <= 253402300799999;
const clone = x => structuredClone(x);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,159}$/.test(x)
  && !x.includes('://') && !x.split(/[.:/]/).some(part => FORBIDDEN.has(part))
  && !/^(?:sk-|Bearer|password|secret|cookie|authorization|api[_-]?key)/i.test(x);

function object(x) {
  return x !== null && typeof x === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(x))
    && Reflect.ownKeys(x).every(k => typeof k === 'string' && !FORBIDDEN.has(k)
      && Object.getOwnPropertyDescriptor(x, k)?.enumerable === true
      && own(Object.getOwnPropertyDescriptor(x, k), 'value'));
}
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k));
const exactKeys = (x, allowed) => keys(x, allowed) && Object.keys(x).length === allowed.length;
function array(x, max) {
  return Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype && x.length <= max
    && Reflect.ownKeys(x).length === x.length + 1 && Reflect.ownKeys(x).every(k => k === 'length'
      || (typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k) && Number(k) < x.length
        && own(Object.getOwnPropertyDescriptor(x, k), 'value')));
}
function numberFrom(values) {
  const present = values.filter(x => x !== undefined);
  return present.length && present.every(integer) && present.every(x => x === present[0]) ? present[0] : null;
}

/** Normalize ONLY trusted transport JSON numbers; never parse text or coerce. */
export function normalizeModelUsage(value) {
  const u = object(value) ? value : {};
  const detail = (key, field) => u[key] === undefined ? undefined : object(u[key]) ? u[key][field] : null;
  const usage = {
    inputTokens: numberFrom([u.inputTokens, u.input_tokens, u.prompt_tokens]),
    outputTokens: numberFrom([u.outputTokens, u.output_tokens, u.completion_tokens]),
    totalTokens: numberFrom([u.totalTokens, u.total_tokens]),
    cachedInputTokens: numberFrom([u.cachedInputTokens, detail('input_tokens_details', 'cached_tokens'), detail('prompt_tokens_details', 'cached_tokens')]),
    reasoningTokens: numberFrom([u.reasoningTokens, detail('output_tokens_details', 'reasoning_tokens'), detail('completion_tokens_details', 'reasoning_tokens')]),
  };
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null
    && (!Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
      || usage.totalTokens !== usage.inputTokens + usage.outputTokens)) usage.totalTokens = null;
  if (usage.inputTokens !== null && usage.cachedInputTokens > usage.inputTokens) usage.cachedInputTokens = null;
  if (usage.outputTokens !== null && usage.reasoningTokens > usage.outputTokens) usage.reasoningTokens = null;
  return usage;
}

function costFor(usage, prices, model) {
  if (!object(prices) || prices.verified !== true || prices.model !== model || !label(prices.source)
    || typeof prices.currency !== 'string' || !/^[A-Z]{3}$/.test(prices.currency) || !integer(prices.inputMicrosPerMillionTokens)
    || !integer(prices.outputMicrosPerMillionTokens) || usage.inputTokens === null
    || usage.outputTokens === null || usage.cachedInputTokens === null) return null;
  const cached = usage.cachedInputTokens;
  if (cached && !integer(prices.cachedInputMicrosPerMillionTokens)) return null;
  const numerator = BigInt(usage.inputTokens - cached) * BigInt(prices.inputMicrosPerMillionTokens)
    + BigInt(cached) * BigInt(cached ? prices.cachedInputMicrosPerMillionTokens : 0)
    + BigInt(usage.outputTokens) * BigInt(prices.outputMicrosPerMillionTokens);
  const amount = (numerator + 999999n) / 1000000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { amountMicros: Number(amount), currency: prices.currency, priceSource: prices.source, verified: true };
}
function validCost(x) {
  return x === null || (exactKeys(x, ['amountMicros', 'currency', 'priceSource', 'verified'])
    && integer(x.amountMicros) && typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency)
    && label(x.priceSource) && x.verified === true);
}
function callOf(args, pending = false) {
  if (!object(args) || !label(args.callId) || !stamp(args.startedAt) || !SCOPE.every(k => label(args[k]))) return null;
  if (!pending && (!TERMINAL.includes(args.status) || !stamp(args.endedAt) || args.endedAt < args.startedAt)) return null;
  const usage = normalizeModelUsage(pending ? null : args.usage);
  return {
    callId: args.callId, revision: 1, startedAt: args.startedAt, endedAt: pending ? null : args.endedAt,
    ...Object.fromEntries(SCOPE.map(k => [k, args[k]])), status: pending ? 'pending' : args.status,
    usage, cost: pending ? null : costFor(usage, args.verifiedPrices, args.model),
  };
}

/** Fixpoint check equivalent to persist(usage) === normalizeModelUsage(usage):
 * all five metrics are null-or-count, totals stay consistent when all three
 * base counts are known, and cached/reasoning never exceed their parent count.
 */
function validUsage(u) {
  if (!exactKeys(u, TOKEN_FIELDS)) return false;
  for (const field of TOKEN_FIELDS) { const v = u[field]; if (v !== null && !integer(v)) return false; }
  if (u.inputTokens !== null && u.outputTokens !== null && u.totalTokens !== null
    && (!Number.isSafeInteger(u.inputTokens + u.outputTokens) || u.totalTokens !== u.inputTokens + u.outputTokens)) return false;
  if (u.inputTokens !== null && u.cachedInputTokens !== null && u.cachedInputTokens > u.inputTokens) return false;
  if (u.outputTokens !== null && u.reasoningTokens !== null && u.reasoningTokens > u.outputTokens) return false;
  return true;
}
function validCall(c) {
  if (!exactKeys(c, CALL_FIELDS) || !label(c.callId) || !stamp(c.startedAt) || !SCOPE.every(k => label(c[k]))
    || ![1, 2].includes(c.revision) || !validUsage(c.usage) || !validCost(c.cost)
    || (c.cost !== null && ['inputTokens', 'outputTokens', 'cachedInputTokens'].some(k => c.usage[k] === null))) return false;
  if (c.status === 'pending') return c.revision === 1 && c.endedAt === null && c.cost === null
    && TOKEN_FIELDS.every(k => c.usage[k] === null);
  return TERMINAL.includes(c.status) && stamp(c.endedAt) && c.endedAt >= c.startedAt;
}
function eventOf(args) {
  if (!object(args) || !label(args.eventId) || !label(args.code) || !label(args.feature)
    || !SEVERITIES.includes(args.severity) || !stamp(args.time)
    || ![args.accountId, args.logicalBotId].every(x => x === undefined || x === null || label(x))
    || !(args.recoveryAction === undefined || args.recoveryAction === null || label(args.recoveryAction))
    || !(args.resolved === undefined || typeof args.resolved === 'boolean')) return null;
  return { eventId: args.eventId, code: args.code, severity: args.severity, accountId: args.accountId ?? null,
    logicalBotId: args.logicalBotId ?? null, feature: args.feature, time: args.time,
    recoveryAction: args.recoveryAction ?? null, resolved: args.resolved ?? false };
}
/** Fixpoint check equivalent to persist(e) === eventOf(e); no allocation. */
function validEvent(e) {
  if (!exactKeys(e, EVENT_FIELDS) || !label(e.eventId) || !label(e.code) || !label(e.feature)
    || !SEVERITIES.includes(e.severity) || !stamp(e.time)) return false;
  if (![e.accountId, e.logicalBotId].every(x => x === null || label(x))) return false;
  if (!(e.recoveryAction === null || label(e.recoveryAction))) return false;
  return typeof e.resolved === 'boolean';
}
const emptyStats = () => ({
  callCount: 0, knownCallCount: 0, unknownCallCount: 0, pendingCallCount: 0,
  confirmedCallCount: 0, failedCallCount: 0, uncertainCallCount: 0,
  tokens: Object.fromEntries(TOKEN_FIELDS.map(k => [k, { knownTokens: 0, knownCalls: 0, unknownCalls: 0, total: 0 }])),
  cost: { knownCalls: 0, unknownCalls: 0, byCurrency: [] },
});
const cloneStats = s => ({
  callCount: s.callCount, knownCallCount: s.knownCallCount, unknownCallCount: s.unknownCallCount,
  pendingCallCount: s.pendingCallCount, confirmedCallCount: s.confirmedCallCount,
  failedCallCount: s.failedCallCount, uncertainCallCount: s.uncertainCallCount,
  tokens: Object.fromEntries(TOKEN_FIELDS.map(k => [k, { ...s.tokens[k] }])),
  cost: { knownCalls: s.cost.knownCalls, unknownCalls: s.cost.unknownCalls,
    byCurrency: s.cost.byCurrency.map(c => ({ ...c })) },
});
function add(a, b) {
  const n = a + b;
  if (!integer(n)) throw new Error('overflow');
  return n;
}
function accumulate(stats, c) {
  stats.callCount++;
  stats[`${c.status}CallCount`]++;
  const known = ['inputTokens', 'outputTokens', 'totalTokens'].every(k => c.usage[k] !== null);
  stats[known ? 'knownCallCount' : 'unknownCallCount']++;
  for (const field of TOKEN_FIELDS) {
    const metric = stats.tokens[field], n = c.usage[field];
    if (n === null) metric.unknownCalls++;
    else { metric.knownCalls++; metric.knownTokens = add(metric.knownTokens, n); }
    metric.total = metric.unknownCalls ? null : metric.knownTokens;
  }
  if (!c.cost) stats.cost.unknownCalls++;
  else {
    stats.cost.knownCalls++;
    let currency = stats.cost.byCurrency.find(x => x.currency === c.cost.currency);
    if (!currency) {
      currency = { currency: c.cost.currency, amountMicros: 0 };
      stats.cost.byCurrency.push(currency);
      stats.cost.byCurrency.sort((a, b) => a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0);
    }
    currency.amountMicros = add(currency.amountMicros, c.cost.amountMicros);
  }
}
/** Structural equality against a freshly built stats object; the rebuilt value
 * is valid by construction, so equality also proves the stored one is valid. */
function sameStats(s, truth) {
  if (!object(s) || Object.keys(s).length !== 9 || !COUNT_FIELDS.every(k => s[k] === truth[k])) return false;
  for (const field of TOKEN_FIELDS) {
    const m = s.tokens?.[field], t = truth.tokens[field];
    if (!object(m) || Object.keys(m).length !== 4 || !TOKEN_METRICS.every(k => m[k] === t[k])) return false;
  }
  const cost = s.cost;
  if (!object(cost) || Object.keys(cost).length !== 3 || cost.knownCalls !== truth.cost.knownCalls
    || cost.unknownCalls !== truth.cost.unknownCalls) return false;
  const list = cost.byCurrency;
  if (!array(list, 17576) || list.length !== truth.cost.byCurrency.length) return false;
  return truth.cost.byCurrency.every((t, i) => {
    const c = list[i];
    return object(c) && Object.keys(c).length === 2 && c.currency === t.currency && c.amountMicros === t.amountMicros;
  });
}
function validStats(s) {
  if (!exactKeys(s, [...COUNT_FIELDS, 'tokens', 'cost']) || !COUNT_FIELDS.every(k => integer(s[k]))
    || s.knownCallCount + s.unknownCallCount !== s.callCount
    || s.pendingCallCount + s.confirmedCallCount + s.failedCallCount + s.uncertainCallCount !== s.callCount
    || !exactKeys(s.tokens, TOKEN_FIELDS) || !exactKeys(s.cost, ['knownCalls', 'unknownCalls', 'byCurrency'])
    || !integer(s.cost.knownCalls) || !integer(s.cost.unknownCalls)
    || s.cost.knownCalls + s.cost.unknownCalls !== s.callCount || !array(s.cost.byCurrency, 17576)) return false;
  if (s.cost.byCurrency.some(c => !exactKeys(c, ['currency', 'amountMicros'])
    || typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency) || !integer(c.amountMicros))
    || new Set(s.cost.byCurrency.map(c => c.currency)).size !== s.cost.byCurrency.length) return false;
  return TOKEN_FIELDS.every(k => {
    const m = s.tokens[k];
    return exactKeys(m, TOKEN_METRICS) && integer(m.knownTokens) && integer(m.knownCalls) && integer(m.unknownCalls)
      && m.knownCalls + m.unknownCalls === s.callCount && m.total === (m.unknownCalls ? null : m.knownTokens);
  });
}
const scopeOf = c => ({
  day: new Date(c.startedAt).toISOString().slice(0, 10), logicalBotId: c.logicalBotId,
  accountId: c.accountId, conversationId: c.conversationId, kind: c.kind, model: c.model,
});
const keyOf = scope => JSON.stringify(scope);
const bucketOf = (scope, stats) => ({
  day: scope.day, logicalBotId: scope.logicalBotId, accountId: scope.accountId,
  conversationId: scope.conversationId, kind: scope.kind, model: scope.model, stats,
});
const EMPTY_LEDGER = () => ({ version: 2, revision: 0, calls: [], events: [], days: [],
  retention: { originAt: null, through: null, prunedUsage: emptyStats(), prunedEventCount: 0, prunedRevisionCount: 0 } });

/** ONE pass over untrusted persisted rows: validate each row, index it, and
 * build the day/scope projection. Returns null when any row is corrupt. */
function deriveIndex(calls) {
  const buckets = new Map(), index = new Map();
  let pending = 0, revisions = 0, min = null, max = null;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!validCall(c) || index.has(c.callId)) return null;
    index.set(c.callId, i);
    if (c.status === 'pending') pending++;
    revisions += c.revision;
    const start = c.startedAt, end = c.endedAt === null ? c.startedAt : c.endedAt;
    if (min === null || start < min) min = start;
    if (max === null || end > max) max = end;
    const scope = scopeOf(c), key = keyOf(scope);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { scope, stats: emptyStats(), calls: [] }; buckets.set(key, bucket); }
    accumulate(bucket.stats, c);
    bucket.calls.push(i);
  }
  const order = [...buckets.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  order.forEach((key, slot) => { buckets.get(key).slot = slot; });
  return { buckets, order, index, pending, revisions, min, max, calls, eventIndex: new Map() };
}
const daysOf = derived => derived.order.map(key => {
  const bucket = derived.buckets.get(key);
  return bucketOf(bucket.scope, bucket.stats);
});
/** The stored projection must equal the one just rebuilt from the same rows. */
function sameDays(derived, days) {
  if (days.length !== derived.order.length) return false;
  for (let i = 0; i < days.length; i++) {
    const d = days[i], bucket = derived.buckets.get(derived.order[i]);
    if (!exactKeys(d, DAY_FIELDS) || d.day !== bucket.scope.day
      || !SCOPE.every(k => d[k] === bucket.scope[k]) || !sameStats(d.stats, bucket.stats)) return false;
  }
  return true;
}
function read(root) {
  if (!object(root)) return fail('invalid_state');
  if (!own(root, 'operationalLedger')) {
    return { ok: true, ledger: EMPTY_LEDGER(), derived: deriveIndex([]) };
  }
  const l = root.operationalLedger;
  if (!object(l)) return fail('invalid_state');
  if (!keys(l, ['version', 'revision', 'calls', 'events', 'days', ...(l.version === 2 ? ['retention'] : [])])
    || Object.keys(l).length !== (l.version === 2 ? 6 : 5)
    || ![1, 2].includes(l.version) || !integer(l.revision) || !array(l.calls, LIMITS.calls)
    || !array(l.events, LIMITS.events) || !array(l.days, LIMITS.dayAggregates)) return fail('invalid_state');
  let derived;
  try { derived = deriveIndex(l.calls); } catch { return fail('invalid_state'); }
  if (!derived || derived.pending > LIMITS.pendingCalls) return fail('invalid_state');
  try { if (!sameDays(derived, l.days)) return fail('invalid_state'); } catch { return fail('invalid_state'); }
  const eventIndex = new Map();
  let eventMin = null, eventMax = null;
  for (const e of l.events) {
    if (!validEvent(e) || eventIndex.has(e.eventId)) return fail('invalid_state');
    eventIndex.set(e.eventId, e);
    if (eventMin === null || e.time < eventMin) eventMin = e.time;
    if (eventMax === null || e.time > eventMax) eventMax = e.time;
  }
  derived.eventIndex = eventIndex;
  const times = [derived.min, derived.max, eventMin, eventMax].filter(t => t !== null);
  const maxTime = times.length ? Math.max(...times) : null;
  let retention = l.retention;
  if (l.version === 1) retention = {
    originAt: times.length ? Math.min(...times) : null, through: times.length ? Math.max(...times) : null,
    prunedUsage: emptyStats(), prunedEventCount: 0, prunedRevisionCount: 0,
  };
  if (!exactKeys(retention, RETENTION_FIELDS) || !integer(retention.prunedEventCount)
    || !integer(retention.prunedRevisionCount) || !validStats(retention.prunedUsage)
    || retention.prunedUsage.pendingCallCount !== 0
    || !(retention.originAt === null && retention.through === null && l.revision === 0
      || stamp(retention.originAt) && stamp(retention.through) && retention.originAt <= retention.through)
    || (maxTime !== null && maxTime > retention.through)
    || derived.revisions + l.events.length + retention.prunedRevisionCount !== l.revision
    || retention.prunedRevisionCount < retention.prunedUsage.callCount + retention.prunedEventCount
    || retention.prunedRevisionCount > retention.prunedUsage.callCount * 2 + retention.prunedEventCount) {
    return fail('invalid_state');
  }
  return { ok: true, ledger: l.version === 1 ? { ...l, version: 2, retention } : l, derived };
}

const windowFrom = ledger => ledger.retention.through === null ? 0 : Math.max(0, ledger.retention.through - LIMITS.retentionMs);
function pressureOf(ledger, pendingCount) {
  const used = { calls: ledger.calls.length, completedCalls: ledger.calls.length - pendingCount,
    pendingCalls: pendingCount, events: ledger.events.length, dayAggregates: ledger.days.length };
  const nearCapacity = Object.keys(used).filter(k => used[k] >= LIMITS[k] * 0.9);
  return { used, limits: { ...LIMITS }, nearCapacity };
}
const capacityFor = (ledger, pendingCount, resource) =>
  ({ ...fail('capacity'), resource, pressure: pressureOf(ledger, pendingCount) });

// Make a private rotation candidate; publication happens only after EVERY gate.
// The retained call/event arrays are rebuilt ONLY when the seven-day floor moves
// far enough to actually expire a row, so ordinary writes keep the same arrays.
function rotate(ledger, time, origin = time) {
  const r = ledger.retention;
  const through = r.through === null ? time : Math.max(r.through, time);
  const originAt = r.originAt === null ? origin : r.originAt;
  const floor = Math.max(0, through - LIMITS.retentionMs);
  const earlierFloor = r.through === null ? 0 : Math.max(0, r.through - LIMITS.retentionMs);
  if (originAt === r.originAt && through === r.through) return { ledger, pruned: false };
  if (floor === earlierFloor) return { ledger: { ...ledger, retention: { ...r, originAt, through } }, pruned: false };
  const retention = clone(r);
  retention.originAt = originAt;
  retention.through = through;
  const calls = [], events = [];
  let pruned = false;
  for (const c of ledger.calls) {
    if (c.status === 'pending' || c.endedAt >= floor) calls.push(c);
    else { accumulate(retention.prunedUsage, c); retention.prunedRevisionCount = add(retention.prunedRevisionCount, c.revision); pruned = true; }
  }
  for (const e of ledger.events) {
    if (e.time >= floor) events.push(e);
    else { retention.prunedEventCount = add(retention.prunedEventCount, 1); retention.prunedRevisionCount = add(retention.prunedRevisionCount, 1); pruned = true; }
  }
  return { ledger: { ...ledger, retention, calls, events }, pruned };
}
function writable(root, args) {
  const found = read(root);
  if (!found.ok) return found;
  if (!object(args)) return fail('invalid_args');
  if (own(args, 'expectedRevision')) {
    if (!integer(args.expectedRevision)) return fail('invalid_args');
    if (args.expectedRevision !== found.ledger.revision) return fail('stale_revision');
  }
  const desc = Object.getOwnPropertyDescriptor(root, 'operationalLedger');
  if (desc ? !desc.writable : !Object.isExtensible(root)) return fail('invalid_state');
  return found;
}
const success = (ledger, pendingCount, entry, duplicate) =>
  ({ ok: true, duplicate, revision: ledger.revision, entry: clone(entry), pressure: pressureOf(ledger, pendingCount) });
function publish(root, base, state, entry) {
  const next = { ...base, revision: base.revision + 1, calls: state.calls, events: state.events, days: state.days };
  if (!integer(next.revision)) return fail('overflow');
  const over = next.calls.length > LIMITS.calls ? 'calls'
    : state.pendingCount > LIMITS.pendingCalls ? 'pendingCalls'
      : next.events.length > LIMITS.events ? 'events'
        : next.days.length > LIMITS.dayAggregates ? 'dayAggregates' : null;
  if (over) return capacityFor(next, state.pendingCount, over);
  Object.defineProperty(root, 'operationalLedger', own(root, 'operationalLedger') ? { value: next }
    : { value: next, writable: true, enumerable: true, configurable: true });
  return success(next, state.pendingCount, entry, false);
}
/** Delta of the validated projection: add one new row to its day/scope bucket. */
function appendDays(derived, days, entry) {
  const scope = scopeOf(entry), key = keyOf(scope), next = days.slice();
  const bucket = derived.buckets.get(key);
  if (bucket) {
    const stats = cloneStats(bucket.stats);
    accumulate(stats, entry);
    next[bucket.slot] = bucketOf(scope, stats);
    return next;
  }
  const stats = emptyStats();
  accumulate(stats, entry);
  let low = 0, high = derived.order.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (derived.order[mid] < key) low = mid + 1; else high = mid;
  }
  next.splice(low, 0, bucketOf(scope, stats));
  return next;
}
/** Delta of the validated projection: a settled row keeps its day/scope bucket,
 * so only that bucket is rebuilt from its own rows. */
function replaceDays(derived, days, entry, at) {
  const scope = scopeOf(entry);
  const bucket = derived.buckets.get(keyOf(scope));
  const stats = emptyStats();
  for (const i of bucket.calls) accumulate(stats, i === at ? entry : derived.calls[i]);
  const next = days.slice();
  next[bucket.slot] = bucketOf(scope, stats);
  return next;
}
function insertCall(root, args, pending) {
  const found = writable(root, args);
  if (!found.ok) return found;
  const entry = callOf(args, pending);
  if (!entry) return fail('invalid_args');
  const ledger = found.ledger, derived = found.derived;
  const at = derived.index.get(entry.callId);
  if (at !== undefined) {
    // A claim remains a duplicate even after settlement. Never replay transport.
    const existing = ledger.calls[at];
    const same = pending ? existing.startedAt === entry.startedAt && SCOPE.every(k => existing[k] === entry[k])
      : equal({ ...existing, revision: 1 }, entry);
    return same ? success(ledger, derived.pending, existing, true) : fail('conflict');
  }
  const time = pending ? entry.startedAt : entry.endedAt;
  if (entry.startedAt < Math.max(windowFrom(ledger), time - LIMITS.retentionMs)) return fail('outside_retention');
  try {
    const rotated = rotate(ledger, time, entry.startedAt), base = rotated.ledger;
    const projection = rotated.pruned ? deriveIndex(base.calls) : derived;
    if (!projection) return fail('invalid_state');
    const days = appendDays(projection, rotated.pruned ? daysOf(projection) : base.days, entry);
    return publish(root, base, {
      calls: [...base.calls, entry], events: base.events, days,
      pendingCount: projection.pending + (pending ? 1 : 0),
    }, entry);
  } catch { return fail('overflow'); }
}

export function claimModelCall(root, args) {
  const result = insertCall(root, args, true);
  return result.ok ? { ...result, shouldCall: !result.duplicate } : result;
}

/** One-phase terminal recording for an ALREADY executed call, not a claim. */
export function recordModelCall(root, args) { return insertCall(root, args, false); }

export function settleModelCall(root, args) {
  const found = writable(root, args);
  if (!found.ok) return found;
  if (!label(args.callId) || !stamp(args.endedAt) || !TERMINAL.includes(args.status)) return fail('invalid_args');
  const ledger = found.ledger, derived = found.derived;
  const index = derived.index.get(args.callId);
  if (index === undefined) return fail('not_found');
  const previous = ledger.calls[index];
  if (own(args, 'expectedCallRevision')) {
    if (!integer(args.expectedCallRevision)) return fail('invalid_args');
    if (args.expectedCallRevision !== previous.revision) return fail('stale_revision');
  }
  if (SCOPE.some(k => own(args, k) && args[k] !== previous[k])
    || (own(args, 'startedAt') && args.startedAt !== previous.startedAt)) return fail('conflict');
  if (args.endedAt < previous.startedAt) return fail('invalid_args');
  const usage = normalizeModelUsage(args.usage);
  const entry = { ...previous, revision: previous.status === 'pending' ? 2 : previous.revision,
    endedAt: args.endedAt, status: args.status, usage, cost: costFor(usage, args.verifiedPrices, previous.model) };
  if (previous.status !== 'pending') return equal(previous, entry) ? success(ledger, derived.pending, previous, true) : fail('conflict');
  const calls = ledger.calls.slice();
  calls[index] = entry;
  try {
    const rotated = rotate({ ...ledger, calls }, args.endedAt), base = rotated.ledger;
    const projection = rotated.pruned ? deriveIndex(base.calls) : derived;
    if (!projection) return fail('invalid_state');
    const days = rotated.pruned ? daysOf(projection) : replaceDays(projection, base.days, entry, index);
    // base.calls already carries the settled entry: rotate preserves the array
    // unless it expired old rows, in which case only base.calls is correct.
    return publish(root, base, {
      calls: base.calls, events: base.events, days,
      pendingCount: rotated.pruned ? projection.pending : derived.pending - 1,
    }, entry);
  } catch { return fail('overflow'); }
}

export function recordOperationalEvent(root, args) {
  const found = writable(root, args);
  if (!found.ok) return found;
  const entry = eventOf(args);
  if (!entry) return fail('invalid_args');
  const ledger = found.ledger, derived = found.derived;
  const existing = derived.eventIndex.get(entry.eventId);
  if (existing) return equal(existing, entry) ? success(ledger, derived.pending, existing, true) : fail('conflict');
  if (entry.time < windowFrom(ledger)) return fail('outside_retention');
  try {
    const rotated = rotate(ledger, entry.time), base = rotated.ledger;
    const projection = rotated.pruned ? deriveIndex(base.calls) : derived;
    if (!projection) return fail('invalid_state');
    return publish(root, base, {
      calls: base.calls, events: [...base.events, entry],
      days: rotated.pruned ? daysOf(projection) : base.days,
      pendingCount: projection.pending,
    }, entry);
  } catch { return fail('overflow'); }
}

function queryArgs(args, filters) {
  return keys(args, ['from', 'to', ...filters]) && stamp(args.from) && stamp(args.to) && args.to >= args.from
    && filters.every(k => !own(args, k) || (['resolved', 'currentOnly'].includes(k) ? typeof args[k] === 'boolean' : label(args[k])));
}
const matches = (entry, args, fields) => fields.every(k => !own(args, k) || entry[k] === args[k]);

function coverage(ledger, args) {
  const r = ledger.retention;
  const from = r.originAt === null ? null : Math.max(r.originAt, windowFrom(ledger));
  const to = r.through === null ? null : r.through + 1;
  const unknownRanges = [];
  if (args.from < args.to) {
    if (from === null) unknownRanges.push({ from: args.from, to: args.to });
    else {
      if (args.from < from) unknownRanges.push({ from: args.from, to: Math.min(from, args.to) });
      if (args.to > to) unknownRanges.push({ from: Math.max(to, args.from), to: args.to });
    }
  }
  return { from, to, complete: unknownRanges.length === 0, unknownRanges,
    prunedCallCount: r.prunedUsage.callCount, prunedEventCount: r.prunedEventCount };
}
function projectStats(stats, covered) {
  if (!covered.complete) for (const k of TOKEN_FIELDS) stats.tokens[k].total = null;
  stats.totalCallCount = covered.complete ? stats.callCount : null;
}
function totals(calls) {
  const stats = emptyStats();
  for (const c of calls) accumulate(stats, c);
  return stats;
}
function dayBuckets(calls) {
  const buckets = new Map();
  for (const c of calls) {
    const key = keyOf(scopeOf(c));
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { scope: scopeOf(c), stats: emptyStats() }; buckets.set(key, bucket); }
    accumulate(bucket.stats, c);
  }
  return [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, value]) => bucketOf(value.scope, value.stats));
}

export function queryModelUsage(root, args) {
  if (!queryArgs(args, SCOPE)) return fail('invalid_args');
  const found = read(root);
  if (!found.ok) return found;
  const calls = found.ledger.calls.filter(c => c.startedAt >= args.from && c.startedAt < args.to && matches(c, args, SCOPE));
  try {
    const stats = totals(calls), days = dayBuckets(calls), covered = coverage(found.ledger, args);
    // Do not convert a missing interval into a reported zero, even when the
    // retained rows happen to contain only completely known usage.
    projectStats(stats, covered);
    for (const day of days) {
      const start = Date.parse(`${day.day}T00:00:00.000Z`);
      day.coverage = coverage(found.ledger, { from: Math.max(start, args.from), to: Math.min(start + DAY, args.to) });
      projectStats(day.stats, day.coverage);
    }
    return { ok: true, revision: found.ledger.revision, from: args.from, to: args.to,
      stats, days, coverage: covered, pressure: pressureOf(found.ledger, found.derived.pending) };
  }
  catch { return fail('overflow'); }
}

/** Default is unchanged immutable history. currentOnly:true folds ALL retained
 * rows by [logicalBotId,accountId,feature,code] BEFORE applying ANY query filter.
 * Latest means greatest event.time, ties go to the later journal append (not
 * lexical/random eventId). Thus a resolution outside the requested time window
 * or severity cannot resurrect an older failure. This is current retained state,
 * NOT an as-of historical snapshot or an assertion about pruned status history.
 */
export function queryOperationalEvents(root, args) {
  const fields = ['accountId', 'logicalBotId', 'feature', 'code', 'severity', 'resolved'];
  if (!queryArgs(args, [...fields, 'currentOnly'])) return fail('invalid_args');
  const found = read(root);
  if (!found.ok) return found;
  let source = found.ledger.events;
  if (args.currentOnly === true) {
    const latest = new Map();
    for (const e of source) {
      const key = JSON.stringify([e.logicalBotId, e.accountId, e.feature, e.code]);
      const previous = latest.get(key);
      if (!previous || e.time >= previous.time) latest.set(key, e);
    }
    source = [...latest.values()];
  }
  const events = source.filter(e => e.time >= args.from && e.time < args.to && matches(e, args, fields))
    .slice().sort((a, b) => a.time - b.time || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  const covered = coverage(found.ledger, args);
  return { ok: true, revision: found.ledger.revision, from: args.from, to: args.to, count: events.length,
    totalCount: covered.complete ? events.length : null, events: clone(events), coverage: covered,
    pressure: pressureOf(found.ledger, found.derived.pending) };
}
