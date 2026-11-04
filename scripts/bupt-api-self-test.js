import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyApiCenterBindings, normalizeApiCenter, resolveApiCapability } from '../src/api-center.js';
import { registryConfig } from '../src/account-registry.js';
import { completeText } from '../src/text-completion.js';
import { resolveModelCredential } from '../src/model-credentials.js';
import { selectVisionRoute } from '../src/vision-completion.js';

// Synthetic only: no credentials, campus network, model calls or QQ writes.
const config = registryConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
const center = normalizeApiCenter(config);
const prior = Object.fromEntries(['vision', 'asr', 'tts', 'search'].map(kind => [kind, resolveApiCapability(config, kind)]));
center.connections.push({ id: 'conn-bupt-campus', name: '北邮校园 API', provider: 'custom',
  baseUrl: 'https://myai.bupt.edu.cn/llm-gw/v1', credentialSource: 'keychain', apiKeyEnv: 'BUPT_API_KEY',
  credentialRef: 'aabbccdd-1234-4567-89ab-123456789abc' });
center.profiles.push({ id: 'bupt-campus-text', name: '北邮 DeepSeek 文本', kind: 'chat',
  connectionId: 'conn-bupt-campus', model: 'deepseek-v4-flash', reasoningEffort: 'none', timeoutMs: 120000 });
center.bindings.chat = 'bupt-campus-text';
center.bindings.task = 'bupt-campus-text';
applyApiCenterBindings(config, center);
for (const id of ['', ...config.accounts.items.map(account => account.id)]) {
  for (const kind of ['chat', 'task']) {
    const selected = resolveApiCapability(config, kind, id);
    assert.equal(selected.profile.model, 'deepseek-v4-flash');
    assert.equal(selected.connection.provider, 'custom');
    assert.equal(selected.connection.credentialSource, 'keychain');
  }
}
for (const kind of ['vision', 'asr', 'tts', 'search']) assert.deepEqual(resolveApiCapability(config, kind), prior[kind]);

const { connection, profile } = resolveApiCapability(config, 'chat');
assert.throws(() => resolveModelCredential(connection, { env: { BUPT_API_KEY: 'synthetic-other-key' },
  getApiSecret: () => null }), /Keychain/); // No DSH/environment fallback after an explicit Keychain selection.
const fakeKey = 'synthetic-campus-key';
assert.equal(resolveModelCredential(connection, { getApiSecret: ref => {
  assert.equal(ref, connection.credentialRef); return fakeKey;
} }), fakeKey);

for (const suffix of ['', '/', '/chat/completions']) {
  const result = await completeText({ prompt: 'Reply only OK.', baseUrl: connection.baseUrl + suffix,
    model: profile.model, apiKey: fakeKey, reasoningEffort: 'none', maxOutputTokens: 64, returnMetadata: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://myai.bupt.edu.cn/llm-gw/v1/chat/completions');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.authorization, `Bearer ${fakeKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, profile.model);
      assert.equal(body.max_tokens, 64);
      assert.equal('reasoning_effort' in body, false);
      assert.equal('tools' in body, false);
      assert(body.messages.every(message => typeof message.content === 'string'));
      return new Response(JSON.stringify({ model: profile.model, choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }));
    } });
  assert.equal(result.text, 'OK');
  assert.equal(result.usage.totalTokens, 13);
}

// A prior administrator image grant is pinned to MiMo, never inherited by a
// text-only gateway just because it now owns the chat binding.
const route = selectVisionRoute({ accountId: 'default', chat: resolveApiCapability(config, 'chat'), vision: prior.vision,
  capability: { source: 'administrator', accountId: 'default', supportsImages: true, profileId: 'mimo-default',
    connectionId: 'conn-mimo-default', provider: 'xiaomi', model: 'mimo-v2.6-flash',
    baseUrl: 'https://api.xiaomimimo.com/v1', transport: 'chat-completions' } });
assert.equal(route.kind, 'vision');
assert.equal(route.reason, 'CHAT_IMAGES_UNKNOWN');
console.log('BUPT API routing, nested endpoint, credential isolation and media separation: PASS');
