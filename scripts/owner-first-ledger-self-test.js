/**
 * Owner First 3.4 — worker C self-test.
 *
 * In-memory only: fake clock, fake sole writer, fake wire. No config, live
 * data, logs, credentials, disk, model, QQ or network access. Every claim is
 * asserted against the DURABLE draft, not a callback's return value.
 *
 * Covers the 3.4 acceptance items:
 *   1 missing provider usage stays unknown, never zero
 *   2 source timestamps (startedAt attribution, [from,to), retention fences)
 *   3 failed/uncertain ACK never recorded as success
 *   4 ledger corruption is rejected without mutation
 *   5 count boundaries and capacity backpressure
 *   6 two daily slots per local day, restart semantics, multiple event sources
 *   7 older suites still pass
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  OPERATIONAL_LEDGER_LIMITS, claimModelCall, settleModelCall, recordModelCall,
  recordOperationalEvent, queryModelUsage, queryOperationalEvents, normalizeModelUsage,
} from "../src/operational-ledger.js";
import { recordOwnerInteraction, queryOwnerInteractions, OWNER_INTERACTION_LIMITS } from "../src/owner-interactions.js";
import {
  normalizeOwnerNotifications, createOwnerNotificationCenter, getOwnerNotificationStatus,
  sanitizeOwnerNotificationFacts, formatOwnerNotificationSummary,
  OWNER_EVENT_CODES, describeOwnerEventCode, ownerFailureEventCode,
} from "../src/owner-notifications.js";

let checks = 0;
const check = (fn, label) => { try { fn(); checks += 1; } catch (error) { error.message = `${label}: ${error.message}`; throw error; } };
const DAY = 86400000, HOUR = 3600000;
const AT = Date.parse("2026-10-28T01:00:00Z");
const SCOPE = { logicalBotId: "account:alpha", accountId: "alpha", conversationId: "private:21001", kind: "chat", model: "model-a" };
const USAGE = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 0, reasoningTokens: 2 };
const clone = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

// --------------------------------------------------------------------------
// 1. Missing provider usage is unknown, never zero
// --------------------------------------------------------------------------
{
  const root = {};
  const claim = claimModelCall(root, { callId: "c-unknown", startedAt: AT, ...SCOPE });
  check(() => assert.equal(claim.ok, true, "claim succeeds"), "1.claim");
  check(() => assert.equal(claim.shouldCall, true, "new claim needs a call"), "1.shouldCall");
  check(() => assert.equal(claim.entry.status, "pending"), "1.pendingStatus");
  check(() => assert.deepEqual(Object.values(claim.entry.usage), [null, null, null, null, null]), "1.pendingUsageNull");

  // Settled with NO provider usage object at all (transport dropped it).
  const settle = settleModelCall(root, { callId: "c-unknown", endedAt: AT + 100, status: "confirmed" });
  check(() => assert.equal(settle.ok, true), "1.settle");
  check(() => assert.deepEqual(settle.entry.usage, { inputTokens: null, outputTokens: null, totalTokens: null,
    cachedInputTokens: null, reasoningTokens: null }), "1.missingUsageStaysNull");
  check(() => assert.equal(settle.entry.cost, null), "1.missingUsageNoCost");

  const usage = queryModelUsage(root, { from: AT, to: AT + 101 });
  check(() => assert.equal(usage.ok, true), "1.query");
  check(() => assert.equal(usage.stats.unknownCallCount, 1), "1.countedUnknown");
  check(() => assert.equal(usage.stats.knownCallCount, 0), "1.notKnown");
  check(() => assert.equal(usage.stats.tokens.inputTokens.total, null), "1.tokenTotalNull");
  check(() => assert.equal(usage.stats.tokens.inputTokens.knownTokens, 0), "1.knownTokensLowerBoundZero");
  check(() => assert.equal(usage.stats.totalCallCount, 1), "1.coveredTotal");
  // A range reaching past the last trusted write is NOT complete, so its total
  // stays unknown even though every retained row is known-usage.
  const future = queryModelUsage(root, { from: AT, to: AT + DAY });
  check(() => assert.equal(future.stats.totalCallCount, null, "future is never complete"), "1.noInventedFuture");
  check(() => assert.ok(future.coverage.unknownRanges.length > 0), "1.futureUnknownRange");

  // A *partially* known usage object must not be promoted to a known total.
  const partial = recordModelCall(root, { callId: "c-partial", startedAt: AT + 200, endedAt: AT + 300,
    ...SCOPE, status: "confirmed", usage: { inputTokens: 5 } });
  check(() => assert.equal(partial.ok, true), "1.partialRecorded");
  check(() => assert.deepEqual(normalizeModelUsage({ inputTokens: 5 }), { inputTokens: 5, outputTokens: null,
    totalTokens: null, cachedInputTokens: null, reasoningTokens: null }), "1.noDerivation");
  const both = queryModelUsage(root, { from: AT, to: AT + DAY });
  check(() => assert.equal(both.stats.unknownCallCount, 2, "partial usage is still unknown"), "1.partialUnknown");
  check(() => assert.equal(both.stats.tokens.inputTokens.total, null), "1.partialTotalNull");
  check(() => assert.equal(both.stats.tokens.inputTokens.knownTokens, 5, "known tokens remain a lower bound"), "1.partialKnown");

  // An uncovered range must never report zero: empty ledger history is unknown.
  const empty = queryModelUsage({}, { from: 0, to: 1 });
  check(() => assert.equal(empty.ok, true), "1.emptyOk");
  check(() => assert.equal(empty.stats.callCount, 0), "1.emptyCount");
  check(() => assert.equal(empty.stats.totalCallCount, null), "1.emptyTotalUnknown");
  check(() => assert.equal(empty.coverage.complete, false), "1.emptyIncomplete");
  // ...and reading an empty ledger wrote nothing.
  const untouched = {};
  queryModelUsage(untouched, { from: 0, to: 1 });
  queryOperationalEvents(untouched, { from: 0, to: 1 });
  queryOwnerInteractions(untouched, { from: 1, to: 2 });
  check(() => assert.deepEqual(untouched, {}, "queries never create state"), "1.noWriteOnRead");
}

// --------------------------------------------------------------------------
// 2. Source timestamps, [from,to) ranges, retention fences
// --------------------------------------------------------------------------
{
  const root = {};
  recordModelCall(root, { callId: "d0", startedAt: AT, endedAt: AT + 10, ...SCOPE, status: "confirmed", usage: USAGE });
  recordModelCall(root, { callId: "d1", startedAt: AT + DAY, endedAt: AT + DAY + 10, ...SCOPE, status: "confirmed", usage: USAGE });
  // A call STARTED before `from` but ENDED inside the range belongs to the
  // earlier day: attribution is startedAt, never endedAt or ingestion time.
  recordModelCall(root, { callId: "span", startedAt: AT + 5, endedAt: AT + DAY + 5, ...SCOPE, status: "confirmed", usage: USAGE });
  const day0 = queryModelUsage(root, { from: AT, to: AT + DAY });
  const day1 = queryModelUsage(root, { from: AT + DAY, to: AT + 2 * DAY });
  check(() => assert.equal(day0.stats.callCount, 2, "startedAt attribution"), "2.attribution0");
  check(() => assert.equal(day1.stats.callCount, 1), "2.attribution1");
  check(() => assert.deepEqual(day0.days.map(d => d.day), ["2026-10-28"]), "2.utcDayBucket");
  // Half-open boundary: `to` is exclusive, `from` inclusive.
  check(() => assert.equal(queryModelUsage(root, { from: AT + DAY, to: AT + DAY }).stats.callCount, 0), "2.emptyHalfOpen");
  check(() => assert.ok(queryModelUsage(root, { from: AT, to: AT }).ok), "2.zeroWidthAllowed");
  check(() => assert.equal(queryModelUsage(root, { from: AT + 1, to: AT }).ok, false), "2.reversedRangeRejected");

  // Events use their own source time, not the write time.
  const event = recordOperationalEvent(root, { eventId: "e-src", code: "MODEL_CALL_FAILED", severity: "warning",
    feature: "chat", time: AT + HOUR, accountId: "alpha", logicalBotId: "account:alpha" });
  check(() => assert.equal(event.ok, true), "2.eventRecorded");
  check(() => assert.equal(event.entry.time, AT + HOUR), "2.eventSourceTime");
  check(() => assert.equal(queryOperationalEvents(root, { from: AT, to: AT + 2 * HOUR }).count, 1), "2.eventInRange");
  check(() => assert.equal(queryOperationalEvents(root, { from: AT + HOUR, to: AT + 3 * HOUR }).count, 1), "2.eventFromInclusive");
  check(() => assert.equal(queryOperationalEvents(root, { from: AT, to: AT + HOUR }).count, 0), "2.eventToExclusive");
  // A timestamp older than the write watermark is rejected, not silently kept.
  check(() => assert.deepEqual(
    recordOperationalEvent(root, { eventId: "e-old", code: "MODEL_CALL_FAILED", severity: "info", feature: "chat",
      time: AT - 20 * DAY }).reason, "outside_retention"), "2.oldEventRejected");
  check(() => assert.equal(root.operationalLedger.events.length, 1, "rejected write mutates nothing"), "2.rejectNoMutation");

  // Interaction rows keep the original event time across a later watermark.
  const interactions = {};
  const first = recordOwnerInteraction(interactions, { ...SCOPE, messageId: "m1", direction: "received",
    at: AT, now: AT });
  const later = recordOwnerInteraction(interactions, { ...SCOPE, messageId: "m2", direction: "sent",
    at: AT + 2 * DAY, now: AT + 2 * DAY });
  check(() => assert.equal(first.recorded, true), "2.firstInteraction");
  check(() => assert.equal(later.recorded, true), "2.laterInteraction");
  check(() => assert.equal(interactions.ownerInteractions.events[0].at, AT, "original at retained"), "2.originalAt");
  check(() => assert.equal(queryOwnerInteractions(interactions, { from: AT, to: AT + 1 }).observed.received, 1), "2.windowBySourceAt");
  check(() => assert.equal(queryOwnerInteractions(interactions, { from: AT + 2 * DAY, to: AT + 2 * DAY + 1 }).observed.sent, 1), "2.windowLater");
}

// --------------------------------------------------------------------------
// 3. Failed / uncertain ACK never recorded as success (notification center)
// --------------------------------------------------------------------------
function notificationFixture(options = {}) {
  let root = freeze(clone(options.root ?? { sentinel: { untouched: true } }));
  let clock = options.at ?? AT, tail = Promise.resolve(), receipt = { status: "confirmed" }, sendHook, snapshotHook;
  let writes = 0;
  const sent = [];
  const config = { enabled: true, recipients: ["10001", "10002"], ...options.policy };
  const seen = new Set();
  const dependencies = {
    read: () => root,
    transact(build) {
      const operation = tail.then(async () => {
        const draft = clone(root), result = build(draft);
        assert.ok(!result?.then, "builders must be synchronous");
        writes += 1;
        root = freeze(clone(draft));
        return result;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    now: () => clock,
    policy: () => config,
    eligible: () => ({ allowed: true, ownerVerified: true, private: true, online: true, revision: "r1",
      logicalBotId: "bot-a", carrierId: "carrier-a" }),
    snapshot: async owner => {
      if (snapshotHook) return snapshotHook(owner);
      return { usage: { known: false }, operational: { needsOwner: 1 }, events: [{ code: "MODEL_CALL_FAILED",
        resolved: false }, { code: "ONEBOT_UNAVAILABLE", resolved: true }] };
    },
    send: async request => {
      const collection = request.kind === "window" ? "windows" : "critical";
      const published = root.ownerNotifications?.[collection]?.find(r => r.claimId === request.claimId);
      assert.equal(published?.status, "claimed", "durable claim must precede the wire");
      if (sendHook) await sendHook(request);
      if (!request.guard()) return { status: "failed" };
      sent.push(request); seen.add(request.claimId);
      if (receipt instanceof Error) throw receipt;
      return receipt;
    }
  };
  return { dependencies, config, sent, seen,
    root: () => root, writes: () => writes, clock: () => clock,
    center: () => createOwnerNotificationCenter(dependencies),
    setTime: at => { clock = typeof at === "number" ? at : Date.parse(at); },
    receipt: value => { receipt = value; }, onSend: fn => { sendHook = fn; }, onSnapshot: fn => { snapshotHook = fn; } };
}
const rowsOf = (f, name = "windows") => f.root().ownerNotifications?.[name] ?? [];

const single = { recipients: ["10001"] };
{
  const f = notificationFixture({ policy: single });
  f.receipt({ status: "failed" });
  const result = await f.center().tick();
  const rows = rowsOf(f);
  check(() => assert.equal(f.sent.length, 1, "wire was attempted once"), "3.attempted");
  check(() => assert.equal(result.code, "TICK_COMPLETE"), "3.tickComplete");
  check(() => assert.equal(rows.length, 1), "3.oneRow");
  check(() => assert.equal(rows[0].status, "failed", "failed ACK is recorded as failed"), "3.failedStatus");
  check(() => assert.equal(rows[0].code, "SEND_FAILED"), "3.failedCode");
  check(() => assert.notEqual(rows[0].status, "confirmed", "never a fake success"), "3.failedNotSuccess");
}
{
  // Transport that throws after the claim: outcome is unknown, so `uncertain`.
  const f = notificationFixture({ policy: single });
  f.receipt(new Error("socket closed after write"));
  await f.center().tick();
  const rows = rowsOf(f);
  check(() => assert.equal(rows[0].status, "uncertain", "thrown wire error is uncertain"), "3.thrownUncertain");
  check(() => assert.equal(rows[0].code, "SEND_UNCERTAIN"), "3.uncertainCode");
  // `accepted` is transport acceptance only, never `confirmed`.
  const second = notificationFixture({ policy: single });
  second.receipt({ status: "accepted" });
  await second.center().tick();
  check(() => assert.equal(rowsOf(second)[0].status, "accepted", "accepted stays accepted"), "3.accepted");
  check(() => assert.equal(getOwnerNotificationStatus(second.root(), { now: AT }).counts.accepted, 1), "3.countedAccepted");
}
{
  // An unrecognised receipt status must not be trusted as success.
  const f = notificationFixture({ policy: single });
  f.receipt({ status: "delivered-ish" });
  await f.center().tick();
  check(() => assert.equal(rowsOf(f)[0].status, "uncertain", "unknown receipt is uncertain"), "3.unknownReceipt");
  check(() => assert.equal(rowsOf(f)[0].code, "SEND_UNCERTAIN"), "3.unknownReceiptCode");
}

// --------------------------------------------------------------------------
// 4. Ledger corruption is rejected without mutation
// --------------------------------------------------------------------------
{
  const build = () => {
    const root = {};
    recordModelCall(root, { callId: "k1", startedAt: AT, endedAt: AT + 10, ...SCOPE, status: "confirmed", usage: USAGE });
    claimModelCall(root, { callId: "k2", startedAt: AT + 10, ...SCOPE });
    recordOperationalEvent(root, { eventId: "e1", code: "MODEL_CALL_FAILED", severity: "warning", feature: "chat", time: AT + 5 });
    return root;
  };
  const corruptions = {
    "not an object": () => ({ operationalLedger: 5 }),
    "wrong version": root => { root.operationalLedger.version = 3; return root; },
    "duplicate callId": root => { const l = root.operationalLedger; l.calls[1].callId = l.calls[0].callId; return root; },
    "duplicate eventId": root => { const l = root.operationalLedger;
      l.events.push({ ...l.events[0] }); return root; },
    "extra call property": root => { root.operationalLedger.calls[0].error = "secret"; return root; },
    "bad status": root => { root.operationalLedger.calls[0].status = "done"; return root; },
    "revision drift": root => { root.operationalLedger.revision += 1; return root; },
    "days mismatch": root => { root.operationalLedger.days[0].stats.callCount += 1; return root; },
    "negative token": root => { root.operationalLedger.calls[0].usage.inputTokens = -1; return root; },
    "non-fixpoint usage": root => { root.operationalLedger.calls[0].usage.totalTokens = 999; return root; },
    "pending with usage": root => { const l = root.operationalLedger;
      l.calls[1].usage.inputTokens = 3; return root; },
    "retention through behind rows": root => { root.operationalLedger.retention.through = AT - 1; return root; },
    "pruned counters inconsistent": root => { root.operationalLedger.retention.prunedUsage.callCount = 5; return root; },
    "dropped retention": root => { delete root.operationalLedger.retention; return root; },
    "prototype poison": root => { Object.defineProperty(root.operationalLedger.calls[0], "__proto__",
      { value: {}, enumerable: true, configurable: true }); return root; },
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const root = corrupt(build());
    const before = JSON.stringify(root, (key, value) => key === "operationalLedger" ? value : value);
    const settle = settleModelCall(root, { callId: "k2", endedAt: AT + 20, status: "confirmed", usage: USAGE });
    const claim = claimModelCall(root, { callId: "k3", startedAt: AT + 30, ...SCOPE });
    const query = queryModelUsage(root, { from: 0, to: AT + DAY });
    check(() => assert.equal(settle.ok, false, `${name} settled`), `4.${name}.settle`);
    check(() => assert.equal(settle.reason, "invalid_state", `${name} settle reason`), `4.${name}.settleReason`);
    check(() => assert.equal(claim.ok, false, `${name} claimed`), `4.${name}.claim`);
    check(() => assert.equal(query.ok, false, `${name} queried`), `4.${name}.query`);
    check(() => assert.equal(JSON.stringify(root), before, `${name} must not mutate`), `4.${name}.mutation`);
  }
  // Structural attacks on the container itself.
  for (const root of [null, 5, "state", [], Object.create({ operationalLedger: {} })]) {
    check(() => assert.deepEqual(queryModelUsage(root, { from: 0, to: 1 }), { ok: false, reason: "invalid_state" }), "4.container");
  }
  // Interaction store: same fail-closed rule.
  const broken = { ownerInteractions: { version: 1, startedAt: AT, watermark: AT, events: [{ key: "not-a-hash" }],
    days: [], gaps: [] } };
  check(() => assert.equal(recordOwnerInteraction(broken, { ...SCOPE, messageId: "x", direction: "received",
    at: AT, now: AT }).reason, "INVALID_STATE"), "4.interactionsInvalid");
  check(() => assert.equal(queryOwnerInteractions(broken, { from: 0, to: AT + DAY }).coverage, "invalid"), "4.interactionsQuery");
}

// --------------------------------------------------------------------------
// 5. Count boundaries and capacity backpressure
// --------------------------------------------------------------------------
{
  // Exactly at the pending cap still reads and settles; one over is rejected.
  // The cap state is produced by the module's own writer, so its projection is
  // real rather than hand-built.
  const atCap = {};
  for (let i = 0; i < OPERATIONAL_LEDGER_LIMITS.pendingCalls; i += 1) {
    claimModelCall(atCap, { callId: `p-${i}`, startedAt: AT, ...SCOPE });
  }
  check(() => assert.equal(queryModelUsage(atCap, { from: 0, to: AT + DAY }).ok, true), "5.atCapReadable");
  check(() => assert.equal(queryModelUsage(atCap, { from: 0, to: AT + DAY }).pressure.used.pendingCalls,
    OPERATIONAL_LEDGER_LIMITS.pendingCalls), "5.atCapPressure");
  const nextClaim = claimModelCall(atCap, { callId: "overflow", startedAt: AT, ...SCOPE });
  check(() => assert.equal(nextClaim.ok, false), "5.capRejects");
  check(() => assert.equal(nextClaim.reason, "capacity"), "5.capReason");
  check(() => assert.equal(nextClaim.resource, "pendingCalls"), "5.capResource");
  check(() => assert.equal(atCap.operationalLedger.calls.length, OPERATIONAL_LEDGER_LIMITS.pendingCalls), "5.noEviction");
  check(() => assert.equal(settleModelCall(atCap, { callId: "p-0", endedAt: AT + 1, status: "uncertain" }).ok, true),
    "5.pendingReservationSettlesAtCap");
  // A claim is a durable reservation: it can still be settled after settlement
  // pushes completed rows to their own cap.
  const draft = {};
  claimModelCall(draft, { callId: "res-1", startedAt: AT, ...SCOPE });
  check(() => assert.equal(settleModelCall(draft, { callId: "res-1", endedAt: AT + 1, status: "confirmed",
    usage: USAGE }).ok, true), "5.reservationSettles");
}
{
  // Rotation must still prune on the settle path (and only there where the
  // seven-day floor actually advances), keeping pending claims forever.
  const root = {};
  recordModelCall(root, { callId: "old-1", startedAt: AT, endedAt: AT + 1, ...SCOPE, status: "confirmed", usage: USAGE });
  recordModelCall(root, { callId: "old-2", startedAt: AT + 2, endedAt: AT + 3, ...SCOPE, status: "failed" });
  claimModelCall(root, { callId: "still-pending", startedAt: AT + 4, ...SCOPE });
  const settled = settleModelCall(root, { callId: "still-pending", endedAt: AT + 30 * DAY, status: "confirmed", usage: USAGE });
  check(() => assert.equal(settled.ok, true, "long-gap settlement succeeds"), "5.pruneSettle");
  check(() => assert.deepEqual(root.operationalLedger.calls.map(c => c.callId), ["still-pending"]), "5.pruneExpired");
  check(() => assert.equal(root.operationalLedger.retention.prunedUsage.callCount, 2), "5.pruneCounted");
  check(() => assert.equal(root.operationalLedger.retention.prunedUsage.confirmedCallCount, 1), "5.pruneStatusDetail");
  check(() => assert.equal(root.operationalLedger.retention.prunedUsage.failedCallCount, 1), "5.pruneStatusDetail2");
  // A pending claim is NEVER pruned, which is what keeps settlement possible.
  const pending = {};
  claimModelCall(pending, { callId: "p", startedAt: AT, ...SCOPE });
  recordOperationalEvent(pending, { eventId: "ev", code: "MODEL_TIMEOUT", severity: "info", feature: "chat",
    time: AT + 30 * DAY });
  check(() => assert.deepEqual(pending.operationalLedger.calls.map(c => c.callId), ["p"]), "5.pendingSurvivesPrune");
  check(() => assert.equal(settleModelCall(pending, { callId: "p", endedAt: AT + 30 * DAY, status: "uncertain" }).ok,
    true), "5.pendingStillSettleable");
  // Event-only rotation prunes calls too, in the SAME publication.
  const mixed = { operationalLedger: clone(pending.operationalLedger) };
  check(() => assert.equal(queryModelUsage(mixed, { from: AT, to: AT + DAY }).pressure.used.calls, 1), "5.pruneProjectionConsistent");
}
{
  // Owner interaction capacity marks a gap instead of dropping counts silently.
  const root = {};
  const rows = Array.from({ length: OWNER_INTERACTION_LIMITS.dayDimensions }, (_, i) => ({
    day: AT - (AT % DAY), logicalBotId: `bot-${i}`, accountId: "alpha", received: 0, sent: 0,
    groupMessages: 0, privateMessages: 0 }));
  root.ownerInteractions = { version: 1, startedAt: AT, watermark: AT, events: [], days: rows, gaps: [] };
  const overflow = recordOwnerInteraction(root, { ...SCOPE, logicalBotId: "one-too-many",
    messageId: "m", direction: "received", at: AT, now: AT });
  check(() => assert.equal(overflow.recorded, false), "5.interactionCapped");
  check(() => assert.equal(overflow.incomplete, true), "5.interactionIncomplete");
  check(() => assert.equal(overflow.reason, "CAPACITY"), "5.interactionReason");
  check(() => assert.equal(root.ownerInteractions.days.length, OWNER_INTERACTION_LIMITS.dayDimensions), "5.noEvictionDays");
  check(() => assert.equal(root.ownerInteractions.gaps.length, 1), "5.gapRecorded");
  const query = queryOwnerInteractions(root, { from: AT, to: AT + 1 });
  check(() => assert.ok(query.reasons.includes("CAPACITY")), "5.gapSurfaces");
  check(() => assert.equal(query.received, null, "capacity makes totals unknown, not zero"), "5.capacityUnknown");
  check(() => assert.equal(query.observed.received, 0), "5.observedLowerBound");
}
{
  // Duplicate rows are idempotent, never replayed or double counted.
  const root = {};
  const args = { callId: "dup", startedAt: AT, ...SCOPE };
  const first = claimModelCall(root, args);
  const again = claimModelCall(root, args);
  check(() => assert.equal(first.shouldCall, true), "5.firstCall");
  check(() => assert.equal(again.ok, true), "5.duplicateOk");
  check(() => assert.equal(again.duplicate, true), "5.duplicateFlag");
  check(() => assert.equal(again.shouldCall, false, "duplicate claim must not re-send"), "5.noReplay");
  check(() => assert.equal(again.revision, first.revision, "duplicate does not advance revision"), "5.duplicateRevision");
  check(() => assert.equal(claimModelCall(root, { ...args, startedAt: AT + 1 }).reason, "conflict"), "5.claimConflict");
  const settled = settleModelCall(root, { callId: "dup", endedAt: AT + 5, status: "confirmed", usage: USAGE });
  const settledAgain = settleModelCall(root, { callId: "dup", endedAt: AT + 5, status: "confirmed", usage: USAGE });
  check(() => assert.equal(settled.ok, true), "5.settled");
  check(() => assert.equal(settledAgain.duplicate, true), "5.settleDuplicate");
  check(() => assert.equal(settleModelCall(root, { callId: "dup", endedAt: AT + 6, status: "confirmed",
    usage: USAGE }).reason, "conflict"), "5.terminalImmutable");
  check(() => assert.equal(settleModelCall(root, { callId: "dup", endedAt: AT + 5, status: "confirmed",
    usage: USAGE, expectedCallRevision: 1 }).reason, "stale_revision"), "5.callRevisionCas");
  // CAS is checked BEFORE dedup.
  check(() => assert.equal(claimModelCall(root, { ...args, expectedRevision: 0 }).reason, "stale_revision"), "5.ledgerCas");
  check(() => assert.equal(claimModelCall(root, { ...args, expectedRevision: root.operationalLedger.revision })
    .duplicate, true), "5.casThenDedup");
}

{
  // The maintained per-day projection must equal a from-scratch aggregation
  // after a mixed write sequence (claims, settlements, one-phase records,
  // multiple dimensions, a pruning gap). read() revalidates `days` on every
  // call, so this also proves the incremental delta path cannot drift.
  const root = {}, open = [];
  let time = AT;
  for (let i = 0; i < 64; i += 1) {
    time += [0, 60_000, HOUR, 6 * HOUR][i % 4];
    const scope = { ...SCOPE, conversationId: `group:${100 + (i % 5)}`, model: i % 3 ? "model-a" : "model-b" };
    const kind = i % 4;
    if (kind === 0) {
      check(() => assert.equal(claimModelCall(root, { callId: `x-${i}`, startedAt: time, ...scope }).ok, true),
        `5.seqClaim${i}`);
      open.push(`x-${i}`);
    } else if (kind === 1 && open.length) {
      const callId = open.shift();
      const settled = settleModelCall(root, { callId, endedAt: time, status: "confirmed", usage: USAGE });
      check(() => assert.equal(settled.ok, true, `settle ${callId}`), `5.seqSettle${i}`);
    } else if (kind === 2) {
      check(() => assert.equal(recordModelCall(root, { callId: `x-${i}`, startedAt: time, endedAt: time + 10,
        ...scope, status: i % 8 === 2 ? "failed" : "confirmed", usage: i % 5 ? USAGE : undefined }).ok, true),
      `5.seqRecord${i}`);
    } else {
      check(() => assert.equal(recordOperationalEvent(root, { eventId: `ev-${i}`, code: "MODEL_TIMEOUT",
        severity: "warning", feature: "chat", time }).ok, true), `5.seqEvent${i}`);
    }
  }
  for (const callId of open.splice(0)) {
    settleModelCall(root, { callId, endedAt: time, status: "uncertain" });
  }
  const ledger = root.operationalLedger;
  check(() => assert.ok(ledger.calls.length > 16, `kept ${ledger.calls.length} rows`), "5.sequenceKeptRows");
  const wide = queryModelUsage(root, { from: 0, to: ledger.retention.through + 1 });
  check(() => assert.equal(wide.ok, true), "5.sequenceReadable");
  check(() => assert.equal(wide.days.reduce((n, day) => n + day.stats.callCount, 0), wide.stats.callCount,
    `partition ${wide.stats.callCount}`), "5.daysPartitionRows");
  check(() => assert.equal(wide.stats.callCount, ledger.calls.length), "5.totalMatchesRows");
  for (const field of ["callCount", "knownCallCount", "unknownCallCount", "confirmedCallCount",
    "failedCallCount", "uncertainCallCount"]) {
    check(() => assert.equal(wide.days.reduce((n, day) => n + day.stats[field], 0), wide.stats[field]),
      `5.partition.${field}`);
  }
  for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
    check(() => assert.equal(wide.days.reduce((n, day) => n + day.stats.tokens[field].unknownCalls, 0),
      wide.stats.tokens[field].unknownCalls), `5.partition.${field}.unknown`);
    check(() => assert.equal(wide.days.reduce((n, day) => n + day.stats.tokens[field].knownTokens, 0),
      wide.stats.tokens[field].knownTokens), `5.partition.${field}.known`);
  }
  // The stored projection equals the recomputed one, key for key. Only the
  // coverage-adjusted fields (`total`, `totalCallCount`) are excluded, because a
  // query may legitimately null them; everything durable must match exactly.
  const durable = day => ({
    day: day.day, logicalBotId: day.logicalBotId, accountId: day.accountId,
    conversationId: day.conversationId, kind: day.kind, model: day.model,
    stats: {
      ...Object.fromEntries(["callCount", "knownCallCount", "unknownCallCount", "pendingCallCount",
        "confirmedCallCount", "failedCallCount", "uncertainCallCount"].map(k => [k, day.stats[k]])),
      tokens: Object.fromEntries(Object.entries(day.stats.tokens).map(([k, m]) => [k,
        { knownTokens: m.knownTokens, knownCalls: m.knownCalls, unknownCalls: m.unknownCalls }])),
      cost: { knownCalls: day.stats.cost.knownCalls, unknownCalls: day.stats.cost.unknownCalls,
        byCurrency: day.stats.cost.byCurrency.map(c => ({ ...c })) },
    },
  });
  check(() => assert.deepEqual(wide.days.map(durable), ledger.days.map(durable)), "5.storedProjectionExact");
  // A tampered projection is still rejected on the very next write.
  const tampered = clone(root);
  tampered.operationalLedger.days[0].stats.callCount += 1;
  check(() => assert.equal(claimModelCall(tampered, { callId: "after-tamper", startedAt: time, ...SCOPE }).reason,
    "invalid_state"), "5.tamperedProjectionRejected");
  // ...and so is a reordered projection, which a count-only comparison would miss.
  const reordered = clone(root);
  if (reordered.operationalLedger.days.length > 1) {
    reordered.operationalLedger.days.reverse();
    const before = JSON.stringify(reordered);
    check(() => assert.equal(claimModelCall(reordered, { callId: "after-reorder", startedAt: time, ...SCOPE }).reason,
      "invalid_state"), "5.reorderedProjectionRejected");
    check(() => assert.equal(JSON.stringify(reordered), before, "rejected write mutates nothing"), "5.reorderNoMutation");
  }
  // Longer gap: retention prunes, and the projection must follow in the same write.
  const pruned = recordModelCall(root, { callId: "much-later", startedAt: time + 20 * DAY,
    endedAt: time + 20 * DAY + 10, ...SCOPE, status: "confirmed", usage: USAGE });
  check(() => assert.equal(pruned.ok, true), "5.gapRecord");
  const afterPrune = queryModelUsage(root, { from: 0, to: root.operationalLedger.retention.through + 1 });
  check(() => assert.equal(afterPrune.ok, true), "5.prunedReadable");
  check(() => assert.equal(afterPrune.days.reduce((n, day) => n + day.stats.callCount, 0), afterPrune.stats.callCount),
    "5.prunedPartition");
  check(() => assert.equal(root.operationalLedger.calls.length, afterPrune.stats.callCount), "5.prunedMatchesRows");
  check(() => assert.deepEqual(afterPrune.days.map(day => day.stats.callCount),
    root.operationalLedger.days.map(day => day.stats.callCount)), "5.prunedProjectionFollows");
}

// --------------------------------------------------------------------------
// 6. Two daily slots, restart, and multiple event sources
// --------------------------------------------------------------------------
{
  const f = notificationFixture({ policy: single });
  const center = f.center();
  const morning = Date.parse("2026-10-28T01:00:00Z");   // 09:00 Asia/Shanghai
  const evening = Date.parse("2026-10-28T13:00:00Z");   // 21:00 Asia/Shanghai
  f.setTime(morning); await center.tick();
  f.setTime(morning + 60_000); await center.tick();      // same slot, polled again
  check(() => assert.equal(f.sent.length, 1, "morning slot sends once"), "6.morningOnce");
  check(() => assert.equal(rowsOf(f)[0].slot, "09:00"), "6.morningSlot");
  f.setTime(evening); await center.tick();
  check(() => assert.equal(f.sent.length, 2, "evening slot is a second window"), "6.evening");
  check(() => assert.deepEqual(rowsOf(f).map(r => r.slot), ["09:00", "21:00"]), "6.twoSlots");
  f.setTime(evening + 60_000); await center.tick();
  check(() => assert.equal(f.sent.length, 2, "no third window in a local day"), "6.maxTwo");
  // Next local day resets the budget, and only for its own slots.
  f.setTime(Date.parse("2026-10-29T01:00:00Z")); await center.tick();
  check(() => assert.equal(f.sent.length, 3, "next day reopens the budget"), "6.nextDay");
  check(() => assert.equal(rowsOf(f)[2].localDate, "2026-10-29"), "6.nextDate");
  // A window key is owner+date+slot; the sending account is NOT part of it.
  const keyed = notificationFixture({ policy: single });
  await keyed.center().tick();
  const key = rowsOf(keyed)[0].key;
  check(() => assert.equal(typeof key, "string"), "6.keyPresent");
  check(() => assert.ok(!key.includes("carrier-a"), "carrier is not in the window key"), "6.keyNoCarrier");
}
{
  // Restart: an unfinished claim becomes RESTART_UNCERTAIN and is never replayed.
  const f = notificationFixture({ policy: single });
  await f.center().tick();
  const stale = clone(f.root());
  stale.ownerNotifications.windows[0].status = "claimed";
  stale.ownerNotifications.windows[0].finishedAt = null;
  const restarted = notificationFixture({ policy: single, root: stale,
    at: Date.parse("2026-10-28T01:05:00Z") });
  await restarted.center().tick();
  check(() => assert.equal(restarted.sent.length, 0, "restarted claim is not re-sent"), "6.restartNoReplay");
  check(() => assert.equal(rowsOf(restarted)[0].status, "uncertain"), "6.restartStatus");
  check(() => assert.equal(rowsOf(restarted)[0].code, "RESTART_UNCERTAIN"), "6.restartCode");
  const status = getOwnerNotificationStatus(restarted.root(), { now: Date.parse("2026-10-28T01:05:00Z") });
  check(() => assert.equal(status.counts.uncertain, 1), "6.restartCounted");
  // Status is read-only.
  check(() => assert.deepEqual(getOwnerNotificationStatus(freeze(clone(restarted.root())),
    { now: AT }), getOwnerNotificationStatus(clone(restarted.root()), { now: AT })), "6.statusPure");
}
{
  // Multiple event sources: aggregation is per local day, and only an explicit
  // host critical event with an allowlisted code may alert.
  const f = notificationFixture({ policy: { ...single, critical: { enabled: true,
    codes: ["PROTOCOL_AUTH_REQUIRED"], cooldownMs: HOUR } } });
  const center = f.center();
  f.setTime(Date.parse("2026-10-28T04:00:00Z"));
  for (const [source, severity, code, issue] of [
    ["host", "warning", "MODEL_CALL_FAILED", "issue-a"],
    ["host", "critical", "MEMORY_WRITE_FAILED", "issue-b"],
    ["model", "critical", "PROTOCOL_AUTH_REQUIRED", "issue-c"],
  ]) {
    await center.ingestEvent({ source, at: f.clock() - 60_000, severity, code, issueId: issue });
  }
  check(() => assert.equal(f.sent.length, 0, "non-host source and unlisted code never alert"), "6.noAlert");
  const bucket = f.root().ownerNotifications.events.find(r => r.localDate === "2026-10-28");
  check(() => assert.equal(bucket.total, 2, "only host-authored events are counted"), "6.sourceFilter");
  check(() => assert.equal(bucket.critical, 1, "only the allowlisted host critical is counted"), "6.criticalCount");
  await center.ingestEvent({ source: "host", at: f.clock() - 60_000, severity: "critical",
    code: "PROTOCOL_AUTH_REQUIRED", issueId: "issue-d" });
  check(() => assert.equal(f.sent.length, 1, "allowlisted host critical alerts"), "6.alerts");
  check(() => assert.equal(f.sent[0].kind, "critical"), "6.criticalKind");
  await center.ingestEvent({ source: "host", at: f.clock() - 60_000, severity: "critical",
    code: "PROTOCOL_AUTH_REQUIRED", issueId: "issue-e" });
  check(() => assert.equal(f.sent.length, 1, "cooldown prevents a second alert"), "6.cooldown");
  // Expired source events are refused instead of alerted late.
  const expired = await center.ingestEvent({ source: "host", at: f.clock() - 2 * HOUR, severity: "critical",
    code: "PROTOCOL_AUTH_REQUIRED", issueId: "issue-f" });
  check(() => assert.equal(expired.code, "INVALID_OR_EXPIRED_EVENT"), "6.expired");
  check(() => assert.equal(f.sent.length, 1), "6.expiredNoSend");
}

// --------------------------------------------------------------------------
// 7. Deterministic summary: optional trusted inputs, event codes, no prose
// --------------------------------------------------------------------------
{
  const from = Date.parse("2026-10-27T13:00:00Z"), to = Date.parse("2026-10-28T01:00:00Z");
  const facts = {
    period: "morning",
    usage: { range: { from, to, timezone: "Asia/Shanghai" }, known: true, requests: 7, totalRequests: 7,
      inputTokens: 1200, outputTokens: 340, unknownCalls: 0, pendingCalls: 1, uncertainCalls: 0 },
    lastNight: { modelCalls: 12, failedCalls: 1, received: 30, sent: 8, newPeople: 2, unresolvedEvents: 1, restoredEvents: 1 },
    people: { new: 2 },
    blockers: [
      { code: "MODEL_CALL_FAILED", resolved: false },
      { code: "ONEBOT_UNAVAILABLE", state: "restored" },
      { code: "UNLISTED", resolved: false },
      { code: "PRIVATE_PROSE", state: "unresolved" },
      { code: "MODEL_CALL_FAILED", state: "restored" },   // unresolved must win
    ],
    interactions: { received: 30, sent: 8, groupMessages: 20, privateMessages: 18, coverage: "complete" },
    pendingOperations: 2,
  };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.equal(safe.period, "morning"), "7.period");
  check(() => assert.deepEqual(safe.lastNight, { modelCalls: 12, failedCalls: 1, received: 30, sent: 8,
    newPeople: 2, unresolvedEvents: 1, restoredEvents: 1 }), "7.lastNight");
  check(() => assert.equal(safe.people.new, 2), "7.newPeople");
  check(() => assert.deepEqual(safe.blockers, [{ code: "MODEL_CALL_FAILED", state: "unresolved" },
    { code: "ONEBOT_UNAVAILABLE", state: "restored" }]), "7.blockersFolded");
  check(() => assert.ok(text.includes("昨夜活动：模型调用 12（失败 1）")), "7.lastNightLine");
  check(() => assert.ok(text.includes("昨夜事件：未解决 1；已恢复 1")), "7.lastNightEvents");
  check(() => assert.ok(text.includes("新联系人计数：2")), "7.newPeopleLine");
  check(() => assert.ok(text.includes("当前未解决事件：MODEL_CALL_FAILED（模型调用失败）")), "7.unresolvedLine");
  check(() => assert.ok(text.includes("已恢复事件：ONEBOT_UNAVAILABLE（OneBot 连接不可用）")), "7.restoredLine");
  check(() => assert.ok(!/UNLISTED|PRIVATE_PROSE/.test(text)), "7.unknownCodesDropped");
  check(() => assert.ok(!/PRIVATE/.test(JSON.stringify(safe))), "7.noProseInProjection");
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe, "sanitize is idempotent"), "7.idempotent");

  // Absent input never becomes zero.
  const bare = sanitizeOwnerNotificationFacts({});
  check(() => assert.equal(bare.lastNight, null), "7.noLastNight");
  check(() => assert.equal(bare.people.new, null), "7.noNewPeople");
  check(() => assert.equal(bare.blockers, null), "7.noBlockers");
  const bareText = formatOwnerNotificationSummary({});
  check(() => assert.ok(bareText.includes("新联系人计数：未知")), "7.unknownNewPeople");
  check(() => assert.ok(bareText.includes("当前未解决事件：未知")), "7.unknownBlockers");
  check(() => assert.ok(!bareText.includes("已恢复事件：")), "7.noEmptyRestoredLine");

  // Hostile values are dropped, not clamped into a fake number.
  const hostile = sanitizeOwnerNotificationFacts({ period: "noon", people: { new: "3" },
    lastNight: { modelCalls: -1, received: 1.5, sent: "8" }, blockers: [{ code: "MODEL_CALL_FAILED", state: "maybe" }] });
  check(() => assert.equal(hostile.period, null), "7.badPeriod");
  check(() => assert.equal(hostile.people.new, null), "7.badNewPeople");
  check(() => assert.equal(hostile.lastNight, null), "7.badLastNight");
  check(() => assert.equal(hostile.blockers, null), "7.badBlockers");

  // Evening label, and the same numbers, only the window label differs.
  const evening = formatOwnerNotificationSummary({ ...facts, period: "evening" });
  check(() => assert.ok(evening.includes("本时段活动：模型调用 12")), "7.eveningLabel");
  check(() => assert.ok(!evening.includes("昨夜活动")), "7.eveningNoMorningLabel");
}
{
  // Event code allowlist is closed, additive-only, and never grants authority.
  check(() => assert.ok(Object.isFrozen(OWNER_EVENT_CODES)), "7.codesFrozen");
  for (const code of ["MODEL_CALL_FAILED", "ONEBOT_UNAVAILABLE", "PROTOCOL_AUTH_REQUIRED", "MEMORY_WRITE_FAILED",
    "RESTART_UNCERTAIN"]) {
    check(() => assert.equal(typeof describeOwnerEventCode(code), "string"), `7.code ${code}`);
  }
  for (const code of ["UNLISTED", "AGGREGATED", "CRITICAL_COMPLETE", "", null, 5, "lowercase"]) {
    check(() => assert.equal(describeOwnerEventCode(code), null), `7.unknown ${code}`);
  }
  // Every described code is a legal ledger event code (the ledger's own regex).
  const legal = /^[A-Z][A-Z0-9_]{1,63}$/;
  check(() => assert.ok(Object.keys(OWNER_EVENT_CODES).every(code => legal.test(code))), "7.codesLegal");
  // Descriptions are fixed Chinese text; the only Latin words allowed are the
  // established product names, never event content or model prose.
  const latin = new Set(["OneBot"]);
  check(() => assert.ok(Object.values(OWNER_EVENT_CODES).every(text => typeof text === "string" && text.length > 0
    && (text.match(/[A-Za-z]+/g) ?? []).every(word => latin.has(word)))), "7.descriptionsAreChineseOnly");
  // And each one can be recorded as a real ledger event.
  const root = {};
  for (const code of Object.keys(OWNER_EVENT_CODES)) {
    check(() => assert.equal(recordOperationalEvent(root, { eventId: `ev-${code}`, code, severity: "warning",
      feature: "test", time: AT }).ok, true), `7.recordable ${code}`);
  }
  check(() => assert.equal(recordOperationalEvent(root, { eventId: "ev-bad", code: "not a code", severity: "warning",
    feature: "test", time: AT }).reason, "invalid_args"), "7.illegalCodeRejected");
}
{
  // Failure-family helper maps only real observed negative receipts.
  const map = { model: ["failed", "timeout"], onebot: ["unavailable", "failed"], sticker: ["failed"],
    permission: ["denied"], memory: ["failed", "uncertain"], config: ["invalid"], identity: ["unverified"],
    protocol: ["authRequired"], task: ["failed", "interrupted"] };
  const produced = new Set();
  for (const [family, details] of Object.entries(map)) {
    for (const detail of details) {
      const code = ownerFailureEventCode(family, detail);
      check(() => assert.equal(typeof code, "string", `${family}/${detail}`), `7.map ${family}/${detail}`);
      check(() => assert.ok(Object.hasOwn(OWNER_EVENT_CODES, code), `${code} must be described`), `7.described ${code}`);
      produced.add(code);
    }
  }
  check(() => assert.equal(produced.size, 13), "7.distinctFamilies");
  for (const [family, detail] of [["model", "confirmed"], ["model", "accepted"], ["onebot", "sent"],
    ["unknown", "failed"], ["model", undefined], [null, null], ["memory", "ok"]]) {
    check(() => assert.equal(ownerFailureEventCode(family, detail), null), `7.null ${family}/${detail}`);
  }
  // Helper is pure: no writer, no clock, no state.
  const before = JSON.stringify(OWNER_EVENT_CODES);
  ownerFailureEventCode("model", "failed"); describeOwnerEventCode("MODEL_TIMEOUT");
  check(() => assert.equal(JSON.stringify(OWNER_EVENT_CODES), before, "codes are immutable"), "7.pure");
}
{
  // Real ledger shapes flow into the summary without inventing totals, and the
  // summary itself never echoes free-form event payloads.
  const root = {};
  claimModelCall(root, { callId: "s1", startedAt: AT, ...SCOPE });
  recordModelCall(root, { callId: "s2", startedAt: AT + 1, endedAt: AT + 2, ...SCOPE, status: "confirmed" });
  recordOperationalEvent(root, { eventId: "r1", code: "MODEL_CALL_FAILED", severity: "warning", feature: "chat",
    time: AT + 3 });
  recordOperationalEvent(root, { eventId: "r2", code: "MODEL_CALL_FAILED", severity: "info", feature: "chat",
    time: AT + 4, resolved: true, recoveryAction: "verified_model_call_succeeded" });
  const facts = {
    usage: { ...queryModelUsage(root, { from: AT, to: AT + DAY }), range: { from: AT, to: AT + DAY, timezone: "Asia/Shanghai" } },
    events: queryOperationalEvents(root, { from: AT, to: AT + DAY, currentOnly: true }),
  };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.equal(safe.usage.unknownCalls, 2), "7.ledgerUnknownCalls");
  check(() => assert.equal(safe.usage.pendingCalls, 1), "7.ledgerPending");
  check(() => assert.equal(safe.operational.recordedUnresolved, 0, "resolved history reduces unresolved"), "7.ledgerResolved");
  check(() => assert.deepEqual(safe.blockers, [{ code: "MODEL_CALL_FAILED", state: "restored" }]), "7.ledgerBlockers");
  check(() => assert.ok(text.includes("已恢复事件：MODEL_CALL_FAILED（模型调用失败）")), "7.ledgerRestoredLine");
  check(() => assert.ok(text.includes("当前未解决事件：无")), "7.ledgerNoneUnresolved");
  // An older failure must NOT undo a later resolution (currentOnly keeps latest).
  const stale = { ...queryOperationalEvents(root, { from: AT, to: AT + DAY }) };
  check(() => assert.equal(sanitizeOwnerNotificationFacts({ blockers: stale.events }).blockers[0].state,
    "unresolved", "unfiltered history still shows the earlier failure"), "7.ledgerStaleUnresolved");
}

// --------------------------------------------------------------------------
// 7b. Optional reproducible benchmark (opt-in, observation only, no thresholds)
// --------------------------------------------------------------------------
// `--benchmark` measures THIS module. `--benchmark --baseline=<file>` also
// measures a second module (e.g. the pre-change file recovered with
// `git show HEAD:src/operational-ledger.js > /tmp/before-ledger.js`) on the same
// fixture and prints both series. Only observed wall-clock is reported: no
// pass/fail threshold and no claim about production performance, disk or IO.
const argv = process.argv.slice(2);
if (argv.includes("--benchmark")) {
  const { performance } = await import("node:perf_hooks");
  const baselineArg = argv.find(a => a.startsWith("--baseline="));
  const modules = [["current", await import("../src/operational-ledger.js")]];
  if (baselineArg) modules.unshift(["baseline", await import(pathToFileURL(baselineArg.slice(11)).href)]);
  const mult = (v, n) => typeof v === "number" ? v * n : v === null || typeof v !== "object" ? v
    : Array.isArray(v) ? v.map(x => mult(x, n))
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mult(x, n)]));
  const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  function fixture(mod, count, dims, base) {
    const seedRoot = {};
    const seed = mod.recordModelCall(seedRoot, { callId: "seed", startedAt: base, endedAt: base + 100,
      ...SCOPE, status: "confirmed", usage: USAGE });
    const ledger = clone(seedRoot.operationalLedger), template = ledger.days[0], buckets = new Map();
    ledger.calls = Array.from({ length: count }, (_, i) => {
      const b = i % dims, d = b % 7, at = base + d * DAY;
      const call = { ...seed.entry, usage: { ...seed.entry.usage }, callId: `c-${i}`, startedAt: at,
        endedAt: at + 100, conversationId: `group:${100 + b}` };
      const day = new Date(at).toISOString().slice(0, 10);
      const key = JSON.stringify([day, call.logicalBotId, call.accountId, call.conversationId, call.kind, call.model]);
      if (!buckets.has(key)) buckets.set(key, { day, conversationId: call.conversationId, count: 0 });
      buckets.get(key).count += 1;
      return call;
    });
    ledger.days = [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, b]) => ({ ...template, day: b.day, conversationId: b.conversationId,
        stats: mult(template.stats, b.count) }));
    ledger.revision = count;
    ledger.retention.through = base + 6 * DAY + 100;
    return { operationalLedger: ledger };
  }
  const series = [];
  for (const [name, mod] of modules) {
    for (const [count, dims] of [[100, 7], [100, 100], [1000, 7], [1000, 1000], [7000, 7], [7000, 7000]]) {
      const query = [], claim = [], settle = [];
      for (let round = 0; round < 5; round += 1) {
        const root = fixture(mod, count, dims, AT);
        const t0 = performance.now();
        const q = mod.queryModelUsage(root, { from: AT, to: AT + 7 * DAY });
        query.push(performance.now() - t0);
        assert.equal(q.ok, true, "benchmark query must succeed");
        const draft = structuredClone(root);
        const t1 = performance.now();
        const c = mod.claimModelCall(draft, { callId: `n-${round}`, startedAt: AT + 7 * DAY, ...SCOPE });
        claim.push(performance.now() - t1);
        assert.equal(c.ok, true, "benchmark claim must succeed");
        const next = structuredClone(draft);
        const t2 = performance.now();
        const s2 = mod.settleModelCall(next, { callId: `n-${round}`, endedAt: AT + 7 * DAY + 1,
          status: "confirmed", usage: USAGE });
        settle.push(performance.now() - t2);
        assert.equal(s2.ok, true, "benchmark settle must succeed");
      }
      series.push({ module: name, calls: count, dimensions: dims,
        queryMs: +median(query).toFixed(2), claimMs: +median(claim).toFixed(2),
        settleMs: +median(settle).toFixed(2) });
    }
  }
  for (const row of series) console.log(JSON.stringify(row));
  console.log(JSON.stringify({ node: process.version, nodeModule: process.execPath }));
  process.exit(0);
}

// --------------------------------------------------------------------------
// 8. Older suites still pass (child processes, no network/model/QQ)
// --------------------------------------------------------------------------
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const older = [
  ["scripts/operational-ledger-self-test.js", "operational ledger self-test passed"],
  ["scripts/owner-interactions-self-test.js", "\"ok\":true"],
  ["scripts/owner-notifications-self-test.js", "PASS owner-notifications"],
  ["scripts/owner-notification-host-self-test.js", "\"ok\":true"],
  ["scripts/backup-service-self-test.js", "\"ok\": true"],
];
for (const [script, marker] of older) {
  const output = execFileSync(process.execPath, [join(root, script)], { cwd: root, encoding: "utf8" });
  check(() => assert.ok(output.includes(marker), `${script} output shape changed`), `8.${script}`);
}

console.log(JSON.stringify({ ok: true, checks, suites: older.length,
  productionMessages: 0, modelCalls: 0, network: false, credentials: false }));
