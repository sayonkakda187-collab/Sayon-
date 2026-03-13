(function bootstrapBrowserApi() {
  const listeners = new Set();
  const supportsFileSystemAccess = Boolean(
    window.isSecureContext &&
    "showDirectoryPicker" in window &&
    "FileSystemWritableFileStream" in window,
  );

  const downloadState = {
    folderHandle: null,
    folderLabel: supportsFileSystemAccess ? "Choose a save folder" : "Browser-managed Downloads",
    restored: false,
    restorePromise: null,
  };

  const browserApi = {
    getDefaultFolder,
    getEnvironment,
    selectFolder,
    openFolder,
    importTextFile,
    analyzeUrls,
    extractUrls: extractPinterestUrls,
    startDownloads,
    exportLog,
    onDownloadEvent,
  };

  window.pinterestDownloaderWeb = browserApi;

  async function getDefaultFolder() {
    await ensureRestored();
    return downloadState.folderLabel;
  }

  async function getEnvironment() {
    await ensureRestored();

    return {
      runtime: "web",
      canSelectFolder: supportsFileSystemAccess,
      canOpenFolder: false,
      saveMode: supportsFileSystemAccess && downloadState.folderHandle ? "direct-folder" : "browser-download",
      saveModeLabel: supportsFileSystemAccess && downloadState.folderHandle ? "Direct Folder Save" : "Browser Downloads",
      saveHint: supportsFileSystemAccess
        ? downloadState.folderHandle
          ? "Files will be written directly into the selected folder. Browser install mode keeps this flow available on supported desktop browsers."
          : "Choose a folder to enable direct writes. Without folder access, downloads fall back to the browser's normal save flow."
        : "This browser does not support direct folder access. Files will download through browser-managed storage or the system save/share flow.",
      folderLabel: downloadState.folderLabel,
      isSecureContext: window.isSecureContext,
      supportsFileSystemAccess,
    };
  }

  async function selectFolder() {
    await ensureRestored();

    if (!supportsFileSystemAccess) {
      return {
        canceled: false,
        unsupported: true,
        folderPath: downloadState.folderLabel,
      };
    }

    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const permission = await verifyPermission(handle);
      if (permission !== "granted") {
        return {
          canceled: true,
        };
      }

      downloadState.folderHandle = handle;
      downloadState.folderLabel = handle.name;
      await saveHandle(handle);

      return {
        canceled: false,
        folderPath: handle.name,
      };
    } catch (error) {
      if (error && error.name === "AbortError") {
        return { canceled: true };
      }

      return {
        canceled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function openFolder() {
    return {
      ok: false,
      error: "Opening a folder directly is not supported in browser mode.",
    };
  }

  async function importTextFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.html,.htm,.json,.csv,.md,.log,text/plain,text/html,application/json";
      input.style.display = "none";

      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) {
          resolve({ canceled: true });
          input.remove();
          return;
        }

        const content = await file.text();
        resolve({
          canceled: false,
          filePath: file.name,
          content,
        });
        input.remove();
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  async function analyzeUrls(payload) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    if (!response.ok) {
      throw new Error(`Analyze request failed (${response.status})`);
    }

    return response.json();
  }

  async function startDownloads(payload) {
    await ensureRestored();

    const items = Array.isArray(payload && payload.items) ? payload.items.filter((item) => item && item.selected && item.directUrl) : [];
    const settings = (payload && payload.settings) || {};

    if (!items.length) {
      return {
        summary: emptySummary(),
        log: [],
      };
    }

    if (supportsFileSystemAccess && downloadState.folderHandle) {
      const permission = await verifyPermission(downloadState.folderHandle);
      if (permission === "granted") {
        return saveDirectlyToFolder(items, settings);
      }

      downloadState.folderHandle = null;
      downloadState.folderLabel = "Browser-managed Downloads";
      await clearHandle();
    }

    return startBrowserManagedDownloads(items, settings);
  }

  async function exportLog(payload) {
    const fileName = `pinterest-download-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const documentText = JSON.stringify({
      exportedAt: new Date().toISOString(),
      summary: payload && payload.summary ? payload.summary : null,
      log: payload && payload.log ? payload.log : [],
    }, null, 2);

    triggerDownloadFromBlob(documentText, "application/json", fileName);

    return {
      canceled: false,
      filePath: "Browser download",
    };
  }

  function onDownloadEvent(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  async function saveDirectlyToFolder(items, settings) {
    const summary = createSummary(items.length);
    const log = [];
    const startedAt = Date.now();
    let downloadedBytes = 0;

    emit({
      type: "queue-start",
      outputFolder: downloadState.folderLabel,
      summary: withSpeed(summary, startedAt, downloadedBytes),
    });

    for (const item of items) {
      let savedLabel = null;

      try {
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Fetching",
          summary: withSpeed(summary, startedAt, downloadedBytes),
        });

        const directory = await resolveTargetDirectory(downloadState.folderHandle, item, settings);
        const fileName = buildFileName(item, settings);
        const duplicate = await resolveDuplicateTarget(directory, fileName, settings.duplicatePolicy || "rename");

        if (duplicate.action === "skip") {
          summary.skipped += 1;
          summary.remaining -= 1;
          savedLabel = joinPathParts(duplicate.relativeParts);
          const logEntry = {
            sourceUrl: item.sourceUrl,
            directUrl: item.directUrl,
            savedPath: savedLabel,
            status: "Skipped Duplicate",
            error: null,
          };

          log.push(logEntry);
          emit({
            type: "item-status",
            itemId: item.id,
            status: "Skipped Duplicate",
            savedPath: savedLabel,
            logEntry,
            summary: withSpeed(summary, startedAt, downloadedBytes),
          });
          continue;
        }

        const mediaUrl = buildMediaProxyUrl(item.directUrl, duplicate.fileName);
        const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(60000) });
        if (!response.ok || !response.body) {
          throw new Error(`download failure (${response.status})`);
        }

        const totalBytes = Number(response.headers.get("content-length")) || item.fileSize || null;
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Downloading",
          totalBytes,
          summary: withSpeed(summary, startedAt, downloadedBytes),
        });

        const fileHandle = await duplicate.directoryHandle.getFileHandle(duplicate.fileName, { create: true });
        const writable = await fileHandle.createWritable();
        const reader = response.body.getReader();
        let itemBytes = 0;

        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }

            itemBytes += chunk.value.length;
            downloadedBytes += chunk.value.length;
            await writable.write(chunk.value);

            emit({
              type: "item-progress",
              itemId: item.id,
              status: "Downloading",
              bytesDownloaded: itemBytes,
              totalBytes,
              speedBps: itemBytes / Math.max((Date.now() - startedAt) / 1000, 0.25),
              summary: withSpeed(summary, startedAt, downloadedBytes),
            });
          }
        } catch (error) {
          await writable.abort();
          throw error;
        }

        await writable.close();

        summary.completed += 1;
        summary.remaining -= 1;
        savedLabel = joinPathParts(duplicate.relativeParts);

        const logEntry = {
          sourceUrl: item.sourceUrl,
          directUrl: item.directUrl,
          savedPath: savedLabel,
          status: "Saved",
          bytesDownloaded: itemBytes,
          error: null,
        };

        log.push(logEntry);
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Saved",
          savedPath: savedLabel,
          bytesDownloaded: itemBytes,
          logEntry,
          summary: withSpeed(summary, startedAt, downloadedBytes),
        });
      } catch (error) {
        summary.failed += 1;
        summary.remaining -= 1;

        const logEntry = {
          sourceUrl: item.sourceUrl,
          directUrl: item.directUrl,
          savedPath: savedLabel,
          status: "Failed",
          error: classifyDownloadError(error),
        };

        log.push(logEntry);
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Failed",
          error: logEntry.error,
          logEntry,
          summary: withSpeed(summary, startedAt, downloadedBytes),
        });
      }
    }

    const finalSummary = withSpeed(summary, startedAt, downloadedBytes);
    emit({
      type: "queue-complete",
      outputFolder: downloadState.folderLabel,
      log,
      summary: finalSummary,
    });

    return {
      outputFolder: downloadState.folderLabel,
      log,
      summary: finalSummary,
    };
  }

  async function startBrowserManagedDownloads(items, settings) {
    const summary = createSummary(items.length);
    const log = [];
    const startedAt = Date.now();

    emit({
      type: "queue-start",
      outputFolder: "Browser-managed Downloads",
      summary: withSpeed(summary, startedAt, 0),
    });

    for (const item of items) {
      try {
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Fetching",
          summary: withSpeed(summary, startedAt, 0),
        });

        const fileName = buildFileName(item, settings);
        const mediaUrl = buildMediaProxyUrl(item.directUrl, fileName);
        const headResponse = await fetch(mediaUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(30000),
        });

        if (!headResponse.ok) {
          throw new Error(`download failure (${headResponse.status})`);
        }

        emit({
          type: "item-status",
          itemId: item.id,
          status: "Downloading",
          totalBytes: Number(headResponse.headers.get("content-length")) || item.fileSize || null,
          summary: withSpeed(summary, startedAt, 0),
        });

        triggerDownloadFromUrl(mediaUrl, fileName);
        await delay(250);

        summary.completed += 1;
        summary.remaining -= 1;

        const logEntry = {
          sourceUrl: item.sourceUrl,
          directUrl: item.directUrl,
          savedPath: "Browser-managed download",
          status: "Saved",
          error: null,
        };

        log.push(logEntry);
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Saved",
          savedPath: "Browser-managed download",
          logEntry,
          summary: withSpeed(summary, startedAt, 0),
        });
      } catch (error) {
        summary.failed += 1;
        summary.remaining -= 1;

        const logEntry = {
          sourceUrl: item.sourceUrl,
          directUrl: item.directUrl,
          savedPath: null,
          status: "Failed",
          error: classifyDownloadError(error),
        };

        log.push(logEntry);
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Failed",
          error: logEntry.error,
          logEntry,
          summary: withSpeed(summary, startedAt, 0),
        });
      }
    }

    const finalSummary = withSpeed(summary, startedAt, 0);
    emit({
      type: "queue-complete",
      outputFolder: "Browser-managed Downloads",
      log,
      summary: finalSummary,
    });

    return {
      outputFolder: "Browser-managed Downloads",
      log,
      summary: finalSummary,
    };
  }

  async function resolveTargetDirectory(baseHandle, item, settings) {
    const segments = [];

    if (settings.subfolderByDate) {
      segments.push(formatDateStamp(new Date()));
    }
    if (settings.subfolderByBoard && item.boardName) {
      segments.push(sanitizeFilename(item.boardName, "board"));
    }
    if (settings.subfolderByMediaType && item.mediaType) {
      segments.push(sanitizeFilename(item.mediaType, "media"));
    }

    let handle = baseHandle;
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment, { create: true });
    }

    return {
      directoryHandle: handle,
      relativeParts: [downloadState.folderLabel, ...segments],
    };
  }

  async function resolveDuplicateTarget(directory, fileName, duplicatePolicy) {
    const existing = await fileExists(directory.directoryHandle, fileName);

    if (!existing) {
      return {
        action: "save",
        fileName,
        directoryHandle: directory.directoryHandle,
        relativeParts: [...directory.relativeParts, fileName],
      };
    }

    if (duplicatePolicy === "overwrite") {
      return {
        action: "save",
        fileName,
        directoryHandle: directory.directoryHandle,
        relativeParts: [...directory.relativeParts, fileName],
      };
    }

    if (duplicatePolicy === "skip") {
      return {
        action: "skip",
        fileName,
        directoryHandle: directory.directoryHandle,
        relativeParts: [...directory.relativeParts, fileName],
      };
    }

    const extensionIndex = fileName.lastIndexOf(".");
    const baseName = extensionIndex === -1 ? fileName : fileName.slice(0, extensionIndex);
    const extension = extensionIndex === -1 ? "" : fileName.slice(extensionIndex);

    for (let counter = 1; counter < 10000; counter += 1) {
      const candidate = `${baseName}(${counter})${extension}`;
      if (!(await fileExists(directory.directoryHandle, candidate))) {
        return {
          action: "save",
          fileName: candidate,
          directoryHandle: directory.directoryHandle,
          relativeParts: [...directory.relativeParts, candidate],
        };
      }
    }

    return {
      action: "skip",
      fileName,
      directoryHandle: directory.directoryHandle,
      relativeParts: [...directory.relativeParts, fileName],
    };
  }

  async function fileExists(directoryHandle, fileName) {
    try {
      await directoryHandle.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async function ensureRestored() {
    if (downloadState.restored) {
      return;
    }

    if (!downloadState.restorePromise) {
      downloadState.restorePromise = restoreHandle();
    }

    await downloadState.restorePromise;
    downloadState.restored = true;
  }

  async function restoreHandle() {
    if (!supportsFileSystemAccess) {
      return;
    }

    try {
      const handle = await readHandle();
      if (!handle) {
        return;
      }

      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission === "granted" || permission === "prompt") {
        downloadState.folderHandle = handle;
        downloadState.folderLabel = handle.name;
      }
    } catch {
      // Ignore stored handle restoration failures.
    }
  }

  async function verifyPermission(handle) {
    if (!handle || typeof handle.requestPermission !== "function") {
      return "granted";
    }

    const existing = await handle.queryPermission({ mode: "readwrite" });
    if (existing === "granted") {
      return existing;
    }

    return handle.requestPermission({ mode: "readwrite" });
  }

  function emit(event) {
    listeners.forEach((listener) => listener(event));
  }

  function triggerDownloadFromUrl(url, fileName) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function triggerDownloadFromBlob(content, contentType, fileName) {
    const blob = new Blob([content], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    triggerDownloadFromUrl(blobUrl, fileName);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  function buildMediaProxyUrl(directUrl, fileName) {
    const params = new URLSearchParams({
      url: directUrl,
      filename: fileName,
    });
    return `/api/media?${params.toString()}`;
  }

  function buildFileName(item, settings) {
    const prefix = sanitizeFilename(settings.customPrefix || "Pinterest", "Pinterest");
    const parts = [prefix];

    if (settings.usePinTitle && item.pinTitle) {
      parts.push(sanitizeFilename(item.pinTitle, "pin"));
    }

    parts.push(item.pinId || "unknown");
    parts.push(item.mediaType || "media");
    parts.push(String(item.index || 1));

    if (settings.addDate) {
      parts.push(formatDateStamp(new Date()));
    }

    return `${parts.join("_")}${item.extension || ".jpg"}`;
  }

  function createSummary(total) {
    return {
      total,
      completed: 0,
      failed: 0,
      skipped: 0,
      remaining: total,
    };
  }

  function emptySummary() {
    return withSpeed(createSummary(0), Date.now(), 0);
  }

  function withSpeed(summary, startedAt, downloadedBytes) {
    return {
      ...summary,
      bytesDownloaded: downloadedBytes,
      speedBps: downloadedBytes / Math.max((Date.now() - startedAt) / 1000, 0.25),
    };
  }

  function classifyDownloadError(error) {
    const message = String((error && error.message) || "").toLowerCase();
    if (error && error.name === "TimeoutError") {
      return "network timeout";
    }
    if (message.includes("permission")) {
      return "folder permission error";
    }
    if (message.includes("timeout")) {
      return "network timeout";
    }
    return "download failure";
  }

  function extractPinterestUrls(text) {
    const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const cleaned = matches
      .map((value) => value.replace(/[),.;]+$/g, ""))
      .map(normalizePinterestUrl)
      .filter((entry) => entry.ok)
      .map((entry) => entry.url);

    return [...new Set(cleaned)];
  }

  function normalizePinterestUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl.trim());
      if (!isPinterestHost(parsed.hostname)) {
        return { ok: false };
      }

      parsed.hash = "";

      if (parsed.hostname.toLowerCase() !== "pin.it") {
        const pinMatch = parsed.pathname.match(/\/pin\/(?:[^/]*--)?(\d+)/i);
        if (!pinMatch) {
          return { ok: false };
        }
        parsed.pathname = `/pin/${pinMatch[1]}/`;
        parsed.search = "";
      }

      return { ok: true, url: parsed.toString() };
    } catch {
      return { ok: false };
    }
  }

  function isPinterestHost(hostname) {
    return hostname.toLowerCase() === "pin.it" || /(^|\.)pinterest\.[a-z.]+$/i.test(hostname);
  }

  function sanitizeFilename(value, fallback) {
    const cleaned = String(value || "")
      .normalize("NFKD")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned ? cleaned.slice(0, 110) : fallback;
  }

  function formatDateStamp(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}${month}${day}`;
  }

  function joinPathParts(parts) {
    return parts.join("/");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function saveHandle(handle) {
    try {
      const db = await openDatabase();
      await runRequest(db.transaction("handles", "readwrite").objectStore("handles").put(handle, "save-folder"));
      db.close();
    } catch {
      // Ignore persistence failures.
    }
  }

  async function readHandle() {
    const db = await openDatabase();
    const handle = await runRequest(db.transaction("handles", "readonly").objectStore("handles").get("save-folder"));
    db.close();
    return handle || null;
  }

  async function clearHandle() {
    try {
      const db = await openDatabase();
      await runRequest(db.transaction("handles", "readwrite").objectStore("handles").delete("save-folder"));
      db.close();
    } catch {
      // Ignore persistence failures.
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("pin-downloader-browser", 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("handles");
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function runRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
})();
