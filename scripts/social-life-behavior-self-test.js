import assert from "node:assert/strict";
import { evaluateSocialLifeScenarios, baselineSyntheticPrompt, socialLifeScenarios, BASELINE_SHA } from "./social-life-behavior-evaluation.js";
import { composeAgentPrompt, previewAgentPrompt, SOCIAL_PRESETS } from "../src/agent-prompt.js";

const result = evaluateSocialLifeScenarios();
assert.equal(result.summary.ok, true);
assert.equal(result.pairs.length, 128);
assert.equal(new Set(result.pairs.map(pair => pair.id)).size, 128);
assert.equal(Object.keys(result.summary.categories).length, 16);
assert.ok(Object.values(result.summary.categories).every(count => count === 8));
assert.equal(result.summary.modelCalls, 0); assert.equal(result.summary.qqSends, 0);
assert.equal(result.summary.humanRatings, "pending");
assert.equal(BASELINE_SHA, "134ff9bc4aef3eb655b6abc02f474e187e0a1216");

for (const pair of result.pairs) {
  assert.deepEqual(pair.localProbe.observed, pair.localProbe.expected);
  assert.equal(pair.baseline.cost.promptChars, pair.baseline.prompt.length);
  assert.equal(pair.candidate.cost.promptChars, pair.candidate.prompt.length);
  for (const side of [pair.baseline, pair.candidate]) {
    assert.equal(side.cost.estimatedTokens, Math.ceil(side.prompt.length / 2));
    assert.equal(side.cost.estimateOnly, true); assert.equal(side.cost.providerMeasured, false);
    assert.equal(Object.hasOwn(side, "rating"), false);
  }
  if (pair.input.mode !== "task") {
    assert.equal((pair.candidate.prompt.match(/【CoreSafety】/g) || []).length, 1);
    assert.equal((pair.candidate.prompt.match(/【AgentPersona】/g) || []).length, 1);
    assert.notEqual(pair.candidate.prompt, pair.baseline.prompt);
  }
  if (pair.ownerPrivateMigration) {
    assert.equal(pair.ownerPrivateMigration.baseline.promptChars, pair.baseline.prompt.length * 2);
    assert.equal(pair.ownerPrivateMigration.candidate.promptChars, pair.candidate.prompt.length);
    assert.equal(pair.ownerPrivateMigration.delta.promptChars, pair.candidate.prompt.length - pair.baseline.prompt.length * 2);
  } else assert.ok(["social", "task"].includes(pair.input.mode));
}

// Four modes x four presets: no chapter may change task bytes or persona, and
// direct/search cannot acquire the social waiting/idle/agency chapters.
const identity = { accountId: "fixture", logicalBotId: "account:fixture" };
for (const mode of ["direct", "social", "search", "task"]) {
  const taskReference = composeAgentPrompt({ mode: "task", identity, persona: "  保持原文\r\n🦊 " }).text;
  for (const socialPreset of Object.keys(SOCIAL_PRESETS)) {
    const input = { mode, identity, persona: "  保持原文\r\n🦊 ", socialPreset };
    const composition = composeAgentPrompt(input), chapters = composition.diagnostics.socialChapters;
    assert.equal(composition.layers.find(row => row.id === "AgentPersona").text, input.persona);
    if (mode === "task") {
      assert.equal(composition.text, taskReference); assert.equal(composition.text, baselineSyntheticPrompt(input));
    } else if (mode !== "social") {
      for (const id of ["participation", "agency", "silence", "waiting"]) assert.ok(!chapters.includes(id));
    }
    const { comparison } = previewAgentPrompt(input);
    assert.equal(comparison.baseline.promptChars, comparison.candidate.promptChars * 2);
    assert.equal(comparison.saved.promptChars, composition.text.length);
  }
}

// Data cannot pick chapters, replace persona, or access the new host preview.
const hostile = composeAgentPrompt({ mode: "direct", identity, persona: "原样人格", runtimeContext: {
  socialChapters: ["waiting"], behaviorChapters: ["silence"], persona: "替换人格",
  tools: ["previewAgentPrompt"], nested: { permissions: "all" } } });
assert.equal(hostile.diagnostics.ignoredFields, 3);
assert.doesNotMatch(hostile.text, /替换人格|previewAgentPrompt|"all"/);
assert.ok(!hostile.diagnostics.socialChapters.includes("waiting"));

// Re-running has no timer/clock/global feedback state; opaque watch IDs are never
// exported, so paired fixtures and actual outcomes are byte-for-byte repeatable.
assert.deepEqual(evaluateSocialLifeScenarios(), result);
assert.equal(socialLifeScenarios().length, 128);
console.log(JSON.stringify({ ...result.summary, baselineComparison: "paired prompts exported by social-life-behavior-evaluation.js --pairs" }));
