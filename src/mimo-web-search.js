import { normalizeModelUsage } from "./operational-ledger.js";

const SUPPORTED_MODELS = new Set([
  "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"
]);
const OFFICIAL_BASE_URL = "https://api.xiaomimimo.com/v1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
class MimoSearchError extends Error {}

const knownCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function searchMetadata(payload, requestedModel, apiKey, query) {
  const safeModel = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,159}$/.test(value)
    && !value.includes("://") && !/^(?:sk-|Bearer|password|secret|cookie|authorization|api[_-]?key)/i.test(value)
    && !value.includes(apiKey) && !value.includes(query);
  const reported = payload?.model;
  const plugin = payload?.usage?.web_search_usage;
  return {
    usage: normalizeModelUsage(payload?.usage),
    model: safeModel(reported) ? reported : safeModel(requestedModel) ? requestedModel : null,
    provider: "mimo-web-search",
    pluginUsage: { toolUsage: knownCount(plugin?.tool_usage), pageUsage: knownCount(plugin?.page_usage) }
  };
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}
function interruptedError(timedOut = false) {
  const error = new MimoSearchError(timedOut ? "MiMo 联网插件请求超时" : "MiMo 联网插件请求已取消");
  error.name = "AbortError";
  return error;
}
async function responseJson(response, wait) {
  if (!response.body || typeof response.body.getReader !== "function") throw new MimoSearchError("MiMo 联网插件返回了无效响应");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new MimoSearchError("MiMo 联网插件响应过大");
      chunks.push(value);
    }
  } finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new MimoSearchError("MiMo 联网插件返回了无效响应"); }
}

export function isSupportedMimoSearchModel(model) {
  return SUPPORTED_MODELS.has(String(model || ""));
}

export function officialMimoSearchEndpoint(baseUrl = "") {
  const value = String(baseUrl || OFFICIAL_BASE_URL).replace(/\/+$/, "");
  if (value !== OFFICIAL_BASE_URL && value !== `${OFFICIAL_BASE_URL}/chat/completions`)
    throw new Error("MiMo 官方联网插件只能使用小米官方 API 地址");
  return value.endsWith("/chat/completions") ? value : `${value}/chat/completions`;
}

export function parseMimoSearchResponse(payload, maxResults = 4) {
  const answer = String(payload?.choices?.[0]?.message?.content || "").trim().slice(0, 3000);
  const annotations = payload?.choices?.[0]?.message?.annotations;
  const results = [];
  for (const item of Array.isArray(annotations) ? annotations : []) {
    if (item?.type !== "url_citation") continue;
    let link;
    try {
      link = new URL(String(item.url || ""));
      if (!["http:", "https:"].includes(link.protocol) || link.username || link.password) continue;
    } catch { continue; }
    if (results.some((result) => result.link === link.href)) continue;
    results.push({
      title: String(item.title || item.site_name || link.hostname).slice(0, 160),
      link: link.href,
      snippet: String(item.summary || "").slice(0, 500),
      source: "mimo-web-search",
      publishedAt: String(item.publish_time || "").slice(0, 60)
    });
    if (results.length >= maxResults) break;
  }
  const usage = payload?.usage?.web_search_usage;
  const toolUsage = Number.isFinite(Number(usage?.tool_usage)) ? Number(usage.tool_usage) : 0;
  const searched = toolUsage > 0 || results.length > 0;
  return { provider: "mimo-web-search", searched, answer: searched ? answer : "", results,
    toolUsage, pageUsage: Number.isFinite(Number(usage?.page_usage)) ? Number(usage.page_usage) : 0 };
}

/** Default search result is unchanged, including legacy coercive toolUsage /
 * pageUsage fields. returnMetadata:true adds {usage,model,pluginUsage}; metadata
 * counters accept ONLY transport JSON nonnegative safe integers, else null.
 * model is the safe response model, falling back to the supported requested
 * binding (NOT generated content). Plugin counters are separate from tokens;
 * missing counters do not prove free search. No price/currency is inferred.
 * Parsed error JSON may supply error.metadata={usage,model,provider,pluginUsage,
 * httpStatus}, never raw upstream errors, response bodies, headers or credentials.
 */
export async function searchWithMimoPlugin({ query, model, baseUrl = "", apiKey, maxKeyword = 2,
  limit = 4, timeoutMs = 45000, forceSearch = true, fetchImpl = fetch, signal, returnMetadata = false } = {}) {
  if (!isSupportedMimoSearchModel(model)) throw new Error("所选 MiMo 模型不支持官方联网插件");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("MiMo 联网插件缺少 API Key；请在 API 管理中配置环境变量或 Keychain");
  if (!String(query || "").trim()) throw new Error("联网查询不能为空");
  if (!Number.isSafeInteger(maxKeyword) || maxKeyword < 1 || maxKeyword > 5) throw new Error("联网关键词数量无效");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("联网结果数无效");
  if (typeof returnMetadata !== "boolean" || typeof fetchImpl !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error("MiMo 联网插件请求选项无效");
  const endpoint = officialMimoSearchEndpoint(baseUrl);
  if (signal?.aborted) throw interruptedError();
  const body = {
    model,
    messages: [
      { role: "system", content: `请只依据联网搜索结果回答，若结果不足就明确说明。当前日期：${new Date().toISOString().slice(0, 10)}。` },
      { role: "user", content: String(query).slice(0, 500) }
    ],
    max_completion_tokens: 1024,
    stream: false,
    thinking: { type: "disabled" },
    tools: [{ type: "web_search", max_keyword: maxKeyword, force_search: forceSearch, limit }],
    tool_choice: "auto"
  };
  const controller = new AbortController();
  let rejectAbort, timedOut = false, metadata;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller.abort(); rejectAbort(interruptedError()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectAbort(interruptedError(true)); }, timeoutMs);
  const wait = promise => Promise.race([promise, interrupted]);
  try {
    const response = await wait(fetchImpl(endpoint, {
      method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal
    }));
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599)
      throw new MimoSearchError("MiMo 联网插件返回了无效响应");
    if (response.status >= 300 && response.status < 400) {
      cancelBody(response);
      throw new MimoSearchError(`MiMo 联网插件拒绝重定向（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      try {
        const payload = await responseJson(response, wait);
        metadata = { ...searchMetadata(payload, model, apiKey, String(query)), httpStatus: response.status };
      } catch {} finally { cancelBody(response); }
      if (response.status === 401 || response.status === 403) throw new MimoSearchError("MiMo 凭据无效或联网服务插件尚未开通");
      throw new MimoSearchError(`MiMo 联网插件请求失败（HTTP ${response.status}）`);
    }
    const payload = await responseJson(response, wait);
    metadata = { ...searchMetadata(payload, model, apiKey, String(query)), httpStatus: response.status };
    if (!payload || !Array.isArray(payload.choices)) throw new MimoSearchError("MiMo 联网插件返回了无效响应");
    const result = parseMimoSearchResponse(payload, limit);
    return returnMetadata ? { ...result, usage: metadata.usage, model: metadata.model, pluginUsage: metadata.pluginUsage } : result;
  } catch (error) {
    const safeError = controller.signal.aborted ? interruptedError(timedOut)
      : error instanceof MimoSearchError ? error : new Error("MiMo 联网插件请求失败");
    if (metadata) safeError.metadata = metadata;
    throw safeError;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
