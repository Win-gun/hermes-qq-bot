import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { canonicalMemoryFields } from "./memory-integrity.js";
import { legacyJobScope } from "./people-memory-migration.js";
import { personMemoryControl, recordPersonEvidence, verifyPublicSelfStatement } from "./people-memory.js";
import { redactText, sanitizeArchiveValue } from "./privacy-filter.js";

/**
 * Hermes 3.5 reconstruction: no repository, config, network, timers or sends.
 * Only the optional pager reads files, and ONLY its explicit immutable manifest.
 * All mutations below take a PRIVATE latest MemoryRuntime.transact draft.
 * Never pass MemoryRuntime.value to a mutation helper. No second writer exists.
 *
 * Host integration (not installed here):
 *   const pager = createPeopleReconstructionPager({ memory: pinnedSnapshot,
 *     sourceId: snapshotId, archives: [{ id, path, conversationId, size, ino }] });
 *   const runner = createPeopleReconstructionRunner({ getState: () => runtime.value,
 *     transact: build => runtime.transact(build), readPage: pager.readPage,
 *     eligible: exactHistoricalAndCurrentScopeCheck,
 *     model: async ({ candidates, signal, maxTokens }) => ({
 *       groups: [{ ids: [candidateId], summary: '...', conflict: false }],
 *       usage: { inputTokens, outputTokens, totalTokens } }) });
 *   await runner.recover(); // startup, before scheduling; orphan claims -> UNKNOWN
 *   await runner.start({ authorized: true, id, sourceId: snapshotId });
 *   await runner.step(); // ONE bounded page; schedule OUTSIDE the reply queue
 *   // After source cursor is done: operator/CAS gated, existing budget only.
 *   await runner.control({ authorized:true, operation:'resume_semantics',
 *     expectedRevision:runner.status().revision, maxSemanticCalls:1 });
 *   await runner.step(); // <=16 adaptive, exact-scope representatives; <=1 call
 *
 * `eligible(tuple)` is synchronous, literal true only. It must authenticate the
 * HISTORICAL bot/account receipt AND current access, not map a historical QQ or
 * physical account to today's owner. For bot-less group candidates it must
 * explicitly accept logicalBotId:null; private unknown-owner rows are never used.
 * All input rows/readPage/model are host seams, not tools granted to a chat model.
 * Each model context is ONE QQ + ONE conversation + ONE historical bot/null;
 * it never mixes peer bot or private/group data. Each sub-call has its own
 * durable attemptId under the page claim. The host must use stateless calls,
 * not a shared provider conversation/session. Model input excludes suppressed
 * rows; output contains IDs + semantic proposals
 * only. Summaries NEVER become evidence, confidence, authority or experiences.
 * Only unchanged Verified canonical values may use recordPersonEvidence. All
 * other results stay in this bounded additive staging store. Existing originals,
 * timestamps, conflicts and tombstones are never rewritten or removed.
 *
 * Cursor refers to an IMMUTABLE source snapshot/manifest. Pin that snapshot in a
 * background worker, not by cloning runtime.value on the chat thread. A mutable
 * object/rotating archive is NOT a valid snapshot. The pager yields every 128
 * visited slots and reads bounded bytes/lines. It caches only one iterator/page;
 * a restart replays the memory prefix cooperatively (no model replay). No whole
 * root clone, sort, full archive index or global candidate scan is performed here.
 * MemoryRuntime itself currently clones its draft: that existing host cost is
 * NOT eliminated by this module; run large jobs off the chat thread.
 *
 * Durable claim precedes every possible model invocation. Unknown outcomes are
 * NEVER retried; explicit skip_unknown advances the pinned cursor and reports
 * unresolved rows. Resume alone cannot unlock them. Pause/cancel abort locally
 * and fence commit by control revision. Already-committing durable transactions
 * cannot be recalled. Usage totals cover reported calls only; missing/failed
 * usage remains unknown and consumes the full reserved token allowance.
 */
export const PEOPLE_RECONSTRUCTION_LIMITS = Object.freeze({
  page: 32, sources: 16, bots: 16, candidates: 24000, people: 20000,
  valueChars: 240, pageBytes: 128 * 1024, lineBytes: 64 * 1024,
  evidenceScanBytes: 2 * 1024 * 1024, semanticGroups: 32, reasons: 32,
  semanticBatch: 16, semanticRunCalls: 100, unknownRecoveryReceipts: 16, unknownRecoverySlots: 512
});
const L = PEOPLE_RECONSTRUCTION_LIMITS;
const FIELD = "peopleReconstruction";
const BAD = new Set(["__proto__", "constructor", "prototype"]);
const TIERS = ["Verified", "Supported", "Tentative", "Conflicted", "Suppressed"];
const DURABLE = new Set(["stable_fact", "preference", "alias", "boundary"]);
const SEMANTIC_CATEGORIES = new Set([...DURABLE, "quote", "episode", "uncertain", "discard"]);
const SEMANTIC_RELATIONS = new Set(["related", "duplicate", "conflict", "temporal", "withdrawal", "insufficient"]);
const TERMINAL = new Set(["deleted", "revoked", "rejected", "superseded", "suppressed"]);
const KIND = { profile: "stable_fact", ...Object.fromEntries([...DURABLE].map(k => [k, k])) };
const own = (v, k) => v && Object.hasOwn(v, k) ? v[k] : undefined;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const integer = v => Number.isSafeInteger(v) && v >= 0;
const id = v => typeof v === "number" && Number.isSafeInteger(v) ? String(v)
  : typeof v === "string" && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(v) && !BAD.has(v) ? v : null;
const qq = v => (typeof v === "string" || typeof v === "number" && Number.isSafeInteger(v))
  && /^[1-9]\d{4,19}$/.test(String(v)) ? String(v) : null;
const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const copy = v => structuredClone(v);
class ReconstructionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReconstructionError(code); };
const sync = (fn, ...args) => {
  const result = fn(...args);
  if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("ASYNC_CALLBACK"); }
  return result;
};
function time(v, seconds = false) {
  const n = typeof v === "number" ? v * (seconds ? 1000 : 1)
    : typeof v === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
  return integer(n) && n <= 253402300799999 ? n : null;
}
function text(v) {
  if (typeof v !== "string" || v.length > L.valueChars || /[\u0000-\u001f\u007f]/.test(v)) return null;
  const s = v.normalize("NFKC").replace(/\s+/g, " ").trim();
  return s && redactText(s) === s && sanitizeArchiveValue(s) === s
    && !/\[(?:已过滤|手机号|身份证|长数字|REDACTED)\]/i.test(s) ? s : null;
}
function bump(stats, reason, n = 1) {
  if (Object.hasOwn(stats.reasons, reason) || Object.keys(stats.reasons).length < L.reasons) {
    stats.reasons[reason] = (stats.reasons[reason] || 0) + n;
  } else stats.reasons.OTHER = (stats.reasons.OTHER || 0) + n;
}
const initialCursor = () => ({ phase: "memory", offset: 0, file: 0, byte: 0 });
function cursor(v) {
  if (!object(v) || !["memory", "archive", "done"].includes(v.phase)
    || ![v.offset, v.file, v.byte].every(integer)) fail("INVALID_CURSOR");
  return { phase: v.phase, offset: v.offset, file: v.file, byte: v.byte };
}
function advances(before, after) {
  const order = { memory: 0, archive: 1, done: 2 };
  if (order[after.phase] !== order[before.phase]) return order[after.phase] > order[before.phase];
  return before.phase === "memory" ? after.offset > before.offset
    : before.phase === "archive" && (after.file > before.file || (after.file === before.file && after.byte > before.byte));
}
function cursorOrder(a, b) {
  const rank = { memory: 0, archive: 1, done: 2 };
  return rank[a.phase] - rank[b.phase] || (a.phase === "memory" ? a.offset - b.offset
    : a.phase === "archive" ? a.file - b.file || a.byte - b.byte : 0);
}
// Old candidates had no per-ID exposure marker. Adopt them only if EVERY old
// attempt is accounted for by an unknown receipt, and skip the entire prefix
// through the last such page. No inference from semanticSkipped totals alone.
function semanticPlan(job) {
  let floor = initialCursor(), attempts = 0;
  const receipts = job.unknownBatches ?? [];
  if (!Array.isArray(receipts) || receipts.length > 128) fail("INVALID_UNKNOWN_LEDGER");
  const seen = new Set();
  for (const [index, receipt] of receipts.entries()) {
    const next = cursor(receipt.nextCursor);
    if (receipt.phase !== "semantics" && !recoveredUnknownMatch(job, index) && cursorOrder(next, floor) > 0) floor = next;
    if (receipt.calls) {
      for (const call of receipt.calls) {
        if (!id(call.id) || seen.has(call.id)) fail("INVALID_UNKNOWN_LEDGER");
        seen.add(call.id); attempts++;
      }
    } else if (receipt.modelStarted) attempts++;
  }
  if (job.semanticStage) return { cursor: copy(job.semanticStage.cursor), excludedPrefixThrough: floor,
    legacyPendingAllowed: job.semanticStage.legacyPendingAllowed === true,
    blockedReason: cursorOrder(job.semanticStage.cursor, floor) < 0 ? "UNKNOWN_RECOVERY_STALE" : null };
  return { cursor: floor, excludedPrefixThrough: floor, legacyPendingAllowed: attempts === job.stats.modelAttempts,
    blockedReason: attempts > job.stats.modelAttempts ? "INVALID_UNKNOWN_LEDGER" : null };
}
function semanticPending(job, candidate, plan = job.semanticStage ?? semanticPlan(job)) {
  const stored = own(job.candidates, candidate.id);
  return Boolean(stored && !unknownCandidateExcluded(job, candidate.id) && !stored.semantic && stored.tier !== "Suppressed" && stored.value
    && stored.userId === candidate.userId && stored.logicalBotId === candidate.logicalBotId
    && stored.conversationId === candidate.conversationId && stored.kind === candidate.kind && stored.value === candidate.value
    && candidate.tier !== "Suppressed" && candidate.value
    && candidate.userId && candidate.conversationId?.startsWith("group:") && candidate.origin !== "archive"
    && (stored.semanticState === "pending" || stored.semanticState === undefined && plan.legacyPendingAllowed));
}
// Reuse ONLY the attached proposal, never sources, evidence grade or time.
const semanticKey = c => hash([c.logicalBotId, c.userId, c.conversationId, c.kind, c.value]);
function reusableSemantic(root, job, c, eligible) {
  if (c.tier === "Conflicted") return null;
  const donor = own(job.candidates, own(job.semanticReuseIndex, semanticKey(c)));
  if (!donor || unknownCandidateExcluded(job, donor.id) || donor.id === c.id || semanticKey(donor) !== semanticKey(c)
    || !["completed", "reused"].includes(donor.semanticState)
    || ["Suppressed", "Conflicted"].includes(donor.tier) || !donor.semantic?.proposalOnly
    || donor.semantic.conflict || donor.semantic.ids.length !== 1
    || ["conflict", "temporal", "withdrawal"].includes(donor.semantic.relation)
    || donor.sourceBinding && currentSourceFence(root, donor.sourceBinding)
    || fence(root, donor.logicalBotId, donor.userId)
    || ["legacy", "archive"].includes(donor.origin) && archiveNegativeFence(root, donor.userId,
      donor.conversationId, donor.sourceMessageIds, donor.logicalBotId, donor.origin === "legacy")
    || sync(eligible, { logicalBotId: donor.logicalBotId, userId: donor.userId,
      conversationId: donor.conversationId, mode: "reconstruction" }) !== true) return null;
  return donor;
}
function retainUnknown(job) {
  job.unknownBatches ??= [];
  if (job.unknownBatches.length >= 128) fail("UNKNOWN_LEDGER_CAPACITY");
  job.unknownBatches.push(copy(job.claim));
}
function advanceClaim(job, claim) {
  // A semantic page can expose only one scope/subset. Quarantine its actual
  // attempted IDs, then revisit the page for unexposed candidates, never ACK
  // the entire page merely because one sub-call became uncertain.
  if (claim.phase === "semantics") job.semanticStage.cursor = copy(claim.startCursor);
  else { job.cursor = copy(claim.nextCursor); job.stats.scanned += claim.scanned; }
}
function jobAt(root) {
  const job = own(root, FIELD);
  if (job === undefined) return null;
  if (!object(job) || job.version !== 1 || !id(job.id) || !integer(job.revision)
    || !object(job.candidates) || !object(job.stats) || !object(job.people)) fail("INVALID_RECONSTRUCTION_STATE");
  return job;
}

export function peopleReconstructionUnknownLedgerBinding(root) {
  const job = jobAt(root);
  if (!job) fail("JOB_REQUIRED");
  return hash([job.id, job.sourceId, job.unknownBatches ?? []]);
}
function recoveredUnknownMatch(job, index) {
  const recovery = job.unknownPageRecovery;
  if (recovery?.version !== 1 || recovery.sourceId !== job.sourceId) return null;
  const match = recovery.matches.find(m => m.receiptIndex === index);
  return match && match.receiptHash === hash(job.unknownBatches[index]) ? match : null;
}
function unknownCandidateExcluded(job, candidateId) {
  return (job.unknownBatches ?? []).some((receipt, index) =>
    recoveredUnknownMatch(job, index)?.candidateIds.includes(candidateId)
    // New semantic claims already pin their actual exposed IDs durably. Keep
    // them excluded too if a later proof permits rewinding the source cursor.
    || receipt.phase === "semantics" && receipt.calls?.some(a => a.candidateIds?.includes(candidateId)));
}

/** Source-worker witness only. A guessed offset is NEVER evidence. Even the
 * exact same rows with a different next cursor/scanned/count do not match.
 * matchedCursor is a reproducible read start, NOT a fabricated historical one. */
export function matchPeopleReconstructionUnknownPage({ receipt, receiptIndex, receiptHash, page, matchedCursor } = {}) {
  if (!object(receipt) || !object(page) || !Array.isArray(page.rows) || page.rows.length > L.page
    || !integer(receiptIndex) || !/^[a-f0-9]{64}$/.test(receiptHash ?? "")) return null;
  const next = cursor(receipt.nextCursor), actualNext = cursor(page.nextCursor), from = cursor(matchedCursor);
  if (next.phase !== "memory" || from.phase !== "memory" || from.offset >= next.offset
    || next.offset - from.offset > L.unknownRecoverySlots || page.rows.length !== receipt.count
    || page.scanned !== receipt.scanned || hash(actualNext) !== hash(next) || hash(page.rows) !== receipt.hash) return null;
  if (page.rows.some(row => !object(row) || !id(row.key))) return null;
  const candidateIds = page.rows.map(row => `recon_${hash([row.key, row.logicalBotId ?? null])}`);
  if (new Set(candidateIds).size !== candidateIds.length) return null;
  return { receiptIndex, receiptHash, hash: receipt.hash, count: receipt.count, scanned: receipt.scanned,
    nextCursor: next, matchedCursor: from, candidateIds };
}

/** Explicit HOST adoption through the sole MemoryRuntime writer, never model
 * JSON or a public caller's supplied proof. Host obtains this packet directly
 * from its private fixed-source worker. Old receipts/costs stay untouched. */
export function applyPeopleReconstructionUnknownRecovery(root, { authorized, expectedRevision, proof } = {}) {
  if (authorized !== true) fail("UNAUTHORIZED");
  const job = jobAt(root);
  if (!job || job.revision !== expectedRevision) fail("REVISION_MISMATCH");
  if (job.claim || job.cursor.phase !== "done" || !["paused", "completed", "completed_with_limits"].includes(job.status)) fail("UNKNOWN_RECOVERY_BLOCKED");
  if (!object(proof) || proof.version !== 1 || proof.done !== true || proof.sourceId !== job.sourceId
    || proof.ledgerBinding !== peopleReconstructionUnknownLedgerBinding(root)
    || !Array.isArray(proof.matches) || proof.matches.length > L.unknownRecoveryReceipts) fail("UNKNOWN_RECOVERY_STALE");
  const seen = new Set();
  for (const match of proof.matches) {
    const receipt = job.unknownBatches?.[match?.receiptIndex];
    if (!object(match) || !integer(match.receiptIndex) || seen.has(match.receiptIndex) || !receipt
      || match.receiptHash !== hash(receipt) || match.hash !== receipt.hash || match.count !== receipt.count
      || match.scanned !== receipt.scanned || hash(cursor(match.nextCursor)) !== hash(cursor(receipt.nextCursor))
      || cursor(match.matchedCursor).phase !== "memory" || match.nextCursor.phase !== "memory"
      || match.matchedCursor.offset >= match.nextCursor.offset
      || match.nextCursor.offset - match.matchedCursor.offset > L.unknownRecoverySlots
      || !Array.isArray(match.candidateIds) || match.candidateIds.length !== receipt.count
      || match.candidateIds.length > L.page || new Set(match.candidateIds).size !== match.candidateIds.length
      || match.candidateIds.some(key => !/^recon_[a-f0-9]{64}$/.test(key))) fail("INVALID_UNKNOWN_RECOVERY");
    seen.add(match.receiptIndex);
  }
  if (!proof.matches.length) fail("NO_UNKNOWN_MATCHES");
  // Additive metadata only; no rewrite of receipt/startCursor or schema version.
  const merged = new Map((job.unknownBatches ?? []).map((_, i) => [i, recoveredUnknownMatch(job, i)]).filter(([, m]) => m));
  for (const match of proof.matches) merged.set(match.receiptIndex, match);
  if (merged.size > L.unknownRecoveryReceipts) fail("RECOVERY_LEDGER_CAPACITY");
  const matches = [...merged.values()];
  job.unknownPageRecovery = { version: 1, sourceId: job.sourceId, ledgerBinding: proof.ledgerBinding, matches: copy(matches) };
  if (job.semanticStage) {
    const plan = semanticPlan(job);
    if (cursorOrder(plan.excludedPrefixThrough, job.semanticStage.excludedPrefixThrough ?? initialCursor()) < 0) {
      job.semanticStage.cursor = copy(plan.excludedPrefixThrough);
      job.semanticStage.excludedPrefixThrough = copy(plan.excludedPrefixThrough);
      job.status = "paused"; job.pauseReason = "unknown_recovery_adopted";
    }
  }
  job.controlRevision++; job.revision++;
  return { status: job.status, revision: job.revision, verifiedBatches: matches.length,
    verifiedRows: matches.reduce((n, m) => n + m.count, 0), excludedPrefixThrough: semanticPlan(job).excludedPrefixThrough };
}

export function createPeopleReconstructionState({ id: jobId, sourceId, maxCalls = 1000,
  maxTokens = 1_000_000, maxTokensPerCall = 2048, publishVerified = false } = {}) {
  if (!id(jobId) || !id(sourceId) || ![maxCalls, maxTokens, maxTokensPerCall].every(integer)
    || maxTokensPerCall < 1 || typeof publishVerified !== "boolean") fail("INVALID_JOB");
  return { version: 1, id: jobId, sourceId, revision: 0, controlRevision: 0, status: "running",
    cursor: initialCursor(), claim: null, sequence: 0, publishVerified,
    budget: { maxCalls, maxTokens, maxTokensPerCall }, candidateCount: 0, people: {}, candidates: {},
    projectionIndex: {}, scanOnly: false, unknownBatches: [], pauseReason: null,
    stats: { scanned: 0, scanAttempts: 0, committedRows: 0, recoveredSources: 0, unattributed: 0,
      people: 0, published: 0, skippedUnknown: 0, unresolved: 0,
      tiers: Object.fromEntries(TIERS.map(t => [t, 0])), reasons: {},
      modelAttempts: 0, modelCompleted: 0, modelNotInvoked: 0, unknownCalls: 0, reservedTokens: 0, semanticSkipped: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, knownCalls: 0 } } };
}

function fence(root, logicalBotId, userId) {
  if (!logicalBotId || !userId) return null;
  const c = personMemoryControl(root, { logicalBotId, userId });
  return !c.ok || c.suppressesLegacy ? "PERSON_CONTROL" : null;
}
function currentSourceFence(root, row) {
  if (!row.holderStamp) return null;
  const live = own(own(own(root.groups, row.jobKey), "users"), row.userId)?.canonicalMemory;
  const stamp = { updatedAt: live?.updatedAt ?? null, entries: live?.entries?.length ?? 0,
    conflicts: live?.conflicts?.length ?? 0 };
  if (hash(stamp) !== hash(row.holderStamp)) return "SOURCE_REVISION_CHANGED";
  if (row.origin === "canonical") {
    const entry = live?.entries?.[row.canonicalIndex];
    if (!entry || hash(canonicalStamp(entry)) !== row.canonicalStamp) return "SOURCE_REVISION_CHANGED";
  }
  return null;
}
function archiveNegativeFence(root, userId, jobKey, sourceIds, logicalBotId, legacy = false) {
  const scope = legacyJobScope(jobKey)?.scope;
  const keys = new Set([jobKey, scope?.replace(/^group:/, "")]);
  if (scope?.startsWith("private:") && logicalBotId) keys.add(`${scope}:${logicalBotId.replace(/^account:/, "")}`);
  for (const key of keys) {
    if (!key) continue;
    const entries = own(own(own(root.groups, key), "users"), userId)?.canonicalMemory?.entries;
    if (!entries) continue;
    // Bounded per-person lookup, never a cold archive/root walk.
    if (!Array.isArray(entries) || entries.length > 4096) return "CANONICAL_CONTROL_CAPACITY";
    for (const e of entries) {
      if (!object(e) || !(TERMINAL.has(e.status) || e.correctedAt || e.negative === true)) continue;
      const ids = e.sourceMessageIds;
      if (legacy || !Array.isArray(ids) || !ids.length || ids.length > L.sources
        || ids.some(mid => sourceIds.includes(id(mid)))) return "CANONICAL_NEGATIVE_SOURCE";
    }
  }
  return null;
}
function sourceTuple(raw, row, scope, now) {
  if (!object(raw) || !id(raw.messageId) || qq(raw.verifiedSenderId) !== row.userId
    || raw.conversationId !== scope || time(raw.time, true) === null || time(raw.time, true) > now) return null;
  if ((raw.logicalBotId !== null && !id(raw.logicalBotId))
    || (raw.logicalBotId !== null && !id(raw.accountId))) return null;
  const archiveContext = raw.archiveConversationId === undefined ? null : legacyJobScope(raw.archiveConversationId);
  if (raw.archiveConversationId !== undefined && (!archiveContext || archiveContext.scope !== scope
    || archiveContext.logicalOwner && archiveContext.logicalOwner !== raw.logicalBotId)) return null;
  return { messageId: id(raw.messageId), verifiedSenderId: row.userId, conversationId: scope,
    logicalBotId: raw.logicalBotId ?? null, accountId: raw.accountId ?? null,
    time: raw.time, text: text(raw.text), via: raw.via === "receipt" ? "receipt" : "archive",
    boundValueDigest: /^[a-f0-9]{64}$/.test(raw.boundValueDigest ?? "") ? raw.boundValueDigest : null,
    sourceTextDigest: /^[a-f0-9]{64}$/.test(raw.sourceTextDigest ?? "") ? raw.sourceTextDigest : null,
    ...(archiveContext ? { archiveConversationId: raw.archiveConversationId } : {}) };
}
/** Host-only content witness, produced after checking an actual archive record.
 * Never accept this marker from model JSON. It avoids copying private source
 * bodies from the indexing worker into the bridge or model prompt. */
export function peopleReconstructionEvidenceBinding(row, source) {
  return hash([String(row.userId), legacyJobScope(row.jobKey)?.scope ?? row.conversationId,
    KIND[row.kind] ?? row.kind, row.value, source.messageId, source.time, source.logicalBotId ?? null,
    source.archiveConversationId ?? null, source.sourceTextDigest ?? null]);
}
function oppositeAssertion(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const normalize = v => v.normalize("NFKC").replace(/[\s，。！？!?、；;：:“”"']/g, "")
    .replace(/^我(?:本人|自己)?/, "").replace(/^(?:现在|已经|目前)/, "").replace(/[了啦]$/, "");
  const first = normalize(a), second = normalize(b);
  const negative = /^(?:不再|并不|从不|不|没有|没)(.+)$/;
  const na = negative.exec(first), nb = negative.exec(second);
  return Boolean(na && !nb && na[1] === second || nb && !na && nb[1] === first);
}

/** Pure bounded classifier. Input is a host-authored normalized row from pager. */
export function classifyPeopleReconstructionRow(root, row, { eligible, now } = {}) {
  if (!object(row) || !id(row.key) || typeof eligible !== "function" || time(now) === null) fail("INVALID_ROW");
  const userId = qq(row.userId), scope = legacyJobScope(row.jobKey)?.scope;
  const value = text(row.value), kind = KIND[row.kind] ?? row.kind;
  const base = { id: `recon_${hash([row.key, row.logicalBotId ?? null])}`, key: row.key,
    origin: row.origin, userId, conversationId: scope ?? null, logicalBotId: id(row.logicalBotId),
    kind: typeof kind === "string" && id(kind) ? kind : "unknown", value,
    tier: "Tentative", reasons: [], sourceMessageIds: [], evidence: [],
    confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence)
      ? Math.max(0, Math.min(1, row.confidence)) : 0.45,
    experience: false, publicStable: false, internalOnly: true, semantic: null,
    sourceBinding: row.holderStamp ? { jobKey: row.jobKey, origin: row.origin, userId,
      holderStamp: copy(row.holderStamp), ...(row.origin === "canonical"
        ? { canonicalIndex: row.canonicalIndex, canonicalStamp: row.canonicalStamp } : {}) } : null };
  const suppress = reason => ({ ...base, value: null, tier: "Suppressed", reasons: [reason], evidence: [] });
  if (!userId || !scope) return { ...base, value: null, reasons: ["UNATTRIBUTED_IDENTITY"] };
  if (row.invalidSource) return suppress("ARCHIVE_SOURCE_INVALID");
  if (!value) return suppress("UNSAFE_OR_OVERSIZED_VALUE");
  if (row.negative === true || TERMINAL.has(row.status)
    || row.corrected === true) return suppress("NEGATIVE_OR_CORRECTION");
  if (scope.startsWith("private:") && !base.logicalBotId) return suppress("PRIVATE_OWNER_UNKNOWN");
  const scopedOwner = legacyJobScope(row.jobKey);
  if (scopedOwner.logicalOwner && scopedOwner.logicalOwner !== base.logicalBotId) return suppress("PRIVATE_OWNER_MISMATCH");
  if (fence(root, base.logicalBotId, userId)) return suppress("PERSON_CONTROL");
  // The pinned input may predate an online correction. Check its exact slot,
  // never search by nickname/value and never scan a person's whole history here.
  const sourceFence = currentSourceFence(root, { ...row, userId });
  if (sourceFence) return suppress(sourceFence);
  if (["archive", "legacy"].includes(row.origin)) {
    const negative = archiveNegativeFence(root, userId, row.jobKey, row.sourceMessageIds ?? [], base.logicalBotId, row.origin === "legacy");
    if (negative) return suppress(negative);
  }
  const eligibility = { logicalBotId: base.logicalBotId, userId, conversationId: scope, mode: "reconstruction" };
  if (sync(eligible, eligibility) !== true) return suppress("SCOPE_NOT_AUTHORIZED");
  if (row.sourceIssue) return { ...base, reasons: [row.sourceIssue === "ARCHIVE_OWNER_AMBIGUOUS"
    ? "ARCHIVE_OWNER_AMBIGUOUS" : "SOURCE_CAPACITY_OR_INVALID_IDS"] };
  if (!Array.isArray(row.sources) || row.sources.length > L.sources) return suppress("SOURCE_CAPACITY");
  const ids = Array.isArray(row.sourceMessageIds) && row.sourceMessageIds.length <= L.sources
    ? row.sourceMessageIds.map(id) : [];
  const sources = [];
  let contradictory = false;
  for (const raw of row.sources) {
    const s = sourceTuple(raw, { ...row, userId }, scope, now);
    if (!s || s.logicalBotId !== base.logicalBotId
      || (scopedOwner.accountOnly && s.accountId !== scopedOwner.logicalOwner.slice(8))) {
      contradictory = true; continue;
    }
    if (sync(eligible, { ...s, userId, mode: "source" }) !== true) continue;
    if (!sources.some(other => other.messageId === s.messageId)) sources.push(s);
    else if (sources.some(other => other.messageId === s.messageId
      && (time(other.time, true) !== time(s.time, true) || other.text !== s.text
        || other.sourceTextDigest && s.sourceTextDigest && other.sourceTextDigest !== s.sourceTextDigest))) contradictory = true;
  }
  base.sourceMessageIds = ids.filter(Boolean);
  // Do not persist raw source text; model sees only safe, scoped original values.
  base.evidence = sources.map(({ text: _text, ...s }) => s);
  const exact = ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length
    && ids.every(mid => sources.some(s => s.messageId === mid));
  if (sources.some(s => !ids.includes(s.messageId))) contradictory = true;
  const contentBound = sources.length > 0 && sources.every(s => s.via === "receipt"
    ? row.evidenceKeys?.includes(JSON.stringify([row.jobKey, s.messageId]))
    : s.boundValueDigest === peopleReconstructionEvidenceBinding({ ...row, userId, value, kind }, s)
      || s.text === value || verifyPublicSelfStatement({ text: s.text, value, kind }).ok);
  if (row.conflicted === true || contradictory) {
    base.tier = "Conflicted"; base.reasons.push(contradictory ? "SOURCE_CONFLICT" : "HISTORICAL_CONFLICT");
  } else if (exact && contentBound && base.logicalBotId && row.origin === "canonical" && row.status === "active") {
    base.tier = "Verified"; base.experience = true;
  } else if (contentBound) {
    base.tier = "Supported";
    base.reasons.push(base.logicalBotId ? "INCOMPLETE_EVIDENCE" : "BOT_OWNERSHIP_UNKNOWN");
  } else base.reasons.push(row.joinIncomplete ? "ARCHIVE_JOIN_INCOMPLETE"
    : sources.length ? "CONTENT_NOT_BOUND" : "NO_ORIGINAL_SOURCE");
  // Different interests are not automatically contradictions. Only explicit
  // historical links, a narrow opposite assertion, or an AI conflict proposal
  // may hold a fact; never interpret "coffee" vs "photography" as a conflict.
  const current = base.logicalBotId ? root.peopleMemory?.bots?.[base.logicalBotId]?.people?.[userId] : null;
  if (base.tier !== "Conflicted" && current?.entries?.some(e => e.status === "active"
    && e.kind === kind && e.conversationId === scope && oppositeAssertion(e.value, value))) {
    base.tier = "Conflicted"; base.experience = false; base.reasons.push("CURRENT_MEMORY_DIFFERS");
  }
  base.publicStable = base.tier === "Verified" && scope.startsWith("group:")
    && ["stable_fact", "preference", "alias"].includes(kind) && base.confidence >= 0.8
    && row.extractionSource === "ai-extraction";
  return base;
}

/**
 * Read-only DRY RUN on a pinned snapshot, even when the live writer is uncertain.
 * No model, transaction, job initialization or compatibility-default writes.
 * Counts are PAGE-LOCAL candidate counts, not globally deduplicated fact/person
 * counts. Never sum page.people and label that number "actual unique people".
 */
export function summarizePeopleReconstructionPage(root, rows, options = {}) {
  if (!Array.isArray(rows) || rows.length > L.page) fail("PAGE_CAPACITY");
  const stats = { scanned: new Set(rows.map(r => r.key)).size, candidates: rows.length,
    people: 0, recoveredSources: 0, unattributed: 0,
    tiers: Object.fromEntries(TIERS.map(t => [t, 0])), reasons: {}, modelCalls: 0 };
  const people = new Set();
  for (const row of rows) {
    const c = classifyPeopleReconstructionRow(root, row, options);
    stats.tiers[c.tier]++;
    if (c.userId) people.add(c.userId);
    if (!c.userId || !c.logicalBotId) stats.unattributed++;
    if (["Verified", "Supported"].includes(c.tier)) stats.recoveredSources += c.evidence.length;
    c.reasons.forEach(reason => bump(stats, reason));
  }
  stats.people = people.size;
  return stats;
}

/**
 * Pure semantic validator: IDs cannot cross QQ, group/private or independent bot.
 * Grades/authority/source/ownership fields in model JSON are deliberately ignored.
 * Summary is a NON-EVIDENCE proposal, even if the model calls it Verified.
 */
export function validatePeopleReconstructionSemantics(output, candidates) {
  if (!object(output) || !Array.isArray(output.groups) || output.groups.length > L.semanticGroups) fail("INVALID_MODEL_OUTPUT");
  const available = new Map(candidates.filter(c => c.tier !== "Suppressed").map(c => [c.id, c]));
  const used = new Set(), result = [];
  for (const g of output.groups) {
    if (!object(g) || !Array.isArray(g.ids) || !g.ids.length || g.ids.length > L.page
      || new Set(g.ids).size !== g.ids.length) fail("INVALID_MODEL_GROUP");
    if (!text(g.summary)) fail("INVALID_MODEL_GROUP_SUMMARY");
    if (g.conflict !== undefined && typeof g.conflict !== "boolean") fail("INVALID_MODEL_GROUP_CONFLICT");
    if (g.category !== undefined && !SEMANTIC_CATEGORIES.has(g.category)) fail("INVALID_MODEL_GROUP_CATEGORY");
    if (g.relation !== undefined && !SEMANTIC_RELATIONS.has(g.relation)) fail("INVALID_MODEL_GROUP_RELATION");
    const selected = g.ids.map(key => available.get(key));
    if (selected.some(c => !c) || g.ids.some(key => used.has(key))) fail("MODEL_UNPINNED_ID");
    const first = selected[0];
    if (selected.some(c => c.userId !== first.userId || c.logicalBotId !== first.logicalBotId
      || c.conversationId !== first.conversationId)) fail("MODEL_SCOPE_CROSSING");
    g.ids.forEach(key => used.add(key));
    result.push({ ids: [...g.ids], summary: text(g.summary), conflict: g.conflict === true,
      ...(g.category !== undefined ? { category: g.category } : {}),
      ...(g.relation !== undefined ? { relation: g.relation } : {}), evidence: false, proposalOnly: true });
  }
  return result;
}

function usage(raw) {
  if (!object(raw) || ![raw.inputTokens, raw.outputTokens, raw.totalTokens].every(integer)
    || raw.totalTokens < raw.inputTokens + raw.outputTokens) return null;
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens };
}
function settleUsage(job, raw, completed, attemptId) {
  const attempt = job.claim.calls
    ? attemptId ? job.claim.calls.find(a => a.id === attemptId) : job.claim.calls.at(-1)
    : job.claim;
  if (!attempt || !job.claim.modelStarted || attempt.usageSettled) return;
  const reported = usage(raw);
  if (completed) job.stats.modelCompleted++;
  if (reported) {
    job.stats.usage.knownCalls++;
    for (const name of ["inputTokens", "outputTokens", "totalTokens"]) job.stats.usage[name] += reported[name];
    job.stats.reservedTokens -= job.budget.maxTokensPerCall;
  } else job.stats.unknownCalls++;
  attempt.usageSettled = true;
}
function settleOrphanCalls(job) {
  if (job.claim.calls) for (const attempt of job.claim.calls) settleUsage(job, null, false, attempt.id);
  else settleUsage(job, null, false);
}

/** Synchronous latest-draft control; caller authenticates HTTP/owner authority. */
export function controlPeopleReconstruction(root, args = {}) {
  if (args.authorized !== true) fail("UNAUTHORIZED");
  const job = jobAt(root);
  if (!job || args.expectedRevision !== job.revision) fail("REVISION_MISMATCH");
  const op = args.operation;
  if (op === "recover") {
    if (job.claim?.status === "claimed") {
      settleOrphanCalls(job);
      job.claim.status = "unknown";
      if (job.status !== "cancelled") job.status = "paused";
      if (job.pauseReason !== "operator") job.pauseReason = "recovered_claim";
      bump(job.stats, "ORPHANED_DURABLE_CLAIM", job.claim.count);
    } else return { status: job.status, revision: job.revision };
  } else if (op === "skip_unknown") {
    if (job.claim?.status !== "unknown" || !["paused", "cancelled"].includes(job.status)) fail("NO_UNKNOWN_CLAIM");
    retainUnknown(job);
    advanceClaim(job, job.claim);
    job.stats.skippedUnknown += job.claim.count; job.stats.unresolved += job.claim.count;
    job.claim = null;
    if ((job.semanticStage?.cursor ?? job.cursor).phase === "done" && job.status !== "cancelled") job.status = "completed_with_limits";
  } else if (op === "pause") {
    if (job.status !== "running") fail("NOT_RUNNING");
    job.status = "paused";
    job.pauseReason = "operator";
  } else if (op === "cancel") {
    if (["completed", "completed_with_limits", "cancelled"].includes(job.status)) fail("TERMINAL_JOB");
    job.status = "cancelled";
    job.pauseReason = "operator";
  } else if (op === "resume") {
    if (job.status !== "paused") fail("NOT_PAUSED");
    if (job.claim) fail("UNKNOWN_REQUIRES_EXPLICIT_SKIP");
    if (job.semanticStage && job.stats.modelAttempts - job.semanticStage.startAttempts >= job.semanticStage.maxCalls) fail("SEMANTIC_RESUME_BLOCKED");
    job.status = "running";
    job.pauseReason = null;
  } else if (op === "scan_only") {
    if (job.status === "cancelled" || job.claim?.status === "claimed" || job.semanticStage) fail("NOT_SCANNABLE");
    if (job.claim?.status === "unknown") {
      // Preserve the unknown receipt, never relabel it an ACK or replay it.
      retainUnknown(job);
      advanceClaim(job, job.claim);
      job.stats.skippedUnknown += job.claim.count; job.stats.unresolved += job.claim.count;
      job.claim = null;
      if (job.pauseReason !== "operator") job.status = job.cursor.phase === "done" ? "completed_with_limits" : "running";
    }
    job.scanOnly = true;
  } else if (op === "resume_semantics") {
    if (job.claim || job.status === "cancelled" || job.stats.modelAttempts >= job.budget.maxCalls
      || job.stats.usage.totalTokens + job.stats.reservedTokens + job.budget.maxTokensPerCall > job.budget.maxTokens) fail("SEMANTIC_RESUME_BLOCKED");
    if (job.cursor.phase === "done") {
      const maxCalls = args.maxSemanticCalls ?? 1, plan = semanticPlan(job);
      if (!["completed", "completed_with_limits", "paused"].includes(job.status)
        || !integer(maxCalls) || maxCalls < 1 || maxCalls > L.semanticRunCalls || plan.blockedReason
        || plan.cursor.phase === "done") fail("SEMANTIC_RESUME_BLOCKED");
      job.semanticStage ??= { version: 1, cursor: plan.cursor, legacyPendingAllowed: plan.legacyPendingAllowed,
        excludedPrefixThrough: copy(plan.excludedPrefixThrough),
        pages: 0, processed: 0, proposed: 0, omitted: 0, suppressed: 0, reused: 0, ineligible: 0, unproven: 0 };
      job.semanticStage.maxCalls = maxCalls;
      job.semanticStage.startAttempts = job.stats.modelAttempts;
    } else if (!job.scanOnly || !["running", "paused"].includes(job.status)) fail("SEMANTIC_RESUME_BLOCKED");
    job.acknowledgedUnknownCalls = job.stats.unknownCalls;
    job.scanOnly = false; job.status = "running"; job.pauseReason = null;
  } else if (op === "set_budget") {
    if (job.claim || !["running", "paused"].includes(job.status)
      || ![args.maxCalls, args.maxTokens].every(integer)) fail("INVALID_BUDGET_CHANGE");
    job.budget.maxCalls = args.maxCalls; job.budget.maxTokens = args.maxTokens;
  } else fail("INVALID_OPERATION");
  job.controlRevision++; job.revision++;
  return { status: job.status, revision: job.revision };
}

/** Read-only bounded preflight. No transaction, model, text or paths in result. */
export function summarizePeopleReconstructionSemanticsPage(root, rows, { eligible, now, cursor: from } = {}) {
  const job = jobAt(root);
  if (!job || !Array.isArray(rows) || rows.length > L.page || job.cursor.phase !== "done") fail("SEMANTIC_DRY_RUN_BLOCKED");
  const plan = semanticPlan(job), at = cursor(from ?? plan.cursor);
  if (cursorOrder(at, plan.cursor) < 0) fail("UNKNOWN_PREFIX_FENCED");
  const candidates = rows.map(row => classifyPeopleReconstructionRow(root, row, { eligible, now }));
  const pending = candidates.filter(c => semanticPending(job, c, plan));
  return { sourceId: job.sourceId, cursor: at, legacyPendingAllowed: plan.legacyPendingAllowed,
    excludedPrefixThrough: copy(plan.excludedPrefixThrough),
    blockedReason: plan.blockedReason, rows: rows.length,
    pending: pending.length,
    exactRepresentativesLowerBound: new Set(pending.map(semanticKey)).size,
    reusableProposals: pending.filter(c => reusableSemantic(root, job, c, eligible)).length,
    unknownCandidates: candidates.filter(c => unknownCandidateExcluded(job, c.id)).length,
    legacyUnproven: candidates.filter(c => own(job.candidates, c.id) && own(job.candidates, c.id).semanticState === undefined
      && !plan.legacyPendingAllowed && !own(job.candidates, c.id)?.semantic).length,
    suppressed: candidates.filter(c => c.tier === "Suppressed").length,
    tiers: Object.fromEntries(TIERS.map(tier => [tier, candidates.filter(c => c.tier === tier).length])),
    sourceTuples: candidates.reduce((n, c) => n + c.evidence.length, 0),
    verifiedDurableCandidates: candidates.filter(c => c.tier === "Verified" && DURABLE.has(c.kind)).length,
    attributionChanges: candidates.filter(c => own(job.candidates, c.id)
      && own(job.candidates, c.id).logicalBotId !== c.logicalBotId).length,
    modelCalls: 0, batchLimit: L.semanticBatch, defaultRunCalls: 1 };
}

// Semantic reprocessing never publishes to peopleMemory or creates candidates.
// It may only attach non-evidence proposals to pinned, still-eligible originals.
function applySemanticPage(root, { claimId, rows, groups, eligible, modelEligible, now }) {
  const job = jobAt(root), claim = job?.claim;
  if (claim?.id !== claimId || claim.status !== "claimed" || claim.phase !== "semantics"
    || hash(rows) !== claim.hash) fail("CLAIM_LOST");
  if (job.status !== "running" || claim.controlRevision !== job.controlRevision) {
    claim.status = "unknown"; job.revision++; return { status: job.status, reason: "CONTROL_CHANGED" };
  }
  const fresh = rows.map(row => classifyPeopleReconstructionRow(root, row, { eligible, now }));
  const attempted = new Set(claim.calls.filter(a => !a.notInvoked).flatMap(a => a.candidateIds));
  for (const c of fresh) {
    const stored = own(job.candidates, c.id);
    if (stored && unknownCandidateExcluded(job, c.id)) {
      if ([undefined, "pending"].includes(stored.semanticState)) {
        stored.semanticState = "unknown"; job.semanticStage.unknown = (job.semanticStage.unknown || 0) + 1;
      }
      continue;
    }
    if (!stored || stored.semanticState && stored.semanticState !== "pending" || stored.semantic) continue;
    if (stored.semanticState === undefined && !job.semanticStage.legacyPendingAllowed) {
      stored.semanticState = "unproven"; job.semanticStage.unproven = (job.semanticStage.unproven || 0) + 1; continue;
    }
    if (c.tier === "Suppressed") {
      job.stats.tiers[stored.tier]--; job.stats.tiers.Suppressed++;
      stored.tier = "Suppressed"; stored.value = null; stored.evidence = []; stored.experience = false;
      stored.publicStable = false; stored.reasons = c.reasons; stored.semanticState = "suppressed";
      job.semanticStage.suppressed++; continue;
    }
    if (stored.tier === "Suppressed" || !c.conversationId?.startsWith("group:") || c.origin === "archive"
      || sync(modelEligible, c) !== true) {
      stored.semanticState = "ineligible"; job.semanticStage.ineligible = (job.semanticStage.ineligible || 0) + 1; continue;
    }
    if (c.tier === "Conflicted" && stored.tier !== "Conflicted") {
      job.stats.tiers[stored.tier]--; job.stats.tiers.Conflicted++;
      stored.tier = "Conflicted"; stored.experience = false; stored.publicStable = false;
      stored.reasons.push("CURRENT_MEMORY_DIFFERS");
    }
    if (!attempted.has(c.id)) continue;
    const proposal = groups.find(g => g.ids.includes(c.id));
    // Original QQ, Bot, time, source IDs, grade and value remain unchanged.
    stored.semantic = proposal ?? null; stored.semanticState = proposal ? "completed" : "omitted";
    if (proposal?.conflict && stored.tier !== "Conflicted") {
      job.stats.tiers[stored.tier]--; job.stats.tiers.Conflicted++;
      stored.tier = "Conflicted"; stored.experience = false; stored.publicStable = false;
      stored.reasons.push("SEMANTIC_CONFLICT_PROPOSAL");
    }
    job.semanticStage.processed++;
    if (proposal) job.semanticStage.proposed++; else job.semanticStage.omitted = (job.semanticStage.omitted || 0) + 1;
    if (proposal && !proposal.conflict && proposal.ids.length === 1
      && !["conflict", "temporal", "withdrawal"].includes(proposal.relation) && stored.tier !== "Conflicted") {
      job.semanticReuseIndex ??= {};
      job.semanticReuseIndex[semanticKey(stored)] = stored.id;
    }
  }
  for (const c of fresh) {
    if (!semanticPending(job, c) || sync(modelEligible, c) !== true) continue;
    const donor = reusableSemantic(root, job, c, eligible);
    if (!donor) continue;
    const stored = job.candidates[c.id];
    stored.semantic = { ...copy(donor.semantic), ids: [c.id], relation: "duplicate", reusedFrom: donor.id };
    stored.semanticState = "reused";
    job.semanticStage.processed++; job.semanticStage.proposed++; job.semanticStage.reused = (job.semanticStage.reused || 0) + 1;
  }
  job.semanticStage.pages++;
  // One scope / <=16 representatives / <=1 call per opportunity. Stay on this source
  // page until all other pending IDs are handled, WITHOUT recalling tried IDs.
  const remaining = fresh.some(c => semanticPending(job, c));
  job.semanticStage.cursor = copy(remaining ? claim.startCursor : claim.nextCursor);
  job.claim = null; job.revision++;
  if (job.semanticStage.cursor.phase === "done") job.status = "completed_with_limits";
  else if (job.stats.modelAttempts - job.semanticStage.startAttempts >= job.semanticStage.maxCalls) {
    job.status = "paused"; job.pauseReason = "semantic_run_limit";
  }
  return { status: job.status, revision: job.revision, published: 0 };
}

/** Atomic result + ACK. Only unchanged Verified originals can enter peopleMemory. */
export function applyPeopleReconstructionPage(root, { claimId, rows, modelOutput, now, eligible } = {}) {
  const job = jobAt(root), claim = job?.claim;
  if (!claim || claim.id !== claimId || claim.status !== "claimed") fail("CLAIM_LOST");
  if (!Array.isArray(rows) || rows.length > L.page || hash(rows) !== claim.hash) fail("PAGE_CHANGED");
  settleUsage(job, modelOutput?.usage, modelOutput !== undefined);
  if (job.status !== "running" || claim.controlRevision !== job.controlRevision) {
    claim.status = "unknown"; job.revision++;
    return { status: job.status, reason: "CONTROL_CHANGED" };
  }
  const planned = rows.map(row => classifyPeopleReconstructionRow(root, row, { eligible, now }));
  // Validate against the originally exposed IDs, then reapply CURRENT controls.
  // The runner validated against its PINNED pre-model page. Newly suppressed
  // rows must lose the proposal, not cause a retry or revive old content.
  const semantic = modelOutput === undefined ? [] : validatePeopleReconstructionSemantics(modelOutput,
    planned.map(c => c.tier === "Suppressed" ? { ...c, tier: "Tentative" } : c));
  for (const g of semantic) for (const key of g.ids) {
    const c = planned.find(item => item.id === key);
    if (c.tier === "Suppressed") continue;
    c.semantic = g;
    if (g.conflict && c.tier !== "Suppressed") { c.tier = "Conflicted"; c.experience = false; c.reasons.push("SEMANTIC_CONFLICT_PROPOSAL"); }
  }
  const added = planned.filter(c => !own(job.candidates, c.id));
  const newPeople = new Set(added.map(c => c.userId).filter(u => u && !own(job.people, u)));
  if (job.candidateCount + added.length > L.candidates || job.stats.people + newPeople.size > L.people) fail("RECONSTRUCTION_CAPACITY");
  let published = 0;
  for (const c of planned) {
    if (own(job.candidates, c.id)) continue;
    if (job.publishVerified && c.tier === "Verified" && DURABLE.has(c.kind)) {
      // Roll back this ROW on any failure; do not partially import its sources.
      const checkpoint = root.peopleMemory;
      let refused = null, imported = false;
      for (const s of c.evidence) {
        const r = recordPersonEvidence(root, { logicalBotId: c.logicalBotId, userId: c.userId,
          verifiedSenderId: c.userId, accountId: s.accountId, conversationId: c.conversationId,
          messageId: s.messageId, time: s.time, now, kind: c.kind, value: c.value,
          privacy: c.conversationId.startsWith("private:") ? "private" : c.publicStable ? "public" : "conversation",
          sourceType: "archive", confidence: Math.min(c.confidence, 0.79), retainDurable: true });
        if (!r.ok) { refused = r.reason; break; }
        imported ||= r.changed;
      }
      if (refused) {
        if (checkpoint === undefined) delete root.peopleMemory; else root.peopleMemory = checkpoint;
        c.reasons.push(`PROJECTION_${refused}`);
      }
      else if (imported) published++;
    }
    const exposed = job.claim.calls?.some(a => !a.notInvoked && a.candidateIds?.includes(c.id));
    c.semanticState = c.tier === "Suppressed" ? "suppressed" : c.semantic ? "completed" : exposed ? "omitted" : "pending";
    job.candidates[c.id] = c; job.candidateCount++; job.stats.tiers[c.tier]++;
    if (["Verified", "Supported"].includes(c.tier) && c.userId && c.conversationId?.startsWith("group:")
      && DURABLE.has(c.kind)) {
      job.projectionIndex ??= {};
      const key = peopleReconstructionProjectionKey(c.conversationId, c.userId, c.logicalBotId);
      const ids = job.projectionIndex[key] ??= [];
      if (ids.length < L.page) ids.push(c.id);
      else bump(job.stats, "PROJECTION_INDEX_CAPACITY");
    }
    if (!c.userId || !c.logicalBotId) job.stats.unattributed++;
    if (c.userId && !own(job.people, c.userId)) { job.people[c.userId] = true; job.stats.people++; }
    if (["Verified", "Supported"].includes(c.tier)) job.stats.recoveredSources += c.evidence.length;
    if (["Tentative", "Conflicted", "Suppressed"].includes(c.tier)) job.stats.unresolved++;
    c.reasons.forEach(reason => bump(job.stats, reason));
  }
  job.stats.published += published; job.stats.committedRows += rows.length; job.stats.scanned += claim.scanned;
  job.cursor = copy(claim.nextCursor); job.claim = null; job.revision++;
  if (job.cursor.phase === "done") job.status = job.stats.unresolved || job.stats.unattributed || job.stats.semanticSkipped || job.stats.modelBindingDiscards
    ? "completed_with_limits" : "completed";
  return { status: job.status, accepted: added.length, published, revision: job.revision };
}

/** Safe status: no values, source text, paths, credentials or model prose. */
export function peopleReconstructionStatus(root) {
  const job = jobAt(root);
  return job ? { id: job.id, sourceId: job.sourceId, status: job.status, revision: job.revision,
    cursor: copy(job.cursor), claim: job.claim ? { id: job.claim.id, status: job.claim.status,
      count: job.claim.count, modelStarted: job.claim.modelStarted } : null,
    candidates: job.candidateCount, stats: copy(job.stats), budget: copy(job.budget),
    usageComplete: job.stats.unknownCalls === 0, scanOnly: job.scanOnly === true,
    acknowledgedUnknownCalls: job.acknowledgedUnknownCalls || 0,
    lastFailureCode: job.lastFailureCode ?? null,
    pauseReason: job.pauseReason ?? null, unknownBatches: job.unknownBatches?.length ?? 0,
    semanticStage: job.semanticStage ? copy(job.semanticStage) : null } : null;
}

export function peopleReconstructionProjectionKey(conversationId, userId, logicalBotId = null) {
  return hash([conversationId, String(userId), logicalBotId]);
}

/**
 * Internal candidate lookup, exact known IDs only (no full-store search). Host
 * keeps a paged/worker index to find IDs. Unknown-bot group evidence NEVER crosses
 * group; private evidence requires the exact bot + subject private conversation.
 * No disclosure API, no source text, no model summary presented as a fact.
 */
export function queryPeopleReconstructionCandidates(root, { ids, logicalBotId, userId,
  conversationId, purpose = "understanding", eligible } = {}) {
  if (!Array.isArray(ids) || ids.length > L.page || !id(logicalBotId) || !qq(userId)
    || purpose !== "understanding" || typeof eligible !== "function") return [];
  if (fence(root, logicalBotId, String(userId))) return [];
  const job = jobAt(root), output = [];
  for (const key of ids) {
    const c = own(job?.candidates, key);
    if (!c || c.userId !== String(userId)
      || (c.logicalBotId && c.logicalBotId !== logicalBotId) || !["Verified", "Supported"].includes(c.tier)) continue;
    if (c.sourceBinding && currentSourceFence(root, c.sourceBinding)) continue;
    if (["archive", "legacy"].includes(c.origin) && archiveNegativeFence(root, c.userId,
      c.conversationId, c.sourceMessageIds, c.logicalBotId, c.origin === "legacy")) continue;
    const sameGroup = c.conversationId === conversationId;
    if (!sameGroup && !(c.logicalBotId === logicalBotId && c.publicStable
      && conversationId?.startsWith("group:") && c.conversationId?.startsWith("group:"))) continue;
    if (conversationId.startsWith("private:") && c.logicalBotId !== logicalBotId) continue;
    if (sync(eligible, { logicalBotId, userId: c.userId, conversationId, mode: "understanding" }) !== true) continue;
    if (!sameGroup && sync(eligible, { logicalBotId, userId: c.userId,
      conversationId: c.conversationId, mode: "understanding" }) !== true) continue;
    output.push({ id: c.id, value: c.value, kind: c.kind, tier: c.tier, experience: c.experience && c.logicalBotId === logicalBotId,
      internalOnly: true, uncertain: true, sourceLimited: !c.logicalBotId,
      warning: "仅供内部理解；不得宣称亲历、跨群披露或复述私人来源。" });
  }
  return output;
}

/** One runner owns one root. No polling/retries; host serializes startup/control. */
export function createPeopleReconstructionRunner({ getState, transact, readPage, eligible, model,
  modelEligible = () => true, modelAvailable = () => true,
  modelBatchSize = cs => Math.min(cs.length, L.semanticBatch), initializeJob = () => {},
  now = Date.now } = {}) {
  for (const fn of [getState, transact, readPage, eligible, now, modelEligible, modelAvailable, modelBatchSize, initializeJob]) if (typeof fn !== "function") fail("INVALID_CALLBACK");
  if (model !== undefined && typeof model !== "function") fail("INVALID_MODEL");
  let recovered = false, active = null, abort = null, storageBlocked = false;
  const tx = async build => {
    try { return await transact(build); }
    catch (error) {
      if (error instanceof ReconstructionError) throw error;
      storageBlocked = true; fail("DURABILITY_UNCERTAIN");
    }
  };
  const control = async args => {
    const result = await tx(root => controlPeopleReconstruction(root, args));
    if (["pause", "cancel"].includes(args.operation)) abort?.abort();
    return result;
  };
  async function recover() {
    if (active) fail("BUSY");
    if (storageBlocked) fail("STORAGE_RECONCILIATION_REQUIRED");
    const job = jobAt(sync(getState));
    if (job?.claim?.status === "claimed") await control({ operation: "recover", authorized: true, expectedRevision: job.revision });
    recovered = true;
    return peopleReconstructionStatus(sync(getState));
  }
  async function start(args) {
    if (args?.authorized !== true) fail("UNAUTHORIZED");
    if (!recovered) fail("RECOVERY_REQUIRED");
    return tx(root => {
      if (jobAt(root)) fail("JOB_ALREADY_EXISTS");
      root[FIELD] = createPeopleReconstructionState(args);
      sync(initializeJob, root[FIELD], args);
      return peopleReconstructionStatus(root);
    });
  }
  async function work({ model: useModel = true } = {}) {
    if (!recovered) fail("RECOVERY_REQUIRED");
    if (storageBlocked) fail("STORAGE_RECONCILIATION_REQUIRED");
    const before = jobAt(sync(getState));
    if (!before || before.status !== "running" || before.claim) return peopleReconstructionStatus(sync(getState));
    const semanticPhase = Boolean(before.semanticStage);
    if (semanticPhase && semanticPlan(before).blockedReason) fail("UNKNOWN_RECOVERY_STALE");
    if (semanticPhase && (!useModel || !model || before.scanOnly)) fail("SEMANTIC_MODEL_REQUIRED");
    abort = new AbortController();
    const pin = { id: before.id, sourceId: before.sourceId,
      cursor: copy(semanticPhase ? before.semanticStage.cursor : before.cursor), control: before.controlRevision };
    let page;
    try { page = await readPage({ sourceId: pin.sourceId, cursor: copy(pin.cursor), limit: L.page, signal: abort.signal }); }
    catch (error) { return { status: abort.signal.aborted ? jobAt(sync(getState))?.status : "source_error",
      code: error instanceof ReconstructionError ? error.code : "SOURCE_READ_FAILED" }; }
    if (!object(page) || page.sourceId !== pin.sourceId || !Array.isArray(page.rows) || page.rows.length > L.page
      || Buffer.byteLength(JSON.stringify(page.rows)) > L.pageBytes) fail("INVALID_PAGE");
    const next = cursor(page.nextCursor);
    const scanned = page.scanned ?? new Set(page.rows.map(r => r.key)).size;
    if (!integer(scanned) || scanned > 4096) fail("INVALID_PAGE_COUNT");
    if (!advances(pin.cursor, next)) fail("CURSOR_DID_NOT_ADVANCE");
    const rows = copy(page.rows), claimId = randomUUID();
    const claimed = await tx(root => {
      const job = jobAt(root);
      if (job?.id !== pin.id || job.sourceId !== pin.sourceId || job.status !== "running"
        || job.controlRevision !== pin.control || job.claim
        || hash(semanticPhase ? job.semanticStage?.cursor : job.cursor) !== hash(pin.cursor)) return false;
      job.sequence++; job.revision++; if (!semanticPhase) job.stats.scanAttempts += scanned;
      job.claim = { id: claimId, status: "claimed", hash: hash(rows), count: rows.length, scanned,
        phase: semanticPhase ? "semantics" : "scan", startCursor: pin.cursor,
        nextCursor: next, controlRevision: job.controlRevision, modelStarted: false, calls: [] };
      return true;
    });
    if (!claimed) return peopleReconstructionStatus(sync(getState));
    let output, latestAttempt = null;
    const groups = [];
    try {
      const candidates = rows.map(row => classifyPeopleReconstructionRow(sync(getState), row, { eligible, now: sync(now) }));
      const visible = candidates.filter(c => c.tier !== "Suppressed" && c.userId && c.value
        && sync(modelEligible, c) === true && (!semanticPhase || semanticPending(jobAt(sync(getState)), c)));
      const partitions = new Map();
      const representatives = new Set();
      for (const c of visible) {
        if (semanticPhase) {
          if (reusableSemantic(sync(getState), jobAt(sync(getState)), c, eligible)) continue;
          const key = semanticKey(c);
          if (representatives.has(key)) continue;
          representatives.add(key);
        }
        const scopeKey = JSON.stringify([c.userId, c.logicalBotId, c.conversationId]);
        if (!partitions.has(scopeKey)) partitions.set(scopeKey, []);
        partitions.get(scopeKey).push(c.id);
      }
      if (semanticPhase && partitions.size) {
        const [key, ids] = partitions.entries().next().value;
        const count = sync(modelBatchSize, ids.map(key => candidates.find(c => c.id === key)),
          { maxTokens: jobAt(sync(getState)).budget.maxTokensPerCall });
        if (!integer(count) || count < 1 || count > Math.min(ids.length, L.semanticBatch)) fail("INVALID_SEMANTIC_BATCH");
        partitions.clear(); partitions.set(key, ids.slice(0, count));
      }
      const modelEnabled = Boolean(model && useModel && !jobAt(sync(getState)).scanOnly);
      if (!modelEnabled && visible.length) await tx(root => {
        const job = jobAt(root);
        if (job.claim?.id !== claimId) fail("CLAIM_LOST");
        job.stats.semanticSkipped = (job.stats.semanticSkipped || 0) + visible.length;
      });
      if (modelEnabled) for (const [scopeKey, ids] of partitions) {
        if (jobAt(sync(getState)).scanOnly) {
          await tx(root => {
            const job = jobAt(root);
            if (job.claim?.id !== claimId) fail("CLAIM_LOST");
            job.stats.semanticSkipped = (job.stats.semanticSkipped || 0) + ids.length;
          });
          continue;
        }
        const attemptId = randomUUID();
        const allowed = await tx(root => {
          const job = jobAt(root);
          if (job.claim?.id !== claimId || job.status !== "running" || job.controlRevision !== pin.control) return false;
          const current = rows.map(row => classifyPeopleReconstructionRow(root, row, { eligible, now: sync(now) }))
            .filter(c => ids.includes(c.id) && c.tier !== "Suppressed" && c.userId && c.value
              && (!semanticPhase || semanticPending(job, c)));
          if (!current.length) return { skip: true };
          if (sync(modelAvailable) !== true
            || semanticPhase && job.stats.modelAttempts - job.semanticStage.startAttempts >= job.semanticStage.maxCalls
            || job.stats.unknownCalls > (job.acknowledgedUnknownCalls || 0) || job.stats.modelAttempts >= job.budget.maxCalls
            || job.stats.usage.totalTokens + job.stats.reservedTokens + job.budget.maxTokensPerCall > job.budget.maxTokens) {
            job.status = "paused";
            if (job.claim.modelStarted) job.claim.status = "unknown"; else job.claim = null;
            job.revision++;
            bump(job.stats, job.stats.unknownCalls ? "MODEL_USAGE_UNKNOWN" : "MODEL_BUDGET"); return false;
          }
          job.claim.modelStarted = true; job.stats.modelAttempts++;
          job.claim.calls.push({ id: attemptId, scopeHash: hash(scopeKey),
            candidateIds: current.map(c => c.id), usageSettled: false });
          job.stats.reservedTokens += job.budget.maxTokensPerCall; job.revision++;
          return { candidates: current };
        });
        if (allowed?.skip) continue;
        if (!allowed) {
          await tx(root => {
            const j = jobAt(root);
            if (j.claim?.id === claimId) {
              if (!j.claim.modelStarted) j.claim = null; else j.claim.status = "unknown";
              j.revision++;
            }
          });
          return peopleReconstructionStatus(sync(getState));
        }
        latestAttempt = attemptId; output = undefined;
        // Recheck AFTER the durable await as well: an online person-control
        // transaction may have been queued ahead of this continuation.
        const current = rows.map(row => classifyPeopleReconstructionRow(sync(getState), row, { eligible, now: sync(now) }))
          .filter(c => ids.includes(c.id) && c.tier !== "Suppressed" && c.userId && c.value
            && (!semanticPhase || semanticPending(jobAt(sync(getState)), c)));
        const latest = jobAt(sync(getState));
        if (abort.signal.aborted || !current.length || latest.status !== "running" || latest.controlRevision !== pin.control) {
          await tx(root => {
            const job = jobAt(root), attempt = job.claim?.calls?.find(a => a.id === attemptId);
            if (!attempt || attempt.usageSettled) fail("CLAIM_LOST");
            attempt.notInvoked = true; attempt.usageSettled = true;
            job.stats.modelNotInvoked++; job.stats.reservedTokens -= job.budget.maxTokensPerCall; job.revision++;
          });
          continue;
        }
        output = await model({ candidates: copy(current), signal: abort.signal,
          maxTokens: jobAt(sync(getState)).budget.maxTokensPerCall, claimId, attemptId });
        // Actual usage is durably settled per sub-call, including rejected or
        // discarded results. A crash cannot lose earlier completed call counts.
        await tx(root => {
          const job = jobAt(root);
          if (job.claim?.id !== claimId) fail("CLAIM_LOST");
          settleUsage(job, output?.usage, output !== undefined, attemptId); job.revision++;
        });
        // Do not retain unexpected/oversized provider content in job state.
        if (!object(output) || !Array.isArray(output.groups) || output.groups.length > L.semanticGroups) fail("INVALID_MODEL_OUTPUT");
        groups.push(...validatePeopleReconstructionSemantics(output, current));
      }
      if (semanticPhase) return await tx(root => applySemanticPage(root,
        { claimId, rows, groups, eligible, modelEligible, now: sync(now) }));
      return await tx(root => applyPeopleReconstructionPage(root, { claimId, rows,
        modelOutput: latestAttempt ? { groups } : undefined, now: sync(now), eligible }));
    } catch (error) {
      if (storageBlocked) return { status: "storage_blocked", code: "DURABILITY_UNCERTAIN" };
      return tx(root => {
        const job = jobAt(root);
        if (job.claim?.id !== claimId) return { status: job.status };
        // Trusted host callback errors may retain normalized provider usage
        // (e.g. output length rejection). Text/model prose is never a ledger.
        settleUsage(job, output?.usage || error?.metadata?.usage, output !== undefined, latestAttempt);
        // Only host enum codes are diagnostics. Never persist a provider error
        // message, model output, candidate text or arbitrary error.code.
        job.lastFailureCode = error instanceof ReconstructionError ? error.code
          : ["RECONSTRUCTION_MODEL_OUTPUT_REJECTED", "MODEL_CONTEXT_CHANGED", "RECONSTRUCTION_STALE",
            "MODEL_PROMPT_LIMIT", "MODEL_TOKEN_ENVELOPE", "MODEL_SCOPE_DENIED", "MODEL_BINDING_CHANGED",
            "EXISTING_BUDGET_EXHAUSTED"].includes(error?.code)
            ? error.code : "MODEL_OR_HOST_FAILED";
        job.claim.status = "unknown";
        job.claim.failureCode = job.lastFailureCode;
        if (job.status === "running") { job.status = "paused"; job.pauseReason = "model_unknown"; }
        job.revision++; bump(job.stats, "BATCH_OUTCOME_UNKNOWN", rows.length);
        return { status: job.status, code: "BATCH_OUTCOME_UNKNOWN", claimId };
      });
    }
  }
  function step(options = {}) {
    if (typeof options.model !== "undefined" && typeof options.model !== "boolean") return Promise.reject(new ReconstructionError("INVALID_MODEL_POLICY"));
    if (!active) active = Promise.resolve().then(() => work(options)).finally(() => { active = null; abort = null; });
    return active;
  }
  return { start, recover, control, step, status: () => peopleReconstructionStatus(sync(getState)) };
}

// ---- Optional immutable-source pager. Never discovers runtime paths. --------
function* memorySlots(memory) {
  const groups = memory?.groups;
  if (!object(groups)) return;
  for (const jobKey in groups) {
    if (!Object.hasOwn(groups, jobKey)) continue;
    const group = groups[jobKey];
    yield null; // cooperative progress even for empty/invalid groups
    if (!legacyJobScope(jobKey) || !object(group?.users)) continue;
    for (const userId in group.users) {
      if (!Object.hasOwn(group.users, userId)) continue;
      const user = group.users[userId], canonical = user?.canonicalMemory;
      yield null;
      if (!object(user)) continue;
      let negativeLegacy = Boolean(canonical?.conflicts?.length);
      if (Array.isArray(canonical?.entries)) for (let i = 0; i < canonical.entries.length; i++) {
        const e = canonical.entries[i];
        negativeLegacy ||= Boolean(e?.correctedAt || e?.negative || ["deleted", "revoked", "rejected", "superseded"].includes(e?.status));
        yield { origin: "canonical", jobKey, userId,
          locator: [jobKey, userId, "canonical", i], raw: e,
          holder: user, canonicalSubject: canonical.subjectUserId, index: group.peopleSourceIndex,
          canonical, canonicalIndex: i };
      }
      for (const [field, kind] of Object.entries(canonicalMemoryFields)) {
        const snake = field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
        for (const [holderName, holder] of [["user", user], ["canonical", canonical]]) {
          for (const name of new Set([field, snake])) {
            const values = holder?.[name];
            if (values === undefined || values === null) continue;
            const list = Array.isArray(values) ? values : [values];
            for (let i = 0; i < list.length; i++) yield { origin: "legacy", jobKey, userId,
              locator: [jobKey, userId, holderName, name, i], raw: { value: list[i], kind }, holder: user,
              canonical, negativeLegacy };
          }
        }
      }
      for (const field of ["summary", "portrait", "rollingSummary", "memories"]) {
        const raw = user[field];
        if (raw === undefined) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        for (let i = 0; i < values.length; i++) yield { origin: "legacy", jobKey, userId,
          locator: [jobKey, userId, field, i], raw: { value: values[i], kind: "profile" }, holder: user,
          canonical, negativeLegacy };
      }
    }
  }
}
function canonicalStamp(e) {
  const scalar = value => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value
    : typeof value === "string" && value.length <= 512 ? value
    : value === undefined || value === null ? null : [typeof value, typeof value === "string" ? value.length : "invalid"];
  const list = value => Array.isArray(value) ? [value.length, value.slice(0, L.sources).map(scalar)] : scalar(value);
  return [scalar(e.id), scalar(e.value), scalar(e.kind), scalar(e.subjectUserId), scalar(e.confidence),
    scalar(e.source), scalar(e.status), scalar(e.correctedAt), scalar(e.negative), scalar(e.supersedes),
    list(e.conflictsWith), list(e.sourceMessageIds), list(e.evidenceKeys)];
}
function canonicalRows(slot) {
  const e = object(slot.raw) ? slot.raw : {}, scope = legacyJobScope(slot.jobKey)?.scope;
  const ids = Array.isArray(e.sourceMessageIds) && e.sourceMessageIds.length <= L.sources ? e.sourceMessageIds.map(id) : [];
  const base = { key: `row_${hash(slot.locator)}`, origin: slot.origin, jobKey: slot.jobKey,
    userId: qq(slot.userId), value: typeof e.value === "string" && e.value.length <= L.valueChars ? e.value : "",
    kind: id(e.kind) ?? "unknown", status: id(e.status) ?? "tentative",
    confidence: typeof e.confidence === "number" && Number.isFinite(e.confidence) ? e.confidence : 0.45,
    negative: e.negative === true || slot.holder?.negative === true || slot.negativeLegacy === true,
    corrected: Boolean(e.correctedAt || e.supersedes),
    conflicted: Boolean(e.conflictsWith?.length || e.status === "conflicted"),
    sourceMessageIds: ids, evidenceKeys: Array.isArray(e.evidenceKeys)
      ? e.evidenceKeys.slice(0, L.sources).filter(key => typeof key === "string" && key.length <= 512) : [],
    logicalBotId: null, sources: [], extractionSource: id(e.source),
    sourceIssue: (Array.isArray(e.sourceMessageIds) && (e.sourceMessageIds.length > L.sources || ids.some(v => !v)))
      || (e.sourceMessageIds !== undefined && !Array.isArray(e.sourceMessageIds))
      || (e.sourceConversationId !== undefined && e.sourceConversationId !== slot.jobKey && e.sourceConversationId !== scope),
    holderStamp: { updatedAt: slot.canonical?.updatedAt ?? null, entries: slot.canonical?.entries?.length ?? 0,
      conflicts: slot.canonical?.conflicts?.length ?? 0 },
    ...(slot.origin === "canonical" ? { canonicalIndex: slot.canonicalIndex, canonicalStamp: hash(canonicalStamp(e)) } : {}) };
  if (slot.origin === "canonical" && (qq(slot.canonicalSubject) !== base.userId
    || (e.subjectUserId !== undefined && qq(e.subjectUserId) !== base.userId))) {
    base.userId = null; base.negative = true;
  }
  const owners = new Map();
  for (const mid of ids) {
    const receipts = own(slot.index, mid);
    if (!object(receipts)) continue;
    let visited = 0;
    for (const bot in receipts) {
      if (!Object.hasOwn(receipts, bot)) continue;
      if (++visited > L.bots) break;
      const r = receipts[bot];
      if (!id(bot) || !object(r)) continue;
      if (!owners.has(bot) && owners.size >= L.bots) { base.sourceIssue = true; break; }
      if (!owners.has(bot)) owners.set(bot, []);
      owners.get(bot).push({ messageId: mid, logicalBotId: bot, accountId: r.accountId ?? null,
        verifiedSenderId: r.verifiedSenderId ?? null, conversationId: r.conversationId ?? null,
        time: r.time ?? null, via: "receipt" });
    }
  }
  return owners.size ? [...owners].map(([bot, sources]) => ({ ...base, logicalBotId: bot, sources })) : [base];
}

// One bounded chunk; trailing partial line is replayed from its first byte.
async function archiveChunk(file, byte, maxBytes, signal) {
  if (signal?.aborted) fail("ABORTED");
  const handle = await open(file.path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < file.size || String(stat.ino) !== String(file.ino) || byte > file.size) fail("ARCHIVE_SNAPSHOT_CHANGED");
    const count = Math.min(maxBytes, file.size - byte);
    if (!count) return { lines: [], byte, done: true };
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, byte);
    if (bytesRead !== count) fail("ARCHIVE_SHORT_READ");
    const lines = []; let start = 0;
    for (let i = 0; i < count; i++) if (buffer[i] === 10) {
      if (i - start > L.lineBytes) fail("ARCHIVE_LINE_CAPACITY");
      lines.push({ raw: buffer.subarray(start, i).toString("utf8"), byte: byte + start, end: byte + i + 1 }); start = i + 1;
    }
    if (byte + count === file.size && start < count) {
      if (count - start > L.lineBytes) fail("ARCHIVE_LINE_CAPACITY");
      lines.push({ raw: buffer.subarray(start).toString("utf8"), byte: byte + start, end: file.size }); start = count;
    }
    if (!start) fail("ARCHIVE_LINE_CAPACITY");
    return { lines, byte: byte + start, done: byte + start === file.size };
  } finally { await handle.close(); }
}
function archiveSource(record, file) {
  if (!object(record) || record.type !== "user_message" || record.conversationId !== file.conversationId) return null;
  const userId = qq(record.senderId), mid = id(record.messageId);
  const times = [record.sentAtMs, record.sentAt, record.time].filter(v => v !== undefined && v !== null).map(v => time(v));
  const at = times[0];
  if (!userId || !mid || !times.length || times.some(t => t === null || t !== at)) return null;
  return { verifiedSenderId: userId, messageId: mid, conversationId: record.conversationId,
    logicalBotId: id(record.logicalBotId), accountId: id(record.accountId), time: new Date(at).toISOString(),
    text: text(record.text), via: "archive" };
}

/**
 * memory: pinned read-only snapshot, never live mutable runtime.value.
 * archives: explicit bounded manifest; size/ino are pinned by the host's async
 * stat on the snapshot file. SourceId must identify BOTH snapshot and manifest.
 * Existing files must be immutable; size/ino detect truncation/replacement, not
 * in-place same-size edits. Use snapshot copies or a host content-hash lease.
 * Canonical/archive joins scan only matching conversation files up to a fixed
 * per-page byte allowance. Incomplete joins remain visible Tentative; the later
 * archive pass still scans every record. No invented source/time fallback.
 * Optional async lookupEvidence({sourceId,requests:[{key,userId,conversationId,
 * messageIds}],limit,signal}) -> {sources:[original archive tuples],complete:bool}
 * lets the host use its PINNED worker-side ID index instead of repeated bounded
 * prefix scans. A tuple is {messageId,verifiedSenderId,conversationId,time,
 * logicalBotId:null|string,accountId:null|string,text,via:'archive'}. Never bind
 * today's account registry as historical evidence. Incomplete joins are counted
 * explicitly, not called "no evidence exists". Adapter performs NO model calls.
 */
export function createPeopleReconstructionPager({ memory, archives = [], sourceId, lookupEvidence } = {}) {
  if (!object(memory) || !id(sourceId) || !Array.isArray(archives) || archives.length > 4096) fail("INVALID_SOURCE");
  if (lookupEvidence !== undefined && typeof lookupEvidence !== "function") fail("INVALID_EVIDENCE_LOOKUP");
  const files = archives.map(file => {
    if (!object(file) || !id(file.id) || typeof file.path !== "string" || !file.path.startsWith("/")
      || !/^(group|private):[1-9]\d{4,19}$/.test(file.conversationId) || !integer(file.size)
      || !/^\d+$/.test(String(file.ino))) fail("INVALID_ARCHIVE_MANIFEST");
    return { id: file.id, path: file.path, conversationId: file.conversationId, size: file.size, ino: String(file.ino) };
  });
  let iterator = null, position = 0, busy = false;
  async function join(rows, signal) {
    let remaining = L.evidenceScanBytes;
    const needed = rows.filter(r => r.sourceMessageIds.some(mid => !r.sources.some(s => s.messageId === mid)));
    if (!needed.length) return rows;
    const matches = new Map(), incomplete = new Set();
    function accept(source) {
      for (const r of needed) if (r.userId === source.verifiedSenderId && legacyJobScope(r.jobKey)?.scope === source.conversationId
        && r.sourceMessageIds.includes(source.messageId) && !r.sources.some(s => s.messageId === source.messageId)) {
        if (!matches.has(r.key)) matches.set(r.key, []);
        const list = matches.get(r.key);
        if (list.length < L.sources) list.push(source);
        else incomplete.add(r.key);
      }
    }
    if (lookupEvidence) {
      const found = await lookupEvidence({ sourceId, signal, limit: L.page * L.sources,
        requests: needed.map(r => ({ key: r.key, userId: r.userId,
          conversationId: legacyJobScope(r.jobKey)?.scope ?? null, messageIds: [...r.sourceMessageIds] })) });
      if (!object(found) || !Array.isArray(found.sources) || found.sources.length > L.page * L.sources
        || typeof found.complete !== "boolean") fail("INVALID_EVIDENCE_LOOKUP");
      for (const s of found.sources) {
        if (!object(s)) fail("INVALID_EVIDENCE_LOOKUP");
        accept({ messageId: id(s.messageId), verifiedSenderId: qq(s.verifiedSenderId),
          conversationId: s.conversationId, time: s.time, logicalBotId: id(s.logicalBotId),
          accountId: id(s.accountId), text: text(s.text), via: "archive" });
      }
      if (!found.complete) needed.forEach(r => incomplete.add(r.key));
    } else {
      for (const file of files) {
        if (!needed.some(r => legacyJobScope(r.jobKey)?.scope === file.conversationId)) continue;
        let byte = 0;
        while (byte < file.size && remaining > L.lineBytes) {
          const part = await archiveChunk(file, byte, Math.min(L.pageBytes, remaining), signal);
          remaining -= part.byte - byte; byte = part.byte;
          for (const line of part.lines) {
            let record; try { record = JSON.parse(line.raw); } catch { continue; }
            const s = archiveSource(record, file);
            if (s) accept(s);
          }
          await yieldTurn();
        }
        if (byte < file.size) needed.filter(r => legacyJobScope(r.jobKey)?.scope === file.conversationId)
          .forEach(r => incomplete.add(r.key));
      }
    }
    return rows.flatMap(r => {
      const found = matches.get(r.key);
      const marked = { ...r, joinIncomplete: incomplete.has(r.key) };
      if (!found?.length) return [marked];
      if (r.logicalBotId) return [{ ...marked, sources: [...r.sources, ...found.filter(s => s.logicalBotId === r.logicalBotId)] }];
      const bots = new Set(found.map(s => s.logicalBotId));
      // Ambiguous joins are not a license to choose one owner. Individual raw
      // archive rows will still be scanned in the second phase.
      if (bots.size !== 1) return [{ ...marked, sourceIssue: "ARCHIVE_OWNER_AMBIGUOUS" }];
      const bot = [...bots][0];
      return [{ ...marked, logicalBotId: bot, sources: found }];
    });
  }
  async function readPage(args = {}) {
    if (busy) fail("PAGER_BUSY");
    if (args.sourceId !== sourceId || !integer(args.limit) || args.limit < 1 || args.limit > L.page) fail("INVALID_PAGE_REQUEST");
    busy = true;
    try {
      const c = cursor(args.cursor), rows = []; let visits = 0, scanned = 0;
      const signal = args.signal;
      if (c.phase === "memory") {
        if (!iterator || position > c.offset) { iterator = memorySlots(memory); position = 0; }
        while (position < c.offset) {
          if (iterator.next().done) fail("SOURCE_CURSOR_OUT_OF_RANGE");
          position++; if (++visits % 128 === 0) { await yieldTurn(); if (signal?.aborted) fail("ABORTED"); }
        }
        visits = 0;
        while (rows.length < args.limit && visits < 512) {
          if (signal?.aborted) fail("ABORTED");
          const slot = iterator.next();
          if (slot.done) { c.phase = "archive"; c.file = 0; c.byte = 0; break; }
          visits++;
          if (slot.value) {
            const expanded = canonicalRows(slot.value);
            if (expanded.length > args.limit) fail("PAGE_LIMIT_TOO_SMALL");
            if (rows.length + expanded.length > args.limit
              || Buffer.byteLength(JSON.stringify([...rows, ...expanded])) > L.pageBytes) {
              iterator = null; break; // next page cooperatively reopens at this exact slot
            }
            rows.push(...expanded); scanned++;
          }
          position++;
          if (visits % 128 === 0) await yieldTurn();
        }
        c.offset = position;
        const joined = await join(rows, signal);
        if (joined.length > args.limit || Buffer.byteLength(JSON.stringify(joined)) > L.pageBytes) fail("PAGE_CAPACITY");
        return { sourceId, rows: joined, nextCursor: c, scanned };
      }
      if (c.phase === "archive") {
        if (c.file > files.length) fail("SOURCE_CURSOR_OUT_OF_RANGE");
        if (c.file === files.length) return { sourceId, rows, nextCursor: { ...c, phase: "done" }, scanned };
        const file = files[c.file], part = await archiveChunk(file, c.byte, L.pageBytes, signal);
        for (const line of part.lines) {
          if (rows.length >= args.limit) break;
          c.byte = line.end;
          scanned++;
          let record; try { record = JSON.parse(line.raw); } catch {
            rows.push({ key: `row_${hash([file.id, line.byte])}`, origin: "archive", jobKey: file.conversationId,
              userId: null, value: "", kind: "episode", sources: [], sourceMessageIds: [] }); continue;
          }
          const s = archiveSource(record, file);
          if (!s) {
            if (record?.type === "user_message") rows.push({ key: `row_${hash([file.id, line.byte])}`,
              origin: "archive", jobKey: file.conversationId, userId: qq(record.senderId),
              value: "", kind: "episode", invalidSource: true, sources: [], sourceMessageIds: [] });
            continue;
          }
          rows.push({ key: `row_${hash([file.id, line.byte])}`, origin: "archive", jobKey: file.conversationId,
            userId: s.verifiedSenderId, logicalBotId: s.logicalBotId, value: s.text ?? "", kind: "episode",
            status: "tentative", sourceMessageIds: [s.messageId], sources: [s], evidenceKeys: [] });
        }
        if (!part.lines.length || c.byte === file.size) { c.file++; c.byte = 0; }
        if (c.file === files.length) c.phase = "done";
      }
      return { sourceId, rows, nextCursor: c, scanned };
    } finally { busy = false; }
  }
  return { sourceId, readPage };
}
