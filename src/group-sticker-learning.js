import { createHash } from 'node:crypto';
import { createPublicMediaReader, publicMediaUrl, validateImage } from './public-media.js';
import { redactText } from './privacy-filter.js';
import { validateStickerStore } from './sticker-service.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const fields = (x, keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));
const qq = x => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x);
const msg = x => typeof x === 'string' && /^-?[1-9]\d{0,19}$/.test(x);
const uint = x => Number.isSafeInteger(x) && x >= 0;
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fail = () => { throw new Error('STICKER_LEARNING_UNAVAILABLE'); };
const TTL = 5 * 60000;
const clean = (x, max) => redactText(String(x || '').replace(/https?:\/\/[^\s<>"']+/gi, '[链接]'))
  .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
const unsafe = x => /\[已过滤\]|\[手机号\]|\[身份证\]|\[长数字\]|\[链接\]|\[\s*CQ\s*:|<\/?(?:system|script|developer)|(?:忽略|绕过|覆盖).{0,16}(?:指令|规则|权限)|(?:ignore|bypass|override).{0,20}(?:instructions?|rules?)|Bearer\s|(?:密码|验证码|密钥|token|secret|cookie|api.?key)\s*[:：=]/iu.test(x);
const meaningful = t => (t.match(/[\p{L}\p{N}]/gu) || []).length >= 2
  && !/^(?:\[(?:图片|表情|image|sticker)\]|图片|表情|image|sticker)$/iu.test(t);

// Process-wide single flight, including different library instances. A dependency
// ignoring abort quarantines the lane after timeout until it actually settles;
// we never dispatch a second model while an uncertain first call is still alive.
const waiting = [];
let active = null;
const idleWaiters = [];
function notifyIdle() { if (!active && !waiting.length) for (const done of idleWaiters.splice(0)) done(); }
function pump() {
  if (active || !waiting.length) { notifyIdle(); return; }
  const job = active = waiting.shift();
  job.timer = setTimeout(() => job.abort.abort(), 60000);
  job.monitor = setInterval(() => { try { job.current(); } catch { job.abort.abort(); } }, 200);
  Promise.resolve().then(() => job.run(job.abort.signal)).then(() => job.settle(true), () => job.settle(false)).finally(() => {
    clearTimeout(job.timer); clearInterval(job.monitor); job.detach(); active = null; pump();
  });
}

export function validateStickerDescription(x) {
  const string = (s, max, empty = false) => typeof s === 'string' && s.length <= max
    && (empty || !!s.trim()) && clean(s, max) === s && !unsafe(s);
  if (!fields(x, ['note', 'tags', 'sticker', 'safeToReuse', 'confidence', 'usage', 'avoid'])
    || !string(x.note, 200) || !Array.isArray(x.tags) || x.tags.length > 16 || !Array.from(x.tags).every(t => string(t, 32))
    || typeof x.sticker !== 'boolean' || typeof x.safeToReuse !== 'boolean'
    || typeof x.confidence !== 'number' || !Number.isFinite(x.confidence) || x.confidence < 0 || x.confidence > 1
    || !string(x.usage, 200, true) || !Array.isArray(x.avoid) || x.avoid.length > 16
    || !Array.from(x.avoid).every(t => string(t, 100))) fail();
  return structuredClone(x);
}

/** Host-only direct-event intake. guard returns immutable host scope/policy and
 * authenticates the exact issued ctx on EVERY await/write. No QQ actions here.
 * No raw context, transport URL, file ref or upstream error enters the ledger.
 * Claims are never retried, even after crash/uncertain durable publication.
 */
export function createGroupStickerLearning({ readState, transact, guard, describeImage, resolveImage,
  mediaCache, downloadImage = createPublicMediaReader(), clock = Date.now }) {
  const owner = {}, attempted = new Set(); // uncertain local publications also fail closed
  const diagnostics = new Map(); // Process-local counters only; never repository writes.
  function diagnostic(logicalId) {
    if (!diagnostics.has(logicalId)) {
      if (diagnostics.size >= 128) fail();
      diagnostics.set(logicalId, { completed: 0, failed: 0, lastErrorCode: null });
    }
    return diagnostics.get(logicalId);
  }
  function allowed(ctx, signal) {
    const c = guard(ctx, signal), p = c.policy;
    if (!c.conversationId.startsWith('group:') || !p.enabled || p.shadowMode || !p.stickers.enabled
      || !p.stickers.groupLearning || !p.stickers.visionLearning || !p.conversationIds.includes(c.conversationId)) fail();
    return c;
  }
  function book(root, c, create = false) {
    if (!plain(root?.memory)) fail();
    let envelope = root.memory.groupStickerLearning;
    if (envelope === undefined) {
      if (!create) return;
      envelope = root.memory.groupStickerLearning = { version: 1, bots: {} };
    }
    if (!fields(envelope, ['version', 'bots']) || envelope.version !== 1 || !plain(envelope.bots)) fail();
    let b = envelope.bots[c.logicalId];
    if (b === undefined && create) b = envelope.bots[c.logicalId] = { claims: {}, days: {}, lastAt: 0 };
    if (b !== undefined && (!fields(b, ['claims', 'days', 'lastAt']) || !plain(b.claims) || !plain(b.days)
      || !uint(b.lastAt) || Object.keys(b.claims).length > 10000
      || Object.entries(b.claims).some(([k, v]) => !digest(k) || !fields(v, ['at', 'urlHash', 'assetId']) || !uint(v.at)
        || (v.urlHash !== undefined && !digest(v.urlHash))
        || (v.assetId !== undefined && !/^gs_[a-f0-9]{64}$/.test(v.assetId)))
      || Object.entries(b.days).some(([k, v]) => !/^\d{4}-\d{2}-\d{2}$/.test(k) || !uint(v)))) fail();
    return b;
  }
  function assets(root, c, create = false) {
    let s = root.memory.socialExpressionAssets;
    if (s === undefined) {
      if (!create) return;
      s = root.memory.socialExpressionAssets = { version: 1, bots: {} };
    }
    validateStickerStore(s, c.logicalId);
    if (!s.bots[c.logicalId] && create) s.bots[c.logicalId] = { stickers: {}, capabilities: {} };
    return s.bots[c.logicalId]?.stickers;
  }
  const sourceFresh = input => {
    const at = clock();
    return uint(at) && uint(input.sentAt) && input.sentAt > 0 && uint(input.receivedAt)
      && input.sentAt <= input.receivedAt + 30000 && input.receivedAt - input.sentAt <= TTL
      && input.receivedAt <= at + 30000 && at - input.receivedAt <= TTL;
  };
  async function run(ctx, input, signal) {
    const c = allowed(ctx, signal);
    const check = () => { allowed(ctx, signal); if (!sourceFresh(input)) fail(); };
    const context = input.context.filter(e => e.sentAt <= input.sentAt && input.sentAt - e.sentAt <= 120000)
      .slice(-6).map(e => ({ messageId: e.messageId, userId: e.userId, sentAt: e.sentAt, text: clean(e.text, 240) }));
    const usageContext = { text: clean(input.text, 400), context, trust: 'untrusted-source-only' };
    const snippets = [usageContext.text, ...context.map(e => e.text)];
    const knownContext = !snippets.some(unsafe) && snippets.some(meaningful);
    // Image-only/placeholder intake is a true no-op: no claim/download/model/cache.
    // A later direct event with real context can still learn the same transport.
    if (!knownContext) return;
    const denied = (list, sha256) => Object.values(list || {}).some(asset => {
      const a = asset.annotations[c.conversationId];
      return (asset.sha256 === sha256 || a?.sha256 === sha256)
        && (asset.blocked || asset.denied || a?.status === 'rejected' || a?.blocked || a?.denied);
    });
    const qualified = (asset, a) => a && a.sha256 === asset.sha256 && (a.status === 'confirmed'
      || (a.automatic?.eligible === true && a.automatic.qualificationVersion === 1
        && a.automatic.sha256 === asset.sha256 && a.automatic.evidenceRevision === a.evidenceRevision && meaningful(a.usage)));
    const evidenceFor = a => [...(a?.evidence || []).filter(e => e.messageId !== input.messageId || e.userId !== input.userId),
      { messageId: input.messageId, userId: input.userId, sentAt: input.sentAt, receivedAt: input.receivedAt }].slice(-8);
    function appendEvidence(root, list, asset, key) {
      const a = asset.annotations[c.conversationId];
      if (denied(list, asset.sha256)) return;
      a.evidence = evidenceFor(a); a.evidenceRevision = (a.evidenceRevision || 0) + 1;
      if (a.automatic) a.automatic.evidenceRevision = a.evidenceRevision;
      a.revision++; a.updatedAt = clock();
      book(root, c).claims[key].assetId = asset.id;
      validateStickerStore(root.memory.socialExpressionAssets, c.logicalId);
    }
    for (const ref of input.refs) {
      check();
      const key = hash(JSON.stringify([c.logicalId, c.conversationId, input.messageId, input.userId, ref.index]));
      if (attempted.has(key)) continue;
      if (attempted.size >= 10000) fail();
      attempted.add(key);
      const urlHash = ref.url ? hash(ref.url) : undefined;
      const claimed = await transact(root => {
        check(); const b = book(root, c, true), at = clock();
        if (b.claims[key]) return false;
        if (Object.keys(b.claims).length >= 10000 || at < b.lastAt) fail();
        const list = assets(root, c) || {};
        // A URL lookup only reuses a successfully learned, content-bound asset.
        // Ambiguous candidates may learn again from a NEW original event.
        const known = urlHash && Object.values(b.claims).find(v => v.urlHash === hash(c.conversationId + urlHash)
          && v.assetId && list[v.assetId]?.annotations[c.conversationId]);
        const existing = known && list[known.assetId], annotation = existing?.annotations[c.conversationId];
        if (existing && (denied(list, existing.sha256) || qualified(existing, annotation))) {
          b.claims[key] = { at, urlHash: hash(c.conversationId + urlHash), assetId: existing.id }; b.lastAt = at;
          if (!denied(list, existing.sha256)) appendEvidence(root, list, existing, key);
          return false;
        }
        if (Object.keys(list).length >= 500) fail();
        const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
        if ((b.days[day] || 0) >= c.policy.stickers.maxDailyDownloads) fail();
        b.claims[key] = { at, ...(urlHash ? { urlHash: hash(c.conversationId + urlHash) } : {}) };
        b.lastAt = at;
        b.days[day] = (b.days[day] || 0) + 1;
        // Bounded daily book; durable replay keys are not pruned.
        for (const d of Object.keys(b.days)) if (d < day) delete b.days[d];
        return true;
      });
      check(); if (!claimed) continue;
      let url = ref.url;
      if (!url && resolveImage && ref.file) { url = await resolveImage(ctx, ref, { signal }); check(); }
      const transport = publicMediaUrl(url); check();
      const downloaded = await downloadImage(url, { signal }); check();
      const checked = validateImage(downloaded?.buffer, downloaded?.mimeType);
      const media = { ...checked, buffer: Buffer.from(checked.buffer), sha256: hash(checked.buffer) };
      const id = `gs_${media.sha256}`;
      const previous = assets(readState(), c)?.[id];
      if (previous?.blocked || previous?.denied || previous?.annotations[c.conversationId]?.status === 'rejected'
        || previous?.annotations[c.conversationId]?.blocked || previous?.annotations[c.conversationId]?.denied) continue;
      // Content identity also respects same-scope rejections in the older manual
      // collection. A different URL/collection id is not a revocation escape.
      if (denied(assets(readState(), c), media.sha256)) continue;
      const originalRevision = previous?.annotations[c.conversationId]?.revision || 0;
      const originalAssetRevision = previous?.revision || 0;
      const unchanged = list => {
        const current = list?.[id];
        if ((current?.revision || 0) !== originalAssetRevision
          || (current?.annotations[c.conversationId]?.revision || 0) !== originalRevision) fail();
      };
      if (previous && qualified(previous, previous.annotations[c.conversationId])) {
        // A second URL with the same content only adds original event evidence;
        // it cannot manufacture a new meaning, policy grant or visual attempt.
        await transact(root => {
          check(); const list = assets(root, c), a = list?.[id]?.annotations[c.conversationId];
          if (!a || denied(list, media.sha256)) return;
          unchanged(list); appendEvidence(root, list, list[id], key);
        });
        check(); continue;
      }
      // No source URL/file/summary is supplied as model instructions or authority.
      const description = validateStickerDescription(await describeImage(ctx, media, { signal, usageContext })); check();
      if (!description.sticker || !description.safeToReuse) continue;
      if (denied(assets(readState(), c), media.sha256)) continue;
      unchanged(assets(readState(), c));
      let cached = false;
      if (mediaCache) { check(); cached = await mediaCache.put(c.logicalId, media) === true; check(); if (!cached) fail(); }
      // Only unsigned, public transport may be a persistent no-cache fallback.
      // Query-bearing QQ URLs may be credentials even with unfamiliar key names.
      if (!cached && (transport.search || redactText(url) !== url)) fail();
      await transact(root => {
        check(); const list = assets(root, c, true), old = list[id], a = old?.annotations[c.conversationId];
        if (denied(list, media.sha256) || old?.blocked || old?.denied || a?.status === 'rejected' || a?.blocked || a?.denied) return;
        unchanged(list);
        if ((!old && Object.keys(list).length >= 500)
          || (old && old.sha256 !== media.sha256)) fail();
        const evidence = evidenceFor(a);
        const evidenceRevision = (a?.evidenceRevision || 0) + 1;
        const annotation = { ...a, conversationId: c.conversationId, revision: (a?.revision || 0) + 1,
          status: a?.status || 'candidate', note: description.note, tags: description.tags,
          sha256: media.sha256, sentCount: a?.sentCount || 0, receipts: a?.receipts || {}, updatedAt: clock(),
          usage: description.usage, avoid: description.avoid, evidence, evidenceRevision,
          // Version describes durable qualification criteria, NOT the ephemeral
          // account/session/control epoch. Current opt-in is checked at use time.
          automatic: { eligible: knownContext && description.confidence >= 0.8 && meaningful(description.usage),
            sha256: media.sha256, evidenceRevision, qualificationVersion: 1 } };
        list[id] = { ...old, id, source: 'group-observed', trust: 'untrusted', desc: '',
          active: old?.active ?? true, revision: (old?.revision || 0) + 1, sha256: media.sha256,
          ...(cached ? { cacheSha256: media.sha256 } : {}),
          annotations: { ...old?.annotations, [c.conversationId]: annotation } };
        // Cached observations need no expiring/signed transport in ordinary backup.
        if (cached) delete list[id].url; else list[id].url = url;
        book(root, c).claims[key].assetId = id;
        validateStickerStore(root.memory.socialExpressionAssets, c.logicalId);
      });
      check();
    }
  }
  async function observe(ctx, input, { signal } = {}) {
    try {
      const c = allowed(ctx, signal);
      if (Array.isArray(input?.refs) && input.refs.length === 0) return { ok: true, admitted: false, reason: 'no-images' };
      if (!fields(input, ['messageId', 'userId', 'sentAt', 'receivedAt', 'refs', 'context', 'text', 'isBot'])
        || input.isBot !== false || !msg(input.messageId) || !qq(input.userId) || !sourceFresh(input)
        || typeof input.text !== 'string' || input.text.length > 4000 || !Array.isArray(input.refs)
        || !input.refs.length || input.refs.length > 2 || !Array.isArray(input.context) || input.context.length > 6) fail();
      const refs = Array.from(input.refs).map((r, index) => {
        if (!fields(r, ['kind', 'url', 'file', 'summary', 'subType']) || !['image', 'mface', 'bface', 'marketface'].includes(r.kind)
          || (r.file !== undefined && (typeof r.file !== 'string' || r.file.length > 2048))
          || (!r.url && !r.file)) fail();
        if (r.url) publicMediaUrl(r.url);
        return { kind: r.kind, index, ...(r.url ? { url: r.url } : {}), ...(r.file ? { file: r.file } : {}) };
      });
      if (Array.from(input.context).some(e => !fields(e, ['messageId', 'userId', 'sentAt', 'text']) || !msg(e.messageId)
        || !qq(e.userId) || !uint(e.sentAt) || typeof e.text !== 'string' || e.text.length > 4000)) fail();
      // Copies prevent callers mutating a queued event into a different source.
      const copy = structuredClone({ ...input, refs });
      if (waiting.filter(j => j.logicalId === c.logicalId).length + (active?.logicalId === c.logicalId ? 1 : 0) >= 16
        || waiting.length >= 128) return { ok: true, admitted: false, reason: 'capacity' };
      const abort = new AbortController(), cancel = () => abort.abort();
      const stats = diagnostic(c.logicalId);
      signal?.addEventListener('abort', cancel, { once: true });
      waiting.push({ owner, logicalId: c.logicalId, abort, detach: () => signal?.removeEventListener('abort', cancel),
        current: () => { allowed(ctx, abort.signal); if (!sourceFresh(copy)) fail(); },
        settle: (ok, code) => {
          const k = ok ? 'completed' : 'failed'; stats[k] = Math.min(Number.MAX_SAFE_INTEGER, stats[k] + 1);
          if (!ok) stats.lastErrorCode = code || (!sourceFresh(copy) ? 'SOURCE_EXPIRED'
            : abort.signal.aborted ? 'ABORTED' : 'STICKER_LEARNING_FAILED');
        },
        run: s => run(ctx, copy, s) });
      pump();
      return { ok: true, admitted: true };
    } catch { return { ok: false, admitted: false, reason: 'unavailable' }; }
  }
  function learningStatus(ctx) {
    try {
      const c = guard(ctx), b = book(readState(), c), day = new Date(clock() + 8 * 3600000).toISOString().slice(0, 10);
      return { ok: true, enabled: !!(c.policy.enabled && !c.policy.shadowMode && c.policy.stickers.groupLearning
        && c.policy.stickers.enabled && c.policy.stickers.visionLearning && c.conversationId.startsWith('group:')),
        queued: waiting.filter(j => j.owner === owner && j.logicalId === c.logicalId).length,
        active: active?.owner === owner && active?.logicalId === c.logicalId ? 1 : 0,
        observed: Object.keys(b?.claims || {}).length, dailyDownloads: b?.days[day] || 0,
        downloadLimit: c.policy.stickers.maxDailyDownloads,
        ...(diagnostics.get(c.logicalId) || { completed: 0, failed: 0, lastErrorCode: null }) };
    } catch { return { ok: false, enabled: false, queued: 0, active: 0, observed: 0, dailyDownloads: 0, downloadLimit: 0,
      completed: 0, failed: 0, lastErrorCode: null }; }
  }
  function cancelLearning(logicalId) {
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].owner === owner && (!logicalId || waiting[i].logicalId === logicalId)) {
      const [job] = waiting.splice(i, 1); job.abort.abort(); job.detach(); job.settle(false, 'ABORTED');
    }
    if (active?.owner === owner && (!logicalId || active.logicalId === logicalId)) active.abort.abort();
    notifyIdle();
  }
  return { observe, learningStatus, cancelLearning,
    whenIdle: () => !active && !waiting.length ? Promise.resolve() : new Promise(done => idleWaiters.push(done)) };
}
