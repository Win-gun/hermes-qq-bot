import { realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const MiB = 1024 * 1024;
const MAX_TIMEOUT = 2_147_483_647;
const WORKER_CODES = new Set(["SEARCH_FAILED", "SOURCE_LIMIT", "INDEX_LIMIT", "RESULT_LIMIT"]);
// Multiple service instances in this module must not race the same cache either.
const heldDirectories = new Map();
const directoryWaiters = new Set();

function failure(code) {
  const error = new Error(code);
  error.name = "ArchiveSearchError";
  error.code = code;
  // Native errors, abort reasons, paths and worker stacks must never escape.
  error.stack = `ArchiveSearchError: ${code}`;
  return error;
}

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure("INVALID_OPTIONS");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !keys.includes(key) || !("value" in descriptors[key])) throw failure("INVALID_OPTIONS");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function integer(value, fallback, min, max) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw failure("INVALID_OPTIONS");
  return number;
}

function selectors(value, ids) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw failure("INVALID_OPTIONS");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure("INVALID_OPTIONS");
  const result = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = descriptors[i];
    if (!descriptor || !("value" in descriptor)) throw failure("INVALID_OPTIONS");
    const item = descriptor.value;
    if (typeof item === "string" && item.length <= 1024) result.push(item);
    else if (ids && typeof item === "number" && Number.isSafeInteger(item)) result.push(item);
    else throw failure("INVALID_OPTIONS");
  }
  return result;
}

function searchOptions(value, kind) {
  const input = object(value, ["terms", "senderIds", "messageIds", "maxCandidates", "policyKey", "privacyFilter",
    ...(kind === "context" ? ["conversationId", "neighborWindow", "maxNeighbors", "maxQuoted", "quoteDepth"] : [])]);
  const options = {
    terms: selectors(input.terms, false), senderIds: selectors(input.senderIds, true),
    messageIds: selectors(input.messageIds, true),
    maxCandidates: integer(input.maxCandidates, 200, 0, 1000)
  };
  if (input.policyKey !== undefined) {
    if (typeof input.policyKey !== "string" || !input.policyKey.length || input.policyKey.length > 256) throw failure("INVALID_OPTIONS");
    options.policyKey = input.policyKey;
  }
  if (Object.hasOwn(input, "privacyFilter")) {
    if (typeof input.privacyFilter !== "boolean") throw failure("INVALID_OPTIONS");
    options.privacyFilter = input.privacyFilter;
  }
  if (kind === "context") {
    if (input.conversationId !== undefined) {
      if (typeof input.conversationId !== "string" || !input.conversationId.length || input.conversationId.length > 1024) throw failure("INVALID_OPTIONS");
      options.conversationId = input.conversationId;
    }
    options.neighborWindow = integer(input.neighborWindow, 1, 0, 2);
    options.maxNeighbors = integer(input.maxNeighbors, 6, 0, 12);
    options.maxQuoted = integer(input.maxQuoted, 6, 0, 12);
    options.quoteDepth = integer(input.quoteDepth, 2, 0, 2);
    if (options.maxNeighbors + options.maxQuoted > 12) throw failure("INVALID_OPTIONS");
  }
  if (Buffer.byteLength(JSON.stringify(options)) > 32 * 1024) throw failure("INVALID_OPTIONS");
  return options;
}

function emptyResult(kind) { return kind === "context" ? { matches: [], neighbors: [], quoted: [] } : []; }

function validResult(kind, value) {
  const record = (item) => item && typeof item === "object" && !Array.isArray(item);
  if (kind === "search") return Array.isArray(value) && value.every(record);
  if (!record(value) || Object.keys(value).sort().join(",") !== "matches,neighbors,quoted"
    || ![value.matches, value.neighbors, value.quoted].every(Array.isArray)
    || value.neighbors.length + value.quoted.length > 12) return false;
  const relation = (item) => record(item) && typeof item.anchorMessageId === "string" && item.anchorMessageId.length > 0 && record(item.record);
  return value.matches.every(record) && value.neighbors.every(relation) && value.quoted.every(relation);
}

/**
 * Background wrapper around searchArchiveRecords; no bridge/runtime side effects.
 *
 * new ArchiveSearchService({ maxWorkers=1 (1..8), queueLimit=32 (0..1024),
 *   timeoutMs=30000 (1..2147483647), maxSourceBytes=64MiB (1..1GiB),
 *   maxIndexBytes=64MiB (1..256MiB), maxResultBytes=4MiB (1..16MiB),
 *   resourceLimits={ maxOldGenerationSizeMb:256, maxYoungGenerationSizeMb:16,
 *     codeRangeSizeMb:16, stackSizeMb:4 } }).
 * Resource overrides: old 16..1024, young 4..64, code 1..64, stack 1..8 MiB.
 * Node/V8 heap limits are NOT a process-wide RSS/security sandbox.
 *
 * search(file, options={}, {signal, timeoutMs}={}) -> Promise<sanitized records>.
 * context(file, options={}, controls={}) -> Promise<{matches,neighbors,quoted}>.
 * Context additionally accepts conversationId, neighborWindow=1 (0..2),
 * maxNeighbors=6/maxQuoted=6 (sum<=12), quoteDepth=2 (0..2); see sync API docs
 * for bounded reads, ordering and legacy conversation handling.
 * Only terms/senderIds/messageIds/maxCandidates/policyKey/privacyFilter are
 * accepted for search; callbacks,
 * code strings as callbacks and unknown/accessor fields are refused (no eval).
 * Selectors: dense arrays, <=256 items each; strings <=1024 UTF-16 units;
 * IDs also accept safe integers; combined options <=32KiB; candidates 0..1000;
 * policyKey is an optional nonempty string <=256 units, NOT a privacy override.
 * Omitted privacyFilter preserves archive-search-index.js's default sanitizer.
 * Explicit boolean uses shared sanitizeArchiveValue; policy includes shared-v1,
 * the privacy flag and caller policyKey. false deliberately preserves raw data.
 * No sanitizer/function crosses the worker boundary. This is
 * NOT the bridge's authoritative privacy/permission filter; apply that at integration.
 * Missing sources return []; directories/nonregular/unsafe cache files fail closed.
 *
 * Admission is bounded to maxWorkers reserved/active jobs + queueLimit waiting.
 * A slot includes async path resolution/directory-lock waiting; deadline starts
 * at admission, including queue time. Pending abort removes only that job;
 * running abort/timeout kills its worker. Directory locks stay held until exit
 * AND owned temporary-cache cleanup. Workers are lazy and reused after success.
 * Directory locks also cover other instances of this module, not other processes
 * or independent synchronous index writers. Prefer one shared service at integration.
 *
 * status() exposes only fixed codes/counts. Errors contain code-only message and
 * stack (never path/query/abort reason/cause). Codes: INVALID_OPTIONS, INVALID_FILE,
 * CLOSED, QUEUE_FULL, ABORTED, TIMEOUT, WORKER_FAILED, RESOURCE_LIMIT,
 * SEARCH_FAILED, SOURCE_LIMIT, INDEX_LIMIT, RESULT_LIMIT, CLEANUP_FAILED.
 * close() is idempotent -> Promise<void>, rejects all jobs with CLOSED, clears
 * timers/listeners, terminates even idle workers and awaits cleanup. Always await it.
 * Any non-ENOENT temp cleanup failure latches one safe CLEANUP_FAILED; close
 * rejects only AFTER every retirement finishes. Repeated close returns the same
 * rejected promise, without retrying cleanup or exposing the original fs error.
 * Size limits reject (not silently truncate); heap/size/IO errors never trigger
 * synchronous main-thread fallback. Limits may reject archives the sync API accepts.
 */
export class ArchiveSearchService {
  #config;
  #slots = [];
  #queue = [];
  #closed = false;
  #closing;
  #cleanupFailure;
  #counts = { accepted: 0, completed: 0, rejected: 0, workerStarts: 0 };
  #errors = {};
  #wake = () => this.#pump();

  constructor(options = {}) {
    try {
      const input = object(options, ["maxWorkers", "queueLimit", "timeoutMs", "maxSourceBytes", "maxIndexBytes", "maxResultBytes", "resourceLimits"]);
      const resources = object(input.resourceLimits === undefined ? {} : input.resourceLimits,
        ["maxOldGenerationSizeMb", "maxYoungGenerationSizeMb", "codeRangeSizeMb", "stackSizeMb"]);
      this.#config = {
        maxWorkers: integer(input.maxWorkers, 1, 1, 8), queueLimit: integer(input.queueLimit, 32, 0, 1024),
        timeoutMs: integer(input.timeoutMs, 30000, 1, MAX_TIMEOUT),
        maxSourceBytes: integer(input.maxSourceBytes, 64 * MiB, 1, 1024 * MiB),
        maxIndexBytes: integer(input.maxIndexBytes, 64 * MiB, 1, 256 * MiB),
        maxResultBytes: integer(input.maxResultBytes, 4 * MiB, 1, 16 * MiB),
        resourceLimits: {
          maxOldGenerationSizeMb: integer(resources.maxOldGenerationSizeMb, 256, 16, 1024),
          maxYoungGenerationSizeMb: integer(resources.maxYoungGenerationSizeMb, 16, 4, 64),
          codeRangeSizeMb: integer(resources.codeRangeSizeMb, 16, 1, 64),
          stackSizeMb: integer(resources.stackSizeMb, 4, 1, 8)
        }
      };
    } catch { throw failure("INVALID_OPTIONS"); }
  }

  #error(code) {
    this.#counts.rejected += 1;
    this.#errors[code] = (this.#errors[code] || 0) + 1;
    return failure(code);
  }

  search(file, options = {}, controls = {}) {
    return this.#submit("search", file, options, controls);
  }

  context(file, options = {}, controls = {}) {
    return this.#submit("context", file, options, controls);
  }

  #submit(kind, file, options, controls) {
    if (this.#closed) return Promise.reject(this.#error("CLOSED"));
    let query, control, timeoutMs;
    try {
      if (typeof file !== "string" || !file.length || file.length > 4096 || file.includes("\0")) throw failure("INVALID_FILE");
      query = searchOptions(options, kind);
      control = object(controls, ["signal", "timeoutMs"]);
      if (control.signal !== undefined && !(control.signal instanceof AbortSignal)) throw failure("INVALID_OPTIONS");
      timeoutMs = integer(control.timeoutMs, this.#config.timeoutMs, 1, MAX_TIMEOUT);
    } catch (error) {
      return Promise.reject(this.#error(error?.code === "INVALID_FILE" ? "INVALID_FILE" : "INVALID_OPTIONS"));
    }
    if (control.signal?.aborted) return Promise.reject(this.#error("ABORTED"));
    const free = this.#slots.find((slot) => !slot.job && !slot.stopping);
    if (!free && this.#slots.length >= this.#config.maxWorkers && this.#queue.length >= this.#config.queueLimit) {
      return Promise.reject(this.#error("QUEUE_FULL"));
    }
    // Snapshot relative paths now; later cwd changes must not redirect queued work.
    const source = path.resolve(file);
    return new Promise((resolve, reject) => {
      const job = { kind, file: source, options: query, resolve, reject, signal: control.signal, done: false };
      this.#counts.accepted += 1;
      job.abort = () => this.#cancel(job, "ABORTED");
      job.timer = setTimeout(() => this.#cancel(job, "TIMEOUT"), timeoutMs);
      job.signal?.addEventListener("abort", job.abort, { once: true });
      this.#queue.push(job);
      this.#pump();
      if (job.signal?.aborted) this.#cancel(job, "ABORTED");
    });
  }

  #settle(job, code, records) {
    if (!job || job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.timer = null;
    job.signal?.removeEventListener("abort", job.abort);
    if (code) job.reject(this.#error(code));
    else { this.#counts.completed += 1; job.resolve(records); }
  }

  #cancel(job, code) {
    if (job.done) return;
    this.#settle(job, code);
    const index = this.#queue.indexOf(job);
    if (index !== -1) this.#queue.splice(index, 1);
    const slot = job.slot;
    if (slot?.job === job) {
      if (slot.running) this.#retire(slot);
      else { slot.job = null; slot.ready = false; }
    }
    this.#pump();
  }

  #pump() {
    directoryWaiters.delete(this.#wake);
    if (this.#closed) return;
    while (this.#queue.length) {
      let slot = this.#slots.find((item) => !item.job && !item.stopping);
      if (!slot && this.#slots.length < this.#config.maxWorkers) {
        slot = { worker: null, job: null, ready: false, running: false, stopping: false };
        this.#slots.push(slot);
      }
      if (!slot) break;
      const job = this.#queue.shift();
      slot.job = job;
      job.slot = slot;
      // No source/index fs work, scanning or JSON parsing on the bridge thread.
      void this.#prepare(slot, job);
    }
    for (const slot of this.#slots) {
      if (!slot.ready || slot.running || slot.stopping || !slot.job) continue;
      if (heldDirectories.has(slot.job.key)) { directoryWaiters.add(this.#wake); continue; }
      this.#start(slot);
    }
  }

  #release(slot, key) {
    // A prepared/waiting slot may have the SAME key but does not own the lease.
    // In particular, close() must not release a sibling's still-running writer.
    if (heldDirectories.get(key) !== slot) return;
    heldDirectories.delete(key);
    for (const wake of [...directoryWaiters]) wake();
  }

  async #prepare(slot, job) {
    try {
      const file = await realpath(job.file);
      if (job.done || slot.job !== job) return;
      job.file = file;
      job.key = path.dirname(file); // the sync cache is DIRECTORY-local
      job.temporary = path.join(job.key, `search-index.json.${randomUUID()}.tmp`);
      slot.ready = true;
      this.#pump();
    } catch (error) {
      if (job.done || slot.job !== job) return;
      slot.job = null;
      this.#settle(job, error?.code === "ENOENT" ? null : "SEARCH_FAILED", emptyResult(job.kind));
      this.#pump();
    }
  }

  #start(slot) {
    const job = slot.job;
    heldDirectories.set(job.key, slot);
    slot.running = true;
    slot.ready = false;
    try {
      if (!slot.worker) {
        const worker = new Worker(new URL("./archive-search-worker.js", import.meta.url), {
          resourceLimits: { ...this.#config.resourceLimits }, execArgv: [], stdout: true, stderr: true,
          name: "archive-search"
        });
        slot.worker = worker;
        this.#counts.workerStarts += 1;
        // Do not forward worker/native diagnostics containing paths or contents.
        worker.stdout.resume();
        worker.stderr.resume();
        worker.on("message", (message) => {
          if (slot.worker !== worker || slot.stopping || !slot.running) return;
          if (!message || message.id !== slot.job.id || message.kind !== slot.job.kind || !["ok", "error"].includes(message.type)
            || (message.type === "ok" && !validResult(slot.job.kind, message.records))) {
            this.#settle(slot.job, "WORKER_FAILED");
            this.#retire(slot);
            return;
          }
          const code = message.type === "error" ? (WORKER_CODES.has(message.code) ? message.code : "SEARCH_FAILED") : null;
          if (code) {
            this.#settle(slot.job, code);
            this.#retire(slot);
            return;
          }
          const current = slot.job;
          this.#release(slot, current.key);
          slot.job = null;
          slot.running = false;
          this.#settle(current, code, message.records);
          this.#pump();
        });
        worker.on("error", (error) => {
          if (slot.worker !== worker) return;
          this.#settle(slot.job, error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "RESOURCE_LIMIT" : "WORKER_FAILED");
          this.#retire(slot);
        });
        worker.on("exit", () => {
          if (slot.worker !== worker) return;
          this.#settle(slot.job, "WORKER_FAILED");
          this.#retire(slot);
        });
      }
      job.id = randomUUID();
      slot.worker.postMessage({ id: job.id, kind: job.kind, file: job.file, options: job.options, temporary: job.temporary,
        limits: { maxSourceBytes: this.#config.maxSourceBytes, maxIndexBytes: this.#config.maxIndexBytes,
          maxResultBytes: this.#config.maxResultBytes } });
    } catch {
      this.#settle(job, "WORKER_FAILED");
      this.#retire(slot);
    }
  }

  #retire(slot) {
    if (slot.stopping) return slot.stopping;
    const worker = slot.worker;
    const job = slot.job;
    slot.stopping = Promise.resolve().then(async () => {
      // Even cancellation during index publication cannot race a replacement.
      if (worker) await worker.terminate();
      if (job?.temporary) {
        try { await unlink(job.temporary); }
        catch (error) {
          if (error.code !== "ENOENT") {
            // Fail closed: an uncertain cache cleanup must not reuse this lane.
            // Latch only a fixed safe error; retirement itself must finish so
            // locks, peer workers and queued jobs are still fully released.
            this.#cleanupFailure ??= this.#error("CLEANUP_FAILED");
            void this.close().catch(() => {});
          }
        }
      }
      this.#release(slot, job?.key);
      slot.worker = null;
      slot.job = null;
      slot.running = false;
      slot.ready = false;
      slot.stopping = false;
      this.#pump();
    });
    return slot.stopping;
  }

  status() {
    const jobs = [...this.#queue, ...this.#slots.map((slot) => slot.job).filter(Boolean)];
    return { code: this.#closed ? "CLOSED" : "OPEN", workers: this.#slots.filter((slot) => slot.worker).length,
      active: this.#slots.filter((slot) => slot.job && !slot.job.done).length,
      running: this.#slots.filter((slot) => slot.running && !slot.stopping).length,
      queued: this.#queue.length, stopping: this.#slots.filter((slot) => slot.stopping).length,
      timers: jobs.filter((job) => job.timer !== null).length,
      ...this.#counts, errors: { ...this.#errors } };
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    directoryWaiters.delete(this.#wake);
    for (const job of this.#queue.splice(0)) this.#settle(job, "CLOSED");
    const endings = this.#slots.map((slot) => {
      this.#settle(slot.job, "CLOSED");
      return this.#retire(slot);
    });
    this.#closing = Promise.all(endings).then(() => {
      if (this.#cleanupFailure) throw this.#cleanupFailure;
    });
    return this.#closing;
  }
}
