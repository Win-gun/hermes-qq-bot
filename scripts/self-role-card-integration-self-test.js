// Real bridge, two fake OneBots, loopback text model and fake TTS; no real QQ/API.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";
import { ingestSocialMessage } from "../src/social-agent-state.js";
const root = path.resolve(import.meta.dirname, ".."), home = fs.mkdtempSync(path.join(os.tmpdir(), "self-role-card-bridge-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
let checks = 0, child, base, token, log = "", slowResolve, slowStarted = false, textCalls = 0;
const sockets = [], wire = [], prompts = [];
const check = (x, note) => { assert(x, note); checks++; };
async function until(fn, note) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; if (child?.exitCode != null) throw Error(`bridge exit: ${log.slice(-500)}`); await pause(40); } throw Error(`timeout ${note}: ${log.slice(-500)}`); }
async function api(route, method = "GET", body, auth = true) {
  const r = await fetch(base + route, { method, signal: AbortSignal.timeout(20000), headers: { origin: base, "content-type": "application/json", ...(auth ? { "x-hermes-qq-admin": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
}
const model = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body), prompt = payload.messages.at(-1).content;
  check(!payload.tools && !payload.tool_choice, "text-only model has no native tools"); textCalls++; prompts.push(prompt);
  let decision = "synthetic direct reply";
  if (prompt.includes("为当前账号生成从属于稳定核心")) {
    const data = JSON.parse(prompt.split("\n").at(-1));
    if (data.topic === "slow") { slowStarted = true; await new Promise(resolve => { slowResolve = resolve; }); }
    decision = JSON.stringify({ expression: data.persona.includes("alpha-original") ? "喜欢直接回应，再自然接梗" : "喜欢先观察，再给出观点",
      interests: `科技工具与生活趣闻${data.topic && data.topic !== "slow" ? `；${data.topic}` : ""}`, examples: "假设朋友分享好消息，可以先祝贺再自然接话。", reason: "保留原有人设，逐步完善表达" });
  } else if (prompt.includes("你是受限社交规划器")) {
    const { snapshot } = JSON.parse(prompt.split("\n").at(-1));
    const source = snapshot.messages.filter(item => !item.isBot).at(-1);
    decision = JSON.stringify({ action: "reply", messages: ["语音测试"], expressionPlan: { version: 1, action: "reply", replyToMessageId: null,
      messages: [{ type: "voice", content: "你好，这是自主语音测试。" }] },
      continuity: { personaChanges: [{ field: "expression", value: "喜欢简洁但有观点的表达", evidenceMessageIds: [source.messageId] }] } });
  }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: decision } }] }));
});
try {
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json")));
  config.listen = { host: "127.0.0.1", port: await port(), path: "/role-fixture" };
  config.control = { ...config.control, host: "127.0.0.1", port: await port() }; base = `http://127.0.0.1:${config.control.port}`;
  for (const key of ["vision", "webSearch", "proactive", "socialPlanner", "implicitReply", "discussionParticipation", "automation", "dailyMessages", "hourlyChat", "adminNotifications", "loginRecovery", "taskMode", "learningMode"]) config[key] = { enabled: false };
  config.memory = { ...config.memory, aiExtraction: { enabled: false }, learning: { enabled: false }, verification: { enabled: false } };
  config.messageDebounce = { enabled: false }; config.targetGroups = ["31001"];
  config.privateChats = { enabled: false }; config.apiCenter = undefined; config.aiProfiles = [];
  config.ai = { ...config.ai, textTransport: "direct", provider: "custom", model: "synthetic", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: "ROLE_FIXTURE_KEY", credentialSource: "existing", timeoutMs: 5000 };
  config.voice = { enabled: true, replyMode: "mixed", apiKeyEnv: "ROLE_FIXTURE_KEY", credentialSource: "existing", tts: { enabled: true, model: "mimo-v2.5-tts", voice: "mimo_default" } };
  config.accounts = { version: 2, items: ["alpha", "beta"].map((id, i) => ({ id, qq: String(11001 + i), displayName: id, selfName: id, style: { systemPrompt: `${id}-original` },
    enabled: true, protocolEnabled: true, managed: true, protocolContainer: `synthetic-role-${id}`, protocol: "napcat", onebotPath: "/role-fixture", features: { chat: true, proactive: true }, sendTypes: { text: true, record: true },
    socialAgent: { enabled: true, shadowMode: false, conversationIds: ["group:31001"], maxDailyCalls: 10, turnTimeoutMs: 5000,
      roleCard: { enabled: true, autoGrow: true, minUpdateIntervalMs: 60000, maxVersions: 32 } },
    socialExperience: { enabled: true, shadowMode: false, conversationIds: ["group:31001"], expression: { enabled: true, minIntervalMs: 0, maxIntervalMs: 0 } } })), failoverGroups: [] };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })));
  const seed = { groups: {} }, seededAt = Date.now();
  check(ingestSocialMessage(seed, { logicalId: "account:alpha", conversationId: "private:21001", now: seededAt,
    message: { messageId: "private-seed", userId: "21001", text: "PRIVATE_SOURCE_MARKER", sentAt: seededAt, receivedAt: seededAt } }).ok,
    "private fixture evidence actually exists before generation");
  fs.mkdirSync(path.join(home, "data")); fs.writeFileSync(path.join(home, "data/memory.json"), JSON.stringify(seed));
  const preload = path.join(home, "preload.cjs"), ttsLog = path.join(home, "tts-calls");
  fs.writeFileSync(preload, `const fs=require('fs'),cp=require('child_process');cp.spawnSync=()=>({status:1,stdout:'',stderr:''});require('module').syncBuiltinESMExports();const original=fetch;global.fetch=async(input,options)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.hostname==='api.xiaomimimo.com'){fs.appendFileSync(${JSON.stringify(ttsLog)},'1');const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return new Response(JSON.stringify({choices:[{message:{audio:{data:b.toString('base64')}}}]}),{headers:{'content-type':'application/json'}});}if(u.hostname!=='127.0.0.1')throw Error('fixture denies external network');return original(input,options);};`);
  child = spawn(process.execPath, [path.join(root, "src/bridge.js")], { cwd: root, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, HERMES_HOME: path.join(home, "hermes"), HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs"), ROLE_FIXTURE_KEY: "synthetic-role-fixture-not-secret", NODE_OPTIONS: `--require=${preload}` }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", d => { log = (log + d).slice(-4000); });
  await until(async () => { try { return (await api("/health", "GET", undefined, false)).status === 200; } catch { return false; } }, "start");
  token = (await api("/api/admin/session", "GET", undefined, false)).body.token;
  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.listen.port}/role-fixture`); sockets.push(ws);
    ws.on("message", raw => { const request = JSON.parse(raw); if (!request.action) return; wire.push({ i, ...request });
      const data = request.action === "get_login_info" ? { user_id: 11001 + i }
        : request.action === "get_group_member_list" ? [{ user_id: 11001 }, { user_id: 11002 }, { user_id: 21001 }]
          : request.action.startsWith("send_") ? { message_id: 50000 + wire.length } : { online: true, good: true };
      ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data })); });
    await until(() => ws.readyState === 1, "socket"); ws.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 11001 + i, status: { online: true, good: true } }));
  }
  await until(async () => (await api("/api/accounts")).body.statuses.filter(a => a.connected).length === 2, "identities");
  const route = id => `/api/social-agent/accounts/${id}/role-card`;
  check((await api(route("alpha"), "GET", undefined, false)).status === 403, "role card GET authenticated");
  const initial = (await api(route("alpha"))).body;
  check(initial.card.revision === 0 && initial.policy.enabled && textCalls === 0, "view is inert and absent store defaults read-only");
  const state = (await api("/api/social-agent/accounts/alpha")).body;
  check(initial.revision !== state.revision, "config revision and social state revision are distinct");
  check((await api(route("alpha") + "/generate", "POST", { expectedRevision: state.revision, cardRevision: 0, topic: "" })).status === 409 && textCalls === 0, "wrong revision does not call model");
  sockets[0].send(JSON.stringify({ post_type: "message", message_type: "group", self_id: 11001, group_id: 31001, user_id: 21001, message_id: 41001,
    time: Math.floor(Date.now() / 1000), message: [{ type: "text", data: { text: "分享一个有趣的科技话题" } }], raw_message: "分享一个有趣的科技话题", sender: { nickname: "Human" } }));
  await until(async () => (await api(route("alpha"))).body.card.revision === 1, "provenance-bound autonomous growth");
  await until(() => wire.some(x => x.i === 0 && x.action === "send_group_msg" && x.params.message.some?.(s => s.type === "record")), "AI-selected voice");
  check(fs.readFileSync(ttsLog, "utf8") === "1", "one fake TTS call, no duplicated voice");
  check((await api(route("beta"))).body.card.revision === 0, "peer does not acquire another role card");
  const grown = (await api(route("alpha"))).body;
  check(grown.card.versions[0].evidenceMessageIds.includes("41001"), "growth pins actual sender evidence");
  const generated = await api(route("alpha") + "/generate", "POST", { expectedRevision: grown.revision, cardRevision: 1, topic: "科技兴趣" });
  check(generated.status === 200 && generated.body.card.revision === 2, `explicit generation accepted: ${JSON.stringify(generated.body)}`);
  check(generated.body.revision === grown.revision, "card write does not change configuration revision");
  const beforeStale = textCalls;
  check((await api(route("alpha") + "/generate", "POST", { expectedRevision: grown.revision, cardRevision: 1, topic: "" })).status === 409 && textCalls === beforeStale, "stale card cannot spend or replay");
  const beta = (await api(route("beta"))).body;
  check((await api(route("beta") + "/generate", "POST", { expectedRevision: beta.revision, cardRevision: 0, topic: "" })).body.card.revision === 1, "peer authors its own card");
  const unchanged = await api(route("beta") + "/generate", "POST", { expectedRevision: beta.revision, cardRevision: 1, topic: "" });
  check(unchanged.status === 200 && unchanged.body.card.revision === 1 && unchanged.body.card.versions.length === 1,
    "identical generated preferences succeed without a duplicate version or conflict error");
  const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
  check(saved.accounts.items.every(a => a.style.systemPrompt === `${a.id}-original`), "original persona snapshots unchanged");
  const beforeSlow = (await api(route("alpha"))).body;
  const inFlight = api(route("alpha") + "/generate", "POST", { expectedRevision: beforeSlow.revision, cardRevision: 2, topic: "slow" });
  await until(() => slowStarted, "generation starts");
  const registry = (await api("/api/accounts")).body;
  check((await api("/api/accounts/alpha", "PATCH", { expectedRevision: registry.revision, patch: { socialAgent: { ...saved.accounts.items[0].socialAgent, roleCard: { ...saved.accounts.items[0].socialAgent.roleCard, enabled: false } } } })).status === 200, "policy revoked mid-generation");
  slowResolve(); check((await inFlight).status === 409, "revoked generation does not write");
  const final = (await api(route("alpha"))).body;
  check(final.card.revision === 2 && final.policy.enabled === false, "disabled card history preserved and readable");
  const memory = JSON.parse(fs.readFileSync(path.join(home, "data/memory.json")));
  const usage = Object.values(memory.socialAgents.bots["account:alpha"].runtimeUsage.days)[0];
  check(usage.reservedCalls >= 4 && usage.actualCalls >= 4 && usage.unknownUsageCalls >= 4, "social text, TTS and explicit generation share usage ledger");
  check(prompts.every(p => !p.includes("PRIVATE_SOURCE_MARKER")), "no private context in explicit generator");
  const beforeCommand = wire.length;
  for (let i = 0; i < 2; i++) sockets[i].send(JSON.stringify({ post_type: "message", message_type: "group", self_id: 11001 + i,
    group_id: 31001, user_id: 21001, message_id: 41002, time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "/bot a rolecard status" } }], raw_message: "/bot a rolecard status", sender: { nickname: "Admin", role: "admin" } }));
  await until(() => wire.slice(beforeCommand).some(x => x.action === "send_group_msg"
    && JSON.stringify(x.params.message).includes("自写角色卡 v2")), "account-addressed rolecard command");
  check(wire.slice(beforeCommand).filter(x => x.action === "send_group_msg" && JSON.stringify(x.params.message).includes("自写角色卡 v2")).every(x => x.i === 0),
    "group rolecard command routes only to the selected logical bot");
  console.log(JSON.stringify({ ok: true, checks, fakeTextCalls: textCalls, fakeTtsCalls: 1, realQqWrites: 0, realModelCalls: 0, productionTouched: false }));
  if (process.env.HERMES_QQ_ROLECARD_UI === "1") {
    console.log(JSON.stringify({ fixtureUi: `${base}/admin`, fixturePid: process.pid, stateIsolated: true }));
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); process.removeListener("SIGTERM", done); resolve(); };
      const timer = setTimeout(done, 3600000); process.once("SIGTERM", done);
    });
  }
} finally {
  slowResolve?.(); for (const socket of sockets) socket.close(); child?.kill("SIGTERM");
  if (child && child.exitCode === null) await Promise.race([new Promise(r => child.once("exit", r)), pause(3000)]);
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); fs.rmSync(home, { recursive: true, force: true });
}
