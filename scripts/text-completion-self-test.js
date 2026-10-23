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

console.log('text completion self-test passed');
