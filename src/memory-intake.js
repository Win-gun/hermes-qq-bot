const failure = code => Object.assign(new Error(code), { code });

/** Bounded raw-message coalescing, NOT a second memory writer.
 * Each batch uses the existing latest-draft transaction and resolves only after
 * durable publication. Controls, rebuilds and extraction ACKs are never batched
 * here. A failed batch rejects every affected input: no partial acceptance, no
 * implicit retry of an uncertain write. Raw archive remains upstream evidence.
 */
export class MemoryIntake {
  #transact; #queue = []; #running = null; #scheduled = null; #closed = false;
  #waiters = []; #batchSize; #limit; #inFlight = 0; #commits = 0; #failed = 0;
  constructor({ transact, batchSize = 16, maxPending = 1024 } = {}) {
    if (typeof transact !== "function" || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64
      || !Number.isSafeInteger(maxPending) || maxPending < batchSize) throw failure("MEMORY_INTAKE_INVALID");
    this.#transact = transact; this.#batchSize = batchSize; this.#limit = maxPending;
  }
  status() { return { pendingMessages: this.#queue.length + this.#inFlight, committedBatches: this.#commits,
    failedMessages: this.#failed, closed: this.#closed }; }
  enqueue(build) {
    if (this.#closed) return Promise.reject(failure("MEMORY_INTAKE_CLOSED"));
    if (typeof build !== "function" || build.constructor.name === "AsyncFunction") return Promise.reject(failure("MEMORY_ASYNC_MUTATOR"));
    if (this.#queue.length + this.#inFlight >= this.#limit) return Promise.reject(failure("MEMORY_INTAKE_FULL"));
    const result = new Promise((resolve, reject) => this.#queue.push({ build, resolve, reject }));
    this.#schedule();
    return result;
  }
  #schedule() {
    if (!this.#running && !this.#scheduled) this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      this.#running = this.#flush().finally(() => {
        this.#running = null;
        // A completion continuation may enqueue after the flush loop exits but
        // before this finally runs. Re-arm that tail rather than stranding it.
        if (this.#queue.length) this.#schedule();
        else for (const resolve of this.#waiters.splice(0)) resolve();
      });
    });
  }
  async #flush() {
    while (this.#queue.length) {
      const batch = this.#queue.splice(0, this.#batchSize);
      this.#inFlight = batch.length;
      try {
        const values = await this.#transact(draft => batch.map(({ build }) => {
          const value = build(draft);
          if (value && typeof value.then === "function") {
            Promise.resolve(value).catch(() => {});
            throw failure("MEMORY_ASYNC_MUTATOR");
          }
          return value;
        }));
        this.#commits += 1;
        batch.forEach((item, index) => item.resolve(values[index]));
      } catch {
        this.#failed += batch.length;
        for (const item of batch) item.reject(failure("MEMORY_INTAKE_COMMIT_FAILED"));
      } finally { this.#inFlight = 0; }
    }
  }
  barrier() {
    return this.#scheduled || this.#running || this.#queue.length
      ? new Promise(resolve => this.#waiters.push(resolve)) : Promise.resolve();
  }
  async close() { this.#closed = true; await this.barrier(); }
}
