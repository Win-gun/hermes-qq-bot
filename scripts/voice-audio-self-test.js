import assert from "node:assert/strict";
import { audioFormat, decodeOneBotAudioBase64, trustedQqAudioUrl } from "../src/voice-audio.js";

assert.equal(trustedQqAudioUrl("https://multimedia.nt.qq.com.cn/download?token=redacted"), true);
assert.equal(trustedQqAudioUrl("http://multimedia.nt.qq.com.cn/download"), false);
assert.equal(trustedQqAudioUrl("https://qq.com.cn.evil.example/download"), false);
assert.equal(trustedQqAudioUrl("https://127.0.0.1/download"), false);
const wav = Buffer.concat([Buffer.from("RIFF0000WAVE"), Buffer.alloc(16)]);
assert.equal(audioFormat(wav), "wav");
assert.deepEqual(decodeOneBotAudioBase64(`base64://${wav.toString("base64")}`, 1024), wav);
assert.equal(decodeOneBotAudioBase64(`base64://${wav.toString("base64")}`, 10), null);
assert.equal(audioFormat(Buffer.from("#!AMR\n")), "amr");
assert.equal(audioFormat(Buffer.from("ID3\u0004\u0000\u0000")), "mp3");
assert.equal(audioFormat(Buffer.from("\u0002#!SILK_V3\u0000")), "silk");
console.log(JSON.stringify({ ok: true, checks: "voice source and format" }));
