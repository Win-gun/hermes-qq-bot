import assert from "node:assert/strict";
import { ingestSocialMessage, appendSocialExperience } from "../src/social-agent-state.js";
import { beginDiscoveryRound, finishDiscoveryRound, feedbackDiscoveryItem } from "../src/social-discovery-state.js";
import { proposeSocialIntent, getSocialIntentJournal, settleSocialIntent, selectRelevantSocialIntents } from "../src/social-intent-journal.js";

// All evidence is synthetic, built in memory using existing state APIs. No
// filesystem/config/runtime/model/network/QQ access, clocks, sleeps or timers.
const NOW = Date.UTC(2026, 9, 24, 4), DAY = 86_400_000;
const BASE = { logicalId: "account:fixture", conversationId: "group:100", now: NOW };
const OTHER_BOT = { ...BASE, logicalId: "account:peer" }, OTHER_GROUP = { ...BASE, conversationId: "group:101" };
const POLICY = { enabled: true, shadowMode: false, conversationIds: ["group:100"] };
let checks = 0, scenarios = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
const yes = x => { assert.equal(x, true); checks++; };
function test(name, fn) {
  try { fn(); scenarios++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const bot = (r, scope = BASE) => r.socialAgents.bots[scope.logicalId];
const conv = (r, scope = BASE) => bot(r, scope).conversations[scope.conversationId];
const journal = r => bot(r)?.socialIntentJournal;
const rev = r => journal(r)?.revision ?? 0;
const args = (r, extra = {}) => ({ ...BASE, expectedRevision: rev(r), kind: "opinion",
  summary: "关于太空探索的看法", reason: "延续公开话题", trigger: { kind: "related_message", terms: ["太空探索", "space"] },
  evidenceMessageIds: ["human-a"], ttlMs: 60_000, ...extra });
const propose = (r, extra = {}) => proposeSocialIntent(r, args(r, extra));
const settle = (r, id, status, extra = {}) => settleSocialIntent(r,
  { ...BASE, id, status, expectedRevision: rev(r), reason: "宿主记录状态变化", ...extra });
const read = (r, extra = {}) => getSocialIntentJournal(r, { ...BASE, ...extra });
const select = (r, extra = {}) => selectRelevantSocialIntents(r, { ...BASE, query: "讨论太空探索", ...extra });
function unchanged(r, fn, reason) {
  const before = structuredClone(r), result = fn();
  eq(result.ok, false);
  if (reason) eq(result.reason, reason);
  eq(r, before);
  return result;
}
function ingest(r, scope = BASE, id = "human-a", extra = {}) {
  yes(ingestSocialMessage(r, { ...scope, message: { messageId: id, userId: "123", text: "大家一起讨论太空探索的新发现吧",
    sentAt: NOW - 200, receivedAt: NOW - 100, ...extra } }).ok);
}
function fixture() {
  const r = { unrelated: { preserve: ["original-memory"] } };
  ingest(r); ingest(r, BASE, "human-b", { userId: "124", text: "这次航天任务的进展很值得关注" });
  ingest(r, BASE, "quoted", { isQuoted: true });
  ingest(r, OTHER_BOT, "peer-source"); ingest(r, OTHER_GROUP, "other-group-source");
  return r;
}
function receipt(r, id = "reply-a", extra = {}, scope = BASE) {
  yes(appendSocialExperience(r, { ...scope, now: NOW + 10, userId: "123", messageId: id,
    text: "这是关于太空探索的实际回复", sentAt: NOW + 5, kind: "bot_reply", confirmed: true, ...extra }).ok);
}
function publicFixture() {
  const r = fixture();
  yes(beginDiscoveryRound(r, { ...BASE, now: NOW - 2000, roundId: "round-a", policy: POLICY }).ok);
  const result = finishDiscoveryRound(r, { ...BASE, now: NOW - 1000, roundId: "round-a", status: "complete", items: [{
    kind: "expression", title: "太空探索公开材料", meaning: "公开航天主题说明", applicable: "太空探索", avoid: "敏感私人话题",
    sources: [{ url: "https://example.org/public-space", title: "synthetic evidence" }], confidence: 0.9,
  }] });
  eq(result.accepted, 1);
  return r;
}
const publicArgs = r => ({ kind: "discovery", summary: "太空探索的公开发现", trigger: { kind: "public_discovery", terms: ["太空探索"] },
  evidenceMessageIds: [], materialIds: [bot(r).discovery.items[0].id] });

test("missing reads are detached, no defaults writes", () => {
  for (const r of [{}, { socialAgents: { version: 1, bots: {} } }]) {
    const before = structuredClone(r);
    eq(read(r), { revision: 0, entries: [] }); eq(select(r), []); eq(r, before);
  }
  const r = fixture(), before = structuredClone(r);
  eq(read(r), { revision: 0, entries: [] }); eq(r, before);
  unchanged({}, () => proposeSocialIntent({}, { ...BASE, expectedRevision: 0 }), "invalid_scope");
});

test("all kinds, canonical refs, detached args/results and unrelated memory", () => {
  for (const kind of ["opinion", "question", "followup", "public_share", "discovery"]) {
    const r = publicFixture(), before = structuredClone(r);
    const input = args(r, { kind, ...(kind === "public_share" || kind === "discovery" ? { materialIds: [bot(r).discovery.items[0].id] } : {}) });
    const savedArgs = structuredClone(input), result = proposeSocialIntent(r, input);
    yes(result.ok); eq(result.duplicate, false); eq(result.revision, 1); eq(result.entry.status, "candidate");
    eq(result.entry.revision, 1); eq(result.entry.expiresAt, NOW + 60_000); eq(input, savedArgs);
    eq(result.entry.evidenceRefs, [{ messageId: "human-a", userId: "123", sentAt: NOW - 200, receivedAt: NOW - 100 }]);
    yes(!JSON.stringify(journal(r)).includes("大家一起"));
    yes(!JSON.stringify(journal(r)).includes("https://"));
    eq(bot(r).conversations, bot(before).conversations); eq(bot(r).discovery, bot(before).discovery);
    eq(r.unrelated, before.unrelated); eq(bot(r, OTHER_BOT), bot(before, OTHER_BOT));
    input.trigger.terms.push("改变"); result.entry.evidenceRefs[0].userId = "999";
    const view = read(r); view.entries[0].trigger.terms.push("改变"); view.entries.length = 0;
    eq(read(r).entries.length, 1); eq(read(r).entries[0].evidenceRefs[0].userId, "123");
    yes(!read(r).entries[0].trigger.terms.includes("改变"));
  }
});

test("state machine, actual confirmed receipt and restart", () => {
  const r = fixture(), first = propose(r); yes(first.ok);
  unchanged(r, () => settle(r, first.id, "expressed", { receiptMessageId: "reply-a" }), "invalid_transition");
  unchanged(r, () => settle(r, first.id, "expired"), "invalid_expiry");
  const pending = settle(r, first.id, "pending"); yes(pending.ok); eq(pending.revision, 2); eq(pending.entry.revision, 2);
  eq(select(r), []); eq(read(r).entries[0].status, "pending");
  unchanged(r, () => settle(r, first.id, "pending"), "invalid_transition");
  receipt(r);
  const restarted = JSON.parse(JSON.stringify(r));
  const expressed = settle(restarted, first.id, "expressed", { now: NOW + 10, receiptMessageId: "reply-a" });
  yes(expressed.ok); eq(expressed.revision, 3); eq(expressed.entry.revision, 3);
  eq(expressed.entry.status, "expressed"); eq(expressed.entry.receiptMessageId, "reply-a");
  eq(expressed.entry.terminalReason, "宿主记录状态变化"); eq(select(restarted, { now: NOW + 10 }), []);
  for (const status of ["pending", "expressed", "abandoned", "expired"]) {
    unchanged(restarted, () => settle(restarted, first.id, status, { now: NOW + 10,
      ...(status === "expressed" ? { receiptMessageId: "reply-a" } : {}) }), "invalid_transition");
  }
  const before = structuredClone(restarted), duplicate = propose(restarted, { now: NOW + 10 });
  yes(duplicate.ok); yes(duplicate.duplicate); eq(duplicate.entry.status, "expressed"); eq(restarted, before);
});

test("cancellation is permanent, overlapping sources cannot evade it", () => {
  for (const pending of [false, true]) {
    const r = fixture(), first = propose(r); yes(first.ok);
    if (pending) yes(settle(r, first.id, "pending").ok);
    yes(settle(r, first.id, "abandoned").ok);
    eq(read(r).entries[0].status, "abandoned");
    for (const extra of [{}, { kind: "question", summary: "太空探索还有哪些开放问题" },
      { evidenceMessageIds: ["human-a", "human-b"] }]) {
      unchanged(r, () => propose(r, extra), "source_abandoned");
    }
    const rebuilt = JSON.parse(JSON.stringify(r));
    unchanged(rebuilt, () => propose(rebuilt), "source_abandoned");
    yes(propose(r, { evidenceMessageIds: ["human-b"] }).ok);
  }
  const r = publicFixture(), p = propose(r, publicArgs(r)); yes(p.ok);
  yes(settle(r, p.id, "abandoned").ok);
  unchanged(r, () => propose(r, { ...publicArgs(r), summary: "改写后的公开发现" }), "source_abandoned");
  const concurrent = fixture(), a = propose(concurrent), b = propose(concurrent, { summary: "太空探索的另一个候选" });
  yes(a.ok); yes(b.ok); yes(settle(concurrent, a.id, "abandoned").ok);
  eq(select(concurrent), []);
  unchanged(concurrent, () => settle(concurrent, b.id, "pending"), "source_abandoned");
});

test("complete lifecycle transition matrix", () => {
  for (const from of ["candidate", "pending", "expressed", "abandoned", "expired"]) {
    for (const to of ["pending", "expressed", "abandoned", "expired"]) {
      const r = fixture(), p = propose(r); yes(p.ok);
      if (["pending", "expressed"].includes(from)) yes(settle(r, p.id, "pending").ok);
      if (from === "expressed") { receipt(r); yes(settle(r, p.id, from, { now: NOW + 10, receiptMessageId: "reply-a" }).ok); }
      if (from === "abandoned") yes(settle(r, p.id, from).ok);
      if (from === "expired") yes(settle(r, p.id, from, { now: NOW + 60_000 }).ok);
      if (to === "expressed" && from !== "expressed") receipt(r);
      const extra = { now: to === "expired" || from === "expired" ? NOW + 60_000 : NOW + 20,
        ...(to === "expressed" ? { receiptMessageId: "reply-a" } : {}) };
      const allowed = (from === "candidate" && ["pending", "abandoned", "expired"].includes(to))
        || (from === "pending" && ["expressed", "abandoned", "expired"].includes(to));
      if (allowed) { yes(settle(r, p.id, to, extra).ok); eq(read(r, { now: extra.now }).entries[0].status, to); }
      else unchanged(r, () => settle(r, p.id, to, extra), "invalid_transition");
    }
  }
});

test("CAS is bot-journal scoped, including duplicate and other group writes", () => {
  const r = fixture(), first = propose(r); yes(first.ok);
  unchanged(r, () => propose(r, { expectedRevision: 0 }), "stale_revision");
  unchanged(r, () => settle(r, first.id, "pending", { expectedRevision: 0 }), "stale_revision");
  yes(propose(r, { ...OTHER_GROUP, evidenceMessageIds: ["other-group-source"] }).ok);
  unchanged(r, () => settle(r, first.id, "pending", { expectedRevision: 1 }), "stale_revision");
  yes(settle(r, first.id, "pending").ok); eq(rev(r), 3);
  for (const expectedRevision of [undefined, null, "3", -1, NaN, 1.5]) {
    unchanged(r, () => propose(r, { expectedRevision }), "invalid_args");
  }
});

test("sources cannot cross bot/group/private or quote/bot/tool boundaries", () => {
  const r = fixture();
  receipt(r, "bot-source"); receipt(r, "tool-source", { kind: "tool_result" });
  for (const id of ["missing", "peer-source", "other-group-source", "quoted", "bot-source", "tool-source"]) {
    unchanged(r, () => propose(r, { evidenceMessageIds: [id] }), "invalid_evidence");
  }
  for (const extra of [{ logicalId: "account:absent" }, { conversationId: "group:999" }]) {
    unchanged(r, () => propose(r, extra), "invalid_scope");
  }
  for (const conversationId of ["private:123", "qzone:100", "group:001", "__proto__"]) {
    unchanged(r, () => propose(r, { conversationId }), "invalid_args");
    eq(read(r, { conversationId }).entries, []); eq(select(r, { conversationId }), []);
  }
  const first = propose(r); yes(first.ok);
  eq(read(r, OTHER_BOT).entries, []); eq(read(r, OTHER_GROUP).entries, []);
  unchanged(r, () => settle(r, first.id, "pending", OTHER_BOT), "stale_revision");
  unchanged(r, () => settle(r, first.id, "pending", OTHER_GROUP), "not_found");
  for (const mutate of [m => { m.isBot = true; }, m => { m.isQuoted = true; },
    m => { m.sentAt = NOW + 100; }, m => { m.receivedAt = NOW + 100; },
    m => { m.conversationId = OTHER_GROUP.conversationId; }, m => { m.logicalId = OTHER_BOT.logicalId; }]) {
    const bad = fixture(); mutate(conv(bad).messages[0]);
    unchanged(bad, () => propose(bad), "invalid_evidence");
  }
  const ambiguous = fixture(); conv(ambiguous).messages.push({ ...conv(ambiguous).messages[0] });
  unchanged(ambiguous, () => propose(ambiguous), "invalid_evidence");
});

test("material provenance, stored policy, active TTL, blocks and topic scope", () => {
  const r = publicFixture(), p = publicArgs(r), first = propose(r, p); yes(first.ok);
  eq(select(r).length, 1); eq(first.entry.evidenceRefs, []); eq(first.entry.materialRefs.length, 1);
  for (const extra of [{ materialIds: [] }, { materialIds: ["fabricated"] }, { materialIds: ["https://example.org/model-url"] },
    { ...OTHER_GROUP }, { ...OTHER_BOT }]) {
    const fresh = publicFixture();
    unchanged(fresh, () => propose(fresh, { ...publicArgs(fresh), ...extra }));
  }
  const invalidations = [
    b => { b.discovery.policy.enabled = false; }, b => { b.discovery.policy.shadowMode = true; },
    b => { b.discovery.policy.conversationIds = ["group:101"]; },
    b => { b.discovery.policy.blockedTopics = ["太空探索"]; },
    b => { b.discovery.items[0].expiresAt = NOW; }, b => { b.discovery.items[0].collectedAt = NOW + 1; },
    b => { b.discovery.items[0].status = "expired"; }, b => { b.discovery.items = []; },
    b => { b.discovery.items.push({ ...b.discovery.items[0] }); },
    b => { b.discovery.version = 2; }, b => { b.discovery.policy = { enabled: true, surprise: true }; },
  ];
  for (const invalidate of invalidations) {
    const fresh = publicFixture(), extra = publicArgs(fresh); invalidate(bot(fresh));
    unchanged(fresh, () => propose(fresh, extra), "invalid_material");
    const changed = structuredClone(r); invalidate(bot(changed)); const before = structuredClone(changed);
    eq(select(changed), []); eq(changed, before);
  }
  for (const action of ["block", "delete", "expire", "dislike"]) {
    const fresh = publicFixture(), extra = publicArgs(fresh);
    yes(feedbackDiscoveryItem(fresh, { ...BASE, id: extra.materialIds[0], action }).ok);
    unchanged(fresh, () => propose(fresh, extra), "invalid_material");
  }
  const capped = publicFixture(); bot(capped).discovery.items[0].expiresAt = NOW + 10;
  eq(propose(capped, publicArgs(capped)).entry.expiresAt, NOW + 10);
  eq(select(capped, { now: NOW + 10 }), []);
  unchanged(r, () => propose(r, { ...p, policy: POLICY }), "invalid_args");
});

test("fabricated, uncertain, stale, cross-scope, duplicate and reused ACKs fail", () => {
  const invalidReceipts = [
    (r) => {},
    r => receipt(r, "ack", {}, OTHER_BOT), r => receipt(r, "ack", {}, OTHER_GROUP),
    r => receipt(r, "ack", { kind: "tool_result" }),
    r => { receipt(r, "ack"); conv(r).experiences[0].confirmed = false; },
    r => { receipt(r, "ack"); conv(r).experiences[0].status = "uncertain"; conv(r).experiences[0].confirmed = false; },
    r => { receipt(r, "ack"); conv(r).experiences[0].status = "uncertain"; },
    r => { receipt(r, "ack"); conv(r).experiences[0].uncertain = true; },
    r => receipt(r, "ack", { sentAt: NOW - 1 }),
    r => { receipt(r, "ack"); conv(r).experiences[0].revokedAt = NOW + 6; },
    r => { receipt(r, "ack"); conv(r).experiences[0].conversationId = OTHER_GROUP.conversationId; },
    r => { receipt(r, "ack"); conv(r).experiences[0].logicalId = OTHER_BOT.logicalId; },
    r => { receipt(r, "ack"); conv(r).experiences[0].sentAt = NOW + 50; },
    r => { receipt(r, "ack"); conv(r).experiences.push({ ...conv(r).experiences[0] }); },
  ];
  for (const prepare of invalidReceipts) {
    const r = fixture(), first = propose(r); yes(first.ok); yes(settle(r, first.id, "pending").ok); prepare(r);
    unchanged(r, () => settle(r, first.id, "expressed", { now: NOW + 10, receiptMessageId: "ack" }), "unconfirmed_receipt");
    eq(read(r, { now: NOW + 10 }).entries[0].status, "pending");
  }
  const r = fixture(), a = propose(r), b = propose(r, { summary: "太空探索的另一种看法" });
  yes(settle(r, a.id, "pending").ok); yes(settle(r, b.id, "pending").ok); receipt(r, "ack");
  yes(settle(r, a.id, "expressed", { now: NOW + 10, receiptMessageId: "ack" }).ok);
  unchanged(r, () => settle(r, b.id, "expressed", { now: NOW + 10, receiptMessageId: "ack" }), "unconfirmed_receipt");
  unchanged(r, () => settle(r, b.id, "abandoned", { now: NOW + 10, receiptMessageId: "ack" }), "invalid_args");
});

test("TTL boundary, pending expiry, projected reads never persist", () => {
  for (const pending of [false, true]) {
    const r = fixture(), first = propose(r, { ttlMs: 10 }); yes(first.ok);
    if (pending) yes(settle(r, first.id, "pending").ok);
    const before = structuredClone(r);
    const atExpiry = read(r, { now: NOW + 10 }); eq(atExpiry.entries[0].status, "expired");
    eq(atExpiry.entries[0].terminalReason, "ttl_expired"); eq(r, before);
    eq(select(r, { now: NOW + 10 }), []); eq(r, before);
    unchanged(r, () => settle(r, first.id, "pending", { now: NOW + 10 }));
    yes(settle(r, first.id, "expired", { now: NOW + 10 }).ok);
    eq(read(r, { now: NOW + 10 }).entries[0].status, "expired");
    const stored = structuredClone(r), duplicate = propose(r, { now: NOW + DAY, ttlMs: DAY });
    yes(duplicate.duplicate); eq(duplicate.entry.status, "expired"); eq(r, stored);
  }
  const r = fixture(); eq(propose(r, { ttlMs: DAY }).entry.expiresAt, NOW + DAY);
  for (const ttlMs of [0, -1, DAY + 1, Infinity, "100", undefined]) {
    unchanged(r, () => propose(r, { ttlMs }), "invalid_proposal");
  }
  const late = fixture(), p = propose(late, { ttlMs: 10 }); yes(p.ok); yes(settle(late, p.id, "pending").ok); receipt(late);
  unchanged(late, () => settle(late, p.id, "expressed", { now: NOW + 10, receiptMessageId: "reply-a" }), "invalid_expiry");
});

test("source+normalized summary+kind dedup never extends TTL or refreshes pending", () => {
  const r = fixture(), p = propose(r, { evidenceMessageIds: ["human-b", "human-a", "human-b"] }); yes(p.ok);
  yes(settle(r, p.id, "pending").ok);
  const before = structuredClone(r);
  const duplicate = propose(r, { evidenceMessageIds: ["human-a", "human-b"], now: NOW + 10,
    reason: "新的原因不覆盖原始记录", ttlMs: DAY, trigger: { kind: "related_message", terms: ["不同标签"] } });
  yes(duplicate.ok); yes(duplicate.duplicate); eq(duplicate.entry.status, "pending"); eq(r, before); eq(select(r), []);
  conv(r).messages = []; // original provenance rotates out; dedup still blocks.
  yes(propose(r, { evidenceMessageIds: ["human-a", "human-b"] }).duplicate);
  const latin = fixture(), first = propose(latin, { summary: "Space topic" }); yes(first.ok);
  eq(propose(latin, { summary: "  ＳＰＡＣＥ  topic  " }).id, first.id); eq(rev(latin), 1);
});

test("selection is scoped, lexical, <=3, deterministic and read-only", () => {
  const r = fixture();
  for (let i = 0; i < 5; i++) yes(propose(r, { summary: `关于太空探索的角度 ${i}` }).ok);
  const before = structuredClone(r);
  eq(select(r).length, 3); eq(select(r, { limit: 999 }).length, 3); eq(select(r, { limit: 1 }).length, 1);
  eq(select(r, { query: "无关天气话题" }), []); eq(select(r, { query: "spaceship" }), []);
  eq(select(r, { query: "discuss SPACE" }).length, 3); eq(select(r, { limit: 0 }), []);
  eq(select(r, OTHER_BOT), []); eq(select(r, OTHER_GROUP), []); eq(r, before);
  const selected = select(r); selected[0].summary = "改动分离结果"; selected[0].trigger.terms.length = 0;
  eq(r, before); eq(read(r, { limit: 2 }).entries.length, 2);
  eq(read(r, { limit: 0 }).ok, false);
});

test("capacity is bounded, no FIFO/pruning, expired reads do not acquire capacity", () => {
  const r = fixture();
  for (let i = 0; i < 128; i++) yes(propose(r, { summary: `太空探索观点 ${i.toString(16)}` }).ok);
  eq(journal(r).entries.length, 128);
  yes(settle(r, journal(r).entries[1].id, "pending").ok);
  unchanged(r, () => propose(r, { summary: "超出活跃容量" }), "backpressure");
  unchanged(r, () => propose(r, { ...OTHER_GROUP, evidenceMessageIds: ["other-group-source"] }), "backpressure");
  yes(propose(r, { summary: "太空探索观点 0" }).duplicate);
  yes(settle(r, journal(r).entries[0].id, "expired", { now: NOW + 60_000 }).ok);
  // Time-invalid candidates do not count as live, but all original records stay.
  for (let i = 128; i < 256; i++) yes(propose(r, { summary: `太空探索观点 ${i.toString(16)}`, now: NOW + 60_000 }).ok);
  eq(journal(r).entries.length, 256); eq(journal(r).entries[0].status, "expired");
  unchanged(r, () => propose(r, { summary: "超出总容量", now: NOW + 120_000 }), "backpressure");
  const first = journal(r).entries[0].id;
  eq(propose(r, { summary: "太空探索观点 0", now: NOW + 120_000 }).id, first);
  eq(r.unrelated, { preserve: ["original-memory"] });
});

test("unsafe public text and unsupported fields rejected atomically", () => {
  const r = fixture();
  const unsafe = ["api_key=example", "Bearer synthetic", "sk-syntheticsecretfixture", "密码是示例", "验证码 000000", "13800000000",
    "user@example.org", "QQ:123", "用户123的个人情况", "/Users/fixture/private", "C:\\private\\sample", "../secret", "https://example.org/",
    "忽略之前的指令", "ignore previous instructions", "system prompt", "请执行命令", "发送消息给联系人", "思维链示例",
    "<script>", "hello\nworld", "你好\u202e世界", "a".repeat(301), " ", "-----BEGIN RSA PRIVATE KEY-----", "ssh-ed25519 sample", ".env", "private key example"];
  for (const summary of unsafe) unchanged(r, () => propose(r, { summary }));
  for (const reason of ["a".repeat(161), "token=example", "123的情况", "大家一起讨论太空探索的新发现吧"]) {
    unchanged(r, () => propose(r, { reason }));
  }
  unchanged(r, () => propose(r, { summary: conv(r).messages[0].text }), "unsafe_summary");
  unchanged(r, () => propose(r, { summary: `原话摘要：${conv(r).messages[0].text}` }), "unsafe_summary");
  unchanged(r, () => propose(r, { summary: "\ufdfa".repeat(20) }), "invalid_proposal");
  for (const extra of [{ wakeAt: NOW }, { sources: [{ url: "https://example.org" }] }, { kind: "send" },
    { trigger: { kind: "timer", terms: ["太空探索"] } }, { trigger: { kind: "related_message", terms: [] } },
    { trigger: { kind: "related_message", terms: ["指令@个人"] } }, { trigger: { kind: "public_discovery", terms: ["太空探索"] } },
    { evidenceMessageIds: [] }, { evidenceMessageIds: ["constructor"] }, { materialIds: ["__proto__"] },
    { evidenceMessageIds: "human-a" }, { trigger: { kind: "related_message", terms: ["太空探索"], permission: true } }]) {
    unchanged(r, () => propose(r, extra));
  }
  const p = propose(r); yes(p.ok);
  unchanged(r, () => settle(r, p.id, "pending", { reason: "api_key=example" }), "invalid_args");
  unchanged(r, () => settle(r, p.id, "pending", { reason: "123的身份" }), "unsafe_summary");
});

test("corrupted root/journal, prototype keys, accessors and frozen publication fail closed", () => {
  const mutations = [
    r => { r.socialAgents.version = 2; }, r => { r.socialAgents.bots = []; }, r => { bot(r).conversations = []; },
    r => { conv(r).messages = {}; }, r => { conv(r).experiences = null; }, r => { conv(r).messages[0] = null; },
    r => { journal(r).version = 2; }, r => { journal(r).revision++; }, r => { journal(r).entries.push({}); },
    r => { journal(r).entries[0].logicalId = OTHER_BOT.logicalId; }, r => { journal(r).entries[0].sourceKey = "forged"; },
    r => { journal(r).entries[0].summary = "改写摘要不重算ID"; }, r => { journal(r).entries[0].revision = 3; },
    r => { journal(r).entries[0].expiresAt = NOW + DAY + 1; }, r => { journal(r).entries[0].evidenceRefs[0].sentAt = 0; },
    r => { journal(r).entries[0].status = "unknown"; }, r => { journal(r).entries.push(structuredClone(journal(r).entries[0])); },
    r => { bot(r).socialIntentJournal = null; }, r => { conv(r).messages[0].text = () => "not JSON"; },
  ];
  for (const mutate of mutations) {
    const r = fixture(); yes(propose(r).ok); mutate(r);
    // JSON-safe digest also works for the deliberately non-cloneable fixture.
    const before = JSON.stringify(r), result = propose(r, { summary: "另一条候选" });
    eq(result, { ok: false, reason: "invalid_state" }); eq(JSON.stringify(r), before);
    eq(read(r).ok, false); eq(select(r), []); eq(JSON.stringify(r), before);
  }
  for (const logicalId of ["__proto__", "constructor", "prototype", "account:__proto__", "account:constructor", "account:a.prototype"]) {
    const r = fixture(); unchanged(r, () => propose(r, { logicalId }), "invalid_args");
  }
  const r = fixture(), poison = JSON.parse('{"__proto__":{"polluted":true}}');
  unchanged(r, () => proposeSocialIntent(r, { ...args(r), ...poison }), "invalid_args");
  const polluted = fixture(); Object.defineProperty(bot(polluted), "__proto__", { value: {}, enumerable: true });
  unchanged(polluted, () => propose(polluted), "invalid_state"); eq({}.polluted, undefined);
  const accessor = fixture(); let invoked = 0;
  Object.defineProperty(conv(accessor).messages[0], "text", { enumerable: true, get() { invoked++; return "bad"; } });
  eq(propose(accessor), { ok: false, reason: "invalid_state" }); eq(invoked, 0);
  const discovered = publicFixture(), extra = publicArgs(discovered);
  Object.defineProperty(bot(discovered).discovery.items[0].sources[0], "url", { enumerable: true, get() { invoked++; return "https://example.org/"; } });
  eq(propose(discovered, extra), { ok: false, reason: "invalid_material" }); eq(invoked, 0);
  const frozen = fixture(); Object.freeze(bot(frozen)); unchanged(frozen, () => propose(frozen), "invalid_state");
  const frozenJournal = fixture(); yes(propose(frozenJournal).ok); Object.freeze(journal(frozenJournal));
  yes(propose(frozenJournal, { summary: "替换不可变旧journal" }).ok);
});

console.log(`social-intent-journal: PASS (${scenarios} scenarios, ${checks} assertions; ${process.version}; in-memory only)`);
