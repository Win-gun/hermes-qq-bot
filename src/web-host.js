import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as backup from "./backup-service.js";

const resourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = path.resolve(process.env.HERMES_QQ_HOME || path.join(os.homedir(), "Library", "Application Support", "Hermes QQ Bot"));
const backupRoot = path.resolve(process.env.HERMES_QQ_BACKUP_ROOT || path.join(os.homedir(), "Documents", "Hermes QQ Bot Backups"));
const logRoot = path.resolve(process.env.HERMES_QQ_LOG_DIR || path.join(stateRoot, "logs"));
const hermesHome = path.join(stateRoot, "hermes");
const configFile = path.join(stateRoot, "config.json");
const setupFile = path.join(stateRoot, ".setup-complete");
const MAX_JSON = 64 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const publicPort = Number(process.env.HERMES_QQ_CONTROL_PORT || readConfig()?.control?.port || 6200);
const desktopExecutable = process.env.HERMES_QQ_DESKTOP_EXE || "";
const webLaunchAgent = path.join(os.homedir(), "Library", "LaunchAgents", "com.eraser.hermesqqbot.web.plist");
const appLaunchAgent = path.join(os.homedir(), "Library", "LaunchAgents", "com.eraser.hermesqqbot.plist");
let server;
let child = null;
let childPort = 0;
let starting = null;
let intentionalStop = false;
let shuttingDown = false;
let retryTimer = null;
let retryDelay = 2000;
let operation = null;
let progress = null;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { return null; }
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function launchctl(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.env.HERMES_QQ_LAUNCHCTL || "/bin/launchctl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGTERM"), 10000);
    proc.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-600); });
    proc.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: stderr.trim() }); });
  });
}

function autoStartPath() { return desktopExecutable ? appLaunchAgent : webLaunchAgent; }

async function setAutoStart(enabled) {
  if (process.platform !== "darwin") throw new Error("登录自动启动目前只支持 macOS");
  const target = autoStartPath();
  const domain = `gui/${process.getuid()}`;
  if (!enabled) {
    await launchctl(["bootout", domain, target]);
    fs.rmSync(target, { force: true });
    return { ok: true, enabled: false };
  }
  const other = desktopExecutable ? webLaunchAgent : appLaunchAgent;
  if (fs.existsSync(other)) throw new Error("请先关闭另一入口的登录自动启动，避免同时接管 QQ");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const label = desktopExecutable ? "com.eraser.hermesqqbot" : "com.eraser.hermesqqbot.web";
  const program = desktopExecutable || process.execPath;
  const args = desktopExecutable ? [program, "--background"] : [program, path.join(resourceRoot, "src", "web-host.js")];
  const env = desktopExecutable ? {} : {
    HERMES_QQ_HOME: stateRoot,
    HERMES_QQ_LOG_DIR: logRoot,
    HERMES_QQ_BACKUP_ROOT: backupRoot,
    HERMES_QQ_CONTROL_PORT: String(publicPort),
    HERMES_HOME: hermesHome
  };
  const values = Object.entries(env).map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join("");
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${values}</dict><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xmlEscape(path.join(logRoot, "web-host.launchd.log"))}</string><key>StandardErrorPath</key><string>${xmlEscape(path.join(logRoot, "web-host.launchd.error.log"))}</string></dict></plist>\n`;
  const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
  fs.writeFileSync(target, contents, { mode: 0o600 });
  await launchctl(["bootout", domain, target]);
  const started = await launchctl(["bootstrap", domain, target]);
  if (!started.ok) {
    if (previous) {
      fs.writeFileSync(target, previous, { mode: 0o600 });
      await launchctl(["bootstrap", domain, target]);
    } else fs.rmSync(target, { force: true });
    throw new Error(`无法安装登录启动项：${started.error || "launchctl bootstrap failed"}`);
  }
  return { ok: true, enabled: true };
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function reply(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function errorMessage(error) {
  // Backup-service errors sometimes contain local paths; the browser needs a safe summary.
  if (error?.name === "BackupCancelledError") return "备份已取消";
  return "操作失败；请检查本机服务日志";
}

function publish(value) {
  progress = { ...value, updatedAt: new Date().toISOString() };
}

function fileForName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.hermesqqbackup$/.test(name) || name.includes("..")) throw new Error("invalid backup name");
  const file = path.join(backupRoot, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("not a regular backup file");
  return { file, stat };
}

function localHost(req) {
  const host = req.headers.host || "";
  return host === `127.0.0.1:${publicPort}` || host === `localhost:${publicPort}`;
}

function validOrigin(req) {
  if (!req.headers.origin) return true; // Non-browser local clients may omit Origin.
  try {
    const origin = new URL(req.headers.origin);
    return origin.protocol === "http:" && origin.host === req.headers.host && origin.pathname === "/";
  } catch { return false; }
}

async function jsonBody(req) {
  if (Number(req.headers["content-length"] || 0) > MAX_JSON) throw new Error("body too large");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_JSON) throw new Error("body too large");
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("invalid JSON"); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForChild(current, port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child === current && current.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("bridge did not become ready");
}

function scheduleRetry() {
  if (intentionalStop || shuttingDown || operation || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    startBridge().catch(() => scheduleRetry());
  }, retryDelay);
  retryTimer.unref();
  retryDelay = Math.min(retryDelay * 2, 30000);
}

async function startBridge(internal = false) {
  if (shuttingDown || (operation && !internal)) throw new Error("host is busy");
  if (child && child.exitCode === null) return { ok: true, alreadyRunning: true };
  if (starting) return starting;
  const config = readConfig();
  if (!config || config.control?.enabled === false) throw new Error("bridge configuration is missing or control API is disabled");
  if (!new Set(["127.0.0.1", "localhost"]).has(config.control?.host || "127.0.0.1")) throw new Error("bridge control host must be loopback");
  const oneBotPort = Number(config.listen?.port || 6199);
  if (!Number.isInteger(oneBotPort) || oneBotPort < 1 || oneBotPort > 65535 || !(await portAvailable(oneBotPort))) throw new Error(`OneBot port ${oneBotPort} is occupied or invalid`);
  intentionalStop = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  starting = (async () => {
    const port = await freePort();
    const env = {
      ...process.env,
      PATH: [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(path.delimiter),
      HERMES_QQ_HOME: stateRoot,
      HERMES_QQ_RESOURCE_ROOT: resourceRoot,
      HERMES_QQ_LOG_DIR: logRoot,
      HERMES_HOME: hermesHome,
      HERMES_QQ_MANAGED_VOLUMES: "1",
      HERMES_QQ_VOLUME_PREFIX: "hermes-qq-bot",
      HERMES_QQ_CONTROL_PORT: String(port),
      HERMES_QQ_INSTANCE_ID: process.env.HERMES_QQ_INSTANCE_ID || crypto.randomBytes(12).toString("hex")
    };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const current = spawn(process.execPath, [path.join(resourceRoot, "src", "bridge.js")], { cwd: stateRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child = current;
    childPort = port;
    const stdoutLog = fs.createWriteStream(path.join(logRoot, "bridge.log"), { flags: "a", mode: 0o600 });
    const stderrLog = fs.createWriteStream(path.join(logRoot, "bridge.error.log"), { flags: "a", mode: 0o600 });
    stdoutLog.on("error", () => {});
    stderrLog.on("error", () => {});
    current.stdout.pipe(stdoutLog);
    current.stderr.pipe(stderrLog);
    current.on("error", (error) => { console.error(`bridge process error: ${error.message}`); });
    current.on("exit", () => {
      stdoutLog.end();
      stderrLog.end();
      if (child === current) { child = null; childPort = 0; scheduleRetry(); }
    });
    try {
      await waitForChild(current, port);
      retryDelay = 2000;
      return { ok: true };
    } catch (error) {
      const shouldRetry = !intentionalStop && !shuttingDown && !operation;
      await stopBridge();
      if (shouldRetry) { intentionalStop = false; scheduleRetry(); }
      throw error;
    }
  })();
  try { return await starting; } finally { starting = null; }
}

async function stopBridge() {
  intentionalStop = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  const current = child;
  if (!current) return { ok: true, alreadyStopped: true };
  child = null;
  childPort = 0;
  if (current.exitCode !== null) return { ok: true };
  const closed = new Promise((resolve) => current.once("exit", resolve));
  current.kill("SIGTERM");
  const timer = setTimeout(() => current.kill("SIGKILL"), 5000);
  timer.unref();
  await closed;
  clearTimeout(timer);
  return { ok: true };
}

async function restoreBridge(wasRunning) {
  if (wasRunning && !shuttingDown) await startBridge(true);
}

async function resetRestoredAccounts(manifest) {
  for (const account of manifest.accounts || []) {
    if (!(manifest.dockerVolumes || []).some((volume) => volume.accountId === account.id)) continue;
    const response = await fetch(`http://127.0.0.1:${childPort}/api/accounts/${encodeURIComponent(account.id)}/login/reset`, { method: "POST", signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`restored protocol account did not start: ${account.id}`);
  }
}

function legacyProject(legacyPath) {
  if (typeof legacyPath !== "string" || !path.isAbsolute(legacyPath) || legacyPath.split(path.sep).includes("..")) throw new Error("invalid legacy path");
  const root = path.resolve(legacyPath);
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("invalid legacy path");
  const source = fs.realpathSync(root);
  const target = fs.realpathSync(stateRoot);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) throw new Error("invalid legacy path");
  let legacy;
  try { legacy = backup.inspectLegacyProject(root); }
  catch { throw new Error("invalid legacy path"); }
  // The migration service copies these trees. Reject links before it sees any of them.
  const inspectTree = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("invalid legacy path");
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) inspectTree(path.join(current, name));
  };
  for (const item of [legacy.configPath, path.join(root, "data"), ...legacy.protocolDirectories.map((name) => path.join(root, name))]) inspectTree(item);
  return { root, hasMemory: legacy.hasMemory, hasArchive: legacy.hasArchive, protocolDirectories: legacy.protocolDirectories };
}

async function childJson(route, method = "GET", timeout = 2500) {
  const response = await fetch(`http://127.0.0.1:${childPort}${route}`, { method, signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok) throw new Error("bridge verification failed");
  return value;
}

async function verifyMigratedAccounts(accounts) {
  if (!accounts.length) return;
  for (const account of accounts) {
    const result = await childJson(`/api/accounts/${encodeURIComponent(account.id)}/login/reset`, "POST", 120000);
    if (!result.ok) throw new Error("protocol account did not start");
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const health = await childJson("/health").catch(() => null);
    if (accounts.every((account) => {
      const found = health?.accounts?.find((item) => item.id === account.id);
      return found?.connected && found.actualQq && (!account.expectedQq || String(found.actualQq) === account.expectedQq);
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("migrated account identity verification failed");
}

async function migrateLocalLegacy(options) {
  if (operation) throw new Error("another host operation is running");
  const legacy = legacyProject(options.path);
  const wasRunning = Boolean(child);
  operation = { kind: "legacy-migrate" };
  publish({ status: "running", type: "legacy-migrate", stage: "prepare", percent: 0 });
  const domain = process.platform === "darwin" ? `gui/${process.getuid()}` : "";
  const agents = ["com.codex.qq-hermes-snowluma-bootstrap", "com.codex.qq-hermes-onebot-bridge"].map((label) => ({
    label, service: `${domain}/${label}`, plist: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
  }));
  const stopped = [];
  const disabled = [];
  let migrated;
  let success = false;
  try {
    await stopBridge();
    if (process.platform === "darwin") {
      for (const agent of agents) {
        const loaded = (await launchctl(["print", agent.service])).ok;
        if (!loaded) continue;
        if (!fs.existsSync(agent.plist)) throw new Error("loaded legacy agent has no plist for rollback");
        const result = await launchctl(["bootout", agent.service]);
        if (!result.ok) throw new Error("could not pause legacy agent");
        stopped.push(agent);
      }
    }
    const currentPort = Number(readConfig()?.listen?.port || 6199);
    const incomingPort = Number(JSON.parse(fs.readFileSync(path.join(legacy.root, "config.json"), "utf8")).listen?.port || 6199);
    if (!(await portAvailable(currentPort)) || !(await portAvailable(incomingPort))) throw new Error("OneBot port is occupied");
    publish({ status: "running", type: "legacy-migrate", stage: "migrate", percent: 45 });
    migrated = await backup.migrateLegacyProject({ projectRoot: legacy.root, stateRoot, legacyHermesHome: process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), hermesHome });
    await startBridge(true);
    const health = await childJson("/health");
    if (!health.generatedAt) throw new Error("bridge health verification failed");
    publish({ status: "running", type: "legacy-migrate", stage: "verify", percent: 85 });
    await verifyMigratedAccounts(migrated.accounts);
    const modelTest = await childJson("/api/ai/test", "POST", 150000);
    if (!modelTest.ok) throw new Error("model verification failed");
    for (const agent of agents) {
      if (!fs.existsSync(agent.plist)) continue;
      if (fs.existsSync(`${agent.plist}.disabled`)) throw new Error("legacy agent disabled plist already exists");
      fs.renameSync(agent.plist, `${agent.plist}.disabled`);
      disabled.push(agent);
    }
    success = true;
    publish({ status: "completed", type: "legacy-migrate", stage: "finished", percent: 100 });
    return { ok: true, legacy, migratedDockerVolumes: migrated.migratedDockerVolumes, hermesProfileMigrated: migrated.hermesProfileMigrated, accounts: migrated.accounts.map(({ id, expectedQq }) => ({ id, expectedQq })), health: { generatedAt: health.generatedAt } };
  } catch (error) {
    await stopBridge();
    let rollbackFailed = false;
    try {
      if (migrated) await backup.rollbackRestore({ stateRoot, rollbackDir: migrated.rollbackDir, installedTargets: migrated.installedTargets, parkedContainers: migrated.parkedContainers, restoredVolumes: migrated.restoredVolumes });
    } catch (failure) { rollbackFailed = true; console.error(`legacy migration rollback failed: ${failure.message}`); }
    for (const agent of disabled.slice().reverse()) {
      try { fs.renameSync(`${agent.plist}.disabled`, agent.plist); }
      catch (failure) { rollbackFailed = true; console.error(`legacy agent plist restore failed: ${failure.message}`); }
    }
    for (const agent of stopped.slice().reverse()) {
      const result = await launchctl(["bootstrap", domain, agent.plist]);
      if (!result.ok) { rollbackFailed = true; console.error(`legacy agent restart failed: ${agent.label}`); }
    }
    try { await restoreBridge(wasRunning); } catch (failure) { rollbackFailed = true; console.error(`bridge restart after legacy rollback failed: ${failure.message}`); }
    publish({ status: "failed", type: "legacy-migrate", stage: "finished", percent: progress?.percent || 0, rollbackFailed });
    throw error;
  } finally {
    operation = null;
    if (!success && !wasRunning) intentionalStop = true;
  }
}

async function createLocalBackup(options) {
  if (operation) throw new Error("another backup operation is running");
  const type = options.type === "full" ? "full" : "safe";
  if (type === "full" && !String(options.password || "")) throw new Error("full backup requires password");
  const controller = new AbortController();
  const wasRunning = Boolean(child);
  operation = { kind: "backup", controller };
  publish({ status: "running", type, stage: "prepare", percent: 0 });
  let result;
  let failure;
  try {
    if (type === "full") await stopBridge();
    if (controller.signal.aborted) throw new backup.BackupCancelledError();
    result = await backup.createBackup({ type, password: options.password || "", includeLogs: type === "full" && options.includeLogs === true, destinationDir: backupRoot, stateRoot, hermesHome, logRoot, signal: controller.signal, onProgress: (item) => publish({ type, status: "running", ...item }) });
    fs.chmodSync(result.path, 0o600);
  } catch (error) { failure = error; }
  try {
    if (type === "full") { publish({ type, status: "running", stage: "restart", percent: 99 }); await restoreBridge(wasRunning); }
  } catch (error) { failure = new Error(`bridge restart failed: ${error.message}`); }
  const cancelled = failure?.name === "BackupCancelledError";
  publish({ type, status: failure ? (cancelled ? "cancelled" : "failed") : "completed", stage: "finished", percent: failure ? progress?.percent || 0 : 100 });
  operation = null;
  if (failure) throw failure;
  return result;
}

async function restoreLocalBackup(options) {
  if (operation) throw new Error("another backup operation is running");
  const { file } = fileForName(options.name);
  const inspected = await backup.inspectBackup({ path: file, password: options.password || "" });
  operation = { kind: "restore" };
  publish({ status: "running", type: "restore", stage: "prepare", percent: 0 });
  let rollback;
  let restored;
  let rollbackType = inspected.manifest.type === "full" && options.password ? "full" : "safe";
  try {
    await stopBridge();
    try {
      rollback = await backup.createBackup({ type: rollbackType, password: rollbackType === "full" ? options.password : "", destinationDir: backupRoot, stateRoot, hermesHome });
    } catch (error) {
      if (rollbackType !== "full" || !/Docker container unavailable|no portable Docker volume/.test(error.message)) throw error;
      rollbackType = "safe";
      rollback = await backup.createBackup({ type: "safe", destinationDir: backupRoot, stateRoot, hermesHome });
    }
    publish({ status: "running", type: "restore", stage: "restore", percent: 60 });
    restored = await backup.restoreBackup({ path: file, password: options.password || "", stateRoot, hermesHome });
    await startBridge(true);
    await resetRestoredAccounts(restored.manifest);
    publish({ status: "completed", type: "restore", stage: "finished", percent: 100 });
    return { ok: true, manifest: restored.manifest, rollbackName: path.basename(rollback.path), warning: restored.manifest.mayRequireQqRescan ? "QQ 可能需要重新扫码" : "" };
  } catch (error) {
    await stopBridge();
    let rollbackFailed = false;
    try {
      if (restored) await backup.rollbackRestore({ stateRoot, rollbackDir: restored.rollbackDir, installedTargets: restored.installedTargets, parkedContainers: restored.parkedContainers, restoredVolumes: restored.restoredVolumes });
      else if (rollback) await backup.restoreBackup({ path: rollback.path, password: rollbackType === "full" ? options.password : "", stateRoot, hermesHome });
    } catch (rollbackError) { rollbackFailed = true; console.error(`restore rollback failed: ${rollbackError.message}`); }
    try { await startBridge(true); } catch (restartError) { console.error(`bridge restart after restore failure: ${restartError.message}`); }
    publish({ status: "failed", type: "restore", stage: "finished", percent: progress?.percent || 0, rollbackFailed });
    throw error;
  } finally { operation = null; }
}

async function upload(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/octet-stream") throw new Error("octet-stream required");
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD) throw new Error("upload too large");
  const name = `upload-${crypto.randomBytes(16).toString("hex")}.hermesqqbackup`;
  const file = path.join(backupRoot, name);
  let size = 0;
  const handle = await fs.promises.open(file, "wx", 0o600);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new Error("upload too large");
      await handle.write(chunk);
    }
    if (!size || (declared && size !== declared)) throw new Error("incomplete upload");
  } catch (error) { await handle.close(); await fs.promises.rm(file, { force: true }); throw error; }
  await handle.close();
  return { ok: true, name, size };
}

function proxy(req, res) {
  if (!child || !childPort) return reply(res, 503, { ok: false, error: "bridge_stopped" });
  const upstream = http.request({ hostname: "127.0.0.1", port: childPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${childPort}` } }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) reply(res, 502, { ok: false, error: "bridge_unavailable" }); else res.destroy(); });
  req.pipe(upstream);
}

async function route(req, res) {
  if (!localHost(req)) return reply(res, 403, { ok: false, error: "invalid_host" });
  const pathname = new URL(req.url, `http://127.0.0.1:${publicPort}`).pathname;
  if (req.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    const file = path.join(resourceRoot, "public", "admin.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === "GET" && pathname === "/health" && !child) return reply(res, 503, { ok: false, running: false, bridgeStopped: true });
  if (!new Set(["GET", "HEAD"]).has(req.method) && !validOrigin(req)) return reply(res, 403, { ok: false, error: "invalid_origin" });
  if (!pathname.startsWith("/api/host/")) return proxy(req, res);
  try {
    if (req.method === "GET" && pathname === "/api/host/status") {
      const bridgeHealth = child ? await childJson("/health", "GET", 700).catch(() => null) : null;
      const appVersion = JSON.parse(fs.readFileSync(path.join(resourceRoot, "package.json"), "utf8")).version;
      return reply(res, 200, { ok: true, hostKind: "hermesqq-local-host", appVersion, platform: process.platform, arch: process.arch, running: Boolean(child), bridgeRunning: Boolean(child), bridgeHealth, backupRoot, stateRoot, logRoot, webEdition: !desktopExecutable, setupComplete: fs.existsSync(setupFile), autoStart: fs.existsSync(autoStartPath()) });
    }
    if (req.method === "POST" && pathname === "/api/host/autostart") return reply(res, 200, await setAutoStart((await jsonBody(req)).enabled === true));
    if (req.method === "GET" && pathname === "/api/host/backup/status") return reply(res, 200, progress || { status: "idle" });
    if (req.method === "POST" && pathname === "/api/host/backup/cancel") {
      if (operation?.kind !== "backup" || !operation.controller || operation.controller.signal.aborted) return reply(res, 200, { ok: false, reason: "not_cancellable" });
      operation.controller.abort();
      publish({ ...progress, status: "cancelling" });
      return reply(res, 200, { ok: true });
    }
    if (operation) return reply(res, 409, { ok: false, error: "host_busy" });
    const action = pathname.match(/^\/api\/host\/bridge\/(start|stop|restart)$/);
    if (req.method === "POST" && action) {
      if (action[1] !== "start") await stopBridge();
      if (action[1] !== "stop") await startBridge();
      return reply(res, 200, { ok: true, running: Boolean(child) });
    }
    if (req.method === "POST" && pathname === "/api/host/backup") return reply(res, 200, await createLocalBackup(await jsonBody(req)));
    if (req.method === "POST" && pathname === "/api/host/backup/upload") return reply(res, 200, await upload(req));
    if (req.method === "GET" && pathname === "/api/host/backups") return reply(res, 200, backup.listLocalBackups(backupRoot).map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt })));
    const match = pathname.match(/^\/api\/host\/backups\/([^/]+?)(\/download)?$/);
    if (match) {
      const { file, stat } = fileForName(decodeURIComponent(match[1]));
      if (req.method === "DELETE" && !match[2]) return reply(res, 200, backup.deleteLocalBackup(file, backupRoot));
      if (req.method === "GET" && match[2]) {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size, "content-disposition": `attachment; filename="${path.basename(file)}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return fs.createReadStream(file).pipe(res);
      }
    }
    if (req.method === "POST" && pathname === "/api/host/backup/inspect") {
      const options = await jsonBody(req);
      return reply(res, 200, await backup.inspectBackup({ path: fileForName(options.name).file, password: options.password || "" }));
    }
    if (req.method === "POST" && pathname === "/api/host/backup/restore") return reply(res, 200, await restoreLocalBackup(await jsonBody(req)));
    if (req.method === "POST" && pathname === "/api/host/legacy/inspect") return reply(res, 200, { ok: true, ...legacyProject((await jsonBody(req)).path) });
    if (req.method === "POST" && pathname === "/api/host/legacy/migrate") return reply(res, 200, await migrateLocalLegacy(await jsonBody(req)));
    return reply(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const badInput = /invalid|too large|incomplete|requires password|octet-stream|not a regular|ENOENT/.test(error.message);
    return reply(res, badInput ? 400 : 500, { ok: false, error: errorMessage(error) });
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  intentionalStop = true;
  clearTimeout(retryTimer);
  operation?.controller?.abort();
  server?.close();
  await stopBridge();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) throw new Error("invalid control port");
server = http.createServer((req, res) => { route(req, res).catch(() => { if (!res.headersSent) reply(res, 500, { ok: false, error: "host_error" }); else res.destroy(); }); });
server.on("clientError", (_error, socket) => socket.destroy());
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${publicPort} is occupied; existing service: http://127.0.0.1:${publicPort}/admin`);
  else console.error(`Web host failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(publicPort, "127.0.0.1", async () => {
  console.log(`Web host: http://127.0.0.1:${publicPort}/admin`);
  for (const dir of [stateRoot, backupRoot, logRoot, hermesHome]) ensurePrivateDir(dir);
  if (!fs.existsSync(configFile)) {
    const example = path.join(resourceRoot, "config.example.json");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, configFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(configFile, 0o600);
    }
  }
  startBridge().catch((error) => console.error(`Bridge startup failed: ${error.message}`));
});
