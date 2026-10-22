import assert from "node:assert/strict";
import { memoryLearningConfig, shouldExtractMemoryBatch, prepareLearningMessages, memoryValidity,
  selectRelevantMemoryEntries, selectRelevantMemoryValues, summarizeMemoryDiscussion } from "../src/memory-learning.js";
import { prepareMemoryEvidenceBatch } from "../src/memory-evidence.js";

// Synthetic data only. No bridge, runtime roots, fixtures on disk or network.
const NOW = Date.parse("2026-10-21T12:00:00Z");
const ISO = new Date(NOW).toISOString();
const old = "2020-01-01T00:00:00Z";
const message = (id, text = "我喜欢喝黑咖啡。", extra = {}) => ({ message_id: String(id), user_id: "u1",
  sentAt: ISO, receivedAt: NOW - 6000, text, ...extra });
const entry = (id, value, extra = {}) => ({ id, subjectUserId: "u1", status: "active", confidence: 0.9,
  kind: "preference", value, firstSeenAt: old, ...extra });
const decide = (messages, config, now = NOW) => shouldExtractMemoryBatch(messages, { now, config });
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test("normalized defaults and legacy floor four", () => {
  assert.deepEqual(memoryLearningConfig(), { enabled: true, maxWaitMs: 120000, minBatchMessages: 4,
    maxBatchMessages: 16, maxMessageChars: 4000, maxBatchChars: 12000, settleMs: 5000 });
  const config = memoryLearningConfig({ memory: { aiExtraction: { everyMessages: 1 }, learning: {
    minBatchMessages: 2, maxBatchMessages: 1, maxBatchChars: 20, maxMessageChars: 30,
    maxWaitMs: 100, settleMs: 500, enabled: false } } });
  assert.equal(config.minBatchMessages, 4);
  assert.equal(config.maxBatchMessages, 4);
  assert.equal(config.maxMessageChars, 20);
  assert.equal(config.settleMs, 100);
  assert.equal(config.enabled, false);
  assert.equal(memoryLearningConfig({ maxWaitMs: NaN }).maxWaitMs, 120000);
  assert.equal(memoryLearningConfig({ maxWaitMs: 100 }).settleMs, 100);
  assert.equal(memoryLearningConfig({ memory: { aiExtraction: { everyMessages: 9 } } }).minBatchMessages, 9);
  assert.equal(memoryLearningConfig({ minBatchMessages: 100, maxBatchMessages: 100 }).minBatchMessages, 16);
  assert.equal(memoryLearningConfig({ minBatchMessages: 100, maxBatchMessages: 100 }).maxBatchMessages, 16);
  assert.equal(memoryLearningConfig({ maxBatchMessages: 100 }).maxBatchMessages, 16);
});

test("four complete messages settle, no per-event extraction", () => {
  const messages = Array.from({ length: 4 }, (_, id) => message(id));
  assert.equal(decide(messages).reason, "settled-turns");
  assert.equal(decide(messages.map(row => ({ ...row, receivedAt: NOW - 4999 }))).reason, "settling");
});

test("partial turn fragments wait; later completion closes same speaker", () => {
  const fragments = ["我感觉", "这个东西", "但是", "因为"].map((text, id) => message(id, text));
  assert.equal(decide(fragments).ready, false);
  assert.equal(decide(fragments).reason, "incomplete-turn");
  assert.equal(decide([...fragments, message(4, "我已经说完了。")]).ready, true);
  assert.equal(decide([...fragments, message(4, "我说完了。", { user_id: "u2" })]).ready, false);
});

test("one to three messages eventually flush, including fragments", () => {
  for (let count = 1; count <= 3; count++) {
    const rows = Array.from({ length: count }, (_, id) => message(id, "但是", { receivedAt: NOW - 119999 }));
    assert.equal(decide(rows).ready, false);
    assert.deepEqual(decide(rows, undefined, NOW + 1), { ready: true, reason: "max-wait", batchSize: count });
  }
});

test("only receipt/enqueue times drive waits, never sentAt/at", () => {
  assert.equal(decide([message(1, "完整消息。", { sentAt: old, receivedAt: NOW - 1 })]).ready, false);
  assert.equal(decide([message(1, "但是", { receivedAt: NOW - 120000, sentAt: ISO })]).ready, true);
  const rows = [message(1, "但是", { receivedAt: undefined, enqueuedAt: NOW - 120000 })];
  assert.equal(decide(rows).reason, "max-wait");
  assert.equal(decide([message(1, "但是", { receivedAt: undefined, at: NOW })]).reason, "unknown-queue-time");
  assert.equal(shouldExtractMemoryBatch([message(1)]).reason, "invalid-now");
  const mixed = Array.from({ length: 4 }, (_, id) => message(id, "说完了。", { enqueuedAt: NOW - 1 }));
  assert.equal(decide(mixed).reason, "settling");
});

test("unknown event chronology stays unknown despite receipt time", () => {
  const row = message("unknown", "咖啡。", { sentAt: "" });
  const prepared = prepareLearningMessages([row]);
  assert.equal(prepared.messages[0].sentAt, "");
  assert.equal(prepared.messages[0].evidenceEligible, false);
  const summary = summarizeMemoryDiscussion([row]);
  assert.equal(summary.sequence[0].sentAt, null);
  assert.equal(summary.sequence[0].sourceTimeKnown, false);
});

test("quiet/reply-disabled flags do not disable learning", () => {
  const rows = Array.from({ length: 4 }, (_, id) => message(id));
  assert.equal(decide(rows, { behavior: { quiet: true }, memory: { learning: { enabled: true } }, chat: { enabled: false } }).ready, true);
  assert.equal(decide(rows, { memory: { learning: { enabled: false } } }).reason, "disabled");
  assert.equal(decide([]).reason, "empty");
});

test("bounded batch capacity/backpressure retains original prefix ownership", () => {
  const rows = Array.from({ length: 25 }, (_, id) => message(id, "这个东西"));
  const decision = decide(rows);
  assert.equal(decision.reason, "capacity");
  assert.equal(decision.batchSize, 16);
  const result = prepareLearningMessages(rows);
  assert.equal(result.messages.length, 16);
  assert.equal(result.deferredMessageCount, 9);
  assert.equal(result.nextIndex, 16);
  assert.deepEqual(result.messages.map(row => row.message_id), rows.slice(0, 16).map(row => row.message_id));
  const long = rows.map(row => ({ ...row, text: "中".repeat(4000) }));
  assert.equal(decide(long).batchSize, 3);
  assert.equal(prepareLearningMessages(long).totalChars, 12000);
  assert.equal(prepareLearningMessages(long).deferredMessageCount, 22);
});

test("batch-size callback recomputes bounds from freshest admitted raw inputs", () => {
  const stale = Array.from({ length: 4 }, (_, id) => message(id, "中".repeat(4000)));
  const admitted = freeze([stale[0], stale[1], message("fresh-a", "新".repeat(1000)), message("fresh-b", "新".repeat(1000))]);
  const batchSize = (_id, admittedRawInputs) => shouldExtractMemoryBatch(admittedRawInputs, { now: NOW }).batchSize;
  assert.equal(decide(stale).batchSize, 3);
  assert.equal(batchSize("group:fake", admitted), 4);
  const projection = prepareLearningMessages(admitted.slice(0, batchSize("group:fake", admitted)));
  assert.equal(projection.deferredMessageCount, 0);
  assert.ok(projection.renderedChars <= 12000);
});

test("head/middle/tail excerpts explicitly mark omission and preserve final corrections", () => {
  const text = "原先说喜欢。" + "前".repeat(6000) + "这是中间语义。" + "后".repeat(6000) + "纠正：我不喜欢咖啡，不要记成喜欢。";
  const result = prepareLearningMessages([message("m-original", text)]);
  const row = result.messages[0];
  assert.ok(row.text.startsWith("原先说喜欢。"));
  assert.ok(row.text.includes("这是中间语义。"));
  assert.ok(row.text.endsWith("纠正：我不喜欢咖啡，不要记成喜欢。"));
  assert.ok(row.text.includes("[原文省略]"));
  assert.equal(row.truncated, true);
  assert.equal(row.evidenceEligible, false);
  assert.ok(row.omittedRanges.length > 0);
  assert.ok(row.retainedChars <= 4000);
  assert.ok(row.segments.every(segment => segment.sourceMessageId === "m-original" && segment.text.length <= 512));
  assert.equal(new Set(row.segments.map(segment => segment.sourceMessageId)).size, 1);
  assert.ok(row.segments.every(segment => text.slice(segment.start, segment.end) === segment.text));
});

test("complete original text/negation and evidence identity survive semantic segmentation", () => {
  const text = "我不" + "太".repeat(2800) + "喜欢咖啡。只是引用别人的喜好，不是我自己的。";
  const row = prepareLearningMessages([message(42, text, { time: NOW / 1000, replyContexts: [{ quoted: true }] })]).messages[0];
  assert.equal(row.text, text);
  assert.equal(row.segments.map(segment => segment.text).join(""), text);
  assert.equal(row.message_id, "42");
  assert.equal(row.sourceMessageId, "42");
  assert.equal(row.time, NOW / 1000);
  assert.equal(row.sentAt, ISO);
  assert.equal(row.replyContexts, true);
  assert.equal(row.isQuoted, true);
  assert.equal(row.evidenceEligible, false);
  assert.equal(row.truncated, false);
});

test("quote flags/OneBot replies/forwards and source roles cannot become new evidence", () => {
  for (const extra of [{ quote: "他人原话" }, { isQuoted: true }, { forwarded: true },
    { message: [{ type: "reply", data: { id: "quoted" } }] }]) {
    const row = prepareLearningMessages([message(1, "原话", extra)]).messages[0];
    assert.equal(row.isQuoted, true);
    assert.equal(row.evidenceEligible, false);
  }
  const row = prepareLearningMessages([message(2, "文本", { role: "assistant", is_bot: true })]).messages[0];
  assert.equal(row.role, "assistant");
  assert.equal(row.is_bot, true);
  assert.equal(row.evidenceEligible, false);
  const anonymous = prepareLearningMessages([{ text: "匿名文本" }]).messages[0];
  assert.equal(anonymous.sourceMessageId, null);
  assert.equal(anonymous.evidenceEligible, false);
});

test("very small/Unicode bounds terminate without half-surrogate segments", () => {
  for (const cap of [1, 2, 3, 7, 32, 511, 512, 513, 4000]) {
    const rows = Array.from({ length: 24 }, (_, id) => message(id, "🙂。".repeat(1800)));
    const options = { maxMessageChars: cap, maxBatchChars: cap * 3, maxBatchMessages: 16 };
    const result = prepareLearningMessages(rows, { config: options });
    assert.ok(result.totalChars <= cap * 3);
    assert.ok(result.renderedChars <= cap * 3);
    assert.ok(result.messages.length <= 16);
    assert.equal(result.messages.length, decide(rows, options).batchSize);
    for (const row of result.messages) {
      assert.ok(row.retainedChars <= cap);
      assert.ok(row.text.length <= cap);
      for (const segment of row.segments) {
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(segment.text));
        assert.equal(segment.sourceMessageId, row.message_id);
      }
    }
  }
});

test("missing/non-text source material is explicitly ineligible, never silently evidence", () => {
  const rows = prepareLearningMessages([
    message(1, ""), message(2, "本人文字", { message: [{ type: "image", data: { file: "fake-image" } }] })
  ]).messages;
  assert.deepEqual(rows[0].sourceIssues, ["empty-text"]);
  assert.deepEqual(rows[1].sourceIssues, ["non-text-segments"]);
  assert.ok(rows.every(row => row.evidenceEligible === false));
});

test("evidence metadata/actor and quote flags survive projection; raw eligible IDs remain authoritative", () => {
  const human = message("human", "我喜欢乌龙茶。", { conversation_id: "group:fake", user_id: "10001", role: "human",
    sender: { user_id: "10001", role: "member", is_bot: false, is_self: false },
    source: "user", is_bot: false, is_self: false, isQuoted: false, quoted: false, forwarded: false,
    sent_at: ISO, sentAtMs: NOW, time: NOW / 1000, enqueuedAt: NOW - 6000 });
  const input = freeze([human,
    { ...human, message_id: "bot", sender: { user_id: "10001", role: "assistant", is_bot: true } },
    { ...human, message_id: "quote", replyContexts: [{ quoted: true }] },
    { ...human, message_id: "truncated", text: "前".repeat(7000) + "不，我不喜欢咖啡。" }]);
  const before = JSON.stringify(input);
  const prepared = prepareLearningMessages(input).messages;
  const row = prepared[0];
  for (const field of ["message_id", "user_id", "conversation_id", "role", "sender", "source", "is_bot", "is_self",
    "isQuoted", "quoted", "forwarded", "sent_at", "sentAt", "sentAtMs", "time", "enqueuedAt", "receivedAt"]) {
    assert.deepEqual(row[field], human[field], `copied metadata: ${field}`);
  }
  assert.notEqual(row.sender, human.sender);
  assert.equal(row.evidenceEligible, true);
  assert.equal(prepared[1].sender.is_bot, true);
  assert.equal(prepared[1].evidenceEligible, false);
  assert.equal(prepared[2].replyContexts, true);
  assert.equal(prepared[2].evidenceEligible, false);
  assert.equal(prepared[3].evidenceEligible, false);
  const ids = new Set(prepared.filter(item => item.evidenceEligible).map(item => item.sourceMessageId));
  const evidence = prepareMemoryEvidenceBatch(input.filter(item => ids.has(item.message_id)), { conversationId: "group:fake" });
  assert.deepEqual(evidence.messages.map(item => item.message_id), ["human"]);
  assert.equal(evidence.messages[0].sent_at, ISO);
  assert.equal(evidence.messages[0].text, human.text);
  assert.equal(JSON.stringify(input), before);
});

test("astral characters at every excerpt and 512-unit segment boundary retain exact source slices", () => {
  for (const prefixSize of [0, 1, 127, 128, 255, 510, 511, 512, 513]) {
    const text = "中".repeat(prefixSize) + "🙂".repeat(520) + "。更正：我不同意。";
    for (const cap of [1, 2, 3, 15, 16, 17, 31, 32, 511, 512, 513, 1023, 1024, 4000]) {
      const row = prepareLearningMessages([message("astral", text)], { config: { maxMessageChars: cap } }).messages[0];
      assert.ok(row.text.length <= cap);
      for (const segment of row.segments) {
        assert.ok(segment.text.length > 0 && segment.text.length <= 512);
        assert.equal(segment.text, text.slice(segment.start, segment.end));
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(segment.text));
        assert.equal(segment.sourceMessageId, "astral");
      }
      if (!row.truncated) assert.equal(row.segments.map(segment => segment.text).join(""), text);
    }
  }
});

test("explicit expiry/inclusive boundary and future effective date", () => {
  for (const memoryClass of ["state", "plan", "stable", "preference", "meme"]) {
    const validity = memoryValidity({ memoryClass, validUntil: ISO }, { now: NOW });
    assert.equal(validity.expired, true);
    assert.equal(validity.usable, false);
  }
  assert.equal(memoryValidity({ validFrom: NOW + 1 }, { now: NOW }).reason, "not-yet-valid");
  assert.equal(memoryValidity({ validUntil: ISO }).reason, "unknown-now");
  assert.equal(memoryValidity({ validUntil: "2026-02-30T00:00:00Z" }, { now: NOW }).reason, "invalid-validity");
  assert.equal(memoryValidity({ validFrom: ISO, validUntil: old }, { now: NOW }).reason, "invalid-validity");
});

test("old unknown chronology is never relabelled as current", () => {
  assert.equal(memoryValidity(null, { now: NOW }).usable, false);
  assert.equal(memoryValidity({ value: "曾住苏州", updatedAt: ISO }, { now: NOW }).reason, "unknown-time");
  const row = selectRelevantMemoryEntries([entry("unknown", "当前住苏州", { firstSeenAt: "", memoryClass: "state" })], { now: NOW })[0];
  assert.equal(row.validity.chronologyKnown, false);
  assert.match(row.displayValue, /时间未知/);
  assert.match(memoryValidity({ memoryClass: "plan", firstSeenAt: old }, { now: NOW }).label, /未确认仍有效/);
});

test("summary preserves uncertain/conflicting times and quote provenance", () => {
  const summary = summarizeMemoryDiscussion([
    message(1, "他说决定了。", { sentAt: "", time: NOW / 1000, quoted: true }),
    message(2, "尚未定论。", { sentAtMs: NOW + 1 })
  ]);
  assert.equal(summary.sequence[0].sentAt, null);
  assert.equal(summary.sequence[1].sentAt, null);
  assert.equal(summary.sequence[0].isQuoted, true);
});

test("expired events remain historical labelled excerpts, not current states", () => {
  const rows = selectRelevantMemoryEntries([
    entry("state", "在杭州出差", { memoryClass: "state", validUntil: old }),
    entry("plan", "杭州出差计划", { memoryClass: "plan", validUntil: old }),
    entry("event", "曾在杭州开会", { memoryClass: "event", validUntil: old })
  ], { now: NOW, text: "杭州" });
  assert.deepEqual(rows.map(row => row.id), ["event"]);
  assert.equal(rows[0].validity.expired, true);
  assert.match(rows[0].displayValue, /历史事件/);
});

test("relevant old facts beat recent irrelevant facts; stable deterministic ties", () => {
  const rows = [entry("old", "不喜欢咖啡，喜欢乌龙茶"),
    entry("new", "最近开始打羽毛球", { firstSeenAt: ISO }), entry("tie", "乌龙茶")];
  const selected = selectRelevantMemoryEntries(rows, { now: NOW, text: "“咖啡”可以吗？", maxItems: 1 });
  assert.equal(selected[0].id, "old");
  const ties = [entry("first", "喜欢茶"), entry("second", "喜欢茶")];
  assert.deepEqual(selectRelevantMemoryEntries(ties, { now: NOW }).map(row => row.id), ["first", "second"]);
});

test("Chinese aliases scoped to original QQ subject; no cross-user name matches", () => {
  const rows = [entry("foreign", "小明叫阿明", { kind: "alias", subjectUserId: "u2" }),
    entry("mine", "阿明", { kind: "alias" }), entry("unscoped", "阿明", { subjectUserId: undefined }),
    entry("topic", "他爱看书", { topics: ["读书会"] })];
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW, text: "叫“阿明”来", subjectUserId: "u1", maxItems: 1 }).map(row => row.id), ["mine"]);
  assert.equal(selectRelevantMemoryEntries(rows, { now: NOW, text: "读书会", subjectUserId: "u1", maxItems: 1 })[0].id, "topic");
});

test("conditions stay conditional, literal cue matches rank without proving truth", () => {
  const rows = [entry("ordinary", "喜欢乌龙茶"), entry("conditional", "喜欢乌龙茶", { condition: "加班时" })];
  const selected = selectRelevantMemoryEntries(rows, { now: NOW, text: "加班时喝乌龙茶" });
  assert.equal(selected[0].id, "conditional");
  assert.equal(selected[0].validity.conditionMatched, true);
  assert.match(selected[0].displayValue, /条件未核验/);
  assert.equal(memoryValidity(rows[1], { now: NOW, currentText: "上班" }).conditionMatched, false);
});

test("verificationConditions annotate/rank context without promotion or provenance rewrites", () => {
  const conditions = freeze([{ caseId: "case-a", condition: "加班时", provenance: { type: "ADMIN", actorUserId: "admin" } }]);
  const annotated = freeze(entry("conditional", "喝乌龙茶", { memoryClass: "stable", verificationConditions: conditions }));
  const before = JSON.stringify(annotated);
  const validity = memoryValidity(annotated, { now: NOW, currentText: "加班时喝乌龙茶" });
  assert.equal(validity.conditional, true);
  assert.equal(validity.reason, "conditional");
  assert.equal(validity.conditionMatched, true);
  assert.match(validity.label, /条件未核验：加班时/);
  assert.equal(memoryValidity(annotated, { now: NOW, currentText: "平时" }).conditionMatched, false);
  const selected = selectRelevantMemoryEntries([entry("other", "喝乌龙茶"), annotated], { now: NOW, text: "加班时喝乌龙茶" });
  assert.equal(selected[0].id, "conditional");
  assert.match(selected[0].displayValue, /条件未核验/);
  assert.deepEqual(selected[0].verificationConditions, conditions);
  assert.equal(selected[0].memoryClass, "stable");
  assert.equal(selected[0].confidence, annotated.confidence);
  assert.equal(JSON.stringify(annotated), before);
  for (const wrapper of ["metadata", "temporal"]) {
    assert.equal(memoryValidity({ [wrapper]: { verificationConditions: conditions } }, { now: NOW }).conditional, true);
  }
  const malformed = memoryValidity({ verificationConditions: [{ caseId: "empty" }] }, { now: NOW });
  assert.equal(malformed.conditional, true);
  assert.equal(malformed.conditionMatched, false);
  assert.match(malformed.label, /未解析条件/);
  const event = memoryValidity({ memoryClass: "event", validUntil: old, verificationConditions: conditions }, { now: NOW });
  assert.match(event.label, /历史事件/);
  assert.match(event.label, /条件未核验/);
  const combined = { condition: "在家时", verificationConditions: conditions };
  assert.equal(memoryValidity(combined, { now: NOW, currentText: "加班时" }).conditionMatched, false);
  assert.equal(memoryValidity(combined, { now: NOW, currentText: "在家时加班时" }).conditionMatched, true);
});

test("no hidden confidence floor; exact caller .4/.7 thresholds and malformed options", () => {
  const rows = [entry("below", "乌龙茶", { confidence: 0.39 }), entry("low", "乌龙茶", { confidence: 0.4 }),
    entry("middle", "乌龙茶", { confidence: 0.6 }), entry("high", "乌龙茶", { confidence: 0.7 })];
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW }).map(row => row.id), ["below", "low", "middle", "high"]);
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW, minConfidence: 0.4 }).map(row => row.id), ["low", "middle", "high"]);
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW, minConfidence: 0.7 }).map(row => row.id), ["high"]);
  for (const threshold of [NaN, -1, 1.1, "0.4", null]) {
    assert.throws(() => selectRelevantMemoryEntries(rows, { minConfidence: threshold }), TypeError);
  }
  assert.deepEqual(selectRelevantMemoryEntries([entry("missing", "茶", { confidence: undefined })], { now: NOW, minConfidence: 0.4 }), []);
});

test("selector guards supplement but never replace parent integrity gates", () => {
  const rows = [entry("good", "咖啡"), ...["tentative", "rejected", "superseded", "disputed"].map(status => entry(status, "咖啡", { status })),
    ...[0.2, NaN, "0.9", 1.1].map((confidence, id) => entry(`confidence${id}`, "咖啡", { confidence }))];
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW }).map(row => row.id), ["good", "confidence0"]);
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW, minConfidence: 0.7 }).map(row => row.id), ["good"]);
  assert.deepEqual(selectRelevantMemoryEntries(rows, { now: NOW, maxItems: 0 }), []);
});

test("legacy arrays relevance only: no mutation, no FIFO deletion, duplicates preserved", () => {
  const values = freeze(["十年前喜欢乌龙茶", "最近羽毛球", "十年前喜欢乌龙茶"]);
  assert.deepEqual(selectRelevantMemoryValues(values, { text: "乌龙茶", maxItems: 2 }), [values[0], values[2]]);
  assert.equal(values.length, 3);
  assert.deepEqual(selectRelevantMemoryValues(values, { text: "不匹配", maxItems: 2 }), values.slice(0, 2));
  assert.deepEqual(selectRelevantMemoryValues(values, { maxItems: 0 }), []);
});

test("summary participants, original times, sequence, decision/pending cues, not conclusions", () => {
  const rows = [message("a", "我决定周末去杭州。", { sentAt: old }),
    message("b", "还没决定，等天气确认。", { user_id: "u2" }),
    message("c", "纠正：不是已经定了，仍然待确认。", { user_id: "u1" })];
  const summary = summarizeMemoryDiscussion(rows);
  assert.equal(summary.verified, false);
  assert.match(summary.text, /未核验/);
  assert.deepEqual(summary.participants.map(row => row.userId), ["u1", "u2"]);
  assert.deepEqual(summary.sequence.map(row => row.sourceMessageId), ["a", "b", "c"]);
  assert.equal(summary.sequence[0].sentAt, "2020-01-01T00:00:00.000Z");
  assert.deepEqual(summary.decisions.map(row => row.sourceMessageId), ["a", "b", "c"]);
  assert.deepEqual(summary.pending.map(row => row.sourceMessageId), ["b", "c"]);
  assert.ok(summary.text.includes(rows[2].text));
  assert.equal(summary.kind, "discussion-excerpts");
});

test("summary long corrections/omissions explicitly marked within maxChars", () => {
  const rows = Array.from({ length: 25 }, (_, id) => message(id, "前".repeat(6000) + "不，我没有同意这个计划。"));
  for (const maxChars of [1, 10, 64, 200, 500, 2000]) {
    const summary = summarizeMemoryDiscussion(rows, { maxChars });
    assert.ok(summary.text.length <= maxChars);
    assert.equal(summary.truncated, true);
    assert.ok(summary.omittedMessageCount > 0);
    for (const row of summary.sequence) assert.ok(row.excerpt.endsWith("不，我没有同意这个计划。") || row.truncated);
  }
  const summary = summarizeMemoryDiscussion([rows[0]], { maxChars: 500 });
  assert.match(summary.text, /不，我没有同意这个计划。/);
  assert.match(summary.text, /有省略/);
});

test("all projections accept frozen source inputs without changing data", () => {
  const rows = freeze([message(1), message(2, "更正：不喜欢茶。", { quoted: true })]);
  const before = JSON.stringify(rows);
  prepareLearningMessages(rows);
  summarizeMemoryDiscussion(rows);
  decide(rows);
  assert.equal(JSON.stringify(rows), before);
  const entries = freeze([entry("frozen", "喜欢茶", { metadata: { memoryClass: "preference", condition: "加班时" } })]);
  const snapshot = JSON.stringify(entries);
  selectRelevantMemoryEntries(entries, { now: NOW, text: "加班时喝茶" });
  assert.equal(JSON.stringify(entries), snapshot);
});

console.log(`memory learning self-test: PASS (${passed} cases; synthetic data only; IO/model calls/sends=0)`);
