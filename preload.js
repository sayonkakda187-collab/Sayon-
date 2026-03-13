const { contextBridge, ipcRenderer } = require("electron");
const { extractPinterestUrls } = require("./src/pinterest-service");

contextBridge.exposeInMainWorld("pinterestDownloader", {
  getDefaultFolder: () => ipcRenderer.invoke("folder:get-default"),
  selectFolder: () => ipcRenderer.invoke("folder:select"),
  openFolder: (folderPath) => ipcRenderer.invoke("folder:open", folderPath),
  importTextFile: () => ipcRenderer.invoke("file:import-text"),
  analyzeUrls: (payload) => ipcRenderer.invoke("pins:analyze", payload),
  extractUrls: (text) => extractPinterestUrls(text),
  startDownloads: (payload) => ipcRenderer.invoke("download:start", payload),
  exportLog: (payload) => ipcRenderer.invoke("log:export", payload),
  onDownloadEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("download:event", listener);
    return () => ipcRenderer.removeListener("download:event", listener);
  },
});
