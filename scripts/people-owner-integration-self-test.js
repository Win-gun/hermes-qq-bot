// Real bridge/MemoryRuntime, two fake OneBots and a loopback HTTP model only.
// Run with Node 22. All runtime files, HOME and credentials are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import vm from "node:vm";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { personMemoryContext, recordPersonEvidence } from "../src/people-memory.js";
import { readMemorySnapshot } from "../src/memory-repository.js";
import { ownerDirectiveAllows, putOwnerDirective, revokeOwnerDirective } from "../src/owner-authority.js";
import { accountDeliveryDecision, GroupSendCoordinator } from "../src/account-delivery.js";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use Node 22 for this fixture");
const root = path.resolve(import.meta.dirname, ".."), home = fs.mkdtempSync(path.join(os.tmpdir(), "people-owner-bridge-"));
const memoryFile = path.join(home, "data", "memory.json"), guardLog = path.join(home, "guard.jsonl");
const preload = path.join(home, "deny-preload.cjs"), DAY = 86_400_000, OWNER = "21001", PERSON = "22001";
const PUBLIC = "PUBLIC_ALPHA_PERSON_FIXTURE", BETA = "PUBLIC_BETA_PERSON_FIXTURE", PRIVATE = "PRIVATE_PERSON_ONLY_FIXTURE";
const LEGACY = "LEGACY_PERSON_MUST_NOT_RESURRECT", EXTRACT = "偏好合成星图标记";
const OWN_FRAGMENT = "OWNER_PRIVATE_FRAGMENT_FIXTURE", OTHER_FRAGMENT = "OTHER_PRIVATE_FRAGMENT_MUST_NOT_LEAK";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [], completed = [], sockets = [], wire = [], calls = [], inbound = [];
let child, base, token, config, childLog = "", sequence = 41000, extractionRelease, extractionStarted, slowReplyStarted, slowReplyRelease;
// One shared admission barrier, not a new unresolved barrier per extraction.
// Later/split batches must not wait for the test's finally block to publish.
const extractionGate = new Promise(resolve => { extractionRelease = resolve; });
const reportPointer = {
  ack: "src/bridge.js oneBotSend -> ownerAck",
  auth: "src/bridge.js localAdminHost/origin/session guard",
  people: "src/owner-services.js administerPerson / src/bridge.js /api/people",
  intake: "src/bridge.js claimConversationMessage -> addPendingMemoryMessage / mergeMemoryPatch",
  owner: "src/owner-services.js sendText/setQuiet / src/owner-authority.js router"
};
async function test(name, run, pointer = reportPointer.owner) {
  try { await run(); completed.push(name); }
  catch (error) { failures.push({ test: name, pointer, error: String(error.message || error).slice(0, 700),
    ...(String(error.message).includes("TIMEOUT") ? { diagnostics: { modelCalls: calls.length,
      wireTail: wire.slice(-8).map(row => ({ action: row.action, accountId: row.accountId,
        userId: row.params?.user_id, groupId: row.params?.group_id, text: messageText(row).slice(0, 100) })) } } : {}) }); }
}
function check(condition, label) { assert(condition, label); }
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function alive() { return child && child.exitCode === null && child.signalCode === null; }
async function until(fn, note, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!alive()) throw new Error(`BRIDGE_EXITED: ${note}; ${childLog.slice(-1200)}`);
    try { if (await fn()) return; } catch (error) { if (error.code !== "MEMORY_READ_BUSY") throw error; }
    await pause(35);
  }
  throw new Error(`TIMEOUT: ${note}`);
}
async function api(route, { method = "GET", body, auth = true, origin = base, headers = {} } = {}) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", ...(origin === null ? {} : { origin }),
      ...(auth ? { "x-hermes-qq-admin": token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function rawHostRequest(route, host) {
  // Fetch can normalize/ignore Host. Use real HTTP headers while keeping the
  // TCP destination fixed to this fixture's loopback listener.
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: config.control.port, path: route, method: "GET",
      headers: { host, origin: base, "x-hermes-qq-admin": token } }, response => {
      let raw = ""; response.on("data", value => { raw += value; });
      response.once("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    request.setTimeout(3000, () => request.destroy(new Error("FIXTURE_RAW_HTTP_TIMEOUT")));
    request.once("error", reject); request.end();
  });
}
function snapshot() { return readMemorySnapshot(memoryFile); }
function messageText(row) {
  const value = row.params?.message;
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.filter(item => item.type === "text").map(item => item.data.text).join("") : "";
  return text.replace(/\[CQ:reply,id=-?\d+\]/g, "");
}
const sends = () => wire.filter(row => row.action.startsWith("send_"));
const groupSends = text => wire.filter(row => row.action === "send_group_msg" && (text === undefined || messageText(row) === text));
const privateSends = () => wire.filter(row => row.action === "send_private_msg");
function emit(accountId, text, { userId = OWNER, groupId, messageId = String(++sequence), time = Math.floor(Date.now() / 1000), selfId, mention = false } = {}) {
  const i = accountId === "alpha" ? 0 : 1, self = 11001 + i;
  const event = { post_type: "message", message_type: groupId ? "group" : "private", sub_type: "friend",
    self_id: selfId ?? self, user_id: Number(userId), message_id: Number(messageId), time,
    ...(groupId ? { group_id: Number(groupId) } : {}), sender: { nickname: "FixtureHuman", role: "owner", user_id: Number(userId) },
    message: [...(mention ? [{ type: "at", data: { qq: String(self) } }] : []), { type: "text", data: { text } }], raw_message: text };
  inbound.push({ accountId, messageId: String(messageId), text }); sockets[i].send(JSON.stringify(event)); return String(messageId);
}
async function command(text, options = {}) {
  const offset = wire.length, messageId = emit(options.accountId || "alpha", text, options);
  await until(() => wire.slice(offset).some(row => row.action === "send_private_msg" && String(row.params.user_id) === OWNER), `private acknowledgment: ${text}`);
  const ack = wire.slice(offset).find(row => row.action === "send_private_msg" && String(row.params.user_id) === OWNER);
  await pause(60); return { messageId, ack, text: messageText(ack), rows: wire.slice(offset) };
}
async function groupMemoryCommand(suffix = PERSON) {
  const offset = wire.length;
  emit("alpha", `/bot a memory ${suffix}`, { userId: PERSON, groupId: "31001" });
  await until(() => wire.slice(offset).some(row => row.action === "send_group_msg"), "addressed group memory command");
  const rows = wire.slice(offset).filter(row => row.action === "send_group_msg");
  check(rows.every(row => row.accountId === "alpha" && String(row.params.group_id) === "31001"), "memory query stays on addressed fake bot/group");
  return rows.map(messageText).join("\n");
}
async function history() { return (await api("/api/owner/query?kind=history")).body.operations; }
async function operationFor(messageId) {
  const commands = snapshot().ownerAuthority?.commands || {};
  return Object.values(commands).find(row => row.sourceMessageId === messageId);
}
const peoplePath = (accountId = "alpha", conversationId = "group:31002", userId = PERSON) =>
  `/api/people?account_id=${accountId}&user_id=${userId}&conversation_id=${encodeURIComponent(conversationId)}`;
async function profile(accountId = "alpha", conversationId = "group:31002") {
  const reply = await api(peoplePath(accountId, conversationId)); assert.equal(reply.status, 200); return reply.body;
}
async function administer(operation, extra = {}) {
  const current = await profile();
  return api("/api/people/admin", { method: "POST", body: { expectedRevision: current.revision,
    personRevision: current.profile.revision, accountId: "alpha", userId: PERSON, operation, ...extra } });
}
const model = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
    let raw = ""; for await (const chunk of req) { raw += chunk; assert(raw.length <= 2_000_000); }
    const body = JSON.parse(raw); assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
    const prompt = body.messages.map(row => typeof row.content === "string" ? row.content : JSON.stringify(row.content)).join("\n");
    const extraction = prompt.includes("你是聊天记忆提取器"); calls.push({ prompt, extraction, model: body.model });
    let content = "fixture plain reply";
    if (!extraction && prompt.includes("SLOW_PERSON_CONTROL_FIXTURE")) {
      slowReplyStarted?.(); await new Promise(resolve => { slowReplyRelease = resolve; });
      content = "STALE_PERSON_CONTROL_REPLY_MUST_NOT_SEND";
    }
    if (extraction) {
      const match = /【新增原始消息[^\n]*】\n([^\n]+)\n【规则】/.exec(prompt);
      assert(match, "extraction prompt carries explicit pinned rows");
      const rows = JSON.parse(match[1]), selected = rows.filter(row => row.text.includes(EXTRACT));
      if (selected.length) {
        extractionStarted?.(); await extractionGate;
        content = JSON.stringify({ canonical_entries: [{ user_id: "22003", kind: "preference", value: EXTRACT,
          confidence: 0.9, source_message_ids: selected.map(row => row.message_id) }] });
      } else content = "{}";
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
  } catch (error) {
    failures.push({ test: "mock HTTP model contract", pointer: "src/text-completion.js", error: error.message });
    res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"FIXTURE_MODEL_CONTRACT"}');
  }
});

function writePreload(ports) {
  // Not a bridge monkeypatch: only deny IO/capabilities and shorten the genuine
  // OneBot ACK timer to 5s. Actual dispatch, ACK parsing and ledgers run unchanged.
  fs.writeFileSync(preload, `
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'),path=require('node:path'),mod=require('node:module');
const home=${JSON.stringify(home)},root=${JSON.stringify(root)},allowed=new Set(${JSON.stringify(ports)});
const rawAppend=fs.appendFileSync.bind(fs);
function record(type,code){rawAppend(${JSON.stringify(guardLog)},JSON.stringify({type,code})+'\\n');}
function denied(type,code){record(type,code);throw Object.assign(new Error(code),{code});}
function filePath(v){if(typeof v==='number')return null;if(v instanceof URL)v=require('node:url').fileURLToPath(v);return path.resolve(String(v));}
function access(v,write){const p=filePath(v);if(p===null)return;const local=p===home||p.startsWith(home+path.sep);
 const source=p===root||p.startsWith(root+path.sep);const relative=path.relative(root,p);
 const runtime=/^(?:config\\.json(?:\\.|$)|data(?:\\/|$)|logs(?:\\/|$)|secrets(?:\\/|$)|napcat[^/]*(?:\\/|$)|snowluma[^/]*(?:\\/|$))/.test(relative);
 if(write?!local:(!local&&!(source&&!runtime)&&p!=='/dev/null'))denied('filesystem',write?'FIXTURE_WRITE_OUTSIDE_HOME':'FIXTURE_READ_OUTSIDE_SAFE_ROOTS');}
for(const name of ['readFileSync','readFile','existsSync','statSync','lstatSync','accessSync','readdirSync','createReadStream']){const old=fs[name];fs[name]=function(file,...args){access(file,false);return old.call(this,file,...args);};}
for(const name of ['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','rmSync','rm','unlinkSync','unlink','rmdirSync','rmdir','createWriteStream','chmodSync','chmod','utimesSync']){const old=fs[name];if(old)fs[name]=function(file,...args){access(file,true);return old.call(this,file,...args);};}
for(const name of ['renameSync','rename','linkSync','link','copyFileSync','copyFile']){const old=fs[name];fs[name]=function(a,b,...args){access(a,true);access(b,true);return old.call(this,a,b,...args);};}
for(const name of ['openSync','open']){const old=fs[name];fs[name]=function(file,flags,...args){access(file,typeof flags==='number'?flags!==0:/[wa+]/.test(String(flags)));return old.call(this,file,flags,...args);};}
cp.spawnSync=function(command){record('spawnSyncDenied',path.basename(String(command)));return{status:1,stdout:'',stderr:'FIXTURE_PROCESS_DENIED'};};
for(const name of ['spawn','exec','execFile','execSync','execFileSync','fork'])cp[name]=function(command){return denied('process','FIXTURE_PROCESS_DENIED:'+name+':'+path.basename(String(command)));};
function connection(args){let opt=args[0];if(Array.isArray(opt))opt=opt[0];if(typeof opt==='number')opt={port:opt,host:typeof args[1]==='string'?args[1]:'127.0.0.1'};
 if(!opt||opt.path||!['127.0.0.1','::1'].includes(opt.host||opt.hostname||'127.0.0.1')||!allowed.has(Number(opt.port)))denied('network','FIXTURE_CONNECTION_DENIED');}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){connection(args);return connect.apply(this,args);};
tls.connect=()=>denied('network','FIXTURE_TLS_DENIED');
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!['127.0.0.1','::1'].includes(host))denied('network','FIXTURE_DNS_DENIED');return lookup.call(this,host,...args);};
require('node:dgram').createSocket=()=>denied('network','FIXTURE_UDP_DENIED');
const originalFetch=global.fetch;global.fetch=function(input,options){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!allowed.has(Number(url.port)))denied('network','FIXTURE_FETCH_DENIED');return originalFetch(input,options);};
const timer=global.setTimeout;global.setTimeout=function(fn,ms,...args){const source=String(fn);if(ms===20000&&(source.includes('oneBotSendTrackers')||source.includes('pendingOneBotActions'))){record('timer',source.includes('pendingOneBotActions')?'ONEBOT_REQUEST_ACK_5000MS':'ONEBOT_SEND_ACK_5000MS');ms=5000;}return timer(fn,ms,...args);};
mod.syncBuiltinESMExports();
`);
}
function bridgeFunction(name, nextName) {
  const source = fs.readFileSync(path.join(root, "src/bridge.js"), "utf8");
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`function ${nextName}(`, start);
  assert(start >= 0 && end > start, `actual bridge adapter ${name}`);
  return source.slice(start, end).trim();
}
function finalGateFixture() {
  // Actual dispatcher + actual policy/coordinator/directive functions; only
  // transport/health are fake. No privileged pokes are exposed on live HTTP.
  const memory = {}, runtime = registryConfig({ ...config, ownerNotifications: { enabled: false },
    accounts: { ...config.accounts, items: config.accounts.items.map(account => ({ ...account,
      socialExperience: { enabled: true, shadowMode: false, conversationIds: ["group:31001", "group:31002"], pokes: { enabled: true } } })) } });
  const coordinator = new GroupSendCoordinator({ minDelayMs: () => 0 }), nativePokeBindings = new WeakMap(), transmitted = [];
  const peers = new Map(["alpha", "beta"].map(id => [id, { readyState: 1, __hermesAccountId: id, __hermesSessionId: `fixture-${id}` }]));
  const sandbox = vm.createContext({ config: runtime, memory, groupSendCoordinator: coordinator, nativePokeBindings,
    isQzoneAction: () => false, qzoneActionKind: () => "unknown", isUnmanagedFavoriteWrite: () => false,
    oneBotAccounts: new Map([...peers].map(([id, ws]) => [id, { ws }])),
    oneBotBinding: ws => ({ id: ws.__hermesAccountId, sessionId: ws.__hermesSessionId }),
    oneBotBindingCurrent: (ws, binding) => ws.__hermesAccountId === binding.id && ws.__hermesSessionId === binding.sessionId,
    accountRuntimeContext: id => ({ accountId: id, logicalBotId: `account:${id}` }),
    accountRuntimeContextCurrent: (context, ws) => context.accountId === ws.__hermesAccountId,
    ownerDirectiveAllows, logicalBotId: (_config, id) => `account:${id}`, accountGroup: () => null,
    accountById: (cfg, id) => cfg.accounts.items.find(account => account.id === id), accountStateById: () => ({}),
    diagnoseAccount: () => ({ routeState: "ONLINE" }), accountDeliveryDecision, accountIsSelected: () => true,
    configForReplyAccount: account => account, isQuiet: () => false, warn: () => {}
  });
  new vm.Script(bridgeFunction("dispatchAccountAction", "validateAccountConfig")).runInContext(sandbox);
  function dispatch(id = "alpha", userId = 22002, groupId = 31001) {
    const ws = peers.get(id), binding = { id, sessionId: ws.__hermesSessionId }, params = { group_id: groupId, user_id: userId };
    nativePokeBindings.set(binding, { accountId: id, groupId, userId, isCurrent: () => true });
    return sandbox.dispatchAccountAction(ws, "group_poke", params, () => { transmitted.push({ id, ...params }); return {}; }, binding);
  }
  function restrict() {
    const result = putOwnerDirective(memory, { actorUserId: OWNER, logicalBotId: "account:alpha", accountId: "alpha",
      groupId: "31001", userId: "22002", messageId: "fixture-final-gate", authorized: true, now: Date.now() });
    assert.equal(result.ok, true); return result;
  }
  return { memory, runtime, coordinator, sandbox, peers, transmitted, dispatch, restrict };
}
function resultSummary() {
  return { ok: failures.length === 0, passed: completed.length, failed: failures.length, failures,
    fakeHttpCalls: calls.length, fakeExtractionCalls: calls.filter(row => row.extraction).length,
    fakeWireSends: sends().length, realQqWrites: 0, realModelCalls: 0, productionIO: false,
    runtime: process.versions.node, ackTimeoutShimMs: 5000 };
}
async function holdForUi() {
  // A fresh process uses the SAME isolated persisted fixture, never production.
  await launch();
  check((await api("/api/owner/status")).status === 200, "held owner endpoint is real");
  check((await api(peoplePath("beta"))).status === 200, "held people endpoint is real");
  console.log(JSON.stringify({ ...resultSummary(), fixtureUi: `${base}/admin`, fixtureHome: home,
    fixturePid: process.pid, bridgePid: child.pid, stateIsolated: true, maxHoldMs: 600000 }));
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); process.removeListener("SIGTERM", done); process.removeListener("SIGINT", done); resolve(); };
    const timer = setTimeout(done, 600000); process.once("SIGTERM", done); process.once("SIGINT", done);
  });
}
async function stopBridge() {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (!alive()) return;
  const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
  await Promise.race([stopped, pause(4000)]);
  if (alive()) { child.kill("SIGKILL"); await stopped; }
}
async function launch() {
  childLog = "";
  child = spawn(process.execPath, [path.join(root, "src/bridge.js")], { cwd: home,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home,
      HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root,
      HERMES_QQ_LOG_DIR: path.join(home, "logs"), PEOPLE_OWNER_FIXTURE_KEY: "synthetic-fixture-not-a-real-key",
      NODE_OPTIONS: `--require=${preload}` }, stdio: ["ignore", "ignore", "pipe"] });
  child.on("error", error => { childLog = error.code || "SPAWN_FAILED"; });
  child.stderr.on("data", value => { childLog = (childLog + value.toString()).slice(-4000); });
  await until(async () => { try { return (await api("/health", { auth: false })).status === 200; } catch { return false; } }, "isolated bridge ready");
  token = (await api("/api/admin/session", { auth: false })).body.token;
  for (const [i, id] of ["alpha", "beta"].entries()) {
    const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}/people-owner-fixture`); sockets.push(socket);
    socket.on("error", () => { childLog += " FIXTURE_SOCKET_ERROR"; });
    socket.on("message", raw => {
      const request = JSON.parse(raw); if (!request.action) return;
      const row = { accountId: id, ...request, at: Date.now() }; wire.push(row);
      const text = messageText(row);
      if (request.action === "send_group_msg" && text === "ACK_TIMEOUT_FIXTURE") return;
      const failed = request.action === "send_group_msg" && text === "ACK_FAILED_FIXTURE";
      const missing = request.action === "send_group_msg" && text === "ACK_MISSING_ID_FIXTURE";
      const data = request.action === "get_login_info" ? { user_id: 11001 + i, nickname: id }
        : request.action === "get_group_list" ? [{ group_id: 31001 }, { group_id: 31002 }]
          : request.action === "get_group_member_list" ? [11001, 11002, 21001, 22001, 22002, 22003].map(user_id => ({ user_id, nickname: "FixtureHuman" }))
            : request.action.startsWith("send_") ? missing ? {} : { message_id: 50000 + wire.length } : { online: true, good: true };
      socket.send(JSON.stringify({ status: failed ? "failed" : "ok", retcode: failed ? 100 : 0,
        echo: request.echo, data, ...(failed ? { message: "FIXTURE_EXPLICIT_REJECTION" } : {}) }));
    });
    await until(() => socket.readyState === WebSocket.OPEN, "fake socket ready");
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 11001 + i, status: { online: true, good: true } }));
  }
  await until(async () => { const body = (await api("/api/accounts")).body;
    return body.statuses?.filter(row => row.connected && row.actualQq === row.configuredQq).length === 2; }, "both verified peer identities");
}

try {
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { host: "127.0.0.1", port: await freePort(), path: "/people-owner-fixture" };
  config.control = { ...config.control, host: "127.0.0.1", port: await freePort() }; base = `http://127.0.0.1:${config.control.port}`;
  for (const key of ["vision", "voice", "webSearch", "proactive", "socialPlanner", "implicitReply", "discussionParticipation", "automation",
    "dailyMessages", "hourlyChat", "adminNotifications", "loginRecovery", "taskMode", "learningMode", "delayedUnderstanding"]) config[key] = { enabled: false };
  config.ownerControl = { enabled: true, naturalLanguage: false, usageEnabled: true, allowedTargets: [{ accountId: "alpha", groupId: "31001" }] };
  config.ownerNotifications = { enabled: false };
  config.privateChats = { enabled: true, targetUsers: ["*"], ownerUserIds: [OWNER] };
  config.memory = { ...config.memory, people: { enabled: true }, verification: { enabled: false },
    learning: { enabled: true, minBatchMessages: 2, maxBatchMessages: 16, settleMs: 1000, maxWaitMs: 2000 },
    aiExtraction: { ...config.memory.aiExtraction, enabled: true, everyMessages: 2 }, botSelf: { enabled: false } };
  config.chatArchive = { enabled: false }; config.messageDebounce = { enabled: false }; config.targetGroups = ["31001", "31002"];
  config.send = { ...config.send, minIntervalMs: 0, privateMinIntervalMs: 0, maxLength: 500, splitLongReplies: false };
  config.reply = { ...config.reply, replyDelayMs: 0 };
  config.apiCenter = undefined; config.aiProfiles = [];
  config.ai = { ...config.ai, textTransport: "direct", provider: "custom", model: "fixture-model",
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: "PEOPLE_OWNER_FIXTURE_KEY", credentialSource: "existing", timeoutMs: 10000 };
  config.accounts = { version: 2, diagnostics: { peerPingEnabled: false, peerPingOnMessageInactive: false },
    items: ["alpha", "beta"].map((id, i) => ({ id, qq: String(11001 + i), displayName: id, selfName: id,
    enabled: true, protocolEnabled: true, managed: true, protocolContainer: `fixture-people-owner-${id}`,
    protocol: "napcat", onebotPath: "/people-owner-fixture",
    style: { systemPrompt: `${id} synthetic fixture persona` },
    scope: { groups: true, groupMode: "allowlist", groupIds: ["31001", "31002"], private: true },
    features: { chat: true, proactive: false }, sendTypes: { text: true, image: false, record: false, video: false, file: false },
    digitalLife: { enabled: true }, socialAgent: { enabled: false }, socialExperience: { enabled: false } })), failoverGroups: [] };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })));
  const seed = { groups: { "31001": { users: { [PERSON]: { profile: [LEGACY], preferences: [LEGACY] } }, summary: LEGACY } } }, now = Date.now();
  for (const [bot, value, conversationId, privacy, userId = PERSON] of [["alpha", PUBLIC, "group:31001", "public"], ["beta", BETA, "group:31001", "public"],
    ["alpha", PRIVATE, `private:${PERSON}`, "private"], ["alpha", OWN_FRAGMENT, `private:${OWNER}`, "private", OWNER],
    ["alpha", OTHER_FRAGMENT, "private:22002", "private", "22002"]]) {
    for (let i = 0; i < 2; i++) assert.equal(recordPersonEvidence(seed, { logicalBotId: `account:${bot}`, accountId: bot,
      userId, verifiedSenderId: userId, conversationId, messageId: `seed-${bot}-${userId}-${privacy}-${i}`,
      time: (now - (2 - i) * DAY) / 1000, now, kind: "stable_fact", value, confidence: 0.9, sourceType: "message", privacy }).ok, true);
  }
  fs.mkdirSync(path.join(home, "data")); fs.writeFileSync(memoryFile, JSON.stringify(seed));
  writePreload([config.listen.port, config.control.port, model.address().port]);
  await launch();

  await test("actual final send gate enforces directive with bot/group/person isolation", async () => {
    const fixture = finalGateFixture(); await fixture.dispatch(); assert.equal(fixture.transmitted.length, 1);
    fixture.restrict(); await assert.rejects(fixture.dispatch(), { code: "ACCOUNT_SEND_BLOCKED" });
    assert.equal(fixture.transmitted.length, 1);
    await fixture.dispatch("beta"); await fixture.dispatch("alpha", 22003); await fixture.dispatch("alpha", 22002, 31002);
    assert.equal(fixture.transmitted.length, 4, "only the exact restricted logical bot/group/member is blocked");
  }, "src/bridge.js dispatchAccountAction / src/owner-authority.js ownerDirectiveAllows");
  await test("directive installed while group action waits blocks wire; revocation never replays blocked action", async () => {
    const fixture = finalGateFixture(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    const blocker = fixture.coordinator.dispatch("31001", () => {}, () => gate);
    const pending = fixture.dispatch(); const rejected = assert.rejects(pending, { code: "ACCOUNT_SEND_BLOCKED" });
    const directive = fixture.restrict(); release({}); await blocker; await rejected;
    assert.equal(fixture.transmitted.length, 0);
    assert.equal(revokeOwnerDirective(fixture.memory, { directiveId: directive.id, actorUserId: OWNER,
      authorized: true, expectedRevision: fixture.memory.ownerAuthority.revision, now: Date.now() }).ok, true);
    assert.equal(fixture.transmitted.length, 0); await fixture.dispatch(); assert.equal(fixture.transmitted.length, 1);
  }, "src/bridge.js dispatchAccountAction / src/account-delivery.js GroupSendCoordinator");
  await test("directive arriving in validation microtask is rechecked immediately before wire", async () => {
    const fixture = finalGateFixture(); let validations = 0;
    fixture.sandbox.accountDeliveryDecision = (...args) => {
      if (++validations === 1) queueMicrotask(() => fixture.restrict());
      return accountDeliveryDecision(...args);
    };
    await assert.rejects(fixture.dispatch(), { code: "ACCOUNT_SEND_BLOCKED" });
    assert.equal(validations, 1); assert.equal(fixture.transmitted.length, 0);
  }, "src/bridge.js dispatchAccountAction final validate()");
  await test("in-flight legacy notification is suppressed by enabled center at final send gate", async () => {
    const fixture = finalGateFixture(); let validations = 0;
    Object.assign(fixture.sandbox, { trimForGroup: text => text, asStringId: String,
      privateMessageCooldowns: new Map(), ownerNotificationsActive: () => fixture.runtime.ownerNotifications.enabled,
      oneBotSend: (ws, action, params, binding) => fixture.sandbox.dispatchAccountAction(ws, action, params,
        () => { fixture.transmitted.push({ action }); return {}; }, binding) });
    new vm.Script(bridgeFunction("sendPrivateMessageToUser", "privateImageSegmentForFile")).runInContext(fixture.sandbox);
    fixture.sandbox.accountDeliveryDecision = (...args) => {
      if (++validations === 1) queueMicrotask(() => { fixture.runtime.ownerNotifications.enabled = true; });
      return accountDeliveryDecision(...args);
    };
    await assert.rejects(fixture.sandbox.sendPrivateMessageToUser(fixture.peers.get("alpha"), OWNER, "LEGACY_INFLIGHT_FIXTURE",
      { __activeAccountId: "alpha", __routineOwnerNotice: true }), { code: "ACCOUNT_SEND_BLOCKED" });
    assert.equal(fixture.transmitted.length, 0);
    await fixture.sandbox.sendPrivateMessageToUser(fixture.peers.get("alpha"), OWNER, "EXPLICIT_MANUAL_FIXTURE", { __activeAccountId: "alpha" });
    assert.equal(fixture.transmitted.length, 1, "center takeover does not indiscriminately block private owner commands");
  }, "src/bridge.js sendPrivateMessageToUser routine guard -> dispatchAccountAction");

  await test("owner status/tokens are direct, no model call or group send", async () => {
    const before = calls.length, groups = groupSends().length;
    const status = await command("/owner status"), tokens = await command("/owner tokens");
    check(status.text.includes("已核实") && tokens.text.includes("已核实"), "private direct query receipts");
    assert.equal(calls.length, before); assert.equal(groupSends().length, groups);
    check(!status.text.includes(PRIVATE) && !tokens.text.includes(PRIVATE), "private person data not in owner reports");
  });
  await test("known-scope owner send is real fake wire + private acknowledgment without approval", async () => {
    const before = calls.length, sent = await command("/owner send alpha 31001 hello");
    const rows = sent.rows.filter(row => row.action === "send_group_msg" && messageText(row) === "hello");
    assert.equal(rows.length, 1); assert.equal(rows[0].accountId, "alpha"); assert.equal(rows[0].params.group_id, 31001);
    check(!sent.text.includes("OWNER_CONFIRM_REQUIRED"), "known explicit send needs no second approval");
    assert.equal(calls.length, before); assert.equal((await operationFor(sent.messageId)).status, "confirmed", "valid message_id ACK must be confirmed");
    check(sent.text.includes("已核实"), "owner sees confirmed, not merely accepted");
  }, reportPointer.ack);
  await test("duplicate command message ID does not replay before or after restart", async () => {
    const source = inbound.find(row => row.text === "/owner send alpha 31001 hello"); assert(source);
    emit("alpha", source.text, { messageId: source.messageId }); await pause(400); assert.equal(groupSends("hello").length, 1);
    await stopBridge(); await launch(); emit("alpha", source.text, { messageId: source.messageId });
    await until(() => privateSends().some(row => messageText(row).includes("OWNER_ALREADY_CLAIMED")), "durable owner command dedup");
    assert.equal(groupSends("hello").length, 1);
  });
  await test("non-owner private and group owner spoof cannot perform privileged send", async () => {
    const before = calls.length;
    emit("alpha", "/owner send alpha 31001 SPOOF_PRIVATE", { userId: "22002" });
    emit("alpha", "/owner send alpha 31001 SPOOF_GROUP", { userId: OWNER, groupId: "31001" });
    emit("beta", "/owner send alpha 31001 SPOOF_GROUP_BETA", { userId: OWNER, groupId: "31001" });
    await pause(450); assert.equal(groupSends().filter(row => /^SPOOF_/.test(messageText(row))).length, 0);
    assert.equal(privateSends().filter(row => String(row.params.user_id) === "22002").length, 0); assert.equal(calls.length, before);
  });
  await test("known account but target outside owner allowedTargets is blocked", async () => {
    const result = await command("/owner send alpha 31002 WRONG_SCOPE");
    check(result.text.includes("OWNER_SCOPE_REQUIRED"), "scope refusal is explicit"); assert.equal(groupSends("WRONG_SCOPE").length, 0);
    const peer = await command("/owner send beta 31001 WRONG_ACCOUNT");
    check(peer.text.includes("OWNER_SCOPE_REQUIRED"), "peer is not an implicitly authorized target"); assert.equal(groupSends("WRONG_ACCOUNT").length, 0);
  });
  await test("owner quiet is persisted and blocks a later explicit send; resume restores eligibility", async () => {
    const quiet = await command("/owner quiet alpha 31001 2"); check(quiet.text.includes("OWNER_CONTROL_VERIFIED"), "quiet readback verified");
    const controls = snapshot().groups["31001"].settings.botSettings;
    check(controls["account:alpha"].quietUntil > Date.now(), "quiet persisted under the correct logical bot");
    check(!controls["account:beta"]?.quietUntil, "quiet did not mutate the independent peer");
    const sent = await command("/owner send alpha 31001 QUIET_MUST_BLOCK"); assert.equal(groupSends("QUIET_MUST_BLOCK").length, 0);
    check((await operationFor(sent.messageId)).status === "blocked", "quiet is blocked, not accepted/confirmed");
  });
  await test("resume from quiet is verified", async () => {
    const result = await command("/owner resume alpha 31001"); check(result.text.includes("OWNER_CONTROL_VERIFIED"), "resume succeeds after quiet");
  });
  for (const [marker, expected] of [["ACK_FAILED_FIXTURE", "failed"], ["ACK_MISSING_ID_FIXTURE", "accepted"], ["ACK_TIMEOUT_FIXTURE", "uncertain"]]) {
    await test(`OneBot ${marker} persists ${expected}, not fabricated success`, async () => {
      const started = Date.now(), result = await command(`/owner send alpha 31001 ${marker}`);
      assert.equal(groupSends(marker).length, 1); const operation = await operationFor(result.messageId);
      if (expected === "uncertain") check(Date.now() - started >= 4500 && Date.now() - started < 11000, "real ACK timeout shortened to bounded 5 seconds");
      assert.equal(operation.status, expected, `actual ${operation.status}; expected ${expected}`);
      const before = groupSends(marker).length; emit("alpha", `/owner send alpha 31001 ${marker}`, { messageId: result.messageId });
      await pause(200); assert.equal(groupSends(marker).length, before);
    }, reportPointer.ack);
  }
  await test("all owner HTTP endpoints require token", async () => {
    for (const route of ["/api/owner/status", "/api/owner/query?kind=tokens", peoplePath()]) assert.equal((await api(route, { auth: false })).status, 403, route);
    assert.equal((await api("/api/owner/settings", { method: "PATCH", body: {}, auth: false })).status, 403);
    assert.equal((await api("/api/people/admin", { method: "POST", body: {}, auth: false })).status, 403);
  }, reportPointer.auth);
  await test("mutating owner/people HTTP endpoints require same-origin JSON and token", async () => {
    for (const [route, method] of [["/api/owner/settings", "PATCH"], ["/api/people/admin", "POST"]]) {
      assert.equal((await api(route, { method, body: {}, origin: "http://outside.invalid" })).status, 403);
      assert.equal((await api(route, { method, body: {}, origin: null })).status, 403);
      assert.equal((await api(route, { method, body: {}, headers: { "content-type": "text/plain" } })).status, 403);
    }
  }, reportPointer.auth);
  await test("owner HTTP rejects non-loopback Host and invalid token", async () => {
    assert.equal((await rawHostRequest("/api/owner/status", "outside.invalid")).status, 403, "actual non-loopback Host refused");
    assert.equal((await api("/api/owner/status", { headers: { "x-hermes-qq-admin": "fixture-invalid-token" } })).status, 403, "invalid session token refused");
  }, reportPointer.auth);
  await test("owner/people GET rejects cross-origin even with a session token", async () => {
    const routes = ["/api/owner/status", "/api/owner/query?kind=tokens", peoplePath()];
    const replies = await Promise.all(routes.map(route => api(route, { origin: "http://outside.invalid" })));
    assert.deepEqual(replies.map(reply => reply.status), [403, 403, 403], "status/query/people all require same-origin reads");
  }, reportPointer.auth);
  await test("HTTP status/query readbacks are inert and carry safe notification defaults", async () => {
    const before = calls.length, status = await api("/api/owner/status"); assert.equal(status.status, 200);
    assert.equal(status.body.control.enabled, true); assert.equal(status.body.notifications.enabled, false);
    assert.deepEqual(status.body.notifications.times, ["09:00", "21:00"]); assert.equal(status.body.notifications.timezone, "Asia/Shanghai");
    for (const kind of ["status", "tokens", "blockers", "tasks", "history"]) assert.equal((await api(`/api/owner/query?kind=${kind}`)).status, 200);
    assert.equal(calls.length, before); check(!JSON.stringify(status.body).includes(PRIVATE), "owner report does not contain person private text");
  });
  await test("HTTP settings exact config CAS, strict whitelist and persisted readback", async () => {
    const status = (await api("/api/owner/status")).body;
    assert.equal((await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: "wrong", people: { enabled: false } } })).status, 409);
    assert.equal((await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: status.revision, control: { unexpectedAuthority: true } } })).status, 400);
    const saved = await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: status.revision,
      notifications: { enabled: false, times: ["09:00", "21:00"], timezone: "Asia/Shanghai" }, people: { enabled: true } } });
    assert.equal(saved.status, 200); assert.equal(saved.body.people.enabled, true);
    const disk = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(disk.ownerNotifications.enabled, false); assert.equal(disk.memory.people.enabled, true);
    assert.equal(disk.ownerControl.naturalLanguage, false); check(!JSON.stringify(disk).includes("synthetic-fixture-not-a-real-key"), "credential is environment-only");
  });
  await test("seeded people public cross-group projection isolates logical bots and private evidence", async () => {
    const alpha = await profile(), beta = await profile("beta"), privateProfile = await profile("alpha", `private:${PERSON}`);
    assert.deepEqual(alpha.profile.entries.map(entry => entry.value), [PUBLIC]); assert.deepEqual(beta.profile.entries.map(entry => entry.value), [BETA]);
    assert.deepEqual(privateProfile.profile.entries.map(entry => entry.value), [PRIVATE]);
    check(!JSON.stringify(alpha).includes(PRIVATE) && !JSON.stringify(beta).includes(PRIVATE), "no private group leakage");
    const report = await command(`/owner people alpha ${PERSON}`); check(report.text.includes(PUBLIC), "owner uses allowed public target context");
    check(!report.text.includes(PRIVATE) && !report.text.includes(BETA), "owner person query does not concatenate private/peer data");
    assert.equal((await api(peoplePath("missing"))).status, 400);
    assert.equal((await api(peoplePath("alpha", "group:31003"))).status, 400);
  }, reportPointer.people);
  await test("addressed /bot memory reads person index, not legacy arrays or private fragments", async () => {
    const before = calls.length, text = await groupMemoryCommand();
    check(text.includes(PUBLIC), "positive control: actual command reaches alpha person index");
    for (const marker of [LEGACY, PRIVATE, BETA, OWN_FRAGMENT, OTHER_FRAGMENT]) check(!text.includes(marker), "only eligible public alpha evidence is displayed");
    const privateOnly = await groupMemoryCommand("22002");
    check(privateOnly.includes("当前没有适合在此会话展示"), "private-only person has no group projection");
    check(!privateOnly.includes(OTHER_FRAGMENT), "undeleted other person's private evidence never enters group command");
    assert.equal(calls.length, before, "deterministic memory queries do not invoke a model");
  }, "src/bridge.js handleBotCommand memory index projection");
  await test("actual private fragment projection fixes conversation subject for both scoped job keys", async () => {
    const state = snapshot(), original = structuredClone(state);
    const observed = [], sandbox = vm.createContext({ Date, logicalBotId: () => "account:alpha",
      personMemoryContext: (memory, options) => { const args = structuredClone(options); observed.push(args); return personMemoryContext(memory, args); } });
    new vm.Script(bridgeFunction("compactSelectedMemory", "buildContextBundle")).runInContext(sandbox);
    for (const conversationId of [`private:${OWNER}:alpha`, `private:${OWNER}:group:FixturePair`]) {
      const text = sandbox.compactSelectedMemory({}, [OWNER, "22002"], { memory: { people: { enabled: true } } }, "", state, conversationId);
      check(text.includes(OWN_FRAGMENT), "positive control: own private context remains available");
      check(!text.includes(OTHER_FRAGMENT), "mapped user must not select another person's private conversation");
    }
    assert.deepEqual(observed.map(args => args.conversationId), Array(4).fill(`private:${OWNER}`));
    assert.deepEqual(state, original, "read-only context adds no persistent defaults");
  }, "src/bridge.js compactSelectedMemory scoped private conversation projection");
  await test("people config revision and people integer CAS are separate and fail closed", async () => {
    const before = await profile();
    for (const patch of [{ expectedRevision: "wrong" }, { personRevision: before.profile.revision - 1 }, { personRevision: String(before.profile.revision) }]) {
      const result = await api("/api/people/admin", { method: "POST", body: { expectedRevision: before.revision,
        personRevision: before.profile.revision, accountId: "alpha", userId: PERSON, operation: "freeze", ...patch } });
      assert.equal(result.status, 409); assert.equal((await profile()).profile.status, "active");
    }
  }, reportPointer.people);
  await test("people freeze/unfreeze is persisted and never affects beta", async () => {
    assert.equal((await administer("freeze")).status, 200); assert.equal((await profile()).profile.status, "frozen");
    assert.deepEqual((await profile()).profile.entries, []); assert.equal((await profile("beta")).profile.status, "active");
    assert.equal((await administer("unfreeze")).status, 200); assert.equal((await profile()).profile.entries[0].value, PUBLIC);
  }, reportPointer.people);
  await test("people exact-entry correction then deletion exposes suppression flag and no legacy resurrection", async () => {
    const before = await profile(), entryId = before.profile.entries[0].id;
    assert.equal((await administer("correct", { entryId, value: "CORRECTED_ALPHA_PERSON_FIXTURE" })).status, 200);
    const local = await profile("alpha", "group:31001"); check(local.profile.entries.some(entry => entry.value === "CORRECTED_ALPHA_PERSON_FIXTURE"), "corrected entry stays origin-scoped");
    assert.equal((await administer("delete")).status, 200); const deleted = await profile();
    assert.equal(deleted.profile.status, "deleted"); assert.equal(deleted.profile.suppressesLegacy, true); assert.deepEqual(deleted.profile.entries, []);
    assert.equal((await administer("unfreeze")).status, 409); assert.equal((await profile("beta")).profile.entries[0].value, BETA);
    const disk = snapshot(); assert.equal(disk.peopleMemory.bots["account:alpha"].people[PERSON].status, "deleted");
    assert.equal(disk.groups["31001"].users[PERSON].profile[0], LEGACY, "old arrays remain intact, not silently erased");
  }, reportPointer.people);
  await test("/bot memory after person deletion cannot resurrect old LEGACY content", async () => {
    const before = calls.length, text = await groupMemoryCommand();
    check(text.includes("当前没有适合在此会话展示"), "deleted person has no displayable person memory");
    for (const marker of [LEGACY, PRIVATE, PUBLIC, OTHER_FRAGMENT]) check(!text.includes(marker), "deleted/index-private values stay absent from actual wire");
    assert.equal(snapshot().groups["31001"].users[PERSON].profile[0], LEGACY);
    assert.equal((await profile()).profile.status, "deleted"); assert.equal(calls.length, before);
  }, "src/bridge.js handleBotCommand memory deleted-person projection");
  await test("people feature off still honors irreversible tombstone in /bot memory", async () => {
    const before = calls.length;
    try {
      const current = (await api("/api/owner/status")).body;
      const changed = await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: current.revision, people: { enabled: false } } });
      assert.equal(changed.status, 200); assert.equal(changed.body.people.enabled, false);
      const text = await groupMemoryCommand();
      check(text.includes("旧群画像不会作为备用内容显示"), "legacy fallback is explicitly suppressed while feature is off");
      check(!text.includes(LEGACY) && !text.includes(PRIVATE), "disabling people does not restore legacy/private values");
      const deleted = await profile(); assert.equal(deleted.profile.status, "deleted"); assert.equal(deleted.profile.suppressesLegacy, true);
      assert.equal(snapshot().groups["31001"].users[PERSON].profile[0], LEGACY);
      assert.equal(calls.length, before);
    } finally {
      const current = (await api("/api/owner/status")).body;
      const restored = await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: current.revision, people: { enabled: true } } });
      assert.equal(restored.status, 200); assert.equal(restored.body.people.enabled, true);
    }
  }, "src/bridge.js handleBotCommand personMemoryControl fallback suppression");
  await test("people-mode /bot memory correct cannot modify only legacy state", async () => {
    const before = snapshot(), count = calls.length;
    const text = await groupMemoryCommand("correct legacy-fixture-id reject");
    check(text.includes("人物索引已启用") && text.includes("人物长期档案"), "old correction command directs exact indexed administration");
    const after = snapshot(); assert.deepEqual(after.peopleMemory, before.peopleMemory);
    assert.deepEqual(after.groups["31001"].users[PERSON], before.groups["31001"].users[PERSON]);
    assert.equal(calls.length, count);
  }, "src/bridge.js handleBotCommand memory correct people-mode guard");
  await test("ordinary HTTP-only reply records actual structured 11/3/14 usage, no command-query model spend", async () => {
    const before = calls.length, id = emit("alpha", "请给一句普通回答", { userId: PERSON, groupId: "31001", mention: true });
    await until(() => groupSends("fixture plain reply").length >= 1, "ordinary reply via fake HTTP");
    await until(() => snapshot().operationalLedger?.calls?.some(row => row.usage?.totalTokens === 14 && row.status === "confirmed"), "durable actual usage");
    const rows = snapshot().operationalLedger.calls.filter(row => row.startedAt && row.status === "confirmed");
    check(rows.some(row => row.accountId === "alpha" && row.logicalBotId === "account:alpha" && row.usage.inputTokens === 11
      && row.usage.outputTokens === 3 && row.usage.totalTokens === 14), "structured transport metadata, not text estimation");
    assert(calls.length > before); check(calls.every(call => [PRIVATE, LEGACY, OWN_FRAGMENT, OTHER_FRAGMENT].every(marker => !call.prompt.includes(marker))), "deleted legacy/private values do not reenter prompt");
    const count = calls.length; await command("/owner tokens");
    const usageQuery = await api("/api/owner/query?kind=tokens&account_id=alpha"); assert.equal(calls.length, count);
    assert.equal(usageQuery.body.stats.tokens.inputTokens.knownTokens, 11);
    assert.equal(usageQuery.body.stats.tokens.outputTokens.knownTokens, 3);
    assert.equal(usageQuery.body.stats.tokens.totalTokens.knownTokens, 14);
    check(Boolean(id), "inbound message has a real fixture source ID");
  }, "src/bridge.js callHermes ledger wrapper / src/text-completion.js");
  await test("durable person freeze cancels an in-flight old-context reply before wire", async () => {
    let started = false; slowReplyStarted = () => { started = true; };
    const before = groupSends("STALE_PERSON_CONTROL_REPLY_MUST_NOT_SEND").length;
    try {
      emit("alpha", "SLOW_PERSON_CONTROL_FIXTURE 请回答", { userId: "22004", groupId: "31001", mention: true });
      await until(() => started, "slow model started before control");
      const current = await profile("alpha", "group:31001", "22004");
      const result = await api("/api/people/admin", { method: "POST", body: {
        expectedRevision: current.revision, personRevision: current.profile.revision,
        accountId: "alpha", userId: "22004", operation: "freeze" } });
      assert.equal(result.status, 200); assert.equal(result.body.result.changed, true);
      assert(snapshot().peopleMemory.bots["account:alpha"].controlRevision > 0);
      slowReplyRelease?.(); await pause(1200);
      assert.equal(groupSends("STALE_PERSON_CONTROL_REPLY_MUST_NOT_SEND").length, before);
      const ledger = snapshot().operationalLedger.calls;
      check(ledger.some(row => row.kind === "chat" && ["uncertain", "failed"].includes(row.status)), "cancelled model call is not silently confirmed or retried");
    } finally { slowReplyRelease?.(); slowReplyStarted = null; }
  }, "src/bridge.js accountMemoryControlRevision /api/people/admin final send guards");
  let extractionObserved = false;
  extractionStarted = () => { extractionObserved = true; };
  const groupId = "31002", first = "46001", second = "46002";
  await test("first real group intake durably captures both logical owners for one shared message", async () => {
    for (const id of ["alpha", "beta"]) emit(id, `我${EXTRACT}`, { userId: "22003", groupId, messageId: first, time: Math.floor((Date.now() - DAY) / 1000) });
    await until(() => Object.keys(snapshot().groups[groupId]?.peopleSourceIndex?.[first] || {}).length >= 1, "first original message admitted");
    await pause(600);
    assert.deepEqual(Object.keys(snapshot().groups[groupId].peopleSourceIndex[first]).sort(), ["account:alpha", "account:beta"]);
  }, reportPointer.intake);
  await test("second real intake retains both bot receipts despite shared extraction-job dedup", async () => {
    for (const id of ["alpha", "beta"]) emit(id, `仍然${EXTRACT}`, { userId: "22003", groupId, messageId: second });
    await until(() => Object.keys(snapshot().groups[groupId]?.peopleSourceIndex?.[second] || {}).length >= 1, "second original message admitted");
    await pause(600);
    assert.deepEqual(Object.keys(snapshot().groups[groupId].peopleSourceIndex[second]).sort(), ["account:alpha", "account:beta"]);
  }, reportPointer.intake);
  await test("background extraction uses mock HTTP, no CLI fallback, and atomically projects accepted owned sources", async () => {
    await until(() => {
      const guards = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
      check(!guards.some(row => row.type === "process" && /hermes/.test(row.code)), "background extraction attempted CLI model instead of bound HTTP; preload denied execution");
      return extractionObserved;
    }, "extraction reaches loopback HTTP", 8000);
    extractionRelease?.();
    await until(() => ["alpha", "beta"].every(id => snapshot().peopleMemory?.bots?.[`account:${id}`]?.people?.["22003"]?.entries.some(entry => entry.value === EXTRACT)), "accepted receipt people projection for both logical bots");
    // A value may exist before a subsequent extraction publication supplies
    // cross-date confirmation. Wait for the ACTUAL public query gate, not just
    // the first candidate's presence, and retain the same assertion below.
    await until(async () => {
      const responses = await Promise.all(["alpha", "beta"].map(id => api(peoplePath(id, "group:31001", "22003"))));
      return responses.every(response => response.status === 200 && response.body.profile.entries.some(entry => entry.value === EXTRACT));
    }, "both public cross-group query gates durably satisfied");
    const disk = snapshot(), source = disk.groups[groupId].peopleSourceIndex;
    for (const id of ["alpha", "beta"]) {
      assert.equal(source[first][`account:${id}`].accountId, id); assert.equal(source[first][`account:${id}`].verifiedSenderId, "22003");
      assert.equal(source[first][`account:${id}`].conversationId, "group:31002");
      check(!JSON.stringify(source[first][`account:${id}`]).includes(EXTRACT), "source index metadata contains no raw text");
      const response = await api(peoplePath(id, "group:31001", "22003"));
      assert.equal(response.status, 200); check(response.body.profile.entries.some(entry => entry.value === EXTRACT), "cross-date source times survive canonical extraction");
    }
  }, "src/bridge.js memoryExtractionRuntime.process -> callHermesTransport (global config)");
  extractionRelease?.();
  await test("all private owner reports omit private person marker and only fixture OneBots receive sends", async () => {
    check(privateSends().every(row => String(row.params.user_id) === OWNER), "no non-owner private transmission");
    check(privateSends().every(row => !messageText(row).includes(PRIVATE)), "private person marker is not a generic owner report");
    check(sends().every(row => !messageText(row).includes(OWN_FRAGMENT) && !messageText(row).includes(OTHER_FRAGMENT)), "unrelated private fragments never escape via reports/group commands");
    check(sends().every(row => ["alpha", "beta"].includes(row.accountId)), "all sends captured by fake sockets");
    check(groupSends().every(row => [31001, 31002].includes(row.params.group_id)), "no external group scope");
    check((await history()).every(row => !Object.hasOwn(row, "intent") && !Object.hasOwn(row, "prompt")), "report strips command content and pending proposals");
  });
  await test("real legacy-status HTTP endpoint is suppressed once notification center owns delivery", async () => {
    const original = (await api("/api/owner/status")).body.notifications;
    const future = new Date(Date.now() + 30 * 60000);
    const safeTime = `${String((future.getUTCHours() + 8) % 24).padStart(2, "0")}:${String(future.getUTCMinutes()).padStart(2, "0")}`;
    try {
      const current = (await api("/api/owner/status")).body;
      assert.equal((await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: current.revision,
        notifications: { enabled: true, times: [safeTime], timezone: "Asia/Shanghai" } } })).status, 200);
      const denied = await api("/api/send_private", { method: "POST", body: { account_id: "alpha", user_id: OWNER,
        message: "LEGACY_HTTP_MUST_NOT_SEND", source: "legacy-status-report" } });
      assert.equal(denied.status, 409); assert.equal(denied.body.code, "OWNER_NOTIFICATIONS_CENTRALIZED");
      assert.equal(privateSends().filter(row => messageText(row) === "LEGACY_HTTP_MUST_NOT_SEND").length, 0);
    } finally {
      const current = (await api("/api/owner/status")).body;
      assert.equal((await api("/api/owner/settings", { method: "PATCH", body: { expectedRevision: current.revision,
        notifications: { enabled: original.enabled, times: original.times, timezone: original.timezone } } })).status, 200);
    }
  }, "src/bridge.js /api/send_private legacy-status-report guard");
  await stopBridge();
  await test("IO guards prove no external process/network/production-state access", async () => {
    const guards = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    assert.deepEqual(guards.filter(row => ["network", "filesystem", "process"].includes(row.type)), []);
    check(guards.some(row => row.type === "timer" && row.code === "ONEBOT_SEND_ACK_5000MS"), "legacy OneBot send timer recognized at 20s only");
    check(guards.some(row => row.type === "timer" && row.code === "ONEBOT_REQUEST_ACK_5000MS"), "owner raw request ACK timer recognized at 20s only");
    check(guards.filter(row => row.type === "spawnSyncDenied").every(row => !["security", "hermes", "hermesqq2"].includes(row.code)), "no Keychain or CLI model lookup");
  }, "scripts/people-owner-integration-self-test.js fixture preload");
  if (process.env.HERMES_QQ_PEOPLE_UI === "1") await holdForUi();
} catch (error) {
  failures.push({ test: "fixture setup or unrecoverable stage", pointer: "scripts/people-owner-integration-self-test.js", error: error.message.slice(0, 1200) });
} finally {
  extractionRelease?.(); slowReplyRelease?.(); await stopBridge(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(resultSummary()));
if (failures.length) process.exitCode = 1;
