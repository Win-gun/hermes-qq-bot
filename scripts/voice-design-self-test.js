import assert from "node:assert/strict";
import { parseMemberVoiceDesign } from "../src/voice-design.js";

const design = parseMemberVoiceDesign("design 年轻 清亮 活泼 | 今天心情不错");
assert.equal(design.speech, "今天心情不错");
assert.deepEqual(design.traits, ["年轻", "清亮", "活泼"]);
assert.ok(design.voiceDescription.includes("不模仿任何真实人物"));
for (const bad of [
  "design 某明星 清亮 | 你好",
  "design 年轻 | 你好",
  "design 年轻 清亮 活泼 沉稳 甜美 | 你好",
  "design 年轻 清亮 | \n恶意内容",
  "design 年轻 清亮 | "
]) assert.throws(() => parseMemberVoiceDesign(bad));
console.log(JSON.stringify({ ok: true, checks: "bounded original voice traits and speech" }));
