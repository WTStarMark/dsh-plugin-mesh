#!/usr/bin/env node
/**
 * 静态预览服务（加固版）—— 只暴露"前端跑起来真正需要的东西"。
 *
 * 安全策略：
 *   1. 【路径白名单】只提供 /、/index.html、/styles.css、/src/*.js、/data/mesh.json；
 *      backend/、tests/、docs/、data/cache/、data/snapshots/、README、package.json 一律 403。
 *   2. 【方法白名单】只允许 GET / HEAD，其余 405。
 *   3. 【Host 白名单】只接受本机地址访问，挡掉 DNS rebinding（恶意域名解析到本机 IP）。
 *   4. 【安全响应头】CSP / nosniff / frame-ancestors none / CORP same-origin / no-referrer。
 *   5. 隐藏文件（.env 等）与路径穿越双重拦截。
 *   6. 协商缓存：ETag + 304，并对 JSON/JS/CSS 开 gzip。
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompress, constants } from "node:zlib";
import { promisify } from "node:util";

// 同步压缩会把单线程服务整个卡住：details 分片 250KB 用 q11 要 ~0.5-1s，
// 期间所有请求（连 /api/status 这种 1KB 的）都在排队 —— 表现就是"页面卡一下"。
// 改用异步版：压缩跑在 libuv 线程池里，事件循环不被阻塞。
const brotliAsync = promisify(brotliCompress);
import { networkInterfaces } from "node:os";
import { createApi, apiIndex, validNamePart } from "./api.mjs";
import { renderPreviewSvg, sceneFromCore } from "./preview-svg.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.4.9";
/** 卡片默认去处（线上站点），可用环境变量 SITE_URL 或请求参数 ?link= 覆盖 */
const SITE_URL = process.env.SITE_URL ?? "http://104.129.51.126/";

/** 只接受 http/https 的去处，其余一律回落到默认站点（挡 javascript: 之类） */
function siteFrom(url) {
  const raw = url.searchParams.get("link");
  if (!raw) return SITE_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return SITE_URL;
    // 保留完整路径（可能想导向仓库页/文档页），只做协议与长度校验
    return parsed.href.length <= 300 ? parsed.href : SITE_URL;
  } catch {
    return SITE_URL;
  }
}
const api = createApi({ root: ROOT });
const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 白名单：路径必须逐条匹配才会被提供 */
const ALLOW = [
  { pattern: /^\/$/, file: "index.html" },
  { pattern: /^\/index\.html$/, file: "index.html" },
  { pattern: /^\/styles\.css$/, file: "styles.css" },
  { pattern: /^\/src\/[A-Za-z0-9_.-]+\.js$/, file: null }, // 前端模块
  { pattern: /^\/data\/mesh\.json$/, file: "data/mesh.json" },
  { pattern: /^\/data\/mesh-core\.json$/, file: "data/mesh-core.json" },
  { pattern: /^\/data\/mesh-core\.bin$/, file: "data/mesh-core.bin" },
  { pattern: /^\/data\/mesh-core\.head\.bin$/, file: "data/mesh-core.head.bin" },
  { pattern: /^\/data\/details\/[0-9]+\.json$/, file: null },
];

/** Host 白名单：本机回环 + 本机各网卡地址 + 显式声明的额外域名/IP（ALLOW_HOSTS，逗号分隔）*/
function allowedHosts() {
  const hosts = new Set(["127.0.0.1", "localhost", "::1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.address) hosts.add(info.address);
    }
  }
  for (const extra of String(process.env.ALLOW_HOSTS ?? "").split(",")) {
    const value = extra.trim().toLowerCase();
    if (value) hosts.add(value);
  }
  return hosts;
}
const HOSTS = allowedHosts();

function hostAllowed(header) {
  if (!header) return false;
  let host = String(header).trim().toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else host = host.split(":")[0];
  return HOSTS.has(host);
}

// ---------- 访问统计（同端口最小 API，不额外开端口）----------
const STATS_FILE = process.env.STATS_FILE ?? join(ROOT, "data", "stats.json");
const ONLINE_WINDOW_MS = 45_000; // 45 秒内有心跳算在线
const MAX_SEEN = 20000; // 见过的人最多记这么多，防止文件无限膨胀
const RATE_LIMIT = { windowMs: 60_000, max: 60, hits: new Map() };

function loadStats() {
  try {
    const data = JSON.parse(readFileSync(STATS_FILE, "utf8"));
    if (data && typeof data === "object" && data.seen && typeof data.seen === "object") return data;
  } catch {
    /* 首次运行或文件损坏都从零开始 */
  }
  return { since: new Date().toISOString(), visits: 0, visitors: 0, seen: {} };
}

const stats = loadStats();
let statsTimer = null;

function saveStats() {
  const tmp = STATS_FILE + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(stats), "utf8");
    renameSync(tmp, STATS_FILE); // 原子替换，避免半截文件
  } catch (err) {
    console.error("统计写入失败:", err.message);
  }
}

function scheduleSave() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    saveStats();
  }, 5000); // 最多 5 秒落盘一次，扛得住高频心跳
}

function onlineCount(now) {
  let online = 0;
  for (const stamp of Object.values(stats.seen)) if (now - stamp <= ONLINE_WINDOW_MS) online += 1;
  return online;
}

function pruneSeen(now) {
  const ids = Object.keys(stats.seen);
  if (ids.length <= MAX_SEEN) return;
  ids.sort((a, b) => stats.seen[a] - stats.seen[b]);
  for (const id of ids.slice(0, ids.length - MAX_SEEN)) delete stats.seen[id];
}

function clientIp(req) {
  return String(req.socket.remoteAddress ?? "?");
}

function rateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const entry = RATE_LIMIT.hits.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT.hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    if (RATE_LIMIT.hits.size > 5000) RATE_LIMIT.hits.clear();
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT.max;
}

/**
 * 压缩结果缓存：Brotli q9 对 11MB 的契约要压 ~1 秒，而同一份文件会被多个访客反复请求。
 * 按「路径 + ETag + 编码」缓存最近几份压缩结果，文件一变 ETag 就变，缓存自然失效。
 */
const compressCache = new Map();
const COMPRESS_CACHE_MAX = 8;
function compressCacheGet(pathname, etag, encoding) {
  return compressCache.get(pathname + "|" + etag + "|" + encoding) ?? null;
}
function compressCachePut(pathname, etag, encoding, payload) {
  compressCache.set(pathname + "|" + etag + "|" + encoding, payload);
  while (compressCache.size > COMPRESS_CACHE_MAX) compressCache.delete(compressCache.keys().next().value);
  return payload;
}

function sendJson(res, data, code = 200, extra = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": body.length,
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

/** 只读公开接口：允许跨域，方便别人直接在前端/文档里引用 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" };
const API_CACHE = { "cache-control": "public, max-age=300" };

/**
 * README 预览图：按【当前预计算数据】实时渲染，采集器更新数据后图自己就变。
 * 缓存到 mesh-core.json 的 mtime 变化为止；响应带 ETag + max-age=300，
 * GitHub 的图片代理（camo）会按这个节奏回源，所以 README 里的图最迟 5 分钟跟上。
 */
const previewCache = new Map();
async function previewSvg(theme, size, sample) {
  const file = join(ROOT, "data/mesh-core.json");
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const key = theme + "|" + size + "|" + sample;
  const hit = previewCache.get(key);
  if (hit && hit.mtimeMs === info.mtimeMs) return hit;
  const core = JSON.parse(await readFile(file, "utf8"));
  const svg = renderPreviewSvg(sceneFromCore(core), { theme, size, sample });
  const entry = { svg, etag: '"' + createHash("sha1").update(svg).digest("hex").slice(0, 20) + '"', mtimeMs: info.mtimeMs };
  previewCache.set(key, entry);
  return entry;
}

async function handlePreview(req, res, method, url) {
  if (method !== "GET" && method !== "HEAD") {
    deny(res, 405, "405 只允许 GET / HEAD");
    return;
  }
  const theme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const size = Math.min(2000, Math.max(600, Number(url.searchParams.get("size")) || 1400));
  const sample = Math.min(20000, Math.max(500, Number(url.searchParams.get("sample")) || 6000));
  const entry = await previewSvg(theme, size, sample);
  if (!entry) {
    sendSvg(
      res,
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#0d1524"/><text x="30" y="105" font-family="sans-serif" font-size="16" fill="#8fa3c0">预览数据尚未生成（等待首次预计算）</text></svg>',
      503,
      { "cache-control": "no-store" },
    );
    return;
  }
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, { etag: entry.etag, "cache-control": "public, max-age=300, must-revalidate", ...SECURITY_HEADERS });
    res.end();
    console.log("304 " + url.pathname + " (" + theme + ")");
    return;
  }
  sendSvg(res, entry.svg, 200, {
    etag: entry.etag,
    "cache-control": "public, max-age=300, must-revalidate",
    "access-control-allow-origin": "*",
  });
  console.log("200 " + url.pathname + " (" + theme + ", " + (entry.svg.length / 1024).toFixed(0) + "KB)");
}

function sendSvg(res, svg, code = 200, extra = {}) {
  const body = Buffer.from(svg);
  res.writeHead(code, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-length": body.length,
    ...API_CACHE,
    ...CORS,
    ...SECURITY_HEADERS,
    ...extra, // 调用方可以覆盖缓存策略/ETag（预览图要按数据 mtime 缓存）
  });
  res.end(body);
}

function sendHtml(res, html, code = 200) {
  const body = Buffer.from(html);
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    ...API_CACHE,
    ...CORS,
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readBody(req, limit = 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

async function handleApi(req, res, method, pathname, url) {
  if (rateLimited(req)) {
    sendJson(res, { error: "请求过于频繁" }, 429);
    return;
  }
  if (method === "OPTIONS") {
    res.writeHead(204, { ...CORS, ...SECURITY_HEADERS });
    res.end();
    return;
  }
  // 查询接口一律只读：除访问统计的 /api/ping（POST）外，写方法全部拒绝
  if (pathname !== "/api/ping" && method !== "GET" && method !== "HEAD") {
    sendJson(res, { error: "只读接口，只允许 GET / HEAD" }, 405, CORS);
    return;
  }
  if (pathname === "/api/preview.svg") {
    await handlePreview(req, res, method, url);
    return;
  }
  if (pathname === "/api") {
    sendJson(res, apiIndex(VERSION), 200, { ...API_CACHE, ...CORS });
    return;
  }
  if (pathname === "/api/health") {
    const cats = await api.categories();
    // readme 字段让"README 索引堆了多少"一眼可见（indexed 篇 / diskKB 磁盘 / memoryBytes 检索时的内存）
    const readme = await api.readmeStats().catch(() => null);
    sendJson(
      res,
      { ok: true, version: VERSION, nodes: cats.total, generatedAt: cats.generatedAt, readme, time: new Date().toISOString() },
      200,
      { ...API_CACHE, ...CORS },
    );
    return;
  }
  if (pathname === "/api/status") {
    // 不缓存：圆环要秒级倒计时，采集器也会随时更新进度
    sendJson(res, { ok: true, version: VERSION, ...(await api.status()) }, 200, CORS);
    return;
  }
  if (pathname === "/api/categories") {
    sendJson(res, await api.categories(), 200, { ...API_CACHE, ...CORS });
    return;
  }
  if (pathname === "/api/search") {
    const result = await api.searchIds(url.searchParams);
    sendJson(res, result, 200, { ...API_CACHE, ...CORS });
    return;
  }
  if (pathname === "/api/repos") {
    sendJson(res, await api.search(url.searchParams), 200, { ...API_CACHE, ...CORS });
    return;
  }
  const repoMatch = /^\/api\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (repoMatch) {
    const [, owner, name] = repoMatch;
    if (!validNamePart(owner) || !validNamePart(name)) {
      sendJson(res, { error: "仓库名不合法" }, 400, CORS);
      return;
    }
    const found = await api.one(owner, name);
    if (!found) {
      sendJson(res, { error: "未收录该仓库", id: owner + "/" + name }, 404, CORS);
      return;
    }
    sendJson(res, found, 200, { ...API_CACHE, ...CORS });
    return;
  }
  const cardMatch = /^\/api\/card\/([^/]+)\/([^/]+)\.svg$/.exec(pathname);
  if (cardMatch) {
    const [, owner, name] = cardMatch;
    if (!validNamePart(owner) || !validNamePart(name)) {
      sendJson(res, { error: "仓库名不合法" }, 400, CORS);
      return;
    }
    const svg = await api.cardSvg(owner, name, { theme: url.searchParams.get("theme") === "dark" ? "dark" : "light", site: siteFrom(url) });
    if (!svg) {
      sendSvg(res, '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="150"><rect width="480" height="150" rx="12" fill="#f3f6fc"/><text x="24" y="80" font-family="sans-serif" font-size="14" fill="#5f6b80">未收录该仓库</text></svg>', 404);
      return;
    }
    sendSvg(res, svg);
    return;
  }
  if (pathname === "/api/stats") {
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, { error: "只允许 GET" }, 405);
      return;
    }
    const now = Date.now();
    sendJson(res, { visits: stats.visits, visitors: stats.visitors, online: onlineCount(now), since: stats.since });
    return;
  }
  if (pathname === "/api/ping") {
    if (method !== "POST") {
      sendJson(res, { error: "只允许 POST" }, 405);
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, { error: "请求体过大" }, 413);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, { error: "请求体不是合法 JSON" }, 400);
      return;
    }
    const id = String(payload?.id ?? "");
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
      sendJson(res, { error: "id 不合法" }, 400);
      return;
    }
    const now = Date.now();
    const isNew = !(id in stats.seen);
    if (payload.first === true) stats.visits += 1; // 一次页面浏览算一次访问
    if (isNew) stats.visitors += 1; // 新面孔算一个访客
    stats.seen[id] = now;
    pruneSeen(now);
    scheduleSave();
    sendJson(res, { visits: stats.visits, visitors: stats.visitors, online: onlineCount(now), since: stats.since, fresh: isNew });
    return;
  }
  sendJson(res, { error: "未知接口" }, 404);
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

function deny(res, code, reason) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS }).end(reason);
}

const server = createServer(async (req, res) => {
  const method = (req.method ?? "GET").toUpperCase();
  // Host 校验对静态与接口一视同仁，先做
  if (!hostAllowed(req.headers.host)) {
    deny(res, 403, "403 Host 不在允许列表（只接受本机地址访问）");
    console.log("403 " + req.url + " (host=" + req.headers.host + ")");
    return;
  }

  const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/") && pathname !== "/") pathname = pathname.slice(0, -1);

  // README 预览图：实时按当前数据渲染（静态白名单之外，单独一条路由）
  if (pathname === "/preview.svg") {
    await handlePreview(req, res, method, url);
    return;
  }
  // 接口路由：只认白名单里的两个，其余 404，绝不落到静态文件逻辑
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    await handleApi(req, res, method, pathname, url);
    return;
  }
  // 卡片分享页：/card/:owner/:name（同样是只读、同端口）
  const pageMatch = /^\/card\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (pageMatch) {
    const [, owner, name] = pageMatch;
    if (method !== "GET" && method !== "HEAD") {
      deny(res, 405, "405 只允许 GET / HEAD");
      return;
    }
    if (!validNamePart(owner) || !validNamePart(name)) {
      deny(res, 400, "400 仓库名不合法");
      return;
    }
    const html = await api.cardPage(owner, name, "http://" + (req.headers.host ?? "localhost"), { site: siteFrom(url) });
    if (!html) {
      deny(res, 404, "404 未收录该仓库");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...CORS,
      ...SECURITY_HEADERS,
    });
    res.end(html);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    deny(res, 405, "405 只允许 GET / HEAD");
    console.log("405 " + method + " " + req.url);
    return;
  }

  // 隐藏文件与路径穿越
  if (pathname.split("/").some((seg) => seg.startsWith("."))) {
    deny(res, 403, "403 隐藏文件不对外提供");
    console.log("403 " + pathname + " (hidden)");
    return;
  }

  const rule = ALLOW.find((item) => item.pattern.test(pathname));
  if (!rule) {
    deny(res, 403, "403 该路径不在白名单内");
    console.log("403 " + pathname + " (not allowlisted)");
    return;
  }
  const relative = rule.file ?? pathname.slice(1);
  const filePath = resolve(join(ROOT, normalize(relative)));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    deny(res, 403, "403 非法路径");
    console.log("403 " + pathname + " (escape)");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      deny(res, 403, "403 只提供文件");
      return;
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    // 缓存分两层：数据（mesh.json）永远实时；代码与样式走浏览器缓存 + 304 校验
    const cacheControl = pathname === "/data/mesh.json" ? "no-store" : "public, max-age=300, must-revalidate";
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 20) + '"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": cacheControl, ...SECURITY_HEADERS });
      res.end();
      console.log("304 " + pathname);
      return;
    }
    // 二进制契约（.bin）本身已经很紧凑，但 Brotli 仍能再省一点，一并压
    const compressible = /^(text\/|application\/(json|javascript|octet-stream))/.test(type) || /mesh-core.*\.bin$/.test(pathname);
    const accept = String(req.headers["accept-encoding"] ?? "");
    let payload = body;
    let encoding;
    if (compressible && body.length > 1024) {
      // 优先 Brotli（JSON 比 gzip 再省 15~20%），不支持的客户端回落 gzip
      if (/\bbr\b/.test(accept)) {
        // Brotli 是同步压缩，会把整个服务卡住 —— 按体积分档：
        //   <512KB  q11（首屏主干 250KB → 98KB，压缩 ~0.5s）
        //   <2MB    q9 （整份二进制 1.4MB → 601KB，~0.3s）
        //   更大    直接 gzip（11MB 的 JSON 用 q11 要 21 秒，不能这么干）
        const quality = body.length < 512 * 1024 ? 11 : body.length < 2 * 1024 * 1024 ? 9 : 5;
        const cached = quality ? compressCacheGet(pathname, etag, "br") : null;
        if (quality) {
          payload =
            cached ??
            compressCachePut(
              pathname,
              etag,
              "br",
              await brotliAsync(body, {
                params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
              }),
            );
          encoding = "br";
        } else if (/\bgzip\b/.test(accept)) {
          payload = gzipSync(body);
          encoding = "gzip";
        }
      } else if (/\bgzip\b/.test(accept)) {
        payload = gzipSync(body);
        encoding = "gzip";
      }
    }
    const headers = {
      "content-type": type,
      etag,
      "cache-control": cacheControl,
      "content-length": payload.length,
      vary: "accept-encoding",
      ...SECURITY_HEADERS,
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(200, headers);
    if (method === "HEAD") res.end();
    else res.end(payload);
    console.log("200 " + pathname + " (" + payload.length + "B" + (encoding ? " " + encoding : "") + ")");
  } catch {
    deny(res, 404, "404 " + pathname);
    console.log("404 " + pathname);
  }
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log("dsh-plugin-mesh 前端原型: http://" + HOST + ":" + actual + "/");
  console.log("白名单路径: /  /index.html  /styles.css  /src/*.js  /data/mesh.json");
  console.log("接口: GET /api · /api/health · /api/categories · /api/repos · /api/repos/:owner/:name");
  console.log("      GET /api/card/:owner/:name.svg（卡片）· /card/:owner/:name（分享页）");
  console.log("      GET /api/stats · POST /api/ping（访问数 / 同时在线）");
  if (process.env.ALLOW_HOSTS) console.log("额外放行的 Host: " + process.env.ALLOW_HOSTS);
});
