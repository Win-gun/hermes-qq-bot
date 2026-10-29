import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { registryConfig } from "../src/account-registry.js";

// Disposable HOME, two fake OneBots, no model endpoint and no real QQ calls.
const root = path.resolve(import.meta.dirname, ".."), home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-sl31-")));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, closed, base, token, checks = 0, log = "";
const sockets = [], wire = [], own = [], modelPrompts = [];
let model;
const check = (value, label) => { assert.ok(value, label); checks++; };
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; if (child?.exitCode != null) throw Error(`fixture stopped: ${log.slice(-400)}`); await pause(30); } throw Error(`fixture timeout: ${log.slice(-400)}`); }
async function api(route, method = "GET", body, { auth = true, origin = base } = {}) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20000),
    headers: { origin, "content-type": "application/json", ...(auth ? { "x-hermes-qq-admin": token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  fs.mkdirSync(path.join(home, "bin")); fs.mkdirSync(path.join(home, "tmp"));
  fs.writeFileSync(path.join(home, "bin", "docker"), `#!${process.execPath}\nprocess.exit(1)`, { mode: 0o700 });
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json")));
  model = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw), prompt = payload.messages.at(-1).content;
    if (Array.isArray(prompt)) {
      check(prompt.some(part => part.type === "image_url" && /^data:image\/png;base64,/.test(part.image_url?.url || "")), "actual image bytes reach bound chat model without CLI");
      modelPrompts.push("synthetic-multimodal");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "合成识图成功" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })); return;
    }
    modelPrompts.push(prompt);
    check(!payload.tools && !prompt.includes("PRIVATE_FEED_SENTINEL"), "model has no native tools or private feed contents");
    const decision = prompt.includes("你为当前账号起草") ? { content: "合成秋日随笔", reason: "管理员秋日主题" }
      : { action: "reply", messages: ["合成拍一拍回应"] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  config.apiCenter = undefined; config.aiProfiles = [];
  config.ai = { ...config.ai, provider: "custom", model: "synthetic-only", baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    apiKeyEnv: "SOCIAL_LIFE_FIXTURE_KEY", credentialSource: "existing", reasoningEffort: "none", timeoutMs: 5000 };
  config.listen = { host: "127.0.0.1", port: await freePort(), path: "/social-life-fixture" };
  config.control = { ...config.control, host: "127.0.0.1", port: await freePort() };
  for (const key of ["webSearch", "vision", "proactive", "socialPlanner", "discussionParticipation", "implicitReply", "learningMode", "loginRecovery", "adminNotifications", "automation", "voice", "taskMode"])
    config[key] = { ...config[key], enabled: false };
  config.memory.aiExtraction.enabled = false; config.memory.learning = { enabled: false };
  config.socialAgent = { enabled: false }; config.dailyMessages = { enabled: false, schedules: [] }; delete config.hourlyChat;
  config.privateChats = { ...config.privateChats, enabled: true, ownerUserIds: ["93001"], targetUserIds: ["93001"] };
  config.responseQueue = { ...config.responseQueue, minDelayMs: 0 };
  config.accounts = { version: 2, failoverGroups: [], topology: "function_split", diagnostics: { enabled: false, peerPingEnabled: false },
    items: ["alpha", "beta"].map((id, index) => ({ id, qq: String(91001 + index), displayName: `Fixture ${id}`, enabled: true,
      protocolEnabled: true, protocol: "napcat", managed: true, onebotPath: config.listen.path, onebotWsUrl: "",
      features: { chat: true, task: false, proactive: false, automation: false }, style: { systemPrompt: `独立风格 ${id}` },
      sendTypes: { text: true, image: true }, scope: { groups: true, private: true },
      socialAgent: { enabled: id === "alpha", shadowMode: false, conversationIds: ["group:810001"] },
      socialExperience: { enabled: id === "alpha", shadowMode: false, conversationIds: ["group:810001"],
        expression: { enabled: true }, pokes: { enabled: true } },
      ...(id === "alpha" ? { qzone: { enabled: true, mode: "reviewed", reads: { feeds: true, own: true, cooldownMs: 0 },
        publish: { enabled: true, cooldownMs: 0 }, likes: { enabled: true, cooldownMs: 0 }, comments: { enabled: true, cooldownMs: 0 } } } : {}) })) };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(registryConfig(config, { strict: true })));
  child = spawn(process.execPath, [path.join(root, "src/bridge.js")], { cwd: root, env: {
    HOME: home, TMPDIR: path.join(home, "tmp"), PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, "logs"), HERMES_HOME: path.join(home, "hermes"),
    SOCIAL_LIFE_FIXTURE_KEY: "synthetic-not-a-real-provider-credential"
  }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", data => { log = (log + data).slice(-4000); }); closed = new Promise(r => child.once("close", r));
  base = `http://127.0.0.1:${config.control.port}`;
  await until(async () => { try { return (await api("/health", "GET", undefined, { auth: false })).status === 200; } catch { return false; } });
  token = (await api("/api/admin/session", "GET", undefined, { auth: false })).data.token;
  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`); sockets.push(ws);
    ws.on("message", raw => {
      const request = JSON.parse(raw); if (!request.action) return; wire.push({ account: i, ...request });
      let data = request.action === "get_login_info" ? { user_id: String(91001 + i) }
        : request.action === "get_status" ? { online: true, good: true }
          : request.action === "get_version_info" ? { app_version: "fixture-only" } : {};
      if (request.action === "get_qzone_feeds") data = { feeds: [{ uin: 92001, tid: "fixture-feed", time: Math.floor(Date.now() / 1000),
        content: "<b>PRIVATE_FEED_SENTINEL</b> https://example.test/?token=hidden", content_complete: true }], has_more: false };
      if (request.action === "send_qzone_msg") {
        check(request.params.ugc_right === 64, "wire always has explicit self-only audience");
        own.push({ tid: `fixture-own-${own.length}`, content: request.params.content, time: Math.floor(Date.now() / 1000), is_private: true });
        data = { tid: own.at(-1).tid, time: own.at(-1).time };
      }
      if (request.action === "get_qzone_msg_list") data = { total: own.length, msglist: own };
      if (request.action === "send_group_msg") data = { message_id: 94001 };
      if (request.action === "send_private_msg") data = { message_id: 95000 + wire.length };
      ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
    });
    await until(() => ws.readyState === 1);
    ws.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: String(91001 + i), status: { online: true, good: true } }));
  }
  await until(async () => (await api("/api/accounts")).data.statuses.filter(x => x.connected).length === 2);
  const pathA = "/api/social-agent/accounts/alpha/qzone", pathB = "/api/social-agent/accounts/beta/qzone";
  check((await api(pathA, "GET", undefined, { auth: false })).status === 403, "QZone local projection is authenticated");
  const initial = (await api(pathA)).data;
  check(initial.ok && initial.policy.ugcRight === 64, "default audience explicit");
  check(Object.values(initial.capabilities).every(x => x === "unknown"), "configuration never claims protocol support");
  check(!wire.some(x => /qzone/.test(x.action)), "opening admin page performs no remote QZone reads or writes");
  const revision = initial.revision;
  const op = (name, body = {}, target = pathA, extra) => api(`${target}/${name}`, "POST", { expectedRevision: revision, ...body }, extra);
  check((await op("create-draft", { content: "无权限", source: { kind: "admin_topic", ref: "fixture" } }, pathA, { origin: "https://example.test" })).status === 403, "cross-origin write denied");
  check((await op("read-feeds", {}, pathB)).status === 409, "peer account cannot inherit enabled policy");
  check((await op("read-feeds", { target_uin: 91002 })).status === 400, "raw target QQ rejected");
  const read = await op("read-feeds"); check(read.status === 200, `authorized read failed ${read.data.code}`);
  const feed = read.data.feeds[0];
  check(feed.source === "private_qzone" && feed.projectable === false, "private surface explicitly labeled");
  check(!/https:|<b>|hidden/.test(feed.content), "HTML and signed transport references excluded");
  check((await api(pathB)).data.feeds.length === 0, "peer feed store isolated");
  const made = await op("create-draft", { content: "一条合成的仅自己可见草稿。", source: { kind: "admin_topic", ref: "fixture-topic" }, audience: 64 });
  check(made.status === 200, `draft failed ${made.data.code}`);
  let draft = made.data.result;
  check(draft.status === "draft" && !draft.protocolAccepted, "creating content is not publishing");
  check((await op("publish", { id: draft.id, draftRevision: draft.revision })).status === 409, "unapproved publish blocked");
  check(!wire.some(x => x.action === "send_qzone_msg"), "no publish without exact approval");
  check((await op("create-draft", { content: "公开未授权", source: { kind: "admin_topic", ref: "fixture-topic" }, audience: 1 })).status === 409, "public audience not inferred");
  check((await op("create-draft", { content: "附件未授权", source: { kind: "admin_topic", ref: "fixture-topic" }, images: ["file:///forbidden"] })).status === 409, "unverified image paths denied");
  for (const name of ["submit-review", "approve"]) {
    const changed = await op(name, { id: draft.id, draftRevision: draft.revision });
    check(changed.status === 200, `${name} passes exact revision`); draft = changed.data.result;
  }
  check((await op("publish", { id: draft.id, draftRevision: draft.revision - 1 })).status === 409, "stale approval version blocked");
  const published = await op("publish", { id: draft.id, draftRevision: draft.revision });
  check(published.status === 200, `publish failed ${published.data.code}`); draft = published.data.result;
  check(draft.protocolAccepted && !draft.clientVerified && draft.status === "publishing", "ACK is not client visibility proof");
  check((await op("publish", { id: draft.id, draftRevision: draft.revision })).status === 409, "confirmed submission never automatically repeated");
  check(wire.filter(x => x.action === "send_qzone_msg").length === 1, "exactly one physical publish request");
  const verified = await op("verify", { id: draft.id, draftRevision: draft.revision });
  check(verified.status === 200 && verified.data.result.clientVerified, `separate own read verifies self-only content ${verified.data.code}`);
  check((await api(pathB)).data.drafts.length === 0, "peer private drafts isolated");
  check((await api("/api/social-agent/accounts/alpha/episodes?conversation_id=group:810001")).data.items.length === 0, "self-only QZone content never becomes group experience");
  const preview = await api("/api/social-agent/accounts/alpha/behavior-preview");
  check(preview.status === 200 && preview.data.diagnostics.promptCost.estimateOnly === true, "host-only behavior preview has honest cost estimate");
  const generated = await op("generate-draft", { topic: "秋日闲想", audience: 64 });
  check(generated.status === 200 && generated.data.result.status === "draft", `model draft is local only ${generated.data.code}`);
  check(modelPrompts.length === 1 && modelPrompts[0].includes("独立风格 alpha"), "draft uses selected account persona once");
  check(wire.filter(x => x.action === "send_qzone_msg").length === 1, "generating draft did not publish it");
  const notice = { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: 91001,
    group_id: 810001, user_id: 93001, target_id: 91001, time: Math.floor(Date.now() / 1000) };
  sockets[0].send(JSON.stringify(notice));
  try { await until(() => modelPrompts.length === 2); }
  catch (error) {
    const state = JSON.parse(fs.readFileSync(path.join(home, "data/memory.json")));
    throw new Error(`${error.message}; synthetic notice diagnostics: ${JSON.stringify({
      observed: !!state.pokeObservations, runtime: state.socialAgents?.bots?.["account:alpha"]?.conversations?.["group:810001"]?.runtime,
      models: modelPrompts.length })}`);
  }
  await until(() => {
    try { return JSON.parse(fs.readFileSync(path.join(home, "data/memory.json"))).socialAgents?.bots?.["account:alpha"]?.conversations?.["group:810001"]?.runtime?.status === "idle"; } catch { return false; }
  });
  const socialState = JSON.parse(fs.readFileSync(path.join(home, "data/memory.json"))).socialAgents.bots["account:alpha"];
  check(!socialState.conversations["group:810001"].messages?.length, "native notice never invents a QQ chat message");
  check(socialState.conversations["group:810001"].runtime.lastProcessedSeq === undefined, "native observation never ACKs chat unread watermarks");
  check(modelPrompts[1].includes("拍一拍通知") && modelPrompts[1].includes('"tools":[]'), "real notice enters existing model-only social lane without tools");
  sockets[0].send(JSON.stringify(notice));
  sockets[0].send(JSON.stringify({ ...notice, user_id: 91002 }));
  sockets[0].send(JSON.stringify({ ...notice, target_id: 91002, time: notice.time - 1 }));
  await pause(1200);
  check(modelPrompts.length === 2, "duplicate, peer-bot and wrong-target notices never wake a second model loop");
  const pokePath = "/api/social-agent/accounts/alpha/native-pokes/probe";
  const sourceId = socialState.conversations["group:810001"].runtime.lastNativeWakeId;
  const pokeBody = { expectedRevision: revision, conversationId: "group:810001", sourceId };
  check((await api(pokePath, "POST", pokeBody, { auth: false })).status === 403, "native probe cannot bypass admin authentication");
  check((await api(pokePath, "POST", { ...pokeBody, userId: "93001" })).status === 409, "probe rejects raw arbitrary targets");
  check((await api(pokePath.replace("alpha", "beta"), "POST", pokeBody)).status === 409, "peer account cannot consume a notice capability");
  const probed = await api(pokePath, "POST", pokeBody);
  check(probed.status === 200 && probed.data.result.status === "accepted", `explicit native probe bound to real synthetic notice ${probed.data.code}`);
  check(wire.filter(x => x.action === "group_poke").length === 1, "exactly one gated native wire test");
  await api(pokePath, "POST", pokeBody);
  check(wire.filter(x => x.action === "group_poke").length === 1, "notice probe cannot replay after accepted ACK");
  check(!wire.some(x => x.action === "friend_poke" || x.action === "send_poke"), "no fallback endpoint guesses");
  const current = (await api("/api/accounts")).data;
  check((await api("/api/accounts/alpha", "PATCH", { expectedRevision: current.revision, patch: { qzone: { ...initial.policy, enabled: false } } })).status === 200, "account-owned stop accepted");
  check((await op("read-feeds")).status === 409, "old policy revision cannot read after stop");
  check(wire.filter(x => /qzone/.test(x.action)).every(x => x.account === 0), "all space IO bound to correct physical account");
  const spoken = wire.filter(x => /send_(?:group|private)_msg/.test(x.action));
  check(spoken.length === 1 && spoken[0].account === 0 && spoken[0].action === "send_group_msg"
    && JSON.stringify(spoken[0].params).includes("合成拍一拍回应"), "only explicit native response enters chat; space never falls back to chat");
  const beforeReview = (await api("/api/accounts")).data;
  const enabledReview = await api("/api/accounts/alpha", "PATCH", { expectedRevision: beforeReview.revision,
    patch: { qzone: { ...initial.policy, enabled: true, reviewTransport: "qq_owner" } } });
  check(enabledReview.status === 200, "QQ owner review policy saves on one account");
  const reviewView = (await api(pathA)).data;
  const createdForOwner = await api(`${pathA}/create-draft`, "POST", { expectedRevision: reviewView.revision,
    content: "公开素材的独立空间预览", source: { kind: "admin_topic", ref: "owner-qq-topic" } });
  check(createdForOwner.status === 200, `owner draft creation/preview ${createdForOwner.data.code}`);
  const previewWire = wire.filter(x => x.action === "send_private_msg").at(-1);
  const previewText = previewWire?.params.message?.[0]?.data?.text;
  const reviewToken = previewText?.match(/qzone confirm ([a-f0-9]{32})/)?.[1];
  check(previewWire?.account === 0 && String(previewWire.params.user_id) === "93001"
    && previewText.includes("公开素材的独立空间预览") && reviewToken, "exact body and confirmation token reach verified owner private chat");
  const ownerDraft = createdForOwner.data.result;
  check((await api(`${pathA}/approve`, "POST", { expectedRevision: reviewView.revision,
    id: ownerDraft.id, draftRevision: ownerDraft.revision })).data.code === "QZONE_OWNER_QQ_CONFIRM_REQUIRED", "console cannot bypass QQ review");
  const ownerEvent = (userId, selfId, messageId) => ({ post_type: "message", message_type: "private", sub_type: "friend",
    self_id: selfId, user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000),
    raw_message: `/bot qzone confirm ${reviewToken}`, message: [{ type: "text", data: { text: `/bot qzone confirm ${reviewToken}` } }],
    sender: { user_id: userId, nickname: "Fixture owner" } });
  sockets[1].send(JSON.stringify(ownerEvent(93001, 91002, 96101)));
  await pause(250);
  check(wire.filter(x => x.action === "send_qzone_msg").length === 1, "another account cannot consume owner token");
  sockets[0].send(JSON.stringify(ownerEvent(93001, 91001, 96102)));
  await until(() => wire.filter(x => x.action === "send_qzone_msg").length === 2);
  check(wire.filter(x => x.action === "send_qzone_msg").at(-1).params.content === "公开素材的独立空间预览", "owner confirmation executes exact reviewed body once");
  sockets[0].send(JSON.stringify(ownerEvent(93001, 91001, 96103)));
  await pause(350);
  check(wire.filter(x => x.action === "send_qzone_msg").length === 2, "duplicate owner confirmation never republishes");
  const beforeVision = (await api("/api/config")).data;
  const visionSave = await api("/api/config", "PATCH", { expectedRevision: beforeVision.revision,
    vision: { enabled: true, preferChatModel: true } });
  check(visionSave.status === 200, "administrator pins chat image capability through config CAS");
  const imageConfig = (await api("/api/config")).data;
  check(imageConfig.vision.preferChatModel && imageConfig.vision.chatModelCapabilities.default.model === "synthetic-only", "saved capability readback is binding-specific not inferred by model name");
  const center = (await api("/api/api-center")).data;
  const messagesBeforeImageTest = wire.filter(x => /^send_/.test(x.action)).length;
  const imageTest = await api("/api/api-center/test", "POST", { capability: "vision", center: center.center });
  check(imageTest.status === 200 && imageTest.data.detail === "合成识图成功", `chat multimodal API path returns real fake-provider text ${imageTest.data.error || ""}`);
  check(wire.filter(x => /^send_/.test(x.action)).length === messagesBeforeImageTest, "vision API test never sends QQ");
  check(!/ReferenceError|TypeError|EPISODE_SOURCE/.test(log), "bridge had no implementation errors");
  console.log(JSON.stringify({ ok: true, checks, fakeOneBots: 2, realQqWrites: 0, fakeModelCalls: modelPrompts.length, realModelCalls: 0, productionTouched: false }));
} finally {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([closed, pause(1500)]); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  fs.rmSync(home, { recursive: true, force: true });
}
