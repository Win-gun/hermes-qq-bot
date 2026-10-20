import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";

// Real bridge/API/CLI, synthetic data and a fake reverse OneBot only. The
// environment contains no provider credentials or real protocol endpoints.
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-memory-integration-"));
const memoryPath = path.join(home, "data", "memory.json");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, closed, socket, base, token = "", output = "";
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const exited = () => child && (child.exitCode !== null || child.signalCode !== null);
async function until(predicate, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (exited()) throw new Error(`${label}: isolated bridge exited`);
    if (await predicate()) return;
    await pause(30);
  }
  throw new Error(`${label}: timed out`);
}
async function stop() {
  socket?.terminate(); socket = null;
  if (!child) return;
  if (!exited()) child.kill("SIGTERM");
  if (!await Promise.race([closed.then(() => true), pause(1000).then(() => false)])) {
    child.kill("SIGKILL");
    await closed;
  }
  child = null;
}
async function request(route, method = "GET", body) {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(20000),
    headers: { ...(token ? { "x-hermes-qq-admin": token } : {}),
      ...(method === "POST" ? { origin: base, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function runCli(args, env) {
  const proc = spawn(process.execPath, [path.join(root, "scripts", "memory-rebuild.js"), ...args], { cwd: root, env });
  let text = "";
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => { text += chunk; });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 12000);
  const code = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
  clearTimeout(timer);
  return { code, text };
}

try {
  for (const dir of ["data", "bin", "hermes", "tmp"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  const fakeModel = path.join(home, "fake-model.cjs");
  fs.writeFileSync(fakeModel, `const fs=require("node:fs"),path=require("node:path");
const root=process.env.HERMES_QQ_HOME;
fs.writeFileSync(path.join(root,"model-started"),"yes");
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,"model-release"))){clearInterval(timer);process.stdout.write(JSON.stringify({preferences:["fixture rebuilt preference"],confidence:0.8}));}},20);
setTimeout(()=>{clearInterval(timer);process.exit(2);},10000).unref();\n`, { mode: 0o600 });
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { ...config.listen, host: "127.0.0.1", port: await freePort(), path: "/memory-fixture" };
  config.control = { ...config.control, enabled: true, host: "127.0.0.1", port: await freePort() };
  config.ai = { ...config.ai, command: process.execPath, args: [fakeModel], timeoutMs: 12000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "fixture", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.memory.aiExtraction.enabled = false;
  config.dailyMessages = { enabled: false, schedules: [] };
  delete config.hourlyChat;
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
    diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 },
    items: [{ id: "fixture", qq: "91001", displayName: "fixture bot", protocol: "napcat", enabled: true,
      managed: true, protocolContainer: "fixture-memory-container", protocolEnabled: true, onebotWsUrl: "", onebotPath: config.listen.path,
      features: { chat: false, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: false, image: false, record: false, video: false, file: false }, scope: { groups: true, private: true } }] };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })), { mode: 0o600 });
  const originalEntry = { id: "mem-fixture-old", kind: "preference", value: "fixture corrected preference",
    subjectUserId: "10001", status: "rejected", confidence: 0.8, correctedAt: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(memoryPath, JSON.stringify({ groups: { "810001": {
    settings: { quietUntil: Date.now() + 600000 }, users: { "10001": {
      names: ["fixture human"], profile: ["fixture original profile"], messageCount: 1,
      canonicalMemory: { subjectUserId: "10001", entries: [originalEntry], conflicts: [] }
    } }
  } } }), { mode: 0o600 });
  const env = { HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8",
    PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home,
    HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  function launch() {
    output = "";
    child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], { cwd: root, env });
    closed = new Promise((resolve) => child.once("close", resolve));
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-3000); });
  }
  launch(); base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { return (await request("/health")).status === 200; } catch { return false; } }, "startup");
  token = (await request("/api/admin/session")).data.token;
  assert.ok(token);
  const liveBefore = fs.readFileSync(memoryPath, "utf8");
  const cli = await runCli(["--apply", "--no-ai", "--report-dir", path.join(home, "offline-report")], env);
  assert.notEqual(cli.code, 0, "offline writer must refuse the live bridge");
  assert.equal(fs.readFileSync(memoryPath, "utf8"), liveBefore);
  const dry = await request("/api/memory/integrity/rebuild", "POST", { noAi: true });
  assert.equal(dry.status, 200);
  assert.equal(fs.readFileSync(memoryPath, "utf8"), liveBefore, "dry-run must not rewrite memory");

  socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  socket.on("message", (raw) => {
    const action = JSON.parse(String(raw));
    assert(!/^send_|^upload_/.test(action.action), "quiet fixture must not send messages");
    if (action.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
      data: action.action === "get_login_info" ? { user_id: "91001", nickname: "fixture bot" }
        : action.action === "get_status" ? { online: true, good: true } : {} }));
  });
  await until(() => socket.readyState === WebSocket.OPEN, "reverse socket");
  socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: "91001", status: { online: true, good: true } }));
  const pending = request("/api/memory/integrity/rebuild", "POST", { apply: true });
  await until(() => fs.existsSync(path.join(home, "model-started")), "candidate worker");
  assert.equal((await request("/api/memory/integrity/rebuild", "POST", { noAi: true })).status, 409, "rebuild jobs cannot overlap");
  socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: "91001", group_id: "810001", user_id: "10001",
    sender: { user_id: "10001", nickname: "fixture new name" }, message_id: "fixture-new-message", time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "fixture new message while rebuilding" } }] }));
  await until(() => JSON.parse(fs.readFileSync(memoryPath, "utf8")).groups["810001"].users["10001"].messageCount > 1, "concurrent collection");
  fs.writeFileSync(path.join(home, "model-release"), "yes");
  const conflict = await pending;
  assert.equal(conflict.status, 409, "new target evidence invalidates the old candidate");
  assert.equal(conflict.data.candidatePreserved, true);
  const afterConflict = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
  assert(afterConflict.groups["810001"].users["10001"].messageCount > 1);
  assert(afterConflict.groups["810001"].users["10001"].canonicalMemory.entries.some((item) => item.id === originalEntry.id && item.status === "rejected"));
  const applied = await request("/api/memory/integrity/rebuild", "POST", { apply: true, noAi: true });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.appliedTargets, 1);
  assert(fs.readdirSync(path.dirname(memoryPath)).some((name) => name.startsWith("memory.json.bak.")));
  const afterApply = fs.readFileSync(memoryPath, "utf8");
  const saved = JSON.parse(afterApply).groups["810001"].users["10001"];
  assert.equal(saved.messageCount, afterConflict.groups["810001"].users["10001"].messageCount);
  assert.deepEqual(saved.profile, ["fixture original profile"]);
  assert(saved.canonicalMemory.entries.some((item) => item.id === originalEntry.id && item.status === "rejected"));
  assert.equal((await request("/health")).data.memoryStorage.writer, true);
  await stop();

  const corrupt = '{"fixture-private-sentinel":';
  fs.writeFileSync(memoryPath, corrupt);
  launch();
  await Promise.race([closed, pause(5000)]);
  assert(exited(), "corrupt startup must fail closed, not run an empty memory");
  assert.equal(fs.readFileSync(memoryPath, "utf8"), corrupt);
  assert(!output.includes("fixture-private-sentinel"), "corrupt bytes must not enter diagnostic output");
  await stop();
  console.log("memory rebuild integration: live writer refusal, dry-run, concurrent collection/CAS, safe commit, quiet and corrupt-start protection passed");
} finally {
  await stop();
  fs.rmSync(home, { recursive: true, force: true });
}
