import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CapabilityError, canonicalNoFollowPath, hasUnresolvedSideEffects, normalizeWorkGrant } from "./work-capabilities.js";
import { sanitizeArchiveValue } from "./privacy-filter.js";
import { applyDelegationControl, delegationReplayBlocked, delegationTarget } from "./social-delegation.js";

const delegated = task => task?.socialDelegation?.version === 1;
const delegationStages = Object.freeze({ waiting: "等待新事件", paused: "已暂停", budget_exhausted: "等待资源预算",
  interrupted: "执行已中断", accepted: "已受理，等待核实", uncertain: "结果待核实", blocked: "执行受限", cancelled: "已取消", completed: "已完成" });
const resumableDelegation = ["waiting", "paused", "budget_exhausted", "interrupted", "blocked"];
const unresolvedTask = task => hasUnresolvedSideEffects(task) || (delegated(task) && delegationReplayBlocked(task.socialDelegation));
function projectDelegation(task, status) {
  if (!Object.hasOwn(delegationStages, status)) return;
  task.status = status;
  task.currentStage = delegationStages[status];
  task.lastProgressText = delegationStages[status];
  task.lastError = "";
  task.completedAt = ["completed", "cancelled"].includes(status) ? new Date().toISOString() : "";
}

function invalidateDelegationGrants(task, at) {
  // Preserve grant/wake history, but neither authority nor a planned opportunity
  // may cross an execution boundary even if the host config revision is unchanged.
  task.grantRevision = nextCounter(task.grantRevision);
  task.grants = asArray(task.grants).map(grant => grant.revokedAt ? grant
    : { ...grant, revokedAt: new Date(at).toISOString(), revokedBy: "execution-boundary" });
  if (["pending", "claimed"].includes(task.socialWake?.status)) {
    task.socialWake = { ...task.socialWake, revokedFrom: task.socialWake.status,
      status: "revoked", revokedAt: at, reason: "execution-boundary" };
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function nextCounter(value) {
  const previous = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new CapabilityError("TASK_COUNTER_INVALID");
  return previous + 1;
}

function safeId(value, fallback = "task") {
  const clean = String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
    const directory = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function containsPath(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

export function taskOwnedBy(task, logicalBotId) {
  return typeof logicalBotId === "string" && logicalBotId.length > 0 && task?.logicalBotId === logicalBotId;
}

function assignedOwner(task) {
  return typeof task?.logicalBotId === "string" && task.logicalBotId.trim().length > 0 && !task.logicalBotId.startsWith("unassigned:");
}

function backupBeforeOwnerMigration(filePath) {
  const backupPath = `${filePath}.pre-logical-owner.bak`;
  fs.chmodSync(path.dirname(filePath), 0o700);
  try {
    fs.writeFileSync(backupPath, fs.readFileSync(filePath), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // A prior migration attempt may have backed up before its atomic write failed.
    // Never overwrite that first original, nor follow a substituted backup symlink.
    if (!fs.lstatSync(backupPath).isFile()) throw new Error("task owner backup is not a regular file");
    if (!fs.readFileSync(backupPath).equals(fs.readFileSync(filePath))) throw new Error("task owner backup does not match original task");
    fs.chmodSync(backupPath, 0o600);
  }
}

export class TaskRuntime {
  constructor({ rootDir, config, execute, notify, log = () => {}, warn = () => {}, ownerForAccount = (id) => id ? `account:${id}` : "legacy:default",
    validateDelegationActor, authorizeSocialTask, clock = Date.now }) {
    this.rootDir = rootDir;
    this.getConfig = typeof config === "function" ? config : () => config || {};
    this.execute = execute;
    this.notify = notify;
    this.log = log;
    this.warn = warn;
    this.ownerForAccount = ownerForAccount;
    this.validateDelegationActor = validateDelegationActor;
    this.authorizeSocialTask = authorizeSocialTask;
    this.clock = clock;
    this.tasks = new Map();
    this.running = new Set();
    this.queue = [];
    this.controllers = new Map();
    this.publishedTasks = new Map();
    this.stateListeners = new Set();
    this.stateTail = Promise.resolve();
    this.stateFailures = [];
    this.stateFailureCount = 0;
    this.stateObservedFailure = 0;
    this.load();
  }

  config() {
    const cfg = this.getConfig()?.taskMode || {};
    const configured = String(cfg.workspaceBaseDir || "data/tasks");
    return {
      enabled: cfg.enabled !== false,
      shadowMode: cfg.shadowMode === true,
      workspaceBaseDir: path.resolve(this.rootDir, configured),
      ownerUserIds: asArray(cfg.ownerUserIds).map(String),
      allowedGroupIds: asArray(cfg.allowedGroupIds).map(String),
      maxConcurrentGlobal: Math.max(1, Number(cfg.maxConcurrentGlobal || 2)),
      maxConcurrentPerConversation: Math.max(1, Number(cfg.maxConcurrentPerConversation || 1)),
      progressHeartbeatMs: Math.max(60_000, Number(cfg.progressHeartbeatMs || 180_000)),
      maxRuntimeMs: Math.max(30_000, Number(cfg.maxRuntimeMs || 20 * 60_000)),
      maxTurns: Math.max(1, Number(cfg.maxTurns || 30)),
      maxArtifactBytes: Math.max(1024, Number(cfg.maxArtifactBytes || 20 * 1024 * 1024)),
      defaultToolsets: asArray(cfg.defaultToolsets || ["web", "todo"]).map(String).filter(Boolean)
    };
  }

  taskDir(taskId) {
    return path.join(this.config().workspaceBaseDir, safeId(taskId));
  }

  taskPath(taskId) {
    return path.join(this.taskDir(taskId), "task.json");
  }

  eventsPath(taskId) {
    return path.join(this.taskDir(taskId), "events.jsonl");
  }

  outputsDir(taskId) {
    return path.join(this.taskDir(taskId), "outputs");
  }

  resolveLogicalOwner(accountId = "", explicitOwner) {
    const id = String(accountId || "");
    let resolved;
    try { resolved = this.ownerForAccount(id); } catch { /* Unknown ownership fails closed. */ }
    const owner = typeof resolved === "string" && resolved.trim() ? resolved : `unassigned:${id || "legacy:default"}`;
    if (explicitOwner !== undefined && explicitOwner !== owner) throw new Error("logicalBotId does not match account owner");
    return owner;
  }

  load() {
    const baseDir = this.config().workspaceBaseDir;
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(baseDir)) {
      const filePath = path.join(baseDir, name, "task.json");
      if (!fs.existsSync(filePath)) continue;
      const task = readJson(filePath);
      if (!task?.id) continue;
      let needsWrite = false;
      if (!Object.hasOwn(task, "logicalBotId")) {
        backupBeforeOwnerMigration(filePath);
        task.logicalBotId = this.resolveLogicalOwner(task.accountId);
        needsWrite = true;
      }
      let interrupted = false;
      if (["running", "planning", "reviewing", "delivering"].includes(task.status)) {
        task.status = "interrupted";
        task.interruptedAt = new Date().toISOString();
        task.lastError = "bridge restarted while task was active";
        needsWrite = true;
        interrupted = true;
        task.revision = (Number.isSafeInteger(task.revision) ? task.revision : 0) + 1;
      }
      if (delegated(task) && !["completed", "cancelled"].includes(task.socialDelegation.status)) {
        const goal = task.socialDelegation;
        goal.recoveryReadOnly = true;
        goal.runId = null;
        invalidateDelegationGrants(task, this.clock());
        if (["running", "ready"].includes(goal.status)) goal.status = delegationReplayBlocked(goal) ? "uncertain" : "interrupted";
        goal.revision = nextCounter(goal.revision);
        goal.controlRevision = nextCounter(goal.controlRevision);
        goal.updatedAt = this.clock();
        goal.code = "DELEGATION_RESTART_NO_REPLAY";
        projectDelegation(task, goal.status);
        task.revision = nextCounter(task.revision);
        needsWrite = true;
      }
      if (needsWrite) writeJsonAtomic(filePath, task);
      if (interrupted) appendJsonl(path.join(baseDir, name, "events.jsonl"), { at: task.interruptedAt, type: "interrupted", reason: task.lastError });
      this.tasks.set(task.id, task);
      this.publishedTasks.set(task.id, structuredClone(task));
    }
  }

  createOffer(input) {
    const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const task = {
      id,
      status: "offered",
      conversationId: String(input.conversationId || ""),
      messageType: input.messageType || "group",
      accountId: String(input.accountId || ""),
      logicalBotId: this.resolveLogicalOwner(input.accountId, input.logicalBotId),
      groupId: input.groupId ? String(input.groupId) : "",
      userId: String(input.userId || ""),
      senderName: input.senderName || input.userId || "",
      objective: String(input.objective || "").trim(),
      summary: String(input.summary || input.objective || "").trim(),
      requestedTools: asArray(input.requestedTools).map(String),
      expectedArtifacts: asArray(input.expectedArtifacts).map(String),
      complexity: ["simple", "standard", "complex"].includes(String(input.complexity || "")) ? String(input.complexity) : "standard",
      reasoningEffort: ["low", "medium", "high"].includes(String(input.reasoningEffort || "")) ? String(input.reasoningEffort) : "medium",
      requiresLocalFiles: input.requiresLocalFiles === true,
      requiresComputer: input.requiresComputer === true,
      requiresAuthenticatedBrowser: input.requiresAuthenticatedBrowser === true,
      permissionTier: input.permissionTier || "isolated",
      grants: [],
      revision: 0,
      attempt: 0,
      attemptId: "",
      grantRevision: 0,
      operationLedger: [],
      supplements: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastProgressAt: 0,
      currentStage: "等待确认",
      lastProgressText: "已理解任务，等待确认执行。",
      resultSummary: "",
      lastError: "",
      review: null
    };
    fs.mkdirSync(this.outputsDir(id), { recursive: true, mode: 0o700 });
    this.tasks.set(id, task);
    this.persist(task);
    this.event(task, "offered", { summary: task.summary, requestedTools: task.requestedTools, complexity: task.complexity, reasoningEffort: task.reasoningEffort });
    return task;
  }

  persist(task) {
    const previous = this.publishedTasks.get(task.id);
    task.revision = nextCounter(previous?.revision);
    task.attempt = Number.isSafeInteger(task.attempt) ? task.attempt : 0;
    task.attemptId ||= "";
    task.grantRevision = Number.isSafeInteger(task.grantRevision) ? task.grantRevision : 0;
    task.operationLedger ||= [];
    task.updatedAt = new Date(this.clock()).toISOString();
    try { writeJsonAtomic(this.taskPath(task.id), task); }
    catch (error) {
      // Never expose an uncommitted grant/receipt through getTask after failure.
      if (previous) {
        for (const key of Object.keys(task)) delete task[key];
        Object.assign(task, structuredClone(previous));
      } else this.tasks.delete(task.id);
      task.authorityBlocked = true;
      throw new CapabilityError("TASK_DURABILITY_UNKNOWN");
    }
    this.tasks.set(task.id, task);
    this.publishedTasks.set(task.id, structuredClone(task));
    this.publishState(task);
  }

  // Existing task writer, synchronous latest-draft builder; no second writer.
  mutateDelegation(taskId, build) {
    const task = this.get(taskId);
    if (!task || task.authorityBlocked) throw new CapabilityError("DELEGATION_TASK_UNAVAILABLE");
    const goal = build(structuredClone(task.socialDelegation ?? null), { ...structuredClone(task),
      currentLogicalBotId: this.resolveLogicalOwner(task.accountId), executionActive: this.running.has(task.id) || task.status === "queued",
      unresolvedOperations: hasUnresolvedSideEffects(task) });
    if (!goal || goal.version !== 1 || typeof goal.then === "function") throw new CapabilityError("DELEGATION_MUTATION_INVALID");
    const previous = task.socialDelegation;
    const renewed = previous && (goal.executionGeneration ?? 1) !== (previous.executionGeneration ?? 1);
    if (renewed) {
      if (this.running.has(task.id) || task.status === "queued") throw new CapabilityError("DELEGATION_EXECUTION_ACTIVE");
      if (goal.executionGeneration !== (previous.executionGeneration ?? 1) + 1 || goal.code !== "DELEGATION_REAUTHORIZED"
        || !goal.authorization || goal.status !== "ready") throw new CapabilityError("DELEGATION_GENERATION_INVALID");
      if (hasUnresolvedSideEffects(task)) throw new CapabilityError("UNRESOLVED_SIDE_EFFECT");
      if (this.resolveLogicalOwner(task.accountId) !== task.logicalBotId) throw new CapabilityError("DELEGATION_IDENTITY_CHANGED");
      invalidateDelegationGrants(task, this.clock());
      task.socialPrivateContext = false;
      task.supplements = [];
      task.executionSupplementCount = 0;
      task.previousResultSummary = "";
      task.resultSummary = "";
      task.review = null;
      task.deliveryArtifactNames = [];
      task.objective = task.summary = task.socialOwnerPrivate ? "主人持续委托" : goal.objective;
      task.status = "interrupted"; // ready, NOT queued: caller must confirm afresh.
      task.completedAt = "";
      task.suppressStartNotice = true;
    }
    if (["paused", "cancelled"].includes(goal.status) && goal.controlRevision !== previous?.controlRevision) {
      this.controllers.get(task.id)?.abort();
      this.queue = this.queue.filter(id => id !== task.id);
      invalidateDelegationGrants(task, this.clock());
    }
    task.socialDelegation = structuredClone(goal);
    projectDelegation(task, goal.status);
    this.persist(task);
    return { ok: true, durable: true, value: structuredClone(goal) };
  }

  // Detached, redacted projections only. Replay never pumps tasks or replays an
  // operation/notification. Listeners are asynchronous, not on the chat lane.
  snapshot(taskId) {
    const project = task => task ? immutableSnapshot(this.tasks.get(task.id)?.authorityBlocked ? { ...task, authorityBlocked: true } : task) : null;
    if (taskId !== undefined) return project(this.publishedTasks.get(String(taskId)));
    return Object.freeze([...this.publishedTasks.values()].map(project));
  }

  subscribeState(listener, { replay = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("state listener must be a function");
    const subscription = { listener };
    this.stateListeners.add(subscription);
    if (replay) for (const task of this.publishedTasks.values()) this.publishState(task, [subscription], true);
    return () => this.stateListeners.delete(subscription);
  }

  publishState(task, subscriptions = [...this.stateListeners], replay = false) {
    const snapshot = immutableSnapshot(task);
    this.stateTail = this.stateTail.then(async () => {
      await Promise.all(subscriptions.map(async subscription => {
        if (!this.stateListeners.has(subscription)) return;
        try { await subscription.listener(snapshot, Object.freeze({ replay })); }
        catch {
          this.stateFailureCount += 1;
          this.stateFailures.push(Object.freeze({ taskId: snapshot.id, revision: snapshot.revision, replay, code: "TASK_STATE_PROJECTION_FAILED" }));
          this.stateFailures = this.stateFailures.slice(-128);
          try { this.warn("task state projection failed"); } catch { /* projection cannot fail execution */ }
        }
      }));
    });
  }

  stateBarrier() {
    const pending = this.stateTail, observed = this.stateObservedFailure;
    return pending.then(() => {
      const failures = this.stateFailureCount;
      this.stateObservedFailure = Math.max(this.stateObservedFailure, failures);
      if (failures > observed) {
        const error = new CapabilityError("TASK_STATE_PROJECTION_FAILED");
        error.failures = Object.freeze([...this.stateFailures]);
        throw error;
      }
      return Object.freeze({ ok: true });
    });
  }

  event(task, type, detail = {}) {
    appendJsonl(this.eventsPath(task.id), { at: new Date().toISOString(), type, ...detail });
  }

  activeForConversation(conversationId, { logicalBotId } = {}) {
    return Array.from(this.tasks.values()).find((task) => task.conversationId === String(conversationId)
      && (logicalBotId === undefined || taskOwnedBy(task, logicalBotId))
      && (["offered", "queued", "planning", "running", "waiting_permission", "reviewing", "delivering", "interrupted"].includes(task.status)
        || delegated(task) && ["waiting", "paused", "budget_exhausted", "blocked", "accepted", "uncertain"].includes(task.status)));
  }

  get(taskId) {
    return this.tasks.get(String(taskId || "")) || null;
  }

  list({ conversationId = "", logicalBotId, limit = 100 } = {}) {
    return Array.from(this.tasks.values())
      .filter((task) => !conversationId || task.conversationId === String(conversationId))
      .filter((task) => logicalBotId === undefined || taskOwnedBy(task, logicalBotId))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Number(limit || 100)));
  }

  canConfirm(task, actor = {}) {
    if (!assignedOwner(task)) return { ok: false, owner: false, reason: "任务归属未分配，已隔离，不能执行。" };
    if (task.authorityBlocked) return { ok: false, code: "TASK_DURABILITY_UNKNOWN", reason: "任务授权持久状态不确定，已停止新动作。" };
    const cfg = this.config();
    if (!cfg.enabled) return { ok: false, reason: "正式任务已停用。" };
    const actorId = String(actor.userId || "");
    if (!actorId || /^(model|ai|agent|tool)$/i.test(actor.source || "") || actor.kind === "model"
      || actor.accountId !== undefined && actor.accountId !== task.accountId
      || actor.logicalBotId !== undefined && actor.logicalBotId !== task.logicalBotId) return { ok: false, code: "HUMAN_ACTOR_REQUIRED", reason: "任务确认需要已验证的人类身份。" };
    if (delegated(task) && typeof this.authorizeSocialTask === "function") {
      // A fresh host event continues a DURABLE owner grant; it is not a new
      // owner command and cannot carry the controller's ephemeral WeakMap key.
      // The strict event verifier below still has to authenticate this event,
      // scope, freshness, current policy and exact goal revision before queuing.
      if (actor.source === "host_event" && actor.kind === "event" && actorId === task.socialOwnerUserId
        && /^[a-f0-9]{64}$/.test(task.socialSourceClaim || "") && typeof this.validateDelegationActor === "function") return { ok: true, owner: true };
      try {
        return this.authorizeSocialTask(actor, immutableSnapshot(task), { action: task.status === "offered" ? "start" : "resume" }) === true
          ? { ok: true, owner: true } : { ok: false, code: "SOCIAL_TASK_AUTHORITY_REQUIRED", reason: "社交委托需要宿主签发的真实主人权限。" };
      } catch { return { ok: false, code: "SOCIAL_TASK_AUTHORITY_REQUIRED", reason: "社交委托来源已失效。" }; }
    }
    const owner = cfg.ownerUserIds.includes(actorId);
    if (task.requiresLocalFiles || task.requiresComputer || task.requiresAuthenticatedBrowser) {
      return owner ? { ok: true, owner } : { ok: false, owner, reason: "该任务涉及本机或登录态，只能由主人确认。" };
    }
    if (owner) return { ok: true, owner };
    if (task.messageType === "group" && cfg.allowedGroupIds.includes(String(task.groupId)) && actorId === String(task.userId)) {
      return { ok: true, owner: false };
    }
    return { ok: false, owner: false, reason: "当前会话或账号没有正式任务权限。" };
  }

  /** Internal host attestation, not an actor/grant supplied by model JSON.
   * Ordinary formal work keeps canConfirm's historical semantics. Delegation
   * requires an authenticated qq/admin actor; host events additionally require
   * a synchronous source verifier and a pinned goal revision. The verifier must
   * check the actual transport event, freshness and the current standing policy.
   */
  delegationActorPermission(task, actor, action) {
    const deny = code => ({ ok: false, code, reason: "持续任务需要已验证的身份和当前事件来源。" });
    if (actor?.verified !== true || !["qq", "admin", "host_event"].includes(actor.source)
      || actor.kind !== undefined && !["human", "event"].includes(actor.kind)
      || actor.accountId !== undefined && actor.accountId !== task.accountId
      || actor.logicalBotId !== undefined && actor.logicalBotId !== task.logicalBotId
      || actor.groupId !== undefined && actor.groupId !== task.groupId
      || actor.conversationId !== undefined && actor.conversationId !== task.conversationId) return deny("DELEGATION_ACTOR_REQUIRED");
    const event = actor.source === "host_event";
    if (event) {
      const at = this.clock();
      if (action !== "resume" || actor.kind !== "event" || actor.accountId !== task.accountId || actor.logicalBotId !== task.logicalBotId
        || task.messageType === "group" && actor.groupId !== task.groupId
        || actor.conversationId !== task.conversationId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(actor.eventId || "")
        || !Number.isSafeInteger(actor.eventAt) || actor.eventAt < 0 || actor.eventAt > at || at - actor.eventAt > 120000
        || actor.expectedDelegationRevision !== task.socialDelegation.revision
        || typeof this.validateDelegationActor !== "function") return deny("DELEGATION_EVENT_SOURCE_REQUIRED");
      if (!["waiting", "budget_exhausted", "interrupted", "blocked"].includes(task.socialDelegation.status)) return deny("DELEGATION_EVENT_RESUME_BLOCKED");
      const key = createHash("sha256").update(JSON.stringify([task.logicalBotId, task.accountId, task.conversationId, actor.eventId])).digest("hex");
      const claims = task.socialDelegation.resumeEventClaims || [];
      if (!Array.isArray(claims) || claims.includes(key)) return deny("DELEGATION_EVENT_ALREADY_CLAIMED");
      if (claims.length >= 512) return deny("DELEGATION_EVENT_CAPACITY");
    } else if (actor.kind === "event") return deny("DELEGATION_ACTOR_REQUIRED");
    if (actor.expectedDelegationRevision !== undefined && actor.expectedDelegationRevision !== task.socialDelegation.revision)
      return deny("DELEGATION_CONTROL_CONFLICT");
    try {
      if (!event && this.authorizeSocialTask && this.authorizeSocialTask(actor, immutableSnapshot(task), Object.freeze({ action, event })) !== true)
        return deny("SOCIAL_TASK_AUTHORITY_REQUIRED");
      if (this.validateDelegationActor && this.validateDelegationActor(actor, immutableSnapshot(task), Object.freeze({ action, event })) !== true)
        return deny("DELEGATION_ACTOR_REQUIRED");
    } catch { return deny("DELEGATION_ACTOR_REQUIRED"); }
    return { ok: true, event };
  }

  confirm(taskId, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    if (delegated(task) && this.resolveLogicalOwner(task.accountId) !== task.logicalBotId)
      return { ok: false, code: "DELEGATION_IDENTITY_CHANGED", reason: "账号的逻辑身份已变化，需要新建委托。" };
    if (this.running.has(task.id)) return { ok: false, task, code: "TASK_BUSY", reason: "旧执行尚未退出。" };
    if (unresolvedTask(task)) return { ok: false, task, code: "UNRESOLVED_SIDE_EFFECT", reason: "存在已声明或结果不确定的执行副作用，不能恢复重放；此限制不包括通知回执。" };
    if (!["offered", "interrupted", "failed", ...(delegated(task) ? resumableDelegation : [])].includes(task.status)) return { ok: false, task, reason: `任务当前状态是 ${task.status}。` };
    const permission = this.canConfirm(task, actor);
    if (!permission.ok) return { ok: false, task, ...(permission.code ? { code: permission.code } : {}), reason: permission.reason };
    if (delegated(task)) {
      const allowed = this.delegationActorPermission(task, actor, task.status === "offered" ? "start" : "resume");
      if (!allowed.ok) return { ...allowed, task };
      // Identity is immutable. A target change needs a new host-validated task;
      // never transfer or discard the old task's operation/receipt history.
      let target;
      try { target = delegationTarget(task.socialDelegation.target); } catch { return { ok: false, code: "DELEGATION_TARGET_MISMATCH" }; }
      if (target.accountId !== task.accountId || target.logicalBotId !== task.logicalBotId || target.conversationId !== task.conversationId
        || (target.groupId ? target.groupId !== task.groupId || task.messageType !== "group"
          : target.userId !== task.userId || task.messageType !== "private")) return { ok: false, code: "DELEGATION_TARGET_MISMATCH" };
      let goal = task.socialDelegation;
      if (goal.status !== "ready") {
        try { goal = applyDelegationControl(goal, { action: "resume", expectedRevision: goal.revision }, this.clock()); }
        catch (error) { return { ok: false, code: error.code || "DELEGATION_NOT_RESUMABLE" }; }
      }
      if (allowed.event) {
        const key = createHash("sha256").update(JSON.stringify([task.logicalBotId, task.accountId, task.conversationId, actor.eventId])).digest("hex");
        goal = { ...goal, resumeEventClaims: [...(goal.resumeEventClaims || []), key] };
      }
      task.socialDelegation = goal;
    }
    task.confirmedBy = String(actor.userId || "");
    task.confirmedAt = new Date().toISOString();
    task.status = "queued";
    task.currentStage = "排队准备";
    task.lastProgressAt = Date.now();
    task.lastProgressText = "已确认，正在进入执行队列。";
    task.suppressStartNotice = actor.source === "qq" || delegated(task)
      && (actor.source === "host_event" || task.socialDelegation.recoveryReadOnly === true || (task.socialDelegation.executionGeneration ?? 1) > 1);
    task.permissionTier = permission.owner ? "owner" : "isolated";
    if (delegated(task) && this.authorizeSocialTask && typeof actor.socialConfigRevision === "string") task.socialOwnerRevision = actor.socialConfigRevision;
    task.lastError = "";
    task.completedAt = "";
    this.persist(task);
    this.event(task, "confirmed", { confirmedBy: task.confirmedBy, permissionTier: task.permissionTier });
    if (!this.queue.includes(task.id)) this.queue.push(task.id);
    queueMicrotask(() => this.pump());
    return { ok: true, task };
  }

  resume(taskId, actor = {}) {
    return this.confirm(taskId, actor);
  }

  grant(taskId, grant, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    if (!this.config().ownerUserIds.includes(String(actor.userId || ""))) return { ok: false, reason: "只有主人可以授予本机权限。" };
    if (task.authorityBlocked) return { ok: false, code: "TASK_DURABILITY_UNKNOWN", reason: "授权持久状态不确定，已停止新动作。" };
    if (!assignedOwner(task) || ["completed", "cancelled"].includes(task.status)) return { ok: false, code: "TASK_NOT_GRANTABLE", reason: "任务已结束或归属未分配。" };
    let item;
    try { item = normalizeWorkGrant(task, grant, actor, this.clock()); }
    catch (error) { return { ok: false, code: error.code || "GRANT_INVALID", reason: "授权目标、期限或身份无效，需要明确范围；不能使用旧 computer 广泛授权。" }; }
    if (task.status === "waiting_permission" && unresolvedTask(task)) return { ok: false, code: "UNRESOLVED_SIDE_EFFECT", reason: "副作用结果未确定，不能重新排队。" };
    task.grantRevision = nextCounter(task.grantRevision);
    item.grantRevision = task.grantRevision;
    task.grants = [...asArray(task.grants), item];
    if (task.status === "waiting_permission") {
      task.status = "queued";
      task.currentStage = "授权完成，重新排队";
    }
    task.lastProgressAt = Date.now();
    task.lastProgressText = `已收到 ${item.capability} 范围授权。`;
    this.persist(task);
    this.event(task, "permission_granted", { grantId: item.id, capability: item.capability, grantRevision: task.grantRevision, grantedBy: item.grantedBy });
    if (task.status === "queued" && !this.queue.includes(task.id)) this.queue.push(task.id);
    queueMicrotask(() => this.pump());
    return { ok: true, task, grant: publicGrant(item) };
  }

  revoke(taskId, grantId, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, code: "TASK_NOT_FOUND", reason: "任务不存在。" };
    if (!this.config().ownerUserIds.includes(String(actor.userId || "")) || /^(model|ai|agent|tool)$/i.test(actor.source || "")
      || actor.kind === "model" || actor.accountId !== undefined && actor.accountId !== task.accountId
      || actor.logicalBotId !== undefined && actor.logicalBotId !== task.logicalBotId) return { ok: false, code: "HUMAN_ACTOR_REQUIRED", reason: "只有已验证的主人可撤销授权。" };
    const grant = asArray(task.grants).find(item => item.id === grantId);
    if (!grant) return { ok: false, code: "GRANT_NOT_FOUND", reason: "授权不存在。" };
    if (grant.revokedAt) return { ok: true, task, grant: publicGrant(grant) };
    grant.revokedAt = new Date(this.clock()).toISOString();
    grant.revokedBy = String(actor.userId);
    task.grantRevision = nextCounter(task.grantRevision);
    if (this.running.has(task.id)) {
      task.status = "waiting_permission";
      task.currentStage = "授权已撤销";
      task.lastProgressText = "授权已撤销，等待当前执行停止。";
    }
    if (delegated(task) && !["cancelled", "completed"].includes(task.socialDelegation.status)) {
      task.socialDelegation = applyDelegationControl(task.socialDelegation,
        { action: "pause", expectedRevision: task.socialDelegation.revision }, this.clock());
      task.socialDelegation.code = "DELEGATION_GRANTS_REVOKED";
      projectDelegation(task, "paused");
      this.queue = this.queue.filter(id => id !== task.id);
      invalidateDelegationGrants(task, this.clock());
    }
    // Abort even if persistence fails; never let a failed revoke keep dispatching.
    this.controllers.get(task.id)?.abort();
    this.persist(task);
    this.event(task, "permission_revoked", { grantId, grantRevision: task.grantRevision, revokedBy: String(actor.userId) });
    return { ok: true, task, grant: publicGrant(grant) };
  }

  /** Sole-runtime-writer CAS for CapabilityBroker; no args, targets or raw errors.
   * Persisted claimed/uncertain records survive restart and block replay. This
   * is an audit ledger in the existing task store, NOT a second work queue.
   */
  recordOperation(record) {
    const task = this.get(record?.taskId);
    const reject = code => { throw new CapabilityError(code); };
    if (!task || record.logicalBotId !== task.logicalBotId || record.accountId !== task.accountId) reject("TASK_IDENTITY_MISMATCH");
    if (record.status === "claimed" && task.authorityBlocked) reject("TASK_DURABILITY_UNKNOWN");
    if (typeof record.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(record.operationId)
      || !["claimed", "succeeded", "failed", "uncertain"].includes(record.status)) reject("INVALID_OPERATION_RECORD");
    const ledger = asArray(task.operationLedger);
    const existing = ledger.find(item => item.operationId === record.operationId);
    if (record.status === "claimed") {
      if (existing) reject("OPERATION_DUPLICATE");
      if (!["planning", "running", "reviewing", "delivering"].includes(task.status) || record.attemptId !== task.attemptId
        || record.attempt !== task.attempt || record.grantRevision !== task.grantRevision) reject("TASK_AUTHORITY_CHANGED");
      if (record.sideEffect !== true && record.sideEffect !== false || !/^[a-f0-9]{64}$/.test(record.operationDigest || "")) reject("INVALID_OPERATION_RECORD");
      if (record.sideEffect && hasUnresolvedSideEffects(task)) reject("UNRESOLVED_SIDE_EFFECT");
      if (record.externalGrantId && ledger.some(item => item.externalGrantId === record.externalGrantId)) reject("EXTERNAL_GRANT_CONSUMED");
      if (ledger.length >= 2048) reject("OPERATION_LEDGER_FULL");
      const entry = Object.fromEntries(["taskId", "operationId", "attemptId", "attempt", "logicalBotId", "accountId", "capability", "action", "grantId", "grantRevision",
        "externalGrantId", "operationDigest", "targetDigest", "backendId", "sideEffect"].map(key => [key, record[key]]));
      task.operationLedger = [...ledger, { ...entry, status: "claimed", claimedAt: new Date(this.clock()).toISOString() }];
    } else {
      if (!existing || existing.status !== "claimed") reject("OPERATION_TRANSITION_DENIED");
      for (const key of ["attemptId", "attempt", "logicalBotId", "accountId", "capability", "action", "grantId", "grantRevision", "externalGrantId", "operationDigest", "targetDigest", "backendId", "sideEffect"]) {
        if (existing[key] !== record[key]) reject("OPERATION_RECORD_MISMATCH");
      }
      if (record.status === "failed" && record.applied !== false) reject("OPERATION_CERTAINTY_REQUIRED");
      existing.status = record.status;
      existing.settledAt = new Date(this.clock()).toISOString();
      if (record.status === "failed") existing.applied = false;
      if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(record.code)) existing.code = record.code;
      task.operationLedger = ledger;
    }
    this.persist(task);
    this.event(task, "operation", { operationId: record.operationId, status: record.status, capability: record.capability, attemptId: record.attemptId });
    return { ok: true, durable: true };
  }

  cancel(taskId, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    const actorId = String(actor.userId || "");
    const allowed = actorId && !/^(model|ai|agent|tool)$/i.test(actor.source || "") && actor.kind !== "model"
      && (actorId === String(task.userId) || this.config().ownerUserIds.includes(actorId));
    if (!allowed) return { ok: false, reason: "只有任务发起人或主人可以取消。" };
    if (delegated(task)) {
      const permission = this.delegationActorPermission(task, actor, "cancel");
      if (!permission.ok) return permission;
      if (!["cancelled", "completed"].includes(task.socialDelegation.status)) {
        task.socialDelegation = applyDelegationControl(task.socialDelegation,
          { action: "cancel", expectedRevision: task.socialDelegation.revision }, this.clock());
        invalidateDelegationGrants(task, this.clock());
      }
    }
    task.status = "cancelled";
    task.currentStage = "已取消";
    task.lastProgressAt = Date.now();
    task.lastProgressText = "任务已按要求取消。";
    task.cancelledBy = actorId;
    task.cancelledAt = new Date().toISOString();
    this.controllers.get(task.id)?.abort();
    this.queue = this.queue.filter((id) => id !== task.id);
    this.persist(task);
    this.event(task, "cancelled", { cancelledBy: actorId });
    return { ok: true, task };
  }

  addContext(taskId, text, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    const actorId = String(actor.userId || "");
    const allowed = actorId === String(task.userId) || this.config().ownerUserIds.includes(actorId);
    if (!allowed) return { ok: false, reason: "只有任务发起人或主人可以补充任务。" };
    if (delegated(task)) {
      const permission = this.delegationActorPermission(task, actor, "context");
      if (!permission.ok) return permission;
      if (["completed", "cancelled"].includes(task.socialDelegation.status)) return { ok: false, code: "DELEGATION_TERMINAL" };
    }
    const value = String(text || "").trim().slice(0, 4000);
    if (!value) return { ok: false, reason: "补充内容不能为空。" };
    task.supplements = [...asArray(task.supplements), { text: value, userId: actorId, at: new Date().toISOString() }].slice(-30);
    if (delegated(task)) task.socialDelegation = { ...task.socialDelegation,
      revision: nextCounter(task.socialDelegation.revision), controlRevision: nextCounter(task.socialDelegation.controlRevision),
      supplementCount: nextCounter(task.socialDelegation.supplementCount), supplements: task.supplements.map(row => sanitizeArchiveValue(row.text)),
      updatedAt: this.clock(), code: "DELEGATION_CONTEXT_UPDATED" };
    task.lastProgressAt = Date.now();
    task.lastProgressText = this.running.has(task.id) ? "已收到补充要求，将并入当前任务。" : "已收到补充要求，等待任务继续。";
    this.persist(task);
    this.event(task, "supplement", { userId: actorId, text: value });
    return { ok: true, task, queuedForNextPass: this.running.has(task.id) };
  }

  artifacts(taskId) {
    const task = this.get(taskId);
    if (!task) return [];
    try {
      // Canonicalize the host-owned base (macOS /var can be a system alias),
      // but reject links in every task-owned path component below that base.
      const base = fs.realpathSync(this.config().workspaceBaseDir);
      const outputDir = path.join(base, safeId(task.id), "outputs");
      canonicalNoFollowPath(outputDir);
      return fs.readdirSync(outputDir).map((name) => {
        try {
          const filePath = path.join(outputDir, name);
          const checked = canonicalNoFollowPath(filePath);
          const stat = fs.lstatSync(filePath);
          return !checked.directory && stat.isFile() && containsPath(outputDir, checked.path)
            ? { id: createHash("sha256").update(name, "utf8").digest("hex"), name, size: stat.size, updatedAt: stat.mtime.toISOString(), filePath: checked.path } : null;
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  deliveryArtifacts(task) {
    const all = this.artifacts(task.id);
    const names = new Set(asArray(task.deliveryArtifactNames).map(String));
    return names.size ? all.filter((item) => names.has(item.name)) : all;
  }

  artifactPath(taskId, artifactId) {
    if (typeof artifactId !== "string" || !artifactId || artifactId === "." || artifactId === ".." || /[/\\\0]/.test(artifactId)) return "";
    const artifacts = this.artifacts(taskId);
    // Names and IDs are exact, case-sensitive namespaces. Never sanitize the
    // requested string: an absent Chinese/punctuated filename must not resolve
    // to another artifact just because both collapse to the same legacy ID.
    let artifact = artifacts.find(item => item.name === artifactId)
      || artifacts.find(item => item.id === artifactId);
    if (!artifact) {
      const legacy = artifacts.filter(item => safeId(item.name) === artifactId);
      if (legacy.length === 1) [artifact] = legacy;
    }
    try {
      if (!artifact || !containsPath(fs.realpathSync(this.outputsDir(taskId)), artifact.filePath)
        || canonicalNoFollowPath(artifact.filePath).directory) return "";
      return artifact.filePath;
    } catch { return ""; }
  }

  async pump() {
    const cfg = this.config();
    if (!cfg.enabled) return;
    // Scan each queued item once so a busy logical lane cannot block a peer lane.
    let remaining = this.queue.length;
    while (this.running.size < cfg.maxConcurrentGlobal && this.queue.length && remaining-- > 0) {
      const id = this.queue.shift();
      const task = this.get(id);
      if (!task || task.status !== "queued" || !assignedOwner(task)) continue;
      const sameConversation = Array.from(this.running).map((runningId) => this.get(runningId))
        .filter((running) => running?.conversationId === task.conversationId && taskOwnedBy(running, task.logicalBotId)).length;
      if (sameConversation >= cfg.maxConcurrentPerConversation) {
        this.queue.push(id);
        continue;
      }
      this.run(task).catch((err) => this.warn(`task runtime failed id=${task.id}: ${err.message}`));
    }
  }

  async notifySafely(task, notice) {
    try {
      return await this.notify(task, notice);
    } catch {
      // Delivery is best-effort; a QQ outage must not fail a confirmed task.
      try { this.warn(`task notice failed id=${task.id} type=${notice.type}`); } catch { /* logging is best-effort too */ }
      try { this.event(task, "notice_failed", { noticeType: notice.type }); } catch { /* preserve task execution */ }
      return false;
    }
  }

  async finishDelegation(task, result) {
    let goal = task.socialDelegation;
    // The latest durable goal/control wins over a returned (possibly stale)
    // executor result. No MAX-pass path may mark unseen goal input complete.
    const staleComplete = goal.status === "completed" && (result?.delegationStatus !== "completed"
      || result.delegationRevision !== goal.revision || result.delegationControlRevision !== goal.controlRevision
      || result.delegationSupplementCount !== (goal.supplementCount || 0));
    const pendingEffect = unresolvedTask(task);
    if ((pendingEffect && !["paused", "cancelled", "accepted", "uncertain"].includes(goal.status))
      || ["running", "ready"].includes(goal.status) || staleComplete || !Object.hasOwn(delegationStages, goal.status)) {
      goal = { ...goal, status: pendingEffect ? "uncertain" : "interrupted", revision: nextCounter(goal.revision),
        code: "DELEGATION_REEVALUATION_REQUIRED", updatedAt: this.clock() };
      task.socialDelegation = goal;
    }
    projectDelegation(task, goal.status);
    task.lastProgressAt = this.clock();
    task.resultSummary = task.socialOwnerPrivate ? "主人持续委托已更新。" : String(goal.summary || goal.code || "").slice(0, 4000);
    task.deliveryArtifactNames = goal.status === "completed" ? asArray(result?.artifacts).map(x => String(x?.name || "")).filter(Boolean) : [];
    this.persist(task);
    this.event(task, task.status, { delegation: true, code: goal.code, controlRevision: goal.controlRevision });
    // Parking/recovery is a UI/state change, not a new QQ send or replay timer.
    if (goal.status !== "completed" || goal.recoveryReadOnly === true) return;
    if (task.socialOwnerPrivate) {
      // The injected host MUST route this to the currently verified owner DM,
      // never task.groupId. Keep public summaries generic. Claim BEFORE calling
      // the host; even a lost ACK/throw/restart must not retry this external act.
      if (task.socialCompletionNotice) return;
      task.socialCompletionNotice = { status: "claimed", goalRevision: goal.revision, at: this.clock() };
      this.persist(task);
      const accepted = await this.notifySafely(task, { type: "completed", audience: "owner_private",
        text: `委托 ${task.id} 已完成。`, artifacts: [] });
      task.socialCompletionNotice = { ...task.socialCompletionNotice,
        status: accepted === true ? "accepted" : "uncertain", settledAt: this.clock() };
      this.persist(task);
      return;
    }
    await this.notifySafely(task, { type: "completed",
      text: `任务 ${task.id} 已完成。${task.resultSummary ? `\n${task.resultSummary}` : ""}`,
      artifacts: task.deliveryArtifactNames.length ? this.deliveryArtifacts(task) : [] });
  }

  async run(task) {
    if (!assignedOwner(task) || this.running.has(task.id) || !this.config().enabled) return;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.running.add(task.id);
    let heartbeat;
    try {
      if (task.authorityBlocked) throw new CapabilityError("TASK_DURABILITY_UNKNOWN");
      if (unresolvedTask(task)) {
        if (delegated(task)) { await this.finishDelegation(task, {}); return; }
        throw new CapabilityError("UNRESOLVED_SIDE_EFFECT");
      }
      task.attempt = nextCounter(task.attempt);
      task.attemptId = `attempt_${randomBytes(12).toString("hex")}`;
      task.status = "planning";
      task.currentStage = "制定执行计划";
      task.lastProgressAt = Date.now();
      task.lastProgressText = "正在整理目标、工具和权限边界。";
      task.startedAt ||= new Date().toISOString();
      this.persist(task);
      this.event(task, "started", { permissionTier: task.permissionTier, complexity: task.complexity, reasoningEffort: task.reasoningEffort });
      if (!task.suppressStartNotice) await this.notifySafely(task, { type: "started", text: `收到，任务 ${task.id} 开始执行。` });
      if (controller.signal.aborted || task.status === "cancelled") return;
      heartbeat = setInterval(() => {
        if (!this.running.has(task.id) || controller.signal.aborted) return;
        try {
          task.lastProgressAt = Date.now();
          task.lastProgressText = `仍在执行：${task.currentStage || task.status}`;
          this.persist(task);
          if (!delegated(task) || task.socialDelegation.recoveryReadOnly !== true && !task.socialOwnerPrivate)
            this.notifySafely(task, { type: "heartbeat", text: `任务 ${task.id} 还在执行，当前阶段：${task.status}。` });
        } catch { controller.abort(); }
      }, this.config().progressHeartbeatMs);
      task.status = "running";
      task.currentStage = "执行任务";
      task.lastProgressAt = Date.now();
      task.lastProgressText = "正在调用获准的工具并整理结果。";
      this.persist(task);
      let result;
      let passes = 0;
      do {
        const supplementCount = asArray(task.supplements).length;
        task.executionSupplementCount = supplementCount;
        this.persist(task);
        result = await this.execute(task, { signal: controller.signal, outputsDir: this.outputsDir(task.id), config: this.config() });
        if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean"
          || result.waitingPermission !== undefined && typeof result.waitingPermission !== "boolean"
          || result.waitingPermission === true && result.ok !== false) {
          task.resultSummary = String(typeof result === "string" ? result : result?.summary || "").slice(0, 4000);
          throw new CapabilityError("TASK_RESULT_INVALID");
        }
        passes += 1;
        // Delegation owns its multi-step loop and control revisions. It is NOT
        // a legacy supplement pass; never re-enter it via the fixed two passes.
        if (delegated(task) || asArray(task.supplements).length <= supplementCount || result?.waitingPermission || result?.ok === false || passes >= 2 || hasUnresolvedSideEffects(task)) break;
        task.previousResultSummary = String(result?.summary || "").slice(0, 3000);
        task.currentStage = "合并补充要求";
        task.lastProgressAt = Date.now();
        task.lastProgressText = "收到执行期间的新补充，正在合并到下一阶段。";
        this.persist(task);
        this.event(task, "supplement_pass_started", { pass: passes + 1, supplementCount: asArray(task.supplements).length });
        await this.notifySafely(task, { type: "progress", text: `任务 ${task.id} 收到新补充，正在合并到下一阶段。` });
      } while (!controller.signal.aborted);
      if (task.status === "cancelled") return;
      if (controller.signal.aborted) {
        if (delegated(task)) await this.finishDelegation(task, result);
        return;
      }
      if (delegated(task)) { await this.finishDelegation(task, result); return; }
      if (result.ok && hasUnresolvedSideEffects(task)) throw new CapabilityError("UNRESOLVED_SIDE_EFFECT");
      task.status = result?.waitingPermission ? "waiting_permission" : result?.ok === false ? "failed" : "completed";
      task.currentStage = task.status === "waiting_permission" ? "等待授权" : task.status === "completed" ? "已完成" : "执行失败";
      task.lastProgressAt = Date.now();
      task.resultSummary = String(result?.summary || "").slice(0, 4000);
      task.deliveryArtifactNames = asArray(result?.artifacts).map((item) => String(item?.name || "")).filter(Boolean);
      task.lastProgressText = task.status === "completed" ? "任务已完成并整理产物。" : task.status === "waiting_permission" ? "缺少继续执行所需的明确授权。" : "任务执行失败。";
      task.lastError = String(result?.error || "").slice(0, 1200);
      if (result?.review) task.review = result.review;
      task.completedAt = ["completed", "failed"].includes(task.status) ? new Date().toISOString() : "";
      this.persist(task);
      this.event(task, task.status, { summary: task.resultSummary, error: task.lastError });
      await this.notifySafely(task, {
        type: task.status,
        text: task.status === "completed"
          ? `任务 ${task.id} 已完成。${task.resultSummary ? `\n${task.resultSummary}` : ""}`
          : task.status === "waiting_permission"
            ? `任务 ${task.id} 正在等待主人授权。${task.resultSummary ? `\n${task.resultSummary}` : ""}`
            : `任务 ${task.id} 执行失败：${task.lastError || "未知错误"}`,
        artifacts: task.status === "completed" ? this.deliveryArtifacts(task) : []
      });
    } catch (err) {
      if (task.status === "cancelled") return;
      if (controller.signal.aborted && !delegated(task)) return;
      if (delegated(task)) {
        if (["TASK_DURABILITY_UNKNOWN", "DELEGATION_DURABILITY_UNKNOWN"].includes(err?.code)) {
          task.authorityBlocked = true;
          throw err; // No compensating write after an uncertain publication.
        }
        await this.finishDelegation(task, { ok: false });
        return;
      }
      task.status = "failed";
      task.currentStage = "执行失败";
      task.lastProgressAt = Date.now();
      task.lastProgressText = "执行时出现错误，详情已记录。";
      task.lastError = String(err?.message || err).slice(0, 1200);
      task.completedAt = new Date().toISOString();
      this.persist(task);
      this.event(task, "failed", { error: task.lastError });
      await this.notifySafely(task, { type: "failed", text: `任务 ${task.id} 执行失败：${task.lastError}` });
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(task.id);
      this.running.delete(task.id);
      queueMicrotask(() => this.pump());
    }
  }
}

export function publicTask(task) {
  if (!task) return null;
  const copy = JSON.parse(JSON.stringify(task));
  copy.logicalBotId = typeof task.logicalBotId === "string" ? task.logicalBotId : "";
  copy.revision = Number.isSafeInteger(task.revision) ? task.revision : 0;
  copy.grantRevision = Number.isSafeInteger(task.grantRevision) ? task.grantRevision : 0;
  copy.attempt = Number.isSafeInteger(task.attempt) ? task.attempt : 0;
  copy.attemptId = typeof task.attemptId === "string" ? task.attemptId : "";
  copy.grants = asArray(copy.grants).map(publicGrant);
  if (copy.socialOwnerPrivate && copy.socialDelegation) {
    delete copy.socialDelegation.objective;
    delete copy.socialDelegation.supplements;
    delete copy.socialDelegation.summary;
    copy.socialDelegation.steps = asArray(copy.socialDelegation.steps).map(({ observation, ...receipt }) => receipt);
    copy.supplements = [];
    copy.resultSummary = "主人持续委托已更新。";
  }
  return sanitizeTaskView(copy);
}

// Read-only output filtering, NOT a grant/identity transformation or a complete
// secret detector. Keep host IDs stable for projections and API addressing;
// sanitize all free-form model/user text and obvious credential-bearing fields.
const TASK_VIEW_IDS = new Set(["id", "taskId", "logicalBotId", "accountId", "conversationId", "groupId", "userId",
  "socialOwnerUserId",
  "grantedBy", "confirmedBy", "cancelledBy", "revokedBy", "operationId", "attemptId", "grantId", "externalGrantId",
  "backendId", "operationDigest", "targetDigest"]);
function sanitizeTaskView(value, key = "") {
  if (/password|passkey|secret|token|cookie|authorization|api.?key|credential|private.?key/i.test(key)
    && value !== null && ["string", "object"].includes(typeof value)) return "[已过滤]";
  if (Array.isArray(value)) return value.map(item => sanitizeTaskView(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !["__proto__", "constructor", "prototype"].includes(name))
    .map(([name, item]) => [name, sanitizeTaskView(item, name)]));
  if (typeof value !== "string" || TASK_VIEW_IDS.has(key)) return value;
  // The shared filter covers sk-* keys, labeled secrets, PII and URL queries.
  // Add common unprefixed API-key/header forms to free-form summaries as well.
  return sanitizeArchiveValue(value
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[已过滤]")
    .replace(/(\b(?:api[-_ ]?key|authorization|set-cookie|cookie)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,;"']+/gi, "$1[已过滤]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已过滤]"));
}

function publicGrant(grant) {
  const copy = Object.fromEntries(["id", "version", "taskId", "logicalBotId", "accountId", "type", "capability", "grantRevision",
    "grantedBy", "grantedAt", "expiresAt", "revokedAt", "revokedBy"].filter(key => grant[key] !== undefined).map(key => [key, grant[key]]));
  if (grant.humanActor) copy.humanActor = { userId: grant.humanActor.userId, source: grant.humanActor.source };
  if (["read", "write", "local_read", "local_write", "isolated_files", "code"].includes(grant.type || grant.capability)) {
    copy.target = path.basename(grant.target || grant.scope?.path || grant.scope?.target || "") || "已授权路径";
  } else if (grant.target) copy.target = "已脱敏目标";
  if (grant.scope) copy.scope = { actions: asArray(grant.scope.actions).filter(item => typeof item === "string" && /^[a-z_]+$/.test(item)), redacted: true };
  if (grant.purpose) copy.purpose = "已脱敏用途";
  return copy;
}

function immutableSnapshot(task) {
  const freeze = value => {
    if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
  };
  return freeze(publicTask(task));
}
