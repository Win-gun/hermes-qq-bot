import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function safeId(value, fallback = "task") {
  const clean = String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
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

export class TaskRuntime {
  constructor({ rootDir, config, execute, notify, log = () => {}, warn = () => {} }) {
    this.rootDir = rootDir;
    this.getConfig = typeof config === "function" ? config : () => config || {};
    this.execute = execute;
    this.notify = notify;
    this.log = log;
    this.warn = warn;
    this.tasks = new Map();
    this.running = new Set();
    this.queue = [];
    this.controllers = new Map();
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

  load() {
    const baseDir = this.config().workspaceBaseDir;
    fs.mkdirSync(baseDir, { recursive: true });
    for (const name of fs.readdirSync(baseDir)) {
      const filePath = path.join(baseDir, name, "task.json");
      if (!fs.existsSync(filePath)) continue;
      const task = readJson(filePath);
      if (!task?.id) continue;
      if (["running", "planning", "reviewing", "delivering"].includes(task.status)) {
        task.status = "interrupted";
        task.interruptedAt = new Date().toISOString();
        task.lastError = "bridge restarted while task was active";
        writeJsonAtomic(filePath, task);
        appendJsonl(path.join(baseDir, name, "events.jsonl"), { at: task.interruptedAt, type: "interrupted", reason: task.lastError });
      }
      this.tasks.set(task.id, task);
    }
  }

  createOffer(input) {
    const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const task = {
      id,
      status: "offered",
      conversationId: String(input.conversationId || ""),
      messageType: input.messageType || "group",
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
    fs.mkdirSync(this.outputsDir(id), { recursive: true });
    this.tasks.set(id, task);
    this.persist(task);
    this.event(task, "offered", { summary: task.summary, requestedTools: task.requestedTools, complexity: task.complexity, reasoningEffort: task.reasoningEffort });
    return task;
  }

  persist(task) {
    task.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.taskPath(task.id), task);
    this.tasks.set(task.id, task);
  }

  event(task, type, detail = {}) {
    appendJsonl(this.eventsPath(task.id), { at: new Date().toISOString(), type, ...detail });
  }

  activeForConversation(conversationId) {
    return Array.from(this.tasks.values()).find((task) => task.conversationId === String(conversationId) && ["offered", "queued", "planning", "running", "waiting_permission", "reviewing", "delivering", "interrupted"].includes(task.status));
  }

  get(taskId) {
    return this.tasks.get(String(taskId || "")) || null;
  }

  list({ conversationId = "", limit = 100 } = {}) {
    return Array.from(this.tasks.values())
      .filter((task) => !conversationId || task.conversationId === String(conversationId))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, Math.max(1, Number(limit || 100)));
  }

  canConfirm(task, actor = {}) {
    const cfg = this.config();
    const actorId = String(actor.userId || "");
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

  confirm(taskId, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    if (!["offered", "interrupted", "failed"].includes(task.status)) return { ok: false, task, reason: `任务当前状态是 ${task.status}。` };
    const permission = this.canConfirm(task, actor);
    if (!permission.ok) return { ok: false, task, reason: permission.reason };
    task.confirmedBy = String(actor.userId || "");
    task.confirmedAt = new Date().toISOString();
    task.status = "queued";
    task.currentStage = "排队准备";
    task.lastProgressAt = Date.now();
    task.lastProgressText = "已确认，正在进入执行队列。";
    task.suppressStartNotice = actor.source === "qq";
    task.permissionTier = permission.owner ? "owner" : "isolated";
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
    const type = String(grant?.type || "").toLowerCase();
    if (!["read", "write", "computer", "authenticated_browser"].includes(type)) return { ok: false, reason: "未知授权类型。" };
    let target = String(grant?.target || grant?.path || "").trim();
    if (["read", "write"].includes(type)) {
      if (!target || target.includes("\0")) return { ok: false, reason: "需要提供有效路径。" };
      target = path.resolve(target);
    }
    const item = { type, target, purpose: String(grant?.purpose || "").slice(0, 300), grantedBy: String(actor.userId), grantedAt: new Date().toISOString() };
    task.grants = [...asArray(task.grants).filter((existing) => !(existing.type === type && existing.target === target)), item];
    if (task.status === "waiting_permission") {
      task.status = "queued";
      task.currentStage = "授权完成，重新排队";
    }
    task.lastProgressAt = Date.now();
    task.lastProgressText = `已收到 ${type} 授权${target ? `：${path.basename(target)}` : ""}。`;
    this.persist(task);
    this.event(task, "permission_granted", item);
    if (task.status === "queued" && !this.queue.includes(task.id)) this.queue.push(task.id);
    queueMicrotask(() => this.pump());
    return { ok: true, task, grant: item };
  }

  cancel(taskId, actor = {}) {
    const task = this.get(taskId);
    if (!task) return { ok: false, reason: "任务不存在。" };
    const actorId = String(actor.userId || "");
    const allowed = actorId === String(task.userId) || this.config().ownerUserIds.includes(actorId);
    if (!allowed) return { ok: false, reason: "只有任务发起人或主人可以取消。" };
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
    const value = String(text || "").trim().slice(0, 4000);
    if (!value) return { ok: false, reason: "补充内容不能为空。" };
    task.supplements = [...asArray(task.supplements), { text: value, userId: actorId, at: new Date().toISOString() }].slice(-30);
    task.lastProgressAt = Date.now();
    task.lastProgressText = this.running.has(task.id) ? "已收到补充要求，将并入当前任务。" : "已收到补充要求，等待任务继续。";
    this.persist(task);
    this.event(task, "supplement", { userId: actorId, text: value });
    return { ok: true, task, queuedForNextPass: this.running.has(task.id) };
  }

  artifacts(taskId) {
    const task = this.get(taskId);
    if (!task) return [];
    const outputDir = this.outputsDir(task.id);
    if (!fs.existsSync(outputDir)) return [];
    return fs.readdirSync(outputDir).map((name) => {
      const filePath = path.join(outputDir, name);
      const stat = fs.statSync(filePath);
      return stat.isFile() ? { id: safeId(name), name, size: stat.size, updatedAt: stat.mtime.toISOString(), filePath } : null;
    }).filter(Boolean);
  }

  deliveryArtifacts(task) {
    const all = this.artifacts(task.id);
    const names = new Set(asArray(task.deliveryArtifactNames).map(String));
    return names.size ? all.filter((item) => names.has(item.name)) : all;
  }

  artifactPath(taskId, artifactId) {
    const artifact = this.artifacts(taskId).find((item) => item.id === safeId(artifactId) || item.name === artifactId);
    if (!artifact || !containsPath(this.outputsDir(taskId), artifact.filePath)) return "";
    return artifact.filePath;
  }

  async pump() {
    const cfg = this.config();
    while (this.running.size < cfg.maxConcurrentGlobal && this.queue.length) {
      const id = this.queue.shift();
      const task = this.get(id);
      if (!task || task.status !== "queued") continue;
      const sameConversation = Array.from(this.running).map((runningId) => this.get(runningId)).filter((running) => running?.conversationId === task.conversationId).length;
      if (sameConversation >= cfg.maxConcurrentPerConversation) {
        this.queue.push(id);
        break;
      }
      this.run(task).catch((err) => this.warn(`task runtime failed id=${task.id}: ${err.message}`));
    }
  }

  async run(task) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.running.add(task.id);
    task.status = "planning";
    task.currentStage = "制定执行计划";
    task.lastProgressAt = Date.now();
    task.lastProgressText = "正在整理目标、工具和权限边界。";
    task.startedAt ||= new Date().toISOString();
    this.persist(task);
    this.event(task, "started", { permissionTier: task.permissionTier, complexity: task.complexity, reasoningEffort: task.reasoningEffort });
    if (!task.suppressStartNotice) await this.notify(task, { type: "started", text: `收到，任务 ${task.id} 开始执行。` });
    const heartbeat = setInterval(() => {
      if (!this.running.has(task.id)) return;
      task.lastProgressAt = Date.now();
      task.lastProgressText = `仍在执行：${task.currentStage || task.status}`;
      this.persist(task);
      this.notify(task, { type: "heartbeat", text: `任务 ${task.id} 还在执行，当前阶段：${task.status}。` }).catch(() => {});
    }, this.config().progressHeartbeatMs);
    try {
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
        passes += 1;
        if (asArray(task.supplements).length <= supplementCount || result?.waitingPermission || result?.ok === false || passes >= 2) break;
        task.previousResultSummary = String(result?.summary || "").slice(0, 3000);
        task.currentStage = "合并补充要求";
        task.lastProgressAt = Date.now();
        task.lastProgressText = "收到执行期间的新补充，正在合并到下一阶段。";
        this.persist(task);
        this.event(task, "supplement_pass_started", { pass: passes + 1, supplementCount: asArray(task.supplements).length });
        await this.notify(task, { type: "progress", text: `任务 ${task.id} 收到新补充，正在合并到下一阶段。` });
      } while (!controller.signal.aborted);
      if (task.status === "cancelled" || controller.signal.aborted) return;
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
      await this.notify(task, {
        type: task.status,
        text: task.status === "completed"
          ? `任务 ${task.id} 已完成。${task.resultSummary ? `\n${task.resultSummary}` : ""}`
          : task.status === "waiting_permission"
            ? `任务 ${task.id} 正在等待主人授权。${task.resultSummary ? `\n${task.resultSummary}` : ""}`
            : `任务 ${task.id} 执行失败：${task.lastError || "未知错误"}`,
        artifacts: this.deliveryArtifacts(task)
      });
    } catch (err) {
      if (controller.signal.aborted || task.status === "cancelled") return;
      task.status = "failed";
      task.currentStage = "执行失败";
      task.lastProgressAt = Date.now();
      task.lastProgressText = "执行时出现错误，详情已记录。";
      task.lastError = String(err?.message || err).slice(0, 1200);
      task.completedAt = new Date().toISOString();
      this.persist(task);
      this.event(task, "failed", { error: task.lastError });
      await this.notify(task, { type: "failed", text: `任务 ${task.id} 执行失败：${task.lastError}` });
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
  for (const grant of asArray(copy.grants)) {
    if (["read", "write"].includes(grant.type)) grant.target = path.basename(grant.target || "") || "已授权路径";
  }
  return copy;
}
