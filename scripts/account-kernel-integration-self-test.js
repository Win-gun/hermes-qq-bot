import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { normalizeApiCenter } from "../src/api-center.js";

// Real bridge and two reverse protocol sockets; fake models/docker; no live
// identity, keychain, browser, network provider or QQ group is ever used.
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-kernel-integration-"));
const sockets = [], actions = [], pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, closed, base, token = "", sequence = 0;
const exited = () => child && (child.exitCode !== null || child.signalCode !== null);
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}
async function until(predicate, name, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (exited()) throw new Error(`${name}: isolated bridge exited`);
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error(`${name}: fixture timeout`);
}
async function request(route, method = "GET", body) {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(6000),
    headers: { ...(token ? { "x-hermes-qq-admin": token } : {}),
      ...(method === "PATCH" ? { origin: base, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const readCalls = () => fs.existsSync(path.join(home, "calls.jsonl"))
  ? fs.readFileSync(path.join(home, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const callsFor = (model, type = "start") => readCalls().filter((item) => item.model === model && item.type === type).length;
const sentBy = (index) => actions.filter((item) => item.index === index && item.action === "send_group_msg");
function event(index, text, { command = false, sharedId } = {}) {
  return { post_type: "message", message_type: "group", self_id: String(91001 + index), group_id: "810001", user_id: "10001",
    sender: { user_id: "10001", nickname: "fixture human", role: "admin" }, message_id: sharedId || `fixture-${++sequence}`,
    time: Math.floor(Date.now() / 1000), message: [...(command ? [] : [{ type: "at", data: { qq: String(91001 + index) } }]),
      { type: "text", data: { text } }] };
}
async function edit(id, patch) {
  const current = await request("/api/accounts");
  const result = await request(`/api/accounts/${id}`, "PATCH", { expectedRevision: current.data.revision, patch });
  assert.equal(result.status, 200, "isolated account edit must succeed");
}
async function stop() {
  for (const socket of sockets) socket.terminate();
  if (!child) return;
  if (!exited()) child.kill("SIGTERM");
  if (!await Promise.race([closed.then(() => true), pause(1000).then(() => false)])) { child.kill("SIGKILL"); await closed; }
}
try {
  for (const name of ["data", "tmp", "bin", "hermes"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  const model = path.join(home, "fixture-model.cjs");
  fs.writeFileSync(model, `#!${process.execPath}
const fs=require("node:fs"),p=require("node:path"),root=process.env.HERMES_QQ_HOME,args=process.argv.slice(2);
const i=args.indexOf("-m"),model=i>=0?args[i+1]:"unknown";
const log=type=>fs.appendFileSync(p.join(root,"calls.jsonl"),JSON.stringify({type,model})+"\\n");
log("start");process.on("SIGTERM",()=>{log("cancel");process.exit(0);});
const timer=setInterval(()=>{if(fs.existsSync(p.join(root,"release-"+model))){clearInterval(timer);process.stdout.write("fixture response "+model);}},15);
setTimeout(()=>process.exit(3),20000).unref();\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home, "release-fixture-b"), "yes");
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { ...config.listen, host: "127.0.0.1", port: await port(), path: "/kernel-fixture" };
  config.control = { ...config.control, host: "127.0.0.1", port: await port() };
  config.ai = { ...config.ai, command: model, args: [], provider: "custom", model: "fixture-a", reasoningEffort: "none", timeoutMs: 25000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "fixture", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.memory.aiExtraction.enabled = false;
  config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
  config.responseQueue = { enabled: true, minDelayMs: 1000, liveContext: { enabled: true, settleMs: 0, maxRegenerations: 2 } };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [], diagnostics: { peerPingEnabled: false },
    items: ["alpha", "beta"].map((id, index) => ({ id, qq: String(91001 + index), displayName: `fixture ${id}`,
      protocol: "napcat", managed: true, enabled: true, protocolEnabled: true, protocolContainer: `fixture-${id}`,
      onebotPath: config.listen.path, style: { systemPrompt: `fixture style ${id}` }, modelBindings: { chat: `chat-${id}` },
      features: { chat: true, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: true, image: false, record: false, video: false, file: false }, scope: { groups: true, private: true } })) };
  const center = normalizeApiCenter(config);
  const original = center.profiles.find((profile) => profile.id === center.bindings.chat);
  center.profiles.push({ ...original, id: "chat-alpha", model: "fixture-a" }, { ...original, id: "chat-beta", model: "fixture-b" });
  config.apiCenter = center;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })), { mode: 0o600 });
  const env = { HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8", HERMES_HOME: path.join(home, "hermes"),
    PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.resume(); closed = new Promise((resolve) => child.once("close", resolve));
  base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { return (await request("/health")).status === 200; } catch { return false; } }, "startup");
  token = (await request("/api/admin/session")).data.token;
  for (let index = 0; index < 2; index += 1) {
    const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`); sockets.push(socket);
    socket.on("message", (raw) => {
      const action = JSON.parse(String(raw)); actions.push({ index, at: Date.now(), ...action });
      if (action.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
        data: action.action === "get_login_info" ? { user_id: String(91001 + index), nickname: `fixture ${index}` }
          : action.action === "get_status" ? { online: true, good: true }
            : action.action === "get_group_member_list" ? [{ user_id: "91001" }, { user_id: "91002" }, { user_id: "10001" }]
              : { message_id: `fixture-response-${++sequence}` } }));
    });
    await until(() => socket.readyState === WebSocket.OPEN, "socket");
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: String(91001 + index), status: { online: true, good: true } }));
  }
  await until(async () => (await request("/api/accounts")).data.statuses.filter((item) => item.connected).length === 2, "two connections");
  sockets[0].send(JSON.stringify(event(0, "fixture slow question A")));
  await until(() => callsFor("fixture-a") === 1, "A generation begins");
  sockets[1].send(JSON.stringify(event(1, "fixture fast question B")));
  await until(() => sentBy(1).length === 1, "B answers while A waits");
  assert.equal(sentBy(0).length, 0);
  await edit("beta", { style: { systemPrompt: "fixture changed beta only" } });
  assert.equal(callsFor("fixture-a", "cancel"), 0, "B's edit cannot cancel A");
  fs.writeFileSync(path.join(home, "release-fixture-a"), "yes");
  await until(() => sentBy(0).length === 1, "A answers after release");
  assert.equal(callsFor("fixture-a"), 1);
  await until(async () => (await request("/health")).data.replyCoordinator.activeCount === 0, "first lanes drain");

  fs.rmSync(path.join(home, "release-fixture-a"));
  sockets[0].send(JSON.stringify(event(0, "fixture second A question")));
  await until(() => callsFor("fixture-a") === 2, "second A begins");
  await edit("alpha", { style: { systemPrompt: "fixture new alpha style" } });
  await until(() => callsFor("fixture-a") === 3, "own edit restarts A");
  assert.equal(callsFor("fixture-b"), 1);
  fs.writeFileSync(path.join(home, "release-fixture-a"), "yes");
  await until(() => sentBy(0).length === 2, "regenerated A sends once");
  await until(async () => (await request("/health")).data.replyCoordinator.activeCount === 0, "second lane drains");
  const commandId = `fixture-command-${++sequence}`;
  for (let index = 0; index < 2; index += 1) sockets[index].send(JSON.stringify(event(index, "/bot a quiet 10m", { command: true, sharedId: commandId })));
  await until(() => {
    const file = path.join(home, "data", "memory.json");
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).groups?.["810001"]?.settings?.botSettings?.["account:alpha"]?.quietUntil > Date.now();
  }, "A-scoped quiet");
  const aCallsBefore = callsFor("fixture-a");
  sockets[0].send(JSON.stringify(event(0, "fixture quiet A question")));
  sockets[1].send(JSON.stringify(event(1, "fixture B remains responsive")));
  await until(() => sentBy(1).length === 2, "B unaffected by A quiet");
  assert.equal(callsFor("fixture-a"), aCallsBefore);
  assert.equal(sentBy(0).length, 2);
  const wires = actions.filter((item) => item.action === "send_group_msg");
  for (let index = 1; index < wires.length; index += 1) assert(wires[index].at - wires[index - 1].at >= 950, "shared group spacing is retained");
  const health = (await request("/health")).data;
  assert.deepEqual(health.logicalBots.map((item) => item.logicalBotId).sort(), ["account:alpha", "account:beta"]);
  console.log("account kernel integration: independent generation, scoped policy refresh, private model bindings, targeted quiet and shared spacing passed");
} finally {
  await stop(); fs.rmSync(home, { recursive: true, force: true });
}
