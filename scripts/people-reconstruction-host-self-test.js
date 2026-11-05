import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { administerPersonMemory, queryPersonMemory } from "../src/people-memory.js";
import {
  createPeopleReconstructionHost, PeopleReconstructionWorkerSource, semanticRequest,
  PEOPLE_RECONSTRUCTION_HOST_LIMITS as H
} from "../src/people-reconstruction-host.js";
import {
  classifyPeopleReconstructionRow, createPeopleReconstructionState,
  createPeopleReconstructionRunner, summarizePeopleReconstructionSemanticsPage, peopleReconstructionEvidenceBinding
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
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

{
  const candidate = { id: "internal-candidate", userId: U, conversationId: `group:${G}`,
    logicalBotId: BOT, kind: "preference", value: "喜欢胶片摄影", tier: "Verified",
    evidence: [{ messageId: "internal-message", time: AT }] };
  const request = semanticRequest([candidate], 16384, { compact: true });
  const payload = JSON.parse(request.prompt.split("\n").at(-1));
  equal(payload, { candidates: [{ id: "c0", kind: "preference", value: "喜欢胶片摄影",
    tier: "Verified", sourceLimited: false, dates: ["2026-10-01"] }] }, "compact provider payload omits source identifiers");
  equal(request.aliases.get("c0"), candidate.id, "the original ID remains pinned in host scope");
  equal(request.outputTokens, 1024, "single-candidate recovery fits the compact output cap");
  equal(semanticRequest([candidate, { ...candidate, id: "other-candidate" }], 16384, { compact: true }).outputTokens,
    736, "two-candidate request fits the observed compact envelope");
}
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
function rootWith(n, { receipts = true, kind = "preference" } = {}) {
  const entries = [], index = {};
  for (let i = 0; i < n; i++) {
    const mid = `m${i}`; entries.push(canonical(`喜欢项目${i}`, receipts ? mid : "", { id: `mem_${i}`, kind }));
    if (receipts) index[mid] = { [BOT]: receipt(mid) };
  }
  return { groups: { [G]: { users: { [U]: { canonicalMemory: { subjectUserId: U, entries } } }, peopleSourceIndex: index } } };
}
const analysisRoot = n => rootWith(n, { kind: "quote" });
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
function modelOptions(handler, budget = () => ({ remainingCalls: 5, remainingTokens: 100000, maxTokensPerCall: 16384 })) {
  return { budget, captureBinding: s => ({ id: "fixture-text-only", revision: 1, owner: s.logicalBotId }),
    bindingCurrent: b => b.id === "fixture-text-only", reconstruct: async args => {
      fakeModels++; return handler(args);
    } };
}
const originalRecord = (mid, value, extra = {}) => ({ type: "user_message", conversationId: `group:${G}`,
  messageId: mid, senderId: U, senderName: "相同昵称", sentAt: AT, sentAtMs: Date.parse(AT), time: AT,
  text: `我${value}`, rawText: `我${value}`, sourceTimeKnown: true, ...extra });

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

  // A completed legacy job with zero published rows can recover public self
  // statements from its already pinned archive, without any semantic replay.
  const evRoot = { groups: { [G]: { peopleSourceIndex: { "clock-equal": { [BOT]: receipt("clock-equal") } } } } };
  const realRecord = (mid, body, extra = {}) => ({ ...bridgeGroup.record, messageId: mid, text: body, rawText: body, ...extra });
  const oldEvidence = { offset: 7, done: true, published: 0, skipped: 7, duplicates: 0, reasons: {} };
  const evSource = await fixtureSource(evRoot, [bridgeGroup.record,
    realRecord("clock-equal", "我常用机械键盘。", { receivedAt: AT, processedAt: AT }),
    { ...fallback.record, text: "我喜欢铜版画", rawText: "我喜欢铜版画" },
    realRecord("botless", "我喜欢绘画", { logicalBotId: null }),
    realRecord("quote", "我喜欢钢琴", { quotedMessage: { ids: ["previous"] } }),
    realRecord("question", "我喜欢芭蕾吗？"), realRecord("joke", "我喜欢象棋。开玩笑"),
    realRecord("secret", "我常用密码 password123"), realRecord("third", "我妈喜欢国画"),
    realRecord("not-an-alias", "我叫他过来"),
    realRecord("peer", "我喜欢木工", { logicalBotId: PEER, accountId: "beta" }),
    realRecord("other-sender", "我喜欢盆栽", { senderId: OTHER }),
    realRecord("wrong-account", "我喜欢冲浪", { accountId: "unexpected" }),
    realRecord("fact-1", "我从事陶艺制作。"),
    realRecord("fact-2", "我从事陶艺制作。", { sentAt: "2026-10-02T00:00:00.000Z",
      time: "2026-10-02T00:00:00.000Z", sentAtMs: Date.parse("2026-10-02T00:00:00.000Z") }),
    realRecord("duplicate", "我喜欢茶"), realRecord("duplicate", "我不喜欢茶"),
    realRecord("oral", "比起数码我还是更喜欢胶片"),
    realRecord("oral-sanitized-mismatch", "我现在基本都拍胶片", { text: "我一直基本都拍胶片" }),
    ...Array.from({ length: 32 }, (_, i) => realRecord(`denied-${i}`, "最近天天在玩星露谷", { accountId: "unexpected" })),
    { ...bridgeGroup.record }]);
  const evFile = path.join(home, "archive-evidence", "memory.json");
  let evRuntime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: evFile }));
  await evRuntime.open(); await evRuntime.transact(draft => { draft.groups = evRoot.groups; });
  const newEvHost = () => createPeopleReconstructionHost({ getState: () => evRuntime.value,
    transact: build => evRuntime.transact(build), memoryHealth: healthy, source: evSource, now: () => NOW,
    eligible: tuple => eligible(tuple) && (tuple.mode !== "source" || tuple.accountId === (tuple.logicalBotId === BOT ? "alpha" : "beta")) });
  let evHost = newEvHost(); clients.add(evHost);
  try {
    await evHost.start({ authorized: true, id: "archive-evidence", publishVerified: true });
    const evScan = await finish(evHost);
    equal(evScan.reconstruction.stats.published, 0, "legacy source pass has no canonical candidates to publish");
    await rejects(evHost.publishArchiveEvidence({ expectedRevision: evScan.reconstruction.revision }), "UNAUTHORIZED");
    await rejects(evHost.publishArchiveEvidence({ authorized: true, expectedRevision: evScan.reconstruction.revision - 1 }), "REVISION_MISMATCH");
    await rejects(evHost.publishArchiveEvidence({ authorized: true, expectedRevision: evScan.reconstruction.revision,
      isCurrent: () => false }), "EVIDENCE_PUBLICATION_BLOCKED");
    await evRuntime.transact(draft => {
      const job = draft.peopleReconstruction, from = { phase: "memory", offset: 0, file: 0, byte: 0 };
      job.status = "paused"; job.pauseReason = "model_unknown";
      job.archiveSelfEvidence = structuredClone(oldEvidence);
      job.semanticStage = { cursor: from, maxCalls: 1, startAttempts: 0 };
      job.claim = { phase: "semantics", status: "unknown", startCursor: from, nextCursor: job.cursor, count: 1, calls: [] };
      job.revision++;
    });
    const unknownRevision = evRuntime.value.peopleReconstruction.revision;
    const unknownClaim = structuredClone(evRuntime.value.peopleReconstruction.claim);
    await rejects(evHost.publishArchiveEvidence({ authorized: true, expectedRevision: unknownRevision }), "EVIDENCE_PUBLICATION_BLOCKED");
    equal(evRuntime.value.peopleReconstruction.claim, unknownClaim, "3.7 evidence never overwrites a held semantic claim");
    await evHost.control({ authorized: true, expectedRevision: unknownRevision, operation: "skip_unknown" });
    const { revision: pausedRevision, budget: priorBudget, semanticStage: priorSemantic } = evHost.progress().reconstruction;
    const firstPage = await evHost.publishArchiveEvidence({ authorized: true, expectedRevision: pausedRevision });
    equal([firstPage.version, firstPage.offset, firstPage.done], [2, 32, false], "completed V1 cannot suppress a bounded V2 rescan");
    const preservedReceipts = structuredClone(evRuntime.value.peopleReconstruction.unknownBatches);
    await evHost.close(); await evRuntime.close();
    evRuntime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: evFile })); await evRuntime.open();
    evHost = newEvHost(); clients.add(evHost);
    let result;
    do { result = await evHost.publishArchiveEvidence({ authorized: true, expectedRevision: evHost.progress().reconstruction.revision }); }
    while (!result.ready || !result.done);
    equal([result.ready, result.done, result.published, result.skipped], [true, true, 7, 33],
      "archive pass publishes only exact, time-verified, current-scope self statements");
    const afterEvidence = evHost.progress().reconstruction;
    equal([afterEvidence.status, afterEvidence.unknownBatches, afterEvidence.budget, afterEvidence.semanticStage],
      ["paused", 1, priorBudget, priorSemantic], "archive publication never resumes semantics, alters budget or loses an unknown receipt");
    equal([afterEvidence.archiveSelfEvidence, evRuntime.value.peopleReconstruction.unknownBatches],
      [oldEvidence, preservedReceipts], "old evidence checkpoint and unknown receipts stay byte-for-byte intact");
    check(evHost.progress().source.archiveSelfEvidenceCoverage.recordReasons.SANITIZED_TEXT_MISMATCH === 1,
      "coverage reports sanitized and original text disagreement without disclosing either");
    equal(await evHost.publishArchiveEvidence({ authorized: true, expectedRevision: afterEvidence.revision }), result,
      "completed evidence operation is a read-only no-op on repeat");
    equal(evRuntime.value.peopleReconstruction.stats.modelAttempts, 0, "archive publication never enters semantic/model execution");
    await evHost.close(); await evRuntime.close();
    evRuntime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: evFile })); await evRuntime.open();
    equal(evRuntime.value.peopleReconstruction.archiveSelfEvidenceV2.published, 7, "evidence progress survives the same durable writer transaction and reopen");
    const args = { logicalBotId: BOT, userId: U, conversationId: `group:${G2}`, now: NOW, purpose: "understanding",
      sourceEligible: ({ conversationId }) => [`group:${G}`, `group:${G2}`].includes(conversationId) };
    const entries = extra => queryPersonMemory(evRuntime.value, { ...args, ...extra }).entries;
    equal(entries().map(e => e.value).sort(), ["从事陶艺制作", "喜欢摄影", "常用机械键盘", "比起数码还是更喜欢胶片"], "same Bot and QQ can understand exact time-qualified self reports across groups");
    check(entries().every(e => e.uncertain && e.scope === "self_reported_public" && e.firstSeenAt === Date.parse(AT) && e.confidence === 0.7),
      "retrieval keeps uncertainty, original time and self-report confidence");
    equal(entries({ purpose: "disclosure" }), [], "even two original dates cannot create cross-group disclosure authority");
    equal(entries({ conversationId: `private:${U}` }), [], "no group-to-private carryover");
    equal(entries({ sourceEligible: undefined }), [], "explicit runtime authorization is required, even for trusted archives");
    equal(entries({ sourceEligible: ({ conversationId }) => conversationId === `group:${G2}` }), [], "current access to the original group remains required");
    equal(entries({ sourceEligible: ({ conversationId }) => conversationId === `group:${G}` }), [], "current access to the destination group remains required");
    equal(entries({ sourceEligible: () => false, conversationId: `group:${G}`, purpose: "disclosure" }), [], "same-group profile reads also require current access");
    equal(entries({ logicalBotId: PEER }).map(e => e.value), ["喜欢木工"], "peer only sees its own historical source");
    equal(entries({ userId: OTHER }).map(e => e.value), ["喜欢盆栽"], "separate QQ only sees their own statement");
    await evRuntime.transact(draft => { draft.groups[G].users = { [U]: { canonicalMemory: { entries: [
      { status: "rejected", sourceMessageIds: ["bridge-group"] }] } } }; });
    equal(entries().map(e => e.value).sort(), ["从事陶艺制作", "常用机械键盘", "比起数码还是更喜欢胶片"], "a later canonical correction fences the exact archive source");
  } finally { await evHost.close(); await evRuntime.close(); }

  const enumeratedRoot = { groups: {
    [G]: { users: { [U]: { preferences: ["喜欢摄影"] } } },
    [`private:${U}:alpha`]: { users: { [U]: { canonicalMemory: { subjectUserId: U, entries: [
      canonical("喜欢摄影", "bridge-private", { sourceMessageIds: ["bridge-private", "uncovered"] })] } } } },
    [`private:${U}:group:family`]: { users: { [U]: { canonicalMemory: { subjectUserId: U, entries: [
      canonical("喜欢摄影", "bridge-failover")] } } } }
  } };
  const rootSource = await fixtureSource(enumeratedRoot), archiveRoot = path.join(path.dirname(rootSource.memoryFile), "archive-root");
  for (const item of [bridgeGroup, bridgePrivate, bridgeFailover]) {
    const relative = path.relative("/fixture/archive", item.file), file = path.join(archiveRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ...item.record, sourceTimeKnown: true }) + "\n");
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
  const duplicateSource = await fixtureSource(duplicateRoot, [originalRecord("same-message", "喜欢摄影", { accountId: "alpha", logicalBotId: BOT }),
    originalRecord("same-message", "不喜欢摄影", { accountId: "alpha", logicalBotId: BOT })]);
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
    canonical("不该猜时间", "bad-time"), canonical("喜欢街拍", "clock-unknown"), canonical("他喜欢数码", "third-person")];
  original.groups[G].users[OTHER] = { nickname: "相同昵称", profile: ["另一个QQ"] };
  original.groups[G2] = { users: { [U]: { profile: ["同一个QQ另一群"] } } };
  const records = [originalRecord("photo", "喜欢摄影"),
    originalRecord("coffee", "喜欢咖啡", { accountId: "alpha", logicalBotId: BOT,
      images: [{ description: "bounded match but large media metadata", file: "x".repeat(100000) }] }),
    originalRecord("tea-original-id", "喜欢茶"),
    originalRecord("shared", "不该借同名来源", { senderId: OTHER }),
    originalRecord("bad-time", "不该猜时间", { sentAtMs: Date.parse(AT) + 1 }),
    originalRecord("clock-unknown", "喜欢街拍", { logicalBotId: BOT, accountId: "alpha", sourceTimeKnown: false }),
    originalRecord("third-person", "他喜欢数码", { logicalBotId: BOT, accountId: "alpha", text: "他喜欢数码", rawText: "他喜欢数码" }),
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
  equal(classifyPeopleReconstructionRow(original, photo, { eligible, now: NOW }).reasons, ["ARCHIVE_OWNER_UNKNOWN"], "original group/QQ alone does not authenticate archive ownership");
  equal(classifyPeopleReconstructionRow(original, coffee, { eligible, now: NOW }).tier, "Verified", "actual bound archive receipt can recover canonical provenance");
  equal(photo.logicalBotId, null, "missing historical bot is never replaced by current account mapping");
  const tea = page.rows.find(r => r.value === "喜欢茶");
  equal(tea.sourceMessageIds, [], "matching words never create a message ID or source attribution for a legacy value");
  equal(classifyPeopleReconstructionRow(original, page.rows.find(r => r.value === "喜欢街拍"), { eligible, now: NOW }).reasons,
    ["ORIGINAL_TIME_UNVERIFIED"], "source time uncertainty is diagnosed rather than replaced");
  equal(classifyPeopleReconstructionRow(original, page.rows.find(r => r.value === "他喜欢数码"), { eligible, now: NOW }).tier,
    "Tentative", "raw equality cannot prove a publishable third-person claim");
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

  // 3.6 really produced a different digest for a value-only archive join.
  // Reproduce that exact shape without exposing a compatibility mode to callers.
  const legacyJoinRoot = rootWith(33, { receipts: false });
  const legacyJoinSource = await fixtureSource(legacyJoinRoot, [originalRecord("historical-m0", "喜欢项目0",
    { logicalBotId: BOT, accountId: "alpha" })]);
  const legacyJoinWorker = new PeopleReconstructionWorkerSource({ cacheDir: legacyJoinSource.cacheDir }); clients.add(legacyJoinWorker);
  await legacyJoinWorker.capture({ sourceId: "legacy-value-digest", memoryFile: legacyJoinSource.memoryFile, archives: legacyJoinSource.archives });
  while (legacyJoinWorker.status().phase !== "ready") await legacyJoinWorker.advance();
  const legacyJoinPage = await legacyJoinWorker.readPage({ sourceId: "legacy-value-digest",
    cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: 32 });
  const strictJoin = legacyJoinPage.rows[0];
  equal([strictJoin.logicalBotId, strictJoin.sourceMessageIds], [null, []], "strict page never associates an old value by content alone");
  const legacyJoinedSource = { messageId: "historical-m0", verifiedSenderId: U, conversationId: `group:${G}`,
    archiveConversationId: `group:${G}`, time: new Date(Date.parse(AT)).toISOString(), logicalBotId: BOT, accountId: "alpha",
    sourceTextDigest: createHash("sha256").update("我喜欢项目0").digest("hex"), via: "archive" };
  legacyJoinedSource.boundValueDigest = peopleReconstructionEvidenceBinding(strictJoin, legacyJoinedSource);
  const oldJoinRows = [{ ...strictJoin, logicalBotId: BOT, sourceMessageIds: ["historical-m0"],
    sources: [legacyJoinedSource], joinIncomplete: false }, ...legacyJoinPage.rows.slice(1)];
  check(digest(legacyJoinPage.rows) !== digest(oldJoinRows), "strict and historical digests are intentionally distinct");
  const legacyJoinProof = await legacyJoinWorker.recoverUnknownPages({ sourceId: "legacy-value-digest", ledgerBinding: "a".repeat(64),
    receipts: [{ receiptIndex: 0, receiptHash: "b".repeat(64), hash: digest(oldJoinRows), count: 32,
      scanned: legacyJoinPage.scanned, nextCursor: legacyJoinPage.nextCursor }] });
  equal(legacyJoinProof.receipts[0].status, "matched", "historical row encoding is used only to prove a legacy unknown exclusion");
  equal(legacyJoinProof.matches[0].candidateIds[0], classifyPeopleReconstructionRow(legacyJoinRoot, oldJoinRows[0], { eligible, now: NOW }).id,
    "recovery excludes the historically exposed ID, not a newly attributed candidate");
  await legacyJoinWorker.close();

  // Legacy UNKNOWN receipts have no startCursor. Reproduce the actual bounded
  // pager on a 4,500-entry fixture at offsets 34 / 3219 / 4408, then recover
  // exactly 96 IDs without quarantining all 4,408 earlier memory slots.
  {
  const unknownRoot = rootWith(4500, { receipts: false }), unknownSource = await fixtureSource(unknownRoot);
  const unknownSourceId = "unknown-page-fixture", unknownWorker = new PeopleReconstructionWorkerSource({ cacheDir: unknownSource.cacheDir });
  clients.add(unknownWorker);
  await unknownWorker.capture({ sourceId: unknownSourceId, memoryFile: unknownSource.memoryFile, archives: [] });
  while (unknownWorker.status().phase !== "ready") await unknownWorker.advance();
  const starts = [0, 3187, 4376], ends = [34, 3219, 4408], unknownPages = [];
  for (let i = 0; i < starts.length; i++) {
    const page = await unknownWorker.readPage({ sourceId: unknownSourceId,
      cursor: { phase: "memory", offset: starts[i], file: 0, byte: 0 }, limit: 32 });
    equal([page.rows.length, page.scanned, page.nextCursor.offset], [32, 32, ends[i]], "synthetic source reproduces a legacy unknown page's exact pager shape");
    unknownPages.push(page);
  }
  const unknownIds = new Set(unknownPages.flatMap(p => p.rows.map(row => classifyPeopleReconstructionRow(unknownRoot, row, { eligible, now: NOW }).id)));
  const unknownJob = createPeopleReconstructionState({ id: "legacy-unknown-pages", sourceId: unknownSourceId,
    maxCalls: 1000, maxTokens: 16384000, maxTokensPerCall: 16384 });
  unknownJob.host = { version: 1, continueScanOnUnknown: true };
  unknownJob.unknownBatches = unknownPages.map((p, i) => ({ id: `unknown-${i}`, status: "unknown", hash: digest(p.rows),
    count: 32, scanned: 32, nextCursor: p.nextCursor, modelStarted: true, calls: [{ id: `legacy-call-${i}`, usageSettled: true }] }));
  let unknownCursor = { phase: "memory", offset: 0, file: 0, byte: 0 };
  for (let n = 0; unknownCursor.phase !== "done"; n++) {
    assert.ok(n < 160, "fixture setup is bounded");
    const page = await unknownWorker.readPage({ sourceId: unknownSourceId, cursor: unknownCursor, limit: 32 });
    for (const row of page.rows) {
      const c = classifyPeopleReconstructionRow(unknownRoot, row, { eligible, now: NOW });
      if (unknownIds.has(c.id)) continue; // Original failed pages were never ACKed.
      unknownJob.candidates[c.id] = c; unknownJob.candidateCount++; unknownJob.stats.tiers[c.tier]++;
    }
    unknownCursor = page.nextCursor;
  }
  Object.assign(unknownJob, { status: "completed_with_limits", cursor: unknownCursor, scanOnly: true });
  Object.assign(unknownJob.stats, { scanned: 4500, committedRows: 4404, skippedUnknown: 96,
    semanticSkipped: 4404, modelAttempts: 3, unknownCalls: 3, reservedTokens: 49152, unattributed: 4404 });
  unknownRoot.peopleReconstruction = unknownJob;
  await unknownWorker.close();
  const unknownH = harness(unknownRoot), beforeRecovery = JSON.stringify([unknownJob.unknownBatches, unknownJob.stats, unknownJob.budget]);
  const beforeRecoveryPlan = summarizePeopleReconstructionSemanticsPage(unknownH.getState(), [], { eligible, now: NOW });
  equal(beforeRecoveryPlan.excludedPrefixThrough.offset, 4408, "unproven old pages initially retain the conservative 4408-slot fence");
  let recoveryWritable = false, recoveryCalls = 0;
  const recoveryHost = makeHost(unknownH, unknownSource, { ...modelOptions(async args => {
    recoveryCalls++; const payload = JSON.parse(args.prompt.split("\n").at(-1));
    return { groups: payload.candidates.map(c => ({ ids: [c.id], summary: c.value })), usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  }), memoryHealth: () => recoveryWritable ? healthy() : { writable: false, recoveryRequired: true } });
  const recoveryRevision = unknownJob.revision, recoveryTransactions = unknownH.transactions();
  await rejects(recoveryHost.adoptUnknownRecovery({ authorized: true, expectedRevision: recoveryRevision,
    proof: { done: true, matches: [{ candidateIds: ["external-untrusted-ID"] }] } }), "RECOVERY_DRY_RUN_REQUIRED");
  await rejects(recoveryHost.dryRunUnknownRecovery({ authorized: false, expectedRevision: recoveryRevision }), "UNAUTHORIZED");
  await rejects(recoveryHost.dryRunUnknownRecovery({ authorized: true, expectedRevision: recoveryRevision + 1 }), "REVISION_MISMATCH");
  let recovered;
  for (let n = 0; n < 160; n++) {
    recovered = await recoveryHost.dryRunUnknownRecovery({ authorized: true, expectedRevision: recoveryRevision });
    if (recovered.done) break;
  }
  equal([recovered.done, recovered.matchedBatches, recovered.matchedRows, recovered.unresolvedBatches], [true, 3, 96, 0],
    "read-only source worker proves all three old pages rather than guessing their starts");
  equal([unknownH.transactions(), recoveryCalls], [recoveryTransactions, 0], "bounded proof search works with a read-only writer and makes no transaction/model call");
  check(!JSON.stringify(recovered).includes("喜欢") && !JSON.stringify(recovered).includes("candidateIds") && !JSON.stringify(recovered).includes(home),
    "public recovery dry-run exposes only hashes, counts and reproducible cursors, never source bodies or arbitrary ID lists");
  check(recovered.receipts.every(r => r.attempts <= 512 && r.status === "matched" && r.candidateSetDigest), "each receipt has a finite search and ID-set commitment");
  await rejects(recoveryHost.adoptUnknownRecovery({ authorized: true, expectedRevision: recoveryRevision }), "MEMORY_UNAVAILABLE");
  recoveryWritable = true;
  const adoptedRecovery = await recoveryHost.adoptUnknownRecovery({ authorized: true, expectedRevision: recoveryRevision,
    proof: { done: true, matches: [] } }); // External packet is deliberately ignored.
  equal([adoptedRecovery.verifiedBatches, adoptedRecovery.verifiedRows, adoptedRecovery.excludedPrefixThrough.offset], [3, 96, 0],
    "only the host's own worker packet can relax the prefix; caller-supplied proof is not accepted");
  const persistedUnknown = unknownH.getState().peopleReconstruction;
  equal(new Set(persistedUnknown.unknownPageRecovery.matches.flatMap(m => m.candidateIds)), unknownIds,
    "adopted exclusion IDs are exactly the source worker's 96 unknown rows");
  equal(JSON.stringify([persistedUnknown.unknownBatches, persistedUnknown.stats, persistedUnknown.budget]), beforeRecovery,
    "writer adoption changes only additive proof metadata, not old receipts/costs/budgets");
  await recoveryHost.initialize(); await recoveryHost.tick();
  equal(recoveryCalls, 0, "adopting proof does not automatically start semantic spending");
  await recoveryHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: recoveryHost.progress().reconstruction.revision });
  await recoveryHost.tick(); // Proven unknown page: excluded without a model.
  equal(recoveryCalls, 0, "proven original unknown page is never replayed through the model");
  await recoveryHost.tick(); // First formerly over-quarantined, actually pending page.
  equal([recoveryCalls, recoveryHost.progress().reconstruction.semanticStage.processed], [0, 0],
    "unquarantined candidates without evidence still cost zero model calls");
  check(Object.values(unknownH.getState().peopleReconstruction.candidates).every(c => !c.semantic),
    "proof recovery never upgrades evidence or imports original unknown IDs");
  await recoveryHost.close();

  // Corrupt the last receipt's hash in a separate fixture copy. Searching every
  // allowed start is finite; unproved page still imposes its original floor.
  const tamperedRoot = structuredClone(unknownRoot); tamperedRoot.peopleReconstruction.unknownBatches[2].hash = "f".repeat(64);
  const tamperedH = harness(tamperedRoot), tamperedHost = makeHost(tamperedH, unknownSource);
  let failedRecovery, priorAttempts = 0;
  for (let n = 0; n < 160; n++) {
    failedRecovery = await tamperedHost.dryRunUnknownRecovery({ authorized: true, expectedRevision: 0 });
    if (failedRecovery.ready) {
      const attempts = failedRecovery.receipts.reduce((n, r) => n + r.attempts, 0);
      check(attempts - priorAttempts <= H.unknownStartsPerStep, "one recovery request tests at most four candidate starts"); priorAttempts = attempts;
    }
    if (failedRecovery.done) break;
  }
  equal([failedRecovery.done, failedRecovery.matchedBatches, failedRecovery.receipts[2].status, failedRecovery.receipts[2].attempts],
    [true, 2, "unmatched", 512], "hash corruption cannot be rescued by cursor/count arithmetic or an unbounded search");
  const partialRecovery = await tamperedHost.adoptUnknownRecovery({ authorized: true, expectedRevision: 0 });
  equal([partialRecovery.verifiedRows, partialRecovery.excludedPrefixThrough.offset], [64, 4408],
    "unverified last unknown page keeps its full conservative floor even after two pages are proved");
  await rejects(tamperedHost.adoptUnknownRecovery({ authorized: true, expectedRevision: 0 }), "REVISION_MISMATCH");
  await tamperedHost.close();
  }

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
  const modelRoot = analysisRoot(70);
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
  }, () => ({ remainingCalls: remaining, remainingTokens: 32768, maxTokensPerCall: 16384 })));
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

  const staleRoot = analysisRoot(2), staleH = harness(staleRoot), staleSource = await fixtureSource(staleRoot);
  const livePin = { id: "text-only", revision: 1 }; let staleCalls = 0;
  const staleHost = makeHost(staleH, staleSource, {
    budget: () => ({ remainingCalls: 2, remainingTokens: 100000, maxTokensPerCall: 16384 }),
    captureBinding: () => livePin, bindingCurrent: pin => pin.revision === livePin.revision,
    reconstruct: async args => {
      fakeModels++; staleCalls++;
      const candidateId = JSON.parse(args.prompt.split("\n").at(-1)).candidates[0].id;
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

  // Post-scan semantics, compact real callback format, and dry-run before host
  // initialization. Cache reads are isolated; no new writer or model is used
  // by preflight, including when the live writer is read-only.
  const semanticRoot = analysisRoot(9);
  semanticRoot.groups[G2] = { users: { [U]: { preferences: ["另一群独立偏好"] } } };
  semanticRoot.groups[G].users[OTHER] = { preferences: ["同名但另一QQ"] };
  semanticRoot.groups[`private:${U}:alpha`] = { users: { [U]: { preferences: [PRIVATE] } } };
  semanticRoot.groups[G].users[U].canonicalMemory.entries.push(canonical("密码: synthetic-password", "unsafe"));
  const semanticSource = await fixtureSource(semanticRoot), semanticH = harness(semanticRoot);
  const scanning = makeHost(semanticH, semanticSource);
  await scanning.start({ authorized: true, id: "post-scan-host" }); await finish(scanning); await scanning.close();
  // This legacy fixture has no model budget. Continuation cannot increase it.
  const semanticSeen = [], immutablePin = { id: "selected-custom-direct", revision: 1 };
  const semanticOptions = modelOptions(async args => {
    const payload = JSON.parse(args.prompt.split("\n").at(-1));
    semanticSeen.push(payload);
    check(payload.candidates.length <= 16, "post-scan gateway has a bounded sixteen-representative batch");
    check(payload.candidates.every(c => /^c\d+$/.test(c.id)), "local aliases replace long candidate hashes in model input");
    check(!args.prompt.includes(PRIVATE) && !args.prompt.includes("synthetic-password") && !args.prompt.includes("recon_"), "private, unsafe and redundant full-ID content is excluded");
    check(Buffer.byteLength(args.prompt) + args.maxTokens + H.framingTokenReserve <= 16384 && args.maxTokens <= 8192,
      "output cap and conservative input envelope fit the unchanged per-call reserve");
    equal(payload.scope, args.scope, "one scope is explicit in the compact model payload");
    return { groups: payload.candidates.map(c => ({ ids: [c.id], summary: `${c.value}\n`, tier: "Verified",
      logicalBotId: BOT, sourceMessageIds: ["invented"] })), usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  });
  semanticOptions.captureBinding = () => immutablePin;
  semanticOptions.bindingCurrent = pin => pin.id === immutablePin.id && pin.revision === immutablePin.revision;
  const readonlyPreview = makeHost(semanticH, semanticSource, { ...semanticOptions,
    memoryHealth: () => ({ writable: false, recoveryRequired: true }) });
  const transactionsBeforePreview = semanticH.transactions(), revision = semanticH.getState().peopleReconstruction.revision;
  await rejects(readonlyPreview.dryRunSemantics({ authorized: false, expectedRevision: revision }), "UNAUTHORIZED");
  await rejects(readonlyPreview.dryRunSemantics({ authorized: true, expectedRevision: revision - 1 }), "REVISION_MISMATCH");
  let dry;
  for (let n = 0; n < 20; n++) {
    dry = await readonlyPreview.dryRunSemantics({ authorized: true, expectedRevision: revision });
    if (dry.ready) break;
  }
  check(dry.ready && dry.pending >= 9, "read-only preflight can inspect existing pinned candidates without opening a writer");
  equal([semanticH.transactions(), semanticSeen.length], [transactionsBeforePreview, 0], "preflight does not initialize/recover a job, transact, or call a model");
  check(!JSON.stringify(dry).includes("喜欢") && !JSON.stringify(dry).includes(home), "dry-run output contains counts/cursors only, not source values or paths");
  await readonlyPreview.close();
  let semanticHost = makeHost(semanticH, semanticSource, semanticOptions);
  await semanticHost.initialize();
  await rejects(semanticHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: semanticHost.progress().reconstruction.revision }), "SEMANTIC_RESUME_BLOCKED");
  equal(semanticHost.progress().reconstruction.budget.maxCalls, 0, "post-scan continuation cannot silently raise a zero-call budget");
  await semanticHost.close();

  const boundedH = harness(semanticRoot), boundedSource = await fixtureSource(semanticRoot);
  semanticHost = makeHost(boundedH, boundedSource, semanticOptions);
  await semanticHost.start({ authorized: true, id: "budgeted-post-scan" });
  await semanticHost.control({ authorized: true, operation: "scan_only", expectedRevision: semanticHost.progress().reconstruction.revision });
  await finish(semanticHost);
  const boundedScan = semanticHost.progress().reconstruction;
  await semanticHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: boundedScan.revision });
  await semanticHost.tick();
  equal([semanticSeen.length, semanticHost.progress().reconstruction.status, semanticHost.progress().reconstruction.pauseReason],
    [1, "paused", "semantic_run_limit"], "one explicit grant makes exactly one call then pauses");
  await semanticHost.close();
  semanticHost = makeHost(boundedH, boundedSource, semanticOptions);
  await semanticHost.initialize(); await semanticHost.tick();
  equal(semanticSeen.length, 1, "cache/runtime restart does not continue a semantic run-limit pause");
  await semanticHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: semanticHost.progress().reconstruction.revision, maxSemanticCalls: 10 });
  await finish(semanticHost);
  const semanticDone = semanticHost.progress().reconstruction;
  const candidateKeys = Object.values(boundedH.getState().peopleReconstruction.candidates);
  equal([semanticDone.semanticStage.processed, semanticDone.semanticStage.proposed], [9, 9], "verified candidates get proposals; unsupported other groups and QQ do not");
  equal(new Set(semanticSeen.flatMap(p => p.candidates.map(c => `${JSON.stringify(p.scope)}:${c.value}`))).size, 9,
    "post-scan source page revisits never repay for already attempted candidate IDs");
  equal([semanticDone.stats.scanned, semanticDone.candidates, semanticDone.stats.published],
    [boundedScan.stats.scanned, boundedScan.candidates, 0], "semantic pass neither rescans source totals nor publishes to peopleMemory");
  check(candidateKeys.filter(c => c.semantic).every(c => c.semantic.proposalOnly && c.kind === "quote"
    && c.tier === "Verified"), "semantic proposals never change original proof or promote quotes");
  await semanticHost.close();

  // Worst-case bounded source metadata makes a 16-item request too large.
  // The host splits before model invocation, not after a paid rejection.
  const wideRoot = analysisRoot(17);
  const wideGroup = wideRoot.groups[G]; wideGroup.peopleSourceIndex = {};
  for (let i = 0; i < 17; i++) {
    const entry = wideGroup.users[U].canonicalMemory.entries[i];
    entry.value = `喜欢${"摄影".repeat(90)}项目${i}`;
    entry.sourceMessageIds = []; entry.evidenceKeys = [];
    for (let j = 0; j < 16; j++) {
      const mid = `wide-${i}-${j}-${"x".repeat(95)}`;
      entry.sourceMessageIds.push(mid); entry.evidenceKeys.push(JSON.stringify([G, mid]));
      wideGroup.peopleSourceIndex[mid] = { [BOT]: receipt(mid) };
    }
  }
  const wideH = harness(wideRoot), wideSource = await fixtureSource(wideRoot); let adaptiveSize = 0;
  const wideHost = makeHost(wideH, wideSource, modelOptions(async args => {
    const payload = JSON.parse(args.prompt.split("\n").at(-1)); adaptiveSize = payload.candidates.length;
    check(adaptiveSize > 0 && adaptiveSize < 16, "large source metadata adaptively reduces batch before a paid call");
    check(Buffer.byteLength(args.prompt) <= H.promptBytes && args.maxTokens >= adaptiveSize * 256,
      "adaptive batch has room for valid compact structured output within fixed byte/token envelope");
    check(payload.candidates.every(c => c.sources.length === 16 && c.sources.every(([, at]) => at === AT)),
      "adaptation never drops or invents original source IDs/times to fit the budget");
    return { groups: payload.candidates.map(c => ({ ids: [c.id], summary: "仅为原偏好的语义提案" })),
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  }));
  await wideHost.start({ authorized: true, id: "adaptive-envelope" });
  await wideHost.control({ authorized: true, operation: "scan_only", expectedRevision: wideHost.progress().reconstruction.revision });
  await finish(wideHost);
  await wideHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: wideHost.progress().reconstruction.revision });
  await wideHost.tick();
  equal(wideHost.progress().reconstruction.semanticStage.processed, adaptiveSize, "remaining rows are not swallowed by adaptive truncation");
  equal(wideHost.progress().reconstruction.status, "paused", "one-call adaptive grant pauses with remaining candidates explicit");
  await wideHost.close();

  // Actual cooperating MemoryRuntime persists proposals + semantic checkpoint
  // in one writer, and reopening it does not call the injected fake model.
  const semanticDurableFile = path.join(home, "semantic-durable", "memory.json");
  let semanticRuntime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: semanticDurableFile }));
  await semanticRuntime.open(); let durableSemanticHost, durableModelCalls = 0;
  try {
    await semanticRuntime.transact(root => Object.assign(root, analysisRoot(5)));
    const durableSource = { cacheDir: path.join(home, "semantic-durable", "cache"), memoryFile: semanticDurableFile, archives: [] };
    const durableOptions = modelOptions(async args => {
      durableModelCalls++;
      const payload = JSON.parse(args.prompt.split("\n").at(-1));
      return { groups: payload.candidates.map(c => ({ ids: [c.id], summary: c.value })), usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
    });
    const newDurableHost = () => createPeopleReconstructionHost({ getState: () => semanticRuntime.value,
      transact: build => semanticRuntime.transact(build), getRevision: () => semanticRuntime.revision,
      memoryHealth: () => semanticRuntime.status(), source: durableSource, eligible, now: () => NOW, ...durableOptions });
    durableSemanticHost = newDurableHost(); clients.add(durableSemanticHost);
    await durableSemanticHost.start({ authorized: true, id: "semantic-single-writer" });
    await durableSemanticHost.control({ authorized: true, operation: "scan_only", expectedRevision: durableSemanticHost.progress().reconstruction.revision });
    await finish(durableSemanticHost);
    await durableSemanticHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: durableSemanticHost.progress().reconstruction.revision });
    await durableSemanticHost.tick();
    check(semanticRuntime.status().writer, "original repository writer owns semantic publication");
    await durableSemanticHost.close(); await semanticRuntime.close();
    semanticRuntime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: semanticDurableFile })); await semanticRuntime.open();
    durableSemanticHost = newDurableHost(); clients.add(durableSemanticHost); await durableSemanticHost.initialize(); await durableSemanticHost.tick();
    equal([durableModelCalls, semanticRuntime.value.peopleReconstruction.semanticStage.processed], [1, 5],
      "actual journal reopen preserves semantic results and does not replay paid work");
    check(Object.values(semanticRuntime.value.peopleReconstruction.candidates).every(c => c.semantic?.proposalOnly && c.kind === "quote"),
      "durable semantic proposals do not promote a verified quote to a publishable fact");
  } finally { await durableSemanticHost?.close(); await semanticRuntime.close(); }

  // Binding change after a post-scan call must pause with an unknown receipt;
  // continueScanOnUnknown applies to scanning only, never this semantic stage.
  const bindingH = harness(analysisRoot(2)), bindingSource = await fixtureSource(analysisRoot(2));
  let bindingVersion = 1, bindingCalls = 0;
  const bindingHost = makeHost(bindingH, bindingSource, { ...modelOptions(async args => {
    bindingCalls++; bindingVersion++;
    const payload = JSON.parse(args.prompt.split("\n").at(-1));
    return { groups: [{ ids: [payload.candidates[0].id], summary: "stale" }], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  }), captureBinding: () => ({ id: "selected", revision: bindingVersion }), bindingCurrent: pin => pin.revision === bindingVersion });
  await bindingHost.start({ authorized: true, id: "post-scan-binding" });
  await bindingHost.control({ authorized: true, operation: "scan_only", expectedRevision: bindingHost.progress().reconstruction.revision });
  await finish(bindingHost);
  await bindingHost.control({ authorized: true, operation: "resume_semantics", expectedRevision: bindingHost.progress().reconstruction.revision });
  await bindingHost.tick(); await bindingHost.tick();
  equal([bindingCalls, bindingHost.progress().reconstruction.status, bindingHost.progress().reconstruction.claim.status],
    [1, "paused", "unknown"], "post-call binding change is fenced and never auto-skipped or replayed");
  equal(bindingHost.progress().reconstruction.stats.usage.totalTokens, 25, "discarded semantic call retains actual usage");
  check(Object.values(bindingH.getState().peopleReconstruction.candidates).every(c => !c.semantic), "stale binding never contributes a proposal");
  await bindingHost.close();

  // Supported projection: same group, real QQ, no experience/disclosure grant.
  const projectionRoot = { groups: { [G]: { users: { [U]: { canonicalMemory: { subjectUserId: U, entries: [
    canonical("喜欢摄影", "real-evidence", { sourceMessageIds: ["real-evidence", "uncovered"] })] } } } } } };
  const projectionSource = await fixtureSource(projectionRoot, [originalRecord("real-evidence", "喜欢摄影", { accountId: "alpha", logicalBotId: BOT })]);
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
  const unknownRoot = analysisRoot(75), unknownSource = await fixtureSource(unknownRoot), uh = harness(unknownRoot);
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
  const missingRoot = analysisRoot(40), missingH = harness(missingRoot), missingSource = await fixtureSource(missingRoot);
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
