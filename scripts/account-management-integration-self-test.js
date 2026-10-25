import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";

// No live QQ, Docker daemon, provider credentials, authenticated browser or model.
// Run with a working Node >=22: node scripts/account-management-integration-self-test.js
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-account-integration-"));
const configFile = path.join(home, "config.json");
const sockets = new Map();
const actions = [];
const acknowledged = new Set();
const results = [];
const ids = Array.from({ length: 6 }, (_, index) => `fixture-${index}`);
const qqs = ids.map((_, index) => String(91000 + index));
const GROUP = "810001", BLOCKED = "810002", QUIET = "810003", EXPLICIT = "810004";
const NEGATIVE_ACK_GROUP = "810005";
// This is a 46-case end-to-end suite, not one failover attempt. It includes
// durable config writes, six-account probes and real 1s shared send spacing.
// Node 22/CI can exceed 60s cumulatively even when every bounded action passes.
const fixtureBudgetMs = 120_000, caseBudgetMs = 20_000;
const startedAt = Date.now(), deadline = startedAt + fixtureBudgetMs;
let caseDeadline = Infinity;
let child, childClosed, negativeAck, base, token = "", output = "", sequence = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasExited = (process) => process && (process.exitCode !== null || process.signalCode !== null);
const stored = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
const clean = (value) => String(value).replaceAll(token || "__no_session__", "[session]").slice(0, 1600);

async function stopBridge() {
  if (!child) return;
  if (!hasExited(child)) child.kill("SIGTERM");
  const closedWithin = (ms) => Promise.race([childClosed.then(() => true), pause(ms).then(() => false)]);
  if (await closedWithin(1000)) return;
  if (!hasExited(child)) child.kill("SIGKILL");
  assert.ok(await closedWithin(1000), "isolated bridge must close before restart or fixture removal");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(predicate, label, timeoutMs = 4500) {
  const end = Math.min(deadline, caseDeadline, Date.now() + timeoutMs);
  while (Date.now() < end) {
    if (hasExited(child)) throw new Error(`isolated bridge exited (${child.exitCode ?? child.signalCode}): ${clean(output)}`);
    const value = await predicate();
    if (value) return value;
    await pause(35);
  }
  throw new Error(`${label}: timeout ${timeoutMs}ms`);
}

function sanitizedStatusDiagnosis(status) {
  const diagnosis = status.diagnosis || {};
  // Only fixture IDs, enum states, booleans and capability states are emitted;
  // never dump transport URLs, probe payloads, credentials or free-form logs.
  return { id: ids.includes(status.id) ? status.id : "[other fixture]", enabled: status.enabled,
    protocolEnabled: status.protocolEnabled, connected: status.connected, active: status.active,
    status: status.status, routeState: status.routeState,
    diagnosis: { routeState: diagnosis.routeState, strongBad: diagnosis.strongBad, canSend: diagnosis.canSend,
      canReceive: diagnosis.canReceive, needsLogin: diagnosis.needsLogin, suspectFakeOnline: diagnosis.suspectFakeOnline,
      wrongAccountLoggedIn: diagnosis.wrongAccountLoggedIn,
      identityMatchesFixture: diagnosis.actualQq === qqs[ids.indexOf(status.id)],
      capabilities: Object.fromEntries(["identity", "onebot", "api", "send", "receive"].map((key) =>
        [key, (status.capabilities || diagnosis.capabilities)?.[key]?.status || null])) } };
}

async function test(name, run, { diagnose = false } = {}) {
  const started = Date.now();
  caseDeadline = Math.min(deadline, started + caseBudgetMs);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) {
    caseDeadline = Infinity; // Permit bounded diagnostics after a case timeout.
    const failure = { name, ok: false, error: clean(error.message) };
    if (diagnose) {
      try { failure.statuses = (await current()).statuses.map(sanitizedStatusDiagnosis); }
      catch (diagnosticError) { failure.diagnosticError = clean(diagnosticError.message); }
    }
    results.push(failure);
  }
  finally {
    caseDeadline = Infinity;
    results.at(-1).durationMs = Date.now() - started;
    if (process.env.HERMES_QQ_TEST_TIMING === "1")
      process.stderr.write(`${JSON.stringify({ test: name, durationMs: Date.now() - started, remainingMs: deadline - Date.now() })}\n`);
  }
}

async function request(route, method = "GET", body, headers = {}) {
  if (Date.now() > deadline) throw new Error(`${fixtureBudgetMs / 1000}s fixture deadline exceeded`);
  if (Date.now() > caseDeadline) throw new Error(`${caseBudgetMs / 1000}s case deadline exceeded`);
  // Undici may rewrite Host; use raw loopback HTTP for the hostile-Host test.
  if (headers.host) return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers: { "x-hermes-qq-admin": token, ...headers } }, (response) => {
      let raw = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => { try { resolve({ status: response.statusCode, data: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(2200, () => req.destroy(new Error("host fixture request timeout")));
    req.on("error", reject); req.end();
  });
  const response = await fetch(`${base}${route}`, {
    method, signal: AbortSignal.timeout(2200),
    headers: { ...(token ? { "x-hermes-qq-admin": token } : {}),
      ...(method !== "GET" ? { origin: base, "content-type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, data: await response.json() };
}

async function current() {
  const result = await request("/api/accounts");
  assert.equal(result.status, 200, "GET /api/accounts must succeed with local session");
  return result.data;
}

async function mutate(route, method, body = {}, expectedStatus = 200) {
  const snapshot = await current();
  const result = await request(route, method, { expectedRevision: snapshot.revision, ...body });
  assert.equal(result.status, expectedStatus, `${method} ${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function rejected(route, method, body, expectedStatus = 400, headers = {}) {
  const before = fs.readFileSync(configFile, "utf8");
  const snapshot = await current();
  const result = await request(route, method, { expectedRevision: snapshot.revision, ...body }, headers);
  if (Array.isArray(expectedStatus)) assert.ok(expectedStatus.includes(result.status), `${method} ${route}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
  else assert.equal(result.status, expectedStatus, `${method} ${route}: ${JSON.stringify(result.data)}`);
  assert.equal(fs.readFileSync(configFile, "utf8"), before, "rejected mutation must not change disk config");
  assert.equal((await current()).revision, snapshot.revision, "rejected mutation must not change revision");
}

function event(index, { group = GROUP, text = "fixture-trigger ordinary question", message, messageId, privateChat = false } = {}) {
  const content = message || [{ type: "text", data: { text } }];
  return { post_type: "message", message_type: privateChat ? "private" : "group", self_id: qqs[index],
    ...(privateChat ? {} : { group_id: group }), user_id: "10001", sender: { user_id: "10001", nickname: "fixture-human" },
    message_id: messageId || `fixture-message-${++sequence}`, time: Math.floor(Date.now() / 1000), message: content, raw_message: text };
}

function broadcast(options) {
  const messageId = options.messageId || `fixture-shared-${++sequence}`;
  for (const [id, socket] of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event(ids.indexOf(id), { ...options, messageId })));
  return messageId;
}

const sent = (group) => actions.filter((item) => item.action === "send_group_msg" && String(item.params.group_id) === group);
const hermesCalls = () => {
  const file = path.join(home, "hermes-calls.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
};
const archive = (...parts) => {
  const file = path.join(home, "data", "chat-archive", ...parts, "messages.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
};

const hardStop = setTimeout(() => { for (const socket of sockets.values()) socket.terminate(); child?.kill("SIGKILL"); }, fixtureBudgetMs + 2000);
try {
  for (const dir of ["bin", "hermes", "tmp", "data"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const dockerLog = path.join(home, "docker-attempts.jsonl");
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(process.argv.slice(2))+"\\n");
process.stderr.write("fixture: real Docker forbidden\\n"); process.exit(97);
`, { mode: 0o700 });
  const hermes = path.join(home, "bin", "hermes");
  fs.writeFileSync(hermes, `#!${process.execPath}
const fs = require("node:fs"), file = ${JSON.stringify(path.join(home, "hermes-calls.jsonl"))};
fs.appendFileSync(file, JSON.stringify(process.argv.slice(2))+"\\n");
const slowRoute=process.argv.some(arg=>arg.includes("CONCURRENT_BOTH_SWITCH"));
setTimeout(()=>process.stdout.write("fixture text reply "+Date.now()+"-"+process.pid+(slowRoute?" CONCURRENT_BOTH_SWITCH":"")+"\\n"),slowRoute?1500:0);
`, { mode: 0o700 });
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { ...config.listen, host: "127.0.0.1", port: await freePort(), path: "/fixture-onebot" };
  config.control = { ...config.control, host: "127.0.0.1", port: await freePort() };
  config.ai = { ...config.ai, command: hermes, args: [], timeoutMs: 3000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "default", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.memory.aiExtraction.enabled = false;
  config.dailyMessages = { enabled: false, schedules: [] };
  delete config.hourlyChat;
  // This fixture explicitly tests migration from the pre-ownership format.
  delete config.automation.ownershipVersion;
  delete config.automation.routines;
  config.botFeatures = { defaultMode: "chat", accountModes: {}, interBot: { enabled: false } };
  config.botNames = ["fixture-trigger"];
  config.trigger = { ...config.trigger, replyToAt: true, replyToKeywords: true, keywordCooldownMs: 1, activeReply: false };
  config.responseQueue = { enabled: true, minDelayMs: 5, liveContext: { enabled: false, settleMs: 0 } };
  config.chatArchive = { ...config.chatArchive, enabled: true, defaultOn: true, baseDir: "data/chat-archive", saveImages: false };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
    diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 },
    items: ids.map((id, index) => ({ id, qq: qqs[index], displayName: `fixture bot ${index}`, protocol: "napcat", managed: true,
      enabled: true, protocolEnabled: true, archived: false, protocolContainer: `fixture-container-${index}`,
      onebotPath: config.listen.path, onebotWsUrl: "", webuiPort: 20000 + index * 4,
      features: { chat: true, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: true, image: false, record: false, video: false, file: false },
      scope: { groups: true, private: true, groupMode: "allowlist", groupIds: [GROUP, QUIET, EXPLICIT, NEGATIVE_ACK_GROUP] }, voice: { mode: "off", preset: "" } })) };
  fs.writeFileSync(configFile, JSON.stringify(registryConfig(config, { strict: true })), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "data", "memory.json"), JSON.stringify({ groups: { [QUIET]: { settings: { quietUntil: Date.now() + 600000 } } } }), { mode: 0o600 });
  const childEnv = { HOME: home, TMPDIR: path.join(home, "tmp"), PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8", HERMES_HOME: path.join(home, "hermes"), XDG_CONFIG_HOME: path.join(home, "xdg"),
      HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  const launchBridge = () => {
    output = "";
    child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    childClosed = new Promise((resolve) => child.once("close", resolve));
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-3000); });
  };
  launchBridge();
  base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { return (await request("/health")).status === 200; } catch { return false; } }, "bridge startup");
  const session = await request("/api/admin/session");
  assert.equal(session.status, 200); token = session.data.token; assert.ok(token);

  await test("GET auth rejects absent token and outsider Host", async () => {
    assert.equal((await request("/api/accounts", "GET", undefined, { "x-hermes-qq-admin": "" })).status, 403, "GET without token must be denied");
    assert.equal((await request("/api/accounts", "GET", undefined, { host: "outsider.invalid" })).status, 403, "GET with outsider Host must be denied");
  });
  await test("mutation auth rejects absent token, foreign Origin and non-JSON", async () => {
    for (const headers of [{ "x-hermes-qq-admin": "" }, { origin: "https://outsider.invalid" }, { origin: "" }, { "content-type": "text/plain" }])
      await rejected("/api/accounts/fixture-0", "PATCH", { patch: { displayName: "must-not-save" } }, 403, headers);
  });
  await test("GET canonical six-account payload", async () => {
    const value = await current(); assert.equal(value.ok, true); assert.ok(value.revision);
    assert.equal(value.items.length, 6); assert.ok(Array.isArray(value.failoverGroups)); assert.ok(Array.isArray(value.statuses));
  });
  for (const [index, id] of ids.entries()) {
    const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
    sockets.set(id, socket);
    socket.on("message", (raw) => {
      const action = JSON.parse(String(raw)); actions.push({ id, ...action });
      if (negativeAck && id === ids[5] && action.action === "send_group_msg" && String(action.params.group_id) === NEGATIVE_ACK_GROUP) {
        const pending = negativeAck;
        pending.action = action;
        pending.reject = () => {
          if (pending.rejected || !action.echo || socket.readyState !== WebSocket.OPEN) return;
          pending.rejected = true;
          socket.send(JSON.stringify({ status: "failed", retcode: 100, echo: action.echo, message: "fixture-negative-model-ack", data: null }));
        };
        return;
      }
      const reply = () => {
        if (!action.echo || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
          data: action.action === "get_login_info" ? { user_id: qqs[index], nickname: id }
            : action.action === "get_status" ? { online: true, good: true } : { message_id: `fixture-reply-${++sequence}` } }));
        acknowledged.add(action.echo);
      };
      // Legal bounded ACK latency must not turn a routing test into a flaky
      // zero-latency assumption. This delay exists only in this fake transport.
      if(action.action==='send_group_msg'&&JSON.stringify(action.params.message).includes('CONCURRENT_BOTH_SWITCH')) setTimeout(reply,2000);
      else reply();
    });
    await until(() => socket.readyState === WebSocket.OPEN, `reverse WS open ${id}`);
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: qqs[index], status: { online: true, good: true } }));
  }
  await until(async () => (await current()).statuses.filter((item) => item.connected).length === 6, "all six reverse sockets identified");

  let createdId;
  await test("manual sends require local same-origin admin authentication before any wire action", async()=>{
    const writes=()=>actions.filter(row=>/^send_/.test(row.action)).length;
    const before=writes();
    for(const route of ["/send","/api/send_private"]) {
      assert.equal((await request(route,"POST",{}, {"x-hermes-qq-admin":""})).status,403);
      assert.equal((await request(route,"POST",{}, {origin:"https://invalid.example"})).status,403);
    }
    assert.equal(writes(),before);
  });
  await test("POST adds seventh account disabled and does not provision", async () => {
    const value = await mutate("/api/accounts", "POST", { account: { id: "fixture-created", displayName: "created fixture", protocol: "napcat", qq: "91999" } }, 201);
    createdId = value.account?.id || value.items.find((item) => item.id === "fixture-created")?.id;
    assert.equal(createdId, "fixture-created");
    const item = stored().accounts.items.find((item) => item.id === createdId);
    assert.equal(item.enabled, false); assert.equal(item.protocolEnabled, true); assert.equal(item.archived, false);
    assert.equal((await current()).items.filter((item) => !item.archived).length, 7);
  });
  await test("PATCH per ID preserves every neighbor", async () => {
    const before = stored().accounts.items.filter((item) => item.id !== ids[2]);
    await mutate(`/api/accounts/${ids[2]}`, "PATCH", { patch: { displayName: "renamed third fixture", sendTypes: { image: true } } });
    assert.deepEqual(stored().accounts.items.filter((item) => item.id !== ids[2]), before);
    assert.equal(stored().accounts.items[2].protocolContainer, "fixture-container-2");
  });
  await test("style is an independent snapshot, including an intentionally empty prompt", async () => {
    const before = stored().accounts.items.filter((item) => item.id !== createdId);
    assert.deepEqual(stored().accounts.items.find((item) => item.id === createdId).style, { systemPrompt: "" });
    await mutate(`/api/accounts/${createdId}`, "PATCH", { patch: { style: { systemPrompt: "fixture independent persona" } } });
    assert.deepEqual(stored().accounts.items.filter((item) => item.id !== createdId), before);
    await mutate(`/api/accounts/${createdId}`, "PATCH", { patch: { style: { systemPrompt: "" } } });
    assert.equal(stored().accounts.items.find((item) => item.id === createdId).style.systemPrompt, "");
  });
  await test("new account can copy style once without copying permissions or automation", async () => {
    const original = stored().accounts.items[0];
    const result = await mutate("/api/accounts", "POST", { account: { id: "fixture-style-copy", displayName: "style copy", protocol: "napcat", copyStyleFromAccountId: original.id } }, 201);
    assert.deepEqual(result.account.style, original.style);
    assert.equal(result.account.enabled, false);
    assert.equal(result.account.features.automation, false);
    assert.equal(result.account.sendTypes.record, false);
    await mutate(`/api/accounts/${original.id}`, "PATCH", { patch: { style: { systemPrompt: "fixture changed source" } } });
    assert.deepEqual(stored().accounts.items.find((item) => item.id === "fixture-style-copy").style, original.style);
    await mutate("/api/accounts/fixture-style-copy", "DELETE");
  });
  await test("legacy routines are visible, revision guarded and preserve legacy schedules", async () => {
    const route = `/api/automation/accounts/${ids[0]}`;
    const read = await request(route);
    assert.equal(read.status, 200);
    assert.equal(read.data.routines.daily.enabled, false);
    assert.ok(Array.isArray(read.data.catalog));
    assert.equal((await request(route, "GET", undefined, { "x-hermes-qq-admin": "" })).status, 403);
    const snapshot = stored();
    await rejected(route, "PATCH", { expectedRevision: "stale", routines: { daily: { enabled: true } } }, 409);
    await mutate(route, "PATCH", { routines: { daily: { enabled: false, windowMinutes: 4 } } });
    assert.equal(stored().automation.accounts[ids[0]].routines.daily.windowMinutes, 4);
    assert.deepEqual(stored().dailyMessages.schedules, snapshot.dailyMessages.schedules);
    assert.deepEqual(stored().automation.rules, snapshot.automation.rules);
    await rejected("/api/automation/routines", "PATCH", { routines: { daily: { accountId: "missing-account" } } });
  });
  await test("missing and stale revisions reject without mutation", async () => {
    const stale = (await current()).revision;
    await mutate(`/api/accounts/${ids[2]}`, "PATCH", { patch: { displayName: "fresh third fixture" } });
    await rejected(`/api/accounts/${ids[2]}`, "PATCH", { expectedRevision: stale, patch: { displayName: "stale" } }, 409);
    await rejected(`/api/accounts/${ids[2]}`, "PATCH", { expectedRevision: undefined, patch: { displayName: "missing-revision" } }, 409);
  });
  await test("automation namespaces isolate rules, switches, revisions and target writes", async () => {
    const routes = ids.slice(0, 2).map(id => `/api/automation/accounts/${id}`);
    const rule = { id: "same_name", enabled: false, timezone: "Asia/Shanghai", scope: { conversationIds: [`group:${GROUP}`] },
      trigger: { type: "schedule", time: "08:30", daysOfWeek: [1], windowMinutes: 3 }, action: { kind: "message" }, prompt: "isolated fixture" };
    await mutate(routes[0], "PATCH", { rules: [rule] });
    await mutate(routes[1], "PATCH", { rules: [{ ...rule, prompt: "independent B" }], enabled: true });
    const b = (await request(routes[1])).data;
    await mutate(routes[0], "PATCH", { rules: [{ ...rule, prompt: "edited A" }], enabled: false });
    const after = (await request(routes[1])).data;
    assert.deepEqual(after.rules, b.rules);
    assert.equal(after.enabled, true);
    assert.equal((await request(routes[0])).data.enabled, false);
    assert.equal(stored().accounts.items.find(item => item.id === ids[1]).features.automation, true);
    assert.equal((await request(routes[0])).data.rules[0].accountId, ids[0]);
    await rejected(routes[0], "PATCH", { rules: [{ ...rule, accountId: ids[1] }] });
    await rejected("/api/config", "PATCH", { automation: { enabled: true, rules: [] } });
    assert.deepEqual((await request(routes[1])).data.rules, b.rules);
    await mutate(routes[0], "PATCH", { rules: [] });
    await mutate(routes[1], "PATCH", { rules: [], enabled: false });
  });
  await test("every registry mutation route requires revision", async () => {
    for (const [route, method] of [["/api/accounts", "POST"], [`/api/accounts/${ids[0]}`, "DELETE"],
      [`/api/accounts/${ids[0]}/pause`, "POST"], [`/api/accounts/${ids[0]}/resume`, "POST"],
      ["/api/account-groups", "POST"], ["/api/account-groups/missing", "PATCH"], ["/api/account-groups/missing", "DELETE"]])
      await rejected(route, method, { expectedRevision: undefined }, 409);
  });
  for (const patch of [{ enabled: "false" }, { protocolEnabled: 1 }, { archived: "no" }, { managed: null }, { features: { chat: "yes" } },
    { sendTypes: { record: 1 } }, { qq: qqs[0] }, { webuiPort: config.accounts.items[0].webuiPort }])
    await test(`invalid account patch ${JSON.stringify(patch)}`, () => rejected(`/api/accounts/${ids[1]}`, "PATCH", { patch }));
  await test("duplicate QQ rejected on POST", () => rejected("/api/accounts", "POST", { account: { id: "duplicate-qq", qq: qqs[0] } }));
  await test("POST rejects invalid protocol boolean", () => rejected("/api/accounts", "POST", { account: { id: "invalid-boolean", protocolEnabled: "false" } }));

  const group = { id: "fixture-pair", name: "fixture pair", memberIds: [ids[0], ids[1]], policyAccountId: ids[0], policy: {}, settings: { enabled: false } };
  for (const invalid of [{ memberIds: [ids[0], "missing-member"] }, { memberIds: [ids[0], ids[0]] }, { memberIds: [ids[0]] },
    { policyAccountId: ids[3] }, { policy: { protocolContainer: "forbidden-policy-transport" } }])
    await test(`invalid group ${JSON.stringify(invalid)}`, () => rejected("/api/account-groups", "POST", { group: { ...group, ...invalid } }));
  await test("group POST/PATCH and reference-blocked account DELETE", async () => {
    await mutate("/api/account-groups", "POST", { group });
    try {
      await mutate(`/api/account-groups/${group.id}`, "PATCH", { group: { ...group, name: "updated fixture pair" } });
      assert.equal((await current()).failoverGroups[0].name, "updated fixture pair");
      await rejected(`/api/accounts/${ids[0]}`, "DELETE", {}, 409);
      // No specific HTTP code is mandated for the PATCH archive bypass.
      await rejected(`/api/accounts/${ids[0]}`, "PATCH", { patch: { archived: true } }, [400, 409]);
      await rejected("/api/account-groups", "POST", { group: { ...group, id: "overlap-pair", memberIds: [ids[0], ids[2]] } });
    } finally { await mutate(`/api/account-groups/${group.id}`, "DELETE"); }
    assert.equal((await current()).failoverGroups.length, 0);
  });
  await test("DELETE archives instead of deleting registry data", async () => {
    assert.ok(createdId); await mutate(`/api/accounts/${createdId}`, "DELETE");
    const item = stored().accounts.items.find((item) => item.id === createdId);
    assert.equal(item.archived, true); assert.equal(item.enabled, false); assert.equal(item.protocolEnabled, false);
  });

  await test("pause keeps protocol socket connected", async () => {
    await mutate(`/api/accounts/${ids[5]}/pause`, "POST");
    const value = await current(), status = value.statuses.find((item) => item.id === ids[5]);
    assert.equal(status.enabled, false, "paused status.enabled");
    assert.equal(value.items.find((item) => item.id === ids[5]).protocolEnabled, true, "pause must not stop the protocol");
    assert.equal(status.connected, true, "paused status.connected");
    assert.equal(sockets.get(ids[5]).readyState, WebSocket.OPEN);
  });
  await test("all five explicitly named eligible bots answer with no two-bot cap", async () => {
    const names = (await current()).items.map((item) => item.displayName).join(" ");
    broadcast({ group: GROUP, messageId: "ordinary-five", text: `${names} 普通问题，请各自回答` });
    await until(() => new Set(sent(GROUP).map((item) => item.id)).size >= 5, "five independent ordinary replies", 6500);
    assert.deepEqual([...new Set(sent(GROUP).map((item) => item.id))].sort(), ids.slice(0, 5));
  });
  await test("shared group raw archive deduplicates six received copies", async () => {
    await until(() => archive("groups", GROUP).some((item) => item.messageId === "ordinary-five"), "shared archive");
    assert.equal(archive("groups", GROUP).filter((item) => item.type === "user_message" && item.messageId === "ordinary-five").length, 1);
  });
  await test("paused account archives the first group copy once and isolated private input without sending", async () => {
    const actionOffset = actions.length;
    const messageId = "paused-first-shared-archive";
    // Quiet scope prevents this evidence-only probe from creating delayed replies
    // that could overlap later manual-send assertions.
    const options = { group: QUIET, text: "neutral archive observation", messageId };
    sockets.get(ids[5]).send(JSON.stringify(event(5, options)));
    await until(() => archive("groups", QUIET).some((item) => item.messageId === messageId), "paused first-copy archive");
    for (let index = 0; index < 5; index++) sockets.get(ids[index]).send(JSON.stringify(event(index, options)));
    sockets.get(ids[5]).send(JSON.stringify(event(5, { privateChat: true, text: "paused private archive only", messageId: "paused-private-archive" })));
    await until(() => archive("private", `10001-${ids[5]}`).some((item) => item.messageId === "paused-private-archive"), "paused private archive");
    await pause(200);
    assert.equal(archive("groups", QUIET).filter((item) => item.type === "user_message" && item.messageId === messageId).length, 1,
      "paused first receiver and five active copies must share exactly one raw archive record");
    assert.equal(archive("private", `10001-${ids[5]}`).filter((item) => item.type === "user_message" && item.messageId === "paused-private-archive").length, 1);
    assert.equal(actions.slice(actionOffset).some((item) => item.id === ids[5] && ["send_group_msg", "send_private_msg"].includes(item.action)), false,
      "paused account must archive without replying");
  });
  await test("resume plus explicit @ only targets the named account", async () => {
    await mutate(`/api/accounts/${ids[5]}/resume`, "POST");
    assert.equal((await current()).statuses.find((item) => item.id === ids[5]).enabled, true);
    broadcast({ group: EXPLICIT, text: `[CQ:at,qq=${qqs[4]}] 请回答 explicit-target-only`, message: [
      { type: "at", data: { qq: qqs[4] } }, { type: "text", data: { text: "请回答 explicit-target-only" } }] });
    await until(() => sent(EXPLICIT).length >= 1, "explicit reply"); await pause(250);
    assert.deepEqual(sent(EXPLICIT).map((item) => item.id), [ids[4]]);
  });
  await test("blocked scope and quiet group produce no sends", async () => {
    broadcast({ group: BLOCKED, text: "fixture-trigger blocked-scope" });
    broadcast({ group: QUIET, text: "fixture-trigger quiet-group" });
    const blocked = await request("/send", "POST", { account_id: ids[0], group_id: BLOCKED, message: "blocked manual text" });
    const quiet = await request("/send", "POST", { account_id: ids[0], group_id: QUIET, message: "quiet manual text" });
    assert.notEqual(blocked.status, 200); assert.notEqual(quiet.status, 200);
    await pause(250); assert.equal(sent(BLOCKED).length, 0); assert.equal(sent(QUIET).length, 0);
  });
  await test("sendTypes allow text but refuse record, file and disguised audio", async () => {
    const actionOffset = actions.length;
    const sendsOf = (message) => actions.slice(actionOffset).filter((item) => item.action === "send_group_msg"
      && String(item.params.group_id) === GROUP && item.params.message === message);
    const allowed = "allowed fixture text";
    assert.equal((await request("/send", "POST", { account_id: ids[0], group_id: GROUP, message: allowed })).status, 200);
    assert.deepEqual(sendsOf(allowed).map((item) => item.id), [ids[0]], "allowed text must reach exactly one selected socket");
    for (const message of ["[CQ:record,file=base64://Zml4dHVyZQ==]", "[CQ:file,file=fixture.txt]"]) {
      assert.notEqual((await request("/send", "POST", { account_id: ids[0], group_id: GROUP, message })).status, 200, `forbidden sendTypes payload ${message}`);
      assert.equal(sendsOf(message).length, 0, `forbidden payload must not reach OneBot: ${message}`);
    }
    await mutate(`/api/accounts/${ids[0]}`, "PATCH", { patch: { sendTypes: { file: true, record: false } } });
    const disguised = "[CQ:file,file=fixture.wav,name=masked.txt]";
    assert.notEqual((await request("/send", "POST", { account_id: ids[0], group_id: GROUP, message: disguised })).status, 200, "file.wav with masked.txt name must still require record=true");
    assert.equal(sendsOf(disguised).length, 0, "audio disguised as file must not bypass record permission");
  });
  await test("same-user private chats stay account isolated", async () => {
    for (const index of [0, 1]) sockets.get(ids[index]).send(JSON.stringify(event(index, { privateChat: true, text: `private-only-${ids[index]}`, messageId: `private-${index}` })));
    await until(() => new Set(actions.filter((item) => item.action === "send_private_msg").map((item) => item.id)).size >= 2, "two isolated private replies");
    for (const index of [0, 1]) {
      const records = archive("private", `10001-${ids[index]}`);
      assert.ok(JSON.stringify(records).includes(`private-only-${ids[index]}`));
      assert.equal(JSON.stringify(records).includes(`private-only-${ids[1 - index]}`), false);
    }
  });

  await test("fresh explicit probes verify all six account identities and ONLINE_PROBABLE API readiness", async () => {
    const startedAt = Date.now();
    const probes = await Promise.all(ids.map((id) => request(`/api/accounts/${id}/probe`, "POST", {})));
    for (const [index, response] of probes.entries()) {
      const id = ids[index], { probe, account } = response.data;
      assert.equal(response.status, 200, `${id}: probe HTTP status`);
      assert.equal(response.data.ok, true, `${id}: probe must succeed`);
      assert.equal(probe?.ok, true, `${id}: cached accountProbe must succeed`);
      assert.equal(probe.accountId, id, `${id}: probe must target the requested account`);
      assert.ok(probe.checkedAt >= startedAt && probe.checkedAt <= Date.now(), `${id}: probe must be fresh`);
      assert.equal(String(probe.loginInfo?.user_id), qqs[index], `${id}: probe identity must match configured fixture QQ`);
      assert.equal(probe.status?.online, true, `${id}: probe must confirm online`);
      assert.equal(probe.status?.good, true, `${id}: probe must confirm good`);
      assert.equal(account?.routeState, "ONLINE_PROBABLE", `${id}: readiness must be ONLINE_PROBABLE`);
      for (const capability of ["identity", "onebot", "api"])
        assert.equal(account.capabilities?.[capability]?.status, "ok", `${id}: ${capability} capability must be ok`);
    }
    const snapshot = await current();
    for (const id of ids) {
      const status = snapshot.statuses.find((item) => item.id === id);
      assert.equal(status?.routeState, "ONLINE_PROBABLE", `${id}: GET status must retain probed readiness`);
      assert.equal(status.capabilities?.api?.status, "ok", `${id}: GET API capability must be ok`);
    }
  }, { diagnose: true });

  // Two independent failover elections must coexist with ungrouped bots.
  // Each member retains its QQ/socket identity while the group's name/prompt
  // policy remains shared, including after both groups elect standby members.
  const routeGroups = [
    { id: "fixture-route-a", name: "fixture route A", memberIds: [ids[0], ids[1]], policyAccountId: ids[0],
      policy: { displayName: "shared-policy-a", promptOverride: "POLICY_ONLY_GROUP_A" } },
    { id: "fixture-route-b", name: "fixture route B", memberIds: [ids[2], ids[3]], policyAccountId: ids[2],
      policy: { displayName: "shared-policy-b", promptOverride: "POLICY_ONLY_GROUP_B" } }
  ].map((group) => ({ ...group, settings: { enabled: true, switchAfterMs: 1000, minSwitchIntervalMs: 1000,
    announceTakeover: false, announceInGroups: false } }));
  const createdGroups = [];
  const assertTimerElection = async (id, label) => {
    // No status/health/accounts polling or incoming chat during this bounded
    // idle period. The 1s election timer must advance the 1s failover clock.
    await pause(2200);
    // Unlike accountsPayload/healthPayload, this endpoint returns the passive
    // accountSummary snapshot after read-only OneBot probes; it does not call
    // selectedGroupAccount/selectActiveAccount and cannot drive the election.
    const response = await request(`/api/accounts/${id}/probe`, "POST", {});
    assert.equal(response.status, 200, `${label}: snapshot probe HTTP status`);
    assert.equal(response.data.probe?.ok, true, `${label}: standby probe must still succeed`);
    assert.equal(response.data.account?.capabilities?.api?.status, "ok", `${label}: standby API readiness must remain ok`);
    assert.equal(response.data.account?.active, true, `${label}: timer must elect standby without status polling or new chat`);
  };
  const assertRoutes = async (expected, marker) => {
    const snapshot = await current();
    assert.deepEqual(snapshot.statuses.filter((item) => item.active).map((item) => item.id).sort(), [...expected].sort(),
      `${marker}: elections must not collapse into one global active account`);
    const actionOffset = actions.length, promptOffset = hermesCalls().length;
    const names = [...snapshot.items.map((item) => item.displayName), ...snapshot.failoverGroups.map((group) => group.policy.displayName)].join(" ");
    broadcast({ group: GROUP, text: `${names} ${marker}`, messageId: marker });
    const newReplies = () => actions.slice(actionOffset).filter((item) => item.action === "send_group_msg" && String(item.params.group_id) === GROUP);
    const generationBudgetMs=Number(config.ai.timeoutMs)+2000;
    const fakeAckMs=marker==='CONCURRENT_BOTH_SWITCH'?2000:0;
    const wireBudgetMs=Number(config.ai.timeoutMs)+expected.length*Math.max(1000,fakeAckMs)+1000;
    try {
      await until(()=>hermesCalls().length-promptOffset>=expected.length,`${marker}: all selected routes start generation`,generationBudgetMs);
      await until(() => newReplies().length >= expected.length, `${marker}: all selected routes reply`,wireBudgetMs);
      await until(()=>newReplies().every(item=>acknowledged.has(item.echo)),`${marker}: actual fake transport ACKs`,fakeAckMs+2000);
    }
    catch(error) {
      // All values are synthetic. Record bounded admission/generation/wire
      // evidence instead of guessing that a missing reply was a slow runner.
      const health=(await request('/health')).data;
      const lines=output.split('\n').filter(line=>line.includes(marker)||/duplicate|skipped|cancelled|discard|blocked|failed/i.test(line)).slice(-12);
      error.message += ` ${JSON.stringify({expected,replied:newReplies().map(item=>item.id),
        promptCalls:hermesCalls().length-promptOffset,coordinator:health.replyCoordinator,lines})}`;
      throw error;
    }
    await pause(200);
    assert.deepEqual(newReplies().map((item) => item.id).sort(), [...expected].sort(), `${marker}: exactly the two selected members and independent bots must send`);
    const prompts = hermesCalls().slice(promptOffset).map((args) => args.join("\n"));
    for (const [groupIndex, memberIndex] of [[0, expected.includes(ids[0]) ? 0 : 1], [1, expected.includes(ids[2]) ? 2 : 3]]) {
      const sharedName = routeGroups[groupIndex].policy.displayName;
      assert.ok(prompts.some((prompt) => prompt.includes(`「${sharedName}」（QQ ${qqs[memberIndex]}）`)
        && prompt.includes(routeGroups[groupIndex].policy.promptOverride)), `${marker}: ${sharedName} must be shared without changing member QQ identity`);
    }
    for (const index of [4, 5]) assert.ok(prompts.some((prompt) => prompt.includes(`「fixture bot ${index}」（QQ ${qqs[index]}）`)),
      `${marker}: independent bot ${index} must keep its own identity`);
  };
  try {
    await test("two concurrent groups plus independent routes share only their own group policy names", async () => {
      for (const group of routeGroups) { await mutate("/api/account-groups", "POST", { group }); createdGroups.push(group.id); }
      const snapshot = await current();
      assert.equal(snapshot.failoverGroups.length, 2);
      assert.deepEqual(snapshot.failoverGroups.map((group) => group.policy.displayName), ["shared-policy-a", "shared-policy-b"]);
      assert.equal(stored().accounts.topology, "function_split");
      await assertRoutes([ids[0], ids[2], ids[4], ids[5]], "CONCURRENT_INITIAL");
    }, { diagnose: true });
    await test("group A timer failover without status polling leaves group B and independent routes unchanged", async () => {
      assert.equal(createdGroups.length, 2, "both groups must exist before failover assertions");
      await mutate(`/api/accounts/${ids[0]}/pause`, "POST");
      await assertTimerElection(ids[1], "group A standby election");
      assert.equal(sockets.get(ids[0]).readyState, WebSocket.OPEN, "failover on bot pause must preserve the protocol socket");
      await assertRoutes([ids[1], ids[2], ids[4], ids[5]], "CONCURRENT_A_SWITCH");
    }, { diagnose: true });
    await test("both group timers independently elect standbys without status polling and preserve shared policy identities", async () => {
      assert.equal(createdGroups.length, 2);
      await mutate(`/api/accounts/${ids[2]}/pause`, "POST");
      await assertTimerElection(ids[3], "group B standby election");
      await assertRoutes([ids[1], ids[3], ids[4], ids[5]], "CONCURRENT_BOTH_SWITCH");
    }, { diagnose: true });
  } finally {
    // Cleanup also runs after a failed assertion, preventing downstream false failures.
    for (const id of createdGroups.reverse()) await mutate(`/api/account-groups/${id}`, "DELETE");
    for (const id of [ids[0], ids[2]]) if (stored().accounts.items.find((item) => item.id === id)?.enabled === false)
      await mutate(`/api/accounts/${id}/resume`, "POST");
  }

  await test("model reply awaits real ack and negative ack never creates a bot reply archive", async () => {
    const modelOffset = hermesCalls().length, actionOffset = actions.length;
    const replies = () => archive("groups", NEGATIVE_ACK_GROUP).filter((item) => item.type === "bot_reply");
    assert.equal(replies().length, 0, "dedicated negative-ack conversation must start empty");
    const pending = negativeAck = {};
    const sendMention = (marker) => sockets.get(ids[5]).send(JSON.stringify(event(5, {
      group: NEGATIVE_ACK_GROUP, messageId: marker, text: `[CQ:at,qq=${qqs[5]}] ${marker}`,
      message: [{ type: "at", data: { qq: qqs[5] } }, { type: "text", data: { text: `请回答 ${marker}` } }]
    })));
    let failedText;
    try {
      sendMention("NEGATIVE_ACK_MODEL");
      await until(() => pending.action, "model reply reaches fake socket before ack");
      assert.ok(hermesCalls().slice(modelOffset).some((args) => args.join("\n").includes("NEGATIVE_ACK_MODEL")),
        "negative-ack attempt must originate from a generated model reply, not a manual send");
      failedText = String(pending.action.params.message).match(/fixture text reply \d+/)?.[0];
      assert.ok(failedText, "fake model output must be present in the attempted send");
      assert.ok(pending.action.echo, "model reply must request a real OneBot acknowledgement");
      await pause(100);
      assert.equal(replies().length, 0, "unacknowledged model reply must not be archived early");
      pending.reject();
      await until(async () => (await current()).statuses.find((item) => item.id === ids[5])?.sendHealth?.lastGroupSendFailure?.includes("fixture-negative-model-ack"),
        "account send state records explicit negative ack");
      assert.equal(replies().length, 0, "failed model reply must not be archived after negative ack");
      assert.equal(archive("groups", NEGATIVE_ACK_GROUP).filter((item) => item.type === "user_message" && item.messageId === "NEGATIVE_ACK_MODEL").length, 1,
        "send failure must preserve the incoming evidence exactly once");
    } finally {
      pending.reject?.(); // Release a held ack even if an early-archive assertion fails.
      negativeAck = null;
    }
    // A successful next job in the same queue is a completion barrier and a
    // positive archive control; it must not retroactively archive the failed text.
    sendMention("ACK_RECOVERED_MODEL");
    await until(() => replies().length >= 1, "successful subsequent model reply archive");
    const records = replies();
    assert.equal(records.length, 1, "only the successfully acknowledged reply may be archived");
    assert.equal(records[0].accountId, ids[5]);
    assert.equal(records.some((item) => item.text.includes(failedText)), false, "failed model text must never appear in bot reply archives");
    assert.deepEqual(actions.slice(actionOffset).filter((item) => item.action === "send_group_msg" && String(item.params.group_id) === NEGATIVE_ACK_GROUP)
      .map((item) => item.id), [ids[5], ids[5]], "exactly one failed send and one acknowledged recovery send must use the addressed socket");
  }, { diagnose: true });

  await test("paused vs protocol-stopped statuses differ and stop closes socket", async () => {
    await mutate(`/api/accounts/${ids[5]}/pause`, "POST");
    const paused = (await current()).statuses.find((item) => item.id === ids[5]);
    await mutate(`/api/accounts/${ids[5]}`, "PATCH", { patch: { protocolEnabled: false } });
    await until(() => sockets.get(ids[5]).readyState === WebSocket.CLOSED, "protocol-disabled socket closure");
    const value = await current(), stopped = value.statuses.find((item) => item.id === ids[5]);
    assert.equal(paused.connected, true, "pause preserves connection"); assert.equal(stopped.connected, false, "protocol stop disconnects");
    assert.equal(value.items.find((item) => item.id === ids[5]).protocolEnabled, false, "protocol stop persisted");
    assert.notEqual(paused.status, stopped.status, "status label must distinguish bot pause from protocol stop");
  });
  await test("archiving every account preserves health and status with zero active accounts", async () => {
    for (const account of (await current()).items.filter((item) => !item.archived)) await mutate(`/api/accounts/${account.id}`, "DELETE");
    const snapshot = await current();
    assert.equal(snapshot.items.filter((item) => !item.archived).length, 0);
    assert.equal(snapshot.statuses.length, 0);
    for (const route of ["/health", "/api/status"]) {
      const response = await request(route); assert.equal(response.status, 200, `${route} must stay responsive without accounts`);
      const health = route === "/api/status" ? response.data.health : response.data;
      assert.deepEqual(health?.accounts, [], `${route} must not invent a legacy account`);
      if (route === "/api/status") assert.deepEqual(response.data.config?.accounts?.items, [], "status config must not invent a legacy account");
    }
  });
  await test("empty v2 items cold startup has responsive health/status and no ghost accounts", async () => {
    const callsBefore = hermesCalls().length;
    await stopBridge();
    assert.ok(hasExited(child), "old isolated bridge must exit before restarting");
    const empty = stored(); empty.accounts.items = []; empty.accounts.failoverGroups = [];
    fs.writeFileSync(configFile, JSON.stringify(registryConfig(empty, { strict: true })), { mode: 0o600 });
    token = ""; launchBridge();
    await until(async () => { try { return (await request("/health")).status === 200; } catch { return false; } }, "empty registry cold startup");
    token = (await request("/api/admin/session")).data.token;
    assert.ok(token);
    const snapshot = await current();
    assert.deepEqual(snapshot.items, []); assert.deepEqual(snapshot.statuses, []); assert.deepEqual(snapshot.failoverGroups, []);
    for (const route of ["/health", "/api/status"]) {
      const response = await request(route); assert.equal(response.status, 200);
      const health = route === "/api/status" ? response.data.health : response.data;
      assert.deepEqual(health?.accounts, [], `${route} must not invent a legacy account on cold startup`);
      if (route === "/api/status") assert.deepEqual(response.data.config?.accounts?.items, [], "cold status config must have no ghost accounts");
    }
    assert.equal(hermesCalls().length, callsBefore, "empty-account startup must not invoke a model");
  });
  await test("no Docker mutation was attempted and no credentials escaped", async () => {
    const attempts = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    assert.equal(attempts.some((args) => ["run", "start", "stop", "pull", "restart", "rm", "rename", "update"].includes(args[0])), false);
    assert.equal(JSON.stringify(await current()).includes(token), false);
    const calls = fs.readFileSync(path.join(home, "hermes-calls.jsonl"), "utf8").trim().split("\n");
    assert.ok(calls.length >= 5, "ordinary replies must use the local fake Hermes, never a model provider");
  });
} catch (error) { results.push({ name: "fixture setup/runtime", ok: false, error: clean(error.message) }); }
finally {
  for (const socket of sockets.values()) socket.terminate();
  try { await stopBridge(); }
  catch (error) { results.push({ name: "fixture child cleanup", ok: false, error: clean(error.message) }); }
  clearTimeout(hardStop);
  fs.rmSync(home, { recursive: true, force: true });
}
const failures = results.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failures.length === 0, fixtureOnly: true, tests: results.length, passed: results.length - failures.length,
  fixture: { accountIds: ids, qqs, groups: { allowed: GROUP, blocked: BLOCKED, quiet: QUIET, explicit: EXPLICIT, negativeAck: NEGATIVE_ACK_GROUP },
    transport: "napcat reverse WS", hermes: "local Node fixture", deadlineMs: fixtureBudgetMs, caseBudgetMs,
    elapsedMs: Date.now() - startedAt }, failures }, null, 2));
if (failures.length) process.exitCode = 1;
