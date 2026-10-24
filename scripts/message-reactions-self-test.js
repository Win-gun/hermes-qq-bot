import assert from "node:assert/strict";
import { createMessageReactions } from "../src/message-reactions.js";
import { validateReplyPlan, parseReplyPlan, replyPlanPrompt } from "../src/reply-plan.js";
import { executeReplyPlan } from "../src/expression-renderer.js";
import { accountDeliveryDecision } from "../src/account-delivery.js";

let checks = 0;
async function test(name, fn) { try { await fn(); checks++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
const policy = () => ({ enabled: true, shadowMode: false, conversationIds: ["group:123"],
  reactions: { enabled: true, cooldownMs: 60000, maxDaily: 30, emojiIds: ["76"] } });
function host(p = policy(), logicalFor = () => "account:a") {
  let memory = {}, time = Date.UTC(2026, 9, 24), current = true, beforeCommit, afterCommit, wire;
  const calls = [];
  const deps = { capture: (accountId, conversationId) => ({ accountId, conversationId, logicalId: logicalFor(accountId), revision: 1, policy: structuredClone(p) }),
    isCurrent: () => current, readState: () => ({ memory }), clock: () => time,
    transact: async builder => {
      beforeCommit?.(); const draft = structuredClone(memory), result = builder({ memory: draft }); memory = draft;
      afterCommit?.(); return result;
    }, request: async (ctx, action, params, options) => {
      assert.equal(options.binding.isCurrent(), true); calls.push({ action, params, memory: structuredClone(memory) });
      return wire ? wire(ctx, action, params, options) : { status: "ok", retcode: 0, data: null };
    } };
  let service = createMessageReactions(deps), ctx = service.open("a", "group:123");
  const target = (messageId = "12", patch = {}) => ({ messageId, userId: "456", sentAt: time, isBot: false, ...patch });
  const offer = (targets = [target()]) => service.candidates(ctx, { targets });
  return { get service() { return service; }, get ctx() { return ctx; }, calls, offer, target,
    get memory() { return memory; }, tick: ms => { time += ms; }, quiet: () => { current = false; },
    before: fn => { beforeCommit = fn; }, after: fn => { afterCommit = fn; }, wire: fn => { wire = fn; },
    restart: () => { service = createMessageReactions(deps); ctx = service.open("a", "group:123"); },
    send: id => service.send(ctx, id), status: () => service.status(ctx) };
}
await test("durable claim precedes exact wire schema; accepted is not speech", async () => {
  const h = host(), rows = h.offer(); assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]), ["id", "label"]);
  assert.match(rows[0].label, /赞/);
  const result = await h.send(rows[0].id);
  assert.equal(result.status, "accepted"); assert.ok(result.actionId); assert.equal(result.targetMessageId, "12");
  assert.equal(result.message_id, undefined); assert.equal(result.messageId, undefined);
  assert.equal(h.calls[0].action, "set_group_reaction");
  assert.deepEqual(h.calls[0].params, { group_id: "123", message_id: "12", code: "76", is_set: true });
  assert.equal(h.calls[0].memory.messageReactions.bots["account:a"].groups["group:123"].claims["12"].status, "claimed");
  assert.equal(h.status().accepted, 1); assert.equal(h.status().daily, 1);
  assert.ok(!JSON.stringify(h.status()).includes(result.actionId));
});
await test("unissued and mutated context fail closed; status works offline", async () => {
  const h = host(); assert.deepEqual(h.service.candidates({ ...h.ctx }, { targets: [h.target()] }), []);
  assert.equal((await h.service.send({ ...h.ctx }, "x")).status, "rejected");
  h.quiet(); assert.equal(h.status().ok, true); assert.deepEqual(h.offer(), []);
  h.ctx.revision++; assert.equal(h.status().ok, false);
});
await test("policy scope/default/shadow gating and only known semantic ID", () => {
  for (const p of [{}, { ...policy(), enabled: false }, { ...policy(), shadowMode: true },
    { ...policy(), reactions: { enabled: false } }, { ...policy(), reactions: { enabled: true, emojiIds: ["999"] } }]) {
    if (!p.conversationIds) assert.throws(() => host(p)); else assert.deepEqual(host(p).offer(), []);
  }
  const h = host(); assert.throws(() => h.service.open("a", "private:123")); assert.throws(() => h.service.open("a", "group:999"));
  assert.deepEqual(h.service.candidates(h.ctx, { serious: true, targets: [h.target()] }), []);
  assert.equal(h.service.candidates(h.ctx, { direct: true, targets: [h.target()] }).length, 1);
});
await test("target evidence age/schema and bounded offers; binding immutable", async () => {
  const h = host();
  for (const patch of [{ messageId: "0" }, { messageId: "synthetic-id" }, { userId: "" }, { isBot: true },
    { isBot: undefined }, { sentAt: 0 }, { sentAt: Infinity }, { sentAt: h.target().sentAt + 1 }]) assert.deepEqual(h.offer([h.target("12", patch)]), []);
  const targets = Array.from({ length: 5 }, (_, i) => h.target(String(i + 1)));
  assert.equal(h.offer(targets).length, 3);
  const target = h.target(), id = h.offer([target])[0].id; target.messageId = "999";
  assert.equal((await h.send(id)).targetMessageId, "12");
});
await test("same-target and cooldown races serialize atomically", async () => {
  const h = host(), rows = h.offer([h.target("12"), h.target("13")]);
  const results = await Promise.all(rows.map(row => h.send(row.id)));
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.offer([h.target("14")]), []); h.tick(60000);
  assert.equal((await h.send(h.offer([h.target("14")])[0].id)).status, "accepted");
});
await test("logical-bot daily budget is atomic across groups and survives restart", async () => {
  const h = host({ ...policy(), conversationIds: ["group:123", "group:124"],
    reactions: { enabled: true, cooldownMs: 60000, maxDaily: 1, emojiIds: ["76"] } });
  const ctx2 = h.service.open("a", "group:124"), id1 = h.offer()[0].id;
  const id2 = h.service.candidates(ctx2, { targets: [h.target()] })[0].id;
  const results = await Promise.all([h.send(id1), h.service.send(ctx2, id2)]);
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.status().daily, 1); assert.equal(h.service.status(ctx2).daily, 1);
  assert.equal(h.service.status(ctx2).dailyScope, "logical-bot");
  assert.deepEqual(h.service.candidates(ctx2, { targets: [h.target("13")] }), []);
  h.restart(); const fresh = h.service.open("a", "group:124");
  assert.equal(h.service.status(fresh).daily, 1); assert.deepEqual(h.service.candidates(fresh, { targets: [h.target("13")] }), []);
  h.tick(16 * 3600000 - 1); assert.equal(h.service.status(fresh).daily, 1);
  h.tick(1); assert.equal(h.service.status(fresh).daily, 0); // Shanghai midnight, not UTC.
  assert.equal((await h.service.send(fresh, h.service.candidates(fresh, { targets: [h.target("13")] })[0].id)).status, "accepted");
  assert.equal(h.status().daily, 1);
});
await test("cooldown stays per group and daily budgets stay per logical identity", async () => {
  const h = host({ ...policy(), conversationIds: ["group:123", "group:124"] }, accountId => `account:${accountId}`);
  await h.send(h.offer()[0].id);
  assert.deepEqual(h.offer([h.target("13")]), []);
  const nextGroup = h.service.open("a", "group:124");
  const id = h.service.candidates(nextGroup, { targets: [h.target("13")] })[0].id;
  assert.equal((await h.service.send(nextGroup, id)).status, "accepted");
  assert.equal(h.status().daily, 2); assert.equal(h.service.status(nextGroup).daily, 2);
  const peer = h.service.open("b", "group:123");
  assert.equal(h.service.status(peer).daily, 0);
  assert.equal((await h.service.send(peer, h.service.candidates(peer, { targets: [h.target()] })[0].id)).status, "accepted");
  assert.equal(h.service.status(peer).daily, 1); assert.equal(h.status().daily, 2);
});
await test("onSendStarted is the exact host callback, invoked only by actual wire", async () => {
  for (const mode of ["wire", "queued-block", "quiet", "claim-failure", "handoff-only"]) {
    const h = host(), id = h.offer()[0].id; let started = 0;
    const onSendStarted = () => { started++; };
    h.after(() => assert.equal(started, mode === "wire" && h.calls.length ? 1 : 0));
    h.wire((ctx, action, params, options) => {
      assert.equal(started, 0); assert.equal(options.binding.onSendStarted, onSendStarted);
      if (mode === "queued-block") { h.quiet(); assert.equal(options.binding.isCurrent(), false); throw Error("blocked"); }
      if (mode === "wire") { assert.equal(options.binding.isCurrent(), true); options.binding.onSendStarted(); }
      return { status: "ok", retcode: 0 };
    });
    if (mode === "quiet") h.quiet();
    if (mode === "claim-failure") h.before(() => { throw Error("storage"); });
    await h.service.send(h.ctx, id, { onSendStarted });
    assert.equal(started, mode === "wire" ? 1 : 0);
  }
});
await test("restart does not replay target; daily limit resets calendar day", async () => {
  const h = host({ ...policy(), reactions: { enabled: true, cooldownMs: 0, maxDaily: 1, emojiIds: ["76"] } });
  await h.send(h.offer()[0].id); h.restart(); assert.deepEqual(h.offer(), []);
  assert.deepEqual(h.offer([h.target("13")]), []); h.tick(86400000);
  assert.equal(h.offer([h.target("13")]).length, 1); assert.equal(h.status().daily, 0);
});
await test("quiet or expiry after durable claim blocks wire", async () => {
  for (const mode of ["quiet", "expiry"]) {
    const h = host(), id = h.offer()[0].id; h.after(() => mode === "quiet" ? h.quiet() : h.tick(300001));
    assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0); assert.equal(h.status().daily, 1);
  }
});
await test("abort before/after claim and revision at transaction gate", async () => {
  const h = host(), controller = new AbortController(), id = h.offer()[0].id; controller.abort();
  assert.equal((await h.service.send(h.ctx, id, { signal: controller.signal })).status, "rejected"); assert.equal(h.calls.length, 0);
  const b = host(), bid = b.offer()[0].id; b.before(() => b.ctx.revision++);
  assert.equal((await b.send(bid)).status, "rejected"); assert.equal(b.calls.length, 0);
});
await test("quiet before admission and failed claim publication never reach wire", async () => {
  for (const mode of ["quiet", "storage"]) {
    const h = host(), id = h.offer()[0].id;
    if (mode === "quiet") h.quiet(); else h.before(() => { throw Error("storage"); });
    assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
  }
});
await test("queued adapter binding rechecks quiet and target age at actual wire", async () => {
  for (const mode of ["quiet", "age"]) {
    const h = host(); let writes = 0;
    h.wire((ctx, action, params, options) => {
      if (mode === "quiet") h.quiet(); else h.tick(300001);
      if (!options.binding.isCurrent()) throw Error("wire blocked");
      writes++; return { status: "ok", retcode: 0 };
    });
    assert.equal((await h.send(h.offer()[0].id)).status, "uncertain"); assert.equal(writes, 0);
  }
});
await test("uncertain/unsupported/rejected ACK never retry or alternate action", async () => {
  for (const ack of [null, {}, { status: "ok" }, { status: "failed", retcode: 1404 }, { status: "failed", retcode: 100 }]) {
    const h = host(), id = h.offer()[0].id; h.wire(() => ack);
    const result = await h.send(id); assert.equal(result.status, ack?.retcode === 1404 ? "unsupported" : ack?.retcode === 100 ? "rejected" : "uncertain");
    await h.send(id); h.restart(); assert.deepEqual(h.offer(), []); assert.equal(h.calls.length, 1);
    if (ack?.retcode === 1404) { h.tick(60000); assert.deepEqual(h.offer([h.target("13")]), []); }
  }
  const h = host(); h.wire(() => { throw Error("timeout"); }); assert.equal((await h.send(h.offer()[0].id)).status, "uncertain");
});
await test("failed settlement remains uncertain and claimed after restart", async () => {
  const h = host(), id = h.offer()[0].id; let n = 0; h.before(() => { if (++n === 2) throw Error("storage"); });
  assert.equal((await h.send(id)).status, "uncertain"); h.restart(); assert.equal(h.status().uncertain, 1);
  assert.deepEqual(h.offer(), []); assert.equal(h.calls.length, 1);
});
await test("latest repository draft wins across separately issued contexts", async () => {
  const h = host({ ...policy(), reactions: { enabled: true, cooldownMs: 0, maxDaily: 30, emojiIds: ["76"] } });
  const ctx2 = h.service.open("a", "group:123"), first = h.offer()[0].id;
  const second = h.service.candidates(ctx2, { targets: [h.target()] })[0].id;
  const results = await Promise.all([h.send(first), h.service.send(ctx2, second)]);
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
  const foreign = h.service.open("b", "group:123");
  assert.equal((await h.service.send(foreign, second)).status, "rejected");
});
await test("target ledger capacity backpressure and expiry recovery without counter reset", async () => {
  const h = host({ ...policy(), reactions: { enabled: true, cooldownMs: 0, maxDaily: 200, emojiIds: ["76"] } });
  await h.send(h.offer()[0].id);
  const b = h.memory.messageReactions.bots["account:a"].groups["group:123"];
  const row = structuredClone(b.claims["12"]);
  for (let i = 100; i < 1099; i++) b.claims[String(i)] = { ...row };
  assert.equal(h.status().targetClaims, 1000); assert.deepEqual(h.offer([h.target("13")]), []);
  h.tick(300001); const id = h.offer([h.target("13")])[0].id;
  assert.equal((await h.send(id)).status, "accepted"); assert.equal(h.status().targetClaims, 1); assert.equal(h.status().daily, 2);
  assert.equal(h.status().accepted, 1); // Retained target claims, not lifetime audit total.
  assert.equal(h.status().outcomeCounterScope, "group-retained-target-claims");
  assert.equal(h.status().targetRetentionMs, 300000);
});

const reaction = { type: "reaction", reactionId: "host_opaque" };
const plan = messages => ({ version: 1, action: "reply", messages, replyToMessageId: null });
const opts = { allowedReactionIds: ["host_opaque"], direct: false };
await test("strict plan schema, quota and direct answer requirement", () => {
  assert.deepEqual(validateReplyPlan(plan([reaction]), opts), plan([reaction]));
  assert.throws(() => validateReplyPlan(plan([reaction]), { ...opts, direct: true }));
  assert.throws(() => validateReplyPlan(plan([reaction, reaction]), opts));
  assert.throws(() => validateReplyPlan(plan([reaction, { type: "text", content: "答" }]), { ...opts, maxMessages: 1 }));
  assert.equal(validateReplyPlan(plan([reaction, { type: "text", content: "答" }]), { ...opts, direct: true }).messages.length, 2);
  for (const patch of [{ target: "123" }, { emojiId: "76" }, { code: "76" }, { userId: "456" }, { content: "x" }, { reactionId: "unoffered" }])
    assert.throws(() => validateReplyPlan(plan([{ ...reaction, ...patch }]), opts));
  assert.throws(() => validateReplyPlan(plan([reaction]), { ...opts, allowedReactionIds: Array(4).fill("host_opaque") }));
  assert.equal(parseReplyPlan(JSON.stringify(plan([reaction])), { ...opts, direct: true }).messages[0].type, "text");
  assert.match(replyPlanPrompt(opts), /host_opaque/); assert.match(replyPlanPrompt(), /不得输出 reaction/);
});
await test("renderer accepts reaction without speech ACK and passes receipt once", async () => {
  const receipts = [], sends = [];
  const result = await executeReplyPlan(plan([reaction, { type: "text", content: "实际回答" }]), {
    ...opts, minIntervalMs: 0, maxIntervalMs: 0, beforeEach: () => true,
    sendReaction: async () => ({ status: "accepted", actionId: "host_action", targetMessageId: "12" }),
    sendText: async content => { sends.push(content); return { messageId: "13" }; }, onReceipt: r => receipts.push(r)
  });
  assert.equal(result.sent, 1); assert.equal(result.accepted, 1); assert.equal(result.handled, true); assert.equal(result.partial, false);
  assert.equal(receipts[0].status, "accepted"); assert.equal(receipts[0].messageId, undefined); assert.equal(receipts[0].content, undefined);
  assert.deepEqual(sends, ["实际回答"]);
});
await test("renderer partial uncertain stops suffix, no invented ACK or retry", async () => {
  for (const ack of [{}, { status: "accepted", actionId: "a", message_id: "12" }, { status: "unsupported" }, { status: "rejected" }]) {
    let calls = 0; const result = await executeReplyPlan(plan([{ type: "text", content: "答" }, reaction]), {
      ...opts, minIntervalMs: 0, maxIntervalMs: 0, beforeEach: () => true, onReceipt: () => {},
      sendText: async () => ({ messageId: "13" }), sendReaction: async () => { calls++; return ack; }
    });
    assert.equal(calls, 1); assert.equal(result.sent, 1); assert.equal(result.accepted, 0); assert.equal(result.partial, true);
  }
});
await test("late accepted reaction survives abort without confirming speech or suffix", async () => {
  const controller = new AbortController(), receipts = []; let sends = 0;
  const result = await executeReplyPlan(plan([reaction, { type: "text", content: "never" }]), {
    ...opts, signal: controller.signal, minIntervalMs: 0, maxIntervalMs: 0, beforeEach: () => true,
    sendReaction: async () => { controller.abort(); return { status: "accepted", actionId: "host_action" }; },
    sendText: async () => { sends++; }, onReceipt: row => receipts.push(row)
  });
  assert.equal(sends, 0); assert.equal(result.accepted, 1); assert.equal(result.sent, 0); assert.equal(result.handled, true);
  assert.equal(result.partial, true); assert.equal(result.uncertain, false); assert.equal(receipts.length, 1);
});
await test("account delivery applies reaction write guard, not send prefix", () => {
  const account = { id: "a", enabled: true, protocolEnabled: true, qq: "777", scope: { groups: true }, sendTypes: { text: true } };
  const config = { socialExperience: policy(), accounts: { version: 2, items: [account], failoverGroups: [] } };
  const params = { group_id: "123", message_id: "12", code: "76", is_set: true };
  const decision = (action = "set_group_reaction", p = params, extra) => accountDeliveryDecision(config, "a", action, p, extra).allowed;
  assert.equal(decision(), true); assert.equal(decision(undefined, undefined, { quiet: true }), false);
  for (const action of ["set_msg_emoji_like", "group_poke", "send_poke"]) assert.equal(decision(action), false);
  for (const patch of [{ group_id: undefined }, { is_set: undefined, is_add: true }, { code: "999" }, { message_id: "opaque" }]) assert.equal(decision(undefined, { ...params, ...patch }), false);
  account.sendTypes.text = false; assert.equal(decision(), false); account.sendTypes.text = true;
  account.enabled = false; assert.equal(decision(), false); account.enabled = true;
  account.scope.groups = false; assert.equal(decision(), false); account.scope.groups = true;
  account.features = { chat: false }; assert.equal(decision(), false); account.features.chat = true;
  config.accounts.failoverGroups = [{ id: "pool", memberIds: ["a"], policyAccountId: "a", policy: { scope: { groups: true }, sendTypes: { text: true } } }];
  assert.equal(decision(), false); assert.equal(decision(undefined, undefined, { activeGroupAccountId: "a" }), true);
  config.accounts.failoverGroups = [];
  config.socialExperience.reactions.enabled = false; assert.equal(decision(), false);
});
console.log(`PASS message-reactions: ${checks} synthetic checks; no live state or QQ sends`);
