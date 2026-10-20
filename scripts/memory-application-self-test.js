import assert from "node:assert/strict";
import { applyMemoryExtraction, groupMemoryValues, rememberGroupValue } from "../src/memory-application.js";
import { applyCanonicalCorrections, canonicalPromptLines, legacyMemoryValues, mergeCanonicalEvidence } from "../src/memory-integrity.js";

const CONVERSATION = "group:test";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const T3 = "2026-01-01T03:00:00.000Z";
let passed = 0;
function test(name, run) {
  try { run(); passed += 1; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
function msg(message_id = "m1", extra = {}) {
  return { message_id, user_id: "10001", conversation_id: CONVERSATION, sentAt: T1, sender: "小明", text: "我喜欢绿茶", ...extra };
}
function claim(value = "喜欢绿茶", extra = {}) {
  return { user_id: "10001", kind: "preference", value, confidence: 0.8, source_message_ids: ["m1"], ...extra };
}
function apply(group, patch, messages = [msg()], options = {}) {
  return applyMemoryExtraction(group, CONVERSATION, patch, messages, options);
}
function entry(user, value) {
  return user.canonicalMemory.entries.find((item) => item.value === value);
}
function reasons(result) { return result.rejected.flatMap((item) => item.reasonCodes); }
function commandContext(extra = {}) {
  return { callerAuthenticated: true, sourceUserId: "10001", sourceMessageId: "command1", sentAt: T1, ...extra };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (Object.hasOwn(descriptor, "value")) freeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

test("per-assertion IDs isolate simultaneous senders without whole-batch confirmation", () => {
  const group = {};
  const batch = [msg(), msg("m2", { user_id: "10002", sender: "小明", sentAt: T2, text: "我喜欢咖啡" }),
    msg("unused", { sentAt: T3, text: "无关消息" })];
  const patch = { canonical_entries: [claim(), claim("喜欢咖啡", { user_id: "10002", source_message_ids: ["m2"] }),
    claim("盗用别人的说法", { source_message_ids: ["m2"] })] };
  const result = apply(group, patch, batch);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(entry(group.users["10001"], "喜欢绿茶").evidenceConfirmations, 1);
  assert.equal(entry(group.users["10001"], "喜欢绿茶").status, "tentative");
  assert.deepEqual(entry(group.users["10001"], "喜欢绿茶").sourceMessageIds, ["m1"]);
  assert.equal(group.users["10001"].updatedAt, T1);
  assert.equal(group.users["10002"].updatedAt, T2);
  assert.equal(entry(group.users["10001"], "盗用别人的说法"), undefined);
  assert.equal(entry(group.users["10002"], "喜欢绿茶"), undefined);
});

test("replays and duplicate patch representations do not supply second evidence", () => {
  const group = {};
  const patch = { user_updates: [{ user_id: "10001", preferences: [{ value: "喜欢绿茶", confidence: 0.8, source_message_ids: ["m1"] }] }],
    canonical_entries: [claim()] };
  apply(group, patch);
  assert.equal(entry(group.users["10001"], "喜欢绿茶").evidenceConfirmations, 1);
  assert.equal(apply(group, patch).changed, false);
  apply(group, { canonical_entries: [claim("喜欢绿茶", { source_message_ids: ["m2"] })] }, [msg("m2", { sentAt: T2 })]);
  assert.equal(entry(group.users["10001"], "喜欢绿茶").status, "active");
  assert.equal(entry(group.users["10001"], "喜欢绿茶").evidenceConfirmations, 2);
  assert.deepEqual(group.users["10001"].preferences, ["喜欢绿茶"]);
});

test("bootstrap happens before mirrors and preserves original style/personality/legacy fields", () => {
  const style = ["短句", "喜欢使用比喻"];
  const personality = ["谨慎"];
  const group = { users: { "10001": { style, personality, preferences: ["喜欢模型"], updatedAt: T0, names: [] } } };
  apply(group, { canonical_entries: [claim()] });
  const user = group.users["10001"];
  assert.equal(user.style, style);
  assert.equal(user.personality, personality);
  assert.deepEqual(style, ["短句", "喜欢使用比喻"]);
  assert.deepEqual(personality, ["谨慎"]);
  assert.equal(entry(user, "喜欢模型").source, "legacy-canonical");
  assert.equal(entry(user, "喜欢绿茶").source, "ai-extraction");
  assert.equal(entry(user, "喜欢绿茶").status, "tentative");
  assert.deepEqual(legacyMemoryValues(user, "preferences", user.preferences), ["喜欢模型"]);
});

test("old string arrays become sanitized deduplicated proposals, never active raw data", () => {
  const group = {};
  const patch = { user_updates: [{ user_id: "10001", name: "AI伪造昵称", source_message_ids: ["m1"],
    preferences: ["喜欢绿茶", "喜欢绿茶", "喜欢绿茶。"], memes: ["密码:secret"], core_memes: ["模型梗"] }] };
  const options = { redact: (value) => value.replace(/secret/g, "[REDACTED]") };
  const result = apply(group, patch, [msg()], options);
  assert.equal(result.accepted.length, 0);
  assert.equal(group.users, undefined);
  assert.equal(group.memoryProposals.length, 3);
  assert.equal(JSON.stringify(group).includes("secret"), false);
  assert.equal(JSON.stringify(group).includes("AI伪造昵称"), false);
  assert.equal(group.memoryProposals.every((item) => item.sourceMessageIds.length === 0 && item.sentAt === null), true);
  assert.equal(apply(group, patch, [msg()], options).changed, false);
});

test("unknown subjects and forged IDs reject without creating user memory", () => {
  const group = {};
  const result = apply(group, { canonical_entries: [claim("未知", { user_id: "10002" }), claim("伪造", { source_message_ids: ["forged"] })],
    user_updates: [{ user_id: "10003", preferences: ["旧格式也不能凭空创建用户"] }] });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.proposed.length, 0);
  assert.equal(result.rejected.length, 3);
  assert.equal(result.changed, false);
  assert.deepEqual(group, {});
});

test("AI names never win; actual selected sender names and times determine nickname", () => {
  const group = { users: { "10001": { names: ["当前昵称"], lastName: "当前昵称", lastSeenAt: T3, updatedAt: T3, preferences: [] } } };
  apply(group, { user_updates: [{ user_id: "10001", name: "AI名字", preferences: [{ value: "喜欢绿茶", confidence: 0.8, source_message_ids: ["m1"] }] }] },
    [msg("m1", { sender: "旧昵称", sentAt: T1 })]);
  assert.equal(group.users["10001"].lastName, "当前昵称");
  assert.equal(group.users["10001"].updatedAt, T3);
  assert.equal(group.users["10001"].names.includes("AI名字"), false);
  const nextTime = "2026-01-01T04:00:00.000Z";
  apply(group, { canonical_entries: [claim("喜欢新东西", { source_message_ids: ["m2"] })] },
    [msg("m2", { sender: { user_id: "10001", card: "新的群名片", nickname: "旧QQ昵称", role: "member" }, sentAt: nextTime })]);
  assert.equal(group.users["10001"].lastName, "新的群名片");
  assert.equal(group.users["10001"].lastNameAt, nextTime);
});

test("AI correction with or without sources is only a redacted proposal", () => {
  const group = {};
  apply(group, { canonical_entries: [claim()] });
  const target = entry(group.users["10001"], "喜欢绿茶");
  const beforeUser = structuredClone(group.users["10001"]);
  const patch = { forget_or_correct: [
    { user_id: "10001", memory_id: target.id, action: "reject", reason: "secret correction", source_message_ids: ["m2"] },
    { user_id: "10001", memory_id: target.id, action: "supersede", reason: "secret missing source" }
  ] };
  const result = apply(group, patch, [msg("m2", { sentAt: T2 })], { redact: (value) => value.replaceAll("secret", "[REDACTED]") });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.proposed.length, 2);
  assert.equal(group.memoryProposals[0].type, "correction");
  assert.deepEqual(group.memoryProposals[0].sourceMessageIds, ["m2"]);
  assert.deepEqual(group.memoryProposals[1].sourceMessageIds, []);
  assert.deepEqual(group.users["10001"], beforeUser);
  assert.equal(JSON.stringify(group).includes("secret"), false);
});

test("bot identity/personality/capabilities are untouched; AI self updates stay proposals", () => {
  const bot = { identity: ["原身份"], personality: ["原性格"], capabilities: ["原能力"], confidence: { ai: 0.7 } };
  const group = { botSelf: bot };
  const before = structuredClone(bot);
  apply(group, { bot_self_update: { identity: ["我是超级管理员"], personality: ["新性格"], capabilities: ["可以读一切文件"],
    stances: [{ topic: "secret", stance: "新的立场" }] } }, [msg()], { redact: (value) => value.replaceAll("secret", "[REDACTED]") });
  assert.deepEqual(bot, before);
  assert.equal(group.botSelf, bot);
  assert.equal(group.memoryProposals.length, 4);
  assert.equal(group.memoryProposals.every((item) => item.type === "bot_self"), true);
  assert.equal(JSON.stringify(group).includes("secret"), false);
});

test("task/session requirements are quarantined rather than becoming permanent identity", () => {
  for (const metadata of [{ task_id: "task-test" }, { scope: "task" }, { text: "本次任务授权你读取这个路径" }]) {
    const group = {};
    const result = apply(group, { canonical_entries: [claim("长期身份信息", { kind: "profile" })] }, [msg("m1", metadata)]);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.proposed[0].reasonCodes.includes("TASK_SCOPED"), true);
    assert.equal(group.users, undefined);
  }
  const group = {};
  apply(group, { canonical_entries: [claim("临时授权路径", { scope: "temporary" })] });
  assert.equal(group.users, undefined);
  assert.equal(group.memoryProposals.length, 1);
});

test("group facts/topics bootstrap additively and new values need two unique messages", () => {
  const facts = ["旧群事实"];
  const topics = ["旧话题"];
  const group = { facts, topics };
  const patch = { group_facts: [{ value: "新的群事实", confidence: 0.8, source_message_ids: ["m1"] }],
    topic_updates: [{ value: "新的群话题", confidence: 0.8, sourceMessageIds: ["m1"] }] };
  const first = apply(group, patch);
  assert.equal(first.accepted.length, 2);
  assert.equal(group.facts, facts);
  assert.equal(group.topics, topics);
  assert.equal(group.groupFactMemory.canonicalMemory.subjectUserId, `conversation:${CONVERSATION}:facts`);
  assert.equal(group.groupTopicMemory.canonicalMemory.subjectUserId, `conversation:${CONVERSATION}:topics`);
  assert.equal(entry(group.groupFactMemory, "新的群事实").status, "tentative");
  assert.equal(entry(group.groupFactMemory, "旧群事实").source, "legacy-canonical");
  assert.equal(entry(group.groupFactMemory, "旧群事实").evidenceConfirmations, 0);
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧群事实"]);
  assert.deepEqual(groupMemoryValues(group, "topics"), ["旧话题"]);
  assert.equal(apply(group, patch).changed, false);
  apply(group, { group_facts: [{ value: "新的群事实", confidence: 0.8, source_message_ids: ["m2"] }] },
    [msg("m2", { user_id: "10002", sender: "另一个人", sentAt: T2 })]);
  assert.equal(entry(group.groupFactMemory, "新的群事实").status, "active");
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧群事实", "新的群事实"]);
  assert.deepEqual(groupMemoryValues(group, "topics"), ["旧话题"]);
});

test("group evidence uses only explicit eligible IDs, including multiple actual humans", () => {
  const group = {};
  const batch = [msg(), msg("m2", { user_id: "10002", sentAt: T2 }), msg("bot", { user_id: "90001", isBot: true }),
    msg("quote", { reply: { message_id: "old", text: "旧话" } })];
  const patch = { group_facts: [
    { value: "真实群共识", confidence: 0.8, source_message_ids: ["m1", "m2"] },
    { value: "伪造", confidence: 0.8, source_message_ids: ["forged"] },
    { value: "bot说的", confidence: 0.8, source_message_ids: ["bot"] },
    { value: "引用的", confidence: 0.8, source_message_ids: ["quote"] }
  ] };
  const result = apply(group, patch, batch, { botUserIds: ["90001"] });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.equal(entry(group.groupFactMemory, "真实群共识").evidenceConfirmations, 2);
  assert.equal(entry(group.groupFactMemory, "真实群共识").status, "active");
  assert.deepEqual(groupMemoryValues(group, "facts"), ["真实群共识"]);
});

test("unattributed group strings/objects cannot bypass via raw arrays", () => {
  const group = { facts: ["旧事实"], topics: ["旧话题"] };
  const result = apply(group, { group_facts: ["新字符串事实", { value: "缺来源的新事实", confidence: 0.8 }], topic_updates: ["新话题"] });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.proposed.length, 3);
  assert.deepEqual(group.facts, ["旧事实"]);
  assert.deepEqual(group.topics, ["旧话题"]);
  assert.equal(group.groupFactMemory, undefined);
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧事实"]);
  assert.deepEqual(groupMemoryValues(group, "facts", { integrity: undefined }), ["旧事实"], "omitted optional bridge settings preserve legacy memories");
  assert.deepEqual(groupMemoryValues(group, "facts", { integrity: null }), [], "explicit malformed policy still fails closed");
});

test("AI explicit and requireEvidence=false do not grant group management authority", () => {
  const group = {};
  apply(group, { group_facts: [{ value: "单次群事实", confidence: 0.9, explicit: true, source_message_ids: ["m1"] }] },
    [msg()], { integrity: { requireEvidence: false } });
  assert.equal(entry(group.groupFactMemory, "单次群事实").status, "tentative");
  assert.deepEqual(groupMemoryValues(group, "facts"), []);
  // Management commands are a separate explicitly authorized parent path.
  const subject = `conversation:${CONVERSATION}:facts`;
  mergeCanonicalEvidence(group.groupFactMemory, { user_id: subject, profile: ["单次群事实"], confidence: 0.9 },
    { subjectUserId: subject, conversationId: CONVERSATION, sourceMessageIds: [], sentAt: T3, explicit: true });
  assert.deepEqual(groupMemoryValues(group, "facts"), ["单次群事实"]);
});

test("group projections exclude corrected and newly appended unknown mirrors only", () => {
  const group = { facts: ["旧事实甲", "旧事实乙"] };
  apply(group, { group_facts: [{ value: "新事实", confidence: 0.8, source_message_ids: ["m1"] }] });
  const target = entry(group.groupFactMemory, "旧事实甲");
  applyCanonicalCorrections(group.groupFactMemory, [{ memory_id: target.id, action: "reject" }],
    { subjectUserId: `conversation:${CONVERSATION}:facts`, sentAt: T2 });
  group.facts.push("不明镜像");
  const before = structuredClone(group);
  freeze(group);
  assert.deepEqual(groupMemoryValues(group, "group_facts"), ["旧事实乙"]);
  assert.deepEqual(groupMemoryValues(group, "unknown"), []);
  assert.deepEqual(group, before);
});

test("old group compatibility is read-only; invalid wrappers fail closed", () => {
  const group = freeze({ facts: ["旧事实", "旧事实"], topics: ["旧话题"] });
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧事实"]);
  assert.deepEqual(groupMemoryValues(group, "topicUpdates"), ["旧话题"]);
  assert.equal(Object.hasOwn(group, "groupFactMemory"), false);
  assert.deepEqual(groupMemoryValues({ ...group, groupFactMemory: null }, "facts"), []);
  assert.deepEqual(groupMemoryValues(group, "facts", { integrity: { promptMinConfidence: NaN } }), []);
});

test("summary context carries genuine batch provenance but confirms no facts", () => {
  const group = { rollingSummary: "旧上下文" };
  const batch = [msg(), msg("m2", { user_id: "10002", sentAt: T2 }), msg("bot", { isBot: true, sentAt: T3 })];
  const patch = { summary_delta: "新上下文" };
  const result = apply(group, patch, batch);
  assert.equal(result.accepted.length, 1);
  assert.equal(group.rollingSummary, "旧上下文；新上下文");
  assert.deepEqual(group.summaryEvidence[0], { value: "新上下文", conversationId: CONVERSATION,
    sourceMessageIds: ["m1", "m2"], sourceUserIds: ["10001", "10002"], sentAt: T2 });
  assert.equal(group.users, undefined);
  assert.equal(group.groupFactMemory, undefined);
  assert.equal(apply(group, patch, batch).changed, false);
  apply(group, patch, [msg("m3", { sentAt: T3 })]);
  assert.equal(group.summaryEvidence.length, 2);
  assert.equal(group.rollingSummary, "旧上下文；新上下文");
});

test("summary without eligible event time and forged explicit summary sources is rejected", () => {
  const group = { rollingSummary: "保留" };
  assert.equal(apply(group, { summary_delta: "不能凭空记录" }, []).changed, false);
  assert.equal(apply(group, { summary_delta: { value: "伪造来源", source_message_ids: ["forged"] } }).changed, false);
  assert.deepEqual(group, { rollingSummary: "保留" });
});

test("candidate/proposal/summary capacity rejects overflow without deleting old state", () => {
  const oldStyle = Array.from({ length: 190 }, (_, index) => `原风格${index}`);
  const group = { users: { "10001": { style: oldStyle } } };
  const patch = { canonical_entries: Array.from({ length: 5 }, (_, index) => claim(`偏好${index}`)) };
  const result = apply(group, patch, [msg()], { integrity: { maxCandidatesPerPatch: 2, maxEntriesPerUser: 1 } });
  assert.equal(result.accepted.length, 2);
  assert.equal(result.rejected.filter((item) => item.reasonCodes.includes("CANDIDATE_LIMIT")).length, 3);
  assert.equal(group.users["10001"].style, oldStyle);
  assert.equal(oldStyle.length, 190);
  assert.equal(group.users["10001"].canonicalMemory.entries.length, 192);
  apply(group, { group_facts: ["候选甲", "候选乙"] });
  const oldProposals = structuredClone(group.memoryProposals);
  assert.equal(reasons(apply(group, { group_facts: ["候选丙"] }, [msg()], { integrity: { maxProposalsPerGroup: 1 } })).includes("PROPOSAL_LIMIT"), true);
  assert.deepEqual(group.memoryProposals, oldProposals);
  apply(group, { summary_delta: "摘要甲" });
  const before = structuredClone(group.summaryEvidence);
  assert.equal(reasons(apply(group, { summary_delta: "摘要乙" }, [msg("m2", { sentAt: T2 })], { integrity: { maxSummaryEvidence: 1 } })).includes("SUMMARY_EVIDENCE_LIMIT"), true);
  assert.deepEqual(group.summaryEvidence, before);
});

test("redaction covers accepted/proposed values, summaries and actual names", () => {
  const group = {};
  const redact = (value) => value.replaceAll("SECRET", "[REDACTED]");
  apply(group, { canonical_entries: [claim("喜欢SECRET")], group_facts: ["SECRET群候选"],
    bot_self_update: { identity: ["SECRET身份"] }, summary_delta: "SECRET摘要" },
  [msg("m1", { sender: "SECRET昵称" })], { redact });
  assert.equal(JSON.stringify(group).includes("SECRET"), false);
  assert.equal(group.users["10001"].lastName, "[REDACTED]昵称");
  assert.equal(group.memoryProposals.every((item) => item.value.includes("[REDACTED]")), true);
  const noRedactor = {};
  apply(noRedactor, { user_updates: [{ user_id: "10001", profile: ["密码:secret-password"] }] });
  assert.equal(JSON.stringify(noRedactor).includes("secret-password"), false);
});

test("redactor failures reject items without leaking originals or half-initializing users", () => {
  for (const redact of [() => { throw new Error("secret"); }, () => null, () => "", () => "\u0000"]) {
    const group = {};
    const result = apply(group, { canonical_entries: [claim("secret")] }, [msg()], { redact });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.changed, false);
    assert.deepEqual(group, {});
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("invalid/prototype/NaN/unknown inputs fail closed and leave existing data alone", () => {
  const patches = [JSON.parse('{"__proto__":{"polluted":true},"group_facts":["x"]}'),
    { canonical_entries: [claim("NaN", { confidence: NaN })] }, { confidence: 2, summary_delta: "bad" },
    Object.assign(Object.create({ user_updates: [] }), { group_facts: [] })];
  for (const patch of patches) {
    const group = { facts: ["旧事实"], rollingSummary: "旧摘要" };
    const before = structuredClone(group);
    assert.equal(apply(group, patch).changed, false);
    assert.deepEqual(group, before);
  }
  assert.equal({}.polluted, undefined);
  const group = {};
  assert.equal(reasons(apply(group, { unsupported: "secret" })).includes("UNSUPPORTED_FIELD"), true);
  assert.equal(apply(group, { canonical_entries: [claim()] }, [msg()], { integrity: { maxCandidatesPerPatch: -1 } }).changed, false);
  assert.equal(apply(group, { canonical_entries: [claim()] }, [msg()], { integrity: { minStableConfidence: NaN } }).changed, false);
  assert.deepEqual(group, {});
  assert.equal(apply(group, { canonical_entries: [claim()] }, [msg("m1", { task_id: "task", extra: NaN })]).changed, false);
  for (const canonicalMemory of [[], { entries: {} }, { entries: [null] }]) {
    const malformed = { users: { "10001": { canonicalMemory, preferences: ["保留旧值"] } } };
    const before = structuredClone(malformed);
    assert.equal(apply(malformed, { canonical_entries: [claim()] }).changed, false);
    assert.deepEqual(malformed, before);
  }
});

test("legacy group source aliases, foreign conversation and numeric confidence fail closed", () => {
  const group = { facts: ["保留旧事实"] };
  for (const candidate of [
    { value: "bad", source_message_ids: null, sourceMessageIds: ["m1"], confidence: 0.8 },
    { value: "bad", source_message_ids: ["m1"], conversation_id: "group:other", confidence: 0.8 },
    { value: "bad", source_message_ids: ["m1"], confidence: "0.8" },
    { value: "bad", source_message_ids: ["m1"], confidence: 2 }
  ]) {
    const before = structuredClone(group);
    const result = apply(group, { group_facts: [candidate] });
    assert.equal(result.changed, false);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(group, before);
  }
});

test("foreign stored user identity and accessors cannot rebind or execute", () => {
  const group = { users: { "10001": { user_id: "10002", style: ["保留另一个人的风格"] } } };
  const before = structuredClone(group);
  const result = apply(group, { canonical_entries: [claim()] });
  assert.equal(result.changed, false);
  assert.equal(reasons(result).includes("INVALID_USER_STATE"), true);
  assert.deepEqual(group, before);
  let reads = 0;
  const patch = {};
  Object.defineProperty(patch, "user_updates", { get() { reads += 1; throw new Error("must not execute"); } });
  assert.equal(apply({}, patch).changed, false);
  const raw = msg();
  Object.defineProperty(raw, "text", { get() { reads += 1; throw new Error("must not execute"); } });
  assert.equal(apply({}, { canonical_entries: [claim()] }, [raw]).changed, false);
  assert.equal(reads, 0);
});

test("application mutates only supplied draft, not frozen patch/messages or other users", () => {
  const untouched = { style: ["原有风格"], personality: ["原有画像"] };
  const group = { users: { "10002": untouched } };
  const beforeOther = structuredClone(untouched);
  const patch = freeze({ canonical_entries: [claim()] });
  const messages = freeze([msg()]);
  const beforePatch = structuredClone(patch);
  const beforeMessages = structuredClone(messages);
  apply(group, patch, messages);
  assert.deepEqual(patch, beforePatch);
  assert.deepEqual(messages, beforeMessages);
  assert.equal(group.users["10002"], untouched);
  assert.deepEqual(untouched, beforeOther);
  assert.deepEqual(canonicalPromptLines(group.users["10001"]), []);
});

test("all persisted times are independent of the processing clock", () => {
  const RealDate = globalThis.Date;
  function underClock(clock) {
    class DifferentClock extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.parse(clock)])); }
      static now() { return RealDate.parse(clock); }
    }
    try {
      globalThis.Date = DifferentClock;
      const group = { facts: ["旧事实"] };
      apply(group, { canonical_entries: [claim()], group_facts: [{ value: "新事实", confidence: 0.8, source_message_ids: ["m1"] }],
        summary_delta: "上下文摘要" });
      return group;
    } finally { globalThis.Date = RealDate; }
  }
  const first = underClock("2099-01-01T00:00:00.000Z");
  assert.deepEqual(first, underClock("2100-01-01T00:00:00.000Z"));
  assert.equal(first.users["10001"].updatedAt, T1);
  assert.equal(first.summaryEvidence[0].sentAt, T1);
});

test("unrelated >100k job nodes never invalidate a small patch or prompt projection", () => {
  // 120k job objects plus their scalar nodes; intentionally beyond patch budget.
  const jobs = Array.from({ length: 60_000 }, (_, index) => ({ id: index, observation: { state: "queued" } }));
  const group = { facts: ["旧群事实"], memoryExtractionJobs: jobs, users: { "10002": { unrelatedArchive: jobs } } };
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧群事实"]);
  const result = apply(group, { canonical_entries: [claim()] });
  assert.equal(result.changed, true);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.fatalErrors, []);
  assert.equal(group.memoryExtractionJobs, jobs);
  assert.equal(group.users["10002"].unrelatedArchive, jobs);
  apply(group, { group_facts: [{ value: "新群事实", confidence: 0.8, source_message_ids: ["m1"] }] });
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧群事实"]);
  const remembered = rememberGroupValue(group, CONVERSATION, "topics", "管理话题", commandContext());
  assert.equal(remembered.ok, true);
  assert.deepEqual(groupMemoryValues(group, "topics"), ["管理话题"]);
});

test("unrelated archives/accessors/other users are not traversed", () => {
  let reads = 0;
  const group = { facts: ["旧事实"], users: {}, unrelated: { invalid: NaN } };
  Object.defineProperty(group, "memoryExtractionJobs", { get() { reads += 1; throw new Error("unrelated job read"); } });
  Object.defineProperty(group.users, "10002", { get() { reads += 1; throw new Error("other user read"); } });
  assert.deepEqual(groupMemoryValues(group, "facts"), ["旧事实"]);
  const result = apply(group, { canonical_entries: [claim()] });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.changed, true);
  assert.equal(reads, 0);
  const fact = rememberGroupValue(group, CONVERSATION, "facts", "管理事实", commandContext());
  assert.equal(fact.ok, true);
  assert.equal(reads, 0);
});

test("fatal top-level schema errors are distinct from rejected individual assertions", () => {
  const group = {};
  const invalid = apply(group, { canonical_entries: [claim()], group_facts: "not an array" });
  assert.equal(invalid.fatalErrors.length, 1);
  assert.equal(invalid.fatalErrors[0].reasonCodes.includes("INVALID_ARRAY"), true);
  assert.equal(invalid.changed, false);
  assert.deepEqual(group, {});
  const rejected = apply(group, { canonical_entries: [claim("bad", { source_message_ids: ["forged"] }), claim()] });
  assert.deepEqual(rejected.fatalErrors, []);
  assert.equal(rejected.rejected.length, 1);
  assert.equal(rejected.accepted.length, 1);
  const tooLarge = apply(group, { group_facts: Array.from({ length: 100_001 }, () => "candidate") });
  assert.equal(tooLarge.fatalErrors.length, 1, "patch input still has a strict budget");
  assert.equal(tooLarge.changed, false);
});

test("remember requires authenticated caller, never an arbitrary AI explicit flag", () => {
  for (const context of [undefined, {}, { explicit: true }, commandContext({ callerAuthenticated: false, explicit: true }),
    commandContext({ callerAuthenticated: "true" }), Object.assign(Object.create({ callerAuthenticated: true }), { sourceUserId: "10001" })]) {
    const group = { facts: ["保留旧事实"] };
    const before = structuredClone(group);
    let redactions = 0;
    const receipt = rememberGroupValue(group, CONVERSATION, "facts", "禁止写入", context,
      { redact: (value) => { redactions += 1; return value; } });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.changed, false);
    assert.equal(receipt.reasonCodes.includes("CALLER_NOT_AUTHENTICATED"), true);
    assert.equal(redactions, 0);
    assert.deepEqual(group, before);
  }
});

test("remember requires exact sourceUserId/sourceMessageId/zoned sentAt, with no fallback", () => {
  const invalidContexts = [
    { callerAuthenticated: true, sourceMessageId: "command1", sentAt: T1 },
    { callerAuthenticated: true, sourceUserId: "10001", sentAt: T1 },
    { callerAuthenticated: true, sourceUserId: "10001", sourceMessageId: "command1", receivedAt: T3 },
    commandContext({ sourceUserId: "昵称" }), commandContext({ sourceMessageId: "" }),
    commandContext({ sentAt: "2026-01-01" }), commandContext({ sentAt: Date.parse(T1) }),
    commandContext({ senderUserId: "10002" }), commandContext({ role: "assistant" }), commandContext({ isBot: true }),
    commandContext({ conversationId: "group:other" })
  ];
  for (const context of invalidContexts) {
    const group = {};
    const result = rememberGroupValue(group, CONVERSATION, "facts", "不能写入", context);
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.deepEqual(group, {});
  }
});

test("remember bootstraps legacy first, writes explicit evidence once and preserves raw history", () => {
  const facts = Array.from({ length: 190 }, (_, index) => `旧事实${index}`);
  const group = { facts, topics: ["旧话题"], botSelf: { identity: ["原身份"] } };
  const first = rememberGroupValue(group, CONVERSATION, "facts", "管理新增事实", commandContext(), { integrity: { maxEntriesPerUser: 2 } });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.status, "active");
  assert.equal(first.context.explicit, true);
  assert.equal(first.context.sourceUserId, "10001");
  assert.deepEqual(first.context.sourceMessageIds, ["command1"]);
  assert.equal(first.context.sentAt, T1);
  assert.equal(group.facts, facts);
  assert.equal(facts.length, 191);
  assert.equal(entry(group.groupFactMemory, "旧事实0").source, "legacy-canonical");
  assert.equal(entry(group.groupFactMemory, "旧事实0").evidenceConfirmations, 0);
  assert.equal(entry(group.groupFactMemory, "管理新增事实").source, "explicit");
  assert.equal(entry(group.groupFactMemory, "管理新增事实").evidenceConfirmations, 1);
  assert.equal(group.groupFactMemory.canonicalMemory.entries.length, 191);
  const before = structuredClone(group);
  const wrapperBeforeReplay = group.groupFactMemory;
  const replay = rememberGroupValue(group, CONVERSATION, "group_facts", "管理新增事实", commandContext({ sentAt: T3 }));
  assert.equal(replay.ok, true);
  assert.equal(replay.changed, false);
  assert.equal(group.groupFactMemory, wrapperBeforeReplay);
  assert.equal(entry(group.groupFactMemory, "管理新增事实").explicitAt, T1);
  assert.deepEqual(group, before);
  assert.equal(groupMemoryValues(group, "facts").includes("管理新增事实"), true);
});

test("remember respects explicit event ordering and terminal corrections", () => {
  const group = { facts: ["无关旧事实"] };
  rememberGroupValue(group, CONVERSATION, "facts", "不喜欢绿茶", commandContext({ sourceMessageId: "new", sentAt: T2 }));
  const old = rememberGroupValue(group, CONVERSATION, "facts", "喜欢绿茶", commandContext({ sourceMessageId: "old", sentAt: T1 }));
  assert.equal(old.ok, true);
  assert.equal(old.status, "superseded");
  assert.deepEqual(groupMemoryValues(group, "facts"), ["无关旧事实", "不喜欢绿茶"]);
  const target = entry(group.groupFactMemory, "不喜欢绿茶");
  applyCanonicalCorrections(group.groupFactMemory, [{ memory_id: target.id, action: "reject" }],
    { subjectUserId: `conversation:${CONVERSATION}:facts`, sentAt: T3 });
  const before = structuredClone(group);
  const rejected = rememberGroupValue(group, CONVERSATION, "facts", "不喜欢绿茶", commandContext({ sourceMessageId: "attempt", sentAt: "2026-01-01T04:00:00.000Z" }));
  assert.equal(rejected.reasonCodes.includes("TERMINAL_CORRECTION"), true);
  assert.equal(rejected.changed, false);
  assert.deepEqual(group, before);
});

test("remember redaction failures and foreign wrappers do not partially bootstrap", () => {
  const group = { facts: ["旧事实"] };
  const before = structuredClone(group);
  const result = rememberGroupValue(group, CONVERSATION, "facts", "SECRET", commandContext(), { redact: () => { throw new Error("private"); } });
  assert.equal(result.changed, false);
  assert.deepEqual(group, before);
  const success = rememberGroupValue(group, CONVERSATION, "facts", "SECRET", commandContext(), { redact: (value) => value.replaceAll("SECRET", "已脱敏") });
  assert.equal(success.value, "已脱敏");
  assert.equal(JSON.stringify(group).includes("SECRET"), false);
  const foreignBefore = structuredClone(group);
  assert.equal(rememberGroupValue(group, "group:other", "facts", "跨群", commandContext()).changed, false);
  assert.deepEqual(group, foreignBefore);
});

console.log(JSON.stringify({ ok: true, tests: passed, suite: "memory-application" }));
