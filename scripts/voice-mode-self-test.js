import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { normalizeVoiceReplyMode, shouldSendVoiceReply, voiceReplyMode } from "../src/voice-mode.js";

assert.equal(normalizeVoiceReplyMode("关闭"), "off");
assert.equal(normalizeVoiceReplyMode("混合"), "mixed");
assert.equal(normalizeVoiceReplyMode("强制"), "force");
assert.equal(normalizeVoiceReplyMode("unknown"), "");
assert.equal(normalizeVoiceReplyMode("__proto__"), "");
assert.equal(voiceReplyMode({ voiceReplyMode: "off" }, { replyMode: "force" }), "off");
assert.equal(voiceReplyMode({}, {}), "mixed");
assert.equal(shouldSendVoiceReply({ mode: "off", incomingVoice: true, direct: true, text: "你好" }), false);
assert.equal(shouldSendVoiceReply({ mode: "mixed", incomingVoice: true, direct: true, text: "你好" }), true);
assert.equal(shouldSendVoiceReply({ mode: "mixed", incomingVoice: false, direct: true, text: "你好" }), false);
assert.equal(shouldSendVoiceReply({ mode: "force", direct: false, text: "你好" }), true);

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-voice-mode-"));
const state = path.join(temp, "state");
const logs = path.join(temp, "logs");
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.mkdirSync(logs, { recursive: true, mode: 0o700 });

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
config.listen.port = await freePort();
config.control.port = await freePort();
config.accounts.primary.qq = "10001";
config.accounts.primary.protocol = "napcat";
config.accounts.standbys = [];
config.accounts.failover.enabled = false;
config.targetGroups = ["*"];
config.commands.adminUserIds = ["20002"];
config.privateChats.enabled = true;
config.privateChats.targetUsers = ["20002"];
config.privateChats.ownerUserIds = ["20002"];
config.voice.enabled = true;
config.voice.tts.enabled = true;
config.voice.tts.allowMemberVoiceDesign = false;
config.voice.voiceClone.enabled = true;
config.memory.aiExtraction.enabled = false;
config.webSearch.enabled = false;
config.loginRecovery.enabled = false;
config.adminNotifications.enabled = false;
config.dailyMessages.enabled = false;
config.automation.enabled = false;
config.taskMode.enabled = false;
const mockAi = path.join(temp, "mock-ai.cjs");
fs.writeFileSync(mockAi, 'process.stdout.write("这是隔离测试回复。");\n', { mode: 0o600 });
config.ai.command = process.execPath;
config.ai.args = [mockAi];
fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });

const child = spawn(process.execPath, [path.join(root, "src/bridge.js")], {
  cwd: root,
  env: { ...process.env, MIMO_API_KEY: "", HERMES_QQ_HOME: state, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: logs },
  stdio: ["ignore", "pipe", "pipe"]
});
let socket;
let lastError = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { lastError = `${lastError}${chunk}`.slice(-2000); });
try {
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`bridge exited ${child.exitCode}: ${lastError}`);
    try { ready = (await fetch(`http://127.0.0.1:${config.control.port}/health`)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, `bridge did not start: ${lastError}`);
  socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const waiting = [];
  socket.on("message", (raw) => {
    let action;
    try { action = JSON.parse(String(raw)); } catch { return; }
    if (!action?.echo) return;
    const id = Number(action.params?.message_id);
    const data = action.action === "get_msg"
      ? { message_id: id, sender: { user_id: id === 42 ? 20002 : 30004 }, message: [{ type: "record", data: { file: "sample.amr" } }] }
      : { message_id: 777 };
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: action.echo }));
    if (!["send_group_msg", "send_private_msg"].includes(action.action)) return;
    const text = String(action.params?.message || "");
    const match = waiting.find((item) => item.action === action.action && item.pattern.test(text));
    if (match) {
      waiting.splice(waiting.indexOf(match), 1);
      clearTimeout(match.timer);
      match.resolve(text);
    }
  });
  let messageId = 100;
  async function command(text, pattern, { privateChat = false, userId = 20002, quoteId = 0 } = {}) {
    const action = privateChat ? "send_private_msg" : "send_group_msg";
    const reply = new Promise((resolve, reject) => {
      const item = { action, pattern, resolve, timer: null };
      item.timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error(`no response to ${text}: ${lastError}`)); }, 8000);
      waiting.push(item);
    });
    socket.send(JSON.stringify({
      post_type: "message", message_type: privateChat ? "private" : "group",
      group_id: privateChat ? undefined : 30003, self_id: 10001, user_id: userId,
      message_id: ++messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "测试用户", role: "member" },
      message: [...(quoteId ? [{ type: "reply", data: { id: String(quoteId) } }] : []), { type: "text", data: { text } }]
    }));
    return reply;
  }
  assert.match(await command("/bot voice status", /本会话语音模式：混合/), /preset/);
  assert.match(await command("/bot voice force", /本会话语音模式已设为强制/), /强制/);
  assert.match(await command("/bot voice synth 你好", /语音发送失败，先用文字回你：你好/), /你好/);
  assert.match(await command("/bot voice off", /本会话语音模式已设为关闭/), /关闭/);
  assert.match(await command("/bot voice force", /语音模式要群主或管理员/, { userId: 20003 }), /管理员/);
  assert.match(await command("/bot voice preset list", /可选音色/), /冰糖/);
  assert.match(await command("/bot voice preset 冰糖", /音色换成「冰糖」/), /冰糖/);
  assert.match(await command("/bot voice design 年轻 清亮 | 测试", /语音模式已关闭/), /关闭/);
  assert.match(await command("/bot voice mixed", /本会话语音模式已设为混合/), /混合/);
  assert.match(await command("/bot voice design 年轻 清亮 | 再测试", /临时设计音色尚未开启/), /尚未开启/);
  assert.match(await command("/bot voice clone self 你好", /引用你自己发的语音/, { quoteId: 43 }), /自己/);
  assert.match(await command("/bot voice clone self 你好", /2 分钟内发送 \/bot voice clone confirm [A-F0-9]{8}/, { quoteId: 42 }), /本人语音/);
  assert.match(await command("/bot voice status", /本会话语音模式：混合/, { privateChat: true }), /混合/);
  assert.match(await command("/bot voice force", /本会话语音模式已设为强制/, { privateChat: true }), /强制/);
  assert.match(await command("你好", /这是隔离测试回复/, { privateChat: true }), /这是隔离测试回复/);
  const memory = JSON.parse(fs.readFileSync(path.join(state, "data/memory.json"), "utf8"));
  assert.equal(memory.groups["30003"].settings.voiceReplyMode, "mixed");
  assert.equal(memory.groups["30003"].settings.voicePreset, "冰糖");
  assert.equal(memory.groups["private:20002"].settings.voiceReplyMode, "force");
  console.log(JSON.stringify({ ok: true, commands: 15, realQqMessages: 0, fallbackText: true }));
} finally {
  socket?.close();
  child.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
}
