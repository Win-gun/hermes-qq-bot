import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { registryConfig } from "../src/account-registry.js";

// Run with an absolute, working Node >=22.12 executable:
// /absolute/path/to/node /absolute/path/to/this-script.js [--self-check]
// --self-check validates only this fixture; it never starts/imports the bridge.
// All writes, HOME, Hermes and protocol state are disposable. No live config,
// QQ login, Docker daemon, provider, credentials or launchctl are used.
const root = path.resolve(import.meta.dirname, "..");
const selfCheck = process.argv.includes("--self-check");
assert.ok(process.argv.slice(2).every((arg) => arg === "--self-check"), "unknown argument");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-bot-routing-"));
const configFile = path.join(home, "config.json");
const ids = ["fixture-absent", "fixture-alpha", "fixture-beta", "fixture-pair-main", "fixture-pair-spare", "fixture-disabled", "fixture-out-of-scope"];
const qqs = ids.map((_, index) => String(91000 + index));
const A = 1, B = 2, MAIN = 3, SPARE = 4, HUMAN = "10001", MEMBER = "10002";
const G = { multi: "810101", single: "810102", filtered: "810103", offlineB: "810104", offlineA: "810105",
  fallback: "810106", fallbackSingle: "810107", logical: "810108", other: "810109", quiet: "810110", voicePreset: "810111" };
const members = new Map([
  [G.multi, [qqs[B], HUMAN, MEMBER, qqs[A]]], // Deliberately not registry order.
  [G.single, [qqs[B], HUMAN]],
  [G.filtered, [qqs[6], qqs[5], qqs[B], qqs[A], HUMAN]],
  [G.offlineB, [qqs[A], qqs[B], HUMAN]], [G.offlineA, [qqs[A], qqs[B], HUMAN]],
  [G.fallback, [qqs[A], qqs[B], HUMAN]], [G.fallbackSingle, [qqs[B], HUMAN]],
  [G.logical, [qqs[SPARE], qqs[MAIN], qqs[A], HUMAN]], [G.quiet, [qqs[A], qqs[B], HUMAN]],
  [G.voicePreset, [qqs[A], qqs[B], HUMAN]]
]);
const failingLists = new Set([G.fallback, G.fallbackSingle]);
const sockets = new Map(), actions = [], results = [];
const dockerLog = path.join(home, "docker-attempts.jsonl");
const hermesLog = path.join(home, "hermes-calls.jsonl");
const deadline = Date.now() + 90_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, childClosed, base, token = "", sequence = 0, selfServer;
const exited = (proc) => proc && (proc.exitCode !== null || proc.signalCode !== null);
const safeError = (error) => String(error.message).replaceAll(token || "__no_token__", "[session]").replaceAll(home, "[fixture]").slice(0, 1600);
const jsonLines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const hardStop = setTimeout(() => {
  for (const socket of sockets.values()) socket.terminate();
  child?.kill("SIGKILL");
  for (const socket of selfServer?.clients || []) socket.terminate();
}, 91_000);

async function until(predicate, label, timeoutMs = 4500) {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < end) {
    if (exited(child)) throw new Error(`isolated bridge exited (${child.exitCode ?? child.signalCode}); no live fallback permitted`);
    const value = await predicate();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`${label}: timeout ${timeoutMs}ms`);
}

async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: safeError(error) }); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopBridge() {
  if (!child) return;
  if (!exited(child)) child.kill("SIGTERM");
  const closedWithin = (ms) => Promise.race([childClosed.then(() => true), pause(ms).then(() => false)]);
  if (await closedWithin(1500)) return;
  if (!exited(child)) child.kill("SIGKILL");
  assert.ok(await closedWithin(1500), "fixture child must close before removing state");
}

async function request(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(2000),
    headers: token ? { "x-hermes-qq-admin": token } : {} });
  assert.equal(response.status, 200, `fixture GET ${route}`);
  return response.json();
}

// A strict fake: unimplemented OneBot actions fail instead of looking successful.
function mockResponse(index, action) {
  const ok = (data) => ({ status: "ok", retcode: 0, echo: action.echo, data });
  const fail = (message) => ({ status: "failed", retcode: 100, echo: action.echo, data: null, message });
  if (action.action === "get_login_info") return ok({ user_id: Number(qqs[index]), nickname: ids[index] });
  if (action.action === "get_status") return ok({ online: true, good: true });
  if (action.action === "get_group_member_list") {
    const group = String(action.params?.group_id);
    if (failingLists.has(group)) return fail("fixture-member-list-unavailable");
    if (!members.has(group)) return fail("fixture-unknown-group");
    // Numeric user_id matches real OneBot payloads, including non-bot members.
    return ok(members.get(group).map((qq) => ({ user_id: Number(qq) })));
  }
  if (["send_group_msg", "send_private_msg"].includes(action.action)) return ok({ message_id: ++sequence });
  return fail(`fixture-unsupported-action:${action.action}`);
}

function attachMock(socket, index) {
  socket.on("message", (raw) => {
    try {
      const action = JSON.parse(String(raw));
      actions.push({ ...action, id: ids[index] });
      if (action.echo !== undefined && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(mockResponse(index, action)));
    } catch { results.push({ name: "mock protocol JSON", ok: false, error: "invalid OneBot request JSON" }); }
  });
}

async function connect(index) {
  const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  sockets.set(index, socket);
  socket.on("error", () => {}); // until() provides bounded failure diagnostics.
  attachMock(socket, index);
  await until(() => socket.readyState === WebSocket.OPEN, `mock WS open ${ids[index]}`);
  socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: Number(qqs[index]), status: { online: true, good: true } }));
  await until(async () => (await request("/api/accounts")).statuses.some((item) => item.id === ids[index] && item.connected), `mock identity ${ids[index]}`);
}

async function disconnect(index) {
  const socket = sockets.get(index);
  socket.close();
  await until(() => socket.readyState === WebSocket.CLOSED, `mock WS close ${ids[index]}`);
  await until(async () => (await request("/api/accounts")).statuses.some((item) => item.id === ids[index] && !item.connected), `bridge observes offline ${ids[index]}`);
}

function emit(text, { group = G.multi, privateTo, recipients, role = "admin", userId = HUMAN, mention } = {}) {
  const messageId = ++sequence;
  const selected = privateTo === undefined
    ? recipients || [...sockets.keys()].filter((index) => members.get(group)?.includes(qqs[index]))
    : [privateTo];
  // Deliver the later registry account first: routing cannot depend on arrival.
  for (const index of [...selected].sort((a, b) => b - a)) {
    const socket = sockets.get(index);
    if (socket?.readyState !== WebSocket.OPEN) continue;
    socket.send(JSON.stringify({ post_type: "message", message_type: privateTo === undefined ? "group" : "private",
      sub_type: privateTo === undefined ? "normal" : "friend", self_id: Number(qqs[index]), user_id: Number(userId),
      ...(privateTo === undefined ? { group_id: Number(group) } : {}),
      sender: { user_id: Number(userId), nickname: "fixture-human", role }, message_id: messageId,
      time: Math.floor(Date.now() / 1000), raw_message: mention === undefined ? text : `[CQ:at,qq=${qqs[mention]}] ${text}`,
      message: [...(mention === undefined ? [] : [{ type: "at", data: { qq: qqs[mention] } }]), { type: "text", data: { text } }] }));
  }
}

const sendsSince = (offset) => actions.slice(offset).filter((item) => ["send_group_msg", "send_private_msg"].includes(item.action));
function replyText(action) {
  const message = action.params.message;
  const text = Array.isArray(message) ? message.filter((item) => item.type === "text").map((item) => item.data.text).join("") : String(message);
  // CQ-string transports prepend a different quoted message ID to every reply.
  // Strip only that metadata; retain actual command feedback and its selectors.
  return text.replace(/^(?:\[CQ:reply,[^\]]+\]\s*)+/u, "");
}

async function observeMembers(group, recipients) {
  // The bridge observes membership before ignoring its own messages. These
  // fixtures cannot trigger a normal chat/model reply or pollute later cases.
  for (const index of recipients) emit("fixture own membership observation", { group, recipients: [index], userId: qqs[index] });
  await pause(150);
}

function assertSends(sent, expected, options = {}) {
  assert.deepEqual(sent.map((item) => item.id), expected.map((index) => ids[index]), "exactly the designated bot(s), without duplicate sends");
  for (const action of sent) {
    assert.equal(action.action, options.privateTo === undefined ? "send_group_msg" : "send_private_msg");
    assert.equal(String(options.privateTo === undefined ? action.params.group_id : action.params.user_id),
      options.privateTo === undefined ? options.group || G.multi : HUMAN, "reply destination must not leak to another conversation");
  }
}

async function command(text, expected, options = {}) {
  const offset = actions.length;
  emit(text, options);
  if (expected.length) await until(() => sendsSince(offset).length >= expected.length, `reply to ${text}`);
  // Check absence/late duplicates too, not only the first successful reply.
  await pause(expected.length ? 350 : 650);
  const sent = sendsSince(offset);
  assertSends(sent, expected, options);
  return sent.map(replyText);
}

function assertChoices(text, entries) {
  const aliases = [...text.matchAll(/^\s*\/bot\s+([a-z]+)\b/gm)].map((match) => match[1]);
  assert.deepEqual(aliases, entries.map(([alias]) => alias), "one ordered listing per logical bot, with no phantom member");
  for (const [alias, index] of entries) assert.match(text, new RegExp(`/bot\\s+${alias}\\b[^\\n]*${ids[index]}`));
}

function modeFrom(text) {
  const match = text.match(/(?:模式|mode)[^\n]*(normal|lively|restrained)\b/i);
  assert.ok(match, "mode response must expose its current mode");
  return match[1].toLowerCase();
}

async function modes(group = G.multi) {
  return [modeFrom((await command("/bot a mode", [A], { group }))[0]), modeFrom((await command("/bot b mode", [B], { group }))[0])];
}

// Read only the temporary state, using the parent's now-established layout.
const controls = (group) => {
  const settings = JSON.parse(fs.readFileSync(path.join(home, "data", "memory.json"), "utf8")).groups?.[group]?.settings || {};
  return Object.fromEntries(["quietUntil", "behaviorMode", "voiceReplyMode", "voicePreset", "learningMode", "botSettings"]
    .filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
};

let config;
async function setup() {
  for (const dir of ["bin", "hermes", "tmp", "data", "logs", "xdg"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  assert.ok(path.isAbsolute(process.execPath), "mock shebangs and children require absolute Node process.execPath");
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(process.argv.slice(2))+"\\n");\nprocess.exit(97);\n`, { mode: 0o700 });
  const hermes = path.join(home, "bin", "hermes");
  fs.writeFileSync(hermes, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(hermesLog)}, JSON.stringify(process.argv.slice(2))+"\\n");\nprocess.stdout.write("fixture Hermes reply\\n");\n`, { mode: 0o700 });
  // Read ONLY the safe example, never config.json from the shared checkout.
  config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { host: "127.0.0.1", port: await freePort(), path: "/fixture-bot-command" };
  do { config.control = { ...config.control, enabled: true, host: "127.0.0.1", port: await freePort() }; }
  while (config.control.port === config.listen.port);
  config.ai = { ...config.ai, command: hermes, args: [], timeoutMs: 2000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "default", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "hourlyChat"])
    config[key] = { ...config[key], enabled: false };
  config.memory = { ...config.memory, aiExtraction: { ...config.memory?.aiExtraction, enabled: false } };
  config.chatArchive = { ...config.chatArchive, enabled: false, saveImages: false };
  config.commands = { ...config.commands, enabled: true, adminUserIds: [HUMAN], chunkDelayMs: 1 };
  config.privateChats = { ...config.privateChats, enabled: true, targetUsers: [HUMAN], ownerUserIds: [HUMAN] };
  config.trigger = { ...config.trigger, ignoreOwnMessages: true, replyToAt: true, replyToKeywords: false, activeReply: false, activeProbability: 0 };
  config.botNames = ["fixture-never-trigger"];
  config.behaviorModes = { ...config.behaviorModes, default: "normal" };
  config.responseQueue = { enabled: true, minDelayMs: 5, liveContext: { enabled: false, settleMs: 0 } };
  config.send = { ...config.send, maxLength: 4000 };
  config.botFeatures = { defaultMode: "chat", accountModes: {}, interBot: { enabled: false } };
  // Enabling the switch allows mode changes; ASR/TTS execution is never requested.
  // There is no provider secret or inherited environment in the isolated child.
  config.voice = { ...config.voice, enabled: true, replyMode: "off", aiJudge: { enabled: false },
    asr: { enabled: false }, tts: { ...config.voice?.tts, enabled: true, model: "mimo-v2.5-tts",
      voice: "mimo_default", allowedVoices: ["mimo_default", "冰糖"] }, voiceClone: { enabled: false } };
  config.accounts = { version: 2, topology: "function_split", diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 },
    items: ids.map((id, index) => ({ id, qq: qqs[index], displayName: id, protocol: "napcat", managed: true,
      enabled: index !== 5, protocolEnabled: true, archived: false, protocolContainer: `fixture-routing-${index}`,
      onebotPath: config.listen.path, onebotWsUrl: "", webuiPort: 22000 + index * 4, behaviorMode: "normal",
      features: { chat: true, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: true, image: false, record: false, video: false, file: false },
      scope: { groups: true, private: true, groupMode: "allowlist", groupIds: index === 6 ? [G.other] : index === MAIN || index === SPARE ? [G.logical] : Object.values(G) },
      voice: { mode: "inherit", preset: "" } })),
    failoverGroups: [{ id: "fixture-logical-pair", name: "fixture logical pair", memberIds: [ids[MAIN], ids[SPARE]],
      policyAccountId: ids[MAIN], policy: {}, settings: { enabled: false, announceInGroups: false } }] };
  config = registryConfig(config, { strict: true });
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "data", "memory.json"), JSON.stringify({ groups: {} }), { mode: 0o600 });
  return { HOME: home, TMPDIR: path.join(home, "tmp"), PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8",
    HERMES_HOME: path.join(home, "hermes"), XDG_CONFIG_HOME: path.join(home, "xdg"),
    HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
}

async function runSelfCheck(env) {
  await test("fixture config is strict-valid and isolated", async () => {
    assert.deepEqual(registryConfig(JSON.parse(fs.readFileSync(configFile, "utf8")), { strict: true }), config);
    for (const key of ["HOME", "TMPDIR", "HERMES_HOME", "HERMES_QQ_HOME", "HERMES_QQ_LOG_DIR", "XDG_CONFIG_HOME"])
      assert.ok(env[key] === home || env[key].startsWith(`${home}${path.sep}`), key);
    assert.ok(!Object.keys(env).some((key) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
    assert.deepEqual(config.accounts.items.map((item) => item.qq), qqs);
    assert.equal(config.accounts.failoverGroups.length, 1);
  });
  await test("fixture subprocess uses absolute Node and local fake Hermes/Docker only", async () => {
    const run = (file, args) => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [file, ...args], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      proc.stdout.on("data", (chunk) => { text += chunk; });
      proc.once("error", reject);
      proc.once("close", (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    assert.deepEqual(await run(config.ai.command, ["fixture-only"]), { code: 0, text: "fixture Hermes reply\n" });
    assert.equal((await run(path.join(home, "bin", "docker"), ["fixture-denied"])).code, 97);
    assert.deepEqual(jsonLines(hermesLog), [["fixture-only"]]);
    assert.deepEqual(jsonLines(dockerLog), [["fixture-denied"]]);
  });
  await test("mock OneBot WS roundtrip: identity/status/member list/failure/send ack", async () => {
    selfServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve, reject) => { selfServer.once("listening", resolve); selfServer.once("error", reject); });
    selfServer.on("connection", (socket) => attachMock(socket, A));
    const socket = new WebSocket(`ws://127.0.0.1:${selfServer.address().port}`);
    sockets.set(A, socket);
    const replies = new Map();
    socket.on("error", () => {});
    socket.on("message", (raw) => { const reply = JSON.parse(String(raw)); replies.set(reply.echo, reply); });
    await until(() => socket.readyState === WebSocket.OPEN, "self-check WS open");
    const call = async (action, params = {}) => {
      const echo = `self-check-${++sequence}`;
      socket.send(JSON.stringify({ action, params, echo }));
      return until(() => replies.get(echo), `self-check ${action}`);
    };
    assert.equal((await call("get_login_info")).data.user_id, Number(qqs[A]));
    assert.deepEqual((await call("get_status")).data, { online: true, good: true });
    assert.deepEqual((await call("get_group_member_list", { group_id: Number(G.multi) })).data,
      members.get(G.multi).map((qq) => ({ user_id: Number(qq) })));
    const failed = await call("get_group_member_list", { group_id: G.fallback });
    assert.equal(failed.status, "failed"); assert.equal(failed.data, null);
    for (const action of ["send_group_msg", "send_private_msg"]) {
      const reply = await call(action, { group_id: G.multi, user_id: HUMAN, message: "fixture only" });
      assert.equal(reply.retcode, 0); assert.ok(reply.data.message_id);
    }
    assert.equal((await call("unsupported-fixture-action")).status, "failed");
    socket.close();
    await until(() => socket.readyState === WebSocket.CLOSED, "self-check WS closed");
  });
  await test("send assertions reject duplicate/wrong bot/wrong destination", async () => {
    const good = { id: ids[A], action: "send_group_msg", params: { group_id: G.multi, message: [{ type: "text", data: { text: "模式：正常 normal" } }] } };
    assertSends([good], [A]);
    assert.throws(() => assertSends([good, good], [A]));
    assert.throws(() => assertSends([{ ...good, id: ids[B] }], [A]));
    assert.throws(() => assertSends([{ ...good, params: { ...good.params, group_id: G.other } }], [A]));
    assert.equal(modeFrom(replyText(good)), "normal");
    assert.equal(replyText({ params: { message: "[CQ:reply,id=999]模式：正常 normal" } }), replyText(good));
    assertChoices(`/bot a → ${ids[A]}\n/bot b → ${ids[B]}\n例如：/bot a status、/bot b voice mixed`, [["a", A], ["b", B]]);
    assert.throws(() => assertChoices(`/bot a → ${ids[0]}\n/bot b → ${ids[A]}`, [["a", A], ["b", B]]));
  });
}

async function runIntegration(env) {
  child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], { cwd: home, env, stdio: ["ignore", "ignore", "ignore"] });
  childClosed = new Promise((resolve) => child.once("close", resolve));
  child.on("error", () => {});
  base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { await request("/health"); return true; } catch { return false; } }, "isolated bridge startup");
  token = (await request("/api/admin/session")).token;
  assert.ok(token, "isolated admin session required");
  for (let index = 0; index < ids.length; index++) await connect(index);

  await test("multi-bot bare/no-selector commands give one fixed hint and do not mutate controls", async () => {
    const before = await modes();
    const voices = [(await command("/bot a voice status", [A]))[0], (await command("/bot b voice status", [B]))[0]];
    const diskBefore = fs.readFileSync(configFile, "utf8");
    for (const text of ["/bot", "/bot mode", "/bot mode restrained"]) {
      const [hint] = await command(text, [A]);
      assertChoices(hint, [["a", A], ["b", B]]);
    }
    assert.deepEqual(await modes(), before);
    assert.equal((await command("/bot a voice status", [A]))[0], voices[0]);
    assert.equal((await command("/bot b voice status", [B]))[0], voices[1]);
    assert.equal(fs.readFileSync(configFile, "utf8"), diskBefore, "hint must not change registry/config");
  });
  await test("explicit a/b status each produces exactly one target response", async () => {
    for (const [alias, index] of [["a", A], ["b", B]]) {
      const [text] = await command(`/bot ${alias} status`, [index]);
      assert.match(text, /状态/); assert.equal(modeFrom(text), "normal");
    }
  });
  await test("b mode changes b only (observable subsequent mode/status)", async () => {
    await command("/bot b mode restrained", [B]);
    assert.deepEqual(await modes(), ["normal", "restrained"]);
    assert.equal(modeFrom((await command("/bot a status", [A]))[0]), "normal");
    assert.equal(modeFrom((await command("/bot b status", [B]))[0]), "restrained");
  });
  await test("ordinary member cannot change b mode; only b rejects and all controls remain unchanged", async () => {
    const beforeModes = await modes();
    const beforeControls = controls(G.multi);
    const beforeConfig = fs.readFileSync(configFile, "utf8");
    const [text] = await command("/bot b mode lively", [B], { role: "member", userId: MEMBER });
    assert.match(text, /群主|管理员|权限/);
    assert.deepEqual(controls(G.multi), beforeControls);
    assert.equal(fs.readFileSync(configFile, "utf8"), beforeConfig);
    assert.deepEqual(await modes(), beforeModes);
  });
  await test("b voice changes b only without ASR/TTS/provider calls", async () => {
    const beforeA = (await command("/bot a voice status", [A]))[0];
    assert.match(beforeA, /语音模式：关闭/);
    await command("/bot b voice mixed", [B]);
    assert.match((await command("/bot b voice status", [B]))[0], /语音模式：混合/);
    assert.equal((await command("/bot a voice status", [A]))[0], beforeA);
  });
  await test("native @a /voice preset creates only a's overlay in a fresh group; b's preset stays unchanged", async () => {
    const options = { group: G.voicePreset };
    assert.deepEqual(controls(G.voicePreset), {}, "regression requires a fresh group with no pre-existing overlays");
    const callsBefore = jsonLines(hermesLog).length;
    const [confirmation] = await command("/voice preset 冰糖", [A], { ...options, mention: A });
    assert.match(confirmation, /音色换成「冰糖」/);
    const after = controls(G.voicePreset);
    assert.deepEqual(Object.keys(after.botSettings || {}), [`account:${ids[A]}`], "native voice command must not create or update b's overlay");
    assert.equal(after.botSettings[`account:${ids[A]}`].voicePreset, "冰糖");
    assert.ok(after.botSettings[`account:${ids[A]}`].voicePresetUpdatedAt > 0);
    assert.equal(after.voicePreset, undefined, "shared group preset must remain untouched");
    assert.equal(after.voicePresetUpdatedAt, undefined, "shared group cooldown must remain untouched");
    assert.match((await command("/bot a voice status", [A], options))[0], /音色：冰糖/);
    assert.match((await command("/bot b voice status", [B], options))[0], /音色：mimo_default/);
    const b = controls(G.voicePreset).botSettings?.[`account:${ids[B]}`] || {};
    assert.equal(b.voicePreset, undefined, "b must not inherit a's preset");
    assert.equal(b.voicePresetUpdatedAt, undefined, "b must not inherit a's cooldown");
    assert.equal(jsonLines(hermesLog).length, callsBefore, "preset switching/status must not invoke a model");
  });
  await test("a quiet suppresses its commands/hints, never b; only target resume wakes it", async () => {
    const options = { group: G.quiet };
    try {
      await command("/bot a quiet 10m", [], options);
      const quiet = controls(G.quiet);
      assert.ok(quiet.botSettings?.[`account:${ids[A]}`]?.quietUntil > Date.now(), "only a's scoped quiet flag must be set");
      assert.equal(Number(quiet.quietUntil || 0), 0, "shared group must not become quiet");
      assert.equal(Number(quiet.botSettings?.[`account:${ids[B]}`]?.quietUntil || 0), 0, "b must remain awake");
      for (const text of ["/bot a status", "/bot a mode lively", "/bot a voice status", "/bot", "/bot mode", "/bot zz status"])
        await command(text, [], options);
      assert.deepEqual(controls(G.quiet), quiet, "suppressed controls must not mutate quiet bot settings");
      assert.match((await command("/bot b status", [B], options))[0], /状态/);
      await command("/bot b resume", [B], options);
      await command("/bot a status", [], options);
      assert.ok(controls(G.quiet).botSettings[`account:${ids[A]}`].quietUntil > Date.now(), "resuming b must not wake a");
      await command("/bot a resume", [A], options);
      assert.equal(controls(G.quiet).botSettings[`account:${ids[A]}`].quietUntil, 0);
      assert.equal(modeFrom((await command("/bot a status", [A], options))[0]), "normal", "quiet mode command was not executed");
      await command("/bot b status", [B], options);
    } finally {
      // Recovery is still a fake group command; never patch private state layout.
      await command("/bot a resume", [A], options);
    }
  });
  await test("single-bot group keeps legacy /bot status; absent early registry members do not occupy a", async () => {
    const options = { group: G.single };
    assert.match((await command("/bot status", [B], options))[0], /状态/);
    assert.match((await command("/bot a status", [B], options))[0], /状态/);
    const [help] = await command("/bot", [B], options);
    assert.doesNotMatch(help, /请指定要控制|本群有\s*\d+\s*个机器人/);
    assert.ok(actions.some((action) => action.action === "get_group_member_list" && String(action.params.group_id) === G.single));
  });
  await test("disabled and out-of-scope members never occupy selectors", async () => {
    const options = { group: G.filtered };
    assertChoices((await command("/bot", [A], options))[0], [["a", A], ["b", B]]);
    await command("/bot b status", [B], options);
    assert.match((await command("/bot c status", [A], options))[0], /未找到|不存在|未知/);
  });
  await test("unknown selector reports once without executing the trailing mode", async () => {
    const before = await modes();
    assert.match((await command("/bot zz mode lively", [A]))[0], /未找到|不存在|未知/);
    assert.deepEqual(await modes(), before);
  });
  await test("offline b retains its number and is reported by first online bot without mutation", async () => {
    await disconnect(B);
    try {
      const options = { group: G.offlineB };
      assertChoices((await command("/bot", [A], options))[0], [["a", A], ["b", B]]);
      assert.match((await command("/bot b mode lively", [A], options))[0], /暂不可用|离线|不在线/);
      await command("/bot a status", [A], options);
    } finally { await connect(B); }
    assert.deepEqual(await modes(G.offlineB), ["normal", "normal"], "offline target mutation must not replay on reconnection");
  });
  await test("offline a retains its number; b reports but does not become a", async () => {
    await disconnect(A);
    try {
      const options = { group: G.offlineA };
      assertChoices((await command("/bot", [B], options))[0], [["a", A], ["b", B]]);
      assert.match((await command("/bot a mode lively", [B], options))[0], /暂不可用|离线|不在线/);
      await command("/bot b status", [B], options);
    } finally { await connect(A); }
    assert.deepEqual(await modes(G.offlineA), ["normal", "normal"]);
  });
  await test("unreadable member lists fail closed with one notice and no control mutation", async () => {
    const options = { group: G.fallback, recipients: [A, B] };
    await observeMembers(G.fallback, [A, B]);
    const before = controls(G.fallback);
    for (const text of ["/bot", "/bot b status", "/bot b mode lively", "/bot b quiet 10m", "/bot b voice mixed", "/bot b resume"]) {
      const [notice] = await command(text, [A], options);
      assert.match(notice, /无法读取.*名单/);
      assert.match(notice, /未执行/);
      assert.deepEqual(controls(G.fallback), before, "unverified roster must never execute controls");
    }
    assert.ok(actions.some((action) => action.action === "get_group_member_list" && String(action.params.group_id) === G.fallback), "must actually attempt the failed member-list API");
    const single = { group: G.fallbackSingle, recipients: [B] };
    await observeMembers(G.fallbackSingle, [B]);
    const singleBefore = controls(G.fallbackSingle);
    for (const text of ["/bot status", "/bot a mode lively"]) {
      const [notice] = await command(text, [B], single);
      assert.match(notice, /无法读取.*名单/);
      assert.match(notice, /未执行/);
    }
    assert.deepEqual(controls(G.fallbackSingle), singleBefore, "one observed bot is not a verified single-bot group");
    assert.ok(actions.some((action) => action.action === "get_group_member_list" && String(action.params.group_id) === G.fallbackSingle));
    failingLists.delete(G.fallback);
    await pause(2100); // Expire the short failed-query cache, not the good roster cache.
    assert.deepEqual(await modes(G.fallback), ["normal", "normal"], "recovery must not replay rejected mutations");
    assert.match((await command("/bot b voice status", [B], options))[0], /语音模式：关闭/);
  });
  await test("failover pair counts as one logical bot and only its selected transport replies", async () => {
    const options = { group: G.logical };
    assertChoices((await command("/bot", [A], options))[0], [["a", A], ["b", MAIN]]);
    await command("/bot b status", [MAIN], options);
    assert.match((await command("/bot c status", [A], options))[0], /未找到|不存在|未知/);
  });
  await test("private /bot keeps existing behavior and never emits group selector hints", async () => {
    const offset = actions.length;
    for (const index of [A, B]) {
      const [text] = await command("/bot status", [index], { privateTo: index });
      assert.match(text, /私聊/);
      assert.doesNotMatch(text, /请指定要控制|本群有\s*\d+\s*个机器人|\/bot a\b|\/bot b\b/);
    }
    assert.equal(actions.slice(offset).some((item) => item.action === "get_group_member_list"), false);
  });
  await test("all command scenarios avoid model, voice-provider and Docker execution", async () => {
    assert.equal(jsonLines(hermesLog).length, 0, "management commands must never invoke Hermes (do not dump prompts)");
    assert.equal(jsonLines(dockerLog).some((args) => ["run", "start", "stop", "pull", "restart", "rm", "rename", "update"].includes(args[0])), false, "no Docker mutation, even via denied fake CLI");
  });
}

try {
  const env = await setup();
  if (selfCheck) await runSelfCheck(env);
  else await runIntegration(env);
} catch (error) { results.push({ name: "fixture setup/runtime", ok: false, error: safeError(error) }); }
finally {
  for (const socket of sockets.values()) socket.terminate();
  try { await stopBridge(); }
  catch (error) { results.push({ name: "fixture child cleanup", ok: false, error: safeError(error) }); }
  if (selfServer) {
    for (const socket of selfServer.clients) socket.terminate();
    await new Promise((resolve) => selfServer.close(resolve));
  }
  clearTimeout(hardStop);
  if (!child || exited(child)) {
    fs.rmSync(home, { recursive: true, force: true });
    results.push({ name: "temporary state removed", ok: !fs.existsSync(home) });
  } else results.push({ name: "temporary state removed", ok: false, error: "retained fixture while child may still be running" });
}
const failures = results.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failures.length === 0, fixtureOnly: true, mode: selfCheck ? "fixture-self-check" : "bridge-integration",
  bridgeStarted: Boolean(child), tests: results.length, passed: results.length - failures.length,
  results, failures, deadlineMs: 90000 }, null, 2));
if (failures.length) process.exitCode = 1;
