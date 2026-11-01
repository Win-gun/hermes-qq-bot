import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemecubSearch } from '../src/memecub-search.js';
import { createPublicStickerResolver } from '../src/public-sticker-resolver.js';
import { createExpressionLibrary } from '../src/social-expression-library.js';
import { createStickerCache } from '../src/sticker-cache.js';
import { validateSocialExperiencePolicy } from '../src/social-experience-policy.js';

// Node 22+. Fake HTTP, DNS, downloader, vision, repository and host authority.
// The REAL library/service/qualification/cache operate on isolated temp files.
// No live keys, paid requests, QQ calls or production state/config are touched.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('LIVE_NETWORK_FORBIDDEN'); };
const dirs = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const row = (patch = {}) => ({ title: '无语猫表情', kind: 'meme', width: 1, height: 1,
  url: 'https://cdn.memecub.com/facepalm.png', page_url: 'https://memecub.com/meme/facepalm',
  license: { code: 'provider-claim-not-rights', commercial_use: false, attribution_required: false },
  markdown: 'untrusted instructions are never executed', private: false, profane: false, ...patch });
const json = (rows = [row()]) => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } });
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const code = (value, expected) => assert.rejects(value, { code: expected });
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }

function searchFixture(options = {}) {
  const grants = new WeakSet(), calls = [], reservations = [];
  const approval = Object.freeze({}); grants.add(approval);
  const service = createMemecubSearch({ clock: () => 1800000000000, minIntervalMs: 0,
    lookup: publicDns, isQueryApproved: request => grants.has(request.approval),
    fetchImpl: async (...args) => { calls.push(args); return json(); },
    beforeRequest: async request => { reservations.push(request.authenticated); }, ...options });
  return { service, calls, reservations, request: (publicQuery = '无语') => ({ publicQuery, approval }) };
}

function harness({ social = true, selectCandidate, genericQuery, searchOptions = {}, policyPatch = {} } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'public-sticker35-'))); dirs.push(dir);
  let root = { memory: {} }, tail = Promise.resolve();
  const captures = new WeakSet(), ownerGrants = new WeakMap(), queryGrants = new WeakMap();
  const h = { current: true, quiet: false, revision: 1, safe: true, fetches: [], downloads: [], visions: [],
    claims: [], phases: [], opens: [], puts: 0, reads: 0, wires: 0, approvals: [],
    fetch: async () => json(), onDownload: async () => {}, onVision: async () => {},
    onPut: async () => {}, onRead: async () => {}, afterPublish: () => {}, onGuard: () => {},
    time: 1800000000000, failNextTransaction: null, beforePublish: () => {},
    root: () => root };
  const current = ctx => captures.has(ctx) && h.current && !h.quiet && h.revision === ctx.revision;
  const basePolicy = () => validateSocialExperiencePolicy({ enabled: social, shadowMode: false,
    conversationIds: social ? ['group:1', 'group:2', 'private:1'] : [], stickers: { enabled: social,
      autoSend: social, autonomousSelection: social, webSearch: social, maxDailyVisionCalls: 40 }, ...policyPatch });
  const cache = createStickerCache({ baseDir: path.join(dir, 'cache') });
  h.cache = cache; h.dir = dir;
  const mediaCache = {
    async put(...args) { h.puts++; await h.onPut(...args); return cache.put(...args); },
    async read(...args) { h.reads++; await h.onRead(...args); return cache.read(...args); }
  };
  const libraryOptions = {
    readState: () => root,
    transact: builder => {
      const result = tail.then(() => {
        const draft = structuredClone(root), result = builder(draft);
        assert.ok(!result?.then, 'latest-draft builder must stay synchronous');
        h.beforePublish(draft);
        const failure = h.failNextTransaction; h.failNextTransaction = null;
        if (failure === 'before') throw new Error('SYNTHETIC_PUBLICATION_FAILED');
        root = draft; h.afterPublish();
        if (failure === 'after') throw new Error('SYNTHETIC_PUBLICATION_UNCERTAIN');
        return result;
      });
      tail = result.catch(() => {}); return result;
    },
    capture: (accountId, conversationId, options) => {
      h.opens.push(options);
      let policy = basePolicy();
      if (options !== undefined) {
        const grant = ownerGrants.get(options);
        if (!grant || grant.accountId !== accountId || grant.conversationId !== conversationId
          || grant.used || grant.revision !== h.revision) throw Object.assign(new Error('denied'), { code: 'EXPRESSION_SCOPE' });
        grant.used = true;
        policy = validateSocialExperiencePolicy({ enabled: true, shadowMode: false, conversationIds: [conversationId],
          stickers: { enabled: true, autoSend: true, autonomousSelection: true, webSearch: true, maxDailyVisionCalls: 40 } });
      }
      const ctx = { accountId, logicalId: `account:${accountId}`, conversationId, revision: h.revision,
        policy, authority: options === undefined ? 'social' : 'owner-content-only' };
      captures.add(ctx); return ctx;
    },
    isCurrent: current, mediaCache, clock: () => h.time,
    request: async () => { h.wires++; throw new Error('QQ_FORBIDDEN'); },
    downloadImage: async (url, opts) => { h.downloads.push(url); await h.onDownload(opts); return { buffer: png, mimeType: 'image/png' }; },
    describeImage: async (ctx, media, opts) => {
      h.visions.push(ctx); assert.equal(media.sha256, sha256); assert.deepEqual(media.buffer, png);
      await h.onVision(ctx, opts);
      return { sticker: true, safeToReuse: h.safe, confidence: 0.95, note: '无语猫表情',
        tags: ['无语', '表情'], usage: '无语时轻松回应', avoid: [] };
    }
  };
  const lib = createExpressionLibrary(libraryOptions);
  const search = createMemecubSearch({ clock: () => 1800000000000, minIntervalMs: 0, lookup: publicDns,
    isQueryApproved: request => {
      const grant = queryGrants.get(request.approval);
      return !!grant && grant.query === request.publicQuery && current(grant.ctx) && !grant.signal?.aborted;
    },
    beforeRequest: async request => { h.claims.push(request.authenticated); },
    fetchImpl: async (...args) => { h.fetches.push(args); return h.fetch(...args); }, ...searchOptions });
  const resolver = createPublicStickerResolver({ library: lib, search, genericQuery, selectCandidate,
    guard: (scope, opts) => {
      h.phases.push(opts.phase); h.onGuard(scope, opts);
      return h.current && !h.quiet && (!opts.context || current(opts.context))
        && (!opts.context || opts.context.accountId === scope.accountId && opts.context.conversationId === scope.conversationId);
    },
    approveQuery: request => {
      h.approvals.push(request.publicQuery);
      if (request.publicQuery.includes('小明') || request.publicQuery.length > 40)
        throw Object.assign(new Error('private'), { code: 'PUBLIC_STICKER_QUERY' });
      const approval = Object.freeze({});
      queryGrants.set(approval, { query: request.publicQuery, ctx: request.context, signal: request.signal });
      return { publicQuery: request.publicQuery, approval };
    }
  });
  h.lib = lib; h.recreate = () => createExpressionLibrary(libraryOptions); h.search = search; h.resolver = resolver;
  h.issueOwner = (accountId = 'alpha', conversationId = 'private:1') => {
    const options = Object.freeze({}); ownerGrants.set(options, { accountId, conversationId, used: false, revision: h.revision }); return options;
  };
  h.resolve = (patch = {}, opts) => resolver.resolve({ accountId: 'alpha', conversationId: 'group:1', query: '无语', ...patch }, opts);
  h.assets = (accountId = 'alpha') => root.memory.socialExpressionAssets?.bots?.[`account:${accountId}`]?.stickers || {};
  h.reject = async (id, conversationId = 'group:1') => {
    const ctx = lib.open('alpha', conversationId), snapshot = lib.snapshot(ctx);
    const result = await lib.operate(ctx, 'review-sticker', { expectedStateRevision: snapshot.revision,
      conversationId, id, expectedRevision: h.assets()[id].annotations[conversationId].revision, status: 'rejected' });
    assert.equal(result.ok, true);
  };
  return h;
}

const publicPolicy = maxDailyDownloads => ({ enabled: true, autoSend: true, autonomousSelection: true,
  webSearch: true, visionLearning: true, groupLearning: true, maxDailyDownloads, maxDailyVisionCalls: 40 });
const publicMetadata = (url = row().url) => ({ provider: 'memecub', url, pageUrl: row().page_url,
  license: row().license, publicQuery: '无语' });
const downloadDay = h => new Date(h.time + 28800000).toISOString().slice(0, 10);
const downloadCount = (h, logicalId = 'account:alpha') => h.root().memory.groupStickerLearning?.bots?.[logicalId]?.days[downloadDay(h)] || 0;
const importFixture = (h, { accountId = 'alpha', conversationId = 'group:1', url, signal } = {}) =>
  h.lib.importPublic(h.lib.open(accountId, conversationId), publicMetadata(url), { signal });

try {
  await test('public downloads reserve the shared durable ledger before dispatch, never fake vision/QQ observations', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } });
    h.onDownload = async () => {
      assert.equal(downloadCount(h), 1, 'the claim is durably published before dispatch');
      assert.equal(h.root().memory.socialExpressionLibrary, undefined, 'no fake vision claim at download time');
      assert.deepEqual(h.root().memory.groupStickerLearning.bots['account:alpha'].claims, {});
    };
    await importFixture(h);
    const ctx = h.lib.open('alpha', 'group:1');
    assert.equal(h.lib.learningStatus(ctx).dailyDownloads, 1, 'same existing ledger/status, not a second budget');
    assert.equal(h.lib.snapshot(ctx).dailyVisionCalls.attempted, 1, 'only actual image qualification counts');
    assert.equal(h.lib.learningStatus(ctx).observed, 0, 'public bytes are not fake group observations');
  });

  await test('maxDailyDownloads zero refuses before download, vision, cache or ledger publication', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(0) } });
    await code(importFixture(h), 'STICKER_DOWNLOAD_BUDGET');
    assert.equal(h.downloads.length + h.visions.length + h.puts, 0);
    assert.deepEqual(h.root(), { memory: {} });
  });

  await test('public imports share group/account daily budget and survive service contexts without refunds', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } });
    await importFixture(h);
    await code(importFixture(h, { conversationId: 'group:2' }), 'STICKER_DOWNLOAD_BUDGET');
    assert.equal(h.downloads.length, 1);
    await importFixture(h, { accountId: 'beta' });
    assert.equal(downloadCount(h, 'account:beta'), 1); assert.equal(h.downloads.length, 2);
    h.time += 86400000;
    await importFixture(h);
    assert.equal(downloadCount(h), 1); assert.equal(h.downloads.length, 3);
    assert.equal(Object.keys(h.root().memory.groupStickerLearning.bots['account:alpha'].days).length, 1);
    h.time--;
    await code(importFixture(h), 'STICKER_CLOCK'); assert.equal(h.downloads.length, 3);
  });

  await test('a prior group-learning reservation denies public download; public reservation denies actual group learning', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } });
    h.root().memory.groupStickerLearning = { version: 1, bots: { 'account:alpha': { claims: {},
      days: { [downloadDay(h)]: 1 }, lastAt: h.time } } };
    await code(importFixture(h), 'STICKER_DOWNLOAD_BUDGET'); assert.equal(h.downloads.length, 0);
    const other = harness({ policyPatch: { stickers: publicPolicy(1) } }); await importFixture(other);
    const ctx = other.lib.open('alpha', 'group:1');
    const admitted = await other.lib.observe(ctx, { messageId: '10001', userId: '20001', sentAt: other.time, receivedAt: other.time,
      text: '这个表情太无语了', isBot: false, refs: [{ kind: 'image', url: 'https://cdn.memecub.com/other.png' }], context: [] });
    assert.equal(admitted.admitted, true); await other.lib.whenIdle();
    assert.equal(other.downloads.length, 1); assert.equal(downloadCount(other), 1);
    assert.equal(other.lib.learningStatus(ctx).failed, 1);
  });

  await test('real byte-cache prepare hit at exhausted cap is free; search metadata cache is not a byte download hit', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } }); await h.resolve();
    const offer = await h.resolve(); assert.equal(offer.source, 'local');
    await offer.prepare(offer.allowedIds[0]);
    assert.equal(h.reads, 1); assert.equal(downloadCount(h), 1); assert.equal(h.downloads.length, 1);
    // No eligible annotation for group 2, but the provider metadata is cached.
    await code(h.resolve({ conversationId: 'group:2' }), 'STICKER_DOWNLOAD_BUDGET');
    assert.equal(h.fetches.length, 1); assert.equal(h.claims.length, 1); assert.equal(h.downloads.length, 1);
  });

  await test('concurrent library instances/contexts cannot overdraw the one latest-draft download slot', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } });
    const second = h.recreate();
    const results = await Promise.allSettled([importFixture(h), second.importPublic(second.open('alpha', 'group:2'), publicMetadata())]);
    assert.equal(h.downloads.length, 1); assert.equal(downloadCount(h), 1);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'STICKER_DOWNLOAD_BUDGET');
  });

  await test('failed/uncertain claim publication never dispatches or creates a vision call', async () => {
    for (const failure of ['before', 'after']) {
      const h = harness({ policyPatch: { stickers: publicPolicy(1) } }); h.failNextTransaction = failure;
      await assert.rejects(importFixture(h));
      assert.equal(h.downloads.length + h.visions.length, 0);
      assert.equal(downloadCount(h), failure === 'after' ? 1 : 0);
      assert.equal(h.root().memory.socialExpressionLibrary, undefined);
      if (failure === 'after') await code(importFixture(h), 'STICKER_DOWNLOAD_BUDGET');
      assert.equal(h.downloads.length, 0);
    }
  });

  await test('quiet/stale/cancel after durable download claim stops dispatch and retains reservation', async () => {
    for (const mode of ['quiet', 'stale', 'cancel']) {
      const h = harness({ policyPatch: { stickers: publicPolicy(1) } }), abort = new AbortController();
      h.afterPublish = () => {
        if (mode === 'quiet') h.quiet = true;
        if (mode === 'stale') h.revision++;
        if (mode === 'cancel') abort.abort();
      };
      await assert.rejects(importFixture(h, { signal: abort.signal }));
      assert.equal(downloadCount(h), 1); assert.equal(h.downloads.length + h.visions.length, 0);
    }
  });

  await test('failed download is charged once with no hidden retry or fake vision attempt', async () => {
    const h = harness({ policyPatch: { stickers: publicPolicy(1) } });
    h.onDownload = async () => { throw new Error('SYNTHETIC_DOWNLOADER_FAILED'); };
    await assert.rejects(importFixture(h)); await code(importFixture(h), 'STICKER_DOWNLOAD_BUDGET');
    assert.equal(downloadCount(h), 1); assert.equal(h.downloads.length, 1); assert.equal(h.visions.length, 0);
  });

  await test('corrupt existing download books fail closed without replacing data or dispatch', async () => {
    for (const bad of [{ version: 2, bots: {} }, { version: 1, bots: { 'account:alpha': { claims: {}, days: { bad: 1 }, lastAt: 0 } } },
      { version: 1, bots: { 'account:alpha': { claims: {}, days: { '2026-01-01': -1 }, lastAt: 0 } } }]) {
      const h = harness(); h.root().memory.groupStickerLearning = structuredClone(bad);
      await code(importFixture(h), 'STICKER_SCHEMA');
      assert.deepEqual(h.root().memory.groupStickerLearning, bad); assert.equal(h.downloads.length, 0);
    }
  });

  await test('constructor/input/host-guard fail closed; model or selector errors cannot leak secret text', async () => {
    assert.throws(() => createPublicStickerResolver(), { code: 'PUBLIC_STICKER_OPTIONS' });
    const h = harness();
    for (const patch of [{ accountId: '../alpha' }, { conversationId: 'group:01' },
      { owner: true }, { query: null }, { query: 'a'.repeat(1001) }]) await code(h.resolve(patch), 'PUBLIC_STICKER_ARGUMENT');
    const guarded = createPublicStickerResolver({ library: h.lib, search: h.search,
      guard: async () => true, approveQuery: () => { throw new Error('must not approve'); } });
    await code(guarded.resolve({ accountId: 'alpha', conversationId: 'group:1', query: '无语' }), 'PUBLIC_STICKER_STALE');
    assert.equal(h.opens.length + h.fetches.length, 0);
    const failed = harness({ selectCandidate: async () => { throw new Error('private secret'); } });
    await code(failed.resolve(), 'PUBLIC_STICKER_UNAVAILABLE'); assert.equal(failed.downloads.length, 0);
  });

  await test('empty local -> remote metadata -> real bytes/hash/qualification/temp cache, never sends', async () => {
    const h = harness(); const offer = await h.resolve();
    assert.equal(offer.source, 'public_memecub'); assert.equal(offer.importedId, `public_${sha256}`);
    assert.deepEqual(offer.allowedIds, [`public_${sha256}`]); assert.equal(offer.sha256, sha256);
    assert.equal(h.downloads.length, 1); assert.equal(h.visions.length, 1); assert.equal(h.puts, 1);
    assert.deepEqual((await h.cache.read('account:alpha', sha256)).buffer, png);
    const asset = h.assets()[offer.importedId];
    assert.equal(asset.annotations['group:1'].status, 'candidate');
    assert.equal(asset.annotations['group:1'].reuseQualification.sha256, sha256);
    assert.equal(asset.provenance.license.code, 'provider-claim-not-rights');
    assert.equal(h.wires, 0); assert.equal(asset.annotations['group:1'].sentCount, 0);
    assert.equal(JSON.stringify(offer.candidates).includes('https://'), false);
    assert.equal('send' in offer, false);
  });

  await test('qualified local wins without new search/download/vision; prepare reads exact cached bytes', async () => {
    const h = harness(); await h.resolve(); const offer = await h.resolve();
    assert.equal(offer.source, 'local'); assert.equal(h.fetches.length, 1); assert.equal(h.downloads.length, 1);
    const prepared = await offer.prepare(offer.allowedIds[0]);
    assert.equal(prepared.segment.type, 'image');
    assert.equal(prepared.segment.data.file, `base64://${png.toString('base64')}`);
    assert.equal(h.reads, 1); assert.equal(h.downloads.length, 1);
    assert.match(offer.revision(), /^[a-f0-9]{64}$/);
  });

  await test('ACK cannot be forged before prepare; actual parent callback is durable/deduplicated, no second sender', async () => {
    const h = harness(), offer = await h.resolve(), id = offer.allowedIds[0];
    await code(offer.markSent(id, '123'), 'EXPRESSION_ACK');
    await offer.prepare(id); h.quiet = true;
    assert.equal((await offer.markSent(id, '123')).counted, true);
    assert.equal((await offer.markSent(id, '123')).counted, false);
    assert.equal(h.assets()[id].annotations['group:1'].sentCount, 1);
    assert.equal(h.wires, 0);
  });

  await test('selector receives actual bounded inert metadata; only a returned offered ID may import', async () => {
    let seen;
    const h = harness({ selectCandidate: async rows => { seen = rows;
      assert.equal(rows.length, 2); assert.equal(rows[1].title, '真实第二候选');
      assert.equal(rows[1].license.commercial_use, false); return rows[1].id; } });
    h.fetch = async () => json([row(), row({ title: '真实第二候选', url: 'https://cdn.memecub.com/second.png' })]);
    await h.resolve(); assert(Object.isFrozen(seen)); assert(Object.isFrozen(seen[0]));
    assert(Object.isFrozen(seen[0].license));
    assert.deepEqual(h.downloads, ['https://cdn.memecub.com/second.png']);
    const forged = harness({ selectCandidate: async () => 'https://evil.com/not-a-candidate.png' });
    await code(forged.resolve(), 'PUBLIC_STICKER_SELECTION'); assert.equal(forged.downloads.length, 0);
  });

  await test('selector refusal is not a retry; imported item is never automatically made available by URL ID', async () => {
    const h = harness({ selectCandidate: async () => null });
    const offer = await h.resolve(); assert.deepEqual(offer.allowedIds, []);
    assert.equal(offer.reason, 'SELECTION_DECLINED'); assert.equal(h.fetches.length, 1); assert.equal(h.downloads.length, 0);
    await code(offer.prepare('memecub_forged'), 'PUBLIC_STICKER_SELECTION');
  });

  await test('only empty results get at most one generic fallback; no recursive search', async () => {
    const h = harness(); h.fetch = async () => json([]);
    const result = await h.resolve(); assert.equal(result.reason, 'NO_REUSABLE_PUBLIC_STICKER');
    assert.deepEqual(h.approvals, ['无语', '表情']); assert.equal(h.fetches.length, 2);
    const same = harness(); same.fetch = async () => json([]); await same.resolve({ query: '表情' });
    assert.equal(same.fetches.length, 1);
    const disabled = harness({ genericQuery: null }); disabled.fetch = async () => json([]); await disabled.resolve();
    assert.equal(disabled.fetches.length, 1);
  });

  await test('generic fallback still needs real qualification and current semantic eligibility', async () => {
    const h = harness(); h.fetch = async url => new URL(url).searchParams.get('q') === '无语' ? json([]) : json();
    const result = await h.resolve(); assert.equal(result.allowedIds[0], `public_${sha256}`);
    assert.deepEqual(h.approvals, ['无语', '表情']); assert.equal(h.visions.length, 1);
  });

  await test('429 cooldown never triggers generic/anonymous/hot retry', async () => {
    const h = harness(); h.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
    await code(h.resolve(), 'MEMECUB_RATE_LIMIT'); await code(h.resolve(), 'MEMECUB_RATE_LIMIT');
    assert.equal(h.fetches.length, 1); assert.deepEqual(h.approvals, ['无语', '无语']);
    assert.equal(h.claims.length, 1); assert.equal(h.downloads.length, 0);
  });

  await test('source privacy/profanity/attribution/kind cannot become reusable local stickers', async () => {
    for (const patch of [{ private: true }, { profane: true }, { kind: 'photo' },
      { license: { code: 'CC-BY', commercial_use: true, attribution_required: true }, attribution: 'artist' }]) {
      const h = harness({ genericQuery: null }); h.fetch = async () => json([row(patch)]);
      assert.deepEqual((await h.resolve()).allowedIds, []); assert.equal(h.downloads.length, 0);
    }
    const h = harness(); await code(h.resolve({ query: '小明无语' }), 'PUBLIC_STICKER_QUERY');
    assert.equal(h.fetches.length, 0);
    await code(h.resolve({ query: 'token private' }), 'MEMECUB_QUERY'); assert.equal(h.fetches.length, 0);
  });

  await test('unsafe visual qualification cannot be replaced with metadata license claims', async () => {
    const h = harness(); h.safe = false;
    await code(h.resolve(), 'STICKER_PUBLIC_UNSAFE');
    assert.deepEqual(h.assets(), {}); assert.equal(h.puts, 0); assert.equal(h.fetches.length, 1);
  });

  await test('rejection wins across new URL/source aliases with identical actual hash', async () => {
    const h = harness(), offer = await h.resolve(); await h.reject(offer.importedId);
    const denied = h.assets()[offer.importedId];
    // Synthetic fixture only: old collection rejected the bytes under another ID.
    const alias = structuredClone(denied); alias.id = 'rejected_alias'; alias.source = 'collection'; alias.url = row().url;
    h.assets().rejected_alias = alias; delete h.assets()[offer.importedId];
    h.fetch = async () => json([row({ url: 'https://cdn.memecub.com/different.png' })]);
    await code(h.resolve({ query: '无语猫' }), 'STICKER_PUBLIC_REJECTED');
    assert.equal(h.visions.length, 1); assert.equal(h.assets().rejected_alias.annotations['group:1'].status, 'rejected');
    await code(offer.prepare(offer.allowedIds[0]), 'EXPRESSION_UNAVAILABLE');
  });

  await test('rejection arriving during vision is rechecked inside the durable latest-draft commit', async () => {
    const h = harness(), offer = await h.resolve();
    // Different query bypasses local semantic matching and reaches same bytes.
    h.assets()[offer.importedId].annotations['group:1'].tags = ['无语'];
    h.onVision = async () => { await h.reject(offer.importedId); };
    await code(h.resolve({ query: '搞笑大笑' }), 'STICKER_PUBLIC_REJECTED');
    assert.equal(h.assets()[offer.importedId].annotations['group:1'].status, 'rejected');
  });

  await test('stale/quiet/cancel before open has no search, import or host open side effect', async () => {
    for (const condition of ['current', 'quiet', 'cancel']) {
      const h = harness(), abort = new AbortController();
      if (condition === 'current') h.current = false;
      if (condition === 'quiet') h.quiet = true;
      if (condition === 'cancel') abort.abort();
      await code(h.resolve({}, { signal: abort.signal }), condition === 'cancel' ? 'PUBLIC_STICKER_ABORTED' : 'PUBLIC_STICKER_STALE');
      assert.equal(h.opens.length + h.fetches.length + h.downloads.length, 0);
    }
  });

  await test('guard surrounds host approval, HTTP, model selection, import and preparation awaits', async () => {
    for (const phase of ['approve-query', 'search', 'select-candidate', 'import-public']) {
      const h = harness({ selectCandidate: async rows => rows[0].id });
      let n = 0;
      h.onGuard = (_, opts) => { if (opts.phase === phase && ++n === 2) h.quiet = true; };
      await code(h.resolve(), 'PUBLIC_STICKER_STALE');
      assert.equal(h.wires, 0);
      if (phase === 'approve-query') assert.equal(h.fetches.length, 0);
      if (phase === 'search' || phase === 'select-candidate') assert.equal(h.downloads.length, 0);
    }
  });

  await test('quiet/identity/cancel during nested download, vision and cache awaits cannot yield an offer', async () => {
    for (const stage of ['onDownload', 'onVision', 'onPut']) for (const condition of ['quiet', 'revision', 'cancel']) {
      const h = harness(), abort = new AbortController();
      h[stage] = async () => {
        if (condition === 'quiet') h.quiet = true;
        if (condition === 'revision') h.revision++;
        if (condition === 'cancel') abort.abort();
      };
      await code(h.resolve({}, { signal: abort.signal }), condition === 'cancel' ? 'PUBLIC_STICKER_ABORTED' : 'PUBLIC_STICKER_STALE');
      assert.deepEqual(h.assets(), {}); assert.equal(h.wires, 0);
    }
  });

  await test('quiet after durable publication suppresses offer; stored bytes are not a send claim', async () => {
    const h = harness(); h.afterPublish = () => { if (Object.keys(h.assets()).length) h.quiet = true; };
    await code(h.resolve(), 'PUBLIC_STICKER_STALE'); assert.equal(h.wires, 0);
  });

  await test('prepare rechecks quiet, changed revision, cancellation, current rejection and cache bytes', async () => {
    for (const condition of ['quiet', 'revision', 'cancel', 'reject', 'read-quiet']) {
      const h = harness(), abort = new AbortController(), offer = await h.resolve({}, { signal: abort.signal });
      if (condition === 'quiet') h.quiet = true;
      if (condition === 'revision') h.revision++;
      if (condition === 'cancel') abort.abort();
      if (condition === 'reject') await h.reject(offer.importedId);
      if (condition === 'read-quiet') h.onRead = async () => { h.quiet = true; };
      await assert.rejects(offer.prepare(offer.allowedIds[0])); assert.equal(h.wires, 0);
    }
  });

  await test('host-issued owner options pass by identity, once, exact target, content-only; social cannot borrow', async () => {
    const h = harness({ social: false }), options = h.issueOwner();
    const offer = await h.resolve({ conversationId: 'private:1', openOptions: options });
    assert.equal(h.opens[0], options); assert.equal(offer.allowedIds[0], `public_${sha256}`);
    assert.equal(h.visions[0].authority, 'owner-content-only');
    assert.deepEqual(h.visions[0].policy.conversationIds, ['private:1']);
    await code(h.resolve({ conversationId: 'private:1', openOptions: options }), 'EXPRESSION_SCOPE');
    await code(h.resolve({ conversationId: 'private:1', openOptions: { ...options, owner: true } }), 'EXPRESSION_SCOPE');
    await code(h.resolve({ conversationId: 'private:1', openOptions: true }), 'EXPRESSION_SCOPE');
    await code(h.resolve({ conversationId: 'group:2', openOptions: h.issueOwner() }), 'EXPRESSION_SCOPE');
    await code(h.resolve({ accountId: 'beta', conversationId: 'private:1', openOptions: h.issueOwner() }), 'EXPRESSION_SCOPE');
    await code(h.resolve({ conversationId: 'private:1' }), 'EXPRESSION_SCOPE');
    assert.equal(h.fetches.length, 1); assert.equal(h.wires, 0);
    // The same content grant does NOT authorize a QQ send; only offer callbacks
    // are exposed, and the parent's existing final sender still owns authority.
    assert.equal('send' in offer, false);
  });

  await test('local owner offer also consumes host grant, never opens or enables social account policy', async () => {
    const h = harness({ social: false });
    await h.resolve({ conversationId: 'private:1', openOptions: h.issueOwner() });
    const options = h.issueOwner(), offer = await h.resolve({ conversationId: 'private:1', openOptions: options });
    assert.equal(offer.source, 'local'); assert.equal(h.fetches.length, 1);
    await code(h.resolve({ conversationId: 'private:1', openOptions: options }), 'EXPRESSION_SCOPE');
    await code(h.resolve(), 'EXPRESSION_SCOPE');
  });

  await test('normal social scope, account and private libraries stay separate', async () => {
    const h = harness(); await h.resolve();
    const other = await h.resolve({ accountId: 'beta' }); assert.equal(other.source, 'public_memecub');
    assert.equal(h.fetches.length, 1, 'shared public metadata cache is allowed, not shared private library');
    assert.equal(h.claims.length, 1, 'cache hit does not charge durable provider budget');
    assert.equal(h.downloads.length, 2); assert.ok(h.assets('beta')[other.importedId]);
    const otherGroup = await h.resolve({ conversationId: 'group:2' }); assert.equal(otherGroup.source, 'public_memecub');
    assert.equal(h.visions.length, 3); assert.equal(h.claims.length, 1);
  });

  await test('serious/empty input never initiates remote search', async () => {
    const h = harness(); assert.equal((await h.resolve({}, { serious: true })).reason, 'SERIOUS_CONTEXT');
    assert.equal((await h.resolve({ query: '' })).reason, 'EMPTY_QUERY'); assert.equal(h.fetches.length, 0);
  });

  await test('disabled/shadow/search-off policy refuses before provider or visual budget is spent', async () => {
    for (const policyPatch of [{ enabled: false }, { shadowMode: true },
      { stickers: { enabled: true, autoSend: true, autonomousSelection: true, webSearch: false } },
      { stickers: { enabled: true, autoSend: false, autonomousSelection: true, webSearch: true } },
      { stickers: { enabled: true, autoSend: true, autonomousSelection: false, webSearch: true } }]) {
      const h = harness({ policyPatch }); await code(h.resolve(), 'EXPRESSION_DISABLED');
      assert.equal(h.fetches.length + h.downloads.length + h.visions.length + h.claims.length, 0);
    }
  });

  await test('public-query normalization precedes exact host approval, controls/long input fail before network', async () => {
    const h = harness(); await h.resolve({ query: '  无语   表情  ' });
    assert.deepEqual(h.approvals, ['无语 表情']);
    assert.equal(new URL(h.fetches[0][0]).searchParams.get('q'), '无语 表情');
    for (const query of ['\n无语', '无语\u200b', 'a'.repeat(81)]) {
      const invalid = harness(); await code(invalid.resolve({ query }), 'MEMECUB_QUERY');
      assert.equal(invalid.approvals.length + invalid.fetches.length, 0);
    }
  });

  await test('tampered real cache bytes are never returned or redownloaded under an absent source URL', async () => {
    const h = harness(), offer = await h.resolve();
    const namespace = createHash('sha256').update('account:alpha').digest('hex');
    const corrupted = Buffer.from(png); corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(path.join(h.dir, 'cache', namespace, `${sha256}.asset`), corrupted);
    await assert.rejects(offer.prepare(offer.allowedIds[0]));
    assert.equal(h.downloads.length, 1); assert.equal(h.wires, 0);
  });

  await test('official Bearer auth is injected only into fixed HTTP header, never metadata/errors/host budget data', async () => {
    const key = 'test-only-fake-secret';
    const f = searchFixture({ getApiKey: async () => key });
    const result = await f.service.search(f.request());
    assert.equal(f.calls[0][1].headers.authorization, `Bearer ${key}`);
    assert.equal(f.calls[0][0].includes(key), false);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(f.service.resolveCandidate(result.candidates[0])).includes(key), false);
    assert.deepEqual(f.reservations, [true]);
    let calls = 0;
    const broken = searchFixture({ getApiKey: async () => key, fetchImpl: async () => { calls++; throw new Error(key); } });
    await assert.rejects(broken.service.search(broken.request()), error => error.code === 'MEMECUB_NETWORK'
      && !JSON.stringify(error).includes(key) && !error.message.includes(key)); assert.equal(calls, 1);
  });

  await test('selected credential lookup/invalid value/401/403 fail closed, never fall back to anonymous', async () => {
    for (const value of ['bad\ncredential', ' ', true, {}, 'x'.repeat(4097)]) {
      const f = searchFixture({ getApiKey: async () => value }); await code(f.service.search(f.request()), 'MEMECUB_CREDENTIAL');
      assert.equal(f.calls.length, 0);
    }
    const failed = searchFixture({ getApiKey: async () => { throw new Error('test-secret'); } });
    await code(failed.service.search(failed.request()), 'MEMECUB_CREDENTIAL'); assert.equal(failed.calls.length, 0);
    for (const status of [401, 403]) {
      let calls = 0;
      const f = searchFixture({ getApiKey: () => 'fake-key', fetchImpl: async (_, opts) => {
        calls++; assert.equal(opts.headers.authorization, 'Bearer fake-key'); return new Response('SECRET', { status }); } });
      await code(f.service.search(f.request()), 'MEMECUB_HTTP'); assert.equal(calls, 1);
    }
  });

  await test('anonymous 20/day cap, explicitly configured bounded auth allowance higher, cache never counts calls', async () => {
    const anon = searchFixture({ maxAuthenticatedRequestsPerDay: 35 });
    for (let i = 0; i < 20; i++) await anon.service.search(anon.request(`表情${String.fromCharCode(65 + i)}`));
    await code(anon.service.search(anon.request('更多表情')), 'MEMECUB_BUDGET');
    assert.equal((await anon.service.search(anon.request('表情A'))).cached, true);
    assert.equal(anon.calls.length, 20); assert.equal(anon.reservations.length, 20);
    const auth = searchFixture({ getApiKey: async () => 'fake-key', maxAuthenticatedRequestsPerDay: 35 });
    for (let i = 0; i < 35; i++) await auth.service.search(auth.request(`猫表情${String.fromCharCode(65 + i)}`));
    await code(auth.service.search(auth.request('更多猫表情')), 'MEMECUB_BUDGET');
    assert.equal((await auth.service.search(auth.request('猫表情c'))).cached, true);
    assert.equal(auth.calls.length, 35); assert.equal(auth.reservations.length, 35);
    const defaults = searchFixture({ getApiKey: () => 'fake-key' });
    for (let i = 0; i < 20; i++) await defaults.service.search(defaults.request(`默认${String.fromCharCode(65 + i)}`));
    await code(defaults.service.search(defaults.request('不可暗增')), 'MEMECUB_BUDGET');
    for (const limit of [-1, 10001, Infinity]) assert.throws(() => searchFixture({ maxAuthenticatedRequestsPerDay: limit }), { code: 'MEMECUB_OPTIONS' });
    assert.throws(() => searchFixture({ maxRequestsPerDay: 21 }), { code: 'MEMECUB_OPTIONS' });
  });

  await test('changing/failing selected credentials cannot reuse anonymous or another credential cache', async () => {
    let key = null;
    const f = searchFixture({ getApiKey: () => key });
    await f.service.search(f.request()); key = 'fake-one'; await f.service.search(f.request());
    key = 'fake-two'; await f.service.search(f.request());
    assert.equal(f.calls.length, 3); assert.deepEqual(f.reservations, [false, true, true]);
    key = ' '; await code(f.service.search(f.request()), 'MEMECUB_CREDENTIAL'); assert.equal(f.calls.length, 3);
    key = null; assert.equal((await f.service.search(f.request())).cached, true); assert.equal(f.calls.length, 3);
  });

  await test('credential and host-budget awaits check abort/current and sanitize injected failures', async () => {
    const abort = new AbortController();
    const f = searchFixture({ getApiKey: async () => { abort.abort(); return 'fake'; } });
    await code(f.service.search(f.request(), { signal: abort.signal }), 'MEMECUB_ABORTED'); assert.equal(f.calls.length, 0);
    let approved = true;
    const revoked = searchFixture({ isQueryApproved: () => approved, getApiKey: async () => { approved = false; return 'fake'; } });
    await code(revoked.service.search(revoked.request()), 'MEMECUB_NOT_APPROVED'); assert.equal(revoked.calls.length, 0);
    const gate = searchFixture({ beforeRequest: async () => { throw new Error('private secret'); } });
    await code(gate.service.search(gate.request()), 'MEMECUB_NETWORK'); assert.equal(gate.calls.length, 0);
    const hanging = searchFixture({ timeoutMs: 5, getApiKey: () => new Promise(() => {}) });
    await code(hanging.service.search(hanging.request()), 'MEMECUB_TIMEOUT'); assert.equal(hanging.calls.length, 0);
  });

  console.log(JSON.stringify({ ok: true, checks, node: process.versions.node,
    realNetworkCalls: 0, paidCalls: 0, realQQCalls: 0, productionChanges: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
