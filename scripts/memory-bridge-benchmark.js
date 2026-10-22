import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { readMemorySnapshot } from "../src/memory-repository.js";
import { ensureCanonicalMemory } from "../src/memory-integrity.js";

// node scripts/memory-bridge-benchmark.js
// Fixed workload/acceptance, not an adaptive diagnostic that shrinks a failing
// burst. Only source config.example.json is read; all runtime data is generated.
// No full snapshot reads/parses occur during the measured health/intake window.
// Intake = send -> post-durable collected-quiet stdout receipt (upper bound,
// including log/pipe scheduling); independently verified against disk twice.
// HTTP gap is an external responsiveness proxy, NOT in-process event-loop time.
const ROOT = path.resolve(import.meta.dirname, "..");
const TOTAL_MESSAGES = 24;
const HEALTH_LIMIT_MS = 250;
const PROBE_INTERVAL_MS = 25;
const DEADLINE_MS = 60_000;
const GROUPS = ["810001", "810002", "810003"];
const QUIET_UNTIL = Date.parse("9999-12-31T00:00:00Z");
const started = performance.now();
const deadline = started + DEADLINE_MS;
const failures = new Set();
const bridgeErrorCodes = new Set();
const bridgeErrorClasses = new Set();
const processes = new Set();
const allProcesses = new Set();
const sockets = new Set();
const sentAt = new Map();
const completed = new Map();
const agents = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw Object.assign(new Error(code), { benchmarkCode: code }); };
const check = (value, code) => { if (!value) fail(code); };
const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const percentile = (values, q) => values.length ? round([...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1]) : null;
const summary = {
  benchmark: "memory-bridge", fixtureOnly: true, status: "FAIL", stage: "setup",
  workload: { messages: TOTAL_MESSAGES, conversations: GROUPS.length, bursts: 1, targetMemoryBytes: 7 * 1024 * 1024 },
  acceptance: { maxHealthResponseGapMs: HEALTH_LIMIT_MS, deadlineMs: DEADLINE_MS },
  data: {}, intake: {}, health: {}, durability: {}, isolation: {}, cleanup: {}
};
let home, child, socket, base, config, env, monitoring = false, healthTask;
let aborted = false, socketError = false, unexpectedSends = 0, forbiddenActions = 0;
let queueFullCount = 0, inboundFailureCount = 0, guardViolations = 0;
let peakStoragePending = 0, peakQueuedTransactions = 0, storageFaults = 0, extractionFailures = 0;
let lastHealth = null;
const healthSamples = [], healthGaps = [], tickLags = [];
let healthErrors = 0, lastHealthAt = null;
let monitorTimer;
const abort = code => { aborted = true; failures.add(code); for (const item of processes) killGroup(item); };
const timer = setTimeout(() => abort("BENCH_DEADLINE_EXCEEDED"), DEADLINE_MS);
const interrupted = () => abort("BENCH_INTERRUPTED");
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

function killGroup(item) {
  if (!item?.process.pid) return;
  try { process.kill(-item.process.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") failures.add("BENCH_PROCESS_CLEANUP_FAILED"); }
}
function alive(item) { return item && item.process.exitCode === null && item.process.signalCode === null; }
async function until(predicate, code, timeout = 12_000) {
  const end = Math.min(deadline, performance.now() + timeout);
  while (!aborted && performance.now() < end) {
    check(!child || alive(child), "BENCH_BRIDGE_EXITED");
    check(!socketError, "BENCH_SOCKET_ERROR");
    if (await predicate()) return;
    await pause(20);
  }
  fail(aborted ? "BENCH_ABORTED" : code);
}
const usedPorts = new Set();
async function port() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const value = server.address().port;
    await new Promise(resolve => server.close(resolve));
    if (!usedPorts.has(value)) { usedPorts.add(value); return value; }
  }
  fail("BENCH_PORT_ALLOCATION_FAILED");
}
function request(route, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${route}`, { agent: healthAgent }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) response.destroy(new Error("BENCH_HTTP_TOO_LARGE"));
      });
      response.once("error", reject);
      response.once("end", () => {
        try { check(response.statusCode === 200, "BENCH_HTTP_STATUS"); resolve(JSON.parse(body)); }
        catch { reject(new Error("BENCH_HTTP_INVALID")); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error("BENCH_HTTP_TIMEOUT")), timeoutMs);
    request.once("close", () => clearTimeout(timeout));
    request.once("error", reject);
  });
}
const healthAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
agents.add(healthAgent);
function consumeLogs(stream) {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    partial += chunk;
    const lines = partial.split("\n"); partial = lines.pop();
    if (partial.length > 64 * 1024) { failures.add("BENCH_LOG_OVERFLOW"); partial = ""; }
    for (const line of lines) {
      for (const code of line.match(/\b(?:MEMORY|ACCOUNT|ERR)_[A-Z0-9_]{1,70}\b/g) || []) bridgeErrorCodes.add(code);
      for (const type of line.match(/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|MemoryStoreError)\b/g) || []) bridgeErrorClasses.add(type);
      if (line.includes("MEMORY_QUEUE_FULL")) queueFullCount++;
      if (line.includes("OneBot inbound processing failed")) inboundFailureCount++;
      if (line.includes("BENCH_GUARD_DENIED")) guardViolations++;
      if (!line.includes("disposition=collected-quiet")) continue;
      const id = line.match(/\bmsg=(bench-\d+)\b/)?.[1];
      if (sentAt.has(id) && !completed.has(id)) completed.set(id, performance.now() - sentAt.get(id));
    }
  });
}
async function launch() {
  const processChild = spawn(process.execPath, ["--require", path.join(home, "guard.cjs"), path.join(ROOT, "src", "bridge.js")], {
    cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const item = { process: processChild, spawnFailed: false };
  processes.add(item); allProcesses.add(item); child = item;
  item.closed = new Promise(resolve => {
    processChild.once("error", () => { item.spawnFailed = true; resolve(); });
    processChild.once("close", (code, signal) => {
      summary.lastBridgeExit = { code, signal }; resolve();
    });
  });
  consumeLogs(processChild.stdout); consumeLogs(processChild.stderr);
  await until(async () => {
    if (item.spawnFailed) fail("BENCH_SPAWN_FAILED");
    try {
      const health = await request("/health");
      return health.memoryStorage?.background === true && health.memoryStorage?.writable === true;
    } catch { return false; }
  }, "BENCH_STARTUP_TIMEOUT", 15_000);
}
async function stopBridge() {
  if (socket) { socket.terminate(); sockets.delete(socket); socket = null; }
  if (!child) return;
  const item = child;
  killGroup(item); // genuine SIGKILL + durable claim recovery, not graceful flush
  const closed = await Promise.race([item.closed.then(() => true), pause(2000).then(() => false)]);
  check(closed && !alive(item), "BENCH_PROCESS_CLEANUP_FAILED");
  processes.delete(item); child = null;
}
async function connect() {
  socketError = false;
  socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  sockets.add(socket);
  socket.on("error", () => { socketError = true; });
  socket.on("message", raw => {
    try {
      const action = JSON.parse(String(raw));
      if (/^(send_|upload_)/.test(action.action)) unexpectedSends++;
      const allowed = ["get_login_info", "get_status", "get_group_member_list", "get_group_info", "get_group_list", "get_friend_list"];
      if (!allowed.includes(action.action)) forbiddenActions++;
      if (action.echo && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
        data: action.action === "get_login_info" ? { user_id: "91001", nickname: "benchmark bot" }
          : action.action === "get_status" ? { online: true, good: true }
            : action.action === "get_group_member_list" ? [{ user_id: "91001" }, { user_id: "10001" }]
              : action.action.endsWith("_list") ? [] : {} }));
    } catch { socketError = true; }
  });
  await until(() => socket.readyState === WebSocket.OPEN, "BENCH_SOCKET_TIMEOUT");
  socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: "91001", status: { online: true, good: true } }));
}
function startMonitoring() {
  monitoring = true;
  let previousTick = performance.now();
  monitorTimer = setInterval(() => {
    const now = performance.now(); tickLags.push(Math.max(0, now - previousTick - PROBE_INTERVAL_MS)); previousTick = now;
  }, PROBE_INTERVAL_MS);
  healthTask = (async () => {
    while (monitoring && !aborted) {
      const begin = performance.now();
      try {
        const health = await request("/health");
        const end = performance.now();
        healthSamples.push(end - begin);
        if (lastHealthAt !== null) healthGaps.push(end - lastHealthAt);
        lastHealthAt = end; lastHealth = health;
        peakStoragePending = Math.max(peakStoragePending, Number(health.memoryStorage?.pending || 0));
        peakQueuedTransactions = Math.max(peakQueuedTransactions, Number(health.memoryStorage?.queuedTransactions || 0));
        if (health.memoryStorage?.recoveryRequired || health.memoryStorage?.lastError) storageFaults++;
        extractionFailures = Math.max(extractionFailures, Number(health.memoryExtraction?.failed || 0));
      } catch { healthErrors++; }
      if (monitoring) await pause(PROBE_INTERVAL_MS);
    }
  })();
}
async function stopMonitoring() {
  monitoring = false; clearInterval(monitorTimer);
  await healthTask;
}
const inputs = Array.from({ length: TOTAL_MESSAGES }, (_, index) => ({ id: `bench-${index}`,
  group: GROUPS[index % GROUPS.length], user: String(20001 + index), time: 1577836800 + index,
  text: `synthetic benchmark note ${String.fromCharCode(65 + index)}` }));
function verify(state) {
  let pending = 0, observations = 0, payloads = 0, acknowledged = 0, backpressured = 0;
  const batches = {};
  for (const groupId of GROUPS) {
    const group = state.groups?.[groupId];
    if (group?.memoryExtractionBackpressure) backpressured++;
    const batch = group?.memoryExtractionJobs?.batch;
    if (batch) batches[groupId] = { id: batch.id, keys: batch.keys, attempts: batch.attempts, status: batch.status };
  }
  for (const input of inputs) {
    const group = state.groups?.[input.group];
    const jobs = group?.memoryExtractionJobs;
    const row = jobs?.messages?.find(item => item.input.message_id === input.id)?.input;
    if (row) pending++;
    if (row?.user_id === input.user && row.text === input.text && row.sentAt === new Date(input.time * 1000).toISOString()) payloads++;
    if (jobs?.acknowledged?.includes(JSON.stringify([input.group, "id", input.id]))) acknowledged++;
    const user = group?.users?.[input.user];
    if (user?.messageCount === 1 && user.observationEvidence?.includes(JSON.stringify([input.group, input.id]))) observations++;
  }
  return { pending, observations, payloads, acknowledged, backpressured, batches };
}
function historyDigest(state) {
  const hash = createHash("sha256");
  for (const [id, group] of Object.entries(state.groups || {})) {
    if (GROUPS.includes(id)) continue;
    hash.update(id); hash.update(JSON.stringify(group.users)); hash.update(JSON.stringify(group.benchmarkHistory));
  }
  return hash.digest("hex");
}
async function snapshot() {
  let value;
  await until(() => {
    try { value = readMemorySnapshot(path.join(home, "data", "memory.json")); return true; }
    catch (error) { if (error.code === "MEMORY_READ_BUSY") return false; fail("BENCH_SNAPSHOT_FAILED"); }
  }, "BENCH_SNAPSHOT_TIMEOUT");
  return value;
}

try {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-bridge-benchmark-"));
  for (const directory of ["data", "tmp", "bin", "hermes"]) fs.mkdirSync(path.join(home, directory), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  // Mandatory fixture guard: network connections are loopback-only; subprocess
  // execution is restricted to our fake docker and Node/fake model, never Apps.
  fs.writeFileSync(path.join(home, "guard.cjs"), String.raw`
const net=require('node:net'),cp=require('node:child_process'),p=require('node:path');
const home=process.env.HERMES_QQ_HOME;
const deny=()=>{process.stderr.write('BENCH_GUARD_DENIED\n');throw new Error('BENCH_GUARD_DENIED');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  if(first&&typeof first==='object'&&first.path){if(!first.path.startsWith(home+p.sep))return deny();}
  else {const host=first&&typeof first==='object'?(first.host||'localhost'):(typeof args[1]==='string'?args[1]:'localhost');
    if(!['127.0.0.1','::1','localhost'].includes(host))return deny();}
  return connect.apply(this,args);
};
for(const method of ['spawn','spawnSync','execFile','execFileSync']){
  const original=cp[method];cp[method]=function(command,...args){
    if(command!==process.execPath&&command!=='docker'&&command!==p.join(home,'bin','docker'))return deny();
    return original.call(this,command,...args);
  };
}
cp.exec=cp.execSync=deny;
require('node:module').syncBuiltinESMExports();
`, { mode: 0o600 });
  const model = path.join(home, "model.cjs");
  fs.writeFileSync(model, String.raw`
const fs=require('node:fs'),p=require('node:path');
const home=process.env.HERMES_QQ_HOME;
fs.appendFileSync(p.join(home,'model-starts.jsonl'),JSON.stringify({pid:process.pid})+'\n');
// Remain in-flight through the burst and be killed with the fixture process group.
setInterval(()=>{},1000);
setTimeout(()=>process.exit(4),55000);
`, { mode: 0o600 });
  config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  config.listen = { host: "127.0.0.1", port: await port(), path: "/benchmark-fixture" };
  config.control = { enabled: true, host: "127.0.0.1", port: await port() };
  config.ai = { command: process.execPath, args: [model], provider: "custom", model: "synthetic-benchmark",
    credentialSource: "existing", apiKeyEnv: "FIXTURE_UNUSED_API_KEY", baseUrl: "http://127.0.0.1:9", timeoutMs: 55_000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "fixture", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.chatArchive = { ...config.chatArchive, enabled: false, defaultOn: false };
  config.observability = { ...config.observability, logIncomingMessages: true, logSkippedMessages: false };
  config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
  config.memory = { ...config.memory, enabled: true,
    learning: { enabled: false }, // Keep the established latency workload identical across versions.
    aiExtraction: { ...config.memory.aiExtraction, enabled: true, everyMessages: 4 } };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
    diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 }, items: [{ id: "fixture", qq: "91001",
      displayName: "benchmark bot", protocol: "napcat", enabled: true, managed: true,
      webuiPort: await port(), protocolEnabled: true, protocolContainer: "fixture-benchmark",
      onebotWsUrl: "", onebotPath: config.listen.path,
      features: { chat: false, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: true, image: false, record: false, video: false, file: false }, scope: { groups: true, private: true } }] };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })), { mode: 0o600 });
  const memory = { groups: {} };
  for (let group = 0; group < 24; group++) {
    memory.groups[String(820000 + group)] = {
      users: Object.fromEntries(Array.from({ length: 48 }, (_, index) => {
        const id = String(30000 + index);
        const user = { names: [`fixture ${index}`], profile: Array.from({ length: 7 }, (_, row) =>
          `fixture-${group}-${index}-${row} ${"synthetic context ".repeat(14)}`) };
        // Generate already-migrated state, not a legacy-import expansion test.
        ensureCanonicalMemory(user, id, { at: "2020-01-01T00:00:00Z", sourceConversationId: String(820000 + group) });
        return [id, user];
      })), benchmarkHistory: Array.from({ length: 16 }, (_, row) => `history-${row} ${"synthetic history ".repeat(12)}`)
    };
  }
  for (const groupId of GROUPS) memory.groups[groupId] = {
    settings: { quietUntil: QUIET_UNTIL, botSettings: { "account:fixture": { quietUntil: QUIET_UNTIL } } }, users: {}
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(memory));
  summary.data = { generatedBytes: initialBytes, generatedMiB: round(initialBytes / 1024 / 1024), bulkGroups: 24, bulkUsers: 1152 };
  check(initialBytes >= 6 * 1024 * 1024 && initialBytes <= 8 * 1024 * 1024, "BENCH_FIXTURE_SIZE_INVALID");
  const memoryFile = path.join(home, "data", "memory.json");
  fs.writeFileSync(memoryFile, JSON.stringify(memory), { mode: 0o600 });
  env = { HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8",
    PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home,
    HERMES_QQ_RESOURCE_ROOT: ROOT, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  base = `http://127.0.0.1:${config.control.port}`;
  summary.stage = "startup";
  await launch(); await connect();
  const baseline = await snapshot();
  const bulkDigest = historyDigest(baseline);
  summary.data.readySnapshotBytes = fs.statSync(memoryFile).size;
  summary.stage = "burst";
  startMonitoring();
  await pause(250);
  const burstStarted = performance.now();
  for (const input of inputs) {
    sentAt.set(input.id, performance.now());
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: "91001",
      group_id: input.group, user_id: input.user, message_id: input.id, time: input.time,
      sender: { user_id: input.user, nickname: "benchmark human", role: "member" },
      message: [{ type: "text", data: { text: input.text } }] }));
  }
  summary.workload.sendWindowMs = round(performance.now() - burstStarted);
  try { await until(() => completed.size === TOTAL_MESSAGES, "BENCH_INTAKE_TIMEOUT", 30_000); }
  catch (error) { failures.add(error.benchmarkCode || "BENCH_INTAKE_FAILED"); }
  const modelStartsFile = path.join(home, "model-starts.jsonl");
  // Intake's final receipt does not mean a claim queued behind it has saved.
  // A sweep may have skipped other conversations before they hit the threshold;
  // a held first model then keeps that shared sweep open. Require a real claim,
  // not two simultaneous models that a single burst does not guarantee.
  try {
    await until(() => fs.existsSync(modelStartsFile)
      && fs.readFileSync(modelStartsFile, "utf8").trim().split("\n").filter(Boolean).length >= 1,
    "BENCH_MODEL_START_TIMEOUT", 12_000);
  } catch (error) { failures.add(error.benchmarkCode || "BENCH_MODEL_START_FAILED"); }
  await pause(500);
  await stopMonitoring();
  summary.stage = "prestop-verification";
  const before = await snapshot();
  const pre = verify(before);
  const modelStarts = fs.existsSync(modelStartsFile) ? fs.readFileSync(modelStartsFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
  summary.durability.beforeStop = { pending: pre.pending, observations: pre.observations, payloads: pre.payloads,
    acknowledged: pre.acknowledged, backpressured: pre.backpressured, runningBatches: Object.values(pre.batches).filter(batch => batch.status === "running").length };
  if (pre.pending !== TOTAL_MESSAGES || pre.observations !== TOTAL_MESSAGES || pre.payloads !== TOTAL_MESSAGES) failures.add("BENCH_MESSAGE_LOSS_BEFORE_STOP");
  if (pre.acknowledged !== 0) failures.add("BENCH_HELD_MODEL_UNEXPECTED_ACK");
  if (pre.backpressured) failures.add("BENCH_EXTRACTION_BACKPRESSURE");
  if (!modelStarts || !Object.keys(pre.batches).length) failures.add("BENCH_EXTRACTION_NOT_EXERCISED");
  if (modelStarts > 2) failures.add("BENCH_EXTRACTION_CONCURRENCY_EXCEEDED");
  if (historyDigest(before) !== bulkDigest) failures.add("BENCH_BULK_MEMORY_CHANGED");
  summary.data.beforeStopSnapshotBytes = fs.statSync(memoryFile).size;
  summary.isolation.modelStarts = modelStarts;
  await stopBridge();
  summary.stage = "restart";
  await launch();
  const restarted = await snapshot();
  const post = verify(restarted);
  let recoveredBatches = 0;
  for (const [id, batch] of Object.entries(pre.batches)) {
    const after = post.batches[id];
    if (after?.id === batch.id && after.attempts === batch.attempts && after.status === "pending"
      && JSON.stringify(after.keys) === JSON.stringify(batch.keys)) recoveredBatches++;
    else failures.add("BENCH_BATCH_RECOVERY_CHANGED");
  }
  summary.durability.afterRestart = { pending: post.pending, observations: post.observations, payloads: post.payloads,
    acknowledged: post.acknowledged, recoveredBatches };
  if (post.pending !== TOTAL_MESSAGES || post.observations !== TOTAL_MESSAGES || post.payloads !== TOTAL_MESSAGES) failures.add("BENCH_MESSAGE_LOSS_AFTER_RESTART");
  if (historyDigest(restarted) !== bulkDigest) failures.add("BENCH_BULK_MEMORY_CHANGED_ON_RESTART");
  summary.data.restartSnapshotBytes = fs.statSync(memoryFile).size;
  summary.stage = "complete";
} catch (error) {
  failures.add(error.benchmarkCode || "BENCH_FIXTURE_FAILED");
} finally {
  await stopMonitoring();
  for (const value of sockets) value.terminate(); sockets.clear();
  try { await stopBridge(); } catch { failures.add("BENCH_PROCESS_CLEANUP_FAILED"); }
  for (const item of processes) {
    killGroup(item);
    await Promise.race([item.closed, pause(1500)]);
    if (alive(item)) failures.add("BENCH_PROCESS_CLEANUP_FAILED");
  }
  for (const agent of agents) agent.destroy();
  let modelCount = 0, modelsStopped = true;
  try {
    const file = home && path.join(home, "model-starts.jsonl");
    const pids = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).pid) : [];
    modelCount = pids.length;
    const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
    for (let attempt = 0; attempt < 20 && pids.some(live); attempt++) await pause(50);
    modelsStopped = pids.every(pid => !live(pid));
    if (!modelsStopped) failures.add("BENCH_MODEL_CLEANUP_FAILED");
  } catch { modelsStopped = false; failures.add("BENCH_MODEL_CLEANUP_FAILED"); }
  let removed = false;
  try { if (home) fs.rmSync(home, { recursive: true, force: true }); removed = !home || !fs.existsSync(home); }
  catch { failures.add("BENCH_DIRECTORY_CLEANUP_FAILED"); }
  clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  const maxLatency = Math.max(0, ...healthSamples), maxGap = Math.max(0, ...healthGaps);
  if (maxLatency > HEALTH_LIMIT_MS || maxGap > HEALTH_LIMIT_MS) failures.add("BENCH_MAIN_BLOCKING_OVER_250MS");
  if (healthSamples.length < 8) failures.add("BENCH_HEALTH_SAMPLE_COUNT_LOW");
  if (healthErrors) failures.add("BENCH_HEALTH_REQUEST_FAILED");
  if (completed.size !== TOTAL_MESSAGES) failures.add("BENCH_INTAKE_INCOMPLETE");
  if (queueFullCount) failures.add("BENCH_MEMORY_QUEUE_FULL");
  if (inboundFailureCount) failures.add("BENCH_INBOUND_PROCESSING_FAILED");
  if (storageFaults) failures.add("BENCH_STORAGE_FAULT");
  if (extractionFailures) failures.add("BENCH_EXTRACTION_FAILED");
  if (unexpectedSends || forbiddenActions || guardViolations) failures.add("BENCH_ISOLATION_VIOLATION");
  summary.intake = { sent: sentAt.size, completed: completed.size, missingCompletionCount: TOTAL_MESSAGES - completed.size,
    p50Ms: percentile([...completed.values()], 0.5), p95Ms: percentile([...completed.values()], 0.95),
    maxMs: completed.size ? round(Math.max(...completed.values())) : null,
    measurement: "send_to_post_durable_quiet_log_receipt_upper_bound", queueFullCount, inboundFailureCount };
  summary.health = { samples: healthSamples.length, errors: healthErrors, probeIntervalMs: PROBE_INTERVAL_MS,
    p50Ms: percentile(healthSamples, 0.5), p95Ms: percentile(healthSamples, 0.95),
    maxLatencyMs: round(maxLatency), maxResponseGapMs: round(maxGap),
    parentProbeMaxTimerLagMs: round(Math.max(0, ...tickLags)), peakStoragePending, peakQueuedTransactions,
    storageFaults, extractionFailures, pendingAtLastProbe: Number(lastHealth?.memoryExtraction?.pendingMessages || 0) };
  summary.isolation = { ...summary.isolation, unexpectedSends, forbiddenActions, guardViolations,
    loopbackOnly: true, subprocessGuard: true, inheritedCredentials: false };
  summary.cleanup = { directoriesRemoved: removed, bridgeProcessesStopped: [...allProcesses].every(item => !alive(item)),
    modelCount, modelsStopped };
  summary.failureCodes = [...failures].sort();
  summary.bridgeErrorCodes = [...bridgeErrorCodes].sort();
  summary.bridgeErrorClasses = [...bridgeErrorClasses].sort();
  summary.observedBottlenecks = [
    ...(queueFullCount ? ["BOUNDED_TRANSACTION_QUEUE_SATURATED"] : []),
    ...(maxLatency > HEALTH_LIMIT_MS || maxGap > HEALTH_LIMIT_MS ? ["HEALTH_RESPONSIVENESS_LIMIT_EXCEEDED"] : []),
    ...(completed.size && percentile([...completed.values()], 0.95) > 1000 ? ["DURABLE_INTAKE_TAIL_OVER_ONE_SECOND"] : [])
  ];
  summary.elapsedMs = round(performance.now() - started);
  summary.status = failures.size ? "FAIL" : "PASS";
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = failures.size ? 1 : 0;
}
