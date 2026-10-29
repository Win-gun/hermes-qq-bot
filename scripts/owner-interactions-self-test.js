import assert from 'node:assert/strict';
import { recordOwnerInteraction as record, queryOwnerInteractions as query,
  OWNER_INTERACTION_LIMITS as limits } from '../src/owner-interactions.js';

const DAY = 86400000, start = Date.parse('2026-10-01T00:00:00Z');
const event = (changes = {}) => ({ logicalBotId: 'account:alpha', accountId: 'alpha',
  conversationId: 'group:10001', messageId: 'one', direction: 'received', at: start, now: start, ...changes });
let checks = 0;
const check = fn => { fn(); checks++; };
const range = (from = start, to = start + 1, rest = {}) => ({ from, to, ...rest });

{
  const root = {}, before = JSON.stringify(root), q = query(root, range());
  check(() => assert.equal(q.coverage, 'not_started'));
  check(() => assert.deepEqual([q.received, q.sent, q.groupMessages, q.privateMessages, q.observed], Array(5).fill(null)));
  check(() => assert.equal(JSON.stringify(root), before));
}
{
  const root = {};
  check(() => assert.equal(record(root, event()).recorded, true));
  check(() => assert.equal(record(root, event()).duplicate, true));
  const restarted = JSON.parse(JSON.stringify(root));
  check(() => assert.equal(record(restarted, event({ now: start + DAY })).duplicate, true));
  check(() => assert.equal(restarted.ownerInteractions.days.length, 1));
  check(() => assert.equal(query(restarted, range()).received, 1));
  check(() => assert.equal(query(restarted, range(start + DAY, start + DAY + 1)).received, 0));
  check(() => assert.equal(query(restarted, range(start, start + DAY)).received, 1));
  // Same ID in another conversation/account/logical bot/direction/original day
  // is distinct. Bare group IDs canonicalize to the group namespace.
  check(() => assert.equal(record(root, event({ conversationId: '10001' })).duplicate, true));
  for (const delta of [{ conversationId: 'private:10001' }, { accountId: 'beta' },
    { logicalBotId: 'account:beta' }, { direction: 'sent' }, { at: start + DAY, now: start + DAY }])
    check(() => assert.equal(record(root, event(delta)).recorded, true));
  const q = query(root, range(start, start + DAY + 1));
  check(() => assert.equal(q.received, 5));
  check(() => assert.equal(q.sent, 1));
  check(() => assert.equal(q.groupMessages, 5));
  check(() => assert.equal(q.privateMessages, 1));
  check(() => assert.equal(q.days.length, 4));
  check(() => assert.equal(query(root, range(start, start + DAY + 1, { accountId: 'beta' })).received, 1));
  check(() => assert.equal(query(root, range(start, start + DAY + 1, { logicalBotId: 'account:beta' })).received, 1));
}
{
  const root = {};
  for (const flag of ['isBot', 'isSelf', 'senderIsBot'])
    check(() => assert.equal(record(root, event({ [flag]: true })).ignored, 'bot_or_self'));
  check(() => assert.equal(root.ownerInteractions, undefined));
  check(() => assert.equal(record(root, event({ direction: 'sent', isBot: true, messageId: -123 })).recorded, true));
  check(() => assert.equal(query(root, range()).received, 0));
  check(() => assert.equal(query(root, range()).sent, 1));
  const encoded = JSON.stringify(root);
  check(() => assert(!encoded.includes('10001') && !encoded.includes('-123')));
}
{
  const root = {};
  record(root, event({ text: 'PRIVATE_FIXTURE', content: 'PRIVATE_FIXTURE', userId: 'PRIVATE_FIXTURE' }));
  check(() => assert(!JSON.stringify(root).includes('PRIVATE_FIXTURE')));
  for (const delta of [{ messageId: '' }, { messageId: 0 }, { messageId: {} }, { conversationId: 'other:10001' },
    { logicalBotId: '__proto__' }, { accountId: 'a:constructor' }, { at: start + 1 }, { now: undefined }]) {
    const before = JSON.stringify(root);
    check(() => assert.equal(record(root, event(delta)).ok, false));
    check(() => assert.equal(JSON.stringify(root), before));
  }
}
{
  const root = {};
  record(root, event());
  record(root, event({ messageId: 'after-boundary', at: start + DAY, now: start + DAY }));
  check(() => assert.equal(query(root, range(start, start + DAY)).received, 1));
  check(() => assert.equal(query(root, range(start + DAY, start + DAY + 1)).received, 1));
  const before = JSON.stringify(root);
  check(() => assert.equal(query(root, range(start - 1, start + 1)).received, null));
  check(() => assert.equal(query(root, range(start, start + DAY + 2)).sent, null));
  check(() => assert.equal(JSON.stringify(root), before));
  check(() => assert.equal(query(root, range(start, start)).coverage, 'invalid'));
}
{
  const root = {};
  record(root, event());
  for (let d = 1; d <= 8; d++) record(root, event({ messageId: `day-${d}`, at: start + d * DAY, now: start + d * DAY }));
  const q = query(root, range(start + DAY, start + 8 * DAY));
  check(() => assert.equal(q.received, 7));
  check(() => assert.equal(q.days.length, 7));
  record(root, event({ messageId: 'late-original', at: start + 2 * DAY + 123, now: start + 8 * DAY }));
  check(() => assert.equal(query(root, range(start + 2 * DAY, start + 3 * DAY)).received, 2));
  check(() => assert.equal(query(root, range(start + 8 * DAY, start + 8 * DAY + 1)).received, 1));
}
{
  const root = {};
  record(root, event());
  record(root, event({ messageId: 'half-day', at: start + DAY / 2, now: start + DAY / 2 }));
  const now = start + limits.retentionMs + 1;
  record(root, event({ messageId: 'current', at: now, now }));
  check(() => assert.equal(root.ownerInteractions.events.length, 2));
  check(() => assert.equal(root.ownerInteractions.days.find(row => row.day === start).received, 2));
  check(() => assert.equal(record(root, event({ now })).ignored, 'expired'));
  check(() => assert.equal(query(root, range()).received, null));
  check(() => assert.equal(query(root, range(now, now + 1)).received, 1));
  const untouched = {};
  check(() => assert.equal(record(untouched, event({ now })).ignored, 'expired'));
  check(() => assert.equal(query(untouched, range()).coverage, 'not_started'));
}
{
  const root = {}, now = start + 10 * DAY;
  // A late first observation does not backdate the collection coverage; its
  // original message is attributed to the original day, never arrival day.
  record(root, event({ at: start + DAY, now }));
  const original = query(root, range(start + DAY, start + DAY + 1));
  check(() => assert.equal(original.received, null));
  check(() => assert.equal(original.observed.received, 1));
  check(() => assert.equal(query(root, range(now, now + 1)).received, 0));
  const before = JSON.stringify(root);
  query(root, range(now, now + DAY));
  check(() => assert.equal(JSON.stringify(root), before));
  // Backwards host clocks cannot rotate the retention window backwards.
  record(root, event({ messageId: 'old-clock', at: now, now: start }));
  check(() => assert.equal(root.ownerInteractions.watermark, now));
  check(() => assert.equal(query(root, range(now, now + 1)).received, 1));
}
{
  const root = {};
  record(root, event());
  const boundary = start + limits.retentionMs;
  record(root, event({ messageId: 'boundary', at: boundary, now: boundary }));
  check(() => assert.equal(record(root, event({ now: boundary })).duplicate, true));
  check(() => assert.equal(query(root, range()).received, 1));
  record(root, event({ messageId: 'after', at: boundary + 1, now: boundary + 1 }));
  check(() => assert.equal(record(root, event({ now: boundary + 1 })).ignored, 'expired'));
  check(() => assert.equal(root.ownerInteractions.events.length, 2));
}
{
  const root = {}; record(root, event());
  const state = root.ownerInteractions, sample = state.events[0];
  state.events = Array.from({ length: limits.events }, (_, i) => ({ ...sample, key: i.toString(16).padStart(64, '0') }));
  state.days[0].received = state.days[0].groupMessages = limits.events;
  const droppedAt = start + 100;
  check(() => assert.equal(record(root, event({ messageId: 'overflow', at: droppedAt, now: droppedAt })).reason, 'CAPACITY'));
  const q = query(root, range(start, droppedAt + 1));
  check(() => assert.equal(q.received, null));
  check(() => assert.equal(q.observed.received, limits.events));
  check(() => assert(q.incomplete && q.reasons.includes('CAPACITY')));
  check(() => assert.equal(query(root, range(start, droppedAt)).received, limits.events));
  check(() => assert.equal(query(root, range(start, droppedAt + 1, { accountId: 'unseen' })).received, null));
  check(() => assert.equal(state.events.length, limits.events));
  // Capacity does not evict good dedup rows or reset original day counts.
  state.events[0] = sample;
  check(() => assert.equal(record(root, event({ now: droppedAt })).duplicate, true));
  check(() => assert.equal(state.days[0].received, limits.events));
  const future = start + limits.retentionMs + DAY;
  check(() => assert.equal(record(root, event({ messageId: 'new-window', at: future, now: future })).recorded, true));
  check(() => assert.equal(query(root, range(future, future + 1)).coverage, 'complete'));
  check(() => assert.equal(state.gaps.length, 0));
}
{
  const root = {}; record(root, event());
  const state = root.ownerInteractions;
  state.days = Array.from({ length: limits.dayDimensions }, (_, i) => ({ ...state.days[0], accountId: `acct-${i}` }));
  check(() => assert.equal(record(root, event({ messageId: 'new-dimension', accountId: 'extra' })).reason, 'CAPACITY'));
  check(() => assert.equal(state.days.length, limits.dayDimensions));
  check(() => assert.equal(query(root, range()).coverage, 'partial'));
}
{
  const root = { ownerInteractions: { version: 900 } }, before = JSON.stringify(root);
  check(() => assert.equal(query(root, range()).received, null));
  check(() => assert.equal(record(root, event()).reason, 'INVALID_STATE'));
  check(() => assert.equal(JSON.stringify(root), before));
}
{
  const root = {}; record(root, event());
  root.ownerInteractions.events.push({ ...root.ownerInteractions.events[0] });
  const before = JSON.stringify(root);
  check(() => assert.equal(query(root, range()).coverage, 'invalid'));
  check(() => assert.equal(record(root, event()).reason, 'INVALID_STATE'));
  check(() => assert.equal(JSON.stringify(root), before));
}
console.log(JSON.stringify({ ok: true, checks, productionMessages: 0, modelCalls: 0 }));
