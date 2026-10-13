const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

let themeState = ipcRenderer.sendSync("app:get-theme");
function applyTheme(state) {
  if (!state || !["dark", "light", "system"].includes(state.theme) || !["dark", "light"].includes(state.resolvedTheme)) return;
  themeState = state;
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = state.resolvedTheme;
  root.dataset.themePreference = state.theme;
  root.style.colorScheme = state.resolvedTheme;
  root.style.backgroundColor = state.resolvedTheme === "dark" ? "#111214" : "#f6f7f9";
}

ipcRenderer.on("app:theme-changed", (_event, state) => applyTheme(state));
if (document.documentElement) applyTheme(themeState);
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    applyTheme(themeState);
    observer.disconnect();
  });
  observer.observe(document, { childList: true });
}

contextBridge.exposeInMainWorld("hermesQQ", Object.freeze({
  getTheme: () => ipcRenderer.sendSync("app:get-theme"),
  setTheme: (theme) => invoke("app:set-theme", theme).then((state) => { applyTheme(state); return state; }),
  getAppStatus: () => invoke("app:get-status"),
  prepareSnowLuma: () => invoke("setup:prepare-snowluma"),
  startBot: () => invoke("bot:start"),
  stopBot: () => invoke("bot:stop"),
  restartBot: () => invoke("bot:restart"),
  chooseBackupDestination: () => invoke("backup:choose-destination"),
  chooseBackupFile: () => invoke("backup:choose-file"),
  createBackup: (options) => invoke("backup:create", options),
  getBackupStatus: () => invoke("backup:status"),
  cancelBackup: () => invoke("backup:cancel"),
  onBackupProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("backup:progress", listener);
    return () => ipcRenderer.removeListener("backup:progress", listener);
  },
  inspectBackup: (options) => invoke("backup:inspect", options),
  restoreBackup: (options) => invoke("backup:restore", options),
  listLocalBackups: () => invoke("backup:list"),
  deleteLocalBackup: (path) => invoke("backup:delete", { path }),
  selectLegacyProject: () => invoke("legacy:select"),
  migrateLegacyProject: (path) => invoke("legacy:migrate", { path }),
  completeSetup: () => invoke("setup:complete"),
  openExternal: (url) => invoke("shell:open-external", { url }),
  openPath: (path) => invoke("shell:open-path", { path }),
  revealBackup: (path) => invoke("shell:reveal-backup", { path }),
  setAutoStart: (enabled) => invoke("app:set-auto-start", { enabled })
}));
