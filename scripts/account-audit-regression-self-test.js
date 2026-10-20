import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { accountKeywordMatches, botSelfSlot, configForAccountCapabilities } from "../src/bot-capabilities.js";
import { newAccount, registryConfig } from "../src/account-registry.js";
import { dailyScheduleLedgerKey, normalizeAutomationRoutines, patchAutomationRoutines } from "../src/legacy-automation.js";

// Synthetic objects and source extraction only. Never import bridge/main(),
// start services, read live config/memory, connect providers or write files.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const start = source.indexOf("function hasKeyword(");
const end = source.indexOf("\n}\n", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ accountKeywordMatches });
vm.runInContext(source.slice(start, end + 2), context);
const hasKeyword = context.hasKeyword;
const cases = [];
const test = (name, run) => { run(); cases.push(name); };
const config = registryConfig({
  botNames: ["旧称", "Old Alias"], prompt: { system: "保留原有风格\n不改写历史承诺。" },
  trigger: { activeProbability: 0.81, customRoot: true },
  behaviorModes: { default: "lively", presets: {
    lively: { trigger: { activeProbability: 0.9 } },
    normal: { trigger: { activeProbability: 0.15 } }
  } },
  accounts: { topology: "collaboration", primary: { id: "original", displayName: "Alpha", selfName: "我" },
    standbys: [{ id: "peer", displayName: "Beta", selfName: "小乙", behaviorMode: "normal" }] }
});
const before = structuredClone(config);

test("independent names and legacy aliases", () => {
  const alpha = configForAccountCapabilities(config, "original");
  const beta = configForAccountCapabilities(config, "peer");
  assert.deepEqual(alpha.botNames, ["Alpha", "旧称", "Old Alias"]);
  assert.deepEqual(beta.botNames, ["Beta"]);
  for (const text of ["Alpha 在吗", "旧称 在吗", "old ALIAS 在吗"]) {
    assert.equal(hasKeyword(text, alpha), true);
    assert.equal(hasKeyword(text, beta), false);
  }
  assert.equal(hasKeyword("Beta 在吗", beta), true);
  assert.equal(hasKeyword("Beta 在吗", alpha), false);
  assert.equal(hasKeyword("我感觉这个东西有问题", alpha), false);
  assert.equal(hasKeyword("小乙在吗", beta), false, "selfName is not a wake word");
  assert.equal(beta.prompt.system, config.prompt.system, "projection preserves the exact stored style");
  assert.deepEqual(configForAccountCapabilities(beta, "original").botNames, alpha.botNames);
  assert.deepEqual(configForAccountCapabilities(alpha, "peer").botNames, beta.botNames);
  assert.deepEqual(configForAccountCapabilities(beta, "peer"), beta, "projection is idempotent");
});

test("displayName works without any global aliases", () => {
  const withoutAliases = structuredClone(config);
  delete withoutAliases.botNames;
  assert.deepEqual(configForAccountCapabilities(withoutAliases, "peer").botNames, ["Beta"]);
  assert.equal(hasKeyword("Beta", configForAccountCapabilities(withoutAliases, "peer")), true);
});

test("real keyword path disambiguates prefixes but keeps separate mentions", () => {
  for (const [short, long] of [["Alpha", "Alpha2"], ["小跟班", "小跟班2"]]) {
    const fixture = structuredClone(config);
    fixture.accounts.items[0].displayName = short;
    fixture.accounts.items[1].displayName = long;
    const alpha = configForAccountCapabilities(fixture, "original");
    const beta = configForAccountCapabilities(fixture, "peer");
    assert.equal(alpha.__peerBotNames.includes(long), true);
    assert.equal(beta.__peerBotNames.includes(short), true);
    assert.equal(hasKeyword(`${long} 你在吗`, alpha), false, "short name inside a longer independent name is not addressing the short-name bot");
    assert.equal(hasKeyword(`${long} 你在吗`, beta), true);
    assert.equal(hasKeyword(`${short} 你在吗`, alpha), true);
    assert.equal(hasKeyword(`${short} 你在吗`, beta), false);
    for (const text of [`${short} 和 ${long} 都来看看`, `${long} 先说，${short} 接着说`]) {
      assert.equal(hasKeyword(text, alpha), true);
      assert.equal(hasKeyword(text, beta), true);
    }
    assert.equal(hasKeyword(`${long} ${long}`, alpha), false, "multiple covered occurrences still do not count");
    assert.equal(hasKeyword(long.toUpperCase(), alpha), false);
    assert.equal(hasKeyword(long.toUpperCase(), beta), true);
    assert.deepEqual(configForAccountCapabilities(beta, "original").__peerBotNames, alpha.__peerBotNames);
  }
});

test("shared failover prefix names are one identity, equal independent names remain ambiguous", () => {
  const grouped = structuredClone(config);
  grouped.accounts.items[0].displayName = "Alpha";
  grouped.accounts.items[1].displayName = "Alpha2";
  grouped.accounts.items.push(newAccount(config, { id: "outside", displayName: "Alpha3" }));
  grouped.accounts.failoverGroups = [{ id: "prefix-team", name: "shared", memberIds: ["original", "peer"],
    policyAccountId: "original", policy: { displayName: "Shared" } }];
  for (const id of ["original", "peer"]) {
    const projection = configForAccountCapabilities(grouped, id);
    assert.equal(projection.__peerBotNames.includes("Alpha2"), false, "same-group members cannot suppress shared names");
    assert.equal(hasKeyword("Alpha2", projection), true);
    assert.equal(hasKeyword("Alpha3", projection), false, "outside independent bot's longer name is still exclusive");
    assert.equal(hasKeyword("Alpha3 和 Alpha", projection), true);
  }
  const equalNames = structuredClone(config);
  equalNames.accounts.items[0].displayName = "Same Name";
  equalNames.accounts.items[1].displayName = "Same Name";
  assert.equal(hasKeyword("Same Name", configForAccountCapabilities(equalNames, "original")), true);
  assert.equal(hasKeyword("Same Name", configForAccountCapabilities(equalNames, "peer")), true,
    "plain-text equal names cannot disambiguate; use @ for a single account");
});

test("new index-zero account cannot borrow original aliases", () => {
  const reordered = structuredClone(config);
  reordered.accounts.items.unshift(newAccount(config, { id: "fresh", displayName: "Gamma" }));
  assert.deepEqual(configForAccountCapabilities(reordered, "fresh").botNames, ["Gamma"]);
  assert.deepEqual(configForAccountCapabilities(reordered, "original").botNames, ["Alpha", "旧称", "Old Alias"]);
});

test("explicit groups share only their own member names", () => {
  const grouped = structuredClone(config);
  grouped.accounts.items.push(newAccount(config, { id: "second-a", displayName: "Delta" }),
    newAccount(config, { id: "second-b", displayName: "Epsilon" }),
    newAccount(config, { id: "outside", displayName: "Outside" }));
  grouped.accounts.failoverGroups = [
    { id: "team-a", name: "A", memberIds: ["original", "peer"], policyAccountId: "original",
      policy: { displayName: "Shared A", selfName: "共享自称" } },
    { id: "team-b", name: "B", memberIds: ["second-a", "second-b"], policyAccountId: "second-a",
      policy: { displayName: "Shared B" } }
  ];
  const teamA = configForAccountCapabilities(grouped, "peer");
  assert.deepEqual(teamA.botNames, ["Shared A", "Alpha", "Beta", "旧称", "Old Alias"]);
  assert.deepEqual(configForAccountCapabilities(grouped, "original").botNames, teamA.botNames);
  assert.equal(hasKeyword("共享自称", teamA), false);
  const teamB = configForAccountCapabilities(grouped, "second-b");
  assert.deepEqual(teamB.botNames, ["Shared B", "Delta", "Epsilon"]);
  assert.equal(hasKeyword("Alpha", teamB), false);
  assert.equal(hasKeyword("旧称", teamB), false);
  assert.deepEqual(configForAccountCapabilities(grouped, "outside").botNames, ["Outside"]);
});

test("behavior projection runs before changing account default", () => {
  const beta = configForAccountCapabilities(config, "peer");
  assert.equal(beta.__behaviorMode, "normal");
  assert.equal(beta.behaviorModes.default, "normal");
  assert.equal(beta.trigger.activeProbability, 0.15, "normal preset must override global lively root");
  assert.equal(beta.trigger.customRoot, true);
  const rootOwner = structuredClone(config);
  rootOwner.accounts.items[0].behaviorMode = "lively";
  assert.equal(configForAccountCapabilities(rootOwner, "original").trigger.activeProbability, 0.81,
    "selected default retains saved root customization instead of preset defaults");
});

const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
const constructorBefore = Object.getOwnPropertyDescriptors(Object);

test("inherited memory slots cannot masquerade as account state", () => {
  const inherited = { identity: ["must stay untouched"] };
  const gm = { botSelf: { identity: ["original"] }, botSelfByAccount: Object.create({ peer: inherited }) };
  const slot = botSelfSlot(gm, { ...config, __activeAccountId: "peer" });
  assert.notEqual(slot, inherited);
  assert.equal(Object.hasOwn(gm.botSelfByAccount, "peer"), true);
  slot.identity = ["peer-only"];
  assert.deepEqual(inherited.identity, ["must stay untouched"]);
  assert.deepEqual(gm.botSelf.identity, ["original"]);
  assert.equal(botSelfSlot(gm, { ...config, __activeAccountId: "peer" }), slot);
  const inheritedMap = Object.create({ botSelfByAccount: { peer: inherited } });
  assert.notEqual(botSelfSlot(inheritedMap, { ...config, __activeAccountId: "peer" }), inherited);
  assert.equal(Object.hasOwn(inheritedMap, "botSelfByAccount"), true);
});

test("own-key slot fallback is safe even for forged reserved active IDs", () => {
  const gm = { botSelfByAccount: {} };
  for (const id of ["constructor", "toString", "__proto__"]) {
    const slot = botSelfSlot(gm, { ...config, __activeAccountId: id });
    assert.equal(typeof slot, "object");
    assert.notEqual(slot, Object);
    assert.notEqual(slot, Object.prototype);
    assert.equal(Object.hasOwn(gm.botSelfByAccount, id), true);
    slot.identity = [id];
  }
  assert.equal(Object.getPrototypeOf(gm.botSelfByAccount), Object.prototype);
  const persisted = JSON.parse('{"botSelfByAccount":{"constructor":{"identity":["historical own slot"]}}}');
  assert.equal(botSelfSlot(persisted, { ...config, __activeAccountId: "constructor" }), persisted.botSelfByAccount.constructor);
});

test("reserved account and group IDs fail closed before dictionary use", () => {
  for (const id of ["constructor", "prototype", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => newAccount(config, { id }), /原型保留名称/);
    const unsafe = structuredClone(config);
    unsafe.accounts.items[1].id = id;
    assert.throws(() => registryConfig(unsafe), /原型保留名称/);
    unsafe.accounts.items[1].id = "peer";
    unsafe.accounts.failoverGroups = [{ id, name: "unsafe", memberIds: ["original", "peer"], policyAccountId: "original", policy: {} }];
    assert.throws(() => registryConfig(unsafe), /原型保留名称/);
  }
  assert.equal(newAccount(config, { id: "constructor-bot" }).id, "constructor-bot");
});

test("valid existing self memory is retained", () => {
  const gm = { botSelf: { identity: ["old original"], speechStyle: ["old style"] },
    botSelfByAccount: { peer: { identity: ["old peer"], style: ["old peer style"] } } };
  const snapshot = structuredClone(gm);
  assert.equal(botSelfSlot(gm, { ...config, __activeAccountId: "original" }), gm.botSelf);
  assert.equal(botSelfSlot(gm, { ...config, __activeAccountId: "peer" }), gm.botSelfByAccount.peer);
  const grouped = structuredClone(config);
  grouped.accounts.failoverGroups = [{ id: "team", name: "shared", memberIds: ["original", "peer"], policyAccountId: "original", policy: {} }];
  gm.botSelfByGroup = Object.create({ team: { identity: ["inherited group"] } });
  const shared = botSelfSlot(gm, { ...grouped, __activeAccountId: "original" });
  assert.equal(Object.hasOwn(gm.botSelfByGroup, "team"), true);
  assert.equal(botSelfSlot(gm, { ...grouped, __activeAccountId: "peer" }), shared);
  assert.deepEqual(gm.botSelf, snapshot.botSelf);
  assert.deepEqual(gm.botSelfByAccount, snapshot.botSelfByAccount);
});

test("no-ID same-name/mode schedules have distinct stable keys", () => {
  const schedules = [
    { name: "summary", mode: "summary", time: "12:00" },
    { name: "summary", mode: "summary", time: "18:00" },
    { mode: "summary", time: "21:00" },
    { mode: "summary", time: "21:00" }
  ];
  const keys = schedules.map((schedule) => dailyScheduleLedgerKey(schedule, schedules));
  assert.equal(new Set(keys).size, schedules.length);
  const reversed = [...schedules].reverse();
  for (const schedule of schedules.slice(0, 2)) {
    assert.equal(dailyScheduleLedgerKey(schedule, reversed), dailyScheduleLedgerKey(schedule, schedules));
  }
  const normalized = normalizeAutomationRoutines({ dailyMessages: { schedules } });
  const edited = patchAutomationRoutines(normalized, { daily: { schedules: [{ id: "daily-2", time: "22:00" }] } });
  const updated = edited.dailyMessages.schedules;
  assert.deepEqual(updated.map((schedule) => dailyScheduleLedgerKey(schedule, updated)), keys,
    "editing one duplicate must not reset itself or renumber the next identical sibling into its key");
  const editedTwice = patchAutomationRoutines(edited, { daily: { schedules: [{ id: "daily-3", time: "23:00" }] } });
  assert.deepEqual(editedTwice.dailyMessages.schedules.map((schedule) => dailyScheduleLedgerKey(schedule, editedTwice.dailyMessages.schedules)), keys);
});

test("explicit ledger and schedule IDs retain their identities", () => {
  const explicit = { legacyLedgerKey: "summary", id: "new-id", name: "new-name", mode: "summary", time: "17:00" };
  assert.equal(dailyScheduleLedgerKey(explicit), "summary", "explicit legacy identity outranks a new ID");
  assert.equal(dailyScheduleLedgerKey({ name: "morning", time: "08:30" }), "morning", "unambiguous old ledger stays readable");
  assert.equal(dailyScheduleLedgerKey({ time: "08:30" }), "08:30");
  assert.equal(dailyScheduleLedgerKey({ id: "s1", name: "morning", time: "08:30" }), "morning",
    "a pre-existing raw ID was never the old executor's ledger identity");
  assert.equal(dailyScheduleLedgerKey({ id: "s2", mode: "evening", time: "23:00" }), "evening");
  assert.equal(dailyScheduleLedgerKey({ id: "s3", time: "08:30" }), "08:30");
  const rawMorning = { id: "s1", name: "morning", time: "08:30" };
  assert.equal(dailyScheduleLedgerKey(rawMorning, [rawMorning, { name: "morning", legacyLedgerKey: "other", time: "08:30" }]), "morning",
    "collision detection follows actual old ledger keys, including explicitly distinct sibling keys");
  assert.notEqual(dailyScheduleLedgerKey(rawMorning, [rawMorning, { legacyLedgerKey: "morning", time: "08:30" }]), "morning",
    "a sibling explicitly claiming the same key still requires disambiguation");
  const identified = { id: "stable", name: "summary", time: "09:00" };
  const sibling = { ...identified, id: "other", time: "11:00" };
  const schedules = [identified, sibling];
  assert.notEqual(dailyScheduleLedgerKey(identified, schedules), dailyScheduleLedgerKey(sibling, schedules));
  const reordered = [sibling, identified];
  assert.equal(dailyScheduleLedgerKey(identified, schedules), dailyScheduleLedgerKey(identified, reordered));
  const edited = patchAutomationRoutines({ dailyMessages: { schedules } }, { daily: { schedules: [{ id: "daily-0", time: "12:00" }] } });
  assert.equal(dailyScheduleLedgerKey(edited.dailyMessages.schedules[0], edited.dailyMessages.schedules), dailyScheduleLedgerKey(identified, schedules));
  assert.notEqual(dailyScheduleLedgerKey({ name: "constructor" }), "constructor", "new implicit keys cannot hit inherited ledger properties");
});

assert.deepEqual(config, before, "all projections and tests leave source config/style untouched");
assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
assert.deepEqual(Object.getOwnPropertyDescriptors(Object), constructorBefore, "constructor cannot become a self-memory object");
console.log(JSON.stringify({ ok: true, cases: cases.length, fixtureOnly: true, sourceReadOnly: true, writes: false,
  checks: "account wake words; prefix/multiple mentions; shared group names; behavior ordering; own-key memory; reserved IDs; daily key collisions and compatibility" }));
