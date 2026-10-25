import assert from "node:assert/strict";
import { evaluateConversationTurn, conversationTurnHints } from "../src/conversation-turn-manager.js";

// Pure synthetic inputs only; no runtime state, QQ or model adapters.
const policy = { turn: { minWaitMs: 100, maxWaitMs: 1200, ordinaryWaitMs: 500,
  incompleteWaitMs: 900, maxTurnMs: 2000 } };
const turn = (extra = {}) => evaluateConversationTurn({ text: "普通陈述", policy, ...extra });
const passed = [];
function test(name, run) { run(); passed.push(name); }

for (const cue of ["你知道", "我跟你讲", "其实吧", "等一下", "然后呢", "我想说", "你先听我说", "还有个事", "对了", "主要是"]) {
  test(`continuation-${cue}`, () => {
    for (const suffix of ["", "，", "…", "。", "？"]) {
      const value = turn({ text: cue + suffix });
      assert.equal(value.reason, "incomplete");
      assert.equal(value.suggestedWaitMs, 900);
      assert.equal(turn({ text: cue + suffix, elapsedMs: 900 }).status, "ready");
    }
  });
}
test("latest-fragment-completes-earlier-cue", () => {
  assert.equal(turn({ text: "我跟你讲\n这次用本地测试验证。" }).reason, "ordinary");
  assert.equal(turn({ text: "我跟你讲\n说完了。" }).suggestedWaitMs, 100);
  assert.deepEqual(conversationTurnHints(null), { incomplete: false, topicEnded: false });
  for (const text of ["等我说完了", "我还没说完了"]) assert.equal(conversationTurnHints(text).topicEnded, false);
});
test("topic-ended-and-host-end-override-punctuation", () => {
  for (const text of ["就这些。", "先这样，", "没别的了", "这个话题到此为止。", "不说了", "不用回复"]) {
    assert.equal(turn({ text }).reason, "topic-ended");
    assert.equal(turn({ text, elapsedMs: 100 }).status, "ready");
  }
  assert.equal(turn({ text: "主要是", topicEnded: true }).suggestedWaitMs, 100);
});
test("fast-consecutive-fragments-vs-interruption-and-long-gap", () => {
  assert.equal(turn({ messageCount: 3, gaps: [100, 150] }).suggestedWaitMs, 600);
  assert.equal(turn({ messageCount: 3, gaps: [100, 150], interveningMessages: 1 }).suggestedWaitMs, 500);
  assert.equal(turn({ text: "还有个事", messageCount: 2, gaps: [950] }).reason, "separated");
  assert.equal(turn({ text: "还有个事", interveningMessages: 1 }).suggestedWaitMs, 500);
  assert.equal(turn({ text: "还有个事", mentioned: true, interveningMessages: 1 }).suggestedWaitMs, 100);
});
test("addressing-is-explicit-not-a-question-mark", () => {
  assert.deepEqual(turn({ text: "你们觉得怎么办？" }), turn());
  for (const flag of ["mentioned", "isPrivate", "quotedBot"]) assert.equal(turn({ [flag]: true }).suggestedWaitMs, 100);
  assert.equal(turn({ addressedTo: "bot" }).suggestedWaitMs, 100);
  assert.equal(turn({ text: "你知道", addressedTo: "other", mentioned: true }).status, "observe");
  assert.equal(turn({ addressedTo: "other", isPrivate: true }).suggestedWaitMs, 100);
});
test("commands-and-explicit-immediacy-zero-wait", () => {
  for (const text of ["/bot quiet", "/status", "马上回答", "请立即回复", "别等了，直接说"]) {
    assert.equal(turn({ text, messageCount: 4, gaps: [100, 100, 100], interveningMessages: 2 }).suggestedWaitMs, 0);
  }
  assert.notEqual(turn({ text: "不要马上回答" }).suggestedWaitMs, 0);
});
test("strict-maxturn-with-repeated-refresh-and-incomplete-history", () => {
  for (let age = 0; age <= 2200; age += 25) {
    const value = turn({ text: "还有个事", messageCount: 30, gaps: [10], sentAtMs: 10000, now: 10000 + age });
    assert(value.suggestedWaitMs <= Math.max(0, 2000 - age));
    if (age >= 2000) assert.equal(value.reason, "max-turn");
  }
  assert.equal(turn({ text: "主要是", messageCount: 3, gaps: [900, 1000], elapsedMs: 50 }).suggestedWaitMs, 50);
  assert.equal(turn({ text: "主要是", messageCount: 3, gaps: [1000, 1000] }).reason, "max-turn");
  assert.equal(turn({ text: "主要是", policy: { turn: { maxTurnMs: 0, minWaitMs: 999 } } }).suggestedWaitMs, 0);
});
test("invalid-inputs-remain-bounded-and-input-is-not-mutated", () => {
  const gaps = Object.freeze([100, 200]);
  const input = Object.freeze({ text: "主要是", policy: Object.freeze({ turn: Object.freeze(policy.turn) }), gaps, messageCount: 3 });
  assert.equal(evaluateConversationTurn(input).suggestedWaitMs, 900);
  for (const value of [NaN, Infinity, -1, null, "100"]) {
    const result = turn({ elapsedMs: value, messageCount: value, gaps: [value], interveningMessages: value,
      policy: { turn: { minWaitMs: value, maxWaitMs: value, maxTurnMs: value } } });
    assert(Number.isFinite(result.suggestedWaitMs));
    assert(result.suggestedWaitMs >= 0 && result.suggestedWaitMs <= 12000);
  }
  assert.equal(turn({ text: " " }).status, "observe");
});

console.log(JSON.stringify({ ok: true, tests: passed.length, passed, modelCalls: 0, qqSends: 0 }));
