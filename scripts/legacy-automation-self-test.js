import assert from "node:assert/strict";
import {
  normalizeAutomationRoutines, legacyRoutineConfig, publicAutomationRoutines,
  routineCatalog, patchAutomationRoutines, previewAutomationRoutines
} from "../src/legacy-automation.js";

const original = {
  automation: { enabled: true, rules: [{ id: "existing" }] },
  targetGroups: ["*"],
  accounts: {
    items: [{ id: "bot_a" }, { id: "old_bot", archived: true }],
    failoverGroups: [{ id: "team" }, { id: "old_team", archived: true }]
  },
  dailyMessages: {
    enabled: false, futureOption: { retained: true }, apiKey: "TEST_SECRET_DAILY",
    schedules: [
      { name: "morning", mode: "morning", time: "08:30", prompt: "早问好", future: 17, token: "TEST_SECRET_SCHEDULE" },
      { name: "evening", mode: "evening", time: "23:00", instruction: "晚间问候" },
      { name: "summary", mode: "summary", time: "23:30", requireHistory: true }
    ]
  },
  hourlyChat: { enabled: false, prompt: "现在 {{time}}", ownerUserIds: ["123"], checkIntervalMs: 60_000, secret: "TEST_SECRET_HOURLY" }
};
const baseline = structuredClone(original);
const normalized = normalizeAutomationRoutines(original);
assert.deepEqual(original, baseline, "normalization must not mutate input");
assert.deepEqual(normalized.automation.routines, { version: 1, daily: original.dailyMessages, hourly: original.hourlyChat });
assert.deepEqual(normalizeAutomationRoutines(normalized), normalized, "normalization is idempotent");
assert.deepEqual(normalized.dailyMessages, normalized.automation.routines.daily);
assert.notEqual(normalized.dailyMessages, normalized.automation.routines.daily);
assert.notEqual(normalized.dailyMessages.schedules, normalized.automation.routines.daily.schedules);
normalized.dailyMessages.futureOption.retained = false;
assert.equal(normalized.automation.routines.daily.futureOption.retained, true, "projections cannot mutate authority");
normalized.dailyMessages.enabled = true;
normalized.hourlyChat.enabled = true;
const runtime = legacyRoutineConfig(normalized);
assert.equal(runtime.dailyMessages.enabled, false, "authority overrides stale daily projection");
assert.equal(runtime.hourlyChat.enabled, false, "authority overrides stale hourly projection");
assert.equal(runtime.automation.rules[0].id, "existing", "unrelated automation is retained");

const empty = normalizeAutomationRoutines({});
assert.deepEqual(empty, { automation: { routines: { version: 1 } } });
assert.deepEqual(routineCatalog(empty), []);
const emptyRuntime = legacyRoutineConfig(empty);
assert.equal(emptyRuntime.dailyMessages.enabled, false);
assert.equal(emptyRuntime.hourlyChat.enabled, false);
assert.deepEqual(normalizeAutomationRoutines(emptyRuntime), empty, "runtime placeholders never become sources");
const authoritativeMissing = normalizeAutomationRoutines({
  automation: { routines: { version: 1 } }, dailyMessages: { enabled: true }, hourlyChat: { enabled: true }
});
assert.equal(Object.hasOwn(authoritativeMissing, "dailyMessages"), false);
assert.equal(Object.hasOwn(authoritativeMissing, "hourlyChat"), false);
assert.throws(() => patchAutomationRoutines(empty, { daily: { enabled: true } }), /missing/);
assert.throws(() => patchAutomationRoutines(empty, { hourly: { enabled: false } }), /missing/);
assert.throws(() => normalizeAutomationRoutines({ automation: { routines: { version: 2 } } }), /version/);
assert.throws(() => normalizeAutomationRoutines({ automation: { routines: null } }), /plain object/);

const catalog = routineCatalog(original);
assert.deepEqual(catalog.map((entry) => entry.id), ["daily-0", "daily-1", "daily-2", "hourly"]);
assert.ok(catalog.every((entry) => entry.enabled === false), "old disabled switches stay disabled");
assert.equal(catalog[1].mode, "evening", "evening is not renamed to night");
assert.equal(catalog[1].prompt, "晚间问候", "instruction fallback is preserved");
assert.equal(catalog[2].requireHistory, true);
assert.equal(catalog[2].windowMinutes, 3, "old window default remains 3, not UI default 5");
assert.equal(catalog[0].targetLabel, "原路由");
assert.match(catalog[0].scopeStrategy, /动态/);
assert.equal(catalog[3].time, null, "hourly is not a fixed wall-clock schedule");
assert.match(catalog[3].risks.join(" "), /重启重置/);
const defaults = { dailyMessages: { schedules: [{ time: "8:30" }] }, hourlyChat: {} };
assert.ok(routineCatalog(defaults).every((entry) => entry.enabled), "present missing-enabled retains old default semantics");
assert.equal(legacyRoutineConfig(defaults).dailyMessages.schedules[0].time, "8:30", "normalization does not rewrite old time");
assert.equal(routineCatalog({ dailyMessages: { enabled: true, schedules: [{ enabled: false }] } })[0].enabled, false);

const publicView = publicAutomationRoutines(original);
assert.equal(publicView.version, 1);
assert.equal(publicView.daily.enabled, false);
assert.equal(publicView.daily.schedules[2].requireHistory, true);
assert.deepEqual(publicView.hourly.ownerUserIds, ["123"]);
for (const value of [publicView, catalog, previewAutomationRoutines(original)]) {
  assert.ok(!JSON.stringify(value).includes("TEST_SECRET"), "unknown internal credential fields are never public");
}
publicView.hourly.ownerUserIds.push("456");
assert.deepEqual(original.hourlyChat.ownerUserIds, ["123"], "public view is detached");
assert.equal(previewAutomationRoutines(original).needed, true);
assert.equal(previewAutomationRoutines(normalizeAutomationRoutines(original)).needed, false);
const malformedPublicFields = {
  dailyMessages: { accountId: { secret: "TEST_SECRET_NESTED" }, schedules: [
    { name: { secret: "TEST_SECRET_NESTED" }, prompt: { secret: "TEST_SECRET_NESTED" }, mode: { secret: "TEST_SECRET_NESTED" }, time: { secret: "TEST_SECRET_NESTED" } }
  ] },
  hourlyChat: { ownerUserIds: ["123", { secret: "TEST_SECRET_NESTED" }] }
};
assert.ok(!JSON.stringify(publicAutomationRoutines(malformedPublicFields)).includes("TEST_SECRET"));
assert.ok(!JSON.stringify(routineCatalog(malformedPublicFields)).includes("TEST_SECRET"));

const patched = patchAutomationRoutines(original, { daily: { enabled: false, windowMinutes: 4 } });
assert.equal(patched.dailyMessages.windowMinutes, 4);
assert.deepEqual(patched.dailyMessages.schedules, original.dailyMessages.schedules, "partial patch does not replace schedules");
assert.deepEqual(patched.dailyMessages.futureOption, original.dailyMessages.futureOption);
assert.equal(patched.dailyMessages.apiKey, "TEST_SECRET_DAILY", "internal unknown fields survive");
assert.deepEqual(patched.dailyMessages, patched.automation.routines.daily);
assert.deepEqual(patched.hourlyChat, patched.automation.routines.hourly);
const edited = patchAutomationRoutines(original, {
  version: 1,
  daily: { enabled: true, accountId: "bot_a", requireKnownGroup: false,
    schedules: [{ id: "daily-2", time: "23:35", enabled: false, requireHistory: false, prompt: "新的摘要说明" }] },
  hourly: { groupId: "team", prompt: "", enabled: false }
});
assert.equal(edited.dailyMessages.schedules.length, 3);
assert.equal(edited.dailyMessages.schedules[2].name, "summary", "ledger identity stays unchanged");
assert.equal(edited.dailyMessages.schedules[2].mode, "summary");
assert.equal(edited.dailyMessages.schedules[2].time, "23:35");
assert.equal(edited.dailyMessages.schedules[2].requireHistory, false);
assert.equal(edited.dailyMessages.schedules[0].future, 17);
assert.equal(edited.dailyMessages.accountId, "bot_a");
assert.equal(routineCatalog(edited)[0].targetLabel, "bot_a");
assert.equal(routineCatalog(edited)[3].targetLabel, "team");
assert.equal(edited.hourlyChat.enabled, false);
assert.deepEqual(edited.targetGroups, original.targetGroups, "scope is never changed");
assert.deepEqual(edited.hourlyChat.ownerUserIds, original.hourlyChat.ownerUserIds);
const switched = patchAutomationRoutines(edited, { daily: { accountId: null, groupId: "team" } });
assert.equal(Object.hasOwn(switched.dailyMessages, "accountId"), false);
assert.equal(switched.dailyMessages.groupId, "team");
assert.equal(routineCatalog(patchAutomationRoutines(switched, { daily: { groupId: null } }))[0].targetLabel, "原路由");

for (const input of [
  { version: 2 }, { unknown: true }, { daily: null }, { daily: { enabled: "false" } },
  { daily: { requireKnownGroup: 1 } }, { daily: { windowMinutes: 0 } }, { daily: { windowMinutes: 1.5 } },
  { daily: { windowMinutes: 1441 } }, { daily: { accountId: "unknownaccount" } },
  { daily: { accountId: "old_bot" } }, { hourly: { groupId: "old_team" } },
  { daily: { accountId: "bot_a", groupId: "team" } },
  { daily: { accountId: "" } }, { daily: { accountId: "../bad" } },
  { daily: { schedules: [{ id: "daily-3", enabled: true }] } },
  { daily: { schedules: [{ id: "daily-0", time: "24:00" }] } },
  { daily: { schedules: [{ id: "daily-0", time: "8:00" }] } },
  { daily: { schedules: [{ id: "daily-0", requireHistory: "false" }] } },
  { daily: { schedules: [{ id: "daily-0", mode: "night" }] } },
  { daily: { schedules: [{ id: "daily-0", name: "new_ledger_key" }] } },
  { daily: { schedules: [{ id: "daily-0" }, { id: "daily-0" }] } },
  { daily: { schedules: [{ time: "09:00" }] } }, { daily: { scope: ["group:456"] } },
  { hourly: { ownerUserIds: ["456"] } }, { hourly: { checkIntervalMs: 1 } },
  { hourly: { prompt: "x".repeat(4001) } }, { hourly: { prompt: "bad\u0000" } },
  JSON.parse('{"daily":{"__proto__":{"polluted":true}}}')
]) {
  assert.throws(() => patchAutomationRoutines(original, input), TypeError);
  assert.deepEqual(original, baseline, "failed patches are atomic and cannot mutate inputs");
}
assert.throws(() => patchAutomationRoutines(edited, { daily: { groupId: "team" } }), /one routine sender/);
assert.deepEqual(original, baseline);
console.log(JSON.stringify({ ok: true, assertions: "lossless/idempotent authority, disabled/absent defaults, evening/summary, ledger identity, sparse atomic patches, sender validation, public allowlist, preview" }));
