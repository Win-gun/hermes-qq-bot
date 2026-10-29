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
/** Bounded owner-facing label (address preference). No CQ codes, no newlines, no secrets. */
const safeLabel = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 80
  && !/\[\s*CQ\s*:|[\u0000-\u001f\u007f]/u.test(v) && !/^[/\\]|^(?:sk-|bearer|password|secret)/iu.test(v)
  && redactText(v) === v;
const outcomes = new Set(['confirmed', 'accepted', 'failed', 'uncertain', 'blocked', 'not_supported']);
/** The only directive kinds a natural revocation phrase may name. */
const REVOKE_SELECTOR_KINDS = Object.freeze(['address', 'group_participation', 'poke']);
const writes = new Set(['send_text', 'send_sticker', 'quiet', 'resume', 'notifications', 'autonomy', 'restrict_poke',
  'revoke_directive', 'set_address', 'reduce_participation']);
const confirmedChanges = new Set(['notifications', 'autonomy', 'restrict_poke', 'revoke_directive',
  'set_address', 'reduce_participation']);
/**
 * The actions `ownerControl.lowRiskDirect` may run without a second explicit
 * confirmation. All of them stay strictly bounded by the authenticated owner
 * identity, the actual allowed-pair/scope intersection, the durable claim, the
 * revision gate and the one-shot rule. `set_address` / `reduce_participation`
 * are additionally allowlisted preferences written to the existing directive
 * store, so a clear low-risk preference never requires copying an approval id.
 * The MODEL path still cannot synthesize either of them (`modelActions`).
 */
export const LOW_RISK_DIRECT_ACTIONS = Object.freeze(['send_text', 'send_sticker', 'quiet', 'resume', 'notifications',
  'autonomy', 'restrict_poke', 'revoke_directive', 'set_address', 'reduce_participation']);
export const isLowRiskDirectAction = action => typeof action === 'string' && LOW_RISK_DIRECT_ACTIONS.includes(action);
/** Strict allowlist for durable owner directives. Anything else is not a store kind. */
export const OWNER_DIRECTIVE_ACTIONS = Object.freeze(['poke', 'address', 'group_participation']);
const queries = new Set(['status', 'blockers', 'tasks', 'history', 'activity', 'why']);
/** The model candidate path may ONLY express these bounded actions. It can never
 * invent an actor, a permission, a target grant or a persistent preference. */
const modelActions = new Set(['tokens', 'send_text', 'send_sticker', 'quiet', 'resume', 'notifications', 'autonomy',
  'restrict_poke', 'revoke_directive']);
const queryFields = ['action', 'days', 'accountId'];
const fail = code => Object.assign(new Error(code), { code });

/** Only host-constructed JSON reaches execution; there is deliberately no OneBot action parameter. */
export function validateOwnerIntent(v) {
  if (!keys(v, ['action', 'accountId', 'groupId', 'text', 'query', 'days', 'userId', 'minutes', 'times', 'timezone', 'enabled', 'commandId', 'directiveId', 'avoid'])) throw fail('OWNER_INTENT_INVALID');
  if (queries.has(v.action)) {
    if (!keys(v, queryFields)) throw fail('OWNER_INTENT_INVALID');
    if (v.accountId !== undefined && !id(v.accountId)) throw fail('OWNER_INTENT_INVALID');
    if (v.days !== undefined && (![1, 7].includes(v.days) || v.action !== 'activity')) throw fail('OWNER_INTENT_INVALID');
    const out = { action: v.action };
    if (v.days !== undefined) out.days = v.days;
    if (v.accountId !== undefined) out.accountId = v.accountId;
    return out;
  }
  if (v.action === 'tokens' && [['action', 'days'], ['action', 'days', 'accountId']].some(f => keys(v, f)) && [1, 7].includes(v.days)
    && (v.accountId === undefined || id(v.accountId))) return v.accountId === undefined ? { action: v.action, days: v.days } : { ...v };
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
  // A natural revocation is still exactly the same bounded action; the host resolves
  // `selector` to ONE active owned directive and then re-executes the exact-id path.
  if (v.action === 'revoke_directive' && keys(v, ['action', 'selector']) && plain(v.selector)
    && REVOKE_SELECTOR_KINDS.includes(v.selector.kind) && keys(v.selector, ['kind', 'accountId', 'groupId', 'userId'])) {
    const sel = { kind: v.selector.kind };
    if (sel.kind === 'address') return { action: 'revoke_directive', selector: sel };
    if (!id(v.selector.accountId) || !qq(v.selector.groupId)) throw fail('OWNER_INTENT_INVALID');
    sel.accountId = v.selector.accountId; sel.groupId = v.selector.groupId;
    if (sel.kind === 'poke') { if (!qq(v.selector.userId)) throw fail('OWNER_INTENT_INVALID'); sel.userId = v.selector.userId; }
    return { action: 'revoke_directive', selector: sel };
  }
  // Persistent, bounded owner preferences. Never a permission or target grant.
  if (v.action === 'set_address' && keys(v, ['action', 'text', 'avoid']) && (v.avoid === undefined || typeof v.avoid === 'boolean')
    && safeLabel(v.text)) return v.avoid === true ? { action: 'set_address', text: v.text.trim(), avoid: true } : { action: 'set_address', text: v.text.trim() };
  if (v.action === 'reduce_participation' && keys(v, ['action', 'accountId', 'groupId']) && id(v.accountId) && qq(v.groupId)) return { ...v };
  throw fail('OWNER_INTENT_INVALID');
}

const QUERY_PHRASES = [
  [/^(?:今日|今天)(?:的)?(?:token|Token|用量|消耗|调用|调用量)$/u, { action: 'tokens', days: 1 }],
  [/^(?:最近七天|最近7天|近七天)(?:的)?(?:token|Token|用量|消耗)$/u, { action: 'tokens', days: 7 }],
  [/^(?:查询|查一下|查下)?(?:今日|今天|当前)(?:的)?(?:主要)?(?:阻碍|故障|问题|阻碍项|报错)$/u, { action: 'blockers' }],
  [/^(?:当前账号状态|查询运行状态|运行状态|账号状态)$/u, { action: 'status' }],
  [/^(?:查询|查一下|查下)?(?:未完成的任务和命令|未完成任务|当前任务|任务状态|任务列表)$/u, { action: 'tasks' }],
  [/^(?:查询|查一下|查下)?(?:操作历史|最近操作|命令历史|历史记录|历史)$/u, { action: 'history' }],
  [/^(?:查询|查一下|查下)?(?:今日活跃|今天活跃|活跃|互动统计|收发统计|今日互动)$/u, { action: 'activity', days: 1 }],
  [/^(?:最近七天活跃|最近7天活跃|七天活跃)$/u, { action: 'activity', days: 7 }],
  [/^(?:为什么|为啥|为什么没回复|为什么没回|为什么不动|为什么没发|咋回事)$/u, { action: 'why' }],
];

/** Deterministic text → intent. Anchored on purpose: ordinary chat must stay unmatched. */
export function parseOwnerCommand(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const s = text.trim();
  for (const [pattern, value] of QUERY_PHRASES) if (pattern.test(s)) return { ...value };
  const m = /^\/owner\s+(status|blockers|tasks|history|tokens|people|send|sticker|quiet|resume|notifications|autonomy|no-poke|revoke|confirm|activity|why|address|reduce)(?:\s+([\s\S]+))?$/iu.exec(s);
  if (!m) return null;
  const action = m[1].toLowerCase(), body = m[2] || '', parts = body.split(/\s+/u);
  let value;
  if (['status', 'blockers', 'tasks', 'history', 'activity', 'why'].includes(action) && !body) value = { action };
  if (['status', 'blockers', 'tasks', 'history', 'activity', 'why'].includes(action) && parts.length === 1 && id(parts[0]))
    value = { action, accountId: parts[0] };
  if (action === 'activity' && (parts.length === 1 || parts.length === 2) && /^(?:1|7|1d|7d)$/.test(parts[0])) {
    const days = parts[0].startsWith('7') ? 7 : 1;
    value = parts.length === 2 && id(parts[1]) ? { action, days, accountId: parts[1] } : { action, days };
  }
  if (action === 'tokens' && /^(?:1|7|1d|7d)?$/.test(body)) value = { action, days: body.startsWith('7') ? 7 : 1 };
  if (action === 'people' && parts.length === 2) value = { action, accountId: parts[0], userId: parts[1] };
  if (action === 'confirm') value = { action, commandId: body };
  if (action === 'revoke') value = { action: 'revoke_directive', directiveId: body };
  if (action === 'address' && safeLabel(body)) value = { action: 'set_address', text: body.trim() };
  if (action === 'reduce' && parts.length === 2) value = { action: 'reduce_participation', accountId: parts[0], groupId: parts[1] };
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
/** Read-only directive view. A damaged store is never repaired by a reader. */
function directives(root) {
  try { return Object.values(store(root).directives).filter(x => plain(x) && OWNER_DIRECTIVE_ACTIONS.includes(x.action)); }
  catch { return []; }
}

export function ownerOperationHistory(root, { ownerUserId, logicalBotId, accountId, from, to, limit = 40, now = Date.now() } = {}) {
  return Object.values(store(root).commands).filter(x => (!ownerUserId || x.ownerUserId === ownerUserId) && (!logicalBotId || x.logicalBotId === logicalBotId)
    && (!accountId || x.accountId === accountId) && (from === undefined || x.createdAt >= from) && (to === undefined || x.createdAt < to))
    .sort((a,b) => b.createdAt - a.createdAt).slice(0, Math.min(100, limit)).map(x => ({ id: x.id, action: x.action, accountId: x.accountId,
      status: x.status === 'claimed' ? 'uncertain' : x.status === 'awaiting_confirmation' && x.expiresAt <= now ? 'blocked' : x.status,
      createdAt: x.createdAt, completedAt: x.completedAt || null,
      code: x.status === 'awaiting_confirmation' && x.expiresAt <= now ? 'OWNER_APPROVAL_EXPIRED' : x.code || '', resultId: x.resultId || null }));
}

/** Durable owner directive. `action` is allowlisted; the row is the only store. */
export function putOwnerDirective(root, { actorUserId, logicalBotId, accountId, groupId, userId, messageId, address,
  action = 'poke', authorized, avoid = false, now }) {
  if (authorized !== true || !qq(actorUserId) || !logical(logicalBotId) || !id(accountId) || !OWNER_DIRECTIVE_ACTIONS.includes(action)
    || typeof messageId !== 'string' || !messageId || !Number.isSafeInteger(now)) return { ok: false, code: 'OWNER_DIRECTIVE_BLOCKED' };
  let key, row;
  if (action === 'poke') {
    if (!qq(groupId) || !qq(userId)) return { ok: false, code: 'OWNER_DIRECTIVE_BLOCKED' };
    key = hash([logicalBotId, groupId, userId, 'poke']).slice(0, 32);
    row = { logicalBotId, accountId, groupId, userId, action };
  } else if (action === 'group_participation') {
    if (!qq(groupId)) return { ok: false, code: 'OWNER_DIRECTIVE_BLOCKED' };
    key = hash([logicalBotId, groupId, 'group_participation']).slice(0, 32);
    row = { logicalBotId, accountId, groupId, action, level: 'reduced' };
  } else {
    if (!safeLabel(address)) return { ok: false, code: 'OWNER_DIRECTIVE_BLOCKED' };
    // A negative preference ("我不喜欢你总是称呼我主人") is stored as its OWN bounded
    // row (`mode:'avoid'`), so it never silently overwrites the positive preference
    // and each one stays individually readable/revocable.
    if (avoid === true) {
      key = hash([logicalBotId, 'address', 'avoid']).slice(0, 32);
      row = { logicalBotId, accountId, action, address: address.trim(), mode: 'avoid' };
    } else {
      key = hash([logicalBotId, 'address']).slice(0, 32);
      row = { logicalBotId, accountId, action, address: address.trim(), mode: 'use' };
    }
  }
  const s = store(root, true);
  if (!s.directives[key] && Object.keys(s.directives).length >= 1000) return { ok: false, code: 'OWNER_CAPACITY' };
  s.directives[key] = { id: key, ...row, state: 'active', actorUserId, messageId, createdAt: now, revision: ++s.revision };
  return { ok: true, id: key, action, revision: s.revision };
}

/**
 * Read-only lookup of ACTIVE directives owned by exactly one logical identity. It exists
 * only so a clear natural revocation phrase can be resolved to an exact directive id;
 * it is never a fuzzy/pattern delete, and every caller must still pass the resulting id
 * through `revokeOwnerDirective` (revision check + tombstone) and the router's claim.
 */
export function ownerActiveDirectives(root, { logicalBotId, action, accountId, groupId, userId } = {}) {
  if (!logical(logicalBotId) || !OWNER_DIRECTIVE_ACTIONS.includes(action)) return [];
  return directives(root).filter(x => x.logicalBotId === logicalBotId && x.action === action && x.state === 'active'
    && (accountId === undefined || x.accountId === accountId)
    && (groupId === undefined || x.groupId === String(groupId))
    && (userId === undefined || x.userId === String(userId)))
    .map(x => ownerDirectiveById(root, { directiveId: x.id })).filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
}

export function ownerDirectiveById(root, { directiveId } = {}) {
  const row = typeof directiveId === 'string' ? directives(root).find(x => x.id === directiveId) : undefined;
  if (!row) return null;
  return { id: row.id, action: row.action, accountId: row.accountId, groupId: row.groupId || null, userId: row.userId || null,
    state: row.state === 'revoked' ? 'revoked' : 'active', createdAt: row.createdAt,
    ...(row.action === 'address' ? { address: row.address, mode: row.mode === 'avoid' ? 'avoid' : 'use' } : {}) };
}

/** Active owner address preference for one logical identity. No nickname/portrait inference. */
export function ownerAddressFor(root, { logicalBotId } = {}) {
  if (!logical(logicalBotId)) return null;
  const row = directives(root).filter(x => x.logicalBotId === logicalBotId && x.action === 'address' && x.state === 'active'
    && safeLabel(x.address) && x.mode !== 'avoid').sort((a, b) => b.createdAt - a.createdAt || b.revision - a.revision)[0];
  return row ? row.address : null;
}

/** Address labels the owner explicitly asked this logical identity NOT to use. */
export function ownerAddressAvoided(root, { logicalBotId } = {}) {
  if (!logical(logicalBotId)) return [];
  const rows = directives(root).filter(x => x.logicalBotId === logicalBotId && x.action === 'address' && x.state === 'active'
    && x.mode === 'avoid' && safeLabel(x.address));
  return [...new Set(rows.map(x => x.address))].slice(0, 16);
}

/** True when the owner asked this logical identity to reduce participation in that group. */
export function ownerGroupParticipationReduced(root, { logicalBotId, groupId } = {}) {
  if (!logical(logicalBotId) || !qq(String(groupId))) return false;
  return directives(root).some(x => x.logicalBotId === logicalBotId && x.groupId === String(groupId)
    && x.action === 'group_participation' && x.state === 'active');
}

export function ownerDirectiveAllows(root, { logicalBotId, groupId, userId, action }) {
  if (action === 'group_participation') return !ownerGroupParticipationReduced(root, { logicalBotId, groupId });
  if (action !== 'group_poke') return true;
  return !directives(root).some(x => x.logicalBotId === logicalBotId && x.groupId === String(groupId)
    && x.userId === String(userId) && x.action === 'poke' && x.state === 'active');
}

/**
 * No tool authority is inferred from parser/model output. The host authenticates a
 * verified Carrier envelope. `allowDirect` may skip ONLY the second confirmation for
 * strictly bounded low-risk writes; claim, revision, guard and one-shot semantics stay.
 */
export function createOwnerCommandRouter({ read, transact, isOwner, capture, isCurrent, authorize, execute, query,
  parseIntent, parseUtterance, isLikelyCommand, allowDirect, now = Date.now }) {
  const inFlight = new Set();
  const direct = intent => intent.action !== 'confirm' && isLowRiskDirectAction(intent.action)
    && typeof allowDirect === 'function' && allowDirect(intent) === true;
  return { async handle(envelope, text) {
    const explicit = /^\/owner\b/iu.test(String(text));
    if (!envelope || envelope.private !== true || envelope.verified !== true || !qq(envelope.ownerUserId) || !id(envelope.accountId)
      || !logical(envelope.logicalBotId) || !/^[-A-Za-z0-9_:]{1,128}$/.test(envelope.messageId || '') || !isOwner(envelope))
      return { matched: explicit, status: 'blocked', code: 'OWNER_IDENTITY_REQUIRED' };
    const source = capture(envelope);
    let intent = null, clarify = null, modelParsed = false;
    if (typeof parseUtterance === 'function') {
      let parsed;
      try { parsed = parseUtterance(text, envelope); } catch { return { matched: explicit, status: 'blocked', code: 'OWNER_PARSE_REJECTED' }; }
      if (parsed?.clarify) clarify = parsed.clarify;
      else if (parsed?.intent) { try { intent = validateOwnerIntent(parsed.intent); } catch { return { matched: true, status: 'blocked', code: 'OWNER_PARSE_REJECTED' }; } }
    }
    if (!intent && !clarify) intent = parseOwnerCommand(text);
    if (!intent && !clarify && parseIntent && (typeof isLikelyCommand !== 'function' || isLikelyCommand(text))) {
      try { const v = await parseIntent(text, envelope); if (v && Object.keys(v).length) {
        intent = validateOwnerIntent(v);
        // Model output can never confirm on the owner's behalf or create a new
        // actor/permission/preference kind.
        if (intent.action === 'confirm' || !(modelActions.has(intent.action) || queries.has(intent.action))) throw fail('OWNER_PARSE_REJECTED');
        modelParsed = true;
      } } catch { return { matched: true, status: 'blocked', code: 'OWNER_PARSE_REJECTED' }; }
    }
    if (clarify) return { matched: true, status: 'blocked', code: clarify.code || 'OWNER_TARGET_REQUIRED',
      clarify: typeof clarify.question === 'string' ? clarify.question.slice(0, 300) : null,
      candidates: Array.isArray(clarify.candidates) ? clarify.candidates.slice(0, 4).map(String) : [] };
    // Ordinary owner chat is NOT a command: no model call, no receipt, no side effect.
    if (!intent) return explicit ? { matched: true, status: 'not_supported', code: 'OWNER_COMMAND_UNKNOWN' }
      : { matched: false, status: 'unmatched', code: 'OWNER_NOT_A_COMMAND' };
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
        // A durable `ownerControl.lowRiskDirect` claim skips ONLY the second confirmation.
        const confirmation = !approval && !direct(intent) && (confirmedChanges.has(intent.action) || modelParsed);
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
  return {ok:true,revision:target.revision,action:target.directives[directiveId].action};
}
