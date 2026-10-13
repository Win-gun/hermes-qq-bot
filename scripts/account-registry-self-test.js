import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountGroup, accountItems, accountPolicy, effectiveAccount, mergeAccountPatch, newAccount, publicAccount, registryConfig, syncLegacyAccountPatch } from "../src/account-registry.js";
import { accountDeliveryDecision, GroupSendCoordinator, messageContentTypes } from "../src/account-delivery.js";

const legacy = {
  prompt: { system: "原来的风格，不可丢失" }, voice: { enabled: true },
  accounts: { topology: "failover", primary: { id: "original", qq: "100001", protocol: "napcat", displayName: "旧机器人" },
    standbys: [{ id: "standby-a", qq: "100002", protocol: "napcat", displayName: "旧备用" }], failover: { switchAfterMs: 60000 } }
};
const original = structuredClone(legacy);
const migrated = registryConfig(legacy, { strict: true });
assert.deepEqual(legacy, original, "migration must not mutate source");
assert.equal(migrated.accounts.legacyPrimaryId, "original");
assert.equal(migrated.prompt.system, legacy.prompt.system);
assert.equal(accountGroup(migrated, "standby-a").legacySelfMemory, true);
assert.equal(effectiveAccount(migrated, "standby-a").displayName, "旧机器人");
assert.equal(effectiveAccount(migrated, "standby-a").qq, "100002", "group must not replace transport identity");
assert.deepEqual(registryConfig(migrated), migrated, "migration must be idempotent");

let independent = registryConfig({ ...legacy, accounts: { ...legacy.accounts, topology: "function_split" } });
for (let i = 0; i < 6; i += 1) {
  independent.accounts.items.push(newAccount(independent, {
    id: `bot${i}`, qq: `${200001 + i}`, managed: false, onebotWsUrl: `ws://127.0.0.1:${6400 + i}`,
    enabled: true, displayName: `独立 ${i}`
  }));
}
independent = registryConfig(independent, { strict: true });
assert.equal(accountItems(independent).length, 8, "no arbitrary account count limit");
assert.equal(independent.accounts.standbys.length, 7, "legacy projection must not truncate");
assert.equal(independent.accounts.items.at(-1).sendTypes.record, false, "new accounts are text only");
assert.equal(newAccount(independent, {}, [7100, 7101, 7102, 7103]).enabled, false);
assert.throws(() => newAccount(independent, { enabled: "false" }), /开关/);
assert.throws(() => newAccount(independent, { promptOverride: 32 }), /文本/);
assert.throws(() => newAccount(independent, { managed: false }), /WebSocket/);
assert.throws(() => mergeAccountPatch(independent.accounts.items[0], { id: "other" }), /字段/);
const bad = (mutate) => { const candidate = structuredClone(independent); mutate(candidate); assert.throws(() => registryConfig(candidate, { strict: true })); };
bad((c) => c.accounts.items[1].id = c.accounts.items[0].id);
bad((c) => c.accounts.items[1].qq = c.accounts.items[0].qq);
bad((c) => c.accounts.items[1].protocol = "invented");
bad((c) => c.accounts.items[1].enabled = "false");
bad((c) => c.accounts.items[1].features.chat = "false");
bad((c) => c.accounts.items[1].sendTypes = { json: true });
bad((c) => c.accounts.items[1].scope.groupMode = "invented");
bad((c) => c.accounts.items[1].onebotWsUrl = "http://example.test/");
bad((c) => c.accounts.items[1].onebotWsUrl = "ws://user:password@localhost:1234");
bad((c) => c.accounts.items[1].protocolContainer = c.accounts.items[0].protocolContainer);
bad((c) => { c.accounts.items[0].webuiPort = 6500; c.accounts.items[1].webuiPort = 6500; });

const group = (id, members) => ({ id, name: id, memberIds: members, policyAccountId: members[0],
  policy: accountPolicy(independent.accounts.items.find((a) => a.id === members[0])), settings: {} });
independent.accounts.failoverGroups = [group("groupA", ["original", "standby-a"]), group("groupB", ["bot0", "bot1"])];
independent = registryConfig(independent, { strict: true });
assert.equal(accountGroup(independent, "bot0").id, "groupB");
assert.equal(accountGroup(independent, "bot3"), null);
assert.equal(effectiveAccount(independent, "bot1").displayName, "独立 0");
bad((c) => c.accounts.failoverGroups[1].memberIds = ["bot0", "standby-a"]);
bad((c) => c.accounts.failoverGroups[0].policy.enabled = false);
bad((c) => c.accounts.failoverGroups[0].policy.features.chat = "false");
assert.throws(() => syncLegacyAccountPatch(independent, structuredClone(independent), { accounts: { topology: "collaboration" } }), /旧接口/);

const before = structuredClone(independent);
const after = syncLegacyAccountPatch(independent, structuredClone(independent), { accounts: { standbys: [{ id: "bot4", promptOverride: "只改这个" }] } });
assert.equal(after.accounts.items.find((a) => a.id === "bot4").promptOverride, "只改这个");
assert.deepEqual(after.accounts.items.find((a) => a.id === "bot5"), before.accounts.items.find((a) => a.id === "bot5"));
assert.throws(() => syncLegacyAccountPatch(independent, structuredClone(independent), { accounts: { standbys: [{ displayName: "no id" }] } }), /定位/);

const safe = publicAccount({ ...independent.accounts.items[0], accessToken: "DO_NOT_LEAK", onebotWsUrl: "ws://localhost:1234/?access_token=DO_NOT_LEAK&path=ok" });
assert(!JSON.stringify(safe).includes("DO_NOT_LEAK"));
assert(safe.onebotWsUrl.includes("path=ok"));

const delivery = (action, params, options = {}) => accountDeliveryDecision(independent, "bot3", action, params, options);
assert.equal(delivery("send_group_msg", { group_id: "900001", message: "hello" }).allowed, true);
assert.equal(delivery("send_group_msg", { group_id: "900001", message: "hello" }, { quiet: true }).allowed, false);
assert.equal(delivery("send_private_msg", { user_id: "900002", message: [{ type: "record", data: { file: "a.wav" } }] }).allowed, false);
assert.equal(delivery("send_private_msg", { user_id: "900002", message: "[CQ:record,file=a.wav]" }).allowed, false);
assert.equal(delivery("send_group_forward_msg", { group_id: "900001", messages: [] }).allowed, false);
assert.equal(delivery("send_group_forward_msg", { group_id: "900001", messages: [{ type: "node", data: { content: "hello" } }] }).allowed, true);
assert.equal(delivery("send_group_forward_msg", { group_id: "900001", messages: [{ type: "node", data: { content: [{ type: "record", data: { file: "x.mp3" } }] } }] }).allowed, false);
assert.equal(accountDeliveryDecision(independent, "standby-a", "send_private_msg", { user_id: "900002", message: "hello" }).allowed, false);
assert.equal(accountDeliveryDecision(independent, "standby-a", "send_private_msg", { user_id: "900002", message: "hello" }, { activeGroupAccountId: "standby-a" }).allowed, true);
independent.accounts.items.find((a) => a.id === "bot3").sendTypes.file = true;
assert.equal(delivery("upload_group_file", { group_id: "900001", name: "not_audio.txt", file: "/a/test.mp3" }).allowed, false);
assert.equal(delivery("send_private_msg", { user_id: "900002", message: [{ type: "file", data: { file: "test.mp3" } }] }).allowed, false);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-media-policy-"));
try {
  const filename = path.join(fixture, "disguised.txt");
  fs.writeFileSync(filename, Buffer.from("RIFF0000WAVEtest", "latin1"));
  assert.equal(delivery("upload_group_file", { group_id: "900001", name: "plain.txt", file: filename }).allowed, false, "audio signature cannot bypass policy by rename");
} finally { fs.rmSync(fixture, { force: true, recursive: true }); }
assert.deepEqual(messageContentTypes([{ type: "node", data: { content: [{ type: "image", data: { file: "x.png" } }] } }]), ["image"]);
independent.accounts.items.find((a) => a.id === "bot3").scope = { groups: true, private: false, groupMode: "allowlist", groupIds: ["900001"] };
assert.equal(delivery("send_group_msg", { group_id: "900003", message: "hello" }).allowed, false);
assert.equal(delivery("send_private_msg", { user_id: "900002", message: "hello" }).allowed, false);

const coordinator = new GroupSendCoordinator({ minDelayMs: () => 30 });
const sent = [];
let enabled = true;
const validate = () => { if (!enabled) throw new Error("paused"); };
await Promise.all(Array.from({ length: 5 }, (_, i) => coordinator.dispatch("g", validate, () => { sent.push({ i, at: Date.now() }); })));
assert.deepEqual(sent.map((item) => item.i), [0, 1, 2, 3, 4], "no reply count cap");
assert(sent.slice(1).every((item, index) => item.at - sent[index].at >= 25), "group pacing across accounts");
const queued = coordinator.dispatch("g", validate, () => assert.fail("paused item sent"));
enabled = false;
await assert.rejects(queued, /paused/);
assert.equal(coordinator.tails.size, 0);
console.log("account registry and delivery self-test: PASS");
