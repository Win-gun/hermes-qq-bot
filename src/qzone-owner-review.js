import { createHash, randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const legacyFingerprint = draft => createHash('sha256').update(JSON.stringify({
  id: draft.id, revision: draft.revision, kind: draft.kind, source: draft.source, content: draft.content,
  images: draft.images || [], audience: draft.audience
})).digest('hex');
const fingerprint = draft => createHash('sha256').update(JSON.stringify({
  id: draft.id, revision: draft.revision, kind: draft.kind, source: draft.source, content: draft.content,
  images: draft.images || [], imageClaims: draft.imageClaims || [],
  confirmationHash: draft.confirmationHash || null, audience: draft.audience
})).digest('hex');
const matches = (row, draft) => row.fingerprintVersion === 2 ? fingerprint(draft) === row.fingerprint
  : row.fingerprintVersion === undefined && legacyFingerprint(draft) === row.fingerprint;
const claimPin = row => JSON.stringify([row.token, row.key, row.accountId, row.logicalId, row.qq,
  row.scopeRevision, row.controlRevision ?? row.scopeRevision, row.recipientId, row.draftId, row.draftRevision,
  row.fingerprint, row.fingerprintVersion ?? null, row.createdAt, row.expiresAt, row.previewMessageId]);
const command = /^\/bot\s+(?:qzone|空间)\s+(confirm|reject|确认|拒绝)\s+([a-f0-9]{32})\s*$/iu;
const decision = /^(发吧|不发了)[。！!]?$/u;
const messageId = value => typeof value === 'string' && /^-?[1-9]\d{0,19}$/.test(value);
const freeze = value => {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return Object.freeze(value);
};
// A UI/Agent consumer may be reconstructed without restarting the repository.
// Preserve uncertain attempts across those rebindings. The host must retain the
// same writer adapter function for one repository lifetime; durable records
// remain the authority after process restart. Weak keys do not retain writers.
const writerAttempts = new WeakMap();

// A QQ review is not model authority. The host authenticates the original
// carrier/private sender, resolves the exact draft and uses the existing QZone
// publish gate. The one memory writer owns claims; no timer or retry queue.
// Natural decisions require a HOST-authenticated original private event:
// {private:true, verified:true, userId, accountId, logicalId, actualQq,
//  controlRevision, messageId, replyMessageId}. Never derive replyMessageId from
// quoted prose/forwarded messages; use the protocol's reply segment. The scope
// revision must include socket, carrier and quiet/control revisions. For hosts
// with a separate controlRevision, capture and compare that too. sendPreview
// must check current() at the actual queued wire, use the exact body/ordered
// imageClaims and return only a real message receipt. Token commands remain
// compatible; tokens are not credentials and never override these host guards.
export function createQzoneOwnerReview({ read, transact, isCurrent, isOwner,
  getDraft, sendPreview, publish, cancel, clock = Date.now } = {}) {
  if ([read, transact, isCurrent, isOwner, getDraft, sendPreview, publish, cancel, clock]
    .some(fn => typeof fn !== 'function')) throw fail('QZONE_REVIEW_CONTRACT');
  if (!writerAttempts.has(transact)) writerAttempts.set(transact, { poisoned: new Set(), consumed: new Set() });
  const { poisoned, consumed } = writerAttempts.get(transact), issued = new WeakSet();
  const now = () => {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000 - 1800000) throw fail('QZONE_REVIEW_CLOCK');
    return at;
  };
  const guard = ctx => { if (!issued.has(ctx) || isCurrent(ctx) !== true) throw fail('QZONE_REVIEW_STALE'); };
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
    const ctx = freeze(structuredClone(scope)); issued.add(ctx); guard(ctx); return ctx;
  }
  async function offer(ctx, id, recipientId) {
    guard(ctx);
    if (!isOwner(ctx, recipientId)) throw fail('QZONE_REVIEW_OWNER_REQUIRED');
    const draft = structuredClone(getDraft(ctx, id));
    if (!draft || !['draft', 'review'].includes(draft.status)) throw fail('QZONE_REVIEW_DRAFT');
    const pin = fingerprint(draft), token = randomBytes(16).toString('hex'), at = now();
    const key = `${ctx.logicalId}:${ctx.qq}:${id}:${draft.revision}`;
    if (Object.values(book(read()) || {}).some(row => row.key === key))
      return { status: 'blocked', code: 'QZONE_REVIEW_ALREADY_OFFERED' };
    if (poisoned.has(key)) throw fail('QZONE_REVIEW_UNCERTAIN');
    if (poisoned.size >= 4096) throw fail('QZONE_REVIEW_CAPACITY');
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
        ...(ctx.controlRevision !== undefined ? { controlRevision: ctx.controlRevision } : {}),
        fingerprint: pin, fingerprintVersion: 2, status: 'claimed', createdAt: at, expiresAt: at + 30 * 60000 };
      return true;
    });
    if (!claim) return { status: 'blocked', code: 'QZONE_REVIEW_ALREADY_OFFERED' };
    const current = () => {
      try { guard(ctx); const row = book(read())?.[token]; return row?.status === 'claimed'
        && row.expiresAt > now() && row.createdAt <= now()
        && isOwner(ctx, recipientId) === true && fingerprint(getDraft(ctx, id)) === pin; }
      catch { return false; }
    };
    let receipt;
    try {
      if (!current()) throw fail('QZONE_REVIEW_STALE');
      receipt = await sendPreview(ctx, recipientId, structuredClone(draft), {
        token, current, instruction: '30分钟内引用本条预览回复“发吧”确认，或“不发了”放弃。',
        legacyInstruction: `30分钟内回复 /bot qzone confirm ${token} 发布；回复 /bot qzone reject ${token} 放弃。`
      });
    } catch { receipt = { status: 'uncertain' }; }
    const confirmed = receipt?.status === 'confirmed' && messageId(String(receipt.messageId || ''));
    await transact(root => {
      const row = book(root)?.[token];
      if (!row || row.status !== 'claimed') throw fail('QZONE_REVIEW_STATE');
      row.status = confirmed && current() ? 'awaiting_owner' : 'uncertain'; row.previewAt = now();
      if (confirmed) row.previewMessageId = String(receipt.messageId);
    });
    const awaiting = book(read())?.[token]?.status === 'awaiting_owner';
    return { status: awaiting ? 'accepted' : 'uncertain', code: awaiting ? 'QZONE_REVIEW_SENT' : 'QZONE_REVIEW_DELIVERY_UNCERTAIN' };
  }
  async function handle(ctx, envelope, text) {
    const match = typeof text === 'string' && command.exec(text.trim());
    const natural = typeof text === 'string' && decision.exec(text.trim());
    if (!match && !(natural && envelope?.replyMessageId !== undefined)) return { matched: false };
    guard(ctx);
    envelope = freeze(structuredClone(envelope || {}));
    if (envelope?.private !== true || envelope.verified !== true || isOwner(ctx, envelope.userId) !== true)
      return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_OWNER_REQUIRED' };
    // Legacy hosts bind the carrier in isCurrent(ctx). New natural events must
    // also carry the receiving account/actual QQ/control revision explicitly.
    const expected = { accountId: ctx.accountId, logicalId: ctx.logicalId, actualQq: ctx.qq,
      controlRevision: ctx.controlRevision ?? ctx.revision };
    if (Object.entries(expected).some(([key, value]) => (!match || envelope[key] !== undefined) && envelope[key] !== value)
      || !match && (!messageId(envelope.replyMessageId) || !messageId(envelope.messageId)))
      return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_EVENT_SCOPE' };
    const rows = book(read()) || {};
    const references = match ? [] : Object.values(rows).filter(item => item.previewMessageId === envelope.replyMessageId
      && item.accountId === ctx.accountId && item.logicalId === ctx.logicalId && item.qq === ctx.qq
      && item.recipientId === envelope.userId);
    const token = match ? match[2].toLowerCase() : references.length === 1 ? references[0].token : '';
    const row = rows[token] && structuredClone(rows[token]);
    const reject = match ? /reject|拒绝/iu.test(match[1]) : natural[1] === '不发了';
    const valid = item => item && item.accountId === ctx.accountId && item.logicalId === ctx.logicalId && item.qq === ctx.qq
      && item.token === token && claimPin(item) === claimPin(row)
      && item.scopeRevision === ctx.revision && item.recipientId === envelope.userId
      && (item.controlRevision ?? item.scopeRevision) === (ctx.controlRevision ?? ctx.revision)
      && item.expiresAt > now() && item.createdAt <= now() && item.status === 'awaiting_owner'
      && (match || item.previewMessageId === envelope.replyMessageId)
      && (() => {
        const draft = getDraft(ctx, item.draftId);
        return draft && ['draft', 'review'].includes(draft.status) && draft.revision === item.draftRevision
          && matches(item, draft);
      })();
    if (!valid(row)) return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_EXPIRED_OR_CHANGED' };
    // A claim/settlement timeout may hide a durable write. Do not consume this
    // preview again in the current instance even if the caller rebinds contexts.
    if (consumed.has(token)) return { matched: true, status: 'blocked', code: 'QZONE_REVIEW_ALREADY_CONSUMED' };
    if (consumed.size >= 4096) throw fail('QZONE_REVIEW_CAPACITY');
    consumed.add(token);
    await transact(root => {
      guard(ctx); const live = book(root)?.[token];
      if (isOwner(ctx, envelope.userId) !== true || !valid(live)) throw fail('QZONE_REVIEW_STALE');
      live.status = reject ? 'rejected' : 'publishing'; live.decidedAt = now();
      if (!match) live.decisionMessageId = envelope.messageId;
    });
    let result;
    // Parent adapters must carry this through their authenticated actor registry
    // and check it in isOwnerReviewActor at approve AND final queued wire. Pin
    // the reviewed content while allowing only runtime-owned revision changes.
    const current = candidate => {
      try {
        guard(ctx);
        const live = book(read())?.[token], draft = getDraft(ctx, row.draftId);
        return isOwner(ctx, envelope.userId) === true && live?.status === (reject ? 'rejected' : 'publishing')
          && claimPin(live) === claimPin(row) && live.scopeRevision === ctx.revision
          && live.expiresAt > now() && live.createdAt <= now() && !!draft
          && !draft.cancelRequested && ['draft', 'review', 'approved', 'publishing'].includes(draft.status)
          && (!candidate || candidate.revision === draft.revision
            && matches(row, { ...candidate, revision: row.draftRevision }))
          && matches(row, { ...draft, revision: row.draftRevision });
      } catch { return false; }
    };
    try {
      guard(ctx);
      if (isOwner(ctx, envelope.userId) !== true || row.expiresAt <= now()
        || !current()) throw fail('QZONE_REVIEW_STALE');
      result = reject ? await cancel(ctx, structuredClone(row), envelope, { current })
        : await publish(ctx, structuredClone(row), envelope, { current });
    } catch { result = { status: 'uncertain', code: 'QZONE_REVIEW_EXECUTION_UNCERTAIN' }; }
    await transact(root => {
      const live = book(root)?.[token];
      if (!live || !['publishing', 'rejected'].includes(live.status)) throw fail('QZONE_REVIEW_STATE');
      live.status = reject ? 'rejected' : ['confirmed', 'accepted', 'failed', 'blocked', 'not_supported'].includes(result?.status)
        ? result.status : 'uncertain'; live.settledAt = now();
    });
    return { matched: true, ...result };
  }
  return Object.freeze({ capture, offer, handle });
}
