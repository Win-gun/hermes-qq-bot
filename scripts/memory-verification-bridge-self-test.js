import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { memoryMessageKey } from "../src/memory-extraction-jobs.js";
import { shouldExtractMemoryBatch, selectRelevantMemoryEntries } from "../src/memory-learning.js";
import { prepareMemoryEvidenceBatch } from "../src/memory-evidence.js";
import { redactText } from "../src/privacy-filter.js";

// Execute actual bridge adapter functions, not copies. No bridge, filesystem
// writes, models or network; every identity/value is a synthetic fixture.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const extract = name => {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0);
  for (let end = source.indexOf("\n}\n", start); end >= 0; end = source.indexOf("\n}\n", end + 3)) {
    const candidate = source.slice(start, end + 2);
    try { new vm.Script(candidate); return candidate; }
    catch { /* A sample JSON brace inside a template is not the function end. */ }
  }
  throw new Error(`Unclosed bridge function: ${name}`);
};
const clock = "2026-10-21T08:00:00.000Z";
const context = vm.createContext({
  memoryMessageKey, asArray: value => Array.isArray(value) ? value : [],
  // Preserve the production plain-JSON realm at the VM/module boundary.
  prepareMemoryEvidenceBatch: (messages, options) => prepareMemoryEvidenceBatch(structuredClone(messages), structuredClone(options)),
  configuredAccountDefinitions: () => [],
  selectRelevantMemoryEntries, canonicalActiveEntries: user => user.canonicalMemory.entries,
  userMemoryBits: user => [user.profile || "虚构背景"],
  redactSensitive: value => redactText(String(value), { privacyFilter: true }),
  now: () => clock
});
new vm.Script(`${extract("pendingMemoryInputs")}\n${extract("memoryExtractionPrompt")}`).runInContext(context);
const id = "810001";
const old = { message_id: "fixture-old", user_id: "10001", text: "旧消息", receivedAt: "2020-01-01T00:00:00.000Z" };
const fresh = { message_id: "fixture-new", user_id: "10001", text: "我感觉", receivedAt: clock };
const admittedKey = memoryMessageKey(id, fresh);
const group = { memoryExtractionJobs: { messages: [{ key: admittedKey, input: fresh }],
  acknowledged: [memoryMessageKey(id, old)] }, pendingMemoryMessages: [old, fresh] };
const inputs = context.pendingMemoryInputs(group, id);
assert.equal(inputs.length, 1);
assert.equal(inputs[0].message_id, "fixture-new");
assert.equal(shouldExtractMemoryBatch(inputs, { now: clock, config: { memory: { learning: { enabled: true } } } }).ready, false,
  "an ACKed old legacy row cannot cause premature max-wait extraction");
assert.equal(group.pendingMemoryMessages.length, 2, "compatibility history must not be deleted");

const users = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
  const user = String(10001 + index);
  return [user, { profile: "口令：synthetic-fixture", canonicalMemory: { entries: [
    { id: `fixture-important-${index}`, value: "喜欢黑咖啡", kind: "preference", subjectUserId: user,
      status: "active", confidence: .9, lastConfirmedAt: "2020-01-01T00:00:00.000Z" },
    ...Array.from({ length: 30 }, (_, n) => ({ id: `fixture-unrelated-${index}-${n}`, value: "虚构无关纸张",
      kind: "preference", subjectUserId: user, status: "active", confidence: .9, lastConfirmedAt: clock }))
  ] } }];
}));
const prompt = context.memoryExtractionPrompt({ config: {}, groupId: id, gm: { users }, messages: [
  { conversation_id: id, message_id: "fixture-source", user_id: "10001", sent_at: clock, text: "我现在不喜欢黑咖啡。" }
] });
assert(prompt.includes('"user_id":"10001"'), "the actual early-inserted speaker must be included");
assert(prompt.includes("fixture-important-0"), "relevant old ID must beat unrelated recent entries");
assert(!prompt.includes("fixture-important-39"), "unrelated late-inserted members must not replace the actual speaker");
assert(!prompt.includes("synthetic-fixture"), "old portrait text must be privacy filtered before the model");
assert(prompt.includes("fixture-source"), "privacy filtering must not rewrite source IDs");
console.log(JSON.stringify({ ok: true, checks: 9, sourceExtracted: true, liveState: false, network: false }));
