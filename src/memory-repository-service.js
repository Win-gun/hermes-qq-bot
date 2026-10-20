import path from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { releaseStoppedMemoryWriter } from "./memory-repository.js";

const error = code => Object.assign(new Error(code), { name: "MemoryServiceError", code });

// Inspection only: never invoke toJSON/accessors while handing state to the
// worker. Unlike canonical hashing, this does not construct large JSON strings.
function inspect(value, ancestors = new Set(), depth = 0, budget = { nodes: 2_000_000 }) {
  if (--budget.nodes < 0 || depth > 128) throw error("MEMORY_LIMIT");
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw error("MEMORY_INVALID_JSON");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw error("MEMORY_INVALID_JSON");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string") || (array && keys.length !== value.length + 1)) throw error("MEMORY_INVALID_JSON");
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw error("MEMORY_INVALID_JSON");
    inspect(descriptor.value, ancestors, depth + 1, budget);
  }
  ancestors.delete(value);
}

/**
 * Lazy, bounded asynchronous facade for the SAME MemoryRepository format.
 * await open() -> save(value, {expectedRevision}) / read() -> await close().
 * A save snapshots input at postMessage, before returning its Promise. Caller
 * mutations cannot change that request. A valid worker rejection (CAS, bad JSON)
 * does not poison the writer. Worker failure/timeout is uncertain: latch, reject
 * pending requests and reopen explicitly; never silently repeat a write.
 * Status/errors contain fixed codes and revisions only, not paths or values.
 */
export class BackgroundMemoryRepository {
  #file; #worker = null; #opened = false; #opening = null; #closing = null;
  #closed = false; #fault = null; #sequence = 0; #pending = new Map();
  #token = randomUUID(); #stopping = null; #idleWaiters = [];
  #timeout; #limit; #status = { writer: false, loaded: false, writable: false, durability: "none", revision: null };

  constructor({ filePath, timeoutMs = 30_000, maxPending = 16 } = {}) {
    if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) throw error("MEMORY_PATH_UNSAFE");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw error("MEMORY_INVALID_REQUEST");
    this.#file = path.resolve(filePath); this.#timeout = timeoutMs; this.#limit = maxPending;
  }
  get revision() { return this.#status.revision; }
  status() {
    return { ...this.#status, closed: this.#closed, pending: this.#pending.size, background: true,
      recoveryRequired: Boolean(this.#fault || this.#status.recoveryRequired),
      lastError: this.#fault || this.#status.lastError || null,
      writable: this.#opened && !this.#closed && !this.#fault && this.#status.writable === true };
  }
  #fail(code) {
    this.#fault ||= code;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error(this.#fault)); }
    this.#pending.clear();
    this.#notifyIdle();
    const worker = this.#worker; this.#worker = null;
    if (worker) {
      this.#stopping = worker.terminate().then(() => releaseStoppedMemoryWriter(this.#file, this.#token))
        .catch(() => { throw error("MEMORY_CLEANUP_FAILED"); });
      void this.#stopping.catch(() => {});
    }
  }
  #notifyIdle() {
    if (!this.#pending.size) for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
  #request(kind, payload = {}) {
    if (this.#fault) return Promise.reject(error(this.#fault));
    if (!this.#worker) return Promise.reject(error("MEMORY_LOAD_REQUIRED"));
    if (this.#pending.size >= this.#limit) return Promise.reject(error("MEMORY_QUEUE_FULL"));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail("MEMORY_OPERATION_UNCERTAIN"), this.#timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#worker.postMessage({ id, kind, ...payload }); }
      catch {
        clearTimeout(timer); this.#pending.delete(id); this.#notifyIdle(); reject(error("MEMORY_INVALID_JSON"));
      }
    });
  }
  open() {
    if (this.#closed || this.#closing) return Promise.reject(error("MEMORY_CLOSED"));
    if (this.#opened) return this.read();
    if (this.#opening) return this.#opening;
    if (this.#fault) return Promise.reject(error(this.#fault));
    const worker = new Worker(new URL("./memory-repository-worker.js", import.meta.url), {
      execArgv: [], stdout: true, stderr: true, name: "memory-writer",
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }
    });
    this.#worker = worker;
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("message", message => {
      if (this.#worker !== worker) return;
      const pending = this.#pending.get(message?.id);
      if (!pending || typeof message.ok !== "boolean") { this.#fail("MEMORY_WORKER_FAILED"); return; }
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      this.#notifyIdle();
      if (message.status) this.#status = message.status;
      if (message.ok) pending.resolve(message.result);
      else pending.reject(error(/^MEMORY_[A-Z_]+$/.test(message.code || "") ? message.code : "MEMORY_IO"));
    });
    worker.on("error", () => { if (this.#worker === worker) this.#fail("MEMORY_WORKER_FAILED"); });
    worker.on("exit", () => {
      if (this.#worker !== worker) return;
      if (this.#closing && !this.#pending.size) { this.#worker = null; return; }
      this.#fail("MEMORY_OPERATION_UNCERTAIN");
    });
    this.#opening = this.#request("open", { filePath: this.#file, writerToken: this.#token }).then(result => {
      this.#opened = true; return result;
    });
    return this.#opening;
  }
  save(value, { expectedRevision } = {}) {
    if (this.#closed || this.#closing) return Promise.reject(error("MEMORY_CLOSED"));
    if (!this.#opened) return Promise.reject(error("MEMORY_LOAD_REQUIRED"));
    try { inspect(value); } catch (failure) { return Promise.reject(failure); }
    return this.#request("save", { value, expectedRevision });
  }
  // Return the exact durable worker snapshot for commit-before-publication.
  // Never give a caller a mutable alias to the snapshot while it is saving.
  commit(value, { expectedRevision, backupPath } = {}) {
    if (this.#closed || this.#closing) return Promise.reject(error("MEMORY_CLOSED"));
    if (!this.#opened) return Promise.reject(error("MEMORY_LOAD_REQUIRED"));
    try { inspect(value); } catch (failure) { return Promise.reject(failure); }
    if (backupPath !== undefined && (typeof backupPath !== "string" || backupPath.includes("\0")
      || path.dirname(path.resolve(backupPath)) !== path.dirname(this.#file)
      || !path.basename(backupPath).startsWith(`${path.basename(this.#file)}.bak.`))) return Promise.reject(error("MEMORY_PATH_UNSAFE"));
    return this.#request("commit", { value, expectedRevision, backupPath });
  }
  read() {
    if (this.#closed || this.#closing) return Promise.reject(error("MEMORY_CLOSED"));
    if (!this.#opened) return Promise.reject(error("MEMORY_LOAD_REQUIRED"));
    return this.#request("read");
  }
  integrity(options = {}) {
    if (this.#closed || this.#closing) return Promise.reject(error("MEMORY_CLOSED"));
    if (!this.#opened) return Promise.reject(error("MEMORY_LOAD_REQUIRED"));
    try { inspect(options); } catch (failure) { return Promise.reject(failure); }
    return this.#request("integrity", { options });
  }
  // Emergency supervisor shutdown, not a retry/cancel primitive. Any pending
  // operation becomes explicitly uncertain and requires a fresh recovered view.
  terminate() {
    this.#closed = true;
    this.#fail("MEMORY_OPERATION_UNCERTAIN");
    return this.#stopping || Promise.resolve();
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const worker = this.#worker;
    if (!worker) return this.#stopping || Promise.resolve();
    const drained = this.#pending.size ? new Promise(resolve => this.#idleWaiters.push(resolve)) : Promise.resolve();
    this.#closing = drained.then(() => this.#request("close")).finally(async () => {
      this.#worker = null; this.#opened = false;
      try { await worker.terminate(); } catch { throw error("MEMORY_CLEANUP_FAILED"); }
      await this.#stopping;
      releaseStoppedMemoryWriter(this.#file, this.#token);
    });
    return this.#closing;
  }
}
