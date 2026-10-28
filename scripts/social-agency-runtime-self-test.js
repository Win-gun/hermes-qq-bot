import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSocialAgentRuntime } from "../src/social-agent-runtime.js";
import { abandonAgencyAttention, agencySnapshot, applyAgencyObservations, claimAgencyIntent, isAgencyStop, validateAgencyProposal } from "../src/social-agency.js";
import { ingestSocialMessage } from "../src/social-agent-state.js";
import { proposeSocialIntent, selectRelevantSocialIntents } from "../src/social-intent-journal.js";

// Runtime contract tests only. ALL callbacks, receipts, publication and timers
// are isolated fakes. Review regressions read ONLY bridge source and execute
// extracted callback bodies with VM fakes; NEVER import/start the bridge or read
// runtime files/config. No actual models, QQ, network, disk writes or real timers.
// The agency marker below measures callback writes; it is NOT a real journal,
// evidence receipt, permission, or claim that semantic expression was verified.
// Regressions remain failing assertions, collected so one failure cannot hide
// the remaining safety checks. No runtime/source patches or expected-bug passes.
const CTX = Object.freeze({ logicalId: "account:agency-test", conversationId: "group:100" });
const NOW = Date.UTC(2026, 9, 28, 4);
const NATIVE = `poke_notice:${"a".repeat(64)}`;
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function until(predicate) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail("fake callback checkpoint was not reached");
}
const proposal = () => ({
  preferences: [{ kind: "group", dimension: "interest", value: "太空探索", evidenceMessageIds: ["human-a"] }],
  intents: [{ kind: "opinion", summary: "太空探索值得关注的新方向", reason: "延续当前公开话题",
    trigger: { kind: "related_message", terms: ["太空探索"] }, evidenceMessageIds: ["human-b"], ttlMs: 60_000 }],
});
const reply = (agency = { ...proposal(), useIntentIds: ["intent:offered-fixture"] }) =>
  ({ action: "reply", messages: ["仅用于隔离测试的公开话题回复"], throughSeq: 4, ...(agency === undefined ? {} : { agency }) });
const terminal = (action, agency = proposal()) => ({ action, throughSeq: 4, agency,
  ...(["wait", "dive"].includes(action) ? { delayMs: 1000 } : {}) });
const state = root => root.socialAgents.bots[CTX.logicalId].conversations[CTX.conversationId].runtime;
const marker = root => root.socialAgents.bots[CTX.logicalId].testAgency;

function fixture(options = {}) {
  let root = clone(options.root ?? { unrelated: { keep: true }, socialAgents: { version: 1, bots: {
    [CTX.logicalId]: { conversations: { [CTX.conversationId]: { runtime: options.native ? { nativeWakeId: NATIVE } : {} } },
      testAgency: { writes: 0, prepare: 0, complete: 0 } },
  } } });
  let now = NOW, timerId = 0, tail = Promise.resolve();
  const timers = new Map();
  const f = { order: [], agencies: [], sends: [], schedules: [], toolCalls: [], models: [], decisions: [],
    continuity: [], interest: [], current: true, afterCommit: undefined, lastReceipt: undefined };
  const policy = { enabled: true, shadowMode: false, conversationIds: [CTX.conversationId],
    maxDailyCalls: 100, maxToolCalls: 8, turnTimeoutMs: 60_000, ...options.policy };
  const snapshot = { seenSeq: 4, readThroughSeq: 0, messages: [
    { seq: 1, messageId: "human-a", userId: "701", text: "隔离的人类输入甲", isQuoted: false, isBot: false },
    { seq: 2, messageId: "quote-a", userId: "702", text: "隔离的引用", isQuoted: true, isBot: false },
    { seq: 3, messageId: "bot-a", userId: "703", text: "隔离的机器人输入", isQuoted: false, isBot: true },
    { seq: 4, messageId: "human-b", userId: "704", text: "隔离的人类输入乙", isQuoted: false, isBot: false },
  ] };
  const clock = { now: () => now,
    setTimeout(fn, delayMs) { const id = ++timerId; timers.set(id, { fn, dueAt: now + delayMs }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, t] of timers) if (t.dueAt <= now) { timers.delete(id); t.fn(); } },
  };
  const transact = build => {
    assert.notEqual(build.constructor.name, "AsyncFunction", "repository builders must be synchronous");
    const work = tail.then(async () => {
      const draft = clone(root), result = build(draft);
      assert.ok(!result || typeof result.then !== "function", "no async draft builder");
      JSON.stringify(draft);
      root = clone(draft);
      await f.afterCommit?.(root);
      return result;
    });
    tail = work.catch(() => {});
    return work;
  };
  const tools = Object.fromEntries(["read_unread", "read_detail", "read_history", "read_memory", "web_search"]
    .map(name => [name, async (scope, args, meta) => {
      f.toolCalls.push({ name, scope, args, meta }); f.order.push(`tool:${name}`);
      return name === "read_unread" ? { messages: [], seenSeq: 4 } : { items: [] };
    }]));
  tools.schedule_followup = async (scope, args, meta) => {
    f.schedules.push({ scope, args, meta }); f.order.push(`schedule:${meta.action}`);
    return { scheduled: true };
  };
  const callbacks = { clock, getPolicy: () => policy, getSnapshot: () => snapshot, transact,
    isCurrent: scope => f.current && scope.logicalId === CTX.logicalId && scope.conversationId === CTX.conversationId,
    callModel: async input => {
      f.models.push(input); f.order.push("model");
      return options.model ? options.model(f, input) : clone(options.decision ?? reply());
    }, tools,
    sendIntent: async (scope, intent) => {
      assert.deepEqual(scope, CTX); assert.ok(Object.isFrozen(scope)); assert.equal(intent.signal.aborted, false);
      f.sends.push({ scope, intent }); f.order.push("send");
      f.lastReceipt = options.send ? await options.send(f, scope, intent)
        : { ok: true, confirmed: true, status: "sent", messageId: "confirmed-fake-reply" };
      return f.lastReceipt;
    },
    onDecision: async (scope, decision) => { f.decisions.push({ scope, decision }); f.order.push(`decision:${decision.action}`); },
    applyContinuity: async (...args) => { f.continuity.push(args); return { ok: true }; },
    applyInterest: async (...args) => { f.interest.push(args); return { ok: true }; },
    ...(options.noAgencyCallback ? {} : { applyAgency: async (scope, value, meta) => {
      assert.deepEqual(scope, CTX); assert.ok(Object.isFrozen(scope)); assert.equal(meta.signal.aborted, false);
      f.agencies.push({ scope, proposal: clone(value), meta }); f.order.push(`agency:${meta.stage}`);
      const result = options.apply ? await options.apply(f, scope, value, meta) : { ok: true };
      if (result?.ok === false) return result;
      if (meta.signal.aborted) throw new Error("FAKE_ABORTED_ADAPTER");
      await transact(draft => { marker(draft).writes++; marker(draft)[meta.stage]++; });
      return result;
    } }),
  };
  Object.assign(f, { callbacks, policy, snapshot, clock,
    getState: () => clone(state(root)), getMarker: () => clone(marker(root)), getRoot: () => clone(root),
    stages: () => f.agencies.map(a => a.meta.stage), timerCount: () => timers.size,
    restart: () => createSocialAgentRuntime(callbacks),
  });
  f.runtime = createSocialAgentRuntime(callbacks);
  f.run = async (extra = {}, runtime = f.runtime) => {
    assert.equal(runtime.observe({ ...CTX, ...extra }).queued, true);
    const results = await runtime.runDue();
    assert.equal(results.length, 1); assert.equal(timers.size, 0, "all fake deadline timers cleared");
    return results[0].code;
  };
  return f;
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, finding: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
function assertMetadata(f, action, stages) {
  assert.deepEqual(f.stages(), stages);
  for (const call of f.agencies) {
    assert.deepEqual(call.meta.seenMessageIds, ["human-a", "human-b"], "quoted/bot messages excluded from evidence IDs");
    assert.equal(call.meta.seenSeq, 4); assert.equal(call.meta.now, f.clock.now());
    assert.equal(call.meta.action, action); assert.equal(call.meta.signal.aborted, false);
  }
}
async function assertNoReplay(f, expectedSends = 0, { allowStale = false } = {}) {
  const before = { sends: f.sends.length, agencies: f.agencies.length, models: f.models.length,
    marker: f.getMarker(), schedules: f.schedules.length, tools: f.toolCalls.length };
  const safeCodes = allowStale ? ["SOCIAL_ALREADY_PROCESSED", "SOCIAL_STALE"] : ["SOCIAL_ALREADY_PROCESSED"];
  const assertFence = () => {
    assert.ok(f.getState().intentFenceThroughSeq >= 4, "durable input fence must survive rejection/restart");
    assert.ok(f.getState().lastProcessedSeq >= 4, "durable processed watermark must not roll back");
    assert.equal(f.sends.length, before.sends); assert.equal(f.agencies.length, before.agencies);
    assert.equal(f.models.length, before.models); assert.deepEqual(f.getMarker(), before.marker);
    assert.equal(f.schedules.length, before.schedules); assert.equal(f.toolCalls.length, before.tools);
  };
  assert.equal(before.sends, expectedSends);
  assertFence();
  for (const extra of [{}, { resumeDue: true }]) {
    // The claim-publication hook can independently invalidate this new attempt
    // again. Both stale rejection and the processed fence are safe; neither may
    // dispatch another model/callback/send or remove the persisted claim.
    if (allowStale) f.current = true;
    const result = await f.run(extra);
    assert.ok(safeCodes.includes(result), `unsafe replay result: ${result}`);
    assertFence();
  }
  const restart = f.restart();
  assert.deepEqual(await restart.runDue(), [], "restart does not enumerate/replay persisted claims");
  if (allowStale) f.current = true;
  const result = await f.run({}, restart);
  assert.ok(safeCodes.includes(result), `unsafe restarted replay result: ${result}`);
  assertFence();
}

await check("agency optional: legacy reply and observe work without callback", async () => {
  for (const decision of [{ action: "reply", messages: ["legacy fake"], throughSeq: 4 }, { action: "observe", throughSeq: 4 }]) {
    const f = fixture({ decision, noAgencyCallback: true });
    assert.equal(await f.run(), "SOCIAL_COMPLETED"); assert.equal(f.sends.length, decision.action === "reply" ? 1 : 0);
    assert.deepEqual(f.stages(), []); assert.equal(f.getMarker().writes, 0);
  }
});

for (const action of ["reply", "observe", "wait", "dive"]) {
  await check(`shadow ${action}: no agency writes, send or schedule`, async () => {
    for (const shadowMode of [true, undefined]) {
      const f = fixture({ policy: { shadowMode }, decision: action === "reply" ? reply() : terminal(action) });
      const before = f.getMarker(), code = await f.run();
      assert.equal(code, action === "observe" ? "SOCIAL_COMPLETED" : "SOCIAL_SHADOWED");
      assert.deepEqual(f.getMarker(), before); assert.deepEqual(f.stages(), []);
      assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
      assert.deepEqual(f.getRoot().unrelated, { keep: true });
    }
  });
}

for (const action of ["reply", "observe"]) {
  await check(`native ${action}: rejects agency before all side effects`, async () => {
    const decision = action === "reply" ? { action, messages: ["native fake"], agency: proposal() } : { action, agency: proposal() };
    const f = fixture({ native: true, decision });
    assert.equal(await f.run({ nativeWakeId: NATIVE }), "SOCIAL_INVALID_DECISION");
    assert.deepEqual(f.stages(), []); assert.equal(f.sends.length, 0); assert.equal(f.getMarker().writes, 0);
    assert.equal(f.toolCalls.length, 0); assert.equal(f.schedules.length, 0);
    assert.equal(await f.run({ nativeWakeId: NATIVE }), "SOCIAL_ALREADY_PROCESSED");
  });
}

for (const action of ["reply", "observe", "wait", "dive"]) {
  await check(`reflect ${action}: rejects agency without writes/send/schedule`, async () => {
    const f = fixture({ decision: action === "reply" ? reply() : terminal(action) });
    assert.equal(await f.run({ reflectOnly: true }), "SOCIAL_INVALID_DECISION");
    assert.deepEqual(f.stages(), []); assert.equal(f.getMarker().writes, 0);
    assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
  });
}

for (const [name, args] of [["read_memory", {}], ["web_search", { query: "synthetic public topic" }], ["schedule_followup", { delayMs: 1000 }]]) {
  await check(`tool ${name}: rejects agency before invoking tool`, async () => {
    const f = fixture({ decision: { action: "tool", tool: { name, args }, agency: proposal() } });
    assert.equal(await f.run(), "SOCIAL_INVALID_DECISION"); assert.deepEqual(f.stages(), []);
    assert.equal(f.toolCalls.length, 0); assert.equal(f.schedules.length, 0); assert.equal(f.sends.length, 0);
  });
}

await check("observe: complete metadata once, no prepare/send/schedule", async () => {
  const input = terminal("observe"), before = clone(input), f = fixture({ decision: input });
  assert.equal(await f.run(), "SOCIAL_COMPLETED"); assertMetadata(f, "observe", ["complete"]);
  assert.deepEqual(f.agencies[0].proposal, input.agency); assert.deepEqual(input, before);
  assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0); assert.equal(f.getMarker().writes, 1);
  assert.deepEqual(f.order, ["model", "agency:complete", "decision:observe"]);
});

await check("reply: prepare -> exactly one existing send -> complete, detached metadata", async () => {
  const input = reply(), before = clone(input);
  const f = fixture({ model: () => input, apply: (_, __, value, meta) => {
    if (meta.stage === "prepare") value.preferences[0].value = "仅修改回调副本";
    return { ok: true };
  } });
  assert.equal(await f.run(), "SOCIAL_COMPLETED"); assertMetadata(f, "reply", ["prepare", "complete"]);
  assert.deepEqual(f.order, ["model", "agency:prepare", "send", "agency:complete"]);
  assert.deepEqual(input, before); assert.deepEqual(f.agencies[1].proposal, input.agency);
  assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0].intent.messages, input.messages);
  assert.equal(f.sends[0].intent.agency, undefined, "agency metadata is not an additional wire message/tool");
  assert.equal(f.getMarker().prepare, 1); assert.equal(f.getMarker().complete, 1);
  await assertNoReplay(f, 1);
});

for (const action of ["wait", "dive"]) {
  await check(`${action}: forwards agency to terminal once; does not self-wake`, async () => {
    const f = fixture({ decision: terminal(action) });
    assert.equal(await f.run(), "SOCIAL_COMPLETED"); assertMetadata(f, "observe", ["complete"]);
    assert.deepEqual(f.order, ["model", "agency:complete", "decision:observe"]);
    assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
    assert.deepEqual(f.agencies[0].proposal, proposal());
    f.clock.advance(2000); assert.deepEqual(await f.runtime.runDue(), []);
    assert.equal(f.models.length, 1); assert.equal(f.agencies.length, 1);
    const restarted = f.restart(); assert.deepEqual(await restarted.runDue(), []);
    assert.equal(await f.run({}, restarted), "SOCIAL_ALREADY_PROCESSED");
    assert.equal(f.schedules.length, 0); assert.equal(f.agencies.length, 1);
  });
}

for (const failure of ["refused", "throw"]) {
  await check(`prepare ${failure}: no send/complete/retry including restart`, async () => {
    const f = fixture({ apply: (_, __, ___, meta) => {
      assert.equal(meta.stage, "prepare");
      if (failure === "throw") throw new Error("FAKE_PREPARE_FAILED");
      return { ok: false };
    } });
    assert.equal(await f.run(), failure === "throw" ? "SOCIAL_CALLBACK_FAILED" : "SOCIAL_INVALID_DECISION");
    assert.deepEqual(f.stages(), ["prepare"]); assert.equal(f.getMarker().writes, 0);
    assert.equal(f.sends.length, 0); await assertNoReplay(f);
  });
}

await check("reply agency requires host callback before send", async () => {
  const f = fixture({ noAgencyCallback: true });
  assert.equal(await f.run(), "SOCIAL_INVALID_DECISION"); assert.equal(f.sends.length, 0);
  await assertNoReplay(f);
});

await check("sender rejects uncertain ACK: no complete or retry", async () => {
  const f = fixture({ send: () => { throw Object.assign(new Error("FAKE_ACK_UNCERTAIN"), { code: "FAKE_ACK_UNCERTAIN" }); } });
  assert.equal(await f.run(), "SOCIAL_CALLBACK_FAILED"); assert.deepEqual(f.stages(), ["prepare"]);
  assert.equal(f.getMarker().complete, 0); await assertNoReplay(f, 1);
});

for (const [label, receipt] of [
  ["ok:false", { ok: false, code: "FAKE_ACK_UNCERTAIN" }],
  ["status:uncertain", { status: "uncertain", confirmed: false }],
  ["contradictory confirmed", { ok: true, confirmed: true, uncertain: true, messageId: "fake-uncertain" }],
]) {
  await check(`REGRESSION resolved ${label}: uncertain ACK must not enter complete`, async () => {
    const f = fixture({ send: () => clone(receipt) });
    const result = await f.run();
    // Check the non-replay fence even if the following safety assertion fails.
    await assertNoReplay(f, 1);
    assert.deepEqual(f.stages(), ["prepare"], `resolved uncertain ACK invoked complete (${result}); sendIntent result must be rejected or host contract must require throwing`);
    assert.equal(f.getMarker().complete, 0);
  });
}

for (const action of ["observe", "wait", "dive"]) {
  await check(`useIntentIds rejected on ${action}`, async () => {
    const f = fixture({ decision: { ...terminal(action), agency: { useIntentIds: ["intent:offered-fixture"] } } });
    assert.equal(await f.run(), "SOCIAL_INVALID_DECISION"); assert.deepEqual(f.stages(), []);
    assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0);
  });
}

await check("negative agency schema: unknown fields/types/limits rejected before callbacks", async () => {
  const invalid = [null, [], "agency", { enabled: true }, { logicalId: "account:other" }, { confidence: 1 }, { authority: "send" },
    { preferences: {} }, { preferences: Array(7).fill(proposal().preferences[0]) },
    { preferences: [{ ...proposal().preferences[0], dimension: "persona" }] },
    { preferences: [{ ...proposal().preferences[0], kind: "global" }] },
    { preferences: [{ ...proposal().preferences[0], value: "x".repeat(81) }] },
    { preferences: [{ ...proposal().preferences[0], evidenceMessageIds: [] }] },
    { preferences: [{ ...proposal().preferences[0], actor: "admin" }] },
    { intents: Array(3).fill(proposal().intents[0]) },
    ...[{ ttlMs: 0 }, { ttlMs: 86_400_001 }, { ttlMs: "1000" }, { summary: "" }, { summary: "x".repeat(301) },
      { reason: "x".repeat(161) }, { kind: "send" }, { trigger: { kind: "timer", terms: ["space"] } },
      { trigger: { kind: "related_message", terms: [] } }, { scope: "all" }].map(p => ({ intents: [{ ...proposal().intents[0], ...p }] })),
    { useIntentIds: [] }, { useIntentIds: "intent:x" }, { useIntentIds: [12] }, { abandonIntentIds: Array(9).fill("intent:x") },
    { publicDraft: { materialId: "material:fixture", motive: "spam" } },
  ];
  for (const agency of invalid) {
    assert.throws(() => validateAgencyProposal(agency));
    const f = fixture({ decision: reply(agency) }), result = await f.run();
    assert.notEqual(result, "SOCIAL_COMPLETED"); assert.deepEqual(f.stages(), []);
    assert.equal(f.sends.length, 0); assert.equal(f.schedules.length, 0); assert.equal(f.getMarker().writes, 0);
  }
});

await check("REGRESSION useIntentIds cardinality: reject >1 at schema boundary", async () => {
  const agency = { useIntentIds: ["intent:one", "intent:two"] };
  const f = fixture({ decision: reply(agency) }); await f.run();
  assert.deepEqual(f.stages(), [], "multiple intent claims crossed validation into prepare/complete; contract permits at most one");
  assert.equal(f.sends.length, 0);
});

await check("REGRESSION sparse nested agency arrays: no null/hole proposals cross schema", async () => {
  const sparse = Array(1), agency = { preferences: sparse };
  const f = fixture({ model: () => reply(agency) }); await f.run();
  assert.deepEqual(f.stages(), [], "sparse array accepted before JSON copy; callback receives preferences:[null]");
  assert.equal(f.sends.length, 0);
});

for (const checkpoint of ["model", "claim", "prepare", "send"]) {
  await check(`quiet/stale at ${checkpoint}: blocks remaining stages and wire`, async () => {
    const gate = deferred();
    const f = fixture({
      ...(checkpoint === "model" ? { model: () => gate.promise } : {}),
      ...(checkpoint === "prepare" ? { apply: (_, __, ___, meta) => meta.stage === "prepare" ? gate.promise : { ok: true } } : {}),
      ...(checkpoint === "send" ? { send: () => gate.promise } : {}),
    });
    if (checkpoint === "claim") f.afterCommit = root => { if (state(root).status === "intent_claimed") f.current = false; };
    const running = f.run();
    if (checkpoint !== "claim") {
      await until(() => checkpoint === "model" ? f.models.length === 1 : checkpoint === "prepare" ? f.agencies.length === 1 : f.sends.length === 1);
      f.current = false;
      gate.resolve(checkpoint === "model" ? reply() : { ok: true, confirmed: true, messageId: "late-fake" });
    }
    assert.equal(await running, "SOCIAL_STALE"); assert.equal(f.getMarker().complete, 0);
    assert.ok(!f.stages().includes("complete")); assert.equal(f.sends.length, checkpoint === "send" ? 1 : 0);
    if (checkpoint !== "model") {
      f.current = true;
      await assertNoReplay(f, checkpoint === "send" ? 1 : 0, { allowStale: checkpoint === "claim" });
      if (checkpoint === "claim") {
        // Also remove the transient quiet hook: recovery still must not replay
        // the durably fenced input, even with routing/quiet now stable.
        f.afterCommit = undefined; f.current = true;
        await assertNoReplay(f);
      }
    }
  });
}

await check("cancel queued work: no model/agency/send", async () => {
  const f = fixture(); assert.equal(f.runtime.observe(CTX).queued, true);
  assert.equal(f.runtime.cancel(CTX.logicalId, CTX.conversationId).cancelled, 1);
  assert.deepEqual(await f.runtime.runDue(), []); assert.equal(f.models.length, 0); assert.deepEqual(f.stages(), []); assert.equal(f.sends.length, 0);
});

for (const checkpoint of ["prepare", "send"]) {
  await check(`cancel in-flight ${checkpoint}: ignores late resolution, no complete/retry`, async () => {
    const gate = deferred(), f = fixture(checkpoint === "prepare"
      ? { apply: (_, __, ___, meta) => meta.stage === "prepare" ? gate.promise : { ok: true } }
      : { send: () => gate.promise });
    const running = f.run();
    await until(() => checkpoint === "prepare" ? f.agencies.length === 1 : f.sends.length === 1);
    assert.equal(f.runtime.cancel(CTX.logicalId, CTX.conversationId).cancelled, 1);
    assert.equal(await running, "SOCIAL_CANCELLED");
    gate.resolve({ ok: true, confirmed: true, messageId: "cancelled-late-fake" }); await flush();
    assert.deepEqual(f.stages(), ["prepare"]); assert.equal(f.getMarker().complete, 0);
    assert.equal(f.agencies[0].meta.signal.aborted, true); await assertNoReplay(f, checkpoint === "send" ? 1 : 0);
  });
}

await check("fake timeout after prepare: no send/complete/retry", async () => {
  const gate = deferred(), f = fixture({ apply: () => gate.promise });
  const running = f.run(); await until(() => f.agencies.length === 1); f.clock.advance(60_000);
  assert.equal(await running, "SOCIAL_TIMEOUT"); gate.resolve({ ok: true }); await flush();
  assert.equal(f.sends.length, 0); assert.deepEqual(f.stages(), ["prepare"]); await assertNoReplay(f);
});

// Review evidence uses the actual bridge bodies, not a rewritten approximation.
// VM dependencies are explicit local fakes; no process/require/network surfaces.
const bridgeSource = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
await check("BRIDGE REGRESSION uncertain expression outcome must reach runtime before ACK/complete", async () => {
  const prefix = "    sendIntent: ", start = bridgeSource.indexOf(`${prefix}async (ctx, intent) => {`);
  const end = bridgeSource.indexOf("\n    }\n  });\n  socialDeliveredProvider", start);
  assert.ok(start > 0 && end > start, "exact bridge sendIntent extraction boundary");
  let unreadAcks = 0, deliveries = 0;
  const scope = { accountId: "fixture", internalId: "100", userId: "701", event: {}, ws: {} };
  const sender = vm.runInNewContext(`(${bridgeSource.slice(start + prefix.length, end + "\n    }".length)})`, {
    requireSocialCurrent: () => scope, effectiveAccount: () => ({ features: { proactive: true } }), config: {},
    replyCoordinator: { enqueue: ({ execute }) => execute({ job: { id: "fake-job" }, signal: new AbortController().signal, revision: "fake" }) },
    configForGroupAccount: () => ({ socialExperience: { enabled: true } }), accountById: () => ({ id: "fixture", qq: "999" }),
    replyDeliveryConfig: () => ({}), sanitizeChatReply: text => text,
    socialExperienceFor: () => ({ active: true, shadowMode: false, expression: { enabled: true, maxMessages: 4 } }),
    fromSocialMessages: messages => ({ action: "reply", messages }), discoveryPlanEvidence: () => [[]], discoveryItemsFor: () => [],
    groupSettings: () => ({}), memory: {}, voiceReplyMode: () => "off", aiVoicePlanAllowed: () => false,
    oneBotRequest: () => { throw new Error("NO_PROTOCOL_ALLOWED"); }, oneBotBinding: () => ({}),
    // Real renderer shape: first bubble confirmed, second attempted but ACK
    // uncertain. Thus handled=true is NOT proof that the whole plan completed.
    deliverChatExpression: async () => { deliveries++; return { sent: 1, accepted: 0, handled: true, uncertain: true, partial: true,
      receipts: [{ status: "sent", messageId: "fake-confirmed-first" }, { status: "uncertain" }] }; },
    socialAck: async () => { unreadAcks++; },
  });
  const f = fixture({ decision: { ...reply(), messages: ["先说公开话题", "补充关键观点"] }, send: (_, scope, intent) => sender(scope, intent) });
  const result = await f.run(); await assertNoReplay(f, 1);
  assert.equal(deliveries, 1, "exactly one existing fake expression dispatch");
  assert.deepEqual(f.stages(), ["prepare"], `bridge lost uncertain outcome: ${result}, unread ACKs=${unreadAcks}; must not reach complete`);
  assert.equal(unreadAcks, 0, "uncertain expression must not advance human unread watermark");
});

await check("BRIDGE REGRESSION merged stop must durably abandon using the actual stop source", async () => {
  let memory = {}, storedResult, runtimeCancels = 0;
  const base = { ...CTX, now: NOW };
  for (const [messageId, text] of [["source-original", "一起讨论太空探索的新进展"], ["source-stop", "不用再说"], ["source-tail", "先换个话题"]]) {
    assert.equal(ingestSocialMessage(memory, { ...base, message: { messageId, userId: "701", text,
      sentAt: NOW - 200, receivedAt: NOW - 100 } }).ok, true);
  }
  const intent = proposeSocialIntent(memory, { ...base, expectedRevision: 0, kind: "opinion", summary: "太空探索的公开想法",
    reason: "延续公开话题", trigger: { kind: "related_message", terms: ["太空探索"] }, evidenceMessageIds: ["source-original"], ttlMs: 60000 });
  assert.equal(intent.ok, true);
  const start = bridgeSource.indexOf("      if (!isPrivate && socialPolicy(accountState.id).agency.enabled");
  const end = bridgeSource.indexOf("      if (quietActive || isQuiet(", start);
  assert.ok(start > 0 && end > start, "exact bridge stop-handler extraction boundary");
  const stop = vm.runInNewContext(`(async () => {${bridgeSource.slice(start, end)}\nreturn "continued";})`, {
    isPrivate: false, socialPolicy: () => ({ agency: { enabled: true } }), accountState: { id: "fixture" },
    mentioned: true, quotedBot: false, keyword: false, text: "不用再说\n先换个话题", isAgencyStop,
    socialRuntime: { cancel: () => { runtimeCancels++; } }, interestWatch: { cancel: () => {} },
    inboundIdentity: { logicalBotId: CTX.logicalId }, socialConversationId: CTX.conversationId,
    current: { messageIds: ["source-stop", "source-tail"] },
    oneBotBindingCurrent: () => true, accountRuntimeIdentityCurrent: () => true, ws: {}, inboundBinding: {}, memory,
    mutateMemory: async (_, fn) => { const draft = clone(memory); storedResult = fn(draft); memory = draft; return storedResult; },
    abandonAgencyAttention, Date: class extends Date { static now() { return NOW; } },
  });
  assert.equal(await stop(), undefined, "stop returns early without a farewell send");
  assert.equal(runtimeCancels, 1);
  const selectable = selectRelevantSocialIntents(memory, { ...base, query: "太空探索" });
  assert.equal(selectable.length, 0, `stop persistence failed: ${JSON.stringify(storedResult)}; candidate must not be selectable on the next related input`);
});

await check("AGENCY REGRESSION due wait without fresh related input must not consume a new journal candidate", async () => {
  // The host's existing due-plan loop calls observe({resumeDue:true}); it does
  // not supply a new human event. A journal must not turn that into fresh source.
  const memory = {}, originalIds = ["human-a", "human-b"];
  for (const [i, messageId] of originalIds.entries()) assert.equal(ingestSocialMessage(memory, {
    ...CTX, now: NOW, message: { messageId, userId: String(701 + i), text: `关于太空探索的公开输入 ${i}`,
      sentAt: NOW - 200, receivedAt: NOW - 100 },
  }).ok, true);
  const currentBase = f => ({ ...CTX, now: f.clock.now() });
  let offered = [];
  const f = fixture({
    model: f => {
      if (f.models.length === 1) return terminal("wait", {});
      offered = agencySnapshot(memory, { ...currentBase(f), userId: "701", query: "太空探索", coreText: "" }).intentions;
      assert.equal(offered.length, 1, "old-topic prompt offered the newly stored candidate without a new message");
      return reply({ useIntentIds: [offered[0].id] });
    },
    apply: (f, _, value, meta) => meta.stage === "prepare"
      ? claimAgencyIntent(memory, { ...currentBase(f), ids: value.useIntentIds, offeredIntentIds: offered.map(e => e.id) })
      : applyAgencyObservations(memory, { ...currentBase(f), userId: "701", coreText: "", proposal: value,
        seenMessageIds: originalIds, ownEvidenceIds: [], materialIds: [], offeredIntentIds: offered.map(e => e.id) }),
  });
  assert.equal(await f.run(), "SOCIAL_WAITING");
  assert(proposeSocialIntent(memory, { ...currentBase(f), ...proposal().intents[0], expectedRevision: 0 }).ok);
  const beforeMessages = clone(memory.socialAgents.bots[CTX.logicalId].conversations[CTX.conversationId].messages);
  f.clock.advance(1000);
  const result = await f.run({ resumeDue: true });
  assert.deepEqual(memory.socialAgents.bots[CTX.logicalId].conversations[CTX.conversationId].messages, beforeMessages);
  assert.equal(f.sends.length, 0, `due-only resume claimed and sent a journal candidate (${result}) with no new related human event`);
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ ok: failures.length === 0, node: process.version, scenarios: results.length,
  passed: results.length - failures.length, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
