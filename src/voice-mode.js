export const VOICE_REPLY_MODES = Object.freeze(["off", "mixed", "force"]);

export function normalizeVoiceReplyMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["off", "关闭", "关"].includes(text)) return "off";
  if (["mixed", "mix", "混合", "自动"].includes(text)) return "mixed";
  if (["force", "forced", "强制", "全语音"].includes(text)) return "force";
  return "";
}

export function voiceReplyMode(settings = {}, voice = {}) {
  return normalizeVoiceReplyMode(settings.voiceReplyMode)
    || normalizeVoiceReplyMode(voice.replyMode)
    || "mixed";
}

// Explicit requests are handled by the existing /voice path. In mixed mode,
// ordinary replies mirror an incoming voice only when the reply is short.
export function shouldSendVoiceReply({ mode, incomingVoice = false, direct = false, text = "", enabled = true } = {}) {
  if (!enabled || mode === "off" || !String(text || "").trim()) return false;
  if (mode === "force") return true;
  return mode === "mixed" && incomingVoice && direct && String(text).length <= 350;
}
