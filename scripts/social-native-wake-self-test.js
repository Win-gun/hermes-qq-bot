import assert from "node:assert/strict";
import { createSocialAgentRuntime, withSocialExpressionPlan } from "../src/social-agent-runtime.js";

const scope = { logicalId: "account:fixture", conversationId: "group:123456" };
const wake = `poke_notice:${"a".repeat(64)}`;
let checks = 0;
async function check(run) { await run(); checks++; }
function fixture({ decision = { action: "reply", messages: ["合成拍一拍回应"] }, shadow = false, throws = false } = {}) {
  let root = { socialAgents: { version: 1, bots: { [scope.logicalId]: { conversations: {
    [scope.conversationId]: { runtime: { nativeWakeId: wake } }
  } } } } }, calls = 0, sends = 0, schedules = 0, after;
  const api = {
    getPolicy: () => ({ enabled: true, shadowMode: shadow, conversationIds: [scope.conversationId], maxDailyCalls: 3 }),
    getSnapshot: () => ({ seenSeq: 0, readThroughSeq: 0, messages: [], hasMore: false }),
    isCurrent: () => true,
    transact: async build => { const draft = structuredClone(root); const result = build(draft); root = draft; after?.(root); return result; },
    callModel: async ({ tools }) => { calls++; assert.deepEqual(tools, []); return structuredClone(decision); },
    tools: { schedule_followup: () => { schedules++; } },
    sendIntent: async (ctx, intent) => { assert.equal(ctx.nativeWakeId, wake); assert.equal(intent.throughSeq, undefined); sends++; if (throws) throw Error("uncertain"); }
  };
  let service = createSocialAgentRuntime(api);
  return { get service() { return service; }, get root() { return root; }, get calls() { return calls; }, get sends() { return sends; },
    run: async (id = wake) => { service.observe({ ...scope, nativeWakeId: id }); return (await service.runDue())[0]?.code; },
    restart: () => { service = createSocialAgentRuntime(api); }, afterCommit: fn => { after = fn; },
    get schedules() { return schedules; }, api };
}
await check(async () => { const f = fixture(); assert.equal(await f.run(), "SOCIAL_COMPLETED"); assert.equal(f.sends, 1);
  const state = f.root.socialAgents.bots[scope.logicalId].conversations[scope.conversationId].runtime;
  assert.equal(state.lastProcessedSeq, undefined); assert.equal(state.lastInputReadThroughSeq, undefined);
  assert.equal(state.nativeIntentClaimed, wake); assert.equal(f.schedules, 0); });
await check(async () => { const f = fixture(); await f.run(); assert.equal(await f.run(), "SOCIAL_ALREADY_PROCESSED"); assert.equal(f.calls, 1); });
await check(async () => { const f = fixture(); await f.run(); f.restart(); assert.equal(await f.run(), "SOCIAL_ALREADY_PROCESSED"); assert.equal(f.sends, 1); });
await check(async () => { const f = fixture({ throws: true }); await f.run(); f.restart(); await f.run(); assert.equal(f.sends, 1); });
await check(async () => { const f = fixture(); assert.equal(await f.run(`poke_notice:${"b".repeat(64)}`), "SOCIAL_ALREADY_PROCESSED"); assert.equal(f.calls, 0); });
await check(async () => { const f = fixture({ shadow: true }); assert.equal(await f.run(), "SOCIAL_SHADOWED"); assert.equal(f.sends, 0); });
await check(async () => { const f = fixture({ decision: { action: "observe" } }); assert.equal(await f.run(), "SOCIAL_COMPLETED"); assert.equal(f.sends, 0); });
for (const decision of [
  { action: "reply", messages: ["不可确认聊天水位"], throughSeq: 0 },
  { action: "wait", delayMs: 1000 }, { action: "dive", delayMs: 1000 },
  { action: "tool", tool: { name: "schedule_followup", args: { delayMs: 1000 } } },
  { action: "observe", interest: { kind: "member", sourceSeq: 1, ttlMs: 1000 } },
  { action: "observe", continuity: { mood: { valence: 1 } } }, { action: "observe", nativeWakeId: wake }
]) await check(async () => { const f = fixture({ decision }); assert.equal(await f.run(), "SOCIAL_INVALID_DECISION"); assert.equal(f.sends, 0); assert.equal(f.schedules, 0); });
await check(async () => { const f = fixture(); for (const value of ["bad", "poke_notice:bad", wake.toUpperCase()])
  assert.equal(f.service.observe({ ...scope, nativeWakeId: value }).queued, false);
  assert.equal(f.service.observe({ ...scope, nativeWakeId: wake, discoveryWakeId: "discovery:fixture" }).queued, false); });
await check(async () => { const f = fixture(); f.afterCommit(root => { const state = root.socialAgents.bots[scope.logicalId].conversations[scope.conversationId].runtime;
  if (state.turnId && !state.nativeIntentClaimed) state.nativeWakeId = `poke_notice:${"b".repeat(64)}`; });
  await f.run(); assert.equal(f.sends, 0); });
await check(async () => { const f = fixture(); await f.run(); f.api.getSnapshot = () => ({ seenSeq: 1, readThroughSeq: 0,
  messages: [{ seq: 1, messageId: "real-message", userId: "345678", text: "新的人类问题" }] });
  f.api.callModel = async () => ({ action: "observe", throughSeq: 1 });
  const service = createSocialAgentRuntime(f.api); service.observe(scope);
  assert.equal((await service.runDue())[0].code, "SOCIAL_COMPLETED"); });
console.log(JSON.stringify({ ok: true, checks, fixtureOnly: true, realQqWrites: 0, modelCalls: 0 }));
