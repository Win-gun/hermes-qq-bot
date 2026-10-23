import assert from "node:assert/strict";
import { validateSocialExperiencePolicy, socialExperienceFor } from "../src/social-experience-policy.js";
import { registryConfig, effectiveAccount, mergeAccountPatch } from "../src/account-registry.js";
import { AccountRuntime } from "../src/account-runtime.js";
import { ExpressionDiagnostics } from "../src/social-expression-diagnostics.js";
import { ReplyCoordinator } from "../src/reply-coordinator.js";
import { parseReplyPlan } from "../src/reply-plan.js";

const policy = { enabled: true, shadowMode: false, conversationIds: ["group:10001"] };
assert.equal(socialExperienceFor({}, "10001").active, false);
assert.equal(socialExperienceFor({ socialExperience: policy }, "10001").active, true);
assert.equal(socialExperienceFor({ socialExperience: policy }, "10002").active, false);
assert.equal(socialExperienceFor({ socialExperience: policy }, "private:10001:bot:fixture").active, false);
assert.equal(socialExperienceFor({ socialExperience: { ...policy, conversationIds: ["private:10001"] } }, "private:10001:bot:fixture").active, true);
for (const value of [null, [], { enabled: "yes" }, { conversationIds: ["*"] }, { conversationIds: ["group:0"] },
  { turn: { maxWaitMs: NaN } }, { turn: { maxTurnMs: 16000 } }, { turn: { minWaitMs: 5000, maxWaitMs: 1000 } },
  { expression: { maxMessages: 0 } }, { expression: { maxMessages: 5 } },
  { expression: { minIntervalMs: 1000, maxIntervalMs: 100 } }, { expression: { accountId: "foreign" } }]) {
  assert.throws(() => validateSocialExperiencePolicy(value));
  assert.equal(socialExperienceFor({ socialExperience: value }, "10001").active, false);
}
const cfg = registryConfig({ accounts: { version: 2, items: [
  { id: "alpha", qq: "91001", protocol: "napcat", socialExperience: policy },
  { id: "beta", qq: "91002", protocol: "napcat" }
], failoverGroups: [] } });
assert.equal(effectiveAccount(cfg, "beta").socialExperience, undefined, "old accounts stay unmodified");
assert.equal(effectiveAccount(cfg, "alpha").socialExperience.expression.maxMessages, 2);
assert.throws(() => mergeAccountPatch(cfg.accounts.items[0], { socialExperience: { enabled: "true" } }));
const runtime = new AccountRuntime(cfg), first = runtime.revision("alpha"), peer = runtime.revision("beta");
const updated = structuredClone(cfg);
updated.accounts.items[0].socialExperience = validateSocialExperiencePolicy({ ...policy, shadowMode: true });
runtime.updateConfig(updated);
assert.notEqual(runtime.revision("alpha"), first);
assert.equal(runtime.revision("beta"), peer, "editing expression cannot invalidate a peer's reply");
const diagnostics = new ExpressionDiagnostics(2);
for (let i = 0; i < 4; i++) diagnostics.record("turns", "account:alpha", { reason: "incomplete", waitMs: 2500,
  content: "PRIVATE", explanation: "PRIVATE", secret: "PRIVATE" });
assert.equal(diagnostics.snapshot().recent.length, 2);
assert.equal(diagnostics.snapshot().turns, 4);
assert(!JSON.stringify(diagnostics.snapshot()).includes("PRIVATE"));
assert.equal(parseReplyPlan(JSON.stringify({ version: 1, action: "reply", replyToMessageId: null,
  messages: [{ type: "text", content: "__LEARN__ 这是合成的澄清问题？" }] })).messages[0].content, "这是合成的澄清问题？");
const queue = new ReplyCoordinator({ config: { responseQueue: { minDelayMs: 0 } } });
let notifyStarted, finishBurst, runs = 0;
const started = new Promise(resolve => { notifyStarted = resolve; });
const base = { accountId: "alpha", logicalBotId: "account:alpha", conversationId: "10001", senderId: "10002", direct: true, mode: "at" };
const pending = queue.enqueue({ ...base, messageIds: ["first"], execute: async ({ job }) => {
  runs++;
  job.deliveryStarted = true;
  job.expressionSending = true;
  const remainder = new Promise(resolve => { finishBurst = resolve; });
  job.stopRemaining = reason => finishBurst(reason);
  notifyStarted();
  assert.equal(await remainder, "new-input-during-expression");
  return { sent: true, partial: true };
} });
await started;
const observed = queue.observeMessage({ ...base, messageIds: ["second"], current: { text: "补充问题" } });
assert.equal(observed.absorbed, false, "a partly sent turn cannot absorb a new independent reply");
assert.equal((await pending).partial, true);
assert.equal(runs, 1);
assert.equal((await queue.enqueue({ ...base, messageIds: ["first"], execute: () => { throw new Error("replayed prefix"); } })).reason, "covered");
const uncertain = await queue.enqueue({ ...base, messageIds: ["unknown-ack"], execute: ({ job }) => {
  job.deliveryStarted = true;
  throw new Error("synthetic missing ACK");
} });
assert.equal(uncertain.deliveryUnconfirmed, true);
assert.equal((await queue.enqueue({ ...base, messageIds: ["unknown-ack"], execute: () => { throw new Error("replayed uncertainty"); } })).reason, "covered");
console.log("social experience policy: PASS (opt-in, scopes, validation, peer revision, bounded redacted diagnostics)");
