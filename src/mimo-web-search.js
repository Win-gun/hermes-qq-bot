const SUPPORTED_MODELS = new Set([
  "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"
]);
const OFFICIAL_BASE_URL = "https://api.xiaomimimo.com/v1";

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

export async function searchWithMimoPlugin({ query, model, baseUrl = "", apiKey, maxKeyword = 2,
  limit = 4, timeoutMs = 45000, forceSearch = true, fetchImpl = fetch, signal } = {}) {
  if (!isSupportedMimoSearchModel(model)) throw new Error("所选 MiMo 模型不支持官方联网插件");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("MiMo 联网插件缺少 API Key；请在 API 管理中配置环境变量或 Keychain");
  if (!String(query || "").trim()) throw new Error("联网查询不能为空");
  if (!Number.isSafeInteger(maxKeyword) || maxKeyword < 1 || maxKeyword > 5) throw new Error("联网关键词数量无效");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("联网结果数无效");
  const endpoint = officialMimoSearchEndpoint(baseUrl);
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
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("MiMo 凭据无效或联网服务插件尚未开通");
    throw new Error(`MiMo 联网插件请求失败（HTTP ${response.status}）`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error("MiMo 联网插件返回了无效响应"); }
  if (!payload || !Array.isArray(payload.choices)) throw new Error("MiMo 联网插件返回了无效响应");
  return parseMimoSearchResponse(payload, limit);
}
