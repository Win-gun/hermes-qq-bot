import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { officialMimoSearchEndpoint, parseMimoSearchResponse, searchWithMimoPlugin } from "../src/mimo-web-search.js";
import { normalizeApiCenter, resolveApiCapability } from "../src/api-center.js";
import { configForAccountCapabilities } from "../src/bot-capabilities.js";
import { registryConfig } from "../src/account-registry.js";

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

// Exercise the bridge call site, not just the resolver: the regression used the
// global searchBinding after correctly projecting an account's MiMo provider.
// No bridge startup, network, environment credentials or Keychain access.
const bridgeSource = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const searchStart = bridgeSource.indexOf("async function webSearch(query, config, { signal } = {}) {");
const searchEnd = bridgeSource.indexOf("async function buildWebSearchContext(", searchStart);
assert.ok(searchStart >= 0 && searchEnd > searchStart, "bridge search call site must be available");
const fixture = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const center = normalizeApiCenter(fixture);
center.searchProfiles = [{ id: "global-google", name: "Global Google", provider: "google", providerOrder: ["google"],
  maxResults: 4, timeoutMs: 20000, proxy: { enabled: false, autoDetect: false, directFallback: false, urls: [] } }];
center.searchBinding = "global-google";
for (const [id, model, maxKeyword, limit] of [["own-search", "mimo-v2.6-flash", 2, 3], ["group-search", "mimo-v2.6-pro", 4, 5]]) {
  center.connections.push({ id: `${id}-connection`, name: id, provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1",
    credentialSource: "existing", apiKeyEnv: id === "own-search" ? "FIXTURE_OWN_SEARCH_KEY" : "FIXTURE_GROUP_SEARCH_KEY" });
  center.searchProfiles.push({ id, name: id, provider: "mimo-web-search", providerOrder: ["mimo-web-search"],
    connectionId: `${id}-connection`, model, maxKeyword, maxResults: limit, forceSearch: true, timeoutMs: 20000,
    proxy: { enabled: false, autoDetect: false, directFallback: false, urls: [] } });
}
const registry = registryConfig({ ...fixture, apiCenter: center, accounts: { version: 2,
  items: ["independent", "group-leader", "group-peer"].map((id) => ({ id, modelBindings: { search: "own-search" } })),
  failoverGroups: [{ id: "search-group", memberIds: ["group-leader", "group-peer"], policyAccountId: "group-leader",
    policy: { modelBindings: { search: "group-search" } } }] } });
const beforeRegistry = structuredClone(registry);
const calls = [];
const bridgeSearch = vm.runInNewContext(`${bridgeSource.slice(searchStart, searchEnd)}\nwebSearch;`, {
  normalizeApiCenter, resolveApiCapability,
  getApiSecret: () => assert.fail("regression must not read Keychain"),
  getVoiceSecret: () => assert.fail("regression must not read legacy Keychain"),
  voiceApiEnvironment: ({ apiKeyEnv }) => ({ [apiKeyEnv]: `fixture-only-${apiKeyEnv}` }),
  searchWithMimoPlugin: async (options) => { calls.push({ ...options }); return { provider: "mimo-web-search", searched: true, results: [] }; }
});
for (const [accountId, profileId] of [["independent", "own-search"], ["group-leader", "group-search"], ["group-peer", "group-search"]]) {
  const scoped = configForAccountCapabilities(registry, accountId);
  const beforeScoped = structuredClone(scoped);
  assert.equal(scoped.apiCenter.searchBinding, "global-google", "account projection must retain global defaults");
  const expected = resolveApiCapability(scoped, "search");
  assert.equal(expected.profile.id, profileId);
  assert.equal((await bridgeSearch(`fixture query ${accountId}`, scoped)).searched, true);
  const call = calls.at(-1);
  assert.equal(call.model, expected.profile.model, `${accountId}: use effective account/group search model`);
  assert.equal(call.apiKey, `fixture-only-${expected.connection.apiKeyEnv}`, `${accountId}: use matching connection credentials`);
  assert.equal(call.baseUrl, expected.connection.baseUrl);
  assert.equal(call.maxKeyword, expected.profile.maxKeyword);
  assert.equal(call.limit, expected.profile.maxResults);
  assert.equal(call.forceSearch, expected.profile.forceSearch);
  assert.deepEqual(scoped, beforeScoped, "search must not mutate the account clone");
}
assert.equal(calls.length, 3);
assert.deepEqual(registry, beforeRegistry, "search projections must not mutate global registry/bindings");
console.log("mimo web search self-test: PASS");
