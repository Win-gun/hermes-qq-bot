import assert from "node:assert/strict";
import fs from "node:fs";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { memoryRevision } from "../src/memory-repository.js";
import { botControlRevision } from "../src/account-runtime.js";

// Extract functions, never import/start bridge.js. All persistence, model and
// wire boundaries below are in-memory fixtures: no sockets, providers or QQ.
const source = fs.readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
function extract(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `missing bridge source boundary: ${start}`);
  return source.slice(from, to);
}
const bodies = {
  command: extract("async function handleBotCommand(", "\nfunction taskModeConfig("),
  voice: extract("  async function handleVoiceCommand(", "\n  async function executeAutomationRule("),
  automation: extract("  async function executeAutomationRule(", "\n  async function runScheduledAutomation(")
};
const helpers = extract("function groupMemory(", "\nfunction dedupePush(")
  + extract("function quietUntil(", "\nasync function repairInvalidQuietUntil(")
  + extract("function oneBotBinding(", "\nfunction botStateKey(")
  + extract("function oneBotBindingCurrent(", "\nfunction oneBotSend(")
  + extract("function markDailySent(", "\nfunction localDateKey(");
const GROUP = "810001", ACCOUNT = "fixture", OWNER = `account:${ACCOUNT}`;
const SCOPE = `group:${GROUP}`, DAY = "2026-10-20";
const RULE = { id: "fixture-rule", accountId: ACCOUNT, action: { kind: "summary" }, prompt: "fixture prompt" };
const LEDGER = `automation:${OWNER}:${RULE.id}`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
function compile(body, names, environment) {
  return Function(...Object.keys(environment), `${body}\nreturn { ${names.join(", ")} };`)(...Object.values(environment));
}

async function fixture(selectedBodies = bodies) {
  let durable = { groups: { [GROUP]: { users: {}, settings: {
    botSettings: { [OWNER]: { behaviorMode: "normal" } }
  } } } };
  let commitPause = null, ackPause = null, modelPause = null;
  const gates = [], operations = [], sent = [], revisionKeys = [];
  const identity = { owner: OWNER, policy: 1 };
  function pause() {
    const entered = deferred(), released = deferred();
    const gate = { entered: entered.promise, enter: entered.resolve, release: released.resolve, released: released.promise };
    gates.push(gate);
    return gate;
  }
  const repository = {
    open: async () => ({ value: structuredClone(durable), revision: memoryRevision(durable) }),
    status: () => ({ fixtureOnly: true }), close: async () => {},
    async commit(value, { expectedRevision }) {
      assert.equal(expectedRevision, memoryRevision(durable), "fixture CAS must remain coherent");
      const submitted = structuredClone(value), waiting = commitPause;
      commitPause = null;
      if (waiting) { waiting.enter(); await waiting.released; }
      durable = submitted;
      return { value: structuredClone(durable), revision: memoryRevision(durable) };
    }
  };
  const runtime = new MemoryRuntime(repository), memory = await runtime.open();
  const ws = { readyState: 1, __hermesAccountId: ACCOUNT, __hermesSessionId: "fixture-session" };
  const account = { id: ACCOUNT, qq: "910001", ws };
  const config = { __activeAccountId: ACCOUNT, commands: { enabled: true },
    reply: { useContextBundle: false }, automation: { enabled: true },
    voice: { enabled: true, tts: { enabled: true, model: "mimo-v2.5-tts", allowedVoices: ["A", "B"] } },
    taskMode: { ownerUserIds: [] } };
  const event = { message_type: "group", group_id: GROUP, user_id: "10001", message_id: "fixture-message",
    __accountId: ACCOUNT, __oneBotSessionId: ws.__hermesSessionId, sender: { role: "admin" } };
  function revision(id, conversationId = "") {
    assert.equal(id, ACCOUNT);
    if (conversationId) revisionKeys.push(conversationId);
    return JSON.stringify([identity.owner, identity.policy, conversationId
      ? botControlRevision(memory, conversationId, config, id, { ownerId: OWNER, projected: config }) : ""]);
  }
  async function mutateMemory(root, build) {
    assert.equal(root, memory);
    const waiting = ackPause;
    ackPause = null;
    const result = await runtime.transact(build);
    // A delayed durable ACK lets another control transaction publish through
    // the SAME lane before the suspended caller resumes. Never mutate live root.
    if (waiting) { waiting.enter(); await waiting.released; }
    return result;
  }
  const environment = {
    memoryRuntime: runtime, memory, config, Date, Number, String, Array,
    asStringId: String, asArray: value => Array.isArray(value) ? value : [],
    accountGroup: () => null, now: () => new Date().toISOString(),
    conversationIdFromEvent: message => String(message.group_id),
    botCommandText: text => /^\/bot(?:\s|$)/.test(text) ? text : "",
    isPrivateOwner: () => false, isGroupAdmin: message => ["owner", "admin"].includes(message.sender?.role),
    normalizeBehaviorMode: value => ["normal", "lively", "restrained"].includes(value) ? value : "",
    behaviorModeDescription: value => value, parseDurationMs: () => 60_000, formatDuration: () => "1m",
    log: () => {}, warn: () => {}, mutateMemory,
    sendGroupMessage: async (_socket, message, text) => {
      if (!api.isQuiet(memory, String(message.group_id), config)) sent.push({ kind: "command", text });
      return true;
    },
    connectedAccountForRole: () => account, configForReplyAccount: () => structuredClone(config),
    accountExecutionRevision: revision, accountIsSelected: () => true,
    taskModeConfig: current => current.taskMode, voiceReplyMode: () => "mixed", botCommandFeedback: text => text,
    oneBotRequest: async (socket, action, params) => {
      assert.equal(socket, ws);
      assert.equal(action, "send_group_msg", "no non-fixture protocol actions are allowed");
      assert.equal(String(params.group_id), GROUP);
      sent.push({ kind: "wire", text: params.message, owner: identity.owner, policy: identity.policy });
      return {};
    },
    automationOwnerEntries: () => [{ key: OWNER, legacyRuleIds: [] }], accountById: () => account,
    oneBotAccounts: new Map([[ACCOUNT, { ws }]]), accountScopeAllows: () => true,
    shouldHandleGroup: id => String(id) === GROUP, accountCanChat: () => true,
    automationOccurrenceKey: (_rule, conversation) => JSON.stringify([RULE.id, conversation, DAY]),
    historyByGroup: new Map(), lastBotMessageByGroup: new Map(),
    compactMemory: () => "fixture memory", buildPrompt: () => "fixture model prompt", trimForGroup: text => text,
    callHermes: async () => {
      const waiting = modelPause;
      modelPause = null;
      if (waiting) { waiting.enter(); await waiting.released; }
      return "fixture generated response";
    },
    recordBotMessage: async () => {}, archiveBotReply: () => {}
  };
  const api = compile(helpers + selectedBodies.command + selectedBodies.voice + selectedBodies.automation,
    ["handleBotCommand", "handleVoiceCommand", "executeAutomationRule", "groupSettings", "isQuiet"], environment);
  function start(operation) {
    const result = Promise.resolve().then(operation);
    void result.catch(() => {});
    operations.push(result);
    return result;
  }
  return {
    runtime, memory, sent, identity, revisionKeys, revision,
    settings: () => api.groupSettings(memory, GROUP, config),
    changeMode: mode => runtime.transact(draft => { api.groupSettings(draft, GROUP, config, { write: true }).behaviorMode = mode; }),
    quiet: () => runtime.transact(draft => { api.groupSettings(draft, GROUP, config, { write: true }).quietUntil = Date.now() + 60_000; }),
    command(text, role = "admin") {
      const captured = revision(ACCOUNT);
      return start(() => api.handleBotCommand({ ws, event: { ...event, sender: { role } }, text, config, memory,
        isCurrent: () => captured === revision(ACCOUNT) }));
    },
    preset: () => start(() => api.handleVoiceCommand({ event, text: "/voice preset A", conversationId: GROUP,
      senderId: "10001", senderName: "fixture human" })),
    automation: () => start(() => api.executeAutomationRule(RULE, SCOPE)),
    ledger: () => memory.groups[SCOPE]?.dailySent?.[DAY]?.[LEDGER],
    pauseCommit() { assert.equal(commitPause, null); return (commitPause = pause()); },
    pauseAck() { assert.equal(ackPause, null); return (ackPause = pause()); },
    pauseModel() { assert.equal(modelPause, null); return (modelPause = pause()); },
    async close() {
      for (const gate of gates) gate.release();
      await bounded(Promise.allSettled(operations), "fixture operations cleanup");
      await bounded(runtime.close(), "fixture runtime close");
    }
  };
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }
test("quiet blocks queued mode builder", async f => {
  const gate = f.pauseCommit(), quiet = f.command("/bot quiet 1m");
  await bounded(gate.entered, "quiet commit entered");
  const mode = f.command("/bot mode lively");
  const rejected = assert.rejects(mode, { code: "ACCOUNT_SEND_BLOCKED" });
  gate.release(); await quiet; await rejected;
  assert.equal(f.settings().behaviorMode, "normal", "quiet must block the queued mode mutation");
  assert(f.settings().quietUntil > Date.now());
});
test("authorized resume is exempt from quiet", async f => {
  await f.quiet();
  assert.equal(await f.command("/bot resume"), true);
  assert.equal(f.settings().quietUntil, 0);
  assert.equal(f.sent.length, 1, "authorized resume must acknowledge after clearing quiet");
});
test("non-admin resume cannot clear quiet", async f => {
  await f.quiet();
  await f.command("/bot resume", "member");
  assert(f.settings().quietUntil > Date.now());
  assert.equal(f.sent.length, 0);
});
test("preset acknowledges its own committed control", async f => {
  const before = f.revision(ACCOUNT, GROUP), gate = f.pauseCommit(), operation = f.preset();
  await bounded(gate.entered, "preset commit entered");
  assert.equal(f.sent.length, 0, "preset cannot confirm before durability");
  assert.equal(f.settings().voicePreset, undefined);
  gate.release();
  assert.equal(await operation, true);
  assert.equal(f.settings().voicePreset, "A");
  assert.notEqual(f.revision(ACCOUNT, GROUP), before, "the preset changes its own control revision");
  assert.equal(f.sent.length, 1, "own control revision must not suppress the normal ACK");
  assert.match(f.sent[0].text, /换成「A」/);
});
for (const change of ["owner", "policy"]) {
  test(`preset refuses ${change} change during durability`, async f => {
    const gate = f.pauseCommit(), operation = f.preset();
    await bounded(gate.entered, "preset commit entered");
    if (change === "owner") f.identity.owner = "group:replacement-owner";
    else f.identity.policy += 1;
    gate.release(); await operation;
    assert.equal(f.sent.length, 0, `preset must not confirm after a ${change} change`);
    assert.equal(f.settings().voicePreset, "A", "a submitted write is not falsely described as rolled back");
  });
}
test("automation normal send keeps scope ledger separate", async f => {
  assert.equal(await f.automation(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.ledger()?.status, "sent");
  assert.equal(f.memory.groups[GROUP].dailySent?.[DAY]?.[LEDGER], undefined);
  assert(f.revisionKeys.includes(GROUP), "automation must read the actual control context");
  assert(!f.revisionKeys.includes(SCOPE), "scope IDs are not memory control context IDs");
});
test("automation checks context after model await", async f => {
  const gate = f.pauseModel(), operation = f.automation();
  await bounded(gate.entered, "automation model entered");
  await f.changeMode("lively");
  gate.release(); await operation;
  assert.equal(f.sent.length, 0, "a changed context must invalidate the old model response");
  assert.equal(f.ledger(), undefined, "invalidated generation must not claim an occurrence");
});
test("automation checks context after durable ACK wait", async f => {
  const gate = f.pauseAck(), operation = f.automation();
  await bounded(gate.entered, "automation durable claim ACK entered");
  assert.equal(f.ledger()?.status, "sending");
  assert.equal(f.sent.length, 0);
  await f.changeMode("restrained");
  gate.release(); await operation;
  assert.equal(f.sent.length, 0, "a context change during durable ACK must prevent send");
  assert.equal(f.ledger()?.status, "cancelled", "the durable unsent claim must have a cancellation receipt");
});
test("automation ignores unrelated scope-key controls", async f => {
  const gate = f.pauseModel(), operation = f.automation();
  await bounded(gate.entered, "automation model entered");
  await f.runtime.transact(draft => {
    draft.groups[SCOPE] = { settings: { botSettings: { [OWNER]: { behaviorMode: "restrained" } } } };
  });
  gate.release();
  assert.equal(await operation, true);
  assert.equal(f.sent.length, 1, "unrelated scope-key controls must not invalidate this context");
  assert.equal(f.ledger()?.status, "sent");
});

async function runCase(entry, selectedBodies = bodies) {
  const f = await fixture(selectedBodies);
  try { await bounded(entry.run(f), entry.name); }
  finally { await f.close(); }
}
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, "in-memory revert must match exactly one guard");
  return text.replace(before, after);
}
const mutations = [
  { name: "old command quiet guard", target: "quiet blocks queued mode builder", bodies: {
    ...bodies, command: replaceOnce(bodies.command,
      " || (isQuiet(draft, groupId, config) && (!resumeCommands.includes(command) || !admin))", "")
  } },
  ...["owner", "policy"].map(change => ({ name: `old preset ${change} ACK guard`,
    target: `preset refuses ${change} change during durability`, bodies: {
      ...bodies, voice: replaceOnce(bodies.voice,
        "      if (voiceIdentityRevision !== accountExecutionRevision(chatAccount.id)\n"
          + "        || !oneBotBindingCurrent(ws, voiceBinding) || !accountIsSelected(chatAccount.id)) return false;\n", "")
    } }))
];
const contextRead = "accountExecutionRevision(selectedAccount.id, contextId)";
assert(bodies.automation.includes(contextRead), "automation control-context guard must be present");
const oldAutomation = { ...bodies, automation: bodies.automation.replaceAll(contextRead,
  "accountExecutionRevision(selectedAccount.id, conversationId)") };
for (const target of ["automation checks context after model await", "automation checks context after durable ACK wait"]) {
  mutations.push({ name: `old scope-key revision: ${target}`, target, bodies: oldAutomation });
}

let passed = 0, regressionsDetected = 0;
for (const entry of cases) { await runCase(entry); passed += 1; }
for (const mutation of mutations) {
  const entry = cases.find(item => item.name === mutation.target);
  assert(entry, mutation.name);
  // Only real assertion failures count: syntax errors, missing fixture helpers
  // and timeouts are harness failures, not proof that the regression is caught.
  await assert.rejects(() => runCase(entry, mutation.bodies), { code: "ERR_ASSERTION" }, mutation.name);
  regressionsDetected += 1;
}
console.log(JSON.stringify({ ok: true, fixtureOnly: true, sourceExtracted: true,
  cases: passed, inMemoryRegressionsDetected: regressionsDetected, total: passed + regressionsDetected,
  liveState: false, network: false, qqSends: false }));
