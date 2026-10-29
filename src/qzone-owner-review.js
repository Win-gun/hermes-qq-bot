import { createHash, randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const fingerprint = draft => createHash('sha256').update(JSON.stringify({
  id: draft.id, revision: draft.revision, kind: draft.kind, source: draft.source, content: draft.content,
  images: draft.images || [], audience: draft.audience
})).digest('hex');
const command = /^\/bot\s+(?:qzone|空间)\s+(confirm|reject|确认|拒绝)\s+([a-f0-9]{32})\s*$/iu;

// A QQ review is not model authority. The host authenticates the original
// carrier/private sender, resolves the exact draft and uses the existing QZone
// publish gate. The one memory writer owns claims; no timer or retry queue.
export function createQzoneOwnerReview({ read, transact, isCurrent, isOwner,
  getDraft, sendPreview, publish, cancel, clock = Date.now } = {}) {
  if ([read, transact, isCurrent, isOwner, getDraft, sendPreview, publish, cancel, clock]
    .some(fn => typeof fn !== 'function')) throw fail('QZONE_REVIEW_CONTRACT');
  const issued = new WeakSet(), poisoned = new Set();
  const guard = ctx => { if (!issued.has(ctx) || !isCurrent(ctx)) throw fail('QZONE_REVIEW_STALE'); };
  const book = (root, create = false) => {
    if (!root.qzoneOwnerReviews && create) root.qzoneOwnerReviews = { version: 1, records: {} };
    const b = root.qzoneOwnerReviews;
    if (b && (b.version !== 1 || !b.records || typeof b.records !== 'object' || Array.isArray(b.records)))
      throw fail('QZONE_REVIEW_STATE');
    return b?.records;
  };
  function capture(scope) {
    if (!scope || typeof scope !== 'object' || !scope.accountId || !scope.logicalId || !scope.qq || !scope.revision)
      throw fail('QZONE_REVIEW_SCOPE');
    const ctx = Object.freeze({ ...scope }); issued.add(ctx); guard(ctx); return ctx;
  }
  async function offer(ctx, id, recipientId) {
    guard(ctx);
    if (!isOwner(ctx, recipientId)) throw fail('QZONE_REVIEW_OWNER_REQUIRED');
    const draft = getDraft(ctx, id);
    if (!draft || !['draft', 'review'].includes(draft.status)) throw fail('QZONE_REVIEW_DRAFT');
    const pin = fingerprint(draft), token = randomBytes(16).toString('hex'), at = clock();
    const key = `${ctx.logicalId}:${ctx.qq}:${id}:${draft.revision}`;
    if (Object.values(book(read()) || {}).some(row => row.key === key))
      return { status: 'blocked', code: 'QZONE_REVIEW_ALREADY_OFFERED' };
    if (poisoned.has(key)) throw fail('QZONE_REVIEW_UNCERTAIN');
    // A throw can mean publication was uncertain: never re-send in this process.
    poisoned.add(key);
    const claim = await transact(root => {
      guard(ctx);
      if (fingerprint(getDraft(ctx, id)) !== pin) throw fail('QZONE_REVIEW_CHANGED');
      const rows = book(root, true);
      if (Object.values(rows).some(row => row.key === key)) return false;
      const terminal = Object.values(rows).filter(row => row.expiresAt <= at
        && !['claimed', 'publishing', 'uncertain'].includes(row.status)).sort((a, b) => a.createdAt - b.createdAt);
      while (Object.keys(rows).length >= 128 && terminal.length) delete rows[terminal.shift().token];
      if (Object.keys(rows).length >= 128) throw fail('QZONE_REVIEW_CAPACITY');
      rows[token] = { token, key, accountId: ctx.accountId, logicalId: ctx.logicalId, qq: ctx.qq,
        scopeRevision: ctx.revision, recipientId, draftId: id, draftRevision: draft.revision,
        fingerprint: pin, status: 'claimed', createdAt: at, expiresAt: at + 30 * 60000 };
      return true;
    });
    if (!claim) return { status: 'blocked', code: 'QZONE_REVIEW_ALREADY_OFFERED' };
    const current = () => {
      try { guard(ctx); const row = book(read())?.[token]; return row?.status === 'claimed'
        && row.expiresAt > clock() && isOwner(ctx, recipientId) && fingerprint(getDraft(ctx, id)) === pin; }
      catch { return false; }
    };
    let receipt;
    try {
      if (!current()) throw fail('QZONE_REVIEW_STALE');
      receipt = await sendPreview(ctx, recipientId, structuredClone(draft), {
        token, current, instruction: `30分钟内回复 /bot qzone confirm ${token} 发布；回复 /bot qzone reject ${token} 放弃。`
      });
    } catch { receipt = { status: 'uncertain' }; }
    const confirmed = receipt?.status === 'confirmed' && /^-?[1-9]\d{0,19}$/.test(String(receipt.messageId || ''));
    await transact(root => {
      const row = book(root)?.[token];
      if (!row || row.status !== 'claimed') throw fail('QZONE_REVIEW_STATE');
      row.status = confirmed ? 'awaiting_owner' : 'uncertain'; row.previewAt = clock();
      if (confirmed) row.previewMessageId = String(receipt.messageId);
    });
    return { status: confirmed ? 'accepted' : 'uncertain', code: confirmed ? 'QZONE_REVIEW_SENT' : 'QZONE_REVIEW_DELIVERY_UNCERTAIN' };
  }
  async function handle(ctx, envelope, text) {
    const match = typeof text === 'string' && command.exec(text.trim());
    if (!match) return { matched: false };
    guard(ctx);
    if (envelope?.private !== true || envelope.verified !== true || !isOwner(ctx, envelope.userId))
      return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_OWNER_REQUIRED' };
    const token = match[2].toLowerCase(), row = book(read())?.[token], reject = /reject|拒绝/iu.test(match[1]);
    const valid = item => item && item.accountId === ctx.accountId && item.logicalId === ctx.logicalId && item.qq === ctx.qq
      && item.scopeRevision === ctx.revision && item.recipientId === envelope.userId
      && item.expiresAt > clock() && item.createdAt <= clock() && item.status === 'awaiting_owner'
      && fingerprint(getDraft(ctx, item.draftId)) === item.fingerprint;
    if (!valid(row)) return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_EXPIRED_OR_CHANGED' };
    await transact(root => {
      guard(ctx); const live = book(root)?.[token];
      if (!isOwner(ctx, envelope.userId) || !valid(live)) throw fail('QZONE_REVIEW_STALE');
      live.status = reject ? 'rejected' : 'publishing'; live.decidedAt = clock();
    });
    let result;
    try {
      guard(ctx);
      if (!isOwner(ctx, envelope.userId)) throw fail('QZONE_REVIEW_STALE');
      result = reject ? await cancel(ctx, structuredClone(row), envelope)
        : await publish(ctx, structuredClone(row), envelope);
    } catch { result = { status: 'uncertain', code: 'QZONE_REVIEW_EXECUTION_UNCERTAIN' }; }
    await transact(root => {
      const live = book(root)?.[token];
      if (!live || !['publishing', 'rejected'].includes(live.status)) throw fail('QZONE_REVIEW_STATE');
      live.status = reject ? 'rejected' : ['confirmed', 'accepted', 'failed', 'blocked', 'not_supported'].includes(result?.status)
        ? result.status : 'uncertain'; live.settledAt = clock();
    });
    return { matched: true, ...result };
  }
  return Object.freeze({ capture, offer, handle });
}
