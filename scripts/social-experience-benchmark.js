import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { evaluateConversationTurn } from "../src/conversation-turn-manager.js";
import { parseReplyPlan } from "../src/reply-plan.js";
import { socialExperienceFor } from "../src/social-experience-policy.js";
import { observeGroupLanguage, groupLanguagePrompt } from "../src/group-language-learning.js";
import { createExpressionLibrary } from "../src/social-expression-library.js";

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
const logicalId = "account:fixture", conversationId = "group:10001", at = Date.parse("2026-10-23T04:00:00Z");
const memory = {};
for (let n = 0; n < 500; n++) assert(observeGroupLanguage(memory, { logicalId, conversationId, now: at + n,
  message: { messageId: String(n + 1), userId: "10002", text: n < 10 ? `合成词${n}在本群的意思是开心讨论` : "合成的普通群消息",
    sentAt: at + n, receivedAt: at + n, isBot: false, isQuoted: false, imageCount: 0 } }).ok);
memory.socialExpressionAssets = { version: 1, bots: { [logicalId]: { capabilities: {}, stickers: {} } } };
for (let n = 0; n < 100; n++) memory.socialExpressionAssets.bots[logicalId].stickers[`s${n}`] = {
  id: `s${n}`, revision: 1, url: `https://cdn.example.com/${n}.png`, desc: "合成元数据", trust: "untrusted", active: true,
  annotations: { [conversationId]: { conversationId, revision: 1, status: "confirmed", sha256: "a".repeat(64), note: "开心讨论",
    tags: ["开心"], sentCount: 0, receipts: {}, actor: "local-admin", updatedAt: at } }
};
const library = createExpressionLibrary({ readState: () => ({ memory }), transact: () => { throw Error("benchmark must be read-only"); },
  capture: (accountId, scope) => ({ accountId, logicalId, conversationId: scope, revision: "fixture", policy: {
    ...config.socialExperience, stickers: { enabled: true, autoSend: true } } }),
  isCurrent: () => true, request: () => { throw Error("no network"); }, describeImage: () => { throw Error("no model"); }, clock: () => at + 1000 });
const ctx = library.open("fixture", conversationId), projection = [];
for (let n = 0; n < 350; n++) {
  const start = performance.now();
  assert(groupLanguagePrompt(memory, { logicalId, conversationId, query: "开心讨论", now: at + 1000 }));
  assert.equal(library.candidates(ctx, { query: "今天很开心" }).length, 3);
  assert(library.snapshot(ctx).ok);
  if (n >= 50) projection.push(performance.now() - start);
}
projection.sort((a, b) => a - b);
const projectionP95 = projection[Math.floor(projection.length * .95)];
assert(projectionP95 < 100, "local expression library/context projection P95 must stay below 100ms");
console.log(JSON.stringify({ ok: true, fixtureOnly: true, samples: samples.length,
  localProcessingP50Ms: +samples[Math.floor(samples.length * .5)].toFixed(3), localProcessingP95Ms: +p95.toFixed(3),
  projectionSamples: projection.length, projectionFixture: { groupMessages: 500, stickers: 100 }, localProjectionP95Ms: +projectionP95.toFixed(3),
  modelCalls: 0, directSerialCallsAdded: 0, tokenUsage: "unknown: no live model used",
  productionLatency: "unmeasured", humanExperienceScore: "unrated", productionThroughput: "unmeasured" }));
