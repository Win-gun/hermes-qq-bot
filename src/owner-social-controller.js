import { createHash } from "node:crypto";
import { createAgentExecutionLoop, createTaskDelegationStore, delegationTarget } from "./social-delegation.js";
import { applyOwnerGuidance, prepareOwnerGuidance, getOwnerGuidance, OWNER_GUIDANCE_FIELDS } from "./owner-guidance.js";
import { parseOwnerCommand } from "./owner-authority.js";
import { normalizeAutonomousSocialPolicy } from "./autonomous-social-migration.js";

const plain = x => x !== null && typeof x === "object" && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const keys = (x, allowed) => plain(x) && Reflect.ownKeys(x).every(k => allowed.includes(k)
  && Object.hasOwn(Object.getOwnPropertyDescriptor(x, k), "value"));
const hash = text => createHash("sha256").update(text).digest("hex");
const clone = structuredClone;
const fail = code => Object.assign(new Error(code), { code });
const demand = (yes, code) => { if (!yes) throw fail(code); };
const token = x => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(x);
const qq = x => typeof x === "string" && /^[1-9]\d{4,19}$/.test(x);
const freeze = x => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const safeCode = x => /^[A-Z][A-Z0-9_]{0,79}$/.test(x || "") ? x : "OWNER_SOCIAL_BLOCKED";
const unmatched = () => ({ matched: false, status: "unmatched", code: "OWNER_SOCIAL_LEGACY" });
const active = goal => goal && !["completed", "cancelled"].includes(goal.status);
const operationSchema = freeze({ create: { required: ["op", "scope", "field", "value", "evidence"] },
  update: { required: ["op", "id", "expectedVersion", "value", "evidence"], value: "full replacement" },
  supersede: { required: ["op", "id", "expectedVersion", "value", "evidence"] },
  revoke: { required: ["op", "id", "expectedVersion", "evidence"] },
  query: { required: ["op", "scope", "evidence"], optional: ["field"] },
  scope: { bot: { kind: "bot" }, group: { kind: "group", groupId: "allowed QQ" },
    member: { kind: "member", userId: "allowed QQ", groupId: "optional allowed QQ" } },
  id: "current exact guidance id", expectedVersion: "current positive integer", evidence: "literal original human substring <=240" });

/** NO IO/send/shell/model client or additional scheduler is created here.
 *
 * HOST (all callbacks except model/transact are synchronous):
 * read()/transact(syncBuilder): existing MemoryRuntime; transact returns the
 * builder result only AFTER durable publication. Throw on uncertain publication.
 * getConfig(): migrated autonomousSocial master flags; absent defaults OFF.
 * All call/step/deadline budgets reuse EXISTING taskMode maxTurns/maxRuntimeMs.
 * getRevision(): opaque current config revision, equal to actor.configRevision.
 * accounts(): real {id,logicalBotId,enabled?} rows. targets(): CURRENT authorized
 * {accountId,logicalBotId,groupId,name?} rows. No guessed group/user lookup.
 * verifyEnvelope(envelope,canonicalText): false OR {actor,sessionId}. actor is the
 * EXACT owner-guidance Actor shape, authenticated by original human OneBot event
 * and configured owner private chat, NEVER QQ text/quote/role flags. The same
 * original actor, verificationId, textHash, session and control revision MUST
 * still verify after EVERY await and inside the writer. At most 120s intake TTL.
 * verifyEnvelope(copy(actor)): exactly true iff verificationId resolves to the
 * same ORIGINAL event and current session/config/control/owner identity. This
 * overload must not rely on object identity, parsed text or a verified flag.
 * captureTarget(target)/currentTarget(pin,target): actual carrier, logical route,
 * quiet, consent, policy/config/control fences including final wire checks.
 * registry: createCapabilityRegistry result (synchronous dynamic snapshots).
 * model({phase:'classify',input,accountId,logicalId}) or
 * model({phase:'plan',input,target,taskId,signal}): async BOUND text-only model;
 * parent owns actual usage receipts/ledger/timeouts. Classifier has NO tools.
 * runtime: existing TaskRuntime; clock(): epoch milliseconds.
 *
 * Wiring (construct runtime first using closures, then this controller):
 * authorizeSocialTask:(actor,task,ctx)=>controller.authorizeSocialTask(actor,task,ctx)
 * execute:(task,runtime)=>task.socialDelegation ? controller.execute(task,runtime)
 *   : legacyExecute(task,runtime). NEVER use this callback for legacy task auth.
 * New owner tasks use a WeakMap-issued actor, not a forged configured task-owner.
 * TaskRuntime itself enqueues/claims/resumes; no new scheduler or sender exists.
 * TaskRuntime.notify for these tasks MUST privately route to the currently
 * verified socialOwnerUserId, NEVER the group's action destination. Completion
 * carries audience:'owner_private', with a durable one-shot notice claim; a
 * boolean true is host acceptance only, not a fabricated QQ message receipt.
 * Fresh group-event continuation uses TaskRuntime.validateDelegationActor with
 * an ACTUAL host event nonce, standing-owner check, scope/freshness/CAS; never
 * manufacture a new owner actor from that group's QQ text. It cannot lift pause.
 * validateDelegationActor(actor,taskSnapshot,{action,event}) is synchronous and
 * must return EXACTLY true. For runtime.resume(task.id,actor), issue
 * {kind:'event',source:'host_event',verified:true,userId:task.socialOwnerUserId,
 *  accountId,logicalBotId,conversationId,groupId,eventId,eventAt,
 *  expectedDelegationRevision:task.socialDelegation.revision} from an actual
 * inbound event. eventAt must be <=120s old. Authenticate the original sender
 * separately; userId identifies the standing owner, NOT that group's sender.
 * If configuration changed, revalidate standing authority/current policy and
 * attach the trusted CURRENT socialConfigRevision, or execute rejects it.
 * Only waiting/budget_exhausted/interrupted/blocked accept event continuation;
 * accepted/uncertain/claimed-write NEVER replay. Restart itself never enqueues:
 * all nonterminal recovered goals retain recoveryReadOnly, including explicit
 * owner resume. Pause needs an explicit owner control; receipts and cumulative
 * spent budget survive every continuation. No renewal/reset is inferred.
 *
 * Classifier returns ONE strict JSON object (already decoded by host):
 * {kind:'goal',objective,targetId,targetEvidence} |
 * {kind:'guidance',guidance:{operations:[...]}} |
 * {kind:'control',action:'correct'|'pause'|'cancel'|'resume',objective?,
 *   targetId?,targetEvidence?} | {kind:'chat'|'query'|'clarify'}.
 * targetId MUST be a candidate ID; evidence is an EXACT unique host alias present
 * in the human text. Duplicate group names -> clarification, never pick first.
 * No explicit target on a control means the latest OWN goal on the ingress bot.
 * Switching bots requires an explicit target each time; it creates a NEW task,
 * never moves old receipts. Guidance remains on the verified ingress identity.
 *
 * kindHint ('chat'/'query'/'possible'/'goal'/'guidance'/'control') is trusted HOST
 * intake metadata. A small default lexical ELIGIBILITY gate is NOT a command
 * parser; hosts should reuse their existing intent hints for unusual phrasings.
 * Ordinary chat and legacy read/command paths do not incur another model call.
 * All returned content is private-owner metadata; parent owns authenticated reply.
 */
export function createOwnerSocialController(host) {
  const { read, transact, getConfig, getRevision, accounts, targets, verifyEnvelope, captureTarget, currentTarget, model, registry, runtime,
    clock = Date.now } = host || {};
  demand([read, transact, getConfig, getRevision, accounts, targets, verifyEnvelope, captureTarget, currentTarget, model, clock]
    .every(f => typeof f === "function") && typeof registry?.snapshot === "function"
    && ["createOffer", "confirm", "resume", "cancel", "persist", "get", "list"].every(k => typeof runtime?.[k] === "function"), "OWNER_SOCIAL_HOST_INVALID");
  const actors = new WeakMap(), pending = new Map();
  const policy = () => {
    // Some migrated installations retain the earlier frozen fence. Honor it
    // without inventing/persisting another switch or changing migration output.
    const { frozen, ...raw } = getConfig()?.autonomousSocial || {};
    demand(frozen === undefined || typeof frozen === "boolean", "OWNER_SOCIAL_POLICY_INVALID");
    return { ...normalizeAutonomousSocialPolicy(raw), frozen: frozen === true };
  };
  const enabled = () => { const p = policy(); return p.enabled && !p.optOut && !p.paused && !p.frozen; };
  const revision = () => String(getRevision());
  const now = () => { const at = clock(); demand(Number.isSafeInteger(at) && at > 0, "OWNER_SOCIAL_CLOCK"); return at; };
  async function mutate(build) {
    let builderError;
    try { return await transact(root => { try { return build(root); } catch (error) { builderError = error; throw error; } }); }
    catch (error) { if (error === builderError) throw error; throw fail("OWNER_SOCIAL_DURABILITY_UNKNOWN"); }
  }
  function source(envelope, text) {
    const receipt = verifyEnvelope(envelope, text), a = receipt?.actor, at = now();
    demand(receipt && token(receipt.sessionId) && plain(a) && a.version === 1 && a.role === "owner" && a.origin === "onebot"
      && a.human === true && a.direct === true && qq(a.actorUserId) && a.actorUserId === a.ownerUserId
      && a.conversationId === `private:${a.ownerUserId}` && token(a.accountId) && token(a.logicalBotId) && token(a.messageId)
      && token(a.verificationId) && token(a.controlRevision) && a.configRevision === revision() && a.textHash === hash(text)
      && Number.isSafeInteger(a.sentAt) && Number.isSafeInteger(a.receivedAt) && a.sentAt <= a.receivedAt && a.receivedAt <= at
      && at - a.receivedAt <= 120000 && at - a.sentAt <= 300000, "OWNER_SOCIAL_SOURCE_REQUIRED");
    demand(accounts().some(account => account.id === a.accountId && account.enabled !== false
      && (account.logicalBotId === undefined || account.logicalBotId === a.logicalBotId)), "OWNER_SOCIAL_SOURCE_REQUIRED");
    demand(verifyEnvelope(clone(a)) === true, "OWNER_SOCIAL_SOURCE_REQUIRED");
    return freeze({ actor: clone(a), sessionId: receipt.sessionId });
  }
  function sourceCurrent(proof) {
    demand(enabled(), "OWNER_SOCIAL_DISABLED");
    demand(JSON.stringify(source(proof.envelope, proof.text)) === JSON.stringify(proof.receipt), "OWNER_SOCIAL_STALE_SOURCE");
    return true;
  }
  function catalogue() {
    const rows = targets(), peers = accounts(), out = [], seen = new Set();
    demand(Array.isArray(rows) && rows.length <= 128 && Array.isArray(peers), "OWNER_SOCIAL_TARGETS_INVALID");
    for (const row of rows) {
      const account = peers.find(a => a.id === row.accountId && a.enabled !== false);
      if (!account || account.logicalBotId !== undefined && account.logicalBotId !== row.logicalBotId) continue;
      const target = delegationTarget({ accountId: row.accountId, logicalBotId: row.logicalBotId, groupId: row.groupId,
        conversationId: `group:${row.groupId}` });
      const targetId = `target:${hash(JSON.stringify(target)).slice(0, 24)}`;
      if (seen.has(targetId)) continue; seen.add(targetId);
      const name = typeof row.name === "string" && row.name.length <= 120 ? row.name : `${row.accountId}:${row.groupId}`;
      const aliases = Array.isArray(account.aliases) ? account.aliases.slice(0, 32).filter(x => typeof x === "string" && x.length <= 100).map(x => `${x}:${row.groupId}`) : [];
      out.push({ targetId, name, target, aliases: [...new Set([name, `${row.accountId}:${row.groupId}`, row.groupId, ...aliases])] });
    }
    return out;
  }
  function allowed(target) { return catalogue().some(c => JSON.stringify(c.target) === JSON.stringify(target)); }
  const restrictive = action => ["pause", "cancel"].includes(action);
  function live(proof, action) {
    sourceCurrent(proof);
    demand(allowed(proof.target), "OWNER_SOCIAL_TARGET_REVOKED");
    if (!restrictive(action)) demand(policy().delegation && currentTarget(proof.targetPin, proof.target) === true, "OWNER_SOCIAL_TARGET_STALE");
    return true;
  }
  function issue(proof, taskId, action, expectedRevision) {
    const actor = freeze({ userId: proof.receipt.actor.ownerUserId, kind: "human", source: "qq", verified: true,
      socialConfigRevision: revision(),
      ...proof.target, ...(expectedRevision === undefined ? {} : { expectedDelegationRevision: expectedRevision }) });
    actors.set(actor, { ...proof, taskId, action }); return actor;
  }
  function authorizeSocialTask(actor, task, context = {}) {
    const proof = actor && actors.get(actor);
    if (!proof || !keys(context, ["action", "event"]) || !task?.socialDelegation || task.id !== proof.taskId || task.socialOwnerUserId !== proof.receipt.actor.ownerUserId
      || task.accountId !== proof.target.accountId || task.logicalBotId !== proof.target.logicalBotId
      || task.conversationId !== proof.target.conversationId || task.groupId !== proof.target.groupId || task.messageType !== "group"
      || context.action !== proof.action || context.event !== undefined && context.event !== false) return false;
    try {
      return JSON.stringify(delegationTarget(task.socialDelegation.target)) === JSON.stringify(proof.target) && live(proof, proof.action);
    } catch { return false; }
  }
  const loop = createAgentExecutionLoop({ store: createTaskDelegationStore(runtime), registry,
    capture: target => freeze({ revision: revision(), pin: clone(captureTarget(target)) }),
    guard: (snapshot, target) => enabled() && policy().delegation && snapshot.revision === revision() && allowed(target) && currentTarget(snapshot.pin, target) === true,
    authorize: (actor, command) => {
      const proof = actors.get(actor);
      return !!proof && proof.taskId === command.taskId && proof.action === command.action
        && JSON.stringify(proof.target) === JSON.stringify(command.target) && live(proof, command.action);
    },
    planner: (input, meta) => model({ phase: "plan", input, target: meta.target, taskId: meta.taskId, signal: meta.signal }),
    budget: () => {
      const b = runtime.config();
      return { maxSteps: b.maxTurns, maxPlannerCalls: b.maxTurns, maxUnits: b.maxTurns,
        deadline: now() + b.maxRuntimeMs, maxContextBytes: 16000, maxObservationBytes: 2000 };
    },
    observe: value => typeof value === "string" ? value : JSON.stringify(value), clock });
  function commands(root, write = false) {
    if (!root.ownerSocialController) {
      if (!write) return {};
      root.ownerSocialController = { version: 1, commands: {} };
    }
    demand(root.ownerSocialController.version === 1 && plain(root.ownerSocialController.commands), "OWNER_SOCIAL_STORE_INVALID");
    return root.ownerSocialController.commands;
  }
  const goals = ownerId => runtime.list({ limit: 512 }).filter(t => t.socialOwnerUserId === ownerId && active(t.socialDelegation));
  function resolveTarget(parsed, candidates, text, fallback) {
    if (parsed.targetId === undefined && parsed.targetEvidence === undefined) {
      demand(fallback, "OWNER_SOCIAL_TARGET_REQUIRED"); return fallback;
    }
    demand(token(parsed.targetId) && typeof parsed.targetEvidence === "string" && parsed.targetEvidence.length > 0
      && parsed.targetEvidence.length <= 160 && text.includes(parsed.targetEvidence), "OWNER_SOCIAL_TARGET_EVIDENCE");
    const aliases = candidates.filter(c => c.aliases.includes(parsed.targetEvidence));
    demand(aliases.length === 1, "OWNER_SOCIAL_TARGET_AMBIGUOUS");
    demand(aliases[0].targetId === parsed.targetId, "OWNER_SOCIAL_TARGET_EVIDENCE"); return aliases[0];
  }
  function classify(value) {
    demand(keys(value, ["kind", "action", "objective", "guidance", "targetId", "targetEvidence"]), "OWNER_SOCIAL_CLASSIFICATION_INVALID");
    if (["chat", "query", "clarify"].includes(value.kind)) demand(keys(value, ["kind"]), "OWNER_SOCIAL_CLASSIFICATION_INVALID");
    else if (value.kind === "guidance") demand(keys(value, ["kind", "guidance"]) && keys(value.guidance, ["operations"]), "OWNER_SOCIAL_CLASSIFICATION_INVALID");
    else if (value.kind === "goal") demand(keys(value, ["kind", "objective", "targetId", "targetEvidence"])
      && typeof value.objective === "string" && value.objective.trim() && value.objective.length <= 4000, "OWNER_SOCIAL_CLASSIFICATION_INVALID");
    else demand(value.kind === "control" && keys(value, ["kind", "action", "objective", "targetId", "targetEvidence"])
      && ["correct", "pause", "cancel", "resume"].includes(value.action) && (value.action === "correct"
        ? typeof value.objective === "string" && value.objective.trim() && value.objective.length <= 4000 : value.objective === undefined), "OWNER_SOCIAL_CLASSIFICATION_INVALID");
    return clone(value);
  }
  async function process(proof, commandId) {
    const { receipt, text } = proof, a = receipt.actor;
    let claimed = false, actionTaskId;
    try {
      const claim = await mutate(root => {
        sourceCurrent(proof);
        const rows = commands(root, true), previous = rows[commandId];
        if (previous) return { duplicate: true, ...clone(previous) };
        demand(Object.keys(rows).length < 2048, "OWNER_SOCIAL_CAPACITY");
        rows[commandId] = { textHash: a.textHash, status: "claimed", at: now() }; return { duplicate: false };
      });
      if (claim.duplicate) return { matched: true, status: claim.status === "claimed" ? "uncertain" : claim.status,
        code: claim.textHash === a.textHash ? "OWNER_SOCIAL_ALREADY_CLAIMED" : "OWNER_SOCIAL_SOURCE_CONFLICT", ...(claim.taskId ? { taskId: claim.taskId } : {}) };
      claimed = true;
      sourceCurrent(proof);
      const candidates = catalogue(), pins = new Map(candidates.map(c => [c.targetId, clone(captureTarget(c.target))]));
      const owned = goals(a.ownerUserId).map(t => ({ id: t.id, target: clone(t.socialDelegation.target), revision: t.socialDelegation.revision,
        objective: t.socialDelegation.objective, status: t.socialDelegation.status, updatedAt: t.socialDelegation.updatedAt }));
      const guidance = getOwnerGuidance(read(), { logicalBotId: a.logicalBotId });
      const classifyInput = {
        instruction: "只分类，不执行。长期指导用guidance operations；持续委托用goal；已有目标改动用control。普通问答返回chat/query。只使用唯一真实targetId和人类原文中的完整唯一别名targetEvidence；有歧义返回clarify。不得产生actor、授权或工具。跨Bot新目标必须显式目标，不能搬迁旧任务。",
        targets: candidates.map(c => ({ targetId: c.targetId, name: c.name, ...c.target, aliases: c.aliases })),
        activeGoals: owned.filter(g => g.target.logicalBotId === a.logicalBotId).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 4) };
      const callClassifier = input => {
        demand(Buffer.byteLength(JSON.stringify(input)) <= 65536, "OWNER_SOCIAL_CONTEXT_LIMIT");
        return model({ phase: "classify", accountId: a.accountId, logicalId: a.logicalBotId, input: freeze(input) });
      };
      const verifyActor = actor => JSON.stringify(actor) === JSON.stringify(a) && verifyEnvelope(clone(actor)) === true && sourceCurrent(proof);
      let parsed, invoked = false, classificationError;
      const prepared = await prepareOwnerGuidance({ root: read(), actor: a, text, now: now(), verifyActor, eligible: true,
        parse: async request => {
          invoked = true;
          try {
            parsed = classify(await callClassifier({ ...classifyInput, text, guidance: { ...request.input, operationSchema } }));
          } catch (error) { classificationError = error; throw error; }
          return parsed.kind === "guidance" ? parsed.guidance : null;
        } });
      if (classificationError) throw classificationError;
      // A research goal may contain a URL or private material which the stricter
      // durable-guidance source filter refuses. It can still be classified once;
      // it can NEVER become a guidance write via this fallback.
      if (!invoked && prepared.duplicate) parsed = { kind: "guidance", guidance: {} };
      else if (!invoked) {
        demand(verifyActor(a), "OWNER_SOCIAL_SOURCE_REQUIRED");
        parsed = classify(await callClassifier({ ...classifyInput, text,
          guidance: { available: false, fields: OWNER_GUIDANCE_FIELDS, operationSchema,
            reason: prepared.code || "GUIDANCE_SOURCE_REJECTED" } }));
      }
      demand(parsed, prepared.code || "OWNER_SOCIAL_CLASSIFICATION_INVALID");
      sourceCurrent(proof);
      let result;
      if (["chat", "query"].includes(parsed.kind)) result = unmatched();
      else if (parsed.kind === "clarify") result = { matched: true, status: "clarify", code: "OWNER_SOCIAL_TARGET_REQUIRED" };
      else if (parsed.kind === "guidance") {
        demand(policy().guidance, "OWNER_SOCIAL_GUIDANCE_DISABLED");
        sourceCurrent(proof);
        demand(prepared.ok && prepared.matched, prepared.code || "OWNER_SOCIAL_GUIDANCE_INVALID");
        if (prepared.duplicate) result = { matched: true, status: "confirmed", code: "OWNER_SOCIAL_GUIDANCE_DUPLICATE" };
        else {
          const applied = await mutate(root => {
            sourceCurrent(proof);
            demand(prepared.plan.expectedRevision === guidance.revision, "OWNER_GUIDANCE_CAS");
            for (const op of prepared.plan.operations) {
              const scope = op.scope || guidance.rules.find(rule => rule.id === op.id)?.scope;
              if (scope?.groupId) demand(catalogue().some(c => c.target.logicalBotId === a.logicalBotId
                && c.target.groupId === scope.groupId), "OWNER_SOCIAL_TARGET_REVOKED");
            }
            return applyOwnerGuidance(root, { ...prepared.plan, now: now(), verifyActor });
          });
          sourceCurrent(proof); demand(applied.ok, applied.code || "OWNER_SOCIAL_GUIDANCE_INVALID");
          result = { matched: true, status: "confirmed", code: "OWNER_SOCIAL_GUIDANCE_APPLIED", revision: applied.revision };
        }
      } else {
        const recent = owned.filter(g => g.target.logicalBotId === a.logicalBotId).sort((x, y) => y.updatedAt - x.updatedAt)[0];
        const fallback = parsed.kind === "control" && recent ? candidates.find(c => JSON.stringify(c.target) === JSON.stringify(recent.target)) : null;
        const selected = resolveTarget(parsed, candidates, text, fallback);
        const scoped = { ...proof, target: selected.target, targetPin: pins.get(selected.targetId) };
        live(scoped, parsed.kind === "goal" ? "start" : parsed.action);
        if (parsed.kind === "goal") {
          const task = runtime.createOffer({ ...selected.target, messageType: "group", userId: a.ownerUserId, senderName: "主人",
            objective: "主人持续委托", summary: "主人持续委托", requestedTools: [] });
          actionTaskId = task.id;
          task.socialOwnerUserId = a.ownerUserId; task.socialOwnerPrivate = true; task.socialSourceClaim = commandId; runtime.persist(task);
          const actor = issue(scoped, task.id, "start");
          await loop.start(task.id, { kind: "goal", objective: parsed.objective, target: selected.target }, actor);
          live(scoped, "start");
          const confirmed = runtime.confirm(task.id, actor); demand(confirmed.ok, confirmed.code || "OWNER_SOCIAL_TASK_BLOCKED");
          result = { matched: true, status: "accepted", code: "OWNER_SOCIAL_GOAL_QUEUED", taskId: task.id };
        } else {
          const chosen = owned.filter(g => JSON.stringify(g.target) === JSON.stringify(selected.target)).sort((x, y) => y.updatedAt - x.updatedAt)[0];
          demand(chosen, "OWNER_SOCIAL_GOAL_REQUIRED");
          const task = runtime.get(chosen.id); demand(task?.socialDelegation?.revision === chosen.revision, "DELEGATION_CONTROL_CONFLICT");
          actionTaskId = task.id;
          const actor = issue(scoped, task.id, parsed.action, ["resume", "cancel"].includes(parsed.action) ? chosen.revision : undefined);
          let changed;
          if (parsed.action === "resume") changed = runtime.resume(task.id, actor);
          else if (parsed.action === "cancel") changed = runtime.cancel(task.id, actor);
          else changed = await loop.control(task.id, { action: parsed.action, expectedRevision: chosen.revision,
            ...(parsed.action === "correct" ? { objective: parsed.objective } : {}) }, actor);
          demand(changed.ok !== false, changed.code || "OWNER_SOCIAL_CONTROL_BLOCKED");
          result = { matched: true, status: "confirmed", code: "OWNER_SOCIAL_CONTROL_APPLIED", taskId: task.id };
        }
      }
      await mutate(root => {
        const row = commands(root)[commandId]; demand(row?.status === "claimed", "OWNER_SOCIAL_CLAIM_LOST");
        row.status = result.matched ? result.status : "unmatched"; row.code = result.code;
        if (result.taskId) row.taskId = result.taskId;
        return true;
      });
      return result;
    } catch (error) {
      // Do not retry either store, model or task creation. A claimed command on
      // disk remains an explicit uncertainty/reconciliation boundary on restart.
      const code = safeCode(error?.code);
      const clarify = /TARGET_(?:REQUIRED|AMBIGUOUS|EVIDENCE)|GOAL_REQUIRED/.test(code);
      return { matched: true, status: clarify ? "clarify" : code === "OWNER_SOCIAL_DURABILITY_UNKNOWN" || !claimed ? "uncertain" : "blocked", code,
        ...(actionTaskId ? { taskId: actionTaskId } : {}),
        ...(clarify ? { question: "请明确账号和群，使用唯一的账号:群号。" } : {}) };
    }
  }
  async function handle(envelope, text, { kindHint } = {}) {
    if (typeof text !== "string" || !text.trim() || text.length > 4096) return unmatched();
    try {
      const p = policy();
      if (!enabled() || !p.guidance && !p.delegation || kindHint === "guidance" && !p.guidance || kindHint === "goal" && !p.delegation) return unmatched();
    } catch { return { matched: true, status: "blocked", code: "OWNER_SOCIAL_POLICY_INVALID" }; }
    if (kindHint !== undefined && !["chat", "query", "possible", "goal", "guidance", "control"].includes(kindHint)) return unmatched();
    // Legacy commands/read queries and explicit ordinary-chat hints bypass this
    // path. This gate only chooses model eligibility; it never extracts actions.
    if (["chat", "query"].includes(kindHint) || parseOwnerCommand(text)) return unmatched();
    if (!kindHint && !/(以后|今后|接下来|持续|帮我|指导|记住|改成|更正|不对|刚才|暂停|取消|继续|恢复|先别|少点|多点)/u.test(text)) return unmatched();
    let proof;
    try { proof = { envelope, text, receipt: source(envelope, text) }; } catch { return { matched: true, status: "blocked", code: "OWNER_SOCIAL_SOURCE_REQUIRED" }; }
    const a = proof.receipt.actor, commandId = hash(JSON.stringify([a.logicalBotId, a.accountId, a.conversationId, a.ownerUserId, a.messageId]));
    const prior = pending.get(commandId);
    if (prior) return prior.textHash === a.textHash ? clone(await prior.promise) : { matched: true, status: "blocked", code: "OWNER_SOCIAL_SOURCE_CONFLICT" };
    if (pending.size >= 64) return { matched: true, status: "blocked", code: "OWNER_SOCIAL_BUSY" };
    // Install before model/writer callbacks can re-enter this message.
    const promise = Promise.resolve().then(() => process(proof, commandId));
    pending.set(commandId, { textHash: a.textHash, promise });
    try { return clone(await promise); } finally { pending.delete(commandId); }
  }
  return Object.freeze({ handle, execute: (task, context) => {
    if (task.socialOwnerRevision !== revision()) return { ok: false, delegationStatus: "interrupted", code: "OWNER_SOCIAL_STALE_GRANT" };
    return loop.execute(task, context);
  }, authorizeSocialTask });
}
