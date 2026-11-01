import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TaskRuntime, publicTask } from "../src/task-runtime.js";
import { createCapabilityRegistry } from "../src/social-delegation.js";
import { createOwnerSocialController } from "../src/owner-social-controller.js";
import { getOwnerGuidance } from "../src/owner-guidance.js";

const hash = text => createHash("sha256").update(text).digest("hex"), clone = structuredClone;
const target = accountId => ({ accountId, logicalBotId: `account:${accountId}`, groupId: "31001", conversationId: "group:31001" });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 3000; i++) { if (predicate()) return; await delay(1); } assert.fail("fixture timeout"); }
async function fixture(run) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-social-controller-test-"));
  let tasks;
  try {
    const state = { root: {}, revision: "r1", session: "session1", control: "control1", serial: 0, calls: [], wires: [], reads: [], notices: [],
      config: { autonomousSocial: { version: 1, enabled: true, guidance: true, delegation: true },
        taskMode: { enabled: true, ownerUserIds: [], allowedGroupIds: [], workspaceBaseDir: "tasks", maxTurns: 20, maxRuntimeMs: 40000 } },
      accounts: [{ id: "alpha", logicalBotId: "account:alpha", aliases: ["小甲"] }, { id: "beta", logicalBotId: "account:beta" }],
      targets: ["alpha", "beta"].map(accountId => ({ ...target(accountId), name: `${accountId}群` })),
      failWrite: false, writes: 0, classify: null, plan: null };
    const originals = new WeakMap(), verifications = new Map();
    let tail = Promise.resolve(), controller;
    const verifyEnvelope = (value, text) => {
      if (text === undefined) {
        const known = verifications.get(value?.verificationId);
        return !state.rejectActorCopy && !!known && JSON.stringify(value) === JSON.stringify(known.actor) && known.sessionId === state.session
          && value.configRevision === state.revision && value.controlRevision === state.control;
      }
      const entry = originals.get(value);
      if (!entry || entry.actor.textHash !== hash(text)) return false;
      // Returns current session as well: the controller must compare it to its
      // original snapshot rather than just checking a copied actor boolean.
      return { actor: clone(entry.actor), sessionId: state.session };
    };
    const host = {
      read: () => state.root,
      transact: build => {
        const job = tail.then(() => {
          const draft = clone(state.root), result = build(draft);
          assert.equal(typeof result?.then, "undefined", "repository builders are synchronous"); state.writes++;
          if (state.failWrite) { state.failWrite = false; throw new Error("fake persistence uncertainty"); }
          state.root = draft; return result;
        });
        tail = job.catch(() => {}); return job;
      },
      getConfig: () => state.config, getRevision: () => state.revision, accounts: () => state.accounts, targets: () => state.targets, verifyEnvelope,
      captureTarget: dest => ({ accountId: dest.accountId, revision: state.revision, control: state.control, session: state.session }),
      currentTarget: (pin, dest) => pin.accountId === dest.accountId && pin.revision === state.revision && pin.control === state.control
        && pin.session === state.session && !state.quiet,
      clock: Date.now,
      model: async request => {
        state.calls.push(request);
        if (request.phase === "classify") return state.classify(request);
        assert(request.target && request.taskId, "planner route comes from host-only metadata");
        return state.plan ? state.plan(request) : request.input.observations.some(o => o.controlRevision === request.input.controlRevision && o.status === "succeeded")
          ? { action: "wait", summary: "等待后续真实事件" } : { action: "tool", capability: "read_history", args: {} };
      }
    };
    const tools = {
      read_history: async (_args, meta) => { meta.guard(); state.reads.push({ accountId: meta.target.accountId, taskId: meta.taskId });
        return { status: "succeeded", scope: { ...meta.target, userId: "22001" }, value: { logicalBotId: meta.target.logicalBotId,
          conversationId: meta.target.conversationId, members: [{ userId: "22001" }, { userId: "22002" }] } }; },
      send: async (args, meta) => { meta.guard(); state.wires.push({ text: args.text, target: meta.target });
        return { status: "succeeded", scope: meta.target, receiptId: "fake-ack", value: "confirmed fake send" }; }
    };
    host.registry = createCapabilityRegistry({ tools, list: () => Object.keys(tools).map(id => ({ id, revision: 1, description: id,
      effect: id === "send" ? "write" : "read", risk: "low", cost: 1, available: true, argumentKeys: id === "send" ? ["text"] : [], validate: () => true })) });
    const createRuntime = () => new TaskRuntime({ rootDir, config: host.getConfig, execute: (task, runtime) => controller.execute(task, runtime),
      authorizeSocialTask: (actor, task, context) => controller?.authorizeSocialTask(actor, task, context),
      validateDelegationActor: (actor, task, context) => !context.event || state.eventVerifier?.(actor, task) === true,
      notify: async (task, notice) => { state.notices.push(notice); return state.onNotice ? state.onNotice(task, notice) : true; } });
    tasks = createRuntime();
    host.runtime = tasks; controller = createOwnerSocialController(host);
    const issue = (text, accountId = "alpha", overrides = {}) => {
      const at = Date.now(), serial = ++state.serial;
      const actor = { version: 1, verificationId: `verify:${serial}`, configRevision: state.revision, controlRevision: state.control,
        origin: "onebot", human: true, direct: true, actorUserId: "21001", ownerUserId: "21001", role: "owner",
        logicalBotId: `account:${accountId}`, accountId, conversationId: "private:21001", messageId: `message:${serial}`,
        sentAt: at, receivedAt: at, textHash: hash(text), explicitlyMentioned: false, managementAddressed: false,
        allowedScopes: [{ kind: "bot" }, { kind: "group", groupId: "31001" }], ...overrides };
      const envelope = Object.freeze({ key: serial });
      const entry = { actor, sessionId: state.session }; originals.set(envelope, entry); verifications.set(actor.verificationId, entry);
      return envelope;
    };
    const handle = (text, hint = "possible", account = "alpha") => controller.handle(issue(text, account), text, { kindHint: hint });
    const goal = (objective, accountId = "alpha", evidence) => request => {
      const dest = request.input.targets.find(t => t.accountId === accountId);
      return { kind: "goal", objective, targetId: dest.targetId, targetEvidence: evidence || `${accountId}群` };
    };
    const control = (action, objective) => () => ({ kind: "control", action, ...(objective ? { objective } : {}) });
    const idle = () => until(() => !tasks.running.size && !tasks.queue.length);
    const restart = () => {
      assert.equal(tasks.running.size, 0); assert.equal(tasks.queue.length, 0);
      tasks = createRuntime(); host.runtime = tasks; controller = createOwnerSocialController(host);
      return { tasks, controller };
    };
    await run({ state, tasks, controller, host, issue, handle, goal, control, idle, tools, restart, rootDir });
    await tasks.stateBarrier();
  } finally {
    if (tasks) { for (const controller of tasks.controllers.values()) controller.abort(); await until(() => !tasks.running.size); }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test("legacy read queries and ordinary chat cost zero additional models/writes", async () => fixture(async f => {
  for (const text of ["今天吃了面", "今日token", "/owner tasks", "为什么没回复"]) {
    assert.equal((await f.controller.handle(f.issue(text), text)).matched, false);
  }
  assert.equal((await f.handle("帮我解释一个普通问题", "query")).matched, false);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.writes, 0);
}));

test("full continuous goal: owner nonce bypasses only legacy formal authority, native queue/control works", async () => fixture(async f => {
  f.state.classify = f.goal("私密目标：持续整理议题");
  const queued = await f.handle("alpha群持续整理议题", "goal"); assert.equal(queued.status, "accepted"); await f.idle();
  const task = f.tasks.get(queued.taskId); assert.equal(task.status, "waiting"); assert.equal(task.socialOwnerUserId, "21001");
  assert.equal(task.permissionTier, "owner"); assert.equal(f.state.reads.length, 1); assert.equal(f.state.notices.length, 0);
  assert(!JSON.stringify(publicTask(task)).includes("私密目标")); assert(!JSON.stringify(queued).includes("私密目标"));
  assert.equal(task.objective, "主人持续委托");
  assert.equal(f.tasks.resume(task.id, { userId: "21001", verified: true, source: "qq", ...target("alpha") }).ok, false);
  const formal = f.tasks.createOffer({ ...target("alpha"), userId: "21001", objective: "formal" });
  assert.equal(f.tasks.confirm(formal.id, { userId: "21001", source: "admin" }).ok, false, "legacy formal permission is unchanged");
  f.state.classify = f.control("correct", "私密目标：只整理技术议题");
  const corrected = await f.handle("那件事只整理技术议题", "control"); assert.equal(corrected.taskId, task.id);
  assert.equal(task.socialDelegation.objective, "私密目标：只整理技术议题");
  f.state.classify = f.control("resume"); assert.equal((await f.handle("继续", "control")).status, "confirmed"); await f.idle();
  assert.equal(f.state.reads.length, 2); assert.equal(task.status, "waiting");
  f.state.classify = f.control("pause"); await f.handle("暂停", "control"); assert.equal(task.status, "paused");
  f.state.classify = f.control("cancel"); await f.handle("取消", "control"); assert.equal(task.status, "cancelled");
  assert.equal(task.socialDelegation.steps.length, 2); assert.equal(f.state.wires.length, 0);
}));

test("guidance reuses one classifier and prepare's detailed schema with copied-source verification", async () => fixture(async f => {
  f.state.classify = request => {
    assert.deepEqual(request.input.guidance.schema.participation.mode, ["silent", "addressed_only", "reduced", "normal", "engaged"]);
    assert.deepEqual(request.input.guidance.operationSchema.update.required, ["op", "id", "expectedVersion", "value", "evidence"]);
    assert.equal(request.accountId, "alpha"); assert.equal(request.logicalId, "account:alpha");
    return { kind: "guidance", guidance: { operations: [{ op: "create", scope: { kind: "group", groupId: "31001" },
      field: "participation", value: { mode: "reduced" }, evidence: "少插话" }] } };
  };
  const result = await f.handle("以后少插话", "guidance"); assert.equal(result.status, "confirmed");
  assert.equal(f.state.calls.length, 1); assert.equal(getOwnerGuidance(f.state.root, { logicalBotId: "account:alpha" }).rules.length, 1);
  assert(!JSON.stringify(f.state.root).includes("以后少插话")); assert.equal(f.tasks.list().length, 0);
}));

test("two simultaneous bots use target-specific planner/account models, no global last account", async () => fixture(async f => {
  f.state.classify = request => f.goal(`目标-${request.accountId}`, request.accountId)(request);
  f.state.plan = async request => {
    await delay(request.target.accountId === "alpha" ? 3 : 1);
    assert.equal(request.input.objective, `目标-${request.target.accountId}`);
    assert.equal(f.tasks.get(request.taskId).accountId, request.target.accountId);
    return request.input.observations.length ? { action: "wait", summary: `模型-${request.target.accountId}` }
      : { action: "tool", capability: "read_history", args: {} };
  };
  const [a, b] = await Promise.all([f.handle("alpha群持续整理", "goal", "alpha"), f.handle("beta群持续整理", "goal", "beta")]);
  await f.idle(); assert.equal(f.tasks.get(a.taskId).accountId, "alpha"); assert.equal(f.tasks.get(b.taskId).accountId, "beta");
  assert.deepEqual(new Set(f.state.reads.map(r => r.accountId)), new Set(["alpha", "beta"]));
  f.state.classify = f.control("correct", "甲的新目标"); await f.handle("更正甲目标", "control", "alpha");
  assert.equal(f.tasks.get(b.taskId).socialDelegation.objective, "目标-beta");
  f.state.classify = f.control("cancel"); await f.handle("取消", "control", "beta");
  assert.equal(f.tasks.get(b.taskId).status, "cancelled"); assert.equal(f.tasks.get(a.taskId).status, "waiting");
}));

test("ambiguous names clarify; explicit cross-bot selection starts new task and keeps old receipts", async () => fixture(async f => {
  f.state.targets.forEach(t => { t.name = "项目群"; }); f.state.classify = f.goal("ambiguous", "beta", "项目群");
  assert.equal((await f.handle("帮我在项目群持续整理", "goal")).status, "clarify"); assert.equal(f.tasks.list().length, 0);
  f.state.classify = f.goal("alpha目标", "alpha", "alpha:31001");
  const a = await f.handle("alpha:31001持续整理", "goal"); await f.idle();
  const receipts = clone(f.tasks.get(a.taskId).socialDelegation.steps);
  f.state.classify = f.goal("beta目标", "beta", "beta:31001");
  const b = await f.handle("改为beta:31001持续整理", "goal", "alpha"); await f.idle();
  assert.notEqual(a.taskId, b.taskId); assert.equal(f.tasks.get(b.taskId).logicalBotId, "account:beta");
  assert.deepEqual(f.tasks.get(a.taskId).socialDelegation.steps, receipts);
}));

for (const change of ["session", "revision", "control", "quiet", "target", "account", "actor_copy"]) {
  test(`classification revalidates ${change} before authority or queue mutation`, async () => fixture(async f => {
    const entered = deferred(), release = deferred();
    f.state.classify = async request => { entered.resolve(); await release.promise; return f.goal("stale")(request); };
    const running = f.handle("alpha群持续整理", "goal"); await entered.promise;
    if (change === "quiet") f.state.quiet = true;
    else if (change === "actor_copy") f.state.rejectActorCopy = true;
    else if (change === "target") f.state.targets = [];
    else if (change === "account") f.state.accounts[0].enabled = false;
    else f.state[change] = `${change}:new`;
    release.resolve(); const result = await running;
    assert.notEqual(result.status, "accepted"); assert.equal(f.tasks.list().length, 0); assert.equal(f.state.wires.length, 0);
  }));
}

test("goal correction CAS pins the pre-classifier goal revision, not newest state", async () => fixture(async f => {
  f.state.classify = f.goal("old"); const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  const entered = deferred(), release = deferred();
  f.state.classify = async () => { entered.resolve(); await release.promise; return { kind: "control", action: "correct", objective: "stale correction" }; };
  const running = f.handle("更正这件事", "control"); await entered.promise;
  f.tasks.mutateDelegation(created.taskId, goal => ({ ...goal, revision: goal.revision + 1, controlRevision: goal.controlRevision + 1, objective: "newer correction" }));
  release.resolve(); assert.equal((await running).code, "DELEGATION_CONTROL_CONFLICT");
  assert.equal(f.tasks.get(created.taskId).socialDelegation.objective, "newer correction");
}));

test("message replay coalesces classifier/goal creation and survives controller recreation", async () => fixture(async f => {
  const text = "alpha群持续整理", envelope = f.issue(text); f.state.classify = f.goal("one");
  const results = await Promise.all([f.controller.handle(envelope, text, { kindHint: "goal" }), f.controller.handle(envelope, text, { kindHint: "goal" })]);
  await f.idle(); assert.equal(results[0].taskId, results[1].taskId); assert.equal(f.tasks.list().length, 1);
  const restarted = createOwnerSocialController(f.host);
  assert.equal((await restarted.handle(envelope, text, { kindHint: "goal" })).code, "OWNER_SOCIAL_ALREADY_CLAIMED");
  assert.equal(f.state.calls.filter(c => c.phase === "classify").length, 1);
}));

test("autonomousSocial gates and existing taskMode budgets remain unchanged", async () => fixture(async f => {
  for (const key of ["optOut", "paused", "frozen"]) {
    f.state.config.autonomousSocial[key] = true;
    assert.equal((await f.handle("alpha群持续整理", "goal")).matched, false);
    f.state.config.autonomousSocial[key] = false;
  }
  const config = clone(f.state.config); f.state.classify = f.goal("budget-test");
  f.state.config.taskMode.maxTurns = 3;
  await f.handle("alpha群持续整理", "goal"); await f.idle();
  const planned = f.state.calls.find(c => c.phase === "plan"); assert.equal(planned.input.remaining.steps, 3);
  assert.equal(planned.input.remaining.plannerCalls, 3); assert.equal(f.state.config.taskMode.maxTurns, 3);
  assert.equal(f.state.config.taskMode.maxRuntimeMs, config.taskMode.maxRuntimeMs);
}));

test("repository uncertainty cannot retry parser, publish guidance, or start real work", async () => fixture(async f => {
  f.state.failWrite = true; f.state.classify = f.goal("none");
  const result = await f.handle("alpha群持续整理", "goal"); assert.equal(result.status, "uncertain");
  assert.equal(f.state.calls.length, 0); assert.equal(f.tasks.list().length, 0); assert.equal(f.state.writes, 1);
}));

test("fresh attested group event can resume durable owner goal without forging a new owner actor", async () => fixture(async f => {
  f.state.classify = f.goal("standing owner goal");
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  const task = f.tasks.get(created.taskId), trusted = new WeakSet();
  f.state.eventVerifier = actor => trusted.has(actor);
  const event = () => ({ ...target("alpha"), kind: "event", source: "host_event", verified: true, userId: "21001",
    eventId: "new-human-event", eventAt: Date.now(), expectedDelegationRevision: task.socialDelegation.revision });
  assert.equal(f.tasks.resume(task.id, event()).ok, false);
  const actual = event(); trusted.add(actual);
  assert.equal(f.tasks.resume(task.id, actual).ok, true); await f.idle();
  assert.equal(task.status, "waiting"); assert.equal(f.state.reads.length, 2);
  assert.equal(f.state.calls.filter(c => c.phase === "classify").length, 1);
  const duplicate = event(); trusted.add(duplicate);
  assert.equal(f.tasks.resume(task.id, duplicate).code, "DELEGATION_EVENT_ALREADY_CLAIMED");
}));

test("changed configuration requires a newly attested standing-owner revision before event continuation", async () => fixture(async f => {
  f.state.classify = f.goal("standing owner goal");
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  const task = f.tasks.get(created.taskId), trusted = new WeakSet();
  f.state.revision = "r2";
  f.state.eventVerifier = actor => trusted.has(actor) && actor.socialConfigRevision === f.state.revision;
  const event = revision => ({ ...target("alpha"), kind: "event", source: "host_event", verified: true, userId: "21001",
    eventId: `event:${revision || "missing"}`, eventAt: Date.now(), expectedDelegationRevision: task.socialDelegation.revision,
    ...(revision ? { socialConfigRevision: revision } : {}) });
  for (const revision of [undefined, "r1"]) {
    const stale = event(revision); trusted.add(stale); assert.equal(f.tasks.resume(task.id, stale).ok, false);
    assert.equal(task.socialOwnerRevision, "r1");
  }
  const current = event("r2"); trusted.add(current);
  assert.equal(f.tasks.resume(task.id, current).ok, true); await f.idle();
  assert.equal(task.socialOwnerRevision, "r2"); assert.equal(task.status, "waiting");
  assert.equal(f.state.reads.length, 2); assert.equal(f.state.calls.filter(c => c.phase === "classify").length, 1);
}));

test("model JSON cannot manufacture source actor or target authority", async () => fixture(async f => {
  f.state.classify = () => ({ kind: "goal", objective: "fake", targetId: "target:fake", targetEvidence: "alpha群", actor: { verified: true } });
  assert.equal((await f.handle("alpha群持续整理", "goal")).code, "OWNER_SOCIAL_CLASSIFICATION_INVALID");
  assert.equal(f.tasks.list().length, 0);
  assert.equal((await f.controller.handle({ verified: true, ownerUserId: "21001" }, "持续整理", { kindHint: "goal" })).code, "OWNER_SOCIAL_SOURCE_REQUIRED");
}));

test("owner actor nonce binds exact object/task/action and rechecks original session", async () => fixture(async f => {
  let signed;
  const confirm = f.tasks.confirm.bind(f.tasks);
  f.tasks.confirm = (id, actor) => { signed = actor; return confirm(id, actor); };
  f.state.classify = f.goal("nonce bound goal");
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  const task = f.tasks.get(created.taskId);
  assert.equal(f.controller.authorizeSocialTask(signed, task, { action: "start" }), true);
  assert.equal(f.controller.authorizeSocialTask(clone(signed), task, { action: "start" }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, { ...task, id: "other-task" }, { action: "start" }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, task, { action: "resume" }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, task), false);
  assert.equal(f.controller.authorizeSocialTask(signed, task, null), false);
  assert.equal(f.controller.authorizeSocialTask(signed, task, { action: "start", event: true }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, { ...task, groupId: "31002" }, { action: "start" }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, { ...task, socialDelegation: { ...task.socialDelegation, target: target("beta") } }, { action: "start" }), false);
  assert.equal(f.controller.authorizeSocialTask(signed, { ...task, ...target("beta") }, { action: "start" }), false);
  f.state.session = "reconnected";
  assert.equal(f.controller.authorizeSocialTask(signed, task, { action: "start" }), false);
}));

const completedResult = task => ({ ok: true, delegationStatus: "completed", delegationRevision: task.socialDelegation.revision,
  delegationControlRevision: task.socialDelegation.controlRevision, delegationSupplementCount: task.socialDelegation.supplementCount || 0 });
const completeAfterRead = request => request.input.observations.some(o => o.controlRevision === request.input.controlRevision && o.status === "succeeded")
  ? { action: "complete", summary: "PRIVATE_OWNER_RESULT" } : { action: "tool", capability: "read_history", args: {} };

for (const outcome of ["accepted", "lost_ack"]) {
  test(`private completion is durably claimed and owner-only once: ${outcome}`, async () => fixture(async f => {
    f.state.classify = f.goal("PRIVATE_OWNER_OBJECTIVE"); f.state.plan = completeAfterRead;
    const ownerDM = [];
    f.state.onNotice = (task, notice) => {
      const stored = JSON.parse(fs.readFileSync(f.tasks.taskPath(task.id), "utf8"));
      assert.equal(stored.socialCompletionNotice.status, "claimed");
      assert.equal(stored.status, "completed"); assert.equal(notice.audience, "owner_private");
      assert.equal(task.groupId, "31001", "group action destination is not notification audience");
      assert.equal(task.socialOwnerUserId, "21001"); assert.equal(task.socialDelegation.summary, "PRIVATE_OWNER_RESULT");
      assert(!JSON.stringify(notice).includes("PRIVATE_OWNER_")); assert.deepEqual(notice.artifacts, []);
      ownerDM.push(task.socialOwnerUserId);
      if (outcome === "lost_ack") throw new Error("synthetic lost ACK after owner DM dispatch");
      return true;
    };
    const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
    const task = f.tasks.get(created.taskId);
    assert.equal(task.status, "completed"); assert.deepEqual(ownerDM, ["21001"]); assert.equal(f.state.wires.length, 0);
    assert.equal(task.socialCompletionNotice.status, outcome === "accepted" ? "accepted" : "uncertain");
    assert(!JSON.stringify(publicTask(task)).includes("PRIVATE_OWNER_"));
    await f.tasks.finishDelegation(task, completedResult(task)); assert.equal(ownerDM.length, 1);
    const restarted = f.restart(); await restarted.tasks.pump(); await f.idle();
    const reloaded = restarted.tasks.get(task.id);
    await restarted.tasks.finishDelegation(reloaded, completedResult(reloaded));
    assert.equal(ownerDM.length, 1); assert.equal(restarted.tasks.queue.length, 0);
  }));
}

test("private completion cannot enter notifier when its durable notice claim fails", async () => fixture(async f => {
  f.state.classify = f.goal("no unclaimed DM"); f.state.plan = completeAfterRead;
  const persist = f.tasks.persist.bind(f.tasks);
  f.tasks.persist = task => {
    if (task.socialCompletionNotice?.status === "claimed") throw Object.assign(new Error("synthetic claim uncertainty"), { code: "TASK_DURABILITY_UNKNOWN" });
    return persist(task);
  };
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  assert.equal(f.state.notices.length, 0); assert.equal(f.tasks.get(created.taskId).authorityBlocked, true);
}));

test("lost notification settlement publication retains claimed-on-disk and never replays", async () => fixture(async f => {
  f.state.classify = f.goal("one owner notification"); f.state.plan = completeAfterRead;
  const persist = f.tasks.persist.bind(f.tasks);
  f.tasks.persist = task => {
    if (task.socialCompletionNotice?.status === "accepted") throw Object.assign(new Error("synthetic settlement uncertainty"), { code: "TASK_DURABILITY_UNKNOWN" });
    return persist(task);
  };
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  assert.equal(f.state.notices.length, 1); assert.equal(f.tasks.get(created.taskId).authorityBlocked, true);
  const stored = JSON.parse(fs.readFileSync(f.tasks.taskPath(created.taskId), "utf8"));
  assert.equal(stored.socialCompletionNotice.status, "claimed");
  const { tasks } = f.restart(), task = tasks.get(created.taskId);
  await tasks.pump(); await tasks.finishDelegation(task, completedResult(task));
  assert.equal(f.state.notices.length, 1); assert.equal(task.socialCompletionNotice.status, "claimed");
}));

test("controller restart waits for a genuine event, then read-only re-evaluates without notification", async () => fixture(async f => {
  f.state.classify = f.goal("standing owner goal");
  const created = await f.handle("alpha群持续整理", "goal"); await f.idle();
  const oldReceipts = clone(f.tasks.get(created.taskId).socialDelegation.steps);
  const { tasks } = f.restart(), task = tasks.get(created.taskId), trusted = new WeakSet();
  const calls = f.state.calls.length;
  assert.equal(task.status, "waiting"); assert.equal(task.socialDelegation.recoveryReadOnly, true);
  await tasks.pump(); await delay(5); assert.equal(f.state.calls.length, calls);
  f.state.eventVerifier = actor => trusted.has(actor) && !f.state.quiet;
  const actor = { ...target("alpha"), kind: "event", source: "host_event", verified: true, userId: "21001",
    eventId: "fresh-after-restart", eventAt: Date.now(), expectedDelegationRevision: task.socialDelegation.revision };
  assert.equal(tasks.resume(task.id, clone(actor)).ok, false);
  trusted.add(actor);
  f.state.quiet = true; assert.equal(tasks.resume(task.id, actor).ok, false); f.state.quiet = false;
  f.state.plan = request => {
    assert(request.input.capabilities.every(c => c.effect === "read"));
    return completeAfterRead(request);
  };
  assert.equal(tasks.resume(task.id, actor).ok, true); await f.idle();
  assert.equal(task.status, "completed"); assert.equal(f.state.reads.length, 2);
  assert.deepEqual(task.socialDelegation.steps.slice(0, oldReceipts.length), oldReceipts);
  assert.equal(f.state.notices.length, 0); assert.equal(f.state.wires.length, 0);
  assert.equal(f.state.calls.filter(c => c.phase === "classify").length, 1);
}));
