import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ArchiveSearchService } from "../src/archive-search-service.js";

// Synthetic, isolated fixtures ONLY; never imports bridge/config or opens data/.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-search-service-test-"));
const services = new Set();
let checks = 0;
const service = (options) => {
  const instance = new ArchiveSearchService(options);
  services.add(instance);
  return instance;
};
const cache = (file) => path.join(path.dirname(file), "search-index.json");
const ids = (records) => records.map((record) => record.messageId);
const row = (id, text = "synthetic marker", senderId = "synthetic-user") => ({ messageId: id, senderId, text });
function fixture(name, records = []) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "messages.jsonl");
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return file;
}
function coldCopy(name, original) {
  const file = fixture(name);
  fs.copyFileSync(original, file);
  return file;
}
function errorCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.name, "ArchiveSearchError");
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.stack, `ArchiveSearchError: ${code}`);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(root));
    return true;
  });
}
async function until(predicate) {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("bounded wait expired");
}
async function test(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
async function noTemporaryFiles(file) {
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
}

// Test-process-only fault injection; exact synthetic directories and owned temp
// basenames only. Nothing is injected into the service/worker production API.
function stubTempUnlink(files, run) {
  const directories = new Set(files.map((file) => fs.realpathSync(path.dirname(file))));
  const original = fsPromises.unlink;
  fsPromises.unlink = function (target, ...args) {
    const proceed = () => original.call(fsPromises, target, ...args);
    if (typeof target === "string" && directories.has(path.dirname(target))
      && /^search-index\.json\.[a-f0-9-]{36}\.tmp$/.test(path.basename(target))) return run(target, proceed);
    return proceed();
  };
  syncBuiltinESMExports();
  return () => { fsPromises.unlink = original; syncBuiltinESMExports(); };
}

function deniedUnlink(target) {
  return Object.assign(new Error(`synthetic denied ${target} SyntheticSecret987`), {
    code: "EACCES", path: target, syscall: "unlink"
  });
}

try {
  const small = fixture("small", [row("early", "early marker 𠮷星 MixHTTPServer_v2.5"), row("later", "other content", 7)]);
  const large = fixture("large");
  const fd = fs.openSync(large, "a");
  try {
    for (let i = 0; i < 6500; i += 1) {
      fs.writeSync(fd, `${JSON.stringify(row(`large-${i}`, `cold needle ${"synthetic filler 归档样例 ".repeat(70)}`))}\n`);
    }
  } finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(large).size > 8 * 1024 * 1024);

  await test("cold build keeps main-thread timers responsive; warm search and append", async () => {
    const instance = service({ timeoutMs: 60000 });
    let ticks = 0;
    let maxGap = 0;
    let previous = performance.now();
    const start = previous;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - previous);
      previous = now;
      ticks += 1;
    }, 10);
    try {
      const records = await instance.search(large, { messageIds: ["large-0"], maxCandidates: 1 });
      assert.deepEqual(ids(records), ["large-0"]);
      assert.ok(ticks >= 5, "timer must tick DURING the cold query");
      assert.ok(maxGap < 500, `timer gap ${Math.round(maxGap)}ms exceeds responsiveness budget`);
    } finally { clearInterval(timer); }
    console.log(`METRIC cold_ms=${Math.round(performance.now() - start)} timer_ticks=${ticks} max_gap_ms=${Math.round(maxGap)}`);
    const before = fs.statSync(cache(large), { bigint: true }).mtimeNs;
    assert.deepEqual(ids(await instance.search(large, { terms: ["needle"], maxCandidates: 2 })), ["large-6499", "large-6498"]);
    assert.equal(fs.statSync(cache(large), { bigint: true }).mtimeNs, before, "warm query must not rebuild");
    fs.appendFileSync(large, `${JSON.stringify(row("appended", "incremental marker"))}\n`);
    assert.deepEqual(ids(await instance.search(large, { terms: ["incremental"] })), ["appended"]);
    assert.equal(JSON.parse(fs.readFileSync(cache(large))).data.rows.length, 6501);
    assert.equal(instance.status().workerStarts, 1, "successful requests reuse one worker");
    await instance.close();
    await noTemporaryFiles(large);
  });

  await test("Unicode/ID selectors, empty queries, missing file, immutable option snapshot", async () => {
    const instance = service();
    for (const term of ["𠮷", "httpserver", "marker"]) {
      assert.deepEqual(ids(await instance.search(small, { terms: [term] })), ["early"]);
    }
    assert.deepEqual(ids(await instance.search(small, { senderIds: [7] })), ["later"]);
    assert.deepEqual(ids(await instance.search(small, { messageIds: ["early"], terms: ["other"], maxCandidates: 1 })), ["early"]);
    assert.deepEqual(await instance.search(small), []);
    assert.deepEqual(await instance.search(small, { terms: ["marker"], maxCandidates: 0 }), []);
    assert.deepEqual(await instance.search(path.join(root, "missing.jsonl"), { terms: ["marker"] }), []);
    const options = { terms: ["marker"] };
    const pending = instance.search(small, options);
    options.terms[0] = "changed-after-submission";
    assert.deepEqual(ids(await pending), ["early"]);
    await instance.close();
  });

  await test("default sanitizer removes fixture secrets; persisted postings remain hashed", async () => {
    const file = fixture("privacy", [{ ...row("privacy", "marker password=SyntheticSecret987 13800138000"), apiKey: "SyntheticKey765" }]);
    const instance = service();
    const [record] = await instance.search(file, { terms: ["marker"], policyKey: "safe-policy-v1" });
    const returned = JSON.stringify(record);
    const persisted = fs.readFileSync(cache(file), "utf8");
    for (const secret of ["SyntheticSecret987", "13800138000", "SyntheticKey765"]) {
      assert.ok(!returned.includes(secret));
      assert.ok(!persisted.includes(secret));
    }
    assert.ok(!persisted.includes("marker"));
    assert.deepEqual(await instance.search(file, { terms: ["SyntheticSecret987"] }), []);
    const status = instance.status();
    assert.ok(!JSON.stringify(status).includes(file));
    assert.ok(!JSON.stringify(status).includes("SyntheticSecret987"));
    status.errors.injected = 999;
    assert.equal(instance.status().errors.injected, undefined);
    await instance.close();
  });

  await test("explicit shared privacy preserves benign URLs, redacts secrets, and keys both closure states", async () => {
    const record = { ...row("shared", "marker https://example.org/manual password=SyntheticPassword987 13800138000"),
      apiKey: "SyntheticKey765", sources: [{ title: "guide", url: "https://example.org/manual" },
        { title: "auth", url: "https://user:pass@example.org/api?token=SyntheticToken765&topic=manual" }] };
    const file = fixture("shared-privacy", [record]);
    const instance = service();
    const policy = () => JSON.parse(fs.readFileSync(cache(file), "utf8")).data.policy;
    const [legacy] = await instance.search(file, { messageIds: ["shared"] });
    assert.equal(legacy.sources[0].url, "[链接]", "omitted flag keeps old default");
    const legacyPolicy = policy();
    const [safe] = await instance.search(file, { messageIds: ["shared"], privacyFilter: true, policyKey: "caller-v1" });
    const safePolicy = policy();
    assert.equal(safe.sources[0].url, "https://example.org/manual");
    assert.equal(new URL(safe.sources[1].url).searchParams.get("topic"), "manual");
    for (const secret of ["SyntheticPassword987", "SyntheticKey765", "SyntheticToken765", "13800138000", "user:pass"]) {
      assert.ok(!JSON.stringify(safe).includes(secret));
      assert.ok(!fs.readFileSync(cache(file), "utf8").includes(secret));
    }
    assert.notEqual(safePolicy, legacyPolicy);
    assert.deepEqual(await instance.search(file, { terms: ["SyntheticPassword987"], privacyFilter: true, policyKey: "caller-v1" }), []);
    assert.equal((await instance.search(file, { terms: ["example.org/manual"], privacyFilter: true, policyKey: "caller-v1" })).length, 1);
    assert.deepEqual(await instance.search(file, { terms: ["SyntheticPassword987"], privacyFilter: false, policyKey: "caller-v1" }), [record]);
    const rawPolicy = policy();
    assert.notEqual(rawPolicy, safePolicy, "same closure source must not reuse privacy=true postings");
    await instance.search(file, { messageIds: ["shared"], privacyFilter: true, policyKey: "caller-v1" });
    assert.equal(policy(), safePolicy, "raw -> safe must rebuild with the original safe identity");
    await instance.search(file, { messageIds: ["shared"], privacyFilter: true, policyKey: "caller-v2" });
    assert.notEqual(policy(), safePolicy, "caller policy key must also contribute");
    await instance.search(file, { messageIds: ["shared"] });
    assert.equal(policy(), legacyPolicy);
    for (const privacyFilter of [undefined, null, 0, "true"]) {
      await errorCode(instance.search(file, { privacyFilter }), "INVALID_OPTIONS");
    }
    await instance.close();
  });

  await test("active abort terminates worker; queued next request recovers", async () => {
    const file = coldCopy("active-abort", large);
    const instance = service({ timeoutMs: 60000 });
    const abort = new AbortController();
    const interrupted = errorCode(instance.search(file, { terms: ["needle"] }, { signal: abort.signal }), "ABORTED");
    await until(() => instance.status().running === 1);
    await delay(80); // allow synchronous indexing, not merely path preparation
    const next = instance.search(small, { messageIds: ["early"] });
    abort.abort(new Error(`must-not-leak:${root}:SyntheticSecret987`));
    await interrupted;
    assert.deepEqual(ids(await next), ["early"]);
    assert.equal(instance.status().workerStarts, 2);
    await instance.close();
    await noTemporaryFiles(file);
  });

  await test("pending abort/timeout do not kill active or drop peer; bounded queue rejects explicitly", async () => {
    const instance = service({ queueLimit: 3, timeoutMs: 60000 });
    const active = instance.search(coldCopy("pending", large), { messageIds: ["large-0"] });
    const abort = new AbortController();
    const cancelled = errorCode(instance.search(small, { terms: ["marker"] }, { signal: abort.signal }), "ABORTED");
    const expired = errorCode(instance.search(small, {}, { timeoutMs: 20 }), "TIMEOUT");
    const peer = instance.search(small, { messageIds: ["later"] });
    await errorCode(instance.search(small, {}), "QUEUE_FULL");
    abort.abort("untrusted abort reason");
    await cancelled;
    await expired;
    assert.deepEqual(ids(await active), ["large-0"]);
    assert.deepEqual(ids(await peer), ["later"]);
    assert.equal(instance.status().workerStarts, 1);
    assert.equal(instance.status().timers, 0);
    await instance.close();
    const zero = service({ queueLimit: 0 });
    const first = zero.search(small, { terms: ["marker"] });
    await errorCode(zero.search(small), "QUEUE_FULL");
    await first;
    await zero.close();
  });

  await test("active timeout kills/rebuilds worker and queued next request succeeds", async () => {
    const instance = service({ timeoutMs: 60000 });
    const file = coldCopy("active-timeout", large);
    const expired = errorCode(instance.search(file, { terms: ["needle"] }, { timeoutMs: 120 }), "TIMEOUT");
    await until(() => instance.status().running === 1);
    const next = instance.search(small, { terms: ["marker"] });
    await expired;
    assert.deepEqual(ids(await next), ["early"]);
    assert.equal(instance.status().workerStarts, 2);
    await instance.close();
    await noTemporaryFiles(file);
  });

  await test("pool serializes canonical directory aliases, including while cancelled worker retires", async () => {
    const instance = service({ maxWorkers: 2, timeoutMs: 60000 });
    const file = coldCopy("directory-lock", large);
    const alias = path.join(root, "source-alias.jsonl");
    fs.symlinkSync(file, alias);
    const abort = new AbortController();
    const stopped = errorCode(instance.search(file, { terms: ["needle"] }, { signal: abort.signal }), "ABORTED");
    await until(() => instance.status().running === 1);
    const second = instance.search(alias, { messageIds: ["large-0"] });
    await until(() => instance.status().active === 2);
    await delay(40);
    assert.equal(instance.status().running, 1, "same cache must have only one writer");
    abort.abort();
    await stopped;
    assert.deepEqual(ids(await second), ["large-0"]);
    assert.equal(JSON.parse(fs.readFileSync(cache(file))).data.rows.length, 6501);
    // Different source names in one directory STILL share a cache; alternate safely.
    const other = path.join(path.dirname(file), "other.jsonl");
    fs.writeFileSync(other, `${JSON.stringify(row("other-file"))}\n`);
    const [a, b] = await Promise.all([
      instance.search(other, { messageIds: ["other-file"] }), instance.search(file, { messageIds: ["large-0"] })
    ]);
    assert.deepEqual(ids(a), ["other-file"]);
    assert.deepEqual(ids(b), ["large-0"]);
    await instance.close();
    await noTemporaryFiles(file);
  });

  await test("cancelling one active pool worker leaves unrelated peer worker intact", async () => {
    const instance = service({ maxWorkers: 2, timeoutMs: 60000 });
    const abort = new AbortController();
    const stopped = errorCode(instance.search(coldCopy("pool-cancel", large), { terms: ["needle"] }, { signal: abort.signal }), "ABORTED");
    const peer = instance.search(coldCopy("pool-peer", large), { messageIds: ["large-0"] });
    await until(() => instance.status().running === 2);
    await delay(50);
    abort.abort();
    await stopped;
    assert.deepEqual(ids(await peer), ["large-0"]);
    assert.equal(instance.status().workerStarts, 2);
    await instance.close();
  });

  await test("separate service instances also serialize the same index; waiting cancellation is isolated", async () => {
    const owner = service({ timeoutMs: 60000 });
    const waiting = service({ timeoutMs: 60000 });
    const file = coldCopy("cross-instance-lock", large);
    const stopOwner = new AbortController();
    const active = errorCode(owner.search(file, { terms: ["needle"] }, { signal: stopOwner.signal }), "ABORTED");
    await until(() => owner.status().running === 1);
    const stopWaiting = new AbortController();
    const pending = errorCode(waiting.search(file, { terms: ["needle"] }, { signal: stopWaiting.signal }), "ABORTED");
    await delay(40);
    assert.equal(waiting.status().workerStarts, 0);
    stopWaiting.abort();
    await pending;
    const next = waiting.search(file, { messageIds: ["large-0"] });
    assert.equal(owner.status().running, 1);
    stopOwner.abort();
    await active;
    assert.deepEqual(ids(await next), ["large-0"]);
    await Promise.all([owner.close(), waiting.close()]);
    await noTemporaryFiles(file);
  });

  await test("source/cache/result byte limits fail closed; original files remain untouched", async () => {
    const sourceLimit = service({ maxSourceBytes: 1 });
    await errorCode(sourceLimit.search(small, { terms: ["marker"] }), "SOURCE_LIMIT");
    await sourceLimit.close();
    const existing = fixture("oversized-cache", [row("index-limit")]);
    fs.writeFileSync(cache(existing), "x".repeat(2048));
    const indexLimit = service({ maxIndexBytes: 1024 });
    await errorCode(indexLimit.search(existing, { terms: ["marker"] }), "INDEX_LIMIT");
    assert.equal(fs.statSync(cache(existing)).size, 2048);
    const generated = fixture("generated-limit", [row("generated-index-limit")]);
    const original = fs.readFileSync(generated);
    await errorCode(indexLimit.search(generated, { terms: ["marker"] }), "INDEX_LIMIT");
    assert.ok(!fs.existsSync(cache(generated)), "oversized generated index must not publish");
    assert.deepEqual(fs.readFileSync(generated), original);
    await indexLimit.close();
    await noTemporaryFiles(generated);
    const resultLimit = service({ maxResultBytes: 1 });
    await errorCode(resultLimit.search(small, { terms: ["marker"] }), "RESULT_LIMIT");
    await resultLimit.close();
  });

  await test("worker resource-limit failure is sanitized; replacement handles next small query", async () => {
    const instance = service({ timeoutMs: 60000, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 } });
    const file = fixture("heap-limit");
    const descriptor = fs.openSync(file, "a");
    let seed = 123456789;
    try {
      // High-cardinality bigrams/postings deliberately exceed the tiny worker
      // heap, without allocating a huge fixture or payload on the host thread.
      for (let i = 0; i < 12000; i += 1) {
        let text = "";
        for (let j = 0; j < 400; j += 1) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          text += String.fromCharCode(65 + ((seed >>> 0) % 52));
        }
        fs.writeSync(descriptor, `${JSON.stringify(row(`heap-${i}`, text))}\n`);
      }
    } finally { fs.closeSync(descriptor); }
    await errorCode(instance.search(file, { terms: ["needle"] }), "RESOURCE_LIMIT");
    assert.deepEqual(ids(await instance.search(small, { messageIds: ["early"] })), ["early"]);
    assert.equal(instance.status().workerStarts, 2);
    await instance.close();
    await noTemporaryFiles(file);
  });

  await test("invalid input/callbacks/accessors/code are refused without execution or worker spawn", async () => {
    const instance = service();
    const getter = {};
    Object.defineProperty(getter, "terms", { get() { assert.fail("getter ran"); } });
    const arrayGetter = [];
    Object.defineProperty(arrayGetter, "0", { get() { assert.fail("array getter ran"); } });
    for (const options of [null, [], { terms: "marker" }, { terms: [() => {}] }, getter,
      { terms: arrayGetter }, { terms: new Array(2) }, { terms: ["x".repeat(1025)] },
      { terms: Array(257).fill("x") }, { terms: Array(256).fill("x".repeat(1024)) },
      { senderIds: [NaN] }, { messageIds: [1n] }, { maxCandidates: Infinity }, { maxCandidates: -1 },
      { maxCandidates: 1001 }, { policyKey: "" }, { unknown: true },
      { sanitizeRecord: (record) => record }, { sanitizeRecord: "(record) => record" },
      { tokenize: () => [] }, { [Symbol("unknown")]: true }]) {
      await errorCode(instance.search(small, options), "INVALID_OPTIONS");
    }
    for (const controls of [null, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 2 ** 31 }, { signal: {} }, { unexpected: true }]) {
      await errorCode(instance.search(small, {}, controls), "INVALID_OPTIONS");
    }
    for (const file of [null, 42, "", "has\0nul"]) await errorCode(instance.search(file), "INVALID_FILE");
    const abort = new AbortController();
    abort.abort(`secret path ${root}`);
    await errorCode(instance.search(small, {}, { signal: abort.signal }), "ABORTED");
    assert.equal(instance.status().workerStarts, 0);
    assert.equal(instance.status().timers, 0);
    for (const options of [null, { maxWorkers: 0 }, { maxWorkers: 9 }, { queueLimit: -1 }, { timeoutMs: 0 },
      { maxSourceBytes: Infinity }, { maxIndexBytes: 0 }, { maxResultBytes: 0 },
      { resourceLimits: { maxOldGenerationSizeMb: 0 } }, { resourceLimits: { stackSizeMb: -1 } }, { workerPath: small }]) {
      assert.throws(() => new ArchiveSearchService(options), (error) => error.code === "INVALID_OPTIONS"
        && error.stack === "ArchiveSearchError: INVALID_OPTIONS");
    }
    await instance.close();
  });

  await test("I/O failures/unsafe cache do not leak paths; corrupted bounded cache rebuilds", async () => {
    const instance = service();
    await errorCode(instance.search(root, { terms: ["marker"] }), "SEARCH_FAILED");
    const file = fixture("cache-symlink", [row("safe")]);
    fs.symlinkSync(small, cache(file));
    await errorCode(instance.search(file, { terms: ["marker"] }), "SEARCH_FAILED");
    assert.ok(fs.lstatSync(cache(file)).isSymbolicLink());
    fs.unlinkSync(cache(file));
    fs.writeFileSync(cache(file), "{broken-json");
    assert.deepEqual(ids(await instance.search(file, { terms: ["marker"] })), ["safe"]);
    await instance.close();
  });

  await test("close rejects running/waiting jobs, clears timers/workers, idempotently prevents new work", async () => {
    const instance = service({ timeoutMs: 60000 });
    const file = coldCopy("close", large);
    const active = errorCode(instance.search(file, { terms: ["needle"] }), "CLOSED");
    const queued = errorCode(instance.search(small, { terms: ["marker"] }), "CLOSED");
    await until(() => instance.status().running === 1);
    const closed = instance.close();
    assert.equal(instance.close(), closed);
    await Promise.all([active, queued, closed]);
    await errorCode(instance.search(small), "CLOSED");
    const status = instance.status();
    for (const key of ["workers", "active", "queued", "running", "stopping", "timers"]) assert.equal(status[key], 0);
    assert.equal(status.code, "CLOSED");
    await noTemporaryFiles(file);
    const preparing = service();
    const pending = errorCode(preparing.search(small), "CLOSED");
    await preparing.close();
    await pending;
    await delay(10);
    assert.equal(preparing.status().workers, 0);
    assert.equal(preparing.status().stopping, 0);
    const unused = service();
    await unused.close();
    assert.equal(unused.status().stopping, 0);
  });

  await test("closing an active plus directory-waiting pool releases only owned leases for another service", async () => {
    const instance = service({ maxWorkers: 2, timeoutMs: 60000 });
    const survivor = service({ timeoutMs: 60000 });
    const file = coldCopy("close-pool", large);
    const active = errorCode(instance.search(file, { terms: ["needle"] }), "CLOSED");
    await until(() => instance.status().running === 1);
    const waiting = errorCode(instance.search(file, { terms: ["needle"] }), "CLOSED");
    const peer = survivor.search(file, { messageIds: ["large-0"] });
    await delay(40);
    assert.equal(instance.status().active, 2);
    assert.equal(instance.status().running, 1);
    assert.equal(survivor.status().workerStarts, 0);
    await Promise.all([instance.close(), active, waiting]);
    assert.deepEqual(ids(await peer), ["large-0"]);
    await survivor.close();
    await noTemporaryFiles(file);
  });

  await test("explicit close latches safe cleanup failure, awaits every retirement, and releases directory locks", async () => {
    const instance = service({ maxWorkers: 2, timeoutMs: 60000 });
    const survivor = service();
    const firstFile = coldCopy("cleanup-denied", large);
    const otherFile = coldCopy("cleanup-delayed", large);
    const deniedDirectory = fs.realpathSync(path.dirname(firstFile));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let injected = 0;
    let delayed = 0;
    const restore = stubTempUnlink([firstFile, otherFile], async (target, proceed) => {
      if (path.dirname(target) === deniedDirectory) { injected += 1; throw deniedUnlink(target); }
      delayed += 1;
      await gate;
      return proceed();
    });
    try {
      const first = errorCode(instance.search(firstFile, { terms: ["needle"] }), "CLOSED");
      const other = errorCode(instance.search(otherFile, { terms: ["needle"] }), "CLOSED");
      await until(() => instance.status().running === 2);
      const queued = errorCode(instance.search(small, { terms: ["marker"] }), "CLOSED");
      const peer = survivor.search(firstFile, { maxCandidates: 0 });
      let closeState = "pending";
      const closed = instance.close();
      void closed.then(() => { closeState = "resolved"; }, () => { closeState = "rejected"; });
      assert.equal(instance.close(), closed);
      await until(() => injected === 1 && delayed === 1);
      await Promise.all([first, other, queued]);
      assert.deepEqual(await peer, [], "failed cleanup must still release its directory lease");
      assert.equal(closeState, "pending", "no rejection until the unrelated retirement finishes");
      assert.equal(instance.status().workers, 1, "delayed retirement remains accounted for");
      release();
      await errorCode(closed, "CLEANUP_FAILED");
      assert.equal(closeState, "rejected");
      assert.equal(instance.close(), closed);
      await errorCode(instance.close(), "CLEANUP_FAILED");
      const status = instance.status();
      assert.equal(status.code, "CLOSED");
      assert.equal(status.errors.CLEANUP_FAILED, 1, "failure is latched, not re-counted per close");
      for (const key of ["workers", "active", "running", "queued", "stopping", "timers"]) assert.equal(status[key], 0);
      await errorCode(instance.search(small), "CLOSED");
    } finally {
      release();
      restore();
      await instance.close().catch(() => {});
      services.delete(instance); // this deliberately failed close was asserted above
      await survivor.close();
    }
  });

  await test("abort-triggered cleanup failures auto-close all slots without unhandled rejection", async () => {
    const instance = service({ maxWorkers: 2, timeoutMs: 60000 });
    const firstFile = coldCopy("auto-cleanup-denied", large);
    const otherFile = coldCopy("auto-cleanup-peer", large);
    const unhandled = [];
    const onUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let injected = 0;
    const restore = stubTempUnlink([firstFile, otherFile], async (target) => {
      injected += 1;
      throw deniedUnlink(target);
    });
    try {
      const abort = new AbortController();
      const first = errorCode(instance.search(firstFile, { terms: ["needle"] }, { signal: abort.signal }), "ABORTED");
      const other = errorCode(instance.search(otherFile, { terms: ["needle"] }), "CLOSED");
      await until(() => instance.status().running === 2);
      const queued = errorCode(instance.context(small, { terms: ["marker"] }), "CLOSED");
      abort.abort();
      await Promise.all([first, other, queued]);
      await until(() => injected === 2 && instance.status().stopping === 0);
      // Do not call close until after a full unhandled-rejection reporting turn.
      await delay(20);
      assert.deepEqual(unhandled, []);
      await errorCode(instance.close(), "CLEANUP_FAILED");
      await errorCode(instance.close(), "CLEANUP_FAILED");
      const status = instance.status();
      assert.equal(status.errors.CLEANUP_FAILED, 1, "two unlink failures still latch one fixed failure");
      for (const key of ["workers", "active", "running", "queued", "stopping", "timers"]) assert.equal(status[key], 0);
      await errorCode(instance.search(small), "CLOSED");
    } finally {
      restore();
      await instance.close().catch(() => {});
      services.delete(instance);
      process.off("unhandledRejection", onUnhandled);
    }
  });

  console.log(`PASS archive-search-service: ${checks} checks (synthetic temporary data only)`);
} finally {
  await Promise.all([...services].map((instance) => instance.close()));
  fs.rmSync(root, { recursive: true, force: true });
}
