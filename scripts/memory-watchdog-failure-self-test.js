import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import workerThreads from "node:worker_threads";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRepository, readMemorySnapshot } from "../src/memory-repository.js";
import { MemoryRuntime } from "../src/memory-runtime.js";

// All injection lives in this test and its isolated subprocess/worker. The real
// service, worker handler, persistence engine and writer cleanup remain in use.
const cases = ["hung", "posted-without-ack", "double-pending", "grace-close", "grace-terminate", "grace-close-terminate"];
const timeoutMs = 500;
const uncertain = "MEMORY_OPERATION_UNCERTAIN";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function bounded(promise, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: did not settle`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert(performance.now() < deadline, `${label}: condition did not become true`);
    await pause(5);
  }
}
function observe(promise) {
  const state = { settled: false };
  state.promise = Promise.resolve(promise).then(value => {
    state.settled = true;
    return { status: "fulfilled", value };
  }, error => {
    state.settled = true;
    return { status: "rejected", code: error.code };
  });
  return state;
}

if (!workerThreads.isMainThread && workerThreads.workerData?.watchdogFailureFixture) {
  const control = new Int32Array(workerThreads.workerData.control);
  if (workerThreads.workerData.hang) {
    // A real worker executes the production handler, marks progress=executing,
    // then blocks indefinitely inside save. Only supervisor termination ends it.
    MemoryRepository.prototype.save = function () {
      Atomics.add(control, 0, 1);
      for (;;) Atomics.wait(control, 1, 0);
    };
  }
  await import("../src/memory-repository-worker.js");
} else if (process.argv.includes("--case")) {
  const name = process.argv[process.argv.indexOf("--case") + 1];
  const home = process.argv[process.argv.indexOf("--home") + 1];
  assert(cases.includes(name));
  assert(process.argv.includes("--home") && path.isAbsolute(home));
  const filePath = path.join(home, "memory.json");
  const NativeWorker = workerThreads.Worker;
  const control = new Int32Array(new SharedArrayBuffer(8));
  const permitStop = deferred(), permitCleanup = deferred(), exited = deferred();
  const events = [], dispatches = new Map(), requests = new Map();
  const posted = name === "posted-without-ack";
  let fixtureWorker, repository, runtime, ticket, droppedAcks = 0;
  let termination, terminationRequested = false, workerExited = false;
  const dispatchCount = kind => [...requests.values()].filter(request => request.kind === kind).length;
  const assertLocked = () => {
    assert(fs.existsSync(ticket), "original writer ticket must still exist");
    const competitor = new MemoryRepository({ filePath });
    try { assert.throws(() => competitor.acquireWriter(), { code: "MEMORY_LOCKED" }); }
    finally { competitor.close(); }
    assert(fs.existsSync(ticket), "rejected competitor cannot remove the original ticket");
  };
  class FixtureWorker extends NativeWorker {
    constructor(url, options) {
      assert.equal(fileURLToPath(url), fileURLToPath(new URL("../src/memory-repository-worker.js", import.meta.url)));
      super(new URL(import.meta.url), { ...options, workerData: {
        watchdogFailureFixture: true, hang: !posted, control: control.buffer
      } });
      fixtureWorker = this;
      this.on("exit", () => {
        workerExited = true;
        events.push("worker-exit");
        exited.resolve();
      });
    }
    postMessage(request, ...args) {
      dispatches.set(request.id, (dispatches.get(request.id) || 0) + 1);
      requests.set(request.id, { kind: request.kind, progress: new Int32Array(request.progress) });
      // Count actual calls to the native dispatch, not an asserted output flag.
      return super.postMessage(request, ...args);
    }
    emit(event, ...args) {
      if (posted && event === "message" && requests.get(args[0]?.id)?.kind === "commit") {
        droppedAcks += 1;
        return true; // Persist normally, but never let the host receive this ACK.
      }
      return super.emit(event, ...args);
    }
    terminate() {
      if (!termination) {
        terminationRequested = true;
        events.push("terminate-requested");
        termination = (async () => {
          // Hold first before native termination, then after its completion.
          // Neither boundary may permit the service to release the writer lock.
          await permitStop.promise;
          events.push("native-terminate");
          const code = await super.terminate();
          assert(workerExited);
          if (ticket) assertLocked();
          events.push("native-terminated-ticket-held");
          await permitCleanup.promise;
          events.push("termination-confirmed");
          return code;
        })();
      }
      return termination;
    }
  }
  workerThreads.Worker = FixtureWorker;
  syncBuiltinESMExports();
  try {
    repository = new BackgroundMemoryRepository({ filePath, timeoutMs });
    runtime = new MemoryRuntime(repository);
    const root = await runtime.open();
    const original = structuredClone(root), originalRevision = runtime.revision;
    const tickets = fs.readdirSync(`${filePath}.writer`).filter(entry => entry.endsWith(".json"));
    assert.equal(tickets.length, 1);
    ticket = path.join(`${filePath}.writer`, tickets[0]);
    assertLocked();
    const started = performance.now();
    const commit = observe(runtime.transact(draft => {
      draft.groups.fixture = { text: "synthetic unacknowledged mutation" };
    }));
    await until(() => dispatchCount("commit") === 1, "commit dispatch");
    const commitRequest = [...requests.values()].find(request => request.kind === "commit");
    await until(() => posted ? droppedAcks === 1 && Atomics.load(commitRequest.progress, 0) === 2
      : Atomics.load(control, 0) === 1, "worker entered injected state");
    assert.equal(Atomics.load(commitRequest.progress, 0), posted ? 2 : 1);
    const pending = [commit];
    const queueRead = () => {
      pending.push(observe(repository.read()));
      assert.equal(repository.status().pending, 2);
      const readRequest = [...requests.values()].find(request => request.kind === "read");
      assert.equal(Atomics.load(readRequest.progress, 0), 0, "second request is queued behind the hung worker");
    };
    if (!["hung", "posted-without-ack", "double-pending"].includes(name)) queueRead();
    // This timer is due after the first deadline but before a second window can
    // expire. Even a delayed event loop must get one complete confirmation turn.
    await pause(timeoutMs + 50);
    assert(pending.every(item => !item.settled), "first deadline must not reject or accept any request");
    assert.equal(repository.status().lastFailure, null);
    assert.equal(repository.status().writable, true);
    assert.deepEqual(root, original, "progress and a durable-but-lost ACK cannot publish memory");
    assert.equal(runtime.revision, originalRevision);
    assertLocked();
    // A newer pending request must not reset the older request's confirmation
    // window. Its own first deadline is later than the hung commit's second one.
    if (name === "double-pending") queueRead();
    if (posted) {
      assert.equal(readMemorySnapshot(filePath).groups.fixture.text, "synthetic unacknowledged mutation");
    } else {
      assert.deepEqual(readMemorySnapshot(filePath), original);
      assert.equal(Atomics.load(control, 0), 1, "save is really blocked, not merely an unstarted worker");
    }
    let closing, stopping;
    if (name.includes("close")) {
      const promise = repository.close();
      assert.strictEqual(repository.close(), promise, "concurrent close shares one drain");
      closing = observe(promise);
      await assert.rejects(repository.read(), { code: "MEMORY_CLOSED" });
      assert(!closing.settled, "close must wait for the pending lane");
    }
    if (name.includes("terminate")) {
      const promise = repository.terminate();
      assert.strictEqual(repository.terminate(), promise, "concurrent terminate shares confirmed cleanup");
      stopping = observe(promise);
    }
    const outcomes = await bounded(Promise.all(pending.map(item => item.promise)), "all pending requests", timeoutMs + 100);
    assert(outcomes.every(item => item.status === "rejected" && item.code === uncertain));
    assert.equal(repository.status().pending, 0);
    assert.equal(repository.status().writable, false);
    assert.equal(repository.status().recoveryRequired, true);
    assert.equal(runtime.status().queuedTransactions, 0);
    assert.deepEqual(root, original, "an uncertain operation must never publish later");
    assert.equal(runtime.revision, originalRevision);
    if (!name.includes("terminate")) {
      const failure = repository.status().lastFailure;
      assert.equal(failure.cause, "deadline");
      assert.equal(failure.operation, "commit");
      assert.equal(failure.workerState, posted ? "response_posted" : "executing");
      assert.equal(failure.resumeGraceUsed, true);
      assert(failure.elapsedMs >= timeoutMs * 1.8, "only the second deadline may reject");
      assert(performance.now() - started < timeoutMs * 4 + 1000, "grace cannot keep extending");
      assert.deepEqual(Object.keys(failure).sort(), ["cause", "operation", "elapsedMs", "overdueMs", "workerState", "resumeGraceUsed"].sort());
      assert(!JSON.stringify(failure).includes(home));
      assert(!JSON.stringify(failure).includes("synthetic unacknowledged mutation"));
    }
    await until(() => terminationRequested, "termination requested");
    assert(!workerExited);
    assertLocked();
    if (!closing) closing = observe(repository.close());
    assert(!closing.settled, "close must wait for confirmed termination");
    if (stopping) assert(!stopping.settled);
    permitStop.resolve();
    await bounded(exited.promise, "native worker exit");
    await until(() => events.includes("native-terminated-ticket-held"), "termination confirmation boundary");
    assertLocked();
    assert(!closing.settled, "worker exit alone does not complete cleanup");
    if (stopping) assert(!stopping.settled);
    permitCleanup.resolve();
    const lifecycle = await bounded(Promise.all([closing.promise, ...(stopping ? [stopping.promise] : [])]), "close/terminate convergence");
    if (name.includes("close")) assert.deepEqual(lifecycle[0], { status: "rejected", code: uncertain });
    else assert.equal(lifecycle[0].status, "fulfilled");
    if (stopping) assert.equal(lifecycle[1].status, "fulfilled");
    assert(!fs.existsSync(ticket), "only confirmed termination may release the original ticket");
    events.push("ticket-released");
    assert(events.indexOf("worker-exit") < events.indexOf("termination-confirmed"));
    assert(events.indexOf("termination-confirmed") < events.indexOf("ticket-released"));
    assert.equal(dispatchCount("commit"), 1, "never resubmit an uncertain mutation under another id");
    assert.equal(dispatchCount("read"), pending.length - 1);
    assert.equal(dispatchCount("open"), 1);
    assert.equal(dispatchCount("close"), 0, "a faulted worker cannot receive a queued close command");
    assert([...dispatches.values()].every(count => count === 1), "every actual native dispatch occurs once");
    if (posted) assert.equal(droppedAcks, 1);
    else assert.equal(Atomics.load(control, 0), 1);
    const recovered = new MemoryRepository({ filePath });
    try {
      recovered.acquireWriter();
      const value = recovered.load();
      assert.deepEqual(value, posted ? { groups: { fixture: { text: "synthetic unacknowledged mutation" } } } : original);
      assert(recovered.status().writable, "a fresh explicit recovery can acquire the released writer lock");
    } finally { recovered.close(); }
    console.log(JSON.stringify({ ok: true, case: name, syntheticOnly: true,
      dispatchCount: { commit: dispatchCount("commit"), read: dispatchCount("read") },
      settledRequests: outcomes.length, writerReleaseAfterTermination: true }));
  } finally {
    permitStop.resolve(); permitCleanup.resolve();
    if (fixtureWorker) await bounded(fixtureWorker.terminate(), "fixture cleanup");
    if (repository) await bounded(repository.close().catch(() => {}), "repository cleanup");
    workerThreads.Worker = NativeWorker;
    syncBuiltinESMExports();
  }
} else {
  for (const name of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-memory-watchdog-failure-"));
    let child;
    try {
      await bounded(new Promise((resolve, reject) => {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--case", name, "--home", home], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { HOME: home, TMPDIR: home, LANG: "en_US.UTF-8", PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` }
        });
        let output = "", errors = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { errors += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          try {
            assert.equal(code, 0, `${name}: ${signal || ""}\n${errors}`);
            const result = JSON.parse(output.trim());
            assert.equal(result.ok, true); assert.equal(result.case, name);
            console.log(JSON.stringify(result));
            resolve();
          } catch (error) { reject(error); }
        });
      }), `${name} subprocess`, 15000);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await bounded(new Promise(resolve => child.once("close", resolve)), "subprocess cleanup");
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ ok: true, suite: "memory-watchdog-failure", cases: cases.length, syntheticOnly: true }));
}
