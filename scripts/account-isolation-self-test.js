import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { accountGroup, accountItems, accountPolicy, accountScopeAllows, effectiveAccount, normalizeAccountRegistry, registryConfig } from "../src/account-registry.js";
import { accountCanChat, accountCanOfferTask, accountTopology, configForAccountCapabilities, accountKeywordMatches } from "../src/bot-capabilities.js";
import { botCommandFeedback, botCommandText, groupCommandBots, routeBotCommand } from "../src/bot-command-routing.js";
import { normalizeVoiceReplyMode, voiceReplyMode } from "../src/voice-mode.js";
import { accountDeliveryDecision, GroupSendCoordinator } from "../src/account-delivery.js";
import { ReplyCoordinator } from "../src/reply-coordinator.js";
import { projectBehaviorSettings, normalizeBehaviorSelection } from "../src/behavior-settings.js";
import { automationForAccount } from "../src/account-automation.js";
import { AccountRuntime, logicalBotId, botConversationKey, botControlRevision } from "../src/account-runtime.js";
import { replyDeliveryConfig } from "../src/reply-execution.js";
import { reconcileMemoryInPlace } from "../src/memory-state.js";
import { socialAgentConfig } from "../src/social-agent-state.js";
import { discoveryUsedIds, discoveryPlanEvidence } from "../src/social-discovery-context.js";
import { socialExperienceFor } from "../src/social-experience-policy.js";
import { evaluateConversationTurn } from "../src/conversation-turn-manager.js";
import { parseReplyPlan, replyPlanPrompt } from "../src/reply-plan.js";
import { executeReplyPlan } from "../src/expression-renderer.js";
import { ExpressionDiagnostics } from "../src/social-expression-diagnostics.js";
import { isQzoneAction, qzoneActionKind, isUnmanagedFavoriteWrite } from "../src/qzone-delivery.js";
import { recordSocialEpisode } from "../src/social-episodes.js";
import { recordOwnerInteraction } from "../src/owner-interactions.js";

// Read source only. Never import/start main(), open sockets, spawn a service,
// read live config/state, or persist anything. The complete real message callback
// and named bridge functions run in a VM; only their external boundaries are fake.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/bridge.js"), "utf8");
const A = "fixture-alpha", B = "fixture-beta", G = "810101", HUMAN = "10001";
const QQ = { [A]: "91001", [B]: "91002" };
let assertions = 0;
const results = [];
const check = new Proxy(assert, { get(target, key) {
  const value = target[key];
  return typeof value === "function" ? (...args) => { assertions += 1; return value(...args); } : value;
} });

function functionSource(name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, "m").exec(source);
  if (!match) throw new Error(`bridge function missing: ${name}`);
  // Project functions use consistent indentation: the closing function brace
  // is on its own line at the declaration's indentation, unlike nested blocks.
  const end = source.indexOf(`\n${match[1]}}\n`, match.index);
  if (end < 0) throw new Error(`bridge function end missing: ${name}`);
  return source.slice(match.index, end + match[1].length + 2);
}
const handlerStart = source.indexOf('    ws.on("message", async (raw) => {');
const handlerEnd = source.indexOf('\n    ws.on("close",', handlerStart);
if (handlerStart < 0 || handlerEnd < 0) throw new Error("real OneBot message callback missing");
const handlerSource = source.slice(handlerStart, handlerEnd).trim();
const closeEnd = source.indexOf('\n    });', handlerEnd);
if (closeEnd < 0) throw new Error("real OneBot close callback missing");
const closeSource = source.slice(handlerEnd, closeEnd + '\n    });'.length).trim();
const timerStart = source.indexOf("      const timer = setInterval(async () => {", closeEnd);
const timerEnd = source.indexOf("      }, intervalMs);", timerStart);
if (timerStart < 0 || timerEnd < 0) throw new Error("real proactive interval missing");
const timerSource = source.slice(timerStart, timerEnd + "      }, intervalMs);".length);

function fixtureConfig() {
  const config = registryConfig({
    accounts: { topology: "collaboration", primary: { id: A, qq: QQ[A], protocol: "napcat", displayName: "Alpha" },
      standbys: [{ id: B, qq: QQ[B], protocol: "napcat", displayName: "Beta" }],
      failover: { autoAdoptUnknownStandby: false }, diagnostics: { peerPingFreshMs: 30000, peerPingReceiveTimeoutMs: 5000 } },
    trigger: { activeReply: false, activeProbability: 0, replyToAt: true, replyToKeywords: true, keywords: ["fixture-keyword"], ignoreOwnMessages: true },
    behaviorModes: { default: "normal", presets: {
      normal: { trigger: { activeReply: false, activeProbability: 0.15 } },
      lively: { trigger: { activeReply: true, activeProbability: 0.9 }, reply: { fixtureStyle: "lively" } },
      restrained: { trigger: { activeReply: false, activeProbability: 0.01 }, reply: { fixtureStyle: "restrained" } }
    } },
    botNames: ["fixture-keyword"], socialPlanner: { enabled: false, shadowMode: false }, implicitReply: { enabled: true },
    messageDebounce: { enabled: false }, commands: { enabled: true },
    voice: { enabled: true, replyMode: "mixed", asr: { enabled: false }, tts: { enabled: true } },
    webSearch: { enabled: false }, automation: { enabled: false }, proactive: { enabled: false },
    reply: { useContextBundle: false }, prompt: { system: "fixture base" },
    send: { privateMinIntervalMs: 0 }, history: { maxMessages: 120 }, status: { onebotStaleMs: 90000 }
  });
  config.__activeAccountId = A;
  for (const account of config.accounts.items) {
    account.enabled = true;
    account.protocolEnabled = true;
    account.features = { ...account.features, chat: true, task: false, proactive: false, automation: false, asr: false };
    account.style = { systemPrompt: account.id === A ? "fixture persona Alpha" : "fixture persona Beta" };
    account.voice = { mode: "mixed" };
    account.behaviorMode = "";
  }
  return config;
}

const realFunctions = [
  "asStringId", "asArray", "clampText", "safePathSegment", "now", "canonicalSocialConversation", "accountProtocol", "oneBotBinding", "oneBotBindingCurrent", "clearOneBotActionsForSocket",
  "groupMemory", "groupSettings", "normalizeBehaviorMode", "behaviorMode", "behaviorModeLabel", "behaviorModeDescription", "applyBehaviorMode", "socialPlannerConfig",
  "configuredAccountDefinitions", "accountFailoverConfig", "accountById", "configForReplyAccount", "configForGroupAccount",
  "syncAccountKernel", "accountExecutionRevision", "accountMemoryControlRevision", "accountRuntimeContext", "accountRuntimeContextCurrent", "accountRuntimeIdentityCurrent", "botStateKey",
  "setDefaultTransport", "selectLogicalCarrier",
  "oneBotAccountState", "accountStateById", "configuredAccountBySelfId", "chooseUnboundStandbyAccount", "identifyOneBotAccount", "accountConnected",
  "accountIsSelected", "accountSelectedSnapshot", "connectedAccountForRole", "dispatchAccountAction",
  "parsePeerPingMessage", "accountActualQq", "acceptPeerPing", "sendPeerPing", "botAccountUserIds", "probeOneBotAccount",
  "accountSendState", "recordAccountSend", "abilityItem", "abilityFresh", "accountStateLabel", "routingActionForState", "diagnoseAccount", "oneBotStatusValue", "oneBotStatusFlagIsFalse",
  "conversationIdFromEvent", "conversationLabelFromEvent", "oneBotMessageToText", "messageMentionsSelf", "stripSelfMention", "stripBotAddressing", "escapeRegExp", "hasKeyword",
  "stableMessageFingerprint", "accountScopedInboundKey", "claimConversationMessage", "messageTiming", "extractReplyMessageIds", "recordPeopleSourceObservation",
  "messageDebounceConfig", "isLikelyIncompleteInput", "shouldWaitForMoreInput", "flushDebouncedMessage", "enqueueDebouncedMessage", "pendingDebouncedContext", "orderedHistory", "mergeReplyCurrents",
  "quietUntil", "isQuiet", "repairInvalidQuietUntil", "parseDurationMs", "formatDuration", "isGroupAdmin", "handleBotCommand", "handleMemoryVerificationCommand",
  "sameLogicalAccount", "recordBotMessage", "lastBotMessageForAccount", "sendGroupMessage", "aiVoicePlanAllowed", "deliverChatExpression", "lastNonBotMessage", "lastNonBotMessagesSince", "scoreImplicitReplyAgainstBotMessage", "isMediaOnlyText"
];

function harness(config = fixtureConfig(), mutation = {}) {
  let clock = 1_900_000_000_000;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const jobs = [], sends = [], warnings = [], prompts = [], archived = [], decisions = [], timers = new Map();
  const seen = new Map();
  const noop = () => {};
  const forbidden = (name) => () => { throw new Error(`unmocked external boundary: ${name}`); };
  const context = vm.createContext({
    Date: FakeDate, structuredClone, randomBytes, AbortController,
    socialExperienceFor, evaluateConversationTurn, parseReplyPlan, replyPlanPrompt, executeReplyPlan,
    expressionStickersFor: () => null,
    expressionReactionsFor: () => null,
    expressionNativeFor: () => null,
    nativePokeBindings: new WeakMap(),
    isQzoneAction, qzoneActionKind, isUnmanagedFavoriteWrite,
    recordSocialEpisode, socialEpisodeDeliveredProvider: async () => {},
    recordOwnerInteraction: (root, args) => recordOwnerInteraction(root, structuredClone(args)),
    ownerServices: { router: { handle: async () => ({ matched: true, status: "blocked", code: "OWNER_IDENTITY_REQUIRED" }) } },
    expressionDiagnostics: new ExpressionDiagnostics(),
    logicalBotId, botConversationKey, botControlRevision, replyDeliveryConfig,
    accountKernel: new AccountRuntime(config), kernelConfigRevision: 1, pendingReplyHandoffs: [],
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    accountGroup, accountItems, accountPolicy, accountScopeAllows, effectiveAccount, normalizeAccountRegistry, automationForAccount,
    accountDeliveryDecision, groupSendCoordinator: new GroupSendCoordinator({ minDelayMs: () => 0 }),
    accountCanChat, accountCanOfferTask, accountTopology, configForAccountCapabilities,
    botCommandFeedback, botCommandText, groupCommandBots, routeBotCommand, normalizeVoiceReplyMode, voiceReplyMode,
    config, liveConfig: config, memory: { groups: {} }, configRevision: 1,
    runtimeStatus: { bridgeStartedAt: clock - 10000, activeMessageCount: 0, oneBotMessageCount: 0, duplicateMessageCount: 0 },
    activeAccountId: A, activeOneBotWs: null, pendingAccountSwitchGroupNotice: null,
    oneBotAccounts: new Map(), wsAccountIds: new Map(), forwardOneBotRuntime: new Map(),
    accountProbeCache: new Map(), accountPeerPing: new Map(), accountSendRuntime: new Map(), activeGroupAccounts: new Map(),
    pendingOneBotActions: new Map(), oneBotSendTrackers: new Map(), oneBotSendRuntime: {},
    historyByGroup: new Map(), lastEventByGroup: new Map(), lastBotMessageByGroup: new Map(), lastActiveReplyAt: new Map(),
    storedConversationMessages: new Map(), taskControlSeen: new Map(), messageDebounceRuntime: new Map(), privateMessageCooldowns: new Map(),
    delayedUnderstandingByGroup: new Map(), lastProactiveAt: new Map(),
    groupBotMembership: { observe: noop, invalidate: noop, isCurrent: () => true,
      members: async () => ({ qqs: context.roster }) },
    roster: [QQ[A], QQ[B], HUMAN],
    log: noop, debug: noop, warn: (message) => warnings.push(message), logIncomingMessage: noop,
    mutateMemory: async (state, build) => {
      const draft = structuredClone(state), result = build(draft);
      assert(!result?.then, "transaction builders must remain synchronous");
      reconcileMemoryInPlace(state, draft);
      return result;
    }, saveConfig: forbidden("saveConfig"),
    accountProbeSummary: (id) => context.accountProbeCache.get(id) || null,
    qrFileInfoForAccount: () => ({ exists: false }), accountWebuiInfoForAccount: () => ({}),
    selectedGroupAccount: (group) => group.memberIds[0],
    primaryRecoveryBlockedReason: () => "", primaryReceiveStalledReason: () => "",
    markInboundSeen: (key, value) => { const previous = seen.get(key); seen.set(key, value); return previous; },
    shouldHandleGroup: () => true, shouldHandlePrivate: () => true, isPrivateOwner: () => false,
    handleOwnerPrivateControlCommand: async () => false,
    // Existing isolation fixtures leave the additive social agent disabled.
    // Resolve the real policy instead of swallowing any new planner calls.
    socialAgentConfig,
    socialPolicy: id => socialAgentConfig(effectiveAccount(config, id)?.socialAgent),
    socialEnabled: (id, conversationId) => {
      const policy = socialAgentConfig(effectiveAccount(config, id)?.socialAgent);
      return policy.enabled && policy.conversationIds.includes(context.canonicalSocialConversation(conversationId));
    },
    socialScopes: new Map(), socialKey: ctx => JSON.stringify([ctx.logicalId, ctx.conversationId]),
    socialRuntime: { cancel: noop, observe: forbidden("unexpected social agent planner") },
    // Human intake updates/cancels discovery even when automatic collection
    // is disabled. Keep these boundaries account-owned, like the real runtime.
    discoveryLastHuman: new Map(), discoveryLastGroupEvent: new Map(),
    discoveryCancellations: [], discoveryRuntime: { cancel: owner => context.discoveryCancellations.push(owner) },
    discoveryUsedIds, discoveryPlanEvidence, discoveryItemsFor: () => [], discoveryDeliveredProvider: async () => [],
    taskRuntime: { get: () => null }, handleTaskControl: async () => false,
    replyCoordinator: { observeMessage: () => ({ absorbed: false }), dropSenderJobs: noop, enqueue: (job) => jobs.push(job),
      refreshLogicalBot: noop, invalidateLogicalBot: noop },
    resolveQuotedMessages: async () => ({ refs: [], contexts: [], texts: [], audioMessages: [] }),
    extractImageRefs: () => [], normalizeImageRefIndexes: (refs) => refs, extractRecordRefs: () => [],
    projectBehaviorSettings, normalizeBehaviorSelection, accountKeywordMatches,
    maybeDescribeImages: async () => [], appendImageDescriptions: (text) => text, redactSensitive: (text) => text,
    archiveConversationEvent: (event) => archived.push(event), archiveBotReply: noop,
    updateMemoryFromMessage: noop, addPendingMemoryMessage: noop, applyConversationFeedback: noop, summarizeOlderHistory: noop, maybeUpdateMemoryWithAI: noop,
    updateBotSelfMemoryFromMessage: () => false, botDisplayName: (c) => c.persona?.displayName || "fixture",
    detectVoiceReplyIntent: () => null, shouldJudgeVoiceReplyIntent: () => false, handleVoiceCommand: forbidden("voice command"),
    buildContextBundle: () => ({}), compactMemory: () => "", buildArchiveContext: () => ({ used: false, text: "" }),
    detectWebSearchRequest: () => ({ matched: false }), judgeWebSearchWithAI: async (candidate) => candidate,
    detectImplicitReplyToBot: () => context.implicitDecision,
    implicitDecision: { matched: false, confidence: 0, reason: "fixture negative" },
    detectDiscussionSignal: () => context.discussionDecision,
    discussionDecision: { matched: false, reason: "fixture negative" },
    judgeSocialActionWithAI: async ({ config: c }) => { decisions.push(c); return context.socialDecision; },
    socialDecision: { action: "observe", requestedAction: "observe", intent: "discussion", confidence: 0.9 },
    rememberSocialDecision: noop, detectDelayedUnderstandingCandidate: () => ({ matched: false }),
    shouldSkipProactiveReply: () => ({ skip: false }), scheduleDelayedUnderstandingReply: forbidden("unexpected delayed reply"),
    withinActiveHours: () => true, handlesAllGroups: () => true, targetGroups: () => [G],
    setInterval: (callback) => { timers.set(context.ws.__hermesAccountId, callback); return timers.size; },
    buildPrompt: (input) => { prompts.push(input); return "fixture prompt"; }, callHermes: async () => "fixture reply",
    learningPromptForConversation: () => "", trimForGroup: (text) => String(text), shouldSendVoiceReply: () => false,
    relatedUserIdsFromText: () => [], maybeInterBotFollowup: async () => {},
    oneBotSend: (ws, action, params) => { sends.push({ accountId: ws.__hermesAccountId, action, params }); return true; },
    oneBotRequest: forbidden("OneBot request"), sleep: async () => {}, clearTimeout: noop,
    checkAdminStatusNotification: noop
  });
  context.collectMemory = context.mutateMemory;
  for (const name of realFunctions) new vm.Script(mutation.functions?.[name] || functionSource(name), { filename: `bridge.js:${name}` }).runInContext(context);
  function socket() {
    const callbacks = new Map();
    return { readyState: 1, on: (name, fn) => callbacks.set(name, fn),
      close() { this.readyState = 3; callbacks.get("close")?.(); }, callbacks };
  }
  function connect(id, ws = socket()) {
    const state = context.identifyOneBotAccount(ws, { self_id: QQ[id] });
    ws.__hermesDispatch = (action, params, send, binding) => context.dispatchAccountAction(ws, action, params, send, binding);
    context.accountProbeCache.set(id, { ok: true, checkedAt: clock, loginInfo: { user_id: QQ[id] }, status: { online: true, good: true } });
    context.ws = ws;
    // Each real connection callback closes over its own WS (not a mutable VM
    // global subsequently replaced by another fixture connection).
    new vm.Script(`((ws) => {\n${mutation.handler || handlerSource}\n${closeSource}\n})(ws)`, { filename: "bridge.js:OneBot-callbacks" }).runInContext(context);
    return state;
  }
  let sequence = 0;
  async function emit(id, text = "ordinary unrelated fixture statement", options = {}) {
    const ws = context.oneBotAccounts.get(id)?.ws;
    if (!ws?.callbacks.get("message")) throw new Error(`fixture socket missing: ${id}`);
    const mentions = options.mentions || [];
    const event = { post_type: "message", message_type: options.private ? "private" : "group",
      self_id: QQ[id], user_id: options.userId || HUMAN, group_id: G,
      sender: { nickname: "fixture human", role: "admin" }, message_id: options.messageId || ++sequence,
      time: Math.floor(clock / 1000), message: [...mentions.map((target) => ({ type: "at", data: { qq: QQ[target] } })), { type: "text", data: { text } }],
      ...options.event };
    await ws.callbacks.get("message")(JSON.stringify(event));
    check.deepEqual(warnings, [], "real callback must not swallow missing mocks/errors");
    return event;
  }
  async function execute(job = jobs.at(-1)) {
    if (!job) throw new Error("expected real queued job missing");
    const result = await job.execute({ job: { ...job, contextRevision: 0 }, revision: 0, signal: new AbortController().signal });
    check.deepEqual(warnings, [], "real generation must not swallow missing mocks/errors");
    return result;
  }
  return { c: context, config, jobs, sends, prompts, archived, decisions, warnings, socket, connect, emit, execute,
    attachProactive: (id) => {
      context.ws = context.oneBotAccounts.get(id).ws;
      new vm.Script(`((ws) => { const intervalMs = 1;\n${timerSource}\n})(ws)`, { filename: "bridge.js:proactive-timer" }).runInContext(context);
    }, tick: (id) => timers.get(id)(),
    advance: (ms) => { clock += ms; }, time: () => clock };
}

async function test(name, run) {
  const before = assertions;
  try { await run(); results.push({ name, ok: true, assertions: assertions - before }); }
  catch (error) { results.push({ name, ok: false, assertions: assertions - before, error: String(error.stack || error).slice(0, 1800) }); }
}

await test("1 reverse WS identity/rebind/session isolation", async () => {
  const h = harness(), { c } = h;
  const ws = h.socket();
  const pending = c.identifyOneBotAccount(ws, {});
  check.notEqual(pending.id, A, "B-first unconfirmed reverse WS cannot borrow A");
  check.equal(pending.enabled, false);
  check.equal(c.oneBotAccounts.get(A)?.ws, undefined);
  c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  check.equal(c.oneBotAccounts.get(B).ws, ws);
  check.notEqual(c.oneBotAccounts.get(pending.id)?.ws, ws, "clear pending reference on identification");
  // Exercise configured A -> B rebinding as well, with another newer A socket.
  const old = h.connect(A).ws;
  c.identifyOneBotAccount(old, { self_id: QQ[B] });
  check.equal(c.oneBotAccounts.get(A).ws, null, "clear old configured account socket");
  check.equal(c.oneBotAccounts.get(A).connected, false);
  c.accountPeerPing.set(B, { receivedAt: h.time() });
  c.accountSendState(B).lastSendFailedAt = h.time();
  // A real replacement initiates close; the old close event can arrive later.
  old.close = () => { old.readyState = 2; };
  const replacement = h.connect(B).ws;
  check.notEqual(replacement, old);
  check.equal(c.accountPeerPing.has(B), false, "new session discards peer evidence");
  check.equal(c.accountSendRuntime.has(B), false, "new session discards send evidence");
  if (old.callbacks.has("message")) await old.callbacks.get("message")(JSON.stringify({ self_id: QQ[B], post_type: "meta_event" }));
  check.equal(c.oneBotAccounts.get(B).ws, replacement, "late old frame cannot retake identity");
  old.readyState = 3; old.callbacks.get("close")();
  check.equal(c.oneBotAccounts.get(B).ws, replacement, "late old close cannot disconnect replacement");
  const deferred = [];
  c.oneBotRequest = (ws, action) => new Promise((resolve) => deferred.push(() => resolve(action === "get_login_info" ? { user_id: QQ[B] } : { online: true, good: true })));
  const staleProbe = c.probeOneBotAccount(B);
  const newer = h.connect(B).ws;
  deferred.forEach((done) => done());
  const probe = await staleProbe;
  check.equal(probe.ok, false, "in-flight probe must not verify a superseded session");
  check.match(probe.error, /connection changed/);
  check.equal(c.oneBotAccounts.get(B).ws, newer);
  check.equal(c.accountProbeCache.get(B).ok, true, "stale completion cannot overwrite new-session probe");
  for (const topology of ["collaboration", "function_split"]) {
    const f = harness(); f.config.accounts.topology = topology;
    const reverse = f.socket();
    f.c.identifyOneBotAccount(reverse, {});
    f.c.ws = reverse;
    new vm.Script(`((ws) => { ${handlerSource}\n${closeSource} })(ws)`).runInContext(f.c);
    await reverse.callbacks.get("message")(JSON.stringify({ post_type: "meta_event", self_id: QQ[B] }));
    check.equal(f.c.activeOneBotWs, reverse, `${topology}: first identified B initializes active reference without polling`);
    check.equal(f.c.activeAccountId, B);
    check.notEqual(f.c.oneBotAccounts.get(A)?.ws, reverse);
    const alphaSocket = f.connect(A).ws;
    f.c.activeOneBotWs = alphaSocket; f.c.activeAccountId = A;
    await alphaSocket.callbacks.get("message")(JSON.stringify({ post_type: "meta_event", self_id: QQ[B] }));
    check.equal(f.c.oneBotAccounts.get(A).ws, null);
    check.equal(f.c.activeOneBotWs, alphaSocket, `${topology}: confirmed rebind initializes new active account`);
    check.equal(f.c.activeAccountId, B);
    await alphaSocket.callbacks.get("message")(JSON.stringify({ post_type: "meta_event", self_id: "91999" }));
    check.equal(f.c.oneBotAccounts.get(B).ws, null);
    check.notEqual(f.c.activeOneBotWs, alphaSocket, `${topology}: unknown identity clears old active reference`);
    check.deepEqual(f.warnings, []);
  }
});

await test("human intake cancels discovery only for its logical account", async () => {
  const h = harness(), { c } = h;
  const alpha = logicalBotId(h.config, A), beta = logicalBotId(h.config, B);
  h.connect(A); h.connect(B);
  await h.emit(A);
  check.deepEqual([...c.discoveryLastHuman.keys()], [alpha]);
  check.deepEqual([...c.discoveryCancellations], [alpha]);
  check.equal(c.discoveryLastGroupEvent.has(JSON.stringify([alpha, `group:${G}`])), true);
  check.equal(c.discoveryLastGroupEvent.has(JSON.stringify([beta, `group:${G}`])), false);
  h.advance(1000);
  await h.emit(B, "private fixture question", { private: true });
  check.equal(c.discoveryLastHuman.get(alpha), h.time() - 1000);
  check.equal(c.discoveryLastHuman.get(beta), h.time());
  check.deepEqual([...c.discoveryCancellations], [alpha, beta]);
  check.equal(c.discoveryLastGroupEvent.size, 1, "private intake must not publish group discovery context");
  await h.emit(A, "peer bot fixture", { userId: QQ[B] });
  check.deepEqual([...c.discoveryCancellations], [alpha, beta], "peer bot events must not count as human intake");
});

await test("shared expression fastpath uses real policy/ACKs and stops a burst on quiet", async () => {
  for (const quietAfterFirst of [false, true]) {
    const cfg = fixtureConfig();
    cfg.accounts.items.find(item => item.id === A).socialExperience = {
      enabled: true, shadowMode: false, conversationIds: [`group:${G}`],
      expression: { minIntervalMs: 0, maxIntervalMs: 0 }
    };
    const h = harness(cfg);
    h.connect(A); h.connect(B);
    const delivered = [];
    h.c.archiveBotReply = row => delivered.push(row);
    let calls = 0;
    h.c.callHermes = async () => { calls++; return JSON.stringify({ version: 1, action: "reply", replyToMessageId: null,
      messages: [{ type: "text", content: "第一句，保留完整链接 https://example.test/a?b=1" }, { type: "text", content: "第二句 👩‍💻" }] }); };
    h.c.oneBotRequest = (ws, action, params, options) => ws.__hermesDispatch(action, params, () => {
      h.sends.push({ accountId: ws.__hermesAccountId, action, params });
      if (quietAfterFirst) h.c.groupSettings(h.c.memory, G, h.c.configForReplyAccount(h.c.accountById(h.config, A)), { write: true }).quietUntil = h.time() + 60000;
      return Promise.resolve({ message_id: 200 + h.sends.length });
    }, options.binding);
    await h.emit(A, "fixture question?", { mentions: [A] });
    const result = await h.execute();
    check.equal(result.sent, true);
    check.equal(calls, 1, "expression must not add a serial model call");
    check.equal(h.sends.length, quietAfterFirst ? 1 : 2);
    check.equal(result.partial, quietAfterFirst);
    check.equal(delivered.length, h.sends.length, "archive only confirmed bubbles");
    check.ok(h.sends.every(row => row.accountId === A && Array.isArray(row.params.message)));
    check.equal(h.c.expressionDiagnostics.snapshot().plans, 1);
  }
});

await test("unknown expression ACK is never promoted to delivery or memory", async () => {
  const cfg = fixtureConfig();
  cfg.accounts.items.find(item => item.id === A).socialExperience = { enabled: true, shadowMode: false, conversationIds: [`group:${G}`] };
  const h = harness(cfg);
  h.connect(A);
  const delivered = [];
  h.c.archiveBotReply = row => delivered.push(row);
  h.c.callHermes = async () => "synthetic response";
  h.c.oneBotRequest = async () => ({});
  await h.emit(A, "fixture question?", { mentions: [A] });
  const result = await h.execute();
  check.equal(result.sent, false);
  check.equal(result.uncertain, true);
  check.equal(delivered.length, 0);
  check.equal(h.c.lastBotMessageByGroup.size, 0);
});

await test("2 private diagnostic authenticity, freshness, replay, ACK race", async () => {
  const h = harness(), { c } = h;
  h.connect(A); const beta = h.connect(B);
  const expected = () => ({ expectedAt: h.time(), expectedFrom: A, expectedToken: "fixture-token" });
  const ping = { from: A, to: B, token: "fixture-token" };
  const event = { message_type: "private", user_id: QQ[A] };
  const invalid = [
    ["group spoof", { ...event, message_type: "group" }, ping],
    ["wrong sender QQ", { ...event, user_id: HUMAN }, ping],
    ["wrong source", event, { ...ping, from: B }],
    ["wrong target", event, { ...ping, to: A }],
    ["wrong token", event, { ...ping, token: "forged" }]
  ];
  for (const [label, e, p] of invalid) {
    c.accountPeerPing.set(B, expected());
    check.equal(c.acceptPeerPing(beta, e, p), false, label);
    check.equal(c.accountPeerPing.get(B).receivedAt, undefined, `${label}: no health evidence`);
  }
  c.accountPeerPing.delete(B);
  check.equal(c.acceptPeerPing(beta, event, ping), false, "unsolicited token");
  c.accountPeerPing.set(B, { ...expected(), expectedAt: h.time() - 30001 });
  check.equal(c.acceptPeerPing(beta, event, ping), false, "expired token");
  c.accountPeerPing.set(B, { ...expected(), expectedAt: h.time() + 1 });
  check.equal(c.acceptPeerPing(beta, event, ping), false, "future expectation");
  c.accountPeerPing.set(B, expected());
  check.equal(c.acceptPeerPing(beta, event, ping), true, "matching private diagnostic");
  const first = c.accountPeerPing.get(B).receivedAt;
  h.advance(1);
  check.equal(c.acceptPeerPing(beta, event, ping), false, "replay rejected");
  check.equal(c.accountPeerPing.get(B).receivedAt, first, "replay does not refresh health");
  // Send fake diagnostic through the complete callback, not only the helper.
  c.accountPeerPing.set(B, expected());
  await h.emit(B, "[Hermes诊断] ping:fixture-token from:fixture-alpha to:fixture-beta", { userId: QQ[A] });
  check.equal(c.accountPeerPing.get(B).receivedAt, undefined, "group callback cannot verify receive");
  check.notEqual(c.diagnoseAccount(c.accountById(h.config, B), beta).routeState, "ONLINE_VERIFIED");
  c.oneBotRequest = async (ws, action, params) => {
    check.equal(ws.__hermesAccountId, A);
    check.equal(action, "send_private_msg");
    check.equal(params.user_id, QQ[B]);
    const parsed = c.parsePeerPingMessage(params.message);
    check.equal(c.accountPeerPing.get(B).expectedToken, parsed.token, "register before awaiting ACK");
    check.equal(c.acceptPeerPing(beta, event, parsed), true, "receive may precede sender ACK");
    return {};
  };
  check.equal((await c.sendPeerPing(c.accountById(h.config, A), c.accountById(h.config, B))).ok, true);
  check.equal(c.accountPeerPing.get(A).sentOk, true);
  check.equal(c.accountPeerPing.get(B).receivedToken, c.accountPeerPing.get(A).token);
  c.oneBotRequest = async () => { throw new Error("fixture rejected send"); };
  h.advance(5001);
  check.equal((await c.sendPeerPing(c.accountById(h.config, A), c.accountById(h.config, B))).ok, false);
  check.equal(c.accountPeerPing.get(A).sentOk, false);
  check.notEqual(c.diagnoseAccount(c.accountById(h.config, B), beta).capabilities.privateReceive.status, "bad", "failed sender is not proof receiver cannot receive");
  for (const sentOk of [null, false, true]) {
    c.accountPeerPing.set(B, { receivedAt: h.time(), receivedFrom: A, receivedToken: "received", sentAt: h.time(), sentTo: A, sentOk, token: "sent" });
    const route = c.diagnoseAccount(c.accountById(h.config, B), beta).routeState;
    check.equal(route === "ONLINE_VERIFIED", sentOk === true, `receive + send ${sentOk}: only confirmed successful ACK verifies online`);
  }
  c.accountPeerPing.set(B, { receivedAt: h.time(), ownerSentAt: h.time(), ownerSentOk: null });
  check.notEqual(c.diagnoseAccount(c.accountById(h.config, B), beta).routeState, "ONLINE_VERIFIED", "blocked/pending owner check cannot verify online");
  for (const [sentOk, token, to, bad] of [[null, "expected", B, false], [false, "expected", B, false], [true, "wrong", B, false], [true, "expected", A, false], [true, "expected", B, true]]) {
    c.accountPeerPing.set(B, { expectedAt: h.time() - 5001, expectedFrom: A, expectedToken: "expected" });
    c.accountPeerPing.set(A, { sentOk, token, sentTo: to, sentAt: h.time() - 5001 });
    check.equal(c.diagnoseAccount(c.accountById(h.config, B), beta).capabilities.privateReceive.status === "bad", bad,
      "missing receive only counts when exact expected sender token/target ACK succeeded");
  }
});

await test("3 per-account send diagnostic reasons and timestamps", async () => {
  const h = harness(), { c } = h;
  const alpha = h.connect(A), beta = h.connect(B);
  c.recordAccountSend(A, "send_group_msg", { failure: "fixture Alpha failure" });
  const alphaAt = h.time(); h.advance(1000);
  c.recordAccountSend(B, "send_group_msg", { failure: "fixture Beta failure" });
  c.oneBotSendRuntime.lastSendFailure = "fixture Beta global failure";
  c.oneBotSendRuntime.lastSendFailedAt = h.time();
  const a = c.diagnoseAccount(c.accountById(h.config, A), alpha);
  const b = c.diagnoseAccount(c.accountById(h.config, B), beta);
  check.match(a.reason, /Alpha failure/);
  check.doesNotMatch(a.reason, /Beta/);
  check.equal(a.capabilities.groupSend.at, alphaAt);
  check.match(a.capabilities.groupSend.reason, /Alpha failure/);
  check.match(b.capabilities.groupSend.reason, /Beta failure/);
  check.equal(b.capabilities.groupSend.at, h.time());
  c.accountSendState(A).lastGroupSendFailure = "";
  check.doesNotMatch(c.diagnoseAccount(c.accountById(h.config, A), alpha).capabilities.groupSend.reason, /Beta/, "generic fallback cannot borrow global reason");
  c.accountSendRuntime.delete(A);
  check.notEqual(c.diagnoseAccount(c.accountById(h.config, A), alpha).capabilities.groupSend.status, "bad", "B failure cannot mark healthy A send bad");
});

await test("4 actual enqueue gate: disabled/shadow planner, direct/implicit/active positives", async () => {
  for (const planner of [{ enabled: false }, { enabled: true, shadowMode: true }, { enabled: true, shadowMode: false }]) {
    const h = harness(); h.config.socialPlanner = planner;
    h.connect(A); h.connect(B);
    await h.emit(A, undefined, { messageId: 500 }); await h.emit(B, undefined, { messageId: 500 });
    check.equal(h.jobs.length, 0, `ordinary observations do not enqueue: ${JSON.stringify(planner)}`);
    check.equal(h.archived.length, 1, "shared human utterance archived only once");
  }
  for (const kind of ["at", "private", "keyword", "implicit", "active"]) {
    const h = harness(); h.connect(B);
    if (kind === "implicit") h.c.implicitDecision = { matched: true, confidence: 0.9, reason: "fixture own follow-up" };
    if (kind === "active") {
      h.config.accounts.items.find((a) => a.id === B).features.proactive = true;
      h.config.behaviorModes.presets.normal.trigger = { activeReply: true, activeProbability: 1 };
      h.config.trigger = { ...h.config.trigger, activeReply: true, activeProbability: 1 };
    }
    await h.emit(B, kind === "keyword" ? "Beta" : "fixture question?", { mentions: kind === "at" ? [B] : [], private: kind === "private" });
    check.equal(h.jobs.length, 1, `${kind}: legitimate positive still queues`);
    check.equal(h.jobs[0].mode, kind);
    check.equal(h.jobs[0].accountId, B);
  }
});

await test("person controls fence prior account drafts without cancelling peer or identity evidence", async () => {
  const h = harness(), a = h.connect(A).ws, b = h.connect(B).ws;
  const owner = logicalBotId(h.config, A);
  const oldA = h.c.accountRuntimeContext(A, a, G), oldB = h.c.accountRuntimeContext(B, b, G);
  const blank = h.c.accountRuntimeContext(A, a), revision = h.c.accountExecutionRevision(A, G);
  h.c.memory.peopleMemory = { bots: { [owner]: { controlRevision: 1 } } };
  check.equal(h.c.accountRuntimeContextCurrent(oldA, a), false);
  check.equal(h.c.accountRuntimeContextCurrent(blank, a), false);
  check.equal(h.c.accountRuntimeContextCurrent(oldB, b), true);
  check.equal(h.c.accountRuntimeIdentityCurrent(oldA, a), true, "person controls do not erase verified carrier identity");
  check.notEqual(h.c.accountExecutionRevision(A, G), revision);
  const current = h.c.accountRuntimeContext(A, a, G);
  h.c.memory.peopleMemory.bots[owner].people = { fixture: { revision: 12 } };
  check.equal(h.c.accountRuntimeContextCurrent(current, a), true, "ordinary evidence updates do not cause regeneration loops");
});

await test("real inbound names address only their independent logical bot", async () => {
  for (const [text, expected, rename] of [["Beta 你在吗", B, false], ["fixture-keyword 你在吗", A, false], ["Alpha2 你在吗", B, true]]) {
    const h = harness(); h.connect(A); h.connect(B);
    if (rename) h.config.accounts.items.find((item) => item.id === B).displayName = "Alpha2";
    await h.emit(A, text, { messageId: 900 });
    await h.emit(B, text, { messageId: 900 });
    check.deepEqual(h.jobs.map((job) => job.accountId), [expected], "a peer receiving the same event must not answer the addressed bot's name");
  }
});

await test("account proactive feature gates random/social participation, not direct replies", async () => {
  for (const planner of [{ enabled: false }, { enabled: true, shadowMode: true }, { enabled: true, shadowMode: false }]) {
    const h = harness(); h.connect(A); h.connect(B);
    h.config.socialPlanner = planner;
    h.config.behaviorModes.presets.normal.trigger = { activeReply: true, activeProbability: 1 };
    h.config.trigger = { ...h.config.trigger, activeReply: true, activeProbability: 1 };
    h.c.discussionDecision = { matched: true, reason: "fixture relevant discussion" };
    h.c.socialDecision = { action: "reply", requestedAction: "reply", intent: "discussion", confidence: 0.9 };
    h.config.accounts.items.find((a) => a.id === A).features.proactive = true;
    await h.emit(B, "fixture ordinary discussion");
    check.equal(h.jobs.length, 0, `B proactive off: random/social discussion cannot enqueue (${JSON.stringify(planner)})`);
    check.equal(h.c.lastActiveReplyAt.has(h.c.botStateKey(h.config, B, G)), false, "blocked participation cannot consume B cooldown");
    check.equal(h.c.lastActiveReplyAt.has(h.c.botStateKey(h.config, A, G)), false, "B decision cannot affect A cooldown");
  }
  for (const intent of ["followup", "reaction"]) {
    const h = harness(); h.connect(B);
    h.config.socialPlanner = { enabled: true, shadowMode: false };
    h.c.discussionDecision = { matched: true, reason: "fixture relevant follow-up" };
    h.c.socialDecision = { action: "reply", requestedAction: "reply", intent, confidence: 0.9 };
    await h.emit(B, "fixture follow-up");
    check.equal(h.jobs.length, 1, "proactive off preserves planner-detected implicit follow-up/reaction");
    check.equal(h.jobs[0].mode, "implicit");
    check.equal((await h.execute()).sent, true);
  }
  // The direct/keyword/private/implicit positives above use proactive=false;
  // also exercise explicit addressing with the live planner enabled.
  const direct = harness(); direct.connect(B);
  direct.config.socialPlanner = { enabled: true, shadowMode: false };
  await direct.emit(B, "fixture explicit question?", { mentions: [B] });
  check.equal(direct.jobs.length, 1);
  check.equal(direct.jobs[0].mode, "at");
});

await test("private control overlays do not leak between independent bots", async () => {
  const h = harness(); h.connect(A); h.connect(B);
  const conversation = `private:${HUMAN}`;
  const a = h.c.configForReplyAccount(h.c.accountById(h.config, A));
  const b = h.c.configForReplyAccount(h.c.accountById(h.config, B));
  const before = h.c.accountExecutionRevision(B, conversation);
  h.c.groupSettings(h.c.memory, conversation, a, { write: true, scoped: true }).voiceReplyMode = "off";
  check.equal(h.c.groupSettings(h.c.memory, conversation, a).voiceReplyMode, "off");
  check.equal(h.c.groupSettings(h.c.memory, conversation, b).voiceReplyMode, undefined);
  check.equal(h.c.accountExecutionRevision(B, conversation), before);
});

await test("voice preset acknowledges its own committed control revision", async () => {
  const h = harness(); h.connect(A);
  h.config.voice = { ...h.config.voice, enabled: true,
    tts: { enabled: true, model: "mimo-v2.5-tts", allowedVoices: ["bright"] } };
  h.c.configRevision += 1;
  let acknowledgements = 0;
  h.c.oneBotRequest = async () => { acknowledgements += 1; return {}; };
  new vm.Script(functionSource("handleVoiceCommand")).runInContext(h.c);
  const event = { message_type: "private", user_id: HUMAN, __accountId: A };
  const conversation = `private:${HUMAN}`;
  const result = await h.c.handleVoiceCommand({ event, conversationId: conversation,
    senderId: HUMAN, senderName: "fixture human", text: "/voice preset bright" });
  check.equal(result, true);
  check.equal(acknowledgements, 1);
  const projected = h.c.configForReplyAccount(h.c.accountById(h.config, A));
  check.equal(h.c.groupSettings(h.c.memory, conversation, projected).voicePreset, "bright");
  const peer = h.c.configForReplyAccount(h.c.accountById(h.config, B));
  check.equal(h.c.groupSettings(h.c.memory, conversation, peer).voicePreset, undefined);
});

await test("proactive capability changes invalidate queued active replies and planner wait", async () => {
  const h = harness(); h.connect(B);
  const beta = h.config.accounts.items.find((a) => a.id === B);
  beta.features.proactive = true;
  h.config.behaviorModes.presets.normal.trigger = { activeReply: true, activeProbability: 1 };
  h.config.trigger = { ...h.config.trigger, activeReply: true, activeProbability: 1 };
  await h.emit(B);
  check.equal(h.jobs.length, 1);
  check.equal(h.jobs[0].mode, "active");
  beta.features.proactive = false;
  check.equal((await h.execute()).skipped, true, "closing capability during queue wait cancels active generation");
  check.equal(h.prompts.length, 0);
  check.equal(h.sends.length, 0);
  beta.features.proactive = true;
  check.equal((await h.execute()).sent, true, "explicitly re-enabled capability permits active job");
  const wait = harness(); wait.connect(B);
  const waitBeta = wait.config.accounts.items.find((a) => a.id === B);
  waitBeta.features.proactive = true;
  wait.config.socialPlanner = { enabled: true, shadowMode: false };
  wait.c.discussionDecision = { matched: true, reason: "fixture discussion" };
  wait.c.socialDecision = { action: "wait", requestedAction: "wait", intent: "discussion", confidence: 0.9 };
  let pending;
  wait.c.scheduleDelayedUnderstandingReply = (options) => { pending = options; };
  await wait.emit(B);
  check.ok(pending, "enabled planner may schedule wait");
  check.equal(wait.jobs.length, 0);
  check.equal(pending.isCurrent(), true);
  waitBeta.features.proactive = false;
  wait.c.configRevision += 1;
  check.equal(pending.isCurrent(), false, "closing B capability invalidates delayed wait");
  waitBeta.features.proactive = true;
  wait.c.configRevision += 1;
  check.equal(pending.isCurrent(), false, "restoring the policy cannot revive a stale delayed wait");
  await wait.emit(B);
  check.equal(pending.isCurrent(), true, "a fresh wait captures the current owner policy");
  wait.config.accounts.items.find((account) => account.id === A).style.systemPrompt += " unrelated peer edit";
  wait.c.configRevision += 1;
  check.equal(pending.isCurrent(), true, "editing A's style must not invalidate B's wait");
  const original = wait.c.oneBotAccounts.get(B).ws;
  wait.c.oneBotAccounts.get(B).ws = wait.socket();
  check.equal(pending.isCurrent(), false, "changed socket invalidates delayed wait");
  wait.c.oneBotAccounts.get(B).ws = original;
  check.equal(pending.isCurrent(), true);
  for (const implicit of [false, true]) {
    const f = harness(); f.connect(B);
    f.config.socialPlanner = { enabled: true, shadowMode: false };
    f.c.discussionDecision = { matched: true, reason: "fixture discussion" };
    f.c.implicitDecision = { matched: implicit, confidence: implicit ? 0.9 : 0, reason: "fixture implicit evidence" };
    f.c.socialDecision = { action: "wait", requestedAction: "wait", intent: "discussion", confidence: 0.9 };
    let scheduled;
    f.c.scheduleDelayedUnderstandingReply = (options) => { scheduled = options; };
    await f.emit(B);
    check.equal(Boolean(scheduled), implicit, "proactive off permits waiting only for existing implicit evidence");
    check.equal(f.jobs.length, 0);
    if (scheduled) {
      check.equal(scheduled.isCurrent(), true, "strong implicit wait does not require proactive capability");
      f.config.accounts.items.find((a) => a.id === B).enabled = false;
      check.equal(scheduled.isCurrent(), false, "disabling whole account still invalidates implicit wait");
    }
  }
});

await test("5 B generation uses B overlay/persona/voice, never root A", async () => {
  const h = harness(); h.connect(A); h.connect(B);
  const shared = h.c.groupMemory(h.c.memory, G).settings;
  shared.botSettings = { [`account:${A}`]: { behaviorMode: "lively" }, [`account:${B}`]: { behaviorMode: "restrained" } };
  h.config.accounts.items.find((a) => a.id === A).voice.mode = "off";
  const before = JSON.stringify(h.config);
  await h.emit(B, "fixture explicit question?", { mentions: [B] });
  check.equal((await h.execute()).sent, true);
  const projected = h.prompts.at(-1).config;
  check.equal(projected.__activeAccountId, B);
  check.equal(projected.__behaviorMode, "restrained");
  check.equal(projected.trigger.activeProbability, 0.01);
  check.equal(projected.prompt.system, "fixture persona Beta");
  check.equal(projected.voice.enabled, true);
  check.equal(projected.voice.replyMode, "mixed");
  check.equal(h.sends.at(-1).accountId, B);
  check.equal(JSON.stringify(h.config), before, "generation projection cannot mutate global config");
  // Change A and root selection during B's queued wait: execute must reproject B.
  h.config.__activeAccountId = A;
  shared.botSettings[`account:${A}`].behaviorMode = "normal";
  await h.execute();
  check.equal(h.prompts.at(-1).config.__behaviorMode, "restrained");
});

await test("6 account defaults before group overlay at decision and generation", async () => {
  const h = harness(); h.connect(B);
  h.config.accounts.items.find((a) => a.id === B).features.proactive = true;
  h.config.accounts.items.find((a) => a.id === B).behaviorMode = "normal";
  const beta = h.c.accountById(h.config, B);
  check.equal(h.c.configForGroupAccount(beta, G).__behaviorMode, "normal", "account default without group overlay");
  const settings = h.c.groupSettings(h.c.memory, G, h.c.configForReplyAccount(beta), { write: true, scoped: true });
  settings.behaviorMode = "restrained";
  const projected = h.c.configForGroupAccount(beta, G);
  check.equal(projected.__behaviorMode, "restrained");
  check.equal(projected.trigger.activeProbability, 0.01);
  h.config.socialPlanner = { enabled: true, shadowMode: false };
  h.c.discussionDecision = { matched: true, reason: "fixture relevant discussion" };
  h.c.socialDecision = { action: "reply", requestedAction: "reply", intent: "discussion", confidence: 0.9 };
  await h.emit(B);
  check.equal(h.decisions.at(-1).__behaviorMode, "restrained", "real decision call receives group overlay");
  check.equal(h.jobs.length, 1);
  check.equal((await h.execute()).sent, true);
  check.equal(h.prompts.at(-1).config.__behaviorMode, "restrained", "generation cannot reapply normal account default");
});

await test("7 single-bot bare /bot scopes quiet/mode/voice; later B and legacy/failover", async () => {
  for (const [command, field, expected] of [["quiet 10m", "quietUntil", "future"], ["mode restrained", "behaviorMode", "restrained"], ["voice off", "voiceReplyMode", "off"]]) {
    const h = harness(); h.connect(A); h.c.roster = [QQ[A], HUMAN];
    await h.emit(A, `/bot ${command}`);
    const shared = h.c.groupMemory(h.c.memory, G).settings;
    const own = shared.botSettings?.[`account:${A}`];
    check.ok(own, `${command}: own overlay created without selector`);
    check.equal(shared[field], undefined, `${command}: shared legacy settings unchanged`);
    if (expected === "future") check.ok(own[field] > h.time());
    else check.equal(own[field], expected);
    h.connect(B); h.c.roster.push(QQ[B]);
    const bConfig = h.c.configForReplyAccount(h.c.accountById(h.config, B));
    check.equal(h.c.groupSettings(h.c.memory, G, bConfig)[field], undefined, `${command}: joining B cannot inherit A's new control`);
    check.equal(h.c.isQuiet(h.c.memory, G, bConfig), false);
    if (field === "voiceReplyMode") check.equal(voiceReplyMode(h.c.groupSettings(h.c.memory, G, bConfig), bConfig.voice), "mixed");
    if (field === "behaviorMode") check.equal(h.c.configForGroupAccount(h.c.accountById(h.config, B), G).__behaviorMode, "normal");
  }
  const h = harness();
  h.c.groupMemory(h.c.memory, G).settings.quietUntil = h.time() + 10000;
  for (const id of [A, B]) check.equal(h.c.isQuiet(h.c.memory, G, h.c.configForReplyAccount(h.c.accountById(h.config, id))), true, "legacy quiet fallback remains readable");
  const groupConfig = fixtureConfig();
  groupConfig.accounts.failoverGroups = [{ id: "fixture-logical", name: "fixture logical bot", memberIds: [A, B], policyAccountId: A,
    policy: accountPolicy(groupConfig.accounts.items[0]), settings: {} }];
  const f = harness(registryConfig(groupConfig));
  const aConfig = f.c.configForReplyAccount(f.c.accountById(f.config, A));
  const bConfig = f.c.configForReplyAccount(f.c.accountById(f.config, B));
  f.c.groupSettings(f.c.memory, G, aConfig, { write: true, scoped: true }).quietUntil = f.time() + 10000;
  check.equal(f.c.isQuiet(f.c.memory, G, bConfig), true, "members of the same logical failover bot intentionally share overlay");
});

await test("@A/@B/@both, private sockets, duplicate delivery and own reply state", async () => {
  for (const targets of [[A], [B], [A, B]]) {
    const h = harness(); h.connect(A); h.connect(B);
    for (const id of [B, A]) await h.emit(id, "fixture mention question?", { mentions: targets, messageId: 123 });
    check.deepEqual(h.jobs.map((job) => job.accountId).sort(), [...targets].sort(), "only explicitly addressed account(s) queue");
    for (const job of h.jobs) check.equal((await h.execute(job)).sent, true);
    check.deepEqual(h.sends.map((send) => send.accountId).sort(), [...targets].sort(), "own selected sockets send");
    check.equal(h.archived.length, 1, "@both shares human history without swallowing either job");
    for (const id of targets) {
      const own = h.c.lastBotMessageForAccount(h.c.lastBotMessageByGroup, G, id, h.config);
      check.equal(own.accountId, id, "last reply state is account-local");
    }
    const count = h.jobs.length;
    for (const id of [B, A]) await h.emit(id, "fixture mention question?", { mentions: targets, messageId: 123 });
    check.equal(h.jobs.length, count, "duplicate per-account delivery cannot queue again");
  }
  const h = harness(); h.connect(A); h.connect(B);
  for (const id of [A, B]) await h.emit(id, "private fixture?", { private: true, messageId: 777 });
  check.equal(h.jobs.length, 2);
  check.notEqual(h.jobs[0].conversationId, h.jobs[1].conversationId, "same human private chats are isolated");
  for (const job of h.jobs) check.equal((await h.execute(job)).sent, true);
  check.deepEqual(h.sends.map((s) => [s.accountId, s.action]), [[A, "send_private_msg"], [B, "send_private_msg"]]);
  h.config.send.privateMinIntervalMs = 1000;
  h.c.privateMessageCooldowns.clear(); h.sends.length = 0;
  for (const id of [A, B, A]) h.c.sendGroupMessage(h.c.oneBotAccounts.get(id).ws, { message_type: "private", user_id: HUMAN }, "fixture", h.config);
  check.deepEqual(h.sends.map((s) => s.accountId), [A, B], "A private cooldown cannot suppress B");
});

await test("actual debounce isolates account buffers and coalesces same-account fragments", async () => {
  const h = harness(); h.config.messageDebounce = { enabled: true, baseWaitMs: 1, minWaitMs: 1, maxWaitMs: 1 };
  const release = [];
  h.c.sleep = () => new Promise((resolve) => release.push(resolve));
  const fragment = (id, text) => h.c.enqueueDebouncedMessage({ event: { message_type: "group", group_id: G, user_id: HUMAN },
    conversationId: G, senderId: HUMAN, accountId: id, senderName: "fixture", text, rawText: text, mentioned: false, isPrivate: false, config: h.config });
  const a1 = fragment(A, "Alpha first"), b = fragment(B, "Beta only"), a2 = fragment(A, "Alpha second");
  check.equal(h.c.messageDebounceRuntime.size, 2);
  release.forEach((done) => done());
  const values = await Promise.all([a1, b, a2]);
  check.equal(values[0].skip, true);
  check.equal(values[1].text, "Beta only");
  check.equal(values[2].text, "Alpha first\nAlpha second");
  check.equal(values[2].text.includes("Beta"), false);
  check.equal(h.c.messageDebounceRuntime.size, 0);
});

await test("actual proactive timer decision/execute use B group overlay", async () => {
  const h = harness(); h.connect(A); h.connect(B);
  h.config.accounts.items.find((a) => a.id === B).features.proactive = true;
  h.config.accounts.items.find((a) => a.id === B).behaviorMode = "normal";
  h.config.behaviorModes.presets.restrained.proactive = { probability: 0.01, cooldownMs: 1, activeWindowMs: 60000 };
  h.config.behaviorModes.presets.lively.proactive = { probability: 0.9 };
  const settings = h.c.groupMemory(h.c.memory, G).settings;
  settings.botSettings = { [`account:${A}`]: { behaviorMode: "lively" }, [`account:${B}`]: { behaviorMode: "restrained" } };
  await h.emit(B);
  h.c.detectDiscussionSignal = ({ config }) => { h.decisions.push(config); return { matched: false }; };
  h.attachProactive(B);
  await h.tick(B);
  check.equal(h.jobs.length, 0, "B 1% probability is not root A's 90%");
  check.equal(h.decisions.at(-1).__behaviorMode, "restrained", "timer decision uses B group overlay, not normal default");
  h.c.Math.random = () => 0;
  await h.tick(B);
  check.equal(h.jobs.length, 1);
  check.equal(h.jobs[0].accountId, B);
  check.equal(h.jobs[0].mode, "proactive");
  check.equal((await h.execute()).sent, true);
  check.equal(h.prompts.at(-1).config.__behaviorMode, "restrained", "timer execute preserves group overlay");
  check.equal(h.sends.at(-1).accountId, B);
  settings.botSettings[`account:${B}`].behaviorMode = "lively";
  check.equal((await h.execute()).sent, true);
  check.equal(h.prompts.at(-1).config.__behaviorMode, "lively", "timer execute re-reads B overlay changed during queue wait");
  settings.botSettings[`account:${B}`].quietUntil = h.time() + 10000;
  const sentCount = h.sends.length;
  check.equal((await h.execute()).skipped, true, "quiet changed during wait prevents timer send");
  check.equal(h.sends.length, sentCount);
  settings.botSettings[`account:${B}`].quietUntil = 0;
  h.config.accounts.items.find((a) => a.id === B).features.proactive = false;
  check.equal((await h.execute()).skipped, true, "closing B capability also cancels queued proactive timer job");
  check.equal(h.sends.length, sentCount);
  const decisionCount = h.decisions.length;
  await h.tick(B);
  check.equal(h.decisions.length, decisionCount, "disabled timer capability exits before discussion judgment");
});

await test("actual implicit algorithm does not treat B reply as A's follow-up", async () => {
  const h = harness(); h.connect(A); h.connect(B);
  new vm.Script(functionSource("detectImplicitReplyToBot")).runInContext(h.c);
  const beta = h.c.configForReplyAccount(h.c.accountById(h.config, B));
  await h.c.recordBotMessage({ historyByGroup: h.c.historyByGroup, lastBotMessageByGroup: h.c.lastBotMessageByGroup,
    groupId: G, text: "fixture Beta reply", config: beta, meta: { replyToUserId: HUMAN } });
  h.advance(1);
  await h.emit(A, "继续");
  check.equal(h.jobs.length, 0, "A has no own recent reply: cannot claim B's follow-up");
  await h.emit(B, "继续", { messageId: 1234 });
  check.equal(h.jobs.length, 1, "B recognizes follow-up to B's own message");
  check.equal(h.jobs[0].mode, "implicit");
  check.equal(h.jobs[0].accountId, B);
});

await test("real coordinator/delivery independent decisions and negative policy", async () => {
  const config = fixtureConfig(), sent = [];
  const coordinator = new ReplyCoordinator({ config: () => ({ responseQueue: { minDelayMs: 0, liveContext: { settleMs: 0 } } }) });
  const pending = [];
  // Enqueue API and account-scoped keys are production implementations.
  for (const accountId of [A, B]) pending.push(coordinator.enqueue({ conversationId: G, senderId: HUMAN, accountId, mode: "at", direct: true,
    currentMessages: [{ text: "fixture", user_id: HUMAN }], messageIds: ["same-id"],
    execute: async () => { sent.push(accountId); return { sent: true }; } }));
  await Promise.all(pending);
  check.deepEqual([...sent].sort(), [A, B], "same group/sender/messageId cannot swallow another account's job");
  for (const id of [A, B]) {
    check.equal(accountDeliveryDecision(config, id, "send_group_msg", { group_id: G, message: "fixture" }).allowed, true);
    check.equal(accountDeliveryDecision(config, id, "send_group_msg", { group_id: G, message: "fixture" }, { quiet: true }).allowed, false);
  }
  config.accounts.items.find((a) => a.id === A).enabled = false;
  check.equal(accountDeliveryDecision(config, A, "send_private_msg", { user_id: HUMAN, message: "fixture" }).allowed, false);
  check.equal(accountDeliveryDecision(config, B, "send_private_msg", { user_id: HUMAN, message: "fixture" }).allowed, true);
  const delivery = new GroupSendCoordinator({ minDelayMs: () => 0 });
  const order = [];
  await Promise.all([A, B].map((id) => delivery.dispatch(G, () => {}, () => order.push(id))));
  check.deepEqual(order, [A, B], "shared anti-spam queue serializes, not merges, account sends");
  coordinator.close?.();
});

await test("seven in-memory reverted fixes are detected (no source writes)", async () => {
  const change = (text, before, after) => {
    if (!text.includes(before)) throw new Error(`mutation anchor changed: ${before}`);
    return text.replace(before, after);
  };
  const mutateFunction = (name, before, after) => ({ functions: { [name]: change(functionSource(name), before, after) } });
  // These deliberately reverse one production fix at a time, then exercise
  // the same real functions/callbacks. They prove mocks do not make old buggy
  // branches pass. Mutants exist only as VM strings, never on disk.
  const one = harness(fixtureConfig(), mutateFunction("identifyOneBotAccount", "previous.ws = null;", "void previous.ws;"));
  const old = one.connect(A).ws;
  one.c.identifyOneBotAccount(old, { self_id: QQ[B] });
  check.equal(one.c.oneBotAccounts.get(A).ws, old, "mutant 1 reproduces stale account socket reference");
  const two = harness(fixtureConfig(), mutateFunction("acceptPeerPing", 'event.message_type !== "private" || ', ""));
  two.connect(A); const beta = two.connect(B);
  two.c.accountPeerPing.set(B, { expectedAt: two.time(), expectedFrom: A, expectedToken: "fixture-token" });
  check.equal(two.c.acceptPeerPing(beta, { message_type: "group", user_id: QQ[A] }, { from: A, to: B, token: "fixture-token" }), true,
    "mutant 2 reproduces forged group receive evidence");
  const three = harness(fixtureConfig(), mutateFunction("diagnoseAccount", 'reason: sendState.lastGroupSendFailure || "最近群聊发送失败。"', 'reason: sendState.lastGroupSendFailure || oneBotSendRuntime.lastSendFailure'));
  const alpha = three.connect(A);
  three.c.recordAccountSend(A, "send_group_msg", { failure: "fixture A" });
  three.c.accountSendState(A).lastGroupSendFailure = "";
  three.c.oneBotSendRuntime.lastSendFailure = "fixture B borrowed";
  check.match(three.c.diagnoseAccount(three.c.accountById(three.config, A), alpha).capabilities.groupSend.reason, /B borrowed/, "mutant 3 borrows B failure");
  const finalGate = handlerSource.match(/^      if \(!\(isPrivate \|\| mentioned \|\| keyword \|\| webSearch \|\| implicit \|\| .*$/m)?.[0];
  if (!finalGate) throw new Error("production final reply gate missing");
  const four = harness(fixtureConfig(), { handler: change(handlerSource, finalGate, "") });
  four.connect(B); await four.emit(B);
  check.equal(four.jobs.length, 1, "mutant 4 enqueues unrelated activeReply-off observation");
  const five = harness(fixtureConfig(), { handler: change(handlerSource, "replyConfig = configForGroupAccount(latestAccount, groupId, liveConfig);", "replyConfig = applyBehaviorMode(liveConfig, memory, groupId);") });
  five.connect(B);
  five.c.groupMemory(five.c.memory, G).settings.botSettings = { [`account:${A}`]: { behaviorMode: "lively" }, [`account:${B}`]: { behaviorMode: "restrained" } };
  await five.emit(B, "fixture?", { mentions: [B] }); await five.execute();
  check.equal(five.prompts.at(-1).config.__behaviorMode, "lively", "mutant 5 B generation reads A overlay");
  const six = harness(fixtureConfig(), mutateFunction("configForGroupAccount", "applyBehaviorMode(configForReplyAccount(account, baseConfig), memory, groupId)", "configForReplyAccount(account, applyBehaviorMode(baseConfig, memory, groupId))"));
  six.config.accounts.items.find((a) => a.id === B).behaviorMode = "normal";
  six.c.groupMemory(six.c.memory, G).settings.botSettings = { [`account:${B}`]: { behaviorMode: "restrained" } };
  check.equal(six.c.configForGroupAccount(six.c.accountById(six.config, B), G).__behaviorMode, "normal", "mutant 6 account default overwrites group overlay");
  // The storage boundary now enforces ownership even if a caller omits scoped.
  // Reverse that boundary itself, rather than a redundant call-site hint.
  const seven = harness(fixtureConfig(), mutateFunction("groupSettings", "if (!id) return shared;", "if (!id || write) return shared;"));
  seven.connect(A); seven.c.roster = [QQ[A], HUMAN]; await seven.emit(A, "/bot quiet 10m");
  check.ok(seven.c.groupMemory(seven.c.memory, G).settings.quietUntil > seven.time(), "mutant 7 bare single-bot command writes shared quiet");
  check.equal(seven.c.isQuiet(seven.c.memory, G, seven.c.configForReplyAccount(seven.c.accountById(seven.config, B))), true, "mutant 7 later B inherits quiet");
});

// Deterministic race barriers: no sleeps, real sockets, disk writes, or live state.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function installBindingDelivery(h) {
  // Real send wrapper, real dispatcher, fake final wire only. Explicit binding
  // must survive the __hermesDispatch fourth argument just as in production.
  h.c.oneBotSendRaw = (socket, action, params) => {
    h.sends.push({ accountId: socket.__hermesAccountId, action, params });
    return Promise.resolve({});
  };
  new vm.Script(functionSource("oneBotSend")).runInContext(h.c);
}

await test("rebind during text generation discards A payload; new B group/private jobs work", async () => {
  for (const isPrivate of [false, true]) {
    const h = harness();
    const ws = h.connect(A).ws;
    h.connect(B);
    installBindingDelivery(h);
    const started = deferred(), response = deferred();
    h.c.callHermes = async () => { started.resolve(); return response.promise; };
    await h.emit(A, "fixture A-only question?", { mentions: isPrivate ? [] : [A], private: isPrivate });
    const oldJob = h.jobs.at(-1);
    const running = h.execute(oldJob);
    await started.promise;
    check.equal(h.prompts.at(-1).config.__activeAccountId, A);
    h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
    response.resolve("fixture A-only answer");
    const discarded = await running;
    check.notEqual(discarded.sent, true, "A generation cannot report success after identity changed");
    check.equal(h.sends.length, 0, "A answer cannot leave through B's socket");
    check.equal(h.c.lastBotMessageByGroup.size, 0, "discarded reply cannot become bot reply evidence");
    h.c.callHermes = async () => "fixture fresh B answer";
    await h.emit(B, "fixture new B question?", { mentions: isPrivate ? [] : [B], private: isPrivate });
    check.equal(h.jobs.at(-1).accountId, B);
    check.equal((await h.execute()).sent, true, "rebinding must not disable legitimate new B jobs");
    check.equal(h.prompts.at(-1).config.__activeAccountId, B);
    check.equal(h.sends.length, 1);
    check.equal(h.sends[0].accountId, B);
    check.equal(h.sends[0].action, isPrivate ? "send_private_msg" : "send_group_msg");
    check.match(h.sends[0].params.message, /fresh B answer/);
    check.doesNotMatch(h.sends[0].params.message, /A-only/);
  }
});

await test("rebind while text/voice delivery waits rejects A; B fresh dispatch succeeds", async () => {
  for (const isPrivate of [false, true]) {
    for (const voice of [false, true]) {
      const h = harness(), ws = h.connect(A).ws;
      h.connect(B);
      const started = deferred(), blocker = deferred();
      const groupId = isPrivate ? undefined : G;
      const hold = isPrivate ? Promise.resolve() : h.c.groupSendCoordinator.dispatch(G, () => {}, () => {
        started.resolve(); return blocker.promise;
      });
      if (!isPrivate) await started.promise;
      const action = isPrivate ? "send_private_msg" : "send_group_msg";
      const params = { ...(isPrivate ? { user_id: HUMAN } : { group_id: groupId }),
        message: voice ? [{ type: "record", data: { file: "base64://Zml4dHVyZQ==" } }] : "fixture A-only queued payload" };
      const wire = [];
      // Observe rejection immediately so it can never become unhandled while
      // the group barrier is held. Only the actual wire boundary is mocked.
      const pending = h.c.dispatchAccountAction(ws, action, params, () => wire.push({ accountId: ws.__hermesAccountId, params }))
        .then(() => ({ sent: true }), (error) => ({ sent: false, error }));
      h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
      blocker.resolve(); await hold;
      const discarded = await pending;
      check.equal(discarded.sent, false, `${action}/${voice ? "voice" : "text"}: old A dispatch rejected`);
      check.equal(discarded.error?.code, "ACCOUNT_SEND_BLOCKED", "discard must be explicit, not a successful no-op");
      check.equal(wire.length, 0, "queued A payload never reaches wire after rebind");
      const freshParams = { ...params, message: voice ? [{ type: "record", data: { file: "base64://Qg==" } }] : "fixture fresh B queued payload" };
      await h.c.dispatchAccountAction(ws, action, freshParams, () => wire.push({ accountId: ws.__hermesAccountId, params: freshParams }));
      check.equal(wire.length, 1);
      check.equal(wire[0].accountId, B);
      check.equal(wire[0].params, freshParams);
      check.deepEqual(h.warnings, []);
    }
  }
});

await test("native message reactions keep strict wire params and pass the real shared dispatcher", async () => {
  const h=harness(), ws=h.connect(A).ws, wires=[];
  h.c.oneBotRequestRaw=async (_socket,action,params)=>{ wires.push({action,...structuredClone(params)}); return {}; };
  new vm.Script(functionSource("oneBotRequest")).runInContext(h.c);
  const item=h.config.accounts.items.find(row=>row.id===A);
  item.socialExperience={enabled:true,shadowMode:false,conversationIds:[`group:${G}`],reactions:{enabled:true}};
  h.c.configRevision="reaction-enabled";
  const params={group_id:G,message_id:"123456",code:"76",is_set:true};
  await h.c.oneBotRequest(ws,"set_group_reaction",params);
  check.equal(wires.length,1);
  check.equal(wires[0].action,"set_group_reaction");
  check.equal(Object.hasOwn(wires[0],"message"),false,"reaction has no chat content field");
  await assert.rejects(()=>h.c.oneBotRequest(ws,"set_group_reaction",{...params,message:undefined}),
    {code:"ACCOUNT_SEND_BLOCKED"},"extra message authority is still rejected");
  h.c.isQuiet=()=>true;
  await assert.rejects(()=>h.c.oneBotRequest(ws,"set_group_reaction",params),{code:"ACCOUNT_SEND_BLOCKED"});
  await assert.rejects(()=>h.c.oneBotRequest(ws,"set_msg_emoji_like",params),{code:"ACCOUNT_SEND_BLOCKED"});
  check.equal(wires.length,1,"quiet applies to reaction writes too");
});

await test("native poke requires an opaque host proof and exact current wire target", async () => {
  const h=harness(), ws=h.connect(A).ws, wires=[];
  h.c.groupSendCoordinator=new GroupSendCoordinator({minDelayMs:()=>0});
  h.c.oneBotRequestRaw=async (_socket,action,params)=>{wires.push({action,...structuredClone(params)});return {};};
  new vm.Script(functionSource("oneBotRequest")).runInContext(h.c);
  const item=h.config.accounts.items.find(row=>row.id===A);
  item.socialExperience={enabled:true,shadowMode:false,conversationIds:[`group:${G}`],pokes:{enabled:true}};
  h.c.configRevision="poke-policy";
  const params={group_id:Number(G),user_id:Number(HUMAN)};
  await assert.rejects(()=>h.c.oneBotRequest(ws,"group_poke",params),{code:"ACCOUNT_SEND_BLOCKED"});
  const binding=h.c.oneBotBinding(ws,A);
  h.c.nativePokeBindings.set(binding,{accountId:A,groupId:params.group_id,userId:params.user_id,isCurrent:()=>true});
  await assert.rejects(()=>h.c.oneBotRequest(ws,"group_poke",{...params,user_id:Number(HUMAN)+1},{binding}),{code:"ACCOUNT_SEND_BLOCKED"});
  await assert.rejects(()=>h.c.oneBotRequest(ws,"group_poke",{...params,message:"not allowed"},{binding}),{code:"ACCOUNT_SEND_BLOCKED"});
  await h.c.oneBotRequest(ws,"group_poke",params,{binding});
  check.equal(wires.length,1);check.equal(wires[0].action,"group_poke");
  h.c.isQuiet=()=>true;
  await assert.rejects(()=>h.c.oneBotRequest(ws,"group_poke",params,{binding}),{code:"ACCOUNT_SEND_BLOCKED"});
  h.c.isQuiet=()=>false;h.c.nativePokeBindings.delete(binding);
  await assert.rejects(()=>h.c.oneBotRequest(ws,"group_poke",params,{binding}),{code:"ACCOUNT_SEND_BLOCKED"});
  for(const action of ["friend_poke","send_poke"])
    await assert.rejects(()=>h.c.oneBotRequest(ws,action,params,{binding}),{code:"ACCOUNT_SEND_BLOCKED"});
  check.equal(wires.length,1,"raw actions, target changes and quiet never gain wire authority");
});

await test("queued native poke proof, quiet or policy revocation stops before wire", async () => {
  for(const mode of ["proof","quiet","policy"]) {
    const h=harness(),ws=h.connect(A).ws,wires=[];
    h.c.groupSendCoordinator=new GroupSendCoordinator({minDelayMs:()=>0});
    h.c.oneBotRequestRaw=async()=>{wires.push(true);return {};};
    new vm.Script(functionSource("oneBotRequest")).runInContext(h.c);
    const item=h.config.accounts.items.find(row=>row.id===A);
    item.socialExperience={enabled:true,shadowMode:false,conversationIds:[`group:${G}`],pokes:{enabled:true}};
    h.c.configRevision="queued-poke-policy";
    const params={group_id:Number(G),user_id:Number(HUMAN)},binding=h.c.oneBotBinding(ws,A);
    let current=true;
    h.c.nativePokeBindings.set(binding,{accountId:A,groupId:params.group_id,userId:params.user_id,isCurrent:()=>current});
    const occupied=deferred(),release=deferred();
    const blocker=h.c.groupSendCoordinator.dispatch(G,()=>{},()=>{occupied.resolve();return release.promise;});
    await occupied.promise;
    const pending=h.c.oneBotRequest(ws,"group_poke",params,{binding}).then(()=>true,()=>false);
    if(mode==="proof")current=false;
    if(mode==="quiet")h.c.isQuiet=()=>true;
    if(mode==="policy")item.socialExperience.pokes.enabled=false;
    release.resolve();await blocker;
    check.equal(await pending,false,mode);check.equal(wires.length,0,mode);
  }
});

await test("native actions, chat and forward reads require an unambiguous raw OneBot envelope", async () => {
  const h=harness(), ws=h.connect(A).ws, frames=[];
  h.config.accounts.items.find(row=>row.id===A).socialExperience={enabled:true,shadowMode:false,
    conversationIds:[`group:${G}`],reactions:{enabled:true}};
  h.c.configRevision="reaction-ack-policy";
  h.c.groupSendCoordinator=new GroupSendCoordinator({minDelayMs:()=>0});
  h.c.setTimeout=()=>1; h.c.clearTimeout=()=>{};
  for(const name of ["oneBotRequest","oneBotRequestRaw"]) new vm.Script(functionSource(name)).runInContext(h.c);
  for(const action of ["set_group_reaction","send_group_msg","get_forward_msg"])
  for(const ack of [{status:"ok",retcode:1404},{status:"failed",retcode:0},{status:"ok"},{retcode:0},{status:"ok",retcode:0}]) {
    const started=deferred(); ws.send=raw=>{frames.push(JSON.parse(raw));started.resolve();};
    const params=action==="set_group_reaction"?{group_id:G,message_id:"123456",code:"76",is_set:true}
      :action==="send_group_msg"?{group_id:G,message:"synthetic"}:{id:"current-source"};
    const pending=h.c.oneBotRequest(ws,action,params)
      .then(()=>true,()=>false);
    await started.promise;
    await ws.callbacks.get("message")(JSON.stringify({self_id:QQ[A],echo:frames.at(-1).echo,data:{},...ack}));
    check.equal(await pending,ack.status==="ok"&&ack.retcode===0);
    check.equal(h.c.pendingOneBotActions.size,0);
  }
});

await test("queued reaction revocation, quiet and cancellation stop before wire/start callback", async () => {
  for (const mode of ["revoke", "quiet", "cancel"]) {
    const h = harness(), ws = h.connect(A).ws, frames = [], timers = new Map();
    const item = h.config.accounts.items.find(row => row.id === A);
    item.socialExperience = { enabled: true, shadowMode: false,
      conversationIds: [`group:${G}`], reactions: { enabled: true } };
    h.c.configRevision = "queued-reaction-policy";
    h.c.setTimeout = callback => { const id = timers.size + 1; timers.set(id, callback); return id; };
    h.c.clearTimeout = id => timers.delete(id);
    ws.send = raw => frames.push(JSON.parse(raw));
    for (const name of ["oneBotRequest", "oneBotRequestRaw"]) new vm.Script(functionSource(name)).runInContext(h.c);
    const occupied = deferred(), release = deferred();
    const blocker = h.c.groupSendCoordinator.dispatch(G, () => {}, () => {
      occupied.resolve(); return release.promise;
    });
    await occupied.promise;
    const controller = new AbortController();
    let sendStarted = 0;
    const pending = h.c.oneBotRequest(ws, "set_group_reaction",
      { group_id: G, message_id: "123456", code: "76", is_set: true }, {
        signal: controller.signal,
        // Match the real reaction adapter's cancellation-aware wire binding.
        binding: { ...h.c.oneBotBinding(ws, A), isCurrent: () => !controller.signal.aborted,
          onSendStarted: () => { sendStarted++; } }
      }).then(() => ({ ok: true }), error => ({ ok: false, error }));
    check.notEqual(h.c.groupSendCoordinator.tails.get(G), blocker, `${mode}: request joined the physical group queue`);
    check.equal(frames.length, 0, `${mode}: occupied group prevents raw wire dispatch`);
    check.equal(sendStarted, 0);
    if (mode === "revoke") item.socialExperience.reactions.enabled = false;
    if (mode === "quiet") h.c.isQuiet = () => true;
    if (mode === "cancel") controller.abort();
    release.resolve(); await blocker;
    const result = await pending;
    check.equal(result.ok, false, mode);
    check.equal(result.error.code, "ACCOUNT_SEND_BLOCKED", mode);
    check.equal(frames.length, 0, `${mode}: no wire after queue release`);
    check.equal(sendStarted, 0, `${mode}: admission/cancellation is not a wire attempt`);
    check.equal(h.c.pendingOneBotActions.size, 0);
    check.equal(timers.size, 0, `${mode}: raw ACK timer was never installed`);
    check.deepEqual(h.warnings, []);
  }
});

await test("reaction raw timeout cleans pending and ignores late success ACK without replay", async () => {
  const h = harness(), ws = h.connect(A).ws, frames = [], timers = new Map();
  h.config.accounts.items.find(row => row.id === A).socialExperience = { enabled: true, shadowMode: false,
    conversationIds: [`group:${G}`], reactions: { enabled: true } };
  h.c.configRevision = "reaction-timeout-policy";
  h.c.setTimeout = callback => { const id = timers.size + 1; timers.set(id, callback); return id; };
  h.c.clearTimeout = id => timers.delete(id);
  const started = deferred();
  ws.send = raw => { frames.push(JSON.parse(raw)); started.resolve(); };
  for (const name of ["oneBotRequest", "oneBotRequestRaw"]) new vm.Script(functionSource(name)).runInContext(h.c);
  let sendStarted = 0, accepted = 0, rejected = 0;
  const pending = h.c.oneBotRequest(ws, "set_group_reaction",
    { group_id: G, message_id: "123456", code: "76", is_set: true }, {
      binding: { ...h.c.oneBotBinding(ws, A), onSendStarted: () => { sendStarted++; } }
    }).then(() => { accepted++; return null; }, error => { rejected++; return error; });
  await started.promise;
  check.equal(frames.length, 1);
  check.equal(sendStarted, 1);
  const frame = frames[0], entry = h.c.pendingOneBotActions.get(frame.echo);
  check.equal(entry.action, "set_group_reaction");
  // Detect even a late resolve call on an already-rejected Promise.
  let lateResolves = 0;
  const resolve = entry.resolve;
  entry.resolve = payload => { lateResolves++; resolve(payload); };
  check.equal(timers.size, 1);
  const [timerId, timeout] = timers.entries().next().value;
  timers.delete(timerId); timeout();
  check.match((await pending).message, /set_group_reaction timeout/);
  check.equal(h.c.pendingOneBotActions.size, 0);
  for (let i = 0; i < 2; i++) await ws.callbacks.get("message")(JSON.stringify({
    self_id: QQ[A], echo: frame.echo, status: "ok", retcode: 0, data: {}
  }));
  check.equal(accepted, 0);
  check.equal(rejected, 1);
  check.equal(lateResolves, 0, "expired echo cannot reach the old acceptance callback");
  check.equal(frames.length, 1, "timeout and duplicate late ACKs never replay the request");
  check.equal(sendStarted, 1);
  check.equal(h.c.pendingOneBotActions.size, 0);
  check.equal(h.c.oneBotSendTrackers.size, 0);
  check.equal(timers.size, 0);
  check.deepEqual(h.warnings, []);
});

await test("rebind during voice synthesis discards A audio/text fallback; B voice still works", async () => {
  const h = harness(), ws = h.connect(A).ws;
  h.connect(B);
  installBindingDelivery(h);
  const started = deferred(), audio = deferred(), removed = [];
  // Virtual audio filesystem only: do not create even temporary output files.
  Object.assign(h.c, {
    path, dataDir: "/fixture-data", Buffer,
    fs: { mkdirSync() {}, existsSync: () => true, readFileSync: () => Buffer.from("fixture audio"), unlinkSync: (file) => removed.push(file) },
    shouldSendVoiceReply: () => true,
    voiceConfigForCapability: () => ({}), voiceApiEnvironment: () => ({}),
    buildRecordMessage: () => ({ type: "record", data: { file: "base64://Zml4dHVyZQ==" } }),
    synthesizeSpeechFile: async () => { started.resolve(); await audio.promise; },
    oneBotRequest: (socket, action, params, options = {}) => h.c.dispatchAccountAction(socket, action, params, () => {
      h.sends.push({ accountId: socket.__hermesAccountId, action, params }); return {};
    }, options.binding)
  });
  await h.emit(A, "fixture A voice question?", { mentions: [A] });
  const running = h.execute();
  await started.promise;
  check.equal(h.prompts.at(-1).config.__activeAccountId, A);
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  audio.resolve();
  const discarded = await running;
  check.notEqual(discarded.sent, true);
  check.equal(h.sends.length, 0, "neither A audio nor fallback text may go out through B");
  check.equal(removed.length, 1, "stale synthesized audio is still cleaned up");
  h.c.synthesizeSpeechFile = async () => {};
  await h.emit(B, "fixture fresh B voice question?", { mentions: [B] });
  check.equal((await h.execute()).sent, true);
  check.equal(h.prompts.at(-1).config.__activeAccountId, B);
  check.equal(h.sends.length, 1);
  check.equal(h.sends[0].accountId, B);
  check.equal(h.sends[0].params.message[0].type, "record");
  check.equal(removed.length, 2);
});

await test("rebind invalidates planner wait before enqueue; B fresh delayed job works", async () => {
  const h = harness(), ws = h.connect(A).ws;
  h.connect(B);
  h.config.socialPlanner = { enabled: true, shadowMode: false };
  h.config.delayedUnderstanding = { enabled: true, minFollowupMessages: 0 };
  h.c.implicitDecision = { matched: true, confidence: 0.9, reason: "fixture own follow-up" };
  h.c.socialDecision = { action: "wait", requestedAction: "wait", intent: "followup", confidence: 0.9 };
  const timers = [];
  h.c.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  new vm.Script(functionSource("scheduleDelayedUnderstandingReply")).runInContext(h.c);
  await h.emit(A, "fixture ambiguous A follow-up");
  check.equal(timers.length, 1);
  check.equal(h.jobs.length, 0);
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  timers[0]();
  check.equal(h.jobs.length, 0, "old A wait cannot enqueue after rebind");
  check.equal(h.sends.length, 0);
  check.equal(h.c.delayedUnderstandingByGroup.size, 0);
  h.advance(1000);
  await h.emit(B, "fixture fresh B follow-up");
  check.equal(timers.length, 2);
  timers[1]();
  check.equal(h.jobs.length, 1);
  check.equal(h.jobs[0].accountId, B);
  check.equal(h.jobs[0].mode, "delayed");
  check.equal((await h.execute()).sent, true);
  check.equal(h.prompts.at(-1).config.__activeAccountId, B);
  check.equal(h.sends.length, 1);
  check.equal(h.sends[0].accountId, B);
});

await test("A-to-B-to-A cannot revive an old binding/config; fresh B binding works", async () => {
  const h = harness(), ws = h.connect(A).ws;
  h.connect(B);
  installBindingDelivery(h);
  const binding = h.c.oneBotBinding(ws, A);
  const staleConfig = h.c.configForReplyAccount(h.c.accountById(h.config, A));
  const event = { message_type: "group", group_id: G, user_id: HUMAN, __accountId: A };
  check.equal(typeof binding.sessionId, "string");
  check.ok(binding.sessionId.length > 0);
  check.equal(staleConfig.__oneBotSessionId, binding.sessionId);
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  h.c.identifyOneBotAccount(ws, { self_id: QQ[A] });
  check.equal(ws.__hermesAccountId, A);
  check.notEqual(ws.__hermesSessionId, binding.sessionId, "same account ID is not the same session");
  check.equal(h.c.oneBotBindingCurrent(ws, binding), false);
  check.equal(await h.c.sendGroupMessage(ws, event, "fixture stale A session", staleConfig), false);
  check.equal(h.sends.length, 0, "explicit stale config binding must survive send helper and dispatch");
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  const freshConfig = h.c.configForReplyAccount(h.c.accountById(h.config, B));
  check.equal(h.c.oneBotBindingCurrent(ws, h.c.oneBotBinding(ws, B)), true);
  check.equal(await h.c.sendGroupMessage(ws, { ...event, __accountId: B }, "fixture fresh B session", freshConfig), true);
  check.equal(h.sends.length, 1);
  check.equal(h.sends[0].accountId, B);
  check.deepEqual(h.warnings, []);
});

await test("ABA probe completion cannot mutate new-session identity or probe cache", async () => {
  const h = harness(), ws = h.connect(A).ws;
  h.connect(B);
  const replies = [];
  h.c.oneBotRequest = (socket, action) => new Promise((resolve) => replies.push({ socket, action, resolve }));
  const oldBinding = h.c.oneBotBinding(ws, A);
  const pending = h.c.probeOneBotAccount(A);
  check.equal(replies.length, 2);
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  h.c.identifyOneBotAccount(ws, { self_id: QQ[A] });
  check.equal(h.c.oneBotBindingCurrent(ws, oldBinding), false);
  const currentProbe = { ok: true, checkedAt: h.time(), loginInfo: { user_id: QQ[A] }, status: { online: true, good: true } };
  h.c.accountProbeCache.set(A, currentProbe);
  // Model an already-delivered response whose Promise continuation completes
  // after ABA: even clearing pending OneBot requests cannot cancel this case.
  for (const reply of replies) reply.resolve(reply.action === "get_login_info" ? { user_id: "91999" } : { online: false });
  const discarded = await pending;
  check.equal(discarded.ok, false);
  check.match(discarded.error, /connection changed/);
  check.equal(discarded.loginInfo, null);
  check.equal(discarded.status, null);
  check.equal(h.c.accountProbeCache.get(A), currentProbe, "old completion cannot replace new probe evidence");
  check.equal(h.c.oneBotAccounts.get(A).selfId, QQ[A], "old login response cannot rewrite new-session identity");
  h.c.oneBotRequest = async (socket, action) => action === "get_login_info" ? { user_id: QQ[A] } : { online: true, good: true };
  check.equal((await h.c.probeOneBotAccount(A)).ok, true);
  check.equal(h.c.accountProbeCache.get(A).loginInfo.user_id, QQ[A]);
  // B needs a new transport after ABA; its old transport was correctly closed.
  h.connect(B);
  await h.emit(B, "fixture B after ABA?", { mentions: [B] });
  check.equal((await h.execute()).sent, true);
  check.equal(h.sends.at(-1).accountId, B);
});

await test("rebind rejects real pending request/send ACKs; old echoes cannot restore health", async () => {
  const h = harness(), ws = h.connect(A).ws;
  h.connect(B);
  const wire = [], cleared = [], timers = new Map(), requestStarted = deferred(), sendStarted = deferred();
  h.c.setTimeout = (callback) => { const id = timers.size + 1; timers.set(id, callback); return id; };
  h.c.clearTimeout = (id) => { cleared.push(id); timers.delete(id); };
  ws.send = (payload) => {
    const frame = JSON.parse(payload); wire.push(frame);
    (frame.echo.startsWith("hermes-request-") ? requestStarted : sendStarted).resolve();
  };
  for (const name of ["oneBotSend", "oneBotSendRaw", "oneBotRequest", "oneBotRequestRaw"]) {
    new vm.Script(functionSource(name)).runInContext(h.c);
  }
  const binding = h.c.oneBotBinding(ws, A);
  const request = h.c.oneBotRequest(ws, "send_private_msg", { user_id: HUMAN, message: "fixture A request" }, { binding })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const send = h.c.oneBotSend(ws, "send_private_msg", { user_id: HUMAN, message: "fixture A tracked send" }, binding);
  await Promise.all([requestStarted.promise, sendStarted.promise]);
  check.equal(h.c.pendingOneBotActions.size, 1);
  check.equal(h.c.oneBotSendTrackers.size, 1);
  h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
  const rejected = await request;
  check.equal(rejected.ok, false);
  check.match(rejected.error.message, /closed/);
  check.equal(await send, false);
  check.equal(h.c.pendingOneBotActions.size, 0);
  check.equal(h.c.oneBotSendTrackers.size, 0);
  check.equal(cleared.length, 2, "both pending action timers must be cancelled");
  check.equal(timers.size, 0);
  check.equal(h.c.accountSendRuntime.get(A)?.lastSendOkAt || 0, 0);
  check.equal(h.c.accountSendRuntime.get(B)?.lastSendOkAt || 0, 0);
  for (const frame of wire) {
    await ws.callbacks.get("message")(JSON.stringify({ self_id: QQ[B], status: "ok", retcode: 0, echo: frame.echo, data: {} }));
  }
  check.equal(h.c.accountSendRuntime.get(A)?.lastSendOkAt || 0, 0, "old ACK cannot bless A");
  check.equal(h.c.accountSendRuntime.get(B)?.lastSendOkAt || 0, 0, "old ACK cannot bless B");
  check.equal(h.c.oneBotSendRuntime.lastSendOkAt || 0, 0);
  check.equal(h.warnings.length, 1);
  check.match(h.warnings[0], /closed/, "old wrapper may log only its expected cancellation");
  h.warnings.length = 0;
  const freshStarted = deferred();
  ws.send = (payload) => { wire.push(JSON.parse(payload)); freshStarted.resolve(); };
  const fresh = h.c.oneBotRequest(ws, "send_private_msg", { user_id: HUMAN, message: "fixture fresh B request" }, { binding: h.c.oneBotBinding(ws, B) });
  await freshStarted.promise;
  await ws.callbacks.get("message")(JSON.stringify({ self_id: QQ[B], status: "ok", retcode: 0, echo: wire.at(-1).echo, data: { message_id: 42 } }));
  check.equal((await fresh).message_id, 42);
  check.equal(h.c.accountSendRuntime.get(B).lastSendOkAt, h.time());
  check.equal(h.c.accountSendRuntime.get(A)?.lastSendOkAt || 0, 0);
  check.equal(h.c.pendingOneBotActions.size, 0);
  check.deepEqual(h.warnings, []);
});

await test("real inbound quote lookup ABA discards old event before accepting or enqueueing", async () => {
  for (const ackBeforeRebind of [false, true]) {
    const h = harness(), ws = h.connect(A).ws;
    h.connect(B);
    installBindingDelivery(h);
    const lookupStarted = deferred(), frames = [];
    let timerSequence = 0;
    h.c.setTimeout = () => ++timerSequence;
    // Use the real request map and real rebind cleanup, not a mocked pending
    // Promise. The only external boundary is the protocol wire itself.
    ws.send = (payload) => { frames.push(JSON.parse(payload)); lookupStarted.resolve(); };
    for (const name of ["oneBotRequest", "oneBotRequestRaw"]) {
      new vm.Script(functionSource(name)).runInContext(h.c);
    }
    const oldBinding = h.c.oneBotBinding(ws, A);
    const inbound = h.emit(A, "fixture-keyword old A quote", { event: { message: [
      { type: "reply", data: { id: "987" } },
      { type: "text", data: { text: "fixture-keyword old A quote" } }
    ] } });
    await lookupStarted.promise;
    check.equal(frames.length, 1);
    check.equal(frames[0].action, "get_msg");
    check.equal(h.c.pendingOneBotActions.size, 1);
    let acknowledgement;
    if (ackBeforeRebind) {
      // Resolve through the real callback, but do not yield to the waiting
      // original handler until the socket has gone A -> B -> A.
      acknowledgement = ws.callbacks.get("message")(JSON.stringify({ self_id: QQ[A], status: "ok", retcode: 0,
        echo: frames[0].echo, data: { sender: { user_id: HUMAN } } }));
      check.equal(h.c.pendingOneBotActions.size, 0);
    }
    h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
    h.c.identifyOneBotAccount(ws, { self_id: QQ[A] });
    check.equal(h.c.oneBotBindingCurrent(ws, oldBinding), false);
    if (acknowledgement) await acknowledgement;
    await inbound;
    check.equal(h.c.pendingOneBotActions.size, 0);
    check.equal(h.c.runtimeStatus.activeMessageCount, 0, "old frame cannot be accepted using the new A session");
    check.equal(h.jobs.length, 0, "old A quote cannot become a new-session reply job");
    check.equal(h.sends.length, 0);
    check.equal(h.prompts.length, 0);
    check.equal(h.archived.length, 0, "stale frame cannot be persisted as newly accepted context");
    check.equal(h.c.lastBotMessageByGroup.size, 0);
    // Positive controls exercise the same socket under its new A session,
    // then rebind it to B and verify fresh B traffic also remains usable.
    await h.emit(A, "fixture fresh A question?", { mentions: [A] });
    check.equal((await h.execute()).sent, true);
    check.equal(h.sends.at(-1).accountId, A);
    h.c.identifyOneBotAccount(ws, { self_id: QQ[B] });
    await h.emit(B, "fixture fresh B question?", { mentions: [B] });
    check.equal((await h.execute()).sent, true);
    check.equal(h.sends.length, 2);
    check.equal(h.sends.at(-1).accountId, B);
    check.doesNotMatch(JSON.stringify(h.sends), /old A quote/);
    check.equal(frames.length, 1, "no unmocked protocol request may escape the quote fixture");
    check.deepEqual(h.warnings, []);
  }
});

console.log(JSON.stringify({ ok: results.every((result) => result.ok), assertions, groups: results,
  offline: true, bridgeStarted: false, liveServicesConnected: false, sourceWrites: false }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
