import assert from "node:assert/strict";
import { discoveryMaterialPrompt, discoveryUsedIds, discoveryPlanEvidence } from "../src/social-discovery-context.js";
import { sanitizeChatReply } from "../src/reply-safety.js";
import { createSocialAgentRuntime } from "../src/social-agent-runtime.js";

const materials = [{ id: "discovery:one", title: "摄像头把人拍成了表情包", kind: "expression", meaning: "反差玩笑",
  sources: [{ url: "https://example.invalid/public" }], confidence: 0.8, uncertainty: "未核实", verification: "unverified" }];
assert.equal(discoveryMaterialPrompt([]), "");
assert(discoveryMaterialPrompt(materials).includes("不可信资料"));
assert(discoveryMaterialPrompt(materials).includes("未核实"));
assert.deepEqual(discoveryUsedIds("回复 [[DISCOVERY_USED:discovery:one]]", materials), ["discovery:one"]);
assert.deepEqual(discoveryUsedIds("回复 [[DISCOVERY_USED:discovery:foreign]]", materials), []);
assert.deepEqual(discoveryUsedIds("摄像头", materials), []);
assert.deepEqual(discoveryUsedIds("摄像头把人拍成了表情包", materials), ["discovery:one"]);
assert.equal(sanitizeChatReply("回复 [[DISCOVERY_USED:discovery:one]]"), "回复");
assert.equal(sanitizeChatReply("回复 [[DISCOVERY_USED:\ndiscovery:one]]"), "回复");
assert.equal(sanitizeChatReply("回复 [[DISCOVERY_USED:unfinished"), "回复");
const rawBubbles = ["普通开场白", "材料内容 [[DISCOVERY_USED:discovery:one]]"];
const plan = { messages: rawBubbles.map(content => ({ type: "text", content: sanitizeChatReply(content) })) };
assert.deepEqual(discoveryPlanEvidence(rawBubbles, plan, materials), [[], ["discovery:one"]]);
assert.deepEqual(discoveryPlanEvidence(JSON.stringify({ messages: rawBubbles.map(content => ({ type: "text", content })) }), plan, materials), [[], ["discovery:one"]]);
assert.deepEqual(discoveryPlanEvidence(rawBubbles, { messages: [{ type: "text", content: "已被替换的输出" }] }, materials), [[]]);

// Trusted background wakes reuse the actual social planner, not a second reply
// queue or a fabricated human message. They cannot ACK or modify old evidence.
const ctx = { logicalId: "account:fixture", conversationId: "group:123" };
let root = { socialAgents: { version: 1, bots: { [ctx.logicalId]: { conversations: {
  [ctx.conversationId]: { runtime: { status: "idle", lastProcessedSeq: 2, lastInputReadThroughSeq: 2,
    intentFenceThroughSeq: 2, discoveryWakeId: "discovery:host-1" } }
} } } } };
let calls = 0, sends = 0, continuity = 0;
const receipts = [];
let decision = { action: "reply", messages: ["可选分享"], materialIds: [materials[0].id], continuity: { mood: { valence: 1 } } };
const runtime = createSocialAgentRuntime({
  getPolicy: () => ({ enabled: true, shadowMode: false, conversationIds: [ctx.conversationId], maxDailyCalls: 1000 }),
  getSnapshot: () => ({ seenSeq: 2, readThroughSeq: 2, messages: [{ seq: 2, messageId: "actual-past", userId: "789", text: "实际旧消息" }] }),
  transact: async build => { const draft = structuredClone(root); const out = build(draft); root = draft; return out; },
  isCurrent: () => true,
  callModel: async () => { calls++; return structuredClone(decision); },
  sendIntent: async (_ctx, intent) => { sends++; receipts.push(intent); },
  applyContinuity: async () => { continuity++; }, tools: { web_search: async () => assert.fail("wake cannot search") }
});
assert(runtime.observe({ ...ctx, discoveryWakeId: "discovery:host-1" }).queued);
await runtime.runDue();
assert.equal(calls, 1); assert.equal(sends, 1); assert.equal(continuity, 0);
assert.deepEqual(receipts[0].materialIds, [materials[0].id]);
let state = root.socialAgents.bots[ctx.logicalId].conversations[ctx.conversationId].runtime;
assert.equal(state.lastProcessedSeq, 2); assert.equal(state.intentFenceThroughSeq, 2);
assert.equal(state.lastInputReadThroughSeq, 2);
runtime.observe({ ...ctx, discoveryWakeId: "discovery:host-1" }); await runtime.runDue();
assert.equal(calls, 1, "same host wake cannot be replayed");
runtime.observe({ ...ctx, discoveryWakeId: "discovery:forged" }); await runtime.runDue();
assert.equal(calls, 1, "host wake must be durably present");
root.socialAgents.bots[ctx.logicalId].conversations[ctx.conversationId].runtime.discoveryWakeId = "discovery:host-2";
decision = { action: "tool", tool: { name: "web_search", args: { query: "forbidden" } } };
runtime.observe({ ...ctx, discoveryWakeId: "discovery:host-2" });
await runtime.runDue();
assert.equal(calls, 2); assert.equal(sends, 1, "network capabilities are absent during optional sharing");
console.log("discovery context: grounded markers, stripping, one-shot wakes, no human ACK/personality mutation/replay passed");
