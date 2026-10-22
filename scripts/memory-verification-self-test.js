import assert from "node:assert/strict";
import { applyVerificationHints, collectVerificationCases, isVerificationAdmin, listVerificationCases,
  memoryVerificationConfig, resolveVerificationCase, reviewVerificationCase } from "../src/memory-verification.js";
import { applyCanonicalCorrections, canonicalActiveEntries, canonicalPromptLines, ensureCanonicalMemory,
  legacyMemoryFallbackAllowed, legacyMemoryValues, mergeCanonicalEvidence } from "../src/memory-integrity.js";
import { applyMemoryExtraction, groupMemoryValues } from "../src/memory-application.js";
import { memoryValidity } from "../src/memory-learning.js";

// Fake data only. No files, live state, networks, notifications or hidden clock.
const CONV = "group:testing", USER = "10001", ADMIN = "90001";
const T0 = "2026-01-01T00:00:00.000Z", T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z", T3 = "2026-01-04T00:00:00.000Z";
let passed = 0;
const failures = [];
function test(name, run) {
  try { run(); passed++; } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); }
}
function options(extra = {}) { return { now: T2, config: { memoryVerification: { shadowMode: false } }, ...extra }; }
function userFixture(value = "喜欢黑咖啡", kind = "preference", subject = USER) {
  const user = { preferences: [value], profile: ["历史简介"], names: ["测试成员"], aliases: ["旧称呼"], extra: { untouched: true } };
  ensureCanonicalMemory(user, subject, { at: T0 });
  // Find the imported entry, then confirm it without relying on writer clocks.
  const target = user.canonicalMemory.entries.find(e => e.value === value);
  target.kind = kind; target.confidence = 0.9;
  return user;
}
function fixture() { return { groups: { [CONV]: { users: { [USER]: userFixture() }, facts: ["旧群事实"], topics: ["旧话题"], unrelated: { keep: true } } } }; }
function group(memory) { return memory.groups[CONV]; }
function old(memory) { return group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢黑咖啡"); }
function row(extra = {}) { return { conversation_id: CONV, user_id: USER, message_id: "new-source", sent_at: T1, text: "我现在更喜欢红茶", ...extra }; }
function hint(memory, extra = {}) { return { subjectUserId: USER, memoryId: old(memory).id, newValue: "喜欢红茶", sourceMessageIds: ["new-source"], relation: "change", ...extra }; }
function apply(memory, extra = {}, opts = options(), rows = [row()]) {
  return applyVerificationHints(group(memory), CONV, [hint(memory, extra)], rows, opts);
}
function cases(memory, opts = {}) { return listVerificationCases(memory, opts).cases; }
function resolve(memory, action = "update", extra = {}) {
  const c = cases(memory)[0];
  return resolveVerificationCase(memory, { conversationId: CONV, caseId: c.id, expectedRevision: c.revision,
    action, actorUserId: ADMIN, authorized: true, now: T3, sourceMessageId: "admin-event", ...extra });
}
function review(memory, extra = {}) {
  const c = cases(memory)[0];
  return reviewVerificationCase(memory, { conversationId: CONV, caseId: c.id, expectedRevision: c.revision,
    actorUserId: ADMIN, authorized: true, now: T3, ...extra });
}
function extractNew(memory, value = "喜欢红茶", rows = [row()]) {
  return applyMemoryExtraction(group(memory), CONV, { canonical_entries: [{ user_id: USER, kind: "preference", value,
    source_message_ids: rows.map(x => x.message_id), confidence: 0.9 }] }, rows);
}
function seedStrongNew(memory, value = "喜欢红茶") {
  const rows = [row({ message_id: `strong-${value}-1`, sent_at: T0 }), row({ message_id: `strong-${value}-2` })];
  extractNew(memory, value, rows);
  return rows;
}
function applyStrong(memory, value = "喜欢红茶", opts = options()) {
  const rows = seedStrongNew(memory, value);
  return apply(memory, { newValue: value, sourceMessageIds: rows.map(x => x.message_id) }, opts, rows);
}
function paginationFixture() {
  const memory = fixture(), otherConv = "group:later";
  apply(memory);
  const first = group(memory), seed = structuredClone(first.memoryVerification.cases[0]);
  first.memoryVerification.cases = Array.from({ length: 320 }, (_, index) => ({ ...structuredClone(seed),
    id: `page_a_${index}`, status: index < 100 ? "resolved" : "pending", ...(index < 100 ? { resolvedAt: T3 } : {}) }));
  first.memoryVerification.notifications = first.memoryVerification.cases.filter(c => c.status === "pending")
    .map(c => ({ caseId: c.id, status: "sent", at: T2 }));
  const second = fixture().groups[CONV];
  applyVerificationHints(second, otherConv, [hint(memory)], [row({ conversation_id: otherConv })], options());
  const otherSeed = structuredClone(second.memoryVerification.cases[0]);
  second.memoryVerification.cases = Array.from({ length: 120 }, (_, index) => ({ ...structuredClone(otherSeed), id: `page_b_${index}` }));
  memory.groups[otherConv] = second;
  return { memory, otherConv };
}

test("configuration defaults and full config aliases", () => {
  assert.deepEqual(memoryVerificationConfig({}), { enabled: true, shadowMode: true, adminUserIds: [], groupAdminUserIds: {},
    notificationAccountIds: {}, perGroupDailyLimit: 3, cooldownMs: 86400000, deferAfterMs: 604800000 });
  const c = memoryVerificationConfig({ memory: { verification: { shadowMode: false, adminUserIds: [ADMIN, ADMIN],
    perGroupDailyLimit: -1, cooldownMs: NaN } } });
  assert.equal(c.shadowMode, false, "invalid unrelated fields do not discard selected valid settings");
  assert.equal(c.cooldownMs, 86400000);
  assert.equal(memoryVerificationConfig({ memory: { verification: { shadowMode: false } } }).shadowMode, false);
});
test("admins are explicit and conversation scoped, not role derived", () => {
  const c = { memoryVerification: { adminUserIds: [ADMIN], groupAdminUserIds: { [CONV]: [USER] } } };
  assert.equal(isVerificationAdmin(c, ADMIN, CONV), true);
  assert.equal(isVerificationAdmin(c, USER, CONV), true);
  assert.equal(isVerificationAdmin(c, USER, "group:other"), false);
  assert.equal(isVerificationAdmin({ role: "admin" }, USER, CONV), false);
});
test("shadow default records only; legacy arrays and target byte content unchanged", () => {
  const memory = fixture(), before = structuredClone(group(memory));
  const r = apply(memory, {}, { now: T2 });
  assert.equal(r.created.length, 1);
  const { memoryVerification, ...after } = group(memory);
  assert.deepEqual(after, before);
  assert.equal(memoryVerification.cases[0].shadowMode, true);
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
});
test("single-source hint is candidate only and preserves reliable old memory", () => {
  const memory = fixture(), n = group(memory).users[USER].canonicalMemory.entries.length;
  const r = apply(memory);
  assert.equal(r.created.length, 1);
  assert.equal(group(memory).users[USER].canonicalMemory.entries.length, n);
  assert.equal(old(memory).status, "active");
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
  assert.equal(canonicalPromptLines(group(memory).users[USER]).some(x => x.includes("黑咖啡")), true);
  assert.deepEqual(legacyMemoryValues(group(memory).users[USER], "preferences"), ["喜欢黑咖啡"]);
  assert.equal(legacyMemoryFallbackAllowed(group(memory).users[USER]), true);
});
test("supported strong canonical NEW evidence may hold reliable OLD", () => {
  const memory = fixture(), r = applyStrong(memory);
  assert.ok(old(memory).verificationHoldCaseIds.includes(r.created[0].id));
  assert.equal(canonicalPromptLines(group(memory).users[USER]).some(x => x.includes("黑咖啡")), false);
  assert.deepEqual(legacyMemoryValues(group(memory).users[USER], "preferences"), []);
});
test("multiple raw hints without canonical confidence remain candidates", () => {
  const memory = fixture(), rows = [row(), row({ message_id: "second" })];
  apply(memory, { sourceMessageIds: ["new-source", "second"] }, options(), rows);
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
  assert.equal(cases(memory)[0].newMemory.confidence, 0);
});
test("weak single canonical source never holds OLD, even if NEW was active", () => {
  const memory = fixture(); extractNew(memory);
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  newer.status = "active"; newer.selfExplicitAt = T1;
  apply(memory);
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
  assert.ok(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === old(memory).id));
  assert.equal(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === newer.id), false);
});
test("migration of a weak historical hold removes only that case hold", () => {
  const memory = fixture(); apply(memory);
  const c = group(memory).memoryVerification.cases[0];
  old(memory).verificationHoldCaseIds = [c.id, "unrelated"];
  collectVerificationCases(group(memory), CONV, options());
  assert.deepEqual(old(memory).verificationHoldCaseIds, ["unrelated"]);
  assert.equal(old(memory).status, "active");
});
test("candidate arriving after hint receives hold through collect", () => {
  const memory = fixture(); apply(memory);
  assert.equal(extractNew(memory).accepted.length, 1);
  const r = collectVerificationCases(group(memory), CONV, options());
  assert.equal(r.created.length, 0); assert.equal(r.updated.length, 1);
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  assert.ok(newer.verificationHoldCaseIds.includes(cases(memory)[0].id));
  assert.equal(cases(memory)[0].stale, false);
  assert.equal(cases(memory)[0].newMemory.id, newer.id);
});
test("weak polarity extraction after hint cannot suspend unchanged reliable active OLD", () => {
  const memory = fixture(); apply(memory, { newValue: "不喜欢黑咖啡", relation: "contradiction" });
  extractNew(memory, "不喜欢黑咖啡");
  collectVerificationCases(group(memory), CONV, options());
  const u = group(memory).users[USER], newer = u.canonicalMemory.entries.find(e => e.value === "不喜欢黑咖啡");
  assert.equal(old(memory).status, "active"); assert.deepEqual(old(memory).verificationHoldCaseIds || [], []);
  assert.equal(newer.status, "tentative");
  assert.deepEqual(legacyMemoryValues(u, "preferences"), ["喜欢黑咖啡"]);
  assert.equal(cases(memory)[0].stale, false);
});
test("duplicate ordinary strong contradictory value receives both holds after canonical arrival", () => {
  const memory = fixture(), rows = [row({ message_id: "s1", sent_at: T0 }), row({ message_id: "s2" })];
  apply(memory, { newValue: "不喜欢黑咖啡", relation: "contradiction", sourceMessageIds: ["s1", "s2"] }, options(), rows);
  assert.equal(old(memory).verificationHoldCaseIds, undefined, "raw hints alone are not canonical truth");
  extractNew(memory, "不喜欢黑咖啡", rows);
  collectVerificationCases(group(memory), CONV, options());
  const c = cases(memory)[0], newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "不喜欢黑咖啡");
  assert.ok(old(memory).verificationHoldCaseIds.includes(c.id)); assert.ok(newer.verificationHoldCaseIds.includes(c.id));
  assert.equal(old(memory).status, "disputed"); assert.equal(newer.status, "disputed"); assert.equal(c.stale, false);
});
test("replaying hints or collect changes no revision, audit or reminder", () => {
  const memory = fixture(); apply(memory);
  const before = structuredClone(memory), rev = cases(memory)[0].revision;
  assert.equal(apply(memory, {}, options({ now: T3 })).created.length, 0);
  assert.equal(collectVerificationCases(group(memory), CONV, options({ now: T3 })).updated.length, 0);
  assert.deepEqual(memory, before); assert.equal(cases(memory)[0].revision, rev);
});
test("reprocessing a source at another processing time does not change original time", () => {
  const memory = fixture(); apply(memory);
  assert.equal(cases(memory)[0].newMemory.firstSeenAt, T1);
  apply(memory, {}, options({ now: T3 }), [row({ sent_at: T2 })]);
  assert.equal(cases(memory)[0].newMemory.firstSeenAt, T1);
});
test("fresh attributed hints retain all sources and revalidate same-value stale case", () => {
  const memory = fixture(); apply(memory);
  const id = cases(memory)[0].id;
  old(memory).confidence = 0.75;
  assert.equal(cases(memory)[0].stale, true);
  const r = apply(memory, { sourceMessageIds: ["another-source"] }, options(), [row({ message_id: "another-source", sent_at: T2 })]);
  assert.equal(r.created.length, 0); assert.equal(r.updated.length, 1);
  assert.equal(cases(memory)[0].id, id); assert.equal(cases(memory)[0].stale, false);
  assert.deepEqual(cases(memory)[0].newMemory.sourceMessageIds, ["another-source", "new-source"]);
  assert.equal(resolve(memory).ok, true);
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.source === "admin-verification");
  assert.deepEqual(version.sourceMessageIds, ["another-source", "new-source"]);
  assert.equal(version.sourceMessageTimes["new-source"], T1);
});
test("same shared physical group across accounts de-duplicates", () => {
  const memory = fixture(); apply(memory);
  apply(memory, {}, options({ accountId: "independent-account" }));
  assert.equal(cases(memory).length, 1);
});
test("missing source and foreign sender reject without state mutation", () => {
  for (const rows of [[], [row({ user_id: "10002" })], [row({ conversation_id: "group:other" })]]) {
    const memory = fixture(), before = structuredClone(memory);
    assert.equal(apply(memory, {}, options(), rows).rejected.length, 1);
    assert.deepEqual(memory, before);
  }
});
test("bot/self/tool/quotes/forwards excluded by evidence batch", () => {
  for (const metadata of [{ isBot: true }, { isSelf: true }, { role: "assistant" }, { source: "tool" },
    { quotedText: "他说喜欢红茶" }, { text: '> 喜欢红茶' }, { message: [{ type: "reply", data: { id: "q1" } }] }]) {
    const memory = fixture(), before = structuredClone(memory);
    assert.equal(apply(memory, {}, options(), [row(metadata)]).created.length, 0);
    assert.deepEqual(memory, before);
  }
  const memory = fixture();
  assert.equal(apply(memory, {}, options({ botUserIds: [USER] })).created.length, 0);
});
test("ambiguous duplicate source ID fails closed", () => {
  const memory = fixture(), before = structuredClone(memory);
  assert.equal(apply(memory, {}, options(), [row(), row({ sent_at: T0 })]).created.length, 0);
  assert.deepEqual(memory, before);
});
test("future sources and malformed calendar dates rejected", () => {
  const memory = fixture(), before = structuredClone(memory);
  assert.equal(apply(memory, {}, options(), [row({ sent_at: T3 })]).created.length, 0);
  for (const now of [undefined, "2026-02-30T00:00:00Z", "tomorrow", "2026-01-02", "2026-01-02T24:00:00Z"]) {
    assert.equal(apply(memory, {}, options({ now })).created.length, 0);
  }
  assert.deepEqual(memory, before);
});
test("prototype, getters, polluted arrays, unsafe IDs rejected", () => {
  const memory = fixture(), before = structuredClone(memory);
  for (const hints of [JSON.parse('[{"__proto__": {"pwn": true}}]'), [Object.create({ subjectUserId: USER })],
    [{ ...hint(memory), memoryId: "constructor" }], [{ ...hint(memory), subjectUserId: "bad id" }]]) {
    assert.equal(applyVerificationHints(group(memory), CONV, hints, [row()], options()).created.length, 0);
  }
  let invoked = false;
  const payload = {};
  Object.defineProperty(payload, "subjectUserId", { get() { invoked = true; return USER; }, enumerable: true });
  applyVerificationHints(group(memory), CONV, [payload], [row()], options());
  assert.equal(invoked, false);
  const config = { memory: {} };
  Object.defineProperty(config.memory, "verification", { get() { invoked = true; return {}; }, enumerable: true });
  memoryVerificationConfig(config);
  assert.equal(invoked, false);
  const hints = [hint(memory)]; hints.extra = "bad";
  applyVerificationHints(group(memory), CONV, hints, [row()], options());
  assert.deepEqual(memory, before); assert.equal({}.pwn, undefined);
});
test("privacy covers all stored candidate values and listing redacts again", () => {
  const memory = fixture();
  apply(memory, { newValue: "电话13812345678 密码:supersecret 地址:测试路99号" }, options({ redact: s => s.replace("电话", "联系") }));
  const encoded = JSON.stringify(group(memory).memoryVerification);
  for (const secret of ["13812345678", "supersecret", "测试路99号"]) assert.equal(encoded.includes(secret), false);
  const preview = JSON.stringify(listVerificationCases(memory, { redact: s => s.replace("联系", "方式") }));
  assert.ok(preview.includes("方式")); assert.equal(preview.includes("联系"), false);
});
test("redaction failure is atomic and does not create empty store", () => {
  const memory = fixture(), before = structuredClone(memory);
  const r = apply(memory, {}, options({ redact: () => { throw new Error("private"); } }));
  assert.equal(r.created.length, 0);
  assert.equal(JSON.stringify(r).includes("private"), false);
  assert.deepEqual(memory, before);
});
test("exact strong conflicts keep disputed statuses and create one case", () => {
  const memory = fixture();
  const u = group(memory).users[USER];
  for (const [messageId, sentAt] of [["negative1", T0], ["negative2", T1]]) mergeCanonicalEvidence(u,
    { preferences: ["不喜欢黑咖啡"], confidence: 0.9 }, { subjectUserId: USER, conversationId: CONV,
      sourceUserId: USER, sourceMessageIds: [messageId], sentAt });
  const r = collectVerificationCases(group(memory), CONV, options());
  assert.equal(r.created.length, 1);
  const members = u.canonicalMemory.entries.filter(e => e.kind === "preference");
  assert.ok(members.every(e => e.status === "disputed" && e.verificationHoldCaseIds.length === 1));
});
test("credible old vs flimsy exact new is candidate, not automatic disputed", () => {
  const memory = fixture(), u = group(memory).users[USER];
  const newer = { ...structuredClone(old(memory)), id: "flimsy", value: "不喜欢黑咖啡", confidence: 0.1,
    status: "tentative", source: "ai-extraction", sourceMessageIds: ["one"], evidenceKeys: [JSON.stringify([CONV, "one"])] };
  u.canonicalMemory.entries.push(newer);
  const r = collectVerificationCases(group(memory), CONV, options());
  assert.equal(r.created.length, 1); assert.equal(r.created[0].candidate, true);
  assert.equal(old(memory).status, "active"); assert.equal(old(memory).verificationHoldCaseIds, undefined);
});
test("semantic hint and exact scan share a case even when timestamp order differs", () => {
  const memory = fixture(); apply(memory, { newValue: "不喜欢黑咖啡", relation: "contradiction" });
  extractNew(memory, "不喜欢黑咖啡");
  collectVerificationCases(group(memory), CONV, options());
  assert.equal(cases(memory).length, 1);
  assert.equal(cases(memory)[0].stale, false);
  assert.equal(cases(memory)[0].notificationReady, true);
  assert.equal(resolve(memory).ok, true);
});
test("parent optional fields are omissions, not invalid JSON payloads", () => {
  const memory = fixture(); apply(memory);
  assert.equal(resolve(memory, "update", { condition: undefined, sourceMessageId: undefined }).ok, true);
});
test("decision processing milliseconds and original command floor-second time remain separate", () => {
  const memory = fixture(), createdAt = "2026-01-03T00:00:00.250Z", processedAt = "2026-01-03T00:00:00.850Z";
  const sentAt = "2026-01-03T00:00:00Z";
  apply(memory, {}, options({ now: createdAt }));
  const original = structuredClone(old(memory)), newEvidence = structuredClone(cases(memory)[0].newMemory.evidence);
  const r = resolve(memory, "update", { now: processedAt, sourceSentAt: sentAt });
  assert.equal(r.ok, true);
  const c = group(memory).memoryVerification.cases[0], decision = c.audit.at(-1);
  assert.equal(decision.at, processedAt); assert.equal(decision.sourceSentAt, "2026-01-03T00:00:00.000Z");
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.id === r.case.resolvedMemoryId);
  assert.equal(version.adminProvenance.at(-1).at, processedAt);
  assert.equal(version.adminProvenance.at(-1).sourceSentAt, "2026-01-03T00:00:00.000Z");
  assert.equal(version.firstSeenAt, T1); assert.equal(version.lastConfirmedAt, T1);
  assert.deepEqual(version.sourceMessageTimes, newEvidence.sourceMessageTimes);
  assert.equal(old(memory).firstSeenAt, original.firstSeenAt); assert.equal(old(memory).lastConfirmedAt, original.lastConfirmedAt);
  assert.equal(version.sourceMessageIds.includes("admin-event"), false);
});
test("optional sourceSentAt remains backward compatible and invalid dates reject atomically", () => {
  for (const sourceSentAt of [null, "", 123, "2026-02-30T00:00:00Z", "yesterday", "2026-01-01", "2026-01-03T00:00:60Z"]) {
    const memory = fixture(); apply(memory); const before = structuredClone(memory);
    assert.equal(resolve(memory, "update", { sourceSentAt }).code, "INVALID_REQUEST");
    assert.deepEqual(memory, before);
  }
  const memory = fixture(); apply(memory);
  const r = resolve(memory, "update", { sourceSentAt: undefined }); assert.equal(r.ok, true);
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.id === r.case.resolvedMemoryId);
  assert.equal(Object.hasOwn(version.adminProvenance.at(-1), "sourceSentAt"), false);
});
test("shadow-to-live stages only matching snapshots and never mass-mutates old arrays", () => {
  const memory = fixture(); applyStrong(memory, "喜欢红茶", { now: T2 });
  const raw = structuredClone(group(memory).users[USER].preferences);
  const r = collectVerificationCases(group(memory), CONV, options({ now: T3 }));
  assert.equal(r.updated.length, 1); assert.equal(cases(memory)[0].shadowMode, false);
  assert.equal(old(memory).verificationHoldCaseIds.length, 1);
  assert.deepEqual(group(memory).users[USER].preferences, raw);
  assert.equal(collectVerificationCases(group(memory), CONV, options({ now: T3 })).updated.length, 0);
});
test("stale shadow target cannot gain holds on live transition", () => {
  const memory = fixture(); apply(memory, {}, { now: T2 });
  old(memory).confidence = 0.7;
  const before = structuredClone(memory);
  collectVerificationCases(group(memory), CONV, options({ now: T3 }));
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
  assert.equal(cases(memory)[0].stale, true); assert.deepEqual(memory, before);
});
test("group fact and topic wrappers use the same hold read gate", () => {
  for (const [field, slot] of [["facts", "groupFactMemory"], ["topics", "groupTopicMemory"]]) {
    const memory = fixture(), g = group(memory), subject = `conversation:${CONV}:${field}`;
    g[slot] = { conversationId: CONV, ...userFixture("喜欢黑咖啡", "profile", subject) };
    g[slot].profile = ["喜欢黑咖啡"]; g[field] = ["喜欢黑咖啡"];
    const target = g[slot].canonicalMemory.entries.find(e => e.value === "喜欢黑咖啡");
    const r = applyVerificationHints(g, CONV, [{ subjectUserId: subject, memoryId: target.id, newValue: "喜欢红茶",
      sourceMessageIds: ["new-source"], relation: "condition", condition: "讨论饮料时" }], [row()], options());
    assert.equal(r.created.length, 1);
    assert.equal(groupMemoryValues(g, field).includes("喜欢黑咖啡"), true, "weak group hints cannot suspend old facts");
    assert.deepEqual(g[field], ["喜欢黑咖啡"]);
  }
});
test("foreign group wrappers and subject bindings never leak", () => {
  const memory = fixture(), g = group(memory);
  g.groupFactMemory = { conversationId: "group:other", ...userFixture("喜欢黑咖啡", "profile", "conversation:group:other:facts") };
  g.users.foreign = userFixture();
  assert.equal(collectVerificationCases(g, CONV, options()).created.length, 0);
  apply(memory);
  const foreign = structuredClone(g); foreign.memoryVerification.cases[0].conversationId = "group:other";
  memory.groups["group:foreign"] = foreign;
  assert.equal(cases(memory).length, 1);
  assert.equal(cases(memory, { conversationId: "group:foreign" }).length, 0);
});
test("resolve requires caller authorization and is side-effect free on failure", () => {
  const memory = fixture(); apply(memory); const before = structuredClone(memory);
  for (const extra of [{ authorized: false }, { authorized: "true" }, { actorUserId: "__proto__" }, { expectedRevision: "bad" },
    { conversationId: "group:other" }, { caseId: "absent" }, { now: "2026-02-30T00:00:00Z" }, { action: "accept-all" }]) {
    assert.equal(resolve(memory, "update", extra).ok, false); assert.deepEqual(memory, before);
  }
});
test("CAS fingerprints target evidence, values, corrections and hold arrays", () => {
  for (const mutate of [e => { e.confidence = 0.7; }, e => { e.value = "修改后的值"; },
    e => { e.sourceMessageIds = ["changed-evidence"]; }, e => { e.verificationHoldCaseIds = ["another-case"]; },
    e => { e.correctedAt = T1; e.correctionAction = "tentative"; }]) {
    const memory = fixture(); apply(memory); const previous = cases(memory)[0].revision;
    mutate(old(memory)); const before = structuredClone(memory);
    assert.notEqual(cases(memory)[0].revision, previous);
    assert.equal(resolve(memory, "update", { expectedRevision: previous }).code, "STALE_REVISION");
    assert.equal(resolve(memory).code, "STALE_REVISION", "fresh UI revision cannot bless stale snapshot");
    assert.deepEqual(memory, before);
  }
});
test("CAS includes case fingerprint, not only targets", () => {
  const memory = fixture(); apply(memory); const rev = cases(memory)[0].revision;
  group(memory).memoryVerification.cases[0].classification = "condition";
  const before = structuredClone(memory);
  assert.equal(resolve(memory, "update", { expectedRevision: rev }).code, "STALE_REVISION");
  assert.deepEqual(memory, before);
});
test("explicit current-revision human review rebases stale evidence, then separate resolve works", () => {
  const memory = fixture(); applyStrong(memory);
  const cached = cases(memory)[0], oldSnapshot = structuredClone(group(memory).memoryVerification.cases[0].snapshot);
  old(memory).confidence = 0.75;
  const current = cases(memory)[0], beforeReview = structuredClone(memory);
  assert.equal(current.stale, true); assert.notEqual(current.revision, cached.revision);
  assert.equal(review(memory, { expectedRevision: cached.revision }).code, "STALE_REVISION");
  assert.deepEqual(memory, beforeReview);
  assert.equal(resolve(memory, "update", { expectedRevision: current.revision }).code, "STALE_REVISION");
  const r = review(memory, { expectedRevision: current.revision });
  assert.equal(r.ok, true); assert.equal(r.code, "REVIEWED"); assert.equal(r.case.stale, false);
  assert.notEqual(r.case.revision, current.revision);
  assert.equal(r.case.status, "pending"); assert.equal(r.case.resolvedAt, null);
  assert.deepEqual(group(memory).users, beforeReview.groups[CONV].users, "review cannot change facts or holds");
  const audit = group(memory).memoryVerification.cases[0].audit.at(-1);
  assert.equal(audit.type, "human_review"); assert.equal(audit.actorUserId, ADMIN);
  assert.deepEqual(audit.previousSnapshot, oldSnapshot);
  const afterReview = structuredClone(memory);
  assert.equal(resolve(memory, "update", { expectedRevision: current.revision }).code, "STALE_REVISION");
  assert.deepEqual(memory, afterReview);
  assert.equal(resolve(memory, "update", { expectedRevision: r.case.revision }).ok, true);
});
test("explicit review is authorised, bounded, same-second aware and idempotent on unchanged targets", () => {
  const memory = fixture(), createdAt = "2026-01-03T00:00:00.250Z", processedAt = "2026-01-03T00:00:00.850Z";
  apply(memory, {}, options({ now: createdAt })); old(memory).confidence = 0.8;
  const before = structuredClone(memory);
  assert.equal(review(memory, { authorized: false }).code, "UNAUTHORIZED"); assert.deepEqual(memory, before);
  assert.equal(review(memory, { sourceSentAt: "invalid" }).code, "INVALID_REQUEST"); assert.deepEqual(memory, before);
  const r = review(memory, { now: processedAt, sourceSentAt: "2026-01-03T00:00:00Z", sourceMessageId: "review-event" });
  assert.equal(r.code, "REVIEWED");
  const audit = group(memory).memoryVerification.cases[0].audit.at(-1);
  assert.equal(audit.at, processedAt); assert.equal(audit.sourceSentAt, "2026-01-03T00:00:00.000Z");
  const after = structuredClone(memory);
  assert.equal(review(memory, { now: T3, expectedRevision: r.case.revision }).code, "UNCHANGED");
  assert.deepEqual(memory, after);
});
test("review cannot bless changed identity, kind, value, removed target or foreign evidence scope", () => {
  const changes = [
    [m => { old(m).value = "别的记忆"; }, "TARGET_MAPPING_CHANGED"],
    [m => { old(m).kind = "profile"; }, "TARGET_MAPPING_CHANGED"],
    [m => { old(m).subjectUserId = "10002"; }, "TARGET_MAPPING_CHANGED"],
    [m => { old(m).sourceConversationId = "group:foreign"; }, "EVIDENCE_SCOPE_MISMATCH"],
    [m => { old(m).sourceUserIds = ["10002"]; }, "EVIDENCE_SCOPE_MISMATCH"],
    [m => { old(m).evidenceKeys = [JSON.stringify(["group:foreign", "message"])]; }, "EVIDENCE_SCOPE_MISMATCH"],
    [m => { old(m).sourceMessageTimes = { message: "invalid-date" }; }, "EVIDENCE_SCOPE_MISMATCH"],
    [m => { group(m).memoryVerification.cases[0].candidateEvidence.sourceConversationId = "group:foreign"; }, "EVIDENCE_SCOPE_MISMATCH"]
  ];
  for (const [mutate, code] of changes) {
    const memory = fixture(); apply(memory); mutate(memory); const before = structuredClone(memory);
    assert.equal(review(memory).code, code); assert.deepEqual(memory, before);
  }
  const memory = fixture(); apply(memory); extractNew(memory); collectVerificationCases(group(memory), CONV, options());
  const u = group(memory).users[USER]; u.canonicalMemory.entries = u.canonicalMemory.entries.filter(e => e.value !== "喜欢红茶");
  const before = structuredClone(memory);
  assert.equal(review(memory).code, "TARGET_MAPPING_CHANGED"); assert.deepEqual(memory, before);
});
test("human review cannot rebase terminal OLD or silently resolve a sibling", () => {
  const memory = fixture(); applyStrong(memory); applyStrong(memory, "喜欢绿茶");
  const siblingId = cases(memory)[1].id;
  assert.equal(resolve(memory).ok, true);
  const sibling = cases(memory).find(c => c.id === siblingId), before = structuredClone(memory);
  assert.equal(review(memory, { caseId: siblingId, expectedRevision: sibling.revision }).code, "TERMINAL_CORRECTION");
  assert.deepEqual(memory, before);
  assert.equal(cases(memory).find(c => c.id === siblingId).status, "pending");
});
test("explicit review preserves derived deferred status and manual decision remains separate", () => {
  const memory = fixture(); apply(memory); old(memory).confidence = 0.7;
  const now = "2026-02-01T00:00:00.000Z", current = listVerificationCases(memory, { now }).cases[0];
  assert.equal(current.status, "deferred");
  const r = review(memory, { now, expectedRevision: current.revision });
  assert.equal(r.code, "REVIEWED"); assert.equal(r.case.status, "deferred");
  assert.equal(group(memory).memoryVerification.cases[0].status, "pending", "age deferral remains a read projection");
  assert.equal(resolve(memory, "update", { now, expectedRevision: r.case.revision }).ok, true);
});
test("local-admin review recomputes only its live case holds when NEW evidence becomes strong", () => {
  const memory = fixture(); apply(memory); extractNew(memory); collectVerificationCases(group(memory), CONV, options());
  const c = cases(memory)[0], u = group(memory).users[USER];
  assert.deepEqual(old(memory).verificationHoldCaseIds || [], []);
  const newer = u.canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  newer.sourceMessageIds.push("second-independent-source");
  newer.evidenceKeys.push(JSON.stringify([CONV, "second-independent-source"]));
  newer.evidenceConfirmations = 2;
  old(memory).verificationHoldCaseIds = ["sibling-case"];
  const stripHolds = value => {
    const clone = structuredClone(value);
    for (const entry of clone.canonicalMemory.entries) delete entry.verificationHoldCaseIds;
    return clone;
  };
  const before = stripHolds(u), current = cases(memory)[0];
  const r = reviewVerificationCase(memory, { conversationId: CONV, caseId: c.id, expectedRevision: current.revision,
    actorUserId: "local-admin", authorized: true, now: T3 });
  assert.equal(r.code, "REVIEWED"); assert.equal(r.case.stale, false);
  assert.deepEqual(stripHolds(group(memory).users[USER]), before);
  assert.ok(old(memory).verificationHoldCaseIds.includes(c.id));
  assert.ok(old(memory).verificationHoldCaseIds.includes("sibling-case"));
  assert.ok(group(memory).users[USER].canonicalMemory.entries.find(e => e.id === newer.id).verificationHoldCaseIds.includes(c.id));
  assert.equal(group(memory).memoryVerification.cases[0].status, "pending");
  assert.equal(group(memory).memoryVerification.cases[0].audit.at(-1).actorUserId, "local-admin");
  assert.equal(resolve(memory, "update", { expectedRevision: current.revision }).code, "STALE_REVISION");
  assert.equal(resolve(memory, "update", { expectedRevision: r.case.revision }).ok, true);
});
test("explicit review of weak or shadow evidence does not newly suspend OLD", () => {
  for (const shadowMode of [false, true]) {
    const memory = fixture(); apply(memory, {}, options({ config: { memoryVerification: { shadowMode } } }));
    old(memory).confidence = 0.75;
    const beforeStatus = old(memory).status, beforeConfidence = old(memory).confidence;
    const r = review(memory, { actorUserId: "local-admin" });
    assert.equal(r.code, "REVIEWED");
    assert.deepEqual(old(memory).verificationHoldCaseIds || [], []);
    assert.equal(old(memory).status, beforeStatus); assert.equal(old(memory).confidence, beforeConfidence);
  }
});
test("CAS also rejects changed newly attached entry without partial writes", () => {
  const memory = fixture(); apply(memory); extractNew(memory);
  collectVerificationCases(group(memory), CONV, options());
  const previous = cases(memory)[0].revision;
  group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶").confidence = 0.3;
  const before = structuredClone(memory);
  assert.equal(resolve(memory, "update", { expectedRevision: previous }).code, "STALE_REVISION");
  assert.deepEqual(memory, before);
});
test("notification receipts do not invalidate independent target CAS", () => {
  const memory = fixture(); apply(memory); const previous = cases(memory)[0].revision;
  group(memory).memoryVerification.notifications = [{ caseId: cases(memory)[0].id, status: "claimed", at: T2 }];
  assert.equal(cases(memory)[0].revision, previous);
  assert.equal(resolve(memory, "update", { expectedRevision: previous }).ok, true);
  assert.equal(group(memory).memoryVerification.notifications.length, 1);
});
test("update creates separate ADMIN version without subject self-evidence", () => {
  const memory = fixture(); apply(memory); const before = structuredClone(old(memory)), raw = structuredClone(group(memory).users[USER].preferences);
  const r = resolve(memory);
  assert.equal(r.ok, true); assert.equal(r.case.status, "resolved");
  assert.equal(old(memory).status, "superseded"); assert.equal(old(memory).correctionAction, "supersede");
  assert.deepEqual(old(memory).sourceMessageIds, before.sourceMessageIds);
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.id === r.case.resolvedMemoryId);
  assert.equal(version.source, "admin-verification"); assert.equal(version.status, "active");
  assert.equal(version.adminProvenance[0].actorUserId, ADMIN);
  assert.deepEqual(version.sourceMessageIds, ["new-source"]); assert.equal(version.evidenceConfirmations, 1);
  assert.equal(version.sourceMessageIds.includes("admin-event"), false);
  assert.equal(version.selfExplicitAt, undefined); assert.equal(version.explicitAt, undefined);
  assert.equal(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === version.id), true);
  assert.deepEqual(group(memory).users[USER].preferences, raw);
});
test("update retains existing new evidence and history without promoting original entry", () => {
  const memory = fixture(); apply(memory); extractNew(memory);
  collectVerificationCases(group(memory), CONV, options());
  const u = group(memory).users[USER], newer = u.canonicalMemory.entries.find(e => e.value === "喜欢红茶"), sources = structuredClone(newer.sourceMessageIds);
  assert.equal(resolve(memory).ok, true);
  const original = u.canonicalMemory.entries.find(e => e.id === newer.id);
  assert.equal(original.status, "superseded"); assert.deepEqual(original.sourceMessageIds, sources);
  assert.equal(u.canonicalMemory.entries.filter(e => e.value === "喜欢红茶").length, 2);
});
test("resolution is single-use and duplicate requests conflict", () => {
  const memory = fixture(); apply(memory); const c = cases(memory)[0];
  assert.equal(resolve(memory).ok, true); const before = structuredClone(memory);
  assert.equal(resolve(memory, "update", { expectedRevision: c.revision }).code, "CONFLICT");
  assert.deepEqual(memory, before);
});
test("coexist creates conditioned ADMIN versions without reviving original low-confidence entry", () => {
  const memory = fixture(); apply(memory); extractNew(memory);
  collectVerificationCases(group(memory), CONV, options()); const before = structuredClone(memory);
  assert.equal(resolve(memory, "coexist").code, "CONDITION_REQUIRED"); assert.deepEqual(memory, before);
  assert.equal(resolve(memory, "coexist", { condition: "工作时喝咖啡，休息时喝茶" }).ok, true);
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  assert.equal(newer.status, "superseded"); assert.equal(newer.confidence, 0.9);
  assert.equal(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === newer.id), false);
  const fresh = canonicalActiveEntries(group(memory).users[USER]).filter(e => e.source === "admin-verification");
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every(e => e.condition === "工作时喝咖啡，休息时喝茶"));
  assert.ok(fresh.every(e => memoryValidity(e, { now: T3 }).conditional));
  assert.ok(canonicalPromptLines(group(memory).users[USER]).some(x => x.includes("适用条件：工作时喝咖啡，休息时喝茶")));
  assert.ok(legacyMemoryValues(group(memory).users[USER], "preferences").every(x => x.includes("当前是否满足条件未核验")));
});
test("coexist preserves tentative human-correction gates", () => {
  const memory = fixture(), u = group(memory).users[USER];
  applyCanonicalCorrections(u, [{ memoryId: old(memory).id, action: "tentative" }], { subjectUserId: USER, sentAt: T1 });
  apply(memory);
  assert.equal(resolve(memory, "coexist", { condition: "不同情境" }).ok, true);
  const version = u.canonicalMemory.entries.find(e => e.versionOf === old(memory).id);
  assert.equal(old(memory).correctionAction, "supersede");
  assert.equal(version.correctionAction, "tentative"); assert.equal(version.status, "tentative");
  assert.equal(version.postCorrectionEvidenceKeys.length, 0);
  assert.equal(canonicalActiveEntries(u).some(e => e.value === "喜欢黑咖啡"), false);
});
test("case-only coexist creates two conditioned ADMIN versions visible without learning", () => {
  const memory = fixture(); apply(memory);
  const before = structuredClone(group(memory).users[USER].preferences);
  const r = resolve(memory, "coexist", { condition: "咖啡仅工作时，红茶仅休息时" });
  assert.equal(r.ok, true); assert.equal(r.case.resolvedMemoryIds.length, 2);
  const u = group(memory).users[USER], values = legacyMemoryValues(u, "preferences");
  assert.equal(values.length, 2);
  assert.ok(values.some(v => v.startsWith("喜欢红茶") && v.includes("仅休息时")));
  assert.ok(values.every(v => v.includes("当前是否满足条件未核验")));
  assert.ok(canonicalPromptLines(u).some(v => v.includes("喜欢红茶（适用条件：")));
  assert.equal(legacyMemoryFallbackAllowed(u), false);
  assert.deepEqual(u.preferences, before);
  const versions = u.canonicalMemory.entries.filter(e => r.case.resolvedMemoryIds.includes(e.id));
  assert.ok(versions.every(e => !e.sourceMessageIds.includes("admin-event") && !e.selfExplicitAt));
  assert.ok(versions.every(e => memoryValidity(e, { now: T3 }).conditional));
});
test("case-only conditional version cannot gain an unconditional extraction duplicate", () => {
  const memory = fixture(); apply(memory);
  resolve(memory, "coexist", { condition: "仅休息场景" });
  const u = group(memory).users[USER], activeBefore = canonicalActiveEntries(u).filter(e => e.value === "喜欢红茶");
  assert.equal(activeBefore.length, 1); assert.equal(activeBefore[0].condition, "仅休息场景");
  extractNew(memory, "喜欢红茶", [row({ message_id: "later-source", sent_at: T3 })]);
  const activeAfter = canonicalActiveEntries(u).filter(e => e.value === "喜欢红茶");
  assert.equal(activeAfter.length, 1); assert.equal(activeAfter[0].condition, "仅休息场景");
  assert.ok(legacyMemoryValues(u, "preferences").find(v => v.startsWith("喜欢红茶")).includes("仅休息场景"));
});
test("coexist adds to existing applicability conditions rather than erasing them", () => {
  const memory = fixture(); old(memory).condition = "只在工作日";
  apply(memory); resolve(memory, "coexist", { condition: "取决于是否加糖" });
  const version = canonicalActiveEntries(group(memory).users[USER]).find(e => e.value === "喜欢黑咖啡");
  assert.ok(version.condition.includes("只在工作日")); assert.ok(version.condition.includes("是否加糖"));
  assert.ok(canonicalPromptLines(group(memory).users[USER]).some(v => v.includes("只在工作日") && v.includes("是否加糖")));
});
test("low-confidence multi-source canonical candidate still cannot hold reliable OLD", () => {
  const memory = fixture(); seedStrongNew(memory);
  group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶").confidence = 0.1;
  apply(memory);
  assert.equal(old(memory).verificationHoldCaseIds, undefined);
});
test("coexisting polarity opposites stay conditioned instead of reopening a case", () => {
  const memory = fixture(); apply(memory, { newValue: "不喜欢黑咖啡", relation: "condition" });
  assert.equal(resolve(memory, "coexist", { condition: "取决于是否加糖" }).ok, true);
  const values = legacyMemoryValues(group(memory).users[USER], "preferences");
  assert.equal(values.length, 2); assert.ok(values.every(v => v.includes("是否加糖")));
  assert.equal(collectVerificationCases(group(memory), CONV, options({ now: T3 })).created.length, 0);
});
test("group conditioned versions render in groupMemoryValues", () => {
  const memory = fixture(), g = group(memory), subject = `conversation:${CONV}:facts`;
  g.groupFactMemory = { conversationId: CONV, ...userFixture("喜欢黑咖啡", "profile", subject) };
  g.groupFactMemory.profile = ["喜欢黑咖啡"]; g.facts = ["喜欢黑咖啡"];
  const entry = g.groupFactMemory.canonicalMemory.entries.find(e => e.value === "喜欢黑咖啡");
  applyVerificationHints(g, CONV, [{ subjectUserId: subject, memoryId: entry.id, newValue: "喜欢红茶", sourceMessageIds: ["new-source"], relation: "condition" }], [row()], options());
  assert.equal(resolve(memory, "coexist", { condition: "不同讨论场景" }).ok, true);
  const values = groupMemoryValues(g, "facts");
  assert.ok(values.some(v => v.startsWith("喜欢黑咖啡（适用条件：")));
  assert.ok(values.some(v => v.startsWith("喜欢红茶（适用条件：")));
  const versions = g.groupFactMemory.canonicalMemory.entries.filter(e => e.source === "admin-verification");
  assert.ok(versions.every(e => !e.sourceMessageIds.includes("admin-event") && !e.selfExplicitAt && !e.explicitAt));
  const freshNew = versions.find(e => e.value === "喜欢红茶");
  assert.deepEqual(freshNew.sourceUserIds, [USER]);
  assert.equal(freshNew.sourceUserIds.includes(subject), false);
  assert.equal(freshNew.adminProvenance.at(-1).actorUserId, ADMIN);
});
test("new_invalid replaces disputed OLD with usable ADMIN version, keeps originals", () => {
  const memory = fixture();
  extractNew(memory, "不喜欢黑咖啡", [row({ message_id: "n1", sent_at: T0 }), row({ message_id: "n2" })]);
  collectVerificationCases(group(memory), CONV, options());
  const originalOld = old(memory), evidence = structuredClone(originalOld.sourceMessageIds);
  assert.equal(originalOld.status, "disputed");
  const r = resolve(memory, "new_invalid"); assert.equal(r.ok, true);
  const u = group(memory).users[USER];
  assert.equal(u.canonicalMemory.entries.find(e => e.id === originalOld.id).status, "superseded");
  assert.deepEqual(u.canonicalMemory.entries.find(e => e.id === originalOld.id).sourceMessageIds, evidence);
  assert.deepEqual(legacyMemoryValues(u, "preferences"), ["喜欢黑咖啡"]);
  assert.ok(canonicalActiveEntries(u).some(e => e.id === r.case.resolvedMemoryId && e.source === "admin-verification"));
});
test("old_invalid clears only its NEW hold and installs an unendorsed tentative correction epoch", () => {
  const memory = fixture(); applyStrong(memory);
  const newerId = cases(memory)[0].newMemory.id;
  const original = structuredClone(group(memory).users[USER].canonicalMemory.entries.find(e => e.id === newerId));
  const r = resolve(memory, "old_invalid"); assert.equal(r.ok, true);
  const u = group(memory).users[USER], newer = u.canonicalMemory.entries.find(e => e.id === newerId);
  assert.deepEqual(newer.verificationHoldCaseIds, []);
  assert.equal(newer.status, "tentative"); assert.equal(newer.correctionAction, "tentative");
  assert.equal(newer.correctedAt, T3); assert.deepEqual(newer.postCorrectionEvidenceKeys, []); assert.equal(newer.postCorrectionConfidence, 0);
  assert.deepEqual(newer.sourceMessageIds, original.sourceMessageIds); assert.equal(newer.firstSeenAt, original.firstSeenAt);
  assert.equal(newer.lastConfirmedAt, original.lastConfirmedAt); assert.equal(newer.confidence, original.confidence);
  assert.equal(newer.correctionProvenance.type, "ADMIN"); assert.equal(newer.correctionProvenance.actorUserId, ADMIN);
  assert.equal(newer.sourceMessageIds.includes("admin-event"), false);
  assert.equal(u.canonicalMemory.entries.some(e => e.source === "admin-verification"), false);
  assert.equal(canonicalActiveEntries(u).some(e => e.id === newerId), false);
});
test("old_invalid NEW cannot recover from replay/old keys but genuinely later same-user evidence can requalify", () => {
  const memory = fixture(), rows = seedStrongNew(memory);
  apply(memory, { sourceMessageIds: rows.map(r => r.message_id) }, options(), rows);
  resolve(memory, "old_invalid");
  const getNew = () => group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  extractNew(memory, "喜欢红茶", rows);
  assert.equal(getNew().status, "tentative"); assert.deepEqual(getNew().postCorrectionEvidenceKeys, []);
  extractNew(memory, "喜欢红茶", rows.map(r => ({ ...r, sent_at: "2026-01-05T00:00:00.000Z" })));
  assert.equal(getNew().status, "tentative"); assert.deepEqual(getNew().postCorrectionEvidenceKeys, []);
  extractNew(memory, "喜欢红茶", [row({ message_id: "arrived-late-old-event", sent_at: T2 })]);
  assert.equal(getNew().status, "tentative"); assert.deepEqual(getNew().postCorrectionEvidenceKeys, []);
  assert.equal(extractNew(memory, "喜欢红茶", [row({ user_id: "10002", message_id: "foreign", sent_at: "2026-01-05T00:00:00.000Z" })]).accepted.length, 0);
  extractNew(memory, "喜欢红茶", [row({ message_id: "fresh-one", sent_at: "2026-01-05T00:00:00.000Z" })]);
  assert.equal(getNew().postCorrectionEvidenceKeys.length, 1); assert.equal(getNew().status, "tentative");
  extractNew(memory, "喜欢红茶", [row({ message_id: "fresh-two", sent_at: "2026-01-06T00:00:00.000Z" })]);
  assert.equal(getNew().postCorrectionEvidenceKeys.length, 2); assert.equal(getNew().status, "active");
  assert.ok(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === getNew().id));
  assert.ok(legacyMemoryValues(group(memory).users[USER], "preferences").includes("喜欢红茶"));
  assert.equal(old(memory).status, "rejected"); assert.equal(cases(memory)[0].status, "resolved");
});
test("old_invalid preserves previous NEW correction history and resets that epoch without self evidence", () => {
  const memory = fixture(); seedStrongNew(memory);
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  Object.assign(newer, { correctedAt: T0, correctionAction: "tentative", correctedBy: "earlier-admin", correctionReason: "此前仍待核实",
    correctionSourceMessageIds: ["earlier-command"], correctionEvidenceKeys: [JSON.stringify([CONV, "earlier-command"])],
    postCorrectionEvidenceKeys: [JSON.stringify([CONV, "earlier-new-source"])], postCorrectionConfidence: 0.8 });
  const prior = structuredClone(newer);
  apply(memory); assert.equal(resolve(memory, "old_invalid").ok, true);
  const actual = group(memory).users[USER].canonicalMemory.entries.find(e => e.id === newer.id);
  const history = actual.verificationPreviousCorrections.at(-1);
  for (const key of Object.keys(prior).filter(k => /^(corrected|correction|postCorrection)/.test(k))) assert.deepEqual(history[key], prior[key], key);
  assert.deepEqual(actual.postCorrectionEvidenceKeys, []); assert.equal(actual.postCorrectionConfidence, 0);
  assert.equal(actual.correctedAt, T3); assert.equal(actual.status, "tentative");
  assert.deepEqual(actual.sourceMessageIds, prior.sourceMessageIds);
});
test("old_invalid keeps other live case holds even after fresh evidence requalifies NEW", () => {
  const memory = fixture(); applyStrong(memory);
  const redId = cases(memory)[0].newMemory.id, whiteRows = seedStrongNew(memory, "喜欢白茶");
  apply(memory, { memoryId: redId, newValue: "喜欢白茶", sourceMessageIds: whiteRows.map(r => r.message_id) }, options(), whiteRows);
  const second = cases(memory)[1]; assert.equal(resolve(memory, "old_invalid").ok, true);
  extractNew(memory, "喜欢红茶", [row({ message_id: "new-red-one", sent_at: "2026-01-05T00:00:00.000Z" }), row({ message_id: "new-red-two", sent_at: "2026-01-06T00:00:00.000Z" })]);
  const u = group(memory).users[USER], actual = u.canonicalMemory.entries.find(e => e.id === redId);
  assert.equal(actual.status, "active"); assert.deepEqual(actual.verificationHoldCaseIds, [second.id]);
  assert.equal(canonicalActiveEntries(u).some(e => e.id === redId), false);
  assert.equal(legacyMemoryValues(u, "preferences").includes("喜欢红茶"), false);
});
test("age-derived deferral is read-only, preserves holds and CAS across the boundary", () => {
  const memory = fixture(); applyStrong(memory);
  const rev = cases(memory)[0].revision, before = structuredClone(memory);
  const threshold = "2026-01-10T00:00:00.000Z"; // created Jan 3 + seven days
  const pending = listVerificationCases(memory, { now: "2026-01-09T23:59:59.999Z", status: "pending" });
  assert.equal(pending.cases.length, 1);
  const deferred = listVerificationCases(memory, { now: threshold });
  assert.equal(deferred.cases[0].status, "deferred"); assert.equal(deferred.cases[0].derivedDeferred, true);
  assert.equal(deferred.cases[0].deferredAt, threshold);
  assert.equal(deferred.cases[0].notificationReady, false);
  assert.equal(deferred.cases[0].revision, rev);
  assert.equal(listVerificationCases(memory, { now: threshold, status: "pending" }).cases.length, 0);
  assert.equal(deferred.totals.deferred, 1); assert.equal(deferred.totals.pending, 0);
  assert.deepEqual(memory, before);
  assert.equal(resolve(memory, "update", { expectedRevision: rev, now: threshold }).ok, true);
});
test("custom deferral thresholds are captured and may be overridden at read", () => {
  const memory = fixture();
  apply(memory, {}, options({ config: { memory: { verification: { shadowMode: false, deferAfterMs: 0 } } } }));
  assert.equal(listVerificationCases(memory, { now: T2 }).cases[0].status, "deferred");
  assert.equal(listVerificationCases(memory, { now: T2, config: { memory: { verification: { deferAfterMs: 86400000 } } } }).cases[0].status, "pending");
});
test("full runtime config callbacks do not discard scoped verification settings", () => {
  const config = { onReply: () => {}, memory: { unrelatedRuntime: () => {}, verification: { shadowMode: false, adminUserIds: [ADMIN] } } };
  assert.equal(memoryVerificationConfig(config).shadowMode, false);
  assert.equal(isVerificationAdmin(config, ADMIN, CONV), true);
  const memory = fixture(); assert.equal(apply(memory, {}, options({ config })).created.length, 1);
});
test("unsure defers without choosing or timeout autoaccept", () => {
  const memory = fixture(); applyStrong(memory); assert.equal(resolve(memory, "unsure").code, "DEFERRED");
  const before = structuredClone(memory);
  collectVerificationCases(group(memory), CONV, options({ now: "2030-01-01T00:00:00Z" }));
  assert.deepEqual(memory, before); assert.equal(cases(memory)[0].status, "deferred");
  assert.equal(old(memory).verificationHoldCaseIds.length, 1);
  assert.equal(cases(memory, { status: "pending" }).length, 0);
});
test("old_invalid does not automatically trust pending new candidate", () => {
  const memory = fixture(); apply(memory);
  assert.equal(resolve(memory, "old_invalid").ok, true);
  assert.equal(old(memory).status, "rejected");
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  assert.equal(newer.status, "tentative"); assert.equal(newer.confidence, 0);
  assert.equal(newer.correctedAt, T3); assert.equal(newer.correctionAction, "tentative");
  assert.deepEqual(newer.verificationHoldCaseIds, []);
  extractNew(memory);
  assert.equal(group(memory).users[USER].canonicalMemory.entries.find(e => e.id === newer.id).status, "tentative");
  assert.equal(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === newer.id), false);
  extractNew(memory, "喜欢红茶", [row({ message_id: "case-only-fresh-1", sent_at: "2026-01-05T00:00:00.000Z" }),
    row({ message_id: "case-only-fresh-2", sent_at: "2026-01-06T00:00:00.000Z" })]);
  assert.ok(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === newer.id));
  assert.equal(group(memory).users[USER].canonicalMemory.entries.find(e => e.id === newer.id).correctedAt, T3);
});
test("new_invalid leaves tombstone even before canonical candidate exists", () => {
  const memory = fixture(); apply(memory);
  assert.equal(resolve(memory, "new_invalid").ok, true);
  const u = group(memory).users[USER];
  assert.equal(u.canonicalMemory.entries.find(e => e.value === "喜欢红茶").status, "rejected");
  extractNew(memory);
  assert.equal(u.canonicalMemory.entries.find(e => e.value === "喜欢红茶").status, "rejected");
  assert.equal(u.canonicalMemory.entries.filter(e => e.value === "喜欢红茶").length, 1);
  assert.equal(old(memory).status, "superseded");
  assert.ok(canonicalActiveEntries(u).some(e => e.value === "喜欢黑咖啡" && e.id !== old(memory).id));
});
test("terminal corrections never revived by any resolution action", () => {
  for (const action of ["update", "coexist", "new_invalid", "old_invalid"]) {
    const memory = fixture(); apply(memory);
    applyCanonicalCorrections(group(memory).users[USER], [{ memoryId: old(memory).id, action: "reject" }], { subjectUserId: USER, sentAt: T3 });
    const before = structuredClone(memory);
    assert.equal(resolve(memory, action, { condition: "某个场景" }).ok, false);
    assert.deepEqual(memory, before);
  }
});
test("endorsed new version is readable while stale siblings keep their original holds", () => {
  const memory = fixture();
  applyStrong(memory); applyStrong(memory, "喜欢绿茶");
  const second = cases(memory)[1]; assert.equal(old(memory).verificationHoldCaseIds.length, 2);
  const r = resolve(memory); assert.equal(r.ok, true);
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.id === r.case.resolvedMemoryId);
  assert.deepEqual(version.verificationHoldCaseIds, []);
  assert.equal(canonicalActiveEntries(group(memory).users[USER]).some(e => e.id === version.id), true);
  assert.ok(canonicalPromptLines(group(memory).users[USER]).some(line => line.includes("喜欢红茶")));
  assert.ok(legacyMemoryValues(group(memory).users[USER], "preferences").includes("喜欢红茶"));
  assert.deepEqual(old(memory).verificationHoldCaseIds, [second.id]);
  const sibling = cases(memory).find(c => c.id === second.id);
  assert.equal(sibling.status, "pending"); assert.equal(sibling.stale, true); assert.equal(sibling.notificationReady, false);
  const before = structuredClone(memory);
  for (const revision of [second.revision, sibling.revision]) {
    for (const action of ["update", "coexist", "new_invalid", "old_invalid", "unsure"]) {
      assert.equal(resolveVerificationCase(memory, { conversationId: CONV, caseId: second.id, expectedRevision: revision,
        action, actorUserId: ADMIN, authorized: true, now: T3, condition: "重新审查" }).code, "STALE_REVISION");
      assert.deepEqual(memory, before);
    }
  }
  collectVerificationCases(group(memory), CONV, options({ now: T3 }));
  assert.deepEqual(memory, before, "collect must not rebind or auto-resolve a sibling against terminal OLD");
});
test("coexist and new_invalid versions also do not inherit unrelated sibling holds", () => {
  for (const action of ["coexist", "new_invalid"]) {
    const memory = fixture(); applyStrong(memory); applyStrong(memory, "喜欢绿茶");
    const siblingId = cases(memory)[1].id, r = resolve(memory, action, { condition: "各自适用场景" });
    assert.equal(r.ok, true);
    const versions = group(memory).users[USER].canonicalMemory.entries.filter(e => r.case.resolvedMemoryIds.includes(e.id));
    assert.ok(versions.every(e => e.verificationHoldCaseIds.length === 0));
    assert.ok(versions.every(e => canonicalActiveEntries(group(memory).users[USER]).some(active => active.id === e.id)));
    assert.equal(cases(memory).find(c => c.id === siblingId).status, "pending");
    assert.equal(cases(memory).find(c => c.id === siblingId).stale, true);
  }
});
test("complete correction payload and original evidence survive in replacement history", () => {
  const memory = fixture(); seedStrongNew(memory);
  const newer = group(memory).users[USER].canonicalMemory.entries.find(e => e.value === "喜欢红茶");
  Object.assign(newer, { correctedAt: T0, correctedBy: "prior-admin", correctionAction: "review", correctionReason: "原核实原因",
    correctionSourceMessageIds: ["prior-correction-message"], correctionConversationId: CONV,
    correctionEvidenceKeys: [JSON.stringify([CONV, "prior-correction-message"])],
    correctionMetadata: { originalReasonCode: "NEEDS_REVIEW" }, correctionVerificationCaseId: "prior-case",
    postCorrectionEvidenceKeys: [JSON.stringify([CONV, "post-correction-source"])], postCorrectionConfidence: 0.8,
    verificationPreviousCorrections: [{ correctedAt: "2025-12-31T00:00:00.000Z", correctionReason: "更早的原因" }],
    verificationDecisions: [{ type: "ADMIN", actorUserId: "prior-admin", action: "review", caseId: "prior-case" }] });
  const original = structuredClone(newer);
  apply(memory); const r = resolve(memory); assert.equal(r.ok, true);
  const u = group(memory).users[USER], version = u.canonicalMemory.entries.find(e => e.id === r.case.resolvedMemoryId);
  const prior = version.verificationPreviousCorrections.at(-1);
  for (const key of Object.keys(original).filter(k => /^(corrected|correction|postCorrection)/.test(k))) assert.deepEqual(prior[key], original[key], key);
  for (const key of ["sourceMessageIds", "sourceMessageTimes", "evidenceKeys", "evidenceConfirmations", "sourceConversationId"]) {
    if (Object.hasOwn(original, key)) assert.deepEqual(prior[key], original[key], key);
  }
  assert.deepEqual(version.verificationPreviousCorrections[0], original.verificationPreviousCorrections[0]);
  assert.deepEqual(version.verificationDecisions[0], original.verificationDecisions[0]);
  assert.equal(version.correctedAt, undefined); assert.equal(version.correctionReason, undefined);
  assert.equal(version.correctionSourceMessageIds, undefined); assert.equal(version.postCorrectionConfidence, undefined);
  const historicalOriginal = u.canonicalMemory.entries.find(e => e.id === original.id);
  assert.equal(historicalOriginal.verificationPreviousCorrections.at(-1).correctionReason, "原核实原因");
  assert.deepEqual(historicalOriginal.verificationPreviousCorrections.at(-1).correctionSourceMessageIds, ["prior-correction-message"]);
});
test("notifications and unknown verification fields survive all mutations", () => {
  const memory = fixture();
  group(memory).memoryVerification = { version: 1, cases: [], notifications: [{ key: "sent-before", at: T0 }],
    extra: { future: "preserved" } };
  apply(memory); collectVerificationCases(group(memory), CONV, options()); resolve(memory, "unsure");
  assert.deepEqual(group(memory).memoryVerification.notifications, [{ key: "sent-before", at: T0 }]);
  assert.deepEqual(group(memory).memoryVerification.extra, { future: "preserved" });
});
test("read-only listing includes revisions and totals, never mutates", () => {
  const memory = fixture(); apply(memory); const before = structuredClone(memory);
  const r = listVerificationCases(memory, { conversationId: CONV, now: T3 });
  assert.equal(r.totals.pending, 1); assert.equal(r.totals.total, 1);
  assert.ok(r.cases[0].revision); assert.ok(r.cases[0].oldMemory); assert.ok(r.cases[0].newMemory);
  r.cases[0].newMemory.value = "UI mutation"; assert.deepEqual(memory, before);
});
test("default 200-item preview stays compatible while totals include later groups", () => {
  const { memory } = paginationFixture(), before = structuredClone(memory);
  const result = listVerificationCases(memory);
  assert.equal(result.cases.length, 200); assert.equal(result.totals.total, 440);
  assert.equal(result.totals.resolved, 100); assert.equal(result.totals.pending, 340);
  assert.equal(result.totals.filteredTotal, 440); assert.equal(result.totals.truncated, 240);
  assert.deepEqual(result.pagination, { offset: 0, limit: 200, nextOffset: 200, hasMore: true });
  assert.deepEqual(memory, before);
});
test("listing skips historical portraits in many groups without an own verification inbox", () => {
  const memory = fixture(); apply(memory); let invoked = 0;
  for (let index = 0; index < 1000; index++) {
    const portrait = {};
    Object.defineProperty(portrait, "canonicalMemory", { enumerable: true, get() { invoked++; throw new Error("UNTOUCHED_PORTRAIT"); } });
    memory.groups[`group:history-${index}`] = { users: { [USER]: portrait }, summary: "历史画像无需扫描" };
  }
  const result = listVerificationCases(memory);
  assert.notEqual(result.ok, false); assert.equal(result.totals.total, 1);
  assert.equal(result.cases.length, 1); assert.equal(result.cases[0].conversationId, CONV);
  assert.equal(invoked, 0);
  const empty = listVerificationCases({ groups: Object.fromEntries(Object.entries(memory.groups).filter(([conv]) => conv !== CONV)) });
  assert.notEqual(empty.ok, false); assert.equal(empty.totals.total, 0); assert.equal(invoked, 0);
});
test("listing still rejects getter/prototype corruption in portraits of a touched inbox", () => {
  for (const corrupt of [portrait => {
    Object.defineProperty(portrait, "poison", { enumerable: true, get() { throw new Error("MUST_NOT_EXECUTE"); } });
    return portrait;
  }, portrait => Object.assign(Object.create({ inherited: "unsafe" }), portrait)]) {
    const memory = fixture(); apply(memory);
    group(memory).users[USER] = corrupt(group(memory).users[USER]);
    const result = listVerificationCases(memory);
    assert.equal(result.ok, false); assert.equal(result.code, "INVALID_MEMORY_STATE");
    assert.deepEqual(result.cases, []);
  }
});
test("filtered pagination reaches group B after inactive first 100 and already-notified pages", () => {
  const { memory, otherConv } = paginationFixture(), before = structuredClone(memory);
  const receipts = new Set(group(memory).memoryVerification.notifications.map(n => n.caseId));
  let offset = 0, firstActionable = null;
  const ids = [];
  for (let page = 0; page < 10; page++) {
    const result = listVerificationCases(memory, { status: "pending", offset, limit: 100 });
    assert.equal(result.totals.total, 440); assert.equal(result.totals.resolved, 100);
    assert.equal(result.totals.filteredTotal, 340);
    assert.ok(result.cases.every(c => c.status === "pending"));
    ids.push(...result.cases.map(c => c.id));
    firstActionable ||= result.cases.find(c => !receipts.has(c.id));
    if (!result.pagination.hasMore) { assert.equal(result.pagination.nextOffset, null); break; }
    assert.ok(result.pagination.nextOffset > offset); offset = result.pagination.nextOffset;
  }
  assert.equal(ids.length, 340); assert.equal(new Set(ids).size, 340);
  assert.equal(firstActionable.conversationId, otherConv);
  assert.equal(firstActionable.id, "page_b_0");
  assert.deepEqual(memory, before);
});
test("exact case guard lookup finds later-group case beyond the default 200 preview", () => {
  const { memory, otherConv } = paginationFixture();
  assert.equal(listVerificationCases(memory).cases.some(c => c.id === "page_b_119"), false);
  const guard = listVerificationCases(memory, { conversationId: otherConv, caseId: "page_b_119", status: "pending" });
  assert.deepEqual(guard.cases.map(c => c.id), ["page_b_119"]);
  assert.equal(guard.totals.total, 120); assert.equal(guard.totals.pending, 120); assert.equal(guard.totals.filteredTotal, 1);
  assert.deepEqual(guard.pagination, { offset: 0, limit: 200, nextOffset: null, hasMore: false });
  assert.equal(listVerificationCases(memory, { conversationId: CONV, caseId: "page_b_119" }).cases.length, 0);
  assert.equal(listVerificationCases(memory, { caseId: "page_b_11" }).cases.length, 1, "case ID filter is exact, not a prefix");
});
test("pagination offset is applied after status filtering and out-of-range pages terminate", () => {
  const { memory } = paginationFixture();
  const first = listVerificationCases(memory, { status: "pending", offset: 0, limit: 1 });
  assert.equal(first.cases[0].id, "page_a_100"); assert.equal(first.pagination.nextOffset, 1);
  const last = listVerificationCases(memory, { status: "pending", offset: 339, limit: 100 });
  assert.deepEqual(last.cases.map(c => c.id), ["page_b_119"]); assert.equal(last.pagination.hasMore, false);
  for (const offset of [340, 10000, Number.MAX_SAFE_INTEGER]) {
    const empty = listVerificationCases(memory, { status: "pending", offset, limit: 100 });
    assert.equal(empty.cases.length, 0); assert.equal(empty.totals.filteredTotal, 340);
    assert.equal(empty.pagination.hasMore, false); assert.equal(empty.pagination.nextOffset, null);
  }
});
test("malformed list options fail closed with fixed explicit errors and no mutation", () => {
  const memory = fixture(); apply(memory); const before = structuredClone(memory);
  const optionsList = [null, [], { offset: -1 }, { offset: 0.5 }, { offset: "0" }, { offset: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "100" },
    { caseId: "" }, { caseId: "__proto__" }, { caseId: "bad id" }, { status: "anything" }, { now: "2026-02-30T00:00:00Z" },
    JSON.parse('{"__proto__": {"limit": 1}}')];
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, "offset", { get() { invoked = true; return 0; }, enumerable: true });
  optionsList.push(accessor);
  for (const options of optionsList) {
    const result = listVerificationCases(memory, options);
    assert.equal(result.ok, false); assert.equal(result.code, "INVALID_OPTIONS");
    assert.deepEqual(result.cases, []); assert.equal(result.pagination.hasMore, false);
    assert.deepEqual(memory, before);
  }
  assert.equal(invoked, false);
});
test("admission backpressure retains all existing cases and legacy arrays", () => {
  const memory = fixture(), g = group(memory), raw = structuredClone(g.users[USER]);
  const hints = Array.from({ length: 40 }, (_, i) => hint(memory, { newValue: `新偏好${i}` }));
  const r = applyVerificationHints(g, CONV, hints, [row()], options());
  assert.equal(r.created.length, 32); assert.equal(r.backpressure.blocked, 8);
  assert.equal(g.memoryVerification.cases.length, 32);
  assert.deepEqual(g.users[USER].preferences, raw.preferences);
  assert.deepEqual(g.users[USER].profile, raw.profile); assert.deepEqual(g.users[USER].aliases, raw.aliases);
});
test("case capacity does not FIFO evict resolutions or audits", () => {
  const memory = fixture(); apply(memory); resolve(memory, "new_invalid");
  const seed = structuredClone(group(memory).memoryVerification.cases[0]);
  for (let i = 1; i < 512; i++) group(memory).memoryVerification.cases.push({ ...structuredClone(seed), id: `saved_${i}` });
  const before = structuredClone(group(memory).memoryVerification);
  const validOld = group(memory).users[USER].canonicalMemory.entries.find(e => e.source === "admin-verification");
  const r = apply(memory, { memoryId: validOld.id, newValue: "另一个候选" });
  assert.equal(r.backpressure.blocked, 1); assert.equal(r.created.length, 0);
  assert.deepEqual(group(memory).memoryVerification, before);
});
test("all evidence retained, only preview is capped", () => {
  const memory = fixture(), rows = Array.from({ length: 40 }, (_, i) => row({ message_id: `source-${i}` }));
  apply(memory, { sourceMessageIds: rows.map(x => x.message_id) }, options(), rows);
  assert.equal(group(memory).memoryVerification.cases[0].newMemory.sourceMessageIds.length, 40);
  assert.equal(cases(memory)[0].newMemory.sourceMessageIds.length, 32);
  resolve(memory);
  const version = group(memory).users[USER].canonicalMemory.entries.find(e => e.source === "admin-verification");
  assert.equal(version.sourceMessageIds.length, 40);
});
test("disabled feature admits nothing and leaves published state intact", () => {
  const memory = fixture(), before = structuredClone(memory);
  apply(memory, {}, options({ config: { memoryVerification: { enabled: false } } }));
  assert.deepEqual(memory, before);
});
test("verification APIs never consult a hidden clock", () => {
  const memory = fixture(), OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { if (!args.length) throw new Error("HIDDEN_CLOCK"); super(...args); }
    static now() { throw new Error("HIDDEN_CLOCK"); }
  };
  try {
    assert.equal(apply(memory).created.length, 1);
    assert.equal(collectVerificationCases(group(memory), CONV, options()).rejected.length, 0);
    old(memory).confidence = 0.8;
    assert.equal(review(memory).code, "REVIEWED");
    assert.equal(resolve(memory).ok, true);
  } finally { globalThis.Date = OriginalDate; }
});

if (failures.length) for (const failure of failures) console.error(failure.stack || failure.message);
console.log(JSON.stringify({ ok: failures.length === 0, suite: "memory-verification", tests: passed, failed: failures.length, total: passed + failures.length }));
if (failures.length) process.exitCode = 1;
