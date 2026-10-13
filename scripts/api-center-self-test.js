import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyApiCenterBindings, normalizeApiCenter, resolveApiCapability, syncLegacyApiPatch, validateApiCenter } from "../src/api-center.js";

const fixture = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const center = normalizeApiCenter(fixture);
assert.deepEqual(validateApiCenter(center, fixture), center);
assert.equal(center.bindings.task, "inherit-chat");
assert.equal(resolveApiCapability(fixture, "task").profile.id, center.bindings.chat);
assert.equal(resolveApiCapability(fixture, "unknown"), null);
assert.equal(resolveApiCapability({ ...fixture, apiCenter: center }, "asr").profile.model, "mimo-v2.5-asr");

const original = structuredClone(fixture);
const projected = applyApiCenterBindings(structuredClone(fixture), center);
assert.equal(projected.ai.model, fixture.ai.model);
assert.deepEqual(projected.ai.args, fixture.ai.args);
assert.equal(projected.aiProfiles.activeId, fixture.aiProfiles.activeId);
assert.equal(projected.vision.enabled, fixture.vision.enabled);
assert.equal(projected.vision.prompt, fixture.vision.prompt);
assert.equal(projected.voice.enabled, fixture.voice.enabled);
assert.deepEqual(projected.voice.asr, fixture.voice.asr);
assert.equal(projected.voice.tts.voice, fixture.voice.tts.voice);
assert.equal(projected.voice.tts.model, fixture.voice.tts.model);
assert.deepEqual(projected.webSearch.aiJudge, fixture.webSearch.aiJudge);
assert.deepEqual(projected.webSearch.google, fixture.webSearch.google);
assert.deepEqual(fixture, original);
assert.deepEqual(normalizeApiCenter(projected), center);
const once = structuredClone(projected);
assert.deepEqual(applyApiCenterBindings(projected, center), once);
const stalePreset = structuredClone(fixture);
stalePreset.ai.model = "runtime-only-model";
assert.equal(resolveApiCapability(stalePreset, "chat").profile.model, "runtime-only-model");

const partial = normalizeApiCenter({ ...fixture, apiCenter: { bindings: { task: "openai-default" } } });
assert.equal(partial.bindings.task, "openai-default");
assert.equal(resolveApiCapability({ ...fixture, apiCenter: partial }, "task").profile.id, "openai-default");

const keychain = structuredClone(center);
const chatConnection = keychain.connections.find((item) => item.id === keychain.profiles.find((item) => item.id === keychain.bindings.chat).connectionId);
chatConnection.credentialSource = "keychain";
delete chatConnection.credentialRef;
const assigned = validateApiCenter(keychain, fixture);
const ref = assigned.connections.find((item) => item.id === chatConnection.id).credentialRef;
assert.match(ref, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
assert.equal(validateApiCenter(assigned, { apiCenter: assigned }).connections.find((item) => item.id === chatConnection.id).credentialRef, ref);
assert.equal(validateApiCenter(keychain, { apiCenter: assigned }).connections.find((item) => item.id === chatConnection.id).credentialRef, ref);
const duplicateRef = structuredClone(assigned);
const other = duplicateRef.connections.find((item) => item.id !== chatConnection.id);
other.credentialSource = "keychain";
other.credentialRef = ref;
assert.throws(() => validateApiCenter(duplicateRef), /duplicate credentialRef/);
const badRef = structuredClone(assigned);
badRef.connections.find((item) => item.id === chatConnection.id).credentialRef = "not-a-uuid";
assert.throws(() => validateApiCenter(badRef), /credentialRef/);
const secret = structuredClone(center);
secret.connections[0].apiKey = "test-only-placeholder";
assert.throws(() => validateApiCenter(secret), /connections/);
const secretUrl = structuredClone(center);
secretUrl.connections[0].baseUrl = "https://example.test/v1?api_key=test-only-placeholder";
assert.throws(() => validateApiCenter(secretUrl), /baseUrl/);
const secretArg = structuredClone(center);
secretArg.profiles.find((item) => item.kind === "chat").args = ["--api-key", "test-only-placeholder"];
assert.throws(() => validateApiCenter(secretArg), /args/);

const invalidBinding = structuredClone(center);
invalidBinding.bindings.vision = "missing";
assert.throws(() => validateApiCenter(invalidBinding), /bindings.vision/);
const invalidConnection = structuredClone(center);
invalidConnection.profiles[0].connectionId = "missing";
assert.throws(() => validateApiCenter(invalidConnection), /connectionId/);
const wrongKind = structuredClone(center);
wrongKind.bindings.asr = wrongKind.bindings.chat;
assert.throws(() => validateApiCenter(wrongKind), /bindings.asr/);
const badAsr = structuredClone(center);
badAsr.profiles.find((item) => item.kind === "asr").model = "other-asr";
assert.throws(() => validateApiCenter(badAsr), /model/);
const badTts = structuredClone(center);
badTts.profiles.find((item) => item.kind === "tts").model = "other-tts";
assert.throws(() => validateApiCenter(badTts), /model/);
const badVoiceProvider = structuredClone(center);
badVoiceProvider.connections.find((item) => item.id === badVoiceProvider.profiles.find((entry) => entry.kind === "asr").connectionId).provider = "deepseek";
assert.throws(() => validateApiCenter(badVoiceProvider), /connectionId/);

const legacyVoice = structuredClone(fixture);
legacyVoice.voice.credentialSource = "keychain";
const voiceCenter = normalizeApiCenter(legacyVoice);
assert.equal(resolveApiCapability({ ...legacyVoice, apiCenter: voiceCenter }, "asr").connection.credentialSource, "legacy-voice-keychain");
applyApiCenterBindings(legacyVoice, voiceCenter);
assert.equal(legacyVoice.voice.asrApi.credentialSource, "legacy-voice-keychain");
assert.equal(legacyVoice.voice.ttsApi.credentialSource, "legacy-voice-keychain");
assert.equal(legacyVoice.voice.tts.model, "mimo-v2.5-tts");

const shared = structuredClone(center);
const chat = shared.profiles.find((item) => item.id === shared.bindings.chat);
const alternate = shared.profiles.find((item) => item.id === "openai-default");
alternate.connectionId = chat.connectionId;
shared.connections = shared.connections.filter((item) => shared.profiles.some((profile) => profile.connectionId === item.id));
const sharedConfig = applyApiCenterBindings(structuredClone(fixture), shared);
const beforeAlternate = sharedConfig.apiCenter.connections.find((item) => item.id === alternate.connectionId);
syncLegacyApiPatch(sharedConfig, { ai: { baseUrl: "https://example.test/v1", apiKeyEnv: "NEW_API_KEY" } });
assert.equal(resolveApiCapability(sharedConfig, "chat").connection.baseUrl, "https://example.test/v1");
assert.notEqual(sharedConfig.apiCenter.profiles.find((item) => item.id === chat.id).connectionId, alternate.connectionId);
assert.equal(sharedConfig.apiCenter.connections.find((item) => item.id === alternate.connectionId).baseUrl, beforeAlternate.baseUrl);
const sharedKeychain = structuredClone(shared);
const sharedTarget = sharedKeychain.connections.find((item) => item.id === chat.connectionId);
sharedTarget.credentialSource = "keychain";
sharedTarget.credentialRef = ref;
const keychainConfig = applyApiCenterBindings(structuredClone(fixture), sharedKeychain);
syncLegacyApiPatch(keychainConfig, { ai: { baseUrl: "https://other.example.test/v1" } });
const changedChat = resolveApiCapability(keychainConfig, "chat").connection;
assert.notEqual(changedChat.credentialRef, ref);
assert.match(changedChat.credentialRef, /^[0-9a-f-]{36}$/);
assert.equal(keychainConfig.apiCenter.connections.find((item) => item.id === alternate.connectionId).credentialRef, ref);

const sync = applyApiCenterBindings(structuredClone(fixture), center);
syncLegacyApiPatch(sync, { aiProfiles: { activeId: "openai-default" }, vision: { model: "mimo-v2.5", toolsets: "vision" },
  voice: { tts: { model: "mimo-v2.5-tts-voicedesign" } }, webSearch: { maxResults: 5 } });
assert.equal(sync.apiCenter.bindings.chat, "openai-default");
assert.equal(sync.apiCenter.profiles.find((item) => item.id === sync.apiCenter.bindings.tts).model, "mimo-v2.5-tts-voicedesign");
assert.equal(sync.apiCenter.searchProfiles.find((item) => item.id === sync.apiCenter.searchBinding).maxResults, 5);
assert.deepEqual(syncLegacyApiPatch(structuredClone(fixture), { ai: { model: "other" } }), fixture);

const mimoSearch = structuredClone(center);
const mimoConnection = mimoSearch.connections.find((item) => ["xiaomi", "mimo"].includes(item.provider.toLowerCase())
  && (!item.baseUrl || item.baseUrl.startsWith("https://api.xiaomimimo.com/v1")));
assert.ok(mimoConnection, "fixture needs an official MiMo connection");
mimoSearch.searchProfiles.push({ id: "mimo-official", name: "MiMo 官方联网", provider: "mimo-web-search",
  providerOrder: ["mimo-web-search"], connectionId: mimoConnection.id, model: "mimo-v2.6-flash",
  maxKeyword: 2, forceSearch: true, maxResults: 4, timeoutMs: 20000,
  proxy: { enabled: false, autoDetect: false, directFallback: false, urls: [] } });
mimoSearch.searchBinding = "mimo-official";
const mimoValidated = validateApiCenter(mimoSearch, fixture);
const mimoProjected = applyApiCenterBindings(structuredClone(fixture), mimoValidated);
assert.equal(mimoProjected.webSearch.provider, "mimo-web-search");
assert.equal(mimoProjected.webSearch.mimo.model, "mimo-v2.6-flash");
assert.equal(normalizeApiCenter(mimoProjected).searchBinding, "mimo-official");
const unsupportedSearch = structuredClone(mimoSearch);
unsupportedSearch.searchProfiles.at(-1).model = "not-supported";
assert.throws(() => validateApiCenter(unsupportedSearch, fixture), /model/);
const wrongConnection = structuredClone(mimoSearch);
wrongConnection.searchProfiles.at(-1).connectionId = wrongConnection.connections.find((item) => item.id !== mimoConnection.id && item.provider !== "xiaomi")?.id || "missing";
assert.throws(() => validateApiCenter(wrongConnection, fixture), /connectionId/);
const silentFallback = structuredClone(mimoSearch);
silentFallback.searchProfiles.at(-1).providerOrder.push("google");
assert.throws(() => validateApiCenter(silentFallback, fixture), /providerOrder/);

const accountConfig = structuredClone(fixture);
accountConfig.apiCenter = structuredClone(mimoValidated);
const accountCenter = accountConfig.apiCenter;
const accountRef = "a1111111-1111-4111-8111-111111111111";
accountCenter.connections.push({ id: "peer-keychain", name: "Peer credential reference", provider: "xiaomi",
  baseUrl: "https://api.xiaomimimo.com/v1", credentialSource: "keychain", apiKeyEnv: "PEER_MIMO_KEY", credentialRef: accountRef });
for (const kind of ["chat", "vision", "asr", "tts"]) {
  const template = accountCenter.profiles.find((item) => item.id === accountCenter.bindings[kind]);
  accountCenter.profiles.push({ ...structuredClone(template), id: `peer-${kind}`, name: `Peer ${kind}`, connectionId: "peer-keychain" });
}
accountConfig.accounts = { version: 2, topology: "failover", items: [
  { id: "alpha", displayName: "Alpha", features: { chat: true, task: true }, modelBindings: {} },
  { id: "beta", displayName: "Beta", features: { chat: true, task: true },
    modelBindings: { chat: "peer-chat", task: "inherit-chat", vision: "peer-vision", asr: "peer-asr", tts: "peer-tts", search: "legacy-search" } }
], failoverGroups: [] };
const beforeAccountResolution = structuredClone(accountConfig);
for (const kind of ["chat", "vision", "asr", "tts"]) {
  const resolved = resolveApiCapability(accountConfig, kind, "beta");
  assert.equal(resolved.profile.id, `peer-${kind}`);
  assert.equal(resolved.connection.credentialSource, "keychain");
  assert.equal(resolved.connection.credentialRef, accountRef);
  assert.equal(resolved.connection.apiKeyEnv, "PEER_MIMO_KEY");
  assert.equal("apiKey" in resolved.connection, false);
  resolved.connection.credentialSource = "modified-return-value";
  resolved.profile.model = "modified-return-value";
}
assert.equal(resolveApiCapability(accountConfig, "task", "beta").profile.id, "peer-chat");
assert.equal(resolveApiCapability(accountConfig, "search", "beta").profile.id, "legacy-search");
assert.equal(resolveApiCapability(accountConfig, "search", "beta").connection, null);
assert.equal(resolveApiCapability(accountConfig, "search").profile.id, "mimo-official");
assert.ok(resolveApiCapability(accountConfig, "search").connection);
assert.equal(resolveApiCapability(accountConfig, "chat", "alpha").profile.id, accountCenter.bindings.chat);
assert.deepEqual(accountConfig, beforeAccountResolution);
accountConfig.__activeAccountId = "beta";
assert.equal(resolveApiCapability(accountConfig, "chat").profile.id, "peer-chat");
assert.equal(resolveApiCapability(accountConfig, "chat", "").profile.id, accountCenter.bindings.chat);
assert.equal(resolveApiCapability(accountConfig, "chat", "alpha").profile.id, accountCenter.bindings.chat);
// Empty task override inherits the global choice; the global inherit-chat sentinel
// still means the current account's chat, not global chat.
accountConfig.accounts.items[1].modelBindings.task = "";
assert.equal(resolveApiCapability(accountConfig, "task").profile.id, "peer-chat");
accountConfig.apiCenter.bindings.task = "openai-default";
assert.equal(resolveApiCapability(accountConfig, "task").profile.id, "openai-default");
accountConfig.accounts.items[1].modelBindings.task = "inherit-chat";
assert.equal(resolveApiCapability(accountConfig, "task").profile.id, "peer-chat");
accountConfig.accounts.items[1].modelBindings.task = "openai-default";
assert.equal(resolveApiCapability(accountConfig, "task").profile.id, "openai-default");
const perAccountProjected = applyApiCenterBindings(structuredClone(accountConfig));
assert.equal(perAccountProjected.ai.credentialRef, accountRef);
assert.equal(perAccountProjected.vision.credentialRef, accountRef);
assert.equal(perAccountProjected.voice.asrApi.credentialRef, accountRef);
assert.equal(perAccountProjected.voice.ttsApi.credentialRef, accountRef);
assert.equal(perAccountProjected.webSearch.provider, center.searchProfiles[0].provider);
assert.deepEqual(perAccountProjected.apiCenter, accountConfig.apiCenter);
const globalProjected = applyApiCenterBindings(structuredClone(accountConfig), accountConfig.apiCenter, "");
assert.equal(globalProjected.aiProfiles.activeId, accountCenter.bindings.chat);
assert.equal(globalProjected.webSearch.provider, "mimo-web-search");
for (const kind of ["chat", "task", "vision", "asr", "tts", "search"]) {
  const invalid = structuredClone(accountConfig);
  invalid.accounts.items[1].modelBindings[kind] = "missing";
  assert.throws(() => resolveApiCapability(invalid, kind), new RegExp(`modelBindings.${kind}`));
  invalid.accounts.items[1].modelBindings[kind] = "inherit-chat";
  if (kind !== "task") assert.throws(() => resolveApiCapability(invalid, kind), new RegExp(`modelBindings.${kind}`));
  invalid.accounts.items[1].modelBindings[kind] = 42;
  assert.throws(() => resolveApiCapability(invalid, kind), new RegExp(`modelBindings.${kind}`));
}
for (const kind of ["vision", "asr", "tts", "search"]) {
  const invalid = structuredClone(accountConfig);
  invalid.accounts.items[1].modelBindings[kind] = "peer-chat";
  assert.throws(() => resolveApiCapability(invalid, kind), new RegExp(`modelBindings.${kind}`));
}
const cloneBinding = structuredClone(accountConfig);
cloneBinding.apiCenter.profiles.push({ ...cloneBinding.apiCenter.profiles.find((item) => item.id === "peer-tts"), id: "clone-only", model: "mimo-v2.5-tts-voiceclone" });
cloneBinding.accounts.items[1].modelBindings.tts = "clone-only";
assert.throws(() => resolveApiCapability(cloneBinding, "tts"), /modelBindings.tts/);
assert.throws(() => resolveApiCapability(accountConfig, "chat", "missing"), /account/);
const archivedAccount = structuredClone(accountConfig);
archivedAccount.accounts.items[1].archived = true;
assert.throws(() => resolveApiCapability(archivedAccount, "chat", "beta"), /account/);
const groupConfig = structuredClone(accountConfig);
groupConfig.accounts.failoverGroups = [{ id: "shared", name: "Shared", memberIds: ["alpha", "beta"], policyAccountId: "beta",
  policy: { modelBindings: { chat: "peer-chat", task: "inherit-chat", vision: "peer-vision", asr: "peer-asr", tts: "peer-tts", search: "mimo-official" } } }];
for (const id of ["alpha", "beta"]) {
  assert.equal(resolveApiCapability(groupConfig, "chat", id).profile.id, "peer-chat");
  assert.equal(resolveApiCapability(groupConfig, "task", id).profile.id, "peer-chat");
  assert.equal(resolveApiCapability(groupConfig, "search", id).profile.id, "mimo-official");
}
const envBinding = structuredClone(accountConfig);
envBinding.apiCenter.connections.find((item) => item.id === "peer-keychain").credentialSource = "existing";
delete envBinding.apiCenter.connections.find((item) => item.id === "peer-keychain").credentialRef;
assert.equal(resolveApiCapability(envBinding, "asr").connection.apiKeyEnv, "PEER_MIMO_KEY");
assert.equal(resolveApiCapability(envBinding, "asr").connection.credentialRef, undefined);
const rejectedProjection = structuredClone(accountConfig);
rejectedProjection.accounts.items[1].modelBindings.task = "invalid-test-only-binding";
const beforeRejected = structuredClone(rejectedProjection);
assert.throws(() => applyApiCenterBindings(rejectedProjection), (error) => /modelBindings.task/.test(error.message)
  && !error.message.includes("invalid-test-only-binding"));
assert.deepEqual(rejectedProjection, beforeRejected);
// Profile identifiers are not model identifiers. Digits, hyphens and underscores
// are valid in profile IDs; model names also retain provider dots/slashes.
const modelNames = structuredClone(accountConfig);
for (const [id, model] of [["deepseek-v4-flash-01", "deepseek-v4-flash"],
  ["mimo-v2_5-02", "mimo-v2.5"], ["model-2026-10-09", "Qwen/Qwen3.5-35B-A3B"]]) {
  modelNames.apiCenter.profiles.push({ ...structuredClone(modelNames.apiCenter.profiles.find((item) => item.kind === "chat")), id, model });
  assert.equal(validateApiCenter(modelNames.apiCenter, modelNames).profiles.find((item) => item.id === id).model, model);
  modelNames.accounts.items[1].modelBindings.chat = id;
  assert.equal(resolveApiCapability(modelNames, "chat", "beta").profile.model, model);
}
console.log("api-center self-test: PASS (global compatibility + per-account/group bindings)");
