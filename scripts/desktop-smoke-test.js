#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const appBinary = path.join(root, process.env.HERMES_QQ_BUILD_OUT || "out", "Hermes QQ Bot-darwin-arm64", "Hermes QQ Bot.app", "Contents", "MacOS", "Hermes QQ Bot");
if (!fs.existsSync(appBinary)) throw new Error("先构建 app，再运行桌面冒烟测试");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-desktop-smoke-"));
if (process.env.HERMES_QQ_SMOKE_KEEP === "1") console.log(`smoke workspace: ${temp}`);
const state = path.join(temp, "state");
const log = path.join(temp, "logs");
const firstRun = process.env.HERMES_QQ_SMOKE_FIRST_RUN === "1";
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const controlPort = await freePort();
const onebotPort = await freePort();
const simulateConflict = process.env.HERMES_QQ_SMOKE_PORT_CONFLICT === "1";
const externalHost = process.env.HERMES_QQ_SMOKE_EXTERNAL_HOST === "1";
const blocker = simulateConflict ? net.createServer() : null;
if (blocker) await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(onebotPort, "127.0.0.1", resolve); });
const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
config.control.port = controlPort;
config.listen.port = onebotPort;
config.targetGroups = [];
config.privateChats.enabled = false;
config.adminNotifications.enabled = false;
config.loginRecovery.enabled = false;
config.accounts.primary.protocol = "napcat";
config.accounts.standbys = [];
config.accounts.failover.enabled = false;
config.webSearch.enabled = false;
if (config.taskMode) config.taskMode.enabled = false;
fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
if (!firstRun) fs.writeFileSync(path.join(state, ".setup-complete"), "smoke test\n", { mode: 0o600 });

let hostChild = null;
let expectedInstanceId = "";
if (externalHost) {
  hostChild = spawn(process.execPath, [path.join(root, "src", "web-host.js")], {
    env: { ...process.env, HERMES_QQ_HOME: state, HERMES_QQ_LOG_DIR: log, HERMES_QQ_CONTROL_PORT: String(controlPort), HERMES_QQ_BACKUP_ROOT: path.join(temp, "backups") },
    stdio: "ignore"
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (hostChild.exitCode !== null) throw new Error(`external WebUI host exited: ${hostChild.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${controlPort}/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.instanceId) { expectedInstanceId = health.instanceId; break; }
    } catch { /* host is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!expectedInstanceId) throw new Error("external WebUI host did not start");
}

const child = spawn(appBinary, process.env.HERMES_QQ_SMOKE_UI === "1" ? [] : ["--background"], {
  env: { ...process.env, PATH: "/usr/bin:/bin", ELECTRON_ENABLE_LOGGING: "1", HERMES_QQ_HOME: state, HERMES_QQ_LOG_DIR: log, HERMES_QQ_CONTROL_PORT: String(controlPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
if (blocker) setTimeout(() => blocker.close(), 4000);
let processError = "";
let processOutput = "";
child.on("error", (error) => { processError = error.message; });
child.stdout.on("data", (chunk) => { processOutput = `${processOutput}${chunk}`.slice(-1600); });
child.stderr.on("data", (chunk) => { processOutput = `${processOutput}${chunk}`.slice(-1600); });
try {
  if (firstRun) {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    if (child.exitCode !== null) throw new Error(`首次设置时应用提前退出：${child.exitCode}\n${processOutput}`);
    const desktopLog = path.join(log, "desktop.log");
    if (fs.existsSync(desktopLog) && fs.readFileSync(desktopLog, "utf8").includes("bridge spawned")) throw new Error("首次设置时不应自动启动 QQ 桥接");
    console.log(JSON.stringify({ ok: true, firstRunSafe: true, stateIsolated: true }));
  } else {
  let health;
  let lastFetchError = "";
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processError || child.exitCode !== null) throw new Error(`桌面应用提前退出：${processError || child.exitCode}\n${processOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${controlPort}/health`);
      if (response.ok) {
        health = await response.json();
        if (health.generatedAt) break;
      }
    } catch (error) { lastFetchError = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!health?.generatedAt) {
    const diagnostics = ["desktop.log", "bridge.error.log", "bridge.log"].map((name) => {
      const file = path.join(log, name);
      return fs.existsSync(file) ? `${name}: ${fs.readFileSync(file, "utf8").slice(-1200)}` : `${name}: missing`;
    }).join("\n");
    throw new Error(`打包后的桥接服务未启动 (last fetch: ${lastFetchError}; response received: ${Boolean(health)})\n${diagnostics}\n${processOutput}`);
  }
  if (!health.instanceId) throw new Error("打包桥接未返回桌面应用实例标识");
  if (externalHost && health.instanceId !== expectedInstanceId) throw new Error("桌面应用没有接入既有 WebUI 宿主");
  if (externalHost && hostChild.exitCode !== null) throw new Error("桌面应用中断了既有 WebUI 宿主");
  const logDeadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(log, "bridge.log")) && Date.now() < logDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!fs.existsSync(path.join(log, "bridge.log"))) throw new Error("桌面应用未写入独立日志目录");
  console.log(JSON.stringify({ ok: true, controlPort, onebotPort, stateIsolated: true, recoveredPortConflict: simulateConflict, attachedExternalHost: externalHost }));
  if (process.env.HERMES_QQ_SMOKE_UI === "1") await new Promise((resolve) => setTimeout(resolve, 90000));
  }
} finally {
  child.kill("SIGTERM");
  hostChild?.kill("SIGTERM");
  if (blocker?.listening) blocker.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (process.env.HERMES_QQ_SMOKE_KEEP !== "1") fs.rmSync(temp, { recursive: true, force: true });
}
