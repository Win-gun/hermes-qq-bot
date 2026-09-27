// A Hermes tool may return a MEDIA: local artifact path. It is not a OneBot
// attachment and must never be exposed as plain QQ chat text.
export function sanitizeChatReply(text) {
  return String(text || "")
    .replace(/MEDIA:\s*(?:file:\/\/)?\/(?:Users|home|var|tmp)\/[^\r\n]*/giu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
