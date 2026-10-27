import assert from "node:assert/strict";
import { createPokeObservation } from "../src/poke-observation.js";
import { createNativeSocialActions } from "../src/native-social-actions.js";

let checks = 0;
async function test(name, fn) { try { await fn(); checks++; } catch (e) { throw new Error(name, { cause: e }); } }
const START = Date.UTC(2026, 9, 27);
function host({ logicalFor = id => `account:${id}` } = {}) {
  let time = START, memory = {}, current = true, tail = Promise.resolve(), before, after, commits = 0, service, ctx;
  const rawEvents = new WeakSet();
  const deps = { clock: () => time,
    capture: (accountId, conversationId) => ({ accountId, logicalId: logicalFor(accountId), conversationId,
      revision: 1, selfId: accountId === "a" ? "900" : "901", peerIds: ["901", "902"] }),
    isCurrent: () => current, isHostEvent: (context, event) => rawEvents.has(event), readState: () => ({ memory }),
    transact: builder => {
      const pending = tail.then(() => {
        commits++; before?.(commits);
        const draft = structuredClone(memory), result = builder({ memory: draft });
        assert(!result?.then, "sole writer requires synchronous builder"); memory = draft; after?.(commits); return result;
      });
      tail = pending.catch(() => {}); return pending;
    } };
  function event(extra = {}) {
    const raw = { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: 900, target_id: 900,
      user_id: 456, group_id: 123, time: time / 1000, ...extra }; rawEvents.add(raw); return raw;
  }
  service = createPokeObservation(deps); ctx = service.open("a", "group:123");
  return { get service() { return service; }, get ctx() { return ctx; }, deps, event,
    get memory() { return memory; }, get commits() { return commits; }, get time() { return time; },
    observe: (raw = event(), options) => service.observe(ctx, raw, options), tick: ms => { time += ms; },
    before: fn => { before = fn; }, after: fn => { after = fn; }, quiet: () => { current = false; }, resume: () => { current = true; },
    restart() { service = createPokeObservation(deps); ctx = service.open("a", "group:123"); } };
}
const entries = h => h.memory.pokeObservations.bots["account:a"].groups["group:123"].sources;

await test("normalizes only real current group poke to immutable non-message observation", async () => {
  const h = host(), raw = h.event(), result = await h.observe(raw);
  assert.equal(result.ok, true); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.observation));
  const { sourceId, ...fields } = result.observation;
  assert.match(sourceId, /^poke_notice:[a-f0-9]{64}$/);
  assert.deepEqual(fields, { userId: "456", groupId: "123", sentAt: START, kind: "poke" });
  assert.deepEqual(entries(h)[sourceId], { userId: "456", sentAt: START, receivedAt: START });
  assert.equal(result.observation.messageId, undefined); assert.equal(result.observation.message_id, undefined);
  assert.equal(h.service.isObservationCurrent(h.ctx, result.observation), true);
});
await test("host provenance mandatory even for identical deserialized payload", async () => {
  const h = host(), e = h.event(); assert.equal((await h.observe({ ...e })).ok, false);
  assert.equal((await h.observe(e)).ok, true);
});
for (const [name, patch] of [["message", { post_type: "message" }], ["other notice", { notice_type: "group_increase" }],
  ["other notify", { sub_type: "lucky_king" }], ["wrong self", { self_id: 901 }], ["wrong target", { target_id: 789 }],
  ["missing target", { target_id: undefined }], ["wrong group", { group_id: 124 }], ["private poke", { group_id: undefined }],
  ["own poke", { user_id: 900 }], ["peer bot", { user_id: 901 }], ["another peer", { user_id: 902 }],
  ["missing user", { user_id: undefined }], ["invalid user", { user_id: 0 }], ["unsafe integer", { user_id: 9007199254740992 }],
  ["string time", { time: String(START / 1000) }], ["future time", { time: START / 1000 + 1 }],
  ["old time", { time: START / 1000 - 300 }], ["bad time", { time: NaN }]]) {
  await test(`reject-${name}`, async () => {
    const h = host(); assert.equal((await h.observe(h.event(patch))).ok, false);
    assert.equal(h.commits, 0); assert.deepEqual(h.memory, {});
  });
}
await test("wire decimal strings supported without lossy coercion", async () => {
  const h = host(), r = await h.observe(h.event({ self_id: "900", target_id: "900", user_id: "456", group_id: "123" }));
  assert.equal(r.ok, true); assert.equal(r.observation.userId, "456");
});
await test("same original notice deduplicates despite new receive time or extra payload", async () => {
  const h = host(), first = await h.observe(); h.tick(1000);
  const duplicate = await h.observe(h.event({ time: START / 1000, extra: "ignored" }));
  assert.equal(first.ok, true); assert.equal(duplicate.reason, "duplicate"); assert.equal(h.commits, 1);
});
await test("protocol-identical same-second notices conservatively deduplicate", async () => {
  const h = host(); assert.equal((await h.observe()).ok, true); assert.equal((await h.observe()).reason, "duplicate");
});
await test("durable dedup survives restart without replaying observation", async () => {
  const h = host(), first = await h.observe(); h.restart();
  assert.equal(h.service.isObservationCurrent(h.ctx, first.observation), false);
  assert.equal((await h.observe()).reason, "duplicate"); assert.equal(h.commits, 1);
});
await test("concurrent different instances serialize sole-writer dedup", async () => {
  const h = host(), other = createPokeObservation(h.deps), ctx2 = other.open("a", "group:123");
  const result = await Promise.all([h.observe(), other.observe(ctx2, h.event())]);
  assert.equal(result.filter(r => r.ok).length, 1); assert.equal(Object.keys(entries(h)).length, 1);
});
await test("one service consumes source before awaiting publication", async () => {
  const h = host(), r = await Promise.all([h.observe(), h.observe()]);
  assert.equal(r.filter(x => x.ok).length, 1); assert.equal(h.commits, 1);
});
await test("observation not returned until durable publish completes", async () => {
  const h = host(); let release, returned = false;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createPokeObservation({ ...h.deps, transact: async builder => { await gate; return h.deps.transact(builder); } });
  const ctx = service.open("a", "group:123"), pending = service.observe(ctx, h.event()).then(r => { returned = true; return r; });
  await Promise.resolve(); assert.equal(returned, false); assert.deepEqual(h.memory, {});
  release(); assert.equal((await pending).ok, true);
});
await test("failed or uncertain publication is never retried locally", async () => {
  for (const uncertain of [false, true]) {
    const h = host(); if (uncertain) h.after(() => { throw Error("uncertain publish"); }); else h.before(() => { throw Error("disk failed"); });
    assert.equal((await h.observe()).ok, false); h.after(); h.before();
    assert.equal((await h.observe()).reason, "duplicate"); assert.equal(h.commits, 1);
    if (uncertain) { h.restart(); assert.equal((await h.observe()).reason, "duplicate"); }
  }
});
await test("abort before observation creates no write", async () => {
  const h = host(), controller = new AbortController(); controller.abort();
  assert.equal((await h.observe(h.event(), { signal: controller.signal })).ok, false); assert.equal(h.commits, 0);
});
await test("abort in transaction blocks admission without retries", async () => {
  const h = host(), controller = new AbortController(); h.before(() => controller.abort());
  assert.equal((await h.observe(h.event(), { signal: controller.signal })).ok, false);
  assert.deepEqual(h.memory, {}); assert.equal((await h.observe()).reason, "duplicate");
});
await test("abort after publication returns no observation and keeps durable fence", async () => {
  const h = host(), controller = new AbortController(); h.after(() => controller.abort());
  assert.equal((await h.observe(h.event(), { signal: controller.signal })).ok, false);
  assert.equal(Object.keys(entries(h)).length, 1); h.after(); h.restart();
  assert.equal((await h.observe()).reason, "duplicate");
});
await test("recipient route/revision change across await invalidates admission", async () => {
  for (const phase of ["before", "after"]) {
    const h = host(); h[phase](() => h.ctx.revision++);
    assert.equal((await h.observe()).ok, false);
    assert.equal(h.commits, 1);
    if (phase === "before") assert.deepEqual(h.memory, {}); else assert.equal(Object.keys(entries(h)).length, 1);
  }
});
await test("raw notice mutation during a queued write is rejected", async () => {
  const h = host(), raw = h.event(); h.before(() => { raw.user_id = 789; });
  assert.equal((await h.observe(raw)).ok, false); assert.deepEqual(h.memory, {});
});
await test("raw notice mutation after publish is not projected as current evidence", async () => {
  const h = host(), raw = h.event(); h.after(() => { raw.target_id = 789; });
  assert.equal((await h.observe(raw)).ok, false); assert.equal(Object.keys(entries(h)).length, 1);
});
await test("freshness rechecked inside write and after publication", async () => {
  for (const phase of ["before", "after"]) {
    const h = host(); h[phase](() => h.tick(300000));
    assert.equal((await h.observe()).ok, false);
    if (phase === "before") assert.deepEqual(h.memory, {}); else assert.equal(Object.keys(entries(h)).length, 1);
  }
});
await test("exact observation handle cannot be cloned or moved to a new context", async () => {
  const h = host(), r = await h.observe(), second = h.service.open("a", "group:123");
  assert.equal(h.service.isObservationCurrent(h.ctx, { ...r.observation }), false);
  assert.equal(h.service.isObservationCurrent(second, r.observation), false);
});
await test("observation expires at TTL and route invalidation", async () => {
  const h = host(), r = await h.observe(); h.quiet();
  assert.equal(h.service.isObservationCurrent(h.ctx, r.observation), false); h.resume();
  h.tick(299999); assert.equal(h.service.isObservationCurrent(h.ctx, r.observation), true);
  h.tick(1); assert.equal(h.service.isObservationCurrent(h.ctx, r.observation), false);
});
await test("group isolation and logical account isolation for identical notice clocks", async () => {
  const h = host(), a = await h.observe();
  const groupCtx = h.service.open("a", "group:124");
  const g = await h.service.observe(groupCtx, h.event({ group_id: 124 }));
  const peerCtx = h.service.open("b", "group:123");
  const b = await h.service.observe(peerCtx, h.event({ self_id: 901, target_id: 901 }));
  assert.equal(g.ok, true); assert.equal(b.ok, true);
  assert.notEqual(g.observation.sourceId, a.observation.sourceId); assert.notEqual(b.observation.sourceId, a.observation.sourceId);
});
await test("failover identity remains scoped to actual targeted recipient", async () => {
  const h = host({ logicalFor: () => "group:pool" }); assert.equal((await h.observe()).ok, true);
  const other = h.service.open("b", "group:123");
  assert.equal((await h.service.observe(other, h.event())).ok, false);
  assert.equal((await h.service.observe(other, h.event({ self_id: 901, target_id: 901 }))).ok, true);
});
await test("read/validation adds no memory defaults and no cross-account repairs", async () => {
  const h = host(), saved = structuredClone(h.memory); h.service.isObservationCurrent(h.ctx, {});
  assert.deepEqual(h.memory, saved);
  await h.observe(); h.memory.pokeObservations.bots["account:b"] = { malformed: true };
  h.tick(1000); assert.equal((await h.observe()).ok, true);
  assert.deepEqual(h.memory.pokeObservations.bots["account:b"], { malformed: true });
});
await test("malformed own ledger fails closed without normalization", async () => {
  const h = host(); await h.observe(); h.memory.pokeObservations.bots["account:a"].lastAt = "bad";
  const saved = structuredClone(h.memory); h.tick(1000); assert.equal((await h.observe()).ok, false); assert.deepEqual(h.memory, saved);
});
await test("expired persisted sources prune only inside sole-writer transaction", async () => {
  const h = host(), first = await h.observe(); h.tick(300000);
  assert.equal(h.service.isObservationCurrent(h.ctx, first.observation), false); assert.equal(Object.keys(entries(h)).length, 1);
  assert.equal((await h.observe()).ok, true); assert.equal(Object.keys(entries(h)).length, 1);
  assert.equal(entries(h)[first.observation.sourceId], undefined);
});
await test("bad host handles and mutated peer list cannot acquire observation authority", async () => {
  const h = host(); assert.equal((await h.service.observe({ ...h.ctx }, h.event())).ok, false);
  h.ctx.peerIds.push("456"); assert.equal((await h.observe()).ok, false); assert.equal(h.commits, 0);
});
await test("private scopes and missing host peers are refused", () => {
  const h = host(); assert.throws(() => h.service.open("a", "private:456"));
  const service = createPokeObservation({ ...h.deps, capture: (accountId, conversationId) => ({ accountId, conversationId,
    logicalId: "account:a", revision: 1, selfId: "900" }) });
  assert.throws(() => service.open("a", "group:123"));
});
await test("clock rollback cannot write a new notice", async () => {
  const h = host(); await h.observe(); h.tick(-1000); assert.equal((await h.observe()).ok, false); assert.equal(h.commits, 1);
});
await test("frozen raw notice is untouched and secret payload is not retained", async () => {
  const h = host(), raw = Object.freeze(h.event({ token: "SECRET", raw_info: "private payload" }));
  const before = JSON.stringify(raw), r = await h.observe(raw);
  assert.equal(r.ok, true); assert.equal(JSON.stringify(raw), before);
  assert.doesNotMatch(JSON.stringify({ r, memory: h.memory }), /SECRET|private payload|token|raw_info/);
});
await test("host observation connects to native notice-only optional poke, not message speech", async () => {
  const h = host(), r = await h.observe(); let calls = 0;
  const native = createNativeSocialActions({
    capture: (accountId, conversationId) => ({ accountId, conversationId, logicalId: "account:a", revision: 1,
      policy: { enabled: true, shadowMode: false, conversationIds: ["group:123"], pokes: { enabled: true } },
      capabilities: { poke: "supported", mention: "supported" } }),
    isCurrent: () => h.service.isObservationCurrent(h.ctx, r.observation),
    getTargets: () => ({ event: { ref: r.observation, ...r.observation, isBot: false },
      members: [{ groupId: "123", userId: "456", verifiedAt: h.time, isBot: false }] }),
    readState: h.deps.readState, transact: h.deps.transact, clock: h.deps.clock,
    request: async (ctx, action, params, { binding }) => {
      assert.equal(binding.isCurrent(), true); assert.equal(action, "group_poke");
      assert.deepEqual(params, { group_id: 123, user_id: 456 }); calls++; return { status: "ok", retcode: 0 };
    }, sendMention: () => assert.fail("notice must never mention") });
  const ctx = native.open("a", "group:123"), offered = native.candidates(ctx);
  assert.equal(calls, 0); assert.equal(offered.mentions.length, 0); assert.equal(offered.pokes.length, 1);
  const ack = await native.sendPoke(ctx, offered.pokes[0].id);
  assert.equal(ack.status, "accepted"); assert.equal(ack.messageId, undefined); assert.equal(calls, 1);
});
await test("full live persisted ledger applies backpressure without eviction", async () => {
  const h = host(); await h.observe();
  const ledger = entries(h), original = Object.keys(ledger)[0];
  for (let n = 1; n < 1000; n++) ledger[`poke_notice:${n.toString(16).padStart(64, "0")}`] = { userId: "456", sentAt: START, receivedAt: START };
  h.tick(1000); const r = await h.observe(); assert.equal(r.ok, false);
  assert.equal(Object.keys(entries(h)).length, 1000); assert.ok(entries(h)[original]);
});
await test("full group scope ledger refuses 129th group without evicting sources", async () => {
  const h = host(); await h.observe(); const groups = h.memory.pokeObservations.bots["account:a"].groups;
  for (let n = 1; n <= 127; n++) groups[`group:${1000 + n}`] = { sources: {
    [`poke_notice:${n.toString(16).padStart(64, "0")}`]: { userId: "456", sentAt: START, receivedAt: START } } };
  const other = h.service.open("a", "group:124"); assert.equal((await h.service.observe(other, h.event({ group_id: 124 }))).ok, false);
  assert.equal(Object.keys(h.memory.pokeObservations.bots["account:a"].groups).length, 128);
});
await test("host provenance rechecked after writer handoff, not only before await", async () => {
  const h = host(); let allowed = true;
  const observer = createPokeObservation({ ...h.deps, isHostEvent: () => allowed });
  const ctx = observer.open("a", "group:123"); h.after(() => { allowed = false; });
  assert.equal((await observer.observe(ctx, h.event())).ok, false); assert.equal(Object.keys(entries(h)).length, 1);
});
console.log(`PASS poke-observation: ${checks} synthetic checks; no network, timers, QQ or model calls`);
