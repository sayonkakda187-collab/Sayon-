const platformApi = window.pinterestDownloader || window.pinterestDownloaderWeb;
const SETTINGS_STORAGE_KEY = "pin-downloader-settings";

const state = {
  mode: "single",
  folderPath: "",
  queueItems: [],
  extractedUrls: [],
  importedFilePath: "",
  environment: {
    runtime: window.pinterestDownloader ? "desktop" : "web",
    canSelectFolder: true,
    canOpenFolder: true,
    saveMode: "direct-folder",
    saveModeLabel: "Direct Folder Save",
    saveHint: "If you do not choose a folder, files are saved to Downloads/Pinterest_Downloader.",
  },
  progress: { total: 0, completed: 0, failed: 0, skipped: 0, remaining: 0, speedBps: 0 },
  latestSummary: { total: 0, completed: 0, failed: 0, skipped: 0 },
  downloadLog: [],
  isAnalyzing: false,
  isDownloading: false,
  message: null,
};

const elements = {
  modeButtons: [...document.querySelectorAll(".mode-btn")],
  panes: [...document.querySelectorAll(".mode-pane")],
  singleInput: document.getElementById("single-url-input"),
  multiInput: document.getElementById("multi-url-input"),
  extractInput: document.getElementById("extract-source-input"),
  importedFileLabel: document.getElementById("imported-file-label"),
  extractedList: document.getElementById("extracted-list"),
  extractCount: document.getElementById("extract-count"),
  findUrlBtn: document.getElementById("find-url-btn"),
  extractUrlBtn: document.getElementById("extract-url-btn"),
  addExtractedBtn: document.getElementById("add-extracted-btn"),
  clearInputBtn: document.getElementById("clear-input-btn"),
  importFileBtn: document.getElementById("import-file-btn"),
  selectExtractedBtn: document.getElementById("select-extracted-btn"),
  removeExtractedBtn: document.getElementById("remove-extracted-btn"),
  messageBanner: document.getElementById("message-banner"),
  folderPath: document.getElementById("folder-path"),
  selectFolderBtn: document.getElementById("select-folder-btn"),
  openFolderBtn: document.getElementById("open-folder-btn"),
  saveModeBadge: document.getElementById("save-mode-badge"),
  saveCapabilityNote: document.getElementById("save-capability-note"),
  duplicatePolicy: document.getElementById("duplicate-policy"),
  concurrency: document.getElementById("concurrency-select"),
  subfolderDate: document.getElementById("subfolder-date"),
  subfolderBoard: document.getElementById("subfolder-board"),
  subfolderMedia: document.getElementById("subfolder-media"),
  usePinTitle: document.getElementById("use-pin-title"),
  addDate: document.getElementById("add-date"),
  customPrefix: document.getElementById("custom-prefix-input"),
  startDownloadBtn: document.getElementById("start-download-btn"),
  previewBody: document.getElementById("preview-body"),
  selectAllBtn: document.getElementById("select-all-btn"),
  unselectAllBtn: document.getElementById("unselect-all-btn"),
  removeSelectedBtn: document.getElementById("remove-selected-btn"),
  retryFailedBtn: document.getElementById("retry-failed-btn"),
  progressLabel: document.getElementById("progress-label"),
  progressDetail: document.getElementById("progress-detail"),
  progressFill: document.getElementById("progress-fill"),
  queueCount: document.getElementById("queue-count"),
  queueDetail: document.getElementById("queue-detail"),
  completedCount: document.getElementById("completed-count"),
  completedDetail: document.getElementById("completed-detail"),
  failedCount: document.getElementById("failed-count"),
  failedDetail: document.getElementById("failed-detail"),
  speedCount: document.getElementById("speed-count"),
  remainingCount: document.getElementById("remaining-count"),
  summaryTotal: document.getElementById("summary-total"),
  summaryDownloaded: document.getElementById("summary-downloaded"),
  summaryFailed: document.getElementById("summary-failed"),
  summarySkipped: document.getElementById("summary-skipped"),
  completionOpenFolderBtn: document.getElementById("completion-open-folder-btn"),
  completionRetryBtn: document.getElementById("completion-retry-btn"),
  exportLogBtn: document.getElementById("export-log-btn"),
};

const unsubscribeDownloadEvents = platformApi.onDownloadEvent(handleDownloadEvent);

window.addEventListener("beforeunload", () => {
  if (typeof unsubscribeDownloadEvents === "function") {
    unsubscribeDownloadEvents();
  }
});

boot();

async function boot() {
  bindEvents();
  loadPreferences();
  await refreshEnvironment();
  state.folderPath = await platformApi.getDefaultFolder();
  renderAll();
}

function bindEvents() {
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      clearMessage();
      renderAll();
    });
  });

  elements.findUrlBtn.addEventListener("click", handleFindUrl);
  elements.extractUrlBtn.addEventListener("click", handleExtractUrls);
  elements.addExtractedBtn.addEventListener("click", addSelectedExtractedUrls);
  elements.clearInputBtn.addEventListener("click", clearCurrentInput);
  elements.importFileBtn.addEventListener("click", importTextFile);
  elements.selectExtractedBtn.addEventListener("click", () => {
    state.extractedUrls = state.extractedUrls.map((item) => ({ ...item, selected: true }));
    renderExtractedList();
  });
  elements.removeExtractedBtn.addEventListener("click", () => {
    state.extractedUrls = state.extractedUrls.filter((item) => item.selected);
    renderExtractedList();
  });

  elements.selectFolderBtn.addEventListener("click", selectFolder);
  elements.openFolderBtn.addEventListener("click", () => openFolder(state.folderPath));
  elements.completionOpenFolderBtn.addEventListener("click", () => openFolder(state.folderPath));

  elements.startDownloadBtn.addEventListener("click", () => startDownload());
  elements.selectAllBtn.addEventListener("click", () => updateAllSelection(true));
  elements.unselectAllBtn.addEventListener("click", () => updateAllSelection(false));
  elements.removeSelectedBtn.addEventListener("click", removeSelectedItems);
  elements.retryFailedBtn.addEventListener("click", retryFailedItems);
  elements.completionRetryBtn.addEventListener("click", retryFailedItems);
  elements.exportLogBtn.addEventListener("click", exportLog);

  elements.previewBody.addEventListener("click", handleTableAction);
  elements.previewBody.addEventListener("change", handleTableSelection);
  elements.extractedList.addEventListener("change", handleExtractSelection);
  elements.extractedList.addEventListener("click", handleExtractRemoval);

  [
    elements.duplicatePolicy,
    elements.concurrency,
    elements.subfolderDate,
    elements.subfolderBoard,
    elements.subfolderMedia,
    elements.usePinTitle,
    elements.addDate,
    elements.customPrefix,
  ].forEach((element) => {
    element.addEventListener("change", savePreferences);
    element.addEventListener("input", savePreferences);
  });
}

async function handleFindUrl() {
  if (state.mode === "extract") {
    showMessage("Use Extract URL in extract mode, then add the selected results to the queue.", "info");
    return;
  }

  const urls = state.mode === "single"
    ? [elements.singleInput.value.trim()].filter(Boolean)
    : dedupeLines(elements.multiInput.value);

  if (!urls.length) {
    showMessage("Paste at least one Pinterest URL first.", "error");
    return;
  }

  await analyzeAndQueue(urls);
}

function handleExtractUrls() {
  if (state.mode !== "extract") {
    showMessage("Switch to Extract URLs mode to scan pasted text or an imported file.", "info");
    return;
  }

  const extracted = platformApi.extractUrls(elements.extractInput.value);
  state.extractedUrls = extracted.map((url) => ({ id: createLocalId(url), url, selected: true }));

  if (!state.extractedUrls.length) {
    showMessage("No Pinterest pin URLs were detected in the pasted content.", "error");
  } else {
    showMessage(`${state.extractedUrls.length} Pinterest URLs extracted and ready to review.`, "success");
  }

  renderExtractedList();
}

async function addSelectedExtractedUrls() {
  const urls = state.extractedUrls.filter((item) => item.selected).map((item) => item.url);
  if (!urls.length) {
    showMessage("Select at least one extracted URL to add it to the queue.", "error");
    return;
  }
  await analyzeAndQueue(urls);
}

async function analyzeAndQueue(urls) {
  state.isAnalyzing = true;
  renderControls();
  showMessage(`Validating ${urls.length} URL${urls.length === 1 ? "" : "s"} and fetching media details...`, "info");

  try {
    const result = await platformApi.analyzeUrls({ urls });
    mergeQueueItems(result.items);
    const readyCount = result.items.filter((item) => item.directUrl).length;
    const failedCount = result.items.filter((item) => item.status === "Failed").length;

    if (readyCount) {
      showMessage(`Added ${readyCount} media item${readyCount === 1 ? "" : "s"} to the preview queue.${failedCount ? ` ${failedCount} item${failedCount === 1 ? "" : "s"} failed validation.` : ""}`, "success");
    } else {
      showMessage("No downloadable media was found for the submitted URLs.", "error");
    }
  } catch (error) {
    showMessage(`Analysis failed: ${error.message}`, "error");
  } finally {
    state.isAnalyzing = false;
    renderAll();
  }
}

async function startDownload(itemsOverride = null) {
  const selectedItems = (itemsOverride || state.queueItems).filter((item) => item.selected && item.directUrl);
  if (!selectedItems.length) {
    showMessage("Select at least one valid queue item before starting the batch download.", "error");
    return;
  }

  state.isDownloading = true;
  state.progress = { total: selectedItems.length, completed: 0, failed: 0, skipped: 0, remaining: selectedItems.length, speedBps: 0 };

  selectedItems.forEach((item) => {
    const queueItem = findQueueItem(item.id);
    if (queueItem && queueItem.status !== "Saved") {
      queueItem.status = "Pending";
      queueItem.error = null;
      queueItem.savedPath = null;
      queueItem.bytesDownloaded = 0;
    }
  });

  renderAll();

  try {
    const result = await platformApi.startDownloads({
      saveFolder: state.folderPath,
      items: selectedItems,
      settings: collectSettings(),
    });

    state.downloadLog = result.log || [];
    state.latestSummary = result.summary || state.latestSummary;
    showMessage("Batch download finished. Review the summary below or open the folder directly.", "success");
  } catch (error) {
    showMessage(`Download failed: ${error.message}`, "error");
  } finally {
    state.isDownloading = false;
    renderAll();
  }
}

async function retryFailedItems() {
  const failedAnalysis = state.queueItems.filter((item) => item.status === "Failed" && !item.directUrl);
  const failedDownloads = state.queueItems.filter((item) => item.status === "Failed" && item.directUrl);

  if (!failedAnalysis.length && !failedDownloads.length) {
    showMessage("There are no failed items to retry right now.", "info");
    return;
  }

  if (failedAnalysis.length) {
    const urls = [...new Set(failedAnalysis.map((item) => item.sourceUrl).filter(Boolean))];
    state.queueItems = state.queueItems.filter((item) => !(item.status === "Failed" && !item.directUrl));
    await analyzeAndQueue(urls);
  }

  if (failedDownloads.length) {
    failedDownloads.forEach((item) => {
      item.selected = true;
      item.status = "Pending";
      item.error = null;
    });
    await startDownload(failedDownloads);
  }
}

async function selectFolder() {
  const result = await platformApi.selectFolder();
  if (result.canceled) {
    return;
  }
  if (result.error) {
    showMessage(`Could not select folder: ${result.error}`, "error");
    return;
  }
  if (result.unsupported) {
    await refreshEnvironment();
    state.folderPath = await platformApi.getDefaultFolder();
    renderAll();
    showMessage("This browser uses browser-managed downloads instead of direct folder access.", "info");
    return;
  }
  state.folderPath = result.folderPath;
  await refreshEnvironment();
  renderAll();
  showMessage("Save folder updated.", "success");
}

async function openFolder(folderPath) {
  if (!folderPath) {
    showMessage("Choose a folder first.", "error");
    return;
  }
  const result = await platformApi.openFolder(folderPath);
  if (!result.ok) {
    showMessage(`Could not open folder: ${result.error}`, "error");
  }
}

async function importTextFile() {
  const result = await platformApi.importTextFile();
  if (result.canceled) {
    return;
  }
  state.importedFilePath = result.filePath;
  elements.extractInput.value = `${elements.extractInput.value.trim()}\n${result.content}`.trim();
  state.mode = "extract";
  showMessage("Imported file content into extract mode. Run Extract URL to scan it.", "success");
  renderAll();
}

async function exportLog() {
  if (!state.downloadLog.length) {
    showMessage("There is no download log to export yet.", "error");
    return;
  }
  const result = await platformApi.exportLog({ summary: state.latestSummary, log: state.downloadLog });
  if (!result.canceled) {
    showMessage(`Download log exported to ${result.filePath}.`, "success");
  }
}

function handleDownloadEvent(event) {
  if (event.summary) {
    state.progress = event.summary;
    state.latestSummary = {
      total: event.summary.total || 0,
      completed: event.summary.completed || 0,
      failed: event.summary.failed || 0,
      skipped: event.summary.skipped || 0,
    };
  }

  if (event.type === "item-progress") {
    const item = findQueueItem(event.itemId);
    if (item) {
      item.status = event.status;
      item.bytesDownloaded = event.bytesDownloaded || 0;
      item.totalBytes = event.totalBytes || item.fileSize || null;
    }
  }

  if (event.type === "item-status") {
    const item = findQueueItem(event.itemId);
    if (item) {
      item.status = event.status;
      item.error = event.error || null;
      item.savedPath = event.savedPath || null;
      if (typeof event.bytesDownloaded === "number") {
        item.bytesDownloaded = event.bytesDownloaded;
      }
    }
    if (event.logEntry) {
      state.downloadLog = replaceOrAppendLogEntry(state.downloadLog, event.logEntry);
    }
  }

  if (event.type === "queue-start") {
    state.downloadLog = [];
  }
  if (event.type === "queue-complete") {
    state.downloadLog = event.log || state.downloadLog;
  }

  renderAll();
}

function handleTableAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const itemId = button.dataset.id;
  const action = button.dataset.action;
  const item = findQueueItem(itemId);
  if (!item) {
    return;
  }

  if (action === "remove-item") {
    state.queueItems = state.queueItems.filter((entry) => entry.id !== itemId);
    renderAll();
    return;
  }

  if (action === "retry-item") {
    if (item.directUrl) {
      item.selected = true;
      item.status = "Pending";
      item.error = null;
      startDownload([item]);
    } else if (item.sourceUrl) {
      state.queueItems = state.queueItems.filter((entry) => entry.id !== itemId);
      analyzeAndQueue([item.sourceUrl]);
    }
  }
}

function handleTableSelection(event) {
  if (!event.target.matches("[data-select-item]")) {
    return;
  }
  const item = findQueueItem(event.target.dataset.id);
  if (item) {
    item.selected = event.target.checked;
    renderMetrics();
    renderControls();
  }
}

function handleExtractSelection(event) {
  if (!event.target.matches("[data-select-extracted]")) {
    return;
  }
  const extracted = state.extractedUrls.find((item) => item.id === event.target.dataset.id);
  if (extracted) {
    extracted.selected = event.target.checked;
    renderExtractedList();
    renderControls();
  }
}

function handleExtractRemoval(event) {
  const button = event.target.closest("[data-remove-extracted]");
  if (!button) {
    return;
  }
  state.extractedUrls = state.extractedUrls.filter((item) => item.id !== button.dataset.id);
  renderExtractedList();
  renderControls();
}

function updateAllSelection(selected) {
  state.queueItems = state.queueItems.map((item) => (item.directUrl ? { ...item, selected } : item));
  renderAll();
}

function removeSelectedItems() {
  const before = state.queueItems.length;
  state.queueItems = state.queueItems.filter((item) => !item.selected);
  const removed = before - state.queueItems.length;
  renderAll();
  showMessage(`${removed} queue item${removed === 1 ? "" : "s"} removed.`, "success");
}

function mergeQueueItems(items) {
  const existing = new Map(state.queueItems.map((item) => [buildItemKey(item), item]));
  items.forEach((item) => {
    const key = buildItemKey(item);
    const current = existing.get(key);
    existing.set(key, current ? { ...current, ...item, id: current.id } : item);
  });
  state.queueItems = [...existing.values()];
}

function buildItemKey(item) {
  return [item.sourceUrl, item.directUrl || "none", item.index || 1].join("::");
}

function findQueueItem(itemId) {
  return state.queueItems.find((item) => item.id === itemId);
}

function replaceOrAppendLogEntry(log, entry) {
  const key = [entry.sourceUrl, entry.directUrl || "none", entry.status].join("::");
  const index = log.findIndex((row) => [row.sourceUrl, row.directUrl || "none", row.status].join("::") === key);
  if (index === -1) {
    return [...log, entry];
  }
  const next = [...log];
  next[index] = entry;
  return next;
}

function collectSettings() {
  return {
    duplicatePolicy: elements.duplicatePolicy.value,
    concurrency: Number(elements.concurrency.value),
    subfolderByDate: elements.subfolderDate.checked,
    subfolderByBoard: elements.subfolderBoard.checked,
    subfolderByMediaType: elements.subfolderMedia.checked,
    usePinTitle: elements.usePinTitle.checked,
    addDate: elements.addDate.checked,
    customPrefix: elements.customPrefix.value.trim() || "Pinterest",
  };
}

async function refreshEnvironment() {
  if (typeof platformApi.getEnvironment === "function") {
    state.environment = await platformApi.getEnvironment();
  }
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const settings = JSON.parse(raw);
    elements.duplicatePolicy.value = settings.duplicatePolicy || elements.duplicatePolicy.value;
    elements.concurrency.value = String(settings.concurrency || elements.concurrency.value);
    elements.subfolderDate.checked = Boolean(settings.subfolderByDate);
    elements.subfolderBoard.checked = Boolean(settings.subfolderByBoard);
    elements.subfolderMedia.checked = Boolean(settings.subfolderByMediaType);
    elements.usePinTitle.checked = Boolean(settings.usePinTitle);
    elements.addDate.checked = Boolean(settings.addDate);
    elements.customPrefix.value = settings.customPrefix || elements.customPrefix.value;
  } catch {
    // Ignore malformed local settings.
  }
}

function savePreferences() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(collectSettings()));
  } catch {
    // Ignore storage failures.
  }
}

function clearCurrentInput() {
  if (state.mode === "single") {
    elements.singleInput.value = "";
  } else if (state.mode === "multiple") {
    elements.multiInput.value = "";
  } else {
    elements.extractInput.value = "";
    state.extractedUrls = [];
    state.importedFilePath = "";
  }
  clearMessage();
  renderAll();
}

function dedupeLines(text) {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function renderAll() {
  renderMode();
  renderControls();
  renderMessage();
  renderFolder();
  renderExtractedList();
  renderPreviewTable();
  renderProgress();
  renderMetrics();
  renderSummary();
}

function renderMode() {
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
  elements.panes.forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.pane === state.mode);
  });
  elements.importedFileLabel.textContent = state.importedFilePath || "No file imported";
}

function renderControls() {
  const busy = state.isAnalyzing || state.isDownloading;
  elements.findUrlBtn.disabled = busy || state.mode === "extract";
  elements.extractUrlBtn.disabled = busy || state.mode !== "extract";
  elements.addExtractedBtn.disabled = busy || state.mode !== "extract" || !state.extractedUrls.some((item) => item.selected);
  elements.clearInputBtn.disabled = busy;
  elements.importFileBtn.disabled = busy;
  elements.selectFolderBtn.disabled = busy || !state.environment.canSelectFolder;
  elements.selectFolderBtn.hidden = !state.environment.canSelectFolder;
  elements.openFolderBtn.disabled = busy || !state.environment.canOpenFolder;
  elements.openFolderBtn.hidden = !state.environment.canOpenFolder;
  elements.startDownloadBtn.disabled = busy || !state.queueItems.some((item) => item.selected && item.directUrl);
  elements.retryFailedBtn.disabled = busy;
  elements.completionRetryBtn.disabled = busy;
  elements.exportLogBtn.disabled = busy || !state.downloadLog.length;
}

function renderMessage() {
  if (!state.message) {
    elements.messageBanner.className = "message-banner hidden";
    elements.messageBanner.textContent = "";
    return;
  }
  elements.messageBanner.className = `message-banner ${state.message.type}`;
  elements.messageBanner.textContent = state.message.text;
}

function renderFolder() {
  elements.folderPath.textContent = state.folderPath || "No folder selected";
  elements.saveModeBadge.textContent = state.environment.saveModeLabel || "Downloads";
  elements.saveModeBadge.className = `status-pill ${state.environment.saveMode === "direct-folder" ? "saved" : "pending"}`;
  elements.saveCapabilityNote.textContent = state.environment.saveHint || "";
}

function renderExtractedList() {
  const items = state.extractedUrls;
  elements.extractCount.textContent = `${items.length} URL${items.length === 1 ? "" : "s"} detected`;

  if (!items.length) {
    elements.extractedList.className = "extract-list empty";
    elements.extractedList.innerHTML = "<p>No extracted Pinterest URLs yet.</p>";
    return;
  }

  elements.extractedList.className = "extract-list";
  elements.extractedList.innerHTML = items.map((item) => `
    <label class="extract-item">
      <input data-select-extracted data-id="${item.id}" type="checkbox" ${item.selected ? "checked" : ""} />
      <span>${escapeHtml(item.url)}</span>
      <button class="row-btn" data-remove-extracted data-id="${item.id}" type="button">Remove</button>
    </label>
  `).join("");
}

function renderPreviewTable() {
  if (!state.queueItems.length) {
    elements.previewBody.innerHTML = `<tr class="empty-row"><td colspan="8">No Pinterest items queued yet.</td></tr>`;
    return;
  }

  elements.previewBody.innerHTML = state.queueItems.map((item) => `
    <tr>
      <td>
        <input data-select-item data-id="${item.id}" type="checkbox" ${item.selected ? "checked" : ""} ${item.directUrl ? "" : "disabled"} />
      </td>
      <td>
        ${item.thumbnailUrl
          ? `<img class="preview-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.pinTitle)}" />`
          : `<div class="thumb-placeholder">N/A</div>`}
      </td>
      <td class="title-cell">
        <strong>${escapeHtml(item.pinTitle)}</strong>
        <div class="title-meta">${escapeHtml(item.resolution || "Unknown")} ${item.boardName ? `| ${escapeHtml(item.boardName)}` : ""}</div>
        ${item.error ? `<div class="row-subtle">${escapeHtml(item.error)}</div>` : ""}
      </td>
      <td><span class="badge">${escapeHtml(formatMediaLabel(item))}</span></td>
      <td>
        <a class="source-link" href="${escapeHtml(item.normalizedUrl || item.sourceUrl)}" target="_blank" rel="noreferrer">
          ${escapeHtml(item.sourceUrl)}
        </a>
      </td>
      <td>${item.fileSize ? escapeHtml(formatBytes(item.fileSize)) : "-"}</td>
      <td><span class="status-pill ${slugifyStatus(item.status)}">${escapeHtml(item.status)}</span></td>
      <td>
        <div class="row-actions">
          <button class="row-btn" data-action="retry-item" data-id="${item.id}" type="button">Retry</button>
          <button class="row-btn" data-action="remove-item" data-id="${item.id}" type="button">Remove</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderProgress() {
  const summary = state.progress;
  const processed = (summary.completed || 0) + (summary.failed || 0) + (summary.skipped || 0);
  const total = summary.total || 0;
  const percentage = total ? Math.min((processed / total) * 100, 100) : 0;

  elements.progressLabel.textContent = state.isDownloading ? "Batch download in progress" : total ? "Latest batch finished" : "Batch idle";
  elements.progressDetail.textContent = `${processed} of ${total} items processed`;
  elements.progressFill.style.width = `${percentage}%`;
}

function renderMetrics() {
  const queued = state.queueItems.length;
  const selected = state.queueItems.filter((item) => item.selected && item.directUrl).length;
  const saved = state.queueItems.filter((item) => item.status === "Saved").length;
  const failed = state.queueItems.filter((item) => item.status === "Failed").length;

  elements.queueCount.textContent = String(queued);
  elements.queueDetail.textContent = selected ? `${selected} selected for download` : "Nothing selected yet";
  elements.completedCount.textContent = String(saved);
  elements.completedDetail.textContent = `${state.progress.completed || 0} saved in latest batch`;
  elements.failedCount.textContent = String(failed);
  elements.failedDetail.textContent = failed ? "Some items need attention" : "No failed items";
  elements.speedCount.textContent = formatSpeed(state.progress.speedBps || 0);
  elements.remainingCount.textContent = `${state.progress.remaining || 0} remaining`;
}

function renderSummary() {
  elements.summaryTotal.textContent = String(state.latestSummary.total || 0);
  elements.summaryDownloaded.textContent = String(state.latestSummary.completed || 0);
  elements.summaryFailed.textContent = String(state.latestSummary.failed || 0);
  elements.summarySkipped.textContent = String(state.latestSummary.skipped || 0);
}

function showMessage(text, type = "info") {
  state.message = { text, type };
  renderMessage();
}

function clearMessage() {
  state.message = null;
  renderMessage();
}

function createLocalId(seed) {
  const safe = btoa(unescape(encodeURIComponent(seed))).replace(/=/g, "").slice(0, 12);
  return `local-${safe}-${Date.now()}`;
}

function formatMediaLabel(item) {
  return item.containerType === "gallery" && item.mediaType !== "unknown"
    ? `Gallery / ${capitalize(item.mediaType)}`
    : capitalize(item.mediaType || "unknown");
}

function slugifyStatus(status = "") {
  return status.toLowerCase().replace(/\s+/g, "-");
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function capitalize(value = "") {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "";
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
