// Account-owned opt-in policy. No IO, model calls, persistent read defaults or
// authority inferred from model output. Failover policies use accountPolicy.
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const defaults = {
  enabled: false, shadowMode: true, conversationIds: [],
  turn: { enabled: true, minWaitMs: 150, maxWaitMs: 4500, ordinaryWaitMs: 700, incompleteWaitMs: 2500, maxTurnMs: 8000 },
  expression: { enabled: true, maxMessages: 2, minIntervalMs: 200, maxIntervalMs: 800, allowQuotes: true },
  stickers: { enabled: false, autoSend: false, visionLearning: false, maxDailyVisionCalls: 8, cooldownMs: 60000 },
  language: { enabled: false, autoCandidates: true }
};

export function validateSocialExperiencePolicy(value = {}) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new Error("社交表达策略字段无效");
  const result = structuredClone(defaults);
  for (const key of ["enabled", "shadowMode"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${key} 必须是开关`);
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (value.conversationIds !== undefined) {
    if (!Array.isArray(value.conversationIds) || value.conversationIds.length > 128
      || value.conversationIds.some(id => typeof id !== "string" || !/^(group|private):[1-9]\d{0,19}$/.test(id))) throw new Error("社交表达必须限定规范会话范围");
    result.conversationIds = [...new Set(value.conversationIds)];
  }
  for (const section of ["turn", "expression", "stickers", "language"]) {
    if (value[section] === undefined) continue;
    if (!plain(value[section]) || Object.keys(value[section]).some(key => !Object.hasOwn(defaults[section], key))) throw new Error("社交表达高级字段无效");
    for (const [key, entry] of Object.entries(value[section])) {
      if (typeof defaults[section][key] === "boolean") {
        if (typeof entry !== "boolean") throw new Error(`${key} 必须是开关`);
      } else if (!Number.isSafeInteger(entry) || entry < (["maxMessages", "maxTurnMs"].includes(key) ? 1 : 0)
        || entry > (key === "maxMessages" ? 4 : key === "maxTurnMs" ? 15000
          : key === "maxDailyVisionCalls" ? 100 : key === "cooldownMs" ? 86400000 : 6000)) throw new Error(`${key} 超出有效范围`);
      result[section][key] = entry;
    }
  }
  if (result.turn.minWaitMs > result.turn.maxWaitMs || result.turn.maxWaitMs > result.turn.maxTurnMs
    || [result.turn.ordinaryWaitMs, result.turn.incompleteWaitMs].some(ms => ms < result.turn.minWaitMs || ms > result.turn.maxWaitMs)
    || result.expression.minIntervalMs > result.expression.maxIntervalMs) throw new Error("等待或分条间隔上下限矛盾");
  return result;
}

export function socialExperienceFor(config = {}, conversationId = "") {
  // Do not repair a malformed saved policy by accidentally enabling anything.
  let policy;
  try { policy = validateSocialExperiencePolicy(config.socialExperience || {}); }
  catch { return { ...structuredClone(defaults), errorCode: "EXPRESSION_POLICY_INVALID", active: false }; }
  const raw = String(conversationId);
  const canonical = raw.startsWith("private:") ? raw.match(/^private:[1-9]\d{0,19}(?=:|$)/)?.[0]
    : raw.startsWith("group:") ? raw : /^[1-9]\d{0,19}$/.test(raw) ? `group:${raw}` : "";
  return { ...policy, active: policy.enabled && policy.conversationIds.includes(canonical || "") };
}
