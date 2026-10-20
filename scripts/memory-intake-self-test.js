import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryIntake } from "../src/memory-intake.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-intake-"));
const repository = new BackgroundMemoryRepository({ filePath: path.join(home, "memory.json") });
const runtime = new MemoryRuntime(repository);
const intake = new MemoryIntake({ transact: build => runtime.transact(build) });
try {
  const memory = await runtime.open();
  const inputs = Array.from({ length: 70 }, (_, id) => intake.enqueue(draft => {
    (draft.groups.g ||= { messages: [] }).messages.push(id); return id;
  }));
  assert.equal(memory.groups.g, undefined, "input is not published before durability");
  assert.equal(intake.status().pendingMessages, 70);
  assert.deepEqual(await Promise.all(inputs), Array.from({ length: 70 }, (_, id) => id));
  assert.deepEqual(memory.groups.g.messages, Array.from({ length: 70 }, (_, id) => id));
  assert.equal(intake.status().committedBatches, 5, "burst coalesces instead of 70 full snapshots");
  await intake.enqueue(draft => { draft.groups.g.messages.push("chain-1"); })
    .then(() => intake.enqueue(draft => { draft.groups.g.messages.push("chain-2"); }));
  assert.deepEqual(memory.groups.g.messages.slice(-2), ["chain-1", "chain-2"], "completion continuations cannot strand a new batch");
  const invalid = [intake.enqueue(draft => { draft.groups.g.messages.push("must rollback"); }),
    intake.enqueue(() => { throw Error("untrusted-error-content"); })];
  const results = await Promise.allSettled(invalid);
  assert(results.every(item => item.status === "rejected" && item.reason.code === "MEMORY_INTAKE_COMMIT_FAILED"));
  assert(!memory.groups.g.messages.includes("must rollback"), "failed batch is all-or-nothing");
  await assert.rejects(intake.enqueue(async () => {}), { code: "MEMORY_ASYNC_MUTATOR" });
  const later = intake.enqueue(draft => { draft.groups.g.messages.push("later"); });
  await runtime.transact(draft => { draft.groups.g.control = "independent control"; });
  await intake.close(); await later;
  assert.equal(memory.groups.g.control, "independent control");
  assert.equal(memory.groups.g.messages.at(-1), "later");
  assert.deepEqual((await repository.read()).value, memory);
  await assert.rejects(intake.enqueue(() => {}), { code: "MEMORY_INTAKE_CLOSED" });
  const limited = new MemoryIntake({ transact: build => runtime.transact(build), batchSize: 1, maxPending: 1 });
  const accepted = limited.enqueue(() => {});
  await assert.rejects(limited.enqueue(() => {}), { code: "MEMORY_INTAKE_FULL" });
  await limited.close(); await accepted;
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, inputs: 70, durableBatches: 5,
    checks: "commit-before-publish, ordered coalescing, atomic failure, source-safe errors, controls, close, backpressure" }));
} finally {
  await intake.close(); await runtime.close(); fs.rmSync(home, { recursive: true, force: true });
}
