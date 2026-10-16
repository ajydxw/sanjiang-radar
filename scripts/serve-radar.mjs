import http from "node:http";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import helmet from "helmet";
import { createAssistantStore, handleAssistantRequest } from "./assistant-questions.mjs";
import { createAdminAuth, handleAdminRequest } from "./admin-auth.mjs";
import { createLikeStore, handleLikesRequest } from "./activity-likes.mjs";
import { publicReadingPage } from "./public-reading.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  // Next/React uses runtime inline layout styles; scripts remain hash restricted.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameSrc: ["'none'"],
};
const securityHeaders = helmet({
  contentSecurityPolicy: { useDefaults: false, directives: DIRECTIVES },
  strictTransportSecurity: false,
  xFrameOptions: { action: "deny" },
  referrerPolicy: { policy: "no-referrer" },
});

export async function createRadarServer({
  root = resolve("out"),
  limits = {},
  log = (entry) => console.warn(JSON.stringify(entry)),
  assistantStore,
  adminAuth,
  likesStore,
} = {}) {
  root = await realpath(root);
  assistantStore ??= await createAssistantStore();
  adminAuth ??= await createAdminAuth();
  likesStore ??= await createLikeStore();
  const budget = {
    requestsPerMinute: 1200,
    burst: 300,
    concurrency: 64,
    connections: 256,
    fileBytes: 16 * 1024 * 1024,
    htmlBytes: 2 * 1024 * 1024,
    ...limits,
  };
  for (const value of Object.values(budget)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid server limit");
  }
  let tokens = budget.burst;
  let tokenTime = performance.now();
  let active = 0;
  let events = {};
  const note = (reason) => { events[reason] = (events[reason] || 0) + 1; };
  const flush = () => {
    if (Object.keys(events).length) log({ event: "radar-security", counts: events });
    events = {};
  };
  const isInside = (file) => {
    const path = relative(root, file);
    return path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
      && !path.split(sep).some((part) => part.startsWith("."));
  };
  const indexPath = await realpath(resolve(root, "index.html"));
  if (!isInside(indexPath)) throw new Error("Invalid export index");
  const index = await open(indexPath);
  try { if (!(await index.stat()).isFile()) throw new Error("Invalid export index"); }
  finally { await index.close(); }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 1000 }, async (req, res) => {
    securityHeaders(req, res, () => {});
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cache-Control", "no-store");
    const reject = (status, reason) => {
      if (reason) note(reason);
      res.setHeader("Connection", "close");
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : http.STATUS_CODES[status]);
    };
    // shortcut: cpolar's visitor-IP headers are unverified; throttle globally, use an edge gateway at larger scale.
    const now = performance.now();
    tokens = Math.min(budget.burst, tokens + (now - tokenTime) * budget.requestsPerMinute / 60000);
    tokenTime = now;
    if (tokens < 1) {
      res.setHeader("Retry-After", String(Math.ceil(60 / budget.requestsPerMinute)));
      reject(429, "rate_limit");
      return;
    }
    tokens -= 1;
    if (active >= budget.concurrency) { reject(503, "busy"); return; }
    active += 1;
    let released = false;
    const release = () => { if (!released) { active -= 1; released = true; } };
    res.once("finish", release);
    res.once("close", release);
    let handle;
    try {
      if (req.rawHeaders.length > 100) { reject(431, "invalid_http"); return; }
      if (!req.url || req.url.length > 2048) { reject(414, "blocked_path"); return; }
      if (!req.url.startsWith("/") || req.url.startsWith("//") || req.url.includes("#")) {
        reject(400, "blocked_path");
        return;
      }
      let pathname;
      try { pathname = decodeURIComponent(req.url.split("?")[0]); }
      catch { reject(400, "blocked_path"); return; }
      if (/[\x00-\x1f\x7f\\:]/.test(pathname) || pathname.split("/").some((part) => part.startsWith("."))) {
        reject(403, "blocked_path");
        return;
      }
      if (await handleAdminRequest(req, res, { auth: adminAuth, store: assistantStore })) return;
      if (await handleAssistantRequest(req, res, assistantStore)) return;
      if (await handleLikesRequest(req, res, likesStore)) return;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        reject(405, "blocked_method");
        return;
      }
      if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) > 0) {
        reject(413, "blocked_body");
        return;
      }
      if (pathname === "/read" || pathname === "/read/") {
        const { status, body } = await publicReadingPage(root);
        if (body.length > budget.htmlBytes) { reject(413, "oversize_file"); return; }
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";
      const candidate = resolve(root, `.${pathname}`);
      if (!isInside(candidate)) { reject(403, "blocked_path"); return; }
      const file = await realpath(candidate);
      if (!isInside(file)) { reject(403, "blocked_path"); return; }
      const type = MIME[extname(file).toLowerCase()];
      if (!type) { reject(403, "blocked_path"); return; }
      handle = await open(file);
      const stat = await handle.stat();
      if (!stat.isFile()) { reject(404); return; }
      if (stat.size > budget.fileBytes || (type.startsWith("text/html") && stat.size > budget.htmlBytes)) {
        reject(413, "oversize_file");
        return;
      }
      let body;
      if (type.startsWith("text/html")) {
        body = await handle.readFile();
        if (body.length > budget.htmlBytes) { reject(413, "oversize_file"); return; }
        const hashes = new Set();
        for (const match of body.toString("utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
          if (match[1]) hashes.add(`'sha256-${createHash("sha256").update(match[1].replace(/\r\n?/g, "\n")).digest("base64")}'`);
          if (hashes.size > 128) { reject(413, "oversize_file"); return; }
        }
        helmet.contentSecurityPolicy({
          useDefaults: false,
          directives: { ...DIRECTIVES, scriptSrc: ["'self'", ...hashes] },
        })(req, res, () => {});
      }
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      res.setHeader("Content-Type", type);
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", stat.mtime.toUTCString());
      res.setHeader("Cache-Control", pathname.startsWith("/_next/static/")
        ? "public, max-age=31536000, immutable" : "no-cache");
      if (req.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.setHeader("Content-Length", body?.length ?? stat.size);
      if (req.method === "HEAD" || stat.size === 0) { res.end(); return; }
      if (body) { res.end(body); return; }
      await pipeline(handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }), res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) reject(404);
      else reject(500, "server_error");
    } finally {
      await handle?.close().catch(() => {});
    }
  });
  const timer = setInterval(flush, 60000);
  timer.unref();
  server.once("close", () => { clearInterval(timer); flush(); });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.timeout = 15000;
  // Reject excess headers explicitly instead of silently hiding Content-Length.
  server.maxHeadersCount = 0;
  server.maxConnections = budget.connections;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (error, socket) => {
    note("invalid_http");
    if (socket.writable) {
      const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\n\r\n`);
    }
  });
  return server;
}

export async function startRadarServer() {
  const port = Number(process.env.RADAR_PREVIEW_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port");
  const host = process.env.RADAR_PREVIEW_HOST || "127.0.0.1";
  const server = await createRadarServer();
  server.listen(port, host, () => console.log(`Preview running on ${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await startRadarServer();
