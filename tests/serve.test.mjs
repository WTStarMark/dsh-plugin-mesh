/**
 * 预览服务加固测试：真的把服务起起来，逐条验证白名单、方法、Host 与安全头。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let child;
let base;
let port;

/** fetch 不允许自定义 Host 头（undici 的禁止头），所以用原始 http 请求来测 Host 白名单 */
const rawStatus = (path, headers) =>
  new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolvePromise(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });

let statsDir;

before(async () => {
  // 统计文件写到临时目录，别污染真实计数
  statsDir = mkdtempSync(join(tmpdir(), "dsh-mesh-stats-"));
  child = spawn(process.execPath, ["tools/serve.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", STATS_FILE: join(statsDir, "stats.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    child.stdout.on("data", (buf) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
      if (match) {
        clearTimeout(timer);
        port = Number(match[1]);
        resolvePromise("http://127.0.0.1:" + match[1]);
      }
    });
    child.on("error", reject);
  });
});

after(() => {
  child?.kill();
  if (statsDir) rmSync(statsDir, { recursive: true, force: true });
});

const status = async (path, options = {}) => (await fetch(base + path, options)).status;

test("前端真正需要的资源可访问", async () => {
  for (const path of ["/", "/index.html", "/styles.css", "/src/app.js", "/src/cache.js", "/src/ranking.js", "/data/mesh.json"]) {
    assert.equal(await status(path), 200, path + " 应可访问");
  }
});

test("源码、数据缓存、文档、配置一律 403（不在白名单）", async () => {
  for (const path of [
    "/.env",
    "/.gitignore",
    "/package.json",
    "/README.md",
    "/backend/collect.py",
    "/backend/dsh_mesh/config.py",
    "/tests/app.smoke.test.mjs",
    "/docs/data-contract.md",
    "/data/cache/repos.json",
    "/data/cache/segments.json",
    "/data/last-crawl.json",
    "/data/sample-raw.json",
    "/data/sample-mesh.json",
    "/tools/serve.mjs",
  ]) {
    assert.equal(await status(path), 403, path + " 不应对外提供");
  }
});

test("快照目录不可枚举（含带斜杠与穿越写法）", async () => {
  for (const path of ["/data/snapshots/", "/data/snapshots/x.json", "/data/../.env", "/%2e%2e/.env", "/src/../.env"]) {
    const code = await status(path);
    assert.ok(code === 403 || code === 404, path + " 应为 403/404，实际 " + code);
  }
});

test("只允许 GET / HEAD，其余方法 405", async () => {
  assert.equal(await status("/", { method: "POST" }), 405);
  assert.equal(await status("/data/mesh.json", { method: "DELETE" }), 405);
  assert.equal(await status("/", { method: "HEAD" }), 200);
});

test("Host 白名单挡掉 DNS rebinding", async () => {
  assert.equal(await rawStatus("/", { host: "evil.example.com" }), 403, "伪造 Host 应被拒绝");
  assert.equal(await rawStatus("/", { host: "evil.example.com:8788" }), 403, "带端口的伪造 Host 同样拒绝");
  assert.equal(await rawStatus("/", { host: "127.0.0.1:" + port }), 200, "本机 Host 应放行");
  assert.equal(await rawStatus("/", { host: "localhost:" + port }), 200, "localhost 应放行");
});

test("安全响应头齐备", async () => {
  const res = await fetch(base + "/");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("协商缓存仍然可用（ETag → 304）", async () => {
  const first = await fetch(base + "/styles.css");
  const etag = first.headers.get("etag");
  assert.ok(etag, "应返回 ETag");
  const second = await fetch(base + "/styles.css", { headers: { "if-none-match": etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0);
});

test("访问统计：/api/stats 可读，/api/ping 计数", async () => {
  const before = await (await fetch(base + "/api/stats")).json();
  assert.equal(typeof before.visits, "number");
  assert.equal(typeof before.online, "number");

  const first = await (
    await fetch(base + "/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "testclient01", first: true }),
    })
  ).json();
  assert.equal(first.visits, before.visits + 1, "首次浏览应让访问数 +1");
  assert.equal(first.visitors, before.visitors + 1, "新 id 应让访客数 +1");
  assert.ok(first.online >= 1, "刚心跳过的人应算在线");

  const again = await (
    await fetch(base + "/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "testclient01", first: false }),
    })
  ).json();
  assert.equal(again.visits, first.visits, "同一页面的后续心跳不应重复计访问");
  assert.equal(again.visitors, first.visitors, "老 id 不应重复计访客");
});

test("统计接口的边界与防滥用", async () => {
  const bad = await fetch(base + "/api/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "短", first: true }),
  });
  assert.equal(bad.status, 400, "非法 id 应 400");

  const notJson = await fetch(base + "/api/ping", { method: "POST", body: "不是 JSON" });
  assert.equal(notJson.status, 400, "非 JSON 请求体应 400");

  assert.equal(await status("/api/ping"), 405, "GET /api/ping 应 405");
  assert.equal(await status("/api/stats", { method: "POST" }), 405, "POST /api/stats 应 405");
  assert.equal(await status("/api/secret"), 404, "未知接口应 404");
});

test("统计文件本身绝不对外提供", async () => {
  for (const path of ["/data/stats.json", "/data/stats.json.tmp", "/data/"]) {
    const code = await status(path);
    assert.ok(code === 403 || code === 404, path + " 不应可读，实际 " + code);
  }
});

test("缓存分层：数据永远实时，代码与样式走浏览器缓存", async () => {
  const data = await fetch(base + "/data/mesh.json");
  assert.equal(data.headers.get("cache-control"), "no-store", "mesh.json 必须每次取新的");

  for (const path of ["/src/app.js", "/styles.css", "/index.html"]) {
    const res = await fetch(base + path);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=300/, path + " 应走浏览器缓存");
    assert.ok(res.headers.get("etag"), path + " 应带 ETag 以便 304 校验");
  }
});
