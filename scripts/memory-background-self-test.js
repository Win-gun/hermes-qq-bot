import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRepository, readMemorySnapshot } from "../src/memory-repository.js";
import { MemoryRuntime } from "../src/memory-runtime.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-memory-background-"));
const filePath = path.join(home, "data", "memory.json");
let checks = 0;
const check = (value, message) => { assert(value, message); checks += 1; };
const service = new BackgroundMemoryRepository({ filePath });
const runtime = new MemoryRuntime(service);
try {
  check(!fs.existsSync(path.dirname(filePath)), "construction is read-only");
  await assert.rejects(service.save({ groups: {} }), { code: "MEMORY_LOAD_REQUIRED" });
  const value = await runtime.open();
  assert.deepEqual(value, { groups: {} });
  check(service.status().writer && service.status().background, "one worker holds the real engine's writer ticket");
  const competitor = new MemoryRepository({ filePath });
  assert.throws(() => competitor.acquireWriter(), { code: "MEMORY_LOCKED" }); competitor.close();
  check(true, "offline writer cannot bypass background ownership");
  await runtime.transact(draft => { draft.groups.g = { users: {}, messages: [], settings: {} }; });
  const group = value.groups.g, messages = group.messages;
  const first = runtime.transact(draft => { draft.groups.g.messages.push("first"); return "first-result"; });
  const second = runtime.transact(draft => { draft.groups.g.messages.push("second"); });
  check(value.groups.g.messages.length === 0, "queued builders never mutate the published root");
  assert.equal(await first, "first-result"); await second;
  assert.deepEqual(messages, ["first", "second"]);
  check(value.groups.g === group && value.groups.g.messages === messages, "publication preserves cached references");
  assert.deepEqual(readMemorySnapshot(filePath), value);
  const revision = runtime.revision;
  await assert.rejects(runtime.transact(draft => { draft.groups.g.invalid = NaN; }), { code: "MEMORY_INVALID_JSON" });
  check(!Object.hasOwn(group, "invalid") && runtime.revision === revision, "failed draft is neither persisted nor published");
  await assert.rejects(runtime.transact(async draft => { draft.groups.g.invalid = "async"; }), { code: "MEMORY_ASYNC_MUTATOR" });
  await assert.rejects(runtime.transact(draft => { draft.groups.g.invalid = "promise"; return Promise.resolve(); }), { code: "MEMORY_ASYNC_MUTATOR" });
  check(!Object.hasOwn(group, "invalid"), "thenable builders cannot escape the transaction boundary");
  let invoked = false;
  const getter = { groups: {} };
  Object.defineProperty(getter.groups, "secret", { enumerable: true, get() { invoked = true; return "forbidden"; } });
  await assert.rejects(service.save(getter), { code: "MEMORY_INVALID_JSON" });
  check(!invoked, "request inspection never executes getters");
  await assert.rejects(runtime.transact(draft => {
    Object.defineProperty(draft.groups, "hiddenGetter", { enumerable: true,
      get() { invoked = true; return "forbidden"; } });
  }), { code: "MEMORY_INVALID_JSON" });
  check(!invoked && !Object.hasOwn(value.groups, "hiddenGetter"), "builder getters are rejected without execution or publication");
  await assert.rejects(service.save({ groups: {} }, { expectedRevision: "stale" }), { code: "MEMORY_CAS_MISMATCH" });
  check(service.status().writable, "a rejected CAS does not poison the writer");
  await runtime.transact(draft => { draft.groups.g.users.u = { profile: ["keep"] }; });
  const disk = await service.read();
  assert.deepEqual(disk.value, value); assert.equal(disk.revision, runtime.revision);
  check(true, "latest worker read and main published view are coherent");
  const assigned = { messages: ["submitted"] };
  let assignedByBuilder;
  const assignedStarted = new Promise(resolve => { assignedByBuilder = resolve; });
  const assignedSave = runtime.transact(draft => { draft.groups.assigned = assigned; assignedByBuilder(); });
  await assignedStarted;
  assigned.messages.push("never submitted");
  await assignedSave;
  assert.deepEqual(value.groups.assigned.messages, ["submitted"]);
  assert.deepEqual((await service.read()).value, value);
  check(true, "caller-owned builder input cannot mutate the snapshot being published");
  const beforeBackup = structuredClone(value), backupPath = `${filePath}.bak.fixture`;
  await runtime.transact(draft => { draft.groups.g.messages.push("after backup"); }, { backupPath });
  assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), beforeBackup);
  check((fs.statSync(backupPath).mode & 0o777) === 0o600, "worker rebuild backup contains the exact prior snapshot with private permissions");
  await assert.rejects(runtime.transact(draft => { draft.groups.g.messages.push("rejected"); },
    { backupPath: path.join(home, "outside.json") }), { code: "MEMORY_PATH_UNSAFE" });
  check(!value.groups.g.messages.includes("rejected"), "invalid backup targets cannot commit or publish a draft");
  await runtime.barrier(); await runtime.close(); await runtime.close();
  await assert.rejects(runtime.transact(() => {}), { code: "MEMORY_CLOSED" });
  check(service.status().closed && !service.status().writer, "graceful close flushes and releases the ticket");
  const reopened = new BackgroundMemoryRepository({ filePath });
  try {
    assert.deepEqual((await reopened.open()).value, value);
    const snapshot = { groups: { captured: { messages: ["before"] } } };
    const saved = reopened.save(snapshot);
    snapshot.groups.captured.messages.push("after");
    await saved;
    assert.deepEqual((await reopened.read()).value.groups.captured.messages, ["before"]);
    check(true, "input is captured before the save Promise returns");
  } finally { await reopened.close(); }
  const limited = new BackgroundMemoryRepository({ filePath, maxPending: 1 });
  await limited.open();
  const queued = limited.save({ groups: { captured: { messages: ["before", "flushed"] } } });
  const closing = limited.close();
  await queued; await closing;
  check((await readMemorySnapshot(filePath)).groups.captured.messages.length === 2,
    "close waits for a full pending request lane instead of abandoning the write");
  const supervised = new BackgroundMemoryRepository({ filePath });
  await supervised.open();
  const blockedPeer = new BackgroundMemoryRepository({ filePath });
  await assert.rejects(blockedPeer.open(), { code: "MEMORY_LOCKED" });
  await blockedPeer.close();
  check(supervised.status().writer, "closing a rejected sibling never removes this writer's ticket");
  const ambiguous = supervised.save({ groups: { captured: { messages: ["before", "flushed", "possibly committed"] } } });
  const rejected = assert.rejects(ambiguous, { code: "MEMORY_OPERATION_UNCERTAIN" });
  await supervised.terminate(); await rejected; await supervised.close();
  check(supervised.status().recoveryRequired, "forced stop never claims that an attempted write was canceled safely");
  const recovered = new BackgroundMemoryRepository({ filePath });
  try {
    const restored = await recovered.open();
    check(restored.value.groups.captured.messages.includes("flushed"),
      "proven terminated worker releases only its own ticket; same-process recovery preserves prior commits");
  } finally { await recovered.close(); }
  fs.writeFileSync(filePath, "{corrupt");
  const broken = new BackgroundMemoryRepository({ filePath });
  try { await assert.rejects(broken.open(), { code: "MEMORY_CORRUPT" }); }
  finally { await broken.close(); }
  check(fs.readFileSync(filePath, "utf8") === "{corrupt", "corruption never resets or rewrites the evidence");
  console.log(JSON.stringify({ ok: true, checks, fixtureOnly: true, background: true }));
} finally {
  await runtime.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
