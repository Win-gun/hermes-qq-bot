import assert from 'node:assert/strict';
import { completeText } from '../src/text-completion.js';

const base = { prompt: '完整上下文', baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', apiKey: 'test-only-api-key-0000', timeoutMs: 100 };
const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
const answer = (content, extra = {}) => response({ choices: [{ message: { content, ...extra } }] });
const run = (changes = {}) => completeText({ ...base, ...changes });

let request;
assert.equal(await run({ fetchImpl: async (url, options) => { request = { url, options }; return answer('可以'); } }), '可以');
assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions');
assert.equal(request.options.redirect, 'manual');
assert.equal(request.options.headers.authorization, `Bearer ${base.apiKey}`);
assert.deepEqual(JSON.parse(request.options.body), {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'Follow the user message instructions and answer directly.' },
    { role: 'user', content: '完整上下文' },
  ],
  reasoning_effort: 'low',
});
await run({ baseUrl: `${base.baseUrl}/chat/completions`, reasoningEffort: 'none', fetchImpl: async (url, options) => {
  assert.equal(url, request.url);
  assert.equal('reasoning_effort' in JSON.parse(options.body), false);
  return answer([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]);
} });

for (const invalid of ['https://user:password@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#secret', 'file:///tmp/api']) {
  await assert.rejects(run({ baseUrl: invalid, fetchImpl: () => { throw new Error('must not call'); } }), /Invalid text completion URL/);
}
for (const value of [answer(' '), answer(null, { reasoning_content: 'hidden' }), answer('visible', { tool_calls: [{ id: 'x' }] })]) {
  await assert.rejects(run({ fetchImpl: async () => value }), /Text completion returned/);
}
for (const status of [302, 401, 500]) {
  let cancelled = false;
  await assert.rejects(run({ fetchImpl: async () => ({ ...response('ignored', status), status, ok: false, body: { cancel: () => { cancelled = true; } } }) }), (error) => {
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(error.message, /never-print-this-key|private upstream error/);
    return true;
  });
  assert.equal(cancelled, true);
}
await assert.rejects(run({ fetchImpl: async () => { throw new Error('Text completion leaked never-print-this-key'); } }), (error) => {
  assert.equal(error.message, 'Text completion request failed');
  return true;
});
await assert.rejects(run({ fetchImpl: async () => response({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }) }), /output truncated/);
await assert.rejects(run({ fetchImpl: async () => answer('x'.repeat(4 * 1024 * 1024 + 1)) }), /response too large/);
await assert.rejects(run({ fetchImpl: async () => response('invalid-json') }), /Invalid text completion JSON/);

const hanging = () => new Promise(() => {});
await assert.rejects(run({ timeoutMs: 10, fetchImpl: hanging }), (error) => error.name === 'AbortError' && /timed out/.test(error.message));
const external = new AbortController();
const pending = run({ signal: external.signal, fetchImpl: hanging });
external.abort();
await assert.rejects(pending, (error) => error.name === 'AbortError' && /aborted/.test(error.message));
const bodyPending = run({ timeoutMs: 10, fetchImpl: async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: hanging, cancel: async () => {} }) } }) });
await assert.rejects(bodyPending, (error) => error.name === 'AbortError' && /timed out/.test(error.message));

// Opt-in transport metadata: only real JSON usage numbers, never inferred from
// generated content, request model, provider strings, errors or token estimates.
const knownUsage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1 };
const unknownUsage = Object.fromEntries(Object.keys(knownUsage).map(k => [k, null]));
const transport = (usage, extra = {}) => ({ model: 'reported/model-v2', usage,
  choices: [{ message: { content: '回答' } }], ...extra });
const openaiUsage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
  prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } };
const metaRun = (value, changes = {}) => run({ returnMetadata: true, fetchImpl: async () => response(value), ...changes });
assert.deepEqual(await metaRun(transport(openaiUsage)), {
  text: '回答', usage: knownUsage, model: 'reported/model-v2', provider: 'openai-compatible',
});
assert.deepEqual((await metaRun(transport({ input_tokens: 12, output_tokens: 4, total_tokens: 16,
  input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } }))).usage, knownUsage);
assert.equal(await run({ fetchImpl: async () => response(transport(openaiUsage)) }), '回答');
assert.deepEqual((await metaRun({ choices: [{ message: { content: 'input_tokens=999; model=pretend' } }] })).usage, unknownUsage);
assert.equal((await metaRun({ choices: [{ message: { content: 'test-model' } }] })).model, null);
for (const bad of [null, '12 tokens', [], { prompt_tokens: '12', completion_tokens: -1, total_tokens: 1.5 },
  { prompt_tokens: true, completion_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: {} }]) {
  assert.deepEqual((await metaRun(transport(bad))).usage, unknownUsage);
}
assert.deepEqual((await metaRun(transport({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }))).usage,
  { ...unknownUsage, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
assert.deepEqual((await metaRun(transport({ prompt_tokens: 12 }))).usage, { ...unknownUsage, inputTokens: 12 });
assert.equal((await metaRun(transport({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 500 }))).usage.totalTokens, null);
for (const model of [base.apiKey, `echo-${base.apiKey}`, 'sk-not-a-model', 'BearerToken', 'https://private.example/key',
  { secret: base.apiKey }, `arbitrary prose ${base.apiKey}`, base.prompt]) {
  assert.equal((await metaRun(transport(openaiUsage, { model }))).model, null);
}
const secret = 'never-print-this-key';
const polluted = await metaRun(transport({ ...openaiUsage, key: secret, content: secret }, {
  error: { message: secret }, provider: secret, id: secret, system_fingerprint: secret,
}));
assert.doesNotMatch(JSON.stringify(polluted), new RegExp(secret));
assert.deepEqual(Object.keys(polluted).sort(), ['model', 'provider', 'text', 'usage']);

for (const [status, value, expectedUsage] of [
  [429, transport(openaiUsage, { error: { message: `${secret} ${base.apiKey} ${base.prompt}` } }), knownUsage],
  [500, { error: { message: secret }, usage: { prompt_tokens: 7 } }, { ...unknownUsage, inputTokens: 7 }],
  [400, { error: secret, usage: { prompt_tokens: '12' }, model: base.apiKey }, unknownUsage],
]) {
  await assert.rejects(run({ returnMetadata: true, fetchImpl: async () => response(value, status) }), error => {
    assert.equal(error.message, `Text completion failed (HTTP ${status})`);
    assert.deepEqual(error.metadata.usage, expectedUsage);
    assert.equal(error.metadata.httpStatus, status);
    assert.equal(error.metadata.provider, 'openai-compatible');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(`${secret}|${base.apiKey}|${base.prompt}`));
    assert.deepEqual(Object.keys(error.metadata).sort(), ['httpStatus', 'model', 'provider', 'usage']);
    return true;
  });
}
for (const choices of [
  [{ finish_reason: 'length', message: { content: 'partial secret content' } }],
  [{ message: { content: 'partial secret content', tool_calls: [{ id: secret }] } }],
  [{ message: { content: '', reasoning_content: secret } }],
]) {
  await assert.rejects(metaRun(transport(openaiUsage, { choices })), error => {
    assert.deepEqual(error.metadata.usage, knownUsage);
    assert.equal(error.metadata.model, 'reported/model-v2');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(`${secret}|partial secret content`));
    return true;
  });
}
await assert.rejects(run({ fetchImpl: async () => response('not JSON plus secret', 503) }), error => {
  assert.equal(error.message, 'Text completion failed (HTTP 503)');
  assert.equal(error.metadata, undefined);
  return true;
});
await assert.rejects(run({ timeoutMs: 10, fetchImpl: async () => ({ ok: false, status: 500,
  body: { getReader: () => ({ read: hanging, cancel: async () => {} }), cancel: async () => {} } }) }),
error => error.name === 'AbortError' && /timed out/.test(error.message));
await assert.rejects(run({ returnMetadata: 'yes', fetchImpl: () => { throw new Error('must not call'); } }), /Invalid text completion options/);

console.log('text completion self-test passed');
