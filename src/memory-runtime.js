import { reconcileMemoryInPlace } from "./memory-state.js";

const failure = code => Object.assign(new Error(code), { code });

/**
 * One serial transaction lane for the live root. Builders are synchronous and
 * operate only on a fresh private draft; model/tool awaits happen OUTSIDE them.
 * Persistence is asynchronous, publication occurs only after durable success.
 * Readers may retain references, but MUST NOT mutate value. All changes,
 * including ingestion, controls, extraction ACKs and rebuilds use transact().
 */
export class MemoryRuntime {
  #repository; #value; #revision; #tail = Promise.resolve(); #pending = 0;
  #closed = false; #closing; #limit;
  constructor(repository, { maxPending = 64 } = {}) {
    if (!repository || typeof repository.open !== "function" || typeof repository.commit !== "function") throw failure("MEMORY_INVALID_REQUEST");
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw failure("MEMORY_INVALID_REQUEST");
    this.#repository = repository; this.#limit = maxPending;
  }
  async open() {
    if (this.#closed) throw failure("MEMORY_CLOSED");
    if (this.#value) throw failure("MEMORY_ALREADY_OPEN");
    const opened = await this.#repository.open();
    this.#value = opened.value; this.#revision = opened.revision;
    return this.#value;
  }
  get value() { return this.#value; }
  get revision() { return this.#revision; }
  status() { return { ...this.#repository.status(), queuedTransactions: this.#pending }; }
  transact(build, { backupPath } = {}) {
    if (this.#closed) return Promise.reject(failure("MEMORY_CLOSED"));
    if (!this.#value) return Promise.reject(failure("MEMORY_LOAD_REQUIRED"));
    if (typeof build !== "function" || build.constructor.name === "AsyncFunction") return Promise.reject(failure("MEMORY_ASYNC_MUTATOR"));
    if (this.#pending >= this.#limit) return Promise.reject(failure("MEMORY_QUEUE_FULL"));
    this.#pending += 1;
    const operation = this.#tail.then(async () => {
      const draft = structuredClone(this.#value);
      const result = build(draft);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw failure("MEMORY_ASYNC_MUTATOR");
      }
      // Publish the worker's actual durable snapshot, never a caller-owned
      // alias assigned by the builder while persistence is in progress.
      const { value: submitted, revision } = await this.#repository.commit(draft, { expectedRevision: this.#revision, backupPath });
      // No await between the durable acknowledgment and publication. The next
      // queued builder cannot capture an old root or erase new input.
      reconcileMemoryInPlace(this.#value, submitted);
      this.#revision = revision;
      return result;
    }).finally(() => { this.#pending -= 1; });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  barrier() { return this.#tail; }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#tail.then(() => this.#repository.close());
    return this.#closing;
  }
}
