import assert from "node:assert/strict";
import {
  applyCanonicalCorrections,
  canonicalActiveEntries,
  canonicalMemoryFields,
  canonicalPromptLines,
  ensureCanonicalMemory,
  legacyMemoryFallbackAllowed,
  legacyMemoryValues,
  memoryIntegrityReport,
  mergeCanonicalEvidence
} from "../src/memory-integrity.js";
import { applyMemoryExtraction, groupMemoryValues } from "../src/memory-application.js";
import { attributeMemoryEvidence } from "../src/memory-evidence.js";

// Entirely synthetic, deterministic fixtures: no files, services or model calls.
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const T3 = "2026-01-01T03:00:00.000Z";
const T4 = "2026-01-01T04:00:00.000Z";
const T5 = "2026-01-01T05:00:00.000Z";
const T6 = "2026-01-01T06:00:00.000Z";
const T7 = "2026-01-01T07:00:00.000Z";
const T8 = "2026-01-01T08:00:00.000Z";
const T9 = "2026-01-01T09:00:00.000Z";
const SUBJECT = "10001";
let passed = 0;
const failures = [];

function test(name, run) {
  try {
    run();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    failures.push(error);
  }
}

function fixture(raw = {}) {
  const user = structuredClone(raw);
  ensureCanonicalMemory(user, SUBJECT, { at: T0 });
  return user;
}

function context(ids = ["m1"], extra = {}) {
  return { subjectUserId: SUBJECT, conversationId: "group:test", sourceMessageIds: ids, sentAt: T1, ...extra };
}

function merge(user, value = "喜欢黑咖啡", ctx = context(), extra = {}, options = {}) {
  return mergeCanonicalEvidence(user, { preferences: [value], confidence: 0.8, ...extra }, ctx, options);
}

function entry(user, value = "喜欢黑咖啡") {
  return user.canonicalMemory.entries.find((item) => item.value === value);
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("duplicate invocations and compatibility representations are one confirmation", () => {
  const user = fixture();
  const update = {
    preferences: ["喜欢黑咖啡", "喜欢黑咖啡"], confidence: 0.8,
    canonical_entries: [{ kind: "preference", value: "喜欢黑咖啡", confidence: 0.9 }]
  };
  mergeCanonicalEvidence(user, update, context(["m1", "m1"]));
  assert.equal(entry(user).evidenceConfirmations, 1);
  assert.equal(entry(user).status, "tentative");
  assert.equal(user.canonicalMemory.entries.length, 1);
  const before = structuredClone(user);
  assert.equal(mergeCanonicalEvidence(user, update, context(["m1"], { sentAt: T3 })).changed, false);
  assert.deepEqual(user, before, "re-extraction must not advance timestamps");
  mergeCanonicalEvidence(user, { canonical_entries: update.canonical_entries }, context());
  assert.equal(entry(user).evidenceConfirmations, 1, "separate user_updates/canonical_entries passes must dedupe too");
  merge(user, undefined, context(["m2"], { sentAt: T2 }));
  assert.equal(entry(user).evidenceConfirmations, 2);
  assert.equal(entry(user).status, "active");
});

test("evidence identity is conversation plus message, not invocation or sender metadata", () => {
  const user = fixture();
  merge(user, undefined, context(["m1"], { sourceUserId: SUBJECT }));
  merge(user, undefined, context(["m1"], { sourceUserId: "10002", sentAt: T2 }));
  assert.equal(entry(user).evidenceConfirmations, 1);
  merge(user, undefined, context(["m1"], { conversationId: "group:other", sentAt: T2 }));
  assert.equal(entry(user).evidenceConfirmations, 2);
  assert.equal(entry(user).status, "active");
  merge(user, undefined, context(["m1"], { conversationId: "group:test", sentAt: T3 }));
  assert.equal(entry(user).evidenceConfirmations, 2, "must remember evidence from all conversations");
  assert.equal(entry(user).lastConfirmedAt, T2);
});

test("overlapping source batches count only their new IDs without dropping old IDs", () => {
  const user = fixture();
  const ids = Array.from({ length: 24 }, (_, index) => `m${index}`);
  merge(user, undefined, context(ids));
  assert.equal(entry(user).evidenceConfirmations, 24);
  assert.equal(entry(user).sourceMessageIds.length, 24);
  merge(user, undefined, context(["m0", "m23", "m24"], { sentAt: T2 }));
  assert.equal(entry(user).evidenceConfirmations, 25);
  merge(user, undefined, context(["m0"], { sentAt: T3 }));
  assert.equal(entry(user).evidenceConfirmations, 25);
  assert.equal(entry(user).lastConfirmedAt, T2);
});

test("missing evidence cannot accumulate independent confirmations", () => {
  for (const ctx of [context([]), context(["m1"], { conversationId: "" })]) {
    const user = fixture();
    for (const sentAt of [T1, T2, T3]) merge(user, undefined, { ...ctx, sentAt }, {}, { requireEvidence: false });
    assert.equal(entry(user).evidenceConfirmations, 0);
    assert.equal(entry(user).status, "tentative");
    assert.equal(entry(user).lastConfirmedAt, T1);
    assert.equal(memoryIntegrityReport({ groups: { test: { users: { [SUBJECT]: user } } } }).totals.withoutEvidence, 1);
  }
});

test("a caller-authorized command is not fabricated independent evidence", () => {
  const user = fixture();
  merge(user, undefined, context([], { explicit: true }));
  assert.equal(entry(user).status, "active");
  assert.equal(entry(user).evidenceConfirmations, 0);
  assert.equal(entry(user).explicitAt, T1);
});

test("migrate inflated historical invocation counts conservatively", () => {
  const user = fixture();
  merge(user);
  const old = entry(user);
  delete old.evidenceKeys;
  old.evidenceConfirmations = 200;
  old.status = "active";
  merge(user);
  assert.equal(old.evidenceConfirmations, 1);
  assert.equal(old.status, "tentative");
});

test("real first/last/updated timestamps are monotonic under late evidence", () => {
  const user = fixture();
  merge(user, undefined, context(["new"], { sentAt: T3 }));
  merge(user, undefined, context(["old"], { sentAt: T1 }));
  assert.equal(entry(user).firstSeenAt, T1);
  assert.equal(entry(user).lastConfirmedAt, T3);
  assert.equal(user.canonicalMemory.updatedAt, T3);
  ensureCanonicalMemory(user, SUBJECT, { at: T0 });
  assert.equal(user.canonicalMemory.updatedAt, T3);
});

test("newest trusted explicit conflict wins in either delivery order", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const user = fixture();
    const events = [
      ["喜欢黑咖啡", context(["old"], { sentAt: T1, explicit: true })],
      ["不喜欢黑咖啡", context(["new"], { sentAt: T2, explicit: true })]
    ];
    for (const index of order) merge(user, ...events[index]);
    assert.equal(entry(user, "喜欢黑咖啡").status, "superseded");
    assert.equal(entry(user, "不喜欢黑咖啡").status, "active");
    assert.equal(user.canonicalMemory.updatedAt, T2);
    const before = structuredClone(user);
    merge(user, "喜欢黑咖啡", context(["old"], { sentAt: T3, explicit: true }));
    assert.deepEqual(user, before, "replayed old ID cannot masquerade as a new explicit event");
    merge(user, "喜欢黑咖啡", context(["older-unseen"], { sentAt: T0, explicit: true }));
    assert.equal(entry(user, "喜欢黑咖啡").status, "superseded");
    merge(user, "喜欢黑咖啡", context(["latest"], { sentAt: T3, explicit: true }));
    assert.equal(entry(user, "喜欢黑咖啡").status, "active");
    assert.equal(entry(user, "不喜欢黑咖啡").status, "superseded");
  }
});

test("equal-time contradictory commands fail closed in either order", () => {
  for (const values of [["喜欢黑咖啡", "不喜欢黑咖啡"], ["不喜欢黑咖啡", "喜欢黑咖啡"]]) {
    const user = fixture();
    values.forEach((value, index) => merge(user, value, context([`m${index}`], { explicit: true })));
    assert.equal(entry(user).status, "disputed");
    assert.equal(entry(user, "不喜欢黑咖啡").status, "disputed");
    assert.deepEqual(canonicalPromptLines(user), []);
  }
});

test("old superseded snapshots cannot be revived by a late old explicit event", () => {
  const user = fixture();
  merge(user, undefined, context(["m1"], { sentAt: T2 }));
  entry(user).status = "superseded";
  delete entry(user).supersededAt;
  merge(user, undefined, context(["old-explicit"], { sentAt: T1, explicit: true }));
  assert.equal(entry(user).status, "superseded");
  assert.equal(entry(user).explicitAt, undefined);
  merge(user, undefined, context(["old-explicit"], { sentAt: T3, explicit: true }));
  assert.equal(entry(user).status, "superseded", "replaying the rejected old event remains old");
  merge(user, undefined, context(["new-explicit"], { sentAt: T3, explicit: true }));
  assert.equal(entry(user).status, "active");
});

test("trusted attribution can confirm an already observed event only once", () => {
  const user = fixture();
  merge(user);
  merge(user, undefined, context(["m1"], { explicit: true }));
  assert.equal(entry(user).explicitAt, T1);
  assert.equal(entry(user).evidenceConfirmations, 1);
  const before = structuredClone(user);
  merge(user, undefined, context(["m1"], { explicit: true, sentAt: T3 }));
  assert.deepEqual(user, before);
});

test("AI explicit is not a trusted correction and requires contextual self identity", () => {
  for (const identity of [undefined, "10002"]) {
    const user = fixture();
    merge(user, undefined, context(["m1"], { sourceUserId: identity }), { explicit: true });
    assert.equal(entry(user).status, "tentative");
    assert.equal(entry(user).explicitAt, undefined);
  }
  const user = fixture();
  merge(user, undefined, context(["m1"], { sourceUserId: SUBJECT }), {
    canonical_entries: [{ kind: "preference", value: "喜欢黑咖啡", explicit: true, confidence: 0.8 }]
  });
  assert.equal(entry(user).status, "active", "identity-bound uncontested statement may be used");
  assert.equal(entry(user).explicitAt, undefined, "self hint must not be promoted to trusted command");
  merge(user, "不喜欢黑咖啡", context(["m2"], { sourceUserId: SUBJECT, sentAt: T2 }), { explicit: true });
  assert.equal(entry(user).status, "disputed");
  assert.equal(entry(user, "不喜欢黑咖啡").status, "disputed");
  merge(user, "不喜欢黑咖啡", context(["command"], { explicit: true, sentAt: T3 }));
  assert.equal(entry(user).status, "superseded");
  assert.equal(entry(user, "不喜欢黑咖啡").status, "active");
});

test("untrusted hints or invalid-time explicit cannot overthrow a trusted event", () => {
  const user = fixture();
  merge(user, undefined, context(["trusted"], { explicit: true }));
  merge(user, "不喜欢黑咖啡", context(["hint"], { sourceUserId: SUBJECT, sentAt: T2 }), { explicit: true });
  merge(user, "不喜欢黑咖啡", context(["invalid-time"], { explicit: true, sentAt: "not-a-time" }));
  assert.equal(entry(user).status, "active");
  assert.equal(entry(user, "不喜欢黑咖啡").status, "superseded");
  assert.equal(entry(user, "不喜欢黑咖啡").explicitAt, undefined);
});

test("ID-scoped terminal corrections survive explicit replay and legacy mirrors", () => {
  for (const action of ["reject", "supersede"]) {
    const user = fixture({ preferences: ["喜欢黑咖啡"], aliases: ["小明"] });
    const target = entry(user);
    assert.equal(applyCanonicalCorrections(user, [{ memory_id: target.id, action }], context([], { sentAt: T2 })), true);
    const status = action === "reject" ? "rejected" : "superseded";
    assert.equal(target.status, status);
    assert.equal(legacyMemoryFallbackAllowed(user), false);
    const before = structuredClone(user);
    for (const sentAt of [T1, T3]) merge(user, undefined, context([sentAt], { explicit: true, sentAt }));
    ensureCanonicalMemory(user, SUBJECT, { at: T3 });
    assert.deepEqual(user, before);
    assert.equal(canonicalPromptLines(user).some((line) => line.includes("黑咖啡")), false);
    // Emulate an old serialized snapshot without the bootstrap marker.
    delete user.canonicalMemory.legacyImported;
    ensureCanonicalMemory(user, SUBJECT, { at: T3 });
    assert.equal(entry(user).status, status);
    assert.equal(user.canonicalMemory.entries.filter((item) => item.id === target.id).length, 1);
    assert.equal(legacyMemoryFallbackAllowed(user), false);
  }
});

test("late/unknown/mismatched corrections cannot target another subject", () => {
  const user = fixture();
  merge(user, undefined, context(["m1"], { explicit: true, sentAt: T2 }));
  const target = entry(user);
  const before = structuredClone(user);
  for (const [correction, ctx] of [
    [{ memory_id: target.id, action: "reject" }, context([], { subjectUserId: "10002", sentAt: T3 })],
    [{ memory_id: target.id, user_id: "10002", action: "reject" }, context([], { sentAt: T3 })],
    [{ memory_id: target.id, action: "reject" }, context([], { subjectUserId: "", sentAt: T3 })],
    [{ memory_id: "missing", action: "reject" }, context([], { sentAt: T3 })],
    [{ memory_id: target.id, action: "reject" }, context([], { sentAt: T1 })],
    [{ memory_id: target.id, action: "typo" }, context([], { sentAt: T3 })]
  ]) assert.equal(applyCanonicalCorrections(user, [correction], ctx), false);
  assert.deepEqual(user, before);
});

test("newer AI observations cannot veto a late valid explicit correction", () => {
  const user = fixture();
  merge(user, undefined, context(["command"], { explicit: true, sentAt: T1 }));
  merge(user, undefined, context(["ai-observation"], { sentAt: T3 }));
  assert.equal(entry(user).lastConfirmedAt, T3);
  assert.equal(applyCanonicalCorrections(user, [{ memory_id: entry(user).id, action: "reject" }], context([], { sentAt: T2 })), true);
  assert.equal(entry(user).status, "rejected");
  assert.equal(user.canonicalMemory.updatedAt, T3);
});

test("invalid timestamps do not inject wall-clock time into evidence ordering", () => {
  const user = fixture();
  merge(user, undefined, context(["bad-time"], { sentAt: "bad", explicit: true }));
  merge(user, undefined, context(["other-bad-time"], { sentAt: "bad", explicit: true }));
  assert.equal(entry(user), undefined, "invalid event times cannot create independent confirmations");
  assert.equal(user.canonicalMemory.updatedAt, T0);
  merge(user, undefined, context(["real-time"], { sentAt: T1, explicit: true }));
  assert.equal(applyCanonicalCorrections(user, [{ memory_id: entry(user).id, action: "reject" }], context([], { sentAt: T2 })), true);
});

test("subject IDs cannot be rebound, including colliding foreign entry IDs", () => {
  const user = fixture();
  merge(user);
  const before = structuredClone(user);
  assert.equal(mergeCanonicalEvidence(user, { user_id: "10002", preferences: ["喜欢茶"] }, context()).changed, false);
  ensureCanonicalMemory(user, "10002", { at: T3 });
  mergeCanonicalEvidence(user, { canonical_entries: [{ user_id: "10002", kind: "preference", value: "喜欢茶" }] }, context());
  assert.deepEqual(user, before);
  entry(user).subjectUserId = "10002";
  const foreign = structuredClone(user);
  assert.equal(merge(user, undefined, context(["m2"])).changed, false);
  assert.equal(applyCanonicalCorrections(user, [{ memory_id: entry(user).id, action: "reject" }], context([], { sentAt: T3 })), false);
  assert.deepEqual(user, foreign);
  assert.deepEqual(canonicalPromptLines(user), []);
  assert.equal(memoryIntegrityReport({ groups: { test: { users: { [SUBJECT]: user } } } }).ok, false);
  const mismatchedRoot = fixture();
  mismatchedRoot.canonicalMemory.subjectUserId = "10002";
  assert.equal(memoryIntegrityReport({ groups: { test: { users: { [SUBJECT]: mismatchedRoot } } } }).ok, false);
});

test("legacy bootstrap is additive, idempotent and never edits raw fields", () => {
  const raw = { aliases: ["小明"], profile: ["模型爱好者"], preferences: ["茶"],
    canonicalMemory: { confidence: 0.45, aliases: ["阿明"], preferences: ["咖啡"] } };
  const user = fixture(raw);
  const canonical = user.canonicalMemory;
  assert.equal(canonical.entries.length, 5);
  assert.equal(canonical.entries.every((item) => item.evidenceConfirmations === 0), true);
  assert.equal(legacyMemoryFallbackAllowed(user), true, "legacy low confidence can remain compatibility-only");
  const before = structuredClone(user);
  ensureCanonicalMemory(user, SUBJECT, { at: T3 });
  assert.deepEqual(user, before);
  assert.deepEqual(user.aliases, raw.aliases);
  assert.deepEqual(user.profile, raw.profile);
  assert.deepEqual(user.preferences, raw.preferences);
  assert.deepEqual(canonical.aliases, raw.canonicalMemory.aliases);
  user.preferences.push("刚写入的镜像");
  ensureCanonicalMemory(user, SUBJECT, { at: T3 });
  assert.equal(canonical.entries.length, 5);
  assert.equal(legacyMemoryFallbackAllowed(user), false, "new compatibility mirrors are not trusted fallback");
  merge(user, "刚写入的镜像");
  assert.equal(entry(user, "刚写入的镜像").status, "tentative");
  assert.equal(entry(user, "刚写入的镜像").evidenceConfirmations, 1);
});

test("fallback cannot bypass tentative or disputed standard entries", () => {
  assert.equal(legacyMemoryFallbackAllowed({ aliases: ["旧外号"] }), true);
  const user = fixture({ preferences: ["喜欢黑咖啡"] });
  assert.equal(legacyMemoryFallbackAllowed(user), true);
  merge(user, "不喜欢黑咖啡");
  assert.equal(entry(user).status, "disputed");
  assert.equal(legacyMemoryFallbackAllowed(user), false);
  assert.deepEqual(canonicalPromptLines(user), []);
  assert.equal(legacyMemoryFallbackAllowed(user, { subjectUserId: "10002" }), false);
});

test("value fallback retains unrelated legacy preferences after scoped corrections", () => {
  for (const action of ["reject", "supersede"]) {
    const user = fixture({ preferences: ["喜欢绿茶", "喜欢黑咖啡"], profile: ["以前是设计师"], aliases: ["小明"] });
    applyCanonicalCorrections(user, [
      { memory_id: entry(user).id, action },
      { memory_id: entry(user, "以前是设计师").id, action }
    ], context([], { sentAt: T2 }));
    user.preferences.push("喜欢新写入的镜像", "喜欢新提取的偏好");
    merge(user, "喜欢新提取的偏好", context(["new"], { sentAt: T3 }));
    assert.equal(legacyMemoryFallbackAllowed(user), false, "whole-user gate stays backward compatible");
    assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢绿茶"]);
    assert.deepEqual(legacyMemoryValues(user, "profile", user.profile), []);
    assert.deepEqual(legacyMemoryValues(user, "aliases", user.aliases), ["小明"]);
  }
});

test("disputed and superseded values do not suppress unrelated legacy values", () => {
  const user = fixture({ preferences: ["喜欢绿茶", "喜欢黑咖啡"] });
  user.preferences.push("不喜欢黑咖啡");
  merge(user, "不喜欢黑咖啡", context(["opposite"]));
  assert.equal(entry(user).status, "disputed");
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢绿茶"]);
  merge(user, "不喜欢黑咖啡", context(["trusted"], { explicit: true, sentAt: T2 }));
  assert.equal(entry(user).status, "superseded");
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢绿茶", "不喜欢黑咖啡"]);
});

test(".45 legacy values stay compatibility-only on frozen snapshots", () => {
  const user = fixture({ preferences: ["喜欢绿茶"], aliases: ["小明"] });
  merge(user, "喜欢黑咖啡");
  const before = structuredClone(user);
  freeze(user);
  assert.deepEqual(legacyMemoryValues(user, "preferences", ["喜欢绿茶"], { minConfidence: 0.9 }), ["喜欢绿茶"]);
  assert.deepEqual(legacyMemoryValues(user, "aliases", user.aliases), ["小明"]);
  assert.deepEqual(canonicalPromptLines(user), [], "compatibility projection does not promote legacy evidence");
  assert.equal(entry(user, "喜欢绿茶").confidence, 0.45);
  assert.equal(entry(user, "喜欢绿茶").evidenceConfirmations, 0);
  assert.deepEqual(entry(user, "喜欢绿茶").evidenceKeys, []);
  assert.deepEqual(user, before);
});

test("value helper covers every camel/snake field and canonical kind", () => {
  for (const [field, kind] of Object.entries(canonicalMemoryFields)) {
    const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const user = fixture({ [field]: ["旧值"] });
    for (const name of new Set([field, snake, kind])) {
      assert.deepEqual(legacyMemoryValues(user, name, ["旧值", "新镜像", "旧值"]), ["旧值"], name);
      assert.deepEqual(legacyMemoryValues(user, name), ["旧值"], `${name}: omitted values`);
    }
    // Old persisted arrays may themselves use snake_case; bootstrap is additive.
    const snakeUser = fixture({ [snake]: ["蛇形字段旧值"] });
    assert.deepEqual(legacyMemoryValues(snakeUser, field), ["蛇形字段旧值"]);
  }
  assert.deepEqual(legacyMemoryValues(fixture({ aliases: ["小明"] }), "unknown", ["小明"]), []);
  assert.deepEqual(legacyMemoryValues(fixture({ aliases: ["小明"] }), "constructor", ["小明"]), []);
});

test("value helper rejects wrong/unknown subjects and foreign entry identities", () => {
  const user = fixture({ preferences: ["喜欢绿茶", "喜欢黑咖啡"] });
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences, { subjectUserId: "10002" }), []);
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences, { subjectUserId: "" }), []);
  assert.deepEqual(legacyMemoryValues({ preferences: ["喜欢绿茶"] }, "preferences", ["喜欢绿茶"]), []);
  entry(user).subjectUserId = "10002";
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢绿茶"]);
  const wrongRawIdentity = { ...user, user_id: "10002" };
  assert.deepEqual(legacyMemoryValues(wrongRawIdentity, "preferences", user.preferences), []);
});

test("uninitialized legacy reads allow only stored values without bootstrapping live data", () => {
  const user = freeze({ core_memes: ["旧梗"], preferences: ["喜欢绿茶"] });
  const before = structuredClone(user);
  assert.deepEqual(legacyMemoryValues(user, "coreMemes", ["旧梗", "凭空传入的值"], { subjectUserId: SUBJECT }), ["旧梗"]);
  assert.deepEqual(legacyMemoryValues(user, "preferences", undefined, { subjectUserId: SUBJECT }), ["喜欢绿茶"]);
  assert.deepEqual(user, before);
  assert.equal(Object.hasOwn(user, "canonicalMemory"), false);
  const bootstrapped = fixture();
  bootstrapped.preferences = ["新写入的镜像"];
  assert.deepEqual(legacyMemoryValues(bootstrapped, "preferences", bootstrapped.preferences), []);
});

test("standard entries retain prompt confidence checks rather than legacy exemption", () => {
  const user = fixture({ preferences: ["喜欢绿茶"] });
  merge(user, "喜欢黑咖啡", context(["command"], { explicit: true }), { confidence: 0.5 });
  user.preferences.push("喜欢黑咖啡");
  assert.equal(entry(user).status, "active");
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢绿茶"]);
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences, { minConfidence: 0.4 }), ["喜欢绿茶", "喜欢黑咖啡"]);
});

test("stable aliases remain active alongside unrelated new tentative evidence", () => {
  const user = fixture();
  mergeCanonicalEvidence(user, { aliases: ["小明"], confidence: 0.9 }, context(["alias"], { explicit: true }));
  merge(user, "喜欢茶", context(["other"], { sentAt: T2 }));
  assert.equal(entry(user, "小明").status, "active");
  assert.deepEqual(canonicalPromptLines(user), ["aliases:小明"]);
});

test("invalid numerical confidence cannot create or leak stable entries", () => {
  for (const confidence of [NaN, Infinity, -Infinity, -1, 2, "bad", "", null, true, {}, []]) {
    const user = fixture();
    merge(user, undefined, context(["m1"], { explicit: true }), { confidence });
    mergeCanonicalEvidence(user, { canonical_entries: [{ kind: "alias", value: "bad", confidence }] }, context(["m2"], { explicit: true }));
    assert.equal(user.canonicalMemory.entries.length, 0, `invalid confidence: ${String(confidence)}`);
    const malformed = fixture();
    merge(malformed, undefined, context(["valid"], { explicit: true }));
    entry(malformed).confidence = confidence;
    assert.deepEqual(canonicalPromptLines(malformed), []);
  }
  const user = fixture();
  merge(user, undefined, context(["m1", "m2"]), { confidence: "0.8" });
  assert.equal(entry(user).status, "active", "finite numeric strings remain backward compatible");
});

test("prompt/report/fallback reads preserve frozen live and legacy-only objects", () => {
  const user = fixture({ aliases: ["小明"] });
  merge(user, undefined, context(["m1", "m2"]));
  const legacy = { aliases: ["阿明"], preferences: ["茶"] };
  const memory = { groups: { test: { users: { [SUBJECT]: user, "10002": legacy } } } };
  const before = structuredClone(memory);
  freeze(memory);
  const report = memoryIntegrityReport(memory);
  assert.equal(report.totals.users, 2);
  assert.equal(report.ok, true);
  assert.deepEqual(canonicalPromptLines(user), ["preferences:喜欢黑咖啡"]);
  canonicalPromptLines(legacy, { subjectUserId: "10002", minConfidence: 0.4 });
  legacyMemoryFallbackAllowed(user);
  assert.deepEqual(memory, before);
  assert.equal(Object.hasOwn(legacy, "canonicalMemory"), false);
});

test("durable capacities never evict entries, evidence, conflicts or tombstones", () => {
  const user = fixture();
  merge(user, "保留的旧条目", context(["old"], { explicit: true }));
  const tombstone = entry(user, "保留的旧条目");
  applyCanonicalCorrections(user, [{ memory_id: tombstone.id, action: "reject" }], context([], { sentAt: T2 }));
  const options = { maxEntriesPerUser: 3, maxConflictsPerUser: 1 };
  mergeCanonicalEvidence(user, {
    style: Array.from({ length: 200 }, (_, index) => `表达方式${index}`), confidence: 0.8
  }, context(["bulk"], { explicit: true, sentAt: T3 }), options);
  for (let index = 0; index < 45; index += 1) {
    merge(user, `喜欢测试主题${index}`, context([`pos${index}`]), {}, options);
    merge(user, `不喜欢测试主题${index}`, context([`neg${index}`], { sentAt: T2 }), {}, options);
  }
  assert.equal(user.canonicalMemory.entries.length, 291);
  assert.equal(user.canonicalMemory.conflicts.length, 45);
  assert.equal(tombstone.status, "rejected");
  assert.equal(user.canonicalMemory.entries.includes(tombstone), true);
  const count = user.canonicalMemory.entries.length;
  const lines = canonicalPromptLines(user, { maxItemsPerField: 3 });
  assert.equal(lines.find((line) => line.startsWith("style:")).split("、").length, 3);
  assert.equal(user.canonicalMemory.entries.length, count);
});

test("legacy import and rebuild dates never invent event confirmations", () => {
  const user = { preferences: ["原有偏好"], canonicalMemory: { rebuiltAt: T3 } };
  ensureCanonicalMemory(user, SUBJECT, { at: T3 });
  assert.equal(user.canonicalMemory.entries[0].firstSeenAt, "");
  assert.equal(user.canonicalMemory.entries[0].lastConfirmedAt, "");
  assert.equal(user.canonicalMemory.entries[0].evidenceConfirmations, 0);
  const dated = { preferences: ["旧偏好"], firstSeenAt: T0, lastSeenAt: T1 };
  ensureCanonicalMemory(dated, SUBJECT, { at: T3 });
  assert.equal(dated.canonicalMemory.entries[0].firstSeenAt, T0);
  assert.equal(dated.canonicalMemory.entries[0].lastConfirmedAt, T1);
});

// Correction epochs are tested on an identity/profile assertion rather than a
// meme kind (which has intentionally different initial activation rules).
const CORRECTED_PROFILE = "从事软件开发";
function profileEvidence(user, ids, sentAt, confidence = 0.9, { trusted = false, hint = false } = {}) {
  // This helper deliberately describes sources authored at the SAME real time.
  // Mixed-time fixtures below pass their individual original timestamps instead.
  return mergeCanonicalEvidence(user, { canonical_entries: [{ kind: "profile", value: CORRECTED_PROFILE,
    confidence, explicit: hint }] }, context(ids, { sentAt, sourceUserId: SUBJECT, explicit: trusted,
    sourceMessageTimes: Object.fromEntries(ids.map(id => [id, sentAt])) }));
}
function correctProfile(user, sentAt = T4, action = "tentative") {
  assert.equal(applyCanonicalCorrections(user, [{ memory_id: entry(user, CORRECTED_PROFILE).id, action }],
    context([`correction-${sentAt}`], { sentAt, sourceUserId: SUBJECT, actorUserId: SUBJECT })), true);
}
function correctedProfile(priorMarker = "") {
  const user = fixture({ profile: [] });
  profileEvidence(user, ["old-1"], T1, 0.95);
  profileEvidence(user, ["old-2"], T2, 0.95,
    { trusted: priorMarker === "explicit", hint: priorMarker === "selfExplicit" });
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  user.profile.push(CORRECTED_PROFILE); // The compatibility mirror must not bypass the epoch.
  correctProfile(user);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
  return user;
}
function profileVisibility(user, visible) {
  const before = structuredClone(user);
  assert.equal(canonicalActiveEntries(user, { subjectUserId: SUBJECT }).some(item => item.value === CORRECTED_PROFILE), visible);
  assert.equal(canonicalPromptLines(user, { subjectUserId: SUBJECT }).some(line => line.includes(CORRECTED_PROFILE)), visible);
  assert.deepEqual(legacyMemoryValues(user, "profile", user.profile, { subjectUserId: SUBJECT }), visible ? [CORRECTED_PROFILE] : []);
  assert.equal(legacyMemoryFallbackAllowed(user, { subjectUserId: SUBJECT }), false);
  memoryIntegrityReport({ groups: { test: { users: { [SUBJECT]: user } } } });
  assert.deepEqual(user, before, "prompt and compatibility projections must be pure");
}

test("late old and equal-time evidence cannot revive a tentative correction", () => {
  for (const sentAt of [T1, T3, T4]) {
    const user = correctedProfile();
    profileEvidence(user, ["previously-unseen-old-message"], sentAt);
    const target = entry(user, CORRECTED_PROFILE);
    assert.equal(target.status, "tentative", "event time must be strictly after the correction");
    assert.equal(target.correctedAt, T4);
    assert.deepEqual(target.postCorrectionEvidenceKeys, []);
    assert.equal(target.postCorrectionConfidence, 0);
    profileVisibility(freeze(user), false);
  }
});

test("one new high-confidence source cannot reuse pre-correction counts", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  const target = entry(user, CORRECTED_PROFILE);
  assert(target.evidenceConfirmations >= 3, "old evidence remains preserved as history");
  assert.equal(target.postCorrectionEvidenceKeys.length, 1);
  assert.equal(target.status, "tentative");
  profileVisibility(user, false);
});

test("duplicate fresh evidence and later invocation timestamps are not a second source", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  profileEvidence(user, ["fresh-1", "fresh-1"], T8);
  assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys.length, 1);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
  profileVisibility(user, false);
});

test("two genuinely new stable sources can confirm the corrected profile", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  profileEvidence(user, ["fresh-2"], T6);
  const target = entry(user, CORRECTED_PROFILE);
  assert.equal(target.postCorrectionEvidenceKeys.length, 2);
  assert.equal(target.postCorrectionConfidence, 0.9);
  assert.equal(target.status, "active");
  assert.equal(target.correctedAt, T4, "reconfirmation must preserve the correction record");
  profileVisibility(freeze(user), true);
});

test("new low-confidence sources do not inherit old high confidence", () => {
  for (const confidence of [0, 0.2, 0.6]) {
    const user = correctedProfile();
    profileEvidence(user, ["weak-1"], T5, confidence);
    profileEvidence(user, ["weak-2"], T6, confidence);
    const target = entry(user, CORRECTED_PROFILE);
    assert.equal(target.confidence, 0.95, "historical confidence is retained, not reused for the epoch");
    assert.equal(target.postCorrectionConfidence, confidence);
    assert.equal(target.postCorrectionEvidenceKeys.length, 2);
    assert.equal(target.status, "tentative");
    profileVisibility(freeze(user), false);
  }
});

test("re-extracting the same weak sources at high confidence cannot promote them", () => {
  const user = correctedProfile();
  profileEvidence(user, ["weak-1"], T5, 0.2);
  profileEvidence(user, ["weak-2"], T6, 0.2);
  profileEvidence(user, ["weak-1", "weak-2"], T8, 0.99);
  assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionConfidence, 0.2);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
  profileVisibility(user, false);
});

test("a genuinely new authenticated explicit event can reactivate without two sources", () => {
  const user = correctedProfile();
  profileEvidence(user, ["new-trusted-command"], T5, 0.9, { trusted: true });
  assert.equal(entry(user, CORRECTED_PROFILE).explicitAt, T5);
  assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys.length, 1);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  profileVisibility(freeze(user), true);
});

test("old explicit and self-explicit markers cannot authorize one fresh source", () => {
  for (const marker of ["explicit", "selfExplicit"]) {
    const user = correctedProfile(marker);
    assert.equal(entry(user, CORRECTED_PROFILE)[`${marker}At`], T2);
    profileEvidence(user, ["fresh-1"], T5);
    assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
    assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys.length, 1);
    profileVisibility(user, false);
  }
});

test("replaying an old explicit message never becomes a new trusted correction override", () => {
  const user = correctedProfile("explicit");
  for (const sentAt of [T2, T4, T8]) profileEvidence(user, ["old-2"], sentAt, 0.95, { trusted: true });
  assert.equal(entry(user, CORRECTED_PROFILE).explicitAt, T2);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
  assert.deepEqual(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys, []);
  profileVisibility(user, false);
});

test("a later tentative correction starts a new epoch rather than reusing the previous epoch", () => {
  const user = correctedProfile();
  profileEvidence(user, ["epoch-1a"], T5);
  profileEvidence(user, ["epoch-1b"], T6);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  correctProfile(user, T7);
  const target = entry(user, CORRECTED_PROFILE);
  assert.deepEqual(target.postCorrectionEvidenceKeys, []);
  assert.equal(target.postCorrectionConfidence, 0);
  profileEvidence(user, ["epoch-1a", "epoch-1b"], T8);
  assert.deepEqual(target.postCorrectionEvidenceKeys, []);
  profileEvidence(user, ["epoch-2a"], T8);
  assert.equal(target.status, "tentative");
  profileVisibility(user, false);
  profileEvidence(user, ["epoch-2b"], T9);
  assert.equal(target.postCorrectionEvidenceKeys.length, 2);
  assert.equal(target.status, "active");
  profileVisibility(user, true);
});

test("terminal corrections remain terminal even after a partial reconfirmation epoch", () => {
  for (const action of ["reject", "supersede"]) {
    const user = correctedProfile();
    profileEvidence(user, ["fresh-1"], T5);
    correctProfile(user, T6, action);
    profileEvidence(user, ["later-1", "later-2"], T8, 0.99, { trusted: true, hint: true });
    assert.equal(entry(user, CORRECTED_PROFILE).status, action === "reject" ? "rejected" : "superseded");
    profileVisibility(freeze(user), false);
  }
});

test("persisted stale-active snapshots without epoch fields cannot leak through either projection", () => {
  for (const marker of ["", "explicit", "selfExplicit"]) {
    const user = correctedProfile(marker), target = entry(user, CORRECTED_PROFILE);
    // Emulate a snapshot written by the old bug; readers must not trust status alone.
    target.status = "active";
    delete target.postCorrectionEvidenceKeys;
    delete target.postCorrectionConfidence;
    profileVisibility(freeze(user), false);
  }
});

test("persisted stale-active snapshots with only one new source remain hidden", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  entry(user, CORRECTED_PROFILE).status = "active";
  profileVisibility(freeze(user), false);
});

test("persisted stale-active snapshots cannot use old confidence over weak epoch evidence", () => {
  const user = correctedProfile();
  profileEvidence(user, ["weak-1"], T5, 0.2);
  profileEvidence(user, ["weak-2"], T6, 0.2);
  entry(user, CORRECTED_PROFILE).status = "active";
  profileVisibility(freeze(user), false);
});

test("markerless populated canonical reads never import unknown raw mirrors and stay pure", () => {
  const user = fixture({ profile: [] });
  profileEvidence(user, ["original-1", "original-2"], T1);
  user.profile.push(CORRECTED_PROFILE, "未经证据确认的新身份镜像");
  user.canonicalMemory.profile = ["canonical旧数组里的未知镜像"];
  user.canonicalMemory.confidence = 0.95;
  delete user.canonicalMemory.legacyImported;
  const before = structuredClone(user);
  freeze(user);
  assert.deepEqual(canonicalPromptLines(user), [`profile:${CORRECTED_PROFILE}`]);
  assert.deepEqual(legacyMemoryValues(user, "profile"), [CORRECTED_PROFILE]);
  assert.equal(legacyMemoryFallbackAllowed(user), false);
  assert.deepEqual(canonicalActiveEntries(user).map(item => item.value), [CORRECTED_PROFILE]);
  assert.deepEqual(user, before, "reads must not restore a marker or add entries on the live snapshot");
  const writable = structuredClone(user);
  ensureCanonicalMemory(writable, SUBJECT, { at: T9 });
  assert.deepEqual(writable.canonicalMemory.entries, before.canonicalMemory.entries,
    "explicit normalization must not import mirrors into an already populated store either");
});

test("markerless conflict-only canonical stores are not uninitialized legacy snapshots", () => {
  const user = { profile: ["未知身份镜像"], canonicalMemory: { subjectUserId: SUBJECT, confidence: 0.95,
    entries: [], conflicts: [{ subjectUserId: SUBJECT, entries: ["old-a", "old-b"], at: T1 }] } };
  const before = structuredClone(user);
  freeze(user);
  assert.deepEqual(canonicalPromptLines(user), []);
  assert.deepEqual(legacyMemoryValues(user, "profile"), []);
  assert.deepEqual(user, before);
  const writable = structuredClone(user);
  ensureCanonicalMemory(writable, SUBJECT, { at: T9 });
  assert.deepEqual(writable.canonicalMemory.entries, []);
  assert.deepEqual(writable.canonicalMemory.conflicts, before.canonicalMemory.conflicts);
});

test("an imported empty canonical store never bootstraps later raw mirrors", () => {
  const user = fixture({ profile: [] });
  user.canonicalMemory.confidence = 0.95;
  user.profile.push("后来追加的未知身份镜像");
  const before = structuredClone(user);
  freeze(user);
  assert.deepEqual(canonicalPromptLines(user), []);
  assert.deepEqual(legacyMemoryValues(user, "profile"), []);
  assert.deepEqual(user, before);
});

test("truly empty markerless legacy stores retain one-time compatibility bootstrap without read mutations", () => {
  const user = { profile: ["历史身份记录"], canonicalMemory: { subjectUserId: SUBJECT, confidence: 0.9,
    entries: [], conflicts: [] } };
  const before = structuredClone(user);
  freeze(user);
  assert.deepEqual(canonicalPromptLines(user), ["profile:历史身份记录"]);
  assert.deepEqual(legacyMemoryValues(user, "profile"), ["历史身份记录"]);
  assert.deepEqual(user, before);
  const writable = structuredClone(user);
  ensureCanonicalMemory(writable, SUBJECT, { at: T9 });
  assert.equal(writable.canonicalMemory.entries.length, 1);
  assert.equal(writable.canonicalMemory.entries[0].source, "legacy-canonical");
  assert.equal(writable.canonicalMemory.entries[0].evidenceConfirmations, 0);
  ensureCanonicalMemory(writable, SUBJECT, { at: T9 });
  assert.equal(writable.canonicalMemory.entries.length, 1);
});

test("markerless legacy-only canonical stores reject unknown mirrors through whole-user fallback", () => {
  const user = fixture({ profile: ["原有身份记录"] });
  delete user.canonicalMemory.legacyImported;
  assert.equal(legacyMemoryFallbackAllowed(user), true, "known .45 legacy entries retain compatibility");
  user.profile.push("未经确认的新增身份镜像");
  const before = structuredClone(user);
  freeze(user);
  assert.equal(legacyMemoryFallbackAllowed(user), false, "a missing marker must not authorize raw-array fallback");
  assert.deepEqual(legacyMemoryValues(user, "profile"), ["原有身份记录"]);
  assert.deepEqual(canonicalActiveEntries(user, { minConfidence: 0.4 }).map(item => item.value), ["原有身份记录"]);
  assert.deepEqual(canonicalPromptLines(user, { minConfidence: 0.4 }), ["profile:原有身份记录"]);
  assert.deepEqual(user, before);
});

test("active-entry detail snapshots expose effective epoch confidence and are fully detached", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5, 0.7);
  profileEvidence(user, ["fresh-2"], T6, 0.7);
  assert.equal(entry(user, CORRECTED_PROFILE).confidence, 0.95);
  const before = structuredClone(user);
  freeze(user);
  const active = canonicalActiveEntries(user, { subjectUserId: SUBJECT });
  assert.equal(active.length, 1);
  assert.equal(active[0].confidence, 0.7, "details must not display historical .95 as current confidence");
  assert.deepEqual(canonicalActiveEntries(user, { subjectUserId: SUBJECT, minConfidence: 0.8 }), []);
  assert.deepEqual(canonicalActiveEntries(user, { subjectUserId: "10002" }), []);
  active[0].value = "caller-only value";
  active[0].sourceMessageIds.push("caller-only-source");
  active[0].postCorrectionEvidenceKeys.push("caller-only-epoch-key");
  assert.deepEqual(user, before, "returned nested evidence arrays must not alias the store");
  assert.equal(canonicalActiveEntries(user)[0].value, CORRECTED_PROFILE);
  assert.equal(canonicalActiveEntries(user)[0].confidence, 0.7);
});

test("detail and prompt read gates honor the same corrected stability policy", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5, 0.7);
  profileEvidence(user, ["fresh-2"], T6, 0.7);
  freeze(user);
  const options = { subjectUserId: SUBJECT, minStableConfidence: 0.8 };
  assert.deepEqual(canonicalActiveEntries(user, options), []);
  assert.deepEqual(canonicalPromptLines(user, options), []);
  assert.deepEqual(legacyMemoryValues(user, "profile", user.profile, options), []);
});

function correctedGroupWrapper(field) {
  const conversationId = "group:test", subject = `conversation:${conversationId}:${field}`;
  const slot = field === "facts" ? "groupFactMemory" : "groupTopicMemory";
  const wrapper = { conversationId, profile: [] }, group = { [field]: [CORRECTED_PROFILE], [slot]: wrapper };
  ensureCanonicalMemory(wrapper, subject, { at: T0 });
  const add = (id, sentAt, confidence = 0.9) => mergeCanonicalEvidence(wrapper,
    { user_id: subject, canonical_entries: [{ kind: "profile", value: CORRECTED_PROFILE, confidence }] },
    { ...context([id], { sentAt }), subjectUserId: subject, sourceUserId: SUBJECT,
      sourceMessageTimes: { [id]: sentAt } }, { requireEvidence: true });
  add("old-1", T1, 0.95);
  add("old-2", T2, 0.95);
  wrapper.profile.push(CORRECTED_PROFILE);
  const target = entry(wrapper, CORRECTED_PROFILE);
  assert.equal(applyCanonicalCorrections(wrapper, [{ memory_id: target.id, action: "tentative" }],
    { ...context(["correction"], { sentAt: T4 }), subjectUserId: subject }), true);
  return { group, target, add };
}

test("group facts and topics share the stale-active epoch and confidence read gates", () => {
  for (const field of ["facts", "topics"]) for (const scenario of ["missing-epoch", "one-source", "weak-two"]) {
    const { group, target, add } = correctedGroupWrapper(field);
    if (scenario === "missing-epoch") {
      delete target.postCorrectionEvidenceKeys;
      delete target.postCorrectionConfidence;
    } else {
      add("fresh-1", T5, scenario === "weak-two" ? 0.2 : 0.9);
      if (scenario === "weak-two") add("fresh-2", T6, 0.2);
    }
    target.status = "active"; // A serialized old-bug snapshot must fail closed.
    const before = structuredClone(group);
    freeze(group);
    assert.deepEqual(groupMemoryValues(group, field), [], `${field}: ${scenario}`);
    assert.deepEqual(group, before);
  }
  for (const field of ["facts", "topics"]) {
    const { group, add } = correctedGroupWrapper(field);
    add("fresh-1", T5);
    add("fresh-2", T6);
    freeze(group);
    assert.deepEqual(groupMemoryValues(group, field), [CORRECTED_PROFILE]);
    assert.deepEqual(groupMemoryValues(group, field, { integrity: { minStableConfidence: 0.95 } }), []);
  }
});

test("disabling personal evidence requirements cannot expose a one-source corrected group fact", () => {
  for (const field of ["facts", "topics"]) {
    const { group, target, add } = correctedGroupWrapper(field);
    add("fresh-1", T5);
    target.status = "active";
    const before = structuredClone(group);
    freeze(group);
    assert.deepEqual(groupMemoryValues(group, field, { integrity: { requireEvidence: false } }), [],
      "AI group facts/topics always require independent evidence, even for old stale-active snapshots");
    assert.deepEqual(group, before);
  }
});

function extractionAfterCorrection(rows, claimMetadata = {}) {
  const group = {}, conversationId = "group:test";
  const apply = messages => applyMemoryExtraction(group, conversationId, { canonical_entries: [{ user_id: SUBJECT,
    kind: "profile", value: CORRECTED_PROFILE, confidence: 0.9, source_message_ids: messages.map(([id]) => id),
    ...claimMetadata }] },
  messages.map(([message_id, sentAt]) => ({ message_id, user_id: SUBJECT, conversation_id: conversationId,
    text: "我从事软件开发", sentAt })));
  assert.equal(apply([["old-1", T1], ["old-2", T2]]).accepted.length, 1);
  const user = group.users[SUBJECT];
  correctProfile(user);
  apply(rows);
  return user;
}

test("multi-source extraction cannot stamp an old source with a newer sibling's event time", () => {
  const user = extractionAfterCorrection([["delayed-old", T3], ["fresh-1", T5]]);
  const target = entry(user, CORRECTED_PROFILE);
  assert.equal(target.status, "tentative", "one post-correction message plus one old message is not two fresh confirmations");
  assert.deepEqual(target.postCorrectionEvidenceKeys, [JSON.stringify(["group:test", "fresh-1"])]);
  profileVisibility(freeze(user), false);
});

test("multi-source extraction with two genuinely post-correction times remains confirmable", () => {
  const user = extractionAfterCorrection([["fresh-1", T5], ["fresh-2", T6]]);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys.length, 2);
  profileVisibility(freeze(user), true);
});

test("same correction ID and original event time replay preserve a partial new epoch", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5, 0.7);
  const before = structuredClone(user);
  const changed = applyCanonicalCorrections(user,
    [{ memory_id: entry(user, CORRECTED_PROFILE).id, action: "tentative" }],
    context([`correction-${T4}`], { sentAt: T4, sourceUserId: SUBJECT, actorUserId: SUBJECT }));
  assert.equal(changed, false);
  assert.deepEqual(user, before, "redelivery must not erase post-correction confidence or evidence");
  profileEvidence(user, ["fresh-2"], T6, 0.7);
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  profileVisibility(freeze(user), true);
});

test("a seen correction ID cannot reset the epoch by claiming a later invocation time", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  profileEvidence(user, ["fresh-2"], T6);
  const before = structuredClone(user);
  assert.equal(applyCanonicalCorrections(user,
    [{ memory_id: entry(user, CORRECTED_PROFILE).id, action: "tentative" }],
    context([`correction-${T4}`], { sentAt: T9, sourceUserId: SUBJECT, actorUserId: SUBJECT })), false);
  assert.deepEqual(user, before);
  profileVisibility(freeze(user), true);
});

test("same-action same-time correction without a remembered ID cannot reset the epoch", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  const before = structuredClone(user);
  assert.equal(applyCanonicalCorrections(user,
    [{ memory_id: entry(user, CORRECTED_PROFILE).id, action: "tentative" }],
    context(["same-event-time-other-id"], { sentAt: T4, sourceUserId: SUBJECT, actorUserId: SUBJECT })), false);
  assert.deepEqual(user, before);
});

test("a newer correction ID resets the epoch while older correction IDs remain remembered", () => {
  const user = correctedProfile();
  profileEvidence(user, ["fresh-1"], T5);
  profileEvidence(user, ["fresh-2"], T6);
  correctProfile(user, T7);
  const target = entry(user, CORRECTED_PROFILE);
  assert.equal(target.correctedAt, T7);
  assert.equal(target.status, "tentative");
  assert.deepEqual(target.postCorrectionEvidenceKeys, []);
  assert.equal(target.postCorrectionConfidence, 0);
  assert.deepEqual(new Set(target.correctionEvidenceKeys), new Set([T4, T7]
    .map(at => JSON.stringify(["group:test", `correction-${at}`]))));
  profileEvidence(user, ["next-epoch-1"], T8);
  const before = structuredClone(user);
  assert.equal(applyCanonicalCorrections(user, [{ memory_id: target.id, action: "tentative" }],
    context([`correction-${T4}`], { sentAt: T9, sourceUserId: SUBJECT, actorUserId: SUBJECT })), false);
  assert.deepEqual(user, before);
  profileEvidence(user, ["next-epoch-2"], T9);
  assert.equal(target.status, "active");
  profileVisibility(freeze(user), true);
});

test("multiple source IDs without individual times cannot be guessed fresh after a correction", () => {
  const user = correctedProfile();
  mergeCanonicalEvidence(user, { canonical_entries: [{ kind: "profile", value: CORRECTED_PROFILE, confidence: 0.9 }] },
    context(["unmapped-1", "unmapped-2"], { sentAt: T6, sourceUserId: SUBJECT }));
  const target = entry(user, CORRECTED_PROFILE);
  assert.equal(target.status, "tentative");
  assert.deepEqual(target.postCorrectionEvidenceKeys, []);
  assert.equal(target.postCorrectionConfidence, 0);
  profileVisibility(freeze(user), false);
});

test("single-source direct callers retain original sentAt compatibility without a time map", () => {
  const user = correctedProfile();
  for (const [id, sentAt] of [["compat-1", T5], ["compat-2", T6]]) {
    mergeCanonicalEvidence(user, { canonical_entries: [{ kind: "profile", value: CORRECTED_PROFILE, confidence: 0.9 }] },
      context([id], { sentAt, sourceUserId: SUBJECT }));
  }
  assert.equal(entry(user, CORRECTED_PROFILE).status, "active");
  assert.equal(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys.length, 2);
  profileVisibility(freeze(user), true);
});

test("partial invalid and future per-source times cannot fall back to a batch maximum", () => {
  for (const badTime of [undefined, "not-a-time", T9]) {
    const user = correctedProfile();
    const sourceMessageTimes = { "valid-fresh": T5, "outside-selected-ids": T6 };
    if (badTime !== undefined) sourceMessageTimes["invalid-or-missing"] = badTime;
    mergeCanonicalEvidence(user, { canonical_entries: [{ kind: "profile", value: CORRECTED_PROFILE, confidence: 0.9 }] },
      context(["valid-fresh", "invalid-or-missing"], { sentAt: T6, sourceUserId: SUBJECT, sourceMessageTimes }));
    assert.deepEqual(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys,
      [JSON.stringify(["group:test", "valid-fresh"])]);
    assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
    profileVisibility(freeze(user), false);
  }
});

test("per-claim source times and earliest event time come from selected eligible messages only", () => {
  const messages = [["actual-first", T1], ["actual-last", T6], ["unselected", T0]].map(([message_id, sentAt]) => (
    { message_id, sentAt, user_id: SUBJECT, conversation_id: "group:test", text: "我从事软件开发" }
  ));
  const patch = { canonical_entries: [{ user_id: SUBJECT, kind: "profile", value: CORRECTED_PROFILE,
    confidence: 0.9, source_message_ids: ["actual-first", "actual-last"],
    sourceMessageTimes: { "actual-first": T9, "actual-last": T9, unselected: T9 } }] };
  const attributed = attributeMemoryEvidence(patch, messages, { conversationId: "group:test" });
  assert.deepEqual(attributed.errors, []);
  assert.equal(attributed.items[0].status, "attributed");
  assert.deepEqual(attributed.items[0].context.sourceMessageTimes, { "actual-first": T1, "actual-last": T6 });
  const user = fixture({ profile: [] });
  mergeCanonicalEvidence(user, attributed.items[0].patch, attributed.items[0].context);
  const target = entry(user, CORRECTED_PROFILE);
  assert.equal(target.firstSeenAt, T1, "firstSeenAt is the minimum original time, not the batch maximum");
  assert.equal(target.lastConfirmedAt, T6);
});

test("AI-provided source times cannot launder old sources into a new personal epoch", () => {
  const user = extractionAfterCorrection([["delayed-old", T3], ["fresh-1", T5]],
    { sourceMessageTimes: { "delayed-old": T9, "fresh-1": T9 } });
  assert.equal(entry(user, CORRECTED_PROFILE).status, "tentative");
  assert.deepEqual(entry(user, CORRECTED_PROFILE).postCorrectionEvidenceKeys,
    [JSON.stringify(["group:test", "fresh-1"])]);
  profileVisibility(freeze(user), false);
});

test("group fact and topic source times also ignore AI maps and retain only genuinely new IDs", () => {
  for (const field of ["facts", "topics"]) for (const mixed of [true, false]) {
    const { group, target } = correctedGroupWrapper(field);
    const rows = mixed ? [["delayed-old", T3], ["fresh-1", T5]] : [["fresh-1", T5], ["fresh-2", T6]];
    const raw = { value: CORRECTED_PROFILE, confidence: 0.9, source_message_ids: rows.map(([id]) => id),
      sourceMessageTimes: Object.fromEntries(rows.map(([id]) => [id, T9])) };
    const patchField = field === "facts" ? "group_facts" : "topic_updates";
    const receipt = applyMemoryExtraction(group, "group:test", { [patchField]: [raw] },
      rows.map(([message_id, sentAt], index) => ({ message_id, sentAt, user_id: index ? "10002" : SUBJECT,
        conversation_id: "group:test", text: "这是一条群共识" })), { integrity: { requireEvidence: false } });
    const accepted = receipt.accepted.find(item => item.type === field);
    assert(accepted, JSON.stringify(receipt.rejected));
    assert.deepEqual(accepted.context.sourceMessageTimes, Object.fromEntries(rows));
    assert.equal(target.postCorrectionEvidenceKeys.length, mixed ? 1 : 2);
    assert.equal(target.status, mixed ? "tentative" : "active");
    const before = structuredClone(group);
    freeze(group);
    assert.deepEqual(groupMemoryValues(group, field, { integrity: { requireEvidence: false } }), mixed ? [] : [CORRECTED_PROFILE]);
    assert.deepEqual(group, before);
  }
});

console.log(JSON.stringify({ ok: failures.length === 0, tests: passed, failed: failures.length,
  total: passed + failures.length, suite: "memory-evidence" }));
if (failures.length) throw new AggregateError(failures, "memory-evidence regressions");
