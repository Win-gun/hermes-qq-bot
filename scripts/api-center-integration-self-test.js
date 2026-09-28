import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-api-integration-"));
const config = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));

function freePort() {
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
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });

const child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], {
  cwd: root,
  env: { ...process.env, HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root,
    HERMES_QQ_LOG_DIR: path.join(home, "logs"), HERMES_QQ_CONTROL_PORT: String(controlPort) },
  stdio: ["ignore", "ignore", "pipe"]
});
let errorTail = "";
child.stderr.on("data", (chunk) => { errorTail = `${errorTail}${chunk}`.slice(-400); });
const base = `http://127.0.0.1:${controlPort}`;
const request = async (url, { method = "GET", token = "", body, origin = base } = {}) => {
  const response = await fetch(`${base}${url}`, { method, headers: {
    ...(token ? { "x-hermes-qq-admin": token } : {}),
    ...(method !== "GET" ? { origin, "content-type": "application/json" } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`bridge exited: ${errorTail}`);
    try { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }); if (response.ok) { ready = true; break; } }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(ready, `bridge did not start: ${errorTail}`);
  assert.equal((await request("/api/api-center")).status, 403);
  const token = (await request("/api/admin/session")).data.token;
  assert(token);
  const original = await request("/api/api-center", { token });
  assert.equal(original.status, 200);
  const center = original.data.center;
  assert.equal(center.bindings.task, "inherit-chat");
  assert.equal((await request("/api/api-center", { method: "PATCH", token, origin: "http://example.com", body: { revision: original.data.revision, center } })).status, 403);
  assert.equal((await request("/api/api-center", { method: "PATCH", token, body: { revision: "stale", center } })).status, 409);
  const chat = center.profiles.find((item) => item.id === center.bindings.chat);
  const priorModel = chat.model;
  chat.model = "integration-test-model";
  const saved = await request("/api/api-center", { method: "PATCH", token, body: { revision: original.data.revision, center } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.center.profiles.find((item) => item.id === center.bindings.chat).model, "integration-test-model");
  assert.equal((await request("/api/config")).data.ai.model, "integration-test-model");
  assert.equal((await request("/api/api-center/test", { method: "POST", token, body: { center, capability: "unsupported" } })).status, 400);
  const legacy = await request("/api/config", { method: "PATCH", body: { vision: { model: "legacy-vision-test" } } });
  assert.equal(legacy.status, 200);
  const synchronized = (await request("/api/api-center", { token })).data.center;
  assert.equal(synchronized.profiles.find((item) => item.id === synchronized.bindings.vision).model, "legacy-vision-test");
  assert.equal(synchronized.profiles.find((item) => item.id === synchronized.bindings.chat).model, "integration-test-model");
  assert.notEqual(priorModel, "integration-test-model");
  process.stdout.write("api-center integration self-test: PASS\n");
  if (process.env.HERMES_QQ_UI_PREVIEW === "1") {
    const preview = await request("/api/api-center", { token });
    const draft = preview.data.center;
    const connection = draft.connections.find((item) => ["xiaomi", "mimo"].includes(item.provider.toLowerCase())
      && (!item.baseUrl || item.baseUrl.startsWith("https://api.xiaomimimo.com/v1")));
    if (connection) {
      draft.searchProfiles.push({ id: "mimo-preview", name: "MiMo 官方联网", provider: "mimo-web-search",
        providerOrder: ["mimo-web-search"], connectionId: connection.id, model: "mimo-v2.6-flash",
        maxKeyword: 2, forceSearch: true, maxResults: 4, timeoutMs: 20000,
        proxy: { enabled: false, autoDetect: false, directFallback: false, urls: [] } });
      draft.searchBinding = "mimo-preview";
      const savedPreview = await request("/api/api-center", { method: "PATCH", token,
        body: { revision: preview.data.revision, center: draft } });
      assert.equal(savedPreview.status, 200);
    }
    process.stdout.write(`API Center preview: ${base}/admin\n`);
    await new Promise((resolve) => process.once("SIGTERM", resolve));
  }
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  fs.rmSync(home, { recursive: true, force: true });
}
