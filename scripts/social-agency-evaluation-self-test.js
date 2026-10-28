import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SOCIAL_AGENCY_CATEGORIES as categories, SOCIAL_AGENCY_SCENARIOS as fixtures, SOCIAL_AGENCY_CORPUS_HASH,
  agencyCanonicalJSON, loadAgencyBaselineAdapter, evaluateSocialAgencyScenarios, agencyReplayTemplate, evaluateAgencyReplay } from "./social-agency-evaluation.js";

// Only fictional fixtures / declared synthetic outputs. No runtime data, files
// written, real model, human ratings, network, paid calls or QQ protocol.
const copy = value => structuredClone(value);
let checks = 0;
async function test(name, run) { try { await run(); checks++; } catch (cause) { throw new Error(name, { cause }); } }
const report = await evaluateSocialAgencyScenarios({ includeCases: true });
const byCategory = id => report.pairs.filter(row => row.category === id);
const sourceScene = row => fixtures.find(scene => scene.id === row.id);
const expectReplayFailure = (packet, mutate, pattern) => { const bad = copy(packet); mutate(bad); assert.throws(() => evaluateAgencyReplay(bad), pattern); };

await test("exact requested 15 categories, 10 genuinely varied fixed inputs each, 150 paired cases", () => {
  assert.equal(categories.length, 15); assert.equal(fixtures.length, 150); assert.equal(report.cases, 150);
  assert.equal(new Set(fixtures.map(scene => scene.id)).size, 150);
  for (const category of categories) {
    const scenes = fixtures.filter(scene => scene.category === category.id);
    assert.equal(scenes.length, 10); assert.equal(new Set(scenes.map(scene => scene.input.topic)).size, 10);
    assert.equal(new Set(scenes.map(scene => scene.input.event.query)).size, category.id === "discussion-ended" || category.id === "rejection-stop" || category.id === "reasonable-silence" ? 1 : 10);
    assert.equal(byCategory(category.id).length, 10);
  }
  assert.equal(report.sameInputPairs, 150); assert.equal(report.corpusHash, SOCIAL_AGENCY_CORPUS_HASH);
  for (const pair of report.pairs) {
    assert.equal(pair.synthetic, true); assert.equal(pair.inputParity.baseline, pair.inputParity.candidate);
    assert.match(pair.inputParity.baseline, /^[a-f0-9]{64}$/);
    assert.equal(sourceScene(pair).input.event.mentioned, false);
  }
  assert.equal(Object.isFrozen(fixtures), true); assert.equal(Object.isFrozen(fixtures[0].input.specs), true);
});

await test("baseline is actual pinned code: source blobs, symbols and exact source hashes", async () => {
  const old = await loadAgencyBaselineAdapter();
  assert.equal(report.sourceParity.baseline, "a8aa328f2d4dd4da9a438e52e416b9eb2c76580b");
  assert.equal(report.sourceParity.candidate, "working-tree"); assert.equal(report.sourceParity.pinnedBlobs.length, 5);
  assert.equal(report.sourceParity.pinnedBlobs.find(row => row.path === "src/bridge.js").sha256,
    "8cd7c80308c875cf20cbf6494c0830073aef89e0a47bd7f4250741109263d986");
  for (const item of [...report.sourceParity.extracted, ...report.sourceParity.candidateFiles]) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.sourceParity.extracted.map(item => item.symbol), ["DiscoveryRuntime.getPolicy", "applyContinuity", "queries"]);
  const input = copy(fixtures[0].input);
  input.configuration = { adminInterests: ["摄影"], profileInterests: "天文，音乐", blockedTopics: [], maxQueries: 3 };
  assert.deepEqual(old.select(input).tags, ["摄影"], "old chooses administrator list, does NOT fill from profile");
  input.configuration.adminInterests = [];
  assert.deepEqual(old.select(input).tags, ["天文", "音乐"]);
  input.configuration.profileInterests = "";
  assert.deepEqual(old.select(input).tags, ["新奇巧妙的梗 游戏", "科技 趣闻", "生活 创意"]);
  input.configuration.adminInterests = ["QQ123456", "https://example.test"];
  assert.deepEqual(old.select(input).tags, ["新奇巧妙的梗 游戏", "科技 趣闻", "生活 创意"]);
});

await test("new results come from actual mutators: six scoped preferences per scenario, forged self refused", () => {
  for (const pair of report.pairs) {
    assert.equal(pair.candidate.recorded.length, 6);
    assert.ok(pair.candidate.recorded.every(entry => entry.status === "active"));
    assert.equal(pair.candidate.forgedSelfRejected, true);
    assert.equal(pair.candidate.growth.accepted, pair.candidate.growth.code === "ROLE_CARD_APPLIED");
  }
  assert.equal(report.ruleProxies.personaOwnership.candidateForgedSelfRejected, 150);
});

await test("group/member origin never becomes self; baseline actual growth exposes its weaker evidence gate", () => {
  for (const category of ["group-self-conflict", "repeated-member-preference", "multiple-opinions", "privacy-isolation"]) {
    for (const pair of byCategory(category)) {
      const input = sourceScene(pair).input;
      assert.equal(pair.baseline.growth.accepted, true);
      assert.equal(pair.baseline.growth.roleCardFields.interests, input.alternate);
      assert.equal(pair.candidate.growth.accepted, false);
      assert.ok(!pair.candidate.context.self.some(entry => entry.value === input.alternate));
    }
  }
  assert.equal(report.ruleProxies.personaOwnership.baselineUnverifiedGrowthAccepted, 40);
  assert.equal(report.ruleProxies.personaOwnership.candidateUnverifiedGrowthAccepted, 0);
});

await test("current core hash change suppresses self and growth, while static config remains independent", () => {
  for (const pair of byCategory("reasonable-silence")) {
    const input = sourceScene(pair).input;
    if (input.variant % 2) {
      assert.deepEqual(pair.candidate.context.self, []); assert.equal(pair.candidate.growth.accepted, false);
      assert.deepEqual(pair.candidate.discovery.tags, []);
    }
    assert.equal(pair.candidate.journal.status, "pending"); assert.equal(pair.candidate.journal.selected, 0);
  }
});

await test("journal creation, idempotency, claim, lazy expiry, terminal rejection and restart fences are actual", () => {
  for (const pair of report.pairs.filter(pair => pair.candidate.journal.proposed)) {
    assert.equal(pair.candidate.journal.duplicateCreates, 0);
    assert.equal(pair.candidate.journal.selectedAfterClaim, 0);
    assert.equal(pair.candidate.journal.restartReplayBlocked, true);
  }
  assert.ok(byCategory("intent-created").every(pair => pair.candidate.journal.selected === 1));
  assert.ok(byCategory("intent-expired").every(pair => pair.candidate.journal.status === "expired" && pair.candidate.journal.selected === 0));
  for (const category of ["discussion-ended", "rejection-stop"]) assert.ok(byCategory(category)
    .every(pair => pair.candidate.journal.status === "abandoned" && pair.candidate.journal.selected === 0));
  for (const pair of byCategory("related-new-content")) assert.equal(pair.candidate.journal.selected, sourceScene(pair).input.variant % 3 === 2 ? 0 : 1);
});

await test("old already has real event-driven one-shot attention: no invented zero-capability straw baseline", () => {
  assert.ok(byCategory("related-new-content").some(pair => pair.baseline.attention.matched));
  assert.ok(report.pairs.every(pair => pair.baseline.attention.available && !pair.baseline.attention.repeatMatched));
  assert.ok(byCategory("intent-expired").every(pair => !pair.baseline.attention.matched));
  assert.ok(byCategory("rejection-stop").every(pair => pair.baseline.attention.sameSessionReplayBlocked));
  assert.ok(byCategory("rejection-stop").every(pair => pair.baseline.attention.afterRestartRecreated));
});

await test("different bots and action modalities get different actual context, not invented different actions", () => {
  for (const category of ["multi-bot-expression", "expression-modalities"]) for (const pair of byCategory(category)) {
    assert.notDeepEqual(pair.candidate.context.self, pair.candidate.peerContext.self);
    assert.ok(pair.candidate.context.self.some(entry => entry.dimension === "expression"));
    assert.equal(pair.candidate.modalitySelection, "NOT_RUN_CONTEXT_ONLY");
    assert.equal(pair.candidate.actualAction, "NOT_RUN"); assert.equal(pair.baseline.actualAction, "NOT_RUN");
  }
  assert.equal(report.ruleProxies.multiBotActionContext.distinctContextPairs, 20);
  assert.equal(report.ruleProxies.multiBotActionContext.actualDifferentActions, "NOT_RUN");
});

await test("private/cross-group/current-user isolation and QZone source permissions are real projections", () => {
  for (const pair of byCategory("privacy-isolation")) {
    assert.deepEqual(pair.candidate.context.member, []);
    if (sourceScene(pair).input.scope.conversationId !== "group:101") assert.deepEqual(pair.candidate.context.group, []);
    assert.equal(pair.candidate.qzone.candidateAvailable, false);
  }
  for (const pair of byCategory("qzone-draft-basis")) {
    assert.equal(pair.candidate.qzone.candidateAvailable, sourceScene(pair).input.variant < 5);
    if (pair.candidate.qzone.candidateAvailable) {
      assert.equal(pair.candidate.qzone.audience, 64); assert.equal(pair.candidate.qzone.sourceKind, "public_information");
    }
    assert.equal(pair.candidate.qzone.publication, "NOT_RUN");
  }
  assert.ok(!JSON.stringify(report).includes("SYNTHETIC_PRIVATE_DO_NOT_PROJECT"));
  assert.equal(report.ruleProxies.permissions.candidateAuthorityGrants, 0);
});

await test("admin bans and hard three/configured query ceiling hold in all 150 actual selections", () => {
  for (const pair of report.pairs) {
    assert.ok(pair.baseline.discovery.querySlots <= Math.min(3, pair.maxQueries));
    assert.ok(pair.candidate.discovery.querySlots <= Math.min(3, pair.maxQueries));
    for (const banned of sourceScene(pair).input.configuration.blockedTopics) assert.ok(!pair.candidate.discovery.tags.includes(banned));
    assert.equal(new Set(pair.candidate.discovery.tags).size, pair.candidate.discovery.tags.length);
  }
  assert.equal(report.ruleProxies.budgetBound.overConfiguredLimit, 0);
});

await test("no naturalness, factual correctness or independent-opinion self-rating, no unknown token zero", () => {
  for (const field of ["actualModel", "actualQQ", "actualHuman", "naturalness", "opinionIndependence", "nonIntrusiveness", "factualAccuracy"]) assert.equal(report[field], "NOT_RUN");
  assert.equal(report.budgets.actualCalls, 0); assert.equal(report.budgets.networkCalls, 0); assert.equal(report.budgets.modelCalls, 0);
  assert.equal(report.budgets.qqActions, 0); assert.equal(report.budgets.tokens, null);
  assert.equal(report.budgets.tokenAccounting, "UNKNOWN_NOT_ZERO");
  assert.equal(report.ruleProxies.evidenceKind, "SYNTHETIC_RULE_PROXIES_NOT_BEHAVIOR_QUALITY");
  assert.ok(report.limitations.some(line => /NOT_RUN/.test(line)));
  assert.ok(!Object.hasOwn(report, "score") && !Object.hasOwn(report, "qualityVerdict"));
});

await test("repeat execution is deterministic and does not mutate frozen corpus", async () => {
  const before = agencyCanonicalJSON(fixtures), second = await evaluateSocialAgencyScenarios({ includeCases: true });
  assert.deepEqual(second, report); assert.equal(agencyCanonicalJSON(fixtures), before);
  second.pairs[0].candidate.context.self.length = 0; assert.notDeepEqual(second.pairs[0], report.pairs[0]);
});

await test("canonicalization rejects getters, hidden/prototype/sparse/non-JSON data without invoking code", () => {
  assert.equal(agencyCanonicalJSON({ b: 2, a: 1 }), agencyCanonicalJSON({ a: 1, b: 2 }));
  assert.notEqual(agencyCanonicalJSON([1, 2]), agencyCanonicalJSON([2, 1]));
  let calls = 0; const accessor = {}; Object.defineProperty(accessor, "text", { enumerable: true, get() { calls++; return "forbidden"; } });
  const array = [1]; Object.defineProperty(array, "0", { get() { calls++; return 1; } });
  const hidden = {}; Object.defineProperty(hidden, "text", { value: "hidden" });
  for (const value of [accessor, array, hidden, Array(1), undefined, NaN, new Date(), { value: undefined }, JSON.parse('{"__proto__":1}')])
    assert.throws(() => agencyCanonicalJSON(value), /NON_JSON/);
  assert.equal(calls, 0);
});

const packet = agencyReplayTemplate();
for (const pair of packet.pairs) for (const variant of ["baseline", "candidate"]) pair[variant].output = { action: "observe", text: "" };

await test("external offline replay starts unfilled and accepts only full parity-matched unverified rows", () => {
  assert.throws(() => evaluateAgencyReplay(agencyReplayTemplate()), /REPLAY_FIELDS/);
  const observed = evaluateAgencyReplay(packet);
  assert.equal(observed.cases, 150); assert.equal(observed.inputParity, true);
  assert.equal(observed.evidenceStatus, "UNVERIFIED_EXTERNAL_JSON");
  for (const field of ["actualModel", "actualHuman", "actualQQ", "naturalness", "opinionIndependence"]) assert.equal(observed[field], "NOT_RUN");
  assert.equal(observed.budgets.actualCalls, 0); assert.equal(observed.budgets.tokens, null);
  assert.deepEqual(observed.ruleProxies.baseline.inputTokens, { knownRows: 0, unknownRows: 150, knownSubtotal: 0, total: null });
  assert.deepEqual(observed.ruleProxies.candidate.declaredCalls, { knownRows: 0, unknownRows: 150, knownSubtotal: 0, total: null });
});

await test("replay input/model parity, exact corpus/IDs, output types and token counts fail closed", () => {
  for (const [mutate, pattern] of [
    [p => { p.corpusHash = "changed"; }, /REPLAY_IDENTITY/], [p => { p.pairs.pop(); }, /REPLAY_INCOMPLETE/],
    [p => { p.pairs[1].id = p.pairs[0].id; }, /REPLAY_CASE_ID/],
    [p => { p.pairs[0].candidate.input.topic = "changed"; }, /REPLAY_INPUT_MISMATCH/],
    [p => { p.pairs[0].candidate.output.text = "text during silence"; }, /REPLAY_SILENT_TEXT/],
    [p => { p.pairs[0].candidate.output.action = "publish"; }, /REPLAY_OUTPUT/],
    [p => { p.pairs[0].candidate.metrics.calls = -1; }, /REPLAY_USAGE/],
    [p => { p.pairs[0].candidate.metrics.inputTokens = "unknown"; }, /REPLAY_USAGE/],
    [p => { p.pairs[0].candidate.metrics.outputTokens = 1.5; }, /REPLAY_USAGE/],
    [p => { p.pairs[0].candidate.model = { provider: "fixture" }; }, /REPLAY_UNEXPECTED_MODEL/]
  ]) expectReplayFailure(packet, mutate, pattern);
  const models = copy(packet); models.declaredSource = "external-model";
  for (const pair of models.pairs) for (const variant of ["baseline", "candidate"])
    pair[variant].model = { provider: "synthetic-provider", name: "synthetic-model", revision: "fixture-only", generation: { temperature: 0 } };
  assert.equal(evaluateAgencyReplay(models).actualModel, "NOT_RUN", "declaring a model never proves a run");
  expectReplayFailure(models, p => { p.pairs[0].candidate.model.revision = "different-fixture"; }, /REPLAY_MODEL_MISMATCH/);
  expectReplayFailure(packet, p => { for (const row of p.pairs) row.baseline.metrics.calls = Number.MAX_SAFE_INTEGER; }, /REPLAY_USAGE_OVERFLOW/);
});

await test("known-zero accounting differs from unknown and imported outputs remain rule proxies", () => {
  const changed = copy(packet);
  changed.pairs[0].baseline.metrics = { calls: 0, inputTokens: 0, outputTokens: 0 };
  changed.pairs[0].candidate.output = { action: "voice", text: "虚构离线输出" };
  changed.pairs[1].candidate.output = { action: "reply", text: "虚构离线输出" };
  const observed = evaluateAgencyReplay(changed);
  assert.deepEqual(observed.ruleProxies.baseline.inputTokens, { knownRows: 1, unknownRows: 149, knownSubtotal: 0, total: null });
  assert.equal(observed.ruleProxies.candidate.repeatedText, 1);
  assert.equal(observed.ruleProxies.candidate.evidenceKind, "OFFLINE_RULE_PROXIES");
  assert.equal(observed.actualHuman, "NOT_RUN"); assert.ok(!JSON.stringify(observed).includes("虚构离线输出"));
});

await test("CLI is stdout/stdin only, no reports written and no automatic reading of replay/live paths", () => {
  const entry = fileURLToPath(new URL("./social-agency-evaluation.js", import.meta.url));
  const run = (args, input) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", input, maxBuffer: 10 * 1024 * 1024 });
  const summary = run(["--summary"]); assert.equal(summary.status, 0, summary.stderr); assert.equal(JSON.parse(summary.stdout).cases, 150);
  const imported = run(["--replay-stdin"], JSON.stringify(packet)); assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).actualModel, "NOT_RUN");
  const bad = run(["--replay-stdin"], "not json SYNTHETIC_SECRET_DO_NOT_ECHO"); assert.equal(bad.status, 1);
  assert.ok(!bad.stderr.includes("SYNTHETIC_SECRET_DO_NOT_ECHO"));
  const pathAttempt = run(["--replay", "config.json"]); assert.equal(pathAttempt.status, 1);
  assert.equal(JSON.parse(pathAttempt.stderr).code, "AGENCY_EVALUATION_CLI_ARGUMENTS");
});

console.log(JSON.stringify({ ok: true, checks, cases: report.cases, categories: categories.length, casesPerCategory: 10,
  sourceParity: { baseline: report.sourceParity.baseline, candidate: "working-tree" }, synthetic: true,
  actualModel: "NOT_RUN", actualQQ: "NOT_RUN", actualHuman: "NOT_RUN", budgets: { actualCalls: 0, tokens: null } }));
