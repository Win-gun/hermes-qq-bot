// Owner First 3.4 — one-shot configuration upgrade (pure, no IO).
//
// This module answers exactly one question: "given the config a user already has,
// what is the smallest deterministic patch that turns the real owner into the
// first-class operator of this bridge?" It reads nothing (no fs, no env, no
// network, no clock, no memory state, no protocol state) and writes nothing.
// The trusted host reads `config.json`, calls `migrateOwnerFirstConfig(config,
// { verifiedGroupsByAccount, ownerIds })`, shows `report`, and persists the
// returned `config` through its own guarded config writer.
//
// Non-negotiable rules encoded here (see docs/OWNER-FIRST-3.4.md):
//
// 1. Owner identity comes ONLY from the existing real `privateChats.ownerUserIds`
//    (legacy spelling `instructionUserIds`, the same slot bridge.js reads). Group
//    roles, `commands.adminUserIds`, `taskMode.ownerUserIds`, memory-verification
//    admins and QQ group-admin bits are NOT owner proof. A host hint (`ownerIds`)
//    can only NARROW that list, never extend it.
// 2. No real owner => no upgrade. Nothing is enabled and nothing else is touched.
// 3. Targets are derived from eligible accounts + joined groups that the TRUSTED
//    host actually verified. Missing evidence stays unresolved (runtime dynamic
//    resolution) — it never becomes "all groups" and never invents a group.
// 4. Existing explicit user data wins: non-empty `allowedTargets` are intersected,
//    explicit times/timezone are preserved, and in an already-migrated config
//    (ownerFirst.version === 1) a switched-off surface is an explicit opt-out.
// 5. Only *real owner reports* are switched off (bridge status/login/periodic
//    reports and the hourly owner private routine), and only when the owner
//    notification center is actually taking over. Group morning greetings,
//    evening summaries, automation rules/scopes, models, prompts, persona,
//    budgets and keys are never touched.
// 6. Every emitted owner-control field is accepted by the current normalizer;
//    no pending metadata is interpreted as a permission grant.
//
// Determinism/idempotency: calling this on its own output returns
// `{ changed: false }` with a deep-equal config. No timestamp is generated; the
// host may stamp its own audit record if it needs one.

export const OWNER_FIRST_VERSION = 1;

/** Kept as a compatibility export only. The coordination it described is over:
 *  `normalizeOwnerControl()` now accepts every field the migration writes, so
 *  nothing is deferred and `report.pendingSchemaFields` is always empty. */
export const OWNER_FIRST_PENDING_SCHEMA_FIELDS = Object.freeze({
  ownerControl: Object.freeze([]),
  neededValues: Object.freeze({}),
  owner: null
});

const DEFAULT_TIMES = Object.freeze(["09:00", "21:00"]);
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const QQ = /^[1-9]\d{4,19}$/;
const ACCOUNT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WILDCARDS = new Set(["*", "all", "ALL"]);
const SURFACES = Object.freeze(["memory.people", "ownerControl", "ownerNotifications"]);
const DEFAULT_TEMPLATE_TIMES = new Set(DEFAULT_TIMES);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => isObject(value) && Object.hasOwn(value, key);
const list = (value) => (Array.isArray(value) ? value : []);
const fail = (code) => Object.assign(new Error(code), { code });

function stableEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => stableEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a), keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && stableEqual(a[key], b[key]));
  }
  return false;
}

/** Dotted paths only. No values (prompts, ids, group numbers) enter the report,
 *  so it is safe to show in the console and to log. */
function changedPaths(before, after, base = "", out = []) {
  if (stableEqual(before, after)) return out;
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const path = base ? `${base}.${key}` : key;
      if (!own(before, key) || !own(after, key)) out.push(path);
      else changedPaths(before[key], after[key], path, out);
    }
    return out;
  }
  out.push(base || "config");
  return out;
}

const asQq = (value) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return QQ.test(String(value)) ? String(value) : "";
  if (typeof value !== "string") return "";
  const text = value.trim();
  return QQ.test(text) ? text : "";
};
const uniqueSorted = (values) => [...new Set(values)].sort();
const qqList = (value) => uniqueSorted((Array.isArray(value) ? value : [value]).map(asQq).filter(Boolean));

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

/** Real owner ids from the one field that actually means "owner" at runtime
 *  (bridge.js `privateOwnerUserIds()`). `instructionUserIds` is the legacy
 *  spelling of the same slot and is read only when ownerUserIds is absent. */
function configuredOwners(config) {
  const chats = isObject(config.privateChats) ? config.privateChats : {};
  const raw = Array.isArray(chats.ownerUserIds) ? chats.ownerUserIds
    : Array.isArray(chats.instructionUserIds) ? chats.instructionUserIds : [];
  const ids = [];
  let invalid = 0;
  for (const value of raw) {
    const id = asQq(value);
    if (id) ids.push(id); else invalid += 1;
  }
  return { ids: uniqueSorted(ids), invalid };
}

/** The optional host hint is a restrictive filter over the real list: it can
 *  never introduce an owner the live config does not already trust. */
function resolveOwners(config, hint) {
  const real = configuredOwners(config);
  if (hint === undefined || hint === null) return { owners: real.ids, invalid: real.invalid, ignoredHint: 0 };
  if (!Array.isArray(hint)) throw fail("OWNER_FIRST_HINT_INVALID");
  const realSet = new Set(real.ids);
  const hinted = new Set();
  let ignoredHint = 0;
  for (const value of hint) {
    const id = asQq(value);
    if (!id || !realSet.has(id)) ignoredHint += 1; else hinted.add(id);
  }
  return { owners: real.ids.filter((id) => hinted.has(id)), invalid: real.invalid, ignoredHint };
}

// ---------------------------------------------------------------------------
// Account / scope / send eligibility (mirrors src/account-registry.js)
// ---------------------------------------------------------------------------

function accountEntries(config) {
  const accounts = isObject(config.accounts) ? config.accounts : {};
  const items = (Array.isArray(accounts.items) ? accounts.items : [accounts.primary, ...list(accounts.standbys)]).filter(isObject);
  const failoverGroups = list(accounts.failoverGroups).filter(isObject);
  const featureDefaults = (id) => {
    // Same projection as `featureDefaults()` in the registry: an absent chat
    // switch means "participates unless this account is task-only".
    const mode = config.botFeatures?.accountModes?.[id] || config.botFeatures?.defaultMode || "all";
    return { chat: mode !== "task", automation: config.automation?.enabled === true };
  };
  return items.map((item, index) => {
    const id = typeof item.id === "string" && item.id ? item.id : index === 0 ? "primary" : "";
    const member = id ? failoverGroups.find((group) => list(group.memberIds).includes(id)) : null;
    const policy = member && isObject(member.policy) ? member.policy : null;
    // A failover group shares one policy identity; its explicit fields win over
    // the member account, exactly like `effectiveAccount()` in the registry.
    const merged = (key) => ({ ...(isObject(item[key]) ? item[key] : {}), ...(policy && isObject(policy[key]) ? policy[key] : {}) });
    return { id, item,
      archived: item.archived === true,
      enabled: item.enabled !== false,
      protocolEnabled: item.protocolEnabled !== false,
      // Registry defaults: sendTypes default to true, scope defaults to "all"
      // groups, and an absent features.chat follows the bot mode.
      scope: { groups: true, private: true, groupMode: "all", groupIds: [], ...merged("scope") },
      sendTypes: { text: true, ...merged("sendTypes") },
      features: { ...featureDefaults(id), ...merged("features") } };
  });
}

function groupScope(entry) {
  const scope = entry.scope;
  const mode = scope.groupMode === undefined ? "all" : scope.groupMode;
  return { groups: scope.groups !== false, mode: mode === "all" || mode === "allowlist" ? mode : null,
    ids: uniqueSorted(list(scope.groupIds).map(asQq).filter(Boolean)) };
}

/** Message-processing + text-send eligibility, as the real send gate sees it.
 *  `accountScopeAllows()` + `accountDeliveryDecision()` rules, read-only. */
function eligibleForOwnerTargets(entry) {
  if (!entry.id || !ACCOUNT_ID.test(entry.id)) return { ok: false, code: "invalid-account-id" };
  if (entry.archived) return { ok: false, code: "archived" };
  if (!entry.enabled || !entry.protocolEnabled) return { ok: false, code: "disabled" };
  if (entry.features.chat === false) return { ok: false, code: "chat-disabled" };
  if (entry.sendTypes.text !== true) return { ok: false, code: "text-send-disabled" };
  const scope = groupScope(entry);
  if (!scope.groups) return { ok: false, code: "group-scope-off" };
  if (scope.mode === null) return { ok: false, code: "invalid-group-mode" };
  return { ok: true, scope };
}

function targetGroupPolicy(config) {
  const values = list(config.targetGroups).map(String).filter(Boolean);
  const dynamic = values.some((value) => WILDCARDS.has(value));
  const explicit = new Set(values.map(asQq).filter(Boolean));
  return { dynamic, explicit, disabled: !dynamic && explicit.size === 0 };
}

/** Optional deny list: restrictions are read, allow expansions are impossible.
 *  An unrecognizable deny list blocks derivation instead of silently authorizing
 *  what it was meant to forbid. The current schema has no such key; when absent
 *  the report says so, because worker A still has to define it. */
function denyList(config) {
  const value = config.blockedGroups;
  if (value === undefined || value === null) return { ok: true, present: false, groups: new Set(), accounts: new Map() };
  const collect = (input) => {
    const set = new Set();
    for (const raw of list(input)) { const id = asQq(raw); if (!id) return null; set.add(id); }
    return set;
  };
  if (Array.isArray(value)) {
    const set = collect(value);
    return set ? { ok: true, present: true, groups: set, accounts: new Map() } : { ok: false, present: true };
  }
  if (!isObject(value)) return { ok: false, present: true };
  if (Array.isArray(value.groupIds)) {
    const set = collect(value.groupIds);
    return set ? { ok: true, present: true, groups: set, accounts: new Map() } : { ok: false, present: true };
  }
  // The map form is account-scoped: `{ primary: ["31001"] }` denies that pair
  // only. It must never widen into a global deny that silences other accounts.
  const accounts = new Map();
  for (const [key, entry] of Object.entries(value)) {
    if (!ACCOUNT_ID.test(key)) return { ok: false, present: true };
    if (isObject(entry) && entry.blocked === false) continue;
    const set = collect(Array.isArray(entry) ? entry : isObject(entry) && Array.isArray(entry.groupIds) ? entry.groupIds : null);
    if (!set) return { ok: false, present: true };
    accounts.set(key, set);
  }
  return { ok: true, present: true, groups: new Set(), accounts };
}

/** Trusted-host evidence only: `{ accountId: [groupId...] }` or
 *  `[{ accountId, groupIds }]`. Anything else is "unknown" — never "all joined
 *  groups". A present-but-empty list means "verified: no joined groups". */
function joinedGroupsEvidence(value) {
  if (value === undefined || value === null) return { ok: false, reason: "absent", map: new Map() };
  const map = new Map();
  const add = (accountId, entries) => {
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) || !Array.isArray(entries)) return false;
    const ids = [];
    for (const raw of entries) { const id = asQq(raw); if (!id) return false; ids.push(id); }
    map.set(accountId, uniqueSorted([...list(map.get(accountId)), ...ids]));
    return true;
  };
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isObject(row) || !add(row.accountId, row.groupIds ?? row.groups)) return { ok: false, reason: "unsupported", map };
    }
    return { ok: true, reason: "", map };
  }
  if (!isObject(value)) return { ok: false, reason: "unsupported", map };
  for (const [accountId, entries] of Object.entries(value)) {
    if (!add(accountId, entries)) return { ok: false, reason: "unsupported", map };
  }
  return { ok: true, reason: "", map };
}

// ---------------------------------------------------------------------------
// Target derivation
// ---------------------------------------------------------------------------

const pairKey = (accountId, groupId) => `${accountId}:${groupId}`;
const sortPairs = (pairs) => pairs.slice().sort((a, b) => pairKey(a.accountId, a.groupId).localeCompare(pairKey(b.accountId, b.groupId)));

/** `present` is the difference between "the key is missing" (never configured,
 *  fair to fill in) and "the key is an empty array" (the owner authorised
 *  nobody). Collapsing the two is what made an explicit empty list expand. */
function normalizeExistingTargets(value, present = false) {
  if (value === undefined || value === null) return { targets: [], invalid: 0, present: false };
  if (!Array.isArray(value)) return { targets: [], invalid: 1, present: present || true };
  const targets = new Map();
  let invalid = 0;
  for (const row of value) {
    if (!isObject(row) || typeof row.accountId !== "string" || !ACCOUNT_ID.test(row.accountId) || !asQq(row.groupId)) { invalid += 1; continue; }
    targets.set(pairKey(row.accountId, asQq(row.groupId)), { accountId: row.accountId, groupId: asQq(row.groupId) });
  }
  return { targets: sortPairs([...targets.values()]), invalid, present: true };
}

function deriveTargets({ entries, evidence, policy, deny }) {
  const pairs = new Map();
  const stats = { groupsUnknownAccounts: 0, noJoinedGroupsAccounts: 0, ineligibleAccounts: 0, denied: 0, outsideTargetGroups: 0 };
  for (const entry of entries) {
    if (entry.archived) continue;
    const eligible = eligibleForOwnerTargets(entry);
    if (!eligible.ok) { stats.ineligibleAccounts += 1; continue; }
    if (!evidence.map.has(entry.id)) { stats.groupsUnknownAccounts += 1; continue; }
    const verified = evidence.map.get(entry.id);
    if (!verified.length) { stats.noJoinedGroupsAccounts += 1; continue; }
    // An allowlist scope caps the candidate set; "all" still needs real evidence.
    const candidates = eligible.scope.mode === "allowlist" ? verified.filter((group) => eligible.scope.ids.includes(group)) : verified;
    for (const group of candidates) {
      if (!policy.dynamic && !policy.explicit.has(group)) { stats.outsideTargetGroups += 1; continue; }
      if (deny.ok && (deny.groups.has(group) || (deny.accounts.get(entry.id) || new Set()).has(group))) { stats.denied += 1; continue; }
      pairs.set(pairKey(entry.id, group), { accountId: entry.id, groupId: group });
    }
  }
  return { pairs, stats };
}

// ---------------------------------------------------------------------------
// Legacy owner-report sources
// ---------------------------------------------------------------------------

function legacyRecipients(section) {
  if (!isObject(section)) return [];
  const raw = [section.recipients, section.users, section.userIds, section.userId].find((value) => value !== undefined) ?? [];
  return qqList(raw);
}

/** Strict boolean markers that can only mean "this is a private owner report".
 *  Deliberately excludes free-text `audience`/`target`/`scope` and arbitrary
 *  `targetUserId`/`toUserId`/`userId`: the real schedule schema
 *  (`SCHEDULE_FIELDS` in src/legacy-automation.js) has none of those fields, and
 *  a group greeting carrying a stray key such as `audience: "group-owners"` must
 *  not be mistaken for an owner report. `ownerUserIds` counts only when the
 *  schedule is otherwise a private send (never for a group schedule). */
const OWNER_PRIVATE_SCHEDULE_KEYS = Object.freeze(["toOwner", "ownerPrivate", "privateOnly", "ownerOnly"]);

function ownerPrivateSchedule(schedule) {
  if (!isObject(schedule)) return false;
  return OWNER_PRIVATE_SCHEDULE_KEYS.some((key) => schedule[key] === true);
}

function routineTargets(routine, admin) {
  const explicit = qqList(list(routine.ownerUserIds));
  return explicit.length ? explicit : legacyRecipients(admin || {});
}

/** Switch off one hourly owner-private routine. `retained` always records why a
 *  routine was left alone, so the report never implies a send was removed when
 *  it was not. */
function sweepHourlyRoutine(routine, source, state) {
  const { isOwner, admin, removed, retained } = state;
  if (!isObject(routine)) return;
  if (routine.enabled === false) { retained.push({ source, reason: "already-off" }); return; }
  // Mirrors bridge.js: `ownerUserIds?.length ? ownerUserIds : adminNotifications.recipients`.
  const viaAdminFallback = qqList(list(routine.ownerUserIds)).length === 0;
  const targets = routineTargets(routine, admin);
  if (!targets.length) { retained.push({ source, reason: "no-recipients" }); return; }
  if (!targets.every(isOwner)) { retained.push({ source, reason: "non-owner-recipients" }); return; }
  routine.enabled = false;
  removed.push({ source, reason: viaAdminFallback ? "centralized-owner-report-via-admin-recipients" : "centralized-owner-report" });
}

function sweepDailySchedules(container, source, state) {
  if (!isObject(container) || !Array.isArray(container.schedules)) return;
  let disabled = 0, kept = 0;
  for (const schedule of container.schedules) {
    if (!isObject(schedule) || schedule.enabled === false) { kept += 1; continue; }
    if (ownerPrivateSchedule(schedule)) { schedule.enabled = false; disabled += 1; } else kept += 1;
  }
  if (disabled) state.removed.push({ source, reason: "owner-private-report", count: disabled });
  if (kept) state.retained.push({ source, reason: "group-greeting-or-summary", count: kept });
}

/** Only real owner reports. Never touches rules, scopes, prompts, models or
 *  readable target metadata: switches are set to false, values stay. */
function migrateLegacySources(draft, state) {
  const { removed, retained } = state;

  // (1) Bridge status / login / quick-login / disconnected / periodic reports.
  //     A shared recipient list is left alone: it also feeds people who are not
  //     this owner, so disabling it would silently drop their reports too.
  const admin = isObject(draft.adminNotifications) ? draft.adminNotifications : null;
  // The hourly routines resolve their recipients through this object when their
  // own `ownerUserIds` is empty, so the sweep must see it too.
  state.admin = admin;
  if (admin) {
    const recipients = legacyRecipients(admin);
    const periodic = isObject(admin.periodicStatus) && admin.periodicStatus.enabled === true;
    const active = admin.enabled !== false || admin.periodicStatusEnabled === true || periodic;
    if (!active) retained.push({ source: "adminNotifications", reason: "already-off" });
    else if (!recipients.length) retained.push({ source: "adminNotifications", reason: "no-recipients" });
    else if (!recipients.every(state.isOwner)) retained.push({ source: "adminNotifications", reason: "shared-or-non-owner-recipients" });
    else {
      admin.enabled = false;
      if (admin.periodicStatusEnabled === true) admin.periodicStatusEnabled = false;
      if (periodic) admin.periodicStatus.enabled = false;
      removed.push({ source: "adminNotifications", reason: "centralized-owner-report" });
    }
  }

  // (2) Legacy hourly owner private chat routine (still an executable path).
  if (isObject(draft.hourlyChat)) sweepHourlyRoutine(draft.hourlyChat, "hourlyChat", state);
  if (isObject(draft.dailyMessages)) sweepDailySchedules(draft.dailyMessages, "dailyMessages.schedules", state);

  // (3) Authoritative routine snapshot and per-account/per-group automation dirs.
  const automation = isObject(draft.automation) ? draft.automation : null;
  if (automation) {
    if (isObject(automation.routines)) {
      sweepDailySchedules(automation.routines.daily, "automation.routines.daily", state);
      sweepHourlyRoutine(automation.routines.hourly, "automation.routines.hourly", state);
    }
    for (const mapName of ["accounts", "groups"]) {
      const map = automation[mapName];
      if (!isObject(map)) continue;
      for (const entry of Object.values(map)) {
        if (!isObject(entry) || !isObject(entry.routines)) continue;
        // Owner ids are deliberately not used as report labels.
        sweepDailySchedules(entry.routines.daily, `automation.${mapName}[].routines.daily`, state);
        sweepHourlyRoutine(entry.routines.hourly, `automation.${mapName}[].routines.hourly`, state);
      }
    }
    // Conversation-scoped rules are automation, not owner reports: untouched.
    if (list(automation.rules).length) retained.push({ source: "automation.rules", reason: "not-an-owner-report", count: automation.rules.length });
  }

  // (4) Login recovery already defers to the centralized center at runtime;
  //     rewriting it would destroy readable intent for no benefit.
  if (isObject(draft.loginRecovery) && draft.loginRecovery.notifyOwner !== false) {
    retained.push({ source: "loginRecovery.notifyOwner", reason: "runtime-gated-by-owner-center" });
  }
  return { removed, retained };
}

// ---------------------------------------------------------------------------
// Owner notification times / timezone
// ---------------------------------------------------------------------------

function normalizeTimes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  if (!value.every((time) => typeof time === "string" && CLOCK.test(time)) || new Set(value).size !== value.length) return null;
  return uniqueSorted(value);
}

/** Default 09:00,21:00 unless the owner already set something else. A custom or
 *  stricter list (fewer points, different hours) is preserved verbatim; nothing
 *  here ever adds a time point the user did not choose. */
function resolveNotificationTimes(existing) {
  const times = normalizeTimes(existing);
  if (!times) {
    return { times: [...DEFAULT_TIMES], state: existing === undefined || existing === null ? "default" : "invalid-reset-default" };
  }
  if (times.length === DEFAULT_TIMES.length && times.every((time) => DEFAULT_TEMPLATE_TIMES.has(time))) return { times, state: "default" };
  const subset = times.every((time) => DEFAULT_TEMPLATE_TIMES.has(time));
  return { times, state: subset ? "preserved-stricter" : "preserved-custom" };
}

function validTimezone(value) {
  if (typeof value !== "string" || !value.trim() || /^[+-]/u.test(value) || value.length > 64) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Upgrade a config object to the Owner First 3.4 shape.
 *
 * @param {object} config complete live config (plain object). Never mutated.
 * @param {object} [options]
 * @param {Record<string, Array<string|number>>|Array<{accountId:string,groupIds:Array}>} [options.verifiedGroupsByAccount]
 *        Joined groups the TRUSTED host actually verified, per account. Missing
 *        evidence keeps targets in runtime-derived (inherited) mode.
 * @param {Array<string|number>} [options.ownerIds] restrictive filter over
 *        `privateChats.ownerUserIds`; never a source of owner authority.
 * @param {{people?:boolean,ownerControl?:boolean,ownerNotifications?:boolean}} [options.optOuts]
 *        explicit user denials the host knows about (e.g. a saved UI switch).
 * @param {boolean} [options.acceptPendingSchemaFields] accepted for API
 *   compatibility; gates nothing now that the schema accepts `targetMode`.
 *        `ownerControl.lowRiskDirect` / `targetMode`. Only valid once worker A's
 *        `normalizeOwnerControl()` accepts them.
 * @returns {{changed:boolean, config:object, report:object}}
 */
export function migrateOwnerFirstConfig(config, options = {}) {
  if (!isObject(config)) throw fail("OWNER_FIRST_CONFIG_INVALID");
  if (!isObject(options)) throw fail("OWNER_FIRST_OPTIONS_INVALID");
  const draft = structuredClone(config);
  const warnings = new Map();
  const warn = (code, count = 1) => {
    if (typeof code !== "string" || !code || !(count > 0)) return;
    warnings.set(code, (warnings.get(code) || 0) + count);
  };

  const previousMeta = isObject(draft.ownerFirst) ? draft.ownerFirst : null;
  const previousVersion = previousMeta && Number.isSafeInteger(previousMeta.version) ? previousMeta.version : null;

  // A shape newer than this module understands is never downgraded in place: a
  // future version may have renamed or re-defaulted switches we would misread as
  // the shipped template, so upgrading would silently revert owner choices.
  // Fail closed: byte-identical config, explicit warning, no surface touched.
  if (previousVersion !== null && previousVersion > OWNER_FIRST_VERSION) {
    warn("OWNER_FIRST_FUTURE_VERSION_UNSUPPORTED");
    const owners = resolveOwners(draft, options.ownerIds);
    return {
      changed: false,
      config: draft,
      report: {
        version: OWNER_FIRST_VERSION,
        status: "unsupported-version",
        changed: false,
        changedPaths: [],
        owner: { source: "privateChats.ownerUserIds", verifiedOwnerCount: owners.owners.length,
          invalidConfigured: owners.invalid, ignoredHintCount: owners.ignoredHint },
        surfaces: Object.fromEntries(SURFACES.map((surface) => [surface, "unsupported-version"])),
        targets: { mode: "untouched", evidence: "none", derived: 0, written: 0, retainedExisting: 0,
          droppedArchived: 0, droppedDenied: 0, droppedOutsideDerivation: 0, droppedOutsideScope: 0,
          groupsUnknownAccounts: 0, noJoinedGroupsAccounts: 0, ineligibleAccounts: 0, existingInvalid: 0,
          deniedListPresent: false, denyBlocked: false },
        notifications: { times: "unchanged", timezone: "unchanged" },
        legacy: { removed: [], retained: [] },
        pendingSchemaFields: [],
        ignoredScopes: [],
        futureVersion: previousVersion,
        warnings: [...warnings.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code))
      }
    };
  }

  // First run = no ownerFirst metadata was ever written. ANY present metadata
  // means a previous run already decided the switches, so a switched-off surface
  // is an owner choice rather than the shipped template default. Keying this on
  // `version === 1` made every version bump re-enable all denials.
  const firstRun = previousMeta === null || previousMeta.version === undefined;

  // Denials are durable state, not a per-call hint: the persisted map is the
  // base and a host hint may only add `true` or clear one with `false`. The
  // merged map is what gets re-persisted, so a denial cannot evaporate on the
  // next restart and reappear as consent the run after.
  const optOuts = { ...(isObject(previousMeta?.optOuts) ? previousMeta.optOuts : {}) };
  for (const [key, value] of Object.entries(isObject(options.optOuts) ? options.optOuts : {})) {
    if (value === true) optOuts[key] = true;
    else if (value === false) delete optOuts[key]; // documented clear path
  }
  const declared = (key) => optOuts[key] === true;

  const resolved = resolveOwners(draft, options.ownerIds);
  const ownerSet = new Set(resolved.owners);
  const isOwner = (id) => ownerSet.has(String(id));
  const hasOwner = ownerSet.size > 0;
  warn("OWNER_FIRST_INVALID_OWNER_IDS", resolved.invalid);
  warn("OWNER_FIRST_OWNER_HINT_IGNORED", resolved.ignoredHint);

  const surfaces = Object.fromEntries(SURFACES.map((surface) => [surface, "unchanged"]));
  let targets = { mode: "unresolved", evidence: "none", derived: 0, written: 0, retainedExisting: 0,
    droppedArchived: 0, droppedOutsideDerivation: 0, droppedDenied: 0,
    groupsUnknownAccounts: 0, noJoinedGroupsAccounts: 0, ineligibleAccounts: 0, existingInvalid: 0, deniedListPresent: false };
  let legacy = { removed: [], retained: [] };
  let notificationReport = { times: "unchanged", timezone: "unchanged" };
  const ignoredScopes = [];

  if (!hasOwner) {
    // No verified real owner => upgrade nothing, enable nothing, remove nothing.
    for (const surface of SURFACES) surfaces[surface] = "no-owner";
    warn("OWNER_FIRST_NO_OWNER");
  } else {
    // ---- memory.people ------------------------------------------------------
    if (!isObject(draft.memory)) draft.memory = {};
    const people = isObject(draft.memory.people) ? draft.memory.people : (draft.memory.people = {});
    if (declared("people") || (people.enabled === false && !firstRun)) {
      people.enabled = false;
      surfaces["memory.people"] = "respected-opt-out";
    } else {
      people.enabled = true;
      surfaces["memory.people"] = "enabled";
    }

    // ---- derive owner targets (nothing is written yet) ----------------------
    const entries = accountEntries(draft);
    const evidence = joinedGroupsEvidence(options.verifiedGroupsByAccount);
    const policy = targetGroupPolicy(draft);
    const deny = denyList(draft);
    const controlWasPresent = isObject(draft.ownerControl);
    const control = controlWasPresent ? draft.ownerControl : (draft.ownerControl = {});
    // Present-but-empty is a deliberate "no group authorised" restriction, not a
    // hole to fill: normalizeOwnerControl documents [] as "never all groups".
    const existing = normalizeExistingTargets(control.allowedTargets, controlWasPresent);
    warn("OWNER_FIRST_EXISTING_TARGETS_INVALID", existing.invalid);
    warn("OWNER_FIRST_DENYLIST_UNSUPPORTED", deny.present && !deny.ok ? 1 : 0);
    if (!deny.present) warn("OWNER_FIRST_DENYLIST_ABSENT");
    if (evidence.reason) warn(evidence.reason === "unsupported" ? "OWNER_FIRST_GROUPS_UNSUPPORTED" : "OWNER_FIRST_GROUPS_ABSENT");
    warn("OWNER_FIRST_GROUP_SCOPE_DISABLED", policy.disabled ? 1 : 0);

    const derived = deny.ok ? deriveTargets({ entries, evidence, policy, deny }) : { pairs: new Map(), stats: null };
    const derivedPairs = sortPairs([...derived.pairs.values()]);
    const derivedSet = new Set(derivedPairs.map((pair) => pairKey(pair.accountId, pair.groupId)));
    const accountById = new Map(entries.map((entry) => [entry.id, entry]));

    // Structural restrictions apply to already-explicit pairs too: the runtime
    // config writer refuses a target outside the account scope or targetGroups,
    // so keeping one would only make the stored config unloadable. A merely
    // paused/offline account is NOT a structural restriction — its readable
    // target metadata stays for when it returns.
    const restrictPair = (pair) => {
      const entry = accountById.get(pair.accountId);
      if (!entry || entry.archived) return "archived";
      const scope = groupScope(entry);
      if (!scope.groups || scope.mode === null) return "account-scope-off";
      if (scope.mode === "allowlist" && !scope.ids.includes(pair.groupId)) return "outside-account-scope";
      if (entry.sendTypes.text !== true) return "text-send-disabled";
      if (!policy.dynamic && !policy.explicit.has(pair.groupId)) return "outside-target-groups";
      if (deny.ok && (deny.groups.has(pair.groupId) || (deny.accounts.get(pair.accountId) || new Set()).has(pair.groupId))) return "denied";
      return "";
    };

    const dropped = { archived: 0, denied: 0, outsideDerivation: 0, outsideScope: 0 };
    // A deny list we cannot read must not be treated as "no deny list": fail
    // closed by leaving whatever explicit targets the user already has.
    const denyBlocked = deny.present && !deny.ok;

    // A present-but-empty `allowedTargets` is ambiguous, and the two readings
    // have opposite consequences, so they are separated by the `enabled` switch:
    //   - ENABLED control + present [] + targetMode explicit/absent: the owner
    //     chose zero targets on purpose. Keep [] and keep explicit mode.
    //   - DISABLED control + []: the shipped template `{enabled:false,
    //     naturalLanguage:false, allowedTargets:[]}` (or a superseded shape).
    //     Nothing is being restricted by the [] — `enabled:false` already blocks
    //     everything — so this is eligible to auto-inherit per the taskbook.
    //   - Absent, or targetMode:"inherited": explicit delegation, derive.
    const modeDeclared = control.targetMode === "inherited";
    const explicitEmpty = control.enabled === true && existing.present && existing.targets.length === 0 && !modeDeclared;
    let finalTargets = [];
    if (denyBlocked) {
      finalTargets = existing.targets.slice();
    } else if (explicitEmpty) {
      // keep [] exactly
    } else if (existing.targets.length) {
      // Explicit user data is intersected, never replaced or expanded. Without
      // joined-group evidence there is nothing to intersect against, so valid
      // explicit pairs survive instead of being silently dropped.
      for (const pair of existing.targets) {
        const reason = restrictPair(pair);
        if (reason === "archived") { dropped.archived += 1; continue; }
        if (reason === "denied") { dropped.denied += 1; continue; }
        if (reason) { dropped.outsideScope += 1; continue; }
        // Intersect only where we actually have joined-group evidence. Without
        // evidence for that account the pair is unknown, not disproven.
        if (evidence.map.has(pair.accountId) && !derivedSet.has(pairKey(pair.accountId, pair.groupId))) { dropped.outsideDerivation += 1; continue; }
        finalTargets.push(pair);
      }
    } else {
      for (const pair of derivedPairs) finalTargets.push(pair);
    }
    finalTargets = sortPairs(finalTargets);
    const concrete = finalTargets.length > 0 && derivedPairs.length > 0
      && finalTargets.length === derivedPairs.length && finalTargets.every((pair) => derivedSet.has(pairKey(pair.accountId, pair.groupId)));
    // A zero-target restriction keeps EXPLICIT mode: reporting it as "inherited"
    // would tell the runtime to go discover the very groups the owner excluded.
    // Anything else with no resolved pairs is unresolved, which is what
    // "inherited" (runtime dynamic resolution) is for.
    const mode = explicitEmpty ? "explicit"
      : finalTargets.length ? (concrete ? "concrete" : "configured") : "inherited";

    const controlOptOut = declared("ownerControl") || (control.enabled === false && !firstRun);
    const usageOptOut = declared("usageEnabled") || (control.usageEnabled === false);
    const naturalLanguageOptOut = declared("naturalLanguage") || (control.naturalLanguage === false && !firstRun);
    // `lowRiskDirect` shipped default-false in no older template: it is new in
    // 3.4, so a `false` there is always an owner decision, not a template value.
    const lowRiskOptOut = declared("lowRiskDirect") || control.lowRiskDirect === false;

    if (controlOptOut) {
      control.enabled = false;
      surfaces.ownerControl = "respected-opt-out";
      warn("OWNER_FIRST_OWNER_CONTROL_OPT_OUT_KEPT");
    } else {
      control.enabled = true;
      // A denial must be WRITTEN, not just reported: `normalizeOwnerControl`
      // defaults usageEnabled to true and `bridge.js` gates the ledger on a
      // strict `=== false`, so omitting the key silently records usage anyway.
      if (naturalLanguageOptOut) { control.naturalLanguage = false; warn("OWNER_FIRST_NATURAL_LANGUAGE_OPT_OUT_KEPT"); }
      else control.naturalLanguage = true;
      if (usageOptOut) { control.usageEnabled = false; warn("OWNER_FIRST_USAGE_OPT_OUT_KEPT"); }
      else control.usageEnabled = true;
      surfaces.ownerControl = "enabled";
    }
    // Allowed targets are metadata, not authority: a stop/quiet/denied control
    // keeps them readable so the owner can see what *would* be handled. Only the
    // `enabled` switch (and the runtime scope/quiet gates) prohibit the send.
    // In the fail-closed branch `finalTargets` is the untouched explicit list, so
    // this assignment is a no-op there rather than a silent rewrite.
    control.allowedTargets = finalTargets.map((pair) => ({ accountId: pair.accountId, groupId: pair.groupId }));

    // `lowRiskDirect` skips the owner's SECOND confirmation for allowlisted
    // writes, so a denial must survive: an explicit `false` (or host denial) is
    // written as false and never deleted, because deleting it would let
    // `normalizeOwnerControl` re-default the gate open on the next read.
    if (lowRiskOptOut) {
      control.lowRiskDirect = false;
      warn("OWNER_FIRST_LOW_RISK_OPT_OUT_KEPT");
    } else if (controlOptOut) {
      // The control is off, so this gate grants nothing either way. Preserve a
      // prior readable choice and never invent `true` on a disabled surface.
      if (!own(control, "lowRiskDirect")) warn("OWNER_FIRST_LOW_RISK_UNSET_ON_DISABLED_CONTROL");
    } else {
      control.lowRiskDirect = true;
    }

    // `targetMode` is live in `normalizeOwnerControl()` now (explicit|inherited),
    // so it is written for real rather than described as pending:
    //   inherited — nothing could be resolved statically, let the trusted host
    //               resolve targets dynamically at runtime;
    //   explicit  — we have the owner's own list, including a deliberate [].
    // A pre-existing owner choice is preserved unless it is the template default.
    const previousMode = control.targetMode;
    if (previousMode === "explicit" || previousMode === "inherited") {
      if (previousMode !== (mode === "inherited" ? "inherited" : "explicit")) {
        warn("OWNER_FIRST_TARGET_MODE_PRESERVED");
      }
      control.targetMode = previousMode;
    } else {
      control.targetMode = mode === "inherited" ? "inherited" : "explicit";
    }

    // `written` is the authoritative list length actually assigned below, and
    // `retainedExisting` counts how many of those the owner already had, so the
    // two are disjoint descriptions rather than contradictory ones.
    const existingKeys = new Set(existing.targets.map((pair) => pairKey(pair.accountId, pair.groupId)));
    const retainedCount = finalTargets.filter((pair) => existingKeys.has(pairKey(pair.accountId, pair.groupId))).length;
    targets = { mode, evidence: evidence.ok ? "trusted-host" : evidence.reason,
      derived: derivedPairs.length, written: finalTargets.length,
      newlyDerived: finalTargets.length - retainedCount, denyBlocked,
      retainedExisting: retainedCount,
      droppedArchived: dropped.archived, droppedDenied: dropped.denied,
      droppedOutsideDerivation: dropped.outsideDerivation, droppedOutsideScope: dropped.outsideScope,
      groupsUnknownAccounts: derived.stats?.groupsUnknownAccounts ?? 0,
      noJoinedGroupsAccounts: derived.stats?.noJoinedGroupsAccounts ?? 0,
      ineligibleAccounts: derived.stats?.ineligibleAccounts ?? 0,
      existingInvalid: existing.invalid,
      deniedListPresent: deny.present && deny.ok };
    warn("OWNER_FIRST_DENIED_PAIRS_SKIPPED", derived.stats?.denied ?? 0);
    warn("OWNER_FIRST_PAIRS_OUTSIDE_TARGET_GROUPS", derived.stats?.outsideTargetGroups ?? 0);

    // ---- ownerNotifications -------------------------------------------------
    const notifications = isObject(draft.ownerNotifications) ? draft.ownerNotifications : (draft.ownerNotifications = {});
    const notificationOptOut = declared("ownerNotifications") || (notifications.enabled === false && !firstRun);
    const previousTimezone = notifications.timezone;
    const times = resolveNotificationTimes(notifications.times);
    const timezoneKept = validTimezone(previousTimezone);

    notifications.enabled = !notificationOptOut;
    // Custom or stricter times survive verbatim; nothing is ever added.
    notifications.times = times.times;
    notifications.timezone = timezoneKept ? previousTimezone : DEFAULT_TIMEZONE;
    surfaces.ownerNotifications = notificationOptOut ? "respected-opt-out" : "enabled";
    warn("OWNER_FIRST_TIMEZONE_RESET", !timezoneKept && previousTimezone !== undefined ? 1 : 0);
    warn("OWNER_FIRST_TIMES_RESET", times.state === "invalid-reset-default" ? 1 : 0);
    notificationReport = { times: times.state, timezone: timezoneKept ? "preserved" : previousTimezone === undefined ? "default" : "reset" };

    // Recipients are candidates, not authority; the runtime re-verifies them.
    // Never invent a recipient from anything but the real owner list, and never
    // keep an address that is not a real owner as if it were one.
    const configuredRecipients = legacyRecipients({ recipients: notifications.recipients });
    if (configuredRecipients.length) {
      const kept = configuredRecipients.filter(isOwner);
      if (kept.length !== configuredRecipients.length) warn("OWNER_FIRST_NOTIFICATION_RECIPIENTS_FILTERED", configuredRecipients.length - kept.length);
      notifications.recipients = kept.length ? kept : resolved.owners.slice();
    } else if (!Array.isArray(notifications.recipients) || !notifications.recipients.length) {
      notifications.recipients = resolved.owners.slice();
    }

    // ---- legacy owner-report sources ---------------------------------------
    // Only when the center actually takes over. If the owner opted out of the
    // center, the old reports stay: silencing them would lose real reporting.
    if (surfaces.ownerNotifications === "enabled") {
      legacy = migrateLegacySources(draft, { isOwner, removed: [], retained: [] });
    } else {
      legacy.retained.push({ source: "legacy-owner-reports", reason: "owner-notification-center-opted-out" });
    }

    // ---- metadata -----------------------------------------------------------
    const meta = { ...(isObject(draft.ownerFirst) ? draft.ownerFirst : {}) };
    meta.version = OWNER_FIRST_VERSION;
    meta.ownerSource = "privateChats.ownerUserIds";
    meta.targetResolution = mode;
    // Recomputed every run so the metadata always describes the current config.
    meta.enabledSurfaces = SURFACES.filter((surface) => surfaces[surface] === "enabled");
    const respected = SURFACES.filter((surface) => surfaces[surface] === "respected-opt-out");
    if (respected.length) meta.respectedOptOuts = respected; else delete meta.respectedOptOuts;
    // Persist the MERGED denial map (previous state + this run's hint), never
    // just this run's argument: dropping it here is what let run 2 erase a
    // denial so run 3 re-enabled the surface. One entry per denied key is enough,
    // the value switches already carry the actual decision.
    const durableOptOuts = {};
    for (const key of Object.keys(optOuts).sort()) if (optOuts[key] === true) durableOptOuts[key] = true;
    if (Object.keys(durableOptOuts).length) meta.optOuts = durableOptOuts;
    else delete meta.optOuts;
    // Nothing is ever deferred now, so a stale marker from an older build is
    // actively cleared instead of being left to confuse the next reader.
    delete meta.pendingSchemaFields;
    if (mode === "inherited") meta.targetsUnresolvedReason = evidence.ok ? "no-eligible-pairs" : `${evidence.reason}-evidence`;
    else delete meta.targetsUnresolvedReason;
    draft.ownerFirst = meta;

    // Non-authoritative scopes: counted only, so a social/proactive conversation
    // list is never mistaken for message-processing authority.
    const ignored = new Map();
    for (const entry of entries) {
      for (const [source, values] of [["socialAgent.conversationIds", entry.item.socialAgent?.conversationIds],
        ["socialExperience.conversationIds", entry.item.socialExperience?.conversationIds]]) {
        const count = Array.isArray(values) ? values.length : 0;
        if (count) ignored.set(source, (ignored.get(source) || 0) + count);
      }
    }
    for (const [source, count] of [...ignored.entries()].sort((a, b) => a[0].localeCompare(b[0]))) ignoredScopes.push({ source, count });
  }

  const changedPathsList = changedPaths(config, draft).sort();
  const changed = changedPathsList.length > 0;
  const report = {
    version: OWNER_FIRST_VERSION,
    status: !hasOwner ? "no-owner" : changed ? "applied" : "noop",
    changed,
    changedPaths: changedPathsList,
    owner: { source: "privateChats.ownerUserIds", verifiedOwnerCount: ownerSet.size,
      invalidConfigured: resolved.invalid, ignoredHintCount: resolved.ignoredHint },
    surfaces,
    targets,
    notifications: notificationReport,
    legacy: { removed: legacy.removed, retained: legacy.retained },
    pendingSchemaFields: [],
    ignoredScopes,
    warnings: [...warnings.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code))
  };
  return { changed, config: draft, report };
}

/** Read-only preview helper: never throws on ordinary bad data. */
export function previewOwnerFirstMigration(config, options = {}) {
  try {
    return { ok: true, ...migrateOwnerFirstConfig(config, options) };
  } catch (error) {
    return { ok: false, code: typeof error?.code === "string" ? error.code : "OWNER_FIRST_MIGRATION_FAILED" };
  }
}
