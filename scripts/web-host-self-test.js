import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.env.HERMES_QQ_WEB_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-web-host-test-"));
const state = path.join(temp, "state");
const backups = path.join(temp, "backups");
const legacy = path.join(temp, "legacy");
const hostScript = path.join(root, "src", "web-host.js");
let host;
let checks = 0;

function check(value, message) { checks += 1; assert.ok(value, message); }

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

async function waitFor(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for isolated Web host");
}

async function request(port, route, method = "GET", body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

function requestWithHost(port, host) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/api/host/status", headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("host did not exit")), 10000))]);
}

try {
  fs.mkdirSync(path.join(state, "data"), { recursive: true, mode: 0o700 });
  const port = await freePort();
  const oneBotPort = await freePort();
  const config = {
    listen: { host: "127.0.0.1", port: oneBotPort, path: "/onebot" },
    control: { enabled: true, host: "127.0.0.1", port, maxBodyBytes: 65536 },
    accounts: { primary: { id: "primary", protocol: "napcat", enabled: false }, standbys: [], failover: { enabled: false } },
    loginRecovery: { enabled: false },
    adminNotifications: { enabled: false },
    webSearch: { enabled: false },
    vision: { enabled: false }
  };
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(state, ".setup-complete"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(state, "data", "memory.json"), "{}", { mode: 0o600 });
  const env = { ...process.env, HOME: path.join(temp, "home"), HERMES_HOME: path.join(temp, "empty-hermes"), HERMES_QQ_LAUNCHCTL: "/usr/bin/false", HERMES_QQ_HOME: state, HERMES_QQ_BACKUP_ROOT: backups, HERMES_QQ_CONTROL_PORT: String(port) };
  host = spawn(process.execPath, [hostScript], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  host.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  host.stdout.resume();
  const active = await waitFor(async () => {
    const result = await request(port, "/api/host/status");
    return result.data.running && result.data.setupComplete ? result : null;
  });
  check(active.data.ok && active.data.hostKind === "hermesqq-local-host" && active.data.webEdition && active.data.stateRoot === state && active.data.backupRoot === backups, "status marker and isolated roots");
  const health = await waitFor(async () => {
    const result = await request(port, "/health");
    return result.status === 200 && typeof result.data.generatedAt === "number" ? result : null;
  });
  check(health.status === 200 && typeof health.data.generatedAt === "number", "bridge health is proxied");
  const proxied = await request(port, "/api/status");
  check(proxied.status === 200 && typeof proxied.data === "object", "bridge API is proxied");
  const admin = await request(port, "/admin");
  check(admin.status === 200 && String(admin.data).includes("<html"), "admin is served directly");
  check((await requestWithHost(port, "example.com")) === 403, "non-loopback Host is rejected");
  const badOrigin = await request(port, "/api/host/bridge/stop", "POST", {}, { Origin: "http://example.com" });
  check(badOrigin.status === 403, "cross-origin host mutation is rejected");
  const stopped = await request(port, "/api/host/bridge/stop", "POST", {});
  check(stopped.data.ok && !stopped.data.running, "intentional stop works");
  const stoppedHealth = await request(port, "/health");
  check(stoppedHealth.status === 503 && stoppedHealth.data.bridgeStopped, "health reports stopped bridge");
  check((await request(port, "/admin/")).status === 200, "admin remains available while stopped");
  await new Promise((resolve) => setTimeout(resolve, 2400));
  check(!(await request(port, "/api/host/status")).data.running, "intentional stop does not auto-restart");
  const restarted = await request(port, "/api/host/bridge/start", "POST", {});
  check(restarted.data.ok && restarted.data.running, "bridge can start again");
  const safe = await request(port, "/api/host/backup", "POST", { type: "safe" });
  check(safe.status === 200 && safe.data.ok && safe.data.manifest?.type === "safe" && fs.existsSync(safe.data.path), "safe backup returns core shape");
  check((fs.statSync(safe.data.path).mode & 0o777) === 0o600, "backup file is private");
  const name = path.basename(safe.data.path);
  const listed = await request(port, "/api/host/backups");
  check(Array.isArray(listed.data) && listed.data.some((item) => item.name === name && item.size > 0 && item.modifiedAt && !item.path), "backups list uses names");
  const inspected = await request(port, "/api/host/backup/inspect", "POST", { name });
  check(inspected.data.ok && inspected.data.manifest.type === "safe", "backup inspect by basename");
  const restored = await request(port, "/api/host/backup/restore", "POST", { name });
  check(restored.data.ok && restored.data.manifest.type === "safe" && restored.data.rollbackName, "safe restore retains rollback backup");
  check((await request(port, "/health")).status === 200, "bridge is available after safe restore");
  const downloaded = await request(port, `/api/host/backups/${name}/download`);
  check(downloaded.status === 200 && downloaded.headers.get("content-type") === "application/octet-stream", "backup download");
  const traversal = await request(port, "/api/host/backup/inspect", "POST", { name: "../config.json" });
  check(traversal.status === 400, "path traversal is rejected");
  const upload = await request(port, "/api/host/backup/upload", "POST", new Uint8Array([1, 2, 3]), { "content-type": "application/octet-stream" });
  check(upload.data.ok && /^upload-[a-f0-9]{32}\.hermesqqbackup$/.test(upload.data.name), "upload chooses random basename");
  check((fs.statSync(path.join(backups, upload.data.name)).mode & 0o777) === 0o600, "uploaded file is private");
  const deletedUpload = await request(port, `/api/host/backups/${upload.data.name}`, "DELETE");
  check(deletedUpload.data.ok && !fs.existsSync(path.join(backups, upload.data.name)), "basename delete works");
  const full = await request(port, "/api/host/backup", "POST", { type: "full", password: "self-test-only" });
  check(full.data.ok && full.data.manifest.type === "full" && full.data.manifest.requiresPassword, "isolated full backup is encrypted");
  const fullName = path.basename(full.data.path);
  const fullInspect = await request(port, "/api/host/backup/inspect", "POST", { name: fullName, password: "self-test-only" });
  if (process.platform === "darwin" && process.arch === "arm64") {
    check(fullInspect.data.ok && fullInspect.data.header.encrypted, "encrypted full backup inspects with password");
    const fullRestore = await request(port, "/api/host/backup/restore", "POST", { name: fullName, password: "self-test-only" });
    check(fullRestore.data.ok && fullRestore.data.manifest.type === "full", "isolated non-Docker full restore works");
    check((await request(port, "/health")).status === 200, "bridge resumes after full restore");
  } else check(fullInspect.data.ok === false, "full migration inspect rejects unsupported platforms");

  if (process.platform === "darwin" && process.arch === "arm64") {
    // The HTTP cancellation race is timing-dependent on shared CI runners; core cancellation is tested separately.
    fs.writeFileSync(path.join(state, "data", "large.bin"), Buffer.alloc(64 * 1024 * 1024, 65), { mode: 0o600 });
    const backupPromise = request(port, "/api/host/backup", "POST", { type: "full", password: "self-test-only" });
    await waitFor(async () => {
      const status = await request(port, "/api/host/backup/status");
      return status.data.status === "running" ? status : null;
    });
    const cancel = await request(port, "/api/host/backup/cancel", "POST", {});
    check(cancel.data.ok, "active full backup accepts cancellation");
    const cancelled = await backupPromise;
    check(!cancelled.data.ok, "cancelled backup request fails");
    const afterCancel = await waitFor(async () => {
      const status = await request(port, "/api/host/status");
      return status.data.running ? status : null;
    });
    check(afterCancel.data.running, "bridge resumes after full backup cancellation");
    check((await request(port, "/api/host/backup/status")).data.status === "cancelled", "cancel progress is retained");
  }
  const deleted = await request(port, `/api/host/backups/${name}`, "DELETE");
  check(deleted.data.ok && !fs.existsSync(safe.data.path), "created backup can be deleted by basename");

  fs.mkdirSync(path.join(legacy, "data", "chat-archive"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "napcat-fixture"));
  const migratedConfig = { ...config, ai: { command: "/usr/bin/true", args: [] } };
  fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify(migratedConfig));
  fs.writeFileSync(path.join(legacy, "data", "memory.json"), JSON.stringify({ legacyFixture: "migrated" }));
  fs.writeFileSync(path.join(legacy, "napcat-fixture", "sentinel.txt"), "protocol fixture");
  const legacyInspect = await request(port, "/api/host/legacy/inspect", "POST", { path: legacy });
  check(legacyInspect.status === 200 && legacyInspect.data.root === legacy && legacyInspect.data.hasMemory && legacyInspect.data.hasArchive && legacyInspect.data.protocolDirectories?.includes("napcat-fixture") && !legacyInspect.data.configPath, `legacy inspect exposes only safe summary: ${JSON.stringify(legacyInspect)}`);
  check((await request(port, "/api/host/legacy/inspect", "POST", { path: state })).status === 400, "live state cannot be selected as legacy source");
  const alias = path.join(temp, "legacy-alias");
  fs.symlinkSync(legacy, alias);
  check((await request(port, "/api/host/legacy/inspect", "POST", { path: alias })).status === 400, "symlinked source is rejected");
  check((await request(port, "/api/host/legacy/inspect", "POST", { path: `${legacy}/../legacy` })).status === 400, "traversal source is rejected");
  const linkedData = path.join(legacy, "data", "linked-config.json");
  fs.symlinkSync(path.join(state, "config.json"), linkedData);
  check((await request(port, "/api/host/legacy/inspect", "POST", { path: legacy })).status === 400, "symlink inside copied data is rejected");
  fs.rmSync(linkedData);
  const migrated = await request(port, "/api/host/legacy/migrate", "POST", { path: legacy });
  check(migrated.status === 200 && migrated.data.ok && migrated.data.health?.generatedAt && !migrated.data.rollbackDir && !migrated.data.legacy?.configPath, "legacy migration passes health and model verification without exposing internals");
  check(JSON.parse(fs.readFileSync(path.join(state, "data", "memory.json"), "utf8")).legacyFixture === "migrated" && fs.readFileSync(path.join(state, "napcat-fixture", "sentinel.txt"), "utf8") === "protocol fixture", "legacy data and protocol directory were migrated");
  check((await request(port, "/health")).status === 200, "bridge resumes after legacy migration");
  const beforeFailedMigration = fs.readFileSync(path.join(state, "data", "memory.json"), "utf8");
  fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ ...migratedConfig, ai: { command: "/bin/sh", args: ["-c", "sleep 2; exit 1"] } }));
  fs.writeFileSync(path.join(legacy, "data", "memory.json"), JSON.stringify({ legacyFixture: "should-roll-back" }));
  const failedMigrationRequest = request(port, "/api/host/legacy/migrate", "POST", { path: legacy });
  await waitFor(async () => (await request(port, "/api/host/backup/status")).data.stage === "verify" ? true : null);
  check((await request(port, "/api/host/backup", "POST", { type: "safe" })).status === 409, "backup cannot overlap legacy migration");
  const failedMigration = await failedMigrationRequest;
  check(failedMigration.status === 500 && !failedMigration.data.ok, "failed model verification rejects migration");
  check(fs.readFileSync(path.join(state, "data", "memory.json"), "utf8") === beforeFailedMigration && JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).ai.command === "/usr/bin/true", "failed verification restores previous state");
  check((await request(port, "/api/host/backup/status")).data.rollbackFailed === false && (await request(port, "/health")).status === 200, "rollback reports success and bridge resumes");

  const second = spawn(process.execPath, [hostScript], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let collision = "";
  second.stderr.on("data", (chunk) => { collision += chunk.toString(); });
  second.stdout.resume();
  await waitFor(() => second.exitCode !== null, 5000);
  check(second.exitCode !== 0 && collision.includes("existing service"), "occupied public port exits without launching bridge");
  await stopProcess(host);
  host = null;
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(oneBotPort, "127.0.0.1", () => server.close(() => resolve(true)));
  });
  check(free, "SIGTERM closes bridge OneBot listener");
  const electronBinary = path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (process.platform === "darwin" && fs.existsSync(electronBinary)) {
    host = spawn(electronBinary, [hostScript], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    host.stdout.resume();
    host.stderr.resume();
    await waitFor(async () => {
      const result = await request(port, "/health");
      return result.status === 200 && typeof result.data.generatedAt === "number" ? result : null;
    });
    check((await request(port, "/api/host/status")).data.hostKind === "hermesqq-local-host", "Electron Node-mode host launches bridge child");
    await stopProcess(host);
    host = null;
  }
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (host) await stopProcess(host);
  fs.rmSync(temp, { recursive: true, force: true });
}
