/**
 * Synchronous draft mutators ONLY: call inside the existing repository writer.
 * No IO, clock reads, replay, messages, model calls or content storage.
 * Times are trusted host epoch milliseconds. `at` MUST retain the original
 * event/ACK time on replay; `now` is mandatory and never moves backwards.
 * Received callers must filter real OneBot users before calling. Optional
 * isBot/isSelf/senderIsBot=true only suppress received events; absence is NOT
 * identity verification. Sent callers supply ONLY confirmed transport IDs.
 *
 * Exact timestamp detail and dedup survive a rolling 30 days (no within-window
 * eviction). UTC day/dimension aggregates survive until their whole day expires.
 * At capacity retain existing counts and mark missing time spans; NEVER halt
 * chat or count undeduplicated guesses. Queries are read-only; unknown totals
 * are null, with `observed` explicitly providing a retained lower bound.
 * Coverage starts at first ingestion's now, ends at latest ingestion now + 1ms.
 * A query cannot prove unobserved history/future, nor infer a running collector
 * from silence. Snapshots should show observed lower bounds when incomplete.
 */
import { createHash } from 'node:crypto';

const DAY = 86400000;
export const OWNER_INTERACTION_LIMITS = Object.freeze({
  retentionMs: 30 * DAY, events: 50000, dayDimensions: 4096,
});
const FIELDS = ['received', 'sent', 'groupMessages', 'privateMessages'];
const zeros = () => ({ received: 0, sent: 0, groupMessages: 0, privateMessages: 0 });
const unknowns = () => Object.fromEntries(FIELDS.map(key => [key, null]));
const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const time = value => Number.isSafeInteger(value) && value >= 0 && value < 253402300799999;
const atom = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && !value.split(/[.:]/).some(part => ['__proto__', 'prototype', 'constructor'].includes(part))
  && !/^(?:sk-|Bearer|password|secret|cookie|authorization|api[_-]?key)/i.test(value);
const dayOf = at => Math.floor(at / DAY) * DAY;
const dimensions = row => atom(row.logicalBotId) && atom(row.accountId);
const failure = reason => ({ ok: false, recorded: false, reason });
const countsValid = row => FIELDS.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
  && row.received + row.sent === row.groupMessages + row.privateMessages;

function conversation(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const match = /^(?:(group|private):)?([1-9]\d{0,19})$/.exec(String(value));
  return match ? { channel: match[1] === 'private' ? 'private' : 'group',
    key: `${match[1] || 'group'}:${match[2]}` } : null;
}
function message(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0 ? String(value) : null;
  return typeof value === 'string' && value !== '0' && /^-?[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value : null;
}
function validState(state) {
  if (!object(state) || state.version !== 1 || !time(state.startedAt) || !time(state.watermark)
    || state.watermark < state.startedAt || !Array.isArray(state.events)
    || state.events.length > OWNER_INTERACTION_LIMITS.events || !Array.isArray(state.days)
    || state.days.length > OWNER_INTERACTION_LIMITS.dayDimensions || !Array.isArray(state.gaps)
    || state.gaps.length > 31) return false;
  const events = new Set(), days = new Set(), gaps = new Set();
  return state.events.every(row => object(row) && dimensions(row) && hex(row.key) && !events.has(row.key)
    && (events.add(row.key), true) && time(row.at) && row.at <= state.watermark
    && ['received', 'sent'].includes(row.direction) && ['group', 'private'].includes(row.channel))
    && state.days.every(row => object(row) && dimensions(row) && time(row.day) && dayOf(row.day) === row.day
      && row.day <= state.watermark && countsValid(row)
      && !days.has(hash([row.day, row.logicalBotId, row.accountId]))
      && (days.add(hash([row.day, row.logicalBotId, row.accountId])), true))
    && state.gaps.every(row => object(row) && time(row.day) && dayOf(row.day) === row.day
      && time(row.from) && time(row.to) && row.from < row.to && dayOf(row.from) === row.day
      && row.to <= row.day + DAY && row.to <= state.watermark + 1 && !gaps.has(row.day)
      && (gaps.add(row.day), true));
}
function add(counts, row) {
  counts[row.direction] += 1;
  counts[row.channel === 'group' ? 'groupMessages' : 'privateMessages'] += 1;
}
function prune(state) {
  const cutoff = Math.max(0, state.watermark - OWNER_INTERACTION_LIMITS.retentionMs);
  state.events = state.events.filter(row => row.at >= cutoff);
  // Preserve the original full-day counts even when exact detail at the left
  // retention edge expires. Queries never use these to guess partial-day data.
  state.days = state.days.filter(row => row.day + DAY > cutoff);
  state.gaps = state.gaps.filter(row => row.to > cutoff)
    .map(row => ({ ...row, from: Math.max(row.from, cutoff) }));
}
function markGap(state, at) {
  const day = dayOf(at), gap = state.gaps.find(row => row.day === day);
  if (gap) { gap.from = Math.min(gap.from, at); gap.to = Math.max(gap.to, at + 1); }
  else state.gaps.push({ day, from: at, to: at + 1 });
}

export function recordOwnerInteraction(root, input = {}) {
  if (!object(root) || !object(input)) return failure('INVALID_INPUT');
  const { logicalBotId, accountId, conversationId, messageId, direction, at, now } = input;
  if (!dimensions(input) || !['received', 'sent'].includes(direction) || !time(at) || !time(now))
    return failure('INVALID_EVENT');
  if (direction === 'received' && (input.isBot === true || input.isSelf === true || input.senderIsBot === true))
    return { ok: true, recorded: false, ignored: 'bot_or_self' };
  const channel = conversation(conversationId), id = message(messageId);
  if (!channel || id === null) return failure('INVALID_ID');
  const old = root.ownerInteractions;
  if (old !== undefined && !validState(old)) return failure('INVALID_STATE');
  const watermark = Math.max(old?.watermark ?? now, now);
  if (at > watermark) return failure('FUTURE_EVENT');
  if (!old && at < Math.max(0, watermark - OWNER_INTERACTION_LIMITS.retentionMs))
    return { ok: true, recorded: false, ignored: 'expired' };
  const state = old ?? { version: 1, startedAt: now, watermark, events: [], days: [], gaps: [] };
  state.watermark = watermark;
  prune(state);
  root.ownerInteractions = state;
  if (at < Math.max(0, watermark - OWNER_INTERACTION_LIMITS.retentionMs))
    return { ok: true, recorded: false, ignored: 'expired' };
  // The original date is part of the namespace, not today's ingestion date.
  // JSON tuple encoding prevents concatenation collisions; raw message/private
  // IDs and message content are never retained.
  const key = hash(['owner-interactions:v1', dayOf(at), logicalBotId, accountId,
    channel.key, direction, id]);
  if (state.events.some(row => row.key === key)) return { ok: true, recorded: false, duplicate: true };
  let daily = state.days.find(row => row.day === dayOf(at)
    && row.logicalBotId === logicalBotId && row.accountId === accountId);
  if (state.events.length >= OWNER_INTERACTION_LIMITS.events
    || (!daily && state.days.length >= OWNER_INTERACTION_LIMITS.dayDimensions)) {
    markGap(state, at);
    return { ok: true, recorded: false, incomplete: true, reason: 'CAPACITY' };
  }
  const row = { key, at, logicalBotId, accountId, direction, channel: channel.channel };
  state.events.push(row);
  if (!daily) {
    daily = { day: dayOf(at), logicalBotId, accountId, ...zeros() };
    state.days.push(daily);
  }
  add(daily, row);
  return { ok: true, recorded: true, duplicate: false };
}

export function queryOwnerInteractions(root, options = {}) {
  const { from, to, logicalBotId, accountId } = object(options) ? options : {};
  const range = { from: time(from) ? from : null, to: time(to) ? to : null, boundary: '[from,to)', timezone: 'UTC' };
  const empty = (coverage, reasons) => ({ ...unknowns(), observed: null, unknown: true, incomplete: true,
    coverage, range, reasons, days: [] });
  if (!time(from) || !time(to) || from >= to || (logicalBotId !== undefined && !atom(logicalBotId))
    || (accountId !== undefined && !atom(accountId))) return empty('invalid', ['INVALID_QUERY']);
  if (!object(root)) return empty('invalid', ['INVALID_STATE']);
  const state = root.ownerInteractions;
  if (state === undefined) return empty('not_started', ['NOT_STARTED']);
  if (!validState(state)) return empty('invalid', ['INVALID_STATE']);
  const coverageFrom = Math.max(state.startedAt, state.watermark - OWNER_INTERACTION_LIMITS.retentionMs, 0);
  const coverageTo = state.watermark + 1;
  const reasons = [];
  if (from < coverageFrom) reasons.push('BEFORE_COVERAGE');
  if (to > coverageTo) reasons.push('AFTER_OBSERVATION');
  // Gaps are conservatively global: at capacity an arbitrary number of NEW
  // scope names must not create an unbounded per-scope "missing" dictionary.
  if (state.gaps.some(row => row.from < to && row.to > from)) reasons.push('CAPACITY');
  const observed = zeros(), days = new Map();
  for (const row of state.events) {
    if (row.at < from || row.at >= to || row.at < state.watermark - OWNER_INTERACTION_LIMITS.retentionMs
      || (logicalBotId !== undefined && row.logicalBotId !== logicalBotId)
      || (accountId !== undefined && row.accountId !== accountId)) continue;
    add(observed, row);
    const day = dayOf(row.at), key = hash([day, row.logicalBotId, row.accountId]);
    if (!days.has(key)) days.set(key, { day: new Date(day).toISOString().slice(0, 10),
      logicalBotId: row.logicalBotId, accountId: row.accountId, ...zeros() });
    add(days.get(key), row);
  }
  const incomplete = reasons.length > 0;
  return { ...(incomplete ? unknowns() : observed), observed, unknown: incomplete, incomplete,
    coverage: incomplete ? 'partial' : 'complete', range: { ...range, coverageFrom, coverageTo }, reasons,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)
      || a.logicalBotId.localeCompare(b.logicalBotId) || a.accountId.localeCompare(b.accountId))
      .map(row => ({ ...row, lowerBound: incomplete })),
    pressure: { events: state.events.length, eventLimit: OWNER_INTERACTION_LIMITS.events,
      dayDimensions: state.days.length, dayDimensionLimit: OWNER_INTERACTION_LIMITS.dayDimensions } };
}
