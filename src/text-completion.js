const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
class CompletionError extends Error {}

function endpointFor(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid text completion URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid text completion URL');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.href;
}

function abortError(timedOut = false) {
  const error = new CompletionError(timedOut ? 'Text completion timed out' : 'Text completion aborted');
  error.name = 'AbortError';
  return error;
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

async function boundedResponse(response, wait) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new CompletionError('Text completion response has no readable body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CompletionError('Text completion response too large');
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A single, stateless OpenAI-compatible text completion. */
export async function completeText({ prompt, baseUrl, model, apiKey, reasoningEffort = 'low', timeoutMs = 60_000, signal, fetchImpl = fetch }) {
  const endpoint = endpointFor(baseUrl);
  if (typeof prompt !== 'string' || !prompt.trim() || typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function') {
    throw new Error('Invalid text completion arguments');
  }
  if (!['none', 'low', 'medium', 'high'].includes(reasoningEffort) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid text completion options');
  }
  if (signal?.aborted) throw abortError();

  const controller = new AbortController();
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  let timeoutFired = false;
  const onAbort = () => { controller.abort(); rejectAbort(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timeoutFired = true; controller.abort(); rejectAbort(abortError(true)); }, timeoutMs);
  const wait = (promise) => Promise.race([promise, interrupted]);
  const payload = {
    model,
    messages: [
      { role: 'system', content: 'Follow the user message instructions and answer directly.' },
      { role: 'user', content: prompt },
    ],
  };
  if (reasoningEffort !== 'none') payload.reasoning_effort = reasoningEffort;
  try {
    const response = await wait(fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'manual',
    }));
    if (!response || !Number.isInteger(response.status)) throw new CompletionError('Invalid text completion response');
    if (response.status >= 300 && response.status < 400) {
      cancelBody(response);
      throw new CompletionError(`Text completion redirect refused (HTTP ${response.status})`);
    }
    if (!response.ok) {
      cancelBody(response);
      throw new CompletionError(`Text completion failed (HTTP ${response.status})`);
    }
    const raw = await boundedResponse(response, wait);
    let data;
    try { data = JSON.parse(raw); } catch { throw new CompletionError('Invalid text completion JSON'); }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new CompletionError('Text completion output truncated');
    if (choice?.message?.tool_calls?.length) throw new CompletionError('Text completion returned tool calls');
    const content = choice?.message?.content;
    const answer = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : '';
    if (!answer.trim()) throw new CompletionError('Text completion returned no text');
    return answer;
  } catch (error) {
    if (controller.signal.aborted) throw abortError(timeoutFired);
    if (error instanceof CompletionError) throw error;
    throw new Error('Text completion request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
