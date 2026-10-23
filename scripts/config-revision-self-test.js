import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-config-revision-"));
const configPath = path.join(home, "config.json");
const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const controlPort = await freePort();
const onebotPort = await freePort();
config.control.port = controlPort;
config.listen.port = onebotPort;
config.accounts.primary.enabled = false;
for (const standby of config.accounts.standbys || []) standby.enabled = false;
config.automation.enabled = false;
config.dailyMessages.enabled = false;
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

const child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], {
  cwd: root,
  env: { ...process.env, HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root,
    HERMES_QQ_LOG_DIR: path.join(home, "logs"), HERMES_QQ_CONTROL_PORT: String(controlPort) },
  stdio: ["ignore", "ignore", "pipe"]
});
let errorTail = "";
child.stderr.on("data", (chunk) => { errorTail = `${errorTail}${chunk}`.slice(-400); });
const base = `http://127.0.0.1:${controlPort}`;
const request = async (method, body) => {
  const response = await fetch(`${base}/api/config`, {
    method,
    headers: method === "PATCH" ? { origin: base, "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, data: await response.json() };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`bridge exited: ${errorTail}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) { ready = true; break; }
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(ready, `bridge did not start: ${errorTail}`);

  const first = await request("GET");
  assert.equal(first.status, 200);
  assert.match(first.data.revision, /^[0-9a-f]{32}$/);
  const originalLength = first.data.send.maxLength;
  const saved = await request("PATCH", { expectedRevision: first.data.revision, send: { maxLength: originalLength + 1 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.config.send.maxLength, originalLength + 1);
  assert.notEqual(saved.data.config.revision, first.data.revision);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configPath, "utf8")), "expectedRevision"), false);

  const beforeStale = fs.readFileSync(configPath, "utf8");
  const stale = await request("PATCH", { expectedRevision: first.data.revision, send: { maxLength: originalLength + 2 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.ok, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeStale);
  const afterStale = await request("GET");
  assert.equal(afterStale.data.revision, saved.data.config.revision);
  assert.equal(afterStale.data.send.maxLength, originalLength + 1);

  const previousStandby = afterStale.data.accounts.standbys[0];
  const scoped = await request("PATCH", { expectedRevision: afterStale.data.revision, accounts: {
    standbys: [{ id: previousStandby.id, displayName: "isolated test name" }]
  } });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.data.config.accounts.standbys[0].displayName, "isolated test name");
  assert.equal(scoped.data.config.accounts.standbys[0].protocol, previousStandby.protocol);
  assert.equal(scoped.data.config.accounts.standbys[0].qq, previousStandby.qq);
  assert.equal(scoped.data.config.accounts.standbys[0].onebotWsUrl, previousStandby.onebotWsUrl);

  const legacy = await request("PATCH", { send: { maxLength: originalLength + 3 } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.config.send.maxLength, originalLength + 3);
  assert.notEqual(legacy.data.config.revision, saved.data.config.revision);
  const beforeInvalidBehavior = fs.readFileSync(configPath, "utf8");
  const invalidBehavior = await request("PATCH", { trigger: { activeProbability: 9 } });
  assert.equal(invalidBehavior.status, 400);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalidBehavior);
  const custom = { behaviorModes:{default:"restrained"}, trigger:{activeProbability:0.09,activeCooldownMs:241000},
    proactive:{enabled:true,probability:0.13,intervalMs:901000,cooldownMs:2401000} };
  const savedBehavior = await request("PATCH", custom);
  assert.equal(savedBehavior.status, 200);
  const reread = await request("GET"); const diskBehavior = JSON.parse(fs.readFileSync(configPath,"utf8"));
  for (const [section, values] of Object.entries(custom)) for (const [key,value] of Object.entries(values)) {
    assert.equal(reread.data[section][key],value); assert.equal(diskBehavior[section][key],value);
  }
  const numericCases = [
    ["vision.maxImagesPerMessage", 1, 4, 3, true],
    ["vision.jpegQuality", 40, 95, 87, true],
    ["vision.aiJudge.minConfidence", 0, 1, 0.61, false],
    ["socialPlanner.minConfidence", 0, 1, 0.63, false],
    ["messageDebounce.maxWaitMs", 500, 60000, 6543, true],
    ["responseQueue.liveContext.windowMs", 1000, 120000, 21000, true],
    ["responseQueue.liveContext.settleMs", 0, 5000, 0, true],
    ["chatArchive.maxRetrieveItems", 1, 20, 9, true],
    ["chatArchive.summary.everyMessages", 10, 500, 67, true],
    ["taskMode.maxRuntimeMs", 30000, 7200000, 1800000, true],
    ["taskMode.maxConcurrentGlobal", 1, 8, 3, true],
    ["taskMode.maxTurns", 1, 90, 31, true],
    ["memory.integrity.maxEntriesPerUser", 20, 500, 190, true],
    ["memory.integrity.minStableConfidence", 0, 1, 0.66, false],
    ["webSearch.maxResults", 1, 10, 5, true],
    ["webSearch.timeoutMs", 1000, 60000, 9000, true],
    ["voice.timeoutMs", 2000, 300000, 70000, true],
    ["learningMode.maxQuestionsPerDay", 1, 20, 4, true]
  ];
  const at = (value, key) => key.split(".").reduce((item, part) => item?.[part], value);
  const patchFor = (key, value) => key.split(".").reverse().reduce((item, part) => ({ [part]: item }), value);
  let rejectedNumbers = 0;
  for (const [key, min, max, value, integer] of numericCases) {
    const invalid = [min - 1, max + 1, null, true, false, {}, [], [String(value)], "not-a-number", String(value), ...(integer ? [min + 0.25] : [])];
    for (const input of invalid) {
      const prior = await request("GET");
      const before = fs.readFileSync(configPath, "utf8");
      const result = await request("PATCH", { expectedRevision: prior.data.revision, ...patchFor(key, input) });
      assert.equal(result.status, 400, `${key} must reject invalid numeric input`);
      assert(result.data.error.includes(key), `${key} error identifies the field without echoing its value`);
      assert.equal(fs.readFileSync(configPath, "utf8"), before, `${key} rejection must not write any config`);
      assert.equal((await request("GET")).data.revision, prior.data.revision, `${key} rejection must not advance the revision`);
      rejectedNumbers++;
    }
    const prior = await request("GET");
    const result = await request("PATCH", { expectedRevision: prior.data.revision, ...patchFor(key, value) });
    assert.equal(result.status, 200, `${key} must accept valid custom values`);
    assert.equal(at(result.data.config, key), value, `${key} acknowledged value`);
    assert.equal(at((await request("GET")).data, key), value, `${key} readback value`);
    assert.equal(at(JSON.parse(fs.readFileSync(configPath, "utf8")), key), value, `${key} durable value`);
  }
  // A valid field in the same request cannot leak through a rejected field.
  const beforeAtomic = fs.readFileSync(configPath, "utf8");
  assert.equal((await request("PATCH", { taskMode: { maxTurns: 42 }, vision: { jpegQuality: 999 } })).status, 400);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeAtomic);
  process.stdout.write(`config revision self-test: PASS (${rejectedNumbers} invalid numeric writes rejected; ${numericCases.length} custom values acknowledged/read/durable; atomic rejection)\n`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  fs.rmSync(home, { recursive: true, force: true });
}
