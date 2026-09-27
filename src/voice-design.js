const TRAITS = new Set([
  "年轻", "成熟", "中性", "男声", "女声", "低沉", "清亮", "柔和", "温暖",
  "沙哑", "活泼", "沉稳", "轻快", "缓慢", "播音", "甜美"
]);

/** Bounded original-voice design, never a free-form request to imitate a person. */
export function parseMemberVoiceDesign(input) {
  if (typeof input !== "string") throw new TypeError("Voice design command must be text");
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error("Invalid speech text");
  const match = input.match(/^design\s+([^|｜]{1,80})\s*[|｜]\s*(.{1,160})$/is);
  if (!match) throw new Error("Use: /voice design 年轻 清亮 活泼 | 要说的话");
  const traits = [...new Set(match[1].trim().split(/[\s,，、]+/).filter(Boolean))];
  if (traits.length < 2 || traits.length > 4 || traits.some((item) => !TRAITS.has(item))) {
    throw new Error(`Choose 2–4 original voice traits: ${[...TRAITS].join("、")}`);
  }
  const speech = match[2].trim();
  if (!speech || /[\x00-\x1f\x7f]/.test(match[2])) throw new Error("Invalid speech text");
  return {
    speech,
    voiceDescription: `请设计原创中文音色，不模仿任何真实人物：${traits.join("、")}。语音自然、清楚。`,
    traits
  };
}
