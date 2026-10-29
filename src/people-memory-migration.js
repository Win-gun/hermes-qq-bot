/**
 * Bounded, progressive legacy-canonical -> person-memory migration helper.
 *
 * This module is NOT a second writer. It never touches `root` itself: every
 * accepted fact is published by `recordPersonEvidence` from people-memory.js,
 * the same mutation function the live intake path uses, so tombstones, freeze,
 * correction lineage, capacity refusals, revision fences and the durable
 * publish contract all apply unchanged.
 *
 * Scope contract (deliberately narrower than "merge the old portraits"):
 * - Only `groups[jobKey].users[QQ].canonicalMemory.entries` are considered.
 *   Legacy `profile`/`preferences`/`memories`/summary arrays are NEVER read or
 *   concatenated: an old portrait is not evidence and has no provenance.
 * - Only EXACT host-authenticated source tuples become evidence. For every
 *   canonical `sourceMessageId` there must be a real
 *   `groups[jobKey].peopleSourceIndex[messageId][logicalBotId]` receipt with
 *   `{accountId, conversationId, verifiedSenderId === subject, time}`. Missing,
 *   mismatched, conflicting or future tuples are rejected with a visible count.
 * - Only the physical/logical carrier that actually RECEIVED the message is
 *   used. This helper never invents an observing carrier, never reattributes a
 *   source to another bot, and never borrows another bot's index.
 * - The host must pass a synchronous `eligible(...)` seam (no IO) that attests
 *   the logical bot + account + conversation + subject scope is currently
 *   authorized. Anything other than a literal `true` is rejected.
 * - Self-reported evidence (`entry.selfEvidence`) is derived ONLY from the
 *   host-authored canonical marker `selfExplicitAt` when that exact timestamp is
 *   one of the authenticated sources. Model prose and helper flags cannot
 *   manufacture it.
 *
 * Boundedness: each call scans at most `PEOPLE_MIGRATION_LIMITS.scanEntries`
 * canonical entries and performs at most `PEOPLE_MIGRATION_LIMITS.writes`
 * source writes, then returns a resumable `cursor`. Persist that cursor; a
 * restart resumes at the same deterministic (jobKey,userId,entryIndex)
 * position and re-running already-imported sources is a no-op (DUPLICATE).
 */

import { PEOPLE_MEMORY_LIMITS, recordPersonEvidence } from "./people-memory.js";

export const PEOPLE_MIGRATION_LIMITS = Object.freeze({
  writes: 64, scanEntries: 512, scanGroups: 512, scanPeople: 1024, sourcesPerEntry: 16,
  rejectionReasons: 32, appliedPerCall: 64
});

const KIND_MAP = Object.freeze({ profile: "stable_fact", stable_fact: "stable_fact",
  preference: "preference", alias: "alias", boundary: "boundary" });
const SELF_REPORTED_KINDS = Object.freeze(new Set(["stable_fact", "preference", "alias"]));
const DURABLE_KINDS = Object.freeze(new Set(["alias", "stable_fact", "preference", "boundary"]));
const SOURCE_SCOPES = Object.freeze(new Set(["public", "conversation", "private"]));
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
const qq = value => (typeof value === "number" && Number.isSafeInteger(value) ? String(value)
  : typeof value === "string" && /^[1-9]\d{4,19}$/.test(value) ? value : null);
const identifier = value => (typeof value === "number" && Number.isSafeInteger(value) ? String(value)
  : typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value) && !RESERVED.has(value) ? value : null);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === "string"
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
function list(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false;
  return Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, "value")).every(Boolean);
}
/** Zoned ISO or epoch-ms only; seconds must be marked explicitly by the caller. */
function timestamp(value, seconds = false) {
  let number;
  if (typeof value === "number" && Number.isFinite(value)) number = seconds ? value * 1000 : value;
  else if (typeof value === "string") number = Date.parse(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 253402300799999 ? number : null;
}

/**
 * Job key -> {scope, logicalOwner}. Mirrors applyPersonExtractionReceipt: bare
 * numeric group jobs keep their exact lookup key but transport as group:<QQ>,
 * and scoped private jobs transport as private:<QQ> while requiring that exact
 * logical suffix to own the source index entry.
 */
export function legacyJobScope(jobKey) {
  if (typeof jobKey !== "string") return null;
  const scoped = /^private:([1-9]\d{4,19})(?::(?:(group):)?([A-Za-z][A-Za-z0-9_-]{0,63}))?$/.exec(jobKey);
  if (scoped) {
    const owner = scoped[3];
    if (owner && (RESERVED.has(owner) || Object.hasOwn(Object.prototype, owner))) return null;
    return { scope: `private:${scoped[1]}`, subject: scoped[1],
      logicalOwner: owner ? `${scoped[2] ? "group" : "account"}:${owner}` : null, accountOnly: Boolean(owner && !scoped[2]) };
  }
  if (/^(?:group:)?[1-9]\d{4,19}$/.test(jobKey)) {
    const groupId = jobKey.startsWith("group:") ? jobKey.slice(6) : jobKey;
    return { scope: `group:${groupId}`, subject: null, logicalOwner: null, accountOnly: false };
  }
  return null;
}

function emptyStats() {
  return { groups: 0, people: 0, entries: 0, imported: 0, verifiable: 0, sources: 0, skipped: 0,
    unverifiable: 0, reasons: {} };
}
function emptyCursor() { return { jobKey: null, userId: null, entryIndex: 0, done: false }; }
function normalizeCursor(cursor) {
  if (cursor === undefined || cursor === null) return emptyCursor();
  if (!plain(cursor) || (cursor.jobKey !== null && typeof cursor.jobKey !== "string")
    || (cursor.userId !== null && qq(cursor.userId) === null) || !safeInt(cursor.entryIndex)
    || typeof cursor.done !== "boolean") return null;
  return { jobKey: cursor.jobKey, userId: cursor.userId === null ? null : qq(cursor.userId),
    entryIndex: cursor.entryIndex, done: cursor.done };
}
function count(stats, reason) {
  if (Object.keys(stats.reasons).length < PEOPLE_MIGRATION_LIMITS.rejectionReasons || Object.hasOwn(stats.reasons, reason)) {
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
  } else stats.reasons.OTHER = (stats.reasons.OTHER ?? 0) + 1;
  stats.unverifiable += 1;
}

/** Sorted, bounded scan order so a persisted index cursor survives restarts. */
function scanOrder(root) {
  const groups = own(root, "groups");
  if (!plain(groups)) return null;
  const keys = Object.keys(groups).filter(key => legacyJobScope(key) !== null).sort()
    .slice(0, PEOPLE_MIGRATION_LIMITS.scanGroups);
  return keys.map(jobKey => ({ jobKey, group: own(groups, jobKey), job: legacyJobScope(jobKey) }));
}

function passFor(canonicalEntry, kind, scope, authenticated) {
  const selfExplicitAt = timestamp(canonicalEntry.selfExplicitAt);
  // Self-report needs public group text; a private/relationship source can
  // never be promoted to public even with a trusted marker.
  const selfReportedAt = scope.startsWith("group:") && canonicalEntry.status === "active"
    && SELF_REPORTED_KINDS.has(kind) && selfExplicitAt !== null
    && authenticated.some(source => timestamp(source.time, true) === selfExplicitAt)
    ? selfExplicitAt : null;
  const publicStable = scope.startsWith("group:")
    && canonicalEntry.status === "active" && typeof canonicalEntry.confidence === "number"
    && canonicalEntry.confidence >= 0.8 && canonicalEntry.source === "ai-extraction"
    && !canonicalEntry.correctedAt && !canonicalEntry.supersedes;
  const privacy = scope.startsWith("private:") ? "private" : publicStable || selfReportedAt !== null ? "public" : "conversation";
  if (!SOURCE_SCOPES.has(privacy)) return null;
  return { privacy, selfReportedAt,
    confidence: canonicalEntry.status === "active" && typeof canonicalEntry.confidence === "number"
      ? Math.min(1, Math.max(0, canonicalEntry.confidence)) : 0.5 };
}

/**
 * One bounded, resumable migration step. Pure synchronous, no IO.
 * -> {ok, changed, complete, reason, revision, cursor, stats, applied:[{jobKey,
 *     subjectUserId,kind,logicalBotId,entryId,sourceCount}], rejected:[{jobKey,
 *     subjectUserId,kind,reason,logicalBotId?}]}
 * `complete` requires BOTH a finished cursor and zero rejections: unverifiable
 * legacy history is reported as counts, never as success.
 */
export function migrateLegacyCanonicalPeople(root, args = {}) {
  const output = { ok: false, changed: false, complete: false, reason: "INVALID_ARGUMENTS",
    revision: 0, cursor: emptyCursor(), stats: emptyStats(), applied: [], rejected: [] };
  if (!plain(root) || !plain(args)) return output;
  const now = timestamp(args.now);
  const cursor = normalizeCursor(args.cursor);
  const limit = args.limit ?? PEOPLE_MIGRATION_LIMITS.writes;
  const scanEntries = args.scanEntries ?? PEOPLE_MIGRATION_LIMITS.scanEntries;
  if (now === null || typeof args.eligible !== "function" || cursor === null
    || !safeInt(limit) || limit < 1 || limit > PEOPLE_MIGRATION_LIMITS.writes
    || !safeInt(scanEntries) || scanEntries < 1 || scanEntries > PEOPLE_MIGRATION_LIMITS.scanEntries) {
    return { ...output, reason: typeof args.eligible !== "function" ? "NO_ELIGIBILITY_SEAM" : "INVALID_ARGUMENTS" };
  }
  if (plain(own(root, "peopleMemory"))) {
    const revision = own(root.peopleMemory, "revision");
    if (safeInt(revision)) output.revision = revision;
  }
  const order = scanOrder(root);
  if (order === null) return { ...output, reason: "INVALID_STATE" };
  const stats = output.stats;
  let writes = 0, scanned = 0, next = null, done = false;
  const reject = (entry, reason, logicalBotId) => {
    count(stats, reason);
    if (output.rejected.length < PEOPLE_MIGRATION_LIMITS.appliedPerCall) output.rejected.push({
      jobKey: entry.jobKey, subjectUserId: entry.subjectUserId, kind: entry.canonical.kind,
      reason, ...(logicalBotId === undefined ? {} : { logicalBotId }) });
  };
  for (const { jobKey, group, job } of order) {
    // Resume: skip whole job keys strictly before the persisted cursor.
    if (cursor.jobKey !== null && jobKey < cursor.jobKey) continue;
    stats.groups += 1;
    const users = group === null || typeof group !== "object" ? null : own(group, "users");
    const index = group === null || typeof group !== "object" ? null : own(group, "peopleSourceIndex");
    const people = plain(users) ? Object.keys(users).filter(key => qq(key) !== null).sort()
      .slice(0, PEOPLE_MIGRATION_LIMITS.scanPeople) : [];
    for (const userId of people) {
      if (cursor.jobKey === jobKey && cursor.userId !== null && userId < cursor.userId) continue;
      stats.people += 1;
      const holder = own(users, userId), canonical = plain(holder) ? own(holder, "canonicalMemory") : null;
      if (!plain(canonical) || qq(canonical.subjectUserId) !== userId
        || !list(canonical.entries, PEOPLE_MIGRATION_LIMITS.scanEntries)) continue;
      for (let entryIndex = 0; entryIndex < canonical.entries.length; entryIndex++) {
        if (cursor.jobKey === jobKey && cursor.userId === userId && entryIndex < cursor.entryIndex) continue;
        if (scanned >= scanEntries || writes >= limit) { next = { jobKey, userId, entryIndex, done: false }; break; }
        scanned += 1;
        stats.entries += 1;
        const canonicalEntry = canonical.entries[entryIndex];
        const entry = { jobKey, subjectUserId: userId, canonical: canonicalEntry };
        if (!plain(canonicalEntry)) { reject(entry, "MALFORMED_CANONICAL"); continue; }
        const kind = KIND_MAP[canonicalEntry.kind];
        if (kind === undefined) { reject(entry, "UNSUPPORTED_KIND"); continue; }
        if (typeof canonicalEntry.value !== "string") { reject(entry, "UNSUPPORTED_VALUE"); continue; }
        if (canonicalEntry.correctedAt || canonicalEntry.supersedes) { reject(entry, "TERMINAL_CORRECTION"); continue; }
        if (!["active", "tentative"].includes(canonicalEntry.status)) { reject(entry, "UNSUPPORTED_STATUS"); continue; }
        if (!plain(index)) { reject(entry, "NO_SOURCE_INDEX"); continue; }
        const ids = canonicalEntry.sourceMessageIds;
        if (!list(ids, PEOPLE_MIGRATION_LIMITS.sourcesPerEntry) || !ids.length
          || !ids.every(id => identifier(id) !== null) || new Set(ids.map(String)).size !== ids.length
          || !list(canonicalEntry.evidenceKeys, PEOPLE_MIGRATION_LIMITS.sourcesPerEntry)
          || !ids.every(id => canonicalEntry.evidenceKeys.includes(JSON.stringify([jobKey, String(id)])))) {
          reject(entry, "UNVERIFIABLE_SOURCES"); continue;
        }
        // Exact per-bot receipt tuples only. A shared job may serve several
        // bots, but each bot must own EVERY source and never borrow another's.
        const owners = ids.map(id => own(index, String(id)));
        if (owners.some(owner => !plain(owner) || !Object.keys(owner).length
          || Object.keys(owner).length > PEOPLE_MEMORY_LIMITS.bots)) { reject(entry, "NO_SOURCE_INDEX"); continue; }
        const bots = [...new Set(owners.flatMap(owner => Object.keys(owner)))].sort();
        if (!bots.length || bots.length > PEOPLE_MEMORY_LIMITS.bots) { reject(entry, "SOURCE_OWNER_CAPACITY"); continue; }
        for (const logicalBotId of bots) {
          if (identifier(logicalBotId) === null || (job.logicalOwner !== null && logicalBotId !== job.logicalOwner)) {
            reject(entry, "SOURCE_OWNER_MISMATCH", logicalBotId); continue;
          }
          const sources = owners.map(owner => own(owner, logicalBotId));
          if (sources.some(source => !plain(source) || identifier(source.accountId) === null
            || (job.accountOnly && source.accountId !== job.logicalOwner.split(":")[1])
            || source.conversationId !== job.scope || qq(source.verifiedSenderId) !== userId
            || timestamp(source.time, true) === null || timestamp(source.time, true) > now)) {
            reject(entry, "SOURCE_OWNER_MISMATCH", logicalBotId); continue;
          }
          const plan = passFor(canonicalEntry, kind, job.scope, sources);
          if (plan === null) { reject(entry, "UNSUPPORTED_SCOPE", logicalBotId); continue; }
          // Host scope seam: literal true only, evaluated once per bot tuple.
          let allowed = false;
          try { allowed = args.eligible(Object.freeze({ logicalBotId, accountId: sources[0].accountId,
            conversationId: job.scope, subjectUserId: userId, jobKey })) === true; }
          catch { allowed = false; }
          if (!allowed) { reject(entry, "INELIGIBLE_SCOPE", logicalBotId); continue; }
          // Atomic per entry/bot: a refused source publishes none of its IDs.
          // An already-imported source is DUPLICATE, not a failure. A fully
          // duplicate bot consumes no write budget, so a resumed pass moves on
          // to the remaining bots instead of stalling on the same entry.
          const draft = plain(own(root, "peopleMemory")) ? { peopleMemory: root.peopleMemory } : {};
          let changed = false, applied, failure, entryId;
          for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
            applied = recordPersonEvidence(draft, { logicalBotId, userId,
              verifiedSenderId: sources[sourceIndex].verifiedSenderId, accountId: sources[sourceIndex].accountId,
              conversationId: job.scope, messageId: String(ids[sourceIndex]), time: sources[sourceIndex].time,
              now, kind, value: canonicalEntry.value, confidence: plan.confidence,
              sourceType: "archive", privacy: plan.privacy,
              // Durable traits may be imported after their original TTL window
              // closed, because the live reader decays instead of deleting. The
              // ORIGINAL source time is preserved, so this is retention, never a
              // fake "now" refresh; transient kinds keep EXPIRED_SOURCE.
              retainDurable: DURABLE_KINDS.has(kind),
              selfReported: plan.selfReportedAt !== null
                && timestamp(sources[sourceIndex].time, true) === plan.selfReportedAt });
            if (!applied.ok) {
              if (applied.reason !== "DUPLICATE") { failure = applied.reason; break; }
              entryId ??= applied.entryId; continue;
            }
            changed ||= applied.changed;
            entryId = applied.entryId;
          }
          if (failure) { reject(entry, `WRITE_${failure}`, logicalBotId); continue; }
          if (!changed) { stats.skipped += 1; continue; }
          writes += 1;
          root.peopleMemory = draft.peopleMemory;
          output.changed = true;
          stats.imported += 1;
          stats.sources += ids.length;
          output.applied.push({ jobKey, subjectUserId: userId, kind, logicalBotId, entryId, sourceCount: ids.length });
          output.revision = applied.revision;
          if (writes >= limit) { next = { jobKey, userId, entryIndex, done: false }; break; }
        }
        if (next) break;
      }
      if (next) break;
    }
    if (next) break;
  }
  if (next === null) done = true;
  output.cursor = next ?? { jobKey: null, userId: null, entryIndex: 0, done: true };
  output.stats.done = output.cursor.done;
  output.ok = true;
  output.reason = done ? (stats.unverifiable ? "DONE_WITH_REJECTIONS" : "DONE") : "STEP";
  output.complete = done && stats.unverifiable === 0;
  return output;
}

/**
 * Read-only progress statistics for the parent bridge. Never mutates `root`,
 * never writes, never projects values. Use it to show owners how much legacy
 * history is still unmigrated and how much is unverifiable.
 */
export function peopleMigrationStats(root, args = {}) {
  const output = { ok: false, reason: "INVALID_ARGUMENTS", revision: 0,
    cursor: emptyCursor(), stats: emptyStats() };
  if (!plain(root) || !plain(args)) return output;
  const cursor = normalizeCursor(args.cursor);
  if (cursor === null) return { ...output, reason: "INVALID_CURSOR" };
  if (plain(own(root, "peopleMemory"))) {
    const revision = own(root.peopleMemory, "revision");
    if (safeInt(revision)) output.revision = revision;
  }
  const order = scanOrder(root);
  if (order === null) return { ...output, reason: "INVALID_STATE" };
  const stats = output.stats;
  for (const { jobKey, group } of order) {
    if (cursor.jobKey !== null && jobKey < cursor.jobKey) continue;
    stats.groups += 1;
    const users = group === null || typeof group !== "object" ? null : own(group, "users");
    if (!plain(users)) continue;
    for (const userId of Object.keys(users).filter(key => qq(key) !== null).sort()
      .slice(0, PEOPLE_MIGRATION_LIMITS.scanPeople)) {
      if (cursor.jobKey === jobKey && cursor.userId !== null && userId < cursor.userId) continue;
      stats.people += 1;
      const holder = own(users, userId), canonical = plain(holder) ? own(holder, "canonicalMemory") : null;
      if (!plain(canonical) || qq(canonical.subjectUserId) !== userId
        || !list(canonical.entries, PEOPLE_MIGRATION_LIMITS.scanEntries)) continue;
      for (let entryIndex = 0; entryIndex < canonical.entries.length; entryIndex++) {
        if (cursor.jobKey === jobKey && cursor.userId === userId && entryIndex < cursor.entryIndex) continue;
        stats.entries += 1;
        const canonicalEntry = canonical.entries[entryIndex];
        if (!plain(canonicalEntry)) { count(stats, "MALFORMED_CANONICAL"); continue; }
        if (KIND_MAP[canonicalEntry.kind] === undefined) { count(stats, "UNSUPPORTED_KIND"); continue; }
        if (typeof canonicalEntry.value !== "string") { count(stats, "UNSUPPORTED_VALUE"); continue; }
        if (canonicalEntry.correctedAt || canonicalEntry.supersedes) { count(stats, "TERMINAL_CORRECTION"); continue; }
        if (!["active", "tentative"].includes(canonicalEntry.status)) { count(stats, "UNSUPPORTED_STATUS"); continue; }
        const index = group === null || typeof group !== "object" ? null : own(group, "peopleSourceIndex");
        if (!plain(index)) { count(stats, "NO_SOURCE_INDEX"); continue; }
        const ids = canonicalEntry.sourceMessageIds;
        if (!list(ids, PEOPLE_MIGRATION_LIMITS.sourcesPerEntry) || !ids.length
          || !ids.every(id => identifier(id) !== null)
          || !list(canonicalEntry.evidenceKeys, PEOPLE_MIGRATION_LIMITS.sourcesPerEntry)
          || !ids.every(id => canonicalEntry.evidenceKeys.includes(JSON.stringify([jobKey, String(id)])))) {
          count(stats, "UNVERIFIABLE_SOURCES"); continue;
        }
        if (ids.some(id => { const owner = own(index, String(id));
          return !plain(owner) || !Object.keys(owner).length; })) { count(stats, "NO_SOURCE_INDEX"); continue; }
        // Verifiable candidate. This function never writes, so it cannot claim
        // the entry is imported; migration reports that separately.
        stats.verifiable += 1;
      }
    }
  }
  output.cursor = { ...cursor };
  output.ok = true;
  output.reason = "STATS";
  return output;
}
