import assert from "node:assert/strict";
import { buildRecordMessage, extractRecordRefs, isPublicHttpUrl } from "../src/voice-onebot.js";

const publicUrl = "https://media.qq.com/audio/clip.amr?token=abc";
const secondUrl = "https://cdn.qq.com/audio/second.mp3";
assert.equal(isPublicHttpUrl(publicUrl), true);
assert.equal(isPublicHttpUrl("http://8.8.8.8/voice.amr"), true);
for (const unsafe of [
  "file:///etc/passwd", "/etc/passwd", "../voice.amr", "C:\\voice.amr", "ftp://media.qq.com/voice.amr",
  "http://127.0.0.1/voice.amr", "http://127.1/voice.amr", "http://2130706433/voice.amr",
  "http://10.0.0.1/voice.amr", "http://192.168.1.1/voice.amr", "http://172.16.0.1/voice.amr",
  "http://169.254.1.1/voice.amr", "http://100.64.0.1/voice.amr",
  "http://localhost/voice.amr", "http://x.local/voice.amr", "http://service.internal/voice.amr",
  "http://user:pass@media.qq.com/voice.amr", "http://media.qq.com:6200/voice.amr",
  "https://media.qq.com/voice.amr#fragment", "https://media.qq.com/voice.amr\nHost: localhost",
  "http://[::1]/voice.amr", "https://example.com/voice.amr"
]) assert.equal(isPublicHttpUrl(unsafe), false, `unsafe URL rejected: ${unsafe}`);

const arrayMessage = [
  { type: "text", data: { text: "听一下" } },
  { type: "record", data: { file: publicUrl } },
  { type: "audio", data: { file: "../private.amr", url: secondUrl } },
  { type: "record", data: { file: "/tmp/not-trusted.amr" } },
  { type: "image", data: { url: publicUrl } }
];
assert.deepEqual(extractRecordRefs(arrayMessage), [
  { file: publicUrl, url: publicUrl, source: "current" },
  { file: "", url: secondUrl, source: "current" }
]);

const cq = `[CQ:record,file=${publicUrl}&#44;part=1]`;
assert.deepEqual(extractRecordRefs(cq), [{ file: `${publicUrl},part=1`, url: `${publicUrl},part=1`, source: "current" }], "CQ escaped comma stays in one parameter");
assert.deepEqual(extractRecordRefs(`[CQ:record,file=${publicUrl},file=${secondUrl}]`), [], "duplicate CQ keys are rejected");
assert.deepEqual(extractRecordRefs("[CQ:record,file=/etc/passwd]"), []);
assert.deepEqual(extractRecordRefs("[CQ:record,file=http://127.0.0.1/audio]"), []);

const quoted = extractRecordRefs("[CQ:reply,id=42]这段语音是什么？", {
  quotedMessages: [
    { message_id: 42, senderId: "123456", message: [{ type: "record", data: { url: publicUrl } }] },
    { message_id: 99, message: [{ type: "record", data: { url: secondUrl } }] }
  ]
});
assert.deepEqual(quoted, [{ file: "", url: publicUrl, source: "quoted", messageId: "42", senderId: "123456" }], "only referenced get_msg payload is used, with verified sender");
assert.deepEqual(extractRecordRefs("无引用", { quotedMessages: [{ message_id: 42, message: [{ type: "record", data: { url: publicUrl } }] }] }), []);
assert.deepEqual(extractRecordRefs([{ type: "reply", data: { id: "42" } }], {
  quotedMessages: [{ messageId: "42", raw_message: `[CQ:audio,file=${secondUrl}]` }]
}), [{ file: secondUrl, url: secondUrl, source: "quoted", messageId: "42", senderId: "" }]);

const verifiedPath = "/protocol-cache/record-42.amr";
const isVerifiedProtocolFile = (value, context) => value === verifiedPath && context.source === "quoted" && context.messageId === "42";
assert.deepEqual(extractRecordRefs("[CQ:reply,id=42]", {
  quotedMessages: [{ message_id: 42, message: [{ type: "record", data: { file: verifiedPath } }] }],
  isVerifiedProtocolFile
}), [{ file: verifiedPath, url: "", source: "quoted", messageId: "42", senderId: "" }], "explicitly attested protocol response may be retained");
assert.deepEqual(extractRecordRefs([{ type: "record", data: { file: verifiedPath } }], { isVerifiedProtocolFile }), [], "same path is not trusted in a different context");
assert.deepEqual(extractRecordRefs([{ type: "record", data: { file: "../record-42.amr" } }], { isVerifiedProtocolFile: () => true }), [], "traversal stays blocked");
assert.deepEqual(extractRecordRefs([{ type: "record", data: { file: "https://127.0.0.1/a" } }], { isVerifiedProtocolFile: () => true }), [], "private URL cannot be laundered through callback");

assert.deepEqual(buildRecordMessage(publicUrl), { type: "record", data: { file: publicUrl } });
assert.throws(() => buildRecordMessage("/etc/passwd"), /public http/);
assert.throws(() => buildRecordMessage("http://127.0.0.1/audio", { isVerifiedProtocolFile: () => true }), /public http/);
assert.deepEqual(buildRecordMessage(verifiedPath, {
  isVerifiedProtocolFile: (value, context) => value === verifiedPath && context.direction === "outgoing"
}), { type: "record", data: { file: verifiedPath } });
const wav = Buffer.alloc(16);
wav.write("RIFF", 0, "ascii");
wav.write("WAVE", 8, "ascii");
assert.equal(buildRecordMessage(wav).data.file, `base64://${wav.toString("base64")}`);
assert.throws(() => buildRecordMessage(Buffer.from("not audio")), /bounded WAV/);

console.log(JSON.stringify({ ok: true, checks: "segments, CQ escaping, quoted records, public URL policy, protocol attestation, outbound record" }));
