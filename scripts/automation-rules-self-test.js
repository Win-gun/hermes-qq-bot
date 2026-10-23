import assert from "node:assert/strict";
import {
  normalizeAutomationRule,
  validateAutomationRules,
  dueAutomationRules,
  matchAutomationCommand,
  automationOccurrenceKey
} from "../src/automation-rules.js";

const schedule = {
  id: "morning",
  scope: { groupIds: [123] },
  trigger: { type: "schedule", time: "00:00" },
  action: { kind: "summary" },
  prompt: "总结昨天的消息"
};
const command = {
  id: "digest",
  scope: { conversationIds: ["group:123", "private:9"] },
  trigger: { type: "command", text: "/digest" },
  action: { kind: "task" },
  accountId: "primary",
  prompt: "生成摘要"
};

const normalized = normalizeAutomationRule(schedule);
assert.equal(normalizeAutomationRule({ ...schedule, groupId: "team_a" }).groupId, "team_a");
assert.throws(() => normalizeAutomationRule({ ...schedule, accountId: "bot1", groupId: "team_a" }), /one sender/);
assert.throws(() => normalizeAutomationRule({ ...schedule, groupId: "../invalid" }), /groupId/);
assert.equal(normalized.enabled, true);
assert.equal(normalized.timezone, "Asia/Shanghai");
assert.deepEqual(normalized.scope.conversationIds, ["group:123"]);
assert.equal(normalized.trigger.windowMinutes, 3);
assert.equal(schedule.scope.groupIds[0], 123, "normalization must not mutate input");

const valid = validateAutomationRules([schedule, command]);
assert.equal(valid.valid, true);
assert.equal(valid.errors.length, 0);
assert.equal(valid.rules.length, 2);
assert.equal(validateAutomationRules([schedule, { ...command, id: "morning" }]).valid, false, "duplicate IDs fail");
assert.equal(validateAutomationRules([command, { ...command, id: "again" }]).valid, false, "overlapping commands fail");
assert.equal(validateAutomationRules([command, { ...command, id: "other", scope: { groupIds: [456] } }]).valid, true, "disjoint commands may share text");
assert.equal(validateAutomationRules("bad").valid, false);

const beforeMidnight = new Date("2026-09-24T15:59:59.000Z");
const midnight = new Date("2026-09-24T16:00:00.000Z");
assert.deepEqual(dueAutomationRules(beforeMidnight, [schedule], 123), []);
assert.deepEqual(dueAutomationRules(midnight, [schedule], "group:123").map((r) => r.id), ["morning"]);
assert.deepEqual(dueAutomationRules(new Date("2026-09-24T16:02:59Z"), [schedule], 123).map((r) => r.id), ["morning"]);
assert.deepEqual(dueAutomationRules(new Date("2026-09-24T16:03:00Z"), [schedule], 123), []);
assert.deepEqual(dueAutomationRules(midnight, [schedule], "group:456"), [], "other groups do not match");
assert.deepEqual(dueAutomationRules(midnight, [{ ...schedule, enabled: false }], 123), [], "disabled schedules do not match");
assert.equal(automationOccurrenceKey(schedule, 123, midnight), automationOccurrenceKey(schedule, "group:123", new Date("2026-09-24T16:02:00Z")));
assert.notEqual(automationOccurrenceKey(schedule, 123, midnight), automationOccurrenceKey(schedule, 123, new Date("2026-09-25T16:00:00Z")));
assert.throws(() => automationOccurrenceKey(schedule, 123, beforeMidnight), /not due/);

const late = {
  ...schedule,
  id: "late",
  trigger: { type: "schedule", time: "23:59", windowMinutes: 3, daysOfWeek: [4] }
};
assert.deepEqual(dueAutomationRules(new Date("2026-09-24T16:01:00Z"), [late], 123).map((r) => r.id), ["late"], "midnight spill belongs to prior local weekday");
assert.equal(automationOccurrenceKey(late, 123, new Date("2026-09-24T15:59:00Z")), automationOccurrenceKey(late, 123, new Date("2026-09-24T16:01:00Z")));

const la = { ...schedule, id: "la", timezone: "America/Los_Angeles", trigger: { type: "schedule", time: "03:00" } };
assert.deepEqual(dueAutomationRules(new Date("2026-03-08T09:59:00Z"), [la], 123), []);
assert.deepEqual(dueAutomationRules(new Date("2026-03-08T10:00:00Z"), [la], 123).map((r) => r.id), ["la"], "DST transition uses actual timezone");
const repeated = { ...la, trigger: { type: "schedule", time: "01:30" } };
assert.equal(automationOccurrenceKey(repeated, 123, new Date("2026-11-01T08:30:00Z")), automationOccurrenceKey(repeated, 123, new Date("2026-11-01T09:30:00Z")), "repeated DST hour is one local-date occurrence");

assert.deepEqual(matchAutomationCommand(" /digest ", [command], 123).map((r) => r.id), ["digest"]);
assert.deepEqual(matchAutomationCommand("/digest", [command], "private:9").map((r) => r.id), ["digest"]);
assert.deepEqual(matchAutomationCommand("/digest", [command], 456), []);
assert.deepEqual(matchAutomationCommand("/digest extra", [command], 123), [], "arguments are not command text");
assert.deepEqual(matchAutomationCommand("/digest", [{ ...command, enabled: false }], 123), []);
assert.deepEqual(dueAutomationRules(midnight, [command], 123), [], "commands are not schedules");
assert.notEqual(automationOccurrenceKey(command, 123, midnight), automationOccurrenceKey(command, 123, new Date(midnight.getTime() + 1)));

for (const text of ["/bot", "/digest now", "/digest;rm", "/digest|sh", "$(rm -rf x)", " /digest", "/Digest", "/digest\nmore"]) {
  assert.equal(validateAutomationRules([{ ...command, trigger: { type: "command", text } }]).valid, false, `unsafe/ambiguous command rejected: ${JSON.stringify(text)}`);
}
for (const rule of [
  { ...schedule, timezone: "Not/AZone" },
  { ...schedule, scope: { groupIds: ["*"] } },
  { ...schedule, trigger: { type: "schedule", time: "24:00" } },
  { ...schedule, trigger: { type: "schedule", time: "09:00", windowMinutes: 60 } },
  { ...schedule, action: { kind: "shell", command: "ls" } },
  { ...schedule, prompt: "" },
  { ...schedule, prompt: "a".repeat(4001) },
  { ...schedule, extra: true }
]) assert.equal(validateAutomationRules([rule]).valid, false);
assert.throws(() => dueAutomationRules(midnight, [schedule, { ...schedule }], 123), /duplicate id/);

const at = { ...schedule, id: "once", trigger: { type: "at", at: "2026-10-23T08:30:00+08:00" } };
const start = Date.parse("2026-10-23T00:30:00Z");
const once = normalizeAutomationRule(at);
assert.deepEqual(once.trigger, { type: "at", at: "2026-10-23T00:30:00.000Z", windowMinutes: 3 });
assert.equal(at.trigger.at, "2026-10-23T08:30:00+08:00", "input unchanged");
for (const [delta, due] of [[-1, false], [0, true], [1, true], [179999, true], [180000, false], [86400000, false]]) {
  assert.equal(dueAutomationRules(start + delta, [at], 123).length, due ? 1 : 0, `at window boundary ${delta}`);
  if (!due) assert.throws(() => automationOccurrenceKey(at, 123, start + delta), /not due/);
}
assert.deepEqual(dueAutomationRules(start, [{ ...at, enabled: false }], 123), []);
assert.deepEqual(dueAutomationRules(start, [at], 456), []);
assert.deepEqual(matchAutomationCommand("/digest", [at], 123), []);
for (const windowMinutes of [1, 15]) {
  const rule = { ...at, trigger: { ...at.trigger, windowMinutes } };
  assert.equal(dueAutomationRules(start + windowMinutes * 60000 - 1, [rule], 123).length, 1);
  assert.equal(dueAutomationRules(start + windowMinutes * 60000, [rule], 123).length, 0);
}
for (const value of ["0001-01-01T00:00:00+14:00", "9999-12-31T23:59:59-14:00"]) assert.throws(() => normalizeAutomationRule({ ...at, trigger: { type: "at", at: value } }), /trigger.at/);
const key = automationOccurrenceKey(at, 123, start);
assert.deepEqual(JSON.parse(key), ["once", "group:123", once.trigger.at]);
assert.equal(key, automationOccurrenceKey({ ...at, timezone: "America/Los_Angeles", trigger: { ...at.trigger, at: once.trigger.at, windowMinutes: 15 } }, 123, start + 179999), "same absolute occurrence despite zone, spelling, window, and now");
assert.notEqual(key, automationOccurrenceKey({ ...at, trigger: { ...at.trigger, at: "2026-10-24T00:30:00Z" } }, 123, start + 86400000));
// Model the caller's durable claim immediately before wire, not while scanning.
const claims = new Set(); let attempts = 0;
function tick(now, allowed = true, wireFails = false) {
  for (const rule of dueAutomationRules(now, [at], 123)) {
    if (!allowed) continue;
    const occurrence = automationOccurrenceKey(rule, 123, now);
    if (claims.has(occurrence)) continue;
    claims.add(occurrence); attempts++;
    if (wireFails) return; // uncertain/failed wire retains claim, never replays
  }
}
tick(start - 1); tick(start, false); assert.equal(claims.size, 0);
tick(start + 1, true, true); tick(start + 2); tick(start + 179999); tick(start + 180000);
assert.equal(attempts, 1); assert.equal(claims.size, 1);
for (const value of ["2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-13-01T12:00:00Z", "2026-01-00T12:00:00Z", "0000-01-01T12:00:00Z", "2026-10-23", "2026-10-23T08:30:00", "2026-10-23T24:00:00Z", "2026-10-23T08:30:60Z", "2026-10-23T08:30:00+14:01", "2026-10-23T08:30:00+24:00", "2026-10-23T08:30:00.1234Z", null, 123]) {
  assert.throws(() => normalizeAutomationRule({ ...at, trigger: { type: "at", at: value } }), /trigger.at/, String(value));
}
assert.equal(normalizeAutomationRule({ ...at, trigger: { type: "at", at: "2028-02-29T12:00:00-05:00" } }).trigger.at, "2028-02-29T17:00:00.000Z");
for (const windowMinutes of [0, 16, -1, 1.5, "3", null]) assert.throws(() => normalizeAutomationRule({ ...at, trigger: { ...at.trigger, windowMinutes } }), /windowMinutes/);
for (const kind of ["message", "summary", "task"]) assert.equal(normalizeAutomationRule({ ...at, action: { kind } }).action.kind, kind);
assert.throws(() => normalizeAutomationRule({ ...at, trigger: { ...at.trigger, runAt: start } }), /not supported/);
console.log(JSON.stringify({ ok: true, assertions: "normalization, timezone/DST, scope, commands, limits; strict at calendar/offsets, finite window, stable key, caller claim timing and no replay simulation" }));
