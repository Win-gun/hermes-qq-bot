// A preset supplies defaults for an explicitly different mode. For the selected
// default mode, the saved form values are authoritative (including custom edits).
export function validateBehaviorPatch(patch = {}) {
  for (const [section, key, min, max] of [
    ["trigger", "activeProbability", 0, 1], ["trigger", "activeCooldownMs", 1000, 3600000],
    ["proactive", "probability", 0, 1], ["proactive", "intervalMs", 10000, 86400000],
    ["proactive", "cooldownMs", 10000, 86400000]
  ]) {
    if (!Object.hasOwn(patch?.[section] || {}, key)) continue;
    const value = patch[section][key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max
      || (key.endsWith("Ms") && !Number.isSafeInteger(value)))
      throw new Error(`${section}.${key} 必须为 ${min}–${max} ${key.endsWith("Ms") ? "范围内的整数毫秒" : "范围内的概率（不是百分数）"}`);
  }
  if (patch.proactive?.enabled !== undefined && typeof patch.proactive.enabled !== "boolean") throw new Error("proactive.enabled 必须为开关");
  if (patch.behaviorModes?.default !== undefined && !["restrained", "normal", "lively"].includes(patch.behaviorModes.default)) throw new Error("活跃度模式无效");
}

export function normalizeBehaviorSelection(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["lively", "active", "chatty", "hot", "活泼", "活跃", "热闹", "话多", "积极"].includes(raw)) return "lively";
  if (["normal", "default", "balanced", "standard", "正常", "普通", "默认", "平衡"].includes(raw)) return "normal";
  if (["restrained", "quiet", "calm", "reserved", "克制", "保守", "少说", "安静", "更克制"].includes(raw)) return "restrained";
  return "";
}

export function projectBehaviorSettings(config = {}, mode = "normal") {
  mode = normalizeBehaviorSelection(mode) || "normal";
  const preset = config.behaviorModes?.presets?.[mode] || {};
  const savedMode = normalizeBehaviorSelection(config.behaviorModes?.default) || "normal";
  const next = { ...config, __behaviorMode: mode };
  for (const key of ["trigger", "discussionParticipation", "proactive", "reply", "implicitReply", "socialPlanner"]) {
    next[key] = mode === savedMode
      ? { ...(preset[key] || {}), ...(config[key] || {}) }
      : { ...(config[key] || {}), ...(preset[key] || {}) };
  }
  return next;
}
