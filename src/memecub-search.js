import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress, publicMediaUrl } from './public-media.js';

const ENDPOINT = 'https://memecub.com/api/v1/search';
const DAY = 24 * 60 * 60 * 1000;
const KINDS = new Set(['meme', 'gif', 'emoji', 'artwork', 'photo']);
const errors = new WeakSet();
const fail = (code, extra = {}) => {
  const error = Object.assign(new Error(code), { code, ...extra });
  errors.add(error);
  return error;
};
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = text => createHash('sha256').update(text).digest('hex');
const bounded = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const number = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const cancel = body => { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} };

function publicQuery(value) {
  // Reject, do not silently truncate/redact a private message into a search.
  // This is defense in depth, NOT a private-data detector: the host must issue
  // approval for the exact short public phrase, never for a chat transcript.
  if (typeof value !== 'string' || value.length > 160 || /[\p{Cc}\p{Cf}]/u.test(value)) throw fail('MEMECUB_QUERY');
  const q = value.trim().replace(/ +/g, ' ');
  if (!q || [...q].length > 80 || Buffer.byteLength(q) > 240
    || /\d{5,}|https?:|www\.|@|\[CQ:|(?:group|private|user|account):/i.test(q)
    || /(?:bearer\b|sk-|mb_|api[ _-]?key|token|password|密码|验证码|口令|身份证|银行卡)/i.test(q)) throw fail('MEMECUB_QUERY');
  return q;
}

function retryDelay(value, now) {
  if (typeof value !== 'string' || value.length > 128) return 60000;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= (Number.MAX_SAFE_INTEGER - now) / 1000
      ? Math.max(1000, seconds * 1000) : Number.MAX_SAFE_INTEGER - now;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 60000;
}

/** Public, keyless, host-only search; Node 22+, no media downloads or disk IO.
 * Official contract (not instructions to execute):
 * https://github.com/liyupi/memecub/blob/master/README.md
 * https://github.com/liyupi/memecub/blob/master/cli/src/client.ts
 * https://memecub.com/developers
 *
 * createMemecubSearch({ isQueryApproved, fetchImpl?, lookup?, clock?, ...limits })
 * search({ publicQuery, approval }, { limit = 5, signal } = {})
 *   -> { provider, cached, candidates: opaque frozen handles[] }
 * resolveCandidate(handle) -> frozen untrusted metadata, or throws if forged or
 * expired. Keep both methods in host code; do not expose metadata/markdown as
 * instructions, auto-render it, or let a model mint approvals.
 *
 * isQueryApproved({publicQuery, approval}) MUST synchronously authenticate a
 * host-issued approval bound to the exact query and current policy; `true` in
 * model JSON is not approval. Approval never goes over the network. It is checked
 * on cache hits too and again after awaits. Do not pass chat history/private IDs.
 *
 * Use ONE instance per shared public IP/budget owner. Budgets/cache are bounded,
 * in-memory and not durable or shared across processes. Every attempted fetch
 * consumes budget, including errors/abort; no automatic retries/backfill polling.
 * Anonymous provider allowance: 20 searches/day/IP; REST limit <=50. We default
 * to <=10 results, 20 attempts/rolling 24h and a 3s minimum interval.
 *
 * Handles are NOT sticker-store records, content hashes, administrator approvals
 * or automatic eligibility. Host integration must download via the existing
 * createPublicMediaReader (DNS pinning + redirect checks), validate bytes/hash,
 * cache via createStickerCache, then run its qualification/review/policy gates.
 * URL/DNS checks here are only preflight: DNS can change after search. License
 * claims are provider data, not a rights guarantee. Preserve attribution when
 * the host uses an image; never equate a provider review_status with approval.
 */
export function createMemecubSearch({
  isQueryApproved, fetchImpl = globalThis.fetch, lookup = dnsLookup, clock = Date.now,
  timeoutMs = 8000, maxBodyBytes = 256 * 1024, maxResults = 10,
  cacheTtlMs = 5 * 60 * 1000, maxCacheEntries = 32, candidateTtlMs = 10 * 60 * 1000,
  maxRequestsPerDay = 20, minIntervalMs = 3000
} = {}) {
  if ([isQueryApproved, fetchImpl, lookup, clock].some(f => typeof f !== 'function')
    || !number(timeoutMs, 1, 30000) || !number(maxBodyBytes, 1, 1024 * 1024)
    || !number(maxResults, 1, 50) || !number(candidateTtlMs, 1, 3600000)
    || !number(cacheTtlMs, 0, candidateTtlMs) || !number(maxCacheEntries, 0, 128)
    || !number(maxRequestsPerDay, 0, 20) || !number(minIntervalMs, 0, DAY)) throw fail('MEMECUB_OPTIONS');
  const cache = new Map(), handles = new WeakMap();
  let attempts = [], lastAttempt = -Infinity, cooldownUntil = 0, busy = false, lastClock = 0;
  function now() {
    const t = clock();
    if (!number(t, 0, Number.MAX_SAFE_INTEGER - DAY) || t < lastClock) throw fail('MEMECUB_CLOCK');
    lastClock = t;
    return t;
  }
  function approved(request) {
    let ok = false;
    try { ok = isQueryApproved(request) === true; } catch {}
    if (!ok) throw fail('MEMECUB_NOT_APPROVED');
  }
  function issue(items, cached) {
    const candidates = items.map(item => {
      const handle = Object.freeze({ id: item.data.id, provider: 'memecub', trust: 'untrusted', status: 'candidate' });
      handles.set(handle, item);
      return handle;
    });
    return Object.freeze({ provider: 'memecub', cached, candidates: Object.freeze(candidates) });
  }

  async function search(input, { limit = Math.min(5, maxResults), signal } = {}) {
    if (!plain(input) || Object.keys(input).some(k => !['publicQuery', 'approval'].includes(k))) throw fail('MEMECUB_QUERY');
    const request = Object.freeze({ publicQuery: publicQuery(input.publicQuery), approval: input.approval });
    if (!number(limit, 1, maxResults)) throw fail('MEMECUB_LIMIT');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('MEMECUB_SIGNAL');
    if (signal?.aborted) throw fail('MEMECUB_ABORTED');
    approved(request);
    const startedAt = now(), key = hash(JSON.stringify([request.publicQuery, limit]));
    for (const [k, entry] of cache) if (entry.expiresAt <= startedAt) cache.delete(k);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); cache.set(key, hit);
      return issue(hit.items, true);
    }
    // Never enqueue searches for future execution or share abort/approval state
    // between callers. Concurrent cache misses fail fast rather than duplicate.
    if (busy) throw fail('MEMECUB_BUSY');
    if (startedAt < cooldownUntil) throw fail('MEMECUB_RATE_LIMIT', { retryAfterMs: cooldownUntil - startedAt });
    attempts = attempts.filter(t => t > startedAt - DAY);
    if (attempts.length >= maxRequestsPerDay) throw fail('MEMECUB_BUDGET');
    if (startedAt - lastAttempt < minIntervalMs) throw fail('MEMECUB_RATE_LIMIT', { retryAfterMs: minIntervalMs - (startedAt - lastAttempt) });

    busy = true;
    const controller = new AbortController(), active = controller.signal;
    const onAbort = () => controller.abort(fail('MEMECUB_ABORTED'));
    const timer = setTimeout(() => controller.abort(fail('MEMECUB_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const check = () => { if (active.aborted) throw active.reason; };
    const race = promise => new Promise((resolve, reject) => {
      const abort = () => reject(active.reason);
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
      Promise.resolve(promise).then(value => {
        active.removeEventListener('abort', abort); resolve(value);
      }, error => { active.removeEventListener('abort', abort); reject(error); });
    });
    let response, reader, completed = false;
    const cancelReader = () => cancel(reader || response?.body);
    active.addEventListener('abort', cancelReader, { once: true });
    try {
      check(); approved(request);
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ q: request.publicQuery, limit: String(limit) }).toString();
      attempts.push(startedAt); lastAttempt = startedAt;
      response = await race(Promise.resolve(fetchImpl(url.href, {
        method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: active
      })).then(value => {
        // Retain the body before settling the race: abort can arrive between
        // promise fulfillment and the await continuation assigning response.
        response = value;
        if (active.aborted) cancel(value?.body);
        return value;
      }));
      check();
      if (response?.redirected || (response?.url && response.url !== url.href)) throw fail('MEMECUB_REDIRECT');
      if (response?.status === 429) {
        const t = now(), delay = retryDelay(response.headers?.get('retry-after'), t);
        cooldownUntil = t + delay;
        throw fail('MEMECUB_RATE_LIMIT', { status: 429, retryAfterMs: delay });
      }
      if (response?.status !== 200) throw fail('MEMECUB_HTTP', {
        status: Number.isInteger(response?.status) ? response.status : 0
      });
      const mime = response.headers?.get('content-type') || '';
      const encoding = response.headers?.get('content-encoding');
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(mime)
        || (encoding && encoding.toLowerCase() !== 'identity')) throw fail('MEMECUB_CONTENT_TYPE');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) throw fail('MEMECUB_BODY_SIZE');
      if (typeof response.body?.getReader !== 'function') throw fail('MEMECUB_BODY');
      reader = response.body.getReader();
      // Fixed storage also bounds overhead from tiny transport chunks. Empty or
      // excessively fragmented streams are not allowed to starve the deadline.
      const body = Buffer.allocUnsafe(maxBodyBytes);
      let bytes = 0, reads = 0;
      while (true) {
        check();
        const part = await race(reader.read());
        check();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || !part.value.byteLength || ++reads > 16384) throw fail('MEMECUB_BODY');
        if (bytes + part.value.byteLength > maxBodyBytes) throw fail('MEMECUB_BODY_SIZE');
        body.set(part.value, bytes);
        bytes += part.value.byteLength;
      }
      if (length !== null && length !== undefined && bytes !== Number(length)) throw fail('MEMECUB_BODY_SIZE');
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes))); }
      catch { throw fail('MEMECUB_JSON'); }
      if (!plain(payload) || !Array.isArray(payload.data) || payload.data.length > 50) throw fail('MEMECUB_SCHEMA');

      const resolved = new Map();
      async function safeUrl(raw) {
        let u;
        try { u = publicMediaUrl(raw); } catch { return null; }
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (u.protocol !== 'https:' || (!isIP(host) && !host.includes('.'))) return null;
        if (!resolved.has(host)) {
          // Only bounded response rows are inspected; no recursive crawling.
          const answers = isIP(host) ? [{ address: host, family: isIP(host) }]
            : await race(lookup(host, { all: true, verbatim: true }));
          check();
          resolved.set(host, Array.isArray(answers) && answers.length > 0 && answers.length <= 64
            && answers.every(a => a && isPublicAddress(a.address) && a.family === isIP(a.address)));
        }
        return resolved.get(host) ? u.href : null;
      }
      const items = [], seen = new Set();
      // Do not parse more rows than requested, even if the server over-returns.
      for (const row of payload.data.slice(0, limit)) {
        check();
        if (!plain(row) || (row.private !== undefined && row.private !== false)
          || (row.profane !== undefined && row.profane !== false) || !KINDS.has(row.kind)
          || !bounded(row.title, 300) || !row.title.trim()
          || !number(row.width, 1, 32768) || !number(row.height, 1, 32768)
          || row.width * row.height > 100000000 || !plain(row.license)
          || !bounded(row.license.code, 80) || !row.license.code.trim()
          || typeof row.license.commercial_use !== 'boolean' || typeof row.license.attribution_required !== 'boolean'
          || !bounded(row.markdown, 8192)
          || (row.attribution != null && !bounded(row.attribution, 2048))
          || (row.license.attribution_required && !row.attribution?.trim())
          || (row.author != null && !bounded(row.author, 300))
          || (row.license.name !== undefined && !bounded(row.license.name, 200))
          || (row.license.remix_allowed !== undefined && typeof row.license.remix_allowed !== 'boolean')) continue;
        const mediaUrl = await safeUrl(row.url), pageUrl = await safeUrl(row.page_url);
        const sourceUrl = row.source_url == null ? null : await safeUrl(row.source_url);
        if (!mediaUrl || !pageUrl || (row.source_url != null && !sourceUrl) || seen.has(mediaUrl)) continue;
        seen.add(mediaUrl);
        const license = Object.freeze({ code: row.license.code, commercial_use: row.license.commercial_use,
          attribution_required: row.license.attribution_required,
          ...(row.license.name === undefined ? {} : { name: row.license.name }),
          ...(row.license.remix_allowed === undefined ? {} : { remix_allowed: row.license.remix_allowed }) });
        const data = Object.freeze({ id: `memecub_${hash(mediaUrl)}`, provider: 'memecub', trust: 'untrusted', status: 'candidate',
          title: row.title, url: mediaUrl, pageUrl, width: row.width, height: row.height, kind: row.kind, license,
          attribution: row.attribution ?? null, markdown: row.markdown,
          source: Object.freeze({ provider: 'memecub', pageUrl, url: sourceUrl, author: row.author ?? null }) });
        items.push({ data });
      }
      check(); approved(request);
      const finishedAt = now();
      for (const item of items) item.expiresAt = finishedAt + candidateTtlMs;
      if (cacheTtlMs && maxCacheEntries) {
        while (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { items, expiresAt: finishedAt + cacheTtlMs });
      }
      completed = true;
      return issue(items, false);
    } catch (error) {
      if (active.aborted) throw active.reason;
      // Never expose a provider body, query, URL or injected error containing a
      // credential. Only our fixed codes and numeric HTTP/rate data escape.
      if (errors.has(error)) throw error;
      throw fail('MEMECUB_NETWORK');
    } finally {
      if (!completed) { cancelReader(); controller.abort(fail('MEMECUB_ABORTED')); }
      try { reader?.releaseLock(); } catch {}
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      active.removeEventListener('abort', cancelReader);
      busy = false;
    }
  }

  return Object.freeze({ search, resolveCandidate(candidate) {
    const item = handles.get(candidate);
    if (!item || item.expiresAt <= now()) throw fail('MEMECUB_CANDIDATE');
    return item.data;
  } });
}
