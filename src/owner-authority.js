import { createHash } from 'node:crypto';
import { redactText } from './privacy-filter.js';

const qq = v => typeof v === 'string' && /^[1-9]\d{4,19}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const logical = v => typeof v === 'string' && /^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const plain = v => v && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && !Array.isArray(v);
const keys = (v, allowed) => plain(v) && Reflect.ownKeys(v).every(k => typeof k === 'string' && allowed.includes(k)
  && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const safeText = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000
  && !/\[\s*CQ\s*:|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/iu.test(v) && redactText(v) === v;
const outcomes = new Set(['confirmed', 'accepted', 'failed', 'uncertain', 'blocked', 'not_supported']);
const writes = new Set(['send_text', 'send_sticker', 'quiet', 'resume', 'notifications', 'autonomy', 'restrict_poke', 'revoke_directive']);
const confirmedChanges = new Set(['notifications', 'autonomy', 'restrict_poke', 'revoke_directive']);
const fail = code => Object.assign(new Error(code), { code });

/** Only host-constructed JSON reaches execution; there is deliberately no OneBot action parameter. */
export function validateOwnerIntent(v) {
  if (!keys(v, ['action', 'accountId', 'groupId', 'text', 'query', 'days', 'userId', 'minutes', 'times', 'timezone', 'enabled', 'commandId', 'directiveId'])) throw fail('OWNER_INTENT_INVALID');
  if (['status', 'blockers', 'tasks', 'history'].includes(v.action) && Object.keys(v).length === 1) return { action: v.action };
  if (v.action === 'tokens' && keys(v, ['action', 'days']) && [1, 7].includes(v.days)) return { action: v.action, days: v.days };
  if (v.action === 'people' && keys(v, ['action', 'accountId', 'userId']) && id(v.accountId) && qq(v.userId)) return { ...v };
  if (v.action === 'confirm' && keys(v, ['action', 'commandId']) && /^[a-f0-9]{32}$/.test(v.commandId)) return { ...v };
  if (['send_text', 'send_sticker'].includes(v.action) && keys(v, ['action', 'accountId', 'groupId', v.action === 'send_text' ? 'text' : 'query'])
    && id(v.accountId) && qq(v.groupId) && safeText(v[v.action === 'send_text' ? 'text' : 'query'])) return { ...v };
  if (['quiet', 'resume'].includes(v.action) && keys(v, ['action', 'accountId', 'groupId', 'minutes']) && id(v.accountId) && qq(v.groupId)
    && (v.action === 'resume' ? v.minutes === undefined : Number.isSafeInteger(v.minutes) && v.minutes >= 1 && v.minutes <= 10080)) return { ...v };
  if (v.action === 'autonomy' && keys(v, ['action', 'accountId', 'enabled']) && id(v.accountId) && typeof v.enabled === 'boolean') return { ...v };
  if (v.action === 'notifications' && keys(v, ['action', 'enabled', 'times', 'timezone']) && typeof v.enabled === 'boolean'
    && Array.isArray(v.times) && v.times.length >= 1 && v.times.length <= 2 && new Set(v.times).size === v.times.length
    && v.times.every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) && typeof v.timezone === 'string' && v.timezone.length <= 64) {
    try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { throw fail('OWNER_INTENT_INVALID'); }
    return { ...v, times: [...v.times].sort() };
  }
  if (v.action === 'restrict_poke' && keys(v, ['action', 'accountId', 'groupId', 'userId']) && id(v.accountId) && qq(v.groupId) && qq(v.userId)) return { ...v };
  if (v.action === 'revoke_directive' && keys(v, ['action', 'directiveId']) && /^[a-f0-9]{32}$/.test(v.directiveId)) return { ...v };
  throw fail('OWNER_INTENT_INVALID');
}

export function parseOwnerCommand(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const s = text.trim();
  if (/^(?:今日(?:的)?Token|今日用量|今天用了多少token|今日 Token)$/iu.test(s)) return { action: 'tokens', days: 1 };
  if (/^(?:最近七天Token|最近7天Token|最近七天用量)$/iu.test(s)) return { action: 'tokens', days: 7 };
  if (/^(?:当前账号状态|查询运行状态)$/u.test(s)) return { action: 'status' };
  if (/^(?:今日主要阻碍|今日阻碍|查询今日阻碍)$/u.test(s)) return { action: 'blockers' };
  if (/^(?:查询未完成任务|未完成的任务和命令)$/u.test(s)) return { action: 'tasks' };
  const m = /^\/owner\s+(status|blockers|tasks|history|tokens|people|send|sticker|quiet|resume|notifications|autonomy|no-poke|revoke|confirm)(?:\s+([\s\S]+))?$/iu.exec(s);
  if (!m) return null;
  const action = m[1].toLowerCase(), body = m[2] || '', parts = body.split(/\s+/u);
  let value;
  if (['status', 'blockers', 'tasks', 'history'].includes(action) && !body) value = { action };
  if (action === 'tokens' && /^(?:1|7|1d|7d)?$/.test(body)) value = { action, days: body.startsWith('7') ? 7 : 1 };
  if (action === 'people' && parts.length === 2) value = { action, accountId: parts[0], userId: parts[1] };
  if (action === 'confirm') value = { action, commandId: body };
  if (action === 'revoke') value = { action: 'revoke_directive', directiveId: body };
  if (['send', 'sticker'].includes(action)) {
    const args = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(body);
    if (args) value = { action: action === 'send' ? 'send_text' : 'send_sticker', accountId: args[1], groupId: args[2], [action === 'send' ? 'text' : 'query']: args[3] };
  }
  if (action === 'quiet' && parts.length === 3) value = { action, accountId: parts[0], groupId: parts[1], minutes: Number(parts[2]) };
  if (action === 'resume' && parts.length === 2) value = { action, accountId: parts[0], groupId: parts[1] };
  if (action === 'autonomy' && parts.length === 2 && ['on', 'off'].includes(parts[1])) value = { action, accountId: parts[0], enabled: parts[1] === 'on' };
  if (action === 'notifications' && parts.length === 3 && ['on', 'off'].includes(parts[0])) value = { action, enabled: parts[0] === 'on', times: parts[1].split(','), timezone: parts[2] };
  if (action === 'no-poke' && parts.length === 3) value = { action: 'restrict_poke', accountId: parts[0], groupId: parts[1], userId: parts[2] };
  if (!value) return null;
  try { return validateOwnerIntent(value); } catch { return null; }
}

function store(root, write = false) {
  if (root.ownerAuthority === undefined) {
    if (!write) return { version: 1, revision: 0, commands: {}, directives: {} };
    root.ownerAuthority = { version: 1, revision: 0, commands: {}, directives: {} };
  }
  const s = root.ownerAuthority;
  if (!plain(s) || s.version !== 1 || !Number.isSafeInteger(s.revision) || !plain(s.commands) || !plain(s.directives)) throw fail('OWNER_STORE_INVALID');
  return s;
}

export function ownerOperationHistory(root, { ownerUserId, logicalBotId, accountId, from, to, limit = 40, now = Date.now() } = {}) {
  return Object.values(store(root).commands).filter(x => (!ownerUserId || x.ownerUserId === ownerUserId) && (!logicalBotId || x.logicalBotId === logicalBotId)
    && (!accountId || x.accountId === accountId) && (from === undefined || x.createdAt >= from) && (to === undefined || x.createdAt < to))
    .sort((a,b) => b.createdAt - a.createdAt).slice(0, Math.min(100, limit)).map(x => ({ id: x.id, action: x.action, accountId: x.accountId,
      status: x.status === 'claimed' ? 'uncertain' : x.status === 'awaiting_confirmation' && x.expiresAt <= now ? 'blocked' : x.status,
      createdAt: x.createdAt, completedAt: x.completedAt || null,
      code: x.status === 'awaiting_confirmation' && x.expiresAt <= now ? 'OWNER_APPROVAL_EXPIRED' : x.code || '', resultId: x.resultId || null }));
}

export function putOwnerDirective(root, { actorUserId, logicalBotId, accountId, groupId, userId, messageId, authorized, now }) {
  if (authorized !== true || !qq(actorUserId) || !logical(logicalBotId) || !id(accountId) || !qq(groupId) || !qq(userId)
    || typeof messageId !== 'string' || !messageId || !Number.isSafeInteger(now)) return { ok: false, code: 'OWNER_DIRECTIVE_BLOCKED' };
  const s = store(root, true), key = hash([logicalBotId, groupId, userId, 'poke']).slice(0, 32);
  if (!s.directives[key] && Object.keys(s.directives).length >= 1000) return { ok: false, code: 'OWNER_CAPACITY' };
  s.directives[key] = { id: key, logicalBotId, accountId, groupId, userId, action: 'poke', state: 'active', actorUserId, messageId, createdAt: now, revision: ++s.revision };
  return { ok: true, id: key, revision: s.revision };
}

export function ownerDirectiveAllows(root, { logicalBotId, groupId, userId, action }) {
  if (action !== 'group_poke') return true;
  return !Object.values(store(root).directives).some(x => x.logicalBotId === logicalBotId && x.groupId === String(groupId)
    && x.userId === String(userId) && x.action === 'poke' && x.state === 'active');
}

/** No tool authority is inferred from parser/model output. The host authenticates a verified Carrier envelope. */
export function createOwnerCommandRouter({ read, transact, isOwner, capture, isCurrent, authorize, execute, query, parseIntent, now = Date.now }) {
  const inFlight = new Set();
  return { async handle(envelope, text) {
    if (!envelope || envelope.private !== true || envelope.verified !== true || !qq(envelope.ownerUserId) || !id(envelope.accountId)
      || !logical(envelope.logicalBotId) || !/^[-A-Za-z0-9_:]{1,128}$/.test(envelope.messageId || '') || !isOwner(envelope))
      return { matched: /^\/owner\b/iu.test(String(text)), status: 'blocked', code: 'OWNER_IDENTITY_REQUIRED' };
    const source = capture(envelope);
    let intent = parseOwnerCommand(text), modelParsed = false;
    if (!intent && parseIntent) {
      try { const v = await parseIntent(text, envelope); if (v && Object.keys(v).length) {
        intent = validateOwnerIntent(v); if (intent.action === 'confirm') throw fail('OWNER_PARSE_REJECTED'); modelParsed = true;
      } } catch { return { matched: true, status: 'blocked', code: 'OWNER_PARSE_REJECTED' }; }
    }
    if (!intent) return { matched: /^\/owner\b/iu.test(String(text)), status: 'not_supported', code: 'OWNER_COMMAND_UNKNOWN' };
    if (!isCurrent(source) || !isOwner(envelope)) return { matched: true, status: 'blocked', code: 'OWNER_STALE_SOURCE' };
    if (!writes.has(intent.action) && intent.action !== 'confirm') {
      if (!authorize(envelope, intent)) return { matched: true, status: 'blocked', code: 'OWNER_QUERY_BLOCKED' };
      return { matched: true, status: 'confirmed', action: intent.action, data: await query(intent, envelope) };
    }
    let approval;
    if (intent.action === 'confirm') {
      const savedApproval = store(read()).commands[intent.commandId];
      approval = savedApproval && structuredClone(savedApproval);
      if (!approval || approval.ownerUserId !== envelope.ownerUserId || approval.logicalBotId !== envelope.logicalBotId
        || approval.sourceRevision !== source.revision || approval.sourceFingerprint !== hash(source)
        || approval.status !== 'awaiting_confirmation' || approval.expiresAt <= now())
        return { matched: true, status: 'blocked', code: 'OWNER_APPROVAL_STALE' };
      intent = validateOwnerIntent(approval.intent);
    }
    if (!authorize(envelope, intent)) return { matched: true, status: 'blocked', code: 'OWNER_SCOPE_REQUIRED' };
    const key = approval?.id || hash([envelope.logicalBotId, envelope.ownerUserId, envelope.messageId]).slice(0,32);
    if (inFlight.has(key)) return { matched: true, status: 'uncertain', code: 'OWNER_ALREADY_CLAIMED', id: key };
    inFlight.add(key);
    try {
      const claimed = await transact(root => {
        if (!isCurrent(source) || !isOwner(envelope) || !authorize(envelope, intent)) return { ok:false, code:'OWNER_STALE_SOURCE' };
        const s = store(root, true), previous = s.commands[key];
        if (previous && (!approval || previous.status !== 'awaiting_confirmation')) return { ok: false, code: 'OWNER_ALREADY_CLAIMED' };
        if (approval && (!previous || previous.expiresAt <= now() || previous.ownerUserId !== envelope.ownerUserId
          || previous.logicalBotId !== envelope.logicalBotId || previous.sourceFingerprint !== hash(source)
          || previous.argumentHash !== hash(intent))) return { ok:false, code:'OWNER_APPROVAL_STALE' };
        if (Object.keys(s.commands).length >= 2000 && !previous) return { ok: false, code: 'OWNER_CAPACITY' };
        const confirmation = !approval && (confirmedChanges.has(intent.action) || modelParsed);
        s.commands[key] = { id:key, ownerUserId:envelope.ownerUserId, logicalBotId:envelope.logicalBotId, accountId:intent.accountId || envelope.accountId,
          action:intent.action, sourceMessageId:envelope.messageId, sourceRevision:source.revision, sourceFingerprint:hash(source), argumentHash:hash(intent),
          status:confirmation?'awaiting_confirmation':'claimed', createdAt:now(), expiresAt:approval?previous.expiresAt:now()+120000,
          // Only allowlisted bounded arguments. History APIs never return this
          // private pending proposal; CQ, credentials and unsafe text are refused.
          ...(confirmation ? { intent: structuredClone(intent) } : {}) };
        s.revision++; return { ok:true, confirmation };
      });
      if (!claimed.ok) return { matched:true, status:claimed.code==='OWNER_ALREADY_CLAIMED'?'uncertain':'blocked', code:claimed.code, id:key };
      if (claimed.confirmation) return { matched:true, status:'accepted', code:'OWNER_CONFIRM_REQUIRED', id:key, change:intent };
      let result;
      const guard = () => isCurrent(source) && isOwner(envelope) && authorize(envelope,intent)
        && store(read()).commands[key]?.status === 'claimed' && store(read()).commands[key]?.expiresAt > now();
      if (!guard()) result = { status:'blocked', code:'OWNER_STALE_SOURCE' };
      else try { result = await execute(intent, { envelope, source, guard, commandId:key }); }
      catch(e) { result = { status:e?.code==='ACCOUNT_SEND_BLOCKED'?'blocked':e?.oneBotRejected?'failed':'uncertain',
        code:e?.code==='ACCOUNT_SEND_BLOCKED'?'OWNER_DELIVERY_BLOCKED':e?.oneBotRejected?'OWNER_WIRE_REJECTED':'OWNER_EXECUTION_UNCONFIRMED' }; }
      if (!outcomes.has(result?.status)) result = { status:'uncertain', code:'OWNER_RECEIPT_MISSING' };
      const receipt = { status:result.status, code:/^[A-Z][A-Z0-9_]{0,80}$/.test(result.code||'')?result.code:'OWNER_RESULT',
        resultId:typeof result.resultId==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.resultId)?result.resultId:null };
      await transact(root => { const s=store(root,true), row=s.commands[key]; if(row?.status!=='claimed')throw fail('OWNER_CLAIM_LOST');
        Object.assign(row,receipt,{completedAt:now()});s.revision++; });
      return { matched:true, id:key, ...receipt };
    } finally { inFlight.delete(key); }
  } };
}

export function revokeOwnerDirective(root, { directiveId, actorUserId, authorized, expectedRevision, now }) {
  const s=store(root);if(authorized!==true||!qq(actorUserId)||s.revision!==expectedRevision||!s.directives[directiveId]) return {ok:false,code:'OWNER_DIRECTIVE_CONFLICT'};
  const target=store(root,true);target.directives[directiveId]={...target.directives[directiveId],state:'revoked',revokedAt:now,revokedBy:actorUserId,revision:++target.revision};
  return {ok:true,revision:target.revision};
}
