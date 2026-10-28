import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ingestSocialMessage, appendSocialExperience, getSocialSnapshot } from "../src/social-agent-state.js";
import { recordSocialPreference } from "../src/social-preferences.js";
import { proposeSocialIntent } from "../src/social-intent-journal.js";
import { agencySnapshot, AGENCY_INSTRUCTION } from "../src/social-agency.js";
import { createAgencyInterestSelector } from "../src/social-agency-context.js";

// Same synthetic root, original pinned snapshot implementation vs candidate
// snapshot + local agency projection. Not end-to-end model/network latency.
const baseline = "a8aa328f2d4dd4da9a438e52e416b9eb2c76580b";
const repo = path.resolve(import.meta.dirname, ".."), now = Date.UTC(2026, 9, 28, 5), owner = "account:fixture";
let oldSource = execFileSync("git", ["show", `${baseline}:src/social-agent-state.js`], { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 });
oldSource = oldSource.replace(/from "(\.\/[^"\n]+)"/g, (_all, relative) => `from ${JSON.stringify(pathToFileURL(path.join(repo, "src", relative)).href)}`);
const old = await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString("base64")}`);
const root = {}, labels = Array.from({ length: 64 }, (_, i) => `兴趣${i}`), coreText = labels.join("、");
for (let group = 1; group <= 20; group++) {
  for (let i = 0; i < 128; i++) assert.equal(ingestSocialMessage(root, { logicalId: owner, conversationId: `group:${group}`, now,
    message: { messageId: `g${group}-${i}`, userId: String(100 + i % 8), text: `公开科技讨论 ${i}`,
      sentAt: now - 10000 + i, receivedAt: now - 10000 + i } }).ok, true);
}
for (let i = 0; i < 3; i++) {
  const at = now - (i === 0 ? 26 : i === 1 ? 25 : 1) * 3600000;
  assert.equal(appendSocialExperience(root, { logicalId: owner, conversationId: "group:1", messageId: `ack-${i}`, userId: "100",
    kind: "bot_reply", text: coreText, sentAt: at, now: at, confirmed: true, agencyEligible: true }).ok, true);
}
for (let i = 0; i < labels.length; i++) assert.equal(recordSocialPreference(root, { logicalId: owner, conversationId: "group:1", kind: "self",
  dimension: "interest", value: labels[i], coreText, expectedRevision: i, evidenceMessageIds: ["ack-0", "ack-1", "ack-2"], now }).ok, true);
for (let i = 0; i < 64; i++) assert.equal(proposeSocialIntent(root, { logicalId: owner, conversationId: "group:1", expectedRevision: i,
  kind: "question", summary: `公开科技的后续方向 ${i}`, reason: "当前有相关公开讨论", trigger: { kind: "related_message", terms: ["科技"] },
  evidenceMessageIds: [`g1-${i}`], ttlMs: 3600000, now }).ok, true);
const scope = { logicalId: owner, conversationId: "group:1", now, userId: "100", coreText, query: "科技", limit: 32 };
const cache = createAgencyInterestSelector();
const interestArgs = { logicalId: owner, now, coreText, adminInterests: [], profileInterests: [], blockedTopics: [], roleCardEnabled: true, maxQueries: 3 };
const before = JSON.stringify(root), timings = { baseline: [], candidate: [], selector: [] };
for (let i = 0; i < 180; i++) {
  let at = performance.now(); const a = old.getSocialSnapshot(root, scope); const end = performance.now();
  const b = getSocialSnapshot(root, scope); agencySnapshot(root, scope); const done = performance.now();
  cache.select(root, interestArgs); const selected = performance.now();
  assert.deepEqual(a, b, "base snapshot semantics remain identical under same input");
  if (i >= 30) { timings.baseline.push(end - at); timings.candidate.push(done - end); timings.selector.push(selected - done); }
}
assert.equal(JSON.stringify(root), before, "all projections read-only");
const percentile = list => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1];
const oldP95 = percentile(timings.baseline), newP95 = percentile(timings.candidate), deltaP95 = newP95 - oldP95;
assert(deltaP95 <= 100, `local incremental P95 exceeds 100ms: ${deltaP95}`);
assert(percentile(timings.selector) <= 100, "bounded interest selector P95");
console.log(JSON.stringify({ ok: true, synthetic: true, baseline, samples: 150, conversations: 20, messages: 2560,
  preferences: 64, intents: 64, localP95Ms: { baseline: oldP95, candidate: newP95, increment: deltaP95, selector: percentile(timings.selector) },
  promptChars: { agencySnapshot: JSON.stringify(agencySnapshot(root, scope)).length, instruction: AGENCY_INSTRUCTION.length,
    billing: "UNKNOWN_NOT_PROVIDER_TOKENS" },
  modelCalls: 0, tokens: null, qqWrites: 0, endToEndLatency: "NOT_RUN", humanNaturalness: "NOT_RUN" }));
