export const WORK_CAPABILITIES = Object.freeze(["public_web", "isolated_browser", "authenticated_browser", "isolated_files", "local_read", "local_write", "code", "desktop_observe", "desktop_input", "app", "external_write"]);
export const SOCIAL_PRESET_IDS = Object.freeze(["existing", "observant", "balanced", "engaged"]);
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const invalid = () => { throw new TypeError("数字生命配置无效，请检查开关、后端、能力及预算"); };

/** Account-owned policy. A setting is never an execution grant or proof that a
 * backend is installed, verified, or allowed to access the physical desktop. */
export function digitalLifePolicy(input = {}) {
  if (!plain(input) || Object.keys(input).some(k => !["enabled", "socialPreset", "work"].includes(k))) invalid();
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") invalid();
  if (input.socialPreset !== undefined && !SOCIAL_PRESET_IDS.includes(input.socialPreset)) invalid();
  const work = input.work ?? {};
  if (!plain(work) || Object.keys(work).some(k => !["enabled", "backendId", "capabilities", "maxActions"].includes(k))) invalid();
  if (work.enabled !== undefined && typeof work.enabled !== "boolean") invalid();
  if (work.backendId !== undefined && (typeof work.backendId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(work.backendId))) invalid();
  if (work.capabilities !== undefined && (!Array.isArray(work.capabilities) || work.capabilities.some(x => !WORK_CAPABILITIES.includes(x)) || new Set(work.capabilities).size !== work.capabilities.length)) invalid();
  if (work.maxActions !== undefined && (!Number.isInteger(work.maxActions) || work.maxActions < 1 || work.maxActions > 32)) invalid();
  return { enabled: input.enabled === true, socialPreset: input.socialPreset || "existing", work: {
    enabled: work.enabled === true, backendId: work.backendId || "local", capabilities: [...(work.capabilities || [])], maxActions: work.maxActions ?? 12
  } };
}
