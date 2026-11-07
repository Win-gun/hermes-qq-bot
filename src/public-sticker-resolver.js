import { normalizeMemecubQuery } from './memecub-search.js';

const fail = code => Object.assign(new Error(code), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fixedCode = error => /^(?:MEMECUB|EXPRESSION|STICKER|PUBLIC_STICKER)_[A-Z_]{1,60}$/.test(error?.code || '')
  ? error.code : 'PUBLIC_STICKER_UNAVAILABLE';
function frozenData(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozenData(item);
    Object.freeze(value);
  }
  return value;
}

/** Host-only content resolver, NOT a model tool, sender or authority issuer.
 *
 * createPublicStickerResolver({ library, search, guard, approveQuery,
 *   selectCandidate?, genericQuery? })
 * resolve({accountId, conversationId, query, openOptions?}, {signal?, serious?})
 *   -> {ok:true, source, candidates, allowedIds, importedId?, sha256?, reason?,
 *       prepare(id,{signal?}), revision(), markSent(id,messageId)}
 *
 * library = the existing createExpressionLibrary instance (same cache, downloader,
 * qualification, rejection ledger and ACK writer). search = createMemecubSearch.
 * Use one shared search instance per IP/budget owner; its beforeRequest hook can
 * claim the existing durable per-IP/account budget ONLY for actual cache misses.
 * Nothing here raises that budget, sends a packet to QQ or records a fake ACK.
 *
 * guard(scope,{context,signal,phase}) MUST synchronously return true, otherwise
 * deny. Authenticate route, exact target, revision, cancellation, quiet and host
 * content scope. The library's injected isCurrent/downloader/vision callbacks
 * MUST enforce those same live gates inside importPublic/prepare (including their
 * internal awaits); an outer resolver cannot police another component's awaits.
 *
 * openOptions is passed by identity to library.open -> capture. Only capture may
 * consume a host-issued one-use WeakMap grant and derive content-only policy for
 * an explicit owner exact-target request. Boolean/model JSON is never authority.
 * Do not put owner options in a shared mutable default or expose this API to AI.
 *
 * approveQuery({ ...scope, publicQuery, context, signal }) -> {publicQuery,approval}
 * is host code: reject member names/private content and issue a search approval
 * for that EXACT normalized public phrase. No transcript/QQ ID goes to provider.
 * It may claim policy authority, but must NOT charge a provider call on cache hit.
 * selectCandidate(frozenMetadataRows,{query,scope,context,signal}) -> row.id|null
 * may use a bounded text-only model; metadata is untrusted evidence, not prompts
 * or permissions. Null declines; a fabricated ID/URL is rejected. Default: first.
 * A license/review_status is only a provider claim, never a copyright guarantee.
 *
 * Empty remote results alone permit ONE generic-query attempt. 429, auth errors,
 * quota, rejection, unsafe bytes, model refusal and all failures never retry.
 * Candidates/IDs are safe projections for this request, NOT perpetual send grants.
 * Keep prepare/revision/markSent in host code; use the existing final send gate.
 * markSent is exclusively the parent's real-ACK callback: it deliberately permits
 * facts after revocation, matching the existing library's durable receipt rules.
 */
export function createPublicStickerResolver({ library, search, guard, approveQuery,
  selectCandidate, genericQuery = '表情' } = {}) {
  if (!library || ['open', 'candidates', 'importPublic', 'prepare', 'snapshot', 'markSent']
    .some(key => typeof library[key] !== 'function')
    || !search || ['search', 'resolveCandidate'].some(key => typeof search[key] !== 'function')
    || typeof guard !== 'function' || typeof approveQuery !== 'function'
    || (selectCandidate !== undefined && typeof selectCandidate !== 'function')
    || (genericQuery !== null && (typeof genericQuery !== 'string' || !genericQuery.trim() || genericQuery.length > 40)))
    throw fail('PUBLIC_STICKER_OPTIONS');
  let fallbackQuery;
  try { fallbackQuery = genericQuery === null ? null : normalizeMemecubQuery(genericQuery); }
  catch { throw fail('PUBLIC_STICKER_OPTIONS'); }

  async function resolve(input, { signal, serious = false } = {}) {
    if (!plain(input) || Object.keys(input).some(key => !['accountId', 'conversationId', 'query', 'openOptions'].includes(key))
      || typeof input.accountId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(input.accountId)
      || typeof input.conversationId !== 'string' || !/^(group|private):[1-9]\d{0,19}$/.test(input.conversationId)
      || typeof input.query !== 'string' || input.query.length > 1000 || typeof serious !== 'boolean'
      || (signal !== undefined && !(signal instanceof AbortSignal))) throw fail('PUBLIC_STICKER_ARGUMENT');
    // Copy identity/query before any host await; callers cannot retarget a grant.
    const scope = Object.freeze({ accountId: input.accountId, conversationId: input.conversationId });
    const query = input.query;
    let context;
    function check(phase, extraSignal) {
      if (signal?.aborted || extraSignal?.aborted) throw fail('PUBLIC_STICKER_ABORTED');
      if (guard(scope, { context, signal, phase }) !== true) throw fail('PUBLIC_STICKER_STALE');
    }
    async function step(phase, action, extraSignal) {
      check(phase, extraSignal);
      try { return await action(); }
      finally { check(phase, extraSignal); }
    }
    function local(phrase = query) {
      check('candidates');
      const rows = library.candidates(context, { query: phrase, serious, limit: 3 });
      check('candidates');
      if (!Array.isArray(rows) || rows.length > 3 || rows.some(row => !plain(row)
        || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id))) throw fail('PUBLIC_STICKER_LIBRARY');
      return rows;
    }
    function offer(rows, source, details = {}) {
      const candidates = frozenData(structuredClone(rows));
      const allowedIds = Object.freeze(candidates.map(row => row.id));
      const ids = new Set(allowedIds);
      check('offer');
      return Object.freeze({ ok: true, source, candidates, allowedIds, ...details,
        async prepare(id, { signal: sendSignal = signal } = {}) {
          try {
            if (sendSignal !== undefined && !(sendSignal instanceof AbortSignal)) throw fail('PUBLIC_STICKER_ARGUMENT');
            if (!ids.has(id)) throw fail('PUBLIC_STICKER_SELECTION');
            // Do not rebuild the library offer here: its original eligible set and
            // current byte/hash/rejection checks remain authoritative at preparation.
            const combined = signal && sendSignal && signal !== sendSignal ? AbortSignal.any([signal, sendSignal]) : sendSignal;
            const result = await step('prepare', () => library.prepare(context, { id, signal: combined }), combined);
            check('prepare', combined);
            if (!result?.segment) throw fail(result?.errorCode || 'PUBLIC_STICKER_UNAVAILABLE');
            return result;
          } catch (error) { throw fail(fixedCode(error)); }
        },
        revision() {
          try {
            check('revision');
            const value = library.snapshot(context);
            check('revision');
            if (!value?.ok) throw fail(value?.code || 'PUBLIC_STICKER_LIBRARY');
            return value.revision;
          } catch (error) { throw fail(fixedCode(error)); }
        },
        async markSent(id, messageId) {
          try {
            if (!ids.has(id)) throw fail('PUBLIC_STICKER_SELECTION');
            // A real receipt is a historical fact, not fresh sending authority.
            const result = await library.markSent(context, { id, messageId });
            if (!result?.ok) throw fail(result?.code || 'PUBLIC_STICKER_ACK');
            return result;
          } catch (error) { throw fail(fixedCode(error)); }
        }
      });
    }
    try {
      check('open');
      context = library.open(scope.accountId, scope.conversationId, input.openOptions);
      check('open');
      const existing = local();
      if (existing.length || serious) return offer(existing, 'local', serious ? { reason: 'SERIOUS_CONTEXT' } : {});
      if (!query.trim()) return offer([], 'local', { reason: 'EMPTY_QUERY' });
      // A host owner grant may derive this policy only for its exact content
      // scope. Ordinary disabled/shadow/social calls must not spend an API call
      // before importPublic eventually refuses them.
      const policy = context.policy;
      if (!policy?.enabled || policy.shadowMode || !policy.stickers?.enabled || !policy.stickers.autoSend
        || !policy.stickers.webSearch || !policy.stickers.autonomousSelection
        || !policy.conversationIds?.includes(scope.conversationId)) throw fail('EXPRESSION_DISABLED');
      let phrase = normalizeMemecubQuery(query), rows;
      for (let attempt = 0; attempt < 2; attempt++) {
        const request = await step('approve-query', () => approveQuery(Object.freeze({ ...scope,
          publicQuery: phrase, context, signal })));
        if (!plain(request) || request.publicQuery !== phrase || Object.keys(request)
          .some(key => !['publicQuery', 'approval'].includes(key))) throw fail('PUBLIC_STICKER_QUERY');
        // Snapshot approval before the search await. It never enters model data.
        const result = await step('search', () => search.search({ publicQuery: phrase, approval: request.approval }, { limit: 3, signal }));
        check('metadata');
        if (!Array.isArray(result?.candidates) || result.candidates.length > 3) throw fail('PUBLIC_STICKER_SEARCH');
        rows = result.candidates.map(handle => search.resolveCandidate(handle)).filter(row =>
          row?.provider === 'memecub' && row.trust === 'untrusted' && row.status === 'candidate'
          && ['meme', 'gif', 'emoji'].includes(row.kind) && row.private !== true && row.profane !== true
          && row.license?.attribution_required === false);
        check('metadata');
        // A rejected or expired candidate is not an empty search result.
        if (result.candidates.length || !fallbackQuery || phrase === fallbackQuery || attempt === 1) break;
        phrase = fallbackQuery;
      }
      if (!rows.length) return offer([], 'public_memecub', { reason: 'NO_REUSABLE_PUBLIC_STICKER' });
      // Clones keep a selector from mutating the authoritative provider metadata.
      const metadata = frozenData(structuredClone(rows));
      const selectedId = selectCandidate
        ? await step('select-candidate', () => selectCandidate(metadata, { query: phrase, scope, context, signal }))
        : rows[0].id;
      check('select-candidate');
      if (selectedId === null) return offer([], 'public_memecub', { reason: 'SELECTION_DECLINED' });
      const selected = rows.find(row => row.id === selectedId);
      if (!selected) throw fail('PUBLIC_STICKER_SELECTION');
      const imported = await step('import-public', () => library.importPublic(context, { ...selected, publicQuery: phrase }, { signal }));
      // Never mint IDs from URLs/metadata or bypass semantic/qualification gates.
      const available = local(query);
      return offer(available, 'public_memecub', { importedId: imported.id, sha256: imported.sha256,
        ...(!available.length ? { reason: 'NO_ELIGIBLE_STICKER' } : {}) });
    } catch (error) { throw fail(fixedCode(error)); }
  }
  return Object.freeze({ resolve });
}
