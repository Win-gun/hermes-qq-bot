#!/usr/bin/env node
// Packaged desktop UI QA only. Never import the real host/bridge or live config.
// Run with a working Node runtime; SIGTERM/SIGINT stops both children and removes
// the disposable HOME, state, logs, backups, and Chromium profile.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureFile = path.join(root, "scripts", "console-preview-server.js");
const require = createRequire(import.meta.url);
const safeJSON = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (code) => { throw Object.assign(new Error(code), { safeCode: code }); };

async function fixtureChild() {
  // Importing this read-only fixture does not execute its CLI or application code.
  const { createPreviewServer } = await import(fixtureFile);
  const server = createPreviewServer({ stateRoot: process.env.HERMES_QQ_HOME });
  let retried = false;
  let closing = false;
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && !retried) {
      retried = true;
      server.listen(0, "127.0.0.1");
    } else {
      process.send?.({ type: "failed", code: "fixture_listen_failed" });
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
  server.once("listening", () => process.send?.({ type: "listening", port: server.address().port }));
  // Passive observation only: do not replace or modify fixture responses.
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/admin?desktop=1") {
      res.once("finish", () => process.send?.({ type: "desktop-console-loaded", status: res.statusCode }));
    }
  });
  const stop = () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    server.close(() => { if (process.connected) process.disconnect(); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("disconnect", stop);
  server.listen(Number(process.env.HERMES_QQ_PREVIEW_PORT), "127.0.0.1");
}

async function reserveOnebotPort() {
  const guard = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    guard.once("error", reject);
    guard.listen(0, "127.0.0.1", resolve);
  });
  return guard;
}

function verifyPackagedMain(appBinary) {
  const archive = path.resolve(path.dirname(appBinary), "..", "Resources", "app.asar");
  const main = require("@electron/asar").extractFile(archive, "desktop/main.cjs").toString("utf8");
  // Fail closed if this build no longer has the attachment and fallback gates
  // this launcher was reviewed against. Never execute bundled source here.
  for (const fragment of [
    'attached?.hostKind === "hermesqq-local-host"',
    'path.resolve(attached.stateRoot || "") === stateRoot()',
    'if (dockerRecoveryInFlight || quitting || bridgeIntentionalStop || !bridge || !setupComplete()) return;',
    'const ports = [...new Set([CONTROL_PORT, configuredOnebotPort()])];',
    'if (await portAvailable(port)) continue;',
    'reason: "port_occupied"',
    'path.join(app.getPath("documents"), `${APP_NAME} Backups`)',
    'path.join(os.homedir(), ".local", "bin", name)'
  ]) if (!main.includes(fragment)) fail("packaged_main_safety_contract_changed");
}

async function stopChild(child) {
  if (!child?.pid) return;
  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signalGroup("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2500, undefined, { ref: false })]);
  }
  // Also reap any remaining renderer/helper processes in the child's group.
  signalGroup("SIGKILL");
}

async function main() {
  if (process.platform !== "darwin") fail("macos_required");
  const buildOut = path.resolve(root, process.env.HERMES_QQ_BUILD_OUT || "out/console-redesign-20261013");
  const appBinary = path.join(buildOut, "Hermes QQ Bot-darwin-arm64", "Hermes QQ Bot.app", "Contents", "MacOS", "Hermes QQ Bot");
  if (!fs.existsSync(appBinary)) fail("packaged_app_missing");
  verifyPackagedMain(appBinary);
  const preferredPort = Number(process.env.HERMES_QQ_PREVIEW_PORT || 6329);
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) fail("invalid_preview_port");

  // Chromium uses Unix sockets in TMPDIR; keep this path below macOS's short
  // socket-path limit rather than nesting under the long per-user /var/folders.
  const temp = fs.realpathSync(fs.mkdtempSync("/private/tmp/hqq-console-"));
  const home = path.join(temp, "home");
  const stateRoot = path.join(temp, "state");
  const logRoot = path.join(temp, "logs");
  const backupRoot = path.join(home, "Documents", "Hermes QQ Bot Backups");
  const temporaryDir = path.join(temp, "tmp");
  let guard;
  let fixture;
  let app;
  let monitor;
  let closing = false;
  let stopRequested = false;
  let resolveStop;
  let startupFailure = "";
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = (code = "") => {
    stopRequested = true;
    if (!startupFailure && code) startupFailure = code;
    resolveStop();
  };
  const onSignal = () => requestStop();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const descriptors = [];
  const childLog = (name) => {
    const fd = fs.openSync(path.join(logRoot, name), "a", 0o600);
    descriptors.push(fd);
    return fd;
  };
  const launch = (command, args, options, code) => {
    const child = spawn(command, args, { detached: true, cwd: temp, ...options });
    child.once("error", () => requestStop(`${code}_spawn_failed`));
    child.once("exit", () => { if (!closing) requestStop(`${code}_exited`); });
    return child;
  };
  try {
    for (const directory of [home, stateRoot, logRoot, backupRoot, temporaryDir, path.join(home, ".local", "bin")]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    // Dependency-status IPC may probe these names while opening the backup tab.
    // These placeholders execute /usr/bin/false, never Docker or Hermes.
    for (const name of ["docker", "hermes"]) fs.symlinkSync("/usr/bin/false", path.join(home, ".local", "bin", name));
    guard = await reserveOnebotPort();
    const onebotPort = guard.address().port;
    guard.on("error", () => requestStop("onebot_guard_failed"));
    fs.writeFileSync(path.join(stateRoot, ".setup-complete"), "ISOLATED CONSOLE PREVIEW ONLY\n", { mode: 0o600 });
    for (const directory of [stateRoot, logRoot, backupRoot]) {
      fs.writeFileSync(path.join(directory, ".console-preview-only"), "DISPOSABLE FICTIONAL UI FIXTURE\n", { mode: 0o600 });
    }
    // Deliberately do not read config.json OR copy config.example.json.
    const config = {
      preview: true, control: { host: "127.0.0.1", port: 0 },
      listen: { host: "127.0.0.1", port: onebotPort, path: "/preview-disabled" },
      accounts: { primary: { id: "preview-disabled", enabled: false, protocolEnabled: false, qq: "10001" }, standbys: [], items: [], failover: { enabled: false } },
      targetGroups: [], privateChats: { enabled: false }, adminNotifications: { enabled: false },
      loginRecovery: { enabled: false }, taskMode: { enabled: false }, webSearch: { enabled: false },
      voice: { enabled: false }, automation: { enabled: false, rules: [] }
    };
    const configFile = path.join(stateRoot, "config.json");
    const environment = {
      PATH: "/usr/bin:/bin", HOME: home, CFFIXED_USER_HOME: home, TMPDIR: `${temporaryDir}${path.sep}`,
      HERMES_QQ_HOME: stateRoot, HERMES_QQ_LOG_DIR: logRoot, HERMES_QQ_BACKUP_ROOT: backupRoot,
      HERMES_HOME: path.join(stateRoot, "hermes"), HERMES_QQ_PREVIEW_PORT: String(preferredPort)
    };
    let resolveListening;
    let resolveConsole;
    const listening = new Promise((resolve) => { resolveListening = resolve; });
    const consoleLoaded = new Promise((resolve) => { resolveConsole = resolve; });
    fixture = launch(process.execPath, [fileURLToPath(import.meta.url), "--fixture-child"], {
      env: environment, stdio: ["ignore", childLog("fixture.stdout.log"), childLog("fixture.stderr.log"), "ipc"]
    }, "fixture");
    fixture.on("message", (message) => {
      if (message?.type === "listening" && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) resolveListening(message.port);
      if (message?.type === "desktop-console-loaded" && message.status === 200) resolveConsole();
      if (message?.type === "failed") requestStop("fixture_failed");
    });
    const port = await Promise.race([listening, stopped, delay(10_000, null, { ref: false })]);
    if (!port) {
      if (startupFailure) fail(startupFailure);
      if (stopRequested) return;
      fail("fixture_listen_timeout");
    }
    config.control.port = port;
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const baseUrl = `http://127.0.0.1:${port}`;
    const inspectFixture = async () => {
      const get = async (route) => {
        const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok || response.headers.get("x-hermes-qq-preview") !== "true") fail("untrusted_preview_response");
        return response.json();
      };
      const [host, health] = await Promise.all([get("/api/host/status"), get("/health")]);
      if (host.preview !== true || host.simulated !== true || host.hostKind !== "hermesqq-local-host"
        || host.stateRoot !== stateRoot || !host.instanceId?.startsWith("console-preview-")
        || health.preview !== true || health.simulated !== true || !health.generatedAt || health.instanceId !== host.instanceId) fail("fixture_attachment_contract_failed");
    };
    await inspectFixture();
    // Preserve the packaged renderer's own sandbox; wrapping the entire App in
    // sandbox-exec prevents Chromium from initializing that native sandbox.
    app = launch(appBinary, [], {
      env: { ...environment, HERMES_QQ_CONTROL_PORT: String(port) },
      stdio: ["ignore", childLog("app.stdout.log"), childLog("app.stderr.log")]
    }, "app");
    const checkDesktopLog = () => {
      const file = path.join(logRoot, "desktop.log");
      if (fs.existsSync(file) && /starting local host utility process|bridge spawned|opening Docker Desktop/.test(fs.readFileSync(file, "utf8"))) requestStop("unexpected_runtime_start_attempt");
    };
    monitor = setInterval(checkDesktopLog, 500);
    const loaded = await Promise.race([consoleLoaded.then(() => true), stopped.then(() => false), delay(20_000, false, { ref: false })]);
    if (!loaded) {
      if (startupFailure) fail(startupFailure);
      if (stopRequested) return;
      fail("desktop_console_load_timeout");
    }
    await inspectFixture();
    checkDesktopLog();
    if (startupFailure) fail(startupFailure);
    // Only safe, synthetic paths and process metadata reach stdout.
    safeJSON({ ok: true, preview: true, appBinary, stateRoot, logRoot, backupRoot, port, url: `${baseUrl}/admin?desktop=1`, pid: process.pid, appPid: app.pid, fixturePid: fixture.pid, bridgeStarted: false });
    await stopped;
    if (startupFailure) fail(startupFailure);
  } finally {
    closing = true;
    clearInterval(monitor);
    // Keep both the fixture and occupied OneBot port alive until the App is gone.
    await stopChild(app);
    await stopChild(fixture);
    if (guard) await new Promise((resolve) => guard.close(resolve));
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(temp, { recursive: true, force: true });
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--fixture-child" && process.send) {
  await fixtureChild();
} else if (args.length === 0) {
  await main().catch((error) => { safeJSON({ ok: false, error: error.safeCode || "isolated_preview_failed" }); process.exitCode = 1; });
} else {
  safeJSON({ ok: false, error: "usage_console_desktop_preview_no_arguments" });
  process.exitCode = 1;
}
