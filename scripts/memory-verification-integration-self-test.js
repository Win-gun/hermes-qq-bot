import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { MemoryRepository, readMemorySnapshot } from "../src/memory-repository.js";
import { ensureCanonicalMemory } from "../src/memory-integrity.js";
import { applyMemoryExtraction } from "../src/memory-application.js";
import { applyVerificationHints, collectVerificationCases, listVerificationCases } from "../src/memory-verification.js";

// Actual bridge HTTP, repository, command router, extraction and 30s notifier.
// Only synthetic state under one temp HOME; no inherited auth/env, real QQ,
// Docker daemon, external model, production config, or production logs.
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-verification-integration-"));
const memoryFile = path.join(home, "data", "memory.json");
const configFile = path.join(home, "config.json");
const callsFile = path.join(home, "model-calls.jsonl");
const G = { api: "810101", command: "810102", foreign: "810103", live: "810104", notice: "810105", queue: "810106" };
const U = "10001", OTHER = "10002", ADMIN = "90001", SCOPED = "90002", FOREIGN = "90003", STRANGER = "90009";
const T0 = "2020-01-01T00:00:00.000Z", T1 = "2021-01-02T00:00:00.000Z";
const QUIET = Date.parse("9999-12-31T00:00:00Z");
const longText = "我说明一下自己的偏好。" + "这是一段仅用于隔离测试的上下文。".repeat(32) + "最后纠正：我不喜欢咖啡。";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
const sends = [];
const wireErrors = [];
const sockets = new Map();
let child, childClosed, config, env, base, token, stage = "setup", passed = 0, launches = 0, modelCalls = 0;
const seededIds = {};
const oldIds = {};
const read = () => readMemorySnapshot(memoryFile);
const cases = (state = read()) => listVerificationCases(state, { now: new Date().toISOString() }).cases;
const callRows = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const notices = () => sends.filter(item => item.text.includes("【记忆核实】"));
const groupSends = () => sends.filter(item => item.action === "send_group_msg" || item.params.message_type === "group");
const entries = (state, group) => state.groups[group].users[U].canonicalMemory.entries;
const currentCase = id => cases().find(item => item.id === id);
const bytes = () => JSON.stringify(read());
function offlineUpdate(builder) {
  assert.equal(child, null, "offline fixtures must never compete with a live bridge writer");
  const repository = new MemoryRepository({ filePath: memoryFile });
  try {
    repository.acquireWriter();
    const state = repository.load();
    builder(state);
    repository.save(state, { expectedRevision: repository.revision });
    return state;
  } finally { repository.close(); }
}
async function test(name, run) {
  stage = name;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    failures.push({ name, error: String(error.message).slice(0, 1600) });
    console.log(`FAIL ${name}: ${String(error.message).slice(0, 1600)}`);
  }
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`${label}: BRIDGE_EXITED`);
    if (wireErrors.length) throw new Error(`${label}: ${wireErrors[0]}`);
    const violation = callRows().find(row => row.type === "violation");
    if (violation) throw new Error(`${label}: ${violation.code}`);
    try { if (await predicate()) return; }
    catch (error) { if (error.code !== "MEMORY_READ_BUSY") throw error; }
    await pause(40);
  }
  throw new Error(`${label}: TIMEOUT_${timeout}MS`);
}
async function http(route, { method = "GET", body, auth = true, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, { method,
    headers: { ...(auth && token ? { "x-hermes-qq-admin": token } : {}),
      ...(method !== "GET" ? { origin: base, "content-type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { status: response.status, data: await response.json() };
}
async function view() {
  const response = await http("/api/memory/verification");
  assert.equal(response.status, 200);
  return response.data;
}
async function configView() {
  const response = await http("/api/config");
  assert.equal(response.status, 200);
  return response.data;
}
async function patchSettings(settings) {
  const current = await configView();
  const response = await http("/api/config", { method: "PATCH", body: {
    expectedRevision: current.revision, memory: { verification: settings } } });
  assert.equal(response.status, 200);
  return response;
}
async function patchPrivate(privateChats) {
  const current = await configView();
  const response = await http("/api/config", { method: "PATCH", body: { expectedRevision: current.revision, privateChats } });
  assert.equal(response.status, 200);
  return response;
}
async function launch() {
  launches++;
  child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], { cwd: home, env, detached: true, stdio: "ignore" });
  childClosed = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("FIXTURE_SPAWN_FAILED")));
    child.once("close", resolve);
  });
  await until(async () => { try { return (await http("/health", { auth: false })).status === 200; } catch { return false; } }, "startup");
  const session = await http("/api/admin/session", { auth: false });
  assert.equal(session.status, 200);
  assert.equal(typeof session.data.token, "string");
  token = session.data.token; // Fixture-only token; never print it.
}
async function stop() {
  for (const socket of sockets.values()) socket.terminate();
  sockets.clear();
  if (!child) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await childClosed;
  child = null;
}
async function connect(accountId, qq) {
  const account = config.accounts.items.find(item => item.id === accountId);
  const socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${account.onebotPath}`);
  sockets.set(accountId, socket);
  socket.on("error", () => wireErrors.push(`SOCKET_${accountId}`));
  socket.on("message", raw => {
    try {
      const action = JSON.parse(String(raw));
      if (/^(send_|upload_)/.test(action.action)) {
        if (!["send_group_msg", "send_private_msg", "send_msg"].includes(action.action)) wireErrors.push("UNEXPECTED_UPLOAD_OR_SEND_TYPE");
        const text = typeof action.params?.message === "string" ? action.params.message
          : JSON.stringify(action.params?.message || []);
        sends.push({ accountId, action: action.action, params: action.params || {}, text });
      }
      if (action.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
        data: action.action === "get_login_info" ? { user_id: qq, nickname: `fixture ${accountId}` }
          : action.action === "get_status" ? { online: true, good: true }
            : action.action === "get_group_member_list" ? [U, OTHER, ADMIN, SCOPED, FOREIGN, qq].map(user_id => ({ user_id }))
              : { message_id: `wire-${sends.length}` } }));
    } catch { wireErrors.push(`INVALID_ACTION_${accountId}`); }
  });
  await until(() => socket.readyState === WebSocket.OPEN, "reverse OneBot connected");
  socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: qq, status: { online: true, good: true } }));
}
function send(accountId, { id, user = U, group, text, iso = new Date().toISOString() }) {
  const account = config.accounts.items.find(item => item.id === accountId);
  sockets.get(accountId).send(JSON.stringify({ post_type: "message", message_type: group ? "group" : "private",
    self_id: account.qq, ...(group ? { group_id: group } : {}), user_id: user, message_id: id,
    time: Math.floor(Date.parse(iso) / 1000), sender: { user_id: user, nickname: "fixture person", role: "member" },
    message: [{ type: "text", data: { text } }] }));
}
async function command(accountId, input) {
  const before = sends.length;
  send(accountId, input);
  await until(() => sends.length > before, "command reply");
  return sends.slice(before);
}
function sourceRow(group, id, text, extra = {}) {
  return { conversation_id: group, user_id: U, message_id: id, sent_at: T1, text, ...extra };
}
function seedGroup(groupId, quiet) {
  // Build source-bound canonical evidence from actual synthetic rows, not a
  // legacy import: legacy sourceConversationId must not be silently re-scoped.
  const user = { preferences: [], names: ["fixture member"], fixturePreserved: { value: "keep" } };
  ensureCanonicalMemory(user, U, { at: T0 });
  const group = { users: { [U]: user }, settings: { quietUntil: quiet ? QUIET : 0,
    botSettings: Object.fromEntries(["a", "b"].map(id => [`account:${id}`, { quietUntil: quiet ? QUIET : 0 }])) },
    facts: ["合成事实"], topics: ["合成话题"], fixturePreserved: { groupId } };
  const rows = [1, 2].map(n => sourceRow(groupId, `old-${groupId}-${n}`, "我喜欢黑咖啡。", { sent_at: T0 }));
  const result = applyMemoryExtraction(group, groupId, { canonical_entries: [{ user_id: U, kind: "preference",
    value: "喜欢黑咖啡", confidence: 0.95, source_message_ids: rows.map(row => row.message_id) }] }, rows);
  assert.equal(result.fatalErrors?.length || 0, 0);
  const old = group.users[U].canonicalMemory.entries.find(item => item.value === "喜欢黑咖啡");
  assert.equal(old.sourceMessageIds.length, 2);
  assert.equal(old.sourceConversationId, groupId);
  oldIds[groupId] = old.id;
  return group;
}

try {
  for (const dir of ["data", "tmp", "bin", "hermes"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { host: "127.0.0.1", port: await port(), path: "/verification-fixture" };
  config.control = { enabled: true, host: "127.0.0.1", port: await port() };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "fixture", profiles: [] };
  config.ai = { command: process.execPath, args: [path.join(home, "fake-model.mjs")], provider: "custom", model: "fixture-verification",
    credentialSource: "existing", apiKeyEnv: "FIXTURE_UNUSED_API_KEY", baseUrl: "http://127.0.0.1:9", timeoutMs: 12000 };
  for (const name of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply",
    "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[name] = { ...config[name], enabled: false };
  config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.privateChats = { ...config.privateChats, enabled: true,
    targetUsers: [ADMIN, SCOPED, FOREIGN, STRANGER, "90008"], ownerUserIds: [], instructionUserIds: [] };
  config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
  config.observability = { ...config.observability, logIncomingMessages: false, logSkippedMessages: false };
  config.memory = { ...config.memory, enabled: true,
    aiExtraction: { ...config.memory.aiExtraction, enabled: true, everyMessages: 4 },
    learning: { enabled: true, minBatchMessages: 4, maxBatchMessages: 16, settleMs: 1000, maxWaitMs: 10000,
      maxMessageChars: 4000, maxBatchChars: 12000 },
    verification: { enabled: true, adminUserIds: [], groupAdminUserIds: {
      [G.api]: [ADMIN], [G.command]: [SCOPED], [G.foreign]: [FOREIGN], [G.live]: [ADMIN], [G.notice]: [ADMIN], [G.queue]: [ADMIN]
    }, notificationAccountIds: { [G.notice]: "b", [G.live]: "b", [G.foreign]: "b" }, cooldownMs: 60000 } };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
    diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 }, items: [] };
  for (const [id, qq] of [["a", "91001"], ["b", "91002"]]) config.accounts.items.push({ id, qq, displayName: `fixture ${id}`,
    protocol: "napcat", enabled: true, managed: true, webuiPort: await port(), protocolEnabled: true,
    protocolContainer: `fixture-${id}`, onebotWsUrl: "", onebotPath: config.listen.path,
    features: { chat: false, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
    sendTypes: { text: true, image: false, record: false, video: false, file: false }, scope: { groups: true, private: true } });
  config = registryConfig(config, { strict: true });
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const initial = { groups: Object.fromEntries(Object.values(G).map(group => [group, seedGroup(group, ![G.command, G.notice].includes(group))])) };
  const seedNow = new Date().toISOString();
  for (const group of [G.api, G.command, G.foreign]) {
    const result = applyVerificationHints(initial.groups[group], group, [{ subjectUserId: U, memoryId: oldIds[group],
      newValue: "喜欢红茶", sourceMessageIds: [`candidate-${group}`], relation: "change" }],
    [sourceRow(group, `candidate-${group}`, "我现在喜欢红茶。")], { now: seedNow, config });
    assert.equal(result.created.length, 1);
    seededIds[group] = result.created[0].id;
  }
  const noticeRows = [1, 2].map(n => sourceRow(G.notice, `notice-source-${n}`, "我不喜欢黑咖啡。"));
  applyMemoryExtraction(initial.groups[G.notice], G.notice, { canonical_entries: [{ user_id: U, kind: "preference",
    value: "不喜欢黑咖啡", confidence: 0.95, source_message_ids: noticeRows.map(row => row.message_id) }] }, noticeRows);
  const collected = collectVerificationCases(initial.groups[G.notice], G.notice, { now: seedNow, config });
  assert.equal(collected.created.length, 1, "collect must seed a real canonical conflict");
  seededIds[G.notice] = collected.created[0].id;
  initial.groups[G.queue].pendingMemoryMessages = [sourceRow(G.queue, "unknown-queue-source", "合成旧队列内容。")];
  fs.writeFileSync(memoryFile, JSON.stringify(initial), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "plan.json"), JSON.stringify({ group: G.live, oldId: oldIds[G.live], text: longText }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "fake-model.mjs"), String.raw`import fs from "node:fs";
import path from "node:path";
import { readMemorySnapshot } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "memory-repository.js")).href)};
const home=process.env.HERMES_QQ_HOME, prompt=process.argv.at(-1);
const log=row=>fs.appendFileSync(path.join(home,"model-calls.jsonl"),JSON.stringify(row)+"\n");
const fail=code=>{log({type:"violation",code});process.exit(4);};
if(Object.keys(process.env).some(key=>/(?:API_KEY|ACCESS_TOKEN|PASSWORD|COOKIE|SECRET)$/i.test(key)&&process.env[key]))fail("INHERITED_CREDENTIAL");
const plan=JSON.parse(fs.readFileSync(path.join(home,"plan.json"),"utf8"));
let memory;
for(let n=0;n<80;n++){try{memory=readMemorySnapshot(path.join(home,"data","memory.json"));break;}catch(e){if(e.code!=="MEMORY_READ_BUSY")fail("SNAPSHOT_FAILED");await new Promise(r=>setTimeout(r,25));}}
if(!memory)fail("SNAPSHOT_TIMEOUT");
const matches=Object.entries(memory.groups||{}).flatMap(([group,gm])=>{
 const state=gm.memoryExtractionJobs,batch=state?.batch;if(batch?.status!=="running")return [];
 const rows=batch.keys.map(key=>state.messages.find(row=>row.key===key)?.input);
 return rows.every(row=>row&&prompt.includes(row.message_id))?[{group,batch,rows}]:[];
});
if(matches.length!==1)fail("NO_UNIQUE_DURABLE_CLAIM");
const {group,batch,rows}=matches[0],ids=rows.map(row=>row.message_id);
if(group===${JSON.stringify(G.queue)}){
 if(JSON.stringify(ids)!==JSON.stringify(["unknown-queue-source"]))fail("UNKNOWN_QUEUE_IDS_CHANGED");
 log({type:"extraction",group,ids,batchId:batch.id,durable:true});process.stdout.write("{}");
}else{
 if(group!==plan.group||JSON.stringify(ids)!==JSON.stringify(["live-long","live-foreign","live-third","live-fourth"]))fail("UNPLANNED_CALL_OR_REVIEWER");
 if(!prompt.includes(plan.text)||!prompt.includes("最后纠正：我不喜欢咖啡。"))fail("LONG_TAIL_OMITTED_220");
 const presented=[...prompt.matchAll(/"message_id"\s*:\s*"([^"\n]+)"/g)].map(m=>m[1]);
 if(presented.some(id=>!ids.includes(id))||new Set(presented).size!==ids.length)fail("INVENTED_OR_MISSING_SOURCE_IDS");
 if(rows.find(row=>row.message_id==="live-long").sentAt!==${JSON.stringify(T1)})fail("ORIGINAL_TIME_CHANGED");
 log({type:"extraction",group,ids,batchId:batch.id,durable:true,longTail:true});
 process.stdout.write(JSON.stringify({memory_conflicts:[
 {subjectUserId:${JSON.stringify(U)},memoryId:plan.oldId,newValue:"不喜欢咖啡",sourceMessageIds:["live-long"],relation:"change"},
 {subjectUserId:${JSON.stringify(U)},memoryId:plan.oldId,newValue:"伪造缺失来源",sourceMessageIds:["missing-source"],relation:"change"},
 {subjectUserId:${JSON.stringify(U)},memoryId:plan.oldId,newValue:"伪造他人来源",sourceMessageIds:["live-foreign"],relation:"change"}]}));
}
`, { mode: 0o600 });
  env = { HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8",
    PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home,
    HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  base = `http://127.0.0.1:${config.control.port}`;
  await launch(); await connect("a", "91001"); await connect("b", "91002");

  await test("GET verification requires admin session, including GET", async () => {
    assert.equal((await http("/api/memory/verification", { auth: false })).status, 403);
    assert.equal((await http("/api/memory/verification", { headers: { "x-hermes-qq-admin": "invalid-fixture-token" } })).status, 403);
    const result = await view();
    assert.equal(result.settings.shadowMode, true);
    assert.equal(result.settings.perGroupDailyLimit, 3);
    assert.ok(result.cases.some(item => item.id === seededIds[G.api]));
    assert.equal(typeof result.configRevision, "string");
  });
  await test("GET pagination is complete and group:digits filters normalize to raw IDs", async () => {
    const full = await view();
    assert.ok(full.cases.length >= 4);
    const first = await http("/api/memory/verification?offset=0&limit=2");
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.cases.map(item => item.id), full.cases.slice(0, 2).map(item => item.id));
    assert.equal(first.data.pagination.nextOffset, 2);
    assert.equal(first.data.pagination.hasMore, true);
    const second = await http("/api/memory/verification?offset=2&limit=2");
    assert.equal(second.status, 200);
    assert.deepEqual(second.data.cases.map(item => item.id), full.cases.slice(2, 4).map(item => item.id));
    assert.equal(new Set([...first.data.cases, ...second.data.cases].map(item => item.id)).size, 4);
    const raw = await http(`/api/memory/verification?conversation_id=${G.api}`);
    const prefixed = await http(`/api/memory/verification?conversation_id=group%3A${G.api}`);
    assert.equal(raw.status, 200);
    assert.equal(prefixed.status, 200);
    assert.deepEqual(prefixed.data.cases.map(item => item.id), raw.data.cases.map(item => item.id));
    assert.deepEqual(raw.data.cases.map(item => item.id), [seededIds[G.api]]);
  });
  await test("invalid GET filters fail 400 instead of false empty success", async () => {
    // Let the independently scheduled legacy import finish before a whole-root
    // no-mutation assertion; its legitimate ACK is not a GET side effect.
    await until(() => read().groups[G.queue].memoryExtractionJobs?.acknowledged?.includes(
      JSON.stringify([G.queue, "id", "unknown-queue-source"])), "legacy import settled before GET comparison");
    const before = bytes();
    for (const query of ["status=unknown", "offset=-1", "offset=0.5", "limit=0", "limit=201", "conversation_id=bad%20scope"]) {
      const response = await http(`/api/memory/verification?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.data.ok, false);
    }
    assert.equal(bytes(), before);
  });
  await test("quiet real extraction: durable claim, long tail/original IDs, conflict plus ACK, no reviewer", async () => {
    for (const [id, user, text] of [["live-long", U, longText], ["live-foreign", OTHER, "他人的合成偏好。"],
      ["live-third", U, "这条只是补充背景。"], ["live-fourth", U, "补充结束了。"]])
      send("a", { id, user, group: G.live, text, iso: T1 });
    await until(() => {
      const state = read(), jobs = state.groups[G.live].memoryExtractionJobs;
      return cases(state).some(item => item.conversationId === G.live)
        && ["live-long", "live-foreign", "live-third", "live-fourth"].every(id => jobs?.acknowledged?.includes(JSON.stringify([G.live, "id", id])));
    }, "live conflict and ACK durable", 18000);
    const liveCases = cases().filter(item => item.conversationId === G.live);
    assert.equal(liveCases.length, 1, "foreign/missing sources must not create candidates");
    const item = liveCases[0];
    assert.equal(item.status, "pending");
    assert.deepEqual(item.newMemory.sourceMessageIds, ["live-long"]);
    assert.equal(item.newMemory.evidence.sourceMessageTimes["live-long"], T1);
    assert.equal(item.newMemory.firstSeenAt, T1);
    assert.equal(groupSends().length, 0);
    assert.equal(sends.length, 0, "shadow mode must not privately notify");
    assert.equal(callRows().filter(row => row.group === G.live).length, 1);
  });
  await test("unknown old queue timestamp can flush without inventing event chronology", async () => {
    await until(() => read().groups[G.queue].memoryExtractionJobs?.acknowledged?.includes(JSON.stringify([G.queue, "id", "unknown-queue-source"])), "legacy queue ACK");
    assert.equal(callRows().filter(row => row.group === G.queue).length, 1);
    assert.equal(callRows().length, 2, "only the two planned extraction calls; no reviewer");
  });
  await test("console resolve uses server authority, preserves sources and adds ADMIN provenance exactly once", async () => {
    const item = (await view()).cases.find(row => row.id === seededIds[G.api]);
    const before = entries(read(), G.api).find(row => row.id === oldIds[G.api]);
    const response = await http("/api/memory/verification/resolve", { method: "POST", body: {
      conversationId: G.api, caseId: item.id, expectedRevision: item.revision, action: "update", authorized: false, actorUserId: STRANGER } });
    assert.equal(response.status, 200);
    assert.equal(response.data.ok, true);
    const after = entries(read(), G.api);
    const original = after.find(row => row.id === oldIds[G.api]);
    assert.deepEqual(original.sourceMessageIds, before.sourceMessageIds);
    assert.deepEqual(original.sourceMessageTimes, before.sourceMessageTimes);
    const versions = after.filter(row => row.source === "admin-verification");
    assert.equal(versions.length, 1);
    assert.deepEqual(versions[0].sourceMessageIds, [`candidate-${G.api}`]);
    assert.equal(versions[0].sourceMessageTimes[`candidate-${G.api}`], T1);
    assert.equal(versions[0].firstSeenAt, T1);
    assert.equal(versions[0].adminProvenance.at(-1).actorUserId, "local-admin");
    assert.equal(versions[0].adminProvenance.at(-1).type, "ADMIN");
    const stable = bytes();
    const replay = await http("/api/memory/verification/resolve", { method: "POST", body: {
      conversationId: G.api, caseId: item.id, expectedRevision: item.revision, action: "update", authorized: true, actorUserId: STRANGER } });
    assert.equal(replay.status, 409);
    assert.equal(bytes(), stable, "stale resolution must leave ALL state intact");
  });
  await test("resolve spoof cannot bypass missing session", async () => {
    const item = currentCase(seededIds[G.foreign]), before = bytes();
    const response = await http("/api/memory/verification/resolve", { method: "POST", auth: false, body: {
      conversationId: G.foreign, caseId: item.id, expectedRevision: item.revision, action: "update", authorized: true, actorUserId: "local-admin" } });
    assert.equal(response.status, 403);
    assert.equal(bytes(), before);
  });
  await test("stale pending-case CAS refuses without changing any state", async () => {
    const item = currentCase(seededIds[G.foreign]);
    assert.equal(item.status, "pending");
    const before = bytes();
    const staleRevision = item.revision.slice(0, -1) + (item.revision.endsWith("0") ? "1" : "0");
    const response = await http("/api/memory/verification/resolve", { method: "POST", body: {
      conversationId: G.foreign, caseId: item.id, expectedRevision: staleRevision, action: "update" } });
    assert.equal(response.status, 409);
    assert.equal(bytes(), before);
  });
  await test("PATCH learning/verification requires token, local origin and JSON", async () => {
    const revision = (await configView()).revision;
    for (const memory of [{ verification: { shadowMode: true } }, { learning: { settleMs: 1000 } }]) {
      for (const options of [{ auth: false }, { headers: { origin: "http://foreign.invalid" } },
        { headers: { "content-type": "text/plain" } }, { headers: { origin: "" } }]) {
        const before = fs.readFileSync(configFile, "utf8");
        const response = await http("/api/config", { method: "PATCH", body: { expectedRevision: revision, memory }, ...options });
        assert.equal(response.status, 403);
        assert.equal(fs.readFileSync(configFile, "utf8"), before);
      }
    }
  });
  await test("owner/instruction grants require admin session and leave denied bytes untouched", async () => {
    for (const field of ["ownerUserIds", "instructionUserIds"]) {
      for (const options of [{ auth: false }, { headers: { origin: "http://foreign.invalid" } },
        { headers: { origin: "" } }, { headers: { "content-type": "text/plain" } }]) {
        const before = fs.readFileSync(configFile, "utf8");
        const revision = (await configView()).revision;
        const response = await http("/api/config", { method: "PATCH", body: {
          expectedRevision: revision, privateChats: { [field]: ["90008"] } }, ...options });
        assert.equal(response.status, 403, `${field}: unauthenticated/foreign-origin grant must fail`);
        assert.equal(fs.readFileSync(configFile, "utf8"), before);
      }
    }
  });
  await test("authenticated owner grant succeeds and is restored before scoped permission checks", async () => {
    const initial = await configView();
    const before = initial.privateChats.ownerUserIds;
    try {
      const response = await http("/api/config", { method: "PATCH", body: {
        expectedRevision: initial.revision, privateChats: { ownerUserIds: ["90008"] } } });
      assert.equal(response.status, 200);
      const current = await configView();
      assert.deepEqual(current.privateChats.ownerUserIds, ["90008"]);
      assert.notEqual(current.revision, initial.revision);
    } finally {
      const revision = (await configView()).revision;
      const restored = await http("/api/config", { method: "PATCH", body: {
        expectedRevision: revision, privateChats: { ownerUserIds: before } } });
      assert.equal(restored.status, 200);
      assert.deepEqual((await configView()).privateChats.ownerUserIds, before);
    }
  });
  for (const [name, value] of [["verification", { shadowMode: true }], ["learning", { settleMs: 1000 }]]) {
    await test(`PATCH ${name} requires expectedRevision`, async () => {
      const before = fs.readFileSync(configFile, "utf8");
      const response = await http("/api/config", { method: "PATCH", body: { memory: { [name]: value } } });
      assert.ok([400, 409, 428].includes(response.status), `missing expectedRevision returned ${response.status}; expected refusal`);
      assert.equal(fs.readFileSync(configFile, "utf8"), before);
    });
  }
  await test("PATCH settings CAS applies once; stale config leaves exact bytes", async () => {
    const revision = (await configView()).revision;
    const response = await http("/api/config", { method: "PATCH", body: {
      expectedRevision: revision, memory: { verification: { perGroupDailyLimit: 2 } } } });
    assert.equal(response.status, 200);
    assert.equal((await view()).settings.perGroupDailyLimit, 2);
    const before = fs.readFileSync(configFile, "utf8");
    assert.equal((await http("/api/config", { method: "PATCH", body: {
      expectedRevision: revision, memory: { verification: { perGroupDailyLimit: 3 } } } })).status, 409);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
  });
  await test("explicit /bot a memory pending routes once across two carriers and stays group scoped", async () => {
    const before = sends.length;
    for (const account of ["a", "b"]) send(account, { id: "group-pending-command", user: SCOPED, group: G.command, text: "/bot a memory pending" });
    await until(() => sends.length > before, "targeted group command");
    await pause(300);
    const replies = sends.slice(before);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].accountId, "a");
    assert.equal(replies[0].action, "send_group_msg");
    assert.equal(String(replies[0].params.group_id), G.command);
    assert.ok(replies[0].text.includes(seededIds[G.command]));
    assert.ok(!replies[0].text.includes(seededIds[G.foreign]));
  });
  await test("scoped memory admin controls bypass owner-only private targets, ordinary messages/disabled private do not", async () => {
    const current = await configView();
    const previous = { enabled: current.privateChats.enabled, targetUsers: current.privateChats.targetUsers,
      ownerUserIds: current.privateChats.ownerUserIds };
    try {
      await patchPrivate({ enabled: true, targetUsers: [ADMIN], ownerUserIds: [ADMIN] });
      const before = sends.length, modelCount = callRows().length;
      const privateBefore = JSON.stringify(read().groups[`private:${SCOPED}`] || null);
      send("a", { id: "ordinary-private-excluded", user: SCOPED, text: "普通聊天，不是控制指令。" });
      await pause(300);
      assert.equal(sends.length, before);
      assert.equal(callRows().length, modelCount);
      assert.equal(JSON.stringify(read().groups[`private:${SCOPED}`] || null), privateBefore,
        "excluded ordinary private text must not enter memory intake");
      const replies = await command("a", { id: "private-owner-only-pending", user: SCOPED, text: "/bot memory pending" });
      assert.equal(replies.length, 1);
      assert.equal(replies[0].action, "send_private_msg");
      assert.ok(replies[0].text.includes(seededIds[G.command]));
      assert.ok(!replies[0].text.includes(seededIds[G.foreign]));
      await patchPrivate({ enabled: false });
      const count = sends.length;
      send("a", { id: "private-disabled-pending", user: SCOPED, text: "/bot memory pending" });
      await pause(300);
      assert.equal(sends.length, count);
    } finally { await patchPrivate(previous); }
  });
  await test("group-specific admin private pending cannot see foreign group cases", async () => {
    const replies = await command("a", { id: "private-pending", user: SCOPED, text: "/bot memory pending" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].action, "send_private_msg");
    assert.ok(replies[0].text.includes(seededIds[G.command]));
    for (const group of [G.foreign, G.api, G.notice]) assert.ok(!replies[0].text.includes(seededIds[group]));
  });
  await test("nonadmin and cross-group resolve cannot alter cases", async () => {
    for (const [actor, group] of [[STRANGER, G.command], [SCOPED, G.foreign]]) {
      const item = currentCase(seededIds[group]);
      const before = JSON.stringify(read().groups[group]);
      const replies = await command("a", { id: `blocked-${actor}`, user: actor,
        text: `/bot memory resolve ${item.id} update ${item.revision}` });
      assert.ok(replies[0].text.includes("未修改"));
      assert.equal(JSON.stringify(read().groups[group]), before);
    }
  });
  await test("private resolve authenticates exact event sender, revision and original command provenance", async () => {
    const item = currentCase(seededIds[G.command]);
    const commandTime = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const replies = await command("a", { id: "private-resolve-authorized", user: SCOPED, iso: commandTime,
      text: `/bot memory resolve ${item.id} update ${item.revision}` });
    assert.ok(replies[0].text.includes("已保存"));
    const versions = entries(read(), G.command).filter(row => row.source === "admin-verification");
    assert.equal(versions.length, 1);
    const admin = versions[0].adminProvenance.at(-1);
    assert.equal(admin.actorUserId, SCOPED);
    assert.equal(admin.sourceMessageId, "private-resolve-authorized");
    assert.equal(admin.sourceSentAt, commandTime, "original command time is evidence, not the transaction clock");
    assert.ok(Date.parse(admin.at) >= Date.parse(commandTime) && Date.parse(admin.at) <= Date.now());
    assert.equal(currentCase(item.id).status, "resolved");
  });
  await test("strict quiet suppresses even explicit group pending command", async () => {
    const before = sends.length;
    send("a", { id: "quiet-pending", user: ADMIN, group: G.live, text: "/bot a memory pending" });
    await pause(500);
    assert.equal(sends.length, before);
    assert.equal(notices().length, 0);
  });
  await test("real 30s dispatcher: one PRIVATE designated-carrier notice, quiet groups suppressed", async () => {
    assert.equal(notices().length, 0);
    await patchSettings({ shadowMode: false });
    await until(() => notices().length > 0, "first live private notice", 35000);
    await until(() => read().groups[G.notice].memoryVerification.notifications?.some(row => row.status === "sent"), "notice receipt durable");
    assert.equal(notices().length, 1);
    const notice = notices()[0];
    assert.equal(notice.action, "send_private_msg");
    assert.equal(notice.accountId, "b");
    assert.equal(String(notice.params.user_id), ADMIN);
    assert.ok(notice.text.includes(seededIds[G.notice]));
    for (const group of [G.foreign, G.live]) assert.equal(read().groups[group].memoryVerification.notifications?.length || 0, 0);
    assert.ok(!notices().some(row => String(row.params.user_id) === FOREIGN));
    assert.equal(groupSends().length, 1, "the only group send is the explicitly requested pending command");
  });
  await test("restart retains cases/receipt and next real dispatcher tick does not replay", async () => {
    const before = read();
    const retained = cases(before).map(item => item.id).sort();
    const receipt = structuredClone(before.groups[G.notice].memoryVerification.notifications);
    const count = sends.length;
    await stop(); await launch(); await connect("a", "91001"); await connect("b", "91002");
    assert.deepEqual((await view()).cases.map(item => item.id).sort(), retained);
    assert.deepEqual(read().groups[G.notice].memoryVerification.notifications, receipt);
    await pause(31500);
    assert.equal((await http("/health")).status, 200, "bridge must remain alive through its next actual timer tick");
    assert.equal((await view()).settings.shadowMode, false);
    assert.equal(sends.length, count, "no command, group send or notice may replay after restart");
    assert.equal(notices().length, 1);
    assert.equal(callRows().length, 2, "ACKed model batches must not replay");
    assert.equal(wireErrors.length, 0);
  });
  await test("changed source evidence needs explicit authorized review before a separate manual resolve", async () => {
    const cached = (await view()).cases.find(item => item.id === seededIds[G.foreign]);
    assert.equal(cached.status, "pending");
    assert.equal(cached.stale, false);
    // A test-only offline source refresh while the real repository writer is
    // stopped. Do not bypass its ownership by editing a live memory file.
    await stop();
    const sourceId = "fresh-old-evidence";
    const changed = offlineUpdate(state => {
      const result = applyMemoryExtraction(state.groups[G.foreign], G.foreign, { canonical_entries: [{
        user_id: U, kind: "preference", value: "喜欢黑咖啡", confidence: 0.95, source_message_ids: [sourceId]
      }] }, [sourceRow(G.foreign, sourceId, "我仍然喜欢黑咖啡。", { sent_at: "2022-01-03T00:00:00.000Z" })]);
      assert.equal(result.fatalErrors?.length || 0, 0);
    });
    const old = entries(changed, G.foreign).find(item => item.id === oldIds[G.foreign]);
    assert.ok(old.sourceMessageIds.includes(sourceId));
    await launch();
    const current = (await view()).cases.find(item => item.id === cached.id);
    assert.equal(current.stale, true);
    assert.notEqual(current.revision, cached.revision);
    for (const revision of [cached.revision, current.revision]) {
      const before = bytes();
      const response = await http("/api/memory/verification/resolve", { method: "POST", body: {
        conversationId: G.foreign, caseId: cached.id, expectedRevision: revision, action: "update" } });
      assert.equal(response.status, 409, "even the current GET revision cannot implicitly bless stale evidence");
      assert.equal(bytes(), before);
    }
    const reviewBody = { conversationId: G.foreign, caseId: cached.id, expectedRevision: current.revision };
    for (const options of [{ auth: false }, { headers: { origin: "http://foreign.invalid" } }]) {
      const before = bytes();
      const response = await http("/api/memory/verification/review", { method: "POST", body: reviewBody, ...options });
      assert.equal(response.status, 403);
      assert.equal(bytes(), before);
    }
    const staleBefore = bytes();
    const staleReview = await http("/api/memory/verification/review", { method: "POST", body: {
      ...reviewBody, expectedRevision: cached.revision } });
    assert.equal(staleReview.status, 409);
    assert.equal(bytes(), staleBefore);
    const factProjection = state => Object.fromEntries(Object.entries(state.groups).map(([id, group]) =>
      [id, Object.fromEntries(Object.entries(group).filter(([key]) => key !== "memoryVerification"))]));
    const factsBefore = factProjection(read());
    const reviewed = await http("/api/memory/verification/review", { method: "POST", body: {
      ...reviewBody, authorized: false, actorUserId: STRANGER } });
    assert.equal(reviewed.status, 200, `authorized review: ${reviewed.data.code || reviewed.data.error || "no error code"}`);
    assert.equal(reviewed.data.ok, true);
    const afterReview = (await view()).cases.find(item => item.id === cached.id);
    assert.equal(afterReview.stale, false);
    assert.equal(afterReview.status, "pending");
    assert.notEqual(afterReview.revision, current.revision);
    assert.deepEqual(factProjection(read()), factsBefore, "review must change no facts, sources, statuses, confidence or holds");
    const audit = read().groups[G.foreign].memoryVerification.cases.find(item => item.id === cached.id).audit.at(-1);
    assert.equal(audit.type, "human_review");
    assert.equal(audit.actorUserId, "local-admin", "review authority must come from the console, not body spoofing");
    const noResolveYet = bytes();
    assert.equal((await http("/api/memory/verification/resolve", { method: "POST", body: {
      conversationId: G.foreign, caseId: cached.id, expectedRevision: current.revision, action: "update" } })).status, 409);
    assert.equal(bytes(), noResolveYet);
    const resolved = await http("/api/memory/verification/resolve", { method: "POST", body: {
      conversationId: G.foreign, caseId: cached.id, expectedRevision: afterReview.revision, action: "update" } });
    assert.equal(resolved.status, 200, `resolve after review: ${resolved.data.code || resolved.data.error || "no error code"}`);
    assert.equal(resolved.data.ok, true);
    assert.equal((await view()).cases.find(item => item.id === cached.id).status, "resolved");
    const persistedOld = entries(read(), G.foreign).find(item => item.id === old.id);
    assert.deepEqual(persistedOld.sourceMessageIds, old.sourceMessageIds);
    assert.deepEqual(persistedOld.sourceMessageTimes, old.sourceMessageTimes);
    assert.equal(entries(read(), G.foreign).filter(item => item.source === "admin-verification").length, 1);
  });
  await test("module read failure returns HTTP 500 without rewriting corrupt fixture state", async () => {
    // Corrupt only a synthetic group while the sole writer is STOPPED. This is
    // deliberately last: honest whole-list failures must not poison other tests.
    await stop();
    offlineUpdate(state => { state.groups["810199"] = { users: {}, memoryVerification: { version: 999, cases: [] } }; });
    await launch();
    const before = bytes();
    const response = await http("/api/memory/verification?conversation_id=810199");
    assert.equal(response.status, 500);
    assert.equal(response.data.ok, false);
    assert.equal(bytes(), before);
  });
} catch (error) {
  failures.push({ name: stage, error: String(error.message).slice(0, 1600) });
} finally {
  try { await stop(); } catch { failures.push({ name: "cleanup", error: "FIXTURE_PROCESS_CLEANUP_FAILED" }); }
  modelCalls = callRows().length;
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ suite: "memory-verification-integration", ok: failures.length === 0,
  passed, failed: failures.length, failures, launches, groupSends: groupSends().length,
  privateSends: sends.length - groupSends().length, notificationSends: notices().length, modelCalls,
  externalQqSends: 0, externalModelCalls: 0, fixtureOnly: true }));
if (failures.length) process.exitCode = 1;
