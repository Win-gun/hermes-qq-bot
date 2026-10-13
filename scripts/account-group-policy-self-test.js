import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ACCOUNT_POLICY_KEYS, accountPolicy, effectiveAccount, mergeAccountPatch, registryConfig } from "../src/account-registry.js";
import { accountDeliveryDecision } from "../src/account-delivery.js";

// Execute the real bridge group route, never a copied merge implementation.
// Only the commit/HTTP boundaries are fake: no live config, disk writes,
// model calls, sockets, QQ messages or service startup.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const start = /^ {12}const groupMatch = [^\n]+\n {12}if \(groupMatch\) \{/m.exec(source)?.index ?? -1;
const end = source.indexOf('\n            return replyJson(404, { ok: false, error: "not found" });', start);
assert.ok(start >= 0 && end > start, "real bridge group route must exist");
const branch = source.slice(start, end);
assert.match(branch, /commitAccountConfig\(next\)/, "extract must include the complete commit boundary");

function functionSource(name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert.ok(match, `real bridge helper ${name} must exist`);
  const last = source.indexOf("\n}\n", match.index);
  assert.ok(last > match.index, `real bridge helper ${name} must have an end`);
  return source.slice(match.index, last + 2);
}

function fixture() {
  return registryConfig({
    prompt: { system: "global style" },
    styleProfiles: { profiles: [
      { id: "source-profile", systemPrompt: "source style" },
      { id: "group-profile", systemPrompt: "group style" },
      { id: "new-profile", systemPrompt: "new group style" }
    ] },
    accounts: { version: 2, items: [
      { id: "alpha", qq: "91001", displayName: "source name", styleProfileId: "source-profile" },
      { id: "beta", qq: "91002", displayName: "standby name" },
      { id: "independent", qq: "91003", displayName: "unrelated bot" }
    ], failoverGroups: [{ id: "team", name: "Restricted team", memberIds: ["alpha", "beta"], policyAccountId: "alpha",
      policy: { displayName: "shared identity", styleProfileId: "group-profile", promptOverride: "old group override",
        scope: { groups: true, private: false, groupMode: "allowlist", groupIds: ["900001"] },
        features: { chat: true, task: false, automation: false, vision: false },
        sendTypes: { text: true, image: false, record: false, video: false, file: false },
        voice: { mode: "off", preset: "group-only" }, modelBindings: { chat: "group-chat" }, behaviorMode: "restrained" },
      settings: { enabled: true }
    }] }
  }, { strict: true });
}

function route(current, group, { method = "PATCH", code = branch } = {}) {
  let committed = null;
  let commits = 0;
  const context = vm.createContext({
    structuredClone, ACCOUNT_POLICY_KEYS, accountPolicy, mergeAccountPatch,
    req: { method }, url: { pathname: method === "POST" ? "/api/account-groups" : "/api/account-groups/team" },
    body: { group: structuredClone(group) }, next: structuredClone(current), configRevision: "fixture-revision",
    commitAccountConfig: (candidate) => { committed = registryConfig(candidate, { strict: true }); commits += 1; },
    accountsPayload: () => ({ ok: true }), replyJson: (status, body) => ({ status, body })
  });
  new vm.Script(`${functionSource("deepClone")}\n${functionSource("isPlainObject")}`).runInContext(context);
  const response = new vm.Script(`(() => {\n${code}\n})()`, { filename: "bridge.js:account-group-route" }).runInContext(context);
  assert.equal(response.status, 200);
  assert.equal(commits, 1);
  return committed;
}

function assertRestricted(config) {
  const decision = (action, params) => accountDeliveryDecision(config, "alpha", action, params, { activeGroupAccountId: "alpha" });
  assert.equal(decision("send_group_msg", { group_id: "900001", message: "fixture" }).allowed, true, "allowed group remains usable");
  assert.equal(decision("send_group_msg", { group_id: "900002", message: "fixture" }).allowed, false, "style edits cannot broaden group allowlist");
  assert.equal(decision("send_private_msg", { user_id: "100001", message: "fixture" }).allowed, false, "style edits cannot enable private sends");
  assert.equal(decision("send_group_msg", { group_id: "900001", message: "[CQ:record,file=fixture.wav]" }).allowed, false, "style edits cannot enable voice sends");
  assert.equal(accountDeliveryDecision(config, "beta", "send_group_msg", { group_id: "900001", message: "fixture" }, { activeGroupAccountId: "alpha" }).allowed,
    false, "standby cannot bypass active-member routing");
}

const cases = [
  { name: "legacy override update", policy: { promptOverride: "updated group override" }, expected: "updated group override" },
  { name: "legacy override clear uses previous group profile", policy: { promptOverride: "" }, expected: "group style" },
  { name: "legacy profile selection", policy: { promptOverride: "", styleProfileId: "new-profile" }, expected: "new group style" },
  { name: "explicit blank canonical style", policy: { style: { systemPrompt: "" } }, expected: "" },
  { name: "canonical style wins over legacy text", policy: { style: { systemPrompt: "canonical" }, promptOverride: "ignored legacy" }, expected: "canonical" }
];
for (const test of cases) {
  const before = fixture();
  const original = structuredClone(before);
  assertRestricted(before);
  const after = route(before, { policy: test.policy });
  assertRestricted(after);
  const oldPolicy = before.accounts.failoverGroups[0].policy;
  const newPolicy = after.accounts.failoverGroups[0].policy;
  for (const key of ACCOUNT_POLICY_KEYS) if (key !== "style" && !Object.hasOwn(test.policy, key)) {
    assert.deepEqual(newPolicy[key], oldPolicy[key], `${test.name}: preserve unsubmitted ${key}`);
  }
  assert.equal(newPolicy.style.systemPrompt, test.expected, test.name);
  assert.equal(effectiveAccount(after, "beta").style.systemPrompt, test.expected, "failover member uses group snapshot");
  assert.deepEqual(after.accounts.items, before.accounts.items, "transport identities and unrelated account policies are unchanged");
  assert.deepEqual(before, original, "route cannot mutate its input config");
}

const partial = route(fixture(), { policy: { features: { vision: true }, scope: { groupIds: ["900001", "900003"] } } });
assert.equal(partial.accounts.failoverGroups[0].policy.features.vision, true);
assert.equal(partial.accounts.failoverGroups[0].policy.features.automation, false, "nested feature edit retains automation deny");
assert.equal(partial.accounts.failoverGroups[0].policy.scope.private, false, "nested scope edit retains private deny");
assertRestricted(partial);
const renameBefore = fixture();
const renamed = route(renameBefore, { name: "Renamed team" });
assert.deepEqual(renamed.accounts.failoverGroups[0].policy, renameBefore.accounts.failoverGroups[0].policy);

for (const policy of [{ protocolContainer: "forbidden" }, { qq: "92001" }, { enabled: true }, { unknown: true }, { style: { systemPrompt: 42 } }]) {
  const before = fixture();
  const original = structuredClone(before);
  assert.throws(() => route(before, { policy }), /策略字段|style/, "reject invalid policy before commit");
  assert.deepEqual(before, original);
}
const newGroup = { id: "new-team", name: "New team", memberIds: ["alpha", "beta"], policyAccountId: "alpha", policy: { promptOverride: "new group" } };
const noGroup = fixture();
noGroup.accounts.failoverGroups = [];
assert.equal(route(noGroup, newGroup, { method: "POST" }).accounts.failoverGroups[0].policy.style.systemPrompt, "new group");
assert.throws(() => route(noGroup, { ...newGroup, policy: { qq: "92001" } }, { method: "POST" }), /策略字段/);

const nameBefore = fixture();
assert.equal(effectiveAccount(nameBefore, "beta").selfName, "shared identity", "old group displayName becomes its shared selfName");
const nameAfter = route(nameBefore, { policy: { selfName: "新的共享自称" } });
for (const id of ["alpha", "beta"]) {
  assert.equal(effectiveAccount(nameAfter, id).selfName, "新的共享自称");
  assert.equal(effectiveAccount(nameAfter, id).displayName, "shared identity");
}
assertRestricted(nameAfter);
assert.deepEqual(nameAfter.accounts.items, nameBefore.accounts.items, "shared selfName edit leaves member and independent account data intact");
assert.deepEqual(nameAfter.accounts.failoverGroups[0].policy.style, nameBefore.accounts.failoverGroups[0].policy.style);
assert.equal(effectiveAccount(nameAfter, "independent").selfName, "unrelated bot");
const onlyManagementName = route(nameAfter, { policy: { displayName: "新管理组名" } });
assert.equal(effectiveAccount(onlyManagementName, "beta").selfName, "新的共享自称");
const blankGroupName = route(onlyManagementName, { policy: { selfName: "" } });
assert.equal(effectiveAccount(blankGroupName, "beta").selfName, "");
assert.equal(effectiveAccount(blankGroupName, "beta").displayName, "新管理组名");
const createdNamesGroup = route(noGroup, { ...newGroup, policy: { displayName: "管理标签", selfName: "新组自称" } }, { method: "POST" });
assert.equal(effectiveAccount(createdNamesGroup, "beta").selfName, "新组自称");
assert.equal(effectiveAccount(createdNamesGroup, "alpha").displayName, "管理标签");
const inheritedNameSource = structuredClone(noGroup);
inheritedNameSource.accounts.items[0].selfName = "来源自称";
const { policy: omittedPolicy, ...groupWithoutPolicy } = newGroup;
const inheritedNamesGroup = route(inheritedNameSource, groupWithoutPolicy, { method: "POST" });
assert.equal(effectiveAccount(inheritedNamesGroup, "beta").selfName, "来源自称", "POST without policy includes selfName in default whitelist");
for (const selfName of [null, 42, "bad\nname", "x".repeat(101)]) {
  assert.throws(() => route(nameBefore, { policy: { selfName } }), /selfName/);
}

// Mutation control: dropping previousPolicy must revive the exact P1 failure.
// This changes only the extracted code in memory, never the bridge source.
const regressed = branch.replace(/const previousPolicy = [^\n]+;/, "const previousPolicy = {};");
assert.notEqual(regressed, branch, "regression control must mutate the real merge base");
const unsafe = route(fixture(), { policy: { promptOverride: "style-only edit" } }, { code: regressed });
assert.throws(() => assertRestricted(unsafe), /style edits cannot broaden group allowlist/, "P1 assertions must detect the unsafe source-account fallback");

console.log(JSON.stringify({ ok: true, cases: cases.length, offline: true, bridgeStarted: false, liveServicesConnected: false,
  sourceWrites: false, checks: "real group route; style-only permission retention; legacy profile fallback; empty canonical style; nested edits; unknown fields; POST; regression mutation" }));
