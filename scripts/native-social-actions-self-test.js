import assert from "node:assert/strict";
import { createNativeSocialActions, validateNativeSocialPolicy } from "../src/native-social-actions.js";
import { executeReplyPlan } from "../src/expression-renderer.js";
import { validateReplyPlan, parseReplyPlan } from "../src/reply-plan.js";
import { accountDeliveryDecision } from "../src/account-delivery.js";

let checks = 0;
async function test(name, fn) { try { await fn(); checks++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
const policy = () => ({ enabled: true, shadowMode: false, conversationIds: ["group:123", "group:124"],
  pokes: { enabled: true, cooldownMs: 300000, maxDaily: 5 }, mentions: { enabled: true }, forwardRead: { enabled: true } });
function host({ p = policy(), capabilities = { poke: "supported", mention: "supported" }, logicalFor = id => `account:${id}`, authorizeProbe } = {}) {
  let time = Date.UTC(2026, 9, 24), memory = {}, current = true, tail = Promise.resolve();
  let before, after, wire, mentionWire, commits = 0;
  const calls = [], targets = new Map();
  function next(group = "123", messageId = "12") {
    const eventRef = Object.freeze({});
    const data = { event: { ref: eventRef, groupId: group, messageId, userId: "456", sentAt: time, isBot: false, pokeAcceptanceVerified: true },
      members: [{ groupId: group, userId: "456", verifiedAt: time, isBot: false },
        { groupId: group, userId: "789", verifiedAt: time, isBot: false }] };
    targets.set(`group:${group}`, data);
    return data;
  }
  next(); next("124");
  const deps = {
    ...(authorizeProbe ? { authorizeProbe } : {}),
    clock: () => time, capture: (accountId, conversationId) => ({ accountId, conversationId,
      logicalId: logicalFor(accountId), revision: 1, policy: structuredClone(p), capabilities: structuredClone(capabilities) }),
    isCurrent: () => current, getTargets: ctx => targets.get(ctx.conversationId), readState: () => ({ memory }),
    transact: builder => {
      const pending = tail.then(() => {
        commits++; before?.(commits);
        const draft = structuredClone(memory), result = builder({ memory: draft });
        assert.ok(!result?.then, "transaction builder must be synchronous");
        memory = draft; after?.(commits); return result;
      });
      tail = pending.catch(() => {}); return pending;
    },
    request: async (ctx, action, params, options) => {
      assert.equal(options.binding.isCurrent(), true);
      calls.push({ kind: "poke", action, params, memory: structuredClone(memory) });
      return wire ? wire(ctx, action, params, options) : { status: "ok", retcode: 0 };
    },
    sendMention: async (ctx, params, options) => {
      assert.equal(options.binding.isCurrent(), true); calls.push({ kind: "mention", params });
      return mentionWire ? mentionWire(ctx, params, options) : { messageId: "13" };
    }
  };
  let service = createNativeSocialActions(deps), ctx = service.open("a", "group:123");
  return { get service() { return service; }, get ctx() { return ctx; }, calls, deps, targets, next,
    get memory() { return memory; }, get time() { return time; }, get commits() { return commits; },
    offer: () => service.candidates(ctx), send: id => service.sendPoke(ctx, id),
    tick: ms => { time += ms; }, quiet: () => { current = false; }, resume: () => { current = true; },
    before: fn => { before = fn; }, after: fn => { after = fn; }, wire: fn => { wire = fn; },
    mention: fn => { mentionWire = fn; },
    restart: () => { service = createNativeSocialActions(deps); ctx = service.open("a", "group:123"); } };
}
const pokeId = h => h.offer().pokes[0]?.id;
const ledger = h => h.memory.nativeSocialActions.bots["account:a"].groups["group:123"];

await test("extension defaults match frozen parent contract, strict schema", () => {
  assert.deepEqual(validateNativeSocialPolicy(), { pokes: { enabled: false, cooldownMs: 300000, maxDaily: 5 },
    mentions: { enabled: false }, forwardRead: { enabled: false } });
  for (const raw of [null, [], { arbitrary: true }, { pokes: { enabled: 1 } }, { pokes: { maxDaily: 201 } },
    { pokes: { cooldownMs: -1 } }, { pokes: { maxDaily: NaN } }, { mentions: { target: "456" } }])
    assert.throws(() => validateNativeSocialPolicy(raw));
});
await test("unknown capability and default disabled never offer actions", () => {
  for (const options of [{ capabilities: {} }, { p: { ...policy(), pokes: {}, mentions: {}, forwardRead: {} } },
    { p: { ...policy(), enabled: false } }, { p: { ...policy(), shadowMode: true } }]) {
    const h = host(options); assert.deepEqual(h.offer(), { mentions: [], pokes: [] });
    assert.deepEqual(h.memory, {});
  }
  const h = host({ capabilities: {} }); assert.equal(h.service.status(h.ctx).capabilities.poke, "unknown");
});
await test("only host handles; exact scope and no mutable capability promotion", async () => {
  const h = host();
  assert.deepEqual(h.service.candidates({ ...h.ctx }), { mentions: [], pokes: [] });
  assert.deepEqual(h.service.candidates(null), { mentions: [], pokes: [] });
  assert.throws(() => h.service.open("a", "private:123")); assert.throws(() => h.service.open("a", "group:999"));
  const id = pokeId(h); h.ctx.capabilities.poke = "unknown";
  assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
});
await test("opaque offers leak no QQ/raw IDs; durable claim before exact integer wire", async () => {
  const h = host(), rows = h.offer();
  assert.equal(rows.mentions.length, 2); assert.equal(rows.pokes.length, 1);
  for (const rowsForKind of Object.values(rows)) for (const row of rowsForKind) assert.deepEqual(Object.keys(row), ["id", "label"]);
  assert.ok(!JSON.stringify(rows).includes('"userId"'));
  const result = await h.send(rows.pokes[0].id);
  assert.equal(result.status, "accepted"); assert.ok(result.actionId);
  assert.equal(result.messageId, undefined); assert.equal(result.message_id, undefined);
  assert.equal(result.targetMessageId, undefined); assert.equal(result.content, undefined);
  assert.deepEqual(h.calls[0].params, { group_id: 123, user_id: 456 }); assert.equal(h.calls[0].action, "group_poke");
  assert.equal(h.calls[0].memory.nativeSocialActions.bots["account:a"].groups["group:123"].claims["12"].status, "claimed");
  assert.equal(ledger(h).claims["12"].status, "accepted"); assert.equal(h.service.status(h.ctx).daily, 1);
});
await test("member evidence, real current human event, exact ref and safe integer required", () => {
  for (const mutate of [d => { d.event.isBot = true; }, d => { d.event.sentAt = 0; },
    d => { d.event.groupId = "999"; }, d => { d.event.messageId = "synthetic"; },
    d => { d.members[0].isBot = true; }, d => { d.members[0].verifiedAt = 0; },
    d => { d.event.userId = "9007199254740993"; d.members[0].userId = d.event.userId; }]) {
    const h = host(); mutate(h.targets.get("group:123")); assert.equal(h.offer().pokes.length, 0);
  }
  const h = host(); h.tick(60001); assert.equal(h.offer().pokes.length, 0);
});
await test("changed current event or member after offer blocks target", async () => {
  for (const change of [h => h.next(), h => { h.targets.get("group:123").members = []; },
    h => { h.targets.get("group:123").event.userId = "999"; }, h => h.tick(300001)]) {
    const h = host(), id = pokeId(h); change(h);
    assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
  }
});
await test("same-target concurrency and separately issued contexts share latest atomic draft", async () => {
  const h = host(), ctx2 = h.service.open("a", "group:123"), id1 = pokeId(h), id2 = h.service.candidates(ctx2).pokes[0].id;
  const results = await Promise.all([h.send(id1), h.service.sendPoke(ctx2, id2), h.send(id1)]);
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
  h.restart(); assert.equal(h.offer().pokes.length, 0);
});
await test("independent service instances still share durable repository claims", async () => {
  const h = host(), service2 = createNativeSocialActions(h.deps), ctx2 = service2.open("a", "group:123");
  const a = pokeId(h), b = service2.candidates(ctx2).pokes[0].id;
  const results = await Promise.all([h.send(a), service2.sendPoke(ctx2, b)]);
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
});
await test("daily budget atomic across groups and survives restart; peers isolated", async () => {
  const h = host({ p: { ...policy(), pokes: { enabled: true, cooldownMs: 0, maxDaily: 1 } } });
  const ctx2 = h.service.open("a", "group:124"), id1 = pokeId(h), id2 = h.service.candidates(ctx2).pokes[0].id;
  const results = await Promise.all([h.send(id1), h.service.sendPoke(ctx2, id2)]);
  assert.equal(results.filter(r => r.status === "accepted").length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.service.status(ctx2).daily, 1); h.restart(); assert.equal(h.service.status(h.ctx).daily, 1);
  const peer = h.service.open("b", "group:123"), id = h.service.candidates(peer).pokes[0].id;
  assert.equal((await h.service.sendPoke(peer, id)).status, "accepted"); assert.equal(h.service.status(peer).daily, 1);
  assert.equal(h.service.status(h.ctx).daily, 1);
});
await test("explicit failover carriers share identity cooldown and target claim", async () => {
  const h = host({ logicalFor: () => "group:pool" }); await h.send(pokeId(h));
  const carrier = h.service.open("b", "group:123"); assert.equal(h.service.candidates(carrier).pokes.length, 0);
  assert.equal(h.service.status(carrier).daily, 1);
});
await test("cooldown per group, daily reset at Shanghai midnight", async () => {
  const h = host(); await h.send(pokeId(h)); h.next("123", "14"); assert.equal(h.offer().pokes.length, 0);
  const ctx2 = h.service.open("a", "group:124");
  h.targets.get("group:124").event.userId = "789";
  assert.equal((await h.service.sendPoke(ctx2, h.service.candidates(ctx2).pokes[0].id)).status, "accepted");
  h.tick(600000); h.next("123", "15"); assert.ok(pokeId(h));
  h.tick(16 * 3600000 - 600000); assert.equal(h.service.status(h.ctx).daily, 0);
  h.next("123", "16"); assert.equal((await h.send(pokeId(h))).status, "accepted");
});
await test("quiet, abort, revision change inside claim all block wire and consume offer", async () => {
  for (const mode of ["quiet", "abort", "revision"]) {
    const h = host(), id = pokeId(h), controller = new AbortController();
    h.before(() => mode === "quiet" ? h.quiet() : mode === "abort" ? controller.abort() : h.ctx.revision++);
    assert.equal((await h.service.sendPoke(h.ctx, id, { signal: controller.signal })).status, "rejected");
    assert.equal(h.calls.length, 0); assert.equal((await h.send(id)).status, "rejected");
  }
});
await test("quiet/cancel/expiry after durable claim never reach wire; budget not refunded", async () => {
  for (const mode of ["quiet", "abort", "expiry"]) {
    const h = host(), id = pokeId(h), controller = new AbortController();
    h.after(n => { if (n === 1) mode === "quiet" ? h.quiet() : mode === "abort" ? controller.abort() : h.tick(300001); });
    assert.equal((await h.service.sendPoke(h.ctx, id, { signal: controller.signal })).status, "rejected");
    assert.equal(h.calls.length, 0); assert.equal(h.service.status(h.ctx).daily, 1);
  }
});
await test("failed or uncertain claim publication never calls wire or reoffers locally", async () => {
  for (const afterPublication of [false, true]) {
    const h = host(), id = pokeId(h);
    if (afterPublication) h.after(() => { throw Error("uncertain storage ACK"); });
    else h.before(() => { throw Error("storage failed"); });
    assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
    h.before(); h.after(); assert.equal(h.offer().pokes.length, 0);
    if (afterPublication) { h.restart(); assert.equal(h.offer().pokes.length, 0); }
  }
});
await test("actual wire binding rechecks current event, member, route, quiet, abort", async () => {
  for (const mode of ["event", "member", "quiet", "abort", "age"]) {
    const h = host(), controller = new AbortController(); let writes = 0;
    h.wire((ctx, action, params, options) => {
      if (mode === "event") h.next();
      if (mode === "member") h.targets.get("group:123").members = [];
      if (mode === "quiet") h.quiet();
      if (mode === "abort") controller.abort();
      if (mode === "age") h.tick(60001);
      assert.equal(options.binding.isCurrent(), false); if (options.binding.isCurrent()) writes++;
      throw Error("wire blocked");
    });
    assert.equal((await h.service.sendPoke(h.ctx, pokeId(h), { signal: controller.signal })).status, "uncertain");
    assert.equal(writes, 0); assert.equal(ledger(h).claims["12"].status, "uncertain");
  }
});
await test("onSendStarted forwarded exactly, never invoked at handoff/claim/settlement", async () => {
  const h = host(); let started = 0; const cb = () => { started++; };
  h.before(() => assert.equal(started, 0));
  h.wire((ctx, action, params, { binding }) => {
    assert.equal(binding.onSendStarted, cb); assert.equal(started, 0);
    return { status: "ok", retcode: 0 };
  });
  await h.service.sendPoke(h.ctx, pokeId(h), { onSendStarted: cb }); assert.equal(started, 0);
  const b = host(); b.wire((ctx, action, params, { binding }) => { binding.onSendStarted(); return { status: "ok", retcode: 0 }; });
  await b.service.sendPoke(b.ctx, pokeId(b), { onSendStarted: cb }); assert.equal(started, 1);
});
await test("rejected/unsupported/uncertain ACKs never retry or alternate endpoint", async () => {
  for (const [ack, status] of [[undefined, "uncertain"], [{}, "uncertain"], [{ status: "ok" }, "uncertain"],
    [{ status: "failed", retcode: 1404 }, "unsupported"], [{ status: "failed", retcode: 100 }, "rejected"]]) {
    const h = host(), id = pokeId(h); h.wire(() => ack);
    assert.equal((await h.send(id)).status, status); await h.send(id);
    assert.equal(h.calls.length, 1); assert.equal(h.offer().pokes.length, 0);
    h.restart(); assert.equal(h.offer().pokes.length, 0);
    if (status === "unsupported") { h.tick(300000); h.next("123", "13"); assert.equal(h.offer().pokes.length, 0);
      assert.equal(h.service.status(h.ctx).capabilities.poke, "unsupported"); }
  }
});
await test("timeout exception and failed settlement preserve uncertainty without replay", async () => {
  const h = host(); h.wire(() => { throw Error("ACK timeout"); });
  assert.equal((await h.send(pokeId(h))).status, "uncertain"); h.restart(); assert.equal(h.offer().pokes.length, 0);
  const b = host(); b.before(n => { if (n === 2) throw Error("settlement failed"); });
  assert.equal((await b.send(pokeId(b))).status, "uncertain"); assert.equal(ledger(b).claims["12"].status, "claimed");
  b.restart(); assert.equal(b.offer().pokes.length, 0); assert.equal(b.calls.length, 1);
});
await test("late accepted ACK after abort settles as accepted, not new speech", async () => {
  const h = host(), controller = new AbortController(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.wire(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.service.sendPoke(h.ctx, pokeId(h), { signal: controller.signal });
  await waiting; controller.abort(); release({ status: "ok", retcode: 0 });
  const result = await pending; assert.equal(result.status, "accepted"); assert.equal(result.messageId, undefined);
  assert.equal(ledger(h).claims["12"].status, "accepted"); assert.equal(h.calls.length, 1);
});
await test("clock rollback/malformed ledger fail closed; status never adds defaults", async () => {
  const h = host(), before = structuredClone(h.memory); h.service.status(h.ctx); assert.deepEqual(h.memory, before);
  const id = pokeId(h); h.tick(-1); assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
  const b = host(); await b.send(pokeId(b)); ledger(b).claims["12"].status = "fake";
  assert.equal(b.service.status(b.ctx).ok, false); assert.equal(b.offer().pokes.length, 0);
});
await test("candidate reuse across kind/account/group and after reoffer denied", async () => {
  const h = host(), rows = h.offer(), peer = h.service.open("b", "group:123"), group = h.service.open("a", "group:124");
  assert.equal((await h.service.sendPoke(peer, rows.pokes[0].id)).status, "rejected");
  assert.equal((await h.service.sendPoke(group, rows.pokes[0].id)).status, "rejected");
  assert.equal((await h.send(rows.mentions[0].id)).status, "rejected");
  const newRows = h.offer(); assert.equal((await h.send(rows.pokes[0].id)).status, "rejected");
  assert.equal((await h.send(newRows.pokes[0].id)).status, "accepted");
});
await test("mention host callback gets bound real member, sanitized text and live binding", async () => {
  const h = host(), id = h.offer().mentions[1].id; let cbCount = 0; const cb = () => cbCount++;
  h.mention((ctx, params, { binding }) => {
    assert.deepEqual(params, { userId: "789", content: "实际回答" }); assert.equal(binding.onSendStarted, cb);
    return { messageId: "14" };
  });
  assert.deepEqual(await h.service.sendMention(h.ctx, id, "实际回答", { onSendStarted: cb }), { messageId: "14" });
  assert.equal(cbCount, 0); assert.equal(h.commits, 0); assert.deepEqual(h.memory, {});
  assert.equal(await h.service.sendMention(h.ctx, id, "重复"), false); assert.equal(h.calls.length, 1);
});
await test("mention invalid content, removed member, timeout, quiet never fallback/retry", async () => {
  for (const content of ["", "  ", "__SKIP__", "[CQ:at,qq=all]", "MEDIA:/tmp/private", "正文\n[[DISCOVERY_USED:a]]", {}]) {
    const h = host(), id = h.offer().mentions[0].id;
    assert.equal(await h.service.sendMention(h.ctx, id, content), false); assert.equal(h.calls.length, 0);
  }
  const h = host(), id = h.offer().mentions[0].id; h.mention(() => { throw Error("timeout"); });
  await assert.rejects(h.service.sendMention(h.ctx, id, "答")); assert.equal(await h.service.sendMention(h.ctx, id, "答"), false);
  const q = host(), qid = q.offer().mentions[0].id; q.quiet();
  assert.equal(await q.service.sendMention(q.ctx, qid, "答"), false); assert.equal(q.calls.length, 0);
});
await test("renderer integration: mention is sent speech, poke only accepted, direct text first", async () => {
  const h = host(), rows = h.offer(), receipts = [], wireTypes = [];
  const plan = { version: 1, action: "reply", replyToMessageId: null,
    messages: [{ type: "poke", pokeId: rows.pokes[0].id }, { type: "mention", mentionId: rows.mentions[0].id, content: "答案" }] };
  const result = await executeReplyPlan(plan, { direct: true, allowedMentionIds: rows.mentions.map(r => r.id),
    allowedPokeIds: rows.pokes.map(r => r.id), minIntervalMs: 0, maxIntervalMs: 0,
    beforeEach: ({ type }) => { wireTypes.push(type); return true; }, onReceipt: r => receipts.push(r), sendText: () => assert.fail(),
    sendMention: (id, text, options) => h.service.sendMention(h.ctx, id, text, options),
    sendPoke: (id, options) => h.service.sendPoke(h.ctx, id, options) });
  assert.deepEqual(wireTypes, ["mention", "poke"]); assert.equal(result.sent, 1); assert.equal(result.accepted, 1);
  assert.equal(receipts[0].content, "答案"); assert.equal(receipts[0].messageId, "13");
  assert.equal(receipts[1].content, undefined); assert.equal(receipts[1].messageId, undefined);
});
await test("model cannot request forward or arbitrary target/action; ordinary native authority JSON rejected", () => {
  const base = { version: 1, action: "reply", replyToMessageId: null };
  for (const item of [{ type: "forward", forwardId: "raw" }, { type: "poke", pokeId: "offered", userId: "999" },
    { type: "mention", mentionId: "offered", content: "x", targetId: "999" }, { type: "group_poke", user_id: "999" }])
    assert.throws(() => validateReplyPlan({ ...base, messages: [item] }, { direct: false, allowedPokeIds: ["offered"], allowedMentionIds: ["offered"] }));
  for (const raw of ['{"forwardRef":"secret"}', '{"nested":{"event_ref":"secret"}}', '{"allowed_poke_ids":["secret"]}'])
    assert.equal(parseReplyPlan(raw, { direct: false }).action, "observe");
});
await test("generic account delivery still blocks poke aliases until parent verified binding wiring", () => {
  for (const action of ["group_poke", "friend_poke", "send_poke", "set_msg_emoji_like"])
    assert.equal(accountDeliveryDecision({}, "a", action, { group_id: "123", user_id: "456" }).allowed, false);
});
await test("native no-wire paths reject without invoking onSendStarted", async () => {
  for (const mode of ["quiet", "abort", "claim-failure"]) {
    const h = host(), id = pokeId(h), controller = new AbortController(); let started = 0;
    if (mode === "quiet") h.quiet();
    if (mode === "abort") controller.abort();
    if (mode === "claim-failure") h.before(() => { throw Error("disk failed"); });
    await h.service.sendPoke(h.ctx, id, { signal: controller.signal, onSendStarted: () => started++ });
    assert.equal(started, 0); assert.equal(h.calls.length, 0);
  }
});
await test("claim ledger capacity rejects new targets, expired claims prune without resetting daily", async () => {
  const h = host({ p: { ...policy(), pokes: { enabled: true, cooldownMs: 0, maxDaily: 200 } } });
  await h.send(pokeId(h)); const b = ledger(h), row = structuredClone(b.claims["12"]);
  for (let i = 100; i < 1099; i++) b.claims[String(i)] = { ...row };
  h.next("123", "13"); assert.equal((await h.send(pokeId(h))).status, "rejected"); assert.equal(h.calls.length, 1);
  h.tick(600001); h.next("123", "14"); assert.equal((await h.send(pokeId(h))).status, "accepted");
  assert.equal(Object.keys(ledger(h).claims).length, 1); assert.equal(h.service.status(h.ctx).daily, 2);
});
await test("mention queued adapter rechecks target/quiet and cannot reoffer after uncertain timeout", async () => {
  const h = host(), id = h.offer().mentions[0].id; let writes = 0;
  h.mention((ctx, params, { binding }) => {
    h.quiet(); assert.equal(binding.isCurrent(), false); if (binding.isCurrent()) writes++;
    throw Error("blocked or timeout");
  });
  await assert.rejects(h.service.sendMention(h.ctx, id, "答案")); assert.equal(writes, 0);
  h.resume(); assert.equal(h.offer().mentions.some(row => row.id === id), false);
  assert.equal(h.offer().mentions.length, 1); // Other verified member, not the attempted target.
});
await test("native surface is poke/mention only; forwardRead remains config-only compatibility", () => {
  const h = host(), saved = structuredClone(h.ctx.policy);
  assert.deepEqual(Object.keys(h.service).sort(), ["open", "candidates", "sendPoke", "sendMention", "openProbe", "sendProbe", "status"].sort());
  assert.deepEqual(Object.keys(h.offer()).sort(), ["mentions", "pokes"]);
  assert.deepEqual(Object.keys(h.service.status(h.ctx).capabilities).sort(), ["mention", "poke"]);
  assert.deepEqual(validateNativeSocialPolicy({ forwardRead: { enabled: true } }).forwardRead, { enabled: true });
  assert.throws(() => validateNativeSocialPolicy({ forwardRead: { enabled: "true" } }));
  assert.throws(() => validateNativeSocialPolicy({ forwardRead: { id: "raw" } }));
  assert.throws(() => host({ capabilities: { forwardRead: "supported" } }));
  assert.deepEqual(h.ctx.policy, saved); assert.equal(h.commits, 0); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.memory, {});
});
await test("sendMention passes normalized message ACK unchanged; raw OneBot and action ACK are not speech", async () => {
  for (const [ack, sent, receiptStatus] of [[{ messageId: "14" }, 1, "sent"], [{ messageId: 14 }, 1, "sent"],
    [false, 0, "failed"], [{ status: "ok", retcode: 0, data: { message_id: 14 } }, 0, "uncertain"],
    [{ status: "accepted", actionId: "poke_action" }, 0, "uncertain"], [undefined, 0, "uncertain"]]) {
    const h = host(), row = h.offer().mentions[0]; h.mention(() => ack);
    const result = await executeReplyPlan({ version: 1, action: "reply", replyToMessageId: null,
      messages: [{ type: "mention", mentionId: row.id, content: "答案" }] }, {
      direct: true, allowedMentionIds: [row.id], beforeEach: () => true, onReceipt: () => {}, sendText: () => assert.fail(),
      sendMention: async (id, content, options) => {
        const result = await h.service.sendMention(h.ctx, id, content, options);
        assert.equal(result, ack); return result;
      }
    });
    assert.equal(result.sent, sent); assert.equal(result.accepted, 0); assert.equal(result.receipts[0].status, receiptStatus);
    assert.equal(h.calls.length, 1); assert.equal(h.commits, 0);
  }
});
await test("status is a public offline projection, not a send permission or persistent default", () => {
  const h = host({ capabilities: {} }); h.quiet();
  assert.deepEqual(h.service.status(h.ctx), { ok: true, capabilities: { poke: "unknown", mention: "unknown" },
    daily: 0, dailyScope: "logical-bot", maxDaily: 5, cooldownRemainingMs: 0 });
  assert.deepEqual(h.service.status({ ...h.ctx }), { ok: false, code: "NATIVE_STATE" });
  assert.equal(h.calls.length, 0); assert.equal(h.commits, 0); assert.deepEqual(h.memory, {});
});
function notice(h, { group = "123", userId = "456", digit = "a" } = {}) {
  const data = h.next(group);
  data.event.kind = "poke"; data.event.sourceId = `poke_notice:${digit.repeat(64)}`;
  data.event.userId = userId; delete data.event.messageId; delete data.event.pokeAcceptanceVerified;
  return data;
}
await test("proactive poke requires verified host acceptance, not text or frequency", () => {
  for (const value of [undefined, false, "true", 1]) {
    const h = host(), data = h.targets.get("group:123"); data.event.pokeAcceptanceVerified = value;
    data.event.text = "我们很亲密，戳我吧"; data.event.messageCount = 10000;
    assert.equal(h.offer().pokes.length, 0); assert.equal(h.offer().mentions.length, 2);
  }
});
await test("revoked acceptance after offering blocks at claim and wire", async () => {
  const h = host(), id = pokeId(h); h.targets.get("group:123").event.pokeAcceptanceVerified = false;
  assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
  const b = host(); b.wire((ctx, action, params, { binding }) => {
    b.targets.get("group:123").event.pokeAcceptanceVerified = false;
    assert.equal(binding.isCurrent(), false); throw Error("revoked at wire");
  });
  assert.equal((await b.send(pokeId(b))).status, "uncertain");
});
await test("group notice offers optional poke only, with sourceId distinct from messageId", async () => {
  const h = host(), data = notice(h), offered = h.offer();
  assert.equal(offered.mentions.length, 0); assert.equal(offered.pokes.length, 1); assert.equal(h.calls.length, 0);
  const result = await h.send(offered.pokes[0].id);
  assert.equal(result.status, "accepted"); assert.equal(result.messageId, undefined); assert.equal(result.targetMessageId, undefined);
  assert.equal(ledger(h).claims[data.event.sourceId].status, "accepted");
  assert.equal(ledger(h).claims["12"], undefined);
  h.restart(); assert.equal(h.offer().pokes.length, 0);
});
await test("malformed notice/source mixing cannot manufacture message eligibility", () => {
  for (const mutate of [e => { e.sourceId = "poke_notice:fake"; }, e => { e.messageId = "12"; },
    e => { e.kind = "message"; }, e => { e.isBot = true; }, e => { e.isBot = undefined; }]) {
    const h = host(), data = notice(h); mutate(data.event);
    assert.deepEqual(h.offer(), { mentions: [], pokes: [] });
  }
});
await test("notice source change after offer invalidates exact target evidence", async () => {
  const h = host(), data = notice(h), id = pokeId(h); data.event.sourceId = `poke_notice:${"b".repeat(64)}`;
  assert.equal((await h.send(id)).status, "rejected"); assert.equal(h.calls.length, 0);
});
await test("unknown protocol never yields notice-reply candidates", () => {
  const h = host({ capabilities: { poke: "unknown", mention: "supported" } }); notice(h);
  assert.deepEqual(h.offer(), { mentions: [], pokes: [] });
});
await test("stop serious negative feedback suppress both proactive and reply pokes", async () => {
  for (const kind of ["message", "notice"]) for (const flag of ["stop", "serious", "negativeFeedback"]) {
    const h = host(), data = kind === "notice" ? notice(h) : h.targets.get("group:123");
    const id = pokeId(h); data.event[flag] = true;
    assert.equal(h.offer().pokes.length, 0); assert.equal((await h.send(id)).status, "rejected");
    assert.equal(h.calls.length, 0);
  }
});
await test("same logical target cooldown crosses groups and persists after restart", async () => {
  const h = host({ p: { ...policy(), pokes: { enabled: true, cooldownMs: 0, maxDaily: 200 } } });
  await h.send(pokeId(h)); h.tick(300001); h.restart();
  h.next("124", "99"); const other = h.service.open("a", "group:124");
  assert.equal(h.service.candidates(other).pokes.length, 0);
  h.tick(299999); h.next("124", "100"); assert.equal(h.service.candidates(other).pokes.length, 1);
});
await test("per-group cooldown still blocks a different accepted target", async () => {
  const h = host(); await h.send(pokeId(h)); h.tick(1000);
  h.next("123", "99").event.userId = "789"; assert.equal(h.offer().pokes.length, 0);
  h.tick(299000); h.next("123", "100").event.userId = "789"; assert.equal(h.offer().pokes.length, 1);
});
await test("failed and uncertain poke attempts retain target cooldown", async () => {
  for (const ack of [{ status: "failed", retcode: 100 }, {}]) {
    const h = host(); h.wire(() => ack); await h.send(pokeId(h)); h.tick(300001);
    const other = h.service.open("a", "group:124"); h.next("124", "99");
    assert.equal(h.service.candidates(other).pokes.length, 0);
  }
});
await test("legacy target-less claims read unchanged and conservatively cool down", async () => {
  const h = host(); await h.send(pokeId(h));
  delete h.memory.nativeSocialActions.bots["account:a"].targets; delete ledger(h).claims["12"].userId;
  const saved = structuredClone(h.memory); h.restart(); h.tick(300001); h.next("124", "99").event.userId = "789";
  const other = h.service.open("a", "group:124"); assert.equal(h.service.candidates(other).pokes.length, 0);
  assert.deepEqual(h.memory, saved); h.tick(299999); h.next("124", "100").event.userId = "789";
  assert.equal(h.service.candidates(other).pokes.length, 1);
});
await test("malformed target ledger refuses without read-time repair", async () => {
  const h = host(); await h.send(pokeId(h)); h.memory.nativeSocialActions.bots["account:a"].targets["456"] = "bad";
  const saved = structuredClone(h.memory); assert.equal(h.offer().pokes.length, 0);
  assert.equal(h.service.status(h.ctx).ok, false); assert.deepEqual(h.memory, saved);
});
await test("probes unavailable without explicit host authorizer", async () => {
  const h = host({ capabilities: { poke: "unknown" } });
  for (const grant of [undefined, "admin", { authorized: true }, { actor: "local-admin" }])
    assert.equal(h.service.openProbe(h.ctx, grant).ok, false);
  assert.equal((await h.service.sendProbe(h.ctx, {})).status, "rejected"); assert.equal(h.calls.length, 0);
});
await test("opaque admin-only probe bootstraps unknown capability via real accepted ACK", async () => {
  const grant = Object.freeze({}), h = host({ capabilities: { poke: "unknown", mention: "supported" },
    authorizeProbe: (ctx, auth) => auth === grant });
  delete h.targets.get("group:123").event.pokeAcceptanceVerified;
  const probe = h.service.openProbe(h.ctx, grant);
  assert.equal(probe.ok, true); assert(Object.isFrozen(probe.ticket)); assert.deepEqual(Object.keys(probe.ticket), []);
  assert.equal(h.offer().pokes.length, 0); assert.equal((await h.send(probe.ticket)).status, "rejected");
  const r = await h.service.sendProbe(h.ctx, probe.ticket);
  assert.equal(r.status, "accepted"); assert.equal(r.messageId, undefined); assert.equal(ledger(h).capability, "supported");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, "group_poke");
  assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "rejected");
  assert.equal(h.service.status(h.ctx).capabilities.poke, "unknown"); // reopen via host capture after accepted
});
await test("probes are exact context-bound capabilities not serializable model data", async () => {
  const grant = {}, h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value) => value === grant });
  const probe = h.service.openProbe(h.ctx, grant), other = h.service.open("b", "group:123");
  assert.equal(h.service.openProbe(h.ctx, { ...grant }).ok, false);
  assert.equal((await h.service.sendProbe(h.ctx, { ...probe.ticket })).status, "rejected");
  assert.equal((await h.service.sendProbe(other, probe.ticket)).status, "rejected");
  assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "accepted");
});
await test("probe grant revocation after durable claim blocks wire without refund", async () => {
  const grant = {}; let allowed = true;
  const h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value) => allowed && value === grant });
  const probe = h.service.openProbe(h.ctx, grant); h.after(n => { if (n === 1) allowed = false; });
  assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "rejected");
  assert.equal(h.calls.length, 0); assert.equal(h.service.status(h.ctx).daily, 1);
  assert.equal(ledger(h).capability, "unknown");
});
await test("probe actual wire binding rechecks grant after queue waits", async () => {
  const grant = {}; let allowed = true;
  const h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value) => allowed && value === grant });
  const probe = h.service.openProbe(h.ctx, grant);
  h.wire((ctx, action, params, { binding }) => { allowed = false; assert.equal(binding.isCurrent(), false); throw Error("revoked"); });
  assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "uncertain");
  assert.equal(ledger(h).capability, "unknown");
});
await test("probe cannot override shadow disabled private or known unsupported", async () => {
  const grant = {};
  for (const extra of [{ capabilities: { poke: "unsupported" } }, { capabilities: { poke: "supported" } },
    { p: { ...policy(), shadowMode: true }, capabilities: {} }, { p: { ...policy(), pokes: {} }, capabilities: {} }]) {
    const h = host({ ...extra, authorizeProbe: () => true }); assert.equal(h.service.openProbe(h.ctx, grant).ok, false);
    assert.throws(() => h.service.open("a", "private:456")); assert.equal(h.calls.length, 0);
  }
});
await test("probe results distinguish accepted API from visible delivery; bad ACK cannot promote", async () => {
  for (const [ack, expected] of [[{}, "uncertain"], [{ status: "ok" }, "uncertain"],
    [{ status: "ok", retcode: 100 }, "uncertain"], [{ status: "failed", retcode: 0 }, "uncertain"],
    [{ status: "failed", retcode: 1404 }, "unsupported"]]) {
    const grant = {}, h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value) => value === grant });
    h.wire(() => ack); const probe = h.service.openProbe(h.ctx, grant);
    const r = await h.service.sendProbe(h.ctx, probe.ticket);
    assert.equal(r.status, expected); assert.notEqual(ledger(h).capability, "supported");
    assert.equal(r.messageId, undefined); assert.equal(r.visible, undefined); assert.equal(r.content, undefined);
    assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "rejected");
  }
});
await test("notice replies still respect target cooldown and latest repository claim", async () => {
  const h = host(), data = notice(h), c2 = h.service.open("a", "group:123");
  const a = pokeId(h), b = h.service.candidates(c2).pokes[0].id;
  const r = await Promise.all([h.send(a), h.service.sendPoke(c2, b)]);
  assert.equal(r.filter(x => x.status === "accepted").length, 1);
  assert.equal(ledger(h).claims[data.event.sourceId].status, "accepted");
  h.tick(300001); notice(h, { digit: "b" }); assert.equal(h.offer().pokes.length, 0);
});
await test("probe authorizer sees exact frozen group/human/source binding", async () => {
  const grant = {}, h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value, target) => {
    assert(Object.isFrozen(target));
    return value === grant && target.groupId === "123" && target.userId === "456" && target.sourceKey === "12"
      && target.eventRef === h.targets.get("group:123").event.ref;
  } });
  const probe = h.service.openProbe(h.ctx, grant); assert.equal(probe.ok, true);
  assert.equal((await h.service.sendProbe(h.ctx, probe.ticket)).status, "accepted");
  const other = h.service.open("a", "group:124"); assert.equal(h.service.openProbe(other, grant).ok, false);
});
await test("one admin grant cannot issue repeated tests even across contexts and failed claims", async () => {
  const grant = {}, h = host({ capabilities: { poke: "unknown" }, authorizeProbe: (ctx, value) => value === grant });
  const other = h.service.open("a", "group:124"), a = h.service.openProbe(h.ctx, grant), b = h.service.openProbe(other, grant);
  assert.equal(a.ok, true); assert.equal(b.ok, true); h.before(() => { throw Error("storage failed"); });
  assert.equal((await h.service.sendProbe(h.ctx, a.ticket)).status, "rejected"); h.before();
  assert.equal((await h.service.sendProbe(other, b.ticket)).status, "rejected");
  assert.equal(h.service.openProbe(other, grant).ok, false); assert.equal(h.calls.length, 0);
});
await test("probe supported receipt cannot be re-probed via an old unknown context", async () => {
  const first = {}, second = {}, h = host({ capabilities: { poke: "unknown" }, authorizeProbe: () => true });
  const a = h.service.openProbe(h.ctx, first); await h.service.sendProbe(h.ctx, a.ticket);
  h.tick(600001); h.next("123", "99"); assert.equal(h.service.openProbe(h.ctx, second).ok, false);
});
await test("string/model admin assertions cannot act as probe capabilities", () => {
  const h = host({ capabilities: { poke: "unknown" }, authorizeProbe: () => true });
  assert.equal(h.service.openProbe(h.ctx, "local-admin").ok, false); assert.equal(h.calls.length, 0);
});
await test("native capability evidence belongs to its physical carrier, not merely failover persona", async () => {
  const h = host({ authorizeProbe: () => true }), base = h.deps.capture;
  h.deps.capture = (...args) => ({ ...base(...args), carrierKey: "a".repeat(64) }); h.restart();
  const sent = await h.send(pokeId(h)); assert.equal(sent.status, "accepted");
  assert.equal(ledger(h).capabilityCarrier, "a".repeat(64));
  h.deps.capture = (...args) => ({ ...base(...args), carrierKey: "b".repeat(64), capabilities: { poke: "unknown", mention: "supported" } }); h.restart();
  assert.equal(h.service.status(h.ctx).capabilities.poke, "unknown"); assert.equal(h.offer().pokes.length, 0);
  h.tick(600001); h.next("123", "14");
  assert.equal(h.service.openProbe(h.ctx, Object.freeze({})).ok, true, "new carrier requires new explicit proof despite old settled ACK");
});
console.log(`PASS native-social-actions: ${checks} synthetic checks; no IO, real QQ, production memory or model calls`);
