import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { projectBehaviorSettings } from "../src/behavior-settings.js";
import { registryConfig } from "../src/account-registry.js";
import { normalizeAutomationRoutines } from "../src/legacy-automation.js";
import { normalizeAccountAutomation } from "../src/account-automation.js";
import { ensureCanonicalMemory } from "../src/memory-integrity.js";
import { searchArchiveRecords, archiveRecordText } from "../src/archive-search-index.js";
import { logicalBotId } from "../src/account-runtime.js";
import { redactText, sanitizeArchiveUrl, sanitizeArchiveValue } from "../src/privacy-filter.js";
import { groupMemoryValues } from "../src/memory-application.js";
import { botSelfSlot } from "../src/bot-capabilities.js";
import { ArchiveSearchService } from "../src/archive-search-service.js";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src/bridge.js"), "utf8");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-core-audit-"));
const archiveSearchService = new ArchiveSearchService();
function fn(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, name);
  const end = source.indexOf("\n}\n", match.index);
  return source.slice(match.index, end + 2);
}

try {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  config.behaviorModes.default = "lively";
  config.trigger.activeProbability = 0.25;
  config.trigger.activeCooldownMs = 60000;
  config.proactive.probability = 0.45;
  const before = JSON.stringify(config);
  const projected = projectBehaviorSettings(config, "lively");
  assert.equal(projected.trigger.activeProbability, 0.25);
  assert.equal(projected.trigger.activeCooldownMs, 60000);
  assert.equal(projected.proactive.probability, 0.45);
  assert.equal(projectBehaviorSettings(config, "normal").trigger.activeProbability, 0.12);
  config.trigger.activeProbability = 0;
  assert.equal(projectBehaviorSettings(config, "lively").trigger.activeProbability, 0);
  config.trigger.activeProbability = 0.25;
  assert.equal(JSON.stringify(config), before, "projections do not modify stored settings");

  const meta = { conversationId: "group:fixture", kind: "groups", id: "fixture",
    messagesPath: path.join(home, "messages.jsonl"), indexPath: path.join(home, "index.json"), summaryPath: path.join(home, "summary.json") };
  const sandbox = vm.createContext({ fs, path, Buffer, URL, URLSearchParams, archiveRecordText, ensureCanonicalMemory, logicalBotId,
    redactText, sanitizeArchiveUrl, sanitizeArchiveValue, groupMemoryValues, now: () => "2026-10-16T00:00:00Z", stateRoot: home,
    asArray: (x) => Array.isArray(x) ? x : [], asStringId: (x) => String(x ?? ""),
    clampText: (x, n) => String(x).slice(0, n), stringValue: (x) => String(x ?? ""),
    archiveConversationMetaFromEvent: () => meta, archiveEnabledForConversation: () => true,
    extractReplyMessageIds: () => ["123456789012345678"], updateArchiveIndex: () => {},
    groupMemory: () => ({ rollingSummary: "password:fixture-secret-1234", facts: ["password:fixture-secret-1234"], topics: [] }),
    warn: (text) => { throw Error(text); }
  });
  const functions = ["readJsonFileSafe", "writeJsonFileSafe", "redactSensitive", "archiveSafeUrl", "archiveSafeValue", "sanitizeUrlForLog", "messageTiming", "botDisplayName", "chatArchiveConfig", "appendJsonl", "archiveImageRecord", "summarizeArchiveIfNeeded", "archiveConversationEvent", "archiveBotReply", "archiveWebSearchResult"];
  vm.runInContext(functions.map(fn).join("\n"), sandbox);
  vm.runInContext(fn("ensureUserMemory"), sandbox);
  const portrait = { personality: Array.from({ length: 16 }, (_, i) => `portrait-${i}`),
    coreMemes: Array.from({ length: 20 }, (_, i) => `meme-${i}`),
    boundaries: Array.from({ length: 18 }, (_, i) => `boundary-${i}`),
    interactionTips: Array.from({ length: 18 }, (_, i) => `tip-${i}`),
    style: ["portrait-0"], memes: ["meme-0"], preferences: ["不喜欢：additional-boundary"], profile: ["相处建议：additional-tip"] };
  const group = { users: { "10001": portrait } };
  const arrays = Object.fromEntries(["personality", "coreMemes", "boundaries", "interactionTips"].map((key) => [key, [...portrait[key]]]));
  sandbox.ensureUserMemory(group, "10001", "fixture user");
  for (const [key, items] of Object.entries(arrays)) assert.deepEqual(portrait[key].slice(0, items.length), items, "startup compatibility must preserve existing legacy items and their order");
  const migrated = JSON.stringify(Object.fromEntries(Object.keys(arrays).map((key) => [key, portrait[key]])));
  sandbox.ensureUserMemory(group, "10001", "fixture user");
  assert.equal(JSON.stringify(Object.fromEntries(Object.keys(arrays).map((key) => [key, portrait[key]]))), migrated, "legacy mirrors are idempotent without truncating longer arrays");
  const sentinel = "password:fixture-secret-1234";
  const privacy = { memory: { privacyFilter: false }, chatArchive: { privacyFilter: true } };
  const event = { message_type: "group", group_id: "fixture", user_id: "10001", message_id: "123456789012345678", time: 100 };
  const record = sandbox.archiveConversationEvent({ event, config: privacy, memory: {}, text: sentinel, rawText: sentinel,
    replyContexts: [{ messageId: event.message_id, text: sentinel }],
    imageRefs: [{ index: 1 }], imageDescriptions: [{ index: 1, description: sentinel }] });
  assert(!JSON.stringify(record).includes("fixture-secret-1234"), "quotes and OCR obey archive privacy even when memory filter is off");
  assert.equal(record.messageId, event.message_id, "privacy preserves addressable message identities");
  assert.equal(record.quotedMessage.ids[0], event.message_id);
  assert.equal(record.sentAt, new Date(event.time * 1000).toISOString());
  const reply = sandbox.archiveBotReply({ event, config: privacy, memory: {}, text: sentinel });
  assert(!reply.text.includes("fixture-secret-1234"));
  const search = sandbox.archiveWebSearchResult({ event, config: privacy, memory: {}, decision: { query: sentinel },
    contextText: sentinel, usedConclusion: sentinel, searchResult: { results: [{ title: sentinel, snippet: sentinel, link: "https://example.test/?token=fixture-token" }] } });
  assert(!JSON.stringify(search).includes("fixture-secret-1234"));
  assert(!JSON.stringify(search).includes("fixture-token"));
  const url = sandbox.archiveSafeValue({ url: "https://example.test/path?phone=13800138000&code=246810&topic=history#otp=975310" }, privacy).url;
  for (const sensitive of ["13800138000", "246810", "975310"]) assert(!url.includes(sensitive), "URL parameters and fragments must obey archive privacy");
  assert.equal(new URL(url).searchParams.get("topic"), "history");
  const benignUrl = "https://example.test/?q=one&q=two#/docs?section=overview";
  assert.equal(sandbox.archiveSafeValue({ link: benignUrl }, privacy).link, benignUrl, "privacy does not damage benign repeated parameters or SPA fragments");
  const quotedUrl = sandbox.archiveSafeValue({ text: "见 https://example.test/?phone=%31%33%38%30%30%31%33%38%30%30%30&code=246810#otp=975310" }, privacy).text;
  for (const sensitive of ["13800138000", "%31%33%38", "246810", "975310"]) assert(!quotedUrl.includes(sensitive), "URLs embedded in quoted or derived text also require filtering");
  const unfiltered = sandbox.archiveConversationEvent({ event, config: { memory: { privacyFilter: false }, chatArchive: { privacyFilter: false } }, memory: {}, text: sentinel });
  assert.equal(unfiltered.text, sentinel, "explicit archive opt-out remains supported");
  fs.writeFileSync(meta.indexPath, JSON.stringify({ messageCount: 50 }));
  sandbox.summarizeArchiveIfNeeded(meta, {}, privacy);
  assert(!fs.readFileSync(meta.summaryPath, "utf8").includes("fixture-secret-1234"));

  // Exercise the real bridge retrieval, not only the index implementation.
  const oldTarget = { type: "user_message", text: "ZETA771 历史结论", messageId: "old-target", senderId: "10002", time: "2020-01-01T00:00:00Z" };
  const recentTarget = { ...oldTarget, text: "ZETA771 最近结论", messageId: "recent-target", time: "2026-01-01T00:00:00Z" };
  const mediaEvidence = [
    { ...oldTarget, text: "看图", messageId: "ocr-only", images: [{ description: "ZETA771 OCR独有证据" }] },
    { ...oldTarget, text: "接上次", messageId: "quote-only", quotedMessage: { contexts: [{ text: "ZETA771 引用独有证据" }] } },
    { ...oldTarget, text: "搜索完成", messageId: "source-only", sources: [{ title: "资料", snippet: "ZETA771 来源独有证据" }] }
  ];
  fs.writeFileSync(meta.messagesPath, [oldTarget, ...mediaEvidence, ...Array.from({ length: 1500 }, (_, i) => ({
    type: "user_message", text: `无关内容${i} ${"填充".repeat(500)}`, messageId: String(i), time: "2026-01-01T00:00:00Z"
  })), recentTarget].map((item) => JSON.stringify(item)).join("\n") + "\n");
  Object.assign(sandbox, { archiveSearchService: {
    // VM objects are a different realm; model the real serializable worker
    // boundary without weakening the service's strict input validation.
    context: (file, options) => archiveSearchService.context(file, structuredClone(options))
  }, relatedUserIdsFromText: () => [], archiveKeywords: () => ["ZETA771"] });
  vm.runInContext(["readLastJsonlRecords", "scoreArchiveRecord", "archiveEvidenceSnippet", "retrieveArchiveSnippets"].map(fn).join("\n"), sandbox);
  const snippets = await sandbox.retrieveArchiveSnippets({ event, current: { text: "上次 ZETA771 的结论", user_id: "10001" }, config: privacy, memory: {} });
  assert(snippets.some((item) => item.text.includes("历史结论")), "real bridge retrieves evidence beyond 1200 messages and 2MB");
  assert.equal(snippets.filter((item) => item.text.includes("最近结论")).length, 1, "index and recent scan do not duplicate evidence");
  for (const evidence of ["OCR独有证据", "引用独有证据", "来源独有证据"]) assert(snippets.some((item) => item.text.includes(evidence)), "derived evidence survives real bridge scoring, filtering and snippet output");

  const checkHome = path.join(home, "check-state");
  const runCheck = () => spawnSync(process.execPath, [path.join(root, "src/bridge.js"), "--check"], {
    env: { ...process.env, HERMES_QQ_HOME: checkHome, HERMES_QQ_RESOURCE_ROOT: root,
      HERMES_QQ_LOG_DIR: path.join(checkHome, "logs"), HERMES_HOME: path.join(home, "hermes") }, encoding: "utf8", timeout: 15000 });
  let result = runCheck();
  assert.equal(result.status, 0, result.stderr);
  assert(!fs.existsSync(checkHome), "checking a new install must not create state or copy config");
  fs.mkdirSync(path.join(checkHome, "data"), { recursive: true });
  const canonical = normalizeAccountAutomation(normalizeAutomationRoutines(registryConfig(config)));
  fs.writeFileSync(path.join(checkHome, "config.json"), JSON.stringify(canonical));
  const memoryPath = path.join(checkHome, "data/memory.json");
  const memory = JSON.stringify({ groups: { fixture: { users: { "10001": { profile: ["fixture fact"] } } } } });
  fs.writeFileSync(memoryPath, memory);
  const stat = fs.statSync(memoryPath);
  result = runCheck();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(memoryPath, "utf8"), memory);
  assert.equal(fs.statSync(memoryPath).mtimeMs, stat.mtimeMs);
  assert(!fs.existsSync(path.join(checkHome, "logs")));
  const identitySandbox = vm.createContext({ asStringId: value => String(value), asArray: value => Array.isArray(value) ? value : [],
    now: () => "2026-01-01T00:00:00Z", ensureCanonicalMemory });
  vm.runInContext(["groupMemory", "ensureUserMemory"].map(fn).join("\n"), identitySandbox);
  const unusual = { groups: {} };
  const unusualGroup = identitySandbox.groupMemory(unusual, "__proto__");
  const unusualUser = identitySandbox.ensureUserMemory(unusualGroup, "constructor", "fixture");
  assert.equal(Object.hasOwn(unusual.groups, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(unusual.groups), Object.prototype);
  assert.equal(Object.hasOwn(unusualGroup.users, "constructor"), true);
  assert.equal(unusualUser.names.length, 0);
  assert.equal(Object.prototype.canonicalMemory, undefined);
  identitySandbox.memoryRuntime = { value: unusual };
  vm.runInContext(["groupSettings", "ensureBotSelfMemory"].map(fn).join("\n"), identitySandbox);
  const publishedBeforeRead = JSON.stringify(unusual);
  assert.deepEqual(Object.keys(identitySandbox.groupMemory(unusual, "unseen").users), []);
  assert.throws(() => identitySandbox.groupSettings(unusual, "unseen", {}, { write: true }), { code: "MEMORY_TRANSACTION_REQUIRED" });
  identitySandbox.botSelfSlot = botSelfSlot;
  identitySandbox.botDisplayName = () => "fixture";
  identitySandbox.ensureBotSelfMemory(unusualGroup, {});
  assert.equal(JSON.stringify(unusual), publishedBeforeRead, "prompt/read compatibility defaults never mutate the live root");
  console.log(JSON.stringify({ ok: true, groups: ["effective-behavior", "additive-startup-memory-compatibility", "archive-privacy", "full-history-bridge-retrieval", "read-only-check"], fixtureOnly: true }));
} finally {
  await archiveSearchService.close();
  fs.rmSync(home, { recursive: true, force: true });
}
