import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
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
const syntheticSecret = "test-only-api-key-0000";
const fakeHermes = path.join(home, "fake-hermes.cjs");
fs.writeFileSync(fakeHermes, `#!${process.execPath}\nif (process.env.OPENAI_API_KEY !== ${JSON.stringify(syntheticSecret)}) process.exit(3);\nif (!process.argv.includes('unbound-test-model')) process.exit(4);\nprocess.stdout.write('ok');\n`, { mode: 0o700 });
const fakeSecurity = path.join(home, "fake-security.cjs");
fs.writeFileSync(fakeSecurity, String.raw`const child = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = child.spawnSync;
const values = new Map();
child.spawnSync = (command, args, options) => {
  if (command !== "/usr/bin/security") return original(command, args, options);
  if (args[0] === "-i") {
    const match = String(options.input || "").match(/^add-generic-password -a ("[^"]+") -s ("[^"]+") -U -w ("[^"]+")\n$/);
    if (!match) return { status: 1, stdout: "", stderr: "" };
    values.set(JSON.parse(match[2]) + ":" + JSON.parse(match[1]), JSON.parse(match[3]));
    return { status: 0, stdout: "", stderr: "" };
  }
  const account = args[args.indexOf("-a") + 1];
  const service = args[args.indexOf("-s") + 1];
  const key = service + ":" + account;
  if (args[0] === "delete-generic-password") {
    const exists = values.delete(key);
    return { status: exists ? 0 : 44, stdout: "", stderr: "" };
  }
  if (!values.has(key)) return { status: 44, stdout: "", stderr: "" };
  return args.includes("-w") ? { status: 0, stdout: values.get(key) + "\n", stderr: "" }
    : { status: 0, stdout: "", stderr: '"cdat"<timedate>="20261022080910Z"\n"mdat"<timedate>="20261022080910Z"\n' };
};
syncBuiltinESMExports();
`, { mode: 0o600 });
config.ai.command = fakeHermes;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });

const child = spawn(process.execPath, [path.join(root, "src", "bridge.js")], {
  cwd: root,
  env: { ...process.env, HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root,
    HERMES_QQ_LOG_DIR: path.join(home, "logs"), HERMES_QQ_CONTROL_PORT: String(controlPort),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${fakeSecurity}`.trim() },
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
  assert.equal((await request("/api/api-center/credentials")).status, 403);
  const token = (await request("/api/admin/session")).data.token;
  assert(token);
  const original = await request("/api/api-center", { token });
  assert.equal(original.status, 200);
  const credentials = await request("/api/api-center/credentials", { token });
  assert.equal(credentials.status, 200);
  assert(Array.isArray(credentials.data.credentials));
  assert(!JSON.stringify(credentials.data).includes(syntheticSecret));
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
  let completionRequest = null;
  const modelsServer = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${syntheticSecret}`);
    if (req.url === "/v1/chat/completions") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        completionRequest = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "synthetic direct reply" } }] }));
      });
      return;
    }
    if (req.url === "/fail/models") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: syntheticSecret }));
      return;
    }
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ secret: syntheticSecret }));
  });
  await new Promise((resolve) => modelsServer.listen(0, "127.0.0.1", resolve));
  try {
    const draft = structuredClone(center);
    draft.connections.push({ id: "draft-test", name: "草稿连接", provider: "custom",
      baseUrl: `http://127.0.0.1:${modelsServer.address().port}/v1`, credentialSource: "existing", apiKeyEnv: "OPENAI_API_KEY" });
    draft.profiles.push({ id: "unbound-test", name: "未绑定模型", kind: "chat", connectionId: "draft-test", model: "unbound-test-model" });
    draft.profiles.push({ id: "incomplete-other", name: "尚未填完", kind: "chat", connectionId: "missing", model: "" });
    assert.equal((await request("/api/api-center/test", { method: "POST", body: { target: "connection", connectionId: "draft-test", center: draft, secret: syntheticSecret } })).status, 403);
    assert.equal((await request("/api/api-center/test", { method: "POST", token, origin: "http://example.com",
      body: { target: "connection", connectionId: "draft-test", center: draft, secret: syntheticSecret } })).status, 403);
    const connectionTest = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "connection", connectionId: "draft-test", center: draft, secret: syntheticSecret } });
    assert.equal(connectionTest.status, 200, JSON.stringify(connectionTest.data));
    assert.equal(connectionTest.data.target, "connection");
    assert(!JSON.stringify(connectionTest.data).includes(syntheticSecret));
    const failingDraft = structuredClone(draft);
    failingDraft.connections.find((item) => item.id === "draft-test").baseUrl = `http://127.0.0.1:${modelsServer.address().port}/fail`;
    const failed = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "connection", connectionId: "draft-test", center: failingDraft, secret: syntheticSecret } });
    assert.equal(failed.status, 502);
    assert(!JSON.stringify(failed.data).includes(syntheticSecret));
    const forged = structuredClone(draft);
    forged.connections.find((item) => item.id === "draft-test").credentialSource = "keychain";
    forged.connections.find((item) => item.id === "draft-test").credentialRef = "ec021717-671a-4c86-9ca0-c44265deee81";
    assert.equal((await request("/api/api-center/test", { method: "POST", token,
      body: { target: "connection", connectionId: "draft-test", center: forged } })).status, 400);
    const profileTest = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "profile", profileId: "unbound-test", center: draft, secret: syntheticSecret } });
    assert.equal(profileTest.status, 200, JSON.stringify(profileTest.data));
    assert.equal(profileTest.data.profileId, "unbound-test");
    assert(!JSON.stringify(profileTest.data).includes(syntheticSecret));
    const persisted = JSON.stringify((await request("/api/api-center", { token })).data.center);
    assert(!persisted.includes("draft-test"));
    assert(!persisted.includes(syntheticSecret));
    assert(!fs.readFileSync(path.join(home, "config.json"), "utf8").includes(syntheticSecret));
    const beforeKeySave = (await request("/api/api-center", { token })).data;
    const keyDraft = structuredClone(beforeKeySave.center);
    const clientRef = "ec021717-671a-4c86-9ca0-c44265deee81";
    keyDraft.connections.push({ id: "managed-test", name: "受管连接", provider: "custom",
      baseUrl: `http://127.0.0.1:${modelsServer.address().port}/v1`, credentialSource: "keychain",
      apiKeyEnv: "OPENAI_API_KEY", credentialRef: clientRef });
    const keySaved = await request("/api/api-center", { method: "PATCH", token,
      body: { revision: beforeKeySave.revision, center: keyDraft } });
    assert.equal(keySaved.status, 200, JSON.stringify(keySaved.data));
    const managed = keySaved.data.center.connections.find((item) => item.id === "managed-test");
    assert.notEqual(managed.credentialRef, clientRef, "server allocates new credential references");
    assert.equal((await request(`/api/api-center/credentials/${managed.credentialRef}`, { method: "POST", token,
      body: { secret: syntheticSecret } })).status, 200);
    const directFlag = await request("/api/config", { method: "PATCH", body: { ai: { textTransport: "direct" } } });
    assert.equal(directFlag.status, 200);
    assert.equal((await request("/api/config")).data.ai.textTransport, "direct");
    const directCenter = structuredClone(keySaved.data.center);
    directCenter.connections.find((item) => item.id === "managed-test").baseUrl = `http://127.0.0.1:${modelsServer.address().port}/v1`;
    directCenter.profiles.push({ id: "managed-direct-chat", name: "直接文本测试", kind: "chat", connectionId: "managed-test", model: "different-from-fake-Hermes", reasoningEffort: "low" });
    const directResult = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "profile", profileId: "managed-direct-chat", center: directCenter } });
    assert.equal(directResult.status, 200, JSON.stringify(directResult.data));
    assert.equal(completionRequest.model, "different-from-fake-Hermes");
    assert.equal(completionRequest.reasoning_effort, "low");
    assert.equal(completionRequest.tools, undefined);
    assert.match(completionRequest.messages.at(-1).content, /请仅回复：连接正常/);
    assert(!JSON.stringify(directResult.data).includes(syntheticSecret));
    const unboundBindings = structuredClone((await request("/api/api-center", { token })).data.center.bindings);
    assert.deepEqual(unboundBindings, keySaved.data.center.bindings);
    const hermesReset = await request("/api/config", { method: "PATCH", body: { ai: { textTransport: "hermes" } } });
    assert.equal(hermesReset.status, 200);
    assert.equal((await request("/api/config")).data.ai.textTransport, "hermes");
    const managedList = (await request("/api/api-center/credentials", { token })).data.credentials;
    const metadata = managedList.find((item) => item.connectionId === "managed-test");
    assert.equal(metadata.status, "configured");
    assert.equal(metadata.preview, `${syntheticSecret.slice(0, 4)}••••${syntheticSecret.slice(-4)}`);
    assert.equal(metadata.createdAt, "2026-10-22T08:09:10Z");
    assert(!JSON.stringify(managedList).includes(syntheticSecret));
    const changedTarget = structuredClone(keySaved.data.center);
    changedTarget.connections.find((item) => item.id === "managed-test").baseUrl = `http://127.0.0.1:${modelsServer.address().port}/fail`;
    const unsafeReuse = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "connection", connectionId: "managed-test", center: changedTarget } });
    assert.equal(unsafeReuse.status, 400);
    assert.match(unsafeReuse.data.error, /临时 API Key/);
    for (const capability of ["chat", "vision", "search"]) {
      const legacyUnsafe = await request("/api/api-center/test", { method: "POST", token,
        body: { capability, center: changedTarget } });
      assert.equal(legacyUnsafe.status, 400, "legacy test must not reuse a key for a changed draft target");
      assert.match(legacyUnsafe.data.error, /临时 API Key/);
    }
    const withTemporary = await request("/api/api-center/test", { method: "POST", token,
      body: { target: "connection", connectionId: "managed-test", center: changedTarget, secret: syntheticSecret } });
    assert.equal(withTemporary.status, 502, "temporary key may reach the changed target, which rejects this fixture request");
    const forgedUpdate = structuredClone(keySaved.data.center);
    forgedUpdate.connections.find((item) => item.id === "managed-test").credentialRef = clientRef;
    const fixed = await request("/api/api-center", { method: "PATCH", token,
      body: { revision: keySaved.data.revision, center: forgedUpdate } });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.center.connections.find((item) => item.id === "managed-test").credentialRef, managed.credentialRef);
    const changedSource = structuredClone(fixed.data.center);
    const changedConnection = changedSource.connections.find((item) => item.id === "managed-test");
    changedConnection.credentialSource = "existing";
    delete changedConnection.credentialRef;
    assert.equal((await request("/api/api-center", { method: "PATCH", token,
      body: { revision: fixed.data.revision, center: changedSource } })).status, 409);
    const dropped = structuredClone(fixed.data.center);
    dropped.connections = dropped.connections.filter((item) => item.id !== "managed-test");
    assert.equal((await request("/api/api-center", { method: "PATCH", token,
      body: { revision: fixed.data.revision, center: dropped } })).status, 409);
    const bound = structuredClone(fixed.data.center);
    bound.profiles.push({ id: "managed-chat", name: "受管模型", kind: "chat", connectionId: "managed-test", model: "unbound-test-model" });
    bound.bindings.chat = "managed-chat";
    const boundSaved = await request("/api/api-center", { method: "PATCH", token,
      body: { revision: fixed.data.revision, center: bound } });
    assert.equal(boundSaved.status, 200, JSON.stringify(boundSaved.data));
    assert.equal((await request(`/api/api-center/credentials/${managed.credentialRef}`, { method: "DELETE", token,
      body: {} })).status, 409, "bound credentials cannot be deleted");
    const unbound = structuredClone(boundSaved.data.center);
    unbound.bindings.chat = fixed.data.center.bindings.chat;
    const unboundSaved = await request("/api/api-center", { method: "PATCH", token,
      body: { revision: boundSaved.data.revision, center: unbound } });
    assert.equal(unboundSaved.status, 200);
    assert.equal((await request(`/api/api-center/credentials/${managed.credentialRef}`, { method: "DELETE", token,
      body: {} })).status, 200);
    const afterDelete = await request("/api/api-center", { token });
    const sourceAfterDelete = structuredClone(afterDelete.data.center);
    const emptyConnection = sourceAfterDelete.connections.find((item) => item.id === "managed-test");
    emptyConnection.credentialSource = "existing";
    delete emptyConnection.credentialRef;
    assert.equal((await request("/api/api-center", { method: "PATCH", token,
      body: { revision: afterDelete.data.revision, center: sourceAfterDelete } })).status, 200);
  } finally { modelsServer.close(); }
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
