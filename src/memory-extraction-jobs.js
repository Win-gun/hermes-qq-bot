import { createHash } from "node:crypto";

/**
 * Durable memory extraction, without I/O, timers, model calls, or repository imports.
 *
 * API / integration contract
 * --------------------------
 * Store JSON state at memory.groups[conversationId].memoryExtractionJobs. Helpers
 * below are pure: they never mutate their arguments. The scheduler always reads
 * getState() again after awaiting process(), never a captured group reference.
 *
 * createMemoryExtractionScheduler({ getState, persist, process, commit,
 *   isEnabled = () => true, concurrency = 2, batchSize = 4,
 *   maxPendingMessages = 1024, maxKnownMessages = 100000 })
 * batchSize: positive safe integer or synchronous () => positive safe integer.
 *   The callback is read and validated when forming EACH NEW batch, not at
 *   construction. Hot reload affects new batches, never pinned retries/recovery.
 *   An invalid value fails prepare without consuming inputs or calling process;
 *   fix the setting and call run() again (there is no failed batch to unlock).
 *
 * getState() -> latest whole memory JSON. One scheduler / single writer per root.
 * persist(draft, { phase, conversationId? }) -> synchronously durably save AND
 *   publish draft; throw BEFORE publishing on failure. No asynchronous save.
 * process({ conversationId, batch, messages }) -> JSON candidate or Promise of
 *   candidate (null is a valid no-op patch). MUST NOT change live memory.
 * commit({ draft, candidate, conversationId, batch }) -> synchronously apply the
 *   candidate to draft, then durably save AND publish that whole draft ONCE.
 *   draft ALREADY contains the batch ACK. Never patch live then ACK separately.
 *   Even a no-op candidate must persist the ACK. Throw means neither is published.
 *   Uncertain storage outcomes must be resolved by the parent repository adapter.
 * isEnabled(conversationId) -> boolean; false pauses work, not ingestion.
 *
 * scheduler.enqueue(id, input) durably accepts one JSON input, including when
 *   disabled. Duplicates are successful no-ops, including after ACK / restart.
 * scheduler.importLegacy(id) imports pendingMemoryMessages without modifying it.
 * scheduler.recover() MUST run once at startup, before run(). It changes orphaned
 *   running -> pending, preserving the batch ID, membership, and attempt count.
 * scheduler.run() -> Promise<result[]>: bounded sweep, at most ONE batch per
 *   conversation. Concurrent calls share a sweep. No polling or implicit retry.
 * scheduler.retry(id) explicitly unlocks a failed batch; then call run() again.
 *
 * Limits reject the WHOLE input array/import with explicit backpressure, never
 * trim an old backlog. The caller must retain/replay rejected new inputs. Legacy
 * input remains in its original array; raise limits to import an oversized queue.
 * maxKnownMessages bounds pending + permanent dedup tombstones, not just backlog.
 * There is deliberately no tombstone eviction: increase the limit or implement
 * an explicit externally proven retention policy when it fills.
 *
 * Idempotency: conversation + message_id/messageId; without an ID, SHA-256 of
 * canonical input JSON (not wall clock). Identical ID-less inputs cannot be
 * distinguished; supply a stable upstream ID for distinct identical events.
 * sentAtMs is milliseconds, OneBot time is seconds, sentAt/at are ISO strings or
 * milliseconds. Missing/invalid event time is null, NEVER processing time.
 * Received order determines batch membership, not an event-time high watermark;
 * late events remain eligible. Input is preserved verbatim; redact upstream.
 *
 * Minimal bridge adapter (illustrative; not installed by this module):
 *
 * const jobs = createMemoryExtractionScheduler({
 *   getState: () => memory,
 *   persist: draft => commitMemoryDraft(memory, draft, saveMemory),
 *   process: ({ conversationId, messages }) => {
 *     const live = memory.groups[conversationId];
 *     return Promise.resolve(callHermes(makePrompt(live, messages), config))
 *       .then(raw => { const patch = parsePatch(raw);
 *         if (!patch) throw new Error('invalid patch'); return patch; });
 *   },
 *   commit: ({ draft, candidate, conversationId, batch }) => {
 *     // Synchronous only; validate candidate, then mutate the DRAFT, not memory.
 *     mergeMemoryPatch(draft, conversationId, candidate, config,
 *       { messages: batch.messages });
 *     commitMemoryDraft(memory, draft, saveMemory); // patch + ACK, one save
 *   },
 *   isEnabled: () => config.memory?.enabled !== false
 *     && config.memory?.aiExtraction?.enabled !== false,
 *   batchSize: () => config.memory?.aiExtraction?.everyMessages ?? 4,
 * });
 * jobs.recover(); // imports occur per conversation in run(), or explicitly
 * // Incoming: jobs.enqueue(conversationId, sanitizedOriginalEvent);
 * // If backpressure: retain upstream; do not report input as durably accepted.
 * // Parent owns scheduling: await jobs.run(); on failure jobs.retry(id) later.
 *
 * Callback atomicity is a required adapter contract, not something a pure module
 * can enforce on disk. A crash before a successful claim never runs the model.
 * A crash after a claim may repeat processing but not an already committed patch.
 * If persistence remains unavailable, failures are also blocked in this instance;
 * retry flushes their retained batch/attempt metadata. A crash cannot preserve
 * metadata that storage refused, but the previously durable inputs remain intact.
 */

const FIELD = "memoryExtractionJobs";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
};

// Reject non-JSON rather than silently dropping undefined, NaN, or class fields.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError("Expected acyclic JSON");
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError("Expected plain JSON");
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, item => canonical(item, ancestors)).join(",")}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

const clone = value => JSON.parse(canonical(value));
const put = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, writable: true, configurable: true
});

function conversation(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("conversationId must be a nonempty string");
  return value;
}

export function memoryMessageKey(conversationId, input) {
  conversation(conversationId);
  const fingerprint = canonical(input);
  const id = input && typeof input === "object" ? input.message_id ?? input.messageId : null;
  if (id !== null && id !== undefined && id !== "") {
    if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) {
      throw new TypeError("message ID must be a string or safe integer");
    }
    return JSON.stringify([conversationId, "id", String(id)]);
  }
  return JSON.stringify([conversationId, "sha256", createHash("sha256").update(fingerprint).digest("hex")]);
}

export function memoryEventTime(input) {
  if (!input || typeof input !== "object") return null;
  for (const [field, seconds] of [["sentAtMs", false], ["sentAt", false], ["time", true], ["at", false]]) {
    const value = input[field];
    if (value === null || value === undefined || value === "") continue;
    const ms = typeof value === "number" ? value * (seconds ? 1000 : 1)
      : typeof value === "string" && !seconds ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return ms;
  }
  return null;
}

export function createMemoryExtractionState() {
  return { version: 1, nextBatch: 1, messages: [], acknowledged: [], batch: null };
}

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.messages) || !Array.isArray(state.acknowledged)) {
    throw new TypeError("Invalid memory extraction state/version");
  }
  positive(state.nextBatch, "nextBatch");
  const keys = new Set();
  for (const message of state.messages) {
    if (!message || typeof message.key !== "string" || keys.has(message.key) || !own(message, "input")
      || !(message.eventTimeMs === null || Number.isFinite(message.eventTimeMs))) throw new TypeError("Invalid pending message");
    keys.add(message.key);
  }
  const ack = new Set(state.acknowledged);
  if (ack.size !== state.acknowledged.length || [...ack].some(key => typeof key !== "string" || keys.has(key))) {
    throw new TypeError("Invalid ACK ledger");
  }
  const batch = state.batch;
  if (batch !== null) {
    if (!batch || typeof batch.id !== "string" || !["pending", "running"].includes(batch.status)
      || !Array.isArray(batch.keys) || !batch.keys.length || new Set(batch.keys).size !== batch.keys.length
      || batch.keys.some(key => !keys.has(key)) || typeof batch.retryRequired !== "boolean"
      || !Number.isSafeInteger(batch.attempts) || batch.attempts < 0
      || !Number.isSafeInteger(batch.failures) || batch.failures < 0
      || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1 || batch.sequence >= state.nextBatch) {
      throw new TypeError("Invalid batch");
    }
  }
  return state;
}

/** Atomic acceptance. On backpressure returns the original state, unchanged. */
export function enqueueMemoryMessages(state, conversationId, inputs, {
  maxPendingMessages = 1024, maxKnownMessages = 100000
} = {}) {
  validate(state);
  conversation(conversationId);
  positive(maxPendingMessages, "maxPendingMessages");
  positive(maxKnownMessages, "maxKnownMessages");
  if (!Array.isArray(inputs)) throw new TypeError("inputs must be an array");
  const known = new Set([...state.acknowledged, ...state.messages.map(item => item.key)]);
  const additions = [];
  for (const input of inputs) {
    const key = memoryMessageKey(conversationId, input);
    if (known.has(key)) continue;
    known.add(key);
    additions.push({ key, eventTimeMs: memoryEventTime(input), input: clone(input) });
  }
  const duplicates = inputs.length - additions.length;
  const pending = state.messages.length + additions.length;
  const code = pending > maxPendingMessages ? "PENDING_LIMIT" : known.size > maxKnownMessages ? "KNOWN_LIMIT" : null;
  if (code && additions.length) return {
    state, accepted: 0, duplicates,
    backpressure: { code, pending: state.messages.length, additional: additions.length,
      limit: code === "PENDING_LIMIT" ? maxPendingMessages : maxKnownMessages }
  };
  if (!additions.length) return { state, accepted: 0, duplicates, backpressure: null };
  const next = clone(state);
  next.messages.push(...additions);
  return { state: next, accepted: additions.length, duplicates, backpressure: null };
}

export function prepareMemoryBatch(state, conversationId, batchSize = 4) {
  validate(state);
  conversation(conversationId);
  positive(batchSize, "batchSize");
  if (state.batch || !state.messages.length) return state;
  const next = clone(state);
  const sequence = next.nextBatch++;
  positive(next.nextBatch, "nextBatch");
  next.batch = {
    id: JSON.stringify([conversationId, "memory", sequence]), sequence,
    keys: next.messages.slice(0, batchSize).map(item => item.key),
    status: "pending", attempts: 0, failures: 0, retryRequired: false, lastFailure: null
  };
  return next;
}

export function claimMemoryBatch(state) {
  validate(state);
  if (!state.batch || state.batch.status !== "pending" || state.batch.retryRequired) return state;
  const next = clone(state);
  next.batch.status = "running";
  next.batch.attempts++;
  positive(next.batch.attempts, "attempts");
  return next;
}

export function acknowledgeMemoryBatch(state, batchId) {
  validate(state);
  if (!state.batch || state.batch.id !== batchId || state.batch.status !== "running") throw new Error("Batch ownership lost");
  const next = clone(state);
  const keys = new Set(next.batch.keys);
  next.acknowledged.push(...next.batch.keys);
  next.messages = next.messages.filter(item => !keys.has(item.key));
  next.batch = null;
  return next;
}

/** attemptedBatch also preserves metadata when a claim write itself failed. */
export function failMemoryBatch(state, attemptedBatch, stage) {
  validate(state);
  if (!["prepare", "claim", "process", "commit", "suspend"].includes(stage)) throw new TypeError("Invalid failure stage");
  if (state.batch && state.batch.id !== attemptedBatch.id) throw new Error("Batch ownership lost");
  const next = clone(state);
  const batch = next.batch || clone(attemptedBatch);
  batch.attempts = Math.max(batch.attempts, attemptedBatch.attempts);
  const repeated = batch.lastFailure?.stage === stage && batch.lastFailure?.attempt === batch.attempts;
  if (!repeated) batch.failures++;
  batch.status = "pending";
  batch.retryRequired = true;
  // Persist only a fixed code, never model output or a potentially secret error.
  batch.lastFailure = { stage, attempt: batch.attempts, code: `MEMORY_JOB_${stage.toUpperCase()}_FAILED` };
  next.batch = batch;
  next.nextBatch = Math.max(next.nextBatch, batch.sequence + 1);
  return validate(next);
}

export function retryMemoryBatch(state) {
  validate(state);
  if (!state.batch || state.batch.status !== "pending" || !state.batch.retryRequired) return state;
  const next = clone(state);
  next.batch.retryRequired = false;
  return next;
}

export function recoverMemoryExtraction(state) {
  validate(state);
  if (state.batch?.status !== "running") return state;
  const next = clone(state);
  next.batch.status = "pending";
  next.batch.retryRequired = false;
  return next;
}

function stateAt(root, id) {
  const group = root.groups && own(root.groups, id) ? root.groups[id] : null;
  return group && own(group, FIELD) ? validate(group[FIELD]) : createMemoryExtractionState();
}

function draftWith(root, id, state) {
  const draft = clone(root);
  if (!draft.groups) draft.groups = {};
  if (!own(draft.groups, id)) put(draft.groups, id, {});
  put(draft.groups[id], FIELD, state);
  return draft;
}

function synchronous(fn, ...args) {
  const result = fn(...args);
  if (result && typeof result.then === "function") {
    // Avoid unhandled rejection from an invalid adapter; no promise is awaited.
    Promise.resolve(result).catch(() => {});
    throw new TypeError("State and transaction callbacks must be synchronous");
  }
  return result;
}

export function createMemoryExtractionScheduler({
  getState, persist, process: processBatch, commit, isEnabled = () => true,
  concurrency = 2, batchSize = 4, maxPendingMessages = 1024, maxKnownMessages = 100000
}) {
  for (const [name, fn] of Object.entries({ getState, persist, process: processBatch, commit, isEnabled })) {
    if (typeof fn !== "function") throw new TypeError(`${name} callback is required`);
    if (name !== "process" && fn.constructor.name === "AsyncFunction") throw new TypeError(`${name} must be synchronous`);
  }
  positive(concurrency, "concurrency");
  if (concurrency > 2) throw new RangeError("Global concurrency cannot exceed two");
  if (typeof batchSize !== "function") positive(batchSize, "batchSize");
  positive(maxPendingMessages, "maxPendingMessages");
  positive(maxKnownMessages, "maxKnownMessages");
  const limits = { maxPendingMessages, maxKnownMessages };
  const active = new Set();
  const blocked = new Map();
  let sweep = null;
  const live = () => synchronous(getState);
  const enabled = id => synchronous(isEnabled, id) === true;

  function saveState(id, state, phase, root = live()) {
    synchronous(persist, draftWith(root, id, state), { phase, conversationId: id });
    if (canonical(stateAt(live(), id)) !== canonical(state)) throw new Error("persist must publish the saved job state");
  }

  function enqueue(id, input) {
    conversation(id);
    const root = live();
    const result = enqueueMemoryMessages(stateAt(root, id), id, [input], limits);
    if (result.accepted) saveState(id, result.state, "enqueue", root);
    return { accepted: result.accepted, duplicates: result.duplicates, backpressure: result.backpressure };
  }

  function importLegacy(id) {
    conversation(id);
    const root = live();
    const legacy = root.groups && own(root.groups, id) ? root.groups[id].pendingMemoryMessages : undefined;
    if (legacy !== undefined && !Array.isArray(legacy)) throw new TypeError("Legacy pendingMemoryMessages must be an array");
    const result = enqueueMemoryMessages(stateAt(root, id), id, legacy || [], limits);
    if (result.accepted) saveState(id, result.state, "import", root);
    return { accepted: result.accepted, duplicates: result.duplicates, backpressure: result.backpressure };
  }

  function recover() {
    if (sweep || active.size) throw new Error("Cannot recover while scheduler is active");
    const root = live();
    let draft = root;
    let count = 0;
    for (const id of Object.keys(root.groups || {})) {
      const before = stateAt(root, id);
      const after = recoverMemoryExtraction(before);
      if (after !== before) {
        draft = draftWith(draft, id, after);
        count++;
      }
    }
    if (count) {
      synchronous(persist, draft, { phase: "recover" });
      const published = live();
      for (const id of Object.keys(draft.groups || {})) {
        if (canonical(stateAt(published, id)) !== canonical(stateAt(draft, id))) {
          throw new Error("persist must publish the recovered job state");
        }
      }
    }
    return count;
  }

  function retry(id) {
    conversation(id);
    if (active.has(id)) throw new Error("Cannot retry an active conversation");
    const root = live();
    let before = stateAt(root, id);
    const failure = blocked.get(id);
    if (failure) before = failMemoryBatch(before, failure.batch, failure.stage);
    const after = retryMemoryBatch(before);
    if (after === before && !failure) return false;
    saveState(id, after, "retry", root);
    blocked.delete(id);
    return true;
  }

  function recordFailure(id, batch, stage) {
    blocked.set(id, { batch: clone(batch), stage });
    try {
      const root = live();
      saveState(id, failMemoryBatch(stateAt(root, id), batch, stage), "failure", root);
      return true;
    } catch {
      return false; // explicit retry will attempt to persist retained metadata
    }
  }

  function suspend(id, batch) {
    const root = live();
    const before = stateAt(root, id);
    if (before.batch?.id !== batch.id) throw new Error("Batch ownership lost");
    saveState(id, recoverMemoryExtraction(before), "suspend", root);
  }

  async function runConversation(id) {
    let batch = null;
    let stage = "prepare";
    active.add(id);
    try {
      if (!enabled(id)) return { conversationId: id, status: "disabled" };
      if (blocked.has(id)) return { conversationId: id, status: "retry_required" };
      const imported = importLegacy(id);
      let root = live();
      let before = stateAt(root, id);
      if (before.batch?.retryRequired) return { conversationId: id, status: "retry_required" };
      if (before.batch?.status === "running") return { conversationId: id, status: "recovery_required" };
      const prepared = before.batch || !before.messages.length ? before
        : prepareMemoryBatch(before, id, positive(
          typeof batchSize === "function" ? synchronous(batchSize) : batchSize, "batchSize"));
      batch = prepared.batch;
      if (!batch) return { conversationId: id, status: imported.backpressure ? "backpressure" : "empty", backpressure: imported.backpressure };
      if (prepared !== before) saveState(id, prepared, "prepare", root);
      stage = "claim";
      root = live();
      before = stateAt(root, id);
      const claimed = claimMemoryBatch(before);
      batch = clone(claimed.batch);
      saveState(id, claimed, "claim", root); // MUST finish before process()
      if (!enabled(id)) {
        stage = "suspend";
        suspend(id, batch);
        return { conversationId: id, status: "disabled" };
      }
      stage = "process";
      const messages = claimed.messages.filter(item => batch.keys.includes(item.key)).map(item => clone(item.input));
      const context = { conversationId: id, batch: { ...clone(batch), messages: clone(messages) }, messages };
      const candidate = clone(await processBatch(context));
      if (!enabled(id)) {
        stage = "suspend";
        suspend(id, batch);
        return { conversationId: id, status: "disabled" };
      }
      stage = "commit";
      root = live(); // includes any concurrent new input, even after whole-root replacement
      const acknowledged = acknowledgeMemoryBatch(stateAt(root, id), batch.id);
      const draft = draftWith(root, id, acknowledged);
      synchronous(commit, { draft, candidate, conversationId: id, batch: { ...clone(batch), messages: clone(messages) } });
      const published = stateAt(live(), id);
      if (batch.keys.some(key => !published.acknowledged.includes(key) || published.messages.some(item => item.key === key))) {
        throw new Error("commit must publish patch and ACK together");
      }
      return { conversationId: id, status: "committed", batchId: batch.id, attempts: batch.attempts,
        count: batch.keys.length, backpressure: imported.backpressure };
    } catch {
      const failurePersisted = batch ? recordFailure(id, batch, stage) : false;
      // Import failure has no claimed batch; next explicit sweep may re-import.
      return { conversationId: id, status: "failed", stage, batchId: batch?.id || null, failurePersisted };
    } finally {
      active.delete(id);
    }
  }

  function run() {
    if (sweep) return sweep;
    // Defer callbacks until sweep is assigned, including for synchronous models.
    sweep = Promise.resolve().then(async () => {
      const root = live();
      const ids = Object.keys(root.groups || {}).filter(id => {
        const state = stateAt(root, id);
        return state.messages.length || state.batch || root.groups[id].pendingMemoryMessages?.length;
      });
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

  return { enqueue, importLegacy, recover, run, retry };
}
