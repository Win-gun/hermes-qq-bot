import { createHash, randomUUID } from "node:crypto";
import { sanitizeArchiveValue } from "./privacy-filter.js";

const plain = x => x !== null && typeof x === "object" && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const fields = (x, names) => plain(x) && Reflect.ownKeys(x).every(k => names.includes(k));
const id = x => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(x)
  && !["__proto__", "prototype", "constructor"].includes(x);
const natural = x => Number.isSafeInteger(x) && x >= 0;
const copy = x => structuredClone(x);
const fail = code => Object.assign(new Error(code), { code });
const assert = (test, code) => { if (!test) throw fail(code); };
const digest = x => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const argumentDigest = value => {
  const canonical = x => Array.isArray(x) ? x.map(canonical) : plain(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
  return digest(canonical(value));
};
const freeze = x => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const safeCode = x => typeof x === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(x) ? x : "DELEGATION_TOOL_RESULT";
const text = (x, max = 4000) => {
  assert(typeof x === "string" && x.trim() && x.length <= max, "DELEGATION_TEXT_INVALID");
  return sanitizeArchiveValue(x.trim());
};

// Model values are DATA. Authority/destination fields are forbidden at every
// depth, even when a permissive host validator would otherwise accept them.
const authorityKeys = new Set(["account", "accountid", "logicalid", "logicalbotid", "groupid", "userid", "conversationid",
  "target", "targets", "destination", "permissions", "permission", "grants", "grant", "scope", "signal", "authorized",
  "capture", "guard", "actor", "owner", "receipt", "__proto__", "prototype", "constructor"]);
const scopeKeys = Object.freeze({ logicalid: "logicalBotId", logicalbotid: "logicalBotId", accountid: "accountId",
  conversationid: "conversationId", groupid: "groupId", userid: "userId" });
function jsonData(value, maxBytes, { model = false, scope } = {}) {
  let nodes = 0;
  const seen = new Set();
  const walk = (x, depth) => {
    assert(++nodes <= 10000 && depth <= 16, "DELEGATION_DATA_LIMIT");
    if (x === null || typeof x === "boolean" || typeof x === "string") return;
    if (typeof x === "number") { assert(Number.isFinite(x), "DELEGATION_DATA_INVALID"); return; }
    assert((plain(x) || Array.isArray(x)) && !seen.has(x), "DELEGATION_DATA_INVALID");
    seen.add(x);
    for (const k of Reflect.ownKeys(x)) {
      if (Array.isArray(x) && k === "length") continue;
      assert(typeof k === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(x, k), "value"), "DELEGATION_DATA_INVALID");
      if (model) assert(!authorityKeys.has(k.toLowerCase().replace(/[-_]/g, ""))
        && !["__proto__", "prototype", "constructor"].includes(k), "DELEGATION_MODEL_AUTHORITY");
      const scopeKey = k.toLowerCase().replace(/[-_]/g, "");
      if (scope && Object.hasOwn(scopeKeys, scopeKey)) {
        if (scopeKey === "userid" && scope.groupId) {
          // A member/sender ID in GROUP evidence is not a private destination.
          assert(typeof x[k] === "string" && /^[1-9]\d{4,19}$/.test(x[k])
            || Number.isSafeInteger(x[k]) && x[k] > 0, "DELEGATION_FOREIGN_SCOPE");
        } else {
          const actual = scopeKey === "userid" && Number.isSafeInteger(x[k]) && x[k] > 0 ? String(x[k]) : x[k];
          assert(actual === scope[scopeKeys[scopeKey]], "DELEGATION_FOREIGN_SCOPE");
        }
      }
      walk(x[k], depth + 1);
    }
  };
  walk(value, 0);
  assert(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, "DELEGATION_DATA_LIMIT");
  return copy(value);
}

export function delegationRoute(input) {
  // Host intent classification only; never call a planner merely to answer chat.
  return input?.kind === "goal" ? "delegate" : "direct";
}

export function delegationTarget(value) {
  assert(fields(value, ["logicalBotId", "accountId", "conversationId", "groupId", "userId"])
    && id(value.logicalBotId) && !value.logicalBotId.startsWith("unassigned:") && id(value.accountId), "DELEGATION_TARGET_REQUIRED");
  const group = typeof value.groupId === "string" && /^[1-9]\d{4,19}$/.test(value.groupId);
  const privateChat = typeof value.userId === "string" && /^[1-9]\d{4,19}$/.test(value.userId);
  assert((group && value.userId === undefined && value.conversationId === `group:${value.groupId}`)
    || (privateChat && value.groupId === undefined && value.conversationId === `private:${value.userId}`), "DELEGATION_TARGET_REQUIRED");
  return freeze({ logicalBotId: value.logicalBotId, accountId: value.accountId, conversationId: value.conversationId,
    ...(group ? { groupId: value.groupId } : { userId: value.userId }) });
}

function matchesTask(task, target) {
  return task && !task.authorityBlocked && task.logicalBotId === target.logicalBotId && task.accountId === target.accountId
    && task.conversationId === target.conversationId
    && (target.groupId ? task.groupId === target.groupId && task.messageType === "group"
      : task.userId === target.userId && task.messageType === "private");
}

export function createDelegationGoal({ objective, target, now }) {
  assert(natural(now), "DELEGATION_CLOCK_INVALID");
  return { version: 1, target: copy(delegationTarget(target)), objective: text(objective), revision: 1, controlRevision: 1,
    executionGeneration: 1, status: "ready", runId: null, createdAt: now, updatedAt: now, spent: { steps: 0, plannerCalls: 0, units: 0 },
    steps: [], summary: "", code: "DELEGATION_READY" };
}

const generation = goal => goal.executionGeneration ?? 1;
const stepGeneration = step => step.executionGeneration ?? 1;
export function delegationReplayBlocked(goal) {
  return goal?.version !== 1 || !Number.isSafeInteger(generation(goal)) || generation(goal) < 1
    || !Array.isArray(goal.steps) || goal.steps.some(s => !plain(s)
    || !["read", "write"].includes(s.effect) || !["claimed", "succeeded", "failed", "accepted", "uncertain", "interrupted"].includes(s.status)
    || !Number.isSafeInteger(stepGeneration(s)) || stepGeneration(s) < 1 || stepGeneration(s) > generation(goal)
    || stepGeneration(s) === generation(goal) && (["accepted", "uncertain"].includes(s.status) || (s.effect === "write" && s.status === "claimed")));
}
const unresolved = delegationReplayBlocked;
export function applyDelegationControl(goal, command, now) {
  assert(fields(command, ["action", "expectedRevision", "objective"]) && goal?.version === 1
    && command.expectedRevision === goal.revision && natural(now), "DELEGATION_CONTROL_CONFLICT");
  assert(["correct", "pause", "cancel", "resume"].includes(command.action), "DELEGATION_CONTROL_INVALID");
  assert(command.action === "correct" || command.objective === undefined, "DELEGATION_CONTROL_INVALID");
  const next = copy(goal);
  if (command.action === "correct") {
    assert(!["cancelled", "completed"].includes(goal.status), "DELEGATION_TERMINAL");
    next.objective = text(command.objective);
    next.summary = "";
    // A correction never clears uncertain receipts or implicitly resumes pause.
  } else if (command.action === "resume") {
    assert(!unresolved(goal), "DELEGATION_UNRESOLVED_EFFECT");
    assert(["paused", "waiting", "interrupted", "blocked", "budget_exhausted"].includes(goal.status), "DELEGATION_NOT_RESUMABLE");
    next.steps = next.steps.map(s => s.status === "claimed" && stepGeneration(s) === generation(goal)
      ? { ...s, status: "interrupted", code: "DELEGATION_INTERRUPTED" } : s);
    next.status = "ready";
    next.runId = null;
  } else {
    assert(!["cancelled", "completed"].includes(goal.status), "DELEGATION_TERMINAL");
    next.status = command.action === "pause" ? "paused" : "cancelled";
  }
  next.revision++;
  next.controlRevision++;
  next.updatedAt = now;
  next.code = `DELEGATION_${command.action.toUpperCase()}`;
  return next;
}

/** Dynamic, host-owned capability catalogue. Only a real injected tool plus an
 * available host descriptor can be offered. No API/backend readiness is inferred.
 * list(target) is synchronous and returns at most 128 descriptors:
 * {id,revision,description,effect:'read'|'write',risk:'low'|'approval',cost,
 *  argumentKeys,validate(args,target),available:true}.
 * tools[id](args,{target,taskId,operationId,signal,guard}) performs the REAL work
 * through existing CapabilityBroker/coordinator. Call guard immediately before
 * EVERY actual read/wire (including after queuing), not just at adapter entry.
 */
export function createCapabilityRegistry({ list, tools }) {
  assert(typeof list === "function" && plain(tools), "DELEGATION_REGISTRY_INVALID");
  function snapshot(target) {
    const rows = list(target);
    assert(Array.isArray(rows) && rows.length <= 128, "DELEGATION_REGISTRY_INVALID");
    const out = [], seen = new Set();
    for (const row of rows) {
      assert(plain(row) && id(row.id) && !seen.has(row.id), "DELEGATION_REGISTRY_INVALID");
      seen.add(row.id);
      if (row.available !== true || typeof tools[row.id] !== "function" || !Object.hasOwn(tools, row.id)) continue;
      assert(natural(row.revision) && ["read", "write"].includes(row.effect) && ["low", "approval"].includes(row.risk)
        && Number.isSafeInteger(row.cost) && row.cost > 0 && row.cost <= 1000000 && typeof row.validate === "function"
        && Array.isArray(row.argumentKeys) && row.argumentKeys.length <= 32 && row.argumentKeys.every(id), "DELEGATION_REGISTRY_INVALID");
      const descriptor = { id: row.id, revision: row.revision, description: text(row.description, 500), effect: row.effect,
        risk: row.risk, cost: row.cost, argumentKeys: [...row.argumentKeys] };
      out.push({ descriptor: freeze(descriptor), fingerprint: digest(descriptor), validate: row.validate, execute: tools[row.id] });
    }
    return out;
  }
  return Object.freeze({ snapshot });
}

function taskView(task) {
  if (!task) return null;
  return copy(Object.fromEntries(["id", "status", "accountId", "logicalBotId", "conversationId", "messageType", "groupId", "userId",
    "authorityBlocked", "attemptId", "socialOwnerUserId", "currentLogicalBotId", "executionActive", "unresolvedOperations", "socialDelegation"].map(k => [k, task[k]])));
}

/** No new files, writer, queue, sender or startup scan. All updates go through
 * TaskRuntime.persist, which fsyncs and rolls back uncertain publication.
 * MemoryRuntime alternative: implement the SAME read/mutate/subscribe interface
 * using transact(root => synchronousLatestDraftBuilder(...)); resolve mutate
 * only after durable publication as {ok:true,durable:true,value}. Never retry an
 * uncertain mutation; never mutate MemoryRuntime.value or add an offline writer.
 */
export function createTaskDelegationStore(runtime) {
  assert(runtime && ["get", "persist", "subscribeState"].every(k => typeof runtime[k] === "function"), "DELEGATION_STORE_INVALID");
  return Object.freeze({
    read: taskId => {
      const task = runtime.get(taskId);
      return task ? taskView({ ...task, ...(typeof runtime.resolveLogicalOwner === "function"
        ? { currentLogicalBotId: runtime.resolveLogicalOwner(task.accountId), executionActive: runtime.running?.has(taskId) || task.status === "queued" }
        : {}) }) : null;
    },
    mutate(taskId, build) {
      if (typeof runtime.mutateDelegation === "function") return runtime.mutateDelegation(taskId, build);
      const task = runtime.get(taskId);
      assert(task && !task.authorityBlocked, "DELEGATION_TASK_UNAVAILABLE");
      const next = build(copy(task.socialDelegation ?? null), taskView(task));
      assert(plain(next) && next.version === 1 && !next.then, "DELEGATION_MUTATION_INVALID");
      assert(!task.socialDelegation || generation(next) === generation(task.socialDelegation), "DELEGATION_STORE_REAUTHORIZATION_UNAVAILABLE");
      task.socialDelegation = copy(next);
      runtime.persist(task);
      return { ok: true, durable: true, value: copy(next) };
    },
    subscribe(taskId, listener) { return runtime.subscribeState(snapshot => { if (snapshot.id === taskId) listener(); }); }
  });
}

function budgetFor(raw, runtimeConfig) {
  assert(fields(raw, ["maxSteps", "maxPlannerCalls", "maxUnits", "deadline", "maxContextBytes", "maxObservationBytes"]), "DELEGATION_BUDGET_INVALID");
  for (const key of ["maxSteps", "maxPlannerCalls", "maxUnits", "deadline", "maxContextBytes", "maxObservationBytes"])
    assert(natural(raw[key]), "DELEGATION_BUDGET_INVALID");
  assert(raw.maxSteps <= 2048 && raw.maxPlannerCalls <= 10000 && raw.maxContextBytes >= 1024
    && raw.maxContextBytes <= 262144 && raw.maxObservationBytes <= 16384, "DELEGATION_BUDGET_INVALID");
  const cap = natural(runtimeConfig?.maxTurns) ? runtimeConfig.maxTurns : Infinity;
  return { ...raw, maxSteps: Math.min(raw.maxSteps, cap), maxPlannerCalls: Math.min(raw.maxPlannerCalls, cap) };
}

function plannerContext(goal, catalogue, budget) {
  const context = { objective: goal.objective, previousSummary: goal.summary, controlRevision: goal.controlRevision, capabilities: catalogue.map(c => c.descriptor),
    spent: copy(goal.spent), remaining: { steps: Math.max(0, budget.maxSteps - goal.spent.steps),
      plannerCalls: Math.max(0, budget.maxPlannerCalls - goal.spent.plannerCalls), units: Math.max(0, budget.maxUnits - goal.spent.units) },
    observations: [], omittedSteps: goal.steps.length, supplements: [], omittedSupplements: (goal.supplements || []).length };
  // Never truncate authority/schema/objective. If essential context does not fit,
  // stop rather than silently give a model an incomplete tool contract.
  assert(Buffer.byteLength(JSON.stringify(context)) <= budget.maxContextBytes, "DELEGATION_CONTEXT_LIMIT");
  for (const supplement of [...(goal.supplements || [])].reverse()) {
    context.supplements.unshift(supplement);
    context.omittedSupplements--;
    if (Buffer.byteLength(JSON.stringify(context)) > budget.maxContextBytes) { context.supplements.shift(); context.omittedSupplements++; break; }
  }
  for (const step of [...goal.steps].reverse()) {
    // Old claims remain audit evidence, NOT executable context. In particular,
    // never carry private/QZone observations into an explicitly renewed grant.
    if (stepGeneration(step) !== generation(goal)) continue;
    const item = { operationId: step.operationId, capability: step.capability, status: step.status,
      controlRevision: step.controlRevision, code: step.code, observation: step.observation || "" };
    context.observations.unshift(item);
    context.omittedSteps--;
    if (Buffer.byteLength(JSON.stringify(context)) > budget.maxContextBytes) { context.observations.shift(); context.omittedSteps++; break; }
  }
  return freeze(context);
}

function decision(value) {
  assert(fields(value, ["action", "capability", "args", "summary"]), "DELEGATION_PLAN_INVALID");
  if (value.action === "tool") {
    assert(fields(value, ["action", "capability", "args"]) && id(value.capability) && plain(value.args), "DELEGATION_PLAN_INVALID");
    return { action: "tool", capability: value.capability, args: jsonData(value.args, 16384, { model: true }) };
  }
  assert(["complete", "wait"].includes(value.action) && fields(value, ["action", "summary"]), "DELEGATION_PLAN_INVALID");
  return { action: value.action, summary: text(value.summary, 2000) };
}

/** Bridge integration contract (opt-in; this module does NOT change bridge):
 *
 * const loop = createAgentExecutionLoop({store:createTaskDelegationStore(tasks),
 *   capture, guard, authorize, planner, registry, budget, observe});
 * TaskRuntime.execute = (task, runtime) => task.socialDelegation
 *   ? loop.execute(task, runtime) : existingExecute(task, runtime);
 *
 * 1. Host classifies goal vs question; question stays on existing ReplyPlan path,
 *    with ZERO planner calls. Resolve explicit verified account/group BEFORE
 *    creating a TaskRuntime offer. start() never guesses or retargets that task.
 * 2. authorize(actor,{action,target,taskId}) must verify current human/source,
 *    owner/policy/consent; model text and args are not actors or grants.
 *    start/control requests belong behind existing durable owner-command claims;
 *    retain their pinned expectedRevision, never refresh a duplicate event's CAS.
 *    status() is an internal content-free projection, not a public auth endpoint.
 *    Low-risk multistep work needs no per-step approval. For approval-risk capabilities,
 *    publish availability only after real broker grants; authorizeStep must
 *    recheck exact args/operationId. Absent authorizeStep means denied.
 * 3. capture(target) + synchronous guard(capture,target) pin actual logical
 *    owner/carrier, config/control revision, consent, quiet and enabled state.
 *    tools MUST compose meta.guard with their existing physical wire gate.
 * 4. planner(context,{signal,target,taskId}) uses the BOUND text-only model, no
 *    native tools. target/taskId are immutable HOST metadata, not model fields;
 *    select the actual target account's binding/persona without global state.
 *    Return one tool/complete/wait decision, never a permission/target. Registry
 *    and budget are re-read after awaits; costs reserve durably BEFORE dispatch.
 *    budget caps are cumulative per GOAL (steps/plannerCalls/tool-cost units),
 *    not invented token usage. Account/global quota reservations still belong
 *    to the existing host budget ledger, within the same cooperating writer.
 * 5. observe(value,target) is a synchronous privacy-filtered TEXT projector.
 *    Tools return {status:'succeeded',scope:target,value?,receiptId?}, or
 *    {status:'failed',applied:false,code?}, accepted or uncertain. Writes require
 *    an actual host receiptId for success. Scope-bound history must be read by
 *    target.logicalBotId AND conversation; never read other bots then filter.
 * 6. Existing TaskRuntime alone enqueues/pumps. After start(), host can confirm
 *    low-risk work with the triggering verified human (no second prompt).
 *    wait/pause/budget/interrupted retain their native TaskRuntime state (not
 *    failed). tasks.resume(taskId,actor) atomically readies the goal and reuses
 *    the existing queue. A host_event actor requires validateDelegationActor,
 *    verified source, exact account/logicalBot/conversation, eventId/eventAt
 *    and pinned expectedDelegationRevision. No timer/startup auto-requeue;
 *    events cannot lift an explicit pause. Restart recovery exposes READ tools
 *    only. Later writes require control({action:'reauthorize',expectedRevision,
 *    objective}, freshOwnerActor): a NEW explicit objective, not the old summary.
 *    It creates a new executionGeneration and keeps old receipts/cumulative costs.
 *    Host resetContext({taskId,target,executionGeneration}) MUST synchronously
 *    return true after dropping all offers for this task, private/QZone context and
 *    prepared content grants. Missing/async acknowledgement fails closed. No
 *    authority may be restored from an older tool's guard, signal or grant.
 *    TaskRuntime store revokes old tool grants atomically with this transition.
 *    Reauthorize only parks ready; obtain a fresh resume actor pinned to the
 *    RETURNED revision, then tasks.resume() uses the SAME existing queue.
 *    MemoryRuntime-only adapters still use control(resume) + their host queue.
 *    correct updates the live goal; changing target/bot requires a NEW validated
 *    TaskRuntime task; keep the old goal/receipts, never retarget or reset them.
 *    cancel also calls tasks.cancel() to stop its existing controller. Authenticated
 *    pause/cancel may restrict a goal even while execution is quiet/disabled. Pausing
 *    closes tool guards through store.subscribe, without a second scheduler.
 * 7. claimed writes, accepted and uncertain NEVER resume/replay, even after
 *    restart or correction. Reauthorization isolates, never resolves old claims;
 *    identical canonical write arguments from older generations are blocked.
 *    Legacy writes without a versioned canonical digest fence that capability
 *    entirely (unless known failed/unapplied); their arguments cannot be recovered.
 *    Unresolved
 *    CapabilityBroker operations still require separate audited reconciliation.
 *    Host receipt reconciliation is a separate audited
 *    operation, not a model decision. No automatic retry on persistence failure.
 *    TaskRuntime notices/delivery remain host-owned and must use current guards.
 */
export function createAgentExecutionLoop(host) {
  const { store, capture, guard, authorize, planner, registry, budget, observe, authorizeStep, resetContext, clock = Date.now } = host || {};
  assert(store && ["read", "mutate", "subscribe"].every(k => typeof store[k] === "function")
    && [capture, guard, authorize, planner, budget, observe, clock].every(f => typeof f === "function")
    && typeof registry?.snapshot === "function", "DELEGATION_HOST_INVALID");
  const now = () => { const at = clock(); assert(natural(at), "DELEGATION_CLOCK_INVALID"); return at; };
  const read = taskId => { const task = store.read(taskId); assert(task, "DELEGATION_TASK_UNAVAILABLE"); return copy(task); };
  async function mutate(taskId, build) {
    let builderError;
    try {
      const receipt = await store.mutate(taskId, (...args) => {
        try { return build(...args); } catch (error) { builderError = error; throw error; }
      });
      assert(receipt?.ok === true && receipt.durable === true && receipt.value?.version === 1, "DELEGATION_DURABILITY_UNKNOWN");
      return receipt.value;
    } catch (error) {
      if (builderError === error) throw error;
      // Unknown store failure is a publication ambiguity, not a tool failure.
      throw fail("DELEGATION_DURABILITY_UNKNOWN");
    }
  }
  function sourceCheck(source, target) { assert(guard(source, target) === true, "DELEGATION_STALE_HOST"); }
  const pin = target => freeze(copy(capture(target)));
  async function start(taskId, input, actor) {
    if (delegationRoute(input) === "direct") return { matched: false, code: "DELEGATION_DIRECT" };
    const target = delegationTarget(input.target), source = pin(target);
    const check = task => {
      assert(matchesTask(task, target), "DELEGATION_TARGET_MISMATCH");
      assert(authorize(actor, freeze({ action: "start", target, taskId })) === true, "DELEGATION_AUTHORITY_REQUIRED");
      sourceCheck(source, target);
    };
    check(read(taskId));
    const goal = await mutate(taskId, (current, task) => {
      check(task);
      assert(!current, "DELEGATION_ALREADY_EXISTS");
      return createDelegationGoal({ objective: input.objective, target, now: now() });
    });
    check(read(taskId));
    return { matched: true, status: goal.status, revision: goal.revision };
  }
  async function control(taskId, command, actor) {
    const task = read(taskId), target = delegationTarget(task.socialDelegation?.target);
    const restrictive = ["pause", "cancel"].includes(command.action), source = restrictive ? null : pin(target);
    const check = latest => {
      assert(matchesTask(latest, target), "DELEGATION_TARGET_MISMATCH");
      assert(authorize(actor, freeze({ action: command.action, target, taskId })) === true, "DELEGATION_AUTHORITY_REQUIRED");
      if (command.action === "reauthorize") assert(!latest.socialOwnerUserId || latest.socialOwnerUserId === actor?.userId,
        "DELEGATION_AUTHORITY_REQUIRED");
      // Restrictive controls remain available under quiet/stale-carrier state.
      // Human/source authenticity still comes from current host authorize().
      if (!restrictive) {
        assert(latest.currentLogicalBotId === undefined || latest.currentLogicalBotId === target.logicalBotId, "DELEGATION_IDENTITY_CHANGED");
        sourceCheck(source, target);
      }
    };
    check(task);
    let renewal;
    if (command.action === "reauthorize") {
      assert(fields(command, ["action", "expectedRevision", "objective"]) && command.expectedRevision === task.socialDelegation.revision,
        "DELEGATION_CONTROL_CONFLICT");
      assert(actor?.verified === true && ["qq", "admin"].includes(actor.source) && [undefined, "human"].includes(actor.kind)
        && typeof actor.userId === "string" && actor.userId.length > 0
        && (!task.socialOwnerUserId || task.socialOwnerUserId === actor.userId), "DELEGATION_AUTHORITY_REQUIRED");
      const objective = text(command.objective);
      assert(!task.executionActive, "DELEGATION_EXECUTION_ACTIVE");
      assert(["paused", "waiting", "interrupted", "blocked", "budget_exhausted", "accepted", "uncertain"].includes(task.socialDelegation.status)
        || task.socialDelegation.status === "completed" && task.socialDelegation.recoveryReadOnly === true,
        "DELEGATION_NOT_RESUMABLE");
      assert(Number.isSafeInteger(generation(task.socialDelegation)) && generation(task.socialDelegation) >= 1, "DELEGATION_GENERATION_INVALID");
      const nextGeneration = generation(task.socialDelegation) + 1;
      assert(Number.isSafeInteger(nextGeneration), "DELEGATION_GENERATION_INVALID");
      assert(typeof resetContext === "function" && resetContext(freeze({ taskId, target, executionGeneration: nextGeneration })) === true,
        "DELEGATION_CONTEXT_RESET_REQUIRED");
      const catalogue = registry.snapshot(target);
      assert(catalogue.length > 0, "DELEGATION_NO_CAPABILITY");
      const catalogueDigest = digest(catalogue.map(c => c.descriptor));
      const fresh = () => {
        const current = registry.snapshot(target);
        assert(digest(current.map(c => c.descriptor)) === catalogueDigest
          && current.every((c, i) => c.execute === catalogue[i].execute), "DELEGATION_CAPABILITY_CHANGED");
      };
      renewal = (current, latest) => {
        assert(current.revision === command.expectedRevision, "DELEGATION_CONTROL_CONFLICT");
        assert(!latest.executionActive, "DELEGATION_EXECUTION_ACTIVE");
        assert(!latest.unresolvedOperations, "UNRESOLVED_SIDE_EFFECT");
        fresh();
        assert(generation(current) + 1 === nextGeneration, "DELEGATION_GENERATION_INVALID");
        return { ...current, objective, executionGeneration: nextGeneration, recoveryReadOnly: false,
          authorization: { sourceDigest: digest(source), catalogueDigest, ownerUserId: actor.userId },
          status: "ready", runId: null, summary: "", supplements: [], supplementCount: 0,
          revision: current.revision + 1, controlRevision: current.controlRevision + 1, updatedAt: now(), code: "DELEGATION_REAUTHORIZED" };
      };
    }
    const goal = await mutate(taskId, (current, latest) => { check(latest); return renewal ? renewal(current, latest) : applyDelegationControl(current, command, now()); });
    check(read(taskId));
    return { status: goal.status, revision: goal.revision, executionGeneration: generation(goal), code: goal.code };
  }
  const outcome = goal => ({ ok: goal.status === "completed", delegationStatus: goal.status, code: goal.code,
    delegationRevision: goal.revision, delegationControlRevision: goal.controlRevision, delegationSupplementCount: goal.supplementCount || 0,
    summary: goal.status === "completed" ? goal.summary : goal.code, ...(goal.status === "completed" ? {} : { error: goal.code }) });

  async function execute(task, runtime = {}) {
    const taskId = task.id, initialTask = read(taskId), initial = initialTask.socialDelegation;
    assert(initial?.version === 1, "DELEGATION_GOAL_REQUIRED");
    assert(id(initialTask.attemptId), "DELEGATION_ATTEMPT_REQUIRED");
    const target = delegationTarget(initial.target), source = pin(target), runId = randomUUID();
    const limits = () => budgetFor(budget(target, freeze(read(taskId))), runtime.config);
    const deadline = Math.min(limits().deadline, now() + (runtime.config?.maxRuntimeMs ?? 2147483647));
    const baseCheck = () => {
      const latest = read(taskId);
      assert(!runtime.signal?.aborted && ["planning", "running", "reviewing", "delivering"].includes(latest.status), "DELEGATION_CANCELLED");
      assert(latest.attemptId === initialTask.attemptId, "DELEGATION_ATTEMPT_CHANGED");
      assert(generation(latest.socialDelegation) === generation(initial), "DELEGATION_GENERATION_CHANGED");
      assert(matchesTask(latest, target), "DELEGATION_TARGET_MISMATCH");
      assert(latest.currentLogicalBotId === undefined || latest.currentLogicalBotId === target.logicalBotId, "DELEGATION_IDENTITY_CHANGED");
      sourceCheck(source, target);
      if (initial.authorization && !initial.recoveryReadOnly) assert(initial.authorization.sourceDigest === digest(source), "DELEGATION_STALE_HOST");
      return latest.socialDelegation;
    };
    baseCheck();
    // A second invocation is a recovery boundary, not permission to steal an
    // active run. TaskRuntime serializes attempts. Persist interruption only.
    if (initial.status !== "ready" || unresolved(initial)) {
      if (initial.status === "running") {
        return outcome(await mutate(taskId, current => {
          assert(current.revision === initial.revision, "DELEGATION_CONTROL_CONFLICT");
          return { ...current, status: unresolved(current) ? "uncertain" : "interrupted", revision: current.revision + 1,
            code: "DELEGATION_RESTART_NO_REPLAY", updatedAt: now() };
        }));
      }
      return outcome(initial);
    }
    await mutate(taskId, current => {
      baseCheck();
      assert(current.revision === initial.revision && current.status === "ready", "DELEGATION_CONTROL_CONFLICT");
      return { ...current, status: "running", runId, revision: current.revision + 1, updatedAt: now() };
    });
    const check = revision => {
      const goal = baseCheck();
      assert(goal.runId === runId, "DELEGATION_RUN_CHANGED");
      assert(goal.status === "running", "DELEGATION_STOPPED");
      assert(goal.controlRevision === revision, "DELEGATION_CONTROL_CHANGED");
      const b = limits();
      assert(now() < Math.min(deadline, b.deadline) && goal.spent.steps <= b.maxSteps
        && goal.spent.plannerCalls <= b.maxPlannerCalls && goal.spent.units <= b.maxUnits, "DELEGATION_BUDGET_EXHAUSTED");
      return goal;
    };
    async function patch(build, expectedControlRevision) {
      return mutate(taskId, current => {
        assert(generation(current) === generation(initial), "DELEGATION_GENERATION_CHANGED");
        assert(current.runId === runId, "DELEGATION_RUN_CHANGED");
        // A MemoryRuntime builder may see a newer draft than published read().
        // CAS against THAT draft, not only against our pre-await snapshot.
        if (expectedControlRevision !== undefined) {
          assert(current.status === "running", "DELEGATION_STOPPED");
          assert(current.controlRevision === expectedControlRevision, "DELEGATION_CONTROL_CHANGED");
        }
        const next = build(current);
        return { ...next, revision: current.revision + 1, updatedAt: now() };
      });
    }
    // These are call-lifetime cancellation/timeouts, never a work scheduler.
    async function bounded(revision, invoke, extraCheck = () => {}) {
      const controller = new AbortController();
      let closed = false, unsubscribe = () => {};
      const gate = () => {
        assert(!closed && !controller.signal.aborted, "DELEGATION_CALL_CLOSED");
        check(revision); extraCheck(); return true;
      };
      const abort = () => controller.abort(fail("DELEGATION_CANCELLED"));
      let rejectAbort;
      const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      runtime.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(fail("DELEGATION_BUDGET_EXHAUSTED")),
        Math.min(2147483647, Math.max(1, Math.min(deadline, limits().deadline) - now())));
      try {
        unsubscribe = store.subscribe(taskId, () => { try { gate(); } catch (error) { controller.abort(error); } });
        gate();
        return await Promise.race([Promise.resolve().then(() => { gate(); return invoke({ signal: controller.signal, guard: gate }); }), interrupted]);
      } finally {
        closed = true; clearTimeout(timer); unsubscribe();
        runtime.signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", rejectAbort);
        controller.abort(fail("DELEGATION_CALL_CLOSED"));
      }
    }
    try {
      while (true) {
        let goal = read(taskId).socialDelegation;
        if (goal.status !== "running") return outcome(goal);
        const revision = goal.controlRevision;
        try {
          check(revision);
          let b = limits();
          assert(goal.spent.plannerCalls < b.maxPlannerCalls && goal.spent.steps <= b.maxSteps && goal.spent.units <= b.maxUnits,
            "DELEGATION_BUDGET_EXHAUSTED");
          const offered = registry.snapshot(target).filter(c => !goal.recoveryReadOnly || c.descriptor.effect === "read");
          if (goal.authorization && !goal.recoveryReadOnly) assert(digest(registry.snapshot(target).map(c => c.descriptor)) === goal.authorization.catalogueDigest,
            "DELEGATION_CAPABILITY_CHANGED");
          assert(offered.length > 0, "DELEGATION_NO_CAPABILITY");
          const context = plannerContext(goal, offered, b);
          await patch(current => {
            check(revision);
            assert(current.spent.plannerCalls < limits().maxPlannerCalls, "DELEGATION_BUDGET_EXHAUSTED");
            return { ...current, spent: { ...current.spent, plannerCalls: current.spent.plannerCalls + 1 } };
          }, revision);
          const next = decision(await bounded(revision, meta => planner(context, { signal: meta.signal, target, taskId })));
          goal = check(revision); b = limits();
          if (next.action !== "tool") {
            if (next.action === "complete") assert(goal.steps.some(s => s.status === "succeeded" && s.controlRevision === revision
              && stepGeneration(s) === generation(goal))
              && !unresolved(goal), "DELEGATION_NO_COMPLETION_EVIDENCE");
            return outcome(await patch(current => { check(revision); return { ...current, status: next.action === "complete" ? "completed" : "waiting",
              summary: next.summary, code: next.action === "complete" ? "DELEGATION_COMPLETED" : "DELEGATION_WAITING" }; }, revision));
          }
          const offeredTool = offered.find(c => c.descriptor.id === next.capability);
          const cap = registry.snapshot(target).find(c => c.descriptor.id === next.capability);
          assert(cap && offeredTool && cap.fingerprint === offeredTool.fingerprint && cap.execute === offeredTool.execute, "DELEGATION_CAPABILITY_CHANGED");
          const args = freeze(next.args), operationId = `delegation:${runId}:${goal.spent.steps + 1}`;
          const validate = () => {
            const current = registry.snapshot(target).find(c => c.descriptor.id === next.capability);
            assert(current?.fingerprint === cap.fingerprint && current.execute === cap.execute, "DELEGATION_CAPABILITY_CHANGED");
            assert(!read(taskId).socialDelegation.recoveryReadOnly || current.descriptor.effect === "read", "DELEGATION_RECOVERY_READ_ONLY");
            assert(cap.descriptor.effect !== "write" || !read(taskId).socialDelegation.steps.some(s => stepGeneration(s) < generation(initial)
              && s.effect === "write" && s.capability === next.capability
              && (s.argumentDigestVersion !== 1 || typeof s.argumentDigest !== "string"
                || !/^[a-f0-9]{64}$/.test(s.argumentDigest) || s.argumentDigest === argumentDigest(args))
              && !(s.status === "failed" && s.applied === false)), "DELEGATION_PRIOR_EFFECT_REPLAY");
            assert(Object.keys(args).every(k => cap.descriptor.argumentKeys.includes(k)) && current.validate(args, target) === true, "DELEGATION_ARGS_INVALID");
            assert(cap.descriptor.risk === "low" || authorizeStep?.(freeze({ taskId, target, operationId, executionGeneration: generation(initial), capability: next.capability, args })) === true,
              "DELEGATION_APPROVAL_REQUIRED");
            const latest = check(revision), available = limits();
            assert(latest.spent.steps <= available.maxSteps && latest.spent.units <= available.maxUnits
              && latest.spent.plannerCalls <= available.maxPlannerCalls, "DELEGATION_BUDGET_EXHAUSTED");
          };
          validate();
          assert(goal.spent.steps < b.maxSteps && goal.spent.units + cap.descriptor.cost <= b.maxUnits && !unresolved(goal), "DELEGATION_BUDGET_EXHAUSTED");
          await patch(current => {
            check(revision); validate();
            const available = limits();
            assert(current.spent.steps < available.maxSteps && current.spent.units + cap.descriptor.cost <= available.maxUnits,
              "DELEGATION_BUDGET_EXHAUSTED");
            return { ...current, spent: { ...current.spent, steps: current.spent.steps + 1, units: current.spent.units + cap.descriptor.cost },
              steps: [...current.steps, { operationId, capability: next.capability, effect: cap.descriptor.effect, controlRevision: revision,
                executionGeneration: generation(initial), argumentDigestVersion: 1, argumentDigest: argumentDigest(args),
                status: "claimed", code: "DELEGATION_CLAIMED", at: now() }] };
          }, revision);
          let receipt, observation = "", invoked = false;
          try {
            const raw = await bounded(revision, meta => {
              invoked = true;
              return cap.execute(args, { ...meta, taskId, operationId, target, executionGeneration: generation(initial) });
            }, validate);
            assert(plain(raw), "DELEGATION_RECEIPT_INVALID");
            const status = raw.status;
            if (status === "succeeded") {
              // Receipt scopes may identify an encountered group member, but
              // the actual routing envelope must still be this exact group.
              const receiptScope = raw.scope?.groupId
                ? Object.fromEntries(Object.entries(raw.scope).filter(([key]) => !["userId", "peerUserId", "senderId", "senderUserId"].includes(key))) : raw.scope;
              assert(JSON.stringify(delegationTarget(receiptScope)) === JSON.stringify(target), "DELEGATION_FOREIGN_SCOPE");
              jsonData(raw.scope, 4096, { scope: target });
              if (cap.descriptor.effect === "write") assert(id(raw.receiptId), "DELEGATION_RECEIPT_INVALID");
              const value = jsonData(raw.value ?? null, 65536, { scope: target });
              const projected = observe(value, target);
              assert(typeof projected === "string", "DELEGATION_OBSERVATION_INVALID");
              observation = sanitizeArchiveValue(projected);
              // Byte bound, not UTF-16 length; do not feed raw tool payload back.
              while (Buffer.byteLength(observation) > b.maxObservationBytes) observation = observation.slice(0, Math.floor(observation.length / 2));
              receipt = { status, code: safeCode(raw.code), ...(id(raw.receiptId) ? { receiptId: raw.receiptId } : {}) };
            } else if (status === "failed" && raw.applied === false) receipt = { status, code: safeCode(raw.code), applied: false };
            else receipt = { status: status === "accepted" ? "accepted" : "uncertain", code: "DELEGATION_UNCONFIRMED" };
          } catch (error) {
            const unknown = cap.descriptor.effect === "write" && invoked;
            receipt = { status: unknown ? "uncertain" : "failed", code: safeCode(error?.code), ...(!unknown ? { applied: false } : {}) };
          }
          // Always settle audit evidence even when cancelled/quiet/retargeted.
          // No guard here: cancellation must not erase an already-dispatched act.
          goal = await patch(current => {
            const step = current.steps.find(s => s.operationId === operationId);
            assert(step?.status === "claimed", "DELEGATION_RECEIPT_CONFLICT");
            const stopped = current.status !== "running";
            return { ...current, steps: current.steps.map(s => s.operationId === operationId ? { ...s, ...receipt, observation, settledAt: now() } : s),
              ...(!stopped && ["accepted", "uncertain"].includes(receipt.status) ? { status: receipt.status, code: "DELEGATION_UNRESOLVED_EFFECT" } : {}) };
          });
          if (goal.status !== "running") return outcome(goal);
          // A known-not-applied failure may be replaced by another currently
          // available capability on the NEXT planner turn; no hidden retry.
        } catch (error) {
          if (error?.code === "DELEGATION_CONTROL_CHANGED" && read(taskId).socialDelegation.status === "running") continue;
          throw error;
        }
      }
    } catch (error) {
      // Persistence uncertainty is never "fixed" by attempting another write.
      if (["DELEGATION_DURABILITY_UNKNOWN", "TASK_DURABILITY_UNKNOWN"].includes(error?.code)) throw error;
      const current = read(taskId).socialDelegation;
      if (generation(current) !== generation(initial)) return outcome(current);
      if (current.status !== "running") return outcome(current);
      return outcome(await patch(latest => ({ ...latest, status: unresolved(latest) ? "uncertain"
        : error?.code === "DELEGATION_BUDGET_EXHAUSTED" ? "budget_exhausted"
          : error?.code === "DELEGATION_CANCELLED" ? "interrupted" : "blocked", code: safeCode(error?.code) })));
    }
  }
  function status(taskId) {
    const goal = read(taskId).socialDelegation;
    return goal ? { status: goal.status, revision: goal.revision, executionGeneration: generation(goal), controlRevision: goal.controlRevision, spent: copy(goal.spent),
      code: goal.code, receipts: goal.steps.map(s => ({ operationId: s.operationId, capability: s.capability, status: s.status, code: s.code })) } : null;
  }
  return Object.freeze({ start, control, execute, status });
}
