import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { legacyRoutineConfig, normalizeAutomationRoutines, patchAutomationRoutines } from "../src/legacy-automation.js";

// Execute the real legacy scheduler with fake model/wire boundaries. No sockets,
// live state, credentials, model providers or QQ messages are involved.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const start = source.indexOf("async function runDailyMessages(");
const end = source.indexOf("\nfunction publicConfig(", start);
assert(start > 0 && end > start);
const groups = new Map([["900001", [{ text: "fixture context" }]], ["900002", []]]);
const memory = { groups: {} }, modes = [], sent = [], saves = [];
const gm = (_memory, id) => memory.groups[id] ||= { dailySent: {}, summaries: [] };
const context = vm.createContext({
  legacyRoutineConfig, Date, Number, String, Array,
  localDateKey: () => "2026-10-13", isWithinScheduleWindow: () => true,
  handlesAllGroups: () => false, targetGroups: () => [...groups.keys()],
  asStringId: String, isQuiet: () => false,
  wasDailySent: (_memory, id, key, day) => Boolean(gm(memory, id).dailySent[day]?.[key]),
  markDailySent: (_memory, id, key, day, status = "sent") => {
    (gm(memory, id).dailySent[day] ||= {})[key] = { status };
  },
  saveMemory: () => saves.push(true), compactMemory: () => "",
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

const hourlyStart = source.indexOf("const hourlyChatState =");
const hourlyContext = vm.createContext({ legacyRoutineConfig, modelCalls: 0,
  callHermes: async () => { hourlyContext.modelCalls++; return "fixture"; } });
vm.runInContext(source.slice(hourlyStart, start), hourlyContext);
await hourlyContext.runHourlyChat({ ws, config: { automation: { enabled: false }, hourlyChat: { enabled: true } } });
assert.equal(hourlyContext.modelCalls, 0, "disabled account automation must block hourly before model generation");
console.log("routine scheduler self-test: PASS (real scheduler; legacy modes/history/summary/ledger preserved)");
