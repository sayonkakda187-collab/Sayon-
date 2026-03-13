if (!process.versions.electron) {
  require("./server");
} else {
  const fs = require("fs/promises");
  const path = require("path");
  const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

  const { analyzeUrls } = require("./src/pinterest-service");
  const { downloadItems, getDefaultDownloadFolder } = require("./src/download-manager");

  let mainWindow;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 1200,
      minHeight: 780,
      backgroundColor: "#f3efe3",
      title: "Pinterest Downloader",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  ipcMain.handle("folder:get-default", async () => {
    const folderPath = getDefaultDownloadFolder();
    await fs.mkdir(folderPath, { recursive: true });
    return folderPath;
  });

  ipcMain.handle("folder:select", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select save folder",
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    return {
      canceled: false,
      folderPath: result.filePaths[0],
    };
  });

  ipcMain.handle("folder:open", async (_event, folderPath) => {
    if (!folderPath) {
      return { ok: false, error: "No folder selected." };
    }

    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("file:import-text", async () => {
    const result = await dialog.showOpenDialog({
      title: "Import text, HTML, or URL list",
      properties: ["openFile"],
      filters: [
        { name: "Supported files", extensions: ["txt", "html", "htm", "json", "csv", "md", "log"] },
        { name: "All files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, "utf8");

    return {
      canceled: false,
      filePath,
      content,
    };
  });

  ipcMain.handle("pins:analyze", async (_event, payload = {}) => {
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    return analyzeUrls(urls);
  });

  ipcMain.handle("download:start", async (event, payload = {}) => {
    const send = (message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("download:event", message);
      }
    };

    return downloadItems(payload, send);
  });

  ipcMain.handle("log:export", async (_event, payload = {}) => {
    const defaultName = `pinterest-download-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const result = await dialog.showSaveDialog({
      title: "Export download log",
      defaultPath: path.join(getDefaultDownloadFolder(), defaultName),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const document = {
      exportedAt: new Date().toISOString(),
      summary: payload.summary || null,
      log: payload.log || [],
    };

    await fs.writeFile(result.filePath, JSON.stringify(document, null, 2), "utf8");

    return {
      canceled: false,
      filePath: result.filePath,
    };
  });
}
