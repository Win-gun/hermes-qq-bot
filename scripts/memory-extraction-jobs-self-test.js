// Entirely synthetic: no filesystem, live config, repository, model, or network.
import assert from "node:assert/strict";
import {
  createMemoryExtractionState, memoryMessageKey, memoryEventTime,
  enqueueMemoryMessages, prepareMemoryBatch, claimMemoryBatch,
  acknowledgeMemoryBatch, failMemoryBatch, retryMemoryBatch,
  recoverMemoryExtraction, createMemoryExtractionScheduler
} from "../src/memory-extraction-jobs.js";

const copy = value => structuredClone(value);
const event = (id, time = 123) => ({ message_id: id, time, text: `synthetic-${id}`, user_id: "test-user" });
const job = (root, id = "g") => root.groups[id].memoryExtractionJobs;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(options = {}) {
  let current = copy(options.root || { groups: {} });
  let durable = copy(current);
  let enabled = true;
  let outage = false;
  let calls = 0;
  const history = [];
  const faults = new Map();
  const apply = (draft, meta) => {
    const remaining = faults.get(meta.phase) || 0;
    if (outage || remaining) {
      if (remaining) faults.set(meta.phase, remaining - 1);
      throw new Error("synthetic storage failure; must not leak into job metadata");
    }
    // Durable write succeeds BEFORE publishing a new whole live root.
    durable = copy(draft);
    current = copy(draft);
    history.push({ ...meta, root: copy(draft) });
  };
  const make = () => createMemoryExtractionScheduler({
    getState: () => current,
    persist: apply,
    isEnabled: id => enabled && (options.isEnabled?.(id) ?? true),
    process: context => {
      calls++;
      assert.equal(job(durable, context.conversationId).batch.status, "running", "claim must be durable before model");
      assert.equal(job(durable, context.conversationId).batch.id, context.batch.id);
      return options.process ? options.process(context) : { facts: [context.batch.id] };
    },
    commit: args => {
      if (options.commit) return options.commit(args, apply);
      const { draft, candidate, conversationId } = args;
      draft.groups[conversationId].facts ||= [];
      if (candidate) draft.groups[conversationId].facts.push(...candidate.facts);
      apply(draft, { phase: "commit", conversationId });
    },
    batchSize: options.batchSize ?? 2,
    concurrency: options.concurrency ?? 2,
    maxPendingMessages: options.maxPendingMessages ?? 1024,
    maxKnownMessages: options.maxKnownMessages ?? 100000
  });
  let scheduler = make();
  return {
    get scheduler() { return scheduler; },
    get current() { return current; }, get durable() { return durable; },
    get calls() { return calls; }, history,
    fail: (phase, count = 1) => faults.set(phase, count),
    outage: value => { outage = value; }, enable: value => { enabled = value; },
    replace: root => { current = copy(root); durable = copy(root); },
    restart: () => { current = copy(durable); scheduler = make(); return scheduler.recover(); }
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("pure helpers, JSON roundtrip and immutable batch membership", () => {
  const initial = createMemoryExtractionState();
  const result = enqueueMemoryMessages(initial, "g", [event("1"), event("2")]);
  assert.equal(initial.messages.length, 0);
  const snapshot = copy(result.state);
  const prepared = prepareMemoryBatch(result.state, "g", 1);
  const claimed = claimMemoryBatch(prepared);
  assert.deepEqual(result.state, snapshot);
  assert.equal(prepared.batch.attempts, 0);
  const withNew = enqueueMemoryMessages(claimed, "g", [event("3")]).state;
  const ack = acknowledgeMemoryBatch(withNew, claimed.batch.id);
  assert.deepEqual(ack.messages.map(m => m.input.message_id), ["2", "3"]);
  assert.equal(ack.acknowledged.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ack)), ack);
  assert.equal(withNew.messages.length, 3);
  assert.throws(() => acknowledgeMemoryBatch(withNew, "wrong"), /ownership/);
});

test("conversation + message ID idempotency before and after durable ACK", async () => {
  const f = fixture();
  assert.equal(f.scheduler.enqueue("g", event(0)).accepted, 1);
  assert.equal(f.scheduler.enqueue("g", { ...event("0"), text: "changed delivery" }).duplicates, 1);
  assert.equal(f.scheduler.enqueue("other", event("0")).accepted, 1);
  assert.equal((await f.scheduler.run()).filter(r => r.status === "committed").length, 2);
  f.restart();
  assert.equal(f.scheduler.enqueue("g", event(0)).duplicates, 1);
  assert.equal(f.calls, 2);
});

test("ID-less canonical fingerprint independent of key order and current clock", () => {
  const a = { text: "same", user_id: "u", nested: { b: 2, a: 1 } };
  const b = { nested: { a: 1, b: 2 }, user_id: "u", text: "same" };
  assert.equal(memoryMessageKey("g", a), memoryMessageKey("g", b));
  assert.notEqual(memoryMessageKey("h", a), memoryMessageKey("g", a));
  const f = fixture();
  f.scheduler.enqueue("g", a);
  assert.equal(f.scheduler.enqueue("g", b).duplicates, 1);
  assert.equal(job(f.current).messages[0].eventTimeMs, null);
});

test("event times are source times, including epoch; never receive/processing time", () => {
  assert.equal(memoryEventTime({ time: 10, receivedAt: "2099-01-01" }), 10000);
  assert.equal(memoryEventTime({ sentAtMs: 0, time: 10 }), 0);
  assert.equal(memoryEventTime({ sentAt: "2020-01-01T00:00:00.000Z" }), 1577836800000);
  assert.equal(memoryEventTime({ at: "2020-01-01T00:00:00.000Z" }), 1577836800000);
  assert.equal(memoryEventTime({ sentAtMs: "bad", time: 5 }), 5000);
  assert.equal(memoryEventTime({ time: "bad", receivedAt: "2099-01-01" }), null);
});

test("legacy import is additive, durable, repeatable, and preserves original array", async () => {
  const legacy = [event("1"), { text: "old without ID", at: "2019-01-01T00:00:00Z" }, "old string"];
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: legacy, users: { u: { names: ["kept"] } } } } } });
  assert.equal(f.scheduler.importLegacy("g").accepted, 3);
  assert.deepEqual(f.current.groups.g.pendingMemoryMessages, legacy);
  assert.equal(f.scheduler.importLegacy("g").duplicates, 3);
  await f.scheduler.run();
  await f.scheduler.run();
  assert.equal(f.calls, 2);
  f.restart();
  await f.scheduler.run();
  assert.equal(f.calls, 2);
  assert.deepEqual(f.current.groups.g.pendingMemoryMessages, legacy);
  assert.deepEqual(f.current.groups.g.users.u.names, ["kept"]);
  assert.equal(job(f.current).acknowledged.length, 3);
});

test("pending limit is explicit backpressure, no FIFO trimming", () => {
  const f = fixture({ maxPendingMessages: 2 });
  f.scheduler.enqueue("g", event("1"));
  f.scheduler.enqueue("g", event("2"));
  const before = copy(f.current);
  const result = f.scheduler.enqueue("g", event("3"));
  assert.equal(result.accepted, 0);
  assert.equal(result.backpressure.code, "PENDING_LIMIT");
  assert.deepEqual(f.current, before);
  assert.equal(f.scheduler.enqueue("g", event("1")).duplicates, 1);
});

test("oversized legacy queue remains completely intact on backpressure", async () => {
  const legacy = [event("1"), event("2"), event("3")];
  const f = fixture({ maxPendingMessages: 2, root: { groups: { g: { pendingMemoryMessages: legacy } } } });
  assert.equal(f.scheduler.importLegacy("g").backpressure.code, "PENDING_LIMIT");
  assert.equal((await f.scheduler.run())[0].status, "backpressure");
  assert.deepEqual(f.current.groups.g.pendingMemoryMessages, legacy);
  assert.equal(f.calls, 0);
  assert.equal(f.current.groups.g.memoryExtractionJobs, undefined);
});

test("dedup ledger limit never silently evicts acknowledged IDs", async () => {
  const f = fixture({ maxKnownMessages: 2 });
  f.scheduler.enqueue("g", event("1"));
  await f.scheduler.run();
  f.scheduler.enqueue("g", event("2"));
  await f.scheduler.run();
  assert.equal(f.scheduler.enqueue("g", event("3")).backpressure.code, "KNOWN_LIMIT");
  assert.equal(f.scheduler.enqueue("g", event("1")).duplicates, 1);
  assert.equal(job(f.durable).acknowledged.length, 2);
});

test("ingestion persistence failure is not reported accepted", () => {
  const f = fixture();
  f.fail("enqueue");
  assert.throws(() => f.scheduler.enqueue("g", event("1")), /synthetic storage/);
  assert.deepEqual(f.current, { groups: {} });
  assert.equal(f.scheduler.enqueue("g", event("1")).accepted, 1);
});

test("prepare persistence failure retains batch and requires explicit retry", async () => {
  const f = fixture();
  f.scheduler.enqueue("g", event("1"));
  f.fail("prepare");
  const [result] = await f.scheduler.run();
  assert.equal(result.stage, "prepare");
  assert.equal(f.calls, 0);
  const id = job(f.current).batch.id;
  assert.equal(job(f.current).batch.attempts, 0);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  f.scheduler.retry("g");
  assert.equal((await f.scheduler.run())[0].batchId, id);
});

test("claimpersistfail: no model before durable claim; exact batch / attempt retained", async () => {
  const f = fixture();
  f.scheduler.enqueue("g", event("1"));
  f.fail("claim");
  const [result] = await f.scheduler.run();
  assert.equal(result.stage, "claim");
  assert.equal(result.failurePersisted, true);
  assert.equal(f.calls, 0);
  const before = copy(job(f.durable).batch);
  assert.equal(before.status, "pending");
  assert.equal(before.attempts, 1);
  assert.equal(before.retryRequired, true);
  for (let i = 0; i < 5; i++) assert.equal((await f.scheduler.run())[0].status, "retry_required");
  assert.equal(f.calls, 0);
  assert.equal(f.scheduler.retry("g"), true);
  const [retried] = await f.scheduler.run();
  assert.equal(retried.batchId, before.id);
  assert.equal(retried.attempts, 2);
});

test("processfail: async rejection stays pending; restart does not unlock failed jobs", async () => {
  let fail = true;
  const f = fixture({ process: async () => {
    if (fail) throw new Error("synthetic private model error");
    return { facts: ["ok"] };
  } });
  f.scheduler.enqueue("g", event("1"));
  f.scheduler.enqueue("g", event("2"));
  const [failed] = await f.scheduler.run();
  assert.equal(failed.stage, "process");
  const batch = copy(job(f.durable).batch);
  assert.equal(batch.failures, 1);
  assert.equal(JSON.stringify(batch).includes("private"), false);
  assert.equal(f.restart(), 0);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  fail = false;
  f.scheduler.retry("g");
  const [success] = await f.scheduler.run();
  assert.equal(success.batchId, batch.id);
  assert.equal(success.attempts, 2);
  assert.equal(job(f.current).messages.length, 0);
});

test("commitfail: draft patch and ACK are both rolled back, then atomically committed", async () => {
  const f = fixture();
  f.scheduler.enqueue("g", event("1"));
  f.fail("commit");
  const [failed] = await f.scheduler.run();
  assert.equal(failed.stage, "commit");
  assert.equal(f.current.groups.g.facts, undefined);
  assert.equal(job(f.current).acknowledged.length, 0);
  assert.equal(job(f.current).messages.length, 1);
  const id = job(f.current).batch.id;
  f.scheduler.retry("g");
  await f.scheduler.run();
  assert.deepEqual(f.current.groups.g.facts, [id]);
  const saved = f.history.filter(h => h.phase === "commit");
  assert.equal(saved.length, 1);
  assert.equal(job(saved[0].root).acknowledged.length, 1);
  assert.equal(job(saved[0].root).batch, null);
});

test("full storage outage never spins and retry flushes retained attempt metadata", async () => {
  const f = fixture();
  f.scheduler.enqueue("g", event("1"));
  f.outage(true);
  const [failed] = await f.scheduler.run();
  assert.equal(failed.failurePersisted, false);
  assert.equal(f.calls, 0);
  const id = failed.batchId;
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  assert.throws(() => f.scheduler.retry("g"), /storage/);
  f.outage(false);
  f.scheduler.retry("g");
  assert.equal(job(f.durable).batch.id, id);
  await f.scheduler.run();
  assert.equal(f.calls, 1);
});

test("failed claim + failed failure-save retain claimed attempt count until explicit retry", async () => {
  const f = fixture();
  f.scheduler.enqueue("g", event("1"));
  f.fail("claim");
  f.fail("failure");
  const [failed] = await f.scheduler.run();
  assert.equal(failed.stage, "claim");
  assert.equal(failed.failurePersisted, false);
  assert.equal(job(f.durable).batch.attempts, 0);
  f.scheduler.retry("g");
  assert.equal(job(f.durable).batch.attempts, 1);
  assert.equal(job(f.durable).batch.failures, 1);
  const [success] = await f.scheduler.run();
  assert.equal(success.attempts, 2);
});

test("restart: orphaned running becomes pending with same batch ID and inputs", async () => {
  const prepared = prepareMemoryBatch(enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1"), event("2")]).state, "g", 1);
  const running = claimMemoryBatch(prepared);
  const f = fixture({ root: { groups: { g: { memoryExtractionJobs: running } } } });
  assert.equal((await f.scheduler.run())[0].status, "recovery_required");
  assert.equal(f.scheduler.recover(), 1);
  assert.equal(f.scheduler.recover(), 0);
  assert.equal(job(f.durable).batch.status, "pending");
  assert.equal(job(f.durable).batch.id, running.batch.id);
  assert.deepEqual(job(f.durable).batch.keys, running.batch.keys);
  const [success] = await f.scheduler.run();
  assert.equal(success.attempts, 2);
  assert.equal(success.batchId, running.batch.id);
  assert.deepEqual(job(f.current).messages.map(m => m.input.message_id), ["2"]);
});

test("recover persistence failure leaves durable running unchanged", () => {
  const running = claimMemoryBatch(prepareMemoryBatch(enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1")]).state, "g"));
  const f = fixture({ root: { groups: { g: { memoryExtractionJobs: running } } } });
  f.fail("recover");
  assert.throws(() => f.scheduler.recover(), /storage/);
  assert.equal(job(f.durable).batch.status, "running");
  assert.equal(f.scheduler.recover(), 1);
});

test("recovery adapter must publish, not merely return success", () => {
  const running = claimMemoryBatch(prepareMemoryBatch(enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1")]).state, "g"));
  const root = { groups: { g: { memoryExtractionJobs: running } } };
  const scheduler = createMemoryExtractionScheduler({
    getState: () => root, persist: () => {}, process: () => null, commit: () => {}
  });
  assert.throws(() => scheduler.recover(), /publish/);
  assert.equal(job(root).batch.status, "running");
});

test("commit adapter cannot silently return success without publishing ACK", async () => {
  const f = fixture({ commit: () => {} });
  f.scheduler.enqueue("g", event("1"));
  const [result] = await f.scheduler.run();
  assert.equal(result.status, "failed");
  assert.equal(result.stage, "commit");
  assert.equal(job(f.durable).messages.length, 1);
  assert.equal(job(f.durable).acknowledged.length, 0);
  assert.equal(job(f.durable).batch.retryRequired, true);
});

test("two lanes, one per conversation, overlapping run calls share one sweep", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const contexts = [];
  const inFlight = new Set();
  let peak = 0;
  const f = fixture({ batchSize: 1, process: async context => {
    assert.equal(inFlight.has(context.conversationId), false);
    inFlight.add(context.conversationId);
    peak = Math.max(peak, inFlight.size);
    const index = contexts.push(context) - 1;
    await gates[index].promise;
    inFlight.delete(context.conversationId);
    return { facts: ["ok"] };
  } });
  for (const id of ["a", "b", "c"]) {
    f.scheduler.enqueue(id, event("1"));
    f.scheduler.enqueue(id, event("2"));
  }
  const sweep = f.scheduler.run();
  assert.equal(f.scheduler.run(), sweep);
  await tick();
  assert.equal(contexts.length, 2);
  assert.equal(peak, 2);
  assert.throws(() => f.scheduler.retry("a"), /active/);
  assert.throws(() => f.scheduler.recover(), /active/);
  gates[0].resolve();
  await tick();
  assert.equal(contexts.length, 3);
  assert.equal(peak, 2);
  gates[1].resolve();
  gates[2].resolve();
  const results = await sweep;
  assert.equal(results.length, 3);
  for (const id of ["a", "b", "c"]) assert.equal(job(f.current, id).messages.length, 1);
});

test("concurrent new input + root replacement survive old batch ACK", async () => {
  const gate = deferred();
  const f = fixture({ batchSize: 1, process: () => gate.promise });
  f.scheduler.enqueue("g", event("old", 100));
  const oldRoot = f.current;
  const sweep = f.scheduler.run();
  await tick();
  f.scheduler.enqueue("g", event("new", 200));
  f.scheduler.enqueue("other", event("unrelated", 300));
  assert.notEqual(f.current, oldRoot);
  gate.resolve({ facts: ["candidate"] });
  await sweep;
  assert.deepEqual(job(f.current).messages.map(m => m.input.message_id), ["new"]);
  assert.equal(job(f.current, "other").messages.length, 1);
  assert.deepEqual(f.current.groups.g.facts, ["candidate"]);
});

test("lateevents: older event time arriving during processing is not removed by ACK", async () => {
  const gate = deferred();
  const seen = [];
  const f = fixture({ process: context => { seen.push(context.messages); return seen.length === 1 ? gate.promise : null; } });
  f.scheduler.enqueue("g", event("recent", 200));
  const sweep = f.scheduler.run();
  await tick();
  f.scheduler.enqueue("g", event("late", 10));
  gate.resolve(null);
  await sweep;
  assert.equal(job(f.current).messages[0].eventTimeMs, 10000);
  await f.scheduler.run();
  assert.equal(seen[1][0].message_id, "late");
  assert.equal(job(f.current).acknowledged.length, 2);
});

test("disabled pauses processing but accepts new and preserves legacy input", async () => {
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: [event("legacy")] } } } });
  f.enable(false);
  f.scheduler.enqueue("g", event("new"));
  const before = copy(f.current);
  assert.equal((await f.scheduler.run())[0].status, "disabled");
  assert.deepEqual(f.current, before);
  assert.equal(f.calls, 0);
  f.enable(true);
  await f.scheduler.run();
  assert.equal(job(f.current).acknowledged.length, 2);
});

test("disabled during process: discard candidate, preserve exact batch for later", async () => {
  const gate = deferred();
  const f = fixture({ process: () => gate.promise });
  f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  const id = job(f.current).batch.id;
  f.enable(false);
  gate.resolve({ facts: ["must not commit while disabled"] });
  assert.equal((await sweep)[0].status, "disabled");
  assert.equal(job(f.current).batch.id, id);
  assert.equal(job(f.current).batch.status, "pending");
  assert.equal(job(f.current).acknowledged.length, 0);
  assert.equal(f.current.groups.g.facts, undefined);
  f.enable(true);
  await f.scheduler.run();
  assert.equal(f.calls, 2);
});

test("disabled immediately after durable claim never calls model", async () => {
  let checks = 0;
  const f = fixture({ isEnabled: () => ++checks !== 2 });
  f.scheduler.enqueue("g", event("1"));
  assert.equal((await f.scheduler.run())[0].status, "disabled");
  assert.equal(f.calls, 0);
  assert.equal(job(f.durable).batch.status, "pending");
  assert.equal(job(f.durable).batch.attempts, 1);
  const id = job(f.durable).batch.id;
  assert.equal((await f.scheduler.run())[0].batchId, id);
  assert.equal(f.calls, 1);
});

test("failed suspension persists retry gate and does not ACK candidate", async () => {
  let checks = 0;
  const f = fixture({ isEnabled: () => ++checks !== 2 });
  f.scheduler.enqueue("g", event("1"));
  f.fail("suspend");
  const [result] = await f.scheduler.run();
  assert.equal(result.stage, "suspend");
  assert.equal(f.calls, 0);
  assert.equal(job(f.durable).batch.retryRequired, true);
  assert.equal(job(f.durable).acknowledged.length, 0);
  f.scheduler.retry("g");
  await f.scheduler.run();
  assert.equal(f.calls, 1);
});

test("sync model, no-op candidate and no-op patch still persist ACK", async () => {
  const f = fixture({ process: () => null });
  f.scheduler.enqueue("g", event("1"));
  assert.equal((await f.scheduler.run())[0].status, "committed");
  assert.equal(f.history.filter(h => h.phase === "commit").length, 1);
  assert.equal(job(f.durable).acknowledged.length, 1);
});

test("invalid candidate rejects rather than consumes input", async () => {
  const f = fixture({ process: () => undefined });
  f.scheduler.enqueue("g", event("1"));
  assert.equal((await f.scheduler.run())[0].stage, "process");
  assert.equal(job(f.current).messages.length, 1);
  assert.equal(job(f.current).batch.retryRequired, true);
});

test("repeated process failures preserve batch ID, attempt and failure counters", async () => {
  const f = fixture({ process: () => { throw new Error("synthetic"); } });
  f.scheduler.enqueue("g", event("1"));
  let id;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [result] = await f.scheduler.run();
    id ||= result.batchId;
    assert.equal(result.batchId, id);
    assert.equal(job(f.durable).batch.attempts, attempt);
    assert.equal(job(f.durable).batch.failures, attempt);
    assert.equal(job(f.durable).messages.length, 1);
    if (attempt < 3) f.scheduler.retry("g");
  }
  f.fail("retry");
  assert.throws(() => f.scheduler.retry("g"), /storage/);
  assert.equal(job(f.durable).batch.retryRequired, true);
  assert.equal((await f.scheduler.run())[0].status, "retry_required");
  assert.equal(f.calls, 3);
});

test("one failed lane cannot prevent other conversations committing", async () => {
  const f = fixture({ process: ({ conversationId }) => {
    if (conversationId === "bad") throw new Error("synthetic process failure");
    return null;
  } });
  for (const id of ["bad", "good", "next"]) f.scheduler.enqueue(id, event("1"));
  const results = await f.scheduler.run();
  assert.equal(results.find(r => r.conversationId === "bad").status, "failed");
  for (const id of ["good", "next"]) assert.equal(job(f.durable, id).acknowledged.length, 1);
  assert.equal(job(f.durable, "bad").messages.length, 1);
});

test("a throwing enabled gate is isolated from the other lane", async () => {
  const f = fixture({ isEnabled: id => {
    if (id === "bad") throw new Error("synthetic config failure");
    return true;
  } });
  f.scheduler.enqueue("bad", event("1"));
  f.scheduler.enqueue("good", event("1"));
  const results = await f.scheduler.run();
  assert.equal(results.find(r => r.conversationId === "bad").status, "failed");
  assert.equal(results.find(r => r.conversationId === "good").status, "committed");
  assert.equal(f.calls, 1);
});

test("late root mutations and fresh pending input survive a commit failure and retry", async () => {
  const gate = deferred();
  const f = fixture({ process: () => gate.promise });
  f.scheduler.enqueue("g", event("1"));
  const sweep = f.scheduler.run();
  await tick();
  const latest = copy(f.current);
  latest.groups.g.externalSetting = "must survive";
  f.replace(latest);
  f.scheduler.enqueue("g", event("2"));
  f.fail("commit");
  gate.resolve({ facts: ["new patch"] });
  await sweep;
  assert.equal(job(f.current).messages.length, 2);
  assert.equal(f.current.groups.g.externalSetting, "must survive");
  const pinned = copy(job(f.current).batch.keys);
  f.scheduler.retry("g");
  await f.scheduler.run();
  assert.deepEqual(job(f.current).acknowledged, pinned);
  assert.deepEqual(job(f.current).messages.map(m => m.input.message_id), ["2"]);
  assert.equal(f.current.groups.g.externalSetting, "must survive");
});

test("disabled per conversation and single-lane option retain independent state", async () => {
  const f = fixture({ concurrency: 1, isEnabled: id => id !== "off" });
  f.scheduler.enqueue("off", event("1"));
  f.scheduler.enqueue("on", event("1"));
  const results = await f.scheduler.run();
  assert.equal(results.find(r => r.conversationId === "off").status, "disabled");
  assert.equal(results.find(r => r.conversationId === "on").status, "committed");
  assert.equal(job(f.current, "off").messages.length, 1);
});

test("helper retry/recovery preserve last failure and reject invalid state", () => {
  const initial = createMemoryExtractionState();
  assert.equal(recoverMemoryExtraction(initial), initial);
  let state = enqueueMemoryMessages(initial, "g", [event("1")]).state;
  state = claimMemoryBatch(prepareMemoryBatch(state, "g"));
  const failed = failMemoryBatch(state, state.batch, "process");
  assert.equal(claimMemoryBatch(failed), failed);
  const retried = retryMemoryBatch(failed);
  assert.equal(retried.batch.attempts, 1);
  assert.equal(retried.batch.failures, 1);
  assert.deepEqual(retried.batch.lastFailure, failed.batch.lastFailure);
  assert.throws(() => prepareMemoryBatch({ ...initial, version: 99 }, "g"), /version/);
  assert.throws(() => memoryMessageKey("g", { value: NaN }), /JSON/);
  assert.throws(() => memoryMessageKey("g", { value: undefined }), /JSON/);
  assert.throws(() => memoryMessageKey("g", { message_id: {} }), /message ID/);
});

test("corrupt state and malformed legacy fail closed rather than resetting backlog", async () => {
  const initial = enqueueMemoryMessages(createMemoryExtractionState(), "g", [event("1")]).state;
  const duplicate = copy(initial);
  duplicate.messages.push(copy(initial.messages[0]));
  assert.throws(() => enqueueMemoryMessages(duplicate, "g", []), /pending message/);
  const overlapping = copy(initial);
  overlapping.acknowledged.push(initial.messages[0].key);
  assert.throws(() => prepareMemoryBatch(overlapping, "g"), /ACK/);
  const brokenBatch = prepareMemoryBatch(initial, "g");
  brokenBatch.batch.keys.push("nonexistent");
  assert.throws(() => claimMemoryBatch(brokenBatch), /batch/);
  const f = fixture({ root: { groups: { g: { pendingMemoryMessages: "not an array" } } } });
  assert.throws(() => f.scheduler.importLegacy("g"), /array/);
  assert.equal((await f.scheduler.run())[0].status, "failed");
  assert.equal(f.calls, 0);
  assert.equal(f.current.groups.g.pendingMemoryMessages, "not an array");
});

test("special conversation IDs are own properties, never prototype setters", async () => {
  const f = fixture();
  f.scheduler.enqueue("__proto__", event("1"));
  await f.scheduler.run();
  assert.equal(Object.hasOwn(f.current.groups, "__proto__"), true);
  assert.equal(job(f.current, "__proto__").acknowledged.length, 1);
  assert.equal({}.memoryExtractionJobs, undefined);
});

test("limits and synchronous transaction adapter contracts fail closed", () => {
  const callbacks = { getState: () => ({ groups: {} }), persist: () => {}, process: () => null, commit: () => {} };
  assert.throws(() => createMemoryExtractionScheduler({ ...callbacks, concurrency: 3 }), /two/);
  assert.throws(() => createMemoryExtractionScheduler({ ...callbacks, batchSize: 0 }), /positive/);
  assert.throws(() => createMemoryExtractionScheduler({ ...callbacks, persist: async () => {} }), /synchronous/);
  const missingPublish = createMemoryExtractionScheduler(callbacks);
  assert.throws(() => missingPublish.enqueue("g", event("1")), /publish/);
  const thenableSave = createMemoryExtractionScheduler({ ...callbacks, persist: () => Promise.resolve() });
  assert.throws(() => thenableSave.enqueue("g", event("1")), /synchronous/);
  assert.equal(createMemoryExtractionScheduler(callbacks).retry("g"), false);
});

test("batchSize callback reads hot-reloaded value for each new batch", async () => {
  let size = 1;
  let reads = 0;
  const f = fixture({ batchSize: () => { reads++; return size; } });
  assert.equal(reads, 0, "do not capture the initial configuration");
  for (let i = 0; i < 6; i++) f.scheduler.enqueue("g", event(String(i)));
  assert.equal((await f.scheduler.run())[0].count, 1);
  size = 3;
  assert.equal((await f.scheduler.run())[0].count, 3);
  size = 2;
  assert.equal((await f.scheduler.run())[0].count, 2);
  assert.equal(reads, 3);
  await f.scheduler.run();
  assert.equal(reads, 3, "empty queue does not prepare a batch");
  assert.equal(job(f.durable).acknowledged.length, 6);
});

test("invalid runtime batchSize rejects prepare without losing or modifying data", async () => {
  let size;
  const f = fixture({ batchSize: () => size });
  for (let i = 0; i < 3; i++) f.scheduler.enqueue("g", event(String(i)));
  const before = copy(f.durable);
  const writes = f.history.length;
  for (size of [0, -1, 1.5, NaN, Infinity, "2", null, undefined, Number.MAX_SAFE_INTEGER + 1, Promise.resolve(2)]) {
    const [result] = await f.scheduler.run();
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "prepare");
    assert.equal(result.batchId, null);
    assert.deepEqual(f.current, before);
    assert.deepEqual(f.durable, before);
  }
  assert.equal(f.calls, 0);
  assert.equal(f.history.length, writes);
  size = 2;
  assert.equal((await f.scheduler.run())[0].count, 2);
  assert.equal(job(f.durable).messages.length, 1);
});

test("hot reload never resizes a pinned retry or recovered batch", async () => {
  let size = 2;
  let reads = 0;
  const f = fixture({ batchSize: () => { reads++; return size; } });
  for (let i = 0; i < 4; i++) f.scheduler.enqueue("g", event(String(i)));
  f.fail("claim");
  const [failed] = await f.scheduler.run();
  const keys = copy(job(f.durable).batch.keys);
  assert.equal(reads, 1);
  size = 0; // A temporarily invalid new setting must not damage an existing job.
  f.scheduler.retry("g");
  const [retried] = await f.scheduler.run();
  assert.equal(retried.batchId, failed.batchId);
  assert.equal(retried.count, 2);
  assert.deepEqual(job(f.durable).acknowledged, keys);
  assert.equal(reads, 1);
  const root = copy(f.durable);
  root.groups.g.memoryExtractionJobs = claimMemoryBatch(prepareMemoryBatch(job(root), "g", 1));
  const pinned = copy(job(root).batch);
  f.replace(root);
  f.restart();
  const [recovered] = await f.scheduler.run();
  assert.equal(recovered.batchId, pinned.id);
  assert.equal(recovered.count, 1);
  assert.equal(reads, 1);
  size = 1;
  assert.equal((await f.scheduler.run())[0].count, 1);
  assert.equal(reads, 2);
});

test("throwing batchSize callback leaves backlog intact until config is fixed", async () => {
  let broken = true;
  const f = fixture({ batchSize: () => {
    if (broken) throw new Error("synthetic config failure");
    return 1;
  } });
  f.scheduler.enqueue("g", event("1"));
  const before = copy(f.durable);
  assert.equal((await f.scheduler.run())[0].stage, "prepare");
  assert.deepEqual(f.durable, before);
  assert.equal(f.calls, 0);
  broken = false;
  assert.equal((await f.scheduler.run())[0].count, 1);
});

test("long synthetic backlog drains without loss across JSON restarts", async () => {
  const f = fixture({ batchSize: 7, maxPendingMessages: 250 });
  for (let i = 0; i < 103; i++) f.scheduler.enqueue("g", event(String(i), 1000 - i));
  let sweeps = 0;
  while (job(f.current).messages.length) {
    await f.scheduler.run();
    f.restart();
    assert.ok(++sweeps < 30);
  }
  assert.equal(sweeps, 15);
  assert.equal(job(f.current).acknowledged.length, 103);
  assert.equal(new Set(job(f.current).acknowledged).size, 103);
  for (let i = 0; i < 103; i++) assert.equal(f.scheduler.enqueue("g", event(String(i))).duplicates, 1);
});

for (const [name, fn] of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`memory-extraction-jobs: ${tests.length}/${tests.length} synthetic checks passed`);
