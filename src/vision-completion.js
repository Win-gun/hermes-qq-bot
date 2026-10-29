import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { normalizeModelUsage } from "./operational-ledger.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 262144;
class VisionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    if (code === "VISION_ABORTED") this.name = "AbortError";
  }
}
const fail = code => { throw new VisionError(code); };
const nonempty = value => typeof value === "string" && Boolean(value.trim());
const validSelection = (value, kind) => value?.profile?.kind === kind
  && nonempty(value.profile.id) && nonempty(value.profile.model) && nonempty(value.connection?.id)
  && nonempty(value.connection.provider) && value.profile.connectionId === value.connection.id;

function endpointFor(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { fail("VISION_ENDPOINT_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
    fail("VISION_ENDPOINT_INVALID");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return url.href;
}

/** Inputs are metadata-only resolveApiCapability() snapshots for ONE account.
 * Capability evidence must come from trusted host configuration/provider metadata,
 * never model prose or a model-name heuristic. It is deliberately NOT a new
 * config field: API Center v1 cannot yet persist this evidence. The host must
 * invalidate it on binding/config/identity changes and abort active work.
 * preferChat:false pins independent vision tests/background consumers.
 */
export function selectVisionRoute({ accountId, chat, vision, capability, preferChat = true } = {}) {
  if (typeof accountId !== "string" || typeof preferChat !== "boolean") fail("VISION_ROUTE_INVALID");
  const matches = validSelection(chat, "chat")
    && ["administrator", "provider-metadata"].includes(capability?.source)
    && capability.accountId === accountId && capability.profileId === chat.profile.id
    && capability.connectionId === chat.connection.id && capability.provider === chat.connection.provider
    && capability.model === chat.profile.model && capability.baseUrl === chat.connection.baseUrl
    && capability.transport === "chat-completions" && typeof capability.supportsImages === "boolean";
  let reason = !preferChat ? "VISION_BINDING_PINNED" : matches
    ? capability.supportsImages ? "CHAT_IMAGES_CONFIRMED" : "CHAT_IMAGES_UNSUPPORTED"
    : "CHAT_IMAGES_UNKNOWN";
  if (preferChat && matches && capability.supportsImages) {
    // A CLI/provider name is not evidence of a compatible HTTP endpoint.
    try { endpointFor(chat.connection.baseUrl); }
    catch { reason = "CHAT_IMAGE_TRANSPORT_UNAVAILABLE"; }
    if (reason === "CHAT_IMAGES_CONFIRMED") return { kind: "chat", reason, selection: structuredClone(chat) };
  }
  if (!validSelection(vision, "vision")) fail("VISION_FALLBACK_UNAVAILABLE");
  return { kind: "vision", reason, selection: structuredClone(vision) };
}

// Sniff bytes, not extensions (the sticker pipeline uses an extensionless file).
// This is container identification, not a full image decoder. Corrupt images
// with a valid header may still be explicitly rejected by the provider.
function imageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  fail("VISION_IMAGE_FORMAT_UNSUPPORTED");
}

async function imageDataUrl(imagePath, maxBytes, check) {
  if (typeof imagePath !== "string" || !path.isAbsolute(imagePath)) fail("VISION_IMAGE_UNREADABLE");
  let handle;
  try {
    // Do not follow a swapped symlink or hang on a FIFO. Paths still require a
    // trusted download/cache resolver; this helper grants no filesystem access.
    handle = await open(imagePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    check();
    const stat = await handle.stat();
    check();
    if (!stat.isFile() || stat.size === 0) fail("VISION_IMAGE_UNREADABLE");
    if (stat.size > maxBytes) fail("VISION_IMAGE_TOO_LARGE");
    // Bounded even when a file grows after stat(). Never silently truncate it.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      check();
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) fail("VISION_IMAGE_TOO_LARGE");
    if (size !== stat.size) fail("VISION_IMAGE_CHANGED");
    const data = bytes.subarray(0, size);
    return `data:${imageMime(data)};base64,${data.toString("base64")}`;
  } catch (error) {
    if (error instanceof VisionError) throw error;
    fail("VISION_IMAGE_UNREADABLE");
  } finally { await handle?.close(); }
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

async function responseData(response, wait, check) {
  if (!response?.body?.getReader) fail("VISION_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await wait(reader.read());
      check();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) fail("VISION_OUTPUT_LIMIT");
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("VISION_RESPONSE_INVALID"); }
}

// Same metadata contract as text-completion: real HTTP JSON usage only, and
// only a sanitized provider-reported model identifier. Never infer from prose,
// requested model, image size or an unrecognized token-count field.
function responseMetadata(data, apiKey, prompt) {
  const reported = data?.model;
  const model = typeof reported === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,159}$/.test(reported)
    && !reported.includes("://") && !/^(?:sk-|Bearer|password|secret|cookie|authorization|api[_-]?key)/i.test(reported)
    && !reported.includes(apiKey) && !reported.includes(prompt) ? reported : null;
  return { usage: normalizeModelUsage(data?.usage), model, provider: "openai-compatible" };
}

function answerText(data) {
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === "length") fail("VISION_OUTPUT_TRUNCATED");
  if (choice?.message?.tool_calls?.length || choice?.message?.function_call) fail("VISION_TOOL_CALL_REFUSED");
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("") : "";
  if (!text.trim()) fail("VISION_EMPTY_RESPONSE");
  return text;
}

/** Single image, single attempt, no native tools, redirects, retries or runtime
 * model switching. Unknown/unsupported chat capability selects the independent
 * vision binding BEFORE any call; request failures never trigger another call.
 * fallback adapts the existing CLI, uses the supplied selection/signal and must
 * remain one bounded attempt. No credentials are resolved or persisted here.
 * isCurrent must cover account/logical identity, config and conversation scope;
 * it is required, including for background calls. A stale result is discarded.
 * Callers must also recheck their ordinary quiet/identity/send gate at delivery.
 * Returns {text,route,reason,usage,model,provider}. CLI usage is unknown (all
 * normalized fields null), model/provider null; HTTP metadata follows
 * text-completion.js. Safe HTTP errors retain .metadata, including real usage
 * reported with non-2xx, empty/truncated/tool-call responses. No raw bodies.
 */
export async function runVisionImage({ accountId, chat, vision, capability, preferChat = true,
  prompt, imagePath, apiKey, fallback, isCurrent, signal, timeoutMs = 120000,
  maxImageBytes = 6 * 1024 * 1024, fetchImpl = fetch } = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || typeof isCurrent !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000
    || !Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > MAX_IMAGE_BYTES)
    fail("VISION_ARGUMENTS_INVALID");
  const route = selectVisionRoute({ accountId, chat, vision, capability, preferChat });
  const controller = new AbortController();
  let interruption;
  const check = () => {
    if (interruption) throw interruption;
    if (signal?.aborted) fail("VISION_ABORTED");
    let current = false;
    try { current = isCurrent() === true; } catch {}
    if (!current) fail("VISION_IDENTITY_STALE");
  };
  check();
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = code => {
    if (interruption) return;
    interruption = new VisionError(code);
    controller.abort();
    rejectAbort(interruption);
  };
  const abort = () => stop("VISION_ABORTED");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("VISION_TIMEOUT"), timeoutMs);
  const wait = promise => Promise.race([promise, interrupted]);
  let metadata;
  try {
    if (signal?.aborted) abort();
    const dataUrl = await wait(imageDataUrl(imagePath, maxImageBytes, check));
    check();
    let text;
    if (route.kind === "vision") {
      if (typeof fallback !== "function") fail("VISION_FALLBACK_UNAVAILABLE");
      text = await wait(fallback({ prompt, imagePath, selection: route.selection, signal: controller.signal, isCurrent }));
      check();
      if (typeof text !== "string" || !text.trim()) fail("VISION_EMPTY_RESPONSE");
      if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) fail("VISION_OUTPUT_LIMIT");
    } else {
      if (typeof apiKey !== "string" || !apiKey || typeof fetchImpl !== "function") fail("VISION_CREDENTIAL_UNAVAILABLE");
      const payload = { model: route.selection.profile.model, messages: [{ role: "user", content: [
        { type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }
      ] }] };
      check();
      const response = await wait(Promise.resolve(fetchImpl(endpointFor(route.selection.connection.baseUrl), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload), signal: controller.signal, redirect: "manual"
      })).then(response => {
        if (controller.signal.aborted) cancelBody(response);
        return response;
      }));
      try {
        check();
        if (!Number.isInteger(response?.status)) fail("VISION_RESPONSE_INVALID");
        if (response.status >= 300 && response.status < 400) fail("VISION_REDIRECT_REFUSED");
        if (response.status < 200 || response.status >= 300) {
          // As in completeText(), even HTTP failures can report billable usage.
          // Inspect only bounded JSON; preserve the safe failure on bad bodies.
          try {
            metadata = { ...responseMetadata(await responseData(response, wait, check), apiKey, prompt), httpStatus: response.status };
          } catch {}
          fail("VISION_REQUEST_FAILED");
        }
        const data = await responseData(response, wait, check);
        metadata = { ...responseMetadata(data, apiKey, prompt), httpStatus: response.status };
        text = answerText(data);
      } finally { cancelBody(response); }
    }
    check();
    return { text, route: route.kind, reason: route.reason,
      usage: metadata?.usage ?? normalizeModelUsage(undefined), model: metadata?.model ?? null, provider: metadata?.provider ?? null };
  } catch (error) {
    // Do not propagate local paths, upstream response bodies, URLs, credentials
    // or arbitrary exception metadata/cause (including from the CLI adapter).
    let safeError;
    try { check(); } catch (guardError) { safeError = guardError; }
    safeError ||= error instanceof VisionError ? error : new VisionError("VISION_REQUEST_FAILED");
    if (metadata) safeError.metadata = metadata;
    throw safeError;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
