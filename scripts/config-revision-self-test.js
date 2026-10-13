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
  process.stdout.write("config revision self-test: PASS\n");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  fs.rmSync(home, { recursive: true, force: true });
}
