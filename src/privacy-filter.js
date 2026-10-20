// Shared by foreground archive writes and background archive search. Credentials
// and URLs must not acquire a weaker policy just because indexing moved threads.
export function redactText(value) {
  return String(value || "")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号]")
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证]")
    .replace(/\b\d{12,19}\b/g, "[长数字]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[已过滤]")
    .replace(/(密码|口令|验证码|token|密钥|secret|password|code)[:：= ]{0,4}[A-Za-z0-9._\-]{4,}/gi, "$1=[已过滤]")
    .replace(/(住址|地址|宿舍|寝室)[:： ]?[^，。！？!?\n]{6,80}/g, "$1=[已过滤]");
}

export function sanitizeArchiveUrl(value) {
  const sensitiveKey = /token|secret|password|key|auth|cookie|phone|mobile|tel|otp|code|验证码|手机号|身份证|bank|address/i;
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    const filterParams = (params) => {
      let changed = false;
      for (const key of new Set(params.keys())) {
        const values = params.getAll(key);
        const safe = values.map(value => sensitiveKey.test(key) ? "[已过滤]" : redactText(value));
        if (safe.some((value, index) => value !== values[index])) {
          params.delete(key);
          for (const value of safe) params.append(key, value);
          changed = true;
        }
      }
      return changed;
    };
    filterParams(url.searchParams);
    let fragment;
    try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { fragment = url.hash.slice(1); }
    if (fragment.includes("=")) {
      const params = new URLSearchParams(fragment);
      if (filterParams(params)) url.hash = params.toString();
    } else {
      const safe = redactText(fragment);
      if (safe !== fragment) url.hash = safe;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
    const safePath = redactText(pathname);
    if (safePath !== pathname) url.pathname = safePath;
    return url.toString();
  } catch {
    return redactText(String(value || "").replace(/([?&][^=]*(?:token|secret|password|key)[^=]*=)[^&\s]+/gi, "$1[已过滤]"));
  }
}

const ADDRESSABLE = /^(?:conversationId|messageId|senderId|accountId|logicalBotId|sourceMessageIds|replyToUserId|ids|mentions|id|time|sentAt|receivedAt|processedAt|searchedAt|updatedAt|file|localPath|source|type|messageType|kind|provider)$/;
export function sanitizeArchiveValue(value, { privacyFilter = true } = {}, key = "", depth = 0) {
  if (!privacyFilter) return value;
  if (depth > 64) return "[已过滤]";
  if (Array.isArray(value)) return value.map(item => sanitizeArchiveValue(item, { privacyFilter }, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !["__proto__", "constructor", "prototype"].includes(name))
    .map(([name, item]) => [name, sanitizeArchiveValue(item, { privacyFilter }, name, depth + 1)]));
  if (typeof value !== "string") return value;
  if (ADDRESSABLE.test(key)) return value;
  if (/(?:password|passkey|secret|token|cookie|authorization|api.?key|密码|密钥)/i.test(key)) return "[已过滤]";
  if (/^(?:url|link)$/.test(key)) return sanitizeArchiveUrl(value);
  return redactText(value.replace(/https?:\/\/[^\s<>"']+/gi, url => sanitizeArchiveUrl(url)));
}
