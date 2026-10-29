// Synthetic cache/repository/OneBot only. No network, model, QQ, files or timers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQzoneRuntime, recoverQzoneState } from "../src/qzone-runtime.js";
import { normalizeQzonePolicy } from "../src/qzone-policy.js";

let checks = 0;
const test = async (name, run) => {
  try { await run(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};
const admin = Object.freeze({ administrator: true }), clone = structuredClone;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=", "base64");
const image = (id, marker = "", patch = {}) => {
  const bytes = Buffer.concat([png, Buffer.from(marker)]);
  return { id, sha256: sha(bytes), provenance: "public", containsPrivateMaterial: false,
    immutable: true, wireReference: `base64://${bytes.toString("base64")}`, ...patch };
};
function host({ resolver = true, policy = {}, resolve } = {}) {
  let memory = {}, insideTransaction = false, commits = 0, before, after, beforeWire;
  let current = true, administrators = true, resolution;
  const cache = new Map(["a", "b", "c"].map(id => [id, image(id, id)]));
  const calls = [], lookups = [], requests = [], source = Object.freeze({ kind: "public_information", ref: "public:fixture" });
  const deps = {
    capture: accountId => ({ accountId, logicalId: `logical:${accountId}`, qq: accountId === "a" ? "10001" : "10002",
      revision: 1, protocolVersion: "synthetic-v1", policy: normalizeQzonePolicy({ enabled: true, mode: "reviewed",
        publish: { enabled: true, maxDaily: 20, cooldownMs: 0 }, reads: { own: true, cooldownMs: 0 }, ...policy }) }),
    isCurrent: () => current, readState: () => ({ memory }), clock: () => Date.UTC(2026, 9, 27),
    isAdministrator: (_ctx, actor) => administrators && actor === admin,
    peerQqs: () => [], isSourceAllowed: (_ctx, candidate) => candidate === source,
    transact: async builder => {
      const n = ++commits;
      await before?.(n);
      const draft = clone(memory);
      insideTransaction = true;
      try {
        const result = builder({ memory: draft });
        assert.equal(Boolean(result?.then), false, "repository builder remains synchronous");
        memory = draft;
      } finally { insideTransaction = false; }
      await after?.(n);
    },
    request: async (ctx, action, params, { binding }) => {
      requests.push({ action, params });
      await beforeWire?.(ctx, action, params, binding);
      assert.equal(binding.isCurrent(), true);
      binding.onSendStarted();
      calls.push({ action, params: clone(params), memory: clone(memory) });
      return { status: "ok", retcode: 0, data: { tid: "tid_sent", time: 1793059200 } };
    },
    ...(resolver ? { resolveImage: (ctx, id) => {
      assert.equal(insideTransaction, false, "resolver must NEVER run in repository builder");
      assert.match(id, /^[a-zA-Z0-9:_-]{1,128}$/);
      lookups.push({ ctx, id });
      return resolve ? resolve(ctx, id) : resolution ? resolution(ctx, id) : cache.get(id);
    } } : {})
  };
  let runtime = createQzoneRuntime(deps), ctx = runtime.open("a");
  const stored = id => memory.qzoneSocial.bots["logical:a"].owners["10001"].drafts[id];
  return {
    deps, cache, calls, lookups, requests, source,
    get runtime() { return runtime; }, get ctx() { return ctx; }, get memory() { return memory; },
    get commits() { return commits; }, stored,
    before: fn => { before = fn; }, after: fn => { after = fn; }, beforeWire: fn => { beforeWire = fn; },
    resolve: fn => { resolution = fn; }, stop: () => { current = false; }, revoke: () => { administrators = false; },
    recover: () => { memory = recoverQzoneState(memory, { reason: "restart", now: deps.clock() }).memory; },
    restart: () => { runtime = createQzoneRuntime(deps); ctx = runtime.open("a"); },
    create: (images = ["a"], content = "公开图片配合正文", extra = {}, actor = admin) => runtime.createDraft(ctx,
      { content, images, source: { kind: "admin_topic", ref: "topic:fixture" }, ...extra }, actor),
    review: row => runtime.submitReview(ctx, row.id, row.revision, admin),
    approve: row => runtime.approve(ctx, row.id, row.revision, admin),
    publish: row => runtime.publish(ctx, row.id, row.revision, { actor: admin })
  };
}
const ready = async (h, ...args) => h.approve(await h.review(await h.create(...args)));
const denied = (fn, code = "QZONE_") => assert.rejects(fn, new RegExp(code));

await test("documented string-array wire, ordered hashes only in state, IDs only in detached views", async () => {
  const h = host(), row = await ready(h, ["b", "a"]);
  assert.deepEqual(row.images, ["b", "a"]);
  assert.deepEqual(h.stored(row.id).images, ["b", "a"].map(id => ({ id, sha256: h.cache.get(id).sha256 })));
  const result = await h.publish(row), call = h.calls[0];
  assert.equal(call.action, "send_qzone_msg");
  assert.deepEqual(call.params, { content: row.content, ugc_right: 64,
    images: [h.cache.get("b").wireReference, h.cache.get("a").wireReference] });
  assert.equal(call.memory.qzoneSocial.bots["logical:a"].owners["10001"].drafts[row.id].status, "publishing");
  assert.equal(result.protocolAccepted, true); assert.equal(result.clientVerified, false);
  assert.doesNotMatch(JSON.stringify(h.memory), /base64:\/\/|file:\/\/|https?:\/\//);
  row.images.reverse(); result.images.push("forged");
  assert.deepEqual(h.runtime.status(h.ctx).drafts[0].images, ["b", "a"]);
  assert.deepEqual(h.runtime.status(h.ctx).images, { supported: true, maxCount: 9 });
});
await test("no resolver preserves rejection and text-only wire compatibility", async () => {
  const h = host({ resolver: false });
  await denied(() => h.create(), "HOST_IMAGE_RESOLVER_REQUIRED");
  assert.equal(h.commits, 0); assert.equal(h.runtime.status(h.ctx).images.supported, false);
  const row = await ready(h, []); await h.publish(row);
  assert.deepEqual(h.calls[0].params, { content: row.content, ugc_right: 64 });
});
await test("only bounded opaque IDs reach resolver, never model URL/path/object/hash fields", async () => {
  for (const ids of [["https://example.org/public.png"], ["file:///tmp/a"], ["base64://aGVsbG8="],
    ["/tmp/public.png"], ["../a"], ["C:\\image.png"], ["__proto__"], ["constructor"], ["prototype"], [""],
    ["x".repeat(129)], [{ id: "a", sha256: "forged" }], [null], [1], Array(1), {}, null, "a",
    Array.from({ length: 10 }, (_, i) => `id_${i}`), ["a", "a"]]) {
    const h = host(); await denied(() => h.create(ids), "IMAGES_INVALID");
    assert.equal(h.lookups.length, 0); assert.equal(h.commits, 0);
  }
});
await test("maximum nine attachments accepted in exact order", async () => {
  const h = host(), ids = Array.from({ length: 9 }, (_, i) => `image:${i}`);
  ids.forEach(id => h.cache.set(id, image(id, id)));
  const row = await ready(h, ids); await h.publish(row);
  assert.deepEqual(h.calls[0].params.images, ids.map(id => h.cache.get(id).wireReference));
});
await test("public provenance, no-private and immutable attestations must be exact", async () => {
  for (const patch of [{ provenance: "private" }, { provenance: "private_qzone" }, { provenance: "group" },
    { provenance: "public_information" }, { provenance: true }, { provenance: undefined },
    { containsPrivateMaterial: true }, { containsPrivateMaterial: "false" }, { containsPrivateMaterial: undefined },
    { immutable: false }, { immutable: "true" }, { immutable: undefined }, { id: "b" },
    { sha256: "f".repeat(63) }, { sha256: "A".repeat(64) }]) {
    const h = host(); h.cache.set("a", image("a", "a", patch));
    await denied(() => h.create(), "IMAGE_PROOF_REQUIRED"); assert.deepEqual(h.memory, {});
  }
});
await test("host URLs/files refused even with public proof, never transported or persisted", async () => {
  for (const wireReference of ["https://public.example/image", "http://127.0.0.1/private", "file:///tmp/image", "aGVsbG8=", {}, null]) {
    const h = host(); h.cache.set("a", image("a", "a", { wireReference }));
    await denied(() => h.create(), "IMAGE_PROOF_REQUIRED"); assert.equal(h.requests.length, 0);
  }
});
await test("unavailable/throwing/promise resolver fails closed without secret-bearing errors", async () => {
  for (const resolve of [() => undefined, () => Promise.resolve(image("a")),
    async () => { throw Error("sensitive provider detail"); }, () => ({ ...image("a"), then() {} }),
    () => { throw Error("sensitive provider detail"); }]) {
    const h = host({ resolve }); await denied(() => h.create(), "QZONE_IMAGE_(?:PROOF_REQUIRED|UNAVAILABLE)");
    assert.deepEqual(h.memory, {}); assert.equal(h.calls.length, 0);
  }
  assert.throws(() => createQzoneRuntime({ ...host().deps, resolveImage: {} }), /HOST_CONTRACT/);
});
await test("actual bytes must match attested immutable sha256", async () => {
  const h = host(); h.cache.set("a", image("a", "tampered", { sha256: image("a", "original").sha256 }));
  await denied(() => h.create(), "IMAGE_HASH_OR_SIZE"); assert.equal(h.commits, 0);
});
await test("empty/malformed/noncanonical base64 refused", async () => {
  for (const encoded of ["", "a", "AA", "YQ=", "YQ==\n", "!!!!", "YQ======", "YR==", "====", "YWJj====", "-___"]) {
    const h = host(); h.cache.set("a", image("a", "a", { wireReference: `base64://${encoded}`, sha256: sha(Buffer.from(encoded, "base64")) }));
    await denied(() => h.create(), "IMAGE_(?:BYTES_INVALID|HASH_OR_SIZE)");
  }
});
await test("5MiB individual and 20MiB aggregate byte bounds, no regex stack overflow", async () => {
  const h = host(), bytes = Buffer.alloc(5 * 1024 * 1024, 1);
  const entry = id => ({ ...image(id), sha256: sha(bytes), wireReference: `base64://${bytes.toString("base64")}` });
  h.cache.set("a", entry("a")); await h.create();
  const large = Buffer.alloc(bytes.length + 1);
  h.cache.set("b", { ...image("b"), sha256: sha(large), wireReference: `base64://${large.toString("base64")}` });
  await denied(() => h.create(["b"]), "IMAGE_(?:BYTES_INVALID|HASH_OR_SIZE)");
  const ids = Array.from({ length: 5 }, (_, i) => `large:${i}`);
  ids.forEach((id, i) => { bytes[0] = i; h.cache.set(id, entry(id)); });
  await h.create(ids.slice(0, 4));
  await denied(() => h.create(ids), "IMAGE_HASH_OR_SIZE");
});
await test("duplicate bytes under different IDs refused inside one attachment list", async () => {
  const h = host(); h.cache.set("alias", { ...h.cache.get("a"), id: "alias" });
  await denied(() => h.create(["a", "alias"]), "IMAGES_INVALID"); assert.equal(h.commits, 0);
});
await test("dedupe binds canonical body plus ordered hashes, not mutable IDs or source refs", async () => {
  const h = host(); h.cache.set("alias", { ...h.cache.get("a"), id: "alias" });
  await h.create(["a", "b"], "a b");
  await denied(() => h.create(["alias", "b"], "ａ  b", { source: { kind: "admin_topic", ref: "different" } }), "DUPLICATE");
  await h.create(["b", "a"], "a b"); await h.create(["a", "c"], "a b"); await h.create([], "a b");
  h.restart(); await denied(() => h.create(["a", "b"], "a b"), "DUPLICATE");
});
await test("published image fingerprint tombstone dedupes alias IDs after draft removal/restart", async () => {
  const h = host(), row = await ready(h); await h.publish(row);
  delete h.memory.qzoneSocial.bots["logical:a"].owners["10001"].drafts[row.id];
  h.cache.set("alias", { ...h.cache.get("a"), id: "alias" }); h.restart();
  await denied(() => h.create(["alias"]), "DUPLICATE"); assert.equal(h.calls.length, 1);
});
await test("caller cannot swap image input array while draft publication is pending", async () => {
  const h = host(), ids = ["a", "b"];
  h.before(() => { ids.reverse(); });
  const row = await h.create(ids);
  assert.deepEqual(row.images, ["a", "b"]);
  assert.deepEqual(h.stored(row.id).images.map(entry => entry.id), ["a", "b"]);
});
await test("public-source autonomous preparation grants neither admin actor nor approval", async () => {
  const h = host(), row = await h.create(["a"], "公开准备", { source: h.source }, null);
  assert.equal(row.status, "draft"); assert.equal(h.calls.length, 0);
  await denied(() => h.runtime.approve(h.ctx, row.id, row.revision, null), "ACTOR");
  await denied(() => h.runtime.publish(h.ctx, row.id, row.revision, { actor: { ...admin } }), "ACTOR");
  await denied(() => h.publish(row), "APPROVAL_REQUIRED");
  const approved = await h.approve(await h.review(row)); await h.publish(approved); assert.equal(h.calls.length, 1);
});
await test("existing text-only scoped autonomy does not authorize new image payloads", async () => {
  const h = host({ policy: { mode: "scoped_autonomy", autonomy: { enabled: true,
    sources: [{ kind: "admin_topic", ref: "topic:fixture", content: "固定主题" }] } } });
  await h.publish(await ready(h, [], "协议验证样本"));
  const row = await h.create(["a"], "固定主题"); await denied(() => h.publish(row), "APPROVAL_REQUIRED");
  await h.publish(await h.approve(await h.review(row))); assert.equal(h.calls.length, 2);
});
await test("changed image bytes/hash before approval cannot be silently repinned", async () => {
  const h = host(), row = await h.review(await h.create()); h.cache.set("a", image("a", "new bytes"));
  await denied(() => h.approve(row), "IMAGE_CHANGED"); assert.equal(h.stored(row.id).status, "review");
  assert.notEqual(h.stored(row.id).images[0].sha256, h.cache.get("a").sha256);
});
await test("changes across draft/approval durable publication await grant no lease", async () => {
  for (const phase of ["draft", "approval"]) {
    const h = host(); let row;
    if (phase === "approval") row = await h.review(await h.create());
    h.after(() => h.cache.set("a", image("a", "replaced during await")));
    await denied(() => phase === "draft" ? h.create() : h.approve(row), "IMAGE_CHANGED");
    h.after(null); const stored = h.runtime.status(h.ctx).drafts[0];
    await denied(() => h.publish(stored), "APPROVAL_REQUIRED"); assert.equal(h.calls.length, 0);
  }
});
await test("observed changed hash revokes old lease even if old bytes are later restored", async () => {
  const h = host(), row = await ready(h), old = h.cache.get("a"); h.cache.set("a", image("a", "new bytes"));
  await denied(() => h.publish(row), "IMAGE_CHANGED"); h.cache.set("a", old);
  await denied(() => h.publish(row), "APPROVAL_REQUIRED"); assert.equal(h.calls.length, 0);
  await h.publish(await h.approve(row)); assert.equal(h.calls.length, 1);
});
await test("private/revoked or byte-tampered attachments after approval revoke leases", async () => {
  for (const patch of [{ provenance: "private" }, { containsPrivateMaterial: true },
    { wireReference: image("a", "forged bytes").wireReference }]) {
    const h = host(), row = await ready(h), old = h.cache.get("a"); h.cache.set("a", { ...old, ...patch });
    await denied(() => h.publish(row), "IMAGE_"); h.cache.set("a", old);
    await denied(() => h.publish(row), "APPROVAL_REQUIRED"); assert.equal(h.calls.length, 0);
  }
});
await test("confirmation binds exact body, source, audience, IDs, hashes and ordering", async () => {
  for (const mutate of [row => { row.content = "公开图片配合正文 "; }, row => { row.audience = 4; },
    row => { row.source.ref = "different:source"; }, row => { row.images.reverse(); },
    row => { row.images[0].id = "alias"; }, row => { row.images[0].sha256 = "f".repeat(64); }]) {
    const h = host({ policy: { allowedAudiences: [64, 4] } }), row = await ready(h, ["a", "b"]);
    h.cache.set("alias", { ...h.cache.get("a"), id: "alias" }); mutate(h.stored(row.id));
    await denied(() => h.publish(row), "CONFIRMATION_CHANGED"); assert.equal(h.calls.length, 0);
  }
});
await test("approval queued against a changed exact snapshot fails CAS binding", async () => {
  const h = host(), row = await h.review(await h.create());
  h.before(() => { h.stored(row.id).content += " "; });
  await denied(() => h.approve(row), "CONFIRMATION_CHANGED"); assert.equal(h.calls.length, 0);
});
await test("approval view mutation grants no authority and cannot change wire payload", async () => {
  const h = host(), row = await ready(h); row.content = "伪造预览"; row.images = ["b"]; row.audience = 1;
  await h.publish(row);
  assert.deepEqual(h.calls[0].params, { content: "公开图片配合正文", ugc_right: 64, images: [h.cache.get("a").wireReference] });
});
await test("image/cache changes after durable claim fail closed with no stale replay", async () => {
  const h = host(), row = await ready(h);
  h.after(() => { h.cache.set("a", image("a", "changed after claim")); });
  const result = await h.publish(row); assert.equal(result.status, "uncertain"); assert.equal(h.requests.length, 0);
  h.after(null); h.restart(); await denied(() => h.publish(h.runtime.status(h.ctx).drafts[0])); assert.equal(h.calls.length, 0);
});
await test("actual wire hook rechecks hash, provenance and quiet after transport queue await", async () => {
  for (const change of [h => h.cache.set("a", image("a", "changed at actual wire")),
    h => h.cache.set("a", { ...h.cache.get("a"), containsPrivateMaterial: true }), h => h.cache.delete("a"),
    h => h.stop(), h => h.revoke()]) {
    const h = host(), row = await ready(h);
    h.beforeWire((_ctx, _action, _params, binding) => { change(h); assert.equal(binding.isCurrent(), false); });
    const result = await h.publish(row); assert.equal(result.status, "uncertain"); assert.equal(h.calls.length, 0);
  }
});
await test("onSendStarted independently checks images after earlier successful isCurrent", async () => {
  const h = host(), row = await ready(h);
  h.beforeWire((_ctx, _action, _params, binding) => {
    assert.equal(binding.isCurrent(), true); h.cache.set("a", image("a", "late substitution"));
    assert.throws(() => binding.onSendStarted(), /IMAGE_CHANGED/);
  });
  assert.equal((await h.publish(row)).status, "uncertain"); assert.equal(h.calls.length, 0);
});
await test("saved attachment changes after claim cannot be sent under old confirmation", async () => {
  const h = host(), row = await ready(h, ["a", "b"]);
  h.beforeWire(() => { h.stored(row.id).images.reverse(); });
  assert.equal((await h.publish(row)).status, "uncertain"); assert.equal(h.calls.length, 0);
});
await test("image publication cannot be client-confirmed from a text-only own-list match", async () => {
  const h = host(), row = await ready(h); await h.publish(row);
  const result = await h.runtime.verifyPublish(h.ctx, row.id);
  assert.equal(result.reason, "QZONE_IMAGES_CLIENT_UNVERIFIED"); assert.equal(result.clientVerified, false);
  assert.equal(h.calls.length, 1); assert.notEqual(result.status, "confirmed");
});
await test("restart/offline read views preserve IDs without resolving cache or replaying approval", async () => {
  const h = host(), row = await ready(h); h.recover(); h.restart();
  h.resolve(() => { throw Error("read views must not resolve images"); }); h.stop();
  const status = h.runtime.status(h.ctx);
  assert.deepEqual(status.drafts[0].images, ["a"]); assert.equal(status.drafts[0].status, "review");
  assert.equal(h.calls.length, 0);
});
await test("restart without recovery still loses lease, fresh approval must reattest cache", async () => {
  const h = host(), row = await ready(h); h.restart();
  await denied(() => h.publish(row), "APPROVAL_REQUIRED"); h.cache.set("a", image("a", "changed across restart"));
  await denied(() => h.approve(row), "IMAGE_CHANGED"); assert.equal(h.calls.length, 0);
});
await test("restart may reapprove only identical cached bytes with original administrator", async () => {
  const h = host(), row = await ready(h); h.recover(); h.restart();
  const review = h.runtime.status(h.ctx).drafts[0];
  await h.publish(await h.approve(review)); assert.equal(h.calls.length, 1);
  await denied(() => h.publish(h.runtime.status(h.ctx).drafts[0])); assert.equal(h.calls.length, 1);
});
await test("restored attachment read view works with resolver absent, but approval fails closed", async () => {
  const h = host(), row = await ready(h), runtime = createQzoneRuntime({ ...h.deps, resolveImage: undefined });
  const ctx = runtime.open("a"); assert.deepEqual(runtime.status(ctx).drafts[0].images, ["a"]);
  await denied(() => runtime.approve(ctx, row.id, row.revision, admin), "HOST_IMAGE_RESOLVER_REQUIRED");
});
await test("cross-account resolver sees captured scope and cannot borrow another owner cache", async () => {
  const h = host(); h.resolve((ctx, id) => ctx.accountId === "a" ? h.cache.get(id) : undefined);
  const row = await h.create(), other = h.runtime.open("b");
  assert.deepEqual(h.runtime.status(other).drafts, []);
  await denied(() => h.runtime.createDraft(other, { content: "隔离测试", images: ["a"],
    source: { kind: "admin_topic", ref: "topic:other" } }, admin), "IMAGE_PROOF_REQUIRED");
  await denied(() => h.runtime.approve(other, row.id, row.revision, admin), "DRAFT_NOT_FOUND");
});
await test("concurrent image writes retain exactly one claim and one wire", async () => {
  const h = host(), row = await ready(h);
  const results = await Promise.allSettled([h.publish(row), h.publish(row)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(h.calls.length, 1);
});
await test("uncertain claim acknowledgement never transports images or retries", async () => {
  const h = host(), row = await ready(h);
  h.after(() => { throw Error("durable acknowledgement lost"); });
  await denied(() => h.publish(row), "acknowledgement lost"); assert.equal(h.requests.length, 0);
  h.after(null); h.recover(); h.restart();
  await denied(() => h.publish(h.runtime.status(h.ctx).drafts[0])); assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(h.memory), /base64:\/\//);
});
console.log(`QZone images: ${checks} synthetic checks passed (Node ${process.versions.node}; no live IO).`);
