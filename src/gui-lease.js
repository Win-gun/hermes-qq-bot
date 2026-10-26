import { randomUUID } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });
const identity = owner => ["taskId", "logicalBotId", "accountId"].every(k => typeof owner?.[k] === "string" && owner[k]);
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= 3_600_000;

/**
 * Host-owned physical desktop arbiter, NOT a lock per bot. No I/O at import.
 * Startup is fenced until a supervisor proves the previous host incarnation
 * stopped. This process-global arbiter is not an OS/multi-process lock: a native
 * driver MUST also have an exclusive host supervisor before being verified.
 * Tokens must never be included in model prompts. No pending work is replayed.
 */
export class GuiLeaseManager {
  #epoch = randomUUID();
  #holder = null;
  #queue = [];
  #ready = false;
  #closed = false;
  #recovering = false;
  #now;
  #setTimer;
  #clearTimer;

  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  async recover(confirmHostIdle) {
    if (this.#holder || this.#queue.length || this.#closed || this.#recovering) throw fail("GUI_RECOVERY_BLOCKED");
    this.#ready = false;
    this.#recovering = true;
    try {
      if (typeof confirmHostIdle !== "function" || await confirmHostIdle({ epoch: this.#epoch }) !== true) {
        throw fail("GUI_HOST_NOT_CONFIRMED_IDLE");
      }
      if (this.#closed) throw fail("GUI_CLOSED");
      this.#ready = true;
    } finally { this.#recovering = false; }
  }

  acquire(owner, { signal, ttlMs = 30_000, waitTimeoutMs = 30_000 } = {}) {
    if (!identity(owner) || !duration(ttlMs) || !duration(waitTimeoutMs)) return Promise.reject(fail("GUI_INVALID_LEASE"));
    if (this.#closed || !this.#ready) return Promise.reject(fail("GUI_UNAVAILABLE"));
    if (signal?.aborted) return Promise.reject(fail("GUI_ABORTED"));
    if (this.#queue.length >= 128) return Promise.reject(fail("GUI_QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const entry = { owner: Object.fromEntries(["taskId", "logicalBotId", "accountId"].map(k => [k, owner[k]])),
        signal, ttlMs, resolve, reject };
      const cancel = code => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        entry.cleanup();
        reject(fail(code));
      };
      const onAbort = () => cancel("GUI_ABORTED");
      const timer = this.#setTimer(() => cancel("GUI_WAIT_TIMEOUT"), waitTimeoutMs);
      entry.cleanup = () => { this.#clearTimer(timer); signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
      this.#drain();
    });
  }

  #drain() {
    if (this.#holder || !this.#ready || this.#closed) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    entry.cleanup();
    if (entry.signal?.aborted) { entry.reject(fail("GUI_ABORTED")); this.#drain(); return; }
    const controller = new AbortController();
    const lease = Object.freeze({ ...entry.owner, epoch: this.#epoch, token: randomUUID(),
      expiresAt: this.#now() + entry.ttlMs, signal: controller.signal });
    const holder = { lease, controller, inFlight: 0, uncertain: false, revoked: false };
    this.#holder = holder;
    const revoke = reason => {
      if (this.#holder !== holder) return;
      holder.revoked = true;
      controller.abort(fail(reason));
      if (!holder.inFlight && !holder.uncertain) this.#drop(holder);
    };
    const onAbort = () => revoke("GUI_ABORTED");
    const timer = this.#setTimer(() => revoke("GUI_TTL_EXPIRED"), entry.ttlMs);
    holder.cleanup = () => { this.#clearTimer(timer); entry.signal?.removeEventListener("abort", onAbort); };
    entry.signal?.addEventListener("abort", onAbort, { once: true });
    entry.resolve(lease);
  }

  #match(lease) {
    const h = this.#holder;
    if (!h || h.lease !== lease || lease.epoch !== this.#epoch) throw fail("GUI_STALE_FENCE");
    return h;
  }

  assert(lease) {
    const h = this.#match(lease);
    if (this.#closed || h.revoked || h.uncertain || lease.signal.aborted || this.#now() >= lease.expiresAt) {
      throw fail("GUI_LEASE_REVOKED");
    }
    return true;
  }

  /** A host completion must explicitly attest stopped:true. A rejection, timeout
   * or plain return value is NOT evidence that detached native work stopped. */
  async run(lease, execute) {
    this.assert(lease);
    const h = this.#match(lease);
    if (h.inFlight) throw fail("GUI_ACTION_IN_FLIGHT");
    h.inFlight++;
    let stopped = false;
    try {
      const result = await execute(lease.signal);
      if (result?.stopped !== true) throw fail("GUI_STOP_UNCONFIRMED");
      stopped = true;
      // A previous epoch/holder may have been explicitly fenced by a supervisor.
      this.assert(lease);
      return result;
    } catch (error) {
      // Revocation after an explicit stop acknowledgement is safe to release.
      h.uncertain = !stopped;
      h.revoked = true;
      h.controller.abort(fail("GUI_EXECUTION_UNCERTAIN"));
      throw error;
    } finally {
      h.inFlight--;
      if (h.revoked && !h.uncertain && this.#holder === h) this.#drop(h);
    }
  }

  release(lease) {
    const h = this.#match(lease);
    h.revoked = true;
    h.controller.abort(fail("GUI_RELEASED"));
    if (h.inFlight || h.uncertain) return false;
    this.#drop(h);
    return true;
  }

  async confirmStopped(lease, confirm) {
    const h = this.#match(lease);
    if (!h.revoked) throw fail("GUI_STOP_NOT_REQUESTED");
    if (typeof confirm !== "function" || await confirm({ ...h.lease }) !== true) throw fail("GUI_STOP_UNCONFIRMED");
    this.#match(lease);
    this.#drop(h);
  }

  #drop(holder) {
    holder.cleanup();
    if (this.#holder === holder) this.#holder = null;
    this.#drain();
  }

  snapshot() {
    return { ready: this.#ready && !this.#closed, epoch: this.#epoch, waiting: this.#queue.length,
      holder: this.#holder ? { taskId: this.#holder.lease.taskId, logicalBotId: this.#holder.lease.logicalBotId,
        accountId: this.#holder.lease.accountId, revoked: this.#holder.revoked,
        uncertain: this.#holder.uncertain, inFlight: this.#holder.inFlight } : null };
  }

  close() {
    this.#closed = true;
    this.#ready = false;
    for (const entry of this.#queue.splice(0)) { entry.cleanup(); entry.reject(fail("GUI_CLOSED")); }
    if (this.#holder) this.release(this.#holder.lease);
  }
}

const key = Symbol.for("hermes.work.physical-desktop-lease.v1");
export const globalGuiLease = globalThis[key] ||= new GuiLeaseManager();
