import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AccountRuntime, logicalBotId, botConversationKey, botControlRevision } from "../src/account-runtime.js";
import { registryConfig, accountPolicy } from "../src/account-registry.js";
import { normalizeApiCenter } from "../src/api-center.js";

const config = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../config.example.json"), "utf8"));
config.accounts = { version: 2, topology: "function_split", failoverGroups: [],
  items: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((id, index) => ({
    id, qq: String(91001 + index), displayName: `fixture ${id}`, protocol: "napcat", enabled: true, protocolEnabled: true,
    onebotPath: "/fixture", protocolContainer: `fixture-${id}`, style: { systemPrompt: `fixture style ${id}` }
  })) };
let current = registryConfig(config, { strict: true });
const before = JSON.stringify(current);
const runtime = new AccountRuntime(current);
assert.equal(JSON.stringify(current), before, "building the kernel never mutates config or copies styles");
for (const id of ["alpha", "beta"]) {
  assert.equal(runtime.ownerForAccount(id), `account:${id}`);
  assert(runtime.selectedForAccount(id));
}
const alpha = runtime.capture("alpha", { sessionId: "s1" });
const beta = runtime.capture("beta", { sessionId: "s2" });
assert(runtime.isCurrent(alpha, { sessionId: "s1" }));
assert(!runtime.isCurrent(alpha, { sessionId: "changed" }));
assert(!runtime.isCurrent({ ...alpha, accountId: "beta" }));
assert.equal(runtime.capture("missing"), null);
assert.equal(logicalBotId(current, "missing"), "");
assert.notEqual(botConversationKey("account:a:b", "c"), botConversationKey("account:a", "b:c"));
assert(Object.isFrozen(alpha));

current.accounts.items[1].style.systemPrompt = "only beta changed";
let changes = runtime.updateConfig(current);
assert.deepEqual(changes.changedOwners, ["account:beta"]);
assert(runtime.isCurrent(alpha)); assert(!runtime.isCurrent(beta));
const betaUpdated = runtime.capture("beta");
current.control.port = 6290;
changes = runtime.updateConfig(current);
assert.deepEqual(changes.changedOwners, [], "UI/management-only settings are not reply policy changes");
assert(runtime.isCurrent(betaUpdated));

const center = normalizeApiCenter(current);
const original = center.profiles.find((item) => item.id === center.bindings.chat);
center.profiles.push({ ...original, id: "alpha-chat", name: "Alpha model" }, { ...original, id: "beta-chat", name: "Beta model" });
current.apiCenter = center;
current.accounts.items[0].modelBindings.chat = "alpha-chat";
current.accounts.items[1].modelBindings.chat = "beta-chat";
runtime.updateConfig(current);
const alphaModel = runtime.capture("alpha"), betaModel = runtime.capture("beta");
center.profiles.find((item) => item.id === "beta-chat").model = "fixture-only-beta-model";
changes = runtime.updateConfig(current);
assert(!changes.changedOwners.includes("account:alpha"));
assert(changes.changedOwners.includes("account:beta"));
assert(runtime.isCurrent(alphaModel)); assert(!runtime.isCurrent(betaModel));

const member = (id) => current.accounts.items.find((item) => item.id === id);
current.accounts.failoverGroups = [
  { id: "first", name: "First bot", memberIds: ["delta", "gamma"], policyAccountId: "delta", policy: accountPolicy(member("delta")), settings: {} },
  { id: "second", name: "Second bot", memberIds: ["epsilon", "zeta"], policyAccountId: "epsilon", policy: accountPolicy(member("epsilon")), settings: {} }
];
current = registryConfig(current, { strict: true });
changes = runtime.updateConfig(current);
assert(changes.routeChangedOwners.includes("account:gamma"));
assert.equal(runtime.ownerForAccount("gamma"), "group:first");
assert.equal(runtime.route("group:first").id, "");
assert(!runtime.select("group:first", "beta"), "a peer's connection cannot carry this identity");
assert(runtime.select("group:first", "delta", { now: 100, reasonCode: "health-test" }));
assert(runtime.select("group:second", "epsilon", { now: 100 }));
const first = runtime.capture("delta", { sessionId: "first" });
const second = runtime.capture("epsilon", { sessionId: "second" });
assert(runtime.isCurrent(first)); assert(runtime.isCurrent(second));
assert(!runtime.selectedForAccount("gamma"));
runtime.noteHealth("group:first", true, 150);
assert.equal(runtime.route("group:first").unhealthySince, 150);
runtime.noteHealth("group:first", true, 170);
assert.equal(runtime.route("group:first").unhealthySince, 150);
runtime.noteHealth("group:first", false);
assert.equal(runtime.route("group:first").unhealthySince, 0);
runtime.select("group:first", "gamma", { now: 200 });
runtime.select("group:first", "delta", { now: 300 });
assert(!runtime.isCurrent(first), "A→B→A route changes cannot revive an old draft");
assert(runtime.isCurrent(second), "another logical bot is unaffected by the switch");

const memory = { groups: { g: { settings: { botSettings: { "account:alpha": { voiceReplyMode: "mixed" }, "account:beta": { quietUntil: 123 } } } } } };
const controls = botControlRevision(memory, "g", current, "alpha");
const scoped = runtime.capture("alpha", { conversationId: "g", controlRevision: controls });
memory.groups.g.settings.botSettings["account:beta"].quietUntil = 456;
assert.equal(botControlRevision(memory, "g", current, "alpha"), controls);
memory.groups.g.settings.botSettings["account:alpha"].voiceReplyMode = "force";
assert.notEqual(botControlRevision(memory, "g", current, "alpha"), controls);
assert(!runtime.isCurrent(scoped, { controlRevision: botControlRevision(memory, "g", current, "alpha") }));

const oldAlpha = runtime.capture("alpha");
const oldPrivate = runtime.capture("alpha");
current.privateChats.enabled = false;
runtime.updateConfig(current);
assert(!runtime.isCurrent(oldPrivate), "private-chat policy changes invalidate old replies");
assert(runtime.isIdentityCurrent(oldPrivate), "the input identity remains valid while policy changes");
current.privateChats.enabled = true;
runtime.updateConfig(current);
assert(!runtime.isCurrent(oldPrivate), "restoring settings cannot revive an old execution policy");
memory.groups.g.settings.botSettings["account:alpha"].behaviorMode = "lively";
const lively = runtime.controlRevision(memory, "g", "alpha");
memory.groups.g.settings.botSettings["account:alpha"].behaviorMode = "活跃";
const legacyAlias = runtime.controlRevision(memory, "g", "alpha");
memory.groups.g.settings.botSettings["account:alpha"].behaviorMode = "lively";
assert.equal(legacyAlias, runtime.controlRevision(memory, "g", "alpha"), "legacy aliases use the same actual behavior projection");
const normal = runtime.controlRevision(memory, "g", "beta");
current.behaviorModes.presets.lively.reply.maxLength = 20;
runtime.updateConfig(current);
assert.notEqual(runtime.controlRevision(memory, "g", "alpha"), lively, "the actual non-default group preset is versioned");
assert.equal(runtime.controlRevision(memory, "g", "beta"), normal, "an unused preset does not invalidate a normal peer");
current.accounts.items.find((item) => item.id === "alpha").archived = true;
runtime.updateConfig(current);
assert(!runtime.isCurrent(oldAlpha));
current.accounts.items.find((item) => item.id === "alpha").archived = false;
runtime.updateConfig(current);
assert(!runtime.isCurrent(oldAlpha), "removal and re-addition must not reuse versions");
assert(!JSON.stringify(runtime.snapshot()).includes("fixture style"), "status exposes identity/version metadata, not prompts or credentials");
console.log("account runtime: independent policy/model changes, mixed groups, route ABA, controls and immutable contexts passed");
