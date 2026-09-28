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

console.log("api-center self-test: PASS");
