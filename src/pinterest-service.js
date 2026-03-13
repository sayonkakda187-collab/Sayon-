const { randomUUID } = require("crypto");

const {
  decodeBoardName,
  extractPinIdFromUrl,
  isPinterestHost,
  sanitizeFilename,
  uniqueBy,
} = require("./utils");

const PAGE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

function extractPinterestUrls(text = "") {
  const urlMatches = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const cleaned = urlMatches
    .map((value) => value.replace(/[),.;]+$/g, ""))
    .filter((value) => {
      try {
        return isPinterestHost(new URL(value).hostname);
      } catch {
        return false;
      }
    })
    .map((value) => normalizePinterestUrl(value))
    .filter((entry) => entry.ok)
    .map((entry) => entry.url);

  return uniqueBy(cleaned, (value) => value);
}

function normalizePinterestUrl(rawUrl = "") {
  try {
    const initial = rawUrl.trim();
    const parsed = new URL(/^https?:\/\//i.test(initial) ? initial : `https://${initial}`);

    if (!isPinterestHost(parsed.hostname)) {
      return { ok: false, error: "invalid link" };
    }

    parsed.hash = "";
    if (parsed.hostname.toLowerCase() !== "pin.it") {
      const pinId = extractPinIdFromUrl(parsed.toString());
      if (!pinId && !/\/pin\//i.test(parsed.pathname)) {
        return { ok: false, error: "invalid link" };
      }
      if (pinId) {
        parsed.pathname = `/pin/${pinId}/`;
      }
      parsed.search = "";
    }

    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "invalid link" };
  }
}

async function analyzeUrls(urls = []) {
  const normalizedInput = uniqueBy(
    urls.map((value) => String(value || "").trim()).filter(Boolean),
    (value) => value,
  );

  const items = [];
  const bySource = [];

  for (const rawUrl of normalizedInput) {
    const analysis = await analyzeUrl(rawUrl);
    items.push(...analysis.items);
    bySource.push({
      sourceUrl: rawUrl,
      normalizedUrl: analysis.normalizedUrl || null,
      ok: analysis.ok,
      mediaCount: analysis.items.filter((item) => Boolean(item.directUrl)).length,
      error: analysis.error || null,
    });
  }

  return {
    items,
    bySource,
    summary: {
      totalUrls: normalizedInput.length,
      ready: items.filter((item) => item.directUrl).length,
      failed: items.filter((item) => item.status === "Failed").length,
    },
  };
}

async function analyzeUrl(rawUrl) {
  const validation = normalizePinterestUrl(rawUrl);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      items: [buildFailureItem(rawUrl, null, validation.error)],
    };
  }

  try {
    const response = await fetch(validation.url, {
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });

    const finalUrl = response.url || validation.url;
    if (!response.ok) {
      const error = classifyPageError(response.status);
      return {
        ok: false,
        normalizedUrl: finalUrl,
        error,
        items: [buildFailureItem(rawUrl, finalUrl, error)],
      };
    }

    if (!isPinterestHost(new URL(finalUrl).hostname)) {
      return {
        ok: false,
        normalizedUrl: finalUrl,
        error: "invalid link",
        items: [buildFailureItem(rawUrl, finalUrl, "invalid link")],
      };
    }

    const html = await response.text();
    if (/\/login\/?/i.test(finalUrl) || /private pin/i.test(html)) {
      return {
        ok: false,
        normalizedUrl: finalUrl,
        error: "private content",
        items: [buildFailureItem(rawUrl, finalUrl, "private content")],
      };
    }

    const pinId = extractPinIdFromUrl(finalUrl) || extractPinIdFromUrl(validation.url);
    const jsonLd = extractJsonLdBlocks(html);
    const relayPayloads = extractRelayPayloads(html);
    const pinData = findPinData(relayPayloads, pinId);
    const mediaItems = await buildMediaItems({
      pinId,
      rawUrl,
      normalizedUrl: finalUrl,
      pinData,
      jsonLd,
    });

    if (!mediaItems.length) {
      return {
        ok: false,
        normalizedUrl: finalUrl,
        error: "media unavailable",
        items: [buildFailureItem(rawUrl, finalUrl, "media unavailable")],
      };
    }

    return {
      ok: true,
      normalizedUrl: finalUrl,
      items: mediaItems,
    };
  } catch (error) {
    const message = classifyRuntimeError(error);
    return {
      ok: false,
      normalizedUrl: validation.url,
      error: message,
      items: [buildFailureItem(rawUrl, validation.url, message)],
    };
  }
}

async function buildMediaItems(context) {
  const pinData = context.pinData || {};
  const socialPosting = context.jsonLd.find((item) => hasType(item, "SocialMediaPosting")) || {};
  const videoObject = context.jsonLd.find((item) => hasType(item, "VideoObject")) || {};
  const boardName = decodeBoardName(pinData.board && pinData.board.url ? pinData.board.url : "");
  const pinTitle = sanitizeFilename(
    pinData.title ||
      pinData.closeupUnifiedTitle ||
      pinData.seoTitle ||
      socialPosting.headline ||
      videoObject.name ||
      "Pinterest pin",
    "Pinterest pin",
  );
  const createdAt = pinData.createdAt || socialPosting.datePublished || videoObject.uploadDate || null;
  const candidates = [];
  const seenUrls = new Set();

  const pushCandidate = (candidate) => {
    if (!candidate || !candidate.directUrl || seenUrls.has(candidate.directUrl)) {
      return;
    }
    seenUrls.add(candidate.directUrl);
    candidates.push(candidate);
  };

  const storyPages = Array.isArray(pinData.storyPinData && pinData.storyPinData.pages)
    ? pinData.storyPinData.pages
    : [];

  if (storyPages.length) {
    storyPages.forEach((page, index) => {
      extractStoryPageMedia(page, index + 1).forEach(pushCandidate);
    });
  }

  if (pinData.carouselData) {
    extractGenericGalleryMedia(pinData.carouselData).forEach(pushCandidate);
  }

  if (!candidates.length) {
    const preferredVideo = pickPreferredVideo(pinData.videos || pinData.videoList || pinData);
    if (preferredVideo) {
      pushCandidate({
        mediaType: "video",
        directUrl: preferredVideo.url,
        thumbnailUrl: preferredVideo.thumbnail || videoObject.thumbnailUrl || socialPosting.image || null,
        width: preferredVideo.width || null,
        height: preferredVideo.height || null,
        duration: preferredVideo.duration || null,
      });
    }

    if (videoObject.contentUrl) {
      pushCandidate({
        mediaType: "video",
        directUrl: videoObject.contentUrl,
        thumbnailUrl: videoObject.thumbnailUrl || socialPosting.image || null,
        width: parseNumericValue(videoObject.width),
        height: parseNumericValue(videoObject.height),
        duration: videoObject.duration || null,
      });
    }

    const preferredImage = pickBestImage(pinData) || pickBestImage(socialPosting);
    if (preferredImage && !candidates.some((candidate) => candidate.mediaType === "video")) {
      pushCandidate({
        mediaType: "image",
        directUrl: preferredImage.url,
        thumbnailUrl: preferredImage.thumbnail || preferredImage.url,
        width: preferredImage.width || null,
        height: preferredImage.height || null,
      });
    }
  }

  const containerType = candidates.length > 1 ? "gallery" : "single";
  return Promise.all(
    candidates.map(async (candidate, index) => {
      const inspection = await inspectMedia(candidate.directUrl, candidate.mediaType);
      return {
        id: randomUUID(),
        sourceUrl: context.rawUrl,
        normalizedUrl: context.normalizedUrl,
        pinId: context.pinId || "unknown",
        pinTitle,
        boardName,
        createdAt,
        containerType,
        index: index + 1,
        mediaType: candidate.mediaType,
        directUrl: candidate.directUrl,
        thumbnailUrl: candidate.thumbnailUrl || candidate.directUrl,
        resolution: candidate.width && candidate.height ? `${candidate.width} x ${candidate.height}` : "Unknown",
        width: candidate.width || null,
        height: candidate.height || null,
        fileSize: inspection.fileSize,
        fileType: inspection.contentType || inferMimeFromExtension(inspection.extension),
        extension: inspection.extension,
        duration: candidate.duration || null,
        status: "Pending",
        error: null,
        selected: true,
      };
    }),
  );
}

function buildFailureItem(sourceUrl, normalizedUrl, error) {
  return {
    id: randomUUID(),
    sourceUrl,
    normalizedUrl,
    pinId: "unknown",
    pinTitle: "Unavailable pin",
    boardName: "",
    createdAt: null,
    containerType: "single",
    index: 1,
    mediaType: "unknown",
    directUrl: null,
    thumbnailUrl: null,
    resolution: "Unknown",
    width: null,
    height: null,
    fileSize: null,
    fileType: null,
    extension: null,
    duration: null,
    status: "Failed",
    error,
    selected: false,
  };
}

function classifyPageError(statusCode) {
  return statusCode === 403 || statusCode === 404 ? "private content" : "media unavailable";
}

function classifyRuntimeError(error) {
  if (error && error.name === "TimeoutError") {
    return "network timeout";
  }
  const message = String((error && error.message) || "").toLowerCase();
  return message.includes("timeout") ? "network timeout" : "media unavailable";
}

function extractJsonLdBlocks(html) {
  const matches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  return matches
    .map((match) => match[1].trim())
    .map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractRelayPayloads(html) {
  const scriptMatches = [...html.matchAll(/<script[^>]*data-relay-completed-request="true"[^>]*>([\s\S]*?)<\/script>/gi)];
  const payloads = [];

  scriptMatches.forEach((match) => {
    const body = match[1];
    const start = body.indexOf("(");
    const end = body.lastIndexOf(");");
    if (start === -1 || end === -1) {
      return;
    }
    const secondArgument = splitSecondArgument(body.slice(start + 1, end));
    if (!secondArgument) {
      return;
    }
    try {
      payloads.push(JSON.parse(secondArgument));
    } catch {
      // Ignore malformed blocks.
    }
  });

  return payloads;
}

function splitSecondArgument(argsString) {
  let inString = false;
  let escaped = false;
  let quote = "";
  let depth = 0;

  for (let index = 0; index < argsString.length; index += 1) {
    const character = argsString[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        inString = false;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = true;
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) {
      return argsString.slice(index + 1).trim();
    }
  }

  return null;
}

function findPinData(payloads, pinId) {
  const direct = payloads
    .map((payload) => payload && payload.data && payload.data.v3GetPinQueryv2 && payload.data.v3GetPinQueryv2.data)
    .find(Boolean);
  if (direct) {
    return direct;
  }

  let bestNode = null;
  let bestScore = -1;
  payloads.forEach((payload) => {
    walkObject(payload, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }
      const score = scorePinNode(node, pinId);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    });
  });

  return bestNode || {};
}

function scorePinNode(node, pinId) {
  let score = 0;
  if (node.entityId) {
    score += 1;
  }
  if (pinId && node.entityId === pinId) {
    score += 6;
  }
  if (node.images_orig || node.storyPinData || node.videos || node.carouselData || node.images_736x) {
    score += 4;
  }
  if (node.board) {
    score += 1;
  }
  if (node.title || node.closeupUnifiedTitle || node.seoTitle) {
    score += 1;
  }
  return score;
}

function walkObject(node, visitor) {
  if (!node || typeof node !== "object") {
    return;
  }
  visitor(node);
  if (Array.isArray(node)) {
    node.forEach((entry) => walkObject(entry, visitor));
    return;
  }
  Object.values(node).forEach((entry) => walkObject(entry, visitor));
}

function extractStoryPageMedia(page, pageIndex) {
  const found = [];
  const dedupe = new Set();
  const blocks = [];
  let hasVideo = false;

  if (Array.isArray(page.blocks)) {
    blocks.push(...page.blocks);
  }
  if (Array.isArray(page.videoBlocks)) {
    blocks.push(...page.videoBlocks);
  }
  blocks.push(page);

  blocks.forEach((block) => {
    const video = pickPreferredVideo(block && (block.videoDataV2 || block.video || block));
    if (video && !dedupe.has(video.url)) {
      dedupe.add(video.url);
      hasVideo = true;
      found.push({
        mediaType: "video",
        directUrl: video.url,
        thumbnailUrl: video.thumbnail || (pickBestImage(page) && pickBestImage(page).url) || null,
        width: video.width || null,
        height: video.height || null,
        duration: video.duration || null,
        index: pageIndex,
      });
    }
  });

  const image = pickBestImage(page);
  if (!hasVideo && image && !dedupe.has(image.url)) {
    dedupe.add(image.url);
    found.push({
      mediaType: "image",
      directUrl: image.url,
      thumbnailUrl: image.thumbnail || image.url,
      width: image.width || null,
      height: image.height || null,
      index: pageIndex,
    });
  }

  return found;
}

function extractGenericGalleryMedia(node) {
  const results = [];
  const seen = new Set();
  walkObject(node, (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return;
    }

    const video = pickPreferredVideo(entry);
    if (video && !seen.has(video.url)) {
      seen.add(video.url);
      results.push({
        mediaType: "video",
        directUrl: video.url,
        thumbnailUrl: video.thumbnail || null,
        width: video.width || null,
        height: video.height || null,
        duration: video.duration || null,
      });
    }

    const image = pickBestImage(entry);
    if (image && !seen.has(image.url)) {
      seen.add(image.url);
      results.push({
        mediaType: "image",
        directUrl: image.url,
        thumbnailUrl: image.thumbnail || image.url,
        width: image.width || null,
        height: image.height || null,
      });
    }
  });

  return results;
}

function pickPreferredVideo(source) {
  const variants = [];
  walkObject(source, (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return;
    }
    if (typeof entry.url === "string" && /https?:\/\//i.test(entry.url) && /\.(mp4|m3u8)(\?|$)/i.test(entry.url)) {
      variants.push({
        url: entry.url,
        width: entry.width || null,
        height: entry.height || null,
        duration: entry.duration || null,
        thumbnail: entry.thumbnail || null,
      });
    }
  });

  const mp4Variants = variants.filter((entry) => /\.mp4(\?|$)/i.test(entry.url));
  const ranked = (mp4Variants.length ? mp4Variants : variants).sort((left, right) => {
    const leftScore = (left.width || 0) * (left.height || 0);
    const rightScore = (right.width || 0) * (right.height || 0);
    return rightScore - leftScore;
  });

  return ranked[0] || null;
}

function pickBestImage(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const candidates = [];
  const knownImageKeys = ["images_orig", "imageAdjustedSpec_orig", "images_1200x", "images_736x", "images_564x", "images_474x", "images_236x"];
  knownImageKeys.forEach((key, priority) => {
    const value = source[key];
    if (value && typeof value.url === "string") {
      candidates.push({
        url: value.url,
        width: value.width || null,
        height: value.height || null,
        priority,
      });
    }
  });
  if (typeof source.image === "string") {
    candidates.push({ url: source.image, width: null, height: null, priority: 99 });
  }
  if (source.sharedContent && typeof source.sharedContent.url === "string") {
    candidates.push({ url: source.sharedContent.url, width: null, height: null, priority: 98 });
  }
  if (!candidates.length) {
    return null;
  }
  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    const leftScore = (left.width || 0) * (left.height || 0);
    const rightScore = (right.width || 0) * (right.height || 0);
    return rightScore - leftScore;
  })[0];
}

async function inspectMedia(url, mediaType) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const contentLength = Number(response.headers.get("content-length"));
    const contentType = response.headers.get("content-type") || null;
    return {
      fileSize: Number.isFinite(contentLength) ? contentLength : null,
      contentType,
      extension: inferExtension(url, contentType, mediaType),
    };
  } catch {
    return {
      fileSize: null,
      contentType: null,
      extension: inferExtension(url, null, mediaType),
    };
  }
}

function inferExtension(url, contentType, mediaType) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{3,5})$/i);
    if (match) {
      return `.${match[1].toLowerCase()}`;
    }
  } catch {
    // Ignore malformed URLs.
  }

  if (contentType) {
    if (contentType.includes("jpeg")) return ".jpg";
    if (contentType.includes("png")) return ".png";
    if (contentType.includes("webp")) return ".webp";
    if (contentType.includes("mp4")) return ".mp4";
  }
  return mediaType === "video" ? ".mp4" : ".jpg";
}

function inferMimeFromExtension(extension) {
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
  };
  return map[extension] || null;
}

function hasType(node, typeName) {
  const type = node && node["@type"];
  if (Array.isArray(type)) {
    return type.includes(typeName);
  }
  return type === typeName;
}

function parseNumericValue(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const match = value.match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }
  return null;
}

module.exports = {
  analyzeUrls,
  extractPinterestUrls,
  normalizePinterestUrl,
};
