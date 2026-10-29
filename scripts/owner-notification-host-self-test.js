import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { registryConfig, accountItems, accountScopeAllows, effectiveAccount } from "../src/account-registry.js";
import { accountDeliveryDecision } from "../src/account-delivery.js";
import { createOwnerServices } from "../src/owner-services.js";
import { createOwnerNotificationCenter } from "../src/owner-notifications.js";
import { recordModelCall } from "../src/operational-ledger.js";
import { recordOwnerInteraction, queryOwnerInteractions } from "../src/owner-interactions.js";

// Read SOURCE only: never import/run bridge startup, load live config, create
// timers/sockets/files, or invoke models. These callbacks are intentionally fake;
// the extracted bridge wiring, ownerAck and notification core are NOT copies.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
function extract(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && from === source.lastIndexOf(start) && to > from, `bridge extraction marker drift: ${start}`);
  return source.slice(from, to);
}
const wiring = new vm.Script(extract("  ownerNotificationCenter = createOwnerNotificationCenter(", "  const ownerRuntimeTimer ="), { filename: "bridge-owner-notification-wiring.js" });
const helpers = new vm.Script(
  extract("  function ownerNoticeRoute(owner)", "  ownerNotificationCenter = createOwnerNotificationCenter(")
  + extract("  const ownerTarget =", "  ownerServices = createOwnerServices(")
  + extract("function oneBotBinding(ws,", "function botStateKey("), { filename: "bridge-owner-notification-helpers.js" });
const revisionSource = source.match(/^let configRevision = randomBytes\(16\)\.toString\("hex"\);$/m)?.[0];
assert.ok(revisionSource, "bridge configRevision initializer drift: inspect actual source rather than assuming a numeric revision");

const MORNING = Date.parse("2026-10-29T01:00:00Z");
let checks = 0;
const check = fn => { fn(); checks += 1; };
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(freeze);
  }
  return value;
}
function seededRoot() {
  const root = { keep: { unchanged: true }, ownerAuthority: { version: 1, revision: 1, directives: {}, commands: {} } };
  for (const [id, status] of [["waiting", "awaiting_confirmation"], ["pending", "uncertain"], ["accepted", "accepted"], ["done", "confirmed"]]) {
    root.ownerAuthority.commands[id] = { id, status, ownerUserId: "21001", logicalBotId: "account:alpha", accountId: "alpha",
      action: "send_text", createdAt: MORNING - 1000, expiresAt: MORNING + 120000, intent: { text: "PRIVATE_TASK_CONTENT" } };
  }
  assert.equal(recordModelCall(root, { callId: "fake-count-only", logicalBotId: "account:alpha", accountId: "alpha",
    conversationId: "private:21001", kind: "chat", model: "fixture-model", startedAt: MORNING - 1000,
    endedAt: MORNING, status: "confirmed", usage: { inputTokens: 10 } }).ok, true);
  for (const direction of ["received", "sent"]) assert.equal(recordOwnerInteraction(root, {
    logicalBotId: "account:alpha", accountId: "alpha", conversationId: "private:21001", messageId: `fake-${direction}`,
    direction, at: MORNING, now: MORNING }).recorded, true);
  return root;
}
function fixture({ root = seededRoot(), at = MORNING, privateAlpha = true, receipt = { message_id: 51001 } } = {}) {
  let clock = at, durable = freeze(structuredClone(root)), published = freeze(structuredClone(root));
  let afterPublish, beforeWire, publishHookUsed = false, options, core;
  const wires = [], requests = [], commits = [];
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const config = registryConfig({ accounts: { version: 2, failoverGroups: [], items: [
    { id: "alpha", qq: "91001", enabled: true, protocolEnabled: true, scope: { private: privateAlpha } },
    { id: "beta", qq: "91002", enabled: true, protocolEnabled: true }
  ] }, privateChats: { enabled: true, ownerUserIds: ["21001", "21002"] }, ownerControl: { enabled: false, allowedTargets: [] },
  ownerNotifications: { enabled: true, recipients: ["21001"], times: ["09:00", "21:00"], timezone: "Asia/Shanghai" } });
  const sockets = new Map(["alpha", "beta"].map(id => [id, { ws: { readyState: 1, __hermesAccountId: id, __hermesSessionId: `${id}-session` } }]));
  const byId = (cfg, id) => accountItems(cfg).find(account => account.id === id) || null;
  const capture = (id, ws = sockets.get(id)?.ws, conversationId = "") => ({ accountId: id, sessionId: String(ws?.__hermesSessionId || ""), conversationId });
  // Synchronous, serial, clone-on-write durability contract. Builders cannot
  // await; durable publication completes BEFORE the core resumes its await.
  function transact(build) {
    const draft = structuredClone(published), result = build(draft);
    assert.ok(!result?.then, "host writer must receive a synchronous builder");
    durable = freeze(structuredClone(draft)); published = freeze(structuredClone(durable));
    commits.push(structuredClone(durable.ownerNotifications));
    if (!publishHookUsed && durable.ownerNotifications?.windows.some(row => row.status === "claimed")) {
      publishHookUsed = true; afterPublish?.();
    }
    return result;
  }
  const context = vm.createContext({ Date: FakeDate, structuredClone, config, ownerNotificationCenter: null, ownerServices: null,
    ownerTransact: transact, oneBotAccounts: sockets, accountById: byId, accountScopeAllows, effectiveAccount, accountDeliveryDecision,
    asStringId: value => String(value ?? ""), privateOwnerUserIds: cfg => cfg.privateChats.ownerUserIds,
    accountIsSelected: id => Boolean(byId(config, id)?.enabled), shouldHandlePrivate: () => config.privateChats.enabled !== false,
    accountExecutionRevision: id => JSON.stringify([id, "fixture-route-epoch"]), accountRuntimeContext: capture,
    configForReplyAccount: definition => ({ ...config, __activeAccountId: definition.id }),
    accountSummary: () => config.accounts.items.map(account => ({ id: account.id, displayName: account.id, enabled: account.enabled,
      connected: sockets.get(account.id)?.ws.readyState === 1, actualQq: account.qq, configuredQq: account.qq,
      wrongAccountLoggedIn: false, strongBad: false })),
    randomBytes: length => { assert.equal(length, 16); return Buffer.alloc(length, 0xab); },
    // ONLY inject the documented clock dependency. All captured host callbacks
    // are passed unchanged to the real core; VM Date never alters global Date.
    createOwnerNotificationCenter: received => {
      options = received; core = createOwnerNotificationCenter({ ...received, now: () => FakeDate.now() }); return core;
    },
    // VM-created argument objects have a different Object.prototype. Marshal
    // this data-only callback boundary so the real module's plain-JSON guard
    // sees the SAME shape it receives in the single-realm production bridge.
    queryOwnerInteractions: (memory, args) => queryOwnerInteractions(memory, structuredClone(args)),
    oneBotRequest: async (ws, action, params, requestOptions) => {
      requests.push({ ws, action, params, options: requestOptions });
      assert.equal(action, "send_private_msg"); assert.equal(requestOptions.timeoutMs, 20000);
      assert.equal(requestOptions.binding.id, ws.__hermesAccountId);
      assert.equal(requestOptions.binding.sessionId, ws.__hermesSessionId);
      assert.equal(requestOptions.binding.executionContext.accountId, ws.__hermesAccountId);
      assert.equal(typeof requestOptions.binding.isCurrent, "function");
      assert.equal(published.ownerNotifications.windows.at(-1).status, "claimed", "claim must be durable before the host send callback");
      beforeWire?.(); await Promise.resolve(); // Queue boundary, not a real wire.
      const decision = accountDeliveryDecision(config, ws.__hermesAccountId, action, params);
      if (!requestOptions.binding.isCurrent() || !decision.allowed || ws.__hermesSessionId !== requestOptions.binding.sessionId) {
        throw Object.assign(new Error("FAKE_ACCOUNT_SEND_BLOCKED"), { code: "ACCOUNT_SEND_BLOCKED" });
      }
      wires.push({ carrier: ws.__hermesAccountId, owner: params.user_id, text: params.message });
      if (receipt instanceof Error) throw receipt;
      return structuredClone(receipt);
    },
    setInterval: () => { throw new Error("HOST_TEST_TIMER_FORBIDDEN"); },
    setTimeout: () => { throw new Error("HOST_TEST_TIMER_FORBIDDEN"); },
    fetch: () => { throw new Error("HOST_TEST_NETWORK_FORBIDDEN"); }
  });
  Object.defineProperty(context, "memory", { get: () => published });
  vm.runInContext(`${revisionSource}\nglobalThis.readRevision = () => configRevision; globalThis.replaceRevision = value => { configRevision = value; };`, context);
  helpers.runInContext(context);
  context.ownerServices = createOwnerServices({ read: () => published, transact, getConfig: () => config,
    getRevision: () => context.readRevision(), commitConfig: () => { throw new Error("HOST_TEST_CONFIG_WRITE_FORBIDDEN"); },
    accounts: () => context.accountSummary().map(row => ({ id: row.id, status: row.connected ? "online" : "offline" })),
    ownerIds: () => config.privateChats.ownerUserIds, logicalId: id => `account:${id}`, capture: () => ({}), isCurrent: () => true,
    identityVerified: () => true, scopeAllows: () => false, sendText: () => { throw new Error("HOST_TEST_COMMAND_FORBIDDEN"); },
    sendSticker: () => { throw new Error("HOST_TEST_COMMAND_FORBIDDEN"); }, setQuiet: () => {}, setAutonomy: () => {},
    taskStatus: () => ({ running: 2, queued: 1, items: [{ title: "PRIVATE_TASK_CONTENT" }] }), now: () => FakeDate.now() });
  wiring.runInContext(context);
  return { config, context, sockets, wires, requests, commits, core, options, published: () => published,
    durable: () => structuredClone(durable), setTime: value => { clock = typeof value === "number" ? value : Date.parse(value); },
    afterPublish: hook => { afterPublish = hook; }, beforeWire: hook => { beforeWire = hook; } };
}

const results = [], failures = [];
async function test(name, run) {
  try { await run(); results.push(name); }
  catch (error) { failures.push({ test: name, code: error.code || error.name,
    // Assert data contain fixture counts/IDs only; never print source or payloads.
    message: error.message.split("\n")[0].slice(0, 180), ...(error.fixtureDetails ? { observed: error.fixtureDetails } : {}) }); }
}

await test("actual-eligible-string-revision-carrier-session", async () => {
  const f = fixture(), guard = f.options.eligible("21001");
  check(() => assert.match(f.context.readRevision(), /^[a-f0-9]{32}$/));
  check(() => assert.equal(guard.revision, f.context.readRevision()));
  for (const field of ["revision", "carrier", "session", "routeEpoch"]) check(() => assert.equal(typeof guard[field], "string", field));
  for (const field of ["allowed", "ownerVerified", "private", "online"]) check(() => assert.equal(guard[field], true, field));
  check(() => assert.equal(guard.carrier, "alpha"));
  check(() => assert.equal(guard.session, "alpha-session"));
  check(() => assert.equal(f.options.eligible("21003").ownerVerified, false));
  check(() => assert.deepEqual(Array.from(f.options.policy().recipients), ["21001"]));
});
await test("09-and-21-exactly-once-daily-cap", async () => {
  const f = fixture(); f.setTime("2026-10-29T00:59:59Z"); await f.core.tick();
  check(() => assert.equal(f.commits.length, 0));
  f.setTime(MORNING); await Promise.all([f.core.tick(), f.core.tick()]); await f.core.tick();
  check(() => assert.equal(f.wires.length, 1));
  check(() => assert.equal(f.published().ownerNotifications.windows[0].slot, "09:00"));
  check(() => assert.equal(f.published().ownerNotifications.windows[0].status, "confirmed"));
  f.setTime("2026-10-29T13:00:00Z"); await f.core.tick(); await f.core.tick();
  check(() => assert.equal(f.wires.length, 2));
  check(() => assert.equal(f.published().ownerNotifications.windows[1].slot, "21:00"));
  f.config.ownerNotifications.times = ["22:00"]; f.setTime("2026-10-29T14:00:00Z"); await f.core.tick();
  check(() => assert.equal(f.wires.length, 2));
});
await test("actual-send-ACK-and-unknown-outcomes", async () => {
  for (const [receipt, expected] of [[{ message_id: 51001 }, "confirmed"], [{}, "accepted"],
    [new Error("FAKE_TIMEOUT"), "uncertain"], [Object.assign(new Error("FAKE_REJECTION"), { oneBotRejected: true }), "uncertain"]]) {
    const f = fixture({ receipt }); await f.core.tick(); await f.core.tick();
    check(() => assert.equal(f.wires.length, 1));
    check(() => assert.equal(f.published().ownerNotifications.windows[0].status, expected));
    check(() => assert.equal(f.requests[0].options.binding.id, "alpha"));
  }
});
await test("actual-snapshot-recorded-counts-range-and-no-private-text", async () => {
  const f = fixture(), facts = await f.options.snapshot("21001");
  check(() => assert.equal(facts.usage.stats.callCount, 1));
  check(() => assert.equal(facts.usage.stats.totalCallCount, null));
  check(() => assert.equal(facts.usage.coverage.complete, false));
  check(() => assert.equal(facts.pendingOperations, 3));
  check(() => assert.equal(facts.interactions.received, null));
  check(() => assert.equal(facts.interactions.observed.received, 1));
  await f.core.tick(); const text = f.wires[0]?.text || "";
  for (const phrase of ["已记录请求 1；完整请求总数 未知", "已观测收到 1；发出 1，完整总数未知", "待处理操作 3",
    "2026-10-29 00:00:00.000", "2026-10-29 09:00:00.001", "Asia/Shanghai", "价格/费用：未知"]) {
    check(() => assert.ok(text.includes(phrase), `missing summary contract: ${phrase}`));
  }
  check(() => assert.ok(!text.includes("PRIVATE_TASK_CONTENT")));
  check(() => assert.deepEqual(f.published().keep, { unchanged: true }));
});
await test("restart-terminal-and-orphan-claims-no-replay", async () => {
  const original = fixture(); await original.core.tick();
  const restart = fixture({ root: original.durable() }); await restart.core.tick();
  check(() => assert.equal(restart.wires.length, 0));
  check(() => assert.equal(restart.published().ownerNotifications.windows[0].status, "confirmed"));
  const orphan = original.durable(); orphan.ownerNotifications.windows[0].status = "claimed";
  const recovered = fixture({ root: orphan }); await recovered.core.tick(); await recovered.core.tick();
  check(() => assert.equal(recovered.wires.length, 0));
  check(() => assert.equal(recovered.published().ownerNotifications.windows[0].status, "uncertain"));
  check(() => assert.equal(recovered.published().ownerNotifications.windows[0].code, "RESTART_UNCERTAIN"));
});
const revoke = {
  config: f => { f.config.ownerNotifications.enabled = false; },
  revision: f => { f.context.replaceRevision("cd".repeat(16)); },
  session: f => { f.sockets.get("alpha").ws.__hermesSessionId = "rotated-session"; },
  owner: f => { f.config.privateChats.ownerUserIds = []; }
};
for (const [name, action] of Object.entries(revoke)) {
  await test(`revoke-${name}-after-durable-publication`, async () => {
    const f = fixture(); f.afterPublish(() => action(f)); await f.core.tick();
    check(() => assert.equal(f.wires.length, 0));
    check(() => assert.equal(f.requests.length, 0));
    check(() => assert.equal(f.published().ownerNotifications.windows[0].status, "failed"));
    check(() => assert.equal(f.published().ownerNotifications.windows[0].code, "GUARD_BLOCKED"));
  });
  await test(`revoke-${name}-at-final-wire-gate`, async () => {
    const f = fixture(); f.beforeWire(() => action(f)); await f.core.tick(); await f.core.tick();
    check(() => assert.equal(f.requests.length, 1));
    check(() => assert.equal(f.wires.length, 0));
    check(() => assert.equal(f.published().ownerNotifications.windows[0].status, "uncertain"));
  });
}
await test("select-send-capable-carrier-before-consuming-slot", async () => {
  const f = fixture({ privateAlpha: false });
  check(() => assert.equal(accountDeliveryDecision(f.config, "alpha", "send_private_msg", { user_id: "21001", message: "fixture" }).allowed, false));
  check(() => assert.equal(accountDeliveryDecision(f.config, "beta", "send_private_msg", { user_id: "21001", message: "fixture" }).allowed, true));
  await f.core.tick(); await f.core.tick();
  if (f.wires.length !== 1) throw Object.assign(new Error("first healthy carrier forbids private sends; eligible beta must receive the slot"), {
    code: "HOST_ROUTE_NO_SEND_CAPABLE_CARRIER", fixtureDetails: { selectedCarrier: f.options.eligible("21001").carrier,
      wireCount: f.wires.length, hostRequests: f.requests.length, claimStatus: f.published().ownerNotifications?.windows[0]?.status,
      betaPrivateAllowed: true }
  });
  check(() => assert.equal(f.wires.length, 1, "first healthy carrier forbids private sends; eligible beta must receive the slot"));
  check(() => assert.equal(f.wires[0].carrier, "beta"));
  check(() => assert.equal(f.published().ownerNotifications.windows[0].status, "confirmed"));
});

console.log(JSON.stringify({ ok: failures.length === 0, checks, passedCases: results.length, totalCases: results.length + failures.length,
  failures, extractedCurrentBridge: true, fakeClock: true, synchronousDurableWriter: true, actualQQ: false, actualModelCalls: 0, productionIO: false }));
if (failures.length) process.exitCode = 1;
