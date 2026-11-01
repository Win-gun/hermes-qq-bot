// Node 22. Synthetic OneBot/host policy only; no QQ, models, production or timers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRuntime } from '../src/memory-runtime.js';
import { BackgroundMemoryRepository } from '../src/memory-repository-service.js';
import { createQzoneRuntime } from '../src/qzone-runtime.js';
import { createQzoneOwnerReview } from '../src/qzone-owner-review.js';
import { normalizeQzonePolicy } from '../src/qzone-policy.js';

assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Run with Node 22');
let checks = 0;
const clone = structuredClone, sha = value => createHash('sha256').update(value).digest('hex');
const denied = (fn, code = 'QZONE_') => assert.rejects(fn, new RegExp(code));
const fixtures = [];
async function test(name, run) {
  try { await run(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  finally { for (const f of fixtures.splice(0)) await f.close(); }
}
async function fixture({ policy: patch = {}, disk = false } = {}) {
  let at = Date.UTC(2026, 10, 1), revision = 'r1', quiet = false, active = true, qq = '10001';
  let lowImpact = true, sourceActive = true, imageActive = true, previewUncertain = false;
  let beforeWire, afterTransaction, failCommit = false, beforePreviewWire, writeEnvelope;
  let messageSequence = 100, feedSequence = 0, transactionSequence = 0;
  const policy = normalizeQzonePolicy({ enabled: true, mode: 'scoped_autonomy', reviewTransport: 'qq_owner',
    reads: { feeds: true, own: true, cooldownMs: 0 },
    publish: { enabled: true, maxDaily: 20, cooldownMs: 0 },
    likes: { enabled: true, maxDaily: 20, cooldownMs: 0 },
    comments: { enabled: true, maxDaily: 20, cooldownMs: 0 },
    autonomy: { enabled: true, maxContentLength: 280, sources: [] }, ...patch });
  const admin = Object.freeze({ host: true }), ownerId = '20001', ownerActors = new WeakMap();
  const bytes = [Buffer.from('synthetic-public-image-a'), Buffer.from('synthetic-public-image-b')];
  const images = new Map(bytes.map((buffer, i) => [`image${i}`, { id: `image${i}`, sha256: sha(buffer),
    provenance: 'public', immutable: true, containsPrivateMaterial: false,
    wireReference: `base64://${buffer.toString('base64')}` }]));
  let persisted = {}, repositoryRevision = 0, home;
  const repository = disk ? new BackgroundMemoryRepository({ filePath: path.join(
    home = await mkdtemp(path.join(os.tmpdir(), 'qzone35-')), 'memory.json') }) : {
    open: async () => ({ value: clone(persisted), revision: repositoryRevision }),
    commit: async (value, options) => {
      assert.equal(options.expectedRevision, repositoryRevision);
      if (failCommit) throw Error('MEMORY_OPERATION_UNCERTAIN');
      persisted = clone(value); return { value: clone(persisted), revision: ++repositoryRevision };
    }, status: () => ({}), close: async () => {}
  };
  const memory = new MemoryRuntime(repository); await memory.open();
  const transact = async build => {
    const result = await memory.transact(root => build(root));
    await afterTransaction?.(++transactionSequence);
    return result;
  };
  const source = Object.freeze({ kind: 'public_information', ref: 'public:topic' });
  const calls = [], requests = [], previews = [], assessments = [];
  const current = ctx => active && !quiet && ctx.accountId === 'a' && ctx.logicalId === 'bot:a'
    && ctx.revision === revision && ctx.qq === qq;
  let runtime, review, ctx, reviewCtx;
  const deps = {
    capture: accountId => ({ accountId, logicalId: 'bot:a', qq, revision, policy, protocolVersion: 'fakeOneBot-v1' }),
    isCurrent: current, readState: () => ({ memory: memory.value }),
    transact: build => transact(root => build({ memory: root })), clock: () => at, peerQqs: () => [],
    isAdministrator: (_ctx, actor) => actor === admin || ownerActors.has(actor),
    isOwnerReviewActor: (_ctx, actor, draft) => ownerActors.get(actor)?.current(draft) === true,
    isSourceAllowed: (_ctx, candidate) => sourceActive && candidate.kind === source.kind && candidate.ref === source.ref,
    isLowImpact: (_ctx, draft) => {
      assert.equal(Object.isFrozen(draft), true); assessments.push(draft);
      return lowImpact && (draft.kind !== 'publish' || draft.source.kind === 'public_information');
    },
    resolveImage: (_ctx, id) => imageActive ? images.get(id) : undefined,
    request: async (scope, action, params, { binding }) => {
      requests.push(action); await beforeWire?.(scope, action, binding);
      if (!binding.isCurrent()) throw Error('QZONE_WIRE_REVOKED');
      binding.onSendStarted();
      calls.push({ action, params: clone(params), snapshot: clone(memory.value) });
      if (action === 'get_qzone_feeds') return { status: 'ok', retcode: 0, data: { feeds: [{
        uin: 30001, tid: `friend_${++feedSequence}`, time: Math.floor(at / 1000),
        content: '朋友现有访问范围内的动态', content_complete: true
      }], has_more: false } };
      if (writeEnvelope) return typeof writeEnvelope === 'function' ? writeEnvelope() : clone(writeEnvelope);
      return { status: 'ok', retcode: 0, data: { tid: `sent_${calls.length}` } };
    }
  };
  runtime = createQzoneRuntime(deps); ctx = runtime.open('a');
  const reviewDeps = {
    read: () => memory.value, transact, isCurrent: current, isOwner: (_ctx, userId) => active && userId === ownerId,
    getDraft: (_ctx, id) => runtime.status(ctx).drafts.find(row => row.id === id), clock: () => at,
    sendPreview: async (_ctx, userId, draft, info) => {
      await beforePreviewWire?.();
      if (!info.current()) throw Error('QZONE_PREVIEW_REVOKED');
      previews.push({ userId, draft, ...info, messageId: String(++messageSequence) });
      return previewUncertain ? { status: 'uncertain' } : { status: 'confirmed', messageId: String(messageSequence) };
    },
    publish: async (_ctx, record, _envelope, execution) => {
      const actor = Object.freeze({ hostOwner: true }); ownerActors.set(actor, execution);
      try {
        let row = runtime.status(ctx).drafts.find(row => row.id === record.draftId);
        assert.equal(row.revision, record.draftRevision);
        if (row.status === 'draft') row = await runtime.submitReview(ctx, row.id, row.revision, actor);
        row = await runtime.approve(ctx, row.id, row.revision, actor);
        const result = await runtime.publish(ctx, row.id, row.revision, { actor });
        return { status: result.protocolAccepted ? 'accepted' : result.status === 'failed' ? 'failed' : 'uncertain' };
      } finally { ownerActors.delete(actor); }
    },
    cancel: async (_ctx, record) => {
      await runtime.cancel(ctx, record.draftId, record.draftRevision, admin);
      return { status: 'confirmed', code: 'QZONE_CANCELLED' };
    }
  };
  review = createQzoneOwnerReview(reviewDeps); reviewCtx = review.capture(ctx);
  const f = { memory, repository, admin, source, images, calls, requests, previews, assessments, deps, reviewDeps, ownerActors,
    get ctx() { return ctx; }, get reviewCtx() { return reviewCtx; },
    get runtime() { return runtime; }, get review() { return review; },
    get at() { return at; }, get commits() { return transactionSequence; },
    close: async () => { await memory.close(); if (home) await rm(home, { recursive: true, force: true }); },
    create: (content = `公开低影响创作${transactionSequence}`, extra = {}) => runtime.createDraft(ctx,
      { content, source, ...extra }, admin),
    publish: row => runtime.publish(ctx, row.id, row.revision, { actor: admin }),
    propose: async kind => runtime.proposeInteraction(ctx, { kind, feedId: (await runtime.readFeeds(ctx)).feeds[0].id,
      ...(kind === 'comment' ? { content: '谢谢分享，挺有意思' } : {}) }, admin),
    offer: row => review.offer(reviewCtx, row.id, ownerId),
    event: (extra = {}) => ({ private: true, verified: true, userId: ownerId, accountId: 'a', logicalId: 'bot:a',
      actualQq: qq, controlRevision: revision, messageId: '9001', replyMessageId: previews.at(-1)?.messageId, ...extra }),
    handle: (text = '发吧', extra = {}) => review.handle(reviewCtx, f.event(extra), text),
    token: (action = 'confirm') => review.handle(reviewCtx, { private: true, verified: true, userId: ownerId },
      `/bot qzone ${action} ${previews.at(-1).token}`),
    quiet: value => { quiet = value; }, withdraw: () => { lowImpact = false; },
    revokeSource: () => { sourceActive = false; }, expireImages: () => { imageActive = false; },
    tick: ms => { at += ms; }, bump: () => { revision = 'r2'; }, actualQq: value => { qq = value; },
    stop: () => { active = false; }, beforeWire: fn => { beforeWire = fn; },
    afterTransaction: fn => { afterTransaction = fn; }, beforePreviewWire: fn => { beforePreviewWire = fn; },
    envelope: raw => { writeEnvelope = raw; }, failCommit: value => { failCommit = value; },
    uncertainPreview: () => { previewUncertain = true; },
    rebind: () => { ctx = runtime.open('a'); reviewCtx = review.capture(ctx); },
    rebindConsumer: () => { review = createQzoneOwnerReview(reviewDeps); reviewCtx = review.capture(ctx); },
    raw: id => memory.value.qzoneSocial.bots['bot:a'].owners['10001'].drafts[id],
    replace: (id, mutate) => transact(root => mutate(root.qzoneSocial.bots['bot:a'].owners['10001'].drafts[id]))
  };
  fixtures.push(f); return f;
}
async function bootstrap(f, kind = 'publish') {
  const row = kind === 'publish' ? await f.create(`明确确认样本${f.commits}`) : await f.propose(kind);
  await f.offer(row); assert.equal((await f.handle()).status, 'accepted');
  return row;
}
const writes = f => f.calls.filter(call => !call.action.startsWith('get_'));

await test('defaults stay self-only, disabled; no broader implicit audiences', () => {
  const p = normalizeQzonePolicy(); assert.equal(p.ugcRight, 64); assert.deepEqual(p.allowedAudiences, [64]);
  assert.equal(p.autonomy.enabled, false); assert.equal(p.mode, 'draft_only');
});
await test('unknown support is never autonomous; descriptor inspection does not write or probe', async () => {
  const f = await fixture(), before = clone(f.memory.value);
  for (const d of f.runtime.capabilityDescriptors(f.ctx)) {
    assert.equal(d.actualSupport, false); assert.equal(d.autonomous, false); assert.equal(d.support, 'unknown');
  }
  assert.deepEqual(f.memory.value, before); assert.equal(f.requests.length, 0); assert.equal(f.commits, 0);
  const row = await f.create(); await denied(() => f.publish(row), 'APPROVAL_REQUIRED');
  assert.equal(f.calls.length, 0);
});
await test('quoted exact preview bootstraps once then low-impact creativity uses standing authority', async () => {
  const f = await fixture(); await bootstrap(f);
  const row = await f.create('不是配置固定正文的新公开创作');
  const result = await f.publish(row);
  assert.equal(result.protocolAccepted, true); assert.equal(result.clientVerified, false);
  assert.equal(writes(f).length, 2); assert.equal(f.previews.length, 1);
  assert.equal(writes(f).at(-1).params.ugc_right, 64);
  assert.equal(f.runtime.capabilityDescriptors(f.ctx)[0].autonomous, true);
  const claimed = writes(f).at(-1).snapshot.qzoneSocial.bots['bot:a'].owners['10001'].drafts[row.id];
  assert.equal(claimed.status, 'publishing'); assert.ok(claimed.claimId);
  assert.equal(f.raw(row.id).protocolAccepted, true);
  await denied(() => f.publish(result)); assert.equal(writes(f).length, 2);
});
await test('existing explicit friends/public audience stays bounded; unconfigured audience is refused', async () => {
  for (const audience of [4, 1]) {
    const f = await fixture({ policy: { ugcRight: audience, allowedAudiences: [64, audience] } });
    await bootstrap(f); const row = await f.create(`已有受众${audience}`); await f.publish(row);
    assert.equal(writes(f).at(-1).params.ugc_right, audience);
  }
  const f = await fixture(); await denied(() => f.create('不得扩大', { audience: 4 }), 'AUDIENCE');
  assert.equal(f.calls.length, 0);
});
await test('console cannot approve a reviewed qq_owner draft, even with a host admin object', async () => {
  const f = await fixture({ policy: { mode: 'reviewed' } });
  let row = await f.create(); row = await f.runtime.submitReview(f.ctx, row.id, row.revision, f.admin);
  await denied(() => f.runtime.approve(f.ctx, row.id, row.revision, f.admin), 'OWNER_QQ_CONFIRM_REQUIRED');
  await denied(() => f.publish(row), 'APPROVAL_REQUIRED'); assert.equal(writes(f).length, 0);
  await f.offer(row); assert.equal((await f.token()).status, 'accepted'); assert.equal(writes(f).length, 1);
});
await test('legacy console reviewed path remains functional', async () => {
  const f = await fixture({ policy: { mode: 'reviewed', reviewTransport: 'console' } });
  let row = await f.create(); row = await f.runtime.submitReview(f.ctx, row.id, row.revision, f.admin);
  row = await f.runtime.approve(f.ctx, row.id, row.revision, f.admin);
  assert.equal((await f.publish(row)).protocolAccepted, true);
});
await test('high-impact/unknown assessment falls back to natural confirmation, never a silent send', async () => {
  const f = await fixture(); await bootstrap(f); f.withdraw(); const row = await f.create();
  await denied(() => f.publish(row), 'APPROVAL_REQUIRED'); assert.equal(writes(f).length, 1);
  await f.offer(row); assert.equal((await f.handle()).status, 'accepted');
  assert.equal(writes(f).length, 2);
});
await test('dynamic descriptors respect actual remaining daily budget', async () => {
  const f = await fixture({ policy: { publish: { enabled: true, maxDaily: 1, cooldownMs: 0 } } });
  await bootstrap(f); const descriptor = f.runtime.capabilityDescriptors(f.ctx)[0];
  assert.equal(descriptor.actualSupport, true); assert.equal(descriptor.remainingDaily, 0);
  assert.equal(descriptor.autonomous, false); assert.equal(descriptor.reason, 'QZONE_BUDGET_OR_COOLDOWN');
  const row = await f.create('已无预算'); await denied(() => f.publish(row), 'BUDGET');
  assert.equal(writes(f).length, 1);
});
await test('likes and comments need their OWN real settled support and fresh scoped feed handle', async () => {
  for (const kind of ['like', 'comment']) {
    const f = await fixture(); await bootstrap(f);
    const unknown = await f.propose(kind); await denied(() => f.publish(unknown), 'APPROVAL_REQUIRED');
    await f.offer(unknown); assert.equal((await f.handle()).status, 'accepted');
    const row = await f.propose(kind); assert.equal((await f.publish(row)).protocolAccepted, true);
    const call = writes(f).at(-1); assert.equal(call.action, `${kind}_qzone`);
    assert.equal(call.params.target_uin, 30001); assert.ok(call.params.tid);
    if (kind === 'comment') assert.equal(call.params.content, row.content);
    assert.equal(f.runtime.capabilityDescriptors(f.ctx).find(d => d.kind === kind).actualSupport, true);
    await denied(() => f.publish(f.runtime.status(f.ctx).drafts.find(d => d.id === row.id)));
    assert.equal(writes(f).length, 3);
  }
});
await test('unsupported like/comment is not faked as accepted or enabled', async () => {
  for (const kind of ['like', 'comment']) {
    const f = await fixture(); const row = await f.propose(kind); await f.offer(row);
    f.envelope({ status: 'failed', retcode: 1404, data: null });
    assert.equal((await f.handle()).status, 'failed');
    const d = f.runtime.capabilityDescriptors(f.ctx).find(d => d.kind === kind);
    assert.equal(d.support, 'unsupported'); assert.equal(d.autonomous, false);
    const next = await f.propose(kind); await denied(() => f.publish(next), 'UNSUPPORTED');
    assert.equal(writes(f).length, 1);
  }
});
await test('malformed ACK and missing data never establish action support', async () => {
  for (const kind of ['publish', 'like', 'comment']) {
    const f = await fixture(); const row = kind === 'publish' ? await f.create() : await f.propose(kind);
    await f.offer(row); f.envelope({ status: 'ok', retcode: '0', data: {} });
    assert.equal((await f.handle()).status, 'uncertain');
    assert.equal(f.runtime.capabilityDescriptors(f.ctx).find(d => d.kind === kind).actualSupport, false);
    assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 1);
  }
});
await test('ordered immutable image hashes and exact source/body survive standing authorization', async () => {
  const f = await fixture(); await bootstrap(f); const row = await f.create('两张公开配图', { images: ['image1', 'image0'] });
  assert.deepEqual(row.imageClaims, ['image1', 'image0'].map(id => ({ id, sha256: f.images.get(id).sha256 })));
  await f.publish(row); const params = writes(f).at(-1).params;
  assert.deepEqual(params.images, ['image1', 'image0'].map(id => f.images.get(id).wireReference));
  assert.equal(params.content, row.content); assert.equal(params.ugc_right, row.audience);
  assert.doesNotMatch(JSON.stringify(f.memory.value), /base64:\/\/|file:\/\//);
});
for (const phase of ['before_claim', 'queued_wire']) {
  await test(`expired image claims fail closed at ${phase}`, async () => {
    const f = await fixture(); await bootstrap(f); const row = await f.create('过期配图不可发布', { images: ['image0'] });
    if (phase === 'before_claim') { f.expireImages(); await denied(() => f.publish(row), 'IMAGE'); }
    else {
      f.beforeWire(() => f.expireImages()); assert.equal((await f.publish(row)).status, 'uncertain');
    }
    assert.equal(writes(f).length, 1);
  });
}
await test('private sources cannot be promoted to a public publication', async () => {
  const f = await fixture(); await bootstrap(f);
  await denied(() => f.create('私聊内容', { source: { kind: 'private_qzone', ref: 'private' } }), 'SOURCE');
  const row = await f.create('公开来源草稿'); await f.replace(row.id, r => { r.source.kind = 'private_qzone'; });
  await denied(() => f.publish(row), 'SOURCE'); assert.equal(writes(f).length, 1);
});
for (const mutate of [f => f.quiet(true), f => f.withdraw(), f => f.revokeSource(), f => f.bump(),
  f => f.actualQq('10002'), f => f.stop()]) {
  await test('queued wire rechecks quiet/withdraw/source/control/actualQQ/route', async () => {
    const f = await fixture(); await bootstrap(f); const row = await f.create();
    f.beforeWire(() => mutate(f)); assert.equal((await f.publish(row)).status, 'uncertain');
    assert.equal(writes(f).length, 1);
  });
}
await test('a newly bound consumer cannot inherit a fresh autonomous draft grant', async () => {
  const f = await fixture(); await bootstrap(f); const row = await f.create(); f.rebind();
  await denied(() => f.publish(row), 'SOURCE_PROOF_REQUIRED'); assert.equal(writes(f).length, 1);
});
await test('queued claim TTL expires without any write or replay', async () => {
  const f = await fixture(); await bootstrap(f); const row = await f.create();
  f.beforeWire(() => f.tick(60001)); const result = await f.publish(row);
  assert.equal(result.status, 'uncertain'); assert.equal(writes(f).length, 1);
  f.beforeWire(null); await denied(() => f.publish(result));
});
await test('quiet after durable claim publication still blocks before transport starts', async () => {
  const f = await fixture(); await bootstrap(f); const row = await f.create(), commits = f.commits;
  f.afterTransaction(n => { if (n === commits + 1) f.quiet(true); });
  assert.equal((await f.publish(row)).status, 'uncertain'); assert.equal(writes(f).length, 1);
});
await test('natural reply requires an exact saved preview ID, not unquoted/forwarded prose', async () => {
  const f = await fixture(); const row = await f.create(); await f.offer(row);
  assert.equal((await f.handle('发吧', { replyMessageId: undefined })).matched, false);
  for (const id of ['99999', '转发的预览正文', 101, '', ' 101'])
    assert.equal((await f.handle('发吧', { replyMessageId: id })).status, 'blocked');
  assert.equal(writes(f).length, 0); assert.equal((await f.handle()).status, 'accepted');
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 1);
});
await test('natural decline cancels exact draft and duplicate references never replay', async () => {
  const f = await fixture(); const row = await f.create(); await f.offer(row);
  assert.equal((await f.handle('不发了')).status, 'confirmed'); assert.equal(f.raw(row.id).cancelRequested, true);
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
});
for (const extra of [{ private: false }, { verified: false }, { userId: '20002' }, { accountId: 'b' },
  { logicalId: 'bot:b' }, { actualQq: '10002' }, { controlRevision: 'r0' }, { messageId: undefined },
  { accountId: undefined }, { actualQq: undefined }]) {
  await test('natural decision authenticates owner/private/account/logical/actualQQ/revision/message', async () => {
    const f = await fixture(); await f.offer(await f.create());
    assert.equal((await f.handle('发吧', extra)).status, 'blocked'); assert.equal(writes(f).length, 0);
  });
}
for (const mutate of [r => { r.content += '改'; }, r => { r.source.ref = 'public:other'; },
  r => { r.audience = 4; }, r => { r.images.reverse(); }, r => { r.images[0].sha256 = 'a'.repeat(64); },
  r => { r.revision++; }]) {
  await test('owner quote binds exact version/body/source/audience/ordered image hashes', async () => {
    const f = await fixture(); const row = await f.create('精确预览', { images: ['image0', 'image1'] });
    await f.offer(row); await f.replace(row.id, mutate);
    assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
  });
}
await test('owner preview expiry and scope rebinding invalidate old quotes', async () => {
  const f = await fixture(); await f.offer(await f.create()); f.tick(1800000);
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
  const g = await fixture(); await g.offer(await g.create()); g.bump(); g.rebind();
  assert.equal((await g.handle()).status, 'blocked'); assert.equal(writes(g).length, 0);
});
await test('a consumed preview actor cannot approve a different draft', async () => {
  const f = await fixture({ policy: { mode: 'reviewed' } });
  const other = await f.create('另一份没有审批的草稿');
  const otherReview = await f.runtime.submitReview(f.ctx, other.id, other.revision, f.admin);
  const publish = f.reviewDeps.publish;
  f.reviewDeps.publish = async (ctx, record, event, execution) => {
    const actor = Object.freeze({ testOwner: true }); f.ownerActors.set(actor, execution);
    assert.equal(execution.current({ ...otherReview, revision: record.draftRevision }), false);
    await denied(() => f.runtime.approve(f.ctx, otherReview.id, otherReview.revision, actor), 'OWNER_QQ_CONFIRM_REQUIRED');
    f.ownerActors.delete(actor); return publish(ctx, record, event, execution);
  };
  f.rebindConsumer(); await f.offer(await f.create('这一份才有审批'));
  assert.equal((await f.handle()).status, 'accepted'); assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0].params.content, '这一份才有审批');
});
await test('in-place MemoryRuntime publication cannot retarget or extend a consumed review snapshot', async () => {
  const f = await fixture(); await f.offer(await f.create()); const commits = f.commits;
  f.afterTransaction(async n => {
    if (n === commits + 1) await f.memory.transact(root => { Object.values(root.qzoneOwnerReviews.records)[0].expiresAt++; });
  });
  assert.equal((await f.handle()).status, 'uncertain'); assert.equal(writes(f).length, 0);
});
await test('owner confirmation expires/revokes even while already queued through runtime', async () => {
  for (const mutation of [f => f.tick(1800001), f => f.quiet(true), f => f.bump(), f => f.expireImages()]) {
    const f = await fixture(); await f.offer(await f.create('有图逐版本预览', { images: ['image0'] }));
    f.beforeWire(() => mutation(f)); assert.equal((await f.handle()).status, 'uncertain');
    assert.equal(writes(f).length, 0); assert.equal((await f.offer(f.runtime.status(f.ctx).drafts[0]).catch(() => ({ status: 'blocked' }))).status, 'blocked');
  }
});
await test('uncertain preview cannot be re-offered or consumed', async () => {
  const f = await fixture(); const row = await f.create(); f.uncertainPreview();
  assert.equal((await f.offer(row)).status, 'uncertain'); assert.equal((await f.offer(row)).status, 'blocked');
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
});
await test('preview queued behind quiet sends nothing and consumes the offer once', async () => {
  const f = await fixture(); const row = await f.create(); f.beforePreviewWire(() => f.quiet(true));
  assert.equal((await f.offer(row)).status, 'uncertain'); assert.equal(f.previews.length, 0);
  f.quiet(false); assert.equal((await f.offer(row)).status, 'blocked');
});
await test('uncertain publication has no retry even after consumer recreation', async () => {
  const f = await fixture(); await f.offer(await f.create()); f.envelope(() => { throw Error('wire timeout'); });
  assert.equal((await f.handle()).status, 'uncertain'); f.rebindConsumer();
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 1);
});
await test('ambiguous decision claim durability cannot be retried in the same consumer', async () => {
  const f = await fixture(); await f.offer(await f.create()); f.failCommit(true);
  await assert.rejects(() => f.handle(), /MEMORY_OPERATION_UNCERTAIN/); f.failCommit(false);
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
});
await test('consumer rebinding does not clear an uncertain decision claim latch', async () => {
  const f = await fixture(); await f.offer(await f.create()); f.failCommit(true);
  await assert.rejects(() => f.handle(), /MEMORY_OPERATION_UNCERTAIN/); f.failCommit(false);
  f.rebindConsumer(); assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 0);
});
await test('old 32-token record fingerprints remain compatible without weakening natural events', async () => {
  const f = await fixture(); const draft = await f.create(); await f.offer(draft);
  await f.memory.transact(root => {
    const row = Object.values(root.qzoneOwnerReviews.records)[0]; delete row.fingerprintVersion;
    row.fingerprint = sha(JSON.stringify({ id: draft.id, revision: draft.revision, kind: draft.kind,
      source: draft.source, content: draft.content, images: draft.images || [], audience: draft.audience }));
  });
  assert.equal((await f.token()).status, 'accepted'); assert.equal((await f.token()).status, 'blocked');
  assert.equal(writes(f).length, 1);
});
await test('real background MemoryRuntime writer persists one-shot decisions and ACK claims', async () => {
  const f = await fixture({ disk: true }); await bootstrap(f); const row = await f.create('持久化授权创作');
  const result = await f.publish(row); assert.equal(result.protocolAccepted, true);
  const saved = await f.repository.read();
  assert.equal(saved.value.qzoneSocial.bots['bot:a'].owners['10001'].drafts[row.id].protocolAccepted, true);
  assert.equal(Object.values(saved.value.qzoneOwnerReviews.records)[0].status, 'accepted');
  assert.equal((await f.handle()).status, 'blocked'); assert.equal(writes(f).length, 2);
});

console.log(JSON.stringify({ ok: true, scenarios: checks, node: process.versions.node,
  fakeOneBot: true, memoryRuntime: true, backgroundWriter: true, realQQCalls: 0, modelCalls: 0 }));
