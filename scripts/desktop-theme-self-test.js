#!/usr/bin/env node
// Offline contract tests: no Electron launch, bridge, network, or live user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = fs.readFileSync(path.join(root, "desktop/main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "desktop/preload.cjs"), "utf8");
const setupSource = fs.readFileSync(path.join(root, "desktop/setup.html"), "utf8");
const themes = ["dark", "light", "system"];
const stateRoot = path.resolve("/isolated-desktop-theme-test");
const preferenceFile = path.join(stateRoot, "desktop-theme.json");
const setupUrl = pathToFileURL(path.join(root, "desktop/setup.html")).href;
let assertions = 0;
function check(fn) { fn(); assertions += 1; }

function runtime(saved, { osDark = false, writeFailure = false } = {}) {
  const files = new Map(saved === undefined ? [] : [[preferenceFile, saved]]);
  const writes = [];
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const nativeTheme = new EventEmitter();
  let source = "system";
  Object.defineProperties(nativeTheme, {
    themeSource: { get: () => source, set(value) { source = value; nativeTheme.emit("updated"); } },
    shouldUseDarkColors: { get: () => source === "dark" || source === "system" && osDark }
  });
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.backgroundColor = options.backgroundColor;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: setupUrl };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, state) => { this.lastSent = { channel, state }; };
      windows.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    setBackgroundColor(value) { this.backgroundColor = value; }
    async loadFile() {}
    hide() {}
  }
  const paths = { userData: stateRoot, appData: stateRoot };
  const app = new EventEmitter();
  Object.assign(app, {
    getPath: (key) => paths[key], getAppPath: () => root,
    setPath: (key, value) => { paths[key] = value; },
    requestSingleInstanceLock: () => false, quit: () => {}
  });
  const fakeFs = {
    mkdirSync: () => {}, existsSync: (file) => files.has(file),
    readFileSync(file) {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    writeFileSync(file, contents, options) {
      if (writeFailure) throw new Error("injected write failure");
      writes.push({ file, contents, options });
      files.set(file, contents);
    },
    renameSync(from, to) { assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from); },
    rmSync: (file) => files.delete(file)
  };
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return { app, BrowserWindow, ipcMain, nativeTheme };
      if (name === "node:fs") return fakeFs;
      if (name === "../package.json") return { version: "test" };
      if (name === "node:child_process") return { spawn() { throw new Error("must not spawn processes"); } };
      if (["node:path", "node:os", "node:net", "node:crypto"].includes(name)) return require(name);
      throw new Error(`unexpected require: ${name}`);
    },
    process: { env: { HERMES_QQ_HOME: stateRoot }, argv: [], platform: "darwin", arch: "arm64" },
    URL
  });
  new vm.Script(`${mainSource}\n globalThis.testApi = { initializeDesktopTheme, desktopThemeState, registerIpc, createWindow };`, { filename: "desktop/main.cjs" }).runInContext(context);
  context.testApi.initializeDesktopTheme();
  context.testApi.registerIpc();
  context.testApi.createWindow();
  const window = windows[0];
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    window, files, writes, nativeTheme,
    state: () => JSON.parse(JSON.stringify(context.testApi.desktopThemeState())),
    set: (value, sender = event()) => handlers.get("app:set-theme")(sender, value),
    snapshot(sender = event()) { ipcMain.emit("app:get-theme", sender); return sender.returnValue; },
    changeSystem(dark) { osDark = dark; nativeTheme.emit("updated"); }
  };
}

async function runOffline() {
const initial = runtime();
check(() => assert.deepEqual(initial.state(), { ok: true, theme: "dark", resolvedTheme: "dark" }));
check(() => assert.equal(initial.window.backgroundColor, "#111214"));
check(() => assert.equal(initial.writes.length, 0));
check(() => assert.deepEqual(JSON.parse(JSON.stringify(initial.window.options.webPreferences)), {
  preload: path.join(root, "desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true
}));
check(() => assert.deepEqual([initial.window.options.width, initial.window.options.height, initial.window.options.minWidth, initial.window.options.minHeight], [1460, 940, 768, 600]));

for (const theme of themes) {
  const current = runtime(JSON.stringify({ theme }));
  check(() => assert.equal(current.state().theme, theme));
  check(() => assert.equal(current.window.backgroundColor, theme === "dark" ? "#111214" : "#f6f7f9"));
  check(() => assert.equal(current.writes.length, 0));
}
for (const invalid of ["broken JSON", "null", "{}", '{"theme":"Dark"}', '{"theme":{}}']) {
  check(() => assert.equal(runtime(invalid).state().theme, "dark"));
}

for (const value of [undefined, null, false, true, 0, 1, "", "auto", "Dark", " light", "dark ", "dark\0", [], ["dark"], {}, { theme: "dark" }, new String("dark")]) {
  await assert.rejects(initial.set(value), /invalid desktop theme/);
  assertions += 1;
}
check(() => assert.equal(initial.writes.length, 0));
check(() => assert.equal(initial.state().theme, "dark"));
for (const sender of [
  { sender: {}, senderFrame: { url: setupUrl } },
  { sender: initial.window.webContents, senderFrame: { url: "https://example.com/admin" } },
  { sender: initial.window.webContents, senderFrame: { url: "http://127.0.0.1:6201/admin" } },
  { sender: initial.window.webContents, senderFrame: { url: "http://127.0.0.1:6200/health" } },
  { sender: initial.window.webContents, senderFrame: { url: "file:///untrusted/setup.html" } },
  { sender: initial.window.webContents }
]) {
  await assert.rejects(initial.set("light", sender), /unauthorized IPC sender/);
  check(() => assert.equal(initial.snapshot(sender), null));
}
for (const url of [setupUrl, `${setupUrl}?error=bridge`, "http://127.0.0.1:6200/admin?desktop=1"]) {
  const event = { sender: initial.window.webContents, senderFrame: { url } };
  check(() => assert.equal(initial.snapshot(event).theme, "dark"));
}
const light = await initial.set("light");
check(() => assert.deepEqual(JSON.parse(JSON.stringify(light)), { ok: true, theme: "light", resolvedTheme: "light" }));
check(() => assert.deepEqual(Object.keys(light).sort(), ["ok", "resolvedTheme", "theme"]));
check(() => assert.deepEqual(JSON.parse(initial.files.get(preferenceFile)), { theme: "light" }));
check(() => assert.equal(initial.writes[0].options.mode, 0o600));
check(() => assert.equal(initial.window.backgroundColor, "#f6f7f9"));
check(() => assert.ok(initial.writes.every(({ file }) => file === `${preferenceFile}.tmp`)));
check(() => assert.equal(runtime(initial.files.get(preferenceFile)).window.backgroundColor, "#f6f7f9"));
await initial.set("system");
initial.changeSystem(true);
check(() => assert.equal(initial.window.backgroundColor, "#111214"));
check(() => assert.equal(initial.window.lastSent.state.resolvedTheme, "dark"));
initial.changeSystem(false);
check(() => assert.equal(initial.window.backgroundColor, "#f6f7f9"));
check(() => assert.equal(initial.state().theme, "system"));
await initial.set("dark");
initial.changeSystem(false);
check(() => assert.equal(initial.window.backgroundColor, "#111214"));
initial.window.destroyed = true;
check(() => assert.doesNotThrow(() => initial.changeSystem(true)));
const failing = runtime(undefined, { writeFailure: true });
await assert.rejects(failing.set("light"), /无法保存桌面主题偏好/);
check(() => assert.equal(failing.state().theme, "dark"));
check(() => assert.equal(failing.files.has(preferenceFile), false));

// Execute the actual sandbox preload with a minimal DOM and channel allowlist.
function preload({ deferred = false } = {}) {
  const apiRuntime = runtime();
  const rootElement = { dataset: {}, style: {} };
  const document = { documentElement: deferred ? null : rootElement };
  const listeners = new Map();
  let exposed;
  let observer;
  let disconnected = false;
  const context = vm.createContext({
    document,
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "hermesQQ"); exposed = value; } },
        ipcRenderer: {
          sendSync(channel) { assert.equal(channel, "app:get-theme"); return apiRuntime.snapshot(); },
          invoke(channel, value) { assert.equal(channel, "app:set-theme"); return apiRuntime.set(value); },
          on(channel, fn) { listeners.set(channel, fn); }
        }
      };
    }
  });
  new vm.Script(preloadSource, { filename: "desktop/preload.cjs" }).runInContext(context);
  return {
    api: exposed, rootElement,
    attachRoot() { document.documentElement = rootElement; observer(); return disconnected; },
    emit(state) { listeners.get("app:theme-changed")({}, state); }
  };
}
const loaded = preload();
check(() => assert.ok(Object.isFrozen(loaded.api)));
check(() => assert.equal(loaded.rootElement.dataset.theme, "dark"));
check(() => assert.equal(loaded.rootElement.style.backgroundColor, "#111214"));
check(() => assert.equal(loaded.api.getTheme().theme, "dark"));
await loaded.api.setTheme("light");
check(() => assert.equal(loaded.rootElement.style.colorScheme, "light"));
check(() => assert.equal(loaded.rootElement.style.backgroundColor, "#f6f7f9"));
await assert.rejects(loaded.api.setTheme({ theme: "dark" }), /invalid desktop theme/);
loaded.emit({ ok: true, theme: "system", resolvedTheme: "dark" });
check(() => assert.equal(loaded.rootElement.dataset.theme, "dark"));
check(() => assert.equal(loaded.rootElement.dataset.themePreference, "system"));
loaded.emit({ theme: "malformed", resolvedTheme: "light" });
check(() => assert.equal(loaded.rootElement.dataset.theme, "dark"));
const deferred = preload({ deferred: true });
check(() => assert.equal(deferred.attachRoot(), true));
check(() => assert.equal(deferred.rootElement.dataset.theme, "dark"));

const expectedIds = ["platform", "disk", "docker", "dockerHelp", "hermes", "hermesHelp", "bridge", "restart", "selectLegacy", "migrateLegacy", "legacyInfo", "prepareAccounts", "accountStatus", "accountLinks", "refresh", "continue", "detail"];
check(() => assert.deepEqual([...setupSource.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]), expectedIds));
check(() => assert.match(setupSource, /<body class="setup-page">/));
check(() => assert.match(setupSource, /href="\.\.\/public\/console\.css"/));
check(() => assert.match(setupSource, /src="\.\.\/public\/console-theme\.js"/));
check(() => assert.ok(setupSource.indexOf('src="../public/console-theme.js"') < setupSource.indexOf("<body")));
check(() => assert.doesNotMatch(setupSource, /(?:linear|radial)-gradient|\bonclick\s*=/));
for (const [index, match] of [...setupSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
  check(() => assert.doesNotThrow(() => new vm.Script(match[1], { filename: `setup-inline-${index}.js` })));
}
console.log(JSON.stringify({ ok: true, assertions, offline: true, bridgeStarted: false, liveDataTouched: false }));
}

// Optional real Chromium/preload QA with a fake dependency-status endpoint.
// Run with Electron, not the project's application entry point. All bridge and
// account operations remain uncalled, and state lives in a fresh temporary dir.
async function runElectronSmoke() {
  const electron = require("electron");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-theme-"));
  const keep = process.env.HERMES_QQ_THEME_SMOKE_KEEP === "1";
  electron.app.setPath("userData", temp);
  const timeout = setTimeout(() => { console.error("desktop theme smoke timed out"); electron.app.exit(1); }, 30_000);
  let window;
  try {
    await electron.app.whenReady();
    const fakeApp = new EventEmitter();
    Object.assign(fakeApp, {
      getPath: () => temp, getAppPath: () => root, setPath: () => {},
      requestSingleInstanceLock: () => false, quit: () => {}
    });
    // Real Electron native objects must stay in their own JS realm (not vm).
    const { Module } = require("node:module");
    const desktopModule = new Module(path.join(root, "desktop/main.cjs"));
    desktopModule.require = (name) => {
        if (name === "electron") return { ...electron, app: fakeApp };
        if (name === "../package.json") return { version: "theme-smoke" };
        if (name === "node:child_process") return { spawn() { throw new Error("process spawning forbidden in theme smoke"); } };
        if (["node:fs", "node:path", "node:os", "node:net", "node:crypto"].includes(name)) return require(name);
        throw new Error(`unexpected require: ${name}`);
    };
    const localProcess = { env: { HERMES_QQ_HOME: temp }, argv: ["--background"] };
    desktopModule._compile(`const process = ${JSON.stringify(localProcess)};\n${mainSource}\n module.exports = { initializeDesktopTheme, registerIpc, createWindow, getWindow: () => mainWindow };`, path.join(root, "desktop/main.cjs"));
    const context = { testApi: desktopModule.exports };
    context.testApi.initializeDesktopTheme();
    context.testApi.registerIpc();
    electron.ipcMain.removeHandler("app:get-status");
    electron.ipcMain.handle("app:get-status", () => ({
      supportedPlatform: true, platform: "darwin", arch: "arm64", firstRun: true,
      disk: { enough: true, availableBytes: 10 * 1024 ** 3 },
      docker: { running: false, version: "", error: "隔离测试：未连接 Docker" },
      hermes: { installed: false, version: "", error: "隔离测试：未调用 Hermes" },
      ports: { control6200: "available", onebot6199: "available" },
      stateRoot: "隔离测试目录", logRoot: "隔离测试目录", backupRoot: "隔离测试目录"
    }));
    context.testApi.createWindow();
    window = context.testApi.getWindow();
    await new Promise((resolve, reject) => {
      window.webContents.once("did-finish-load", resolve);
      window.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`${code}: ${description}`)));
    });
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    assert.equal(await evaluate('window.hermesQQ.getTheme().theme'), "dark");
    assert.equal(await evaluate('document.documentElement.dataset.theme'), "dark");
    assert.equal(await evaluate('getComputedStyle(document.documentElement).backgroundColor'), "rgb(17, 18, 20)");
    const sharedAssetsPresent = ["console.css", "console-theme.js"].every((file) => fs.existsSync(path.join(root, "public", file)));
    const screenshots = [];
    for (const theme of ["dark", "light", "system"]) {
      const state = await evaluate(`window.hermesQQ.setTheme(${JSON.stringify(theme)})`);
      assert.equal(state.theme, theme);
      assert.equal(await evaluate('document.documentElement.dataset.theme'), state.resolvedTheme);
      assert.equal(await evaluate('matchMedia("(prefers-color-scheme: dark)").matches'), state.resolvedTheme === "dark");
      for (const [width, height] of [[1460, 940], [768, 600]]) {
        window.setSize(width, height);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (sharedAssetsPresent) {
          assert.equal(await evaluate('getComputedStyle(document.body).fontSize'), "14px");
          assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
          assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), state.resolvedTheme === "dark" ? "rgb(17, 18, 20)" : "rgb(246, 247, 249)");
        }
        if (keep) {
          const file = path.join(temp, `setup-${theme}-${width}.png`);
          fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
          screenshots.push(file);
        }
      }
    }
    assert.match(await evaluate('window.hermesQQ.setTheme({theme:"dark"}).then(() => "accepted", error => error.message)'), /invalid desktop theme/);
    console.log(JSON.stringify({ ok: true, electronSmoke: true, sharedAssetsPresent, screenshots, bridgeStarted: false, liveDataTouched: false }));
  } finally {
    clearTimeout(timeout);
    window?.destroy();
    if (!keep) fs.rmSync(temp, { recursive: true, force: true });
    electron.app.quit();
  }
}

// Do not hold Electron's ESM bootstrap open while waiting for app.ready.
if (process.versions.electron && process.argv.includes("--electron-smoke")) {
  void runElectronSmoke().catch((error) => { console.error(error); require("electron").app.exit(1); });
}
else await runOffline();
