// Owner First 3.4 — self-test for src/owner-first-migration.js.
//
// Pure fixtures only: this script never reads config.json, data/memory.json,
// logs, or any runtime state, and never calls a model, a network endpoint or QQ.
// Every case builds a small config literal and asserts on the pure result.
//
// Run: PATH=/opt/homebrew/opt/node@22/bin node scripts/owner-first-migration-self-test.js

import assert from 'node:assert/strict';
import { migrateOwnerFirstConfig, previewOwnerFirstMigration, OWNER_FIRST_VERSION,
  OWNER_FIRST_PENDING_SCHEMA_FIELDS } from '../src/owner-first-migration.js';
import { normalizeOwnerControl } from '../src/owner-services.js';
import { normalizeOwnerNotifications } from '../src/owner-notifications.js';

let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message) || checks++;
const code = (fn, expected, message) => {
  try { fn(); } catch (error) { check(error.code === expected || new RegExp(expected).test(error.message), message); return; }
  check(false, `${message} (expected throw)`);
};

const OWNER = '2435193119';
const OTHER = '2888888888';

/** Live-shaped baseline: legacy template, no owner-first surfaces at all. */
const baseConfig = () => ({
  targetGroups: ['*'],
  accounts: {
    primary: { id: 'primary', qq: '2148672836', enabled: true, protocolEnabled: true },
    standbys: [{ id: 'standby-a', qq: '2148672837', enabled: true, protocolEnabled: true }]
  },
  privateChats: { enabled: true, targetUsers: ['*'], ownerUserIds: [OWNER] },
  adminNotifications: { enabled: true, recipients: [OWNER], periodicStatusEnabled: true, periodicStatusIntervalMs: 1800000 },
  hourlyChat: { enabled: true, checkIntervalMs: 3600000, ownerUserIds: [OWNER], prompt: '旧的小时私聊提示词' },
  dailyMessages: { enabled: true, checkIntervalMs: 60000, windowMinutes: 10, requireKnownGroup: true, schedules: [
    { id: 'morning', enabled: true, time: '08:30', prompt: '早上好，今天也要开心' },
    { id: 'evening', enabled: true, time: '23:00', prompt: '今天大家辛苦了' },
    { id: 'summary', enabled: true, time: '23:30', prompt: '总结一下今天', requireHistory: true }
  ] },
  memory: { enabled: true, people: { enabled: false } },
  apiCenter: { version: 1, connections: [{ id: 'main', baseUrl: 'https://example.invalid', apiKeyEnv: 'HERMES_KEY' }],
    features: { chat: { connectionId: 'main', model: 'chat-model-x' }, task: { connectionId: 'main', model: 'task-model-y' } } },
  persona: { displayName: '测试机器人', systemPrompt: '你是一个安静的群成员' },
  budget: { maxDailyCalls: 250, maxToolCalls: 3 },
  voice: { enabled: false, mode: 'inherit' }
});

const allGroups = (...ids) => ({ primary: ids, 'standby-a': ids });
const targetsOf = (config) => config.ownerControl.allowedTargets.map((row) => `${row.accountId}:${row.groupId}`).sort();

// ── 1. No owner: nothing is enabled, nothing else is touched ─────────────────
{
  const config = baseConfig();
  config.privateChats.ownerUserIds = [];
  const before = structuredClone(config);
  const { changed, config: after, report } = migrateOwnerFirstConfig(config, { verifiedGroupsByAccount: allGroups('31001', '31002') });
  equal(changed, false, 'no real owner => no change at all');
  equal(after, before, 'no owner leaves the config byte-identical');
  equal(report.status, 'no-owner', 'status names the missing owner');
  equal(report.owner.verifiedOwnerCount, 0, 'no verified owner count');
  for (const surface of ['memory.people', 'ownerControl', 'ownerNotifications']) {
    check(report.surfaces[surface] === 'no-owner', `no owner keeps ${surface} off`);
  }
  check(after.ownerControl === undefined, 'no owner does not create ownerControl');
  check(after.ownerNotifications === undefined, 'no owner does not create ownerNotifications');
  check(after.adminNotifications.enabled === true, 'no owner keeps legacy admin reports');
  check(after.hourlyChat.enabled === true, 'no owner keeps legacy hourly routine');
  check(report.warnings.some((w) => w.code === 'OWNER_FIRST_NO_OWNER'), 'no owner is reported');
}

// Admin recipients are not owner proof: a config whose only "owner-ish" field is
// adminNotifications.recipients must not promote anyone to owner.
{
  const config = baseConfig();
  config.privateChats.ownerUserIds = [];
  const { changed, config: after } = migrateOwnerFirstConfig(config, { ownerIds: [OWNER] });
  equal(changed, false, 'admin recipients and host hint are not owner proof');
  check(after.ownerControl === undefined, 'no invented ownerControl from admin recipients');
}

// ── 2. Real owner: the documented surfaces turn on ──────────────────────────
let migrated;
{
  const { changed, config, report } = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001', '31002') });
  check(changed, 'real owner => the upgrade applies');
  equal(report.status, 'applied', 'status applied');
  migrated = config;

  equal(config.memory.people.enabled, true, 'memory.people enabled for a real owner');
  equal(config.ownerControl.enabled, true, 'ownerControl.enabled');
  equal(config.ownerControl.naturalLanguage, true, 'ownerControl.naturalLanguage');
  equal(config.ownerControl.usageEnabled, true, 'ownerControl.usageEnabled');
  equal(config.ownerControl.lowRiskDirect, true, 'ownerControl.lowRiskDirect');
  equal(config.ownerNotifications.enabled, true, 'ownerNotifications.enabled');
  equal(config.ownerNotifications.timezone, 'Asia/Shanghai', 'ownerNotifications timezone Asia/Shanghai');
  equal(config.ownerNotifications.times, ['09:00', '21:00'], 'ownerNotifications default 09:00/21:00');
  equal(config.ownerNotifications.recipients, [OWNER], 'notification recipients are the real owner');
  equal(config.ownerFirst.version, OWNER_FIRST_VERSION, 'migration metadata version 1');
  equal(config.ownerFirst.ownerSource, 'privateChats.ownerUserIds', 'metadata names the real owner source');

  // Emitted authority must satisfy the real runtime validators, not a private copy.
  check(normalizeOwnerControl(config.ownerControl).enabled, 'emitted ownerControl passes the real normalizer');
  check(normalizeOwnerNotifications(config.ownerNotifications).enabled, 'emitted ownerNotifications passes the real normalizer');
  // CHANGED SEMANTICS (was: "targetMode must stay out of live authority"):
  // `targetMode` is now part of the accepted schema, so it is written for real
  // and must round-trip. The old assertion blessed coordination drift.
  equal(config.ownerControl.targetMode, 'explicit', 'targetMode is written and concrete resolution reports explicit');
  check(normalizeOwnerControl(config.ownerControl).targetMode === 'explicit', 'emitted targetMode passes the real normalizer');
  equal(report.pendingSchemaFields, [], 'nothing is deferred once the schema accepts the field');

  // Derived targets come from evidence + scope only.
  equal(targetsOf(config), [`primary:31001`, `primary:31002`, 'standby-a:31001', 'standby-a:31002'], 'targets derived for both eligible accounts');
  equal(report.targets.mode, 'concrete', 'target resolution mode is concrete');
}

// ── 3. Idempotency: the second run is a no-op ───────────────────────────────
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001', '31002') };
  const second = migrateOwnerFirstConfig(migrated, evidence);
  equal(second.changed, false, 'second run changes nothing');
  equal(second.report.status, 'noop', 'second run reports noop');
  equal(second.config, migrated, 'second run is deep-equal to its input');
  equal(second.report.changedPaths, [], 'second run has no changed paths');
  const third = migrateOwnerFirstConfig(second.config, evidence);
  equal(third.changed, false, 'third run also stable');
  check(structuredClone(migrated) !== migrated && migrateOwnerFirstConfig(migrated, evidence).changed === false,
    'idempotent without mutating the caller config');
  // Input is never mutated, even on the first run.
  const pristine = baseConfig();
  const snapshot = structuredClone(pristine);
  migrateOwnerFirstConfig(pristine, evidence);
  equal(pristine, snapshot, 'the input config object is never mutated');
}

// ── 4. Strict per-account scopes are intersected, never expanded ────────────
{
  const config = baseConfig();
  config.accounts.primary.scope = { groups: true, groupMode: 'allowlist', groupIds: ['31001'] };
  config.accounts.standbys[0].scope = { groups: true, groupMode: 'allowlist', groupIds: ['31999'] };
  const { config: after, report } = migrateOwnerFirstConfig(config, { verifiedGroupsByAccount: allGroups('31001', '31002') });
  equal(targetsOf(after), ['primary:31001'], 'allowlist caps candidates; a group outside the scope never appears');
  check(report.targets.droppedOutsideScope === 0 && report.targets.derived === 1, 'only the in-scope pair is derived');

  // A stricter "text send off" account contributes nothing.
  const noText = baseConfig();
  noText.accounts.standbys[0].sendTypes = { text: false };
  equal(targetsOf(migrateOwnerFirstConfig(noText, { verifiedGroupsByAccount: allGroups('31001') }).config), ['primary:31001'],
    'an account without text send eligibility contributes no target');

  // An account whose group scope is switched off contributes nothing.
  const noGroups = baseConfig();
  noGroups.accounts.primary.scope = { groups: false };
  equal(targetsOf(migrateOwnerFirstConfig(noGroups, { verifiedGroupsByAccount: allGroups('31001') }).config), ['standby-a:31001'],
    'group scope off removes the account from derivation');
}

// ── 5. Explicit non-empty allowedTargets win (intersect, not expand) ───────
{
  const config = baseConfig();
  config.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] };
  const { config: after, report } = migrateOwnerFirstConfig(config, { verifiedGroupsByAccount: allGroups('31001', '31002') });
  equal(targetsOf(after), ['primary:31001'], 'explicit allowedTargets is kept, not broadened to every joined group');
  equal(report.targets.mode, 'configured', 'a narrowed explicit list is not reported as fully derived');

  // An explicit pair that evidence explicitly denies (not joined) is dropped.
  const stale = baseConfig();
  stale.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'primary', groupId: '31001' }, { accountId: 'primary', groupId: '31999' }] };
  const dropped = migrateOwnerFirstConfig(stale, { verifiedGroupsByAccount: allGroups('31001') });
  equal(targetsOf(dropped.config), ['primary:31001'], 'a stale pair the account is not in is dropped');
  equal(dropped.report.targets.droppedOutsideDerivation, 1, 'the dropped pair is counted');

  // Without any evidence the explicit list survives untouched.
  const unknown = baseConfig();
  unknown.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] };
  equal(targetsOf(migrateOwnerFirstConfig(unknown).config), ['primary:31001'], 'no evidence keeps explicit readable targets');
}

// ── 6. Deny list: restrictions only ────────────────────────────────────────
{
  const config = baseConfig();
  config.blockedGroups = ['31002'];
  const { config: after, report } = migrateOwnerFirstConfig(config, { verifiedGroupsByAccount: allGroups('31001', '31002') });
  equal(targetsOf(after), ['primary:31001', 'standby-a:31001'], 'a denied group is never derived as a target');
  check(report.targets.deniedListPresent, 'deny list presence is reported');

  const perAccount = baseConfig();
  perAccount.blockedGroups = { primary: ['31001'], 'standby-a': [] };
  equal(targetsOf(migrateOwnerFirstConfig(perAccount, { verifiedGroupsByAccount: allGroups('31001', '31002') }).config),
    ['primary:31002', 'standby-a:31001', 'standby-a:31002'], 'a per-account deny list blocks only that account/group pair');

  // A deny entry that already exists in allowedTargets is removed.
  const explicit = baseConfig();
  explicit.blockedGroups = ['31001'];
  explicit.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] };
  equal(targetsOf(migrateOwnerFirstConfig(explicit, { verifiedGroupsByAccount: allGroups('31001') }).config), [],
    'a denied pair is removed from explicit targets too');

  // Unreadable deny list: fail closed instead of authorizing everything.
  const broken = baseConfig();
  broken.blockedGroups = { 'not an account id!': ['31001'] };
  const broken2 = migrateOwnerFirstConfig(broken, { verifiedGroupsByAccount: allGroups('31001') });
  equal(targetsOf(broken2.config), [], 'an unreadable deny list derives no new targets');
  check(broken2.report.warnings.some((w) => w.code === 'OWNER_FIRST_DENYLIST_UNSUPPORTED'), 'unsupported deny list is reported');

  // Absent deny list is honestly reported as absent, not as an empty allow.
  const none = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001') });
  check(none.report.warnings.some((w) => w.code === 'OWNER_FIRST_DENYLIST_ABSENT'), 'missing deny list is reported for the parent');
}

// ── 7. Archived / disabled accounts ────────────────────────────────────────
{
  const archived = baseConfig();
  archived.accounts.standbys[0].archived = true;
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  const result = migrateOwnerFirstConfig(archived, evidence);
  equal(targetsOf(result.config), ['primary:31001'], 'an archived account is never a target');

  const disabled = baseConfig();
  disabled.accounts.primary.enabled = false;
  equal(targetsOf(migrateOwnerFirstConfig(disabled, evidence).config), ['standby-a:31001'], 'a disabled account is never a target');

  const protocolOff = baseConfig();
  protocolOff.accounts.primary.protocolEnabled = false;
  equal(targetsOf(migrateOwnerFirstConfig(protocolOff, evidence).config), ['standby-a:31001'], 'a protocol-disabled account is never a target');

  const chatOff = baseConfig();
  chatOff.accounts.primary.features = { chat: false };
  equal(targetsOf(migrateOwnerFirstConfig(chatOff, evidence).config), ['standby-a:31001'], 'a chat-disabled account is never a target');

  // An archived account also loses its already-explicit targets.
  const archivedExplicit = baseConfig();
  archivedExplicit.accounts.standbys[0].archived = true;
  archivedExplicit.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'standby-a', groupId: '31001' }, { accountId: 'primary', groupId: '31001' }] };
  const pruned = migrateOwnerFirstConfig(archivedExplicit, evidence);
  equal(targetsOf(pruned.config), ['primary:31001'], 'archived account targets are pruned from config');
  equal(pruned.report.targets.droppedArchived, 1, 'the archived prune is counted');

  // No eligible account at all still keeps readable (inherited) metadata.
  const allArchived = baseConfig();
  allArchived.accounts.standbys[0].archived = true;
  allArchived.accounts.primary.archived = true;
  const empty = migrateOwnerFirstConfig(allArchived, evidence);
  equal(empty.config.ownerControl.allowedTargets, [], 'no eligible account => no concrete target');
  equal(empty.config.ownerFirst.targetResolution, 'inherited', 'unresolved targets stay in inherited mode');
}

// ── 8. Missing group evidence: derived mode, never "allow all membership" ──
{
  const noEvidence = migrateOwnerFirstConfig(baseConfig());
  equal(noEvidence.config.ownerControl.allowedTargets, [], 'absent evidence derives no concrete group');
  equal(noEvidence.config.ownerFirst.targetResolution, 'inherited', 'absent evidence keeps inherited target resolution');
  equal(noEvidence.config.ownerFirst.targetsUnresolvedReason, 'absent-evidence', 'the unresolved reason is readable');
  check(noEvidence.report.warnings.some((w) => w.code === 'OWNER_FIRST_GROUPS_ABSENT'), 'missing evidence is reported');
  equal(noEvidence.config.ownerControl.enabled, true, 'the control surface still turns on in inherited mode');

  // Evidence for one account only must not be extended to the other.
  const partial = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: { primary: ['31001'] } });
  equal(targetsOf(partial.config), ['primary:31001'], 'no group is invented for an account without evidence');
  equal(partial.report.targets.groupsUnknownAccounts, 1, 'the account without evidence is counted');

  // A verified-empty account is "no joined groups", not "unknown".
  const noneJoined = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: { primary: [], 'standby-a': [] } });
  equal(noneJoined.config.ownerControl.allowedTargets, [], 'verified-empty evidence yields no target');
  equal(noneJoined.config.ownerFirst.targetResolution, 'inherited', 'verified-empty keeps inherited mode');
  equal(noneJoined.report.targets.noJoinedGroupsAccounts, 2, 'verified-empty accounts are counted separately');

  // Malformed evidence must not be read as a wildcard.
  const malformed = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: { primary: ['not-a-group'] } });
  equal(malformed.config.ownerControl.allowedTargets, [], 'malformed evidence never becomes "all groups"');
  check(malformed.report.warnings.some((w) => w.code === 'OWNER_FIRST_GROUPS_UNSUPPORTED'), 'malformed evidence is reported');

  // An explicit host array form is accepted too.
  const arrayForm = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: [{ accountId: 'primary', groupIds: ['31003'] }] });
  equal(targetsOf(arrayForm.config), ['primary:31003'], 'array evidence form works');

  // targetGroups narrows derivation like any other real scope.
  const narrowed = baseConfig();
  narrowed.targetGroups = ['31001'];
  equal(targetsOf(migrateOwnerFirstConfig(narrowed, { verifiedGroupsByAccount: allGroups('31001', '31002') }).config),
    ['primary:31001', 'standby-a:31001'], 'targetGroups caps derived targets');

  // targetGroups empty/[] means "handle no group", not "all groups".
  const noGroups = baseConfig();
  noGroups.targetGroups = [];
  const off = migrateOwnerFirstConfig(noGroups, { verifiedGroupsByAccount: allGroups('31001') });
  equal(off.config.ownerControl.allowedTargets, [], 'empty targetGroups authorizes no group');
  check(off.report.warnings.some((w) => w.code === 'OWNER_FIRST_GROUP_SCOPE_DISABLED'), 'disabled group scope is reported');

  // Social/proactive conversation lists are not message-processing authority.
  const social = baseConfig();
  social.accounts.primary.socialAgent = { enabled: true, conversationIds: ['group:31001', 'group:31002'] };
  social.accounts.primary.socialExperience = { conversationIds: ['group:31003'] };
  const socialResult = migrateOwnerFirstConfig(social, { verifiedGroupsByAccount: allGroups('31001') });
  equal(targetsOf(socialResult.config), ['primary:31001', 'standby-a:31001'], 'social scope is never treated as authorized targets');
  equal(socialResult.report.ignoredScopes.map((row) => row.count), [2, 1], 'non-authoritative scopes are counted only');
}

// ── 9. Custom limits / times are preserved ────────────────────────────────
{
  const custom = baseConfig();
  custom.ownerNotifications = { enabled: false, timezone: 'America/Los_Angeles', times: ['07:30'] };
  const { config: after, report } = migrateOwnerFirstConfig(custom, { verifiedGroupsByAccount: allGroups('31001') });
  equal(after.ownerNotifications.enabled, true, 'custom notification config still turns on');
  equal(after.ownerNotifications.times, ['07:30'], 'a stricter single custom time survives verbatim');
  equal(after.ownerNotifications.timezone, 'America/Los_Angeles', 'an explicit custom timezone survives');
  equal(report.notifications.times, 'preserved-custom', 'a different hour is preserved as an explicit custom choice');

  // A strict subset of the defaults (one of the two points) is "stricter".
  const stricter = baseConfig();
  stricter.ownerNotifications = { enabled: false, times: ['09:00'] };
  const stricterResult = migrateOwnerFirstConfig(stricter, { verifiedGroupsByAccount: allGroups('31001') });
  equal(stricterResult.config.ownerNotifications.times, ['09:00'], 'a single default time is kept, never widened back to two');
  equal(stricterResult.report.notifications.times, 'preserved-stricter', 'a stricter subset is reported as stricter');

  const customTimes = baseConfig();
  customTimes.ownerNotifications = { enabled: false, times: ['06:15', '22:45'] };
  const kept = migrateOwnerFirstConfig(customTimes, { verifiedGroupsByAccount: allGroups('31001') });
  equal(kept.config.ownerNotifications.times, ['06:15', '22:45'], 'custom pair of times is preserved, not reset to default');
  equal(kept.config.ownerNotifications.timezone, 'Asia/Shanghai', 'missing timezone falls back to the documented default');

  // Invalid times cannot crash the upgrade and are honestly reported.
  const badTimes = baseConfig();
  badTimes.ownerNotifications = { enabled: false, times: ['9:00', '21:00'] };
  const fixed = migrateOwnerFirstConfig(badTimes, { verifiedGroupsByAccount: allGroups('31001') });
  equal(fixed.config.ownerNotifications.times, ['09:00', '21:00'], 'invalid times reset to the documented default');
  check(fixed.report.warnings.some((w) => w.code === 'OWNER_FIRST_TIMES_RESET'), 'the reset is reported');

  // Explicit usage opt-out and natural-language opt-out survive an already
  // migrated config where the owner enabled the control but denied these two.
  const optOut = baseConfig();
  optOut.ownerControl = { enabled: true, usageEnabled: false, naturalLanguage: false };
  optOut.ownerFirst = { version: OWNER_FIRST_VERSION };
  const keptOptOut = migrateOwnerFirstConfig(optOut, { verifiedGroupsByAccount: allGroups('31001') });
  equal(keptOptOut.config.ownerControl.usageEnabled, false, 'explicit usageEnabled:false is respected');
  equal(keptOptOut.config.ownerControl.naturalLanguage, false, 'explicit naturalLanguage:false is respected');
  check(keptOptOut.report.warnings.some((w) => w.code === 'OWNER_FIRST_USAGE_OPT_OUT_KEPT'), 'the usage opt-out is reported');
  // CHANGED SEMANTICS (was: warning only): the denial must actually be WRITTEN.
  check(normalizeOwnerControl(keptOptOut.config.ownerControl).usageEnabled === false,
    'usageEnabled:false survives the real normalizer instead of defaulting back on');
  check(normalizeOwnerControl(keptOptOut.config.ownerControl).naturalLanguage === false,
    'naturalLanguage:false survives the real normalizer');
}

// A switched-off surface after a finished upgrade is an owner decision; the
// shipped template default (first run only) is not. The two must be separable.
{
  const templateDefault = baseConfig();
  equal(templateDefault.memory.people.enabled, false, 'fixture starts at the template default false');
  equal(migrateOwnerFirstConfig(templateDefault, { verifiedGroupsByAccount: allGroups('31001') }).config.memory.people.enabled, true,
    'a first-run template default does not block the upgrade');

  const optedOut = baseConfig();
  optedOut.ownerFirst = { version: OWNER_FIRST_VERSION, optOuts: { people: true } };
  const respected = migrateOwnerFirstConfig(optedOut, { verifiedGroupsByAccount: allGroups('31001') });
  equal(respected.config.memory.people.enabled, false, 'a declared opt-out blocks re-enabling on a later run');
  check(respected.report.surfaces['memory.people'] === 'respected-opt-out', 'the respected opt-out is named');
  check(respected.config.ownerFirst.respectedOptOuts.includes('memory.people'), 'metadata records the respected opt-out');

  // A host-declared denial is the same thing through the API.
  const viaHost = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001'), optOuts: { ownerControl: true } });
  equal(viaHost.config.ownerControl.enabled, false, 'host-declared ownerControl opt-out is respected');
  equal(targetsOf(viaHost.config), ['primary:31001', 'standby-a:31001'], 'the opt-out keeps readable target metadata');
  equal(viaHost.config.ownerNotifications.enabled, true, 'an unrelated surface still turns on');

  // Opting out of the notification center must not silence the old reports.
  const noCenter = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001'), optOuts: { ownerNotifications: true } });
  equal(noCenter.config.ownerNotifications.enabled, false, 'notification center opt-out honoured');
  equal(noCenter.config.adminNotifications.enabled, true, 'legacy reports stay when the center is off');
  check(noCenter.report.legacy.retained.some((row) => row.source === 'legacy-owner-reports'), 'the retained legacy path is reported');
}

// ── 10. Only real owner reports are switched off ──────────────────────────
{
  const { config: after, report } = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001') });
  equal(after.adminNotifications.enabled, false, 'legacy admin status report is switched off');
  equal(after.adminNotifications.periodicStatusEnabled, false, 'legacy periodic status report is switched off');
  equal(after.adminNotifications.recipients, [OWNER], 'readable recipients are preserved for rollback');
  equal(after.hourlyChat.enabled, false, 'legacy hourly owner private routine is switched off');
  equal(after.hourlyChat.prompt, '旧的小时私聊提示词', 'the routine prompt is preserved, not deleted');

  // Group morning greeting / evening summary / summary schedules survive intact.
  equal(after.dailyMessages.enabled, true, 'group daily messages stay enabled');
  equal(after.dailyMessages.schedules.map((row) => row.id), ['morning', 'evening', 'summary'], 'every group schedule survives');
  equal(after.dailyMessages.schedules.map((row) => row.time), ['08:30', '23:00', '23:30'], 'group schedule times are untouched');
  equal(after.dailyMessages.schedules.map((row) => row.enabled), [true, true, true], 'group schedules stay enabled');
  equal(after.dailyMessages.schedules[0].prompt, '早上好，今天也要开心', 'group greeting prompt is untouched');

  // A schedule that explicitly targets the owner privately IS a real owner report.
  const ownerSchedule = baseConfig();
  ownerSchedule.dailyMessages.schedules.push({ id: 'ownerDigest', enabled: true, time: '22:00', toOwner: true, prompt: '给我一份进度' });
  const swept = migrateOwnerFirstConfig(ownerSchedule, { verifiedGroupsByAccount: allGroups('31001') });
  equal(swept.config.dailyMessages.schedules.find((row) => row.id === 'ownerDigest').enabled, false, 'an explicit owner-private schedule is switched off');
  equal(swept.config.dailyMessages.schedules.find((row) => row.id === 'ownerDigest').prompt, '给我一份进度', 'its prompt metadata stays readable');
  equal(swept.config.dailyMessages.schedules.find((row) => row.id === 'morning').enabled, true, 'group greetings are not swept along');
  check(swept.report.legacy.removed.some((row) => row.source === 'dailyMessages.schedules' && row.count === 1), 'the removed owner schedule is reported');

  // Shared (non-owner) recipients must never lose their reports.
  const shared = baseConfig();
  shared.adminNotifications.recipients = [OWNER, OTHER];
  const kept = migrateOwnerFirstConfig(shared, { verifiedGroupsByAccount: allGroups('31001') });
  equal(kept.config.adminNotifications.enabled, true, 'a shared recipient list is not silenced');
  check(kept.report.legacy.retained.some((row) => row.reason === 'shared-or-non-owner-recipients'), 'the retained shared report is explained');

  // Automation rules are conversation-scoped automation, not owner reports.
  const rules = baseConfig();
  rules.automation = { enabled: true, ownershipVersion: 1, accounts: {}, groups: {}, rules: [{ id: 'r1', conversationId: 'group:31001', schedules: [] }],
    routines: { version: 1, hourly: { enabled: true, ownerUserIds: [OWNER] }, daily: { enabled: true, schedules: [
      { id: 'morning', enabled: true, time: '08:30', prompt: '早安' }] } } };
  const rulesAfter = migrateOwnerFirstConfig(rules, { verifiedGroupsByAccount: allGroups('31001') });
  equal(rulesAfter.config.automation.rules.length, 1, 'automation rules are preserved');
  equal(rulesAfter.config.automation.routines.hourly.enabled, false, 'an owner-private hourly routine in the snapshot is switched off');
  equal(rulesAfter.config.automation.routines.daily.schedules[0].enabled, true, 'a group daily routine survives in the snapshot');

  // A non-owner hourly recipient is somebody else's routine: leave it alone.
  const foreign = baseConfig();
  foreign.hourlyChat.ownerUserIds = [OTHER];
  equal(migrateOwnerFirstConfig(foreign, { verifiedGroupsByAccount: allGroups('31001') }).config.hourlyChat.enabled, true,
    'a non-owner routine is not silenced');

  // Report hygiene: names and counts only, never user content or credentials.
  const serialized = JSON.stringify(report);
  for (const secret of ['旧的小时私聊提示词', '早上好，今天也要开心', '你是一个安静的群成员', OWNER, 'chat-model-x', 'HERMES_KEY']) {
    check(!serialized.includes(secret), `report never leaks ${secret}`);
  }
  check(report.legacy.removed.every((row) => typeof row.source === 'string' && typeof row.reason === 'string'), 'removed sources are named by code');
}

// ── 11. No model / persona / budget / voice / memory-value changes ────────
{
  const before = baseConfig();
  const after = migrateOwnerFirstConfig(before, { verifiedGroupsByAccount: allGroups('31001') }).config;
  equal(after.apiCenter, before.apiCenter, 'apiCenter connections, models and key references are untouched');
  equal(after.persona, before.persona, 'persona and system prompt are untouched');
  equal(after.budget, before.budget, 'budgets are untouched');
  equal(after.voice, before.voice, 'voice settings are untouched');
  equal(after.privateChats, before.privateChats, 'privateChats owner identity is untouched');
  equal(after.memory.enabled, before.memory.enabled, 'other memory switches are untouched');
  equal(after.accounts, before.accounts, 'the account registry is untouched');
  equal(after.targetGroups, before.targetGroups, 'targetGroups is untouched');
  check(after.memory.people && Object.keys(after.memory.people).join() === 'enabled', 'only the people switch is written');

  // Unknown/user-tuned keys survive verbatim.
  const tuned = baseConfig();
  tuned.customUserSetting = { keep: ['these', 'values'] };
  tuned.dailyMessages.schedules[0].at = { card: 'custom' };
  const tunedAfter = migrateOwnerFirstConfig(tuned, { verifiedGroupsByAccount: allGroups('31001') }).config;
  equal(tunedAfter.customUserSetting, { keep: ['these', 'values'] }, 'unknown user keys survive');
  equal(tunedAfter.dailyMessages.schedules[0].at, { card: 'custom' }, 'user-tuned schedule fields survive');
}

// ── 12. Host hint can only narrow owner authority ─────────────────────────
{
  const narrow = migrateOwnerFirstConfig(baseConfig(), { ownerIds: [OWNER], verifiedGroupsByAccount: allGroups('31001') });
  equal(narrow.report.owner.verifiedOwnerCount, 1, 'a matching hint keeps the real owner');

  const stranger = migrateOwnerFirstConfig(baseConfig(), { ownerIds: [OTHER], verifiedGroupsByAccount: allGroups('31001') });
  equal(stranger.changed, false, 'a hint naming a non-owner yields no upgrade');
  equal(stranger.report.owner.ignoredHintCount, 1, 'the ignored hint is counted');

  const mixed = migrateOwnerFirstConfig(baseConfig(), { ownerIds: [OWNER, OTHER], verifiedGroupsByAccount: allGroups('31001') });
  equal(mixed.report.owner.verifiedOwnerCount, 1, 'the hint filter never adds an owner');
  equal(mixed.config.ownerNotifications.recipients, [OWNER], 'an outsider never becomes a notification recipient');

  // Invalid owner ids are reported, not silently trusted.
  const invalid = baseConfig();
  invalid.privateChats.ownerUserIds = [OWNER, 'not-a-qq'];
  const invalidResult = migrateOwnerFirstConfig(invalid, { verifiedGroupsByAccount: allGroups('31001') });
  equal(invalidResult.config.ownerNotifications.recipients, [OWNER], 'an invalid owner id never becomes a recipient');
  check(invalidResult.report.warnings.some((w) => w.code === 'OWNER_FIRST_INVALID_OWNER_IDS'), 'the invalid owner id is reported');

  // The legacy instructionUserIds spelling is the same slot, read only when needed.
  const legacy = baseConfig();
  legacy.privateChats = { enabled: true, instructionUserIds: [OWNER] };
  const legacyResult = migrateOwnerFirstConfig(legacy, { verifiedGroupsByAccount: allGroups('31001') });
  equal(legacyResult.config.ownerNotifications.recipients, [OWNER], 'the documented legacy alias is honoured');
}

// ── 13. Bad input fails loudly, preview never throws ─────────────────────
{
  code(() => migrateOwnerFirstConfig(null), 'OWNER_FIRST_CONFIG_INVALID', 'null config is rejected');
  code(() => migrateOwnerFirstConfig([]), 'OWNER_FIRST_CONFIG_INVALID', 'array config is rejected');
  code(() => migrateOwnerFirstConfig({}, { ownerIds: 'nope' }), 'OWNER_FIRST_HINT_INVALID', 'a non-array hint is rejected');
  code(() => migrateOwnerFirstConfig({}, 'nope'), 'OWNER_FIRST_OPTIONS_INVALID', 'non-object options are rejected');

  const preview = previewOwnerFirstMigration(null);
  equal(preview.ok, false, 'preview returns a code instead of throwing');
  equal(preview.code, 'OWNER_FIRST_CONFIG_INVALID', 'preview reports the exact code');
  check(previewOwnerFirstMigration(baseConfig(), { verifiedGroupsByAccount: allGroups('31001') }).ok, 'preview succeeds on a valid config');

  // An empty config object is legal input, not a crash.
  const empty = migrateOwnerFirstConfig({});
  equal(empty.changed, false, 'an empty config has no real owner and stays untouched');
  equal(empty.report.status, 'no-owner', 'an empty config reports no owner');
}

// ── 14. Idempotency holds on every branch, not just the happy path ────────
{
  const cases = [];
  const noOwner = baseConfig(); noOwner.privateChats.ownerUserIds = []; cases.push(['no owner', noOwner, {}]);
  cases.push(['no evidence', baseConfig(), {}]);
  cases.push(['with evidence', baseConfig(), { verifiedGroupsByAccount: allGroups('31001', '31002') }]);
  const denied = baseConfig(); denied.blockedGroups = ['31001'];
  cases.push(['deny list', denied, { verifiedGroupsByAccount: allGroups('31001', '31002') }]);
  const broken = baseConfig(); broken.blockedGroups = { 'bad!': ['31001'] };
  cases.push(['unreadable deny list', broken, { verifiedGroupsByAccount: allGroups('31001') }]);
  const mixed = baseConfig(); mixed.accounts.standbys[0].archived = true;
  cases.push(['archived account', mixed, { verifiedGroupsByAccount: allGroups('31001') }]);
  const custom = baseConfig(); custom.ownerNotifications = { enabled: false, timezone: 'America/Los_Angeles', times: ['06:15'] };
  cases.push(['custom notifications', custom, { verifiedGroupsByAccount: allGroups('31001') }]);
  const optOut = baseConfig(); optOut.ownerFirst = { version: OWNER_FIRST_VERSION, optOuts: { people: true, ownerControl: true } };
  cases.push(['declared opt-outs', optOut, { verifiedGroupsByAccount: allGroups('31001') }]);
  const explicit = baseConfig(); explicit.ownerControl = { enabled: false, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] };
  cases.push(['explicit targets', explicit, { verifiedGroupsByAccount: allGroups('31001', '31002') }]);
  const hint = baseConfig(); cases.push(['narrowing hint', hint, { ownerIds: [OWNER], verifiedGroupsByAccount: allGroups('31001') }]);
  const enabledEmpty = baseConfig(); enabledEmpty.ownerFirst = { version: OWNER_FIRST_VERSION };
  enabledEmpty.ownerControl = { enabled: true, naturalLanguage: true, allowedTargets: [] };
  cases.push(['enabled empty restriction', enabledEmpty, { verifiedGroupsByAccount: allGroups('31001', '31002') }]);
  const template = baseConfig(); template.ownerControl = { enabled: false, naturalLanguage: false, usageEnabled: true, allowedTargets: [] };
  cases.push(['shipped disabled template', template, { verifiedGroupsByAccount: allGroups('31001') }]);
  const future = baseConfig(); future.ownerFirst = { version: OWNER_FIRST_VERSION + 1 };
  future.ownerControl = { enabled: false, lowRiskDirect: false, allowedTargets: [] };
  cases.push(['unsupported future version', future, { verifiedGroupsByAccount: allGroups('31001') }]);
  const durable = baseConfig(); durable.ownerFirst = { version: OWNER_FIRST_VERSION, optOuts: { usageEnabled: true, lowRiskDirect: true } };
  cases.push(['durable opt-outs', durable, { verifiedGroupsByAccount: allGroups('31001') }]);

  for (const [label, config, options] of cases) {
    const first = migrateOwnerFirstConfig(config, options);
    const second = migrateOwnerFirstConfig(first.config, options);
    equal(second.changed, false, `${label}: second run is a no-op`);
    equal(second.config, first.config, `${label}: second run is deep-equal`);
    const third = migrateOwnerFirstConfig(second.config, options);
    equal(third.config, second.config, `${label}: third run is stable too`);
    const snapshot = structuredClone(config);
    equal(config, snapshot, `${label}: the input is never mutated`);
  }
}

// ── 15. Independent-review regressions F1–F8 ─────────────────────────────
// Three successive runs WITHOUT repeating the host hint: denial metadata must be
// durable state, not a per-call argument that evaporates after run 2.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  let config = baseConfig();
  const run1 = migrateOwnerFirstConfig(config, { ...evidence, optOuts: { usageEnabled: true, people: true } });
  check(run1.config.ownerFirst.optOuts.usageEnabled === true, 'F1: run 1 persists the denial');
  check(run1.config.ownerFirst.optOuts.people === true, 'F1: run 1 persists every denied key');
  config = run1.config;

  const run2 = migrateOwnerFirstConfig(config, evidence);   // no optOuts hint
  equal(run2.changed, false, 'F1: run 2 without the hint changes nothing');
  equal(run2.report.changedPaths, [], 'F1: run 2 is a clean no-op (optOuts not deleted)');
  check(run2.config.ownerFirst.optOuts.usageEnabled === true, 'F1: run 2 keeps the denial instead of erasing it');
  config = run2.config;

  const run3 = migrateOwnerFirstConfig(config, evidence);
  equal(run3.config.ownerControl.usageEnabled, false, 'F1: run 3 still honours the denial');
  equal(run3.config.memory.people.enabled, false, 'F1: run 3 still honours the people denial');
  equal(run3.changed, false, 'F1: run 3 is also a no-op');
  equal(run3.config, run2.config, 'F1: three runs are stable');

  // Re-enabling is an explicit owner action on the VALUE switch, which is the
  // authority the runtime actually reads. `optOuts: {key:false}` only drops the
  // metadata shorthand; it is not a way to re-enable behind the owner's back.
  const clearedMeta = migrateOwnerFirstConfig(run3.config, { ...evidence, optOuts: { usageEnabled: false } });
  check(clearedMeta.config.ownerFirst.optOuts === undefined || clearedMeta.config.ownerFirst.optOuts.usageEnabled === undefined,
    'F1: optOuts:false removes the metadata shorthand');
  equal(clearedMeta.config.ownerControl.usageEnabled, false,
    'F1: dropping the shorthand does not re-enable against the stored switch');
  // Re-enabling therefore needs BOTH steps the owner controls: drop the metadata
  // shorthand, then set the value switch. The switch alone is not enough while a
  // recorded denial still stands, which is the safe direction.
  const switchOnly = { ...run3.config, ownerControl: { ...run3.config.ownerControl, usageEnabled: true } };
  equal(migrateOwnerFirstConfig(switchOnly, evidence).config.ownerControl.usageEnabled, false,
    'F1: flipping the switch alone does not silently overrule a recorded denial');
  const reEnabled = { ...clearedMeta.config, ownerControl: { ...clearedMeta.config.ownerControl, usageEnabled: true } };
  equal(migrateOwnerFirstConfig(reEnabled, evidence).config.ownerControl.usageEnabled, true,
    'F1: dropping the shorthand and setting the switch re-enables');
  equal(migrateOwnerFirstConfig(migrateOwnerFirstConfig(reEnabled, evidence).config, evidence).changed, false,
    'F1: the re-enabled state is stable');
}

// F2: lowRiskDirect denial must be written false and never deleted. It is new in
// 3.4, so a `false` is always an owner decision rather than a template value.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  const explicitFalse = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION }, ownerControl: { enabled: true, lowRiskDirect: false } };
  const kept = migrateOwnerFirstConfig(explicitFalse, evidence);
  equal(kept.config.ownerControl.lowRiskDirect, false, 'F2: an explicit lowRiskDirect:false survives');
  check(kept.report.warnings.some((w) => w.code === 'OWNER_FIRST_LOW_RISK_OPT_OUT_KEPT'), 'F2: the denial is reported');
  check(normalizeOwnerControl(kept.config.ownerControl).lowRiskDirect === false, 'F2: the denial survives the real normalizer');
  equal(migrateOwnerFirstConfig(kept.config, evidence).changed, false, 'F2: the denial is idempotent');

  const viaHost = migrateOwnerFirstConfig({ ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION }, ownerControl: { enabled: true } },
    { ...evidence, optOuts: { lowRiskDirect: true } });
  equal(viaHost.config.ownerControl.lowRiskDirect, false, 'F2: optOuts.lowRiskDirect wins over the default true');

  // A disabled control must keep readable low-risk metadata, not lose the field.
  const disabled = migrateOwnerFirstConfig({ ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: false, lowRiskDirect: false } }, evidence);
  check('lowRiskDirect' in disabled.config.ownerControl, 'F2: a prior low-risk choice is not deleted');
  equal(disabled.config.ownerControl.lowRiskDirect, false, 'F2: the disabled control keeps its low-risk value');
  equal(migrateOwnerFirstConfig({ ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: false, lowRiskDirect: true } }, evidence).config.ownerControl.lowRiskDirect, true,
    'F2: a disabled control with lowRiskDirect:true is not silently rewritten');

  // The default path still enables it for a fresh owner.
  equal(migrateOwnerFirstConfig(baseConfig(), evidence).config.ownerControl.lowRiskDirect, true,
    'F2: a fresh owner still gets lowRiskDirect');
}

// F3: usageEnabled / naturalLanguage denials are WRITTEN, not merely warned.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  const write = migrateOwnerFirstConfig(baseConfig(), { ...evidence, optOuts: { usageEnabled: true, naturalLanguage: true } });
  check(write.config.ownerControl.usageEnabled === false, 'F3: usageEnabled:false is written, not omitted');
  check(write.config.ownerControl.naturalLanguage === false, 'F3: naturalLanguage:false is written, not omitted');
  check(normalizeOwnerControl(write.config.ownerControl).usageEnabled === false,
    'F3: the written denial is not re-defaulted on by the real normalizer');
  check(normalizeOwnerControl(write.config.ownerControl).naturalLanguage === false,
    'F3: naturalLanguage denial survives the real normalizer too');
  check(write.report.warnings.some((w) => w.code === 'OWNER_FIRST_USAGE_OPT_OUT_KEPT'), 'F3: the denial is reported');
  // And it survives a restart without the hint (the F1 mechanism).
  equal(migrateOwnerFirstConfig(write.config, evidence).config.ownerControl.usageEnabled, false,
    'F3: the written denial persists across runs');
}

// F4: a future ownerFirst.version must fail closed, not re-enable everything.
{
  const future = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION + 1 },
    memory: { people: { enabled: false } }, ownerNotifications: { enabled: false, times: ['09:00'] },
    ownerControl: { enabled: false, naturalLanguage: false, lowRiskDirect: false, allowedTargets: [] } };
  const snapshot = structuredClone(future);
  const result = migrateOwnerFirstConfig(future, { verifiedGroupsByAccount: allGroups('31001') });
  equal(result.changed, false, 'F4: an unknown future version is not upgraded');
  equal(result.config, snapshot, 'F4: the future-version config is returned unchanged');
  equal(result.report.status, 'unsupported-version', 'F4: the status names the unsupported version');
  check(result.report.warnings.some((w) => w.code === 'OWNER_FIRST_FUTURE_VERSION_UNSUPPORTED'), 'F4: the refusal is explained');
  check(result.report.futureVersion === OWNER_FIRST_VERSION + 1, 'F4: the offending version is reported');
  check(Object.values(result.report.surfaces).every((state) => state === 'unsupported-version'), 'F4: no surface is touched');
  equal(result.config.memory.people.enabled, false, 'F4: the owner people opt-out is not reverted');
  equal(result.config.ownerControl.enabled, false, 'F4: the owner control opt-out is not reverted');
  equal(migrateOwnerFirstConfig(result.config, { verifiedGroupsByAccount: allGroups('31001') }).changed, false,
    'F4: re-running on a future version stays a no-op');

  // Version 1 without any hint: present metadata means prior decisions win.
  const priorDeci = migrateOwnerFirstConfig({ ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    memory: { people: { enabled: false } }, ownerControl: { enabled: false, naturalLanguage: false, lowRiskDirect: false } },
  { verifiedGroupsByAccount: allGroups('31001') });
  equal(priorDeci.config.memory.people.enabled, false, 'F4: a version-1 people denial is respected without a hint');
  equal(priorDeci.config.ownerControl.enabled, false, 'F4: a version-1 control denial is respected without a hint');
}

// F5: a deliberate zero-target restriction is never expanded; the shipped
// disabled template IS eligible to inherit.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001', '31002') };
  const enabledEmpty = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: true, naturalLanguage: true, allowedTargets: [] } };
  const restricted = migrateOwnerFirstConfig(enabledEmpty, evidence);
  equal(restricted.config.ownerControl.allowedTargets, [], 'F5: enabled control with [] stays empty (no authority growth)');
  equal(restricted.config.ownerControl.targetMode, 'explicit', 'F5: the restriction stays in EXPLICIT mode');
  equal(restricted.report.targets.mode, 'explicit', 'F5: the report does not claim inherited resolution');
  equal(restricted.config.ownerFirst.targetResolution, 'explicit', 'F5: metadata records the explicit restriction');
  check(!restricted.report.changedPaths.some((path) => path.includes('allowedTargets')), 'F5: the empty list is not rewritten');
  equal(migrateOwnerFirstConfig(restricted.config, evidence).changed, false, 'F5: the restriction is idempotent');

  // Same result on the very first run: enabling does not imply "fill this in".
  equal(migrateOwnerFirstConfig({ ...baseConfig(), ownerControl: { enabled: true, allowedTargets: [] } }, evidence)
    .config.ownerControl.allowedTargets, [], 'F5: a first-run enabled empty list is respected too');

  // The shipped disabled template and an absent ownerControl are both eligible.
  const template = { ...baseConfig(), ownerControl: { enabled: false, naturalLanguage: false, usageEnabled: true, allowedTargets: [] } };
  equal(targetsOf(migrateOwnerFirstConfig(template, evidence).config), ['primary:31001', 'primary:31002', 'standby-a:31001', 'standby-a:31002'],
    'F5: the shipped disabled template is eligible to auto-inherit');
  const absent = baseConfig();
  delete absent.ownerControl;
  equal(targetsOf(migrateOwnerFirstConfig(absent, evidence).config), ['primary:31001', 'primary:31002', 'standby-a:31001', 'standby-a:31002'],
    'F5: an absent ownerControl is eligible to auto-inherit');

  // Explicit delegation still derives, even with an empty list.
  const delegating = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: true, targetMode: 'inherited', allowedTargets: [] } };
  equal(targetsOf(migrateOwnerFirstConfig(delegating, evidence).config), ['primary:31001', 'primary:31002', 'standby-a:31001', 'standby-a:31002'],
    'F5: targetMode:inherited still derives targets');

  // A non-empty restriction is preserved, never expanded.
  const nonEmpty = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: true, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] } };
  equal(targetsOf(migrateOwnerFirstConfig(nonEmpty, evidence).config), ['primary:31001'],
    'F5: a non-empty restriction is preserved, not expanded');
}

// F5 continued: an explicit denylist with an enabled+empty control still blocks.
{
  const config = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION }, blockedGroups: ['31001'],
    ownerControl: { enabled: true, allowedTargets: [] } };
  const result = migrateOwnerFirstConfig(config, { verifiedGroupsByAccount: allGroups('31001') });
  equal(result.config.ownerControl.allowedTargets, [], 'F5: enabled+empty deny vs inherit stays empty');
}

// F6: the real group schedule schema must survive arbitrary owner-ish wording.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  const groupSchedules = [
    { name: 'morning', mode: 'daily', time: '08:30', prompt: '早安，今天也要开心', enabled: true, requireHistory: false },
    { enabled: true, time: '08:00', prompt: '早安', audience: 'group-owners' },
    { enabled: true, time: '08:00', prompt: '早安', targetUserId: OWNER },
    { enabled: true, time: '08:00', prompt: '早安', target: 'owner' },
    { enabled: true, time: '08:00', prompt: '早安', scope: 'owner-only-groups' },
    { enabled: true, time: '08:00', prompt: '早安', userId: OWNER },
    { enabled: true, time: '08:00', prompt: '早上好，聊聊今天的热点' }
  ];
  for (const schedule of groupSchedules) {
    const config = baseConfig();
    config.dailyMessages.schedules = [structuredClone(schedule)];
    const after = migrateOwnerFirstConfig(config, evidence).config;
    equal(after.dailyMessages.schedules[0].enabled, true,
      `F6: group schedule with ${Object.keys(schedule).join('/')} survives`);
  }
  // Only the strict boolean markers are authority.
  for (const marker of ['toOwner', 'ownerPrivate', 'privateOnly', 'ownerOnly']) {
    const config = baseConfig();
    config.dailyMessages.schedules = [{ enabled: true, time: '22:00', prompt: '汇报', [marker]: true }];
    equal(migrateOwnerFirstConfig(config, evidence).config.dailyMessages.schedules[0].enabled, false,
      `F6: an explicit ${marker} schedule is still switched off`);
  }
  // A private-owner marker that is not `true` is not authority either.
  const notTrue = baseConfig();
  notTrue.dailyMessages.schedules = [{ enabled: true, time: '22:00', prompt: '汇报', toOwner: 'yes' }];
  equal(migrateOwnerFirstConfig(notTrue, evidence).config.dailyMessages.schedules[0].enabled, true,
    'F6: a non-boolean toOwner is not treated as a private owner report');
}

// F7: the hourlyChat admin-recipient fallback is modelled in the reason code.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001') };
  const viaAdmin = baseConfig();
  viaAdmin.hourlyChat = { enabled: true, ownerUserIds: [], prompt: '每小时汇报' };
  const result = migrateOwnerFirstConfig(viaAdmin, evidence);
  equal(result.config.hourlyChat.enabled, false, 'F7: the admin-recipient fallback routine is switched off');
  equal(result.report.legacy.removed.find((row) => row.source === 'hourlyChat').reason,
    'centralized-owner-report-via-admin-recipients', 'F7: the fallback is named instead of "no-recipients"');

  const explicitOwner = baseConfig();
  explicitOwner.hourlyChat = { enabled: true, ownerUserIds: [OWNER] };
  equal(migrateOwnerFirstConfig(explicitOwner, evidence).report.legacy.removed.find((row) => row.source === 'hourlyChat').reason,
    'centralized-owner-report', 'F7: an explicit owner routine keeps the plain reason');

  // No recipients anywhere is still honestly "no-recipients" and stays enabled.
  const none = baseConfig();
  none.adminNotifications = { enabled: false, recipients: [] };
  none.hourlyChat = { enabled: true, ownerUserIds: [] };
  const noneResult = migrateOwnerFirstConfig(none, evidence);
  equal(noneResult.config.hourlyChat.enabled, true, 'F7: a routine with no recipient is not silenced');
  equal(noneResult.report.legacy.retained.find((row) => row.source === 'hourlyChat').reason, 'no-recipients',
    'F7: the genuinely recipient-less routine is reported correctly');
}

// F8: written / retainedExisting / newlyDerived describe the same list.
{
  const evidence = { verifiedGroupsByAccount: allGroups('31001', '31002') };
  const explicit = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION },
    ownerControl: { enabled: true, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] } };
  const result = migrateOwnerFirstConfig(explicit, evidence);
  equal(result.report.targets.written, result.config.ownerControl.allowedTargets.length,
    'F8: written matches the list actually stored');
  equal(result.report.targets.retainedExisting, 1, 'F8: the pre-existing pair is counted as retained');
  equal(result.report.targets.newlyDerived, 0, 'F8: nothing new is derived when the owner restricted');

  const fresh = migrateOwnerFirstConfig(baseConfig(), evidence);
  equal(fresh.report.targets.written, 4, 'F8: a fresh derivation writes all four pairs');
  equal(fresh.report.targets.retainedExisting, 0, 'F8: nothing pre-existed');
  equal(fresh.report.targets.newlyDerived, 4, 'F8: all four are new');

  // The fail-closed denylist branch no longer claims zero while writing pairs.
  const blocked = { ...baseConfig(), ownerFirst: { version: OWNER_FIRST_VERSION }, blockedGroups: { 'bad!': ['31001'] },
    ownerControl: { enabled: true, allowedTargets: [{ accountId: 'primary', groupId: '31001' }] } };
  const blockedResult = migrateOwnerFirstConfig(blocked, evidence);
  equal(blockedResult.report.targets.denyBlocked, true, 'F8: fail-closed is flagged');
  equal(blockedResult.report.targets.written, blockedResult.config.ownerControl.allowedTargets.length,
    'F8: written is honest on the fail-closed path too');
}

// ── 16. Report shape is stable and safe to log ────────────────────────────
{
  const { report } = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001', '31002') });
  for (const key of ['version', 'status', 'changed', 'changedPaths', 'owner', 'surfaces', 'targets', 'notifications',
    'legacy', 'pendingSchemaFields', 'ignoredScopes', 'warnings']) {
    check(key in report, `report exposes ${key}`);
  }
  check(report.changedPaths.includes('ownerFirst') && report.changedPaths.includes('ownerControl'), 'changed paths are dotted and readable');
  check(report.changedPaths.every((path) => !/\d{5,}/u.test(path)), 'changed paths never embed identifiers');
  // CHANGED SEMANTICS (was: assert targetMode was still pending for worker A).
  // The coordination is closed — targetMode is accepted by the real normalizer —
  // so the compatibility export must no longer advertise any deferred field.
  equal(OWNER_FIRST_PENDING_SCHEMA_FIELDS.ownerControl, [], 'no schema field is pending any more');
  equal(OWNER_FIRST_PENDING_SCHEMA_FIELDS.owner, null, 'the pending-field owner handoff is closed');
  equal(OWNER_FIRST_PENDING_SCHEMA_FIELDS.neededValues, {}, 'no pending value is requested');
  check(!('pendingSchemaFields' in report) || report.pendingSchemaFields.length === 0, 'the report defers nothing');
  // The emitted control must be accepted by the real normalizer with or without
  // the compatibility flag, which is the property the pending marker existed for.
  for (const flag of [true, false]) {
    const out = migrateOwnerFirstConfig(baseConfig(), { verifiedGroupsByAccount: allGroups('31001'), acceptPendingSchemaFields: flag });
    check(normalizeOwnerControl(out.config.ownerControl).targetMode === 'explicit',
      `acceptPendingSchemaFields:${flag} still yields schema-valid ownerControl`);
    check(!('pendingSchemaFields' in out.config.ownerFirst), `acceptPendingSchemaFields:${flag} plants no pending marker`);
  }
  equal(JSON.parse(JSON.stringify(report)), report, 'the report is plain JSON');
}

console.log(JSON.stringify({ ok: true, checks, module: 'owner-first-migration', productionIO: false, actualModelCalls: 0, actualQQ: 0 }));
