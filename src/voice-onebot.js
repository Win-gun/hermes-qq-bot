import { isIP } from "node:net";

// Pure OneBot v11 record helpers. No fetch, filesystem access, or protocol calls.
// For local/opaque protocol file values, isVerifiedProtocolFile must attest the exact
// value came from a trusted protocol response; never use an unconditional true callback.
const MAX_URL_LENGTH = 2048;
const MAX_FILE_LENGTH = 1024;
const MAX_RECORDS = 16;
const MAX_QUOTES = 8;
const REPLY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CQ_SEGMENT = /\[CQ:(record|audio|reply),([^\]]*)\]/g;
const FORBIDDEN_INPUT = /[\s\\\x00-\x1f\x7f]/;

function publicIPv4(host) {
  const [a, b, c] = host.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicHttpUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH || FORBIDDEN_INPUT.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.port) return false;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const ipType = isIP(host);
  if (ipType === 4) return publicIPv4(host);
  // Conservatively reject every IPv6 literal, including mapped IPv4 and scoped forms.
  if (ipType === 6 || host.includes(":")) return false;
  if (!host.includes(".") || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  const suffix = labels.at(-1);
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/.test(suffix)) return false;
  if (["localhost", "local", "lan", "home", "internal", "intranet", "test", "example", "invalid", "arpa", "onion"].includes(suffix)) return false;
  if (["com", "net", "org"].includes(suffix) && labels.at(-2) === "example") return false;
  return true;
}

function safeFile(value, context, isVerifiedProtocolFile) {
  if (typeof value !== "string" || !value || value.length > MAX_FILE_LENGTH || /[\x00-\x1f\x7f]/.test(value)) return "";
  if (isPublicHttpUrl(value)) return value;
  // A malformed/private URL must not be reclassified as a trusted protocol file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes("..") || value.includes("\u0000")) return "";
  if (typeof isVerifiedProtocolFile !== "function") return "";
  try { return isVerifiedProtocolFile(value, context) === true ? value : ""; } catch { return ""; }
}

function decodeCqValue(value) {
  // One pass, with &amp; last: double-encoded delimiters must not become syntax.
  return value.replace(/&#44;/g, ",").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&");
}

function parseCqParams(raw) {
  const data = Object.create(null);
  for (const part of raw.split(",")) {
    const split = part.indexOf("=");
    if (split <= 0) continue;
    const key = part.slice(0, split).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(key) || Object.hasOwn(data, key)) return null;
    data[key] = decodeCqValue(part.slice(split + 1));
  }
  return data;
}

function segments(message) {
  if (typeof message === "string") {
    const result = [];
    for (const match of message.matchAll(CQ_SEGMENT)) {
      const data = parseCqParams(match[2]);
      if (data) result.push({ type: match[1], data });
    }
    return result;
  }
  if (Array.isArray(message)) return message.filter((segment) => segment && typeof segment === "object");
  return [];
}

function replyIds(message) {
  const ids = [];
  for (const segment of segments(message)) {
    if (segment.type !== "reply") continue;
    const candidate = segment.data?.id ?? segment.data?.message_id ?? segment.data?.messageId;
    const id = typeof candidate === "number" && Number.isSafeInteger(candidate) ? String(candidate) : candidate;
    if (typeof id === "string" && REPLY_ID.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_QUOTES) break;
  }
  return ids;
}

function quotePayload(quote) {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return null;
  const rawId = quote.message_id ?? quote.messageId ?? quote.id;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  if (typeof id !== "string" || !REPLY_ID.test(id)) return null;
  const message = quote.message ?? quote.raw_message ?? quote.message_body;
  if (typeof message !== "string" && !Array.isArray(message)) return null;
  const senderId = quote.senderId ?? quote.sender?.user_id ?? quote.user_id;
  return { id, message, senderId: senderId == null ? "" : String(senderId) };
}

function recordRefs(message, source, messageId, senderId, isVerifiedProtocolFile, remaining) {
  const refs = [];
  for (const segment of segments(message)) {
    if (refs.length >= remaining) break;
    if (segment.type !== "record" && segment.type !== "audio") continue;
    const data = segment.data;
    if (!data || typeof data !== "object") continue;
    const context = { source, messageId, direction: "incoming" };
    const file = safeFile(data.file, context, isVerifiedProtocolFile);
    const url = isPublicHttpUrl(data.url) ? data.url : "";
    if (file || url) refs.push({
      file,
      url: url || (isPublicHttpUrl(file) ? file : ""),
      source,
      ...(source === "quoted" ? { messageId, senderId } : {})
    });
  }
  return refs;
}

// quotedMessages must be caller-resolved get_msg responses with IDs matching reply
// segments in message. No recursive quote traversal or network access occurs here.
export function extractRecordRefs(message, { quotedMessages = [], isVerifiedProtocolFile } = {}) {
  const refs = recordRefs(message, "current", "", "", isVerifiedProtocolFile, MAX_RECORDS);
  if (!Array.isArray(quotedMessages) || !quotedMessages.length || refs.length >= MAX_RECORDS) return refs;
  const requestedIds = new Set(replyIds(message));
  if (!requestedIds.size) return refs;
  const seen = new Set();
  for (const rawQuote of quotedMessages.slice(0, MAX_QUOTES)) {
    const quote = quotePayload(rawQuote);
    if (!quote || !requestedIds.has(quote.id) || seen.has(quote.id)) continue;
    seen.add(quote.id);
    refs.push(...recordRefs(quote.message, "quoted", quote.id, quote.senderId, isVerifiedProtocolFile, MAX_RECORDS - refs.length));
    if (refs.length >= MAX_RECORDS) break;
  }
  return refs;
}

export function buildRecordMessage(fileOrUrl, { isVerifiedProtocolFile } = {}) {
  if (Buffer.isBuffer(fileOrUrl)) {
    if (fileOrUrl.length < 12 || fileOrUrl.length > 10 * 1024 * 1024
      || fileOrUrl.toString("ascii", 0, 4) !== "RIFF" || fileOrUrl.toString("ascii", 8, 12) !== "WAVE") {
      throw new TypeError("outgoing audio must be a bounded WAV buffer");
    }
    return { type: "record", data: { file: `base64://${fileOrUrl.toString("base64")}` } };
  }
  const file = safeFile(fileOrUrl, { source: "outgoing", messageId: "", direction: "outgoing" }, isVerifiedProtocolFile);
  if (!file) throw new TypeError("record file must be a public http(s) URL or a caller-verified protocol file");
  return { type: "record", data: { file } };
}
