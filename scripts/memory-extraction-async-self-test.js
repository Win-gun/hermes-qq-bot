// Synthetic only: no files, live config, QQ messages, network or model calls.
import assert from "node:assert/strict";
import { createAsyncMemoryExtractionScheduler } from "../src/memory-extraction-async.js";
import {
  createMemoryExtractionState, enqueueMemoryMessages, prepareMemoryBatch, claimMemoryBatch
} from "../src/memory-extraction-jobs.js";

const copy = value => structuredClone(value);
const event = id => ({ message_id: id, time: 123, text: `synthetic-${id}`, user_id: "synthetic-user" });
const job = (root, id = "g") => root.groups[id]?.memoryExtractionJobs;
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const privateError = () => new Error("synthetic-private-error-MUST-NOT-ESCAPE");

// Independent parent-adapter validation, not imported from the scheduler. Reject
// invalid data BEFORE any persistence/publication; stringify is not sufficient.
function validateBackendJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw privateError();
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!array && proto !== Object.prototype && proto !== null) throw privateError();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw privateError();
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
      || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) throw privateError();
    validateBackendJSON(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function fixture(options = {}) {
  let live = copy(options.root || { groups: {} });
  let durable = copy(live);
  let tail = Promise.resolve();
  let enabled = true;
  let outage = false;
  let calls = 0;
  let patches = 0;
  let starts = 0;
  let submissions = 0;
  let validationFailures = 0;
  const beforeActions = [];
  const saveActions = [];
  const history = [];
  const drafts = [];
  const schedulerView = value => options.schedulerView ? options.schedulerView(value) : value;
  function validate(draft) {
    try { validateBackendJSON(draft); }
    catch (cause) { validationFailures++; throw cause; }
  }
  function transact(build) {
    submissions++;
    const operation = tail.then(async () => {
      starts++;
      await beforeActions.shift()?.();
      // Clone LATEST live only when this queued transaction actually executes.
      const draft = copy(live);
      validate(draft);
      const result = build(schedulerView(draft));
      assert.equal(typeof result?.then, "undefined", "all mutators must be synchronous");
      validate(draft); // synchronous full-root gate in the PARENT adapter
      drafts.push(copy(draft));
      await saveActions.shift()?.(draft);
      if (outage) throw privateError();
      assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft);
      durable = copy(draft); // async durable acknowledgment, THEN publication
      live = copy(draft);
      history.push(copy(draft));
      return result;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  const make = () => createAsyncMemoryExtractionScheduler({
    getState: () => schedulerView(live), transact,
    isEnabled: id => enabled && (options.isEnabled?.(id) ?? true),
    process: context => {
      calls++;
      const claimed = job(durable, context.conversationId);
      assert.equal(claimed.batch.status, "running", "NO model before durable claim");
      assert.equal(claimed.batch.id, context.batch.id);
      assert.equal(claimed.batch.attempts, context.batch.attempts);
      assert.deepEqual(context.batch.messages, context.messages);
      return options.process ? options.process(context) : { facts: [context.batch.id] };
    },
    apply: (draft, candidate, context) => {
      patches++;
      if (options.apply) return options.apply(draft, candidate, context);
      const group = draft.groups[context.conversationId];
      group.facts ||= [];
      if (candidate) group.facts.push(...candidate.facts);
    },
    batchSize: options.batchSize ?? (() => 2), concurrency: options.concurrency ?? 2,
    maxPendingMessages: options.maxPendingMessages ?? 1024,
    maxKnownMessages: options.maxKnownMessages ?? 100000
  });
  let scheduler = make();
  return {
    get scheduler() { return scheduler; }, get live() { return live; }, get durable() { return durable; },
    get calls() { return calls; }, get patches() { return patches; },
    get validationFailures() { return validationFailures; },
    get starts() { return starts; }, get submissions() { return submissions; }, history, drafts, transact,
    enable: value => { enabled = value; }, outage: value => { outage = value; },
    holdBefore() { const gate = deferred(); beforeActions.push(() => gate.promise); return gate; },
    holdSave() { const gate = deferred(); saveActions.push(() => gate.promise); return gate; },
    failSave(count = 1) { for (let i = 0; i < count; i++) saveActions.push(() => { throw privateError(); }); },
    restart() { live = copy(durable); scheduler = make(); return scheduler.recover(); }
  };
}
const tests = [];
const test = (name, run) => tests.push([name, run]);

test("delayed queue + durable claim before model; import/prepare/claim ONE commit", async () => {
  const legacy = [event("old")];
  const model = deferred();
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: legacy } } }, process: () => model.promise });
  const before = f.holdBefore();
  const save = f.holdSave();
  const sweep = f.scheduler.run();
  assert.equal(f.scheduler.run(), sweep);
  await tick();
  assert.equal(f.calls, 0);
  assert.equal(job(f.live), undefined);
  assert.equal(f.drafts.length, 0);
  before.resolve();
  await tick();
  assert.equal(f.drafts.length, 1);
  assert.equal(job(f.drafts[0]).batch.status, "running");
  assert.equal(job(f.drafts[0]).batch.attempts, 1);
  assert.equal(job(f.live), undefined);
  assert.equal(f.calls, 0);
  save.resolve();
  await tick();
  assert.equal(f.calls, 1);
  assert.equal(f.history.length, 1);
  model.resolve({ facts: ["ok"] });
  assert.equal((await sweep)[0].status, "committed");
  assert.equal(f.history.length, 2, "patch + ACK are one second commit");
  assert.equal(job(f.durable).batch, null);
  assert.deepEqual(f.durable.groups.g.pendingMemoryMessages, legacy);
  assert.deepEqual(f.durable.groups.g.facts, ["ok"]);
});

test("new input QUEUED before ACK survives; latest unrelated root changes survive", async () => {
  const model = deferred();
  const f = fixture({ batchSize: 1, process: () => model.promise });
  await f.scheduler.enqueue("g", event("old"));
  const oldRoot = f.live;
  const sweep = f.scheduler.run();
  await tick();
  const save = f.holdSave();
  const addition = f.scheduler.enqueue("g", event("new"));
  const other = f.transact(draft => { draft.sentinel = { version: 2 }; });
  await tick();
  model.resolve({ facts: ["candidate"] });
  await tick();
  assert.equal(f.patches, 0);
  assert.equal(job(f.live).messages.length, 1);
  save.resolve();
  await Promise.all([addition, other, sweep]);
  assert.notEqual(f.live, oldRoot);
  assert.deepEqual(job(f.live).messages.map(item => item.input.message_id), ["new"]);
  assert.equal(job(f.live).acknowledged.length, 1);
  assert.deepEqual(f.live.sentinel, { version: 2 });
  assert.deepEqual(f.live.groups.g.facts, ["candidate"]);
});

test("concurrent ingestion clones only input before queue; idempotent after restart", async () => {
  const f = fixture();
  const gate = f.holdBefore();
  const input = event("1");
  const first = f.scheduler.enqueue("g", input);
  input.text = "caller changed input after submission";
  const duplicate = f.scheduler.enqueue("g", event("1"));
  const second = f.scheduler.enqueue("g", event("2"));
  await tick();
  assert.equal(job(f.live), undefined);
  gate.resolve();
  assert.equal((await first).accepted, 1);
  assert.equal((await duplicate).duplicates, 1);
  await second;
  assert.equal(job(f.live).messages[0].input.text, "synthetic-1");
  await f.scheduler.run();
  await f.restart();
  assert.equal((await f.scheduler.enqueue("g", event("1"))).duplicates, 1);
  assert.equal(f.calls, 1);
});

test("global two / same conversation one; shared sweep processes one batch per conversation", async () => {
  const gates = { a: deferred(), b: deferred(), c: deferred() };
  const running = new Set();
  let peak = 0;
  const f = fixture({ batchSize: 1, process: async ({ conversationId }) => {
    assert.equal(running.has(conversationId), false);
    running.add(conversationId);
    peak = Math.max(peak, running.size);
    await gates[conversationId].promise;
    running.delete(conversationId);
    return null;
  } });
  for (const id of Object.keys(gates)) {
    await f.scheduler.enqueue(id, event("1"));
    await f.scheduler.enqueue(id, event("2"));
  }
  const sweep = f.scheduler.run();
  for (let i = 0; i < 5; i++) assert.equal(f.scheduler.run(), sweep);
  await tick();
  assert.equal(f.calls, 2);
  assert.equal(peak, 2);
  await assert.rejects(f.scheduler.retry("a"), { code: "MEMORY_JOB_BUSY" });
  await assert.rejects(f.scheduler.recover(), { code: "MEMORY_JOB_BUSY" });
  gates.a.resolve();
  await tick();
  assert.equal(f.calls, 3);
  gates.b.resolve(); gates.c.resolve();
  assert.equal((await sweep).length, 3);
  assert.equal(peak, 2);
  for (const id of Object.keys(gates)) assert.equal(job(f.live, id).messages.length, 1);
});

test("recovery is async and preserves batch/membership/attempts; run waits for recovery", async () => {
  const state = enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1"), event("2")]).state;
  const running = claimMemoryBatch(prepareMemoryBatch(state, "g", 1));
  const f = fixture({ root: { groups: { g: { memoryExtractionJobs: running } } }, batchSize: () => 99 });
  assert.equal((await f.scheduler.run())[0].status, "recovery_required");
  const gate = f.holdSave();
  const recovery = f.scheduler.recover();
  assert.equal(f.scheduler.recover(), recovery);
  const sweep = f.scheduler.run();
  await tick();
  assert.equal(job(f.live).batch.status, "running");
  assert.equal(f.calls, 0);
  gate.resolve();
  assert.equal(await recovery, 1);
  const [result] = await sweep;
  assert.equal(result.batchId, running.batch.id);
  assert.equal(result.attempts, 2);
  assert.equal(result.count, 1);
  assert.deepEqual(job(f.live).messages.map(item => item.input.message_id), ["2"]);
});

test("failed recovery never publishes; explicit retry of recovery succeeds", async () => {
  const running = claimMemoryBatch(prepareMemoryBatch(
    enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1")]).state, "g"));
  const f = fixture({ root: { groups: { g: { memoryExtractionJobs: running } } } });
  f.failSave();
  await assert.rejects(f.scheduler.recover(), { code: "MEMORY_JOB_RECOVER_FAILED" });
  assert.deepEqual(job(f.live), running);
  assert.equal(await f.scheduler.recover(), 1);
  assert.equal(job(f.live).batch.status, "pending");
});

test("model failure persists gate; restart keeps failure; async retry preserves batch", async () => {
  let failing = true;
  const f = fixture({ process: () => { if (failing) throw privateError(); return null; } });
  await f.scheduler.enqueue("g", event("1"));
  const [failed] = await f.scheduler.run();
  assert.equal(failed.stage, "process");
  assert.equal(failed.failurePersisted, true);
  assert.equal(JSON.stringify([failed, f.live]).includes("MUST-NOT-ESCAPE"), false);
  const batch = copy(job(f.live).batch);
  assert.equal(batch.attempts, 1);
  assert.equal(batch.failures, 1);
  assert.equal(await f.restart(), 0);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  failing = false;
  const gate = f.holdSave();
  const retry = f.scheduler.retry("g");
  assert.equal(f.scheduler.retry("g"), retry);
  await tick();
  assert.equal(job(f.live).batch.retryRequired, true);
  gate.resolve();
  assert.equal(await retry, true);
  const [success] = await f.scheduler.run();
  assert.equal(success.batchId, batch.id);
  assert.equal(success.attempts, 2);
  assert.equal(f.calls, 2);
});

test("claim + failure-save storage outage: no model, no busyloop; retry flushes exact attempts", async () => {
  const legacy = [event("1"), event("2")];
  let size = 1;
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: legacy } } }, batchSize: () => size });
  f.outage(true);
  const [failed] = await f.scheduler.run();
  assert.equal(failed.stage, "claim");
  assert.equal(failed.failurePersisted, false);
  assert.equal(f.calls, 0);
  assert.equal(job(f.live), undefined);
  const submissions = f.submissions;
  for (let i = 0; i < 5; i++) assert.equal((await f.scheduler.run())[0].status, "retry_required");
  assert.equal(f.submissions, submissions, "blockedMap must prevent storage/model busyloop");
  await assert.rejects(f.scheduler.retry("g"), { code: "MEMORY_JOB_RETRY_FAILED" });
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  f.outage(false);
  size = 50;
  assert.equal(await f.scheduler.retry("g"), true);
  assert.equal(job(f.live).batch.id, failed.batchId);
  assert.equal(job(f.live).batch.attempts, 1);
  assert.equal(job(f.live).batch.failures, 1);
  assert.equal(job(f.live).batch.keys.length, 1);
  const [success] = await f.scheduler.run();
  assert.equal(success.batchId, failed.batchId);
  assert.equal(success.attempts, 2);
  assert.equal(success.count, 1);
  assert.equal(job(f.live).messages.length, 1);
  assert.deepEqual(f.live.groups.g.pendingMemoryMessages, legacy);
});

test("storage rejection before mutator also blocks; retry is required", async () => {
  let reject = true;
  let submissions = 0;
  const root = { groups: { g: { pendingMemoryMessages: [event("1")] } } };
  let live = copy(root);
  const scheduler = createAsyncMemoryExtractionScheduler({ getState: () => live,
    transact: async build => {
      submissions++;
      if (reject) throw privateError();
      const draft = copy(live);
      validateBackendJSON(draft);
      const result = build(draft);
      assert.equal(typeof result?.then, "undefined");
      validateBackendJSON(draft);
      live = draft;
      return result;
    }, process: () => { throw new Error("model must not run in this test"); }, apply: () => {} });
  const [failed] = await scheduler.run();
  assert.equal(failed.failurePersisted, false);
  assert.equal(failed.batchId, null);
  assert.equal((await scheduler.run())[0].status, "retry_required");
  assert.equal(submissions, 1);
  reject = false;
  assert.equal(await scheduler.retry("g"), true);
  assert.deepEqual(live, root);
});

test("commit storage failure rolls back BOTH patch and ACK; failure metadata remains", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise });
  await f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  f.failSave();
  model.resolve({ facts: ["candidate"] });
  const [failed] = await sweep;
  assert.equal(failed.stage, "commit");
  assert.equal(failed.failurePersisted, true);
  assert.equal(f.live.groups.g.facts, undefined);
  assert.equal(job(f.live).acknowledged.length, 0);
  assert.equal(job(f.live).messages.length, 1);
  assert.equal(job(f.live).batch.retryRequired, true);
  await f.scheduler.retry("g");
  assert.equal((await f.scheduler.run())[0].attempts, 2);
  assert.deepEqual(f.live.groups.g.facts, ["candidate"]);
  assert.equal(job(f.live).acknowledged.length, 1);
});

test("failed failure-save after model preserves attempts; recover cannot bypass private gate", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise });
  await f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  f.failSave(2);
  model.resolve({ facts: [] });
  const [failed] = await sweep;
  assert.equal(failed.failurePersisted, false);
  assert.equal(job(f.live).batch.status, "running");
  assert.equal(await f.scheduler.recover(), 0);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  await f.scheduler.retry("g");
  assert.equal(job(f.live).batch.attempts, 1);
  assert.equal(job(f.live).batch.failures, 1);
  assert.equal((await f.scheduler.run())[0].attempts, 2);
});

test("disabled during model discards even non-JSON candidate, keeps exact batch, no ACK", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise });
  await f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  const batch = copy(job(f.live).batch);
  f.enable(false);
  model.resolve({ invalid: undefined });
  assert.equal((await sweep)[0].status, "disabled");
  assert.equal(f.patches, 0);
  assert.equal(job(f.live).acknowledged.length, 0);
  assert.deepEqual(job(f.live).batch, { ...batch, status: "pending" });
  assert.equal((await f.scheduler.enqueue("g", event("new"))).accepted, 1);
  assert.equal((await f.scheduler.run())[0].status, "disabled");
});

test("disable queued ahead of ACK checked on latest draft, not only after model", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise });
  await f.scheduler.enqueue("g", event("old"));
  const sweep = f.scheduler.run();
  await tick();
  const gate = f.holdBefore();
  const queuedInput = f.scheduler.enqueue("g", event("new"));
  await tick();
  model.resolve({ facts: ["must discard"] });
  await tick();
  assert.equal(f.patches, 0);
  f.enable(false);
  gate.resolve();
  await queuedInput;
  assert.equal((await sweep)[0].status, "disabled");
  assert.equal(f.live.groups.g.facts, undefined);
  assert.equal(job(f.live).messages.length, 2);
  assert.equal(job(f.live).acknowledged.length, 0);
  assert.equal(job(f.live).batch.status, "pending");
  f.enable(true);
  const [success] = await f.scheduler.run();
  assert.equal(success.count, 1, "resume uses pinned batch, not the added input");
  assert.equal(success.attempts, 2);
});

test("disable while claim save is pending prevents model after durable claim", async () => {
  const f = fixture();
  await f.scheduler.enqueue("g", event("1"));
  const gate = f.holdSave();
  const sweep = f.scheduler.run();
  await tick();
  f.enable(false);
  gate.resolve();
  assert.equal((await sweep)[0].status, "disabled");
  assert.equal(f.calls, 0);
  assert.equal(job(f.live).batch.status, "pending");
  assert.equal(job(f.live).batch.attempts, 1);
  f.enable(true);
  assert.equal((await f.scheduler.run())[0].attempts, 2);
});

test("dynamic batch size read in queued prepare; invalid size consumes nothing; retries pinned", async () => {
  let size = 0;
  let reads = 0;
  let fail = false;
  const f = fixture({ batchSize: () => { reads++; return size; },
    process: () => { if (fail) throw privateError(); return null; } });
  for (let i = 0; i < 7; i++) await f.scheduler.enqueue("g", event(String(i)));
  const before = copy(job(f.live));
  assert.equal((await f.scheduler.run())[0].code, "MEMORY_JOB_BATCH_SIZE_INVALID");
  assert.deepEqual(job(f.live), before);
  size = 1;
  assert.equal((await f.scheduler.run())[0].count, 1);
  const gate = f.holdBefore();
  const sweep = f.scheduler.run();
  await tick();
  size = 3; // queued but not yet prepared
  gate.resolve();
  assert.equal((await sweep)[0].count, 3);
  size = 2;
  fail = true;
  await f.scheduler.run();
  const batch = copy(job(f.live).batch);
  const oldReads = reads;
  size = NaN;
  fail = false;
  await f.scheduler.retry("g");
  const [success] = await f.scheduler.run();
  assert.equal(reads, oldReads);
  assert.equal(success.batchId, batch.id);
  assert.equal(success.count, 2);
  assert.equal(job(f.live).messages.length, 1);
});

test("non-JSON candidates fail closed with safe codes, no patch/ACK", async () => {
  const circular = {}; circular.self = circular;
  const sparse = new Array(2);
  for (const candidate of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(),
    { invalid: undefined }, { invalid: Symbol("synthetic") }, { [Symbol("x")]: 1 }, circular, sparse]) {
    const f = fixture({ process: () => candidate });
    await f.scheduler.enqueue("g", event("1"));
    const [failed] = await f.scheduler.run();
    assert.equal(failed.code, "MEMORY_JOB_NON_JSON");
    assert.equal(failed.failurePersisted, true);
    assert.equal(f.patches, 0);
    assert.equal(job(f.live).acknowledged.length, 0);
    assert.equal(job(f.live).batch.retryRequired, true);
  }
});

test("parent whole-state validation rejects invalid apply; scheduler still rejects ACK edits/async patch", async () => {
  for (const apply of [draft => { draft.bad = undefined; }, draft => { draft.bad = new Date(); },
    draft => { draft.groups.g.memoryExtractionJobs.acknowledged = []; },
    () => Promise.reject(privateError()), () => { throw privateError(); }]) {
    const f = fixture({ apply });
    await f.scheduler.enqueue("g", event("1"));
    const [failed] = await f.scheduler.run();
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "commit");
    assert.equal(failed.failurePersisted, true);
    assert.equal(f.live.bad, undefined);
    assert.equal(job(f.live).acknowledged.length, 0);
    assert.equal(JSON.stringify(failed).includes("MUST-NOT-ESCAPE"), false);
  }
  const f = fixture({ root: { groups: {}, invalid: undefined } });
  await assert.rejects(f.scheduler.enqueue("g", event("1")), { code: "MEMORY_JOB_ENQUEUE_FAILED" });
  assert.equal(f.validationFailures, 1);
  assert.equal(f.history.length, 0);
});

test("safe parent adapter rejects bad apply NaN/Infinity before saving or publishing patch + ACK", async () => {
  for (const invalid of [NaN, Infinity, -Infinity, undefined, new Date(), new Map()]) {
    const original = { marker: "unchanged", history: [1, 2, 3] };
    const f = fixture({ root: { groups: { other: original } }, apply: draft => {
      // Outside the scheduler's job state: ONLY the parent should inspect this.
      draft.groups.other.history.push(invalid);
      draft.groups.g.facts = ["invalid patch must not publish"];
    } });
    await f.scheduler.enqueue("g", event("1"));
    const [failed] = await f.scheduler.run();
    assert.equal(f.patches, 1);
    assert.equal(f.validationFailures, 1, "bad apply must reach the parent's full-root gate");
    assert.equal(failed.code, "MEMORY_JOB_COMMIT_FAILED");
    assert.equal(failed.stage, "commit");
    assert.equal(failed.failurePersisted, true);
    for (const root of [f.live, f.durable, ...f.history]) {
      assert.deepEqual(root.groups.other, original);
      assert.equal(root.groups.g.facts, undefined);
      assert.equal(job(root).acknowledged.length, 0);
    }
    assert.equal(job(f.live).messages.length, 1);
    assert.equal(job(f.live).batch.retryRequired, true);
    assert.equal(JSON.stringify(failed).includes("MUST-NOT-ESCAPE"), false);
  }
});

test("strict input boundary rejects non-JSON before submitting a parent transaction", async () => {
  const f = fixture();
  const cyclic = {}; cyclic.self = cyclic;
  for (const input of [NaN, Infinity, undefined, new Date(), new Map(), 1n,
    { value: undefined }, { [Symbol("synthetic")]: 1 }, new Array(2), cyclic]) {
    await assert.rejects(f.scheduler.enqueue("g", input), { code: "MEMORY_JOB_NON_JSON" });
  }
  assert.equal(f.submissions, 0);
  assert.equal((await f.scheduler.enqueue("g", event("valid"))).accepted, 1);
});

test("7MB unrelated root/group histories are never traversed by scheduler reads or mutators", async () => {
  const forbidden = [];
  const deny = path => { forbidden.push(path); throw new Error("synthetic unrelated field was read"); };
  // Backend clones/validates raw drafts normally. ONLY the view passed to the
  // scheduler is instrumented, so its scans cannot hide behind backend scans.
  const schedulerView = root => new Proxy(root, {
    ownKeys: () => deny("root traversal"),
    get(target, key) {
      if (key === "then") return undefined; // synchronous callback contract probe
      if (key !== "groups") return deny(`root.${String(key)}`);
      return new Proxy(target.groups, {
        get(groups, id) {
          const group = Reflect.get(groups, id);
          if (!Object.hasOwn(groups, id) || !group) return group;
          return new Proxy(group, {
            ownKeys: () => deny(`groups.${String(id)} traversal`),
            get(value, field) {
              if (field === "history") return deny(`groups.${String(id)}.history`);
              return Reflect.get(value, field);
            }
          });
        }
      });
    }
  });
  let fail = false;
  const history = { events: ["x".repeat(7 * 1024 * 1024)] };
  const f = fixture({ root: {
    unrelated: { marker: "root preserved" },
    groups: { g: { history: { events: ["own group history"] }, pendingMemoryMessages: [event("legacy")] },
      other: { history } }
  }, schedulerView, batchSize: 1, process: () => { if (fail) throw privateError(); return null; } });
  await f.scheduler.enqueue("g", event("new"));
  assert.equal((await f.scheduler.importLegacy("g")).accepted, 1);
  assert.equal(await f.scheduler.recover(), 0);
  assert.equal((await f.scheduler.run())[0].status, "committed");
  fail = true;
  assert.equal((await f.scheduler.run())[0].status, "failed");
  assert.equal(await f.scheduler.retry("g"), true);
  fail = false;
  assert.equal((await f.scheduler.run())[0].status, "committed");
  assert.equal(await f.scheduler.retry("g"), false);
  assert.deepEqual(forbidden, [], "scheduler must never inspect unrelated root/group payloads");
  assert.equal(f.validationFailures, 0);
  assert.deepEqual(f.live.unrelated, { marker: "root preserved" });
  assert.deepEqual(f.live.groups.g.history, { events: ["own group history"] });
  assert.deepEqual(f.live.groups.other.history, history);
  assert.deepEqual(f.live.groups.g.pendingMemoryMessages, [event("legacy")]);
  assert.equal(job(f.live).acknowledged.length, 2);
});

test("backpressure preserves legacy array/old inputs; known ledger never evicted", async () => {
  const legacy = [event("1"), event("2"), event("3")];
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: legacy } } }, maxPendingMessages: 2 });
  assert.equal((await f.scheduler.importLegacy("g")).backpressure.code, "PENDING_LIMIT");
  assert.equal((await f.scheduler.run())[0].status, "backpressure");
  assert.equal(f.calls, 0);
  assert.equal(job(f.live), undefined);
  assert.deepEqual(f.live.groups.g.pendingMemoryMessages, legacy);
  const limited = fixture({ maxKnownMessages: 1 });
  await limited.scheduler.enqueue("g", event("1"));
  await limited.scheduler.run();
  assert.equal((await limited.scheduler.enqueue("g", event("2"))).backpressure.code, "KNOWN_LIMIT");
  assert.equal((await limited.scheduler.enqueue("g", event("1"))).duplicates, 1);
});

test("enqueue/import failures reject safely, never report durable acceptance", async () => {
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: [event("legacy")] } } } });
  f.failSave();
  await assert.rejects(f.scheduler.enqueue("g", event("new")), { code: "MEMORY_JOB_ENQUEUE_FAILED" });
  assert.equal(job(f.live), undefined);
  f.failSave();
  await assert.rejects(f.scheduler.importLegacy("g"), { code: "MEMORY_JOB_IMPORT_FAILED" });
  assert.equal(job(f.live), undefined);
  assert.equal((await f.scheduler.importLegacy("g")).accepted, 1);
  assert.equal((await f.scheduler.importLegacy("g")).duplicates, 1);
});

test("process cannot mutate scheduler's retained batch or inputs; null candidate ACK is durable", async () => {
  const f = fixture({ process: ({ batch, messages }) => {
    batch.id = "incorrect"; batch.keys.length = 0; messages[0].message_id = "incorrect";
    return null;
  } });
  await f.scheduler.enqueue("g", event("1"));
  const [result] = await f.scheduler.run();
  assert.equal(result.status, "committed");
  assert.equal(result.count, 1);
  assert.equal(job(f.live).messages.length, 0);
  assert.equal(job(f.live).acknowledged.length, 1);
  assert.equal(await f.scheduler.retry("g"), false);
});

test("throwing/async dynamic size is a config failure, not a permanently blocked batch", async () => {
  let mode = "throw";
  const f = fixture({ batchSize: () => {
    if (mode === "throw") throw privateError();
    if (mode === "async") return Promise.reject(privateError());
    return 1;
  } });
  await f.scheduler.enqueue("g", event("1"));
  const before = copy(job(f.live));
  for (mode of ["throw", "async"]) {
    const [result] = await f.scheduler.run();
    assert.equal(result.code, "MEMORY_JOB_BATCH_SIZE_INVALID");
    assert.deepEqual(job(f.live), before);
    assert.equal(f.calls, 0);
  }
  mode = "valid";
  assert.equal((await f.scheduler.run())[0].status, "committed");
});

test("failed durable retry keeps gate; repeated model failures retain batch and increment counts", async () => {
  const f = fixture({ process: () => { throw privateError(); } });
  await f.scheduler.enqueue("g", event("1"));
  await f.scheduler.run();
  const batch = copy(job(f.live).batch);
  f.failSave();
  await assert.rejects(f.scheduler.retry("g"), { code: "MEMORY_JOB_RETRY_FAILED" });
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  assert.deepEqual(job(f.live).batch, batch);
  await f.scheduler.retry("g");
  await f.scheduler.run();
  assert.equal(job(f.live).batch.id, batch.id);
  assert.equal(job(f.live).batch.attempts, 2);
  assert.equal(job(f.live).batch.failures, 2);
});

test("suspend storage failure preserves batch/attempt and requires explicit retry", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise });
  await f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  f.enable(false);
  f.failSave();
  model.resolve(null);
  const [result] = await sweep;
  assert.equal(result.stage, "suspend");
  assert.equal(result.failurePersisted, true);
  assert.equal(job(f.live).batch.attempts, 1);
  assert.equal(job(f.live).batch.retryRequired, true);
  assert.equal(job(f.live).acknowledged.length, 0);
  assert.equal(f.patches, 0);
  f.enable(true);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  await f.scheduler.retry("g");
  assert.equal((await f.scheduler.run())[0].attempts, 2);
});

test("applyResult reaches success metrics ONLY after durable save/publication, as a detached snapshot", async () => {
  const model = deferred();
  const returned = { count: 1, codes: ["SYNTHETIC_APPLIED"] };
  const f = fixture({ process: () => model.promise, apply: draft => {
    draft.groups.g.applied = true;
    return returned;
  } });
  await f.scheduler.enqueue("g", event("1"));
  let delivered = null;
  let metric = 0;
  const sweep = f.scheduler.run();
  const observation = sweep.then(results => {
    delivered = results;
    for (const result of results) if (result.status === "committed") metric += result.applyResult.count;
  });
  await tick();
  const save = f.holdSave();
  model.resolve({ facts: ["candidate is NOT the return value"] });
  await tick();
  assert.equal(f.patches, 1, "apply ran speculatively inside the draft transaction");
  assert.equal(delivered, null);
  assert.equal(metric, 0);
  assert.equal(f.live.groups.g.applied, undefined);
  assert.equal(job(f.durable).acknowledged.length, 0);
  returned.count = 99;
  returned.codes.push("SYNTHETIC_MUTATION_AFTER_RETURN");
  save.resolve();
  await observation;
  assert.equal(delivered[0].status, "committed");
  assert.deepEqual(delivered[0].applyResult, { count: 1, codes: ["SYNTHETIC_APPLIED"] });
  assert.equal(metric, 1);
  assert.equal(f.durable.groups.g.applied, true);
  assert.equal(job(f.durable).acknowledged.length, 1);
  assert.equal(Object.hasOwn(job(f.durable), "applyResult"), false);
});

test("failed durable commit never exposes applyResult or increments success metrics; retry counts once", async () => {
  const model = deferred();
  const f = fixture({ process: () => model.promise, apply: () => ({ count: 1, codes: ["SYNTHETIC_APPLIED"] }) });
  await f.scheduler.enqueue("g", event("1"));
  let metric = 0;
  const consume = results => {
    for (const result of results) if (result.status === "committed") metric += result.applyResult.count;
    return results;
  };
  const sweep = f.scheduler.run().then(consume);
  await tick();
  f.failSave();
  model.resolve(null);
  const [failed] = await sweep;
  assert.equal(f.patches, 1);
  assert.equal(failed.status, "failed");
  assert.equal(Object.hasOwn(failed, "applyResult"), false);
  assert.equal(metric, 0);
  assert.equal(job(f.durable).acknowledged.length, 0);
  await f.scheduler.retry("g");
  const [success] = consume(await f.scheduler.run());
  assert.equal(success.status, "committed");
  assert.equal(f.patches, 2);
  assert.equal(metric, 1);
});

test("applyResult accepts arbitrary strict JSON, normalizes undefined, rejects invalid returns without ACK", async () => {
  for (const returned of [undefined, null, 0, false, "", ["SYNTHETIC_OK"], { count: 2, codes: [] }]) {
    const f = fixture({ apply: () => returned });
    await f.scheduler.enqueue("g", event("1"));
    const [result] = await f.scheduler.run();
    assert.equal(result.status, "committed");
    assert.deepEqual(result.applyResult, returned === undefined ? null : returned);
    assert.equal(job(f.durable).acknowledged.length, 1);
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const returned of [NaN, Infinity, new Date(), { count: undefined }, cyclic]) {
    const f = fixture({ apply: draft => { draft.groups.g.applied = true; return returned; } });
    await f.scheduler.enqueue("g", event("1"));
    const [result] = await f.scheduler.run();
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "commit");
    assert.equal(result.code, "MEMORY_JOB_NON_JSON");
    assert.equal(Object.hasOwn(result, "applyResult"), false);
    assert.equal(f.durable.groups.g.applied, undefined);
    assert.equal(job(f.durable).acknowledged.length, 0);
    assert.equal(job(f.durable).batch.retryRequired, true);
  }
  const f = fixture();
  await f.scheduler.enqueue("g", event("1"));
  f.enable(false);
  const [disabled] = await f.scheduler.run();
  assert.equal(disabled.status, "disabled");
  assert.equal(Object.hasOwn(disabled, "applyResult"), false);
  assert.equal(f.patches, 0);
});

test("single-lane setting and one failed conversation do not block an independent commit", async () => {
  let inFlight = 0;
  let peak = 0;
  const f = fixture({ concurrency: 1, process: async ({ conversationId }) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    if (conversationId === "bad") throw privateError();
    return null;
  } });
  await f.scheduler.enqueue("bad", event("1"));
  await f.scheduler.enqueue("good", event("1"));
  const results = await f.scheduler.run();
  assert.deepEqual(results.map(result => result.status), ["failed", "committed"]);
  assert.equal(peak, 1);
  assert.equal(job(f.live, "bad").batch.retryRequired, true);
  assert.equal(job(f.live, "good").acknowledged.length, 1);
});

for (const [name, run] of tests) {
  await run();
  console.log(`PASS ${name}`);
}
console.log(`PASS ${tests.length} async durable extraction tests (synthetic only)`);
