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
assert.deepEqual(migrated.accounts.items[0].style, { systemPrompt: legacy.prompt.system });
assert.equal(effectiveAccount(migrated, "standby-a").style.systemPrompt, legacy.prompt.system);
assert.equal(migrated.accounts.failoverGroups[0].policy.style.systemPrompt, legacy.prompt.system);

const styledLegacy = structuredClone(legacy);
styledLegacy.accounts.topology = "function_split";
styledLegacy.styleProfiles = { activeId: "legacy", profiles: [{ id: "legacy", systemPrompt: "" }, { id: "custom", systemPrompt: "旧模板风格" }] };
styledLegacy.accounts.primary.promptOverride = "  小跟班原有提示词\n完整保留  ";
styledLegacy.accounts.standbys[0].styleProfileId = "custom";
const snapshots = registryConfig(styledLegacy, { strict: true });
assert.equal(snapshots.accounts.items[0].style.systemPrompt, styledLegacy.accounts.primary.promptOverride, "preserve exact legacy text including whitespace");
assert.equal(snapshots.accounts.items[1].style.systemPrompt, "旧模板风格");
const changedTemplates = structuredClone(snapshots);
changedTemplates.prompt.system = "新全局模板";
changedTemplates.styleProfiles.profiles[1].systemPrompt = "新风格模板";
changedTemplates.styleProfiles.activeId = "custom";
assert.deepEqual(registryConfig(changedTemplates).accounts.items.map((item) => item.style), snapshots.accounts.items.map((item) => item.style));
const templateSync = syncLegacyAccountPatch(snapshots, changedTemplates, { prompt: changedTemplates.prompt, styleProfiles: changedTemplates.styleProfiles });
assert.deepEqual(templateSync.accounts.items.map((item) => item.style), snapshots.accounts.items.map((item) => item.style));
const pendingMigration = structuredClone(styledLegacy);
pendingMigration.prompt.system = "更新后的全局模板";
const pendingSync = syncLegacyAccountPatch(styledLegacy, pendingMigration, { prompt: pendingMigration.prompt });
assert.equal(pendingSync.accounts.items[0].style.systemPrompt, styledLegacy.accounts.primary.promptOverride);
const pendingGlobal = structuredClone(legacy);
const updatedGlobal = structuredClone(pendingGlobal);
updatedGlobal.prompt.system = "新全局但旧 bot 应冻结旧文字";
assert.equal(syncLegacyAccountPatch(pendingGlobal, updatedGlobal, { prompt: updatedGlobal.prompt }).accounts.items[0].style.systemPrompt, legacy.prompt.system);

const fresh = newAccount(snapshots, { id: "fresh" }, [7100, 7101, 7102, 7103]);
assert.deepEqual(fresh.style, { systemPrompt: "" }, "new accounts start blank, not from the active template");
snapshots.accounts.items[0].features.automation = true;
snapshots.accounts.items[0].modelBindings.chat = "source-only";
snapshots.accounts.items[0].voice = { mode: "force", preset: "source-only" };
snapshots.accounts.items[0].scope = { groups: true, private: false, groupMode: "allowlist", groupIds: ["900001"] };
const copied = newAccount(snapshots, { id: "copied", copyStyleFromAccountId: "original" });
assert.deepEqual(copied.style, snapshots.accounts.items[0].style);
assert.notEqual(copied.style, snapshots.accounts.items[0].style);
assert.equal(Object.hasOwn(copied, "copyStyleFromAccountId"), false, "copy instruction is not stored");
assert.equal(copied.qq, "");
assert.equal(copied.displayName, "机器人 3");
assert.equal(copied.features.automation, false);
assert.equal(copied.features.asr, false);
assert.equal(copied.sendTypes.record, false);
assert.deepEqual(copied.modelBindings, fresh.modelBindings);
assert.deepEqual(copied.voice, fresh.voice);
assert.deepEqual(copied.scope, fresh.scope);
assert.equal(Object.hasOwn(copied, "memory"), false);
copied.style.systemPrompt = "副本独立修改";
assert.equal(snapshots.accounts.items[0].style.systemPrompt, styledLegacy.accounts.primary.promptOverride);
snapshots.accounts.items[0].style.systemPrompt = "源独立修改";
assert.equal(copied.style.systemPrompt, "副本独立修改");
assert.equal(newAccount(snapshots, { copyStyleFromAccountId: "original", style: { systemPrompt: "" } }).style.systemPrompt, "");
assert.throws(() => newAccount(snapshots, { copyStyleFromAccountId: "missing" }), /源账号/);
assert.throws(() => newAccount(snapshots, { copyStyleFromAccountId: 1 }), /源账号/);
assert.throws(() => newAccount(snapshots, { copyPermissionsFromAccountId: "original" }), /字段/);
const retiredSource = structuredClone(snapshots);
retiredSource.accounts.items[0].archived = true;
assert.throws(() => newAccount(retiredSource, { copyStyleFromAccountId: "original" }), /源账号/);

const styleAccount = snapshots.accounts.items[1];
assert.equal(mergeAccountPatch(styleAccount, { promptOverride: "兼容旧编辑" }, snapshots).style.systemPrompt, "兼容旧编辑");
assert.equal(mergeAccountPatch(styleAccount, { promptOverride: "" }, snapshots).style.systemPrompt, "旧模板风格");
assert.equal(mergeAccountPatch(styleAccount, { styleProfileId: "legacy" }, snapshots).style.systemPrompt, styledLegacy.prompt.system);
assert.equal(mergeAccountPatch(styleAccount, { promptOverride: "旧字段", style: { systemPrompt: "" } }, snapshots).style.systemPrompt, "");
assert.deepEqual(mergeAccountPatch(styleAccount, { displayName: "只改名" }, changedTemplates).style, styleAccount.style);
assert.equal(mergeAccountPatch(fresh, { promptOverride: "无 config 也能更新文字" }).style.systemPrompt, "无 config 也能更新文字");
for (const style of [null, {}, [], "text", { systemPrompt: 12 }, { systemPrompt: "x", extra: true }, { systemPrompt: "x".repeat(12001) }]) {
  assert.throws(() => mergeAccountPatch(styleAccount, { style }, snapshots), /style/);
  assert.throws(() => registryConfig({ accounts: { version: 2, items: [{ id: "invalid", style }], failoverGroups: [] } }), /style/);
}
const legacyPromptSync = syncLegacyAccountPatch(snapshots, structuredClone(snapshots), { accounts: { promptOverrides: { "standby-a": "旧 promptOverrides 更新" } } });
assert.equal(legacyPromptSync.accounts.items[1].style.systemPrompt, "旧 promptOverrides 更新");
const legacyClearSync = syncLegacyAccountPatch(legacyPromptSync, structuredClone(legacyPromptSync), { accounts: { promptOverrides: { "standby-a": "" } } });
assert.equal(legacyClearSync.accounts.items[1].style.systemPrompt, "旧模板风格");
assert.throws(() => syncLegacyAccountPatch(snapshots, structuredClone(snapshots), { accounts: { promptOverrides: { "standby-a": 12 } } }), /文本/);
const sharedStyleSync = syncLegacyAccountPatch(migrated, structuredClone(migrated), { accounts: { promptOverrides: { original: "共享身份新风格" } } });
assert.equal(effectiveAccount(sharedStyleSync, "standby-a").style.systemPrompt, "共享身份新风格");

const oldGroup = structuredClone(snapshots);
oldGroup.accounts.failoverGroups = [{ id: "old-group", name: "旧共享身份", memberIds: ["original", "standby-a"], policyAccountId: "original",
  policy: { displayName: "共享", promptOverride: "旧组专属提示词", styleProfileId: "custom" }, settings: {} }];
const normalizedGroup = registryConfig(oldGroup, { strict: true });
assert.equal(normalizedGroup.accounts.failoverGroups[0].policy.style.systemPrompt, "旧组专属提示词", "source snapshot must not overwrite legacy group override");
assert.equal(effectiveAccount(normalizedGroup, "standby-a").style.systemPrompt, "旧组专属提示词");
assert.equal(newAccount(normalizedGroup, { copyStyleFromAccountId: "standby-a" }).style.systemPrompt, "旧组专属提示词", "copy the effective failover policy, not the transport's own style");
oldGroup.accounts.failoverGroups[0].policy.promptOverride = "";
assert.equal(registryConfig(oldGroup).accounts.failoverGroups[0].policy.style.systemPrompt, "旧模板风格");
oldGroup.accounts.failoverGroups[0].policy.styleProfileId = "legacy";
assert.equal(registryConfig(oldGroup).accounts.failoverGroups[0].policy.style.systemPrompt, styledLegacy.prompt.system);
oldGroup.accounts.failoverGroups[0].policy.style = { systemPrompt: "" };
assert.equal(effectiveAccount(oldGroup, "standby-a").style.systemPrompt, "", "explicit empty group style wins over all old fields");
delete oldGroup.accounts.failoverGroups[0].policy.style;
delete oldGroup.accounts.failoverGroups[0].policy.promptOverride;
delete oldGroup.accounts.failoverGroups[0].policy.styleProfileId;
assert.equal(registryConfig(oldGroup).accounts.failoverGroups[0].policy.style.systemPrompt, "源独立修改", "group without old style settings starts from source snapshot");
normalizedGroup.prompt.system = "新全局";
normalizedGroup.styleProfiles.profiles[1].systemPrompt = "新模板";
normalizedGroup.accounts.items[0].style.systemPrompt = "源再次修改";
assert.equal(effectiveAccount(normalizedGroup, "standby-a").style.systemPrompt, "旧组专属提示词");
assert.deepEqual(registryConfig(registryConfig(normalizedGroup)), registryConfig(normalizedGroup), "group snapshots are idempotent after refreshing legacy projections");

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
assert.equal(after.accounts.items.find((a) => a.id === "bot4").style.systemPrompt, "只改这个");
assert.deepEqual(after.accounts.items.find((a) => a.id === "bot5"), before.accounts.items.find((a) => a.id === "bot5"));
assert.throws(() => syncLegacyAccountPatch(independent, structuredClone(independent), { accounts: { standbys: [{ displayName: "no id" }] } }), /定位/);

const safe = publicAccount({ ...independent.accounts.items[0], accessToken: "DO_NOT_LEAK", onebotWsUrl: "ws://localhost:1234/?access_token=DO_NOT_LEAK&path=ok" });
assert(!JSON.stringify(safe).includes("DO_NOT_LEAK"));
assert(safe.onebotWsUrl.includes("path=ok"));
assert.deepEqual(safe.style, independent.accounts.items[0].style);

const delivery = (action, params, options = {}) => accountDeliveryDecision(independent, "bot3", action, params, options);
for (const action of ["group_poke", "friend_poke", "send_poke"])
  assert.equal(delivery(action, { group_id: "900001", user_id: "900002" }).allowed, false, "unverified native interaction cannot bypass send policy");
assert.equal(delivery("get_status", {}).allowed, true, "read-only protocol status remains compatible");
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

// Management names and self-address are separate, owner-local snapshots.
const namesLegacy = { ...structuredClone(legacy), memory: { untouched: ["原有记忆"] } };
namesLegacy.accounts.topology = "function_split";
const namesBefore = structuredClone(namesLegacy);
const namesConfig = registryConfig(namesLegacy, { strict: true });
assert.equal(namesConfig.accounts.items[0].selfName, "旧机器人", "missing legacy selfName snapshots its original displayName");
assert.equal(namesConfig.accounts.items[1].selfName, "旧备用", "independent legacy account keeps its own name");
assert.deepEqual(namesLegacy, namesBefore);
assert.deepEqual(namesConfig.memory, namesLegacy.memory);
assert.deepEqual(registryConfig(namesConfig, { strict: true }), namesConfig);
const originalNamedAccount = namesConfig.accounts.items[0];
const selfOnly = mergeAccountPatch(originalNamedAccount, { selfName: "小墨" }, namesConfig);
assert.equal(selfOnly.displayName, "旧机器人");
assert.equal(selfOnly.selfName, "小墨");
assert.deepEqual(selfOnly.style, originalNamedAccount.style);
const managementOnly = mergeAccountPatch(selfOnly, { displayName: "客服管理卡片" }, namesConfig);
assert.equal(managementOnly.selfName, "小墨", "management rename must not overwrite explicit selfName");
assert.equal(mergeAccountPatch(originalNamedAccount, { displayName: "新管理名称" }).selfName, "旧机器人", "legacy selfName is frozen after migration");
assert.equal(mergeAccountPatch({ id: "raw", displayName: "未迁移旧名称" }, { displayName: "新名称" }).selfName,
  "未迁移旧名称", "patch before normalization also preserves old identity");
const clearedName = mergeAccountPatch(managementOnly, { selfName: "" }, namesConfig);
assert.equal(clearedName.selfName, "", "explicit empty is a supported stored fallback, not a migration signal");
assert.equal(publicAccount(clearedName).selfName, "", "public account whitelist includes selfName");
assert.equal(accountPolicy(selfOnly).selfName, "小墨", "group policy whitelist includes selfName");
assert.equal(namesConfig.accounts.items[1].selfName, "旧备用", "patch A never changes B");
assert.equal(newAccount(namesConfig, { id: "named-new", displayName: "管理名", selfName: "聊天名" }).selfName, "聊天名");
assert.equal(newAccount(namesConfig, { id: "default-new", displayName: "管理名" }).selfName, "", "new account defaults to its own displayName fallback");
assert.equal(newAccount(namesConfig, { id: "style-only-copy", copyStyleFromAccountId: "original" }).selfName, "", "copying style must not copy another account's selfName");
for (const value of [null, undefined, 12, {}, " ", "a".repeat(101), "bad\nname", "bad\u0000name"]) {
  assert.throws(() => mergeAccountPatch(originalNamedAccount, { selfName: value }), /selfName/);
  assert.throws(() => newAccount(namesConfig, { id: "bad-self", selfName: value }), /selfName/);
  const invalid = structuredClone(namesConfig);
  invalid.accounts.items[0].selfName = value;
  assert.throws(() => registryConfig(invalid, { strict: true }), /selfName/);
}
const namePatch = { accounts: { primary: { selfName: "旧API自称" } } };
const legacyNamesPatched = syncLegacyAccountPatch(namesConfig, structuredClone(namesConfig), namePatch);
assert.equal(legacyNamesPatched.accounts.items[0].selfName, "旧API自称");
assert.equal(legacyNamesPatched.accounts.items[0].displayName, "旧机器人");
assert.deepEqual(legacyNamesPatched.accounts.items[1], namesConfig.accounts.items[1]);
assert.deepEqual(legacyNamesPatched.memory, namesConfig.memory);

const namesGroup = structuredClone(namesConfig);
namesGroup.accounts.items[0].selfName = "源账号专属自称";
namesGroup.accounts.failoverGroups = [{ id: "name-team", name: "接管组管理标签", memberIds: ["original", "standby-a"],
  policyAccountId: "original", policy: { displayName: "此前共享称呼" } }];
const migratedNamesGroup = registryConfig(namesGroup, { strict: true });
assert.equal(migratedNamesGroup.accounts.failoverGroups[0].policy.selfName, "此前共享称呼", "legacy shared displayName takes precedence over source's new selfName");
for (const id of ["original", "standby-a"]) assert.equal(effectiveAccount(migratedNamesGroup, id).selfName, "此前共享称呼");
migratedNamesGroup.accounts.failoverGroups[0].policy.displayName = "新组管理名称";
assert.equal(effectiveAccount(migratedNamesGroup, "standby-a").selfName, "此前共享称呼", "later management rename cannot overwrite migrated shared selfName");
migratedNamesGroup.accounts.failoverGroups[0].policy.selfName = "";
assert.equal(effectiveAccount(migratedNamesGroup, "standby-a").selfName, "");
assert.deepEqual(registryConfig(registryConfig(migratedNamesGroup)), registryConfig(migratedNamesGroup));
delete namesGroup.accounts.failoverGroups[0].policy.displayName;
assert.equal(effectiveAccount(namesGroup, "standby-a").selfName, "源账号专属自称", "group without its own legacy name inherits source selfName");
assert.deepEqual(namesLegacy, namesBefore, "all name operations leave legacy input and memory untouched");
console.log("account registry and delivery self-test: PASS");
