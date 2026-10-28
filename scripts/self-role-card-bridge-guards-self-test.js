import assert from "node:assert/strict";
import fs from "node:fs";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { applySelfRoleCard, getSelfRoleCard } from "../src/self-role-card.js";
import { createSelfRoleCardGenerator } from "../src/self-role-card-generator.js";

// Read SOURCE only. Never import/start bridge.js, read private config, create
// files, bind sockets or call a provider. Real bridge guards + adapter, real
// store and serial MemoryRuntime; only repository/account/model leaves are fixtures.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
function extract(start, end, offset = 0) {
  const from = source.indexOf(start, offset), to = from < 0 ? -1 : source.indexOf(end, from);
  assert(from >= 0 && to > from, `missing bridge source boundary: ${start}`);
  return source.slice(from, to);
}
const guards = extract("  function roleCardContext(", "\n  const roleCardGenerator = ");
const apply = extract("    applyCard: async (ctx, input) => {", "\n  });",
  source.indexOf("  const roleCardGenerator = "));
const settings = extract("function groupMemory(", "\nfunction dedupePush(");
const quiet = extract("function quietUntil(", "\nasync function repairInvalidQuietUntil(");
const callers = {
  command: extract("  async function handleRoleCardCommand(", "\n  const qzoneDraftGenerator = "),
  ui: extract("        if (selfRoleCardMatch) {", '\n        if (url.pathname.startsWith("/api/social-agent/")) {')
};
const bindSignal = Object.fromEntries(Object.entries(callers).map(([origin, body]) => {
  const assignments = [...body.matchAll(/ctx\.signal\s*=\s*controller\.signal\s*;/g)];
  assert.equal(assignments.length, 1, `${origin} must bind the ORIGINAL controller signal on ctx`);
  assert.match(body, /roleCardGenerator\.run\(ctx,[\s\S]*?signal:\s*controller\.signal/,
    `${origin} must pass that same signal to the generator`);
  return [origin, Function("ctx", "controller", assignments[0][0])];
}));

const NOW = Date.UTC(2026, 9, 27, 4), GROUP = "810001", ACCOUNT = "alpha", PEER = "beta";
const OWNER = `account:${ACCOUNT}`, OTHER = `account:${PEER}`;
const POLICY = { enabled: true, autoGrow: false, minUpdateIntervalMs: 86_400_000, maxVersions: 32 };
const FIELDS = { expression: "简洁温和，先回应问题", interests: "天文与音乐", examples: "假设对方分享新歌，可以先问喜欢哪段旋律。" };
const payload = extra => ({ fields: { ...FIELDS }, reason: "完善互动偏好", evidenceMessageIds: ["admin:fixture"], ...extra });
class FixedDate extends Date { static now() { return NOW; } }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
// Watchdog only, not test scheduling. All race ordering uses explicit promises.
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
const outcomeOf = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
let checks = 0;
async function test(name, run) {
  try { await bounded(run(), name); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

async function fixture({ existing = false, shared = false } = {}) {
  const owner = shared ? "group:shared" : OWNER;
  const initial = { fixture: { queueMarkers: 0 }, groups: { [GROUP]: { users: {}, settings: {
    botSettings: { [owner]: { quietUntil: 0 }, [OTHER]: { quietUntil: 0 } }
  } } } };
  const seed = (logicalId, fields) => assert.equal(applySelfRoleCard(initial, {
    logicalId, expectedRevision: 0, ...payload({ fields }), now: NOW - 1, policy: POLICY, explicit: true
  }).ok, true);
  if (existing) seed(owner, FIELDS);
  seed(OTHER, { expression: "独立账号的原有偏好" });
  let durable = structuredClone(initial), revision = 0, commits = 0, pauseCommit;
  const repository = {
    open: async () => ({ value: structuredClone(durable), revision }),
    status: () => ({ fixtureOnly: true }), close: async () => {},
    async commit(draft, options) {
      assert.equal(options.expectedRevision, revision, "real MemoryRuntime must preserve repository CAS");
      const submitted = structuredClone(draft), waiting = pauseCommit;
      pauseCommit = undefined;
      if (waiting) {
        waiting.submitted = submitted; waiting.entered.resolve(); await waiting.release.promise;
      }
      durable = submitted; revision++; commits++;
      return { value: structuredClone(durable), revision };
    }
  };
  const runtime = new MemoryRuntime(repository), memory = await runtime.open();
  const config = { accounts: {
    [ACCOUNT]: { id: ACCOUNT, logicalId: owner, executionRevision: "route:1", roleCard: { ...POLICY } },
    [PEER]: { id: PEER, logicalId: OTHER, executionRevision: "peer:1", roleCard: { ...POLICY } }
  } };
  const applyQueued = deferred();
  const environment = {
    config, memory, memoryRuntime: runtime, configRevision: 42, Date: FixedDate,
    // Fixture leaves return facts; roleCardCurrent itself is NEVER stubbed.
    accountById: (cfg, id) => cfg.accounts[id] || null,
    logicalBotId: (cfg, id) => cfg.accounts[id]?.logicalId || "",
    accountExecutionRevision: id => config.accounts[id]?.executionRevision,
    configForReplyAccount: account => ({ __activeAccountId: account.id }),
    accountGroup: (_cfg, id) => {
      const logicalId = config.accounts[id]?.logicalId || "";
      return logicalId.startsWith("group:") ? { id: logicalId.slice(6) } : null;
    },
    asStringId: String,
    socialPolicy: id => ({ roleCard: config.accounts[id]?.roleCard || { ...POLICY, enabled: false }, maxDailyCalls: 10 }),
    applySelfRoleCard, getSelfRoleCard,
    mutateMemory: (root, build) => {
      assert.strictEqual(root, memory);
      const result = runtime.transact(build);
      applyQueued.resolve();
      return result;
    }
  };
  // Same realm as the imported store: vm contexts would introduce foreign
  // Object prototypes and accidentally test INVALID_ARGS instead of the guard.
  const host = Function(...Object.keys(environment), `${settings}\n${quiet}\n${guards}
    const adapter = { ${apply} };
    return { roleCardContext, roleCardCurrent, applyCard: adapter.applyCard,
      advanceConfigRevision() { configRevision++; } };`)(...Object.values(environment));
  return {
    runtime, memory, config, host, owner, applyQueued: applyQueued.promise,
    get durable() { return structuredClone(durable); }, get commits() { return commits; },
    card: () => getSelfRoleCard(memory, { logicalId: owner }),
    context(origin = "ui", controller = new AbortController()) {
      const ctx = host.roleCardContext(ACCOUNT, getSelfRoleCard(memory, { logicalId: owner }).revision, "admin:fixture");
      bindSignal[origin](ctx, controller);
      assert.strictEqual(ctx.signal, controller.signal, `${origin} signal must retain identity`);
      if (origin === "command") ctx.controlId = GROUP;
      return { ctx, controller };
    },
    async blockQueue(build = () => {}) {
      const gate = { entered: deferred(), release: deferred(), submitted: null };
      assert.equal(pauseCommit, undefined);
      pauseCommit = gate;
      const done = runtime.transact(draft => { draft.fixture.queueMarkers++; build(draft); });
      await bounded(gate.entered.promise, "blocking commit entered");
      return { done, release: gate.release.resolve, get submitted() { return structuredClone(gate.submitted); } };
    }
  };
}

async function queueApply(f, ctx, input = payload(), priorWrite) {
  assert(f.host.roleCardCurrent(ctx), "control must start valid");
  const block = await f.blockQueue(priorWrite);
  const result = outcomeOf(f.host.applyCard(ctx, input));
  assert.equal(f.runtime.status().queuedTransactions, 2, "apply builder must wait behind a real pending commit");
  return { block, result };
}
async function finish(f, queued) {
  queued.block.release();
  await bounded(queued.block.done, "preceding durable publication");
  return bounded(queued.result, "queued apply outcome");
}
function assertUnchanged(f, queued, beforeCard, expectedCommits = 1) {
  assert.deepEqual(f.card(), beforeCard, "card revision/fields/history must remain unchanged");
  assert.deepEqual(f.memory, queued.block.submitted, "rejected builder must not partially mutate any account");
  assert.deepEqual(f.durable, queued.block.submitted, "no rejected card update may reach durable state");
  assert.equal(f.commits, expectedCommits, "guard throws must not commit; a store rejection may commit an unchanged draft");
}

for (const origin of ["ui", "command"]) {
  await test(`${origin}: live queued apply succeeds and returns a detached card`, async () => {
    const f = await fixture(), { ctx } = f.context(origin);
    const queued = await queueApply(f, ctx), result = await finish(f, queued);
    assert.equal(result.ok, true); assert.equal(result.value.ok, true);
    assert.equal(f.card().revision, 1); assert.equal(f.card().versions.length, 1);
    assert.deepEqual(result.value.card, { revision: 1, fields: FIELDS });
    assert.deepEqual(getSelfRoleCard(f.memory, { logicalId: OTHER }), getSelfRoleCard(queued.block.submitted, { logicalId: OTHER }));
    assert.deepEqual(f.memory, f.durable);
    result.value.card.fields.expression = "outside mutation";
    assert.equal(f.card().fields.expression, FIELDS.expression);
    await f.runtime.close();
  });

  for (const existing of [false, true]) await test(`${origin}: abort before queued builder preserves ${existing ? "old history" : "absent card"}`, async () => {
    const f = await fixture({ existing }), { ctx, controller } = f.context(origin), before = f.card();
    const queued = await queueApply(f, ctx, payload({ fields: { expression: "这次尚未采用的偏好" } }));
    controller.abort();
    assert.equal(Boolean(f.host.roleCardCurrent(ctx)), false);
    const result = await finish(f, queued);
    assert.equal(result.ok, false); assert.equal(result.error.message, "ROLE_CARD_STALE");
    assertUnchanged(f, queued, before);
    await f.runtime.close();
  });

  const revocations = {
    configuration: f => f.host.advanceConfigRevision(),
    "logical identity": f => { f.config.accounts[ACCOUNT].logicalId = "group:newOwner"; },
    "execution revision": f => { f.config.accounts[ACCOUNT].executionRevision = "route:2"; },
    "account removal": f => { delete f.config.accounts[ACCOUNT]; },
    "policy disable": f => { f.config.accounts[ACCOUNT].roleCard.enabled = false; }
  };
  for (const [name, revoke] of Object.entries(revocations)) await test(`${origin}: queued ${name} revocation blocks apply`, async () => {
    const f = await fixture({ existing: true }), { ctx } = f.context(origin), before = f.card();
    const queued = await queueApply(f, ctx, payload({ fields: { interests: "新的兴趣" } }));
    revoke(f);
    assert.equal(Boolean(f.host.roleCardCurrent(ctx)), false);
    const result = await finish(f, queued);
    assert.equal(result.ok, false); assert.equal(result.error.message, "ROLE_CARD_STALE");
    assertUnchanged(f, queued, before);
    await f.runtime.close();
  });

  await test(`${origin}: exact NO_CHANGE is success without a version/history append`, async () => {
    const f = await fixture({ existing: true }), { ctx } = f.context(origin), before = f.card();
    const queued = await queueApply(f, ctx, payload({ reason: "相同内容的新理由", evidenceMessageIds: ["admin:second"] }));
    const result = await finish(f, queued);
    assert.equal(result.ok, true); assert.deepEqual(result.value, { ok: true, card: { revision: before.revision, fields: before.fields } });
    assert.deepEqual(f.card(), before); assert.deepEqual(f.memory, queued.block.submitted);
    assert.deepEqual(f.durable, queued.block.submitted);
    result.value.card.fields.expression = "outside mutation";
    assert.deepEqual(f.card(), before);
    await f.runtime.close();
  });
}

// Quiet is committed through the SAME lane, not by mutating the published root.
for (const shared of [false, true]) await test(`command: queued quiet publication blocks ${shared ? "shared" : "independent"} identity`, async () => {
  const f = await fixture({ existing: true, shared }), { ctx } = f.context("command"), before = f.card();
  const queued = await queueApply(f, ctx, payload({ fields: { expression: "不可采用" } }), draft => {
    draft.groups[GROUP].settings.botSettings[f.owner].quietUntil = NOW + 60_000;
  });
  assert(f.host.roleCardCurrent(ctx), "unpublished quiet draft must not appear committed yet");
  const result = await finish(f, queued);
  assert.equal(result.ok, false); assert.equal(result.error.message, "ROLE_CARD_STALE");
  assert.equal(Boolean(f.host.roleCardCurrent(ctx)), false);
  assertUnchanged(f, queued, before);
  await f.runtime.close();
});
await test("command: another account's quiet does not block this identity", async () => {
  const f = await fixture(), { ctx } = f.context("command");
  const queued = await queueApply(f, ctx, payload(), draft => {
    draft.groups[GROUP].settings.botSettings[OTHER].quietUntil = NOW + 60_000;
  });
  assert.equal((await finish(f, queued)).ok, true); assert.equal(f.card().revision, 1);
  await f.runtime.close();
});

for (const [name, input, setup, message] of [
  ["CAS conflict", payload(), ctx => { ctx.expectedRevision = 99; }, "ROLE_CARD_REVISION_CONFLICT"],
  ["forbidden core field", payload({ fields: { identity: "不能写入" } }), () => {}, "ROLE_CARD_INVALID_FIELDS"],
  ["missing evidence", payload({ evidenceMessageIds: [] }), () => {}, "ROLE_CARD_INVALID_EVIDENCE"],
  ["full history", payload(), (_ctx, f) => { f.config.accounts[ACCOUNT].roleCard.maxVersions = 1; }, "ROLE_CARD_CAPACITY"]
]) await test(`NO_CHANGE exception must not mask ${name}`, async () => {
  const f = await fixture({ existing: true }), { ctx } = f.context(), before = f.card();
  setup(ctx, f);
  const queued = await queueApply(f, ctx, input), result = await finish(f, queued);
  assert.equal(result.ok, false); assert.equal(result.error.message, message);
  assertUnchanged(f, queued, before, 2);
  await f.runtime.close();
});

await test("queued CAS observes a preceding durable card update, not a stale root", async () => {
  const f = await fixture(), { ctx } = f.context();
  const queued = await queueApply(f, ctx, payload(), draft => {
    assert.equal(applySelfRoleCard(draft, { logicalId: f.owner, expectedRevision: 0,
      ...payload({ fields: { expression: "先提交的偏好" } }), now: NOW, policy: POLICY, explicit: true }).ok, true);
  });
  const result = await finish(f, queued);
  assert.equal(result.ok, false); assert.equal(result.error.message, "ROLE_CARD_REVISION_CONFLICT");
  assert.deepEqual(f.memory, queued.block.submitted); assert.deepEqual(f.durable, queued.block.submitted);
  assert.equal(f.card().revision, 1); assert.equal(f.card().fields.expression, "先提交的偏好");
  await f.runtime.close();
});

// End-to-end reproduction of the reported bug using the actual generator AND
// actual host adapter. Model output waits while a preceding commit blocks apply.
for (const origin of ["ui", "command"]) await test(`${origin}: generator abort while host apply is queued never adopts a card`, async () => {
  const f = await fixture(), { ctx, controller } = f.context(origin), before = f.card();
  const modelEntered = deferred(), modelRelease = deferred();
  let modelCalls = 0;
  const generator = createSelfRoleCardGenerator({
    isCurrent: value => Boolean(f.host.roleCardCurrent(value)),
    getPolicy: () => ({ ...f.config.accounts[ACCOUNT].roleCard, maxDailyCalls: 10 }),
    getPersona: () => "稳定文风，仅供参考", clock: () => NOW,
    transact: build => f.runtime.transact(build), applyCard: f.host.applyCard,
    generate: async () => {
      modelCalls++; modelEntered.resolve(); await modelRelease.promise;
      return JSON.stringify({ ...FIELDS, reason: "完善互动偏好" });
    }
  });
  const resultPromise = outcomeOf(generator.run(ctx, {}, { actor: { id: "fixture-admin", authorized: true }, signal: controller.signal }));
  await bounded(modelEntered.promise, "model entered");
  const block = await f.blockQueue();
  modelRelease.resolve();
  await bounded(f.applyQueued, "actual host apply enqueued");
  assert.equal(f.runtime.status().queuedTransactions, 2);
  assert.deepEqual(f.card(), before);
  controller.abort(); block.release();
  await bounded(block.done, "blocking commit finished");
  const result = await bounded(resultPromise, "generator cancellation settled");
  assert.equal(result.ok, false); assert.equal(result.error.code, "ROLE_CARD_STALE_OR_ABORTED");
  assert.deepEqual(f.card(), before);
  assert.deepEqual(getSelfRoleCard(f.durable, { logicalId: f.owner }), before);
  assert.equal(modelCalls, 1);
  const day = new Date(NOW + 28_800_000).toISOString().slice(0, 10);
  const usage = f.durable.socialAgents.bots[f.owner].runtimeUsage.days[day];
  assert.equal(usage.reservedCalls, 1); assert.equal(usage.actualCalls, 1); assert.equal(usage.unknownUsageCalls, 1);
  assert.deepEqual(usage.pending, {}, "accounting cleanup must still settle after cancellation");
  assert.equal(f.commits, 3, "reservation + preceding neutral write + settlement; NO card commit");
  assert.deepEqual(getSelfRoleCard(f.memory, { logicalId: OTHER }), getSelfRoleCard(block.submitted, { logicalId: OTHER }));
  await f.runtime.close();
});

console.log(`self-role-card bridge guards self-test: PASS (${checks} checks; extracted host guards/adapter, real serial runtime/store/generator; offline fixtures only)`);
