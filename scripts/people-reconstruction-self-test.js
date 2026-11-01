import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { administerPersonMemory, recordPersonEvidence, queryPersonMemory } from "../src/people-memory.js";
import {
  PEOPLE_RECONSTRUCTION_LIMITS as LIMITS,
  createPeopleReconstructionState, createPeopleReconstructionPager,
  createPeopleReconstructionRunner, classifyPeopleReconstructionRow,
  summarizePeopleReconstructionPage,
  validatePeopleReconstructionSemantics, controlPeopleReconstruction,
  queryPeopleReconstructionCandidates, peopleReconstructionStatus
} from "../src/people-memory-reconstruction.js";

// ALL source/state files are synthetic and under this newly-created directory.
// No bridge import, live config/memory, QQ, external model, service or network.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-people-reconstruction-"));
const NOW = Date.parse("2026-10-30T10:00:00Z");
const AT = "2026-10-01T10:00:00Z";
const U = "50001", OTHER = "50002", G = "10001", G2 = "10002";
const BOT = "account:alpha", PEER = "account:beta";
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const rejected = async (operation, code) => { await assert.rejects(operation, { code }); checks++; };
const eligible = tuple => tuple.logicalBotId === null || [BOT, PEER].includes(tuple.logicalBotId);
const source = (extra = {}) => ({ messageId: "m1", logicalBotId: BOT, accountId: "alpha",
  verifiedSenderId: U, conversationId: `group:${G}`, time: AT, via: "receipt", ...extra });
const row = (extra = {}) => ({ key: "fixture", origin: "canonical", jobKey: G, userId: U,
  logicalBotId: BOT, kind: "preference", value: "喜欢咖啡", status: "active", confidence: 0.9,
  sourceMessageIds: ["m1"], evidenceKeys: [JSON.stringify([G, "m1"])],
  extractionSource: "ai-extraction", sources: [source()], ...extra });
const classify = (r, root = { groups: {} }) => classifyPeopleReconstructionRow(root, r, { now: NOW, eligible });

function harness(initial = { groups: {} }) {
  let live = structuredClone(initial), durable = structuredClone(initial), tail = Promise.resolve();
  let fault = null;
  const history = [];
  return {
    getState: () => live, durable: () => structuredClone(durable), history,
    fault: (phase, when = () => true) => { fault = { phase, when }; },
    transact(build) {
      const action = tail.then(async () => {
        const draft = structuredClone(live);
        const result = build(draft);
        assert.ok(!result?.then, "transaction builder is synchronous");
        const inject = fault?.when(draft) ? fault.phase : null;
        if (inject === "before") { fault = null; throw new Error("fixture persistence failure"); }
        durable = structuredClone(draft);
        history.push(structuredClone(draft.peopleReconstruction));
        if (inject === "after") { fault = null; throw new Error("fixture lost durable ACK"); }
        live = structuredClone(draft);
        return result;
      });
      tail = action.catch(() => {});
      return action;
    }
  };
}
const onePage = rows => async ({ sourceId }) => ({ sourceId, rows: structuredClone(rows),
  nextCursor: { phase: "done", offset: rows.length, file: 0, byte: 0 } });
function runnerFor(h, options = {}) {
  return createPeopleReconstructionRunner({ getState: h.getState, transact: h.transact.bind(h),
    readPage: onePage([row()]), eligible, now: () => NOW, ...options });
}
async function start(runner, options = {}) {
  await runner.recover();
  await runner.start({ authorized: true, id: "test-job", sourceId: "fixture-v1", ...options });
}
const usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };

try {
  // Pure provenance tiers, not AI confidence or nicknames.
  equal(classify(row()).tier, "Verified", "exact canonical receipts recover original ownership");
  equal(classify(row({ sources: [], logicalBotId: null })).tier, "Tentative", "source-less canonical stays tentative");
  const unknown = row({ key: "unowned", logicalBotId: null, evidenceKeys: [],
    sources: [source({ logicalBotId: null, accountId: null, via: "archive", text: "我喜欢咖啡" })] });
  const supported = classify(unknown);
  equal([supported.tier, supported.logicalBotId, supported.experience], ["Supported", null, false], "QQ + original group is supported, not fabricated bot experience");
  equal(classify(row({ logicalBotId: PEER })).tier, "Conflicted", "cannot borrow another bot's receipt");
  equal(classify(row({ sources: [source({ verifiedSenderId: OTHER })] })).tier, "Conflicted", "same-name other QQ cannot supply evidence");
  equal(classify(row({ sources: [source({ time: "2027-01-01T00:00:00Z" })] })).tier, "Conflicted", "future sources rejected");
  equal(classify(row({ sourceMessageIds: ["m1", "m2"] })).tier, "Supported", "partial receipt cannot become Verified");
  equal(classify(row({ negative: true })).tier, "Suppressed", "negative record wins");
  equal(classify(row({ corrected: true, sourceIssue: true })).tier, "Suppressed", "correction wins even over invalid evidence");
  equal(classify(row({ value: "密码:secret123" })).value, null, "sensitive claim is not retained");
  equal(classify(row({ jobKey: `private:${U}`, logicalBotId: null })).tier, "Suppressed", "ownerless private evidence never enters candidates/model");
  equal(classify(row({ jobKey: `private:${U}:beta` })).tier, "Suppressed", "private suffix must match exact logical owner");
  check(!classify(row({ origin: "legacy" })).experience, "legacy portrait never becomes personal experience");
  const immutable = { groups: {}, unrelated: {} };
  Object.defineProperty(immutable.unrelated, "doNotScan", { get() { throw new Error("unrelated global read"); } });
  equal(classify(row(), immutable).tier, "Verified", "classification does not traverse unrelated root");
  const dryRoot = { groups: {} }, dryBefore = structuredClone(dryRoot);
  const dry = summarizePeopleReconstructionPage(dryRoot, [row(), unknown], { now: NOW, eligible });
  equal(dryRoot, dryBefore, "safe dry-run statistics do not initialize jobs or touch snapshot state");
  equal([dry.modelCalls, dry.people, dry.tiers.Verified, dry.tiers.Supported], [0, 1, 1, 1], "dry-run statistics need no live writer/model");

  // Model only proposes semantics and can only lower certainty by flagging conflict.
  const a = classify(row()), b = classify(row({ key: "second", value: "偏爱咖啡" }));
  const semantic = validatePeopleReconstructionSemantics({ groups: [{ ids: [a.id, b.id], summary: "偏爱咖啡", tier: "Verified", logicalBotId: PEER }] }, [a, b]);
  equal([semantic[0].proposalOnly, semantic[0].evidence], [true, false], "model cannot claim authority or improve provenance");
  assert.throws(() => validatePeopleReconstructionSemantics({ groups: [{ ids: [a.id, "invented"], summary: "捏造" }] }, [a]), { code: "MODEL_UNPINNED_ID" }); checks++;
  const otherQQ = classify(row({ key: "other-user", userId: OTHER, sources: [source({ verifiedSenderId: OTHER })] }));
  assert.throws(() => validatePeopleReconstructionSemantics({ groups: [{ ids: [a.id, otherQQ.id], summary: "同名合并" }] }, [a, otherQQ]), { code: "MODEL_SCOPE_CROSSING" }); checks++;
  const otherBot = classify(row({ key: "other-bot", logicalBotId: PEER, sources: [source({ logicalBotId: PEER, accountId: "beta" })] }));
  assert.throws(() => validatePeopleReconstructionSemantics({ groups: [{ ids: [a.id, otherBot.id], summary: "共享经历" }] }, [a, otherBot]), { code: "MODEL_SCOPE_CROSSING" }); checks++;
  const privateRow = row({ key: "private", jobKey: `private:${U}:alpha`,
    evidenceKeys: [JSON.stringify([`private:${U}:alpha`, "m1"])],
    sources: [source({ conversationId: `private:${U}` })] });
  const privateCandidate = classify(privateRow);
  equal(privateCandidate.tier, "Verified", "exact private owner tuple stays private");
  assert.throws(() => validatePeopleReconstructionSemantics({ groups: [{ ids: [a.id, privateCandidate.id], summary: "公开私聊" }] },
    [a, privateCandidate]), { code: "MODEL_SCOPE_CROSSING" }); checks++;

  // Real canonical/legacy/JSONL source shapes; no invented fixtures-as-results.
  const canonical = (value, mid, extra = {}) => ({ id: `mem_${mid}`, subjectUserId: U,
    kind: "preference", value, status: "active", confidence: 0.9, source: "ai-extraction",
    sourceMessageIds: [mid], evidenceKeys: [JSON.stringify([G, mid])], ...extra });
  const snapshot = { groups: {
    [G]: { users: {
      [U]: { nickname: "同名", profile: ["爱好摄影"], summary: "这是一份旧摘要",
        canonicalMemory: { subjectUserId: U, entries: [canonical("喜欢咖啡", "m1"),
          canonical("喜欢摄影", "m2"), canonical("喜欢茶", "m3"),
          canonical("尚无来源", "missing"), canonical("矛盾偏好", "m4", { conflictsWith: ["old"] })] } },
      [OTHER]: { nickname: "同名", preferences: ["喜欢散步"] }
    }, peopleSourceIndex: { m1: { [BOT]: source() } } },
    [G2]: { users: { [U]: { nickname: "改了昵称", preferences: ["喜欢跑步"] } } },
    "10003": { users: { [OTHER]: { profile: ["不可复活"], canonicalMemory: { subjectUserId: OTHER,
      entries: [{ id: "revoked", subjectUserId: OTHER, kind: "profile", value: "不可复活", status: "rejected" }] } } } }
  } };
  const archiveFile = path.join(home, "group.jsonl");
  const archiveRecords = [
    { type: "user_message", conversationId: `group:${G}`, messageId: "m2", senderId: U, text: "我喜欢摄影", time: AT },
    { type: "user_message", conversationId: `group:${G}`, messageId: "m3", senderId: U, text: "我喜欢茶", time: AT, accountId: "alpha", logicalBotId: BOT },
    { type: "bot_reply", conversationId: `group:${G}`, senderId: U, text: "机器人说的不能当成人的事实", time: AT },
    { type: "summary", conversationId: `group:${G}`, text: "群摘要不是人物证据" }
  ];
  await fs.writeFile(archiveFile, archiveRecords.map(r => JSON.stringify(r)).join("\n") + "\n{invalid json}\n");
  const stat = await fs.stat(archiveFile);
  const manifest = [{ id: "group-fixture", path: archiveFile, conversationId: `group:${G}`, size: stat.size, ino: stat.ino }];
  const pager = createPeopleReconstructionPager({ memory: snapshot, archives: manifest, sourceId: "fixture-v1" });
  const h = harness(snapshot), observedModels = [];
  const r = runnerFor(h, { readPage: pager.readPage, model: async args => {
    const persisted = h.durable().peopleReconstruction;
    check(persisted.claim.modelStarted && persisted.claim.id === args.claimId, "model sees durable claim + reservation first");
    check(persisted.claim.calls.some(c => c.id === args.attemptId), "every isolated sub-call has its own durable attempt claim");
    equal(new Set(args.candidates.map(c => JSON.stringify([c.userId, c.logicalBotId, c.conversationId]))).size, 1,
      "model input never mixes QQ, private/group conversations or independent bots");
    check(args.candidates.every(c => c.tier !== "Suppressed"), "suppressed content never reaches model");
    observedModels.push(args.candidates);
    return { groups: args.candidates.map(c => ({ ids: [c.id], summary: c.value, tier: "Verified" })), usage };
  } });
  await start(r);
  for (let n = 0; n < 30 && r.status().status === "running"; n++) await r.step();
  const status = r.status(), candidates = Object.values(h.getState().peopleReconstruction.candidates);
  equal(status.status, "completed_with_limits", "incomplete provenance is not reported as full recovery");
  equal(status.stats.people, 2, "same QQ across groups is one actual person, same name different QQ is two");
  check(candidates.some(c => c.value === "喜欢咖啡" && c.tier === "Verified" && c.logicalBotId === BOT), "real canonical source index scanned");
  const recoveredUnknown = candidates.find(c => c.value === "喜欢摄影");
  equal([recoveredUnknown.tier, recoveredUnknown.logicalBotId, recoveredUnknown.experience], ["Supported", null, false], "archive joins recover bot-less original group support");
  check(candidates.some(c => c.value === "喜欢茶" && c.logicalBotId === BOT && c.tier === "Verified"), "archive tuple recovers actual bot only");
  check(candidates.some(c => c.origin === "legacy" && c.value === "这是一份旧摘要" && c.tier === "Tentative"), "legacy summary actually scanned, never promoted by model");
  check(candidates.filter(c => c.conversationId === "group:10003").every(c => c.tier === "Suppressed"), "canonical negative suppresses raw legacy mirrors");
  check(candidates.some(c => c.tier === "Conflicted"), "canonical conflicts retained");
  equal(h.getState().groups, snapshot.groups, "original memory and provenance untouched");
  equal(status.stats.usage.totalTokens, observedModels.length * usage.totalTokens, "provider usage summed, never estimated");
  check(!JSON.stringify(status).includes("喜欢咖啡") && !JSON.stringify(status).includes(archiveFile), "status excludes source text and file paths");
  equal(status.stats.scanned, 16, "scan count includes raw JSONL records once, not model/bot copies");

  const lookup = (candidate, extra = {}) => queryPeopleReconstructionCandidates(h.getState(), {
    ids: [candidate.id], logicalBotId: BOT, userId: U, conversationId: `group:${G}`, eligible, ...extra });
  equal(lookup(recoveredUnknown).length, 1, "unknown bot group candidate available for authorized original-group understanding");
  equal(lookup(recoveredUnknown, { conversationId: `group:${G2}` }), [], "unknown bot candidate cannot cross groups");
  equal(lookup(recoveredUnknown, { purpose: "disclosure" }), [], "internal candidate is not a disclosure API");
  equal(lookup(recoveredUnknown, { eligible: () => false }), [], "current access authorization required");
  const verified = candidates.find(c => c.value === "喜欢咖啡");
  equal(lookup(verified, { conversationId: `group:${G2}` }).length, 1, "same bot may understand stable public facts across authorized groups");
  equal(lookup(verified, { logicalBotId: PEER }), [], "independent bot cannot inherit experience");

  // Shared root writer integration + oldest event time retention.
  const filePath = path.join(home, "runtime", "memory.json");
  let runtime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath }));
  await runtime.open();
  try {
    const real = createPeopleReconstructionRunner({ getState: () => runtime.value,
      transact: build => runtime.transact(build), readPage: onePage([row()]), eligible, now: () => NOW });
    await start(real, { publishVerified: true });
    await real.step();
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    const person = persisted.peopleMemory.bots[BOT].people[U];
    equal(person.entries.length, 1, "opt-in projection uses existing person evidence writer");
    equal(person.entries[0].firstSeenAt, Date.parse(AT), "no rebuild timestamp masquerades as original evidence");
    equal(persisted.peopleReconstruction.claim, null, "person projection and batch ACK durable together");
    check(person.entries[0].value === "喜欢咖啡" && !person.entries[0].value.includes("AI"), "only unchanged original fact projected");
    equal(queryPersonMemory(runtime.value, { logicalBotId: BOT, userId: U,
      conversationId: `group:${G2}`, now: NOW }).entries, [], "reconstruction does not create cross-group disclosure authority");
    await runtime.close();
    runtime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath }));
    await runtime.open();
    equal(runtime.value.peopleReconstruction.stats.published, 1, "published stats survive actual repository reopen");
    const rev = runtime.value.peopleMemory.revision;
    await runtime.transact(root => administerPersonMemory(root, { logicalBotId: BOT, userId: U,
      operation: "revoke", expectedRevision: rev, authorized: true, actorUserId: "90001", now: NOW + 1 }));
    equal(classify(row(), runtime.value).tier, "Suppressed", "person tombstone wins over recovered old evidence");
  } finally { await runtime.close(); }

  const controlled = { groups: {} };
  const evidenceArgs = { logicalBotId: BOT, userId: U, verifiedSenderId: U, accountId: "alpha",
    conversationId: `group:${G}`, messageId: "current", time: AT, now: NOW,
    kind: "preference", value: "不喜欢咖啡", privacy: "conversation", sourceType: "message", confidence: 0.9 };
  check(recordPersonEvidence(controlled, evidenceArgs).ok, "fixture creates real current person memory");
  equal(classify(row(), controlled).tier, "Conflicted", "old/new different values held for review rather than overwrite");
  equal(classify(row({ value: "喜欢摄影" }), controlled).tier, "Verified", "independent preferences are not falsely declared contradictory");
  check(administerPersonMemory(controlled, { logicalBotId: BOT, userId: U, operation: "freeze",
    expectedRevision: controlled.peopleMemory.revision, authorized: true, actorUserId: "90001", now: NOW }).ok, "fixture freeze accepted");
  equal(classify(row(), controlled).tier, "Suppressed", "freeze blocks reconstruction");
  equal(classify(row({ logicalBotId: PEER, sources: [source({ logicalBotId: PEER, accountId: "beta" })] }), controlled).tier,
    "Verified", "one bot's freeze does not mutate independent bot");
  const privateH = harness();
  const privateR = runnerFor(privateH, { readPage: onePage([privateRow]) }); await start(privateR); await privateR.step();
  const privateId = Object.keys(privateH.getState().peopleReconstruction.candidates)[0];
  const privateQuery = extra => queryPeopleReconstructionCandidates(privateH.getState(), {
    ids: [privateId], logicalBotId: BOT, userId: U, conversationId: `private:${U}`, eligible, ...extra });
  equal(privateQuery({}).length, 1, "private candidate available only to exact subject conversation and bot");
  equal(privateQuery({ conversationId: `group:${G}` }), [], "private candidates never widen to groups");
  equal(privateQuery({ logicalBotId: PEER }), [], "peer bot cannot read private candidate");

  // Latest correction while model is running: no replay, no stale publication.
  const changed = harness(snapshot), deferred = {};
  const entered = new Promise(resolve => { deferred.enter = resolve; });
  const resultReady = new Promise(resolve => { deferred.release = resolve; });
  const changingPager = createPeopleReconstructionPager({ memory: snapshot, archives: [], sourceId: "fixture-v1" });
  const changing = runnerFor(changed, { readPage: changingPager.readPage, model: async ({ candidates: cs }) => {
    deferred.enter(); await resultReady;
    return { groups: cs.map(c => ({ ids: [c.id], summary: c.value })), usage };
  } });
  await start(changing, { publishVerified: true });
  const pendingChange = changing.step(); await entered;
  await changed.transact(root => { root.groups[G].users[U].canonicalMemory.entries[0].status = "rejected"; });
  deferred.release(); await pendingChange;
  check(Object.values(changed.getState().peopleReconstruction.candidates)
    .filter(c => c.value === "喜欢咖啡").length === 0, "latest canonical rejection beats pinned model result");
  check(!changed.getState().peopleMemory, "stale model cannot resurrect source after online correction");
  const originalId = candidates.find(c => c.value === "喜欢咖啡").id;
  await h.transact(root => { root.groups[G].users[U].canonicalMemory.entries[0].status = "rejected"; });
  equal(queryPeopleReconstructionCandidates(h.getState(), { ids: [originalId], logicalBotId: BOT,
    userId: U, conversationId: `group:${G}`, eligible }), [], "published candidate read rechecks newest canonical control");
  const rawArchive = row({ origin: "archive", key: "raw-revoked", jobKey: G,
    value: "我喜欢咖啡", sources: [source({ via: "archive", text: "我喜欢咖啡" })] });
  equal(classify(rawArchive, h.getState()).tier, "Suppressed", "raw archive cannot bypass exact canonical negative source");

  // Pause, explicit unknown handling, resume: first paid claim is never replayed.
  const pausing = harness(), barriers = {}, calls = [];
  const began = new Promise(resolve => { barriers.began = resolve; });
  const releaseModel = new Promise(resolve => { barriers.release = resolve; });
  const pagedRows = async ({ sourceId, cursor: c }) => ({ sourceId,
    rows: [row({ key: c.offset ? "later" : "first" })], nextCursor: c.offset
      ? { phase: "done", offset: 2, file: 0, byte: 0 } : { phase: "memory", offset: 1, file: 0, byte: 0 } });
  const pauseRunner = runnerFor(pausing, { readPage: pagedRows, model: async args => {
    calls.push(args.candidates[0].key); if (calls.length === 1) { barriers.began(); await releaseModel; }
    return { groups: [], usage };
  } });
  await start(pauseRunner);
  const pendingPause = pauseRunner.step();
  equal(pauseRunner.step(), pendingPause, "concurrent step shares exactly one page operation");
  await began;
  await pauseRunner.control({ authorized: true, operation: "pause", expectedRevision: pauseRunner.status().revision });
  barriers.release(); await pendingPause;
  equal(pauseRunner.status().claim.status, "unknown", "pause during model fences publication and leaves unknown claim");
  equal(pauseRunner.status().candidates, 0, "no result applied after pause");
  equal(pauseRunner.status().stats.usage.totalTokens, 25, "discarded result still accounts real provider usage");
  await rejected(pauseRunner.control({ authorized: true, operation: "resume", expectedRevision: pauseRunner.status().revision }), "UNKNOWN_REQUIRES_EXPLICIT_SKIP");
  await pauseRunner.control({ authorized: true, operation: "skip_unknown", expectedRevision: pauseRunner.status().revision });
  await pauseRunner.control({ authorized: true, operation: "resume", expectedRevision: pauseRunner.status().revision });
  await pauseRunner.step();
  equal(calls, ["first", "later"], "resume advances only after explicit skip; no automatic replay");
  equal(pauseRunner.status().stats.skippedUnknown, 1, "skipped unknown count remains visible");

  // Restart model-started claim; missing tokens are UNKNOWN, never zero-cost.
  const orphan = harness();
  const old = runnerFor(orphan);
  await start(old);
  await orphan.transact(root => {
    const j = root.peopleReconstruction;
    j.claim = { id: "orphan", status: "claimed", hash: "unused", count: 2, scanned: 2,
      nextCursor: { phase: "done", offset: 2, file: 0, byte: 0 }, controlRevision: j.controlRevision,
      modelStarted: true, usageSettled: false };
    j.stats.modelAttempts = 1; j.stats.reservedTokens = j.budget.maxTokensPerCall;
  });
  let replayed = 0;
  const restarted = runnerFor(harness(orphan.durable()), { model: async () => { replayed++; return { groups: [] }; } });
  await rejected(restarted.step(), "RECOVERY_REQUIRED");
  await restarted.recover(); await restarted.step();
  equal([restarted.status().status, restarted.status().claim.status, replayed], ["paused", "unknown", 0], "restart never replays durable claim");
  equal([restarted.status().usageComplete, restarted.status().stats.unknownCalls], [false, 1], "unknown provider usage is explicit");
  equal(restarted.status().stats.reservedTokens, 2048, "unknown call retains conservative token reservation");
  await restarted.control({ authorized: true, operation: "skip_unknown", expectedRevision: restarted.status().revision });
  equal(restarted.status().status, "completed_with_limits", "explicitly skipped last page terminates honestly, not a stuck done cursor");

  // Budgets are claim-time gates; explicit increase can resume non-invoked pages.
  const budgetH = harness(); let budgetCalls = 0;
  const budgetR = runnerFor(budgetH, { model: async () => { budgetCalls++; return { groups: [], usage }; } });
  await start(budgetR, { maxCalls: 0 }); await budgetR.step();
  equal([budgetR.status().status, budgetR.status().claim, budgetCalls], ["paused", null, 0], "budget refuses before provider call");
  await budgetR.control({ authorized: true, operation: "set_budget", expectedRevision: budgetR.status().revision, maxCalls: 2, maxTokens: 5000 });
  await budgetR.control({ authorized: true, operation: "resume", expectedRevision: budgetR.status().revision });
  await budgetR.step(); equal(budgetCalls, 1, "explicitly raised budget permits a new call");
  const tokenH = harness(); let tokenCalls = 0;
  const tokenR = runnerFor(tokenH, { model: async () => { tokenCalls++; return { groups: [], usage }; } });
  await start(tokenR, { maxTokens: 10 }); await tokenR.step();
  equal(tokenCalls, 0, "token reservation is checked before model invocation");

  const missingH = harness(); let missingCalls = 0;
  const missingR = runnerFor(missingH, { readPage: pagedRows, model: async () => { missingCalls++; return { groups: [] }; } });
  await start(missingR); await missingR.step(); await missingR.step();
  equal(missingCalls, 1, "missing usage prevents further model spending");
  check(!missingR.status().usageComplete && missingR.status().stats.unknownCalls === 1, "missing usage is never invented as zero");

  // Cancellation is terminal even if a model adapter ignores AbortSignal.
  const cancelH = harness(), cancelBarriers = {};
  const cancelBegan = new Promise(resolve => { cancelBarriers.begin = resolve; });
  const cancelRelease = new Promise(resolve => { cancelBarriers.release = resolve; });
  let signal;
  const cancelR = runnerFor(cancelH, { model: async args => { signal = args.signal;
    cancelBarriers.begin(); await cancelRelease; return { groups: [], usage }; } });
  await start(cancelR); const cancelling = cancelR.step(); await cancelBegan;
  await cancelR.control({ authorized: true, operation: "cancel", expectedRevision: cancelR.status().revision });
  check(signal.aborted, "cancel sends AbortSignal to injected model");
  cancelBarriers.release(); await cancelling;
  equal([cancelR.status().status, cancelR.status().candidates], ["cancelled", 0], "cancel fences ignored-abort model results");
  await rejected(cancelR.control({ authorized: true, operation: "resume", expectedRevision: cancelR.status().revision }), "NOT_PAUSED");

  // Unknown storage ACK must not be retried even in the current process.
  const uncertain = harness(); let attempted = 0;
  const uncertainR = runnerFor(uncertain, { model: async () => { attempted++; return { groups: [], usage }; } });
  await start(uncertainR); uncertain.fault("after");
  await rejected(uncertainR.step(), "DURABILITY_UNCERTAIN");
  equal(attempted, 0, "durable claim with lost ACK never invokes model");
  await rejected(uncertainR.step(), "STORAGE_RECONCILIATION_REQUIRED");
  const restoredH = harness(uncertain.durable());
  const restored = runnerFor(restoredH); await restored.recover();
  equal(restored.status().claim.status, "unknown", "new runtime reconciles orphan claim instead of auto-retry");
  const lostCommitH = harness();
  const lostCommit = runnerFor(lostCommitH, { model: async () => {
    lostCommitH.fault("after", root => root.peopleReconstruction.claim === null); return { groups: [], usage };
  } });
  await start(lostCommit);
  equal((await lostCommit.step()).status, "storage_blocked", "lost result ACK stops the current runner");
  const lostAfterRestart = runnerFor(harness(lostCommitH.durable())); await lostAfterRestart.recover();
  equal([lostAfterRestart.status().candidates, lostAfterRestart.status().claim], [1, null], "durable result + ACK are not repeated after reopen");

  // Bad model IDs/JSON do not ACK sources or leak exception messages.
  const badH = harness();
  const badR = runnerFor(badH, { model: async () => ({ groups: [{ ids: ["invented"], summary: "bad" }], usage }) });
  await start(badR); const badResult = await badR.step();
  equal([badResult.code, badR.status().candidates, badR.status().claim.status], ["BATCH_OUTCOME_UNKNOWN", 0, "unknown"], "invalid model patch never commits/ACKs");
  equal(badR.status().stats.usage.totalTokens, 25, "bad model response still records actual usage");
  const conflictH = harness();
  const conflictR = runnerFor(conflictH, { model: async ({ candidates: cs }) => ({
    groups: [{ ids: [cs[0].id], summary: "待核实矛盾", conflict: true, tier: "Verified" }], usage }) });
  await start(conflictR, { publishVerified: true }); await conflictR.step();
  equal([conflictR.status().stats.tiers.Conflicted, conflictR.status().stats.published], [1, 0], "model may flag conflict but never raise evidence grade");

  // Indexed archive host seam: original IDs/sender/time still checked by helper.
  let indexRequests;
  const indexPager = createPeopleReconstructionPager({ memory: snapshot, sourceId: "indexed",
    lookupEvidence: async args => { indexRequests = args; return { complete: false,
      sources: [source({ messageId: "m2", logicalBotId: null, accountId: null, via: "archive", text: "我喜欢摄影" })] }; } });
  const indexed = await indexPager.readPage({ sourceId: "indexed", cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: LIMITS.page });
  check(indexRequests.requests.some(req => req.messageIds.includes("m2") && req.userId === U), "host ID index receives exact QQ/conversation/source IDs");
  const indexedSupported = indexed.rows.find(v => v.value === "喜欢摄影");
  equal(classify(indexedSupported, snapshot).tier, "Supported", "indexed original bot-less source has same supported classification");
  const indexedMissing = indexed.rows.find(v => v.value === "尚无来源");
  check(classify(indexedMissing, snapshot).reasons.includes("ARCHIVE_JOIN_INCOMPLETE"), "incomplete source coverage is not falsely called absent evidence");

  // Bounded cooperative paging survives restart after >512 previously visited slots.
  const big = { groups: {} };
  for (let n = 0; n < 700; n++) big.groups[String(20000 + n)] = { users: {} };
  big.groups["30000"] = { users: { [U]: { profile: ["后面的资料不能丢"] } } };
  let bigPager = createPeopleReconstructionPager({ memory: big, sourceId: "big" });
  let c = { phase: "memory", offset: 0, file: 0, byte: 0 };
  let page = await bigPager.readPage({ sourceId: "big", cursor: c, limit: LIMITS.page });
  check(page.rows.length === 0 && page.nextCursor.offset === 512, "empty containers still advance bounded cursor");
  c = page.nextCursor;
  bigPager = createPeopleReconstructionPager({ memory: big, sourceId: "big" });
  page = await bigPager.readPage({ sourceId: "big", cursor: c, limit: LIMITS.page });
  check(page.rows.some(v => v.value === "后面的资料不能丢"), "resumed cooperative prefix does not hide later groups");
  const p1 = createPeopleReconstructionPager({ memory: snapshot, archives: manifest, sourceId: "fixture-v1" });
  const first = await p1.readPage({ sourceId: "fixture-v1", cursor: { phase: "memory", offset: 0, file: 0, byte: 0 }, limit: LIMITS.page });
  const p2 = createPeopleReconstructionPager({ memory: snapshot, archives: manifest, sourceId: "fixture-v1" });
  const second = await p2.readPage({ sourceId: "fixture-v1", cursor: first.nextCursor, limit: LIMITS.page });
  check(second.rows.every(v => v.origin === "archive"), "persisted cursor resumes exact archive phase");
  await fs.truncate(archiveFile, 1);
  await rejected(p2.readPage({ sourceId: "fixture-v1", cursor: first.nextCursor, limit: LIMITS.page }), "ARCHIVE_SNAPSHOT_CHANGED");
  assert.throws(() => controlPeopleReconstruction({ peopleReconstruction: createPeopleReconstructionState({ id: "a", sourceId: "b" }) },
    { operation: "pause", expectedRevision: 0 }), { code: "UNAUTHORIZED" }); checks++;

  console.log(JSON.stringify({ ok: true, checks, fixturesOnly: true, realMemoryRuntime: true,
    qqSends: 0, paidModelCalls: 0, productionReads: 0 }));
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
