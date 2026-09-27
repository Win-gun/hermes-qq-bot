import assert from "node:assert/strict";
import { detectVoiceReplyIntent, shouldJudgeVoiceReplyIntent } from "../src/voice-intent.js";
import { sanitizeChatReply } from "../src/reply-safety.js";

const parse = (text, addressed = true) => detectVoiceReplyIntent(text, {
  addressed,
  addressNames: ["Eraser的小跟班", "Eraser的小跟班2", "小跟班", "10001"]
});
assert.deepEqual(parse("再次测试发送语音"), { kind: "test", text: "语音测试成功，我可以给你发语音条了。" });
assert.deepEqual(parse("再次语音测试"), { kind: "test", text: "语音测试成功，我可以给你发语音条了。" });
assert.deepEqual(parse("给我发条语音"), { kind: "test", text: "语音测试成功，我可以给你发语音条了。" });
assert.deepEqual(parse("给我发一个语音"), { kind: "test", text: "语音测试成功，我可以给你发语音条了。" });
assert.deepEqual(parse("用语音给我介绍一下你自己"), { kind: "answer", text: "介绍一下你自己" });
assert.deepEqual(parse("用语音"), { kind: "followup", text: "" });
assert.deepEqual(parse("@Eraser的小跟班 用语音发一遍"), { kind: "repeat", text: "" });
assert.deepEqual(parse("没有用语音发出来啊"), { kind: "repeat", text: "" });
assert.deepEqual(parse("发语音说你好呀"), { kind: "speak", text: "你好呀" });
assert.deepEqual(parse("用语音回答我今天的天气"), { kind: "answer", text: "今天的天气" });
assert.deepEqual(parse("再次测试发送语音，说一句开玩笑的话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.deepEqual(parse("发一条语音，讲个笑话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.deepEqual(parse("用语音给我讲个笑话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.deepEqual(parse("@Eraser的小跟班 用语音给我讲个笑话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.deepEqual(parse("[引用消息]@Eraser的小跟班 用语音给我讲个笑话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.deepEqual(parse("用语音给我打个招呼"), { kind: "greeting", text: "嗨，我是小跟班！今天过得怎么样？" });
assert.deepEqual(parse("@Eraser的小跟班2 用语音跟我问个好"), { kind: "greeting", text: "嗨，我是小跟班！今天过得怎么样？" });
assert.deepEqual(parse("[引用消息]用语音给我讲个笑话"), { kind: "joke", text: "我本来想讲个冷笑话，结果空调说：这活儿它熟。" });
assert.equal(parse("[引用消息]用语音给我讲个笑话", false), null);
assert.deepEqual(parse("请用语音念：今天要早点睡"), { kind: "speak", text: "今天要早点睡" });
assert.equal(parse("再次测试发送语音", false), null);
assert.equal(parse("@Eraser的小跟班 用语音给我讲个笑话", false), null);
for (const message of ["能不能发语音？", "语音识别坏了吗", "如何设置语音功能", "这个语音消息怎么回事", "他刚才发送语音了", "语音消息发不出来为什么", "发语音为什么失败"]) {
  assert.equal(parse(message), null, message);
}
assert.equal(shouldJudgeVoiceReplyIntent("说给我听听", { addressed: true }), true);
assert.equal(shouldJudgeVoiceReplyIntent("讨论一下语音功能", { addressed: false }), false);
assert.equal(shouldJudgeVoiceReplyIntent("今天吃什么", { addressed: true }), false);
assert.equal(sanitizeChatReply("语音合成成功\nMEDIA:/tmp/hermesqq-test-audio.mp3\n稍等"), "语音合成成功\n\n稍等");
assert.equal(sanitizeChatReply("这是正常的文字消息"), "这是正常的文字消息");
console.log(JSON.stringify({ ok: true, checks: "voice intent and false-positive guard" }));
