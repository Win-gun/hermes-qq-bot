import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Local-filesystem, synchronous memory store. No bridge/runtime imports.
 *
 * acquireWriter() -> load() -> save(value, { expectedRevision }) -> close().
 * save returns the canonical revision (also for a no-op). Missing memory is
 * { groups: {} }; every other read/schema failure is an error, never a reset.
 *
 * Siblings: .writer/ (private bakery-lock tickets + initialization witness), .journal.jsonl (checkpoint
 * witness + incremental set/delete records). A commit is durable BEFORE the
 * atomic snapshot replacement. Each successful checkpoint atomically compacts
 * the journal to a content-free revision/hash witness, bounding replay. Limits:
 * 64 MiB snapshot, 16 MiB journal, 128 pending commits, depth 128. Exceeding a
 * limit refuses the operation without discarding evidence. Torn journal tails
 * are preserved and explicitly refused; they are NEVER silently truncated.
 *
 * Read-only readers replay a stable snapshot/journal pair without taking locks
 * or writing. load() establishes the writer baseline once, not an API refresh.
 * On any uncertain/failed commit this instance latches recoveryRequired: inspect
 * status(), close(), then reopen under the writer lock to recover. Do not retry
 * the mutation on the faulted instance. Errors/status never contain file data.
 *
 * All cooperating writers (including offline tools) must use this lock. Raw
 * external edits are detected by byte/hash/stat witnesses, including across
 * reopen via the journal witness. There is no portable filesystem CAS against
 * an uncooperative writer changing a path in the final check/rename window.
 * Requires a local filesystem with atomic rename/hard-link and directory fsync;
 * not a network/distributed lock. PID reuse conservatively refuses a live PID.
 * Unique private temporary files left by SIGKILL are not replayed or deleted.
 */

const MAX_SNAPSHOT = 64 * 1024 * 1024;
const MAX_JOURNAL = 16 * 1024 * 1024;
const MAX_COMMITS = 128;
const MAX_TICKETS = 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 2_000_000;
const FORMAT = Buffer.from("memory-repository-v1\n");
const HASH = /^[a-f0-9]{64}$/;
const TICKET = /^([1-9]\d*)-([a-f0-9-]{36})\.json$/;
const MESSAGES = {
  MEMORY_CORRUPT: "Memory JSON or schema is invalid.",
  MEMORY_INVALID_JSON: "Value is not supported JSON.",
  MEMORY_IO: "Memory filesystem operation failed.",
  MEMORY_LIMIT: "Memory repository safety limit exceeded.",
  MEMORY_PATH_UNSAFE: "Memory repository path is unsafe.",
  MEMORY_LOCKED: "Memory writer is already active or contending.",
  MEMORY_LOCK_CORRUPT: "Memory writer ticket is invalid; inspection required.",
  MEMORY_LOCK_LOST: "Memory writer ownership was lost.",
  MEMORY_WRITER_REQUIRED: "Acquire the memory writer before this operation.",
  MEMORY_LOAD_REQUIRED: "Load the memory writer baseline before saving.",
  MEMORY_CLOSED: "Memory repository is closed.",
  MEMORY_CAS_MISMATCH: "Memory revision precondition failed.",
  MEMORY_EXTERNAL_CHANGE: "Memory files changed outside this writer; inspection required.",
  MEMORY_JOURNAL_CORRUPT: "Memory journal is invalid or incomplete; evidence preserved.",
  MEMORY_READ_BUSY: "Memory view changed during the bounded read; retry later.",
  MEMORY_RECOVERY_REQUIRED: "Memory commit needs recovery; close and reopen before writing."
};

export class MemoryStoreError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.MEMORY_IO);
    this.name = "MemoryStoreError";
    this.code = Object.hasOwn(MESSAGES, code) ? code : "MEMORY_IO";
  }
}

function fail(code) { throw new MemoryStoreError(code); }
function mapped(error, fallback = "MEMORY_IO") {
  return error instanceof MemoryStoreError ? error : new MemoryStoreError(fallback);
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Inspect descriptors rather than invoking getters/toJSON. Own __proto__,
// constructor and prototype keys remain legal JSON data: no assignment/merge
// ever traverses inherited properties, and patch writes use defineProperty.
function canonical(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("MEMORY_LIMIT");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) fail("MEMORY_INVALID_JSON");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
      fail("MEMORY_INVALID_JSON");
    }
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) fail("MEMORY_INVALID_JSON");
    let result;
    if (array) {
      if (keys.length !== item.length + 1) fail("MEMORY_INVALID_JSON");
      const values = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("MEMORY_INVALID_JSON");
        values.push(visit(descriptor.value, depth + 1));
      }
      result = `[${values.join(",")}]`;
    } else {
      result = `{${keys.sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("MEMORY_INVALID_JSON");
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}

/** Canonical SHA-256 for ANY JSON value; object key order is insignificant. */
export function memoryRevision(value) {
  try { return hash(canonical(value)); } catch (error) { throw mapped(error, "MEMORY_INVALID_JSON"); }
}

function validateMemory(value) {
  try {
    canonical(value);
    if (!object(value) || !Object.hasOwn(value, "groups") || !object(value.groups)) fail("MEMORY_CORRUPT");
    return value;
  } catch (error) {
    if (error instanceof MemoryStoreError && error.code === "MEMORY_LIMIT") throw error;
    fail("MEMORY_CORRUPT");
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function serialize(value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_SNAPSHOT) fail("MEMORY_LIMIT");
  return bytes;
}
function location(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) fail("MEMORY_PATH_UNSAFE");
  return path.resolve(filePath);
}
function parse(bytes, code) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(code); }
}
function signature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function readFile(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail("MEMORY_PATH_UNSAFE");
    if (before.size > BigInt(limit)) fail("MEMORY_LIMIT");
    // Do not let a concurrently growing file turn a bounded read into an
    // unbounded allocation. The extra byte distinguishes exactly-at-limit.
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      chunks.push(chunk.subarray(0, length));
      total += length;
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    if (bytes.length > limit) fail("MEMORY_LIMIT");
    if (signature(before) !== signature(after)) fail("MEMORY_READ_BUSY");
    return { bytes, stamp: signature(after), hash: hash(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") fail("MEMORY_PATH_UNSAFE");
    throw mapped(error);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function same(a, b) { return a === null ? b === null : b !== null && a.stamp === b.stamp && a.hash === b.hash; }
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureDirectory(directory) {
  try {
    if (!fs.statSync(directory).isDirectory()) fail("MEMORY_PATH_UNSAFE");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ensureDirectory(path.dirname(directory));
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      syncDirectory(path.dirname(directory));
    } catch (createError) { if (createError.code !== "EEXIST") throw createError; }
    if (!fs.statSync(directory).isDirectory()) fail("MEMORY_PATH_UNSAFE");
  }
}
function writeNew(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function remove(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

function seal(payload) { return { ...payload, checksum: memoryRevision(payload) }; }
function checkpoint(revision, snapshotHash) {
  return seal({ version: 1, kind: "checkpoint", revision, snapshotHash });
}
function line(record) { return Buffer.from(`${JSON.stringify(record)}\n`); }
function validHash(value) { return typeof value === "string" && HASH.test(value); }
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(",") === keys.sort().join(",");
}

// Object keys (including numeric/empty/slash/__proto__ keys) are literal path
// segments, NOT dotted paths or JSON pointers. Arrays are indivisible leaves.
function operations(before, after, at = [], result = []) {
  if (object(before) && object(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) result.push({ op: "delete", path: [...at, key] });
    }
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) result.push({ op: "set", path: [...at, key], value: after[key] });
      else operations(before[key], after[key], [...at, key], result);
    }
  } else if (canonical(before) !== canonical(after)) {
    result.push({ op: "set", path: at, value: after });
  }
  return result;
}
function validateOperations(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_NODES) fail("MEMORY_JOURNAL_CORRUPT");
  for (const op of ops) {
    if (!object(op) || !["set", "delete"].includes(op.op)
      || !exactKeys(op, op.op === "set" ? ["op", "path", "value"] : ["op", "path"])
      || !Array.isArray(op.path) || !op.path.length || op.path.length > MAX_DEPTH
      || op.path.some((key) => typeof key !== "string")) fail("MEMORY_JOURNAL_CORRUPT");
  }
}
function apply(value, ops) {
  validateOperations(ops);
  for (const op of ops) {
    let parent = value;
    for (const key of op.path.slice(0, -1)) {
      if (!object(parent) || !Object.hasOwn(parent, key)) fail("MEMORY_JOURNAL_CORRUPT");
      parent = parent[key];
    }
    if (!object(parent)) fail("MEMORY_JOURNAL_CORRUPT");
    const key = op.path.at(-1);
    if (op.op === "delete") {
      if (!Object.hasOwn(parent, key)) fail("MEMORY_JOURNAL_CORRUPT");
      delete parent[key];
    } else {
      Object.defineProperty(parent, key, { value: clone(op.value), writable: true, configurable: true, enumerable: true });
    }
  }
  return validateMemory(value);
}
function decodeJournal(state) {
  if (!state) return [];
  const bytes = state.bytes;
  if (!bytes.length || bytes.at(-1) !== 10) fail("MEMORY_JOURNAL_CORRUPT");
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("MEMORY_JOURNAL_CORRUPT"); }
  const rows = decoded.split("\n");
  rows.pop();
  if (rows.length > MAX_COMMITS + 1) fail("MEMORY_LIMIT");
  return rows.map((row, index) => {
    const record = parse(Buffer.from(row), "MEMORY_JOURNAL_CORRUPT");
    const keys = index === 0
      ? ["version", "kind", "revision", "snapshotHash", "checksum"]
      : ["version", "kind", "parentRevision", "parentSnapshotHash", "revision", "snapshotHash", "ops", "checksum"];
    if (!exactKeys(record, keys) || record.version !== 1 || record.kind !== (index ? "commit" : "checkpoint")
      || !validHash(record.revision) || !validHash(record.checksum)
      || !(validHash(record.snapshotHash) || (!index && record.snapshotHash === null))) fail("MEMORY_JOURNAL_CORRUPT");
    const { checksum, ...payload } = record;
    try {
      if (memoryRevision(payload) !== checksum) fail("MEMORY_JOURNAL_CORRUPT");
    } catch (error) {
      if (error.code === "MEMORY_LIMIT") throw error;
      fail("MEMORY_JOURNAL_CORRUPT");
    }
    if (index) validateOperations(record.ops);
    return record;
  });
}
function materialize(pair) {
  if (pair.marker && !pair.marker.bytes.equals(FORMAT)) fail("MEMORY_JOURNAL_CORRUPT");
  if (pair.marker && !pair.journal) fail("MEMORY_EXTERNAL_CHANGE");
  let value = pair.snapshot ? validateMemory(parse(pair.snapshot.bytes, "MEMORY_CORRUPT")) : { groups: {} };
  const snapshotRevision = memoryRevision(value);
  const snapshotHash = pair.snapshot?.hash ?? null;
  const records = decodeJournal(pair.journal);
  if (!records.length) return { ...pair, value, revision: snapshotRevision, records, replayed: false };
  let match = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (index) {
      const parent = records[index - 1];
      if (record.parentRevision !== parent.revision || record.parentSnapshotHash !== parent.snapshotHash
        || record.revision === parent.revision || !Array.isArray(record.ops) || !record.ops.length) fail("MEMORY_JOURNAL_CORRUPT");
    }
    if (record.revision === snapshotRevision && record.snapshotHash === snapshotHash) match = index;
  }
  if (match < 0) fail("MEMORY_EXTERNAL_CHANGE");
  for (let index = match + 1; index < records.length; index += 1) {
    value = apply(value, records[index].ops);
    if (memoryRevision(value) !== records[index].revision || hash(serialize(value)) !== records[index].snapshotHash) {
      fail("MEMORY_JOURNAL_CORRUPT");
    }
  }
  return { ...pair, value, revision: records.at(-1).revision, records, replayed: match < records.length - 1 };
}
function stableView(filePath) {
  let last;
  const readPair = () => ({ snapshot: readFile(filePath, MAX_SNAPSHOT),
    journal: readFile(`${filePath}.journal.jsonl`, MAX_JOURNAL),
    marker: readFile(path.join(`${filePath}.writer`, "initialized"), 128) });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const pair = readPair();
      const next = readPair();
      if (!same(pair.snapshot, next.snapshot) || !same(pair.journal, next.journal) || !same(pair.marker, next.marker)) fail("MEMORY_READ_BUSY");
      return materialize(pair);
    } catch (error) {
      last = mapped(error);
      if (!["MEMORY_READ_BUSY", "MEMORY_EXTERNAL_CHANGE", "MEMORY_JOURNAL_CORRUPT"].includes(last.code)) throw last;
      if (attempt < 7) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw last;
}

/** Pure, lock-free materialized read. Missing ONLY is allowed. */
export function readMemorySnapshot(filePath) {
  try { return stableView(location(filePath)).value; } catch (error) { throw mapped(error); }
}

/** Internal worker-supervisor capability. Call ONLY after the worker using this
 * private, preallocated token is proven terminated. Never discovers/deletes
 * other tickets, initialization witnesses, journal data or memory snapshots. */
export function releaseStoppedMemoryWriter(filePath, token) {
  if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) fail("MEMORY_LOCK_LOST");
  const directory = `${location(filePath)}.writer`;
  try { if (fs.lstatSync(directory).isSymbolicLink()) fail("MEMORY_PATH_UNSAFE"); }
  catch (error) { if (error.code === "ENOENT") return; throw mapped(error); }
  const ticket = path.join(directory, `${process.pid}-${token}.json`);
  const state = readFile(ticket, 4096);
  if (state) {
    const owner = parse(state.bytes, "MEMORY_LOCK_LOST");
    if (!exactKeys(owner, ["pid", "token", "number"]) || owner.pid !== process.pid || owner.token !== token
      || !Number.isSafeInteger(owner.number) || owner.number < 0) fail("MEMORY_LOCK_LOST");
    remove(ticket);
  }
  // Publication temp files contain only our lock metadata, never user data.
  // Like dead-PID cleanup, the proven-stopped worker cannot still publish them.
  const temporary = `${ticket}.tmp`;
  if (readFile(temporary, 4096)) remove(temporary);
  syncDirectory(directory);
}

export class MemoryRepository {
  #file; #journal; #directory; #lockDirectory; #marker; #ticket = null; #owner = null;
  #loaded = false; #closed = false; #value; #revision = null; #durableRevision = null;
  #baseline; #fault = null; #phase = "idle"; #durability = "none"; #failpoint; #writerToken;

  // Optional callback for fault-injection by callers/tests. No environment flags,
  // fs replacement, data arguments or production durability bypasses.
  constructor({ filePath, failpoint, writerToken } = {}) {
    this.#file = location(filePath);
    this.#journal = `${this.#file}.journal.jsonl`;
    this.#directory = path.dirname(this.#file);
    this.#lockDirectory = `${this.#file}.writer`;
    this.#marker = path.join(this.#lockDirectory, "initialized");
    if (failpoint !== undefined && typeof failpoint !== "function") fail("MEMORY_INVALID_JSON");
    this.#failpoint = failpoint;
    if (writerToken !== undefined && (typeof writerToken !== "string" || !/^[a-f0-9-]{36}$/.test(writerToken))) fail("MEMORY_LOCK_LOST");
    this.#writerToken = writerToken;
  }
  get revision() { return this.#revision; }
  status() {
    return {
      writer: this.#ticket !== null, loaded: this.#loaded, closed: this.#closed,
      revision: this.#revision, durableRevision: this.#durableRevision,
      recoveryRequired: this.#fault !== null, lastError: this.#fault,
      degraded: this.#fault !== null,
      writable: this.#ticket !== null && this.#loaded && !this.#closed && !this.#fault,
      phase: this.#phase, durability: this.#durability
    };
  }
  #hit(stage) { this.#phase = stage; this.#failpoint?.(stage); }
  #usable() {
    if (this.#closed) fail("MEMORY_CLOSED");
    if (this.#fault) fail("MEMORY_RECOVERY_REQUIRED");
    if (!this.#ticket) fail("MEMORY_WRITER_REQUIRED");
    try { this.#assertOwner(); }
    catch (error) { const safe = mapped(error); this.#fault = safe.code; throw safe; }
  }
  #assertOwner() {
    const state = readFile(this.#ticket, 4096);
    if (!state || state.hash !== hash(Buffer.from(JSON.stringify(this.#owner)))) fail("MEMORY_LOCK_LOST");
  }
  #publishTicket(initial) {
    const temporary = `${this.#ticket}.tmp`;
    try {
      writeNew(temporary, JSON.stringify(this.#owner));
      if (initial) fs.linkSync(temporary, this.#ticket);
      else { this.#assertOwnerChoosing(); fs.renameSync(temporary, this.#ticket); }
      syncDirectory(this.#lockDirectory);
    } finally { remove(temporary); }
  }
  #assertOwnerChoosing() {
    const state = readFile(this.#ticket, 4096);
    const previous = { ...this.#owner, number: 0 };
    if (!state || state.hash !== hash(Buffer.from(JSON.stringify(previous)))) fail("MEMORY_LOCK_LOST");
  }
  #tickets() {
    const entries = fs.readdirSync(this.#lockDirectory);
    if (entries.length > MAX_TICKETS) fail("MEMORY_LIMIT");
    const result = [];
    for (const name of entries) {
      if (name === "initialized") continue;
      const match = TICKET.exec(name);
      if (!match) {
        // Only our own unpublished temp format is recognized. Dead-owner temp
        // cleanup cannot unlink another contender's uniquely named ticket.
        const temporary = TICKET.exec(name.replace(/\.tmp$/, ""));
        if (!temporary || !name.endsWith(".tmp")) fail("MEMORY_LOCK_CORRUPT");
        if (!alive(Number(temporary[1]))) remove(path.join(this.#lockDirectory, name));
        continue;
      }
      const file = path.join(this.#lockDirectory, name);
      const state = readFile(file, 4096);
      if (!state) continue;
      const ticket = parse(state.bytes, "MEMORY_LOCK_CORRUPT");
      if (!exactKeys(ticket, ["pid", "token", "number"]) || ticket.pid !== Number(match[1]) || ticket.token !== match[2]
        || !Number.isSafeInteger(ticket.pid) || ticket.pid < 1
        || !Number.isSafeInteger(ticket.number) || ticket.number < 0) fail("MEMORY_LOCK_CORRUPT");
      if (!alive(ticket.pid)) { remove(file); continue; }
      result.push(ticket);
    }
    return result;
  }
  acquireWriter() {
    if (this.#closed) fail("MEMORY_CLOSED");
    if (this.#ticket) { this.#usable(); return this; }
    try {
      ensureDirectory(this.#directory);
      ensureDirectory(this.#lockDirectory);
      if (fs.lstatSync(this.#lockDirectory).isSymbolicLink()) fail("MEMORY_PATH_UNSAFE");
      this.#owner = { pid: process.pid, token: this.#writerToken || randomUUID(), number: 0 };
      this.#ticket = path.join(this.#lockDirectory, `${process.pid}-${this.#owner.token}.json`);
      this.#publishTicket(true);
      this.#hit("lock:published");
      const tickets = this.#tickets();
      const maximum = Math.max(0, ...tickets.map((ticket) => ticket.number));
      if (maximum >= Number.MAX_SAFE_INTEGER) fail("MEMORY_LIMIT");
      this.#owner.number = maximum + 1;
      this.#publishTicket(false);
      this.#hit("lock:selected");
      for (const ticket of this.#tickets()) {
        if (ticket.token === this.#owner.token) continue;
        if (ticket.number === 0 || ticket.number < this.#owner.number
          || (ticket.number === this.#owner.number && ticket.token < this.#owner.token)) fail("MEMORY_LOCKED");
      }
      this.#hit("lock:acquired");
      this.#phase = "locked";
      return this;
    } catch (error) {
      // Never delete an entry unless it still bears our unique identity.
      this.#releaseTicket();
      throw mapped(error);
    }
  }
  #releaseTicket() {
    if (!this.#ticket) return;
    try {
      const state = readFile(this.#ticket, 4096);
      if (state) {
        const value = parse(state.bytes, "MEMORY_LOCK_LOST");
        if (value.pid !== process.pid || value.token !== this.#owner.token) fail("MEMORY_LOCK_LOST");
        remove(this.#ticket);
        syncDirectory(this.#lockDirectory);
      }
    } finally { this.#ticket = null; this.#owner = null; }
  }
  #assertUnchanged() {
    this.#assertOwner();
    if (!same(readFile(this.#file, MAX_SNAPSHOT), this.#baseline.snapshot)
      || !same(readFile(this.#journal, MAX_JOURNAL), this.#baseline.journal)
      || !same(readFile(this.#marker, 128), this.#baseline.marker)) fail("MEMORY_EXTERNAL_CHANGE");
  }
  #atomic(file, bytes, kind) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeNew(temporary, bytes);
      this.#hit(`${kind}:tempDurable`);
      this.#assertUnchanged();
      this.#hit(`${kind}:beforeRename`);
      // A failpoint/caller cannot bypass the final external-change check.
      this.#assertUnchanged();
      fs.renameSync(temporary, file);
      this.#hit(`${kind}:renamed`);
      syncDirectory(this.#directory);
      if (kind === "snapshot") this.#baseline.snapshot = readFile(file, MAX_SNAPSHOT);
      else this.#baseline.journal = readFile(file, MAX_JOURNAL);
      const installed = kind === "snapshot" ? this.#baseline.snapshot : this.#baseline.journal;
      if (!installed || installed.hash !== hash(bytes)) fail("MEMORY_EXTERNAL_CHANGE");
      this.#hit(`${kind}:durable`);
    } finally { remove(temporary); }
  }
  #compact() {
    const bytes = line(checkpoint(this.#revision, this.#baseline.snapshot?.hash ?? null));
    this.#atomic(this.#journal, bytes, "journalCheckpoint");
    this.#hit("journal:compacted");
  }
  load() {
    this.#usable();
    try {
      if (this.#loaded) { this.#assertUnchanged(); return clone(this.#value); }
      const view = stableView(this.#file);
      this.#baseline = { snapshot: view.snapshot, journal: view.journal, marker: view.marker };
      this.#value = view.value;
      this.#revision = view.revision;
      this.#durableRevision = view.revision;
      if (view.replayed) {
        this.#durability = "committed";
        this.#atomic(this.#file, serialize(view.value), "snapshot");
      }
      if (!view.journal || view.records.length > 1) this.#compact();
      if (!view.marker) {
        this.#assertUnchanged();
        // Publish a COMPLETE marker atomically; a crash during its creation must
        // not strand a partial marker. It is a witness, not a writer lock.
        const temporary = `${this.#ticket}.tmp`;
        try {
          writeNew(temporary, FORMAT);
          this.#assertUnchanged();
          fs.linkSync(temporary, this.#marker);
          syncDirectory(this.#lockDirectory);
        } finally { remove(temporary); }
        this.#baseline.marker = readFile(this.#marker, 128);
        if (!this.#baseline.marker?.bytes.equals(FORMAT)) fail("MEMORY_EXTERNAL_CHANGE");
      }
      this.#assertUnchanged();
      this.#loaded = true;
      this.#durability = "checkpointed";
      this.#phase = "ready";
      return clone(this.#value);
    } catch (error) {
      const safe = mapped(error);
      this.#fault = safe.code;
      throw safe;
    }
  }
  save(value, { expectedRevision } = {}) {
    this.#usable();
    if (!this.#loaded) fail("MEMORY_LOAD_REQUIRED");
    // All validation/precondition checks occur before journal mutation.
    validateMemory(value);
    const targetRevision = memoryRevision(value);
    if (expectedRevision !== undefined && expectedRevision !== this.#revision) fail("MEMORY_CAS_MISMATCH");
    let started = false;
    try {
      this.#assertUnchanged();
      if (targetRevision === this.#revision) return this.#revision;
      const ops = operations(this.#value, value);
      const next = apply(clone(this.#value), ops);
      const bytes = serialize(next);
      if (memoryRevision(next) !== targetRevision) fail("MEMORY_CORRUPT");
      const record = line(seal({ version: 1, kind: "commit",
        parentRevision: this.#revision, parentSnapshotHash: this.#baseline.snapshot?.hash ?? null,
        revision: targetRevision, snapshotHash: hash(bytes), ops }));
      if (this.#baseline.journal.bytes.length + record.length > MAX_JOURNAL) fail("MEMORY_LIMIT");
      this.#hit("journal:beforeAppend");
      this.#assertUnchanged();
      started = true;
      this.#durability = "uncertain";
      const fd = fs.openSync(this.#journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      try {
        fs.writeFileSync(fd, record);
        this.#hit("journal:appended");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const journal = readFile(this.#journal, MAX_JOURNAL);
      if (!journal || journal.hash !== hash(Buffer.concat([this.#baseline.journal.bytes, record]))) fail("MEMORY_EXTERNAL_CHANGE");
      this.#baseline.journal = journal;
      this.#durableRevision = targetRevision;
      this.#durability = "committed";
      this.#hit("journal:durable");
      this.#atomic(this.#file, bytes, "snapshot");
      this.#value = next;
      this.#revision = targetRevision;
      this.#compact();
      this.#assertUnchanged();
      this.#durability = "checkpointed";
      this.#phase = "ready";
      return this.#revision;
    } catch (error) {
      const safe = mapped(error);
      if (started || safe.code === "MEMORY_EXTERNAL_CHANGE" || safe.code === "MEMORY_LOCK_LOST") this.#fault = safe.code;
      throw safe;
    }
  }
  close() {
    if (this.#closed) return;
    try { this.#releaseTicket(); }
    catch (error) { const safe = mapped(error); this.#fault = safe.code; throw safe; }
    finally { this.#closed = true; this.#phase = "closed"; }
  }
}
