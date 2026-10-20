import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { readMemorySnapshot } from "../src/memory-repository.js";

// Real bridge + repository + reverse OneBot; only synthetic identities, a
// whitelist environment and temp-home model/docker fixtures. No production
// config, credentials, external endpoint, rebuild, or real QQ send is used.
// The fake model matches known IDs against the prompt, then reads a preplanned
// patch. It does not parse prose or depend on old/new tagged-JSON prompt layout.
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-extraction-integration-"));
const memoryFile = path.join(home, "data", "memory.json");
const callsFile = path.join(home, "model-calls.jsonl");
const quietUntil = Date.parse("9999-12-31T00:00:00Z");
const groups = { a: "810001", b: "810002", invalid: "810003", crash: "810004" };
const users = ["10001", "10002"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, closed, socket, config, env, base, wireSends = 0, socketError = false;
let failedStage = "setup";
const exited = () => child && (child.exitCode !== null || child.signalCode !== null);
const check = (condition, code) => { if (!condition) throw new Error(code); };
const snapshot = () => readMemorySnapshot(memoryFile);
const jobs = (id, state = snapshot()) => state.groups?.[id]?.memoryExtractionJobs;
const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const starts = plan => calls().filter(row => row.type === "start" && (!plan || row.plan === plan));
const pendingIds = state => state.messages.map(row => row.input.message_id);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function message(group, id, userIndex, iso, value) {
  return { group, id, user: users[userIndex], time: Date.parse(iso) / 1000, value };
}
const inputs = {
  a1: message(groups.a, "fixture-a1", 0, "2020-01-01T00:00:00Z", "偏好合成蓝纸"),
  a2: message(groups.a, "fixture-a2", 1, "2021-01-01T00:00:00Z", "偏好合成绿纸"),
  a3: message(groups.a, "fixture-a3", 0, "2018-01-01T00:00:00Z", "偏好合成铅笔"),
  a4: message(groups.a, "fixture-a4", 1, "2019-01-01T00:00:00Z", "偏好合成钢笔"),
  b1: message(groups.b, "fixture-b1", 0, "2022-01-01T00:00:00Z", "偏好合成红茶"),
  b2: message(groups.b, "fixture-b2", 1, "2023-01-01T00:00:00Z", "偏好合成白茶"),
  b3: message(groups.b, "fixture-b3", 0, "2024-01-01T00:00:00Z", "偏好合成灰纸"),
  c1: message(groups.invalid, "fixture-c1", 0, "2020-02-01T00:00:00Z", "偏好合成方格"),
  c2: message(groups.invalid, "fixture-c2", 1, "2021-02-01T00:00:00Z", "偏好合成圆格"),
  c3: message(groups.invalid, "fixture-c3", 0, "2022-02-01T00:00:00Z", "偏好合成三角"),
  c4: message(groups.invalid, "fixture-c4", 1, "2023-02-01T00:00:00Z", "偏好合成横格"),
  d1: message(groups.crash, "fixture-d1", 0, "2017-01-01T00:00:00Z", "偏好合成木盒"),
  d2: message(groups.crash, "fixture-d2", 1, "2016-01-01T00:00:00Z", "偏好合成铁盒"),
  d3: message(groups.crash, "fixture-d3", 0, "2015-01-01T00:00:00Z", "偏好合成纸盒")
};
const plans = [
  ["a-first", [inputs.a1, inputs.a2]], ["a-late", [inputs.a3, inputs.a4]],
  ["b-first", [inputs.b1, inputs.b2]], ["invalid", [inputs.c1, inputs.c2]],
  ["crash", [inputs.d1, inputs.d2]]
].map(([id, messages]) => ({ id, group: messages[0].group, messages,
  patch: { canonical_entries: messages.map(item => ({ user_id: item.user,
    kind: "preference", value: item.value, confidence: 0.95, source_message_ids: [item.id] })) } }));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function until(predicate, label, ms = 10000) {
  failedStage = label;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    check(!exited(), `${label}: BRIDGE_EXITED`);
    check(!socketError, `${label}: FIXTURE_SOCKET_ERROR`);
    check(wireSends === 0, `${label}: UNEXPECTED_SEND_OR_UPLOAD`);
    const violation = calls().find(row => row.type === "violation");
    check(!violation, `${label}: ${violation?.code || "MODEL_VIOLATION"}`);
    try { if (await predicate()) return; }
    catch (error) { if (error.code !== "MEMORY_READ_BUSY") throw error; }
    await pause(25);
  }
  throw new Error(`${label}: TIMEOUT`);
}
async function request(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(3000) });
  check(response.ok, "FIXTURE_HTTP_STATUS");
  return response.json();
}
async function idle() {
  await until(async () => !(await request("/health")).memoryExtraction.active, "sweep idle");
}
async function launch() {
  socketError = false;
  child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], {
    cwd: home, env, detached: true, stdio: "ignore"
  });
  closed = new Promise((resolve, reject) => { child.once("error", () => reject(new Error("FIXTURE_SPAWN_FAILED"))); child.once("close", resolve); });
  await until(async () => {
    // QQ is intentionally disconnected until connect(); HTTP readiness is
    // sufficient here, not the aggregate QQ-online health flag.
    try { await request("/health"); return true; } catch { return false; }
  }, "isolated bridge startup");
}
async function stop() {
  socket?.terminate(); socket = null;
  if (!child) return;
  // The bridge and its fake model children own a dedicated process group.
  // SIGKILL simulates a real crash without leaving a held model behind.
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await closed;
  child = null;
  // These are fixture mutexes, NOT memory/repository state or writer tickets.
  fs.rmSync(path.join(home, "model-locks"), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "model-locks"));
}
async function connect() {
  socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  socket.on("error", () => { socketError = true; });
  socket.on("message", raw => {
    try {
      const action = JSON.parse(String(raw));
      if (/^(send_|upload_)/.test(action.action)) wireSends++;
      if (action.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo,
        data: action.action === "get_login_info" ? { user_id: "91001", nickname: "fixture bot" }
          : action.action === "get_status" ? { online: true, good: true }
            : action.action === "get_group_member_list" ? [...users, "91001"].map(user_id => ({ user_id })) : {} }));
    } catch { socketError = true; }
  });
  await until(() => socket.readyState === WebSocket.OPEN, "fixture reverse WebSocket");
  socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: "91001", status: { online: true, good: true } }));
}
function send(item) {
  socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: "91001",
    group_id: item.group, user_id: item.user, message_id: item.id, time: item.time,
    sender: { user_id: item.user, nickname: "fixture same name", card: "fixture same name", role: "member" },
    message: [{ type: "text", data: { text: `我长期${item.value}。` } }] }));
}
const release = id => fs.writeFileSync(path.join(home, `release-${id}`), "yes", { mode: 0o600 });
async function collected(id, expected) {
  await until(() => {
    const state = jobs(id);
    return state && expected.every(item => pendingIds(state).includes(item.id));
  }, "durable incoming collection");
}
async function committed(planId) {
  const plan = plans.find(item => item.id === planId);
  await until(() => {
    const state = snapshot();
    const group = state.groups?.[plan.group];
    return plan.messages.every(item => {
      const entry = group?.users?.[item.user]?.canonicalMemory?.entries?.find(row => row.value === item.value);
      return entry && jobs(plan.group, state).acknowledged.includes(JSON.stringify([plan.group, "id", item.id]));
    });
  }, "atomic patch and ACK");
  const group = snapshot().groups[plan.group];
  for (const item of plan.messages) {
    const user = group.users[item.user];
    const entries = user.canonicalMemory.entries.filter(row => row.value === item.value);
    check(entries.length === 1, "CANONICAL_ENTRY_MISSING_OR_DUPLICATE");
    const entry = entries[0];
    check(entry.subjectUserId === item.user, "SAME_NAME_QQ_ATTRIBUTION_FAILED");
    check(same(entry.sourceMessageIds, [item.id]), "PER_ASSERTION_SOURCE_IDS_CHANGED");
    check(entry.firstSeenAt === new Date(item.time * 1000).toISOString(), "OLD_EVENT_FIRST_SEEN_BECAME_NEW");
    check(entry.lastConfirmedAt === new Date(item.time * 1000).toISOString(), "OLD_EVENT_CONFIRMATION_BECAME_NEW");
    check(entry.sourceConversationId === plan.group, "SOURCE_CONVERSATION_CHANGED");
    check(!group.users[users.find(id => id !== item.user)]?.canonicalMemory?.entries?.some(row => row.value === item.value), "SAME_NAME_CROSS_USER_LEAK");
    check(user.names.includes("fixture same name"), "ORIGINAL_DISPLAY_NAME_MISSING");
  }
}

try {
  for (const name of ["data", "tmp", "bin", "hermes", "model-locks"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home, "plans.json"), JSON.stringify(plans), { mode: 0o600 });
  const model = path.join(home, "fake-model.mjs");
  fs.writeFileSync(model, String.raw`import fs from "node:fs";
import path from "node:path";
import { readMemorySnapshot } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "memory-repository.js")).href)};
const home = process.env.HERMES_QQ_HOME;
const log = row => fs.appendFileSync(path.join(home,"model-calls.jsonl"),JSON.stringify({...row,pid:process.pid})+"\n");
function fail(code) { log({type:"violation",code}); process.exit(4); }
const prompt = process.argv.at(-1);
const plans = JSON.parse(fs.readFileSync(path.join(home,"plans.json"),"utf8"));
let memory;
for(let i=0;i<40;i++) {
  try { memory=readMemorySnapshot(path.join(home,"data","memory.json")); break; }
  catch(error) { if(error.code!=="MEMORY_READ_BUSY") fail("MODEL_SNAPSHOT_FAILED"); await new Promise(r=>setTimeout(r,25)); }
}
if(!memory) fail("MODEL_SNAPSHOT_TIMEOUT");
const matching=[];
for(const [group,gm] of Object.entries(memory.groups||{})) {
  const state=gm.memoryExtractionJobs,batch=state?.batch;
  if(batch?.status!=="running") continue;
  const messages=batch.keys.map(key=>state.messages.find(row=>row.key===key)?.input);
  if(messages.every(row=>row && typeof row.message_id==="string" && prompt.includes(row.message_id))) matching.push({group,state,batch,messages});
}
if(matching.length!==1) fail("NO_UNIQUE_DURABLE_PROMPT_CLAIM");
const {group,batch,messages}=matching[0];
const ids=messages.map(row=>row.message_id).sort();
const plan=plans.find(row=>row.group===group && JSON.stringify(row.messages.map(m=>m.id).sort())===JSON.stringify(ids));
if(!plan) fail("UNPLANNED_MODEL_BATCH");
if(!messages.every(row=>Date.parse(row.sentAt)===plan.messages.find(m=>m.id===row.message_id).time*1000)) fail("MODEL_ORIGINAL_TIME_CHANGED");
if(Object.keys(process.env).some(key=>/(?:API_KEY|ACCESS_TOKEN|PASSWORD|COOKIE|SECRET)$/i.test(key) && process.env[key])) fail("MODEL_INHERITED_CREDENTIAL");
const lock=path.join(home,"model-locks",group);
try { fs.mkdirSync(lock); } catch { fail("CONCURRENT_MODEL_SAME_CONVERSATION"); }
process.on("exit",()=>fs.rmSync(lock,{recursive:true,force:true}));
if(fs.readdirSync(path.join(home,"model-locks")).length>2) fail("GLOBAL_MODEL_CONCURRENCY_EXCEEDED");
log({type:"start",plan:plan.id,group,batchId:batch.id,attempts:batch.attempts,ids,durableRunning:true});
const timer=setInterval(()=>{
  if(fs.existsSync(path.join(home,"release-"+plan.id))) {
    clearInterval(timer);
    log({type:"finish",plan:plan.id,batchId:batch.id});
    process.stdout.write(plan.id==="invalid" ? "fixture deliberately invalid JSON" : JSON.stringify(plan.patch));
  }
},15);
setTimeout(()=>{clearInterval(timer);fail("HELD_MODEL_TIMEOUT");},25000).unref();
`, { mode: 0o600 });
  config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.listen = { host: "127.0.0.1", port: await freePort(), path: "/extraction-fixture" };
  config.control = { enabled: true, host: "127.0.0.1", port: await freePort() };
  config.ai = { command: process.execPath, args: [model], provider: "custom", model: "fixture-extraction",
    credentialSource: "existing", apiKeyEnv: "FIXTURE_UNUSED_API_KEY", baseUrl: "http://127.0.0.1:9", timeoutMs: 28000 };
  delete config.apiCenter;
  config.aiProfiles = { activeId: "fixture", profiles: [] };
  for (const key of ["webSearch", "vision", "taskMode", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "messageDebounce", "loginRecovery", "adminNotifications", "dailyMessages", "automation", "voice"])
    config[key] = { ...config[key], enabled: false };
  config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.observability = { ...config.observability, logIncomingMessages: false, logSkippedMessages: false };
  config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
  config.memory = { ...config.memory, enabled: true,
    aiExtraction: { ...config.memory.aiExtraction, enabled: true, everyMessages: 2 } };
  config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
    diagnostics: { peerPingEnabled: false, probeIntervalMs: 600000 }, items: [{ id: "fixture", qq: "91001",
      displayName: "fixture bot", protocol: "napcat", enabled: true, managed: true,
      webuiPort: await freePort(),
      protocolEnabled: true, protocolContainer: "fixture-extraction", onebotWsUrl: "", onebotPath: config.listen.path,
      features: { chat: false, task: false, proactive: false, automation: false, webSearch: false, vision: false, asr: false, learning: false },
      sendTypes: { text: true, image: false, record: false, video: false, file: false }, scope: { groups: true, private: true } }] };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })), { mode: 0o600 });
  fs.writeFileSync(memoryFile, JSON.stringify({ groups: Object.fromEntries(Object.values(groups).map(id => [id, {
    settings: { quietUntil, botSettings: { "account:fixture": { quietUntil } } }, users: {}
  }])) }), { mode: 0o600 });
  env = { HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8",
    PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home,
    HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs") };
  base = `http://127.0.0.1:${config.control.port}`;
  await launch(); await connect();

  send(inputs.a1); send(inputs.a2);
  await until(() => starts("a-first").length === 1, "durable claim precedes first model");
  const first = jobs(groups.a).batch;
  check(first.status === "running" && first.attempts === 1, "FIRST_CLAIM_NOT_DURABLE_RUNNING");
  send(inputs.a3); send(inputs.a4);
  send(inputs.b1); send(inputs.b2);
  send(inputs.c1); send(inputs.c2);
  await collected(groups.a, [inputs.a1, inputs.a2, inputs.a3, inputs.a4]);
  await collected(groups.b, [inputs.b1, inputs.b2]);
  await collected(groups.invalid, [inputs.c1, inputs.c2]);
  check(starts("a-first").length === 1 && starts().length === 1, "HELD_MODEL_REENTERED");
  check(jobs(groups.a).batch.id === first.id, "CONCURRENT_INPUT_REPLACED_PINNED_BATCH");
  release("a-first"); await committed("a-first"); await idle();
  check(same(pendingIds(jobs(groups.a)), [inputs.a3.id, inputs.a4.id]), "OLD_ACK_DELETED_NEW_INPUT");

  // New input explicitly starts a fresh sweep; no minute-long timer dependency.
  send(inputs.b3);
  await until(() => starts("a-late").length === 1 && starts("b-first").length === 1, "two independent model lanes");
  check(starts("invalid").length === 0, "THIRD_MODEL_STARTED_WHILE_TWO_HELD");
  release("a-late"); await committed("a-late");
  await until(() => starts("invalid").length === 1, "third conversation admitted after lane released");
  release("b-first"); await committed("b-first");
  check(same(pendingIds(jobs(groups.b)), [inputs.b3.id]), "OTHER_CONVERSATION_NEW_INPUT_LOST");
  release("invalid");
  await until(() => jobs(groups.invalid)?.batch?.retryRequired === true, "invalid JSON retains failed batch");
  await idle();
  const failed = structuredClone(jobs(groups.invalid).batch);
  check(failed.status === "pending" && failed.attempts === 1 && failed.lastFailure.stage === "process", "INVALID_JSON_FAILURE_METADATA");
  check(failed.id === starts("invalid")[0].batchId && same(failed.keys,
    [inputs.c1, inputs.c2].map(item => JSON.stringify([groups.invalid, "id", item.id]))), "INVALID_JSON_CHANGED_BATCH_MEMBERSHIP");
  check(jobs(groups.invalid).acknowledged.length === 0, "INVALID_JSON_ACKED_INPUT");
  check(same(pendingIds(jobs(groups.invalid)), [inputs.c1.id, inputs.c2.id]), "INVALID_JSON_DROPPED_INPUT");
  send(inputs.c3); send(inputs.c4);
  await collected(groups.invalid, [inputs.c1, inputs.c2, inputs.c3, inputs.c4]);
  await idle(); await pause(150);
  check(starts("invalid").length === 1, "NEW_INPUT_BUSY_RETRIED_FAILED_BATCH");
  check(jobs(groups.invalid).batch.id === failed.id, "FAILED_BATCH_ID_CHANGED");

  send(inputs.d1); send(inputs.d2);
  await until(() => starts("crash").length === 1, "crash fixture durable running claim");
  const running = structuredClone(jobs(groups.crash).batch);
  check(running.status === "running", "CRASH_FIXTURE_NOT_RUNNING");
  await stop();
  check(jobs(groups.crash).batch.status === "running" && jobs(groups.crash).batch.id === running.id, "CRASH_MUTATED_DURABLE_CLAIM");
  await launch();
  const recovered = jobs(groups.crash).batch;
  check(recovered.status === "pending" && recovered.id === running.id && recovered.attempts === running.attempts, "RESTART_DID_NOT_PRESERVE_BATCH");
  check(same(recovered.keys, running.keys), "RESTART_CHANGED_BATCH_MEMBERSHIP");
  check(jobs(groups.invalid).batch.retryRequired && jobs(groups.invalid).batch.id === failed.id, "RESTART_UNLOCKED_FAILED_BATCH");
  await connect(); send(inputs.d3);
  await until(() => starts("crash").length === 2, "new arrival wakes recovered batch");
  const resumed = starts("crash")[1];
  check(resumed.batchId === running.id && resumed.attempts === running.attempts + 1, "RESTART_CREATED_DIFFERENT_CLAIM");
  await collected(groups.crash, [inputs.d1, inputs.d2, inputs.d3]);
  release("crash"); await committed("crash"); await idle();
  check(same(pendingIds(jobs(groups.crash)), [inputs.d3.id]), "RESTART_ACK_DELETED_FRESH_INPUT");
  check(starts("invalid").length === 1, "RESTART_BUSY_RETRIED_INVALID_BATCH");
  check(starts().length === 6 && starts().every(row => row.durableRunning), "UNEXPECTED_OR_UNPERSISTED_MODEL_CLAIM");
  check(Object.values(snapshot().groups).every(group => group.settings.quietUntil === quietUntil), "QUIET_SETTING_CHANGED");
  assert.equal(wireSends, 0, "quiet + chat-disabled fixture must never send or upload");
  console.log("memory extraction integration: PASS durable-before-model, two-lane/per-conversation exclusion, same-name QQ attribution, original/late event times, patch+ACK/new input survival, invalid JSON retry gate, SIGKILL/restart same batch, quiet/chat-disabled collection; sends=0");
} catch (error) {
  // Fixed codes/counts only: never print a bridge prompt, response, config, or
  // memory dump. Temporary test artifacts are cleaned even when integration fails.
  let counts = {};
  try {
    const state = snapshot();
    counts = Object.fromEntries(Object.entries(groups).map(([label, id]) => {
      const job = jobs(id, state);
      return [label, { pending: job?.messages.length || 0, acknowledged: job?.acknowledged.length || 0,
        batchStatus: job?.batch?.status || "none", attempts: job?.batch?.attempts || 0,
        retryRequired: job?.batch?.retryRequired === true }];
    }));
  } catch { /* Repository failure is already represented by stage/code. */ }
  console.error(JSON.stringify({ test: "memory-extraction-integration", status: "FAIL", stage: failedStage,
    code: /^[A-Za-z0-9 :+/_-]{1,180}$/.test(error.message) ? error.message : "ASSERTION_OR_FIXTURE_FAILURE",
    modelStarts: starts().length, sends: wireSends, jobs: counts }));
  process.exitCode = 1;
} finally {
  await stop();
  fs.rmSync(home, { recursive: true, force: true });
}
