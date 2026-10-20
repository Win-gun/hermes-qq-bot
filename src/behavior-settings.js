// A preset supplies defaults for an explicitly different mode. For the selected
// default mode, the saved form values are authoritative (including custom edits).
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
