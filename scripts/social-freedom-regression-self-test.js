import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { botControlRevision, logicalBotId } from "../src/account-runtime.js";
import { administerPersonMemory, personMemoryControl } from "../src/people-memory.js";
import { createQzoneRuntime } from "../src/qzone-runtime.js";
import { createQzoneOwnerReview } from "../src/qzone-owner-review.js";
import { normalizeQzonePolicy } from "../src/qzone-policy.js";
import { isQzoneAction, qzoneActionKind } from "../src/qzone-delivery.js";
import { assertPublicIllustration } from "../src/public-illustration.js";

// Execute actual, unmodified bridge callbacks in the SAME JS realm as the
// runtime's plain-object validators. Never import/start bridge.js. Read source
// only; repositories, archive results, queues and OneBot are entirely in memory.
// Collection qualification/public-alias regressions live in the sibling tests.
const source = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Bridge fixture boundary missing: ${start}`);
  return source.slice(first, last);
}
function compile(body, dependencies) {
  return new Function(...Object.keys(dependencies), `"use strict";\n${body}`)(...Object.values(dependencies));
}
const ACCOUNT = "fixture", BOT = "account:fixture", QQ = "20001", OWNER = "10001", PERSON = "30001";
const account = { id: ACCOUNT, qq: QQ, displayName: "Synthetic fixture", enabled: true, protocolEnabled: true,
  qzone: { enabled: true, mode: "reviewed", reviewTransport: "qq_owner", publish: { enabled: true, cooldownMs: 0 } } };
const config = { accounts: { version: 2, items: [account], failoverGroups: [] },
  privateChats: { ownerUserIds: [OWNER] } };
const NOW = Date.now(), completed = [];
const networkFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("REGRESSION_UNEXPECTED_NETWORK"); };

const peopleLegacySuppressed = compile(`${section("function peopleLegacySuppressed(", "function compactSelectedMemory(")}\nreturn peopleLegacySuppressed;`,
  { logicalBotId, personMemoryControl });
const historyCode = section("      read_history: async (ctx, args, { signal }) => {", "\n      read_memory:");
const qzoneCode = section("  const qzoneAdminActor = Object.freeze(", "  const roleCardGrowthState =");

async function test(name, run) {
  await run();
  completed.push(name);
}
function suppress(memory, operation) {
  const result = administerPersonMemory(memory, { logicalBotId: BOT, userId: PERSON,
    expectedRevision: memory.peopleMemory?.revision || 0, operation, actorUserId: OWNER,
    authorized: true, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(personMemoryControl(memory, { logicalBotId: BOT, userId: PERSON }).suppressesLegacy, true);
}
function historyFixture({ operation, duringSearch } = {}) {
  const memory = { groups: {} }, ctx = { logicalId: BOT, conversationId: "group:40001" };
  const selected = { ...config, __activeAccountId: ACCOUNT, memory: { people: { enabled: false } } };
  const scope = { accountId: ACCOUNT, internalId: "40001", userId: PERSON,
    event: { message_type: "group", group_id: "40001", user_id: PERSON } };
  let searches = 0;
  if (operation) suppress(memory, operation);
  const callback = compile(`return ({${historyCode}}).read_history;`, {
    memory, config, peopleLegacySuppressed,
    requireSocialCurrent: () => scope, accountById: () => account,
    configForGroupAccount: () => selected,
    socialMessages: () => [{ seq: 1, text: "SYNTHETIC_RECENT_OLD_FACT", isBot: false }],
    socialEvidenceProjection: value => structuredClone(value),
    archiveConversationMetaFromEvent: () => ({ conversationId: ctx.conversationId }),
    archiveEnabledForConversation: () => true,
    retrieveArchiveSnippets: async () => {
      searches++;
      // Cross a real await, then publish a real person-control tombstone. Keep
      // the separate identity guard valid to isolate the history fence itself.
      await Promise.resolve();
      if (duringSearch) suppress(memory, duringSearch);
      return [{ type: "user", text: "SYNTHETIC_ARCHIVED_OLD_FACT" }];
    }
  });
  return { call: args => callback(ctx, args, {}), searches: () => searches };
}

function qzoneFixture(initialMemory = { groups: {} }) {
  const wire = [], requests = [], gateChecks = [], ws = { readyState: 1, __hermesSessionId: "synthetic-session-1" };
  const accounts = new Map([[ACCOUNT, { ws, selfId: QQ, protocolVersion: "synthetic" }]]);
  const hooks = { afterCommit: null, beforeWire: null, externalQuiet: false };
  let runtimeOptions;
  const host = compile(`
    let memory = initialMemory;
    const configRevision = 1;
    const mutateMemory = async (_published, build) => {
      const draft = structuredClone(memory), result = build(draft);
      memory = draft;
      await hooks.afterCommit?.(memory);
      return result;
    };
    const isQuiet = (root, id) => hooks.externalQuiet || Number(root.groups?.[id]?.settings?.quietUntil || 0) > Date.now();
    ${qzoneCode}
    return { qzoneRuntime, qzoneOwnerReview, qzoneContext, qzoneReviewContext,
      offerQzoneOwnerReview, qzoneCurrent, qzoneCapture, qzoneAdminActor, qzoneOwnerActors,
      resolveQzonePublicImage, qzoneImagePreview, publicIllustrations,
      get memory() { return memory; },
      change: build => mutateMemory(memory, build) };
  `, {
    initialMemory: structuredClone(initialMemory), hooks, config, createHash, logicalBotId, botControlRevision,
    normalizeQzonePolicy, createQzoneOwnerReview, isQzoneAction, qzoneActionKind, assertPublicIllustration,
    createQzoneRuntime: options => { runtimeOptions = options; return createQzoneRuntime(options); },
    oneBotAccounts: accounts, qzoneBindings: new WeakMap(),
    accountById: () => account, effectiveAccount: () => account,
    configuredAccountDefinitions: () => [account], accountIsSelected: () => true,
    accountExecutionRevision: () => "stable-execution-revision",
    accountRuntimeContext: () => ({ accountId: ACCOUNT, logicalBotId: BOT }),
    accountRuntimeContextCurrent: () => true, configForReplyAccount: () => config,
    privateOwnerUserIds: () => [OWNER], isPrivateOwner: id => id === OWNER,
    oneBotBinding: () => ({ id: ACCOUNT, sessionId: ws.__hermesSessionId }),
    recordQzoneEpisode: async () => {},
    oneBotRequest: async (_ws, action, params, { binding }) => {
      requests.push(action);
      // Queue/transport substitute: recheck the REAL bridge-produced binding
      // after an await. No sockets, model/provider or bridge service is started.
      await Promise.resolve();
      await hooks.beforeWire?.(action);
      const allowed = binding.isCurrent();
      gateChecks.push({ action, allowed });
      if (!allowed) throw new Error("SYNTHETIC_FINAL_GATE_BLOCKED");
      binding.onSendStarted?.();
      wire.push({ action, params: structuredClone(params) });
      return action === "send_private_msg" ? { message_id: "51001" } : { tid: "synthetic-tid" };
    }
  });
  const setQuiet = () => host.change(draft => {
    draft.groups[`qzone:${QQ}`] = { settings: { quietUntil: NOW + 3600000 } };
  });
  async function offer() {
    const zone = host.qzoneContext(ACCOUNT).ctx;
    const draft = await host.qzoneRuntime.createDraft(zone, { content: "合成公开主题正文",
      audience: 64, source: { kind: "admin_topic", ref: "synthetic-topic" } }, host.qzoneAdminActor);
    assert.equal((await host.offerQzoneOwnerReview(zone, draft)).status, "accepted");
    const preview = wire.find(row => row.action === "send_private_msg");
    assert.equal(preview.params.user_id, OWNER);
    assert(preview.params.message[0].data.text.includes(draft.content));
    const token = preview.params.message[0].data.text.match(/qzone confirm ([a-f0-9]{32})/)?.[1];
    assert(token, "Real preview callback must provide its confirmation token");
    const confirm = () => host.qzoneOwnerReview.handle(host.qzoneReviewContext(zone),
      { private: true, verified: true, userId: OWNER }, `/bot qzone confirm ${token}`);
    return { zone, draft, confirm, token };
  }
  return { host, hooks, wire, requests, gateChecks, ws, setQuiet, offer, options: () => runtimeOptions,
    writes: () => wire.filter(row => row.action === "send_qzone_msg") };
}

function publicImageFixture(sourceKind = "public-search") {
  const bytes = Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = `${sourceKind === "group-observed" ? "gs" : "public"}_${sha256}`;
  const f = qzoneFixture({ groups: {}, socialExpressionAssets: { version: 1, bots: {
    [BOT]: { capabilities: {}, stickers: { [id]: { id, source: sourceKind, active: true, sha256,
      annotations: { "group:40001": { status: "candidate",
        reuseQualification: { eligible: true, sha256, version: 1 } } } } } }
  } } });
  const zone = f.host.qzoneContext(ACCOUNT).ctx, key = `${BOT}:${id}`;
  f.host.publicIllustrations.set(key, { buffer: Buffer.from(bytes), sha256, expiresAt: Date.now() + 60000 });
  return { ...f, zone, id, key, bytes, sha256,
    resolve: ctx => f.host.resolveQzonePublicImage(ctx || zone, id),
    preview: ctx => f.host.qzoneImagePreview(ctx || zone, id) };
}

try {
  await test("history: unsuppressed callback returns real synthetic results", async () => {
    const f = historyFixture(), result = await f.call({ query: "合成" });
    assert.equal(result.archived[0].text, "SYNTHETIC_ARCHIVED_OLD_FACT");
    assert.equal(result.recent[0].text, "SYNTHETIC_RECENT_OLD_FACT");
    assert.equal(f.searches(), 1);
  });
  for (const operation of ["freeze", "revoke", "delete"]) {
    for (const args of [{}, { query: "合成" }]) {
      await test(`history: ${operation} blocks ${args.query ? "archive" : "recent"} before retrieval`, async () => {
        const f = historyFixture({ operation });
        assert.deepEqual(await f.call(args), { recent: [], archived: [], reason: "PERSON_CONTROL_SUPPRESSED" });
        assert.equal(f.searches(), 0);
      });
    }
    await test(`history: ${operation} during await discards archive AND recent`, async () => {
      const f = historyFixture({ duringSearch: operation });
      assert.deepEqual(await f.call({ query: "合成" }), { recent: [], archived: [], reason: "PERSON_CONTROL_SUPPRESSED" });
      assert.equal(f.searches(), 1);
    });
  }
  await test("qzone: actual preview/confirmation publishes exact text once", async () => {
    const f = qzoneFixture(), review = await f.offer();
    assert.equal((await review.confirm()).status, "accepted");
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0].params.content, review.draft.content);
    assert.equal(f.writes()[0].params.ugc_right, review.draft.audience);
    assert.equal((await review.confirm()).status, "blocked");
    assert.equal(f.writes().length, 1);
  });
  await test("qzone: control change invalidates capture/current, even without identity changes", async () => {
    const f = qzoneFixture(), zone = f.host.qzoneContext(ACCOUNT).ctx;
    assert.equal(f.host.qzoneCurrent(zone), true);
    await f.setQuiet();
    assert.equal(f.host.qzoneCurrent(zone), false);
    assert.notEqual(f.host.qzoneCapture(ACCOUNT).revision, zone.revision);
    assert.equal(f.wire.length, 0);
  });
  for (const phase of ["review", "approved"]) {
    await test(`qzone: quiet after durable ${phase} prevents publication`, async () => {
      const f = qzoneFixture(), review = await f.offer();
      f.hooks.afterCommit = async memory => {
        const drafts = memory.qzoneSocial?.bots[BOT]?.owners[QQ]?.drafts || {};
        if (!Object.values(drafts).some(row => row.status === phase)) return;
        f.hooks.afterCommit = null;
        await f.setQuiet();
      };
      assert.equal((await review.confirm()).status, "uncertain");
      assert.equal(f.writes().length, 0);
      assert(!f.requests.includes("send_qzone_msg"));
    });
  }
  await test("qzone: owner actor independently rejects quiet, not textual authority", async () => {
    const f = qzoneFixture(), zone = f.host.qzoneContext(ACCOUNT).ctx;
    const actor = Object.freeze({ source: "qq-owner-review" });
    assert.equal(f.options().isAdministrator(zone, actor), false);
    f.host.qzoneOwnerActors.set(actor, { accountId: ACCOUNT, userId: OWNER });
    assert.equal(f.options().isAdministrator(zone, actor), true);
    // Deliberately keep the capture revision current to isolate the actor's
    // extra quiet defense, rather than passing via the control-hash fence.
    f.hooks.externalQuiet = true;
    assert.equal(f.host.qzoneCurrent(zone), true);
    assert.equal(f.options().isAdministrator(zone, actor), false);
  });
  await test("qzone: request independently rejects already-quiet writes", async () => {
    const f = qzoneFixture(), zone = f.host.qzoneContext(ACCOUNT).ctx;
    f.hooks.externalQuiet = true;
    assert.equal(f.host.qzoneCurrent(zone), true);
    await assert.rejects(() => f.options().request(zone, "send_qzone_msg", { content: "合成正文" },
      { binding: { isCurrent: () => true, onSendStarted: () => assert.fail("No wire permitted") } }), /QZONE_QUIET/);
    assert.equal(f.requests.length, 0);
  });
  await test("qzone: final real request binding rejects quiet arriving in the send queue", async () => {
    const f = qzoneFixture(), review = await f.offer();
    f.hooks.beforeWire = action => { if (action === "send_qzone_msg") f.hooks.externalQuiet = true; };
    assert.equal((await review.confirm()).status, "uncertain");
    assert.equal(f.host.qzoneCurrent(review.zone), true, "Isolate final quiet gate from revision invalidation");
    assert(f.requests.includes("send_qzone_msg"), "Must reach queue admission, not stop earlier");
    assert.equal(f.gateChecks.find(row => row.action === "send_qzone_msg").allowed, false,
      "The bridge request binding itself must reject, before onSendStarted/runtime actor checks");
    assert.equal(f.writes().length, 0);
  });
  await test("qzone: restart/session change never consumes an old owner token", async () => {
    const f = qzoneFixture(), review = await f.offer();
    const restarted = qzoneFixture(f.host.memory);
    restarted.ws.__hermesSessionId = "synthetic-session-2";
    const zone = restarted.host.qzoneContext(ACCOUNT).ctx;
    assert.notEqual(zone.revision, review.zone.revision);
    const result = await restarted.host.qzoneOwnerReview.handle(restarted.host.qzoneReviewContext(zone),
      { private: true, verified: true, userId: OWNER }, `/bot qzone confirm ${review.token}`);
    assert.equal(result.status, "blocked");
    assert.equal(restarted.wire.length, 0);
  });
  await test("qzone image: actual resolver and preview pin the same public base64 bytes", async () => {
    const f = publicImageFixture(), resolved = f.resolve(), preview = f.preview();
    assert.equal(resolved.id, f.id);
    assert.equal(resolved.sha256, f.sha256);
    assert.equal(resolved.provenance, "public");
    assert.equal(resolved.containsPrivateMaterial, false);
    assert.equal(resolved.immutable, true);
    assert.equal(resolved.wireReference, `base64://${f.bytes.toString("base64")}`);
    assert.deepEqual(preview, { type: "image", data: { file: resolved.wireReference } });
    assert.deepEqual(f.host.qzoneImagePreview(f.zone, { id: f.id }), preview);
    assert.deepEqual(Buffer.from(preview.data.file.slice("base64://".length), "base64"), f.bytes);
    assert.equal(f.requests.length, 0, "Resolver/preview must not dispatch OneBot");
  });
  for (const kind of ["group-observed", "collection"]) {
    await test(`qzone image: ${kind} is rejected even with matching hash/cache`, () => {
      const f = publicImageFixture(kind);
      assert.throws(f.resolve, /QZONE_IMAGE_UNAVAILABLE/);
      assert.throws(f.preview, /QZONE_IMAGE_UNAVAILABLE/);
      assert.equal(f.requests.length, 0);
    });
  }
  for (const [name, revoke] of [
    ["inactive asset", asset => { asset.active = false; }],
    ["blocked asset", asset => { asset.blocked = true; }],
    ["denied asset", asset => { asset.denied = true; }],
    ["rejected annotation", asset => { asset.annotations["group:40001"].status = "rejected"; }],
    ["blocked annotation", asset => { asset.annotations["group:40001"].blocked = true; }],
    ["denied annotation", asset => { asset.annotations["group:40001"].denied = true; }],
    ["no remaining annotation", asset => { asset.annotations = {}; }]
  ]) {
    await test(`qzone image: ${name} revokes an already-resolved preview`, async () => {
      const f = publicImageFixture();
      assert.equal(f.preview().type, "image");
      await f.host.change(memory => revoke(memory.socialExpressionAssets.bots[BOT].stickers[f.id]));
      assert.throws(f.resolve, /QZONE_IMAGE_UNAVAILABLE/);
      assert.throws(f.preview, /QZONE_IMAGE_UNAVAILABLE/);
    });
  }
  for (const target of ["asset", "cache"]) {
    await test(`qzone image: changed ${target} hash is rejected`, async () => {
      const f = publicImageFixture();
      if (target === "asset") await f.host.change(memory => {
        memory.socialExpressionAssets.bots[BOT].stickers[f.id].sha256 = "0".repeat(64);
      });
      else f.host.publicIllustrations.get(f.key).sha256 = "0".repeat(64);
      assert.throws(f.resolve, /QZONE_IMAGE_UNAVAILABLE/);
      assert.throws(f.preview, /QZONE_IMAGE_UNAVAILABLE/);
    });
  }
  for (const missing of ["asset", "cache"]) {
    await test(`qzone image: another logical identity cannot borrow the ${missing}`, async () => {
      const f = publicImageFixture(), other = { ...f.zone, logicalId: "account:other" };
      // Seed the OTHER half in that namespace so each scope lookup is tested
      // independently, not merely failing because both lookups are absent.
      if (missing === "asset") f.host.publicIllustrations.set(`${other.logicalId}:${f.id}`,
        { ...f.host.publicIllustrations.get(f.key) });
      else await f.host.change(memory => {
        memory.socialExpressionAssets.bots[other.logicalId] = structuredClone(memory.socialExpressionAssets.bots[BOT]);
      });
      assert.throws(() => f.resolve(other), /QZONE_IMAGE_UNAVAILABLE/);
      assert.throws(() => f.preview(other), /QZONE_IMAGE_UNAVAILABLE/);
    });
  }
  for (const state of ["missing", "expired"]) {
    await test(`qzone image: ${state} cached bytes cannot be previewed`, () => {
      const f = publicImageFixture();
      if (state === "missing") f.host.publicIllustrations.delete(f.key);
      else f.host.publicIllustrations.get(f.key).expiresAt = 0;
      assert.throws(f.resolve, /QZONE_IMAGE_UNAVAILABLE/);
      assert.throws(f.preview, /QZONE_IMAGE_UNAVAILABLE/);
    });
  }
  console.log(JSON.stringify({ ok: true, scenarios: completed.length, completed,
    realQQCalls: 0, realModelCalls: 0, realNetworkCalls: 0, runtimeFileWrites: 0 }));
} finally {
  globalThis.fetch = networkFetch;
}
