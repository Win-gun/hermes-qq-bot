import { listDiscoveryItems, validateDiscoveryPolicy } from "./social-discovery-state.js";
import { isQzoneSafeText } from "./qzone-policy.js";

// Pure candidate projection, NOT a draft writer, administrator, source proof or
// publication grant. The host must re-resolve the source at create/review/wire
// time and retain all existing QZone gates and fingerprint deduplication.
const DAY = 86_400_000;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const record = value => plain(value) && Reflect.ownKeys(value).every(key => typeof key === "string"
  && !["__proto__", "constructor", "prototype"].includes(key)
  && Object.getOwnPropertyDescriptor(value, key).enumerable
  && own(Object.getOwnPropertyDescriptor(value, key), "value"));
const reasons = Object.freeze({ interest: "公开发现：兴趣相关的资料摘要候选",
  new_perspective: "公开发现：供参考的新视角摘要候选", useful_public: "公开发现：有用公开资料摘要候选" });
const fail = code => ({ ok: false, code });
const normalize = value => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
// Conservative rejection, not a complete privacy classifier or prompt-injection
// proof. Never salvage a safe prefix from hostile/private-looking material.
const unsafe = /[\p{Cc}\p{Cf}]|\[CQ:|(?:www\.|ftp:|javascript:|data:)|(?:ignore|disregard).{0,30}(?:instructions?|prompts?)|system\s*prompt|developer\s*message|(?:call|invoke|execute)\s+(?:a\s+)?(?:tool|command)|\b(?:private|confidential|password|secret|token|cookie|credential)\b|忽略.{0,12}(?:指令|提示)|系统提示|开发者消息|调用工具|执行命令|你必须|你是管理员|自动发布|发送消息|私聊|私信|私密|群聊|聊天记录|群友|联系人|好友|昵称|QQ号|微信|住址|手机号|邮箱|内部资料|内幕|memberImpression|(?:我|我们|本人|俺)|\b(?:I|we|my|our)\b/iu;
function publicText(value, max, empty = false) {
  return typeof value === "string" && value.isWellFormed() && value.length <= max
    && (empty && value === "" || isQzoneSafeText(value, max))
    && (empty && value === "" || isQzoneSafeText(value.normalize("NFKC"), max))
    && !unsafe.test(value.normalize("NFKC"));
}
function publicSource(source, now) {
  if (!record(source) || Object.keys(source).some(key => !["url", "title", "publishedAt"].includes(key))
    || !publicText(source.title ?? "", 180, true)
    || typeof source.url !== "string" || source.url.length > 2048
    || /[\p{Cc}\p{Cf}]/u.test(source.url)) return false;
  if (source.publishedAt !== undefined && (!Number.isSafeInteger(source.publishedAt)
    || source.publishedAt <= 0 || source.publishedAt > now)) return false;
  try {
    const url = new URL(source.url);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".")
      && !/^(?:\d+\.){3}\d+$/.test(url.hostname) && !url.hostname.startsWith("[")
      && !/(?:^|\.)(?:localhost|local|internal|lan|home|invalid)$/i.test(url.hostname)
      && !/(?:^|\.)(?:qzone\.qq\.com|qun\.qq\.com|wx\.qq\.com)$/i.test(url.hostname)
      && ![...url.searchParams.keys()].some(key => /token|secret|password|signature|auth|key/i.test(key));
  } catch { return false; }
}
// Bound by UTF-16 length (the existing QZone contract), without splitting an
// emoji/surrogate pair. Validate the entire original material before truncation.
function bounded(value, max) {
  if (value.length <= max) return value;
  let result = "";
  for (const point of value) { if (result.length + point.length > max - 1) break; result += point; }
  return `${result}…`;
}

/** root is the host's latest memory root, never caller/model supplied material.
 * audience is deliberately fixed to 64; omitted means 64, never a wider default.
 * Returns a detached createDraft input. Does not read chat/preferences/member
 * state, acknowledge discovery usage, reserve budgets, approve or publish.
 */
export function buildAgencyQzoneCandidate(root, args = {}) {
  if (!record(args) || Reflect.ownKeys(args).some(key => !["logicalId", "conversationId", "materialId", "motive", "now", "audience"].includes(key))
    || !["logicalId", "conversationId", "materialId", "motive", "now"].every(key => own(args, key))
    || typeof args.logicalId !== "string" || !/^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.logicalId)
    || Object.getOwnPropertyNames(Object.prototype).includes(args.logicalId.split(":")[1]) || args.logicalId.endsWith(":prototype")
    || typeof args.conversationId !== "string" || !/^group:[1-9]\d{0,19}$/.test(args.conversationId)
    || typeof args.materialId !== "string" || !/^[A-Za-z0-9:_-]{1,96}$/.test(args.materialId)
    || ["__proto__", "constructor", "prototype"].includes(args.materialId)
    || typeof args.motive !== "string" || !own(reasons, args.motive)
    || !Number.isSafeInteger(args.now) || args.now <= 0 || args.now > 8_640_000_000_000_000 - 31 * DAY
    || own(args, "audience") && args.audience !== 64) return fail("AGENCY_QZONE_INVALID_ARGS");
  try {
    // Own data properties only: another account, inherited namespace or an
    // absent default must never become the requested material's authority.
    if (!record(root) || !own(root, "socialAgents")) return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE");
    const social = root.socialAgents;
    if (!record(social) || social.version !== 1 || !record(social.bots) || !own(social.bots, args.logicalId))
      return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE");
    const bot = social.bots[args.logicalId];
    if (!record(bot) || !own(bot, "discovery") || !record(bot.discovery)) return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE");
    const state = bot.discovery;
    if (!record(state.policy)) return fail("AGENCY_QZONE_POLICY");
    const policy = validateDiscoveryPolicy(state.policy);
    if (!policy.ok || !policy.policy.enabled || policy.policy.shadowMode
      || !policy.policy.conversationIds.includes(args.conversationId)) return fail("AGENCY_QZONE_POLICY");
    const items = listDiscoveryItems(root, { logicalId: args.logicalId, conversationId: args.conversationId,
      id: args.materialId, now: args.now, includeInactive: false });
    if (items.length !== 1 || !Array.isArray(state.items)
      || state.items.filter(item => item.id === args.materialId).length !== 1) return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE");
    const item = items[0];
    // Accept only the existing public-discovery schema. New privacy/correction
    // annotations must be consciously integrated, never silently ignored.
    if (!record(item) || Object.keys(item).some(key => !["id", "eventKey", "kind", "title", "meaning", "applicable", "avoid",
      "sources", "confidence", "status", "expiresAt", "collectedAt", "isTrending", "uncertainty", "verification"].includes(key))
      || item.status !== "active" || item.expiresAt <= args.now || item.collectedAt > args.now
      || item.confidence < 0.6 || item.confidence > 1
      || ![undefined, "unverified", "verified"].includes(item.verification)) return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE");
    // listDiscoveryItems is an admin inventory: unlike retrieval it does NOT
    // apply topicAllowed, so explicitly enforce the real owner's current bans.
    const topic = normalize([item.title, item.meaning, item.applicable, item.avoid].join(" "));
    if (policy.policy.blockedTopics.some(value => topic.includes(normalize(value)))) return fail("AGENCY_QZONE_BLOCKED_TOPIC");
    if (!publicText(item.title, 180) || !publicText(item.meaning, 800, true)
      || !Array.isArray(item.sources) || !item.sources.length || item.sources.some(source => !publicSource(source, args.now)))
      return fail("AGENCY_QZONE_UNSAFE_MATERIAL");
    const content = bounded(`公开资料摘要（未核实）：${item.title.trim()}${item.meaning.trim() ? `｜${item.meaning.trim()}` : ""}`, 280);
    // NFKC expands the ellipsis into three dots; the wire content, not that
    // validation-only projection, is subject to the 280-code-unit ceiling.
    if (!isQzoneSafeText(content, 280) || !isQzoneSafeText(content.normalize("NFKC"), 1000)) return fail("AGENCY_QZONE_UNSAFE_MATERIAL");
    return { ok: true, code: "AGENCY_QZONE_CANDIDATE", draft: { content,
      source: { kind: "public_information", ref: item.id }, creationReason: reasons[args.motive], audience: 64 } };
  } catch { return fail("AGENCY_QZONE_SOURCE_UNAVAILABLE"); }
}
