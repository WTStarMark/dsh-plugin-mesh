/**
 * 公开重接口的两个回归：
 *   ① /market/index.json 以前不限流、也不缓存压缩结果（每次请求都重压 5.6MB），现在要带限流头 + ETag/304；
 *   ② /api/preview.svg 与 /preview.svg 必须只扣一次令牌（以前走通用闸门 + handlePreview 各扣一次，成本 6）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let child;
let base;
let statsDir;

before(async () => {
  statsDir = mkdtempSync(join(tmpdir(), "dsh-mesh-market-"));
  child = spawn(process.execPath, ["tools/serve.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      STATS_FILE: join(statsDir, "stats.json"),
      RATE_LIMIT_MAX: "100",
      RATE_LIMIT_REFILL: "0.01",
      REVIEWS_SITE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    child.stdout.on("data", (buf) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
      if (match) {
        clearTimeout(timer);
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

test("市场索引：OPTIONS 预检回 204", async () => {
  const res = await fetch(base + "/market/index.json", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("市场索引：带限流头与 ETag，支持 304", async (t) => {
  const res = await fetch(base + "/market/index.json", { headers: { "accept-encoding": "br" } });
  if (res.status === 404) {
    t.skip("CI 干净克隆没有 dist/market/index.json，这条在本地验证");
    return;
  }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-ratelimit-cost"), "2", "市场索引是重接口，要按 2 个令牌计");
  assert.ok(Number(res.headers.get("x-ratelimit-remaining")) >= 0, "要带剩余额度");
  const etag = res.headers.get("etag");
  assert.ok(etag, "要带 ETag（DSH 客户端重复拉取时可以 304）");
  const again = await fetch(base + "/market/index.json", {
    headers: { "if-none-match": etag, "accept-encoding": "br" },
  });
  assert.equal(again.status, 304, "带 If-None-Match 应回 304");
});

test("预览图两个入口只扣一次令牌（成本 3）", async () => {
  const one = await fetch(base + "/preview.svg");
  assert.equal(one.status, 200);
  assert.equal(one.headers.get("x-ratelimit-cost"), "3");
  const left1 = Number(one.headers.get("x-ratelimit-remaining"));
  const two = await fetch(base + "/api/preview.svg");
  assert.equal(two.status, 200);
  assert.equal(two.headers.get("x-ratelimit-cost"), "3");
  const left2 = Number(two.headers.get("x-ratelimit-remaining"));
  // 回填 0.01/秒可忽略：一次请求应净扣 3 个令牌（以前 /api 入口会扣 6）
  assert.equal(left1 - left2, 3, "两个入口成本必须一致，不能双扣：left1=" + left1 + " left2=" + left2);
});
