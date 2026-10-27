import assert from "node:assert/strict";
import { createQzoneDraftGenerator } from "../src/qzone-draft.js";
import { normalizeQzonePolicy } from "../src/qzone-policy.js";

let checks = 0;
const test = async (name, run) => { await run(); checks++; console.log(`ok ${name}`); };
function fixture({ limit = 2, result = JSON.stringify({ content: "合成秋日主题文字", reason: "围绕管理员的秋日主题" }) } = {}) {
  let memory = {}, current = true, calls = 0, drafts = [], prompts = [];
  const ctx = { logicalId: "account:fixture", accountId: "fixture", policy: normalizeQzonePolicy({ enabled: true }) };
  const actor = Object.freeze({});
  let generate = async () => result;
  const runtime = createQzoneDraftGenerator({
    isCurrent: c => current && c === ctx, getPolicy: () => ({ maxDailyCalls: limit }),
    getPersona: () => "合成账号的简洁、温柔文风", clock: () => Date.UTC(2026, 9, 27),
    transact: async builder => { const next = structuredClone(memory); const value = builder(next); memory = next; return value; },
    generate: async (c, prompt, options) => { calls++; prompts.push(prompt); return generate(c, prompt, options); },
    createDraft: async (c, input, who) => {
      assert.equal(c, ctx); assert.equal(who, actor); drafts.push(input);
      return { id: `draft_${drafts.length}`, status: "draft", ...input };
    }
  });
  return { runtime, ctx, actor, drafts, prompts, get calls() { return calls; }, get memory() { return memory; },
    setGenerate(fn) { generate = fn; }, stop() { current = false; },
    run(input = { topic: "秋日闲想" }, options = {}) { return runtime.run(ctx, input, { actor, ...options }); } };
}
const daily = t => t.memory.socialAgents.bots[t.ctx.logicalId].runtimeUsage.days["2026-10-27"];
await test("one text-only call creates draft, never approves or publishes", async () => {
  const t = fixture(), row = await t.run();
  assert.equal(row.status, "draft"); assert.equal(row.audience, 64); assert.equal(row.generated, true);
  assert.equal(t.calls, 1); assert.equal(t.drafts[0].creationReason, "围绕管理员的秋日主题");
  assert.match(t.prompts[0], /温柔文风/); assert.match(t.prompts[0], /秋日闲想/);
  assert.deepEqual(Object.keys(JSON.parse(t.prompts[0].split("\n").at(-1))).sort(), ["persona", "topic"]);
  assert.equal(daily(t).reservedCalls, 1); assert.equal(daily(t).actualCalls, 1);
  assert.equal(daily(t).unknownUsageCalls, 1); assert.equal(daily(t).inputTokens, 0);
  assert.deepEqual(daily(t).pending, {});
});
for (const input of [{ topic: "" }, { topic: "a", history: "PRIVATE" }, { topic: "a", audience: 1 },
  { topic: "token=do-not-copy" }, { topic: "file:///private" }, { topic: "a".repeat(1001) }]) await test("invalid topic/fields/audience denied before call", async () => {
  const t = fixture(); await assert.rejects(t.run(input), /QZONE_/); assert.equal(t.calls, 0); assert.deepEqual(t.memory, {});
});
for (const result of ["```json\n{}", "{}", '{"content":"okay","reason":"fine","audience":1}',
  '{"content":"/Users/private/file","reason":"fine"}', '{"content":"fine","reason":"token=bad"}',
  '{"content":"","reason":"not suitable"}']) await test("invalid/private/tool-like model output never becomes a draft", async () => {
  const t = fixture({ result }); await assert.rejects(t.run(), /QZONE_DRAFT_MODEL_INVALID/);
  assert.equal(t.calls, 1); assert.equal(t.drafts.length, 0); assert.equal(daily(t).unknownUsageCalls, 1);
});
await test("shared daily ledger is authoritative and budget exhaustion does not affect another account", async () => {
  const t = fixture({ limit: 1 }); await t.run(); await assert.rejects(t.run(), /QZONE_MODEL_BUDGET/);
  assert.equal(t.calls, 1); assert.equal(daily(t).reservedCalls, 1);
  assert.equal((await fixture().run()).status, "draft");
});
await test("cancellation and revocation after model call discard generated text, settle usage once", async () => {
  for (const revoke of [true, false]) {
    const t = fixture(), controller = new AbortController();
    t.setGenerate(async () => { if (revoke) t.stop(); else controller.abort(); return JSON.stringify({ content: "不要保存", reason: "合成" }); });
    await assert.rejects(t.run(undefined, { signal: controller.signal }), /QZONE_STALE/);
    assert.equal(t.drafts.length, 0); assert.equal(t.calls, 1); assert.equal(daily(t).actualCalls, 1);
  }
});
await test("concurrent generation cannot bypass account budget or create duplicates", async () => {
  const t = fixture(); let release;
  t.setGenerate(() => new Promise(resolve => { release = resolve; }));
  const first = t.run(); while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(t.run(), /QZONE_DRAFT_BUSY/);
  release(JSON.stringify({ content: "唯一草稿", reason: "合成主题" })); await first;
  assert.equal(t.calls, 1); assert.equal(t.drafts.length, 1);
});
await test("model rejection accounts unknown usage but never retries or persists prompt/output", async () => {
  const t = fixture(); t.setGenerate(() => { throw Error("provider secret-bearing detail"); });
  await assert.rejects(t.run()); assert.equal(t.calls, 1); assert.equal(t.drafts.length, 0);
  assert.doesNotMatch(JSON.stringify(t.memory), /secret|秋日|温柔/); assert.equal(daily(t).actualCalls, 1);
});
console.log(`qzone-draft: ${checks} checks passed (fake model/repository only)`);
