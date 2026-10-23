import assert from "node:assert/strict";
import { createSocialAgentRuntime, withSocialAgentUsage, withSocialExpressionPlan } from "../src/social-agent-runtime.js";
import { ingestSocialMessage, getSocialSnapshot, markSocialRead, applySocialContinuity } from "../src/social-agent-state.js";

// No disk, network, production config, account, QQ or model is used here.
const ctx = { logicalId: "account:test", conversationId: "group:123" };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
async function until(predicate) {
  for (let i = 0; i < 1000; i += 1) { if (predicate()) return; await Promise.resolve(); }
  assert.fail("fake callback did not reach expected checkpoint");
}
function fixture(overrides = {}) {
  let root = structuredClone(overrides.root || { unrelated: { keep: true } });
  let time = Date.UTC(2026, 9, 23, 4), nextTimer = 0, tail = Promise.resolve();
  const timers = new Map();
  const policy = { enabled: true, shadowMode: false, conversationIds: ["group:123", "group:456", "private:789"], ...overrides.policy };
  const modelCalls = [], sends = [], toolCalls = [], schedules = [], decisions = [], continuity = [];
  let snapshot = { seenSeq: 3, messages: [{ seq: 3, messageId: "fake-message", userId: "789", text: "fake input" }] }, current = true;
  let afterCommit;
  const clock = {
    now: () => time,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, item] of timers) if (item.at <= time) { timers.delete(id); item.fn(); } }
  };
  const transact = build => {
    assert.notEqual(build.constructor.name, "AsyncFunction", "mutators must be synchronous");
    const work = tail.then(async () => {
      const draft = structuredClone(root);
      const result = build(draft);
      assert.ok(!result || typeof result.then !== "function");
      JSON.stringify(draft);
      root = structuredClone(draft);
      if (afterCommit) await afterCommit(root);
      return result;
    });
    tail = work.catch(() => {});
    return work;
  };
  const tools = Object.fromEntries(["read_unread", "read_detail", "read_history", "read_memory", "web_search"]
    .map(name => [name, async (scope, args, options) => { toolCalls.push({ name, scope, args, options });
      return name === "read_unread" ? { messages: [], seenSeq: 3 } : { items: ["fake result"] }; }]));
  tools.schedule_followup = async (scope, args, metadata) => { schedules.push({ scope, args, metadata }); return { scheduled: true }; };
  Object.assign(tools, overrides.tools);
  const callbacks = {
    getPolicy: () => policy, getSnapshot: () => snapshot, transact,
    callModel: args => { modelCalls.push(args); return overrides.model ? overrides.model(args, modelCalls.length)
      : withSocialAgentUsage({ action: "reply", messages: ["fake final"], throughSeq: 3 }, { inputTokens: 4, outputTokens: 2 }); },
    tools, sendIntent: async (scope, intent) => { sends.push({ scope, intent }); return overrides.send?.(scope, intent); },
    isCurrent: () => current, clock,
    onDecision: async (scope, decision) => { decisions.push({ scope, decision }); return overrides.onDecision?.(scope, decision); },
    applyContinuity: async (scope, proposal, metadata) => { continuity.push({ scope, proposal, metadata }); return overrides.applyContinuity?.(scope, proposal, metadata); }
  };
  const runtime = createSocialAgentRuntime(callbacks);
  const run = async (scope = ctx) => { assert.equal(runtime.observe(scope).queued, true); return runtime.runDue(); };
  return { runtime, callbacks, run, policy, clock, modelCalls, sends, toolCalls, schedules, decisions, continuity,
    get root() { return root; }, get usage() { return root.socialAgents?.bots?.[ctx.logicalId]?.runtimeUsage?.days?.["2026-10-23"]; },
    get state() { return root.socialAgents?.bots?.[ctx.logicalId]?.conversations?.[ctx.conversationId]?.runtime; },
    setSnapshot(value) { snapshot = value; }, setCurrent(value) { current = value; },
    afterCommit(fn) { afterCommit = fn; }, get timerCount() { return timers.size; } };
}
const code = result => result[0]?.code;
let checks = 0;
async function check(name, test) { await test(); checks += 1; console.log(`PASS ${name}`); }

await check("durable reservation / accounting / one intent / no duplicate", async () => {
  const f = fixture();
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].scope, ctx);
  assert.equal(f.sends[0].intent.throughSeq, 3);
  assert.equal(f.usage.reservedCalls, 1); assert.equal(f.usage.actualCalls, 1);
  assert.equal(f.usage.unknownUsageCalls, 0); assert.equal(f.usage.inputTokens, 4);
  assert.equal(code(await f.run()), "SOCIAL_ALREADY_PROCESSED");
  assert.equal(f.modelCalls.length, 1);
  assert.deepEqual(f.root.unrelated, { keep: true });
  assert.equal(f.timerCount, 0);
});

await check("disabled by default / canonical scopes only / no state creation", async () => {
  const f = fixture({ policy: { enabled: false } });
  assert.equal(f.runtime.observe(ctx).queued, false);
  assert.deepEqual(await f.runtime.runDue(), []);
  assert.equal(f.root.socialAgents, undefined);
  for (const conversationId of ["group:0123", "group:other", "123", "group:999", "__proto__"]) {
    assert.equal(f.runtime.observe({ ...ctx, conversationId }).queued, false);
  }
});

await check("shadow default suppresses sends and schedule callbacks", async () => {
  const f = fixture({ policy: { shadowMode: undefined } });
  assert.equal(code(await f.run()), "SOCIAL_SHADOWED"); assert.equal(f.sends.length, 0);
  const wait = fixture({ policy: { shadowMode: true }, model: () => ({ action: "dive", delayMs: 5000 }) });
  assert.equal(code(await wait.run()), "SOCIAL_SHADOWED"); assert.equal(wait.schedules.length, 0);
});

await check("future input cannot be ACKed / malformed raw text never sent", async () => {
  for (const decision of ["raw secret-bearing draft", { action: "reply", messages: ["draft"], throughSeq: 4 },
    { action: "observe", messages: ["draft"] }, { action: "reply", messages: ["draft"], foreignId: "x" }]) {
    const f = fixture({ model: () => decision });
    assert.match(code(await f.run()), /^SOCIAL_INVALID_/); assert.equal(f.sends.length, 0);
    assert.equal(f.usage.actualCalls, 1); assert.equal(f.usage.unknownUsageCalls, 1);
    assert.ok(!JSON.stringify(f.root).includes("draft"));
  }
});

await check("whitelisted scoped tools / strict args / bounded observed sequence", async () => {
  const f = fixture({ model: (_, n) => n === 1 ? { action: "tool", tool: { name: "read_detail", args: { seq: 2 } } }
    : { action: "reply", messages: ["fake final"], throughSeq: 2 } });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.equal(f.toolCalls.length, 1);
  assert.deepEqual(f.toolCalls[0].scope, ctx);
  assert.equal(f.modelCalls[1].snapshot.toolResults[0].name, "read_detail");
  for (const tool of [{ name: "terminal", args: {} }, { name: "web_search", args: { query: "x", conversationId: "group:456" } },
    { name: "read_detail", args: { seq: 4 } }, { name: "read_history", args: { beforeSeq: 99 } }]) {
    const bad = fixture({ model: () => ({ action: "tool", tool }) });
    assert.equal(code(await bad.run()), "SOCIAL_INVALID_TOOL"); assert.equal(bad.toolCalls.length, 0);
  }
});

await check("bounded eight calls / lower tool budget / unknown usage", async () => {
  const f = fixture({ model: () => ({ action: "tool", tool: { name: "read_unread", args: {} } }) });
  assert.equal(code(await f.run()), "SOCIAL_CALL_LIMIT");
  assert.equal(f.modelCalls.length, 8); assert.equal(f.usage.actualCalls, 8); assert.equal(f.usage.unknownUsageCalls, 8);
  const lower = fixture({ policy: { maxToolCalls: 1 }, model: () => ({ action: "tool", tool: { name: "read_memory", args: {} } }) });
  assert.equal(code(await lower.run()), "SOCIAL_TOOL_LIMIT"); assert.equal(lower.toolCalls.length, 1);
});

await check("daily budget shared across concurrent conversations / max global two", async () => {
  const gates = [deferred(), deferred()];
  const f = fixture({ policy: { maxDailyCalls: 1 }, model: (_, n) => gates[n - 1].promise });
  for (const conversationId of ["group:123", "group:456", "private:789"]) f.runtime.observe({ ...ctx, conversationId });
  const running = f.runtime.runDue();
  await until(() => f.modelCalls.length === 1);
  assert.ok(f.runtime.status().active <= 2); assert.equal(f.runtime.status().queued, 1);
  assert.deepEqual(await f.runtime.runDue(), []);
  gates[0].resolve({ action: "observe" });
  const results = await running;
  assert.deepEqual(results.map(item => item.code).sort(), ["SOCIAL_BUDGET_EXHAUSTED", "SOCIAL_COMPLETED"]);
  await f.runtime.runDue(); assert.equal(f.modelCalls.length, 1); assert.equal(f.usage.reservedCalls, 1);
});

await check("per-scope exclusion / direct cancellation / late model ignored", async () => {
  const gate = deferred();
  const f = fixture({ model: (_, n) => n === 1 ? gate.promise : { action: "observe" } });
  const running = f.run(); await until(() => f.modelCalls.length === 1);
  assert.equal(f.runtime.cancel(ctx.logicalId, ctx.conversationId).cancelled, 1);
  assert.equal(code(await running), "SOCIAL_CANCELLED");
  gate.resolve({ action: "reply", messages: ["late draft"] }); await flush();
  assert.equal(f.sends.length, 0); assert.equal(f.usage.unknownUsageCalls, 1);
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
});

await check("disable / route revision / quiet after persistence blocks model or wire", async () => {
  const f = fixture();
  let reservations = 0;
  f.afterCommit(root => {
    if (root.socialAgents?.bots?.[ctx.logicalId]?.runtimeUsage && !reservations++) f.policy.enabled = false;
  });
  assert.equal(code(await f.run()), "SOCIAL_DISABLED"); assert.equal(f.modelCalls.length, 0);
  const wire = fixture();
  wire.afterCommit(root => {
    if (root.socialAgents?.bots?.[ctx.logicalId]?.conversations?.[ctx.conversationId]?.runtime?.status === "intent_claimed") wire.setCurrent(false);
  });
  assert.equal(code(await wire.run()), "SOCIAL_STALE"); assert.equal(wire.sends.length, 0);
});

await check("fake-clock timeout ignores uncooperative late completion", async () => {
  const gate = deferred(); const f = fixture({ model: () => gate.promise });
  const running = f.run(); await until(() => f.modelCalls.length === 1);
  f.clock.advance(60_000);
  assert.equal(code(await running), "SOCIAL_TIMEOUT");
  gate.resolve({ action: "reply", messages: ["late draft"] }); await flush();
  assert.equal(f.sends.length, 0); assert.equal(f.timerCount, 0);
});

await check("wait/dive schedule executable scoped plans / explicit due resume", async () => {
  for (const action of ["wait", "dive", "tool"]) {
    const f = fixture({ model: (_, n) => n > 1 ? { action: "observe" } : action === "tool"
      ? { action, tool: { name: "schedule_followup", args: { delayMs: 1000 } } }
      : { action, delayMs: 1000, throughSeq: 2 } });
    assert.equal(code(await f.run()), "SOCIAL_WAITING"); assert.equal(f.schedules.length, 1);
    assert.deepEqual(f.schedules[0].scope, ctx); assert.equal(f.schedules[0].metadata.dueAt, f.clock.now() + 1000);
    assert.equal(code(await f.run({ ...ctx, resumeDue: true })), "SOCIAL_ALREADY_PROCESSED");
    f.clock.advance(1000);
    assert.equal(code(await f.run()), "SOCIAL_ALREADY_PROCESSED");
    assert.equal(code(await f.run({ ...ctx, resumeDue: true })), "SOCIAL_COMPLETED");
  }
  const f = fixture({ tools: { schedule_followup: undefined }, model: () => ({ action: "wait", delayMs: 1000 }) });
  assert.equal(code(await f.run()), "SOCIAL_SCHEDULE_UNAVAILABLE");
});

await check("restart never automatically replays plans or uncertain intents", async () => {
  const f = fixture({ model: () => ({ action: "wait", delayMs: 1000 }) }); await f.run();
  f.clock.advance(5000);
  const restart = createSocialAgentRuntime(f.callbacks);
  assert.deepEqual(await restart.runDue(), []); assert.equal(f.modelCalls.length, 1);
  restart.observe(ctx); assert.equal(code(await restart.runDue()), "SOCIAL_ALREADY_PROCESSED");
  assert.equal(f.state.status, "paused"); assert.equal(f.state.reason, "startup_interrupted");
  const uncertain = fixture({ send: () => { throw new Error("secret content must never escape"); } });
  assert.equal(code(await uncertain.run()), "SOCIAL_CALLBACK_FAILED"); assert.equal(uncertain.sends.length, 1);
  const again = createSocialAgentRuntime(uncertain.callbacks);
  again.observe({ ...ctx, resumeDue: true }); await again.runDue(); assert.equal(uncertain.sends.length, 1);
  assert.ok(!JSON.stringify(uncertain.runtime.status()).includes("secret"));
});

await check("unpublished transaction failure is not retried / no model side effect", async () => {
  const f = fixture(); let transactions = 0;
  const runtime = createSocialAgentRuntime({ ...f.callbacks, transact: () => { transactions += 1; throw new Error("secret storage failure"); } });
  runtime.observe(ctx);
  assert.equal(code(await runtime.runDue()), "SOCIAL_CALLBACK_FAILED");
  assert.equal(transactions, 1); assert.equal(f.modelCalls.length, 0); assert.equal(f.sends.length, 0);
});

await check("tool timeout / cancellation after intent claim / content-free failures", async () => {
  const toolGate = deferred();
  const f = fixture({ model: () => ({ action: "tool", tool: { name: "web_search", args: { query: "fake" } } }),
    tools: { web_search: () => toolGate.promise } });
  const running = f.run(); await until(() => f.usage?.actualCalls === 1); await flush(); f.clock.advance(60_000);
  assert.equal(code(await running), "SOCIAL_TIMEOUT"); toolGate.resolve({ answer: "late" }); await flush();
  assert.equal(f.sends.length, 0);
  const cancelled = fixture();
  cancelled.afterCommit(root => {
    if (root.socialAgents?.bots?.[ctx.logicalId]?.conversations?.[ctx.conversationId]?.runtime?.status === "intent_claimed") cancelled.runtime.cancel(ctx.logicalId);
  });
  assert.equal(code(await cancelled.run()), "SOCIAL_CANCELLED"); assert.equal(cancelled.sends.length, 0);
});

await check("model self-reported usage is unknown / only adapter receipts count", async () => {
  const f = fixture({ model: () => ({ action: "observe", usage: { inputTokens: 99999, outputTokens: 99999 } }) });
  await f.run(); assert.equal(f.usage.inputTokens, 0); assert.equal(f.usage.unknownUsageCalls, 1);
  const trusted = fixture({ model: () => withSocialAgentUsage({ action: "observe", usage: { inputTokens: 99999, outputTokens: 99999 } },
    { inputTokens: 7, outputTokens: 3 }) });
  await trusted.run(); assert.equal(trusted.usage.inputTokens, 7); assert.equal(trusted.usage.outputTokens, 3);
  assert.equal(trusted.usage.unknownUsageCalls, 0);
});

await check("core structured continuity / pinned evidence / post-terminal callback", async () => {
  const proposal = { mood: { valence: 0.5, engagement: 0.2 },
    experiences: [{ text: "fake experience", evidenceMessageIds: ["fake-message"] }],
    habits: [{ text: "candidate only; core must validate frequency", evidenceMessageIds: ["fake-message"] }] };
  const f = fixture({ model: () => ({ action: "observe", throughSeq: 2, continuity: proposal }) });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.equal(f.continuity.length, 1);
  assert.deepEqual(f.continuity[0].metadata.seenMessageIds, ["fake-message"]);
  assert.deepEqual(f.continuity[0].proposal, proposal); assert.equal(f.decisions[0].decision.throughSeq, 2);
  assert.equal(f.decisions[0].decision.seenSeq, 3);
  const rejected = fixture({ model: () => ({ action: "observe", continuity: proposal }), applyContinuity: () => ({ ok: false, reason: "insufficient_habit_evidence" }) });
  assert.equal(code(await rejected.run()), "SOCIAL_CONTINUITY_REJECTED"); assert.equal(rejected.decisions.length, 0);
  for (const bad of [{ topic: "old unsupported field" }, { mood: { valence: 2 } },
    { experiences: [{ text: "fake", evidenceMessageIds: ["future-message"] }] },
    { experiences: [{ text: "fake", userId: "foreign" }] }]) {
    const invalid = fixture({ model: () => ({ action: "observe", continuity: bad }) });
    assert.equal(code(await invalid.run()), "SOCIAL_INVALID_CONTINUITY"); assert.equal(invalid.continuity.length, 0);
  }
  const shadow = fixture({ policy: { shadowMode: true }, model: () => ({ action: "observe", continuity: proposal }) });
  await shadow.run(); assert.equal(shadow.continuity.length, 0); assert.equal(shadow.decisions.length, 1);
});

await check("configured daily budget above 1000 / shared upper 10000", async () => {
  const base = fixture(); await base.run();
  const root = structuredClone(base.root);
  const bot = root.socialAgents.bots[ctx.logicalId];
  bot.runtimeUsage.days["2026-10-23"].reservedCalls = 1200;
  delete bot.conversations[ctx.conversationId].runtime.lastProcessedSeq;
  const f = fixture({ root, policy: { maxDailyCalls: 2000 }, model: () => ({ action: "observe" }) });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.equal(f.usage.reservedCalls, 1201);
  const invalid = fixture({ policy: { maxDailyCalls: 10_001 } });
  assert.equal(code(await invalid.run()), "SOCIAL_BUDGET_EXHAUSTED"); assert.equal(invalid.modelCalls.length, 0);
});

await check("Shanghai midnight daily budget rollover (not UTC midnight)", async () => {
  const f = fixture({ policy: { maxDailyCalls: 1 }, model: () => ({ action: "observe" }) });
  f.clock.advance(11 * 3_600_000 + 59 * 60_000); // 23:59 Asia/Shanghai
  await f.run(); assert.equal(f.usage.reservedCalls, 1);
  f.clock.advance(60_000); // 00:00 local, still 16:00 UTC
  f.setSnapshot({ seenSeq: 4, messages: [] });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.equal(f.root.socialAgents.bots[ctx.logicalId].runtimeUsage.days["2026-10-24"].reservedCalls, 1);
});

await check("partial unread snapshot / verified contiguous tool pages / bounded ACK", async () => {
  const message = seq => ({ seq, messageId: `msg-${seq}`, userId: "789", text: "fake page",
    sentAt: 1792728000000, receivedAt: 1792728000000 });
  const page = { messages: [message(4), message(5)], seenSeq: 5, state: { nextSeq: 999999 } };
  const f = fixture({ tools: { read_unread: async () => page }, model: (_, n) => n === 1
    ? { action: "tool", tool: { name: "read_unread", args: { limit: 2 } } }
    : { action: "reply", messages: ["page read"], throughSeq: 5,
      continuity: { experiences: [{ text: "fake", evidenceMessageIds: ["msg-5"] }] } } });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.equal(f.sends[0].intent.throughSeq, 5);
  assert.equal(f.modelCalls[1].snapshot.seenSeq, 5);
  assert.deepEqual(f.continuity[0].metadata.seenMessageIds, ["fake-message", "msg-4", "msg-5"]);
  for (const poison of [
    { ...page, conversationId: "group:456" }, { ...page, logicalId: "account:foreign" },
    { messages: [{ ...message(4), conversationId: "group:456" }], seenSeq: 4 },
    { messages: [message(5)], seenSeq: 5 }, { messages: [message(4)], seenSeq: 999999 },
    { messages: [], seenSeq: 999999 }, { messages: [message(4)], seenSeq: 4, foreignRoot: {} }
  ]) {
    const bad = fixture({ tools: { read_unread: async () => poison }, model: () => ({ action: "tool", tool: { name: "read_unread", args: {} } }) });
    assert.match(code(await bad.run()), /^SOCIAL_(INVALID_TOOL_RESULT|FOREIGN_TOOL_RESULT)$/);
    assert.equal(bad.sends.length, 0);
  }
  const ack = fixture({ tools: { read_unread: async () => page }, model: (_, n) => n === 1
    ? { action: "tool", tool: { name: "read_unread", args: {} } }
    : { action: "observe", throughSeq: 6 } });
  assert.equal(code(await ack.run()), "SOCIAL_INVALID_SEQUENCE"); assert.equal(ack.decisions.length, 0);
});

await check("real pure core + fake repository: page expansion / continuity / durable ACK", async () => {
  const f = fixture();
  await f.callbacks.transact(root => {
    for (let i = 1; i <= 40; i += 1) assert.equal(ingestSocialMessage(root, { ...ctx, now: f.clock.now(), message: {
      messageId: `core-${i}`, userId: "789", text: "fake core evidence", sentAt: f.clock.now(), receivedAt: f.clock.now()
    } }).ok, true);
  });
  let calls = 0, actualAck;
  const runtime = createSocialAgentRuntime({ ...f.callbacks,
    getSnapshot: scope => getSocialSnapshot(f.root, { ...scope, now: f.clock.now(), limit: 32 }),
    tools: { read_unread: async scope => getSocialSnapshot(f.root, { ...scope, now: f.clock.now(), limit: 40 }) },
    callModel: () => ++calls === 1 ? { action: "tool", tool: { name: "read_unread", args: { limit: 40 } } }
      : { action: "observe", throughSeq: 40, continuity: { mood: { engagement: 0.4 },
        experiences: [{ text: "fake core integration", evidenceMessageIds: ["core-40"] }] } },
    applyContinuity: (scope, proposal, metadata) => f.callbacks.transact(root => applySocialContinuity(root, {
      ...scope, userId: "789", proposal, evidenceMessageIds: metadata.seenMessageIds.slice(-32), now: metadata.now
    })),
    onDecision: (scope, decision) => f.callbacks.transact(root => {
      assert.equal(decision.seenSeq, 40);
      actualAck = markSocialRead(root, { ...scope, throughSeq: decision.throughSeq });
      assert.equal(actualAck.ok, true);
    })
  });
  runtime.observe(ctx); assert.equal(code(await runtime.runDue()), "SOCIAL_COMPLETED");
  const state = f.root.socialAgents.bots[ctx.logicalId].conversations[ctx.conversationId];
  assert.equal(state.readThroughSeq, 40); assert.equal(state.mood.engagement, 0.4);
  assert.equal(state.experiences[0].evidenceMessageIds[0], "core-40");
  assert.equal(f.sends.length, 0); assert.equal(state.runtime.lastProcessedSeq, 40);
});

await check("partial ACK remainder can progress / uncertain intents never replay", async () => {
  const f = fixture({ model: () => ({ action: "observe", throughSeq: 2 }) });
  f.setSnapshot({ seenSeq: 3, readThroughSeq: 0, messages: [{ seq: 3, messageId: "fake-message" }] });
  await f.run();
  f.setSnapshot({ seenSeq: 3, readThroughSeq: 2, messages: [{ seq: 3, messageId: "fake-message" }] });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.equal(f.modelCalls.length, 2);
  const failed = fixture({ send: () => { throw new Error("uncertain"); } });
  failed.setSnapshot({ seenSeq: 3, readThroughSeq: 0, messages: [{ seq: 3, messageId: "fake-message" }] });
  await failed.run();
  failed.setSnapshot({ seenSeq: 3, readThroughSeq: 2, messages: [{ seq: 3, messageId: "fake-message" }] });
  assert.equal(code(await failed.run()), "SOCIAL_ALREADY_PROCESSED"); assert.equal(failed.sends.length, 1);
  const scheduled = fixture({ model: () => ({ action: "wait", delayMs: 1000 }),
    tools: { schedule_followup: () => { throw new Error("uncertain schedule"); } } });
  assert.equal(code(await scheduled.run()), "SOCIAL_CALLBACK_FAILED"); scheduled.clock.advance(2000);
  const restart = createSocialAgentRuntime(scheduled.callbacks);
  restart.observe({ ...ctx, resumeDue: true });
  assert.equal(code(await restart.runDue()), "SOCIAL_ALREADY_PROCESSED"); assert.equal(scheduled.modelCalls.length, 1);
});

await check("new input and restart cannot replay an old uncertain wire range", async () => {
  let throughSeq = 1;
  const f = fixture({ model: () => ({ action: "reply", messages: ["fake final"], throughSeq }),
    send: () => { throw new Error("uncertain"); } });
  f.setSnapshot({ seenSeq: 1, readThroughSeq: 0, messages: [{ seq: 1, messageId: "m1" }] });
  assert.equal(code(await f.run()), "SOCIAL_CALLBACK_FAILED");
  assert.equal(f.state.intentFenceThroughSeq, 1);
  f.setSnapshot({ seenSeq: 2, readThroughSeq: 0, messages: [{ seq: 1, messageId: "m1" }, { seq: 2, messageId: "m2" }] });
  assert.equal(code(await f.run()), "SOCIAL_INTENT_ALREADY_CLAIMED"); assert.equal(f.sends.length, 1);
  const restarted = createSocialAgentRuntime(f.callbacks);
  restarted.observe(ctx); assert.equal(code(await restarted.runDue()), "SOCIAL_INTENT_ALREADY_CLAIMED");
  assert.equal(f.sends.length, 1);
  throughSeq = 2;
  restarted.observe(ctx); assert.equal(code(await restarted.runDue()), "SOCIAL_CALLBACK_FAILED");
  assert.deepEqual(f.sends.map(item => item.intent.throughSeq), [1, 2]);
  assert.equal(f.state.intentFenceThroughSeq, 2);
});

await check("wait/dive share tool budget including hot reductions before callback", async () => {
  for (const action of ["wait", "dive", "tool"]) {
    const decision = action === "tool" ? { action, tool: { name: "schedule_followup", args: { delayMs: 1000 } } }
      : { action, delayMs: 1000 };
    const f = fixture({ policy: { maxToolCalls: 0 }, model: () => decision });
    assert.equal(code(await f.run()), "SOCIAL_TOOL_LIMIT"); assert.equal(f.schedules.length, 0);
  }
  for (const maxToolCalls of [1, 2]) {
    const f = fixture({ policy: { maxToolCalls }, model: (_, n) => n === 1
      ? { action: "tool", tool: { name: "read_memory", args: {} } } : { action: "wait", delayMs: 1000 } });
    assert.equal(code(await f.run()), maxToolCalls === 1 ? "SOCIAL_TOOL_LIMIT" : "SOCIAL_WAITING");
    assert.equal(f.schedules.length, maxToolCalls === 1 ? 0 : 1);
  }
  const f = fixture({ policy: { maxToolCalls: 1 }, model: () => ({ action: "dive", delayMs: 1000 }) });
  f.afterCommit(root => {
    if (root.socialAgents?.bots?.[ctx.logicalId]?.conversations?.[ctx.conversationId]?.runtime?.status === "schedule_claimed") f.policy.maxToolCalls = 0;
  });
  assert.equal(code(await f.run()), "SOCIAL_TOOL_LIMIT"); assert.equal(f.schedules.length, 0);
});

await check("read_unread cursor supports >100 total contiguous messages without skips", async () => {
  const time = Date.UTC(2026, 9, 23, 4);
  const messages = Array.from({ length: 232 }, (_, i) => ({ seq: i + 1, messageId: `page-${i + 1}`,
    userId: "789", text: "fake bounded page", sentAt: time, receivedAt: time }));
  const cursors = [];
  const f = fixture({ tools: { read_unread: async (scope, args) => {
    assert.deepEqual(scope, ctx);
    cursors.push(args.afterSeq);
    const page = messages.filter(item => item.seq > args.afterSeq).slice(0, args.limit);
    return { messages: page, seenSeq: page.at(-1)?.seq ?? args.afterSeq, state: { nextSeq: 999999 } };
  } }, model: ({ snapshot, tools }, n) => {
    assert.ok(tools.find(item => item.name === "read_unread").argumentKeys.includes("afterSeq"));
    if (n < 3) return { action: "tool", tool: { name: "read_unread", args: { limit: 100, afterSeq: snapshot.seenSeq } } };
    assert.equal(snapshot.seenSeq, 232);
    return { action: "reply", messages: ["fake final"], throughSeq: 232 };
  } });
  f.setSnapshot({ messages: messages.slice(0, 32), seenSeq: 32, readThroughSeq: 0 });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED"); assert.deepEqual(cursors, [32, 132]);
  assert.equal(f.modelCalls.length, 3); assert.equal(f.sends[0].intent.seenSeq, 232);
  assert.equal(f.sends[0].intent.throughSeq, 232);
  const gap = fixture({ model: () => ({ action: "tool", tool: { name: "read_unread", args: { afterSeq: 32, limit: 100 } } }),
    tools: { read_unread: async () => ({ messages: messages.slice(33, 133), seenSeq: 133 }) } });
  gap.setSnapshot({ messages: messages.slice(0, 32), seenSeq: 32, readThroughSeq: 0 });
  assert.equal(code(await gap.run()), "SOCIAL_INVALID_TOOL_RESULT"); assert.equal(gap.sends.length, 0);
});

await check("read_unread rejects future/invalid cursors and foreign argument fields", async () => {
  for (const afterSeq of [4, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture({ model: () => ({ action: "tool", tool: { name: "read_unread", args: { afterSeq } } }) });
    assert.equal(code(await f.run()), "SOCIAL_INVALID_TOOL"); assert.equal(f.toolCalls.length, 0);
  }
  for (const field of ["conversationId", "logicalId", "userId", "accountId"]) {
    const f = fixture({ model: () => ({ action: "tool", tool: { name: "read_unread", args: { afterSeq: 3, [field]: "foreign" } } }) });
    assert.equal(code(await f.run()), "SOCIAL_INVALID_TOOL"); assert.equal(f.toolCalls.length, 0);
  }
  const zero = fixture({ model: (_, n) => n === 1 ? { action: "tool", tool: { name: "read_unread", args: { afterSeq: 0 } } }
    : { action: "observe" } });
  assert.equal(code(await zero.run()), "SOCIAL_COMPLETED"); assert.equal(zero.toolCalls[0].args.afterSeq, 0);
});

await check("schedule recipient is a format-only request forwarded to bridge metadata", async () => {
  for (const userId of [undefined, "789", "12345678901234567890"]) {
    const args = { delayMs: 5000, ...(userId === undefined ? {} : { userId }) };
    const f = fixture({ model: ({ tools }) => {
      assert.ok(tools.find(item => item.name === "schedule_followup").argumentKeys.includes("userId"));
      return { action: "tool", tool: { name: "schedule_followup", args } };
    } });
    assert.equal(code(await f.run()), "SOCIAL_WAITING"); assert.equal(f.schedules.length, 1);
    assert.deepEqual(f.schedules[0].scope, ctx); assert.deepEqual(f.schedules[0].args, args);
    assert.equal(f.schedules[0].metadata.userId, userId);
    if (userId === undefined) assert.equal(Object.hasOwn(f.schedules[0].metadata, "userId"), false);
    assert.equal(f.schedules[0].metadata.action, "wait"); assert.equal(f.sends.length, 0);
  }
});

await check("schedule rejects malformed recipient IDs and arbitrary scope fields", async () => {
  for (const userId of [789, null, "", "0", "0123", "-1", "private:789", "1e3", "789 ", "123456789012345678901"]) {
    const f = fixture({ model: () => ({ action: "tool", tool: { name: "schedule_followup", args: { delayMs: 5000, userId } } }) });
    assert.equal(code(await f.run()), "SOCIAL_INVALID_TOOL"); assert.equal(f.schedules.length, 0); assert.equal(f.sends.length, 0);
  }
  for (const field of ["conversationId", "logicalId", "accountId", "authorized", "consent"]) {
    const f = fixture({ model: () => ({ action: "tool", tool: { name: "schedule_followup", args: { delayMs: 5000, userId: "789", [field]: "foreign" } } }) });
    assert.equal(code(await f.run()), "SOCIAL_INVALID_TOOL"); assert.equal(f.schedules.length, 0);
  }
});

await check("model-only transport unavailable preserves safe code but never exception content", async () => {
  const f = fixture({ model: () => { throw Object.assign(new Error("private adapter details must not escape"),
    { code: "SOCIAL_MODEL_ONLY_UNAVAILABLE" }); } });
  const result = await f.run();
  assert.equal(code(result), "SOCIAL_MODEL_ONLY_UNAVAILABLE");
  assert.deepEqual(result, [{ code: "SOCIAL_MODEL_ONLY_UNAVAILABLE" }]);
  assert.equal(f.sends.length, 0); assert.equal(f.usage.unknownUsageCalls, 1);
  assert.ok(!JSON.stringify([result, f.root, f.runtime.status()]).includes("private adapter details"));
});

await check("background reflection updates continuity but never sends or schedules", async () => {
  const f = fixture({ model: () => ({ action: "reply", messages: ["must not send"],
    continuity: { mood: { valence: 0.2 } } }) });
  assert.equal(code(await f.run({ ...ctx, reflectOnly: true })), "SOCIAL_COMPLETED");
  assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
  assert.equal(f.continuity.length, 1);
  const search = fixture({ model: () => ({ action: "tool", tool: { name: "web_search", args: { query: "must not export" } } }) });
  assert.equal(code(await search.run({ ...ctx, reflectOnly: true })), "SOCIAL_INVALID_TOOL");
  assert.equal(search.toolCalls.length, 0);
});

await check("persona changes are pinned proposals, never arbitrary settings", async () => {
  const f = fixture({ model: () => ({ action: "observe", continuity: { personaChanges: [
    { field: "expression", value: "虚构的表达候选", evidenceMessageIds: ["fake-message"] }
  ] } }) });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.equal(f.continuity[0].proposal.personaChanges[0].field, "expression");
  assert.equal(f.sends.length, 0);
  for (const item of [
    { field: "permissions", value: "all", evidenceMessageIds: ["fake-message"] },
    { field: "identity", value: "fake", evidenceMessageIds: ["foreign-message"] }
  ]) {
    const invalid = fixture({ model: () => ({ action: "observe", continuity: { personaChanges: [item] } }) });
    assert.equal(code(await invalid.run()), "SOCIAL_INVALID_CONTINUITY");
    assert.equal(invalid.continuity.length, 0);
  }
});

const expression = (patch = {}) => ({ version: 1, action: "reply", messages: [
  { type: "sticker", stickerId: "approved_A", fallbackText: "准备失败备用文字" }
], replyToMessageId: null, ...patch });
const expressionOptions = () => ({ allowedStickerIds: ["approved_A"], allowedQuoteIds: ["fake-message"], maxMessages: 2, maxTextLength: 2000 });
const expressionDecision = (patch = {}) => ({ action: "reply", messages: ["[表情]"], throughSeq: 3, ...patch });
const attachExpression = (decision = expressionDecision(), plan = expression(), options = expressionOptions()) => withSocialExpressionPlan(decision, plan, options);

await check("host expression metadata adds only optional sendIntent field, legacy shape unchanged", async () => {
  const raw = expressionDecision(), before = structuredClone(raw);
  assert.equal(attachExpression(raw), raw);
  assert.deepEqual(raw, before); assert.equal(Object.hasOwn(raw, "expressionPlan"), false);
  const f = fixture({ model: () => raw });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  const { scope, intent } = f.sends[0];
  assert.deepEqual(scope, ctx); assert.deepEqual(intent.expressionPlan, expression());
  assert.deepEqual(intent.messages, ["[表情]"]); // Host chooses metadata plan, not this legacy proxy.
  assert.equal(intent.throughSeq, 3); assert.equal(intent.seenSeq, 3);
  assert.deepEqual(Object.keys(intent).sort(), ["expressionPlan", "materialIds", "messages", "seenSeq", "signal", "throughSeq"]);
  assert.ok(!JSON.stringify([f.root, f.runtime.status()]).includes("approved_A"));
  const legacy = fixture(); await legacy.run();
  assert.deepEqual(Object.keys(legacy.sends[0].intent).sort(), ["materialIds", "messages", "seenSeq", "signal", "throughSeq"]);
  assert.deepEqual(legacy.sends[0].intent.messages, ["fake final"]);
});

await check("JSON cannot forge expression metadata and model private fields stay invalid", async () => {
  for (const raw of [
    { ...expressionDecision(), expressionPlan: expression() },
    { ...expressionDecision(), expression_plan: expression() },
    { ...expressionDecision(), messages: [{ type: "sticker", stickerId: "approved_A" }] },
    { ...expressionDecision(), allowedStickerIds: ["approved_A"] }
  ]) {
    const f = fixture({ model: () => JSON.parse(JSON.stringify(raw)) });
    assert.equal(code(await f.run()), "SOCIAL_INVALID_DECISION"); assert.equal(f.sends.length, 0);
  }
  const attached = attachExpression(expressionDecision({ messages: ["legacy text"] }));
  const cloned = JSON.parse(JSON.stringify(attached));
  const f = fixture({ model: () => cloned }); await f.run();
  assert.equal(Object.hasOwn(f.sends[0].intent, "expressionPlan"), false);
  assert.deepEqual(f.sends[0].intent.messages, ["legacy text"]);
});

await check("host metadata validator enforces offered sticker IDs, quotes and quotas", () => {
  for (const options of [undefined, { allowedStickerIds: [] }, { allowedStickerIds: ["foreign_B"] },
    { ...expressionOptions(), allowedStickerIds: ["a", "b", "c", "d"] },
    { ...expressionOptions(), maxMessages: 0 }, { ...expressionOptions(), maxTextLength: 1 }]) {
    assert.throws(() => withSocialExpressionPlan(expressionDecision(), expression(), options), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
  }
  assert.throws(() => attachExpression(expressionDecision(), expression({ replyToMessageId: "foreign-message" })), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
  assert.equal(attachExpression(expressionDecision(), expression({ replyToMessageId: "fake-message" })).action, "reply");
  const two = expression({ messages: [{ type: "text", content: "先说一句" }, ...expression().messages] });
  assert.throws(() => attachExpression(expressionDecision(), two, { ...expressionOptions(), maxMessages: 1 }), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
});

await check("host metadata rejects target/path/identity authority and nonreply actions", () => {
  for (const field of ["target", "path", "accountId", "logicalId", "conversationId", "tools", "expressionPlan"]) {
    assert.throws(() => attachExpression(expressionDecision(), expression({ [field]: "foreign" })), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
    assert.throws(() => attachExpression(expressionDecision(), expression({ messages: [{ ...expression().messages[0], [field]: "foreign" }] })), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
  }
  for (const action of ["observe", "wait", "dive", "tool"]) {
    assert.throws(() => attachExpression({ action }, expression()), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
    assert.throws(() => attachExpression(expressionDecision(), expression({ action, messages: [] })), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
  }
  for (const raw of [null, [], "raw string"]) assert.throws(() => attachExpression(raw), { code: "SOCIAL_INVALID_EXPRESSION_PLAN" });
});

await check("WeakMap attachment cannot bypass strict decision validation", async () => {
  const raw = attachExpression(); raw.expressionPlan = expression();
  const f = fixture({ model: () => raw });
  assert.equal(code(await f.run()), "SOCIAL_INVALID_DECISION"); assert.equal(f.sends.length, 0);
  // Rejected uses consume the host attachment too; removing the illegal JSON
  // field later does not resurrect an old attached plan on a new execution.
  delete raw.expressionPlan;
  const next = fixture({ model: () => raw }); await next.run();
  assert.equal(Object.hasOwn(next.sends[0].intent, "expressionPlan"), false);
});

await check("attached plan is detached from source, options and delayed caller mutation", async () => {
  const plan = expression({ replyToMessageId: "fake-message" }), expected = structuredClone(plan), options = expressionOptions();
  const raw = attachExpression(expressionDecision(), plan, options);
  plan.messages[0].stickerId = "foreign"; plan.messages[0].fallbackText = "changed"; plan.replyToMessageId = "foreign";
  options.allowedStickerIds[0] = "foreign"; options.allowedQuoteIds.length = 0;
  const f = fixture({ model: () => raw });
  f.afterCommit(() => {
    if (f.usage?.actualCalls === 1) {
      raw.messages[0] = "caller changed proxy";
      attachExpression(raw, expression({ messages: [{ type: "text", content: "replacement" }] }));
    }
  });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.deepEqual(f.sends[0].intent.expressionPlan, expected);
  assert.deepEqual(f.sends[0].intent.messages, ["[表情]"]);
});

await check("host usage and expression metadata compose in either order", async () => {
  for (const usageFirst of [true, false]) {
    let raw = expressionDecision();
    if (usageFirst) raw = withSocialAgentUsage(raw, { inputTokens: 7, outputTokens: 3 });
    raw = attachExpression(raw);
    if (!usageFirst) raw = withSocialAgentUsage(raw, { inputTokens: 7, outputTokens: 3 });
    const f = fixture({ model: () => raw }); await f.run();
    assert.deepEqual(f.sends[0].intent.expressionPlan, expression());
    assert.equal(f.usage.inputTokens, 7); assert.equal(f.usage.outputTokens, 3); assert.equal(f.usage.unknownUsageCalls, 0);
  }
});

await check("shadow and reflection still suppress expression sends", async () => {
  const shadow = fixture({ policy: { shadowMode: true }, model: () => attachExpression() });
  assert.equal(code(await shadow.run()), "SOCIAL_SHADOWED"); assert.equal(shadow.sends.length, 0); assert.equal(shadow.schedules.length, 0);
  const reflected = fixture({ model: () => attachExpression() });
  assert.equal(code(await reflected.run({ ...ctx, reflectOnly: true })), "SOCIAL_COMPLETED");
  assert.equal(reflected.sends.length, 0); assert.equal(reflected.schedules.length, 0);
});

await check("quiet/route change and cancellation after expression claim block wire", async () => {
  for (const mode of ["quiet", "cancel", "disable", "shadow"]) {
    const f = fixture({ model: () => attachExpression() });
    f.afterCommit(root => {
      if (root.socialAgents?.bots?.[ctx.logicalId]?.conversations?.[ctx.conversationId]?.runtime?.status !== "intent_claimed") return;
      if (mode === "quiet") f.setCurrent(false);
      if (mode === "cancel") f.runtime.cancel(ctx.logicalId);
      if (mode === "disable") f.policy.enabled = false;
      if (mode === "shadow") f.policy.shadowMode = true;
    });
    assert.equal(code(await f.run()), { quiet: "SOCIAL_STALE", cancel: "SOCIAL_CANCELLED", disable: "SOCIAL_DISABLED", shadow: "SOCIAL_SHADOWED" }[mode]);
    assert.equal(f.sends.length, 0);
  }
});

await check("expression sender retains observed sequence and durable no-replay fence", async () => {
  const f = fixture({ model: () => attachExpression(expressionDecision({ throughSeq: 2 })), send: (_scope, intent) => {
    assert.equal(f.state.status, "intent_claimed"); assert.equal(f.state.intentFenceThroughSeq, 2);
    assert.equal(intent.seenSeq, 3); assert.equal(intent.throughSeq, 2); assert.deepEqual(intent.expressionPlan, expression());
    throw new Error("unknown send outcome");
  } });
  assert.equal(code(await f.run()), "SOCIAL_CALLBACK_FAILED"); assert.equal(f.sends.length, 1);
  const restarted = createSocialAgentRuntime(f.callbacks);
  restarted.observe({ ...ctx, resumeDue: true }); await restarted.runDue(); assert.equal(f.sends.length, 1);
  const future = fixture({ model: () => attachExpression(expressionDecision({ throughSeq: 4 })) });
  assert.equal(code(await future.run()), "SOCIAL_INVALID_SEQUENCE"); assert.equal(future.sends.length, 0);
});

await check("post-attachment decision action mutation cannot send or schedule metadata", async () => {
  const raw = attachExpression(); raw.action = "observe"; delete raw.messages;
  const f = fixture({ model: () => raw });
  assert.equal(code(await f.run()), "SOCIAL_INVALID_EXPRESSION_PLAN"); assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
});

await check("plain text host expression plan also preserves old decision schema", async () => {
  const textPlan = expression({ messages: [{ type: "text", content: "宿主已校验正文" }] });
  const f = fixture({ model: () => attachExpression(expressionDecision({ messages: ["旧字段保持字符串"] }), textPlan, {}) });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.deepEqual(f.sends[0].intent.messages, ["旧字段保持字符串"]);
  assert.deepEqual(f.sends[0].intent.expressionPlan, textPlan);
});

await check("expression intent after unread paging keeps actual observed sequence", async () => {
  const f = fixture({ tools: { read_unread: async () => ({ messages: [
    { seq: 4, messageId: "message4", userId: "789", text: "fourth input", sentAt: 1, receivedAt: 1 }
  ], seenSeq: 4 }) }, model: (_, n) => n === 1
    ? { action: "tool", tool: { name: "read_unread", args: { afterSeq: 3 } } }
    : attachExpression(expressionDecision({ throughSeq: 4 }), expression({ replyToMessageId: "message4" }),
      { ...expressionOptions(), allowedQuoteIds: ["message4"] }) });
  assert.equal(code(await f.run()), "SOCIAL_COMPLETED");
  assert.equal(f.modelCalls.length, 2); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].intent.seenSeq, 4); assert.equal(f.sends[0].intent.throughSeq, 4);
  assert.equal(f.sends[0].intent.expressionPlan.replyToMessageId, "message4");
  assert.equal(f.state.intentFenceThroughSeq, 4);
});

console.log(`social-agent-runtime: ${checks} checks passed (fake state/model/clock only)`);
