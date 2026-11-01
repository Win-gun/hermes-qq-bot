import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TaskRuntime } from "../src/task-runtime.js";
import { applyDelegationControl, createAgentExecutionLoop, createCapabilityRegistry, createDelegationGoal,
  createTaskDelegationStore, delegationRoute, delegationTarget } from "../src/social-delegation.js";

// Synthetic hosts only. No bridge/config/data, provider, network or real OneBot.
const clone = structuredClone;
const owner = Object.freeze({ verified: true, userId: "90001", source: "qq" });
const tool = (capability, args = {}) => ({ action: "tool", capability, args });
const done = summary => ({ action: "complete", summary: summary || "已核实完成" });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(1); }
  assert.fail("synthetic host timeout");
}
function target(accountId = "a", groupId = "10001") {
  return { logicalBotId: `account:${accountId}`, accountId, conversationId: `group:${groupId}`, groupId };
}
function taskFor(id = "one", dest = target()) {
  return { id, status: "running", ...dest, messageType: "group", userId: "90001", attemptId: "synthetic-attempt" };
}
function memoryStore(tasks) {
  const rows = new Map(tasks.map(t => [t.id, clone(t)])), listeners = new Map();
  let writes = 0, failAt = Infinity, afterCommit;
  const store = {
    read: id => clone(rows.get(id)),
    mutate(id, build) {
      const task = rows.get(id), next = build(clone(task.socialDelegation ?? null), clone(task));
      assert.equal(typeof next?.then, "undefined", "mutation builder must be synchronous");
      if (++writes === failAt) throw new Error("synthetic disk uncertainty");
      task.socialDelegation = clone(next);
      for (const listener of [...(listeners.get(id) || [])]) listener();
      afterCommit?.(id, next);
      return { ok: true, durable: true, value: clone(next) };
    },
    subscribe(id, fn) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(fn);
      return () => listeners.get(id).delete(fn);
    },
    get writes() { return writes; },
    failNext() { failAt = writes + 1; },
    updateTask(id, patch) { Object.assign(rows.get(id), clone(patch)); },
    onCommit(fn) { afterCommit = fn; },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  };
  return store;
}
function fixture({ tasks = [taskFor()], store = memoryStore(tasks), planner, extra = {} } = {}) {
  const state = { revision: {}, quiet: {}, unavailable: new Set(), calls: [], plans: [], wires: [], at: 1000,
    budget: { maxSteps: 40, maxPlannerCalls: 50, maxUnits: 100, deadline: 100000,
      maxContextBytes: 12000, maxObservationBytes: 1000 } };
  const descriptors = [
    { id: "read_history", effect: "read", argumentKeys: ["query", "limit"] },
    { id: "search", effect: "read", argumentKeys: ["query"] },
    { id: "send", effect: "write", argumentKeys: ["text"] },
    { id: "publish", effect: "write", argumentKeys: ["text"], risk: "approval" }
  ];
  const tools = Object.fromEntries(descriptors.map(d => [d.id, async (args, meta) => {
    meta.guard();
    state.calls.push({ id: d.id, args: clone(args), target: clone(meta.target), operationId: meta.operationId });
    if (d.effect === "write") {
      // Fake physical coordinator/OneBot gate, NEVER a real wire.
      meta.guard(); state.wires.push(clone(meta.target));
      return { status: "succeeded", scope: meta.target, receiptId: `fake-${state.wires.length}`, value: "已确认" };
    }
    return { status: "succeeded", scope: meta.target, value: { logicalBotId: meta.target.logicalBotId,
      conversationId: meta.target.conversationId, messages: ["synthetic scoped history"] } };
  }]));
  const registry = createCapabilityRegistry({ list: dest => descriptors.map(d => ({ revision: 1, description: `synthetic ${d.id}`,
    risk: "low", cost: 1, validate: args => Object.values(args).every(v => typeof v === "string" || Number.isSafeInteger(v)),
    available: !state.unavailable.has(d.id), ...d })), tools });
  let sequence = [tool("read_history"), tool("send", { text: "整理结果" }), done()];
  const host = { store, registry, capture: dest => ({ accountId: dest.accountId, revision: state.revision[dest.accountId] || 0 }),
    guard: (pin, dest) => pin.accountId === dest.accountId && pin.revision === (state.revision[dest.accountId] || 0) && !state.quiet[dest.accountId],
    authorize: actor => actor === owner && actor.verified === true,
    planner: async (context, meta) => { state.plans.push(context); return planner ? planner(context, meta, state) : sequence.shift(); },
    budget: () => clone(state.budget), observe: value => typeof value === "string" ? value : JSON.stringify(value), clock: () => state.at, ...extra };
  const loop = createAgentExecutionLoop(host);
  return { loop, host, state, store, tools, descriptors, tasks,
    setPlan: next => { sequence = [...next]; },
    start: (id = tasks[0].id, dest = tasks.find(t => t.id === id)) => loop.start(id, { kind: "goal", objective: "持续收集并整理结果", target: delegationTarget({
      logicalBotId: dest.logicalBotId, accountId: dest.accountId, conversationId: dest.conversationId, groupId: dest.groupId }) }, owner),
    execute: (id = tasks[0].id, runtime = {}) => loop.execute(store.read(id), runtime),
    control: (action, objective, id = tasks[0].id) => loop.control(id, { action,
      expectedRevision: loop.status(id).revision, ...(objective ? { objective } : {}) }, owner) };
}

test("direct Q&A bypasses planner, store and capability discovery", async () => {
  const f = fixture();
  assert.equal(delegationRoute({ kind: "question" }), "direct");
  assert.equal((await f.loop.start("one", { kind: "question" }, owner)).matched, false);
  assert.equal(f.state.plans.length, 0); assert.equal(f.store.writes, 0);
});

test("executor cannot bypass TaskRuntime queue or continue an old attempt", async () => {
  const f = fixture({ tasks: [{ ...taskFor(), status: "offered" }] }); await f.start();
  await assert.rejects(f.execute(), /CANCELLED/); assert.equal(f.state.plans.length, 0);
  f.store.updateTask("one", { status: "running" });
  f.store.onCommit((_id, goal) => { if (goal.steps.length) f.store.updateTask("one", { attemptId: "another-attempt" }); });
  f.setPlan([tool("send", { text: "old attempt" })]);
  assert.equal((await f.execute()).code, "DELEGATION_ATTEMPT_CHANGED"); assert.equal(f.state.wires.length, 0);
});

test("explicit verified account/conversation required; no guessed group or model actor", async () => {
  const f = fixture();
  await assert.rejects(f.loop.start("one", { kind: "goal", objective: "goal" }, owner), /TARGET_REQUIRED/);
  await assert.rejects(f.loop.start("one", { kind: "goal", objective: "goal", target: target("other") }, owner), /TARGET_MISMATCH/);
  await assert.rejects(f.loop.start("one", { kind: "goal", objective: "goal", target: target() }, { verified: true, source: "model" }), /AUTHORITY_REQUIRED/);
  assert.equal(f.store.writes, 0);
  assert.deepEqual(delegationTarget({ groupId: "10001", conversationId: "group:10001", accountId: "a", logicalBotId: "account:a" }), target());
  assert.throws(() => delegationTarget({ ...target(), userId: "90001" }), /TARGET_REQUIRED/);
});

test("low-risk multi-step loop has durable claims/receipts and no second approval", async () => {
  const f = fixture(); await f.start();
  const seen = [];
  f.store.onCommit((id, goal) => seen.push(clone(goal)));
  const result = await f.execute();
  assert.equal(result.ok, true); assert.equal(f.state.wires.length, 1);
  assert.deepEqual(f.loop.status("one").receipts.map(s => s.status), ["succeeded", "succeeded"]);
  for (const call of f.state.calls) assert(seen.some(g => g.steps.some(s => s.operationId === call.operationId && s.status === "claimed")));
  assert.equal(f.store.listenerCount(), 0);
  assert(f.state.plans[1].observations.some(s => s.capability === "read_history"));
});

test("dynamic resource budget allows more than eight steps", async () => {
  const f = fixture(); await f.start();
  f.setPlan([...Array.from({ length: 12 }, (_, i) => tool("search", { query: `q${i}` })), done()]);
  assert.equal((await f.execute()).ok, true);
  assert.equal(f.loop.status("one").spent.steps, 12);
});

test("known-not-applied failure replans using available alternative", async () => {
  const f = fixture(); await f.start();
  f.tools.search = async (_args, meta) => { meta.guard(); f.state.unavailable.add("search"); return { status: "failed", applied: false, code: "SEARCH_OFFLINE" }; };
  f.setPlan([tool("search"), tool("read_history"), done()]);
  assert.equal((await f.execute()).ok, true);
  assert(!f.state.plans[1].capabilities.some(c => c.id === "search"));
  assert.deepEqual(f.loop.status("one").receipts.map(s => s.status), ["failed", "succeeded"]);
});

test("no real tool means no capability, planner call or fictional completion", async () => {
  const f = fixture(); await f.start();
  for (const key of Object.keys(f.tools)) delete f.tools[key];
  const result = await f.execute();
  assert.equal(result.ok, false); assert.equal(result.code, "DELEGATION_NO_CAPABILITY"); assert.equal(f.state.plans.length, 0);
});

test("registry changes during planner await prevent stale dispatch", async () => {
  const f = fixture({ planner: async (_ctx, _meta, state) => { state.unavailable.add("send"); return tool("send", { text: "no" }); } });
  await f.start(); const r = await f.execute();
  assert.equal(r.code, "DELEGATION_CAPABILITY_CHANGED"); assert.equal(f.state.wires.length, 0);
});

test("approval-risk action cannot create permission via model arguments", async () => {
  const f = fixture(); await f.start(); f.setPlan([tool("publish", { text: "post" })]);
  assert.equal((await f.execute()).code, "DELEGATION_APPROVAL_REQUIRED"); assert.equal(f.state.wires.length, 0);
  const g = fixture({ extra: { authorizeStep: req => req.capability === "publish" && req.args.text === "allowed" } });
  await g.start(); g.setPlan([tool("publish", { text: "allowed" }), done()]);
  assert.equal((await g.execute()).ok, true);
});

for (const args of [{ accountId: "b" }, { nested: { permissions: ["send"] } }, { scope: { logicalBotId: "b" } }, JSON.parse('{"__proto__":{"x":1}}')]) {
  test(`nested model authority is rejected: ${JSON.stringify(args)}`, async () => {
    const f = fixture(); await f.start(); f.setPlan([tool("send", args)]);
    assert.equal((await f.execute()).code, "DELEGATION_MODEL_AUTHORITY"); assert.equal(f.state.wires.length, 0);
  });
}

test("model schema forbids fabricated receipts/completion without work", async () => {
  const f = fixture(); await f.start(); f.setPlan([done("我已发送")]);
  assert.equal((await f.execute()).code, "DELEGATION_NO_COMPLETION_EVIDENCE");
  const g = fixture(); await g.start(); g.setPlan([{ action: "complete", summary: "done", receipt: "fake" }]);
  assert.equal((await g.execute()).code, "DELEGATION_PLAN_INVALID");
});

test("multi-round objective correction discards stale plans and old completion evidence", async () => {
  const entered = deferred(), release = deferred(); let n = 0;
  const f = fixture({ planner: async context => {
    n++;
    if (n === 1) { entered.resolve(); await release.promise; return tool("send", { text: "old" }); }
    if (n === 2) { assert.equal(context.objective, "更正一"); return tool("read_history"); }
    if (n === 3) { await f.control("correct", "更正二"); return done("old revision"); }
    assert.equal(context.objective, "更正二");
    return n === 4 ? tool("search", { query: "new" }) : done();
  } });
  await f.start(); const running = f.execute(); await entered.promise;
  await f.control("correct", "更正一"); release.resolve();
  assert.equal((await running).ok, true); assert.equal(f.state.wires.length, 0);
  assert.equal(f.loop.status("one").controlRevision, 3);
  assert.deepEqual(f.loop.status("one").receipts.map(s => s.capability), ["read_history", "search"]);
});

test("pause cancels noncooperating planner, resume uses fresh explicit execution", async () => {
  const entered = deferred(), late = deferred();
  const f = fixture({ planner: async () => { entered.resolve(); return late.promise; } });
  await f.start(); const running = f.execute(); await entered.promise;
  await f.control("pause"); assert.equal((await running).delegationStatus, "paused");
  late.resolve(tool("send", { text: "stale" })); await delay(0); assert.equal(f.state.wires.length, 0);
  f.host.planner = async () => done(); // existing closure intentionally unchanged
  await f.control("resume");
  const resumed = createAgentExecutionLoop({ ...f.host, planner: async ctx => ctx.observations.length ? done() : tool("read_history") });
  assert.equal((await resumed.execute(f.store.read("one"))).ok, true);
  assert.equal(f.store.listenerCount(), 0);
});

test("cancel while a tool is waiting stops later work and closes late wire guard", async () => {
  const entered = deferred(), release = deferred(); let lateGuard;
  const f = fixture(); await f.start();
  f.tools.send = async (_args, meta) => { lateGuard = meta.guard; entered.resolve(); await release.promise; meta.guard(); assert.fail("late external write"); };
  f.setPlan([tool("send", { text: "late" }), tool("search")]);
  const running = f.execute(); await entered.promise; await f.control("cancel");
  const result = await running; assert.equal(result.delegationStatus, "cancelled");
  assert.equal(f.loop.status("one").receipts[0].status, "uncertain");
  assert.throws(() => lateGuard(), /CALL_CLOSED/); release.resolve(); await delay(0);
  await assert.rejects(f.control("resume"), /UNRESOLVED_EFFECT/);
  assert.equal(f.state.wires.length, 0); assert.equal(f.store.listenerCount(), 0);
});

for (const change of ["carrier", "config", "quiet"]) {
  test(`${change} changes after durable claim: final queued wire is blocked`, async () => {
    const entered = deferred(), release = deferred();
    const f = fixture(); await f.start();
    f.tools.send = async (_args, meta) => {
      meta.guard(); entered.resolve(); await release.promise;
      try { meta.guard(); } catch { return { status: "failed", applied: false, code: "FINAL_GATE_BLOCKED" }; }
      f.state.wires.push(meta.target); return { status: "succeeded", scope: meta.target, receiptId: "fake" };
    };
    f.setPlan([tool("send", { text: "no" }), done()]);
    const running = f.execute(); await entered.promise;
    if (change === "quiet") f.state.quiet.a = true; else f.state.revision.a = 2;
    release.resolve(); const result = await running;
    assert.equal(result.ok, false); assert.equal(f.state.wires.length, 0);
    assert.equal(f.loop.status("one").receipts[0].status, "failed");
    assert.equal(f.store.listenerCount(), 0);
  });
}

for (const response of ["accepted", "uncertain", "throw", "missing", "fake-success"]) {
  test(`unknown external result ${response}: no retry/fallback/restart replay`, async () => {
    const f = fixture(); await f.start(); let dispatched = 0;
    f.tools.send = async (_args, meta) => {
      meta.guard(); dispatched++;
      if (response === "throw") throw new Error("socket disconnected");
      if (response === "missing") return undefined;
      if (response === "fake-success") return { status: "succeeded", scope: meta.target };
      return { status: response };
    };
    f.setPlan([tool("send", { text: "one-shot" }), tool("search"), done()]);
    const r = await f.execute(); assert.equal(r.ok, false); assert.equal(dispatched, 1);
    assert.equal(f.state.plans.length, 1);
    await assert.rejects(f.control("resume"), /UNRESOLVED_EFFECT/);
    await f.control("correct", "新目标也不能重放旧发送");
    const restarted = createAgentExecutionLoop(f.host);
    assert.equal((await restarted.execute(f.store.read("one"))).ok, false);
    assert.equal(dispatched, 1);
  });
}

test("crash claimed write is interrupted without replay, even with changed goal", async () => {
  const f = fixture(); await f.start();
  f.store.mutate("one", goal => ({ ...goal, status: "running", runId: "old", steps: [{ operationId: "old-op", status: "claimed", effect: "write" }],
    spent: { steps: 1, plannerCalls: 1, units: 1 } }));
  const result = await f.execute(); assert.equal(result.delegationStatus, "uncertain");
  await assert.rejects(f.control("resume"), /UNRESOLVED_EFFECT/);
  assert.equal(f.state.plans.length, 0); assert.equal(f.state.wires.length, 0);
});

test("read-only crash requires explicit resume, never startup planning", async () => {
  const f = fixture(); await f.start();
  f.store.mutate("one", goal => ({ ...goal, status: "running", runId: "old", steps: [{ operationId: "old", capability: "read_history", effect: "read", status: "claimed" }] }));
  assert.equal((await f.execute()).delegationStatus, "interrupted"); assert.equal(f.state.plans.length, 0);
  await f.control("resume"); assert.equal((await f.execute()).ok, true);
  assert.equal(f.store.read("one").socialDelegation.steps[0].status, "interrupted");
});

test("dynamic budget shrinks after planner and stops dispatch; host may extend on resume", async () => {
  const f = fixture({ planner: async (_ctx, _meta, state) => { state.budget.maxUnits = 0; return tool("send", { text: "no" }); } });
  await f.start(); assert.equal((await f.execute()).delegationStatus, "budget_exhausted"); assert.equal(f.state.wires.length, 0);
  f.state.budget.maxUnits = 100; await f.control("resume");
  const loop = createAgentExecutionLoop({ ...f.host, planner: async context => context.observations.length ? done() : tool("search") });
  assert.equal((await loop.execute(f.store.read("one"))).ok, true);
});

test("planner reservation followed by budget revocation dispatches no model", async () => {
  const f = fixture(); await f.start();
  f.store.onCommit((_id, goal) => { if (goal.spent.plannerCalls) f.state.budget.maxPlannerCalls = 0; });
  assert.equal((await f.execute()).delegationStatus, "budget_exhausted");
  assert.equal(f.state.plans.length, 0); assert.equal(f.state.calls.length, 0);
});

test("quiet change after durable claim but before dispatch is known not applied", async () => {
  const f = fixture(); await f.start(); f.setPlan([tool("send", { text: "no" })]);
  f.store.onCommit((_id, goal) => { if (goal.steps.length) f.state.quiet.a = true; });
  assert.equal((await f.execute()).code, "DELEGATION_STALE_HOST");
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.loop.status("one").receipts[0].status, "failed");
  assert.equal(f.store.read("one").socialDelegation.steps[0].applied, false);
});

test("restrictive controls work under quiet; stale/unverified actors remain denied", async () => {
  const f = fixture(); await f.start(); f.state.quiet.a = true;
  assert.equal((await f.control("pause")).status, "paused");
  await assert.rejects(f.loop.control("one", { action: "cancel", expectedRevision: f.loop.status("one").revision },
    { ...owner, verified: false }), /AUTHORITY_REQUIRED/);
  assert.equal((await f.control("cancel")).status, "cancelled");
});

test("latest registry validator is used at the final gate, not the old closure", async () => {
  const f = fixture(); await f.start(); f.setPlan([tool("send", { text: "no" })]);
  f.store.onCommit((_id, goal) => { if (goal.steps.length) f.descriptors.find(d => d.id === "send").validate = () => false; });
  assert.equal((await f.execute()).ok, false);
  assert.equal(f.state.wires.length, 0); assert.equal(f.state.calls.length, 0);
  assert.equal(f.loop.status("one").receipts[0].code, "DELEGATION_ARGS_INVALID");
});

test("latest-draft control CAS wins even when published MemoryRuntime read lags", async () => {
  const base = memoryStore([taskFor()]); let stale = null, injected = false;
  const store = { ...base, read: id => stale || base.read(id), mutate(id, build) {
    const published = base.read(id);
    if (!injected && published.socialDelegation?.spent.plannerCalls === 1 && !published.socialDelegation.steps.length) {
      injected = true;
      base.mutate(id, goal => applyDelegationControl(goal, { action: "correct", expectedRevision: goal.revision, objective: "最新 draft 目标" }, 1000));
      stale = published;
      try { return base.mutate(id, build); } finally { stale = null; }
    }
    return base.mutate(id, build);
  } };
  let turns = 0;
  const f = fixture({ store, planner: async context => {
    turns++;
    if (turns === 1) return tool("send", { text: "旧 draft 不得发送" });
    assert.equal(context.objective, "最新 draft 目标");
    return turns === 2 ? tool("read_history") : done();
  } });
  await f.start(); assert.equal((await f.execute()).ok, true);
  assert.equal(f.state.wires.length, 0); assert.equal(injected, true);
});

test("TaskRuntime maxTurns is also respected; waits never enqueue themselves", async () => {
  const f = fixture(); await f.start(); f.setPlan(Array.from({ length: 20 }, () => tool("search")));
  assert.equal((await f.execute("one", { config: { maxTurns: 3 } })).delegationStatus, "budget_exhausted");
  assert.equal(f.state.plans.length, 3);
  const g = fixture(); await g.start(); g.setPlan([{ action: "wait", summary: "等下一轮明确输入" }]);
  assert.equal((await g.execute()).delegationStatus, "waiting"); await delay(5);
  assert.equal(g.state.plans.length, 1);
});

test("deadline interrupts stuck model and closes listeners", async () => {
  const entered = deferred(), never = deferred();
  const f = fixture({ planner: async () => { entered.resolve(); return never.promise; } });
  f.state.budget.deadline = 1010; await f.start();
  const running = f.execute(); await entered.promise;
  assert.equal((await running).delegationStatus, "budget_exhausted");
  assert.equal(f.store.listenerCount(), 0); never.resolve(done());
});

test("runtime AbortSignal cancels waiting planner without any tool call", async () => {
  const entered = deferred(), never = deferred(), controller = new AbortController();
  const f = fixture({ planner: async () => { entered.resolve(); return never.promise; } });
  await f.start(); const running = f.execute("one", { signal: controller.signal }); await entered.promise; controller.abort();
  assert.equal((await running).ok, false); assert.equal(f.state.calls.length, 0); assert.equal(f.store.listenerCount(), 0);
  never.resolve(done());
});

test("durable mutation failure stops immediately, with no compensating retry or dispatch", async () => {
  const f = fixture(); await f.start();
  f.store.onCommit((_id, goal) => { if (goal.spent.plannerCalls === 1 && !goal.steps.length) f.store.failNext(); });
  await assert.rejects(f.execute(), /DURABILITY_UNKNOWN/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.store.writes, 4);
});

test("failed receipt persistence does not replay an actual acknowledged write", async () => {
  const f = fixture(); await f.start(); let count = 0;
  f.tools.send = async (_args, meta) => { meta.guard(); count++; f.store.failNext(); return { status: "succeeded", scope: meta.target, receiptId: "wire-ack" }; };
  f.setPlan([tool("send", { text: "once" })]);
  await assert.rejects(f.execute(), /DURABILITY_UNKNOWN/);
  assert.equal(count, 1); assert.equal(f.loop.status("one").receipts[0].status, "claimed");
  // Simulate a recovered store; failure was exactly one write, not a retry policy.
  const restarted = createAgentExecutionLoop(f.host);
  assert.equal((await restarted.execute(f.store.read("one"))).delegationStatus, "uncertain"); assert.equal(count, 1);
});

test("bounded context and observations exclude raw payload/credentials", async () => {
  const f = fixture(); await f.start();
  f.state.budget.maxContextBytes = 2500; f.state.budget.maxObservationBytes = 600;
  f.tools.search = async (_args, meta) => ({ status: "succeeded", scope: meta.target, value: "x".repeat(20000) + " token=synthetic-secret" });
  f.setPlan([...Array.from({ length: 12 }, () => tool("search")), done()]);
  assert.equal((await f.execute()).ok, true);
  assert(f.state.plans.every(c => Buffer.byteLength(JSON.stringify(c)) <= 2500));
  assert(f.state.plans.at(-1).omittedSteps > 0);
  assert(!JSON.stringify(f.store.read("one")).includes("synthetic-secret"));
});

for (const foreign of ["envelope", "nested", "scope_alias"]) {
  test(`read_history rejects cross-bot ${foreign} before exposing data to planner`, async () => {
    const f = fixture(); await f.start();
    f.tools.read_history = async (_args, meta) => ({ status: "succeeded", scope: foreign === "envelope" ? target("b") : meta.target,
      value: { records: [{ [foreign === "scope_alias" ? "logical_bot_id" : "logicalBotId"]: "account:b", text: "FOREIGN_PRIVATE_EVIDENCE" }] } });
    f.setPlan([tool("read_history"), done()]);
    assert.equal((await f.execute()).ok, false);
    assert.equal(f.loop.status("one").receipts[0].code, "DELEGATION_FOREIGN_SCOPE");
    assert(!JSON.stringify(f.state.plans).includes("FOREIGN_PRIVATE_EVIDENCE"));
    assert(!JSON.stringify(f.store.read("one")).includes("FOREIGN_PRIVATE_EVIDENCE"));
  });
}

test("concurrent accounts in same physical group keep plans/history/receipts isolated", async () => {
  const tasks = [taskFor("a-job", target("a")), taskFor("b-job", target("b"))];
  const f = fixture({ tasks, planner: async context => {
    if (!context.observations.length) return tool("read_history");
    if (context.observations.length === 1) return tool("send", { text: "result" });
    return done();
  } });
  await Promise.all(tasks.map(t => f.start(t.id)));
  const results = await Promise.all(tasks.map(t => f.execute(t.id)));
  assert(results.every(r => r.ok)); assert.equal(f.state.wires.length, 2);
  for (const task of tasks) {
    const goal = f.store.read(task.id).socialDelegation;
    assert.equal(goal.target.accountId, task.accountId);
    assert(goal.steps[0].observation.includes(task.logicalBotId));
    assert(!goal.steps[0].observation.includes(task.accountId === "a" ? "account:b" : "account:a"));
  }
  assert.equal(new Set(f.state.calls.map(c => c.operationId)).size, 4);
});

test("group evidence may contain multiple real members but never another route", async () => {
  const f = fixture(); await f.start();
  f.tools.read_history = async (_args, meta) => ({ status: "succeeded", scope: { ...meta.target, userId: "22001" }, value: {
    logicalBotId: meta.target.logicalBotId, conversationId: meta.target.conversationId,
    members: [{ userId: "22001" }, { user_id: 22002 }, { userId: "22003", senderId: "22004" }] } });
  f.setPlan([tool("read_history"), done()]); assert.equal((await f.execute()).ok, true);
  for (const foreign of [{ conversationId: "private:22001", userId: "22001" }, { accountId: "b", userId: "22001" }]) {
    const g = fixture(); await g.start();
    g.tools.read_history = async (_args, meta) => ({ status: "succeeded", scope: meta.target, value: { members: [foreign] } });
    g.setPlan([tool("read_history"), done()]); assert.equal((await g.execute()).ok, false);
    assert.equal(g.loop.status("one").receipts[0].code, "DELEGATION_FOREIGN_SCOPE");
  }
});

test("a completed tool's guard/signal cannot authorize the next tool's context", async () => {
  const f = fixture(); await f.start();
  let old;
  f.tools.read_history = async (_args, meta) => {
    meta.guard(); old = meta;
    return { status: "succeeded", scope: meta.target, value: { memberRef: "opaque-member" } };
  };
  f.tools.send = async (_args, meta) => {
    assert.notEqual(meta.guard, old.guard); assert.notEqual(meta.signal, old.signal);
    assert.equal(old.signal.aborted, true);
    assert.throws(() => old.guard(), /DELEGATION_CALL_CLOSED/);
    // A host prepare closure from the read step is also expired. Host adapters
    // must open a fresh content grant using THIS step's guard, not reuse it.
    const stalePrepare = () => old.guard();
    assert.throws(stalePrepare, /DELEGATION_CALL_CLOSED/); meta.guard();
    return { status: "succeeded", scope: meta.target, receiptId: "fresh-guard-ack" };
  };
  f.setPlan([tool("read_history"), tool("send", { text: "synthetic" }), done()]);
  assert.equal((await f.execute()).ok, true);
  assert.throws(() => old.guard(), /DELEGATION_CALL_CLOSED/); assert.equal(f.store.listenerCount(), 0);
});

test("planner receives immutable host-only account target/task metadata per concurrent run", async () => {
  const tasks = [taskFor("a-job", target("a")), taskFor("b-job", target("b"))], seen = [];
  const f = fixture({ tasks, planner: async (input, meta) => {
    seen.push({ target: meta.target, taskId: meta.taskId });
    assert.equal(Object.isFrozen(meta.target), true); assert.equal(input.target, undefined); assert.equal(input.taskId, undefined);
    return input.observations.length ? done() : tool("read_history");
  } });
  await Promise.all(tasks.map(t => f.start(t.id))); await Promise.all(tasks.map(t => f.execute(t.id)));
  assert(seen.every(s => s.target.accountId === s.taskId[0])); assert.equal(seen.length, 4);
});

test("private evidence user remains exact even though group member IDs are allowed", async () => {
  const dest = { accountId: "a", logicalBotId: "account:a", conversationId: "private:22001", userId: "22001" };
  const f = fixture({ tasks: [{ ...taskFor(), ...dest, groupId: "", messageType: "private" }] });
  await f.loop.start("one", { kind: "goal", objective: "private scoped goal", target: dest }, owner);
  f.tools.read_history = async (_args, meta) => ({ status: "succeeded", scope: meta.target, value: { userId: "22002" } });
  f.setPlan([tool("read_history"), done()]); assert.equal((await f.execute()).ok, false);
  assert.equal(f.loop.status("one").receipts[0].code, "DELEGATION_FOREIGN_SCOPE");
});

test("quieting one account never blocks independent account in same group", async () => {
  const tasks = [taskFor("a-job", target("a")), taskFor("b-job", target("b"))];
  const f = fixture({ tasks, planner: async context => context.observations.length ? done() : tool("read_history") });
  await Promise.all(tasks.map(t => f.start(t.id))); f.state.quiet.a = true;
  await assert.rejects(f.execute("a-job"), /STALE_HOST/);
  assert.equal((await f.execute("b-job")).ok, true);
});

test("pure control CAS preserves terminal/uncertain evidence and cannot retarget", () => {
  const goal = createDelegationGoal({ objective: "goal", target: target(), now: 1 });
  assert.throws(() => applyDelegationControl(goal, { action: "pause", expectedRevision: 0 }, 2), /CONFLICT/);
  assert.throws(() => applyDelegationControl(goal, { action: "correct", expectedRevision: 1, objective: "new", target: target("b") }, 2), /CONFLICT/);
  const paused = applyDelegationControl(goal, { action: "pause", expectedRevision: 1 }, 2);
  const corrected = applyDelegationControl(paused, { action: "correct", objective: "new", expectedRevision: 2 }, 3);
  assert.equal(corrected.status, "paused"); assert.equal(goal.objective, "goal");
});

test("real TaskRuntime queue/store adapter and restart use only disposable synthetic roots", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-delegation-test-"));
  let tasks;
  try {
    const scaffold = fixture();
    let loop;
    tasks = new TaskRuntime({ rootDir, config: { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: [owner.userId] } },
      execute: (task, runtime) => loop.execute(task, runtime), notify: async () => true });
    const offer = tasks.createOffer({ ...target(), messageType: "group", userId: owner.userId, objective: "synthetic actual queue" });
    const store = createTaskDelegationStore(tasks);
    loop = createAgentExecutionLoop({ ...scaffold.host, store });
    await loop.start(offer.id, { kind: "goal", objective: "synthetic queue", target: target() }, owner);
    assert.equal(tasks.confirm(offer.id, owner).ok, true);
    await until(() => tasks.get(offer.id).status === "completed" && tasks.running.size === 0);
    assert.equal(loop.status(offer.id).status, "completed");
    const disk = JSON.parse(fs.readFileSync(tasks.taskPath(offer.id), "utf8"));
    assert.equal(disk.socialDelegation.steps.length, 2);
    assert(disk.socialDelegation.steps.every(s => s.status === "succeeded"));
    await tasks.stateBarrier();
    let replayed = 0;
    const restarted = new TaskRuntime({ rootDir, config: { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: [owner.userId] } },
      execute: async () => { replayed++; return { ok: true }; }, notify: async () => true });
    await restarted.pump(); assert.equal(replayed, 0); assert.equal(restarted.queue.length, 0);
    assert.equal(restarted.get(offer.id).socialDelegation.status, "completed");
  } finally {
    if (tasks) await until(() => tasks.running.size === 0);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("real TaskRuntime restart/manual resume cannot replay accepted delegated send", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-delegation-restart-test-"));
  let restarted;
  try {
    const config = { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: [owner.userId] } };
    const original = new TaskRuntime({ rootDir, config, execute: async () => assert.fail("no original execution"), notify: async () => true });
    const offer = original.createOffer({ ...target(), messageType: "group", userId: owner.userId, objective: "synthetic restart" });
    const synthetic = fixture(), store = createTaskDelegationStore(original);
    const loop = createAgentExecutionLoop({ ...synthetic.host, store });
    await loop.start(offer.id, { kind: "goal", target: target(), objective: "synthetic restart" }, owner);
    store.mutate(offer.id, goal => ({ ...goal, status: "accepted", runId: "old-run", spent: { steps: 1, plannerCalls: 1, units: 1 },
      steps: [{ operationId: "accepted-onebot", capability: "send", effect: "write", status: "accepted" }] }));
    original.get(offer.id).status = "running"; original.persist(original.get(offer.id));
    let nextLoop;
    restarted = new TaskRuntime({ rootDir, config, execute: (task, runtime) => nextLoop.execute(task, runtime), notify: async () => true });
    assert.equal(restarted.get(offer.id).status, "accepted");
    nextLoop = createAgentExecutionLoop({ ...synthetic.host, store: createTaskDelegationStore(restarted) });
    assert.equal(restarted.queue.length, 0); assert.equal(synthetic.state.plans.length, 0);
    // Even a legacy TaskRuntime resume path that does not call loop.control()
    // cannot get past the durable delegated receipt fence.
    assert.equal(restarted.resume(offer.id, owner).code, "UNRESOLVED_SIDE_EFFECT");
    assert.equal(restarted.queue.length, 0); assert.equal(restarted.running.size, 0);
    assert.equal(nextLoop.status(offer.id).status, "accepted");
    assert.equal(synthetic.state.plans.length, 0); assert.equal(synthetic.state.wires.length, 0);
    await assert.rejects(nextLoop.control(offer.id, { action: "resume", expectedRevision: nextLoop.status(offer.id).revision }, owner), /UNRESOLVED_EFFECT/);
  } finally {
    if (restarted) await until(() => restarted.running.size === 0);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

async function realDelegation(run, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-lifecycle-test-"));
  let tasks;
  try {
    const f = fixture(), notices = [], executions = [];
    f.host.clock = Date.now; f.state.budget.deadline = Date.now() + 60000;
    const config = { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: [owner.userId], maxTurns: 50 } };
    let loop, customExecute;
    tasks = new TaskRuntime({ rootDir, config, validateDelegationActor: options.verify,
      execute: (task, runtime) => { executions.push(task.attemptId); return customExecute ? customExecute(task, runtime) : loop.execute(task, runtime); },
      notify: async (_task, notice) => { notices.push(notice); return true; } });
    loop = createAgentExecutionLoop({ ...f.host, store: createTaskDelegationStore(tasks) });
    const task = tasks.createOffer({ ...target(), messageType: "group", userId: owner.userId, objective: "持续目标" });
    await loop.start(task.id, { kind: "goal", target: target(), objective: "持续目标" }, owner);
    const context = { ...f, loop, tasks, task, config, rootDir, notices, executions,
      executeWith: fn => { customExecute = fn; },
      idle: () => until(() => !tasks.running.size && !tasks.queue.length),
      event: (eventId = "real-human-message") => ({ userId: owner.userId, verified: true, kind: "event", source: "host_event",
        ...target(), eventId, eventAt: Date.now(), expectedDelegationRevision: tasks.get(task.id).socialDelegation.revision }) };
    await run(context);
    await tasks.stateBarrier();
  } finally {
    if (tasks) {
      for (const controller of tasks.controllers.values()) controller.abort();
      await until(() => !tasks.running.size);
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test("native waiting persists, occupies no slot, and resumes on one attested fresh event", async () => {
  const attested = new WeakSet();
  await realDelegation(async h => {
    h.setPlan([{ action: "wait", summary: "等待群里下一条真实消息" }]);
    assert.equal(h.tasks.confirm(h.task.id, owner).ok, true); await h.idle();
    assert.equal(h.task.status, "waiting"); assert.equal(h.task.lastError, ""); assert.equal(h.task.completedAt, "");
    assert.equal(h.tasks.activeForConversation(h.task.conversationId, { logicalBotId: h.task.logicalBotId }).id, h.task.id);
    assert.equal(h.tasks.snapshot(h.task.id).status, "waiting");
    assert(!h.notices.some(n => n.type === "failed"));
    await delay(5); assert.equal(h.executions.length, 1);
    const event = h.event(); attested.add(event);
    h.setPlan([tool("read_history"), done()]);
    assert.equal(h.tasks.resume(h.task.id, event).ok, true);
    assert.equal(h.task.status, "queued"); assert.equal(h.task.socialDelegation.status, "ready");
    await h.idle(); assert.equal(h.task.status, "completed"); assert.equal(h.executions.length, 2);
    assert.equal(new Set(h.executions).size, 2); assert.equal(h.task.socialDelegation.resumeEventClaims.length, 1);
  }, { verify: (actor, _task, context) => !context.event || attested.has(actor) });
});

test("event source/identity/CAS/durable dedup cannot be supplied by model JSON", async () => {
  const attested = new WeakSet();
  await realDelegation(async h => {
    h.setPlan([{ action: "wait", summary: "等真实事件" }]);
    h.tasks.confirm(h.task.id, owner); await h.idle();
    for (const patch of [{ source: "model" }, { kind: "human" }, { verified: false }, { accountId: "b" },
      { logicalBotId: "account:b" }, { groupId: "20002" }, { conversationId: "group:20002" }, { eventId: "" }, { eventAt: Date.now() + 100000 },
      { eventAt: Date.now() - 120001 },
      { expectedDelegationRevision: 0 }]) {
      const actor = { ...h.event(), ...patch }; attested.add(actor);
      assert.equal(h.tasks.resume(h.task.id, actor).ok, false);
    }
    assert.equal(h.tasks.resume(h.task.id, h.event()).ok, false, "unattested JSON cannot stand in for source verification");
    assert.equal(h.tasks.resume(h.task.id, { ...owner, source: "timer" }).ok, false);
    h.setPlan([{ action: "wait", summary: "仍然等待" }]);
    const event = h.event("only-once"); attested.add(event);
    assert.equal(h.tasks.resume(h.task.id, event).ok, true); await h.idle();
    const duplicate = h.event("only-once"); attested.add(duplicate);
    assert.equal(h.tasks.resume(h.task.id, duplicate).code, "DELEGATION_EVENT_ALREADY_CLAIMED");
    assert.equal(h.task.status, "waiting"); assert.equal(h.executions.length, 2);
  }, { verify: (actor, _task, context) => !context.event || attested.has(actor) });
  await realDelegation(async h => {
    h.setPlan([{ action: "wait", summary: "waiting" }]); h.tasks.confirm(h.task.id, owner); await h.idle();
    assert.equal(h.tasks.resume(h.task.id, h.event()).code, "DELEGATION_EVENT_SOURCE_REQUIRED");
  });
});

test("event attestation is synchronous strict-true and receives immutable scope/context", async () => {
  await realDelegation(async h => {
    h.setPlan([{ action: "wait", summary: "waiting" }]); h.tasks.confirm(h.task.id, owner); await h.idle();
    const result = h.tasks.resume(h.task.id, h.event());
    assert.equal(result.ok, false); assert.equal(result.code, "DELEGATION_ACTOR_REQUIRED");
    assert.equal(h.tasks.queue.length, 0); assert.equal(h.executions.length, 1);
  }, { verify: (_actor, task, context) => {
    assert.equal(Object.isFrozen(task), true); assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(task.socialDelegation.target), true);
    return context.event ? Promise.resolve(true) : true;
  } });
});

test("native paused cannot be lifted by event; explicit human resumes existing queue", async () => {
  const entered = deferred(), late = deferred();
  await realDelegation(async h => {
    const pendingLoop = createAgentExecutionLoop({ ...h.host, store: createTaskDelegationStore(h.tasks),
      planner: async () => { entered.resolve(); return late.promise; } });
    h.executeWith((task, runtime) => pendingLoop.execute(task, runtime));
    h.tasks.confirm(h.task.id, owner); await entered.promise;
    await pendingLoop.control(h.task.id, { action: "pause", expectedRevision: pendingLoop.status(h.task.id).revision }, owner);
    await h.idle(); assert.equal(h.task.status, "paused"); assert.equal(h.task.completedAt, "");
    assert.equal(h.tasks.resume(h.task.id, h.event()).code, "DELEGATION_EVENT_RESUME_BLOCKED");
    h.executeWith(null); h.setPlan([tool("read_history"), done()]);
    assert.equal(h.tasks.resume(h.task.id, owner).ok, true); await h.idle();
    assert.equal(h.task.status, "completed"); assert.equal(h.executions.length, 2);
    late.resolve(tool("send", { text: "旧计划不得发送" })); await delay(0);
    assert.equal(h.state.wires.length, 0); assert(!h.notices.some(n => n.type === "failed"));
  }, { verify: () => true });
});

test("native budget_exhausted is parked without failed timestamp or auto wake", async () => {
  await realDelegation(async h => {
    h.state.budget.maxPlannerCalls = 0; h.tasks.confirm(h.task.id, owner); await h.idle();
    assert.equal(h.task.status, "budget_exhausted"); assert.equal(h.task.completedAt, ""); assert.equal(h.task.lastError, "");
    assert.equal(h.state.plans.length, 0); await delay(5); assert.equal(h.executions.length, 1);
    h.state.budget.maxPlannerCalls = 50; h.setPlan([tool("search"), done()]);
    assert.equal(h.tasks.resume(h.task.id, owner).ok, true); await h.idle();
    assert.equal(h.task.status, "completed"); assert.equal(h.executions.length, 2);
  });
});

test("native cancel aborts in-flight external tool but keeps uncertain receipt fenced", async () => {
  const entered = deferred(), release = deferred();
  await realDelegation(async h => {
    h.tools.send = async (_args, meta) => { entered.resolve(); await release.promise; meta.guard(); assert.fail("late wire"); };
    h.setPlan([tool("send", { text: "cancel me" }), done()]);
    h.tasks.confirm(h.task.id, owner); await entered.promise;
    assert.equal(h.tasks.cancel(h.task.id, { ...owner, source: "model" }).ok, false);
    assert.equal(h.tasks.cancel(h.task.id, owner).ok, true); await h.idle();
    assert.equal(h.task.status, "cancelled"); assert.equal(h.task.socialDelegation.status, "cancelled");
    assert.equal(h.task.socialDelegation.steps[0].status, "uncertain");
    assert.equal(h.tasks.resume(h.task.id, owner).code, "UNRESOLVED_SIDE_EFFECT");
    release.resolve(); await delay(0); assert.equal(h.state.wires.length, 0);
    assert(!h.notices.some(n => n.type === "failed"));
  });
});

test("read-only recovery rejects model requests for real write tools", async () => {
  const f = fixture(); await f.start();
  f.store.mutate("one", goal => ({ ...goal, recoveryReadOnly: true }));
  f.setPlan([tool("send", { text: "do not replay" })]);
  assert.equal((await f.execute()).ok, false);
  assert(f.state.plans[0].capabilities.every(c => c.effect === "read"));
  assert.equal(f.state.wires.length, 0); assert.equal(f.state.calls.length, 0);
});

test("native interruption preserves receipts; subsequent resume never resets resource usage", async () => {
  const entered = deferred(), late = deferred();
  await realDelegation(async h => {
    h.executeWith((task, runtime) => createAgentExecutionLoop({ ...h.host, store: createTaskDelegationStore(h.tasks),
      planner: async () => { entered.resolve(); return late.promise; } }).execute(task, runtime));
    h.tasks.confirm(h.task.id, owner); await entered.promise; h.tasks.controllers.get(h.task.id).abort(); await h.idle();
    assert.equal(h.task.status, "interrupted"); assert.equal(h.task.socialDelegation.status, "interrupted");
    assert.equal(h.task.completedAt, ""); assert.equal(h.task.lastError, "");
    const reserved = h.task.socialDelegation.spent.plannerCalls;
    h.executeWith(null); h.setPlan([tool("read_history"), done()]);
    assert.equal(h.tasks.resume(h.task.id, owner).ok, true); await h.idle();
    assert.equal(h.task.socialDelegation.spent.plannerCalls, reserved + 2);
    late.resolve(tool("send", { text: "late" })); await delay(0); assert.equal(h.state.wires.length, 0);
  });
});

for (const status of ["accepted", "uncertain", "claimed"]) {
  test(`native ${status} external receipt prevents resume/enqueue before any new attempt`, async () => {
    await realDelegation(async h => {
      h.tasks.mutateDelegation(h.task.id, goal => ({ ...goal, status: status === "claimed" ? "interrupted" : status,
        steps: [{ operationId: "prior-wire", capability: "send", effect: "write", status }] }));
      const before = clone(h.task.socialDelegation.steps);
      assert.equal(h.tasks.resume(h.task.id, owner).code, "UNRESOLVED_SIDE_EFFECT");
      assert.equal(h.tasks.queue.length, 0); assert.equal(h.executions.length, 0);
      assert.deepEqual(h.task.socialDelegation.steps, before);
    });
  });
}

test("MAX-pass cannot swallow goal controls/supplements or return false completion", async () => {
  await realDelegation(async h => {
    h.executeWith(async task => {
      h.tasks.mutateDelegation(task.id, goal => ({ ...goal, status: "running", runId: "stale-executor" }));
      const old = clone(task.socialDelegation);
      assert.equal(h.tasks.addContext(task.id, "补充一", owner).ok, true);
      assert.equal(h.tasks.addContext(task.id, "补充二", owner).ok, true);
      return { ok: true, delegationStatus: "completed", delegationRevision: old.revision,
        delegationControlRevision: old.controlRevision, delegationSupplementCount: 0, summary: "旧结果" };
    });
    h.tasks.confirm(h.task.id, owner); await h.idle();
    assert.equal(h.executions.length, 1); assert.equal(h.task.status, "interrupted");
    assert.equal(h.task.socialDelegation.controlRevision, 3); assert.equal(h.task.socialDelegation.supplementCount, 2);
    h.executeWith(null); h.setPlan([tool("read_history"), done()]);
    h.tasks.resume(h.task.id, owner); await h.idle();
    assert.deepEqual(h.state.plans[0].supplements, ["补充一", "补充二"]);
    assert.equal(h.task.status, "completed"); assert.equal(h.executions.length, 2);
  });
});

test("restart resumes only read-safe evaluation, keeps prior receipts and sends no notices", async () => {
  await realDelegation(async h => {
    const prior = { operationId: "already-acknowledged", capability: "send", effect: "write", status: "succeeded", receiptId: "old-qq-ack" };
    h.tasks.mutateDelegation(h.task.id, goal => ({ ...goal, status: "running", runId: "crashed", steps: [prior] }));
    h.task.status = "running"; h.tasks.persist(h.task);
    const notices = [], attested = new WeakSet(); let nextLoop, runs = 0;
    const next = new TaskRuntime({ rootDir: h.rootDir, config: h.config, validateDelegationActor: actor => actor.source !== "host_event" || attested.has(actor),
      execute: (task, runtime) => { runs++; return nextLoop.execute(task, runtime); }, notify: async (_task, notice) => { notices.push(notice); } });
    try {
      nextLoop = createAgentExecutionLoop({ ...h.host, store: createTaskDelegationStore(next), planner: async context => {
        assert(context.capabilities.every(c => c.effect === "read"));
        return context.observations.some(o => o.capability === "search") ? done() : tool("search");
      } });
      const task = next.get(h.task.id); assert.equal(task.status, "interrupted"); assert.equal(task.socialDelegation.recoveryReadOnly, true);
      await next.pump(); assert.equal(runs, 0); assert.equal(next.queue.length, 0);
      const actor = { ...h.event("post-restart-human"), expectedDelegationRevision: task.socialDelegation.revision }; attested.add(actor);
      assert.equal(next.resume(task.id, actor).ok, true);
      await until(() => !next.running.size && !next.queue.length);
      assert.equal(task.status, "completed"); assert.deepEqual(task.socialDelegation.steps[0], prior);
      assert.equal(h.state.wires.length, 0); assert.equal(notices.length, 0); assert.equal(runs, 1);
    } finally { for (const c of next.controllers.values()) c.abort(); await until(() => !next.running.size); }
  });
});

test("restart event-resume status matrix is read-only, gated and never self-enqueued", async () => {
  for (const status of ["waiting", "budget_exhausted", "interrupted", "blocked", "paused", "accepted", "uncertain", "claimed-write"]) {
    await realDelegation(async h => {
      const unresolved = ["accepted", "uncertain", "claimed-write"].includes(status);
      h.tasks.mutateDelegation(h.task.id, goal => ({ ...goal, status: status === "claimed-write" ? "running" : status,
        steps: unresolved ? [{ operationId: "prior-external-act", capability: "send", effect: "write",
          status: status === "claimed-write" ? "claimed" : status }] : goal.steps }));
      const trusted = new WeakSet(); let loop, executions = 0;
      const next = new TaskRuntime({ rootDir: h.rootDir, config: h.config,
        validateDelegationActor: actor => trusted.has(actor),
        execute: (task, runtime) => { executions++; return loop.execute(task, runtime); },
        notify: async () => assert.fail("recovery must not notify") });
      try {
        loop = createAgentExecutionLoop({ ...h.host, store: createTaskDelegationStore(next), planner: async context => {
          assert(context.capabilities.every(cap => cap.effect === "read"));
          return { action: "wait", summary: "read-only reevaluation" };
        } });
        const task = next.get(h.task.id);
        assert.equal(task.socialDelegation.recoveryReadOnly, true, status);
        await next.pump(); assert.equal(executions, 0, status); assert.equal(next.queue.length, 0, status);
        const actor = { ...h.event(`fresh:${status}`), expectedDelegationRevision: task.socialDelegation.revision };
        trusted.add(actor);
        const resume = next.resume(task.id, actor), allowed = ["waiting", "budget_exhausted", "interrupted", "blocked"].includes(status);
        assert.equal(resume.ok, allowed, status);
        await until(() => !next.running.size && !next.queue.length);
        assert.equal(executions, allowed ? 1 : 0, status); assert.equal(h.state.wires.length, 0, status);
        if (unresolved) assert.equal(task.socialDelegation.steps[0].status, status === "claimed-write" ? "claimed" : status);
      } finally { for (const controller of next.controllers.values()) controller.abort(); await until(() => !next.running.size); }
    });
  }
});

test("target change creates a new verified host task instead of dropping old receipts", async () => {
  await realDelegation(async h => {
    const prior = { operationId: "old-scope-ack", capability: "read_history", effect: "read", status: "succeeded" };
    h.tasks.mutateDelegation(h.task.id, goal => ({ ...goal, status: "waiting", steps: [prior] }));
    await assert.rejects(h.loop.control(h.task.id, { action: "correct", objective: "new bot", expectedRevision: h.loop.status(h.task.id).revision,
      target: target("b") }, owner), /CONTROL_CONFLICT/);
    const other = h.tasks.createOffer({ ...target("b"), messageType: "group", userId: owner.userId, objective: "new target" });
    await h.loop.start(other.id, { kind: "goal", target: target("b"), objective: "new target" }, owner);
    assert.equal(other.socialDelegation.target.logicalBotId, "account:b"); assert.deepEqual(h.task.socialDelegation.steps, [prior]);
    assert.equal(h.task.socialDelegation.target.logicalBotId, "account:a");
    assert.equal(h.tasks.resume(h.task.id, { ...owner, ...target("b") }).ok, false);
  });
});

test("legacy formal-work supplement passes and confirmation semantics stay unchanged", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-passes-test-")); let tasks;
  try {
    let calls = 0;
    tasks = new TaskRuntime({ rootDir, config: { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: [owner.userId] } },
      execute: async task => { calls++; task.supplements.push({ text: `legacy ${calls}` }); return { ok: true, summary: "legacy" }; }, notify: async () => true });
    const task = tasks.createOffer({ ...target(), messageType: "group", userId: owner.userId, objective: "formal work" });
    assert.equal(tasks.confirm(task.id, { userId: owner.userId, source: "admin" }).ok, true);
    await until(() => !tasks.running.size && !tasks.queue.length);
    assert.equal(calls, 2); assert.equal(task.status, "completed");
  } finally { if (tasks) await until(() => !tasks.running.size); fs.rmSync(rootDir, { recursive: true, force: true }); }
});
