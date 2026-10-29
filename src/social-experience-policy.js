// Account-owned opt-in policy. No IO, model calls, persistent read defaults or
// authority inferred from model output. Failover policies use accountPolicy.
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const defaults = {
  enabled: false, shadowMode: true, conversationIds: [], behaviorPreset: "existing",
  turn: { enabled: true, minWaitMs: 150, maxWaitMs: 4500, ordinaryWaitMs: 700, incompleteWaitMs: 2500, maxTurnMs: 8000 },
  expression: { enabled: true, maxMessages: 2, minIntervalMs: 200, maxIntervalMs: 800, allowQuotes: true },
  stickers: { enabled: false, autoSend: false, visionLearning: false, groupLearning: false,
    autonomousEligibility: false, autonomousSelection: false, webSearch: false, maxDailySearches: 12,
    interactionEnabled: false, maxDailyVisionCalls: 8, maxDailyDownloads: 16, cooldownMs: 60000 },
  reactions: { enabled: false, cooldownMs: 60000, maxDaily: 30, emojiIds: ["76"] },
  language: { enabled: false, autoCandidates: true, implicitLearning: false },
  interestWatch: { enabled: false, maxDurationMs: 300000, maxActive: 4 },
  style: { enabled: false },
  pokes: { enabled: false, cooldownMs: 300000, maxDaily: 5 },
  mentions: { enabled: false },
  forwardRead: { enabled: false }
};

export function validateSocialExperiencePolicy(value = {}) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new Error("社交表达策略字段无效");
  const result = structuredClone(defaults);
  if (value.behaviorPreset !== undefined && !["existing", "observant", "balanced", "engaged"].includes(value.behaviorPreset))
    throw new Error("社交行为预设无效");
  if (value.behaviorPreset === undefined) delete result.behaviorPreset;
  else result.behaviorPreset = value.behaviorPreset;
  for (const key of ["enabled", "shadowMode"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${key} 必须是开关`);
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (value.conversationIds !== undefined) {
    if (!Array.isArray(value.conversationIds) || value.conversationIds.length > 128
      || value.conversationIds.some(id => typeof id !== "string" || !/^(group|private):[1-9]\d{0,19}$/.test(id))) throw new Error("社交表达必须限定规范会话范围");
    result.conversationIds = [...new Set(value.conversationIds)];
  }
  for (const section of ["turn", "expression", "stickers", "reactions", "language", "interestWatch", "style", "pokes", "mentions", "forwardRead"]) {
    if (value[section] === undefined) continue;
    if (!plain(value[section]) || Object.keys(value[section]).some(key => !Object.hasOwn(defaults[section], key))) throw new Error("社交表达高级字段无效");
    for (const [key, entry] of Object.entries(value[section])) {
      if (section === "reactions" && key === "emojiIds") {
        if (!Array.isArray(entry) || entry.length > 3 || entry.some(id => typeof id !== "string" || !/^[1-9]\d{0,5}$/.test(id)))
          throw new Error("消息回应表情须为至多三个 QQ 表情编号");
        result.reactions.emojiIds = [...new Set(entry)];
        continue;
      }
      if (typeof defaults[section][key] === "boolean") {
        if (typeof entry !== "boolean") throw new Error(`${key} 必须是开关`);
      } else if (!Number.isSafeInteger(entry) || entry < (key === "maxDurationMs" ? 1000 : ["maxMessages", "maxTurnMs", "maxActive"].includes(key) ? 1 : 0)
        || entry > (key === "maxMessages" || key === "maxActive" ? 4 : key === "maxDurationMs" ? 600000 : key === "maxTurnMs" ? 15000
            : ["maxDailyVisionCalls", "maxDailyDownloads", "maxDailySearches"].includes(key) ? 100 : key === "maxDaily" ? 200
            : key === "cooldownMs" ? 86400000 : 6000)) throw new Error(`${key} 超出有效范围`);
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
