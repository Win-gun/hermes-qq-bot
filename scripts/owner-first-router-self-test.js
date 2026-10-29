/**
 * Owner First 3.4 — worker A bounded self-test.
 *
 * Fake host + temporary data directory only: no config.json, no data/, no logs,
 * no .env, no network/model/QQ calls, no git. Every assertion runs against the
 * REAL src/owner-authority.js, src/owner-services.js and src/owner-intent.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerServices, normalizeOwnerControl } from '../src/owner-services.js';
import { resolveOwnerUtterance, parseOwnerQueryUtterance, buildOwnerIntentContext } from '../src/owner-intent.js';
import { parseOwnerCommand, validateOwnerIntent, ownerAddressFor, ownerDirectiveById,
  ownerGroupParticipationReduced, ownerDirectiveAllows } from '../src/owner-authority.js';
import { recordOwnerInteraction } from '../src/owner-interactions.js';

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deep = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const throws = (fn, message) => { assert.throws(fn, undefined, message); checks += 1; };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner34-workerA-'));
const memoryFile = path.join(dataDir, 'memory.json');
fs.writeFileSync(memoryFile, '{}');
const OWNER = '21001', MEMBER = '22002', CLOCK = Date.parse('2026-10-30T02:00:00+08:00');

const LEGACY_TARGETS = [
  { accountId: 'alpha', groupId: '31001' }, { accountId: 'alpha', groupId: '31002' },
  { accountId: 'alpha', groupId: '31004' }, { accountId: 'alpha', groupId: '31005' },
  { accountId: 'alpha', groupId: '31006' },
];
const SCOPE = { 'alpha:31001': true, 'alpha:31002': true, 'alpha:31004': true, 'alpha:31005': true,
  'alpha:31006': false, 'beta:31002': true, 'beta:31001': false };

const SCOPE_LOOKUP = (id, gid) => SCOPE[`${id}:${gid}`] === true;

function makeHost(options = {}) {
  // A fixture may want its own durable file so unrelated sections never share state.
  const file = options.memoryFile || memoryFile;
  if (options.memoryFile) fs.writeFileSync(file, '{}');
  const state = { clock: CLOCK, revision: 'rev-1', live: true, modelCalls: 0, wires: [], quiet: {}, revision2: 0 };
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const persist = value => fs.writeFileSync(file, JSON.stringify(value));
  const config = {
    ownerControl: { enabled: true, naturalLanguage: false, usageEnabled: true, lowRiskDirect: false,
      ...(options.policy || {}), allowedTargets: structuredClone(options.targets || LEGACY_TARGETS) },
    ownerNotifications: { enabled: true, recipients: [OWNER], times: ['09:00', '21:00'], timezone: 'Asia/Shanghai', ...(options.notifications || {}) },
    memory: { people: { enabled: false } },
  };
  if (options.omitLowRiskDirect) delete config.ownerControl.lowRiskDirect;
  const accounts = () => [{ id: 'alpha', status: 'online' }, { id: 'beta', status: 'online' }];
  const scopeAllows = (id, gid) => SCOPE[`${id}:${gid}`] === true;
  const transact = build => {
    const draft = structuredClone(stored());
    const result = build(draft);
    assert.ok(!result || typeof result.then !== 'function', 'host writer accepts only synchronous builders');
    persist(draft);
    if (typeof state.afterTransact === 'function') state.afterTransact(draft, result);
    return result;
  };
  const host = {
    read: stored, transact, getConfig: () => config, getRevision: () => state.revision,
    commitConfig: next => { Object.assign(config, next); state.revision = `rev-${++state.revision2 + 1}`; },
    accounts, ownerIds: () => [OWNER], logicalId: id => `account:${id}`,
    identityVerified: envelope => envelope.accountId === 'alpha' || envelope.accountId === 'beta',
    scopeAllows, capture: () => ({ revision: state.captureRevision ?? state.revision, carrier: 'alpha', session: 's-1' }),
    isCurrent: source => state.live && source.revision === state.revision,
    taskStatus: () => ({ running: 1, queued: 0, items: [] }),
    sendText: async intent => { state.wires.push({ kind: 'text', ...intent });
      return options.textReceipt ? options.textReceipt(intent) : { status: 'confirmed', resultId: '71001' }; },
    sendSticker: async intent => { state.wires.push({ kind: 'sticker', ...intent }); return { status: 'confirmed', resultId: '71002' }; },
    setQuiet: async intent => { state.wires.push({ kind: intent.action, ...intent });
      state.quiet[intent.groupId] = intent.action === 'quiet' ? intent.minutes : 0; return { status: 'confirmed' }; },
    setAutonomy: async intent => { state.wires.push({ kind: 'autonomy', ...intent }); return { status: 'confirmed' }; },
    now: () => state.clock,
    // `noHostTargets` models a host that exposes no target callback at all.
    ...(options.noHostTargets ? {} : {
      allowedTargets: () => options.hostTargets ? options.hostTargets() : LEGACY_TARGETS.map(row => ({ ...row })),
    }),
    intentContext: () => options.context ? options.context() : ({
      accounts: [{ id: 'alpha', name: '主号', aliases: ['阿法'] }, { id: 'beta', name: '备号' }],
      targets: [
        { accountId: 'alpha', groupId: '31001', name: '开发群' }, { accountId: 'alpha', groupId: '31002', name: '闲聊群' },
        { accountId: 'alpha', groupId: '31004', name: '同名群' }, { accountId: 'alpha', groupId: '31005', name: '同名群' },
        { accountId: 'beta', groupId: '31002', name: '闲聊群' }, { accountId: 'gamma', groupId: '31009', name: '野生群' },
        { accountId: 'alpha', groupId: '31006', name: '越权群' },
      ],
      ...(options.recentTarget ? { recentTarget: options.recentTarget } : {}),
    }),
    quietGroups: () => options.quietGroups ? options.quietGroups() : Object.entries(state.quiet)
      .filter(([, minutes]) => minutes > 0).map(([groupId]) => groupId),
    autonomyFor: () => options.autonomyFor ? options.autonomyFor() : true,
    onParticipationRevoked: (logical, groupId) => { state.revokedParticipation.push({ logical, groupId }); },
    ...(options.parseIntent ? { parseIntent: options.parseIntent(state) } : {}),
  };
  state.revokedParticipation = [];
  return { host, state, config, file, stored };
}

let seq = 0;
function makeService(options = {}) {
  const fixture = makeHost(options);
  const service = createOwnerServices(fixture.host);
  const envelope = (extra = {}) => ({ private: true, verified: true, ownerUserId: OWNER, accountId: 'alpha',
    logicalBotId: 'account:alpha', messageId: `m-${(seq += 1)}`, ...extra });
  return { ...fixture, service, envelope };
}

// ── 1. Deterministic Chinese query phrasing (no model, no wire) ───────────────
{
  // Real durable interaction facts for the activity/why reports (temporary file only).
  const seed = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
  equal(recordOwnerInteraction(seed, { logicalBotId: 'account:alpha', accountId: 'alpha',
    conversationId: 'group:31001', messageId: 'seed-received', direction: 'received', at: CLOCK - 1000, now: CLOCK }).recorded, true);
  equal(recordOwnerInteraction(seed, { logicalBotId: 'account:alpha', accountId: 'alpha',
    conversationId: 'group:31001', messageId: 'seed-sent', direction: 'sent', at: CLOCK, now: CLOCK }).recorded, true);
  fs.writeFileSync(memoryFile, JSON.stringify(seed));
}
const queryCases = [
  ['今日Token', 'tokens', { days: 1 }], ['今天的token是多少', 'tokens', { days: 1 }],
  ['最近七天Token', 'tokens', { days: 7 }], ['今日主要阻碍', 'blockers', {}],
  ['今天的阻碍有哪些', 'blockers', {}], ['今天活跃', 'activity', { days: 1 }],
  ['最近七天活跃', 'activity', { days: 7 }], ['未完成的任务和命令', 'tasks', {}],
  ['任务', 'tasks', {}], ['历史', 'history', {}], ['操作历史', 'history', {}],
  ['为什么没回复', 'why', {}], ['为啥不说话', 'why', {}], ['当前账号状态', 'status', {}],
];
for (const [text, action, expected] of queryCases) {
  const parsed = parseOwnerQueryUtterance(text) || parseOwnerCommand(text);
  check(parsed, `phrase must parse: ${text}`);
  equal(parsed.action, action, `action for ${text}`);
  for (const [key, value] of Object.entries(expected)) equal(parsed[key], value, `${key} for ${text}`);
}
{
  const f = makeService({ policy: { naturalLanguage: true }, parseIntent: () => async () => { f.state.modelCalls += 1; return null; } });
  for (const [text] of queryCases) {
    const result = await f.service.router.handle(f.envelope(), text);
    equal(result.status, 'confirmed', `query executes: ${text}`);
    equal(result.data !== undefined, true, `query returns host facts: ${text}`);
  }
  equal(f.state.modelCalls, 0, 'deterministic queries never call the model');
  equal(f.state.wires.length, 0, 'queries never send to QQ');
  const activity = f.service.query({ action: 'activity', days: 1 });
  check(activity.observed && activity.range?.timezone, 'activity uses durable interaction facts and a real range');
  equal(activity.observed.received, 1, 'activity reports the actually recorded received message');
  equal(activity.observed.sent, 1, 'activity reports the actually recorded sent message');
  const why = f.service.query({ action: 'why' });
  check(why.basis.includes('no model inference') && why.blockers?.coverage, 'why report is host-facts only');
  equal(why.observed.received, 1, 'why report uses the same durable facts');
  const report = await f.service.router.handle(f.envelope(), '为什么没回复');
  equal(report.status, 'confirmed', 'why answered');
  equal(f.state.wires.length, 0, 'why never resends a reply');
}

// ── 2. Name/QQ destination resolution, current-bot and recent-target rules ───
{
  const f = makeService({ policy: { lowRiskDirect: true } });
  const context = f.service.intentContext(f.envelope());
  const resolve = text => resolveOwnerUtterance(text, context);

  deep(resolve('给开发群发一句 早安').intent,
    { action: 'send_text', accountId: 'alpha', groupId: '31001', text: '早安' }, 'unique group name resolves');
  deep(resolve('发消息 alpha 31001 大家好').intent,
    { action: 'send_text', accountId: 'alpha', groupId: '31001', text: '大家好' }, 'account + QQ resolves');
  deep(resolve('给31001发一句 hi').intent,
    { action: 'send_text', accountId: 'alpha', groupId: '31001', text: 'hi' }, 'QQ number resolves');
  // 闲聊群 exists on alpha and beta; the CURRENT carrier resolves it, never a guess.
  deep(resolve('给闲聊群发一句 在吗').intent,
    { action: 'send_text', accountId: 'alpha', groupId: '31002', text: '在吗' }, 'current bot disambiguates a shared name');
  // Two groups on the SAME account share a name → must clarify.
  const ambiguous = resolve('给同名群发一句 在吗');
  equal(ambiguous.clarify?.code, 'OWNER_TARGET_AMBIGUOUS', 'same-account duplicate name requires clarification');
  check(ambiguous.clarify.candidates.length === 2, 'clarification lists the real candidates');
  equal(resolve('给不存在群发一句 在吗').clarify?.code, 'OWNER_TARGET_REQUIRED', 'unknown destination asks instead of guessing');
  equal(resolve('给野生群发一句 在吗').clarify?.code, 'OWNER_TARGET_REQUIRED', 'target outside the owner allowlist is never a destination');
  equal(resolve('给越权群发一句 在吗').clarify?.code, 'OWNER_TARGET_REQUIRED', 'target outside the account scope is never a destination');
  // recent target resolves a bare 群 command; without it the same command asks.
  const recent = buildOwnerIntentContext({ context: f.host.intentContext(), allowedTargets: f.service.allowedTargets(),
    knownAccounts: ['alpha', 'beta'], scopeAllows: SCOPE_LOOKUP, currentAccountId: 'alpha' });
  deep(resolveOwnerUtterance('安静一下 10分钟', recent).clarify?.code, 'OWNER_TARGET_REQUIRED', 'no implicit destination without a single/recent target');
  const withRecent = buildOwnerIntentContext({ context: { ...f.host.intentContext(), recentTarget: { accountId: 'alpha', groupId: '31001' } },
    allowedTargets: f.service.allowedTargets(), knownAccounts: ['alpha', 'beta'], scopeAllows: SCOPE_LOOKUP, currentAccountId: 'alpha' });
  deep(resolveOwnerUtterance('安静一下 10分钟', withRecent).intent,
    { action: 'quiet', accountId: 'alpha', groupId: '31001', minutes: 10 }, 'recent target resolves a bare quiet command');

  // A name shared ACROSS accounts with no current bot: the recent target decides, never a guess.
  const crossName = buildOwnerIntentContext({ context: { accounts: [{ id: 'alpha', name: '主号' }, { id: 'beta', name: '备号' }],
    targets: [{ accountId: 'alpha', groupId: '31001', name: '开发群' }, { accountId: 'beta', groupId: '31001', name: '开发群' }],
    recentTarget: { accountId: 'beta', groupId: '31001' } },
    allowedTargets: [{ accountId: 'alpha', groupId: '31001' }, { accountId: 'beta', groupId: '31001' }],
    knownAccounts: ['alpha', 'beta'], scopeAllows: () => true, currentAccountId: '' });
  deep(resolveOwnerUtterance('给开发群发一句 早安', crossName).intent,
    { action: 'send_text', accountId: 'beta', groupId: '31001', text: '早安' }, 'recent target disambiguates a cross-account shared name');
  const noRecentSame = buildOwnerIntentContext({ context: { accounts: [{ id: 'alpha', name: '主号' }, { id: 'beta', name: '备号' }],
    targets: [{ accountId: 'alpha', groupId: '31001', name: '开发群' }, { accountId: 'beta', groupId: '31001', name: '开发群' }] },
    allowedTargets: [{ accountId: 'alpha', groupId: '31001' }, { accountId: 'beta', groupId: '31001' }],
    knownAccounts: ['alpha', 'beta'], scopeAllows: () => true, currentAccountId: '' });
  equal(resolveOwnerUtterance('给开发群发一句 早安', noRecentSame).clarify?.code, 'OWNER_TARGET_AMBIGUOUS',
    'without a current bot or recent target a shared name asks');
  // Ambiguous account nickname must also ask.
  const dupAccount = buildOwnerIntentContext({ context: { accounts: [{ id: 'alpha', name: '主号' }, { id: 'beta', name: '主号' }],
    targets: [] }, allowedTargets: [], knownAccounts: ['alpha', 'beta'], scopeAllows: () => true, currentAccountId: '' });
  equal(resolveOwnerUtterance('关闭主号的自动参与', dupAccount).clarify?.code, 'OWNER_ACCOUNT_AMBIGUOUS',
    'ambiguous account nickname asks instead of guessing');
  equal(resolveOwnerUtterance('给开发群发一句 晚安', { accounts: [], targets: [] })?.clarify?.code, 'OWNER_TARGET_REQUIRED',
    'an empty context asks for an explicit destination instead of inventing one');
  equal(resolveOwnerUtterance('给开发群发一句 晚安', {}), null,
    'a stale/non-context object is not a resolution context');

  // Write grammar coverage.
  deep(resolve('发个表情 alpha 31001 开心')?.intent,
    { action: 'send_sticker', accountId: 'alpha', groupId: '31001', query: '开心' }, 'sticker intent bounded');
  deep(resolve('给开发群发个表情 开心')?.intent,
    { action: 'send_sticker', accountId: 'alpha', groupId: '31001', query: '开心' }, 'sticker by unique group name');
  deep(resolve('让开发群安静 15分钟').intent,
    { action: 'quiet', accountId: 'alpha', groupId: '31001', minutes: 15 }, 'quiet intent bounded');
  deep(resolve('恢复开发群').intent, { action: 'resume', accountId: 'alpha', groupId: '31001' }, 'resume intent bounded');
  deep(resolve('关闭 alpha 的自动参与').intent, { action: 'autonomy', accountId: 'alpha', enabled: false }, 'autonomy off intent');
  deep(resolve('开启 alpha 的自动参与').intent, { action: 'autonomy', accountId: 'alpha', enabled: true }, 'autonomy on intent');
  deep(resolve('关闭主人通知').intent, { action: 'notifications', enabled: false, times: ['09:00', '21:00'], timezone: 'Asia/Shanghai' },
    'notifications intent keeps safe defaults');
  deep(resolve('别拍一拍 22001 alpha 31001').intent,
    { action: 'restrict_poke', accountId: 'alpha', groupId: '31001', userId: '22001' }, 'no-poke intent bounded');
  deep(resolve('以后叫我老板').intent, { action: 'set_address', text: '老板' }, 'address preference intent');
  deep(resolve('减少开发群的参与').intent,
    { action: 'reduce_participation', accountId: 'alpha', groupId: '31001' }, 'reduced participation intent');
  const revoked = resolve('撤销指令 ' + 'a'.repeat(32));
  deep(revoked.intent, { action: 'revoke_directive', directiveId: 'a'.repeat(32) }, 'revoke intent bounded');
}

// ── 3. Ordinary owner chat is unmatched and costs zero model calls ───────────
{
  const f = makeService({ policy: { enabled: true, naturalLanguage: true },
    parseIntent: () => async () => { f.state.modelCalls += 1; return { action: 'status' }; } });
  for (const text of ['晚上吃什么好', '今天天气不错啊', '你觉得这个梗好笑吗', '夸夸我']) {
    const result = await f.service.router.handle(f.envelope(), text);
    equal(result.matched, false, `ordinary chat is not a command: ${text}`);
    equal(result.status, 'unmatched', `ordinary chat returns unmatched: ${text}`);
  }
  equal(f.state.modelCalls, 0, 'ordinary chat never invokes the model parser');
  equal(f.state.wires.length, 0, 'ordinary chat performs no action');
  const unknown = await f.service.router.handle(f.envelope(), '/owner frobnicate');
  equal(unknown.status, 'not_supported', 'explicit /owner with an unknown verb stays not_supported');
  equal(f.state.modelCalls, 0, 'explicit unknown command does not fall through to a model');
}

// ── 4. lowRiskDirect: legacy default false, opt-in true, always bounded ──────
{
  const legacy = normalizeOwnerControl({ enabled: true, allowedTargets: [] });
  equal(legacy.lowRiskDirect, false, 'legacy config without the flag defaults to false');
  const f = makeService({ omitLowRiskDirect: true });
  // A confirmed-change action still requires the explicit second confirmation.
  const pending = await f.service.router.handle(f.envelope(), '关闭 alpha 的自动参与');
  equal(pending.status, 'accepted', 'confirmed-change action still awaits explicit confirmation by default');
  equal(pending.code, 'OWNER_CONFIRM_REQUIRED', 'confirmation receipt code');
  equal(f.state.wires.length, 0, 'no wire write before confirmation');
  const confirmed = await f.service.router.handle(f.envelope(), '/owner confirm ' + pending.id);
  equal(confirmed.status, 'confirmed', 'explicit confirmation executes once');
  equal(f.state.wires.length, 1, 'exactly one wire call after confirmation');
  equal((await f.service.router.handle(f.envelope(), '/owner confirm ' + pending.id)).code, 'OWNER_APPROVAL_STALE',
    'the approval is single-use');
  // The same semantic parse runs directly once the owner opts in.
  const opted = makeService({ policy: { lowRiskDirect: true } });
  equal((await opted.service.router.handle(opted.envelope(), '关闭 alpha 的自动参与')).status, 'confirmed',
    'lowRiskDirect runs a bounded confirmed-change action directly');
}
{
  const f = makeService({ policy: { lowRiskDirect: true } });
  const sent = await f.service.router.handle(f.envelope(), '给开发群发一句 早安');
  equal(sent.status, 'confirmed', 'lowRiskDirect sends a bounded semantic write directly');
  equal(f.state.wires.length, 1, 'exactly one real wire call');
  deep(f.state.wires[0], { kind: 'text', action: 'send_text', accountId: 'alpha', groupId: '31001', text: '早安' },
    'wire arguments are the resolved bounded intent');
  check(!JSON.stringify(f.state.wires).includes('CQ:'), 'no raw CQ payload reaches the host');

  const replay = await f.service.router.handle(f.envelope(), '给开发群发一句 早安');
  equal(replay.status, 'confirmed', 'distinct message id is a distinct one-shot');
  equal(f.state.wires.length, 2, 'distinct source message executes once');
  const quiet = await f.service.router.handle(f.envelope({ messageId: 'replay-1' }), '让开发群安静 5分钟');
  equal(quiet.status, 'confirmed', 'quiet executes directly');
  equal(f.state.quiet['31001'], 5, 'quiet minutes actually persisted via the host');
  equal((await f.service.router.handle(f.envelope({ messageId: 'replay-1' }), '让开发群安静 5分钟')).code,
    'OWNER_ALREADY_CLAIMED', 'identical message id is never replayed');
  equal((await f.service.router.handle(f.envelope({ messageId: 'replay-1' }), '让开发群安静 5分钟')).status,
    'uncertain', 'duplicate claim reports uncertain, not success');
  equal(f.state.wires.length, 3, 'no third wire call for the duplicate');
}

// ── 5. Identity cannot be spoofed; model cannot create actor/permission ──────
{
  const f = makeService({ policy: { lowRiskDirect: true } });
  const spoofs = [
    [{ ownerUserId: MEMBER }, 'non-owner QQ'],
    [{ private: false, groupId: '31001' }, 'group chat is not private authority'],
    [{ verified: false }, 'unverified carrier envelope'],
    [{ logicalBotId: 'account:beta' }, 'mismatched logical identity'],
    [{ messageId: '' }, 'missing source message id'],
  ];
  for (const [extra, label] of spoofs) {
    const result = await f.service.router.handle(f.envelope(extra), '给开发群发一句 早安');
    equal(result.status, 'blocked', `spoofed identity blocked: ${label}`);
    equal(result.code, 'OWNER_IDENTITY_REQUIRED', `identity code: ${label}`);
  }
  equal(f.state.wires.length, 0, 'spoofed requests never reach the wire');

  // A model candidate may not confirm, invent an action, or name an unknown actor.
  const malicious = [
    [{ action: 'confirm', commandId: 'a'.repeat(32) }, 'OWNER_PARSE_REJECTED'],
    [{ action: 'grant_target', accountId: 'beta', groupId: '31001' }, 'OWNER_PARSE_REJECTED'],
    [{ action: 'set_address', text: '主人' }, 'OWNER_PARSE_REJECTED'],
    [{ action: 'send_text', accountId: 'gamma', groupId: '31009', text: '你好' }, 'OWNER_SCOPE_REQUIRED'],
    [{ action: 'send_text', accountId: 'alpha', groupId: '31006', text: '你好' }, 'OWNER_SCOPE_REQUIRED'],
  ];
  for (const [candidate, code] of malicious) {
    const model = makeService({ policy: { enabled: true, naturalLanguage: true, lowRiskDirect: true },
      parseIntent: () => async () => { model.state.modelCalls += 1; return candidate; } });
    const result = await model.service.router.handle(model.envelope(), '请按我上边说的做');
    equal(result.code, code, `model candidate refused with ${code}`);
    equal(model.state.wires.length, 0, 'refused model candidate performs nothing');
    check(model.state.modelCalls === 1, 'the model parser is consulted at most once');
  }
  equal(validateOwnerIntent, validateOwnerIntent, 'intent validator exported');
  assert.throws(() => validateOwnerIntent({ action: 'send_text', accountId: 'alpha', groupId: '31001', text: '[CQ:at,qq=1]' }));
  checks += 1;
}

// ── 6. Stale revisions, final gate and exactly-once durability ───────────────
{
  const f = makeService({ policy: { lowRiskDirect: true } });
  f.state.captureRevision = 'rev-old';
  equal((await f.service.router.handle(f.envelope(), '给开发群发一句 早安')).code, 'OWNER_STALE_SOURCE',
    'stale config revision blocks before any claim');
  equal(f.state.wires.length, 0, 'stale rejection performs nothing');
  f.state.captureRevision = null;
  f.state.live = false;
  equal((await f.service.router.handle(f.envelope(), '给开发群发一句 早安')).code, 'OWNER_STALE_SOURCE',
    'revoked carrier liveness blocks');
  f.state.live = true;

  // Revision changes AFTER the durable claim but BEFORE dispatch: the final gate holds.
  const gate = makeService({ policy: { lowRiskDirect: true } });
  let mutated = false;
  gate.state.afterTransact = draft => {
    const row = Object.values(draft.ownerAuthority?.commands || {}).find(item => item.status === 'claimed');
    if (!mutated && row) { mutated = true; gate.state.revision = 'rev-late'; }
  };
  const gated = await gate.service.router.handle(gate.envelope(), '给开发群发一句 早安');
  equal(mutated, true, 'the claim was durably written before the injected revision change');
  equal(gated.status, 'blocked', 'revision change between claim and dispatch blocks');
  equal(gated.code, 'OWNER_STALE_SOURCE', 'final gate code');
  equal(gate.state.wires.length, 0, 'final gate prevents the wire write');
  gate.state.afterTransact = null;

  // Concurrent duplicates: at most one execution.
  const race = makeService({ policy: { lowRiskDirect: true } });
  const results = await Promise.all([race.service.router.handle(race.envelope({ messageId: 'same' }), '给开发群发一句 早安'),
    race.service.router.handle(race.envelope({ messageId: 'same' }), '给开发群发一句 早安')]);
  equal(race.state.wires.length, 1, 'concurrent duplicate claims execute at most once');
  check(results.some(row => row.status === 'uncertain'), 'the loser reports uncertain');

  // Durable restart: the claim survives, nothing replays.
  const before = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
  check(Object.keys(before.ownerAuthority.commands).length > 0, 'claims are durably recorded in the temporary data file');
  const restarted = makeService({ policy: { lowRiskDirect: true } });
  equal((await restarted.service.router.handle(restarted.envelope({ messageId: 'same' }), '给开发群发一句 早安')).status,
    'uncertain', 'restart cannot replay a persisted claim');
  equal(restarted.state.wires.length, 0, 'restart performs no wire write');
}

// ── 7. Real outcomes are never reported as premature success ────────────────
for (const [receipt, expected, code] of [
  [() => ({ status: 'accepted' }), 'accepted', 'OWNER_RESULT'],
  [() => true, 'uncertain', 'OWNER_RECEIPT_MISSING'],
  [() => { throw new Error('timeout with secret token abc'); }, 'uncertain', 'OWNER_EXECUTION_UNCONFIRMED'],
  [() => { throw Object.assign(new Error('rejected'), { oneBotRejected: true }); }, 'failed', 'OWNER_WIRE_REJECTED'],
  [() => ({ status: 'confirmed', resultId: '88001' }), 'confirmed', 'OWNER_RESULT'],
]) {
  const f = makeService({ policy: { lowRiskDirect: true }, textReceipt: receipt });
  const result = await f.service.router.handle(f.envelope(), '给开发群发一句 早安');
  equal(result.status, expected, `receipt ${expected} is reported honestly`);
  if (expected !== 'confirmed') check(result.code !== 'confirmed', `no success code for ${expected}`);
  const stored = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
  const row = Object.values(stored.ownerAuthority.commands).find(item => item.status === expected);
  check(row, `durable record stores the real outcome ${expected}`);
  check(!JSON.stringify(stored).includes('secret token'), 'raw exception text is never persisted');
  check(!JSON.stringify(stored).includes('早安'), 'private send body is not stored in history');
}

// ── 8. Owner preferences: low-risk direct, then revocable, then legacy confirm ─
{
  // (a) 3.4 requirement: a CLEAR low-risk persistent preference must not require
  // copying an approval id. With ownerControl.lowRiskDirect=true the deterministic
  // intent executes directly, persists, is verified against the store, and revokes.
  // The owner is speaking in the group conversation, so the host supplies that target.
  const fileA = path.join(dataDir, 'memory-8a.json'), fileB = path.join(dataDir, 'memory-8b.json');
  const f = makeService({ policy: { lowRiskDirect: true }, memoryFile: fileA,
    recentTarget: { accountId: 'alpha', groupId: '31001' } });
  equal(f.service.addressFor('alpha'), null, 'no address preference by default');

  const direct = await f.service.router.handle(f.envelope(), '我不喜欢你总是称呼我主人');
  equal(direct.status, 'confirmed', 'negative address preference runs directly under lowRiskDirect');
  deep(direct.change, undefined, 'no pending approval is created for a low-risk direct preference');
  deep(f.service.addressAvoidedFor('alpha'), ['主人'], 'avoided label is durably exposed to the bridge');
  equal(f.service.addressFor('alpha'), null, 'an avoided label is never the active address preference');
  deep(f.service.addressAvoidedFor('beta'), [], 'preference is per logical identity, not global');
  const stored8 = () => JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const avoidRow = Object.values(stored8().ownerAuthority.directives).find(row => row.action === 'address' && row.mode === 'avoid');
  check(avoidRow, 'avoid preference is a durable, individually revocable directive row');
  equal(ownerDirectiveById(stored8(), { directiveId: avoidRow.id })?.mode, 'avoid', 'directive view reports the avoid mode');
  equal((await f.service.router.handle(f.envelope(), `撤销指令 ${avoidRow.id}`)).status, 'confirmed',
    'avoid preference revokes directly');
  deep(f.service.addressAvoidedFor('alpha'), [], 'revocation restores the default address behaviour');

  // (b) Positive address preference, also direct, then legible through the helper.
  const addressed = await f.service.router.handle(f.envelope(), '以后叫我老板');
  equal(addressed.status, 'confirmed', 'address preference runs directly under lowRiskDirect');
  equal(f.service.addressFor('alpha'), '老板', 'bridge helper exposes the preference');
  equal(f.service.addressFor('beta'), null, 'preference is per logical identity, not global');
  const addressRow = Object.values(stored8().ownerAuthority.directives).find(row => row.action === 'address' && row.mode !== 'avoid');
  check(addressRow, 'address directive is durably stored');
  check(ownerDirectiveById(stored8(), { directiveId: addressRow.id })?.id === addressRow.id, 'directive is readable by exact id');
  equal(ownerDirectiveById(stored8(), { directiveId: 'f'.repeat(32) }), null, 'unknown directive id is not readable');

  // (c) "以后这个群尽量少说话" — standing reduced participation, group-scoped, direct.
  const reducedDirect = await f.service.router.handle(f.envelope(), '以后这个群尽量少说话');
  equal(reducedDirect.status, 'confirmed', 'group-scoped reduced participation runs directly');
  equal(f.service.participationReducedFor('alpha', '31001'), true, 'the actual resolved group is reduced');
  equal(f.service.participationReducedFor('alpha', '31002'), false, 'other groups unaffected');
  equal(ownerDirectiveAllows(stored8(), { logicalBotId: 'account:alpha', groupId: '31001', action: 'group_participation' }), false,
    'reduction gate is effective');
  check(f.service.query({ action: 'why' }).participationReduced.some(row => row.includes('31001')),
    'why report surfaces the owner-recorded reduction');
  const participationId = Object.values(stored8().ownerAuthority.directives).find(row => row.action === 'group_participation').id;
  equal((await f.service.router.handle(f.envelope(), `撤销指令 ${participationId}`)).status, 'confirmed',
    'revocation runs directly (lowRiskDirect) and is verified against the store');
  equal(f.service.participationReducedFor('alpha', '31001'), false, 'revocation restores participation immediately');
  equal(f.state.revokedParticipation.length, 1, 'bridge hook notified about cancellation');
  equal((await f.service.router.handle(f.envelope(), `撤销指令 ${participationId}`)).status, 'blocked',
    'a revoked directive cannot be revoked twice');

  // (d) The legacy shape still exists: explicit confirmation when lowRiskDirect is off.
  const g = makeService({ policy: { lowRiskDirect: false }, memoryFile: fileB,
    recentTarget: { accountId: 'alpha', groupId: '31001' } });
  const pendingAddress = await g.service.router.handle(g.envelope(), '以后叫我老板');
  equal(pendingAddress.status, 'accepted', 'without lowRiskDirect the second confirmation is still required');
  equal(pendingAddress.code, 'OWNER_CONFIRM_REQUIRED', 'legacy confirm path is unchanged');
  equal(g.service.addressFor('alpha'), null, 'nothing is persisted before confirmation');
  equal((await g.service.router.handle(g.envelope(), '/owner confirm ' + pendingAddress.id)).status, 'confirmed',
    'address preference is persisted after explicit confirmation');
  equal(g.service.addressFor('alpha'), '老板', 'confirmed preference is exposed');
  const pendingReduce = await g.service.router.handle(g.envelope(), '以后这个群尽量少说话');
  equal(pendingReduce.status, 'accepted', 'reduced participation still confirms when lowRiskDirect is off');
  equal(g.service.participationReducedFor('alpha', '31001'), false, 'reduction not applied before confirmation');
  equal((await g.service.router.handle(g.envelope(), '/owner confirm ' + pendingReduce.id)).status, 'confirmed',
    'reduced participation persisted after confirmation');
  equal(g.service.participationReducedFor('alpha', '31001'), true, 'confirmed reduction is effective');

  // (d2) The explicit `/owner` prefix is equivalent to the bare natural-language form.
  const prefixed = await f.service.router.handle(f.envelope(), '/owner 我不喜欢你总是称呼我主人');
  equal(prefixed.status, 'confirmed', 'the /owner prefix resolves the same natural-language preference');
  deep(f.service.addressAvoidedFor('alpha'), ['主人'], 'prefix form persists the same avoid directive');
  const prefixedReduce = await f.service.router.handle(f.envelope(), '/owner 以后这个群尽量少说话');
  equal(prefixedReduce.status, 'confirmed', 'the /owner prefix resolves the standing reduce form');
  equal(f.service.participationReducedFor('alpha', '31001'), true, 'prefix form applies to the real group');

  // (e) Directives are a strict allowlist: unknown kinds are refused by the store.
  const noPoke = await f.service.router.handle(f.envelope(), '别拍一拍 22001 alpha 31001');
  equal(noPoke.status, 'confirmed', 'no-poke directive stored');
  equal(ownerDirectiveAllows(stored8(), { logicalBotId: 'account:alpha', groupId: '31001', userId: '22001', action: 'group_poke' }), false,
    'poke restriction effective');
  equal(ownerAddressFor(stored8(), { logicalBotId: 'account:alpha' }), '老板', 'address preference survives unrelated directives');
  equal(ownerGroupParticipationReduced(stored8(), { logicalBotId: 'account:beta', groupId: '31001' }), false,
    'other logical identities are isolated');
}

// ── 8b. Natural revocation resolves to one exact owned directive, or asks ────
{
  const fileR = path.join(dataDir, 'memory-8c.json');
  const f = makeService({ policy: { lowRiskDirect: true }, memoryFile: fileR,
    recentTarget: { accountId: 'alpha', groupId: '31001' } });
  const direct = (name) => Object.values(JSON.parse(fs.readFileSync(fileR, 'utf8')).ownerAuthority?.directives || {})
    .filter(row => row.action === name);
  const say = (text, extra = {}) => f.service.router.handle(f.envelope(extra), text);

  // (a) 取消对我的称呼偏好 — the current logical bot's own address preference only.
  equal((await say('以后叫我老板')).status, 'confirmed', 'address preference stored first');
  equal(f.service.addressFor('alpha'), '老板', 'preference is readable');
  const revokeAddress = await say('取消对我的称呼偏好');
  equal(revokeAddress.status, 'confirmed', 'natural revocation of the address preference runs');
  equal(revokeAddress.code, 'OWNER_DIRECTIVE_REVOKED', 'it reuses the exact revoke_directive receipt');
  equal(f.service.addressFor('alpha'), null, 'the address preference is actually gone');
  equal(direct('address').every(row => row.state === 'revoked'), true, 'the store holds a tombstone, not a deletion');
  equal((await say('取消对我的称呼偏好')).status, 'blocked', 'nothing left to revoke');
  equal((await say('取消对我的称呼偏好')).code, 'OWNER_DIRECTIVE_NOT_FOUND', 'a missing rule is reported, not invented');

  // A negative (avoid) preference is revoked the same way and separately.
  equal((await say('我不喜欢你总是称呼我主人')).status, 'confirmed', 'avoid preference stored');
  deep(f.service.addressAvoidedFor('alpha'), ['主人'], 'avoid label present');
  equal((await say('取消对我的称呼偏好')).status, 'confirmed', 'avoid preference revokes naturally');
  deep(f.service.addressAvoidedFor('alpha'), [], 'avoid list is empty afterwards');

  // (b) 恢复这个群正常发言 — the reduced-participation rule, not the quiet timer.
  equal((await say('以后这个群尽量少说话')).status, 'confirmed', 'standing reduction stored');
  equal(f.service.participationReducedFor('alpha', '31001'), true, 'reduction is effective');
  equal(f.state.quiet['31001'] || 0, 0, 'the temporary quiet timer was never touched');
  const restore = await say('恢复这个群正常发言');
  equal(restore.status, 'confirmed', '恢复这个群正常发言 revokes the standing rule');
  equal(f.service.participationReducedFor('alpha', '31001'), false, 'participation is restored');
  equal(direct('group_participation').every(row => row.state === 'revoked'), true, 'participation tombstone kept');
  deep(f.state.revokedParticipation, [{ logical: 'account:alpha', groupId: '31001' }],
    'the host hook fires exactly once for the natural revocation');
  equal((await say('恢复这个群正常发言')).code, 'OWNER_DIRECTIVE_NOT_FOUND', 'second restore has nothing to revoke');

  // 取消这个群少说话的要求 is the same intent by another clear phrasing.
  equal((await say('以后这个群尽量少说话')).status, 'confirmed', 'reduction stored again');
  const wording = await say('取消这个群少说话的要求');
  equal(wording.status, 'confirmed', 'the alternative phrasing revokes the same rule');
  equal(f.service.participationReducedFor('alpha', '31001'), false, 'alternative phrasing restores participation');

  // (c) Explicit real QQ + resolved allowed target for a no-poke rule.
  equal((await say('别拍一拍 22001 alpha 31001')).status, 'confirmed', 'no-poke rule stored');
  equal(ownerDirectiveAllows(JSON.parse(fs.readFileSync(fileR, 'utf8')),
    { logicalBotId: 'account:alpha', groupId: '31001', userId: '22001', action: 'group_poke' }), false, 'rule effective');
  const unPoke = await say('取消禁止拍一拍 22001 alpha 31001');
  equal(unPoke.status, 'confirmed', 'explicit QQ + allowed target revokes the no-poke rule');
  equal(ownerDirectiveAllows(JSON.parse(fs.readFileSync(fileR, 'utf8')),
    { logicalBotId: 'account:alpha', groupId: '31001', userId: '22001', action: 'group_poke' }), true, 'poking allowed again');

  // (d) Ambiguity and spoofing never pick a row.
  const ambiguousFile = path.join(dataDir, 'memory-8d.json');
  const g = makeService({ policy: { lowRiskDirect: true }, memoryFile: ambiguousFile,
    recentTarget: { accountId: 'alpha', groupId: '31001' } });
  await g.service.router.handle(g.envelope(), '以后叫我老板');
  await g.service.router.handle(g.envelope(), '我不喜欢你总是称呼我主人');
  const ambiguous = await g.service.router.handle(g.envelope(), '取消对我的称呼偏好');
  equal(ambiguous.status, 'blocked', 'two live address rules are NOT silently resolved');
  equal(ambiguous.code, 'OWNER_DIRECTIVE_AMBIGUOUS', 'the owner is told the choice is ambiguous');
  check(ambiguous.clarify && ambiguous.clarify.includes('撤销指令'), 'the clarification names the exact-id escape hatch');
  equal(g.service.addressFor('alpha'), '老板', 'nothing was revoked while ambiguous');
  deep(g.service.addressAvoidedFor('alpha'), ['主人'], 'the avoid rule also survived');
  equal(ambiguous.candidates.length, 2, 'both real candidate ids are offered');

  // Unresolvable target: ask, never revoke an arbitrary group.
  const targetless = makeService({ policy: { lowRiskDirect: true }, memoryFile: path.join(dataDir, 'memory-8e.json') });
  const noTarget = await targetless.service.router.handle(targetless.envelope(), '恢复这个群正常发言');
  equal(noTarget.status, 'blocked', 'a group-scoped revocation without a unique group asks');
  check(['OWNER_TARGET_REQUIRED', 'OWNER_TARGET_AMBIGUOUS'].includes(noTarget.code), 'bounded clarification code');
  check(!JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-8e.json'), 'utf8')).ownerAuthority?.directives
    || Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-8e.json'), 'utf8')).ownerAuthority.directives).length === 0,
    'no directive was written by a refused revocation');

  // Spoofed identity shapes are rejected before any lookup.
  equal((await say('取消对我的称呼偏好', { ownerUserId: '22999' })).status, 'blocked', 'non-owner cannot revoke');
  equal((await say('恢复这个群正常发言', { verified: false })).code, 'OWNER_IDENTITY_REQUIRED', 'unverified envelope cannot revoke');
  equal((await say('取消对我的称呼偏好', { logicalBotId: 'account:beta' })).code, 'OWNER_IDENTITY_REQUIRED',
    'a mismatched logical id cannot revoke');
  equal((await say('取消对我的称呼偏好', { private: false })).code, 'OWNER_IDENTITY_REQUIRED', 'a group chat cannot revoke');
  // A tombstone is never revived or re-revoked, and another logical bot's rule is untouched.
  const storedR = JSON.parse(fs.readFileSync(fileR, 'utf8'));
  check(Object.values(storedR.ownerAuthority.directives).every(row => row.state === 'revoked'),
    'every rule in this fixture ends as a tombstone');
  const otherBot = await g.service.router.handle(g.envelope({ logicalBotId: 'account:beta' }), '取消对我的称呼偏好');
  equal(otherBot.code, 'OWNER_IDENTITY_REQUIRED', 'another logical bot cannot revoke this one');
  equal(g.service.addressFor('alpha'), '老板', 'the other bot attempt changed nothing');

  // (e) The behaviour survives a restart: the store, not memory, is the source of truth.
  const restarted = createOwnerServices(g.host);
  await restarted.router.handle(g.envelope(), '撤销指令 ' + ambiguous.candidates[0]);
  equal(JSON.parse(fs.readFileSync(ambiguousFile, 'utf8')).ownerAuthority.directives[ambiguous.candidates[0]].state, 'revoked',
    'an exact-id revocation still works after a restart');
}

// ── 9. Target modes: explicit (historical) vs inherited (3.4), never a wildcard ─
{
  const f = makeService({ hostTargets: () => [
    { accountId: 'alpha', groupId: '31001' }, { accountId: 'beta', groupId: '31002' },
    { accountId: 'gamma', groupId: '31009' }, { accountId: 'alpha', groupId: '31006' },
  ] });
  equal(f.config.ownerControl.targetMode, undefined, 'the legacy config really has no targetMode');
  equal(f.service.status().control.targetMode, 'explicit', 'absent targetMode normalizes to explicit');
  deep(f.service.allowedTargets(), [{ accountId: 'alpha', groupId: '31001' }],
    'host targets are intersected with the owner allowlist and the real account scope');
  equal(f.service.intentContext(f.envelope()).targets.some(row => row.groupId === '31009'), false,
    'unauthorized host target never becomes a destination');
  // A host that reports no current pair denies, even though the config allowlist is full.
  const nothingJoined = makeService({ hostTargets: () => [] });
  deep(nothingJoined.service.allowedTargets(), [], 'explicit mode: a supplied host callback can deny by reporting nothing');
  equal((await nothingJoined.service.router.handle(nothingJoined.envelope(), '给开发群发一句 早安')).status, 'blocked',
    'explicit mode: nothing joined means nothing may be sent');
  // An explicit empty allowlist still denies everything: it is NOT a wildcard.
  const empty = makeService({ targets: [] });
  deep(empty.service.allowedTargets(), [], 'explicit empty allowlist denies every target');
  equal((await empty.service.router.handle(empty.envelope(), '给开发群发一句 早安')).status, 'blocked',
    'explicit empty allowlist cannot be talked around by a write');

  // inherited: the trusted host callback is the authority, so an empty static list no
  // longer blanket-blocks real joined groups — but it still needs the callback and scope.
  const inherited = makeService({ targets: [], policy: { targetMode: 'inherited' }, hostTargets: () => [
    { accountId: 'alpha', groupId: '31001' }, { accountId: 'beta', groupId: '31002' },
    { accountId: 'gamma', groupId: '31009' }, { accountId: 'alpha', groupId: '31006' },
  ] });
  equal(inherited.service.status().control.targetMode, 'inherited', 'inherited mode round-trips through status');
  deep(inherited.service.allowedTargets(), [{ accountId: 'alpha', groupId: '31001' }, { accountId: 'beta', groupId: '31002' }],
    'inherited mode allows every real, in-scope joined target and drops unknown/unauthorized ones');
  deep(inherited.service.intentContext(inherited.envelope()).targets.map(row => `${row.accountId}:${row.groupId}`).sort(),
    ['alpha:31001', 'beta:31002'], 'inherited context offers exactly the real joined targets');
  equal(inherited.service.query({ action: 'people', accountId: 'alpha', userId: MEMBER }).status, 'missing',
    'inherited people queries use verified targets rather than the empty legacy table');
  const queried = await inherited.service.router.handle(inherited.envelope(), `/owner people alpha ${MEMBER}`);
  equal(queried.status, 'confirmed', 'authenticated inherited people query reaches the real store');
  throws(() => nothingJoined.service.query({ action: 'people', accountId: 'alpha', userId: MEMBER }),
    'people queries cannot use stale static targets after host membership is revoked');

  // No host callback ⇒ inherited denies everything. Never a wildcard.
  const noCallback = makeService({ targets: [], policy: { targetMode: 'inherited' }, noHostTargets: true });
  deep(noCallback.service.allowedTargets(), [], 'inherited mode without a trusted host callback denies all targets');
  equal(noCallback.service.intentContext(noCallback.envelope()).targets.length, 0, 'no context targets are invented');

  // A non-empty explicit restriction still narrows inherited mode.
  const narrowed = makeService({ targets: [{ accountId: 'alpha', groupId: '31002' }], policy: { targetMode: 'inherited' } });
  deep(narrowed.service.allowedTargets(), [{ accountId: 'alpha', groupId: '31002' }],
    'a non-empty owner allowlist still narrows inherited mode');

  // Deny rules and account scope outrank both modes.
  const denied = makeService({ targets: [], policy: { targetMode: 'inherited' },
    hostTargets: () => [{ accountId: 'alpha', groupId: '31006' }, { accountId: 'beta', groupId: '31001' }] });
  deep(denied.service.allowedTargets(), [], 'an out-of-scope pair is denied even in inherited mode');

  // The mode itself is validated, and the UI can still save the legacy shape alone.
  throws(() => normalizeOwnerControl({ targetMode: 'wildcard' }), 'targetMode is a closed enum');
  equal(normalizeOwnerControl({ enabled: true, allowedTargets: [] }).targetMode, 'explicit',
    'legacy payload without targetMode stays valid');
  const saved = makeService({ targets: [], policy: { targetMode: 'inherited' } });
  equal(saved.service.settings({ expectedRevision: saved.state.revision,
    control: { enabled: true, allowedTargets: [{ accountId: 'alpha', groupId: '31001' }] } }).control.targetMode, 'inherited',
    'a UI patch that omits targetMode preserves the stored mode');
}

// The fake host never wires a real model/network/QQ client.
console.log(JSON.stringify({ ok: true, checks, fakeHost: true, temporaryData: true, realQQ: false,
  realModelCalls: 0, network: false, productionConfig: false }));
fs.rmSync(dataDir, { recursive: true, force: true });
