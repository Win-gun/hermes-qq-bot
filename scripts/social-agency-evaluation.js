import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ingestSocialMessage, appendSocialExperience } from "../src/social-agent-state.js";
import { recordSocialPreference, getSocialPreferences, reviewSocialPreference, setSocialGrowthFrozen } from "../src/social-preferences.js";
import { selectAgencyDiscoveryInterests, agencyPreferenceContext } from "../src/social-agency-context.js";
import { proposeSocialIntent, getSocialIntentJournal, settleSocialIntent, selectRelevantSocialIntents } from "../src/social-intent-journal.js";
import { applySelfRoleCard, getSelfRoleCard } from "../src/self-role-card.js";
import { agencyGrowthAllowed } from "../src/social-agency.js";
import { beginDiscoveryRound, finishDiscoveryRound } from "../src/social-discovery-state.js";
import { buildAgencyQzoneCandidate } from "../src/social-agency-qzone.js";

// Offline synthetic differential harness, NOT a model evaluator or QQ client.
// Source IO is allowlisted to pinned git blobs / specific working-tree code.
// No config, memory, archives, credentials, URLs, models or protocol are read.
// The optional replay interface consumes explicitly supplied JSON bytes only.
const BASELINE = "a8aa328f2d4dd4da9a438e52e416b9eb2c76580b";
const SCHEMA = "social-agency-3.2/evaluation-v1";
const REPO = fileURLToPath(new URL("../", import.meta.url));
const DAY = 86_400_000, AT = 1_792_800_000_000;
const A = "account:syntheticAlpha", B = "account:syntheticBeta", G = "group:101", H = "group:202", U = "111";
const copy = value => structuredClone(value);
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw new TypeError(`AGENCY_EVALUATION_${code}`); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uint = value => Number.isSafeInteger(value) && value >= 0;
function insist(condition, code) { if (!condition) fail(code); }
export function agencyCanonicalJSON(value, depth = 0, budget = { left: 250000 }) {
  insist(depth <= 32 && --budget.left >= 0, "JSON_LIMIT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    insist(Object.getPrototypeOf(value) === Array.prototype && value.length <= 100000 && Reflect.ownKeys(value).length === value.length + 1
      && Object.keys(value).length === value.length && Object.keys(value).every((key, i) => key === String(i)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")), "NON_JSON");
    return `[${value.map(child => agencyCanonicalJSON(child, depth + 1, budget)).join(",")}]`;
  }
  if (plain(value)) {
    insist(Reflect.ownKeys(value).every(key => typeof key === "string"
      && !["__proto__", "prototype", "constructor"].includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")
      && Object.getOwnPropertyDescriptor(value, key).enumerable), "NON_JSON");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${agencyCanonicalJSON(value[key], depth + 1, budget)}`).join(",")}}`;
  }
  return fail("NON_JSON");
}
const digest = value => sha(agencyCanonicalJSON(value));
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export const SOCIAL_AGENCY_CATEGORIES = freeze([
  ["interested-unmentioned", "机器人有兴趣但没有被 @"],
  ["group-self-conflict", "群友兴趣与机器人兴趣冲突"],
  ["repeated-member-preference", "某个群友反复提出不同偏好"],
  ["multiple-opinions", "多人意见不同"],
  ["explicit-dissent", "Bot 有明确不同意见"],
  ["discussion-ended", "讨论结束"],
  ["intent-created", "产生待表达意图"],
  ["intent-expired", "意图过期"],
  ["related-new-content", "新内容与旧意图相关"],
  ["rejection-stop", "被拒绝后停止"],
  ["multi-bot-expression", "多 Bot 之间表达不同"],
  ["expression-modalities", "表情、语音、拍一拍选择"],
  ["reasonable-silence", "沉默是否合理"],
  ["qzone-draft-basis", "QQ 空间草稿依据"],
  ["privacy-isolation", "跨群、私聊与空间隐私隔离"]
].map(([id, label]) => ({ id, label })));
const topics = ["天文", "摄影", "音乐", "电影", "园艺", "烹饪", "书法", "围棋", "历史", "绘画"];
const styles = ["文字简洁", "表情交流", "语音交流", "轻拍互动", "审慎质疑", "温和幽默", "安静倾听", "完整解释", "简明观点", "克制提问"];

function scenes() {
  return SOCIAL_AGENCY_CATEGORIES.flatMap(({ id: category }, categoryIndex) => topics.map((topic, index) => {
    const alternate = topics[(index + 3) % topics.length], style = styles[index];
    const now = AT + index * 3_600_000, stem = `${topic}进展值得讨论`;
    const conflict = ["group-self-conflict", "repeated-member-preference", "multiple-opinions", "privacy-isolation"].includes(category);
    const specs = [{ logicalId: A, kind: "self", dimension: "interest", value: topic },
      { logicalId: A, kind: "self", dimension: "expression", value: style },
      { logicalId: A, kind: "group", dimension: "interest", value: alternate },
      { logicalId: A, kind: "member", dimension: "interest", value: alternate },
      { logicalId: B, kind: "self", dimension: "interest", value: alternate },
      { logicalId: B, kind: "self", dimension: "expression", value: styles[(index + 1) % 10] }];
    const currentCore = `偏好${topic}。表达${style}`;
    const privateScope = [G, H, `private:${U}`, G, H, `private:${U}`, G, H, `private:${U}`, G][index];
    const query = category === "discussion-ended" ? "先这样，话题结束" : category === "rejection-stop" ? "别再问，先这样"
      : category === "reasonable-silence" ? "" : category === "related-new-content" && index % 3 === 2 ? `${alternate}的另一话题`
        : `${stem}，有新的公开资料${index + 1}`;
    return { id: `${category}:${String(index + 1).padStart(2, "0")}`, category, synthetic: true,
      input: { variant: index, now, readAt: now + (category === "intent-expired" ? 2_001 + index * 100 : 100),
        topic, alternate, style, specs,
        cores: { [A]: category === "reasonable-silence" && index % 2 ? `${currentCore}。核心已修订` : currentCore,
          [B]: `偏好${alternate}。表达${styles[(index + 1) % 10]}` }, evidenceCore: currentCore,
        scope: { logicalId: A, conversationId: category === "privacy-isolation" ? privateScope : G,
          userId: category === "privacy-isolation" && index % 3 === 0 ? "444" : U },
        event: { query, mentioned: false, quiet: ["discussion-ended", "rejection-stop", "reasonable-silence"].includes(category), stem,
          sourceText: `${stem}。讨论${style}的表达方式` },
        configuration: { adminInterests: index === 8 ? [topic, alternate, "科学", "艺术"] : [],
          profileInterests: index % 4 === 0 ? topic : "", blockedTopics: index === 9 ? [alternate] : [], maxQueries: index % 3 + 1 },
        proposal: { field: ["explicit-dissent", "expression-modalities"].includes(category) ? "expression" : "interests",
          value: ["explicit-dissent", "expression-modalities"].includes(category) ? style : conflict ? alternate : topic },
        growthEvidenceIds: conflict ? ["fixture:3:2"] : ["source-current"],
        intent: { enabled: ["discussion-ended", "intent-created", "intent-expired", "related-new-content", "rejection-stop", "reasonable-silence"].includes(category),
          ttlMs: 2_000 + index * 100, disposition: category === "discussion-ended" || category === "rejection-stop" ? "abandoned"
            : category === "reasonable-silence" ? "pending" : "candidate" },
        capabilities: { sticker: index % 2 === 0, voice: index % 3 === 0, poke: index % 4 === 0 },
        freezeGrowth: category === "repeated-member-preference" && index >= 8,
        rejectSelf: category === "rejection-stop" && index % 2 === 1,
        qzone: { enabled: ["qzone-draft-basis", "privacy-isolation"].includes(category), mode: category === "privacy-isolation" ? "private_source"
          : ["public", "public", "public", "public", "public", "missing", "private_scope", "blocked", "expired", "private_text"][index] },
        fixtureProvenance: { synthetic: true, categoryOrdinal: categoryIndex + 1, source: "fixed anonymous in-memory histories; no live data" } } };
  }));
}
export const SOCIAL_AGENCY_SCENARIOS = freeze(scenes());
export const SOCIAL_AGENCY_CORPUS_HASH = digest(SOCIAL_AGENCY_SCENARIOS);

const baselinePaths = ["src/bridge.js", "src/social-discovery-runtime.js", "src/self-role-card.js", "src/self-role-card-generator.js", "src/social-interest-watch.js"];
const candidatePaths = ["src/social-preferences.js", "src/social-agency-context.js", "src/social-intent-journal.js", "src/social-agency.js", "src/social-agency-qzone.js",
  "src/social-agent-state.js", "src/self-role-card.js", "src/social-discovery-state.js"];
function pinned(path) {
  insist(baselinePaths.includes(path), "SOURCE_NOT_ALLOWLISTED");
  try { return execFileSync("git", ["-C", REPO, "show", `${BASELINE}:${path}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return fail("PINNED_BASELINE_UNAVAILABLE"); }
}
function section(source, start, end, after = 0) {
  const a = source.indexOf(start, after), b = source.indexOf(end, a + start.length);
  insist(a >= 0 && b > a, "BASELINE_ADAPTER_SOURCE_MISMATCH");
  return { text: source.slice(a, b), lines: [source.slice(0, a).split("\n").length, source.slice(0, b).split("\n").length - 1] };
}
let baselinePromise;
export async function loadAgencyBaselineAdapter() {
  baselinePromise ||= (async () => {
    const sources = Object.fromEntries(baselinePaths.map(path => [path, pinned(path)]));
    const bridge = sources["src/bridge.js"];
    const policy = section(bridge, "    getPolicy: ctx => {", "\n    getRoot:", bridge.indexOf("const discoveryRuntime = createSocialDiscoveryRuntime({"));
    const continuity = section(bridge, "    applyContinuity: async (ctx, proposal,", "\n    sendIntent:");
    const query = section(sources["src/social-discovery-runtime.js"], "function queries(", "\nfunction publicUrl(");
    const sourceModule = text => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
    const [cards, validation, watches] = await Promise.all([sourceModule(sources[baselinePaths[2]]), sourceModule(sources[baselinePaths[3]]), sourceModule(sources[baselinePaths[4]])]);
    // Execute exact pinned callback bodies, not a hand-written old/new if ladder.
    // All dependencies below are actual pinned pure functions or explicit local
    // host doubles. Inputs already contain safe public labels; the redactor
    // double is identity, so this is NOT an auth/redaction/whole-bridge test.
    const policyFactory = Function("discoveryPolicy", "socialPolicy", `"use strict"; return ({${policy.text}}).getPolicy;`);
    const queries = Function("day", `"use strict"; ${query.text}; return queries;`)(at => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10));
    const names = ["requireSocialCurrent", "mutateMemory", "memory", "applySocialContinuity", "socialPolicy", "getSelfRoleCard",
      "validateSelfRoleCardFields", "redactSensitive", "config", "applySelfRoleCard", "proposePersonaChanges", "roleCardGrowthState"];
    const growthFactory = Function(...names, `"use strict"; return ({${continuity.text}}).applyContinuity;`);
    return {
      metadata: { baseline: BASELINE, candidate: "working-tree", adapter: "EXECUTED_PINNED_SOURCE_WITH_IN_MEMORY_HOST_DOUBLES",
        pinnedBlobs: baselinePaths.map(path => ({ path, sha256: sha(sources[path]) })),
        extracted: [{ path: "src/bridge.js", symbol: "DiscoveryRuntime.getPolicy", lines: policy.lines, sha256: sha(policy.text) },
          { path: "src/bridge.js", symbol: "applyContinuity", lines: continuity.lines, sha256: sha(continuity.text) },
          { path: "src/social-discovery-runtime.js", symbol: "queries", lines: query.lines, sha256: sha(query.text) }],
        limits: ["policy/query and auto-role-card-growth parity only; not full runtime or model parity",
          "mutateMemory is synchronous in-memory publication; identity/quiet host check is a fixture double",
          "redaction is identity for already-public fixture labels; no redaction safety claim",
          "old interest watch is executed too; absence of journal does not mean old attention was absent"] },
      select(input) {
        const c = input.configuration;
        const p = policyFactory(() => ({ interests: c.adminInterests, maxSearchesPerRound: c.maxQueries, blockedTopics: c.blockedTopics }),
          () => ({ profile: { interests: c.profileInterests }, maxDailyCalls: 100 }))({ accountId: "syntheticAlpha" });
        const emitted = queries(p, input.readAt);
        return { tags: emitted.map(value => value.replace(/^\d{4}-\d{2}-\d{2} /, "").replace(/ 公开资讯$/, "")),
          querySlots: emitted.length, configuredInterestsPresent: p.interests.length > 0,
          sourceTier: c.adminInterests.length ? "administrator" : c.profileInterests ? "profile" : "legacy-default" };
      },
      async grow(root, input) {
        const policy = { enabled: true, autoGrow: true, minUpdateIntervalMs: DAY, maxVersions: 32 };
        const unreachable = () => fail("UNEXPECTED_BASELINE_BRANCH");
        const callback = growthFactory(() => ({ userId: U, accountId: "syntheticAlpha", contactSource: null }),
          async (_root, build) => build(_root), root, unreachable, () => ({ roleCard: policy, shadowMode: false }),
          cards.getSelfRoleCard, validation.validateSelfRoleCardFields, value => value, {}, cards.applySelfRoleCard, unreachable, new Map());
        const result = await callback({ logicalId: A, conversationId: G }, { personaChanges: [{ ...input.proposal, evidenceMessageIds: input.growthEvidenceIds }] },
          { seenMessageIds: input.growthEvidenceIds, now: input.now, signal: undefined });
        return { accepted: result.growthCode === "ROLE_CARD_APPLIED", code: result.growthCode || "NOT_APPLIED",
          roleCardFields: cards.getSelfRoleCard(root, { logicalId: A }).fields };
      },
      attention(input) {
        let at = input.now;
        const ctx = { logicalId: A, conversationId: G, revision: 1 };
        const deps = { clock: () => at, isCurrent: () => true, getPolicy: () => ({ enabled: true, shadowMode: false,
          conversationIds: [G], interestWatch: { enabled: true } }) };
        const watch = watches.createSocialInterestWatch(deps);
        const source = { seq: 1, messageId: "source-current", userId: U, text: input.event.sourceText, sentAt: input.now - 200, isBot: false, isQuoted: false };
        const proposal = { kind: "topic", sourceSeq: 1, ttlMs: input.intent.ttlMs };
        const created = watch.create(ctx, proposal, { sources: [source] });
        if (input.intent.disposition === "abandoned") watch.cancel(A, G);
        at = input.readAt;
        const event = { ...source, messageId: "next-current", text: input.event.query, sentAt: at };
        const first = watch.observe(ctx, event), second = watch.observe(ctx, event);
        const replay = watch.create(ctx, proposal, { sources: [source] });
        const restarted = watches.createSocialInterestWatch(deps).create(ctx, proposal, { sources: [source] });
        return { available: true, created: created.ok, matched: first.matched, repeatMatched: second.matched,
          sameSessionReplayBlocked: !replay.ok, afterRestartRecreated: restarted.ok, persistentJournal: false };
      }
    };
  })();
  return baselinePromise;
}

const bot = (root, id = A) => root.socialAgents.bots[id];
function must(result, where) { insist(result?.ok === true, `FIXTURE_${where}_${result?.reason || result?.code || "FAILED"}`); return result; }
// Seed pattern reused from preference/journal self-tests: ingest actual human
// messages, append confirmed ACK experiences, then call REAL store mutators.
// Both variants receive clones of exactly this same raw synthetic history.
function rawHistory(input) {
  const root = { syntheticPrivate: { text: "SYNTHETIC_PRIVATE_DO_NOT_PROJECT" } };
  for (const [n, spec] of input.specs.entries()) for (let i = 0; i < 3; i++) {
    const sentAt = input.now - (3 - i) * DAY, messageId = `fixture:${n}:${i}`;
    if (spec.kind === "self") must(appendSocialExperience(root, { logicalId: spec.logicalId, conversationId: G, now: sentAt,
      sentAt, messageId, userId: U, text: `喜欢${spec.value}`, confirmed: true, kind: "bot_reply", agencyEligible: true }), "ACK");
    else must(ingestSocialMessage(root, { logicalId: spec.logicalId, conversationId: G, now: sentAt,
      message: { messageId, userId: spec.kind === "member" ? U : String(111 + i), text: `喜欢${spec.value}`,
        sentAt, receivedAt: sentAt, isBot: false, isQuoted: false } }), "HUMAN");
  }
  must(ingestSocialMessage(root, { logicalId: A, conversationId: G, now: input.now,
    message: { messageId: "source-current", userId: U, text: input.event.sourceText, sentAt: input.now - 200,
      receivedAt: input.now - 100, isBot: false, isQuoted: false } }), "CURRENT");
  return root;
}
function seedPreferences(root, input) {
  const outcomes = [];
  for (const [n, spec] of input.specs.entries()) {
    const coreText = spec.logicalId === A ? input.evidenceCore : input.cores[B];
    const view = getSocialPreferences(root, { logicalId: spec.logicalId, now: input.now });
    const result = must(recordSocialPreference(root, { ...spec, conversationId: G, expectedRevision: view.revision, now: input.now,
      evidenceMessageIds: [0, 1, 2].map(i => `fixture:${n}:${i}`), ...(spec.kind === "member" ? { userId: U } : {}),
      ...(spec.kind === "self" ? { coreText } : {}) }), "PREFERENCE");
    outcomes.push({ kind: spec.kind, status: result.status });
  }
  if (input.freezeGrowth) must(setSocialGrowthFrozen(root, { logicalId: A, expectedRevision: bot(root).socialPreferences.revision,
    frozen: true, actor: { authorized: true }, reason: "synthetic freeze", now: input.now }), "FREEZE");
  if (input.rejectSelf) must(reviewSocialPreference(root, { logicalId: A, id: bot(root).socialPreferences.entries[0].id,
    expectedRevision: bot(root).socialPreferences.revision, action: "reject", actor: { authorized: true },
    reason: "synthetic rejection", now: input.now }), "REJECT");
  return outcomes;
}
function candidateJournal(root, input) {
  if (!input.intent.enabled) return { available: true, proposed: false, selected: 0, selectedAfterClaim: 0, duplicateCreates: 0, status: null, restartReplayBlocked: null };
  const scope = { logicalId: A, conversationId: G, now: input.now };
  const proposal = { ...scope, kind: "opinion", summary: `关于${input.topic}的补充视角`, reason: "延续公开讨论",
    trigger: { kind: "related_message", terms: [input.topic] }, evidenceMessageIds: ["source-current"], ttlMs: input.intent.ttlMs };
  const rev = () => getSocialIntentJournal(root, scope).revision;
  const result = must(proposeSocialIntent(root, { ...proposal, expectedRevision: rev() }), "INTENT");
  const duplicate = must(proposeSocialIntent(root, { ...proposal, expectedRevision: rev() }), "INTENT_DUPLICATE");
  if (input.intent.disposition !== "candidate") must(settleSocialIntent(root, { ...scope, expectedRevision: rev(), id: result.id,
    status: input.intent.disposition, reason: "synthetic lifecycle" }), "SETTLE");
  const readScope = { ...scope, now: input.readAt, query: input.event.query, limit: 3 };
  const selected = selectRelevantSocialIntents(root, readScope);
  if (selected.length) must(settleSocialIntent(root, { ...scope, now: input.readAt, expectedRevision: rev(), id: selected[0].id,
    status: "pending", reason: "synthetic local claim only" }), "CLAIM");
  const after = selectRelevantSocialIntents(root, readScope);
  const restarted = copy(root), again = proposeSocialIntent(restarted, { ...proposal, now: input.readAt, expectedRevision: rev() });
  const entry = getSocialIntentJournal(root, { ...scope, now: input.readAt }).entries[0];
  return { available: true, proposed: true, selected: selected.length, selectedAfterClaim: after.length,
    duplicateCreates: duplicate.duplicate ? 0 : 1, status: entry.status,
    restartReplayBlocked: !again.ok || again.duplicate === true, permissionGrant: false };
}
function qzoneProbe(root, input) {
  if (!input.qzone.enabled) return { tested: false, candidateAvailable: null, publication: "NOT_RUN" };
  const policy = { enabled: true, shadowMode: false, conversationIds: [G], blockedTopics: input.qzone.mode === "blocked" ? [input.topic] : [] };
  must(beginDiscoveryRound(root, { logicalId: A, roundId: "fixture-public", now: input.now - 20, policy }), "DISCOVERY_BEGIN");
  const collected = must(finishDiscoveryRound(root, { logicalId: A, roundId: "fixture-public", now: input.now - 10, status: "complete", items: [{
    kind: "expression", title: input.qzone.mode === "private_text" ? "私聊记录" : `${input.topic}公开资料`, meaning: `${input.topic}主题的公开说明。`,
    applicable: input.topic, avoid: "严肃求助", confidence: 0.9,
    sources: [{ url: "https://example.org/synthetic-public-source", title: "虚构公开来源" }] }] }), "DISCOVERY_FINISH");
  const item = bot(root).discovery.items[0];
  const materialId = input.qzone.mode === "missing" || input.qzone.mode === "private_source" || !collected.accepted ? "fixture-missing" : item.id;
  const result = buildAgencyQzoneCandidate(root, { logicalId: A, conversationId: input.qzone.mode === "private_scope" ? `private:${U}` : G,
    materialId, motive: "interest", now: input.qzone.mode === "expired" && item ? item.expiresAt : input.readAt });
  return { tested: true, candidateAvailable: result.ok, code: result.code,
    audience: result.draft?.audience ?? null, sourceKind: result.draft?.source.kind ?? null, publication: "NOT_RUN" };
}
function channels(projected) {
  return { self: projected.self.map(({ dimension, value }) => ({ dimension, value })),
    group: projected.group.map(({ dimension, value }) => ({ dimension, value })), member: projected.member.map(({ dimension, value }) => ({ dimension, value })) };
}
async function candidate(root, input) {
  const recorded = seedPreferences(root, input);
  const args = { ...input.scope, query: input.event.query, now: input.readAt, coreText: input.cores[A] };
  const selected = selectAgencyDiscoveryInterests(root, { logicalId: A, now: input.readAt, coreText: input.cores[A], ...input.configuration,
    maxQueries: input.configuration.maxQueries, roleCardEnabled: true });
  insist(!selected.excluded.includes("invalid_state"), "CANDIDATE_SELECTOR_STATE");
  const projected = agencyPreferenceContext(root, args);
  insist(projected.ok, "CANDIDATE_CONTEXT_STATE");
  const peer = agencyPreferenceContext(root, { ...args, logicalId: B, conversationId: G, userId: U, coreText: input.cores[B] });
  insist(peer.ok, "CANDIDATE_PEER_STATE");
  const allowed = agencyGrowthAllowed(root, { logicalId: A, field: input.proposal.field, value: input.proposal.value,
    coreText: input.cores[A], now: input.readAt });
  const growth = allowed ? applySelfRoleCard(root, { logicalId: A, expectedRevision: getSelfRoleCard(root, { logicalId: A }).revision,
    fields: { [input.proposal.field]: input.proposal.value }, reason: "synthetic verified growth", evidenceMessageIds: input.growthEvidenceIds,
    now: input.readAt, policy: { enabled: true, autoGrow: true } }) : { ok: false, code: "AGENCY_GROWTH_NOT_VERIFIED" };
  const journal = candidateJournal(root, input);
  // Also try to turn human evidence into self: the REAL writer must refuse.
  const forged = recordSocialPreference(root, { logicalId: A, conversationId: G, kind: "self", dimension: "interest", value: input.alternate,
    coreText: input.cores[A], evidenceMessageIds: ["source-current"], expectedRevision: bot(root).socialPreferences.revision, now: input.readAt });
  const qzone = qzoneProbe(root, input);
  const authorityFields = ["sendAllowed", "contactAllowed", "publishAllowed", "grantsAuthority", "execute"];
  const authorityGrant = [selected, projected, peer, journal, qzone].some(view => authorityFields.some(key => view[key] === true));
  return { discovery: { tags: selected.interests, sources: selected.sources.map(source => source.kind), querySlots: selected.interests.length,
    emptySelection: selected.interests.length === 0, runtimeDefaultFallback: "NOT_EXECUTED_SELECTOR_ONLY" },
    growth: { accepted: growth.ok, code: growth.code ?? "ROLE_CARD_APPLIED" }, context: channels(projected), peerContext: channels(peer),
    recorded, forgedSelfRejected: !forged.ok, journal, qzone,
    modalitySelection: "NOT_RUN_CONTEXT_ONLY", actualAction: "NOT_RUN", permissionGrant: authorityGrant };
}

function ruleProxies(rows) {
  const sum = fn => rows.reduce((n, row) => n + Number(fn(row)), 0);
  const eligibleGrowth = rows.filter(row => ["group-self-conflict", "repeated-member-preference", "multiple-opinions", "privacy-isolation"].includes(row.category));
  const groupCases = rows.filter(row => row.category === "multi-bot-expression" || row.category === "expression-modalities");
  return {
    evidenceKind: "SYNTHETIC_RULE_PROXIES_NOT_BEHAVIOR_QUALITY",
    relevance: { definition: "selected public tag literally matches the fixture's topic; not reply relevance or search quality",
      eligible: rows.length, baselineMatched: sum(row => row.baseline.discovery.tags.some(tag => tag.includes(row.topic))),
      candidateMatched: sum(row => row.candidate.discovery.tags.some(tag => tag.includes(row.topic))) },
    interruptionRisk: { definition: "selected discovery tags lack current event-topic overlap; NOT observed wrong interjections",
      baselineUnmatchedTags: rows.reduce((n, row) => n + row.baseline.discovery.tags.filter(tag => !tag.includes(row.topic)).length, 0),
      candidateUnmatchedTags: rows.reduce((n, row) => n + row.candidate.discovery.tags.filter(tag => !tag.includes(row.topic)).length, 0), actualWrongInterjections: "NOT_RUN" },
    repetition: { definition: "same-source create/claim is not a second journal candidate; old one-shot attention measured separately",
      candidateDuplicateCreates: sum(row => row.candidate.journal.duplicateCreates), candidateReofferedAfterClaim: sum(row => row.candidate.journal.selectedAfterClaim),
      baselineRepeatedWatchMatches: sum(row => row.baseline.attention.repeatMatched), actualRepeatedMessages: "NOT_RUN" },
    personaOwnership: { definition: "group/member-origin proposed role-card interest accepted without verified self; risk proxy, not a claim of actual persona drift",
      eligible: eligibleGrowth.length, baselineUnverifiedGrowthAccepted: eligibleGrowth.filter(row => row.baseline.growth.accepted).length,
      candidateUnverifiedGrowthAccepted: eligibleGrowth.filter(row => row.candidate.growth.accepted).length,
      candidateForgedSelfRejected: sum(row => row.candidate.forgedSelfRejected) },
    permissions: { definition: "count true sendAllowed/contactAllowed/publishAllowed/grantsAuthority/execute fields in actual projections; not a full wire-time authorization audit",
      candidateAuthorityGrants: sum(row => row.candidate.permissionGrant), realExternalActions: 0 },
    expiry: { definition: "expired fixture intent is not returned by the real journal selector",
      eligible: rows.filter(row => row.category === "intent-expired").length,
      expiredCandidateIntentsOffered: sum(row => row.category === "intent-expired" && row.candidate.journal.selected > 0) },
    multiBotActionContext: { definition: "different scoped preference JSON for two bots on identical input; NOT observed different actions",
      eligible: groupCases.length, distinctContextPairs: groupCases.filter(row => digest(row.candidate.context.self) !== digest(row.candidate.peerContext.self)).length,
      actualDifferentActions: "NOT_RUN" },
    qzone: { definition: "real public-source candidate builder, no draft write, approval or publication",
      tested: sum(row => row.candidate.qzone.tested), candidates: sum(row => row.candidate.qzone.candidateAvailable === true), publications: 0 },
    budgetBound: { definition: "selector query slots before runtime scheduling, not performed requests",
      baselineSlots: rows.reduce((n, row) => n + row.baseline.discovery.querySlots, 0), candidateSlots: rows.reduce((n, row) => n + row.candidate.discovery.querySlots, 0),
      baselineMaximum: Math.max(...rows.map(row => row.baseline.discovery.querySlots)), candidateMaximum: Math.max(...rows.map(row => row.candidate.discovery.querySlots)),
      overConfiguredLimit: sum(row => row.candidate.discovery.querySlots > Math.min(3, row.maxQueries)) }
  };
}

export async function evaluateSocialAgencyScenarios({ includeCases = false } = {}) {
  const old = await loadAgencyBaselineAdapter(), rows = [];
  const sourceParity = { ...copy(old.metadata), candidateFiles: candidatePaths.map(path => ({ path,
    sha256: sha(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) })) };
  for (const scene of SOCIAL_AGENCY_SCENARIOS) {
    const input = copy(scene.input), oldInput = copy(scene.input), newInput = copy(scene.input);
    const before = digest(input), raw = rawHistory(input), oldRoot = copy(raw), newRoot = copy(raw);
    insist(digest(oldRoot) === digest(newRoot), "INITIAL_ROOT_PARITY");
    insist(digest(oldInput) === digest(newInput), "INITIAL_INPUT_PARITY");
    const baseline = { discovery: old.select(oldInput), growth: await old.grow(oldRoot, oldInput), attention: old.attention(oldInput),
      preferenceChannels: "UNAVAILABLE_IN_BASELINE", actualAction: "NOT_RUN", automaticQzoneCandidate: "UNAVAILABLE_IN_BASELINE" };
    const observed = await candidate(newRoot, newInput);
    insist(digest(oldInput) === before && digest(newInput) === before, "MUTATED_INPUT");
    rows.push({ id: scene.id, category: scene.category, topic: input.topic, maxQueries: input.configuration.maxQueries,
      synthetic: true, inputParity: { baseline: digest(oldInput), candidate: digest(newInput) }, baseline, candidate: observed });
  }
  const coverage = SOCIAL_AGENCY_CATEGORIES.map(category => ({ ...category, cases: rows.filter(row => row.category === category.id).length }));
  return { schema: SCHEMA, sourceParity, synthetic: true, corpusHash: SOCIAL_AGENCY_CORPUS_HASH,
    cases: rows.length, coverage, sameInputPairs: rows.length,
    ruleProxies: ruleProxies(rows), actualModel: "NOT_RUN", actualQQ: "NOT_RUN", actualHuman: "NOT_RUN",
    naturalness: "NOT_RUN", opinionIndependence: "NOT_RUN", nonIntrusiveness: "NOT_RUN", factualAccuracy: "NOT_RUN",
    budgets: { actualCalls: 0, networkCalls: 0, modelCalls: 0, qqActions: 0, tokens: null,
      tokenAccounting: "UNKNOWN_NOT_ZERO", actualPaidCost: "NOT_RUN", productionDailyCost: "NOT_RUN" },
    limitations: ["150 deterministic synthetic scenarios validate mechanisms, not natural conversations or independent viewpoints",
      "baseline adapter executes pinned selection/growth and interest-watch rules; not a full old process or model output",
      "candidate uses real preference/context/growth/journal/public-candidate APIs on isolated synthetic roots",
      "modality preferences are context only; actual sticker/voice/poke selection, fallback and wire are NOT_RUN",
      "no model, QQ protocol, human identity/rating or naturalness/independence gate was run",
      "source availability and lexical overlap are rule proxies, not factual truth or public search success",
      "empty new selection is not silently filled here; existing DiscoveryRuntime alone controls its defaults" ],
    ...(includeCases ? { pairs: rows } : {}) };
}

export function agencyReplayTemplate() {
  return { schema: SCHEMA, corpusHash: SOCIAL_AGENCY_CORPUS_HASH, declaredSource: "synthetic", evidenceStatus: "UNVERIFIED_EXTERNAL_JSON",
    pairs: SOCIAL_AGENCY_SCENARIOS.map(scene => ({ id: scene.id, baseline: { input: copy(scene.input), output: null, model: null,
      metrics: { calls: null, inputTokens: null, outputTokens: null } }, candidate: { input: copy(scene.input), output: null, model: null,
      metrics: { calls: null, inputTokens: null, outputTokens: null } } })) };
}
function fields(object, names) { insist(plain(object) && Object.keys(object).length === names.length
  && names.every(name => Object.hasOwn(object, name)), "REPLAY_FIELDS"); }
/** Offline, unverified imported outputs only. NEVER authenticates humanity or
 * model execution; never self-scores naturalness/independent opinions. Unknown
 * token counts remain null, and declared counts are NOT this runner's usage.
 */
export function evaluateAgencyReplay(packet) {
  agencyCanonicalJSON(packet);
  fields(packet, ["schema", "corpusHash", "declaredSource", "evidenceStatus", "pairs"]);
  insist(packet.schema === SCHEMA && packet.corpusHash === SOCIAL_AGENCY_CORPUS_HASH
    && packet.evidenceStatus === "UNVERIFIED_EXTERNAL_JSON" && ["synthetic", "external-model", "external-human"].includes(packet.declaredSource), "REPLAY_IDENTITY");
  insist(Array.isArray(packet.pairs) && packet.pairs.length === SOCIAL_AGENCY_SCENARIOS.length, "REPLAY_INCOMPLETE");
  const expected = new Map(SOCIAL_AGENCY_SCENARIOS.map(scene => [scene.id, scene])), seen = new Set();
  const variants = { baseline: { repeatedText: 0, unavailableModality: 0, quietOutput: 0, declaredCalls: [], inputTokens: [], outputTokens: [] },
    candidate: { repeatedText: 0, unavailableModality: 0, quietOutput: 0, declaredCalls: [], inputTokens: [], outputTokens: [] } };
  let modelHash;
  const prior = { baseline: new Set(), candidate: new Set() };
  for (const pair of packet.pairs) {
    fields(pair, ["id", "baseline", "candidate"]);
    const scene = expected.get(pair.id); insist(scene && !seen.has(pair.id), "REPLAY_CASE_ID"); seen.add(pair.id);
    for (const variant of ["baseline", "candidate"]) {
      const run = pair[variant], counts = variants[variant];
      fields(run, ["input", "output", "model", "metrics"]);
      insist(digest(run.input) === digest(scene.input), "REPLAY_INPUT_MISMATCH");
      fields(run.output, ["action", "text"]);
      insist(["reply", "observe", "wait", "sticker", "voice", "poke", "draft"].includes(run.output.action)
        && typeof run.output.text === "string" && run.output.text.length <= 10000, "REPLAY_OUTPUT");
      insist(!["observe", "wait"].includes(run.output.action) || run.output.text === "", "REPLAY_SILENT_TEXT");
      if (packet.declaredSource === "external-model") {
        fields(run.model, ["provider", "name", "revision", "generation"]);
        insist([run.model.provider, run.model.name, run.model.revision].every(value => typeof value === "string" && value.trim() && value.length <= 128)
          && plain(run.model.generation), "REPLAY_MODEL_IDENTITY");
        const identity = digest(run.model);
        insist(!modelHash || modelHash === identity, "REPLAY_MODEL_MISMATCH"); modelHash = identity;
      } else insist(run.model === null, "REPLAY_UNEXPECTED_MODEL");
      fields(run.metrics, ["calls", "inputTokens", "outputTokens"]);
      for (const field of ["calls", "inputTokens", "outputTokens"]) insist(run.metrics[field] === null || uint(run.metrics[field]), "REPLAY_USAGE");
      counts.declaredCalls.push(run.metrics.calls); counts.inputTokens.push(run.metrics.inputTokens); counts.outputTokens.push(run.metrics.outputTokens);
      const text = run.output.text.trim();
      if (text && prior[variant].has(text)) counts.repeatedText++;
      if (text) prior[variant].add(text);
      if (["sticker", "voice", "poke"].includes(run.output.action) && !scene.input.capabilities[run.output.action]) counts.unavailableModality++;
      if (scene.input.event.quiet && !["observe", "wait"].includes(run.output.action)) counts.quietOutput++;
    }
  }
  const usage = values => {
    const known = values.filter(value => value !== null), subtotal = known.reduce((a, b) => { insist(uint(a + b), "REPLAY_USAGE_OVERFLOW"); return a + b; }, 0);
    return { knownRows: known.length, unknownRows: values.length - known.length, knownSubtotal: subtotal, total: values.includes(null) ? null : subtotal };
  };
  return { schema: SCHEMA, corpusHash: SOCIAL_AGENCY_CORPUS_HASH, cases: seen.size, inputParity: true,
    evidenceStatus: "UNVERIFIED_EXTERNAL_JSON", declaredSource: packet.declaredSource,
    ruleProxies: Object.fromEntries(Object.entries(variants).map(([variant, metrics]) => [variant, { evidenceKind: "OFFLINE_RULE_PROXIES",
      repeatedText: metrics.repeatedText, unavailableModality: metrics.unavailableModality, quietOutput: metrics.quietOutput,
      declaredCalls: usage(metrics.declaredCalls), inputTokens: usage(metrics.inputTokens), outputTokens: usage(metrics.outputTokens) }])),
    actualModel: "NOT_RUN", actualQQ: "NOT_RUN", actualHuman: "NOT_RUN", naturalness: "NOT_RUN", opinionIndependence: "NOT_RUN",
    budgets: { actualCalls: 0, tokens: null }, warning: "Imported claims are not verified model/human evidence; quiet/modality/repetition are proxies, not quality ratings." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2] ?? "--summary";
    insist(process.argv.length <= 3, "CLI_ARGUMENTS");
    if (command === "--fixtures") console.log(JSON.stringify({ schema: SCHEMA, corpusHash: SOCIAL_AGENCY_CORPUS_HASH, scenarios: SOCIAL_AGENCY_SCENARIOS }));
    else if (command === "--replay-template") console.log(JSON.stringify(agencyReplayTemplate()));
    else if (command === "--replay-stdin") {
      const input = readFileSync(0, "utf8"); insist(Buffer.byteLength(input) <= 10 * 1024 * 1024, "REPLAY_SIZE");
      console.log(JSON.stringify(evaluateAgencyReplay(JSON.parse(input))));
    } else {
      insist(["--summary", "--cases"].includes(command), "CLI_COMMAND");
      console.log(JSON.stringify(await evaluateSocialAgencyScenarios({ includeCases: command === "--cases" })));
    }
  } catch (error) {
    // Never echo imported text, absolute paths, source code, stderr or secrets.
    const code = typeof error?.message === "string" && /^AGENCY_EVALUATION_[A-Z0-9_]+$/.test(error.message) ? error.message : "AGENCY_EVALUATION_FAILED";
    console.error(JSON.stringify({ ok: false, code })); process.exitCode = 1;
  }
}
