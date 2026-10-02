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
import { gzipSync } from "node:zlib";
import { networkInterfaces } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function sendJson(res, data, code = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": body.length,
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

  // 接口路由：只认白名单里的两个，其余 404，绝不落到静态文件逻辑
  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, method, pathname, url);
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
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 20) + '"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache", ...SECURITY_HEADERS });
      res.end();
      console.log("304 " + pathname);
      return;
    }
    const compressible = /^(text\/|application\/(json|javascript))/.test(type);
    const wantsGzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
    let payload = body;
    let encoding;
    if (compressible && wantsGzip && body.length > 1024) {
      payload = gzipSync(body);
      encoding = "gzip";
    }
    const headers = {
      "content-type": type,
      etag,
      "cache-control": "no-cache",
      "content-length": payload.length,
      vary: "accept-encoding",
      ...SECURITY_HEADERS,
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(200, headers);
    if (method === "HEAD") res.end();
    else res.end(payload);
    console.log("200 " + pathname + " (" + payload.length + "B" + (encoding ? " gzip" : "") + ")");
  } catch {
    deny(res, 404, "404 " + pathname);
    console.log("404 " + pathname);
  }
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log("dsh-plugin-mesh 前端原型: http://" + HOST + ":" + actual + "/");
  console.log("白名单路径: /  /index.html  /styles.css  /src/*.js  /data/mesh.json");
  console.log("接口: GET /api/stats  ·  POST /api/ping（访问数 / 同时在线）");
  if (process.env.ALLOW_HOSTS) console.log("额外放行的 Host: " + process.env.ALLOW_HOSTS);
});
