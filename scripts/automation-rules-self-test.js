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

console.log(JSON.stringify({ ok: true, assertions: "normalization, duplicate/ambiguous validation, timezone/DST/date boundaries, scope, disabled, command safety, limits" }));
