// Host-only policy: configuration is not protocol support or write authority.
export const QZONE_READ_ACTIONS = Object.freeze(["get_qzone_feeds", "get_qzone_msg_list", "get_qzone_msg_detail"]);
export const QZONE_WRITE_ACTIONS = Object.freeze([
  "send_qzone_msg", "like_qzone", "comment_qzone", "delete_qzone_msg", "set_qzone_msg_right",
  "unlike_qzone", "set_qzone_blacklist"
]);
// Unknown QZone verbs must also be denied by the parent's generic dispatcher.
export const isQzoneAction = action => typeof action === "string"
  && (QZONE_READ_ACTIONS.includes(action) || QZONE_WRITE_ACTIONS.includes(action)
    || /qzone/i.test(action));

const DAY = 86400000;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const defaults = {
  enabled: false, mode: "draft_only", ugcRight: 64, allowedAudiences: [64],
  reads: { feeds: false, own: false, count: 20, maxDaily: 20,
    cooldownMs: 1000, freshnessMs: 300000, ttlMs: 3600000 },
  publish: { enabled: false, maxDaily: 2, cooldownMs: 3600000 },
  likes: { enabled: false, maxDaily: 5, cooldownMs: 300000 },
  comments: { enabled: false, maxDaily: 2, cooldownMs: 600000 },
  autonomy: { enabled: false, maxContentLength: 280, sources: [] }
};
const fail = () => { throw new Error("QZONE_POLICY_INVALID"); };
const bounded = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const ref = v => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,96}$/.test(v)
  && !["__proto__", "constructor", "prototype"].includes(v);

// Reject rather than silently persist credentials, transport URLs or host paths.
// This is deliberately conservative; not a claim to recognize all private data.
export function isQzoneSafeText(value, limit = 1000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit
    && !/[<>\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
    && !/(?:https?:\/\/|file:|base64:|\/Users\/|\/home\/|[A-Z]:\\|Bearer\s|\bsk-(?:proj-|ant-)?[a-z0-9_-]{16,}|-----BEGIN\s.*PRIVATE KEY|(?:api[_ -]?key|password|passwd|token|secret|验证码|密码)\s*[:=：]|\b1[3-9]\d{9}\b|\b\d{15,19}[Xx]?\b|\d+号楼.*\d+(?:室|单元))/iu.test(value);
}

/** Both entrypoints are strict. Missing policy means safe defaults; malformed
 * saved policy must not be repaired into an enabled configuration. */
export function validateQzonePolicy(value = {}) {
  if (!plain(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) fail();
  const result = structuredClone(defaults);
  for (const [key, entry] of Object.entries(value)) {
    if (["reads", "publish", "likes", "comments", "autonomy"].includes(key)) {
      if (!plain(entry) || Object.keys(entry).some(k => !Object.hasOwn(defaults[key], k))) fail();
      for (const [field, item] of Object.entries(entry)) {
        if (field === "sources") {
          if (!Array.isArray(item) || item.length > 32) fail();
          const seen = new Set();
          for (const source of item) {
            if (!plain(source) || Object.keys(source).length !== 3
              || Object.keys(source).some(k => !["kind", "ref", "content"].includes(k))
              || !["admin_topic", "public_information"].includes(source.kind)
              || !ref(source.ref) || !isQzoneSafeText(source.content, 1000)) fail();
            const id = `${source.kind}:${source.ref}`;
            if (seen.has(id)) fail();
            seen.add(id);
          }
          result.autonomy.sources = structuredClone(item);
        } else if (typeof defaults[key][field] === "boolean") {
          if (typeof item !== "boolean") fail();
          result[key][field] = item;
        } else {
          const bounds = field === "count" ? [1, 50] : field === "maxDaily" ? [0, 20]
            : field === "maxContentLength" ? [1, 1000] : ["ttlMs", "freshnessMs"].includes(field) ? [1000, DAY]
              : [0, DAY];
          if (!bounded(item, ...bounds)) fail();
          result[key][field] = item;
        }
      }
    } else if (key === "enabled") {
      if (typeof entry !== "boolean") fail();
      result.enabled = entry;
    } else if (key === "mode") {
      if (!["draft_only", "reviewed", "scoped_autonomy"].includes(entry)) fail();
      result.mode = entry;
    } else if (key === "ugcRight") {
      if (![1, 4, 64].includes(entry)) fail();
      result.ugcRight = entry;
    } else if (key === "allowedAudiences") {
      if (!Array.isArray(entry) || !entry.length || entry.length > 3
        || entry.some(x => ![1, 4, 64].includes(x)) || new Set(entry).size !== entry.length) fail();
      result.allowedAudiences = [...entry];
    }
  }
  if (!result.allowedAudiences.includes(result.ugcRight) || result.reads.freshnessMs > result.reads.ttlMs
    || result.autonomy.sources.some(s => s.content.length > result.autonomy.maxContentLength)) fail();
  return result;
}

export const normalizeQzonePolicy = validateQzonePolicy;
