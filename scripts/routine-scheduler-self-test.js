import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { reconcileMemoryInPlace } from "../src/memory-state.js";
import { dailyScheduleLedgerKey, legacyRoutineConfig, normalizeAutomationRoutines, patchAutomationRoutines } from "../src/legacy-automation.js";

// Execute the real legacy scheduler with fake model/wire boundaries. No sockets,
// live state, credentials, model providers or QQ messages are involved.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const start = source.indexOf("async function runDailyMessages(");
const end = source.indexOf("\nfunction publicConfig(", start);
assert(start > 0 && end > start);
const groups = new Map([["900001", [{ text: "fixture context" }]], ["900002", []]]);
const memory = { groups: {} }, modes = [], sent = [], saves = [];
const gm = (state, id) => state.groups[id] ||= { dailySent: {}, summaries: [] };
let transaction = Promise.resolve();
const context = vm.createContext({
  dailyScheduleLedgerKey, legacyRoutineConfig, Date, Number, String, Array,
  localDateKey: () => "2026-10-13", isWithinScheduleWindow: () => true,
  handlesAllGroups: () => false, targetGroups: () => [...groups.keys()],
  asStringId: String, isQuiet: () => false,
  wasDailySent: (_memory, id, key, day) => Boolean(gm(memory, id).dailySent[day]?.[key]),
  markDailySent: (state, id, key, day, status = "sent") => {
    (gm(state, id).dailySent[day] ||= {})[key] = { status };
  },
  mutateMemory: (state, build) => {
    const result = transaction.then(() => {
      const draft = structuredClone(state), value = build(draft);
      assert(!value?.then, "transaction builders must remain synchronous");
      reconcileMemoryInPlace(state, draft);
      saves.push(true);
      return value;
    });
    transaction = result.catch(() => {});
    return result;
  }, compactMemory: () => "",
  buildPrompt: ({ mode }) => { modes.push(mode); return mode; },
  callHermes: async (prompt) => `fixture ${prompt}`, trimForGroup: (text) => text,
  recordBotMessage: () => {}, relatedUserIdsFromText: () => [], groupMemory: gm,
  now: () => "2026-10-13T12:00:00Z", log: () => {}, warn: (error) => { throw new Error(error); }
});
vm.runInContext(source.slice(start, end), context);
const ws = { readyState: 1 };
const config = normalizeAutomationRoutines({
  reply: { useContextBundle: false }, memory: { maxSummaries: 14 },
  dailyMessages: { enabled: true, windowMinutes: 5, schedules: [
    { name: "morning", mode: "morning", time: "08:30", prompt: "fixture morning" },
    { name: "evening", mode: "evening", time: "23:00", prompt: "fixture evening" },
    { name: "summary", mode: "summary", time: "23:30", prompt: "fixture summary", requireHistory: true }
  ] }
});
const run = () => context.runDailyMessages({
  ws, config, memory, historyByGroup: groups, lastEventByGroup: new Map(),
  lastBotMessageByGroup: new Map(), activeSocket: () => ws,
  sendMessage: async (_ws, id, text) => sent.push({ id, text })
});
await run();
assert.deepEqual(modes, ["morning", "morning", "evening", "evening", "summary"]);
assert.equal(sent.length, 5);
assert.equal(gm(memory, "900001").summaries.length, 1);
assert.equal(gm(memory, "900002").summaries.length, 0, "empty history must not produce a summary");
assert.equal(gm(memory, "900001").dailySent["2026-10-13"].summary.status, "sent");
await run();
assert.equal(sent.length, 5, "moving rules must not invalidate old daily ledger keys");
assert(saves.length >= 10, "send claims must remain persistent");
const timed = normalizeAutomationRoutines({ reply: { useContextBundle: false },
  dailyMessages: { enabled: true, schedules: [{ time: "08:30", prompt: "fixture time-only" }] } });
const runTimed = (config) => context.runDailyMessages({ ws, config, memory, historyByGroup: groups,
  lastEventByGroup: new Map(), lastBotMessageByGroup: new Map(), activeSocket: () => ws,
  sendMessage: async (_ws, id, text) => sent.push({ id, text }) });
await runTimed(timed);
const beforeTimeEdit = sent.length;
await runTimed(patchAutomationRoutines(timed, { daily: { schedules: [{ id: "daily-0", time: "09:00" }] } }));
assert.equal(sent.length, beforeTimeEdit, "changing a time-only schedule must preserve its occupied ledger identity");
const migrated = { ...config, __automationOwnerKey: "account:a", __legacyRoutineLedger: true };
await runTimed(migrated);
assert.equal(sent.length, beforeTimeEdit, "the original owner must honor its old occupied daily ledger");
const freshOwner = { ...config, __automationOwnerKey: "account:b", __legacyRoutineLedger: false };
await runTimed(freshOwner);
assert.equal(sent.length, beforeTimeEdit + 5, "another owner with identical names must not inherit old send claims");
assert.equal(gm(memory, "900001").dailySent["2026-10-13"]["routine:account:b:summary"].status, "sent");
await runTimed(freshOwner);
assert.equal(sent.length, beforeTimeEdit + 5, "owner-namespaced claims prevent repeats");

// Old executors ignored raw IDs entirely. These occupied name/mode/time keys
// have no explicit legacyLedgerKey and must still block same-day re-sends.
const rawIdentified = { reply: { useContextBundle: false }, dailyMessages: { enabled: true, schedules: [
  { id: "s1", name: "morning", mode: "morning", time: "08:30" },
  { id: "s2", mode: "evening", time: "23:00" }
] } };
const beforeRawIdentified = sent.length;
for (const owner of [{}, { __automationOwnerKey: "account:a", __legacyRoutineLedger: true },
  { __automationOwnerKey: "account:b", __legacyRoutineLedger: false }]) {
  await runTimed({ ...rawIdentified, ...owner });
  assert.equal(sent.length, beforeRawIdentified, "raw IDs must not replace occupied unambiguous old name/mode/time keys");
}
assert.deepEqual(rawIdentified.dailyMessages.schedules.map((schedule) => dailyScheduleLedgerKey(schedule, rawIdentified.dailyMessages.schedules)),
  ["morning", "evening"]);
assert.equal(rawIdentified.dailyMessages.schedules.some((schedule) => Object.hasOwn(schedule, "legacyLedgerKey")), false);
await runTimed({ reply: { useContextBundle: false }, dailyMessages: { enabled: true,
  schedules: [{ id: "s3", time: "08:30" }] } });
assert.equal(sent.length, beforeRawIdentified, "raw ID with only a time must honor the old occupied time key too");
await runTimed({ reply: { useContextBundle: false }, dailyMessages: { enabled: true, schedules: [
  rawIdentified.dailyMessages.schedules[0],
  { name: "morning", legacyLedgerKey: "evening", time: "23:00" }
] } });
assert.equal(sent.length, beforeRawIdentified, "an explicitly distinct sibling ledger cannot make the raw morning key ambiguous");

const identifiedDuplicates = { reply: { useContextBundle: false }, __automationOwnerKey: "account:identified-duplicates", __legacyRoutineLedger: true,
  dailyMessages: { enabled: true, schedules: [
    { id: "identified-one", name: "summary", mode: "summary", time: "12:00", requireHistory: true },
    { id: "identified-two", name: "summary", mode: "summary", time: "18:00", requireHistory: true }
  ] } };
const beforeIdentifiedDuplicates = sent.length;
await runTimed(identifiedDuplicates);
assert.equal(sent.length, beforeIdentifiedDuplicates + 2,
  "raw IDs disambiguate colliding names; an ambiguous old shared summary flag cannot swallow both schedules");
await runTimed({ ...identifiedDuplicates, dailyMessages: { ...identifiedDuplicates.dailyMessages,
  schedules: [...identifiedDuplicates.dailyMessages.schedules].reverse() } });
assert.equal(sent.length, beforeIdentifiedDuplicates + 2, "identified colliding schedules keep their claimed keys after reordering");

const duplicateModes = normalizeAutomationRoutines({ reply: { useContextBundle: false },
  dailyMessages: { enabled: true, schedules: [
    { name: "summary", mode: "summary", time: "12:00", requireHistory: true },
    { name: "summary", mode: "summary", time: "18:00", requireHistory: true },
    { mode: "summary", time: "21:00", requireHistory: true }
  ] } });
const duplicateOwner = { ...duplicateModes, __automationOwnerKey: "account:duplicate-modes", __legacyRoutineLedger: false };
const beforeDuplicates = sent.length;
await runTimed(duplicateOwner);
assert.equal(sent.length, beforeDuplicates + 3, "same-name/same-mode summaries at different times must each send");
const duplicateSchedules = duplicateModes.dailyMessages.schedules;
const duplicateKeys = duplicateSchedules.map((schedule) => dailyScheduleLedgerKey(schedule, duplicateSchedules));
assert.equal(new Set(duplicateKeys).size, 3);
for (const key of duplicateKeys) assert.equal(gm(memory, "900001").dailySent["2026-10-13"][`routine:account:duplicate-modes:${key}`].status, "sent");
await runTimed(duplicateOwner);
assert.equal(sent.length, beforeDuplicates + 3, "each distinct occurrence retains its own duplicate-send guard");
await runTimed({ ...patchAutomationRoutines(duplicateModes, { daily: { schedules: [{ id: "daily-0", time: "13:00" }] } }),
  __automationOwnerKey: "account:duplicate-modes", __legacyRoutineLedger: false });
assert.equal(sent.length, beforeDuplicates + 3, "editing one colliding schedule preserves all occupied sibling keys");

const explicitLedger = normalizeAutomationRoutines({ reply: { useContextBundle: false },
  dailyMessages: { enabled: true, schedules: [{ id: "new-id", legacyLedgerKey: "summary", mode: "summary", time: "19:00" }] } });
await runTimed({ ...explicitLedger, __automationOwnerKey: "account:a", __legacyRoutineLedger: true });
assert.equal(sent.length, beforeDuplicates + 4, "explicit legacy key prevents re-send to the occupied group; only the unoccupied group can send");
await runTimed({ ...explicitLedger, __automationOwnerKey: "account:a", __legacyRoutineLedger: true });
assert.equal(sent.length, beforeDuplicates + 4, "explicit old ledger key also respects the new owner claim");

const hourlyStart = source.indexOf("const hourlyChatState =");
// Change routing/quiet AFTER durable claim, while the scheduler is suspended.
// Neither transition may let the old prepared message reach the wire.
const originalTransact = context.mutateMemory;
for (const mode of ["quiet", "owner", "controls"]) {
  let current = true, quiet = false, controlRevision = 1;
  const id = `async-${mode}`, before = sent.length;
  context.targetGroups = () => [id];
  context.isQuiet = () => quiet;
  let firstCommit = true;
  context.mutateMemory = async (...args) => {
    const result = await originalTransact(...args);
    if (firstCommit) {
      firstCommit = false;
      if (mode === "quiet") quiet = true;
      else if (mode === "owner") current = false;
      else controlRevision++;
    }
    return result;
  };
  await context.runDailyMessages({ ws, config: timed, memory, historyByGroup: groups,
    lastEventByGroup: new Map(), lastBotMessageByGroup: new Map(), activeSocket: () => ws,
    isCurrent: () => current, conversationRevision: () => controlRevision,
    sendMessage: async () => sent.push("unexpected") });
  assert.equal(sent.length, before, `${mode} changed during commit must suppress send`);
  assert.equal(Object.values(gm(memory, id).dailySent["2026-10-13"])[0].status, "cancelled");
}
context.mutateMemory = originalTransact;
const hourlyContext = vm.createContext({ legacyRoutineConfig, modelCalls: 0,
  callHermes: async () => { hourlyContext.modelCalls++; return "fixture"; } });
vm.runInContext(source.slice(hourlyStart, start), hourlyContext);
await hourlyContext.runHourlyChat({ ws, config: { automation: { enabled: false }, hourlyChat: { enabled: true } } });
assert.equal(hourlyContext.modelCalls, 0, "disabled account automation must block hourly before model generation");
console.log("routine scheduler self-test: PASS (real scheduler; legacy modes/history/summary/ledger preserved)");
