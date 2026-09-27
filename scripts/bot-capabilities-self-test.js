import assert from "node:assert/strict";
import { accountCanChat, accountCanOfferTask, accountTopology, botModeForAccount, botSelfSlot, systemPromptForAccount } from "../src/bot-capabilities.js";

const legacy = { prompt: { system: "原有风格" }, accounts: { primary: { id: "primary" }, standbys: [{ id: "standby-a" }] } };
assert.equal(botModeForAccount(legacy, "primary"), "all");
assert.equal(accountTopology(legacy), "failover");
assert.equal(systemPromptForAccount(legacy, "primary"), "原有风格");

const configured = {
  ...legacy,
  botFeatures: { defaultMode: "all", accountModes: { primary: "chat", "standby-a": "task" } },
  styleProfiles: { activeId: "legacy", profiles: [{ id: "legacy", systemPrompt: "" }, { id: "task-style", systemPrompt: "任务风格" }] },
  accounts: { topology: "function_split", primary: { id: "primary" }, standbys: [{ id: "standby-a", styleProfileId: "task-style" }] }
};
assert.equal(accountTopology(configured), "function_split");
assert.equal(accountCanChat(configured, "primary"), true);
assert.equal(accountCanOfferTask(configured, "primary"), false);
assert.equal(accountCanChat(configured, "standby-a"), false);
assert.equal(accountCanOfferTask(configured, "standby-a"), true);
assert.equal(systemPromptForAccount(configured, "standby-a"), "任务风格");
assert.equal(systemPromptForAccount(configured, "primary"), "原有风格");
assert.equal(botModeForAccount({ botFeatures: { defaultMode: "invalid" } }), "all");
const shared = { users: { "123": { names: ["群友"] } }, facts: ["群事实"], botSelf: { identity: ["原有小跟班"] } };
const primarySelf = botSelfSlot(shared, { ...configured, __activeAccountId: "primary" });
const secondarySelf = botSelfSlot(shared, { ...configured, __activeAccountId: "standby-a" });
secondarySelf.identity = ["独立任务 bot"];
assert.notEqual(primarySelf, secondarySelf);
assert.deepEqual(shared.botSelf.identity, ["原有小跟班"]);
assert.deepEqual(shared.botSelfByAccount["standby-a"].identity, ["独立任务 bot"]);
assert.deepEqual(shared.users["123"].names, ["群友"]);
assert.deepEqual(shared.facts, ["群事实"]);
assert.equal(botSelfSlot(shared, { ...legacy, __activeAccountId: "standby-a" }), shared.botSelf);
assert.equal(botModeForAccount({ ...configured, accounts: { ...configured.accounts, topology: "failover" } }, "standby-a"), "chat");
assert.equal(systemPromptForAccount({ ...configured, accounts: { ...configured.accounts, topology: "failover", primary: { id: "primary", styleProfileId: "legacy" } } }, "standby-a"), "原有风格");
console.log(JSON.stringify({ ok: true, tests: 17 }));
