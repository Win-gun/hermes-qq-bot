import assert from "node:assert/strict";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { queryModelUsage, queryOperationalEvents } from "../src/operational-ledger.js";
import { recordOwnerInteraction, queryOwnerInteractions } from "../src/owner-interactions.js";
import { normalizeOwnerNotifications, createOwnerNotificationCenter,
  sanitizeOwnerNotificationFacts, formatOwnerNotificationSummary, getOwnerNotificationStatus } from "../src/owner-notifications.js";

let checks = 0;
function check(fn) { fn(); checks += 1; }
const freeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// In-memory fake sole writer with the SAME synchronous-builder/durable-publication
// contract as MemoryRuntime. No config, archive, network, models or disk reads.
function fixture(options = {}) {
  let root = freeze(structuredClone(options.root ?? { sentinel: { untouched: true } }));
  let clock = Date.parse(options.at ?? "2026-10-28T01:00:00Z"), tail = Promise.resolve();
  let afterCommit, writeFailure = null, receipt = { status: "confirmed" }, sendHook, snapshotHook;
  let writes = 0, snapshots = 0;
  const sent = [];
  const config = { enabled: true, recipients: ["10001"], ...options.policy };
  const authority = { allowed: true, ownerVerified: true, private: true, online: true, revision: "r1", logicalBotId: "bot-a", carrierId: "carrier-a" };
  const dependencies = {
    read: () => root,
    transact(build) {
      const operation = tail.then(async () => {
        const draft = structuredClone(root), result = build(draft);
        assert.ok(!result?.then, "transaction builders must be synchronous");
        writes += 1;
        if (writeFailure?.when === "before") throw new Error("secret persistence error");
        root = freeze(structuredClone(draft));
        if (afterCommit) await afterCommit(root);
        if (writeFailure?.when === "after") throw new Error("uncertain secret persistence error");
        return result;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    now: () => clock,
    policy: () => config,
    eligible: () => ({ ...authority }),
    snapshot: async owner => {
      snapshots += 1;
      if (snapshotHook) return snapshotHook(owner);
      return { usage: { known: false }, tasks: { running: 2, failed: 1 }, operational: { unresolved: 3 },
        taskContent: "secret task content", prompt: "model text", token: "secret-token" };
    },
    send: async request => {
      assert.equal(root.ownerNotifications[request.kind === "window" ? "windows" : "critical"]
        .find(row => row.claimId === request.claimId)?.status, "claimed", "claim must be published before wire");
      if (sendHook) await sendHook(request);
      if (!request.guard()) return { status: "failed" };
      sent.push(request);
      if (receipt instanceof Error) throw receipt;
      return receipt;
    }
  };
  return { dependencies, config, authority, sent, root: () => root, writes: () => writes, snapshots: () => snapshots,
    center: () => createOwnerNotificationCenter(dependencies), setTime: at => { clock = typeof at === "number" ? at : Date.parse(at); },
    afterCommit: hook => { afterCommit = hook; }, failWrites: when => { writeFailure = { when }; },
    receipt: value => { receipt = value; }, onSend: hook => { sendHook = hook; }, onSnapshot: hook => { snapshotHook = hook; } };
}
const row = f => f.root().ownerNotifications.windows[0];
const event = (at, overrides = {}) => ({ source: "host", at, severity: "critical", code: "PROTOCOL_AUTH_REQUIRED", issueId: "issue-1", ...overrides });
const criticalPolicy = { critical: { enabled: true, codes: ["PROTOCOL_AUTH_REQUIRED", "MEMORY_WRITE_FAILED"], cooldownMs: 3_600_000 } };

{
  const defaults = normalizeOwnerNotifications();
  check(() => assert.deepEqual(defaults, { enabled: false, timezone: "Asia/Shanghai", times: ["09:00", "21:00"],
    recipients: [], dueGraceMs: 600_000, maxPerLocalDay: 2, critical: { enabled: false, codes: [], cooldownMs: 3_600_000 } }));
  check(() => assert.equal(normalizeOwnerNotifications({ adminNotifications: { enabled: true } }).enabled, false));
  for (const policy of ["bad", { enabled: "true" }, { times: [] }, { times: ["9:00"] }, { times: ["24:00"] },
    { times: ["09:00", "09:00"] }, { times: ["09:00", "12:00", "21:00"] }, { times: [true] },
    { timezone: "bad/zone" }, { timezone: "+08:00" }, { recipients: ["group:12345"] }, { recipients: [10001] },
    { recipients: ["10001", "10001"] }, { recipients: Array.from({ length: 33 }, (_, i) => String(i + 10001)) },
    { dueGraceMs: 600_001 }, { dueGraceMs: -1 }, { maxPerLocalDay: 3 },
    { critical: { enabled: true, codes: ["raw text"] } }, { critical: { cooldownMs: 3_599_999 } },
    { times: null }, { timezone: null }, { recipients: null }, { dueGraceMs: null },
    { critical: null }, { critical: { codes: null } }, { critical: { cooldownMs: null } }]) {
    check(() => assert.throws(() => normalizeOwnerNotifications(policy), /OWNER_NOTIFICATIONS_INVALID_/));
  }
  check(() => assert.deepEqual(normalizeOwnerNotifications({ times: ["21:00", "09:00"] }).times, ["09:00", "21:00"]));
  check(() => assert.throws(() => createOwnerNotificationCenter({}), /INVALID_CALLBACK/));
}

{
  const f = fixture({ policy: { enabled: false } }), before = JSON.stringify(f.root());
  const n = f.center();
  check(() => assert.equal(n.status().counts.confirmed, 0));
  await n.tick();
  check(() => assert.equal(f.writes(), 0));
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(JSON.stringify(f.root()), before));
}
{
  const f = fixture(), n = f.center(), published = f.root();
  await Promise.all([n.tick(), n.tick(), f.center().tick(), f.center().tick()]);
  check(() => assert.equal(f.sent.length, 1));
  check(() => assert.equal(row(f).status, "confirmed"));
  check(() => assert.equal(published.ownerNotifications, undefined));
  check(() => assert.deepEqual(f.root().sentinel, { untouched: true }));
  await f.center().tick();
  f.authority.logicalBotId = "independent-bot"; f.authority.carrierId = "carrier-b";
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 1));
  const writes = f.writes(); await f.center().tick();
  check(() => assert.equal(f.writes(), writes, "duplicate polling is read-only"));
}
{
  const f = fixture(), started = deferred(), unblock = deferred();
  f.onSend(async () => { started.resolve(); await unblock.promise; });
  const pending = f.center().tick(); await started.promise;
  await f.center().tick();
  check(() => assert.equal(row(f).status, "claimed", "new center must not orphan another center's active send"));
  unblock.resolve(); await pending;
  check(() => assert.equal(row(f).status, "confirmed"));
  check(() => assert.equal(f.sent.length, 1));
}
{
  const f = fixture(), n = f.center();
  await n.tick(); f.setTime("2026-10-28T13:00:00Z"); await n.tick();
  f.config.times = ["22:00"]; f.setTime("2026-10-28T14:00:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 2));
  f.config.times = ["09:00"]; f.setTime("2026-10-29T01:00:00Z"); await n.tick();
  check(() => assert.equal(f.sent.length, 3));
}
{
  const f = fixture({ policy: { recipients: ["10001", "10002"] } }); await f.center().tick();
  check(() => assert.equal(f.sent.length, 2));
  check(() => assert.deepEqual(f.sent.map(request => request.ownerUserId), ["10001", "10002"]));
}
for (const gate of ["allowed", "ownerVerified", "private", "online"]) {
  const f = fixture(); f.authority[gate] = false; await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(f.snapshots(), 0));
  check(() => assert.equal(f.writes(), 0));
}
{
  const f = fixture(); f.dependencies.eligible = async () => ({ ...f.authority }); await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
}
for (const change of [f => { f.authority.allowed = false; }, f => { f.authority.private = false; },
  f => { f.authority.carrierId = "carrier-b"; }, f => { f.config.enabled = false; },
  f => { f.config.times = ["09:01"]; }, f => { f.config.recipients = []; }, f => f.setTime("2026-10-28T01:11:00Z")]) {
  const f = fixture();
  f.afterCommit(root => { if (root.ownerNotifications?.windows.at(-1)?.status === "claimed") change(f); });
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(row(f).status, "failed"));
  check(() => assert.equal(row(f).code, "GUARD_BLOCKED"));
}
{
  const f = fixture(); f.onSnapshot(async () => { f.authority.ownerVerified = false; return {}; });
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(row(f).status, "failed"));
}
{
  const f = fixture(); f.onSnapshot(async () => { f.setTime("2026-10-28T01:10:00Z"); return {}; });
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 0, "snapshot await may outlive the due window"));
  check(() => assert.equal(row(f).status, "failed"));
}
{
  const f = fixture(); f.onSend(() => { f.authority.allowed = false; }); await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(row(f).status, "failed"));
}
{
  const f = fixture(); f.onSnapshot(() => { throw new Error("secret snapshot"); }); await f.center().tick();
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(row(f).code, "SNAPSHOT_FAILED"));
}
for (const [receipt, expected] of [[undefined, "uncertain"], [true, "uncertain"], ["sent", "uncertain"],
  [{ ok: true }, "uncertain"], [{ status: "sent" }, "uncertain"], [{ status: "confirmed" }, "confirmed"],
  [{ status: "accepted" }, "accepted"], [{ status: "failed" }, "failed"], [{ status: "uncertain" }, "uncertain"],
  [new Error("secret token provider error"), "uncertain"]]) {
  const f = fixture(); f.receipt(receipt); await f.center().tick();
  check(() => assert.equal(row(f).status, expected));
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 1));
  check(() => assert.ok(!JSON.stringify(f.center().status()).includes("secret")));
}
for (const receipt of [undefined, { status: "failed" }]) {
  const f = fixture(); f.receipt(receipt); await f.center().tick();
  f.config.times = ["09:01"]; f.setTime("2026-10-28T01:01:00Z"); await f.center().tick();
  f.config.times = ["09:02"]; f.setTime("2026-10-28T01:02:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 2, "failed and uncertain attempts still consume daily cap"));
}
{
  const f = fixture(); await f.center().tick();
  const stale = structuredClone(f.root()); stale.ownerNotifications.windows[0].status = "claimed";
  const restarted = fixture({ root: stale });
  const before = JSON.stringify(restarted.root());
  check(() => assert.equal(restarted.center().status().counts.uncertain, 1));
  check(() => assert.equal(JSON.stringify(restarted.root()), before, "status must be read-only"));
  await restarted.center().tick();
  check(() => assert.equal(row(restarted).status, "uncertain"));
  check(() => assert.equal(row(restarted).code, "RESTART_UNCERTAIN"));
  check(() => assert.equal(restarted.sent.length, 0));
}
for (const phase of ["before", "after"]) {
  const f = fixture(); f.failWrites(phase);
  const result = await f.center().tick();
  check(() => assert.equal(result.code, "OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN"));
  const writes = f.writes(); await f.center().tick();
  check(() => assert.equal(f.writes(), writes, "no silent retry through a second center"));
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(f.center().status().persistenceUncertain, true));
}
{
  const f = fixture(); f.onSend(() => f.failWrites("before"));
  const result = await f.center().tick();
  check(() => assert.equal(result.code, "OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN"));
  check(() => assert.equal(f.sent.length, 1));
  check(() => assert.equal(f.center().status().counts.uncertain, 1));
  const restarted = fixture({ root: f.root() }); await restarted.center().tick();
  check(() => assert.equal(restarted.sent.length, 0));
  check(() => assert.equal(row(restarted).status, "uncertain"));
}
for (const [at, expected] of [["2026-10-28T00:59:59Z", 0], ["2026-10-28T01:09:59.999Z", 1],
  ["2026-10-28T01:10:00Z", 0], ["2026-10-29T04:00:00Z", 0]]) {
  const f = fixture({ at }); await f.center().tick();
  check(() => assert.equal(f.sent.length, expected, "only today's narrow due window is eligible"));
}
{
  const f = fixture({ at: "2026-11-01T05:30:00Z", policy: { timezone: "America/New_York", times: ["01:30"] } });
  await f.center().tick(); f.setTime("2026-11-01T06:30:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 1, "DST repeated wall time must not create another claim"));
}
{
  const f = fixture({ at: "2026-03-08T07:00:00Z", policy: { timezone: "America/New_York", times: ["02:30"] } });
  await f.center().tick(); check(() => assert.equal(f.sent.length, 0, "DST nonexistent time is not caught up"));
}
{
  const f = fixture({ policy: { times: ["09:00", "09:01"] } }); await f.center().tick();
  f.setTime("2026-10-28T01:01:00Z"); await f.center().tick();
  f.config.timezone = "UTC"; f.config.times = ["01:02"]; f.setTime("2026-10-28T01:02:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 2, "timezone change must not reset the current day's cap"));
}
{
  const f = fixture({ at: "2026-10-28T04:00:00Z", policy: criticalPolicy });
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z", { severity: "warning", text: "secret task" }));
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z", { code: "UNLISTED" }));
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z", { issueId: "bad issue" }));
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(f.center().status().eventCount, 3));
  check(() => assert.ok(!JSON.stringify(f.root()).includes("secret task")));
  for (const overrides of [{ source: "model" }, { at: "2026-10-27T04:00:00Z" }, { at: "2026-10-28T04:01:00Z" }]) {
    const result = await f.center().ingestEvent(event("2026-10-28T04:00:00Z", overrides));
    check(() => assert.equal(result.code, "INVALID_OR_EXPIRED_EVENT"));
  }
}
{
  const f = fixture({ at: "2026-10-28T04:00:00Z" });
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z"));
  check(() => assert.equal(f.sent.length, 0, "critical must be explicitly enabled separately"));
  check(() => assert.equal(f.center().status().eventCount, 1));
}
{
  const f = fixture({ at: "2026-10-28T04:00:00Z", policy: criticalPolicy }); f.authority.online = false;
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z"));
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(f.root().ownerNotifications.critical.length, 0, "offline is not a successful critical notification"));
}
{
  const f = fixture({ at: "2026-10-28T04:00:00Z", policy: criticalPolicy });
  f.afterCommit(() => f.setTime("2026-10-28T04:10:00Z"));
  await f.center().ingestEvent(event("2026-10-28T04:00:00Z"));
  check(() => assert.equal(f.sent.length, 0, "critical event expiry applies after persistence awaits too"));
}
{
  const f = fixture({ at: "2026-10-28T04:00:00Z", policy: criticalPolicy });
  const input = event("2026-10-28T04:00:00Z");
  await Promise.all([f.center().ingestEvent(input), f.center().ingestEvent(input)]);
  check(() => assert.equal(f.sent.length, 1));
  f.authority.carrierId = "carrier-b"; await f.center().ingestEvent(input);
  check(() => assert.equal(f.sent.length, 1));
  f.setTime("2026-10-28T04:59:59Z");
  await f.center().ingestEvent(event("2026-10-28T04:59:59Z", { code: "MEMORY_WRITE_FAILED", issueId: "issue-2" }));
  check(() => assert.equal(f.sent.length, 1, "cooldown is per owner across issues/codes/carriers"));
  f.setTime("2026-10-28T05:00:00Z");
  await f.center().ingestEvent(event("2026-10-28T05:00:00Z"));
  check(() => assert.equal(f.sent.length, 1, "same issue must not respawn after cooldown"));
  await f.center().ingestEvent(event("2026-10-28T05:00:00Z", { issueId: "issue-2" }));
  check(() => assert.equal(f.sent.length, 2));
  await f.center().tick(); check(() => assert.equal(f.sent.length, 2, "tick never replays critical events"));
}
{
  const f = fixture({ policy: criticalPolicy }); await f.center().tick();
  await f.center().ingestEvent(event("2026-10-28T01:00:00Z"));
  check(() => assert.equal(f.sent.length, 2, "critical has separate budget"));
  const persisted = structuredClone(f.root()); persisted.ownerNotifications.critical[0].status = "claimed";
  const restart = fixture({ root: persisted, policy: criticalPolicy }); await restart.center().tick();
  await restart.center().ingestEvent(event("2026-10-28T01:00:00Z"));
  check(() => assert.equal(restart.sent.length, 0));
  check(() => assert.equal(restart.root().ownerNotifications.critical[0].status, "uncertain"));
}
{
  const f = fixture({ policy: criticalPolicy }); f.receipt(undefined);
  await f.center().ingestEvent(event("2026-10-28T01:00:00Z"));
  check(() => assert.equal(f.root().ownerNotifications.critical[0].status, "uncertain"));
  await f.center().ingestEvent(event("2026-10-28T01:00:00Z"));
  check(() => assert.equal(f.sent.length, 1));
}
{
  const f = fixture(); const n = f.center();
  for (let day = 1; day <= 24; day += 1) {
    f.setTime(`2026-10-${String(day).padStart(2, "0")}T01:00:00Z`); await n.tick();
    f.setTime(`2026-10-${String(day).padStart(2, "0")}T13:00:00Z`); await n.tick();
    await n.ingestEvent({ source: "host", at: `2026-10-${String(day).padStart(2, "0")}T13:00:00Z`, severity: "info", text: "not saved" });
  }
  check(() => assert.ok(f.root().ownerNotifications.windows.length <= 15));
  check(() => assert.ok(f.root().ownerNotifications.events.length <= 8));
  f.config.times = ["21:01"]; f.setTime("2026-10-24T13:01:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 48, "pruning must preserve current-day cap even on slot changes"));
}
{
  const at = Date.parse("2026-10-28T01:00:00Z");
  const windows = Array.from({ length: 1024 }, (_, i) => ({ key: `fixture-${i}`, ownerUserId: "20001", localDate: "2026-10-28",
    slot: "09:00", claimId: `fixture-${i}`, status: "failed", claimedAt: at }));
  const f = fixture({ root: { ownerNotifications: { version: 1, windows, critical: [], events: [] } } });
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 0, "capacity fails closed instead of evicting current-day fences"));
  check(() => assert.equal(f.writes(), 0));
  check(() => assert.equal(f.root().ownerNotifications.windows.length, 1024));
  f.setTime("2026-11-05T01:00:00Z"); await f.center().tick();
  check(() => assert.equal(f.sent.length, 1));
  check(() => assert.equal(f.root().ownerNotifications.windows.length, 1, "expiry can free old days, never replays them"));
}
{
  const at = Date.parse("2026-10-28T04:00:00Z");
  const critical = Array.from({ length: 8192 }, (_, i) => ({ key: `fixture-${i}`, ownerUserId: "20001", localDate: "2026-10-28",
    claimId: `fixture-${i}`, status: "uncertain", claimedAt: at }));
  const f = fixture({ at, policy: criticalPolicy, root: { ownerNotifications: { version: 1, windows: [], critical, events: [] } } });
  await f.center().ingestEvent(event(at));
  check(() => assert.equal(f.sent.length, 0));
  check(() => assert.equal(f.root().ownerNotifications.critical.length, 8192));
}
{
  const f = fixture(); await f.center().tick();
  const expired = structuredClone(f.root());
  expired.ownerNotifications.windows[0].status = "claimed";
  const nextDay = fixture({ at: "2026-10-29T04:00:00Z", root: expired });
  await nextDay.center().tick();
  check(() => assert.equal(nextDay.sent.length, 0, "restart outside today's window cannot catch up yesterday"));
  check(() => assert.equal(row(nextDay).status, "uncertain"));
}
{
  const usage = { ok: true, stats: { callCount: 4, unknownCallCount: 2, pendingCallCount: 1, uncertainCallCount: 1,
    tokens: { inputTokens: { total: null, knownTokens: 100, knownCalls: 2, unknownCalls: 2 },
      outputTokens: { total: null, knownTokens: 20, knownCalls: 2, unknownCalls: 2 } } },
    byModel: [{ model: "SENSITIVE MODEL NAME" }], days: [] };
  const input = { accounts: [{ id: "SENSITIVE ACCOUNT", status: "online" }, { status: "offline" }, { status: "unknown" }],
    usage, events: { ok: true, events: [{ resolved: false, text: "PRIVATE EVENT" }, { resolved: true }] },
    pendingOperations: [{ description: "PRIVATE TASK" }], tasks: { running: 2, queued: 3 },
    interactions: { received: 17, sent: 4, text: "PRIVATE CHAT" }, timeRange: "UNTRUSTED TIME RANGE" };
  const safe = sanitizeOwnerNotificationFacts(input), text = formatOwnerNotificationSummary(input);
  check(() => assert.deepEqual(safe.accounts, { total: 3, online: 1, offline: 1, unknown: 1 }));
  check(() => assert.equal(safe.tasks.waiting, 3));
  check(() => assert.equal(safe.operational.unresolved, 1));
  check(() => assert.equal(safe.operational.pendingOperations, 1));
  check(() => assert.equal(safe.usage.known, false));
  check(() => assert.equal(safe.usage.requests, 4));
  check(() => assert.equal(safe.usage.inputTokens, null));
  check(() => assert.equal(safe.usage.knownInputTokens, 100));
  check(() => assert.ok(text.includes("未知（已知计数 100）")));
  check(() => assert.ok(text.includes("未结算 1")));
  check(() => assert.ok(text.includes("待处理操作 1")));
  check(() => assert.ok(text.includes("收到 17；发出 4")));
  check(() => assert.ok(!/PRIVATE|SENSITIVE|UNTRUSTED/.test(text)));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe, "safe projection is idempotent"));
  check(() => assert.equal(sanitizeOwnerNotificationFacts({ accounts: Array(1025), events: Array(1025) }).operational.unresolved, null));
  check(() => assert.equal(sanitizeOwnerNotificationFacts({ usage: { ok: false } }).usage.known, false));
  check(() => assert.equal(sanitizeOwnerNotificationFacts({ events: [{ text: "ambiguous" }] }).operational.unresolved, null));
  usage.stats.unknownCallCount = 0; usage.stats.tokens.inputTokens.total = 3_000_000_000; usage.stats.tokens.outputTokens.total = 20;
  check(() => assert.equal(sanitizeOwnerNotificationFacts(input).usage.inputTokens, 3_000_000_000, "never silently truncate authoritative counts"));
  check(() => assert.equal(sanitizeOwnerNotificationFacts(input).usage.known, true));
}
{
  const from = Date.parse("2026-10-27T16:00:00Z"), to = Date.parse("2026-10-28T01:00:00.001Z");
  const facts = { usage: { ok: true, range: { from, to, timezone: "Asia/Shanghai", basis: "PRIVATE BASIS", coverage: "PRIVATE COVERAGE" },
    stats: { callCount: 1, unknownCallCount: 1, tokens: { inputTokens: { total: null, knownTokens: 0 }, outputTokens: { total: null, knownTokens: 0 } },
      cost: { amount: 12345, currency: "PRIVATE COST" } }, prices: "PRIVATE PRICES" },
    timeRange: { from: 0, to: 0, timezone: "UTC", text: "PRIVATE TIME RANGE" },
    operational: { needsOwner: 3, description: "PRIVATE OPERATION" } };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.deepEqual(safe.timeRange, { from, to, timezone: "Asia/Shanghai" }, "usage.range takes precedence"));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe, "range projection remains idempotent"));
  check(() => assert.equal(safe.operational.needsOwner, 3));
  check(() => assert.ok(text.includes("2026-10-28 00:00:00.000 GMT+08:00")));
  check(() => assert.ok(text.includes("2026-10-28 09:00:00.001 GMT+08:00")));
  check(() => assert.ok(text.includes("Asia/Shanghai")));
  check(() => assert.ok(text.includes("用量统计范围：[")));
  check(() => assert.ok(text.includes("仅本账本开始记录后的数据")));
  check(() => assert.ok(text.includes("按调用开始时间统计")));
  check(() => assert.ok(text.includes("未提供 token/费用为未知，不是 0")));
  check(() => assert.ok(text.includes("需主人处理 3")));
  check(() => assert.ok(text.includes("价格/费用：未知")));
  check(() => assert.ok(text.includes("未知（已知计数 0）"), "zero known tokens cannot imply missing usage is zero"));
  check(() => assert.ok(!/PRIVATE|12345/.test(text), "range/basis/price free text and amounts never echo"));
  check(() => assert.ok(!/PRIVATE/.test(JSON.stringify(safe))));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts({ timeRange: { from: 0, to: 0, timezone: "UTC" } }).timeRange,
    { from: 0, to: 0, timezone: "UTC" }, "epoch zero and empty half-open interval are valid"));
  const missing = formatOwnerNotificationSummary({});
  check(() => assert.ok(missing.includes("用量统计范围：未知")));
  check(() => assert.ok(missing.includes("需主人处理 未知")));
  check(() => assert.ok(missing.includes("价格/费用：未知")));
}
for (const bad of [null, "PRIVATE RANGE", {}, { from: "0", to: 1, timezone: "UTC" },
  { from: 0, to: "1", timezone: "UTC" }, { from: -1, to: 0, timezone: "UTC" },
  { from: 2, to: 1, timezone: "UTC" }, { from: 0, to: 1.5, timezone: "UTC" },
  { from: 0, to: NaN, timezone: "UTC" }, { from: 0, to: Infinity, timezone: "UTC" },
  { from: 0, to: 8_640_000_000_000_001, timezone: "UTC" },
  { from: 0, to: 1, timezone: "PRIVATE/ZONE" }, { from: 0, to: 1, timezone: "+08:00" },
  { from: 0, to: 1, timezone: "UTC\nPRIVATE" }, { from: 0, to: 1, timezone: 8 },
  { from: 0, to: 1 }, { from: 0, to: 1, timezone: "" }]) {
  const facts = { usage: { range: bad } };
  check(() => assert.equal(sanitizeOwnerNotificationFacts(facts).timeRange, null));
  check(() => assert.ok(formatOwnerNotificationSummary(facts).includes("用量统计范围：未知")));
  check(() => assert.ok(!formatOwnerNotificationSummary(facts).includes("PRIVATE")));
}
for (const value of [-1, "2", 1.1, Infinity, null, {}, undefined]) {
  check(() => assert.equal(sanitizeOwnerNotificationFacts({ operational: { needsOwner: value } }).operational.needsOwner, null));
}
{
  const facts = { timeRange: { from: Date.parse("2026-11-01T05:30:00Z"), to: Date.parse("2026-11-01T06:30:00Z"), timezone: "America/New_York" },
    operational: { needsOwner: 0 } };
  const text = formatOwnerNotificationSummary(facts);
  check(() => assert.ok(text.includes("2026-11-01 01:30:00.000 GMT-04:00")));
  check(() => assert.ok(text.includes("2026-11-01 01:30:00.000 GMT-05:00"), "DST repeated wall times remain distinguishable"));
  check(() => assert.ok(text.includes("需主人处理 0")));
}
{
  const f = fixture();
  f.onSnapshot(async () => ({ usage: { range: { from: Date.parse("2026-10-27T16:00:00Z"), to: Date.parse("2026-10-28T01:00:00Z"), timezone: "Asia/Shanghai" } },
    operational: { needsOwner: 1 } }));
  await f.center().tick();
  check(() => assert.equal(f.sent.length, 1));
  check(() => assert.ok(f.sent[0].text.includes("2026-10-28 09:00:00.000")));
  check(() => assert.ok(f.sent[0].text.includes("需主人处理 1")));
  check(() => assert.ok(f.sent[0].text.includes("价格/费用：未知")));
  check(() => assert.ok(!JSON.stringify(f.root()).includes("timeRange"), "facts/range stay out of durable claim metadata"));
}
{
  // Real pure query shapes: empty/uncovered history is NOT zero total usage or
  // proof that every current operational issue has been resolved.
  const from = Date.parse("2026-10-28T00:00:00Z"), to = from + 60_000;
  const facts = { usage: { ...queryModelUsage({}, { from, to }), range: { from, to, timezone: "UTC" } },
    events: queryOperationalEvents({}, { from, to, resolved: false, currentOnly: true }),
    interactions: queryOwnerInteractions({}, { from, to }) };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.equal(facts.usage.coverage.complete, false));
  check(() => assert.equal(safe.usage.requests, 0));
  check(() => assert.equal(safe.usage.totalRequests, null));
  check(() => assert.equal(safe.usage.inputTokens, null));
  check(() => assert.equal(safe.usage.known, false));
  check(() => assert.equal(safe.operational.recordedUnresolved, 0));
  check(() => assert.equal(safe.operational.unresolved, null));
  check(() => assert.ok(text.includes("已记录请求 0；完整请求总数 未知")));
  check(() => assert.ok(text.includes("已记录未解决 0（完整总数未知）")));
  check(() => assert.ok(text.includes("已观测收到 未知；发出 未知，完整总数未知")));
  check(() => assert.ok(!text.includes("完整请求总数 0")));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe));
}
{
  const at = Date.parse("2026-10-28T01:00:00Z"), root = {};
  const scope = { logicalBotId: "account:alpha", accountId: "alpha", conversationId: "private:21001" };
  check(() => assert.equal(recordOwnerInteraction(root, { ...scope, messageId: "fake-in", direction: "received", at, now: at }).recorded, true));
  check(() => assert.equal(recordOwnerInteraction(root, { ...scope, messageId: "fake-ack", direction: "sent", at: at + 1, now: at + 1 }).recorded, true));
  const partial = queryOwnerInteractions(root, { from: at - 1, to: at + 2 });
  const facts = { interactions: partial };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.equal(partial.received, null));
  check(() => assert.equal(partial.observed.received, 1));
  check(() => assert.equal(safe.interactions.received, null));
  check(() => assert.equal(safe.interactions.observed.sent, 1));
  check(() => assert.equal(safe.interactions.complete, false));
  check(() => assert.ok(text.includes("已观测收到 1；发出 1，完整总数未知")));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe));
  const complete = { interactions: queryOwnerInteractions(root, { from: at, to: at + 2 }) };
  check(() => assert.equal(sanitizeOwnerNotificationFacts(complete).interactions.complete, true));
  check(() => assert.ok(formatOwnerNotificationSummary(complete).includes("完整交互计数：收到 1；发出 1")));
  complete.interactions.reasons = ["PRIVATE REASON"]; complete.interactions.days[0].accountId = "PRIVATE ACCOUNT";
  check(() => assert.ok(!JSON.stringify(sanitizeOwnerNotificationFacts(complete)).includes("PRIVATE")));
  check(() => assert.ok(!formatOwnerNotificationSummary(complete).includes("PRIVATE")));
}
{
  const facts = { usage: { ok: true, coverage: { complete: false, text: "PRIVATE COVERAGE" },
    stats: { callCount: 5, totalCallCount: 999, unknownCallCount: 0,
      tokens: { inputTokens: { total: 100, knownTokens: 100 }, outputTokens: { total: 20, knownTokens: 20 } } } },
    events: { ok: true, coverage: { complete: false }, events: [{ resolved: false }] },
    interactions: { coverage: "partial", unknown: true, received: 999, sent: 999,
      observed: { received: 3, sent: 2, text: "PRIVATE OBSERVATION" } } };
  const safe = sanitizeOwnerNotificationFacts(facts), text = formatOwnerNotificationSummary(facts);
  check(() => assert.equal(safe.usage.totalRequests, null, "incomplete coverage wins over contradictory total fields"));
  check(() => assert.equal(safe.usage.inputTokens, null));
  check(() => assert.equal(safe.usage.knownInputTokens, 100));
  check(() => assert.ok(text.includes("已记录请求 5；完整请求总数 未知")));
  check(() => assert.ok(text.includes("未知（已知计数 100）")));
  check(() => assert.ok(text.includes("已记录未解决 1（完整总数未知）")));
  check(() => assert.ok(text.includes("已观测收到 3；发出 2，完整总数未知")));
  check(() => assert.ok(!/999|PRIVATE/.test(text)));
  check(() => assert.deepEqual(sanitizeOwnerNotificationFacts(safe), safe));
  for (const bad of [-1, "2", 1.1, Infinity, {}, null]) {
    facts.interactions.observed.received = bad;
    check(() => assert.equal(sanitizeOwnerNotificationFacts(facts).interactions.observed.received, null));
  }
}
for (const code of [123, "OWNER_NOTIFICATIONS_SECRET_TOKEN", undefined]) {
  const f = fixture(); f.dependencies.eligible = () => { throw Object.assign(new Error("secret"), { code }); };
  const result = await f.center().tick();
  check(() => assert.equal(result.code, "OWNER_NOTIFICATIONS_HOST_ERROR"));
  check(() => assert.ok(!JSON.stringify(result).includes("secret")));
}
{
  const f = fixture(); f.dependencies.read = () => { throw new Error("private root"); };
  check(() => assert.equal(f.center().status().code, "OWNER_NOTIFICATIONS_HOST_ERROR"));
}
{
  const raw = { usage: { known: false, requests: "secret", outputTokens: -1 }, tasks: { running: 4, description: "PRIVATE TASK" },
    operational: { unresolved: 2, error: "token [CQ:at,qq=all]" }, generatedText: "MODEL TEXT" };
  const safe = sanitizeOwnerNotificationFacts(raw), text = formatOwnerNotificationSummary(raw);
  check(() => assert.equal(safe.usage.requests, null));
  check(() => assert.ok(text.includes("用量：未知")));
  check(() => assert.ok(text.includes("未解决 2")));
  check(() => assert.ok(!/PRIVATE|MODEL|CQ:|secret|token \[/.test(text)));
  check(() => assert.ok(formatOwnerNotificationSummary({ usage: { known: true, requests: 0 } }).includes("请求 0")));
  const root = freeze({ unrelated: true });
  getOwnerNotificationStatus(root);
  check(() => assert.deepEqual(root, { unrelated: true }));
  check(() => assert.equal(getOwnerNotificationStatus({ ownerNotifications: { version: 99 } }).code, "OWNER_NOTIFICATIONS_INVALID_STATE"));
}
{
  // Exercise the actual reusable runtime adapter, with a fake durable repository.
  let durable = { ownerNotifications: undefined }, revision = 0;
  const runtime = new MemoryRuntime({ open: async () => ({ value: structuredClone(durable), revision }),
    commit: async draft => { durable = structuredClone(draft); return { value: structuredClone(durable), revision: ++revision }; },
    close: async () => {}, status: () => ({}) });
  await runtime.open();
  const f = fixture();
  const dependencies = { ...f.dependencies, read: () => runtime.value, transact: build => runtime.transact(build),
    send: async request => { assert.equal(request.guard(), true); return { status: "accepted" }; } };
  const n = createOwnerNotificationCenter(dependencies);
  await n.tick();
  check(() => assert.equal(runtime.value.ownerNotifications.windows[0].status, "accepted"));
  check(() => assert.equal(durable.ownerNotifications.windows.length, 1));
  await createOwnerNotificationCenter(dependencies).tick();
  check(() => assert.equal(durable.ownerNotifications.windows.length, 1));
  await runtime.close();
}

console.log(`PASS owner-notifications: ${checks} checks (fake clock/writer/wire only)`);
