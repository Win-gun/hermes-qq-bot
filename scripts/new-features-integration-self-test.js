import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

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
  config.listen.port = await unusedPort();
  config.control.port = await unusedPort();
  config.accounts.primary.enabled = false;
  config.accounts.standbys[0].enabled = false;
  config.accounts.failover.enabled = false;
  config.dailyMessages.enabled = false;
  config.automation.enabled = false;
  config.voice.unexpectedField = "private-fixture-marker";
  config.voice.apiKeyEnv = "invalid-env-name-with-dashes";
  writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  let output = "";
  child = spawn(process.execPath, [join(root, "src/bridge.js")], {
    cwd: root,
    env: { ...process.env, HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root },
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
      id: "daily_summary", enabled: true, timezone: "Asia/Shanghai",
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
  assert.equal(saved.automation.rules[0].trigger.time, "23:30");
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
  const publicConfig = await (await fetch(`${base}/api/config`)).json();
  assert.equal(publicConfig.config?.voice?.apiKeyEnv || publicConfig.voice?.apiKeyEnv, "MIMO_API_KEY");
  assert.equal(JSON.stringify(publicConfig).includes("private-fixture-marker"), false, "unknown voice fields must not be exposed");
  console.log(JSON.stringify({ ok: true, checks: "isolated account role/name/style PATCH, persistence, hot read, no QQ send" }));
} finally {
  child?.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
}
