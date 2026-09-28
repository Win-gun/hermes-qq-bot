import assert from "node:assert/strict";
import { officialMimoSearchEndpoint, parseMimoSearchResponse, searchWithMimoPlugin } from "../src/mimo-web-search.js";

assert.equal(officialMimoSearchEndpoint(), "https://api.xiaomimimo.com/v1/chat/completions");
assert.throws(() => officialMimoSearchEndpoint("https://example.test/v1"), /官方 API/);

let request;
const result = await searchWithMimoPlugin({
  query: "今天的科技新闻", model: "mimo-v2.6-flash", apiKey: "test-only-secret", maxKeyword: 2, limit: 3,
  fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "今天有一条新闻。",
      annotations: [{ type: "url_citation", url: "https://example.test/story", title: "新闻", summary: "摘要" },
        { type: "url_citation", url: "file:///etc/passwd", title: "不安全" }] } }],
      usage: { web_search_usage: { tool_usage: 1, page_usage: 1 } } }) };
  }
});
assert.equal(request.url, "https://api.xiaomimimo.com/v1/chat/completions");
assert.equal(request.options.headers.authorization, "Bearer test-only-secret");
const body = JSON.parse(request.options.body);
assert.equal(body.tools[0].type, "web_search");
assert.equal(body.tools[0].max_keyword, 2);
assert.equal(body.tools[0].force_search, true);
assert.equal(body.tools[0].limit, 3);
assert.equal(result.searched, true);
assert.equal(result.results.length, 1);
assert.equal(result.results[0].link, "https://example.test/story");
assert.equal(result.answer, "今天有一条新闻。");

const noSearch = parseMimoSearchResponse({ choices: [{ message: { content: "模型直接回答" } }] });
assert.equal(noSearch.searched, false);
assert.equal(noSearch.answer, "");
assert.equal(noSearch.results.length, 0);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "mimo-v2.6-flash", apiKey: "test-only-secret",
  fetchImpl: async () => ({ ok: false, status: 403 }) }), /尚未开通/);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "unsupported", apiKey: "test-only-secret" }), /不支持/);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "mimo-v2.6-flash", apiKey: "" }), /缺少 API Key/);
console.log("mimo web search self-test: PASS");
