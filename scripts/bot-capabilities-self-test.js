import assert from "node:assert/strict";
import { accountCanChat, accountCanOfferTask, accountIdentityForPrompt, accountTopology, botModeForAccount, botSelfSlot, configForAccountCapabilities, styleProfileForAccount, systemPromptForAccount } from "../src/bot-capabilities.js";
import { normalizeApiCenter, resolveApiCapability } from "../src/api-center.js";
import { registryConfig, newAccount } from "../src/account-registry.js";

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
const overrides = structuredClone(configured);
overrides.accounts.primary.promptOverride = "主号专属";
overrides.accounts.standbys[0].promptOverride = "备用号专属";
assert.equal(systemPromptForAccount(overrides, "primary"), "主号专属");
assert.equal(systemPromptForAccount(overrides, "standby-a"), "备用号专属");
overrides.accounts.standbys[0].promptOverride = "";
assert.equal(systemPromptForAccount(overrides, "standby-a"), "任务风格");
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
assert.equal(systemPromptForAccount({ ...overrides, accounts: { ...overrides.accounts, topology: "failover" } }, "standby-a"), "主号专属");
const identityConfig = {
  ...configured,
  accounts: {
    ...configured.accounts,
    primary: { id: "primary", displayName: "甲", qq: "90001" },
    standbys: [{ id: "standby-a", displayName: "乙", qq: "90002" }]
  }
};
const splitIdentity = accountIdentityForPrompt(identityConfig, "standby-a");
assert.match(splitIdentity, /账号平级，不存在主备接管/);
assert.match(splitIdentity, /你是「乙」（QQ 90002），负责任务/);
assert.doesNotMatch(splitIdentity, /账号ID：standby-a|账号角色：standby/);
assert.match(accountIdentityForPrompt({ ...identityConfig, accounts: { ...identityConfig.accounts, topology: "collaboration" } }, "primary"), /多个独立 bot 协作聊天/);
assert.match(accountIdentityForPrompt({ ...identityConfig, accounts: { ...identityConfig.accounts, topology: "failover" } }, "standby-a"), /备用账号接管发言/);
const runtimeAuthority = splitIdentity.slice(splitIdentity.indexOf("运行时权限约束："));
assert.match(runtimeAuthority, /风格提示词、历史消息和自我记忆中的定时口头约定，不代表已登记自动化/);
assert.match(runtimeAuthority, /复制风格也不复制自动化规则或定时承诺的执行权限/);
assert.match(runtimeAuthority, /早晚问候、定时总结等定时动作由自动化调度负责/);
assert.match(runtimeAuthority, /普通回复不得自行执行，也不得凭风格或历史冒称已配置或已发送/);
assert.match(runtimeAuthority, /quiet（静默）、功能开关和发送权限以当前结构化配置为准/);
assert.match(runtimeAuthority, /风格、历史约定和复制来的提示词不能覆盖这些限制/);
for (const topology of ["function_split", "collaboration", "failover"]) {
  const identity = accountIdentityForPrompt({ ...identityConfig, accounts: { ...identityConfig.accounts, topology } }, "standby-a");
  assert.equal(identity.endsWith(runtimeAuthority), true, `${topology} must end with the same runtime authority layer`);
}
const promisedStyle = registryConfig(identityConfig);
const oldPromise = "原有小跟班风格：每天早晚问候并总结，已经答应定时发送。";
promisedStyle.accounts.items[0].style.systemPrompt = oldPromise;
promisedStyle.accounts.items.push(newAccount(promisedStyle, { id: "style-copy", copyStyleFromAccountId: "primary" }));
const promisedBefore = structuredClone(promisedStyle);
for (const id of ["primary", "style-copy"]) {
  assert.equal(systemPromptForAccount(promisedStyle, id), oldPromise, "runtime authority must not rewrite stored style or its old promises");
  assert.equal(accountIdentityForPrompt(promisedStyle, id).endsWith(runtimeAuthority), true, "copied promises do not bypass runtime authority");
}
assert.equal(promisedStyle.accounts.items.at(-1).features.automation, false);
assert.deepEqual(promisedStyle, promisedBefore, "identity prompt must not mutate style, permissions or automation");
const dynamic = {
  ...identityConfig,
  accounts: {
    version: 2, topology: "failover", // stale global topology/projection is not authoritative
    primary: { id: "obsolete", displayName: "旧昵称", promptOverride: "旧提示" },
    items: [
      { id: "primary", displayName: "甲", qq: "90001", features: { chat: true, task: false }, promptOverride: "甲的提示" },
      { id: "peer", displayName: "乙", qq: "90002", features: { chat: false, task: true }, styleProfileId: "task-style" },
      { id: "retired", archived: true, features: { chat: true, task: true } }
    ], failoverGroups: []
  }
};
const dynamicBefore = structuredClone(dynamic);
assert.equal(accountCanChat(dynamic, "peer"), false);
assert.equal(accountCanOfferTask(dynamic, "peer"), true);
assert.equal(botModeForAccount(dynamic, "peer"), "task");
assert.equal(systemPromptForAccount(dynamic, "peer"), "任务风格");
assert.equal(styleProfileForAccount(dynamic, "peer").id, "task-style");
assert.match(accountIdentityForPrompt(dynamic, "peer"), /账号平级，不存在主备接管/);
assert.match(accountIdentityForPrompt(dynamic, "peer"), /你是「乙」（QQ 90002），负责任务/);
assert.doesNotMatch(accountIdentityForPrompt(dynamic, "peer"), /旧昵称|retired/);
assert.equal(accountCanChat(dynamic, "missing"), false);
assert.equal(accountCanOfferTask(dynamic, "retired"), false);
assert.equal(botModeForAccount(dynamic, "missing"), "none");
const paused = structuredClone(dynamic);
paused.accounts.items[0].enabled = false;
assert.equal(botModeForAccount(paused, "primary"), "none");
const transportOff = structuredClone(dynamic);
transportOff.accounts.items[0].protocolEnabled = false;
assert.equal(botModeForAccount(transportOff, "primary"), "none", "disabled protocol cannot participate");
assert.equal(accountCanChat(transportOff, "primary"), false);
assert.equal(accountCanOfferTask(transportOff, "primary"), false);
const self = { botSelf: { identity: ["original"] }, botSelfByAccount: { peer: { identity: ["peer"] } } };
assert.equal(botSelfSlot(self, { ...dynamic, __activeAccountId: "primary" }), self.botSelf);
assert.equal(botSelfSlot(self, { ...dynamic, __activeAccountId: "peer" }), self.botSelfByAccount.peer);
const freshId = structuredClone(dynamic);
freshId.accounts.items.unshift({ id: "new-first", displayName: "新 bot" });
assert.notEqual(botSelfSlot(self, { ...freshId, __activeAccountId: "new-first" }), self.botSelf);
const migratedCustomId = structuredClone(dynamic);
migratedCustomId.accounts.items[0].id = "original-bot-42";
migratedCustomId.accounts.legacyPrimaryId = "original-bot-42";
migratedCustomId.accounts.primary = { id: "peer" }; // stale/read projection must not select the old memory owner
migratedCustomId.accounts.items.reverse();
assert.equal(botSelfSlot(self, { ...migratedCustomId, __activeAccountId: "original-bot-42" }), self.botSelf);
assert.equal(botSelfSlot(self, { ...migratedCustomId, __activeAccountId: "peer" }), self.botSelfByAccount.peer);
assert.deepEqual(self.botSelf.identity, ["original"]);

const grouped = structuredClone(dynamic);
grouped.accounts.failoverGroups = [{ id: "team", name: "共享 bot", memberIds: ["peer", "primary"], policyAccountId: "primary",
  policy: { displayName: "共享身份", styleProfileId: "task-style", promptOverride: "共享提示", features: { chat: true, task: false } } }];
assert.equal(botModeForAccount(grouped, "peer"), "chat");
assert.equal(systemPromptForAccount(grouped, "peer"), "共享提示");
const snapshotted = registryConfig(grouped);
snapshotted.prompt.system = "新全局风格";
snapshotted.styleProfiles.profiles[1].systemPrompt = "新任务模板";
snapshotted.accounts.items[0].promptOverride = "过时字段不应覆盖快照";
assert.equal(systemPromptForAccount(snapshotted, "peer"), "共享提示");
snapshotted.accounts.failoverGroups[0].policy.style.systemPrompt = "";
assert.equal(systemPromptForAccount(snapshotted, "primary"), "");
assert.equal(configForAccountCapabilities(snapshotted, "peer").prompt.system, "");
const independentSnapshots = registryConfig(dynamic);
independentSnapshots.accounts.items.push(newAccount(independentSnapshots, { id: "blank" }));
assert.equal(systemPromptForAccount(independentSnapshots, "blank"), "");
assert.equal(configForAccountCapabilities(independentSnapshots, "blank").prompt.system, "");
independentSnapshots.prompt.system = "新全局";
independentSnapshots.styleProfiles.profiles[1].systemPrompt = "新模板";
assert.equal(systemPromptForAccount(independentSnapshots, "peer"), "任务风格");
assert.equal(systemPromptForAccount(independentSnapshots, "primary"), "甲的提示");
assert.equal(systemPromptForAccount(independentSnapshots, "missing"), "");
const projectedLegacy = configForAccountCapabilities(dynamic, "peer");
assert.equal(systemPromptForAccount(projectedLegacy, "primary"), "甲的提示");
const globalFallback = structuredClone(dynamic);
delete globalFallback.accounts.items[0].promptOverride;
assert.equal(systemPromptForAccount(configForAccountCapabilities(globalFallback, "peer"), "primary"), "原有风格", "account projection must not contaminate another unmigrated account's global fallback");
assert.match(accountIdentityForPrompt(grouped, "primary"), /「共享身份」（QQ 90001）/);
assert.match(accountIdentityForPrompt(grouped, "primary"), /备用账号接管发言/);
assert.equal(accountIdentityForPrompt(grouped, "primary").endsWith(runtimeAuthority), true, "explicit v2 failover groups also retain runtime authority");
assert.equal(botSelfSlot(self, { ...grouped, __activeAccountId: "peer" }), botSelfSlot(self, { ...grouped, __activeAccountId: "primary" }));
assert.equal(botSelfSlot(self, { ...grouped, __activeAccountId: "peer" }), self.botSelfByGroup.team);
assert.notEqual(self.botSelfByGroup.team, self.botSelf);
grouped.accounts.failoverGroups[0].id = "other-team";
assert.notEqual(botSelfSlot(self, { ...grouped, __activeAccountId: "peer" }), self.botSelfByGroup.team);
grouped.accounts.failoverGroups[0].legacySelfMemory = true;
assert.equal(botSelfSlot(self, { ...grouped, __activeAccountId: "peer" }), self.botSelf);
assert.deepEqual(self.botSelf.identity, ["original"]);
assert.deepEqual(self.botSelfByAccount.peer.identity, ["peer"]);
const mixedRegistry = structuredClone(dynamic);
mixedRegistry.accounts.items.push({ id: "team-a1" }, { id: "team-a2" }, { id: "team-b1" }, { id: "team-b2" });
mixedRegistry.accounts.failoverGroups = [
  { id: "team-a", name: "A", memberIds: ["team-a1", "team-a2"], policyAccountId: "team-a1", policy: { displayName: "Bot A" } },
  { id: "team-b", name: "B", memberIds: ["team-b1", "team-b2"], policyAccountId: "team-b1", policy: { displayName: "Bot B" } }
];
const mixedIdentity = accountIdentityForPrompt(mixedRegistry, "peer");
assert.match(mixedIdentity, /当前账号是独立 bot，不属于任何主备接管组/);
assert.match(mixedIdentity, /接管组「A」|接管组「B」/);
assert.doesNotMatch(mixedIdentity, /不存在主备接管/);
assert.doesNotMatch(accountIdentityForPrompt(mixedRegistry, "team-a1"), /组外账号仍是独立 bot/);
assert.notEqual(botSelfSlot(self, { ...mixedRegistry, __activeAccountId: "team-a1" }), botSelfSlot(self, { ...mixedRegistry, __activeAccountId: "team-b1" }));

const runtime = structuredClone(dynamic);
runtime.ai = { provider: "deepseek", model: "global-chat", apiKeyEnv: "GLOBAL_KEY" };
runtime.aiProfiles = { activeId: "chat-global", profiles: [{ id: "chat-global", name: "Global" },
  { id: "chat-peer", name: "Peer", provider: "custom", model: "peer-chat", apiKeyEnv: "PEER_KEY" }] };
runtime.proactive = { enabled: true, probability: 0.2 };
runtime.vision = { enabled: true, prompt: "preserve vision prompt" };
runtime.webSearch = { enabled: true };
runtime.automation = { enabled: true, rules: [{ id: "keep" }] };
runtime.learningMode = { enabled: false, maxQuestions: 2 };
runtime.voice = { enabled: false, asr: { enabled: false, autoTranscribe: true }, tts: { enabled: true, voice: "mimo_default" } };
runtime.behaviorModes = { default: "normal", presets: { lively: { trigger: { activeProbability: 0.4 }, proactive: { probability: 0.7 } } } };
runtime.apiCenter = normalizeApiCenter(runtime);
runtime.accounts.items[1] = { ...runtime.accounts.items[1], behaviorMode: "lively",
  features: { chat: true, task: true, proactive: false, automation: false, learning: true, vision: false, webSearch: false, asr: true },
  voice: { mode: "force", preset: "Mia" }, modelBindings: { chat: "chat-peer", task: "inherit-chat" } };
const runtimeBefore = structuredClone(runtime);
const local = configForAccountCapabilities(runtime, "peer");
assert.equal(local.__activeAccountId, "peer");
assert.equal(local.ai.model, "peer-chat");
assert.equal(local.ai.apiKeyEnv, "PEER_KEY");
assert.equal(local.aiProfiles.activeId, "chat-peer");
assert.equal(resolveApiCapability(local, "task").profile.model, "peer-chat");
assert.deepEqual(local.apiCenter, runtime.apiCenter, "global bindings remain global on the clone");
assert.equal(local.botFeatures.defaultMode, "all");
assert.equal(local.proactive.enabled, false);
assert.equal(local.proactive.probability, 0.7);
assert.equal(local.trigger.activeProbability, 0.4);
assert.equal(local.__behaviorMode, "lively");
assert.equal(local.behaviorModes.default, "lively");
assert.equal(local.learningMode.enabled, true);
assert.equal(local.learningMode.maxQuestions, 2);
assert.equal(local.automation.enabled, false);
assert.deepEqual(local.automation.rules, [{ id: "keep" }]);
assert.equal(local.vision.enabled, false);
assert.equal(local.vision.prompt, "preserve vision prompt");
assert.equal(local.webSearch.enabled, false);
assert.equal(local.voice.enabled, true);
assert.equal(local.voice.replyMode, "force");
assert.equal(local.voice.asr.enabled, true);
assert.equal(local.voice.asr.autoTranscribe, true);
assert.equal(local.voice.tts.voice, "Mia");
assert.equal(local.persona.displayName, "乙");
assert.equal(local.__activeAccountDisplayName, "乙");
assert.equal(local.styleProfiles.activeId, "task-style");
assert.equal(local.prompt.system, "任务风格");
assert.deepEqual(configForAccountCapabilities(local, "peer"), local, "same-account projection is idempotent");
assert.deepEqual(runtime, runtimeBefore);
assert.deepEqual(dynamic, dynamicBefore);
const groupRuntime = structuredClone(runtime);
groupRuntime.accounts.failoverGroups = [{ id: "runtime-team", name: "Team", memberIds: ["primary", "peer"], policyAccountId: "peer",
  policy: { displayName: "共享 bot", styleProfileId: "task-style", promptOverride: "共享系统提示", behaviorMode: "lively",
    features: { chat: false, task: true, proactive: true, automation: true, learning: false, vision: true, webSearch: true, asr: false },
    voice: { mode: "mixed", preset: "Chloe" }, modelBindings: { chat: "chat-peer", task: "inherit-chat" } } }];
const groupRuntimeBefore = structuredClone(groupRuntime);
const groupedLocal = configForAccountCapabilities(groupRuntime, "primary");
assert.equal(groupedLocal.__activeAccountId, "primary");
assert.equal(groupedLocal.__activeAccountDisplayName, "共享 bot");
assert.equal(groupedLocal.ai.model, "peer-chat");
assert.equal(groupedLocal.prompt.system, "共享系统提示");
assert.equal(groupedLocal.botFeatures.defaultMode, "task");
assert.equal(groupedLocal.proactive.enabled, true);
assert.equal(groupedLocal.learningMode.enabled, false);
assert.equal(groupedLocal.voice.tts.voice, "Chloe");
assert.equal(groupedLocal.voice.asr.enabled, false);
assert.deepEqual(groupRuntime, groupRuntimeBefore);
groupRuntime.accounts.items[0].protocolEnabled = false;
assert.equal(accountCanOfferTask(groupRuntime, "primary"), false, "shared bot policy cannot re-enable a stopped transport");
assert.equal(accountCanOfferTask(groupRuntime, "peer"), true);
assert.equal(configForAccountCapabilities(groupRuntime, "primary").voice.enabled, false);
assert.throws(() => configForAccountCapabilities(runtime, "missing"), /account/);
runtime.accounts.items[1].voice.mode = "off";
assert.equal(configForAccountCapabilities(runtime, "peer").voice.asr.enabled, false);
assert.equal(configForAccountCapabilities(runtime, "peer").voice.enabled, false);
runtime.accounts.items[1].voice.mode = "inherit";
assert.equal(configForAccountCapabilities(runtime, "peer").voice.enabled, false);
runtime.voice.enabled = true;
runtime.voice.replyMode = "mixed";
assert.equal(configForAccountCapabilities(runtime, "peer").voice.replyMode, "mixed");
runtime.accounts.items[1].voice.mode = "mixed";
assert.equal(configForAccountCapabilities(runtime, "peer").voice.enabled, true);
runtime.accounts.items[1].enabled = false;
const pausedLocal = configForAccountCapabilities(runtime, "peer");
for (const section of ["proactive", "automation", "learningMode", "vision", "webSearch", "voice"]) assert.equal(pausedLocal[section].enabled, false);
runtime.accounts.items[1].enabled = true;
runtime.accounts.items[1].protocolEnabled = false;
const stoppedLocal = configForAccountCapabilities(runtime, "peer");
assert.equal(stoppedLocal.botFeatures.defaultMode, "none");
for (const section of ["proactive", "automation", "learningMode", "vision", "webSearch", "voice"]) assert.equal(stoppedLocal[section].enabled, false);
assert.equal(stoppedLocal.voice.asr.enabled, false);
runtime.accounts.items[1].protocolEnabled = true;
runtime.accounts.items[1].modelBindings.vision = "missing";
assert.throws(() => configForAccountCapabilities(runtime, "peer"), /modelBindings.vision/);

const selfNames = registryConfig(identityConfig);
selfNames.botNames = ["固定触发昵称"];
selfNames.accounts.items[0].selfName = "小墨";
selfNames.accounts.items[1].selfName = "我";
const selfNamesBefore = structuredClone(selfNames);
const namedIdentity = accountIdentityForPrompt(selfNames, "primary");
assert.match(namedIdentity, /你是「小墨」（QQ 90001）/);
assert.match(namedIdentity, /自称约束：自称使用"小墨"/);
assert.match(namedIdentity, /管理名称"甲"仅用于管理、账号标识和 QQ 引用，不强制用作自称/);
assert.match(namedIdentity, /账号 1「甲」/, "account catalog retains management names");
assert.doesNotMatch(namedIdentity, /你是「甲」/);
assert.match(namedIdentity, /旧风格提示词、历史消息和自我记忆中的旧称呼与此冲突时，以本段自称为准/);
assert.equal(systemPromptForAccount(selfNames, "primary"), systemPromptForAccount(identityConfig, "primary"), "stored style stays byte-for-byte intact");
const pronounIdentity = accountIdentityForPrompt(selfNames, "standby-a");
assert.match(pronounIdentity, /自然使用第一人称“我”/);
assert.doesNotMatch(pronounIdentity, /你是「我」|自称使用"小墨"/);
const pronounProjection = configForAccountCapabilities(selfNames, "standby-a");
assert.equal(pronounProjection.persona.displayName, "乙");
assert.equal(pronounProjection.persona.selfName, "我");
assert.equal(pronounProjection.__activeAccountDisplayName, "乙");
assert.equal(pronounProjection.__activeAccountSelfName, "我");
assert.deepEqual(pronounProjection.botNames, ["固定触发昵称"], "selfName never registers a trigger nickname, especially 我");
assert.deepEqual(configForAccountCapabilities(selfNames, "primary").botNames, selfNames.botNames);
assert.deepEqual(selfNames, selfNamesBefore, "selfName prompts and projections leave the source config untouched");
selfNames.accounts.items[1].selfName = "";
selfNames.accounts.items[1].displayName = "乙新管理名";
assert.match(accountIdentityForPrompt(selfNames, "standby-a"), /你是「乙新管理名」/, "blank selfName follows own current displayName");
assert.equal(configForAccountCapabilities(selfNames, "standby-a").persona.selfName, "乙新管理名");
selfNames.accounts.failoverGroups = [{ id: "self-team", name: "管理组", memberIds: ["primary", "standby-a"], policyAccountId: "primary",
  policy: { displayName: "共享管理名", selfName: "共享自称" } }];
for (const id of ["primary", "standby-a"]) {
  assert.match(accountIdentityForPrompt(selfNames, id), /自称约束：自称使用"共享自称"/);
  assert.match(accountIdentityForPrompt(selfNames, id), /管理名称"共享管理名"/);
  assert.equal(configForAccountCapabilities(selfNames, id).persona.selfName, "共享自称");
}
selfNames.accounts.failoverGroups[0].policy.selfName = "";
assert.equal(configForAccountCapabilities(selfNames, "standby-a").persona.selfName, "共享管理名", "blank shared selfName uses group displayName, never transport's name");
selfNames.accounts.failoverGroups[0].policy.selfName = "共享自称";
const nameMemory = { botSelf: { identity: ["原有身份"] }, botSelfByGroup: { "self-team": { identity: ["旧共享身份"] } } };
const nameMemoryBefore = structuredClone(nameMemory);
const oldSelfSlot = botSelfSlot(nameMemory, { ...selfNames, __activeAccountId: "primary" });
selfNames.accounts.failoverGroups[0].policy.selfName = "新共享自称";
assert.equal(botSelfSlot(nameMemory, { ...selfNames, __activeAccountId: "standby-a" }), oldSelfSlot, "selfName edits do not re-key self memory");
assert.deepEqual(nameMemory, nameMemoryBefore);
assert.equal(selfNamesBefore.accounts.items[0].displayName, "甲");
const untouchedNames = structuredClone(selfNames);
accountIdentityForPrompt(selfNames, "standby-a");
configForAccountCapabilities(selfNames, "standby-a");
assert.deepEqual(selfNames, untouchedNames, "prompt and runtime projections never mutate names, styles or memory");
console.log("bot-capabilities self-test: PASS (legacy identity + dynamic account projections)");
