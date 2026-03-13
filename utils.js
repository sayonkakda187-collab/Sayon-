const os = require("os");
const path = require("path");

function getDefaultDownloadFolder() {
  return path.join(os.homedir(), "Downloads", "Pinterest_Downloader");
}

function sanitizeFilename(value, fallback = "untitled") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? cleaned.slice(0, 110) : fallback;
}

function formatDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}

function decodeBoardName(boardUrl = "") {
  const segments = boardUrl.split("/").filter(Boolean);
  const slug = segments[segments.length - 1] || "";
  try {
    return sanitizeFilename(decodeURIComponent(slug).replace(/-/g, " "), "board");
  } catch {
    return sanitizeFilename(slug.replace(/-/g, " "), "board");
  }
}

function extractPinIdFromUrl(urlString = "") {
  try {
    const parsed = new URL(urlString);
    const match = parsed.pathname.match(/\/pin\/(?:[^/]*--)?(\d+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isPinterestHost(hostname = "") {
  return hostname.toLowerCase() === "pin.it" || /(^|\.)pinterest\.[a-z.]+$/i.test(hostname);
}

function uniqueBy(values, selector) {
  const seen = new Set();
  return values.filter((value) => {
    const key = selector(value);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

module.exports = {
  decodeBoardName,
  extractPinIdFromUrl,
  formatDateStamp,
  getDefaultDownloadFolder,
  isPinterestHost,
  sanitizeFilename,
  uniqueBy,
};
