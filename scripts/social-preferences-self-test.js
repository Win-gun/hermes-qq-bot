import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  recordSocialPreference, getSocialPreferences, reviewSocialPreference, setSocialGrowthFrozen,
} from "../src/social-preferences.js";
import { ingestSocialMessage, appendSocialExperience } from "../src/social-agent-state.js";

// All identities/text are synthetic. No runtime files, clock, network or QQ.
const DAY = 86_400_000;
const T = Date.UTC(2025, 0, 2, 8);
const BOT = "account:fixture", GROUP = "group:101", OTHER_GROUP = "group:202";
const USER = "11", actor = { authorized: true };
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}
const copy = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const bot = (root, logicalId = BOT) => root.socialAgents.bots[logicalId];
const conv = (root, conversationId = GROUP, logicalId = BOT) => bot(root, logicalId).conversations[conversationId];
const store = root => bot(root).socialPreferences;
function human(root, messageId, userId = USER, sentAt = T, text = "我喜欢摄影", conversationId = GROUP, logicalId = BOT) {
  const result = ingestSocialMessage(root, { logicalId, conversationId, now: sentAt,
    message: { messageId, userId, sentAt, receivedAt: sentAt, text, isQuoted: false, isBot: false } });
  assert.equal(result.ok, true);
  return conv(root, conversationId, logicalId).messages.at(-1);
}
function ack(root, messageId, sentAt = T, { eligible = true, conversationId = GROUP, logicalId = BOT, text = "我喜欢摄影" } = {}) {
  assert.equal(appendSocialExperience(root, { logicalId, conversationId, messageId, userId: USER,
    now: sentAt, sentAt, text, confirmed: true, kind: "bot_reply", agencyEligible: eligible }).ok, true);
  const entry = conv(root, conversationId, logicalId).experiences.at(-1);
  if (eligible === true) assert.equal(entry.agencyEligible, true, "actual host adapter must preserve the ACK marker");
  return entry;
}
const args = (extra = {}) => ({ logicalId: BOT, conversationId: GROUP, kind: "group", dimension: "interest",
  value: "摄影", evidenceMessageIds: ["h1"], expectedRevision: 0, now: T, ...extra });
const view = (root, extra = {}) => getSocialPreferences(root, { logicalId: BOT, now: T + 2 * DAY, ...extra });
function record(root, extra = {}) {
  return recordSocialPreference(root, args({ expectedRevision: bot(root).socialPreferences?.revision ?? 0, ...extra }));
}
function failed(root, fn, code) {
  const before = copy(root), result = fn();
  assert.deepEqual(result, { ok: false, code: `SOCIAL_PREFERENCE_${code}` });
  assert.deepEqual(root, before, `failed ${code} changed root`);
}
function reviewed(root, id, extra = {}) {
  return reviewSocialPreference(root, { logicalId: BOT, id, expectedRevision: store(root).revision,
    action: "reject", actor, reason: "synthetic correction", now: T + 2 * DAY, ...extra });
}

test("absent read is detached, read-only, exact default", () => {
  const root = {};
  assert.deepEqual(view(root), { revision: 0, growthFrozen: false, entries: [] });
  assert.deepEqual(root, {});
  const result = view(root);
  result.entries.push({});
  assert.deepEqual(view(root).entries, []);
  assert.throws(() => getSocialPreferences(root, { logicalId: BOT }), /INVALID_ARGS/);
});

test("first write preserves sibling identities, fields and original data", () => {
  const root = {};
  human(root, "h1");
  bot(root).selfRoleCard = { untouched: true };
  root.groups = { facts: ["synthetic fact"] };
  const originalBot = bot(root), originalConv = conv(root), card = bot(root).selfRoleCard, groups = root.groups;
  const result = record(root);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(result.status, "candidate");
  assert.equal(bot(root), originalBot);
  assert.equal(conv(root), originalConv);
  assert.equal(bot(root).selfRoleCard, card);
  assert.equal(root.groups, groups);
  assert.equal(store(root).entries[0].firstSeenAt, T);
  assert.equal(store(root).entries[0].sourceType, "human_message");
  assert.equal(store(root).entries[0].expiresAt, T + 7 * DAY);
});

test("exact CAS, including duplicate, review and freeze", () => {
  const root = {};
  human(root, "h1");
  const { id } = record(root);
  for (const expectedRevision of [undefined, null, "1", -1, 0.5]) {
    failed(root, () => recordSocialPreference(root, args({ expectedRevision })), "INVALID_ARGS");
  }
  failed(root, () => recordSocialPreference(root, args()), "REVISION_CONFLICT");
  failed(root, () => reviewed(root, id, { expectedRevision: 0 }), "REVISION_CONFLICT");
  failed(root, () => setSocialGrowthFrozen(root, { logicalId: BOT, expectedRevision: 0, frozen: true,
    actor, reason: "pause", now: T }), "REVISION_CONFLICT");
  const before = copy(root);
  assert.equal(record(root, { evidenceMessageIds: ["h1", "h1"], now: T + 1 }).duplicate, true);
  assert.deepEqual(root, before);
});

test("human diversity and member Shanghai dates are independent thresholds", () => {
  const root = {};
  human(root, "h1", USER, T);
  human(root, "h2", USER, T + 1);
  human(root, "h3", USER, T + DAY);
  assert.equal(record(root, { evidenceMessageIds: ["h1", "h2", "h3"], now: T + DAY }).status, "candidate");
  assert.equal(record(root, { kind: "member", userId: USER,
    evidenceMessageIds: ["h1", "h2", "h3"], now: T + DAY }).status, "active");
  human(root, "h4", "12", T + DAY + 1);
  human(root, "h5", "13", T + DAY + 2);
  assert.equal(record(root, { evidenceMessageIds: ["h4", "h5"], now: T + DAY + 2 }).status, "active");
  const group = store(root).entries.find(e => e.kind === "group");
  assert.equal(group.evidence.length, 5);
  assert.equal(group.confidence, 0.85);
  failed(root, () => record(root, { kind: "self", evidenceMessageIds: ["h1", "h2", "h3"], now: T + DAY + 2 }), "INVALID_EVIDENCE");
});

test("self maturity: three independent eligible ACKs and literal core compatibility", () => {
  const root = {};
  ack(root, "b1", T);
  ack(root, "b2", T + 1);
  ack(root, "b3", T + DAY);
  const first = record(root, { kind: "self", evidenceMessageIds: ["b1", "b2"], now: T + 1, coreText: "我喜欢摄影" });
  assert.equal(first.status, "candidate");
  const before = copy(root);
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["b1", "b1"], now: T + 1 }).duplicate, true);
  assert.deepEqual(root, before);
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["b3"], now: T + DAY }).status, "active");
  const entry = store(root).entries[0];
  assert.equal(entry.confidence, 0.85);
  assert.equal(entry.firstSeenAt, T);
  assert.equal(entry.lastSeenAt, T + DAY);
  assert.equal(entry.expiresAt, T + 31 * DAY);
  assert.equal(entry.coreConsistency.compatible, true);
  assert.match(entry.coreConsistency.hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(store(root)).includes("我喜欢摄影"), false);
  assert.equal(entry.evidence.every(ref => ref.senderId === null), true);
});

test("Shanghai midnight counts, UTC midnight alone does not", () => {
  const beforeShanghai = Date.UTC(2025, 0, 1, 15, 59, 59), afterShanghai = beforeShanghai + 1000;
  for (const kind of ["member", "self"]) {
    const root = {};
    const add = kind === "self" ? (id, time) => ack(root, id, time) : (id, time) => human(root, id, USER, time);
    add("s1", beforeShanghai); add("s2", beforeShanghai); add("s3", afterShanghai);
    assert.equal(record(root, { kind, ...(kind === "member" ? { userId: USER } : { coreText: "摄影" }),
      evidenceMessageIds: ["s1", "s2", "s3"], now: afterShanghai }).status, "active");
    const utc = {};
    const a = Date.UTC(2025, 0, 1, 23, 59, 59);
    for (let i = 0; i < 3; i++) {
      if (kind === "self") ack(utc, `u${i}`, a + i * 1000);
      else human(utc, `u${i}`, USER, a + i * 1000);
    }
    assert.equal(record(utc, { kind, ...(kind === "member" ? { userId: USER } : { coreText: "摄影" }),
      evidenceMessageIds: ["u0", "u1", "u2"], now: a + 2000 }).status, "candidate");
  }
});

test("unknown, absent or negated core stays candidate; admin explicitly resolves", () => {
  for (const coreText of [undefined, "我喜欢音乐", "我不喜欢摄影"]) {
    const root = {};
    ack(root, "b1"); ack(root, "b2", T + 1); ack(root, "b3", T + DAY);
    const result = record(root, { kind: "self", evidenceMessageIds: ["b1", "b2", "b3"], now: T + DAY,
      ...(coreText === undefined ? {} : { coreText }) });
    assert.equal(result.status, "candidate");
    failed(root, () => reviewed(root, result.id, { action: "approve" }), "COMPATIBILITY_REQUIRED");
    assert.equal(reviewed(root, result.id, { action: "approve", compatibility: "compatible" }).status, "active");
    assert.equal(store(root).entries[0].coreConsistency.source, "admin");
    failed(root, () => record(root, { kind: "self", evidenceMessageIds: ["b1"], now: T + 2 * DAY,
      coreText: "变化后的摄影核心" }), "CORE_CHANGED");
    assert.equal(reviewed(root, result.id).status, "rejected");
  }
});

test("admin compatibility cannot manufacture self evidence maturity", () => {
  const root = {}; ack(root, "b1");
  const { id } = record(root, { kind: "self", evidenceMessageIds: ["b1"] });
  failed(root, () => reviewed(root, id, { action: "approve", compatibility: "compatible" }), "INSUFFICIENT_EVIDENCE");
  assert.equal(store(root).entries[0].coreConsistency.source, "unknown");
});

test("admin self approval binds exact current core hash without retaining prose", () => {
  const root = {}; ack(root, "b1"); ack(root, "b2", T + 1); ack(root, "b3", T + DAY);
  const { id } = record(root, { kind: "self", evidenceMessageIds: ["b1", "b2", "b3"], now: T + DAY,
    coreText: "我喜欢摄影 旧版核心" });
  const currentCore = "我喜欢摄影 当前核心", digest = text => createHash("sha256").update(text).digest("hex");
  assert.equal(reviewed(root, id, { action: "approve", compatibility: "compatible", coreText: currentCore }).status, "active");
  assert.deepEqual(store(root).entries[0].coreConsistency, { hash: digest(currentCore), compatible: true, source: "admin" });
  assert.equal(JSON.stringify(store(root)).includes(currentCore), false);
  // Unchanged record rule: growth using a DIFFERENT effective core is refused.
  failed(root, () => record(root, { kind: "self", evidenceMessageIds: ["b1"], now: T + 2 * DAY,
    coreText: "更新后的摄影核心" }), "CORE_CHANGED");
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["b1"], now: T + 2 * DAY,
    coreText: currentCore }).duplicate, true);
  const nextCore = "重新审查后的摄影核心";
  assert.equal(reviewed(root, id, { action: "approve", compatibility: "compatible", coreText: nextCore }).ok, true);
  assert.equal(store(root).entries[0].coreConsistency.hash, digest(nextCore));
  // Reader deliberately exposes the STORED binding; host consumers must compare
  // it to their current effective hash, not infer authority from compatible.
  const saved = view(root).entries[0].coreConsistency;
  assert.notEqual(saved.hash, digest(currentCore));
  assert.equal(saved.compatible, true);
});

test("legacy self approval preserves prior hash including null; current core may bind later", () => {
  for (const initialCore of [undefined, "摄影旧核心"]) {
    const root = {}; ack(root, "b1"); ack(root, "b2", T + 1); ack(root, "b3", T + DAY);
    const { id } = record(root, { kind: "self", evidenceMessageIds: ["b1", "b2", "b3"], now: T + DAY,
      ...(initialCore === undefined ? {} : { coreText: initialCore }) });
    const priorHash = store(root).entries[0].coreConsistency.hash;
    assert.equal(reviewed(root, id, { action: "approve", compatibility: "compatible" }).ok, true);
    assert.equal(store(root).entries[0].coreConsistency.hash, priorHash);
    assert.equal(reviewed(root, id, { action: "approve", compatibility: "compatible", coreText: "摄影当前核心" }).ok, true);
    assert.match(store(root).entries[0].coreConsistency.hash, /^[a-f0-9]{64}$/);
    assert.notEqual(store(root).entries[0].coreConsistency.hash, priorHash);
  }
});

test("review coreText strict schema, exact size boundary, CAS and atomic failure", () => {
  const root = {}; ack(root, "b1"); ack(root, "b2", T + 1); ack(root, "b3", T + DAY);
  const { id } = record(root, { kind: "self", evidenceMessageIds: ["b1", "b2", "b3"], now: T + DAY });
  for (const coreText of [undefined, null, true, 1, {}, "", "  ", "核".repeat(32_769)]) {
    failed(root, () => reviewed(root, id, { action: "approve", compatibility: "compatible", coreText }), "INVALID_ARGS");
  }
  failed(root, () => reviewed(root, id, { action: "reject", coreText: "摄影" }), "INVALID_ARGS");
  failed(root, () => reviewed(root, id, { action: "expire", coreText: "摄影" }), "INVALID_ARGS");
  failed(root, () => reviewed(root, id, { action: "approve", compatibility: "compatible", coreText: "摄影", expectedRevision: 0 }), "REVISION_CONFLICT");
  assert.equal(reviewed(root, id, { action: "approve", compatibility: "compatible", coreText: "核".repeat(32_768) }).ok, true);
  const group = {}; human(group, "h1"); const target = record(group);
  failed(group, () => reviewed(group, target.id, { action: "approve", coreText: "摄影" }), "INVALID_ARGS");
  const immature = {}; ack(immature, "b1");
  const candidate = record(immature, { kind: "self", evidenceMessageIds: ["b1"] });
  failed(immature, () => reviewed(immature, candidate.id, { action: "approve", compatibility: "compatible", coreText: "摄影" }), "INSUFFICIENT_EVIDENCE");
  assert.equal(store(immature).entries[0].coreConsistency.hash, null);
});

test("no self maturation by same-day repetition, no unrelated or substring evidence", () => {
  const root = {};
  for (let i = 0; i < 4; i++) ack(root, `b${i}`, T + i);
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["b0", "b1", "b2", "b3"], now: T + 4,
    coreText: "摄影" }).status, "candidate");
  failed(root, () => record(root, { kind: "self", value: "音乐", evidenceMessageIds: ["b0"], now: T + 4 }), "UNGROUNDED_VALUE");
  human(root, "h1", USER, T + 4, "party");
  failed(root, () => record(root, { value: "art", now: T + 4 }), "UNGROUNDED_VALUE");
});

test("ACK gate rejects legacy, failed, tool, candidate, revoked and quoted experiences", () => {
  const variants = [
    e => delete e.agencyEligible,
    e => { e.agencyEligible = false; },
    e => { e.agencyEligible = "true"; },
    e => { e.confirmed = false; },
    e => { e.kind = "tool_result"; },
    e => { e.candidate = true; },
    e => { e.candidate = "false"; },
    e => { e.revokedAt = T; },
    e => { e.status = "rejected"; },
    e => { e.isQuoted = true; },
    e => { e.isQuoted = "false"; },
    e => { e.logicalId = "account:other"; },
    e => { e.conversationId = OTHER_GROUP; },
  ];
  for (const mutate of variants) {
    const root = {};
    const e = ack(root, "b1"); mutate(e);
    failed(root, () => record(root, { kind: "self", evidenceMessageIds: ["b1"] }), "INVALID_EVIDENCE");
  }
  const root = {};
  assert.equal(appendSocialExperience(root, { logicalId: BOT, conversationId: GROUP, messageId: "actual-ack", userId: USER,
    now: T, sentAt: T, text: "摄影", confirmed: true, kind: "bot_reply", agencyEligible: true }).ok, true);
  assert.equal(own(conv(root).experiences[0], "agencyEligible"), true);
  assert.equal(conv(root).experiences[0].agencyEligible, true);
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["actual-ack"] }).status, "candidate");
  const actual = store(root).entries[0].evidence[0];
  assert.equal(actual.sourceType, "agency_bot_reply");
  assert.equal(actual.senderId, null);
  assert.equal(actual.messageId, "actual-ack");
  failed(root, () => record(root, { evidenceMessageIds: ["actual-ack"] }), "INVALID_EVIDENCE");
  for (const [index, agencyEligible] of [undefined, false, "true"].entries()) {
    const messageId = `ineligible-${index}`;
    assert.equal(appendSocialExperience(root, { logicalId: BOT, conversationId: GROUP, messageId, userId: USER,
      now: T, sentAt: T, text: "摄影", confirmed: true, kind: "bot_reply",
      ...(agencyEligible === undefined ? {} : { agencyEligible }) }).ok, true);
    assert.equal(own(conv(root).experiences.at(-1), "agencyEligible"), false);
    failed(root, () => record(root, { kind: "self", evidenceMessageIds: [messageId] }), "INVALID_EVIDENCE");
    assert.equal(appendSocialExperience(root, { logicalId: BOT, conversationId: GROUP, messageId, userId: USER,
      now: T, sentAt: T, text: "摄影", confirmed: true, kind: "bot_reply", agencyEligible: true }).duplicate, true);
    assert.equal(own(conv(root).experiences.at(-1), "agencyEligible"), false,
      "an existing ineligible ACK must not gain autonomy provenance on replay");
    failed(root, () => record(root, { kind: "self", evidenceMessageIds: [messageId] }), "INVALID_EVIDENCE");
  }
});
test("human sources must be non-bot, unquoted, same exact member and actual ID", () => {
  for (const field of ["isQuoted", "isBot"]) {
    const root = {}; const message = human(root, "h1"); message[field] = true;
    failed(root, () => record(root), "INVALID_EVIDENCE");
  }
  const root = {}; human(root, "h1", "12");
  failed(root, () => record(root, { kind: "member", userId: USER }), "INVALID_EVIDENCE");
  failed(root, () => record(root, { evidenceMessageIds: ["missing"] }), "INVALID_EVIDENCE");
  conv(root).messages.push(copy(conv(root).messages[0]));
  failed(root, () => record(root), "INVALID_EVIDENCE");
});

test("bot, group, member and private scope isolation; only self is global", () => {
  const root = {};
  human(root, "h1"); human(root, "h2", "12");
  human(root, "other", USER, T, "摄影", OTHER_GROUP);
  human(root, "peer", USER, T, "摄影", GROUP, "account:peer");
  ack(root, "b1");
  assert.equal(record(root).ok, true);
  assert.equal(record(root, { kind: "member", userId: USER }).ok, true);
  assert.equal(record(root, { kind: "member", userId: "12", evidenceMessageIds: ["h2"] }).ok, true);
  assert.equal(record(root, { kind: "self", evidenceMessageIds: ["b1"] }).ok, true);
  assert.equal(record(root, { conversationId: OTHER_GROUP, evidenceMessageIds: ["other"] }).ok, true);
  assert.equal(view(root).entries.length, 1);
  assert.equal(view(root, { conversationId: GROUP }).entries.length, 2);
  assert.equal(view(root, { conversationId: GROUP, userId: USER }).entries.length, 3);
  assert.equal(view(root, { conversationId: GROUP, userId: "13", kind: "member" }).entries.length, 0);
  assert.equal(view(root, { conversationId: OTHER_GROUP, userId: USER }).entries.length, 2);
  assert.equal(view(root, { logicalId: "account:peer", conversationId: GROUP }).entries.length, 0);
  assert.equal(view(root, { logicalId: "account:absent" }).entries.length, 0);
  failed(root, () => record(root, { evidenceMessageIds: ["other"] }), "INVALID_EVIDENCE");
  failed(root, () => record(root, { evidenceMessageIds: ["peer"] }), "INVALID_EVIDENCE");
  for (const kind of ["self", "group", "member"]) {
    failed(root, () => record(root, { kind, conversationId: "private:11", ...(kind === "member" ? { userId: USER } : {}) }), "INVALID_ARGS");
    assert.throws(() => view(root, { conversationId: "private:11", kind }), /INVALID_ARGS/);
  }
  assert.throws(() => view(root, { kind: "group" }), /INVALID_ARGS/);
  assert.throws(() => view(root, { kind: "member", conversationId: GROUP }), /INVALID_ARGS/);
});

test("self accumulates real ACKs across groups, never counts a repeated ID twice", () => {
  const root = {};
  ack(root, "b1"); ack(root, "b2", T + DAY, { conversationId: OTHER_GROUP });
  ack(root, "b3", T + DAY + 1, { conversationId: OTHER_GROUP });
  record(root, { kind: "self", evidenceMessageIds: ["b1"], coreText: "摄影" });
  assert.equal(record(root, { kind: "self", conversationId: OTHER_GROUP,
    evidenceMessageIds: ["b2", "b3"], now: T + DAY + 1 }).status, "active");
  const global = view(root, { conversationId: "group:303", userId: "99", kind: "self", now: T + DAY + 1 }).entries[0];
  assert.equal(global.conversationId, null);
  assert.equal(global.userId, null);
  assert.deepEqual(global.evidence.map(ref => ref.conversationId), [GROUP, OTHER_GROUP, OTHER_GROUP]);
  assert.equal(global.evidence.every(ref => ref.sourceType === "agency_bot_reply"
    && ref.senderId === null && !own(ref, "userId")), true, "global self contains no member provenance");
  ack(root, "b1", T + DAY + 2, { conversationId: OTHER_GROUP });
  failed(root, () => record(root, { kind: "self", conversationId: OTHER_GROUP,
    evidenceMessageIds: ["b1"], now: T + DAY + 2 }), "EVIDENCE_CONFLICT");
});

test("TTL is original sentAt based, lazy/read-only, and no replay refresh", () => {
  for (const kind of ["self", "group", "member"]) {
    const root = {}, life = (kind === "group" ? 7 : 30) * DAY;
    if (kind === "self") ack(root, "e1"); else human(root, "e1");
    record(root, { kind, ...(kind === "member" ? { userId: USER } : {}), evidenceMessageIds: ["e1"], now: T + DAY });
    assert.equal(store(root).entries[0].createdAt, T + DAY);
    assert.equal(store(root).entries[0].expiresAt, T + life);
    const before = copy(root);
    const result = view(root, { conversationId: GROUP, userId: USER, now: T + life });
    assert.equal(result.entries[0].status, "expired");
    assert.equal(result.entries[0].confidence, 0);
    assert.deepEqual(root, before);
    failed(root, () => record(root, { kind, ...(kind === "member" ? { userId: USER } : {}),
      evidenceMessageIds: ["e1"], now: T + life }), "EXPIRED");
    failed(root, () => reviewed(root, store(root).entries[0].id, { now: T + life, action: "approve",
      ...(kind === "self" ? { compatibility: "compatible" } : {}) }), "EXPIRED");
  }
});

test("expired evidence cannot contribute to new maturity", () => {
  const root = {};
  human(root, "h1", USER, T);
  failed(root, () => record(root, { now: T + 7 * DAY }), "INVALID_EVIDENCE");
  const self = {};
  ack(self, "b1"); ack(self, "b2", T + 29 * DAY); ack(self, "b3", T + 29 * DAY + 1);
  record(self, { kind: "self", evidenceMessageIds: ["b1", "b2"], now: T + 29 * DAY, coreText: "摄影" });
  assert.equal(record(self, { kind: "self", evidenceMessageIds: ["b3"], now: T + 30 * DAY }).status, "candidate");
});

test("read re-evaluates recent diversity without writing or granting new maturity", () => {
  const root = {};
  human(root, "h1", USER, T);
  human(root, "h2", "12", T + 1);
  human(root, "h3", "13", T + 6 * DAY);
  assert.equal(record(root, { evidenceMessageIds: ["h1", "h2", "h3"], now: T + 6 * DAY }).status, "active");
  const before = copy(root);
  const result = view(root, { kind: "group", conversationId: GROUP, now: T + 8 * DAY });
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.entries[0].confidence, 0.25);
  assert.deepEqual(root, before);
  assert.equal(store(root).entries[0].status, "active");
});

test("negative and correction evidence becomes a durable rejection tombstone", () => {
  for (const text of ["我不喜欢摄影", "更正 摄影并不是兴趣"]) {
    const root = {}; human(root, "h1", USER, T, text);
    const result = record(root);
    assert.equal(result.status, "rejected");
    assert.equal(store(root).entries[0].confidence, 0);
    assert.equal(store(root).entries[0].tombstone.type, text.startsWith("更正") ? "correction" : "negative");
    human(root, "h2", "12", T + 1);
    failed(root, () => record(root, { evidenceMessageIds: ["h2"], now: T + 1 }), "TOMBSTONED");
    failed(root, () => reviewed(root, result.id, { action: "approve" }), "TOMBSTONED");
    assert.equal(view(root, { kind: "group", conversationId: GROUP, now: T + 90 * DAY }).entries[0].status, "rejected");
  }
});

test("admin correction and explicit expiration retain terminal originals", () => {
  for (const action of ["reject", "expire"]) {
    const root = {}; human(root, "h1");
    const { id } = record(root);
    assert.equal(reviewed(root, id, { action }).ok, true);
    assert.equal(store(root).entries[0].evidence.length, 1);
    assert.equal(store(root).entries[0].tombstone.type, action === "reject" ? "correction" : "expired");
    failed(root, () => reviewed(root, id, { action: "approve" }), "TOMBSTONED");
    failed(root, () => record(root, { now: T + 2 * DAY }), action === "reject" ? "TOMBSTONED" : "EXPIRED");
  }
});

test("trusted host schema only: no prose actor or model confidence/permissions", () => {
  const root = {}; human(root, "h1"); const { id } = record(root);
  for (const bad of [undefined, true, "authorized", { authorized: false }, { authorized: true, role: "admin" },
    Object.create({ authorized: true }), { authorized: "true" }]) {
    failed(root, () => reviewed(root, id, { actor: bad }), "INVALID_ARGS");
    failed(root, () => setSocialGrowthFrozen(root, { logicalId: BOT, expectedRevision: 1, frozen: true,
      actor: bad, reason: "pause", now: T }), "INVALID_ARGS");
  }
  for (const extra of [{ confidence: 1 }, { actor }, { confirmed: true }, { evidence: "摄影" }, { permission: "admin" }]) {
    failed(root, () => record(root, extra), "INVALID_ARGS");
  }
  failed(root, () => reviewed(root, id, { action: "approve" }), "INSUFFICIENT_EVIDENCE");
  failed(root, () => reviewed(root, id, { reason: "" }), "INVALID_ARGS");
});

test("freeze is CAS-protected, blocks growth, permits host corrections, unfreezes", () => {
  const root = {}; human(root, "h1"); const { id } = record(root);
  const freeze = frozen => setSocialGrowthFrozen(root, { logicalId: BOT, expectedRevision: store(root).revision,
    frozen, actor, reason: "synthetic pause", now: T + 2 * DAY });
  assert.equal(freeze(true).revision, 2);
  assert.equal(view(root).growthFrozen, true);
  failed(root, () => record(root, { now: T + 2 * DAY }), "GROWTH_FROZEN");
  const before = copy(root); assert.equal(freeze(true).duplicate, true); assert.deepEqual(root, before);
  assert.equal(reviewed(root, id).ok, true);
  assert.equal(freeze(false).ok, true);
  assert.equal(view(root).growthFrozen, false);
  assert.equal(view(root, { conversationId: GROUP }).entries[0].status, "rejected");
});

test("freeze initialization publishes exactly once, false default is no-op", () => {
  const root = {};
  const request = { logicalId: BOT, expectedRevision: 0, frozen: false, actor, reason: "synthetic pause", now: T };
  assert.equal(setSocialGrowthFrozen(root, request).duplicate, true);
  assert.deepEqual(root, {});
  assert.equal(setSocialGrowthFrozen(root, { ...request, frozen: true }).revision, 1);
  assert.deepEqual(store(root), { version: 1, revision: 1, entries: [], growthFrozen: true });
});

test("256 entries: no FIFO, tombstones retained, 257th is atomic backpressure", () => {
  const root = {};
  const labels = Array.from({ length: 257 }, (_, i) => `合成标签${i}`);
  human(root, "h1", USER, T, labels.join(" "));
  for (const value of labels.slice(0, 256)) assert.equal(record(root, { value }).ok, true);
  const first = store(root).entries[0].id;
  assert.equal(reviewed(root, first).ok, true);
  failed(root, () => record(root, { value: labels[256], now: T + 2 * DAY }), "BACKPRESSURE");
  assert.equal(store(root).entries[0].id, first);
  assert.equal(store(root).entries[0].status, "rejected");
  assert.equal(record(root, { value: labels[1], now: T + 2 * DAY }).duplicate, true);
});

test("32 evidence: no eviction, replay no-op, overflow fails atomically", () => {
  const root = {};
  for (let i = 0; i < 33; i++) human(root, `e${i}`, USER, T + i);
  const evidenceMessageIds = Array.from({ length: 32 }, (_, i) => `e${i}`);
  assert.equal(record(root, { kind: "member", userId: USER, evidenceMessageIds, now: T + 32 }).ok, true);
  assert.equal(record(root, { kind: "member", userId: USER, evidenceMessageIds, now: T + 32 }).duplicate, true);
  failed(root, () => record(root, { kind: "member", userId: USER, evidenceMessageIds: ["e32"], now: T + 32 }), "BACKPRESSURE");
  assert.equal(store(root).entries[0].evidence.length, 32);
});

test("whole-state corruption fails closed, never repairs or resets", () => {
  const seed = {}; human(seed, "h1"); record(seed);
  const variants = [
    r => { store(r).version = 2; },
    r => { store(r).revision = "1"; },
    r => { store(r).entries = null; },
    r => { store(r).growthFrozen = 1; },
    r => { store(r).unknown = true; },
    r => { store(r).entries[0].confidence = 1; },
    r => { store(r).entries[0].status = "active"; },
    r => { store(r).entries[0].evidence[0].senderId = "invalid"; },
    r => { store(r).entries[0].expiresAt++; },
    r => { store(r).entries[0].id = "bad"; },
    r => { store(r).entries[0].coreConsistency.compatible = true; },
    r => { store(r).entries.push(copy(store(r).entries[0])); },
    r => { store(r).entries[0].evidence.push(copy(store(r).entries[0].evidence[0])); },
    r => { bot(r).socialPreferences = null; },
    r => { r.socialAgents.version = 2; },
    r => { r.socialAgents.bots = []; },
    r => { r.socialAgents.bots[BOT] = false; },
  ];
  for (const mutate of variants) {
    const root = copy(seed); mutate(root);
    const before = copy(root);
    assert.throws(() => view(root), /INVALID_STATE/);
    assert.deepEqual(root, before);
    failed(root, () => recordSocialPreference(root, args({ expectedRevision: 1 })), "INVALID_STATE");
  }
});

test("late evidence conflict, invalid batch and non-writable publication are atomic", () => {
  const root = {}; human(root, "h1"); human(root, "h2"); record(root);
  conv(root).messages[0].text = "摄影 我更喜欢摄影";
  failed(root, () => record(root, { evidenceMessageIds: ["h2", "h1"] }), "EVIDENCE_CONFLICT");
  failed(root, () => record(root, { evidenceMessageIds: ["h2", "missing"] }), "INVALID_EVIDENCE");
  const empty = {};
  failed(empty, () => recordSocialPreference(empty, args()), "INVALID_EVIDENCE");
  assert.deepEqual(empty, {});
  const fresh = {}; human(fresh, "h1"); Object.preventExtensions(bot(fresh));
  failed(fresh, () => record(fresh), "NOT_WRITABLE");
  const sealed = Object.freeze({});
  failed(sealed, () => setSocialGrowthFrozen(sealed, { logicalId: BOT, expectedRevision: 0,
    frozen: true, actor, reason: "pause", now: T }), "NOT_WRITABLE");
  const existing = {}; human(existing, "h1"); record(existing);
  Object.defineProperty(bot(existing), "socialPreferences", { writable: false });
  failed(existing, () => reviewed(existing, store(existing).entries[0].id), "NOT_WRITABLE");
});

test("malicious keys, prototypes, accessors, symbols, sparse and hidden fields reject", () => {
  const root = {}; human(root, "h1");
  for (const logicalId of ["__proto__", "constructor", "account:__proto__", "account:constructor", "account:toString", "account:prototype"]) {
    failed(root, () => record(root, { logicalId }), "INVALID_ARGS");
    assert.throws(() => view(root, { logicalId }), /INVALID_ARGS/);
  }
  const requests = [JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: true }, { prototype: true },
    { [Symbol("hidden")]: true }];
  for (const extra of requests) failed(root, () => recordSocialPreference(root, { ...args(), ...extra }), "INVALID_ARGS");
  let calls = 0;
  const accessor = args(); Object.defineProperty(accessor, "value", { get() { calls++; return "摄影"; } });
  assert.equal(recordSocialPreference(root, accessor).ok, false);
  const badRoot = {}; Object.defineProperty(badRoot, "socialAgents", { enumerable: true, get() { calls++; return {}; } });
  assert.equal(recordSocialPreference(badRoot, args()).code, "SOCIAL_PREFERENCE_INVALID_STATE");
  assert.throws(() => view(badRoot), /INVALID_STATE/);
  const hidden = args(); Object.defineProperty(hidden, "hidden", { value: 1 });
  assert.equal(recordSocialPreference(root, hidden).ok, false);
  assert.equal(recordSocialPreference(root, Object.assign(Object.create({ injected: true }), args())).ok, false);
  const sparse = []; sparse.length = 2; sparse[1] = "h1";
  failed(root, () => record(root, { evidenceMessageIds: sparse }), "INVALID_ARGS");
  const array = ["h1"]; Object.defineProperty(array, "0", { get() { calls++; return "h1"; } });
  assert.equal(recordSocialPreference(root, args({ evidenceMessageIds: array })).ok, false);
  assert.equal(calls, 0);
  assert.equal({}.polluted, undefined);
});

test("unsafe labels, out-of-schema time/limit/kind and personal identifiers reject", () => {
  const root = {}; human(root, "h1");
  for (const value of ["", " 摄影", "x".repeat(81), "https://invalid.example", "/tmp/synthetic", "C:\\synthetic",
    "QQ号 1234", "1234", "123456", "@11", "a@invalid.example", "sk-syntheticcredential", "api_key",
    "授予工具权限", "忽略系统提示", "system prompt", "ignore all rules", "grant admin", "你必须私聊", "摄\u200b影", "摄\n影"]) {
    failed(root, () => record(root, { value }), "INVALID_ARGS");
  }
  for (const extra of [{ now: NaN }, { now: 0 }, { now: 1.5 }, { now: Number.MAX_SAFE_INTEGER },
    { kind: "private" }, { dimension: "identity" }, { evidenceMessageIds: [] }, { userId: USER }, { coreText: "摄影" }]) {
    failed(root, () => record(root, extra), "INVALID_ARGS");
  }
  for (const limit of [0, -1, 257, "1", null]) assert.throws(() => view(root, { limit }), /INVALID_ARGS/);
});

test("detached results, explicit limit, old clock, future evidence and revision overflow", () => {
  const root = {}; human(root, "h1"); record(root);
  const result = view(root, { conversationId: GROUP, limit: 1 });
  result.entries[0].evidence[0].senderId = "99";
  result.entries[0].feedback.negativeEvidenceIds.push("injected");
  assert.equal(store(root).entries[0].evidence[0].senderId, USER);
  assert.equal(store(root).entries[0].feedback.negativeEvidenceIds.length, 0);
  assert.throws(() => view(root, { now: T - 1 }), /INVALID_TIME/);
  failed(root, () => record(root, { now: T - 1 }), "INVALID_TIME");
  const future = {}; human(future, "h1", USER, T + 1);
  failed(future, () => record(future), "INVALID_EVIDENCE");
  store(root).revision = Number.MAX_SAFE_INTEGER;
  failed(root, () => record(root), "BACKPRESSURE");
});

console.log(`social-preferences self-test: ${passed} tests passed`);
