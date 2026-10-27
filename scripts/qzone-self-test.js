// Synthetic only: no QQ, network, filesystem state or model adapters.
import assert from "node:assert/strict";
import { QZONE_READ_ACTIONS, QZONE_WRITE_ACTIONS, isQzoneAction,
  normalizeQzonePolicy, validateQzonePolicy } from "../src/qzone-policy.js";
import { createQzoneRuntime, recoverQzoneState } from "../src/qzone-runtime.js";

let checks = 0;
async function test(name, run) {
  try { await run(); checks++; }
  catch (e) { e.message = `${name}: ${e.message}`; throw e; }
}
const admin = Object.freeze({ source: "admin", userId: "local-admin" });
const clone = structuredClone;
const defaults = normalizeQzonePolicy();
const enabled = patch => normalizeQzonePolicy({ ...defaults, enabled: true, mode: "reviewed",
  reads: { ...defaults.reads, feeds: true, own: true, cooldownMs: 0 },
  publish: { enabled: true, maxDaily: 20, cooldownMs: 0 },
  likes: { enabled: true, maxDaily: 20, cooldownMs: 0 },
  comments: { enabled: true, maxDaily: 20, cooldownMs: 0 }, ...patch });
function host({ policy = enabled(), logicalFor = id => `logical:${id}`, qqFor = id => id === "a" ? "10001" : "10002" } = {}) {
  let memory = {}, at = Date.UTC(2026, 9, 27), current = true, revision = 1, administrators = true;
  let tail = Promise.resolve(), commits = 0, before, after, wire, beforeWire, skipHook = false;
  let peerIds = [], own = [], feeds, readEnvelope, restored;
  const calls = [], requests = [], episodes = [], sourceProofs = new WeakSet();
  const nextFeed = (patch = {}) => ({ uin: 20002, tid: "tid_friend", time: Math.floor(at / 1000),
    content: "一条普通动态", content_complete: true, ...patch });
  feeds = [nextFeed()];
  const deps = {
    capture: accountId => ({ accountId, logicalId: logicalFor(accountId), qq: qqFor(accountId), revision,
      policy: clone(policy), protocolVersion: "synthetic-v1" }),
    isCurrent: ctx => current && ctx.revision === revision,
    readState: () => ({ memory }), clock: () => at,
    isAdministrator: (_ctx, actor) => administrators && actor === admin,
    isSourceAllowed: (_ctx, source) => sourceProofs.has(source),
    peerQqs: () => peerIds,
    onEpisode: episode => episodes.push(episode),
    transact: builder => {
      const task = tail.then(async () => {
        const number = ++commits;
        await before?.(number);
        const draft = clone(memory), result = builder({ memory: draft });
        assert.equal(Boolean(result?.then), false, "sole-writer builder is synchronous");
        memory = draft;
        await after?.(number);
        return result;
      });
      tail = task.catch(() => {});
      return task;
    },
    request: async (ctx, action, params, options) => {
      requests.push({ action, params: clone(params) });
      await beforeWire?.(ctx, action, params, options);
      if (!skipHook) {
        assert.equal(options.binding.isCurrent(), true);
        options.binding.onSendStarted();
        calls.push({ ctx, action, params: clone(params), memory: clone(memory) });
      }
      if (wire) return wire(ctx, action, params, options);
      if (action === "get_qzone_feeds") return readEnvelope ?? { status: "ok", retcode: 0, data: { feeds: clone(feeds), has_more: false } };
      if (action === "get_qzone_msg_list") return readEnvelope ?? { status: "ok", retcode: 0, data: { msglist: clone(own), total: own.length } };
      return { status: "ok", retcode: 0, data: { tid: "tid_sent", time: Math.floor(at / 1000) } };
    }
  };
  let runtime = createQzoneRuntime(deps), ctx = runtime.open("a");
  return {
    get runtime() { return runtime; }, get ctx() { return ctx; }, get memory() { return memory; },
    get at() { return at; }, get commits() { return commits; }, deps, calls, requests, episodes, nextFeed,
    next: input => { feeds = input || [nextFeed()]; }, own: input => { own = input; },
    envelope: input => { readEnvelope = input; },
    before: fn => { before = fn; }, after: fn => { after = fn; }, wire: fn => { wire = fn; },
    beforeWire: fn => { beforeWire = fn; }, skipHook: v => { skipHook = v; },
    tick: ms => { at += ms; }, stop: () => { current = false; }, resume: () => { current = true; },
    revoke: () => { administrators = false; }, bump: () => { revision++; },
    peers: value => { peerIds = value; }, grant: source => { sourceProofs.add(source); },
    ungrant: source => { sourceProofs.delete(source); },
    replaceMemory: value => { memory = value; }, policy: value => { policy = value; },
    restart: () => { runtime = createQzoneRuntime(deps); ctx = runtime.open("a"); },
    restore: reason => {
      restored = recoverQzoneState(memory, { reason, now: at }); memory = restored.memory; return restored;
    }
  };
}
const bot = (h, logical = "logical:a", qq = "10001") => h.memory.qzoneSocial?.bots[logical]?.owners[qq];
const create = (h, content = "今日读书心得", extra = {}, actor = admin) => h.runtime.createDraft(h.ctx,
  { content, source: { kind: "admin_topic", ref: "topic:books" }, ...extra }, actor);
async function approve(h, row) {
  const review = await h.runtime.submitReview(h.ctx, row.id, row.revision, admin);
  return h.runtime.approve(h.ctx, review.id, review.revision, admin);
}
const ready = async (h, content, extra) => approve(h, await create(h, content, extra));
const publish = (h, row, options = {}) => h.runtime.publish(h.ctx, row.id, row.revision, { actor: admin, ...options });
const feedId = async h => (await h.runtime.readFeeds(h.ctx)).feeds[0].id;
const comment = async h => h.runtime.proposeInteraction(h.ctx, { kind: "comment", feedId: await feedId(h), content: "谢谢分享" }, admin);
const like = async h => h.runtime.proposeInteraction(h.ctx, { kind: "like", feedId: await feedId(h) }, admin);
const rejects = (run, code) => assert.rejects(run, code ? new RegExp(code) : undefined);

await test("safe defaults are strict and detached", () => {
  assert.equal(defaults.enabled, false); assert.equal(defaults.mode, "draft_only"); assert.equal(defaults.ugcRight, 64);
  assert.equal(defaults.reads.feeds, false); assert.equal(defaults.reads.own, false);
  for (const key of ["publish", "likes", "comments"]) assert.equal(defaults[key].enabled, false);
  const p = normalizeQzonePolicy(); p.allowedAudiences.push(1); assert.deepEqual(normalizeQzonePolicy().allowedAudiences, [64]);
});
await test("unknown policy fields and unsafe numbers never permissively normalize", () => {
  for (const p of [null, [], true, { enabled: 1 }, { mode: "auto" }, { public: true },
    { reads: { maxDaily: 21 } }, { reads: { count: 51 } }, { reads: { ttlMs: 86400001 } },
    { reads: { count: NaN } }, { reads: { page_num: 100 } }, { publish: { maxDaily: -1 } },
    { publish: { enabled: "true" } }, { likes: { cooldownMs: Infinity } }, { autonomy: { enabled: 1 } },
    { allowedAudiences: [64, 64] }, { allowedAudiences: [16] }, { ugcRight: 1 },
    { reads: { freshnessMs: 9000, ttlMs: 1000 } }]) assert.throws(() => normalizeQzonePolicy(p));
});
await test("autonomy source configuration must be exact bounded safe material", () => {
  for (const source of [{ kind: "private_qzone", ref: "x", content: "x" },
    { kind: "public_information", ref: "https://unsafe", content: "x" },
    { kind: "admin_topic", ref: "x", content: "token=forbidden" },
    { kind: "admin_topic", ref: "x", content: "x", arbitrary: 1 }])
    assert.throws(() => validateQzonePolicy({ autonomy: { sources: [source] } }));
});
await test("all official writes and unknown QZone action spellings stay protected", () => {
  for (const a of ["like_qzone", "comment_qzone", "delete_qzone_msg", "set_qzone_msg_right", "send_qzone_msg"])
    assert.ok(QZONE_WRITE_ACTIONS.includes(a));
  for (const a of [...QZONE_READ_ACTIONS, ...QZONE_WRITE_ACTIONS, "new_qzone_action", "QZoneWrite"]) assert.equal(isQzoneAction(a), true);
  assert.equal(isQzoneAction("get_status"), false); assert.equal(isQzoneAction({}), false);
});
await test("missing host dependencies and malformed captures fail closed", () => {
  assert.throws(() => createQzoneRuntime({}));
  const h = host();
  for (const change of [{ qq: "9007199254740993" }, { accountId: "other" }, { logicalId: "__proto__" },
    { revision: undefined }, { protocolVersion: "" }, { policy: { enable: true } }]) {
    const svc = createQzoneRuntime({ ...h.deps, capture: id => ({ ...h.deps.capture(id), ...change }) });
    assert.throws(() => svc.open("a"));
  }
});
await test("status is read-only, detached, no persistent defaults", () => {
  const h = host(), status = h.runtime.status(h.ctx);
  assert.deepEqual(h.memory, {}); assert.equal(h.commits, 0);
  for (const a of [...QZONE_READ_ACTIONS, ...QZONE_WRITE_ACTIONS]) assert.equal(status.capabilities[a], "unknown");
  status.capabilities.send_qzone_msg = "supported";
  assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unknown");
  assert.equal(status.images.supported, false); assert.equal(status.destructive.supported, false);
});
await test("offline open/status may inspect scope but cannot read or mutate", async () => {
  const h = host(); const d = await create(h); h.stop();
  const ctx = h.runtime.open("a"), status = h.runtime.status(ctx);
  assert.equal(status.current, false); assert.equal(status.drafts[0].id, d.id);
  await rejects(() => h.runtime.readOwn(ctx), "STALE");
  await rejects(() => h.runtime.createDraft(ctx, { content: "offline", source: { kind: "admin_topic", ref: "x" } }, admin));
});
await test("contexts are opaque runtime-bound weakmap authority", async () => {
  const h = host(), other = createQzoneRuntime(h.deps);
  assert.throws(() => h.runtime.status({ ...h.ctx }), /CONTEXT/);
  assert.throws(() => other.status(h.ctx), /CONTEXT/);
  await rejects(() => h.runtime.readFeeds(null), "CONTEXT");
  assert.throws(() => { h.ctx.qq = "10002"; });
});
await test("default disabled forbids reads, drafts and writes", async () => {
  const h = host({ policy: defaults });
  await rejects(() => h.runtime.readFeeds(h.ctx), "DISABLED"); await rejects(() => create(h), "DISABLED");
  assert.equal(h.calls.length, 0); assert.equal(h.commits, 0);
});
await test("read toggles are independent and unknown options rejected", async () => {
  const h = host({ policy: enabled({ reads: { ...defaults.reads, feeds: false, own: true } }) });
  await rejects(() => h.runtime.readFeeds(h.ctx), "READ_DISABLED"); await h.runtime.readOwn(h.ctx);
  await rejects(() => h.runtime.readOwn(h.ctx, { target_uin: 20002 }), "INPUT");
  await rejects(() => h.runtime.readFeeds(h.ctx, { page_num: 20 }), "INPUT");
});
await test("official reads use bounded exact host self and first-page schema", async () => {
  const h = host(); await h.runtime.readFeeds(h.ctx); await h.runtime.readOwn(h.ctx);
  assert.deepEqual(h.calls[0].params, { count: 20, page_num: 1 });
  assert.deepEqual(h.calls[1].params, { target_uin: 10001, pos: 0, num: 20 });
  assert.equal(h.runtime.status(h.ctx).capabilities.get_qzone_feeds, "supported");
  assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unknown");
});
await test("private feed projection strips HTML/URLs/credentials and raw identifiers", async () => {
  const h = host(); h.next([h.nextFeed({ html: "<script>secret</script>", nickname: "private nickname",
    content: '<b>正文</b> https://signed.invalid/x?token=secret password=hush 13812345678' })]);
  const data = await h.runtime.readFeeds(h.ctx), s = JSON.stringify(data);
  for (const raw of ["https://", "secret", "hush", "13812345678", "tid_friend", "20002", "nickname", "<b>"]) assert.ok(!s.includes(raw));
  assert.equal(data.source, "private_qzone"); assert.equal(data.feeds[0].projectable, false);
  assert.deepEqual(h.episodes, []); assert.ok(!JSON.stringify(h.memory).includes("正文"));
});
await test("no HTML fallback when plain content absent", async () => {
  const h = host(); h.next([h.nextFeed({ content: null, html: "<p>not input</p>", content_complete: false })]);
  const row = (await h.runtime.readFeeds(h.ctx)).feeds[0]; assert.equal(row.content, ""); assert.equal(row.complete, false);
});
await test("public read APIs never expose internal tid/proof records", async () => {
  const h = host(); h.own([{ tid: "private_tid", content: "私密正文", time: h.at / 1000, is_private: true }]);
  const rows = await h.runtime.readOwn(h.ctx);
  assert.equal(rows.internal, undefined); assert.equal(rows.feeds[0].tid, undefined);
  assert.equal(rows.feeds[0].source, "private_qzone");
});
await test("host-issued cursor passes raw transport only to exact adapter", async () => {
  const h = host(); h.envelope({ status: "ok", retcode: 0, data: { feeds: [], has_more: true, next_cursor: "signed opaque cursor" } });
  const page = await h.runtime.readFeeds(h.ctx); assert.notEqual(page.cursor, "signed opaque cursor");
  await h.runtime.readFeeds(h.ctx, { cursor: page.cursor });
  assert.deepEqual(h.calls[1].params, { count: 20, cursor: "signed opaque cursor" });
  assert.ok(!JSON.stringify(h.memory).includes("signed opaque cursor"));
});
await test("raw, cross-context, consumed and expired cursors are refused", async () => {
  const h = host(); h.envelope({ status: "ok", retcode: 0, data: { feeds: [], has_more: true, next_cursor: "server cursor" } });
  await rejects(() => h.runtime.readFeeds(h.ctx, { cursor: "server cursor" }), "CURSOR");
  const page = await h.runtime.readFeeds(h.ctx), other = h.runtime.open("a");
  await rejects(() => h.runtime.readFeeds(other, { cursor: page.cursor }), "CURSOR");
  await h.runtime.readFeeds(h.ctx, { cursor: page.cursor });
  await rejects(() => h.runtime.readFeeds(h.ctx, { cursor: page.cursor }), "CURSOR");
  const next = await h.runtime.readFeeds(h.ctx); h.tick(defaults.reads.ttlMs + 1);
  await rejects(() => h.runtime.readFeeds(h.ctx, { cursor: next.cursor }), "CURSOR");
});
await test("max20 reads/day are durably counted across restart", async () => {
  const h = host(); for (let i = 0; i < 20; i++) await h.runtime.readOwn(h.ctx);
  h.restart(); await rejects(() => h.runtime.readOwn(h.ctx), "BUDGET");
  assert.equal(h.calls.length, 20); h.tick(86400000); await h.runtime.readOwn(h.ctx);
  assert.equal(h.runtime.status(h.ctx).daily.reads, 1);
});
await test("reads consume durable budget before actual wire", async () => {
  const h = host(); await h.runtime.readOwn(h.ctx);
  assert.equal(h.calls[0].memory.qzoneSocial.bots["logical:a"].owners["10001"].days["2026-10-27"].reads, 1);
});
await test("read cooldown and backwards clock fail closed", async () => {
  const h = host({ policy: enabled({ reads: { ...defaults.reads, own: true, cooldownMs: 1000 } }) });
  await h.runtime.readOwn(h.ctx); await rejects(() => h.runtime.readOwn(h.ctx), "COOLDOWN");
  h.tick(-100); await rejects(() => h.runtime.readOwn(h.ctx), "COOLDOWN");
  h.tick(1100); await h.runtime.readOwn(h.ctx);
});
await test("malformed and unwrapped read envelopes never prove support", async () => {
  for (const raw of [{ feeds: [] }, { status: "ok", retcode: "0", data: { feeds: [] } },
    { status: "ok", retcode: 0 }, { status: "ok", retcode: 0, data: { feeds: {} } },
    { status: "ok", retcode: 0, data: { feeds: Array(51).fill({}) } }]) {
    const h = host(); h.envelope(raw); await rejects(() => h.runtime.readFeeds(h.ctx), "ENVELOPE");
    assert.notEqual(h.runtime.status(h.ctx).capabilities.get_qzone_feeds, "supported");
  }
});
await test("read rejection distinguishes unsupported from temporary availability", async () => {
  for (const [retcode, state] of [[404, "unsupported"], [1404, "unsupported"], [503, "temporarily_unavailable"]]) {
    const h = host(); h.envelope({ status: "failed", retcode, data: null });
    await rejects(() => h.runtime.readFeeds(h.ctx)); assert.equal(h.runtime.status(h.ctx).capabilities.get_qzone_feeds, state);
    assert.equal(h.runtime.status(h.ctx).capabilities.like_qzone, "unknown");
  }
});
await test("read abort or quiet after durable claim never reaches request", async () => {
  for (const action of [h => h.stop(), h => h.bump()]) {
    const h = host(); h.after(n => { if (n === 1) action(h); });
    await rejects(() => h.runtime.readFeeds(h.ctx)); assert.equal(h.calls.length, 0);
  }
  const h = host(), controller = new AbortController(); h.after(() => controller.abort());
  await rejects(() => h.runtime.readFeeds(h.ctx, { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
await test("read late completion after revocation creates no feed handles", async () => {
  const h = host(); h.wire(() => { h.stop(); return { status: "ok", retcode: 0, data: { feeds: [h.nextFeed()] } }; });
  await rejects(() => h.runtime.readFeeds(h.ctx)); assert.deepEqual(h.runtime.status(h.ctx).drafts, []);
});
await test("read adapter must honor actual-wire hook", async () => {
  const h = host(); h.skipHook(true); await rejects(() => h.runtime.readFeeds(h.ctx), "ENVELOPE");
  assert.equal(h.runtime.status(h.ctx).capabilities.get_qzone_feeds, "temporarily_unavailable");
});
await test("actor fields are not authority; only original verified object is", async () => {
  const h = host(); await rejects(() => create(h, "伪造管理员", {}, { ...admin }), "ACTOR");
  await rejects(() => create(h, "没有管理员", {}, null), "ACTOR");
  const row = await create(h); await rejects(() => h.runtime.submitReview(h.ctx, row.id, row.revision, { ...admin }), "ACTOR");
});
await test("admin source requires authenticated actor; private/group sources refused", async () => {
  const h = host();
  for (const kind of ["private_qzone", "group", "private", "model"]) await rejects(() => create(h, "不应该接纳", { source: { kind, ref: "x" } }));
  await rejects(() => create(h, "正文", { source: { kind: "admin_topic", ref: "https://bad" } }));
  assert.equal(h.commits, 0);
});
await test("host-public inspiration creates draft only with exact source proof", async () => {
  const h = host(), source = Object.freeze({ kind: "public_information", ref: "public:one" });
  await rejects(() => create(h, "公开发现", { source }, null), "SOURCE_PROOF");
  h.grant(source); const row = await create(h, "公开发现", { source }, null);
  assert.equal(row.status, "draft"); assert.deepEqual(row.source, source); assert.equal(h.calls.length, 0);
  await rejects(() => h.runtime.submitReview(h.ctx, row.id, row.revision, null), "ACTOR");
  await rejects(() => create(h, "另一个公开发现", { source: { ...source } }, null), "SOURCE_PROOF");
});
await test("public source callback is false by default", async () => {
  const h = host(), svc = createQzoneRuntime({ ...h.deps, isSourceAllowed: undefined }), ctx = svc.open("a");
  await rejects(() => svc.createDraft(ctx, { content: "公开发现", source: { kind: "public_information", ref: "p" } }, admin), "SOURCE_PROOF");
});
await test("source proof revoked inside transaction blocks draft", async () => {
  const h = host(), source = { kind: "public_information", ref: "p" }; h.grant(source);
  h.before(() => h.ungrant(source)); await rejects(() => create(h, "公开发现", { source }, null), "SOURCE_PROOF");
  assert.deepEqual(h.memory, {});
});
await test("unsafe content, images, paths and unknown fields never persist", async () => {
  const h = host();
  for (const content of ["", "x".repeat(1001), "<script>x</script>", "password=secret", "https://signed.invalid/x", "13812345678", "/Users/test/private", "abc\u202edef"])
    await rejects(() => create(h, content), "CONTENT");
  for (const images of [["file:///secret"], ["https://url"], ["asset:approved"], {}]) await rejects(() => create(h, "正文", { images }), "IMAGE");
  await rejects(() => create(h, "正文", { tid: "raw" }), "INPUT"); assert.deepEqual(h.memory, {});
});
await test("empty images are omitted; default audience explicit64", async () => {
  const h = host(), row = await ready(h, "纯文字", { images: [] }); await publish(h, row);
  assert.deepEqual(h.calls[0].params, { content: "纯文字", ugc_right: 64 });
});
await test("audience cannot inherit public protocol defaults", async () => {
  const h = host(); for (const audience of [1, 4, 16, 128, "64", null]) {
    await rejects(() => create(h, "受众测试", { audience }), "AUDIENCE");
  }
  assert.equal(h.calls.length, 0);
});
await test("draft_only mode can review but never publish", async () => {
  const h = host({ policy: enabled({ mode: "draft_only" }) }), row = await ready(h);
  await rejects(() => publish(h, row), "WRITE_DISABLED"); assert.equal(h.calls.length, 0);
});
await test("review/approval state machine and exact CAS revisions", async () => {
  const h = host(), row = await create(h);
  await rejects(() => h.runtime.approve(h.ctx, row.id, row.revision, admin), "TRANSITION");
  const review = await h.runtime.submitReview(h.ctx, row.id, 1, admin); assert.equal(review.revision, 2);
  await rejects(() => h.runtime.approve(h.ctx, row.id, 1, admin), "REVISION");
  const approved = await h.runtime.approve(h.ctx, row.id, 2, admin); assert.equal(approved.revision, 3);
  await rejects(() => publish(h, { ...approved, revision: 2 }), "REVISION");
});
await test("approval cannot be won twice with stale CAS", async () => {
  const h = host(), d = await create(h), r = await h.runtime.submitReview(h.ctx, d.id, 1, admin);
  const results = await Promise.allSettled([h.runtime.approve(h.ctx, r.id, 2, admin), h.runtime.approve(h.ctx, r.id, 2, admin)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});
await test("unapproved draft and forged status fields are not write authority", async () => {
  const h = host(), row = await create(h); row.status = "approved";
  await rejects(() => publish(h, row), "APPROVAL"); assert.equal(h.calls.length, 0);
});
await test("explicit admin-approved verification sample may bootstrap unknown", async () => {
  const h = host(), row = await ready(h);
  assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unknown");
  const result = await publish(h, row); assert.equal(result.status, "publishing");
  assert.equal(result.protocolAccepted, true); assert.equal(result.clientVerified, false);
  assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "supported");
});
await test("write claim is durably published before exact wire", async () => {
  const h = host(), row = await ready(h); await publish(h, row);
  const b = h.calls[0].memory.qzoneSocial.bots["logical:a"].owners["10001"];
  assert.equal(b.drafts[row.id].status, "publishing"); assert.equal(Object.keys(b.claims).length, 1);
  assert.equal(b.days["2026-10-27"].publish, 1); assert.equal(h.calls.length, 1);
});
await test("same draft concurrent publishing has one durable claim and wire", async () => {
  const h = host(), row = await ready(h);
  const results = await Promise.allSettled([publish(h, row), publish(h, row), publish(h, row)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(h.calls.length, 1);
});
await test("same canonical content cannot be recreated under a new source/id", async () => {
  const h = host(), row = await ready(h, "a b"); await publish(h, row);
  await rejects(() => create(h, "ａ  b", { source: { kind: "admin_topic", ref: "different" } }), "DUPLICATE");
  h.restart(); await rejects(() => create(h, "a b"), "DUPLICATE"); assert.equal(h.calls.length, 1);
});
await test("claimed tombstones survive even when a draft record is removed", async () => {
  const h = host(), row = await ready(h); await publish(h, row);
  const m = clone(h.memory); delete m.qzoneSocial.bots["logical:a"].owners["10001"].drafts[row.id]; h.replaceMemory(m); h.restart();
  await rejects(() => create(h), "DUPLICATE");
});
await test("transaction failure before claim never invokes transport", async () => {
  const h = host(), row = await ready(h); h.before(() => { throw new Error("durability failure"); });
  await rejects(() => publish(h, row)); assert.equal(h.requests.length, 0);
});
await test("durable claim acknowledgement failure never sends or retries", async () => {
  const h = host(), row = await ready(h); h.after(() => { throw new Error("lost acknowledgement"); });
  await rejects(() => publish(h, row)); assert.equal(h.calls.length, 0);
  h.after(null); h.restart(); await rejects(() => publish(h, row)); assert.equal(h.calls.length, 0);
});
await test("settlement durability failure reports uncertain and blocks new writes", async () => {
  const h = host(), row = await ready(h), n = h.commits;
  h.before(count => { if (count === n + 2) throw new Error("disk unavailable"); });
  const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(result.reason, "QZONE_DURABILITY_UNCERTAIN");
  h.before(null); const next = await ready(h, "第二篇"); await rejects(() => publish(h, next), "DURABILITY");
  assert.equal(h.calls.length, 1);
});
await test("quiet and route revocation after durable claim stop all wire", async () => {
  for (const revoke of [h => h.stop(), h => h.bump(), h => h.revoke()]) {
    const h = host(), row = await ready(h), n = h.commits;
    h.after(count => { if (count === n + 1) revoke(h); });
    const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(h.calls.length, 0);
  }
});
await test("abort before claim spends nothing; abort after claim forbids retries", async () => {
  const h = host(), row = await ready(h), c = new AbortController(); c.abort();
  await rejects(() => publish(h, row, { signal: c.signal })); assert.equal(Object.keys(bot(h).claims).length, 0);
  const d = new AbortController(), n = h.commits; h.after(count => { if (count === n + 1) d.abort(); });
  const result = await publish(h, row, { signal: d.signal }); assert.equal(result.status, "uncertain");
  h.after(null); await rejects(() => publish(h, result)); assert.equal(h.calls.length, 0);
});
await test("actual-wire guard sees late quiet, policy revocation and abort", async () => {
  for (const revoke of [h => h.stop(), h => h.bump(), h => h.revoke()]) {
    const h = host(), row = await ready(h);
    h.beforeWire((_ctx, _a, _p, opts) => { revoke(h); assert.equal(opts.binding.isCurrent(), false); });
    const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(h.calls.length, 0);
  }
});
await test("binding current checks are pure but onSendStarted is one-shot", async () => {
  const h = host(), row = await ready(h);
  h.beforeWire((_ctx, _a, _p, opts) => {
    assert.equal(opts.binding.isCurrent(), true); assert.equal(opts.binding.isCurrent(), true);
  });
  h.wire((_ctx, _a, _p, opts) => {
    assert.equal(opts.binding.isCurrent(), false);
    assert.throws(() => opts.binding.onSendStarted(), /WIRE_REUSE/);
    return { status: "ok", retcode: 0, data: { tid: "tid_sent" } };
  });
  assert.equal((await publish(h, row)).protocolAccepted, true); assert.equal(h.calls.length, 1);
});
await test("adapter ACK without wire hook is uncertain, never write support", async () => {
  const h = host(), row = await ready(h); h.skipHook(true);
  const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(result.protocolAccepted, false);
  assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unknown");
});
await test("ACK0 is accepted not client verified, and no manufactured episode", async () => {
  const h = host(), row = await ready(h), result = await publish(h, row);
  assert.equal(result.protocolAccepted, true); assert.equal(result.clientVerified, false); assert.notEqual(result.status, "confirmed");
  assert.deepEqual(h.episodes, []); assert.equal(result.tid, undefined);
});
await test("malformed write ACKs remain uncertain, never known failed", async () => {
  for (const raw of [null, {}, { retcode: 0, data: {} }, { status: "ok", retcode: "0", data: {} },
    { status: "ok", retcode: 0 }, { status: "failed", retcode: 0, data: null }, { status: "failed", retcode: "503" }]) {
    const h = host(), row = await ready(h); h.wire(() => raw);
    const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(result.protocolAccepted, false);
  }
});
await test("explicit protocol rejection only is a known failure; never retry", async () => {
  const h = host(), row = await ready(h); h.wire(() => ({ status: "failed", retcode: 403, data: null }));
  const result = await publish(h, row); assert.equal(result.status, "failed");
  await rejects(() => publish(h, result)); await rejects(() => create(h), "DUPLICATE"); assert.equal(h.calls.length, 1);
});
await test("documented unsupported receipt blocks subsequent admin samples", async () => {
  const h = host(), row = await ready(h); h.wire(() => ({ status: "failed", retcode: 1404, data: null }));
  await publish(h, row); assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unsupported");
  const next = await ready(h, "另一份草稿"); await rejects(() => publish(h, next), "UNSUPPORTED"); assert.equal(h.calls.length, 1);
});
await test("timeout and post-wire abort are uncertain and never retried", async () => {
  for (const mode of ["throw", "abort"]) {
    const h = host(), row = await ready(h), c = new AbortController();
    h.wire(() => { if (mode === "abort") c.abort(); throw new Error("transport outcome unknown"); });
    const result = await publish(h, row, { signal: c.signal }); assert.equal(result.status, "uncertain");
    await rejects(() => publish(h, result)); h.restart(); await rejects(() => create(h), "DUPLICATE"); assert.equal(h.calls.length, 1);
  }
});
await test("late accepted ACK after route loss is factual but never extra send", async () => {
  const h = host(), row = await ready(h); h.wire(() => { h.stop(); return { status: "ok", retcode: 0, data: { tid: "tid_sent" } }; });
  const result = await publish(h, row); assert.equal(result.protocolAccepted, true); assert.equal(result.clientVerified, false);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.episodes, []);
});
await test("daily write budget is atomic across drafts", async () => {
  const h = host({ policy: enabled({ publish: { enabled: true, maxDaily: 1, cooldownMs: 0 } }) });
  const a = await ready(h, "第一篇"), b = await ready(h, "第二篇");
  await publish(h, a); await rejects(() => publish(h, b), "BUDGET"); assert.equal(h.calls.length, 1);
});
await test("write cooldown survives restart and no refund after rejection", async () => {
  const h = host({ policy: enabled({ publish: { enabled: true, maxDaily: 20, cooldownMs: 1000 } }) });
  const a = await ready(h, "第一篇"), b = await ready(h, "第二篇");
  h.wire(() => ({ status: "failed", retcode: 403, data: null })); await publish(h, a);
  await rejects(() => publish(h, b), "COOLDOWN"); h.tick(1000); await publish(h, b); assert.equal(h.calls.length, 2);
});
await test("separate own-read matches tid, content and explicit self visibility", async () => {
  const h = host(), row = await ready(h), sent = await publish(h, row);
  h.own([{ tid: "tid_sent", content: row.content, time: h.at / 1000, is_private: true }]);
  const result = await h.runtime.verifyPublish(h.ctx, row.id);
  assert.equal(sent.clientVerified, false); assert.equal(result.status, "confirmed"); assert.equal(result.clientVerified, true);
  assert.equal(h.calls[1].action, "get_qzone_msg_list"); assert.deepEqual(h.episodes, []);
});
await test("wrong tid/content or absent visibility never confirms", async () => {
  for (const patch of [{ tid: "different" }, { content: "不同正文" }, { is_private: false }, { is_private: undefined }]) {
    const h = host(), row = await ready(h); await publish(h, row);
    h.own([{ tid: "tid_sent", content: row.content, time: h.at / 1000, is_private: true, ...patch }]);
    const result = await h.runtime.verifyPublish(h.ctx, row.id); assert.equal(result.clientVerified, false); assert.notEqual(result.status, "confirmed");
  }
});
await test("non-private read cannot prove friends/public audience even content matches", async () => {
  for (const audience of [1, 4]) {
    const h = host({ policy: enabled({ allowedAudiences: [64, 1, 4] }) }), row = await ready(h, "非私密测试", { audience });
    await publish(h, row); h.own([{ tid: "tid_sent", content: row.content, time: h.at / 1000, is_private: false }]);
    assert.equal((await h.runtime.verifyPublish(h.ctx, row.id)).clientVerified, false);
  }
});
await test("ACK without tid cannot be verified by content alone", async () => {
  const h = host(), row = await ready(h); h.wire(() => ({ status: "ok", retcode: 0, data: null }));
  const sent = await publish(h, row); assert.equal(sent.protocolAccepted, true);
  h.wire(null); h.own([{ tid: "tid_sent", content: row.content, time: h.at / 1000, is_private: true }]);
  await rejects(() => h.runtime.verifyPublish(h.ctx, row.id), "NOT_VERIFIABLE");
});
await test("verification cannot race cancel/revision changes into confirmation", async () => {
  const h = host(), row = await ready(h), sent = await publish(h, row);
  h.own([{ tid: "tid_sent", content: row.content, time: h.at / 1000, is_private: true }]);
  h.beforeWire(async (_c, action) => { if (action === "get_qzone_msg_list") await h.runtime.cancel(h.ctx, row.id, sent.revision, admin); });
  await rejects(() => h.runtime.verifyPublish(h.ctx, row.id), "REVISION"); assert.notEqual(bot(h).drafts[row.id].status, "confirmed");
});
await test("cancel revokes approved draft and never publishes by cancellation", async () => {
  const h = host(), row = await ready(h); const cancelled = await h.runtime.cancel(h.ctx, row.id, row.revision, admin);
  assert.equal(cancelled.status, "uncertain"); await rejects(() => publish(h, cancelled)); assert.equal(h.calls.length, 0);
});
await test("cancel after claim but before actual wire revokes binding", async () => {
  const h = host(), row = await ready(h);
  h.beforeWire(async (_ctx, _a, _p, opts) => {
    const live = h.runtime.status(h.ctx).drafts[0]; await h.runtime.cancel(h.ctx, live.id, live.revision, admin);
    assert.equal(opts.binding.isCurrent(), false);
  });
  assert.equal((await publish(h, row)).status, "uncertain"); assert.equal(h.calls.length, 0);
});
await test("public source proof revoked at wire blocks even approved operation", async () => {
  const h = host(), source = { kind: "public_information", ref: "p" }; h.grant(source);
  const row = await ready(h, "允许的公开内容", { source });
  h.beforeWire(() => h.ungrant(source)); assert.equal((await publish(h, row)).status, "uncertain"); assert.equal(h.calls.length, 0);
});
await test("raw feed IDs and QQs cannot become interaction targets", async () => {
  const h = host(); await h.runtime.readFeeds(h.ctx);
  await rejects(() => h.runtime.proposeInteraction(h.ctx, { kind: "like", feedId: "tid_friend" }, admin), "HANDLE");
  await rejects(() => h.runtime.proposeInteraction(h.ctx, { kind: "like", feedId: "x", target_uin: 20002 }, admin), "INPUT");
});
await test("normalized handles stay exact-context/account scoped", async () => {
  const h = host(), id = await feedId(h), b = h.runtime.open("b"), other = h.runtime.open("a");
  for (const ctx of [b, other]) await rejects(() => h.runtime.proposeInteraction(ctx, { kind: "like", feedId: id }, admin), "HANDLE");
});
await test("like/comment share explicit review path and exact official schemas", async () => {
  for (const kind of ["like", "comment"]) {
    const h = host(), d = await (kind === "like" ? like(h) : comment(h)), r = await approve(h, d);
    const result = await publish(h, r), call = h.calls[1]; assert.equal(result.protocolAccepted, true);
    assert.deepEqual(call.params, kind === "like" ? { tid: "tid_friend", target_uin: 20002, abstime: h.at / 1000 }
      : { tid: "tid_friend", target_uin: 20002, content: "谢谢分享" });
    assert.equal(call.action, kind === "like" ? "like_qzone" : "comment_qzone");
  }
});
await test("incomplete, self, peer and old events refuse interaction", async () => {
  for (const patch of [{ content_complete: false }, { uin: 10001 }, { time: 100 }, { uin: 30003 }]) {
    const h = host(); h.peers(["30003"]); h.next([h.nextFeed(patch)]);
    await rejects(() => like(h), "TARGET"); assert.equal(h.calls.length, 1);
  }
});
await test("interaction freshness rechecked after approval and at actual wire", async () => {
  const h = host(), row = await approve(h, await like(h)); h.tick(defaults.reads.freshnessMs + 1);
  await rejects(() => publish(h, row), "TARGET"); assert.equal(h.calls.length, 1);
  const n = host(), r = await approve(n, await like(n)); n.beforeWire(() => n.peers(["20002"]));
  assert.equal((await publish(n, r)).status, "uncertain"); assert.equal(n.calls.length, 1);
});
await test("duplicate interaction event stays deduped across fresh host handles", async () => {
  const h = host(), row = await approve(h, await comment(h)); await publish(h, row);
  await rejects(() => comment(h), "DUPLICATE"); assert.equal(h.calls.filter(c => c.action === "comment_qzone").length, 1);
});
await test("feed handle cache is bounded at100 and evicts oldest", async () => {
  const h = host(); let old;
  for (let i = 0; i < 6; i++) {
    h.next(Array.from({ length: 20 }, (_, j) => h.nextFeed({ tid: `tid_${i}_${j}` })));
    const page = await h.runtime.readFeeds(h.ctx); old ||= page.feeds[0].id;
  }
  await rejects(() => h.runtime.proposeInteraction(h.ctx, { kind: "like", feedId: old }, admin), "HANDLE");
});
await test("restart loses approval leases; restored approved cannot auto publish", async () => {
  const h = host(), row = await ready(h); h.restart(); await rejects(() => publish(h, row), "APPROVAL");
  const refreshed = await h.runtime.approve(h.ctx, row.id, row.revision, admin);
  assert.equal((await publish(h, refreshed)).protocolAccepted, true);
});
await test("restart loses raw interaction targets, not durable anti-replay claims", async () => {
  const h = host(), row = await approve(h, await like(h)); h.restart();
  const approved = await h.runtime.approve(h.ctx, row.id, row.revision, admin);
  await rejects(() => publish(h, approved), "TARGET"); assert.equal(h.calls.length, 1);
});
await test("pure recovery never mutates input and downgrades approvals/transport proof", async () => {
  const h = host(), approved = await ready(h, "待审核恢复"), sent = await ready(h, "待结算恢复"); await publish(h, sent);
  const before = clone(h.memory), result = recoverQzoneState(h.memory, { reason: "restart", now: h.at });
  assert.deepEqual(h.memory, before); assert.equal(result.changed, true); assert.equal(result.recovered, 2);
  const b = result.memory.qzoneSocial.bots["logical:a"].owners["10001"];
  assert.equal(b.drafts[approved.id].status, "review"); assert.equal(b.drafts[sent.id].status, "uncertain");
  assert.equal(b.capabilities.send_qzone_msg.state, "unknown"); assert.equal(b.capabilities.send_qzone_msg.writeSettled, undefined);
  assert.equal(b.capabilities.send_qzone_msg.diagnosticPrevious.state, "supported");
});
await test("backup recovery applies without socialAgents and does not resume", async () => {
  const h = host(), row = await ready(h); await publish(h, row);
  assert.equal(h.memory.socialAgents, undefined); const restored = h.restore("backup_restore");
  assert.equal(restored.changed, true); assert.equal(bot(h).drafts[row.id].status, "uncertain");
  assert.equal(bot(h).drafts[row.id].reason, "QZONE_BACKUP_RESTORE_NO_RETRY");
  h.restart(); await rejects(() => publish(h, h.runtime.status(h.ctx).drafts[0])); assert.equal(h.calls.length, 1);
});
await test("recovery is idempotent and no-QZone state stays untouched", async () => {
  const memory = { other: { stable: true } }, no = recoverQzoneState(memory, { reason: "restart", now: 0 });
  assert.equal(no.changed, false); assert.equal(no.memory, memory);
  const h = host(), row = await ready(h); await publish(h, row); h.restore("restart");
  assert.equal(h.restore("restart").changed, false);
  assert.throws(() => recoverQzoneState(memory, { reason: "guess", now: 0 }));
});
await test("runtime recover is explicit bookkeeping even offline and never sends", async () => {
  const h = host(), row = await ready(h); await publish(h, row); h.stop();
  assert.deepEqual(await h.runtime.recover(h.ctx), { recovered: 1, automaticResume: false });
  assert.equal(h.calls.length, 1); assert.equal(bot(h).drafts[row.id].status, "uncertain");
});
await test("recovery during in-flight request cannot resurrect publishing", async () => {
  const h = host(), row = await ready(h);
  h.wire(async () => { await h.runtime.recover(h.ctx); return { status: "ok", retcode: 0, data: { tid: "tid_sent" } }; });
  const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(result.protocolAccepted, true);
});
await test("physical QQ isolation for independent accounts", async () => {
  const h = host(), row = await create(h), ctx = h.runtime.open("b");
  assert.deepEqual(h.runtime.status(ctx).drafts, []);
  await rejects(() => h.runtime.submitReview(ctx, row.id, row.revision, admin), "NOT_FOUND");
});
await test("failover shared logical identity never shares private drafts/reads/approval", async () => {
  const h = host({ logicalFor: () => "shared:persona" }), row = await ready(h), id = await feedId(h), b = h.runtime.open("b");
  assert.deepEqual(h.runtime.status(b).drafts, []); assert.equal(h.runtime.status(b).daily.reads, 0);
  await rejects(() => h.runtime.publish(b, row.id, row.revision, { actor: admin }), "NOT_FOUND");
  await rejects(() => h.runtime.proposeInteraction(b, { kind: "like", feedId: id }, admin), "HANDLE");
  const other = await h.runtime.createDraft(b, { content: row.content, source: { kind: "admin_topic", ref: "topic:other" } }, admin);
  assert.equal(h.runtime.status(h.ctx).drafts.length, 1); assert.equal(h.runtime.status(b).drafts[0].id, other.id);
  assert.ok(bot(h, "shared:persona", "10001")); assert.ok(bot(h, "shared:persona", "10002"));
});
await test("same physical QQ namespace refuses different account registry ownership", async () => {
  const h = host({ logicalFor: () => "shared", qqFor: () => "10001" }); await create(h);
  assert.throws(() => h.runtime.open("b"), /STATE_SCOPE/);
});
await test("autonomy cannot bootstrap protocol proof from config or reads", async () => {
  const p = enabled({ mode: "scoped_autonomy", autonomy: { enabled: true, maxContentLength: 280,
    sources: [{ kind: "admin_topic", ref: "topic:books", content: "固定公开材料" }] } });
  const h = host({ policy: p }); await h.runtime.readOwn(h.ctx); const row = await create(h, "固定公开材料");
  await rejects(() => publish(h, row), "APPROVAL"); assert.equal(h.calls.length, 1);
});
await test("scoped autonomy requires previous settled actual write and exact source text", async () => {
  const p = enabled({ mode: "scoped_autonomy", autonomy: { enabled: true, maxContentLength: 280,
    sources: [{ kind: "admin_topic", ref: "topic:books", content: "固定允许材料" }] } });
  const h = host({ policy: p }); const sample = await ready(h, "明确批准的验证样本"); await publish(h, sample);
  const allowed = await create(h, "固定允许材料"); assert.equal((await publish(h, allowed)).protocolAccepted, true);
  const other = await create(h, "同来源但正文不在许可中"); await rejects(() => publish(h, other), "APPROVAL");
});
await test("autonomy never publishes public audience without explicit review", async () => {
  const p = enabled({ mode: "scoped_autonomy", allowedAudiences: [64, 1], autonomy: { enabled: true, maxContentLength: 280,
    sources: [{ kind: "admin_topic", ref: "topic:books", content: "许可材料" }] } });
  const h = host({ policy: p }); await publish(h, await ready(h, "验证样本"));
  const row = await create(h, "许可材料", { audience: 1 }); await rejects(() => publish(h, row), "APPROVAL");
});
await test("autonomy restored draft is never a fresh-process publishing grant", async () => {
  const p = enabled({ mode: "scoped_autonomy", autonomy: { enabled: true, maxContentLength: 280,
    sources: [{ kind: "admin_topic", ref: "topic:books", content: "待恢复材料" }] } });
  const h = host({ policy: p }); await publish(h, await ready(h, "验证样本"));
  const d = await create(h, "待恢复材料"); h.restart(); await rejects(() => publish(h, d), "APPROVAL");
});
await test("capability support is bound to exact protocol version", async () => {
  const h = host(), row = await ready(h); await publish(h, row);
  const svc = createQzoneRuntime({ ...h.deps, capture: id => ({ ...h.deps.capture(id), protocolVersion: "synthetic-v2" }) });
  assert.equal(svc.status(svc.open("a")).capabilities.send_qzone_msg, "unknown");
});
await test("draft capacity fails closed without erasing tombstones", async () => {
  const h = host(); for (let i = 0; i < 128; i++) await create(h, `草稿编号 ${i}`);
  await rejects(() => create(h, "溢出草稿"), "CAPACITY"); assert.equal(Object.keys(bot(h).drafts).length, 128);
});
await test("unknown repository schema is never silently overwritten", () => {
  const h = host(); h.replaceMemory({ qzoneSocial: { version: 2, bots: {} } });
  assert.throws(() => h.runtime.status(h.ctx), /STATE_VERSION/);
  assert.throws(() => recoverQzoneState(h.memory, { reason: "restart", now: h.at }), /STATE_VERSION/);
});

await test("source identity or ref cannot be swapped across draft persistence await", async () => {
  for (const mode of ["replace", "ref", "kind"]) {
    const h = host(), original = { kind: "public_information", ref: "public:initial" };
    const other = { kind: "public_information", ref: "public:other" }; h.grant(original); h.grant(other);
    const input = { content: "公开来源绑定", source: original };
    h.before(() => {
      if (mode === "replace") input.source = other;
      else if (mode === "ref") original.ref = "public:other";
      else original.kind = "admin_topic";
    });
    await rejects(() => h.runtime.createDraft(h.ctx, input, null), "SOURCE_PROOF");
    assert.deepEqual(h.memory, {});
  }
});
await test("source ref cannot be repinned after approval", async () => {
  const h = host(), source = { kind: "public_information", ref: "public:original" }; h.grant(source);
  const row = await ready(h, "公开材料绑定", { source }); source.ref = "public:different";
  await rejects(() => publish(h, row), "SOURCE_PROOF"); assert.equal(h.calls.length, 0);
});
await test("administrator callback cannot be an asynchronous or truthy permission grant", async () => {
  const h = host();
  for (const callback of [() => ({ administrator: true }), async () => true]) {
    const svc = createQzoneRuntime({ ...h.deps, isAdministrator: callback }), ctx = svc.open("a");
    await rejects(() => svc.createDraft(ctx, { content: "不可靠的许可", source: { kind: "admin_topic", ref: "x" } }, admin), "ACTOR");
  }
});
await test("read persistence acknowledgement failure exposes no private handles", async () => {
  const h = host(); h.after(() => { throw new Error("publication acknowledgement unknown"); });
  await rejects(() => h.runtime.readFeeds(h.ctx)); assert.equal(h.calls.length, 0);
});
await test("read final capability-publication revocation suppresses projection", async () => {
  const h = host(); h.after(n => { if (n === 2) h.stop(); });
  await rejects(() => h.runtime.readFeeds(h.ctx), "STALE"); assert.equal(h.calls.length, 1);
});
await test("delayed wire claim expires and cannot cross a budget day", async () => {
  for (const delay of [60001, 86400000]) {
    const h = host(), row = await ready(h); h.beforeWire(() => h.tick(delay));
    const result = await publish(h, row); assert.equal(result.status, "uncertain"); assert.equal(h.calls.length, 0);
  }
});
await test("in-flight write serializes same-kind drafts without a second send lane", async () => {
  const h = host(), a = await ready(h, "第一条在途"), b = await ready(h, "第二条等待");
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  h.wire(async () => { started(); await pending; return { status: "ok", retcode: 0, data: { tid: "tid_sent" } }; });
  const first = publish(h, a); await entered;
  await rejects(() => publish(h, b), "IN_FLIGHT"); release(); await first; assert.equal(h.calls.length, 1);
});
await test("cooldown measures settled time rather than a delayed reservation", async () => {
  const h = host({ policy: enabled({ publish: { enabled: true, maxDaily: 20, cooldownMs: 1000 } }) });
  const a = await ready(h, "延迟发送"), b = await ready(h, "后续发送");
  h.wire(() => { h.tick(900); return { status: "ok", retcode: 0, data: { tid: "tid_sent" } }; });
  await publish(h, a); h.tick(100); await rejects(() => publish(h, b), "COOLDOWN");
  h.tick(900); await publish(h, b); assert.equal(h.calls.length, 2);
});
await test("runtime scoped recovery does not mutate another QQ owner's approval", async () => {
  const h = host({ logicalFor: () => "shared:persona" }), a = await ready(h), ctx = h.runtime.open("b");
  let b = await h.runtime.createDraft(ctx, { content: "另一账号草稿", source: { kind: "admin_topic", ref: "b" } }, admin);
  b = await h.runtime.submitReview(ctx, b.id, b.revision, admin);
  b = await h.runtime.approve(ctx, b.id, b.revision, admin);
  await h.runtime.recover(h.ctx);
  assert.equal(h.runtime.status(h.ctx).drafts.find(r => r.id === a.id).status, "review");
  assert.equal(h.runtime.status(ctx).drafts[0].status, "approved");
});
await test("carrier QQ changes invalidate old route and fresh context sees only its QQ", async () => {
  let activeQq = "10001";
  const h = host({ logicalFor: () => "shared:persona", qqFor: () => activeQq }), row = await ready(h);
  h.bump(); activeQq = "10002";
  await rejects(() => publish(h, row), "STALE");
  const fresh = h.runtime.open("a"); assert.deepEqual(h.runtime.status(fresh).drafts, []);
  await h.runtime.readOwn(fresh); assert.deepEqual(h.calls[0].params, { target_uin: 10002, pos: 0, num: 20 });
});
await test("claimed recovery clears approvals and records no replay despite missing ACK", async () => {
  const h = host(), row = await ready(h), m = clone(h.memory), b = m.qzoneSocial.bots["logical:a"].owners["10001"];
  b.drafts[row.id].status = "claimed"; b.drafts[row.id].approval = { actor: "old" };
  const result = recoverQzoneState(m, { reason: "backup_restore", now: h.at });
  const recovered = result.memory.qzoneSocial.bots["logical:a"].owners["10001"].drafts[row.id];
  assert.equal(recovered.status, "uncertain"); assert.equal(recovered.approval, undefined); assert.equal(recovered.protocolAccepted, false);
});
await test("old in-flight ACK after recovery cannot restore transport support proof", async () => {
  const h = host(), row = await ready(h);
  h.wire(async () => { await h.runtime.recover(h.ctx); return { status: "ok", retcode: 0, data: { tid: "tid_sent" } }; });
  await publish(h, row); assert.equal(h.runtime.status(h.ctx).capabilities.send_qzone_msg, "unknown");
  assert.equal(bot(h).drafts[row.id].protocolAccepted, true);
});
await test("recovered uncertain attempt does not permanently block a new approved sample", async () => {
  const h = host(), a = await ready(h, "旧操作"), n = h.commits;
  h.after(count => { if (count === n + 1) throw new Error("unknown publication"); });
  await rejects(() => publish(h, a)); h.after(null); h.restart(); await h.runtime.recover(h.ctx);
  const b = await ready(h, "新的独立验证样本"); assert.equal((await publish(h, b)).protocolAccepted, true);
  await rejects(() => create(h, "旧操作"), "DUPLICATE");
});
await test("likes/comments switches cannot be enabled merely by admin approval", async () => {
  const h = host({ policy: enabled({ likes: defaults.likes, comments: defaults.comments }) });
  const row = await approve(h, await like(h)); await rejects(() => publish(h, row), "WRITE_DISABLED");
  assert.equal(h.calls.filter(c => QZONE_WRITE_ACTIONS.includes(c.action)).length, 0);
});
await test("approveInteraction is the same authenticated CAS approval path", () => {
  const h = host(); assert.equal(h.runtime.approveInteraction, h.runtime.approve);
});
await test("restored public draft needs fresh explicit admin approval and host source re-attestation", async () => {
  const h = host(), source = { kind: "public_information", ref: "public:reattest" }; h.grant(source);
  const row = await ready(h, "可重新核实的材料", { source }); h.restore("restart"); h.restart();
  const stored = h.runtime.status(h.ctx).drafts[0];
  await rejects(() => h.runtime.approve(h.ctx, stored.id, stored.revision, admin), "SOURCE_PROOF");
  const svc = createQzoneRuntime({ ...h.deps,
    isSourceAllowed: (_ctx, s) => s.kind === "public_information" && s.ref === "public:reattest" });
  const ctx = svc.open("a"); await rejects(() => svc.publish(ctx, row.id, stored.revision, { actor: admin }), "SOURCE_PROOF");
  const approved = await svc.approve(ctx, stored.id, stored.revision, admin);
  const result = await svc.publish(ctx, approved.id, approved.revision, { actor: admin });
  assert.equal(result.protocolAccepted, true);
});

console.log(`QZone safe core: ${checks} synthetic checks passed (no live IO).`);
