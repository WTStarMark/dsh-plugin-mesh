/**
 * 预览服务加固测试：真的把服务起起来，逐条验证白名单、方法、Host 与安全头。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request, createServer } from "node:http";
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
    // 显式清空评测联动配置：主服务的测试不能依赖开发机 .env，也不该外呼
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", STATS_FILE: join(statsDir, "stats.json"), REVIEWS_SITE_URL: "", REVIEWS_ALLOW_HTTP: "" },
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
  // 卡片把作者头像内联成 data URI；img-src 不放行 data: 的话浏览器会画裂图
  assert.match(csp, /img-src[^;]*data:/, "img-src 必须放行 data:（卡片头像）");
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

test("预览图不带参数时落默认档位 1400，而不是最小档 600", async () => {
  // 回归：snapTo() 曾把"没带参数"（Number(null) === 0）当成"用户选了 0"，就近取档落到 600/500，
  // 声明的默认值 1400/6000 永远用不上 —— README 预览图因此变成 600px 的小图，标签全挤在一起。
  const res = await fetch(base + "/preview.svg");
  assert.equal(res.status, 200, "预览图应能渲染（夹具数据必须已生成）");
  const svg = await res.text();
  assert.match(svg, /<svg[^>]*width="1400" height="1400"/, "缺 size 参数应落默认 1400");
  assert.doesNotMatch(svg, /width="600" height="600"/, "不应再退回最小档 600");

  // 显式指定仍然生效，且是同一张图的不同分辨率
  const small = await (await fetch(base + "/preview.svg?size=600")).text();
  assert.match(small, /<svg[^>]*width="600" height="600"/, "显式 size=600 应生效");
  assert.match(small, /font-size="9"/, "600 画布上的扇区标签字号应缩放为 21×0.43");

  // 主题参数不受影响
  const light = await (await fetch(base + "/preview.svg?theme=light")).text();
  assert.match(light, /<rect width="1400" height="1400" fill="#f6faff"/, "浅色主题底色");
});

test("多节点与倡议书：/api/nodes 回公开投影，/api/manifesto 回可编辑内容", async () => {
  const nodes = await (await fetch(base + "/api/nodes")).json();
  assert.equal(typeof nodes.enabled, "boolean");
  assert.ok(Array.isArray(nodes.nodes));
  for (const node of nodes.nodes) {
    assert.equal(typeof node.id, "string");
    assert.equal("probe" in node, false, "公开投影不能带探针配置");
  }
  const manifesto = await (await fetch(base + "/api/manifesto")).json();
  assert.equal(typeof manifesto.title, "string");
  assert.ok(Array.isArray(manifesto.pages) && manifesto.pages.length >= 1);
  assert.equal(typeof manifesto.pages[0].html, "string");
});

test("访问统计：raw=1 只回本节点原始计数（不带聚合明细）", async () => {
  const local = await (await fetch(base + "/api/stats?raw=1")).json();
  assert.equal(typeof local.visits, "number");
  assert.equal(typeof local.online, "number");
  assert.equal(typeof local.since, "string");
  assert.equal(local.aggregated, undefined, "raw=1 不能被聚合逻辑污染");
  assert.equal(local.nodes, undefined);
});

/* ---------- 评测联动：/api/review-nodes（stub 上游 + 真起服务） ---------- */

const reviewUuid = (n) => ("0000000" + Number(n).toString(16)).slice(-8) + "-1111-7000-8000-000000000000";
const REVIEW_REAL_REPO = "deepseek-ai/deepseek-harness"; // mesh 里一定有（圆心）
const REVIEW_FAKE_REPO = "no-such-owner/no-such-repo-xyz"; // mesh 里一定没有（用来验 unmatched）

/** 本地 stub 评测站：固定分页结构；delayMs 用来验证「冷启动不阻塞」，broken 用来验证坏结构降级 */
function startStubReviews({ delayMs = 0, broken = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            broken
              ? { ok: false, error: "upstream broken" }
              : {
                  ok: true,
                  data: {
                    items: [
                      { pluginId: reviewUuid(1), pluginPath: ".", repositoryFullName: REVIEW_REAL_REPO, publicReviewCount: 3 },
                      { pluginId: reviewUuid(2), pluginPath: "packages/x", repositoryFullName: REVIEW_FAKE_REPO, publicReviewCount: 1 },
                    ],
                    page: 1,
                    page_size: 50,
                    total: 2,
                    total_pages: 1,
                    has_next: false,
                    has_previous: false,
                  },
                },
          ),
        );
      }, delayMs);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

/** 单独起一个 serve（带评测配置），返回 { proc, base, statsFile } */
function spawnServe(env = {}) {
  return new Promise((resolvePromise, reject) => {
    const statsFile = join(tmpdir(), "dsh-mesh-stats-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".json");
    const proc = spawn(process.execPath, ["tools/serve.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", STATS_FILE: statsFile, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("服务启动超时"));
    }, 10000);
    proc.stdout.on("data", (buf) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
      if (!match) return;
      clearTimeout(timer);
      resolvePromise({ proc, base: "http://127.0.0.1:" + match[1], statsFile });
    });
    proc.on("error", reject);
  });
}

async function waitFor(check, label, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("等待" + label + "超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function stopStubServer(proc, statsFile, stub) {
  try {
    proc?.kill();
  } catch {
    /* 已退出 */
  }
  if (statsFile) {
    try {
      rmSync(statsFile, { force: true });
    } catch {
      /* 忽略 */
    }
  }
  try {
    stub?.close();
  } catch {
    /* 忽略 */
  }
}

test("评测联动：未配置时端点关闭（不外呼），health 给出 review 概览", async () => {
  const body = await (await fetch(base + "/api/review-nodes")).json();
  assert.equal(body.enabled, false);
  assert.equal(body.count, 0);
  assert.ok(Array.isArray(body.ids));
  assert.ok(body.error, "关闭态应说明原因");
  const health = await (await fetch(base + "/api/health")).json();
  assert.equal(health.review.enabled, false);
  assert.equal(health.review.count, 0);
  assert.equal(health.review.matched, 0);
});

test("评测联动：冷启动不阻塞、形状正确、health 分清 matched/unmatched", async () => {
  const stub = await startStubReviews({ delayMs: 400 });
  const { proc, base: reviewBase, statsFile } = await spawnServe({
    REVIEWS_SITE_URL: "http://127.0.0.1:" + stub.address().port,
    REVIEWS_ALLOW_HTTP: "1",
  });
  try {
    // 冷启动：预热在后台跑，请求必须立刻返回（不能等上游分页）
    const started = Date.now();
    const cold = await (await fetch(reviewBase + "/api/review-nodes")).json();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, "冷启动请求不能等待上游（实测 " + elapsed + "ms）");
    assert.equal(cold.ok, false, "首拉完成前不应假装有数据");
    assert.equal(typeof cold.loading, "boolean");

    const ready = await waitFor(async () => {
      const snap = await (await fetch(reviewBase + "/api/review-nodes")).json();
      return snap.ok ? snap : null;
    }, "评测数据就绪");

    assert.equal(ready.enabled, true);
    assert.equal(ready.stale, false);
    assert.equal(ready.expired, false);
    assert.equal(ready.count, 2);
    assert.equal(ready.reviews, 4);
    assert.deepEqual(ready.ids, [REVIEW_REAL_REPO, REVIEW_FAKE_REPO].sort((a, b) => a.localeCompare(b)));
    assert.equal(ready.byId[REVIEW_REAL_REPO].count, 3);
    assert.equal(
      ready.byId[REVIEW_REAL_REPO].url,
      "http://127.0.0.1:" + stub.address().port + "/plugins/" + reviewUuid(1),
      "主插件应落插件测评页",
    );
    assert.ok(Date.parse(ready.fetchedAt) > 0, "fetchedAt 应是可解析的时间");

    const res = await fetch(reviewBase + "/api/review-nodes");
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("x-ratelimit-cost"), "1");

    const health = await (await fetch(reviewBase + "/api/health")).json();
    assert.equal(health.review.count, 2);
    assert.equal(health.review.matched, 1, "只有 mesh 里存在的仓库算 matched");
    assert.equal(health.review.unmatched, 1);
    assert.deepEqual(health.review.unmatchedIds, [REVIEW_FAKE_REPO]);
    assert.equal(health.review.reviews, 4);
    assert.equal(typeof health.review.ageSeconds, "number");
  } finally {
    stopStubServer(proc, statsFile, stub);
  }
});

test("评测联动：上游坏结构不 500，端点仍 200 并如实标错误", async () => {
  const stub = await startStubReviews({ broken: true });
  const { proc, base: reviewBase, statsFile } = await spawnServe({
    REVIEWS_SITE_URL: "http://127.0.0.1:" + stub.address().port,
    REVIEWS_ALLOW_HTTP: "1",
  });
  try {
    const body = await waitFor(async () => {
      const snap = await (await fetch(reviewBase + "/api/review-nodes")).json();
      return !snap.loading && snap.error ? snap : null;
    }, "坏结构失败被记录");
    assert.equal(body.enabled, true);
    assert.equal(body.ok, false);
    assert.match(body.error, /接口结构变化/);
    assert.equal((await fetch(reviewBase + "/api/review-nodes")).status, 200);
    const health = await (await fetch(reviewBase + "/api/health")).json();
    assert.equal(health.review.ok, false);
    assert.ok(health.review.error);
  } finally {
    stopStubServer(proc, statsFile, stub);
  }
});
