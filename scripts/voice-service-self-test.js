import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizeSpeechFile, transcribeAudioFile, validateVoiceConfig } from "../src/voice-service.js";

const directory = await mkdtemp(join(tmpdir(), "voice-service-test-"));
const env = { MIMO_API_KEY: "test-only-placeholder" };
const config = { outputDir: directory, timeoutMs: 1000, maxInputBytes: 1024, maxOutputBytes: 1024 };
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(16)]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const wavPath = join(directory, "input.wav");
const mp3Path = join(directory, "input.mp3");
let calls = 0;

function mockFetch(verify, payload) {
  return async (url, options) => {
    calls += 1;
    assert.equal(url, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${env.MIMO_API_KEY}`);
    assert.ok(options.signal instanceof AbortSignal);
    verify(JSON.parse(options.body));
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

try {
  await Promise.all([writeFile(wavPath, wav), writeFile(mp3Path, mp3)]);
  assert.equal(validateVoiceConfig(config, { env }).apiKeyEnv, "MIMO_API_KEY");
  assert.equal(JSON.stringify(validateVoiceConfig(config, { env })).includes(env.MIMO_API_KEY), false);
  assert.throws(() => validateVoiceConfig(config, { env: {} }), /not configured/);
  assert.throws(() => validateVoiceConfig({ timeoutMs: 0 }, { env }), /timeoutMs/);

  const recognized = await transcribeAudioFile({
    inputPath: mp3Path, language: "zh", config, env,
    fetchImpl: mockFetch((body) => {
      assert.equal(body.model, "mimo-v2.5-asr");
      assert.deepEqual(body.asr_options, { language: "zh" });
      assert.equal(body.messages[0].content[0].input_audio.data, `data:audio/mpeg;base64,${mp3.toString("base64")}`);
    }, { choices: [{ message: { content: "你好" } }] })
  });
  assert.equal(recognized, "你好");

  const defaultResult = await synthesizeSpeechFile({
    text: "你好", outputPath: "default.wav", config, env,
    fetchImpl: mockFetch((body) => {
      assert.equal(body.model, "mimo-v2.5-tts");
      assert.deepEqual(body.messages, [{ role: "assistant", content: "你好" }]);
      assert.deepEqual(body.audio, { format: "wav", voice: "mimo_default" });
    }, { choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
  });
  assert.equal(defaultResult.outputPath, join(await realpath(directory), "default.wav"));
  assert.deepEqual(await readFile(defaultResult.outputPath), wav);

  await synthesizeSpeechFile({
    text: "测试", outputPath: "designed.wav", model: "mimo-v2.5-tts-voicedesign",
    voiceDescription: "温柔的声音", config, env,
    fetchImpl: mockFetch((body) => {
      assert.equal(body.model, "mimo-v2.5-tts-voicedesign");
      assert.deepEqual(body.messages, [
        { role: "user", content: "温柔的声音" },
        { role: "assistant", content: "测试" }
      ]);
      assert.deepEqual(body.audio, { format: "wav" });
    }, { choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
  });

  await assert.rejects(synthesizeSpeechFile({
    text: "不应调用", outputPath: "no-consent.wav", model: "mimo-v2.5-tts-voiceclone",
    referenceAudioPath: wavPath, config, env, fetchImpl: () => { throw new Error("unexpected fetch"); }
  }), /consentToVoiceClone/);
  await assert.rejects(synthesizeSpeechFile({
    text: "不应调用", outputPath: "no-reference.wav", model: "mimo-v2.5-tts-voiceclone",
    consentToVoiceClone: true, config, env, fetchImpl: () => { throw new Error("unexpected fetch"); }
  }), /referenceAudioPath/);
  await synthesizeSpeechFile({
    text: "授权测试", outputPath: "clone.wav", model: "mimo-v2.5-tts-voiceclone",
    consentToVoiceClone: true, referenceAudioPath: wavPath, config, env,
    fetchImpl: mockFetch((body) => {
      assert.equal(body.model, "mimo-v2.5-tts-voiceclone");
      assert.equal(body.audio.voice, `data:audio/wav;base64,${wav.toString("base64")}`);
    }, { choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
  });

  await assert.rejects(synthesizeSpeechFile({
    text: "测试", outputPath: "../escape.wav", config, env,
    fetchImpl: () => { throw new Error("unexpected fetch"); }
  }), /directly inside outputDir/);
  await assert.rejects(synthesizeSpeechFile({
    text: "测试", outputPath: "default.wav", config, env,
    fetchImpl: mockFetch(() => {}, { choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
  }), { code: "EEXIST" });
  assert.deepEqual(await readFile(defaultResult.outputPath), wav);

  await assert.rejects(transcribeAudioFile({
    inputPath: mp3Path, config: { ...config, maxInputBytes: 4 }, env,
    fetchImpl: () => { throw new Error("unexpected fetch"); }
  }), /input audio size/);
  await assert.rejects(synthesizeSpeechFile({
    text: "测试", outputPath: "oversize.wav", config: { ...config, maxOutputBytes: 12 }, env,
    fetchImpl: mockFetch(() => {}, { choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
  }), /oversized/);
  await assert.rejects(synthesizeSpeechFile({
    text: "测试", outputPath: "bad-response.wav", config, env,
    fetchImpl: mockFetch(() => {}, { choices: [{ message: { audio: { data: "not-base64" } } }] })
  }), /invalid or oversized/);
  await assert.rejects(transcribeAudioFile({
    inputPath: wavPath, config, env,
    fetchImpl: mockFetch(() => {}, { choices: [] })
  }), /no transcription/);
  await assert.rejects(transcribeAudioFile({
    inputPath: wavPath, config, env,
    fetchImpl: async () => new Response("server internals", { status: 401 })
  }), /HTTP 401/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transcribeAudioFile({
    inputPath: wavPath, config, env, signal: controller.signal,
    fetchImpl: () => { throw new Error("unexpected fetch"); }
  }), /cancelled or timed out/);
  await assert.rejects(transcribeAudioFile({
    inputPath: wavPath, config: { ...config, timeoutMs: 5 }, env,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  }), /cancelled or timed out/);

  console.log(`voice-service self-test: PASS (${calls} mocked API calls, no real requests)`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
