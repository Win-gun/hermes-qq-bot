// Isolated beta.6 console fixture. Only config.example.json and the three fixed
// public assets are read. No application imports, state IO, subprocesses, outbound
// services, credentials, model calls or QQ sends. Every change dies on exit.
// Start: node scripts/console-preview-server.js (default loopback port 6328).
// App attachment: give BOTH processes the same disposable HERMES_QQ_HOME;
// give the App HERMES_QQ_CONTROL_PORT=6328. This script never launches the App.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureVersion = "api-shape-v2";
const copy = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const forbidden = /^(?:__proto__|prototype|constructor)$/;
const secret = /^(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|cookie|authorization|env)$/i;

function scrub(value, key = "", example = true) {
  if (example && /^(?:ownerUserIds|adminUserIds|recipients|targetUsers)$/.test(key)) return ["10001"];
  if (Array.isArray(value)) return value.map((item) => scrub(item, "", example));
  if (object(value)) return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !forbidden.test(name) && !secret.test(name))
    .map(([name, item]) => [name, scrub(item, name, example)]));
  // Example prompts can contain an owner's QQ number; do not carry it into QA.
  if (example && typeof value === "string") return value.replace(/\b\d{5,20}\b/g, "10001").replace(/\/Users\/[^\s"']+/g, "/preview");
  return value;
}

function merge(target, patch) {
  const result = copy(target);
  for (const [key, value] of Object.entries(patch)) {
    if (forbidden.test(key) || secret.test(key) || ["revision", "expectedRevision", "readonly"].includes(key)) continue;
    result[key] = object(value) && object(result[key]) ? merge(result[key], value) : scrub(value, "", false);
  }
  return result;
}

function readResource(relative) {
  const file = path.join(root, relative);
  assert.ok(fs.lstatSync(file).isFile(), `preview requires regular source asset: ${relative}`);
  return fs.readFileSync(file);
}

function previewCenterShape(input) {
  const invalid = () => { throw Object.assign(new Error("invalid_preview_api_center"), { status: 400 }); };
  if (!object(input) || ![input.connections, input.profiles, input.searchProfiles].every((items) => Array.isArray(items) && items.every((item) => object(item) && typeof item.id === "string" && item.id))) invalid();
  const connections = input.connections.map((item) => ({ name: item.id, provider: "custom", baseUrl: "", credentialSource: "existing", apiKeyEnv: "PREVIEW_NOT_CONFIGURED", ...item }));
  if (connections.some((item) => typeof item.provider !== "string")) invalid();
  const profiles = input.profiles.map((item) => ({ name: item.id, model: "", command: "preview-disabled", args: [], reasoningEffort: "none", timeoutMs: 60000, toolsets: "", ...item }));
  const searchProfiles = input.searchProfiles.map((item) => ({
    name: item.id, provider: "google", providerOrder: [item.provider || "google"], maxResults: 4, timeoutMs: 8000, ...item,
    // The real UI reads proxy even when the MiMo advanced panel is hidden.
    proxy: { enabled: false, autoDetect: false, directFallback: false, ...(object(item.proxy) ? item.proxy : {}), urls: Array.isArray(item.proxy?.urls) ? item.proxy.urls : [] }
  }));
  const bindings = { ...input.bindings };
  for (const kind of ["chat", "vision", "asr", "tts"]) {
    bindings[kind] ||= profiles.find((item) => item.kind === kind)?.id;
    if (!profiles.some((item) => item.id === bindings[kind] && item.kind === kind)) invalid();
  }
  bindings.task ||= "inherit-chat";
  if (bindings.task !== "inherit-chat" && !profiles.some((item) => item.id === bindings.task && item.kind === "chat")) invalid();
  const searchBinding = input.searchBinding || searchProfiles[0]?.id;
  if (!searchProfiles.some((item) => item.id === searchBinding)) invalid();
  if (profiles.some((item) => !connections.some((connection) => connection.id === item.connectionId))
    || searchProfiles.some((item) => !Array.isArray(item.providerOrder) || item.provider === "mimo-web-search" && !connections.some((connection) => connection.id === item.connectionId))) invalid();
  for (const items of [connections, profiles, searchProfiles]) if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return { version: 1, connections, profiles, bindings, searchProfiles, searchBinding };
}

export function createPreviewServer({ stateRoot = process.env.HERMES_QQ_HOME || path.join(os.tmpdir(), "hermesqq-console-preview") } = {}) {
  // stateRoot is only an attachment marker for an independently isolated App.
  // It is never opened, created, tested for existence or modified here.
  stateRoot = path.resolve(stateRoot);
  const instanceId = `console-preview-${randomUUID()}`;
  const startedAt = Date.now();
  const now = () => new Date().toISOString();
  const staticFiles = new Map([
    ["/admin", [readResource("public/admin.html"), "text/html; charset=utf-8"]],
    ["/console.css", [readResource("public/console.css"), "text/css; charset=utf-8"]],
    ["/console-theme.js", [readResource("public/console-theme.js"), "text/javascript; charset=utf-8"]]
  ]);
  staticFiles.set("/", staticFiles.get("/admin"));
  staticFiles.set("/admin/", staticFiles.get("/admin"));
  let config = scrub(JSON.parse(readResource("config.example.json").toString("utf8")));
  let version = 1;
  let centerVersion = 1;
  let running = true;
  let autoStart = false;
  let backupProgress = { status: "idle" };
  const revision = () => `preview-${version}`;
  const centerRevision = () => `preview-api-${centerVersion}`;
  const account = (id, qq, displayName) => ({
    id, qq, displayName, protocol: "snowluma", enabled: true, protocolEnabled: true, managed: true, archived: false,
    protocolContainer: `preview-${id}`, napcatContainer: `preview-${id}`, onebotPath: `/onebot/${id}`, onebotWsUrl: "", webuiPort: 0,
    features: { chat: true, task: true, proactive: false, automation: true, webSearch: true, vision: true, asr: true, learning: false },
    sendTypes: { text: true, image: true, record: true, video: false, file: true },
    scope: { groups: true, private: true, groupMode: "allowlist", groupIds: ["20001", "20002"] },
    modelBindings: { chat: "", task: "", vision: "", asr: "", tts: "", search: "" },
    voice: { mode: "inherit", preset: "mimo_default" }, styleProfileId: "legacy", promptOverride: "", behaviorMode: "balanced"
  });
  config.accounts = { version: 2, topology: "collaboration", items: [
    account("primary", "10001", "预览 · 小跟班"), account("standby-a", "10002", "预览 · 小跟班 2")
  ], failoverGroups: [], failover: { enabled: false }, diagnostics: { enabled: false } };
  config.privateChats = { enabled: true, targetUsers: ["10001", "10002"], ownerUserIds: ["10001"], ownerSystem: "虚构 QA 主人，无真实权限。" };
  config.targetGroups = ["20001", "20002"];
  config.commands = { enabled: true, adminUserIds: ["10001"] };
  config.taskMode = { ...config.taskMode, enabled: true, shadowMode: true, ownerUserIds: ["10001"], workspaceBaseDir: "/preview/tasks" };
  config.chatArchive = { ...config.chatArchive, enabled: true, baseDir: "/preview/chat-archive" };
  config.adminNotifications = { ...config.adminNotifications, enabled: false, recipients: ["10001"] };
  config.loginRecovery = { enabled: false };
  config.hourlyChat = { enabled: false, ownerUserIds: ["10001"] };
  config.ai = { ...config.ai, command: "preview-disabled", args: [], provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "", apiKeyEnv: "PREVIEW_NOT_CONFIGURED" };
  config.vision = { ...config.vision, provider: "xiaomi", model: "mimo-v2.5" };
  config.voice = { ...config.voice, enabled: true, credentialSource: "existing", apiKeyEnv: "PREVIEW_NOT_CONFIGURED", apiKeyEnvPresent: false, keychainStored: false };
  config.automation = { enabled: true, rules: [
    { id: "preview-morning", enabled: true, accountId: "primary", scope: { conversationIds: ["group:20001"] }, timezone: "Asia/Shanghai", trigger: { type: "schedule", time: "09:00", daysOfWeek: [1, 2, 3, 4, 5], windowMinutes: 3 }, action: { kind: "message" }, prompt: "演示早间提醒；不会实际执行或发送。" },
    { id: "preview-summary", enabled: false, accountId: "standby-a", scope: { conversationIds: ["group:20002"] }, timezone: "Asia/Shanghai", trigger: { type: "command", text: "/preview-summary" }, action: { kind: "summary" }, prompt: "仅预览讨论摘要。" }
  ] };
  const syncLegacy = () => {
    config.accounts.primary = copy(config.accounts.items.find((item) => item.id === "primary") || config.accounts.items[0] || {});
    config.accounts.standbys = copy(config.accounts.items.filter((item) => item.id !== config.accounts.primary.id));
  };
  syncLegacy();

  let center = previewCenterShape({ version: 1, connections: [
    { id: "preview-chat", name: "DeepSeek · 演示连接", provider: "deepseek", baseUrl: "", credentialSource: "existing", apiKeyEnv: "PREVIEW_NOT_CONFIGURED" },
    { id: "preview-mimo", name: "MiMo · 演示连接", provider: "xiaomi", baseUrl: "", credentialSource: "existing", apiKeyEnv: "PREVIEW_NOT_CONFIGURED" }
  ], profiles: [
    { id: "preview-chat", name: "日常问答", kind: "chat", connectionId: "preview-chat", model: "deepseek-v4-flash", command: "preview-disabled", args: [], reasoningEffort: "medium", timeoutMs: 60000 },
    { id: "preview-vision", name: "图像理解", kind: "vision", connectionId: "preview-mimo", model: "mimo-v2.5", toolsets: "vision" },
    { id: "preview-asr", name: "语音识别", kind: "asr", connectionId: "preview-mimo", model: "mimo-v2.5-asr" },
    { id: "preview-tts", name: "自然语音", kind: "tts", connectionId: "preview-mimo", model: "mimo-v2.5-tts" }
  ], bindings: { chat: "preview-chat", task: "preview-chat", vision: "preview-vision", asr: "preview-asr", tts: "preview-tts" },
  searchProfiles: [
    { id: "preview-search", name: "MiMo · 演示联网检索", provider: "mimo-web-search", providerOrder: ["mimo-web-search"], connectionId: "preview-mimo", model: "mimo-v2.5", timeoutMs: 30000, maxResults: 4, maxKeyword: 2, forceSearch: true },
    { id: "preview-google", name: "Google · 演示来源", provider: "google", providerOrder: ["google", "baidu"] },
    { id: "preview-baidu", name: "百度 · 演示回退来源", provider: "baidu", providerOrder: ["baidu"] }
  ], searchBinding: "preview-search" });
  const tasks = [
    { id: "preview-task-001", status: "completed", summary: "整理本周产品讨论", objective: "汇总讨论并生成 Markdown 清单（虚构任务）。", conversationId: "group:20001", userId: "10001", senderName: "演示成员 A", complexity: "standard", reasoningEffort: "medium", updatedAt: now(), artifacts: [{ id: "preview-note", name: "讨论摘要.md", size: 128 }] },
    { id: "preview-task-002", status: "waiting_permission", summary: "检查设计稿说明", objective: "等待一次性授权；预览不会读取本地文件。", conversationId: "private:10002", userId: "10002", senderName: "演示成员 B", complexity: "standard", reasoningEffort: "medium", updatedAt: now(), artifacts: [] },
    { id: "preview-task-003", status: "interrupted", summary: "比较两个交互方案", objective: "演示中断后的恢复入口，不运行模型。", conversationId: "group:20002", userId: "10001", senderName: "演示成员 A", updatedAt: now(), artifacts: [] }
  ];
  const groups = ["20001", "20002"].map((groupId, index) => ({ groupId, users: 2, profiledUsers: 2, facts: 2, topics: 3, summaries: 1, botSelfUpdatedAt: now(), rollingSummary: index ? "正在比较深色主题的对比度与排版。" : "讨论本周开发计划与界面验收。", settings: {} }));
  let conversations = groups.map(({ groupId }, index) => ({ conversationId: `group:${groupId}`, kind: "group", messageCount: 28 + index * 12, bytes: 8192 + index * 4096, mtimeMs: startedAt, path: `/preview/chat-archive/groups/${groupId}/messages.jsonl` }));
  const backups = [{ name: "preview-safe-backup.hermesqqbackup", size: 32768, modifiedAt: now() }, { name: "preview-full-backup.hermesqqbackup", size: 131072, modifiedAt: now() }];
  const operations = new Map();
  const statuses = () => config.accounts.items.filter((item) => !item.archived).map((item) => ({
    ...copy(item), role: item.id === "primary" ? "primary" : "standby", accountId: item.id,
    connected: running && item.protocolEnabled !== false, healthy: running && item.enabled !== false,
    routeState: !running || item.protocolEnabled === false ? "DISCONNECTED" : item.enabled === false ? "PAUSED" : "HEALTHY",
    statusLevel: "good", statusText: "模拟在线", statusReason: "仅演示数据，无真实 QQ 连接", needsLogin: false, strongBad: false,
    lastFrameAt: Date.now() - 1000, lastMessageAt: Date.now() - 15000, qrcode: { exists: false },
    qqLogin: { status: "online", needsLogin: false },
    capabilities: Object.fromEntries(["identity", "onebot", "api", "groupSend", "groupReceive", "privateSend", "privateReceive"].map((key) => [key, { status: "ok", reason: "虚构 QA 证据", simulated: true }]))
  }));
  const registry = () => ({ ok: true, preview: true, revision: revision(), items: copy(config.accounts.items), failoverGroups: copy(config.accounts.failoverGroups), statuses: statuses() });
  const configView = () => ({ ...copy(config), preview: true, revision: revision(), readonly: { listen: { host: "127.0.0.1", port: 0, path: "/preview-no-onebot" }, control: { host: "127.0.0.1", port: server.address()?.port }, configPath: "/preview/config.json" } });
  const centerView = () => ({ ok: true, preview: true, center: copy(center), revision: centerRevision(), credentialStatus: Object.fromEntries(center.connections.map((item) => [item.id, "missing"])) });
  const health = () => ({
    ok: running, preview: true, simulated: true, fixtureVersion, instanceId, generatedAt: Date.now(), onebotConnected: running, onebotStale: false,
    loginNeedsAttention: false, primaryNeedsAttention: false, accountsNeedingAttention: [], topology: config.accounts.topology,
    activeAccountId: "primary", activeAccountRole: "primary", accounts: statuses(), allGroups: false, targetGroups: config.targetGroups,
    privateChats: true, targetPrivateUsers: ["10001", "10002"], qqLogin: { status: "online", needsLogin: false }, qrcode: { exists: false },
    replyCoordinator: { activeCount: 0, pending: 0, merged: 12, regenerated: 0 },
    runtime: { startedAt, now: Date.now(), lastOneBotFrameAt: Date.now() - 1000, lastOneBotMessageAt: Date.now() - 15000, lastOneBotMessagePreview: "预览消息：检查控制台布局", oneBotMessageCount: 64, secondsSinceLastFrame: 1, secondsSinceLastMessage: 15 },
    diagnostics: { socialPlanner: { enabled: true, shadowMode: true, recent: [] }, reviewer: { enabled: false }, tasks: { running: 0, queued: 0 } }
  });
  const hostStatus = () => ({ ok: true, preview: true, simulated: true, hostKind: "hermesqq-local-host", instanceId, appVersion: "1.0.0-beta.6", platform: "darwin", arch: "arm64", running, bridgeRunning: running, bridgeHealth: health(), externalHost: true, webEdition: true, setupComplete: true, autoStart, stateRoot, logRoot: "/preview/logs", backupRoot: "/preview/backups", docker: { installed: false, running: false, error: "隔离预览未执行 Docker" }, hermes: { installed: false, error: "隔离预览未执行 Hermes" } });

  function respond(req, res, status, value, contentType = "application/json; charset=utf-8") {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(contentType.startsWith("application/json") ? JSON.stringify(value) : String(value));
    res.writeHead(status, { "content-type": contentType, "content-length": body.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-hermes-qq-preview": "true" });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  async function jsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) throw Object.assign(new Error("preview_body_too_large"), { status: 413 });
      chunks.push(chunk);
    }
    let value;
    try { value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { throw Object.assign(new Error("invalid_json"), { status: 400 }); }
    if (!object(value)) throw Object.assign(new Error("body_must_be_object"), { status: 400 });
    return scrub(value, "", false);
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => { if (!res.headersSent) respond(req, res, error.status || 500, { ok: false, preview: true, error: error.status ? error.message : "preview_fixture_error" }); else res.destroy(); });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;

  async function route(req, res) {
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const reply = (value, status = 200, type) => respond(req, res, status, value, type);
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || !hosts.includes(req.headers.host)) return reply({ ok: false, error: "loopback_only" }, 403);
    if (req.headers.origin && !hosts.map((host) => `http://${host}`).includes(req.headers.origin)) return reply({ ok: false, error: "invalid_origin" }, 403);
    const rawPath = (req.url || "").split("?")[0];
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (rawPath !== url.pathname || /%|\\|\/\/|(?:^|\/)\.\.(?:\/|$)/.test(rawPath)) return reply({ ok: false, error: "invalid_path" }, 404);
    const get = req.method === "GET" || req.method === "HEAD";
    if (get && staticFiles.has(rawPath)) { const [body, type] = staticFiles.get(rawPath); return reply(body, 200, type); }
    if (get && rawPath === "/health") return reply(health());
    if (get && rawPath === "/api/admin/session") return reply({ ok: true, token: "preview-session-not-a-credential", preview: true });
    if (get && rawPath === "/api/config") return reply(configView());
    if (get && rawPath === "/api/accounts") return reply(registry());
    if (get && rawPath === "/api/api-center") return reply(centerView());
    if (get && rawPath === "/api/status") return reply({ ok: true, preview: true, serverTime: Date.now(), health: health(), config: configView(), showQrcode: false, qrcodeExists: false, qrcode: { exists: false }, primaryProtocol: "snowluma", logs: { tail: "[PREVIEW] 两个虚构账号 · 内存草稿 · 不执行模型或 QQ 操作\n[PREVIEW] 控制台 UI QA 就绪", errorTail: "" } });
    if (get && rawPath === "/api/tasks") return reply({ ok: true, tasks, running: 0, queued: 0 });
    if (get && rawPath === "/api/reviewer/status") return reply({ ok: true, enabled: false, shadowMode: true, config: { enabled: false, shadowMode: true, runtimeDisabled: true }, metrics: { reviewed: 8, passed: 7, corrected: 1, rejected: 0, failed: 0, totalDurationMs: 2400, recent: [] } });
    if (get && rawPath === "/api/memory/integrity") return reply({ ok: true, generatedAt: Date.now(), totals: { groups: 2, users: 4, entries: 8, conflicts: 0, active: 8 } });
    if (get && rawPath === "/api/memory") {
      const group = groups.find((item) => item.groupId === url.searchParams.get("group_id"));
      return reply(group ? { ...group, summaries: ["虚构讨论摘要"], facts: ["所有内容均为虚构 UI 夹具。", "预览不会保留修改。"], topics: ["界面排版", "开发计划", "暗色主题"], users: { "10001": { name: "演示成员 A", aliases: ["小白"], personality: ["喜欢简洁界面"], preferences: ["中文说明"], profile: ["虚构画像"] }, "10002": { name: "演示成员 B", aliases: ["小蓝"], personality: ["关注细节"], style: ["简短直接"] } }, botSelf: { identity: "演示助手", updatedAt: now() } } : url.searchParams.has("group_id") ? { groupId: url.searchParams.get("group_id"), users: {}, facts: [], topics: [], summaries: [], botSelf: {} } : { groupCount: groups.length, groups });
    }
    if (get && rawPath === "/api/archive/status") return reply({ ok: true, enabled: true, exists: true, conversationCount: conversations.length, totalBytes: conversations.reduce((sum, item) => sum + item.bytes, 0), preview: true });
    if (get && rawPath === "/api/archive/conversations") return reply({ ok: true, conversations });
    if (get && rawPath === "/api/host/status") return reply(hostStatus());
    if (get && rawPath === "/api/host/backups") return reply(backups);
    if (get && rawPath === "/api/host/backup/status") return reply(backupProgress);
    if (get && rawPath === "/api/voice/credential") return reply({ ok: true, stored: false, available: false, configured: false, keychainStored: false, credentialSource: "existing", preview: true });
    const operationId = rawPath.match(/^\/api\/accounts\/operations\/([^/]+)$/)?.[1];
    if (get && operationId) return reply({ ok: true, operation: operations.get(operationId) || null, preview: true });
    const artifact = rawPath.match(/^\/api\/tasks\/([^/]+)\/artifacts(?:\/([^/]+))?$/);
    if (get && artifact) return reply(artifact[2] ? "# 演示讨论摘要\n\n所有内容均为虚构，未执行任何任务。\n" : { ok: true, artifacts: tasks.find((task) => task.id === artifact[1])?.artifacts || [] }, 200, artifact[2] ? "text/plain; charset=utf-8" : undefined);
    if (get && rawPath === "/api/archive/export") return reply(`${JSON.stringify({ preview: true, conversationId: url.searchParams.get("conversation_id"), senderId: "10001", text: "虚构聊天记录" })}\n`, 200, "application/x-ndjson; charset=utf-8");
    if (get && rawPath === "/api/memory/export") return reply({ preview: true, groups });
    // Credential dialogs must never accept or retain a real secret during QA.
    if (!get && /\/(?:credential|credentials)(?:\/|$)/.test(rawPath)) { req.resume(); return reply({ ok: false, preview: true, error: "预览不接收真实凭据，请使用虚构数据" }, 403); }
    if (get && rawPath.startsWith("/api/")) return reply({ ok: true, preview: true, empty: true, unsupported: true, items: [], tasks: [], conversations: [], artifacts: [], data: {} });
    if (get) return reply({ ok: false, preview: true, error: "not_found" }, 404);
    const knownMutation = ["/api/preview/conflict", "/api/config", "/api/api-center", "/api/archive/clear", "/api/memory/integrity/rebuild", "/api/host/autostart", "/api/host/backup", "/api/host/backup/cancel", "/send"].includes(rawPath)
      || /^\/api\/(?:accounts|account-groups)(?:\/|$)/.test(rawPath)
      || /^\/api\/tasks\/[^/]+\/(?:cancel|resume|supplement|grant)$/.test(rawPath)
      || /^\/api\/host\/(?:bridge\/(?:start|stop|restart)|backups\/[^/]+)$/.test(rawPath)
      || /^\/api\/(?:ai|voice|api-center)\/test$/.test(rawPath);
    if (rawPath.startsWith("/api/") && !knownMutation) { req.resume(); return reply({ ok: false, preview: true, simulated: true, unsupported: true, empty: true, items: [], data: {} }); }
    if (!["POST", "PATCH", "DELETE", "PUT"].includes(req.method)) return reply({ ok: false, error: "method_not_allowed" }, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { req.resume(); return reply({ ok: false, preview: true, empty: true, error: "preview_json_only" }, 415); }
    const body = await jsonBody(req);
    const simulated = { ok: true, preview: true, simulated: true, sentToQq: false, message: "仅内存模拟，未调用真实服务" };
    if (rawPath === "/api/preview/conflict" && req.method === "POST") { version += 1; return reply({ ...simulated, revision: revision() }); }
    if (rawPath === "/api/config" && req.method === "PATCH") {
      if (body.expectedRevision !== revision()) return reply({ ok: false, preview: true, revision: revision(), error: "配置已在别处更新，请保留草稿并刷新后重试" }, 409);
      const next = merge(config, body);
      if (!object(next.accounts) || !Array.isArray(next.accounts.items) || next.accounts.items.some((item) => !object(item) || typeof item.id !== "string") || !Array.isArray(next.accounts.failoverGroups)) return reply({ ok: false, error: "invalid_preview_accounts" }, 400);
      config = next; syncLegacy(); version += 1;
      return reply({ ...simulated, config: configView(), revision: revision(), restartRequired: false });
    }
    if (rawPath === "/api/api-center" && req.method === "PATCH") {
      if (body.revision !== centerRevision()) return reply({ ok: false, preview: true, revision: centerRevision(), error: "API 配置已更新，请保留草稿并刷新" }, 409);
      if (!object(body.center) || !Array.isArray(body.center.connections) || !Array.isArray(body.center.profiles)
        || [body.center.connections, body.center.profiles, body.center.searchProfiles === undefined ? [] : body.center.searchProfiles].some((items) => !Array.isArray(items) || items.some((item) => !object(item) || typeof item.id !== "string"))) return reply({ ok: false, error: "invalid_preview_api_center" }, 400);
      const next = previewCenterShape(merge(center, body.center));
      center = next; centerVersion += 1; version += 1;
      return reply({ ...simulated, ...centerView() });
    }
    const accountRoute = rawPath.match(/^\/api\/accounts(?:\/([^/]+)(?:\/(.+))?)?$/);
    const groupRoute = rawPath.match(/^\/api\/account-groups(?:\/([^/]+))?$/);
    if (accountRoute || groupRoute) {
      if (body.expectedRevision !== revision()) return reply({ ok: false, preview: true, revision: revision(), error: "账号配置已更新，请保留草稿并刷新" }, 409);
      if (groupRoute) {
        const id = groupRoute[1] || body.group?.id;
        if (!id || (req.method !== "DELETE" && (!object(body.group) || !Array.isArray(body.group.memberIds)))) return reply({ ok: false, error: "invalid_preview_group" }, 400);
        const at = config.accounts.failoverGroups.findIndex((item) => item.id === id);
        if (req.method === "DELETE") config.accounts.failoverGroups = config.accounts.failoverGroups.filter((item) => item.id !== id);
        else if (at < 0) config.accounts.failoverGroups.push(copy(body.group));
        else config.accounts.failoverGroups[at] = merge(config.accounts.failoverGroups[at], body.group);
      } else {
        const [, id, action] = accountRoute;
        const item = config.accounts.items.find((entry) => entry.id === id);
        if (!id && req.method === "POST" && object(body.account)) {
          const nextId = body.account.id || `preview-account-${config.accounts.items.length + 1}`;
          if (config.accounts.items.some((entry) => entry.id === nextId)) return reply({ ok: false, error: "duplicate_account" }, 409);
          config.accounts.items.push(merge(account(nextId, "10002", "预览 · 新账号"), body.account));
        } else if (!item) return reply({ ok: false, error: "unknown_preview_account" }, 404);
        else if (req.method === "PATCH" && object(body.patch)) Object.assign(item, merge(item, body.patch));
        else if (req.method === "DELETE") item.archived = true;
        else if (action === "pause" || action === "resume") item.enabled = action === "resume";
        else if (action === "protocol/stop") item.protocolEnabled = false;
        else if (action === "protocol/restart" || action === "provision") item.protocolEnabled = true;
        else if (!["probe", "login/reset", "qrcode/refresh", "activate"].includes(action)) return reply({ ...simulated, ok: false, unsupported: true, empty: true });
        if (action === "provision") {
          const operation = { id: randomUUID().replaceAll("-", ""), accountId: id, status: "completed", stage: "completed", message: "模拟部署完成，未启动协议", updatedAt: now() };
          operations.set(operation.id, operation); version += 1; syncLegacy();
          return reply({ ...simulated, ...registry(), operationId: operation.id, operation });
        }
      }
      version += 1; syncLegacy(); return reply({ ...simulated, ...registry(), probe: { loginInfo: { user_id: "10001", nickname: "虚构 QA 身份" } } });
    }
    const taskAction = rawPath.match(/^\/api\/tasks\/([^/]+)\/(cancel|resume|supplement|grant)$/);
    if (taskAction) {
      const task = tasks.find((item) => item.id === taskAction[1]);
      if (!task) return reply({ ok: false, error: "unknown_preview_task" }, 404);
      if (taskAction[2] === "cancel") task.status = "cancelled";
      if (["resume", "grant"].includes(taskAction[2])) task.status = "completed";
      task.updatedAt = now(); return reply({ ...simulated, task });
    }
    if (rawPath === "/api/archive/clear") { conversations = conversations.filter((item) => item.conversationId !== body.conversationId && item.conversationId !== body.conversation_id); return reply(simulated); }
    if (rawPath === "/api/memory/integrity/rebuild") return reply({ ...simulated, stdout: "预览 dry-run：2 群、4 个虚构成员，无串人风险；未读取、备份或重写任何记忆。" });
    if (/^\/api\/host\/bridge\/(start|stop|restart)$/.test(rawPath)) { running = !rawPath.endsWith("/stop"); return reply({ ...simulated, running }); }
    if (rawPath === "/api/host/autostart") { autoStart = body.enabled === true; return reply({ ...simulated, enabled: autoStart }); }
    if (rawPath === "/api/host/backup") {
      const name = `preview-${body.type === "full" ? "full" : "safe"}-${backups.length + 1}.hermesqqbackup`;
      const record = { name, size: 32768, modifiedAt: now() }; backups.unshift(record);
      backupProgress = { status: "completed", type: body.type || "safe", percent: 100, detail: "模拟完成，没有创建备份文件" };
      return reply({ ...simulated, ...record, path: `/preview/backups/${name}`, manifest: { type: body.type || "safe", preview: true, version: 1, createdAt: now(), accounts: config.accounts.items.map(({ id, qq }) => ({ id, qq })) } });
    }
    if (rawPath === "/api/host/backup/cancel") { backupProgress = { status: "cancelled", percent: 0, detail: "模拟取消" }; return reply(simulated); }
    const backupName = rawPath.match(/^\/api\/host\/backups\/([^/]+)$/)?.[1];
    if (backupName && req.method === "DELETE") { const at = backups.findIndex((item) => item.name === backupName); if (at >= 0) backups.splice(at, 1); return reply(simulated); }
    if (/^\/api\/(?:ai|voice|api-center)\/test$/.test(rawPath) || rawPath === "/send") return reply({ ...simulated, reply: "隔离 UI 预览回复；未执行模型。", output: "隔离预览", durationMs: 12 });
    if (rawPath.startsWith("/api/")) return reply({ ...simulated, ok: false, unsupported: true, empty: true, items: [], data: {} });
    return reply({ ok: false, preview: true, error: "not_found" }, 404);
  }
  return server;
}

// Contract-test the actual public/admin.html render functions without a browser,
// application imports, network tools or execution of the page's startup code.
function verifyRenderShapes(source, fixtures, check) {
  const elements = new Map();
  class Element {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} }; this._value = ""; this.textContent = "";
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set value(value) { this._value = String(value ?? ""); }
    get value() { return this._value; }
    get options() { return this.children; }
    get selectedOptions() { return this.children.filter((item) => item.value === this.value); }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ""; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { this.children.push(node); if (this.tagName === "SELECT" && this.children.length === 1) this.value = node.value; return node; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() {}
    focus() {}
    scrollIntoView() {}
  }
  const element = (id) => {
    if (!elements.has(id)) { const node = new Element(); node.id = id; }
    return elements.get(id);
  };
  const context = vm.createContext({
    structuredClone, $: element, document: { createElement: (tag) => new Element(tag) },
    cfg: fixtures.config, apiCenterDraft: copy(fixtures.center.center), apiCredentialStatus: fixtures.center.credentialStatus,
    selectedApiConnection: "", selectedApiProfile: "", selectedApiSearch: "", apiTests: {},
    taskData: fixtures.tasks, reviewerData: fixtures.reviewer, memoryIntegrityData: fixtures.integrity,
    memoryData: fixtures.memory, selectedGroupId: "20001", selectedGroupMemory: fixtures.group,
    archiveStatusData: fixtures.archiveStatus, archiveConversationData: fixtures.archive,
    statusData: fixtures.status, currentLogKind: "main", desktopApi: null, browserHostAvailable: true,
    desktopStatusData: fixtures.host, localBackups: fixtures.backups, backupProgress: null, legacyProjectPath: "",
    fmtAgo: () => "预览时间", formatBytes: (value) => `${value} B`, esc: (value) => String(value ?? "")
  });
  const names = ["apiSelectOptions", "apiCurrentConnection", "apiCurrentProfile", "apiCurrentSearch", "renderApiConnection", "renderApiProfile", "renderApiSearch", "renderApiCapabilityCards", "renderTasks", "renderReviewerAndIntegrity", "renderGroups", "renderMemoryDetail", "renderArchive", "renderBackupProgress", "renderDesktopBackup", "renderLogs", "renderSocialPlanner"];
  for (const name of names) {
    const start = source.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, `actual admin renderer exists: ${name}`);
    const remaining = source.slice(start + 1);
    const next = /\n    (?:async )?function /.exec(remaining);
    assert.ok(next, `renderer end exists: ${name}`);
    vm.runInContext(source.slice(start, start + 1 + next.index), context);
  }
  context.renderApiConnection();
  for (const profile of context.apiCenterDraft.profiles) { context.selectedApiProfile = profile.id; context.renderApiProfile(); check(element("apiProfileModel").value === profile.model); }
  for (const search of context.apiCenterDraft.searchProfiles) {
    context.selectedApiSearch = search.id; context.renderApiSearch();
    check(element("apiSearchAdvanced").children.length === 5);
    check(element("apiSearchProvider").value === search.provider);
  }
  context.renderApiCapabilityCards();
  check(element("apiCapabilityCards").children.length === 6);
  check(element("apiBindingRows").children.length === 6);
  for (const capability of ["chat", "task", "vision", "asr", "tts", "search"]) {
    const binding = elements.get(`apiBinding-${capability}`);
    check(binding.selectedOptions.length === 1);
  }
  // Reproduce the reported failure, so the test cannot pass without exercising
  // the field access that crashed the real page (even for hidden MiMo options).
  context.selectedApiSearch = context.apiCenterDraft.searchProfiles[0].id;
  const search = context.apiCenterDraft.searchProfiles[0];
  const proxy = search.proxy; delete search.proxy;
  assert.throws(() => context.renderApiSearch(), /enabled/);
  search.proxy = proxy; context.renderApiSearch();
  check(true);
  for (const render of ["renderTasks", "renderReviewerAndIntegrity", "renderGroups", "renderMemoryDetail", "renderArchive", "renderDesktopBackup", "renderLogs", "renderSocialPlanner"]) { context[render](); check(true); }
  element("memoryDetailSearch").value = "演示"; context.renderMemoryDetail(); check(true);
  context.backupProgress = { status: "completed", percent: 100, type: "safe", detail: "模拟完成" }; context.renderBackupProgress(); check(true);
  for (const item of fixtures.config.accounts.items) check(["features", "sendTypes", "scope", "modelBindings", "voice"].every((key) => object(item[key])));
  check(fixtures.accounts.statuses.every((item) => object(item.capabilities) && item.qqLogin && item.qrcode));
  check(fixtures.config.automation.rules.every((rule) => Array.isArray(rule.scope.conversationIds) && (rule.trigger.type !== "command" || /^\/[a-z][a-z0-9_-]{0,47}$/.test(rule.trigger.text))));
}

async function selfTest() {
  const server = createPreviewServer({ stateRoot: "/preview/isolated-app" });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let checks = 0;
  const check = (value) => { assert.ok(value); checks += 1; };
  const request = async (route, method = "GET", body, headers = {}) => {
    const res = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  try {
    for (const route of ["/health", "/api/status", "/api/config", "/api/accounts", "/api/api-center", "/api/tasks", "/api/reviewer/status", "/api/memory/integrity", "/api/memory", "/api/memory?group_id=20001", "/api/archive/status", "/api/archive/conversations", "/api/host/status", "/api/host/backups", "/api/host/backup/status", "/api/admin/session", "/api/unknown-fixture"]) check((await request(route)).status === 200);
    for (const [route, type] of [["/admin", "text/html"], ["/console.css", "text/css"], ["/console-theme.js", "text/javascript"]]) {
      const response = await fetch(`${base}${route}`);
      check(response.status === 200 && response.headers.get("content-type").startsWith(type));
      const body = Buffer.from(await response.arrayBuffer());
      const file = route === "/admin" ? "public/admin.html" : `public${route}`;
      check(body.equals(readResource(file)));
      const head = await fetch(`${base}${route}`, { method: "HEAD" });
      check(head.status === 200 && (await head.text()) === "" && head.headers.get("content-length") === String(body.length));
    }
    const original = (await request("/api/config")).data;
    const load = async (route) => (await request(route)).data;
    verifyRenderShapes(readResource("public/admin.html").toString("utf8"), {
      config: original, center: await load("/api/api-center"), tasks: await load("/api/tasks"),
      reviewer: await load("/api/reviewer/status"), integrity: await load("/api/memory/integrity"),
      memory: await load("/api/memory"), group: await load("/api/memory?group_id=20001"),
      archiveStatus: await load("/api/archive/status"), archive: await load("/api/archive/conversations"),
      status: await load("/api/status"), host: await load("/api/host/status"), backups: await load("/api/host/backups"), accounts: await load("/api/accounts")
    }, check);
    check(original.accounts.items.length === 2 && original.accounts.items.map((item) => item.qq).join(",") === "10001,10002");
    check(original.privateChats.ownerUserIds.join() === "10001" && original.taskMode.ownerUserIds.join() === "10001");
    const example = JSON.parse(readResource("config.example.json"));
    for (const id of [...(example.privateChats?.ownerUserIds || []), ...(example.taskMode?.ownerUserIds || []), ...(example.commands?.adminUserIds || [])]) if (id && !["10001", "10002"].includes(String(id))) check(!JSON.stringify(original).includes(String(id)));
    const saved = await request("/api/config", "PATCH", { expectedRevision: original.revision, prompt: { system: "preview draft saved" } });
    check(saved.status === 200 && saved.data.config.prompt.system === "preview draft saved");
    check((await request("/api/config", "PATCH", { expectedRevision: original.revision, prompt: { system: "stale" } })).status === 409);
    const registry = (await request("/api/accounts")).data;
    check(registry.revision === saved.data.config.revision);
    check((await request("/api/accounts/primary", "PATCH", { expectedRevision: registry.revision, patch: { displayName: "修改后的预览账号" } })).status === 200);
    check((await request("/api/accounts/primary", "PATCH", { expectedRevision: registry.revision, patch: { displayName: "stale" } })).status === 409);
    const center = (await request("/api/api-center")).data;
    check(Array.isArray(center.center.searchProfiles[0].proxy.urls));
    check((await request("/api/api-center", "PATCH", { revision: center.revision, center: center.center })).status === 200);
    check((await request("/api/api-center", "PATCH", { revision: center.revision, center: center.center })).status === 409);
    const sparse = copy((await request("/api/api-center")).data);
    for (const item of sparse.center.searchProfiles) delete item.proxy;
    const normalized = await request("/api/api-center", "PATCH", { revision: sparse.revision, center: sparse.center });
    check(normalized.status === 200 && normalized.data.center.searchProfiles.every((item) => typeof item.proxy.enabled === "boolean" && Array.isArray(item.proxy.urls)));
    const invalidCenter = copy(normalized.data.center); invalidCenter.bindings.vision = "missing-profile";
    check((await request("/api/api-center", "PATCH", { revision: normalized.data.revision, center: invalidCenter })).status === 400);
    check((await load("/api/api-center")).revision === normalized.data.revision);
    check((await request("/api/config", "PATCH", {}, { origin: "https://example.com" })).status === 403);
    check((await request("/api/voice/credential", "POST", { secret: "test-placeholder" })).status === 403);
    check((await request("/send", "POST", { message: "test" })).data.sentToQq === false);
    check((await request("/api/unknown-fixture", "POST", {})).data.unsupported === true);
    const unknown = await fetch(`${base}/api/unknown-fixture`, { method: "POST", body: "not-json" });
    check(unknown.status === 200 && (await unknown.json()).empty === true);
    for (const route of ["/config.json", "/data/memory.json", "/public/admin.html", "/%2e%2e%2fconfig.json"]) check((await request(route)).status === 404);
    check((await request("/api/host/status")).data.stateRoot === "/preview/isolated-app");
    check((await request("/health")).data.instanceId.startsWith("console-preview-"));
    check((await request("/health")).data.fixtureVersion === fixtureVersion);
    check((await request("/api/host/backup", "POST", { type: "safe" })).data.simulated);
    const current = (await request("/api/config")).data;
    check((await request("/api/config", "PATCH", { expectedRevision: current.revision, accounts: { items: null } })).status === 400);
    check((await request("/api/config")).data.revision === current.revision);
    const invalid = await fetch(`${base}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{invalid-json" });
    check(invalid.status === 400);
    const oversized = await fetch(`${base}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(262144) }) });
    check(oversized.status === 413);
    for (const [rawPath, host, status] of [["/x/../console.css", new URL(base).host, 404], ["/console.css/../console-theme.js", new URL(base).host, 404], ["/health", "example.com", 403]]) {
      const code = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.address().port, path: rawPath, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
      });
      check(code === status);
    }
    const fresh = createPreviewServer({ stateRoot: "/preview/fresh-isolated-app" });
    try {
      await new Promise((resolve, reject) => { fresh.once("error", reject); fresh.listen(0, "127.0.0.1", resolve); });
      const reset = await (await fetch(`http://127.0.0.1:${fresh.address().port}/api/config`)).json();
      check(reset.revision === "preview-1" && reset.prompt.system !== "preview draft saved");
    } finally { fresh.closeAllConnections(); await new Promise((resolve) => fresh.close(resolve)); }
    console.log(`Console preview self-test passed (${checks} checks; loopback only, no application startup or state IO)`);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every((arg) => arg === "--self-test") && args.length <= 1, "usage: console-preview-server.js [--self-test]");
  if (args.includes("--self-test")) await selfTest();
  else {
    const port = Number(process.env.HERMES_QQ_PREVIEW_PORT || 6328);
    assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, "invalid HERMES_QQ_PREVIEW_PORT");
    const server = createPreviewServer();
    server.on("error", (error) => { console.error(`Preview server failed (${error.code || "error"})`); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => console.log(`Isolated console preview: http://127.0.0.1:${port}/admin (fictional data; memory-only saves; no QQ)`));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  }
}
