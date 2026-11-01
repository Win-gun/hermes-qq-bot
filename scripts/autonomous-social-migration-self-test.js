import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrateAutonomousSocialConfig, createAutonomousSocialStarter, normalizeAutonomousSocialPolicy,
  AUTONOMOUS_SOCIAL_NEW_OPTIONS } from '../src/autonomous-social-migration.js';
import { validateQzonePolicy } from '../src/qzone-policy.js';
import { normalizeOwnerNotifications } from '../src/owner-notifications.js';

// Synthetic JSON only: no production config/memory, model, protocol or IO.
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node 22 required');
let checks = 0;
const clone = structuredClone;
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const check = (a, label) => { assert(a, label); checks++; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HOST = { verifiedOwnerIds: ['21001'], verifiedAccountIds: ['alpha'] };
const qzone = () => ({ enabled: true, mode: 'reviewed', ugcRight: 64, allowedAudiences: [64],
  reviewTransport: 'qq_owner', publish: { enabled: true, maxDaily: 1, cooldownMs: 9_000_000 },
  reads: { feeds: false, own: true, maxDaily: 3 }, likes: { enabled: false, maxDaily: 0 },
  comments: { enabled: false }, autonomy: { enabled: false, maxContentLength: 120,
    sources: [{ kind: 'admin_topic', ref: 'fixture', content: '关于春天的小想法' }] } });
function account(id = 'alpha') {
  return { id, qq: id === 'alpha' ? '51001' : '51002', enabled: true, protocolEnabled: true,
    scope: { groups: true, private: true, groupMode: 'allowlist', groupIds: ['31001'] },
    features: { chat: true, task: true, proactive: true }, sendTypes: { text: true, image: true, record: false },
    displayName: '已有名字', selfName: '原有自称', style: { systemPrompt: '保留原有人格与边界。' },
    promptOverride: '保留既有覆盖', modelBindings: { chat: 'fixture-chat', task: 'fixture-task', vision: 'fixture-vision' },
    voice: { mode: 'off' }, socialAgent: { enabled: true, shadowMode: false, conversationIds: ['group:31001'],
      profile: { identity: '固定人格', interests: '摄影', expression: '原有表达' }, maxDailyCalls: 7, maxToolCalls: 1,
      turnTimeoutMs: 12000, crossConversation: { enabled: false, groupIds: [], userIds: [] },
      discovery: { conversationIds: ['group:31001'], maxRoundsPerDay: 1, maxSharesPerDay: 0 } },
    socialExperience: { enabled: true, shadowMode: false, conversationIds: ['group:31001'],
      expression: { maxMessages: 1 }, stickers: { cooldownMs: 900000, maxDailySearches: 1 } }, qzone: qzone() };
}
function base() {
  return { privateChats: { enabled: true, ownerUserIds: ['21001'], targetUsers: ['21001'] }, targetGroups: ['31001'],
    accounts: { version: 2, items: [account()], failoverGroups: [] },
    taskMode: { enabled: true, shadowMode: false, allowedGroupIds: ['31001'], ownerUserIds: [], maxTurns: 8,
      maxRuntimeMs: 90000, defaultToolsets: ['web', 'todo'], allowedWebDomains: ['example.invalid'],
      maxArtifactBytes: 1048576 },
    ownerNotifications: { enabled: true, recipients: ['21001'], times: ['09:00', '21:00'], timezone: 'Asia/Shanghai' },
    apiCenter: { selected: 'bound', connections: [{ id: 'fixture', secretRef: 'fixture-keychain-reference' }] },
    ai: { model: 'fixture-legacy-chat', reasoningEffort: 'low', apiKey: 'fake-SYNTHETIC_SECRET_SENTINEL' },
    persona: { name: '已有角色' }, prompt: { system: '原有系统提示' }, voice: { enabled: false },
    memory: { people: { enabled: true }, maxUserFacts: 12 }, budgets: { tokens: 5000 } };
}
const item = c => c.accounts.items[0];
const migrate = (c, opts = HOST) => migrateAutonomousSocialConfig(c, opts);
const scopeKeys = new Set(['scope', 'conversationIds', 'crossConversation', 'targetGroups', 'targetUsers',
  'ownerUserIds', 'allowedGroupIds', 'allowedTargets', 'recipients', 'allowedAudiences', 'ugcRight', 'sources']);
function scopes(c) {
  const found = [];
  function walk(v, path) {
    if (!v || typeof v !== 'object') return;
    for (const [k, value] of Object.entries(v)) {
      const next = `${path}.${k}`;
      if (scopeKeys.has(k)) found.push([next, value]); else walk(value, next);
    }
  }
  walk(c, 'config'); return hash(found);
}
function protectedValues(c) {
  return { ai: c.ai, apiCenter: c.apiCenter, persona: c.persona, prompt: c.prompt, voice: c.voice,
    taskMode: c.taskMode, memory: c.memory, budgets: c.budgets,
    accounts: c.accounts.items.map(a => ({ enabled: a.enabled, protocolEnabled: a.protocolEnabled,
      features: a.features, sendTypes: a.sendTypes, modelBindings: a.modelBindings, style: a.style,
      displayName: a.displayName, selfName: a.selfName, promptOverride: a.promptOverride, voice: a.voice,
      profile: a.socialAgent?.profile, maxDailyCalls: a.socialAgent?.maxDailyCalls,
      maxToolCalls: a.socialAgent?.maxToolCalls, timeout: a.socialAgent?.turnTimeoutMs,
      maxRounds: a.socialAgent?.discovery?.maxRoundsPerDay, maxShares: a.socialAgent?.discovery?.maxSharesPerDay,
      expressionMax: a.socialExperience?.expression?.maxMessages,
      stickerCooldown: a.socialExperience?.stickers?.cooldownMs, stickerSearches: a.socialExperience?.stickers?.maxDailySearches })) };
}
const original = base(), before = clone(original), first = migrate(original);
check(first.ok && first.changed, 'verified owner + enabled real account installs');
equal(original, before, 'pure: input unchanged');
equal(first.config.autonomousSocial, { version: 1, enabled: true, guidance: true, delegation: true,
  reconstruction: true, optOut: false, paused: false }, 'single seven-field master');
check(!Object.hasOwn(first.config, 'task35') && !Object.hasOwn(first.config, 'ownerSocial'), 'no duplicate controller/task section');
equal(AUTONOMOUS_SOCIAL_NEW_OPTIONS.length, 7, 'seven new options only');
check(AUTONOMOUS_SOCIAL_NEW_OPTIONS.length <= 32, 'under user option cap');
equal(scopes(first.config), scopes(original), 'all scopes/contact lists/audiences/source references hash equal');
equal(protectedValues(first.config), protectedValues(original), 'models/persona/sendTypes/budgets unchanged');
check(item(first.config).socialAgent.enabled && !item(first.config).socialAgent.shadowMode, 'existing live social mode preserved');
check(item(first.config).socialAgent.roleCard.enabled && item(first.config).socialAgent.roleCard.autoGrow, 'missing role card defaults');
check(item(first.config).socialAgent.agency.enabled, 'missing agency default');
check(item(first.config).socialAgent.discovery.enabled && !item(first.config).socialAgent.discovery.shadowMode, 'existing discovery scope reused');
check(item(first.config).socialExperience.stickers.autonomousSelection, 'missing scoped sticker defaults');
equal(item(first.config).qzone.mode, 'scoped_autonomy', 'reviewed explicit authority upgraded');
check(item(first.config).qzone.autonomy.enabled, 'specific authorization covers old autonomy false');
equal(item(first.config).qzone.allowedAudiences, item(original).qzone.allowedAudiences, 'QZone audiences exact');
equal(item(first.config).qzone.ugcRight, item(original).qzone.ugcRight, 'QZone actual visibility exact');
equal(item(first.config).qzone.reads, item(original).qzone.reads, 'private feed/read policy exact');
equal(item(first.config).qzone.likes, item(original).qzone.likes, 'no old false likes enabled');
equal(item(first.config).qzone.comments, item(original).qzone.comments, 'no old false comments enabled');
check(validateQzonePolicy(item(first.config).qzone).autonomy.enabled, 'actual QZone normalizer accepts result');
equal(first.config.ownerNotifications.times, ['09:00', '21:00'], '09/21 preserved');
check(normalizeOwnerNotifications(first.config.ownerNotifications).enabled, 'existing notification normalizer accepts');
check(first.report.unavailable.some(r => r.reason === 'CAPABILITY_NOT_ATTESTED'), 'unknown capability stays unavailable');
check(!JSON.stringify(first.report).includes('SYNTHETIC_SECRET') && !JSON.stringify(first.report).includes('21001')
  && !JSON.stringify(first.report).includes('原有系统提示'), 'report contains no secrets/IDs/persona');
const second = migrate(first.config);
check(second.ok && !second.changed, 'idempotent');
equal(second.config, first.config, 'second pass byte-equivalent JSON');
equal(second.report.status, 'already-migrated', 'once-only marker');
const edited = clone(first.config); delete item(edited).socialAgent.agency;
item(edited).socialAgent.roleCard.enabled = false;
equal(migrate(edited).config, edited, 'never re-default later deletion/opt-out');
first.config.ai.model = 'detached'; equal(original.ai.model, before.ai.model, 'output detached');

// Only configured private owner IDs narrowed by a verified host list qualify.
for (const [label, mutate, options] of [
  ['no host verification', () => {}, {}],
  ['no configured owner', c => { c.privateChats.ownerUserIds = []; }, HOST],
  ['fake task owner', c => { c.privateChats.ownerUserIds = []; c.taskMode.ownerUserIds = ['21001']; }, HOST],
  ['fake group admin', c => { c.privateChats.ownerUserIds = []; c.commands = { adminUserIds: ['21001'] }; }, HOST],
  ['foreign verified owner', () => {}, { ...HOST, verifiedOwnerIds: ['21002'] }],
  ['no verified account', () => {}, { ...HOST, verifiedAccountIds: [] }],
  ['unconfigured verified account', () => {}, { ...HOST, verifiedAccountIds: ['beta'] }],
  ['account disabled', c => { item(c).enabled = false; }, HOST],
  ['account absent enabled', c => { delete item(c).enabled; }, HOST],
  ['account paused', c => { item(c).paused = true; }, HOST],
  ['account frozen', c => { item(c).frozen = true; }, HOST],
  ['account opt-out', c => { item(c).optOut = true; }, HOST],
  ['account protocol disabled', c => { item(c).protocolEnabled = false; }, HOST],
  ['account archived', c => { item(c).archived = true; }, HOST],
]) {
  const c = base(); mutate(c); const snapshot = clone(c), result = migrate(c, options);
  check(result.ok && !result.changed, label); equal(result.config, snapshot, `${label}: no enabling`);
}
const legacyOwner = base(); legacyOwner.privateChats.instructionUserIds = legacyOwner.privateChats.ownerUserIds;
delete legacyOwner.privateChats.ownerUserIds;
check(migrate(legacyOwner).changed, 'legacy owner spelling only if canonical absent');
const emptyCanonical = clone(legacyOwner); emptyCanonical.privateChats.ownerUserIds = [];
check(!migrate(emptyCanonical).changed, 'canonical empty list never falls through to legacy owners');
for (const value of [true, '21001', ['*'], ['0'], ['abc'], [21001], ['21001', '21001']]) {
  const result = migrate(base(), { ...HOST, verifiedOwnerIds: value });
  check(!result.ok && !result.changed, 'invalid verified owner IDs fail closed');
}
for (const value of [['*'], ['__proto__'], ['constructor'], ['../alpha'], ['alpha', 'alpha'], [22], true]) {
  const result = migrate(base(), { ...HOST, verifiedAccountIds: value });
  check(!result.ok && !result.changed, 'invalid verified account IDs fail closed');
}
const badConfigured = base(); item(badConfigured).id = '../bad-SYNTHETIC_SECRET';
check(!migrate(badConfigured).changed, 'invalid configured IDs do not become accounts');
check(!JSON.stringify(migrate(badConfigured).report).includes('SYNTHETIC_SECRET'), 'invalid IDs not echoed in report');
const noAccounts = base(); delete noAccounts.accounts;
check(!migrate(noAccounts).changed, 'missing registry never creates a primary');
const duplicateAccounts = base(); duplicateAccounts.accounts.items.push(clone(item(duplicateAccounts)));
check(!migrate(duplicateAccounts).changed, 'duplicate configured account IDs ambiguous');

// Explicit denial and observation-only state win, including nested controls.
for (const key of ['enabled', 'guidance', 'delegation', 'reconstruction']) {
  const c = base(); c.autonomousSocial = { [key]: false };
  const result = migrate(c);
  equal(result.config.autonomousSocial[key], false, `master ${key}: false preserved`);
  if (key === 'enabled') check(!result.changed, 'master off does not migrate account or QZone');
}
for (const flags of [{ optOut: true }, { paused: true }, { frozen: true }, { version: 2 }, { version: '1' }]) {
  const c = base(); c.autonomousSocial = flags; const result = migrate(c);
  check(result.ok && !result.changed, 'master denial/future/invalid preserved'); equal(result.config, c, 'no downgrade or implicit opt-in');
}
const stoppedPaths = [
  ['socialAgent', { enabled: false }], ['socialAgent', { paused: true }], ['socialAgent', { frozen: true }],
  ['socialAgent', { optOut: true }], ['socialAgent', { shadowMode: true }],
  ['socialExperience', { enabled: false }], ['socialExperience', { frozen: true }], ['socialExperience', { shadowMode: true }],
];
for (const [section, fields] of stoppedPaths) {
  const c = base(); Object.assign(item(c)[section], fields); const expected = clone(item(c)[section]);
  const result = migrate(c); equal(item(result.config)[section], expected, `${section}: explicit fence`);
  check(result.report.keptDisabled.some(r => r.path.endsWith(section)), 'fence reported');
}
for (const [section, leaf, fields] of [
  ['socialAgent', 'roleCard', { enabled: false }], ['socialAgent', 'roleCard', { frozen: true }],
  ['socialAgent', 'roleCard', { autoGrow: false }], ['socialAgent', 'agency', { enabled: false }],
  ['socialAgent', 'discovery', { enabled: false }], ['socialExperience', 'stickers', { enabled: false }],
  ['socialExperience', 'stickers', { autoSend: false, autonomousSelection: false, groupLearning: false }],
]) {
  const c = base(); item(c)[section][leaf] = { ...(item(c)[section][leaf] || {}), ...fields };
  const result = migrate(c);
  for (const [k, value] of Object.entries(fields)) equal(item(result.config)[section][leaf][k], value, 'nested false/frozen remains');
}
const stoppedTask = base(); stoppedTask.taskMode.enabled = false;
equal(migrate(stoppedTask).config.taskMode, stoppedTask.taskMode, 'taskMode enabled false + all budgets untouched');
const noImages = base(); item(noImages).sendTypes.image = false;
equal(item(migrate(noImages).config).socialExperience.stickers, item(noImages).socialExperience.stickers, 'image gate prevents default sticker enabling');
const noChat = base(); item(noChat).features.chat = false;
equal(item(migrate(noChat).config).socialAgent, item(noChat).socialAgent, 'chat off prevents social defaults');

// Never create, expand, backfill or repair conversation / contact scopes.
for (const alter of [
  c => { delete item(c).socialAgent.conversationIds; delete item(c).socialExperience.conversationIds; },
  c => { item(c).socialAgent.conversationIds = []; item(c).socialExperience.conversationIds = []; },
  c => { item(c).socialAgent.conversationIds = ['*']; item(c).socialExperience.conversationIds = ['all']; },
  c => { item(c).socialAgent.conversationIds = ['group:31002']; item(c).socialExperience.conversationIds = ['group:31002']; },
  c => { item(c).scope.groups = false; },
]) {
  const c = base(); alter(c); const scopeHash = scopes(c), result = migrate(c);
  equal(scopes(result.config), scopeHash, 'unconfigured/malformed/unauthorized scope never rewritten');
  check(!item(result.config).socialAgent.roleCard, 'no rolecard defaults without existing eligible conversation scope');
  check(result.report.unavailable.some(r => r.reason === 'NO_VALID_EXISTING_CONVERSATION_SCOPE'), 'scope uncertainty reported');
}
const scopeLess = base(); delete item(scopeLess).socialAgent; delete item(scopeLess).socialExperience;
const scopeLessOut = migrate(scopeLess);
check(!item(scopeLessOut.config).socialAgent && !item(scopeLessOut.config).socialExperience, 'no policy containers or implicit all groups');
const undiscovered = base(); delete item(undiscovered).socialAgent.discovery.conversationIds;
equal(item(migrate(undiscovered).config).socialAgent.discovery, item(undiscovered).socialAgent.discovery, 'discovery scope never inherited as new grant');

// QZone exact qualification matrix: no draft-only/disabled/invalid/audience default upgrade.
for (const [label, change] of [
  ['root disabled', q => { q.enabled = false; }], ['publish disabled', q => { q.publish.enabled = false; }],
  ['root absent enabled', q => { delete q.enabled; }], ['publish absent enabled', q => { delete q.publish.enabled; }],
  ['draft only', q => { q.mode = 'draft_only'; }], ['no explicit mode', q => { delete q.mode; }],
  ['no explicit audience', q => { delete q.allowedAudiences; }], ['no explicit visibility', q => { delete q.ugcRight; }],
  ['invalid audience', q => { q.allowedAudiences = [0]; }], ['mismatched visibility', q => { q.ugcRight = 4; }],
  ['duplicate audience', q => { q.allowedAudiences = [64, 64]; }], ['unknown audience', q => { q.allowedAudiences = ['all']; }],
  ['autonomy opted out', q => { q.autonomy.optOut = true; }], ['autonomy frozen', q => { q.autonomy.frozen = true; }],
  ['autonomy paused', q => { q.autonomy.paused = true; }], ['root frozen', q => { q.frozen = true; }],
]) {
  const c = base(); change(item(c).qzone); const expected = clone(item(c).qzone), result = migrate(c);
  equal(item(result.config).qzone, expected, `QZone ${label}: untouched`);
}
for (const audience of [[1], [4, 64], [64, 4, 1]]) {
  const c = base(); item(c).qzone.allowedAudiences = audience; item(c).qzone.ugcRight = audience[0];
  const result = migrate(c);
  equal(item(result.config).qzone.allowedAudiences, audience, 'legal current audience order/list never expanded');
  equal(item(result.config).qzone.ugcRight, audience[0], 'legal visibility unchanged');
  equal(item(result.config).qzone.mode, 'scoped_autonomy', 'only reviewed existing audience transitions');
}
const missingQzone = base(); delete item(missingQzone).qzone;
check(!item(migrate(missingQzone).config).qzone, 'missing QZone never enabled');
const noCaps = migrate(base(), { ...HOST, capabilitiesByAccount: { alpha: { qzonePublish: false, stickers: false } } });
equal(item(noCaps.config).qzone.mode, 'scoped_autonomy', 'standing policy preference independent of transport availability');
check(noCaps.report.unavailable.some(r => r.path.endsWith('qzone') && r.reason === 'CAPABILITY_UNAVAILABLE'), 'unavailable protocol reported honestly');
check(!JSON.stringify(noCaps.report).includes('"available":true'), 'no configuration success represented as protocol success');

// Notification cadence/recipients remain exact, including custom/disabled configs.
for (const n of [{ enabled: true, times: ['06:15', '22:45'], timezone: 'UTC', recipients: ['21001'] },
  { enabled: false, times: ['09:00'], timezone: 'Asia/Shanghai' },
  { enabled: true, times: ['invalid'], recipients: ['21001'] }]) {
  const c = base(); c.ownerNotifications = n;
  equal(migrate(c).config.ownerNotifications, n, 'existing notification settings not repaired or reset');
}
const absentNotifications = base(); delete absentNotifications.ownerNotifications;
equal(migrate(absentNotifications).config.ownerNotifications, { times: ['09:00', '21:00'], timezone: 'Asia/Shanghai' },
  'missing times default without inventing recipients or delivery authority');

// Registry ownership, failover policy inheritance and unverified peers.
const peers = base(); peers.accounts.items.push(account('beta'));
const betaBefore = clone(peers.accounts.items[1]);
equal(migrate(peers).config.accounts.items[1], betaBefore, 'unverified independent peer untouched');
const shared = base(); shared.accounts.items.push(account('beta'));
shared.accounts.failoverGroups = [{ id: 'pair', memberIds: ['alpha', 'beta'], policyAccountId: 'alpha',
  policy: { scope: clone(item(shared).scope) } }];
const unverifiedShared = migrate(shared);
equal(unverifiedShared.config.accounts, shared.accounts, 'shared identity not upgraded through one verified carrier');
check(unverifiedShared.report.unavailable.some(r => r.reason === 'SHARED_IDENTITY_REQUIRES_ALL_MEMBERS_VERIFIED'), 'shared identity blocker explicit');
const sharedOut = migrate(shared, { ...HOST, verifiedAccountIds: ['alpha', 'beta'] });
check(item(sharedOut.config).socialAgent.roleCard.enabled, 'all verified shared members permit inherited source defaults');
equal(scopes(sharedOut.config), scopes(shared), 'no materialized copies of inherited scopes');
equal(sharedOut.config.accounts.items[1].socialAgent, shared.accounts.items[1].socialAgent, 'shared source not duplicated into peer');
const sharedExplicit = clone(shared); sharedExplicit.accounts.failoverGroups[0].policy.socialAgent = clone(item(shared).socialAgent);
sharedExplicit.accounts.failoverGroups[0].policy.socialAgent.roleCard = { enabled: false };
const sharedExplicitOut = migrate(sharedExplicit, { ...HOST, verifiedAccountIds: ['alpha', 'beta'] });
equal(sharedExplicitOut.config.accounts.failoverGroups[0].policy.socialAgent.roleCard.enabled, false, 'explicit shared false wins');
equal(item(sharedExplicitOut.config).socialAgent, item(sharedExplicit).socialAgent, 'do not patch ineffective member social policy');
const aliased = base(); aliased.accounts.items.push(account('beta'));
aliased.accounts.items[1].socialAgent = item(aliased).socialAgent;
equal(migrate(aliased).config.accounts.items[1].socialAgent, aliased.accounts.items[1].socialAgent,
  'shared JS template references cannot mutate an independent unverified peer');
const legacy = base(); const old = legacy.accounts.items;
legacy.accounts = { primary: old[0], standbys: [account('beta')], topology: 'failover' };
const legacyOut = migrate(legacy, { ...HOST, verifiedAccountIds: ['alpha', 'beta'] });
check(legacyOut.ok && legacyOut.config.accounts.primary.socialAgent.roleCard.enabled, 'legacy failover source owner supported');
equal(legacyOut.config.accounts.standbys, legacy.accounts.standbys, 'legacy standby not modified');

// Future-account starter is explicit, default-only, own scoped profile; no QZone upgrade.
for (const profile of ['observant', 'balanced', 'engaged']) {
  const c = base(); c.autonomousSocial = { version: 1, enabled: true, guidance: true, delegation: true, reconstruction: true, optOut: false, paused: false };
  const options = { ...HOST, accountId: 'alpha', profile }, out = createAutonomousSocialStarter(c, options);
  check(out.ok, `starter ${profile}`);
  equal(out.config.autonomousSocial, c.autonomousSocial, 'starter never changes global master');
  equal(item(out.config).socialExperience.behaviorPreset, profile, 'independent explicit profile');
  equal(item(out.config).qzone, item(c).qzone, 'future profile is NOT future QZone standing authorization');
  equal(scopes(out.config), scopes(c), 'starter no scope changes');
  check(!createAutonomousSocialStarter(out.config, options).changed, 'starter idempotent/default only');
}
const allScope = base(); item(allScope).scope.groupMode = 'all';
const allStarter = createAutonomousSocialStarter(allScope, { ...HOST, accountId: 'alpha', profile: 'balanced' });
check(allStarter.ok && !allStarter.changed, 'starter refuses all-groups scope');
const invalidStarter = createAutonomousSocialStarter(base(), { ...HOST, accountId: 'alpha', profile: 'all' });
check(!invalidStarter.ok, 'starter unknown profile rejected');

// Independent sanitizer normalizer: partial patches never install extra flags.
equal(normalizeAutonomousSocialPolicy({ delegation: false }, { partial: true }), { delegation: false }, 'partial patch exact');
equal(normalizeAutonomousSocialPolicy().enabled, false, 'absent read policy off');
equal(normalizeAutonomousSocialPolicy(first.config.autonomousSocial), first.config.autonomousSocial, 'installed master accepted');
for (const value of [null, [], { enabled: 'true' }, { version: 2 }, { budget: {} }, { task35: {} },
  { delegation: 1 }, { reconstruction: null }, JSON.parse('{"__proto__":{}}')]) {
  assert.throws(() => normalizeAutonomousSocialPolicy(value)); checks++;
}
let getters = 0;
const accessor = {}; Object.defineProperty(accessor, 'enabled', { enumerable: true, get() { getters++; return true; } });
assert.throws(() => normalizeAutonomousSocialPolicy(accessor)); checks++;
equal(getters, 0, 'normalizer never executes getters');
const malicious = base(); Object.defineProperty(malicious, 'secretGetter', { enumerable: true, get() { getters++; return 'secret'; } });
const maliciousOut = migrate(malicious);
check(!maliciousOut.ok && !maliciousOut.changed, 'malformed config fails atomically'); equal(getters, 0, 'config getter not evaluated');
const future = base(); future.accounts.version = 3;
check(!migrate(future).ok, 'unknown account schema not downgraded');
const inputSnapshot = clone(base()), invalidRegistry = clone(inputSnapshot);
invalidRegistry.accounts.failoverGroups = [{ id: 'x', memberIds: ['missing'], policy: {} }];
check(!migrate(invalidRegistry).ok, 'invalid membership fails closed');
equal(inputSnapshot, base(), 'no test mutation of source fixture');

console.log(JSON.stringify({ ok: true, checks, node: process.versions.node, newOptions: AUTONOMOUS_SOCIAL_NEW_OPTIONS.length,
  productionIO: false, modelCalls: 0, realQQ: false }));
