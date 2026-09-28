import { randomUUID } from "node:crypto";
import { isValidApiSecretRef } from "./api-secret-store.js";
import { isSupportedMimoSearchModel, officialMimoSearchEndpoint } from "./mimo-web-search.js";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const SOURCES = new Set(["existing", "keychain", "legacy-voice-keychain"]);
const KINDS = new Set(["chat", "vision", "asr", "tts"]);
const TTS_MODELS = new Set(["mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign", "mimo-v2.5-tts-voiceclone"]);

function fail(field) { throw new Error(`Invalid API Center ${field}`); }
function exact(value, keys, field) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(field);
}
function string(value, field, { blank = false, max = 500 } = {}) {
  if (typeof value !== "string" || value.length > max || (!blank && !value.trim()) || value !== value.trim() || /[\r\n\0]/.test(value)) fail(field);
  return value;
}
function identifier(value, field) {
  if (typeof value !== "string" || !ID.test(value)) fail(field);
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}
function url(value, field, { proxy = false } = {}) {
  string(value, field, { blank: true });
  if (!value) {
    if (proxy) fail(field);
    return value;
  }
  let parsed;
  try { parsed = new URL(value); } catch { fail(field); }
  if (!(proxy ? ["http:", "https:", "socks5:", "socks5h:"] : ["http:", "https:"]).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.hash || parsed.search) fail(field);
  return value;
}
function optionalText(input, output, key, field, options) {
  if (own(input, key)) output[key] = string(input[key], field, options);
}
function connection(value, index, previous) {
  const field = `connections[${index}]`;
  exact(value, ["id", "name", "provider", "baseUrl", "credentialSource", "apiKeyEnv", "credentialRef"], field);
  const result = {
    id: identifier(value.id, `${field}.id`),
    name: string(value.name, `${field}.name`, { max: 80 }),
    provider: string(value.provider, `${field}.provider`, { max: 80 }),
    baseUrl: url(value.baseUrl, `${field}.baseUrl`),
    credentialSource: value.credentialSource,
    apiKeyEnv: string(value.apiKeyEnv, `${field}.apiKeyEnv`, { blank: true, max: 80 })
  };
  if (!SOURCES.has(result.credentialSource) || (result.apiKeyEnv && !ENV.test(result.apiKeyEnv))) fail(field);
  if (result.credentialSource === "keychain") {
    const ref = value.credentialRef || (previous?.credentialSource === "keychain" ? previous.credentialRef : "") || randomUUID();
    if (!isValidApiSecretRef(ref)) fail(`${field}.credentialRef`);
    result.credentialRef = ref;
  } else if (own(value, "credentialRef") && value.credentialRef !== "") fail(`${field}.credentialRef`);
  return result;
}
function profile(value, index, connections) {
  const field = `profiles[${index}]`;
  exact(value, ["id", "name", "kind", "connectionId", "model", "command", "args", "reasoningEffort", "timeoutMs", "toolsets"], field);
  const result = {
    id: identifier(value.id, `${field}.id`),
    name: string(value.name, `${field}.name`, { max: 80 }),
    kind: value.kind,
    connectionId: identifier(value.connectionId, `${field}.connectionId`),
    model: string(value.model, `${field}.model`, { blank: value.kind === "chat", max: 160 })
  };
  if (!KINDS.has(result.kind)) fail(`${field}.kind`);
  const target = connections.get(result.connectionId);
  if (!target) fail(`${field}.connectionId`);
  optionalText(value, result, "command", `${field}.command`, { max: 300 });
  optionalText(value, result, "reasoningEffort", `${field}.reasoningEffort`, { blank: true, max: 40 });
  optionalText(value, result, "toolsets", `${field}.toolsets`, { blank: true, max: 160 });
  if (own(value, "args")) {
    if (!Array.isArray(value.args) || value.args.length > 40) fail(`${field}.args`);
    result.args = value.args.map((arg) => string(arg, `${field}.args`, { max: 300 }));
    if (result.args.some((arg) => /^--?(?:api[-_]?key|access[-_]?token|token|secret|password|authorization)(?:$|=)/i.test(arg))) fail(`${field}.args`);
  }
  if (own(value, "timeoutMs")) result.timeoutMs = integer(value.timeoutMs, `${field}.timeoutMs`, 1000, 600000);
  if (result.kind === "asr" && result.model !== "mimo-v2.5-asr") fail(`${field}.model`);
  if (result.kind === "tts" && !TTS_MODELS.has(result.model)) fail(`${field}.model`);
  if (["asr", "tts"].includes(result.kind) && !["xiaomi", "mimo"].includes(target.provider.toLowerCase())) fail(`${field}.connectionId`);
  if (["asr", "tts"].includes(result.kind) && target.baseUrl
    && !["https://api.xiaomimimo.com/v1", "https://api.xiaomimimo.com/v1/chat/completions"].includes(target.baseUrl.replace(/\/$/, ""))) fail(`${field}.connectionId`);
  return result;
}
function searchProfile(value, index, connections) {
  const field = `searchProfiles[${index}]`;
  exact(value, ["id", "name", "provider", "providerOrder", "proxy", "maxResults", "timeoutMs", "connectionId", "model", "maxKeyword", "forceSearch"], field);
  const result = {
    id: identifier(value.id, `${field}.id`),
    name: string(value.name, `${field}.name`, { max: 80 }),
    provider: string(value.provider, `${field}.provider`, { max: 80 }),
    providerOrder: value.providerOrder,
    proxy: value.proxy,
    maxResults: integer(value.maxResults, `${field}.maxResults`, 1, 10),
    timeoutMs: integer(value.timeoutMs, `${field}.timeoutMs`, 1000, 60000)
  };
  if (!Array.isArray(result.providerOrder) || result.providerOrder.length > 6) fail(`${field}.providerOrder`);
  result.providerOrder = result.providerOrder.map((item) => string(item, `${field}.providerOrder`, { max: 80 }));
  exact(result.proxy, ["enabled", "autoDetect", "directFallback", "urls"], `${field}.proxy`);
  for (const key of ["enabled", "autoDetect", "directFallback"]) {
    if (typeof result.proxy[key] !== "boolean") fail(`${field}.proxy.${key}`);
  }
  if (!Array.isArray(result.proxy.urls) || result.proxy.urls.length > 12) fail(`${field}.proxy.urls`);
  result.proxy = { ...result.proxy, urls: result.proxy.urls.map((item) => url(item, `${field}.proxy.urls`, { proxy: true })) };
  if (result.provider === "mimo-web-search") {
    result.connectionId = identifier(value.connectionId, `${field}.connectionId`);
    const target = connections.get(result.connectionId);
    if (!target || !["xiaomi", "mimo"].includes(target.provider.toLowerCase())) fail(`${field}.connectionId`);
    try { officialMimoSearchEndpoint(target.baseUrl); } catch { fail(`${field}.connectionId`); }
    result.model = string(value.model, `${field}.model`, { max: 160 });
    if (!isSupportedMimoSearchModel(result.model)) fail(`${field}.model`);
    result.maxKeyword = integer(value.maxKeyword ?? 2, `${field}.maxKeyword`, 1, 5);
    if (typeof value.forceSearch !== "boolean") fail(`${field}.forceSearch`);
    result.forceSearch = value.forceSearch;
    if (result.providerOrder.length !== 1 || result.providerOrder[0] !== "mimo-web-search") fail(`${field}.providerOrder`);
  } else if (["connectionId", "model", "maxKeyword", "forceSearch"].some((key) => own(value, key))) fail(field);
  return result;
}

/** Validate an entire v1 center. Unknown fields are rejected so credentials cannot enter config. */
export function validateApiCenter(candidate, currentConfig = {}) {
  exact(candidate, ["version", "connections", "profiles", "bindings", "searchProfiles", "searchBinding"], "root");
  if (candidate.version !== 1) fail("version");
  if (!Array.isArray(candidate.connections) || candidate.connections.length > 80) fail("connections");
  if (!Array.isArray(candidate.profiles) || candidate.profiles.length > 100) fail("profiles");
  if (!Array.isArray(candidate.searchProfiles) || candidate.searchProfiles.length > 40) fail("searchProfiles");
  const oldConnections = new Map((currentConfig?.apiCenter?.connections || []).filter(object).map((item) => [item.id, item]));
  const connections = candidate.connections.map((item, index) => connection(item, index, oldConnections.get(item?.id)));
  const connectionMap = new Map(connections.map((item) => [item.id, item]));
  if (connectionMap.size !== connections.length) fail("duplicate connection id");
  const refs = new Set();
  for (const item of connections) {
    if (!item.credentialRef) continue;
    if (refs.has(item.credentialRef)) fail("duplicate credentialRef");
    refs.add(item.credentialRef);
  }
  const profiles = candidate.profiles.map((item, index) => profile(item, index, connectionMap));
  const profileMap = new Map(profiles.map((item) => [item.id, item]));
  if (profileMap.size !== profiles.length) fail("duplicate profile id");
  exact(candidate.bindings, ["chat", "task", "vision", "asr", "tts"], "bindings");
  const bindings = {};
  for (const kind of ["chat", "vision", "asr", "tts"]) {
    const id = identifier(candidate.bindings[kind], `bindings.${kind}`);
    if (profileMap.get(id)?.kind !== kind) fail(`bindings.${kind}`);
    if (kind === "tts" && profileMap.get(id)?.model === "mimo-v2.5-tts-voiceclone") fail("bindings.tts");
    bindings[kind] = id;
  }
  const task = candidate.bindings.task;
  if (task !== "inherit-chat" && profileMap.get(task)?.kind !== "chat") fail("bindings.task");
  bindings.task = task;
  const searchProfiles = candidate.searchProfiles.map((item, index) => searchProfile(item, index, connectionMap));
  const searchMap = new Map(searchProfiles.map((item) => [item.id, item]));
  if (searchMap.size !== searchProfiles.length || !searchMap.has(candidate.searchBinding)) fail("searchBinding");
  return { version: 1, connections, profiles, bindings, searchProfiles, searchBinding: candidate.searchBinding };
}

function legacyId(value, fallback) {
  const result = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 64);
  return ID.test(result) ? result : fallback;
}
function legacyText(value, fallback = "") { return (typeof value === "string" ? value.trim() : "") || fallback; }
function legacyEnv(value, fallback = "") { return ENV.test(value || "") ? value : fallback; }
function legacySource(value, voice = false) { return value === "keychain" && voice ? "legacy-voice-keychain" : SOURCES.has(value) ? value : "existing"; }
function aiArgs(ai) { return Array.isArray(ai.args) ? ai.args.filter((item) => typeof item === "string") : ["-z"]; }
function argValue(args, flags) {
  for (let i = 0; i < args.length - 1; i += 1) if (flags.includes(args[i])) return args[i + 1];
  return "";
}

function legacyCenter(config) {
  const center = { version: 1, connections: [], profiles: [], bindings: {}, searchProfiles: [], searchBinding: "legacy-search" };
  const connectionBySignature = new Map();
  const addConnection = (id, name, source, voice = false) => {
    const provider = legacyText(source.provider, voice ? "xiaomi" : "custom");
    const credentialSource = legacySource(source.credentialSource, voice);
    const apiKeyEnv = legacyEnv(source.apiKeyEnv, voice ? "MIMO_API_KEY" : "");
    const baseUrl = legacyText(source.baseUrl || source.baseURL);
    const credentialRef = credentialSource === "keychain" ? source.credentialRef : undefined;
    const signature = JSON.stringify([provider, baseUrl, credentialSource, apiKeyEnv, credentialRef]);
    if (connectionBySignature.has(signature)) return connectionBySignature.get(signature);
    const unique = (base) => {
      const stem = base.slice(0, 58);
      let next = stem, n = 2;
      while (center.connections.some((item) => item.id === next)) next = `${stem}-${n++}`;
      return next;
    };
    const connection = { id: unique(id), name, provider, baseUrl, credentialSource, apiKeyEnv };
    if (credentialRef) connection.credentialRef = credentialRef;
    center.connections.push(connection);
    connectionBySignature.set(signature, connection.id);
    return connection.id;
  };
  const rawAi = object(config.ai) ? config.ai : {};
  const legacyProfiles = Array.isArray(config.aiProfiles?.profiles) && config.aiProfiles.profiles.length
    ? config.aiProfiles.profiles : [{ id: "legacy-chat", name: "当前聊天", ...rawAi }];
  for (let index = 0; index < legacyProfiles.length; index += 1) {
    const item = legacyProfiles[index];
    if (!object(item)) continue;
    const id = legacyId(item.id, `chat-${index + 1}`);
    // config.ai is the runtime source of truth; the active saved preset may be stale.
    const source = item.id === config.aiProfiles?.activeId ? { ...item, ...rawAi } : item;
    const args = aiArgs(source);
    const connectionId = addConnection(`conn-${id}`, legacyText(item.name, id), {
      ...source, provider: source.provider || argValue(args, ["--provider"]), apiKeyEnv: source.apiKeyEnv || rawAi.apiKeyEnv
    });
    center.profiles.push({ id, name: legacyText(item.name, id), kind: "chat", connectionId,
      model: legacyText(source.model || argValue(args, ["-m", "--model"])), command: legacyText(source.command, "hermes"),
      args, reasoningEffort: legacyText(source.reasoningEffort, "none"), timeoutMs: Number.isSafeInteger(source.timeoutMs) ? source.timeoutMs : 120000 });
  }
  if (!center.profiles.length) return legacyCenter({ ...config, aiProfiles: undefined });
  const uniqueProfileId = (base) => {
    let id = base, n = 2;
    while (center.profiles.some((item) => item.id === id)) id = `${base}-${n++}`;
    return id;
  };
  center.bindings.chat = center.profiles.some((item) => item.id === config.aiProfiles?.activeId)
    ? config.aiProfiles.activeId : center.profiles[0].id;
  center.bindings.task = "inherit-chat";
  const vision = object(config.vision) ? config.vision : {};
  center.bindings.vision = uniqueProfileId("legacy-vision");
  center.profiles.push({ id: center.bindings.vision, name: "图像识别", kind: "vision",
    connectionId: addConnection("conn-vision", "图像识别", { ...vision, provider: vision.provider || "xiaomi", apiKeyEnv: vision.apiKeyEnv || "XIAOMI_API_KEY" }),
    model: legacyText(vision.model, "mimo-v2.5"), toolsets: legacyText(vision.toolsets, "vision"),
    timeoutMs: Number.isSafeInteger(vision.timeoutMs) ? vision.timeoutMs : 120000 });
  const voice = object(config.voice) ? config.voice : {};
  for (const kind of ["asr", "tts"]) {
    const slot = object(voice[`${kind}Api`]) ? voice[`${kind}Api`] : {};
    const source = { ...voice, ...slot, provider: slot.provider || "xiaomi", credentialSource: slot.credentialSource || voice.credentialSource };
    const id = uniqueProfileId(`legacy-${kind}`);
    center.bindings[kind] = id;
    center.profiles.push({ id, name: kind.toUpperCase(), kind,
      connectionId: addConnection(`conn-${kind}`, kind.toUpperCase(), source, !own(slot, "credentialSource")),
      model: kind === "asr" ? "mimo-v2.5-asr" : legacyText(voice.tts?.model, "mimo-v2.5-tts"),
      timeoutMs: Number.isSafeInteger(voice.timeoutMs) ? voice.timeoutMs : 60000 });
  }
  const search = object(config.webSearch) ? config.webSearch : {};
  const proxy = object(search.proxy) ? search.proxy : {};
  center.searchProfiles.push({ id: "legacy-search", name: "当前搜索", provider: legacyText(search.provider, "google"),
    providerOrder: Array.isArray(search.providerOrder) ? search.providerOrder : ["google", "baidu"],
    proxy: { enabled: proxy.enabled !== false, autoDetect: proxy.autoDetect !== false,
      directFallback: proxy.directFallback !== false, urls: Array.isArray(proxy.urls) ? proxy.urls : [] },
    maxResults: Number.isSafeInteger(search.maxResults) ? search.maxResults : 4,
    timeoutMs: Number.isSafeInteger(search.timeoutMs) ? search.timeoutMs : 8000,
    ...(search.provider === "mimo-web-search" ? {
      connectionId: search.mimo?.connectionId || center.profiles.find((item) => item.id === center.bindings.chat)?.connectionId || "",
      model: search.mimo?.model || center.profiles.find((item) => item.id === center.bindings.chat)?.model || "",
      maxKeyword: search.mimo?.maxKeyword ?? 2,
      forceSearch: search.mimo?.forceSearch !== false
    } : {}) });
  return center;
}

/** Derive missing center sections from legacy settings without reading credential values. */
export function normalizeApiCenter(config = {}) {
  if (!object(config)) fail("config");
  const legacy = legacyCenter(config);
  const incoming = config.apiCenter;
  if (incoming === undefined || incoming === null) return validateApiCenter(legacy, config);
  if (!object(incoming)) fail("root");
  const merged = { ...legacy, ...incoming, bindings: { ...legacy.bindings, ...(incoming.bindings || {}) } };
  return validateApiCenter(merged, config);
}

/** Resolve one role; task inherits chat unless explicitly bound. */
export function resolveApiCapability(config, capability) {
  if (!KINDS.has(capability) && capability !== "task") return null;
  const center = normalizeApiCenter(config);
  const id = capability === "task" && center.bindings.task === "inherit-chat" ? center.bindings.chat : center.bindings[capability];
  const profile = center.profiles.find((item) => item.id === id);
  const connection = center.connections.find((item) => item.id === profile?.connectionId);
  return profile && connection ? { profile: copy(profile), connection: copy(connection) } : null;
}

function setArg(args, flags, preferred, value) {
  const result = [...args];
  const at = result.findIndex((item) => flags.includes(item));
  if (at >= 0) {
    if (value) result[at + 1] = value;
    else result.splice(at, 2);
  } else if (value) result.unshift(preferred, value);
  return result;
}
function credentialProjection(connection) {
  return { credentialSource: connection.credentialSource, credentialRef: connection.credentialRef || "",
    apiKeyEnv: connection.apiKeyEnv, baseUrl: connection.baseUrl };
}

/** Mutate only center-owned legacy fields; keep feature flags and other user settings. */
export function applyApiCenterBindings(config, center = normalizeApiCenter(config)) {
  if (!object(config)) fail("config");
  const safe = validateApiCenter(center, config);
  const byProfile = new Map(safe.profiles.map((item) => [item.id, item]));
  const byConnection = new Map(safe.connections.map((item) => [item.id, item]));
  const selected = (kind) => {
    const profile = byProfile.get(safe.bindings[kind]);
    return [profile, byConnection.get(profile.connectionId)];
  };
  const [chat, chatConnection] = selected("chat");
  const [vision, visionConnection] = selected("vision");
  const [asr, asrConnection] = selected("asr");
  const [tts, ttsConnection] = selected("tts");
  const projectAi = (profile, connection, prior = {}) => {
    const args = profile.args ? [...profile.args] : aiArgs(prior);
    return { ...prior, command: profile.command || prior.command || "hermes", args: setArg(setArg(args, ["--provider"], "--provider", connection.provider), ["-m", "--model"], "-m", profile.model),
      provider: connection.provider, model: profile.model, baseUrl: connection.baseUrl, apiKeyEnv: connection.apiKeyEnv,
      credentialSource: connection.credentialSource, credentialRef: connection.credentialRef || "",
      reasoningEffort: profile.reasoningEffort ?? prior.reasoningEffort ?? "none", timeoutMs: profile.timeoutMs ?? prior.timeoutMs ?? 120000 };
  };
  config.ai = projectAi(chat, chatConnection, config.ai);
  const oldProfiles = new Map((config.aiProfiles?.profiles || []).map((item) => [item.id, item]));
  config.aiProfiles = { ...(config.aiProfiles || {}), activeId: chat.id,
    profiles: safe.profiles.filter((item) => item.kind === "chat").map((item) => projectAi(item, byConnection.get(item.connectionId),
      { ...(oldProfiles.get(item.id) || {}), id: item.id, name: item.name })) };
  config.vision = { ...(config.vision || {}), ...credentialProjection(visionConnection), provider: visionConnection.provider,
    model: vision.model, toolsets: vision.toolsets ?? config.vision?.toolsets ?? "vision", timeoutMs: vision.timeoutMs ?? config.vision?.timeoutMs ?? 120000 };
  const voice = config.voice || {};
  config.voice = { ...voice, asrApi: { ...(voice.asrApi || {}), ...credentialProjection(asrConnection), provider: asrConnection.provider, model: asr.model },
    ttsApi: { ...(voice.ttsApi || {}), ...credentialProjection(ttsConnection), provider: ttsConnection.provider, model: tts.model },
    tts: { ...(voice.tts || {}), model: tts.model } };
  const search = safe.searchProfiles.find((item) => item.id === safe.searchBinding);
  config.webSearch = { ...(config.webSearch || {}), provider: search.provider, providerOrder: [...search.providerOrder],
    proxy: { ...(config.webSearch?.proxy || {}), ...copy(search.proxy) }, maxResults: search.maxResults, timeoutMs: search.timeoutMs };
  if (search.provider === "mimo-web-search") config.webSearch.mimo = {
    connectionId: search.connectionId, model: search.model, maxKeyword: search.maxKeyword, forceSearch: search.forceSearch
  };
  config.apiCenter = safe;
  return config;
}

/** Mirror a sanitized legacy PATCH into the center, cloning shared connections before editing them. */
export function syncLegacyApiPatch(config, patch) {
  if (!object(config) || !object(patch)) fail("legacy patch");
  if (!config.apiCenter) return config;
  const center = normalizeApiCenter(config);
  const profileFor = (kind) => center.profiles.find((item) => item.id === center.bindings[kind]);
  const syncConnection = (profile, fields) => {
    if (!Object.keys(fields).length) return;
    let target = center.connections.find((item) => item.id === profile.connectionId);
    if (!target) fail("connectionId");
    const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && target[key] !== value));
    if (!Object.keys(changes).length) return;
    if (center.profiles.filter((item) => item.connectionId === target.id).length > 1) {
      const base = `${target.id}-${profile.id}`.slice(0, 58);
      let id = base, n = 2;
      while (center.connections.some((item) => item.id === id)) id = `${base}-${n++}`;
      target = { ...target, id };
      // A cloned connection is a separate credential owner. Never copy a secret or reuse its ref.
      if (target.credentialSource === "keychain") target.credentialRef = randomUUID();
      center.connections.push(target);
      profile.connectionId = id;
    }
    Object.assign(target, changes);
    if (target.credentialSource !== "keychain") delete target.credentialRef;
    else if (own(fields, "credentialSource") && fields.credentialSource === "keychain" && !own(fields, "credentialRef")) delete target.credentialRef;
  };
  const connectionFields = (value, voice = false) => Object.fromEntries(
    ["provider", "baseUrl", "apiKeyEnv", "credentialSource", "credentialRef"]
      .filter((key) => own(value, key)).map((key) => [key, key === "credentialSource" ? legacySource(value[key], voice) : value[key]])
  );
  if (object(patch.aiProfiles)) {
    const activeId = patch.aiProfiles.activeId;
    if (activeId !== undefined) {
      const target = center.profiles.find((item) => item.id === activeId && item.kind === "chat");
      if (!target) fail("aiProfiles.activeId");
      center.bindings.chat = target.id;
    }
    if (Array.isArray(patch.aiProfiles.profiles)) {
      for (const item of patch.aiProfiles.profiles) {
        const profile = center.profiles.find((entry) => entry.id === item?.id && entry.kind === "chat");
        if (!profile) continue;
        for (const key of ["name", "model", "command", "args", "reasoningEffort", "timeoutMs"]) if (own(item, key)) profile[key] = copy(item[key]);
        syncConnection(profile, connectionFields(item));
      }
    }
  }
  const aiPatch = object(patch.ai) ? patch.ai : null;
  if (aiPatch) {
    const profile = profileFor("chat");
    for (const key of ["model", "command", "args", "reasoningEffort", "timeoutMs"]) if (own(aiPatch, key)) profile[key] = copy(aiPatch[key]);
    syncConnection(profile, connectionFields(aiPatch));
  }
  if (object(patch.vision)) {
    const profile = profileFor("vision");
    for (const key of ["model", "toolsets", "timeoutMs"]) if (own(patch.vision, key)) profile[key] = copy(patch.vision[key]);
    syncConnection(profile, connectionFields(patch.vision));
  }
  if (object(patch.voice)) {
    for (const kind of ["asr", "tts"]) {
      const profile = profileFor(kind);
      if (kind === "tts" && own(patch.voice.tts || {}, "model")) profile.model = patch.voice.tts.model;
      const slot = object(patch.voice[`${kind}Api`]) ? patch.voice[`${kind}Api`] : {};
      syncConnection(profile, connectionFields({ ...Object.fromEntries(["credentialSource", "apiKeyEnv", "baseUrl"].filter((key) => own(patch.voice, key)).map((key) => [key, patch.voice[key]])), ...slot }, true));
    }
  }
  if (object(patch.webSearch)) {
    const search = center.searchProfiles.find((item) => item.id === center.searchBinding);
    for (const key of ["provider", "providerOrder", "maxResults", "timeoutMs"]) if (own(patch.webSearch, key)) search[key] = copy(patch.webSearch[key]);
    if (object(patch.webSearch.proxy)) search.proxy = { ...search.proxy, ...copy(patch.webSearch.proxy) };
  }
  config.apiCenter = validateApiCenter(center, config);
  return config;
}
