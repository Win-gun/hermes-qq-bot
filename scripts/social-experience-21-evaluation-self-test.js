import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SOCIAL_EXPERIENCE_21_FIXTURES as fixtures, SOCIAL_EXPERIENCE_21_CATEGORIES as categories } from "./social-experience-21-fixtures.js";
import { DIMENSIONS, CORPUS_HASH, canonicalJSON, stableHash, exportFixtures, pairedOutputTemplate,
  validatePairedOutputs, createBlindReview, humanReviewSigningPayload, aggregateHumanReviews, aggregateMetrics } from "./social-experience-21-evaluation.js";

// Keys, signatures and scores below are SYNTHETIC TEST DATA, not human evidence.
let checks = 0;
function check(name, run) {
  try { run(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const copy = value => structuredClone(value);
const seed = "28".repeat(32);
const paired = pairedOutputTemplate();
paired.authorIds = ["fictional-output-collector"];
paired.evidenceLabel = "synthetic-rule-tests";
for (const pair of paired.cases) for (const variant of ["baseline", "candidate"]) {
  pair[variant].model = { provider: "fictional-provider", name: "fictional-model", revision: "fixture-revision-1",
    generation: { temperature: 0, reasoning: "fixture-default" } };
  pair[variant].output = { action: "reply", text: variant === "baseline" ? "虚构回答甲" : "虚构回答乙" };
}
const mutatePair = change => { const changed = copy(paired); change(changed); return () => validatePairedOutputs(changed); };
const blind = createBlindReview(paired, { seed });
const identities = [0, 1].map(n => {
  const key = generateKeyPairSync("ed25519");
  return { id: `fictional-human-${n}`, key };
});
const registry = { schema: paired.schema, reviewers: identities.map(({ id, key }) => ({ id, type: "human", role: "independent-reviewer",
  identityVerifiedBy: "fictional-external-organizer", evidenceRef: "SYNTHETIC-TEST-ONLY-NO-HUMAN-VERIFICATION",
  publicKey: key.publicKey.export({ type: "spki", format: "pem" }) })) };
function signedReview(packet = blind, identity = identities[0], change = () => {}) {
  const review = copy(packet.ratings);
  review.reviewerId = identity.id;
  review.attestation = { independentHuman: true, noModelAssistance: true, blindToAssignment: true };
  const assignment = new Map(packet.key.core.assignments.map(a => [a.blindId, a]));
  review.rows = review.rows.map(row => {
    const a = assignment.get(row.blindId);
    const rating = value => Object.fromEntries(DIMENSIONS.map(d => [d, value]));
    return { blindId: row.blindId, A: rating(a.A === "candidate" ? 4 : 3), B: rating(a.A === "candidate" ? 3 : 4), safetyPassed: true };
  });
  change(review);
  review.signature = sign(null, humanReviewSigningPayload(review), identity.key.privateKey).toString("base64");
  return review;
}
const reviews = identities.map(identity => signedReview(blind, identity));
const aggregate = (ratings = reviews, trust = registry, key = blind.key) => aggregateHumanReviews(key, ratings, trust);

check("90 distinct complete fixed scenes and all 15 categories", () => {
  assert.equal(fixtures.length, 90); assert.equal(new Set(fixtures.map(f => f.id)).size, 90);
  assert.equal(categories.length, 15); assert.equal(new Set(fixtures.map(f => f.context.events.map(e => e.text).join("|"))).size, 90);
  for (const category of categories) assert.equal(fixtures.filter(f => f.category === category).length, 6);
  for (const f of fixtures) {
    assert.equal(f.synthetic, true); assert(f.requirement && f.persona.prompt && f.context.events.length);
    assert(f.context.events.every(e => e.senderId.startsWith("fictional-") && e.atMs <= f.context.nowMs));
    assert(Object.isFrozen(f.context));
  }
  assert.equal(DIMENSIONS.length, 6); assert.equal(exportFixtures().corpusHash, CORPUS_HASH);
});
check("canonical object order, array order and invalid non-JSON", () => {
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
  assert.notEqual(stableHash([1, 2]), stableHash([2, 1]));
  assert.throws(() => canonicalJSON({ missing: undefined }), /NON_JSON/);
  assert.throws(() => stableHash(NaN), /NON_JSON/);
});
check("full import valid; unfilled template invalid", () => {
  assert.equal(validatePairedOutputs(paired).cases, 90);
  assert.throws(() => validatePairedOutputs(pairedOutputTemplate()), /UNFILLED_AUTHOR/);
});
for (const [name, change, pattern] of [
  ["missing scene", p => p.cases.pop(), /INCOMPLETE_CASES/],
  ["duplicate scene", p => p.cases[1] = p.cases[0], /DUPLICATE/],
  ["unknown scene", p => p.cases[0].id = "unknown", /UNKNOWN/],
  ["wrong corpus", p => p.corpusHash = "0".repeat(64), /CORPUS/],
  ["wrong source", p => p.evidenceLabel = "human-review", /SOURCE/],
  ["different candidate model", p => p.cases[0].candidate.model.name = "other", /MODEL_MISMATCH/],
  ["different revision", p => p.cases[0].candidate.model.revision = "other", /MODEL_MISMATCH/],
  ["different sampling", p => p.cases[0].candidate.model.generation.temperature = 1, /MODEL_MISMATCH/],
  ["different provider", p => p.cases[0].candidate.model.provider = "other", /MODEL_MISMATCH/],
  ["different model across cases", p => { p.cases[1].baseline.model.name = "other"; p.cases[1].candidate.model.name = "other"; }, /MODEL_MISMATCH/],
  ["missing model revision", p => delete p.cases[0].baseline.model.revision, /INVALID_FIELDS/],
  ["unknown model revision", p => p.cases[0].baseline.model.revision = "unknown", /MODEL_IDENTITY/],
  ["missing generation", p => p.cases[0].baseline.model.generation = {}, /MODEL_IDENTITY/],
  ["persona changed on both sides", p => { p.cases[0].baseline.persona.prompt = "other"; p.cases[0].candidate.persona.prompt = "other"; }, /PERSONA_MISMATCH/],
  ["context changed", p => p.cases[0].candidate.context.policy.quiet = true, /CONTEXT_MISMATCH/],
  ["hash-only input disallowed", p => { p.cases[0].baseline.contextHash = stableHash(p.cases[0].baseline.context); delete p.cases[0].baseline.context; }, /INVALID_FIELDS/],
  ["empty output", p => p.cases[0].baseline.output = null, /INVALID_FIELDS/],
  ["fake silent text", p => p.cases[0].baseline.output = { action: "silent", text: "actually speaking" }, /INVALID_OUTPUT/],
  ["missing reaction target", p => p.cases[0].baseline.output = { action: "reaction", text: "" }, /INVALID_OUTPUT/],
  ["missing sticker asset", p => p.cases[0].baseline.output = { action: "sticker", text: "" }, /INVALID_OUTPUT/],
  ["negative tokens", p => p.cases[0].baseline.metrics.inputTokens = -1, /INVALID_METRIC/],
  ["string token count", p => p.cases[0].baseline.metrics.calls = "0", /INVALID_METRIC/],
  ["nonfinite metric", p => p.cases[0].baseline.metrics.calls = Infinity, /NON_JSON|INVALID_METRIC/],
  ["timestamp backwards", p => Object.assign(p.cases[0].baseline.metrics, { firstInputAtMs: 5, firstOutputAtMs: 4 }), /TIMESTAMP/],
  ["invalid rate denominator", p => p.cases[0].baseline.metrics.badSticker = { count: 2, eligible: 1 }, /INVALID_RATE/],
  ["invalid ACK counts", p => p.cases[0].baseline.metrics.ack = { attempted: 1, accepted: 1, failed: 1, uncertain: 0 }, /INVALID_ACK/]
]) check(name, () => assert.throws(mutatePair(change), pattern));

check("secure reproducible host shuffle, seed isolation and changing seeds", () => {
  assert.deepEqual(blind, createBlindReview(copy(paired), { seed }));
  const other = createBlindReview(paired, { seed: "72".repeat(32) });
  assert.notEqual(blind.key.packetHash, other.key.packetHash);
  assert(blind.key.core.assignments.some(a => a.A === "baseline"));
  assert(blind.key.core.assignments.some(a => a.A === "candidate"));
  assert.notDeepEqual(blind.key.core.assignments.map(a => a.sceneId), fixtures.map(f => f.id));
  const text = JSON.stringify(blind.review);
  for (const forbidden of ["baseline", "candidate", seed, "authorIds", "metrics", "fictional-provider"]) assert(!text.includes(forbidden));
  assert.equal(new Set(blind.review.cases.map(row => row.blindId)).size, 90);
  assert.equal(stableHash(blind.review), blind.ratings.packetHash);
  assert.notEqual(createBlindReview(paired).key.packetHash, createBlindReview(paired).key.packetHash);
  assert.throws(() => createBlindReview(paired, { seed: "1" }), /SEED/);
});
check("pairing order independent for assignment", () => {
  const p = copy(paired); p.cases.reverse();
  assert.deepEqual(createBlindReview(p, { seed }).key.core.assignments, blind.key.core.assignments);
});
check("key mutation/assignment corruption rejected", () => {
  const key = copy(blind.key); key.core.assignments[0].A = key.core.assignments[0].A === "baseline" ? "candidate" : "baseline";
  assert.throws(() => aggregate(reviews, registry, key), /TAMPERED/);
  key.core.assignments[0] = key.core.assignments[1];
  assert.throws(() => aggregate(reviews, registry, key), /ASSIGNMENTS/);
});
check("synthetic ratings cannot pass human gate", () => {
  const report = aggregate();
  assert.equal(report.completeCases, 90); assert.equal(report.humanVerdict, "pending");
  assert.equal(report.inputEvidenceLabel, "synthetic-rule-tests");
  assert.equal(report.dimensions.naturalness.candidate, 4); assert.equal(report.dimensions.naturalness.baseline, 3);
  assert.equal(report.overallAcceptance, "pending-external-gates");
});
check("no human reviews and signed all-null reviews stay pending", () => {
  const result = aggregate([]); assert.equal(result.pendingCases, 90); assert.equal(result.dimensions.correctness.candidate, "unknown");
  const empty = signedReview(blind, identities[0], r => r.rows = copy(blind.ratings.rows));
  assert.equal(aggregate([empty]).completeCases, 0);
});
check("incomplete coverage remains pending and cannot dilute missing scenes", () => {
  const one = signedReview(blind, identities[0], r => r.rows.pop());
  const report = aggregate([one, reviews[1]]);
  assert.equal(report.completeCases, 89); assert.equal(report.pendingCases, 1);
});
check("unsigned human marker/forged self score rejected", () => {
  assert.throws(() => aggregate([{ ...reviews[0], signature: null }]), /SIGNATURE_REQUIRED/);
  assert.throws(() => aggregate([{ ...reviews[0], reviewerType: "human" }]), /INVALID_FIELDS/);
  const forged = copy(reviews[0]); forged.rows[0].A.naturalness = 5;
  assert.throws(() => aggregate([forged]), /INVALID_HUMAN_SIGNATURE/);
});
for (const [name, change, pattern] of [
  ["unknown human", r => r.reviewerId = "fictional-unregistered", /UNTRUSTED/],
  ["model review", r => r.source = "model-self-review", /BOUND/],
  ["unblinded review", r => r.attestation.blindToAssignment = false, /ATTESTATION/],
  ["model-assisted review", r => r.attestation.noModelAssistance = false, /ATTESTATION/],
  ["packet mismatch", r => r.packetHash = "0".repeat(64), /BOUND/],
  ["batch mismatch", r => r.batchId = "0".repeat(32), /BOUND/],
  ["duplicate case rating", r => r.rows[1] = r.rows[0], /DUPLICATE_RATING/],
  ["unknown case rating", r => r.rows[0].blindId = "f".repeat(24), /UNKNOWN/],
  ["missing dimension", r => delete r.rows[0].A.correctness, /INVALID_FIELDS/],
  ["score out of range", r => r.rows[0].A.correctness = 6, /OUT_OF_RANGE/],
  ["missing safety", r => r.rows[0].safetyPassed = null, /SAFETY/],
  ["partial score", r => r.rows[0].B = null, /INVALID_FIELDS/]
]) check(name, () => assert.throws(() => aggregate([signedReview(blind, identities[0], change)]), pattern));

check("duplicate submission, key aliases and self-review cannot pad quorum", () => {
  assert.throws(() => aggregate([reviews[0], reviews[0]]), /DUPLICATE_REVIEWER/);
  const alias = copy(registry); alias.reviewers[1].publicKey = alias.reviewers[0].publicKey;
  assert.throws(() => aggregate(reviews, alias), /DUPLICATE_REVIEWER_KEY/);
  const self = copy(registry); self.reviewers[0].id = paired.authorIds[0];
  assert.throws(() => aggregate(reviews, self), /SELF_REVIEWER/);
  const model = copy(registry); model.reviewers[0].type = "model";
  assert.throws(() => aggregate(reviews, model), /SELF_REVIEWER/);
  const unverified = copy(registry); unverified.reviewers[0].evidenceRef = "";
  assert.throws(() => aggregate(reviews, unverified), /SELF_REVIEWER/);
  const privateKey = copy(registry); privateKey.reviewers[0].publicKey = identities[0].key.privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => aggregate(reviews, privateKey), /INVALID_REVIEWER_KEY/);
});
check("only externally-trusted signed offline human evidence can pass human-only gate", () => {
  // Exercise success branch with synthetic signatures; NOT actual human ratings.
  const p = copy(paired); p.evidenceLabel = "offline-paired";
  const b = createBlindReview(p, { seed });
  const rs = identities.map(identity => signedReview(b, identity));
  const result = aggregate(rs, registry, b.key);
  assert.equal(result.humanVerdict, "pass"); assert.equal(result.gates.liveQQPilot, "pending-external-authorization-and-evidence");
  assert.equal(result.overallAcceptance, "pending-external-gates");
  const poor = identities.map(identity => signedReview(b, identity, r => {
    for (const row of r.rows) row.A.correctness = row.B.correctness = 2;
  }));
  assert.equal(aggregate(poor, registry, b.key).humanVerdict, "fail");
  const veto = signedReview(b, identities[0], r => r.rows[0].safetyPassed = false);
  assert.equal(aggregate([veto], registry, b.key).humanVerdict, "fail");
  assert.equal(aggregate([rs[0]], registry, b.key).humanVerdict, "pending");
});
check("missing metrics stay unknown, not zero", () => {
  const result = aggregateMetrics(paired);
  for (const variant of ["baseline", "candidate"]) for (const metric of Object.values(result[variant])) {
    assert.equal(metric.value, "unknown"); assert.equal(metric.observed, "unknown"); assert.equal(metric.knownCases, 0);
  }
  const p = copy(paired); p.cases[0].baseline.metrics = { calls: null, inputTokens: "unknown", ack: "unknown", falseParticipation: null };
  assert.equal(aggregateMetrics(p).baseline.calls.observed, "unknown");
});
check("actual imported measurements, percentiles, explicit zeros and ACK uncertainty", () => {
  const p = copy(paired); p.evidenceLabel = "live-observation";
  for (const [i, pair] of p.cases.entries()) for (const variant of ["baseline", "candidate"]) pair[variant].metrics = {
    firstInputAtMs: 1000, lastInputAtMs: 1100, firstOutputAtMs: 1200 + i, completedAtMs: 1400 + i,
    calls: 1, inputTokens: 20, outputTokens: 10,
    ack: { attempted: 2, accepted: 1, failed: 0, uncertain: 1 },
    falseParticipation: { count: 0, eligible: 1 }, missedDirect: { count: 0, eligible: 0 },
    badSticker: { count: 1, eligible: 2 }, repetition: { count: 0, eligible: 1 }
  };
  const result = aggregateMetrics(p);
  assert.equal(result.evidenceLabel, "live-observation"); assert.equal(result.ackMeaning, "accepted-is-not-delivered");
  assert.equal(result.candidate.calls.value.sum, 90); assert.equal(result.candidate.outputTokens.value.sum, 900);
  assert.equal(result.candidate.firstResponseMs.value.p50, 244); assert.equal(result.candidate.firstResponseMs.value.p95, 285);
  assert.equal(result.candidate.lastInputToResponseMs.value.mean, 144.5);
  assert.equal(result.candidate.ackAccepted.value.rate, .5); assert.equal(result.candidate.ack_uncertain.value.sum, 90);
  assert.equal(result.candidate.falseParticipation.value.rate, 0); assert.equal(result.candidate.badSticker.value.rate, .5);
  assert.equal(result.candidate.missedDirect.value.rate, "unknown");
  delete p.cases[0].candidate.metrics.calls;
  const partial = aggregateMetrics(p).candidate.calls;
  assert.equal(partial.value, "unknown"); assert.equal(partial.knownCases, 89); assert.equal(partial.observed.sum, 89);
});
check("zero denominators, partially unknown counts and ACKs", () => {
  const p = copy(paired);
  p.cases[0].baseline.metrics = { calls: 0, ack: { attempted: 1, accepted: "unknown", failed: 0, uncertain: 1 },
    missedDirect: { count: "unknown", eligible: 2 } };
  const r = aggregateMetrics(p).baseline;
  assert.equal(r.calls.observed.sum, 0); assert.equal(r.ackAccepted.observed, "unknown");
  assert.equal(r.missedDirect.observed, "unknown"); assert.equal(r.ack_uncertain.observed.sum, 1);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se21-evaluation-test-"));
const cli = fileURLToPath(new URL("./social-experience-21-evaluation.js", import.meta.url));
function run(...args) { return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, SE21_HOST_SEED: seed } }); }
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
try {
  fs.mkdirSync(path.join(tmp, "public"), { mode: 0o700 }); fs.mkdirSync(path.join(tmp, "private"), { mode: 0o700 });
  const publicFile = name => path.join(tmp, "public", name), privateFile = name => path.join(tmp, "private", name);
  const input = privateFile("paired.json"), output = publicFile("review.json"), key = privateFile("key.json"), ratings = publicFile("ratings.json");
  save(input, paired);
  check("CLI fixture, template, validate, help and metrics", () => {
    assert.equal(run("--help").status, 0);
    assert.equal(run("fixtures", publicFile("fixtures.json")).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(publicFile("fixtures.json"))).cases.length, 90);
    assert.equal(run("template", privateFile("template.json")).status, 0);
    assert.equal(run("validate", input).status, 0);
    assert.equal(run("metrics", input, privateFile("metrics.json")).status, 0);
    assert.equal(run("bogus").status, 1);
  });
  check("CLI blind separate key files, 0600, no overwrite", () => {
    assert.equal(run("blind", input, output, key, ratings).status, 0);
    assert.equal(fs.statSync(key).mode & 0o777, 0o600); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(stableHash(JSON.parse(fs.readFileSync(output))), JSON.parse(fs.readFileSync(key)).packetHash);
    const old = fs.readFileSync(output, "utf8");
    assert.equal(run("blind", input, output, key, ratings).status, 1);
    assert.equal(fs.readFileSync(output, "utf8"), old);
    assert.equal(run("blind", input, publicFile("bad.json"), publicFile("bad-key.json"), publicFile("bad-ratings.json")).status, 1);
    assert.equal(fs.existsSync(publicFile("bad.json")), false);
    const symlinkDir = path.join(tmp, "private-alias"); fs.symlinkSync(path.dirname(key), symlinkDir);
    assert.equal(run("blind", input, path.join(symlinkDir, "public.json"), privateFile("secret.json"), ratings).status, 1);
  });
  check("CLI failed multi-file export cleans only new own files", () => {
    const newKey = privateFile("partial-key.json");
    assert.equal(run("blind", input, output, newKey, publicFile("partial-ratings.json")).status, 1);
    assert.equal(fs.existsSync(newKey), false); assert.equal(fs.existsSync(output), true);
  });
  check("CLI signed aggregate pending, unsigned rejection and safe errors", () => {
    const stored = { key: JSON.parse(fs.readFileSync(key)), ratings: JSON.parse(fs.readFileSync(ratings)) };
    const rs = identities.map(identity => signedReview(stored, identity));
    const rsFile = privateFile("reviews.json"), trustFile = privateFile("trust.json"), report = privateFile("summary.json");
    save(rsFile, rs); save(trustFile, registry);
    assert.equal(run("aggregate", key, rsFile, trustFile, report).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(report)).humanVerdict, "pending");
    rs[0].signature = null; save(rsFile, rs);
    const bad = run("aggregate", key, rsFile, trustFile, privateFile("bad-summary.json"));
    assert.equal(bad.status, 1); assert.match(bad.stderr, /HUMAN_SIGNATURE_REQUIRED/);
    assert.equal(fs.existsSync(privateFile("bad-summary.json")), false);
    const missing = run("validate", privateFile("sensitive-name.json"));
    assert(!missing.stderr.includes(tmp)); assert(!missing.stderr.includes("sensitive-name"));
  });
  check("CLI symlink input rejected without following target", () => {
    const symlink = privateFile("link.json"); fs.symlinkSync(input, symlink);
    assert.equal(run("validate", symlink).status, 1);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log(JSON.stringify({ ok: true, checks, scenarios: fixtures.length, categories: categories.length, dimensions: DIMENSIONS.length,
  evidenceLabel: "synthetic-rule-tests", modelCalls: 0, actualHumanEvaluation: "pending", liveQQPilot: "pending", productionMutations: 0 }));
