import assert from 'node:assert/strict';
import { createQzoneOwnerReview } from '../src/qzone-owner-review.js';

let count = 0;
async function fixture(overrides = {}) {
  let root = {}, at = 100000, current = true, owner = true, sends = 0, publishes = 0;
  let draft = { id: 'draft_fixture', revision: 1, content: '今天看到一个有意思的公开话题',
    images: [{ id: 'public_image', sha256: 'a'.repeat(64) }], audience: 4, status: 'draft' };
  let preview;
  const api = createQzoneOwnerReview({ read: () => root,
    transact: async build => { const next = structuredClone(root); const out = build(next); root = next; return out; },
    isCurrent: () => current, isOwner: (_ctx, userId) => owner && userId === '10001',
    getDraft: () => structuredClone(draft), clock: () => at,
    sendPreview: async (_ctx, _owner, exact, info) => {
      sends++; assert.deepEqual(exact, draft); assert.equal(info.current(), true); preview = info;
      return { status: 'confirmed', messageId: '123' };
    },
    publish: async () => { publishes++; return { status: 'accepted' }; },
    cancel: async () => ({ status: 'confirmed', code: 'CANCELLED' }), ...overrides });
  const ctx = api.capture({ accountId: 'primary', logicalId: 'account:primary', qq: '20001', revision: 'r1' });
  const offer = () => api.offer(ctx, draft.id, '10001');
  const handle = (action = 'confirm', envelope = {}) => api.handle(ctx,
    { private: true, verified: true, userId: '10001', ...envelope }, `/bot qzone ${action} ${preview.token}`);
  return { api, ctx, offer, handle, state: () => root, counts: () => ({ sends, publishes }),
    change: () => { draft.images[0].sha256 = 'b'.repeat(64); },
    expire: () => { at += 1800001; }, revoke: () => { owner = false; }, stale: () => { current = false; } };
}
{
  const f = await fixture(); assert.equal((await f.offer()).status, 'accepted');
  assert.equal((await f.offer()).status, 'blocked');
  assert.equal((await f.handle()).status, 'accepted');
  assert.equal((await f.handle()).status, 'blocked');
  assert.deepEqual(f.counts(), { sends: 1, publishes: 1 }); count++;
}
for (const mutation of ['change', 'expire', 'revoke']) {
  const f = await fixture(); await f.offer(); f[mutation]();
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(f.counts().publishes, 0); count++;
}
for (const envelope of [{ private: false }, { verified: false }, { userId: '10002' }]) {
  const f = await fixture(); await f.offer(); assert.equal((await f.handle('confirm', envelope)).status, 'blocked');
  assert.equal(f.counts().publishes, 0); count++;
}
{
  const f = await fixture({ sendPreview: async () => ({ status: 'uncertain' }) });
  assert.equal((await f.offer()).status, 'uncertain');
  assert.equal((await f.offer()).status, 'blocked'); count++;
}
{
  const f = await fixture(); await f.offer(); assert.equal((await f.handle('reject')).status, 'confirmed');
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(f.counts().publishes, 0); count++;
}
{
  const f = await fixture({ publish: async () => { throw new Error('wire timeout'); } });
  await f.offer(); assert.equal((await f.handle()).status, 'uncertain');
  assert.equal((await f.handle()).status, 'blocked'); count++;
}
{
  const f = await fixture(); await f.offer(); f.stale(); await assert.rejects(() => f.handle(), /STALE/); count++;
}
console.log(JSON.stringify({ ok: true, scenarios: count, realQQCalls: 0 }));
