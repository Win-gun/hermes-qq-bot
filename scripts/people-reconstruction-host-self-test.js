import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import vm from "node:vm";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { administerPersonMemory } from "../src/people-memory.js";
import {
  createPeopleReconstructionHost, PeopleReconstructionWorkerSource,
  PEOPLE_RECONSTRUCTION_HOST_LIMITS as H
} from "../src/people-reconstruction-host.js";
import {
  classifyPeopleReconstructionRow, createPeopleReconstructionState,
  createPeopleReconstructionRunner
} from "../src/people-memory-reconstruction.js";

// Fixtures only. Every source/cache/runtime file lives below this new tmpdir.
// Never import bridge, read production paths, contact QQ or a real model.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-reconstruction-host-"));
const NOW = Date.parse("2026-10-31T12:00:00Z"), AT = "2026-10-01T00:00:00Z";
const G = "10001", G2 = "10002", U = "50001", OTHER = "50002", BOT = "account:alpha", PEER = "account:beta";
const PRIVATE = "PRIVATE_RAW_ONLY_IN_WORKER";
let checks = 0, fakeModels = 0;
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const check = (a, label) => { assert.ok(a, label); checks++; };
const rejects = async (promise, code) => { await assert.rejects(promise, { code }); checks++; };
const clients = new Set();
const healthy = () => ({ writable: true, recoveryRequired: false, lastError: null, durability: "durable" });
const eligible = tuple => tuple.logicalBotId === null || [BOT, PEER].includes(tuple.logicalBotId);
const receipt = (mid, extra = {}) => ({ accountId: "alpha", verifiedSenderId: U, conversationId: `group:${G}`, time: AT, ...extra });
function canonical(value, mid, extra = {}) {
  return { id: `mem_${mid}`, subjectUserId: U, kind: "preference", value, status: "active",
    confidence: 0.9, source: "ai-extraction", sourceMessageIds: mid ? [mid] : [],
    evidenceKeys: mid ? [JSON.stringify([G, mid])] : [], ...extra };
}
function rootWith(n, { receipts = true } = {}) {
  const entries = [], index = {};
  for (let i = 0; i < n; i++) {
    const mid = `m${i}`; entries.push(canonical(`喜欢项目${i}`, receipts ? mid : "", { id: `mem_${i}` }));
    if (receipts) index[mid] = { [BOT]: receipt(mid) };
  }
  return { groups: { [G]: { users: { [U]: { canonicalMemory: { subjectUserId: U, entries } } }, peopleSourceIndex: index } } };
}
function harness(initial) {
  let live = structuredClone(initial), transactions = 0, failNext = false;
  const history = [];
  return {
    getState: () => live, transactions: () => transactions, history,
    failNext: () => { failNext = true; },
    transact: async build => {
      const draft = structuredClone(live), result = build(draft);
      assert.ok(!result?.then, "existing-writer builder must stay synchronous");
      if (failNext) { failNext = false; throw new Error("fixture lost storage acknowledgement"); }
      live = draft; transactions++; history.push({ host: structuredClone(draft.peopleReconstruction?.host),
        status: draft.peopleReconstruction?.status, claim: structuredClone(draft.peopleReconstruction?.claim) });
      return result;
    }
  };
}
let serial = 0;
async function fixtureSource(memory, records = []) {
  const directory = path.join(home, `source-${serial++}`); await fs.mkdir(directory);
  const memoryFile = path.join(directory, "memory.json"), archiveFile = path.join(directory, "archive.jsonl");
  await fs.writeFile(memoryFile, JSON.stringify(memory));
  await fs.writeFile(archiveFile, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  return { cacheDir: path.join(directory, "cache"), memoryFile,
    archives: records.length ? [{ id: "fixture-group", path: archiveFile, conversationId: `group:${G}` }] : [] };
}
function makeHost(h, source, options = {}) {
  const host = createPeopleReconstructionHost({ getState: h.getState, transact: h.transact,
    memoryHealth: healthy, eligible, source, now: () => NOW, ...options }); clients.add(host); return host;
}
async function finish(host, max = 100) {
  for (let i = 0; i < max; i++) {
    const p = await host.tick();
    if (["completed", "completed_with_limits", "cancelled"].includes(p.reconstruction?.status)) return p;
    if (p.code && !["BATCH_OUTCOME_UNKNOWN", "MODEL_BINDING_CHANGED"].includes(p.code)) failProgress(p);
  }
  throw new Error("fixture exceeded bounded opportunity count");
}
function failProgress(progress) { throw new Error(`unexpected safe code ${progress.code}`); }
function modelOptions(handler, budget = () => ({ remainingCalls: 5, remainingTokens: 10000, maxTokensPerCall: 512 })) {
  return { budget, captureBinding: s => ({ id: "fixture-text-only", revision: 1, owner: s.logicalBotId }),
    bindingCurrent: b => b.id === "fixture-text-only", reconstruct: async args => {
      fakeModels++; return handler(args);
    } };
}
const originalRecord = (mid, value, extra = {}) => ({ type: "user_message", conversationId: `group:${G}`,
  messageId: mid, senderId: U, senderName: "相同昵称", sentAt: AT, sentAtMs: Date.parse(AT), time: AT,
  text: `我${value}`, rawText: `我${value}`, ...extra });

try {
  // Execute ONLY isolated real bridge writer functions in a stubbed VM. Never
  // import/run bridge startup, config loading, services, OneBot or paid models.
  const bridgeSource = await fs.readFile(new URL("../src/bridge.js", import.meta.url), "utf8");
  function bridgeFunction(name, next) {
    const start = bridgeSource.indexOf(`function ${name}(`), end = bridgeSource.indexOf(`\nfunction ${next}(`, start);
    assert.ok(start >= 0 && end > start); return bridgeSource.slice(start, end);
  }
  const bridgeFixture = vm.createContext({ path, Buffer, Date,
    accountGroup: () => null, chatArchiveConfig: () => ({ baseDir: "/fixture/archive", privacyFilter: false }),
    archiveEnabledForConversation: () => true, asStringId: value => String(value ?? ""),
    asArray: value => Array.isArray(value) ? value : [], extractReplyMessageIds: () => [],
    archiveSafeValue: value => value, archiveImageRecord: () => ({}), botDisplayName: () => "fixture",
    logicalBotId: () => BOT, updateArchiveIndex: () => {}, summarizeArchiveIfNeeded: () => {},
    appendJsonl: (file, record) => { bridgeFixture.lastFile = file; bridgeFixture.lastRecord = record; },
    warn: () => { throw new Error("bridge fixture writer failed"); }
  });
  vm.runInContext([
    bridgeFunction("safePathSegment", "accountQrPaths"), bridgeFunction("conversationIdFromEvent", "conversationLabelFromEvent"),
    bridgeFunction("archiveDirectoryId", "aiArgsWithoutPrompt"), bridgeFunction("messageTiming", "formatMessageTime"),
    bridgeFunction("archiveConversationMetaFromEvent", "archiveConversationSettings"), bridgeFunction("archiveConversationEvent", "archiveBotReply")
  ].join("\n"), bridgeFixture);
  function actualBridgeRecord(event) {
    bridgeFixture.input = { event, config: { __activeAccountId: "alpha" }, memory: { groups: {} },
      text: "我喜欢摄影", accountId: "alpha", senderName: "fixture" };
    vm.runInContext("archiveConversationEvent(input)", bridgeFixture);
    return { file: bridgeFixture.lastFile, record: JSON.parse(JSON.stringify(bridgeFixture.lastRecord)) };
  }
  const bridgeGroup = actualBridgeRecord({ message_type: "group", group_id: G, user_id: U,
    message_id: "bridge-group", time: Date.parse(AT) / 1000, __logicalBotId: BOT });
  equal([bridgeGroup.record.senderId, bridgeGroup.record.messageId, bridgeGroup.record.conversationId,
    bridgeGroup.record.sentAtMs, bridgeGroup.record.logicalBotId], [U, "bridge-group", `group:${G}`, Date.parse(AT), BOT],
    "source field schema is tested against the real bridge archive writer, not guessed fixtures");
  const bridgePrivate = actualBridgeRecord({ message_type: "private", user_id: U, message_id: "bridge-private",
    time: Date.parse(AT) / 1000, __accountId: "alpha", __independentAccounts: true, __logicalBotId: BOT });
  equal([bridgePrivate.file, bridgePrivate.record.conversationId], [`/fixture/archive/private/${U}-alpha/messages.jsonl`, `private:${U}:alpha`],
    "real independent-private directory and conversation preserve account suffix");
  const bridgeFailover = actualBridgeRecord({ message_type: "private", user_id: U, message_id: "bridge-failover",
    time: Date.parse(AT) / 1000, __accountId: "alpha", __accountGroupId: "family", __logicalBotId: "group:family" });
  check(bridgeFailover.file.includes("/private/ctx-") && bridgeFailover.record.conversationId === `private:${U}:group:family`,
    "real failover-private archive uses ctx base64url namespace");
  const fallback = actualBridgeRecord({ message_type: "group", group_id: G, user_id: U,
    message_id: "fallback-time", __receivedAt: NOW, __logicalBotId: BOT });
  equal([fallback.record.sentAtMs, Object.hasOwn(fallback.record, "sourceTimeKnown")], [NOW, false],
    "archive timestamps alone cannot prove source time because real writer has an unmarked receive-time fallback");

  const enumeratedRoot = { groups: {
    [G]: { users: { [U]: { preferences: ["喜欢摄影"] } } },
    [`private:${U}:alpha`]: { users: { [U]: { preferences: ["喜欢摄影"] } } },
    [`private:${U}:group:family`]: { users: { [U]: { preferences: ["喜欢摄影"] } } }
  } };
  const rootSource = await fixtureSource(enumeratedRoot), archiveRoot = path.join(path.dirname(rootSource.memoryFile), "archive-root");
  for (const item of [bridgeGroup, bridgePrivate, bridgeFailover]) {
    const relative = path.relative("/fixture/archive", item.file), file = path.join(archiveRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(item.record) + "\n");
  }
  const enumWorker = new PeopleReconstructionWorkerSource({ cacheDir: rootSource.cacheDir }); clients.add(enumWorker);
  await enumWorker.capture({ sourceId: "actual-bridge-format", memoryFile: rootSource.memoryFile, archiveRoot });
  while (enumWorker.status().phase !== "ready") await enumWorker.advance();
  equal(enumWorker.status().archiveFiles, 3, "worker directory enumeration covers actual group, independent-private and failover-private formats");
  const enumPage = await enumWorker.readPage({ sourceId: "actual-bridge-format", cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: 32 });
  const privateRow = enumPage.rows.find(row => row.jobKey === `private:${U}:alpha`);
  equal([privateRow.sources[0].conversationId, privateRow.sources[0].archiveConversationId], [`private:${U}`, `private:${U}:alpha`],
    "normalized transport conversation never erases original private archive ownership context");
  check(privateRow.sources.every(source => !Object.hasOwn(source, "text")), "real bridge private raw text never leaves source worker");
  equal(classifyPeopleReconstructionRow(enumeratedRoot, privateRow, { now: NOW, eligible }).tier, "Supported", "real private tuple remains candidate support, not public disclosure authority");
  const familyRow = enumPage.rows.find(row => row.jobKey === `private:${U}:group:family`);
  equal(familyRow.logicalBotId, "group:family", "only actual archive logicalBotId is retained, not today's carrier mapping");
  await enumWorker.close();

  const duplicateRoot = { groups: { [G]: { users: { [U]: { canonicalMemory: { subjectUserId: U,
    entries: [canonical("喜欢摄影", "same-message")] } } } } } };
  const duplicateSource = await fixtureSource(duplicateRoot, [originalRecord("same-message", "喜欢摄影"),
    originalRecord("same-message", "不喜欢摄影")]);
  const duplicateWorker = new PeopleReconstructionWorkerSource({ cacheDir: duplicateSource.cacheDir }); clients.add(duplicateWorker);
  await duplicateWorker.capture({ sourceId: "duplicate-source", memoryFile: duplicateSource.memoryFile, archives: duplicateSource.archives });
  while (duplicateWorker.status().phase !== "ready") await duplicateWorker.advance();
  const duplicatePage = await duplicateWorker.readPage({ sourceId: "duplicate-source", cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: 32 });
  equal(classifyPeopleReconstructionRow(duplicateRoot, duplicatePage.rows[0], { eligible, now: NOW }).tier,
    "Conflicted", "stripping raw source bodies does not hide contradictory duplicate message IDs");
  await duplicateWorker.close();

  // Worker-only materialization and exact QQ/message ID intersection.
  const original = rootWith(0);
  original.groups[G].users[U].canonicalMemory.entries = [canonical("喜欢摄影", "photo"), canonical("喜欢咖啡", "coffee"),
    canonical("喜欢茶", "no-id", { sourceMessageIds: [] }), canonical("不该借同名来源", "shared"),
    canonical("不该猜时间", "bad-time")];
  original.groups[G].users[OTHER] = { nickname: "相同昵称", profile: ["另一个QQ"] };
  original.groups[G2] = { users: { [U]: { profile: ["同一个QQ另一群"] } } };
  const records = [originalRecord("photo", "喜欢摄影"),
    originalRecord("coffee", "喜欢咖啡", { accountId: "alpha", logicalBotId: BOT,
      images: [{ description: "bounded match but large media metadata", file: "x".repeat(100000) }] }),
    originalRecord("tea-original-id", "喜欢茶"),
    originalRecord("shared", "不该借同名来源", { senderId: OTHER }),
    originalRecord("bad-time", "不该猜时间", { sentAtMs: Date.parse(AT) + 1 }),
    { type: "bot_reply", conversationId: `group:${G}`, messageId: "photo", senderId: U, text: "bot text", time: AT },
    "{invalid json}",
    originalRecord("huge", "巨大消息不应使扫描永久卡住", { media: "x".repeat(H.lineBytes + 10) })];
  const source = await fixtureSource(original, records);
  const worker = new PeopleReconstructionWorkerSource({ cacheDir: source.cacheDir }); clients.add(worker);
  const prepared = await worker.capture({ sourceId: "pinned-fixture", memoryFile: source.memoryFile, archives: source.archives });
  check(prepared.parserThreadId !== threadId && prepared.parserThreadId > 0, "snapshot JSON parsing is off the bridge thread");
  equal(prepared.memoryBytes, Buffer.byteLength(JSON.stringify(original)), "snapshot size is real metadata, not an estimate");
  check(!JSON.stringify(prepared).includes("喜欢") && !JSON.stringify(prepared).includes(home), "progress never exposes paths or content");
  await assert.rejects(fs.stat(`${source.memoryFile}.writer`), { code: "ENOENT" }); checks++;
  await fs.appendFile(source.archives[0].path, JSON.stringify(originalRecord("late", "后来追加不属于快照")) + "\n");
  await fs.writeFile(source.memoryFile, JSON.stringify({ groups: {} }));
  let indexSteps = 0;
  while (worker.status().phase !== "ready") { await worker.advance(); check(++indexSteps < 20, "index advances in fixed bounded steps"); }
  check(indexSteps >= 4, "large JSONL record spans multiple source opportunities");
  equal(worker.status().archiveRecords, records.length, "archive counts include invalid/non-human/oversized records exactly once");
  equal(worker.status().oversizedRecords, 1, "oversized JSONL is counted and skipped, not an infinite source_error");
  check(worker.status().invalidRecords >= 2, "time disagreement and malformed JSON are visible");
  const page = await worker.readPage({ sourceId: "pinned-fixture", cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: 32 });
  check(page.rows.length <= 32 && Buffer.byteLength(JSON.stringify(page)) < 128 * 1024, "only a fixed-size normalized batch crosses worker boundary");
  const photo = page.rows.find(r => r.value === "喜欢摄影"), coffee = page.rows.find(r => r.value === "喜欢咖啡");
  equal(classifyPeopleReconstructionRow(original, photo, { eligible, now: NOW }).tier, "Supported", "real original group/QQ without bot stays supported");
  equal(classifyPeopleReconstructionRow(original, coffee, { eligible, now: NOW }).tier, "Verified", "actual bound archive receipt can recover canonical provenance");
  equal(photo.logicalBotId, null, "missing historical bot is never replaced by current account mapping");
  const tea = page.rows.find(r => r.value === "喜欢茶");
  equal(tea.sourceMessageIds, ["tea-original-id"], "source-less old fact gets actual archive message ID only after literal self-statement match");
  equal(page.rows.find(r => r.value === "不该借同名来源").sources, [], "QQ and ID selectors are intersection, not search-service OR semantics");
  check(page.rows.every(r => r.sources.every(s => !Object.hasOwn(s, "text") && !Object.hasOwn(s, "rawText"))), "archive source bodies remain inside worker; only content-binding witnesses cross");
  check(worker.status().maxReplyBytes < 128 * 1024, "no whole archive/memory root is posted to parent");
  await worker.close();
  const reopened = new PeopleReconstructionWorkerSource({ cacheDir: source.cacheDir }); clients.add(reopened);
  await reopened.open("pinned-fixture");
  equal(reopened.status().memoryBytes, prepared.memoryBytes, "restart reopens immutable captured memory, never mutated original file");
  const pinnedDirectory = path.join(source.cacheDir, "pinned-fixture");
  check(((await fs.stat(path.join(pinnedDirectory, "memory.json"))).mode & 0o777) === 0o600, "sensitive snapshot has private filesystem mode");
  await reopened.close();
  const tamperedFile = path.join(pinnedDirectory, "archive-0.jsonl");
  const corrupt = await fs.open(tamperedFile, "r+");
  try { await corrupt.write(Buffer.from("!"), 0, 1, 0); } finally { await corrupt.close(); }
  const changedCache = new PeopleReconstructionWorkerSource({ cacheDir: source.cacheDir }); clients.add(changedCache);
  await rejects(changedCache.open("pinned-fixture"), "SNAPSHOT_CHANGED"); await changedCache.close();

  // Existing unique background writer + journal-aware source materialization.
  const durableDir = path.join(home, "real-runtime"), durableFile = path.join(durableDir, "memory.json");
  const runtime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: durableFile }));
  await runtime.open();
  let liveHost;
  try {
    await runtime.transact(root => { Object.assign(root, rootWith(1)); });
    await runtime.transact(root => { root.groups[G].users[U].profile = ["只在durable journal中的画像"]; });
    const sourceConfig = { cacheDir: path.join(durableDir, "cache"), memoryFile: durableFile, archives: [] };
    liveHost = createPeopleReconstructionHost({ getState: () => runtime.value, getRevision: () => runtime.revision,
      transact: build => runtime.transact(build), memoryHealth: () => runtime.status(), source: sourceConfig, eligible, now: () => NOW });
    clients.add(liveHost);
    await liveHost.initialize(); await liveHost.start({ authorized: true, id: "real-writer-job" });
    const result = await finish(liveHost);
    equal(result.reconstruction.candidates, 2, "source includes journal-only materialized memory, not just raw checkpoint JSON");
    equal(result.reconstruction.budget.maxCalls, 0, "absent model budget never inherits helper's 1000-call default");
    equal(result.reconstruction.stats.modelAttempts, 0, "read-only scanning never fabricates model usage");
    check(Object.values(runtime.value.peopleReconstruction.candidates).some(c => c.value === "只在durable journal中的画像"), "journal-only old profile was actually scanned");
    equal(runtime.value.peopleReconstruction.host.version, 1, "adapter metadata persisted through the same MemoryRuntime writer");
    check(runtime.status().writer, "original writer retains its ticket throughout reconstruction");
  } finally { await liveHost?.close(); await runtime.close(); }

  // Timer opportunity only, stateless scoped prompt, private/raw history excluded.
  const modelRoot = rootWith(70);
  modelRoot.groups[`private:${U}:alpha`] = { users: { [U]: { canonicalMemory: { subjectUserId: U,
    entries: [canonical(PRIVATE, "private", { evidenceKeys: [JSON.stringify([`private:${U}:alpha`, "private"])] })] } } },
    peopleSourceIndex: { private: { [BOT]: receipt("private", { conversationId: `private:${U}` }) } } };
  const modelSource = await fixtureSource(modelRoot), modelH = harness(modelRoot);
  let remaining = 1, calls = 0;
  const modelHost = makeHost(modelH, modelSource, modelOptions(async args => {
    calls++; remaining--;
    equal(args.scope, { userId: U, logicalBotId: BOT, conversationId: `group:${G}` }, "bound model sees one QQ and original public group only");
    check(!args.prompt.includes(PRIVATE) && !args.prompt.includes("evidenceKeys") && !args.prompt.includes("rawText"), "no private/raw archive payload is copied into prompts");
    check(modelH.getState().peopleReconstruction.claim.calls.some(c => c.id === args.attemptId), "model sub-call claim is durable before host gateway");
    check(Object.isFrozen(args.binding), "model gateway receives a detached frozen metadata pin");
    return { groups: [], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  }, () => ({ remainingCalls: remaining, remainingTokens: 2048, maxTokensPerCall: 512 })));
  await modelHost.initialize(); await modelHost.start({ authorized: true, id: "scoped-model" });
  equal(modelH.history[0].host, { version: 1, continueScanOnUnknown: true }, "job and adapter recovery metadata publish in ONE start transaction");
  const revisionBefore = modelHost.progress().reconstruction.revision;
  await delay(25);
  equal(modelHost.progress().reconstruction.revision, revisionBefore, "adapter has no autonomous recurring timer");
  const shared = modelHost.tick(); equal(modelHost.tick(), shared, "overlapping owner timer calls share one step"); await shared;
  const modelResult = await finish(modelHost);
  equal(calls, 1, "existing one-call budget is respected, not silently increased");
  equal(modelResult.reconstruction.stats.usage.totalTokens, 25, "only recorded provider usage is counted");
  equal(modelResult.reconstruction.candidates, 71, "nonmodel scan continues after budget stops model spending");
  check(modelResult.reconstruction.scanOnly && modelResult.reconstruction.stats.semanticSkipped > 0, "skipped semantic work is visible, not claimed complete");
  await modelHost.close();

  const staleRoot = rootWith(2), staleH = harness(staleRoot), staleSource = await fixtureSource(staleRoot);
  const livePin = { id: "text-only", revision: 1 }; let staleCalls = 0;
  const staleHost = makeHost(staleH, staleSource, {
    budget: () => ({ remainingCalls: 2, remainingTokens: 10000, maxTokensPerCall: 512 }),
    captureBinding: () => livePin, bindingCurrent: pin => pin.revision === livePin.revision,
    reconstruct: async args => {
      fakeModels++; staleCalls++;
      const candidateId = /"id":"(recon_[a-f0-9]+)"/.exec(args.prompt)[1];
      livePin.revision = 2;
      equal(args.binding.revision, 1, "later config mutation cannot alter pinned request binding");
      return { groups: [{ ids: [candidateId], summary: "STALE_SEMANTIC_MUST_NOT_APPLY" }],
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
    }
  });
  await staleHost.start({ authorized: true, id: "stale-binding" }); const staleDone = await finish(staleHost);
  equal([staleCalls, staleDone.bindingDiscards, staleDone.reconstruction.stats.usage.totalTokens], [1, 1, 25],
    "binding change discards semantics but preserves actual reported usage without another model call");
  check(Object.values(staleH.getState().peopleReconstruction.candidates).every(candidate => candidate.semantic === null),
    "stale-binding model summary is never published");
  equal(staleDone.reconstruction.status, "completed_with_limits", "discarded semantic work is not called full completion");
  await staleHost.close();

  // Supported projection: same group, real QQ, no experience/disclosure grant.
  const projectionRoot = { groups: { [G]: { users: { [U]: { preferences: ["喜欢摄影"] } } } } };
  const projectionSource = await fixtureSource(projectionRoot, [originalRecord("real-evidence", "喜欢摄影")]);
  const ph = harness(projectionRoot), projectionHost = makeHost(ph, projectionSource);
  await projectionHost.start({ authorized: true, id: "projection" }); await finish(projectionHost);
  const projection = projectionHost.supportedProjection({ logicalBotId: BOT, userId: U, conversationId: `group:${G}` });
  equal(projection.items.map(c => [c.value, c.tier, c.experience]), [["喜欢摄影", "Supported", false]], "compactMemory gets bounded uncertain same-group support without fake bot ownership");
  equal(projectionHost.supportedProjection({ logicalBotId: BOT, userId: U, conversationId: `group:${G2}` }).items, [], "compact overlay cannot cross groups");
  equal(projectionHost.supportedProjection({ logicalBotId: BOT, userId: OTHER, conversationId: `group:${G}` }).items, [], "same name other QQ cannot borrow projection");
  await ph.transact(root => administerPersonMemory(root, { logicalBotId: BOT, userId: U, operation: "revoke",
    authorized: true, actorUserId: "90001", expectedRevision: root.peopleMemory?.revision ?? 0, now: NOW }));
  equal(projectionHost.supportedProjection({ logicalBotId: BOT, userId: U, conversationId: `group:${G}` }).items, [], "latest person tombstone wins at hot projection read");
  await projectionHost.close();

  // Operator pause survives process restart, including a running model claim.
  const pauseRoot = rootWith(1), pauseSource = await fixtureSource(pauseRoot), pauseH = harness(pauseRoot);
  const paused = makeHost(pauseH, pauseSource); await paused.start({ authorized: true, id: "paused" });
  await paused.control({ authorized: true, operation: "pause", expectedRevision: paused.progress().reconstruction.revision });
  await pauseH.transact(root => {
    const j = root.peopleReconstruction;
    j.claim = { id: "orphan-paused", status: "claimed", hash: "fixture", count: 1, scanned: 1, controlRevision: j.controlRevision,
      nextCursor: { phase: "archive", offset: 3, file: 0, byte: 0 }, modelStarted: true,
      calls: [{ id: "uncertain-model", usageSettled: false }] };
    j.stats.modelAttempts = 1; j.stats.reservedTokens = 1;
  });
  await paused.close();
  const restartedPause = makeHost(pauseH, pauseSource); await restartedPause.initialize();
  const frozen = restartedPause.progress().reconstruction;
  await restartedPause.tick();
  equal([restartedPause.progress().reconstruction.status, restartedPause.progress().reconstruction.pauseReason], ["paused", "operator"], "startup recovery never resumes an operator-paused task");
  equal(restartedPause.progress().reconstruction.revision, frozen.revision, "paused timer opportunity performs no source/model transactions");
  await restartedPause.close();
  await pauseH.transact(root => { root.peopleReconstruction.status = "cancelled"; root.peopleReconstruction.claim.status = "claimed"; });
  const cancelled = makeHost(pauseH, pauseSource); await cancelled.initialize(); await cancelled.tick();
  equal(cancelled.progress().reconstruction.status, "cancelled", "orphan recovery never revives cancellation"); await cancelled.close();

  // Unknown paid outcome stops spending but later deterministic pages advance.
  const unknownRoot = rootWith(75), unknownSource = await fixtureSource(unknownRoot), uh = harness(unknownRoot);
  let unknownCalls = 0;
  const unknownHost = makeHost(uh, unknownSource, modelOptions(async () => { unknownCalls++; throw new Error("PRIVATE SECRET must not escape"); }));
  await unknownHost.start({ authorized: true, id: "unknown" });
  const unknownDone = await finish(unknownHost);
  equal(unknownCalls, 1, "unknown provider outcome is never replayed automatically");
  equal(unknownDone.reconstruction.unknownBatches, 1, "unknown page claim remains durably preserved, not an ACK");
  equal(unknownDone.reconstruction.stats.skippedUnknown, 32, "uncertain original page remains explicitly unresolved");
  equal(unknownDone.reconstruction.candidates, 43, "later nonmodel source pages still finish");
  check(unknownDone.reconstruction.scanOnly && !unknownDone.reconstruction.usageComplete, "unknown usage blocks all later spending");
  check(!JSON.stringify(unknownDone).includes("PRIVATE SECRET"), "model exception contents never reach safe progress");
  await unknownHost.close();

  // Missing usage is not zero-cost and does not stop the rest of the source scan.
  const missingRoot = rootWith(40), missingH = harness(missingRoot), missingSource = await fixtureSource(missingRoot);
  let missingCalls = 0;
  const missingHost = makeHost(missingH, missingSource, modelOptions(async () => { missingCalls++; return { groups: [] }; }));
  await missingHost.start({ authorized: true, id: "missing-usage" }); const missingDone = await finish(missingHost);
  equal([missingCalls, missingDone.reconstruction.candidates, missingDone.reconstruction.stats.unknownCalls], [1, 40, 1], "missing usage stops model only; no fabricated tokens or lost deterministic rows");
  await missingHost.close();

  // Production-uncertain policy gate: no worker, source read, transaction or model.
  const unhealthyRoot = rootWith(1), unhealthyH = harness(unhealthyRoot);
  const unsafe = makeHost(unhealthyH, { cacheDir: path.join(home, "never-created-cache"), memoryFile: path.join(home, "never-read.json") },
    { memoryHealth: () => ({ writable: false, recoveryRequired: true, lastError: "MEMORY_OPERATION_UNCERTAIN" }) });
  const unhealthyResult = await unsafe.initialize(); await unsafe.tick();
  equal(unhealthyResult.code, "MEMORY_UNAVAILABLE", "uncertain production writer fails closed before preparing sources");
  equal(unhealthyResult.source.parserThreadId, null, "no source worker launched under writer uncertainty");
  equal(unhealthyH.transactions(), 0, "uncertain status never invokes injected writer");
  await rejects(unsafe.start({ authorized: true, id: "forbidden" }), "MEMORY_UNAVAILABLE");
  await assert.rejects(fs.stat(path.join(home, "never-created-cache")), { code: "ENOENT" }); checks++;
  await unsafe.close();

  // 8,883 real-shaped legacy canonical entries + 10.3MiB unrelated root data.
  // This fixture uses a tiny in-memory writer callback; actual durability was
  // tested above with the SAME BackgroundMemoryRepository/MemoryRuntime classes.
  const largeRoot = rootWith(8883, { receipts: false });
  const targetBytes = Math.round(10.3 * 1024 * 1024), originalBytes = Buffer.byteLength(JSON.stringify(largeRoot));
  largeRoot.unrelated = "x".repeat(Math.max(0, targetBytes - originalBytes));
  const largeSource = await fixtureSource(largeRoot);
  let largeTransactions = 0;
  const largeHost = createPeopleReconstructionHost({ getState: () => largeRoot,
    transact: async build => { const result = build(largeRoot); assert.ok(!result?.then); largeTransactions++; return result; },
    source: largeSource, eligible, memoryHealth: healthy, now: () => NOW }); clients.add(largeHost);
  await largeHost.start({ authorized: true, id: "large-rolling" });
  const startedAt = Date.now(); let opportunities = 0, lastScanned = 0;
  while (!["completed", "completed_with_limits"].includes(largeHost.progress().reconstruction.status)) {
    const p = await largeHost.tick(); opportunities++;
    check(opportunities < 400 && !p.code, "10.3MiB/8883-entry run makes bounded forward progress");
    const scanned = p.reconstruction.stats.scanned;
    check(scanned - lastScanned <= 32, "one owner timer opportunity commits at most one 32-row page");
    lastScanned = scanned;
  }
  const largeDone = largeHost.progress();
  equal([largeDone.reconstruction.stats.scanned, largeDone.reconstruction.candidates], [8883, 8883], "all 8883 old entries reached durable staging; no prefix/capacity truncation");
  equal(largeDone.reconstruction.stats.people, 1, "actual people counts deduplicate QQ across bounded pages");
  equal(largeDone.reconstruction.stats.modelAttempts, 0, "large scan needs no paid/model calls");
  check(largeDone.source.memoryBytes >= 10.3 * 1024 * 1024 && largeDone.source.maxReplyBytes < 128 * 1024,
    "10.3MiB source stays in worker while every parent reply remains below 128KiB");
  check(largeTransactions < 1000, "large run does not create per-entry persistence calls");
  await largeHost.close();

  console.log(JSON.stringify({ ok: true, checks, fixtureOnly: true, paidModelCalls: 0, qqSends: 0,
    productionReads: 0, fakeModelCalls: fakeModels, large: { entries: 8883, memoryBytes: largeDone.source.memoryBytes,
      opportunities, maxWorkerReplyBytes: largeDone.source.maxReplyBytes, elapsedMs: Date.now() - startedAt } }));
} finally {
  await Promise.all([...clients].map(client => client.close().catch(() => {})));
  await fs.rm(home, { recursive: true, force: true });
}
