import assert from "node:assert/strict";
import { createExpressionLibrary } from "../src/social-expression-library.js";
import { validateSocialExperiencePolicy } from "../src/social-experience-policy.js";
import { observeGroupLanguage, listGroupLanguage } from "../src/group-language-learning.js";

// Every dependency is fake. No network/model/QQ or persistent memory is touched.
const START = Date.parse("2026-10-24T10:00:00+08:00");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=", "base64");
let checks = 0;
async function test(name, fn) { try { await fn(); checks++; } catch (e) { throw new Error(name, { cause: e }); } }
function harness(policyPatch = {}) {
  let root = { memory: {} }, time = START, current = true, online = true, failure = false;
  let hostRevision = "host:1", before = () => {}, after = () => {}, down = async () => {}, vision = async () => {};
  let protocol = { status: "ok", retcode: 0, data: [{ emoji_id: "s1", url: "https://cdn.qq.com/a.png", desc: "official-untrusted" }] };
  let policy = validateSocialExperiencePolicy({ enabled: true, shadowMode: false, conversationIds: ["group:1", "group:2", "private:1"],
    stickers: { enabled: true, autoSend: true, visionLearning: true, maxDailyVisionCalls: 2, cooldownMs: 60000 }, ...policyPatch });
  const captures = new WeakSet(), calls = [], models = [], downloads = [], transactions = [];
  let tail = Promise.resolve();
  const options = {
    readState: () => root,
    transact: builder => {
      assert.notEqual(builder.constructor.name, "AsyncFunction");
      const promise = tail.then(() => {
        const hook = before; before = () => {}; hook();
        const draft = structuredClone(root), result = builder(draft); assert.ok(!result?.then);
        if (failure) throw new Error("SECRET disk content");
        root = draft; transactions.push(result);
        const published = after; after = () => {}; published(); return result;
      }); tail = promise.catch(() => {}); return promise;
    },
    capture: (accountId, conversationId) => {
      const ctx = { accountId, logicalId: `account:${accountId}`, conversationId, internalId: conversationId,
        revision: hostRevision, policy: { ...structuredClone(policy), active: policy.enabled && policy.conversationIds.includes(conversationId) },
        selected: online, ws: online ? {} : null, identity: { privateHostField: true } };
      captures.add(ctx); return ctx;
    },
    isCurrent: ctx => captures.has(ctx) && current && ctx.revision === hostRevision,
    request: async (ctx, action, args, { signal }) => {
      assert.ok(captures.has(ctx)); assert.equal(action, "fetch_custom_face_detail"); assert.deepEqual(args, { count: 100 });
      if (!online || signal?.aborted) throw new Error("SECRET unavailable"); calls.push(action); return structuredClone(protocol);
    },
    downloadImage: async (url, opts) => { downloads.push(url); await down(opts); return { buffer: png, mimeType: "image/png" }; },
    describeImage: async (ctx, media, opts) => { assert.ok(captures.has(ctx)); assert.ok(Buffer.isBuffer(media.buffer)); models.push(ctx.logicalId); await vision(ctx, opts); return { note: "开心赞同", tags: ["开心", "赞同"] }; },
    clock: () => time
  };
  const lib = createExpressionLibrary(options);
  const h = { lib, options, calls, models, downloads, transactions, root: () => root,
    ctx: (accountId = "alpha", conversationId = "group:1") => lib.open(accountId, conversationId),
    time: n => { time = n; }, current: b => { current = b; }, online: b => { online = b; },
    revision: r => { hostRevision = r; }, before: fn => { before = fn; }, after: fn => { after = fn; },
    down: fn => { down = fn; }, vision: fn => { vision = fn; }, fail: b => { failure = b; },
    policy: p => { policy = validateSocialExperiencePolicy(p); }, protocol: p => { protocol = p; }
  };
  h.op = (ctx, op, body = {}) => lib.operate(ctx, op, { expectedStateRevision: lib.snapshot(ctx).revision, conversationId: ctx.conversationId, ...body });
  return h;
}
async function confirmed(h, ctx) {
  assert.equal((await h.op(ctx, "sync")).ok, true);
  const annotation = await h.op(ctx, "annotate", { id: "s1" }); assert.equal(annotation.ok, true);
  assert.equal((await h.op(ctx, "review-sticker", { id: "s1", expectedRevision: annotation.result.revision, status: "confirmed" })).ok, true);
}
const annotation = (h, ctx) => h.root().memory.socialExpressionAssets.bots[ctx.logicalId].stickers.s1.annotations[ctx.conversationId];
const allClaims = h => Object.values(h.root().memory.socialExpressionLibrary?.bots || {}).flatMap(b => Object.values(b.days).flatMap(d => Object.values(d.claims)));

await test("missing preview is read-only and offline/paused/policy-off compatible", () => {
  const h = harness({ enabled: false, stickers: { enabled: false } }); h.online(false); const ctx = h.ctx();
  const before = structuredClone(h.root()), s = h.lib.snapshot(ctx);
  assert.equal(s.ok, true); assert.match(s.revision, /^[a-f0-9]{64}$/); assert.deepEqual(s.stickers, []);
  assert.equal(s.capabilities.collection, "unknown"); assert.deepEqual(h.root(), before);
  assert.equal(h.calls.length + h.models.length + h.downloads.length, 0);
  assert.deepEqual(s.dailyVisionCalls, { reserved: 0, attempted: 0, limit: 8 });
});
await test("snapshot rejects stale issued ctx while fact ACK remains separately authorized", () => {
  const h = harness(), ctx = h.ctx(); h.current(false);
  assert.deepEqual(h.lib.snapshot(ctx), { ok: false, code: "EXPRESSION_STALE" });
  assert.deepEqual(h.lib.snapshot({ ...ctx }), { ok: false, code: "EXPRESSION_CONTEXT" });
});
await test("open requires explicit canonical scope, not active policy", () => {
  const h = harness({ enabled: false }); assert.ok(h.ctx());
  for (const scope of ["1", "group:01", "group:99", "private:1:foreign"]) assert.throws(() => h.ctx("alpha", scope));
});
await test("fabricated/cloned and mutated identities have no authority", async () => {
  const h = harness(), ctx = h.ctx(); assert.equal(h.lib.snapshot({ ...ctx }).code, "EXPRESSION_CONTEXT");
  assert.equal((await h.lib.operate({ ...ctx }, "sync", {})).ok, false);
  ctx.logicalId = "account:beta"; assert.equal(h.lib.snapshot(ctx).code, "EXPRESSION_CONTEXT");
});
await test("snapshot strips URLs/receipt ledgers and stays detached", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.lib.candidates(ctx, { query: "开心" }); assert.ok((await h.lib.prepare(ctx, { id: "s1" })).segment);
  assert.equal((await h.lib.markSent(ctx, { id: "s1", messageId: "100" })).ok, true);
  const s = h.lib.snapshot(ctx); assert.equal(s.stickers[0].official.url, undefined); assert.equal(s.stickers[0].annotation.receipts, undefined);
  assert.equal(s.stickers[0].annotation.sentCount, 1);
  assert(s.stickers[0].annotation.lastSentAt > 0);
  s.stickers[0].annotation.tags.push("mutated");
  assert.ok(!annotation(h, ctx).tags.includes("mutated"));
});
await test("hash is scoped, deterministic and invalidated by relevant mutations", async () => {
  const h = harness(), a = h.ctx(), b = h.ctx("beta"), g = h.ctx("alpha", "group:2"); await confirmed(h, a);
  const before = h.lib.snapshot(a).revision;
  h.root().memory.unrelated = "preserve"; await confirmed(h, b); assert.equal(h.lib.snapshot(a).revision, before);
  observeGroupLanguage(h.root().memory, { ...g, message: { messageId: "l", userId: "123456789", text: "词在本群的意思是意义", sentAt: START, receivedAt: START } });
  assert.equal(h.lib.snapshot(a).revision, before);
  annotation(h, a).revision++; assert.notEqual(h.lib.snapshot(a).revision, before);
  h.revision("host:2"); assert.notEqual(h.lib.snapshot(h.ctx()).revision, before);
});
await test("management rejects body authority and mismatched conversation", async () => {
  const h = harness(), ctx = h.ctx();
  for (const body of [{ actor: "admin" }, { url: "https://cdn.qq.com/a" }, { logicalId: "account:beta" }, { permissions: true }]) {
    assert.equal((await h.op(ctx, "sync", body)).code, "EXPRESSION_ARGUMENT");
  }
  assert.equal((await h.op(ctx, "sync", { conversationId: "group:2" })).code, "EXPRESSION_SCOPE");
  for (const op of ["prepare", "candidates", "markSent", "delete-all"]) assert.equal((await h.op(ctx, op)).ok, false);
  assert.equal(h.calls.length, 0);
});
await test("expectedStateRevision is mandatory and exact before external work", async () => {
  const h = harness(), ctx = h.ctx();
  for (const revision of [undefined, "", "a".repeat(64)]) assert.equal((await h.lib.operate(ctx, "sync", { expectedStateRevision: revision })).ok, false);
  assert.equal(h.calls.length, 0);
  const revision = h.lib.snapshot(ctx).revision; await h.op(ctx, "sync");
  assert.equal((await h.lib.operate(ctx, "sync", { expectedStateRevision: revision })).code, "EXPRESSION_CONFLICT");
});
await test("latest transaction builder repeats CAS rather than trusting preflight", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.before(() => { annotation(h, ctx).note = "changed externally"; });
  const result = await h.op(ctx, "review-sticker", { id: "s1", expectedRevision: annotation(h, ctx).revision, status: "rejected" });
  assert.equal(result.code, "EXPRESSION_CONFLICT"); assert.equal(annotation(h, ctx).status, "confirmed");
});
await test("sync commit CAS rejects library changes during protocol await", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.before(() => { annotation(h, ctx).note = "different"; });
  assert.equal((await h.op(ctx, "sync")).code, "EXPRESSION_CONFLICT"); assert.equal(annotation(h, ctx).note, "different");
});
await test("policy gates sync/vision while disabled historical previews remain readable", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  h.policy({ enabled: false, conversationIds: ["group:1"], stickers: { enabled: false } }); h.revision("host:2"); const disabled = h.ctx();
  assert.equal(h.lib.snapshot(disabled).stickers.length, 1);
  assert.equal((await h.op(disabled, "sync")).code, "EXPRESSION_DISABLED");
  assert.deepEqual(h.lib.candidates(disabled, { query: "开心" }), []);
  const v = harness({ stickers: { enabled: true, visionLearning: false } }), c = v.ctx(); await v.op(c, "sync");
  assert.equal((await v.op(c, "annotate", { id: "s1" })).code, "EXPRESSION_DISABLED"); assert.equal(v.models.length, 0);
});
await test("download precedes durable budget reservation/model dispatch", async () => {
  const h = harness(), ctx = h.ctx(); await h.op(ctx, "sync");
  h.down(async () => { assert.deepEqual(allClaims(h), []); assert.equal(h.models.length, 0); });
  const revision = h.lib.snapshot(ctx).revision;
  h.vision(async () => {
    assert.equal(allClaims(h)[0].status, "reserved");
    const s = h.lib.snapshot(ctx); assert.equal(s.revision, revision);
    assert.deepEqual(s.dailyVisionCalls, { reserved: 1, attempted: 0, limit: 2 });
  });
  assert.equal((await h.op(ctx, "annotate", { id: "s1" })).ok, true); assert.equal(allClaims(h)[0].status, "attempted");
  assert.deepEqual(h.lib.snapshot(ctx).dailyVisionCalls, { reserved: 0, attempted: 1, limit: 2 });
});
await test("failed downloads do not charge model attempts", async () => {
  const h = harness(), ctx = h.ctx(); await h.op(ctx, "sync"); h.down(async () => { throw new Error("SECRET url"); });
  const result = await h.op(ctx, "annotate", { id: "s1" }); assert.equal(result.ok, false);
  assert.deepEqual(allClaims(h), []); assert.equal(h.models.length, 0); assert.ok(!JSON.stringify(result).includes("SECRET"));
});
await test("failed actual models consume budget without refunds", async () => {
  const h = harness(), ctx = h.ctx(); await h.op(ctx, "sync"); h.vision(async () => { throw new Error("SECRET vision"); });
  for (let i = 0; i < 2; i++) assert.equal((await h.op(ctx, "annotate", { id: "s1" })).ok, false);
  assert.equal((await h.op(ctx, "annotate", { id: "s1" })).code, "EXPRESSION_BUDGET");
  assert.equal(h.models.length, 2); assert.ok(allClaims(h).every(c => c.status === "attempted"));
});
await test("vision budget is logical-bot-wide across groups, not cross-bot", async () => {
  const h = harness(), a = h.ctx(), g = h.ctx("alpha", "group:2"), b = h.ctx("beta");
  await h.op(a, "sync"); await h.op(a, "annotate", { id: "s1" }); await h.op(g, "annotate", { id: "s1" });
  assert.equal((await h.op(a, "annotate", { id: "s1" })).code, "EXPRESSION_BUDGET");
  await h.op(b, "sync"); assert.equal((await h.op(b, "annotate", { id: "s1" })).ok, true);
});
await test("Shanghai midnight starts next daily budget", async () => {
  const h = harness(), ctx = h.ctx(); h.time(Date.parse("2026-10-24T23:59:59+08:00")); await h.op(ctx, "sync");
  await h.op(ctx, "annotate", { id: "s1" }); await h.op(ctx, "annotate", { id: "s1" });
  h.time(Date.parse("2026-10-25T00:00:00+08:00")); assert.equal((await h.op(ctx, "annotate", { id: "s1" })).ok, true);
  assert.deepEqual(Object.keys(h.root().memory.socialExpressionLibrary.bots[ctx.logicalId].days), ["2026-10-24", "2026-10-25"]);
});
await test("daily claim bookkeeping retains seven Shanghai dates and never prunes on rollback", async () => {
  const h = harness(), ctx = h.ctx(); await h.op(ctx, "sync");
  for (let i = 0; i < 9; i++) {
    h.time(START + i * 86400000); assert.equal((await h.op(ctx, "annotate", { id: "s1" })).ok, true);
  }
  const book = h.root().memory.socialExpressionLibrary.bots[ctx.logicalId];
  assert.equal(Object.keys(book.days).length, 7); assert.equal(book.days['2026-10-24'], undefined); assert.equal(book.days['2026-10-25'], undefined);
  const before = structuredClone(h.root()); h.time(START + 7 * 86400000);
  assert.equal((await h.op(ctx, "annotate", { id: "s1" })).code, "EXPRESSION_BUDGET"); assert.deepEqual(h.root(), before);
});
await test("same logical account annotate is singleflight across groups", async () => {
  const h = harness(), ctx = h.ctx(), g = h.ctx("alpha", "group:2"); await h.op(ctx, "sync");
  let release, started; const barrier = new Promise(resolve => { started = resolve; });
  h.down(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.op(ctx, "annotate", { id: "s1" }); await barrier;
  assert.equal((await h.op(g, "annotate", { id: "s1" })).code, "EXPRESSION_BUSY"); release();
  assert.equal((await pending).ok, true); assert.equal(h.models.length, 1);
});
await test("abort/stale after claim cancels reservation without a fake model charge", async () => {
  const h = harness(), ctx = h.ctx(); await h.op(ctx, "sync"); h.after(() => h.current(false));
  assert.equal((await h.op(ctx, "annotate", { id: "s1" })).ok, false);
  assert.equal(h.models.length, 0); assert.equal(allClaims(h)[0].status, "cancelled");
});
await test("annotation CAS detects external changes during download or model", async () => {
  for (const boundary of ["down", "vision"]) {
    const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
    h[boundary](async () => { annotation(h, ctx).note = "external edit"; });
    assert.equal((await h.op(ctx, "annotate", { id: "s1" })).code, "EXPRESSION_CONFLICT");
    assert.equal(annotation(h, ctx).note, "external edit");
  }
});
await test("unsupported collection capability is stable and safe", async () => {
  const h = harness(), ctx = h.ctx(); h.protocol({ status: "failed", retcode: 1404 });
  assert.equal((await h.op(ctx, "sync")).ok, true); assert.equal(h.lib.snapshot(ctx).capabilities.collection, "unsupported");
});
await test("review-language uses fixed authorized scoped local-admin with CAS", async () => {
  const h = harness(), ctx = h.ctx(); observeGroupLanguage(h.root().memory, { ...ctx,
    message: { messageId: "definition", userId: "123456789", text: "贴贴在本群的意思是一起摸鱼", sentAt: START, receivedAt: START } });
  const c = h.lib.snapshot(ctx).language.candidates[0]; h.time(START + 1000);
  assert.equal((await h.op(ctx, "review-language", { id: c.id, expectedRevision: c.revision, status: "confirmed" })).ok, true);
  const reviewed = listGroupLanguage(h.root().memory, ctx).candidates[0]; assert.equal(reviewed.reviews[0].actorId, "local-admin");
  assert.equal((await h.op(ctx, "review-language", { id: c.id, expectedRevision: c.revision, status: "revoked" })).code, "EXPRESSION_CONFLICT");
});
await test("serious/unrelated/empty query never displays the whole library", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  assert.deepEqual(h.lib.candidates(ctx), []); assert.deepEqual(h.lib.candidates(ctx, { query: "完全不相关" }), []);
  assert.deepEqual(h.lib.candidates(ctx, { query: "开心", serious: true }), []);
  assert.equal(h.lib.candidates(ctx, { query: "今天很开心" })[0].id, "s1");
});
await test("prepare is offered-ID-only and annotation stays group/bot isolated", async () => {
  const h = harness(), ctx = h.ctx(), b = h.ctx("beta"), g = h.ctx("alpha", "group:2"); await confirmed(h, ctx);
  assert.equal((await h.lib.prepare(ctx, { id: "s1" })).segment, null);
  h.lib.candidates(ctx, { query: "开心" }); assert.ok((await h.lib.prepare(ctx, { id: "s1" })).segment);
  for (const other of [b, g]) { assert.deepEqual(h.lib.candidates(other, { query: "开心" }), []); assert.equal((await h.lib.prepare(other, { id: "s1" })).segment, null); }
  assert.equal((await h.lib.prepare(ctx, { id: "https://cdn.qq.com/a.png" })).segment, null);
});
await test("stale/quiet host context blocks all fresh actions", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" }); h.current(false);
  assert.deepEqual(h.lib.candidates(ctx, { query: "开心" }), []); assert.equal((await h.lib.prepare(ctx, { id: "s1" })).segment, null);
  assert.equal((await h.op(ctx, "sync")).code, "EXPRESSION_STALE");
});
await test("abort during download consumes no model budget; abort during model does", async () => {
  for (const boundary of ["down", "vision"]) {
    const h = harness(), ctx = h.ctx(), controller = new AbortController(); await h.op(ctx, "sync");
    h[boundary](async () => controller.abort());
    assert.equal((await h.lib.operate(ctx, "annotate", { id: "s1", expectedStateRevision: h.lib.snapshot(ctx).revision },
      { signal: controller.signal })).ok, false);
    assert.equal(h.models.length, boundary === "vision" ? 1 : 0);
    assert.equal(allClaims(h).filter(c => c.status === "attempted").length, boundary === "vision" ? 1 : 0);
    assert.equal(h.lib.snapshot(ctx).stickers[0].annotation, null);
  }
});
await test("changed serious offer during prepare prevents late prepared authority", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" });
  h.down(async () => { assert.deepEqual(h.lib.candidates(ctx, { query: "开心", serious: true }), []); });
  assert.equal((await h.lib.prepare(ctx, { id: "s1" })).segment, null);
  assert.equal((await h.lib.markSent(ctx, { id: "s1", messageId: "300" })).ok, false);
});
await test("candidate offers are capped at three even with a larger approved library", async () => {
  const h = harness({ stickers: { enabled: true, autoSend: true, visionLearning: true, maxDailyVisionCalls: 8 } }), ctx = h.ctx();
  h.protocol({ status: "ok", retcode: 0, data: ["s1", "s2", "s3", "s4"].map(emoji_id => ({ emoji_id, url: "https://cdn.qq.com/a.png" })) });
  await h.op(ctx, "sync");
  for (const id of ["s1", "s2", "s3", "s4"]) {
    const r = await h.op(ctx, "annotate", { id }); assert.equal(r.ok, true);
    assert.equal((await h.op(ctx, "review-sticker", { id, expectedRevision: r.result.revision, status: "confirmed" })).ok, true);
  }
  const rows = h.lib.candidates(ctx, { query: "开心" }); assert.equal(rows.length, 3);
  assert.ok(!JSON.stringify(rows).includes("https://")); assert.equal((await h.lib.prepare(ctx, { id: "s4" })).segment, null);
});
await test("unprepared, fake and HTTP receipt paths are refused", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx);
  assert.equal((await h.lib.markSent(ctx, { id: "s1", messageId: "100" })).code, "EXPRESSION_ACK");
  assert.equal((await h.lib.markSent({ ...ctx }, { id: "s1", messageId: "100" })).code, "EXPRESSION_CONTEXT");
  assert.equal((await h.op(ctx, "markSent", { id: "s1", messageId: "100" })).ok, false);
});
await test("real ACK survives revoked approval plus stale old ctx without granting sends", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" });
  assert.ok((await h.lib.prepare(ctx, { id: "s1" })).segment);
  await h.op(ctx, "review-sticker", { id: "s1", expectedRevision: annotation(h, ctx).revision, status: "rejected" });
  h.current(false);
  assert.deepEqual(await h.lib.markSent(ctx, { id: "s1", messageId: "201" }), { ok: true, counted: true });
  assert.equal(annotation(h, ctx).status, "rejected"); assert.equal(annotation(h, ctx).sentCount, 1);
  assert.equal((await h.lib.prepare(ctx, { id: "s1" })).segment, null);
});
await test("ACK write is cached, uncertain storage is never retried", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" }); await h.lib.prepare(ctx, { id: "s1" });
  h.fail(true); const first = await h.lib.markSent(ctx, { id: "s1", messageId: "202" }); assert.equal(first.ok, false);
  h.fail(false); assert.deepEqual(await h.lib.markSent(ctx, { id: "s1", messageId: "202" }), first);
  assert.equal(annotation(h, ctx).sentCount, 0);
});
await test("duplicate real ACK is idempotent including the counted result", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" }); await h.lib.prepare(ctx, { id: "s1" });
  const args = { id: "s1", messageId: "204" };
  assert.deepEqual(await h.lib.markSent(ctx, args), { ok: true, counted: true });
  assert.deepEqual(await h.lib.markSent(ctx, args), { ok: true, counted: false }); assert.equal(annotation(h, ctx).sentCount, 1);
});
await test("damaged own library/language fail closed; foreign bot remains independent", async () => {
  const h = harness(), a = h.ctx(), b = h.ctx("beta"); await confirmed(h, b);
  h.root().memory.socialExpressionAssets.bots[a.logicalId] = { stickers: null, capabilities: {} };
  assert.equal(h.lib.snapshot(a).code, "EXPRESSION_STATE"); assert.equal(h.lib.snapshot(b).ok, true);
  assert.equal((await h.op(b, "sync")).ok, true);
  h.root().memory.socialExpressionLanguage = { version: 1, bots: { [b.logicalId]: { conversations: { "group:1": null } } } };
  const before = structuredClone(h.root()); assert.equal(h.lib.snapshot(b).code, "EXPRESSION_STATE"); assert.deepEqual(h.root(), before);
});
await test("context field/session revision mutation cannot grant fresh sends", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" });
  h.revision("new-session"); assert.equal((await h.lib.prepare(ctx, { id: "s1" })).segment, null);
  const current = h.ctx(); assert.equal(h.lib.snapshot(current).ok, true); assert.equal(h.lib.candidates(current, { query: "开心" }).length, 1);
});
await test("ACK cooldown prevents repeated selection until exact boundary", async () => {
  const h = harness(), ctx = h.ctx(); await confirmed(h, ctx); h.lib.candidates(ctx, { query: "开心" }); await h.lib.prepare(ctx, { id: "s1" });
  assert.equal((await h.lib.markSent(ctx, { id: "s1", messageId: "203" })).ok, true);
  assert.deepEqual(h.lib.candidates(ctx, { query: "开心" }), []); h.time(START + 60000);
  assert.equal(h.lib.candidates(ctx, { query: "开心" }).length, 1);
});
await test("all outward failures are fixed codes, never dependency evidence", async () => {
  const h = harness(), ctx = h.ctx(); h.online(false); const result = await h.op(ctx, "sync");
  assert.equal(result.ok, false); assert.match(result.code, /^EXPRESSION_[A-Z_]+$/); assert.ok(!JSON.stringify(result).includes("SECRET"));
});

console.log(`PASS social-expression-library: ${checks} synthetic checks; no network/model/QQ`);
