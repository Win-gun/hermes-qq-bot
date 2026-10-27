#!/usr/bin/env node
// Read-only, offline UI contract tests. No bridge, browser, Electron, or user data.
// Complements console-assets-self-test.js (routes/packaging) and
// desktop-theme-self-test.js (main/preload); this executes the shared UI script.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("public/admin.html");
const css = read("public/console.css");
const themeSource = read("public/console-theme.js");
const key = "hermesqq.console.theme";
let assertions = 0;
const groups = [];
function check(description, fn) {
  try { fn(); assertions += 1; }
  catch (error) { throw new Error(description, { cause: error }); }
}
async function group(name, fn) {
  await fn();
  groups.push(name);
}

// Pre-visual-refactor beta.6 working-tree evidence, captured before extracting
// admin styles. This is intentionally fixed, never derived from the current UI.
// HEAD predates the account-registry work and uses automationRule.accountId;
// that work had already replaced it with automationRule.target in this baseline.
// Only DOM identifiers are retained here: no config, account IDs, or credentials.
const legacyBusinessIds = `
  sideStatus nav secondaryNav saveState lastRefresh
  pageTitle pageSubtitle pageActionState refreshBtn reloadConfigBtn
  saveBtn autoRefreshBtn page-overview statLogin statLoginHint
  statOnebot statOnebotHint statModel statModelHint statMemory
  statMemoryHint attentionPill attentionBox loginAssist loginQr
  loginAssistInfo overviewProtocolWebuiLink overviewNoVncLink overviewProbePrimaryBtn overviewRestartProtocolBtn
  overviewRefreshQrBtn overviewRebuildNapcatBtn capabilityPills scopeText behaviorText
  recentLog page-account-status accountStatusMount page-account-functions accountFunctionsMount
  page-api-center apiCenterState apiCapabilityCards apiConnectionEditor apiConnectionSelect
  apiConnectionName apiConnectionProvider apiConnectionUrl apiConnectionSource apiConnectionEnv
  apiConnectionStatus apiConnectionNew apiConnectionDelete apiConnectionSave apiKeyEditor
  apiKeyInput apiKeySave apiKeyDelete apiProfileEditor apiProfileSelect
  apiProfileName apiProfileKind apiProfileConnection apiProfileModel apiVoiceModels
  apiProfileReasoning apiProfileTimeout apiProfileNew apiProfileDelete apiProfileSave
  apiBindingsEditor apiBindingRows apiBindingsSave apiSearchEditor apiSearchSelect
  apiSearchName apiSearchProvider apiSearchLegacyFields apiSearchOrder apiSearchMimoConnectionField
  apiSearchMimoConnection apiSearchMimoModelField apiSearchMimoModel apiSearchMimoKeywordField apiSearchMimoKeyword
  apiSearchMimoForceField apiSearchMimoForce apiSearchLimit apiSearchTimeout apiSearchMimoNote
  apiSearchNew apiSearchDelete apiSearchSave apiSearchAdvancedDetails apiSearchAdvanced
  apiTestResult legacyApiFields page-qa qaModelSummary promptAccountPicker
  promptAccountSelect qa-model qa-persona qa-behavior qa-search
  page-vision visionModelSummary visionMount page-accounts accountFeaturesCard
  accounts.topology accountTopologyHint accountScenarioPreview botFeatures.defaultMode accountModeFields
  editAccountStylesBtn accountFunctionsFeedback accountConnectionGrid accountStatusCard peerPingTopBtn
  refreshAccountsTopBtn accountCards accountConnectionCard accounts.primary.qq accounts.primary.enabled
  accounts.primary.protocol accounts.primary.napcatContainer accounts.primary.onebotPath accounts.primary.protocolContainer accounts.primary.webuiPort
  accounts.primary.noVncPort accounts.primary.vncPort accounts.primary.onebotWsUrl accounts.primary.snowlumaImage accounts.standbys.0.qq
  accounts.standbys.0.protocol accounts.standbys.0.napcatContainer accounts.standbys.0.protocolContainer accounts.standbys.0.webuiPort accounts.standbys.0.noVncPort
  accounts.standbys.0.vncPort accounts.standbys.0.onebotWsUrl accounts.standbys.0.snowlumaImage accounts.standbys.0.onebotPath accounts.standbys.0.behaviorMode
  accounts.standbys.0.enabled failoverSettings accounts.failover.enabled accounts.failover.switchBackWhenPrimaryHealthy accounts.failover.switchAfterMs
  saveAccountsBtn refreshAccountsBtn peerPingBtn interBotCard botFeatures.interBot.enabled
  botFeatures.interBot.probability botFeatures.interBot.cooldownMs learningModeCard learningMode.enabled learningMode.groupIds
  learningMode.minIntervalMs learningMode.maxQuestionsPerDay page-quick testAiBtn testSearchBtn
  activeProtocolText activeProtocolLink activeNoVncAction activeNoVncLink restartBridgeBtn
  restartActiveProtocolHint restartActiveProtocolBtn legacyNapcatTools legacyRefreshQrBtn legacyRebuildNapcatBtn
  send.groupId send.groupSelect send.message sendBtn clearOpsBtn
  opsResult page-model aiProfileSelect aiProfileActiveState activateAiProfileBtn
  newAiProfileBtn duplicateAiProfileBtn deleteAiProfileBtn ai.profileName modelPreset
  ai.command ai.timeoutMs ai.provider ai.model ai.baseUrl
  ai.apiKeyEnv ai.reasoningEffort ai.args saveModelBtn testAiBtn2
  aiTest page-behavior presetRestrained presetNormal presetLively
  behaviorModes.default trigger.activeCooldownMs proactive.intervalMs proactive.cooldownMs proactive.enabled
  trigger.activeProbability.slider trigger.activeProbability proactive.probability.slider proactive.probability socialPlanner.enabled
  socialPlanner.shadowMode socialPlanner.minConfidence socialPlanner.timeoutMs socialPlannerRecent page-tools
  searchSettingsCard webSearch.enabled webSearch.provider webSearch.maxResults webSearch.timeoutMs
  webSearch.providerOrder webSearch.proxy.urls saveSearchBtn testSearchBtn2 visionSettingsCard
  vision.enabled vision.onlyWhenMentionedOrAsked vision.aiJudge.enabled vision.includeQuotedImages vision.includeImageEmojis
  vision.aggressiveFollowup vision.contextAssist vision.describeWhenUncertain vision.provider vision.model
  vision.toolsets vision.maxQuotedMessages vision.followupWindowMs vision.followupMaxMessagesAfterBot vision.contextAssistWindowMs
  vision.contextAssistRecentMessages vision.contextAssistMaxMessagesAfterBot vision.contextAssistShortTextMaxLength vision.aiJudge.minConfidence vision.aiJudge.uncertainMaxConfidence
  vision.aiJudge.timeoutMs vision.aiJudge.fallback vision.maxImagesPerMessage vision.maxImageBytes vision.maxHermesImageBytes
  vision.resizeMaxPixels vision.jpegQuality vision.downloadTimeoutMs vision.timeoutMs vision.prompt
  saveVisionBtn page-prompt promptAccountState prompt.system savePromptBtn
  resetAccountPromptBtn copyPromptBtn styleProfileSelect styleProfiles.name styleProfiles.systemPrompt
  styleProfileState newStyleProfileBtn duplicateStyleProfileBtn deleteStyleProfileBtn activateStyleProfileBtn
  accounts.primary.styleProfileId accounts.standbys.0.styleProfileId saveStyleProfilesBtn page-memory memoryCount
  memorySearch groupList exportMemoryBtn selectedGroupPill memorySummaryBox
  memoryDetailSearch memoryView page-archive archiveStatusPill chatArchive.enabled
  chatArchive.defaultOn chatArchive.saveImages messageDebounce.enabled responseQueue.liveContext.enabled chatArchive.baseDir
  chatArchive.maxRetrieveItems chatArchive.summary.everyMessages messageDebounce.baseWaitMs messageDebounce.minWaitMs messageDebounce.maxWaitMs
  messageDebounce.sameUserExtendMs messageDebounce.maxBufferedMessages messageDebounce.maxBufferedChars responseQueue.liveContext.windowMs responseQueue.liveContext.settleMs
  responseQueue.liveContext.maxRegenerations responseQueue.liveContext.maxMergedMessages saveArchiveBtn refreshArchiveBtn clearArchiveBtn
  archiveStatusView archiveCount archiveSearch archiveList page-tasks
  taskModePill taskMode.enabled taskMode.shadowMode taskMode.ownerUserIds taskMode.allowedGroupIds
  taskMode.webResearchEnabled taskMode.allowedWebDomains taskMode.maxConcurrentGlobal taskMode.maxConcurrentPerConversation taskMode.progressHeartbeatMs
  taskMode.intentJudge.minConfidence taskMode.maxRuntimeMs taskMode.maxTurns saveTaskBtn refreshTasksBtn
  taskCount taskRuntimeSummary taskList taskArtifactPanel taskArtifactTitle
  closeTaskArtifactsBtn taskArtifactList taskArtifactPreview page-automation automationCount
  automation.enabled automationRuleList newAutomationRuleBtn saveAutomationBtn automationEditorState
  automationEditorEmpty automationEditor automationRule.enabled automationRule.id automationRule.action
  automationRule.triggerType automationRule.target automationRule.scope automationRule.timezone automationRule.time
  automationRule.windowMinutes automationDays automationRule.command automationRule.prompt automationEditorError
  applyAutomationRuleBtn deleteAutomationRuleBtn page-voice voiceLoadState voiceModelSummary
  voice-api-panel voice.credentialSource voice.apiKeyEnv voice.tts.model voiceSecretInput
  voiceSecretState setVoiceSecretBtn deleteVoiceSecretBtn testVoiceApiBtn voiceApiTestResult
  voice.timeoutMs voice.maxInputBytes voice.maxOutputBytes saveVoiceApiBtn voice-behavior-panel
  voice.enabled voice.replyMode voice.asr.enabled voice.asr.autoTranscribe voice.tts.enabled
  voice.aiJudge.enabled voice.tts.voice voiceAllowedVoices voiceAllowedState voice.voiceDesign.enabled
  voice.tts.voiceDescription voice.tts.allowMemberVoiceDesign voice.voiceClone.enabled voiceCloneState voiceConfigError
  saveVoiceBtn page-reviewer reviewerPill reviewer.enabled reviewer.shadowMode
  reviewer.mode reviewer.reasoningEffort reviewer.provider reviewer.model reviewer.timeoutMs
  reviewer.minLength saveReviewerBtn refreshReviewerBtn reviewerMetrics memoryIntegrityCard
  memoryIntegrityPill memory.integrity.enabled memory.integrity.requireEvidence memory.integrity.minStableConfidence memory.integrity.promptMinConfidence
  memory.integrity.maxEntriesPerUser memory.integrity.maxConflictsPerUser saveIntegrityBtn memoryDryRunBtn memoryApplyBtn
  memoryIntegrityView page-backup backupBrowserNotice desktopAppState desktopAppHint
  desktopDataState desktopDataPath desktopBackupState desktopBackupPath createSafeBackupBtn
  createFullBackupBtn backupPassword backupIncludeLogs chooseBackupDestinationBtn backupDestinationLabel
  backupProgressPanel backupProgressTitle cancelBackupBtn backupProgressBar backupProgressDetail
  chooseBackupFileBtn restoreFileLabel webBackupFileInput inspectBackupBtn restoreBackupBtn
  backupInspectView webLegacyPathField webLegacyProjectPath selectLegacyProjectBtn migrateLegacyProjectBtn
  legacyProjectInfo refreshBackupsBtn localBackupList desktopStartBtn desktopStopBtn
  desktopRestartBtn desktopAutoStart desktopStatusView page-logs showMainLog
  showErrorLog copyLogBtn logView toastWrap
`.trim().split(/\s+/);

const navigation = [
  ["overview", "总览"],
  ["account-status", "账号状态"],
  ["account-functions", "账号功能"],
  ["api-center", "API 管理"],
  ["qa", "问答"],
  ["vision", "识图"],
  ["voice", "语音"],
  ["tasks", "任务 / Agent"],
  ["automation", "自动化"],
  ["memory", "记忆"],
  ["archive", "聊天存档"],
  ["backup", "备份与迁移"],
  ["logs", "日志"],
  ["reviewer", "高级诊断"]
];
const stripTags = (value) => value.replace(/<[^>]*>/g, "").trim();

await group("source-contracts", () => {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const ids = [...markup.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  check("fixed beta6 baseline has 464 unique IDs", () => {
    assert.equal(legacyBusinessIds.length, 464);
    assert.equal(new Set(legacyBusinessIds).size, 464);
  });
  check("all original business IDs remain present", () => {
    assert.deepEqual(legacyBusinessIds.filter((id) => !ids.includes(id)), []);
  });
  check("markup contains no duplicate IDs", () => assert.equal(ids.length, new Set(ids).size));
  const nav = markup.match(/<nav\b[^>]*\bid="nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  check("main navigation exists", () => assert.ok(nav));
  const buttons = [...nav.matchAll(/<button\b[^>]*data-page="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((match) => [match[1], stripTags(match[2])]);
  check("navigation labels and ordering are exact", () => assert.deepEqual(buttons, navigation));
  const labels = [...nav.matchAll(/<div\b[^>]*class="nav-label"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => stripTags(match[1]));
  check("navigation group labels are exact", () => assert.deepEqual(labels, ["核心管理", "任务与自动化"]));
  const secondary = nav.match(/<details\b[^>]*\bid="secondaryNav"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  check("data and system group stays nested", () => {
    assert.ok(secondary);
    assert.equal(stripTags(secondary.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ""), "数据与系统");
    assert.deepEqual([...secondary.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]), navigation.slice(9).map(([id]) => id));
    assert(nav.indexOf("核心管理") < nav.indexOf('data-page="account-status"'));
    assert(nav.indexOf("任务与自动化") > nav.indexOf('data-page="voice"'));
    assert(nav.indexOf("任务与自动化") < nav.indexOf('data-page="tasks"'));
  });
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  check("admin includes an executable inline business script", () => assert(scripts.some(([, attrs, body]) => !/\bsrc=/.test(attrs) && body.trim())));
  for (const [index, [, attrs, body]] of scripts.entries()) {
    if (!/\bsrc=/.test(attrs)) check(`admin script ${index} parses without executing business code`, () => new vm.Script(body, { filename: `admin-inline-${index}.js` }));
  }
  check("shared theme script parses", () => new vm.Script(themeSource, { filename: "console-theme.js" }));
  check("no inline onclick handlers, including dynamic templates", () => assert.doesNotMatch(html, /\bonclick\s*=/i));
  check("shared resources exist and theme loads before body", () => {
    assert.match(html, /<link\b[^>]*href="\/console\.css"/);
    assert.match(html, /<script\b[^>]*src="\/console-theme\.js"/);
    assert(html.indexOf('src="/console-theme.js"') < html.indexOf("<body"));
    assert(css.trim() && themeSource.trim());
  });
  check("no external script or stylesheet dependencies", () => {
    assert.doesNotMatch(html, /<script\b[^>]*src=["'](?:https?:)?\/\//i);
    assert.doesNotMatch(html, /<link\b[^>]*href=["'](?:https?:)?\/\//i);
    assert.doesNotMatch(css, /@import|url\(\s*["']?(?:https?:)?\/\//i);
  });
  check("theme selection cannot dirty business configuration", () => assert.match(html, /el\.matches\("\[data-console-theme\]"\)\) continue/));
  check("styles are extracted and avoid decorative effects", () => {
    assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i);
    assert.doesNotMatch(css, /(?:radial|linear)-gradient|translateY\(-1px\)/i);
  });
  check("wide sidebar uses 224px", () => assert.match(css, /--sidebar-width:\s*224px/));
  check("compact breakpoint preserves a 176px labelled sidebar", () => {
    assert.match(css, /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1099px\)/);
    assert.match(css, /--sidebar-width:\s*176px/);
  });
  check("mobile breakpoint switches to header and drawer", () => {
    assert.match(css, /@media\s*\(max-width:\s*767px\)/);
    assert.match(css, /\.sidebar\.drawer-open\s*\{\s*display:\s*flex/);
    for (const id of ["consoleMobileHeader", "consoleMenuButton", "consoleSidebar", "consoleMenuClose", "consoleDrawerBackdrop"]) assert(ids.includes(id));
    assert.match(themeSource, /event\.key === "Escape"/);
    assert.match(themeSource, /event\.key !== "Tab"/);
    assert.match(themeSource, /main\.inert = true/);
  });
  check("keyboard focus and reduced motion have explicit styles", () => {
    assert.match(css, /:focus-visible/);
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1];
    assert.ok(reduced);
    assert.match(reduced, /transition:\s*none\s*!important/);
    assert.match(reduced, /animation:\s*none\s*!important/);
    assert.match(reduced, /scroll-behavior:\s*auto\s*!important/);
  });
  check("overview raw logs are collapsed by default", () => {
    const details = markup.match(/<details\b([^>]*class="[^"]*overview-events[^"]*"[^>]*)>([\s\S]*?)<\/details>/);
    assert.ok(details);
    assert.doesNotMatch(details[1], /\bopen(?:\s|=|$)/);
    assert.match(details[2], /id="recentLog"/);
  });
});

// Deliberately minimal DOM: enough for theme initialization and deferred selector
// binding. Only selected business functions execute below, with isolated mocks;
// the full admin script/bootstrap is never evaluated. Drawer rendering,
// geometry, focus layout and real Electron IPC remain the parent's render tests.
class MockEvents {
  listeners = new Map();
  addEventListener(type, callback, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }
  async dispatch(type, fields = {}) {
    const listeners = [...(this.listeners.get(type) || [])];
    const results = [];
    for (const listener of listeners) {
      if (listener.once) this.listeners.set(type, this.listeners.get(type).filter((entry) => entry !== listener));
      results.push(listener.callback({ type, target: this, ...fields }));
    }
    await Promise.all(results);
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function runtime({ saved, osDark = false, getFailure = false, setFailure = false, storageFailure = false, desktop, legacyMedia = false, mediaFailure = false } = {}) {
  const observers = [];
  const values = new Map(saved === undefined ? [] : [[key, saved]]);
  const writes = [];
  const rootNode = { style: {}, dataset: null };
  let elementsReady = false;
  rootNode.dataset = new Proxy({}, { set(target, property, value) {
    const changed = target[property] !== value;
    target[property] = value;
    if (changed) for (const observer of observers) {
      const attribute = `data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      if (observer.node === rootNode && observer.options?.attributes && (!observer.options.attributeFilter || observer.options.attributeFilter.includes(attribute))) {
        queueMicrotask(() => observer.callback([{ type: "attributes", target: rootNode, attributeName: attribute }]));
      }
    }
    return true;
  } });
  class MockMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node, options) { this.node = node; this.options = options; }
  }
  const selectors = [new MockEvents(), new MockEvents()];
  selectors.forEach((select) => { select.value = ""; });
  const feedback = { textContent: "" };
  const document = new MockEvents();
  document.documentElement = rootNode;
  document.readyState = "loading";
  document.querySelectorAll = (query) => query === "[data-console-theme]" && elementsReady ? selectors : [];
  document.getElementById = (id) => elementsReady && id === "consoleThemeState" ? feedback : null;
  const window = new MockEvents();
  const storage = {
    getItem(name) { if (getFailure) throw new Error("storage read denied"); return values.get(name) ?? null; },
    setItem(name, value) { if (setFailure) throw new Error("storage write denied"); values.set(name, value); writes.push([name, value]); }
  };
  Object.defineProperty(window, "localStorage", { get() { if (storageFailure) throw new Error("storage unavailable"); return storage; } });
  const media = new MockEvents();
  media.matches = osDark;
  if (legacyMedia) {
    media.addListener = (callback) => MockEvents.prototype.addEventListener.call(media, "change", callback);
    media.addEventListener = undefined;
  }
  window.matchMedia = (query) => {
    assert.equal(query, "(prefers-color-scheme: dark)");
    if (mediaFailure) throw new Error("matchMedia unavailable");
    return media;
  };
  if (desktop) window.hermesQQ = desktop;
  const context = vm.createContext({ window, document, MutationObserver: MockMutationObserver }, {
    codeGeneration: { strings: false, wasm: false }
  });
  new vm.Script(themeSource, { filename: "console-theme.js" }).runInContext(context, { timeout: 1000 });
  return {
    root: rootNode, selectors, feedback, values, writes,
    async ready() { elementsReady = true; document.readyState = "interactive"; await document.dispatch("DOMContentLoaded"); await settle(); },
    async choose(value, index = 0) { selectors[index].value = value; await selectors[index].dispatch("change"); await settle(); },
    async mediaChange(dark) { media.matches = dark; await media.dispatch("change", { matches: dark }); await settle(); },
    async storageChange(value, eventKey = key) {
      if (value === undefined) values.delete(key); else values.set(key, value);
      await window.dispatch("storage", { key: eventKey, newValue: value ?? null }); await settle();
    },
    async nativeChange(theme, resolvedTheme) { rootNode.dataset.theme = resolvedTheme; rootNode.dataset.themePreference = theme; await settle(); }
  };
}

function expectTheme(test, preference, actual, description) {
  check(description, () => {
    assert.equal(test.root.dataset.themePreference, preference);
    assert.equal(test.root.dataset.theme, actual);
    assert.equal(test.root.style.colorScheme, actual);
    assert.deepEqual(test.selectors.map((select) => select.value), [preference, preference]);
  });
}

await group("default-and-three-themes", async () => {
  const initial = runtime({ osDark: false });
  check("default is dark before DOMContentLoaded, even on a light OS", () => {
    assert.equal(initial.root.dataset.theme, "dark");
    assert.equal(initial.root.style.colorScheme, "dark");
    assert(initial.selectors.every((select) => select.listeners.size === 0));
  });
  await initial.ready();
  expectTheme(initial, "dark", "dark", "deferred DOM binding synchronizes both selectors");
  for (const preference of ["dark", "light", "system"]) {
    for (const osDark of [false, true]) {
      const test = runtime({ saved: preference, osDark }); await test.ready();
      expectTheme(test, preference, preference === "system" ? osDark ? "dark" : "light" : preference, `saved ${preference} / OS dark ${osDark}`);
    }
  }
  for (const invalid of ["", "auto", "Dark", " light", "system ", "null"]) {
    const test = runtime({ saved: invalid }); await test.ready();
    expectTheme(test, "dark", "dark", `invalid stored preference ${JSON.stringify(invalid)} falls back`);
  }
  await initial.choose("light"); expectTheme(initial, "light", "light", "sidebar selects light");
  await initial.choose("system", 1); expectTheme(initial, "system", "light", "header selects system");
  await initial.choose("dark"); expectTheme(initial, "dark", "dark", "selects dark again");
  check("only the scoped theme key is persisted", () => {
    assert(initial.writes.length > 0);
    assert(initial.writes.every(([name, value]) => name === key && ["dark", "light", "system"].includes(value)));
    assert.equal(initial.values.get(key), "dark");
  });
});

await group("storage-and-system-events", async () => {
  for (const options of [{ getFailure: true }, { setFailure: true }, { storageFailure: true }, { getFailure: true, setFailure: true }]) {
    const test = runtime(options); await test.ready();
    expectTheme(test, "dark", "dark", `storage failure default ${JSON.stringify(options)}`);
    await test.choose("light"); expectTheme(test, "light", "light", `storage failure selection ${JSON.stringify(options)}`);
  }
  const test = runtime(); await test.ready();
  await test.storageChange("light"); expectTheme(test, "light", "light", "cross-window storage update");
  await test.storageChange("dark", "unrelated.preference"); expectTheme(test, "light", "light", "unrelated storage event ignored");
  await test.storageChange(undefined); expectTheme(test, "dark", "dark", "theme key removal resets dark");
  await test.choose("light"); await test.storageChange(undefined, null); expectTheme(test, "dark", "dark", "storage clear resets dark");
  await test.storageChange("invalid"); expectTheme(test, "dark", "dark", "invalid cross-window value defaults dark");
  for (const legacyMedia of [false, true]) {
    const system = runtime({ saved: "system", legacyMedia }); await system.ready();
    await system.mediaChange(true); expectTheme(system, "system", "dark", `system turns dark / legacy listener ${legacyMedia}`);
    await system.mediaChange(false); expectTheme(system, "system", "light", `system turns light / legacy listener ${legacyMedia}`);
    await system.choose("dark"); await system.mediaChange(false); expectTheme(system, "dark", "dark", "explicit dark ignores OS updates");
    await system.choose("light"); await system.mediaChange(true); expectTheme(system, "light", "light", "explicit light ignores OS updates");
  }
  const noMedia = runtime({ mediaFailure: true }); await noMedia.ready();
  expectTheme(noMedia, "dark", "dark", "missing matchMedia does not break default paint");
});

await group("desktop-snapshot-and-failures", async () => {
  for (const snapshot of [null, {}, { theme: "invalid", resolvedTheme: "light" }, { ok: false, theme: "dark", resolvedTheme: "dark" }, { theme: "dark" }]) {
    const test = runtime({ saved: "light", desktop: { getTheme: () => snapshot } }); await test.ready();
    expectTheme(test, "light", "light", "invalid native snapshot keeps local preference");
  }
  const readFailure = runtime({ saved: "light", desktop: { getTheme() { throw new Error("IPC unavailable"); } } });
  await readFailure.ready(); expectTheme(readFailure, "light", "light", "getTheme throwing uses local fallback");
  const calls = [];
  let state = { ok: true, theme: "system", resolvedTheme: "light" };
  let getCalls = 0;
  const desktop = runtime({ saved: "dark", osDark: true, desktop: {
    getTheme() { getCalls += 1; return state; },
    async setTheme(theme) { calls.push(theme); return { ok: true, theme, resolvedTheme: theme === "system" ? "light" : theme }; }
  } });
  check("desktop getTheme snapshot is synchronous and read before DOM ready", () => {
    assert.equal(getCalls, 1); assert.equal(desktop.root.dataset.theme, "light");
  });
  await desktop.ready(); expectTheme(desktop, "system", "light", "native resolvedTheme overrides browser media snapshot");
  for (const theme of ["dark", "light", "system"]) {
    await desktop.choose(theme);
    expectTheme(desktop, theme, theme === "system" ? "light" : theme, `desktop setTheme ${theme}`);
  }
  check("desktop setTheme receives only enum strings", () => assert.deepEqual(calls, ["dark", "light", "system"]));
  state = { ok: true, theme: "system", resolvedTheme: "dark" };
  await desktop.mediaChange(false); expectTheme(desktop, "system", "dark", "system change refreshes native resolvedTheme");
  const beforeNative = calls.length;
  state = { ok: true, theme: "light", resolvedTheme: "light" };
  await desktop.nativeChange("light", "light"); expectTheme(desktop, "light", "light", "preload native event synchronizes selectors");
  check("native event does not echo IPC", () => assert.equal(calls.length, beforeNative));
  for (const sync of [true, false]) {
    const failed = runtime({ desktop: {
      getTheme: () => ({ ok: true, theme: "dark", resolvedTheme: "dark" }),
      setTheme() { if (sync) throw new Error("IPC rejected"); return Promise.reject(new Error("IPC rejected")); }
    } });
    await failed.ready(); await failed.choose("light");
    expectTheme(failed, "dark", "dark", `desktop setTheme ${sync ? "throws" : "rejects"}: rollback`);
    check("failed native save restores storage and visible feedback", () => {
      assert.equal(failed.values.get(key), "dark"); assert.match(failed.feedback.textContent, /保存失败/);
    });
  }
  const systemFallback = runtime({ saved: "system", desktop: { getTheme() { throw new Error("IPC unavailable"); } } });
  await systemFallback.ready(); await systemFallback.mediaChange(true);
  expectTheme(systemFallback, "system", "dark", "getTheme failure during system event uses media fallback");
  const pending = [];
  const racing = runtime({ desktop: {
    getTheme: () => ({ ok: true, theme: "dark", resolvedTheme: "dark" }),
    setTheme: (theme) => new Promise((resolve) => pending.push({ theme, resolve }))
  } });
  await racing.ready();
  const first = racing.choose("light"); const second = racing.choose("dark");
  pending[1].resolve({ ok: true, theme: "dark", resolvedTheme: "dark" }); await second;
  pending[0].resolve({ ok: true, theme: "light", resolvedTheme: "light" }); await first;
  expectTheme(racing, "dark", "dark", "stale native response cannot overwrite latest selection");
});

await group("overlapping-native-theme-failures", async () => {
  for (const completionOrder of [[0, 1], [1, 0]]) {
    const pending = [];
    const test = runtime({ desktop: {
      getTheme: () => ({ ok: true, theme: "dark", resolvedTheme: "dark" }),
      setTheme: (theme) => new Promise((resolve, reject) => pending.push({ theme, resolve, reject }))
    } });
    await test.ready();
    const requests = [test.choose("light"), test.choose("system")];
    await settle(); // Flush observers of our optimistic writes while IPC is pending.
    expectTheme(test, "system", "light", "optimistic system remains pending, not confirmed by observer");
    for (const index of completionOrder) {
      pending[index].reject(new Error("IPC unavailable")); await requests[index];
    }
    expectTheme(test, "dark", "dark", `two IPC failures roll back to confirmed dark (${completionOrder})`);
    check("failed optimistic themes never persist as final native state", () => assert.equal(test.values.get(key), "dark"));
  }
  const pending = [];
  let nativeState = { ok: true, theme: "dark", resolvedTheme: "dark" };
  const test = runtime({ desktop: {
    getTheme: () => nativeState,
    setTheme: (theme) => new Promise((resolve, reject) => pending.push({ theme, resolve, reject }))
  } });
  await test.ready();
  const light = test.choose("light"); const system = test.choose("system");
  nativeState = { ok: true, theme: "light", resolvedTheme: "light" };
  await test.nativeChange("light", "light"); // Preload writes before its IPC promise settles.
  expectTheme(test, "system", "light", "older preload acknowledgement does not invalidate newer intent");
  pending[0].resolve(nativeState); await light;
  pending[1].reject(new Error("IPC unavailable")); await system;
  expectTheme(test, "light", "light", "latest failure falls back to earlier acknowledged success");
  const third = test.choose("dark");
  pending[2].reject(new Error("IPC unavailable")); await third;
  expectTheme(test, "light", "light", "subsequent failure retains last confirmed light");
  for (const response of [null, {}, { ok: false, theme: "light", resolvedTheme: "light" }]) {
    const invalid = runtime({ desktop: {
      getTheme: () => ({ ok: true, theme: "dark", resolvedTheme: "dark" }),
      setTheme: async () => response
    } });
    await invalid.ready(); await invalid.choose("light");
    expectTheme(invalid, "dark", "dark", "invalid/failed native response cannot confirm optimistic light");
  }
  for (const olderSucceeds of [false, true]) {
    const pending = [];
    let snapshot = { ok: true, theme: "dark", resolvedTheme: "dark" };
    const latest = runtime({ desktop: {
      getTheme: () => snapshot,
      setTheme: (theme) => new Promise((resolve, reject) => pending.push({ theme, resolve, reject }))
    } });
    await latest.ready();
    const old = latest.choose("light"), newer = latest.choose("system");
    snapshot = { ok: true, theme: "system", resolvedTheme: "dark" };
    await latest.nativeChange("system", "dark");
    pending[1].resolve(snapshot); await newer;
    if (olderSucceeds) {
      await latest.nativeChange("light", "light");
      pending[0].resolve({ ok: true, theme: "light", resolvedTheme: "light" });
    } else pending[0].reject(new Error("stale failure"));
    await old;
    expectTheme(latest, "system", "dark", `older ${olderSucceeds ? "preload/success" : "failure"} cannot replace newer confirmed system`);
    // Idle native events must use the synchronous native snapshot, not stale
    // attributes left by preload or an optimistic selector change.
    await latest.nativeChange("light", "light");
    expectTheme(latest, "system", "dark", "observer reconciles stale attributes with authoritative native snapshot");
  }
  let systemSnapshot = { ok: true, theme: "system", resolvedTheme: "light" };
  const systemConfirmed = runtime({ desktop: {
    getTheme: () => systemSnapshot,
    setTheme: async () => { throw new Error("IPC unavailable"); }
  } });
  await systemConfirmed.ready();
  systemSnapshot = { ok: true, theme: "system", resolvedTheme: "dark" };
  await systemConfirmed.mediaChange(true); await systemConfirmed.choose("light");
  expectTheme(systemConfirmed, "system", "dark", "failed selection retains last confirmed system resolution after OS change");
});

// Extract exact top-level functions from the inline source; no copied versions
// of the algorithms, API traffic, timers, or admin startup in these regressions.
const businessScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).find((body) => body.includes("function refreshApiCenter("));
function adminFunction(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, "m").exec(businessScript);
  assert.ok(start, `missing admin function ${name}`);
  const rest = businessScript.slice(start.index + start[0].length);
  const next = /^    }\s*$/m.exec(rest);
  assert.ok(next, `missing function closing brace ${name}`);
  const end = start.index + start[0].length + next.index + next[0].trimEnd().length;
  return businessScript.slice(start.index, end);
}
const plain = (value) => JSON.parse(JSON.stringify(value));

// Execute the real global save/refresh/form-fill path with an in-memory HTTP
// server. Deferred responses reproduce typing and cross-pane races without a
// bridge, filesystem writes, credentials, or QQ traffic.
function configUiRuntime() {
  const nodes = new Map(), pending = [], reads = [], feedback = [];
  const initial = {
    revision: "r1", accounts: { version: 2, items: [{ id: "a" }, { id: "b" }],
      primary: { id: "a" }, standbys: [{ id: "b", behaviorMode: "lively" }, { id: "c", behaviorMode: "restrained" }] },
    behaviorModes: { default: "normal" }, trigger: { activeProbability: 0.12, activeCooldownMs: 120000 },
    proactive: { enabled: true, probability: 0.25, intervalMs: 300000, cooldownMs: 900000 },
    learningMode: { enabled: true, groupIds: [], minIntervalMs: 1800000, maxQuestionsPerDay: 3 },
    voice: { enabled: false, tts: { model: "mimo-v2.5-tts", voice: "mimo_default", allowedVoices: ["mimo_default"] } },
    taskMode: { maxTurns: 10 }, chatArchive: { baseDir: "data/offline-archive", enabled: true }
  };
  const scopeOf = (id) => {
    if (/^(behaviorModes|trigger|proactive|socialPlanner|messageDebounce|responseQueue|learningMode)\./.test(id) || id === "webSearch.enabled") return "qa:behavior";
    if (id.startsWith("taskMode.")) return "tasks";
    if (id.startsWith("chatArchive.")) return "archive";
    if (id.startsWith("vision.")) return "vision";
    if (id.startsWith("voice.")) return "voice:behavior";
    if (/^(prompt|styleProfiles)\./.test(id)) return "qa:persona";
    if (id.startsWith("ai.")) return "qa:model";
    if (id.startsWith("webSearch.")) return "qa:search";
    return "account-status";
  };
  const node = (id = "", type = "text") => ({
    id, type, value: "", checked: false, disabled: false, dataset: {}, options: [], textContent: "",
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {},
    querySelector: () => null,
    appendChild(option) { this.options.push(option); },
    closest(selector) {
      const scope = scopeOf(id);
      if (selector === "[data-tab-panel]" && scope.includes(":")) return { dataset: { tabPanel: scope } };
      if (selector === ".page") return { id: `page-${scope}` };
      return null;
    }
  });
  for (const match of html.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    if (id) nodes.set(id, node(id, match[1].match(/\btype="([^"]+)"/)?.[1] || "text"));
  }
  const state = {
    structuredClone, Headers, cfg: structuredClone(initial), server: structuredClone(initial),
    activePage: "tasks", activeTabs: { qa: "behavior", voice: "behavior" }, dirty: false,
    dirtyScopes: new Set(), conflictedScopes: new Set(), scopeFeedback: new Map(),
    scopeEditVersions: new Map(), savingConfigScopes: new Set(), preservingDirtyFields: false,
    promptDrafts: new Map(), routineState: { dirty: false }, automationAccounts: { drafts: new Map() },
    apiCenterDirty: false, apiCenterConflicted: false, apiCenterSaved: {},
    registryState: { items: structuredClone(initial.accounts.items), groups: [], drafts: new Map(),
      operations: new Map(), contexts: {}, selected: "a", epoch: 0, revision: "r1", modelLoadedAt: 0 },
    VOICE_PRESET_IDS: ["mimo_default"],
    $: (id) => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    document: { querySelectorAll: () => [], createElement: () => node() },
    confirm: () => true, setBusy() {}, toast: (message) => feedback.push(message),
    ensureAdminSession: async () => "offline-session", sensitiveApi: async () => ({ center: {} }),
    registryItem: (id) => state.registryState.items.find((item) => item.id === (id || state.registryState.selected)),
    rebaseRegistryDraft() {}, initializeAiProfiles() {}, initializeStyleProfiles() {}, renderAccountModeFields() {},
    updateAccountTopologyHint() {}, renderActivityPresetState() {}, renderPromptEditor() {}, syncProtocolFields() {},
    renderAutomationAccountState() {}, renderRoutineState() {}, renderRegistrySaveState() {}, renderRegistryLists() {},
    renderRegistryEditor() {}, renderRegistryContexts() {}, renderApiAccountModels() {}, renderAutomationTargetPicker() {},
    renderOverview() {}, renderLogs() {}, renderProtocolControls() {}, renderAll() {},
    refreshRoutines: async () => {}, refreshAgentFeatures: async () => {}, fmtTime: () => "offline", fmtAgo: () => "offline",
    beforeRead: null,
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      let body;
      if (url === "/api/config" && method === "PATCH") {
        return new Promise((resolve) => pending.push({ body: JSON.parse(options.body), resolve }));
      }
      assert.equal(method, "GET", `unexpected offline mutation ${method} ${url}`);
      reads.push({ url, revision: state.cfg.revision });
      if (state.beforeRead) await state.beforeRead(url);
      if (url.startsWith("/api/config?")) body = structuredClone(state.server);
      else if (url.startsWith("/api/accounts?")) body = { ok: true, revision: state.server.revision, items: structuredClone(state.server.accounts.items) };
      else {
        assert.match(url, /^\/api\/(?:status|memory|archive\/(?:status|conversations))\?/);
        body = {};
      }
      return response(body);
    }
  };
  const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const context = vm.createContext(state);
  const constants = ["scopeNames", "saveScopeByButton"].map((name) => {
    const source = businessScript.match(new RegExp(`    const ${name} = \\{[\\s\\S]*?\\n    \\};`))?.[0];
    assert.ok(source, `missing admin constant ${name}`);
    return source.replace(`const ${name}`, `globalThis.${name}`);
  });
  new vm.Script([...constants, ...["api", "currentScope", "scopeForElement", "setVal", "getVal", "renderSaveState", "markDirty",
    "learningModePatch", "collectScopedPatch", "fillConfig", "refreshAll", "refreshAccountRegistry", "validateActivityPatch", "verifyActivitySaved", "verifyConfigSaved", "saveConfig"].map(adminFunction)].join("\n"))
    .runInContext(context, { timeout: 1000 });
  state.fillConfig();
  const edit = (id, value, { mark = true } = {}) => {
    const field = state.$(id);
    if (field.type === "checkbox") field.checked = value;
    else field.value = String(value);
    if (mark) state.markDirty({ target: field });
  };
  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "expectedRevision") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) merge(target[key] ||= {}, value);
      else target[key] = structuredClone(value);
    }
  };
  const commit = (index, revision, normalize = () => {}) => {
    assert.equal(pending[index].body.expectedRevision, state.server.revision);
    merge(state.server, pending[index].body); state.server.revision = revision; normalize(state.server);
    return { config: structuredClone(state.server), restartRequired: false };
  };
  const waitForPatch = async (index) => {
    // Advance only the in-memory promise chain until the real fetch boundary.
    // Authentication may add awaits; a bounded drain fails if no PATCH arrives,
    // rather than sleeping or masking a missing/early-settled request.
    for (let turn = 0; turn < 200 && !pending[index]; turn++) await Promise.resolve();
    assert.ok(pending[index], `config PATCH ${index} did not reach the network/authority boundary`);
    return pending[index];
  };
  return { state, nodes, pending, reads, feedback, edit, commit, waitForPatch,
    reply: (index, body, status) => pending[index].resolve(response(body, status)) };
}

await group("global-save-inflight-same-and-cross-scope", async () => {
  const t = configUiRuntime(), s = t.state;
  t.edit("taskMode.maxTurns", 12);
  const saving = s.saveConfig();
  t.edit("taskMode.maxTurns", 13);
  t.edit("chatArchive.baseDir", "unsaved/cross-scope");
  s.promptDrafts.set("a", "unsaved account prompt"); s.markDirty("qa:persona");
  s.apiCenterDirty = true; s.markDirty("api-center");
  await s.refreshAll({ silent: true });
  check("automatic refresh while PATCH is pending preserves same- and cross-scope drafts", () => {
    assert.equal(s.getVal("taskMode.maxTurns"), 13);
    assert.equal(s.getVal("chatArchive.baseDir"), "unsaved/cross-scope");
    assert(s.savingConfigScopes.has("tasks")); assert(s.dirtyScopes.has("tasks"));
    assert.equal(s.$("saveBtn").disabled, true);
  });
  await t.waitForPatch(0); t.reply(0, t.commit(0, "r2")); await saving;
  check("successful global save acknowledges only the submitted snapshot", () => {
    assert.equal(s.cfg.taskMode.maxTurns, 12); assert.equal(s.getVal("taskMode.maxTurns"), 13);
    assert(s.dirtyScopes.has("tasks")); assert(s.dirtyScopes.has("archive")); assert(s.dirtyScopes.has("qa:persona"));
    assert.equal(s.promptDrafts.get("a"), "unsaved account prompt");
    assert(s.apiCenterDirty); assert(s.dirtyScopes.has("api-center"));
    assert.match(s.scopeFeedback.get("tasks"), /后续修改仍未保存/);
    assert.equal(s.savingConfigScopes.size, 0); assert.equal(s.$("saveBtn").disabled, false);
    assert.deepEqual(Object.keys(t.pending[0].body), ["taskMode", "expectedRevision"]);
  });
  await s.refreshAll({ silent: true });
  check("later automatic refresh also retains newly edited fields", () => assert.equal(s.getVal("taskMode.maxTurns"), 13));
  const retry = s.saveConfig(); await t.waitForPatch(1); t.reply(1, t.commit(1, "r3")); await retry;
  check("saving the later draft cleans only that scope", () => {
    assert.equal(s.cfg.taskMode.maxTurns, 13); assert(!s.dirtyScopes.has("tasks"));
    assert(s.dirtyScopes.has("archive")); assert(s.dirtyScopes.has("qa:persona")); assert(s.dirtyScopes.has("api-center"));
  });
});

await group("global-save-clean-normalization-and-refresh-window", async () => {
  const t = configUiRuntime(), s = t.state;
  t.edit("taskMode.maxTurns", 15, { mark: false });
  const saving = s.saveConfig();
  t.edit("chatArchive.baseDir", "new other-region draft");
  await s.refreshAll({ silent: true });
  check("a clean-form save also protects its submission during refresh", () => {
    assert.equal(s.getVal("taskMode.maxTurns"), 15); assert(s.dirtyScopes.has("tasks"));
  });
  const rejected = assert.rejects(saving, /保存核对不一致/);
  await t.waitForPatch(0); t.reply(0, t.commit(0, "r2", (server) => { server.taskMode.maxTurns = 16; })); await rejected;
  check("numeric normalization is rejected and retains the submitted draft", () => {
    assert(s.dirtyScopes.has("tasks")); assert.equal(s.getVal("taskMode.maxTurns"), 15);
    assert.match(s.scopeFeedback.get("tasks"), /未通过保存核对/);
    assert.equal(s.getVal("chatArchive.baseDir"), "new other-region draft"); assert(s.dirtyScopes.has("archive"));
  });
  await s.refreshAll({ silent: true });
  t.edit("taskMode.maxTurns", 17);
  let release, reached;
  const refreshing = new Promise(resolve => { reached = resolve; });
  s.beforeRead = async (url) => { if (url.startsWith("/api/status?")) { reached(); await new Promise(resolve => { release = resolve; }); } };
  const next = s.saveConfig(); await t.waitForPatch(1); t.reply(1, t.commit(1, "r3")); await refreshing;
  // Also catch programmatic edits that do not dispatch a dirty event.
  t.edit("taskMode.maxTurns", 18, { mark: false });
  release(); await next;
  check("edits during post-save refresh stay dirty even without a new input event", () => {
    assert.equal(s.cfg.taskMode.maxTurns, 17); assert.equal(s.getVal("taskMode.maxTurns"), 18);
    assert(s.dirtyScopes.has("tasks")); assert.equal(s.savingConfigScopes.size, 0);
  });
});

await group("global-save-concurrent-scopes-and-stale-responses", async () => {
  const t = configUiRuntime(), s = t.state;
  t.edit("taskMode.maxTurns", 20);
  const first = s.saveConfig();
  await s.saveConfig();
  await t.waitForPatch(0);
  check("duplicate saves of the same scope are not replayed", () => assert.equal(t.pending.length, 1));
  const oldResponse = t.commit(0, "r2");
  // The server committed A, but its response is delayed. An automatic refresh
  // observes r2 and permits a legitimate second scope write using that revision.
  await s.refreshAll({ silent: true });
  s.activePage = "archive"; t.edit("chatArchive.baseDir", "saved concurrently");
  const second = s.saveConfig(); await t.waitForPatch(1); t.reply(1, t.commit(1, "r3")); await second;
  t.edit("chatArchive.baseDir", "edited after second save");
  const readStart = t.reads.length;
  t.reply(0, oldResponse); await first;
  check("delayed whole-config response cannot roll back a newer scope's acknowledgement", () => {
    assert.equal(t.reads[readStart].revision, "r3"); assert.equal(s.cfg.revision, "r3");
    assert.equal(s.cfg.taskMode.maxTurns, 20); assert.equal(s.cfg.chatArchive.baseDir, "saved concurrently");
    assert.equal(s.getVal("chatArchive.baseDir"), "edited after second save");
    assert(s.dirtyScopes.has("archive")); assert(!s.dirtyScopes.has("tasks"));
  });
  const conflict = configUiRuntime(), c = conflict.state;
  conflict.edit("taskMode.maxTurns", 21); const taskSave = c.saveConfig();
  c.activePage = "archive"; conflict.edit("chatArchive.baseDir", "conflicting draft");
  const archiveSave = c.saveConfig();
  const rejected = assert.rejects(archiveSave, (error) => error.status === 409);
  await Promise.all([conflict.waitForPatch(0), conflict.waitForPatch(1)]);
  conflict.reply(0, conflict.commit(0, "r2")); await taskSave;
  conflict.reply(1, { error: "stale revision" }, 409); await rejected;
  check("concurrent optimistic-revision failure preserves the losing scope without a retry", () => {
    assert.equal(conflict.pending.length, 2); assert(!c.dirtyScopes.has("tasks"));
    assert(c.dirtyScopes.has("archive")); assert(c.conflictedScopes.has("archive"));
    assert.equal(c.getVal("chatArchive.baseDir"), "conflicting draft"); assert.equal(c.savingConfigScopes.size, 0);
  });
});

await group("global-save-failure-and-behavior-account-isolation", async () => {
  for (const status of [500, 409]) {
    const t = configUiRuntime(), s = t.state;
    t.edit("taskMode.maxTurns", 22); const saving = s.saveConfig();
    const rejected = assert.rejects(saving, (error) => error.status === status);
    t.edit("taskMode.maxTurns", 23); t.edit("chatArchive.baseDir", "unrelated failure draft");
    await t.waitForPatch(0); t.reply(0, { error: "offline save error" }, status); await rejected;
    await s.refreshAll({ silent: true });
    check(`HTTP ${status} retains submitted, later and unrelated drafts through refresh`, () => {
      assert.equal(s.getVal("taskMode.maxTurns"), 23); assert.equal(s.getVal("chatArchive.baseDir"), "unrelated failure draft");
      assert(s.dirtyScopes.has("tasks")); assert(s.dirtyScopes.has("archive"));
      assert.equal(s.conflictedScopes.has("tasks"), status === 409); assert.equal(t.pending.length, 1);
      assert.equal(s.savingConfigScopes.size, 0);
    });
  }
  const t = configUiRuntime(), s = t.state;
  s.activePage = "qa";
  t.edit("behaviorModes.default", "restrained");
  t.edit("accounts.standbys.0.behaviorMode", "normal", { mark: false });
  const accounts = structuredClone(s.server.accounts);
  const saving = s.saveConfig();
  await t.waitForPatch(0);
  check("Q&A behavior PATCH never submits an account or standby array", () => {
    assert(!("accounts" in t.pending[0].body));
    assert.equal(t.pending[0].body.behaviorModes.default, "restrained");
  });
  t.reply(0, t.commit(0, "r2")); await saving;
  check("global behavior save preserves independent account modes and registry entry", () => {
    assert.deepEqual(s.server.accounts, accounts); assert(!s.dirtyScopes.has("qa:behavior"));
    assert.match(html, /各账号（包括账号 2）的独立发言档位请到「账号功能 → 基本」设置/);
    assert.match(adminFunction("registryTabKeys"), /"identity"\s*\?\s*\["displayName", "selfName", "qq", "behaviorMode"\]/);
    assert.match(adminFunction("mountAccountRegistry"), /\["standbyBehaviorCard", "legacyNapcatTools"/);
  });
  t.edit("behaviorModes.default", "lively");
  const next = s.saveConfig();
  t.edit("learningMode.maxQuestionsPerDay", 0, { mark: false });
  await t.waitForPatch(1); t.reply(1, t.commit(1, "r3")); await next;
  check("newly invalid behavior drafts are retained, not treated as a failed successful write", () => {
    assert.equal(s.cfg.learningMode.maxQuestionsPerDay, 3); assert.equal(s.getVal("learningMode.maxQuestionsPerDay"), 0);
    assert(s.dirtyScopes.has("qa:behavior")); assert.match(s.scopeFeedback.get("qa:behavior"), /后续修改仍未保存/);
  });
});

await group("activity-save-validation-and-readback", async () => {
  const t = configUiRuntime(), s = t.state;
  s.activePage = "qa"; s.activeTabs.qa = "behavior";
  t.edit("trigger.activeProbability", 9);
  await assert.rejects(s.saveConfig(), /普通聊天接话概率/);
  check("percentage instead of decimal is refused without dispatch and retains draft", () => {
    assert.equal(t.pending.length, 0); assert(s.dirtyScopes.has("qa:behavior"));
    assert.equal(s.getVal("trigger.activeProbability"), 9); assert.match(s.scopeFeedback.get("qa:behavior"), /0.09/);
  });
  t.edit("trigger.activeProbability", 0.17);
  const work = s.saveConfig(); await t.waitForPatch(0);
  const committed = t.commit(0, "r2");
  committed.config.trigger.activeProbability = 0.12;
  const rejection = assert.rejects(work, /保存核对不一致/);
  t.reply(0, committed); await rejection;
  check("a server-normalized different value cannot masquerade as a successful save", () => {
    assert(s.dirtyScopes.has("qa:behavior")); assert.equal(s.getVal("trigger.activeProbability"), 0.17);
    assert.match(s.scopeFeedback.get("qa:behavior"), /保存核对不一致/);
  });
});

await group("global-save-post-write-sync-failure", async () => {
  const t = configUiRuntime(), s = t.state;
  t.edit("taskMode.maxTurns", 24); const saving = s.saveConfig();
  const rejected = assert.rejects(saving, /offline refresh failure/);
  s.beforeRead = async () => { throw new Error("offline refresh failure"); };
  await t.waitForPatch(0); t.reply(0, t.commit(0, "r2")); await rejected;
  check("a failed follow-up read preserves the draft and distinguishes an already committed write", () => {
    assert.equal(s.cfg.taskMode.maxTurns, 24); assert.equal(s.getVal("taskMode.maxTurns"), 24);
    assert(s.dirtyScopes.has("tasks")); assert.match(s.scopeFeedback.get("tasks"), /已提交，但刷新失败/);
    assert.equal(t.pending.length, 1); assert.equal(s.savingConfigScopes.size, 0);
  });
  const stale = configUiRuntime(), c = stale.state;
  stale.edit("taskMode.maxTurns", 25); const delayed = c.saveConfig();
  const delayedRejected = assert.rejects(delayed, /offline registry failure/);
  await stale.waitForPatch(0);
  const newerResponse = stale.commit(0, "r3");
  // A different pane has read a revision between this write's expected and
  // returned revisions. Do not accept its old read as the save acknowledgement.
  c.cfg.revision = "r2";
  c.beforeRead = async (url) => { if (url.startsWith("/api/accounts?")) throw new Error("offline registry failure"); };
  stale.reply(0, newerResponse); await delayedRejected;
  check("failed registry reconciliation cannot clean a scope using a mismatched snapshot", () => {
    assert.equal(c.cfg.revision, "r2"); assert.equal(c.getVal("taskMode.maxTurns"), 25);
    assert(c.dirtyScopes.has("tasks")); assert.match(c.scopeFeedback.get("tasks"), /已提交，但刷新失败/);
    assert.equal(stale.pending.length, 1);
  });
});

const sampleCenter = () => ({
  connections: [
    { id: "c1", name: "Connection", provider: "custom", baseUrl: "", apiKeyEnv: "TEST_KEY" },
    { id: "c2", name: "Spare", provider: "custom" }
  ],
  profiles: [{ id: "p1", name: "Plan", model: "model-original", timeoutMs: 1000, connectionId: "c1" }],
  bindings: { chat: "p1", task: "inherit-chat", vision: "p1", asr: "p1", tts: "p1" },
  searchBinding: "s1",
  searchProfiles: [{ id: "s1", name: "Search", provider: "google", proxy: { enabled: false, urls: [] } }]
});
function apiRuntime() {
  const nodes = new Map(); const requests = []; const feedback = [];
  let response = async () => { throw new Error("No mock API response configured"); };
  const state = {
    structuredClone, apiCenterDraft: sampleCenter(), apiCenterSaved: sampleCenter(),
    apiCenterDirty: false, apiCenterConflicted: false, apiCenterRevision: "r1", apiCredentialStatus: {},
    apiCenterLastLoaded: 0, apiCenterReadRequest: 0, apiCenterSaveEpoch: 0, registryState: {}, dirtyScopes: new Set(), conflictedScopes: new Set(),
    selectedApiConnection: "c1", selectedApiProfile: "p1", apiCredentialEntries: [], apiCredentialRequest: 0,
    $: (id) => { if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", classList: { toggle() {} } }); return nodes.get(id); },
    sensitiveApi: async (url, method, body) => { requests.push({ url, method, body: structuredClone(body) }); return response(url, method, body); },
    confirm: () => true, setBusy: () => {}, toast: (message) => feedback.push(message),
    renderSaveState: () => {}, renderApiConnection: () => {}, renderApiProfile: () => {},
    renderApiSearch: () => {}, renderApiCapabilityCards: () => {}, refreshAll: async () => {}, refreshApiCredentials: async () => {}
  };
  state.apiCurrentConnection = () => state.apiCenterDraft.connections.find((item) => item.id === state.selectedApiConnection);
  state.apiCurrentProfile = () => state.apiCenterDraft.profiles.find((item) => item.id === state.selectedApiProfile);
  const context = vm.createContext(state);
  new vm.Script(["apiConnectionCredentialsSaved", "newApiProfileForConnection", "testApiEditor", "deleteApiCredentialEntry", "mergeApiCenterDraft", "refreshApiCenter", "saveApiCenter"].map(adminFunction).join("\n"))
    .runInContext(context, { timeout: 1000 });
  return { state, requests, feedback, nodes, respond: (fn) => { response = fn; } };
}

await group("api-conflict-multiple-refreshes", async () => {
  const test = apiRuntime(); const s = test.state;
  s.apiCenterDraft.connections[0].name = "local draft"; s.apiCenterDirty = true;
  const remote = sampleCenter(); remote.profiles[0].name = "remote edit";
  test.respond(async () => ({ center: structuredClone(remote), revision: "r2" }));
  const draft = structuredClone(s.apiCenterDraft);
  for (let refresh = 0; refresh < 3; refresh += 1) {
    await s.refreshApiCenter({ preserveDirty: true });
    check(`conflict survives refresh ${refresh + 1} at same remote revision`, () => {
      assert.equal(s.apiCenterConflicted, true); assert.equal(s.apiCenterRevision, "r2");
      assert.deepEqual(plain(s.apiCenterDraft), draft);
    });
  }
  const count = test.requests.length; s.confirm = () => false;
  await s.saveApiCenter("apiConnectionSave");
  check("conflict still prompts and cancellation does not PATCH", () => {
    assert.equal(test.requests.length, count); assert.equal(s.apiCenterConflicted, true);
  });
  s.confirm = () => true;
  test.respond(async (_url, method, body) => {
    assert.equal(method, "PATCH"); return { center: body.center, revision: "r3" };
  });
  await s.saveApiCenter("apiConnectionSave");
  check("acknowledged area save retains conflict for other stale drafts", () => {
    assert.equal(s.apiCenterConflicted, true); assert(s.conflictedScopes.has("api-center"));
    assert.equal(s.apiCenterDraft.profiles[0].name, "Plan");
    assert.equal(s.apiCenterSaved.profiles[0].name, "remote edit");
  });
  const afterConnectionSave = test.requests.length;
  s.confirm = () => false;
  await s.saveApiCenter("apiProfileSave");
  check("another stale area cannot overwrite remote changes without confirmation", () => {
    assert.equal(test.requests.length, afterConnectionSave); assert.equal(s.apiCenterConflicted, true);
  });
  s.confirm = () => true;
  await s.saveApiCenter("apiProfileSave");
  check("explicitly resolving all remaining drafts clears conflict", () => {
    assert.equal(s.apiCenterConflicted, false); assert.equal(s.apiCenterDirty, false);
    assert.equal(s.conflictedScopes.has("api-center"), false);
  });
});

await group("api-delayed-area-save", async () => {
  const areas = {
    apiConnectionSave: ["connections"], apiProfileSave: ["profiles"],
    apiBindingsSave: ["bindings", "searchBinding"], apiSearchSave: ["searchProfiles"]
  };
  for (const [button, keys] of Object.entries(areas)) {
    const test = apiRuntime(); const s = test.state;
    // Pre-existing unsaved changes in every region: a scoped save must not send
    // these unrelated drafts, and none may be replaced by an old request snapshot.
    s.apiCenterDraft.connections[0].name = "submit connection";
    s.apiCenterDraft.profiles[0].name = "submit plan";
    s.apiCenterDraft.bindings.chat = "submit binding";
    s.apiCenterDraft.searchBinding = "submit search binding";
    s.apiCenterDraft.searchProfiles[0].name = "submit search";
    s.apiCenterDirty = true; s.dirtyScopes.add("api-center");
    const before = structuredClone(s.apiCenterDraft);
    let resolve;
    test.respond(() => new Promise((done) => { resolve = done; }));
    const saving = s.saveApiCenter(button);
    const submitted = test.requests[0].body.center;
    check(`${button} submits only its own region`, () => {
      for (const field of Object.keys(submitted)) assert.deepEqual(submitted[field], keys.includes(field) ? before[field] : s.apiCenterSaved[field]);
    });
    s.apiCenterDraft.connections[0].name = "new in-flight connection";
    s.apiCenterDraft.profiles[0].name = "new in-flight plan";
    s.apiCenterDraft.bindings.chat = "new in-flight binding";
    s.apiCenterDraft.searchBinding = "new in-flight search binding";
    s.apiCenterDraft.searchProfiles[0].name = "new in-flight search";
    const current = structuredClone(s.apiCenterDraft);
    resolve({ center: structuredClone(submitted), revision: "r2" }); await saving;
    check(`${button} preserves in-flight edits across every region`, () => {
      assert.deepEqual(plain(s.apiCenterDraft), current);
      assert.deepEqual(plain(s.apiCenterSaved), submitted);
      assert.equal(s.apiCenterDirty, true); assert(s.dirtyScopes.has("api-center"));
    });
  }
  const test = apiRuntime(); const s = test.state;
  s.apiCenterDraft.connections[0].name = "submitted";
  s.apiCenterDraft.profiles[0].name = "other-region draft";
  s.apiCenterDirty = true;
  let resolve;
  test.respond(() => new Promise((done) => { resolve = done; }));
  const saving = s.saveApiCenter("apiConnectionSave");
  const submitted = test.requests[0].body.center;
  s.apiCenterDraft.connections[0].name = "typed while saving";
  s.apiCenterDraft.connections[0].baseUrl = "https://example.invalid/v2";
  delete s.apiCenterDraft.connections[0].apiKeyEnv;
  s.apiCenterDraft.connections.splice(1, 1);
  s.apiCenterDraft.connections.push({ id: "c3", name: "added while saving", provider: "custom" });
  s.apiCenterDraft.profiles[0].model = "new model while saving";
  s.apiCenterDraft.searchProfiles[0].proxy.urls.push("https://example.invalid/proxy");
  const normalized = structuredClone(submitted);
  normalized.connections[0].credentialRef = "generated-reference";
  normalized.profiles[0].timeoutMs = 9000;
  resolve({ center: normalized, revision: "r2" }); await saving;
  check("merge preserves field edits, local additions/deletions and server normalization", () => {
    const connection = s.apiCenterDraft.connections[0];
    assert.equal(connection.name, "typed while saving"); assert.equal(connection.baseUrl, "https://example.invalid/v2");
    assert.equal(connection.credentialRef, "generated-reference"); assert(!("apiKeyEnv" in connection));
    assert.deepEqual(Array.from(s.apiCenterDraft.connections, (item) => item.id), ["c1", "c3"]);
    assert.equal(s.apiCenterDraft.profiles[0].name, "other-region draft");
    assert.equal(s.apiCenterDraft.profiles[0].model, "new model while saving");
    assert.equal(s.apiCenterDraft.profiles[0].timeoutMs, 9000);
    assert.deepEqual(plain(s.apiCenterDraft.searchProfiles[0].proxy.urls), ["https://example.invalid/proxy"]);
    assert.equal(s.apiCenterDirty, true);
  });
  const clean = apiRuntime(); const c = clean.state;
  c.apiCenterDraft.profiles[0].name = "submitted plan"; c.apiCenterDirty = true; c.dirtyScopes.add("api-center");
  clean.respond(async (_url, _method, body) => ({ center: body.center, revision: "r2" }));
  await c.saveApiCenter("apiProfileSave");
  check("unchanged successfully submitted fields become clean", () => {
    assert.equal(c.apiCenterDirty, false); assert.equal(c.dirtyScopes.has("api-center"), false);
    assert.deepEqual(plain(c.apiCenterDraft), plain(c.apiCenterSaved));
  });
});

await group("api-credentials-saved-connection", async () => {
  const test = apiRuntime(); const s = test.state;
  const connection = s.apiCenterDraft.connections[0];
  connection.credentialSource = "keychain";
  s.apiCenterDraft.profiles[0].name = "unrelated unsaved model";
  s.apiCenterDirty = true;
  check("unsaved connection cannot store credentials", () => {
    assert.equal(s.apiConnectionCredentialsSaved(connection), false);
  });
  test.respond(async (_url, _method, body) => {
    const center = structuredClone(body.center);
    center.connections[0].credentialRef = "ec021717-671a-4c86-9ca0-c44265deee81";
    return { center, revision: "r2" };
  });
  await s.saveApiCenter("apiConnectionSave");
  check("saved connection accepts credentials despite another unsaved region", () => {
    assert.equal(s.apiCenterDirty, true);
    assert.equal(s.apiCenterDraft.profiles[0].name, "unrelated unsaved model");
    assert.equal(s.apiConnectionCredentialsSaved(s.apiCenterDraft.connections[0]), true);
  });
  for (const [field, value] of Object.entries({ name: "changed name", provider: "changed-provider",
    baseUrl: "https://example.invalid/v2", credentialSource: "existing", apiKeyEnv: "NEW_ENV",
    credentialRef: "91b65f87-976e-4e74-9d8b-8fae04fe992c" })) {
    check(`unsaved current connection ${field} still blocks credential writes`, () => {
      assert.equal(s.apiConnectionCredentialsSaved({ ...s.apiCenterDraft.connections[0], [field]: value }), false);
    });
  }
  check("missing, removed and new connection references cannot be used", () => {
    assert.equal(s.apiConnectionCredentialsSaved(undefined), false);
    assert.equal(s.apiConnectionCredentialsSaved({ ...s.apiCenterDraft.connections[0], id: "new-connection" }), false);
    s.apiCenterSaved.connections = [];
    assert.equal(s.apiConnectionCredentialsSaved(s.apiCenterDraft.connections[0]), false);
  });
});

await group("api-new-profile-selected-connection", () => {
  const test = apiRuntime(); const s = test.state;
  const saved = structuredClone(s.apiCenterSaved);
  const bindings = structuredClone(s.apiCenterDraft.bindings);
  let focused = 0;
  s.$("apiProfileModel").focus = () => { focused++; };
  s.apiCenterChanged = () => { s.apiCenterDirty = true; s.dirtyScopes.add("api-center"); };
  s.Date = { now: () => 123456 };
  s.newApiProfileForConnection("c2");
  check("new model draft uses selected connection without switching bindings", () => {
    const profile = s.apiCenterDraft.profiles.find((item) => item.id === s.selectedApiProfile);
    assert.equal(profile.connectionId, "c2");
    assert.equal(profile.name, "Spare · 问答");
    assert.equal(profile.model, "");
    assert.equal(s.apiCenterDirty, true);
    assert.equal(focused, 1);
    assert.deepEqual(plain(s.apiCenterDraft.bindings), bindings);
    assert.deepEqual(plain(s.apiCenterSaved), saved);
    assert.equal(test.requests.length, 0);
  });
  s.newApiProfileForConnection("c2");
  check("rapid new drafts have unique identifiers", () => {
    assert.equal(new Set(s.apiCenterDraft.profiles.map((item) => item.id)).size, s.apiCenterDraft.profiles.length);
  });
  s.newApiProfileForConnection("removed-connection");
  check("stale selection falls back to an available connection", () => {
    assert.equal(s.apiCenterDraft.profiles.find((item) => item.id === s.selectedApiProfile).connectionId, "c1");
  });
  s.apiCenterDraft.connections = [];
  const count = s.apiCenterDraft.profiles.length;
  s.newApiProfileForConnection("removed-connection");
  check("missing connections cannot create an invalid profile", () => {
    assert.equal(s.apiCenterDraft.profiles.length, count);
    assert.equal(test.feedback.at(-1), "请先添加服务连接");
  });
});

await group("api-editor-draft-tests", async () => {
  const test = apiRuntime(); const s = test.state;
  s.apiCenterDraft.connections[0].credentialSource = "keychain";
  s.apiCenterDraft.connections[0].baseUrl = "https://example.invalid/v1";
  s.$("apiKeyInput").value = "test-only-unsaved-secret";
  const before = structuredClone(s.apiCenterDraft), saved = structuredClone(s.apiCenterSaved);
  test.respond(async () => ({ ok: true, durationMs: 10, detail: "模型列表可访问" }));
  await s.testApiEditor("connection");
  check("connection test submits unbound draft and transient key without saving", () => {
    const request = test.requests.at(-1);
    assert.equal(request.url, "/api/api-center/test");
    assert.equal(request.body.target, "connection"); assert.equal(request.body.connectionId, "c1");
    assert.equal(request.body.secret, "test-only-unsaved-secret");
    assert.equal(s.$("apiKeyInput").value, "");
    assert.deepEqual(request.body.center, before);
    assert.deepEqual(plain(s.apiCenterDraft), before); assert.deepEqual(plain(s.apiCenterSaved), saved);
    assert.match(s.$("apiConnectionTestResult").textContent, /成功/);
  });
  s.selectedApiConnection = "c2"; s.$("apiKeyInput").value = "test-only-other-connection-secret";
  await s.testApiEditor("profile");
  check("model test selects the edited unbound profile and never takes another connection's key", () => {
    assert.equal(test.requests.at(-1).body.profileId, "p1");
    assert.equal(test.requests.at(-1).body.target, "profile");
    assert.equal(test.requests.at(-1).body.secret, undefined);
    assert.equal(s.$("apiKeyInput").value, "test-only-other-connection-secret");
    assert.match(s.$("apiProfileTestResult").textContent, /成功/);
  });
  s.apiCenterDraft.profiles[0].model = "";
  const count = test.requests.length; await s.testApiEditor("profile");
  check("blank model is explained before sending a model test", () => {
    assert.equal(test.requests.length, count); assert.match(s.$("apiProfileTestResult").textContent, /模型 ID/);
  });
  s.selectedApiConnection = "c1"; s.$("apiKeyInput").value = "";
  let resolve; test.respond(() => new Promise((done) => { resolve = done; }));
  const pending = s.testApiEditor("connection");
  s.apiCenterDraft.connections[0].baseUrl = "https://changed.invalid/v1";
  resolve({ ok: true, durationMs: 1 }); await pending;
  check("old test success cannot validate a newly edited URL", () => {
    assert.match(s.$("apiConnectionTestResult").textContent, /已修改/);
  });
});

await group("api-credential-list-state", async () => {
  const test = apiRuntime(); const s = test.state;
  s.renderApiCredentialList = () => {};
  new vm.Script(adminFunction("refreshApiCredentials")).runInContext(vm.createContext(s));
  s.apiCenterDirty = true; s.apiCenterDraft.profiles[0].name = "unsaved model";
  const draft = structuredClone(s.apiCenterDraft);
  test.respond(async () => ({ credentials: [{ connectionId: "c1", connectionName: "Connection", status: "configured", preview: "test••••only", createdAt: null }] }));
  await s.refreshApiCredentials();
  check("credential refresh updates masked metadata while retaining drafts", () => {
    assert.equal(test.requests.at(-1).url, "/api/api-center/credentials");
    assert.equal(s.apiCredentialEntries[0].preview, "test••••only");
    assert.deepEqual(plain(s.apiCenterDraft), draft); assert.equal(s.apiCenterDirty, true);
  });
  test.respond(async () => { throw new Error("synthetic-read-failure"); }); await s.refreshApiCredentials();
  check("credential errors clear stale metadata and show retry state", () => {
    assert.equal(s.apiCredentialEntries.length, 0); assert.match(s.$("apiKeyManagerState").textContent, /读取失败/);
    assert.equal(s.$("apiKeyRefresh").disabled, false);
  });
  const count = test.requests.length;
  await s.deleteApiCredentialEntry({ connectionId: "c1", credentialRef: "unmatched", inUse: false }, {});
  check("stale credential references cannot be deleted from the list", () => assert.equal(test.requests.length, count));
});

await group("api-password-owner", () => {
  const test = apiRuntime(); const s = test.state;
  s.apiKeyInputConnectionId = "c1";
  s.apiCenterDraft.connections[0].credentialSource = "keychain";
  s.apiCenterDraft.connections[1].credentialSource = "keychain";
  s.apiSelectOptions = () => {}; s.apiDefaultEditorProfile = () => s.apiCurrentProfile();
  new vm.Script(adminFunction("renderApiConnection")).runInContext(vm.createContext(s));
  s.$("apiKeyInput").value = "test-only-first-connection-secret";
  s.renderApiConnection();
  check("same connection refresh preserves its pending key", () => assert.equal(s.$("apiKeyInput").value, "test-only-first-connection-secret"));
  s.selectedApiConnection = "c2"; s.renderApiConnection();
  check("switching connections clears the previous connection's pending key", () => assert.equal(s.$("apiKeyInput").value, ""));
});

await group("registry-focused-controls", () => {
  for (const name of ["renderRegistryEditor", "renderRegistryContexts"]) {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"]) {
      let replacements = 0, synced = 0;
      const stop = new Error("Rebuild reached");
      const host = {
        dataset: { accountId: "a1" },
        contains: (node) => node?.owner === host,
        querySelector: () => ({ value: "a1" }),
        replaceChildren() { replacements += 1; throw stop; }
      };
      const focused = { owner: host, tagName, matches: () => ["INPUT", "TEXTAREA", "SELECT"].includes(tagName) };
      const document = { activeElement: focused, querySelector: (query) => query.includes('="qa"') ? host : null };
      const state = {
        document, $: () => host, activeTabs: { qa: "persona" }, registryState: { selected: "a1", contexts: { qa: "a1" } },
        registryItem: () => ({ id: "a1" }), registryDraft: () => ({ value: {} }), registryGroup: () => null,
        syncRegistryDraftControls: () => { synced += 1; }
      };
      const context = vm.createContext(state);
      new vm.Script(adminFunction(name)).runInContext(context, { timeout: 1000 });
      check(`${name} polling retains focused ${tagName}`, () => {
        context[name](); assert.equal(replacements, 0); assert.equal(synced, 1);
        assert.equal(document.activeElement, focused);
      });
      check(`${name} explicit forced rendering still rebuilds ${tagName}`, () => {
        assert.throws(() => context[name](true), (error) => error === stop); assert.equal(replacements, 1);
      });
      document.activeElement = { owner: null, tagName: "BUTTON" };
      check(`${name} unfocused editor still refreshes`, () => {
        assert.throws(() => context[name](), (error) => error === stop); assert.equal(replacements, 2);
      });
    }
  }
});

function scopedUiRuntime() {
  const nodes = new Map(), fields = [], requests = [];
  const node = () => ({ children: [], dataset: {}, className: "", textContent: "", disabled: false,
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    contains: () => false, querySelector: () => null,
    querySelectorAll(selector) { return selector === "details[open]" ? this.children.filter((child) => child.open && child.dataset?.routineEntry) : []; },
    setAttribute() {}, classList: { toggle() {}, add() {} } });
  const state = {
    structuredClone, Date, cfg: { revision: "r1", prompt: { system: "original template" }, styleProfiles: { activeId: "legacy", profiles: [{ id: "legacy", systemPrompt: "" }] } },
    registryState: { loaded: true, revision: "r1", selected: "a", tab: "style", items: [
      { id: "a", displayName: "甲", style: { systemPrompt: "saved A" }, features: { chat: true } },
      { id: "b", displayName: "乙", style: { systemPrompt: "" }, promptOverride: "must not inherit" }
    ], groups: [], drafts: new Map(), contexts: { qa: "a" }, error: "" },
    registryIdentityKeys: ["displayName", "selfName", "qq", "behaviorMode"], registryPolicyKeys: ["displayName", "selfName", "style", "features"],
    registryTabs: { identity: "基本", style: "风格", features: "功能", connection: "连接高级" },
    registryFeatures: { chat: "聊天" }, VOICE_PRESET_IDS: [],
    routineState: { revision: "r1", value: null, dirty: false, dirtyPaths: new Set(), catalog: [], busy: false, loadedAt: 0 },
    automationAccounts: { selected: "a", drafts: new Map() },
    dirtyScopes: new Set(["automation"]), automationRulesDraft: [{ id: "unsaved-rule", prompt: "unrelated draft" }],
    document: { activeElement: null, createElement: node },
    $: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    registryField: (host, label, path, value, change, options = {}) => { const control = node(); fields.push({ label, path, value, change, options, control }); host.append(control); return control; },
    renderAutomationTargetPicker() {}, showAutomationDraft() {}, renderAutomationAccountState() {}, renderSaveState() {}, renderRegistrySaveState() {}, renderRegistryLists() {}, renderRegistryEditor() {}, registryFeedback() {},
    confirm: () => true, toast() {},
    refreshAccountRegistry: async () => {
      for (const [id, draft] of state.registryState.drafts) {
        Object.assign(state.registryItem(id), structuredClone(draft.base));
        state.rebaseRegistryDraft(id, draft, state.registryItem(id), draft.revision);
      }
      return { items: state.registryState.items };
    },
    registryRequest: async (url, method, body) => { requests.push({ url, method, body: structuredClone(body) }); return { revision: "r2" }; },
    sensitiveApi: async () => { throw new Error("No fixture response"); }
  };
  state.automationAccounts.drafts.set("a", { routine: state.routineState, dirty: true, rules: state.automationRulesDraft });
  const context = vm.createContext(state);
  state.automationBaseline = result => JSON.stringify({ owner: result.owner, enabled: result.enabled, rules: result.rules, routines: result.routines });
  const names = ["registryStyle", "registryEditable", "registryDraft", "registryItem", "registryGroup", "registryGet", "registrySet", "registrySelect", "rebaseRegistryDraft", "registryTabKeys", "registryValidate", "registryPatch", "confirmRegistrySave", "saveRegistryPatch", "registryDraftStatus", "saveRegistryContext", "routineTarget", "routinePatch", "renderRoutineState", "renderRoutines", "refreshRoutines", "saveRoutines"];
  new vm.Script(names.map(adminFunction).join("\n")).runInContext(context);
  return { state, nodes, fields, requests, context };
}

await group("independent-style-and-account-drafts", async () => {
  const { state: s, requests } = scopedUiRuntime();
  check("explicit blank and empty style never fall back", () => {
    assert.equal(s.registryStyle(s.registryItem("b")).systemPrompt, "");
    assert.equal(s.registryStyle({ style: {}, promptOverride: "old" }).systemPrompt, "");
    assert.equal(s.registryStyle({ promptOverride: "legacy override" }).systemPrompt, "legacy override");
    assert.equal(s.registryStyle({}).systemPrompt, "original template");
  });
  const draft = s.registryDraft("a"); draft.value.style.systemPrompt = "local style"; draft.dirty.add("style.systemPrompt");
  draft.value.features.chat = false; draft.dirty.add("features.chat");
  s.registrySelect("b", "features"); s.registryDraft("b").value.displayName = "乙草稿"; s.registryDraft("b").dirty.add("displayName");
  s.registrySelect("a", "style");
  check("switching account and tab preserves both account drafts", () => {
    assert.equal(s.registryDraft(), draft); assert.equal(draft.value.style.systemPrompt, "local style");
    assert.equal(draft.value.features.chat, false); assert.equal(s.registryDraft("b").value.displayName, "乙草稿");
    assert.deepEqual([...draft.dirty], ["style.systemPrompt", "features.chat"]);
  });
  await s.saveRegistryPatch("a", s.registryTabKeys("style"), "风格");
  check("style save submits only canonical snapshot and retains other tab/account drafts", () => {
    assert.deepEqual(plain(requests[0].body), { expectedRevision: "r1", patch: { style: { systemPrompt: "local style" } } });
    assert.deepEqual([...draft.dirty], ["features.chat"]); assert(s.registryDraft("b").dirty.has("displayName"));
  });
  draft.value.style.systemPrompt = ""; draft.dirty.add("style.systemPrompt"); await s.saveRegistryContext("qa");
  check("QA saves blank canonical style without name, features, legacy profile or override", () => assert.deepEqual(plain(requests[1].body.patch), { style: { systemPrompt: "" } }));
  const remote = { ...s.registryItem("a"), style: { systemPrompt: "remote" } };
  draft.value.style.systemPrompt = "unsaved conflict"; draft.dirty.add("style.systemPrompt");
  s.rebaseRegistryDraft("a", draft, remote, "r9");
  check("revision conflict preserves local multi-tab drafts", () => {
    assert.equal(draft.conflict, true); assert.equal(draft.value.style.systemPrompt, "unsaved conflict"); assert.equal(draft.value.features.chat, false);
  });
});

await group("legacy-routines-sparse-defaults", async () => {
  const { state: s, fields, nodes } = scopedUiRuntime();
  const value = { version: 1, daily: { schedules: [{ name: "morning", mode: "old", time: "8:30" }, { time: "23:00", enabled: false }] }, hourly: {} };
  s.routineState.value = structuredClone(value);
  s.routineState.catalog = [{ id: "daily-0", kind: "daily", windowMinutes: 3, prompt: "effective legacy instruction", scopeStrategy: "old scope", targetLabel: "原路由", senderStrategy: "old router" }, { id: "hourly", kind: "hourly", prompt: "effective hourly default" }];
  s.renderRoutines();
  check("routine editors are collapsed by default and preserve explicitly opened entries", () => {
    const host = nodes.get("routineEditor");
    const entry = host.children.find((item) => item.dataset?.routineEntry === "daily-0");
    assert.equal(entry.open, false); entry.open = true; fields.length = 0;
    s.renderRoutines();
    assert.equal(host.children.find((item) => item.dataset?.routineEntry === "daily-0").open, true);
  });
  check("defaults render without materializing config fields", () => {
    assert.equal(fields.find((field) => field.path === "windowMinutes").value, 3);
    assert.equal(fields.find((field) => field.label.startsWith("此时")).value, "effective legacy instruction");
    assert.equal(fields.find((field) => field.label === "启用定期主人私聊").value, true);
    assert.deepEqual(plain(s.routineState.value), value); assert.equal(nodes.get("saveRoutinesBtn").disabled, true);
  });
  fields.find((field) => field.label.startsWith("此时")).change("prompt", "edited morning");
  check("editing one prompt submits only that schedule leaf; malformed old time and missing defaults remain untouched", () => {
    assert.deepEqual(plain(s.routinePatch(s.routineState.value)), { daily: { schedules: [{ id: "daily-0", prompt: "edited morning" }] } });
    assert.equal(s.routineState.value.daily.schedules[0].time, "8:30"); assert.equal(nodes.get("saveRoutinesBtn").disabled, false);
  });
  check("sender reset uses null and cannot co-select account/group", () => {
    assert.deepEqual(plain(s.routinePatch({ version: 1, hourly: { accountId: null, groupId: null } }, new Set(["hourly.accountId", "hourly.groupId"]))), { hourly: { accountId: null, groupId: null } });
    assert.throws(() => s.routinePatch({ hourly: { accountId: "a", groupId: "g" } }, new Set(["hourly.accountId"])), /互斥/);
  });
  for (const partial of [{ version: 1 }, { version: 1, daily: { schedules: [] } }, { version: 1, hourly: {} }]) {
    s.routineState.value = partial; s.routineState.dirty = false; s.routineState.dirtyPaths.clear();
    fields.length = 0; s.renderRoutines();
    check(`missing routine sources are not created: ${Object.keys(partial).join()}`, () => {
      assert.deepEqual(plain(s.routinePatch(partial)), {}); assert.equal(fields.some((field) => field.label === "启用每日例行规则"), Boolean(partial.daily));
      assert.equal(fields.some((field) => field.label === "启用定期主人私聊"), Boolean(partial.hourly));
    });
  }
  check("patch refuses creation or unsupported schedule metadata", () => {
    assert.throws(() => s.routinePatch({ version: 1 }, new Set(["daily.enabled"])), /缺失/);
    assert.throws(() => s.routinePatch(value, new Set(["daily.schedules.0.mode"])), /字段/);
  });
  s.routineState.dirty = false;
  s.sensitiveApi = async () => ({ ok: true, revision: "r2", routines: { version: 1 }, catalog: [] });
  await s.refreshRoutines({ force: true });
  check("GET version-only routines is a valid empty state", () => { assert.equal(s.routineState.error, ""); assert.deepEqual(plain(s.routineState.value), { version: 1 }); });
});

await group("legacy-routines-conflict-and-isolated-save", async () => {
  const { state: s, requests } = scopedUiRuntime();
  const remote = { version: 1, daily: { schedules: [{ time: "08:30", prompt: "remote" }] }, hourly: { enabled: false } };
  const draft = structuredClone(remote); draft.daily.schedules[0].prompt = "local";
  Object.assign(s.routineState, { value: draft, dirty: true, revision: "r1", dirtyPaths: new Set(["daily.schedules.0.prompt"]) });
  const rules = s.automationRulesDraft;
  s.sensitiveApi = async (url, method, body) => {
    requests.push({ url, method, body: structuredClone(body) });
    if (method === "PATCH") throw Object.assign(new Error("conflict"), { status: 409 });
    return { ok: true, revision: "r2", routines: remote, catalog: [] };
  };
  await s.saveRoutines();
  check("409 refresh retains local draft and does not replay mutation", () => {
    assert.equal(s.routineState.value, draft); assert.equal(draft.daily.schedules[0].prompt, "local");
    assert.equal(s.routineState.conflict, true); assert.equal(s.routineState.revision, "r2"); assert.equal(s.routineState.dirty, true);
    assert.equal(requests.filter((item) => item.method === "PATCH").length, 1); assert.equal(s.automationRulesDraft, rules);
  });
  s.sensitiveApi = async (url, method, body) => {
    requests.push({ url, method, body: structuredClone(body) });
    return { ok: true, revision: "r3", routines: { ...remote, daily: { schedules: [{ time: "08:30", prompt: "local" }] } }, catalog: [] };
  };
  await s.saveRoutines();
  check("retry uses refreshed revision and only sparse leaves, preserving rules draft", () => {
    const saved = requests.filter((item) => item.method === "PATCH").at(-1);
    assert.deepEqual(plain(saved.body), { expectedRevision: "r2", routines: { daily: { schedules: [{ id: "daily-0", prompt: "local" }] } } });
    assert.equal(s.routineState.dirty, false); assert.equal(s.routineState.dirtyPaths.size, 0); assert.equal(s.automationRulesDraft, rules); assert(s.dirtyScopes.has("automation"));
  });
});

await group("routine-navigation-draft-marker", () => {
  const { state: s, context, nodes } = scopedUiRuntime();
  let marked = false;
  const nav = { dataset: { page: "automation" }, classList: { toggle(_class, value) { marked = value; } } };
  Object.assign(s, { dirtyScopes: new Set(), currentScope: () => "overview", scopeNames: {}, scopeFeedback: new Map(), conflictedScopes: new Set(), apiCenterConflicted: false });
  s.document.querySelectorAll = () => [nav];
  new vm.Script(adminFunction("renderSaveState")).runInContext(context);
  s.routineState.dirty = true; s.renderSaveState();
  check("routine-only draft remains visible when leaving automation and rerendering save state", () => {
    assert.equal(marked, true); assert.match(nodes.get("saveState").textContent, /原有例行规则/);
    s.renderSaveState(); assert.equal(marked, true);
  });
  s.routineState.dirty = false; s.dirtyScopes.add("automation"); s.renderSaveState();
  check("clearing routine draft does not clear an independent rules draft marker", () => assert.equal(marked, true));
});

await group("account-save-state-and-self-name", async () => {
  const { state: s, requests } = scopedUiRuntime();
  const draft = s.registryDraft("a");
  check("legacy self-name initially preserves existing account name", () => assert.equal(draft.value.selfName, "甲"));
  draft.value.displayName = "管理名称"; draft.value.selfName = "我";
  draft.dirty.add("displayName"); draft.dirty.add("selfName"); draft.dirty.add("style.systemPrompt");
  check("identity marks only real unsaved edits, not account selection", () => {
    assert.equal(s.registryDraftStatus("a", "identity").kind, "dirty");
    assert.equal(s.registryDraftStatus("b", "identity").kind, "saved");
  });
  let release;
  s.registryRequest = async (url, method, body) => { requests.push({ url, method, body: structuredClone(body) }); await new Promise(resolve => { release = resolve; }); return { revision: "r2" }; };
  const saving = s.saveRegistryPatch("a", s.registryTabKeys("identity"), "基本");
  check("pending request reports saving without clearing drafts", () => {
    assert.equal(s.registryDraftStatus("a", "identity").kind, "saving"); assert(draft.dirty.has("selfName"));
  });
  release(); await saving;
  check("successful save separates name/self-name and clears only saved tab", () => {
    assert.equal(requests[0].body.patch.displayName, "管理名称"); assert.equal(requests[0].body.patch.selfName, "我");
    assert.equal(s.registryItem("a").displayName, "管理名称"); assert.equal(s.registryItem("a").selfName, "我");
    assert.equal(s.registryDraftStatus("a", "identity").text, "基本已保存");
    assert.equal(s.registryDraftStatus("a").kind, "dirty"); assert(draft.dirty.has("style.systemPrompt"));
    assert(!draft.dirty.has("displayName") && !draft.dirty.has("selfName"));
  });
  draft.value.selfName = "另一自称"; draft.dirty.add("selfName");
  s.registryRequest = async () => { throw new Error("fixture error"); };
  await assert.rejects(s.saveRegistryPatch("a", s.registryTabKeys("identity"), "基本"), /fixture error/);
  check("failed saves retain independent self-name draft and show failure", () => {
    assert.equal(s.registryDraftStatus("a", "identity").kind, "failed"); assert(draft.dirty.has("selfName"));
    assert.equal(s.registryItem("a").selfName, "我"); assert.equal(draft.value.selfName, "另一自称");
  });
  s.registryRequest = async () => { const error = new Error("conflicting revision"); error.status = 409; throw error; };
  await assert.rejects(s.saveRegistryPatch("a", s.registryTabKeys("identity"), "基本"), /conflicting revision/);
  check("real HTTP 409 reports conflict instead of generic failure", () => assert.equal(s.registryDraftStatus("a", "identity").kind, "conflict"));
  draft.conflict = false; draft.saveState = null; draft.value.selfName = "提交的自称";
  s.registryRequest = async () => { await new Promise(resolve => { release = resolve; }); return { revision: "r3" }; };
  s.refreshAccountRegistry = async () => {
    Object.assign(s.registryItem("a"), structuredClone(draft.base));
    s.rebaseRegistryDraft("a", draft, s.registryItem("a"), "r3");
    return { items: s.registryState.items };
  };
  const delayed = s.saveRegistryPatch("a", s.registryTabKeys("identity"), "基本");
  draft.value.selfName = "请求期间继续编辑"; draft.dirty.add("selfName");
  release(); await delayed;
  check("edits during a successful save remain drafts without false conflicts", () => {
    assert.equal(draft.value.selfName, "请求期间继续编辑"); assert.equal(draft.base.selfName, "提交的自称");
    assert.equal(s.registryItem("a").selfName, "提交的自称"); assert(draft.dirty.has("selfName"));
    assert.equal(draft.conflict, false); assert.equal(s.registryDraftStatus("a", "identity").kind, "dirty");
  });
  check("self-name validation is independent and does not leak into connection saves", () => {
    s.registryValidate({ displayName: "管理名称", selfName: "" }, ["displayName", "selfName"]);
    assert.throws(() => s.registryValidate({ selfName: 1 }, ["selfName"]));
    assert.throws(() => s.registryValidate({ selfName: "字".repeat(101) }, ["selfName"]));
    assert(!s.registryTabKeys("connection").includes("selfName"));
    assert(!/\? "正在编辑" : "编辑账号"/.test(businessScript));
  });
});

await group("activity-preset-selected-state", () => {
  const nodes = new Map();
  const state = { dirtyScopes: new Set(), preservingDirtyFields: false,
    $: id => {
      if (!nodes.has(id)) {
        const classes = new Set(["secondary"]);
        nodes.set(id, { value: "", checked: false, type: id === "proactive.enabled" ? "checkbox" : id === "behaviorModes.default" || id.startsWith("preset") ? "text" : "number", attributes: {},
          setAttribute(key, value) { this.attributes[key] = value; }, classList: { toggle(key, value) { value ? classes.add(key) : classes.delete(key); }, contains: key => classes.has(key) } });
      }
      return nodes.get(id);
    }, scopeForElement: () => "qa:behavior", markDirty: scope => state.dirtyScopes.add(scope), toast() {}
  };
  const context = vm.createContext(state);
  new vm.Script(["setVal", "getVal", "activityPresetValues", "renderActivityPresetState", "applyPreset"].map(adminFunction).join("\n")).runInContext(context);
  check("restrained activity is moderately below normal and agrees with runtime defaults", () => {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
    const preset = defaults.behaviorModes.presets.restrained;
    const values = state.activityPresetValues("restrained"), normal = state.activityPresetValues("normal");
    assert.equal(values["trigger.activeProbability"], 0.08);
    assert.equal(values["proactive.probability"], 0.16);
    for (const key of ["trigger.activeProbability", "trigger.activeCooldownMs", "proactive.probability", "proactive.intervalMs", "proactive.cooldownMs"])
      assert.equal(values[key], key.split(".").reduce((value, part) => value[part], preset));
    assert(values["trigger.activeProbability"] < normal["trigger.activeProbability"]);
    assert(values["proactive.probability"] < normal["proactive.probability"]);
    assert(values["trigger.activeCooldownMs"] > normal["trigger.activeCooldownMs"]);
    assert(values["proactive.cooldownMs"] > normal["proactive.cooldownMs"]);
    assert(preset.socialPlanner.minConfidence > defaults.behaviorModes.presets.normal.socialPlanner.minConfidence);
  });
  for (const [kind, button] of [["normal", "presetNormal"], ["restrained", "presetRestrained"], ["lively", "presetLively"], ["normal", "presetNormal"]]) {
    state.applyPreset(kind);
    check(`${kind} button, mode, values, sliders and dirty scope agree`, () => {
      assert.equal(state.getVal("behaviorModes.default"), kind);
      for (const [id, value] of Object.entries(state.activityPresetValues(kind))) assert.equal(state.getVal(id), value);
      assert.equal(state.getVal("trigger.activeProbability.slider"), state.getVal("trigger.activeProbability"));
      assert.equal(state.getVal("proactive.probability.slider"), state.getVal("proactive.probability"));
      for (const id of ["presetNormal", "presetRestrained", "presetLively"]) {
        assert.equal(state.$(id).attributes["aria-pressed"], String(id === button));
        assert.equal(state.$(id).classList.contains("secondary"), id !== button);
      }
      assert.match(state.$("activityPresetState").textContent, /未保存/);
    });
  }
  state.preservingDirtyFields = true;
  for (const [id, value] of Object.entries(state.activityPresetValues("lively"))) state.setVal(id, value);
  state.renderActivityPresetState();
  check("automatic refresh retains pending preset and matching highlight", () => {
    assert.equal(state.getVal("behaviorModes.default"), "normal"); assert.equal(state.$("presetNormal").attributes["aria-pressed"], "true");
  });
  state.preservingDirtyFields = false; state.$("trigger.activeCooldownMs").value = 123456; state.renderActivityPresetState();
  check("custom parameters are labeled without silently resetting the mode", () => {
    assert.match(state.$("activityPresetState").textContent, /参数已自定义/); assert.equal(state.getVal("behaviorModes.default"), "normal");
  });
  state.dirtyScopes.clear(); state.renderActivityPresetState();
  check("saved state is distinct from pending draft", () => assert.match(state.$("activityPresetState").textContent, /已同步/));
});

await group("api-account-summary-refresh", async () => {
  const center = sampleCenter(); center.profiles[0].model = "mimo-live";
  center.profiles.push({ ...center.profiles[0], id: "p2", model: "deepseek-live" });
  const host = { children: [], textContent: "", replaceChildren() { this.children = []; this.textContent = ""; }, appendChild(node) { this.children.push(node); } };
  let revision = "r1", override = "p1", failed = false, groupPolicy = false;
  const state = {
    structuredClone, apiCenterSaved: center, cfg: { revision }, dirtyScopes: new Set(), conflictedScopes: new Set(),
    registryState: { items: [], groups: [], operations: new Map(), drafts: new Map(), contexts: {}, epoch: 0, modelLoadedAt: 0 },
    $: () => host, document: { createElement: () => ({ children: [], appendChild(node) { this.children.push(node); } }) },
    api: async (url) => {
      if (failed) throw new Error("offline");
      if (url.startsWith("/api/accounts")) return { revision, items: [{ id: "a", displayName: "A", modelBindings: { chat: override } }], failoverGroups: groupPolicy ? [{ id: "g", name: "共享策略", memberIds: ["a"], policy: { modelBindings: { chat: "p1" } } }] : [] };
      return { revision };
    },
    sensitiveApi: async () => ({ center }),
    registryItem(id) { return state.registryState.items.find((item) => item.id === (id || state.registryState.selected)); },
    registryGroup(id) { return state.registryState.groups.find((item) => item.memberIds.includes(id)); },
    registryEffective(item) { return { ...item, ...state.registryGroup(item.id)?.policy }; },
    fillConfig: () => {}, renderAutomationTargetPicker: () => {}, renderRegistryLists: () => {},
    renderRegistryEditor: () => {}, renderRegistryContexts: () => {}, renderRegistrySaveState: () => {}
  };
  const context = vm.createContext(state);
  new vm.Script(["apiBoundPlan", "renderApiAccountModels", "refreshAccountRegistry"].map(adminFunction).join("\n")).runInContext(context);
  const text = (node) => [node.textContent || "", ...(node.children || []).map(text)].join(" ");
  await state.refreshAccountRegistry();
  check("saved account summary follows first registry load", () => assert.match(text(host), /mimo-live/));
  revision = "r2"; override = "p2"; await state.refreshAccountRegistry();
  check("account refresh updates saved summary without opening API editor", () => assert.match(text(host), /问答：Plan · deepseek-live/));
  revision = "r3"; groupPolicy = true; await state.refreshAccountRegistry();
  check("group policy is labeled shared, not independent account override", () => {
    assert.match(text(host), /接管组「共享策略」共享/); assert.doesNotMatch(text(host), /账号单独指定/);
    assert.match(text(host), /问答：Plan · mimo-live/);
  });
  failed = true; await state.refreshAccountRegistry();
  check("failed account refresh removes stale model claims", () => {
    assert.match(text(host), /刷新失败/); assert.doesNotMatch(text(host), /mimo-live|deepseek-live/);
  });
});

await group("api-old-get-after-save-and-request-order", async () => {
  const t = apiRuntime(), s = t.state;
  let releaseOld;
  t.respond((_url, method, body) => method === "GET"
    ? new Promise(resolve => { releaseOld = resolve; })
    : { center: body.center, revision: "r2" });
  const oldRead = s.refreshApiCenter();
  s.apiCenterDraft.connections[0].name = "saved B"; s.apiCenterDirty = true;
  await s.saveApiCenter("apiConnectionSave");
  releaseOld({ center: sampleCenter(), revision: "r1" }); await oldRead;
  check("pre-save GET arriving after PATCH cannot roll back clean saved API draft or revision", () => {
    assert.equal(s.apiCenterRevision, "r2"); assert.equal(s.apiCenterDraft.connections[0].name, "saved B");
    assert.equal(s.apiCenterSaved.connections[0].name, "saved B"); assert.equal(s.apiCenterDirty, false);
  });
  const releases = [];
  t.respond(() => new Promise(resolve => releases.push(resolve)));
  const first = s.refreshApiCenter(), second = s.refreshApiCenter();
  const newest = sampleCenter(); newest.connections[0].name = "newest";
  releases[1]({ center: newest, revision: "r4" }); await second;
  releases[0]({ center: sampleCenter(), revision: "r3" }); await first;
  check("older overlapping API GET cannot replace a newer GET", () => assert.equal(s.apiCenterRevision, "r4"));
});

// Real save, readback, rebase and status functions; only transport and DOM are
// fixtures. Each request is bounded by a small microtask drain, never a timer.
function registryReadbackRuntime() {
  const t = scopedUiRuntime(), s = t.state, messages = [];
  const server = { revision: "r1", items: structuredClone(s.registryState.items) };
  Object.assign(s.registryState, { epoch: 0, operations: new Map(), modelLoadedAt: Date.now(), modelError: "" });
  Object.assign(s, { conflictedScopes: new Set(), fillConfig() {}, renderRegistryContexts() {}, renderApiAccountModels() {},
    registryFeedback: message => messages.push(message),
    api: async url => {
      if (t.beforeRead) await t.beforeRead(url);
      if (url.startsWith("/api/accounts?")) return structuredClone(server);
      assert.match(url, /^\/api\/config\?/); return { revision: server.revision };
    },
    sensitiveApi: async () => ({ center: {} }),
    registryRequest: async (_url, _method, body) => {
      if (t.beforePatch) await t.beforePatch();
      Object.assign(server.items[0], structuredClone(body.patch)); server.revision = "r2";
      ++s.registryState.epoch;
      if (t.afterPatch) t.afterPatch(server);
      return { revision: "r2" };
    }
  });
  new vm.Script(adminFunction("refreshAccountRegistry")).runInContext(t.context);
  return Object.assign(t, { server, messages });
}

await group("registry-save-confirmation-races-and-failures", async () => {
  {
    const t = registryReadbackRuntime(), s = t.state, d = s.registryDraft("a"), listStates = [];
    s.renderRegistryLists = () => listStates.push(d.dirty.size);
    d.value.style.systemPrompt = "confirmed clean save"; d.dirty.add("style.systemPrompt");
    await s.saveRegistryPatch("a", ["style"], "风格");
    check("confirmed clean save redraws account list without a stale draft badge", () => {
      assert(listStates.length > 0); assert.equal(listStates.at(-1), 0);
    });
  }
  for (const contextSave of [false, true]) for (const failure of ["read-failure", "mismatch", "success"]) {
    const t = registryReadbackRuntime(), s = t.state, d = s.registryDraft("a");
    d.value.style.systemPrompt = "submitted B"; d.dirty.add("style.systemPrompt");
    d.value.features.chat = false; d.dirty.add("features.chat");
    let releasePatch;
    t.beforePatch = () => new Promise(resolve => { releasePatch = resolve; });
    if (failure === "read-failure") t.beforeRead = () => { throw new Error("readback unavailable"); };
    if (failure === "mismatch") t.afterPatch = server => { server.items[0].style.systemPrompt = "wrong server value"; };
    const saving = contextSave ? s.saveRegistryContext("qa") : s.saveRegistryPatch("a", ["style"], "风格");
    const rejected = failure === "success" ? saving : assert.rejects(saving, /readback unavailable|保存核对不一致/);
    d.value.style.systemPrompt = "newer C"; d.dirty.add("style.systemPrompt");
    releasePatch(); await rejected;
    check(`${contextSave ? "context" : "tab"} ${failure} preserves new and unrelated drafts`, () => {
      assert.equal(d.value.style.systemPrompt, "newer C"); assert(d.dirty.has("style.systemPrompt"));
      assert.equal(d.value.features.chat, false); assert(d.dirty.has("features.chat"));
      assert.equal(d.base.style.systemPrompt, "submitted B");
      if (failure === "success") assert.equal(d.conflict, false);
      else {
        assert.match(t.messages.at(-1), /已提交，但未通过保存核对/); assert(!t.messages.some(message => /已保存/.test(message)));
        assert.equal(d.saveState.status, "unverified"); assert.match(s.registryDraftStatus("a", "style").text, /已提交但未核实/);
      }
    });
  }
  // A submitted, unchanged leaf also stays dirty on failure (not only C).
  for (const contextSave of [false, true]) {
    const t = registryReadbackRuntime(), s = t.state, d = s.registryDraft("a");
    d.value.style.systemPrompt = "submitted B"; d.dirty.add("style.systemPrompt");
    t.beforeRead = () => { throw new Error("readback unavailable"); };
    await assert.rejects(contextSave ? s.saveRegistryContext("qa") : s.saveRegistryPatch("a", ["style"], "风格"));
    check(`unchanged ${contextSave ? "context" : "tab"} submission stays dirty on read failure`, () => {
      assert.equal(d.value.style.systemPrompt, "submitted B"); assert(d.dirty.has("style.systemPrompt"));
    });
  }
  const t = registryReadbackRuntime(), s = t.state, d = s.registryDraft("a");
  let releaseOld; let reads = 0;
  t.beforeRead = async url => {
    if (url.startsWith("/api/accounts?") && ++reads === 1) await new Promise(resolve => { releaseOld = resolve; });
  };
  const oldRead = s.refreshAccountRegistry();
  for (let turn = 0; turn < 100 && !releaseOld; turn++) await Promise.resolve();
  assert.ok(releaseOld, "old registry read reached boundary");
  d.value.style.systemPrompt = "submitted B"; d.dirty.add("style.systemPrompt");
  let finished = false;
  const saving = s.saveRegistryPatch("a", ["style"], "风格").then(() => { finished = true; });
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  assert.equal(finished, false);
  releaseOld(); await oldRead; await saving;
  check("shared pre-save registry refresh cannot substitute for a fresh post-save read", () => {
    assert(reads >= 3); assert.equal(d.dirty.has("style.systemPrompt"), false);
    assert.equal(s.registryItem("a").style.systemPrompt, "submitted B");
  });
});

await group("generic-numeric-boolean-acknowledgement-mismatches", async () => {
  const cases = [
    ["qa", "socialPlanner.timeoutMs", 1234], ["qa", "socialPlanner.shadowMode", true],
    ["qa", "messageDebounce.baseWaitMs", 1234], ["qa", "messageDebounce.enabled", true],
    ["qa", "responseQueue.liveContext.windowMs", 1234], ["qa", "responseQueue.liveContext.enabled", true],
    ["tasks", "taskMode.maxTurns", 12], ["archive", "chatArchive.enabled", true],
    ["archive", "chatArchive.maxRetrieveItems", 1234],
    ["memory", "memory.integrity.maxEntriesPerUser", 123], ["memory", "memory.integrity.enabled", true],
    ["vision", "vision.maxImagesPerMessage", 3], ["vision", "vision.enabled", true]
  ];
  for (const [page, field, value] of cases) for (const boundary of ["ack", "readback"]) {
    const t = configUiRuntime(), s = t.state;
    s.activePage = page; t.edit(field, value); s.markDirty(page === "qa" ? "qa:behavior" : page);
    const work = s.saveConfig(), rejected = assert.rejects(work, /保存核对不一致/, `${field} ${boundary}`);
    await t.waitForPatch(0);
    const response = t.commit(0, "r2");
    const target = boundary === "ack" ? response.config : s.server;
    const parts = field.split("."); let parent = target;
    for (const part of parts.slice(0, -1)) parent = parent[part];
    // Exercise dropped values at readback, clipped/flipped values at ACK.
    if (boundary === "readback") delete parent[parts.at(-1)];
    else parent[parts.at(-1)] = typeof value === "boolean" ? !value : value + 1;
    t.reply(0, response); await rejected;
    check(`${field} ${boundary} mismatch cannot clear or claim success`, () => {
      assert(s.dirtyScopes.has(page === "qa" ? "qa:behavior" : page));
      assert.equal(s.getVal(field), value); assert(!t.feedback.some(message => /已保存/.test(message)));
    });
  }
  const t = configUiRuntime();
  check("scalar validation intentionally permits text and QQ ID list canonicalization", () => {
    t.state.verifyConfigSaved({ scope: { groupIds: [12345] }, name: " padded " }, { scope: { groupIds: ["12345"] }, name: "padded" });
  });
});

console.log(JSON.stringify({ ok: true, assertions, groups, baselineIds: legacyBusinessIds.length,
  offline: true, sourceReadOnly: true, bridgeStarted: false, liveDataTouched: false }));
