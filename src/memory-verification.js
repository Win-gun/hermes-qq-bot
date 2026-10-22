import { createHash } from "node:crypto";
import { prepareMemoryEvidenceBatch } from "./memory-evidence.js";

/** Pure synchronous draft APIs. No IO, clocks, models, timers or sends.
 * Call inside the parent's latest-draft transaction; publish before notifying.
 * now is a REQUIRED zoned ISO time. created/updated are safe preview arrays;
 * rejected and backpressure are receipts, never implicit eviction/retry.
 * Full config: memoryVerification (or memory.verification). Shadow records only;
 * live collect stages holds only against an unchanged snapshot (apart from the
 * expected arrival of a candidate's matching canonical entry).
 * notifications and all unknown store/group/legacy fields are preserved.
 * revision is opaque: refresh via collect after target changes. List exposes a
 * current revision plus stale=true when the stored target snapshot is stale;
 * resolving stale snapshots is forbidden even with that current revision.
 * authorized MUST be a caller-built boolean, never an AI-provided field. Admin
 * assertions are separate provenance, NEVER a subject's self evidence.
 * Semantic hints alone never hold OLD. Live collection holds OLD only when NEW
 * has separately supported canonical evidence (or prior authenticated authority).
 * List derives age deferral from explicit now and the captured deferAfterMs;
 * options.config can override the threshold. Derived status never changes CAS,
 * chooses a fact, clears a hold or writes a timestamp to the stored case.
 * List offset/limit slice the status+caseId matches, not raw stored cases.
 * totals.filteredTotal counts matches before slicing; status totals still cover
 * all cases in the requested conversation(s). Invalid query options return a
 * fixed INVALID_OPTIONS receipt. No-option reads retain the 200-item default.
 */
const BAD = new Set(["__proto__", "constructor", "prototype"]);
const RELATIONS = new Set(["contradiction", "change", "condition", "identity_ambiguous"]);
const ACTIONS = new Set(["update", "coexist", "new_invalid", "old_invalid", "unsure"]);
const OPEN = new Set(["active", "tentative", "disputed"]);
const MAX_CASES = 512, MAX_ADMISSIONS = 32, MAX_HINTS = 128, MAX_PREVIEW = 200;

function record(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return (p === Object.prototype || p === null) && Reflect.ownKeys(v).every(k => typeof k === "string"
    && !BAD.has(k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value"));
}
function data(v, seen = new Set(), budget = { left: 250_000 }) {
  if (--budget.left < 0 || seen.size > 64) return false;
  if (v === null || ["string", "boolean"].includes(typeof v)) return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object" || seen.has(v)) return false;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1
      || Reflect.ownKeys(v).some(k => typeof k !== "string" || (k !== "length" && !/^(0|[1-9]\d*)$/.test(k))
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value"))) return false;
  } else if (!record(v)) return false;
  seen.add(v);
  const valid = Object.keys(v).every(k => data(v[k], seen, budget));
  seen.delete(v);
  return valid;
}
function id(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return typeof v === "string" && v.length > 0 && v.length <= 256 && !BAD.has(v)
    && !/[\s\u0000-\u001f\u007f]/u.test(v) ? v : null;
}
function time(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)) return null;
  const [y, m, d, h, n, s] = v.slice(0, 19).split(/\D/).map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ms = Date.parse(v);
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && h < 24 && n < 60 && s < 60
    && Number.isFinite(ms) && ms >= 0 && ms <= 253402300799999 ? new Date(ms).toISOString() : null;
}
function stable(v) {
  return JSON.stringify(v, (_, x) => record(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
}
function hash(v) { return createHash("sha256").update(stable(v)).digest("hex"); }
function normalized(v) { return v.normalize("NFKC").toLowerCase().replace(/[，。！？!?、；;：:\s"'“”‘’（）()\[\]【】]/g, ""); }
// Same ID algorithm as integrity's canonical writer, so a rejected case-only
// candidate blocks later extraction too, not merely another verification case.
function canonicalId(subject, kind, value) {
  let text = value.replace(/\s+/g, " ").trim();
  const max = kind === "notable_quote" ? 180 : 240;
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  const key = text.toLowerCase().replace(/[，。！？!?、；;：:\s"'“”‘’（）()\[\]【】]/g, "");
  return `mem_${createHash("sha256").update(`${subject}|${kind}|${key}`).digest("hex").slice(0, 16)}`;
}
function privacy(v) {
  return v.replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/((?:password|passkey|secret|api[_ -]?key|token|密码|口令|验证码)\s*[:=：]?\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(?<!\d)(?:1[3-9]\d{9}|\d{15,19}[Xx]?)(?!\d)/g, "[REDACTED]")
    .replace(/(?:住址|地址|address)\s*[:：=]?\s*[^\n。；;]+/gi, "[REDACTED ADDRESS]");
}
function clean(v, redact = privacy, max = 240) {
  if (typeof v !== "string" || !v.trim() || v.length > 4096) throw new Error("INVALID_VALUE");
  let output;
  try { output = redact(privacy(v)); } catch { throw new Error("REDACTION_REJECTED"); }
  if (typeof output !== "string" || !output.trim()) throw new Error("REDACTION_REJECTED");
  const cleaned = privacy(output).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  if (!cleaned) throw new Error("REDACTION_REJECTED");
  return cleaned;
}
function uniqueIds(v) { return Array.isArray(v) ? [...new Set(v.map(id).filter(Boolean))].sort() : []; }
function integer(v, fallback, max) { return Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fallback; }

export function memoryVerificationConfig(config = {}) {
  if (!record(config)) config = {};
  // Runtime callbacks elsewhere in the full config are not verification data.
  // Inspect descriptors before selecting the narrow, JSON-only settings block.
  const raw = Object.hasOwn(config, "memoryVerification") ? config.memoryVerification
    : record(config.memory) && Object.hasOwn(config.memory, "verification") ? config.memory.verification : config;
  const fields = ["enabled", "shadowMode", "adminUserIds", "groupAdminUserIds", "notificationAccountIds", "perGroupDailyLimit", "cooldownMs", "deferAfterMs"];
  const c = record(raw) ? Object.fromEntries(fields.filter(k => Object.hasOwn(raw, k) && data(raw[k])).map(k => [k, raw[k]])) : {};
  const adminUserIds = uniqueIds(c.adminUserIds);
  const groupAdminUserIds = {}, notificationAccountIds = {};
  for (const [k, v] of Object.entries(record(c.groupAdminUserIds) ? c.groupAdminUserIds : {})) {
    if (id(k)) groupAdminUserIds[k] = uniqueIds(v);
  }
  for (const [k, v] of Object.entries(record(c.notificationAccountIds) ? c.notificationAccountIds : {})) {
    if (id(k) && (id(v) || Array.isArray(v))) notificationAccountIds[k] = Array.isArray(v) ? uniqueIds(v) : id(v);
  }
  return { enabled: c.enabled !== false, shadowMode: c.shadowMode !== false, adminUserIds, groupAdminUserIds,
    notificationAccountIds, perGroupDailyLimit: integer(c.perGroupDailyLimit, 3, 1000),
    cooldownMs: integer(c.cooldownMs, 86400000, 31536000000), deferAfterMs: integer(c.deferAfterMs, 604800000, 31536000000) };
}
export function isVerificationAdmin(config, userId, conversationId) {
  const user = id(userId), conv = id(conversationId), c = memoryVerificationConfig(config);
  return !!(user && conv && (c.adminUserIds.includes(user) || (c.groupAdminUserIds[conv] || []).includes(user)));
}

function optionsFor(options) {
  if (!record(options) || !time(options.now) || (options.redact !== undefined && typeof options.redact !== "function")
    || (options.config !== undefined && !record(options.config))
    || (options.botUserIds !== undefined && (!data(options.botUserIds) || !Array.isArray(options.botUserIds)
      || options.botUserIds.some(v => !id(v))))) throw new Error("INVALID_OPTIONS");
  return { now: time(options.now), redact: options.redact || privacy, config: memoryVerificationConfig(options.config || {}) };
}
function relevant(group) {
  if (!record(group)) throw new Error("INVALID_GROUP");
  const draft = {};
  for (const k of ["users", "groupFactMemory", "groupTopicMemory", "memoryVerification"]) {
    if (Object.hasOwn(group, k)) {
      if (!record(group[k]) || !data(group[k])) throw new Error("INVALID_MEMORY_STATE");
      draft[k] = structuredClone(group[k]);
    }
  }
  if (draft.memoryVerification && (draft.memoryVerification.version !== 1 || !Array.isArray(draft.memoryVerification.cases)
    || draft.memoryVerification.cases.some(c => !record(c)))) throw new Error("INVALID_VERIFICATION_STATE");
  return draft;
}
function holders(group, conv) {
  const result = [];
  for (const [subject, holder] of Object.entries(group.users || {})) {
    if (id(subject) && record(holder) && holder.canonicalMemory?.subjectUserId === subject
      && ["user_id", "userId", "subjectUserId", "qq"].every(k => holder[k] === undefined || id(holder[k]) === subject)) {
      result.push({ subject, scope: "user", holder });
    }
  }
  for (const [slot, scope] of [["groupFactMemory", "facts"], ["groupTopicMemory", "topics"]]) {
    const holder = group[slot], subject = `conversation:${conv}:${scope}`;
    if (holder?.conversationId === conv && holder.canonicalMemory?.subjectUserId === subject) result.push({ subject, scope, holder });
  }
  return result.filter(x => Array.isArray(x.holder.canonicalMemory.entries));
}
function entries(h) {
  const all = h.holder.canonicalMemory.entries;
  const counts = new Map();
  for (const e of all) if (record(e) && id(e.id)) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  return all.filter(e => record(e) && id(e.id) && counts.get(e.id) === 1 && e.subjectUserId === h.subject
    && typeof e.value === "string" && typeof e.kind === "string");
}
function terminal(e) {
  return e && (e.status === "rejected" || e.status === "superseded"
    || (e.correctedAt && ["reject", "supersede"].includes(e.correctionAction)));
}
function eligible(e, conv) { return !terminal(e) && OPEN.has(e.status) && (!e.sourceConversationId || [conv, "legacy"].includes(e.sourceConversationId)); }
function strong(e) {
  return Number.isFinite(e.confidence) && e.confidence >= 0.65
    && (e.source === "legacy-canonical" || !!time(e.explicitAt) || !!time(e.selfExplicitAt)
      || (e.source === "admin-verification" && Array.isArray(e.adminProvenance) && e.adminProvenance.some(p => p.type === "ADMIN"))
      || uniqueIds(e.evidenceKeys).length >= 2 || uniqueIds(e.sourceMessageIds).length >= 2);
}
function supportedNew(e, conv) {
  if (!e || !eligible(e, conv) || !Number.isFinite(e.confidence) || e.confidence < 0.65) return false;
  if (time(e.explicitAt) || (e.source === "admin-verification" && Array.isArray(e.adminProvenance)
    && e.adminProvenance.some(p => p.type === "ADMIN"))) return true;
  // An AI hint has no confidence/truth authority. A hold on reliable OLD memory
  // needs a separately supported canonical NEW claim, not one authored event.
  const keys = uniqueIds(e.evidenceKeys).flatMap(key => {
    try {
      const parsed = JSON.parse(key);
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== conv || !id(parsed[1])) return [];
      return [JSON.stringify([conv, id(parsed[1])])];
    } catch { return []; }
  });
  return new Set(keys).size >= 2;
}
function polarity(v) { return /不喜欢|讨厌|不爱|不是|拒绝|雷点|避免/.test(v) ? -1 : 1; }
function contradiction(e) {
  if (!["preference", "boundary", "profile", "personality"].includes(e.kind)) return "";
  const text = normalized(e.value).replace(/^(我|本人|他|她|ta)/, "").replace(/^(不喜欢|讨厌|不爱|喜欢|爱好|偏好|不是|是)/, "");
  return text.length >= 2 ? `${e.kind}:${text}` : "";
}
function memoryView(e, redact, sourceLimit = Infinity) {
  const result = { id: e.id, subjectUserId: e.subjectUserId, kind: e.kind, value: clean(e.value, redact), status: e.status,
    confidence: Number.isFinite(e.confidence) ? e.confidence : null, source: typeof e.source === "string" ? clean(e.source, redact, 80) : "",
    firstSeenAt: time(e.firstSeenAt), lastConfirmedAt: time(e.lastConfirmedAt),
    sentAt: time(e.lastConfirmedAt) || time(e.firstSeenAt),
    sourceMessageIds: uniqueIds(e.sourceMessageIds).slice(0, sourceLimit), verificationHoldCaseIds: uniqueIds(e.verificationHoldCaseIds).slice(0, sourceLimit) };
  // Preview only; originals remain on canonical entries. No raw excerpts/quotes.
  result.evidence = { sourceMessageIds: result.sourceMessageIds,
    sourceMessageTimes: Object.fromEntries(Object.entries(e.sourceMessageTimes || {}).filter(([k, v]) => id(k) && time(v)).slice(0, sourceLimit)),
    sourceUserIds: uniqueIds(e.sourceUserIds).slice(0, sourceLimit), sourceConversationId: id(e.sourceConversationId) || null,
    confirmations: Number.isSafeInteger(e.evidenceConfirmations) ? e.evidenceConfirmations : 0 };
  if (typeof e.condition === "string" && e.condition.trim()) result.condition = clean(e.condition, redact);
  return result;
}
function locate(group, c) {
  const h = holders(group, c.conversationId).find(h => h.subject === c.subjectUserId && h.scope === c.scope);
  if (!h) return null;
  const all = entries(h), old = all.find(e => e.id === c.oldMemory.id);
  const rawMatches = h.holder.canonicalMemory.entries.filter(e => e.id === c.newMemory.id
    || (e.kind === c.newMemory.kind && typeof e.value === "string" && hash(normalized(e.value)) === c.newValueDigest));
  if (rawMatches.some(e => !all.includes(e))) return null;
  const matches = all.filter(e => e.id !== old?.id && e.kind === c.newMemory.kind && hash(normalized(e.value)) === c.newValueDigest);
  const newer = all.find(e => e.id === c.newMemory.id) || (matches.length === 1 ? matches[0] : null);
  return old ? { h, old, newer, all } : null;
}
function snapshot(target) {
  const content = e => {
    if (!e) return null;
    const { verificationHoldCaseIds: _holds, ...rest } = e;
    return rest;
  };
  const preConflict = e => {
    if (!e) return null;
    const { status: _status, conflictsWith: _conflicts, supersedes: _supersedes, ...rest } = content(e);
    return rest;
  };
  return target ? { oldDigest: hash(target.old), newDigest: hash(target.newer || null),
    oldContentDigest: hash(content(target.old)), newContentDigest: hash(content(target.newer)),
    oldPreConflictDigest: hash(preConflict(target.old)),
    targetsDigest: hash([target.h.subject, target.h.scope, target.old, target.newer || null]) } : null;
}
function targetIdentity(entry) {
  return hash([entry.id, entry.subjectUserId, entry.kind, normalized(entry.value)]);
}
function revision(c, targets) {
  const { revision: _revision, ...body } = c;
  return `mvrev_${hash([body, targets]).slice(0, 40)}`;
}
function refresh(c, target) { c.snapshot = snapshot(target); c.revision = revision(c, c.snapshot?.targetsDigest || null); }
function caseReadStatus(c, now, config) {
  const limit = config?.deferAfterMs ?? integer(c.deferAfterMs, 604800000, 31536000000);
  const age = time(now) && time(c.createdAt) ? Date.parse(now) - Date.parse(c.createdAt) : null;
  return c.status === "pending" && age !== null && age >= limit ? "deferred" : c.status;
}
function preview(c, group, redact, now, config) {
  const target = locate(group, c), digest = snapshot(target)?.targetsDigest || null;
  const status = caseReadStatus(c, now, config), aged = c.status === "pending" && status === "deferred";
  // Return an allowlist; unknown persisted fields (including audit extras) never
  // cross the UI boundary. Values are redacted again with the current policy.
  const view = v => memoryView({ ...v, sourceMessageTimes: v.evidence?.sourceMessageTimes || v.sourceMessageTimes,
    sourceUserIds: v.evidence?.sourceUserIds || v.sourceUserIds,
    sourceConversationId: v.evidence?.sourceConversationId || v.sourceConversationId,
    evidenceConfirmations: v.evidence?.confirmations ?? v.evidenceConfirmations }, redact, 32);
  return { id: c.id, conversationId: c.conversationId, subjectUserId: c.subjectUserId, scope: c.scope,
    classification: c.classification, status, derivedDeferred: aged, candidate: c.candidate === true, shadowMode: c.shadowMode === true,
    revision: revision(c, digest), stale: c.snapshot?.targetsDigest !== digest,
    notificationReady: status === "pending" && c.shadowMode === false && c.snapshot?.targetsDigest === digest,
    oldMemory: view(target?.old || c.oldMemory), newMemory: view(target?.newer || c.newMemory),
    condition: c.condition ? clean(c.condition, redact) : null,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    deferredAt: c.deferredAt || (aged ? new Date(Math.min(253402300799999, Date.parse(c.createdAt)
      + (config?.deferAfterMs ?? integer(c.deferAfterMs, 604800000, 31536000000)))).toISOString() : null), resolvedAt: c.resolvedAt || null,
    resolvedAction: c.resolvedAction || null, resolvedMemoryId: c.resolvedMemoryId || null,
    resolvedMemoryIds: uniqueIds(c.resolvedMemoryIds),
    auditCount: Array.isArray(c.audit) ? c.audit.length : 0 };
}
function audit(c, event) { if (!c.audit) c.audit = []; c.audit.push(event); }
function addHold(e, caseId) {
  if (e && !terminal(e)) e.verificationHoldCaseIds = uniqueIds([...(e.verificationHoldCaseIds || []), caseId]);
}
function removeHold(e, caseId) {
  if (e?.verificationHoldCaseIds) e.verificationHoldCaseIds = uniqueIds(e.verificationHoldCaseIds).filter(x => x !== caseId);
}
function publish(group, draft) {
  for (const [subject, holder] of Object.entries(draft.users || {})) {
    if (group.users?.[subject] && holder.canonicalMemory
      && stable(group.users[subject].canonicalMemory) !== stable(holder.canonicalMemory)) group.users[subject].canonicalMemory = holder.canonicalMemory;
  }
  for (const slot of ["groupFactMemory", "groupTopicMemory"]) {
    if (draft[slot] && stable(group[slot]?.canonicalMemory) !== stable(draft[slot].canonicalMemory)) group[slot].canonicalMemory = draft[slot].canonicalMemory;
  }
  if (draft.memoryVerification && stable(group.memoryVerification || null) !== stable(draft.memoryVerification)) group.memoryVerification = draft.memoryVerification;
}
function receipt() { return { created: [], updated: [], rejected: [], backpressure: { blocked: 0, maxCases: MAX_CASES, maxNewCases: MAX_ADMISSIONS } }; }
function admit(group, h, old, newer, relation, o, result, extra = {}) {
  const s = group.memoryVerification || { version: 1, cases: [] };
  const value = clean(newer.value, o.redact), valueDigest = hash(normalized(value));
  const caseId = `mvc_${hash([extra.conversationId, h.subject, old.id, valueDigest]).slice(0, 32)}`;
  let c = s.cases.find(c => c.id === caseId);
  if (c) {
    // A fresh, attributed hint can revalidate an unchanged assertion after its
    // evidence changes. Replays alone cannot rebase stale snapshots or create
    // reminders. Keep every original source time; never rewrite its event time.
    if (extra.origin !== "semantic_hint" || c.status === "resolved") return c;
    const previous = c.candidateEvidence || c.newMemory.evidence;
    const incoming = memoryView(newer, o.redact).evidence;
    if (incoming.sourceMessageIds.some(x => previous.sourceMessageTimes[x]
      && previous.sourceMessageTimes[x] !== incoming.sourceMessageTimes[x])) throw new Error("SOURCE_TIME_CONFLICT");
    const fresh = incoming.sourceMessageIds.filter(x => !previous.sourceMessageIds.includes(x));
    if (!fresh.length) return c;
    const target = locate(group, c);
    if (!target || terminal(target.old) || (target.newer && terminal(target.newer))
      || normalized(clean(target.old.value, o.redact)) !== normalized(c.oldMemory.value)) throw new Error("TARGET_CHANGED");
    c.candidateEvidence = { ...previous,
      sourceMessageIds: uniqueIds([...previous.sourceMessageIds, ...incoming.sourceMessageIds]),
      sourceMessageTimes: { ...previous.sourceMessageTimes, ...incoming.sourceMessageTimes },
      sourceUserIds: uniqueIds([...previous.sourceUserIds, ...incoming.sourceUserIds]) };
    if (c.newMemory.status === "candidate") {
      c.newMemory.sourceMessageIds = [...c.candidateEvidence.sourceMessageIds];
      c.newMemory.evidence = structuredClone(c.candidateEvidence);
      const times = Object.values(c.candidateEvidence.sourceMessageTimes).sort();
      c.newMemory.firstSeenAt = times[0]; c.newMemory.lastConfirmedAt = times.at(-1); c.newMemory.sentAt = times.at(-1);
    }
    c.updatedAt = o.now;
    audit(c, { type: "hint_evidence_added", at: o.now, sourceMessageIds: fresh });
    refresh(c, target);
    if (!result.updated.includes(c)) result.updated.push(c);
    return c;
  }
  if (s.cases.length >= MAX_CASES || result.created.length >= MAX_ADMISSIONS) { result.backpressure.blocked += 1; return null; }
  c = { id: caseId, conversationId: extra.conversationId, subjectUserId: h.subject, scope: h.scope,
    oldMemory: memoryView(old, o.redact), newMemory: { ...memoryView(newer, o.redact), value }, newValueDigest: valueDigest,
    oldTargetIdentity: targetIdentity(old), newTargetIdentity: targetIdentity(newer),
    classification: relation, status: "pending", candidate: extra.candidate === true, origin: extra.origin || "canonical",
    candidateEvidence: memoryView(newer, o.redact).evidence,
    shadowMode: o.config.shadowMode, holdRequired: extra.holdRequired === true, deferAfterMs: o.config.deferAfterMs, createdAt: o.now, updatedAt: o.now,
    audit: [{ type: "created", at: o.now, origin: extra.origin || "canonical" }] };
  if (extra.condition) c.condition = clean(extra.condition, o.redact);
  if (!group.memoryVerification) group.memoryVerification = s;
  s.cases.push(c);
  refresh(c, locate(group, c));
  result.created.push(c); // Converted to detached safe previews before return.
  return c;
}
function synchronize(group, conv, o, result) {
  const processed = [];
  for (const c of group.memoryVerification?.cases || []) {
    if (c.conversationId !== conv || c.status === "resolved") continue;
    const target = locate(group, c);
    if (!target || terminal(target.old) || (target.newer && terminal(target.newer))) continue;
    const before = stable(c), current = snapshot(target);
    // A newly arrived exact candidate may attach, but no unrelated target
    // modification (including a correction/hold) can authorize live holds.
    const matching = current.targetsDigest === c.snapshot?.targetsDigest;
    const holdsOnly = current.oldContentDigest === c.snapshot?.oldContentDigest && current.newContentDigest === c.snapshot?.newContentDigest;
    const unchangedOld = current.oldContentDigest === c.snapshot?.oldContentDigest;
    const expectedDispute = target.old.status === "disputed" && current.oldPreConflictDigest === c.snapshot?.oldPreConflictDigest;
    const arrival = (unchangedOld || expectedDispute) && c.newMemory.status === "candidate"
      && c.snapshot?.newDigest === hash(null) && target.newer && hash(normalized(target.newer.value)) === c.newValueDigest;
    if (!matching && !arrival && !holdsOnly) continue;
    if (arrival) c.newMemory = memoryView(target.newer, o.redact);
    const oldShadow = c.shadowMode;
    if (!o.config.shadowMode) {
      if (c.origin === "semantic_hint") {
        c.holdRequired = supportedNew(target.newer, conv);
        if (c.holdRequired) addHold(target.old, c.id);
        else {
          removeHold(target.old, c.id); // Only this case's historical weak hold.
          // The ordinary polarity merger may have just marked BOTH entries
          // disputed. Restore only a prior, reliable ACTIVE snapshot whose
          // evidence/identity did not change; never revive preexisting disputes
          // or human corrections on the strength of a weak AI candidate.
          if (arrival && expectedDispute && c.oldMemory.status === "active" && strong(target.old)
            && !target.old.correctedAt) {
            target.old.status = "active";
            if (target.newer?.status === "disputed") target.newer.status = "tentative";
          }
        }
        addHold(target.newer, c.id); // A weak NEW candidate cannot bypass reads.
      } else if (c.holdRequired) { addHold(target.old, c.id); addHold(target.newer, c.id); }
      c.shadowMode = false;
    }
    processed.push({ c, target, arrival, oldShadow, before });
  }
  // Install all validated holds first; then fingerprint their final union, so
  // sibling cases sharing an old target do not stale one another on creation.
  for (const { c, target, arrival, oldShadow, before } of processed) {
    if (c.snapshot?.targetsDigest !== snapshot(target).targetsDigest || c.shadowMode !== oldShadow || stable(c) !== before) {
      // Turning shadow back on never clears a previously installed safety hold.
      c.updatedAt = o.now;
      audit(c, { type: arrival ? "candidate_attached" : "snapshot_refreshed", at: o.now });
      refresh(c, target);
    }
    if (stable(c) !== before && !result.created.includes(c) && !result.updated.includes(c)) result.updated.push(c);
  }
}
function finish(group, draft, result, o) {
  const created = result.created.map(c => preview(c, draft, o.redact, o.now, o.config));
  const updated = result.updated.map(c => preview(c, draft, o.redact, o.now, o.config));
  publish(group, draft);
  return { ...result, created, updated };
}

export function collectVerificationCases(group, conversationId, options = {}) {
  const result = receipt();
  try {
    const o = optionsFor(options), conv = id(conversationId);
    if (!conv) throw new Error("INVALID_CONVERSATION_ID");
    const draft = relevant(group);
    if (!o.config.enabled) return result;
    for (const h of holders(draft, conv)) {
      const all = entries(h).filter(e => eligible(e, conv));
      const conflicts = h.holder.canonicalMemory.conflicts || [];
      for (let i = 0; i < all.length; i++) for (const b of all.slice(i + 1)) {
        const a = all[i];
        if (a.source === "admin-verification" && b.source === "admin-verification" && a.condition && b.condition
          && a.verificationResolutionCaseId && a.verificationResolutionCaseId === b.verificationResolutionCaseId) continue;
        const linked = (a.conflictsWith || []).includes(b.id) || (b.conflictsWith || []).includes(a.id)
          || conflicts.some(c => !c.resolvedBy && Array.isArray(c.entries) && c.entries.includes(a.id) && c.entries.includes(b.id));
        const opposite = contradiction(a) && contradiction(a) === contradiction(b) && polarity(a.value) !== polarity(b.value);
        if (!linked && !opposite) continue;
        const ordered = [a, b].sort((x, y) => (Date.parse(x.firstSeenAt) || 0) - (Date.parse(y.firstSeenAt) || 0) || x.id.localeCompare(y.id));
        const [old, newer] = ordered;
        const bothStrong = strong(old) && strong(newer);
        const semantic = (draft.memoryVerification?.cases || []).find(c => c.conversationId === conv && c.subjectUserId === h.subject
          && ((c.oldMemory.id === old.id && c.newValueDigest === hash(normalized(newer.value)))
            || (c.oldMemory.id === newer.id && c.newValueDigest === hash(normalized(old.value)))));
        if (semantic) continue;
        admit(draft, h, old, newer, "contradiction", o, result, { conversationId: conv,
          candidate: !bothStrong, holdRequired: bothStrong || (old.status === "disputed" && newer.status === "disputed") });
      }
    }
    synchronize(draft, conv, o, result);
    return finish(group, draft, result, o);
  } catch (e) { return { ...receipt(), rejected: [{ code: e.message }] }; }
}

export function applyVerificationHints(group, conversationId, hints, rawMessages, options = {}) {
  const result = receipt();
  try {
    const o = optionsFor(options), conv = id(conversationId);
    if (!conv) throw new Error("INVALID_CONVERSATION_ID");
    if (!Array.isArray(hints) || !data(hints) || !data(rawMessages)) throw new Error("INVALID_HINTS");
    const draft = relevant(group);
    if (!o.config.enabled) return result;
    const batch = prepareMemoryEvidenceBatch(rawMessages, { conversationId: conv, botUserIds: options.botUserIds || [] });
    if (batch.errors.length) throw new Error(batch.errors[0]);
    const sources = new Map(batch.messages.map(row => [row.message_id, row]));
    for (let index = 0; index < hints.length; index++) {
      if (index >= MAX_HINTS) { result.backpressure.blocked += 1; continue; }
      try {
        const hint = hints[index];
        if (!record(hint) || !id(hint.subjectUserId) || !id(hint.memoryId) || !RELATIONS.has(hint.relation)
          || !Array.isArray(hint.sourceMessageIds) || !hint.sourceMessageIds.length || hint.sourceMessageIds.some(x => !id(x))) throw new Error("INVALID_HINT");
        const subject = id(hint.subjectUserId), ids = uniqueIds(hint.sourceMessageIds);
        const h = holders(draft, conv).find(h => h.subject === subject);
        if (!h) throw new Error("UNKNOWN_SUBJECT");
        const old = entries(h).find(e => e.id === id(hint.memoryId));
        if (!old || !eligible(old, conv)) throw new Error("INVALID_TARGET");
        // Synthetic group subjects may cite multiple humans, but personal claims
        // MUST cite only original messages from the exact same QQ user.
        const rows = ids.map(x => sources.get(x));
        if (rows.some(row => !row || (h.scope === "user" && row.user_id !== subject))) throw new Error("SOURCE_NOT_ELIGIBLE");
        if (rows.some(row => row.sent_at > o.now)) throw new Error("FUTURE_SOURCE");
        const value = clean(hint.newValue, o.redact);
        if (!normalized(value) || normalized(value) === normalized(clean(old.value, o.redact))) throw new Error("SAME_VALUE");
        const times = Object.fromEntries(rows.map(row => [row.message_id, row.sent_at]));
        const newer = { id: canonicalId(subject, old.kind, value),
          kind: old.kind, value, subjectUserId: subject, confidence: 0, status: "candidate", source: "ai-verification-hint",
          sourceMessageIds: ids, sourceMessageTimes: times, sourceUserIds: [...new Set(rows.map(row => row.user_id))].sort(),
          sourceConversationId: conv, firstSeenAt: rows.map(row => row.sent_at).sort()[0], lastConfirmedAt: rows.map(row => row.sent_at).sort().at(-1) };
        admit(draft, h, old, newer, hint.relation, o, result, { conversationId: conv, candidate: true, origin: "semantic_hint",
          holdRequired: false, condition: hint.condition });
      } catch (e) { result.rejected.push({ index, code: e.message }); }
    }
    synchronize(draft, conv, o, result);
    return finish(group, draft, result, o);
  } catch (e) { return { ...receipt(), rejected: [{ code: e.message }] }; }
}

function scopedGroups(memory, conversationId) {
  if (!record(memory) || !record(memory.groups)) return [];
  return Object.entries(memory.groups).filter(([key, group]) => id(key) && (!conversationId || key === conversationId) && record(group));
}
export function listVerificationCases(memory, options = {}) {
  const emptyTotals = () => ({ pending: 0, deferred: 0, resolved: 0, total: 0, filteredTotal: 0, returned: 0, truncated: 0 });
  const totals = emptyTotals();
  const cases = [];
  const failure = (code, offset = 0, limit = MAX_PREVIEW) => ({ ok: false, code, cases: [], totals: emptyTotals(),
    pagination: { offset, limit, nextOffset: null, hasMore: false } });
  if (!record(options) || (options.now !== undefined && !time(options.now))
    || (options.config !== undefined && !record(options.config))
    || (options.redact !== undefined && typeof options.redact !== "function")
    || (options.conversationId !== undefined && !id(options.conversationId))
    || (options.caseId !== undefined && !id(options.caseId))
    || (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0))
    || (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_PREVIEW))
    || (options.status !== undefined && !["pending", "deferred", "resolved"].includes(options.status))) return failure("INVALID_OPTIONS");
  const offset = options.offset ?? 0, limit = options.limit ?? MAX_PREVIEW;
  const config = options.config === undefined ? undefined : memoryVerificationConfig(options.config);
  const conversationId = options.conversationId === undefined ? undefined : id(options.conversationId);
  const caseId = options.caseId === undefined ? undefined : id(options.caseId);
  for (const [conv, group] of scopedGroups(memory, conversationId)) {
    // No inbox means no need to inspect/clone historical user portraits. The
    // outer record check already validated the group's own descriptors.
    if (!Object.hasOwn(group, "memoryVerification")) continue;
    try {
      const draft = relevant(group);
      for (const c of draft.memoryVerification?.cases || []) {
        if (c.conversationId !== conv || !["pending", "deferred", "resolved"].includes(c.status)) continue;
        const status = caseReadStatus(c, options.now, config);
        totals[status]++; totals.total++;
        if ((options.status && status !== options.status) || (caseId && c.id !== caseId)) continue;
        const position = totals.filteredTotal++;
        if (position >= offset && cases.length < limit) cases.push(preview(c, draft, options.redact || privacy, options.now, config));
      }
    } catch { return failure("INVALID_MEMORY_STATE", offset, limit); }
  }
  totals.returned = cases.length;
  totals.truncated = Math.max(0, totals.filteredTotal - offset - cases.length);
  const hasMore = totals.truncated > 0;
  return { cases, totals, pagination: { offset, limit, nextOffset: hasMore ? offset + cases.length : null, hasMore } };
}

export function resolveVerificationCase(memory, request) {
  const fail = code => ({ ok: false, code });
  if (!record(request)) return fail("INVALID_REQUEST");
  // Parent handlers naturally construct optional fields as undefined; accept
  // those top-level omissions without admitting undefined nested payloads.
  request = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
  if (!data(request)) return fail("INVALID_REQUEST");
  if (request.authorized !== true || !id(request.actorUserId)) return fail("UNAUTHORIZED");
  const conv = id(request.conversationId), caseId = id(request.caseId), now = time(request.now);
  const sourceSentAt = request.sourceSentAt === undefined ? null : time(request.sourceSentAt);
  if (!conv || !caseId || !now || !id(request.expectedRevision) || !ACTIONS.has(request.action)
    || (request.sourceSentAt !== undefined && !sourceSentAt)
    || (request.sourceMessageId !== undefined && !id(request.sourceMessageId))) return fail("INVALID_REQUEST");
  const group = scopedGroups(memory, conv)[0]?.[1];
  if (!group) return fail("NOT_FOUND");
  try {
    const draft = relevant(group), matches = draft.memoryVerification?.cases.filter(c => c.id === caseId && c.conversationId === conv) || [];
    if (matches.length !== 1) return fail("NOT_FOUND");
    const c = matches[0];
    if (c.status === "resolved") return fail("CONFLICT");
    const target = locate(draft, c), snap = snapshot(target);
    if (!target || c.snapshot?.targetsDigest !== snap.targetsDigest || request.expectedRevision !== revision(c, snap.targetsDigest)) return fail("STALE_REVISION");
    if (!time(c.createdAt) || !time(c.updatedAt) || now < c.createdAt || now < c.updatedAt) return fail("STALE_TIME");
    const { old, newer, h, all } = target;
    if (terminal(old) || (newer && terminal(newer))) return fail("TERMINAL_CORRECTION");
    if (["update", "coexist"].includes(request.action) && all.some(e => terminal(e) && e.kind === c.newMemory.kind
      && hash(normalized(e.value)) === c.newValueDigest)) return fail("TERMINAL_CORRECTION");
    if (["new_invalid", "coexist"].includes(request.action) && all.some(e => e.id !== old.id && terminal(e)
      && e.kind === old.kind && normalized(e.value) === normalized(old.value)
      && (e.status === "rejected" || e.correctionAction === "reject"))) return fail("TERMINAL_CORRECTION");
    if (request.action === "coexist" && (typeof request.condition !== "string" || !request.condition.trim())) return fail("CONDITION_REQUIRED");
    const condition = request.action === "coexist" ? clean(request.condition) : null;
    const provenance = { type: "ADMIN", actorUserId: id(request.actorUserId), subjectUserId: c.subjectUserId, conversationId: conv,
      at: now, caseId, action: request.action, sourceMessageId: id(request.sourceMessageId), ...(sourceSentAt ? { sourceSentAt } : {}) };
    function priorCorrection(entry) {
      if (!entry || !Object.keys(entry).some(key => /^(corrected|correction|postCorrection)/.test(key))) return null;
      // Snapshot the FULL correction payload, including future correction
      // fields, alongside its original evidence. Never recursively copy the
      // history array or the whole entry into each subsequent snapshot.
      const evidence = new Set(["status", "confidence", "source", "sourceMessageIds", "sourceMessageTimes", "sourceUserIds",
        "sourceConversationId", "evidenceKeys", "evidenceConfirmations", "firstSeenAt", "lastConfirmedAt",
        "explicitAt", "selfExplicitAt", "explicitEvidenceKeys", "supersededAt", "supersedes"]);
      return structuredClone({ at: entry.correctedAt || null, action: entry.correctionAction || null,
        actorUserId: entry.correctedBy || null, ...Object.fromEntries(Object.entries(entry)
          .filter(([key]) => /^(corrected|correction|postCorrection)/.test(key) || evidence.has(key))) });
    }
    function archiveCorrection(entry, prior) {
      if (!prior) return;
      if (!entry.verificationPreviousCorrections) entry.verificationPreviousCorrections = [];
      entry.verificationPreviousCorrections.push(prior);
    }
    function correct(e, action) {
      if (!e) return;
      archiveCorrection(e, priorCorrection(e));
      e.status = action === "reject" ? "rejected" : action === "tentative" ? "tentative" : "superseded";
      e.correctedAt = now; e.correctionAction = action; e.correctedBy = provenance.actorUserId;
      e.correctionVerificationCaseId = caseId;
      if (action === "tentative") {
        e.postCorrectionEvidenceKeys = []; e.postCorrectionConfidence = 0;
        e.correctionReason = "旧记忆无效不代表新记忆获确认；仅后续独立证据可重新确认";
        e.correctionSourceMessageIds = request.sourceMessageId === undefined ? [] : [id(request.sourceMessageId)];
        e.correctionConversationId = conv;
        e.correctionProvenance = provenance;
      }
      if (!e.verificationDecisions) e.verificationDecisions = [];
      e.verificationDecisions.push(provenance);
    }
    function adminVersion(side, condition = null) {
      const original = side === "old" ? old : newer;
      const fallback = side === "old" ? c.oldMemory : c.newMemory;
      const candidateEvidence = side === "new" ? c.candidateEvidence || fallback.evidence : fallback.evidence;
      const versionId = `memadmin_${hash([caseId, request.expectedRevision, side]).slice(0, 24)}`;
      if (h.holder.canonicalMemory.entries.some(e => e.id === versionId)) throw new Error("VERSION_CONFLICT");
      const originalIds = uniqueIds([...(original?.sourceMessageIds || []), ...candidateEvidence.sourceMessageIds]);
      const originalKeys = uniqueIds([...(original?.evidenceKeys || []), ...candidateEvidence.sourceMessageIds.map(x => JSON.stringify([conv, x]))]);
      const correctionGated = original?.correctionAction === "tentative" && !!original.correctedAt;
      const version = { ...(original ? structuredClone(original) : {}), id: versionId, kind: fallback.kind,
        value: clean(original?.value || fallback.value), subjectUserId: c.subjectUserId,
        status: correctionGated ? "tentative" : "active", confidence: correctionGated ? original.confidence : 1, source: "admin-verification",
        sourceMessageIds: originalIds, sourceMessageTimes: { ...candidateEvidence.sourceMessageTimes, ...(original?.sourceMessageTimes || {}) },
        sourceUserIds: uniqueIds([...(original?.sourceUserIds || []), ...candidateEvidence.sourceUserIds]), sourceConversationId: conv,
        firstSeenAt: original?.firstSeenAt || fallback.firstSeenAt, lastConfirmedAt: original?.lastConfirmedAt || fallback.lastConfirmedAt,
        evidenceKeys: originalKeys, evidenceConfirmations: originalKeys.length,
        supersedes: request.action === "update" ? old.id : original?.id || fallback.id, versionOf: original?.id || fallback.id,
        verificationReplaces: [original?.id || fallback.id], verificationResolutionCaseId: caseId,
        // Holds bind the original case targets, not this newly endorsed version.
        // Sibling cases retain those targets/holds and become stale when this
        // decision supersedes OLD. They cannot silently veto or overwrite the
        // new version and are not auto-resolved or rebound to it.
        verificationHoldCaseIds: [],
        adminProvenance: [...(original?.adminProvenance || []), provenance],
        verificationDecisions: [...(original?.verificationDecisions || []), provenance] };
      archiveCorrection(version, priorCorrection(original));
      // The administrator is not another self-statement or post-correction
      // evidence. Preserve a human tentative gate, but do not inherit explicit
      // flags that could accidentally defeat it. Terminal originals are refused
      // above, and are never reactivated in place.
      for (const key of ["explicitAt", "selfExplicitAt", "supersededAt", "correctionVerificationCaseId"]) delete version[key];
      if (!correctionGated) for (const key of Object.keys(version)) {
        if (/^(corrected|correction|postCorrection)/.test(key)) delete version[key];
      }
      const inheritedCondition = original?.condition ?? original?.temporal?.condition ?? original?.metadata?.condition;
      if (inheritedCondition !== undefined && inheritedCondition !== null && inheritedCondition !== ""
        && (typeof inheritedCondition !== "string" || !inheritedCondition.trim())) throw new Error("INVALID_EXISTING_CONDITION");
      if (condition) version.condition = inheritedCondition
        ? `（原条件：${clean(inheritedCondition)}）且（核实条件：${condition}）` : condition;
      else if (inheritedCondition) version.condition = clean(inheritedCondition);
      if (!original) {
        // Bind the prospective canonical ID too. Otherwise a later extraction
        // of the case-only value could create an unconditioned active duplicate
        // and silently bypass the administrator's conditional version.
        h.holder.canonicalMemory.entries.push({ id: fallback.id, kind: fallback.kind, value: fallback.value,
          subjectUserId: c.subjectUserId, status: "superseded", confidence: 0, source: "ai-verification-hint",
          sourceMessageIds: [...candidateEvidence.sourceMessageIds], sourceMessageTimes: { ...candidateEvidence.sourceMessageTimes },
          sourceUserIds: [...candidateEvidence.sourceUserIds], sourceConversationId: conv,
          evidenceKeys: originalKeys, evidenceConfirmations: originalKeys.length,
          firstSeenAt: fallback.firstSeenAt, lastConfirmedAt: fallback.lastConfirmedAt,
          correctedAt: now, correctionAction: "supersede", correctedBy: provenance.actorUserId,
          correctionVerificationCaseId: caseId, verificationDecisions: [provenance] });
      }
      h.holder.canonicalMemory.entries.push(version);
      if (!c.resolvedMemoryIds) c.resolvedMemoryIds = [];
      c.resolvedMemoryIds.push(versionId); c.resolvedMemoryId = versionId;
      return version;
    }
    if (request.action === "unsure") {
      c.status = "deferred"; c.deferredAt = now;
      // No timer/auto-accept; even a deferred case retains live safety holds.
    } else {
      if (request.action === "update") {
        adminVersion("new");
        correct(old, "supersede"); correct(newer, "supersede");
      } else if (request.action === "new_invalid") {
        // A valid OLD value gets a fresh administrator-backed version, even if
        // the original was disputed. Do not revive or erase the old evidence.
        adminVersion("old"); correct(old, "supersede");
        correct(newer, "reject");
        // A case-only candidate receives its own tombstone, not just an audit
        // label; later extraction cannot silently turn that value into fact.
        if (!newer) {
          h.holder.canonicalMemory.entries.push({ id: canonicalId(c.subjectUserId, c.newMemory.kind, c.newMemory.value), kind: c.newMemory.kind,
            value: c.newMemory.value, subjectUserId: c.subjectUserId, status: "rejected", confidence: 0,
            sourceMessageIds: [...c.newMemory.sourceMessageIds], sourceConversationId: conv,
            sourceMessageTimes: { ...c.newMemory.evidence.sourceMessageTimes },
            evidenceKeys: c.newMemory.sourceMessageIds.map(x => JSON.stringify([conv, x])),
            correctedAt: now, correctionAction: "reject", correctedBy: provenance.actorUserId, verificationDecisions: [provenance] });
        }
      } else if (request.action === "old_invalid") {
        correct(old, "reject");
        let unverified = newer;
        if (!unverified) {
          // A case-only claim also needs a correction epoch: otherwise replaying
          // its pre-decision source batch could create a newly active canonical
          // entry with no post-decision evidence at all.
          const evidence = c.candidateEvidence || c.newMemory.evidence;
          unverified = { id: c.newMemory.id, kind: c.newMemory.kind, value: c.newMemory.value,
            subjectUserId: c.subjectUserId, status: "tentative", confidence: 0, source: "ai-verification-hint",
            sourceConversationId: conv, sourceMessageIds: [...evidence.sourceMessageIds],
            sourceMessageTimes: { ...evidence.sourceMessageTimes }, sourceUserIds: [...evidence.sourceUserIds],
            evidenceKeys: evidence.sourceMessageIds.map(id => JSON.stringify([conv, id])), evidenceConfirmations: evidence.sourceMessageIds.length,
            firstSeenAt: c.newMemory.firstSeenAt, lastConfirmedAt: c.newMemory.lastConfirmedAt, verificationHoldCaseIds: [] };
          h.holder.canonicalMemory.entries.push(unverified);
        }
        correct(unverified, "tentative");
      }
      else {
        c.condition = condition;
        adminVersion("old", condition); adminVersion("new", condition);
        correct(old, "supersede"); correct(newer, "supersede");
      }
      removeHold(old, caseId);
      // OLD-invalid leaves NEW behind a recoverable, evidence-bound tentative
      // epoch, not a permanent hold owned by an already resolved case.
      removeHold(newer, caseId);
      c.status = "resolved"; c.resolvedAt = now; c.resolvedAction = request.action;
    }
    c.updatedAt = now;
    audit(c, { type: "admin_decision", ...provenance, ...(condition ? { condition } : {}) });
    refresh(c, locate(draft, c));
    const safeCase = preview(c, draft, privacy, now);
    publish(group, draft);
    return { ok: true, code: request.action === "unsure" ? "DEFERRED" : "RESOLVED", case: safeCase };
  } catch { return fail("INVALID_MEMORY_STATE"); }
}

/** Explicit human re-review of a stale snapshot, NOT a resolution or automatic
 * rebase. Parent must authenticate/authorize the actor and submit the revision
 * from the CURRENT preview after showing the changed evidence. Fact/status/
 * confidence and correction gates stay unchanged. A live case may recompute
 * only its OWN hold IDs against the reviewed evidence; sibling holds and cases
 * are never moved, removed or rebound. Terminal corrections and changed mappings,
 * subjects, values or evidence scopes cannot be blessed by this operation.
 * now is processing/transaction time; optional sourceSentAt is separately
 * validated original command time, never a subject observation or CAS clock.
 */
export function reviewVerificationCase(memory, request) {
  const fail = code => ({ ok: false, code });
  if (!record(request)) return fail("INVALID_REQUEST");
  request = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
  if (!data(request)) return fail("INVALID_REQUEST");
  if (request.authorized !== true || !id(request.actorUserId)) return fail("UNAUTHORIZED");
  const conv = id(request.conversationId), caseId = id(request.caseId), now = time(request.now);
  const sourceSentAt = request.sourceSentAt === undefined ? null : time(request.sourceSentAt);
  if (!conv || !caseId || !now || !id(request.expectedRevision)
    || (request.sourceMessageId !== undefined && !id(request.sourceMessageId))
    || (request.sourceSentAt !== undefined && !sourceSentAt)) return fail("INVALID_REQUEST");
  const group = scopedGroups(memory, conv)[0]?.[1];
  if (!group) return fail("NOT_FOUND");
  try {
    const draft = relevant(group), matches = draft.memoryVerification?.cases.filter(c => c.id === caseId && c.conversationId === conv) || [];
    if (matches.length !== 1) return fail("NOT_FOUND");
    const c = matches[0];
    if (c.status === "resolved") return fail("CONFLICT");
    if (!["pending", "deferred"].includes(c.status)) return fail("INVALID_MEMORY_STATE");
    if (!record(c.snapshot) || ["oldDigest", "newDigest", "targetsDigest"].some(key => typeof c.snapshot[key] !== "string"
      || !/^[a-f0-9]{64}$/.test(c.snapshot[key]))) return fail("INVALID_MEMORY_STATE");
    const target = locate(draft, c), snap = snapshot(target);
    if (request.expectedRevision !== revision(c, snap?.targetsDigest || null)) return fail("STALE_REVISION");
    if (!target) return fail("TARGET_MAPPING_CHANGED");
    if (terminal(target.old) || (target.newer && terminal(target.newer))) return fail("TERMINAL_CORRECTION");
    if (!time(c.createdAt) || !time(c.updatedAt) || now < c.createdAt || now < c.updatedAt) return fail("STALE_TIME");
    const oldIdentity = c.oldTargetIdentity || targetIdentity(c.oldMemory);
    const newIdentity = c.newTargetIdentity || targetIdentity(c.newMemory);
    if (targetIdentity(target.old) !== oldIdentity || (target.newer && targetIdentity(target.newer) !== newIdentity)
      || (!target.newer && c.snapshot?.newDigest !== hash(null))) return fail("TARGET_MAPPING_CHANGED");

    function scopedEvidence(evidence, allowLegacy = false) {
      if (!record(evidence)) return false;
      const source = evidence.sourceConversationId;
      if (source !== undefined && source !== null && source !== "" && source !== conv && !(allowLegacy && source === "legacy")) return false;
      for (const field of ["sourceMessageIds", "sourceUserIds", "verificationHoldCaseIds"]) {
        if (evidence[field] !== undefined && (!Array.isArray(evidence[field]) || evidence[field].some(v => !id(v)))) return false;
      }
      const senders = [...(evidence.sourceUserIds || [])];
      for (const field of ["sourceUserId", "senderUserId"]) {
        if (evidence[field] !== undefined && !id(evidence[field])) return false;
        if (evidence[field] !== undefined) senders.push(id(evidence[field]));
      }
      if (senders.some(sender => target.h.scope === "user" ? id(sender) !== c.subjectUserId : String(sender).startsWith("conversation:"))) return false;
      if (evidence.evidenceKeys !== undefined) {
        if (!Array.isArray(evidence.evidenceKeys)) return false;
        for (const key of evidence.evidenceKeys) {
          if (typeof key !== "string") return false;
          try {
            const tuple = JSON.parse(key);
            if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== conv || !id(tuple[1])) return false;
          } catch { return false; }
        }
      }
      if (evidence.sourceMessageTimes !== undefined) {
        if (!record(evidence.sourceMessageTimes)) return false;
        if (Object.entries(evidence.sourceMessageTimes).some(([key, value]) => !id(key) || !time(value) || time(value) > now)) return false;
      }
      for (const field of ["firstSeenAt", "lastConfirmedAt"]) {
        if (evidence[field] !== undefined && evidence[field] !== null && evidence[field] !== ""
          && (!time(evidence[field]) || time(evidence[field]) > now)) return false;
      }
      return true;
    }
    if (!scopedEvidence(target.old, target.old.source === "legacy-canonical")
      || (target.newer && !scopedEvidence(target.newer, target.newer.source === "legacy-canonical"))
      || !scopedEvidence(c.candidateEvidence || c.newMemory.evidence,
        c.origin === "canonical" && c.newMemory.source === "legacy-canonical")) return fail("EVIDENCE_SCOPE_MISMATCH");
    const beforeHolds = { old: uniqueIds(target.old.verificationHoldCaseIds), new: uniqueIds(target.newer?.verificationHoldCaseIds) };
    const previousHoldRequired = c.holdRequired;
    if (c.shadowMode === false) {
      c.holdRequired = c.origin === "semantic_hint" ? supportedNew(target.newer, conv)
        : !!target.newer && ((strong(target.old) && strong(target.newer))
          || (target.old.status === "disputed" && target.newer.status === "disputed"));
      if (c.holdRequired) addHold(target.old, caseId);
      else removeHold(target.old, caseId);
      addHold(target.newer, caseId);
    }
    const afterHolds = { old: uniqueIds(target.old.verificationHoldCaseIds), new: uniqueIds(target.newer?.verificationHoldCaseIds) };
    const holdsChanged = stable(beforeHolds) !== stable(afterHolds);
    if (c.snapshot?.targetsDigest === snap.targetsDigest && !holdsChanged && c.holdRequired === previousHoldRequired) {
      return { ok: true, code: "UNCHANGED", case: preview(c, draft, privacy, now) };
    }
    audit(c, { type: "human_review", provenance: "ADMIN", actorUserId: id(request.actorUserId), at: now,
      ...(request.sourceMessageId === undefined ? {} : { sourceMessageId: id(request.sourceMessageId) }),
      ...(sourceSentAt ? { sourceSentAt } : {}), reviewedRevision: request.expectedRevision,
      previousRevision: c.revision, previousSnapshot: structuredClone(c.snapshot),
      ...(holdsChanged ? { reviewedHolds: { before: beforeHolds, after: afterHolds } } : {}) });
    c.updatedAt = now;
    // Preserve already-redacted values. The digest binds the current targets;
    // their facts and evidence themselves remain unmodified in the canonical
    // store; only this explicitly reviewed case's hold IDs may have changed.
    c.oldTargetIdentity = oldIdentity; c.newTargetIdentity = newIdentity;
    refresh(c, target);
    const safeCase = preview(c, draft, privacy, now);
    publish(group, draft);
    return { ok: true, code: "REVIEWED", case: safeCase };
  } catch { return fail("INVALID_MEMORY_STATE"); }
}
