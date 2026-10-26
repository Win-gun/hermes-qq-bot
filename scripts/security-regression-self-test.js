import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { TaskRuntime } from "../src/task-runtime.js";
import { ensureRequestedTaskArtifacts } from "../src/task-artifacts.js";

// All writes, browser profiles and mocked runtime state stay in this temporary tree.
// No bridge import, QQ connection, real backup, Keychain or launchctl invocation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-security-test-"));
const results = [];
const fakeChildProcessesOnly = process.argv.includes("--fake-child-processes-only");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("isolated task queue did not drain");
}

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source boundary: ${start}`);
  return source.slice(from, to);
}

function artifactHarness(spawn, pandocAvailable = false, rawBody = false) {
  const source = fs.readFileSync(path.join(root, "src/task-artifacts.js"), "utf8")
    .replace(/^import .+;\n/gm, "").replace(/^export /gm, "");
  return vm.runInNewContext(`${source}\n${rawBody ? "markdownBody = (value) => value;" : ""}\nensureRequestedTaskArtifacts`, {
    fs: { ...fs, existsSync: (file) => /pandoc$/.test(String(file)) ? pandocAvailable : /Google Chrome$/.test(String(file)) || fs.existsSync(file) },
    os: { ...os, tmpdir: () => temp }, path, Buffer, pathToFileURL, spawnSync: spawn
  });
}

async function testPdfPolicy() {
  const outputsDir = path.join(temp, "pdf-policy");
  fs.mkdirSync(outputsDir);
  const payload = '# 中文安全报告\n<script>fetch("http://127.0.0.1:6200/api/status")</script>\n'
    + '<img src="file:///etc/passwd" onerror="alert(1)"><iframe src="http://localhost/"></iframe>\n'
    + '<style>@import "https://example.com/";</style><meta http-equiv="refresh" content="0;url=file:///etc/passwd">\n'
    + '![image](http://127.0.0.1:6200/) &lt;script&gt;';
  fs.writeFileSync(path.join(outputsDir, "source.html"), payload);
  let renderDir;
  let calls = 0;
  const render = artifactHarness((command, args) => {
    calls += 1;
    assert.match(command, /Google Chrome$/, "Pandoc must never receive untrusted task content");
    const htmlPath = fileURLToPath(args.at(-1));
    renderDir = path.dirname(htmlPath);
    assert.notEqual(renderDir, outputsDir, "renderer input/profile must not be task-controlled files");
    const html = fs.readFileSync(htmlPath, "utf8");
    assert.match(html, /default-src 'none'; script-src 'none'/);
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<style>"));
    const escaped = payload.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    assert.equal(html.match(/<body>([\s\S]*)<\/body>/)?.[1], `<pre>${escaped}</pre>`);
    for (const flag of ["--disable-background-networking", "--disable-extensions",
      "--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]) {
      assert.ok(args.includes(flag), `missing renderer guard: ${flag}`);
    }
    assert.ok(!args.some((arg) => /no-sandbox|disable-web-security|allow-file-access|disable-setuid-sandbox/.test(arg)));
    fs.writeFileSync(args.find((arg) => arg.startsWith("--print-to-pdf=")).slice("--print-to-pdf=".length), "%PDF-test");
    return { status: 0 };
  });
  const result = render({ task: { objective: "输出 PDF", expectedArtifacts: ["中文报告.pdf"] }, artifacts: [{ name: "source.html" }], outputsDir });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(renderDir), false, "private render files must be cleaned up");
  const throws = artifactHarness((_command, args) => {
    renderDir = path.dirname(fileURLToPath(args.at(-1)));
    throw new Error("simulated renderer failure");
  });
  assert.throws(() => throws({ task: { objective: "PDF" }, artifacts: [{ name: "source.html" }], outputsDir }), /simulated renderer/);
  assert.equal(fs.existsSync(renderDir), false, "cleanup must also run after a spawn exception");
  // Exercise the exact locally installed Pandoc, not a fabricated sanitizer result.
  const pandoc = ["/usr/local/bin/pandoc", "/opt/homebrew/bin/pandoc"].find((file) => fs.existsSync(file));
  if (pandoc && !fakeChildProcessesOnly) {
    let markdownCalls = 0;
    const renderMarkdown = artifactHarness((command, args, options) => {
      if (/pandoc$/.test(command)) {
        markdownCalls += 1;
        assert.ok(args.includes("--sandbox"));
        assert.ok(args.includes("--from=markdown_strict+pipe_tables+fenced_code_blocks+backtick_code_blocks+strikeout-raw_html-raw_attribute"));
        return spawnSync(pandoc, args, options);
      }
      const html = fs.readFileSync(fileURLToPath(args.at(-1)), "utf8");
      assert.match(html, /<h1[^>]*>中文安全报告<\/h1>/);
      assert.match(html, /<table>/);
      assert.ok(!/<(?:script|iframe|meta|style)\b/i.test(html.split("<body>")[1]));
      assert.ok(!/<img[^>]*onerror=/i.test(html));
      assert.match(html, /&lt;script&gt;/);
      fs.writeFileSync(args.find((arg) => arg.startsWith("--print-to-pdf=")).slice("--print-to-pdf=".length), "%PDF-test");
      return { status: 0 };
    }, true);
    fs.writeFileSync(path.join(outputsDir, "formatted.md"), `${payload}\n\n| 标题 | 数据 |\n| --- | --- |\n| 中文 | 保留表格 |\n`);
    const formatted = renderMarkdown({ task: { objective: "PDF", expectedArtifacts: ["格式.pdf"] }, artifacts: [{ name: "formatted.md" }], outputsDir });
    assert.equal(formatted.ok, true);
    assert.equal(markdownCalls, 1);
  } else results.push(fakeChildProcessesOnly ? "pandoc-formatting:skipped-fake-child-processes-only" : "pandoc-formatting:skipped-no-pandoc");
  results.push("pdf-escaped-content-csp-offline-sandbox-cleanup");
}

async function testRealChrome() {
  if (fakeChildProcessesOnly) {
    results.push("real-chrome:skipped-fake-child-processes-only");
    return;
  }
  const binaries = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  if (!binaries.some((file) => fs.existsSync(file))) {
    results.push("real-chrome:skipped-no-renderer");
    return;
  }
  const outputsDir = path.join(temp, "pdf-browser");
  fs.mkdirSync(outputsDir);
  const hits = path.join(outputsDir, "requests.log");
  const secret = path.join(outputsDir, "local-resource.txt");
  fs.writeFileSync(secret, "PRIVATE_LOCAL_RESOURCE_SENTINEL");
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const server = require('node:http').createServer((req, res) => {
      fs.appendFileSync(workerData, req.url + '\\n');
      res.end('isolated fixture');
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `, { eval: true, workerData: hits });
  try {
    const port = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    const url = `http://127.0.0.1:${port}/resource`;
    const content = `中文安全报告\n<script>fetch('${url}');document.write('SCRIPT_'+'EXECUTED_SENTINEL')</script>\n`
      + `<img src="${url}"><link rel="stylesheet" href="${url}"><style>@import '${url}';</style>\n`
      + `<iframe src="${pathToFileURL(secret).href}"></iframe><object data="${url}"></object>\n`
      + `<meta http-equiv="refresh" content="0;url=${url}">\n![image](${url})`;
    fs.writeFileSync(path.join(outputsDir, "malicious.md"), content);
    const result = ensureRequestedTaskArtifacts({ task: { objective: "PDF", expectedArtifacts: ["中文.pdf"] }, artifacts: [{ name: "malicious.md" }], outputsDir });
    assert.equal(result.ok, true, result.error);
    // Defense in depth: bypass only the Markdown sanitizer in an isolated VM.
    // Real Chrome must still refuse page scripts, HTTP and file subresources.
    const rawRender = artifactHarness(spawnSync, false, true);
    // Navigation/meta refresh is prevented by the reader, not by default-src.
    fs.writeFileSync(path.join(outputsDir, "csp-only.html"), content.replace(/<meta[^>]*>/g, ""));
    const rawResult = rawRender({ task: { objective: "PDF", expectedArtifacts: ["csp.pdf"] }, artifacts: [{ name: "csp-only.html" }], outputsDir });
    assert.equal(rawResult.ok, true, rawResult.error);
    await delay(150);
    assert.equal(fs.existsSync(hits), false, "malicious content must not request the loopback fixture");
    const python = process.env.HERMES_QQ_PDF_TEST_PYTHON;
    if (python) {
      for (const name of ["中文.pdf", "csp.pdf"]) {
        const extract = spawnSync(python, ["-c", "from pypdf import PdfReader; import sys; print(''.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))", path.join(outputsDir, name)], { encoding: "utf8", timeout: 30000 });
        assert.equal(extract.status, 0, extract.stderr);
        assert.match(extract.stdout.normalize("NFKC"), /中文安全报告/, "Chinese PDF text must survive rendering (including compatibility glyphs)");
        assert.ok(!extract.stdout.includes("PRIVATE_LOCAL_RESOURCE_SENTINEL"), "local file contents must not be embedded");
        assert.ok(!extract.stdout.includes("SCRIPT_EXECUTED_SENTINEL"), "page scripts must not execute even without the Markdown sanitizer");
      }
      results.push("real-chrome-no-loopback-no-local-file-chinese-text");
    } else results.push("real-chrome-no-loopback:chinese-extraction-skipped-set-HERMES_QQ_PDF_TEST_PYTHON");
  } finally { await worker.terminate(); }
}

function hostHarness(overrides = {}, controls = {}) {
  const source = fs.readFileSync(path.join(root, "src/web-host.js"), "utf8");
  const calls = { stop: 0, start: 0, inspect: 0, create: 0, restore: 0, delete: 0 };
  const backup = {
    inspectBackup: async () => { calls.inspect += 1; return { manifest: { type: "safe" } }; },
    createBackup: async () => { calls.create += 1; return { path: path.join(temp, "rollback.hermesqqbackup") }; },
    restoreBackup: async () => { calls.restore += 1; return { manifest: { type: "safe" }, rollbackDir: "mock-rollback" }; },
    completeRestore: () => {}, rollbackRestore: async () => {},
    migrateLegacyProject: async () => ({ accounts: [] }),
    deleteLocalBackup: () => { calls.delete += 1; return { ok: true }; },
    ...overrides
  };
  const code = 'let operation = null; let progress = null; let child = null; let childPort = 0; let intentionalStop = false; let retryTimer = null;'
    + sourceBetween(source, "function acquireOperation(", "function readConfig(")
    + (controls.realStop ? sourceBetween(source, "async function stopBridge(", "async function restoreBridge(") : "")
    + sourceBetween(source, "async function migrateLocalLegacy(", "async function upload(")
    + sourceBetween(source, "async function route(", "async function shutdown(")
    + `\n({ restoreLocalBackup, createLocalBackup, migrateLocalLegacy, acquireOperation, releaseOperation,
      lock: () => operation, child: () => child, setChild: (value) => { child = value; },
      invoke: async (url, method = "POST", body = {}) => {
        const response = {}; await route({ url, method, headers: {}, body }, response); return response;
      } })`;
  const api = vm.runInNewContext(code, {
    fs: { existsSync: () => false, chmodSync: () => {}, readFileSync: () => '{"listen":{"port":6199}}' },
    path, os: { homedir: () => temp }, process: { platform: "linux", env: {} }, AbortController, URL, setTimeout, clearTimeout,
    backup, stateRoot: temp, backupRoot: temp, hermesHome: temp, logRoot: temp, intentionalStop: false,
    fileForName: () => ({ file: path.join(temp, "fixture.hermesqqbackup"), stat: { size: 1 } }),
    legacyProject: () => ({ root: temp }), readConfig: () => ({}), portAvailable: async () => true,
    childJson: async () => ({ generatedAt: 1, ok: true }), verifyMigratedAccounts: async () => {},
    stopBridge: async () => { calls.stop += 1; if (controls.stop) await controls.stop(); },
    startBridge: async (internal) => { calls.start += 1; if (controls.start) await controls.start(internal); },
    restoreBridge: async () => {}, resetRestoredAccounts: async () => {},
    publish: (value) => { /* Progress is deliberately not connected to any live host. */ },
    publicPort: 1234, localHost: () => true, validOrigin: () => true,
    jsonBody: async (request) => controls.body ? controls.body(request) : request.body,
    reply: (response, status, data) => Object.assign(response, { status, data }), errorMessage: (error) => error.message,
    console: { error: () => {} }
  });
  return { ...api, calls };
}

async function assertBusy(api, owner) {
  for (const [method, options] of [["restoreLocalBackup", { name: "fixture" }], ["createLocalBackup", { type: "safe" }], ["migrateLocalLegacy", { path: temp }]]) {
    await assert.rejects(api[method](options), (error) => error.code === "HOST_BUSY", `${method} must share the lock`);
    assert.equal(api.lock(), owner, "rejected contender must not release the owner's lock");
  }
}

async function testHostLocks() {
  const inspection = deferred();
  const api = hostHarness({ inspectBackup: () => inspection.promise });
  const restoring = api.restoreLocalBackup({ name: "fixture" });
  const owner = api.lock();
  assert.equal(owner?.kind, "restore", "lock must be taken before awaiting inspectBackup");
  assert.equal(api.calls.stop, 0);
  await assertBusy(api, owner);
  inspection.resolve({ manifest: { type: "safe" } });
  assert.equal((await restoring).ok, true);
  assert.equal(api.lock(), null);
  assert.equal(api.calls.restore, 1, "only one restore may mutate state");

  const failed = hostHarness({ inspectBackup: async () => { throw new Error("invalid fixture"); } });
  await assert.rejects(failed.restoreLocalBackup({ name: "fixture" }), /invalid fixture/);
  assert.equal(failed.lock(), null);
  assert.equal(failed.calls.stop + failed.calls.start + failed.calls.restore + failed.calls.create, 0, "failed inspection must not change bridge/state");
  await failed.createLocalBackup({ type: "safe" });
  assert.equal(failed.lock(), null);

  for (const method of ["createLocalBackup", "migrateLocalLegacy"]) {
    const gate = deferred();
    const current = hostHarness(method === "createLocalBackup" ? { createBackup: () => gate.promise } : { migrateLegacyProject: () => gate.promise });
    const active = current[method](method === "createLocalBackup" ? { type: "safe" } : { path: temp });
    await assertBusy(current, current.lock());
    gate.resolve(method === "createLocalBackup" ? { path: path.join(temp, "mock-backup") } : { accounts: [] });
    await active;
    assert.equal(current.lock(), null);
  }

  const old = api.acquireOperation("backup");
  api.releaseOperation(old);
  const newer = api.acquireOperation("restore");
  api.releaseOperation(old);
  assert.equal(api.lock(), newer, "stale owner must never release a newer operation");
  api.releaseOperation(newer);
  for (const [method, overrides] of [["createLocalBackup", { createBackup: async () => { throw new Error("create failed"); } }],
    ["migrateLocalLegacy", { migrateLegacyProject: async () => { throw new Error("migration failed"); } }]]) {
    const failedOperation = hostHarness(overrides);
    await assert.rejects(failedOperation[method]({ type: "safe", path: temp }), /failed/);
    assert.equal(failedOperation.lock(), null, "failed operation must release its own lock");
  }
  results.push("restore-inspection-race-create-migrate-owner-lock-failure-cleanup");
}

const webMutations = [
  ["/api/host/bridge/start"], ["/api/host/bridge/stop"], ["/api/host/bridge/restart"],
  ["/api/host/backup/restore", "POST", { name: "fixture.hermesqqbackup" }],
  ["/api/host/backup", "POST", { type: "full", password: "test-only-isolated" }],
  ["/api/host/backups/fixture.hermesqqbackup", "DELETE"],
  ["/api/host/legacy/migrate", "POST", { path: temp }]
];

async function assertWebRoutesBusy(api, owner) {
  for (const args of webMutations) {
    const response = await api.invoke(...args);
    assert.equal(response.status, 409, `actual route ${args[0]} must reject while ${owner?.kind} is active`);
    assert.equal(response.data.error, "host_busy");
    assert.equal(api.lock(), owner, "busy route must not release or replace the transaction owner");
  }
}

function fakeBridgeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  child.exit = () => { child.exitCode = 0; child.emit("exit", 0); };
  return child;
}

async function testWebControlRouteLocks() {
  // Execute both the original route and stopBridge bodies. No real child process
  // is launched: SIGTERM leaves the fake child pending until its explicit exit.
  const api = hostHarness({}, { realStop: true });
  const child = fakeBridgeChild();
  api.setChild(child);
  const stopping = api.invoke("/api/host/bridge/stop");
  const owner = api.lock();
  assert.equal(owner?.kind, "bridge-stop");
  assert.equal(api.child(), null, "reproduce the child=null window before process exit");
  assert.equal(child.exitCode, null);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await assertWebRoutesBusy(api, owner);
  assert.equal(api.calls.inspect + api.calls.create + api.calls.restore + api.calls.delete, 0, "busy requests must not reach backup state");
  assert.equal((await api.invoke("/api/host/backup/status", "GET")).status, 200, "status must remain responsive during stop");
  child.exit();
  assert.equal((await stopping).status, 200);
  assert.equal(api.lock(), null);
  assert.equal((await api.invoke("/api/host/backup/restore", "POST", { name: "fixture.hermesqqbackup" })).status, 200, "restore must work after child exit and lock release");

  // Restart must retain the same lock across the stop/start boundary and until
  // readiness, while start must use the owner-authorized internal path.
  for (const action of ["start", "restart"]) {
    const startup = deferred();
    let entered = false;
    const current = hostHarness({}, { realStop: true, start: async (internal) => {
      assert.equal(internal, true, "locked route must pass the internal start guard");
      entered = true;
      await startup.promise;
    } });
    const prior = fakeBridgeChild();
    if (action === "restart") current.setChild(prior);
    const active = current.invoke(`/api/host/bridge/${action}`);
    const held = current.lock();
    assert.equal(held?.kind, `bridge-${action}`);
    if (action === "restart") {
      assert.equal(current.child(), null);
      await assertWebRoutesBusy(current, held);
      prior.exit();
    }
    await waitFor(() => entered);
    await assertWebRoutesBusy(current, held);
    startup.resolve();
    assert.equal((await active).status, 200);
    assert.equal(current.lock(), null);
  }

  // Reverse direction: restore inspection, full backup and async deletion each
  // hold the same lock, rejecting every bridge-control request with HTTP 409.
  for (const transaction of ["restore", "full-backup", "delete"]) {
    const gate = deferred();
    const current = hostHarness(transaction === "restore" ? { inspectBackup: () => gate.promise }
      : transaction === "full-backup" ? { createBackup: () => gate.promise } : { deleteLocalBackup: () => gate.promise });
    const active = transaction === "restore" ? current.invoke("/api/host/backup/restore", "POST", { name: "fixture.hermesqqbackup" })
      : transaction === "full-backup" ? current.invoke("/api/host/backup", "POST", { type: "full", password: "test-only-isolated" })
      : current.invoke("/api/host/backups/fixture.hermesqqbackup", "DELETE");
    await waitFor(() => current.lock());
    const held = current.lock();
    const stopCount = current.calls.stop;
    await assertWebRoutesBusy(current, held);
    assert.equal(current.calls.stop, stopCount, "blocked bridge routes must not call stopBridge");
    assert.equal(current.calls.start, 0);
    gate.resolve(transaction === "restore" ? { manifest: { type: "safe" } }
      : transaction === "full-backup" ? { path: path.join(temp, "full-fixture.hermesqqbackup") } : { ok: true });
    assert.equal((await active).status, 200);
    assert.equal(current.lock(), null);
  }

  // A body-read already in flight must re-check ownership when it finally
  // reaches restore; HOST_BUSY must map to 409 rather than a generic 500.
  const body = deferred();
  const stop = deferred();
  const reading = hostHarness({}, { stop: () => stop.promise, body: (request) => request.url.endsWith("/restore") ? body.promise : request.body });
  const waitingRestore = reading.invoke("/api/host/backup/restore");
  assert.equal(reading.lock(), null);
  const waitingStop = reading.invoke("/api/host/bridge/stop");
  const stoppingOwner = reading.lock();
  body.resolve({ name: "fixture.hermesqqbackup" });
  assert.equal((await waitingRestore).status, 409);
  assert.equal(reading.lock(), stoppingOwner);
  stop.resolve();
  assert.equal((await waitingStop).status, 200);

  for (const [url, method, controls, overrides] of [
    ["/api/host/bridge/start", "POST", { start: async () => { throw new Error("start fixture failure"); } }, {}],
    ["/api/host/bridge/stop", "POST", { stop: async () => { throw new Error("stop fixture failure"); } }, {}],
    ["/api/host/bridge/restart", "POST", { start: async () => { throw new Error("restart fixture failure"); } }, {}],
    ["/api/host/backups/fixture.hermesqqbackup", "DELETE", {}, { deleteLocalBackup: async () => { throw new Error("delete fixture failure"); } }]
  ]) {
    const failed = hostHarness(overrides, controls);
    assert.equal((await failed.invoke(url, method)).status, 500);
    assert.equal(failed.lock(), null, "failed control/delete route must release its own lock");
    assert.equal((await failed.invoke("/api/host/backup", "POST", { type: "safe" })).status, 200, "a later transaction must not remain blocked");
  }
  results.push("web-original-stop-exit-window-start-restart-delete-and-reverse-route-locks-http409");
}

function desktopHarness(moduleGate, overrides = {}, attached = false) {
  const source = fs.readFileSync(path.join(root, "desktop/main.cjs"), "utf8");
  const handlers = new Map();
  const calls = { module: 0, stop: 0, start: 0, fetch: 0, create: 0, restore: 0, migrate: 0, delete: 0 };
  const service = {
    inspectBackup: async () => ({ manifest: { type: "safe" } }),
    inspectLegacyProject: () => ({}), completeRestore: () => {}, rollbackRestore: async () => {},
    createBackup: async () => { calls.create += 1; return { path: path.join(temp, "native.hermesqqbackup") }; },
    restoreBackup: async () => { calls.restore += 1; return { manifest: { type: "safe" } }; },
    migrateLegacyProject: async () => { calls.migrate += 1; return { accounts: [] }; },
    deleteLocalBackup: () => { calls.delete += 1; return { ok: true }; },
    ...overrides
  };
  const handlersSource = sourceBetween(source, '  handle("bot:start"', '  handle("setup:complete"')
    .replace(/await import\(path\.join\(resourceRoot\(\), "src", "account-registry\.js"\)\)/g, "registry");
  const code = `let activeLocalOperation = null, activeBackup = null, lastBackupProgress = null;
    let externalHost = ${attached}, bridge = null, bridgeIntentionalStop = false, setupBridgeAllowed = false;`
    + sourceBetween(source, "function publishBackupProgress(", "function resourceRoot(") + handlersSource
    + '\n({ lock: () => activeLocalOperation, backup: () => activeBackup, replaceLock: (value) => { activeLocalOperation = value; }, localOperationHandler })';
  const api = vm.runInNewContext(code, {
    handle: (name, fn) => handlers.set(name, fn), mainWindow: null,
    backupModule: async () => { calls.module += 1; if (moduleGate) await moduleGate.promise; return service; },
    path, fs: { readFileSync: () => "{}", existsSync: () => false }, os: { homedir: () => temp },
    process: { getuid: () => 501, env: {} }, AbortController, APP_VERSION: "fixture", CONTROL_PORT: 1234, CONTROL_URL: "http://fixture.invalid",
    stateRoot: () => temp, hermesHome: () => temp, logRoot: () => temp, backupRoot: () => temp,
    setupComplete: () => false, configuredOnebotPort: () => 1235, portAvailable: async () => true,
    registry: { accountItems: () => [], registryConfig: (value) => value },
    stopBridge: async () => { calls.stop += 1; return { ok: true }; },
    startBridge: () => { calls.start += 1; return { ok: true }; },
    startManagedBridge: async () => { calls.start += 1; return { ok: true }; },
    restartBridge: async () => { calls.start += 1; return { ok: true }; },
    startBridgeWhenPortsFree: async () => ({ ok: true }), waitForBridge: async () => ({ generatedAt: 1 }),
    waitForMigratedAccounts: async () => {}, appendDesktopLog: () => {}, execCapture: async () => ({ ok: false }),
    fetchJson: async () => { calls.fetch += 1; return { ok: true }; }
  });
  return { ...api, calls, invoke: (name, options) => handlers.get(name)(options) };
}

const nativeMutations = [
  ["backup:create", { type: "safe" }], ["backup:restore", { path: path.join(temp, "fixture.hermesqqbackup") }],
  ["legacy:migrate", { path: temp }], ["backup:delete", { path: path.join(temp, "fixture.hermesqqbackup") }],
  ["bot:start", {}], ["bot:stop", {}], ["bot:restart", {}]
];

async function testNativeLocks() {
  for (const [name, options] of nativeMutations.slice(0, 4)) {
    const moduleGate = deferred();
    const api = desktopHarness(moduleGate);
    const active = api.invoke(name, options);
    const owner = api.lock();
    assert.ok(owner, `${name} must lock before awaiting backupModule`);
    assert.equal(api.calls.module, 1);
    for (const [other, input] of nativeMutations) {
      await assert.rejects(api.invoke(other, input), (error) => error.code === "HOST_BUSY", `${other} must reject during ${name}`);
      assert.equal(api.lock(), owner);
    }
    assert.equal(api.calls.module, 1, "blocked IPC must not import or call the backup module");
    assert.equal(api.calls.stop + api.calls.start + api.calls.fetch, 0, "blocked IPC must not touch bridge or Web host");
    moduleGate.resolve();
    await active;
    assert.equal(api.lock(), null);
    assert.equal(api.backup(), null);
  }
  for (const [name, options] of nativeMutations.slice(0, 4)) {
    const moduleGate = deferred();
    const api = desktopHarness(moduleGate);
    const active = api.invoke(name, options);
    moduleGate.reject(new Error("isolated import failed"));
    await assert.rejects(active, /isolated import failed/);
    assert.equal(api.lock(), null, "module-load failure must release local lock");
    assert.equal(api.backup(), null);
  }
  const inspectGate = deferred();
  const restore = desktopHarness(null, { inspectBackup: () => inspectGate.promise });
  const restoring = restore.invoke("backup:restore", { path: temp });
  await delay(0);
  const owner = restore.lock();
  await assert.rejects(restore.invoke("backup:create", { type: "safe" }), (error) => error.code === "HOST_BUSY");
  assert.equal(restore.lock(), owner);
  assert.equal(restore.calls.stop, 0);
  inspectGate.reject(new Error("isolated invalid backup"));
  await assert.rejects(restoring, /isolated invalid backup/);
  assert.equal(restore.lock(), null);
  assert.equal(restore.calls.stop, 0, "inspection failure must not stop the bridge");

  for (const [name, override, expected] of [["backup:create", { createBackup: async () => { throw new Error("isolated operation failed"); } }, /isolated operation failed/],
    ["backup:restore", { restoreBackup: async () => { throw new Error("isolated operation failed"); } }, /自动回滚未完成/],
    ["legacy:migrate", { migrateLegacyProject: async () => { throw new Error("isolated operation failed"); } }, /isolated operation failed/]]) {
    const api = desktopHarness(null, override);
    await assert.rejects(api.invoke(name, { type: "safe", path: temp }), expected);
    assert.equal(api.lock(), null);
    assert.equal(api.backup(), null);
    if (name === "backup:restore") assert.equal(api.calls.start, 0, "rollback failure must leave the bridge stopped");
  }
  const stale = desktopHarness();
  const gate = deferred();
  const active = stale.localOperationHandler("old", () => gate.promise)();
  const newer = { kind: "new" };
  stale.replaceLock(newer);
  gate.resolve();
  await active;
  assert.equal(stale.lock(), newer, "old native owner must never release a newer lock");

  const attached = desktopHarness(null, {}, true);
  for (const [name, options] of nativeMutations.slice(0, 4)) {
    await attached.invoke(name, options);
    assert.equal(attached.lock(), null, "externalHost transactions belong to the Web lock");
  }
  assert.equal(attached.calls.fetch, 4);
  assert.equal(attached.calls.module, 0);

  const cancelling = desktopHarness(null, { createBackup: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { const error = new Error("cancelled fixture"); error.name = "BackupCancelledError"; reject(error); }, { once: true });
  }) });
  const creating = cancelling.invoke("backup:create", { type: "safe" });
  await waitFor(() => cancelling.backup()?.cancelable);
  const cancellingOwner = cancelling.lock();
  assert.equal(cancelling.invoke("backup:cancel", {}).ok, true);
  assert.equal(cancelling.lock(), cancellingOwner, "cancellation must not release the lock before the transaction settles");
  await assert.rejects(creating, /cancelled fixture/);
  assert.equal(cancelling.lock(), null);
  assert.equal(cancelling.backup(), null);
  results.push("native-ipc-import-inspection-create-restore-migrate-delete-bridge-owner-lock-and-external-delegation");
}

async function testTaskCleanup() {
  for (const failure of ["start-notice", "all-notices", "initial-persist", "initial-event", "execute-error"]) {
    const notices = [];
    const executed = [];
    const runtime = new TaskRuntime({
      rootDir: path.join(temp, failure),
      config: { taskMode: { workspaceBaseDir: "tasks", maxConcurrentGlobal: 1, maxConcurrentPerConversation: 1 } },
      execute: async (task) => {
        executed.push(task.id);
        if (failure === "execute-error" && task.objective === "first") throw new Error("isolated execution failed");
        return { ok: true };
      },
      notify: async (task, notice) => {
        notices.push(notice.type);
        if (["all-notices", "execute-error"].includes(failure) || (task.objective === "first" && notice.type === "started")) throw new Error("notice failed");
      }
    });
    const first = runtime.createOffer({ objective: "first", conversationId: "isolated" });
    const next = runtime.createOffer({ objective: "next", conversationId: "isolated" });
    next.status = "queued";
    runtime.queue.push(next.id);
    if (["initial-persist", "initial-event"].includes(failure)) {
      const method = failure === "initial-persist" ? "persist" : "event";
      const original = runtime[method].bind(runtime);
      let once = true;
      runtime[method] = (...args) => {
        if (once) { once = false; throw new Error("initial write failed"); }
        return original(...args);
      };
    }
    await runtime.run(first);
    await waitFor(() => next.status === "completed" && runtime.running.size === 0);
    const initializationFailure = ["initial-persist", "initial-event"].includes(failure);
    assert.equal(first.status, initializationFailure || failure === "execute-error" ? "failed" : "completed");
    assert.equal(runtime.controllers.size, 0);
    assert.deepEqual(executed, initializationFailure ? [next.id] : [first.id, next.id], "notice failures must not prevent execution or block the next queued task");
    assert.equal(notices.includes(initializationFailure || failure === "execute-error" ? "failed" : "completed"), true);
    if (!initializationFailure) {
      const events = fs.readFileSync(runtime.eventsPath(first.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "notice_failed" && event.noticeType === "started"));
    }
  }
  for (const rejects of [false, true]) {
    const start = deferred();
    let executed = false;
    const runtime = new TaskRuntime({ rootDir: path.join(temp, `cancel-${rejects}`), config: {},
      execute: async () => { executed = true; return { ok: true }; }, notify: () => start.promise });
    const task = runtime.createOffer({ objective: "cancel during notice" });
    const run = runtime.run(task);
    task.status = "cancelled";
    runtime.controllers.get(task.id).abort();
    if (rejects) start.reject(new Error("notice failed during cancellation"));
    else start.resolve();
    await run;
    assert.equal(executed, false);
    assert.equal(runtime.running.size + runtime.controllers.size, 0);
  }
  for (const method of ["persist", "event"]) {
    const runtime = new TaskRuntime({ rootDir: path.join(temp, `permanent-${method}`), config: {}, execute: async () => ({}), notify: async () => {} });
    const task = runtime.createOffer({ objective: "permanent write failure" });
    runtime[method] = () => { throw new Error("permanent fixture failure"); };
    await assert.rejects(runtime.run(task), /permanent fixture failure/);
    assert.equal(runtime.running.size + runtime.controllers.size, 0, "even failed error persistence must release the slot");
  }
  results.push("task-start-notice-persist-event-failure-drains-queue-and-cancel-cleans-up");
}

try {
  await testPdfPolicy();
  await testRealChrome();
  await testHostLocks();
  await testWebControlRouteLocks();
  await testNativeLocks();
  await testTaskCleanup();
  console.log(JSON.stringify({ ok: true, results }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
