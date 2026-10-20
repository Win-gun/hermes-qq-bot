import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MemoryRepository, MemoryStoreError, memoryRevision, readMemorySnapshot } from "../src/memory-repository.js";

// Entire suite is synthetic. No bridge imports, service calls, config, memory,
// chat archives, logs or credentials from this checkout are opened.
const self = fileURLToPath(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const childMode = process.argv[2] === "--child";

if (childMode) {
  const [mode, file, point] = process.argv.slice(3);
  let repo;
  try {
    repo = new MemoryRepository({ filePath: file, failpoint(stage) {
      if (mode === "crash" && stage === point) process.kill(process.pid, "SIGKILL");
    } });
    if (mode === "contend") {
      process.send({ type: "ready" });
      await once(process, "message");
      // Keep all children alive: live PID refusal must not depend on scheduling.
      try {
        repo.acquireWriter();
        repo.load();
        process.send({ type: "acquired" });
      } catch (error) {
        process.send({ type: "rejected", code: error.code });
      }
      await once(process, "message");
    } else if (mode === "stream") {
      repo.acquireWriter();
      let value = repo.load();
      process.send({ type: "ready" });
      await once(process, "message");
      for (let index = 1; index <= 100; index += 1) {
        value.groups.a = { counter: index, paired: index, legacy: ["b", "a", "b"] };
        repo.save(value);
        await delay(1);
      }
      process.send({ type: "done" });
      await once(process, "message");
    } else {
      repo.acquireWriter();
      const value = repo.load();
      if (mode === "crash") {
        value.groups.a = { counter: 1, legacy: ["b", "a", "b"] };
        repo.save(value);
        throw new Error("unreached failpoint");
      }
      process.send({ type: "acquired" });
      await once(process, "message");
    }
    repo.close();
    process.disconnect();
  } catch (error) {
    if (process.connected) process.send({ type: "error", code: error.code || "CHILD_FAILURE" });
    try { repo?.close(); } catch {}
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
} else {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-memory-repository-"));
  const children = new Set();
  let count = 0;
  const repositories = new Set();
  function file(name) { return path.join(home, name, "memory.json"); }
  function fixture(name, value) {
    const target = file(name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (value !== undefined) fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return target;
  }
  function repository(target, options = {}) {
    const repo = new MemoryRepository({ filePath: target, ...options });
    repositories.add(repo);
    return repo;
  }
  function opened(target, options) {
    const repo = repository(target, options);
    repo.acquireWriter();
    const value = repo.load();
    return { repo, value };
  }
  function code(callback, expected) {
    assert.throws(callback, (error) => error instanceof MemoryStoreError && error.code === expected
      && !error.message.includes("PRIVATE_SENTINEL"), expected);
  }
  function disk(directory) {
    if (!fs.existsSync(directory)) return null;
    return fs.readdirSync(directory).sort().map((name) => {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      return [name, stat.mode, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
        stat.isDirectory() ? disk(target) : fs.readFileSync(target).toString("hex")];
    });
  }
  function child(mode, target, point) {
    const instance = spawn(process.execPath, [self, "--child", mode, target, ...(point ? [point] : [])], {
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    children.add(instance);
    const messages = [];
    instance.on("message", (message) => messages.push(message));
    instance.on("error", () => {});
    instance.on("exit", () => children.delete(instance));
    return { instance, messages, async message(type) {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        if (instance.exitCode !== null || instance.signalCode !== null) throw new Error(`child exited before ${type}`);
        await delay(10);
      }
      throw new Error(`child timeout waiting for ${type}`);
    } };
  }
  async function exit(instance, signal) {
    const done = instance.exitCode !== null || instance.signalCode !== null ? Promise.resolve() : once(instance, "exit");
    if (signal) instance.kill(signal);
    else if (instance.connected) instance.send("release");
    await done;
  }
  async function test(name, body) {
    await body();
    count += 1;
    process.stdout.write(`PASS ${name}\n`);
  }

  try {
    await test("canonical revision supports arbitrary JSON, rejects lossy inputs without invoking getters", () => {
      assert.equal(memoryRevision({ b: [1, { z: "中\n😀", a: true }], a: null }), memoryRevision({ a: null, b: [1, { a: true, z: "中\n😀" }] }));
      for (const value of [null, true, false, "string", 12, [1, null], {}, { conflict: "PRIVATE_SENTINEL" }]) {
        assert.match(memoryRevision(value), /^[a-f0-9]{64}$/);
      }
      assert.notEqual(memoryRevision([1, 2]), memoryRevision([2, 1]));
      assert.notEqual(memoryRevision({ a: null }), memoryRevision({}));
      const cycle = {}; cycle.self = cycle;
      let invoked = false;
      const getter = Object.defineProperty({}, "x", { enumerable: true, get() { invoked = true; return 1; } });
      for (const value of [undefined, NaN, Infinity, 1n, () => {}, { x: undefined }, new Date(), cycle, getter, [, 1], { [Symbol()]: 1 }]) {
        code(() => memoryRevision(value), "MEMORY_INVALID_JSON");
      }
      assert.equal(invoked, false);
    });

    await test("constructor, status and read-only reads have no write/lock side effects", () => {
      const missing = file("read-only-missing");
      const repo = repository(missing);
      assert.equal(repo.revision, null);
      assert.equal(repo.status().writer, false);
      assert.deepEqual(readMemorySnapshot(missing), { groups: {} });
      assert.equal(fs.existsSync(path.dirname(missing)), false);
      repo.close();
      assert.equal(fs.existsSync(path.dirname(missing)), false);
      const existing = fixture("read-only-existing", "{\n \"groups\": {}, \"legacy\": [3,1,3] }");
      const before = disk(path.dirname(existing));
      assert.deepEqual(readMemorySnapshot(existing), { groups: {}, legacy: [3, 1, 3] });
      assert.deepEqual(disk(path.dirname(existing)), before);
    });

    await test("invalid JSON/schema/UTF-8 is never reset; errors/status are content-free", () => {
      const bad = ["", "{PRIVATE_SENTINEL", "null", "[]", "{}", '{"groups":[]}', '{"groups":null}', '{"groups":"PRIVATE_SENTINEL"}', '{"groups":{},"x":1e999}'];
      for (const [index, text] of bad.entries()) {
        const target = fixture(`corrupt-${index}`, text);
        const before = fs.readFileSync(target);
        code(() => readMemorySnapshot(target), "MEMORY_CORRUPT");
        const repo = repository(target);
        repo.acquireWriter();
        code(() => repo.load(), "MEMORY_CORRUPT");
        assert.equal(JSON.stringify(repo.status()).includes("PRIVATE_SENTINEL"), false);
        assert.deepEqual(fs.readFileSync(target), before);
        assert.equal(fs.existsSync(`${target}.journal.jsonl`), false);
        repo.close();
      }
      const target = fixture("bad-utf8");
      fs.writeFileSync(target, Buffer.from([123, 34, 103, 114, 111, 117, 112, 115, 34, 58, 123, 125, 44, 34, 120, 34, 58, 34, 255, 34, 125]));
      code(() => readMemorySnapshot(target), "MEMORY_CORRUPT");
    });

    await test("writer lifecycle, validated values, deep-copy baseline and idempotent saves", () => {
      const target = file("lifecycle");
      const repo = repository(target);
      code(() => repo.load(), "MEMORY_WRITER_REQUIRED");
      code(() => repo.save({ groups: {} }), "MEMORY_WRITER_REQUIRED");
      repo.acquireWriter();
      assert.equal(repo.acquireWriter(), repo);
      code(() => repo.save({ groups: {} }), "MEMORY_LOAD_REQUIRED");
      const value = repo.load();
      value.groups.a = { aliases: ["二", "一", "二"], profile: "PRIVATE_SENTINEL\n😀", legacy: null };
      assert.deepEqual(repo.load(), { groups: {} });
      const old = repo.revision;
      const next = repo.save(value, { expectedRevision: old });
      assert.equal(next, memoryRevision(value));
      assert.equal(repo.revision, next);
      assert.deepEqual(readMemorySnapshot(target), value);
      const before = disk(path.dirname(target));
      assert.equal(repo.save(cloneForTest(value)), next);
      assert.deepEqual(disk(path.dirname(target)), before);
      code(() => repo.save({ groups: [] }), "MEMORY_CORRUPT");
      assert.deepEqual(disk(path.dirname(target)), before);
      value.groups.a.aliases.push("not-saved");
      assert.equal(repo.load().groups.a.aliases.length, 3);
      repo.close(); repo.close();
      code(() => repo.acquireWriter(), "MEMORY_CLOSED");
      code(() => repo.load(), "MEMORY_CLOSED");
      const reopened = opened(target);
      assert.equal(reopened.repo.revision, next);
      reopened.repo.close();
    });

    await test("CAS rejects stale offline proposals; read-only API never resets writer baseline", () => {
      const target = fixture("cas", { groups: { a: { n: 1 } } });
      const proposalRevision = memoryRevision(readMemorySnapshot(target));
      let { repo, value } = opened(target);
      value.groups.a.n = 2;
      repo.save(value);
      assert.equal(readMemorySnapshot(target).groups.a.n, 2);
      const before = disk(path.dirname(target));
      code(() => repo.save({ groups: {} }, { expectedRevision: proposalRevision }), "MEMORY_CAS_MISMATCH");
      assert.deepEqual(disk(path.dirname(target)), before);
      assert.equal(repo.status().recoveryRequired, false);
      repo.close();
      ({ repo, value } = opened(target));
      code(() => repo.save({ groups: {} }, { expectedRevision: proposalRevision }), "MEMORY_CAS_MISMATCH");
      repo.close();
    });

    await test("out-of-band snapshot edits/deletion/identical rewrite fail closed, including offline", () => {
      for (const action of ["edit", "delete", "rewrite", "offline", "whitespace", "corrupt"]) {
        const target = fixture(`external-${action}`, { groups: { a: { n: 1 } } });
        const { repo, value } = opened(target);
        if (action === "offline") repo.close();
        if (action === "delete") fs.unlinkSync(target);
        else if (action === "rewrite") {
          const replacement = `${target}.outside`;
          fs.writeFileSync(replacement, fs.readFileSync(target));
          fs.renameSync(replacement, target);
        } else if (action === "corrupt") fs.writeFileSync(target, "{PRIVATE_SENTINEL");
        else if (action === "whitespace") fs.appendFileSync(target, " \n");
        else fs.writeFileSync(target, JSON.stringify({ groups: { unrelated: { n: 9 } } }));
        const before = disk(path.dirname(target));
        if (action === "offline") {
          const other = repository(target); other.acquireWriter();
          code(() => other.load(), "MEMORY_EXTERNAL_CHANGE");
          other.close();
          code(() => readMemorySnapshot(target), "MEMORY_EXTERNAL_CHANGE");
        } else {
          value.groups.a.n = 2;
          code(() => repo.save(value), "MEMORY_EXTERNAL_CHANGE");
          code(() => repo.save(value), "MEMORY_RECOVERY_REQUIRED");
          // Lock tickets legitimately change on close; no memory/journal writes.
          assert.deepEqual(fs.existsSync(target) ? fs.readFileSync(target).toString("hex") : null,
            before.find(([name]) => name === "memory.json")?.at(-1) ?? null);
          repo.close();
        }
      }
    });

    await test("own-property patch paths preserve legacy data without prototype pollution", () => {
      const original = JSON.parse('{"groups":{"__proto__":{"polluted":false},"constructor":{"prototype":{"x":1}},"a/b":{"":1}},"legacy":[3,2,3],"self":{"style":"旧值"}}');
      const target = fixture("prototype", original);
      const { repo, value } = opened(target);
      value.groups.__proto__.polluted = true;
      value.groups.constructor.prototype.x = 2;
      value.groups["a/b"][""] = 2;
      Object.defineProperty(value, "__proto__", { value: { safe: 1 }, enumerable: true });
      delete value.self;
      repo.save(value);
      assert.deepEqual(readMemorySnapshot(target), value);
      assert.equal({}.polluted, undefined);
      assert.equal({}.x, undefined);
      assert.equal({}.safe, undefined);
      repo.close();
    });

    await test("all new directories/files are private; symlink/non-file paths are rejected", () => {
      const target = path.join(home, "permissions", "nested", "memory.json");
      const { repo, value } = opened(target);
      value.groups.a = { n: 1 }; repo.save(value);
      function permissions(directory) {
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        for (const name of fs.readdirSync(directory)) {
          const full = path.join(directory, name);
          if (fs.statSync(full).isDirectory()) permissions(full);
          else assert.equal(fs.statSync(full).mode & 0o777, 0o600);
        }
      }
      permissions(path.join(home, "permissions"));
      repo.close();
      const link = fixture("symlink"); fs.symlinkSync(target, link);
      code(() => readMemorySnapshot(link), "MEMORY_PATH_UNSAFE");
      const directory = fixture("non-file"); fs.mkdirSync(directory);
      code(() => readMemorySnapshot(directory), "MEMORY_PATH_UNSAFE");
      const lockLink = fixture("lock-symlink"); fs.symlinkSync(path.dirname(target), `${lockLink}.writer`);
      code(() => repository(lockLink).acquireWriter(), "MEMORY_PATH_UNSAFE");
    });

    await test("incremental journal is durable before snapshot and compacted after checkpoint", () => {
      const target = fixture("incremental", { groups: { a: { counter: 0 }, unchanged: { text: "x".repeat(200_000) } }, legacy: [3, 1, 3] });
      let seen = false;
      const { repo, value } = opened(target, { failpoint(stage) {
        if (stage !== "journal:durable") return;
        const rows = fs.readFileSync(`${target}.journal.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[1].ops, [{ op: "set", path: ["groups", "a", "counter"], value: 1 }]);
        assert(fs.statSync(`${target}.journal.jsonl`).size < 2000);
        assert.equal(JSON.parse(fs.readFileSync(target)).groups.a.counter, 0);
        const before = disk(path.dirname(target));
        assert.equal(readMemorySnapshot(target).groups.a.counter, 1);
        assert.deepEqual(disk(path.dirname(target)), before);
        seen = true;
      } });
      value.groups.a.counter = 1; repo.save(value);
      assert.equal(seen, true);
      assert.equal(fs.readFileSync(`${target}.journal.jsonl`, "utf8").trim().split("\n").length, 1);
      assert(fs.statSync(`${target}.journal.jsonl`).size < 400);
      repo.close();
    });

    await test("checkpoint failure is inspectable, blocks repeat mutation, and recovers once", () => {
      const target = fixture("failed-checkpoint", { groups: {} });
      const { repo, value } = opened(target, { failpoint(stage) {
        if (stage === "snapshot:beforeRename") throw new Error("PRIVATE_SENTINEL");
      } });
      value.groups.a = { n: 1 };
      code(() => repo.save(value), "MEMORY_IO");
      const status = repo.status();
      assert.equal(status.recoveryRequired, true);
      assert.equal(status.degraded, true);
      assert.equal(status.writable, false);
      assert.equal(status.durability, "committed");
      assert.equal(status.durableRevision, memoryRevision(value));
      assert.equal(status.lastError, "MEMORY_IO");
      assert.equal(JSON.stringify(status).includes("PRIVATE_SENTINEL"), false);
      const before = disk(path.dirname(target));
      code(() => repo.save(value), "MEMORY_RECOVERY_REQUIRED");
      code(() => repo.load(), "MEMORY_RECOVERY_REQUIRED");
      assert.deepEqual(disk(path.dirname(target)), before);
      assert.deepEqual(readMemorySnapshot(target), value);
      repo.close();
      const recovered = opened(target);
      assert.deepEqual(recovered.value, value);
      const checkpointed = disk(path.dirname(target));
      recovered.repo.save(value);
      assert.deepEqual(disk(path.dirname(target)), checkpointed);
      recovered.repo.close();
    });

    await test("real SIGKILL at commit/checkpoint stages replays; read-only never repairs disk", async () => {
      for (const point of ["journal:durable", "snapshot:tempDurable", "snapshot:renamed", "snapshot:durable", "journalCheckpoint:renamed"]) {
        const target = fixture(`crash-${point.replaceAll(":", "-")}`, { groups: {} });
        // Initialize first: journalCheckpoint also fires during first load.
        const init = opened(target); init.repo.close();
        const crashed = child("crash", target, point);
        await once(crashed.instance, "exit");
        assert.equal(crashed.instance.signalCode, "SIGKILL");
        const before = disk(path.dirname(target));
        const expected = { groups: { a: { counter: 1, legacy: ["b", "a", "b"] } } };
        assert.deepEqual(readMemorySnapshot(target), expected);
        assert.deepEqual(disk(path.dirname(target)), before);
        const { repo, value } = opened(target);
        assert.deepEqual(value, expected);
        assert.deepEqual(JSON.parse(fs.readFileSync(target)), expected);
        assert.equal(fs.readFileSync(`${target}.journal.jsonl`, "utf8").trim().split("\n").length, 1);
        repo.close();
      }
    });

    await test("real competing processes have at most one writer; dead-owner races recover", async () => {
      const target = fixture("contenders", { groups: {} });
      const owner = child("hold", target); await owner.message("acquired");
      const local = repository(target);
      code(() => local.acquireWriter(), "MEMORY_LOCKED");
      local.close();
      // An actual stale owner, not a fabricated high PID.
      await exit(owner.instance, "SIGKILL");
      for (let round = 0; round < 4; round += 1) {
        const contenders = Array.from({ length: 8 }, () => child("contend", target));
        await Promise.all(contenders.map((entry) => entry.message("ready")));
        contenders.forEach((entry) => entry.instance.send("go"));
        for (const entry of contenders) {
          for (let attempt = 0; attempt < 500 && !entry.messages.some((message) => ["acquired", "rejected", "error"].includes(message.type)); attempt += 1) await delay(10);
        }
        const winners = contenders.filter((entry) => entry.messages.some((message) => message.type === "acquired"));
        assert(winners.length <= 1, "multiple writers acquired");
        for (const entry of contenders) {
          assert(entry.messages.some((message) => ["acquired", "rejected"].includes(message.type)));
          const rejected = entry.messages.find((message) => message.type === "rejected");
          if (rejected) assert(["MEMORY_LOCKED", "MEMORY_READ_BUSY"].includes(rejected.code), rejected.code);
        }
        // Keep winner stale for the NEXT round, exercising simultaneous reapers.
        await Promise.all(contenders.map((entry) => exit(entry.instance, winners.includes(entry) ? "SIGKILL" : undefined)));
      }
      const final = opened(target); final.repo.close();
    });

    await test("death while publishing/selecting lock does not strand an unowned global lock", async () => {
      for (const point of ["lock:published", "lock:selected"]) {
        const target = fixture(`stale-${point.replaceAll(":", "-")}`, { groups: {} });
        const crashed = child("crash", target, point);
        await once(crashed.instance, "exit");
        assert.equal(crashed.instance.signalCode, "SIGKILL");
        const { repo } = opened(target); repo.close();
      }
    });

    await test("close cannot release a foreign ticket; journal/out-of-band edits fail closed", () => {
      const target = fixture("foreign-close", { groups: {} });
      const { repo } = opened(target);
      const own = fs.readdirSync(`${target}.writer`).find((name) => name.endsWith(".json"));
      const ticket = path.join(`${target}.writer`, own);
      const foreign = { pid: process.pid, token: "foreign", number: 1 };
      fs.writeFileSync(ticket, JSON.stringify(foreign));
      code(() => repo.close(), "MEMORY_LOCK_LOST");
      assert.equal(repo.status().degraded, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(ticket)), foreign);
      for (const action of ["edit", "delete"]) {
        const other = fixture(`journal-${action}`, { groups: {} });
        const { repo: active, value } = opened(other);
        if (action === "delete") fs.unlinkSync(`${other}.journal.jsonl`);
        else fs.appendFileSync(`${other}.journal.jsonl`, "PRIVATE_SENTINEL");
        value.groups.a = { n: 1 };
        code(() => active.save(value), "MEMORY_EXTERNAL_CHANGE");
        active.close();
      }
    });

    await test("offline journal deletion is detected by the durable initialization witness", () => {
      const target = fixture("offline-journal-delete", { groups: { a: { n: 1 } } });
      const { repo } = opened(target); repo.close();
      fs.unlinkSync(`${target}.journal.jsonl`);
      const before = disk(path.dirname(target));
      code(() => readMemorySnapshot(target), "MEMORY_EXTERNAL_CHANGE");
      assert.deepEqual(disk(path.dirname(target)), before);
      const other = repository(target); other.acquireWriter();
      code(() => other.load(), "MEMORY_EXTERNAL_CHANGE");
      assert.equal(fs.existsSync(`${target}.journal.jsonl`), false);
      other.close();
    });

    await test("torn tail, checksum mismatch and forged inherited patch paths preserve evidence", () => {
      for (const variant of ["torn", "checksum", "inherited"]) {
        const target = fixture(`bad-journal-${variant}`, { groups: {} });
        const { repo, value } = opened(target, { failpoint(stage) { if (stage === "journal:durable") throw new Error("stop"); } });
        value.groups.a = { n: 1 }; code(() => repo.save(value), "MEMORY_IO"); repo.close();
        const journal = `${target}.journal.jsonl`;
        if (variant === "torn") fs.appendFileSync(journal, '{"PRIVATE_SENTINEL');
        else {
          const rows = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
          if (variant === "checksum") rows[1].checksum = "0".repeat(64);
          else {
            rows[1].ops = [{ op: "set", path: ["__proto__", "polluted"], value: true }];
            const { checksum, ...payload } = rows[1];
            rows[1].checksum = memoryRevision(payload);
          }
          fs.writeFileSync(journal, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        }
        const beforeSnapshot = fs.readFileSync(target);
        const beforeJournal = fs.readFileSync(journal);
        code(() => readMemorySnapshot(target), "MEMORY_JOURNAL_CORRUPT");
        const other = repository(target); other.acquireWriter();
        code(() => other.load(), "MEMORY_JOURNAL_CORRUPT"); other.close();
        assert.deepEqual(fs.readFileSync(target), beforeSnapshot);
        assert.deepEqual(fs.readFileSync(journal), beforeJournal);
        assert.equal({}.polluted, undefined);
      }
    });

    await test("bounded journal refusal leaves prior snapshot and evidence intact", () => {
      const target = fixture("journal-limit", { groups: {} });
      const { repo, value } = opened(target);
      const before = disk(path.dirname(target));
      value.groups.large = "x".repeat(16 * 1024 * 1024);
      code(() => repo.save(value), "MEMORY_LIMIT");
      assert.deepEqual(disk(path.dirname(target)), before);
      assert.equal(repo.status().recoveryRequired, false);
      repo.close();
      const journal = `${target}.journal.jsonl`;
      fs.appendFileSync(journal, "x".repeat(16 * 1024 * 1024));
      const digest = createHash("sha256").update(fs.readFileSync(journal)).digest("hex");
      code(() => readMemorySnapshot(target), "MEMORY_LIMIT");
      const other = repository(target); other.acquireWriter();
      code(() => other.load(), "MEMORY_LIMIT"); other.close();
      assert.equal(createHash("sha256").update(fs.readFileSync(journal)).digest("hex"), digest);
    });

    await test("reader races 100 actual child-process commits/compactions without stale/mixed records", async () => {
      const target = fixture("reader-race", { groups: { a: { counter: 0, paired: 0, legacy: ["b", "a", "b"] } } });
      const writer = child("stream", target); await writer.message("ready");
      writer.instance.send("go");
      let previous = 0;
      let reads = 0;
      while (!writer.messages.some((message) => message.type === "done")) {
        if (writer.messages.some((message) => message.type === "error")) assert.fail("stream writer failed");
        const value = readMemorySnapshot(target).groups.a;
        assert.equal(value.counter, value.paired);
        assert(value.counter >= previous, "reader regressed to a stale generation");
        assert.deepEqual(value.legacy, ["b", "a", "b"]);
        previous = value.counter;
        reads += 1;
        await delay(1);
      }
      assert(reads > 2);
      assert.equal(readMemorySnapshot(target).groups.a.counter, 100);
      await exit(writer.instance);
    });

    process.stdout.write(`memory repository self-test: PASS (${count} cases)\n`);
  } finally {
    for (const repo of repositories) { try { repo.close(); } catch {} }
    await Promise.all([...children].map((instance) => exit(instance, "SIGKILL")));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function cloneForTest(value) { return JSON.parse(JSON.stringify(value)); }
