import { createHash } from 'node:crypto';
import { createPublicMediaReader, publicMediaUrl, validateImage } from './public-media.js';
import { redactText } from './privacy-filter.js';

const fail = code => Object.assign(new Error(code), { code });
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const map = v => plain(v) && Object.keys(v).every(k => !['__proto__', 'constructor', 'prototype'].includes(k));
const own = (v, k) => Object.hasOwn(v, k);
const idOK = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const logicalOK = v => typeof v === 'string' && /^(account|group):[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v);
const scopeOK = v => typeof v === 'string' && /^(group|private):[1-9]\d{0,19}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
// Redact BEFORE truncation so a boundary cannot retain half a credential.
const text = (v, max = 200) => typeof v === 'string' ? [...redactText(v.replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff]+/g, ' ').trim())].slice(0, max).join('') : '';
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const digestOK = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

// Unknown persisted fields remain inert data. Never repair a malformed known
// field into an empty library. All new values are explicit allowlist projections.
export function validateStickerStore(store, logicalId) {
  if (!plain(store) || store.version !== 1 || !map(store.bots)) throw fail('STICKER_SCHEMA');
  // The envelope is shared; individual account libraries are fault domains.
  // Do not traverse, repair or normalize a different logical identity's data.
  if (own(store.bots, logicalId)) {
    const bot = store.bots[logicalId];
    if (!plain(bot) || !map(bot.stickers) || !map(bot.capabilities)
      || (bot.collectionRevision !== undefined && !integer(bot.collectionRevision))) throw fail('STICKER_SCHEMA');
    if (bot.capabilities.collection !== undefined && !['supported', 'unsupported'].includes(bot.capabilities.collection)) throw fail('STICKER_SCHEMA');
    if (Object.keys(bot.stickers).length > 500) throw fail('STICKER_CAPACITY');
    let annotations = 0, receipts = 0;
    for (const [id, asset] of Object.entries(bot.stickers)) {
      if (!idOK(id) || !plain(asset) || asset.id !== id || typeof asset.desc !== 'string'
        || asset.trust !== 'untrusted' || typeof asset.active !== 'boolean' || !integer(asset.revision) || asset.revision < 1
        || !map(asset.annotations) || (asset.sha256 !== undefined && !digestOK(asset.sha256))) throw fail('STICKER_SCHEMA');
      if (asset.url !== undefined) { try { publicMediaUrl(asset.url); } catch { throw fail('STICKER_SCHEMA'); } }
      else if (asset.source !== 'group-observed' || !digestOK(asset.cacheSha256) || asset.sha256 !== asset.cacheSha256) throw fail('STICKER_SCHEMA');
      if (asset.source !== undefined && !['collection', 'group-observed'].includes(asset.source)) throw fail('STICKER_SCHEMA');
      if (asset.cacheSha256 !== undefined && (!digestOK(asset.cacheSha256) || asset.cacheSha256 !== asset.sha256)) throw fail('STICKER_SCHEMA');
      annotations += Object.keys(asset.annotations).length;
      if (annotations > 1000) throw fail('STICKER_CAPACITY');
      for (const [scope, a] of Object.entries(asset.annotations)) {
        if (!scopeOK(scope) || !plain(a) || a.conversationId !== scope || !integer(a.revision) || a.revision < 1
          || !['candidate', 'confirmed', 'rejected'].includes(a.status) || !digestOK(a.sha256)
          || typeof a.note !== 'string' || !Array.isArray(a.tags) || a.tags.some(t => typeof t !== 'string')
          || !integer(a.sentCount) || !map(a.receipts) || a.sentCount !== Object.keys(a.receipts).length
          || (a.status === 'confirmed' && (typeof a.actor !== 'string' || !a.actor.trim()))) throw fail('STICKER_SCHEMA');
        receipts += Object.keys(a.receipts).length;
        if (receipts > 10000) throw fail('STICKER_CAPACITY');
        for (const [messageId, receipt] of Object.entries(a.receipts)) {
          if (!/^-?[1-9]\d{0,19}$/.test(messageId) || !plain(receipt) || !integer(receipt.at)) throw fail('STICKER_SCHEMA');
        }
        if (a.evidence !== undefined && (!Array.isArray(a.evidence) || !a.evidence.length || a.evidence.length > 8
          || !integer(a.evidenceRevision) || a.evidenceRevision < 1 || a.evidence.some(e => !plain(e)
            || !/^-?[1-9]\d{0,19}$/.test(e.messageId) || !/^[1-9]\d{0,19}$/.test(e.userId)
            || !integer(e.sentAt) || !integer(e.receivedAt)))) throw fail('STICKER_SCHEMA');
        if (a.automatic !== undefined && (!plain(a.automatic) || typeof a.automatic.eligible !== 'boolean'
          || !digestOK(a.automatic.sha256) || !integer(a.automatic.evidenceRevision)
          || a.automatic.qualificationVersion !== 1
          || typeof a.usage !== 'string' || !Array.isArray(a.avoid) || a.avoid.some(x => typeof x !== 'string'))) throw fail('STICKER_SCHEMA');
      }
    }
  }
  return store;
}

// Host-produced qualification is separate from an administrator's decision.
export function stickerAutoEligible(asset, a, ctx) {
  const p = ctx.policy;
  return !!(asset.source === 'group-observed' && a && a.status === 'candidate' && !a.blocked && !a.denied
    && asset.active && !asset.blocked && !asset.denied && p?.enabled && !p.shadowMode && p.stickers?.enabled
    && p.stickers.groupLearning === true && p.stickers.autonomousEligibility === true
    && p.conversationIds?.includes(ctx.conversationId) && ctx.conversationId.startsWith('group:')
    && a.automatic?.eligible === true && a.automatic.sha256 === asset.sha256 && a.sha256 === asset.sha256
    && a.automatic.evidenceRevision === a.evidenceRevision && a.automatic.qualificationVersion === 1
    && a.evidence?.length && a.usage?.trim());
}

/** Isolated, host-only API. NOT a model tool surface.
 * ctx = host-issued {logicalId,conversationId,...}; isCurrent MUST synchronously
 * authenticate issuance AND current route/control/quiet policy (not just shape).
 * transact(builder) supplies the latest private root; builder is synchronous,
 * resolves only after durable publication; readState() returns that root.
 * Actor is a host-authenticated principal string, never a model assertion.
 * downloadImage(url,{signal}) is a trusted seam with the public-media contract;
 * describeImage(ctx,{buffer,mimeType,sha256},{signal}) returns {note,tags?}.
 * Official signed CDN URLs retain necessary query parameters for downloading;
 * they are transport-only, never prompt evidence or UI/model library fields.
 * Official desc and vision note/tags are untrusted redacted text, not authority.
 * No send/add/modify API exists. markSent is ONLY for host-confirmed OneBot ACKs.
 */
export function createStickerService({ request, transact, readState, isCurrent, describeImage, mediaCache, policyFor = ctx => ctx.policy, downloadImage = createPublicMediaReader(), clock = Date.now }) {
  if ([request, transact, readState, isCurrent, describeImage, downloadImage, clock].some(f => typeof f !== 'function')) throw fail('STICKER_DEPENDENCY');
  const context = (ctx, signal) => {
    if (!plain(ctx) || !logicalOK(ctx.logicalId) || !scopeOK(ctx.conversationId)) throw fail('STICKER_CONTEXT');
    const logicalId = ctx.logicalId, conversationId = ctx.conversationId;
    const guard = () => {
      if (signal?.aborted) throw fail('STICKER_ABORTED');
      if (ctx.logicalId !== logicalId || ctx.conversationId !== conversationId || isCurrent(ctx) !== true) throw fail('STICKER_STALE');
    };
    guard();
    return { logicalId, conversationId, guard, ctx: { logicalId, conversationId, revision: ctx.revision, policy: policyFor(ctx) } };
  };
  function store(root, c, create = false) {
    if (!plain(root) || !plain(root.memory)) throw fail('STICKER_SCHEMA');
    if (!own(root.memory, 'socialExpressionAssets')) {
      if (!create) return { version: 1, bots: {} };
      root.memory.socialExpressionAssets = { version: 1, bots: {} };
    }
    return validateStickerStore(root.memory.socialExpressionAssets, c.logicalId);
  }
  const now = () => { const n = clock(); if (!integer(n)) throw fail('STICKER_CLOCK'); return n; };
  const getBot = (root, c, create = false) => {
    const data = store(root, c, create);
    if (!own(data.bots, c.logicalId) && create) data.bots[c.logicalId] = { stickers: {}, capabilities: {} };
    return data.bots[c.logicalId];
  };
  const assetAt = (root, c, id) => {
    if (!idOK(id)) throw fail('STICKER_ID');
    const asset = getBot(root, c)?.stickers[id];
    if (!asset?.active) throw fail('STICKER_UNAVAILABLE');
    return asset;
  };
  const commit = async (c, builder) => {
    const result = await transact(root => {
      c.guard(); store(root, c);
      const value = builder(root);
      store(root, c); // Reject this account's invalid output before commit.
      return value;
    });
    c.guard();
    return result;
  };
  const projected = (asset, scope, ctx) => ({ id: asset.id, source: asset.source || 'collection', autoEligible: stickerAutoEligible(asset, asset.annotations[scope], ctx), official: { url: asset.url, desc: asset.desc, trust: 'untrusted' },
    annotation: asset.annotations[scope] ? structuredClone(asset.annotations[scope]) : null });
  async function image(c, url, signal) {
    publicMediaUrl(url);
    const downloaded = await downloadImage(url, { signal }); c.guard();
    const result = validateImage(downloaded?.buffer, downloaded?.mimeType);
    return { ...result, sha256: hash(result.buffer) };
  }
  async function assetImage(c, asset, signal) {
    if (mediaCache && asset.cacheSha256) {
      const cached = await mediaCache.read(c.logicalId, asset.cacheSha256); c.guard();
      if (cached) {
        const checked = validateImage(cached.buffer, cached.mimeType), sha256 = hash(checked.buffer);
        if (sha256 !== asset.cacheSha256) throw fail('STICKER_CONFLICT');
        return { ...checked, sha256 };
      }
    }
    return image(c, asset.url, signal);
  }
  function approved(root, c, id) {
    const asset = assetAt(root, c, id), a = asset.annotations[c.conversationId];
    if (!a || a.blocked || a.denied || asset.blocked || asset.denied || a.conversationId !== c.conversationId
      || (a.status !== 'confirmed' && !stickerAutoEligible(asset, a, c.ctx))) throw fail('STICKER_NOT_CONFIRMED');
    return { asset, a };
  }
  function requireReceiptRoom(root, c) {
    const bot = getBot(root, c);
    let total = 0;
    for (const asset of Object.values(bot?.stickers || {})) {
      for (const annotation of Object.values(asset.annotations)) total += annotation.sentCount;
    }
    if (total >= 10000) throw fail('STICKER_CAPACITY');
  }
  return Object.freeze({
    async sync(ctx, { signal } = {}) {
      const c = context(ctx, signal), collectionRevision = getBot(readState(), c)?.collectionRevision || 0;
      const syncBot = root => {
        const bot = getBot(root, c, true);
        if ((bot.collectionRevision || 0) !== collectionRevision) throw fail('STICKER_CONFLICT');
        bot.collectionRevision = collectionRevision + 1;
        return bot;
      };
      const response = await request(ctx, 'fetch_custom_face_detail', { count: 100 }, { signal }); c.guard();
      if (response?.retcode === 1404 || response?.retcode === 404) {
        await commit(c, root => { syncBot(root).capabilities.collection = 'unsupported'; });
        return { supported: false };
      }
      if (response?.status !== 'ok' || response.retcode !== 0 || !Array.isArray(response.data) || response.data.length > 100) throw fail('STICKER_SYNC_FAILED');
      const seen = new Set();
      const entries = response.data.map(item => {
        if (!plain(item) || !idOK(String(item.emoji_id ?? '')) || typeof item.url !== 'string' || (item.desc !== undefined && typeof item.desc !== 'string')) throw fail('STICKER_PROTOCOL');
        const id = String(item.emoji_id); publicMediaUrl(item.url);
        if (seen.has(id)) throw fail('STICKER_PROTOCOL'); seen.add(id);
        return { id, url: item.url, desc: text(item.desc), trust: 'untrusted' };
      });
      await commit(c, root => {
        const bot = syncBot(root);
        bot.capabilities.collection = 'supported';
        for (const entry of entries) {
          const previous = bot.stickers[entry.id];
          if (previous?.source === 'group-observed') throw fail('STICKER_CONFLICT');
          // A new URL/remark invalidates prior approvals; keep tombstones and
          // receipts for audit, but require fresh vision + admin confirmation.
          if (previous && (previous.url !== entry.url || previous.desc !== entry.desc || !previous.active)) {
            for (const a of Object.values(previous.annotations)) { if (a.status !== 'rejected') { a.status = 'candidate'; delete a.actor; } a.revision++; }
          }
          bot.stickers[entry.id] = { ...previous, ...entry, active: true, revision: (previous?.revision || 0) + 1, annotations: previous?.annotations || {} };
        }
        // Exactly count=100 cannot prove completeness; never delete from it.
        if (entries.length < 100) for (const a of Object.values(bot.stickers)) if (a.source !== 'group-observed' && !seen.has(a.id)) { a.active = false; a.revision++; }
      });
      return { supported: true, count: entries.length, complete: entries.length < 100 };
    },
    async annotate(ctx, { id, signal } = {}) {
      const c = context(ctx, signal), original = structuredClone(assetAt(readState(), c, id));
      const media = await assetImage(c, original, signal); c.guard();
      const description = await describeImage(ctx, media, { signal }); c.guard();
      const note = text(description?.note);
      if (!note || !plain(description) || (description.tags !== undefined && (!Array.isArray(description.tags) || description.tags.some(t => typeof t !== 'string')))) throw fail('STICKER_VISION');
      return commit(c, root => {
        const asset = assetAt(root, c, id), old = asset.annotations[c.conversationId];
        if (asset.revision !== original.revision || (old?.revision || 0) !== (original.annotations[c.conversationId]?.revision || 0)) throw fail('STICKER_CONFLICT');
        const annotation = { ...old, conversationId: c.conversationId, revision: (old?.revision || 0) + 1, status: old?.status === 'rejected' ? 'rejected' : 'candidate',
          note, tags: (description.tags || []).slice(0, 16).map(t => text(t, 32)), sha256: media.sha256,
          sentCount: old?.sentCount || 0, receipts: old?.receipts || {}, updatedAt: now() };
        if (annotation.status !== 'rejected') delete annotation.actor;
        delete annotation.automatic;
        asset.annotations[c.conversationId] = annotation;
        return structuredClone(annotation);
      });
    },
    async review(ctx, { id, expectedRevision, status, actor } = {}) {
      const c = context(ctx);
      if (!integer(expectedRevision) || !['confirmed', 'rejected'].includes(status) || typeof actor !== 'string' || !actor.trim() || actor.length > 128) throw fail('STICKER_REVIEW');
      return commit(c, root => {
        const a = assetAt(root, c, id).annotations[c.conversationId];
        if (!a || a.revision !== expectedRevision) throw fail('STICKER_CONFLICT');
        a.status = status; a.actor = actor; a.revision++; a.updatedAt = now();
        if (status === 'confirmed') { delete a.blocked; delete a.denied; }
        return structuredClone(a);
      });
    },
    list(ctx) {
      const c = context(ctx), bot = getBot(readState(), c);
      return Object.values(bot?.stickers || {}).filter(a => a.active && (a.source !== 'group-observed' || a.annotations[c.conversationId])).map(a => projected(a, c.conversationId, c.ctx));
    },
    candidates(ctx, { query = '', serious = false, limit = 3 } = {}) {
      const c = context(ctx), bot = getBot(readState(), c);
      if (typeof query !== 'string' || typeof serious !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw fail('STICKER_QUERY');
      if (serious) return [];
      const q = text(query).toLowerCase();
      return Object.values(bot?.stickers || {}).filter(asset => {
        const a = asset.annotations[c.conversationId];
        return asset.active && !asset.blocked && !asset.denied && !a?.blocked && !a?.denied
          && (a?.status === 'confirmed' || stickerAutoEligible(asset, a, c.ctx)) && (!q || `${a.note} ${a.tags.join(' ')} ${a.usage || ''}`.toLowerCase().includes(q));
      }).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(a => ({ id: a.id, ...structuredClone(a.annotations[c.conversationId]) }));
    },
    async prepare(ctx, { id, signal } = {}) {
      try {
        const c = context(ctx, signal), root = readState(), { asset, a } = approved(root, c, id);
        requireReceiptRoom(root, c); // Do not send an image whose ACK cannot fit.
        const revision = a.revision, assetRevision = asset.revision, expectedHash = a.sha256;
        const media = await assetImage(c, asset, signal); c.guard();
        const latest = readState(), current = approved(latest, c, id);
        requireReceiptRoom(latest, c); // Another ACK may have filled it during download.
        if (current.a.revision !== revision || current.asset.revision !== assetRevision || media.sha256 !== expectedHash) throw fail('STICKER_CONFLICT');
        return { segment: { type: 'image', data: { file: `base64://${media.buffer.toString('base64')}` } } };
      } catch (error) { return { segment: null, errorCode: /^STICKER_|^MEDIA_/.test(error?.code || '') ? error.code : 'STICKER_MEDIA_FAILED' }; }
    },
    async markSent(ctx, { id, messageId } = {}) {
      const c = context(ctx);
      if (typeof messageId !== 'string' || !/^-?[1-9]\d{0,19}$/.test(messageId)) throw fail('STICKER_ACK_REQUIRED');
      return commit(c, root => {
        // A confirmed wire ACK is a historical fact, not fresh send authority.
        // Approval/active state may have changed while OneBot's ACK was pending.
        // Keep the current annotation's audit trail without re-approving it.
        if (!idOK(id)) throw fail('STICKER_ID');
        const bot = getBot(root, c), a = bot?.stickers[id]?.annotations[c.conversationId];
        if (!a) throw fail('STICKER_UNAVAILABLE');
        for (const asset of Object.values(bot.stickers)) {
          if (own(asset.annotations[c.conversationId]?.receipts || {}, messageId)) {
            if (asset.id !== id) throw fail('STICKER_RECEIPT_CONFLICT');
            return { counted: false };
          }
        }
        if (Object.keys(a.receipts).length >= 10000) throw fail('STICKER_CAPACITY');
        if (!Number.isSafeInteger(a.sentCount + 1)) throw fail('STICKER_RECEIPT_LIMIT');
        a.receipts[messageId] = { at: now() }; a.sentCount++;
        return { counted: true };
      });
    }
  });
}
