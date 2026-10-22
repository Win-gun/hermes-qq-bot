import {
  createMemoryExtractionState, enqueueMemoryMessages, prepareMemoryBatch,
  claimMemoryBatch, acknowledgeMemoryBatch, failMemoryBatch,
  retryMemoryBatch, recoverMemoryExtraction
} from "./memory-extraction-jobs.js";

const FIELD = "memoryExtractionJobs";
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const put = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, configurable: true, writable: true
});
class JobError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const error = code => new JobError(code);
const positive = value => Number.isSafeInteger(value) && value > 0;
const conversation = id => {
  if (typeof id !== "string" || !id.trim()) throw error("MEMORY_JOB_INVALID_CONVERSATION");
};

// Local boundary checks only: inputs, candidates and this scheduler's job state.
// Whole-root JSON safety belongs to transact's mandatory backend contract below.
// JSON.stringify alone silently drops/coerces invalid data.
function assertJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw error("MEMORY_JOB_NON_JSON");
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!array && proto !== Object.prototype && proto !== null) throw error("MEMORY_JOB_NON_JSON");
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw error("MEMORY_JOB_NON_JSON");
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !own(descriptor, "value")
      || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw error("MEMORY_JOB_NON_JSON");
    }
    assertJSON(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
const snapshot = value => { assertJSON(value); return JSON.parse(JSON.stringify(value)); };
function synchronous(fn, ...args) {
  const result = fn(...args);
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    throw error("MEMORY_JOB_ASYNC_CALLBACK");
  }
  return result;
}
function stateAt(root, id) {
  const group = root.groups && own(root.groups, id) ? root.groups[id] : null;
  const state = group && own(group, FIELD) ? group[FIELD] : createMemoryExtractionState();
  assertJSON(state);
  return state;
}
function writeState(draft, id, state) {
  assertJSON(state);
  if (!draft.groups) draft.groups = {};
  if (!own(draft.groups, id)) put(draft.groups, id, {});
  put(draft.groups[id], FIELD, state);
}
function legacyAt(draft, id) {
  const legacy = draft.groups && own(draft.groups, id) ? draft.groups[id].pendingMemoryMessages : undefined;
  if (legacy !== undefined && !Array.isArray(legacy)) throw error("MEMORY_JOB_INVALID_LEGACY");
  return legacy || [];
}
const acceptance = ({ accepted, duplicates, backpressure }) => ({ accepted, duplicates, backpressure });

/**
 * Async durable extraction. ONE scheduler per memory root. No I/O or timers here.
 *
 * transact(syncMutator) MUST queue a fresh draft from the latest live root, run
 * the callback without awaits, STRICTLY VALIDATE THE ENTIRE RESULTING DRAFT as
 * JSON before durable save/publication, durably save off-thread, then publish
 * and resolve with its return value. Validation must reject NaN/Infinity,
 * undefined, cycles, non-plain values, etc.; stringify/coercion is NOT validation.
 * Rejection MUST NOT save/publish any invalid patch or its ACK. This mandatory
 * backend validation also covers arbitrary fields written by apply; there is no
 * validation bypass option. getState() returns already-validated read-only live
 * state. The scheduler never walks/clones unrelated group/history/root fields;
 * it validates only inputs/candidates/job states. This is NOT a wrapper around
 * a synchronous persist callback.
 * process({ conversationId, batch, messages }) may await; apply(draft, candidate,
 * { conversationId, batch }) is synchronous, patch-only (no saving or live edits).
 * batch.messages contains the exact claimed inputs, as in the sync scheduler.
 * apply may return small JSON (undefined becomes null). Its strict JSON snapshot
 * is exposed as committed.applyResult ONLY after transact durably resolves, never
 * in failed/disabled results or live job state. Callers must update success
 * metrics from that committed result, not from the speculative apply callback.
 * This is a general return passthrough; the scheduler never adds candidate data.
 *
 * API: enqueue(id, input), importLegacy(id), recover(), retry(id) are async.
 * run() returns a shared Promise<result[]> for one bounded sweep, at most one
 * batch per conversation, at most two global model calls, one per conversation.
 * Call recover() at startup. Failed jobs require explicit await retry(id), then
 * run(). No automatic polling, retries, tombstone eviction, or legacy deletion.
 * Storage failures also gate privately when failure metadata cannot be saved;
 * retry flushes the retained batch/attempts before unlocking. A crash cannot
 * preserve metadata which storage refused, but durable inputs remain replayable.
 * Enqueue/import backpressure rejects the whole addition: retain/replay upstream.
 *
 * A disable observed after claim or in the latest ACK builder discards candidate
 * without ACK, returning that same batch to pending. Config is checked again
 * inside queued builders; a transaction already durably committing cannot be
 * cancelled. All errors expose fixed codes only, never callback error contents.
 */
export function createAsyncMemoryExtractionScheduler({
  getState, transact, process: processBatch, apply, isEnabled = () => true,
  batchSize = () => 4, concurrency = 2, maxPendingMessages = 1024, maxKnownMessages = 100000
}) {
  for (const [name, fn] of Object.entries({ getState, transact, process: processBatch, apply, isEnabled })) {
    if (typeof fn !== "function") throw error("MEMORY_JOB_INVALID_CALLBACK");
    if (["getState", "apply", "isEnabled"].includes(name) && fn.constructor.name === "AsyncFunction") {
      throw error("MEMORY_JOB_ASYNC_CALLBACK");
    }
  }
  if (!positive(concurrency) || concurrency > 2 || !positive(maxPendingMessages)
    || !positive(maxKnownMessages) || (typeof batchSize !== "function" && !positive(batchSize))) {
    throw error("MEMORY_JOB_INVALID_LIMIT");
  }
  const limits = { maxPendingMessages, maxKnownMessages };
  const active = new Set();
  const blockedMap = new Map();
  const retrying = new Map();
  let sweep = null;
  let recovering = null;
  const enabled = id => synchronous(isEnabled, id) === true;
  async function transaction(build, code) {
    try {
      return await transact(draft => synchronous(build, draft));
    } catch (cause) {
      // Do not trust arbitrary repository/model/patch exception messages/codes.
      throw cause instanceof JobError ? cause : error(code);
    }
  }
  function importInto(draft, id) {
    const legacy = legacyAt(draft, id);
    assertJSON(legacy);
    return enqueueMemoryMessages(stateAt(draft, id), id, legacy, limits);
  }
  async function enqueue(id, input) {
    conversation(id);
    const captured = snapshot(input); // only this input, never a captured root
    return transaction(draft => {
      const result = enqueueMemoryMessages(stateAt(draft, id), id, [captured], limits);
      if (result.accepted) writeState(draft, id, result.state);
      return acceptance(result);
    }, "MEMORY_JOB_ENQUEUE_FAILED");
  }
  async function importLegacy(id) {
    conversation(id);
    return transaction(draft => {
      const result = importInto(draft, id);
      if (result.accepted) writeState(draft, id, result.state);
      return acceptance(result);
    }, "MEMORY_JOB_IMPORT_FAILED");
  }
  function recover() {
    if (recovering) return recovering;
    if (sweep || active.size || retrying.size) return Promise.reject(error("MEMORY_JOB_BUSY"));
    recovering = transaction(draft => {
      let count = 0;
      for (const id of Object.keys(draft.groups || {})) {
        if (blockedMap.has(id)) continue; // recovery must not unlock private failures
        const before = stateAt(draft, id);
        const after = recoverMemoryExtraction(before);
        if (before !== after) { writeState(draft, id, after); count++; }
      }
      return count;
    }, "MEMORY_JOB_RECOVER_FAILED").finally(() => { recovering = null; });
    return recovering;
  }
  function failureState(draft, id, failure) {
    const before = stateAt(draft, id);
    // Atomic import+claim may have failed before ANY legacy inputs were saved.
    // Keep just the attempted batch inputs privately, never an old whole draft.
    const restored = enqueueMemoryMessages(before, id, failure.messages, limits);
    if (restored.backpressure) throw error("MEMORY_JOB_FAILURE_BACKPRESSURE");
    return failMemoryBatch(restored.state, failure.batch, failure.stage);
  }
  function retry(id) {
    try { conversation(id); } catch (cause) { return Promise.reject(cause); }
    if (active.has(id) || recovering) return Promise.reject(error("MEMORY_JOB_BUSY"));
    if (retrying.has(id)) return retrying.get(id);
    const operation = transaction(draft => {
      const failure = blockedMap.get(id);
      const before = failure?.batch ? failureState(draft, id, failure) : stateAt(draft, id);
      const after = retryMemoryBatch(before);
      if (before === after && !failure) return false;
      if (failure?.batch || after !== before) writeState(draft, id, after);
      return true;
    }, "MEMORY_JOB_RETRY_FAILED").then(result => {
      blockedMap.delete(id); // only AFTER retry metadata is durable
      return result;
    }).finally(() => { retrying.delete(id); });
    retrying.set(id, operation);
    return operation;
  }
  async function recordFailure(id, batch, messages, stage) {
    const failure = { batch, messages, stage };
    blockedMap.set(id, failure);
    if (!batch) return false;
    try {
      await transaction(draft => {
        writeState(draft, id, failureState(draft, id, failure));
      }, "MEMORY_JOB_FAILURE_SAVE_FAILED");
      return true;
    } catch { return false; }
  }
  function suspendInto(draft, id, batch) {
    const state = stateAt(draft, id);
    if (state.batch?.id !== batch.id || state.batch.status !== "running") {
      throw error("MEMORY_JOB_OWNERSHIP_LOST");
    }
    writeState(draft, id, recoverMemoryExtraction(state));
    return { conversationId: id, status: "disabled" };
  }
  async function runConversation(id) {
    let batch = null;
    let messages = [];
    let stage = "prepare";
    active.add(id);
    try {
      if (retrying.has(id)) await retrying.get(id);
      if (blockedMap.has(id)) return { conversationId: id, status: "retry_required" };
      if (!enabled(id)) return { conversationId: id, status: "disabled" };
      const claim = await transaction(draft => {
        if (!enabled(id)) return { conversationId: id, status: "disabled" };
        const imported = importInto(draft, id);
        const before = imported.state;
        if (before.batch?.retryRequired || before.batch?.status === "running") {
          return { conversationId: id, status: before.batch.retryRequired ? "retry_required" : "recovery_required" };
        }
        if (!before.messages.length) return {
          conversationId: id, status: imported.backpressure ? "backpressure" : "idle", backpressure: imported.backpressure
        };
        let size = 1; // pinned recovery/retry does not consult a new setting
        if (!before.batch) {
          // Optional arguments are the current, transaction-local admitted
          // inputs. A contextual window must not size a claim from a stale root.
          try { size = typeof batchSize === "function" ? synchronous(batchSize, id, before.messages.map(row => row.input)) : batchSize; }
          catch { throw error("MEMORY_JOB_BATCH_SIZE_INVALID"); }
          if (!positive(size)) throw error("MEMORY_JOB_BATCH_SIZE_INVALID");
        }
        const prepared = prepareMemoryBatch(before, id, size);
        stage = "claim";
        const claimed = claimMemoryBatch(prepared);
        batch = snapshot(claimed.batch);
        const keys = new Set(batch.keys);
        messages = claimed.messages.filter(item => keys.has(item.key)).map(item => snapshot(item.input));
        writeState(draft, id, claimed);
        return { status: "claimed", backpressure: imported.backpressure };
      }, "MEMORY_JOB_CLAIM_FAILED");
      if (claim.status !== "claimed") return claim;
      // The claim transaction has durably saved AND published before this point.
      if (!enabled(id)) {
        stage = "suspend";
        return await transaction(draft => suspendInto(draft, id, batch), "MEMORY_JOB_SUSPEND_FAILED");
      }
      stage = "process";
      const candidate = await processBatch({ conversationId: id,
        batch: { ...snapshot(batch), messages: snapshot(messages) }, messages: snapshot(messages) });
      if (!enabled(id)) {
        stage = "suspend";
        return await transaction(draft => suspendInto(draft, id, batch), "MEMORY_JOB_SUSPEND_FAILED");
      }
      const captured = snapshot(candidate);
      stage = "commit";
      const committed = await transaction(draft => {
        // Recheck HERE: disable/new input may be queued ahead of this ACK.
        if (!enabled(id)) { stage = "suspend"; return suspendInto(draft, id, batch); }
        const acknowledged = acknowledgeMemoryBatch(stateAt(draft, id), batch.id);
        writeState(draft, id, acknowledged);
        const expected = JSON.stringify(acknowledged);
        const returned = synchronous(apply, draft, captured, { conversationId: id,
          batch: { ...snapshot(batch), messages: snapshot(messages) } });
        const applyResult = snapshot(returned === undefined ? null : returned);
        if (JSON.stringify(stateAt(draft, id)) !== expected) throw error("MEMORY_JOB_PATCH_CHANGED_ACK");
        return { applyResult }; // private until the backend durably saves + publishes
      }, "MEMORY_JOB_COMMIT_FAILED");
      if (committed.status === "disabled") return committed;
      return { conversationId: id, status: "committed", batchId: batch.id,
        attempts: batch.attempts, count: batch.keys.length, backpressure: claim.backpressure,
        applyResult: committed.applyResult };
    } catch (cause) {
      // A bad hot-reloaded size has no attempted batch: fixing it is sufficient.
      const failurePersisted = cause?.code === "MEMORY_JOB_BATCH_SIZE_INVALID" ? false
        : await recordFailure(id, batch, messages, stage);
      return { conversationId: id, status: "failed", stage,
        code: cause instanceof JobError ? cause.code : `MEMORY_JOB_${stage.toUpperCase()}_FAILED`,
        batchId: batch?.id || null, failurePersisted };
    } finally { active.delete(id); }
  }
  function run() {
    if (sweep) return sweep;
    // Assign shared sweep BEFORE invoking any adapter/model callback.
    sweep = Promise.resolve().then(async () => {
      if (recovering) await recovering;
      let ids;
      try {
        const root = synchronous(getState);
        ids = [...new Set([...Object.keys(root.groups || {}), ...blockedMap.keys()])].filter(id => {
          const state = stateAt(root, id);
          return blockedMap.has(id) || state.messages?.length || state.batch || legacyAt(root, id).length;
        });
      } catch { throw error("MEMORY_JOB_READ_FAILED"); }
      const results = new Array(ids.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
        while (cursor < ids.length) {
          const index = cursor++;
          results[index] = await runConversation(ids[index]);
        }
      }));
      return results;
    }).finally(() => { sweep = null; });
    return sweep;
  }
  return { enqueue, importLegacy, recover, retry, run };
}
