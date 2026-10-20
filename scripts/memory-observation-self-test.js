import assert from "node:assert/strict";
import { appendMemoryValue, observeUserMessage } from "../src/memory-observation.js";

const user = { names: [], preferences: ["原有偏好"], messageCount: 0,
  firstSeenAt: "2035-01-01T00:00:00Z", lastSeenAt: "2035-01-01T00:00:00Z" };
const current = { conversationId: "group:a", messageId: "later", name: "新昵称", sentAt: "2026-01-02T00:00:00Z" };
assert.equal(observeUserMessage(user, current).changed, true);
assert.equal(user.firstSeenAt, "2026-01-02T00:00:00.000Z");
assert.equal(user.lastSeenAt, user.firstSeenAt);
assert.equal(observeUserMessage(user, current).duplicate, true);
assert.equal(user.messageCount, 1);
observeUserMessage(user, { ...current, messageId: "earlier", name: "旧昵称", sentAt: "2025-12-31T00:00:00Z" });
assert.equal(user.lastName, "新昵称");
assert.equal(user.firstSeenAt, "2025-12-31T00:00:00.000Z");
assert.equal(user.lastSeenAt, "2026-01-02T00:00:00.000Z");
assert.deepEqual(user.names, ["新昵称", "旧昵称"]);
assert.equal(observeUserMessage(user, { ...current, conversationId: "group:b" }).duplicate, false);
const before = structuredClone(user);
for (const sentAt of ["invalid", NaN, Infinity]) assert.equal(observeUserMessage(user, { ...current, sentAt }).changed, false);
assert.deepEqual(user, before);
for (let i = 0; i < 100; i++) appendMemoryValue(user.preferences, `偏好${i}`);
assert.equal(user.preferences.length, 101);
assert.equal(user.preferences[0], "原有偏好");
assert.equal(appendMemoryValue(user.preferences, "偏好99"), false);
assert.equal(appendMemoryValue(user.preferences, { value: "不是文本" }), false);
assert.deepEqual(observeUserMessage({}, { ...current, conversationId: "" }), { changed: false, duplicate: false });
console.log("memory observation: event-time ordering, source idempotence and lossless durable values passed");
