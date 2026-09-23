const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, utilityProcess, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const APP_NAME = "Hermes QQ Bot";
const APP_VERSION = "1.0.0-beta.4";
const CONTROL_PORT = Number(process.env.HERMES_QQ_CONTROL_PORT || 6200);
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const CONTROL_HEALTH = `${CONTROL_URL}/health`;
let mainWindow = null;
let tray = null;
let bridge = null;
let bridgeIntentionalStop = false;
let quitting = false;
let restartTimer = null;
let lastBridgeExit = null;
let bridgeInstanceId = "";
let externalHost = false;
let externalHostRunning = false;
let setupBridgeAllowed = false;
let activeBackup = null;
let lastBackupProgress = null;

function publishBackupProgress(progress) {
  const next = { ...progress, updatedAt: new Date().toISOString() };
  lastBackupProgress = next;
  if (activeBackup) activeBackup.progress = next;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("backup:progress", next);
}

function resourceRoot() {
  return app.getAppPath();
}

function stateRoot() {
  return app.getPath("userData");
}

function logRoot() {
  return app.getPath("logs");
}

function backupRoot() {
  return path.join(app.getPath("documents"), `${APP_NAME} Backups`);
}

function hermesHome() {
  return path.join(stateRoot(), "hermes");
}

function setupComplete() {
  return fs.existsSync(path.join(stateRoot(), ".setup-complete"));
}

function configuredOnebotPort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(stateRoot(), "config.json"), "utf8")).listen?.port || 6199); }
  catch { return 6199; }
}

function ensureRuntimeDirectories() {
  for (const dir of [stateRoot(), logRoot(), backupRoot(), hermesHome()]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = path.join(stateRoot(), "config.json");
  const example = path.join(resourceRoot(), "config.example.json");
  if (!fs.existsSync(config) && fs.existsSync(example)) fs.copyFileSync(example, config);
}

function appendDesktopLog(message) {
  try {
    fs.mkdirSync(logRoot(), { recursive: true });
    fs.appendFileSync(path.join(logRoot(), "desktop.log"), `${new Date().toISOString()} ${message}\n`);
  } catch { /* best effort */ }
}

function resolveExecutable(name) {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", name),
    path.join(os.homedir(), ".hermes", "bin", name),
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
    path.join("/usr/bin", name)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || name;
}

function bridgeEnvironment() {
  const extraPath = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(path.delimiter);
  return {
    ...process.env,
    PATH: extraPath,
    HERMES_QQ_HOME: stateRoot(),
    HERMES_QQ_RESOURCE_ROOT: resourceRoot(),
    HERMES_QQ_LOG_DIR: logRoot(),
    HERMES_QQ_MANAGED_VOLUMES: "1",
    HERMES_QQ_VOLUME_PREFIX: "hermes-qq-bot",
    HERMES_QQ_INSTANCE_ID: bridgeInstanceId,
    HERMES_QQ_DESKTOP_EXE: app.getPath("exe"),
    HERMES_HOME: hermesHome()
  };
}

function pipeBridgeOutput(stream, fileName) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    try { fs.appendFileSync(path.join(logRoot(), fileName), chunk); } catch { /* best effort */ }
  });
}

function startBridge() {
  if (bridge) return { ok: true, alreadyRunning: true };
  ensureRuntimeDirectories();
  bridgeIntentionalStop = false;
  bridgeInstanceId = crypto.randomBytes(12).toString("hex");
  const script = path.join(resourceRoot(), "src", "web-host.js");
  appendDesktopLog("starting local host utility process");
  try {
    bridge = utilityProcess.fork(script, [], {
      env: bridgeEnvironment(),
      cwd: stateRoot(),
      stdio: "pipe",
      serviceName: APP_NAME
    });
  } catch (error) {
    appendDesktopLog(`bridge spawn failed: ${error.message}`);
    throw error;
  }
  pipeBridgeOutput(bridge.stdout, "bridge.log");
  pipeBridgeOutput(bridge.stderr, "bridge.error.log");
  bridge.on("spawn", () => appendDesktopLog(`bridge spawned pid=${bridge.pid || "unknown"}`));
  bridge.on("error", (error) => appendDesktopLog(`bridge process error: ${error.message}`));
  bridge.on("exit", async (code) => {
    lastBridgeExit = { code, at: new Date().toISOString(), intentional: bridgeIntentionalStop };
    appendDesktopLog(`bridge exited code=${code} intentional=${bridgeIntentionalStop}`);
    bridge = null;
    if (!bridgeIntentionalStop && !quitting) scheduleBridgeRetry(2000);
    updateTrayMenu();
  });
  updateTrayMenu();
  return { ok: true };
}

function scheduleBridgeRetry(delayMs = 5000) {
  if (bridgeIntentionalStop || quitting || (!setupComplete() && !setupBridgeAllowed)) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { restartTimer = null; startBridgeWhenPortsFree().catch((error) => appendDesktopLog(`bridge retry failed: ${error.message}`)); }, delayMs);
}

async function startBridgeWhenPortsFree({ retry = true } = {}) {
  if (bridge) return { ok: true, alreadyRunning: true };
  const attached = await fetchJson(`${CONTROL_URL}/api/host/status`, 1500).catch(() => null);
  if (attached?.hostKind === "hermesqq-local-host" && path.resolve(attached.stateRoot || "") === stateRoot()) {
    externalHost = true;
    externalHostRunning = Boolean(attached.running);
    return { ok: true, alreadyRunning: Boolean(attached.running), externalHost: true };
  }
  externalHost = false;
  externalHostRunning = false;
  if (!setupComplete() && !setupBridgeAllowed) return { ok: false, reason: "setup_required" };
  const ports = [...new Set([CONTROL_PORT, configuredOnebotPort()])];
  for (const port of ports) {
    if (await portAvailable(port)) continue;
    if (retry) scheduleBridgeRetry();
    return { ok: false, reason: "port_occupied", port };
  }
  return startBridge();
}

async function startManagedBridge() {
  const result = await startBridgeWhenPortsFree({ retry: false });
  if (result.ok && result.externalHost && !result.alreadyRunning) {
    const started = await fetchJson(`${CONTROL_URL}/api/host/bridge/start`, 30_000, "POST");
    externalHostRunning = Boolean(started.running);
  }
  updateTrayMenu();
  return result;
}

async function stopBridge() {
  if (externalHost) {
    const result = await fetchJson(`${CONTROL_URL}/api/host/bridge/stop`, 30_000, "POST");
    externalHostRunning = false;
    updateTrayMenu();
    return result;
  }
  bridgeIntentionalStop = true;
  clearTimeout(restartTimer);
  if (!bridge) return { ok: true, alreadyStopped: true };
  const current = bridge;
  bridge = null;
  current.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  updateTrayMenu();
  return { ok: true };
}

async function restartBridge() {
  if (externalHost) {
    const result = await fetchJson(`${CONTROL_URL}/api/host/bridge/restart`, 30_000, "POST");
    externalHostRunning = Boolean(result.running);
    updateTrayMenu();
    return result;
  }
  await stopBridge();
  bridgeIntentionalStop = false;
  return startBridgeWhenPortsFree();
}

async function fetchJson(url, timeoutMs = 2500, method = "GET", body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBridge(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(CONTROL_HEALTH, 1500);
      if (health.generatedAt && (externalHost || (health.instanceId && health.instanceId === bridgeInstanceId))) return health;
    } catch { /* bridge may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("桥接服务未在预期时间内恢复");
}

async function waitForMigratedAccounts(accounts, timeoutMs = 90_000) {
  if (!accounts.length) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchJson(CONTROL_HEALTH, 2500).catch(() => null);
    const current = Array.isArray(health?.accounts) ? health.accounts : [];
    if (accounts.every((account) => {
      const found = current.find((item) => item.id === account.id);
      return found?.connected && found.actualQq && (!account.expectedQq || found.actualQq === account.expectedQq);
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("迁移后的 OneBot 账号未能在 90 秒内确认连接和身份，已触发回滚");
}

function execCapture(command, args = [], timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: bridgeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => resolve({ ok: false, error: error.message, stdout: "", stderr: "" }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim() });
    });
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function dependencyStatus() {
  const onebotPort = configuredOnebotPort();
  const docker = await execCapture(resolveExecutable("docker"), ["info", "--format", "{{.ServerVersion}}"], 8000);
  const hermes = await execCapture(resolveExecutable("hermes"), ["--version"], 45_000);
  const candidate = await fetchJson(CONTROL_HEALTH, 1500).catch(() => null);
  const host = externalHost ? await fetchJson(`${CONTROL_URL}/api/host/status`, 1500).catch(() => null) : null;
  const health = (externalHost && host?.hostKind === "hermesqq-local-host") || candidate?.instanceId === bridgeInstanceId ? candidate : null;
  const macosMajor = Number(process.getSystemVersion?.().split(".")[0] || 0);
  const disk = fs.statfsSync(stateRoot());
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    supportedPlatform: process.platform === "darwin" && process.arch === "arm64" && macosMajor >= 13,
    disk: { availableBytes, enough: availableBytes >= 5 * 1024 ** 3 },
    stateRoot: stateRoot(),
    logRoot: logRoot(),
    backupRoot: backupRoot(),
    externalHost,
    bridgeRunning: Boolean(bridge && health) || Boolean(externalHost && host?.running),
    bridgeHealth: health,
    lastBridgeExit,
    docker: { installed: docker.ok || !/ENOENT|not found/i.test(docker.error || ""), running: docker.ok, version: docker.ok ? docker.stdout : "", error: docker.ok ? "" : (docker.stderr || docker.error || "Docker 不可用") },
    hermes: { installed: hermes.ok, version: hermes.ok ? hermes.stdout : "", error: hermes.ok ? "" : (hermes.stderr || hermes.error || "Hermes 不可用") },
    ports: {
      control6200: health ? "bridge" : (await portAvailable(CONTROL_PORT) ? "available" : "occupied"),
      onebotPort,
      onebot6199: health ? "bridge" : (await portAvailable(onebotPort) ? "available" : "occupied")
    },
    firstRun: !setupComplete(),
    autoStart: externalHost ? Boolean(host?.autoStart) : autoStartInstalled()
  };
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.eraser.hermesqqbot.plist");
}

function autoStartInstalled() {
  return fs.existsSync(launchAgentPath());
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function setAutoStart(enabled) {
  const plist = launchAgentPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const domain = `gui/${process.getuid()}`;
  if (!enabled) {
    await execCapture("launchctl", ["bootout", domain, plist], 8000);
    fs.rmSync(plist, { force: true });
    return { ok: true, enabled: false };
  }
  if (fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", "com.eraser.hermesqqbot.web.plist"))) {
    throw new Error("请先关闭 WebUI 版的登录自动启动，避免两套入口同时接管 QQ");
  }
  const executable = app.getPath("exe");
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.eraser.hermesqqbot</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(executable)}</string><string>--background</string></array>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n<key>StandardOutPath</key><string>${xmlEscape(path.join(logRoot(), "launchd.log"))}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(path.join(logRoot(), "launchd.error.log"))}</string>\n</dict></plist>\n`;
  fs.writeFileSync(plist, content, { mode: 0o600 });
  await execCapture("launchctl", ["bootout", domain, plist], 5000);
  const result = await execCapture("launchctl", ["bootstrap", domain, plist], 8000);
  if (!result.ok && !/already loaded|service already loaded/i.test(result.stderr)) throw new Error(result.stderr || "无法启用登录启动");
  return { ok: true, enabled: true };
}

function createWindow() {
  const setupUrl = new URL(`file://${path.join(resourceRoot(), "desktop", "setup.html")}`).href;
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: "#0b0f17",
    show: !process.argv.includes("--background"),
    webPreferences: {
      preload: path.join(resourceRoot(), "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${CONTROL_URL}/`) && !url.startsWith(`${setupUrl}?`) && url !== setupUrl) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  loadInitialPage();
}

async function loadInitialPage() {
  const firstRun = !fs.existsSync(path.join(stateRoot(), ".setup-complete"));
  if (firstRun && !externalHost) {
    await mainWindow.loadFile(path.join(resourceRoot(), "desktop", "setup.html"));
    return;
  }
  try {
    if (!externalHost) await waitForBridge();
    await mainWindow.loadURL(`${CONTROL_URL}/admin?desktop=1`);
  } catch {
    await mainWindow.loadFile(path.join(resourceRoot(), "desktop", "setup.html"), { query: { error: "bridge" } });
  }
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制台", click: showWindow },
    { type: "separator" },
    { label: bridge || externalHostRunning ? "机器人运行中" : "机器人已停止", enabled: false },
    { label: "启动", enabled: !bridge && !externalHostRunning, click: () => startManagedBridge().catch((error) => appendDesktopLog(`start failed: ${error.message}`)) },
    { label: "停止", enabled: Boolean(bridge || externalHostRunning), click: () => stopBridge() },
    { label: "重启", click: () => restartBridge() },
    { label: "查看日志", click: () => shell.openPath(logRoot()) },
    { type: "separator" },
    { label: "退出并停止机器人", click: async () => { quitting = true; await stopBridge(); app.quit(); } }
  ]));
}

function createTray() {
  const icon = nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><rect width="22" height="22" rx="6" fill="#6c82ff"/><circle cx="8" cy="10" r="2" fill="white"/><circle cx="14" cy="10" r="2" fill="white"/><path d="M7 15h8" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`).toString("base64"));
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip(APP_NAME);
  tray.on("click", showWindow);
  updateTrayMenu();
}

function validSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const current = event.senderFrame?.url || "";
  const setupUrl = new URL(`file://${path.join(resourceRoot(), "desktop", "setup.html")}`).href;
  return current.startsWith(`${CONTROL_URL}/admin`) || current === setupUrl || current.startsWith(`${setupUrl}?`);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!validSender(event)) throw new Error("unauthorized IPC sender");
    return fn(payload || {});
  });
}

async function backupModule() {
  return import(path.join(resourceRoot(), "src", "backup-service.js"));
}

function registerIpc() {
  handle("app:get-status", () => dependencyStatus());
  handle("setup:prepare-snowluma", async () => {
    const config = JSON.parse(fs.readFileSync(path.join(stateRoot(), "config.json"), "utf8"));
    const accounts = [config.accounts?.primary, ...(config.accounts?.standbys || [])]
      .filter((account) => account && account.protocol === "snowluma" && account.enabled !== false);
    if (!setupBridgeAllowed && !setupComplete()) {
      for (const account of accounts) {
        const container = String(account.protocolContainer || account.napcatContainer || "");
        if (!container) continue;
        if ((await execCapture(resolveExecutable("docker"), ["inspect", container], 10_000)).ok) {
          throw new Error("检测到同名 QQ 协议端容器。若已有网页端数据，请先使用下方“迁移现有项目”，避免两个桥接同时接管账号。");
        }
      }
      setupBridgeAllowed = true;
      const started = await startBridgeWhenPortsFree({ retry: false });
      if (!started.ok) {
        setupBridgeAllowed = false;
        throw new Error(`本机端口 ${started.port || ""} 已被占用；请先迁移旧网页项目或关闭占用端口的程序。`);
      }
      try { await waitForBridge(); }
      catch (error) { setupBridgeAllowed = false; await stopBridge(); throw error; }
    }
    const images = [...new Set(accounts.map((account) => account.snowlumaImage || "motricseven7/snowluma:latest"))];
    for (const image of images) {
      const pulled = await execCapture(resolveExecutable("docker"), ["pull", image], 10 * 60_000);
      if (!pulled.ok) throw new Error(`无法拉取 SnowLuma 镜像：${pulled.stderr || pulled.error || image}`);
    }
    const results = [];
    for (const account of accounts) {
      const result = await fetchJson(`${CONTROL_URL}/api/accounts/${encodeURIComponent(account.id)}/login/reset`, 120_000, "POST");
      if (!result.ok) throw new Error(`无法启动 ${account.id}：${result.error || result.message || "未知错误"}`);
      results.push({ id: account.id, webuiUrl: `http://127.0.0.1:${account.webuiPort}`, noVncUrl: `http://127.0.0.1:${account.noVncPort}` });
    }
    return { ok: true, accounts: results };
  });
  handle("bot:start", async () => {
    const result = await startManagedBridge();
    if (!result.ok) throw new Error(result.reason === "setup_required" ? "请先迁移现有项目或在首次设置中准备新账号" : `端口 ${result.port} 正被其他程序占用`);
    await waitForBridge();
    return result;
  });
  handle("bot:stop", () => stopBridge());
  handle("bot:restart", async () => {
    const result = await restartBridge();
    if (!result.ok) throw new Error(result.reason === "setup_required" ? "请先迁移现有项目或在首次设置中准备新账号" : `端口 ${result.port} 正被其他程序占用`);
    const health = await waitForBridge(); return { ok: true, health };
  });
  handle("backup:choose-destination", async () => {
    if (externalHost) throw new Error("当前连接到 WebUI 宿主，请使用默认备份目录");
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择备份保存目录", defaultPath: backupRoot(), properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
  });
  handle("backup:choose-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择 Hermes QQ Bot 迁移包", defaultPath: backupRoot(), properties: ["openFile"], filters: [{ name: "Hermes QQ Bot Backup", extensions: ["hermesqqbackup"] }] });
    if (result.canceled) return { canceled: true };
    let selected = result.filePaths[0];
    if (externalHost && !selected.startsWith(`${backupRoot()}${path.sep}`)) {
      const imported = path.join(backupRoot(), `import-${crypto.randomBytes(12).toString("hex")}.hermesqqbackup`);
      fs.copyFileSync(selected, imported, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(imported, 0o600);
      selected = imported;
    }
    return { canceled: false, path: selected };
  });
  handle("backup:create", async (options) => {
    if (externalHost) {
      if (options.destination && path.resolve(options.destination) !== backupRoot()) throw new Error("当前连接到 WebUI 宿主，请使用默认备份目录");
      return fetchJson(`${CONTROL_URL}/api/host/backup`, 30 * 60_000, "POST", { type: options.type, password: options.password || "", includeLogs: Boolean(options.includeLogs) });
    }
    if (activeBackup) throw new Error("已有备份正在进行，请等待或取消后再试");
    const service = await backupModule();
    const type = options.type === "full" ? "full" : "safe";
    if (type === "full" && !String(options.password || "")) throw new Error("完整迁移备份必须设置密码");
    const controller = new AbortController();
    const wasRunning = Boolean(bridge);
    activeBackup = { controller, progress: null, cancelable: true };
    publishBackupProgress({ type, status: "running", stage: "prepare", percent: 0, detail: type === "full" ? "准备暂停机器人并备份登录状态" : "准备复制用户数据" });
    let result;
    let error;
    try {
      if (type === "full") await stopBridge();
      if (controller.signal.aborted) throw new service.BackupCancelledError();
      result = await service.createBackup({ type, password: options.password || "", includeLogs: type === "full" && Boolean(options.includeLogs), destinationDir: options.destination || backupRoot(), stateRoot: stateRoot(), hermesHome: hermesHome(), logRoot: logRoot(), appVersion: APP_VERSION, signal: controller.signal, onProgress: (progress) => publishBackupProgress({ type, status: "running", ...progress }) });
      activeBackup.cancelable = false;
    } catch (caught) {
      error = caught;
    } finally {
      activeBackup.cancelable = false;
      if (type === "full" && wasRunning) {
        publishBackupProgress({ type, status: "running", stage: "restart", percent: 99, detail: "恢复机器人连接" });
        bridgeIntentionalStop = false;
        try {
          const started = await startBridgeWhenPortsFree();
          if (!started.ok) throw new Error(`端口 ${started.port || ""} 被占用`);
          await waitForBridge(30_000);
        } catch (restartError) {
          error = new Error(`${result ? "备份文件已生成" : "备份未完成"}，且桥接恢复失败：${restartError.message}`);
          appendDesktopLog(`backup bridge restart failed: ${restartError.message}`);
        }
      }
      const cancelled = error?.name === "BackupCancelledError";
      publishBackupProgress({ type, status: error ? (cancelled ? "cancelled" : "failed") : "completed", stage: error ? "finished" : "complete", percent: error ? activeBackup.progress?.percent || 0 : 100, detail: error ? (cancelled ? "备份已取消；机器人已恢复" : error.message) : "备份完成；机器人已恢复" });
      activeBackup = null;
    }
    if (error) throw error;
    return result;
  });
  handle("backup:status", () => externalHost ? fetchJson(`${CONTROL_URL}/api/host/backup/status`, 2500) : activeBackup?.progress || lastBackupProgress);
  handle("backup:cancel", () => {
    if (externalHost) return fetchJson(`${CONTROL_URL}/api/host/backup/cancel`, 2500, "POST");
    if (!activeBackup || !activeBackup.cancelable) return { ok: false, reason: "not_cancellable" };
    activeBackup.controller.abort();
    publishBackupProgress({ ...activeBackup.progress, status: "cancelling", detail: "正在取消并恢复机器人连接" });
    return { ok: true };
  });
  handle("backup:inspect", async (options) => (await backupModule()).inspectBackup(options));
  handle("backup:restore", async (options) => {
    if (externalHost) {
      const selected = path.resolve(options.path || "");
      if (!selected.startsWith(`${backupRoot()}${path.sep}`)) throw new Error("请先将迁移包导入默认备份目录");
      return fetchJson(`${CONTROL_URL}/api/host/backup/restore`, 30 * 60_000, "POST", { name: path.basename(selected), password: options.password || "" });
    }
    const service = await backupModule();
    const inspected = await service.inspectBackup(options);
    await stopBridge();
    let rollbackType = inspected.manifest.type === "full" && options.password ? "full" : "safe";
    let rollback = null;
    let restored = null;
    try {
      try {
        rollback = await service.createBackup({ type: rollbackType, password: rollbackType === "full" ? options.password : "", destinationDir: backupRoot(), stateRoot: stateRoot(), hermesHome: hermesHome(), appVersion: APP_VERSION });
      } catch (error) {
        if (rollbackType !== "full" || !/Docker container unavailable|no portable Docker volume/.test(error.message)) throw error;
        rollbackType = "safe";
        rollback = await service.createBackup({ type: "safe", destinationDir: backupRoot(), stateRoot: stateRoot(), hermesHome: hermesHome(), appVersion: APP_VERSION });
      }
      restored = await service.restoreBackup({ ...options, stateRoot: stateRoot(), hermesHome: hermesHome() });
      bridgeIntentionalStop = false;
      startBridge();
      const health = await waitForBridge(30_000);
      if (!health?.generatedAt) throw new Error("恢复后桥接健康检查失败");
      for (const account of restored.manifest.accounts || []) {
        if (!(restored.manifest.dockerVolumes || []).some((volume) => volume.accountId === account.id)) continue;
        const result = await fetchJson(`${CONTROL_URL}/api/accounts/${encodeURIComponent(account.id)}/login/reset`, 120_000, "POST");
        if (!result.ok) throw new Error(`无法启动恢复的协议端：${account.id}`);
      }
      return { ...restored, health, rollbackPath: rollback.path, warning: restored.manifest.mayRequireQqRescan ? "数据已恢复；QQ 可能因新设备策略要求重新扫码。" : "" };
    } catch (error) {
      await stopBridge();
      try {
        if (restored) await service.rollbackRestore({ stateRoot: stateRoot(), rollbackDir: restored.rollbackDir, installedTargets: restored.installedTargets, parkedContainers: restored.parkedContainers, restoredVolumes: restored.restoredVolumes });
        else if (rollback) await service.restoreBackup({ path: rollback.path, password: rollbackType === "full" ? options.password : "", stateRoot: stateRoot(), hermesHome: hermesHome() });
      } catch (rollbackError) { appendDesktopLog(`automatic rollback failed: ${rollbackError.message}`); }
      bridgeIntentionalStop = false;
      startBridge();
      throw error;
    }
  });
  handle("backup:list", async () => externalHost
    ? (await fetchJson(`${CONTROL_URL}/api/host/backups`, 2500)).map((item) => ({ ...item, path: path.join(backupRoot(), item.name) }))
    : (await backupModule()).listLocalBackups(backupRoot()));
  handle("backup:delete", async ({ path: file }) => externalHost
    ? fetchJson(`${CONTROL_URL}/api/host/backups/${encodeURIComponent(path.basename(file))}`, 2500, "DELETE")
    : (await backupModule()).deleteLocalBackup(file, backupRoot()));
  handle("legacy:select", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择现有 Hermes QQ Bot 项目", properties: ["openDirectory"] });
    if (result.canceled) return { canceled: true };
    const service = await backupModule();
    return { canceled: false, ...(service.inspectLegacyProject(result.filePaths[0])) };
  });
  handle("legacy:migrate", async ({ path: legacyPath }) => {
    if (setupComplete() && (externalHost || bridge)) {
      return fetchJson(`${CONTROL_URL}/api/host/legacy/migrate`, 30 * 60_000, "POST", { path: legacyPath });
    }
    if (externalHost) throw new Error("请先在 WebUI 中停止宿主并使用桌面应用的首次迁移流程");
    const service = await backupModule();
    service.inspectLegacyProject(legacyPath);
    await stopBridge();
    const launchDomain = `gui/${process.getuid()}`;
    const legacyAgents = ["com.codex.qq-hermes-snowluma-bootstrap", "com.codex.qq-hermes-onebot-bridge"].map((label) => ({
      label,
      service: `${launchDomain}/${label}`,
      plist: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`),
      loaded: false
    }));
    for (const agent of legacyAgents) agent.loaded = (await execCapture("launchctl", ["print", agent.service], 5000)).ok;
    const stoppedAgents = [];
    let migrated = null;
    try {
      for (const agent of legacyAgents) {
        if (!agent.loaded) continue;
        const stopped = await execCapture("launchctl", ["bootout", agent.service], 10_000);
        if (!stopped.ok) throw new Error(`无法暂停旧服务 ${agent.label}，请先检查旧 LaunchAgent`);
        stoppedAgents.push(agent);
      }
      if (!(await portAvailable(CONTROL_PORT)) || !(await portAvailable(configuredOnebotPort()))) throw new Error("桥接端口仍被旧程序占用，无法安全迁移");
      migrated = await service.migrateLegacyProject({ projectRoot: legacyPath, stateRoot: stateRoot(), legacyHermesHome: process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), hermesHome: hermesHome() });
      bridgeIntentionalStop = false;
      setupBridgeAllowed = true;
      startBridge();
      const health = await waitForBridge(30_000);
      if (!health?.generatedAt) throw new Error("迁移后桥接健康检查失败");
      for (const account of migrated.accounts) {
        const result = await fetchJson(`${CONTROL_URL}/api/accounts/${encodeURIComponent(account.id)}/login/reset`, 120_000, "POST");
        if (!result.ok) throw new Error(`迁移后无法启动协议端：${account.id}`);
      }
      await waitForMigratedAccounts(migrated.accounts);
      const modelTest = await fetchJson(`${CONTROL_URL}/api/ai/test`, 150_000, "POST");
      if (!modelTest.ok) throw new Error(`迁移后模型测试失败：${modelTest.error || "未知错误"}`);
      for (const agent of legacyAgents) if (fs.existsSync(agent.plist)) fs.renameSync(agent.plist, `${agent.plist}.disabled`);
      return { ...migrated, health };
    } catch (error) {
      await stopBridge();
      let rollbackError = null;
      try {
        if (migrated) await service.rollbackRestore({ stateRoot: stateRoot(), rollbackDir: migrated.rollbackDir, installedTargets: migrated.installedTargets, parkedContainers: migrated.parkedContainers, restoredVolumes: migrated.restoredVolumes });
      } catch (failure) { rollbackError = failure; }
      for (const agent of legacyAgents) {
        if (!fs.existsSync(agent.plist) && fs.existsSync(`${agent.plist}.disabled`)) fs.renameSync(`${agent.plist}.disabled`, agent.plist);
      }
      for (const agent of stoppedAgents.slice().reverse()) await execCapture("launchctl", ["bootstrap", launchDomain, agent.plist], 10_000);
      if (!setupComplete()) setupBridgeAllowed = false;
      if (rollbackError) throw new Error(`迁移失败：${error.message}；自动回滚也失败：${rollbackError.message}。旧项目仍保留，请勿重复迁移。`);
      throw error;
    } finally {
      if (!migrated && stoppedAgents.length === 0 && setupComplete()) { bridgeIntentionalStop = false; startBridgeWhenPortsFree(); }
    }
  });
  handle("setup:complete", async () => {
    if (app.isPackaged && app.getPath("exe").startsWith("/Volumes/")) throw new Error("请先把 App 拖入“应用程序”，再从应用程序目录打开并完成设置");
    await waitForBridge();
    fs.writeFileSync(path.join(stateRoot(), ".setup-complete"), `${new Date().toISOString()}\n`);
    if (app.isPackaged) await setAutoStart(true).catch((error) => appendDesktopLog(`autostart setup failed: ${error.message}`));
    await mainWindow.loadURL(`${CONTROL_URL}/admin?desktop=1`);
    return { ok: true };
  });
  handle("shell:open-external", ({ url }) => {
    const parsed = new URL(String(url));
    const local = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && !parsed.username && !parsed.password;
    const official = parsed.protocol === "https:" && (
      parsed.hostname === "www.docker.com" && parsed.pathname.startsWith("/products/docker-desktop/") ||
      parsed.hostname === "github.com" && parsed.pathname.startsWith("/NousResearch/hermes-agent")
    );
    if (!local && !official) throw new Error("不允许打开这个地址");
    return shell.openExternal(parsed.href);
  });
  handle("shell:open-path", ({ path: target }) => {
    const selected = path.resolve(String(target));
    const allowed = [stateRoot(), logRoot(), backupRoot()].some((root) => selected === root || selected.startsWith(`${root}${path.sep}`));
    if (!allowed) throw new Error("只能打开应用数据、日志或备份目录");
    return shell.openPath(selected);
  });
  handle("shell:reveal-backup", ({ path: target }) => {
    const selected = path.resolve(String(target));
    if (!selected.startsWith(`${backupRoot()}${path.sep}`) || !selected.endsWith(".hermesqqbackup") || !fs.existsSync(selected)) throw new Error("备份文件不存在或不在默认备份目录中");
    shell.showItemInFolder(selected);
    return { ok: true };
  });
  handle("app:set-auto-start", ({ enabled }) => externalHost
    ? fetchJson(`${CONTROL_URL}/api/host/autostart`, 10_000, "POST", { enabled: Boolean(enabled) })
    : setAutoStart(Boolean(enabled)));
}

const initialUserData = path.resolve(process.env.HERMES_QQ_HOME || path.join(app.getPath("appData"), APP_NAME));
fs.mkdirSync(initialUserData, { recursive: true, mode: 0o700 });
app.setPath("userData", initialUserData);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    app.setAppLogsPath(path.resolve(process.env.HERMES_QQ_LOG_DIR || path.join(os.homedir(), "Library", "Logs", APP_NAME)));
    ensureRuntimeDirectories();
    registerIpc();
    await startBridgeWhenPortsFree().catch((error) => appendDesktopLog(`bridge startup failed: ${error.message}`));
    createTray();
    createWindow();
  }).catch((error) => appendDesktopLog(`desktop startup failed: ${error.stack || error.message}`));
}

app.on("activate", showWindow);
app.on("window-all-closed", () => { /* tray application: keep running */ });
app.on("before-quit", () => { quitting = true; bridgeIntentionalStop = true; clearTimeout(restartTimer); if (bridge) bridge.kill(); });
