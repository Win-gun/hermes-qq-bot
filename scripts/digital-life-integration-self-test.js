import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { normalizeApiCenter } from "../src/api-center.js";
import { TaskRuntime } from "../src/task-runtime.js";

// Entire integration uses a disposable home, loopback model fixture and fake
// OneBot. No Hermes CLI, credentials, production QQ or native browser is used.
const root = path.resolve(import.meta.dirname, ".."), home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-dl30-")));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, closed, base, token, modelCalls = 0, modelPrompts = [], model;
const sockets = [], sends = [];
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function until(fn, name) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`fixture exited: ${name}`);
    if (await fn()) return;
    await pause(30);
  }
  throw new Error(`fixture timeout: ${name}`);
}
async function api(route, method = "GET", body, authenticated = true) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(5000),
    headers: { origin: base, "content-type": "application/json", ...(authenticated ? { "x-hermes-qq-admin": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  fs.mkdirSync(path.join(home, "bin")); fs.mkdirSync(path.join(home, "tmp"));
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1)`, { mode: 0o700 });
  model = http.createServer(async (req, res) => {
    let body = ""; for await (const data of req) body += data;
    const payload = JSON.parse(body); modelCalls++; modelPrompts.push(payload.messages.at(-1).content);
    assert.equal(payload.tools, undefined); // no native model tools
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: payload.messages.at(-1).content.includes("【WorkAgent】") ? JSON.stringify({ type: "complete", ok: true,
      summary: "合成文档已生成；内容未进行真人验收。", artifacts: [{ name: "fixture.md", type: "text/markdown", content: "# Fixture\nIsolated document result." }] }) : "Fixture direct reply." } }] }));
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { ...config.listen, host: "127.0.0.1", port: await port(), path: "/dl-fixture" };
  config.control = { ...config.control, host: "127.0.0.1", port: await port() };
  config.ai = { ...config.ai, command: "/fixture/never-run-cli", args: [], provider: "custom", model: "fixture-work",
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: "FIXTURE_MODEL_KEY", reasoningEffort: "none" };
  delete config.apiCenter; config.aiProfiles = { activeId: "fixture", profiles: [] };
  for (const key of ["webSearch", "vision", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "loginRecovery", "adminNotifications", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.memory.aiExtraction.enabled = false; config.memory.learning = { enabled: false };
  config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.socialAgent = { enabled: false }; config.trigger = { ...config.trigger, activeReply: false };
  config.privateChats = { ...config.privateChats, enabled: true, targetUsers: ["10001"], ownerUserIds: ["10001"] };
  config.taskMode = { ...config.taskMode, enabled: true, shadowMode: false, ownerUserIds: ["10001"],
    allowedGroupIds: ["810001"], workspaceBaseDir: "data/tasks", defaultToolsets: [], webResearchEnabled: false };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [], diagnostics: { enabled: false, peerPingEnabled: false },
    items: ["alpha", "beta"].map((id, index) => ({ id, qq: String(91001 + index), displayName: `Fixture ${id}`, protocol: "napcat",
      enabled: true, protocolEnabled: true, managed: true, onebotPath: config.listen.path, onebotWsUrl: "",
      style: { systemPrompt: `独立人格 ${id}，不继承另一账号。` }, features: { chat: true, task: true, proactive: false, automation: false },
      sendTypes: { text: true, file: true, image: false, record: false, video: false }, scope: { groups: true, private: true } })) };
  config.apiCenter = normalizeApiCenter(config);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })));
  const seed = new TaskRuntime({ rootDir: home, config, execute: async () => { throw Error("seed must not run"); }, notify: async () => false });
  const a = seed.createOffer({ accountId: "alpha", conversationId: "810001", messageType: "group", groupId: "810001", userId: "10001",
    objective: "生成一份合成 Markdown 文档", requestedTools: [], expectedArtifacts: ["fixture.md"] });
  const b = seed.createOffer({ accountId: "beta", conversationId: "810001", messageType: "group", groupId: "810001", userId: "10001",
    objective: "未确认任务，不应执行", requestedTools: [] });
  child = spawn(process.execPath, [path.join(root, "src/bridge.js")], { cwd: root, env: {
    HOME: home, TMPDIR: path.join(home, "tmp"), PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8", HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_HOME: path.join(home, "hermes"),
    HERMES_QQ_LOG_DIR: path.join(home, "logs"), FIXTURE_MODEL_KEY: "fixture-only-not-a-real-credential" }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", data => { errors = (errors + data).slice(-12000); });
  closed = new Promise(resolve => child.once("close", resolve)); base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { return (await api("/health", "GET", undefined, false)).status === 200; } catch { return false; } }, "start");
  token = (await api("/api/admin/session", "GET", undefined, false)).data.token;
  assert.equal((await api("/api/tasks", "GET", undefined, false)).status, 403);
  for (let index = 0; index < 2; index++) {
    const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`); sockets.push(socket);
    socket.on("message", raw => {
      const action = JSON.parse(raw); sends.push({ index, ...action });
      if (action.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
        data: action.action === "get_login_info" ? { user_id: String(91001 + index), nickname: `Fixture ${index}` }
          : action.action === "get_status" ? { online: true, good: true } : { message_id: "fixture-receipt" } }));
    });
    await until(() => socket.readyState === 1, "fake onebot");
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: String(91001 + index), status: { online: true, good: true } }));
  }
  await until(async () => (await api("/api/accounts")).data.statuses.filter(s => s.connected).length === 2, "accounts");
  assert.deepEqual((await api("/api/tasks?account_id=alpha")).data.tasks.map(t => t.id), [a.id]);
  assert.deepEqual((await api("/api/tasks?account_id=beta")).data.tasks.map(t => t.id), [b.id]);
  const life = (await api("/api/tasks/agent-life?account_id=alpha")).data;
  assert.equal(life.logicalBotId, "account:alpha"); assert.equal(life.policy.enabled, false);
  assert.equal(life.backends.filter(x => x.id !== "local").some(x => x.verified), false);
  for (const mode of ["direct", "social", "search", "task"]) {
    const preview = await api("/api/tasks/prompt-preview", "POST", { accountId: "alpha", mode });
    assert.equal(preview.status, 200); assert.match(preview.data.composition.text, /独立人格 alpha/);
    assert.doesNotMatch(preview.data.composition.text, /独立人格 beta|fixture-only-not-a-real-credential/);
  }
  const before = (await api(`/api/tasks/${a.id}`)).data.task;
  assert.equal((await api(`/api/tasks/${a.id}/resume`, "POST", { expectedRevision: -1 })).status, 409);
  assert.equal(modelCalls, 0);
  assert.equal((await api(`/api/tasks/${a.id}/resume`, "POST", { expectedRevision: before.revision })).status, 200);
  await until(async () => ["completed", "failed", "waiting_permission"].includes((await api(`/api/tasks/${a.id}`)).data.task.status), "completion");
  const result = (await api(`/api/tasks/${a.id}`)).data.task;
  assert.equal(result.status, "completed", `document failed: ${result.lastError || result.resultSummary}`);
  assert.equal(modelCalls, 1); assert.match(modelPrompts[0], /【WorkAgent】/);
  assert.ok(result.operationLedger.some(x => x.capability === "isolated_files" && x.status === "succeeded"));
  const artifact = (await api(`/api/tasks/${a.id}/artifacts`)).data.artifacts.find(x => x.name === "fixture.md");
  assert.ok(artifact);
  const artifactUrl = `${base}/api/tasks/${a.id}/artifacts/${encodeURIComponent(artifact.id)}`;
  assert.equal((await fetch(artifactUrl)).status, 403);
  const download = await fetch(artifactUrl, { headers: { "x-hermes-qq-admin": token } });
  assert.equal(download.status, 200); assert.match(await download.text(), /Isolated document/);
  const events = (await api(`/api/tasks/${a.id}/events`)).data.events;
  assert.ok(events.some(x => x.type === "operation")); assert.doesNotMatch(JSON.stringify(events), /credential|独立人格|Isolated document/);
  await until(async () => (await api("/api/tasks/agent-life?account_id=alpha")).data.episodes.some(e => e.taskId === a.id && e.status === "completed"), "durable experience");
  assert.equal((await api("/api/tasks/agent-life?account_id=beta")).data.episodes.some(e => e.taskId === a.id), false);
  assert.equal((await api(`/api/tasks/${b.id}`)).data.task.status, "offered");
  assert.equal(sends.filter(x => /^send_|^upload_/.test(x.action)).some(x => x.index === 1), false);
  const registry = (await api("/api/accounts")).data;
  assert.equal((await api("/api/accounts/alpha", "PATCH", { expectedRevision: registry.revision,
    patch: { digitalLife: { enabled: true, socialPreset: "balanced", work: { enabled: false } } } })).status, 200);
  sockets[0].send(JSON.stringify({ post_type: "message", message_type: "private", self_id: "91001", user_id: "10001",
    sender: { user_id: "10001", nickname: "Fixture human" }, message_id: "fixture-agent-direct", time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "你好，今天怎么样" } }] }));
  await until(() => sends.some(x => x.index === 0 && x.action === "send_private_msg" && JSON.stringify(x.params).includes("Fixture direct reply")), "opt-in text-only chat");
  assert.equal(modelCalls, 2); assert.match(modelPrompts[1], /【SocialSimulation】/);
  assert.doesNotMatch(modelPrompts[1], /独立人格 beta/);
  assert.doesNotMatch(errors, /ReferenceError|TypeError|TASK_STATE_PROJECTION_FAILED/);
  console.log(JSON.stringify({ ok: true, tests: 37, fixtureOnly: true, fakeModelCalls: modelCalls, realQqSends: 0, cliSpawns: 0 }));
} finally {
  for (const socket of sockets) socket.terminate();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([closed, pause(1500)]); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  fs.rmSync(home, { recursive: true, force: true });
}
