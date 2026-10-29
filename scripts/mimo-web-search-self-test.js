import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { officialMimoSearchEndpoint, parseMimoSearchResponse, searchWithMimoPlugin } from "../src/mimo-web-search.js";
import { normalizeApiCenter, resolveApiCapability } from "../src/api-center.js";
import { configForAccountCapabilities } from "../src/bot-capabilities.js";
import { registryConfig } from "../src/account-registry.js";

assert.equal(officialMimoSearchEndpoint(), "https://api.xiaomimimo.com/v1/chat/completions");
assert.throws(() => officialMimoSearchEndpoint("https://example.test/v1"), /官方 API/);
const response = (value, status = 200) => new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
const initialPayload = { choices: [{ message: { content: "今天有一条新闻。",
  annotations: [{ type: "url_citation", url: "https://example.test/story", title: "新闻", summary: "摘要" },
    { type: "url_citation", url: "file:///etc/passwd", title: "不安全" }] } }],
  usage: { web_search_usage: { tool_usage: 1, page_usage: 1 } } };

let request;
const result = await searchWithMimoPlugin({
  query: "今天的科技新闻", model: "mimo-v2.6-flash", apiKey: "test-only-secret", maxKeyword: 2, limit: 3,
  fetchImpl: async (url, options) => {
    request = { url, options };
    return response(initialPayload);
  }
});
assert.equal(request.url, "https://api.xiaomimimo.com/v1/chat/completions");
assert.equal(request.options.headers.authorization, "Bearer test-only-secret");
assert.equal(request.options.redirect, "manual");
const body = JSON.parse(request.options.body);
assert.equal(body.tools[0].type, "web_search");
assert.equal(body.tools[0].max_keyword, 2);
assert.equal(body.tools[0].force_search, true);
assert.equal(body.tools[0].limit, 3);
assert.equal(result.searched, true);
assert.equal(result.results.length, 1);
assert.equal(result.results[0].link, "https://example.test/story");
assert.equal(result.answer, "今天有一条新闻。");
assert.deepEqual(result, parseMimoSearchResponse(initialPayload, 3));
assert.equal(Object.hasOwn(result, "usage"), false);
assert.equal(Object.hasOwn(result, "model"), false);
assert.equal(Object.hasOwn(result, "pluginUsage"), false);

const noSearch = parseMimoSearchResponse({ choices: [{ message: { content: "模型直接回答" } }] });
assert.equal(noSearch.searched, false);
assert.equal(noSearch.answer, "");
assert.equal(noSearch.results.length, 0);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "mimo-v2.6-flash", apiKey: "test-only-secret",
  fetchImpl: async () => ({ ok: false, status: 403 }) }), /尚未开通/);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "unsupported", apiKey: "test-only-secret" }), /不支持/);
await assert.rejects(searchWithMimoPlugin({ query: "新闻", model: "mimo-v2.6-flash", apiKey: "" }), /缺少 API Key/);

// Every transport below is mocked; no network/model, credentials or billing.
const base = { query: "fixture-private-query", model: "mimo-v2.6-flash", apiKey: "test-only-secret", timeoutMs: 100 };
const usage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1 };
const unknown = Object.fromEntries(Object.keys(usage).map(k => [k, null]));
const rawUsage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
  prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
  web_search_usage: { tool_usage: 1, page_usage: 3 } };
const payload = (extra = {}) => ({ model: "mimo-v2.6-flash-reported", choices: [{ message: { content: "搜索回答" } }], usage: rawUsage, ...extra });
const run = (value, changes = {}) => searchWithMimoPlugin({ ...base, returnMetadata: true, fetchImpl: async () => response(value), ...changes });
const withMetadata = await run(payload());
assert.deepEqual(withMetadata, { ...parseMimoSearchResponse(payload()), usage, model: "mimo-v2.6-flash-reported",
  pluginUsage: { toolUsage: 1, pageUsage: 3 } });
assert.equal(withMetadata.provider, "mimo-web-search");
assert.deepEqual((await run(payload({ usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16,
  input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } }))).usage, usage);
const noPlugin = await run(payload({ model: undefined, usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }));
assert.equal(noPlugin.searched, false);
assert.equal(noPlugin.answer, "");
assert.deepEqual(noPlugin.usage, { ...unknown, inputTokens: 12, outputTokens: 4, totalTokens: 16 });
assert.deepEqual(noPlugin.pluginUsage, { toolUsage: null, pageUsage: null });
assert.equal(noPlugin.model, base.model);
assert.deepEqual((await run(payload({ usage: undefined }))).usage, unknown);
assert.deepEqual((await run(payload({ usage: { web_search_usage: { tool_usage: 1, page_usage: 100 } } }))).usage, unknown);
const zero = await run(payload({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  web_search_usage: { tool_usage: 0, page_usage: 0 } } }));
assert.deepEqual(zero.usage, { ...unknown, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
assert.deepEqual(zero.pluginUsage, { toolUsage: 0, pageUsage: 0 });
assert.equal((await run(payload({ usage: { prompt_tokens: 12 } }))).usage.totalTokens, null);
assert.equal((await run(payload({ usage: { ...rawUsage, total_tokens: 99 } }))).usage.totalTokens, null);
for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", true, {}, [], null]) {
  const malformed = await run(payload({ usage: { prompt_tokens: value, completion_tokens: value, total_tokens: value,
    web_search_usage: { tool_usage: value, page_usage: value } } }));
  assert.deepEqual(malformed.usage, unknown);
  assert.deepEqual(malformed.pluginUsage, { toolUsage: null, pageUsage: null });
}
const legacyCoercion = await run(payload({ usage: { web_search_usage: { tool_usage: "1", page_usage: "3" } } }));
assert.equal(legacyCoercion.toolUsage, 1); // Preserve legacy result, but NOT ledger metadata.
assert.equal(legacyCoercion.pageUsage, 3);
assert.deepEqual(legacyCoercion.pluginUsage, { toolUsage: null, pageUsage: null });
for (const reported of [undefined, null, {}, 123, base.apiKey, `echo-${base.apiKey}`, base.query,
  "https://private.example/secret", "sk-secret", "arbitrary model prose", "x".repeat(161)]) {
  assert.equal((await run(payload({ model: reported }))).model, base.model);
}
const leaked = "private-upstream-error-secret";
for (const status of [400, 401, 403, 429, 500]) {
  await assert.rejects(run(payload({ error: { message: `${leaked} ${base.apiKey} ${base.query}` }, provider: leaked }), {
    fetchImpl: async () => response(payload({ error: { message: `${leaked} ${base.apiKey} ${base.query}` }, provider: leaked }), status)
  }), error => {
    assert.deepEqual(error.metadata.usage, usage);
    assert.deepEqual(error.metadata.pluginUsage, { toolUsage: 1, pageUsage: 3 });
    assert.equal(error.metadata.model, "mimo-v2.6-flash-reported");
    assert.equal(error.metadata.httpStatus, status);
    assert.equal(error.metadata.provider, "mimo-web-search");
    assert.deepEqual(Object.keys(error.metadata).sort(), ["httpStatus", "model", "pluginUsage", "provider", "usage"]);
    for (const secret of [leaked, base.apiKey, base.query]) assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false);
    assert.match(error.message, [401, 403].includes(status) ? /凭据无效|尚未开通/ : new RegExp(`HTTP ${status}`));
    return true;
  });
}
await assert.rejects(run(null, { fetchImpl: async () => response({ usage: { prompt_tokens: 7 }, error: leaked, model: base.apiKey }, 500) }), error => {
  assert.deepEqual(error.metadata.usage, { ...unknown, inputTokens: 7 });
  assert.equal(error.metadata.model, base.model);
  assert.deepEqual(error.metadata.pluginUsage, { toolUsage: null, pageUsage: null });
  return true;
});
await assert.rejects(run({ usage: rawUsage, model: "reported-model", error: leaked }), error => {
  assert.match(error.message, /无效响应/);
  assert.deepEqual(error.metadata.usage, usage);
  assert.equal(JSON.stringify(error).includes(leaked), false);
  return true;
});
await assert.rejects(run(null, { fetchImpl: async () => { throw new Error(`${leaked} ${base.apiKey}`); } }), error => {
  assert.equal(error.message, "MiMo 联网插件请求失败");
  assert.equal(error.metadata, undefined);
  return true;
});
for (const [status, content] of [[200, leaked], [500, leaked], [500, "x".repeat(4 * 1024 * 1024 + 1)]]) {
  await assert.rejects(run(null, { fetchImpl: async () => response(content, status) }), error => {
    assert.match(error.message, status === 200 ? /无效响应/ : /HTTP 500/);
    assert.equal(error.metadata, undefined);
    assert.equal(error.message.includes(leaked), false);
    return true;
  });
}
await assert.rejects(run(null, { fetchImpl: async () => response("x".repeat(4 * 1024 * 1024 + 1)) }), /响应过大/);
await assert.rejects(run(null, { fetchImpl: async () => response(leaked, 302) }), error => {
  assert.match(error.message, /拒绝重定向/);
  assert.equal(error.metadata, undefined);
  return true;
});
const hanging = () => new Promise(() => {});
await assert.rejects(run(null, { timeoutMs: 10, fetchImpl: hanging }), error => error.name === "AbortError" && /超时/.test(error.message));
for (const ok of [true, false]) {
  await assert.rejects(run(null, { timeoutMs: 10, fetchImpl: async () => ({ ok, status: ok ? 200 : 500,
    body: { getReader: () => ({ read: hanging, cancel: async () => {} }), cancel: async () => {} } }) }),
  error => error.name === "AbortError" && /超时/.test(error.message));
}
const controller = new AbortController();
const pending = run(null, { signal: controller.signal, fetchImpl: hanging });
controller.abort(new Error(leaked));
await assert.rejects(pending, error => error.name === "AbortError" && error.message === "MiMo 联网插件请求已取消");
await assert.rejects(run(null, { signal: controller.signal, fetchImpl: () => assert.fail("pre-abort must not fetch") }), error => error.name === "AbortError");
for (const changes of [{ returnMetadata: "yes" }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { fetchImpl: null }]) {
  await assert.rejects(run(null, changes), /请求选项无效/);
}

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
const invocations = [];
const bridgeSearch = vm.runInNewContext(`${bridgeSource.slice(searchStart, searchEnd)}\nwebSearch;`, {
  normalizeApiCenter, resolveApiCapability,
  getApiSecret: () => assert.fail("regression must not read Keychain"),
  getVoiceSecret: () => assert.fail("regression must not read legacy Keychain"),
  voiceApiEnvironment: ({ apiKeyEnv }) => ({ [apiKeyEnv]: `fixture-only-${apiKeyEnv}` }),
  recordedModelInvocation: (config, options, invoke) => { invocations.push({ config, options }); return invoke(); },
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
  assert.equal(call.returnMetadata, true);
  assert.equal(invocations.at(-1).config, scoped);
  assert.equal(invocations.at(-1).options.kind, "web_search");
  assert.equal(invocations.at(-1).options.model, expected.profile.model);
  assert.deepEqual(scoped, beforeScoped, "search must not mutate the account clone");
}
assert.equal(calls.length, 3);
assert.deepEqual(registry, beforeRegistry, "search projections must not mutate global registry/bindings");
console.log("mimo web search self-test: PASS");
