// Incoming OneBot record payloads may be an already-converted file, base64,
// or a short-lived QQ media URL whose path has no file extension.
export function trustedQqAudioUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname.toLowerCase();
  return ["qq.com", "qq.com.cn", "gtimg.com", "gtimg.cn", "qpic.cn"]
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function decodeOneBotAudioBase64(value, maxBytes) {
  if (typeof value !== "string") return null;
  const raw = value.startsWith("base64://") ? value.slice(9)
    : value.startsWith("data:audio/") ? value.slice(value.indexOf(",") + 1) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length > Math.ceil(maxBytes * 4 / 3) + 4) return null;
  const buffer = Buffer.from(raw, "base64");
  return buffer.length >= 4 && buffer.length <= maxBytes ? buffer : null;
}

export function audioFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return "mp3";
  if (buffer.toString("ascii", 0, 5) === "#!AMR") return "amr";
  if (buffer.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (buffer.toString("ascii", 0, 16).includes("#!SILK_V3")) return "silk";
  return "";
}
