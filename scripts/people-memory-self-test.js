import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { recordPersonEvidence, queryPersonMemory, personMemoryContext, personMemoryControl,
  administerPersonMemory, applyPersonExtractionReceipt, PEOPLE_MEMORY_LIMITS as LIMITS } from "../src/people-memory.js";
import { applyMemoryExtraction } from "../src/memory-application.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { readMemorySnapshot } from "../src/memory-repository.js";

// Synthetic QQs/messages only. Read bridge adapter SOURCE, never live state;
// no bridge execution, runtime config/archive/model/protocol access.
const NOW = Date.parse("2026-10-28T12:00:00Z"), DAY = 86_400_000;
const USER = "12345678", BOT = "account:fixture", GROUP = "group:23456789";
const tests = [];
const test = (name, run) => tests.push({ name, run });
const base = patch => ({ logicalBotId: BOT, userId: USER, verifiedSenderId: USER, accountId: "carrier-a",
  conversationId: GROUP, messageId: "msg-1", time: (NOW - DAY) / 1000, now: NOW,
  kind: "stable_fact", value: "喜欢研究星图", confidence: 0.9, sourceType: "message", privacy: "public", ...patch });
const query = (root, patch) => queryPersonMemory(root, { logicalBotId: BOT, userId: USER, conversationId: GROUP, now: NOW, ...patch });
const control = root => personMemoryControl(root, { logicalBotId: BOT, userId: USER });
const record = (root, patch) => recordPersonEvidence(root, base(patch));
const admin = (root, operation, patch) => administerPersonMemory(root, { logicalBotId: BOT, userId: USER,
  expectedRevision: root.peopleMemory?.revision ?? 0, operation, actorUserId: "34567890", authorized: true, now: NOW, ...patch });
const person = root => root.peopleMemory.bots[BOT].people[USER];
const seeded = patch => { const root = { groups: {} }; assert.equal(record(root, patch).ok, true); return root; };
function unchanged(root, action, reason) {
  const before = structuredClone(root), result = action();
  assert.equal(result.ok, false); if (reason) assert.equal(result.reason, reason);
  assert.deepEqual(root, before); return result;
}
function stable(root, patch = {}) {
  const first = record(root, patch);
  assert.equal(first.ok, true);
  assert.equal(record(root, { ...patch, messageId: "msg-2", time: NOW / 1000 }).ok, true);
  return first.entryId;
}
function extractionFixture({ conversationId = GROUP, kind = "preference", value = "喜欢研究星图",
  confidence = 0.9, times = [NOW - DAY, NOW], bots = [BOT], accountIds = {}, isoSourceTimes = false } = {}) {
  const group = {}, root = { groups: { [conversationId]: group } };
  const messages = times.map((time, index) => ({ message_id: `msg-${index + 1}`, user_id: USER,
    conversation_id: conversationId, sentAt: new Date(time).toISOString(), text: "我喜欢研究星图" }));
  const applied = applyMemoryExtraction(group, conversationId, { canonical_entries: [{ user_id: USER, kind,
    value, confidence, source_message_ids: messages.map(message => message.message_id) }] }, messages);
  assert.equal(applied.accepted.length, 1);
  group.peopleSourceIndex = Object.fromEntries(messages.map((message, index) => [message.message_id,
    Object.fromEntries(bots.map(logicalBotId => [logicalBotId, { accountId: accountIds[logicalBotId] ?? `carrier:${logicalBotId}`,
      conversationId: conversationId.startsWith("private:") ? conversationId.split(":").slice(0, 2).join(":")
        : conversationId.includes(":") ? conversationId : `group:${conversationId}`,
      verifiedSenderId: USER, time: isoSourceTimes ? new Date(times[index]).toISOString() : times[index] / 1000 }]))]));
  const args = { conversationId, receipts: applied.accepted, now: NOW };
  return { root, args, group, canonical: group.users[USER].canonicalMemory.entries[0] };
}

test("read-only absent root/control/context never create defaults", () => {
  const root = Object.freeze({ groups: Object.freeze({}) });
  assert.equal(query(root).status, "missing"); assert.equal(control(root).suppressesLegacy, false);
  assert.equal(personMemoryContext(root, base()), ""); assert.deepEqual(root, { groups: {} });
});
test("record returns synchronous result and required additive shape", () => {
  const root = { groups: {} }, result = record(root);
  assert.equal(result.then, undefined); assert.equal(result.ok, true); assert.equal(result.changed, true);
  assert.equal(result.revision, 1); assert.equal(result.personRevision, 1);
  assert.equal(root.peopleMemory.version, 1); assert.equal(person(root).entries.length, 1);
  assert.equal(query(root).entries[0].id, result.entryId);
});
test("optional control revision defaults to zero without read/intake materialization", () => {
  const root = seeded(), before = structuredClone(root);
  assert.equal(root.peopleMemory.bots[BOT].controlRevision ?? 0, 0);
  assert.equal(query(root).ok, true); assert.equal(control(root).ok, true);
  personMemoryContext(root, base()); assert.deepEqual(root, before);
  assert.equal(record(root, { messageId: "second-control-source", time: NOW / 1000 }).changed, true);
  assert.equal(Object.hasOwn(root.peopleMemory.bots[BOT], "controlRevision"), false);
});
test("only successful changed administration publishes one bot-wide control increment", () => {
  const root = seeded(), initial = root.peopleMemory;
  let expected = 0;
  function changed(operation, patch) {
    const oldRoot = root.peopleMemory, old = structuredClone(oldRoot), previousRevision = oldRoot.revision;
    const result = admin(root, operation, patch); assert.equal(result.ok, true); assert.equal(result.changed, true);
    assert.equal(root.peopleMemory.bots[BOT].controlRevision, ++expected);
    assert.equal(root.peopleMemory.revision, previousRevision + 1);
    assert.deepEqual(oldRoot, old, "old published root is not mutated");
    return result;
  }
  changed("freeze"); changed("unfreeze");
  const corrected = changed("correct", { entryId: person(root).entries[0].id, value: "偏好观察月相" });
  changed("revoke", { entryId: corrected.replacementEntryId });
  changed("delete", { entryId: corrected.replacementEntryId });
  changed("delete"); assert.equal(expected, 6);
  assert.equal(Object.hasOwn(initial.bots[BOT], "controlRevision"), false);
});
test("evidence including duplicate/failed intake never changes explicit control revision", () => {
  for (const value of [0, 7, Number.MAX_SAFE_INTEGER]) {
    const root = seeded(); root.peopleMemory.bots[BOT].controlRevision = value;
    assert.equal(record(root, { messageId: "new-control-source", time: NOW / 1000 }).changed, true);
    assert.equal(record(root, { messageId: "new-control-source", time: NOW / 1000 }).changed, false);
    unchanged(root, () => record(root, { verifiedSenderId: "87654321" }), "SENDER_MISMATCH");
    assert.equal(root.peopleMemory.bots[BOT].controlRevision, value);
  }
});
test("invalid present control revisions fail closed across all reads and writers", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined, true, {}]) {
    const root = seeded(); root.peopleMemory.bots[BOT].controlRevision = value;
    assert.equal(query(root).ok, false); assert.equal(query(root).status, "invalid");
    assert.equal(control(root).suppressesLegacy, true); assert.equal(personMemoryContext(root, base()), "");
    unchanged(root, () => record(root, { messageId: "bad-control" }), "INVALID_STATE");
    unchanged(root, () => admin(root, "freeze"), "INVALID_STATE");
  }
});
test("no-change administration does not increment or materialize control revision", () => {
  const root = seeded(), before = structuredClone(root);
  const identical = admin(root, "correct", { entryId: person(root).entries[0].id, value: person(root).entries[0].value });
  assert.equal(identical.ok, true); assert.equal(identical.changed, false); assert.equal(identical.reason, "NO_CHANGE");
  assert.deepEqual(root, before);
  for (const operation of ["freeze", "unfreeze"]) {
    assert.equal(admin(root, operation).changed, true);
    const old = structuredClone(root), result = admin(root, operation);
    assert.equal(result.ok, true); assert.equal(result.changed, false); assert.equal(result.reason, "NO_CHANGE");
    assert.deepEqual(root, old);
  }
  const entryId = person(root).entries[0].id; assert.equal(admin(root, "delete", { entryId }).changed, true);
  const old = structuredClone(root), result = admin(root, "delete", { entryId });
  assert.equal(result.reason, "NO_CHANGE"); assert.equal(result.changed, false); assert.deepEqual(root, old);
});
test("failed authorization/CAS/validation/capacity cannot advance control fence", () => {
  const root = seeded(); root.peopleMemory.bots[BOT].controlRevision = 8;
  for (const patch of [{ authorized: false }, { expectedRevision: 0 }, { now: -1 }, { entryId: "missing-id" }, { operation: "invalid" }]) {
    unchanged(root, () => admin(root, "revoke", patch));
  }
  unchanged(root, () => admin(root, "correct", { entryId: person(root).entries[0].id, value: "password=very-secret" }), "UNSAFE_VALUE");
  const bot = root.peopleMemory.bots[BOT];
  for (let i = 1; i < LIMITS.archivePerPerson; i++) {
    const id = person(root).entries[0].id;
    assert.equal(admin(root, "correct", { entryId: id, value: `合成星图档案 ${i}` }).ok, true);
  }
  assert.equal(admin(root, "correct", { entryId: person(root).entries[0].id, value: "合成星图档案最后一项" }).ok, true);
  unchanged(root, () => admin(root, "revoke", { entryId: person(root).entries[0].id }), "CAPACITY");
  assert.equal(bot.controlRevision, 8, "pre-publication bot is immutable");
});
test("control overflow refuses administration atomically, not otherwise valid evidence", () => {
  const root = seeded(); root.peopleMemory.bots[BOT].controlRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(record(root, { messageId: "last-control-evidence", time: NOW / 1000 }).changed, true);
  unchanged(root, () => admin(root, "freeze"), "REVISION_OVERFLOW");
  assert.equal(admin(root, "correct", { entryId: person(root).entries[0].id, value: person(root).entries[0].value }).reason, "NO_CHANGE");
  root.peopleMemory.bots[BOT].controlRevision--;
  assert.equal(admin(root, "freeze").changed, true);
  assert.equal(root.peopleMemory.bots[BOT].controlRevision, Number.MAX_SAFE_INTEGER);
  unchanged(root, () => admin(root, "unfreeze"), "REVISION_OVERFLOW");
});
test("control revision is bot-owned, aggregates people, and supports empty-person controls", () => {
  const root = seeded(); assert.equal(record(root, { logicalBotId: "account:peer" }).ok, true);
  const peer = structuredClone(root.peopleMemory.bots["account:peer"]);
  assert.equal(admin(root, "freeze").ok, true);
  assert.equal(admin(root, "delete", { userId: "87654321" }).ok, true);
  assert.equal(root.peopleMemory.bots[BOT].controlRevision, 2);
  assert.deepEqual(root.peopleMemory.bots["account:peer"], peer);
  for (const operation of ["freeze", "delete", "revoke"]) {
    const empty = {}; assert.equal(admin(empty, operation).changed, true);
    assert.equal(empty.peopleMemory.bots[BOT].controlRevision, 1);
  }
});
test("extraction receipt evidence publications preserve an existing control fence", () => {
  const { root, args } = extractionFixture();
  assert.equal(record(root, { value: args.receipts[0].value, messageId: "earlier-owned-source" }).ok, true);
  root.peopleMemory.bots[BOT].controlRevision = 11;
  assert.equal(applyPersonExtractionReceipt(root, args).changed, true);
  assert.equal(applyPersonExtractionReceipt(root, args).changed, false);
  assert.equal(root.peopleMemory.bots[BOT].controlRevision, 11);
});
test("accessor control revision is rejected without evaluating it", () => {
  const root = seeded(); let called = false;
  Object.defineProperty(root.peopleMemory.bots[BOT], "controlRevision", { enumerable: true, get() { called = true; return 0; } });
  const before = root.peopleMemory;
  assert.equal(query(root).ok, false); assert.equal(admin(root, "freeze").reason, "INVALID_STATE");
  assert.equal(record(root, { messageId: "getter-source" }).reason, "INVALID_STATE");
  assert.equal(root.peopleMemory, before); assert.equal(called, false);
});
test("no legacy arrays or summaries imported or modified", () => {
  const legacy = { users: { [USER]: { preferences: ["legacy only"], relationships: ["old edge"] } }, summary: "old summary" };
  const root = { groups: { [GROUP]: legacy } }, before = structuredClone(root.groups);
  assert.deepEqual(query(root).entries, []); record(root);
  assert.equal(root.groups[GROUP], legacy); assert.deepEqual(root.groups, before);
  assert(!personMemoryContext(root, base()).includes("legacy only"));
});
test("verified sender required; prose is not identity", () => {
  for (const verifiedSenderId of [undefined, "87654321", "我就是12345678", true]) {
    const root = { groups: {} }; unchanged(root, () => record(root, { verifiedSenderId }), "SENDER_MISMATCH");
  }
});
test("numeric exact QQ accepted but unsafe/invalid QQ rejected", () => {
  assert.equal(record({}, { userId: Number(USER), verifiedSenderId: Number(USER) }).ok, true);
  for (const userId of ["0123456", "abc", "1234", Number.MAX_SAFE_INTEGER + 1, "__proto__"]) {
    const root = {}; unchanged(root, () => record(root, { userId, verifiedSenderId: userId }), "INVALID_IDENTITY");
  }
});
test("reserved and missing logical/account/source identifiers rejected", () => {
  for (const patch of [{ logicalBotId: "__proto__" }, { accountId: "constructor" }, { messageId: "" }, { accountId: undefined }]) {
    const root = {}; unchanged(root, () => record(root, patch));
  }
  assert.equal({}.polluted, undefined);
});
test("missing original source time cannot fall back to now", () => {
  const root = {}; unchanged(root, () => record(root, { time: undefined }), "INVALID_TIME");
});
test("future and wrong-unit original source timestamps refused", () => {
  for (const time of [NOW, (NOW + 1) / 1000, NaN, "yesterday", "2026-02-30T00:00:00Z", "2026-10-27T00:00:00"]) {
    const root = {}; unchanged(root, () => record(root, { time }), "INVALID_TIME");
  }
});
test("zoned original timestamp retained exactly as event time", () => {
  const root = seeded({ time: "2026-10-27T20:00:00+08:00", now: "2026-10-28T12:00:00Z" });
  const entry = person(root).entries[0]; assert.equal(entry.firstSeenAt, NOW - DAY);
  assert.equal(entry.evidence[0].time, NOW - DAY); assert.equal(entry.lastConfirmedAt, NOW - DAY);
});
test("model/tool/quoted/textual authorization source kinds refused", () => {
  for (const sourceType of ["model", "tool", "quoted", "administrator", "authorized", undefined]) {
    const root = {}; unchanged(root, () => record(root, { sourceType }), "INVALID_SOURCE_TYPE");
  }
});
test("accepted archived self evidence still needs verified sender", () => {
  assert.equal(record({}, { sourceType: "archive" }).ok, true);
  const root = {}; unchanged(root, () => record(root, { sourceType: "archive", verifiedSenderId: undefined }), "SENDER_MISMATCH");
});
test("raw text and arbitrary source fields never enter state", () => {
  const root = seeded({ rawText: "RAW_BODY_SENTINEL", text: "RAW_BODY_SENTINEL", authorized: "admin", secrets: { token: "hidden" } });
  assert(!JSON.stringify(root).includes("RAW_BODY_SENTINEL")); assert(!JSON.stringify(root).includes("hidden"));
  assert.deepEqual(Object.keys(person(root).entries[0].evidence[0]).sort(), ["accountId", "confidence", "conversationId", "key", "messageId", "sourceType", "time"]);
});
test("shared privacy filter rejects phone/ID/card/password/address/URL credentials", () => {
  for (const value of ["电话13800138000", "证件 110101199003071234", "卡号 6222021234567890123",
    "password=abcd1234", "验证码123456", "住址：朝阳区幸福街道一号楼二单元",
    "https://example.test/?token=secret-value", "sk-abcdefghijklmnopqrstuvwx"]) {
    const root = {}; unchanged(root, () => record(root, { value }), "UNSAFE_VALUE");
  }
});
test("nested sensitive fields and unbounded values refused", () => {
  for (const value of [{ password: "abcd1234" }, ["text"], "a".repeat(LIMITS.valueChars + 1), "x\nraw", "[已过滤]"]) {
    const root = {}; unchanged(root, () => record(root, { value }), "UNSAFE_VALUE");
  }
});
test("out-of-range and string confidence rejected", () => {
  for (const confidence of [-1, 1.01, NaN, "0.9", undefined]) {
    const root = {}; unchanged(root, () => record(root, { confidence }), "INVALID_CONFIDENCE");
  }
});
test("low-confidence evidence is tentative, not prompt context", () => {
  const root = seeded({ confidence: 0.5 });
  assert.equal(person(root).entries[0].status, "tentative"); assert.deepEqual(query(root).entries, []);
});
test("high-confidence same-group fact available but not yet cross-group", () => {
  const root = seeded(); assert.equal(query(root).entries.length, 1);
  assert.deepEqual(query(root, { conversationId: "group:45678901" }).entries, []);
});
test("public stable fact with independent source dates crosses groups", () => {
  const root = { groups: {} }; stable(root);
  const result = query(root, { conversationId: "group:45678901" });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].scope, "public_stable");
  const projection = JSON.stringify(result.entries);
  assert(!projection.includes(GROUP)); assert(!projection.includes("carrier-a")); assert(!projection.includes("msg-1"));
});
test("same-day repetitions do not establish cross-group stable evidence", () => {
  const root = seeded({ time: (NOW - 1000) / 1000 });
  record(root, { messageId: "msg-2", time: NOW / 1000 });
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("only stable_fact may cross groups, never preference/boundary/alias/episode", () => {
  for (const kind of ["preference", "boundary", "alias", "episode"]) {
    const root = {}; stable(root, { kind });
    assert.equal(query(root).entries.length, 1);
    assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
  }
});
test("conversation privacy forbids cross-group even for stable facts", () => {
  const root = {}; stable(root, { privacy: "conversation" });
  assert.deepEqual(query(root, { conversationId: "group:45678901" }).entries, []);
});
test("private memory never reaches any group or another private subject", () => {
  const root = {}, conversationId = `private:${USER}`;
  stable(root, { conversationId, privacy: "private" });
  assert.equal(query(root, { conversationId }).entries.length, 1);
  assert.equal(query(root).entries.length, 0);
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
  assert.equal(query(root, { conversationId: "private:87654321" }).ok, false);
  assert.equal(personMemoryContext(root, base()), "");
});
test("private and public identical values keep distinct receipts", () => {
  const root = seeded({ conversationId: `private:${USER}`, privacy: "private" });
  record(root, { messageId: "group-msg", time: NOW / 1000 });
  assert.equal(person(root).entries.length, 2);
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("private label cannot be downgraded and private source must match subject", () => {
  for (const patch of [{ conversationId: `private:${USER}`, privacy: "public" },
    { conversationId: "private:87654321", privacy: "private" }, { privacy: "private" }, { privacy: undefined }]) {
    const root = {}; unchanged(root, () => record(root, patch));
  }
});
test("public group memory not implicitly copied into private context", () => {
  const root = {}; stable(root);
  assert.equal(query(root, { conversationId: `private:${USER}` }).entries.length, 0);
});
test("logical bots isolate people even on same physical group", () => {
  const root = {}; stable(root);
  assert.equal(query(root, { logicalBotId: "account:other" }).status, "missing");
  record(root, { logicalBotId: "account:other", value: "另一人格的局部事实" });
  assert.equal(query(root, { logicalBotId: "account:other" }).entries[0].value, "另一人格的局部事实");
  assert.equal(query(root).entries[0].value, "喜欢研究星图");
});
test("different people never share same-name or same-value evidence", () => {
  const root = {}; stable(root);
  assert.equal(query(root, { userId: "87654321" }).entries.length, 0);
  record(root, { userId: "87654321", verifiedSenderId: "87654321" });
  assert.equal(query(root, { userId: "87654321", conversationId: "group:45678901" }).entries.length, 0);
});
test("explicit logical failover carriers share one person but not duplicate confirmations", () => {
  const root = seeded({ logicalBotId: "group:failover" });
  const before = structuredClone(root), duplicate = record(root, { logicalBotId: "group:failover", accountId: "carrier-b" });
  assert.equal(duplicate.reason, "DUPLICATE"); assert.deepEqual(root, before);
  assert.equal(query(root, { logicalBotId: "group:failover", conversationId: "group:45678901" }).entries.length, 0);
});
test("same source ID with changed original timestamp refused", () => {
  const root = seeded(); unchanged(root, () => record(root, { time: NOW / 1000 }), "SOURCE_CONFLICT");
});
test("original source time cannot disagree across different claims", () => {
  const root = seeded(); unchanged(root, () => record(root, { value: "另一条断言", time: NOW / 1000 }), "SOURCE_CONFLICT");
});
test("relationship stays a typed self-reported scoped edge, not target facts", () => {
  const root = seeded({ kind: "relationship", value: { targetUserId: "87654321", relation: "共同研究天文" } });
  const result = query(root); assert.equal(result.entries[0].kind, "relationship");
  assert.deepEqual(result.entries[0].value, { targetUserId: "87654321", relation: "共同研究天文" });
  assert.equal(query(root, { userId: "87654321" }).status, "missing");
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("relationships reject flattening/self-edge/sensitive extra fields", () => {
  for (const value of ["某某是朋友", { targetUserId: USER, relation: "自己" },
    { targetUserId: "87654321", relation: "朋友", token: "secret" },
    { targetUserId: "87654321", relation: "密码abcd1234" }]) {
    const root = {}; unchanged(root, () => record(root, { kind: "relationship", value }), "UNSAFE_VALUE");
  }
});
test("TTL hides expired facts without destructive cleanup or read writes", () => {
  const root = seeded({ kind: "episode" }), before = structuredClone(root);
  assert.equal(query(root, { now: NOW + 7 * DAY }).entries.length, 0);
  assert.deepEqual(root, before); assert.equal(person(root).entries.length, 1);
});
test("ancient archive ingestion is refused rather than stamped as new", () => {
  const root = {}; unchanged(root, () => record(root, { sourceType: "archive", time: (NOW - 181 * DAY) / 1000 }), "EXPIRED_SOURCE");
});
test("replayed old source cannot refresh expiry or confidence", () => {
  const root = seeded(), before = structuredClone(root);
  assert.equal(record(root, { now: NOW + DAY, confidence: 1 }).reason, "DUPLICATE");
  assert.deepEqual(root, before);
});
test("out-of-order original evidence does not advance lastConfirmedAt", () => {
  const root = seeded({ time: NOW / 1000 });
  record(root, { messageId: "old-msg", time: (NOW - 2 * DAY) / 1000 });
  const entry = person(root).entries[0]; assert.equal(entry.lastConfirmedAt, NOW); assert.equal(entry.firstSeenAt, NOW - 2 * DAY);
});
test("admin authorization is literal trusted boolean plus authenticated actor", () => {
  const root = seeded();
  for (const patch of [{ authorized: "true" }, { authorized: false }, { authorized: undefined }, { actorUserId: "admin" }]) {
    unchanged(root, () => admin(root, "delete", patch), "UNAUTHORIZED");
  }
});
test("admin requires exact global revision, not person revision/string", () => {
  const root = seeded(); record(root, { userId: "87654321", verifiedSenderId: "87654321" });
  for (const expectedRevision of [0, 1, "2", undefined, NaN]) {
    unchanged(root, () => admin(root, "freeze", { expectedRevision }), "CAS_MISMATCH");
  }
  assert.equal(admin(root, "freeze", { expectedRevision: 2 }).ok, true);
});
test("freeze blocks reads, context, intake and legacy fallback; unfreeze restores only active", () => {
  const root = seeded(); assert.equal(admin(root, "freeze").ok, true);
  assert.equal(control(root).frozen, true); assert.equal(control(root).suppressesLegacy, true);
  assert.equal(query(root).status, "frozen"); assert.equal(query(root).entries.length, 0);
  assert.equal(personMemoryContext(root, base()), "");
  unchanged(root, () => record(root), "FROZEN");
  assert.equal(admin(root, "unfreeze").ok, true); assert.equal(query(root).entries.length, 1);
});
test("freeze absent subject prevents queued old evidence intake", () => {
  const root = {}; assert.equal(admin(root, "freeze").ok, true); unchanged(root, () => record(root), "FROZEN");
});
test("freeze no-op does not change revision", () => {
  const root = seeded(); admin(root, "freeze"); const before = structuredClone(root);
  assert.equal(admin(root, "freeze").changed, false); assert.deepEqual(root, before);
});
test("entry correction archives terminal original and creates admin-only replacement", () => {
  const root = seeded(), id = query(root).entries[0].id;
  const updated = admin(root, "correct", { entryId: id, value: "改为研究月球地形" });
  assert.equal(updated.ok, true); assert.notEqual(updated.replacementEntryId, id);
  assert.equal(person(root).archive[0].id, id); assert.equal(person(root).archive[0].status, "superseded");
  assert.equal(query(root).entries[0].provenance, "administrator"); assert.equal(control(root).suppressesLegacy, true);
  assert.equal(person(root).entries[0].evidence.length, 0); assert.equal(person(root).entries[0].firstSeenAt, null);
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("correction rejects fuzzy/unknown entry IDs and invalid operations", () => {
  const root = seeded();
  unchanged(root, () => admin(root, "correct", { entryId: "喜欢研究星图", value: "新事实" }));
  unchanged(root, () => admin(root, "correct", { value: "新事实" }), "INVALID_ENTRY_ID");
  unchanged(root, () => admin(root, "reset"), "INVALID_OPERATION");
});
test("correction cannot introduce sensitive data or restore terminal value", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  unchanged(root, () => admin(root, "correct", { entryId, value: "token=secret123" }), "UNSAFE_VALUE");
  const fixed = admin(root, "correct", { entryId, value: "现在研究月球" });
  unchanged(root, () => admin(root, "correct", { entryId: fixed.replacementEntryId, value: "喜欢研究星图" }), "TOMBSTONED");
});
test("post-correction old source cannot activate replacement or paraphrased old value", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  admin(root, "correct", { entryId, value: "现在研究月球" });
  unchanged(root, () => record(root, { value: "现在研究月球" }), "TOMBSTONED_SOURCE");
  unchanged(root, () => record(root, { value: "原来那条的改写", messageId: "old-batch" }), "OLD_SOURCE");
});
test("fresh own evidence after correction allowed without resurrecting old fact", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  admin(root, "correct", { entryId, value: "现在研究月球" });
  assert.equal(record(root, { value: "现在研究月球", messageId: "new", time: (NOW + DAY) / 1000, now: NOW + DAY }).ok, true);
  unchanged(root, () => record(root, { time: (NOW + DAY) / 1000, now: NOW + DAY, messageId: "new-old-value" }), "TOMBSTONED");
});
test("admin confidence cannot turn low-confidence later evidence into cross-group self evidence", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  admin(root, "correct", { entryId, value: "现在研究月球" });
  for (let i = 1; i <= 2; i++) assert.equal(record(root, { value: "现在研究月球", messageId: `low-${i}`,
    time: (NOW + i * DAY) / 1000, now: NOW + i * DAY, confidence: 0.2 }).ok, true);
  assert.equal(query(root, { conversationId: "group:45678901", now: NOW + 2 * DAY }).entries.length, 0);
});
test("entry delete scrubs value, suppresses legacy, permanently blocks same fact across groups", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  assert.equal(admin(root, "delete", { entryId }).ok, true);
  assert.equal(query(root).entries.length, 0); assert.equal(control(root).suppressesLegacy, true);
  assert(control(root).suppressedEntryIds.includes(entryId)); assert(!JSON.stringify(root).includes("喜欢研究星图"));
  unchanged(root, () => record(root, { conversationId: "group:45678901", messageId: "fresh", time: (NOW + DAY) / 1000, now: NOW + DAY }), "TOMBSTONED");
});
test("whole-person delete blocks resurrection and unfreeze indefinitely", () => {
  const root = seeded(); admin(root, "delete");
  assert.equal(control(root).deleted, true); assert.equal(query(root).status, "deleted");
  assert.equal(control(root).suppressesLegacy, true); assert.equal(person(root).archive.length, 0);
  unchanged(root, () => record(root, { value: "新值", messageId: "new", now: NOW + 1000 * DAY, time: (NOW + 1000 * DAY) / 1000 }), "DELETED");
  unchanged(root, () => admin(root, "unfreeze"), "TERMINAL");
});
test("tombstone suppresses already-recorded same-value copies in other groups", () => {
  const root = seeded(), entryId = query(root).entries[0].id;
  record(root, { conversationId: "group:45678901" });
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 1);
  admin(root, "delete", { entryId });
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("entry tombstone alone still suppresses legacy if person record omitted", () => {
  const root = seeded(); admin(root, "delete", { entryId: query(root).entries[0].id });
  delete root.peopleMemory.bots[BOT].people[USER];
  assert.equal(control(root).suppressesLegacy, true); assert.equal(query(root).suppressesLegacy, true);
});
test("delete absent person writes durable negative marker, not an ephemeral empty query", () => {
  const root = {}; assert.equal(admin(root, "delete").ok, true); assert.equal(control(root).deleted, true);
  unchanged(root, () => record(root), "DELETED");
});
test("person tombstone still protects if person record omitted from a snapshot", () => {
  const root = seeded(); admin(root, "delete"); delete root.peopleMemory.bots[BOT].people[USER];
  assert.equal(query(root).status, "deleted"); assert.equal(control(root).suppressesLegacy, true);
  unchanged(root, () => record(root), "DELETED");
});
test("revocation irreversible; delete may subsequently scrub revoked history", () => {
  const root = seeded(); admin(root, "revoke");
  assert.equal(query(root).status, "revoked"); unchanged(root, () => admin(root, "unfreeze"), "TERMINAL");
  unchanged(root, () => record(root), "REVOKED");
  assert.equal(admin(root, "delete").ok, true); assert(!JSON.stringify(root).includes("喜欢研究星图"));
});
test("entry revoke retains only internal terminal history, never query context", () => {
  const root = seeded(), entryId = query(root).entries[0].id; admin(root, "revoke", { entryId });
  assert.equal(query(root).entries.length, 0); assert.equal(personMemoryContext(root, base()), "");
  assert.equal(person(root).archive[0].status, "revoked"); unchanged(root, () => record(root), "TOMBSTONED");
});
test("entry delete may scrub archived revoked original by exact ID", () => {
  const root = seeded(), entryId = query(root).entries[0].id; admin(root, "revoke", { entryId });
  assert.equal(admin(root, "delete", { entryId }).ok, true);
  assert(!JSON.stringify(root).includes("喜欢研究星图")); assert.equal(admin(root, "delete", { entryId }).changed, false);
});
test("delete replacement scrubs the complete bounded correction lineage", () => {
  const root = seeded();
  for (let i = 0; i < 4; i++) admin(root, "correct", { entryId: person(root).entries[0].id, value: `更正链${i}` });
  assert.equal(admin(root, "delete", { entryId: person(root).entries[0].id }).ok, true);
  assert(!JSON.stringify(root).includes("喜欢研究星图")); assert(!JSON.stringify(root).includes("更正链"));
});
test("kind reclassification cannot resurrect exact deleted fact", () => {
  const root = seeded(), entryId = query(root).entries[0].id; admin(root, "delete", { entryId });
  unchanged(root, () => record(root, { kind: "preference", privacy: "conversation", messageId: "new-type",
    time: (NOW + DAY) / 1000, now: NOW + DAY }), "TOMBSTONED");
});
test("bot/person deletion does not suppress peers", () => {
  const root = seeded(); record(root, { logicalBotId: "account:peer" });
  record(root, { userId: "87654321", verifiedSenderId: "87654321" }); admin(root, "delete");
  assert.equal(query(root, { logicalBotId: "account:peer" }).entries.length, 1);
  assert.equal(query(root, { userId: "87654321" }).entries.length, 1);
});
test("admin cannot move time backwards or alter privacy via correction", () => {
  const root = seeded(); unchanged(root, () => admin(root, "delete", { now: NOW - 1 }), "INVALID_TIME");
  const privateRoot = seeded({ conversationId: `private:${USER}`, privacy: "private" });
  const entryId = person(privateRoot).entries[0].id;
  admin(privateRoot, "correct", { entryId, value: "私聊的更正", privacy: "public", conversationId: GROUP });
  assert.equal(query(privateRoot).entries.length, 0); assert.equal(person(privateRoot).entries[0].privacy, "private");
});
test("evidence cap refuses overflow, duplicate remains idempotent, active evidence retained", () => {
  const root = {};
  for (let i = 0; i < LIMITS.evidencePerEntry; i++) assert.equal(record(root, { messageId: `m-${i}` }).ok, true);
  const before = structuredClone(root);
  unchanged(root, () => record(root, { messageId: "overflow" }), "EVIDENCE_CAPACITY");
  assert.equal(record(root, { messageId: "m-0" }).reason, "DUPLICATE"); assert.deepEqual(root, before);
});
test("active-entry capacity refuses rather than FIFO dropping facts", () => {
  const root = {};
  for (let i = 0; i < LIMITS.entriesPerPerson; i++) assert.equal(record(root, { value: `事实第${i}项` }).ok, true);
  unchanged(root, () => record(root, { value: "溢出事实" }), "CAPACITY");
  assert.equal(person(root).entries[0].value, "事实第0项");
});
test("terminal archive bounded and refuses next correction atomically", () => {
  const root = seeded();
  for (let i = 0; i < LIMITS.archivePerPerson; i++) {
    assert.equal(admin(root, "correct", { entryId: person(root).entries[0].id, value: `更正第${i}版` }).ok, true);
  }
  unchanged(root, () => admin(root, "correct", { entryId: person(root).entries[0].id, value: "溢出更正" }), "CAPACITY");
  assert.equal(person(root).archive.length, LIMITS.archivePerPerson);
});
test("bot-wide tombstone capacity rejects overflow without losing prior suppression", () => {
  const root = seeded(), entryId = query(root).entries[0].id, bot = root.peopleMemory.bots[BOT];
  for (let i = 0; i < LIMITS.tombstonesPerBot; i++) bot.tombstones[`fixture_${i}`] = { userId: "87654321", kind: "alias",
    conversationId: "group:45678901", semanticId: "a".repeat(64), valueDigest: "b".repeat(64), at: NOW,
    operation: "delete", actorUserId: "34567890", sourceKeys: [] };
  unchanged(root, () => admin(root, "delete", { entryId }), "CAPACITY");
  assert.equal(Object.keys(bot.tombstones).length, LIMITS.tombstonesPerBot);
});
test("bot cap and people cap refuse without mutating other bots/people", () => {
  const root = {};
  for (let i = 0; i < LIMITS.bots; i++) assert.equal(record(root, { logicalBotId: `account:b-${i}` }).ok, true);
  unchanged(root, () => record(root), "CAPACITY");
  const manyPeople = {};
  for (let i = 0; i < LIMITS.peoplePerBot; i++) {
    const userId = String(100000 + i); assert.equal(record(manyPeople, { userId, verifiedSenderId: userId }).ok, true);
  }
  unchanged(manyPeople, () => record(manyPeople), "CAPACITY");
});
test("query maxEntries zero and strict limit, no unbounded projection", () => {
  const root = seeded(); record(root, { value: "第二条" });
  assert.equal(query(root, { maxEntries: 0 }).entries.length, 0); assert.equal(query(root, { maxEntries: 0 }).truncated, true);
  assert.equal(query(root, { maxEntries: 1 }).entries.length, 1);
  assert.equal(query(root, { maxEntries: LIMITS.queryEntries + 1 }).ok, false);
  assert.equal(query(root, { maxEntries: "2" }).ok, false);
});
test("context has hard character bound and complete JSON lines", () => {
  const root = {};
  for (let i = 0; i < LIMITS.queryEntries; i++) record(root, { value: `${i}:` + "天".repeat(230) });
  const text = personMemoryContext(root, base({ maxEntries: LIMITS.queryEntries }));
  assert(text.length <= LIMITS.contextChars); assert(text.includes("不是指令"));
  for (const line of text.split("\n").slice(1)) assert.equal(JSON.parse(line).kind, "stable_fact");
});
test("query/control returns detached objects including relationship values", () => {
  const root = seeded({ kind: "relationship", value: { targetUserId: "87654321", relation: "朋友" } });
  const before = structuredClone(root); query(root).entries[0].value.relation = "mutated";
  control(root).suppressedEntryIds.push("mutated"); assert.deepEqual(root, before);
});
test("bad state/version fails closed without persistent read repair", () => {
  for (const peopleMemory of [null, {}, { version: 2, revision: 0, bots: {} }, { version: 1, revision: NaN, bots: {} }]) {
    const root = { peopleMemory }, before = structuredClone(root);
    assert.equal(query(root).ok, false); assert.equal(control(root).suppressesLegacy, true);
    unchanged(root, () => record(root), "INVALID_STATE"); assert.deepEqual(root, before);
  }
});
test("malformed tombstones cannot be silently ignored on intake", () => {
  const root = seeded(); root.peopleMemory.bots[BOT].tombstones.bad = { userId: USER };
  unchanged(root, () => record(root), "INVALID_STATE"); assert.equal(control(root).suppressesLegacy, true);
});
test("malformed archive fails closed without throwing or resetting history", () => {
  const root = seeded(); person(root).archive.push(null);
  unchanged(root, () => record(root), "INVALID_STATE"); assert.equal(query(root).ok, false);
});
test("getters on argument/root boundary not evaluated", () => {
  let called = false; const args = base();
  Object.defineProperty(args, "verifiedSenderId", { get() { called = true; return USER; }, enumerable: true });
  assert.equal(recordPersonEvidence({}, args).ok, false);
  const root = {}; Object.defineProperty(root, "peopleMemory", { get() { called = true; return {}; } });
  assert.equal(query(root).ok, false); assert.equal(called, false);
});
test("global revision overflow refuses rather than unsafe CAS increment", () => {
  const root = seeded(); root.peopleMemory.revision = Number.MAX_SAFE_INTEGER;
  unchanged(root, () => record(root, { messageId: "overflow" }), "REVISION_OVERFLOW");
});
test("receipt adapter consumes actual accepted extraction, without changing canonical/legacy/index", () => {
  const { root, args } = extractionFixture(), before = structuredClone(root.groups);
  const applied = applyPersonExtractionReceipt(root, args);
  assert.equal(applied.ok, true); assert.equal(applied.changed, true); assert.equal(applied.applied.length, 1);
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 1);
  assert.equal(query(root).entries[0].kind, "stable_fact"); assert.deepEqual(root.groups, before);
  assert.equal(person(root).entries[0].firstSeenAt, NOW - DAY);
  assert.equal(person(root).entries[0].lastConfirmedAt, NOW);
});
test("receipt adapter handles shared-message jobs for multiple independently owned bots", () => {
  const { root, args } = extractionFixture({ bots: [BOT, "account:peer"] });
  const applied = applyPersonExtractionReceipt(root, args); assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.map(item => item.logicalBotId).sort(), [BOT, "account:peer"].sort());
  assert.equal(query(root, { logicalBotId: "account:peer", conversationId: "group:45678901" }).entries.length, 1);
  assert.equal(person(root).entries[0].evidence.length, 2);
});
test("receipt exact raw numeric job key maps only its matching group transport scope", () => {
  const { root, args } = extractionFixture({ conversationId: "23456789" });
  assert.equal(applyPersonExtractionReceipt(root, args).ok, true);
  assert.equal(query(root).entries.length, 1); assert.equal(person(root).entries[0].conversationId, GROUP);
});
test("receipt typed relationship remains distinct/local; legacy string edges are not guessed", () => {
  const { root, args, canonical } = extractionFixture({ kind: "relationship", value: "与87654321研究天文" });
  assert.equal(applyPersonExtractionReceipt(root, args).changed, false);
  const value = { targetUserId: "87654321", relation: "共同研究天文" };
  canonical.value = structuredClone(value); args.receipts[0].value = structuredClone(value);
  assert.equal(applyPersonExtractionReceipt(root, args).ok, true);
  assert.equal(query(root).entries[0].kind, "relationship"); assert.deepEqual(query(root).entries[0].value, value);
  assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
});
test("receipt per-call writes cap is checked before publishing any bot", () => {
  const { root, args } = extractionFixture({ bots: [BOT, "account:peer"] });
  args.receipts = Array(LIMITS.extractionReceipts).fill(args.receipts[0]);
  const before = structuredClone(root), result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.reason, "EXTRACTION_CAPACITY"); assert.deepEqual(root, before);
});
test("receipt replay stays idempotent and returns no values/raw bodies", () => {
  const { root, args } = extractionFixture(); applyPersonExtractionReceipt(root, args);
  const before = structuredClone(root), result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.ok, true); assert.equal(result.changed, false); assert.deepEqual(root, before);
  assert(!JSON.stringify(result).includes("喜欢研究星图"));
});
test("receipt cannot fill missing exact IDs from the canonical entry", () => {
  const { root, args, group } = extractionFixture(); delete group.peopleSourceIndex["msg-2"];
  const before = structuredClone(root), result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.ok, false); assert.equal(result.changed, false); assert.deepEqual(root, before);
});
test("receipt bot must own all assertion sources rather than borrowing another bot", () => {
  const { root, args, group } = extractionFixture({ bots: [BOT, "account:peer"] });
  delete group.peopleSourceIndex["msg-2"][BOT]; const result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.applied.length, 1); assert.equal(result.applied[0].logicalBotId, "account:peer");
  assert.equal(query(root).status, "missing");
});
test("receipt rejects sender mismatch/time mismatch and exact conversation mismatch", () => {
  for (const modify of [fixture => { fixture.group.peopleSourceIndex["msg-1"][BOT].verifiedSenderId = "87654321"; },
    fixture => { fixture.group.peopleSourceIndex["msg-2"][BOT].time -= 1; },
    fixture => { fixture.group.peopleSourceIndex["msg-1"][BOT].conversationId = "group:45678901"; }]) {
    const fixture = extractionFixture(); modify(fixture); const before = structuredClone(fixture.root);
    const result = applyPersonExtractionReceipt(fixture.root, fixture.args);
    assert.equal(result.ok, false); assert.equal(result.changed, false); assert.deepEqual(fixture.root, before);
  }
});
test("receipt does not promote tentative canonical, regardless of receipt privacy/confidence hints", () => {
  const { root, args } = extractionFixture({ times: [NOW] });
  Object.assign(args.receipts[0], { privacy: "public", confidence: 1, authorized: true });
  assert.equal(applyPersonExtractionReceipt(root, args).ok, true);
  assert.equal(person(root).entries[0].privacy, "conversation"); assert.equal(person(root).entries[0].status, "tentative");
  assert.equal(query(root).entries.length, 0);
});
test("active low-confidence and administrator-backed canonical remain conversation-local", () => {
  for (const patch of [{ status: "active", confidence: 0.7 }, { source: "explicit" }, { correctedAt: "2026-10-27T12:00:00Z" }]) {
    const { root, args, canonical } = extractionFixture(); Object.assign(canonical, patch);
    assert.equal(applyPersonExtractionReceipt(root, args).ok, true);
    assert.equal(query(root).entries.length, 1); assert.equal(person(root).entries[0].privacy, "conversation");
    assert.equal(query(root, { conversationId: "group:45678901" }).entries.length, 0);
  }
});
test("receipt private canonical never upgrades into public stable memory", () => {
  const conversationId = `private:${USER}`, { root, args } = extractionFixture({ conversationId });
  assert.equal(applyPersonExtractionReceipt(root, args).ok, true);
  assert.equal(query(root, { conversationId }).entries.length, 1);
  assert.equal(query(root).entries.length, 0); assert.equal(person(root).entries[0].privacy, "private");
});
test("scoped independent private job preserves exact keys and normalized ISO event provenance", () => {
  const conversationId = `private:${USER}:fixture`, { root, args, group } = extractionFixture({ conversationId,
    accountIds: { [BOT]: "fixture" }, isoSourceTimes: true });
  const before = structuredClone(root.groups), result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.ok, true); assert.equal(result.applied[0].logicalBotId, BOT);
  assert.equal(query(root, { conversationId: `private:${USER}` }).entries.length, 1);
  assert.equal(query(root).entries.length, 0); assert.deepEqual(root.groups, before);
  assert.equal(root.groups[`private:${USER}`], undefined);
  assert.equal(person(root).entries[0].conversationId, `private:${USER}`);
  assert.equal(person(root).entries[0].evidence[0].time, NOW - DAY);
  assert(group.users[USER].canonicalMemory.entries[0].evidenceKeys.includes(JSON.stringify([conversationId, "msg-1"])));
});
test("scoped failover private job uses identifier group suffix, not a QQ, with independently verified carriers", () => {
  const logicalBotId = "group:Pair_A-33", conversationId = `private:${USER}:group:Pair_A-33`;
  const { root, args, group } = extractionFixture({ conversationId, bots: [logicalBotId],
    accountIds: { [logicalBotId]: "alpha" }, isoSourceTimes: true });
  group.peopleSourceIndex["msg-2"][logicalBotId].accountId = "beta";
  const before = structuredClone(root.groups), result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.ok, true); assert.equal(result.applied.length, 1);
  assert.equal(query(root, { logicalBotId, conversationId: `private:${USER}` }).entries.length, 1);
  assert.equal(query(root, { logicalBotId }).entries.length, 0);
  assert.equal(query(root).status, "missing"); assert.deepEqual(root.groups, before);
  const entry = root.peopleMemory.bots[logicalBotId].people[USER].entries[0];
  assert.deepEqual(entry.evidence.map(source => source.accountId), ["alpha", "beta"]);
});
test("independent private suffix must match logical owner AND physical account", () => {
  for (const patch of [{ bots: ["account:peer"], accountIds: { "account:peer": "fixture" } },
    { bots: [BOT], accountIds: { [BOT]: "peer" } }, { bots: ["group:fixture"], accountIds: { "group:fixture": "fixture" } }]) {
    const { root, args } = extractionFixture({ conversationId: `private:${USER}:fixture`, ...patch });
    const before = structuredClone(root), result = applyPersonExtractionReceipt(root, args);
    assert.equal(result.ok, false); assert.equal(result.rejected[0].reason, "SOURCE_OWNER_MISMATCH"); assert.deepEqual(root, before);
  }
});
test("failover private suffix must match group owner, not a carrier or another group", () => {
  for (const logicalBotId of ["group:Other_33", "account:Pair_A-33", "account:alpha"]) {
    const { root, args } = extractionFixture({ conversationId: `private:${USER}:group:Pair_A-33`, bots: [logicalBotId],
      accountIds: { [logicalBotId]: "alpha" } });
    const before = structuredClone(root), result = applyPersonExtractionReceipt(root, args);
    assert.equal(result.ok, false); assert.equal(result.rejected[0].reason, "SOURCE_OWNER_MISMATCH"); assert.deepEqual(root, before);
  }
});
test("private scoped context/canonical keys cannot be silently normalized or borrowed", () => {
  for (const modify of [fixture => { fixture.args.receipts[0].context.conversationId = `private:${USER}`; },
    fixture => { fixture.canonical.evidenceKeys = ["msg-1", "msg-2"].map(id => JSON.stringify([`private:${USER}`, id])); },
    fixture => { fixture.group.peopleSourceIndex["msg-1"][BOT].conversationId = `private:${USER}:fixture`; },
    fixture => { fixture.group.peopleSourceIndex["msg-1"][BOT].verifiedSenderId = "87654321"; }]) {
    const fixture = extractionFixture({ conversationId: `private:${USER}:fixture`, accountIds: { [BOT]: "fixture" } });
    modify(fixture); const before = structuredClone(fixture.root);
    assert.equal(applyPersonExtractionReceipt(fixture.root, fixture.args).ok, false); assert.deepEqual(fixture.root, before);
  }
});
test("malformed and reserved private suffixes fail closed without lookup fallback", () => {
  for (const suffix of [":fixture:extra", ":group:", ":group:Pair:extra", ":group:31001", ":constructor", ":group:toString", ":../fixture"]) {
    const { root, args } = extractionFixture({ conversationId: `private:${USER}`, isoSourceTimes: true });
    args.conversationId += suffix; const before = structuredClone(root);
    assert.equal(applyPersonExtractionReceipt(root, args).reason, "INVALID_EXTRACTION"); assert.deepEqual(root, before);
  }
});
for (const [owner, scoped] of [[BOT, `private:${USER}:fixture`], ["group:Pair_A-33", `private:${USER}:group:Pair_A-33`]]) {
  test(`actual compactSelectedMemory uses conversation subject, not mapped user (${owner})`, () => {
    const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
    const start = source.indexOf("function compactSelectedMemory("), end = source.indexOf("\nfunction buildContextBundle(", start);
    assert(start >= 0 && end > start, "execute real bridge function without booting bridge");
    const root = {}, other = "87654321";
    for (const [userId, value] of [[USER, "OWN_PRIVATE_FIXTURE"], [other, "OTHER_PRIVATE_MUST_NOT_LEAK"]]) {
      assert.equal(record(root, { logicalBotId: owner, userId, verifiedSenderId: userId,
        conversationId: `private:${userId}`, privacy: "private", value }).ok, true);
    }
    const observed = [], sandbox = vm.createContext({
      Date: class extends Date { static now() { return NOW; } },
      logicalBotId: config => config.owner,
      personMemoryContext: (memory, options) => { const args = structuredClone(options); observed.push(args); return personMemoryContext(memory, args); }
    });
    new vm.Script(source.slice(start, end)).runInContext(sandbox);
    const before = structuredClone(root);
    const text = sandbox.compactSelectedMemory({}, [USER, other], { owner, memory: { people: { enabled: true } } }, "", root, scoped);
    assert(text.includes("OWN_PRIVATE_FIXTURE")); assert(!text.includes("OTHER_PRIVATE_MUST_NOT_LEAK"));
    assert.deepEqual(observed.map(args => args.conversationId), [`private:${USER}`, `private:${USER}`]);
    assert.deepEqual(root, before);
  });
}
test("receipt can only whitelist stable canonical traits, not summary/meme/personality/raw arrays", () => {
  const { root, args, group } = extractionFixture();
  for (const receipt of [{ ...args.receipts[0], type: "summary" }, { ...args.receipts[0], kind: "personality" },
    { ...args.receipts[0], kind: "meme" }, { value: "legacy only" }]) {
    const before = structuredClone(root);
    assert.equal(applyPersonExtractionReceipt(root, { ...args, receipts: [receipt] }).changed, false); assert.deepEqual(root, before);
  }
  group.users[USER].preferences.push("legacy only"); assert.equal(query(root).status, "missing");
});
test("receipt exact canonical value/subject/status/evidence membership required", () => {
  for (const modify of [fixture => { fixture.canonical.subjectUserId = "87654321"; },
    fixture => { fixture.canonical.status = "superseded"; }, fixture => { fixture.canonical.sourceMessageIds = ["msg-1"]; },
    fixture => { fixture.args.receipts[0].value = "模型伪造新事实"; }, fixture => { fixture.canonical.evidenceKeys = []; }]) {
    const fixture = extractionFixture(); modify(fixture); const before = structuredClone(fixture.root);
    assert.equal(applyPersonExtractionReceipt(fixture.root, fixture.args).ok, false); assert.deepEqual(fixture.root, before);
  }
});
test("receipt source failure after first event rolls back that entire receipt/bot", () => {
  const { root, args } = extractionFixture({ times: [NOW, NOW - 181 * DAY] }), before = structuredClone(root);
  const result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.ok, false); assert.equal(result.changed, false); assert.deepEqual(root, before);
});
test("receipt rollback with existing peopleMemory does not mutate shared prior subtrees", () => {
  const { root, args } = extractionFixture({ times: [NOW, NOW - 181 * DAY] });
  record(root, { value: "保留的已有事实", messageId: "existing" });
  const retained = root.peopleMemory, before = structuredClone(retained);
  const result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.changed, false); assert.equal(root.peopleMemory, retained); assert.deepEqual(retained, before);
});
test("receipt honors current freeze/delete without affecting eligible peer bots", () => {
  const { root, args } = extractionFixture({ bots: [BOT, "account:peer"] });
  admin(root, "delete"); const result = applyPersonExtractionReceipt(root, args);
  assert.equal(result.applied.length, 1); assert.equal(result.applied[0].logicalBotId, "account:peer");
  assert.equal(control(root).deleted, true); assert.equal(query(root).entries.length, 0);
});
test("receipt requires source IDs exactly, never empty/substituted/duplicated IDs", () => {
  for (const sourceMessageIds of [[], ["msg-1", "msg-1"], ["msg-unknown"], undefined]) {
    const { root, args } = extractionFixture(); args.receipts[0].context.sourceMessageIds = sourceMessageIds;
    const before = structuredClone(root); assert.equal(applyPersonExtractionReceipt(root, args).changed, false);
    assert.deepEqual(root, before);
  }
});
test("receipt over-limit refuses without loss or partial application", () => {
  const { root, args } = extractionFixture(); args.receipts = Array(LIMITS.extractionReceipts + 1).fill(args.receipts[0]);
  const before = structuredClone(root); assert.equal(applyPersonExtractionReceipt(root, args).changed, false);
  assert.deepEqual(root, before);
});
test("latest-root queued MemoryRuntime builders preserve both people", async () => {
  let durable = { groups: {} }, rev = 0;
  const repository = { open: async () => ({ value: structuredClone(durable), revision: rev }),
    status: () => ({}), close: async () => {}, commit: async draft => {
      durable = structuredClone(draft); return { value: structuredClone(durable), revision: ++rev };
    } };
  const runtime = new MemoryRuntime(repository); await runtime.open();
  try {
    const first = runtime.transact(draft => record(draft));
    const second = runtime.transact(draft => record(draft, { userId: "87654321", verifiedSenderId: "87654321" }));
    assert.equal(runtime.value.peopleMemory, undefined);
    assert.equal((await first).revision, 1); assert.equal((await second).revision, 2);
    assert.equal(Object.keys(runtime.value.peopleMemory.bots[BOT].people).length, 2);
    assert.deepEqual(runtime.value, durable);
  } finally { await runtime.close(); }
});
test("MemoryRuntime does not publish before durability, failed commits stay invisible", async () => {
  let start, release, fail = false;
  const started = new Promise(resolve => { start = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const repository = { open: async () => ({ value: { groups: {} }, revision: 0 }), status: () => ({}), close: async () => {},
    commit: async draft => { start(); await gate; if (fail) throw new Error("FIXTURE_COMMIT_FAILED");
      return { value: structuredClone(draft), revision: 1 }; } };
  const runtime = new MemoryRuntime(repository); await runtime.open();
  try {
    const pending = runtime.transact(draft => record(draft)); await started;
    assert.equal(runtime.value.peopleMemory, undefined); release(); await pending;
    const before = structuredClone(runtime.value); fail = true;
    await assert.rejects(runtime.transact(draft => admin(draft, "delete")), /FIXTURE_COMMIT_FAILED/);
    assert.deepEqual(runtime.value, before); assert.equal(query(runtime.value).entries.length, 1);
  } finally { release(); await runtime.close(); }
});
test("control fence and person status publish together only after MemoryRuntime durability", async () => {
  const initial = seeded(); let start, release;
  const started = new Promise(resolve => { start = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const repository = { open: async () => ({ value: structuredClone(initial), revision: 0 }), status: () => ({}), close: async () => {},
    commit: async draft => { start(); await gate; return { value: structuredClone(draft), revision: 1 }; } };
  const runtime = new MemoryRuntime(repository); await runtime.open();
  try {
    const pending = runtime.transact(draft => admin(draft, "freeze")); await started;
    assert.equal(runtime.value.peopleMemory.bots[BOT].controlRevision ?? 0, 0);
    assert.equal(control(runtime.value).frozen, false);
    release(); assert.equal((await pending).changed, true);
    assert.equal(runtime.value.peopleMemory.bots[BOT].controlRevision, 1);
    assert.equal(control(runtime.value).frozen, true);
  } finally { release(); await runtime.close(); }
});
test("real background repository durable reopen preserves tombstones and untouched legacy", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-people-memory-test-"));
  const filePath = path.join(home, "memory.json");
  const repository = new BackgroundMemoryRepository({ filePath }), runtime = new MemoryRuntime(repository);
  let reopened;
  try {
    await runtime.open();
    await runtime.transact(draft => { draft.groups[GROUP] = { users: { [USER]: { preferences: ["legacy fixture"] } } }; return record(draft); });
    const expectedRevision = runtime.value.peopleMemory.revision;
    await runtime.transact(draft => admin(draft, "delete", { expectedRevision }));
    const snapshot = readMemorySnapshot(filePath); assert.deepEqual(snapshot, runtime.value);
    assert.equal(control(snapshot).deleted, true); assert.equal(control(snapshot).suppressesLegacy, true);
    assert.equal(snapshot.peopleMemory.bots[BOT].controlRevision, 1);
    assert.deepEqual(snapshot.groups[GROUP].users[USER].preferences, ["legacy fixture"]);
    await runtime.close();
    reopened = new MemoryRuntime(new BackgroundMemoryRepository({ filePath })); await reopened.open();
    assert.equal(query(reopened.value).status, "deleted");
    const refused = await reopened.transact(draft => record(draft)); assert.equal(refused.reason, "DELETED");
    assert.equal(control(reopened.value).deleted, true);
    assert.equal(reopened.value.peopleMemory.bots[BOT].controlRevision, 1);
  } finally {
    await runtime.close(); if (reopened) await reopened.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, run } of tests) {
  try { await run(); passed++; }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
console.log(JSON.stringify({ ok: true, checks: passed, fixtureOnly: true, productionIO: false, modelCalls: 0,
  memoryRuntimeDurability: true, backgroundRepositoryReopen: true }));
