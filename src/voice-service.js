import { open, lstat, realpath, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
const ASR_MODEL = "mimo-v2.5-asr";
const TTS_MODELS = new Set([
  "mimo-v2.5-tts",
  "mimo-v2.5-tts-voicedesign",
  "mimo-v2.5-tts-voiceclone"
]);
const AUDIO_TYPES = { ".mp3": "audio/mpeg", ".wav": "audio/wav" };

/** Validate public settings without returning or logging the API key. */
export function validateVoiceConfig(config = {}, { env = process.env } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("Invalid voice config");
  const apiKeyEnv = config.apiKeyEnv ?? "MIMO_API_KEY";
  if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new TypeError("Invalid API key environment variable name");
  }
  if (typeof env?.[apiKeyEnv] !== "string" || !env[apiKeyEnv].trim()) {
    throw new Error(`Voice API key is not configured in ${apiKeyEnv}`);
  }
  const integer = (name, fallback, ceiling) => {
    const value = config[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new RangeError(`Invalid ${name}`);
    return value;
  };
  if (config.outputDir !== undefined && (typeof config.outputDir !== "string" || !config.outputDir.trim())) {
    throw new TypeError("Invalid outputDir");
  }
  return {
    apiKeyEnv,
    outputDir: config.outputDir,
    timeoutMs: integer("timeoutMs", 60_000, 300_000),
    maxInputBytes: integer("maxInputBytes", 5 * 1024 * 1024, 7 * 1024 * 1024),
    maxOutputBytes: integer("maxOutputBytes", 10 * 1024 * 1024, 20 * 1024 * 1024)
  };
}

function audioType(path) {
  if (typeof path !== "string" || !path) throw new TypeError("Audio path is required");
  const type = AUDIO_TYPES[extname(path).toLowerCase()];
  if (!type) throw new TypeError("Only MP3 and WAV input files are supported");
  return type;
}

async function readAudio(path, maxBytes) {
  const type = audioType(path);
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > maxBytes) throw new RangeError("Invalid input audio size");
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("Input audio changed while reading");
      offset += bytesRead;
    }
    // Avoid sending arbitrary files renamed with a supported extension.
    if (type === "audio/wav" && (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")) {
      throw new TypeError("Invalid WAV input");
    }
    if (type === "audio/mpeg" && buffer.toString("ascii", 0, 3) !== "ID3" && !(buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
      throw new TypeError("Invalid MP3 input");
    }
    return `data:${type};base64,${buffer.toString("base64")}`;
  } finally {
    await handle.close();
  }
}

async function responseJson(response, maxBytes) {
  if (!response?.ok) throw new Error(`Voice API request failed (HTTP ${Number(response?.status) || "unknown"})`);
  if (!response.body?.getReader) throw new Error("Voice API response has no readable body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError("Voice API response is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new Error("Voice API returned invalid JSON");
  }
}

async function completion(body, settings, { fetchImpl, env, signal, maxResponseBytes }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), settings.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(new Error("Voice request cancelled or timed out"));
    requestSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (requestSignal.aborted) throw new Error("Voice request cancelled or timed out");
    return await Promise.race([cancelled, (async () => {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env[settings.apiKeyEnv].trim()}`
        },
        body: JSON.stringify(body),
        signal: requestSignal
      });
      return responseJson(response, maxResponseBytes);
    })()]);
  } catch (error) {
    if (requestSignal.aborted) throw new Error("Voice request cancelled or timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", onAbort);
  }
}

function requiredText(value, name, maxChars = 2500) {
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}

/** Transcribe a local MP3/WAV file; returns the recognized text. */
export async function transcribeAudioFile({ inputPath, language = "auto", config = {}, fetchImpl = globalThis.fetch, env = process.env, signal } = {}) {
  const settings = validateVoiceConfig(config, { env });
  if (!["auto", "zh", "en"].includes(language)) throw new TypeError("Invalid ASR language");
  const data = await readAudio(inputPath, settings.maxInputBytes);
  const result = await completion({
    model: ASR_MODEL,
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data } }] }],
    asr_options: { language }
  }, settings, { fetchImpl, env, signal, maxResponseBytes: 1024 * 1024 });
  const text = result?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Voice API returned no transcription");
  return text;
}

async function safeOutputPath(outputPath, outputDir) {
  if (!outputDir) throw new TypeError("An outputDir is required for speech synthesis");
  if (typeof outputPath !== "string" || !outputPath || extname(outputPath).toLowerCase() !== ".wav") {
    throw new TypeError("Output path must name a WAV file");
  }
  const requestedDirectory = resolve(outputDir);
  if (!(await lstat(requestedDirectory)).isDirectory()) {
    throw new Error("Output directory must be a real directory, not a symlink");
  }
  const target = isAbsolute(outputPath) ? resolve(outputPath) : resolve(requestedDirectory, outputPath);
  if (dirname(target) !== requestedDirectory || basename(target) !== basename(outputPath) || basename(target).startsWith(".")) {
    throw new Error("Output file must be directly inside outputDir");
  }
  return join(await realpath(requestedDirectory), basename(target));
}

function decodeAudio(data, maxBytes) {
  if (typeof data !== "string" || !data || data.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("Voice API returned invalid or oversized audio");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 12 || bytes.length > maxBytes || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Voice API returned invalid or oversized WAV audio");
  }
  return bytes;
}

/** Synthesize WAV speech into a new file directly under config.outputDir. Never overwrites. */
export async function synthesizeSpeechFile({
  text, outputPath, model = "mimo-v2.5-tts", voice = "mimo_default", voiceDescription,
  style, referenceAudioPath, consentToVoiceClone = false,
  config = {}, fetchImpl = globalThis.fetch, env = process.env, signal
} = {}) {
  const settings = validateVoiceConfig(config, { env });
  if (!TTS_MODELS.has(model)) throw new TypeError("Unsupported TTS model");
  const speech = requiredText(text, "text");
  const target = await safeOutputPath(outputPath, settings.outputDir);
  let userContent = style === undefined ? "" : requiredText(style, "style", 1000);
  const audio = { format: "wav" };
  if (model === "mimo-v2.5-tts") {
    if (voiceDescription !== undefined || referenceAudioPath !== undefined) throw new TypeError("Preset voice does not accept design or reference audio");
    audio.voice = requiredText(voice, "voice", 100);
  } else if (model === "mimo-v2.5-tts-voicedesign") {
    if (referenceAudioPath !== undefined || voice !== "mimo_default") throw new TypeError("Voice design does not accept preset or reference voice");
    userContent = requiredText(voiceDescription, "voiceDescription", 1000);
    if (style !== undefined) throw new TypeError("Voice design uses voiceDescription, not style");
  } else {
    if (consentToVoiceClone !== true) throw new Error("Explicit consentToVoiceClone: true is required");
    if (voiceDescription !== undefined || voice !== "mimo_default") throw new TypeError("Voice clone does not accept preset or designed voice");
    if (!referenceAudioPath) throw new TypeError("Voice clone requires referenceAudioPath");
    audio.voice = await readAudio(referenceAudioPath, settings.maxInputBytes);
  }
  const result = await completion({
    model,
    messages: [
      ...(userContent ? [{ role: "user", content: userContent }] : []),
      { role: "assistant", content: speech }
    ],
    audio
  }, settings, {
    fetchImpl, env, signal,
    maxResponseBytes: Math.ceil(settings.maxOutputBytes / 3) * 4 + 64 * 1024
  });
  const bytes = decodeAudio(result?.choices?.[0]?.message?.audio?.data, settings.maxOutputBytes);
  if (signal?.aborted) throw new Error("Voice request cancelled or timed out");
  const temporary = join(dirname(target), `.voice-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, target); // Atomic no-overwrite publish; partial WAVs remain hidden.
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { outputPath: target, bytes: bytes.length, model };
}
