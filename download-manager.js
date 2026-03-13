const fs = require("fs/promises");
const path = require("path");

const { formatDateStamp, getDefaultDownloadFolder, sanitizeFilename } = require("./utils");

const MEDIA_HEADERS = {
  referer: "https://www.pinterest.com/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

async function downloadItems(payload = {}, emit = () => {}) {
  const settings = payload.settings || {};
  const outputFolder = payload.saveFolder || getDefaultDownloadFolder();
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  const queue = allItems.filter((item) => item && item.selected && item.directUrl);
  const concurrency = Math.max(1, Math.min(Number(settings.concurrency) || 2, 4));
  const summary = { total: queue.length, completed: 0, failed: 0, skipped: 0, remaining: queue.length };
  const log = [];
  const startedAt = Date.now();
  let downloadedBytes = 0;
  let pointer = 0;

  await fs.mkdir(outputFolder, { recursive: true });
  emit({ type: "queue-start", outputFolder, summary: withSpeed(summary, startedAt, downloadedBytes) });

  const workerCount = Math.min(concurrency, queue.length || 1);
  const worker = async () => {
    while (true) {
      const currentIndex = pointer;
      pointer += 1;
      if (currentIndex >= queue.length) {
        return;
      }

      const item = queue[currentIndex];
      const itemStartedAt = Date.now();
      let currentFilePath = null;

      try {
        emit({ type: "item-status", itemId: item.id, status: "Fetching", summary: withSpeed(summary, startedAt, downloadedBytes) });

        const targetDir = await resolveTargetDirectory(outputFolder, item, settings);
        await fs.mkdir(targetDir, { recursive: true });

        const fileName = buildFileName(item, settings);
        const duplicateResult = await resolveDuplicatePath(targetDir, fileName, settings.duplicatePolicy || "rename");
        currentFilePath = duplicateResult.filePath;

        if (duplicateResult.action === "skip") {
          summary.skipped += 1;
          summary.remaining -= 1;
          const logEntry = { sourceUrl: item.sourceUrl, directUrl: item.directUrl, savedPath: duplicateResult.filePath, status: "Skipped Duplicate", error: null };
          log.push(logEntry);
          emit({
            type: "item-status",
            itemId: item.id,
            status: "Skipped Duplicate",
            savedPath: duplicateResult.filePath,
            logEntry,
            summary: withSpeed(summary, startedAt, downloadedBytes),
          });
          continue;
        }

        const response = await fetch(item.directUrl, {
          headers: MEDIA_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok || !response.body) {
          throw new Error(`download failure (${response.status})`);
        }

        const totalBytes = Number(response.headers.get("content-length")) || item.fileSize || null;
        emit({ type: "item-status", itemId: item.id, status: "Downloading", totalBytes, summary: withSpeed(summary, startedAt, downloadedBytes) });

        const fileHandle = await fs.open(duplicateResult.filePath, "w");
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
            await fileHandle.write(chunk.value);

            emit({
              type: "item-progress",
              itemId: item.id,
              status: "Downloading",
              bytesDownloaded: itemBytes,
              totalBytes,
              speedBps: itemBytes / Math.max((Date.now() - itemStartedAt) / 1000, 0.25),
              summary: withSpeed(summary, startedAt, downloadedBytes),
            });
          }
        } finally {
          await fileHandle.close();
        }

        summary.completed += 1;
        summary.remaining -= 1;
        const logEntry = { sourceUrl: item.sourceUrl, directUrl: item.directUrl, savedPath: duplicateResult.filePath, status: "Saved", bytesDownloaded: itemBytes, error: null };
        log.push(logEntry);
        emit({
          type: "item-status",
          itemId: item.id,
          status: "Saved",
          savedPath: duplicateResult.filePath,
          bytesDownloaded: itemBytes,
          logEntry,
          summary: withSpeed(summary, startedAt, downloadedBytes),
        });
      } catch (error) {
        if (currentFilePath) {
          await fs.rm(currentFilePath, { force: true }).catch(() => {});
        }
        summary.failed += 1;
        summary.remaining -= 1;
        const logEntry = { sourceUrl: item.sourceUrl, directUrl: item.directUrl, savedPath: null, status: "Failed", error: classifyDownloadError(error) };
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
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const finalSummary = withSpeed(summary, startedAt, downloadedBytes);
  emit({ type: "queue-complete", outputFolder, log, summary: finalSummary });
  return { outputFolder, log, summary: finalSummary };
}

function withSpeed(summary, startedAt, downloadedBytes) {
  return {
    ...summary,
    bytesDownloaded: downloadedBytes,
    speedBps: downloadedBytes / Math.max((Date.now() - startedAt) / 1000, 0.25),
  };
}

async function resolveTargetDirectory(baseFolder, item, settings) {
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
  return path.join(baseFolder, ...segments);
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

async function resolveDuplicatePath(folderPath, fileName, duplicatePolicy) {
  const parsed = path.parse(fileName);
  const initialPath = path.join(folderPath, fileName);

  if (!(await fileExists(initialPath))) {
    return { action: "save", filePath: initialPath };
  }
  if (duplicatePolicy === "overwrite") {
    return { action: "save", filePath: initialPath };
  }
  if (duplicatePolicy === "skip") {
    return { action: "skip", filePath: initialPath };
  }

  let counter = 1;
  while (counter < 10000) {
    const candidatePath = path.join(folderPath, `${parsed.name}(${counter})${parsed.ext}`);
    if (!(await fileExists(candidatePath))) {
      return { action: "save", filePath: candidatePath };
    }
    counter += 1;
  }

  return { action: "skip", filePath: initialPath };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function classifyDownloadError(error) {
  if (error && error.name === "TimeoutError") {
    return "network timeout";
  }
  const message = String((error && error.message) || "").toLowerCase();
  if (message.includes("eperm") || message.includes("eacces")) {
    return "folder permission error";
  }
  if (message.includes("timeout")) {
    return "network timeout";
  }
  if (message.includes("download failure")) {
    return "download failure";
  }
  return "download failure";
}

module.exports = {
  downloadItems,
  getDefaultDownloadFolder,
};
