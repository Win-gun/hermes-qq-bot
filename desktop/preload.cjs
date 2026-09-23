const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("hermesQQ", Object.freeze({
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
