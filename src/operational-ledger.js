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
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'];
const SCOPE = ['logicalBotId', 'accountId', 'conversationId', 'kind', 'model'];
const TERMINAL = ['confirmed', 'failed', 'uncertain'];
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
function array(x, max) {
  return Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype && x.length <= max
    && Reflect.ownKeys(x).length === x.length + 1 && Reflect.ownKeys(x).every(k => k === 'length'
      || (typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k) && Number(k) < x.length
        && own(Object.getOwnPropertyDescriptor(x, k), 'value')));
}
function jsonData(x, budget = { left: 4000000 }, depth = 0) {
  if (--budget.left < 0 || depth > 12) return false;
  if (x === null || ['string', 'boolean'].includes(typeof x)) return true;
  if (typeof x === 'number') return Number.isFinite(x);
  return (object(x) || array(x, OPERATIONAL_LEDGER_LIMITS.dayAggregates)) && Object.values(x).every(v => jsonData(v, budget, depth + 1));
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
  return x === null || (keys(x, ['amountMicros', 'currency', 'priceSource', 'verified'])
    && Object.keys(x).length === 4 && integer(x.amountMicros) && typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency)
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
function validCall(c) {
  if (!keys(c, ['callId', 'revision', 'startedAt', 'endedAt', ...SCOPE, 'status', 'usage', 'cost'])
    || Object.keys(c).length !== 12 || !label(c.callId) || !stamp(c.startedAt) || !SCOPE.every(k => label(c[k]))
    || ![1, 2].includes(c.revision) || !keys(c.usage, TOKEN_FIELDS) || Object.keys(c.usage).length !== TOKEN_FIELDS.length
    || !equal(normalizeModelUsage(c.usage), c.usage) || !validCost(c.cost)
    || (c.cost !== null && ['inputTokens', 'outputTokens', 'cachedInputTokens'].some(k => c.usage[k] === null))) return false;
  if (c.status === 'pending') return c.revision === 1 && c.endedAt === null && c.cost === null
    && TOKEN_FIELDS.every(k => c.usage[k] === null);
  return TERMINAL.includes(c.status) && stamp(c.endedAt) && c.endedAt >= c.startedAt;
}
function eventOf(args) {
  if (!object(args) || !label(args.eventId) || !label(args.code) || !label(args.feature)
    || !['info', 'warning', 'error', 'critical'].includes(args.severity) || !stamp(args.time)
    || ![args.accountId, args.logicalBotId].every(x => x === undefined || x === null || label(x))
    || !(args.recoveryAction === undefined || args.recoveryAction === null || label(args.recoveryAction))
    || !(args.resolved === undefined || typeof args.resolved === 'boolean')) return null;
  return { eventId: args.eventId, code: args.code, severity: args.severity, accountId: args.accountId ?? null,
    logicalBotId: args.logicalBotId ?? null, feature: args.feature, time: args.time,
    recoveryAction: args.recoveryAction ?? null, resolved: args.resolved ?? false };
}
const emptyStats = () => ({
  callCount: 0, knownCallCount: 0, unknownCallCount: 0, pendingCallCount: 0,
  confirmedCallCount: 0, failedCallCount: 0, uncertainCallCount: 0,
  tokens: Object.fromEntries(TOKEN_FIELDS.map(k => [k, { knownTokens: 0, knownCalls: 0, unknownCalls: 0, total: 0 }])),
  cost: { knownCalls: 0, unknownCalls: 0, byCurrency: [] },
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
function aggregates(calls) {
  const stats = emptyStats(), buckets = new Map();
  for (const c of calls) {
    accumulate(stats, c);
    const scope = { day: new Date(c.startedAt).toISOString().slice(0, 10), ...Object.fromEntries(SCOPE.map(k => [k, c[k]])) };
    const key = JSON.stringify(scope);
    if (!buckets.has(key)) buckets.set(key, { ...scope, stats: emptyStats() });
    accumulate(buckets.get(key).stats, c);
  }
  return { stats, days: [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) };
}
function read(root) {
  if (!object(root)) return fail('invalid_state');
  if (!own(root, 'operationalLedger')) return { ok: true, ledger: { version: 2, revision: 0, calls: [], events: [], days: [],
    retention: { originAt: null, through: null, prunedUsage: emptyStats(), prunedEventCount: 0, prunedRevisionCount: 0 } } };
  const l = root.operationalLedger;
  if (!object(l)) return fail('invalid_state');
  if (!keys(l, ['version', 'revision', 'calls', 'events', 'days', ...(l?.version === 2 ? ['retention'] : [])])
    || Object.keys(l).length !== (l.version === 2 ? 6 : 5)
    || ![1, 2].includes(l.version) || !integer(l.revision) || !array(l.calls, OPERATIONAL_LEDGER_LIMITS.calls)
    || !array(l.events, OPERATIONAL_LEDGER_LIMITS.events) || !array(l.days, OPERATIONAL_LEDGER_LIMITS.dayAggregates) || !jsonData(l.days)
    || l.calls.some(c => !validCall(c)) || l.events.some(e => !keys(e, ['eventId', 'code', 'severity', 'accountId', 'logicalBotId', 'feature', 'time', 'recoveryAction', 'resolved'])
      || !equal(eventOf(e), e)) || new Set(l.calls.map(c => c.callId)).size !== l.calls.length
    || new Set(l.events.map(e => e.eventId)).size !== l.events.length
    || l.calls.filter(c => c.status === 'pending').length > OPERATIONAL_LEDGER_LIMITS.pendingCalls) return fail('invalid_state');
  const times = [...l.calls.flatMap(c => [c.startedAt, c.endedAt ?? c.startedAt]), ...l.events.map(e => e.time)];
  let retention = l.retention;
  if (l.version === 1) retention = { originAt: times.length ? times.reduce((a, b) => Math.min(a, b)) : null,
    through: times.length ? times.reduce((a, b) => Math.max(a, b)) : null,
    prunedUsage: emptyStats(), prunedEventCount: 0, prunedRevisionCount: 0 };
  if (!keys(retention, ['originAt', 'through', 'prunedUsage', 'prunedEventCount', 'prunedRevisionCount'])
    || Object.keys(retention).length !== 5 || !integer(retention.prunedEventCount) || !integer(retention.prunedRevisionCount)
    || !validStats(retention.prunedUsage) || retention.prunedUsage.pendingCallCount !== 0
    || !(retention.originAt === null && retention.through === null && l.revision === 0
      || stamp(retention.originAt) && stamp(retention.through) && retention.originAt <= retention.through)
    || times.some(t => t > retention.through)
    || l.calls.reduce((n, c) => n + c.revision, l.events.length + retention.prunedRevisionCount) !== l.revision
    || retention.prunedRevisionCount < retention.prunedUsage.callCount + retention.prunedEventCount
    || retention.prunedRevisionCount > retention.prunedUsage.callCount * 2 + retention.prunedEventCount) return fail('invalid_state');
  try {
    if (!equal(aggregates(l.calls).days, l.days)) return fail('invalid_state');
  } catch { return fail('invalid_state'); }
  return { ok: true, ledger: l.version === 1 ? { ...l, version: 2, retention } : l };
}

function validStats(s) {
  const counts = ['callCount', 'knownCallCount', 'unknownCallCount', 'pendingCallCount', 'confirmedCallCount', 'failedCallCount', 'uncertainCallCount'];
  if (!keys(s, [...counts, 'tokens', 'cost']) || Object.keys(s).length !== 9 || !counts.every(k => integer(s[k]))
    || s.knownCallCount + s.unknownCallCount !== s.callCount
    || s.pendingCallCount + s.confirmedCallCount + s.failedCallCount + s.uncertainCallCount !== s.callCount
    || !keys(s.tokens, TOKEN_FIELDS) || Object.keys(s.tokens).length !== TOKEN_FIELDS.length
    || !keys(s.cost, ['knownCalls', 'unknownCalls', 'byCurrency']) || Object.keys(s.cost).length !== 3
    || !integer(s.cost.knownCalls) || !integer(s.cost.unknownCalls)
    || s.cost.knownCalls + s.cost.unknownCalls !== s.callCount || !array(s.cost.byCurrency, 17576)) return false;
  if (s.cost.byCurrency.some(c => !keys(c, ['currency', 'amountMicros']) || Object.keys(c).length !== 2
    || typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency) || !integer(c.amountMicros))
    || new Set(s.cost.byCurrency.map(c => c.currency)).size !== s.cost.byCurrency.length) return false;
  return TOKEN_FIELDS.every(k => {
    const m = s.tokens[k];
    return keys(m, ['knownTokens', 'knownCalls', 'unknownCalls', 'total']) && Object.keys(m).length === 4
      && integer(m.knownTokens) && integer(m.knownCalls) && integer(m.unknownCalls)
      && m.knownCalls + m.unknownCalls === s.callCount && m.total === (m.unknownCalls ? null : m.knownTokens);
  });
}
const windowFrom = ledger => ledger.retention.through === null ? 0 : Math.max(0, ledger.retention.through - OPERATIONAL_LEDGER_LIMITS.retentionMs);
function pressure(ledger) {
  const pendingCalls = ledger.calls.filter(c => c.status === 'pending').length;
  const used = { calls: ledger.calls.length, completedCalls: ledger.calls.length - pendingCalls,
    pendingCalls, events: ledger.events.length, dayAggregates: ledger.days.length };
  const nearCapacity = Object.keys(used).filter(k => used[k] >= OPERATIONAL_LEDGER_LIMITS[k] * 0.9);
  return { used, limits: { ...OPERATIONAL_LEDGER_LIMITS }, nearCapacity };
}
function capacity(ledger, resource) { return { ...fail('capacity'), resource, pressure: pressure(ledger) }; }

// Make a private rotation candidate; publication happens only after EVERY gate.
function rotate(ledger, time, origin = time) {
  const retention = clone(ledger.retention);
  retention.originAt ??= origin;
  retention.through = Math.max(retention.through ?? time, time);
  const floor = Math.max(0, retention.through - OPERATIONAL_LEDGER_LIMITS.retentionMs);
  const calls = [], events = [];
  for (const c of ledger.calls) {
    if (c.status === 'pending' || c.endedAt >= floor) calls.push(c);
    else { accumulate(retention.prunedUsage, c); retention.prunedRevisionCount = add(retention.prunedRevisionCount, c.revision); }
  }
  for (const e of ledger.events) {
    if (e.time >= floor) events.push(e);
    else { retention.prunedEventCount = add(retention.prunedEventCount, 1); retention.prunedRevisionCount = add(retention.prunedRevisionCount, 1); }
  }
  // publish rebuilds the bounded projection once after the requested delta.
  return { ...ledger, retention, calls, events };
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
function success(ledger, entry, duplicate) {
  return { ok: true, duplicate, revision: ledger.revision, entry: clone(entry), pressure: pressure(ledger) };
}
function publish(root, ledger, entry) {
  let days;
  try { days = aggregates(ledger.calls).days; } catch { return fail('overflow'); }
  const candidate = { ...ledger, days };
  if (ledger.calls.length > OPERATIONAL_LEDGER_LIMITS.calls) return capacity(candidate, 'calls');
  if (ledger.calls.filter(c => c.status === 'pending').length > OPERATIONAL_LEDGER_LIMITS.pendingCalls) return capacity(candidate, 'pendingCalls');
  if (ledger.events.length > OPERATIONAL_LEDGER_LIMITS.events) return capacity(candidate, 'events');
  if (days.length > OPERATIONAL_LEDGER_LIMITS.dayAggregates) return capacity(candidate, 'dayAggregates');
  const next = { ...ledger, revision: ledger.revision + 1, days };
  if (!integer(next.revision)) return fail('overflow');
  Object.defineProperty(root, 'operationalLedger', own(root, 'operationalLedger') ? { value: next }
    : { value: next, writable: true, enumerable: true, configurable: true });
  return success(next, entry, false);
}
function insertCall(root, args, pending) {
  const found = writable(root, args);
  if (!found.ok) return found;
  const entry = callOf(args, pending);
  if (!entry) return fail('invalid_args');
  const ledger = found.ledger, existing = ledger.calls.find(c => c.callId === entry.callId);
  if (existing) {
    // A claim remains a duplicate even after settlement. Never replay transport.
    const same = pending ? existing.startedAt === entry.startedAt && SCOPE.every(k => existing[k] === entry[k])
      : equal({ ...existing, revision: 1 }, entry);
    return same ? success(ledger, existing, true) : fail('conflict');
  }
  const time = pending ? entry.startedAt : entry.endedAt;
  if (entry.startedAt < Math.max(windowFrom(ledger), time - OPERATIONAL_LEDGER_LIMITS.retentionMs)) return fail('outside_retention');
  try {
    const rotated = rotate(ledger, time, entry.startedAt);
    return publish(root, { ...rotated, calls: [...rotated.calls, entry] }, entry);
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
  const ledger = found.ledger, index = ledger.calls.findIndex(c => c.callId === args.callId);
  if (index < 0) return fail('not_found');
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
  if (previous.status !== 'pending') return equal(previous, entry) ? success(ledger, previous, true) : fail('conflict');
  const calls = ledger.calls.slice();
  calls[index] = entry;
  try { return publish(root, rotate({ ...ledger, calls }, args.endedAt), entry); }
  catch { return fail('overflow'); }
}

export function recordOperationalEvent(root, args) {
  const found = writable(root, args);
  if (!found.ok) return found;
  const entry = eventOf(args);
  if (!entry) return fail('invalid_args');
  const ledger = found.ledger, existing = ledger.events.find(e => e.eventId === entry.eventId);
  if (existing) return equal(existing, entry) ? success(ledger, existing, true) : fail('conflict');
  if (entry.time < windowFrom(ledger)) return fail('outside_retention');
  try {
    const rotated = rotate(ledger, entry.time);
    return publish(root, { ...rotated, events: [...rotated.events, entry] }, entry);
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

export function queryModelUsage(root, args) {
  if (!queryArgs(args, SCOPE)) return fail('invalid_args');
  const found = read(root);
  if (!found.ok) return found;
  const calls = found.ledger.calls.filter(c => c.startedAt >= args.from && c.startedAt < args.to && matches(c, args, SCOPE));
  try {
    const result = aggregates(calls), covered = coverage(found.ledger, args);
    // Do not convert a missing interval into a reported zero, even when the
    // retained rows happen to contain only completely known usage.
    projectStats(result.stats, covered);
    for (const day of result.days) {
      const start = Date.parse(`${day.day}T00:00:00.000Z`);
      day.coverage = coverage(found.ledger, { from: Math.max(start, args.from), to: Math.min(start + DAY, args.to) });
      projectStats(day.stats, day.coverage);
    }
    return { ok: true, revision: found.ledger.revision, from: args.from, to: args.to,
      ...result, coverage: covered, pressure: pressure(found.ledger) };
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
    totalCount: covered.complete ? events.length : null, events: clone(events), coverage: covered, pressure: pressure(found.ledger) };
}
