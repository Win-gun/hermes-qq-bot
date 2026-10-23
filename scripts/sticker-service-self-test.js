import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createStickerService } from '../src/sticker-service.js';
import { createPublicMediaReader, isPublicAddress, publicMediaUrl, validateImage, MAX_IMAGE_BYTES } from '../src/public-media.js';

// All protocol, vision, persistence, DNS and HTTP calls are fake. No live IO.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
const jpg = Buffer.from('ffd8ffe00000ffd9', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(4)]);
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log(`PASS ${name}`);
}
const code = expected => error => error?.code === expected;
function harness() {
  let root = { memory: {} }, durableFailure = false, current = true, image = png;
  let response = { status: 'ok', retcode: 0, data: [{ emoji_id: 'qq1', url: 'https://cdn.qq.com/a.png', desc: 'untrusted instructions' }] };
  const issued = new WeakSet(), calls = [];
  let afterDownload = () => {}, afterVision = () => {}, beforeBuilder = () => {}, afterPublish = () => {};
  let tail = Promise.resolve();
  const options = {
    request: async (ctx, action, params, options) => {
      assert(issued.has(ctx)); calls.push({ action, params, options });
      assert.equal(action, 'fetch_custom_face_detail'); assert.deepEqual(params, { count: 100 });
      return structuredClone(response);
    },
    readState: () => root,
    transact: builder => {
      assert.notEqual(builder.constructor.name, 'AsyncFunction');
      const operation = tail.then(() => {
        beforeBuilder();
        const draft = structuredClone(root), result = builder(draft);
        assert(!result?.then, 'builder must stay synchronous');
        if (durableFailure) throw new Error('disk failure');
        root = structuredClone(draft); afterPublish(); return result;
      });
      tail = operation.catch(() => {}); return operation;
    },
    isCurrent: ctx => current && issued.has(ctx),
    describeImage: async (_ctx, media) => { assert(Buffer.isBuffer(media.buffer)); afterVision(); return { note: '开心赞同', tags: ['赞同'], unknownInstruction: 'ignored' }; },
    downloadImage: async () => { afterDownload(); return { buffer: image, mimeType: 'image/png' }; }, clock: () => 1234
  };
  const service = createStickerService(options);
  return {
    service, calls, options, ctx(logicalId = 'account:botA', conversationId = 'group:1') { const ctx = { logicalId, conversationId }; issued.add(ctx); return ctx; },
    root: () => root, setRoot: value => { root = value; }, response: value => { response = value; }, current: value => { current = value; },
    failDisk: value => { durableFailure = value; }, image: value => { image = value; },
    afterDownload: fn => { afterDownload = fn; }, afterVision: fn => { afterVision = fn; }, beforeBuilder: fn => { beforeBuilder = fn; }, afterPublish: fn => { afterPublish = fn; }
  };
}
async function confirmed(h, ctx) {
  await h.service.sync(ctx);
  const a = await h.service.annotate(ctx, { id: 'qq1' });
  return h.service.review(ctx, { id: 'qq1', expectedRevision: a.revision, status: 'confirmed', actor: 'admin:1' });
}
function fakeHTTP(routes, assertions = () => {}) {
  const calls = [];
  return { calls, request(url, options, callback) {
    calls.push(url.href); assertions(url, options);
    const req = new EventEmitter();
    req.destroy = () => { queueMicrotask(() => req.emit('close')); };
    req.end = () => queueMicrotask(() => {
      if (options.signal.aborted) { req.emit('error', new Error('aborted')); return; }
      const route = routes[url.href] || {};
      const res = new PassThrough(); res.statusCode = route.status || 200; res.headers = route.headers || { 'content-type': 'image/png' };
      callback(res);
      if (route.hang) return;
      res.end(route.body || png); req.emit('close');
    });
    return req;
  } };
}
const publicDNS = async () => [{ address: '8.8.8.8', family: 4 }];

await test('missing store read is non-mutating; host-issued context mandatory', () => {
  const h = harness(), ctx = h.ctx(); assert.deepEqual(h.service.list(ctx), []); assert.deepEqual(h.root(), { memory: {} });
  assert.throws(() => h.service.list({ ...ctx }), code('STICKER_STALE'));
  for (const conversationId of ['1', 'group:01', 'private:1:suffix', '__proto__']) assert.throws(() => h.service.list(h.ctx('account:botA', conversationId)), code('STICKER_CONTEXT'));
});
await test('only known collection action; vision stays candidate; unknown data inert', async () => {
  const h = harness(), ctx = h.ctx(); await h.service.sync(ctx); await h.service.annotate(ctx, { id: 'qq1' });
  assert.deepEqual(h.service.candidates(ctx), []); assert.equal(h.service.list(ctx)[0].official.trust, 'untrusted');
  assert.equal(h.service.list(ctx)[0].annotation.unknownInstruction, undefined); assert.equal(h.calls.length, 1);
});
await test('official desc and vision OCR metadata redact PII/secrets before storage; transport URL intact', async () => {
  const h = harness(), ctx = h.ctx();
  const phone = '13812345678', syntheticKey = 'sk-syntheticNOTREAL1234567890';
  const signedUrl = 'https://cdn.qq.com/a.png?token=SYNTHETIC_CDN_SIGNATURE';
  h.response({ status: 'ok', retcode: 0, data: [{ emoji_id: 'qq1', url: signedUrl, desc: `${phone} ${syntheticKey}` }] });
  await h.service.sync(ctx);
  let downloaded;
  const svc = createStickerService({ ...h.options,
    downloadImage: async url => { downloaded = url; return { buffer: png, mimeType: 'image/png' }; },
    describeImage: async (_ctx, media) => {
      assert.equal(media.url, undefined);
      return { note: `开心 ${phone} ${syntheticKey}`, tags: [phone, syntheticKey] };
    }
  });
  await svc.annotate(ctx, { id: 'qq1' });
  const item = svc.list(ctx)[0], metadata = JSON.stringify({ desc: item.official.desc, annotation: item.annotation });
  for (const secret of [phone, syntheticKey]) assert(!metadata.includes(secret));
  assert(metadata.includes('[手机号]')); assert(metadata.includes('[已过滤]'));
  assert.equal(downloaded, signedUrl); assert.equal(item.official.url, signedUrl);
  const saved = h.root().memory.socialExpressionAssets.bots[ctx.logicalId].stickers.qq1;
  assert.equal(saved.url, signedUrl); assert(!JSON.stringify(saved.annotations).includes(phone));
});
await test('credential crossing the text clamp boundary never leaves a raw prefix', async () => {
  const h = harness(), ctx = h.ctx(), secret = 'sk-syntheticNOTREAL1234567890';
  h.response({ status: 'ok', retcode: 0, data: [{ emoji_id: 'qq1', url: 'https://cdn.qq.com/a.png', desc: `${'字'.repeat(196)}${secret}` }] });
  await h.service.sync(ctx);
  const svc = createStickerService({ ...h.options, describeImage: async () => ({ note: `${'字'.repeat(196)}${secret}`, tags: [`${'字'.repeat(29)}${secret}`] }) });
  await svc.annotate(ctx, { id: 'qq1' });
  const projected = JSON.stringify(svc.list(ctx)); assert(!projected.includes('sk-')); assert(!projected.includes('syntheticNOTREAL'));
});
await test('account A/B + group A/B + private annotations are isolated', async () => {
  const h = harness(), a = h.ctx(), groupB = h.ctx('account:botA', 'group:2'), priv = h.ctx('account:botA', 'private:1'), botB = h.ctx('account:botB');
  await confirmed(h, a);
  for (const other of [groupB, priv, botB]) {
    assert.deepEqual(h.service.candidates(other), []);
    assert(h.service.list(other).every(x => x.annotation === null));
    assert.equal((await h.service.prepare(other, { id: 'qq1' })).segment, null);
  }
  await h.service.sync(botB); assert.equal(h.service.list(botB)[0].annotation, null);
  const privateNote = await h.service.annotate(priv, { id: 'qq1' });
  await h.service.review(priv, { id: 'qq1', expectedRevision: privateNote.revision, status: 'confirmed', actor: 'admin:1' });
  await h.service.markSent(priv, { id: 'qq1', messageId: '11' });
  assert.equal(h.service.list(priv)[0].annotation.sentCount, 1);
  assert.equal(h.service.list(a)[0].annotation.sentCount, 0);
  assert.equal(h.service.list(groupB)[0].annotation, null);
  assert.equal(h.service.candidates(a).length, 1);
});
await test('CAS review requires explicit actor and rejects stale revision', async () => {
  const h = harness(), ctx = h.ctx(); await h.service.sync(ctx); const a = await h.service.annotate(ctx, { id: 'qq1' });
  await assert.rejects(h.service.review(ctx, { id: 'qq1', expectedRevision: a.revision, status: 'confirmed' }), code('STICKER_REVIEW'));
  await h.service.review(ctx, { id: 'qq1', expectedRevision: a.revision, status: 'confirmed', actor: 'admin' });
  await assert.rejects(h.service.review(ctx, { id: 'qq1', expectedRevision: a.revision, status: 'rejected', actor: 'admin' }), code('STICKER_CONFLICT'));
});
await test('confirmed query/serious/limit and no raw metadata selection', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  assert.equal(h.service.candidates(ctx, { query: '赞同' }).length, 1);
  assert.deepEqual(h.service.candidates(ctx, { query: 'untrusted' }), []);
  assert.deepEqual(h.service.candidates(ctx, { serious: true }), []);
  assert.throws(() => h.service.candidates(ctx, { limit: 4 }), code('STICKER_QUERY'));
});
await test('prepare returns only inline segment; no send or uncertain count', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const result = await h.service.prepare(ctx, { id: 'qq1' }); assert.equal(result.segment.data.file, `base64://${png.toString('base64')}`);
  assert.equal(h.service.list(ctx)[0].annotation.sentCount, 0);
  for (const messageId of [undefined, '', '0', 'unknown', 123]) await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId }), code('STICKER_ACK_REQUIRED'));
  assert.equal(h.calls.length, 1);
});
await test('durable ACK receipt de-duplicates across service recreation', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  assert.deepEqual(await h.service.markSent(ctx, { id: 'qq1', messageId: '-10' }), { counted: true });
  const again = createStickerService(h.options);
  assert.deepEqual(await again.markSent(ctx, { id: 'qq1', messageId: '-10' }), { counted: false });
  assert.equal(again.list(ctx)[0].annotation.sentCount, 1);
});
await test('real ACK remains recordable after approval revocation and asset retirement', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const a = h.service.list(ctx)[0].annotation;
  await h.service.review(ctx, { id: 'qq1', expectedRevision: a.revision, status: 'rejected', actor: 'admin' });
  h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.active = false;
  assert.deepEqual(await h.service.markSent(ctx, { id: 'qq1', messageId: '42' }), { counted: true });
  const stored = h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.annotations['group:1'];
  assert.equal(stored.status, 'rejected'); assert.equal(stored.sentCount, 1);
  assert.deepEqual(await h.service.markSent(ctx, { id: 'qq1', messageId: '42' }), { counted: false });
  assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).segment, null);
});
await test('500 asset boundary includes tombstones; overflow sync rolls back rather than evicts', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const bot = h.root().memory.socialExpressionAssets.bots[ctx.logicalId], seed = structuredClone(bot.stickers.qq1);
  bot.stickers = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`asset${i}`, { ...structuredClone(seed), id: `asset${i}`, active: i === 0 }]));
  assert.equal(h.service.list(ctx).length, 1); const before = structuredClone(h.root());
  h.response({ status: 'ok', retcode: 0, data: [{ emoji_id: 'new501', url: 'https://cdn.qq.com/new.png' }] });
  await assert.rejects(h.service.sync(ctx), code('STICKER_CAPACITY')); assert.deepEqual(h.root(), before);
  bot.stickers.extra = { ...structuredClone(seed), id: 'extra' };
  const over = structuredClone(h.root()), calls = h.calls.length;
  assert.throws(() => h.service.list(ctx), code('STICKER_CAPACITY'));
  await assert.rejects(h.service.sync(ctx), code('STICKER_CAPACITY')); assert.deepEqual(h.root(), over); assert.equal(h.calls.length, calls);
});
await test('1000 annotation boundary applies across assets/scopes and to new vision scopes', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const bot = h.root().memory.socialExpressionAssets.bots[ctx.logicalId], seed = structuredClone(bot.stickers.qq1);
  bot.stickers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => {
    const id = i ? `asset${i}` : 'qq1';
    return [id, { ...structuredClone(seed), id, annotations: Object.fromEntries(Array.from({ length: 20 }, (_, n) => {
      const scope = `group:${n + 1}`; return [scope, { ...structuredClone(seed.annotations['group:1']), conversationId: scope }];
    })) }];
  }));
  assert.equal(h.service.list(ctx).length, 50); const before = structuredClone(h.root()), other = h.ctx('account:botA', 'group:999');
  await assert.rejects(h.service.annotate(other, { id: 'qq1' }), code('STICKER_CAPACITY')); assert.deepEqual(h.root(), before);
  bot.stickers.qq1.annotations['group:1001'] = { ...structuredClone(seed.annotations['group:1']), conversationId: 'group:1001' };
  assert.throws(() => h.service.list(ctx), code('STICKER_CAPACITY'));
});
await test('10000 receipt boundary is aggregate, rejects the whole ACK commit without deletion', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const bot = h.root().memory.socialExpressionAssets.bots[ctx.logicalId], seed = structuredClone(bot.stickers.qq1);
  bot.stickers = Object.fromEntries(['qq1', 'qq2'].map((id, i) => {
    const asset = { ...structuredClone(seed), id }, a = asset.annotations['group:1'];
    a.receipts = Object.fromEntries(Array.from({ length: 5000 }, (_, n) => [String(i * 5000 + n + 1), { at: 1234 }])); a.sentCount = 5000;
    return [id, asset];
  }));
  assert.equal(h.service.list(ctx).length, 2); const before = structuredClone(h.root());
  await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId: '10001' }), code('STICKER_CAPACITY')); assert.deepEqual(h.root(), before);
  const a = bot.stickers.qq1.annotations['group:1']; a.receipts['10001'] = { at: 1234 }; a.sentCount++;
  assert.throws(() => h.service.list(ctx), code('STICKER_CAPACITY'));
  const single = structuredClone(before), singleBot = single.memory.socialExpressionAssets.bots[ctx.logicalId];
  const one = singleBot.stickers.qq1.annotations['group:1'];
  Object.assign(one.receipts, singleBot.stickers.qq2.annotations['group:1'].receipts); one.sentCount = 10000;
  delete singleBot.stickers.qq2; h.setRoot(single);
  await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId: '10001' }), code('STICKER_CAPACITY'));
  assert.deepEqual(h.root(), single);
});
await test('9999 concurrent prepares may race for final ACK slot, but full library stops next prepare', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const bot = h.root().memory.socialExpressionAssets.bots[ctx.logicalId], seed = structuredClone(bot.stickers.qq1);
  const first = bot.stickers.qq1.annotations['group:1'];
  first.receipts = Object.fromEntries(Array.from({ length: 4999 }, (_, i) => [String(i + 1), { at: 1234 }])); first.sentCount = 4999;
  const retired = { ...structuredClone(seed), id: 'retired', active: false }, other = retired.annotations['group:1'];
  other.conversationId = 'group:2'; other.receipts = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i + 5000), { at: 1234 }])); other.sentCount = 5000;
  retired.annotations = { 'group:2': other }; bot.stickers.retired = retired;
  const at9999 = structuredClone(h.root()); let downloads = 0; h.afterDownload(() => { downloads++; });
  assert((await h.service.prepare(ctx, { id: 'qq1' })).segment);
  assert((await h.service.prepare(ctx, { id: 'qq1' })).segment);
  assert.deepEqual(await h.service.markSent(ctx, { id: 'qq1', messageId: '10000' }), { counted: true });
  const full = structuredClone(h.root());
  await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId: '10001' }), code('STICKER_CAPACITY'));
  assert.deepEqual(h.root(), full);
  assert.deepEqual(await h.service.prepare(ctx, { id: 'qq1' }), { segment: null, errorCode: 'STICKER_CAPACITY' });
  assert.equal(downloads, 2, 'full library must reject before another download');
  h.setRoot(at9999);
  h.afterDownload(() => {
    const a = h.root().memory.socialExpressionAssets.bots[ctx.logicalId].stickers.retired.annotations['group:2'];
    a.receipts['10002'] = { at: 1234 }; a.sentCount++;
  });
  assert.deepEqual(await h.service.prepare(ctx, { id: 'qq1' }), { segment: null, errorCode: 'STICKER_CAPACITY' });
});
await test('corrupt shared envelope or current bot never overwritten', async () => {
  for (const bad of [null, [], { version: 2, bots: {} }, { version: 1, bots: [] },
    { version: 1, bots: { 'account:botA': null } },
    { version: 1, bots: { 'account:botA': { stickers: null, capabilities: {} } } }]) {
    const h = harness(), ctx = h.ctx(); h.setRoot({ memory: { socialExpressionAssets: bad } }); const original = structuredClone(h.root());
    await assert.rejects(h.service.sync(ctx), code('STICKER_SCHEMA')); assert.deepEqual(h.root(), original); assert.equal(h.calls.length, 0);
  }
});
await test('damaged account A cannot break B reads/writes; A remains untouched', async () => {
  for (const damaged of [null, { stickers: null, capabilities: {} },
    { stickers: {}, capabilities: { collection: 'corrupt' } }]) {
    const h = harness(), a = h.ctx(), b = h.ctx('account:botB');
    await confirmed(h, a); await confirmed(h, b);
    const bots = h.root().memory.socialExpressionAssets.bots;
    bots['account:botA'] = structuredClone(damaged);
    assert.equal(h.service.list(b).length, 1);
    assert.equal(h.service.candidates(b).length, 1);
    assert((await h.service.prepare(b, { id: 'qq1' })).segment);
    await h.service.sync(b);
    const annotation = await h.service.annotate(b, { id: 'qq1' });
    await h.service.review(b, { id: 'qq1', expectedRevision: annotation.revision, status: 'confirmed', actor: 'admin:B' });
    assert.deepEqual(await h.service.markSent(b, { id: 'qq1', messageId: '30' }), { counted: true });
    assert.deepEqual(h.root().memory.socialExpressionAssets.bots['account:botA'], damaged);
    const original = structuredClone(h.root());
    assert.throws(() => h.service.list(a), code('STICKER_SCHEMA'));
    assert.throws(() => h.service.candidates(a), code('STICKER_SCHEMA'));
    assert.deepEqual(await h.service.prepare(a, { id: 'qq1' }), { segment: null, errorCode: 'STICKER_SCHEMA' });
    const callsBefore = h.calls.length;
    await assert.rejects(h.service.sync(a), code('STICKER_SCHEMA'));
    await assert.rejects(h.service.annotate(a, { id: 'qq1' }), code('STICKER_SCHEMA'));
    await assert.rejects(h.service.review(a, { id: 'qq1', expectedRevision: 1, status: 'confirmed', actor: 'admin:A' }), code('STICKER_SCHEMA'));
    await assert.rejects(h.service.markSent(a, { id: 'qq1', messageId: '31' }), code('STICKER_SCHEMA'));
    assert.equal(h.calls.length, callsBefore);
    assert.deepEqual(h.root(), original);
  }
});
await test('optional fields and missing bot reads never create persistent defaults', async () => {
  const h = harness(), a = h.ctx(), b = h.ctx('account:botB');
  for (const root of [{ memory: {} }, { memory: { socialExpressionAssets: { version: 1, bots: {} } } },
    { memory: { socialExpressionAssets: { version: 1, bots: { 'account:botA': { stickers: {}, capabilities: {} } } } } }]) {
    h.setRoot(structuredClone(root));
    for (const ctx of [a, b]) {
      assert.deepEqual(h.service.list(ctx), []);
      assert.deepEqual(h.service.candidates(ctx), []);
      assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).segment, null);
    }
    assert.deepEqual(h.root(), root);
  }
  await confirmed(h, a);
  const asset = h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1;
  assert.equal(Object.hasOwn(asset, 'sha256'), false);
  delete h.root().memory.socialExpressionAssets.bots['account:botA'].collectionRevision;
  const before = structuredClone(h.root());
  h.service.list(a); h.service.candidates(a);
  assert((await h.service.prepare(a, { id: 'qq1' })).segment);
  assert.deepEqual(h.root(), before);
});
await test('malformed response/network failure preserve library; no unknown fallback', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); const original = structuredClone(h.root());
  for (const response of [{ status: 'ok', retcode: 0, data: {} }, { status: 'failed', retcode: 500 }, { status: 'ok', retcode: 0, data: [{ emoji_id: '__proto__', url: 'https://cdn.qq.com/a' }] }]) {
    h.response(response); await assert.rejects(h.service.sync(ctx)); assert.deepEqual(h.root(), original);
  }
  h.response({ status: 'failed', retcode: 1404 }); assert.deepEqual(await h.service.sync(ctx), { supported: false });
  assert.equal(h.service.candidates(ctx).length, 1); assert(h.calls.every(c => c.action === 'fetch_custom_face_detail'));
});
await test('sync preserves scope notes; changed metadata invalidates approval', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); await h.service.sync(ctx); assert.equal(h.service.candidates(ctx).length, 1);
  h.response({ status: 'ok', retcode: 0, data: [{ emoji_id: 'qq1', url: 'https://cdn.qq.com/b.png' }] });
  await h.service.sync(ctx); assert.equal(h.service.candidates(ctx).length, 0); assert.equal(h.service.list(ctx)[0].annotation.note, '开心赞同');
});
await test('incomplete collection does not delete missing assets; complete tombstones', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.response({ status: 'ok', retcode: 0, data: Array.from({ length: 100 }, (_, i) => ({ emoji_id: `x${i}`, url: 'https://cdn.qq.com/a.png' })) });
  await h.service.sync(ctx); assert.equal(h.service.candidates(ctx).length, 1);
  h.response({ status: 'ok', retcode: 0, data: [] }); await h.service.sync(ctx); assert.deepEqual(h.service.list(ctx), []);
});
await test('failed durable commit never publishes or reports success', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); const original = structuredClone(h.root()); h.failDisk(true);
  await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId: '10' })); assert.deepEqual(h.root(), original);
});
await test('guards after vision/download/persistence and inside latest builder', async () => {
  for (const boundary of ['afterDownload', 'afterVision', 'beforeBuilder']) {
    const h = harness(), ctx = h.ctx(); await h.service.sync(ctx); const original = structuredClone(h.root()); h[boundary](() => h.current(false));
    await assert.rejects(h.service.annotate(ctx, { id: 'qq1' }), code('STICKER_STALE')); assert.deepEqual(h.root(), original);
  }
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.afterPublish(() => h.current(false));
  await assert.rejects(h.service.markSent(ctx, { id: 'qq1', messageId: '10' }), code('STICKER_STALE'));
  assert.equal(h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.annotations['group:1'].sentCount, 1, 'durable ACK must not be retried or rolled back');
});
await test('latest-draft CAS rejects vision race and retains unrelated writes', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.beforeBuilder(() => { h.root().memory.unrelated = 'preserve'; h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.annotations['group:1'].revision++; });
  await assert.rejects(h.service.annotate(ctx, { id: 'qq1' }), code('STICKER_CONFLICT')); assert.equal(h.root().memory.unrelated, 'preserve');
});
await test('media mismatch/failed download/revocation degrade prepare independently', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; h.image(changed);
  assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).errorCode, 'STICKER_CONFLICT');
  h.image(Buffer.from('<svg/>')); assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).errorCode, 'MEDIA_TYPE');
  h.image(png); h.afterDownload(() => { h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.annotations['group:1'].status = 'rejected'; });
  assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).segment, null);
});
await test('failover logical identity remains distinct from independent account', async () => {
  const h = harness(), failover = h.ctx('group:pair'), independent = h.ctx('account:pair');
  await confirmed(h, failover); assert.equal(h.service.candidates(failover).length, 1);
  assert.deepEqual(h.service.list(independent), []);
});
await test('protocol await guard, context mutation, canceled vision and failed download', async () => {
  const h = harness(), ctx = h.ctx();
  const staleService = createStickerService({ ...h.options, request: async (...args) => { const result = await h.options.request(...args); h.current(false); return result; } });
  await assert.rejects(staleService.sync(ctx), code('STICKER_STALE')); assert.deepEqual(h.root(), { memory: {} });
  h.current(true); await confirmed(h, ctx);
  h.afterDownload(() => { ctx.conversationId = 'group:2'; });
  assert.equal((await h.service.prepare(ctx, { id: 'qq1' })).errorCode, 'STICKER_STALE');
  ctx.conversationId = 'group:1'; h.afterDownload(() => {});
  const abort = new AbortController(); h.afterVision(() => abort.abort());
  await assert.rejects(h.service.annotate(ctx, { id: 'qq1', signal: abort.signal }), code('STICKER_ABORTED'));
  const failedMedia = createStickerService({ ...h.options, downloadImage: async () => { throw new Error('upstream private detail'); } });
  assert.deepEqual(await failedMedia.prepare(ctx, { id: 'qq1' }), { segment: null, errorCode: 'STICKER_MEDIA_FAILED' });
});
await test('concurrent sync stale result cannot overwrite newer durable collection', async () => {
  const h = harness(), ctx = h.ctx(), pending = [];
  const service = createStickerService({ ...h.options, request: () => new Promise(resolve => pending.push(resolve)) });
  const first = service.sync(ctx), second = service.sync(ctx);
  pending[0]({ status: 'ok', retcode: 0, data: [{ emoji_id: 'new', url: 'https://cdn.qq.com/new.png' }] }); await first;
  pending[1]({ status: 'ok', retcode: 0, data: [] });
  await assert.rejects(second, code('STICKER_CONFLICT')); assert.equal(service.list(ctx)[0].id, 'new');
});
await test('damaged annotation/receipt refuses writes, without empty replacement', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.root().memory.socialExpressionAssets.bots['account:botA'].stickers.qq1.annotations['group:1'].sentCount = 99;
  const original = structuredClone(h.root());
  await assert.rejects(h.service.sync(ctx), code('STICKER_SCHEMA')); assert.deepEqual(h.root(), original);
});
await test('same ACK cannot count against two different assets in one scope', async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  const bot = h.root().memory.socialExpressionAssets.bots['account:botA'];
  bot.stickers.qq2 = { ...structuredClone(bot.stickers.qq1), id: 'qq2' };
  await h.service.markSent(ctx, { id: 'qq1', messageId: '20' });
  await assert.rejects(h.service.markSent(ctx, { id: 'qq2', messageId: '20' }), code('STICKER_RECEIPT_CONFLICT'));
  assert.equal(h.service.list(ctx).find(x => x.id === 'qq2').annotation.sentCount, 0);
});
await test('PNG/JPEG/GIF/WebP magic; SVG/spoof/oversize rejected', () => {
  for (const [buffer, mime] of [[png, 'image/png'], [gif, 'image/gif'], [jpg, 'image/jpeg'], [webp, 'image/webp']]) assert.equal(validateImage(buffer, mime).mimeType, mime);
  assert.throws(() => validateImage(png, 'image/svg+xml'), code('MEDIA_TYPE'));
  assert.throws(() => validateImage(Buffer.from('<svg/>'), 'image/png'), code('MEDIA_TYPE'));
  assert.throws(() => validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)), code('MEDIA_SIZE'));
});
await test('URL private/credential/local-file/odd ports + IPv6 mappings denied', () => {
  for (const url of ['file:///etc/passwd', 'data:image/png;base64,AA', 'https://user:pass@cdn.qq.com/a', 'https://cdn.qq.com:444/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:8.8.8.8]/a', 'http://localhost/a', 'https://foo.local/a']) assert.throws(() => publicMediaUrl(url), undefined, url);
  for (const ip of ['0.0.0.0', '10.1.1.1', '100.64.1.1', '172.31.0.1', '192.168.1.1', '198.18.0.1', '224.1.1.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:808:808::1', '::ffff:0808:0808']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
});
await test('DNS all-answer validation before HTTP', async () => {
  let calls = 0;
  for (const answers of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const reader = createPublicMediaReader({ lookup: async () => answers, request: () => { calls++; throw Error('forbidden'); } });
    await assert.rejects(reader('https://cdn.qq.com/a'), code('MEDIA_DNS'));
  }
  assert.equal(calls, 0);
});
await test('DNS rebinding cannot replace pinned lookup (including all=true)', async () => {
  let resolutions = 0;
  const fake = fakeHTTP({}, (_url, options) => {
    options.lookup('cdn.qq.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup('cdn.qq.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    assert.equal(options.agent, false);
  });
  const reader = createPublicMediaReader({ request: fake.request, lookup: async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; } });
  assert.equal((await reader('https://cdn.qq.com/a')).mimeType, 'image/png'); assert.equal(resolutions, 1);
});
await test('every redirect rechecks URL + DNS; no internal hop ever requested', async () => {
  for (const target of ['http://127.0.0.1/a', 'https://private.qq.com/a', 'https://u:p@cdn.qq.com/a', 'file:///etc/passwd']) {
    const fake = fakeHTTP({ 'https://cdn.qq.com/a': { status: 302, headers: { location: target } } });
    const reader = createPublicMediaReader({ request: fake.request, lookup: async host => host === 'private.qq.com' ? [{ address: '10.0.0.1', family: 4 }] : publicDNS() });
    await assert.rejects(reader('https://cdn.qq.com/a')); assert.equal(fake.calls.length, 1);
  }
});
await test('same-host redirect performs fresh DNS preflight (rebind rejected)', async () => {
  let n = 0; const fake = fakeHTTP({ 'https://cdn.qq.com/a': { status: 302, headers: { location: '/b' } } });
  const reader = createPublicMediaReader({ request: fake.request, lookup: async () => [{ address: ++n === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }] });
  await assert.rejects(reader('https://cdn.qq.com/a'), code('MEDIA_DNS')); assert.equal(fake.calls.length, 1);
});
await test('valid redirects work; loops bounded; HTTPS downgrade rejected', async () => {
  const routes = { 'https://cdn.qq.com/a': { status: 302, headers: { location: '/b' } }, 'https://cdn.qq.com/b': { body: png } };
  assert.equal((await createPublicMediaReader({ lookup: publicDNS, request: fakeHTTP(routes).request })('https://cdn.qq.com/a')).mimeType, 'image/png');
  routes['https://cdn.qq.com/b'] = { status: 302, headers: { location: '/a' } };
  await assert.rejects(createPublicMediaReader({ lookup: publicDNS, request: fakeHTTP(routes).request, maxRedirects: 1 })('https://cdn.qq.com/a'), code('MEDIA_REDIRECT'));
  routes['https://cdn.qq.com/a'].headers.location = 'http://cdn.qq.com/b';
  await assert.rejects(createPublicMediaReader({ lookup: publicDNS, request: fakeHTTP(routes).request })('https://cdn.qq.com/a'), code('MEDIA_REDIRECT'));
});
await test('streaming size, content-length, MIME and encoding validation', async () => {
  for (const route of [
    { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
    { headers: {}, body: Buffer.alloc(MAX_IMAGE_BYTES + 1) },
    { headers: { 'content-length': '100' }, body: png },
    { headers: { 'content-type': 'image/svg+xml' }, body: png },
    { headers: { 'content-encoding': 'gzip' } }, { status: 403 }
  ]) await assert.rejects(createPublicMediaReader({ lookup: publicDNS, request: fakeHTTP({ 'https://cdn.qq.com/a': route }).request })('https://cdn.qq.com/a'));
});
await test('cancellation and whole-operation DNS/body timeout', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(createPublicMediaReader({ lookup: async () => { calls++; return publicDNS(); } })('https://cdn.qq.com/a', { signal: abort.signal }), code('MEDIA_ABORTED')); assert.equal(calls, 0);
  await assert.rejects(createPublicMediaReader({ timeoutMs: 10, lookup: () => new Promise(() => {}) })('https://cdn.qq.com/a'), code('MEDIA_TIMEOUT'));
  await assert.rejects(createPublicMediaReader({ timeoutMs: 10, lookup: publicDNS, request: fakeHTTP({ 'https://cdn.qq.com/a': { hang: true } }).request })('https://cdn.qq.com/a'), code('MEDIA_TIMEOUT'));
  const activeAbort = new AbortController();
  const pending = createPublicMediaReader({ lookup: publicDNS, request: fakeHTTP({ 'https://cdn.qq.com/a': { hang: true } }).request })('https://cdn.qq.com/a', { signal: activeAbort.signal });
  setTimeout(() => activeAbort.abort(), 5);
  await assert.rejects(pending, code('MEDIA_ABORTED'));
});
console.log(`sticker-service self-test: ${passed} passed (mock only; no network/QQ)`);
