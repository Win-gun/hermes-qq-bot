// Isolated OneBot round-trip: no real QQ account or message is used.
// Requires MIMO_API_KEY in the environment to exercise real TTS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { synthesizeSpeechFile } from "../src/voice-service.js";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-voice-route-"));
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
config.accounts.primary.displayName = "Eraser的小跟班";
config.accounts.primary.protocol = "napcat";
config.accounts.standbys = [];
config.accounts.failover.enabled = false;
config.targetGroups = ["*"];
config.privateChats.enabled = true;
config.privateChats.targetUsers = ["20002"];
config.privateChats.ownerUserIds = ["20002"];
config.voice.enabled = true;
config.voice.tts.enabled = true;
config.voice.tts.model = "mimo-v2.5-tts";
config.voice.tts.voice = "mimo_default";
config.memory.aiExtraction.enabled = false;
config.webSearch.enabled = false;
config.adminNotifications.enabled = false;
config.loginRecovery.enabled = false;
config.dailyMessages.enabled = false;
config.automation.enabled = false;
config.taskMode.enabled = false;
const mockAi = path.join(temp, "mock-chat-ai.cjs");
fs.writeFileSync(mockAi, `const prompt = process.argv.at(-1) || "";
process.stdout.write(prompt.includes("语音发送意图裁判")
  ? JSON.stringify({ should_send_voice: true, confidence: 0.96 })
  : prompt.includes("当前语音转写：今天是语音识别测试")
    ? "已听懂语音：今天是语音识别测试。"
  : "这是模型判断后发出的语音。");\n`, { mode: 0o600 });
config.ai.command = process.execPath;
config.ai.args = [mockAi];
fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
const sampleWav = path.join(temp, "sample.wav");
await synthesizeSpeechFile({
  text: "今天是语音识别测试。", outputPath: sampleWav,
  model: "mimo-v2.5-tts", voice: "mimo_default",
  config: { apiKeyEnv: "MIMO_API_KEY", outputDir: temp }
});
const asrFixtureBase64 = `base64://${fs.readFileSync(sampleWav).toString("base64")}`;

const child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], {
  cwd: root,
  env: { ...process.env, HERMES_QQ_HOME: state, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: logs },
  stdio: ["ignore", "pipe", "pipe"]
});
let childOutput = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  childOutput = `${childOutput}${String(chunk)}`.slice(-8000);
});
let socket;
try {
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated bridge exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${config.control.port}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("isolated bridge did not start");

  socket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let recordWaiter = null;
  let textWaiter = null;
  socket.on("message", (raw) => {
    let action;
    try { action = JSON.parse(String(raw)); } catch { return; }
    if (!action?.echo) return;
    const data = action.action === "get_msg"
      ? { message_id: 42, sender: { user_id: 10001, nickname: "bot" }, message: "在的" }
      : action.action === "get_record" ? { base64: asrFixtureBase64 }
      : { message_id: 777 };
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: action.echo }));
    const record = Array.isArray(action.params?.message)
      ? action.params.message.find((item) => item?.type === "record") : null;
    if (record && recordWaiter) recordWaiter({ action: action.action, params: action.params, file: record.data?.file });
    if (action.action === "send_group_msg" && typeof action.params?.message === "string" && textWaiter) {
      textWaiter(action.params.message);
    }
  });
  async function checkSpeech(event, expectedAction, expectedRecipient) {
    const speech = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${expectedAction} record within 60 seconds`)), 60_000);
      recordWaiter = (result) => {
        if (result.action !== expectedAction) return;
        clearTimeout(timer);
        recordWaiter = null;
        resolve(result);
      };
    });
    socket.send(JSON.stringify(event));
    const result = await speech;
    assert.equal(String(result.params[expectedAction === "send_private_msg" ? "user_id" : "group_id"]), expectedRecipient);
    assert.match(result.file, /^base64:\/\//);
    const wav = Buffer.from(result.file.slice("base64://".length), "base64");
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    return wav.length;
  }
  const common = { post_type: "message", self_id: 10001, user_id: 20002, time: Math.floor(Date.now() / 1000), sender: { nickname: "测试用户" } };
  const asrText = new Promise((resolve, reject) => {
    let lastText = "";
    const timer = setTimeout(() => reject(new Error(`no transcription-based group reply; last reply=${lastText || "none"}; bridge log=${childOutput.slice(-3500) || "none"}`)), 25_000);
    textWaiter = (message) => {
      lastText = String(message).slice(0, 200);
      if (!String(message).includes("已听懂语音")) return;
      clearTimeout(timer);
      textWaiter = null;
      resolve(message);
    };
  });
  socket.send(JSON.stringify({
    ...common, message_type: "group", group_id: 30003, message_id: 12351,
    message: [
      { type: "at", data: { qq: "10001" } },
      { type: "record", data: { file: "sample.amr" } }
    ]
  }));
  assert.match(await asrText, /今天是语音识别测试/u);
  const bareFollowupBytes = await checkSpeech({
    ...common, message_type: "group", group_id: 30003, message_id: 12353,
    message: [{ type: "text", data: { text: "用语音" } }]
  }, "send_group_msg", "30003");
  const privateBytes = await checkSpeech({
    ...common, message_type: "private", message_id: 12345,
    message: [{ type: "text", data: { text: "用语音给我讲个笑话" } }]
  }, "send_private_msg", "20002");
  const greetingBytes = await checkSpeech({
    ...common, message_type: "private", message_id: 12347,
    message: [{ type: "text", data: { text: "用语音给我打个招呼" } }]
  }, "send_private_msg", "20002");
  const groupBytes = await checkSpeech({
    ...common, message_type: "group", group_id: 30003, message_id: 12346,
    message: [
      { type: "reply", data: { id: "42" } },
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 用语音给我讲个笑话" } }
    ]
  }, "send_group_msg", "30003");
  const aliasGroupBytes = await checkSpeech({
    ...common, message_type: "group", group_id: 30003, message_id: 12348,
    message: [{ type: "text", data: { text: "@Eraser的小跟班 用语音给我讲个笑话" } }]
  }, "send_group_msg", "30003");
  const judgedPrivateBytes = await checkSpeech({
    ...common, message_type: "private", message_id: 12349,
    message: [{ type: "text", data: { text: "你开口说给我听听" } }]
  }, "send_private_msg", "20002");
  const repeatQuoteBytes = await checkSpeech({
    ...common, message_type: "group", group_id: 30003, message_id: 12350,
    message: [
      { type: "reply", data: { id: "42" } },
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 用语音发一遍" } }
    ]
  }, "send_group_msg", "30003");
  console.log(JSON.stringify({ ok: true, privateRecordBytes: privateBytes, greetingRecordBytes: greetingBytes,
    groupRecordBytes: groupBytes, aliasGroupRecordBytes: aliasGroupBytes,
    aiJudgedRecordBytes: judgedPrivateBytes, repeatQuoteBytes, bareFollowupBytes,
    asrTranscribed: true, realQqMessages: 0 }));
} finally {
  socket?.close();
  child.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
}
