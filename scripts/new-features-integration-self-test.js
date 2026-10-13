import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import vm from "node:vm";
import WebSocket from "ws";
import { accountGroup, effectiveAccount, registryConfig } from "../src/account-registry.js";

// Read-only, in-memory check of the task transport selector. A paused creation
// account must not suppress its logical group's healthy replacement, but a
// paused independent account must still have no delivery route.
const bridgeSource = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
const deliveryStart = bridgeSource.indexOf("  function taskDeliveryAccount(task) {");
const deliveryEnd = bridgeSource.indexOf("  async function sendTaskArtifact(", deliveryStart);
assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart);
const deliveryConfig = registryConfig({ accounts: { version: 2,
  items: [{ id: "creator", enabled: false }, { id: "replacement" }, { id: "independent", enabled: false }],
  failoverGroups: [{ id: "delivery-group", memberIds: ["creator", "replacement"], policyAccountId: "creator", policy: {} }] } });
const replacementSocket = { readyState: 1 };
const taskDelivery = vm.runInNewContext(`${bridgeSource.slice(deliveryStart, deliveryEnd)}\ntaskDeliveryAccount;`, {
  config: deliveryConfig, accountById: effectiveAccount, accountGroup,
  accountTopology: () => deliveryConfig.accounts.topology, activeAccountId: "creator",
  selectedGroupAccount: () => "replacement", accountConnected: (id) => id === "replacement",
  oneBotAccounts: new Map([["replacement", { ws: replacementSocket }]])
});
assert.equal(taskDelivery({ accountId: "creator" })?.ws, replacementSocket, "paused creator uses its group's selected healthy socket");
assert.equal(taskDelivery({ accountId: "independent" }), null, "paused independent bot must not borrow a group's socket");
deliveryConfig.accounts.items.find((item) => item.id === "replacement").protocolEnabled = false;
assert.equal(taskDelivery({ accountId: "creator" }), null, "stopped replacement cannot deliver a task");

const root = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "hermes-qq-features-"));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child;
try {
  const config = JSON.parse(readFileSync(join(root, "config.example.json"), "utf8"));
  const fakeHermes = join(home, "fake-hermes.sh");
  const promptCapture = join(home, "captured-prompts.txt");
  const slowOnce = join(home, "slow-once");
  const slowEntered = join(home, "slow-entered");
  writeFileSync(fakeHermes, `#!/bin/sh
printf '%s\\n---PROMPT---\\n' "$*" >> "$HERMES_QQ_TEST_PROMPT_CAPTURE"
case "$*" in
  *HOTSWITCH*)
    if [ -f "$HERMES_QQ_TEST_SLOW_ONCE" ]; then
      rm "$HERMES_QQ_TEST_SLOW_ONCE"
      : > "$HERMES_QQ_TEST_SLOW_ENTERED"
      sleep 1
    fi
    ;;
esac
printf '隔离测试回复\\n'
`, { mode: 0o700 });
  config.ai.command = fakeHermes;
  config.ai.args = [];
  config.webSearch.enabled = false;
  config.taskMode.enabled = false;
  config.proactive.enabled = false;
  config.socialPlanner.enabled = false;
  config.messageDebounce.enabled = false;
  config.loginRecovery.enabled = false;
  config.adminNotifications.enabled = false;
  config.memory.aiExtraction.enabled = false;
  delete config.dailyMessages;
  delete config.hourlyChat;
  config.listen.port = await unusedPort();
  config.control.port = await unusedPort();
  // Keep the isolated bridge away from the user's live SnowLuma sockets.
  config.accounts.primary.onebotWsUrl = `ws://127.0.0.1:${await unusedPort()}`;
  config.accounts.standbys[0].onebotWsUrl = `ws://127.0.0.1:${await unusedPort()}`;
  config.accounts.primary.protocol = "napcat";
  config.accounts.standbys[0].protocol = "napcat";
  config.accounts.primary.qq = "90001";
  config.accounts.standbys[0].qq = "90002";
  config.accounts.primary.enabled = false;
  config.accounts.standbys[0].enabled = false;
  config.accounts.failover.enabled = false;
  config.automation.enabled = false;
  config.voice.unexpectedField = "private-fixture-marker";
  config.voice.apiKeyEnv = "invalid-env-name-with-dashes";
  writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  let output = "";
  child = spawn(process.execPath, [join(root, "src/bridge.js")], {
    cwd: root,
    env: { ...process.env, HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root,
      HERMES_QQ_TEST_PROMPT_CAPTURE: promptCapture, HERMES_QQ_TEST_SLOW_ONCE: slowOnce,
      HERMES_QQ_TEST_SLOW_ENTERED: slowEntered },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-2000); });
  const base = `http://127.0.0.1:${config.control.port}`;
  let started = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) { started = true; break; }
    } catch { /* wait for isolated bridge */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(started, `isolated bridge did not start: ${output}`);
  const beforePatch = await (await fetch(`${base}/api/config`)).json();
  assert.equal(beforePatch.config?.voice?.apiKeyEnv || beforePatch.voice?.apiKeyEnv, "MIMO_API_KEY");
  assert.equal(JSON.stringify(beforePatch).includes("invalid-env-name-with-dashes"), false);
  assert.equal(JSON.stringify(beforePatch).includes("private-fixture-marker"), false);

  const patch = {
    accounts: { topology: "function_split", primary: { enabled: false }, standbys: [{ id: "standby-a", enabled: false }] },
    botFeatures: { defaultMode: "all", accountModes: { primary: "chat", "standby-a": "task" },
      interBot: { enabled: false, probability: 0.03, cooldownMs: 1800000 } },
    styleProfiles: { activeId: "legacy", profiles: [
      { id: "legacy", name: "保留旧风格", systemPrompt: "" },
      { id: "task", name: "任务风格", systemPrompt: "只回答任务进度。" }
    ] },
    learningMode: { enabled: true, groupIds: ["123456"], minIntervalMs: 900000, maxQuestionsPerDay: 2 },
    taskMode: { webResearchEnabled: true, allowedWebDomains: ["docs.example.org"] },
    automation: { enabled: true, rules: [{
      id: "daily_summary", accountId: "primary", enabled: true, timezone: "Asia/Shanghai",
      scope: { conversationIds: ["group:123456"] },
      trigger: { type: "schedule", time: "23:30", daysOfWeek: [1, 2, 3, 4, 5], windowMinutes: 3 },
      action: { kind: "summary" }, prompt: "总结今天的讨论"
    }] },
    voice: { enabled: true, apiKeyEnv: "MIMO_API_KEY", asr: { enabled: true, autoTranscribe: false },
      tts: { enabled: true, model: "mimo-v2.5-tts", voice: "mimo_default", allowedVoices: ["mimo_default", "茉莉"], allowMemberVoiceDesign: false },
      voiceClone: { enabled: false, requireConsent: true } }
  };
  const response = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch)
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 600));
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(saved.accounts.topology, "function_split");
  assert.equal(saved.accounts.primary.enabled, false);
  assert.equal(saved.botFeatures.accountModes["standby-a"], "task");
  assert.equal(saved.botFeatures.interBot.cooldownMs, 1800000);
  assert.equal(saved.styleProfiles.profiles[1].systemPrompt, "只回答任务进度。");
  assert.equal(saved.learningMode.groupIds[0], "123456");
  assert.deepEqual(saved.taskMode.allowedWebDomains, ["docs.example.org"]);
  assert.equal(saved.automation.accounts.primary.rules[0].trigger.time, "23:30");
  assert.deepEqual(saved.voice.tts.allowedVoices, ["mimo_default", "茉莉"]);
  assert.equal(saved.voice.tts.allowMemberVoiceDesign, false);
  const rolesResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounts: {
      topology: "function_split",
      primary: { enabled: true, displayName: "主 bot" },
      standbys: [{ id: "standby-a", enabled: true, displayName: "独立任务 bot", styleProfileId: "task" }]
    } })
  });
  assert.equal(rolesResponse.status, 200);
  const roles = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(roles.accounts.primary.displayName, "主 bot");
  assert.equal(roles.accounts.standbys[0].displayName, "独立任务 bot");
  assert.equal(roles.accounts.standbys[0].styleProfileId, "task");
  assert.equal(roles.accounts.standbys[0].enabled, true);
  const independentHealth = await (await fetch(`${base}/health`)).json();
  assert.equal(independentHealth.topology, "function_split");
  assert.equal(independentHealth.primaryReceiveStalled, "");
  assert.equal(independentHealth.primaryRecoveryBlocked, "");
  assert.equal(independentHealth.primaryNeedsAttention, false, "independent accounts must not inherit failover incidents");
  assert.deepEqual(independentHealth.accountsNeedingAttention.sort(), ["primary", "standby-a"]);
  const accountPromptResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounts: { promptOverrides: { primary: "主账号专属", "standby-a": "备用号专属" } } })
  });
  assert.equal(accountPromptResponse.status, 200);
  const prompted = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(prompted.accounts.primary.promptOverride, "主账号专属");
  assert.equal(prompted.accounts.standbys[0].promptOverride, "备用号专属");
  assert.equal(prompted.accounts.standbys[0].styleProfileId, "task");
  const resetPromptResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounts: { promptOverrides: { "standby-a": "" } } })
  });
  assert.equal(resetPromptResponse.status, 200);
  const resetPrompts = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(resetPrompts.accounts.primary.promptOverride, "主账号专属");
  assert.equal(resetPrompts.accounts.standbys[0].promptOverride, "");
  const bothChatResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botFeatures: { defaultMode: "chat", accountModes: { primary: "chat", "standby-a": "chat" } }, voice: { enabled: false } })
  });
  assert.equal(bothChatResponse.status, 200);
  const firstSocket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  await new Promise((resolve, reject) => { firstSocket.once("open", resolve); firstSocket.once("error", reject); });
  const secondSocket = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`);
  await new Promise((resolve, reject) => { secondSocket.once("open", resolve); secondSocket.once("error", reject); });
  const replies = new Set();
  const privateActions = [];
  const groupReplies = new Set();
  const groupActions = [];
  for (const [socket, accountId] of [[firstSocket, "primary"], [secondSocket, "standby-a"]]) {
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      if (request.action === "send_private_msg") { replies.add(accountId); privateActions.push(accountId); }
      if (request.action === "send_group_msg") { groupReplies.add(accountId); groupActions.push(accountId); }
      if (request.echo) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { message_id: `reply-${accountId}` } }));
    });
  }
  for (const [socket, selfId, messageId, body] of [
    [firstSocket, "90001", "test-primary", "只发给甲的私聊"],
    [secondSocket, "90002", "test-secondary", "只发给乙的私聊"]
  ]) socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: selfId,
    user_id: "10001", message_id: messageId, time: Math.floor(Date.now() / 1000),
    sender: { user_id: "10001", nickname: "测试用户" }, message: body, raw_message: body }));
  for (let attempt = 0; attempt < 100 && replies.size < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual([...replies].sort(), ["primary", "standby-a"], `isolated peer replies missing: ${output}`);
  for (const [accountId, body] of [["primary", "只发给甲的私聊"], ["standby-a", "只发给乙的私聊"]]) {
    const archive = join(home, "data", "chat-archive", "private", `10001-${accountId}`, "messages.jsonl");
    assert.ok(existsSync(archive), `missing private archive for ${accountId}`);
    const content = readFileSync(archive, "utf8");
    assert.ok(content.includes(body), `missing message for ${accountId}`);
    assert.ok(!content.includes(accountId === "primary" ? "只发给乙的私聊" : "只发给甲的私聊"), `private chats crossed for ${accountId}`);
  }
  const dualGroupMessage = { post_type: "message", message_type: "group", group_id: "123456", user_id: "10001",
    message_id: "group-dual", time: Math.floor(Date.now() / 1000), sender: { user_id: "10001", nickname: "测试用户" },
    message: [{ type: "at", data: { qq: "90001" } }, { type: "at", data: { qq: "90002" } }, { type: "text", data: { text: "各说一句" } }],
    raw_message: "[CQ:at,qq=90001][CQ:at,qq=90002]各说一句" };
  for (const [socket, selfId] of [[firstSocket, "90001"], [secondSocket, "90002"]]) {
    socket.send(JSON.stringify({ ...dualGroupMessage, self_id: selfId }));
  }
  for (let attempt = 0; attempt < 100 && groupReplies.size < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual([...groupReplies].sort(), ["primary", "standby-a"], `dual-addressed group replies missing: ${output}`);
  const groupArchive = join(home, "data", "chat-archive", "groups", "123456", "messages.jsonl");
  const groupRecords = readFileSync(groupArchive, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(groupRecords.filter((record) => record.type === "user_message" && record.messageId === "group-dual").length, 1,
    "shared group archive must store the human message once");
  const taskSplitResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botFeatures: { defaultMode: "all", accountModes: { primary: "chat", "standby-a": "task" } }, taskMode: { enabled: true } })
  });
  assert.equal(taskSplitResponse.status, 200);
  groupReplies.clear();
  groupActions.length = 0;
  const taskStatus = { ...dualGroupMessage, message_id: "task-control", message: "/task status", raw_message: "/task status" };
  for (const [socket, selfId] of [[firstSocket, "90001"], [secondSocket, "90002"]]) {
    socket.send(JSON.stringify({ ...taskStatus, self_id: selfId }));
  }
  for (let attempt = 0; attempt < 50 && groupActions.length < 1; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(groupActions, ["standby-a"], `task status must reply once through task bot: ${output}`);
  groupActions.length = 0;
  const dualTaskStatus = { ...taskStatus, message_id: "task-control-dual",
    message: "/task status [CQ:at,qq=90001] [CQ:at,qq=90002]",
    raw_message: "/task status [CQ:at,qq=90001] [CQ:at,qq=90002]" };
  for (const [socket, selfId] of [[firstSocket, "90001"], [secondSocket, "90002"]]) {
    socket.send(JSON.stringify({ ...dualTaskStatus, self_id: selfId }));
  }
  for (let attempt = 0; attempt < 50 && groupActions.length < 1; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(groupActions, ["standby-a"], `dual-addressed task control must not duplicate: ${output}`);
  // Change topology while Hermes is already drafting. The first (independent)
  // draft must not be sent; the retry must use the new failover identity.
  // This test exercises routing, not automation transfer. Explicitly remove
  // its disposable rule before regrouping; populated ownership must not drift.
  const clearSession = (await (await fetch(`${base}/api/admin/session`)).json()).token;
  const clearSnapshot = await (await fetch(`${base}/api/accounts`, { headers: { "x-hermes-qq-admin": clearSession } })).json();
  const clearResponse = await fetch(`${base}/api/automation/accounts/primary`, { method: "PATCH",
    headers: { "Content-Type": "application/json", origin: base, "x-hermes-qq-admin": clearSession },
    body: JSON.stringify({ expectedRevision: clearSnapshot.revision, rules: [] }) });
  assert.equal(clearResponse.status, 200);
  privateActions.length = 0;
  writeFileSync(slowOnce, "", { mode: 0o600 });
  const hotSwitchText = "HOTSWITCH 请介绍当前账号关系";
  firstSocket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: "90001",
    user_id: "10001", message_id: "hot-switch", time: Math.floor(Date.now() / 1000),
    sender: { user_id: "10001", nickname: "测试用户" }, message: hotSwitchText, raw_message: hotSwitchText }));
  for (let attempt = 0; attempt < 100 && !existsSync(slowEntered); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(slowEntered), `Hermes did not start the old-mode draft: ${output}`);
  const failoverResponse = await fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounts: { topology: "failover" } })
  });
  assert.equal(failoverResponse.status, 200);
  for (let attempt = 0; attempt < 100 && privateActions.length < 1; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const routeEvidence = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const routeHealth = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(privateActions, ["primary"], `mode switch must produce exactly one fresh reply: ${output}\n${JSON.stringify({ items: routeEvidence.accounts.items.map(item => ({id:item.id,enabled:item.enabled,features:item.features})), groups:routeEvidence.accounts.failoverGroups.map(group=>({id:group.id,features:group.policy.features})), active:routeHealth.activeAccountId, states:routeHealth.accounts.map(account=>({id:account.id,diagnosis:account.diagnosis?.routeState})) })}`);
  const captured = readFileSync(promptCapture, "utf8").split("---PROMPT---").filter((item) => item.includes("HOTSWITCH"));
  assert.equal(captured.length, 2, "mode switch must discard the old draft and regenerate once");
  assert.match(captured[0], /账号平级，不存在主备接管/);
  assert.match(captured[1], /当前运行方式：主备接管/);

  // P1 regression: automation rules use public conversation IDs, while private
  // history uses account/group-scoped IDs. Even rules=[] previously threw in
  // the matcher and swallowed every ordinary private message on these routes.
  let coordinatorState;
  for (let attempt = 0; attempt < 100; attempt++) {
    coordinatorState = (await (await fetch(`${base}/health`)).json()).replyCoordinator;
    if (coordinatorState?.activeCount === 0 && coordinatorState.pending === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(coordinatorState?.activeCount, 0, "finish the acknowledged topology-switch reply before the next fixture");
  assert.equal(coordinatorState.pending, 0);
  const regressionSession = (await (await fetch(`${base}/api/admin/session`)).json()).token;
  assert.ok(regressionSession, "isolated registry API requires a local admin session");
  const mutateRegressionRegistry = async (route, method, body) => {
    const snapshot = await (await fetch(`${base}/api/accounts`, { headers: { "x-hermes-qq-admin": regressionSession } })).json();
    const response = await fetch(`${base}${route}`, { method,
      headers: { "Content-Type": "application/json", origin: base, "x-hermes-qq-admin": regressionSession },
      body: JSON.stringify({ expectedRevision: snapshot.revision, ...body }) });
    assert.equal(response.status, 200, `private automation registry setup ${route}: HTTP ${response.status}`);
  };
  const patchPrivateAutomation = async (failoverGroups) => {
    const response = await fetch(`${base}/api/config`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: { topology: "function_split" },
        automation: { enabled: true }, taskMode: { enabled: false }, voice: { enabled: false } })
    });
    assert.equal(response.status, 200, `private automation regression setup: ${JSON.stringify(await response.json()).slice(0, 600)}`);
    for (const id of ["primary", "standby-a"]) {
      await mutateRegressionRegistry(`/api/automation/accounts/${id}`, "PATCH", { rules: [] });
      await mutateRegressionRegistry(`/api/accounts/${id}`, "PATCH", {
        patch: { enabled: true, features: { chat: true, task: false, automation: true } }
      });
    }
    for (const group of failoverGroups) await mutateRegressionRegistry("/api/account-groups", "POST", { group });
    const actual = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(actual.automation.enabled, true);
    assert.deepEqual(actual.automation.rules, []);
    assert.equal(actual.accounts.failoverGroups.length, failoverGroups.length);
    for (const item of actual.accounts.items) assert.equal(item.features.automation, true, "exercise the enabled account path");
  };
  const assertPrivateAutomationReply = async (socket, accountId, selfId, marker, archiveId, conversationId, text = marker) => {
    const before = privateActions.filter((id) => id === accountId).length;
    socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: selfId,
      user_id: "10001", message_id: marker, time: Math.floor(Date.now() / 1000),
      sender: { user_id: "10001", nickname: "测试用户" }, message: text, raw_message: text }));
    const archivePath = join(home, "data", "chat-archive", "private", archiveId, "messages.jsonl");
    let records = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(archivePath)) records = readFileSync(archivePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const userIndex = records.findIndex((record) => record.messageId === marker);
      if (privateActions.filter((id) => id === accountId).length > before && userIndex >= 0
        && records.slice(userIndex + 1).some((record) => record.type === "bot_reply" && record.accountId === accountId)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(privateActions.filter((id) => id === accountId).length, before + 1,
      `${accountId}: scoped private chat must reply with automation enabled and rules=[]: ${output}`);
    assert.ok(records.some((record) => record.messageId === marker && record.conversationId === conversationId),
      `${accountId}: keep scoped private archive identity instead of replacing it with matcher ID`);
    return records;
  };
  await patchPrivateAutomation([]);
  await assertPrivateAutomationReply(firstSocket, "primary", "90001", "AUTOMATION_EMPTY_OWN_A",
    "10001-primary", "private:10001:primary");
  await assertPrivateAutomationReply(secondSocket, "standby-a", "90002", "AUTOMATION_EMPTY_OWN_B",
    "10001-standby-a", "private:10001:standby-a");
  const summaryRule = { id: "fixture_private_summary", accountId: "standby-a", scope: { conversationIds: ["private:10001"] },
    trigger: { type: "command", text: "/fixture-summary" }, action: { kind: "summary" }, prompt: "AUTOMATION_CONTEXT_PROBE" };
  const summaryPatch = await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ automation: { enabled: true, rules: [summaryRule] } }) });
  assert.equal(summaryPatch.status, 200);
  const summaryRecords = await assertPrivateAutomationReply(secondSocket, "standby-a", "90002", "AUTOMATION_SCOPED_COMMAND",
    "10001-standby-a", "private:10001:standby-a", "/fixture-summary");
  assert.ok(summaryRecords.some((record) => record.source === "automation:fixture_private_summary"
    && record.accountId === "standby-a" && record.conversationId === "private:10001:standby-a"), "actual automation reply keeps selected private identity");
  const summaryPrompt = readFileSync(promptCapture, "utf8").split("---PROMPT---").find((item) => item.includes("AUTOMATION_CONTEXT_PROBE"));
  assert.ok(summaryPrompt?.includes("AUTOMATION_EMPTY_OWN_B"), "automation must read selected account's private history");
  assert.ok(!summaryPrompt.includes("AUTOMATION_EMPTY_OWN_A"), "automation must not read the other bot's private history");
  const regressionGroupId = "private-automation-group";
  await patchPrivateAutomation([{ id: regressionGroupId, name: "私聊空规则回归组", memberIds: ["primary", "standby-a"],
    policyAccountId: "primary", policy: {}, legacySelfMemory: false, settings: { enabled: false } }]);
  const scopedPrivateId = `10001:group:${regressionGroupId}`;
  await assertPrivateAutomationReply(firstSocket, "primary", "90001", "AUTOMATION_EMPTY_GROUP",
    `ctx-${Buffer.from(scopedPrivateId).toString("base64url")}`, `private:${scopedPrivateId}`);
  firstSocket.close();
  secondSocket.close();
  const publicConfig = await (await fetch(`${base}/api/config`)).json();
  assert.equal(publicConfig.config?.voice?.apiKeyEnv || publicConfig.voice?.apiKeyEnv, "MIMO_API_KEY");
  assert.equal(JSON.stringify(publicConfig).includes("private-fixture-marker"), false, "unknown voice fields must not be exposed");
  const failoverHealth = await (await fetch(`${base}/health`)).json();
  assert.equal(failoverHealth.topology, "failover");
  assert.equal(failoverHealth.primaryNeedsAttention, true, "failover mode still diagnoses its primary account");
  console.log(JSON.stringify({ ok: true, checks: "isolated account PATCH, dual private/group WS routing, separate private archives, one task-control reply from task bot, in-flight topology switch discards stale draft, automation empty-rules scoped private replies for two accounts and a new group, automation command private history/archive isolation, paused task creator uses selected group replacement, no QQ send" }));
  if (process.env.HERMES_QQ_UI_PREVIEW === "1") {
    console.log(`Account prompt preview: ${base}/admin`);
    await new Promise((resolve) => process.once("SIGTERM", resolve));
  }
} finally {
  child?.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
}
