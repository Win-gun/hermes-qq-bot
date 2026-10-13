import assert from "node:assert/strict";
import { registryConfig } from "../src/account-registry.js";
import { botCommandText, botCommandAlias, botCommandFeedback, groupCommandBots, routeBotCommand, GroupBotMembership } from "../src/bot-command-routing.js";

const config = registryConfig({ accounts: { version: 2, topology: "function_split", items: [
  { id: "one", qq: "91000", displayName: "one", protocol: "napcat" },
  { id: "two", qq: "91001", displayName: "two", protocol: "napcat" },
  { id: "elsewhere", qq: "91002", displayName: "elsewhere", protocol: "napcat" }
], failoverGroups: [] } });
const options = { selectedForGroup: (group) => group.memberIds[0], connected: (id) => id !== "two" };
const bots = groupCommandBots(config, "810001", ["91000", "91001"], options);
assert.equal(bots.length, 2);
assert.deepEqual(bots.map((b) => b.alias), ["a", "b"]);
assert.equal(routeBotCommand("/bot", bots).accountId, "one");
assert.match(routeBotCommand("/bot mode lively", bots).notice, /\/bot a/);
assert.match(routeBotCommand("/bot b status", bots).notice, /暂不可用/);
assert.match(routeBotCommand("/bot z quiet", bots).notice, /未找到/);
assert.equal(routeBotCommand("/bot a mode lively", bots).text, "/bot mode lively");
assert.equal(routeBotCommand("/BOT A", bots).text, "/bot help");
assert.equal(routeBotCommand("/bot status", bots.slice(0, 1)).text, "/bot status");
assert.equal(routeBotCommand("/botanical quiet", bots), null);
assert.equal(botCommandText("[引用消息] /bot a status"), "/bot a status");
assert.equal(botCommandAlias(25), "z"); assert.equal(botCommandAlias(26), "aa"); assert.equal(botCommandAlias(701), "zz");
assert.equal(botCommandFeedback("用 /bot voice mixed", { __botCommandAlias: "b" }), "用 /bot b voice mixed");
const grouped = registryConfig({ ...config, accounts: { ...config.accounts, failoverGroups: [
  { id: "same-bot", name: "shared", memberIds: ["one", "two"], policyAccountId: "one" }
] } });
const logical = groupCommandBots(grouped, "810001", ["91000", "91001", "91002"], options);
assert.equal(logical.length, 2); assert.equal(logical[1].id, "elsewhere");
assert.equal(groupCommandBots(grouped, "810001", ["91001"], options)[0].available, false, "selected transport outside group must not send");
const unknownQq = registryConfig({ ...config, accounts: { ...config.accounts, items: config.accounts.items.map((item) => ({ ...item, qq: "" })) } });
assert.equal(groupCommandBots(unknownQq, "810001", ["91000"], { ...options, qqForAccount: (account) => account.id === "one" ? "91000" : "" })[0].id, "one", "runtime identity can resolve an unconfigured QQ");

const members = new GroupBotMembership();
members.observe("810001", "91000"); members.observe("810001", "91001");
let calls = 0;
const query = async () => { calls++; return [{ user_id: "91000" }, { user_id: "91001" }]; };
const snapshots = await Promise.all([members.members("810001", query), members.members("810001", query)]);
assert.equal(calls, 1); assert.deepEqual(snapshots[0], snapshots[1]); assert.equal(members.isCurrent("810001", snapshots[0]), true);
members.invalidate("810001"); members.observe("810001", "91000");
const fallback = await members.members("810001", async () => { throw Error("fixture unavailable"); });
assert.deepEqual(fallback.qqs, ["91000"]); assert.equal(fallback.verified, false);
assert.equal(members.isCurrent("810001", fallback), false);
members.invalidate("810001"); await members.members("810001", query); assert.equal(calls, 2);
members.invalidate("810001"); assert.equal((await members.members("810001", async () => ({ unexpected: "payload" }))).verified, false);
// A late query must never borrow a newer query's verification after a notice.
for (const failOld of [true, false]) {
  members.invalidate("810001");
  let resolveOld, rejectOld;
  const old = members.members("810001", () => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
  await Promise.resolve();
  members.invalidate("810001");
  const fresh = await members.members("810001", query);
  if (failOld) rejectOld(Error("late failure")); else resolveOld([{ user_id: "91001" }]);
  const stale = await old;
  assert.equal(members.isCurrent("810001", stale), false);
  assert.equal(members.isCurrent("810001", fresh), true);
}
console.log("bot command routing self-test: PASS (membership, aliases, failover grouping, unavailable targets, cache and safe failure)");
