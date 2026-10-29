import assert from 'node:assert/strict';
import { createStickerService } from '../src/sticker-service.js';
import { validateSocialExperiencePolicy } from '../src/social-experience-policy.js';
import { validateQzonePolicy } from '../src/qzone-policy.js';

const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
let root = { memory: {} }, active = true, safe = true, wire = 0;
const policy = validateSocialExperiencePolicy({ enabled: true, shadowMode: false, conversationIds: ['group:123'],
  stickers: { enabled: true, autoSend: true, autonomousSelection: true, webSearch: true } });
const ctx = { logicalId: 'account:fixture', conversationId: 'group:123', policy };
const cache = new Map();
const service = createStickerService({ readState: () => root,
  transact: async build => { const next = structuredClone(root); const result = build(next); root = next; return result; },
  isCurrent: value => active && value === ctx, request: async () => { wire++; throw new Error('no wire'); },
  mediaCache: { put: async (id, media) => { cache.set(`${id}:${media.sha256}`, media); return true; },
    read: async (id, hash) => cache.get(`${id}:${hash}`) },
  describeImage: async () => ({ sticker: true, safeToReuse: safe, confidence: 0.95, note: '无语表情', tags: ['无语'], usage: '轻松无语时回应', avoid: [] }),
  downloadImage: async () => ({ buffer, mimeType: 'image/png' }), clock: () => 10000 });
const metadata = { provider: 'memecub', url: 'https://cdn.example.com/public.png', pageUrl: 'https://memecub.com/meme/example',
  license: { code: 'web', commercial_use: false, attribution_required: false } };
const imported = await service.importPublic(ctx, metadata);
assert.equal(service.candidates(ctx, { query: '无语' })[0].id, imported.id);
assert.equal(root.memory.socialExpressionAssets.bots[ctx.logicalId].stickers[imported.id].annotations[ctx.conversationId].status, 'candidate', 'AI qualification never fabricates administrator approval');
assert.equal((await service.prepare(ctx, imported)).segment.type, 'image');
policy.stickers.autonomousSelection = false;
assert.equal(service.candidates(ctx, { query: '无语' }).length, 0);
policy.stickers.autonomousSelection = true;
const annotation = root.memory.socialExpressionAssets.bots[ctx.logicalId].stickers[imported.id].annotations[ctx.conversationId];
await service.review(ctx, { id: imported.id, expectedRevision: annotation.revision, status: 'rejected', actor: 'fixture-owner' });
assert.equal(service.candidates(ctx, { query: '无语' }).length, 0);
await assert.rejects(() => service.importPublic(ctx, metadata), /REJECTED/);
assert.equal((await service.prepare(ctx, imported)).segment, null);
// A different ID/source must not resurrect the same rejected bytes.
const assets = root.memory.socialExpressionAssets.bots[ctx.logicalId].stickers;
assets.rejected_alias = { ...structuredClone(assets[imported.id]), id: 'rejected_alias' };
delete assets[imported.id];
await assert.rejects(() => service.importPublic(ctx, metadata), /REJECTED/);
// Legacy collection annotations are descriptions, not privacy qualifications.
const legacy = assets.rejected_alias;
delete assets.rejected_alias;
legacy.id = 'legacy_collection'; legacy.source = 'collection'; legacy.url = metadata.url;
legacy.annotations[ctx.conversationId].status = 'candidate';
delete legacy.annotations[ctx.conversationId].reuseQualification;
assets.legacy_collection = legacy;
assert.equal(service.candidates(ctx, { query: '无语' }).length, 0);
await service.annotate(ctx, { id: legacy.id });
assert.equal(service.candidates(ctx, { query: '无语' })[0].id, legacy.id);
active = false;
await assert.rejects(() => service.importPublic(ctx, metadata), /STALE/);
active = true; root = { memory: {} }; safe = false;
await assert.rejects(() => service.importPublic(ctx, metadata), /UNSAFE/);
safe = true;
await assert.rejects(() => service.importPublic(ctx, { ...metadata, license: { attribution_required: true } }), /POLICY/);
await assert.rejects(() => service.importPublic(ctx, { ...metadata, provider: 'model-claim' }), /POLICY/);
assert.equal(validateQzonePolicy({ reviewTransport: 'qq_owner' }).reviewTransport, 'qq_owner');
assert.throws(() => validateQzonePolicy({ reviewTransport: 'model_auto_approval' }));
assert.equal(wire, 0);
console.log(JSON.stringify({ ok: true, checks: 18, realQQCalls: wire, realModelCalls: 0 }));
