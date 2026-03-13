const fs = require("fs");
const fsPromises = require("fs/promises");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const { analyzeUrls } = require("./src/pinterest-service");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 4173;
const ROOT_DIR = __dirname;
const RENDERER_DIR = path.join(ROOT_DIR, "renderer");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SERVER_HEADERS = {
  referer: "https://www.pinterest.com/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (requestUrl.pathname === "/api/analyze" && request.method === "POST") {
      await handleAnalyze(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/media" && (request.method === "GET" || request.method === "HEAD")) {
      await handleMediaProxy(requestUrl, request.method, response);
      return;
    }

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
      respondJson(response, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        secureContextNote: "PWAs require HTTPS in production. Localhost is treated as a secure context for development.",
      });
      return;
    }

    await handleStatic(requestUrl.pathname, request.method, response);
  } catch (error) {
    respondJson(response, 500, {
      error: "server_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pinterest Downloader PWA running at http://${HOST}:${PORT}`);
  console.log("For installable production use, serve the same app over HTTPS.");
});

async function handleAnalyze(request, response) {
  const payload = await readJsonBody(request);
  const urls = Array.isArray(payload.urls) ? payload.urls : [];
  const result = await analyzeUrls(urls);
  respondJson(response, 200, result);
}

async function handleMediaProxy(requestUrl, method, response) {
  const target = requestUrl.searchParams.get("url");
  const filename = requestUrl.searchParams.get("filename");

  if (!target) {
    respondJson(response, 400, { error: "missing_url" });
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    respondJson(response, 400, { error: "invalid_url" });
    return;
  }

  if (!/^https?:$/i.test(parsedTarget.protocol)) {
    respondJson(response, 400, { error: "invalid_protocol" });
    return;
  }

  const upstream = await fetch(parsedTarget.toString(), {
    headers: SERVER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });

  response.statusCode = upstream.status;

  const contentType = upstream.headers.get("content-type");
  const contentLength = upstream.headers.get("content-length");
  const disposition = filename ? buildContentDisposition(filename) : null;

  if (contentType) {
    response.setHeader("Content-Type", contentType);
  }
  if (contentLength) {
    response.setHeader("Content-Length", contentLength);
  }
  if (disposition) {
    response.setHeader("Content-Disposition", disposition);
  }
  response.setHeader("Cache-Control", "no-store");

  if (method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }

  await pipeline(Readable.fromWeb(upstream.body), response);
}

async function handleStatic(pathname, method, response) {
  if (!["GET", "HEAD"].includes(method)) {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method Not Allowed");
    return;
  }

  const assetPath = resolveStaticPath(pathname);
  if (!assetPath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }

  const stat = await fsPromises.stat(assetPath);
  const extension = path.extname(assetPath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  fs.createReadStream(assetPath).pipe(response);
}

function resolveStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded === "/") {
    return path.join(RENDERER_DIR, "index.html");
  }

  const cleaned = decoded.replace(/^\/+/, "");
  const candidates = [
    path.join(PUBLIC_DIR, cleaned),
    path.join(RENDERER_DIR, cleaned),
  ];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (!normalized.startsWith(path.normalize(PUBLIC_DIR)) && !normalized.startsWith(path.normalize(RENDERER_DIR))) {
      continue;
    }

    if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
      return normalized;
    }
  }

  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respondJson(response, statusCode, document) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(document));
}

function buildContentDisposition(filename) {
  const safe = filename.replace(/["\r\n]/g, "");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
