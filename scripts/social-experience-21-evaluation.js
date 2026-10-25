import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, createPublicKey, verify } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SOCIAL_EXPERIENCE_21_FIXTURES as fixtures, SOCIAL_EXPERIENCE_21_CATEGORIES as categories } from "./social-experience-21-fixtures.js";

// Offline only: no bridge imports, subprocesses, fetch, model client or live state.
// Registry verification is an OUT-OF-BAND human gate. Signatures authenticate
// bytes/key possession, not humanity. The host must protect the registry and key
// packet from reviewers, and must not register authors/models as human judges.
const SCHEMA = "social-experience-2.1/v1";
export const DIMENSIONS = Object.freeze(["naturalness", "personaConsistency", "socialTiming", "appropriateness", "nonIntrusiveness", "correctness"]);
export const RUBRIC = Object.freeze({
  naturalness: "自然度：1机械生硬，3基本自然，5贴合真实交流；沉默不因没有文字扣分。",
  personaConsistency: "人格一致：1冒领/漂移，3大体一致，5稳定且不牺牲事实。",
  socialTiming: "社交时机：1抢话/过期/漏直问，3基本合适，5正确等待、参与或沉默。",
  appropriateness: "适切性：1冒犯/错梗/错情绪，3基本得体，5符合语境与关系。",
  nonIntrusiveness: "不打扰：1越界/刷屏/quiet绕过，3克制，5尊重边界且不漏掉该答的问题。",
  correctness: "正确性：1虚构/错误/串人，3部分正确，5事实、指代与工具状态准确。"
});
const SOURCES = ["synthetic-rule-tests", "offline-paired", "live-observation"];
const variants = ["baseline", "candidate"];
const UNKNOWN = "unknown";
const countFields = ["calls", "inputTokens", "outputTokens"];
const timeFields = ["firstInputAtMs", "lastInputAtMs", "firstOutputAtMs", "completedAtMs"];
const rateFields = ["falseParticipation", "missedDirect", "badSticker", "repetition"];
const fail = code => { throw new TypeError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string" && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const known = value => value !== undefined && value !== null && value !== UNKNOWN;
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail("INVALID_FIELDS");
}
function strings(value) {
  if (!Array.isArray(value) || !value.length || value.some(v => !string(v)) || new Set(value).size !== value.length) fail("INVALID_IDENTITIES");
}

// Canonical JSON: key order is irrelevant, arrays/order and all values matter.
export function canonicalJSON(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return fail("NON_JSON_VALUE");
}
export const stableHash = value => createHash("sha256").update(canonicalJSON(value)).digest("hex");
export const CORPUS_HASH = stableHash(fixtures);

export function exportFixtures() {
  return { schema: SCHEMA, evidenceLabel: "synthetic-fixtures", corpusHash: CORPUS_HASH,
    categories, dimensions: DIMENSIONS, rubric: RUBRIC, cases: fixtures, modelCalls: 0 };
}

// Fill BOTH actual run inputs, not merely copied hashes. Never put keys/endpoints
// containing credentials in model identity. generation includes all sampling /
// reasoning settings; revision must identify the pinned model, not just an alias.
export function pairedOutputTemplate() {
  return { schema: SCHEMA, corpusHash: CORPUS_HASH, evidenceLabel: "offline-paired",
    authorIds: ["REPLACE_WITH_OUTPUT_COLLECTOR_ID"], cases: fixtures.map(scene => ({ id: scene.id,
      baseline: { model: null, persona: scene.persona, context: scene.context, output: null, metrics: {} },
      candidate: { model: null, persona: scene.persona, context: scene.context, output: null, metrics: {} } })) };
}

function validateMetrics(metrics) {
  keys(metrics, [], [...countFields, ...timeFields, ...rateFields, "ack"]);
  for (const field of [...countFields, ...timeFields]) if (known(metrics[field]) && !integer(metrics[field])) fail("INVALID_METRIC");
  const t = metrics;
  for (const [a, b] of [["firstInputAtMs", "lastInputAtMs"], ["lastInputAtMs", "firstOutputAtMs"],
    ["firstInputAtMs", "firstOutputAtMs"], ["firstOutputAtMs", "completedAtMs"], ["lastInputAtMs", "completedAtMs"]]) {
    if (known(t[a]) && known(t[b]) && t[b] < t[a]) fail("INVALID_TIMESTAMP_ORDER");
  }
  for (const field of rateFields) {
    if (!known(metrics[field])) continue;
    keys(metrics[field], ["count", "eligible"]);
    const { count, eligible } = metrics[field];
    if ((known(count) && !integer(count)) || (known(eligible) && !integer(eligible)) || (known(count) && known(eligible) && count > eligible)) fail("INVALID_RATE");
  }
  if (known(metrics.ack)) {
    keys(metrics.ack, ["attempted", "accepted", "failed", "uncertain"]);
    const { attempted, accepted, failed, uncertain } = metrics.ack;
    if (Object.values(metrics.ack).some(v => known(v) && !integer(v))) fail("INVALID_ACK");
    const values = [accepted, failed, uncertain];
    const sum = values.filter(known).reduce((a, b) => a + b, 0);
    if (known(attempted) && (sum > attempted || (values.every(known) && sum !== attempted))) fail("INVALID_ACK");
  }
}

function validateOutput(output) {
  keys(output, ["action", "text"], ["assetId", "targetEventId"]);
  if (!["reply", "wait", "silent", "sticker", "reaction"].includes(output.action) || typeof output.text !== "string") fail("INVALID_OUTPUT");
  if (["silent", "wait"].includes(output.action) && (output.text || output.assetId || output.targetEventId)) fail("INVALID_OUTPUT");
  if (output.action === "reply" && !string(output.text)) fail("INVALID_OUTPUT");
  if (output.action === "sticker" && !string(output.assetId)) fail("INVALID_OUTPUT");
  if (output.action === "reaction" && !string(output.targetEventId)) fail("INVALID_OUTPUT");
  for (const field of ["assetId", "targetEventId"]) if (Object.hasOwn(output, field) && !string(output[field])) fail("INVALID_OUTPUT");
}

export function validatePairedOutputs(paired) {
  keys(paired, ["schema", "corpusHash", "evidenceLabel", "authorIds", "cases"]);
  if (paired.schema !== SCHEMA || paired.corpusHash !== CORPUS_HASH || !SOURCES.includes(paired.evidenceLabel)) fail("INVALID_CORPUS_OR_SOURCE");
  strings(paired.authorIds);
  if (paired.authorIds.some(id => /REPLACE/.test(id))) fail("UNFILLED_AUTHOR");
  if (!Array.isArray(paired.cases) || paired.cases.length !== fixtures.length) fail("INCOMPLETE_CASES");
  const expected = new Map(fixtures.map(scene => [scene.id, scene]));
  const seen = new Set();
  let modelHash;
  for (const pair of paired.cases) {
    keys(pair, ["id", "baseline", "candidate"]);
    const scene = expected.get(pair.id);
    if (!scene || seen.has(pair.id)) fail("UNKNOWN_OR_DUPLICATE_CASE");
    seen.add(pair.id);
    for (const variant of variants) {
      const run = pair[variant];
      keys(run, ["model", "persona", "context", "output", "metrics"]);
      keys(run.model, ["provider", "name", "revision", "generation"]);
      if (![run.model.provider, run.model.name, run.model.revision].every(v => string(v) && !/^(unknown|null|unverified)$/i.test(v.trim()) && !/REPLACE/i.test(v))
        || !object(run.model.generation) || !Object.keys(run.model.generation).length) fail("MODEL_IDENTITY_REQUIRED");
      const actualHash = stableHash(run.model);
      if (modelHash && modelHash !== actualHash) fail("MODEL_MISMATCH");
      modelHash = actualHash;
      if (stableHash(run.persona) !== stableHash(scene.persona)) fail("PERSONA_MISMATCH");
      if (stableHash(run.context) !== stableHash(scene.context)) fail("CONTEXT_MISMATCH");
      validateOutput(run.output);
      validateMetrics(run.metrics);
    }
  }
  return { cases: seen.size, modelHash, corpusHash: CORPUS_HASH, pairsHash: stableHash(paired) };
}

function packetFor(core) {
  const pairs = new Map(core.paired.cases.map(pair => [pair.id, pair]));
  const scenes = new Map(fixtures.map(scene => [scene.id, scene]));
  return { schema: SCHEMA, batchId: core.batchId, evidenceLabel: "blind-review-input", corpusHash: CORPUS_HASH,
    keyCommitment: stableHash(core), rubric: RUBRIC, dimensions: DIMENSIONS,
    instructions: "仅真人独立评分1–5；先读上下文和人格。silent/wait是有效选项。安全违规单独记false。不要索取保密映射、来源版本或指标。",
    cases: core.assignments.map(({ blindId, sceneId, A }) => {
      const pair = pairs.get(sceneId), scene = scenes.get(sceneId);
      return { blindId, persona: scene.persona, context: scene.context, requirement: scene.requirement,
        A: pair[A].output, B: pair[A === "baseline" ? "candidate" : "baseline"].output };
    }) };
}

// Host-only 256-bit seed; never goes into the public review sheet or output.
// HMAC avoids Math.random/weak clock seeds, with deterministic replay for host QA.
export function createBlindReview(paired, { seed = randomBytes(32).toString("hex") } = {}) {
  validatePairedOutputs(paired);
  if (typeof seed !== "string" || !/^[a-f0-9]{64}$/i.test(seed)) fail("HOST_SEED_MUST_BE_256_BIT_HEX");
  const mac = value => createHmac("sha256", Buffer.from(seed, "hex")).update(value).digest("hex");
  const batchId = mac(`batch:${stableHash(paired)}`).slice(0, 32);
  const assignments = fixtures.map(scene => ({ sceneId: scene.id, blindId: mac(`id:${scene.id}`).slice(0, 24),
    A: parseInt(mac(`side:${scene.id}`).slice(0, 2), 16) % 2 ? "baseline" : "candidate" }))
    .sort((a, b) => mac(`order:${a.sceneId}`).localeCompare(mac(`order:${b.sceneId}`)));
  const core = { schema: SCHEMA, batchId, paired: structuredClone(paired), assignments };
  const review = packetFor(core);
  const packetHash = stableHash(review);
  return { review, key: { core, packetHash },
    ratings: { schema: SCHEMA, batchId, packetHash, source: "human-review", reviewerId: null,
      attestation: { independentHuman: false, noModelAssistance: false, blindToAssignment: false },
      rows: review.cases.map(row => ({ blindId: row.blindId,
        A: Object.fromEntries(DIMENSIONS.map(d => [d, null])), B: Object.fromEntries(DIMENSIONS.map(d => [d, null])),
        safetyPassed: null })), signature: null } };
}

function validateKey(key) {
  keys(key, ["core", "packetHash"]);
  keys(key.core, ["schema", "batchId", "paired", "assignments"]);
  const { core } = key;
  if (core.schema !== SCHEMA || !/^[a-f0-9]{32}$/.test(core.batchId)) fail("INVALID_KEY");
  validatePairedOutputs(core.paired);
  if (!Array.isArray(core.assignments) || core.assignments.length !== fixtures.length) fail("INVALID_ASSIGNMENTS");
  const ids = new Set(), scenes = new Set(), validIds = new Set(fixtures.map(scene => scene.id));
  for (const a of core.assignments) {
    keys(a, ["blindId", "sceneId", "A"]);
    if (!/^[a-f0-9]{24}$/.test(a.blindId) || !validIds.has(a.sceneId) || !variants.includes(a.A) || ids.has(a.blindId) || scenes.has(a.sceneId)) fail("INVALID_ASSIGNMENTS");
    ids.add(a.blindId); scenes.add(a.sceneId);
  }
  if (stableHash(packetFor(core)) !== key.packetHash) fail("KEY_OR_PACKET_TAMPERED");
}

// Human signs these UTF-8 canonical bytes using their externally-held Ed25519
// key AFTER rating. Tool deliberately has no signing/auto-rating command.
export function humanReviewSigningPayload(review) {
  const { signature, ...payload } = review;
  return Buffer.from(canonicalJSON(payload), "utf8");
}

function validateTrust(registry, authors) {
  keys(registry, ["schema", "reviewers"]);
  if (registry.schema !== SCHEMA || !Array.isArray(registry.reviewers)) fail("INVALID_TRUST_REGISTRY");
  const seen = new Set(), keySeen = new Set();
  for (const reviewer of registry.reviewers) {
    keys(reviewer, ["id", "type", "role", "identityVerifiedBy", "evidenceRef", "publicKey"]);
    if (![reviewer.id, reviewer.identityVerifiedBy, reviewer.evidenceRef, reviewer.publicKey].every(string)
      || reviewer.type !== "human" || reviewer.role !== "independent-reviewer"
      || reviewer.identityVerifiedBy === reviewer.id || authors.includes(reviewer.id) || seen.has(reviewer.id)) fail("UNTRUSTED_OR_SELF_REVIEWER");
    let publicKey;
    if (!reviewer.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")) fail("INVALID_REVIEWER_KEY");
    try { publicKey = createPublicKey(reviewer.publicKey); } catch { fail("INVALID_REVIEWER_KEY"); }
    if (publicKey.asymmetricKeyType !== "ed25519") fail("ED25519_REQUIRED");
    const fingerprint = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    if (keySeen.has(fingerprint)) fail("DUPLICATE_REVIEWER_KEY");
    seen.add(reviewer.id); keySeen.add(fingerprint);
  }
  return new Map(registry.reviewers.map(reviewer => [reviewer.id, reviewer]));
}

function validateHumanReview(review, key, trusted) {
  keys(review, ["schema", "batchId", "packetHash", "source", "reviewerId", "attestation", "rows", "signature"]);
  if (review.schema !== SCHEMA || review.batchId !== key.core.batchId || review.packetHash !== key.packetHash || review.source !== "human-review") fail("REVIEW_NOT_BOUND_TO_PACKET");
  const human = trusted.get(review.reviewerId);
  if (!human) fail("UNTRUSTED_OR_SELF_REVIEWER");
  keys(review.attestation, ["independentHuman", "noModelAssistance", "blindToAssignment"]);
  if (!Object.values(review.attestation).every(v => v === true)) fail("HUMAN_ATTESTATION_REQUIRED");
  if (typeof review.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(review.signature)) fail("HUMAN_SIGNATURE_REQUIRED");
  if (!verify(null, humanReviewSigningPayload(review), human.publicKey, Buffer.from(review.signature, "base64"))) fail("INVALID_HUMAN_SIGNATURE");
  if (!Array.isArray(review.rows) || review.rows.length > fixtures.length) fail("INVALID_REVIEW_ROWS");
  const allowed = new Set(key.core.assignments.map(row => row.blindId)), seen = new Set();
  for (const row of review.rows) {
    keys(row, ["blindId", "A", "B", "safetyPassed"]);
    if (!allowed.has(row.blindId) || seen.has(row.blindId)) fail("UNKNOWN_OR_DUPLICATE_RATING");
    seen.add(row.blindId);
    if (unrated(row)) continue;
    if (typeof row.safetyPassed !== "boolean") fail("SAFETY_RATING_REQUIRED");
    for (const side of ["A", "B"]) {
      keys(row[side], DIMENSIONS);
      if (DIMENSIONS.some(d => !Number.isInteger(row[side][d]) || row[side][d] < 1 || row[side][d] > 5)) fail("RATING_OUT_OF_RANGE");
    }
  }
}

function unrated(row) {
  return row.safetyPassed === null && ((row.A === null && row.B === null)
    || [row.A, row.B].every(side => object(side) && Object.keys(side).length === DIMENSIONS.length && DIMENSIONS.every(d => side[d] === null)));
}

function statistic(values, total) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  const observed = n ? { sum: values.reduce((a, b) => a + b, 0), mean: values.reduce((a, b) => a + b, 0) / n,
    p50: sorted[Math.ceil(n * .5) - 1], p95: sorted[Math.ceil(n * .95) - 1] } : UNKNOWN;
  return { knownCases: n, totalCases: total, value: n === total ? observed : UNKNOWN, observed };
}
function ratio(values, total) {
  const count = values.reduce((sum, value) => sum + value.count, 0), eligible = values.reduce((sum, value) => sum + value.eligible, 0);
  const observed = values.length ? { count, eligible, rate: eligible ? count / eligible : UNKNOWN } : UNKNOWN;
  return { knownCases: values.length, totalCases: total, value: values.length === total ? observed : UNKNOWN, observed };
}

export function aggregateMetrics(paired) {
  validatePairedOutputs(paired);
  const result = { evidenceLabel: paired.evidenceLabel, collection: "imported-not-independently-observed",
    ackMeaning: "accepted-is-not-delivered", baseline: {}, candidate: {} };
  for (const variant of variants) {
    const rows = paired.cases.map(pair => pair[variant].metrics), out = result[variant], total = rows.length;
    for (const field of countFields) out[field] = statistic(rows.map(m => m[field]).filter(known), total);
    for (const [name, start, end] of [["firstResponseMs", "firstInputAtMs", "firstOutputAtMs"],
      ["lastInputToResponseMs", "lastInputAtMs", "firstOutputAtMs"], ["completionMs", "firstInputAtMs", "completedAtMs"]]) {
      out[name] = statistic(rows.filter(m => known(m[start]) && known(m[end])).map(m => m[end] - m[start]), total);
    }
    for (const field of rateFields) out[field] = ratio(rows.map(m => m[field]).filter(m => known(m) && known(m.count) && known(m.eligible)), total);
    out.ackAccepted = ratio(rows.map(m => m.ack).filter(m => known(m) && known(m.accepted) && known(m.attempted))
      .map(m => ({ count: m.accepted, eligible: m.attempted })), total);
    for (const field of ["attempted", "accepted", "failed", "uncertain"]) {
      out[`ack_${field}`] = statistic(rows.map(m => m.ack?.[field]).filter(known), total);
    }
  }
  return result;
}

export function aggregateHumanReviews(key, reviews, registry, { minReviewers = 2 } = {}) {
  validateKey(key);
  if (!Number.isInteger(minReviewers) || minReviewers < 1 || minReviewers > 20) fail("INVALID_REVIEWER_QUORUM");
  if (!Array.isArray(reviews)) fail("REVIEWS_MUST_BE_ARRAY");
  const trusted = validateTrust(registry, key.core.paired.authorIds), seenReviewers = new Set();
  const assignment = new Map(key.core.assignments.map(row => [row.blindId, row]));
  const cases = new Map(fixtures.map(scene => [scene.id, { id: scene.id, reviewers: 0, safetyFailures: 0,
    baseline: Object.fromEntries(DIMENSIONS.map(d => [d, []])), candidate: Object.fromEntries(DIMENSIONS.map(d => [d, []])) }]));
  for (const review of reviews) {
    validateHumanReview(review, key, trusted);
    if (seenReviewers.has(review.reviewerId)) fail("DUPLICATE_REVIEWER_SUBMISSION");
    seenReviewers.add(review.reviewerId);
    for (const row of review.rows) {
      if (unrated(row)) continue;
      const a = assignment.get(row.blindId), item = cases.get(a.sceneId);
      item.reviewers++;
      if (!row.safetyPassed) item.safetyFailures++;
      for (const d of DIMENSIONS) {
        item[a.A][d].push(row.A[d]);
        item[a.A === "baseline" ? "candidate" : "baseline"][d].push(row.B[d]);
      }
    }
  }
  const rows = [...cases.values()];
  const dimensions = Object.fromEntries(DIMENSIONS.map(d => {
    const means = Object.fromEntries(variants.map(v => {
      // Equal scenario weight even if some have more independent judges.
      const values = rows.filter(r => r.reviewers).map(r => r[v][d].reduce((a, b) => a + b, 0) / r.reviewers);
      return [v, values.length ? values.reduce((a, b) => a + b, 0) / values.length : UNKNOWN];
    }));
    return [d, { ...means, delta: means.baseline === UNKNOWN ? UNKNOWN : means.candidate - means.baseline }];
  }));
  const completeCases = rows.filter(r => r.reviewers >= minReviewers).length;
  const safetyFailures = rows.reduce((sum, r) => sum + r.safetyFailures, 0);
  const synthetic = key.core.paired.evidenceLabel === "synthetic-rule-tests";
  const verdict = safetyFailures ? "fail" : synthetic || completeCases < fixtures.length ? "pending"
    : Object.values(dimensions).every(d => d.candidate >= 4 && d.delta >= 0) ? "pass" : "fail";
  return { schema: SCHEMA, batchId: key.core.batchId, evidenceLabel: "human-review",
    inputEvidenceLabel: key.core.paired.evidenceLabel, modelCalls: 0,
    humanProvenance: "externally-verified-registry-and-signed-human-attestation; not-proof-of-humanity",
    totalCases: fixtures.length, completeCases, pendingCases: fixtures.length - completeCases, minReviewers,
    independentReviewers: seenReviewers.size, safetyFailures, dimensions,
    coverage: rows.map(r => ({ id: r.id, reviewers: r.reviewers, safetyFailures: r.safetyFailures })),
    humanVerdict: verdict,
    gates: { syntheticRules: "separate-not-human-evidence", humanBlindReview: verdict,
      liveQQPilot: "pending-external-authorization-and-evidence", productionAuthorization: "not-granted" },
    metrics: aggregateMetrics(key.core.paired), overallAcceptance: "pending-external-gates" };
}

function readJSON(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail("INPUT_NOT_BOUNDED_JSON_FILE");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function writeNew(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content); }
  catch (error) { fs.unlinkSync(file); throw error; }
  finally { fs.closeSync(fd); }
}

export const USAGE = `Social Experience 2.1 — OFFLINE ONLY, 90 fictional scenes, six human dimensions.
Node 22: node scripts/social-experience-21-evaluation.js <command>
  fixtures <new.json>                     固定场景导出
  template <new.json>                     配对输出输入模板（必须填写实际输入/输出）
  validate <paired.json>                  全量校验；不会调用模型
  blind <paired.json> <review.json> <private-key.json> <ratings-template.json>
  aggregate <private-key.json> <reviews-array.json> <trusted-humans.json> <new-summary.json>
  metrics <paired.json> <new-summary.json>
Export files must not exist; parents must exist. blind key parent must differ
from BOTH public-file parents (real paths); keep it inaccessible to reviewers.
Default host seed: crypto.randomBytes(32). Optional SE21_HOST_SEED=64 hex chars,
host only; do NOT give reviewers the seed, paired input, key, or metrics.

paired schema: {schema:"${SCHEMA}",corpusHash,evidenceLabel:
"offline-paired"|"synthetic-rule-tests"|"live-observation",authorIds:["collector"],
cases:[{id,baseline:{model,persona,context,output,metrics},candidate:{...}}]}.
All 90 IDs required once. model={provider,name,revision,generation:{temperature:0}}
must be identical across all runs; persona/context must exactly match fixtures.
authorIds must include ALL baseline/candidate implementers and output collectors,
not just the file submitter. Unknown model identities/revisions are rejected.
output={action:"reply"|"wait"|"silent"|"sticker"|"reaction",text,
assetId?:string,targetEventId?:string}. No credentials or real chat data.
metrics optional values: calls,inputTokens,outputTokens; timestamps in ms:
firstInputAtMs,lastInputAtMs,firstOutputAtMs,completedAtMs;
ack:{attempted,accepted,failed,uncertain}; each of falseParticipation,missedDirect,
badSticker,repetition:{count,eligible}. null/"unknown"/omitted stay UNKNOWN.
Partial observations have observed statistics, never a fabricated full value.
ACK accepted is not delivery. Imported labels/measurements are not attested.

Human process: host independently verifies each human and keeps a trusted local
registry {schema,reviewers:[{id,type:"human",role:"independent-reviewer",
identityVerifiedBy,evidenceRef,publicKey:Ed25519-SPKI-PEM}]}. Unique keys required;
authors cannot review. Mere reviewerType:"human" is insufficient. Ratings template
has blindId,A/B:{six dimension scores 1..5},safetyPassed:boolean per row; all-null
rows remain pending. Set reviewerId and all three human attestations TRUE only
after independent human review. Reviewer signs humanReviewSigningPayload(review)
using their OWN external Ed25519 private key; signature is base64. No signing,
key-generation or auto-scoring command is provided. Submit an array of reviews.
Default quorum: 2 independent humans per case. Any safety failure vetoes; complete
human pass requires every candidate dimension >=4 and >=baseline. Synthetic rule
tests never pass the human gate. Live and production gates remain separate.
Signature verifies bytes/key possession only; the host's out-of-band identity,
independence and blindness checks cannot be replaced by this offline script.`;

export function main(args = process.argv.slice(2)) {
  const [command, ...files] = args;
  const arity = { fixtures: 1, template: 1, validate: 1, blind: 4, aggregate: 4, metrics: 2 };
  if (!command || command === "--help") { console.log(USAGE); return; }
  if (!Object.hasOwn(arity, command) || files.length !== arity[command]) fail("INVALID_COMMAND_ARGUMENTS");
  if (command === "fixtures") writeNew(files[0], exportFixtures());
  if (command === "template") writeNew(files[0], pairedOutputTemplate());
  if (command === "validate") console.log(JSON.stringify({ ...validatePairedOutputs(readJSON(files[0])), modelCalls: 0 }));
  if (command === "metrics") writeNew(files[1], aggregateMetrics(readJSON(files[0])));
  if (command === "blind") {
    const parents = files.slice(1).map(file => fs.realpathSync(path.dirname(path.resolve(file))));
    if (parents[1] === parents[0] || parents[1] === parents[2]) fail("KEY_MUST_HAVE_SEPARATE_PRIVATE_PARENT");
    if (new Set(files.slice(1).map(file => path.resolve(file))).size !== 3) fail("OUTPUT_PATHS_MUST_DIFFER");
    const { review, key, ratings } = createBlindReview(readJSON(files[0]), process.env.SE21_HOST_SEED ? { seed: process.env.SE21_HOST_SEED } : {});
    const written = [];
    try {
      for (const [file, value] of [[files[2], key], [files[1], review], [files[3], ratings]]) { writeNew(file, value); written.push(file); }
    } catch (error) { for (const file of written) fs.unlinkSync(file); throw error; }
  }
  if (command === "aggregate") {
    const result = aggregateHumanReviews(readJSON(files[0]), readJSON(files[1]), readJSON(files[2]));
    writeNew(files[3], result);
    if (result.humanVerdict === "fail") process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    // Do not echo imported outputs, credentials, filesystem paths or raw errors.
    console.error(JSON.stringify({ ok: false, error: error instanceof TypeError && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "INPUT_OR_OUTPUT_ERROR", modelCalls: 0 }));
    process.exitCode = 1;
  }
}
