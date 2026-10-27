import assert from "node:assert/strict";
import { createStickerInteraction } from "../src/sticker-interaction.js";

// Synthetic host events and ACKs only. No files, runtime config, model, QQ or IO.
const START = 1_000_000;
const enabled = extra => ({ enabled: true, ...extra });
const scope = extra => ({ logicalId: "account:a", conversationId: "group:123", userId: "456", revision: 1, ...extra });
const scopeKey = s => JSON.stringify([s.logicalId, s.conversationId, s.userId]);
function host({ interactions = enabled(), ...limits } = {}) {
  let time = START, seq = 10, ackSeq = 1000, live = true, brokenClock = false;
  let currentScope = scope(), service;
  const events = new Map();
  const deps = { ...limits, clock: () => { if (brokenClock) throw new Error("clock failed"); return time; },
    isCurrent: () => live,
    isCurrentEvent: (s, e) => events.get(scopeKey(s)) === e };
  const options = extra => ({ interactions, ...extra });
  function event(extra = {}, s = currentScope) {
    const e = { kind: "message", messageId: String(seq++), logicalId: s.logicalId,
      recipientLogicalId: s.logicalId, conversationId: s.conversationId, userId: s.userId,
      sentAt: time, receivedAt: time, isBot: false, isQuoted: false,
      hasSticker: true, directedToBot: true, text: "", ...extra };
    events.set(scopeKey(s), e); return e;
  }
  const observe = (e = event(), s = currentScope, extra) => service.observe(s, { current: e }, options(extra));
  service = createStickerInteraction(deps);
  return { get service() { return service; }, get scope() { return currentScope; },
    get time() { return time; }, events, deps, options, event, observe,
    project: (s = currentScope, extra) => service.project(s, options(extra)),
    begin: (source, s = currentScope, extra) => service.beginReply(s, source, options(extra)),
    receipt: (ticket, r = {}, s = currentScope, extra) => service.recordReceipt(s, ticket,
      { type: "sticker", status: "sent", messageId: String(ackSeq++), ...r }, options(extra)),
    round(extra = {}, s = currentScope) {
      const input = observe(event(extra, s), s);
      assert.equal(input.ok, true); assert.ok(input.source);
      const attempt = service.beginReply(s, input.source, options());
      assert.equal(attempt.ok, true); assert.ok(attempt.ticket);
      return service.recordReceipt(s, attempt.ticket, { type: "sticker", status: "sent", messageId: String(ackSeq++) }, options());
    },
    tick: (ms = 1001) => { time += ms; }, clockValue: v => { time = v; }, failClock: () => { brokenClock = true; },
    live: value => { live = value; }, policy: value => { interactions = value; },
    setScope: value => { currentScope = value; },
    restart() { events.clear(); service = createStickerInteraction(deps); } };
}

const passed = [];
function test(name, fn) {
  try { fn(); passed.push(name); }
  catch (error) { throw new Error(name, { cause: error }); }
}
test("default separate policy is off", () => {
  const h = host(), e = h.event();
  assert.equal(h.service.observe(h.scope, { current: e }).reason, "disabled");
  assert.equal(h.service.project(h.scope).stage, "ended");
});
test("factory requires actual host guards", () => {
  for (const patch of [{ isCurrent: undefined }, { isCurrentEvent: undefined }, { clock: null },
    { maxScopes: 0 }, { maxSources: 0 }, { maxScopes: 1025 }, { maxSources: 10001 }])
    assert.throws(() => createStickerInteraction({ clock: () => START, isCurrent: () => true, isCurrentEvent: () => true, ...patch }));
});
test("invalid initial clock rejected", () => {
  for (const value of [NaN, Infinity, -1, "123", 8640000000000000])
    assert.throws(() => createStickerInteraction({ clock: () => value, isCurrent: () => true, isCurrentEvent: () => true }));
});
for (const [name, value] of [["null", null], ["array", []], ["unknown fields", { enabled: true, target: "123" }],
  ["coerced enabled", { enabled: 1 }], ["coerced shadow", { enabled: true, shadowMode: "false" }],
  ["zero TTL", enabled({ ttlMs: 0 })], ["infinite TTL", enabled({ ttlMs: Infinity })],
  ["short hard duration", enabled({ ttlMs: 2000, maxDurationMs: 1000 })],
  ["zero cap", enabled({ maxReciprocations: 0 })], ["excess cap", enabled({ maxReciprocations: 9 })],
  ["negative cooldown", enabled({ cooldownMs: -1 })], ["excess source age", enabled({ maxSourceAgeMs: 300001 })]]) {
  test(`invalid-policy-${name}`, () => {
    const h = host({ interactions: value }); assert.equal(h.observe().reason, "invalid-policy");
  });
}
test("shared sticker policy is not interaction opt-in", () => {
  const h = host({ interactions: { stickers: { enabled: true, autoSend: true } } });
  assert.equal(h.observe().ok, false);
});
test("shadow mode issues no handle or pending work", () => {
  const h = host({ interactions: enabled({ shadowMode: true }) });
  assert.equal(h.observe().reason, "shadow"); assert.equal(h.project().awaitingReceipt, false);
});
test("ordinary unaddressed sticker is not a reply invitation", () => {
  const h = host(), r = h.observe(h.event({ directedToBot: false }));
  assert.equal(r.projection.stage, "ordinary"); assert.equal(r.source, null);
});
test("ordinary non-sticker directed chat is not sticker intent", () => {
  const h = host(), r = h.observe(h.event({ hasSticker: false, text: "早上好" }));
  assert.equal(r.projection.stage, "ordinary"); assert.equal(r.source, null);
});
test("first directed human sticker creates one opportunity", () => {
  const h = host(), r = h.observe();
  assert.equal(r.projection.stage, "directed"); assert.equal(r.projection.humanTurns, 1);
  assert.equal(r.projection.reciprocations, 0); assert.equal(r.projection.hasCurrentOpportunity, true);
});
test("host-confirmed sticker request can start without an image", () => {
  const h = host(), r = h.observe(h.event({ hasSticker: false, stickerRequested: true }));
  assert.equal(r.projection.stage, "directed"); assert.ok(r.source);
});
test("quoted or forwarded evidence is not current human input", () => {
  for (const patch of [{ isQuoted: true }, { kind: "notice" }, { kind: "history" }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).reason, "invalid-source");
  }
});
test("explicit false human and unquoted evidence required", () => {
  for (const patch of [{ isBot: true }, { isBot: undefined }, { isBot: "false" }, { isQuoted: undefined }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).reason, "invalid-source");
  }
});
test("peer bot events cannot create or progress sessions", () => {
  const h = host(); h.round(); h.tick();
  assert.equal(h.observe(h.event({ isBot: true })).ok, false);
  assert.equal(h.project().reciprocations, 1); assert.equal(h.project().humanTurns, 1);
});
test("recipient must be exact and explicit", () => {
  for (const recipientLogicalId of [undefined, null, "account:b", "group:a"]) {
    const h = host(); assert.equal(h.observe(h.event({ recipientLogicalId })).reason, "invalid-source");
  }
});
test("matching logical identity, conversation and sender required", () => {
  for (const patch of [{ logicalId: "account:b" }, { conversationId: "group:124" }, { userId: "789" }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).reason, "invalid-source");
  }
});
test("deserialized equal event cannot forge host current evidence", () => {
  const h = host(), e = h.event();
  assert.equal(h.observe(structuredClone(e)).ok, false); assert.equal(h.observe(e).ok, true);
});
test("missing host classification and invalid flags fail closed", () => {
  for (const patch of [{ hasSticker: undefined }, { directedToBot: "yes" }, { battleRequested: 1 },
    { serious: "false" }, { negativeFeedback: "false" }, { stop: 0 }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).ok, false);
  }
});
test("invalid source shapes do not become authority", () => {
  for (const patch of [{ messageId: "abc" }, { messageId: 10 }, { text: null }, { text: "x".repeat(4001) },
    { target: "789" }, { tools: [] }, { sentAt: NaN }, { receivedAt: Infinity }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).ok, false);
  }
});
test("pre-start, future and expired source events rejected", () => {
  for (const patch of [{ receivedAt: START - 1, sentAt: START - 1 }, { sentAt: START + 1 },
    { receivedAt: START + 1 }, { sentAt: START - 300000 }]) {
    const h = host(); assert.equal(h.observe(h.event(patch)).ok, false);
  }
});
test("source age exact boundary is closed", () => {
  const h = host({ interactions: enabled({ maxSourceAgeMs: 10 }) }), e = h.event(); h.tick(10);
  assert.equal(h.observe(e).ok, false);
});
test("source dedup survives cancellation and changed payload", () => {
  const h = host(), e = h.event(), r = h.observe(e); h.service.cancel(h.scope);
  const duplicate = h.event({ messageId: e.messageId, stickerRequested: true });
  assert.equal(h.observe(duplicate).reason, "duplicate-source");
  assert.equal(h.begin(r.source).ok, false);
});
test("source cannot be reassigned to another human in same conversation", () => {
  const h = host(), e = h.event(); h.observe(e);
  const other = scope({ userId: "789" }), copied = h.event({ messageId: e.messageId }, other);
  assert.equal(h.observe(copied, other).reason, "duplicate-source");
});
test("logical accounts are independent even with same event IDs", () => {
  const h = host(), a = h.observe(), bScope = scope({ logicalId: "account:b" });
  const b = h.observe(h.event({ messageId: "10" }, bScope), bScope);
  assert.equal(b.ok, true); assert.equal(h.begin(a.source, bScope).ok, false);
  assert.equal(h.begin(b.source).ok, false); assert.equal(h.begin(a.source).ok, true);
});
test("groups are isolated including reused source IDs", () => {
  const h = host(), a = h.observe(), other = scope({ conversationId: "group:124" });
  const b = h.observe(h.event({ messageId: "10" }, other), other);
  assert.ok(b.source); assert.equal(h.begin(a.source, other).ok, false);
});
test("humans have independent bounded sessions in same group", () => {
  const h = host(); h.round(); const other = scope({ userId: "789" });
  const b = h.observe(h.event({}, other), other);
  assert.equal(b.projection.reciprocations, 0); assert.equal(h.project().reciprocations, 1);
});
test("explicit failover logical identity scopes work without account ownership guesses", () => {
  const h = host(); h.setScope(scope({ logicalId: "group:failover" }));
  assert.equal(h.round().projection.stage, "exchange");
});
test("private current recipient creates directed stage without a group mention", () => {
  const h = host(); h.setScope(scope({ conversationId: "private:456" }));
  assert.equal(h.observe(h.event({ directedToBot: false })).projection.stage, "directed");
});
test("private recipient mismatch is never inferred from chat type", () => {
  const h = host(); h.setScope(scope({ conversationId: "private:456" }));
  assert.equal(h.observe(h.event({ recipientLogicalId: "account:b" })).ok, false);
});
test("private scope cannot carry a different human or leak group continuity", () => {
  const h = host(); h.round(); const privateScope = scope({ conversationId: "private:456" });
  assert.equal(h.project(privateScope).reciprocations, 0);
  assert.equal(h.observe(h.event({}, scope({ conversationId: "private:789" })), scope({ conversationId: "private:789" })).ok, false);
});
test("one-use source and ticket cannot be forged", () => {
  const h = host(), r = h.observe();
  assert.equal(h.begin({}).ok, false);
  const attempt = h.begin(r.source); assert.equal(attempt.ok, true);
  assert.equal(h.begin(r.source).ok, false); assert.equal(h.receipt({}).recorded, false);
});
test("source is consumed at begin rather than on successful ACK", () => {
  const h = host(), r = h.observe(), attempt = h.begin(r.source);
  assert.equal(attempt.projection.awaitingReceipt, true);
  assert.equal(attempt.projection.reciprocations, 0); assert.equal(attempt.projection.hasCurrentOpportunity, false);
});
test("own confirmed image ACK alone advances exchange once", () => {
  const h = host(), attempt = h.begin(h.observe().source), r = h.receipt(attempt.ticket);
  assert.equal(r.recorded, true); assert.equal(r.projection.stage, "exchange"); assert.equal(r.projection.reciprocations, 1);
  assert.equal(h.receipt(attempt.ticket).recorded, false); assert.equal(h.project().reciprocations, 1);
});
test("generic host image ACK uses the same image-only contract", () => {
  const h = host(), attempt = h.begin(h.observe().source);
  assert.equal(h.receipt(attempt.ticket, { type: "image" }).recorded, true);
});
test("receipt ticket is bound to logical bot, group and human", () => {
  const h = host(), attempt = h.begin(h.observe().source);
  for (const other of [scope({ logicalId: "account:b" }), scope({ conversationId: "group:124" }), scope({ userId: "789" })])
    assert.equal(h.receipt(attempt.ticket, {}, other).recorded, false);
  assert.equal(h.receipt(attempt.ticket).recorded, true);
});
for (const [name, patch] of [["uncertain", { status: "uncertain" }], ["failed", { status: "failed" }],
  ["rejected", { status: "rejected" }], ["native reaction accepted", { type: "reaction", status: "accepted" }],
  ["poke accepted", { type: "poke", status: "accepted" }], ["text ACK", { type: "text" }],
  ["missing ACK", { messageId: undefined }], ["coerced ACK", { messageId: 99 }],
  ["raw protocol ACK", { message_id: "99" }], ["ambiguous skipped ACK", { skipped: true }]]) {
  test(`non-image-or-unconfirmed-${name}`, () => {
    const h = host(), r = h.observe(), attempt = h.begin(r.source);
    assert.equal(h.receipt(attempt.ticket, patch).recorded, false);
    assert.equal(h.project().stage, "ended"); assert.equal(h.project().reciprocations, 0);
    assert.equal(h.begin(r.source).ok, false); assert.equal(h.receipt(attempt.ticket).recorded, false);
    h.tick(); assert.equal(h.observe().source, null);
  });
}
test("null receipt consumes attempt with no retries", () => {
  const h = host(), attempt = h.begin(h.observe().source);
  const r = h.service.recordReceipt(h.scope, attempt.ticket, null, h.options());
  assert.equal(r.recorded, false); assert.equal(h.receipt(attempt.ticket).recorded, false);
});
test("ACK dedup crosses human scopes within same logical conversation", () => {
  const h = host(), a = h.begin(h.observe().source); h.receipt(a.ticket, { messageId: "100" });
  const other = scope({ userId: "789" }), b = h.begin(h.observe(h.event({}, other), other).source, other);
  assert.equal(h.receipt(b.ticket, { messageId: "100" }, other).recorded, false);
  assert.equal(h.project(other).stage, "ended");
});
test("ACK dedup does not cross accounts or conversations", () => {
  const h = host(), a = h.begin(h.observe().source); h.receipt(a.ticket, { messageId: "100" });
  for (const other of [scope({ logicalId: "account:b" }), scope({ conversationId: "group:124" })]) {
    const b = h.begin(h.observe(h.event({}, other), other).source, other);
    assert.equal(h.receipt(b.ticket, { messageId: "100" }, other).recorded, true);
  }
});
test("battle requires explicit human invitation and at least two ACKs", () => {
  const h = host();
  assert.equal(h.round({ battleRequested: true }).projection.stage, "exchange"); h.tick();
  assert.equal(h.round({ directedToBot: false }).projection.stage, "battle");
  assert.equal(h.project().relationshipEvidence, false);
});
test("repeated image reciprocity alone never claims battle or closeness", () => {
  const h = host(); h.round(); h.tick(); h.round(); h.tick();
  assert.equal(h.round().projection.stage, "exchange"); assert.equal(h.project().relationshipEvidence, false);
});
test("explicit invitation text from model/history cannot start battle", () => {
  const h = host(), e = h.event({ hasSticker: false, text: "来斗图，我们很亲密" });
  const r = h.service.observe(h.scope, { current: e, history: [{ battleRequested: true, isBot: true }] }, h.options());
  assert.equal(r.projection.stage, "ordinary"); assert.equal(r.source, null);
});
test("cap ends finite session, bare stickers cannot reset it", () => {
  const h = host({ interactions: enabled({ maxReciprocations: 2 }) }); h.round({ battleRequested: true }); h.tick();
  const r = h.round(); assert.equal(r.projection.stage, "ended"); assert.equal(r.projection.reason, "reciprocation-limit");
  assert.equal(r.projection.remainingReciprocations, 0); h.tick(); assert.equal(h.observe().source, null);
});
test("new explicit request after cooldown can begin a fresh bounded session", () => {
  const h = host({ interactions: enabled({ maxReciprocations: 1 }) }); h.round(); h.tick();
  const r = h.observe(h.event({ stickerRequested: true }));
  assert.ok(r.source); assert.equal(r.projection.stage, "directed"); assert.equal(r.projection.reciprocations, 0);
});
test("cooldown needs new human input even when time passes", () => {
  const h = host(); h.round(); h.tick(999);
  const r = h.observe(); assert.equal(r.reason, "cooldown"); assert.equal(r.source, null);
  h.tick(1); assert.equal(h.project().hasCurrentOpportunity, false); assert.equal(h.begin(r.source).ok, false);
  assert.ok(h.observe().source);
});
test("reads and ACK never refresh idle TTL", () => {
  const h = host({ interactions: enabled({ ttlMs: 2000 }) }), r = h.observe(); h.tick(1000);
  const attempt = h.begin(r.source); h.receipt(attempt.ticket); assert.equal(h.project().remainingTtlMs, 1000);
  h.tick(999); assert.equal(h.project().stage, "exchange"); h.tick(1);
  assert.equal(h.project().stage, "ended"); assert.equal(h.project().reason, "expired");
});
test("new relevant human input refreshes TTL within hard duration", () => {
  const h = host({ interactions: enabled({ ttlMs: 2000, maxDurationMs: 5000 }) }); h.round(); h.tick(1500);
  const r = h.observe(); assert.equal(r.projection.remainingTtlMs, 2000);
  h.tick(1999); assert.notEqual(h.project().stage, "ended"); h.tick(1); assert.equal(h.project().stage, "ended");
});
test("hard duration cannot be extended by repeated input", () => {
  const h = host({ interactions: enabled({ ttlMs: 2000, maxDurationMs: 3000 }) }); h.observe();
  h.tick(1500); assert.ok(h.observe().source); h.tick(1499); assert.ok(h.observe().source);
  assert.equal(h.project().remainingTtlMs, 1); h.tick(1);
  assert.equal(h.project().reason, "duration-limit"); assert.equal(h.observe().source, null);
});
for (const [name, patch, expected] of [["host stop", { stop: true }, "stopped"],
  ["host serious", { serious: true }, "serious"], ["host negative", { negativeFeedback: true }, "negative-feedback"],
  ["stop text", { text: "不要发表情了" }, "stopped"], ["negative text", { text: "谁问你了" }, "negative-feedback"],
  ["serious text", { text: "代码报错，认真帮我看看" }, "serious"]]) {
  test(`terminate-${name}`, () => {
    const h = host(); h.round(); h.tick();
    const r = h.observe(h.event({ battleRequested: true, ...patch }));
    assert.equal(r.source, null); assert.equal(r.projection.reason, expected); assert.equal(r.projection.stage, "ended");
    h.tick(); assert.equal(h.observe().source, null);
  });
}
test("non-sticker topic change ends exchange", () => {
  const h = host(); h.round(); h.tick();
  assert.equal(h.observe(h.event({ hasSticker: false, text: "明天几点见" })).projection.reason, "topic-changed");
});
test("stale timestamp cannot progress but negative feedback still stops", () => {
  const h = host(); h.observe(); h.tick(20); h.observe();
  assert.equal(h.observe(h.event({ sentAt: START + 10 })).reason, "out-of-order");
  assert.equal(h.observe(h.event({ sentAt: START + 9, stop: true })).projection.reason, "stopped");
});
test("distinct real messages with equal protocol timestamp are not duplicates", () => {
  const h = host({ interactions: enabled({ cooldownMs: 0 }) }); h.round();
  assert.ok(h.observe().source);
});
test("new input supersedes unused source without duplicating opportunity", () => {
  const h = host(), old = h.observe(); h.tick(); const fresh = h.observe();
  assert.equal(h.begin(old.source).ok, false); assert.equal(h.begin(fresh.source).ok, true);
});
test("host event mutation after observe cannot rewrite source authority", () => {
  for (const patch of [{ messageId: "999" }, { text: "changed" }, { battleRequested: true }]) {
    const h = host(), e = h.event(), r = h.observe(e); Object.assign(e, patch);
    assert.equal(h.begin(r.source).ok, false); assert.equal(h.project().stage, "ended");
  }
});
test("source ceasing to be current cannot begin a reply", () => {
  const h = host(), r = h.observe(); h.event(); assert.equal(h.begin(r.source).ok, false);
});
test("new event while attempt unresolved ends instead of creating a second send", () => {
  const h = host(), attempt = h.begin(h.observe().source); h.tick();
  assert.equal(h.observe(h.event({ battleRequested: true })).reason, "reply-pending");
  const late = h.receipt(attempt.ticket); assert.equal(late.recorded, true); assert.equal(late.projection.stage, "ended");
});
test("cancel blocks old source and requires new explicit request", () => {
  const h = host(), r = h.observe(); assert.equal(h.service.cancel(h.scope).cancelled, true);
  assert.equal(h.begin(r.source).ok, false); assert.equal(h.observe().source, null);
  assert.ok(h.observe(h.event({ stickerRequested: true })).source);
});
test("cancel is scope-local", () => {
  const h = host(), a = h.observe(), bScope = scope({ userId: "789" });
  const b = h.observe(h.event({}, bScope), bScope); h.service.cancel(h.scope);
  assert.equal(h.begin(a.source).ok, false); assert.equal(h.begin(b.source, bScope).ok, true);
});
test("aborted signal before claim ends without a ticket", () => {
  const h = host(), r = h.observe(), abort = new AbortController(); abort.abort();
  assert.equal(h.begin(r.source, h.scope, { signal: abort.signal }).reason, "cancelled");
  assert.equal(h.begin(r.source).ok, false);
});
test("abort after begin still records one late real ACK without revival", () => {
  const h = host(), attempt = h.begin(h.observe().source), abort = new AbortController(); abort.abort();
  const r = h.receipt(attempt.ticket, {}, h.scope, { signal: abort.signal });
  assert.equal(r.recorded, true); assert.equal(r.projection.stage, "ended"); assert.equal(r.projection.reason, "cancelled");
});
test("late ACK after explicit stop records fact without reviving battle", () => {
  const h = host(), attempt = h.begin(h.observe(h.event({ battleRequested: true })).source); h.tick();
  h.observe(h.event({ stop: true }));
  assert.equal(h.receipt(attempt.ticket).projection.reason, "stopped"); assert.equal(h.project().reciprocations, 1);
});
test("late ACK after TTL expires records only historical fact", () => {
  const h = host({ interactions: enabled({ ttlMs: 1000 }) }), attempt = h.begin(h.observe().source); h.tick(1000);
  const r = h.receipt(attempt.ticket); assert.equal(r.recorded, true); assert.equal(r.projection.stage, "ended");
});
test("quiet or invalid live context ends at next synchronous boundary", () => {
  const h = host(), r = h.observe(); h.live(false);
  assert.equal(h.begin(r.source).reason, "stale"); h.live(true); assert.equal(h.begin(r.source).ok, false);
});
test("throwing host guard fails closed", () => {
  const h = host();
  const service = createStickerInteraction({ ...h.deps, isCurrent: () => { throw new Error("stale"); } });
  assert.equal(service.observe(h.scope, { current: h.event() }, h.options()).reason, "stale");
});
test("throwing event guard rejects current source", () => {
  const h = host();
  const service = createStickerInteraction({ ...h.deps, isCurrentEvent: () => { throw new Error("bad source"); } });
  assert.equal(service.observe(h.scope, { current: h.event() }, h.options()).reason, "invalid-source");
});
test("revision changes invalidate existing source", () => {
  const h = host(), r = h.observe(), next = scope({ revision: 2 });
  assert.equal(h.begin(r.source, next).ok, false); assert.equal(h.project(next).reason, "context-changed");
});
test("policy off or shadow invalidates old source after reenable", () => {
  for (const p of [enabled({ enabled: false }), enabled({ shadowMode: true })]) {
    const h = host(), r = h.observe(); h.policy(p); assert.equal(h.project().stage, "ended");
    h.policy(enabled()); assert.equal(h.begin(r.source).ok, false);
  }
});
test("live policy change requires fresh human request, never silent resume", () => {
  const h = host(), r = h.observe(); h.policy(enabled({ maxReciprocations: 2 }));
  assert.equal(h.begin(r.source).ok, false); assert.equal(h.observe().source, null);
  assert.ok(h.observe(h.event({ stickerRequested: true })).source);
});
test("late ACK after policy disabled remains a fact, not permission", () => {
  const h = host(), attempt = h.begin(h.observe().source); h.policy({ enabled: false });
  const r = h.receipt(attempt.ticket); assert.equal(r.recorded, true); assert.equal(r.projection.reason, "disabled");
});
test("history is never replayed or used to restore sessions", () => {
  const h = host(), history = [{ ...h.event(), battleRequested: true }]; h.restart();
  assert.equal(h.project().stage, "ordinary");
  const r = h.service.observe(h.scope, { history }, h.options()); assert.equal(r.ok, false);
  assert.equal(h.project().humanTurns, 0);
});
test("restart rejects old issued event, source and receipt ticket", () => {
  const h = host(), e = h.event(), r = h.observe(e), attempt = h.begin(r.source); h.restart();
  assert.equal(h.observe(e).ok, false); assert.equal(h.begin(r.source).ok, false);
  assert.equal(h.receipt(attempt.ticket).recorded, false); assert.equal(h.project().reciprocations, 0);
  assert.equal(h.observe().projection.stage, "directed");
});
test("bounded history is compatibility data not an alternate source lane", () => {
  const h = host(), e = h.event();
  for (const history of [null, {}, Array(129).fill({})])
    assert.equal(h.service.observe(h.scope, { current: e, history }, h.options()).ok, false);
  assert.equal(h.service.observe(h.scope, { current: e, history: Array(128).fill({}) }, h.options()).ok, true);
});
test("scope and source capacity apply backpressure without evicting live fences", () => {
  const h = host({ maxScopes: 1, maxSources: 2 }), first = h.observe();
  const other = scope({ userId: "789" }); assert.equal(h.observe(h.event({}, other), other).reason, "capacity");
  h.service.cancel(h.scope); assert.equal(h.observe().reason, "capacity");
  assert.equal(h.begin(first.source).ok, false);
});
test("expired scope slots are reclaimed on real events only", () => {
  const h = host({ maxScopes: 1 }); h.observe(); h.tick(300001);
  const other = scope({ userId: "789" }); assert.ok(h.observe(h.event({}, other), other).source);
});
test("same scope can safely reuse slot after retention expiry", () => {
  const h = host({ maxScopes: 1 }); h.observe(); h.tick(300001);
  const r = h.observe(); assert.ok(r.source); assert.equal(h.begin(r.source).ok, true);
});
test("unsettled attempts never evicted to create more work", () => {
  const h = host({ maxScopes: 1 }); h.begin(h.observe().source); h.tick(600001);
  const other = scope({ userId: "789" }); assert.equal(h.observe(h.event({}, other), other).reason, "capacity");
});
test("bounded receipt ledger fails closed when saturated", () => {
  const h = host({ maxSources: 1 }), attempt = h.begin(h.observe().source); h.receipt(attempt.ticket);
  h.tick(300001); const next = h.begin(h.observe(h.event({ stickerRequested: true })).source);
  assert.equal(h.receipt(next.ticket).reason, "receipt-duplicate-or-capacity");
});
test("clock rollback is latched and cannot reopen old sources", () => {
  const h = host(), r = h.observe(); h.tick(1); h.project(); h.tick(-1);
  assert.equal(h.begin(r.source).reason, "clock-invalid"); h.tick(1000); assert.equal(h.observe().reason, "clock-invalid");
});
test("runtime clock failure never escapes or enables more work", () => {
  const h = host(), r = h.observe(); h.failClock(); assert.equal(h.begin(r.source).reason, "clock-invalid");
});
test("late real ACK with clock failure cannot revive ended context", () => {
  const h = host(), attempt = h.begin(h.observe().source); h.failClock();
  const r = h.receipt(attempt.ticket); assert.equal(r.recorded, true); assert.equal(r.projection.stage, "ended");
});
test("immutable projection has fixed safe fields, no raw text or closeness", () => {
  const h = host(), r = h.observe(h.event({ text: "SECRET;我们很亲密" })), p = r.projection;
  assert(Object.isFrozen(h.service)); assert(Object.isFrozen(r)); assert(Object.isFrozen(r.source)); assert(Object.isFrozen(p));
  assert.throws(() => { p.stage = "battle"; });
  assert.deepEqual(Object.keys(p).sort(), ["stage", "reason", "ephemeral", "restartReplay", "relationshipEvidence", "grantsAuthority",
    "humanTurns", "reciprocations", "remainingReciprocations", "awaitingReceipt", "hasCurrentOpportunity", "remainingTtlMs"].sort());
  assert.doesNotMatch(JSON.stringify(p), /SECRET|亲密|account:|group:|messageId|token/);
  assert.equal(p.grantsAuthority, false); assert.equal(p.relationshipEvidence, false); assert.equal(p.restartReplay, false);
});
test("frozen caller inputs are never mutated or given persistent defaults", () => {
  const h = host(), e = Object.freeze(h.event()), s = Object.freeze(h.scope), p = Object.freeze(enabled());
  const history = Object.freeze([]), input = Object.freeze({ current: e, history });
  const options = Object.freeze({ interactions: p }), before = JSON.stringify({ e, s, p, input });
  const r = h.service.observe(s, input, options); assert.ok(r.source);
  h.service.beginReply(s, r.source, options);
  assert.equal(JSON.stringify({ e, s, p, input }), before);
});
test("empty or malformed scopes cannot create authority", () => {
  const h = host();
  for (const s of [null, {}, scope({ logicalId: "__proto__" }), scope({ conversationId: "public:1" }),
    scope({ userId: "all" }), scope({ revision: null })]) {
    assert.equal(h.service.observe(s, { current: h.event() }, h.options()).ok, false);
    assert.equal(h.service.cancel(s).cancelled, false);
  }
});
test("no timer or networking dependency needed for full finite exchange", () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = () => { throw new Error("timer forbidden"); };
  try {
    const h = host({ interactions: enabled({ cooldownMs: 0, maxReciprocations: 3 }) });
    h.round({ battleRequested: true }); h.round();
    assert.equal(h.round().projection.stage, "ended");
  } finally { globalThis.setTimeout = original; }
});

assert(passed.length >= 40);
console.log(JSON.stringify({ ok: true, tests: passed.length, passed, modelCalls: 0, qqSends: 0 }));
