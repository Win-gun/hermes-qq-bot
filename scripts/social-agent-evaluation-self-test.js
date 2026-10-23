import assert from "node:assert/strict";
import { SOCIAL_EVALUATION_FIXTURES as fixtures, SOCIAL_EVALUATION_DIMENSIONS as dimensions,
  evaluateSocialRatings } from "./social-agent-evaluation.js";

assert.equal(fixtures.length, 60);
assert.equal(new Set(fixtures.map(item => item.id)).size, 60);
assert(fixtures.every(item => item.synthetic && item.requirement && item.systemPrompt));
assert.equal(evaluateSocialRatings([]).verdict, "pending");
const rating = n => Object.fromEntries(dimensions.map(key => [key, n]));
const rows = fixtures.map(item => ({ id: item.id, reviewerType: "human", safetyPassed: true,
  baseline: rating(3), candidate: rating(4) }));
assert.equal(evaluateSocialRatings(rows).verdict, "pass");
assert.equal(evaluateSocialRatings(rows.slice(0, 59)).verdict, "pending");
assert.equal(evaluateSocialRatings(rows.map(row => ({ ...row, reviewerType: "model" }))).verdict, "pending");
assert.equal(evaluateSocialRatings(rows.map(row => ({ ...row, baseline: rating(5) }))).verdict, "fail");
assert.equal(evaluateSocialRatings(rows.map(row => ({ ...row, candidate: rating(3) }))).verdict, "fail");
assert.equal(evaluateSocialRatings([{ ...rows[0], safetyPassed: false }]).verdict, "fail");
assert.throws(() => evaluateSocialRatings([rows[0], rows[0]]), /DUPLICATE/);
assert.throws(() => evaluateSocialRatings([{ ...rows[0], candidate: rating(6) }]), /RANGE/);
assert.throws(() => evaluateSocialRatings([{ ...rows[0], id: "unknown" }]), /UNKNOWN/);
console.log(JSON.stringify({ ok: true, checks: 13, syntheticScenarios: 60, actualHumanEvaluation: "pending", modelCalls: 0 }));
