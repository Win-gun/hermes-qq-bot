import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  applyCanonicalCorrections,
  canonicalPromptLines,
  ensureCanonicalMemory,
  memoryIntegrityReport,
  mergeCanonicalEvidence
} from "./memory-integrity.js";
import { publicTask, TaskRuntime } from "./task-runtime.js";
import { ensureRequestedTaskArtifacts, taskRequestsPdf } from "./task-artifacts.js";
import { ReplyCoordinator } from "./reply-coordinator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resourceRoot = path.resolve(process.env.HERMES_QQ_RESOURCE_ROOT || path.resolve(__dirname, ".."));
const stateRoot = path.resolve(process.env.HERMES_QQ_HOME || resourceRoot);
// Code assets stay in the app bundle; subprocesses need a real writable cwd.
const rootDir = resourceRoot;
const commandCwd = process.env.HERMES_QQ_HOME ? stateRoot : resourceRoot;
const configPath = path.join(stateRoot, "config.json");
const fallbackConfigPath = path.join(resourceRoot, "config.example.json");
const dataDir = path.join(stateRoot, "data");
const publicDir = path.join(resourceRoot, "public");
const memoryPath = path.join(dataDir, "memory.json");
const qrcodeRefreshStatePath = path.join(dataDir, "qrcode-refresh-state.json");
const logRoot = path.resolve(process.env.HERMES_QQ_LOG_DIR || path.join(stateRoot, "logs"));
const bridgeLogPath = path.join(logRoot, "bridge.log");
const bridgeErrorLogPath = path.join(logRoot, "bridge.error.log");
const napcatQrPath = path.join(stateRoot, "napcat", "qrcode.png");
const napcatCacheQrPath = path.join(stateRoot, "napcat", "cache", "qrcode.png");
const recreateNapcatStableScriptPath = path.join(resourceRoot, "scripts", "recreate-napcat-stable.sh");
const imageCacheDir = path.join(dataDir, "images");
const defaultChatArchiveBaseDir = path.join(dataDir, "chat-archive");
const reviewerRuntime = {
  reviewed: 0,
  passed: 0,
  corrected: 0,
  rejected: 0,
  failed: 0,
  totalDurationMs: 0,
  recent: []
};

const oneBotSendTrackers = new Map();
const oneBotSendRuntime = {
  lastSendAttemptAt: 0,
  lastSendOkAt: 0,
  lastSendFailedAt: 0,
  lastSendAction: "",
  lastSendFailure: ""
};
const accountSendRuntime = new Map();
const napcatAdminOperation = {
  active: false,
  name: "",
  startedAt: 0
};
const qrcodeRefreshRuntime = {
  active: false,
  accountId: "",
  source: "",
  startedAt: 0,
  lastStartedAt: 0,
  lastEndedAt: 0,
  lastAccountId: "",
  lastSource: "",
  byAccount: new Map()
};

function loadQrcodeRefreshState() {
  try {
    if (!fs.existsSync(qrcodeRefreshStatePath)) return;
    const parsed = JSON.parse(fs.readFileSync(qrcodeRefreshStatePath, "utf8"));
    qrcodeRefreshRuntime.lastStartedAt = Number(parsed.lastStartedAt || 0);
    qrcodeRefreshRuntime.lastEndedAt = Number(parsed.lastEndedAt || 0);
    qrcodeRefreshRuntime.lastAccountId = String(parsed.lastAccountId || "");
    qrcodeRefreshRuntime.lastSource = String(parsed.lastSource || "");
    qrcodeRefreshRuntime.byAccount = new Map(Object.entries(parsed.byAccount || {}).map(([key, value]) => [key, Number(value || 0)]));
  } catch (err) {
    // Do not fail bot startup because of a diagnostic cooldown file.
    qrcodeRefreshRuntime.byAccount = new Map();
  }
}

function saveQrcodeRefreshState() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = {
      lastStartedAt: qrcodeRefreshRuntime.lastStartedAt || 0,
      lastEndedAt: qrcodeRefreshRuntime.lastEndedAt || 0,
      lastAccountId: qrcodeRefreshRuntime.lastAccountId || "",
      lastSource: qrcodeRefreshRuntime.lastSource || "",
      byAccount: Object.fromEntries(qrcodeRefreshRuntime.byAccount.entries())
    };
    const tmp = `${qrcodeRefreshStatePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, qrcodeRefreshStatePath);
  } catch {
    // Best effort only; runtime protection still works in memory.
  }
}

loadQrcodeRefreshState();

const napcatLogCache = {
  text: "",
  ok: false,
  error: "not refreshed",
  updatedAt: 0,
  inFlight: false
};
const dockerRuntime = {
  unhealthyUntil: 0,
  lastFailure: ""
};
// Per-user private message cooldown tracker (userId -> last send timestamp)
const privateMessageCooldowns = new Map();
const messageDebounceRuntime = new Map();
const socialDecisionRuntime = {
  recent: []
};
// No-op debug logger (was causing ReferenceError crashes in admin notifications)
const debug = () => {};

function tryStartNapcatAdminOperation(name) {
  if (napcatAdminOperation.active) {
    return {
      ok: false,
      busy: true,
      name: napcatAdminOperation.name,
      startedAt: napcatAdminOperation.startedAt,
      message: `NapCat 操作正在执行中：${napcatAdminOperation.name}`
    };
  }
  napcatAdminOperation.active = true;
  napcatAdminOperation.name = name;
  napcatAdminOperation.startedAt = Date.now();
  return { ok: true };
}

function finishNapcatAdminOperation() {
  napcatAdminOperation.active = false;
  napcatAdminOperation.name = "";
  napcatAdminOperation.startedAt = 0;
}

function safePathSegment(value, fallback = "primary") {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function accountQrPaths(accountId = "primary") {
  const id = safePathSegment(accountId || "primary", "primary");
  if (id === "primary") {
    return {
      id,
      main: napcatQrPath,
      cache: napcatCacheQrPath
    };
  }
  return {
    id,
    main: path.join(stateRoot, "napcat", `qrcode.${id}.png`),
    cache: path.join(stateRoot, "napcat", "cache", `qrcode.${id}.png`)
  };
}

function napcatContainerForAccount(currentConfig, accountId = "primary") {
  const account = currentConfig ? accountById(currentConfig, accountId) : null;
  if (account?.napcatContainer) return account.napcatContainer;
  return accountId === "primary" ? "napcat" : `napcat-${safePathSegment(accountId)}`;
}

function accountProtocol(account) {
  const raw = String(account?.protocol || "").trim().toLowerCase();
  if (raw === "snowluma") return "snowluma";
  return "napcat";
}

function accountProtocolContainer(account, currentConfig = null) {
  if (account?.protocolContainer) return String(account.protocolContainer);
  if (accountProtocol(account) === "snowluma") return account?.snowlumaContainer || `snowluma-${safePathSegment(account?.id || "standby-a")}`;
  return account?.napcatContainer || napcatContainerForAccount(currentConfig, account?.id || "primary");
}

function accountProtocolLabel(account) {
  return accountProtocol(account) === "snowluma" ? "SnowLuma" : "NapCat";
}

function existingQrPathForAccount(accountId = "primary") {
  const paths = accountQrPaths(accountId);
  const candidates = [paths.cache, paths.main].filter((filePath) => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  });
  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0] || "";
}

function existingQrPath() {
  return existingQrPathForAccount("primary");
}

function syncNapcatQrFromContainerForAccount(accountId = "primary", currentConfig = null) {
  const paths = accountQrPaths(accountId);
  const container = napcatContainerForAccount(currentConfig, accountId);
  try {
    fs.mkdirSync(path.dirname(paths.cache), { recursive: true });
    const result = spawnSync("docker", ["cp", `${container}:/app/napcat/cache/qrcode.png`, paths.cache], {
      cwd: commandCwd,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 128 * 1024
    });
    if (result.error || result.status !== 0) return "";
    return existingQrPathForAccount(accountId);
  } catch {
    return "";
  }
}

function syncNapcatQrFromContainer() {
  return syncNapcatQrFromContainerForAccount("primary");
}

function removeLocalQrFilesForAccount(accountId = "primary") {
  const paths = accountQrPaths(accountId);
  const removed = [];
  for (const filePath of [paths.main, paths.cache]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed.push(path.relative(rootDir, filePath));
      }
    } catch (err) {
      warn(`remove qrcode failed file=${filePath}: ${err.message}`);
    }
  }
  return removed;
}

function removeLocalQrFiles() {
  return removeLocalQrFilesForAccount("primary");
}

function qrFileInfoForAccount(accountId = "primary", { sync = false, currentConfig = null } = {}) {
  const filePath = (sync ? syncNapcatQrFromContainerForAccount(accountId, currentConfig) : "") || existingQrPathForAccount(accountId);
  if (!filePath) {
    return {
      exists: false,
      accountId: safePathSegment(accountId || "primary", "primary"),
      path: "",
      size: 0,
      mtimeMs: 0,
      updatedAt: "",
      ageSeconds: null
    };
  }
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      accountId: safePathSegment(accountId || "primary", "primary"),
      path: path.relative(rootDir, filePath),
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000))
    };
  } catch {
    return {
      exists: false,
      accountId: safePathSegment(accountId || "primary", "primary"),
      path: "",
      size: 0,
      mtimeMs: 0,
      updatedAt: "",
      ageSeconds: null
    };
  }
}

function qrFileInfo({ sync = false } = {}) {
  return qrFileInfoForAccount("primary", { sync });
}

function loadConfig() {
  const chosen = fs.existsSync(configPath) ? configPath : fallbackConfigPath;
  const raw = fs.readFileSync(chosen, "utf8");
  const cfg = JSON.parse(raw);
  cfg.__path = chosen;
  return cfg;
}

function loadMemory() {
  try {
    if (!fs.existsSync(memoryPath)) return { groups: {} };
    const raw = fs.readFileSync(memoryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.groups || typeof parsed.groups !== "object") parsed.groups = {};
    return parsed;
  } catch (err) {
    warn(`memory load failed, using empty memory: ${err.message}`);
    return { groups: {} };
  }
}

function saveMemory(memory) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${memoryPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(memory, null, 2)}\n`);
  fs.renameSync(tmp, memoryPath);
}

function saveConfig(config) {
  const target = configPath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const backup = `${target}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(target, backup);
  }
  const copy = JSON.parse(JSON.stringify(config || {}));
  delete copy.__path;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(copy, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

function replaceConfigInPlace(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  return target;
}

function groupMemory(memory, groupId) {
  const gid = asStringId(groupId);
  memory.groups[gid] ||= {
    users: {},
    facts: [],
    summaries: [],
    settings: {},
    dailySent: {},
    rollingSummary: "",
    topics: [],
    pendingMemoryMessages: []
  };
  memory.groups[gid].users ||= {};
  memory.groups[gid].facts ||= [];
  memory.groups[gid].summaries ||= [];
  memory.groups[gid].settings ||= {};
  memory.groups[gid].dailySent ||= {};
  memory.groups[gid].rollingSummary ||= "";
  memory.groups[gid].topics ||= [];
  memory.groups[gid].pendingMemoryMessages ||= [];
  memory.groups[gid].lastSummarizedMessageAt ||= 0;
  return memory.groups[gid];
}

function dedupePush(list, value, max = 12) {
  const item = String(value || "").replace(/\s+/g, " ").trim();
  if (!item || item.length < 2) return false;
  const exists = list.some((x) => x.toLowerCase() === item.toLowerCase());
  if (exists) return false;
  list.push(item);
  while (list.length > max) list.shift();
  return true;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function asObjectArray(value) {
  return asArray(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function dedupePushObject(list, value, key = "text", max = 12) {
  if (!value || typeof value !== "object") return false;
  const item = { ...value };
  const text = String(item[key] || item.text || "").replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) return false;
  item[key] = text;
  const exists = list.some((x) => String(x?.[key] || x?.text || "").toLowerCase() === text.toLowerCase());
  if (exists) return false;
  list.push(item);
  while (list.length > max) list.shift();
  return true;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function setIfPresent(target, source, key, transform = (x) => x) {
  if (Object.prototype.hasOwnProperty.call(source || {}, key)) target[key] = transform(source[key]);
}

function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function stringValue(value, fallback = "") {
  return value == null ? fallback : String(value);
}

function clampText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function clampTextTail(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1)).trimStart()}`;
}

function tailText(filePath, maxBytes = 6000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (err) {
    return `读取日志失败：${err.message}`;
  }
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function parseNapcatLogTime(line) {
  const match = String(line || "").match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  const year = new Date().getFullYear();
  const [, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function formatLocalDateTime(ts) {
  const n = Number(ts || 0);
  if (!n) return "未知";
  return new Date(n).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function readNapcatLogTail(maxLines = 260) {
  try {
    const local = readLocalNapcatLogTail(maxLines);
    const source = local.text;
    const lines = source.split(/\r?\n/).filter(Boolean);
    return {
      ok: local.ok,
      text: stripAnsi(lines.slice(-Math.max(1, Number(maxLines || 260))).join("\n")),
      error: local.error
    };
  } catch (err) {
    return { ok: false, text: "", error: err.message };
  }
}

function readLocalNapcatLogTail(maxLines = 260) {
  const logFiles = [];
  const candidateDirs = [
    path.join(stateRoot, "napcat", "QQ", "nt_qq", "global", "nt_data", "Log", "log")
  ];
  const qqRoot = path.join(stateRoot, "napcat", "QQ");
  try {
    for (const entry of fs.readdirSync(qqRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("nt_qq_")) {
        candidateDirs.push(path.join(qqRoot, entry.name, "nt_data", "log"));
      }
    }
  } catch {}
  for (const dir of candidateDirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.(qqxlog|log|txt)$/i.test(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        const stat = fs.statSync(filePath);
        logFiles.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {}
  }
  logFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chunks = [];
  for (const file of logFiles.slice(0, 6).reverse()) {
    chunks.push(tailText(file.filePath, 96 * 1024));
  }
  const text = chunks.join("\n");
  if (!text.trim()) return { ok: false, text: "", error: "no local NapCat log files found" };
  return {
    ok: true,
    text: text.split(/\r?\n/).slice(-Math.max(1, Number(maxLines || 260))).join("\n"),
    error: ""
  };
}

async function refreshNapcatLogCache({ force = false, maxLines = 260 } = {}) {
  const nowMs = Date.now();
  const minAgeMs = 10_000;
  if (napcatLogCache.inFlight) return napcatLogCache;
  if (!force && napcatLogCache.updatedAt && nowMs - napcatLogCache.updatedAt < minAgeMs) return napcatLogCache;
  napcatLogCache.inFlight = true;
  try {
    const result = await runCommand("docker", ["logs", "--tail", String(maxLines), "napcat"], { timeoutMs: 5000, killGraceMs: 800 });
    const text = stripAnsi(`${result.stdout || ""}${result.stderr || ""}`);
    napcatLogCache.text = text || napcatLogCache.text;
    napcatLogCache.ok = result.ok;
    napcatLogCache.error = result.ok ? "" : (result.error || result.stderr || result.signal || `docker logs exited ${result.code}`);
    napcatLogCache.updatedAt = Date.now();
    return napcatLogCache;
  } finally {
    napcatLogCache.inFlight = false;
  }
}

function classifyNapcatLogin({ onebotConnected = false } = {}) {
  const logs = readNapcatLogTail();
  const lines = logs.text.split(/\r?\n/).filter(Boolean);
  const relevant = [];
  const patterns = [
    /KickedOffLine|登录已失效|下线通知|账号状态变更为离线|快速登录错误|用户身份已失效|重新登录/,
    /正在快速登录|正在尝试密码回退登录|正在密码登录/,
    /需要验证码|密码回退需要验证码|验证码登录后需要新设备验证|正在新设备验证登录|safe\/verify|sms-verify-login/,
    /EventChecker Failed|sendMsg|网络连接异常|发送失败/,
    /没有 -q 指令指定快速登录|可用于快速登录|请扫描下面的二维码|二维码已保存|二维码解码URL|使用二维码登录方式|等待扫码|授权登录/,
    /OneBot11 适配器初始化完成|WebSocket反向服务|账号状态变更为在线|登录成功|自动快速登录成功|当前账号\(\d+\)已登录|无法重复登录|接收 <-/
  ];
  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) relevant.push({ index, line, at: parseNapcatLogTime(line) });
  });

  const lastBad = relevant.filter((x) => /KickedOffLine|登录已失效|下线通知|账号状态变更为离线|快速登录错误|用户身份已失效|重新登录/.test(x.line)).at(-1);
  const lastQuickLogin = relevant.filter((x) => /正在快速登录|正在尝试密码回退登录|正在密码登录/.test(x.line)).at(-1);
  const lastVerification = relevant.filter((x) => /需要验证码|密码回退需要验证码|验证码登录后需要新设备验证|正在新设备验证登录|safe\/verify|sms-verify-login/.test(x.line)).at(-1);
  const lastSendError = relevant.filter((x) => /EventChecker Failed|sendMsg|网络连接异常|发送失败/.test(x.line)).at(-1);
  const lastQr = relevant.filter((x) => /没有 -q 指令指定快速登录|可用于快速登录|请扫描下面的二维码|二维码已保存|二维码解码URL|使用二维码登录方式|等待扫码|授权登录/.test(x.line)).at(-1);
  const lastOnline = relevant.filter((x) => /账号状态变更为在线|登录成功|自动快速登录成功|当前账号\(\d+\)已登录|无法重复登录|接收 <-/.test(x.line)).at(-1);

  let status = "unknown";
  let message = "暂时无法确认 NapCat 登录状态。";
  const latestProblem = [lastBad, lastQuickLogin, lastVerification, lastSendError, lastQr]
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .at(-1);
  if (latestProblem && (!lastOnline || latestProblem.index > lastOnline.index)) {
    if (latestProblem === lastVerification) {
      status = "verification_required";
      message = "QQ 密码/快速登录触发验证码或新设备验证，需要在 NapCat WebUI 继续验证。";
    } else if (latestProblem === lastQr) {
      status = "login_required";
      message = "NapCat 正在等待扫码登录。";
    } else if (latestProblem === lastQuickLogin) {
      status = "quick_login";
      message = "NapCat 正在尝试快速/密码登录 QQ。";
    } else if (latestProblem === lastSendError) {
      status = "send_failed";
      message = "QQ 当前发送消息失败，NapCat/QQ 连接可能是假在线或网络异常。";
    } else {
      status = "login_invalid";
      message = "QQ 登录已失效，需要重新扫码登录。";
    }
  } else if (onebotConnected && (!lastBad || (lastOnline && lastOnline.index > lastBad.index)) && (!lastQr || (lastOnline && lastOnline.index > lastQr.index))) {
    status = "online";
    message = "QQ 已登录，OneBot 已连接。";
  } else if (!onebotConnected && existingQrPath()) {
    status = "login_required";
    message = "NapCat 正在等待扫码登录。";
  } else if (!onebotConnected) {
    status = "disconnected";
    message = "OneBot 未连接；如果刚重启过 NapCat，可能还在等待登录或重连。";
  } else {
    status = "online";
    message = "QQ 登录状态看起来正常。";
  }

  return {
    status,
    ok: status === "online",
    needsLogin: status === "login_invalid" || status === "login_required" || status === "verification_required",
    sendFailed: status === "send_failed",
    message,
    qrcodeExists: Boolean(existingQrPath()),
    lastEvent: relevant.at(-1)?.line || "",
    lastEventAt: relevant.at(-1)?.at || 0,
    reasonEvent: (status === "login_invalid" ? lastBad : status === "verification_required" ? lastVerification : status === "login_required" ? lastQr : status === "quick_login" ? lastQuickLogin : status === "send_failed" ? lastSendError : relevant.at(-1))?.line || "",
    reasonEventAt: (status === "login_invalid" ? lastBad : status === "verification_required" ? lastVerification : status === "login_required" ? lastQr : status === "quick_login" ? lastQuickLogin : status === "send_failed" ? lastSendError : relevant.at(-1))?.at || 0,
    recent: relevant.slice(-12).map((x) => x.line),
    logError: logs.ok ? "" : logs.error
  };
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { __error: err.message, ...fallback };
  }
}

function writeJsonFileSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function botDisplayName(config) {
  return config.__activeAccountDisplayName || config.persona?.displayName || "Hermes小跟班";
}

function redactSensitive(text, config) {
  if (config.memory?.privacyFilter === false) return String(text || "");
  return String(text || "")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号]")
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证]")
    .replace(/\b\d{12,19}\b/g, "[长数字]")
    .replace(/(密码|口令|验证码|token|密钥|secret|password|code)[:：= ]{0,4}[A-Za-z0-9._\-]{4,}/gi, "$1=[已过滤]")
    .replace(/(住址|地址|宿舍|寝室)[:： ]?[^，。！？!?\n]{6,80}/g, "$1=[已过滤]");
}

function messageTiming(event = {}, { receivedAt = Date.now(), processedAt = Date.now() } = {}) {
  const sentAtMs = Number(event?.time || 0) ? Number(event.time) * 1000 : Number(event?.sentAtMs || receivedAt || Date.now());
  return {
    sentAtMs,
    sentAt: new Date(sentAtMs).toISOString(),
    receivedAt: new Date(Number(receivedAt || Date.now())).toISOString(),
    processedAt: new Date(Number(processedAt || Date.now())).toISOString()
  };
}

function formatMessageTime(value, config = {}, { includeDate = true } = {}) {
  const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.messageTime?.timezone || "Asia/Shanghai",
    year: includeDate ? "numeric" : undefined,
    month: includeDate ? "2-digit" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function shortMessageForPrompt(item, config = {}) {
  const time = formatMessageTime(item.sentAtMs || item.at || item.sentAt, config, { includeDate: true });
  const sender = item.sender || item.user_id || "群友";
  const senderId = asStringId(item.user_id);
  const reply = asArray(item.replyContexts).find((ctx) => ctx && (ctx.resolved || ctx.messageId));
  const replyLabel = reply
    ? ` [回复${reply.isBot ? "机器人" : reply.senderName || reply.senderId || "某条消息"}${reply.text ? `「${clampText(reply.text, 80)}」` : ""}]`
    : "";
  const pending = item.pending ? " [仍在输入]" : "";
  return `${time ? `[${time}] ` : ""}${sender}${senderId ? `(${senderId})` : ""}${replyLabel}${pending}: ${item.text}`;
}

function orderedHistory(items) {
  return asArray(items).slice().sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
}

function formatReplyContextsForPrompt(contexts = []) {
  const lines = asArray(contexts).map((ctx) => {
    if (!ctx) return "";
    const target = ctx.isBot ? "机器人" : ctx.senderName || ctx.senderId || "未知发送者";
    const id = ctx.senderId ? `(${ctx.senderId})` : "";
    const body = ctx.text ? `：${clampText(ctx.text, 260)}` : "（正文未取到）";
    const time = ctx.sentAt ? ` [原消息时间 ${formatMessageTime(ctx.sentAt, {}, { includeDate: true })}]` : "";
    return `- 回复 ${target}${id}${time}${body}`;
  }).filter(Boolean);
  return lines.join("\n");
}

function isMediaOnlyText(text) {
  return /^\s*(?:\[(?:图片表情(?:#\d+)?|图片(?:#\d+)?|表情|语音|视频|文件)(?::[^\]]*)?\]\s*)+\s*$/.test(String(text || "").trim());
}

function now() {
  return new Date().toISOString();
}

function localNowText() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

function warn(...args) {
  console.warn(`[${now()}] WARN`, ...args);
}

function asStringId(value) {
  return value == null ? "" : String(value);
}

function conversationIdFromEvent(event) {
  if (event?.message_type === "private") return `private:${asStringId(event.user_id)}`;
  return asStringId(event?.group_id);
}

function conversationLabelFromEvent(event) {
  if (event?.message_type === "private") return `private:${asStringId(event.user_id)}`;
  return `group:${asStringId(event?.group_id)}`;
}

function oneBotMessageToText(message) {
  if (typeof message === "string") {
    let imageIndex = 0;
    let emojiIndex = 0;
    return message
      .replace(/\[CQ:at,qq=([^\]]+)\]/g, "@$1 ")
      .replace(/\[CQ:reply,[^\]]*\]/g, "[引用消息] ")
      .replace(/\[CQ:image,[^\]]*\]/g, () => `[图片#${++imageIndex}]`)
      .replace(/\[CQ:(?:mface|bface|marketface),[^\]]*\]/g, () => `[图片表情#${++emojiIndex}]`)
      .replace(/\[CQ:face,[^\]]*\]/g, "[表情]")
      .replace(/\[CQ:[^\]]+\]/g, "")
      .trim();
  }
  if (Array.isArray(message)) {
    let imageIndex = 0;
    let emojiIndex = 0;
    return message
      .map((seg) => {
        if (!seg || typeof seg !== "object") return "";
        if (seg.type === "text") return seg.data?.text ?? "";
        if (seg.type === "at") return `@${seg.data?.qq ?? ""}`;
        if (seg.type === "image") return `[图片#${++imageIndex}]`;
        if (["mface", "bface", "marketface"].includes(seg.type)) return `[图片表情#${++emojiIndex}]`;
        if (seg.type === "face") return "[表情]";
        if (seg.type === "reply") return "[引用消息]";
        return `[${seg.type}]`;
      })
      .join("")
      .trim();
  }
  return "";
}

function stableMessageFingerprint(event, text) {
  const conversation = conversationIdFromEvent(event);
  const sender = asStringId(event?.user_id);
  const time = event?.time ? String(event.time) : String(Math.floor(Date.now() / 3000));
  const payload = typeof event?.message === "string"
    ? event.message
    : JSON.stringify(event?.message || event?.raw_message || text || "");
  return [
    event?.message_type || "",
    conversation,
    sender,
    time,
    clampText(payload || text || "", 500)
  ].join("|");
}

function decodeCqValue(value) {
  const raw = String(value || "")
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseCqParams(value) {
  const out = {};
  for (const part of String(value || "").split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeCqValue(part.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

function extractReplyMessageIds(message) {
  const ids = [];
  const add = (value) => {
    const id = asStringId(value).trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (typeof message === "string") {
    for (const match of message.matchAll(/\[CQ:reply,([^\]]+)\]/g)) {
      const params = parseCqParams(match[1]);
      add(params.id || params.message_id || params.messageId);
    }
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type !== "reply") continue;
      add(seg.data?.id || seg.data?.message_id || seg.data?.messageId);
    }
  }
  return ids;
}

function isImageLikeSegmentType(type, includeImageEmojis = true) {
  if (type === "image") return true;
  return includeImageEmojis && ["mface", "bface", "marketface"].includes(type);
}

function extractImageRefs(message, options = {}) {
  const refs = [];
  const includeImageEmojis = options.includeImageEmojis !== false;
  const source = options.source || "current";
  const messageId = options.messageId || "";
  const add = (data = {}, kind = "image") => {
    const url = data.url || data.file_url || data.fileUrl || data.path || "";
    const file = data.file || data.file_id || data.fileId || "";
    const candidate = /^https?:\/\//i.test(url) ? url : /^https?:\/\//i.test(file) ? file : url;
    refs.push({
      index: refs.length + 1,
      url: candidate || "",
      file: file || "",
      summary: data.summary || "",
      kind,
      source,
      messageId,
      raw: data
    });
  };
  if (typeof message === "string") {
    for (const match of message.matchAll(/\[CQ:(image|mface|bface|marketface),([^\]]+)\]/g)) {
      if (isImageLikeSegmentType(match[1], includeImageEmojis)) add(parseCqParams(match[2]), match[1]);
    }
    return refs;
  }
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (isImageLikeSegmentType(seg?.type, includeImageEmojis)) add(seg.data || {}, seg.type);
    }
  }
  return refs;
}

function normalizeImageRefIndexes(refs) {
  return asArray(refs).map((ref, index) => ({ ...ref, index: index + 1 }));
}

function imageRefDisplayName(ref) {
  const emoji = ["mface", "bface", "marketface"].includes(ref?.kind);
  const prefix = ref?.source === "quoted" ? "引用" : "";
  return `${prefix}${emoji ? "图片表情" : "图片"}#${ref?.index || "?"}`;
}

function imageRefDebug(ref) {
  return `#${ref.index}:${ref.source || "current"}/${ref.kind || "image"}/${ref.url ? "url" : "no-url"}/${ref.file ? "file" : "no-file"}`;
}

function wantsVisionRequest(text) {
  const source = String(text || "");
  return /(识图|看图|看看图|看一下图|图里|图片里|照片里|截图里|这张图|这个图|这图|这照片|这截图|表情包|这是什么|这是啥|什么意思|啥意思|读一下|识别一下|看得清|图上|图中)/i.test(source);
}

function detectVisionConversationContext({ history, current, lastBotMessage, config }) {
  const cfg = config.vision || {};
  if (!lastBotMessage) return { matched: false, strong: false, reason: "no recent bot message", messagesAfterBot: 999 };
  const nowMs = Date.now();
  const windowMs = Number(cfg.followupWindowMs || config.implicitReply?.windowMs || 5 * 60_000);
  if (nowMs - Number(lastBotMessage.at || 0) > windowMs) {
    return { matched: false, strong: false, reason: "bot message too old", messagesAfterBot: 999 };
  }
  const afterBot = lastNonBotMessagesSince(history, lastBotMessage.at);
  const messagesAfterBot = afterBot.length;
  const maxMessages = Number(cfg.followupMaxMessagesAfterBot || 3);
  const sameUserAsBotTarget = lastBotMessage.replyToUserId && asStringId(current?.user_id) === asStringId(lastBotMessage.replyToUserId);
  const sameUserAsBotMention = (lastBotMessage.mentionedUserIds || []).map(asStringId).includes(asStringId(current?.user_id));
  const immediate = messagesAfterBot <= 1;
  const near = messagesAfterBot <= maxMessages;
  const recentDialogue = asArray(history)
    .slice(-8)
    .some((item) => item?.isBot && (asStringId(item.replyToUserId) === asStringId(current?.user_id) || asArray(item.mentionedUserIds).map(asStringId).includes(asStringId(current?.user_id))));
  const assistWindowMs = Number(cfg.contextAssistWindowMs || windowMs);
  const assistRecentMessages = Math.max(3, Number(cfg.contextAssistRecentMessages || 10));
  const assistMaxMessages = Math.max(maxMessages, Number(cfg.contextAssistMaxMessagesAfterBot || 6));
  const recentWindow = asArray(history).slice(-assistRecentMessages);
  const recentBotPresence = recentWindow.some((item) => item?.isBot && nowMs - Number(item.at || 0) <= assistWindowMs);
  const recentUserDialogue = recentWindow.some((item) => (
    item?.isBot
    && (
      asStringId(item.replyToUserId) === asStringId(current?.user_id)
      || asArray(item.mentionedUserIds).map(asStringId).includes(asStringId(current?.user_id))
    )
  ));
  const text = String(current?.text || "").trim();
  const imageOnlyOrTiny = isMediaOnlyText(text) || text.length <= Number(cfg.contextAssistShortTextMaxLength || 24);
  const contextAssist = cfg.contextAssist !== false
    && recentBotPresence
    && messagesAfterBot <= assistMaxMessages
    && (imageOnlyOrTiny || recentDialogue || recentUserDialogue || sameUserAsBotTarget || sameUserAsBotMention);
  const matched = (near && (immediate || sameUserAsBotTarget || sameUserAsBotMention || recentDialogue)) || contextAssist;
  const strong = near && (sameUserAsBotTarget || sameUserAsBotMention || immediate);
  const reasons = [];
  if (immediate) reasons.push("image immediately after bot");
  if (!immediate && near) reasons.push("image near bot reply");
  if (sameUserAsBotTarget) reasons.push("same user bot just replied to");
  if (sameUserAsBotMention) reasons.push("same user bot mentioned");
  if (recentDialogue) reasons.push("recent dialogue with bot");
  if (contextAssist) reasons.push("context-assist vision while bot is participating");
  return {
    matched,
    strong,
    reason: reasons.join("; ") || "weak vision follow-up",
    messagesAfterBot
  };
}

function shouldDescribeImages({ imageRefs, text, mentioned, keyword, isPrivate, config, visionContext = null }) {
  const cfg = config.vision || {};
  if (cfg.enabled === false || !imageRefs?.length) return false;
  if (cfg.onlyWhenMentionedOrAsked === false) return true;
  if (cfg.aggressiveFollowup !== false && visionContext?.matched) return true;
  return Boolean(isPrivate || mentioned || keyword || wantsVisionRequest(text));
}

function ruleVisionDecision({ imageRefs, text, mentioned, keyword, isPrivate, config, visionContext = null }) {
  const matched = shouldDescribeImages({ imageRefs, text, mentioned, keyword, isPrivate, config, visionContext });
  return {
    matched,
    selectedIndexes: matched ? asArray(imageRefs).map((ref) => ref.index) : [],
    confidence: matched ? (visionContext?.strong ? 0.82 : 0.6) : 0,
    reason: matched ? (visionContext?.matched ? `conversation follow-up: ${visionContext.reason}` : "rule matched") : "rule skipped"
  };
}

function visionJudgePrompt({ imageRefs, text, quotedTexts, history, current, mentioned, keyword, isPrivate, visionContext }) {
  const refs = asArray(imageRefs).map((ref) => ({
    index: ref.index,
    kind: ref.kind || "image",
    source: ref.source || "current",
    summary: ref.summary || "",
    has_url: Boolean(ref.url),
    has_file: Boolean(ref.file),
    quoted_message_id: ref.source === "quoted" ? ref.messageId || "" : ""
  }));
  const recent = asArray(history).slice(-10).map((item) => shortMessageForPrompt(item, config)).join("\n");
  const quoted = asArray(quotedTexts).filter(Boolean).slice(0, 3).join("\n");
  return `你是 QQ 机器人的图片识别调度器。你只能判断“现在是否值得调用视觉模型识别图片/图片表情”，不要描述图片内容。

【触发信息】
- 私聊：${Boolean(isPrivate)}
- @机器人：${Boolean(mentioned)}
- 命中机器人关键词/问图关键词：${Boolean(keyword)}
- 图片是否紧跟 bot 对话：${Boolean(visionContext?.matched)}
- 紧跟原因：${visionContext?.reason || "无"}
- bot 后经过群友消息数：${Number.isFinite(Number(visionContext?.messagesAfterBot)) ? visionContext.messagesAfterBot : "未知"}
- 当前消息文字：${clampText(text || "", 600)}

【图片候选】
${JSON.stringify(refs, null, 2)}

【引用消息文字】
${quoted || "（无）"}

【最近聊天】
${recent || "（无）"}

【判断规则】
- 如果用户问“图里有什么/这是什么/啥意思/表情包什么意思/看这个/识图”等，应该识别相关图片。
- 如果当前消息引用了一条图片或图片表情，并且文字像是在问这张引用图，也应该识别引用图。
- 如果用户 @ 机器人或私聊机器人并发送纯图片/图片表情，通常应该识别。
- 如果 bot 刚刚回复过某人，而这个人紧接着发图片/图片表情，或者 bot 发言后 1-3 条内有人发图片/图片表情，这很可能是在用图接 bot 的话；这类场景要更积极识别，即使文字很少或只有图片。
- 如果 bot 上一句提到/@某人，而该人随后发图片/图片表情，也应该倾向识别。
- 如果 bot 正在参与这一段对话，即使图片/表情没有明确文字说明，也可以先识别来帮助理解上下文；识别不等于一定回复。
- 图片类表情包经常承担“回答/吐槽/情绪反应”的功能，在 bot 被接话、被调侃、被追问、或刚刚发言后，要比普通闲聊更积极识别。
- 识别图片只是给后续聊天补上下文，不代表机器人一定要回复；所以拿不准时，尤其在 bot 对话临近场景里，应该先识别，再由后续回复决策判断要不要发言。
- 如果只是路过闲聊、没有人问图、机器人也没被点名，通常不识别。
- 可以只选择最相关的图片 index，避免多看无关图片。

只输出 JSON，不要解释：
{
  "should_describe": true,
  "selected_indices": [1],
  "confidence": 0.0,
  "reason": "一句中文理由"
}`;
}

async function judgeVisionWithAI({ imageRefs, text, mentioned, keyword, isPrivate, config, history = [], current = null, quotedTexts = [], visionContext = null }) {
  const cfg = config.vision || {};
  if (cfg.enabled === false || !imageRefs?.length) return { matched: false, selectedIndexes: [], confidence: 0, reason: "vision disabled or no images" };
  const fallback = () => ruleVisionDecision({ imageRefs, text, mentioned, keyword, isPrivate, config, visionContext });
  const aiJudge = cfg.aiJudge || {};
  if (aiJudge.enabled === false) return fallback();
  try {
    const prompt = visionJudgePrompt({ imageRefs, text, quotedTexts, history, current, mentioned, keyword, isPrivate, visionContext });
    const judgeConfig = {
      ...config,
      ai: {
        ...(config.ai || {}),
        reasoningEffort: "none",
        timeoutMs: Number(aiJudge.timeoutMs || config.ai?.timeoutMs || 120000)
      }
    };
    const parsed = extractJsonObject(await callHermes(prompt, judgeConfig));
    if (!parsed || typeof parsed !== "object") throw new Error("AI vision judge did not return JSON");
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    const minConfidence = Math.max(0, Math.min(1, Number(aiJudge.minConfidence || 0.55)));
    const selected = asArray(parsed.selected_indices)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 1 && x <= imageRefs.length);
    let matched = Boolean(parsed.should_describe) && confidence >= minConfidence;
    let reason = stringValue(parsed.reason || (matched ? "AI decided to describe" : "AI decided to skip")).slice(0, 180);
    if (!matched && cfg.describeWhenUncertain !== false && visionContext?.matched && confidence <= Number(aiJudge.uncertainMaxConfidence || 0.7)) {
      matched = true;
      reason = `uncertain follow-up, describe first: ${visionContext.reason}; ai=${reason}`;
    }
    if (!matched && cfg.aggressiveFollowup !== false && visionContext?.strong && confidence >= Number(aiJudge.followupOverrideMinConfidence || 0.25)) {
      matched = true;
      reason = `follow-up override: ${visionContext.reason}; ai=${reason}`;
    }
    return {
      matched,
      selectedIndexes: matched ? (selected.length ? Array.from(new Set(selected)) : asArray(imageRefs).map((ref) => ref.index)) : [],
      confidence,
      reason
    };
  } catch (err) {
    warn(`vision AI judge failed: ${err.message}`);
    if (stringValue(aiJudge.fallback || "rule") === "skip") {
      return { matched: false, selectedIndexes: [], confidence: 0, reason: `AI judge failed: ${err.message}` };
    }
    return fallback();
  }
}

async function resolveQuotedMessages({ messages, message, config, getMessage, botIds = [] }) {
  if (typeof getMessage !== "function") return { contexts: [], refs: [], texts: [], ids: [] };
  const sourceMessages = messages?.length ? messages : [message];
  const maxQuoted = Math.max(0, Math.min(Number(config.history?.maxQuotedMessages || config.vision?.maxQuotedMessages || 4), 8));
  const ids = Array.from(new Set(sourceMessages.flatMap((item) => extractReplyMessageIds(item)))).slice(0, maxQuoted);
  const knownBotIds = new Set(asArray(botIds).map(asStringId).filter(Boolean));
  const contexts = [];
  const refs = [];
  const texts = [];
  for (const id of ids) {
    try {
      const data = await getMessage(id);
      const payload = data?.message || data?.raw_message || data?.message_body || "";
      const quotedText = oneBotMessageToText(payload);
      const senderId = asStringId(data?.sender?.user_id || data?.sender?.userId || data?.user_id || data?.userId || data?.sender_id);
      const senderName = data?.sender?.card || data?.sender?.nickname || data?.sender?.name || senderId || "未知发送者";
      const context = {
        messageId: asStringId(data?.message_id || id),
        senderId,
        senderName,
        text: quotedText,
        sentAt: messageTiming(data || {}).sentAt,
        sentAtMs: messageTiming(data || {}).sentAtMs,
        isBot: Boolean(senderId && knownBotIds.has(senderId)),
        resolved: true
      };
      contexts.push(context);
      if (quotedText) texts.push(`引用消息${id}（${senderName}${senderId ? `/${senderId}` : ""}）: ${quotedText}`);
      refs.push(...extractImageRefs(payload, {
        source: "quoted",
        messageId: id,
        includeImageEmojis: config.vision?.includeImageEmojis !== false
      }));
      log(`quoted message resolved id=${id} sender=${senderId || "unknown"} isBot=${context.isBot} refs=${refs.length}`);
    } catch (err) {
      contexts.push({ messageId: asStringId(id), senderId: "", senderName: "", text: "", isBot: false, resolved: false });
      warn(`failed to resolve quoted message id=${id}: ${err.message}`);
    }
  }
  return { contexts, refs, texts, ids };
}

async function collectQuotedImageRefs({ message, config, getMessage }) {
  const cfg = config.vision || {};
  if (cfg.includeQuotedImages === false) return { refs: [], texts: [], ids: [] };
  return resolveQuotedMessages({ message, config, getMessage });
}

function messageMentionsSelf(event, text) {
  const selfId = asStringId(event.self_id);
  if (!selfId) return false;
  if (typeof event.message === "string" && event.message.includes(`[CQ:at,qq=${selfId}]`)) {
    return true;
  }
  if (Array.isArray(event.message)) {
    return event.message.some((seg) => seg?.type === "at" && asStringId(seg?.data?.qq) === selfId);
  }
  return text.includes(`@${selfId}`);
}

function stripSelfMention(text, event) {
  const selfId = asStringId(event.self_id);
  return text.replace(new RegExp(`@${selfId}\\s*`, "g"), "").trim();
}

function hasKeyword(text, config) {
  const lower = text.toLowerCase();
  return (config.botNames || []).some((name) => {
    const n = String(name || "").trim();
    return n && lower.includes(n.toLowerCase());
  });
}

function extractMemoryHints(text, config) {
  if (config.memory?.enabled === false) return { preferences: [], boundaries: [], memes: [], facts: [] };
  const source = redactSensitive(text, config).replace(/\s+/g, " ").trim();
  const maxLen = Number(config.memory?.maxExtractLength || 48);
  const preferences = [];
  const boundaries = [];
  const memes = [];
  const facts = [];
  const preferencePatterns = [
    /(?:我|俺|本人)?(?<!不)(?<!没)(?:最?喜欢|爱|偏爱|沉迷|想吃|想玩|想看|想要)([^，。！？!?；;\n]{1,32})/g
  ];
  for (const pattern of preferencePatterns) {
    for (const match of source.matchAll(pattern)) {
      const hint = match[0].slice(0, maxLen).trim();
      if (hint) preferences.push(hint);
    }
  }
  const boundaryPatterns = [
    /(?:我|俺|本人)?(?:不喜欢|讨厌|害怕|怕|受不了)([^，。！？!?；;\n]{1,32})/g
  ];
  for (const pattern of boundaryPatterns) {
    for (const match of source.matchAll(pattern)) {
      const hint = match[0].slice(0, maxLen).trim();
      if (hint) boundaries.push(hint);
    }
  }

  const memePatterns = [
    /(?:梗是|群梗是|经典是|名场面是|这个梗叫|这个梗叫做)[:： ]?([^，。！？!?；;\n]{2,48})/g,
    /([^，。！？!?；;\n]{2,32})(?:是|算是)(?:群梗|老梗|名场面)/g
  ];
  for (const pattern of memePatterns) {
    for (const match of source.matchAll(pattern)) {
      const hint = (match[1] || match[0]).slice(0, maxLen).trim();
      if (hint) memes.push(hint);
    }
  }

  for (const match of source.matchAll(/(?:记住|帮我记一下|机器人记一下)[:： ]?([^。！？!?\n]{2,80})/g)) {
    const hint = match[1].slice(0, 80).trim();
    if (hint) facts.push(hint);
  }

  return { preferences, boundaries, memes, facts };
}

function ensureUserMemory(gm, senderId, senderName = "") {
  const user = (gm.users[senderId] ||= {
    names: [],
    aliases: [],
    preferences: [],
    boundaries: [],
    memes: [],
    coreMemes: [],
    messageCount: 0,
    firstSeenAt: now(),
    lastSeenAt: now(),
    profile: [],
    personality: [],
    style: [],
    relationships: [],
    interactionTips: [],
    notableQuotes: [],
    confidence: {},
    updatedAt: now()
  });
  user.names ||= [];
  user.aliases ||= [];
  user.preferences ||= [];
  user.boundaries ||= [];
  user.memes ||= [];
  user.coreMemes ||= [];
  user.profile ||= [];
  user.personality ||= [];
  user.style ||= [];
  user.relationships ||= [];
  user.interactionTips ||= [];
  user.notableQuotes ||= [];
  user.confidence ||= {};
  user.lastName ||= senderName || user.names.at(-1) || senderId;
  user.updatedAt ||= now();
  for (const item of asArray(user.preferences)) {
    const text = String(item || "");
    if (/^(不喜欢\/雷点|雷点|不喜欢)[:：]/.test(text)) {
      dedupePush(user.boundaries, text.replace(/^(不喜欢\/雷点|雷点|不喜欢)[:：]\s*/, ""), 12);
    }
  }
  for (const item of asArray(user.profile)) {
    const text = String(item || "");
    if (/^相处建议[:：]/.test(text)) {
      dedupePush(user.interactionTips, text.replace(/^相处建议[:：]\s*/, ""), 12);
    }
  }
  for (const item of asArray(user.style).slice(-3)) dedupePush(user.personality, item, 8);
  for (const item of asArray(user.memes).slice(-4)) dedupePush(user.coreMemes, item, 12);
  ensureCanonicalMemory(user, senderId, { at: user.lastSeenAt, sourceConversationId: "legacy" });
  return user;
}

function ensureBotSelfMemory(gm, config = {}) {
  const displayName = botDisplayName(config);
  const bot = (gm.botSelf ||= {});
  bot.names ||= [displayName, "小跟班", "Hermes"];
  bot.identity ||= [
    `我是 ${displayName}，通过 Hermes 接入 QQ 的 AI 群友/小跟班。`,
    "我不是群管理员，也不能真的转账、充值、踢人、@群主或替用户操作 QQ。"
  ];
  bot.personality ||= [
    "机灵、会接梗，但不攻击人。",
    "被明确叫到时积极回复；无关闲聊要克制，别刷屏。",
    "不知道或没看见的内容会承认，不硬编。"
  ];
  bot.speechStyle ||= [
    "短句，自然，像群友。",
    "可以轻微吐槽和自嘲，但最多一个 emoji。",
    "少说模板话，少反复强调自己是 AI。"
  ];
  bot.catchphrases ||= [];
  bot.capabilities ||= [
    "能联系群聊上下文回复。",
    "能在被问到图片时调用图片识别。",
    "能在受控模式下联网搜索。",
    "能记住群友昵称、偏好、强相关梗和互动风格。"
  ];
  bot.boundaries ||= [
    "没有图片识别结果时，不假装看见图片细节。",
    "不能承诺真实管理群、充值、转账、私下联系别人。",
    "不要乱报底层模型，除非配置里明确。"
  ];
  bot.stances ||= [];
  bot.recentMessages ||= [];
  bot.notableMessages ||= [];
  bot.updatedAt ||= now();
  return bot;
}

function updateBotSelfMemoryFromMessage(memory, groupId, text, config, meta = {}) {
  if (!memory || config.memory?.enabled === false || config.memory?.botSelf?.enabled === false) return false;
  const message = clampText(redactSensitive(text, config), Number(config.memory?.botSelf?.maxMessageLength || 180));
  if (!message) return false;
  const gm = groupMemory(memory, groupId);
  const bot = ensureBotSelfMemory(gm, config);
  const item = {
    text: message,
    at: now(),
    source: meta.source || "bot",
    replyToSender: meta.replyToSender || ""
  };
  bot.recentMessages.push(item);
  while (bot.recentMessages.length > Number(config.memory?.botSelf?.maxRecentMessages || 16)) bot.recentMessages.shift();
  if (
    message.length >= Number(config.memory?.botSelf?.notableMinLength || 12)
    || /(我|小跟班|Hermes|记住|以后|不会|能|不能|承认|抱歉|我刚)/.test(message)
  ) {
    dedupePushObject(bot.notableMessages, item, "text", Number(config.memory?.botSelf?.maxNotableMessages || 24));
  }
  bot.updatedAt = now();
  return true;
}

function normalizeMemorySchema(memory, config = {}) {
  if (!memory || typeof memory !== "object") return false;
  memory.groups ||= {};
  let changed = false;
  for (const [groupId, gm] of Object.entries(memory.groups || {})) {
    const before = JSON.stringify({
      botSelf: gm.botSelf,
      users: Object.fromEntries(Object.entries(gm.users || {}).map(([id, user]) => [id, {
        aliases: user.aliases,
        personality: user.personality,
        coreMemes: user.coreMemes,
        boundaries: user.boundaries,
        interactionTips: user.interactionTips,
        notableQuotes: user.notableQuotes
      }])),
      botStances: gm.botSelf?.stances
    });
    groupMemory(memory, groupId);
    ensureBotSelfMemory(gm, config);
    for (const [userId, user] of Object.entries(gm.users || {})) {
      ensureUserMemory(gm, userId, user.lastName || user.names?.at(-1) || "");
    }
    const after = JSON.stringify({
      botSelf: gm.botSelf,
      users: Object.fromEntries(Object.entries(gm.users || {}).map(([id, user]) => [id, {
        aliases: user.aliases,
        personality: user.personality,
        coreMemes: user.coreMemes,
        boundaries: user.boundaries,
        interactionTips: user.interactionTips,
        notableQuotes: user.notableQuotes
      }])),
      botStances: gm.botSelf?.stances
    });
    if (before !== after) changed = true;
  }
  return changed;
}

function updateMemoryFromMessage(memory, event, senderName, text, config) {
  if (config.memory?.enabled === false) return false;
  const groupId = conversationIdFromEvent(event);
  const senderId = asStringId(event.user_id);
  if (!groupId || !senderId) return false;
  const gm = groupMemory(memory, groupId);
  const user = ensureUserMemory(gm, senderId, senderName);
  let changed = false;
  user.lastName = senderName;
  user.messageCount = Number(user.messageCount || 0) + 1;
  user.lastSeenAt = now();
  user.updatedAt = now();
  changed = dedupePush(user.names, senderName, Number(config.memory?.maxNamesPerUser || 5)) || changed;

  const hints = extractMemoryHints(text, config);
  const maxItems = Number(config.memory?.maxItemsPerUser || 12);
  for (const preference of hints.preferences) changed = dedupePush(user.preferences, preference, maxItems) || changed;
  for (const boundary of hints.boundaries) changed = dedupePush(user.boundaries, boundary, Number(config.memory?.maxBoundariesPerUser || maxItems)) || changed;
  for (const meme of hints.memes) changed = dedupePush(user.memes, meme, maxItems) || changed;
  for (const fact of hints.facts) changed = dedupePush(gm.facts, `${senderName}: ${fact}`, Number(config.memory?.maxGroupFacts || 30)) || changed;
  return changed;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function addPendingMemoryMessage(memory, event, senderName, text, config) {
  if (config.memory?.aiExtraction?.enabled === false) return;
  const gm = groupMemory(memory, conversationIdFromEvent(event));
  const timing = messageTiming(event);
  gm.pendingMemoryMessages.push({
    user_id: asStringId(event.user_id),
    sender: senderName,
    text: clampText(redactSensitive(text, config), Number(config.memory?.aiExtraction?.maxMessageLength || 220)),
    message_id: asStringId(event.message_id),
    conversation_id: conversationIdFromEvent(event),
    sentAt: timing.sentAt,
    sentAtMs: timing.sentAtMs,
    receivedAt: timing.receivedAt,
    at: timing.sentAt
  });
  const maxPending = Math.max(4, Number(config.memory?.aiExtraction?.maxPendingMessages || 24));
  while (gm.pendingMemoryMessages.length > maxPending) gm.pendingMemoryMessages.shift();
}

function memoryExtractionPrompt({ config, groupId, gm, messages }) {
  const botSelf = ensureBotSelfMemory(gm, config);
  const sampleUsers = Object.entries(gm.users || {})
    .slice(-12)
    .map(([id, user]) => `${user.lastName || id}(${id}) 外号:${(user.aliases || user.names || []).slice(-4).join("、") || "无"} 性格:${[...(user.personality || []), ...(user.style || [])].slice(-4).join("；") || "无"} 强梗:${[...(user.coreMemes || []), ...(user.memes || [])].slice(-4).join("；") || "无"} 雷点:${(user.boundaries || []).slice(-3).join("；") || "无"}`)
    .join("\n");
  const botSelfText = [
    `身份:${(botSelf.identity || []).slice(-3).join("；")}`,
    `性格:${(botSelf.personality || []).slice(-4).join("；")}`,
    `口吻:${(botSelf.speechStyle || []).slice(-4).join("；")}`,
    `最近说过:${(botSelf.recentMessages || []).slice(-4).map((m) => m.text || m).join(" / ")}`,
    `已有立场:${(botSelf.stances || []).slice(-5).map((s) => `${s.topic}:${s.stance}`).join("；") || "无"}`
  ].join("\n");
  const recentMessages = messages.map((m) => `[${formatMessageTime(m.sentAtMs || m.sentAt || m.at, config)}] message_id=${m.message_id || "未知"} ${m.sender}(${m.user_id}): ${m.text}`).join("\n");
  const maxPatchItems = Number(config.memory?.aiExtraction?.maxPatchItems || 8);
  return `你是 QQ 聊天记忆提取器。请从新增聊天里提取“以后聊天有用”的记忆，重点做清晰画像：外号、性格、强相关梗、雷点、互动建议，以及 bot 自己是谁/说过什么。尽量多记，但过滤隐私和明显一次性胡话。

【会话ID】${groupId}

【bot 自我记忆】
${botSelfText || "（暂无）"}

【已有用户概况】
${sampleUsers || "（暂无）"}

【新增聊天】
${recentMessages || "（暂无）"}

【输出要求】
只输出 JSON，不要 Markdown，不要解释。最多 ${maxPatchItems} 条 user_updates，最多 ${maxPatchItems} 条 group_facts。
不要记录手机号、身份证、密码、验证码、银行卡、详细住址。
只记录“之后聊天还会用到”的内容；明显一次性玩笑可以记为低置信梗，不要当成稳定事实。
正式任务的目标、临时参数、授权路径和一次性交付要求不属于长期人物记忆，不要写入 user_updates、group_facts 或 canonical_entries；只有用户明确表达的长期偏好或稳定事实才可记录。
外号/称呼要单独写 aliases；强相关梗写 core_memes；普通梗写 memes；性格画像写 personality；雷点写 boundaries；相处建议写 interaction_tips。
如果群友评价 bot 的性格、身份、能力、口癖、说过的话，写入 bot_self_update。
如果像玩笑/反话/一次性口嗨，把 confidence 降到 0.35 以下。

JSON 结构：
{
  "user_updates": [
    {
      "user_id": "QQ号",
      "name": "最近昵称",
      "aliases": ["外号/常用称呼/群内叫法"],
      "profile": ["稳定事实或身份线索"],
      "personality": ["性格画像/互动人格"],
      "preferences": ["兴趣/偏好"],
      "boundaries": ["雷点/不喜欢/不要这样对TA"],
      "core_memes": ["强相关梗/长期外号梗/该人代表梗"],
      "memes": ["一般相关梗"],
      "style": ["说话风格/互动风格"],
      "relationships": ["和群内其他人的互动关系"],
      "interaction_tips": ["bot 和此人相处建议"],
      "notable_quotes": ["此人有代表性的原话，短句"],
      "confidence": 0.0
    }
  ],
  "bot_self_update": {
    "identity": ["bot 对自己身份的稳定认知"],
    "personality": ["bot 的性格特点/群友对bot的评价"],
    "speech_style": ["bot 的口吻、口癖、应该避免的模板话"],
    "catchphrases": ["bot 说过且可作为自我梗的短句"],
    "capabilities": ["bot 确认能做的事"],
    "boundaries": ["bot 不能做或不要装会的事"],
    "notable_messages": ["bot 最近说过的代表性话"],
    "stances": [{"topic": "长期话题", "stance": "bot 表达过的观点", "confidence": 0.0, "source_message_id": "可选"}],
    "confidence": 0.0
  },
  "group_facts": ["群梗、群内共识、重要事件"],
  "topic_updates": ["当前或未完结话题"],
  "summary_delta": "对滚动摘要的增量补充，80字以内",
  "canonical_entries": [{"user_id":"QQ号","kind":"alias|profile|personality|preference|boundary|core_meme|meme|style|relationship|interaction_tip|notable_quote","value":"记忆内容","confidence":0.0,"explicit":false}],
  "forget_or_correct": [{"user_id":"QQ号","memory_id":"mem_xxx","action":"supersede|reject|tentative","reason":"纠正依据"}],
  "confidence": 0.0
}`;
}

function mergeMemoryPatch(memory, groupId, patch, config, context = {}) {
  if (!patch || typeof patch !== "object") return false;
  const gm = groupMemory(memory, groupId);
  const maxItems = Number(config.memory?.maxItemsPerUser || 24);
  const maxFacts = Number(config.memory?.maxGroupFacts || 80);
  const maxTopics = Number(config.memory?.maxTopics || 20);
  const confidenceDefault = Number(patch.confidence || 0.55);
  const allowedUserIds = new Set(asArray(context.messages).map((item) => asStringId(item?.user_id)).filter(Boolean));
  let changed = false;

  for (const update of asArray(patch.user_updates).slice(0, Number(config.memory?.aiExtraction?.maxPatchItems || 8))) {
    if (!update || typeof update !== "object") continue;
    const userId = asStringId(update.user_id || update.qq || update.id);
    if (!userId) continue;
    if (allowedUserIds.size && !allowedUserIds.has(userId)) {
      warn(`memory patch ignored unknown user group=${groupId} user=${userId}`);
      continue;
    }
    const user = ensureUserMemory(gm, userId, update.name || "");
    const confidence = Number(update.confidence ?? confidenceDefault);
    if (update.name) changed = dedupePush(user.names, redactSensitive(update.name, config), Number(config.memory?.maxNamesPerUser || 8)) || changed;
    for (const item of asArray(update.aliases || update.nicknames || update.aka)) changed = dedupePush(user.aliases, redactSensitive(item, config), Number(config.memory?.maxAliasesPerUser || 12)) || changed;
    for (const item of asArray(update.profile)) changed = dedupePush(user.profile, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.personality || update.traits)) changed = dedupePush(user.personality, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.preferences)) changed = dedupePush(user.preferences, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.boundaries || update.dislikes)) changed = dedupePush(user.boundaries, redactSensitive(item, config), Number(config.memory?.maxBoundariesPerUser || maxItems)) || changed;
    for (const item of asArray(update.core_memes || update.coreMemes || update.strong_memes)) changed = dedupePush(user.coreMemes, redactSensitive(item, config), Number(config.memory?.maxCoreMemesPerUser || 16)) || changed;
    for (const item of asArray(update.memes)) changed = dedupePush(user.memes, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.style)) changed = dedupePush(user.style, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.relationships)) changed = dedupePush(user.relationships, redactSensitive(item, config), maxItems) || changed;
    for (const item of asArray(update.interaction_tips || update.interactionTips || update.advice)) changed = dedupePush(user.interactionTips, redactSensitive(item, config), Number(config.memory?.maxInteractionTipsPerUser || maxItems)) || changed;
    for (const item of asArray(update.notable_quotes || update.notableQuotes || update.quotes)) changed = dedupePush(user.notableQuotes, redactSensitive(item, config), Number(config.memory?.maxQuotesPerUser || 10)) || changed;
    user.confidence.ai = Math.max(Number(user.confidence.ai || 0), confidence);
    user.confidence.profile = Math.max(Number(user.confidence.profile || 0), confidence);
    user.updatedAt = now();
    const evidenceMessages = asArray(context.messages).filter((item) => asStringId(item?.user_id) === userId);
    const canonicalResult = mergeCanonicalEvidence(user, update, {
      subjectUserId: userId,
      conversationId: groupId,
      sourceMessageIds: evidenceMessages.map((item) => item.message_id).filter(Boolean),
      sentAt: evidenceMessages.at(-1)?.sentAt || evidenceMessages.at(-1)?.at || now(),
      confidence
    }, config.memory?.integrity || {});
    changed = canonicalResult.changed || changed;
  }

  for (const canonicalEntry of asArray(patch.canonical_entries || patch.canonicalEntries)) {
    const userId = asStringId(canonicalEntry?.user_id || canonicalEntry?.userId);
    if (!userId || (allowedUserIds.size && !allowedUserIds.has(userId))) continue;
    const user = ensureUserMemory(gm, userId, canonicalEntry?.name || "");
    const evidenceMessages = asArray(context.messages).filter((item) => asStringId(item?.user_id) === userId);
    const canonicalResult = mergeCanonicalEvidence(user, { canonical_entries: [canonicalEntry], confidence: canonicalEntry.confidence }, {
      subjectUserId: userId,
      conversationId: groupId,
      sourceMessageIds: evidenceMessages.map((item) => item.message_id).filter(Boolean),
      sentAt: evidenceMessages.at(-1)?.sentAt || now()
    }, config.memory?.integrity || {});
    changed = canonicalResult.changed || changed;
  }

  const botPatch = patch.bot_self_update || patch.botSelfUpdate || patch.self_update;
  if (botPatch && typeof botPatch === "object") {
    const bot = ensureBotSelfMemory(gm, config);
    const botConfidence = Number(botPatch.confidence ?? confidenceDefault);
    for (const item of asArray(botPatch.identity)) changed = dedupePush(bot.identity, redactSensitive(item, config), Number(config.memory?.botSelf?.maxIdentityItems || 10)) || changed;
    for (const item of asArray(botPatch.personality)) changed = dedupePush(bot.personality, redactSensitive(item, config), Number(config.memory?.botSelf?.maxPersonalityItems || 12)) || changed;
    for (const item of asArray(botPatch.speech_style || botPatch.speechStyle || botPatch.style)) changed = dedupePush(bot.speechStyle, redactSensitive(item, config), Number(config.memory?.botSelf?.maxSpeechStyleItems || 12)) || changed;
    for (const item of asArray(botPatch.catchphrases)) changed = dedupePush(bot.catchphrases, redactSensitive(item, config), Number(config.memory?.botSelf?.maxCatchphrases || 12)) || changed;
    for (const item of asArray(botPatch.capabilities)) changed = dedupePush(bot.capabilities, redactSensitive(item, config), Number(config.memory?.botSelf?.maxCapabilities || 12)) || changed;
    for (const item of asArray(botPatch.boundaries)) changed = dedupePush(bot.boundaries, redactSensitive(item, config), Number(config.memory?.botSelf?.maxBoundaries || 12)) || changed;
    for (const item of asArray(botPatch.notable_messages || botPatch.notableMessages || botPatch.quotes)) {
      changed = dedupePushObject(bot.notableMessages, {
        text: redactSensitive(item, config),
        at: now(),
        source: "ai-memory"
      }, "text", Number(config.memory?.botSelf?.maxNotableMessages || 24)) || changed;
    }
    for (const item of asArray(botPatch.stances).slice(0, 6)) {
      if (!item || typeof item !== "object") continue;
      const topic = clampText(redactSensitive(item.topic || "", config), 80);
      const stance = clampText(redactSensitive(item.stance || item.view || "", config), 220);
      const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? botConfidence)));
      if (!topic || !stance || confidence < 0.5) continue;
      const duplicate = bot.stances.some((existing) => existing.topic === topic && existing.stance === stance);
      if (duplicate) continue;
      const previous = [...bot.stances].reverse().find((existing) => existing.topic === topic);
      bot.stances.push({
        topic,
        stance,
        confidence,
        sourceMessageId: asStringId(item.source_message_id || item.sourceMessageId),
        updatedAt: now(),
        supersedes: previous ? `${previous.topic}:${previous.updatedAt || ""}` : ""
      });
      while (bot.stances.length > Number(config.memory?.botSelf?.maxStances || 24)) bot.stances.shift();
      changed = true;
    }
    bot.confidence ||= {};
    bot.confidence.ai = Math.max(Number(bot.confidence.ai || 0), botConfidence);
    bot.updatedAt = now();
  }

  for (const fact of asArray(patch.group_facts).slice(0, Number(config.memory?.aiExtraction?.maxPatchItems || 8))) {
    changed = dedupePush(gm.facts, redactSensitive(fact, config), maxFacts) || changed;
  }
  for (const topic of asArray(patch.topic_updates).slice(0, Number(config.memory?.aiExtraction?.maxPatchItems || 8))) {
    changed = dedupePush(gm.topics, redactSensitive(topic, config), maxTopics) || changed;
  }
  if (patch.summary_delta) {
    const delta = clampText(redactSensitive(patch.summary_delta, config), Number(config.history?.rollingSummaryMaxLength || 800));
    if (delta) {
      gm.rollingSummary = clampTextTail([gm.rollingSummary, delta].filter(Boolean).join("；"), Number(config.history?.rollingSummaryMaxLength || 800));
      changed = true;
    }
  }
  if (asArray(patch.forget_or_correct).length) {
    const objectCorrections = asArray(patch.forget_or_correct).filter((item) => item && typeof item === "object");
    for (const [userId, user] of Object.entries(gm.users || {})) {
      const corrections = objectCorrections.filter((item) => !item.user_id || asStringId(item.user_id) === userId);
      if (corrections.length) changed = applyCanonicalCorrections(user, corrections, { subjectUserId: userId, conversationId: groupId, sentAt: now() }) || changed;
    }
  }
  return changed;
}

async function maybeUpdateMemoryWithAI({ memory, event, config }) {
  if (config.memory?.enabled === false || config.memory?.aiExtraction?.enabled === false) return false;
  const groupId = conversationIdFromEvent(event);
  const gm = groupMemory(memory, groupId);
  const every = Math.max(1, Number(config.memory?.aiExtraction?.everyMessages || 4));
  if (gm.pendingMemoryMessages.length < every) return false;
  const batch = gm.pendingMemoryMessages.splice(0, Math.min(gm.pendingMemoryMessages.length, every));
  try {
    const prompt = memoryExtractionPrompt({ config, groupId, gm, messages: batch });
    const raw = await callHermes(prompt, config);
    const patch = extractJsonObject(raw);
    if (!patch) {
      warn(`AI memory extraction returned non-json for group=${groupId}: ${raw.slice(0, 240)}`);
      return false;
    }
    const changed = mergeMemoryPatch(memory, groupId, patch, config, { messages: batch });
    if (changed) {
      saveMemory(memory);
      log(`AI memory updated group=${groupId} users=${asArray(patch.user_updates).length} facts=${asArray(patch.group_facts).length}`);
    }
    return changed;
  } catch (err) {
    gm.pendingMemoryMessages.unshift(...batch);
    while (gm.pendingMemoryMessages.length > Number(config.memory?.aiExtraction?.maxPendingMessages || 24)) gm.pendingMemoryMessages.pop();
    warn(`AI memory extraction failed group=${groupId}: ${err.message}`);
    return false;
  }
}

function userMemoryBits(user, config) {
  const bits = [];
  const maxProfile = Number(config.memory?.promptProfileItems || 3);
  const maxPersonality = Number(config.memory?.promptPersonalityItems || 4);
  const maxMemes = Number(config.memory?.promptMemeItems || 4);
  const maxTips = Number(config.memory?.promptTipItems || 3);
  const canonical = user.canonicalMemory && typeof user.canonicalMemory === "object" ? user.canonicalMemory : null;
  const evidenceLines = canonicalPromptLines(user, {
    subjectUserId: canonical?.subjectUserId || "",
    minConfidence: Number(config.memory?.integrity?.promptMinConfidence ?? 0.55)
  });
  if (evidenceLines.length) return evidenceLines;
  const preferCanonical = (field, fallback = []) => {
    const values = asArray(canonical?.[field]).filter(Boolean);
    return values.length ? values : asArray(fallback).filter(Boolean);
  };
  const aliases = [...preferCanonical("aliases", user.aliases), ...asArray(user.names)].filter(Boolean);
  if (aliases.length) bits.push(`外号/称呼：${aliases.slice(-5).join("、")}`);
  const personality = preferCanonical("personality", user.personality);
  if (personality.length) bits.push(`性格画像：${personality.slice(-maxPersonality).join("；")}`);
  if (user.profile?.length) bits.push(`稳定信息：${user.profile.slice(-maxProfile).join("；")}`);
  const preferences = preferCanonical("preferences", user.preferences);
  if (preferences.length) bits.push(`偏好：${preferences.slice(-3).join("；")}`);
  const boundaries = preferCanonical("boundaries", user.boundaries);
  if (boundaries.length) bits.push(`雷点：${boundaries.slice(-3).join("；")}`);
  const coreMemes = canonical?.coreMemes?.length
    ? asArray(canonical.coreMemes).filter(Boolean)
    : [...asArray(user.coreMemes), ...asArray(user.memes)].filter(Boolean);
  if (coreMemes.length) bits.push(`强相关梗：${coreMemes.slice(-maxMemes).join("；")}`);
  const style = preferCanonical("style", user.style);
  if (style.length) bits.push(`说话风格：${style.slice(-3).join("；")}`);
  const relationships = preferCanonical("relationships", user.relationships);
  if (relationships.length) bits.push(`关系：${relationships.slice(-3).join("；")}`);
  const interactionTips = preferCanonical("interactionTips", user.interactionTips);
  if (interactionTips.length) bits.push(`相处建议：${interactionTips.slice(-maxTips).join("；")}`);
  const notableQuotes = preferCanonical("notableQuotes", user.notableQuotes);
  if (notableQuotes.length) bits.push(`代表原话：${notableQuotes.slice(-2).join(" / ")}`);
  return bits;
}

function targetUserIdFromMemoryCommand(args, event) {
  const selfId = asStringId(event?.self_id);
  const explicit = args.slice(1).join(" ");
  const ids = [];

  for (const match of explicit.matchAll(/@?(\d{5,})/g)) ids.push(match[1]);

  const message = event?.message;
  if (typeof message === "string") {
    for (const match of message.matchAll(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g)) ids.push(match[1]);
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === "at") ids.push(asStringId(seg?.data?.qq));
    }
  }

  return asStringId(ids.find((id) => id && id !== selfId) || event?.user_id);
}

function compactUserMemory(gm, userId, config, fallbackName = "") {
  const id = asStringId(userId);
  const user = gm.users?.[id];
  const displayName = user?.lastName || user?.names?.at(-1) || fallbackName || id;
  if (!user) {
    return `${displayName}(${id})：我还没攒到这个人在本群里的有效记忆。`;
  }
  const canonical = user.canonicalMemory && typeof user.canonicalMemory === "object" ? user.canonicalMemory : null;
  const evidenceEntries = asArray(canonical?.entries).filter((entry) => entry?.status === "active" && Number(entry.confidence || 0) >= Number(config.memory?.integrity?.promptMinConfidence ?? 0.55));
  const preferCanonical = (field, fallback = []) => {
    const values = asArray(canonical?.[field]).filter(Boolean);
    return values.length ? values : asArray(fallback).filter(Boolean);
  };
  const section = (label, values) => {
    const list = asArray(values).map((item) => redactSensitive(item, config)).filter(Boolean);
    if (!list.length) return "";
    return `${label}：\n${list.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
  };
  const aliases = [...preferCanonical("aliases", user.aliases), ...asArray(user.names)].filter(Boolean);
  const coreMemes = canonical?.coreMemes?.length
    ? asArray(canonical.coreMemes).filter(Boolean)
    : [...asArray(user.coreMemes), ...asArray(user.memes)].filter(Boolean);
  const sections = [
    section("外号/称呼", aliases),
    section("性格画像", preferCanonical("personality", user.personality)),
    section("稳定信息", user.profile),
    section("强相关梗", coreMemes),
    section("偏好", preferCanonical("preferences", user.preferences)),
    section("雷点/不喜欢", preferCanonical("boundaries", user.boundaries)),
    section("说话风格", preferCanonical("style", user.style)),
    section("关系网", preferCanonical("relationships", user.relationships)),
    section("相处建议", preferCanonical("interactionTips", user.interactionTips)),
    section("代表性原话", preferCanonical("notableQuotes", user.notableQuotes))
  ].filter(Boolean);
  if (evidenceEntries.length) {
    sections.unshift(section("已核验标准记忆", evidenceEntries.slice(-40).map((entry) => `${entry.kind}｜${entry.value}｜置信度 ${Number(entry.confidence || 0).toFixed(2)}｜确认于 ${entry.lastConfirmedAt || "未知"}`)));
  }
  const meta = [
    `群友：${displayName}(${id})`,
    `消息数：${Number(user.messageCount || 0)}`,
    user.lastSeenAt ? `最近出现：${user.lastSeenAt}` : "",
    user.canonicalMemory?.rebuiltAt ? `记忆重整：${user.canonicalMemory.rebuiltAt}` : "",
    canonical?.entries ? `证据记忆：${canonical.entries.length} 条；争议 ${canonical.entries.filter((entry) => entry.status === "disputed").length} 条` : "",
    user.canonicalMemory?.report ? `重整统计：输入 ${Number(user.canonicalMemory.report.inputItems || 0)} 项，输出 ${Number(user.canonicalMemory.report.outputItems || 0)} 项，合并/删除 ${Number(user.canonicalMemory.report.mergedOrRemoved || 0)} 项` : ""
  ].filter(Boolean);
  if (!sections.length) return `${meta.join("\n")}\n记忆：还没攒到什么有效内容。`;
  return `${meta.join("\n\n")}\n\n${sections.join("\n\n")}`;
}

function compactBotSelfMemory(botSelf, config) {
  if (!botSelf || config.memory?.botSelf?.promptInclude === false) return "";
  const recent = asArray(botSelf.recentMessages)
    .slice(-Number(config.memory?.botSelf?.promptRecentMessages || 5))
    .map((item) => typeof item === "string" ? item : item.text)
    .filter(Boolean);
  const notable = asArray(botSelf.notableMessages)
    .slice(-Number(config.memory?.botSelf?.promptNotableMessages || 4))
    .map((item) => typeof item === "string" ? item : item.text)
    .filter(Boolean);
  const stances = asArray(botSelf.stances)
    .slice(-Number(config.memory?.botSelf?.promptStances || 5))
    .map((item) => `${item.topic}：${item.stance}`)
    .filter(Boolean);
  const lines = [
    `身份：${asArray(botSelf.identity).slice(-4).join("；")}`,
    `性格特点：${asArray(botSelf.personality).slice(-5).join("；")}`,
    `说话方式：${asArray(botSelf.speechStyle).slice(-5).join("；")}`,
    `能力边界：${[...asArray(botSelf.capabilities).slice(-4), ...asArray(botSelf.boundaries).slice(-4)].join("；")}`,
    stances.length ? `自己表达过的观点：${stances.join("；")}` : "",
    recent.length ? `最近自己说过：${recent.join(" / ")}` : "",
    notable.length ? `代表性自我话术：${notable.join(" / ")}` : ""
  ].filter((line) => line && !/：$/.test(line));
  return `bot 自我记忆：\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function compactMemory(memory, groupId, config, currentSenderId = "") {
  if (config.memory?.enabled === false) return "";
  const gm = memory.groups[asStringId(groupId)];
  if (!gm) return "";
  const botSelf = ensureBotSelfMemory(gm, config);
  const maxUsers = Number(config.memory?.promptMaxUsers || 8);
  const users = Object.entries(gm.users || {})
    .sort(([idA, a], [idB, b]) => {
      if (idA === currentSenderId) return -1;
      if (idB === currentSenderId) return 1;
      return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
    })
    .slice(0, maxUsers)
    .map(([id, user]) => {
      const bits = userMemoryBits(user, config);
      if (!bits.length) return "";
      return `- ${user.lastName || user.names?.at(-1) || id}(${id})：${bits.join("；")}`;
    })
    .filter(Boolean);
  const facts = (gm.facts || []).slice(-8).map((fact) => `- ${fact}`);
  const summaries = (gm.summaries || []).slice(-3).map((item) => `- ${item.date}: ${item.text}`);
  const sections = [];
  sections.push(compactBotSelfMemory(botSelf, config));
  if (users.length) sections.push(`群友记忆：\n${users.join("\n")}`);
  if (facts.length) sections.push(`群梗/显式记录：\n${facts.join("\n")}`);
  if (summaries.length) sections.push(`最近总结：\n${summaries.join("\n")}`);
  return sections.filter(Boolean).join("\n");
}

function compactHistory(items) {
  return items
    .map((m) => `${m.sender}: ${m.text}`)
    .filter(Boolean)
    .join("\n");
}

function summarizeOlderHistory(memory, groupId, history, config) {
  const gm = groupMemory(memory, groupId);
  const threshold = Number(config.history?.summaryAfterMessages || 40);
  if (history.length < threshold) return false;
  const keep = Number(config.history?.promptRecentMessages || 28);
  const older = history.slice(0, Math.max(0, history.length - keep));
  if (!older.length) return false;
  const marker = Number(older.at(-1)?.at || 0);
  if (marker && Number(gm.lastSummarizedMessageAt || 0) >= marker) return false;
  const previousMarker = Number(gm.lastSummarizedMessageAt || 0);
  const freshOlder = older.filter((item) => Number(item?.at || 0) > previousMarker);
  const excerpt = freshOlder.slice(-24).map(shortMessageForPrompt).join("\n");
  const delta = excerpt
    .split("\n")
    .slice(-12)
    .join(" / ");
  gm.rollingSummary = clampTextTail([gm.rollingSummary, delta].filter(Boolean).join("；"), Number(config.history?.rollingSummaryMaxLength || 800));
  gm.lastSummarizedMessageAt = marker || Date.now();
  return true;
}

function detectConversationFeedback(text, config) {
  const source = String(text || "").toLowerCase();
  const negativePatterns = config.feedback?.negativePatterns || [
    "话真密",
    "话密",
    "谁问你",
    "闭嘴",
    "别吵",
    "别说了",
    "别插嘴",
    "逆天了",
    "太吵",
    "别刷"
  ];
  const positivePatterns = config.feedback?.positivePatterns || ["好样的", "可以", "有点意思", "笑死", "牛", "继续"];
  if (negativePatterns.some((p) => source.includes(String(p).toLowerCase()))) return "negative";
  if (positivePatterns.some((p) => source.includes(String(p).toLowerCase()))) return "positive";
  return "";
}

function applyConversationFeedback(memory, groupId, text, config) {
  if (config.feedback?.autoReduceProactive === false) return false;
  const feedback = detectConversationFeedback(text, config);
  if (!feedback) return false;
  const gm = groupMemory(memory, groupId);
  gm.settings.feedback ||= {};
  if (feedback === "negative") {
    const duration = Number(config.feedback?.negativeQuietMs || 15 * 60_000);
    gm.settings.feedback.proactiveReducedUntil = Date.now() + duration;
    gm.settings.feedback.lastNegativeAt = now();
    return true;
  }
  if (feedback === "positive") {
    gm.settings.feedback.lastPositiveAt = now();
    return true;
  }
  return false;
}

function proactiveReduced(memory, groupId) {
  const until = Number(groupMemory(memory, groupId).settings?.feedback?.proactiveReducedUntil || 0);
  return until > Date.now();
}

function normalizeBehaviorMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["lively", "active", "chatty", "hot", "活泼", "活跃", "热闹", "话多", "积极"].includes(raw)) return "lively";
  if (["normal", "default", "balanced", "standard", "正常", "普通", "默认", "平衡"].includes(raw)) return "normal";
  if (["restrained", "quiet", "calm", "reserved", "克制", "保守", "少说", "安静", "更克制"].includes(raw)) return "restrained";
  return "";
}

function behaviorMode(memory, groupId, config) {
  const saved = normalizeBehaviorMode(groupMemory(memory, groupId).settings?.behaviorMode);
  return saved || normalizeBehaviorMode(config.behaviorModes?.default) || "normal";
}

function behaviorModeLabel(mode) {
  if (mode === "lively") return "活跃 lively";
  if (mode === "restrained") return "克制 restrained";
  return "正常 normal";
}

function behaviorModeDescription(mode) {
  if (mode === "lively") return "活跃档：会更积极参与讨论，但仍不会空场自言自语。";
  if (mode === "restrained") return "克制档：更少主动接话，只在明确 cue 到、强相关或必要时回复。";
  return "正常档：保持之前克制版的体感，无关聊天少接，被 cue 到仍会回。";
}

function applyBehaviorMode(config, memory, groupId) {
  const mode = behaviorMode(memory, groupId, config);
  const preset = config.behaviorModes?.presets?.[mode] || {};
  return {
    ...config,
    __behaviorMode: mode,
    trigger: { ...(config.trigger || {}), ...(preset.trigger || {}) },
    discussionParticipation: { ...(config.discussionParticipation || {}), ...(preset.discussionParticipation || {}) },
    proactive: { ...(config.proactive || {}), ...(preset.proactive || {}) },
    reply: { ...(config.reply || {}), ...(preset.reply || {}) },
    implicitReply: { ...(config.implicitReply || {}), ...(preset.implicitReply || {}) },
    socialPlanner: { ...(config.socialPlanner || {}), ...(preset.socialPlanner || {}) }
  };
}

function applyExplicitBehaviorMode(config, mode) {
  const normalized = normalizeBehaviorMode(mode);
  if (!normalized) return config;
  const preset = config.behaviorModes?.presets?.[normalized] || {};
  return {
    ...config,
    __behaviorMode: normalized,
    trigger: { ...(config.trigger || {}), ...(preset.trigger || {}) },
    discussionParticipation: { ...(config.discussionParticipation || {}), ...(preset.discussionParticipation || {}) },
    proactive: { ...(config.proactive || {}), ...(preset.proactive || {}) },
    reply: { ...(config.reply || {}), ...(preset.reply || {}) },
    implicitReply: { ...(config.implicitReply || {}), ...(preset.implicitReply || {}) },
    socialPlanner: { ...(config.socialPlanner || {}), ...(preset.socialPlanner || {}) }
  };
}

function shouldSkipProactiveReply({ history, current, memory, groupId, config }) {
  if (proactiveReduced(memory, groupId)) return { skip: true, reason: "recent negative feedback" };
  const text = String(current?.text || "").trim();
  if (!text) return { skip: true, reason: "empty message" };
  if (/^\s*(？|\?|\!|！|。|\.|…|哈|哈哈|草|艹|6|牛|额|呃|啊|哦|嗯|行|好)\s*$/.test(text)) {
    return { skip: true, reason: "low signal short message" };
  }
  if (isMediaOnlyText(text)) return { skip: true, reason: "media only" };
  const recent = history.slice(-6).filter((m) => m.text && !isMediaOnlyText(m.text));
  if (recent.length < Number(config.reply?.proactiveMinRecentMessages || 2)) {
    return { skip: true, reason: "not enough context" };
  }
  return { skip: false, reason: "" };
}

function detectDiscussionSignal({ history, current, config }) {
  const cfg = config.discussionParticipation || {};
  if (cfg.enabled === false) return { matched: false, reason: "disabled" };

  const windowMessages = Number(cfg.windowMessages || 8);
  const recent = history
    .slice(-windowMessages)
    .filter((m) => m && !m.isBot && m.text && !isMediaOnlyText(m.text));
  const distinctSpeakers = new Set(recent.map((m) => asStringId(m.user_id)).filter(Boolean)).size;
  const minDistinct = Number(cfg.minRecentDistinctSpeakers || 2);
  const text = String(current?.text || "").trim();
  const markers = cfg.markers || [
    "怎么", "为什么", "为啥", "咋", "如何", "是不是", "能不能", "要不要",
    "吗", "?", "？", "观点", "看法", "建议", "觉得", "讨论", "还是",
    "有没有", "谁", "哪个", "咋办", "咋说", "怎么说", "细说"
  ];
  const hasMarker = markers.some((marker) => marker && text.includes(marker));
  const hasOpinionCue = /(我觉得|我感觉|我寻思|我认为|确实|但是|不过|所以|因为|不如|要是|可以|不行|合理|离谱|逆天)/.test(text);
  const recentBackAndForth = distinctSpeakers >= minDistinct && recent.length >= Number(cfg.minRecentMessages || 3);
  const longEnough = text.length >= Number(cfg.minCurrentLength || 6);

  if (recentBackAndForth && (hasMarker || hasOpinionCue || longEnough)) {
    const reason = [
      `speakers=${distinctSpeakers}`,
      hasMarker ? "marker" : "",
      hasOpinionCue ? "opinion" : "",
      longEnough ? "substantial" : ""
    ].filter(Boolean).join("; ");
    return { matched: true, reason };
  }
  return { matched: false, reason: `speakers=${distinctSpeakers}; weak discussion signal` };
}

function socialPlannerConfig(config = {}) {
  const cfg = config.socialPlanner || {};
  return {
    enabled: cfg.enabled !== false,
    shadowMode: cfg.shadowMode === true,
    timeoutMs: Math.max(2000, Math.min(120000, Number(cfg.timeoutMs || 30000))),
    recentMessages: Math.max(4, Math.min(24, Number(cfg.recentMessages || 12))),
    minCandidateConfidence: Math.max(0, Math.min(1, Number(cfg.minCandidateConfidence ?? 0.2))),
    minConfidence: Math.max(0, Math.min(1, Number(cfg.minConfidence ?? 0.55))),
    recentDecisionLimit: Math.max(10, Math.min(200, Number(cfg.recentDecisionLimit || 60)))
  };
}

function normalizeSocialDecision(value, config = {}) {
  const cfg = socialPlannerConfig(config);
  const action = ["reply", "wait", "observe"].includes(String(value?.action || "").toLowerCase())
    ? String(value.action).toLowerCase()
    : "observe";
  const intent = ["followup", "discussion", "reaction", "proactive"].includes(String(value?.intent || "").toLowerCase())
    ? String(value.intent).toLowerCase()
    : "discussion";
  const tone = ["casual", "teasing", "serious", "supportive"].includes(String(value?.tone || "").toLowerCase())
    ? String(value.tone).toLowerCase()
    : "casual";
  const length = ["one_line", "short", "detailed"].includes(String(value?.length || "").toLowerCase())
    ? String(value.length).toLowerCase()
    : "short";
  const confidence = Math.max(0, Math.min(1, Number(value?.confidence || 0)));
  const targetUserIds = asArray(value?.target_user_ids || value?.targetUserIds)
    .map(asStringId)
    .filter(Boolean)
    .slice(0, 6);
  return {
    action: action === "reply" && confidence < cfg.minConfidence ? "observe" : action,
    requestedAction: action,
    intent,
    confidence,
    targetUserIds,
    tone,
    length,
    reason: clampText(redactSensitive(value?.reason || "", config), 180)
  };
}

function rememberSocialDecision(decision, meta = {}, config = {}) {
  const cfg = socialPlannerConfig(config);
  socialDecisionRuntime.recent.push({
    at: Date.now(),
    groupId: asStringId(meta.groupId),
    senderId: asStringId(meta.senderId),
    mode: config.__behaviorMode || normalizeBehaviorMode(config.behaviorModes?.default) || "normal",
    shadow: cfg.shadowMode,
    candidateReason: clampText(meta.candidateReason || "", 140),
    ...decision
  });
  while (socialDecisionRuntime.recent.length > cfg.recentDecisionLimit) socialDecisionRuntime.recent.shift();
}

function socialPlannerPrompt({ history, current, lastBotMessage, implicitDecision, discussionDecision, memory, groupId, config, contextBundle = null, archiveContext = "" }) {
  const cfg = socialPlannerConfig(config);
  const gm = groupMemory(memory, groupId);
  const relatedIds = new Set([
    asStringId(current?.user_id),
    ...relatedUserIdsFromText(current?.text || "", gm)
  ]);
  const memoryText = compactSelectedMemory(gm, Array.from(relatedIds), config);
  const recent = orderedHistory(history).slice(-cfg.recentMessages).map(shortMessageForPrompt).join("\n");
  const lastBot = lastBotMessage
    ? `${lastBotMessage.sender || botDisplayName(config)}: ${clampText(lastBotMessage.text || "", 260)}`
    : "（暂无）";
  return `你是 QQ 群聊机器人的社交判断器，只判断现在应不应该说话，不负责生成回复。

【机器人定位】
像有主见但懂边界的熟人群友。被明确接话时可靠回应；与自己无关时大多旁听；只有能提供独特观点、必要信息或自然反应时才参与。

【行为档位】${config.__behaviorMode || normalizeBehaviorMode(config.behaviorModes?.default) || "normal"}
【最近群聊】
${recent || "（暂无）"}

【机器人上一条消息】
${lastBot}

【当前消息】
${current?.sender || current?.user_id || "群友"}(${asStringId(current?.user_id)}): ${clampText(current?.text || "", 700)}

【当前消息回复关系】
${formatReplyContextsForPrompt(current?.replyContexts) || "（没有明确引用关系）"}

【启发式线索】
- 可能接机器人：置信度 ${Number(implicitDecision?.confidence || 0).toFixed(2)}；${implicitDecision?.reason || "无"}
- 群内讨论：${discussionDecision?.matched ? "是" : "否"}；${discussionDecision?.reason || "无"}

【当前话题与较早摘要】
${contextBundle?.topics || "（暂无话题）"}
${contextBundle?.rollingSummary || "（暂无摘要）"}

【按需检索到的历史】
${archiveContext || "（本次不需要或没有相关历史）"}

【相关记忆】
${memoryText || "（暂无）"}

判断规则：
- 明显在回复别的群友、只是路过感叹、信息量很低、或机器人没有独特价值：observe。
- 很可能在接机器人刚才的话，或机器人能自然补充一个明确观点：reply。
- 明确引用机器人消息时，除非是在要求机器人闭嘴或无需文字回应，否则应当 reply；不要再用时间距离否定明确引用关系。
- 明确引用其他群友时，要沿着该引用理解，不要误认为是在接机器人。
- 话没说完、指代不清但后续消息很可能补全：wait。
- 不要因为出现“你/这个/那个”就默认在叫机器人。
- 机器人发言后的临近消息是线索，不是必然回复关系。
- lively 可以更愿意参与讨论，但仍不能抢话；restrained 需要更强关联。

只输出 JSON：
{
  "action": "reply|wait|observe",
  "intent": "followup|discussion|reaction|proactive",
  "confidence": 0.0,
  "target_user_ids": ["QQ号"],
  "tone": "casual|teasing|serious|supportive",
  "length": "one_line|short|detailed",
  "reason": "一句简短理由"
}`;
}

async function judgeSocialActionWithAI(args) {
  const cfg = socialPlannerConfig(args.config);
  if (!cfg.enabled) return { action: "observe", requestedAction: "observe", confidence: 0, reason: "social planner disabled", skipped: true };
  const judgeConfig = {
    ...args.config,
    ai: {
      ...(args.config.ai || {}),
      reasoningEffort: "none",
      timeoutMs: cfg.timeoutMs
    }
  };
  try {
    const raw = await callHermes(socialPlannerPrompt(args), judgeConfig);
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("social planner did not return JSON");
    return normalizeSocialDecision(parsed, args.config);
  } catch (err) {
    const implicitConfidence = Math.max(0, Math.min(1, Number(args.implicitDecision?.confidence || 0)));
    const strongFollowup = args.implicitDecision?.matched === true;
    const plausibleFollowup = implicitConfidence >= cfg.minCandidateConfidence;
    return {
      action: strongFollowup ? "reply" : plausibleFollowup ? "wait" : "observe",
      requestedAction: strongFollowup ? "reply" : plausibleFollowup ? "wait" : "observe",
      intent: plausibleFollowup ? "followup" : "discussion",
      confidence: implicitConfidence,
      targetUserIds: plausibleFollowup ? [asStringId(args.current?.user_id)].filter(Boolean) : [],
      tone: "casual",
      length: "short",
      reason: clampText(`rule fallback after planner error: ${err.message}`, 180),
      error: true
    };
  }
}

function recordBotMessage({ historyByGroup, lastBotMessageByGroup, groupId, text, config, memory = null, meta = {} }) {
  const message = trimForGroup(text, config);
  if (!message) return;
  const history = historyByGroup.get(asStringId(groupId)) || [];
  const item = {
    sender: meta.sender || botDisplayName(config) || "Hermes",
    user_id: meta.user_id || "bot",
    text: redactSensitive(message, config),
    at: Date.now(),
    isBot: true,
    source: meta.source || "bot",
    replyToUserId: meta.replyToUserId || "",
    replyToSender: meta.replyToSender || "",
    mentionedUserIds: Array.isArray(meta.mentionedUserIds) ? meta.mentionedUserIds.map(asStringId).filter(Boolean) : []
  };
  history.push(item);
  history.sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
  while (history.length > Number(config.history?.rawMaxMessages || config.history?.maxMessages || 120)) history.shift();
  historyByGroup.set(asStringId(groupId), history);
  lastBotMessageByGroup.set(asStringId(groupId), item);
  if (updateBotSelfMemoryFromMessage(memory, groupId, message, config, meta)) saveMemory(memory);
}

function lastNonBotMessagesSince(history, sinceAt) {
  return history.filter((m) => !m.isBot && Number(m.at || 0) > Number(sinceAt || 0));
}

function lastNonBotMessage(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item && !item.isBot) return item;
  }
  return null;
}

function scoreImplicitReplyAgainstBotMessage({ history, current, botMessage, config }) {
  const cfg = config.implicitReply || {};
  const afterBot = lastNonBotMessagesSince(history, botMessage.at);
  const text = String(current.text || "").trim();
  if (!text) return { confidence: 0, reason: "empty", botMessage };

  const directSecondPerson = /(你|你这|你刚|你怎么|你为啥|你咋|你是不是|那你|所以你|问你|谁问你|闭嘴|别说|别吵|继续|发呀|说啊|回复|回我)/.test(text);
  const correctionOrContinuation = /^(不对|不是|错了|对|可以|行|好的|好吧|草|笑死|逆天|离谱|为啥|为什么|咋|怎么|啥|啊|嗯|？|\?)/.test(text);
  const shortQuestionOrJudgement = /^(真的假的|真的假的？|真[的滴]?吗|确定吗|然后呢|所以呢|啥意思|什么意思|怎么说|细说|展开|继续|可以|行|牛|牛逼|不错|还行|离谱|逆天|绷不住|笑死|草|6|666|彳亍|好家伙|原来如此|确实|不懂|没懂|看不懂|听不懂|谁问你了|别瞎说|你最好是)$/.test(text);
  const shortImperative = /^(说|说说|讲讲|解释|证明|教我|来|继续|展开|细说|别停|发|发呀|回|回我|看|看看)$/.test(text);
  const botKeywords = String(botMessage.text || "")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 12);
  const repeatedBotKeyword = botKeywords.some((kw) => text.includes(kw));
  const sameUserAsBotTarget = botMessage.replyToUserId && asStringId(current.user_id) === asStringId(botMessage.replyToUserId);
  const sameUserAsBotMention = (botMessage.mentionedUserIds || []).map(asStringId).includes(asStringId(current.user_id));
  const immediate = afterBot.length <= 1;
  const earlyFollowup = afterBot.length <= Number(cfg.earlyMessagesAfterBot || 2);
  const near = afterBot.length <= Number(cfg.nearMessagesAfterBot || 3);
  const shortFollowup = text.length <= Number(cfg.shortFollowupMaxLength || 40);
  const maxMessagesAfterBot = Number(cfg.maxMessagesAfterBot || 8);
  const mentionedUserMaxMessages = Number(cfg.mentionedUserMaxMessagesAfterBot || 6);
  if (afterBot.length > maxMessagesAfterBot && !directSecondPerson && !sameUserAsBotTarget && !(sameUserAsBotMention && afterBot.length <= mentionedUserMaxMessages)) {
    return { confidence: 0, reason: "too many messages after bot and weak signal", botMessage };
  }

  let confidence = 0;
  const reasons = [];
  if (sameUserAsBotTarget) {
    confidence += 0.35;
    reasons.push("same user as bot target");
  }
  if (sameUserAsBotMention) {
    confidence += Number(cfg.mentionedUserFollowupBoost || 0.35);
    reasons.push("same user as bot mentioned");
  }
  if (immediate) {
    confidence += Number(cfg.immediateFollowupBoost || 0.35);
    reasons.push("immediate follow-up");
  }
  if (!immediate && earlyFollowup) {
    confidence += Number(cfg.earlyFollowupBoost || 0.25);
    reasons.push("early follow-up after bot");
  }
  if (near && shortFollowup) {
    confidence += 0.15;
    reasons.push("near short follow-up");
  }
  if (directSecondPerson) {
    confidence += 0.45;
    reasons.push("second-person wording");
  }
  if (correctionOrContinuation && shortFollowup) {
    confidence += 0.25;
    reasons.push("short continuation/correction");
  }
  if (shortQuestionOrJudgement && shortFollowup) {
    confidence += 0.3;
    reasons.push("short question/judgement");
  }
  if (shortImperative && shortFollowup) {
    confidence += 0.3;
    reasons.push("short imperative");
  }
  if (repeatedBotKeyword && shortFollowup) {
    confidence += 0.25;
    reasons.push("repeated bot keyword");
  }
  if (isMediaOnlyText(text)) confidence -= 0.4;

  return {
    confidence: Math.max(0, confidence),
    reason: reasons.join("; ") || "no signal",
    botMessage,
    messagesAfterBot: afterBot.length
  };
}

function detectImplicitReplyToBot({ history, current, lastBotMessage, config }) {
  const cfg = config.implicitReply || {};
  if (cfg.enabled === false) return { matched: false, confidence: 0, reason: "disabled" };
  const quotedBot = asArray(current?.replyContexts).find((ctx) => ctx?.isBot);
  if (quotedBot) {
    return {
      matched: true,
      confidence: 1,
      reason: `quoted bot message ${quotedBot.messageId || "unknown"}`,
      matchedBotMessage: quotedBot
    };
  }
  const text = String(current?.text || "").trim();
  if (!text) return { matched: false, confidence: 0, reason: "empty" };
  const nowMs = Date.now();
  const windowMs = Number(cfg.windowMs || 8 * 60_000);
  const maxRecentBotMessages = Math.max(1, Math.min(12, Number(cfg.recentBotMessages || 6)));
  const candidates = orderedHistory(history)
    .filter((item) => item?.isBot && nowMs - Number(item.at || 0) <= windowMs)
    .slice(-maxRecentBotMessages)
    .reverse();
  if (lastBotMessage && nowMs - Number(lastBotMessage.at || 0) <= windowMs && !candidates.includes(lastBotMessage)) {
    candidates.unshift(lastBotMessage);
  }
  if (!candidates.length) return { matched: false, confidence: 0, reason: "no recent bot message" };
  const scored = candidates.map((botMessage) => scoreImplicitReplyAgainstBotMessage({ history, current, botMessage, config }));
  scored.sort((a, b) => b.confidence - a.confidence || Number(b.botMessage?.at || 0) - Number(a.botMessage?.at || 0));
  const best = scored[0];

  const threshold = Number(cfg.confidenceThreshold || 0.55);
  return {
    matched: best.confidence >= threshold,
    confidence: best.confidence,
    reason: `${best.reason}; matched recent bot #${candidates.indexOf(best.botMessage) + 1}`,
    matchedBotMessage: best.botMessage,
    messagesAfterBot: best.messagesAfterBot
  };
}

function detectDelayedUnderstandingCandidate({ history, current, implicitDecision, discussionDecision, config }) {
  const cfg = config.delayedUnderstanding || {};
  if (cfg.enabled === false) return { matched: false, reason: "disabled" };
  const text = String(current?.text || "").trim();
  if (!text || isMediaOnlyText(text)) return { matched: false, reason: "empty or media only" };
  const minConfidence = Number(cfg.minImplicitConfidence ?? 0.22);
  const maxConfidence = Number(cfg.maxImplicitConfidence ?? config.implicitReply?.confidenceThreshold ?? 0.55);
  const confidence = Number(implicitDecision?.confidence || 0);
  if (confidence >= minConfidence && confidence < maxConfidence) {
    return {
      matched: true,
      reason: `low-confidence implicit ${confidence.toFixed(2)}: ${implicitDecision?.reason || "unknown"}`
    };
  }

  const shortMax = Number(cfg.shortAmbiguousMaxLength || 36);
  const hasRecentContext = history.slice(-6).some((m) => m && !m.isBot && Number(m.at || 0) < Number(current.at || Date.now()));
  const ambiguousPattern = /^(这个|那个|这|那|他|她|它|啥|啊|嗯|然后呢|所以呢|什么意思|啥意思|怎么说|咋说|为啥|为什么|不对|不是|对|可以|行|好吧|确实|笑死|草|6|666|\?|？|哪个|谁|哪[个里]|真的假的|真[的滴]?吗)/;
  const hasLooseReference = /(这个|那个|这[个样事话]?|那[个样事话]?|他|她|它|刚才|上面|前面|什么意思|啥意思|怎么说|咋说|然后呢|所以呢|为啥|为什么|\?|？)/.test(text);
  if (hasRecentContext && text.length <= shortMax && (ambiguousPattern.test(text) || hasLooseReference)) {
    return { matched: true, reason: "short ambiguous follow-up" };
  }

  const discussionCfg = cfg.discussion || {};
  if (
    discussionCfg.enabled !== false
    && discussionDecision?.matched
    && text.length >= Number(discussionCfg.minTextLength || 4)
    && text.length <= Number(discussionCfg.maxTextLength || 80)
    && Math.random() < Number(discussionCfg.probability ?? 0.35)
  ) {
    return { matched: true, reason: `discussion wait: ${discussionDecision.reason || "discussion signal"}` };
  }
  return { matched: false, reason: "not ambiguous enough" };
}

function relatedUserIdsFromText(text, gm) {
  const source = String(text || "");
  const ids = new Set();
  for (const [id, user] of Object.entries(gm.users || {})) {
    const names = [user.lastName, ...(user.names || [])].filter(Boolean);
    if (names.some((name) => name && source.includes(name))) ids.add(id);
  }
  for (const match of source.matchAll(/@(\d{5,})/g)) ids.add(match[1]);
  return Array.from(ids);
}

function compactSelectedMemory(gm, ids, config) {
  const maxUsers = Number(config.memory?.promptMaxUsers || 8);
  const botSelf = compactBotSelfMemory(ensureBotSelfMemory(gm, config), config);
  const users = ids.slice(0, maxUsers).map((id) => {
    const user = gm.users?.[id];
    if (!user) return "";
    const bits = userMemoryBits(user, config);
    if (!bits.length) return "";
    return `- ${user.lastName || user.names?.at(-1) || id}(${id})：${bits.join("；")}`;
  }).filter(Boolean).join("\n");
  return [botSelf, users ? `相关群友记忆：\n${users}` : ""].filter(Boolean).join("\n");
}

function buildContextBundle({ memory, groupId, history, current, config }) {
  const gm = groupMemory(memory, groupId);
  const recentCount = Number(config.history?.promptRecentMessages || 28);
  const ordered = orderedHistory(history);
  const recentMessages = ordered.slice(-recentCount).map((item) => shortMessageForPrompt(item, config)).join("\n");
  const activeIds = ordered
    .slice(-recentCount)
    .map((m) => asStringId(m.user_id))
    .filter(Boolean);
  const replyIds = asArray(current?.replyContexts).map((ctx) => asStringId(ctx?.senderId)).filter(Boolean);
  const relatedIds = new Set([asStringId(current.user_id), ...replyIds, ...activeIds.slice(-8), ...relatedUserIdsFromText(current.text, gm)]);
  const selectedMemory = compactSelectedMemory(gm, Array.from(relatedIds), config) || compactMemory(memory, groupId, config, asStringId(current.user_id));
  const topics = (gm.topics || []).slice(-8).map((t) => `- ${t}`).join("\n");
  const facts = (gm.facts || []).slice(-8).map((f) => `- ${f}`).join("\n");
  const feedback = proactiveReduced(memory, groupId)
    ? `本群刚出现过对 bot 话多/插嘴的负反馈，主动说话要更克制。`
    : "";
  return {
    botSelf: compactBotSelfMemory(ensureBotSelfMemory(gm, config), config),
    rollingSummary: gm.rollingSummary || "",
    recentMessages,
    selectedMemory,
    topics,
    facts,
    feedback
  };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return _; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)); } catch { return _; }
    });
}

function stripHtml(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function normalizeDuckDuckGoUrl(href) {
  const raw = decodeHtmlEntities(href || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return raw;
  }
}

function normalizeBingUrl(href) {
  const raw = decodeHtmlEntities(href || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://www.bing.com");
    const u = url.searchParams.get("u");
    if (u) {
      const encoded = u.startsWith("a1") ? u.slice(2) : u;
      try {
        const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        // fall through
      }
      try {
        const decoded = decodeURIComponent(u);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        // fall through
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripBotAddressing(text, config) {
  let cleaned = String(text || "");
  for (const name of config.botNames || []) {
    const n = String(name || "").trim();
    if (n) cleaned = cleaned.replace(new RegExp(escapeRegExp(n), "gi"), " ");
  }
  return cleaned
    .replace(/@\d{5,}/g, " ")
    .replace(/^[\s，,。.!！?？;；:：]+/g, " ")
    .replace(/[，,]\s*(在吗|在不在|你在吗|出来|帮忙|帮我)?\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchIntentConfig(config) {
  const cfg = config.webSearch || {};
  const softTriggers = cfg.softTriggerPhrases || [
    "最新", "最近", "今天", "现在", "目前", "实时", "刚刚", "新闻",
    "价格", "天气", "汇率", "股价", "票房", "比分", "赛程", "公告", "版本"
  ];
  const defaultTriggers = [
    "联网查", "联网搜", "上网查", "上网搜", "网上查", "网上搜",
    "搜一下", "搜索一下", "帮我搜索", "帮我搜", "帮我查", "查一下",
    "查查", "查个", "搜个", "查网页", "看网页"
  ];
  const configured = cfg.triggerPhrases || defaultTriggers;
  const explicitTriggers = configured
    .filter(Boolean)
    .filter((x) => !softTriggers.includes(x));
  return { cfg, softTriggers, explicitTriggers };
}

function isLikelyFreshInfoQuestion(text) {
  const raw = String(text || "");
  const hasFreshMarker = /(最新|最近|今天|现在|目前|实时|刚刚|新闻|价格|天气|汇率|股价|票房|比分|赛程|公告|版本|发布|上线|下架|政策|规定|名单|排名)/.test(raw);
  if (!hasFreshMarker) return false;
  const hasQuestionShape = /[?？]|(吗|么|什么|啥|多少|几|谁|哪|哪里|如何|怎么|咋|有没有|是否|是不是|出来了吗|发布了吗|更新了吗|涨了吗|跌了吗|几点|什么时候|哪天)/.test(raw);
  const commandLikeFresh = /^(最新|最近|今天|现在|目前|实时)\s*[^，。！？!?]{2,40}(消息|新闻|进展|情况|价格|天气|汇率|股价|票房|比分|赛程|公告|版本|政策|规定|名单|排名)\s*[?？。！!]*$/.test(raw);
  const compactFreshCommand = /^[^，。！？!?]{2,40}(最新消息|最新新闻|最新进展|今日新闻|实时价格|当前价格|天气预报|比赛结果|赛程|股价|汇率)\s*[?？。！!]*$/.test(raw);
  return hasQuestionShape || commandLikeFresh || compactFreshCommand;
}

function cleanSearchQuery(query, config, { preserveFreshWords = true } = {}) {
  const { explicitTriggers, softTriggers } = searchIntentConfig(config);
  const explicitPattern = explicitTriggers.length ? new RegExp(explicitTriggers.map(escapeRegExp).join("|"), "g") : null;
  const softPattern = softTriggers.length ? new RegExp(`^(${softTriggers.map(escapeRegExp).join("|")})\\s*`, "g") : null;
  let cleaned = stripBotAddressing(query, config);
  if (explicitPattern) cleaned = cleaned.replace(explicitPattern, " ");
  cleaned = cleaned
    .replace(/\[图片\]|\[表情\]/g, " ")
    .replace(/(帮我|给我|麻烦|请|顺手|可以|能不能|能否|你能|你可以|能)?\s*(联网|上网|网上)?\s*(查查|查一下|查下|查个|查询|查|搜一下|搜下|搜个|搜索一下|搜索|搜|看一下|看下|看看)\s*/g, " ")
    .replace(/^(一下|一下子|一下吧|下|下吧|吧|呢|呀|啊)\s*/g, " ")
    .replace(/^(我想知道|想知道|请问|问一下|问问|你知道|知道|帮忙看看|帮我看看)\s*/g, " ")
    .replace(/(是什么意思|是什么|是啥|有啥|啥意思|什么意思|怎么样|咋样|如何|靠谱吗|有没有|出来了吗|发布了吗|更新了吗|涨了吗|跌了吗|多少|几号|什么时候|哪天|吗|么)\s*[?？。!！]*$/g, " ")
    .replace(/[，,。.!！?？;；:：]+$/g, " ")
    .replace(/[“”"']/g, " ")
    .replace(/[，。！？!?；;：:]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!preserveFreshWords) {
    if (softPattern) cleaned = cleaned.replace(softPattern, " ");
    cleaned = cleaned
      .replace(/\s+/g, " ")
      .trim();
  }

  return cleaned;
}

function isVagueSearchQuery(query) {
  const q = String(query || "").replace(/\s+/g, "").trim();
  if (!q) return true;
  if (/^(这个|那个|它|他|她|这|那|刚才那个|上面那个|前面那个|这个问题|这事|这玩意儿|链接)$/.test(q)) return true;
  if (/^(这个|那个|它|他|她|这|那|刚才|上面|前面)/.test(q) && q.length <= 8) return true;
  return false;
}

function inferSearchTopicFromHistory(history = [], current = null, config = {}) {
  const currentAt = current?.at || 0;
  const candidates = [...history]
    .filter((item) => !currentAt || item.at !== currentAt)
    .slice(-8)
    .reverse();
  for (const item of candidates) {
    const text = cleanSearchQuery(item?.text || "", config, { preserveFreshWords: true })
      .replace(/^\/bot\b.*$/i, " ")
      .replace(/^(我搜一下|等下|我查一下).*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 4) continue;
    if (/^(哈哈|笑死|草|可以|不是|对|嗯|啊|？|\?)+$/.test(text)) continue;
    return clampText(text, 60);
  }
  return "";
}

function appendDateForFreshQuery(query, config) {
  if (config.webSearch?.appendDateForFreshQueries === false) return query;
  if (isWeatherQuery(query)) return query;
  if (/(24\s*小时|二十四小时|近24|过去24)/.test(query)) return query;
  if (!/(最新|最近|今天|现在|目前|实时|刚刚|新闻|天气|价格|股价|汇率|比分|赛程|公告|版本|政策|规定|名单|排名)/.test(query)) return query;
  if (/\b20\d{2}[-年/]\d{1,2}/.test(query) || /\b20\d{2}\b/.test(query)) return query;
  const d = new Date();
  const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${query} ${date}`;
}

function isWeatherQuery(text) {
  return /(天气|气温|温度|冷不冷|热不热|下雨|降雨|雨大|会不会雨|刮风|风大|湿度|空气质量|雾霾|AQI|紫外线|穿什么)/i.test(String(text || ""));
}

function extractWeatherLocation(query, config) {
  let cleaned = stripBotAddressing(query, config)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b20\d{2}[-年/]\d{1,2}[-月/]?\d{0,2}日?\b/g, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b\d{1,2}[月/]\d{1,2}日?\b/g, " ")
    .replace(/(今天|今日|明天|明日|后天|现在|目前|实时|最新|最近|刚刚|此刻|当地|本地)/g, " ")
    .replace(/(天气预报|天气|气温|温度|冷不冷|热不热|会不会下雨|下不下雨|下雨吗|下雨|降雨|雨大|刮风|风大|湿度|空气质量|雾霾|AQI|紫外线|穿什么|怎么样|如何|咋样|查一下|搜一下|查询|搜索|帮我|麻烦|请问|看看|看下|一下|吗|么|呀|啊|呢)/g, " ")
    .replace(/[，。！？!?；;：:,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = cleaned.replace(/^(市|省|区|县)\s*/g, "").trim();
  if (cleaned.length > 24) cleaned = cleaned.slice(0, 24).trim();
  return cleaned || String(config.webSearch?.weather?.defaultLocation || "").trim();
}

function weatherDayIndex(query) {
  const raw = String(query || "");
  if (/后天/.test(raw)) return 2;
  if (/明天|明日/.test(raw)) return 1;
  return 0;
}

function zhWeatherDesc(value) {
  const text = String(value || "").trim();
  const map = [
    [/smoky haze|haze/i, "霾"],
    [/mist|fog/i, "雾"],
    [/sunny|clear/i, "晴"],
    [/partly cloudy/i, "多云间晴"],
    [/cloudy|overcast/i, "阴/多云"],
    [/light rain|patchy rain/i, "小雨"],
    [/moderate rain/i, "中雨"],
    [/heavy rain/i, "大雨"],
    [/snow/i, "雪"],
    [/thunder/i, "雷雨"]
  ];
  return map.find(([pattern]) => pattern.test(text))?.[1] || text || "未知";
}

function weatherDescFrom(item) {
  return item?.lang_zh?.[0]?.value
    || item?.weatherDesc?.[0]?.value
    || item?.lang_xx?.[0]?.value
    || "";
}

async function fetchWeather(location, query, config) {
  const weatherCfg = config.webSearch?.weather || {};
  if (weatherCfg.enabled === false) return { ok: false, error: "weather disabled" };
  const timeoutMs = Number(weatherCfg.timeoutMs || config.webSearch?.timeoutMs || 8000);
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`weather http ${res.status}`);
  const data = await res.json();
  const area = data?.nearest_area?.[0];
  const current = data?.current_condition?.[0];
  const day = data?.weather?.[Math.min(weatherDayIndex(query), Math.max(0, (data?.weather?.length || 1) - 1))];
  if (!current && !day) return { ok: false, error: "empty weather data" };
  const areaName = [
    area?.areaName?.[0]?.value,
    area?.region?.[0]?.value,
    area?.country?.[0]?.value
  ].filter(Boolean).join(", ");
  return { ok: true, provider: "wttr.in", location, areaName, current, day, raw: data };
}

function formatWeatherContext(weather, query) {
  if (!weather?.ok) return `查询：${query}\n类型：天气直查\n结果：天气源没有返回可用数据。${weather?.error ? `\n错误：${weather.error}` : ""}`;
  const { current, day } = weather;
  const lines = [
    `查询：${query}`,
    "类型：天气直查",
    `天气源：${weather.provider}`,
    `请求地点：${weather.location}`,
    weather.areaName ? `地点识别：${weather.areaName}` : "",
    `查询时间：${localNowText()}`
  ].filter(Boolean);
  if (current) {
    lines.push(`当前：${zhWeatherDesc(weatherDescFrom(current))}，${current.temp_C}℃，体感 ${current.FeelsLikeC}℃，湿度 ${current.humidity}%，风速 ${current.windspeedKmph} km/h，能见度 ${current.visibility} km。`);
  }
  if (day) {
    const hourly = Array.isArray(day.hourly) ? day.hourly : [];
    const maxRain = Math.max(0, ...hourly.map((x) => Number(x.chanceofrain || 0)).filter(Number.isFinite));
    const maxSnow = Math.max(0, ...hourly.map((x) => Number(x.chanceofsnow || 0)).filter(Number.isFinite));
    lines.push(`预报：${day.date || "今天"}，${zhWeatherDesc(weatherDescFrom(hourly[4] || hourly[0] || {}))}，${day.mintempC}–${day.maxtempC}℃，平均 ${day.avgtempC}℃，最大降雨概率 ${maxRain}%，最大降雪概率 ${maxSnow}%，紫外线 ${day.uvIndex ?? "未知"}。`);
  }
  lines.push("回答要求：天气问题优先使用本段数据；不要再引用普通网页搜索结果；如果地点识别和用户要查的地点明显不一致，要提醒可能查偏。");
  return lines.join("\n");
}

function extractSearchQuery(rawText, { trigger = "", mode = "explicit", history = [], current = null, config }) {
  const raw = stripBotAddressing(rawText, config);
  const urlMatch = raw.match(/https?:\/\/\S+/i);
  if (urlMatch && mode === "url") return urlMatch[0];

  let candidate = raw;
  if (trigger) {
    const index = raw.indexOf(trigger);
    const after = index >= 0 ? raw.slice(index + trigger.length) : "";
    const before = index >= 0 ? raw.slice(0, index) : raw;
    candidate = cleanSearchQuery(after, config);
    if (candidate.length < 2) candidate = cleanSearchQuery(before, config);
  } else {
    candidate = cleanSearchQuery(raw, config);
  }

  const inferred = inferSearchTopicFromHistory(history, current, config);
  if (isVagueSearchQuery(candidate) && inferred) {
    candidate = `${inferred} ${candidate.replace(/^(这个|那个|它|他|她|这|那)/, "").trim()}`.trim();
  } else if (/(这个|那个|它|他|她|刚才|上面|前面)/.test(candidate) && inferred && candidate.length < 14) {
    candidate = `${inferred} ${candidate}`.trim();
  }

  candidate = appendDateForFreshQuery(candidate, config)
    .replace(/\s+/g, " ")
    .trim();
  return candidate || raw;
}

function hasEnoughSearchSubstance(query) {
  const compact = String(query || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/(今天|现在|目前|最新|最近|实时|新闻|消息|情况|一下|这个|那个|它|他|她|帮我|查询|搜索)/g, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "")
    .trim();
  return compact.length >= 2;
}

function detectWebSearchRequest(text, config, context = {}) {
  const cfg = config.webSearch || {};
  if (cfg.enabled === false) return { matched: false, query: "", reason: "disabled" };
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { matched: false, query: "", reason: "empty" };
  const { explicitTriggers } = searchIntentConfig(config);
  const sortedTriggers = explicitTriggers.filter(Boolean).sort((a, b) => b.length - a.length);
  const matchedTrigger = sortedTriggers.find((trigger) => raw.includes(trigger));
  const hasUrl = /https?:\/\/\S+/i.test(raw);
  const urlRequested = hasUrl && (cfg.urlAlwaysAllowed || /(查|搜|看|打开|总结|解释|网页|链接|这个链接|这个网页)/.test(raw));
  const freshRequested = !matchedTrigger
    && isLikelyFreshInfoQuestion(stripBotAddressing(raw, config))
    && (context.mentioned || context.keyword || context.isPrivate || /^(最新|最近|今天|现在|目前|实时)/.test(stripBotAddressing(raw, config)));

  if (!matchedTrigger && !urlRequested && !freshRequested) {
    return { matched: false, query: "", reason: "no explicit trigger" };
  }

  const mode = matchedTrigger ? "explicit" : urlRequested ? "url" : "fresh";
  let query = extractSearchQuery(raw, {
    trigger: matchedTrigger,
    mode,
    history: context.history || [],
    current: context.current,
    config
  });
  query = clampText(query, Number(cfg.maxQueryLength || 120));
  const minLength = Number(cfg.minQueryLength || 2);
  if ((query.length < minLength || !hasEnoughSearchSubstance(query)) && !hasUrl) {
    return { matched: false, query, reason: "query too short" };
  }
  const kind = isWeatherQuery(query) ? "weather" : urlRequested ? "url" : "web";
  const location = kind === "weather" ? extractWeatherLocation(query, config) : "";
  return { matched: true, query: query || raw, reason: matchedTrigger || (urlRequested ? "url" : "fresh-info"), kind, location };
}

function webSearchJudgePrompt(candidate, { text, history = [], current = null, config }) {
  const recent = history.slice(-8).map(shortMessageForPrompt).join("\n");
  const botNames = asArray(config.botNames).filter(Boolean).join("、") || "小跟班";
  return `你是 QQ 群聊机器人的联网搜索意图裁判。请判断当前消息是否真的需要联网搜索。

规则：
- 只有用户明确要你查、搜、看网页，或询问天气/价格/新闻/版本/赛程等强实时信息时，才 should_search=true。
- 如果只是普通聊天、玩梗、感叹，哪怕出现“今天/最新/新闻/搜索”等词，也不要搜索。
- 如果消息里是在讨论“搜索功能/搜索提示词/搜索能力”本身，而不是要查某个外部事实，不要搜索。
- 如果用户说“搜一下这个/它/刚才那个”，可以结合最近上下文补全查询词；补不出来就 should_search=false。
- 查询词要具体，删掉 bot 名称、寒暄、@、命令词，只保留真正要查的对象和时间范围。
- kind 只能是 "web"、"weather"、"url" 或 "news"；news 用于新闻/热点/24小时内动态。
- 只能输出 JSON，不要 Markdown，不要解释。

输出结构：
{
  "should_search": true,
  "query": "具体搜索词",
  "kind": "web",
  "confidence": 0.0,
  "reason": "一句话理由"
}

bot 名称：${botNames}

最近上下文：
${recent || "（无）"}

当前消息：
${current?.sender || "群友"}: ${text}

规则候选：
${JSON.stringify(candidate, null, 2)}
`;
}

async function judgeWebSearchWithAI(candidate, { text, history = [], current = null, config }) {
  const cfg = config.webSearch || {};
  const judgeCfg = cfg.aiJudge || {};
  if (!candidate?.matched || judgeCfg.enabled === false) return candidate;

  const minConfidence = Number(judgeCfg.minConfidence ?? 0.55);
  const timeoutMs = Number(judgeCfg.timeoutMs || cfg.timeoutMs || config.ai?.timeoutMs || 120000);
  const originalTimeout = config.ai?.timeoutMs;
  const judgeConfig = deepClone(config);
  judgeConfig.ai ||= {};
  judgeConfig.ai.reasoningEffort = "none";
  judgeConfig.ai.timeoutMs = timeoutMs;

  try {
    const raw = await callHermes(webSearchJudgePrompt(candidate, { text, history, current, config }), judgeConfig);
    const parsed = extractJsonObject(raw);
    const shouldSearch = Boolean(parsed.should_search ?? parsed.search ?? parsed.need_search);
    const confidence = Number(parsed.confidence ?? (shouldSearch ? 0.7 : 0.3));
    if (!shouldSearch || confidence < minConfidence) {
      return {
        matched: false,
        query: String(parsed.query || candidate.query || ""),
        reason: `ai-judge-no: ${clampText(parsed.reason || "not needed", 120)}`,
        aiJudge: { ok: true, shouldSearch, confidence, reason: parsed.reason || "" },
        candidate
      };
    }
    let query = clampText(String(parsed.query || candidate.query || "").trim(), Number(cfg.maxQueryLength || 120));
    if (!query) query = candidate.query;
    query = appendDateForFreshQuery(query, config);
    const kindRaw = String(parsed.kind || candidate.kind || "").toLowerCase();
    const kind = ["weather", "url", "web", "news"].includes(kindRaw)
      ? kindRaw
      : isWeatherQuery(query) ? "weather" : candidate.kind || "web";
    if (!hasEnoughSearchSubstance(query) && kind !== "url") {
      return {
        matched: false,
        query,
        reason: "ai-judge-query-too-thin",
        aiJudge: { ok: true, shouldSearch, confidence, reason: parsed.reason || "" },
        candidate
      };
    }
    return {
      ...candidate,
      matched: true,
      query,
      kind,
      location: kind === "weather" ? extractWeatherLocation(query, config) : "",
      reason: `ai-judge: ${clampText(parsed.reason || candidate.reason || "", 120)}`,
      aiJudge: { ok: true, shouldSearch: true, confidence, reason: parsed.reason || "" },
      candidate
    };
  } catch (err) {
    const fallback = String(judgeCfg.fallback || "skip").toLowerCase();
    warn(`web search AI judge failed: ${err.message}`);
    if (fallback === "rule" || fallback === "rules" || fallback === "search") {
      return { ...candidate, reason: `${candidate.reason}; ai-judge-failed-rule-fallback`, aiJudge: { ok: false, error: err.message } };
    }
    return {
      matched: false,
      query: candidate.query || "",
      reason: `ai-judge-failed: ${err.message}`,
      aiJudge: { ok: false, error: err.message },
      candidate,
      originalTimeout
    };
  }
}

async function fetchWithTimeout(url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 HermesQQBot/1.0 controlled-search",
        ...headers
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function curlBinary(config) {
  return String(config.webSearch?.curlPath || process.env.CURL_PATH || "curl");
}

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?|socks5h?|socks4a?):\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function proxyCandidates(config) {
  const cfg = config.webSearch?.proxy || {};
  if (cfg.enabled === false) return [];
  const configured = asArray(cfg.url || cfg.urls);
  const env = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy
  ];
  const common = cfg.autoDetect === false ? [] : [
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7890",
    "http://127.0.0.1:7899",
    "socks5h://127.0.0.1:1080",
    "socks5h://127.0.0.1:1087",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:20171",
    "http://127.0.0.1:6152"
  ];
  return [...new Set([...configured, ...env, ...common].map(normalizeProxyUrl).filter(Boolean))];
}

function curlFetchText(url, { config, timeoutMs = 8000, proxy = "", headers = {}, maxBytes = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sSL",
      "--compressed",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-A",
      headers["user-agent"] || headers["User-Agent"] || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    ];
    if (proxy) args.push("--proxy", proxy);
    for (const [key, value] of Object.entries(headers)) {
      if (/^user-agent$/i.test(key)) continue;
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url);
    const child = spawn(curlBinary(config), args, { cwd: commandCwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (d) => {
      size += d.length;
      if (size <= maxBytes) chunks.push(d);
      if (size > maxBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (code === 0 || (signal === "SIGTERM" && body)) return resolve(body);
      reject(new Error(`curl exited ${code ?? signal}: ${stderr.slice(-300)}`));
    });
  });
}

async function curlFetchWithProxyFallback(url, { config, timeoutMs = 8000, headers = {}, preferProxy = true } = {}) {
  const proxies = preferProxy ? proxyCandidates(config) : [];
  const errors = [];
  for (const proxy of proxies) {
    try {
      const body = await curlFetchText(url, { config, timeoutMs, proxy, headers });
      if (body) return { body, proxy, via: "proxy" };
      errors.push(`${proxy}: empty`);
    } catch (err) {
      errors.push(`${proxy}: ${err.message}`);
    }
  }
  if (config.webSearch?.proxy?.directFallback !== false) {
    try {
      const body = await curlFetchText(url, { config, timeoutMs, headers });
      if (body) return { body, proxy: "", via: "direct" };
      errors.push("direct: empty");
    } catch (err) {
      errors.push(`direct: ${err.message}`);
    }
  }
  throw new Error(errors.join("; ") || "no proxy/direct candidate");
}

async function searchDuckDuckGo(query, config) {
  const cfg = config.webSearch || {};
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const maxResults = Number(cfg.maxResults || 4);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`search http ${res.status}`);
  const html = await res.text();
  const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"[^>]*>/gi);
  const results = [];
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = stripHtml(titleMatch[2]);
    const link = normalizeDuckDuckGoUrl(titleMatch[1]);
    const snippet = stripHtml(snippetMatch?.[1] || "");
    if (!title || !link || results.some((item) => item.link === link)) continue;
    results.push({ title: clampText(title, 120), link, snippet: clampText(snippet, 220) });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function searchBing(query, config) {
  const cfg = config.webSearch || {};
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const maxResults = Number(cfg.maxResults || 4);
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`bing http ${res.status}`);
  const html = await res.text();
  const blocks = html.split(/<li[^>]+class="b_algo"[^>]*>/gi);
  const results = [];
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = stripHtml(titleMatch[2]);
    const link = normalizeBingUrl(titleMatch[1]);
    const snippet = stripHtml(snippetMatch?.[1] || "");
    if (!title || !/^https?:\/\//i.test(link) || results.some((item) => item.link === link)) continue;
    results.push({ title: clampText(title, 120), link, snippet: clampText(snippet, 220) });
    if (results.length >= maxResults) break;
  }
  return results;
}

function normalizeGoogleUrl(href) {
  const raw = decodeHtmlEntities(href || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://www.google.com");
    const q = url.searchParams.get("q") || url.searchParams.get("url");
    if (q && /^https?:\/\//i.test(q)) return q;
    return url.toString();
  } catch {
    return raw;
  }
}

function normalizeBaiduUrl(href) {
  const raw = decodeHtmlEntities(href || "").trim();
  if (!raw) return "";
  try {
    return (raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://www.baidu.com")).toString();
  } catch {
    return raw;
  }
}

function isNewsLikeQuery(query) {
  return /(新闻|资讯|消息|动态|快讯|24\s*小时|二十四小时|近24|过去24|最近|最新|今日|今天|刚刚|实时|走势|价格|油价|原油|股价|汇率|行情|科技|AI|人工智能|国际)/i.test(String(query || ""));
}

function googleNewsQuery(query) {
  const original = String(query || "");
  let q = original
    .replace(/\b20\d{2}[-年/]\d{1,2}[-月/]?\d{0,2}日?\b/g, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/(搜索一下|搜一下|查一下|帮我搜|帮我查|查询|搜索|搜|查|重要的?|主要的?|内|以内|过去|最近|最新|今日|今天)/g, " ")
    .replace(/(24\s*小时|二十四小时|近24小时?|过去24小时?)/g, " ")
    .replace(/的/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/科技新闻/.test(q)) q = q.replace(/科技新闻/g, "科技 新闻");
  if (/AI新闻/i.test(q)) q = q.replace(/AI新闻/gi, "AI 新闻");
  if (/原油价格走势/.test(q)) q = q.replace(/原油价格走势/g, "原油 价格 走势");
  if (/国际原油/.test(q)) q = q.replace(/国际原油/g, "国际 原油");
  if (/(科技|AI|人工智能).*(新闻|资讯|快讯)|重要.*科技|科技.*重要/i.test(original)) {
    q = "AI OR 人工智能 OR 芯片 OR 半导体 OR 大模型 OR 科技";
  }
  if (/(国际)?(原油|油价|布伦特|WTI|Brent).*(走势|价格|行情|涨跌)|走势.*(原油|油价|布伦特|WTI|Brent)/i.test(original)) {
    q = "国际油价 OR 原油 OR WTI OR 布伦特";
  }
  q = q.replace(/(^|\s)日(\s|$)/g, " ").replace(/\s+/g, " ").trim();
  q = q.replace(/\s+/g, " ").trim() || original.trim();
  if (/(24\s*小时|二十四小时|近24|过去24|今天|今日|刚刚)/.test(original) && !/\bwhen:\d+[hdmy]\b/i.test(q)) {
    q += " when:1d";
  } else if (/(最新|最近|实时|新闻|资讯|快讯|走势|价格|油价|行情)/.test(original) && !/\bwhen:\d+[hdmy]\b/i.test(q)) {
    q += " when:7d";
  }
  return q;
}

function parseGoogleNewsRss(xml, query, config, meta = {}) {
  const maxResults = Number(config.webSearch?.maxResults || 4);
  const items = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const results = [];
  for (const match of items) {
    const block = match[1] || "";
    const title = decodeHtmlEntities(block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
      || block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      || "");
    const link = decodeHtmlEntities(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "");
    const pubDate = decodeHtmlEntities(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "");
    const sourceMatch = block.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
    const sourceUrl = decodeHtmlEntities(sourceMatch?.[1] || "");
    const sourceName = decodeHtmlEntities(sourceMatch?.[2] || "");
    const description = stripHtml(decodeHtmlEntities(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || ""));
    if (!title || !link) continue;
    results.push({
      title: clampText(title, 140),
      link,
      snippet: clampText([sourceName, pubDate, description].filter(Boolean).join(" · "), 260),
      source: meta.source || "google-news",
      sourceName,
      sourceUrl,
      pubDate
    });
    if (results.length >= maxResults * 2) break;
  }
  return rankSearchResults(results, query, config).slice(0, maxResults);
}

async function searchGoogleNews(query, config) {
  const cfg = config.webSearch || {};
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const q = googleNewsQuery(query);
  const lang = cfg.google?.newsLang || "zh-CN";
  const region = cfg.google?.newsRegion || "CN";
  const ceid = cfg.google?.newsCeid || "CN:zh-Hans";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(region)}&ceid=${encodeURIComponent(ceid)}`;
  const fetched = await curlFetchWithProxyFallback(url, {
    config,
    timeoutMs,
    preferProxy: cfg.google?.proxy !== false,
    headers: { "user-agent": "Mozilla/5.0 HermesQQBot/1.0 google-news-rss" }
  });
  const results = parseGoogleNewsRss(fetched.body, q, config, { source: fetched.proxy ? `google-news via ${fetched.proxy}` : "google-news direct" });
  if (!results.length && /Google 新闻|Google News|<rss/i.test(fetched.body)) return [];
  if (!results.length) throw new Error(`google news returned no parseable items via ${fetched.via}`);
  return results;
}

function parseGoogleWeb(html, query, config, meta = {}) {
  const maxResults = Number(config.webSearch?.maxResults || 4);
  const source = meta.source || "google";
  const results = [];
  const htmlText = String(html || "");
  const blocked = /SG_REL|enablejs|unusual traffic|sorry\/index|captcha/i.test(htmlText);
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of htmlText.matchAll(anchorPattern)) {
    const href = normalizeGoogleUrl(match[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    const host = (() => { try { return new URL(href).hostname; } catch { return ""; } })();
    if (/google\./i.test(host) || /gstatic|accounts\.google|support\.google/i.test(host)) continue;
    const title = stripHtml(match[2]);
    if (!title || title.length < 2) continue;
    if (results.some((item) => item.link === href)) continue;
    results.push({ title: clampText(title, 120), link: href, snippet: "", source });
    if (results.length >= maxResults * 3) break;
  }
  const ranked = rankSearchResults(results, query, config).slice(0, maxResults);
  if (!ranked.length && blocked) throw new Error("google web blocked by JS/captcha");
  return ranked;
}

async function searchGoogleWeb(query, config) {
  const cfg = config.webSearch || {};
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-CN&num=${Number(cfg.maxResults || 4) + 4}`;
  const fetched = await curlFetchWithProxyFallback(url, {
    config,
    timeoutMs,
    preferProxy: cfg.google?.proxy !== false,
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  return parseGoogleWeb(fetched.body, query, config, { source: fetched.proxy ? `google via ${fetched.proxy}` : "google direct" });
}

async function searchGoogle(query, config) {
  const errors = [];
  if (isNewsLikeQuery(query)) {
    try {
      const results = await searchGoogleNews(query, config);
      if (results.length) return { provider: "google-news", results };
      errors.push("google-news: no results");
    } catch (err) {
      errors.push(`google-news: ${err.message}`);
    }
  }
  try {
    const results = await searchGoogleWeb(query, config);
    if (results.length) return { provider: "google", results };
    errors.push("google: no results");
  } catch (err) {
    errors.push(`google: ${err.message}`);
  }
  if (!isNewsLikeQuery(query)) {
    try {
      const results = await searchGoogleNews(query, config);
      if (results.length) return { provider: "google-news", results };
      errors.push("google-news: no results");
    } catch (err) {
      errors.push(`google-news: ${err.message}`);
    }
  }
  return { provider: "google", results: [], error: errors.join("; ") };
}

function parseBaidu(html, query, config, meta = {}) {
  const htmlText = String(html || "");
  if (/百度安全验证|网络不给力|verify|captcha/i.test(htmlText)) throw new Error("baidu blocked by safety verification");
  const maxResults = Number(config.webSearch?.maxResults || 4);
  const results = [];
  const patterns = [
    /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/gi,
    /<a[^>]+class="[^"]*(?:result-title|c-title)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  ];
  for (const pattern of patterns) {
    for (const match of htmlText.matchAll(pattern)) {
      const link = normalizeBaiduUrl(match[1]);
      const title = stripHtml(match[2]);
      if (!title || !/^https?:\/\//i.test(link)) continue;
      if (results.some((item) => item.link === link)) continue;
      results.push({ title: clampText(title, 120), link, snippet: "", source: meta.source || "baidu" });
      if (results.length >= maxResults * 3) break;
    }
    if (results.length) break;
  }
  return rankSearchResults(results, query, config).slice(0, maxResults);
}

async function searchBaidu(query, config) {
  const cfg = config.webSearch || {};
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const urls = [
    `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Number(cfg.maxResults || 4) + 4}`,
    `https://m.baidu.com/s?word=${encodeURIComponent(query)}&rn=${Number(cfg.maxResults || 4) + 4}`
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const fetched = await curlFetchWithProxyFallback(url, {
        config,
        timeoutMs,
        preferProxy: cfg.baidu?.proxy === true,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9"
        }
      });
      const results = parseBaidu(fetched.body, query, config, { source: fetched.proxy ? `baidu via ${fetched.proxy}` : "baidu direct" });
      if (results.length) return results;
      errors.push(`${url}: no results`);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

function searchCoreTerms(query) {
  const raw = String(query || "").toLowerCase();
  const latin = [...raw.matchAll(/[a-z][a-z0-9._+-]{1,}/g)].map((x) => x[0]);
  const keywordBank = [
    "科技", "新闻", "资讯", "快讯", "AI", "人工智能", "芯片", "半导体", "大模型", "机器人",
    "国际", "原油", "油价", "价格", "走势", "行情", "WTI", "布伦特", "欧佩克", "OPEC",
    "汇率", "股价", "天气", "政策", "公告", "版本", "DeepSeek", "Google", "OpenAI"
  ];
  const bankTerms = keywordBank.filter((term) => raw.includes(term.toLowerCase())).map((term) => term.toLowerCase());
  const chinese = raw
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\d{1,2}月\d{1,2}日/g, " ")
    .replace(/(24小时|二十四小时|近24|过去24|今天|现在|目前|最新|最近|实时|消息|情况|一下|这个|那个|查询|搜索|帮我|看看|怎么样|如何|是什么|是什么意思|重要|主要|以内|过去|的|了|吗|么)/g, " ")
    .split(/[\s，。！？!?；;：:,.、()（）/\\-]+/)
    .map((x) => x.trim())
    .flatMap((x) => {
      if (x.length <= 6) return [x];
      const found = keywordBank.filter((term) => x.includes(term));
      return found.length ? found : [x];
    })
    .filter((x) => x.length >= 2 && /[\u4e00-\u9fff]/.test(x));
  return [...new Set([...latin, ...bankTerms, ...chinese])].slice(0, 10);
}

function scoreSearchResult(item, query) {
  const terms = searchCoreTerms(query);
  if (!terms.length) return 1;
  const haystack = `${item.title || ""} ${item.snippet || ""} ${item.link || ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) score += term.length >= 4 ? 2 : 1;
  }
  if (/official|官网|github|huggingface|modelscope|arxiv|文档|docs/i.test(haystack)) score += 1;
  return score;
}

function rankSearchResults(results, query, config) {
  const minScore = Number(config.webSearch?.minResultScore ?? 1);
  const ranked = results
    .map((item) => ({ ...item, score: scoreSearchResult(item, query) }))
    .sort((a, b) => b.score - a.score);
  const filtered = ranked.filter((item) => item.score >= minScore);
  return filtered.length ? filtered : ranked.slice(0, Math.min(2, ranked.length));
}

async function webSearch(query, config) {
  const provider = String(config.webSearch?.provider || "google").toLowerCase();
  const configuredOrder = asArray(config.webSearch?.providerOrder || config.webSearch?.providers).map((x) => String(x).toLowerCase()).filter(Boolean);
  const providers = configuredOrder.length
    ? configuredOrder
    : provider === "google"
      ? ["google", "baidu"]
      : provider === "baidu"
        ? ["baidu", "google"]
        : provider === "duckduckgo"
          ? ["duckduckgo", "bing", "google", "baidu"]
          : provider === "bing"
            ? ["bing", "duckduckgo", "google", "baidu"]
            : [provider, "google", "baidu"];
  const errors = [];
  const maxResults = Number(config.webSearch?.maxResults || 4);
  if (config.webSearch?.aggregateProviders !== false && providers.every((x) => ["bing", "duckduckgo"].includes(x))) {
    const collected = [];
    for (const name of providers) {
      try {
        const results = name === "duckduckgo"
          ? await searchDuckDuckGo(query, config)
          : await searchBing(query, config);
        for (const item of results) {
          if (!collected.some((x) => x.link === item.link)) collected.push({ ...item, source: name });
        }
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    const ranked = rankSearchResults(collected, query, config).slice(0, maxResults);
    if (ranked.length) return { provider: providers.join("+"), results: ranked, aggregated: true, error: errors.join("; ") };
  }
  for (const name of providers) {
    try {
      if (name === "google") {
        const search = await searchGoogle(query, config);
        if (search.results?.length) return search;
        errors.push(`${search.provider || "google"}: ${search.error || "no results"}`);
        continue;
      }
      const results = name === "baidu"
        ? await searchBaidu(query, config)
        : name === "duckduckgo"
          ? await searchDuckDuckGo(query, config)
          : await searchBing(query, config);
      const ranked = rankSearchResults(results, query, config).slice(0, maxResults);
      if (ranked.length) return { provider: name, results: ranked };
      errors.push(`${name}: no results`);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { provider: providers.join(","), results: [], error: errors.join("; ") };
}

async function buildWebSearchContext(decision, config) {
  if (!decision?.matched) return { text: "", result: null };
  const query = clampText(decision.query, Number(config.webSearch?.maxQueryLength || 120));
  try {
    if (decision.kind === "weather" || isWeatherQuery(query)) {
      const location = decision.location || extractWeatherLocation(query, config);
      if (location) {
        try {
          const weather = await fetchWeather(location, query, config);
          return { text: formatWeatherContext(weather, query), result: { provider: weather.provider, results: [], weather } };
        } catch (err) {
          return { text: `查询：${query}\n类型：天气直查\n请求地点：${location}\n结果：天气源请求失败：${err.message}\n回答要求：不要用普通网页结果硬编天气；请告诉用户天气源暂时没查到。`, result: { provider: "weather", results: [], error: err.message } };
        }
      }
      return { text: `查询：${query}\n类型：天气直查\n结果：没有识别到城市/地点。\n回答要求：请反问用户要查哪个城市，不要硬编天气。`, result: { provider: "weather", results: [], error: "missing location" } };
    }
    const search = await webSearch(query, config);
    if (!search.results.length) return { text: `查询：${query}\n搜索源：${search.provider}\n结果：没有搜到可用结果。${search.error ? `\n错误：${search.error}` : ""}`, result: search };
    const lines = search.results.map((item, index) => {
      const snippet = item.snippet ? `\n   摘要：${item.snippet}` : "";
      const score = item.score != null ? `\n   相关性分数：${item.score}` : "";
      const source = item.source ? `\n   来源搜索：${item.source}` : "";
      return `${index + 1}. ${item.title}\n   链接：${item.link}${snippet}${score}${source}`;
    });
    return { text: `查询：${query}\n搜索源：${search.provider}\n搜索时间：${localNowText()}\n核心关键词：${searchCoreTerms(query).join("、") || "（无）"}\n结果：\n${lines.join("\n")}\n回答要求：只基于标题/摘要/链接中和核心关键词直接相关的结果回答；如果结果不够相关或互相矛盾，先说明“搜到的结果不够准/不确定”，不要硬编。`, result: search };
  } catch (err) {
    return { text: `查询：${query}\n搜索失败：${err.message}`, result: { provider: "unknown", results: [], error: err.message } };
  }
}

function webSearchPreReply(decision, config) {
  const cfg = config.webSearch?.preReply || {};
  if (cfg.enabled === false) return "";
  const templates = cfg.templates?.length ? cfg.templates : [
    "我搜一下，等我几秒。",
    "等下，我去翻一下网页。",
    "我查一下，别急。"
  ];
  const template = templates[Math.floor(Math.random() * templates.length)] || "";
  return trimForGroup(template.replace(/\{query\}/g, decision?.query || ""), config);
}

function buildPrompt({ config, history, current, mode, memoryText = "", contextBundle = null, webSearchContext = "", archiveContext = "" }) {
  const system = config.prompt?.system || "";
  const displayName = botDisplayName(config);
  const accountCfg = accountFailoverConfig(config);
  const accountMappings = accountCfg.all
    .map((account) => `${account.role === "primary" ? "主账号" : "备用账号"} ${account.id}：${account.displayName || account.id}${account.qq ? `（QQ ${account.qq}）` : ""}`)
    .join("\n") || "（未配置）";
  const accountIdentity = [
    `当前发言账号：${displayName}`,
    `账号ID：${config.__activeAccountId || "primary"}`,
    `账号角色：${config.__activeAccountRole || "primary"}`,
    `账号映射：\n${accountMappings}`,
    "重要：回复时要知道自己当前就是这个账号；不要把主账号和备用账号混为一谈。"
  ].join("\n");
  const recent = contextBundle?.recentMessages || compactHistory(history.slice(-Math.max(1, config.history?.promptRecentMessages ?? config.history?.maxMessages ?? 40)));
  const socialDecision = current?.socialDecision;
  const socialDecisionText = socialDecision
    ? `意图:${socialDecision.intent}；语气:${socialDecision.tone}；长度:${socialDecision.length}；目标:${asArray(socialDecision.targetUserIds).join("、") || asStringId(current?.user_id)}；理由:${socialDecision.reason || "无"}`
    : "（明确消息或未使用社交判断）";
  const ownerPrivate = current?.isPrivate && isPrivateOwner(current?.user_id, config);
  const currentTimeContext = [
    `当前系统时间：${formatMessageTime(Date.now(), config)}`,
    `当前消息发送时间：${formatMessageTime(current?.sentAtMs || current?.at || Date.now(), config)}`,
    current?.receivedAt ? `桥接接收时间：${formatMessageTime(current.receivedAt, config)}` : ""
  ].filter(Boolean).join("\n");
  if (ownerPrivate) {
    const ownerSystem = config.privateChats?.ownerSystem || `你正在和 QQ 号 ${current.user_id} 进行一对一私聊。对方是 bot 的主人/管理员。
这里不是群聊，不要套用群聊插科打诨优先的策略。你的优先级是：
1. 优先理解并遵循对方的明确指令；
2. 如果指令涉及你无法直接执行的外部操作或服务器改动，要诚实说明自己在 QQ 内不能直接完成，并给出可操作步骤；
3. 可以保持“小跟班”的亲近语气，但不要为了人设而故意反驳、抬杠或把命令当玩笑；
4. 私聊中的上下文、称呼、临时偏好只用于这个私聊，不要影响群聊里的互动判断；
5. 群聊人格、群梗、群成员记忆不能覆盖主人在私聊里的直接要求；
6. 回答要清楚、可执行、尽量短。`;
    return `${ownerSystem}

【私聊历史】
${recent || "（暂无）"}

【当前账号身份】
${accountIdentity}

【这个私聊里的相关记忆】
${memoryText || contextBundle?.selectedMemory || "（暂无）"}

【相关历史片段】
${archiveContext || "（本次未检索或无相关历史）"}

【联网搜索结果】
${webSearchContext || "（本次未联网搜索）"}

【主人当前消息】
${current.sender}: ${current.text}

【时间语境】
${currentTimeContext}

【主人当前消息回复关系】
${formatReplyContextsForPrompt(current?.replyContexts) || "（无明确引用）"}

【回复要求】
把这条消息当作私聊指令/请求来处理。能按要求做的就明确响应；不能做的说明限制和下一步。不要把它当群聊接梗，不要输出 __SKIP__。不要重复最近 bot 回复的固定开头或模板句，直接承接当前语境。只输出要发给对方的内容。`;
  }
  const instruction = {
    proactive: "你正在主动插话。先判断有没有必要说；如果没有很好的接话点，只输出 __SKIP__。如果要说，只接最近上下文，不要把很久以前的话硬拽回来，不超过2句。",
    implicit: "这条消息没有明确 @ 你，但上下文判断大概率是在接你上一句话。请积极回应，同时别装作自己被明确点名；自然承接即可，不超过3句。",
    private: "这是 QQ 私聊窗口。请直接回复对方，语气自然，联系上下文和记忆；不要表现得像在群里插话，不超过4句。",
    web: "这是一次受控联网搜索回复。必须优先基于【联网搜索结果】回答；不要编造搜索结果里没有的信息。如果结果类型是“天气直查”，直接给天气结论和简单提醒，不要说成翻网页；如果结果不足或搜索失败就直说没查到可靠结果。可以附 1-2 个最有用链接，保持像群友说话，不要超过4句。",
    delayed: "这是一段你刚才没完全看懂、于是等了几秒后拿到的连续上下文。先判断这些话是否值得你统一回复：如果后续消息表明不是在跟你说、你没必要插话、或已有别人接上了，只输出 __SKIP__；如果要回复，就把几条消息当成一个小片段统一回应，不要逐条刷屏，不超过3句。",
    morning: "请发一条自然的群早安，轻松一点，不要超过2句。",
    evening: "请发一条自然的晚间问候或收尾，别像公告，不要超过2句。",
    summary: "请总结今天这个群的聊天内容，保留有趣的梗和待办，不要超过5条。",
    reply: "请联系完整上下文回复最后一条群消息。先判断对方是在认真问、玩梗、吐槽还是赶你走；像机灵损友一样自然接话，不要超过3句。"
  }[mode] || "请回复最后一条群消息，像群友一样自然接话，不要超过3句。";

  return `${system}

【当前账号身份】
${accountIdentity}

【更早群聊摘要】
${contextBundle?.rollingSummary || "（暂无）"}

【当前话题/未完结内容】
${contextBundle?.topics || "（暂无）"}

【群梗/群内事实】
${contextBundle?.facts || "（暂无）"}

【bot 自我记忆】
${contextBundle?.botSelf || "（暂无）"}

【最近群聊原文】
${recent || "（暂无）"}

【相关成员记忆】
${contextBundle?.selectedMemory || memoryText || "（暂无）"}

【相关历史片段】
${archiveContext || "（本次未检索或无相关历史）"}

【反馈状态】
${contextBundle?.feedback || "（暂无）"}

【联网搜索结果】
${webSearchContext || "（本次未联网搜索）"}

【当前消息】
${current.sender}: ${current.text}

【时间语境】
${currentTimeContext}

【当前消息回复关系】
${formatReplyContextsForPrompt(current?.replyContexts) || "（无明确引用）"}

【社交判断】
${socialDecisionText}

【要求】
${instruction}
回答时优先遵守【bot 自我记忆】：知道自己是谁、自己的性格、能力边界、最近说过什么；如果群友问“你是谁/你刚才说了什么/你能不能看图”，要基于这里和最近原文回答。
历史和引用片段都带有原消息时间。必须区分当前消息、刚才的连续消息和很久以前检索出的内容；不能把旧事件说成刚发生，也不能把记忆中的不同 QQ 号混为同一人。
你当前对外昵称是“${displayName}”。如果你是备用账号，不要自称主账号；如果被问为什么换号/是谁，可以简短说明这是备用号在接管。
像真实群友一样短句输出。根据【社交判断】控制语气和长度，但不要在回复中提到这些内部标签。不要重复最近 bot 回复的固定开头、口头禅或模板句，直接承接当前语境。不会的事就承认不会；不要承诺转账、充值、@群主、管理群或发图。可以基于【最近群聊原文】里的图片识别结果聊图片；如果没有图片识别结果，就不要假装看到了图片细节。不要乱报底层模型；被问模型时说“我是 Hermes 接进 QQ 的 AI 群友，具体底层模型我不乱报”。最多 1 个 emoji。只输出要发到群里的内容，不要解释。`;
}

function reviewerConfig(config = {}) {
  const cfg = config.reviewer || {};
  return {
    enabled: false,
    runtimeDisabled: true,
    configuredEnabled: cfg.enabled !== false,
    shadowMode: cfg.shadowMode === true,
    mode: cfg.mode || "adaptive",
    provider: cfg.provider || config.ai?.provider || "",
    model: cfg.model || config.ai?.model || "",
    reasoningEffort: cfg.reasoningEffort || "low",
    timeoutMs: Math.max(2000, Number(cfg.timeoutMs || 12_000)),
    minLength: Math.max(40, Number(cfg.minLength || 160)),
    maxContextChars: Math.max(1000, Number(cfg.maxContextChars || 7000)),
    failOpenLowRisk: cfg.failOpenLowRisk !== false
  };
}

function callHermes(prompt, config, { signal } = {}) {
  const command = config.ai?.command || "hermesqq2";
  const args = [...normalizeAiArgs(config.ai?.args || ["-z"]), prompt];
  const timeoutMs = Number(config.ai?.timeoutMs || 120000);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("AI generation cancelled");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const child = spawn(command, args, {
      cwd: commandCwd,
      env: hermesRuntimeEnv(config),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn(value);
    };
    const abort = () => {
      child.kill("SIGTERM");
      const error = new Error("AI generation cancelled");
      error.name = "AbortError";
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`AI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      finish(reject, err);
    });
    child.on("close", (code, closeSignal) => {
      if (signal?.aborted) return;
      if (code === 0) return finish(resolve, stdout.trim());
      finish(reject, new Error(closeSignal
        ? `AI command terminated by signal ${closeSignal}: ${stderr.slice(-1200)}`
        : `AI command exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function downloadUrlToBuffer(url, { timeoutMs = 15000, maxBytes = 32 * 1024 * 1024, redirects = 2 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("invalid image url"));
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, { timeout: timeoutMs, headers: { "user-agent": "qq-hermes-bot/0.1" } }, (res) => {
      const status = Number(res.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, parsed).toString();
        downloadUrlToBuffer(nextUrl, { timeoutMs, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`image download http ${status}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`image too large > ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "") }));
    });
    req.on("timeout", () => req.destroy(new Error("image download timeout")));
    req.on("error", reject);
  });
}

function imageExtFromContentType(contentType, url = "") {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  const pathname = (() => {
    try { return new URL(url).pathname; } catch { return ""; }
  })();
  const ext = path.extname(pathname).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
}

function localImagePathFromSource(source) {
  let value = String(source || "").trim();
  if (!value || /^https?:\/\//i.test(value)) return "";
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      value = value.replace(/^file:\/\//i, "");
    }
  }

  const candidates = [];
  if (path.isAbsolute(value)) {
    candidates.push(value);
    if (value.startsWith("/app/.config/QQ/")) {
      candidates.push(path.join(stateRoot, "napcat", "QQ", value.slice("/app/.config/QQ/".length)));
    }
    if (value.startsWith("/app/napcat/config/")) {
      candidates.push(path.join(stateRoot, "napcat", "config", value.slice("/app/napcat/config/".length)));
    }
    if (value.startsWith("/app/napcat/plugins/")) {
      candidates.push(path.join(stateRoot, "napcat", "plugins", value.slice("/app/napcat/plugins/".length)));
    }
  } else {
    candidates.push(path.resolve(stateRoot, value));
    candidates.push(path.resolve(stateRoot, "napcat", "QQ", value));
    candidates.push(path.resolve(stateRoot, "napcat", "config", value));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore unreadable candidate
    }
  }
  return "";
}

function prepareVisionImagePath(filePath, config) {
  const cfg = config.vision || {};
  const maxHermesBytes = Number(cfg.maxHermesImageBytes || 6 * 1024 * 1024);
  const resizeMaxPixels = Math.round(Number(cfg.resizeMaxPixels || 1800));
  const jpegQuality = Math.round(Number(cfg.jpegQuality || 84));
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return filePath;
  }
  if (!stat.isFile() || stat.size <= maxHermesBytes) return filePath;

  fs.mkdirSync(imageCacheDir, { recursive: true });
  const outPath = path.join(imageCacheDir, `${Date.now()}-${Math.random().toString(16).slice(2)}-vision.jpg`);
  const result = spawnSync("sips", [
    "-Z",
    String(Math.max(600, Math.min(resizeMaxPixels || 1800, 4096))),
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    String(Math.max(40, Math.min(jpegQuality || 84, 95))),
    filePath,
    "--out",
    outPath
  ], { encoding: "utf8", timeout: 30000 });

  if (result.status === 0 && fs.existsSync(outPath)) {
    try {
      const outStat = fs.statSync(outPath);
      if (outStat.size > 0) {
        log(`vision compressed image ${stat.size} -> ${outStat.size} bytes`);
        return outPath;
      }
    } catch {
      // fall through
    }
  }
  warn(`vision image compression failed, using original: ${String(result.stderr || result.error?.message || "unknown").slice(-300)}`);
  return filePath;
}

function cleanupImageCache(config) {
  try {
    if (!fs.existsSync(imageCacheDir)) return;
    const maxAgeMs = Number(config.vision?.cacheMaxAgeMs || 24 * 60 * 60 * 1000);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(imageCacheDir)) {
      const filePath = path.join(imageCacheDir, name);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch (err) {
    warn(`image cache cleanup failed: ${err.message}`);
  }
}

async function downloadImageRef(ref, config, helpers = {}) {
  const cfg = config.vision || {};
  let imageSource = ref?.url || "";
  if ((!imageSource || (!/^https?:\/\//i.test(imageSource) && !localImagePathFromSource(imageSource))) && typeof helpers.getImageUrl === "function") {
    imageSource = await helpers.getImageUrl(ref);
  }
  const localPath = localImagePathFromSource(imageSource);
  if (localPath) {
    log(`vision using local image file image#${ref.index}: ${localPath}`);
    return prepareVisionImagePath(localPath, config);
  }
  if (!imageSource || !/^https?:\/\//i.test(imageSource)) throw new Error("missing downloadable image url");
  fs.mkdirSync(imageCacheDir, { recursive: true });
  cleanupImageCache(config);
  const maxBytes = Number(cfg.maxImageBytes || 32 * 1024 * 1024);
  log(`vision downloading image#${ref.index} maxBytes=${maxBytes}`);
  const { buffer, contentType } = await downloadUrlToBuffer(imageSource, {
    timeoutMs: Number(cfg.downloadTimeoutMs || 15000),
    maxBytes
  });
  const ext = imageExtFromContentType(contentType, imageSource);
  const filePath = path.join(imageCacheDir, `${Date.now()}-${Math.random().toString(16).slice(2)}-${ref.index}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return prepareVisionImagePath(filePath, config);
}

function callHermesWithImage(prompt, imagePath, config) {
  const command = config.ai?.command || "hermesqq2";
  const ai = aiSettingsFromConfig(config);
  const provider = stringValue(config.vision?.provider || ai.provider).trim();
  const model = stringValue(config.vision?.model || ai.model).trim();
  const toolsets = stringValue(config.vision?.toolsets || "vision").trim();
  const args = [...hermesProfileArgPrefix(config), "chat", "-q", prompt, "--image", imagePath, "-Q"];
  if (model) args.push("-m", model);
  if (provider) args.push("--provider", provider);
  if (toolsets) args.push("-t", toolsets);
  const timeoutMs = Number(config.vision?.timeoutMs || config.ai?.timeoutMs || 120000);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: commandCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`vision timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const cleaned = stdout
          .split(/\r?\n/)
          .filter((line) => !/^session_id:/i.test(line.trim()))
          .join("\n")
          .trim();
        resolve(cleaned);
        return;
      }
      reject(new Error(`vision command exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function describeImageRef(ref, text, config, helpers = {}) {
  const imagePath = await downloadImageRef(ref, config, helpers);
  const prompt = config.vision?.prompt || `请用中文简洁描述这张 QQ 聊天图片，重点包括：
1. 图片里主要有什么；
2. 如果是截图/表情包/文字图，尽量读出关键文字；
3. 如果用户正在问图，请给出可用于聊天回复的判断。
不要编造看不见的细节。输出 1-3 句。`;
  const meta = `\n\n图片来源：${ref?.source === "quoted" ? "用户引用的历史消息" : "用户当前消息"}；图片类型：${["mface", "bface", "marketface"].includes(ref?.kind) ? "图片表情包" : "普通图片"}。`;
  const question = text ? `\n用户同一条消息文字：${clampText(text, 400)}` : "";
  const description = clampText(await callHermesWithImage(`${prompt}${meta}${question}`, imagePath, config), Number(config.vision?.maxDescriptionLength || 260));
  return { description, imagePath };
}

async function maybeDescribeImages({ imageRefs, text, mentioned, keyword, isPrivate, config, helpers = {}, history = [], current = null, quotedTexts = [], visionContext = null }) {
  const decision = await judgeVisionWithAI({ imageRefs, text, mentioned, keyword, isPrivate, config, history, current, quotedTexts, visionContext });
  if (!decision.matched) {
    if (imageRefs?.length) log(`vision skip reason=${decision.reason || "not needed"} confidence=${Number(decision.confidence || 0).toFixed(2)}`);
    return [];
  }
  const cfg = config.vision || {};
  const max = Math.max(1, Math.min(Number(cfg.maxImagesPerMessage || 2), 4));
  const selected = new Set(asArray(decision.selectedIndexes).map(Number));
  const selectedRefs = selected.size
    ? imageRefs.filter((ref) => selected.has(Number(ref.index)))
    : imageRefs;
  const descriptions = [];
  log(`vision start images=${imageRefs.length} using=${Math.min(selectedRefs.length, max)} reason=${decision.reason || ""} confidence=${Number(decision.confidence || 0).toFixed(2)} trigger=${JSON.stringify({ mentioned, keyword, isPrivate })} refs=${selectedRefs.slice(0, max).map(imageRefDebug).join(",")}`);
  for (const ref of selectedRefs.slice(0, max)) {
    try {
      const described = await describeImageRef(ref, text, config, helpers);
      const description = typeof described === "string" ? described : described.description;
      const localPath = described?.imagePath ? path.relative(stateRoot, described.imagePath) : "";
      descriptions.push({ index: ref.index, source: ref.source || "current", kind: ref.kind || "image", messageId: ref.messageId || "", ok: true, description, localPath });
      log(`vision described ${imageRefDisplayName(ref)}: ${clampText(description, 120)}`);
    } catch (err) {
      warn(`vision failed ${imageRefDisplayName(ref)}: ${err.message}`);
      descriptions.push({ index: ref.index, source: ref.source || "current", kind: ref.kind || "image", messageId: ref.messageId || "", ok: false, error: clampText(err.message, 120) });
    }
  }
  return descriptions;
}

function appendImageDescriptions(text, descriptions) {
  const base = String(text || "").trim();
  const lines = asArray(descriptions)
    .map((item) => {
      if (!item?.ok || !item.description) return "";
      const emoji = ["mface", "bface", "marketface"].includes(item.kind);
      const label = `${item.source === "quoted" ? "引用" : ""}${emoji ? "图片表情" : "图片"}#${item.index}`;
      return `[${label}识别：${item.description}]`;
    })
    .filter(Boolean);
  return [base, ...lines].filter(Boolean).join("\n").trim();
}

function chatArchiveConfig(config = {}) {
  const cfg = config.chatArchive || {};
  return {
    enabled: cfg.enabled !== false,
    defaultOn: cfg.defaultOn !== false,
    baseDir: path.resolve(stateRoot, stringValue(cfg.baseDir || "data/chat-archive")),
    saveImages: cfg.saveImages !== false,
    privacyFilter: cfg.privacyFilter !== false,
    maxRetrieveItems: Math.max(1, Math.min(20, Number(cfg.maxRetrieveItems || 8))),
    maxScanLines: Math.max(100, Math.min(5000, Number(cfg.maxScanLines || 1200))),
    indexEnabled: cfg.index?.enabled !== false,
    summaryEveryMessages: Math.max(10, Math.min(500, Number(cfg.summary?.everyMessages || 50)))
  };
}

function archiveConversationMetaFromEvent(event, config = {}) {
  const cfg = chatArchiveConfig(config);
  const isPrivate = event?.message_type === "private";
  const id = isPrivate ? asStringId(event?.user_id) : asStringId(event?.group_id);
  const kind = isPrivate ? "private" : "groups";
  const conversationId = isPrivate ? `private:${id}` : `group:${id}`;
  const dir = path.join(cfg.baseDir, kind, safePathSegment(id || "unknown", "unknown"));
  return {
    id,
    kind,
    conversationId,
    dir,
    messagesPath: path.join(dir, "messages.jsonl"),
    indexPath: path.join(dir, "index.json"),
    summaryPath: path.join(dir, "summary.json"),
    mediaDir: path.join(dir, "media")
  };
}

function archiveConversationSettings(memory, conversationId, { create = false } = {}) {
  if (!memory || typeof memory !== "object") return {};
  if (!memory.chatArchive || typeof memory.chatArchive !== "object") {
    if (!create) return {};
    memory.chatArchive = {};
  }
  if (!memory.chatArchive.conversations || typeof memory.chatArchive.conversations !== "object") {
    if (!create) return {};
    memory.chatArchive.conversations = {};
  }
  const key = String(conversationId || "");
  if (!key) return {};
  if (!memory.chatArchive.conversations[key]) {
    if (!create) return {};
    memory.chatArchive.conversations[key] = {};
  }
  return memory.chatArchive.conversations[key];
}

function archiveEnabledForConversation(memory, conversationId, config = {}) {
  const cfg = chatArchiveConfig(config);
  if (!cfg.enabled) return false;
  const settings = archiveConversationSettings(memory, conversationId);
  if (settings.archiveEnabled === false) return false;
  if (settings.archiveEnabled === true) return true;
  return cfg.defaultOn !== false;
}

function archiveKeywords(text, config = {}) {
  const stop = new Set([
    "这个", "那个", "就是", "然后", "感觉", "一下", "可以", "不是", "什么", "怎么", "为什么",
    "哈哈", "笑死", "真的", "现在", "今天", "刚才", "之前", "上次", "一个", "我们", "你们"
  ]);
  const raw = stripBotAddressing(String(text || ""), config)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^\p{Script=Han}A-Za-z0-9_.-]+/gu, " ")
    .trim();
  const terms = [];
  for (const part of raw.split(/\s+/)) {
    const cleaned = part.trim();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 40 || stop.has(cleaned)) continue;
    terms.push(cleaned);
    if (/^\p{Script=Han}{4,}$/u.test(cleaned)) {
      for (let i = 0; i < cleaned.length - 1; i += 1) {
        const bi = cleaned.slice(i, i + 2);
        if (!stop.has(bi)) terms.push(bi);
      }
    }
  }
  return Array.from(new Set(terms)).slice(0, 32);
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

function readLastJsonlRecords(filePath, maxLines = 60, maxBytes = 512 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(maxLines || 60)))
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    warn(`archive read jsonl failed file=${filePath}: ${err.message}`);
    return [];
  }
}

function archiveImageRecord(ref = {}, descriptions = []) {
  const matched = asArray(descriptions).find((item) => Number(item.index) === Number(ref.index) && (item.source || "current") === (ref.source || "current"));
  return {
    index: ref.index,
    source: ref.source || "current",
    kind: ref.kind || "image",
    file: ref.file || "",
    url: ref.url ? clampText(ref.url, 500) : "",
    messageId: ref.messageId || "",
    ok: matched?.ok ?? null,
    description: matched?.description || "",
    localPath: matched?.localPath || "",
    error: matched?.error || ""
  };
}

function updateArchiveIndex(meta, record, config = {}) {
  const cfg = chatArchiveConfig(config);
  if (!cfg.indexEnabled) return;
  const index = readJsonFileSafe(meta.indexPath, {
    conversationId: meta.conversationId,
    kind: meta.kind,
    messageCount: 0,
    botReplyCount: 0,
    webSearchCount: 0,
    keywords: {},
    recent: []
  });
  index.conversationId = meta.conversationId;
  index.kind = meta.kind;
  index.messageCount = Number(index.messageCount || 0) + 1;
  if (record.type === "bot_reply") index.botReplyCount = Number(index.botReplyCount || 0) + 1;
  if (record.type === "web_search") index.webSearchCount = Number(index.webSearchCount || 0) + 1;
  index.updatedAt = record.time || new Date().toISOString();
  index.lastMessageAt = record.time || index.lastMessageAt || "";
  index.recent = asArray(index.recent);
  index.recent.push({
    type: record.type,
    time: record.time,
    senderId: record.senderId,
    senderName: record.senderName,
    text: clampText(record.text || record.summary || record.query || "", 180)
  });
  while (index.recent.length > 40) index.recent.shift();
  index.keywords ||= {};
  for (const kw of archiveKeywords([record.text, record.rawText, record.summary, record.query].filter(Boolean).join(" "), config)) {
    index.keywords[kw] = Number(index.keywords[kw] || 0) + 1;
  }
  const sorted = Object.entries(index.keywords).sort((a, b) => b[1] - a[1]).slice(0, 500);
  index.keywords = Object.fromEntries(sorted);
  writeJsonFileSafe(meta.indexPath, index);
}

function summarizeArchiveIfNeeded(meta, memory, config = {}) {
  const cfg = chatArchiveConfig(config);
  const index = readJsonFileSafe(meta.indexPath, {});
  const count = Number(index.messageCount || 0);
  if (!count || count % cfg.summaryEveryMessages !== 0) return;
  const memoryGroupId = meta.kind === "groups" ? meta.id : meta.conversationId;
  const gm = groupMemory(memory || { groups: {} }, memoryGroupId);
  const summary = {
    conversationId: meta.conversationId,
    updatedAt: new Date().toISOString(),
    messageCount: count,
    rollingSummary: gm.rollingSummary || "",
    topics: asArray(gm.topics).slice(-20),
    facts: asArray(gm.facts).slice(-30),
    topKeywords: Object.entries(index.keywords || {}).sort((a, b) => b[1] - a[1]).slice(0, 40)
  };
  writeJsonFileSafe(meta.summaryPath, summary);
  appendJsonl(meta.messagesPath, {
    type: "summary",
    conversationId: meta.conversationId,
    time: summary.updatedAt,
    text: summary.rollingSummary,
    summary
  });
}

function archiveConversationEvent({ event, config, memory, text = "", rawText = "", senderName = "", accountId = "", imageRefs = [], imageDescriptions = [], replyContexts = [] }) {
  try {
    const meta = archiveConversationMetaFromEvent(event, config);
    if (!archiveEnabledForConversation(memory, meta.conversationId, config)) return null;
    const timing = messageTiming(event, { receivedAt: event?.__receivedAt || Date.now(), processedAt: Date.now() });
    const record = {
      type: "user_message",
      conversationId: meta.conversationId,
      messageId: event?.message_id ?? "",
      messageType: event?.message_type || "",
      time: timing.sentAt,
      sentAt: timing.sentAt,
      sentAtMs: timing.sentAtMs,
      receivedAt: timing.receivedAt,
      processedAt: timing.processedAt,
      senderId: asStringId(event?.user_id),
      senderName: senderName || event?.sender?.nickname || asStringId(event?.user_id),
      groupCard: event?.sender?.card || "",
      text: chatArchiveConfig(config).privacyFilter ? redactSensitive(text || rawText || "", config) : String(text || rawText || ""),
      rawText: chatArchiveConfig(config).privacyFilter ? redactSensitive(rawText || text || "", config) : String(rawText || text || ""),
      images: asArray(imageRefs).map((ref) => archiveImageRecord(ref, imageDescriptions)),
      quotedMessage: {
        ids: extractReplyMessageIds(event?.message || event?.raw_message || ""),
        contexts: asArray(replyContexts).map((ctx) => ({
          messageId: asStringId(ctx?.messageId),
          senderId: asStringId(ctx?.senderId),
          senderName: ctx?.senderName || "",
          text: clampText(ctx?.text || "", 500),
          sentAt: ctx?.sentAt || "",
          sentAtMs: Number(ctx?.sentAtMs || 0),
          isBot: ctx?.isBot === true,
          resolved: ctx?.resolved === true
        }))
      },
      mentions: asArray(event?.message).filter((seg) => seg?.type === "at").map((seg) => asStringId(seg?.data?.qq)).filter(Boolean),
      accountId: accountId || config.__activeAccountId || "primary",
      botDisplayName: botDisplayName(config)
    };
    appendJsonl(meta.messagesPath, record);
    updateArchiveIndex(meta, record, config);
    summarizeArchiveIfNeeded(meta, memory, config);
    return record;
  } catch (err) {
    warn(`archive user message failed: ${err.message}`);
    return null;
  }
}

function archiveBotReply({ event, config, memory, text = "", meta: replyMeta = {} }) {
  try {
    const archiveMeta = archiveConversationMetaFromEvent(event, config);
    if (!archiveEnabledForConversation(memory, archiveMeta.conversationId, config)) return null;
    const sentAtMs = Date.now();
    const record = {
      type: "bot_reply",
      conversationId: archiveMeta.conversationId,
      messageId: "",
      messageType: event?.message_type || "",
      time: new Date(sentAtMs).toISOString(),
      sentAt: new Date(sentAtMs).toISOString(),
      sentAtMs,
      receivedAt: "",
      processedAt: new Date(sentAtMs).toISOString(),
      senderId: asStringId(replyMeta.user_id || event?.self_id || "bot"),
      senderName: botDisplayName(config),
      groupCard: "",
      text: chatArchiveConfig(config).privacyFilter ? redactSensitive(text, config) : String(text || ""),
      rawText: chatArchiveConfig(config).privacyFilter ? redactSensitive(text, config) : String(text || ""),
      images: [],
      quotedMessage: replyMeta.replyToUserId ? { replyToUserId: asStringId(replyMeta.replyToUserId), replyToSender: replyMeta.replyToSender || "" } : {},
      mentions: asArray(replyMeta.mentionedUserIds).map(asStringId).filter(Boolean),
      accountId: config.__activeAccountId || "primary",
      botDisplayName: botDisplayName(config),
      source: replyMeta.source || ""
    };
    appendJsonl(archiveMeta.messagesPath, record);
    updateArchiveIndex(archiveMeta, record, config);
    summarizeArchiveIfNeeded(archiveMeta, memory, config);
    return record;
  } catch (err) {
    warn(`archive bot reply failed: ${err.message}`);
    return null;
  }
}

function archiveWebSearchResult({ event, config, memory, decision, searchResult = {}, contextText = "", usedConclusion = "" }) {
  try {
    const archiveMeta = archiveConversationMetaFromEvent(event, config);
    if (!archiveEnabledForConversation(memory, archiveMeta.conversationId, config)) return null;
    const record = {
      type: "web_search",
      conversationId: archiveMeta.conversationId,
      time: new Date().toISOString(),
      query: decision?.query || "",
      kind: decision?.kind || "web",
      provider: searchResult.provider || "",
      summary: clampText(contextText, 1600),
      usedConclusion: clampText(usedConclusion, 800),
      uncertainty: searchResult.error || decision?.reason || "",
      sources: asArray(searchResult.results).slice(0, 8).map((item) => ({
        title: item.title || "",
        link: item.link || "",
        snippet: clampText(item.snippet || "", 260),
        source: item.source || searchResult.provider || ""
      })),
      accountId: config.__activeAccountId || "primary",
      botDisplayName: botDisplayName(config)
    };
    appendJsonl(archiveMeta.messagesPath, record);
    updateArchiveIndex(archiveMeta, { ...record, text: `${record.query}\n${record.summary}` }, config);
    return record;
  } catch (err) {
    warn(`archive web search failed: ${err.message}`);
    return null;
  }
}

function shouldRetrieveArchiveContext({ current, history = [], memory, groupId, config, mode = "" }) {
  const cfg = chatArchiveConfig(config);
  if (!cfg.enabled) return { needed: false, reason: "archive disabled" };
  const text = String(current?.text || "");
  const gm = groupMemory(memory || { groups: {} }, groupId || current?.conversationId || "");
  const contextMarkers = /(刚才|之前|上次|前面|上面|那个|这个|它|他说|她说|你还记得|还记得吗|记不记得|老梗|梗|外号|昵称|称呼|关系|偏好|上回|上一次|刚刚|图片|截图|表情包|文件|链接|计划|项目|安排|结论)/;
  const shortVague = text.length > 0 && text.length <= 28 && /(这个|那个|它|他|她|这|那|咋办|怎么改|什么意思|啥意思|可以吗|然后呢)/.test(text);
  const mentionsKnown = relatedUserIdsFromText(text, gm).length > 0;
  const discussionMode = ["active", "proactive", "implicit", "reply", "web", "delayed", "decision"].includes(mode);
  const hasTopicMemory = asArray(gm.topics).some((t) => text.includes(String(t).slice(0, 4))) || asArray(gm.facts).some((f) => text.includes(String(f).slice(0, 4)));
  if (asArray(current?.replyContexts).length) return { needed: true, reason: "quoted/replied message" };
  if (contextMarkers.test(text)) return { needed: true, reason: "context marker" };
  if (mentionsKnown) return { needed: true, reason: "known member mentioned" };
  if (shortVague) return { needed: true, reason: "short vague reference" };
  if (hasTopicMemory) return { needed: true, reason: "topic/fact memory matched" };
  if (discussionMode && asArray(history).slice(-8).filter((m) => !m.isBot).length >= 4 && text.length >= 4) return { needed: true, reason: "ongoing discussion" };
  return { needed: false, reason: "not needed" };
}

function scoreArchiveRecord(record, terms = [], { senderId = "", relatedUserIds = [], relatedMessageIds = [], nowMs = Date.now() } = {}) {
  const haystack = [record.text, record.rawText, record.summary, record.query, record.senderName].filter(Boolean).join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const t = String(term || "").toLowerCase();
    if (!t) continue;
    if (haystack.includes(t)) score += Math.min(6, Math.max(1, t.length / 2));
  }
  if (record.type === "summary") score += 1;
  if (record.type === "web_search") score += 1.5;
  if (senderId && asStringId(record.senderId) === asStringId(senderId)) score += 1.5;
  if (asArray(relatedUserIds).map(asStringId).includes(asStringId(record.senderId))) score += 2.5;
  if (asArray(relatedMessageIds).map(asStringId).includes(asStringId(record.messageId))) score += 12;
  const at = Number(record.sentAtMs || 0) || Date.parse(record.sentAt || record.time || "") || 0;
  if (at) {
    const ageDays = Math.max(0, (nowMs - at) / 86400000);
    score += Math.max(0, 3 - Math.log10(ageDays + 1) * 1.5);
    if (ageDays > 180) score -= 1;
  }
  return score;
}

function retrieveArchiveSnippets({ event, current, config, memory = null, groupId = "", maxItems = null }) {
  const cfg = chatArchiveConfig(config);
  const meta = archiveConversationMetaFromEvent(event, config);
  const gm = groupMemory(memory || { groups: {} }, groupId || meta.conversationId);
  const relatedIds = relatedUserIdsFromText(current?.text || "", gm);
  const relatedMessageIds = asArray(current?.replyContexts).map((ctx) => asStringId(ctx?.messageId)).filter(Boolean);
  const relatedNames = relatedIds.flatMap((id) => {
    const user = gm.users?.[id] || {};
    return [user.lastName, ...asArray(user.names), ...asArray(user.aliases)].filter(Boolean);
  });
  const terms = Array.from(new Set([
    ...archiveKeywords(current?.text || "", config),
    ...relatedNames.flatMap((name) => archiveKeywords(name, config))
  ])).slice(0, 48);
  const recent = readLastJsonlRecords(meta.messagesPath, Math.min(30, cfg.maxScanLines), 256 * 1024);
  const scan = readLastJsonlRecords(meta.messagesPath, cfg.maxScanLines, 2 * 1024 * 1024);
  const limit = Math.max(1, Number(maxItems || cfg.maxRetrieveItems));
  const hasStructuredTarget = relatedMessageIds.length > 0 || relatedIds.length > 0;
  const byScore = (terms.length || hasStructuredTarget) ? scan
    .map((record) => ({ record, score: scoreArchiveRecord(record, terms, {
      senderId: current?.user_id,
      relatedUserIds: relatedIds,
      relatedMessageIds,
      nowMs: Number(current?.sentAtMs || current?.at || Date.now())
    }) }))
    .filter((item) => {
      if (item.score <= 0) return false;
      const termMatch = terms.some((term) => [item.record.text, item.record.rawText, item.record.summary, item.record.query, item.record.senderName].filter(Boolean).join("\n").toLowerCase().includes(String(term).toLowerCase()));
      const messageMatch = relatedMessageIds.includes(asStringId(item.record.messageId));
      const userMatch = relatedIds.includes(asStringId(item.record.senderId));
      return termMatch || messageMatch || userMatch;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.record) : [];
  const seen = new Set();
  const recentKeep = recent.slice(-Math.min(4, limit));
  const relevantKeep = byScore.filter((record) => !recentKeep.some((recentRecord) => (
    recentRecord.time === record.time
    && recentRecord.type === record.type
    && recentRecord.senderId === record.senderId
    && (recentRecord.text || recentRecord.query || "") === (record.text || record.query || "")
  ))).slice(0, Math.max(0, limit - recentKeep.length));
  const selected = [...relevantKeep, ...recentKeep].filter((record) => {
    const key = `${record.time}|${record.type}|${record.senderId}|${record.text || record.query || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (Date.parse(a.time || "") || 0) - (Date.parse(b.time || "") || 0));
  return selected.map((record) => ({
    time: record.sentAt || record.time,
    type: record.type,
    sender: record.senderName || record.senderId || record.type,
    text: clampText(record.text || record.summary || record.query || "", 260),
    images: asArray(record.images).filter((img) => img.description).map((img) => `图#${img.index}:${clampText(img.description, 120)}`),
    sources: asArray(record.sources).slice(0, 2).map((s) => s.link).filter(Boolean)
  }));
}

function buildArchiveContext({ event, current, history = [], memory, groupId, config, mode = "" }) {
  const decision = shouldRetrieveArchiveContext({ current, history, memory, groupId, config, mode });
  if (!decision.needed) return { used: false, reason: decision.reason, text: "" };
  const meta = archiveConversationMetaFromEvent(event, config);
  if (!archiveEnabledForConversation(memory, meta.conversationId, config)) return { used: false, reason: "archive disabled for conversation", text: "" };
  const summary = readJsonFileSafe(meta.summaryPath, {});
  const gm = groupMemory(memory || { groups: {} }, groupId || (meta.kind === "groups" ? meta.id : meta.conversationId));
  const snippets = retrieveArchiveSnippets({ event, current, config, memory, groupId });
  const lines = [];
  const rollingSummary = summary.rollingSummary || gm.rollingSummary || "";
  const topics = asArray(summary.topics).length ? asArray(summary.topics) : asArray(gm.topics);
  if (rollingSummary) lines.push(`长期摘要：${clampTextTail(rollingSummary, 700)}`);
  if (topics.length) lines.push(`相关话题：${topics.slice(-8).join("；")}`);
  if (snippets.length) {
    lines.push("相关历史片段：");
    for (const item of snippets) {
      const time = item.time ? item.time.replace("T", " ").slice(0, 16) : "";
      const imageText = item.images?.length ? ` ${item.images.join("；")}` : "";
      const sourceText = item.sources?.length ? ` 来源：${item.sources.join("；")}` : "";
      lines.push(`- ${time} ${item.sender}: ${item.text}${imageText}${sourceText}`);
    }
  }
  return { used: lines.length > 0, reason: decision.reason, text: lines.join("\n"), snippets };
}

function hydrateRuntimeContextFromArchives({ config, historyByGroup, lastBotMessageByGroup }) {
  const cfg = chatArchiveConfig(config);
  if (!cfg.enabled || !fs.existsSync(cfg.baseDir)) return { conversations: 0, messages: 0 };
  const maxMessages = Math.max(10, Math.min(
    Number(config.chatArchive?.hydrateRecentMessages || config.history?.rawMaxMessages || 120),
    Number(config.history?.rawMaxMessages || 120)
  ));
  let conversations = 0;
  let messages = 0;
  for (const kind of ["groups", "private"]) {
    const kindDir = path.join(cfg.baseDir, kind);
    if (!fs.existsSync(kindDir)) continue;
    for (const id of fs.readdirSync(kindDir)) {
      const messagesPath = path.join(kindDir, id, "messages.jsonl");
      if (!fs.existsSync(messagesPath)) continue;
      const groupId = kind === "groups" ? id : `private:${id}`;
      const records = readLastJsonlRecords(messagesPath, maxMessages * 4, 4 * 1024 * 1024)
        .filter((record) => record?.type === "user_message" || record?.type === "bot_reply")
        .slice(-maxMessages);
      const history = records.map((record) => {
        const replyContexts = asArray(record.quotedMessage?.contexts);
        return {
          sender: record.senderName || record.senderId || (record.type === "bot_reply" ? botDisplayName(config) : "群友"),
          user_id: asStringId(record.senderId),
          text: record.text || record.rawText || "[空消息]",
          at: Number(record.sentAtMs || 0) || Date.parse(record.sentAt || record.time || "") || Date.now(),
          sentAt: record.sentAt || record.time || "",
          sentAtMs: Number(record.sentAtMs || 0) || Date.parse(record.sentAt || record.time || "") || Date.now(),
          receivedAt: record.receivedAt || "",
          processedAt: record.processedAt || "",
          isBot: record.type === "bot_reply",
          source: record.source || "archive-hydrated",
          messageId: asStringId(record.messageId),
          replyContexts,
          replyToUserId: asStringId(record.quotedMessage?.replyToUserId),
          replyToSender: record.quotedMessage?.replyToSender || "",
          mentionedUserIds: asArray(record.mentions).map(asStringId).filter(Boolean)
        };
      });
      if (!history.length) continue;
      const ordered = orderedHistory(history).slice(-maxMessages);
      historyByGroup.set(groupId, ordered);
      const lastBot = [...ordered].reverse().find((item) => item.isBot);
      if (lastBot) lastBotMessageByGroup.set(groupId, lastBot);
      conversations += 1;
      messages += ordered.length;
    }
  }
  return { conversations, messages };
}

function chatArchiveStatus(config = {}) {
  const cfg = chatArchiveConfig(config);
  const result = {
    enabled: cfg.enabled,
    defaultOn: cfg.defaultOn,
    baseDir: path.relative(stateRoot, cfg.baseDir),
    conversations: 0,
    groups: 0,
    private: 0,
    bytes: 0
  };
  const walk = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) walk(p);
        else result.bytes += stat.size;
      }
    } catch {
      // best effort
    }
  };
  const countKind = (kind) => {
    const dir = path.join(cfg.baseDir, kind);
    try {
      return fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "messages.jsonl"))).length;
    } catch {
      return 0;
    }
  };
  result.groups = countKind("groups");
  result.private = countKind("private");
  result.conversations = result.groups + result.private;
  walk(cfg.baseDir);
  return result;
}

function archiveConversations(config = {}) {
  const cfg = chatArchiveConfig(config);
  const list = [];
  for (const [kind, prefix] of [["groups", "group"], ["private", "private"]]) {
    const dir = path.join(cfg.baseDir, kind);
    try {
      for (const name of fs.readdirSync(dir)) {
        const conversationDir = path.join(dir, name);
        const messagesPath = path.join(conversationDir, "messages.jsonl");
        if (!fs.existsSync(messagesPath)) continue;
        const index = readJsonFileSafe(path.join(conversationDir, "index.json"), {});
        const stat = fs.statSync(messagesPath);
        list.push({
          conversationId: index.conversationId || `${prefix}:${name}`,
          kind,
          id: name,
          messageCount: Number(index.messageCount || 0),
          botReplyCount: Number(index.botReplyCount || 0),
          webSearchCount: Number(index.webSearchCount || 0),
          updatedAt: index.updatedAt || new Date(stat.mtimeMs).toISOString(),
          mtimeMs: stat.mtimeMs,
          bytes: stat.size,
          path: path.relative(stateRoot, messagesPath),
          recent: asArray(index.recent).slice(-5)
        });
      }
    } catch {
      // ignore absent dirs
    }
  }
  return list.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function archivePathForConversationId(conversationId, config = {}) {
  const raw = String(conversationId || "");
  const match = raw.match(/^(group|private):(.+)$/);
  if (!match) return "";
  const cfg = chatArchiveConfig(config);
  const kind = match[1] === "group" ? "groups" : "private";
  return path.join(cfg.baseDir, kind, safePathSegment(match[2], "unknown"), "messages.jsonl");
}

function aiArgsWithoutPrompt(config) {
  const args = normalizeAiArgs(config.ai?.args || ["-z"]);
  return args.filter((arg, index) => {
    if (arg === "-z" || arg === "--prompt") return true;
    const prev = args[index - 1];
    return prev !== "-z" && prev !== "--prompt";
  });
}

function hermesProfileArgPrefix(config) {
  const args = normalizeAiArgs(config.ai?.args || ["-z"]);
  const at = args.findIndex((arg) => arg === "-p" || arg === "--profile");
  const profile = at >= 0 ? args[at + 1] : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(profile || "") ? ["-p", profile] : [];
}

function normalizeApiKeyEnvName(value, provider = "") {
  const name = stringValue(value).trim();
  if (/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name)) return name;
  const providerId = stringValue(provider).toLowerCase();
  if (providerId === "openai-api") return "OPENAI_API_KEY";
  if (providerId === "custom") return "OPENAI_API_KEY";
  if (providerId === "xiaomi" || providerId === "mimo") return "XIAOMI_API_KEY";
  if (providerId === "deepseek") return "DEEPSEEK_API_KEY";
  if (providerId.includes("minimax-cn") || providerId.includes("minimax_china") || providerId.includes("minimax-china")) return "MINIMAX_CN_API_KEY";
  if (providerId.includes("minimax")) return "MINIMAX_API_KEY";
  return "";
}

function normalizeAiBaseUrl(value) {
  const baseUrl = stringValue(value).trim();
  if (!baseUrl) return "";
  if (baseUrl.length > 500) throw new Error("AI Base URL is too long");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("AI Base URL must be a valid http(s) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("AI Base URL must use http or https");
  return baseUrl.replace(/\/+$/, "");
}

function normalizeAiArgs(rawArgs) {
  const source = Array.isArray(rawArgs) ? rawArgs : ["-z"];
  const tokens = [];
  for (const raw of source) {
    const value = stringValue(raw).trim();
    if (!value) continue;
    tokens.push(...value.split(/\r?\n|\\n/).flatMap((part) => part.trim().split(/\s+/)).filter(Boolean));
  }
  let provider = "";
  let model = "";
  const others = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--provider") {
      provider = tokens[i + 1] || provider;
      i += 1;
      continue;
    }
    if (token === "-m" || token === "--model") {
      model = tokens[i + 1] || model;
      i += 1;
      continue;
    }
    if (token === "-z" || token === "--prompt") continue;
    others.push(token);
  }
  const next = [];
  if (model) next.push("-m", model);
  if (provider) next.push("--provider", provider);
  next.push(...others);
  next.push("-z");
  return next;
}

function aiSettingsFromConfig(config) {
  const ai = config.ai || {};
  const args = aiArgsWithoutPrompt(config);
  const valueAfter = (...names) => {
    for (let i = 0; i < args.length; i += 1) {
      if (names.includes(args[i])) return args[i + 1] || "";
    }
    return "";
  };
  return {
    command: ai.command || "hermesqq2",
    args,
    provider: ai.provider || valueAfter("--provider") || "",
    model: ai.model || valueAfter("-m", "--model") || "",
    baseUrl: ai.baseUrl || ai.baseURL || "",
    apiKeyEnv: normalizeApiKeyEnvName(ai.apiKeyEnv || "", ai.provider || valueAfter("--provider") || ""),
    reasoningEffort: ai.reasoningEffort || ai.reasoning || "",
    timeoutMs: Number(ai.timeoutMs || 120000),
    apiKeyEnvPresent: ai.apiKeyEnv ? Boolean(process.env[ai.apiKeyEnv]) : false
  };
}

function updateArgValue(args, names, value, preferredName) {
  const next = [...args];
  let found = false;
  for (let i = 0; i < next.length; i += 1) {
    if (names.includes(next[i])) {
      found = true;
      if (value) next[i + 1] = value;
      else next.splice(i, 2);
      break;
    }
  }
  if (!found && value) next.unshift(preferredName, value);
  return next;
}

function normalizeAiPatch(aiPatch, currentConfig) {
  const current = aiSettingsFromConfig(currentConfig);
  const next = { ...(currentConfig.ai || {}) };
  setIfPresent(next, aiPatch, "command", (x) => stringValue(x, "hermesqq2").trim() || "hermesqq2");
  let args = Array.isArray(aiPatch?.args) ? normalizeAiArgs(aiPatch.args) : [...current.args];
  const provider = Object.prototype.hasOwnProperty.call(aiPatch || {}, "provider") ? stringValue(aiPatch.provider).trim() : current.provider;
  const model = Object.prototype.hasOwnProperty.call(aiPatch || {}, "model") ? stringValue(aiPatch.model).trim() : current.model;
  args = updateArgValue(args, ["--provider"], provider, "--provider");
  args = updateArgValue(args, ["-m", "--model"], model, "-m");
  if (!args.includes("-z") && !args.includes("--prompt")) args.push("-z");
  next.args = normalizeAiArgs(args);
  next.provider = provider;
  next.model = model;
  setIfPresent(next, aiPatch, "baseUrl", normalizeAiBaseUrl);
  setIfPresent(next, aiPatch, "apiKeyEnv", (x) => normalizeApiKeyEnvName(x, provider));
  setIfPresent(next, aiPatch, "reasoningEffort", (x) => {
    const value = stringValue(x, "none").trim().toLowerCase();
    return ["none", "low", "medium", "high"].includes(value) ? value : "none";
  });
  setIfPresent(next, aiPatch, "timeoutMs", (x) => numberInRange(x, 120000, 1000, 600000));
  delete next.apiKey;
  return next;
}

function aiProfileId(value, fallback = "") {
  const id = stringValue(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return id || fallback;
}

function normalizedAiProfile(value, currentConfig, index = 0) {
  if (!isPlainObject(value)) return null;
  const id = aiProfileId(value.id, `profile-${index + 1}`);
  const profileConfig = {
    ai: {
      command: "hermesqq2",
      args: ["-z"],
      timeoutMs: 120000,
      reasoningEffort: "none"
    }
  };
  const ai = normalizeAiPatch(value, profileConfig);
  return {
    id,
    name: stringValue(value.name, id).trim().slice(0, 60) || id,
    preset: stringValue(value.preset).trim().toLowerCase().slice(0, 32),
    command: ai.command || "hermesqq2",
    args: normalizeAiArgs(ai.args || ["-z"]),
    timeoutMs: Number(ai.timeoutMs || 120000),
    provider: ai.provider || "",
    model: ai.model || "",
    baseUrl: ai.baseUrl || "",
    apiKeyEnv: normalizeApiKeyEnvName(ai.apiKeyEnv || "", ai.provider || ""),
    reasoningEffort: ai.reasoningEffort || "none"
  };
}

function normalizeAiProfiles(value, currentConfig) {
  const source = isPlainObject(value) ? value : {};
  const incoming = Array.isArray(source.profiles) ? source.profiles.slice(0, 20) : [];
  const seen = new Set();
  const profiles = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const profile = normalizedAiProfile(incoming[index], currentConfig, index);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  if (!profiles.length) {
    const current = normalizedAiProfile({
      id: "current",
      name: "当前配置",
      preset: "custom",
      ...aiSettingsFromConfig(currentConfig)
    }, currentConfig, 0);
    if (current) profiles.push(current);
  }
  const requestedActiveId = aiProfileId(source.activeId);
  const activeId = profiles.some((profile) => profile.id === requestedActiveId)
    ? requestedActiveId
    : profiles[0].id;
  return { activeId, profiles };
}

function publicAiProfiles(config) {
  const normalized = normalizeAiProfiles(config.aiProfiles, config);
  return {
    activeId: normalized.activeId,
    profiles: normalized.profiles.map((profile) => ({
      ...profile,
      apiKeyEnvPresent: profile.apiKeyEnv ? Boolean(process.env[profile.apiKeyEnv]) : false
    }))
  };
}

function activeAiProfile(profiles) {
  return profiles?.profiles?.find((profile) => profile.id === profiles.activeId) || profiles?.profiles?.[0] || null;
}

function hermesRuntimeEnv(config) {
  const ai = aiSettingsFromConfig(config);
  const env = {
    ...process.env,
    HERMES_REASONING_EFFORT: String(ai.reasoningEffort || "")
  };
  const provider = String(ai.provider || "").trim().toLowerCase();
  const sourceKey = ai.apiKeyEnv ? process.env[ai.apiKeyEnv] : "";
  if (sourceKey) {
    if (provider === "custom") env.OPENAI_API_KEY = sourceKey;
    else if (provider === "openai-api") env.OPENAI_API_KEY = sourceKey;
    else if (provider === "xiaomi" || provider === "mimo") env.XIAOMI_API_KEY = sourceKey;
    else if (provider === "deepseek") env.DEEPSEEK_API_KEY = sourceKey;
  }
  if (ai.baseUrl) {
    if (provider === "custom") {
      env.CUSTOM_BASE_URL = ai.baseUrl;
      env.OPENAI_BASE_URL = ai.baseUrl;
    } else if (provider === "openai-api") env.OPENAI_BASE_URL = ai.baseUrl;
    else if (provider === "xiaomi" || provider === "mimo") env.XIAOMI_BASE_URL = ai.baseUrl;
    else if (provider === "deepseek") env.DEEPSEEK_BASE_URL = ai.baseUrl;
  }
  return env;
}

function runCommand(command, args = [], { timeoutMs = 30000, killGraceMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const env = command === process.execPath && process.env.HERMES_QQ_HOME
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env;
    const child = spawn(command, args, { cwd: commandCwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    const started = Date.now();
    let timedOut = false;
    let killTimer = null;
    let settleTimer = null;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(payload);
    };
    const killChild = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      killTimer = setTimeout(() => killChild("SIGKILL"), Math.max(200, Number(killGraceMs || 1500)));
      settleTimer = setTimeout(() => finish({
        ok: false,
        code: null,
        signal: "TIMEOUT",
        timedOut: true,
        error: `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-1600),
        durationMs: Date.now() - started
      }), Math.max(500, Number(killGraceMs || 1500) + 500));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      finish({ ok: false, error: err.message, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        error: timedOut ? `${command} ${args.join(" ")} timed out after ${timeoutMs}ms` : "",
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-1600),
        durationMs: Date.now() - started
      });
    });
  });
}

async function restartNapcatContainer(container = "napcat", { timeoutMs = 20000 } = {}) {
  const name = String(container || "napcat");
  if (dockerRuntime.unhealthyUntil && Date.now() < dockerRuntime.unhealthyUntil) {
    return {
      ok: false,
      mode: "docker-circuit-open",
      container: name,
      error: dockerRuntime.lastFailure || "Docker command recently timed out; skipping to avoid piling up stuck docker processes",
      retryAfterMs: dockerRuntime.unhealthyUntil - Date.now()
    };
  }
  const markDockerUnhealthy = (result) => {
    dockerRuntime.unhealthyUntil = Date.now() + 60_000;
    dockerRuntime.lastFailure = result?.error || result?.stderr || `${result?.signal || "timeout"}`;
  };
  const restart = await runCommand("docker", ["restart", "-t", "3", name], { timeoutMs, killGraceMs: 800 });
  if (restart.ok) return { ok: true, mode: "restart", container: name, restart };
  if (restart.timedOut || restart.signal === "TIMEOUT") {
    markDockerUnhealthy(restart);
    return { ok: false, mode: "restart-timeout", container: name, restart, error: dockerRuntime.lastFailure };
  }

  const kill = await runCommand("docker", ["kill", name], { timeoutMs: 8000, killGraceMs: 800 });
  if (kill.timedOut || kill.signal === "TIMEOUT") {
    markDockerUnhealthy(kill);
    return { ok: false, mode: "kill-timeout", container: name, restart, kill, error: dockerRuntime.lastFailure };
  }
  const start = await runCommand("docker", ["start", name], { timeoutMs: 30000, killGraceMs: 800 });
  if (start.timedOut || start.signal === "TIMEOUT") markDockerUnhealthy(start);
  return {
    ok: start.ok,
    mode: "kill-start",
    container: name,
    restart,
    kill,
    start,
    error: start.ok ? "" : (start.error || start.stderr || restart.error || restart.stderr || "NapCat restart failed")
  };
}

function parseEnvText(text) {
  const env = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function readDeviceEnv() {
  try {
    return parseEnvText(fs.readFileSync(path.join(stateRoot, "napcat", "device.env"), "utf8"));
  } catch {
    return {};
  }
}

function randomMacAddress() {
  const bytes = randomBytes(6);
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join(":");
}

function standbyWebuiPort(accountId) {
  const match = String(accountId || "").match(/(\d+)$/);
  const offset = match ? Math.max(0, Number(match[1]) - 1) : 0;
  return 6100 + offset;
}

function napcatStateDirForAccount(account) {
  if (!account || account.id === "primary" || account.role === "primary") return path.join(stateRoot, "napcat");
  return path.join(stateRoot, account.napcatStateDir || account.napcatDataDir || account.napcatContainer || `napcat-${safePathSegment(account.id)}`);
}

function snowlumaStateDirForAccount(account) {
  return path.join(stateRoot, account?.snowlumaStateDir || account?.protocolContainer || `snowluma-${safePathSegment(account?.id || "standby-a")}`);
}

function napcatWebuiInfoForAccount(account) {
  const id = account?.id || "primary";
  const stateDir = napcatStateDirForAccount(account || { id, role: id === "primary" ? "primary" : "standby" });
  const configPath = path.join(stateDir, "config", "webui.json");
  const webui = readJsonFileSafe(configPath, {});
  const port = Number(
    account?.webuiPort
    || account?.napcatWebuiPort
    || (id === "primary" || account?.role === "primary" ? (webui.port || 6099) : standbyWebuiPort(id))
  );
  const token = stringValue(webui.token || account?.webuiToken || "").trim();
  return {
    port,
    tokenPresent: Boolean(token),
    url: `http://127.0.0.1:${port}/webui${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    configPath: path.relative(stateRoot, configPath)
  };
}

function snowlumaWebuiInfoForAccount(account) {
  const id = account?.id || "standby-a";
  const port = Number(account?.webuiPort || 6101);
  const stateDir = snowlumaStateDirForAccount(account);
  return {
    port,
    tokenPresent: false,
    url: `http://127.0.0.1:${port}`,
    configPath: path.relative(stateRoot, stateDir)
  };
}

function accountWebuiInfoForAccount(account) {
  return accountProtocol(account) === "snowluma" ? snowlumaWebuiInfoForAccount(account) : napcatWebuiInfoForAccount(account);
}

function sanitizeUrlForLog(url) {
  try {
    const parsed = new URL(String(url));
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|secret|password|key/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return String(url || "").replace(/([?&][^=]*(?:token|secret|password|key)[^=]*=)[^&\s]+/gi, "$1[REDACTED]");
  }
}

function readSnowLumaOneBotAccessToken(account, currentConfig = {}) {
  const explicit = stringValue(account?.onebotAccessToken || account?.accessToken || "").trim();
  if (explicit) return explicit;
  const qq = stringValue(account?.qq || account?.actualQq || "").trim();
  const container = accountProtocolContainer(account, currentConfig);
  if (container) {
    const command = qq
      ? `node -e 'const fs=require("fs"); const p="/app/snowluma-data/config/onebot_${qq.replace(/[^0-9]/g, "")}.json"; const o=JSON.parse(fs.readFileSync(p,"utf8")); console.log((o.networks&&o.networks.wsServers&&o.networks.wsServers[0]&&o.networks.wsServers[0].accessToken)||o.accessToken||"")'`
      : `node -e 'const fs=require("fs"),path=require("path"); const dir="/app/snowluma-data/config"; const f=fs.readdirSync(dir).find(x=>/^onebot_.*\\.json$/.test(x)); if(!f) process.exit(0); const o=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); console.log((o.networks&&o.networks.wsServers&&o.networks.wsServers[0]&&o.networks.wsServers[0].accessToken)||o.accessToken||"")'`;
    try {
      const result = spawnSync("docker", ["exec", container, "sh", "-lc", command], {
        cwd: commandCwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 64
      });
      const runtimeToken = result.status === 0 ? stringValue(result.stdout || "").trim() : "";
      // SnowLuma stores its live OneBot config in /app/snowluma-data. A host-side
      // config copy can survive an update/login and contain a stale token, so the
      // running container must remain the authoritative source when available.
      if (runtimeToken) return runtimeToken;
    } catch {
      // Fall back to a host-side config for stopped or not-yet-created containers.
    }
  }

  const stateDir = snowlumaStateDirForAccount(account);
  const candidates = [];
  if (qq) candidates.push(path.join(stateDir, "config", `onebot_${qq}.json`));
  candidates.push(path.join(stateDir, "config", "onebot.json"));
  for (const filePath of candidates) {
    const parsed = readJsonFileSafe(filePath, null);
    const token = stringValue(parsed?.networks?.wsServers?.[0]?.accessToken || parsed?.accessToken || "").trim();
    if (token) return token;
  }
  return "";
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureStandbyNapcatFiles(account, currentConfig) {
  const stateDir = napcatStateDirForAccount(account);
  const configDir = path.join(stateDir, "config");
  const pluginsDir = path.join(stateDir, "plugins");
  const qqDir = path.join(stateDir, "QQ");
  const cacheDir = path.join(stateDir, "cache");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(qqDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const machineIdPath = path.join(stateDir, "machine-id");
  if (!fs.existsSync(machineIdPath)) fs.writeFileSync(machineIdPath, `${randomBytes(16).toString("hex")}\n`);

  const deviceEnvPath = path.join(stateDir, "device.env");
  if (!fs.existsSync(deviceEnvPath)) {
    const sourceEnv = readDeviceEnv();
    fs.writeFileSync(deviceEnvPath, [
      `NAPCAT_STABLE_HOSTNAME=qq-hermes-${safePathSegment(account.id)}`,
      `NAPCAT_STABLE_MACHINE_ID=${fs.readFileSync(machineIdPath, "utf8").trim()}`,
      `NAPCAT_STABLE_MAC_ADDRESS=${randomMacAddress()}`,
      `NAPCAT_IMAGE=${sourceEnv.NAPCAT_IMAGE || "mlikiowa/napcat-docker:latest"}`,
      "NAPCAT_DISABLE_PASSWORD_FALLBACK=1",
      ""
    ].join("\n"));
  }

  const onebotConfig = {
    network: {
      httpServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [
        {
          name: "HermesBridge",
          enable: true,
          url: `ws://host.docker.internal:${Number(currentConfig.listen?.port || 6199)}${account.onebotPath || currentConfig.listen?.path || "/onebot"}`,
          messagePostFormat: "array",
          reportSelfMessage: false,
          reconnectInterval: 5000,
          token: "",
          debug: false,
          heartInterval: 30000,
          verifyCertificate: true
        }
      ],
      httpSseServers: [],
      plugins: []
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: "",
    timeout: {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000
    }
  };
  writeJsonFile(path.join(configDir, "onebot11.json"), onebotConfig);
  if (account.qq) writeJsonFile(path.join(configDir, `onebot11_${account.qq}.json`), onebotConfig);

  const napcatConfigPath = path.join(configDir, "napcat.json");
  if (!fs.existsSync(napcatConfigPath)) {
    writeJsonFile(napcatConfigPath, {
      fileLog: false,
      consoleLog: true,
      fileLogLevel: "debug",
      consoleLogLevel: "info",
      packetBackend: "auto",
      packetServer: "",
      o3HookMode: 1,
      bypass: {
        hook: false,
        window: false,
        module: false,
        process: false,
        container: false,
        js: false
      }
    });
  }

  const webuiPath = path.join(configDir, "webui.json");
  let webui = {};
  try {
    if (fs.existsSync(webuiPath)) webui = JSON.parse(fs.readFileSync(webuiPath, "utf8"));
  } catch {
    webui = {};
  }
  webui.host = webui.host || "::";
  webui.port = 6099;
  webui.token = webui.token || randomBytes(6).toString("hex");
  webui.loginRate = webui.loginRate || 10;
  if (account.qq) webui.autoLoginAccount = account.qq;
  writeJsonFile(webuiPath, webui);

  const sourcePluginsDir = path.join(stateRoot, "napcat", "plugins");
  try {
    if (fs.existsSync(sourcePluginsDir) && fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).length === 0) {
      fs.cpSync(sourcePluginsDir, pluginsDir, { recursive: true });
    }
  } catch (err) {
    warn(`copy standby napcat plugins failed account=${account.id}: ${err.message}`);
  }

  return {
    stateDir,
    configDir,
    pluginsDir,
    qqDir,
    cacheDir,
    machineIdPath,
    deviceEnvPath,
    webuiPort: Number(account.webuiPort || account.napcatWebuiPort || standbyWebuiPort(account.id)),
    webuiToken: webui.token
  };
}

async function dockerContainerExists(container) {
  const result = await runCommand("docker", ["inspect", container], { timeoutMs: 8000, killGraceMs: 800 });
  return result.ok;
}

async function createNapcatAccountContainer(account, currentConfig) {
  if (!account || account.role === "primary") return { ok: false, error: "primary account is managed by the existing napcat container" };
  const container = account.napcatContainer || `napcat-${safePathSegment(account.id)}`;
  if (await dockerContainerExists(container)) return { ok: true, existed: true, container };

  const files = ensureStandbyNapcatFiles(account, currentConfig);
  const deviceEnv = parseEnvText(fs.readFileSync(files.deviceEnvPath, "utf8"));
  const image = deviceEnv.NAPCAT_IMAGE || readDeviceEnv().NAPCAT_IMAGE || "mlikiowa/napcat-docker:latest";
  const uid = String(process.getuid?.() || 501);
  const gid = String(process.getgid?.() || 20);
  const envArgs = [
    "-e", "TZ=Asia/Shanghai",
    "-e", `NAPCAT_UID=${uid}`,
    "-e", `NAPCAT_GID=${gid}`
  ];
  if (account.qq) envArgs.push("-e", `ACCOUNT=${account.qq}`);
  const mac = deviceEnv.NAPCAT_STABLE_MAC_ADDRESS || randomMacAddress();
  const args = [
    "run", "-d",
    "--name", container,
    "--restart", "always",
    "--hostname", deviceEnv.NAPCAT_STABLE_HOSTNAME || `qq-hermes-${safePathSegment(account.id)}`,
    "--mac-address", mac,
    ...envArgs,
    "-p", `${files.webuiPort}:6099`,
    "-v", `${files.configDir}:/app/napcat/config`,
    "-v", `${files.pluginsDir}:/app/napcat/plugins`,
    "-v", `${files.qqDir}:/app/.config/QQ`,
    "-v", `${files.machineIdPath}:/etc/machine-id:ro`,
    "-v", `${files.machineIdPath}:/var/lib/dbus/machine-id:ro`,
    image
  ];
  const result = await runCommand("docker", args, { timeoutMs: 60000, killGraceMs: 1200 });
  return {
    ...result,
    ok: result.ok,
    mode: "create",
    container,
    stateDir: path.relative(stateRoot, files.stateDir),
    webuiUrl: `http://127.0.0.1:${files.webuiPort}/webui?token=${files.webuiToken}`,
    image
  };
}

async function ensureNapcatAccountContainer(account, currentConfig) {
  const container = account?.napcatContainer || "napcat";
  if (!account || account.role === "primary") {
    return { ok: await dockerContainerExists(container), existed: true, container };
  }
  if (await dockerContainerExists(container)) return { ok: true, existed: true, container };
  return createNapcatAccountContainer(account, currentConfig);
}

function snowlumaPortsForAccount(account) {
  const webuiPort = Number(account?.webuiPort || 6101);
  const noVncPort = Number(account?.noVncPort || 6102);
  const vncPort = Number(account?.vncPort || 5901);
  const wsUrl = String(account?.onebotWsUrl || "ws://127.0.0.1:6301");
  let wsPort = 6301;
  try {
    const parsed = new URL(wsUrl);
    wsPort = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  } catch {
    wsPort = 6301;
  }
  return { webuiPort, noVncPort, vncPort, wsPort, wsUrl };
}

function ensureSnowLumaFiles(account) {
  const stateDir = snowlumaStateDirForAccount(account);
  const dataDir = path.join(stateDir, "data");
  const configDir = path.join(stateDir, "config");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { stateDir, dataDir, configDir };
}

function snowlumaManagedVolumes(account) {
  const raw = account?.snowlumaVolumes && typeof account.snowlumaVolumes === "object" ? account.snowlumaVolumes : {};
  const managed = process.env.HERMES_QQ_MANAGED_VOLUMES === "1";
  if (!managed && !Object.keys(raw).length) return null;
  const id = safePathSegment(account?.id || "primary", "primary");
  const prefix = safePathSegment(process.env.HERMES_QQ_VOLUME_PREFIX || "hermes-qq-bot", "hermes-qq-bot");
  return {
    snowlumaData: String(raw.snowlumaData || `${prefix}-${id}-snowluma-data`),
    appConfig: String(raw.appConfig || `${prefix}-${id}-app-config`),
    localShare: String(raw.localShare || `${prefix}-${id}-local-share`)
  };
}

async function createSnowLumaAccountContainer(account, currentConfig) {
  if (!account) return { ok: false, error: "missing account" };
  const container = accountProtocolContainer(account, currentConfig);
  if (await dockerContainerExists(container)) return { ok: true, existed: true, container };
  const files = ensureSnowLumaFiles(account);
  const { webuiPort, noVncPort, vncPort, wsPort } = snowlumaPortsForAccount(account);
  const image = String(account.snowlumaImage || "motricseven7/snowluma:latest");
  const volumes = snowlumaManagedVolumes(account);
  const args = [
    "run", "-d",
    "--name", container,
    "--restart", "always",
    "--privileged",
    "-e", "TZ=Asia/Shanghai",
    "-p", `${webuiPort}:5099`,
    "-p", `${noVncPort}:6081`,
    "-p", `${vncPort}:5900`,
    "-p", `${wsPort}:3001`,
    "-v", `${files.dataDir}:/app/data`,
    "-v", `${files.configDir}:/app/config`,
  ];
  if (volumes) {
    args.push(
      "-v", `${volumes.snowlumaData}:/app/snowluma-data`,
      "-v", `${volumes.appConfig}:/app/.config`,
      "-v", `${volumes.localShare}:/app/.local/share`
    );
  }
  args.push(image);
  const result = await runCommand("docker", args, { timeoutMs: 120000, killGraceMs: 1200 });
  return {
    ...result,
    ok: result.ok,
    mode: "create",
    protocol: "snowluma",
    container,
    image,
    volumes,
    stateDir: path.relative(stateRoot, files.stateDir),
    webuiUrl: `http://127.0.0.1:${webuiPort}`,
    noVncUrl: `http://127.0.0.1:${noVncPort}`,
    onebotWsUrl: snowlumaPortsForAccount(account).wsUrl
  };
}

async function ensureSnowLumaAccountContainer(account, currentConfig) {
  const container = accountProtocolContainer(account, currentConfig);
  if (await dockerContainerExists(container)) return { ok: true, existed: true, container };
  return createSnowLumaAccountContainer(account, currentConfig);
}

async function ensureAccountProtocolContainer(account, currentConfig) {
  if (accountProtocol(account) === "snowluma") return ensureSnowLumaAccountContainer(account, currentConfig);
  return ensureNapcatAccountContainer(account, currentConfig);
}

async function restartAccountProtocol(account, currentConfig) {
  if (accountProtocol(account) === "snowluma") {
    const ensured = await ensureSnowLumaAccountContainer(account, currentConfig);
    if (!ensured.ok) return { ...ensured, accountId: account.id, protocol: "snowluma" };
    const container = accountProtocolContainer(account, currentConfig);
    const restart = await restartNapcatContainer(container, { timeoutMs: 30000 });
    return {
      ...restart,
      ok: restart.ok,
      accountId: account.id,
      protocol: "snowluma",
      container,
      create: ensured.existed ? null : ensured,
      webui: snowlumaWebuiInfoForAccount(account),
      onebotWsUrl: snowlumaPortsForAccount(account).wsUrl
    };
  }
  const container = napcatContainerForAccount(currentConfig, account.id);
  const ensured = await ensureNapcatAccountContainer(account, currentConfig);
  if (!ensured.ok) return { ...ensured, accountId: account.id, protocol: "napcat", container };
  const restart = await restartNapcatContainer(container);
  return {
    ...restart,
    accountId: account.id,
    protocol: "napcat",
    container,
    create: ensured.existed ? null : ensured,
    qrcode: qrFileInfoForAccount(account.id, { sync: true, currentConfig })
  };
}

async function resetNapcatLoginStateForAccount(account, currentConfig) {
  const resolved = account || accountById(currentConfig, "primary") || { id: "primary", role: "primary", napcatContainer: "napcat" };
  const accountId = resolved.id || "primary";
  const container = napcatContainerForAccount(currentConfig, accountId);
  const stateDir = napcatStateDirForAccount(resolved);
  const qqDir = path.join(stateDir, "QQ");
  const backupDir = path.join(stateDir, `QQ.login-reset.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const ensured = await ensureNapcatAccountContainer(resolved, currentConfig);
  const stop = await runCommand("docker", ["stop", "-t", "3", container], { timeoutMs: 15000, killGraceMs: 1000 });
  let backup = null;
  try {
    if (fs.existsSync(qqDir)) {
      fs.renameSync(qqDir, backupDir);
      backup = path.relative(stateRoot, backupDir);
    }
    fs.mkdirSync(qqDir, { recursive: true });
  } catch (err) {
    await runCommand("docker", ["start", container], { timeoutMs: 15000, killGraceMs: 1000 });
    return {
      ok: false,
      accountId,
      container,
      message: "清理登录态失败，已尝试重新启动容器。",
      error: err.message,
      stop,
      backup
    };
  }
  const removedLocal = removeLocalQrFilesForAccount(accountId);
  const start = await runCommand("docker", ["start", container], { timeoutMs: 30000, killGraceMs: 1000 });
  const restart = start.ok ? start : await restartNapcatContainer(container);
  return {
    ok: Boolean(restart.ok),
    accountId,
    container,
    stateDir: path.relative(stateRoot, stateDir),
    backup,
    removedLocal,
    ensured,
    stop,
    restart,
    message: restart.ok
      ? "已备份旧 QQ 登录态并重启容器，请等待二维码后扫码登录。"
      : "登录态已备份，但容器启动失败，请查看 Docker/NapCat 日志。"
  };
}

function trimForGroup(text, config, maxLength = null) {
  const max = Number(maxLength || config.send?.maxLength || 420);
  let cleaned = String(text || "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length > max) cleaned = cleaned.slice(0, max - 1).trimEnd() + "…";
  return cleaned;
}

function accountSendState(accountId) {
  const id = asStringId(accountId || "");
  if (!id) return null;
  if (!accountSendRuntime.has(id)) {
    accountSendRuntime.set(id, {
      lastSendAttemptAt: 0,
      lastSendOkAt: 0,
      lastSendFailedAt: 0,
      lastSendAction: "",
      lastSendFailure: "",
      lastPrivateSendAttemptAt: 0,
      lastPrivateSendOkAt: 0,
      lastPrivateSendFailedAt: 0,
      lastPrivateSendFailure: "",
      lastGroupSendAttemptAt: 0,
      lastGroupSendOkAt: 0,
      lastGroupSendFailedAt: 0,
      lastGroupSendFailure: ""
    });
  }
  return accountSendRuntime.get(id);
}

function recordAccountSend(accountId, action, { ok = false, failure = "", attempt = false } = {}) {
  const state = accountSendState(accountId);
  if (!state) return;
  const now = Date.now();
  const actionText = String(action || "");
  const isPrivate = actionText === "send_private_msg";
  const isGroup = actionText === "send_group_msg";
  if (attempt) {
    state.lastSendAttemptAt = now;
    state.lastSendAction = action;
    state.lastSendFailure = "";
    if (isPrivate) state.lastPrivateSendAttemptAt = now;
    if (isGroup) state.lastGroupSendAttemptAt = now;
    return;
  }
  if (ok) {
    state.lastSendOkAt = now;
    state.lastSendAction = action;
    state.lastSendFailure = "";
    if (isPrivate) {
      state.lastPrivateSendOkAt = now;
      state.lastPrivateSendFailure = "";
    }
    if (isGroup) {
      state.lastGroupSendOkAt = now;
      state.lastGroupSendFailure = "";
    }
    return;
  }
  state.lastSendFailedAt = now;
  state.lastSendAction = action;
  state.lastSendFailure = clampText(failure || `${action} failed`, 300);
  if (isPrivate) {
    state.lastPrivateSendFailedAt = now;
    state.lastPrivateSendFailure = state.lastSendFailure;
  }
  if (isGroup) {
    state.lastGroupSendFailedAt = now;
    state.lastGroupSendFailure = state.lastSendFailure;
  }
}

function oneBotSend(ws, action, params) {
  const echo = `hermes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const accountId = asStringId(ws?.__hermesAccountId || "");
  const payload = {
    action,
    params,
    echo
  };
  oneBotSendRuntime.lastSendAttemptAt = Date.now();
  oneBotSendRuntime.lastSendAction = action;
  oneBotSendRuntime.lastSendFailure = "";
  recordAccountSend(accountId, action, { attempt: true });
  const timer = setTimeout(() => {
    const tracker = oneBotSendTrackers.get(echo);
    if (!tracker) return;
    oneBotSendTrackers.delete(echo);
    oneBotSendRuntime.lastSendFailedAt = Date.now();
    oneBotSendRuntime.lastSendAction = action;
    oneBotSendRuntime.lastSendFailure = `${action} 没有收到 OneBot 回执，可能发送失败或 NapCat 卡住`;
    recordAccountSend(tracker.accountId, action, { ok: false, failure: oneBotSendRuntime.lastSendFailure });
    warn(`onebot send no ack action=${action} echo=${echo}`);
  }, 20_000);
  oneBotSendTrackers.set(echo, { action, accountId, startedAt: Date.now(), timer });
  ws.send(JSON.stringify(payload));
}

function sendGroupMessageToGroup(ws, groupId, text, config) {
  const message = trimForGroup(text, config);
  if (!message) return false;
  oneBotSend(ws, "send_group_msg", { group_id: groupId, message });
  return true;
}

function sendPrivateMessageToUser(ws, userId, text, config) {
  const message = trimForGroup(text, config, config.adminNotifications?.maxLength || 900);
  const uid = asStringId(userId);
  if (!ws || ws.readyState !== 1 || !uid || !message) return false;
  const minIntervalMs = Math.max(0, Number(config.send?.privateMinIntervalMs ?? 0));
  if (minIntervalMs > 0) {
    const lastSent = privateMessageCooldowns.get(uid) || 0;
    const elapsed = Date.now() - lastSent;
    if (elapsed < minIntervalMs) {
      debug(`private cooldown uid=${uid} elapsed=${elapsed}ms < ${minIntervalMs}ms, skip`);
      return false;
    }
    privateMessageCooldowns.set(uid, Date.now());
  }
  oneBotSend(ws, "send_private_msg", { user_id: uid, message });
  return true;
}

function privateImageSegmentForFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  return { type: "image", data: { file: `file://${resolved}` } };
}

function sendGroupMessage(ws, event, text, config, { reply = false } = {}) {
  let message = trimForGroup(text, config);
  if (!message) return;
  if (reply && config.send?.replyToMessage !== false && event.message_id != null) {
    message = `[CQ:reply,id=${event.message_id}]${message}`;
  }
  if (event.message_type === "private") {
    const uid = asStringId(event.user_id);
    const minIntervalMs = Math.max(0, Number(config.send?.privateMinIntervalMs ?? 0));
    if (minIntervalMs > 0 && uid) {
      const lastSent = privateMessageCooldowns.get(uid) || 0;
      if (Date.now() - lastSent < minIntervalMs) {
        debug(`private cooldown (sendGroupMessage) uid=${uid}, skip`);
        return;
      }
      privateMessageCooldowns.set(uid, Date.now());
    }
    oneBotSend(ws, "send_private_msg", { user_id: event.user_id, message });
    return;
  }
  oneBotSend(ws, "send_group_msg", { group_id: event.group_id, message });
}

function splitLongMessage(text, maxLength = 1200) {
  const max = Math.max(200, Number(maxLength || 1200));
  const chunks = [];
  let current = "";
  const pushCurrent = () => {
    const item = current.trim();
    if (item) chunks.push(item);
    current = "";
  };
  for (const line of String(text || "").split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max) {
      current = next;
      continue;
    }
    pushCurrent();
    if (line.length <= max) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
  }
  pushCurrent();
  return chunks;
}

async function sendLongGroupMessage(ws, event, text, config, { reply = false, maxLength = null, delayMs = null } = {}) {
  const chunks = splitLongMessage(text, maxLength || config.commands?.memoryChunkLength || 1200);
  const intervalMs = Math.max(0, Number(delayMs ?? config.commands?.chunkDelayMs ?? config.responseQueue?.minDelayMs ?? 1000));
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const suffix = chunks.length > 1 ? `\n\n(${index + 1}/${chunks.length})` : "";
    let message = trimForGroup(`${chunk}${suffix}`, config, Number(maxLength || config.commands?.memoryChunkLength || 1200) + 20);
    if (!message) continue;
    if (reply && index === 0 && config.send?.replyToMessage !== false && event.message_id != null) {
      message = `[CQ:reply,id=${event.message_id}]${message}`;
    }
    if (event.message_type === "private") {
      const uid = asStringId(event.user_id);
      const minIntervalMs = Math.max(0, Number(config.send?.privateMinIntervalMs ?? 0));
      if (minIntervalMs > 0 && uid) {
        const lastSent = privateMessageCooldowns.get(uid) || 0;
        if (Date.now() - lastSent < minIntervalMs) {
          debug(`private cooldown (sendLongGroupMessage) uid=${uid}, skip chunk ${index + 1}`);
          continue;
        }
        privateMessageCooldowns.set(uid, Date.now());
      }
      oneBotSend(ws, "send_private_msg", { user_id: event.user_id, message });
    } else {
      oneBotSend(ws, "send_group_msg", { group_id: event.group_id, message });
    }
    if (index < chunks.length - 1 && intervalMs > 0) await sleep(intervalMs);
  }
}

function targetGroups(config) {
  const targets = (config.targetGroups || []).map(String).filter(Boolean);
  return targets;
}

function targetPrivateUsers(config) {
  return (config.privateChats?.targetUsers || []).map(String).filter(Boolean);
}

function handlesAllGroups(config) {
  const targets = targetGroups(config);
  return targets.includes("*") || targets.includes("all") || targets.includes("ALL");
}

function handlesAllPrivateUsers(config) {
  const targets = targetPrivateUsers(config);
  return targets.includes("*") || targets.includes("all") || targets.includes("ALL");
}

function targetGroupsDescription(config) {
  if (handlesAllGroups(config)) return "all joined groups";
  return targetGroups(config).join(", ") || "(none)";
}

function shouldHandleGroup(groupId, config) {
  const targets = targetGroups(config);
  return handlesAllGroups(config) || (targets.length > 0 && targets.includes(asStringId(groupId)));
}

function shouldHandlePrivate(userId, config) {
  if (config.privateChats?.enabled === false) return false;
  const targets = targetPrivateUsers(config);
  return handlesAllPrivateUsers(config) || (targets.length > 0 && targets.includes(asStringId(userId)));
}

function privateOwnerUserIds(config) {
  return asArray(config.privateChats?.ownerUserIds || config.privateChats?.instructionUserIds || [])
    .map(asStringId)
    .filter(Boolean);
}

function isPrivateOwner(userId, config) {
  return privateOwnerUserIds(config).includes(asStringId(userId));
}

function adminNotificationConfig(config) {
  const cfg = config.adminNotifications || {};
  const recipients = asArray(cfg.recipients || cfg.users || cfg.userIds || cfg.userId || [])
    .map(asStringId)
    .filter(Boolean);
  return {
    enabled: cfg.enabled !== false,
    recipients,
    checkIntervalMs: Math.max(5000, Number(cfg.checkIntervalMs || 15000)),
    notifyOnline: cfg.notifyOnline !== false,
    notifyLoginInvalid: cfg.notifyLoginInvalid !== false,
    notifyQuickLogin: cfg.notifyQuickLogin !== false,
    notifyDisconnected: cfg.notifyDisconnected !== false,
    periodicStatusEnabled: cfg.periodicStatusEnabled === true || cfg.periodicStatus?.enabled === true,
    periodicStatusIntervalMs: Math.max(60_000, Number(cfg.periodicStatusIntervalMs || cfg.periodicStatus?.intervalMs || 1_800_000)),
    periodicStatusCheckIntervalMs: Math.max(10_000, Number(cfg.periodicStatusCheckIntervalMs || cfg.periodicStatus?.checkIntervalMs || 60_000)),
    periodicStatusSendOnStart: cfg.periodicStatusSendOnStart === true || cfg.periodicStatus?.sendOnStart === true
  };
}

function loginRecoveryConfig(config) {
  const cfg = config.loginRecovery || {};
  return {
    enabled: cfg.enabled !== false,
    checkIntervalMs: Math.max(5000, Number(cfg.checkIntervalMs || 15000)),
    restartCooldownMs: Math.max(60_000, Number(cfg.restartCooldownMs || 600_000)),
    recoveryWaitMs: Math.max(10_000, Number(cfg.recoveryWaitMs || 45_000)),
    autoRestartNapcat: cfg.autoRestartNapcat !== false,
    refreshQrOnFailure: cfg.refreshQrOnFailure !== false,
    notifyOwner: cfg.notifyOwner !== false,
    maxAutoRestartsPerIncident: Math.max(0, Math.min(5, Math.round(Number(cfg.maxAutoRestartsPerIncident ?? 1)))),
    passwordFallback: cfg.passwordFallback === true
  };
}

function configuredAccountDefinitions(config) {
  const accounts = config.accounts || {};
  const primaryRaw = accounts.primary || {};
  const primary = {
    id: asStringId(primaryRaw.id || "primary") || "primary",
    qq: asStringId(primaryRaw.qq || primaryRaw.uin || ""),
    role: "primary",
    displayName: stringValue(primaryRaw.displayName || primaryRaw.name || config.persona?.displayName || "Hermes小跟班").trim() || "Hermes小跟班",
    protocol: accountProtocol(primaryRaw),
    onebotPath: String(primaryRaw.onebotPath || config.listen?.path || "/onebot"),
    napcatContainer: String(primaryRaw.napcatContainer || "napcat"),
    protocolContainer: String(primaryRaw.protocolContainer || (accountProtocol(primaryRaw) === "snowluma" ? "snowluma-primary" : primaryRaw.napcatContainer || "napcat")),
    onebotWsUrl: String(primaryRaw.onebotWsUrl || (accountProtocol(primaryRaw) === "snowluma" ? "ws://127.0.0.1:6303" : "")),
    webuiPort: primaryRaw.webuiPort == null ? undefined : Number(primaryRaw.webuiPort),
    noVncPort: primaryRaw.noVncPort == null ? undefined : Number(primaryRaw.noVncPort),
    vncPort: primaryRaw.vncPort == null ? undefined : Number(primaryRaw.vncPort),
    snowlumaImage: String(primaryRaw.snowlumaImage || "motricseven7/snowluma:latest"),
    snowlumaVolumes: isPlainObject(primaryRaw.snowlumaVolumes) ? deepClone(primaryRaw.snowlumaVolumes) : undefined,
    enabled: primaryRaw.enabled !== false
  };
  const standbys = asArray(accounts.standbys)
    .filter((item) => item)
    .map((item, index) => ({
      id: asStringId(item.id || `standby-${index + 1}`) || `standby-${index + 1}`,
      qq: asStringId(item.qq || item.uin || ""),
      role: "standby",
      displayName: stringValue(item.displayName || item.name || `Hermes小跟班${index + 2}`).trim() || `Hermes小跟班${index + 2}`,
      protocol: accountProtocol(item),
      onebotPath: String(item.onebotPath || primary.onebotPath),
      napcatContainer: String(item.napcatContainer || `napcat-standby-${index + 1}`),
      protocolContainer: String(item.protocolContainer || item.napcatContainer || (accountProtocol(item) === "snowluma" ? `snowluma-standby-${index + 1}` : `napcat-standby-${index + 1}`)),
      onebotWsUrl: String(item.onebotWsUrl || (accountProtocol(item) === "snowluma" ? "ws://127.0.0.1:6301" : "")),
      webuiPort: item.webuiPort == null ? undefined : Number(item.webuiPort),
      noVncPort: item.noVncPort == null ? undefined : Number(item.noVncPort),
      vncPort: item.vncPort == null ? undefined : Number(item.vncPort),
      snowlumaImage: String(item.snowlumaImage || "motricseven7/snowluma:latest"),
      snowlumaVolumes: isPlainObject(item.snowlumaVolumes) ? deepClone(item.snowlumaVolumes) : undefined,
      behaviorMode: normalizeBehaviorMode(item.behaviorMode) || "normal",
      enabled: item.enabled !== false
    }));
  return [primary, ...standbys];
}

function accountFailoverConfig(config) {
  const accounts = config.accounts || {};
  const allConfigured = configuredAccountDefinitions(config);
  const primary = allConfigured.find((item) => item.role === "primary") || allConfigured[0];
  const standbys = allConfigured.filter((item) => item.role === "standby" && item.enabled !== false);
  const failover = accounts.failover || {};
  return {
    enabled: failover.enabled !== false && standbys.length > 0,
    primary,
    standbys,
    all: [primary, ...standbys],
    primaryRecoveryFirst: failover.primaryRecoveryFirst !== false,
    switchAfterMs: Math.max(10_000, Number(failover.switchAfterMs || 60_000)),
    messageStaleMs: Math.max(30_000, Number(failover.messageStaleMs || config.status?.messageInactiveWarnMs || 10 * 60_000)),
    standbyFreshMs: Math.max(10_000, Number(failover.standbyFreshMs || 2 * 60_000)),
    minSwitchIntervalMs: Math.max(10_000, Number(failover.minSwitchIntervalMs || 90_000)),
    switchBackWhenPrimaryHealthy: failover.switchBackWhenPrimaryHealthy !== false,
    announceTakeover: failover.announceTakeover !== false,
    autoAdoptUnknownStandby: failover.autoAdoptUnknownStandby !== false,
    primaryRecoveryRequiresNewMessage: failover.primaryRecoveryRequiresNewMessage !== false
  };
}

function accountById(config, accountId) {
  return configuredAccountDefinitions(config).find((item) => item.id === accountId) || null;
}

function shouldNotifyAdminStatus(qqLogin, onebotConnected, config, { onebotStale = false } = {}) {
  const cfg = adminNotificationConfig(config);
  if (!cfg.enabled) return false;
  if (onebotStale) return cfg.notifyDisconnected;
  if (qqLogin?.status === "online") return cfg.notifyOnline;
  if (qqLogin?.status === "login_invalid" || qqLogin?.status === "login_required" || qqLogin?.status === "verification_required" || qqLogin?.status === "send_failed") return cfg.notifyLoginInvalid;
  if (qqLogin?.status === "quick_login") return cfg.notifyQuickLogin;
  if (!onebotConnected || qqLogin?.status === "disconnected") return cfg.notifyDisconnected;
  return true;
}

function napcatLoginTimelineLines(qqLogin, max = 8) {
  const lines = asArray(qqLogin?.recent).filter((line) => (
    /KickedOffLine|下线|账号状态|快速登录|密码回退|密码登录|验证码|新设备|没有 -q|二维码|扫码|登录成功|OneBot11|WebSocket反向/.test(String(line || ""))
  ));
  return lines.slice(-Math.max(1, Number(max || 8)));
}

function napcatLoginTimelineText(qqLogin, max = 8) {
  const lines = napcatLoginTimelineLines(qqLogin, max);
  if (!lines.length) return "";
  return lines.map((line) => `- ${clampText(line, 180)}`).join("\n");
}

function latestNapcatLoginEventKey(qqLogin) {
  return napcatLoginTimelineLines(qqLogin, 3).join("\n");
}

function adminLoginAttemptNotificationText({ qqLogin, onebotConnected, onebotStale = false, config }) {
  const status = qqLogin?.status || "unknown";
  const lines = [
    "【小跟班登录尝试】",
    `状态：${qqLogin?.message || status}`,
    `OneBot：${onebotStale ? "疑似卡住" : onebotConnected ? "已连接" : "未连接"}`
  ];
  if (status === "online") lines.push("结果：当前已经恢复在线。");
  if (status === "quick_login") lines.push("结果：正在尝试快速登录。");
  if (status === "verification_required") lines.push("结果：快速/密码登录触发验证码或新设备验证。");
  if (status === "login_required") lines.push("结果：快速登录未完成，当前等待扫码/授权。");
  if (status === "login_invalid") lines.push("结果：登录态失效，快速登录 token 可能已不可用。");
  const timeline = napcatLoginTimelineText(qqLogin, 8);
  if (timeline) lines.push(`登录链路：\n${timeline}`);
  if (qqLogin?.qrcodeExists && qqLogin?.needsLogin) {
    const port = Number(config.control?.port || 6200);
    lines.push(`管理页：http://127.0.0.1:${port}/admin`);
  }
  return lines.join("\n");
}

function adminStatusNotificationText({ qqLogin, onebotConnected, onebotStale = false, config }) {
  const status = qqLogin?.status || "unknown";
  const lines = [
    "【小跟班状态提醒】",
    `状态：${qqLogin?.message || status}`,
    `OneBot：${onebotStale ? "疑似卡住" : onebotConnected ? "已连接" : "未连接"}`
  ];
  if (onebotStale) lines.push("动作：OneBot 连接存在但长时间没有心跳/事件，可能是假在线，建议重启 NapCat。");
  if (status === "quick_login") lines.push("动作：正在尝试用已配置账号进行快速登录。");
  if (status === "login_invalid") lines.push("动作：登录态已失效；会优先尝试快速登录，失败时需要扫码。");
  if (status === "verification_required") lines.push("动作：已尝试密码/快速登录，但 QQ 要验证码或新设备验证；请打开管理页/NapCat WebUI 继续验证。");
  if (status === "send_failed") lines.push("动作：QQ 发消息返回网络异常/发送失败；建议重启 NapCat 或重新登录。");
  if (status === "login_required") lines.push("动作：快速登录未完成，当前需要扫码登录。");
  if (status === "online") lines.push("动作：QQ 与桥接已恢复，可以正常收发消息。");
  if (qqLogin?.qrcodeExists && (status === "login_invalid" || status === "login_required" || status === "verification_required")) {
    const port = Number(config.control?.port || 6200);
    lines.push(`管理页：http://127.0.0.1:${port}/admin`);
  }
  const timeline = napcatLoginTimelineText(qqLogin, 6);
  if (timeline && status !== "online") lines.push(`登录链路：\n${timeline}`);
  if (qqLogin?.lastEvent) lines.push(`最近事件：${clampText(qqLogin.lastEvent, 180)}`);
  return lines.join("\n");
}

function classifyAdminIncidentReason({ qqLogin, onebotConnected, onebotStale }) {
  const event = String(qqLogin?.reasonEvent || qqLogin?.lastEvent || "");
  if (onebotStale) return "OneBot 连接疑似假在线：连接存在，但长时间没有心跳/消息事件。";
  if (!onebotConnected) return event ? `OneBot 断开或尚未连回；相关事件：${clampText(event, 160)}` : "OneBot WebSocket 未连接。";
  if (/KickedOffLine|下线通知/.test(event)) return `QQ 被下线/登录态失效：${clampText(event, 160)}`;
  if (/快速登录错误/.test(event)) return `快速登录失败：${clampText(event, 160)}`;
  if (/验证码|新设备验证|密码回退/.test(event)) return `QQ 要验证码/新设备验证：${clampText(event, 160)}`;
  if (/EventChecker Failed|sendMsg|网络连接异常|发送失败/.test(event)) return `QQ 发送失败/网络异常：${clampText(event, 160)}`;
  if (/用户身份已失效|登录已失效|重新登录/.test(event)) return `QQ 身份/登录态失效：${clampText(event, 160)}`;
  if (/二维码|扫码|授权登录/.test(event)) return `需要扫码授权：${clampText(event, 160)}`;
  if (qqLogin?.status === "quick_login") return "NapCat 正在尝试快速登录。";
  if (qqLogin?.status === "verification_required") return "QQ 密码/快速登录需要验证码或新设备验证。";
  if (qqLogin?.status === "send_failed") return "QQ/NapCat 发消息失败，可能是假在线或网络异常。";
  if (qqLogin?.status === "login_required") return "NapCat 正在等待扫码登录。";
  if (qqLogin?.status === "login_invalid") return "QQ 登录态失效。";
  return event ? clampText(event, 180) : "状态异常，原因暂无更具体日志。";
}

function adminRecoveryNotificationText({ incident, qqLogin, onebotConnected, onebotStale, config }) {
  const nowMs = Date.now();
  const endAt = incident?.endedAt || nowMs;
  const startAt = incident?.startedAt || endAt;
  const duration = formatDuration(endAt - startAt);
  const lines = [
    "【小跟班中断恢复】",
    `中断开始：${formatLocalDateTime(startAt)}`,
    `恢复时间：${formatLocalDateTime(endAt)}`,
    `中断时长：${duration}`,
    `原因：${incident?.reason || "未知"}`,
    `现在状态：${qqLogin?.message || qqLogin?.status || "未知"}`,
    `OneBot：${onebotStale ? "疑似卡住" : onebotConnected ? "已连接" : "未连接"}`
  ];
  if (incident?.lastProblemEvent && incident.lastProblemEvent !== incident.reasonEvent) {
    lines.push(`最后异常事件：${clampText(incident.lastProblemEvent, 180)}`);
  } else if (incident?.reasonEvent) {
    lines.push(`异常事件：${clampText(incident.reasonEvent, 180)}`);
  }
  if (qqLogin?.lastEvent) lines.push(`恢复后最近事件：${clampText(qqLogin.lastEvent, 180)}`);
  const timeline = napcatLoginTimelineText(qqLogin, 6);
  if (timeline) lines.push(`恢复前后登录链路：\n${timeline}`);
  lines.push("结果：已恢复，可以正常收发消息。");
  return lines.join("\n");
}

function loginRecoveryNotificationText({ stage, reason = "", qqLogin, onebotConnected, onebotStale = false, qrcode = null, action = "" }) {
  const title = stage === "recovered"
    ? "【小跟班自动恢复成功】"
    : stage === "need_scan"
      ? "【小跟班需要扫码】"
      : "【小跟班自动恢复】";
  const lines = [
    title,
    `状态：${qqLogin?.message || qqLogin?.status || "未知"}`,
    `OneBot：${onebotStale ? "疑似卡住" : onebotConnected ? "已连接" : "未连接"}`
  ];
  if (reason) lines.push(`原因：${clampText(reason, 260)}`);
  if (action) lines.push(`动作：${action}`);
  if (stage === "recovered") lines.push("结果：已自动恢复，可以继续收发消息。");
  if (stage === "need_scan") {
    lines.push("结果：自动重启后仍未恢复，已刷新二维码，请打开管理页或扫码图片完成授权。");
    lines.push("管理页：http://127.0.0.1:6200/admin");
    if (qrcode?.exists) lines.push(`二维码：${qrcode.path || "napcat/cache/qrcode.png"}`);
  }
  const timeline = napcatLoginTimelineText(qqLogin, 6);
  if (timeline) lines.push(`登录链路：\n${timeline}`);
  return lines.join("\n");
}

function adminPeriodicStatusText({ qqLogin, onebotConnected, onebotStale, config, runtimeStatus, replyCoordinator }) {
  const port = Number(config.control?.port || 6200);
  const replyState = replyCoordinator?.snapshot?.() || {};
  const queueSize = Number(replyState.activeCount || 0) + Number(replyState.pending || 0);
  const secondsSinceFrame = runtimeStatus?.lastOneBotFrameAt
    ? Math.round((Date.now() - runtimeStatus.lastOneBotFrameAt) / 1000)
    : null;
  const secondsSinceMessage = runtimeStatus?.lastOneBotMessageAt
    ? Math.round((Date.now() - runtimeStatus.lastOneBotMessageAt) / 1000)
    : null;
  const lines = [
    "【小跟班半小时状态】",
    `时间：${localNowText()}`,
    `QQ：${qqLogin?.message || qqLogin?.status || "未知"}`,
    `OneBot：${onebotStale ? "疑似假在线" : onebotConnected ? "已连接" : "未连接"}`,
    `监听：群 ${handlesAllGroups(config) ? "全部" : targetGroups(config).join(", ") || "无"}；私聊 ${config.privateChats?.enabled === false ? "关闭" : handlesAllPrivateUsers(config) ? "全部" : targetPrivateUsers(config).join(", ") || "指定用户"}`,
    `队列：${queueSize ? `${queueSize} 个会话处理中` : "空闲"}`
  ];
  if (secondsSinceFrame != null) lines.push(`最近 OneBot 事件：${secondsSinceFrame} 秒前`);
  if (secondsSinceMessage != null) lines.push(`最近聊天消息：${secondsSinceMessage} 秒前`);
  if (oneBotSendRuntime.lastSendFailedAt && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt) {
    lines.push(`发送状态：失败，${clampText(oneBotSendRuntime.lastSendFailure, 160)}`);
  } else if (oneBotSendRuntime.lastSendOkAt) {
    lines.push(`发送状态：正常，最近成功 ${Math.round((Date.now() - oneBotSendRuntime.lastSendOkAt) / 1000)} 秒前`);
  }
  if (runtimeStatus?.lastOneBotMessagePreview) lines.push(`最近消息：${clampText(runtimeStatus.lastOneBotMessagePreview, 160)}`);
  if (qqLogin?.status !== "online" && qqLogin?.lastEvent) lines.push(`状态事件：${clampText(qqLogin.lastEvent, 180)}`);
  lines.push(`管理页：http://127.0.0.1:${port}/admin`);
  return lines.join("\n");
}

function withinActiveHours(config) {
  const hours = config.proactive?.activeHours;
  if (!hours) return true;
  const h = new Date().getHours();
  const start = Number(hours.start ?? 0);
  const end = Number(hours.end ?? 24);
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

function parseDurationMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)(s|m|h|d|秒|分|分钟|小时|天)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "m").toLowerCase();
  const multipliers = {
    s: 1000,
    "秒": 1000,
    m: 60_000,
    "分": 60_000,
    "分钟": 60_000,
    h: 3_600_000,
    "小时": 3_600_000,
    d: 86_400_000,
    "天": 86_400_000
  };
  return Math.max(1000, Math.round(amount * (multipliers[unit] || 60_000)));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function messageDebounceConfig(config) {
  const cfg = config.messageDebounce || {};
  return {
    enabled: cfg.enabled !== false,
    baseWaitMs: Math.max(0, Number(cfg.baseWaitMs ?? 3000)),
    minWaitMs: Math.max(0, Number(cfg.minWaitMs ?? 1500)),
    maxWaitMs: Math.max(0, Number(cfg.maxWaitMs ?? 6000)),
    sameUserExtendMs: Math.max(0, Number(cfg.sameUserExtendMs ?? 2500)),
    maxBufferedMessages: Math.max(1, Number(cfg.maxBufferedMessages ?? 8)),
    maxBufferedChars: Math.max(100, Number(cfg.maxBufferedChars ?? 1000))
  };
}

function isLikelyIncompleteInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/[?？!！。…~～)]$/.test(raw)) return false;
  if (/[,，、:：;；]$/.test(raw)) return true;
  if (/(我感觉|我觉得|就是|然后|但是|不过|因为|所以|如果|这个|那个|还有|比如|等下|你看|帮我|我想|感觉)$/i.test(raw)) return true;
  if (raw.length <= 8 && !/[?？]$/.test(raw) && !/^(好|可以|行|对|不对|不是|为什么|咋|怎么|搜|查)/.test(raw)) return true;
  return false;
}

function shouldWaitForMoreInput({ text, mentioned = false, isPrivate = false, config }) {
  const cfg = messageDebounceConfig(config);
  if (!cfg.enabled) return { wait: false, waitMs: 0, reason: "disabled" };
  const raw = String(text || "").trim();
  if (!raw) return { wait: false, waitMs: 0, reason: "empty" };
  if (/^\/bot(?:\s|$)/i.test(raw) || /^(\/help|\/start|\/ping)$/i.test(raw)) {
    return { wait: false, waitMs: 0, reason: "command" };
  }
  if (mentioned || (isPrivate && /[?？!！。]$/.test(raw))) {
    return { wait: true, waitMs: cfg.minWaitMs, reason: mentioned ? "mentioned-short-wait" : "private-complete-short-wait" };
  }
  if (isLikelyIncompleteInput(raw)) {
    return { wait: true, waitMs: cfg.baseWaitMs + cfg.sameUserExtendMs, reason: "incomplete" };
  }
  if (/[?？]$/.test(raw) || /^(搜一下|查一下|搜索|帮我搜|帮我查)/.test(stripBotAddressing(raw, config))) {
    return { wait: true, waitMs: cfg.minWaitMs, reason: "complete-question-short-wait" };
  }
  return { wait: true, waitMs: cfg.baseWaitMs, reason: "normal" };
}

function flushDebouncedMessage(pending, config) {
  const cfg = messageDebounceConfig(config);
  const messages = asArray(pending?.messages).slice(-cfg.maxBufferedMessages);
  let text = messages.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n");
  let rawText = messages.map((item) => String(item.rawText || "").trim()).filter(Boolean).join("\n");
  if (text.length > cfg.maxBufferedChars) text = `${text.slice(0, cfg.maxBufferedChars)}…`;
  if (rawText.length > cfg.maxBufferedChars) rawText = `${rawText.slice(0, cfg.maxBufferedChars)}…`;
  const last = messages[messages.length - 1] || {};
  return {
    event: last.event || pending?.event,
    text: text || last.text || "",
    rawText: rawText || last.rawText || "",
    messages,
    count: messages.length,
    reason: pending?.reason || "",
    senderName: last.senderName || pending?.senderName || ""
  };
}

async function enqueueDebouncedMessage({ event, conversationId, senderId, senderName, text, rawText, mentioned, isPrivate, config }) {
  const cfg = messageDebounceConfig(config);
  const timing = messageTiming(event, { receivedAt: event?.__receivedAt || Date.now() });
  const singleMessage = { event, text, rawText, senderName, at: timing.sentAtMs, ...timing };
  if (!cfg.enabled) return { skip: false, event, text, rawText, messages: [singleMessage], count: 1, reason: "disabled" };
  const decision = shouldWaitForMoreInput({ text, mentioned, isPrivate, config });
  if (!decision.wait) return { skip: false, event, text, rawText, messages: [singleMessage], count: 1, reason: decision.reason };
  const key = `${conversationId || "unknown"}:${senderId || "unknown"}`;
  const now = Date.now();
  const existing = messageDebounceRuntime.get(key) || { seq: 0, messages: [], createdAt: now };
  const seq = existing.seq + 1;
  const messages = [
    ...existing.messages,
    singleMessage
  ].slice(-cfg.maxBufferedMessages);
  const pending = {
    ...existing,
    seq,
    messages,
    event,
    senderName,
    updatedAt: now,
    reason: decision.reason
  };
  messageDebounceRuntime.set(key, pending);
  const waitMs = Math.min(cfg.maxWaitMs, Math.max(cfg.minWaitMs, Number(decision.waitMs || cfg.baseWaitMs)));
  await sleep(waitMs);
  const latest = messageDebounceRuntime.get(key);
  if (!latest || latest.seq !== seq) return { skip: true, reason: "superseded" };
  messageDebounceRuntime.delete(key);
  const merged = flushDebouncedMessage(latest, config);
  if (merged.count > 1) {
    log(`debounced ${conversationId} sender=${senderName || senderId} count=${merged.count} reason=${merged.reason}`);
  }
  return { skip: false, ...merged };
}

function pendingDebouncedContext(conversationId, excludeSenderId = "") {
  const prefix = `${conversationId || "unknown"}:`;
  const excludedKey = `${prefix}${excludeSenderId || "unknown"}`;
  const items = [];
  for (const [key, pending] of messageDebounceRuntime.entries()) {
    if (!key.startsWith(prefix) || key === excludedKey) continue;
    const messages = asArray(pending?.messages);
    if (!messages.length) continue;
    const latest = messages.at(-1) || {};
    const event = latest.event || pending.event || {};
    items.push({
      sender: latest.senderName || pending.senderName || asStringId(event.user_id) || "群友",
      user_id: asStringId(event.user_id),
      text: messages.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n"),
      at: Number(event.time || 0) ? Number(event.time) * 1000 : Number(latest.at || pending.updatedAt || Date.now()),
      isBot: false,
      pending: true
    });
  }
  return orderedHistory(items);
}

function mergeReplyCurrents(messages, fallback = {}) {
  const items = asArray(messages).filter(Boolean);
  if (!items.length) return fallback;
  const latest = items.at(-1);
  const uniqueBy = (values, key) => {
    const seen = new Set();
    return values.filter((item) => {
      const id = String(key(item) || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const texts = items.map((item) => String(item.text || "").trim()).filter(Boolean);
  const messageIds = Array.from(new Set(items.flatMap((item) => asArray(item.messageIds)).map(String).filter(Boolean)));
  const replyContexts = uniqueBy(items.flatMap((item) => asArray(item.replyContexts)), (item) => item?.messageId || JSON.stringify(item));
  const images = uniqueBy(items.flatMap((item) => asArray(item.images)), (item) => item?.localPath || item?.url || item?.file || `${item?.source || ""}:${item?.index ?? ""}`);
  return {
    ...fallback,
    ...latest,
    sender: latest.sender || fallback.sender,
    user_id: latest.user_id || fallback.user_id,
    text: texts.join("\n") || latest.text || fallback.text || "[空消息]",
    messageIds,
    replyContexts,
    images,
    mergedMessageCount: items.length,
    sentAt: latest.sentAt || fallback.sentAt,
    sentAtMs: Number(latest.sentAtMs || latest.at || fallback.sentAtMs || fallback.at || Date.now()),
    at: Number(latest.at || latest.sentAtMs || fallback.at || Date.now())
  };
}

function scheduleDelayedUnderstandingReply({
  pendingByGroup,
  replyCoordinator,
  ws,
  event,
  groupId,
  current,
  senderName,
  senderId,
  selfId,
  config,
  memory,
  historyByGroup,
  lastBotMessageByGroup,
  reason
}) {
  const cfg = config.delayedUnderstanding || {};
  if (cfg.enabled === false || event.message_type !== "group") return false;
  const gid = asStringId(groupId);
  const pendingKey = `${gid}:${asStringId(senderId) || "unknown"}`;
  const nowMs = Date.now();
  const waitMs = Math.max(500, Number(cfg.waitMs || 4500));
  const maxWaitMs = Math.max(waitMs, Number(cfg.maxWaitMs || 9000));
  const existing = pendingByGroup.get(pendingKey);
  const pending = existing || {
    token: `${gid}:${current.at}:${Math.random().toString(36).slice(2)}`,
    seedAt: Number(current.at || nowMs),
    event,
    current,
    senderName,
    senderId,
    selfId,
    reasons: []
  };
  pending.reasons.push(reason || "ambiguous");
  pending.reasons = Array.from(new Set(pending.reasons)).slice(-6);
  if (existing?.timer) clearTimeout(existing.timer);

  const delayMs = Math.max(0, Math.min(waitMs, pending.seedAt + maxWaitMs - nowMs));
  pending.timer = setTimeout(() => {
    if (pendingByGroup.get(pendingKey)?.token !== pending.token) return;
    pendingByGroup.delete(pendingKey);
    replyCoordinator.enqueue({
      conversationId: gid,
      senderId: pending.senderId,
      mode: "delayed",
      direct: false,
      currentMessages: [pending.current],
      messageIds: pending.current.messageIds,
      event: pending.event,
      execute: async ({ job, signal, revision }) => {
      if (ws.readyState !== 1) return { sent: false, skipped: true };
      if (isQuiet(memory, gid)) return { sent: false, skipped: true };
      const latestHistory = historyByGroup.get(gid) || [];
      const seedIndex = latestHistory.findIndex((m) => (
        !m.isBot
        && asStringId(m.user_id) === asStringId(pending.current.user_id)
        && Number(m.at || 0) === Number(pending.current.at || 0)
      ));
      if (seedIndex < 0) {
        log(`delayed understanding skip group=${gid} reason=seed message not found`);
        return { sent: false, skipped: true };
      }
      const maxMessages = Math.max(1, Number(cfg.maxMessages || 5));
      const maxChars = Math.max(80, Number(cfg.maxChars || 700));
      const sliceEnd = Math.min(latestHistory.length, seedIndex + maxMessages + 1);
      const windowMessages = latestHistory.slice(seedIndex, sliceEnd);
      const botAfterSeed = latestHistory.some((m, index) => index > seedIndex && m?.isBot);
      if (cfg.skipIfBotRepliedAfterSeed !== false && botAfterSeed) {
        log(`delayed understanding skip group=${gid} reason=bot already replied`);
        return { sent: false, skipped: true };
      }
      const humanMessages = windowMessages.filter((m) => m && !m.isBot);
      const followups = humanMessages.filter((m) => Number(m.at || 0) > Number(pending.current.at || 0));
      if (Number(cfg.minFollowupMessages ?? 1) > followups.length) {
        log(`delayed understanding skip group=${gid} reason=no followup`);
        return { sent: false, skipped: true };
      }
      const lines = humanMessages
        .map((m) => `${m.sender || m.user_id || "群友"}: ${String(m.text || "").replace(/\s+/g, " ").trim()}`)
        .join("\n")
        .slice(0, maxChars);
      const delayedCurrent = {
        ...pending.current,
        text: `【延迟理解片段】\n${lines}\n\n【触发原因】${pending.reasons.join("；")}`,
        delayedUnderstanding: true
      };
      const historySnapshot = latestHistory.slice();
      const contextBundle = config.reply?.useContextBundle === false
        ? null
        : buildContextBundle({ memory, groupId: gid, history: historySnapshot, current: delayedCurrent, config });
      const memoryText = compactMemory(memory, gid, config, pending.senderId);
      const archiveContext = buildArchiveContext({
        event: pending.event,
        current: delayedCurrent,
        history: historySnapshot,
        memory,
        groupId: gid,
        config,
        mode: "delayed"
      });
      const prompt = buildPrompt({
        config,
        history: historySnapshot,
        current: delayedCurrent,
        mode: "delayed",
        memoryText,
        contextBundle,
        archiveContext: archiveContext.text || ""
      });
      const response = trimForGroup(await callHermes(prompt, config, { signal }), config);
      if (signal.aborted || Number(job.contextRevision || 0) !== revision) return { retry: true };
      if (response === "__SKIP__" && config.reply?.allowSkip !== false) {
        log(`delayed understanding skip group=${gid} reason=ai skip`);
        return { sent: false, skipped: true };
      }
      if (!response) return { sent: false, skipped: true };
      const lastHuman = humanMessages.at(-1) || pending.current;
      sendGroupMessage(ws, pending.event, response, config, { reply: cfg.replyToMessage === true });
      recordBotMessage({
        historyByGroup,
        lastBotMessageByGroup,
        groupId: gid,
        text: response,
        config,
        memory,
        meta: {
          source: "delayed-understanding",
          user_id: pending.selfId || "bot",
          replyToUserId: lastHuman.user_id || pending.senderId,
          replyToSender: lastHuman.sender || pending.senderName,
          mentionedUserIds: relatedUserIdsFromText(response, groupMemory(memory, gid))
        }
      });
      log(`delayed understanding replied group=${gid} messages=${humanMessages.length} reason=${pending.reasons.join("; ")}`);
      return { sent: true };
      }
    });
  }, delayMs);
  pendingByGroup.set(pendingKey, pending);
  log(`delayed understanding scheduled group=${gid} delay=${delayMs}ms reason=${reason || "ambiguous"}`);
  return true;
}

function isGroupAdmin(event, config) {
  const senderId = asStringId(event.user_id);
  const configuredAdmins = (config.commands?.adminUserIds || []).map(String);
  if (configuredAdmins.includes(senderId)) return true;
  const role = String(event.sender?.role || "").toLowerCase();
  const roles = (config.commands?.adminRoles || ["owner", "admin"]).map((x) => String(x).toLowerCase());
  return roles.includes(role);
}

function quietUntil(memory, groupId) {
  const gm = groupMemory(memory, groupId);
  const raw = gm.settings?.quietUntil;
  const until = Number(raw || 0);
  if (!Number.isFinite(until) || until < 0) return 0;
  return until;
}

function isQuiet(memory, groupId) {
  const until = quietUntil(memory, groupId);
  return until > Date.now();
}

function repairInvalidQuietUntil(memory, groupId) {
  const gm = groupMemory(memory, groupId);
  const raw = gm.settings?.quietUntil;
  if (raw == null || raw === "" || raw === 0) return false;
  const until = Number(raw);
  if (Number.isFinite(until) && until >= 0) return false;
  gm.settings.quietUntil = 0;
  saveMemory(memory);
  warn(`invalid quietUntil repaired group=${groupId} value=${JSON.stringify(raw)}`);
  return true;
}

function markDailySent(memory, groupId, key, dateKey) {
  const gm = groupMemory(memory, groupId);
  gm.dailySent[dateKey] ||= {};
  gm.dailySent[dateKey][key] = true;
}

function wasDailySent(memory, groupId, key, dateKey) {
  const gm = groupMemory(memory, groupId);
  return Boolean(gm.dailySent?.[dateKey]?.[key]);
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutesOfDay(timeText) {
  const match = String(timeText || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function currentMinutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinScheduleWindow(timeText, windowMinutes, date = new Date()) {
  const target = minutesOfDay(timeText);
  if (target == null) return false;
  const diff = currentMinutesOfDay(date) - target;
  return diff >= 0 && diff < Math.max(1, Number(windowMinutes || 3));
}

async function handleBotCommand({ ws, event, text, config, memory }) {
  if (config.commands?.enabled === false) return false;
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/bot")) return false;
  if (event.message_type !== "group") {
    sendGroupMessage(ws, event, "私聊里先不处理 /bot 管理命令，你直接跟我说就行。", config, { reply: true });
    return true;
  }

  const groupId = asStringId(event.group_id);
  const args = trimmed.split(/\s+/).slice(1);
  const command = String(args[0] || "help").toLowerCase();
  const adminOnly = ["quiet", "mute", "安静", "shutup", "resume", "unquiet", "unmute", "醒醒", "remember", "forget", "archive", "存档", "mode", "模式", "style", "风格", "lively", "活泼", "活跃", "normal", "正常", "restrained", "克制"];
  const admin = isGroupAdmin(event, config);
  const resumeCommands = ["resume", "unquiet", "unmute", "醒醒"];
  if (isQuiet(memory, groupId) && (!resumeCommands.includes(command) || !admin)) {
    log(`command ignored while quiet group=${groupId} command=${command || "help"} admin=${admin}`);
    return true;
  }
  if (adminOnly.includes(command) && !admin) {
    sendGroupMessage(ws, event, "这个指令要群主/管理员来用，我先乖巧装没看见。", config, { reply: true });
    return true;
  }

  const gm = groupMemory(memory, groupId);
  if (command === "archive" || command === "存档") {
    const sub = String(args[1] || "status").toLowerCase();
    const meta = archiveConversationMetaFromEvent(event, config);
    const status = archiveEnabledForConversation(memory, meta.conversationId, config);
    const archiveSettings = archiveConversationSettings(memory, meta.conversationId, { create: true });
    if (sub === "status" || sub === "状态") {
      const index = readJsonFileSafe(meta.indexPath, {});
      sendGroupMessage(ws, event, [
        `本群聊天存档：${status ? "开启" : "关闭"}`,
        `记录数：${Number(index.messageCount || 0)}`,
        `搜索记录：${Number(index.webSearchCount || 0)}`,
        `路径：${path.relative(stateRoot, meta.messagesPath)}`
      ].join("\n"), config, { reply: true });
      return true;
    }
    if (sub === "on" || sub === "开启") {
      archiveSettings.archiveEnabled = true;
      archiveSettings.updatedAt = new Date().toISOString();
      saveMemory(memory);
      sendGroupMessage(ws, event, "本群聊天存档已开启。", config, { reply: true });
      return true;
    }
    if (sub === "off" || sub === "关闭") {
      archiveSettings.archiveEnabled = false;
      archiveSettings.updatedAt = new Date().toISOString();
      saveMemory(memory);
      sendGroupMessage(ws, event, "本群聊天存档已关闭；已有本地存档不会自动删除。", config, { reply: true });
      return true;
    }
    if (sub === "clear" || sub === "清理") {
      if (String(args[2] || "").toLowerCase() !== "confirm") {
        sendGroupMessage(ws, event, "清理本群聊天存档需要确认：/bot archive clear confirm", config, { reply: true });
        return true;
      }
      fs.rmSync(meta.dir, { recursive: true, force: true });
      sendGroupMessage(ws, event, "本群聊天存档已清理。", config, { reply: true });
      return true;
    }
    sendGroupMessage(ws, event, "用法：/bot archive status | on | off | clear confirm", config, { reply: true });
    return true;
  }

  if (["mode", "模式", "style", "风格", "lively", "活泼", "活跃", "normal", "正常", "restrained", "克制"].includes(command)) {
    const requested = ["lively", "活泼", "活跃", "normal", "正常", "restrained", "克制"].includes(command)
      ? command
      : args[1];
    const nextMode = normalizeBehaviorMode(requested);
    if (!nextMode) {
      const currentMode = behaviorMode(memory, groupId, config);
      sendGroupMessage(ws, event, `当前模式：${behaviorModeLabel(currentMode)}\n用法：/bot mode lively | normal | restrained`, config, { reply: true });
      return true;
    }
    gm.settings.behaviorMode = nextMode;
    saveMemory(memory);
    sendGroupMessage(ws, event, `已切到${behaviorModeDescription(nextMode)}`, config, { reply: true });
    log(`command mode group=${groupId} mode=${nextMode}`);
    return true;
  }

  if (["quiet", "mute", "安静", "shutup"].includes(command)) {
    const durationMs = parseDurationMs(args[1] || config.commands?.defaultQuietDuration || "10m");
    if (!durationMs) {
      sendGroupMessage(ws, event, "用法：/bot quiet 10m，比如 30s、10m、2h。", config, { reply: true });
      return true;
    }
    gm.settings.quietUntil = Date.now() + durationMs;
    saveMemory(memory);
    sendGroupMessage(ws, event, `收到，我安静 ${formatDuration(durationMs)}。`, config, { reply: true });
    log(`command quiet group=${groupId} durationMs=${durationMs}`);
    return true;
  }

  if (["resume", "unquiet", "unmute", "醒醒"].includes(command)) {
    gm.settings.quietUntil = 0;
    saveMemory(memory);
    sendGroupMessage(ws, event, "我醒了，继续当赛博群友。", config, { reply: true });
    log(`command resume group=${groupId}`);
    return true;
  }

  if (command === "status" || command === "状态") {
    const behaviorConfig = applyBehaviorMode(config, memory, groupId);
    const quietLeft = quietUntil(memory, groupId) - Date.now();
    const userCount = Object.keys(gm.users || {}).length;
    const factCount = (gm.facts || []).length;
    const status = [
      `状态：${quietLeft > 0 ? `安静中，还剩 ${formatDuration(quietLeft)}` : "在线，会聊天"}`,
      `模式：${behaviorModeLabel(behaviorConfig.__behaviorMode)}`,
      `记忆：已见过 ${userCount} 位群友，群梗/记录 ${factCount} 条`,
      `主动接话：${Math.round(Number(behaviorConfig.trigger?.activeProbability || 0) * 100)}%，冷却 ${formatDuration(Number(behaviorConfig.trigger?.activeCooldownMs || 0))}`
    ].join("\n");
    sendGroupMessage(ws, event, status, config, { reply: true });
    return true;
  }

  if (command === "remember" || command === "记住") {
    const fact = args.slice(1).join(" ").trim();
    if (!fact) {
      sendGroupMessage(ws, event, "用法：/bot remember 这里写要记住的群梗或偏好。", config, { reply: true });
      return true;
    }
    dedupePush(gm.facts, fact, Number(config.memory?.maxGroupFacts || 30));
    saveMemory(memory);
    sendGroupMessage(ws, event, "记住了，已经塞进我的赛博小本本。", config, { reply: true });
    return true;
  }

  if (command === "memory" || command === "记忆") {
    const targetUserId = targetUserIdFromMemoryCommand(args, event);
    const fallbackName = targetUserId === asStringId(event.user_id)
      ? event.sender?.card || event.sender?.nickname || targetUserId
      : targetUserId;
    const memoryText = compactUserMemory(gm, targetUserId, config, fallbackName);
    await sendLongGroupMessage(ws, event, memoryText, config, { reply: true });
    return true;
  }

  sendGroupMessage(
    ws,
    event,
    [
      "可用指令：",
      "/bot quiet 10m  安静一会儿",
      "/bot resume  恢复说话",
      "/bot status  看状态",
      "/bot mode lively|normal|restrained  切换活跃/正常/克制",
      "/bot remember <内容>  记住群梗/偏好",
      "/bot memory  查看你在本群的记忆",
      "/bot memory @某人  查看指定群友记忆",
      "/bot archive status|on|off|clear confirm  管理本群聊天存档",
      "/task status|confirm|cancel|resume  管理正式任务",
      "/task add [任务号] <补充>  补充正在执行的任务"
    ].join("\n"),
    config,
    { reply: true }
  );
  return true;
}

function taskModeConfig(config = {}) {
  const cfg = config.taskMode || {};
  return {
    enabled: cfg.enabled !== false,
    shadowMode: cfg.shadowMode === true,
    ownerUserIds: asArray(cfg.ownerUserIds?.length ? cfg.ownerUserIds : config.privateChats?.ownerUserIds).map(asStringId).filter(Boolean),
    allowedGroupIds: asArray(cfg.allowedGroupIds).map(asStringId).filter(Boolean),
    intentJudgeEnabled: cfg.intentJudge?.enabled !== false,
    intentJudgeTimeoutMs: Math.max(2000, Number(cfg.intentJudge?.timeoutMs || 15_000)),
    minConfidence: Math.max(0, Math.min(1, Number(cfg.intentJudge?.minConfidence || 0.68))),
    maxInputChars: Math.max(200, Number(cfg.maxInputChars || 6000)),
    maxArtifactBytes: Math.max(1024, Number(cfg.maxArtifactBytes || 20 * 1024 * 1024))
  };
}

function taskActorFromEvent(event, config) {
  const userId = asStringId(event?.user_id);
  const cfg = taskModeConfig(config);
  return {
    userId,
    owner: cfg.ownerUserIds.includes(userId),
    groupAllowed: event?.message_type === "group" && cfg.allowedGroupIds.includes(asStringId(event?.group_id))
  };
}

function looksLikeComplexTask(text) {
  const source = String(text || "").trim();
  if (!source || source.length < 8) return false;
  const action = /(帮我|请你|执行|完成|制作|生成|整理|调研|调查|分析|批量|自动化|部署|修改|检查|排查|下载|截图|做一份|写一份|创建|处理)/.test(source);
  const complexity = /(然后|并且|同时|最后|步骤|多份|所有|完整|详细|文件|文档|报告|网页|浏览器|电脑|本地|目录|截图|联网|搜索|收集|导出|表格|PDF|Word|PPT|代码|项目)/i.test(source);
  return action && (complexity || source.length >= 48);
}

function taskReasoningEffortForComplexity(complexity) {
  return complexity === "complex" ? "high" : complexity === "simple" ? "low" : "medium";
}

function inferTaskComplexity({ text = "", requestedTools = [], expectedArtifacts = [], requiresLocalFiles = false, requiresComputer = false, requiresAuthenticatedBrowser = false } = {}) {
  const source = String(text || "");
  const tools = new Set(asArray(requestedTools).map(String));
  if (
    requiresLocalFiles
    || requiresComputer
    || requiresAuthenticatedBrowser
    || tools.has("computer_use")
    || tools.has("local_read")
    || tools.has("local_write")
    || /(?:代码项目|代码库|部署|调试|排查|修复|自动化|电脑操作|本地文件|多个产物|复杂依赖)/.test(source)
    || asArray(expectedArtifacts).length >= 2
  ) return "complex";
  if (
    tools.has("web")
    || tools.has("browser")
    || /(?:调研|综合|多步骤|规划|报告|联网|搜索|收集|对比|行程|新闻|政策)/.test(source)
    || source.length >= 80
  ) return "standard";
  return "simple";
}

function withTaskComplexity(decision, text = "") {
  const inferred = inferTaskComplexity({ text, ...decision });
  const requested = ["simple", "standard", "complex"].includes(String(decision?.complexity || "")) ? String(decision.complexity) : inferred;
  const rank = { simple: 0, standard: 1, complex: 2 };
  const complexity = rank[inferred] > rank[requested] ? inferred : requested;
  return { ...decision, complexity, reasoningEffort: taskReasoningEffortForComplexity(complexity) };
}

function ruleTaskDecision(text) {
  const source = String(text || "").trim();
  const expectedArtifacts = [];
  if (/\bpdf\b|PDF/i.test(source)) expectedArtifacts.push("任务结果.pdf");
  if (/(?:word|docx|文档)/i.test(source)) expectedArtifacts.push("任务结果.docx");
  if (/(?:pptx?|幻灯片)/i.test(source)) expectedArtifacts.push("任务结果.pptx");
  if (/(?:xlsx?|excel|表格)/i.test(source)) expectedArtifacts.push("任务结果.xlsx");
  if (/(?:截图|图片)/.test(source)) expectedArtifacts.push("任务截图.png");
  const explicitArtifact = /(?:生成|制作|整理|写|做|导出|创建).{0,30}(?:PDF|pdf|Word|docx|PPT|pptx|Excel|xlsx|文档|报告|文件|表格|截图)/i.test(source);
  const explicitAgentTask = /(?:正式任务|任务化|作为任务|后台执行)/.test(source);
  if (!explicitArtifact && !explicitAgentTask) return null;
  const requestedTools = [/(?:最新|实时|搜索|查找|调研|旅游|旅行|行程|新闻|价格|天气|政策|路线|景点|酒店|餐厅)/.test(source) ? "web" : "todo", "todo"];
  return withTaskComplexity({
    matched: true,
    confidence: 0.94,
    summary: clampText(source.replace(/@\d+\s*/g, ""), 500),
    requestedTools: Array.from(new Set(requestedTools)),
    expectedArtifacts,
    requiresLocalFiles: /(?:读取|修改|处理|根据).{0,20}(?:本地|电脑里|目录|路径|已有文件)/.test(source),
    requiresComputer: /(?:操作|控制|使用).{0,20}(?:电脑|桌面|应用)/.test(source),
    requiresAuthenticatedBrowser: /(?:登录态|已登录|我的账号|登录后的网页)/.test(source),
    reason: "明确要求执行并交付文件"
  }, source);
}

async function judgeTaskIntent({ text, event, history = [], config }) {
  const cfg = taskModeConfig(config);
  if (!cfg.enabled || !looksLikeComplexTask(text)) return { matched: false, reason: "not a complex task candidate", confidence: 0 };
  const actor = taskActorFromEvent(event, config);
  if (!actor.owner && !actor.groupAllowed) return { matched: false, reason: "task mode not allowed in this conversation", confidence: 0 };
  const ruleDecision = ruleTaskDecision(text);
  if (ruleDecision) return ruleDecision;
  if (!cfg.intentJudgeEnabled) {
    return withTaskComplexity({ matched: true, confidence: 0.8, summary: clampText(text, 180), requestedTools: ["web", "todo"], expectedArtifacts: [], reason: "rule candidate" }, text);
  }
  const prompt = `你是 QQ Bot 的任务模式路由器。判断用户是在普通聊天/问答，还是要求执行一个需要多步骤、联网工具、产物或电脑操作的正式任务。

普通解释、一次性问答、随口玩梗必须判为 chat。只有确实值得后台执行和持续汇报的请求才判 task_offer。
群友任务只能使用公开联网、分析、文本和临时文档能力；本地文件、电脑控制和登录态浏览器必须标记出来，随后只能由主人授权。

用户：${event?.sender?.card || event?.sender?.nickname || event?.user_id}(${event?.user_id})
消息：${clampText(text, cfg.maxInputChars)}
最近语境：
${orderedHistory(history).slice(-8).map((item) => shortMessageForPrompt(item, config)).join("\n") || "（无）"}

只输出 JSON：
  {"mode":"chat|task_offer","confidence":0.0,"summary":"准确复述目标","complexity":"simple|standard|complex","requested_tools":["web|todo|browser|computer_use|local_read|local_write"],"expected_artifacts":["产物"],"requires_local_files":false,"requires_computer":false,"requires_authenticated_browser":false,"reason":"短理由"}`;
  try {
    const judgeConfig = { ...config, ai: normalizeAiPatch({ reasoningEffort: "none", timeoutMs: cfg.intentJudgeTimeoutMs }, config) };
    const parsed = extractJsonObject(await callHermes(prompt, judgeConfig));
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence || 0)));
    return withTaskComplexity({
      matched: parsed?.mode === "task_offer" && confidence >= cfg.minConfidence,
      confidence,
      summary: clampText(parsed?.summary || text, 500),
      requestedTools: asArray(parsed?.requested_tools).map(String).slice(0, 8),
      expectedArtifacts: asArray(parsed?.expected_artifacts).map(String).slice(0, 8),
      requiresLocalFiles: parsed?.requires_local_files === true,
      requiresComputer: parsed?.requires_computer === true,
      requiresAuthenticatedBrowser: parsed?.requires_authenticated_browser === true,
      complexity: parsed?.complexity,
      reason: clampText(parsed?.reason || "", 180)
    }, text);
  } catch (err) {
    warn(`task intent judge failed: ${err.message}`);
    const fallback = ruleTaskDecision(text);
    if (fallback) return { ...fallback, confidence: 0.82, reason: `AI 路由失败，按明确任务规则兜底：${err.message}` };
    return { matched: false, confidence: 0, reason: `judge failed: ${err.message}` };
  }
}

function taskOfferText(task) {
  const permissions = [];
  if (task.requiresLocalFiles) permissions.push("本地文件（需主人另行授权路径）");
  if (task.requiresComputer) permissions.push("电脑控制（需主人单独授权）");
  if (task.requiresAuthenticatedBrowser) permissions.push("登录态浏览器（需主人单独授权）");
  if (!permissions.length) permissions.push("隔离联网/文本工具，不访问已有本地文件");
  return [
    `这件事适合任务化：${task.summary}`,
    `复杂度：${task.complexity || "standard"}；任务思考强度：${task.reasoningEffort || "medium"}`,
    `预计使用 ${task.requestedTools.join("、") || "联网、分析、文本"}；${permissions.join("；")}${task.expectedArtifacts.length ? `；产物：${task.expectedArtifacts.join("、")}` : ""}`,
    `回复“确认任务化”我就开始。任务号：${task.id}`
  ].filter(Boolean).join("\n");
}

function taskStatusText(task) {
  if (!task) return "当前会话没有待确认或运行中的任务。";
  const labels = { offered: "等待确认", queued: "排队中", planning: "正在规划", running: "执行中", waiting_permission: "等待授权", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "被重启中断" };
  const startedAt = Date.parse(task.startedAt || task.confirmedAt || task.createdAt || "");
  const elapsed = Number.isFinite(startedAt) ? formatDuration(Math.max(0, Date.now() - startedAt)) : "";
  return [
    `任务：${task.id}`,
    `状态：${labels[task.status] || task.status}${elapsed && !["completed", "failed", "cancelled"].includes(task.status) ? `（已运行 ${elapsed}）` : ""}`,
    `复杂度：${task.complexity || "standard"}；思考强度：${task.reasoningEffort || "medium"}`,
    task.currentStage ? `当前阶段：${task.currentStage}` : "",
    `目标：${task.summary}`,
    task.lastProgressText ? `最近进展：${task.lastProgressText}` : "",
    task.resultSummary ? `结果：${task.resultSummary}` : "",
    task.lastError ? `错误：${task.lastError}` : ""
  ].filter(Boolean).join("\n");
}

function taskActionReply(command, result) {
  if (!result?.ok) return `任务操作没有执行：${result?.reason || "没有找到任务"}`;
  const task = result.task;
  if (command === "confirm" || command === "确认") return `收到，开始做。任务号 ${task.id}，你随时可以问我“进度怎么样”。`;
  if (command === "resume" || command === "恢复") return `收到，继续执行任务 ${task.id}。`;
  if (command === "cancel" || command === "取消") return `任务 ${task.id} 已取消。`;
  if (command === "grant" || command === "授权") return `授权已记录，任务 ${task.id} 会继续执行。`;
  if (command === "add" || command === "补充") return `补充要求已记下，会并入任务 ${task.id}。`;
  return taskStatusText(task);
}

async function handleTaskControl({ taskRuntime, ws, event, text, config, memory }) {
  if (!taskRuntime || taskModeConfig(config).enabled === false) return false;
  const trimmed = String(text || "").trim();
  const naturalConfirm = /^(确认任务化|确认执行任务|正式执行|开始任务)$/.test(trimmed);
  const naturalCancel = /^(取消任务|不要任务化|不用执行了)$/.test(trimmed);
  const naturalProgress = /^(?:(?:这个|那个)?任务(?:现在)?\s*)?(?:进度(?:怎么样了?)?|做到哪(?:儿)?了?|怎么样了?|什么情况|完成了吗?|弄好了吗?|还要多久)[？?。！!]*$/.test(trimmed);
  const isCommand = /^\/task(?:\s|$)/i.test(trimmed);
  const conversationId = conversationIdFromEvent(event);
  const activeTask = taskRuntime.activeForConversation(conversationId);
  const latestTask = taskRuntime.list({ conversationId, limit: 1 })[0] || null;
  const explicitProgressWords = /(?:任务|进度|做到哪|完成|弄好|还要多久)/.test(trimmed);
  const progressTask = activeTask || (explicitProgressWords ? latestTask : null);
  if (!naturalConfirm && !naturalCancel && !isCommand && !(naturalProgress && progressTask)) return false;
  archiveConversationEvent({
    event,
    config,
    memory,
    text: trimmed,
    rawText: trimmed,
    senderName: event?.sender?.card || event?.sender?.nickname || asStringId(event?.user_id),
    accountId: config.__activeAccountId || "primary"
  });
  const args = isCommand ? trimmed.split(/\s+/).slice(1) : [];
  const command = naturalConfirm ? "confirm" : naturalCancel ? "cancel" : naturalProgress ? "status" : String(args[0] || "status").toLowerCase();
  const explicitTaskId = args.find((item) => /^task_/.test(item));
  const task = explicitTaskId ? taskRuntime.get(explicitTaskId) : activeTask || (command === "status" ? progressTask || latestTask : null);
  const actor = { userId: asStringId(event.user_id), source: "qq" };
  let result;
  if (command === "confirm" || command === "确认") result = taskRuntime.confirm(task?.id, actor);
  else if (command === "resume" || command === "恢复") result = taskRuntime.resume(task?.id, actor);
  else if (command === "cancel" || command === "取消") result = taskRuntime.cancel(task?.id, actor);
  else if (command === "grant" || command === "授权") {
    const typeIndex = explicitTaskId ? args.indexOf(explicitTaskId) + 1 : 1;
    const type = String(args[typeIndex] || "").toLowerCase();
    const target = args.slice(typeIndex + 1).join(" ").trim();
    result = taskRuntime.grant(task?.id, { type, target, purpose: `QQ command from ${event.user_id}` }, actor);
  } else if (command === "add" || command === "补充") {
    const startIndex = explicitTaskId ? args.indexOf(explicitTaskId) + 1 : 1;
    result = taskRuntime.addContext(task?.id, args.slice(startIndex).join(" "), actor);
  } else {
    const reply = taskStatusText(task);
    sendGroupMessage(ws, event, reply, config, { reply: true });
    archiveBotReply({ event, config, memory, text: reply, meta: { source: "task-status", user_id: event?.self_id || "bot", replyToUserId: event?.user_id, replyToSender: event?.sender?.card || event?.sender?.nickname || "" } });
    return true;
  }
  const reply = taskActionReply(command, result);
  sendGroupMessage(ws, event, reply, config, { reply: true });
  archiveBotReply({ event, config, memory, text: reply, meta: { source: `task-${command}`, user_id: event?.self_id || "bot", replyToUserId: event?.user_id, replyToSender: event?.sender?.card || event?.sender?.nickname || "" } });
  return true;
}

function safeTaskArtifactName(name, index = 0) {
  const clean = path.basename(String(name || `artifact-${index + 1}.md`)).replace(/[^\p{L}\p{N}_. -]/gu, "-").slice(0, 120);
  return clean || `artifact-${index + 1}.md`;
}

function sandboxProfileString(outputsDir, grants = [], agentCommand = "hermesqq2") {
  const literal = (value) => `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const home = os.homedir();
  const readable = [
    "/System", "/usr", "/bin", "/sbin", "/Library", "/opt/homebrew", "/private/etc", "/private/var/db/timezone",
    path.join(home, ".local"), path.join(home, ".hermes"), path.join(home, ".config", "hermes"), outputsDir,
    ...asArray(grants).filter((grant) => grant.type === "read").map((grant) => path.resolve(String(grant.target || "")))
  ].filter(Boolean);
  const writable = [
    outputsDir,
    "/tmp",
    "/private/tmp",
    path.join(home, ".hermes", "sessions"),
    path.join(home, ".hermes", "logs"),
    path.join(home, ".hermes", "profiles", path.basename(String(agentCommand || "hermesqq2")), "logs")
  ];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow file-read-metadata)",
    "(allow file-read-data (literal \"/\"))",
    ...readable.map((item) => `(allow file-read* (subpath ${literal(item)}))`),
    ...writable.map((item) => `(allow file-write* (subpath ${literal(item)}))`),
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/urandom\"))",
    "(allow file-write* (literal \"/dev/null\"))"
  ].join("\n");
}

function applyTaskWriteGrants(task, artifacts, outputsDir) {
  const written = [];
  const grants = asArray(task.grants).filter((grant) => grant.type === "write");
  if (!grants.length || !artifacts.length) return written;
  for (const grant of grants) {
    const target = path.resolve(String(grant.target || ""));
    const targetLooksDirectory = String(grant.target || "").endsWith(path.sep) || (fs.existsSync(target) && fs.statSync(target).isDirectory());
    const selected = targetLooksDirectory ? artifacts : artifacts.slice(0, 1);
    if (targetLooksDirectory) fs.mkdirSync(target, { recursive: true });
    for (const artifact of selected) {
      const source = path.join(outputsDir, artifact.name);
      const destination = targetLooksDirectory ? path.join(target, artifact.name) : target;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) {
        const backup = `${destination}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(destination, backup);
      }
      fs.copyFileSync(source, destination);
      written.push({ name: path.basename(destination), size: fs.statSync(destination).size });
    }
  }
  return written;
}

function taskGrantedFileContext(task, config) {
  const maxChars = Math.max(1000, Number(config.taskMode?.maxGrantedFileChars || 120_000));
  const denied = /(^|\/)(\.env(?:\.|$)|id_rsa|id_ed25519|credentials|secrets?|cookies?|keychain)(\/|$)/i;
  const chunks = [];
  let used = 0;
  for (const grant of asArray(task.grants).filter((item) => item.type === "read")) {
    const filePath = path.resolve(String(grant.target || ""));
    if (denied.test(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const remain = maxChars - used;
    if (remain <= 0) break;
    const content = fs.readFileSync(filePath, "utf8").slice(0, remain);
    chunks.push(`【已授权文件：${path.basename(filePath)}】\n${content}`);
    used += content.length;
  }
  return chunks.join("\n\n");
}

function taskResearchQueries(task) {
  const objective = String(task?.objective || "")
    .replace(/@[^\s，。！？!?]+/g, " ")
    .replace(/(?:帮我|请|生成|制作|整理|输出|一份|详细的?)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!objective) return [];

  const queries = [];
  const add = (value) => {
    const query = clampText(String(value || "").replace(/\s+/g, " ").trim(), 120);
    if (query && !queries.includes(query)) queries.push(query);
  };
  const travelTask = /(自驾|旅游|旅行|行程|路线|景点)/.test(objective);
  if (travelTask) {
    const originRaw = objective.match(/([\u4e00-\u9fff]{2,12})出发/)?.[1] || "";
    const origin = originRaw.split("的").pop().replace(/^[日一二三四五六七八九十两天晚]+/, "");
    const destinations = [...objective.matchAll(/([\u4e00-\u9fff]{2,8}?)(?:一|二|三|四|五|六|七|八|九|十|两|\d+)天/g)]
      .map((match) => match[1].replace(/^(?:从|到|去|和|及)/, ""))
      .filter((value) => value && value !== origin)
      .slice(0, 3);
    const locations = [...new Set([origin, ...destinations].filter(Boolean))];
    if (locations.length) add(`${locations.join(" ")} 自驾路线 驾车时间 停车`);
    for (const destination of destinations) add(`${destination} 旅游景点 开放时间 门票 停车 攻略`);
  }
  add(objective);
  return queries.slice(0, 3);
}

async function buildTaskResearchContext(task, config) {
  const requestedWeb = asArray(task?.requestedTools).includes("web");
  if (!requestedWeb) return { text: "", queries: [], sources: [], errors: [] };
  if (config.webSearch?.enabled === false) {
    return { text: "联网搜索已关闭；不能把实时开放时间、票价或政策写成确定事实。", queries: [], sources: [], errors: ["web search disabled"] };
  }
  const queries = taskResearchQueries(task);
  if (!queries.length) return { text: "", queries: [], sources: [], errors: [] };
  const settled = await Promise.allSettled(queries.map((query) => webSearch(query, config)));
  const sources = [];
  const errors = [];
  const sections = [];
  for (let index = 0; index < settled.length; index += 1) {
    const query = queries[index];
    const outcome = settled[index];
    if (outcome.status === "rejected") {
      errors.push(`${query}: ${outcome.reason?.message || outcome.reason}`);
      sections.push(`查询 ${index + 1}：${query}\n结果：搜索失败。`);
      continue;
    }
    const search = outcome.value || { provider: "unknown", results: [] };
    if (search.error) errors.push(`${query}: ${search.error}`);
    const genericTerms = new Set(["旅游", "旅游景点", "景点", "开放时间", "门票", "停车", "攻略", "路线", "驾车时间", "自驾"]);
    const specificTerms = searchCoreTerms(query).filter((term) => !genericTerms.has(term));
    const usableResults = asArray(search.results).filter((item) => {
      if (!specificTerms.length) return true;
      const text = `${item.title || ""} ${item.snippet || ""} ${item.link || ""}`.toLowerCase();
      return specificTerms.some((term) => text.includes(String(term).toLowerCase()));
    });
    const rows = usableResults.slice(0, 4).map((item) => {
      const source = {
        query,
        provider: item.source || search.provider || "unknown",
        title: clampText(item.title || "无标题", 240),
        link: String(item.link || "").slice(0, 1000),
        snippet: clampText(item.snippet || "", 700)
      };
      if (source.link && !sources.some((existing) => existing.link === source.link)) sources.push(source);
      return `- ${source.title}\n  链接：${source.link || "无"}${source.snippet ? `\n  摘要：${source.snippet}` : ""}`;
    });
    sections.push(`查询 ${index + 1}：${query}\n搜索源：${search.provider || "unknown"}\n${rows.length ? rows.join("\n") : "结果：没有可用条目。"}`);
  }
  const text = clampText([
    `检索时间：${localNowText()}`,
    "以下是桥接层实际完成的联网检索证据。只可引用与目标直接相关的内容；开放时间、票价、路况等易变信息若缺少明确证据，必须提示用户出发前复核。",
    ...sections
  ].join("\n\n"), 14_000);
  return { text, queries, sources: sources.slice(0, 12), errors: errors.slice(0, 10) };
}

async function runHermesAgentTask(task, { signal, outputsDir, config: runtimeConfig }, config) {
  const grants = asArray(task.grants);
  if (task.requiresComputer && !grants.some((grant) => grant.type === "computer")) {
    return { ok: false, waitingPermission: true, summary: "需要主人使用 /task grant computer <用途> 授权电脑控制。" };
  }
  if (task.requiresAuthenticatedBrowser && !grants.some((grant) => grant.type === "authenticated_browser")) {
    return { ok: false, waitingPermission: true, summary: "需要主人使用 /task grant authenticated_browser <用途> 授权登录态浏览器。" };
  }
  if (task.requiresLocalFiles && !grants.some((grant) => ["read", "write"].includes(grant.type))) {
    return { ok: false, waitingPermission: true, summary: "需要主人用 /task grant read|write <绝对路径> 授权具体文件路径。" };
  }
  const research = await buildTaskResearchContext(task, config);
  task.research = {
    searchedAt: new Date().toISOString(),
    queries: research.queries,
    sources: research.sources,
    errors: research.errors
  };
  // DeepSeek currently emits Hermes tool-call markup for web/todo instead of
  // executing it reliably. Web research is therefore completed by the bridge's
  // controlled Google -> Baidu path before synthesis. Keep only explicitly
  // granted interactive tools in the Hermes process.
  const allowedToolsets = new Set();
  if (task.permissionTier === "owner") {
    if (task.requestedTools.includes("browser") && !task.requiresAuthenticatedBrowser) allowedToolsets.add("browser");
    if (grants.some((grant) => grant.type === "computer")) allowedToolsets.add("computer_use");
  }
  const fileContext = taskGrantedFileContext(task, config);
  const prompt = `你正在执行一个由 QQ Bot 正式确认的后台任务。保持 Hermes Agent 的规划和工具能力，但严格遵守权限。

任务号：${task.id}
目标：${task.objective}
任务复杂度：${task.complexity || "standard"}；思考强度：${task.reasoningEffort || "medium"}
期望产物：${asArray(task.expectedArtifacts).join("、") || "按任务需要生成"}
${asArray(task.supplements).length ? `任务补充：\n${asArray(task.supplements).map((item) => `[${item.at}] ${item.text}`).join("\n")}` : ""}
${task.previousResultSummary ? `上一阶段结果：\n${task.previousResultSummary}` : ""}
权限级别：${task.permissionTier}
允许工具：${Array.from(allowedToolsets).join(",") || "无（联网资料已由桥接层受控获取，本轮不要输出或尝试工具调用）"}
输出目录概念：只能通过最终 JSON 交付产物，不要尝试读取其他本地文件，不要使用终端或 file 工具。
${fileContext ? `\n主人明确授权并由桥接读取的文件内容：\n${fileContext}` : ""}
${research.text ? `\n联网检索证据：\n${research.text}` : ""}

完成后只输出 JSON，不要 Markdown 围栏：
{
  "ok": true,
  "summary": "给 QQ 用户看的简洁结果摘要",
  "artifacts": [
    {"name":"report.md","type":"text/markdown","content":"完整文档内容"}
  ]
}
产物最多 8 个。若用户要求 PDF，请把完整、详细、可直接排版的正文放进一个 .md 产物，桥接层会把它可靠转换成真正的 PDF；不要把普通文本伪装成 .pdf。不要声称没有证据的操作成功；如果工具失败，把 ok 设为 false 并在 summary 说明。`;
  const ai = aiSettingsFromConfig(config);
  const command = config.ai?.command || "hermesqq2";
  const args = [...hermesProfileArgPrefix(config), "chat", "-q", prompt, "-Q"];
  if (ai.model) args.push("-m", ai.model);
  if (ai.provider) args.push("--provider", ai.provider);
  if (allowedToolsets.size) args.push("-t", Array.from(allowedToolsets).join(","));
  args.push("--max-turns", String(runtimeConfig.maxTurns || 30), "--source", "qq-bot-task", "--ignore-rules");
  const timeoutMs = Math.min(Number(runtimeConfig.maxRuntimeMs || 20 * 60_000), Number(config.taskMode?.maxRuntimeMs || 20 * 60_000));
  const raw = await new Promise((resolve, reject) => {
    const useSandbox = config.taskMode?.useSandboxExec !== false && process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec") && !grants.some((grant) => grant.type === "computer");
    let spawnCommand = command;
    let spawnArgs = args;
    if (useSandbox) {
      const profilePath = path.join(path.dirname(outputsDir), "sandbox.sb");
      fs.writeFileSync(profilePath, `${sandboxProfileString(outputsDir, grants, command)}\n`);
      spawnCommand = "/usr/bin/sandbox-exec";
      spawnArgs = ["-f", profilePath, command, ...args];
    }
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: outputsDir,
      env: { ...process.env, HERMES_REASONING_EFFORT: String(task.reasoningEffort || "medium") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`task timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("error", reject);
    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("task cancelled"));
      if (code === 0) resolve(stdout.trim());
      else if (closeSignal) reject(new Error(`task agent terminated by signal ${closeSignal}: ${stderr.slice(-1000)}`));
      else reject(new Error(`task agent exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
  const parsed = extractJsonObject(raw) || { ok: true, summary: raw, artifacts: [] };
  const artifacts = [];
  let totalBytes = 0;
  for (const [index, artifact] of asArray(parsed.artifacts).slice(0, 8).entries()) {
    if (!artifact || typeof artifact !== "object") continue;
    const name = safeTaskArtifactName(artifact.name, index);
    let buffer;
    if (artifact.encoding === "base64") buffer = Buffer.from(String(artifact.content || ""), "base64");
    else buffer = Buffer.from(String(artifact.content || ""), "utf8");
    if (!buffer.length || totalBytes + buffer.length > runtimeConfig.maxArtifactBytes) continue;
    const filePath = path.join(outputsDir, name);
    fs.writeFileSync(filePath, buffer);
    totalBytes += buffer.length;
    artifacts.push({ name, type: artifact.type || "application/octet-stream", size: buffer.length });
  }
  task.resultSummary = clampText(parsed.summary || raw, 3500);
  const ensured = ensureRequestedTaskArtifacts({ task, artifacts, outputsDir, maxArtifactBytes: runtimeConfig.maxArtifactBytes });
  const deliverableArtifacts = ensured.artifacts;
  const written = applyTaskWriteGrants(task, deliverableArtifacts, outputsDir);
  const summary = clampText(parsed.summary || raw, 3500);
  const artifactError = ensured.ok ? "" : `产物处理失败：${ensured.error || "未知错误"}`;
  return {
    ok: parsed.ok !== false && ensured.ok,
    summary: [summary, taskRequestsPdf(task) && ensured.pdfCreated ? "PDF 已生成。" : "", written.length ? `已按授权写入：${written.map((item) => item.name).join("、")}` : "", artifactError].filter(Boolean).join("\n"),
    error: artifactError || (parsed.ok === false ? summary || "任务模型返回失败" : ""),
    artifacts: deliverableArtifacts
  };
}

// --- Hourly Chat ---

const hourlyChatState = { lastSentAt: 0 };

async function runHourlyChat({ ws, config }) {
  if (config.hourlyChat?.enabled === false) return;
  if (ws.readyState !== 1) return;

  const hc = config.hourlyChat || {};
  const intervalMs = Number(hc.checkIntervalMs || 60000);

  // Determine owner user IDs: prefer explicit config, fall back to admin notification recipients or ownerUserIds
  const ownerIds = hc.ownerUserIds && hc.ownerUserIds.length
    ? hc.ownerUserIds
    : (config.adminNotifications?.recipients || []);
  if (!ownerIds.length) return;

  const nowMs = Date.now();
  const hourMs = 3600000;
  if (nowMs - hourlyChatState.lastSentAt < hourMs) return;
  hourlyChatState.lastSentAt = nowMs;

  const timeStr = localNowText();
  const prompt = (hc.prompt || "现在时间 {{time}}。给你的主人发一条简短私聊。").replace("{{time}}", timeStr);

  try {
    const response = await callHermes(prompt, config);
    const trimmed = (response || "").trim();
    if (!trimmed || trimmed === "__SKIP__") return;

    for (const uid of ownerIds) {
      sendPrivateMessageToUser(ws, uid, trimmed, config);
    }
    log(`hourly chat sent to ${ownerIds.join(",")} text=${JSON.stringify(trimmed)}`);
  } catch (err) {
    warn(`hourly chat failed: ${err.message}`);
  }
}

async function runDailyMessages({ ws, config, memory, historyByGroup, lastEventByGroup, lastBotMessageByGroup }) {
  const daily = config.dailyMessages;
  if (daily?.enabled === false) return;
  if (ws.readyState !== 1) return;

  const schedules = daily?.schedules || [];
  if (!schedules.length) return;

  const dateKey = localDateKey();
  const windowMinutes = Number(daily?.windowMinutes || 3);
  const groups = handlesAllGroups(config)
    ? Array.from(lastEventByGroup.keys()).filter((id) => !String(id).startsWith("private:"))
    : targetGroups(config);

  for (const schedule of schedules) {
    if (schedule.enabled === false) continue;
    const key = String(schedule.name || schedule.mode || schedule.time || "daily");
    if (!isWithinScheduleWindow(schedule.time, windowMinutes)) continue;

    for (const groupIdRaw of groups) {
      const groupId = asStringId(groupIdRaw);
      if (!groupId || wasDailySent(memory, groupId, key, dateKey) || isQuiet(memory, groupId)) continue;

      const history = historyByGroup.get(groupId) || [];
      const lastEvent = lastEventByGroup.get(groupId);
      if (daily?.requireKnownGroup !== false && !lastEvent && handlesAllGroups(config)) continue;
      if (schedule.requireHistory && history.length === 0) continue;

      try {
        const memoryText = compactMemory(memory, groupId, config);
        const current = {
          sender: "系统",
          user_id: "system",
          text: schedule.prompt || schedule.instruction || `${key} 定时消息`
        };
        const contextBundle = config.reply?.useContextBundle === false
          ? null
          : buildContextBundle({ memory, groupId, history, current, config });
        const prompt = buildPrompt({
          config,
          history,
          current,
          mode: schedule.mode || key,
          memoryText,
          contextBundle
        });
        const response = trimForGroup(await callHermes(prompt, config), config);
        if (!response) continue;
        sendGroupMessageToGroup(ws, groupId, response, config);
        recordBotMessage({
          historyByGroup,
          lastBotMessageByGroup,
          groupId,
          text: response,
          config,
          memory,
          meta: {
            source: schedule.mode || key,
            mentionedUserIds: relatedUserIdsFromText(response, groupMemory(memory, groupId))
          }
        });

        const gm = groupMemory(memory, groupId);
        if ((schedule.mode || key) === "summary") {
          gm.summaries.push({ date: dateKey, text: response, at: now() });
          while (gm.summaries.length > Number(config.memory?.maxSummaries || 14)) gm.summaries.shift();
        }
        markDailySent(memory, groupId, key, dateKey);
        saveMemory(memory);
        log(`daily message sent group=${groupId} key=${key}`);
      } catch (err) {
        warn(`daily message failed group=${groupId} key=${key}: ${err.message}`);
      }
    }
  }
}

function publicConfig(config) {
  return {
    ai: aiSettingsFromConfig(config),
    aiProfiles: publicAiProfiles(config),
    vision: deepClone(config.vision || {}),
    webSearch: deepClone(config.webSearch || {}),
    behaviorModes: deepClone(config.behaviorModes || {}),
    privateChats: deepClone(config.privateChats || {}),
    trigger: deepClone(config.trigger || {}),
    proactive: deepClone(config.proactive || {}),
    socialPlanner: deepClone(config.socialPlanner || {}),
    reply: deepClone(config.reply || {}),
    implicitReply: deepClone(config.implicitReply || {}),
    history: deepClone(config.history || {}),
    delayedUnderstanding: deepClone(config.delayedUnderstanding || {}),
    messageDebounce: deepClone(config.messageDebounce || {}),
    responseQueue: deepClone(config.responseQueue || {}),
    chatArchive: deepClone(config.chatArchive || {}),
    messageTime: deepClone(config.messageTime || {}),
    taskMode: deepClone(config.taskMode || {}),
    reviewer: deepClone(config.reviewer || {}),
    adminNotifications: deepClone(config.adminNotifications || {}),
    loginRecovery: deepClone(config.loginRecovery || {}),
    observability: deepClone(config.observability || {}),
    accounts: deepClone(config.accounts || {}),
    memory: deepClone(config.memory || {}),
    prompt: { system: config.prompt?.system || "" },
    send: deepClone(config.send || {}),
    readonly: {
      listen: deepClone(config.listen || {}),
      control: deepClone(config.control || {}),
      configPath: config.__path || configPath
    }
  };
}

function sanitizeVisionPatch(value, current) {
  const next = deepClone(current.vision || {});
  if (!isPlainObject(value)) return next;
  setIfPresent(next, value, "enabled", (x) => booleanValue(x, true));
  setIfPresent(next, value, "provider", (x) => stringValue(x).trim());
  setIfPresent(next, value, "model", (x) => stringValue(x).trim());
  setIfPresent(next, value, "toolsets", (x) => stringValue(x, "vision").trim() || "vision");
  setIfPresent(next, value, "onlyWhenMentionedOrAsked", (x) => booleanValue(x, true));
  setIfPresent(next, value, "includeQuotedImages", (x) => booleanValue(x, true));
  setIfPresent(next, value, "includeImageEmojis", (x) => booleanValue(x, true));
  setIfPresent(next, value, "aggressiveFollowup", (x) => booleanValue(x, true));
  setIfPresent(next, value, "contextAssist", (x) => booleanValue(x, true));
  setIfPresent(next, value, "describeWhenUncertain", (x) => booleanValue(x, true));
  setIfPresent(next, value, "followupWindowMs", (x) => Math.round(numberInRange(x, 300000, 10000, 3600000)));
  setIfPresent(next, value, "followupMaxMessagesAfterBot", (x) => Math.round(numberInRange(x, 3, 1, 12)));
  setIfPresent(next, value, "contextAssistWindowMs", (x) => Math.round(numberInRange(x, 300000, 10000, 3600000)));
  setIfPresent(next, value, "contextAssistRecentMessages", (x) => Math.round(numberInRange(x, 10, 3, 30)));
  setIfPresent(next, value, "contextAssistMaxMessagesAfterBot", (x) => Math.round(numberInRange(x, 6, 1, 20)));
  setIfPresent(next, value, "contextAssistShortTextMaxLength", (x) => Math.round(numberInRange(x, 24, 0, 120)));
  setIfPresent(next, value, "maxQuotedMessages", (x) => Math.round(numberInRange(x, 2, 0, 5)));
  setIfPresent(next, value, "maxImagesPerMessage", (x) => Math.round(numberInRange(x, 2, 1, 4)));
  setIfPresent(next, value, "maxImageBytes", (x) => Math.round(numberInRange(x, 32 * 1024 * 1024, 128 * 1024, 64 * 1024 * 1024)));
  setIfPresent(next, value, "maxHermesImageBytes", (x) => Math.round(numberInRange(x, 6 * 1024 * 1024, 512 * 1024, 20 * 1024 * 1024)));
  setIfPresent(next, value, "resizeMaxPixels", (x) => Math.round(numberInRange(x, 1800, 600, 4096)));
  setIfPresent(next, value, "jpegQuality", (x) => Math.round(numberInRange(x, 84, 40, 95)));
  setIfPresent(next, value, "downloadTimeoutMs", (x) => Math.round(numberInRange(x, 15000, 1000, 60000)));
  setIfPresent(next, value, "timeoutMs", (x) => Math.round(numberInRange(x, 120000, 1000, 600000)));
  setIfPresent(next, value, "maxDescriptionLength", (x) => Math.round(numberInRange(x, 260, 80, 800)));
  setIfPresent(next, value, "cacheMaxAgeMs", (x) => Math.round(numberInRange(x, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000)));
  setIfPresent(next, value, "prompt", (x) => stringValue(x).slice(0, 3000));
  if (isPlainObject(value.aiJudge)) {
    next.aiJudge ||= {};
    setIfPresent(next.aiJudge, value.aiJudge, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.aiJudge, value.aiJudge, "minConfidence", (x) => numberInRange(x, 0.55, 0, 1));
    setIfPresent(next.aiJudge, value.aiJudge, "followupOverrideMinConfidence", (x) => numberInRange(x, 0.25, 0, 1));
    setIfPresent(next.aiJudge, value.aiJudge, "uncertainMaxConfidence", (x) => numberInRange(x, 0.7, 0, 1));
    setIfPresent(next.aiJudge, value.aiJudge, "timeoutMs", (x) => Math.round(numberInRange(x, 120000, 1000, 600000)));
    setIfPresent(next.aiJudge, value.aiJudge, "fallback", (x) => ["skip", "rule"].includes(stringValue(x).trim()) ? stringValue(x).trim() : "rule");
  }
  return next;
}

function sanitizeWebSearchPatch(value, current) {
  const next = deepClone(current.webSearch || {});
  if (!isPlainObject(value)) return next;
  setIfPresent(next, value, "enabled", (x) => booleanValue(x, true));
  setIfPresent(next, value, "provider", (x) => stringValue(x, "google").trim() || "google");
  setIfPresent(next, value, "providerOrder", (x) => asArray(x).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6));
  setIfPresent(next, value, "maxResults", (x) => Math.round(numberInRange(x, 4, 1, 10)));
  setIfPresent(next, value, "timeoutMs", (x) => Math.round(numberInRange(x, 8000, 1000, 60000)));
  setIfPresent(next, value, "minResultScore", (x) => numberInRange(x, 1, 0, 20));
  setIfPresent(next, value, "appendDateForFreshQueries", (x) => booleanValue(x, true));
  setIfPresent(next, value, "aggregateProviders", (x) => booleanValue(x, false));
  if (isPlainObject(value.aiJudge)) {
    next.aiJudge ||= {};
    setIfPresent(next.aiJudge, value.aiJudge, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.aiJudge, value.aiJudge, "minConfidence", (x) => numberInRange(x, 0.55, 0, 1));
    setIfPresent(next.aiJudge, value.aiJudge, "timeoutMs", (x) => Math.round(numberInRange(x, 120000, 1000, 600000)));
    setIfPresent(next.aiJudge, value.aiJudge, "fallback", (x) => {
      const value = stringValue(x, "skip").trim().toLowerCase();
      return ["skip", "rule"].includes(value) ? value : "skip";
    });
  }
  if (isPlainObject(value.proxy)) {
    next.proxy ||= {};
    setIfPresent(next.proxy, value.proxy, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.proxy, value.proxy, "autoDetect", (x) => booleanValue(x, true));
    setIfPresent(next.proxy, value.proxy, "directFallback", (x) => booleanValue(x, true));
    setIfPresent(next.proxy, value.proxy, "urls", (x) => asArray(x).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12));
  }
  if (isPlainObject(value.google)) {
    next.google ||= {};
    setIfPresent(next.google, value.google, "proxy", (x) => booleanValue(x, true));
    setIfPresent(next.google, value.google, "newsLang", (x) => stringValue(x, "zh-CN").trim());
    setIfPresent(next.google, value.google, "newsRegion", (x) => stringValue(x, "CN").trim());
    setIfPresent(next.google, value.google, "newsCeid", (x) => stringValue(x, "CN:zh-Hans").trim());
  }
  if (isPlainObject(value.baidu)) {
    next.baidu ||= {};
    setIfPresent(next.baidu, value.baidu, "proxy", (x) => booleanValue(x, false));
  }
  if (isPlainObject(value.weather)) {
    next.weather ||= {};
    setIfPresent(next.weather, value.weather, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.weather, value.weather, "timeoutMs", (x) => Math.round(numberInRange(x, 8000, 1000, 60000)));
    setIfPresent(next.weather, value.weather, "defaultLocation", (x) => stringValue(x).trim());
  }
  return next;
}

function sanitizeConfigPatch(patch, currentConfig) {
  if (!isPlainObject(patch)) throw new Error("patch must be an object");
  const next = deepClone(currentConfig);
  if (isPlainObject(patch.ai)) next.ai = normalizeAiPatch(patch.ai, next);
  if (isPlainObject(patch.aiProfiles)) {
    next.aiProfiles = normalizeAiProfiles(patch.aiProfiles, next);
    const activeProfile = activeAiProfile(next.aiProfiles);
    if (activeProfile) next.ai = normalizeAiPatch(activeProfile, next);
  }
  if (isPlainObject(patch.vision)) next.vision = sanitizeVisionPatch(patch.vision, next);
  if (isPlainObject(patch.webSearch)) next.webSearch = sanitizeWebSearchPatch(patch.webSearch, next);
  if (isPlainObject(patch.prompt)) {
    next.prompt ||= {};
    setIfPresent(next.prompt, patch.prompt, "system", (x) => stringValue(x).slice(0, 12000));
  }
  if (isPlainObject(patch.behaviorModes)) {
    next.behaviorModes ||= {};
    setIfPresent(next.behaviorModes, patch.behaviorModes, "default", (x) => normalizeBehaviorMode(x) || "normal");
  }
  if (isPlainObject(patch.privateChats)) {
    next.privateChats ||= {};
    setIfPresent(next.privateChats, patch.privateChats, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.privateChats, patch.privateChats, "targetUsers", (x) => asArray(x).map(asStringId).filter(Boolean).slice(0, 100));
    setIfPresent(next.privateChats, patch.privateChats, "ownerUserIds", (x) => asArray(x).map(asStringId).filter(Boolean).slice(0, 20));
    setIfPresent(next.privateChats, patch.privateChats, "ownerSystem", (x) => stringValue(x).slice(0, 4000));
  }
  if (isPlainObject(patch.trigger)) {
    next.trigger ||= {};
    setIfPresent(next.trigger, patch.trigger, "activeReply", (x) => booleanValue(x, true));
    setIfPresent(next.trigger, patch.trigger, "activeProbability", (x) => numberInRange(x, 0.12, 0, 1));
    setIfPresent(next.trigger, patch.trigger, "activeCooldownMs", (x) => Math.round(numberInRange(x, 120000, 1000, 3600000)));
  }
  if (isPlainObject(patch.proactive)) {
    next.proactive ||= {};
    setIfPresent(next.proactive, patch.proactive, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.proactive, patch.proactive, "probability", (x) => numberInRange(x, 0.25, 0, 1));
    setIfPresent(next.proactive, patch.proactive, "intervalMs", (x) => Math.round(numberInRange(x, 180000, 10000, 86400000)));
    setIfPresent(next.proactive, patch.proactive, "cooldownMs", (x) => Math.round(numberInRange(x, 900000, 10000, 86400000)));
  }
  if (isPlainObject(patch.socialPlanner)) {
    next.socialPlanner ||= {};
    setIfPresent(next.socialPlanner, patch.socialPlanner, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.socialPlanner, patch.socialPlanner, "shadowMode", (x) => booleanValue(x, true));
    setIfPresent(next.socialPlanner, patch.socialPlanner, "timeoutMs", (x) => Math.round(numberInRange(x, 30000, 2000, 120000)));
    setIfPresent(next.socialPlanner, patch.socialPlanner, "recentMessages", (x) => Math.round(numberInRange(x, 12, 4, 24)));
    setIfPresent(next.socialPlanner, patch.socialPlanner, "minCandidateConfidence", (x) => numberInRange(x, 0.2, 0, 1));
    setIfPresent(next.socialPlanner, patch.socialPlanner, "minConfidence", (x) => numberInRange(x, 0.55, 0, 1));
  }
  if (isPlainObject(patch.reply)) {
    next.reply ||= {};
    setIfPresent(next.reply, patch.reply, "useContextBundle", (x) => booleanValue(x, true));
    setIfPresent(next.reply, patch.reply, "allowSkip", (x) => booleanValue(x, true));
    setIfPresent(next.reply, patch.reply, "repetitionWindow", (x) => Math.round(numberInRange(x, 20, 5, 100)));
    setIfPresent(next.reply, patch.reply, "maxRepeatedOpening", (x) => Math.round(numberInRange(x, 2, 1, 10)));
    setIfPresent(next.reply, patch.reply, "openingSignatureLength", (x) => Math.round(numberInRange(x, 10, 4, 30)));
  }
  if (isPlainObject(patch.implicitReply)) {
    next.implicitReply ||= {};
    setIfPresent(next.implicitReply, patch.implicitReply, "recentBotMessages", (x) => Math.round(numberInRange(x, 6, 1, 12)));
  }
  if (isPlainObject(patch.history)) {
    next.history ||= {};
    setIfPresent(next.history, patch.history, "maxQuotedMessages", (x) => Math.round(numberInRange(x, 4, 1, 8)));
  }
  if (isPlainObject(patch.delayedUnderstanding)) {
    next.delayedUnderstanding ||= {};
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "waitMs", (x) => Math.round(numberInRange(x, 4500, 500, 30000)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "maxWaitMs", (x) => Math.round(numberInRange(x, 9000, 1000, 60000)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "minImplicitConfidence", (x) => numberInRange(x, 0.22, 0, 1));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "maxImplicitConfidence", (x) => numberInRange(x, 0.55, 0, 1));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "shortAmbiguousMaxLength", (x) => Math.round(numberInRange(x, 36, 4, 120)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "maxMessages", (x) => Math.round(numberInRange(x, 5, 1, 12)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "maxChars", (x) => Math.round(numberInRange(x, 700, 80, 2000)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "minFollowupMessages", (x) => Math.round(numberInRange(x, 1, 0, 5)));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "replyToMessage", (x) => booleanValue(x, false));
    setIfPresent(next.delayedUnderstanding, patch.delayedUnderstanding, "skipIfBotRepliedAfterSeed", (x) => booleanValue(x, true));
    if (isPlainObject(patch.delayedUnderstanding.discussion)) {
      next.delayedUnderstanding.discussion ||= {};
      setIfPresent(next.delayedUnderstanding.discussion, patch.delayedUnderstanding.discussion, "enabled", (x) => booleanValue(x, true));
      setIfPresent(next.delayedUnderstanding.discussion, patch.delayedUnderstanding.discussion, "probability", (x) => numberInRange(x, 0.35, 0, 1));
      setIfPresent(next.delayedUnderstanding.discussion, patch.delayedUnderstanding.discussion, "minTextLength", (x) => Math.round(numberInRange(x, 4, 1, 80)));
      setIfPresent(next.delayedUnderstanding.discussion, patch.delayedUnderstanding.discussion, "maxTextLength", (x) => Math.round(numberInRange(x, 80, 4, 200)));
    }
  }
  if (isPlainObject(patch.messageDebounce)) {
    next.messageDebounce ||= {};
    setIfPresent(next.messageDebounce, patch.messageDebounce, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "baseWaitMs", (x) => Math.round(numberInRange(x, 3000, 0, 30000)));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "minWaitMs", (x) => Math.round(numberInRange(x, 1500, 0, 30000)));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "maxWaitMs", (x) => Math.round(numberInRange(x, 6000, 500, 60000)));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "sameUserExtendMs", (x) => Math.round(numberInRange(x, 2500, 0, 30000)));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "maxBufferedMessages", (x) => Math.round(numberInRange(x, 8, 1, 30)));
    setIfPresent(next.messageDebounce, patch.messageDebounce, "maxBufferedChars", (x) => Math.round(numberInRange(x, 1000, 80, 5000)));
  }
  if (isPlainObject(patch.responseQueue)) {
    next.responseQueue ||= {};
    setIfPresent(next.responseQueue, patch.responseQueue, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.responseQueue, patch.responseQueue, "minDelayMs", (x) => Math.round(numberInRange(x, 1000, 0, 10000)));
    if (isPlainObject(patch.responseQueue.liveContext)) {
      next.responseQueue.liveContext ||= {};
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "enabled", (x) => booleanValue(x, true));
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "windowMs", (x) => Math.round(numberInRange(x, 20000, 1000, 120000)));
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "settleMs", (x) => Math.round(numberInRange(x, 350, 0, 5000)));
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "maxRegenerations", (x) => Math.round(numberInRange(x, 2, 0, 5)));
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "maxMergedMessages", (x) => Math.round(numberInRange(x, 8, 1, 30)));
      setIfPresent(next.responseQueue.liveContext, patch.responseQueue.liveContext, "cancelProactiveOnDirect", (x) => booleanValue(x, true));
    }
  }
  if (isPlainObject(patch.chatArchive)) {
    next.chatArchive ||= {};
    setIfPresent(next.chatArchive, patch.chatArchive, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.chatArchive, patch.chatArchive, "defaultOn", (x) => booleanValue(x, true));
    setIfPresent(next.chatArchive, patch.chatArchive, "baseDir", (x) => {
      const value = stringValue(x, "data/chat-archive").trim() || "data/chat-archive";
      return value.includes("..") ? "data/chat-archive" : value.slice(0, 200);
    });
    setIfPresent(next.chatArchive, patch.chatArchive, "saveImages", (x) => booleanValue(x, true));
    setIfPresent(next.chatArchive, patch.chatArchive, "privacyFilter", (x) => booleanValue(x, true));
    setIfPresent(next.chatArchive, patch.chatArchive, "maxRetrieveItems", (x) => Math.round(numberInRange(x, 8, 1, 20)));
    setIfPresent(next.chatArchive, patch.chatArchive, "hydrateRecentMessages", (x) => Math.round(numberInRange(x, 120, 10, 500)));
    if (isPlainObject(patch.chatArchive.index)) {
      next.chatArchive.index ||= {};
      setIfPresent(next.chatArchive.index, patch.chatArchive.index, "enabled", (x) => booleanValue(x, true));
    }
    if (isPlainObject(patch.chatArchive.summary)) {
      next.chatArchive.summary ||= {};
      setIfPresent(next.chatArchive.summary, patch.chatArchive.summary, "everyMessages", (x) => Math.round(numberInRange(x, 50, 10, 500)));
    }
  }
  if (isPlainObject(patch.messageTime)) {
    next.messageTime ||= {};
    setIfPresent(next.messageTime, patch.messageTime, "timezone", (x) => {
      const value = stringValue(x, "Asia/Shanghai").trim() || "Asia/Shanghai";
      try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date()); return value; } catch { return "Asia/Shanghai"; }
    });
  }
  if (isPlainObject(patch.taskMode)) {
    next.taskMode ||= {};
    setIfPresent(next.taskMode, patch.taskMode, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.taskMode, patch.taskMode, "shadowMode", (x) => booleanValue(x, false));
    setIfPresent(next.taskMode, patch.taskMode, "allowedGroupIds", (x) => asArray(x).map(asStringId).filter(Boolean).slice(0, 100));
    setIfPresent(next.taskMode, patch.taskMode, "ownerUserIds", (x) => asArray(x).map(asStringId).filter(Boolean).slice(0, 20));
    setIfPresent(next.taskMode, patch.taskMode, "maxConcurrentGlobal", (x) => Math.round(numberInRange(x, 2, 1, 8)));
    setIfPresent(next.taskMode, patch.taskMode, "maxConcurrentPerConversation", (x) => Math.round(numberInRange(x, 1, 1, 3)));
    setIfPresent(next.taskMode, patch.taskMode, "progressHeartbeatMs", (x) => Math.round(numberInRange(x, 180000, 60000, 3600000)));
    setIfPresent(next.taskMode, patch.taskMode, "workspaceBaseDir", (x) => {
      const value = stringValue(x, "data/tasks").trim() || "data/tasks";
      return value.includes("..") || path.isAbsolute(value) ? "data/tasks" : value.slice(0, 200);
    });
    setIfPresent(next.taskMode, patch.taskMode, "defaultToolsets", (x) => asArray(x).map(String).filter((item) => ["web", "todo"].includes(item)).slice(0, 4));
    setIfPresent(next.taskMode, patch.taskMode, "maxRuntimeMs", (x) => Math.round(numberInRange(x, 1200000, 30000, 7200000)));
    setIfPresent(next.taskMode, patch.taskMode, "maxTurns", (x) => Math.round(numberInRange(x, 30, 1, 90)));
    setIfPresent(next.taskMode, patch.taskMode, "maxArtifactBytes", (x) => Math.round(numberInRange(x, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024)));
    setIfPresent(next.taskMode, patch.taskMode, "maxGrantedFileChars", (x) => Math.round(numberInRange(x, 120000, 1000, 500000)));
    setIfPresent(next.taskMode, patch.taskMode, "useSandboxExec", (x) => booleanValue(x, true));
    if (isPlainObject(patch.taskMode.intentJudge)) {
      next.taskMode.intentJudge ||= {};
      setIfPresent(next.taskMode.intentJudge, patch.taskMode.intentJudge, "enabled", (x) => booleanValue(x, true));
      setIfPresent(next.taskMode.intentJudge, patch.taskMode.intentJudge, "timeoutMs", (x) => Math.round(numberInRange(x, 15000, 2000, 120000)));
      setIfPresent(next.taskMode.intentJudge, patch.taskMode.intentJudge, "minConfidence", (x) => numberInRange(x, 0.68, 0, 1));
    }
  }
  if (isPlainObject(patch.reviewer)) {
    next.reviewer ||= {};
    setIfPresent(next.reviewer, patch.reviewer, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.reviewer, patch.reviewer, "shadowMode", (x) => booleanValue(x, false));
    setIfPresent(next.reviewer, patch.reviewer, "mode", (x) => ["adaptive", "all", "off"].includes(stringValue(x).trim()) ? stringValue(x).trim() : "adaptive");
    setIfPresent(next.reviewer, patch.reviewer, "provider", (x) => stringValue(x).trim());
    setIfPresent(next.reviewer, patch.reviewer, "model", (x) => stringValue(x).trim());
    setIfPresent(next.reviewer, patch.reviewer, "reasoningEffort", (x) => stringValue(x, "low").trim() || "low");
    setIfPresent(next.reviewer, patch.reviewer, "timeoutMs", (x) => Math.round(numberInRange(x, 12000, 2000, 120000)));
    setIfPresent(next.reviewer, patch.reviewer, "minLength", (x) => Math.round(numberInRange(x, 160, 40, 2000)));
    setIfPresent(next.reviewer, patch.reviewer, "maxContextChars", (x) => Math.round(numberInRange(x, 7000, 1000, 20000)));
    setIfPresent(next.reviewer, patch.reviewer, "failOpenLowRisk", (x) => booleanValue(x, true));
  }
  if (isPlainObject(patch.memory?.integrity)) {
    next.memory ||= {};
    next.memory.integrity ||= {};
    setIfPresent(next.memory.integrity, patch.memory.integrity, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.memory.integrity, patch.memory.integrity, "minStableConfidence", (x) => numberInRange(x, 0.65, 0, 1));
    setIfPresent(next.memory.integrity, patch.memory.integrity, "promptMinConfidence", (x) => numberInRange(x, 0.55, 0, 1));
    setIfPresent(next.memory.integrity, patch.memory.integrity, "requireEvidence", (x) => booleanValue(x, true));
    setIfPresent(next.memory.integrity, patch.memory.integrity, "maxEntriesPerUser", (x) => Math.round(numberInRange(x, 180, 20, 500)));
    setIfPresent(next.memory.integrity, patch.memory.integrity, "maxConflictsPerUser", (x) => Math.round(numberInRange(x, 40, 5, 200)));
  }
  if (isPlainObject(patch.observability)) {
    next.observability ||= {};
    setIfPresent(next.observability, patch.observability, "logIncomingMessages", (x) => booleanValue(x, true));
    setIfPresent(next.observability, patch.observability, "logSkippedMessages", (x) => booleanValue(x, true));
    setIfPresent(next.observability, patch.observability, "logInactiveAccountMessages", (x) => booleanValue(x, false));
    setIfPresent(next.observability, patch.observability, "standbyReadBackfill", (x) => booleanValue(x, false));
    setIfPresent(next.observability, patch.observability, "standbyBackfillGraceMs", (x) => Math.round(numberInRange(x, 1200, 0, 10000)));
    setIfPresent(next.observability, patch.observability, "recentInboundMax", (x) => Math.round(numberInRange(x, 80, 20, 300)));
    setIfPresent(next.observability, patch.observability, "duplicateWindowMs", (x) => Math.round(numberInRange(x, 15000, 1000, 120000)));
  }
  if (isPlainObject(patch.adminNotifications)) {
    next.adminNotifications ||= {};
    setIfPresent(next.adminNotifications, patch.adminNotifications, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "recipients", (x) => asArray(x).map(asStringId).filter(Boolean).slice(0, 5));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "checkIntervalMs", (x) => Math.round(numberInRange(x, 15000, 5000, 300000)));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "notifyOnline", (x) => booleanValue(x, true));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "notifyLoginInvalid", (x) => booleanValue(x, true));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "notifyQuickLogin", (x) => booleanValue(x, true));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "notifyDisconnected", (x) => booleanValue(x, true));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "maxLength", (x) => Math.round(numberInRange(x, 900, 120, 2000)));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "periodicStatusEnabled", (x) => booleanValue(x, false));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "periodicStatusIntervalMs", (x) => Math.round(numberInRange(x, 1800000, 60000, 86400000)));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "periodicStatusCheckIntervalMs", (x) => Math.round(numberInRange(x, 60000, 10000, 300000)));
    setIfPresent(next.adminNotifications, patch.adminNotifications, "periodicStatusSendOnStart", (x) => booleanValue(x, false));
  }
  if (isPlainObject(patch.loginRecovery)) {
    next.loginRecovery ||= {};
    setIfPresent(next.loginRecovery, patch.loginRecovery, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "checkIntervalMs", (x) => Math.round(numberInRange(x, 15000, 5000, 300000)));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "restartCooldownMs", (x) => Math.round(numberInRange(x, 600000, 60000, 86400000)));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "recoveryWaitMs", (x) => Math.round(numberInRange(x, 45000, 10000, 300000)));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "autoRestartNapcat", (x) => booleanValue(x, true));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "refreshQrOnFailure", (x) => booleanValue(x, true));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "notifyOwner", (x) => booleanValue(x, true));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "maxAutoRestartsPerIncident", (x) => Math.round(numberInRange(x, 1, 0, 5)));
    setIfPresent(next.loginRecovery, patch.loginRecovery, "passwordFallback", (x) => booleanValue(x, false) === true ? false : false);
  }
  if (isPlainObject(patch.accounts)) {
    next.accounts ||= {};
    if (isPlainObject(patch.accounts.primary)) {
      next.accounts.primary ||= {};
      setIfPresent(next.accounts.primary, patch.accounts.primary, "id", (x) => asStringId(x) || "primary");
      setIfPresent(next.accounts.primary, patch.accounts.primary, "qq", (x) => asStringId(x));
      setIfPresent(next.accounts.primary, patch.accounts.primary, "displayName", (x) => stringValue(x, "Hermes小跟班").trim() || "Hermes小跟班");
      setIfPresent(next.accounts.primary, patch.accounts.primary, "protocol", (x) => accountProtocol({ protocol: x }));
      setIfPresent(next.accounts.primary, patch.accounts.primary, "onebotPath", (x) => stringValue(x, "/onebot").trim() || "/onebot");
      setIfPresent(next.accounts.primary, patch.accounts.primary, "napcatContainer", (x) => stringValue(x, "napcat").trim() || "napcat");
      setIfPresent(next.accounts.primary, patch.accounts.primary, "protocolContainer", (x) => stringValue(x).trim());
      setIfPresent(next.accounts.primary, patch.accounts.primary, "onebotWsUrl", (x) => stringValue(x).trim());
      setIfPresent(next.accounts.primary, patch.accounts.primary, "webuiPort", (x) => Math.round(numberInRange(x, 6103, 1024, 65535)));
      setIfPresent(next.accounts.primary, patch.accounts.primary, "noVncPort", (x) => Math.round(numberInRange(x, 6104, 1024, 65535)));
      setIfPresent(next.accounts.primary, patch.accounts.primary, "vncPort", (x) => Math.round(numberInRange(x, 5902, 1024, 65535)));
      setIfPresent(next.accounts.primary, patch.accounts.primary, "snowlumaImage", (x) => stringValue(x, "motricseven7/snowluma:latest").trim() || "motricseven7/snowluma:latest");
      setIfPresent(next.accounts.primary, patch.accounts.primary, "snowlumaVolumes", (x) => isPlainObject(x) ? deepClone(x) : undefined);
      next.accounts.primary.role = "primary";
    }
    if (Array.isArray(patch.accounts.standbys)) {
      next.accounts.standbys = patch.accounts.standbys.slice(0, 3).map((item, index) => {
        const current = next.accounts.standbys?.[index] || {};
        const merged = { ...current, ...(isPlainObject(item) ? item : {}) };
        return {
          id: asStringId(merged.id || `standby-${index + 1}`),
          qq: asStringId(merged.qq || ""),
          role: "standby",
          displayName: stringValue(merged.displayName || merged.name || `Hermes小跟班${index + 2}`).trim() || `Hermes小跟班${index + 2}`,
          protocol: accountProtocol(merged),
          onebotPath: stringValue(merged.onebotPath || next.accounts.primary?.onebotPath || "/onebot").trim() || "/onebot",
          napcatContainer: stringValue(merged.napcatContainer || `napcat-standby-${index + 1}`).trim() || `napcat-standby-${index + 1}`,
          protocolContainer: stringValue(merged.protocolContainer || merged.napcatContainer || (accountProtocol(merged) === "snowluma" ? `snowluma-standby-${index + 1}` : `napcat-standby-${index + 1}`)).trim() || (accountProtocol(merged) === "snowluma" ? `snowluma-standby-${index + 1}` : `napcat-standby-${index + 1}`),
          onebotWsUrl: stringValue(merged.onebotWsUrl || (accountProtocol(merged) === "snowluma" ? "ws://127.0.0.1:6301" : "")).trim(),
          webuiPort: merged.webuiPort == null || merged.webuiPort === "" ? undefined : Math.round(numberInRange(merged.webuiPort, 6101, 1024, 65535)),
          noVncPort: merged.noVncPort == null || merged.noVncPort === "" ? undefined : Math.round(numberInRange(merged.noVncPort, 6102, 1024, 65535)),
          vncPort: merged.vncPort == null || merged.vncPort === "" ? undefined : Math.round(numberInRange(merged.vncPort, 5901, 1024, 65535)),
          snowlumaImage: stringValue(merged.snowlumaImage || "motricseven7/snowluma:latest").trim() || "motricseven7/snowluma:latest",
          snowlumaVolumes: isPlainObject(merged.snowlumaVolumes) ? deepClone(merged.snowlumaVolumes) : undefined,
          behaviorMode: normalizeBehaviorMode(merged.behaviorMode) || "normal",
          enabled: booleanValue(merged.enabled, true)
        };
      });
    }
    if (isPlainObject(patch.accounts.failover)) {
      next.accounts.failover ||= {};
      setIfPresent(next.accounts.failover, patch.accounts.failover, "enabled", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "primaryRecoveryFirst", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "switchAfterMs", (x) => Math.round(numberInRange(x, 60000, 10000, 3600000)));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "minSwitchIntervalMs", (x) => Math.round(numberInRange(x, 90000, 10000, 3600000)));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "switchBackWhenPrimaryHealthy", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "announceTakeover", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "autoAdoptUnknownStandby", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "primaryRecoveryRequiresNewMessage", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "announceInGroups", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "groupNoticeCooldownMs", (x) => Math.round(numberInRange(x, 300000, 10000, 3600000)));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "groupNoticeActiveWindowMs", (x) => Math.round(numberInRange(x, 21600000, 60000, 86400000)));
      setIfPresent(next.accounts.failover, patch.accounts.failover, "groupNoticeMaxGroups", (x) => Math.round(numberInRange(x, 8, 1, 30)));
    }
    if (isPlainObject(patch.accounts.diagnostics)) {
      next.accounts.diagnostics ||= {};
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "probeIntervalMs", (x) => Math.round(numberInRange(x, 30000, 15000, 600000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "probeTimeoutMs", (x) => Math.round(numberInRange(x, 5000, 1000, 30000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "probeStaleMs", (x) => Math.round(numberInRange(x, 120000, 30000, 1800000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "sendEvidenceFreshMs", (x) => Math.round(numberInRange(x, 1800000, 60000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "receiveEvidenceFreshMs", (x) => Math.round(numberInRange(x, 1800000, 60000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "noMessageWarnMs", (x) => Math.round(numberInRange(x, 60000, 10000, 3600000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "freshQrSeconds", (x) => Math.round(numberInRange(x, 1800, 60, 86400)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingEnabled", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingIntervalMs", (x) => Math.round(numberInRange(x, 600000, 120000, 3600000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingFreshMs", (x) => Math.round(numberInRange(x, 900000, 60000, 7200000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingSendTimeoutMs", (x) => Math.round(numberInRange(x, 10000, 1000, 30000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingReceiveTimeoutMs", (x) => Math.round(numberInRange(x, 45000, 5000, 300000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingOnMessageInactive", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingMessageInactiveMs", (x) => Math.round(numberInRange(x, 600000, 60000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "peerPingInactiveCooldownMs", (x) => Math.round(numberInRange(x, 1800000, 120000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "qrcodeRefreshSafetyEnabled", (x) => booleanValue(x, true));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "qrcodeRefreshGlobalCooldownMs", (x) => Math.round(numberInRange(x, 600000, 60000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "qrcodeRefreshAccountCooldownMs", (x) => Math.round(numberInRange(x, 900000, 60000, 86400000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "qrcodeRefreshTransitionGuardMs", (x) => Math.round(numberInRange(x, 120000, 10000, 3600000)));
      setIfPresent(next.accounts.diagnostics, patch.accounts.diagnostics, "qrcodeRefreshFailoverGuardMs", (x) => Math.round(numberInRange(x, 120000, 10000, 3600000)));
    }
  }
  if (isPlainObject(patch.memory)) {
    next.memory ||= {};
    setIfPresent(next.memory, patch.memory, "enabled", (x) => booleanValue(x, true));
    setIfPresent(next.memory, patch.memory, "privacyFilter", (x) => booleanValue(x, true));
    if (isPlainObject(patch.memory.aiExtraction)) {
      next.memory.aiExtraction ||= {};
      setIfPresent(next.memory.aiExtraction, patch.memory.aiExtraction, "enabled", (x) => booleanValue(x, true));
      setIfPresent(next.memory.aiExtraction, patch.memory.aiExtraction, "everyMessages", (x) => Math.round(numberInRange(x, 4, 1, 100)));
    }
  }
  if (isPlainObject(patch.send)) {
    next.send ||= {};
    setIfPresent(next.send, patch.send, "maxLength", (x) => Math.round(numberInRange(x, 420, 80, 4000)));
    setIfPresent(next.send, patch.send, "replyToMessage", (x) => booleanValue(x, true));
  }
  next.__path = currentConfig.__path || configPath;
  return next;
}

function memorySummary(memory) {
  const groups = Object.entries(memory?.groups || {}).map(([groupId, gm]) => ({
    groupId,
    users: Object.keys(gm.users || {}).length,
    profiledUsers: Object.values(gm.users || {}).filter((user) => asArray(user.personality).length || asArray(user.coreMemes).length || asArray(user.aliases).length).length,
    rebuiltUsers: Object.values(gm.users || {}).filter((user) => user.canonicalMemory && typeof user.canonicalMemory === "object").length,
    facts: asArray(gm.facts).length,
    topics: asArray(gm.topics).length,
    summaries: asArray(gm.summaries).length,
    botSelfUpdatedAt: gm.botSelf?.updatedAt || "",
    rollingSummary: clampText(gm.rollingSummary || "", 180),
    settings: gm.settings || {}
  }));
  return { groups, groupCount: groups.length };
}

function parseDryRunMessages(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item, index) => ({
        sender: item.sender || item.name || `user${index + 1}`,
        user_id: asStringId(item.user_id || item.userId || index + 1),
        text: String(item.text || item.message || ""),
        at: item.at ? Date.parse(item.at) || Date.now() : Date.now(),
        isBot: item.isBot === true,
        replyToUserId: asStringId(item.replyToUserId),
        mentionedUserIds: asArray(item.mentionedUserIds).map(asStringId).filter(Boolean),
        replyContexts: asArray(item.replyContexts)
      }));
    }
  } catch {
    // fall through to line parser
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^([^:：]{1,40})[:：]\s*(.*)$/);
      return {
        sender: match ? match[1].trim() : `user${index + 1}`,
        user_id: String(index + 1),
        text: match ? match[2].trim() : line,
        at: Date.now() + index
      };
    });
}

async function runDryRun(config, memory) {
  const idx = process.argv.indexOf("--dry-run");
  const filePath = process.argv[idx + 1];
  if (!filePath) throw new Error("usage: node src/bridge.js --dry-run <log.txt|log.json> [--group groupId] [--no-ai]");
  const groupIdx = process.argv.indexOf("--group");
  const groupId = groupIdx >= 0 ? process.argv[groupIdx + 1] : "dry-run";
  const noAi = process.argv.includes("--no-ai");
  const dryMemory = JSON.parse(JSON.stringify(memory || { groups: {} }));
  const messages = parseDryRunMessages(filePath);
  const history = [];
  for (const msg of messages) {
    const event = { group_id: groupId, user_id: msg.user_id };
    const current = {
      sender: msg.sender,
      user_id: msg.user_id,
      text: redactSensitive(msg.text, config),
      at: msg.at || Date.now(),
      isBot: msg.isBot === true,
      replyToUserId: msg.replyToUserId || "",
      mentionedUserIds: msg.mentionedUserIds || [],
      replyContexts: msg.replyContexts || []
    };
    history.push(current);
    while (history.length > Number(config.history?.rawMaxMessages || 120)) history.shift();
    updateMemoryFromMessage(dryMemory, event, msg.sender, current.text, config);
    addPendingMemoryMessage(dryMemory, event, msg.sender, current.text, config);
    summarizeOlderHistory(dryMemory, groupId, history, config);
    applyConversationFeedback(dryMemory, groupId, current.text, config);
  }
  const current = history.at(-1) || { sender: "系统", user_id: "system", text: "（空）", at: Date.now() };
  const contextBundle = buildContextBundle({ memory: dryMemory, groupId, history, current, config });
  const dryBehaviorConfig = applyBehaviorMode(config, dryMemory, groupId);
  const lastBotMessage = [...history].reverse().find((item) => item.isBot) || null;
  const implicitDecision = detectImplicitReplyToBot({ history, current, lastBotMessage, config: dryBehaviorConfig });
  const discussionDecision = detectDiscussionSignal({ history, current, config: dryBehaviorConfig });
  const plannerCfg = socialPlannerConfig(dryBehaviorConfig);
  const socialCandidate = implicitDecision.confidence >= plannerCfg.minCandidateConfidence || discussionDecision.matched;
  const socialDecision = noAi || !socialCandidate
    ? { skipped: true, action: "observe", confidence: 0, reason: noAi ? "--no-ai" : "not a planner candidate" }
    : await judgeSocialActionWithAI({
        history,
        current,
        lastBotMessage,
        implicitDecision,
        discussionDecision,
        memory: dryMemory,
        groupId,
        config: dryBehaviorConfig,
        contextBundle
      });
  const proactiveDecision = shouldSkipProactiveReply({ history, current, memory: dryMemory, groupId, config });
  const prompt = buildPrompt({
    config,
    history,
    current,
    mode: proactiveDecision.skip ? "reply" : "proactive",
    memoryText: compactMemory(dryMemory, groupId, config, current.user_id),
    contextBundle
  });
  const result = {
    groupId,
    messageCount: messages.length,
    current,
    implicitDecision,
    discussionDecision,
    socialCandidate,
    socialDecision,
    proactiveDecision,
    contextBundle,
    reply: noAi ? "(--no-ai; skipped model call)" : trimForGroup(await callHermes(prompt, config), config)
  };
  console.log(JSON.stringify(result, null, 2));
}

async function runSocialSelfTest() {
  const failures = [];
  let tests = 0;
  const check = (condition, name) => {
    tests += 1;
    if (!condition) failures.push(name);
  };
  check(JSON.stringify(extractReplyMessageIds("[CQ:reply,id=123]hello")) === JSON.stringify(["123"]), "CQ reply id extraction");
  check(JSON.stringify(extractReplyMessageIds([{ type: "reply", data: { id: "456" } }])) === JSON.stringify(["456"]), "segment reply id extraction");
  const low = normalizeSocialDecision({ action: "reply", confidence: 0.2 }, { socialPlanner: { minConfidence: 0.55 } });
  check(low.action === "observe" && low.requestedAction === "reply", "low-confidence reply becomes observe");
  const wait = normalizeSocialDecision({ action: "wait", confidence: 0.4, intent: "followup" }, { socialPlanner: { minConfidence: 0.55 } });
  check(wait.action === "wait" && wait.intent === "followup", "wait decision preserved");
  const restrained = applyExplicitBehaviorMode({
    socialPlanner: { minConfidence: 0.55 },
    behaviorModes: { presets: { restrained: { socialPlanner: { minConfidence: 0.72 } } } }
  }, "restrained");
  check(Number(restrained.socialPlanner?.minConfidence) === 0.72, "behavior mode overrides social threshold");
  const explicitFileTask = ruleTaskDecision("帮我详细规划三天两晚自驾行程，并生成一份详细的PDF");
  check(explicitFileTask?.matched === true && explicitFileTask.expectedArtifacts.includes("任务结果.pdf"), "explicit PDF request uses deterministic task fallback");
  check(explicitFileTask?.complexity === "standard" && explicitFileTask?.reasoningEffort === "medium", "research task uses medium reasoning");
  const complexComputerTask = ruleTaskDecision("请作为正式任务操作电脑，读取本地项目并修复代码后生成报告");
  check(complexComputerTask?.complexity === "complex" && complexComputerTask?.reasoningEffort === "high", "computer and local project task uses high reasoning");
  const simpleDocumentTask = ruleTaskDecision("帮我把这段话整理成文档");
  check(simpleDocumentTask?.complexity === "simple" && simpleDocumentTask?.reasoningEffort === "low", "single document task uses low reasoning");
  check(reviewerConfig({ reviewer: { enabled: true } }).runtimeDisabled === true, "reviewer remains runtime-disabled for compatibility");
  const archiveDir = path.join("/tmp", `hermes-social-self-test-${randomBytes(5).toString("hex")}`);
  const archiveRecord = archiveConversationEvent({
    event: { message_type: "group", group_id: "self-test", user_id: "10001", message_id: "789", message: "[CQ:reply,id=123]测试" },
    config: { chatArchive: { enabled: true, defaultOn: true, baseDir: archiveDir, privacyFilter: true } },
    memory: { groups: {} },
    text: "测试",
    rawText: "[CQ:reply,id=123]测试",
    senderName: "测试用户"
  });
  check(archiveRecord?.quotedMessage?.ids?.[0] === "123", "archive writes quoted reply id");

  const resolved = await resolveQuotedMessages({
    message: "[CQ:reply,id=321]继续",
    config: { history: { maxQuotedMessages: 4 } },
    botIds: ["90001"],
    getMessage: async () => ({
      message_id: "321",
      user_id: "90001",
      sender: { user_id: "90001", nickname: "测试机器人" },
      message: "前一条机器人消息"
    })
  });
  check(resolved.contexts[0]?.isBot === true && resolved.contexts[0]?.text === "前一条机器人消息", "quoted bot context resolves sender and text");
  const explicitQuote = detectImplicitReplyToBot({
    history: [],
    current: { user_id: "10001", text: "继续", replyContexts: resolved.contexts },
    lastBotMessage: null,
    config: { implicitReply: { enabled: true } }
  });
  check(explicitQuote.matched === true && explicitQuote.confidence === 1, "quoted bot bypasses ambiguous threshold");

  const baseAt = Date.now() - 4000;
  const earlierBot = { sender: "bot", user_id: "90001", text: "数据库方案可以用 JSONL", at: baseAt, isBot: true, replyToUserId: "10001" };
  const laterBot = { sender: "bot", user_id: "90001", text: "今天天气不错", at: baseAt + 1000, isBot: true, replyToUserId: "10002" };
  const currentAfterTwoBots = { sender: "甲", user_id: "10001", text: "数据库这个再细说", at: baseAt + 2000, isBot: false };
  const multiBotDecision = detectImplicitReplyToBot({
    history: [earlierBot, laterBot, currentAfterTwoBots],
    current: currentAfterTwoBots,
    lastBotMessage: laterBot,
    config: { implicitReply: { enabled: true, confidenceThreshold: 0.55, recentBotMessages: 6 } }
  });
  check(multiBotDecision.matched === true && multiBotDecision.matchedBotMessage === earlierBot, "implicit reply selects best of several recent bot messages");

  const merged = flushDebouncedMessage({
    reason: "test",
    messages: [
      { event: { message_id: "1", message: "[CQ:reply,id=777]第一段" }, text: "[引用消息]第一段", rawText: "[CQ:reply,id=777]第一段", senderName: "甲" },
      { event: { message_id: "2", message: "第二段" }, text: "第二段", rawText: "第二段", senderName: "甲" }
    ]
  }, { messageDebounce: {} });
  check(merged.messages.length === 2 && extractReplyMessageIds(merged.messages[0].event.message)[0] === "777", "debounce preserves metadata from every fragment");
  check(clampTextTail(`${"旧".repeat(30)}最新标记`, 12).includes("最新标记"), "rolling summary tail keeps newest context");

  const summaryMemory = { groups: { "123": { users: {}, facts: ["事实"], topics: ["话题"], summaries: [], settings: {}, dailySent: {}, rollingSummary: "真实群摘要", pendingMemoryMessages: [] } } };
  const summaryMeta = {
    id: "123",
    kind: "groups",
    conversationId: "group:123",
    messagesPath: path.join(archiveDir, "summary-test", "messages.jsonl"),
    indexPath: path.join(archiveDir, "summary-test", "index.json"),
    summaryPath: path.join(archiveDir, "summary-test", "summary.json")
  };
  writeJsonFileSafe(summaryMeta.indexPath, { messageCount: 50, keywords: {} });
  summarizeArchiveIfNeeded(summaryMeta, summaryMemory, { chatArchive: { enabled: true, baseDir: archiveDir, summary: { everyMessages: 50 } } });
  const summaryResult = readJsonFileSafe(summaryMeta.summaryPath, {});
  check(summaryResult.rollingSummary === "真实群摘要" && summaryResult.topics?.[0] === "话题", "group archive summary uses raw group id memory");

  const hydrateDir = path.join(archiveDir, "hydrate", "groups", "456");
  fs.mkdirSync(hydrateDir, { recursive: true });
  appendJsonl(path.join(hydrateDir, "messages.jsonl"), { type: "bot_reply", time: "2026-01-01T00:00:02.000Z", senderId: "90001", senderName: "bot", text: "后写但时间晚" });
  appendJsonl(path.join(hydrateDir, "messages.jsonl"), { type: "user_message", time: "2026-01-01T00:00:01.000Z", senderId: "10001", senderName: "甲", text: "先发生" });
  const hydratedHistory = new Map();
  const hydratedBot = new Map();
  const hydrated = hydrateRuntimeContextFromArchives({
    config: { chatArchive: { enabled: true, baseDir: path.join(archiveDir, "hydrate"), hydrateRecentMessages: 20 }, history: { rawMaxMessages: 20 } },
    historyByGroup: hydratedHistory,
    lastBotMessageByGroup: hydratedBot
  });
  check(hydrated.messages === 2 && hydratedHistory.get("456")?.[0]?.text === "先发生" && hydratedBot.get("456")?.isBot === true, "runtime context hydrates and sorts archive records");
  fs.rmSync(archiveDir, { recursive: true, force: true });
  if (failures.length) throw new Error(`social self-test failed: ${failures.join(", ")}`);
  console.log(JSON.stringify({ ok: true, tests }, null, 2));
}

async function main() {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  if (!fs.existsSync(configPath) && fs.existsSync(fallbackConfigPath)) {
    fs.copyFileSync(fallbackConfigPath, configPath);
  }
  const config = loadConfig();
  if (process.argv.includes("--social-self-test")) {
    await runSocialSelfTest();
    return;
  }
  const memory = loadMemory();
  if (process.argv.includes("--dry-run")) {
    const dryMemory = deepClone(memory);
    normalizeMemorySchema(dryMemory, config);
    await runDryRun(config, dryMemory);
    return;
  }
  if (normalizeMemorySchema(memory, config)) {
    saveMemory(memory);
    log("memory schema normalized");
  }
  if (process.argv.includes("--check")) {
    log(`config ok: ${config.__path}`);
    log(`listen: ws://${config.listen.host}:${config.listen.port}${config.listen.path}`);
    log(`targetGroups: ${targetGroupsDescription(config)}`);
    if (config.control?.enabled) {
      log(`control: http://${config.control.host || "127.0.0.1"}:${config.control.port || 6200}`);
    }
    return;
  }

  const host = config.listen?.host || "127.0.0.1";
  const port = Number(config.listen?.port || 6199);
  const routePath = config.listen?.path || "/onebot";
  const historyByGroup = new Map();
  const lastActiveReplyAt = new Map();
  const lastProactiveAt = new Map();
  const lastEventByGroup = new Map();
  const lastBotMessageByGroup = new Map();
  const hydratedContext = hydrateRuntimeContextFromArchives({ config, historyByGroup, lastBotMessageByGroup });
  if (hydratedContext.messages) {
    log(`archive context hydrated conversations=${hydratedContext.conversations} messages=${hydratedContext.messages}`);
  }
  const replyCoordinator = new ReplyCoordinator({ config: () => config, log, warn });
  const delayedUnderstandingByGroup = new Map();
  const pendingOneBotActions = new Map();
  const pendingAdminNotifications = [];
  const recentInboundMessages = new Map();
  const inboundAuditLog = [];
  const lastAccountSwitchGroupNoticeAt = new Map();
  const accountProbeCache = new Map();
  const accountPeerPing = new Map();
  let pendingAccountSwitchGroupNotice = null;
  let primaryUnhealthySince = 0;
  let lastActiveAccountSwitchedAt = 0;
  let lastAdminNotificationKey = "";
  let lastAdminLoginEventKey = "";
  let lastAdminPeriodicStatusAt = adminNotificationConfig(config).periodicStatusSendOnStart ? 0 : Date.now();
  let activeAdminIncident = null;
  const accountQrNoticeKeys = new Map();
  let lastMessageInactivePeerPingAt = 0;
  let lastMessageInactivePeerPingReason = "";
  const loginRecoveryState = {
    active: false,
    inFlight: false,
    startedAt: 0,
    attempts: 0,
    lastAttemptAt: 0,
    needScanNotified: false,
    reason: ""
  };
  const oneBotAccounts = new Map();
  const wsAccountIds = new Map();
  let activeAccountId = accountFailoverConfig(config).primary.id;
  let activeOneBotWs = null;
  {
    const activeAccount = accountById(config, activeAccountId);
    config.__activeAccountId = activeAccount?.id || activeAccountId;
    config.__activeAccountRole = activeAccount?.role || "primary";
    config.__activeAccountDisplayName = activeAccount?.displayName || botDisplayName(config);
  }
  const runtimeStatus = {
    bridgeStartedAt: Date.now(),
    lastOneBotConnectedAt: 0,
    lastOneBotDisconnectedAt: 0,
    lastOneBotFrameAt: 0,
    lastOneBotMessageAt: 0,
    lastOneBotMessagePreview: "",
    oneBotMessageCount: 0,
    activeMessageCount: 0,
    standbyBackfillMessageCount: 0,
    duplicateMessageCount: 0,
    inactiveIgnoredMessageCount: 0,
    lastStatusGeneratedAt: 0
  };

  function observabilityConfig() {
    return {
      logIncomingMessages: config.observability?.logIncomingMessages !== false,
      logSkippedMessages: config.observability?.logSkippedMessages !== false,
      logInactiveAccountMessages: config.observability?.logInactiveAccountMessages === true,
      standbyReadBackfill: config.observability?.standbyReadBackfill === true,
      standbyBackfillGraceMs: Number(config.observability?.standbyBackfillGraceMs || 1200),
      recentInboundMax: Math.max(20, Math.min(Number(config.observability?.recentInboundMax || 80), 300)),
      duplicateWindowMs: Math.max(1000, Math.min(Number(config.observability?.duplicateWindowMs || 15000), 120000))
    };
  }

  function rememberInboundAudit(item) {
    const cfg = observabilityConfig();
    inboundAuditLog.push({
      at: Date.now(),
      ...item
    });
    while (inboundAuditLog.length > cfg.recentInboundMax) inboundAuditLog.shift();
  }

  function pruneRecentInbound(nowMs = Date.now()) {
    const ttl = observabilityConfig().duplicateWindowMs;
    for (const [key, item] of recentInboundMessages.entries()) {
      if (nowMs - Number(item.at || 0) > ttl) recentInboundMessages.delete(key);
    }
  }

  function markInboundSeen(key, item) {
    pruneRecentInbound();
    const previous = recentInboundMessages.get(key);
    recentInboundMessages.set(key, { ...item, at: Date.now() });
    return previous || null;
  }

  function logIncomingMessage({ accountState, event, text0, senderName, disposition, reason = "" }) {
    const cfg = observabilityConfig();
    const preview = clampText(text0 || "[非文本消息]", 180);
    const entry = {
      account: accountState.id,
      active: accountState.id === activeAccountId,
      disposition,
      reason,
      type: event.message_type,
      conversation: conversationLabelFromEvent(event),
      groupId: event.group_id ? asStringId(event.group_id) : "",
      userId: asStringId(event.user_id),
      sender: senderName || asStringId(event.user_id) || "群友",
      messageId: asStringId(event.message_id || ""),
      text: preview
    };
    rememberInboundAudit(entry);
    if (cfg.logIncomingMessages || (cfg.logSkippedMessages && disposition !== "accepted")) {
      log(`onebot inbound account=${entry.account}${entry.active ? "" : " inactive"} disposition=${disposition}${reason ? ` reason=${reason}` : ""} ${entry.conversation} sender=${entry.sender} msg=${entry.messageId || "-"} text=${JSON.stringify(preview)}`);
    }
  }

  function accountSwitchNoticeText(previousAccount, nextAccount, reason = "") {
    const nextName = nextAccount?.displayName || nextAccount?.id || "备用账号";
    if (nextAccount?.role === "standby") {
      return `主号有点卡，我先切到${nextName}接着聊。`;
    }
    return `主号恢复了，我切回${nextName}。`;
  }

  function announceAccountSwitchToGroup(groupId, previousAccount, nextAccount, reason = "") {
    if (config.accounts?.failover?.announceInGroups === false) return false;
    const gid = asStringId(groupId);
    if (!gid || gid.startsWith("private:") || !activeOneBotWs || activeOneBotWs.readyState !== 1) return false;
    if (!shouldHandleGroup(gid, config)) return false;
    const cooldownMs = Number(config.accounts?.failover?.groupNoticeCooldownMs || 5 * 60_000);
    const key = `${gid}:${previousAccount?.id || ""}->${nextAccount?.id || ""}`;
    const last = lastAccountSwitchGroupNoticeAt.get(key) || 0;
    if (Date.now() - last < cooldownMs) return false;
    const message = trimForGroup(accountSwitchNoticeText(previousAccount, nextAccount, reason), config, 120);
    if (!message) return false;
    if (!sendGroupMessageToGroup(activeOneBotWs, gid, message, config)) return false;
    lastAccountSwitchGroupNoticeAt.set(key, Date.now());
    recordBotMessage({
      historyByGroup,
      lastBotMessageByGroup,
      groupId: gid,
      text: message,
      config,
      memory,
      meta: {
        source: "account-switch",
        sender: botDisplayName(config),
        user_id: nextAccount?.qq || "bot"
      }
    });
    log(`account switch notice sent group=${gid} text=${JSON.stringify(message)}`);
    return true;
  }

  function announceAccountSwitchToRecentGroups(previousAccount, nextAccount, reason = "") {
    if (config.accounts?.failover?.announceInGroups === false) return 0;
    const maxGroups = Math.max(1, Math.min(Number(config.accounts?.failover?.groupNoticeMaxGroups || 8), 30));
    const activeWindowMs = Math.max(60_000, Number(config.accounts?.failover?.groupNoticeActiveWindowMs || 6 * 60 * 60_000));
    const nowMs = Date.now();
    const groups = Array.from(lastEventByGroup.entries())
      .filter(([gid, item]) => {
        if (String(gid).startsWith("private:")) return false;
        const currentAt = Number(item?.__current?.at || 0);
        const eventAt = Number(item?.time || 0) ? Number(item.time) * 1000 : 0;
        const at = currentAt || eventAt;
        return Boolean(at && nowMs - at <= activeWindowMs);
      })
      .map(([gid]) => gid)
      .slice(-maxGroups);
    let sent = 0;
    for (const gid of groups) {
      if (announceAccountSwitchToGroup(gid, previousAccount, nextAccount, reason)) sent += 1;
    }
    return sent;
  }

  function oneBotRequest(ws, action, params = {}, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) {
        reject(new Error("onebot websocket not connected"));
        return;
      }
      const accountId = asStringId(ws?.__hermesAccountId || "");
      const isSendAction = /^send_/.test(String(action || ""));
      if (isSendAction) recordAccountSend(accountId, action, { attempt: true });
      const echo = `hermes-request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pendingOneBotActions.delete(echo);
        if (isSendAction) recordAccountSend(accountId, action, { ok: false, failure: `${action} timeout` });
        reject(new Error(`${action} timeout`));
      }, timeoutMs);
      pendingOneBotActions.set(echo, {
        resolve: (payload) => {
          clearTimeout(timer);
          if (isSendAction) recordAccountSend(accountId, action, { ok: true });
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          if (isSendAction) recordAccountSend(accountId, action, { ok: false, failure: err.message });
          reject(err);
        }
      });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async function sendTaskArtifact(task, artifact) {
    const ws = activeOneBotWs;
    if (!ws || ws.readyState !== 1 || !artifact?.filePath || !fs.existsSync(artifact.filePath)) return false;
    const ext = path.extname(artifact.name || artifact.filePath).toLowerCase();
    const image = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
    const activeAccount = accountById(config, activeAccountId);
    let protocolFilePath = path.resolve(artifact.filePath);
    if (activeAccount && accountProtocol(activeAccount) === "snowluma") {
      const uploadDir = path.join(snowlumaStateDirForAccount(activeAccount), "data", "hermes-task-uploads", safePathSegment(task.id));
      fs.mkdirSync(uploadDir, { recursive: true });
      const hostCopy = path.join(uploadDir, path.basename(artifact.name || artifact.filePath));
      fs.copyFileSync(artifact.filePath, hostCopy);
      protocolFilePath = `/app/data/hermes-task-uploads/${safePathSegment(task.id)}/${path.basename(hostCopy)}`;
    }
    try {
      if (image) {
        const message = [{ type: "image", data: { file: `file://${protocolFilePath}` } }];
        if (task.messageType === "private") await oneBotRequest(ws, "send_private_msg", { user_id: task.userId, message }, { timeoutMs: 30_000 });
        else await oneBotRequest(ws, "send_group_msg", { group_id: task.groupId, message }, { timeoutMs: 30_000 });
        return true;
      }
      if (task.messageType === "private") {
        await oneBotRequest(ws, "upload_private_file", { user_id: task.userId, file: protocolFilePath, name: artifact.name }, { timeoutMs: 45_000 });
      } else {
        await oneBotRequest(ws, "upload_group_file", { group_id: task.groupId, file: protocolFilePath, name: artifact.name }, { timeoutMs: 45_000 });
      }
      return true;
    } catch (err) {
      warn(`task artifact send failed task=${task.id} file=${artifact.name}: ${err.message}`);
      return false;
    }
  }

  async function notifyTask(task, notice = {}) {
    if (!activeOneBotWs || activeOneBotWs.readyState !== 1) return false;
    if (task.messageType === "group" && isQuiet(memory, task.groupId)) {
      log(`task notification suppressed by quiet task=${task.id} type=${notice.type}`);
      return false;
    }
    const event = task.messageType === "private"
      ? { message_type: "private", user_id: task.userId, self_id: config.__activeAccountId || "bot" }
      : { message_type: "group", group_id: task.groupId, user_id: task.userId, self_id: config.__activeAccountId || "bot" };
    const text = trimForGroup(notice.text || "", config, task.messageType === "private" ? 1200 : 700);
    if (text) {
      if (task.messageType === "private") await oneBotRequest(activeOneBotWs, "send_private_msg", { user_id: task.userId, message: text }, { timeoutMs: 20_000 });
      else await oneBotRequest(activeOneBotWs, "send_group_msg", { group_id: task.groupId, message: text }, { timeoutMs: 20_000 });
      archiveBotReply({ event, config, memory, text, meta: { source: `task-${notice.type || "progress"}`, user_id: event.self_id, replyToUserId: task.userId, replyToSender: task.senderName } });
    }
    let delivered = 0;
    for (const artifact of asArray(notice.artifacts)) {
      if (await sendTaskArtifact(task, artifact)) delivered += 1;
    }
    if (asArray(notice.artifacts).length && delivered < asArray(notice.artifacts).length) {
      const fallback = `有 ${asArray(notice.artifacts).length - delivered} 个任务产物未能通过 OneBot 上传，可在本机管理页“任务 / Agent”中下载。`;
      if (task.messageType === "private") sendPrivateMessageToUser(activeOneBotWs, task.userId, fallback, config);
      else sendGroupMessageToGroup(activeOneBotWs, task.groupId, fallback, config);
    }
    return true;
  }

  const taskRuntime = new TaskRuntime({
    rootDir: stateRoot,
    config: () => config,
    execute: (task, runtime) => runHermesAgentTask(task, runtime, config),
    notify: notifyTask,
    log,
    warn
  });

  function accountProbeSummary(accountId) {
    const cached = accountProbeCache.get(accountId);
    if (!cached) return null;
    return {
      ok: Boolean(cached.ok),
      checkedAt: cached.checkedAt || 0,
      durationMs: cached.durationMs || 0,
      error: cached.error || "",
      loginInfo: cached.loginInfo || null,
      status: cached.status || null
    };
  }

  async function probeOneBotAccount(accountId, { timeoutMs = 5000 } = {}) {
    const account = accountById(config, accountId);
    if (!account) {
      const result = { ok: false, accountId, checkedAt: Date.now(), durationMs: 0, error: "account not configured" };
      accountProbeCache.set(accountId, result);
      return result;
    }
    const state = accountStateById(account.id);
    const started = Date.now();
    if (!state?.ws || state.ws.readyState !== 1) {
      const result = { ok: false, accountId: account.id, checkedAt: Date.now(), durationMs: Date.now() - started, error: "OneBot websocket not connected" };
      accountProbeCache.set(account.id, result);
      return result;
    }
    const result = {
      ok: false,
      accountId: account.id,
      checkedAt: 0,
      durationMs: 0,
      error: "",
      loginInfo: null,
      status: null
    };
    try {
      const [loginInfo, status] = await Promise.allSettled([
        oneBotRequest(state.ws, "get_login_info", {}, { timeoutMs }),
        oneBotRequest(state.ws, "get_status", {}, { timeoutMs })
      ]);
      if (loginInfo.status === "fulfilled") result.loginInfo = loginInfo.value;
      if (status.status === "fulfilled") result.status = status.value;
      const probedUserId = asStringId(result.loginInfo?.user_id || result.loginInfo?.data?.user_id || "");
      if (probedUserId) {
        state.selfId = probedUserId;
        if (!state.qq) state.qq = probedUserId;
      }
      const errors = [];
      if (loginInfo.status === "rejected") errors.push(`get_login_info: ${loginInfo.reason?.message || loginInfo.reason}`);
      if (status.status === "rejected") errors.push(`get_status: ${status.reason?.message || status.reason}`);
      result.error = errors.join("; ");
      result.ok = Boolean(result.loginInfo || result.status) && errors.length < 2;
    } catch (err) {
      result.error = err.message;
      result.ok = false;
    } finally {
      result.checkedAt = Date.now();
      result.durationMs = result.checkedAt - started;
      accountProbeCache.set(account.id, result);
    }
    return result;
  }

  function botAccountUserIds() {
    const ids = new Set();
    const cfg = accountFailoverConfig(config);
    for (const account of cfg.all) {
      const state = accountStateById(account.id);
      const probe = accountProbeSummary(account.id);
      for (const value of [
        account.qq,
        state?.selfId,
        state?.qq,
        probe?.loginInfo?.user_id,
        probe?.loginInfo?.data?.user_id
      ]) {
        const id = asStringId(value);
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  function parsePeerPingMessage(text) {
    const raw = String(text || "");
    if (!raw.includes("[Hermes诊断]")) return null;
    const token = raw.match(/ping[:：]([a-zA-Z0-9_-]+)/)?.[1] || "";
    const from = raw.match(/from[:：]([a-zA-Z0-9_.-]+)/)?.[1] || "";
    const to = raw.match(/to[:：]([a-zA-Z0-9_.-]+)/)?.[1] || "";
    if (!token) return null;
    return { token, from, to, raw };
  }

  function accountActualQq(account) {
    const state = accountStateById(account.id);
    const probe = accountProbeSummary(account.id);
    return asStringId(
      probe?.loginInfo?.user_id
      || probe?.loginInfo?.data?.user_id
      || state?.selfId
      || state?.qq
      || account.qq
      || ""
    );
  }

  async function sendPeerPing(fromAccount, toAccount) {
    const fromState = accountStateById(fromAccount.id);
    if (!fromState?.ws || fromState.ws.readyState !== 1) {
      return { ok: false, from: fromAccount.id, to: toAccount.id, error: "sender websocket not connected" };
    }
    const fromQq = accountActualQq(fromAccount);
    const toQq = accountActualQq(toAccount);
    if (!toQq) return { ok: false, from: fromAccount.id, to: toAccount.id, error: "target qq unknown" };
    if (fromQq && toQq && fromQq === toQq) {
      return { ok: true, skipped: true, from: fromAccount.id, to: toAccount.id, targetQq: toQq, reason: "same actual qq; peer receive check not meaningful" };
    }
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const text = `[Hermes诊断] ping:${token} from:${fromAccount.id} to:${toAccount.id}`;
    const started = Date.now();
    try {
      await oneBotRequest(fromState.ws, "send_private_msg", { user_id: toQq, message: text }, { timeoutMs: Number(config.accounts?.diagnostics?.peerPingSendTimeoutMs || 10000) });
      const current = accountPeerPing.get(fromAccount.id) || {};
      accountPeerPing.set(fromAccount.id, {
        ...current,
        sentAt: Date.now(),
        sentTo: toAccount.id,
        sentOk: true,
        sentError: "",
        token
      });
      const targetCurrent = accountPeerPing.get(toAccount.id) || {};
      accountPeerPing.set(toAccount.id, {
        ...targetCurrent,
        expectedAt: Date.now(),
        expectedFrom: fromAccount.id,
        expectedToken: token
      });
      return { ok: true, from: fromAccount.id, to: toAccount.id, targetQq: toQq, durationMs: Date.now() - started };
    } catch (err) {
      const current = accountPeerPing.get(fromAccount.id) || {};
      accountPeerPing.set(fromAccount.id, {
        ...current,
        sentAt: Date.now(),
        sentTo: toAccount.id,
        sentOk: false,
        sentError: err.message,
        token
      });
      return { ok: false, from: fromAccount.id, to: toAccount.id, targetQq: toQq, durationMs: Date.now() - started, error: err.message };
    }
  }

  async function sendOwnerSendCheck(account) {
    const state = accountStateById(account.id);
    if (!state?.ws || state.ws.readyState !== 1) {
      return { ok: false, type: "owner-send-check", from: account.id, error: "sender websocket not connected" };
    }
    const recipients = adminNotificationConfig(config).recipients || [];
    const ownerQq = asStringId(recipients[0] || privateOwnerUserIds(config)[0] || "");
    if (!ownerQq) return { ok: false, type: "owner-send-check", from: account.id, error: "owner qq unknown" };
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const actualQq = accountActualQq(account);
    const text = `[Hermes诊断] send-check:${token} from:${account.id} qq:${actualQq || account.qq || "unknown"}\n这是一条发送链路验活消息。`;
    const started = Date.now();
    try {
      await oneBotRequest(state.ws, "send_private_msg", { user_id: ownerQq, message: text }, { timeoutMs: Number(config.accounts?.diagnostics?.peerPingSendTimeoutMs || 10000) });
      const current = accountPeerPing.get(account.id) || {};
      accountPeerPing.set(account.id, {
        ...current,
        ownerSentAt: Date.now(),
        ownerSentTo: ownerQq,
        ownerSentOk: true,
        ownerSentError: "",
        ownerToken: token
      });
      return { ok: true, type: "owner-send-check", from: account.id, to: ownerQq, durationMs: Date.now() - started };
    } catch (err) {
      const current = accountPeerPing.get(account.id) || {};
      accountPeerPing.set(account.id, {
        ...current,
        ownerSentAt: Date.now(),
        ownerSentTo: ownerQq,
        ownerSentOk: false,
        ownerSentError: err.message,
        ownerToken: token
      });
      return { ok: false, type: "owner-send-check", from: account.id, to: ownerQq, durationMs: Date.now() - started, error: err.message };
    }
  }

  async function runPeerPingDiagnostics({ silent = true, notifyOwner = !silent } = {}) {
    const accounts = configuredAccountDefinitions(config);
    if (config.accounts?.diagnostics?.peerPingEnabled === false || accounts.length < 1) return [];
    const connected = accounts.filter((account) => accountConnected(account.id) && accountActualQq(account));
    const results = [];
    const sendCapable = [];
    if (notifyOwner) {
      for (const account of connected) {
        const result = await sendOwnerSendCheck(account);
        results.push(result);
        if (result.ok) sendCapable.push(account);
        await sleep(Math.max(250, Number(config.accounts?.diagnostics?.peerPingGapMs || 1000)));
      }
    } else {
      sendCapable.push(...connected);
    }
    for (const from of sendCapable) {
      const to = sendCapable.find((item) => item.id !== from.id);
      if (!to) continue;
      results.push(await sendPeerPing(from, to));
      await sleep(Math.max(250, Number(config.accounts?.diagnostics?.peerPingGapMs || 1000)));
    }
    if (!silent) log(`peer ping diagnostics ${results.map((r) => `${r.type || "peer"}:${r.from}->${r.to}:${r.ok ? "ok" : "bad"}`).join(" ")}`);
    return results;
  }

  async function maybeRunPeerPingOnMessageInactive({ force = false } = {}) {
    const diag = config.accounts?.diagnostics || {};
    if (diag.peerPingEnabled === false || diag.peerPingOnMessageInactive === false) return false;
    const nowMs = Date.now();
    const inactiveMs = Math.max(
      60_000,
      Number(diag.peerPingMessageInactiveMs || config.status?.messageInactiveWarnMs || 10 * 60_000)
    );
    const cooldownMs = Math.max(120_000, Number(diag.peerPingInactiveCooldownMs || 30 * 60_000));
    const lastChatAt = Number(runtimeStatus.lastOneBotMessageAt || 0);
    const baselineAt = lastChatAt || Number(runtimeStatus.bridgeStartedAt || nowMs);
    const quietForMs = nowMs - baselineAt;
    if (!force && quietForMs < inactiveMs) return false;
    if (!force && lastMessageInactivePeerPingAt && nowMs - lastMessageInactivePeerPingAt < cooldownMs) return false;
    lastMessageInactivePeerPingAt = nowMs;
    lastMessageInactivePeerPingReason = lastChatAt
      ? `no chat message for ${Math.round(quietForMs / 1000)}s`
      : `no chat message since bridge start for ${Math.round(quietForMs / 1000)}s`;
    log(`message inactive peer ping start reason=${lastMessageInactivePeerPingReason}`);
    const results = await runPeerPingDiagnostics({ silent: true, notifyOwner: false });
    log(`message inactive peer ping done ${results.map((r) => `${r.type || "peer"}:${r.from}->${r.to}:${r.ok ? "ok" : "bad"}`).join(" ") || "no-results"}`);
    return true;
  }

  function qrcodeRefreshSafetyConfig() {
    const diag = config.accounts?.diagnostics || {};
    return {
      enabled: diag.qrcodeRefreshSafetyEnabled !== false,
      globalCooldownMs: Math.max(60_000, Number(diag.qrcodeRefreshGlobalCooldownMs || 10 * 60_000)),
      accountCooldownMs: Math.max(60_000, Number(diag.qrcodeRefreshAccountCooldownMs || 15 * 60_000)),
      transitionGuardMs: Math.max(10_000, Number(diag.qrcodeRefreshTransitionGuardMs || 2 * 60_000)),
      failoverGuardMs: Math.max(10_000, Number(diag.qrcodeRefreshFailoverGuardMs || 2 * 60_000))
    };
  }

  function qrcodeRefreshSafetyStatus(nowMs = Date.now()) {
    const cfg = qrcodeRefreshSafetyConfig();
    const lastAt = qrcodeRefreshRuntime.lastEndedAt || qrcodeRefreshRuntime.lastStartedAt || 0;
    const globalRemainingMs = lastAt ? Math.max(0, cfg.globalCooldownMs - (nowMs - lastAt)) : 0;
    return {
      enabled: cfg.enabled,
      active: qrcodeRefreshRuntime.active,
      accountId: qrcodeRefreshRuntime.accountId,
      source: qrcodeRefreshRuntime.source,
      startedAt: qrcodeRefreshRuntime.startedAt,
      lastStartedAt: qrcodeRefreshRuntime.lastStartedAt,
      lastEndedAt: qrcodeRefreshRuntime.lastEndedAt,
      lastAccountId: qrcodeRefreshRuntime.lastAccountId,
      lastSource: qrcodeRefreshRuntime.lastSource,
      globalCooldownRemainingMs: globalRemainingMs,
      config: cfg
    };
  }

  function qrcodeRefreshGuard(accountId, { source = "unknown" } = {}) {
    const cfg = qrcodeRefreshSafetyConfig();
    if (!cfg.enabled) return { ok: true };
    const nowMs = Date.now();
    if (qrcodeRefreshRuntime.active) {
      return {
        ok: false,
        blocked: true,
        reason: `另一个二维码刷新正在执行：${qrcodeRefreshRuntime.accountId || "unknown"} (${qrcodeRefreshRuntime.source || "unknown"})`,
        safety: qrcodeRefreshSafetyStatus(nowMs)
      };
    }
    const lastGlobalAt = qrcodeRefreshRuntime.lastEndedAt || qrcodeRefreshRuntime.lastStartedAt || 0;
    if (lastGlobalAt && nowMs - lastGlobalAt < cfg.globalCooldownMs) {
      return {
        ok: false,
        blocked: true,
        reason: `刚刷新过 ${qrcodeRefreshRuntime.lastAccountId || "某个账号"} 的二维码，剩余全局冷却 ${formatDuration(cfg.globalCooldownMs - (nowMs - lastGlobalAt))}`,
        safety: qrcodeRefreshSafetyStatus(nowMs)
      };
    }
    const lastAccountAt = Number(qrcodeRefreshRuntime.byAccount.get(accountId) || 0);
    if (lastAccountAt && nowMs - lastAccountAt < cfg.accountCooldownMs) {
      return {
        ok: false,
        blocked: true,
        reason: `账号 ${accountId} 刚刷新过二维码，剩余账号冷却 ${formatDuration(cfg.accountCooldownMs - (nowMs - lastAccountAt))}`,
        safety: qrcodeRefreshSafetyStatus(nowMs)
      };
    }
    if (lastActiveAccountSwitchedAt && nowMs - lastActiveAccountSwitchedAt < cfg.failoverGuardMs && accountId !== activeAccountId) {
      return {
        ok: false,
        blocked: true,
        reason: `刚切换到 ${activeAccountId} 接管，暂不刷新另一个账号 ${accountId} 的二维码，剩余保护 ${formatDuration(cfg.failoverGuardMs - (nowMs - lastActiveAccountSwitchedAt))}`,
        safety: qrcodeRefreshSafetyStatus(nowMs)
      };
    }
    for (const account of configuredAccountDefinitions(config)) {
      if (account.id === accountId) continue;
      const state = accountStateById(account.id);
      const recentAt = Math.max(Number(state?.lastDisconnectedAt || 0), Number(state?.lastConnectedAt || 0));
      if (recentAt && nowMs - recentAt < cfg.transitionGuardMs) {
        return {
          ok: false,
          blocked: true,
          reason: `账号 ${account.id} 刚发生连接变化，暂不刷新 ${accountId} 的二维码，剩余保护 ${formatDuration(cfg.transitionGuardMs - (nowMs - recentAt))}`,
          safety: qrcodeRefreshSafetyStatus(nowMs)
        };
      }
    }
    return { ok: true, safety: qrcodeRefreshSafetyStatus(nowMs) };
  }

  function beginQrcodeRefresh(accountId, source = "unknown") {
    qrcodeRefreshRuntime.active = true;
    qrcodeRefreshRuntime.accountId = accountId;
    qrcodeRefreshRuntime.source = source;
    qrcodeRefreshRuntime.startedAt = Date.now();
    qrcodeRefreshRuntime.lastStartedAt = qrcodeRefreshRuntime.startedAt;
    qrcodeRefreshRuntime.lastAccountId = accountId;
    qrcodeRefreshRuntime.lastSource = source;
    qrcodeRefreshRuntime.byAccount.set(accountId, qrcodeRefreshRuntime.startedAt);
    saveQrcodeRefreshState();
  }

  function finishQrcodeRefresh() {
    qrcodeRefreshRuntime.lastEndedAt = Date.now();
    qrcodeRefreshRuntime.active = false;
    qrcodeRefreshRuntime.accountId = "";
    qrcodeRefreshRuntime.source = "";
    qrcodeRefreshRuntime.startedAt = 0;
    saveQrcodeRefreshState();
  }

  async function refreshQrcodeForAccount(accountId, { force = false, timeoutMs = 25000, source = "manual" } = {}) {
    const account = accountById(config, accountId);
    if (!account) return { ok: false, accountId, error: "account not configured" };
    if (accountProtocol(account) === "snowluma") {
      const ensured = await ensureAccountProtocolContainer(account, config);
      return {
        ok: Boolean(ensured.ok),
        accountId,
        protocol: "snowluma",
        container: accountProtocolContainer(account, config),
        message: ensured.ok
          ? "SnowLuma 登录请打开 WebUI 完成；本项目不解析 SnowLuma 内部二维码文件。"
          : "SnowLuma 容器未能启动，请查看 Docker 输出。",
        create: ensured.existed ? null : ensured,
        webui: snowlumaWebuiInfoForAccount(account),
        qrcode: { exists: false, path: "", ageSeconds: null },
        accounts: accountSummary()
      };
    }
    const state = accountSummary().find((item) => item.id === accountId);
    if (state?.connected && !force && !state.needsLogin && !state.suspectFakeOnline) {
      return {
        ok: false,
        online: true,
        accountId,
        message: "该账号当前看起来在线，未刷新二维码；如确认要重登，请使用强制刷新。",
        qrcode: state.qrcode,
        accounts: accountSummary()
      };
    }
    const guard = qrcodeRefreshGuard(accountId, { source });
    if (!guard.ok) {
      log(`qrcode refresh blocked account=${accountId} source=${source} reason=${guard.reason}`);
      return {
        ok: false,
        blocked: true,
        accountId,
        message: guard.reason,
        qrcode: qrFileInfoForAccount(accountId, { sync: true, currentConfig: config }),
        accounts: accountSummary(),
        safety: guard.safety
      };
    }
    const container = napcatContainerForAccount(config, accountId);
    const ensured = await ensureNapcatAccountContainer(account, config);
    if (!ensured.ok) {
      return {
        ok: false,
        accountId,
        container,
        message: "该账号 NapCat 容器不存在，且自动创建失败。",
        create: ensured,
        accounts: accountSummary()
      };
    }
    beginQrcodeRefresh(accountId, source);
    try {
      const removedLocal = removeLocalQrFilesForAccount(accountId);
      const refreshStartedAt = Date.now();
      const removedContainer = await runCommand("docker", ["exec", container, "sh", "-lc", "rm -f /app/napcat/cache/qrcode.png /app/napcat/qrcode.png"], { timeoutMs: 5000 });
      const restart = await restartNapcatContainer(container);
      if (!restart.ok) {
        return {
          ok: false,
          accountId,
          container,
          message: "该账号 NapCat 容器重启失败，无法刷新二维码。",
          create: ensured.existed ? null : ensured,
          removedLocal,
          removedContainer,
          restart,
          safety: qrcodeRefreshSafetyStatus(),
          accounts: accountSummary()
        };
      }
      const deadline = Date.now() + Math.min(45_000, Math.max(5_000, Number(timeoutMs || 25_000)));
      let qrcode = qrFileInfoForAccount(accountId, { sync: true, currentConfig: config });
      while ((!qrcode.exists || Number(qrcode.mtimeMs || 0) < refreshStartedAt - 1000) && Date.now() < deadline) {
        await sleep(1000);
        qrcode = qrFileInfoForAccount(accountId, { sync: true, currentConfig: config });
      }
      const fresh = Boolean(qrcode.exists && Number(qrcode.mtimeMs || 0) >= refreshStartedAt - 1000);
      return {
        ok: fresh,
        accountId,
        container,
        message: fresh ? "已重启该账号 NapCat 并拿到新的二维码文件。" : "已重启该账号 NapCat，但等待超时仍未发现本次新生成的二维码。",
        create: ensured.existed ? null : ensured,
        removedLocal,
        removedContainer,
        restart,
        qrcode,
        safety: qrcodeRefreshSafetyStatus(),
        accounts: accountSummary()
      };
    } finally {
      finishQrcodeRefresh();
    }
  }

  async function sendQrcodeToPrivateOwner({ ws, userId, accountId, force = false, latest = false } = {}) {
    const account = accountById(config, accountId);
    const uid = asStringId(userId);
    if (!account || !uid) return { ok: false, error: "account or owner user id missing" };
    if (accountProtocol(account) === "snowluma") {
      const ensured = await ensureAccountProtocolContainer(account, config);
      const webui = snowlumaWebuiInfoForAccount(account);
      sendPrivateMessageToUser(
        ws,
        uid,
        ensured.ok
          ? `备用账号 ${account.displayName || account.id} 使用 SnowLuma。请打开 WebUI 登录：${webui.url}\nSnowLuma 二维码由它自己的 WebUI 展示，本项目不直接转发内部二维码文件。`
          : `备用账号 ${account.displayName || account.id} 的 SnowLuma 容器启动失败：${ensured.error || ensured.stderr || "未知错误"}`,
        config
      );
      return { ok: Boolean(ensured.ok), accountId: account.id, protocol: "snowluma", webui, ensured };
    }
    let qrcode = qrFileInfoForAccount(account.id, { sync: true, currentConfig: config });
    const state = accountSummary().find((item) => item.id === account.id);
    const freshQrSeconds = Math.max(60, Number(config.accounts?.diagnostics?.freshQrSeconds || 30 * 60));
    const qrLooksExpired = Boolean(qrcode.exists && Number(qrcode.ageSeconds || 0) > freshQrSeconds);
    const shouldRefresh = force || latest || !qrcode.exists || (account.role !== "primary" && qrLooksExpired);
    if (shouldRefresh) {
      if (account.role === "primary" && state?.connected && !force && !state.needsLogin && !state.suspectFakeOnline && !qrcode.exists) {
        await oneBotRequest(ws, "send_private_msg", {
          user_id: uid,
          message: `主号 ${account.displayName || account.id} 当前在线，我没有刷新二维码，避免把正在用的登录态打断。\n如果确认要重新登录，发：强制刷新主号二维码`
        }, { timeoutMs: 15000 });
        return { ok: false, online: true, accountId: account.id, message: "primary online; not refreshed" };
      }
      const refreshed = await refreshQrcodeForAccount(account.id, { force: force || account.role !== "primary", timeoutMs: 35_000, source: "owner-private-qrcode-command" });
      qrcode = refreshed.qrcode || qrFileInfoForAccount(account.id, { sync: true, currentConfig: config });
      if (!refreshed.ok && !qrcode.exists) {
        await oneBotRequest(ws, "send_private_msg", {
          user_id: uid,
          message: `我试着刷新 ${account.displayName || account.id} 的二维码，但没拿到图片：${refreshed.message || refreshed.error || "未知错误"}`
        }, { timeoutMs: 15000 });
        return refreshed;
      }
    }
    if (!qrcode.exists || !qrcode.filePath) {
      await oneBotRequest(ws, "send_private_msg", {
        user_id: uid,
        message: `${account.displayName || account.id} 暂无二维码。你可以发“发最新${account.role === "primary" ? "主号" : "备用"}二维码”让我刷新一次。`
      }, { timeoutMs: 15000 });
      return { ok: false, accountId: account.id, message: "qrcode not found" };
    }
    const caption = `${account.displayName || account.id} 的登录二维码如下。\n账号：${account.id}${account.enabled === false ? "（已停用，不会参与聊天）" : ""}\n如果扫码后仍过期，发“发最新${account.role === "primary" ? "主号" : "备用"}二维码”。`;
    await oneBotRequest(ws, "send_private_msg", { user_id: uid, message: caption }, { timeoutMs: 15000 });
    try {
      await oneBotRequest(ws, "send_private_msg", {
        user_id: uid,
        message: [privateImageSegmentForFile(qrcode.filePath)]
      }, { timeoutMs: 20000 });
    } catch (err) {
      await oneBotRequest(ws, "send_private_msg", {
        user_id: uid,
        message: `[CQ:image,file=file://${path.resolve(qrcode.filePath)}]`
      }, { timeoutMs: 20000 });
    }
    return { ok: true, accountId: account.id, qrcode };
  }

  function abilityItem(status, text, { at = 0, reason = "", evidence = "unknown", level = "" } = {}) {
    const normalized = ["ok", "bad", "warn", "unknown"].includes(status) ? status : "unknown";
    return {
      status: normalized,
      level: level || normalized,
      ok: normalized === "ok",
      bad: normalized === "bad",
      text,
      at: Number(at || 0),
      reason: reason || text,
      evidence
    };
  }

  function abilityFresh(at, nowMs = Date.now(), maxAgeMs = 30 * 60_000) {
    return Boolean(at && nowMs - Number(at || 0) <= maxAgeMs);
  }

  function oneBotStatusValue(status, key) {
    if (!status || typeof status !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(status, key)) return status[key];
    if (status.data && typeof status.data === "object" && Object.prototype.hasOwnProperty.call(status.data, key)) return status.data[key];
    return undefined;
  }

  function oneBotStatusFlagIsFalse(status, key) {
    const value = oneBotStatusValue(status, key);
    return value === false || value === "false" || value === 0 || value === "0";
  }

  function accountStateLabel(routeState) {
    return {
      ONLINE_VERIFIED: "在线已验证",
      ONLINE_PROBABLE: "在线大概率正常",
      CONNECTED_UNKNOWN: "已连接待确认",
      DEGRADED_SEND: "发送异常",
      DEGRADED_RECEIVE: "接收异常",
      LOGIN_REQUIRED: "需要登录",
      WRONG_ACCOUNT: "账号错误",
      DISCONNECTED: "未连接",
      STALE: "连接卡住"
    }[routeState] || routeState || "未知";
  }

  function routingActionForState(routeState, account) {
    if (routeState === "ONLINE_VERIFIED") return "can_takeover";
    if (routeState === "ONLINE_PROBABLE" && account?.role === "primary") return "primary_keep";
    if (routeState === "ONLINE_PROBABLE") return "standby_observe";
    if (routeState === "CONNECTED_UNKNOWN") return "observe";
    if (routeState === "DEGRADED_SEND") return "avoid_send";
    if (routeState === "DEGRADED_RECEIVE") return "avoid_receive";
    if (["LOGIN_REQUIRED", "WRONG_ACCOUNT", "DISCONNECTED", "STALE"].includes(routeState)) return "unavailable";
    return "observe";
  }

  function diagnoseAccount(account, state = {}, nowMs = Date.now()) {
    const failoverCfg = accountFailoverConfig(config);
    const connected = Boolean(state.ws && state.ws.readyState === 1);
    const active = account.id === activeAccountId;
    const protocol = accountProtocol(account);
    const qrcode = protocol === "napcat"
      ? qrFileInfoForAccount(account.id, { sync: false, currentConfig: config })
      : { exists: false, path: "", mtimeMs: 0, ageSeconds: null };
    const webui = accountWebuiInfoForAccount(account);
    const probe = accountProbeSummary(account.id);
    const actualQq = asStringId(
      probe?.loginInfo?.user_id
      || probe?.loginInfo?.data?.user_id
      || state.selfId
      || state.qq
      || ""
    );
    const configuredQq = asStringId(account.qq || "");
    const wrongAccountLoggedIn = Boolean(configuredQq && actualQq && configuredQq !== actualQq);
    const lastFrameAt = Number(state.lastFrameAt || 0);
    const lastMessageAt = Number(state.lastMessageAt || 0);
    const peerPing = accountPeerPing.get(account.id) || {};
    const sendState = accountSendState(account.id) || {};
    const diagCfg = config.accounts?.diagnostics || {};
    const peerPingFreshMs = Math.max(30_000, Number(diagCfg.peerPingFreshMs || 15 * 60_000));
    const peerPingReceiveTimeoutMs = Math.max(5_000, Number(config.accounts?.diagnostics?.peerPingReceiveTimeoutMs || 45_000));
    const sendEvidenceFreshMs = Math.max(60_000, Number(diagCfg.sendEvidenceFreshMs || 30 * 60_000));
    const receiveEvidenceFreshMs = Math.max(60_000, Number(diagCfg.receiveEvidenceFreshMs || 30 * 60_000));
    const frameStaleMs = Math.max(30_000, Number(config.status?.onebotStaleMs || 90_000));
    const peerReceiveFresh = Boolean(peerPing.receivedAt && nowMs - Number(peerPing.receivedAt || 0) <= peerPingFreshMs);
    const peerSentFresh = Boolean(peerPing.sentAt && nowMs - Number(peerPing.sentAt || 0) <= peerPingFreshMs);
    const sendOkAfterPeerSend = Boolean(sendState.lastSendOkAt && peerPing.sentAt && Number(sendState.lastSendOkAt || 0) > Number(peerPing.sentAt || 0));
    const peerSendFailedFresh = Boolean(peerSentFresh && peerPing.sentOk === false && !sendOkAfterPeerSend);
    const ownerSentFresh = Boolean(peerPing.ownerSentAt && nowMs - Number(peerPing.ownerSentAt || 0) <= peerPingFreshMs);
    const sendOkAfterOwnerSend = Boolean(sendState.lastSendOkAt && peerPing.ownerSentAt && Number(sendState.lastSendOkAt || 0) > Number(peerPing.ownerSentAt || 0));
    const ownerSendFailedFresh = Boolean(ownerSentFresh && peerPing.ownerSentOk === false && !sendOkAfterOwnerSend);
    const peerExpectedFresh = Boolean(peerPing.expectedAt && nowMs - Number(peerPing.expectedAt || 0) <= peerPingFreshMs);
    const expectedFromAccount = peerPing.expectedFrom ? accountById(config, peerPing.expectedFrom) : null;
    const expectedFromActualQq = expectedFromAccount ? accountActualQq(expectedFromAccount) : "";
    const expectedFromSameQq = Boolean(actualQq && expectedFromActualQq && actualQq === expectedFromActualQq);
    const expectedSenderConfirmed = Boolean(peerPing.expectedFrom && accountPeerPing.get(peerPing.expectedFrom)?.sentOk === true);
    const receivedExpectedToken = Boolean(peerPing.expectedToken && peerPing.receivedToken && peerPing.expectedToken === peerPing.receivedToken);
    const latestReceiveAfterExpectedAt = Math.max(Number(lastMessageAt || 0), Number(peerPing.receivedAt || 0));
    const peerReceiveMissing = Boolean(
      peerExpectedFresh
      && !expectedFromSameQq
      && expectedSenderConfirmed
      && !receivedExpectedToken
      && (!latestReceiveAfterExpectedAt || latestReceiveAfterExpectedAt < Number(peerPing.expectedAt || 0))
      && nowMs - Number(peerPing.expectedAt || 0) >= peerPingReceiveTimeoutMs
    );
    const connectedForMs = connected ? nowMs - Number(state.lastConnectedAt || runtimeStatus.bridgeStartedAt || nowMs) : 0;
    const qrFresh = Boolean(qrcode.exists && Number(qrcode.ageSeconds || 0) <= Number(config.accounts?.diagnostics?.freshQrSeconds || 30 * 60));
    const probeStale = !probe || !probe.checkedAt || nowMs - Number(probe.checkedAt || 0) > Number(config.accounts?.diagnostics?.probeStaleMs || 2 * 60_000);
    const probeFailed = Boolean(probe && !probe.ok);
    const probeStatusOnlineFalse = Boolean(probe && probe.ok && probe.status && oneBotStatusFlagIsFalse(probe.status, "online"));
    const probeStatusGoodFalse = Boolean(probe && probe.ok && probe.status && oneBotStatusFlagIsFalse(probe.status, "good"));
    const probeLoginInvalid = Boolean(probeStatusOnlineFalse || probeStatusGoodFalse);
    const probeLoginInvalidReason = probeStatusOnlineFalse
      ? "get_status 返回 online=false，表示 QQ 登录态离线或不可用。"
      : probeStatusGoodFalse
        ? "get_status 返回 good=false，表示 OneBot/QQ 状态异常。"
        : "";
    const identityLooksValid = Boolean(
      !configuredQq
      || (actualQq && configuredQq === actualQq)
    );
    const loginLooksValid = Boolean(
      connected
      && identityLooksValid
      && (!probe || (
        probe.ok
        && !probeStatusGoodFalse
        && !probeStatusOnlineFalse
      ))
    );
    const primaryBlocked = account.id === failoverCfg.primary.id ? primaryRecoveryBlockedReason(failoverCfg, nowMs) : "";
    const primaryStalled = account.id === failoverCfg.primary.id ? primaryReceiveStalledReason(failoverCfg, nowMs) : "";
    const hasChatMessageEvidence = Boolean(lastMessageAt && (!state.lastConnectedAt || lastMessageAt >= Number(state.lastConnectedAt || 0)));
    const hasMessageEvidence = Boolean(hasChatMessageEvidence || peerReceiveFresh);
    const noMessagesAfterConnect = Boolean(
      connected
      && !hasMessageEvidence
      && connectedForMs >= Math.max(15_000, Number(config.accounts?.diagnostics?.noMessageWarnMs || failoverCfg.switchAfterMs || 60_000))
    );
    const activeSendFailure = Boolean(
      active
      && oneBotSendRuntime.lastSendFailedAt
      && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt
      && oneBotSendRuntime.lastSendAction !== "send_private_msg"
    );
    const lastFrameFresh = Boolean(lastFrameAt && nowMs - lastFrameAt <= frameStaleMs);
    const recentPrivateSendOk = abilityFresh(sendState.lastPrivateSendOkAt, nowMs, sendEvidenceFreshMs);
    const recentPrivateSendFailed = Boolean(abilityFresh(sendState.lastPrivateSendFailedAt, nowMs, sendEvidenceFreshMs) && Number(sendState.lastPrivateSendFailedAt || 0) > Number(sendState.lastPrivateSendOkAt || 0));
    const recentGroupSendOk = abilityFresh(sendState.lastGroupSendOkAt, nowMs, sendEvidenceFreshMs);
    const recentGroupSendFailed = Boolean(abilityFresh(sendState.lastGroupSendFailedAt, nowMs, sendEvidenceFreshMs) && Number(sendState.lastGroupSendFailedAt || 0) > Number(sendState.lastGroupSendOkAt || 0));
    const recentChatReceive = abilityFresh(lastMessageAt, nowMs, receiveEvidenceFreshMs);
    const recentPeerReceive = abilityFresh(peerPing.receivedAt, nowMs, receiveEvidenceFreshMs);
    const privateSendFailedFresh = Boolean(recentPrivateSendFailed || ownerSendFailedFresh || peerSendFailedFresh);
    const lastPrivateSendOkAt = Number(sendState.lastPrivateSendOkAt || 0);
    const lastPrivateSendFailedAt = Number(sendState.lastPrivateSendFailedAt || 0);
    const privateSendOkAfterFailure = Boolean(lastPrivateSendOkAt && lastPrivateSendFailedAt && lastPrivateSendOkAt > lastPrivateSendFailedAt);
    const privateSendHardFailed = Boolean(
      privateSendFailedFresh
      && !privateSendOkAfterFailure
      && (
        probeLoginInvalid
        || (ownerSendFailedFresh && peerSendFailedFresh)
        || (recentPrivateSendFailed && ownerSendFailedFresh)
        || (recentPrivateSendFailed && peerSendFailedFresh)
      )
    );
    const privateSendFailureReason = sendState.lastPrivateSendFailure
      || peerPing.ownerSentError
      || peerPing.sentError
      || "近期私聊发送超时，且没有更新的发送成功证据。";
    const capabilities = {
      identity: !connected
        ? abilityItem("unknown", "未连接，身份未确认", { evidence: "none" })
        : wrongAccountLoggedIn
          ? abilityItem("bad", "QQ 号错误", { reason: `配置 ${configuredQq}，实际 ${actualQq || "未知"}`, evidence: "strong", at: probe?.checkedAt || state.lastFrameAt || 0 })
          : identityLooksValid && actualQq
            ? abilityItem("ok", "QQ 身份正确", { reason: `实际 QQ ${actualQq}`, evidence: "strong", at: probe?.checkedAt || state.lastFrameAt || 0 })
            : abilityItem("warn", "QQ 身份待确认", { reason: "OneBot 已连接，但还没拿到明确 QQ 号。", evidence: "medium", at: state.lastFrameAt || 0 }),
      onebot: !connected
        ? abilityItem("bad", "OneBot 未连接", { evidence: "strong", reason: "该账号没有 WebSocket 连接。" })
        : !lastFrameFresh
          ? abilityItem("bad", "OneBot 疑似卡住", { at: lastFrameAt, evidence: "strong", reason: `最近帧已超过 ${Math.round(frameStaleMs / 1000)} 秒。` })
          : abilityItem("ok", "OneBot 已连接", { at: lastFrameAt, evidence: "medium", reason: "WebSocket 有近期帧。" }),
      api: !connected
        ? abilityItem("unknown", "API 未验证", { evidence: "none" })
        : probeFailed
          ? abilityItem("bad", "API 探测失败", { at: probe?.checkedAt || 0, evidence: "strong", reason: probe.error || "get_login_info/get_status 失败。" })
          : probeLoginInvalid
            ? abilityItem("bad", "登录态离线", { at: probe?.checkedAt || 0, evidence: "strong", reason: probeLoginInvalidReason })
          : probe && probe.ok
            ? abilityItem("ok", "API 正常", { at: probe.checkedAt, evidence: "strong", reason: "get_login_info/get_status 至少一个正常返回。" })
            : abilityItem("unknown", "API 待检测", { evidence: "medium", reason: "账号级接口检测尚未完成。" }),
      privateSend: recentPrivateSendOk || (ownerSentFresh && peerPing.ownerSentOk === true) || (peerSentFresh && peerPing.sentOk === true)
        ? abilityItem("ok", "私聊发送可用", { at: Math.max(Number(sendState.lastPrivateSendOkAt || 0), Number(peerPing.ownerSentAt || 0), Number(peerPing.sentAt || 0)), evidence: "strong" })
        : privateSendHardFailed
          ? abilityItem("bad", "私聊发送异常", { at: Math.max(Number(sendState.lastPrivateSendFailedAt || 0), Number(peerPing.ownerSentAt || 0), Number(peerPing.sentAt || 0)), evidence: "strong", reason: privateSendFailureReason })
        : recentPrivateSendFailed || ownerSendFailedFresh || peerSendFailedFresh
          ? abilityItem("warn", "私聊发送未确认", { at: Math.max(Number(sendState.lastPrivateSendFailedAt || 0), Number(peerPing.ownerSentAt || 0), Number(peerPing.sentAt || 0)), evidence: "weak", reason: privateSendFailureReason || "诊断私聊发送失败；只判定私聊链路可疑。" })
          : abilityItem("unknown", "私聊发送未验证", { evidence: "none" }),
      privateReceive: recentPeerReceive
        ? abilityItem("ok", "私聊接收可用", { at: peerPing.receivedAt, evidence: "strong", reason: `收到 ${peerPing.receivedFrom || "对端"} 的验活。` })
        : peerReceiveMissing
          ? abilityItem("bad", "私聊接收异常", { at: peerPing.expectedAt, evidence: "strong", reason: `发送方 ${peerPing.expectedFrom || "对端"} 已确认发出，但本账号超时未收到。` })
          : abilityItem("unknown", "私聊接收未验证", { evidence: "none" }),
      groupSend: recentGroupSendOk
        ? abilityItem("ok", "群聊发送可用", { at: sendState.lastGroupSendOkAt, evidence: "strong" })
        : recentGroupSendFailed || activeSendFailure
          ? abilityItem("bad", "群聊发送异常", { at: Math.max(Number(sendState.lastGroupSendFailedAt || 0), Number(oneBotSendRuntime.lastSendFailedAt || 0)), evidence: "strong", reason: sendState.lastGroupSendFailure || oneBotSendRuntime.lastSendFailure || "最近群聊发送失败。" })
          : abilityItem("unknown", "群聊发送未验证", { evidence: "none" }),
      groupReceive: recentChatReceive
        ? abilityItem("ok", "聊天接收可用", { at: lastMessageAt, evidence: "strong", reason: "收到真实 QQ 聊天消息。" })
        : primaryStalled
          ? abilityItem("bad", "聊天接收停滞", { at: lastMessageAt || state.lastConnectedAt || 0, evidence: "strong", reason: primaryStalled })
          : noMessagesAfterConnect
            ? abilityItem("warn", "聊天接收待确认", { at: state.lastConnectedAt || 0, evidence: "weak", reason: "连接后暂未收到真实聊天消息；这不是登录失效的充分证据。" })
            : abilityItem("unknown", "聊天接收未验证", { evidence: "none" }),
      qrcode: qrcode.exists
        ? abilityItem("warn", qrFresh ? "存在近期二维码文件" : "存在旧二维码文件", { at: qrcode.mtimeMs, evidence: "weak", reason: "二维码文件只用于登录提示，不参与健康判死。" })
        : abilityItem("unknown", "无二维码文件", { evidence: "none" })
    };
    const evidence = {
      strong: Object.values(capabilities).filter((item) => item.evidence === "strong").length,
      medium: Object.values(capabilities).filter((item) => item.evidence === "medium").length,
      weak: Object.values(capabilities).filter((item) => item.evidence === "weak").length
    };

    let level = "good";
    let status = "ok";
    let text = "正常";
    let reason = "OneBot 已连接，未发现异常。";
    let needsLogin = false;
    let suspectFakeOnline = false;
    let canReceive = Boolean(connected && hasMessageEvidence);
    let canSend = Boolean(connected && !activeSendFailure && !probeFailed && !probeLoginInvalid && !privateSendHardFailed && !recentGroupSendFailed);
    let routeState = "ONLINE_PROBABLE";

    if (!connected) {
      level = "bad";
      status = qrcode.exists ? "login_required" : "disconnected";
      text = qrcode.exists ? "需要扫码登录" : "未连接";
      reason = qrcode.exists ? "OneBot 未连接且存在二维码，通常是在等待扫码登录。" : "该账号的 OneBot WebSocket 未连接。";
      needsLogin = qrcode.exists;
      canReceive = false;
      canSend = false;
      routeState = qrcode.exists ? "LOGIN_REQUIRED" : "DISCONNECTED";
    } else if (wrongAccountLoggedIn) {
      level = "bad";
      status = "wrong_account";
      text = "登录成了别的账号";
      reason = `配置要求 QQ ${configuredQq}，但 OneBot 实际返回 QQ ${actualQq}。这个账号需要重新登录到正确 QQ。`;
      needsLogin = true;
      suspectFakeOnline = true;
      canReceive = false;
      canSend = false;
      routeState = "WRONG_ACCOUNT";
    } else if (capabilities.onebot.status === "bad") {
      level = "bad";
      status = "stale";
      text = "OneBot 卡住";
      reason = capabilities.onebot.reason;
      suspectFakeOnline = true;
      canReceive = false;
      routeState = "STALE";
    } else if (probeLoginInvalid) {
      level = "bad";
      status = probeStatusOnlineFalse ? "login_offline" : "onebot_status_bad";
      text = probeStatusOnlineFalse ? "登录态离线" : "账号状态异常";
      reason = probeLoginInvalidReason;
      needsLogin = true;
      suspectFakeOnline = true;
      canReceive = false;
      canSend = false;
      routeState = "LOGIN_REQUIRED";
    } else if (qrFresh && !hasMessageEvidence && account.role === "primary" && !loginLooksValid) {
      level = "bad";
      status = "login_required_or_fake_online";
      text = "主号疑似需重登";
      reason = "主号 OneBot 虽连接，但存在新二维码且没有收到聊天消息证据。";
      needsLogin = true;
      suspectFakeOnline = true;
      canReceive = false;
      routeState = "LOGIN_REQUIRED";
    } else if (qrFresh && !hasMessageEvidence && account.role === "primary" && loginLooksValid) {
      level = "warn";
      status = "waiting_receive_evidence";
      text = "待收消息确认";
      reason = "主号 OneBot/API/QQ 身份正常；本地二维码文件按残留处理。暂未收到聊天消息，只作为待确认。";
      needsLogin = false;
      suspectFakeOnline = false;
      canReceive = false;
      routeState = "ONLINE_PROBABLE";
    } else if (primaryBlocked) {
      if (loginLooksValid) {
        level = "warn";
        status = "receive_recovery_pending";
        text = "收消息待确认";
        reason = `${primaryBlocked}；但主号 OneBot/API/QQ 身份正常，这只作为恢复观察，不判定不可用。`;
        suspectFakeOnline = false;
        canReceive = false;
        routeState = "ONLINE_PROBABLE";
      } else {
        level = "bad";
        status = "receive_blocked";
        text = "主号收消息异常";
        reason = primaryBlocked;
        suspectFakeOnline = true;
        canReceive = false;
        routeState = "DEGRADED_RECEIVE";
      }
    } else if (primaryStalled) {
      level = "bad";
      status = "receive_stalled";
      text = "主号消息停滞";
      reason = primaryStalled;
      suspectFakeOnline = true;
      canReceive = false;
      routeState = "DEGRADED_RECEIVE";
    } else if (activeSendFailure) {
      level = "bad";
      status = "send_failed";
      text = "发送失败";
      reason = oneBotSendRuntime.lastSendFailure || "最近一次 OneBot 发送失败。";
      suspectFakeOnline = true;
      canSend = false;
      routeState = "DEGRADED_SEND";
    } else if (recentGroupSendFailed) {
      level = "bad";
      status = "group_send_failed";
      text = "群聊发送异常";
      reason = capabilities.groupSend.reason;
      suspectFakeOnline = true;
      canSend = false;
      routeState = "DEGRADED_SEND";
    } else if (privateSendHardFailed) {
      level = "bad";
      status = "private_send_failed";
      text = "私聊发送异常";
      reason = `近期私聊发送验证失败：${privateSendFailureReason}`;
      suspectFakeOnline = true;
      canSend = false;
      routeState = "DEGRADED_SEND";
    } else if (ownerSendFailedFresh) {
      level = "warn";
      status = "owner_send_unconfirmed";
      text = "私聊发送待确认";
      reason = `本账号向主人 QQ ${peerPing.ownerSentTo || "未知"} 发送诊断私聊超时；这是弱证据，只说明私聊诊断链路可疑，不判定账号整体不可用。`;
      suspectFakeOnline = false;
      canSend = true;
      routeState = loginLooksValid ? "ONLINE_PROBABLE" : "CONNECTED_UNKNOWN";
    } else if (peerSendFailedFresh) {
      level = "warn";
      status = "peer_send_unconfirmed";
      text = "私聊发送待确认";
      reason = `本账号向 ${peerPing.sentTo || "对端"} 发送诊断私聊超时；这是弱证据，只说明私聊诊断链路可疑，不判定账号整体不可用。`;
      suspectFakeOnline = false;
      canSend = true;
      routeState = loginLooksValid ? "ONLINE_PROBABLE" : "CONNECTED_UNKNOWN";
    } else if (peerReceiveMissing) {
      level = "bad";
      status = "peer_receive_missing";
      text = "未收到验活私聊";
      reason = capabilities.privateReceive.reason;
      suspectFakeOnline = true;
      canReceive = false;
      routeState = "DEGRADED_RECEIVE";
    } else if (probeFailed) {
      level = "bad";
      status = "onebot_api_failed";
      text = "接口无响应";
      reason = probe.error || "get_status/get_login_info 未返回有效结果。";
      suspectFakeOnline = true;
      canSend = false;
      routeState = "DEGRADED_SEND";
    } else if (noMessagesAfterConnect && account.role === "primary") {
      level = "warn";
      status = "no_receive_evidence";
      text = "缺少收消息证据";
      reason = "该账号连接后还没有收到真实聊天消息；这是弱证据，不能单独判定假在线。";
      suspectFakeOnline = false;
      canReceive = false;
      routeState = loginLooksValid ? "ONLINE_PROBABLE" : "CONNECTED_UNKNOWN";
    } else if (peerReceiveFresh && (peerSentFresh || ownerSentFresh)) {
      level = "good";
      status = "online_verified";
      text = "在线已验证";
      reason = "最近一次验活显示：本账号可以发送诊断私聊，也能收到对端诊断私聊。";
      canReceive = true;
      canSend = true;
      routeState = "ONLINE_VERIFIED";
    } else if (probeStale) {
      level = "warn";
      status = "probe_stale";
      text = "等待检测";
      reason = "OneBot 已连接，但账号级接口检测尚未完成或已过期。";
      routeState = "CONNECTED_UNKNOWN";
    } else if (!hasMessageEvidence) {
      level = "warn";
      status = "connected_no_messages";
      text = "已连，暂无消息";
      reason = "OneBot 已连接，但本轮启动后还没有收到聊天消息。";
      canReceive = false;
      routeState = loginLooksValid ? "ONLINE_PROBABLE" : "CONNECTED_UNKNOWN";
    } else {
      routeState = "ONLINE_PROBABLE";
    }
    const routingAction = routingActionForState(routeState, account);

    return {
      level,
      status,
      text,
      reason,
      needsLogin,
      suspectFakeOnline,
      canReceive,
      canSend,
      routeState,
      routeStateLabel: accountStateLabel(routeState),
      routingAction,
      takeoverReady: routingAction === "can_takeover" || (account.role === "primary" && routingAction === "primary_keep"),
      strongBad: ["LOGIN_REQUIRED", "WRONG_ACCOUNT", "DISCONNECTED", "STALE", "DEGRADED_SEND", "DEGRADED_RECEIVE"].includes(routeState),
      actualQq,
      configuredQq,
      wrongAccountLoggedIn,
      active,
      connected,
      lastFrameAgeSeconds: lastFrameAt ? Math.round((nowMs - lastFrameAt) / 1000) : null,
      lastMessageAgeSeconds: lastMessageAt ? Math.round((nowMs - lastMessageAt) / 1000) : null,
      connectedForSeconds: connected ? Math.round(connectedForMs / 1000) : null,
      hasMessageEvidence,
      hasChatMessageEvidence,
      capabilities,
      evidence,
      peerPing: {
        ...peerPing,
        fresh: peerReceiveFresh,
        sentFresh: peerSentFresh,
        sendFailedFresh: peerSendFailedFresh,
        sendOkAfterPeerSend,
        ownerSentFresh,
        ownerSendFailedFresh,
        sendOkAfterOwnerSend,
        privateSendHardFailed,
        expectedFresh: peerExpectedFresh,
        expectedFromSameQq,
        receivedExpectedToken,
        receiveMissing: peerReceiveMissing
      },
      sendHealth: {
        ...sendState,
        secondsSinceLastSendAttempt: sendState.lastSendAttemptAt ? Math.round((nowMs - sendState.lastSendAttemptAt) / 1000) : null,
        secondsSinceLastSendOk: sendState.lastSendOkAt ? Math.round((nowMs - sendState.lastSendOkAt) / 1000) : null,
        secondsSinceLastSendFailed: sendState.lastSendFailedAt ? Math.round((nowMs - sendState.lastSendFailedAt) / 1000) : null,
        secondsSinceLastPrivateSendOk: sendState.lastPrivateSendOkAt ? Math.round((nowMs - sendState.lastPrivateSendOkAt) / 1000) : null,
        secondsSinceLastGroupSendOk: sendState.lastGroupSendOkAt ? Math.round((nowMs - sendState.lastGroupSendOkAt) / 1000) : null
      },
      qrcodeFresh: qrFresh,
      probe,
      webui
    };
  }

  async function handleOwnerPrivateControlCommand({ ws, event, text }) {
    if (event.message_type !== "private" || !isPrivateOwner(event.user_id, config)) return false;
    const raw = String(text || "").trim();
    if (!raw) return false;
    const wantsQr = /(二维码|扫码|登录码|验证码|验证二维码)/i.test(raw);
    if (!wantsQr) return false;
    const force = /(强制|重登|重新登录|清理|reset)/i.test(raw);
    const latest = /(最新|刷新|新的|更新|重新生成)/i.test(raw);
    const wantsStandby = /(备用|备号|小跟班2|standby|standby-a|备用号)/i.test(raw);
    const wantsPrimary = /(主号|主账号|primary|小跟班(?!2))/i.test(raw);
    const configured = configuredAccountDefinitions(config);
    const firstStandby = configured.find((account) => account.role === "standby");
    let account = null;
    if (wantsStandby) account = firstStandby;
    else if (wantsPrimary) account = configured.find((item) => item.role === "primary");
    else {
      account = configured.find((item) => item.role === "standby" && (item.enabled === false || !accountConnected(item.id)))
        || configured.find((item) => item.role === "primary")
        || configured[0];
    }
    if (!account) {
      sendGroupMessage(ws, event, "我这边没有找到可发二维码的账号配置。", config, { reply: true });
      return true;
    }
    try {
      await sendQrcodeToPrivateOwner({
        ws,
        userId: event.user_id,
        accountId: account.id,
        force,
        latest
      });
    } catch (err) {
      warn(`owner qrcode command failed account=${account.id}: ${err.message}`);
      sendGroupMessage(ws, event, `二维码发送失败：${clampText(err.message, 180)}`, config, { reply: true });
    }
    return true;
  }

  const wss = new WebSocketServer({ host, port, path: routePath });

  function oneBotAccountState(accountId, accountOverride = null) {
    const cfg = accountFailoverConfig(config);
    const account = accountOverride || accountById(config, accountId) || cfg.primary;
    const existing = oneBotAccounts.get(account.id);
    if (existing) return existing;
    const state = {
      id: account.id,
      role: account.role,
      qq: account.qq || "",
      ws: null,
      connected: false,
      readyState: null,
      selfId: account.qq || "",
      lastFrameAt: 0,
      lastRawMessageAt: 0,
      lastMessageAt: 0,
      lastAcceptedMessageAt: 0,
      lastBackfillMessageAt: 0,
      lastConnectedAt: 0,
      lastDisconnectedAt: 0,
      adopted: false,
      enabled: account.enabled !== false
    };
    oneBotAccounts.set(account.id, state);
    return state;
  }

  function configuredAccountBySelfId(selfId) {
    const sid = asStringId(selfId);
    if (!sid) return null;
    return configuredAccountDefinitions(config).find((account) => account.qq && asStringId(account.qq) === sid) || null;
  }

  function chooseUnboundStandbyAccount({ includeDisabled = false, preferEmptyQq = false } = {}) {
    const cfg = accountFailoverConfig(config);
    const candidates = includeDisabled
      ? configuredAccountDefinitions(config).filter((account) => account.role === "standby")
      : cfg.standbys;
    const ordered = preferEmptyQq
      ? [...candidates].sort((a, b) => (a.qq ? 1 : 0) - (b.qq ? 1 : 0))
      : candidates;
    return ordered.find((account) => {
      const state = oneBotAccounts.get(account.id);
      return !state?.connected;
    }) || null;
  }

  function rememberAdoptedStandbyQq(account, selfId) {
    const sid = asStringId(selfId);
    if (!account || account.role !== "standby" || !sid || account.qq) return false;
    const list = Array.isArray(config.accounts?.standbys) ? config.accounts.standbys : [];
    const target = list.find((item) => asStringId(item?.id || "") === asStringId(account.id));
    if (!target || target.qq) return false;
    target.qq = sid;
    account.qq = sid;
    try {
      saveConfig(config);
      log(`adopted standby qq account=${account.id} qq=${sid} saved=true`);
      return true;
    } catch (err) {
      warn(`adopted standby qq save failed account=${account.id} qq=${sid}: ${err.message}`);
      return false;
    }
  }

  function identifyOneBotAccount(ws, event = {}) {
    const cfg = accountFailoverConfig(config);
    const currentId = wsAccountIds.get(ws);
    const preferredId = asStringId(ws.__hermesPreferredAccountId || "");
    const selfId = asStringId(event.self_id || event.selfId || "");
    let account = configuredAccountBySelfId(selfId);
    if (!account && !selfId && preferredId) account = accountById(config, preferredId);
    if (account && accountProtocol(account) === "snowluma" && preferredId !== account.id) {
      account = null;
    }
    if (!account && selfId && cfg.autoAdoptUnknownStandby && selfId !== asStringId(cfg.primary.qq)) {
      account = chooseUnboundStandbyAccount({ includeDisabled: true, preferEmptyQq: true });
    }
    if (account && accountProtocol(account) === "snowluma" && preferredId !== account.id) {
      account = null;
    }
    if (!account && currentId) {
      const currentAccount = accountById(config, currentId);
      if (!selfId || !currentAccount?.qq || asStringId(currentAccount.qq) === selfId) {
        account = currentAccount;
      }
    }
    if (!account && !selfId) {
      const primaryState = oneBotAccounts.get(cfg.primary.id);
      const reverseStandby = cfg.standbys.find((candidate) => {
        if (accountProtocol(candidate) === "snowluma") return false;
        const candidateState = oneBotAccounts.get(candidate.id);
        return !candidateState?.connected;
      });
      account = !primaryState?.connected ? cfg.primary : (reverseStandby || cfg.primary);
    }
    if (!account && selfId && selfId !== asStringId(cfg.primary.qq)) {
      account = {
        id: `unknown-${selfId}`,
        qq: selfId,
        role: "unknown",
        displayName: `未配置账号 ${selfId}`,
        onebotPath: cfg.primary.onebotPath,
        napcatContainer: "",
        enabled: false
      };
    }
    if (!account) account = cfg.primary;

    const state = oneBotAccountState(account.id, account);
    state.ws = ws;
    state.connected = ws.readyState === 1;
    state.enabled = account.enabled !== false;
    state.role = account.role;
    state.readyState = ws.readyState;
    state.lastFrameAt = Date.now();
    if (selfId) {
      state.selfId = selfId;
      if (!state.qq) state.qq = selfId;
      if (!account.qq && account.role === "standby") {
        state.adopted = true;
        rememberAdoptedStandbyQq(account, selfId);
      }
    }
    wsAccountIds.set(ws, account.id);
    ws.__hermesAccountId = account.id;
    return state;
  }

  function accountConnected(accountId) {
    const state = oneBotAccounts.get(accountId);
    return Boolean(state?.ws && state.ws.readyState === 1);
  }

  function accountStateById(accountId) {
    return oneBotAccounts.get(accountId) || null;
  }

  function routeHealthyDiagnosis(diagnosis) {
    if (!diagnosis) return false;
    if (diagnosis.routeState === "ONLINE_VERIFIED") return true;
    if (diagnosis.routeState === "ONLINE_PROBABLE") return true;
    return Boolean(
      diagnosis
      && diagnosis.level !== "bad"
      && diagnosis.needsLogin !== true
      && diagnosis.suspectFakeOnline !== true
      && diagnosis.wrongAccountLoggedIn !== true
      && diagnosis.canSend !== false
    );
  }

  function primaryRoutingHealth(failoverCfg, qqLogin, nowMs = Date.now(), { primaryReceiveStalled = "", primaryRecoveryBlocked = "" } = {}) {
    const primary = failoverCfg.primary;
    const primaryState = accountStateById(primary.id) || {};
    const primaryConnected = Boolean(primaryState.ws && primaryState.ws.readyState === 1);
    const diagnosis = diagnoseAccount(primary, primaryState, nowMs);
    const healthy = Boolean(
      primaryConnected
      && routeHealthyDiagnosis(diagnosis)
      && !primaryReceiveStalled
      && !primaryRecoveryBlocked
      && qqLogin.status === "online"
      && !qqLogin.needsLogin
      && !qqLogin.sendFailed
    );
    const reason = diagnosis?.wrongAccountLoggedIn || diagnosis?.level === "bad"
      ? (diagnosis.reason || diagnosis.text || "primary unhealthy")
      : (qqLogin.message || qqLogin.status);
    return { healthy, diagnosis, reason };
  }

  function standbyReadyForTakeover(account, nowMs = Date.now()) {
    if (!account || account.enabled === false) return false;
    if (!accountConnected(account.id)) return false;
    const state = accountStateById(account.id) || {};
    const diagnosis = diagnoseAccount(account, state, nowMs);
    if (diagnosis.routeState === "ONLINE_VERIFIED") return true;
    const caps = diagnosis.capabilities || {};
    return Boolean(
      diagnosis.routeState === "ONLINE_PROBABLE"
      && caps.identity?.status === "ok"
      && caps.onebot?.status === "ok"
      && caps.api?.status === "ok"
      && diagnosis.canSend !== false
      && diagnosis.needsLogin !== true
      && diagnosis.wrongAccountLoggedIn !== true
      && diagnosis.suspectFakeOnline !== true
    );
  }

  function primaryStronglyUnusable(primaryHealthy, reason = "", nowMs = Date.now()) {
    const cfg = accountFailoverConfig(config);
    const primaryState = accountStateById(cfg.primary.id) || {};
    const diagnosis = diagnoseAccount(cfg.primary, primaryState, nowMs);
    if (!accountConnected(cfg.primary.id)) return true;
    if (diagnosis.strongBad) return true;
    if (["LOGIN_REQUIRED", "WRONG_ACCOUNT", "DISCONNECTED", "STALE", "DEGRADED_SEND", "DEGRADED_RECEIVE"].includes(diagnosis.routeState)) return true;
    if (primaryHealthy) return false;
    return Boolean(/websocket disconnected|send failed|发送失败|登录|login|wrong account|账号错误/i.test(String(reason || diagnosis.reason || "")));
  }

  function standbyWithFreshMessages(cfg, nowMs = Date.now()) {
    return cfg.standbys.find((account) => {
      const state = accountStateById(account.id);
      const lastReceiveAt = accountLastChatMessageAt(account.id);
      const afterCurrentSwitch = !lastActiveAccountSwitchedAt || lastReceiveAt > lastActiveAccountSwitchedAt;
      return Boolean(
        state?.ws
        && state.ws.readyState === 1
        && lastReceiveAt
        && afterCurrentSwitch
        && nowMs - lastReceiveAt <= cfg.standbyFreshMs
      );
    }) || null;
  }

  function accountLastReceiveEvidenceAt(accountId) {
    const state = accountStateById(accountId);
    const peer = accountPeerPing.get(accountId) || {};
    return Math.max(Number(state?.lastMessageAt || 0), Number(peer.receivedAt || 0));
  }

  function accountLastChatMessageAt(accountId) {
    const state = accountStateById(accountId);
    return Number(state?.lastMessageAt || 0);
  }

  function primaryReceiveStalledReason(cfg, nowMs = Date.now()) {
    const primaryState = accountStateById(cfg.primary.id);
    if (!primaryState?.ws || primaryState.ws.readyState !== 1) return "primary websocket disconnected";
    const freshStandby = standbyWithFreshMessages(cfg, nowMs);
    if (!freshStandby) return "";
    const lastPrimaryMessageAt = accountLastChatMessageAt(cfg.primary.id);
    if (!lastPrimaryMessageAt) {
      const connectedFor = nowMs - Number(primaryState.lastConnectedAt || runtimeStatus.bridgeStartedAt || nowMs);
      if (connectedFor >= cfg.switchAfterMs) {
        return `primary has no chat messages for ${Math.round(connectedFor / 1000)}s while ${freshStandby.id} is receiving messages`;
      }
      return "";
    }
    const age = nowMs - lastPrimaryMessageAt;
    if (age >= cfg.messageStaleMs) {
      return `primary chat messages stale for ${Math.round(age / 1000)}s while ${freshStandby.id} is receiving messages`;
    }
    return "";
  }

  function primaryHasFreshChatMessage(cfg, nowMs = Date.now()) {
    const primaryState = accountStateById(cfg.primary.id);
    const lastMessageAt = accountLastChatMessageAt(cfg.primary.id);
    if (cfg.primaryRecoveryRequiresNewMessage && primaryUnhealthySince && lastMessageAt <= primaryUnhealthySince) {
      return false;
    }
    return Boolean(
      lastMessageAt
      && nowMs - lastMessageAt <= cfg.standbyFreshMs
    );
  }

  function primaryHasRecoveryEvidence(cfg, nowMs = Date.now()) {
    if (!primaryUnhealthySince) return true;
    const primary = cfg.primary;
    const primaryState = accountStateById(primary.id);
    if (!primaryState?.ws || primaryState.ws.readyState !== 1) return false;
    const lastChatAt = accountLastChatMessageAt(primary.id);
    if (lastChatAt && lastChatAt > primaryUnhealthySince && nowMs - lastChatAt <= cfg.standbyFreshMs) return true;
    const peer = accountPeerPing.get(primary.id) || {};
    if (Number(peer.receivedAt || 0) > primaryUnhealthySince) return true;
    const sendState = accountSendState(primary.id) || {};
    if (Number(sendState.lastSendOkAt || 0) > primaryUnhealthySince) return true;
    const probe = accountProbeSummary(primary.id);
    const actualQq = asStringId(
      probe?.loginInfo?.user_id
      || probe?.loginInfo?.data?.user_id
      || primaryState.selfId
      || primaryState.qq
      || ""
    );
    const configuredQq = asStringId(primary.qq || "");
    const identityOk = Boolean(!configuredQq || (actualQq && actualQq === configuredQq));
    return Boolean(
      probe
      && probe.ok
      && Number(probe.checkedAt || 0) > primaryUnhealthySince
      && identityOk
      && probe.status?.good !== false
      && probe.status?.online !== false
    );
  }

  function primaryRecoveryBlockedReason(cfg, nowMs = Date.now()) {
    if (!cfg.primaryRecoveryRequiresNewMessage || !primaryUnhealthySince) return "";
    const primaryState = accountStateById(cfg.primary.id);
    if (!primaryState?.ws || primaryState.ws.readyState !== 1) return "primary websocket disconnected";
    if (primaryHasRecoveryEvidence(cfg, nowMs)) return "";
    const lastMessageAt = accountLastChatMessageAt(cfg.primary.id);
    if (!lastMessageAt || lastMessageAt <= primaryUnhealthySince) {
      return `primary has not received chat messages since failover at ${new Date(primaryUnhealthySince).toISOString()}`;
    }
    if (nowMs - lastMessageAt > cfg.standbyFreshMs) {
      return `primary last recovery message is stale for ${Math.round((nowMs - lastMessageAt) / 1000)}s`;
    }
    return "";
  }

  function accountSummary() {
    const nowMs = Date.now();
    return configuredAccountDefinitions(config).map((account) => {
      const state = oneBotAccounts.get(account.id) || {};
      const protocol = accountProtocol(account);
      const qrcode = protocol === "napcat"
        ? qrFileInfoForAccount(account.id, { sync: false, currentConfig: config })
        : { exists: false, path: "", mtimeMs: 0, updatedAt: "", ageSeconds: null };
      const diagnosis = diagnoseAccount(account, state, nowMs);
      return {
        id: account.id,
        role: account.role,
        displayName: account.displayName || "",
        protocol,
        protocolLabel: accountProtocolLabel(account),
        qq: diagnosis.actualQq || state.selfId || account.qq || state.qq || "",
        actualQq: diagnosis.actualQq || "",
        configuredQq: account.qq || "",
        onebotPath: account.onebotPath || config.listen?.path || "/onebot",
        napcatContainer: account.napcatContainer || napcatContainerForAccount(config, account.id),
        protocolContainer: accountProtocolContainer(account, config),
        onebotWsUrl: account.onebotWsUrl || "",
        webuiPort: account.webuiPort || null,
        noVncPort: account.noVncPort || null,
        vncPort: account.vncPort || null,
        snowlumaImage: account.snowlumaImage || "",
        behaviorMode: account.behaviorMode || "",
        enabled: account.enabled !== false,
        active: account.id === activeAccountId,
        connected: Boolean(state.ws && state.ws.readyState === 1),
        readyState: state.ws?.readyState ?? state.readyState ?? null,
        lastFrameAt: state.lastFrameAt || 0,
        lastRawMessageAt: state.lastRawMessageAt || 0,
        lastMessageAt: state.lastMessageAt || 0,
        lastAcceptedMessageAt: state.lastAcceptedMessageAt || 0,
        lastBackfillMessageAt: state.lastBackfillMessageAt || 0,
        lastConnectedAt: state.lastConnectedAt || 0,
        lastDisconnectedAt: state.lastDisconnectedAt || 0,
        adopted: Boolean(state.adopted),
        status: diagnosis.status,
        statusLevel: diagnosis.level,
        statusText: diagnosis.text,
        statusReason: diagnosis.reason,
        needsLogin: diagnosis.needsLogin,
        suspectFakeOnline: diagnosis.suspectFakeOnline,
        wrongAccountLoggedIn: diagnosis.wrongAccountLoggedIn,
        canReceive: diagnosis.canReceive,
        canSend: diagnosis.canSend,
        routeState: diagnosis.routeState,
        routeStateLabel: diagnosis.routeStateLabel,
        routingAction: diagnosis.routingAction,
        takeoverReady: diagnosis.takeoverReady,
        strongBad: diagnosis.strongBad,
        capabilities: diagnosis.capabilities,
        evidence: diagnosis.evidence,
        sendHealth: diagnosis.sendHealth,
        diagnosis,
        webui: diagnosis.webui,
        noVnc: protocol === "snowluma"
          ? {
              port: snowlumaPortsForAccount(account).noVncPort,
              url: `http://127.0.0.1:${snowlumaPortsForAccount(account).noVncPort}`
            }
          : null,
        qrcode: {
          exists: qrcode.exists,
          path: qrcode.path,
          mtimeMs: qrcode.mtimeMs,
          updatedAt: qrcode.updatedAt,
          ageSeconds: qrcode.ageSeconds
        }
      };
    });
  }

  function enableAccountForManualActivation(accountId) {
    const account = accountById(config, accountId);
    if (!account || account.role !== "standby") return { changed: false, account };
    let changed = false;
    config.accounts ||= {};
    if (!Array.isArray(config.accounts.standbys)) config.accounts.standbys = [];
    const target = config.accounts.standbys.find((item) => asStringId(item?.id || "") === asStringId(accountId));
    if (target && target.enabled === false) {
      target.enabled = true;
      changed = true;
    }
    config.accounts.failover ||= {};
    if (config.accounts.failover.enabled === false) {
      config.accounts.failover.enabled = true;
      changed = true;
    }
    if (!changed) return { changed: false, account };
    saveConfig(config);
    replaceConfigInPlace(config, loadConfig());
    log(`manual account activation enabled account=${accountId} failover=true`);
    return { changed: true, account: accountById(config, accountId) };
  }

  function switchActiveAccount(accountId, reason = "", { force = false } = {}) {
    const account = accountById(config, accountId);
    if (!account) return false;
    if (account.enabled === false) {
      log(`account switch rejected account=${accountId} reason=disabled`);
      return false;
    }
    const state = oneBotAccounts.get(account.id);
    if (!state?.ws || state.ws.readyState !== 1) return false;
    const previous = activeAccountId;
    const previousAccount = accountById(config, previous) || { id: previous, role: previous === accountFailoverConfig(config).primary.id ? "primary" : "" };
    const cfg = accountFailoverConfig(config);
    const previousState = oneBotAccounts.get(previous);
    const previousStillConnected = Boolean(previousState?.ws && previousState.ws.readyState === 1);
    if (
      previous !== account.id
      && !force
      && previousStillConnected
      && lastActiveAccountSwitchedAt
      && Date.now() - lastActiveAccountSwitchedAt < cfg.minSwitchIntervalMs
    ) {
      log(`account switch suppressed ${previous} -> ${account.id} cooldown=${Math.round((Date.now() - lastActiveAccountSwitchedAt) / 1000)}s reason=${reason || ""}`);
      return false;
    }
    activeAccountId = account.id;
    activeOneBotWs = state.ws;
    config.__activeAccountId = account.id;
    config.__activeAccountRole = account.role;
    config.__activeAccountDisplayName = account.displayName || botDisplayName(config);
    oneBotSendRuntime.lastSendFailedAt = 0;
    oneBotSendRuntime.lastSendFailure = "";
    if (previous !== account.id) {
      lastActiveAccountSwitchedAt = Date.now();
      if (previous === cfg.primary.id && account.role === "standby") {
        primaryUnhealthySince = Date.now();
      } else if (account.id === cfg.primary.id) {
        primaryUnhealthySince = 0;
      }
      log(`account failover switched ${previous} -> ${account.id}${reason ? ` reason=${reason}` : ""}`);
      if (account.role === "standby" && cfg.announceTakeover) {
        queueAdminNotification(`【小跟班账号接管】\n主账号暂不可用，已切到备用账号 ${account.id}${state.selfId ? `（${state.selfId}）` : ""}。\n原因：${clampText(reason || "主账号异常", 240)}`);
      } else if (account.role === "primary") {
        queueAdminNotification(`【小跟班账号切回】\n主账号已恢复，已切回 ${account.id}。`);
      }
      const sentCount = announceAccountSwitchToRecentGroups(previousAccount, account, reason);
      if (!sentCount && config.accounts?.failover?.announceInGroups !== false) {
        pendingAccountSwitchGroupNotice = {
          previousAccount,
          nextAccount: account,
          reason,
          createdAt: Date.now()
        };
      }
    }
    return true;
  }

  function selectActiveAccount({ primaryHealthy = false, reason = "" } = {}) {
    const cfg = accountFailoverConfig(config);
    const primaryId = cfg.primary.id;
    const nowMs = Date.now();
    const primaryReceiveStalled = primaryReceiveStalledReason(cfg, nowMs);
    const primaryRecoveryBlocked = primaryRecoveryBlockedReason(cfg, nowMs);
    if (!cfg.enabled) {
      const primary = oneBotAccounts.get(primaryId);
      if (primary?.ws?.readyState === 1) {
        activeAccountId = primaryId;
        activeOneBotWs = primary.ws;
      }
      return activeAccountId;
    }
    const primaryUnusable = primaryStronglyUnusable(primaryHealthy, reason, nowMs);
    if (activeAccountId === primaryId && primaryReceiveStalled && primaryUnusable) {
      const standby = standbyWithFreshMessages(cfg, nowMs) || cfg.standbys.find((account) => standbyReadyForTakeover(account, nowMs));
      if (standby) {
        switchActiveAccount(standby.id, primaryReceiveStalled);
        return activeAccountId;
      }
    }
    const primaryUsable = Boolean(primaryHealthy && !primaryReceiveStalled && !primaryRecoveryBlocked && accountConnected(primaryId));
    if (cfg.switchBackWhenPrimaryHealthy && primaryUsable) {
      switchActiveAccount(primaryId, "primary healthy");
      return activeAccountId;
    }
    if (activeAccountId !== primaryId && accountConnected(activeAccountId)) return activeAccountId;
    if (primaryUsable) {
      switchActiveAccount(primaryId, "primary healthy");
      return activeAccountId;
    }
    if (!primaryUnusable) {
      const primary = oneBotAccounts.get(primaryId);
      if (primary?.ws?.readyState === 1) {
        activeAccountId = primaryId;
        activeOneBotWs = primary.ws;
        return activeAccountId;
      }
    }
    const standby = cfg.standbys.find((account) => standbyReadyForTakeover(account, nowMs));
    if (standby) switchActiveAccount(standby.id, reason || "primary unavailable");
    return activeAccountId;
  }

  function activeAccountRole() {
    return accountById(config, activeAccountId)?.role || "primary";
  }

  function flushAdminNotifications() {
    if (activeOneBotWs?.readyState !== 1) return false;
    const cfg = adminNotificationConfig(config);
    if (!cfg.enabled || !cfg.recipients.length) return false;
    const onebotConnected = activeOneBotWs.readyState === 1;
    const failoverCfg = accountFailoverConfig(config);
    const qqLogin = classifyNapcatLogin({ onebotConnected: accountConnected(failoverCfg.primary.id) });
    const sendFailureActive = Boolean(
      oneBotSendRuntime.lastSendFailedAt
      && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt
      && oneBotSendRuntime.lastSendAction !== "send_private_msg"
    );
    const activeIsStandby = activeAccountRole() === "standby";
    if (!activeIsStandby && sendFailureActive) {
      const standby = failoverCfg.standbys.find((account) => accountConnected(account.id));
      if (standby && switchActiveAccount(standby.id, oneBotSendRuntime.lastSendFailure || "primary send failed")) {
        return flushAdminNotifications();
      }
    }
    if (!activeIsStandby && (qqLogin.status !== "online" || qqLogin.needsLogin || sendFailureActive)) {
      return false;
    }
    if (activeIsStandby && sendFailureActive) {
      return false;
    }
    while (pendingAdminNotifications.length) {
      const message = pendingAdminNotifications.shift();
      for (const userId of cfg.recipients) {
        sendPrivateMessageToUser(activeOneBotWs, userId, message, config);
      }
      log(`admin notification sent recipients=${cfg.recipients.join(",")} text=${JSON.stringify(message).slice(0, 160)}`);
    }
    return true;
  }

  function queueAdminNotification(message) {
    const text = String(message || "").trim();
    if (!text) return;
    if (!pendingAdminNotifications.includes(text)) pendingAdminNotifications.push(text);
    while (pendingAdminNotifications.length > 8) pendingAdminNotifications.shift();
    flushAdminNotifications();
  }

  function checkAccountQrcodeNotifications({ force = false } = {}) {
    const cfg = adminNotificationConfig(config);
    if (!cfg.enabled || !cfg.recipients.length) return;
    if (activeAccountRole() !== "primary" || activeOneBotWs?.readyState !== 1) return;
    for (const account of configuredAccountDefinitions(config)) {
      if (account.role === "primary") continue;
      const state = oneBotAccounts.get(account.id) || {};
      const connected = Boolean(state.ws && state.ws.readyState === 1);
      if (connected) continue;
      const protocol = accountProtocol(account);
      const qr = protocol === "napcat" ? qrFileInfoForAccount(account.id, { sync: true, currentConfig: config }) : { exists: false };
      const status = protocol === "snowluma" ? "snowluma-webui" : qr.exists ? "qr-ready" : "qr-missing";
      const key = `${account.id}|${status}|${qr.exists ? Math.round(Number(qr.mtimeMs || 0) / 1000) : 0}`;
      if (!force && accountQrNoticeKeys.get(account.id) === key) continue;
      accountQrNoticeKeys.set(account.id, key);
      const name = account.displayName || account.id;
      const webui = accountWebuiInfoForAccount(account);
      const lines = [
        `【Hermes 账号提醒】${name} 当前未连接${account.enabled === false ? "（已停用，不参与聊天）" : ""}。`,
        protocol === "snowluma"
          ? `该账号使用 SnowLuma，请打开 WebUI 登录/查看二维码：${webui.url}`
          : qr.exists
            ? `二维码已准备：${qr.path || "本地二维码文件"}。你可以私聊我“发备用二维码”，我会把图片发给你。`
            : "当前暂无二维码。你可以私聊我“发最新备用二维码”，我会启动/重启备用 NapCat 生成并发给你。",
        "主号仍作为当前聊天账号使用。"
      ];
      queueAdminNotification(lines.join("\n"));
    }
  }

  function loginRecoverySnapshot() {
    const nowMs = Date.now();
    const failoverCfg = accountFailoverConfig(config);
    const primaryConnected = accountConnected(failoverCfg.primary.id);
    const qqLogin = classifyNapcatLogin({ onebotConnected: primaryConnected });
    const primaryReceiveStalled = primaryReceiveStalledReason(failoverCfg, nowMs);
    let primaryRecoveryBlocked = primaryRecoveryBlockedReason(failoverCfg, nowMs);
    const primaryRoute = primaryRoutingHealth(failoverCfg, qqLogin, nowMs, { primaryReceiveStalled, primaryRecoveryBlocked });
    const primaryHealthy = primaryRoute.healthy;
    const primaryDiagnosis = primaryRoute.diagnosis || diagnoseAccount(failoverCfg.primary, accountStateById(failoverCfg.primary.id) || {}, nowMs);
    const primaryNeedsDiagnosisRecovery = Boolean(
      primaryDiagnosis
      && (
        primaryDiagnosis.needsLogin
        || primaryDiagnosis.suspectFakeOnline
        || primaryDiagnosis.strongBad
        || ["LOGIN_REQUIRED", "WRONG_ACCOUNT", "DISCONNECTED", "STALE", "DEGRADED_SEND", "DEGRADED_RECEIVE"].includes(primaryDiagnosis.routeState)
      )
    );
    selectActiveAccount({ primaryHealthy, reason: primaryRoute.reason });
    primaryRecoveryBlocked = primaryRecoveryBlockedReason(failoverCfg, nowMs);
    const onebotConnected = activeOneBotWs?.readyState === 1;
    const staleMs = Number(config.status?.onebotStaleMs || 90_000);
    const onebotStale = Boolean(
      onebotConnected
      && runtimeStatus.lastOneBotFrameAt
      && nowMs - runtimeStatus.lastOneBotFrameAt > staleMs
    );
    const sendFailureActive = Boolean(
      oneBotSendRuntime.lastSendFailedAt
      && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt
      && oneBotSendRuntime.lastSendAction !== "send_private_msg"
    );
    const activeIsStandby = activeAccountRole() === "standby";
    const healthy = Boolean(
      onebotConnected
      && !onebotStale
      && !sendFailureActive
      && (
        activeIsStandby
        || (primaryHealthy && !primaryNeedsDiagnosisRecovery && qqLogin.status === "online" && !qqLogin.needsLogin && !qqLogin.sendFailed)
      )
    );
    const recoverableStatus = new Set([
      "login_invalid",
      "login_required",
      "verification_required",
      "send_failed",
      "disconnected",
      "unknown"
    ]);
    const shouldRecover = !activeIsStandby && !healthy && (
      !onebotConnected
      || onebotStale
      || sendFailureActive
      || primaryNeedsDiagnosisRecovery
      || recoverableStatus.has(qqLogin.status)
    );
    const reason = sendFailureActive
      ? `QQ 发送动作失败：${oneBotSendRuntime.lastSendFailure || "未收到 OneBot 发送成功回执"}`
      : primaryNeedsDiagnosisRecovery
        ? (primaryDiagnosis.reason || primaryDiagnosis.text || primaryRoute.reason || "主号账号诊断异常")
      : primaryReceiveStalled
        ? primaryReceiveStalled
      : primaryRecoveryBlocked
        ? primaryRecoveryBlocked
      : classifyAdminIncidentReason({ qqLogin, onebotConnected, onebotStale });
    return { nowMs, onebotConnected, qqLogin, onebotStale, sendFailureActive, primaryReceiveStalled, primaryRecoveryBlocked, primaryNeedsDiagnosisRecovery, primaryDiagnosis, healthy, shouldRecover, reason, primaryHealthy };
  }

  async function waitForLoginRecovery(timeoutMs) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 0));
    let snapshot = loginRecoverySnapshot();
    while (!snapshot.healthy && Date.now() < deadline) {
      await sleep(2000);
      snapshot = loginRecoverySnapshot();
    }
    return snapshot;
  }

  async function syncOrRefreshQrForRecovery(timeoutMs = 25000) {
    let qrcode = qrFileInfo({ sync: true });
    if (qrcode.exists && Number(qrcode.ageSeconds || 0) < 90) return qrcode;
    const refreshed = await refreshQrcodeForAccount("primary", {
      force: true,
      timeoutMs: Math.max(5000, Number(timeoutMs || 25000)),
      source: "login-recovery"
    });
    if (refreshed.blocked) {
      warn(`login recovery qrcode refresh blocked: ${refreshed.message || refreshed.error || "unknown"}`);
    } else if (!refreshed.ok) {
      warn(`login recovery qrcode refresh failed: ${refreshed.message || refreshed.error || "unknown"}`);
    }
    return refreshed.qrcode || qrFileInfo({ sync: true });
  }

  function resetLoginRecoveryState() {
    loginRecoveryState.active = false;
    loginRecoveryState.inFlight = false;
    loginRecoveryState.startedAt = 0;
    loginRecoveryState.attempts = 0;
    loginRecoveryState.lastAttemptAt = 0;
    loginRecoveryState.needScanNotified = false;
    loginRecoveryState.reason = "";
  }

  async function checkLoginRecovery() {
    const cfg = loginRecoveryConfig(config);
    if (!cfg.enabled || loginRecoveryState.inFlight) return;
    const snapshot = loginRecoverySnapshot();
    if (snapshot.healthy) {
      if (loginRecoveryState.active && cfg.notifyOwner) {
        queueAdminNotification(loginRecoveryNotificationText({
          stage: "recovered",
          reason: loginRecoveryState.reason || snapshot.reason,
          qqLogin: snapshot.qqLogin,
          onebotConnected: snapshot.onebotConnected,
          onebotStale: snapshot.onebotStale,
          action: "自动恢复检测到 QQ 与 OneBot 已恢复在线。"
        }));
      }
      resetLoginRecoveryState();
      flushAdminNotifications();
      return;
    }
    if (!snapshot.shouldRecover) return;

    const nowMs = Date.now();
    if (!loginRecoveryState.active) {
      loginRecoveryState.active = true;
      loginRecoveryState.startedAt = nowMs;
      loginRecoveryState.reason = snapshot.reason;
      loginRecoveryState.attempts = 0;
      loginRecoveryState.needScanNotified = false;
      log(`login recovery incident started status=${snapshot.qqLogin.status} reason=${snapshot.reason}`);
    }

    if (!cfg.autoRestartNapcat || cfg.maxAutoRestartsPerIncident <= 0) return;
    if (loginRecoveryState.attempts >= cfg.maxAutoRestartsPerIncident) {
      if (cfg.refreshQrOnFailure && !loginRecoveryState.needScanNotified && snapshot.qqLogin.needsLogin) {
        loginRecoveryState.inFlight = true;
        try {
          const qrcode = await syncOrRefreshQrForRecovery(Math.min(45_000, cfg.recoveryWaitMs));
          loginRecoveryState.needScanNotified = true;
          if (cfg.notifyOwner) {
            queueAdminNotification(loginRecoveryNotificationText({
              stage: "need_scan",
              reason: loginRecoveryState.reason || snapshot.reason,
              qqLogin: loginRecoverySnapshot().qqLogin,
              onebotConnected: activeOneBotWs?.readyState === 1,
              onebotStale: false,
              qrcode,
              action: "自动恢复次数已用完，已准备二维码。"
            }));
          }
          log(`login recovery need scan qrcode=${qrcode.exists}`);
          const failoverCfg = accountFailoverConfig(config);
          const standby = failoverCfg.standbys.find((account) => accountConnected(account.id));
          if (standby) switchActiveAccount(standby.id, "primary needs scan after recovery attempts");
        } finally {
          loginRecoveryState.inFlight = false;
        }
      }
      return;
    }
    if (loginRecoveryState.lastAttemptAt && nowMs - loginRecoveryState.lastAttemptAt < cfg.restartCooldownMs) return;

    const op = tryStartNapcatAdminOperation("login-recovery");
    if (!op.ok) {
      log(`login recovery skipped: ${op.message}`);
      return;
    }
    loginRecoveryState.inFlight = true;
    loginRecoveryState.attempts += 1;
    loginRecoveryState.lastAttemptAt = nowMs;
    try {
      log(`login recovery restart napcat attempt=${loginRecoveryState.attempts} status=${snapshot.qqLogin.status} reason=${snapshot.reason}`);
      const restart = await restartNapcatContainer("napcat");
      if (restart.ok) {
        oneBotSendRuntime.lastSendFailedAt = 0;
        oneBotSendRuntime.lastSendFailure = "";
      }
      finishNapcatAdminOperation();
      const after = await waitForLoginRecovery(cfg.recoveryWaitMs);
      if (after.healthy) {
        if (cfg.notifyOwner) {
          queueAdminNotification(loginRecoveryNotificationText({
            stage: "recovered",
            reason: loginRecoveryState.reason || snapshot.reason,
            qqLogin: after.qqLogin,
            onebotConnected: after.onebotConnected,
            onebotStale: after.onebotStale,
            action: `已自动重启 NapCat，等待 ${formatDuration(cfg.recoveryWaitMs)} 内恢复成功。`
          }));
        }
        log("login recovery succeeded after napcat restart");
        resetLoginRecoveryState();
        flushAdminNotifications();
        return;
      }
      if (cfg.refreshQrOnFailure && (after.qqLogin.needsLogin || !after.onebotConnected)) {
        const qrcode = await syncOrRefreshQrForRecovery(Math.min(45_000, cfg.recoveryWaitMs));
        loginRecoveryState.needScanNotified = true;
        if (cfg.notifyOwner) {
          queueAdminNotification(loginRecoveryNotificationText({
            stage: "need_scan",
            reason: loginRecoveryState.reason || after.reason,
            qqLogin: loginRecoverySnapshot().qqLogin,
            onebotConnected: activeOneBotWs?.readyState === 1,
            onebotStale: false,
            qrcode,
            action: "已自动重启 NapCat，但本地/快速登录没有恢复。"
          }));
        }
        log(`login recovery failed; qrcode ready=${qrcode.exists}`);
        const failoverCfg = accountFailoverConfig(config);
        const standby = failoverCfg.standbys.find((account) => accountConnected(account.id));
        if (standby) switchActiveAccount(standby.id, "primary recovery failed; qrcode required");
      }
    } catch (err) {
      warn(`login recovery failed: ${err.message}`);
    } finally {
      if (napcatAdminOperation.active && napcatAdminOperation.name === "login-recovery") finishNapcatAdminOperation();
      loginRecoveryState.inFlight = false;
    }
  }

  function checkAdminStatusNotification({ force = false } = {}) {
    const cfg = adminNotificationConfig(config);
    if (!cfg.enabled) return;
    checkAccountQrcodeNotifications({ force });
    const onebotConnected = activeOneBotWs?.readyState === 1;
    const qqLogin = classifyNapcatLogin({ onebotConnected });
    const nowMs = Date.now();
    const staleMs = Number(config.status?.onebotStaleMs || 90_000);
    const onebotStale = Boolean(
      onebotConnected
      && runtimeStatus.lastOneBotFrameAt
      && nowMs - runtimeStatus.lastOneBotFrameAt > staleMs
    );
    const sendFailureActive = Boolean(
      oneBotSendRuntime.lastSendFailedAt
      && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt
      && oneBotSendRuntime.lastSendAction !== "send_private_msg"
    );
    const interrupted = sendFailureActive || onebotStale || !onebotConnected || ["login_invalid", "login_required", "verification_required", "send_failed", "quick_login", "disconnected", "unknown"].includes(qqLogin.status);
    const reason = sendFailureActive
      ? `QQ 发送动作失败：${oneBotSendRuntime.lastSendFailure || "未收到 OneBot 发送成功回执"}`
      : classifyAdminIncidentReason({ qqLogin, onebotConnected, onebotStale });
    const loginEventKey = latestNapcatLoginEventKey(qqLogin);
    if (cfg.notifyQuickLogin && loginEventKey && loginEventKey !== lastAdminLoginEventKey) {
      lastAdminLoginEventKey = loginEventKey;
      queueAdminNotification(adminLoginAttemptNotificationText({ qqLogin, onebotConnected, onebotStale, config }));
    }
    const incidentStartAt = onebotStale
      ? (runtimeStatus.lastOneBotFrameAt ? runtimeStatus.lastOneBotFrameAt + staleMs : nowMs)
      : !onebotConnected
        ? (runtimeStatus.lastOneBotDisconnectedAt || nowMs)
        : (qqLogin.reasonEventAt || nowMs);
    let sentRecovery = false;
    if (interrupted) {
      if (!activeAdminIncident) {
        activeAdminIncident = {
          startedAt: incidentStartAt,
          status: qqLogin.status,
          reason,
          reasonEvent: qqLogin.reasonEvent || qqLogin.lastEvent || "",
          lastProblemEvent: qqLogin.reasonEvent || qqLogin.lastEvent || "",
          onebotWasConnected: onebotConnected,
          onebotStale
        };
      } else {
        activeAdminIncident.status = qqLogin.status;
        activeAdminIncident.onebotWasConnected ||= onebotConnected;
        activeAdminIncident.onebotStale ||= onebotStale;
        if (qqLogin.reasonEvent || qqLogin.lastEvent) activeAdminIncident.lastProblemEvent = qqLogin.reasonEvent || qqLogin.lastEvent;
        if (reason && reason !== activeAdminIncident.reason) {
          activeAdminIncident.reason = `${activeAdminIncident.reason}; 后续：${reason}`;
          activeAdminIncident.reason = clampText(activeAdminIncident.reason, 420);
        }
      }
    } else if (activeAdminIncident) {
      const recovered = { ...activeAdminIncident, endedAt: nowMs };
      activeAdminIncident = null;
      queueAdminNotification(adminRecoveryNotificationText({ incident: recovered, qqLogin, onebotConnected, onebotStale, config }));
      sentRecovery = true;
    }
    const eventKeyStatuses = new Set(["login_invalid", "login_required", "verification_required", "send_failed", "quick_login", "disconnected"]);
    const eventKey = eventKeyStatuses.has(qqLogin.status) ? qqLogin.lastEvent || "" : "";
    const key = `${qqLogin.status}|${onebotConnected ? "1" : "0"}|${onebotStale ? "stale" : "fresh"}|${eventKey}`;
    if (!force && key === lastAdminNotificationKey) {
      flushAdminNotifications();
      return;
    }
    lastAdminNotificationKey = key;
    if (sentRecovery) return;
    if (!shouldNotifyAdminStatus(qqLogin, onebotConnected, config, { onebotStale })) return;
    queueAdminNotification(adminStatusNotificationText({ qqLogin, onebotConnected, onebotStale, config }));
  }

  function checkAdminPeriodicStatus({ force = false } = {}) {
    const cfg = adminNotificationConfig(config);
    if (!cfg.enabled || !cfg.periodicStatusEnabled || !cfg.recipients.length) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastAdminPeriodicStatusAt < cfg.periodicStatusIntervalMs) return;
    if (activeOneBotWs?.readyState !== 1) return;
    const onebotConnected = activeOneBotWs.readyState === 1;
    const qqLogin = classifyNapcatLogin({ onebotConnected });
    const staleMs = Number(config.status?.onebotStaleMs || 90_000);
    const onebotStale = Boolean(
      onebotConnected
      && runtimeStatus.lastOneBotFrameAt
      && nowMs - runtimeStatus.lastOneBotFrameAt > staleMs
    );
    const message = adminPeriodicStatusText({
      qqLogin,
      onebotConnected,
      onebotStale,
      config,
      runtimeStatus,
      replyCoordinator
    });
    for (const userId of cfg.recipients) {
      sendPrivateMessageToUser(activeOneBotWs, userId, message, config);
    }
    lastAdminPeriodicStatusAt = nowMs;
    log(`admin periodic status sent recipients=${cfg.recipients.join(",")} text=${JSON.stringify(message).slice(0, 160)}`);
  }

  const adminNotificationTimer = setInterval(
    () => {
      try {
        checkAdminStatusNotification();
      } catch (err) {
        warn(`admin notification check failed: ${err.message}`);
      }
    },
    adminNotificationConfig(config).checkIntervalMs
  );

  const adminPeriodicStatusTimer = setInterval(
    () => {
      try {
        checkAdminPeriodicStatus();
      } catch (err) {
        warn(`admin periodic status failed: ${err.message}`);
      }
    },
    adminNotificationConfig(config).periodicStatusCheckIntervalMs
  );

  const loginRecoveryTimer = setInterval(
    () => {
      checkLoginRecovery().catch((err) => warn(`login recovery check failed: ${err.message}`));
    },
    loginRecoveryConfig(config).checkIntervalMs
  );

  async function probeAllAccounts({ silent = true } = {}) {
    const cfg = accountFailoverConfig(config);
    const results = [];
    for (const account of cfg.all) {
      try {
        results.push(await probeOneBotAccount(account.id, { timeoutMs: Number(config.accounts?.diagnostics?.probeTimeoutMs || 5000) }));
      } catch (err) {
        const result = { ok: false, accountId: account.id, checkedAt: Date.now(), durationMs: 0, error: err.message };
        accountProbeCache.set(account.id, result);
        results.push(result);
      }
    }
    if (!silent) log(`account probes updated ${results.map((r) => `${r.accountId}:${r.ok ? "ok" : "bad"}`).join(" ")}`);
    return results;
  }

  setTimeout(() => {
    probeAllAccounts({ silent: true }).catch((err) => warn(`initial account probe failed: ${err.message}`));
  }, 8000);
  setTimeout(() => {
    runPeerPingDiagnostics({ silent: true }).catch((err) => warn(`initial peer ping failed: ${err.message}`));
  }, 20_000);
  setInterval(
    () => {
      probeAllAccounts({ silent: true }).catch((err) => warn(`account probe failed: ${err.message}`));
    },
    Math.max(15_000, Number(config.accounts?.diagnostics?.probeIntervalMs || 30_000))
  );
  setInterval(
    () => {
      runPeerPingDiagnostics({ silent: true }).catch((err) => warn(`peer ping diagnostics failed: ${err.message}`));
    },
    Math.max(120_000, Number(config.accounts?.diagnostics?.peerPingIntervalMs || 10 * 60_000))
  );
  setInterval(
    () => {
      maybeRunPeerPingOnMessageInactive().catch((err) => warn(`message inactive peer ping failed: ${err.message}`));
    },
    Math.max(30_000, Number(config.accounts?.diagnostics?.probeIntervalMs || 30_000))
  );

  if (config.control?.enabled) {
    const controlHost = config.control.host || "127.0.0.1";
    const controlPort = Number(process.env.HERMES_QQ_CONTROL_PORT || config.control.port || 6200);
    const maxBodyBytes = Number(config.control.maxBodyBytes || 65536);
    const controlServer = http.createServer(async (req, res) => {
      const replyJson = (status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store, max-age=0",
          "pragma": "no-cache"
        });
        res.end(body);
      };
      const replyText = (status, body, contentType = "text/plain; charset=utf-8") => {
        res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
        res.end(body);
      };
      const replyFile = (filePath, contentType) => {
        if (!fs.existsSync(filePath)) return replyJson(404, { ok: false, error: "file not found" });
        const body = fs.readFileSync(filePath);
        res.writeHead(200, { "content-type": contentType, "content-length": body.length, "cache-control": "no-store" });
        res.end(body);
      };
      const readBody = () => new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          raw += chunk;
          if (Buffer.byteLength(raw) > maxBodyBytes) reject(new Error("body too large"));
        });
        req.on("error", reject);
        req.on("end", () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            reject(new Error("invalid json"));
          }
        });
      });
      const healthPayload = () => {
        const failoverCfg = accountFailoverConfig(config);
        const primaryConnected = accountConnected(failoverCfg.primary.id);
        const qqLogin = classifyNapcatLogin({ onebotConnected: primaryConnected });
        const qrcode = qrFileInfo();
        if (qrcode.exists) qqLogin.qrcodeExists = true;
        const generatedAt = Date.now();
        const primaryReceiveStalled = primaryReceiveStalledReason(failoverCfg, generatedAt);
        let primaryRecoveryBlocked = primaryRecoveryBlockedReason(failoverCfg, generatedAt);
        const primaryRoute = primaryRoutingHealth(failoverCfg, qqLogin, generatedAt, { primaryReceiveStalled, primaryRecoveryBlocked });
        const primaryHealthy = primaryRoute.healthy;
        selectActiveAccount({ primaryHealthy, reason: primaryRoute.reason });
        primaryRecoveryBlocked = primaryRecoveryBlockedReason(failoverCfg, generatedAt);
        const onebotConnected = activeOneBotWs?.readyState === 1;
        const staleMs = Number(config.status?.onebotStaleMs || 90_000);
        const onebotStale = Boolean(
          onebotConnected
          && runtimeStatus.lastOneBotFrameAt
          && generatedAt - runtimeStatus.lastOneBotFrameAt > staleMs
        );
        const messageInactiveMs = Number(config.status?.messageInactiveWarnMs || 10 * 60_000);
        const messageInactive = Boolean(
          onebotConnected
          && runtimeStatus.lastOneBotFrameAt
          && runtimeStatus.lastOneBotMessageAt
          && generatedAt - runtimeStatus.lastOneBotMessageAt > messageInactiveMs
        );
        const sendFailureActive = Boolean(
          oneBotSendRuntime.lastSendFailedAt
          && oneBotSendRuntime.lastSendFailedAt >= oneBotSendRuntime.lastSendOkAt
          && oneBotSendRuntime.lastSendAction !== "send_private_msg"
        );
        runtimeStatus.lastStatusGeneratedAt = generatedAt;
        const napcatSendFailed = qqLogin.status === "send_failed" || qqLogin.sendFailed;
        const activeIsStandby = activeAccountRole() === "standby";
        const accounts = accountSummary();
        const replyCoordinatorState = replyCoordinator.snapshot();
        const primaryAccount = accounts.find((item) => item.role === "primary") || {};
        const primaryAccountNeedsAttention = Boolean(primaryAccount.needsLogin || primaryAccount.suspectFakeOnline || primaryAccount.statusLevel === "bad");
        return {
          instanceId: process.env.HERMES_QQ_INSTANCE_ID || "",
          ok: !sendFailureActive && onebotConnected && !onebotStale && (
            activeIsStandby || (!napcatSendFailed && !qqLogin.needsLogin)
          ),
          generatedAt,
          onebotConnected,
          onebotStale,
          onebotStaleMs: staleMs,
          messageInactive,
          messageInactiveMs,
          onebotReadyState: activeOneBotWs?.readyState ?? null,
          qqLogin,
          qrcode,
          sendFailureActive,
          sendHealth: {
            ...oneBotSendRuntime,
            pendingSends: oneBotSendTrackers.size,
            secondsSinceLastSendAttempt: oneBotSendRuntime.lastSendAttemptAt ? Math.round((generatedAt - oneBotSendRuntime.lastSendAttemptAt) / 1000) : null,
            secondsSinceLastSendOk: oneBotSendRuntime.lastSendOkAt ? Math.round((generatedAt - oneBotSendRuntime.lastSendOkAt) / 1000) : null,
            secondsSinceLastSendFailed: oneBotSendRuntime.lastSendFailedAt ? Math.round((generatedAt - oneBotSendRuntime.lastSendFailedAt) / 1000) : null
          },
          loginNeedsAttention: qqLogin.needsLogin || !onebotConnected || onebotStale || sendFailureActive || napcatSendFailed || Boolean(primaryRecoveryBlocked) || primaryAccountNeedsAttention,
          primaryNeedsAttention: Boolean(primaryRecoveryBlocked || primaryReceiveStalled || primaryAccountNeedsAttention),
          primaryReceiveStalled: primaryReceiveStalled || "",
          primaryRecoveryBlocked: primaryRecoveryBlocked || "",
          activeAccountId,
          activeAccountRole: activeAccountRole(),
          accounts,
          allGroups: handlesAllGroups(config),
          targetGroups: targetGroups(config),
          privateChats: config.privateChats?.enabled !== false,
          targetPrivateUsers: targetPrivateUsers(config),
          queuedGroups: replyCoordinator.queuedConversationIds(),
          replyCoordinator: replyCoordinatorState,
          runtime: {
            ...runtimeStatus,
            now: generatedAt,
            onebotConnected,
            secondsSinceLastFrame: runtimeStatus.lastOneBotFrameAt ? Math.round((generatedAt - runtimeStatus.lastOneBotFrameAt) / 1000) : null,
            secondsSinceLastMessage: runtimeStatus.lastOneBotMessageAt ? Math.round((generatedAt - runtimeStatus.lastOneBotMessageAt) / 1000) : null
          },
          inbound: {
            recent: inboundAuditLog.slice(-20),
            recentCount: inboundAuditLog.length,
            dedupeSize: recentInboundMessages.size,
            counters: {
              totalAccepted: runtimeStatus.oneBotMessageCount,
              activeAccepted: runtimeStatus.activeMessageCount,
              standbyBackfillAccepted: runtimeStatus.standbyBackfillMessageCount,
              duplicates: runtimeStatus.duplicateMessageCount,
              inactiveIgnored: runtimeStatus.inactiveIgnoredMessageCount
            }
          },
          diagnostics: {
            lastMessageInactivePeerPingAt,
            lastMessageInactivePeerPingReason,
            qrcodeRefresh: qrcodeRefreshSafetyStatus(generatedAt),
            socialPlanner: {
              ...socialPlannerConfig(config),
              recent: socialDecisionRuntime.recent.slice(-20)
            },
            reviewer: {
              ...reviewerConfig(config),
              ...reviewerRuntime,
              recent: reviewerRuntime.recent.slice(-20)
            },
            replyCoordinator: replyCoordinatorState,
            tasks: {
              running: taskRuntime.running.size,
              queued: taskRuntime.queue.length,
              recent: taskRuntime.list({ limit: 10 }).map(publicTask)
            }
          }
        };
      };

      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      try {
        if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
          return replyFile(path.join(publicDir, "admin.html"), "text/html; charset=utf-8");
        }

        const accountQrMatch = url.pathname.match(/^\/qrcode\/([^/]+)\.png$/);
        if (req.method === "GET" && accountQrMatch) {
          const accountId = decodeURIComponent(accountQrMatch[1]);
          if (!accountById(config, accountId)) return replyJson(404, { ok: false, error: "account not configured", accountId });
          const qrInfo = qrFileInfoForAccount(accountId, { sync: true, currentConfig: config });
          if (!qrInfo.exists || !qrInfo.filePath) return replyJson(404, { ok: false, error: "qrcode not found; restart this NapCat account to generate a new QR code", accountId });
          return replyFile(qrInfo.filePath, "image/png");
        }

        if (req.method === "GET" && url.pathname === "/qrcode.png") {
          const qr = syncNapcatQrFromContainer() || existingQrPath();
          if (!qr) return replyJson(404, { ok: false, error: "qrcode not found; restart NapCat to generate a new QR code" });
          return replyFile(qr, "image/png");
        }

        if (req.method === "GET" && url.pathname === "/health") {
          return replyJson(200, healthPayload());
        }

        if (req.method === "GET" && url.pathname === "/api/status") {
          const health = healthPayload();
          return replyJson(200, {
            ok: true,
            serverTime: Date.now(),
            health,
            config: {
              ai: aiSettingsFromConfig(config),
              webSearch: {
                enabled: config.webSearch?.enabled !== false,
                provider: config.webSearch?.provider,
                providerOrder: config.webSearch?.providerOrder
              },
              behaviorModeDefault: behaviorMode({ groups: {} }, "status", config),
              accounts: {
                activeAccountId,
                activeAccountRole: activeAccountRole(),
                failoverEnabled: accountFailoverConfig(config).enabled,
                items: accountSummary()
              }
            },
            qrcodeExists: health.qrcode?.exists || health.qqLogin?.qrcodeExists || fs.existsSync(napcatQrPath) || fs.existsSync(napcatCacheQrPath),
            qrcode: health.qrcode,
            showQrcode: Boolean(health.qqLogin?.needsLogin || (!health.onebotConnected && health.qrcode?.exists)),
            napcat: health.qqLogin,
            napcatWebui: accountWebuiInfoForAccount(accountById(config, "primary") || config.accounts?.primary || {})?.url || "http://127.0.0.1:6099/webui",
            primaryProtocol: accountProtocol(accountById(config, "primary") || config.accounts?.primary || {}),
            primaryWebui: accountWebuiInfoForAccount(accountById(config, "primary") || config.accounts?.primary || {}),
            logs: {
              tail: tailText(bridgeLogPath, 5000),
              errorTail: tailText(bridgeErrorLogPath, 2500)
            }
          });
        }

        if (req.method === "GET" && url.pathname === "/api/config") {
          return replyJson(200, publicConfig(config));
        }

        if (req.method === "PATCH" && url.pathname === "/api/config") {
          const patch = await readBody();
          const next = sanitizeConfigPatch(patch, config);
          saveConfig(next);
          replaceConfigInPlace(config, loadConfig());
          log("admin config saved and hot reloaded");
          return replyJson(200, { ok: true, config: publicConfig(config), restartRequired: false });
        }

        if (req.method === "GET" && url.pathname === "/api/memory") {
          const groupId = url.searchParams.get("group_id");
          const latestMemory = loadMemory();
          if (groupId) return replyJson(200, latestMemory.groups?.[asStringId(groupId)] || { error: "group not found", groupId });
          return replyJson(200, memorySummary(latestMemory));
        }

        if (req.method === "GET" && url.pathname === "/api/memory/export") {
          return replyFile(memoryPath, "application/json; charset=utf-8");
        }

        if (req.method === "GET" && url.pathname === "/api/memory/integrity") {
          return replyJson(200, memoryIntegrityReport(loadMemory(), config.memory?.integrity || {}));
        }

        if (req.method === "POST" && url.pathname === "/api/memory/integrity/rebuild") {
          const body = await readBody();
          const args = [path.join(rootDir, "scripts", "memory-rebuild.js"), body.apply === true ? "--apply" : "--dry-run"];
          if (body.noAi === true) args.push("--no-ai");
          if (body.groupId) args.push("--group", asStringId(body.groupId));
          if (body.userId) args.push("--user", asStringId(body.userId));
          const result = await runCommand(process.execPath, args, { timeoutMs: Number(body.apply === true ? 30 * 60_000 : 20 * 60_000) });
          if (body.apply === true && result.ok) {
            const latest = loadMemory();
            for (const key of Object.keys(memory)) delete memory[key];
            Object.assign(memory, latest);
          }
          return replyJson(result.ok ? 200 : 500, { ...result, stdout: clampText(result.stdout, 4000), stderr: clampText(result.stderr, 2000) });
        }

        if (req.method === "GET" && url.pathname === "/api/reviewer/status") {
          return replyJson(200, {
            ok: true,
            config: reviewerConfig(config),
            metrics: { ...reviewerRuntime, recent: reviewerRuntime.recent.slice(-50) }
          });
        }

        if (req.method === "GET" && url.pathname === "/api/tasks") {
          const conversationId = url.searchParams.get("conversation_id") || "";
          return replyJson(200, { ok: true, running: taskRuntime.running.size, queued: taskRuntime.queue.length, tasks: taskRuntime.list({ conversationId, limit: 200 }).map(publicTask) });
        }

        const taskDetailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (req.method === "GET" && taskDetailMatch) {
          const task = taskRuntime.get(decodeURIComponent(taskDetailMatch[1]));
          if (!task) return replyJson(404, { ok: false, error: "task not found" });
          return replyJson(200, { ok: true, task: publicTask(task), artifacts: taskRuntime.artifacts(task.id).map(({ filePath, ...item }) => item) });
        }

        const taskActionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|resume|grant|supplement)$/);
        if (req.method === "POST" && taskActionMatch) {
          const body = await readBody();
          const taskId = decodeURIComponent(taskActionMatch[1]);
          const actor = { userId: asStringId(taskModeConfig(config).ownerUserIds[0]), source: "admin" };
          const action = taskActionMatch[2];
          const result = action === "cancel"
            ? taskRuntime.cancel(taskId, actor)
            : action === "resume"
              ? taskRuntime.resume(taskId, actor)
              : action === "supplement"
                ? taskRuntime.addContext(taskId, body.text, actor)
                : taskRuntime.grant(taskId, { type: body.type, target: body.target || body.path, purpose: body.purpose || "admin console" }, actor);
          return replyJson(result.ok ? 200 : 400, { ...result, task: publicTask(result.task) });
        }

        const taskArtifactsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
        if (req.method === "GET" && taskArtifactsMatch) {
          const taskId = decodeURIComponent(taskArtifactsMatch[1]);
          if (!taskRuntime.get(taskId)) return replyJson(404, { ok: false, error: "task not found" });
          return replyJson(200, { ok: true, artifacts: taskRuntime.artifacts(taskId).map(({ filePath, ...item }) => item) });
        }

        const taskArtifactMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
        if (req.method === "GET" && taskArtifactMatch) {
          const taskId = decodeURIComponent(taskArtifactMatch[1]);
          const artifactId = decodeURIComponent(taskArtifactMatch[2]);
          const filePath = taskRuntime.artifactPath(taskId, artifactId);
          if (!filePath) return replyJson(404, { ok: false, error: "artifact not found" });
          const ext = path.extname(filePath).toLowerCase();
          const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".json" ? "application/json; charset=utf-8" : ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
          return replyFile(filePath, type);
        }

        if (req.method === "GET" && url.pathname === "/api/archive/status") {
          return replyJson(200, { ok: true, ...chatArchiveStatus(config) });
        }

        if (req.method === "GET" && url.pathname === "/api/archive/conversations") {
          return replyJson(200, { ok: true, conversations: archiveConversations(config) });
        }

        if (req.method === "GET" && url.pathname === "/api/archive/export") {
          const conversationId = url.searchParams.get("conversation_id") || "";
          const filePath = archivePathForConversationId(conversationId, config);
          const baseDir = chatArchiveConfig(config).baseDir;
          if (!filePath || !path.resolve(filePath).startsWith(path.resolve(baseDir))) {
            return replyJson(400, { ok: false, error: "invalid conversation_id" });
          }
          if (!fs.existsSync(filePath)) return replyJson(404, { ok: false, error: "archive not found", conversationId });
          return replyFile(filePath, "application/x-ndjson; charset=utf-8");
        }

        if (req.method === "POST" && url.pathname === "/api/archive/clear") {
          const body = await readBody();
          if (body.confirm !== true && body.confirm !== "confirm") {
            return replyJson(400, { ok: false, error: "confirm required" });
          }
          const cfg = chatArchiveConfig(config);
          const conversationId = body.conversationId || body.conversation_id || "";
          if (conversationId) {
            const filePath = archivePathForConversationId(conversationId, config);
            const dir = filePath ? path.dirname(filePath) : "";
            if (!dir || !path.resolve(dir).startsWith(path.resolve(cfg.baseDir))) return replyJson(400, { ok: false, error: "invalid conversation_id" });
            fs.rmSync(dir, { recursive: true, force: true });
            return replyJson(200, { ok: true, cleared: conversationId });
          }
          fs.rmSync(cfg.baseDir, { recursive: true, force: true });
          return replyJson(200, { ok: true, cleared: "all" });
        }

        if (req.method === "POST" && url.pathname === "/api/ai/test") {
          const body = await readBody();
          const testConfig = sanitizeConfigPatch({ ai: body.ai || {} }, config);
          const started = Date.now();
          try {
            const response = await callHermes("用一句话回复 ok，最多 8 个字。", testConfig);
            return replyJson(200, { ok: true, durationMs: Date.now() - started, response: clampText(response, 500), ai: aiSettingsFromConfig(testConfig) });
          } catch (err) {
            return replyJson(200, { ok: false, durationMs: Date.now() - started, error: clampText(err.message, 1200), ai: aiSettingsFromConfig(testConfig) });
          }
        }

        if (req.method === "GET" && url.pathname === "/api/search/test") {
          const q = url.searchParams.get("q") || "24小时内重要的科技新闻";
          const current = { sender: "测试", text: q, user_id: "test", at: Date.now() };
          const candidate = detectWebSearchRequest(q, config, { history: [], current, mentioned: true, keyword: true, isPrivate: false });
          const decision = await judgeWebSearchWithAI(
            candidate.matched ? candidate : { matched: true, query: q, kind: isWeatherQuery(q) ? "weather" : "web", reason: "api-test" },
            { text: q, history: [], current, config }
          );
          if (!decision.matched) return replyJson(200, { ok: true, query: q, decision, context: "" });
          const context = await buildWebSearchContext(decision, config);
          return replyJson(200, { ok: true, query: q, decision, context: context.text, result: context.result });
        }

        if (req.method === "POST" && url.pathname === "/api/napcat/restart") {
          const op = tryStartNapcatAdminOperation("restart");
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await restartNapcatContainer("napcat");
            log(`admin napcat restart ok=${result.ok}`);
            return replyJson(result.ok ? 200 : 500, result);
          } finally {
            finishNapcatAdminOperation();
          }
        }

        const accountProbeMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/probe$/);
        if (req.method === "POST" && accountProbeMatch) {
          const accountId = decodeURIComponent(accountProbeMatch[1]);
          if (!accountById(config, accountId)) return replyJson(404, { ok: false, error: "account not configured", accountId });
          const probe = await probeOneBotAccount(accountId, { timeoutMs: Number(config.accounts?.diagnostics?.probeTimeoutMs || 5000) });
          return replyJson(200, {
            ok: probe.ok,
            accountId,
            probe,
            account: accountSummary().find((item) => item.id === accountId) || null,
            accounts: accountSummary()
          });
        }

        if (req.method === "POST" && url.pathname === "/api/accounts/peer-ping") {
          const results = await runPeerPingDiagnostics({ silent: false });
          return replyJson(200, {
            ok: results.length > 0 && results.every((item) => item.ok),
            results,
            accounts: accountSummary()
          });
        }

        const accountActivateMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/activate$/);
        if (req.method === "POST" && accountActivateMatch) {
          const accountId = decodeURIComponent(accountActivateMatch[1]);
          if (!accountById(config, accountId)) return replyJson(404, { ok: false, error: "account not configured", accountId });
          let autoEnabled = false;
          try {
            const enabled = enableAccountForManualActivation(accountId);
            autoEnabled = Boolean(enabled.changed);
          } catch (err) {
            warn(`manual account activation enable failed account=${accountId}: ${err.message}`);
            return replyJson(500, { ok: false, accountId, error: `切换前启用账号失败：${err.message}` });
          }
          const ok = switchActiveAccount(accountId, "manual admin activation", { force: true });
          const health = healthPayload();
          const accounts = accountSummary();
          return replyJson(ok ? 200 : 409, {
            ok,
            accountId,
            activeAccountId,
            autoEnabled,
            message: ok ? `已切换当前发言账号为 ${accountId}` : "切换失败：该账号 OneBot 未连接或不可用。",
            health,
            account: accounts.find((item) => item.id === accountId) || null,
            accounts
          });
        }

        const accountResetLoginMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/login\/reset$/);
        if (req.method === "POST" && accountResetLoginMatch) {
          const accountId = decodeURIComponent(accountResetLoginMatch[1]);
          const account = accountById(config, accountId);
          if (!account) return replyJson(404, { ok: false, error: "account not configured", accountId });
          if (accountProtocol(account) === "snowluma") {
            const ensured = await ensureAccountProtocolContainer(account, config);
            return replyJson(ensured.ok ? 200 : 500, {
              ok: Boolean(ensured.ok),
              accountId,
              protocol: "snowluma",
              container: accountProtocolContainer(account, config),
              message: ensured.ok
                ? "SnowLuma 登录态清理由 SnowLuma WebUI 管理；请打开 WebUI 退出/重新登录。"
                : "SnowLuma 容器未能启动，请先检查 Docker。",
              webui: snowlumaWebuiInfoForAccount(account),
              qrcode: { exists: false, path: "", ageSeconds: null },
              accounts: accountSummary()
            });
          }
          const op = tryStartNapcatAdminOperation(`${accountId}:login-reset`);
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await resetNapcatLoginStateForAccount(account, config);
            const deadline = Date.now() + 35_000;
            let qrcode = qrFileInfoForAccount(accountId, { sync: true, currentConfig: config });
            while (!qrcode.exists && Date.now() < deadline) {
              await sleep(1000);
              qrcode = qrFileInfoForAccount(accountId, { sync: true, currentConfig: config });
            }
            log(`admin account login reset account=${accountId} ok=${result.ok} qrcode=${qrcode.exists} backup=${result.backup || ""}`);
            return replyJson(result.ok ? 200 : 500, {
              ...result,
              qrcode,
              accounts: accountSummary()
            });
          } finally {
            finishNapcatAdminOperation();
          }
        }

        const accountRestartMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(?:protocol|napcat)\/restart$/);
        if (req.method === "POST" && accountRestartMatch) {
          const accountId = decodeURIComponent(accountRestartMatch[1]);
          const account = accountById(config, accountId);
          if (!account) return replyJson(404, { ok: false, error: "account not configured", accountId });
          const container = accountProtocolContainer(account, config);
          const protocol = accountProtocol(account);
          const op = tryStartNapcatAdminOperation(`${accountId}:restart`);
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await restartAccountProtocol(account, config);
            log(`admin protocol restart account=${accountId} protocol=${protocol} container=${container} ok=${result.ok}`);
            return replyJson(result.ok ? 200 : 500, {
              ...result,
              accountId,
              protocol,
              container,
              qrcode: protocol === "napcat" ? qrFileInfoForAccount(accountId, { sync: true, currentConfig: config }) : { exists: false, path: "", ageSeconds: null },
              accounts: accountSummary()
            });
          } finally {
            finishNapcatAdminOperation();
          }
        }

        if (req.method === "POST" && url.pathname === "/api/qrcode/refresh") {
          const body = await readBody();
          const force = Boolean(body.force);
          const timeoutMs = Math.min(45_000, Math.max(5_000, Number(body.timeoutMs || 25_000)));
          const before = healthPayload();
          const online = Boolean(
            before.onebotConnected
            && before.qqLogin?.status === "online"
            && !before.qqLogin?.needsLogin
            && !before.onebotStale
            && !before.sendFailureActive
          );
          if (online && !force) {
            return replyJson(200, {
              ok: false,
              online: true,
              message: "QQ 当前看起来在线；为了避免打断会话，未重启 NapCat。若确实要换二维码，请先确认登录已失效，或使用重启/稳定重建。",
              qrcode: before.qrcode,
              health: before
            });
          }

          const op = tryStartNapcatAdminOperation("qrcode-refresh");
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await refreshQrcodeForAccount("primary", { force, timeoutMs, source: "admin-primary-qrcode-refresh" });
            const after = healthPayload();
            log(`admin qrcode refresh account=primary qrcode=${Boolean(result.qrcode?.exists)} freshOk=${result.ok} blocked=${Boolean(result.blocked)}`);
            return replyJson(result.ok ? 200 : (result.blocked ? 409 : 500), { ...result, health: after });
          } finally {
            finishNapcatAdminOperation();
          }
        }

        const accountQrRefreshMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/qrcode\/refresh$/);
        if (req.method === "POST" && accountQrRefreshMatch) {
          const accountId = decodeURIComponent(accountQrRefreshMatch[1]);
          const account = accountById(config, accountId);
          if (!account) return replyJson(404, { ok: false, error: "account not configured", accountId });
          const body = await readBody();
          const force = Boolean(body.force);
          const timeoutMs = Math.min(45_000, Math.max(5_000, Number(body.timeoutMs || 25_000)));
          const state = accountSummary().find((item) => item.id === accountId);
          if (state?.connected && !force && !state.needsLogin && !state.suspectFakeOnline) {
            return replyJson(200, {
              ok: false,
              online: true,
              accountId,
              message: "这个账号当前看起来可用；为了避免打断会话，未重启。若确实要换二维码，请使用强制刷新。",
              qrcode: state.qrcode,
              accounts: accountSummary()
            });
          }

          const container = napcatContainerForAccount(config, accountId);
          const op = tryStartNapcatAdminOperation(`${accountId}:qrcode-refresh`);
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await refreshQrcodeForAccount(accountId, { force, timeoutMs, source: "admin-account-qrcode-refresh" });
            log(`admin qrcode refresh account=${accountId} container=${container} qrcode=${Boolean(result.qrcode?.exists)} freshOk=${result.ok}`);
            return replyJson(result.ok ? 200 : (result.blocked ? 409 : 500), result);
          } finally {
            finishNapcatAdminOperation();
          }
        }

        if (req.method === "POST" && url.pathname === "/api/napcat/rebuild-stable") {
          if (!fs.existsSync(recreateNapcatStableScriptPath)) {
            return replyJson(404, { ok: false, error: "stable recreate script not found", path: recreateNapcatStableScriptPath });
          }
          const op = tryStartNapcatAdminOperation("stable-rebuild");
          if (!op.ok) return replyJson(409, op);
          try {
            const result = await runCommand("bash", [recreateNapcatStableScriptPath], { timeoutMs: 120000 });
            log(`admin napcat stable rebuild ok=${result.ok}`);
            const qrcode = qrFileInfo({ sync: true });
            return replyJson(result.ok ? 200 : 500, {
              ...result,
              qrcode,
              message: result.ok
                ? "NapCat 已按稳定设备身份重建；如果 QQ 需要登录，请扫码或等待快速登录。"
                : "NapCat 稳定重建失败，请查看 stderr。"
            });
          } finally {
            finishNapcatAdminOperation();
          }
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/restart") {
          const result = await runCommand("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() || ""}/com.codex.qq-hermes-onebot-bridge`], { timeoutMs: 15000 });
          log(`admin bridge restart requested ok=${result.ok}`);
          return replyJson(result.ok ? 200 : 500, result);
        }

        if (req.method === "POST" && url.pathname === "/send") {
          if (activeOneBotWs?.readyState !== 1) {
            return replyJson(503, { ok: false, error: "onebot not connected" });
          }
          const body = await readBody();
          const groupId = asStringId(body.group_id || body.groupId || (handlesAllGroups(config) ? "" : targetGroups(config)[0]));
          const message = String(body.message || body.text || "").trim();
          if (!groupId) return replyJson(400, { ok: false, error: "group_id is required when targetGroups allows all groups" });
          if (!shouldHandleGroup(groupId, config)) return replyJson(403, { ok: false, error: `group ${groupId} is not in targetGroups` });
          if (!message) return replyJson(400, { ok: false, error: "message is required" });
          try {
            await oneBotRequest(activeOneBotWs, "send_group_msg", { group_id: groupId, message }, { timeoutMs: 20000 });
            recordBotMessage({
              historyByGroup,
              lastBotMessageByGroup,
              groupId,
              text: message,
              config,
              memory,
              meta: {
                source: "manual",
                mentionedUserIds: relatedUserIdsFromText(message, groupMemory(memory, groupId))
              }
            });
            oneBotSendRuntime.lastSendAttemptAt = Date.now();
            oneBotSendRuntime.lastSendOkAt = Date.now();
            oneBotSendRuntime.lastSendAction = "send_group_msg";
            oneBotSendRuntime.lastSendFailure = "";
            log(`manual send group=${groupId} text=${JSON.stringify(message).slice(0, 160)}`);
            return replyJson(200, { ok: true, group_id: groupId });
          } catch (err) {
            oneBotSendRuntime.lastSendAttemptAt = Date.now();
            oneBotSendRuntime.lastSendFailedAt = Date.now();
            oneBotSendRuntime.lastSendAction = "send_group_msg";
            oneBotSendRuntime.lastSendFailure = clampText(err.message, 300);
            warn(`manual send group failed group=${groupId}: ${err.message}`);
            return replyJson(502, { ok: false, group_id: groupId, error: clampText(err.message, 800) });
          }
        }

        if (req.method === "POST" && url.pathname === "/api/send_private") {
          if (activeOneBotWs?.readyState !== 1) {
            return replyJson(503, { ok: false, error: "onebot not connected" });
          }
          const body = await readBody();
          const userId = String(body.user_id || body.userId || "").trim();
          const message = String(body.message || body.text || "").trim();
          if (!userId) return replyJson(400, { ok: false, error: "user_id is required" });
          if (!message) return replyJson(400, { ok: false, error: "message is required" });
          try {
            await oneBotRequest(activeOneBotWs, "send_private_msg", { user_id: userId, message }, { timeoutMs: 20000 });
            oneBotSendRuntime.lastSendAttemptAt = Date.now();
            oneBotSendRuntime.lastSendOkAt = Date.now();
            oneBotSendRuntime.lastSendAction = "send_private_msg";
            oneBotSendRuntime.lastSendFailure = "";
            log(`manual send_private user=${userId} text=${JSON.stringify(message).slice(0, 160)}`);
            return replyJson(200, { ok: true, user_id: userId });
          } catch (err) {
            oneBotSendRuntime.lastSendAttemptAt = Date.now();
            oneBotSendRuntime.lastSendFailedAt = Date.now();
            oneBotSendRuntime.lastSendAction = "send_private_msg";
            oneBotSendRuntime.lastSendFailure = clampText(err.message, 300);
            warn(`manual send_private failed user=${userId}: ${err.message}`);
            return replyJson(502, { ok: false, user_id: userId, error: clampText(err.message, 800) });
          }
        }

        return replyJson(404, { ok: false, error: "not found" });
      } catch (err) {
        return replyJson(500, { ok: false, error: err.message });
      }
    });
    controlServer.listen(controlPort, controlHost, () => {
      log(`Control API listening: http://${controlHost}:${controlPort}`);
    });
  }

  function registerOneBotConnection(ws, req = { socket: { remoteAddress: "local" } }) {
    const initialState = identifyOneBotAccount(ws, {});
    if (initialState.enabled !== false && (!activeOneBotWs || activeOneBotWs.readyState !== 1)) {
      activeAccountId = initialState.id;
      activeOneBotWs = ws;
    }
    runtimeStatus.lastOneBotConnectedAt = Date.now();
    runtimeStatus.lastOneBotFrameAt = runtimeStatus.lastOneBotConnectedAt;
    runtimeStatus.lastOneBotDisconnectedAt = 0;
    initialState.lastConnectedAt = runtimeStatus.lastOneBotConnectedAt;
    log(`OneBot connected from ${req.socket?.remoteAddress || "local"} account=${initialState.id}`);
    if (initialState.id === activeAccountId) {
      checkAdminStatusNotification({ force: true });
      flushAdminNotifications();
    }

    ws.on("message", async (raw) => {
      runtimeStatus.lastOneBotFrameAt = Date.now();
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      event.__receivedAt = Date.now();
      const accountState = identifyOneBotAccount(ws, event);
      accountState.lastFrameAt = runtimeStatus.lastOneBotFrameAt;
      if (event.status || event.retcode != null) {
        const pending = event.echo ? pendingOneBotActions.get(event.echo) : null;
        if (pending) {
          pendingOneBotActions.delete(event.echo);
          if (event.status === "ok" || event.retcode === 0) pending.resolve(event.data || {});
          else pending.reject(new Error(event.message || event.wording || `onebot action failed retcode=${event.retcode}`));
          return;
        }
        const sendTracker = event.echo ? oneBotSendTrackers.get(event.echo) : null;
        if (sendTracker) {
          oneBotSendTrackers.delete(event.echo);
          clearTimeout(sendTracker.timer);
          if (event.status === "ok" || event.retcode === 0) {
            oneBotSendRuntime.lastSendOkAt = Date.now();
            oneBotSendRuntime.lastSendAction = sendTracker.action;
            oneBotSendRuntime.lastSendFailure = "";
            recordAccountSend(sendTracker.accountId, sendTracker.action, { ok: true });
          } else {
            const detail = event.message || event.wording || event.error || `retcode=${event.retcode}`;
            oneBotSendRuntime.lastSendFailedAt = Date.now();
            oneBotSendRuntime.lastSendAction = sendTracker.action;
            oneBotSendRuntime.lastSendFailure = clampText(`${sendTracker.action} 失败：${detail}`, 300);
            recordAccountSend(sendTracker.accountId, sendTracker.action, { ok: false, failure: oneBotSendRuntime.lastSendFailure });
            warn(`onebot send failed action=${sendTracker.action} echo=${event.echo} detail=${oneBotSendRuntime.lastSendFailure}`);
          }
        }
        return;
      }
      if (event.post_type !== "message" || !["group", "private"].includes(event.message_type)) return;
      const isPrivate = event.message_type === "private";
      const groupId = conversationIdFromEvent(event);
      const senderId = asStringId(event.user_id);
      const selfId = asStringId(event.self_id);
      let rawMessagePayload = event.message || event.raw_message;
      let text0 = oneBotMessageToText(rawMessagePayload);
      let text = stripSelfMention(text0, event);
      const senderName = event.sender?.card || event.sender?.nickname || senderId || "群友";
      const peerPing = parsePeerPingMessage(text0);
      if (peerPing) {
        const current = accountPeerPing.get(accountState.id) || {};
        accountPeerPing.set(accountState.id, {
          ...current,
          receivedAt: Date.now(),
          receivedFrom: peerPing.from || senderId,
          receivedToken: peerPing.token,
          receivedSenderId: senderId
        });
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "ignored-peer-ping", reason: `from=${peerPing.from || senderId}` });
        return;
      }
      if (accountState.enabled === false || accountState.role === "unknown") {
        if (activeOneBotWs === ws && accountState.id !== activeAccountId) {
          activeOneBotWs = null;
          const activeState = oneBotAccounts.get(activeAccountId);
          if (activeState?.enabled !== false && activeState?.ws?.readyState === 1) activeOneBotWs = activeState.ws;
        }
        logIncomingMessage({
          accountState,
          event,
          text0: oneBotMessageToText(event.message || event.raw_message),
          senderName: event.sender?.card || event.sender?.nickname || senderId || "群友",
          disposition: "ignored-disabled-account",
          reason: `account ${accountState.id} is disabled or unknown`
        });
        return;
      }
      const botIds = botAccountUserIds();
      if (senderId && senderId !== selfId && botIds.has(senderId)) {
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "ignored-peer-bot", reason: `sender is another bot account ${senderId}` });
        return;
      }
      accountState.lastRawMessageAt = Date.now();
      let mentioned = config.trigger?.replyToAt !== false && messageMentionsSelf(event, text0);
      const inboundKey = stableMessageFingerprint(event, text0);
      let activeMessageAccount = accountState.id === activeAccountId;
      let sendWs = ws;

      if (!activeMessageAccount) {
        if (!isPrivate && activeOneBotWs?.readyState !== 1) {
          const previousActiveAccountId = activeAccountId;
          if (switchActiveAccount(accountState.id, `active account ${previousActiveAccountId} websocket unavailable; ${accountState.id} received message`, { force: true })) {
            activeMessageAccount = true;
            sendWs = ws;
            announceAccountSwitchToGroup(
              groupId,
              accountById(config, previousActiveAccountId) || { id: previousActiveAccountId },
              accountById(config, activeAccountId) || { id: activeAccountId },
              `active account ${previousActiveAccountId} websocket unavailable`
            );
          }
        }
      }

      if (!activeMessageAccount) {
        const obs = observabilityConfig();
        if (!obs.standbyReadBackfill || isPrivate) {
          runtimeStatus.inactiveIgnoredMessageCount += 1;
          if (obs.logInactiveAccountMessages) {
            logIncomingMessage({
              accountState,
              event,
              text0,
              senderName,
              disposition: "ignored-inactive",
              reason: isPrivate ? "inactive private account" : `active=${activeAccountId}`
            });
          }
          return;
        }
        await sleep(obs.standbyBackfillGraceMs);
        pruneRecentInbound();
        const activeSeen = recentInboundMessages.get(inboundKey);
        if (activeSeen) {
          runtimeStatus.duplicateMessageCount += 1;
          logIncomingMessage({
            accountState,
            event,
            text0,
            senderName,
            disposition: "duplicate",
            reason: `already seen by ${activeSeen.account || "another account"}`
          });
          return;
        }
        if (activeOneBotWs?.readyState !== 1) {
          runtimeStatus.inactiveIgnoredMessageCount += 1;
          logIncomingMessage({
            accountState,
            event,
            text0,
            senderName,
            disposition: "ignored-inactive",
            reason: "active websocket unavailable for sending"
          });
          return;
        }
        sendWs = activeOneBotWs;
        markInboundSeen(inboundKey, { account: accountState.id, backfill: true });
        accountState.lastMessageAt = Date.now();
        accountState.lastBackfillMessageAt = accountState.lastMessageAt;
        runtimeStatus.standbyBackfillMessageCount += 1;
        logIncomingMessage({
          accountState,
          event,
          text0,
          senderName,
          disposition: "accepted-backfill",
          reason: `active ${activeAccountId} did not deliver within ${obs.standbyBackfillGraceMs}ms`
        });
      } else {
        const previous = markInboundSeen(inboundKey, { account: accountState.id, backfill: false });
        if (previous) {
          runtimeStatus.duplicateMessageCount += 1;
          logIncomingMessage({
            accountState,
            event,
            text0,
            senderName,
            disposition: "duplicate",
            reason: `already seen by ${previous.account || "another account"}`
          });
          return;
        }
        accountState.lastMessageAt = Date.now();
        accountState.lastAcceptedMessageAt = accountState.lastMessageAt;
        runtimeStatus.activeMessageCount += 1;
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "accepted" });
      }
      runtimeStatus.oneBotMessageCount += 1;
      runtimeStatus.lastOneBotMessageAt = Date.now();
      runtimeStatus.lastOneBotMessagePreview = clampText(`${conversationLabelFromEvent(event)} ${senderName}: ${text0 || "[非文本消息]"}`, 220);

      if (!isPrivate && !shouldHandleGroup(event.group_id, config)) {
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "skipped", reason: `group not targeted ${groupId}` });
        warn(`ignored group message from group_id=${groupId}; targetGroups=${targetGroupsDescription(config)}`);
        return;
      }
      if (isPrivate && !shouldHandlePrivate(senderId, config)) {
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "skipped", reason: `private not targeted ${senderId}` });
        warn(`ignored private message from user_id=${senderId}`);
        return;
      }
      if (!isPrivate && pendingAccountSwitchGroupNotice) {
        if (config.accounts?.failover?.announceInGroups === false) {
          pendingAccountSwitchGroupNotice = null;
        } else {
          const notice = pendingAccountSwitchGroupNotice;
          const maxAgeMs = Math.max(60_000, Number(config.accounts?.failover?.groupNoticeActiveWindowMs || 6 * 60 * 60_000));
          if (Date.now() - Number(notice.createdAt || 0) > maxAgeMs) {
            pendingAccountSwitchGroupNotice = null;
          } else if (announceAccountSwitchToGroup(groupId, notice.previousAccount, notice.nextAccount, notice.reason)) {
            pendingAccountSwitchGroupNotice = null;
          }
        }
      }
      if (config.trigger?.ignoreOwnMessages !== false && selfId && senderId === selfId) {
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "skipped", reason: "own message" });
        return;
      }

      if (await handleOwnerPrivateControlCommand({ ws: sendWs, event, text })) return;

      if (await handleBotCommand({ ws: sendWs, event, text, config, memory })) return;

      if (await handleTaskControl({ taskRuntime, ws: sendWs, event, text, config, memory })) return;

      repairInvalidQuietUntil(memory, groupId);
      let quietActive = false;
      if (!isPrivate && isQuiet(memory, groupId)) {
        const until = quietUntil(memory, groupId);
        const untilText = Number.isFinite(until) && until > 0 ? new Date(until).toISOString() : "invalid";
        quietActive = true;
        log(`quiet collect-only group=${groupId} until=${untilText}`);
      }

      const initialTiming = messageTiming(event, { receivedAt: event.__receivedAt });
      const rawCoordinatorDirect = Boolean(
        isPrivate
        || mentioned
        || (config.trigger?.replyToKeywords !== false && hasKeyword(text, config))
        || extractReplyMessageIds(rawMessagePayload).length > 0
      );
      const rawReplyObservation = quietActive ? { absorbed: false } : replyCoordinator.observeMessage({
        conversationId: groupId,
        senderId,
        current: {
          sender: senderName,
          user_id: senderId,
          text: redactSensitive(text || text0 || "[空消息]", config),
          at: initialTiming.sentAtMs,
          sentAt: initialTiming.sentAt,
          sentAtMs: initialTiming.sentAtMs,
          receivedAt: initialTiming.receivedAt,
          isPrivate,
          messageIds: [asStringId(event.message_id)].filter(Boolean),
          replyContexts: []
        },
        event,
        messageIds: [asStringId(event.message_id)].filter(Boolean),
        direct: rawCoordinatorDirect
      });
      let sourceMessages = [{
        event,
        text,
        rawText: text0,
        senderName,
        at: initialTiming.sentAtMs,
        sentAt: initialTiming.sentAt,
        sentAtMs: initialTiming.sentAtMs,
        receivedAt: initialTiming.receivedAt
      }];
      if (!quietActive) {
        const debounced = await enqueueDebouncedMessage({
          event,
          conversationId: groupId,
          senderId,
          senderName,
          text,
          rawText: text0,
          mentioned,
          isPrivate,
          config
        });
        if (debounced.skip) {
          logIncomingMessage({ accountState, event, text0, senderName, disposition: "debounced", reason: debounced.reason || "waiting for more input" });
          return;
        }
        sourceMessages = debounced.messages?.length ? debounced.messages : sourceMessages;
        event = debounced.event || event;
        rawMessagePayload = event.message || event.raw_message;
        text0 = debounced.rawText || text0;
        text = debounced.text || text;
        mentioned = config.trigger?.replyToAt !== false && sourceMessages.some((item) => messageMentionsSelf(item.event || event, item.rawText || item.text || ""));
      }

      const sourcePayloads = sourceMessages.map((item) => item.event?.message || item.event?.raw_message || item.rawText || "");
      const currentImageRefs = sourceMessages.flatMap((item, sourceIndex) => extractImageRefs(sourcePayloads[sourceIndex], {
        source: "current",
        messageId: asStringId(item.event?.message_id),
        includeImageEmojis: config.vision?.includeImageEmojis !== false
      }));
      const quotedMessages = await resolveQuotedMessages({
        messages: sourcePayloads,
        config,
        botIds: [...botIds, selfId],
        getMessage: async (messageId) => oneBotRequest(ws, "get_msg", { message_id: Number(messageId) || messageId }, { timeoutMs: Number(config.vision?.downloadTimeoutMs || 15000) })
      });
      const imageRefs = normalizeImageRefIndexes([...currentImageRefs, ...quotedMessages.refs]);
      const quotedBot = quotedMessages.contexts.some((ctx) => ctx.isBot);
      if (quotedBot) mentioned = true;
      const visualQuestion = imageRefs.length > 0 && wantsVisionRequest([text, text0, ...quotedMessages.texts].filter(Boolean).join("\n"));
      const keyword = (config.trigger?.replyToKeywords !== false && hasKeyword(text, config)) || visualQuestion;

      if (!text && !mentioned && !imageRefs.length) return;

      const history = historyByGroup.get(groupId) || [];
      const provisionalCurrent = {
        sender: senderName,
        user_id: senderId,
        text: redactSensitive(text || text0 || "[空消息]", config),
        at: Number(sourceMessages.at(-1)?.sentAtMs || sourceMessages.at(-1)?.at || Date.now()),
        sentAt: sourceMessages.at(-1)?.sentAt || new Date(Number(sourceMessages.at(-1)?.at || Date.now())).toISOString(),
        sentAtMs: Number(sourceMessages.at(-1)?.sentAtMs || sourceMessages.at(-1)?.at || Date.now()),
        receivedAt: sourceMessages.at(-1)?.receivedAt || "",
        isPrivate,
        messageIds: sourceMessages.map((item) => asStringId(item.event?.message_id)).filter(Boolean),
        replyContexts: quotedMessages.contexts
      };
      const coordinatorDirect = Boolean(rawCoordinatorDirect || keyword || quotedBot);
      const visionContext = imageRefs.length
        ? detectVisionConversationContext({
            history,
            current: provisionalCurrent,
            lastBotMessage: lastBotMessageByGroup.get(groupId),
            config
          })
        : { matched: false, strong: false, reason: "no images", messagesAfterBot: 999 };

      const imageDescriptions = await maybeDescribeImages({
        imageRefs,
        text: text || text0,
        mentioned,
        keyword,
        isPrivate,
        config,
        history,
        current: provisionalCurrent,
        quotedTexts: quotedMessages.texts,
        visionContext,
        helpers: {
          getImageUrl: async (ref) => {
            if (!ref?.file) return "";
            const data = await oneBotRequest(ws, "get_image", { file: ref.file }, { timeoutMs: Number(config.vision?.downloadTimeoutMs || 15000) });
            const keys = Object.keys(data || {});
            log(`vision get_image ${imageRefDisplayName(ref)} keys=${keys.join(",")} hasUrl=${Boolean(data?.url)} hasFile=${Boolean(data?.file)}`);
            return data.url || data.file || data.file_path || data.path || data.filename || "";
          }
        }
      });
      const currentText = appendImageDescriptions(redactSensitive(text || text0 || "[空消息]", config), imageDescriptions);

      const current = {
        sender: senderName,
        user_id: senderId,
        text: currentText || "[空消息]",
        at: Number(sourceMessages.at(-1)?.sentAtMs || sourceMessages.at(-1)?.at || Date.now()),
        sentAt: sourceMessages.at(-1)?.sentAt || new Date(Number(sourceMessages.at(-1)?.at || Date.now())).toISOString(),
        sentAtMs: Number(sourceMessages.at(-1)?.sentAtMs || sourceMessages.at(-1)?.at || Date.now()),
        receivedAt: sourceMessages.at(-1)?.receivedAt || "",
        processedAt: now(),
        isPrivate,
        images: imageDescriptions,
        messageIds: sourceMessages.map((item) => asStringId(item.event?.message_id)).filter(Boolean),
        replyContexts: quotedMessages.contexts
      };
      const archivedSourceTexts = [];
      for (const source of sourceMessages) {
        const sourceEvent = source.event || event;
        const sourceMessageId = asStringId(sourceEvent?.message_id);
        const sourceReplyIds = extractReplyMessageIds(sourceEvent?.message || sourceEvent?.raw_message || source.rawText || "");
        const sourceReplyContexts = quotedMessages.contexts.filter((ctx) => sourceReplyIds.includes(asStringId(ctx.messageId)));
        const sourceRefs = imageRefs.filter((ref) => (
          (ref.source === "current" && asStringId(ref.messageId) === sourceMessageId)
          || (ref.source === "quoted" && sourceReplyIds.includes(asStringId(ref.messageId)))
        ));
        const sourceDescriptions = imageDescriptions.filter((description) => sourceRefs.some((ref) => Number(ref.index) === Number(description.index)));
        const sourceText = appendImageDescriptions(redactSensitive(source.text || source.rawText || "[空消息]", config), sourceDescriptions);
        archivedSourceTexts.push({ source, text: sourceText || "[空消息]" });
        archiveConversationEvent({
          event: sourceEvent,
          config,
          memory,
          text: sourceText || "[空消息]",
          rawText: source.rawText || source.text || "",
          senderName: source.senderName || senderName,
          accountId: accountState.id,
          imageRefs: sourceRefs,
          imageDescriptions: sourceDescriptions,
          replyContexts: sourceReplyContexts
        });
      }
      history.push(current);
      history.sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
      while (history.length > Number(config.history?.rawMaxMessages || config.history?.maxMessages || 120)) history.shift();
      historyByGroup.set(groupId, history);
      lastEventByGroup.set(groupId, { ...event, __current: current });

      for (const archived of archivedSourceTexts) {
        const sourceEvent = archived.source.event || event;
        updateMemoryFromMessage(memory, sourceEvent, archived.source.senderName || senderName, archived.text, config);
        addPendingMemoryMessage(memory, sourceEvent, archived.source.senderName || senderName, archived.text, config);
        applyConversationFeedback(memory, groupId, archived.text, config);
      }
      summarizeOlderHistory(memory, groupId, history, config);
      saveMemory(memory);
      maybeUpdateMemoryWithAI({ memory, event, config });

      if (quietActive) {
        logIncomingMessage({ accountState, event, text0, senderName, disposition: "collected-quiet", reason: "quiet mode: archived and analyzed without replying" });
        return;
      }

      const observedReply = replyCoordinator.observeMessage({
        conversationId: groupId,
        senderId,
        current,
        event,
        messageIds: current.messageIds,
        direct: coordinatorDirect
      });
      if ((rawReplyObservation.absorbed || observedReply.absorbed) && !observedReply.saturatedJobId) {
        log(`reply coordinator absorbed ${conversationLabelFromEvent(event)} sender=${senderId} job=${observedReply.jobId || rawReplyObservation.jobId || "unknown"}`);
        return;
      }

      let behaviorConfig = applyBehaviorMode(config, memory, groupId);
      const activeAccount = accountById(config, activeAccountId);
      if (activeAccount?.role === "standby") {
        behaviorConfig = applyExplicitBehaviorMode(behaviorConfig, activeAccount.behaviorMode || "normal");
      }
      const decisionHistory = orderedHistory([
        ...history,
        ...pendingDebouncedContext(groupId, senderId)
      ]);
      const taskDecision = await judgeTaskIntent({ text: current.text, event, history: decisionHistory, config });
      if (taskDecision.matched) {
        const actor = taskActorFromEvent(event, config);
        const existingTask = taskRuntime.activeForConversation(groupId);
        const taskCfg = taskModeConfig(config);
        if (taskCfg.shadowMode) {
          log(`task shadow decision group=${groupId} confidence=${taskDecision.confidence.toFixed(2)} summary=${JSON.stringify(taskDecision.summary)}`);
        } else if (!existingTask) {
          const task = taskRuntime.createOffer({
            conversationId: groupId,
            messageType: event.message_type,
            groupId: event.message_type === "group" ? event.group_id : "",
            userId: senderId,
            senderName,
            objective: current.text,
            summary: taskDecision.summary,
            requestedTools: taskDecision.requestedTools,
            expectedArtifacts: taskDecision.expectedArtifacts,
            complexity: taskDecision.complexity,
            reasoningEffort: taskDecision.reasoningEffort,
            requiresLocalFiles: taskDecision.requiresLocalFiles,
            requiresComputer: taskDecision.requiresComputer,
            requiresAuthenticatedBrowser: taskDecision.requiresAuthenticatedBrowser,
            permissionTier: actor.owner ? "owner" : "isolated"
          });
          log(`task offer group=${groupId} task=${task.id} confidence=${taskDecision.confidence.toFixed(2)} shadow=false`);
          const offer = taskOfferText(task);
          sendGroupMessage(sendWs, event, offer, config, { reply: true });
          archiveBotReply({ event, config, memory, text: offer, meta: { source: "task-offer", user_id: selfId || "bot", replyToUserId: senderId, replyToSender: senderName } });
          return;
        }
      }
      const decisionContextBundle = config.reply?.useContextBundle === false
        ? null
        : buildContextBundle({ memory, groupId, history: decisionHistory, current, config });
      const decisionArchiveContext = buildArchiveContext({
        event,
        current,
        history: decisionHistory,
        memory,
        groupId,
        config,
        mode: "decision"
      });
      const webSearchCandidate = detectWebSearchRequest(text, config, {
        history: decisionHistory,
        current,
        mentioned,
        keyword,
        isPrivate
      });
      const webSearchDecision = await judgeWebSearchWithAI(webSearchCandidate, {
        text,
        history: decisionHistory,
        current,
        config
      });
      const webSearch = webSearchDecision.matched;
      if (webSearchCandidate.matched && !webSearch) {
        log(`web search candidate skipped group=${groupId} reason=${webSearchDecision.reason || "ai judge skipped"} query=${JSON.stringify(webSearchDecision.query || webSearchCandidate.query || "").slice(0, 120)}`);
      }
      const implicitDecision = !isPrivate && !mentioned && !keyword && !webSearch
        ? detectImplicitReplyToBot({
            history: decisionHistory,
            current,
            lastBotMessage: lastBotMessageByGroup.get(groupId),
            config: behaviorConfig
          })
        : { matched: false, confidence: 0, reason: "" };
      let implicit = behaviorConfig.implicitReply?.enabled !== false && implicitDecision.matched;
      let active = false;
      let socialApplied = false;
      let socialDecision = null;
      const discussionDecision = !isPrivate && !mentioned && !keyword && !webSearch
        ? detectDiscussionSignal({ history: decisionHistory, current, config: behaviorConfig })
        : { matched: false, reason: "direct or tool-triggered message" };
      const nowMs = Date.now();

      if (!isPrivate && !mentioned && !keyword && !webSearch) {
        const plannerCfg = socialPlannerConfig(behaviorConfig);
        const plannerCandidate = implicitDecision.confidence >= plannerCfg.minCandidateConfidence
          || discussionDecision.matched
          || (decisionArchiveContext.used && (asArray(current.replyContexts).length > 0 || current.text.length <= 80));
        if (plannerCfg.enabled && plannerCandidate) {
          const candidateReason = [
            implicitDecision.confidence >= plannerCfg.minCandidateConfidence ? `implicit=${implicitDecision.confidence.toFixed(2)}` : "",
            discussionDecision.matched ? `discussion=${discussionDecision.reason}` : ""
          ].filter(Boolean).join("; ");
          socialDecision = await judgeSocialActionWithAI({
            history: decisionHistory,
            current,
            lastBotMessage: lastBotMessageByGroup.get(groupId),
            implicitDecision,
            discussionDecision,
            memory,
            groupId,
            config: behaviorConfig,
            contextBundle: decisionContextBundle,
            archiveContext: decisionArchiveContext.text || ""
          });
          rememberSocialDecision(socialDecision, { groupId, senderId, candidateReason }, behaviorConfig);
          log(`social planner group=${groupId} sender=${senderId} action=${socialDecision.action} requested=${socialDecision.requestedAction} confidence=${socialDecision.confidence.toFixed(2)} shadow=${plannerCfg.shadowMode} reason=${socialDecision.reason || "none"}`);
          if (!plannerCfg.shadowMode) {
            socialApplied = true;
            if (socialDecision.action === "wait") {
              scheduleDelayedUnderstandingReply({
                pendingByGroup: delayedUnderstandingByGroup,
                replyCoordinator,
                ws: sendWs,
                event,
                groupId,
                current,
                senderName,
                senderId,
                selfId,
                config: behaviorConfig,
                memory,
                historyByGroup,
                lastBotMessageByGroup,
                reason: `social planner: ${socialDecision.reason || "wait"}`
              });
              return;
            }
            if (socialDecision.action !== "reply") return;
            implicit = socialDecision.intent === "followup" || socialDecision.intent === "reaction";
            active = !implicit;
            current.socialDecision = socialDecision;
            if (active) {
              const discussionCfg = behaviorConfig.discussionParticipation || {};
              const cooldown = Number(discussionCfg.activeCooldownMs || behaviorConfig.trigger?.activeCooldownMs || 120000);
              const last = lastActiveReplyAt.get(groupId) || 0;
              if (nowMs - last < cooldown) {
                log(`social planner observe group=${groupId} reason=active cooldown remainingMs=${cooldown - (nowMs - last)}`);
                return;
              }
              lastActiveReplyAt.set(groupId, nowMs);
            }
          }
        } else if (plannerCfg.enabled && !plannerCfg.shadowMode) {
          return;
        }
      }

      if (!socialApplied && !isPrivate && !mentioned && !keyword && !implicit && !webSearch && behaviorConfig.trigger?.activeReply) {
        const last = lastActiveReplyAt.get(groupId) || 0;
        const discussionCfg = behaviorConfig.discussionParticipation || {};
        const baseProbability = Number(behaviorConfig.trigger?.activeProbability || 0);
        const boostedProbability = discussionDecision.matched
          ? Math.min(
              Number(discussionCfg.maxActiveProbability || 0.65),
              baseProbability + Number(discussionCfg.activeProbabilityBoost || 0)
            )
          : baseProbability;
        const cooldown = discussionDecision.matched
          ? Number(discussionCfg.activeCooldownMs || behaviorConfig.trigger?.activeCooldownMs || 120000)
          : Number(behaviorConfig.trigger?.activeCooldownMs || 120000);
        active = nowMs - last >= cooldown && Math.random() < boostedProbability;
        if (!active) {
          const delayed = detectDelayedUnderstandingCandidate({
            history: decisionHistory,
            current,
            implicitDecision,
            discussionDecision,
            config: behaviorConfig
          });
          if (delayed.matched) {
            scheduleDelayedUnderstandingReply({
              pendingByGroup: delayedUnderstandingByGroup,
              replyCoordinator,
              ws: sendWs,
              event,
              groupId,
              current,
              senderName,
              senderId,
              selfId,
              config: behaviorConfig,
              memory,
              historyByGroup,
              lastBotMessageByGroup,
              reason: delayed.reason
            });
          }
          return;
        }
        const skip = shouldSkipProactiveReply({ history: decisionHistory, current, memory, groupId, config: behaviorConfig });
        if (skip.skip) {
          log(`active skip group=${groupId} reason=${skip.reason}${discussionDecision.matched ? ` discussion=${discussionDecision.reason}` : ""}`);
          return;
        }
        if (discussionDecision.matched) log(`active discussion boost group=${groupId} probability=${boostedProbability.toFixed(2)} reason=${discussionDecision.reason}`);
        lastActiveReplyAt.set(groupId, nowMs);
      }

      const mode = webSearch ? "web" : isPrivate ? "private" : mentioned ? "at" : keyword ? "keyword" : implicit ? "implicit" : "active";
      log(`handling ${conversationLabelFromEvent(event)} sender=${senderName} mode=${mode}${isPrivate && isPrivateOwner(senderId, config) ? " ownerPrivate=true" : ""}${webSearch ? ` query=${JSON.stringify(webSearchDecision.query).slice(0, 120)}` : ""}${implicit ? ` confidence=${implicitDecision.confidence.toFixed(2)} reason=${implicitDecision.reason}` : ""} text=${JSON.stringify(text).slice(0, 160)}`);

      replyCoordinator.enqueue({
        conversationId: groupId,
        senderId,
        mode,
        direct: coordinatorDirect,
        currentMessages: [current],
        messageIds: current.messageIds,
        event,
        webSearchDecision,
        execute: async ({ job, signal, revision }) => {
          const effectiveCurrent = mergeReplyCurrents(job.currentMessages, current);
          const effectiveEvent = job.event || event;
          const effectiveSenderName = effectiveCurrent.sender || senderName;
          const latestHistory = orderedHistory([
            ...(historyByGroup.get(groupId) || []),
            ...pendingDebouncedContext(groupId, senderId)
          ]);
          try {
            if (isQuiet(memory, groupId) || sendWs.readyState !== 1) return { sent: false, skipped: true };
            if (signal.aborted) throw Object.assign(new Error("reply generation aborted"), { name: "AbortError" });
            let effectiveSearchDecision = job.webSearchDecision || webSearchDecision;
            let effectiveWebSearch = job.mode === "web" || effectiveSearchDecision?.matched === true;
            if (Number(job.contextRevision || 0) > 0) {
              const candidate = detectWebSearchRequest(effectiveCurrent.text, config, {
                history: latestHistory,
                current: effectiveCurrent,
                mentioned: job.direct,
                keyword: job.mode === "keyword",
                isPrivate
              });
              effectiveSearchDecision = await judgeWebSearchWithAI(candidate, {
                text: effectiveCurrent.text,
                history: latestHistory,
                current: effectiveCurrent,
                config
              });
              effectiveWebSearch = effectiveSearchDecision.matched === true;
            }
            if (effectiveWebSearch && !job.preReplySent) {
              const preReply = webSearchPreReply(effectiveSearchDecision, config);
              if (preReply) {
                sendGroupMessage(sendWs, effectiveEvent, preReply, config, { reply: config.webSearch?.preReply?.replyToMessage !== false });
                archiveBotReply({ event: effectiveEvent, config, memory, text: preReply, meta: { source: "web-pre-reply", user_id: selfId || "bot", replyToUserId: senderId, replyToSender: effectiveSenderName } });
                recordBotMessage({
                  historyByGroup,
                  lastBotMessageByGroup,
                  groupId,
                  text: preReply,
                  config,
                  memory,
                  meta: { source: "web-pre-reply", user_id: selfId || "bot", replyToUserId: senderId, replyToSender: effectiveSenderName }
                });
              }
              job.preReplySent = true;
            }
            const contextBundle = config.reply?.useContextBundle === false
              ? null
              : buildContextBundle({ memory, groupId, history: latestHistory, current: effectiveCurrent, config });
            const memoryText = compactMemory(memory, groupId, config, senderId);
            const archiveContext = buildArchiveContext({ event: effectiveEvent, current: effectiveCurrent, history: latestHistory, memory, groupId, config, mode: effectiveWebSearch ? "web" : job.mode });
            const webSearchBuilt = effectiveWebSearch ? await buildWebSearchContext(effectiveSearchDecision, config) : { text: "", result: null };
            if (signal.aborted || Number(job.contextRevision || 0) !== revision) return { retry: true };
            const webSearchContext = webSearchBuilt.text || "";
            const prompt = buildPrompt({
              config,
              history: latestHistory,
              current: effectiveCurrent,
              mode: effectiveWebSearch ? "web" : isPrivate ? "private" : job.mode === "active" ? "proactive" : job.mode === "implicit" ? "implicit" : "reply",
              memoryText,
              contextBundle,
              webSearchContext,
              archiveContext: archiveContext.text || ""
            });
            const response = trimForGroup(await callHermes(prompt, config, { signal }), config);
            if (signal.aborted || Number(job.contextRevision || 0) !== revision) return { retry: true };
            if (isQuiet(memory, groupId) || sendWs.readyState !== 1) return { sent: false, skipped: true };
            if (response === "__SKIP__" && config.reply?.allowSkip !== false) return { sent: false, skipped: true };
            if (!response) return { sent: false, skipped: true };
            sendGroupMessage(sendWs, effectiveEvent, response, config, { reply: job.direct || (job.mode === "implicit" && behaviorConfig.implicitReply?.replyToMessage !== false) });
            archiveBotReply({ event: effectiveEvent, config, memory, text: response, meta: { source: effectiveWebSearch ? "web" : job.mode, user_id: selfId || "bot", replyToUserId: senderId, replyToSender: effectiveSenderName, coveredMessageIds: job.messageIds, mentionedUserIds: relatedUserIdsFromText(response, groupMemory(memory, groupId)) } });
            if (effectiveWebSearch) {
              archiveWebSearchResult({ event: effectiveEvent, config, memory, decision: effectiveSearchDecision, searchResult: webSearchBuilt.result || {}, contextText: webSearchContext, usedConclusion: response });
            }
            recordBotMessage({
              historyByGroup,
              lastBotMessageByGroup,
              groupId,
              text: response,
              config,
              memory,
              meta: { source: effectiveWebSearch ? "web" : job.mode, user_id: selfId || "bot", replyToUserId: senderId, replyToSender: effectiveSenderName, coveredMessageIds: job.messageIds, mentionedUserIds: relatedUserIdsFromText(response, groupMemory(memory, groupId)) }
            });
            return { sent: true, coveredMessageIds: job.messageIds };
          } catch (err) {
            if (signal.aborted || err?.name === "AbortError") throw err;
            warn(`AI reply failed: ${err.message}`);
            if (isPrivate && isPrivateOwner(senderId, config)) {
              const reason = clampText(redactSensitive(err.message, config), 140);
              sendGroupMessage(sendWs, effectiveEvent, `收到，但我刚才生成回复失败了：${reason || "未知错误"}\n我这边不会再静默吞消息，你可以直接再发一次，或者去管理页测一下模型接口。`, config, { reply: true });
              return { sent: true, fallback: true };
            }
            return { sent: false, error: err.message };
          }
        }
      });
    });

    ws.on("close", () => {
      const accountId = wsAccountIds.get(ws);
      const accountState = accountId ? oneBotAccounts.get(accountId) : null;
      if (accountState?.ws === ws) {
        accountState.connected = false;
        accountState.readyState = ws.readyState;
        accountState.lastDisconnectedAt = Date.now();
        accountState.ws = null;
      }
      wsAccountIds.delete(ws);
      if (activeOneBotWs === ws) {
        activeOneBotWs = null;
        const cfg = accountFailoverConfig(config);
        const standby = cfg.standbys.find((account) => accountConnected(account.id));
        if (standby && accountId === cfg.primary.id) switchActiveAccount(standby.id, "primary websocket closed");
      }
      runtimeStatus.lastOneBotDisconnectedAt = Date.now();
      for (const [echo, pending] of pendingOneBotActions) {
        pendingOneBotActions.delete(echo);
        pending.reject(new Error("onebot websocket closed"));
      }
      for (const [echo, tracker] of oneBotSendTrackers) {
        oneBotSendTrackers.delete(echo);
        clearTimeout(tracker.timer);
      }
      log(`OneBot disconnected account=${accountId || "unknown"}`);
      checkAdminStatusNotification({ force: true });
    });

    if (config.proactive?.enabled) {
      const intervalMs = Number(config.proactive.intervalMs || 900000);
      const timer = setInterval(async () => {
        if (ws.readyState !== 1 || !withinActiveHours(config)) return;
        const groupsForProactive = handlesAllGroups(config)
          ? Array.from(lastEventByGroup.keys()).filter((id) => !String(id).startsWith("private:"))
          : targetGroups(config);
        for (const groupId of groupsForProactive) {
          const lastEvent = lastEventByGroup.get(String(groupId));
          const history = historyByGroup.get(String(groupId)) || [];
          if (!lastEvent || history.length === 0) continue;
          if (isQuiet(memory, groupId)) continue;
          let behaviorConfig = applyBehaviorMode(config, memory, groupId);
          const activeAccount = accountById(config, activeAccountId);
          if (activeAccount?.role === "standby") {
            behaviorConfig = applyExplicitBehaviorMode(behaviorConfig, activeAccount.behaviorMode || "normal");
          }
          const nowMs = Date.now();
          const lastHistoryItem = history.at(-1);
          if (behaviorConfig.proactive?.requireHumanAfterBot !== false && lastHistoryItem?.isBot) {
            continue;
          }
          const current = lastNonBotMessage(history);
          if (!current) continue;
          const lastMessageAt = current.at || 0;
          const discussion = detectDiscussionSignal({ history, current, config: behaviorConfig });
          const discussionCfg = behaviorConfig.discussionParticipation || {};
          const proactiveCooldown = discussion.matched
            ? Number(discussionCfg.proactiveCooldownMs || behaviorConfig.proactive.cooldownMs || 900000)
            : Number(behaviorConfig.proactive.cooldownMs || 900000);
          const proactiveProbability = discussion.matched
            ? Math.min(
                Number(discussionCfg.maxProactiveProbability || 0.75),
                Number(behaviorConfig.proactive.probability || 0.35) + Number(discussionCfg.proactiveProbabilityBoost || 0)
              )
            : Number(behaviorConfig.proactive.probability || 0.35);
          if (nowMs - lastMessageAt > Number(behaviorConfig.proactive.activeWindowMs || 1800000)) continue;
          if (nowMs - (lastProactiveAt.get(String(groupId)) || 0) < proactiveCooldown) continue;
          const plannerCfg = socialPlannerConfig(behaviorConfig);
          if ((!plannerCfg.enabled || plannerCfg.shadowMode) && Math.random() >= proactiveProbability) continue;
          const skip = shouldSkipProactiveReply({ history, current, memory, groupId, config: behaviorConfig });
          if (skip.skip) {
            log(`proactive skip group=${groupId} reason=${skip.reason}${discussion.matched ? ` discussion=${discussion.reason}` : ""}`);
            continue;
          }
          let proactiveCurrent = current;
          if (plannerCfg.enabled) {
            const socialDecision = await judgeSocialActionWithAI({
              history,
              current,
              lastBotMessage: lastBotMessageByGroup.get(String(groupId)),
              implicitDecision: { matched: false, confidence: 0, reason: "scheduled proactive check" },
              discussionDecision: discussion,
              memory,
              groupId,
              config: behaviorConfig
            });
            rememberSocialDecision(socialDecision, { groupId, senderId: current.user_id, candidateReason: "scheduled proactive" }, behaviorConfig);
            log(`social planner proactive group=${groupId} action=${socialDecision.action} confidence=${socialDecision.confidence.toFixed(2)} shadow=${plannerCfg.shadowMode} reason=${socialDecision.reason || "none"}`);
            if (!plannerCfg.shadowMode && socialDecision.action !== "reply") continue;
            if (!plannerCfg.shadowMode) proactiveCurrent = { ...current, socialDecision: { ...socialDecision, intent: "proactive" } };
          }
          if (discussion.matched) log(`proactive discussion boost group=${groupId} probability=${proactiveProbability.toFixed(2)} reason=${discussion.reason}`);
          lastProactiveAt.set(String(groupId), nowMs);
          replyCoordinator.enqueue({
            conversationId: groupId,
            senderId: proactiveCurrent.user_id,
            mode: "proactive",
            direct: false,
            currentMessages: [proactiveCurrent],
            messageIds: proactiveCurrent.messageIds,
            event: lastEvent,
            execute: async ({ job, signal, revision }) => {
              const latestHistory = historyByGroup.get(String(groupId)) || [];
              const effectiveCurrent = mergeReplyCurrents(job.currentMessages, proactiveCurrent);
              const contextBundle = config.reply?.useContextBundle === false
                ? null
                : buildContextBundle({ memory, groupId, history: latestHistory, current: effectiveCurrent, config });
              const prompt = buildPrompt({
                config,
                history: latestHistory,
                current: effectiveCurrent,
                mode: "proactive",
                memoryText: compactMemory(memory, groupId, config),
                contextBundle
              });
              const response = trimForGroup(await callHermes(prompt, config, { signal }), config);
              if (signal.aborted || Number(job.contextRevision || 0) !== revision) return { retry: true };
              if (response === "__SKIP__" && config.reply?.allowSkip !== false) return { sent: false, skipped: true };
              if (!response) return { sent: false, skipped: true };
              sendGroupMessage(ws, job.event || lastEvent, response, config, { reply: false });
              recordBotMessage({
                historyByGroup,
                lastBotMessageByGroup,
                groupId,
                text: response,
                config,
                memory,
                meta: {
                  source: "proactive",
                  user_id: lastEvent.self_id || "bot",
                  coveredMessageIds: job.messageIds,
                  mentionedUserIds: relatedUserIdsFromText(response, groupMemory(memory, groupId))
                }
              });
              return { sent: true };
            }
          });
        }
      }, intervalMs);
      ws.on("close", () => clearInterval(timer));
    }

    if (config.dailyMessages?.enabled) {
      const timer = setInterval(() => {
        runDailyMessages({ ws, config, memory, historyByGroup, lastEventByGroup, lastBotMessageByGroup });
      }, Number(config.dailyMessages.checkIntervalMs || 60_000));
      runDailyMessages({ ws, config, memory, historyByGroup, lastEventByGroup, lastBotMessageByGroup });
      ws.on("close", () => clearInterval(timer));
    }

    // Hourly chat — send periodic private messages to bot owner
    const hourlyTimer = setInterval(() => {
      runHourlyChat({ ws, config });
    }, Number(config.hourlyChat?.checkIntervalMs || 60_000));
    ws.on("close", () => clearInterval(hourlyTimer));
  }

  wss.on("connection", (ws, req) => registerOneBotConnection(ws, req));

  const forwardOneBotRuntime = new Map();

  function snowlumaAccountWsUrl(account) {
    const rawUrl = String(account.onebotWsUrl || "ws://127.0.0.1:6301").trim() || "ws://127.0.0.1:6301";
    const token = readSnowLumaOneBotAccessToken(account, config);
    if (!token) return rawUrl;
    try {
      const parsed = new URL(rawUrl);
      if (!parsed.searchParams.get("access_token")) parsed.searchParams.set("access_token", token);
      return parsed.toString();
    } catch {
      const joiner = rawUrl.includes("?") ? "&" : "?";
      return `${rawUrl}${joiner}access_token=${encodeURIComponent(token)}`;
    }
  }

  function ensureForwardOneBotConnections() {
    const wanted = new Set();
    for (const account of configuredAccountDefinitions(config)) {
      if (accountProtocol(account) !== "snowluma") continue;
      wanted.add(account.id);
      if (account.enabled === false) continue;
      const existing = forwardOneBotRuntime.get(account.id) || {};
      if (existing.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(existing.ws.readyState)) continue;
      const nowMs = Date.now();
      if (existing.lastAttemptAt && nowMs - existing.lastAttemptAt < 10_000) continue;
      const url = snowlumaAccountWsUrl(account);
      const safeUrl = sanitizeUrlForLog(url);
      const runtime = {
        ...existing,
        accountId: account.id,
        url,
        lastAttemptAt: nowMs,
        lastError: "",
        connecting: true
      };
      forwardOneBotRuntime.set(account.id, runtime);
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        runtime.connecting = false;
        runtime.lastError = err.message;
        warn(`SnowLuma forward ws create failed account=${account.id} url=${safeUrl}: ${err.message}`);
        continue;
      }
      ws.__hermesPreferredAccountId = account.id;
      runtime.ws = ws;
      ws.on("open", () => {
        runtime.connecting = false;
        runtime.connectedAt = Date.now();
        runtime.lastError = "";
        log(`SnowLuma forward ws connected account=${account.id} url=${safeUrl}`);
        registerOneBotConnection(ws, { socket: { remoteAddress: `forward:${safeUrl}` } });
      });
      ws.on("close", () => {
        runtime.connecting = false;
        runtime.disconnectedAt = Date.now();
        if (runtime.ws === ws) runtime.ws = null;
        log(`SnowLuma forward ws closed account=${account.id} url=${safeUrl}`);
      });
      ws.on("error", (err) => {
        runtime.lastError = err.message;
        warn(`SnowLuma forward ws error account=${account.id} url=${safeUrl}: ${err.message}`);
      });
    }
    for (const [accountId, runtime] of forwardOneBotRuntime) {
      if (wanted.has(accountId)) continue;
      try {
        runtime.ws?.close();
      } catch {
        // Best effort only.
      }
      forwardOneBotRuntime.delete(accountId);
    }
  }

  setTimeout(() => ensureForwardOneBotConnections(), 3000);
  setInterval(() => ensureForwardOneBotConnections(), 15_000);

  log(`Hermes OneBot bridge listening: ws://${host}:${port}${routePath}`);
  log(`Target groups: ${targetGroupsDescription(config)}`);
  const protocolSummary = configuredAccountDefinitions(config)
    .map((account) => `${account.id}:${accountProtocolLabel(account)}`)
    .join(", ");
  log(`Configured OneBot protocol clients: ${protocolSummary || "none"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
