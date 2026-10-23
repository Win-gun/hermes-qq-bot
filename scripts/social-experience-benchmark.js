import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { evaluateConversationTurn } from "../src/conversation-turn-manager.js";
import { parseReplyPlan } from "../src/reply-plan.js";
import { socialExperienceFor } from "../src/social-experience-policy.js";

const config = { socialExperience: { enabled: true, shadowMode: false, conversationIds: ["group:10001"] } };
const samples = [];
for (let index = 0; index < 2500; index++) {
  const start = performance.now();
  const policy = socialExperienceFor(config, "10001");
  const turn = evaluateConversationTurn({ text: "我觉得，然后", mentioned: true, now: 100000,
    sentAtMs: 99900, messageCount: 3, gaps: [100, 100], policy });
  const plan = parseReplyPlan('{"version":1,"action":"reply","messages":[{"type":"text","content":"合成性能样本 👩‍💻"}],"replyToMessageId":null}');
  assert(turn.suggestedWaitMs <= policy.turn.maxTurnMs);
  assert.equal(plan.messages.length, 1);
  if (index >= 500) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * .95)];
assert(p95 < 100, "local expression processing P95 must stay below 100ms");
console.log(JSON.stringify({ ok: true, fixtureOnly: true, samples: samples.length,
  localProcessingP50Ms: +samples[Math.floor(samples.length * .5)].toFixed(3), localProcessingP95Ms: +p95.toFixed(3),
  modelCalls: 0, directSerialCallsAdded: 0, tokenUsage: "unknown: no live model used",
  productionLatency: "unmeasured", humanExperienceScore: "unrated", productionThroughput: "unmeasured" }));
