import assert from 'node:assert/strict';
import {
  OPERATIONAL_LEDGER_LIMITS, normalizeModelUsage, claimModelCall, settleModelCall,
  recordModelCall, queryModelUsage, recordOperationalEvent, queryOperationalEvents,
} from '../src/operational-ledger.js';
import { MemoryRuntime } from '../src/memory-runtime.js';

// Entirely in-memory fixtures: no files, local services, paid model calls or IO.
const DAY = 86400000, T = Date.UTC(2026, 9, 28);
const scope = { logicalBotId: 'account:alpha', accountId: 'alpha', conversationId: 'group:100', kind: 'chat', model: 'provider/model-1' };
const input = (callId, extra = {}) => ({ callId, startedAt: T, ...scope, ...extra });
const terminal = (callId, extra = {}) => input(callId, { endedAt: T + 100, status: 'confirmed', ...extra });
const usage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 0, reasoningTokens: 2 };
const unknown = Object.fromEntries(Object.keys(usage).map(k => [k, null]));
const range = { from: T, to: T + DAY * 400 };
const query = (root, extra = {}) => queryModelUsage(root, { ...range, ...extra });
const event = (eventId, extra = {}) => ({ eventId, code: 'MODEL_TIMEOUT', severity: 'warning',
  accountId: 'alpha', logicalBotId: 'account:alpha', feature: 'chat', time: T, ...extra });
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
function unchanged(root, operation, reason) {
  const before = structuredClone(root);
  const result = operation();
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  if (reason === 'capacity') { assert.ok(result.resource); assert.ok(result.pressure); }
  assert.deepEqual(root, before);
}

assert.deepEqual(normalizeModelUsage(null), unknown);
assert.deepEqual(normalizeModelUsage('12 tokens'), unknown);
assert.deepEqual(normalizeModelUsage({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
  prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 2 } }), usage);
assert.deepEqual(normalizeModelUsage({ input_tokens: 12, output_tokens: 4, total_tokens: 16,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }), usage);
assert.deepEqual(normalizeModelUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), { ...unknown, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', true, {}, [], null]) {
  assert.equal(normalizeModelUsage({ prompt_tokens: bad }).inputTokens, null);
}
assert.equal(normalizeModelUsage({ prompt_tokens: 12, input_tokens: 13 }).inputTokens, null);
assert.equal(normalizeModelUsage({ prompt_tokens: 12, input_tokens: '12' }).inputTokens, null);
assert.equal(normalizeModelUsage({ inputTokens: 12, outputTokens: 4 }).totalTokens, null);
assert.equal(normalizeModelUsage({ ...usage, totalTokens: 100 }).totalTokens, null);
assert.equal(normalizeModelUsage({ ...usage, cachedInputTokens: 13 }).cachedInputTokens, null);
assert.equal(normalizeModelUsage({ ...usage, reasoningTokens: 5 }).reasoningTokens, null);
let getterCalls = 0;
const accessor = Object.defineProperty({}, 'inputTokens', { enumerable: true, get() { getterCalls++; return 12; } });
assert.deepEqual(normalizeModelUsage(accessor), unknown);
assert.equal(getterCalls, 0);

const root = { legacy: { keep: true } }, legacy = root.legacy;
assert.equal(query(freeze({})).stats.callCount, 0);
assert.deepEqual(root, { legacy: { keep: true } });
assert.equal(queryOperationalEvents({}, range).count, 0);
assert.equal(ownLedger(root), false);
function ownLedger(x) { return Object.hasOwn(x, 'operationalLedger'); }

const claimed = claimModelCall(root, input('one'));
assert.equal(claimed.ok, true);
assert.equal(claimed.shouldCall, true);
assert.equal(claimed.entry.status, 'pending');
assert.deepEqual(claimed.entry.usage, unknown);
assert.equal(root.legacy, legacy);
claimed.entry.accountId = 'do-not-alias';
let stats = query(root).stats;
assert.equal(stats.callCount, 1);
assert.equal(stats.pendingCallCount, 1);
assert.equal(stats.unknownCallCount, 1);
assert.deepEqual(stats.tokens.totalTokens, { knownTokens: 0, knownCalls: 0, unknownCalls: 1, total: null });
const sameClaim = claimModelCall(root, input('one'));
assert.equal(sameClaim.duplicate, true);
assert.equal(sameClaim.shouldCall, false);
assert.equal(sameClaim.revision, 1);
unchanged(root, () => claimModelCall(root, input('one', { accountId: 'beta' })), 'conflict');
unchanged(root, () => claimModelCall(root, input('two', { expectedRevision: 0 })), 'stale_revision');
unchanged(root, () => settleModelCall(root, { callId: 'one', endedAt: T + 100, status: 'confirmed', expectedCallRevision: 0 }), 'stale_revision');
unchanged(root, () => settleModelCall(root, { callId: 'missing', endedAt: T + 100, status: 'confirmed' }), 'not_found');
unchanged(root, () => settleModelCall(root, { callId: 'one', endedAt: T - 1, status: 'confirmed' }), 'invalid_args');
unchanged(root, () => settleModelCall(root, { callId: 'one', endedAt: T + 100, status: 'confirmed', model: 'other' }), 'conflict');
const settlement = { callId: 'one', endedAt: T + 100, status: 'confirmed', usage };
assert.equal(settleModelCall(root, { ...settlement, expectedCallRevision: 1, expectedRevision: 1 }).ok, true);
assert.equal(settleModelCall(root, settlement).duplicate, true);
assert.equal(recordModelCall(root, terminal('one', { usage })).duplicate, true);
assert.equal(root.operationalLedger.revision, 2);
assert.equal(claimModelCall(root, input('one')).shouldCall, false);
unchanged(root, () => settleModelCall(root, { ...settlement, status: 'failed' }), 'conflict');
unchanged(root, () => settleModelCall(root, { ...settlement, usage: { ...usage, inputTokens: 50 } }), 'conflict');
unchanged(root, () => settleModelCall(root, { ...settlement, expectedCallRevision: 1 }), 'stale_revision');

assert.equal(recordModelCall(root, terminal('two', { status: 'failed', accountId: 'beta', logicalBotId: 'account:beta',
  conversationId: 'private:200', kind: 'task', model: 'model-2', usage: { inputTokens: 3 } })).ok, true);
assert.equal(recordModelCall(root, terminal('three', { startedAt: T + DAY, endedAt: T + DAY + 1, status: 'uncertain' })).ok, true);
assert.equal(recordModelCall(root, terminal('four', { usage })).ok, true);
assert.equal(recordModelCall(root, terminal('four', { usage })).duplicate, true);
stats = query(root).stats;
assert.equal(stats.callCount, 4);
assert.equal(stats.knownCallCount, 2);
assert.equal(stats.unknownCallCount, 2);
assert.equal(stats.confirmedCallCount, 2);
assert.equal(stats.failedCallCount, 1);
assert.equal(stats.uncertainCallCount, 1);
assert.equal(stats.pendingCallCount, 0);
assert.deepEqual(stats.tokens.inputTokens, { knownTokens: 27, knownCalls: 3, unknownCalls: 1, total: null });
assert.deepEqual(stats.tokens.totalTokens, { knownTokens: 32, knownCalls: 2, unknownCalls: 2, total: null });
assert.equal(stats.cost.unknownCalls, 4);
assert.equal(query(root).days.length, 3);
for (const filter of [{ logicalBotId: 'account:beta' }, { accountId: 'beta' }, { conversationId: 'private:200' }, { kind: 'task' }, { model: 'model-2' }]) {
  assert.equal(query(root, filter).stats.callCount, 1);
}
assert.equal(query(root, { logicalBotId: 'account:alpha', accountId: 'beta' }).stats.callCount, 0);
assert.equal(query(root, { from: T, to: T + 1 }).stats.callCount, 3);
assert.equal(query(root, { from: T + 1, to: T + DAY }).stats.callCount, 0);
assert.equal(query(root, { from: T + DAY, to: T + DAY + 1 }).stats.callCount, 1);
assert.equal(query(root, { from: T, to: T }).stats.callCount, 0);
assert.equal(query(root, { from: T + 1, to: T }).reason, 'invalid_args');
assert.equal(query(root, { accountId: undefined }).reason, 'invalid_args');
const detached = query(root);
detached.days[0].stats.callCount = -100;
assert.equal(query(root).stats.callCount, 4);
assert.equal(query(freeze(structuredClone(root))).ok, true);

const prices = { verified: true, model: scope.model, currency: 'USD', source: 'host-verified-2026-10',
  inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000, cachedInputMicrosPerMillionTokens: 100000 };
const priced = {};
assert.equal(recordModelCall(priced, terminal('paid', { usage, verifiedPrices: prices })).entry.cost.amountMicros, 20);
assert.equal(recordModelCall(priced, terminal('cached', { usage: { ...usage, cachedInputTokens: 2 }, verifiedPrices: prices })).entry.cost.amountMicros, 19);
for (const [id, verifiedPrices, u] of [
  ['unverified', { ...prices, verified: false }, usage], ['wrong-model', { ...prices, model: 'other' }, usage],
  ['currency', { ...prices, currency: 'unknown' }, usage], ['unknown-cached', prices, { ...usage, cachedInputTokens: null }],
  ['missing-cached-rate', { ...prices, cachedInputMicrosPerMillionTokens: undefined }, { ...usage, cachedInputTokens: 2 }],
  ['string-rate', { ...prices, inputMicrosPerMillionTokens: '1' }, usage],
]) assert.equal(recordModelCall(priced, terminal(id, { usage: u, verifiedPrices })).entry.cost, null);
assert.deepEqual(query(priced).stats.cost, { knownCalls: 2, unknownCalls: 6, byCurrency: [{ currency: 'USD', amountMicros: 39 }] });
assert.equal(recordModelCall(priced, terminal('eur', { usage, verifiedPrices: { ...prices, currency: 'EUR' } })).ok, true);
assert.equal(query(priced).stats.cost.byCurrency.length, 2); // No currency conversion.

const events = {};
assert.equal(recordOperationalEvent(events, event('outage', { recoveryAction: 'retry-manually', error: 'never-persist', prompt: 'private-content' })).ok, true);
assert.equal(recordOperationalEvent(events, event('outage', { recoveryAction: 'retry-manually' })).duplicate, true);
assert.equal(recordOperationalEvent(events, event('recovered', { time: T + 1, resolved: true, severity: 'info' })).ok, true);
assert.equal(recordOperationalEvent(events, event('global', { accountId: null, logicalBotId: null, feature: 'repository' })).ok, true);
assert.equal(queryOperationalEvents(events, { ...range, resolved: true }).count, 1);
assert.equal(queryOperationalEvents(events, { ...range, feature: 'chat', accountId: 'alpha' }).count, 2);
assert.equal(queryOperationalEvents(events, { from: T, to: T + 1, logicalBotId: 'account:alpha' }).count, 1);
assert.equal(queryOperationalEvents(events, { ...range, severity: 'warning', code: 'MODEL_TIMEOUT' }).count, 2);
unchanged(events, () => recordOperationalEvent(events, event('outage', { resolved: true })), 'conflict');
unchanged(events, () => recordOperationalEvent(events, event('raw', { code: 'error includes private content' })), 'invalid_args');
assert.doesNotMatch(JSON.stringify(events), /never-persist|private-content|prompt|"error"/);
const queriedEvents = queryOperationalEvents(events, range);
queriedEvents.events[0].code = 'changed';
assert.equal(queryOperationalEvents(events, range).events[0].code, 'MODEL_TIMEOUT');

// Current status folds the WHOLE retained journal before time/resolved/severity
// filtering. A later resolution must never resurrect its historical failure.
const currentQuery = (r, extra = {}) => queryOperationalEvents(r, { ...range, currentOnly: true, ...extra });
const eventsBeforeCurrent = structuredClone(events);
assert.equal(currentQuery(events, { resolved: false, accountId: 'alpha' }).count, 0);
assert.equal(currentQuery(events, { resolved: true, accountId: 'alpha' }).events[0].eventId, 'recovered');
assert.equal(currentQuery(events, { resolved: false }).count, 1); // Independent global repository status.
assert.equal(currentQuery(events, { from: T, to: T + 1, feature: 'chat' }).count, 0);
assert.equal(currentQuery(events, { from: T, to: T + 1, feature: 'chat', resolved: false }).count, 0);
assert.equal(currentQuery(events, { from: T + 1, to: T + 2, feature: 'chat', resolved: true }).count, 1);
assert.equal(currentQuery(events, { severity: 'warning', feature: 'chat' }).count, 0);
assert.equal(queryOperationalEvents(events, { ...range, resolved: false, accountId: 'alpha' }).count, 1);
assert.deepEqual(queryOperationalEvents(events, { ...range, currentOnly: false }), queryOperationalEvents(events, range));
assert.deepEqual(events, eventsBeforeCurrent);
assert.equal(currentQuery(freeze(structuredClone(events))).ok, true);
const detachedCurrent = currentQuery(events);
detachedCurrent.events[0].resolved = !detachedCurrent.events[0].resolved;
assert.deepEqual(currentQuery(events), currentQuery(eventsBeforeCurrent));
for (const bad of ['true', 1, null, undefined, {}]) {
  unchanged(events, () => currentQuery(events, { currentOnly: bad }), 'invalid_args');
}

const perAccount = {};
const shared = { logicalBotId: 'group:shared', code: 'MODEL_CALL_FAILED' };
const appendCurrent = (id, extra = {}) => {
  const result = recordOperationalEvent(perAccount, event(id, { ...shared, ...extra }));
  assert.equal(result.ok, true);
  return result;
};
appendCurrent('alpha-failure');
appendCurrent('beta-failure', { accountId: 'beta', time: T + 1 });
appendCurrent('alpha-resolution', { time: T + 2, severity: 'info', resolved: true });
appendCurrent('alpha-backdated-failure', { time: T + 1 }); // Append order cannot override a newer time.
appendCurrent('other-logical-failure', { logicalBotId: 'account:other' });
appendCurrent('other-feature-failure', { feature: 'task' });
appendCurrent('other-code-failure', { code: 'OTHER_FAILURE' });
const sameStatus = { logicalBotId: shared.logicalBotId, code: shared.code, feature: 'chat' };
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'alpha', resolved: false }).count, 0);
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'beta', resolved: false }).events[0].eventId, 'beta-failure');
assert.equal(currentQuery(perAccount, { ...sameStatus, resolved: true }).events[0].accountId, 'alpha');
assert.equal(currentQuery(perAccount, { ...sameStatus }).count, 2);
assert.equal(currentQuery(perAccount, { ...sameStatus, severity: 'warning' }).count, 1);
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'alpha', to: T + 2 }).count, 0);
assert.equal(currentQuery(perAccount, { accountId: 'alpha', resolved: false }).count, 3);
assert.equal(currentQuery(perAccount).count, 5);

// Equal timestamps use persisted append order, not arbitrary eventId sorting.
appendCurrent('zz-tied-failure', { time: T + 10 });
appendCurrent('aa-tied-resolution', { time: T + 10, resolved: true });
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'alpha', resolved: false }).count, 0);
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'alpha' }).events[0].eventId, 'aa-tied-resolution');
appendCurrent('reopened', { time: T + 10 });
assert.equal(currentQuery(perAccount, { ...sameStatus, accountId: 'alpha', resolved: false }).events[0].eventId, 'reopened');
assert.equal(appendCurrent('aa-tied-resolution', { time: T + 10, resolved: true }).duplicate, true);
assert.equal(currentQuery(JSON.parse(JSON.stringify(perAccount)), { ...sameStatus, accountId: 'alpha' }).events[0].eventId, 'reopened');

const secretRoot = {};
recordModelCall(secretRoot, terminal('safe', { usage: { ...usage, prompt: 'never-persist' }, error: 'never-persist', prompt: 'never-persist', text: 'never-persist', provider: 'never-persist' }));
assert.doesNotMatch(JSON.stringify(secretRoot), /never-persist|"prompt"|"provider"|"text"/);
for (const badState of [null, { operationalLedger: null }, { operationalLedger: { version: 99 } },
  { ...structuredClone(root), operationalLedger: { ...root.operationalLedger, revision: 999 } },
  { ...structuredClone(root), operationalLedger: { ...root.operationalLedger, days: [] } }]) {
  unchanged(badState, () => recordModelCall(badState, terminal('no-write')), 'invalid_state');
  assert.equal(query(badState).reason, 'invalid_state');
}
const broken = structuredClone(root);
broken.operationalLedger.calls[0].usage.inputTokens = -1;
unchanged(broken, () => claimModelCall(broken, input('no-write')), 'invalid_state');
const dangerous = structuredClone(root);
Object.defineProperty(dangerous.operationalLedger.days[0], 'day', { enumerable: true, get() { getterCalls++; return '2026-10-28'; } });
assert.equal(query(dangerous).reason, 'invalid_state');
assert.equal(getterCalls, 0);
unchanged(Object.freeze({}), () => claimModelCall(Object.freeze({}), input('no-write')), 'invalid_state');

const overflow = {};
assert.equal(recordModelCall(overflow, terminal('huge', { usage: { totalTokens: Number.MAX_SAFE_INTEGER } })).ok, true);
unchanged(overflow, () => recordModelCall(overflow, terminal('overflow', { usage: { totalTokens: 1 } })), 'overflow');

// Large canonical fixtures avoid O(n^2) SETUP while exercising real validation,
// boundary writes, exact queries, rotation and restart at production-size caps.
function multiply(value, count) {
  if (typeof value === 'number') return value * count;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => multiply(v, count));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, multiply(v, count)]));
}
function fixture(count, { pending = false, dimensions = false, days = 1, unknownUsage = false } = {}) {
  const seed = {};
  const saved = pending ? claimModelCall(seed, input('seed')) : recordModelCall(seed, terminal('seed', { usage: unknownUsage ? null : usage }));
  assert.equal(saved.ok, true);
  const l = structuredClone(seed.operationalLedger), templateDay = l.days[0], buckets = new Map();
  l.calls = Array.from({ length: count }, (_, i) => {
    const offset = i % days;
    const c = { ...saved.entry, usage: { ...saved.entry.usage }, callId: `call-${i}`, startedAt: T + offset * DAY,
      endedAt: pending ? null : T + offset * DAY + 100,
      conversationId: dimensions ? `group:${100 + i}` : scope.conversationId };
    const d = { ...templateDay, day: new Date(c.startedAt).toISOString().slice(0, 10), conversationId: c.conversationId };
    const key = JSON.stringify({ day: d.day, ...Object.fromEntries(['logicalBotId', 'accountId', 'conversationId', 'kind', 'model'].map(k => [k, c[k]])) });
    if (!buckets.has(key)) buckets.set(key, { day: d, count: 0 });
    buckets.get(key).count++;
    return c;
  });
  l.days = [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([, b]) => ({ ...b.day, stats: multiply(templateDay.stats, b.count) }));
  l.revision = count;
  l.retention.through = T + (Math.min(count, days) - 1) * DAY + (pending ? 0 : 100);
  return { operationalLedger: l };
}
function eventFixture(count) {
  const seed = {};
  const saved = recordOperationalEvent(seed, event('seed'));
  seed.operationalLedger.events = Array.from({ length: count }, (_, i) => ({ ...saved.entry, eventId: `event-${i}` }));
  seed.operationalLedger.revision = count;
  return seed;
}

assert.ok(OPERATIONAL_LEDGER_LIMITS.calls > 14000);
assert.ok(OPERATIONAL_LEDGER_LIMITS.completedCalls >= 50000);
assert.ok(OPERATIONAL_LEDGER_LIMITS.dayAggregates >= 20000);
assert.equal(OPERATIONAL_LEDGER_LIMITS.retentionMs, 7 * DAY);
const full = fixture(OPERATIONAL_LEDGER_LIMITS.pendingCalls, { pending: true });
unchanged(full, () => claimModelCall(full, input('over-pending')), 'capacity');
unchanged(full, () => claimModelCall(full, input('over-pending-future', { startedAt: T + 8 * DAY })), 'capacity');
assert.equal(claimModelCall(full, input('call-0')).shouldCall, false);
assert.equal(settleModelCall(full, { callId: 'call-0', endedAt: T + 1, status: 'uncertain' }).ok, true);
assert.equal(claimModelCall(full, input('new-pending')).ok, true);
assert.equal(query(full).stats.unknownCallCount, OPERATIONAL_LEDGER_LIMITS.pendingCalls + 1);
const fullCalls = fixture(OPERATIONAL_LEDGER_LIMITS.calls - 1);
const reserved = claimModelCall(fullCalls, input('reserved'));
assert.equal(reserved.ok, true);
assert.ok(reserved.pressure.nearCapacity.includes('calls'));
unchanged(fullCalls, () => claimModelCall(fullCalls, input('over-calls')), 'capacity');
assert.equal(settleModelCall(fullCalls, { callId: 'reserved', endedAt: T + 100, status: 'confirmed', usage }).ok, true);
assert.equal(claimModelCall(fullCalls, input('reserved')).shouldCall, false);
// Future write rotates EXPIRED terminals before checking capacity: chat resumes.
assert.equal(claimModelCall(fullCalls, input('after-window', { startedAt: T + 8 * DAY })).ok, true);
assert.equal(fullCalls.operationalLedger.calls.length, 1);
assert.equal(fullCalls.operationalLedger.retention.prunedUsage.callCount, OPERATIONAL_LEDGER_LIMITS.calls);
assert.equal(fullCalls.operationalLedger.retention.prunedUsage.tokens.totalTokens.knownTokens, OPERATIONAL_LEDGER_LIMITS.calls * 16);
unchanged(fullCalls, () => claimModelCall(fullCalls, input('call-0')), 'outside_retention');

const fullDays = fixture(OPERATIONAL_LEDGER_LIMITS.dayAggregates, { dimensions: true });
unchanged(fullDays, () => claimModelCall(fullDays, input('over-day', { conversationId: 'group:999999' })), 'capacity');
assert.equal(claimModelCall(fullDays, input('existing-day')).ok, true);
assert.equal(settleModelCall(fullDays, { callId: 'existing-day', endedAt: T + 100, status: 'uncertain' }).ok, true);
assert.equal(claimModelCall(fullDays, input('rotated-day', { startedAt: T + 8 * DAY, conversationId: 'group:999999' })).ok, true);
assert.equal(fullDays.operationalLedger.days.length, 1);
const fullEvents = eventFixture(OPERATIONAL_LEDGER_LIMITS.events);
unchanged(fullEvents, () => recordOperationalEvent(fullEvents, event('over-event')), 'capacity');
assert.equal(recordOperationalEvent(fullEvents, event('event-0')).duplicate, true);
assert.equal(claimModelCall(fullEvents, input('chat-independent-of-event-cap')).ok, true);
assert.equal(recordOperationalEvent(fullEvents, event('after-window', { time: T + 8 * DAY })).ok, true);
assert.equal(fullEvents.operationalLedger.events.length, 1);
assert.equal(fullEvents.operationalLedger.retention.prunedEventCount, OPERATIONAL_LEDGER_LIMITS.events);

// JSON restart preserves an uncertain pending claim and forbids transport replay.
const restarted = JSON.parse(JSON.stringify(full));
assert.equal(claimModelCall(restarted, input('call-1')).shouldCall, false);
assert.equal(query(restarted).stats.pendingCallCount, OPERATIONAL_LEDGER_LIMITS.pendingCalls);
assert.equal(query(restarted).stats.tokens.totalTokens.total, null);

// >14k/week, seven-day exact retained queries, explicit unknowns on BOTH sides.
const weeklyCount = 14007, weekly = fixture(weeklyCount, { days: 7 });
assert.equal(recordOperationalEvent(weekly, event('week-end', { time: T + 7 * DAY - 1 })).ok, true);
let week = query(weekly, { from: T, to: T + 7 * DAY });
assert.equal(week.coverage.complete, true);
assert.equal(week.stats.totalCallCount, weeklyCount);
assert.equal(week.stats.tokens.totalTokens.total, weeklyCount * 16);
assert.equal(week.days.length, 7);
assert.equal(query(weekly, { from: T - 1, to: T + 7 * DAY }).coverage.complete, false);
assert.equal(query(weekly, { from: T - 1, to: T + 7 * DAY }).stats.tokens.totalTokens.total, null);
assert.equal(query(weekly, { from: T - 1, to: T + 7 * DAY }).days[0].coverage.complete, true);
assert.equal(query(weekly, { from: T, to: T + 7 * DAY + 1 }).stats.totalCallCount, null);
assert.equal(query({}, { from: T, to: T + 1 }).coverage.complete, false);
assert.equal(query({}, { from: T, to: T + 1 }).stats.tokens.totalTokens.total, null);
assert.equal(query({}, { from: T, to: T }).coverage.complete, true);
assert.equal(query(weekly, { from: T, to: T + 7 * DAY, accountId: 'absent' }).stats.tokens.totalTokens.total, 0);
assert.equal(claimModelCall(weekly, input('direct-chat-after-14k', { startedAt: T + 7 * DAY })).ok, true);
assert.equal(settleModelCall(weekly, { callId: 'direct-chat-after-14k', endedAt: T + 7 * DAY, status: 'confirmed', usage }).ok, true);
assert.equal(query(weekly).stats.callCount, weeklyCount + 1);
assert.equal(claimModelCall(JSON.parse(JSON.stringify(weekly)), input('call-0')).shouldCall, false);

// Unknowns are preserved in the bounded global retired summary, not rewritten as
// known zeros. Old pending claims stay pinned and may settle after the window.
const rotateUnknown = fixture(2, { unknownUsage: true });
assert.equal(claimModelCall(rotateUnknown, input('pinned')).ok, true);
const beforeRotation = structuredClone(rotateUnknown);
unchanged(rotateUnknown, () => claimModelCall(rotateUnknown, input('stale-CAS', { startedAt: T + 8 * DAY, expectedRevision: 0 })), 'stale_revision');
assert.deepEqual(rotateUnknown, beforeRotation);
assert.equal(claimModelCall(rotateUnknown, input('fresh', { startedAt: T + 8 * DAY })).ok, true);
assert.equal(rotateUnknown.operationalLedger.retention.prunedUsage.unknownCallCount, 2);
assert.equal(rotateUnknown.operationalLedger.retention.prunedUsage.tokens.totalTokens.unknownCalls, 2);
assert.equal(rotateUnknown.operationalLedger.retention.prunedUsage.tokens.totalTokens.total, null);
assert.equal(claimModelCall(rotateUnknown, input('pinned')).shouldCall, false);
assert.equal(settleModelCall(rotateUnknown, { callId: 'pinned', endedAt: T + 8 * DAY, status: 'uncertain' }).ok, true);
assert.equal(settleModelCall(rotateUnknown, { callId: 'pinned', endedAt: T + 8 * DAY, status: 'uncertain' }).duplicate, true);
assert.equal(query(rotateUnknown, { from: T, to: T + 1 }).stats.totalCallCount, null);
assert.equal(query(rotateUnknown, { from: T, to: T + 1 }).days[0].coverage.complete, false);
assert.equal(query(rotateUnknown, { from: T, to: T + 1 }).days[0].stats.totalCallCount, null);
assert.equal(queryOperationalEvents(fullEvents, { from: T, to: T + 1 }).totalCount, null);

// Compatible v1 reading is non-mutating; durable mutation upgrades to v2.
const legacyLedger = fixture(2);
legacyLedger.operationalLedger.version = 1;
delete legacyLedger.operationalLedger.retention;
const legacyBefore = structuredClone(legacyLedger);
assert.equal(query(legacyLedger).stats.callCount, 2);
assert.deepEqual(legacyLedger, legacyBefore);
assert.equal(claimModelCall(legacyLedger, input('upgrade')).ok, true);
assert.equal(legacyLedger.operationalLedger.version, 2);
assert.equal(legacyLedger.operationalLedger.revision, 3);

// Actual MemoryRuntime transaction lane, backed ONLY by an in-memory CAS mock.
let stored = {}, revision = 0, rejectCommit = false;
const repository = {
  async open() { return { value: structuredClone(stored), revision }; },
  async commit(draft, { expectedRevision }) {
    assert.equal(expectedRevision, revision);
    if (rejectCommit) throw new Error('MOCK_DURABILITY_FAILURE');
    stored = structuredClone(draft); revision++;
    return { value: structuredClone(stored), revision };
  },
  status() { return {}; }, async close() {},
};
const runtime = new MemoryRuntime(repository);
await runtime.open();
const both = await Promise.all([runtime.transact(draft => claimModelCall(draft, input('serial'))),
  runtime.transact(draft => claimModelCall(draft, input('serial')))]);
assert.deepEqual(both.map(x => x.shouldCall), [true, false]);
assert.equal(query(runtime.value).stats.pendingCallCount, 1);
rejectCommit = true;
await assert.rejects(runtime.transact(draft => settleModelCall(draft, { callId: 'serial', endedAt: T + 1, status: 'confirmed', usage })), /MOCK_DURABILITY_FAILURE/);
assert.equal(query(runtime.value).stats.pendingCallCount, 1);
assert.equal(query(stored).stats.pendingCallCount, 1);
rejectCommit = false;
assert.equal((await runtime.transact(draft => settleModelCall(draft, { callId: 'serial', endedAt: T + 1, status: 'uncertain' }))).ok, true);
await runtime.close();
console.log('operational ledger self-test passed');
