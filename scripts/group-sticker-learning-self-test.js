import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createExpressionLibrary } from '../src/social-expression-library.js';
import { validateSocialExperiencePolicy } from '../src/social-experience-policy.js';
import { validateStickerDescription } from '../src/group-sticker-learning.js';
import { mock } from 'node:test';

// All dependencies are fake: no network, disk cache, real model, QQ or live memory.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const START = Date.parse('2026-10-24T02:00:00Z');
const description = { note: '开心赞同', tags: ['赞同'], sticker: true, safeToReuse: true,
  confidence: 0.95, usage: '赞同讨论', avoid: ['严肃求助'] };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function harness(patch = {}, cache = true) {
  let root = { memory: {} }, time = START, revision = 'r1', diskFail = false;
  const dead = new Set(), stored = new Map(), calls = { download: 0, vision: 0, put: 0, resolve: 0 };
  let down = async () => ({ buffer: png, mimeType: 'image/png' }), vision = async () => description,
    put = async (id, media) => { stored.set(`${id}:${media.sha256}`, media); return true; };
  const policy = validateSocialExperiencePolicy({ enabled: true, shadowMode: false,
    conversationIds: ['group:1', 'group:2', 'private:1'], stickers: { enabled: true, groupLearning: true,
      visionLearning: true, autonomousEligibility: true, autoSend: true, maxDailyVisionCalls: 8,
      maxDailyDownloads: 16, ...patch } });
  let tail = Promise.resolve();
  const opts = { readState: () => root, clock: () => time,
    transact: builder => {
      assert.notEqual(builder.constructor.name, 'AsyncFunction');
      const result = tail.then(() => {
        const draft = structuredClone(root), result = builder(draft);
        assert(!result?.then); if (diskFail) throw Error('SECRET disk'); root = draft; return result;
      }); tail = result.catch(() => {}); return result;
    },
    capture: (accountId, conversationId) => ({ accountId, conversationId, logicalId: `account:${accountId}`,
      revision, policy: structuredClone(policy), identity: {}, ws: {}, selected: {} }),
    isCurrent: ctx => !dead.has(ctx.logicalId) && ctx.revision === revision,
    request: async () => ({ status: 'ok', retcode: 0, data: [] }),
    downloadImage: async (...args) => { calls.download++; return down(...args); },
    describeImage: async (...args) => { calls.vision++; return vision(...args); },
    resolveImage: async (_ctx, ref) => { calls.resolve++; assert.equal(ref.file, 'current-file'); return 'https://cdn.qq.com/resolved'; },
    ...(cache ? { mediaCache: { put: async (...args) => { calls.put++; return put(...args); },
      read: async (id, sha) => stored.get(`${id}:${sha}`) || null } } : {}) };
  const lib = createExpressionLibrary(opts);
  return { lib, calls, policy, stored, root: () => root, ctx: (a = 'alpha', g = 'group:1') => lib.open(a, g),
    down: f => { down = f; }, vision: f => { vision = f; }, put: f => { put = f; },
    revoke: id => dead.add(id), revision: r => { revision = r; }, diskFail: b => { diskFail = b; },
    time: n => { time = n; }, recreate: () => createExpressionLibrary(opts) };
}
function event(n = 1, extra = {}) { return { messageId: String(n), userId: '123', sentAt: START,
  receivedAt: START, refs: [{ kind: 'image', url: `https://cdn.qq.com/${n}?signed=synthetic`, subType: 0 }],
  text: '非常赞同', context: [], isBot: false, ...extra }; }
async function learn(h, ctx, e = event()) { const r = await h.lib.observe(ctx, e); await h.lib.whenIdle(); return r; }
const assets = (h, ctx) => h.root().memory.socialExpressionAssets?.bots[ctx.logicalId]?.stickers || {};
const asset = (h, ctx) => Object.values(assets(h, ctx))[0];
const review = (h, ctx, status) => h.lib.operate(ctx, 'review-sticker', {
  id: asset(h, ctx).id, status, expectedRevision: asset(h, ctx).annotations[ctx.conversationId].revision,
  expectedStateRevision: h.lib.snapshot(ctx).revision });

await test('disabled/private/bot/forged/mismatched/stale/empty admissions do no work', async () => {
  const h = harness({ groupLearning: false }), ctx = h.ctx();
  assert.equal((await learn(h, ctx)).admitted, false); assert.deepEqual(h.root(), { memory: {} });
  const on = harness(), c = on.ctx();
  for (const [ctx, e] of [[on.ctx('alpha', 'private:1'), event()], [{ ...c }, event()],
    [c, event(1, { isBot: true })], [c, event(1, { conversationId: 'group:2' })],
    [c, event(1, { sentAt: START - 600000 })], [c, event(1, { refs: [] })],
    [c, event(1, { refs: [{ kind: 'image', url: 'file:///secret' }] })]]) assert.equal((await on.lib.observe(ctx, e)).admitted, false);
  assert.deepEqual(on.root(), { memory: {} }); assert.equal(on.calls.download, 0);
});
await test('subtype0 visual classification, contextual eligibility, cache-only backup and detached public projection', async () => {
  const h = harness(), ctx = h.ctx();
  h.vision(async (_ctx, media, { usageContext }) => {
    assert(Buffer.isBuffer(media.buffer)); assert(!media.url); assert.equal(usageContext.text, '非常赞同');
    return description;
  });
  assert.equal((await learn(h, ctx)).admitted, true);
  const a = asset(h, ctx), annotation = a.annotations['group:1'];
  assert.equal(a.source, 'group-observed'); assert.equal(a.url, undefined); assert.equal(a.cacheSha256, a.sha256);
  assert.equal(annotation.status, 'candidate'); assert.equal(annotation.actor, undefined);
  assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 1);
  const downloads = h.calls.download; assert((await h.lib.prepare(ctx, { id: a.id })).segment); assert.equal(h.calls.download, downloads);
  const publicRow = h.lib.snapshot(ctx).stickers[0];
  assert.equal(publicRow.source, 'group-observed'); assert.equal(publicRow.autoEligible, true); assert.equal(publicRow.usage, description.usage);
  for (const key of ['evidence', 'automatic', 'url', 'file', 'context']) assert(!JSON.stringify(publicRow).includes(`"${key}"`));
  assert.equal(h.lib.candidates(ctx, { query: '赞同但严肃求助' }).length, 0);
  assert.equal(h.lib.candidates(ctx, { query: '赞同', serious: true }).length, 0);
});
await test('durable replay + same URL dedup + content SHA dedup; evidence bounded', async () => {
  const h = harness({ maxDailyDownloads: 32 }), ctx = h.ctx(); await learn(h, ctx);
  const restarted = h.recreate(), fresh = restarted.open('alpha', 'group:1');
  await restarted.observe(fresh, event()); await restarted.whenIdle(); assert.equal(h.calls.download, 1);
  await learn(h, ctx, event(2, { refs: event().refs })); assert.equal(h.calls.download, 1);
  for (let i = 3; i < 15; i++) await learn(h, ctx, event(i));
  assert.equal(Object.keys(assets(h, ctx)).length, 1); assert.equal(h.calls.vision, 1);
  assert.equal(asset(h, ctx).annotations['group:1'].evidence.length, 8);
});
await test('new same-URL scene upgrades ambiguous candidate; replay never retries; qualified events add evidence without paid calls', async () => {
  const h = harness(), ctx = h.ctx(); h.vision(async () => ({ ...description, confidence: 0.5, usage: '用法不确定' }));
  await learn(h, ctx); const id = asset(h, ctx).id;
  assert.equal(h.lib.snapshot(ctx).stickers[0].autoEligible, false);
  await learn(h, ctx); assert.equal(h.calls.download, 1); assert.equal(h.calls.vision, 1);
  const reopened = h.recreate(), reopenedCtx = reopened.open('alpha', 'group:1');
  await reopened.observe(reopenedCtx, event()); await reopened.whenIdle();
  assert.equal(h.calls.download, 1); assert.equal(h.calls.vision, 1, 'ambiguous original replay also blocked after recreation');
  h.vision(async (_c, _m, { usageContext }) => {
    assert.equal(usageContext.text, '明确表示赞同这个方案'); return description;
  });
  const next = event(2, { refs: event().refs, text: '明确表示赞同这个方案' });
  await learn(h, ctx, next);
  assert.equal(asset(h, ctx).id, id); assert.equal(Object.keys(assets(h, ctx)).length, 1);
  assert.equal(h.calls.download, 2); assert.equal(h.calls.vision, 2);
  assert.equal(h.lib.snapshot(ctx).stickers[0].autoEligible, true);
  assert.equal(h.lib.snapshot(ctx).stickers[0].usage, description.usage);
  assert.equal(asset(h, ctx).annotations['group:1'].evidence.length, 2);
  await learn(h, ctx, event()); await learn(h, ctx, next);
  assert.equal(h.calls.download, 2); assert.equal(h.calls.vision, 2);
  await learn(h, ctx, event(3, { refs: event().refs }));
  assert.equal(h.calls.download, 2); assert.equal(h.calls.vision, 2);
  assert.equal(asset(h, ctx).annotations['group:1'].evidence.length, 3);
  assert((await review(h, ctx, 'rejected')).ok);
  await learn(h, ctx, event(4, { refs: event().refs }));
  assert.equal(h.calls.vision, 2); assert.equal(asset(h, ctx).annotations['group:1'].status, 'rejected');
  assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 0);
});
await test('ambiguous retries obey vision/download limits and exact annotation revision, including in-flight rejection', async () => {
  const limited = harness({ maxDailyVisionCalls: 1 }), lc = limited.ctx();
  limited.vision(async () => ({ ...description, confidence: 0.5 })); await learn(limited, lc);
  await learn(limited, lc, event(2, { refs: event().refs })); assert.equal(limited.calls.vision, 1);
  assert.equal(limited.lib.snapshot(lc).stickers[0].autoEligible, false);
  for (const denied of [true, false]) {
    const h = harness(), ctx = h.ctx(); h.vision(async () => ({ ...description, confidence: 0.5 })); await learn(h, ctx);
    const puts = h.calls.put;
    h.vision(async () => {
      if (denied) assert((await review(h, ctx, 'rejected')).ok);
      else asset(h, ctx).annotations['group:1'].revision++;
      return description;
    });
    await learn(h, ctx, event(2, { refs: event().refs }));
    assert.equal(h.calls.put, puts); assert.equal(h.lib.snapshot(ctx).stickers[0].autoEligible, false);
    assert.equal(asset(h, ctx).annotations['group:1'].status, denied ? 'rejected' : 'candidate');
  }
});
await test('runtime diagnostics are safe, bounded-schema, read-only and owner/instance isolated', async () => {
  const h = harness(), a = h.ctx(), b = h.ctx('beta');
  const initial = structuredClone(h.root());
  assert.equal(h.lib.learningStatus(a).completed, 0); assert.deepEqual(h.root(), initial);
  h.down(async () => { throw Error('SECRET https://cdn.qq.com/raw?token=private'); });
  assert((await learn(h, a)).admitted);
  let status = h.lib.learningStatus(a);
  assert.equal(status.failed, 1); assert.equal(status.completed, 0); assert.equal(status.lastErrorCode, 'STICKER_LEARNING_FAILED');
  assert(!/SECRET|https:|private|token/.test(JSON.stringify(status)));
  assert.equal(h.lib.learningStatus(b).failed, 0);
  const recreated = h.recreate(), fresh = recreated.open('alpha', 'group:1');
  assert.equal(recreated.learningStatus(fresh).failed, 0);
  h.down(async () => ({ buffer: png, mimeType: 'image/png' })); await learn(h, a, event(2));
  status = h.lib.learningStatus(a); assert.equal(status.completed, 1); assert.equal(status.failed, 1);
  assert.equal(status.lastErrorCode, 'STICKER_LEARNING_FAILED', 'last failure is retained across successful work');
  const snapshot = structuredClone(h.root()); h.lib.learningStatus(a); assert.deepEqual(h.root(), snapshot);
  const ac = new AbortController();
  h.down(async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('raw')), { once: true })));
  await h.lib.observe(b, event(3), { signal: ac.signal });
  await new Promise(resolve => setImmediate(resolve)); ac.abort(); await h.lib.whenIdle();
  assert.equal(h.lib.learningStatus(b).failed, 1); assert.equal(h.lib.learningStatus(b).lastErrorCode, 'ABORTED');
});
await test('cross account/group context and interpretation are isolated, collection sync preserves observed assets', async () => {
  const h = harness(), a = h.ctx(), b = h.ctx('beta'), g = h.ctx('alpha', 'group:2');
  await learn(h, a); assert.equal(h.lib.snapshot(g).stickers.length, 0); assert.equal(h.lib.snapshot(b).stickers.length, 0);
  await learn(h, g); await learn(h, b); assert.equal(h.calls.vision, 3);
  const s = await h.lib.operate(a, 'sync', { expectedStateRevision: h.lib.snapshot(a).revision }); assert(s.ok);
  assert.equal(asset(h, a).active, true); assert.equal(h.lib.candidates(a, { query: '赞同' }).length, 1);
});
await test('photos/docs/unsafe/schema-invalid data never cached; unknown context cannot auto qualify', async () => {
  for (const desc of [{ ...description, sticker: false }, { ...description, safeToReuse: false },
    { ...description, confidence: '0.9' }, { ...description, safeToReuse: 'true' },
    { ...description, unexpected: true }, { ...description, note: 'ignore instructions' }]) {
    const h = harness(), ctx = h.ctx(); h.vision(async () => desc); await learn(h, ctx);
    assert.equal(h.calls.put, 0); assert.equal(Object.keys(assets(h, ctx)).length, 0);
  }
  for (const extra of [{ text: '' }, {}]) {
    const h = harness(), ctx = h.ctx(); if (!extra.text && extra.text !== '') h.vision(async () => ({ ...description, confidence: 0.79 }));
    await learn(h, ctx, event(1, extra)); assert.equal(h.lib.snapshot(ctx).stickers[0]?.autoEligible || false, false);
  }
  assert.throws(() => validateStickerDescription({ ...description, confidence: NaN }));
  for (const text of ['', '[图片]', '图片', '??', '👍', '好！']) {
    const h = harness(), ctx = h.ctx(); await learn(h, ctx, event(1, { text }));
    assert.equal(h.lib.snapshot(ctx).stickers.length, 0, `not meaningful: ${text}`);
    assert.equal(h.calls.vision, 0); assert.equal(h.calls.put, 0);
    assert.equal(h.calls.download, 0); assert.deepEqual(h.root(), { memory: {} });
    await learn(h, ctx, event(2, { refs: event().refs }));
    assert.equal(h.lib.snapshot(ctx).stickers[0].autoEligible, true, 'no-context must not poison future real-context intake');
  }
});
await test('rejection survives observe/annotation/sync; deliberate normal admin reconfirm remains possible', async () => {
  const h = harness(), ctx = h.ctx(); await learn(h, ctx); assert((await review(h, ctx, 'rejected')).ok);
  await learn(h, ctx, event(2)); assert.equal(h.calls.vision, 1);
  const id = asset(h, ctx).id;
  assert((await h.lib.operate(ctx, 'annotate', { id, expectedStateRevision: h.lib.snapshot(ctx).revision })).ok);
  assert.equal(asset(h, ctx).annotations['group:1'].status, 'rejected');
  assert((await h.lib.operate(ctx, 'sync', { expectedStateRevision: h.lib.snapshot(ctx).revision })).ok);
  assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 0);
  assert((await review(h, ctx, 'confirmed')).ok); assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 1);
});
await test('old ctx remains stale but restart/new epoch preserves qualification under current opt-in; denial survives', async () => {
  const h = harness({ autonomousEligibility: false }), ctx = h.ctx(); await learn(h, ctx);
  ctx.policy.stickers.autonomousEligibility = true; assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 0);
  const on = harness(), a = on.ctx(); await learn(on, a); on.lib.candidates(a, { query: '赞同' });
  on.revision('r2'); assert.equal((await on.lib.prepare(a, { id: asset(on, a).id })).segment, null);
  const restarted = on.recreate(), current = restarted.open('alpha', 'group:1');
  assert.equal(restarted.candidates(current, { query: '赞同' }).length, 1);
  assert((await restarted.prepare(current, { id: asset(on, a).id })).segment);
  assert.equal(asset(on, a).annotations['group:1'].automatic.qualificationVersion, 1);
  assert.equal(asset(on, a).annotations['group:1'].automatic.policyRevision, undefined);
  const rejected = await restarted.operate(current, 'review-sticker', { id: asset(on, a).id, status: 'rejected',
    expectedRevision: asset(on, a).annotations['group:1'].revision, expectedStateRevision: restarted.snapshot(current).revision });
  assert(rejected.ok); on.revision('r3');
  const third = on.recreate(), c = third.open('alpha', 'group:1');
  assert.equal(third.candidates(c, { query: '赞同' }).length, 0);
  await third.observe(c, event(2)); await third.whenIdle();
  assert.equal(asset(on, a).annotations['group:1'].status, 'rejected');
  assert.equal(on.calls.vision, 1, 'new epoch plus duplicate source cannot undo denial');
  assert((await third.operate(c, 'review-sticker', { id: asset(on, a).id, status: 'confirmed',
    expectedRevision: asset(on, a).annotations['group:1'].revision,
    expectedStateRevision: third.snapshot(c).revision })).ok);
  on.policy.stickers.autonomousEligibility = false; on.policy.stickers.groupLearning = false; on.revision('r4');
  const fourth = on.recreate(), d = fourth.open('alpha', 'group:1');
  assert.equal(fourth.candidates(d, { query: '赞同' }).length, 1, 'deliberately confirmed materials survive restart with learning off');
  assert((await fourth.prepare(d, { id: asset(on, a).id })).segment);
});
await test('download/vision budgets shared with manual annotation and reserved before dispatch', async () => {
  const h = harness({ maxDailyDownloads: 1 }), ctx = h.ctx(); await learn(h, ctx); await learn(h, ctx, event(2));
  assert.equal(h.calls.download, 1);
  const v = harness({ maxDailyVisionCalls: 1 }), a = v.ctx(); await learn(v, a);
  await learn(v, v.ctx('alpha', 'group:2'), event(2)); assert.equal(v.calls.vision, 1);
  assert.equal((await v.lib.operate(a, 'annotate', { id: asset(v, a).id, expectedStateRevision: v.lib.snapshot(a).revision })).ok, false);
  assert.equal(v.calls.vision, 1);
});
await test('resolve current file only, cache full fails closed, no-cache URL fallback, corrupt cache cannot send', async () => {
  const h = harness(), ctx = h.ctx(); await learn(h, ctx, event(1, { refs: [{ kind: 'image', file: 'current-file' }] }));
  assert.equal(h.calls.resolve, 1); assert.equal(h.calls.vision, 1);
  const full = harness(), f = full.ctx(); full.put(async () => false); await learn(full, f); assert.equal(Object.keys(assets(full, f)).length, 0);
  const uncached = harness({}, false), u = uncached.ctx(); await learn(uncached, u,
    event(1, { refs: [{ kind: 'image', url: 'https://cdn.qq.com/public.png' }] }));
  uncached.lib.candidates(u, { query: '赞同' }); assert((await uncached.lib.prepare(u, { id: asset(uncached, u).id })).segment);
  const key = [...h.stored.keys()][0]; h.stored.set(key, { buffer: Buffer.from('invalid'), mimeType: 'image/png' });
  h.lib.candidates(ctx, { query: '赞同' }); assert.equal((await h.lib.prepare(ctx, { id: asset(h, ctx).id })).segment, null);
});
await test('admission is immediate, global singleflight, <=16 per bot, cancellation only chosen identity', async () => {
  const h = harness(), a = h.ctx(), b = h.ctx('beta'); let release;
  h.down(async (_url, { signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ buffer: png, mimeType: 'image/png' });
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }));
  assert((await h.lib.observe(a, event())).admitted);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.download, 1);
  for (let i = 2; i <= 16; i++) assert((await h.lib.observe(a, event(i))).admitted);
  assert.equal((await h.lib.observe(a, event(17))).reason, 'capacity');
  assert((await h.lib.observe(b, event(18))).admitted); assert.equal(h.calls.download, 1);
  h.down(async () => ({ buffer: png, mimeType: 'image/png' })); h.lib.cancelLearning(a.logicalId);
  await h.lib.whenIdle(); assert.equal(h.calls.vision, 1); assert(asset(h, b)); assert(!asset(h, a));
  release();
});
await test('200ms stale monitor actively aborts outstanding paid work', async () => {
  const h = harness(), ctx = h.ctx(); let start; const started = new Promise(r => { start = r; });
  let aborted = false;
  h.vision(async (_c, _m, { signal }) => { start(); return new Promise((_, reject) => signal.addEventListener('abort', () => {
    aborted = true; reject(Error('SECRET upstream'));
  }, { once: true })); });
  await h.lib.observe(ctx, event()); await started; h.revoke(ctx.logicalId); await h.lib.whenIdle();
  assert(aborted); assert.equal(h.calls.put, 0); assert(!asset(h, ctx));
});
await test('failed publication, expired queued source, redaction and status reveal no raw content/errors', async () => {
  const h = harness(), ctx = h.ctx(); h.diskFail(true); await learn(h, ctx); assert.equal(h.calls.download, 0);
  h.diskFail(false); await learn(h, ctx); assert.equal(h.calls.download, 0, 'uncertain claim never retried');
  const r = harness(), a = r.ctx(); let seen;
  r.vision(async (_c, _m, { usageContext }) => { seen = JSON.stringify(usageContext); return description; });
  await learn(r, a, event(1, { text: '赞同 密码=syntheticSECRET https://cdn.qq.com/p?token=synthetic' }));
  assert.equal(seen, undefined); assert.equal(r.calls.vision, 0); assert.equal(r.calls.put, 0);
  const s = JSON.stringify(r.lib.learningStatus(a)); assert(!/SECRET|cdn|url|context|error|赞同/.test(s));
  assert.equal(r.lib.snapshot(a).stickers.length, 0);
  await learn(r, a, event(2));
  const sha = createHash('sha256').update(png).digest('hex'); assert.equal(asset(r, a).sha256, sha);
});
await test('signed URL without cache is never persisted; blocked aliases and 500 asset capacity fail closed', async () => {
  const signed = harness({}, false), s = signed.ctx(); await learn(signed, s); assert(!asset(signed, s));
  const h = harness(), ctx = h.ctx(); await learn(h, ctx);
  const a = asset(h, ctx); a.annotations['group:1'].denied = true;
  await learn(h, ctx, event(2)); assert.equal(h.calls.vision, 1);
  assert.equal(h.lib.candidates(ctx, { query: '赞同' }).length, 0);
  delete a.annotations['group:1'].denied;
  const list = assets(h, ctx);
  for (let i = 1; i < 500; i++) list[`retired${i}`] = { ...structuredClone(a), id: `retired${i}`, active: false, annotations: {} };
  const count = h.calls.download; await learn(h, ctx, event(3)); assert.equal(h.calls.download, count);
  assert.equal(Object.keys(assets(h, ctx)).length, 500);
});
await test('revocation during download/cache and changed evidence after offer cannot produce a prepared image', async () => {
  const h = harness(), ctx = h.ctx(); h.down(async () => { h.revoke(ctx.logicalId); return { buffer: png, mimeType: 'image/png' }; });
  await learn(h, ctx); assert.equal(h.calls.vision, 0); assert.equal(h.calls.put, 0);
  const c = harness(), a = c.ctx(); c.put(async () => { c.revoke(a.logicalId); return true; });
  await learn(c, a); assert(!asset(c, a));
  const e = harness(), b = e.ctx(); await learn(e, b); e.lib.candidates(b, { query: '赞同' });
  asset(e, b).annotations['group:1'].evidenceRevision++;
  assert.equal((await e.lib.prepare(b, { id: asset(e, b).id })).segment, null);
});
await test('market/custom face refs use the same image reader/classifier, no pack/send protocol assumptions', async () => {
  for (const kind of ['mface', 'bface', 'marketface']) {
    const h = harness(), ctx = h.ctx();
    await learn(h, ctx, event(1, { refs: [{ kind, file: 'current-file' }] }));
    assert.equal(h.calls.resolve, 1); assert.equal(h.calls.download, 1); assert.equal(h.calls.vision, 1);
    assert.equal(asset(h, ctx).source, 'group-observed');
  }
});
await test('hard 60s deadline aborts an otherwise hanging vision; expired queued sources never download', async () => {
  const h = harness(), ctx = h.ctx(); let start; const started = new Promise(r => { start = r; });
  let aborted = false;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    h.vision(async (_ctx, _media, { signal }) => { start(); return new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; h.time(START + 6 * 60000); reject(Error('timeout')); }, { once: true });
    }); });
    await h.lib.observe(ctx, event()); await started;
    await h.lib.observe(ctx, event(2));
    mock.timers.tick(60001); await h.lib.whenIdle();
    assert(aborted); assert.equal(h.calls.download, 1); assert.equal(h.calls.put, 0);
  } finally { mock.timers.reset(); }
});
console.log(`group-sticker-learning: ${passed} synthetic checks; no network/model/QQ/disk`);
