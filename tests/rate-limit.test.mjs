/**
 * 限流测试：令牌桶、成本权重、标准头部、429 退避、伪造 XFF 不能绕过。
 *
 * 用独立的小额度服务（容量 6、回填 2/秒），与 tests/serve.test.mjs 那份默认额度互不干扰。
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
  statsDir = mkdtempSync(join(tmpdir(), "dsh-mesh-rate-"));
  child = spawn(process.execPath, ["tools/serve.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      STATS_FILE: join(statsDir, "stats.json"),
      RATE_LIMIT_MAX: "6",
      RATE_LIMIT_REFILL: "2",
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

test("每个 /api 响应都带标准限流头，且成本按接口权重扣", async () => {
  const health = await fetch(base + "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-ratelimit-limit"), "6", "限额要如实告诉调用方");
  assert.equal(health.headers.get("x-ratelimit-cost"), "1", "健康检查是轻接口");
  const before = Number(health.headers.get("x-ratelimit-remaining"));

  const ranking = await fetch(base + "/api/ranking?limit=1");
  assert.equal(ranking.status, 200);
  assert.equal(ranking.headers.get("x-ratelimit-cost"), "5", "榜单接口要按 5 个令牌计（它要读 mesh + 快照环 + 更新日志 + 版本缓存）");
  const after = Number(ranking.headers.get("x-ratelimit-remaining"));
  assert.ok(before - after >= 5, "重接口要扣得更多：before=" + before + " after=" + after);
});

test("额度打满 → 429 + Retry-After；退避后恢复（令牌桶会回填）", async () => {
  // 上面那条已经把桶用到接近空，这里继续打满（同 IP 共用同一个桶）
  let last;
  for (let i = 0; i < 20; i++) {
    last = await fetch(base + "/api/health");
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, "打满后应返回 429");
  assert.equal(last.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(Number(last.headers.get("retry-after")) >= 1, "429 必须给 Retry-After（秒），实际 " + last.headers.get("retry-after"));
  const body = await last.json();
  assert.match(body.error, /频繁/);
  assert.ok(body.retryAfter >= 1, "响应体也要带 retryAfter：" + JSON.stringify(body));

  // 回填 2/秒 → 等 1.2 秒应该又能拿到额度（证明是"限流"不是"封禁"）
  await new Promise((r) => setTimeout(r, 1200));
  const recovered = await fetch(base + "/api/health");
  assert.equal(recovered.status, 200, "退避后应恢复（限流不是封禁）");
  assert.ok(Number(recovered.headers.get("x-ratelimit-remaining")) >= 0);
});

test("预检不扣令牌；伪造 X-Forwarded-For 不能绕过（默认只信 socket 地址）", async () => {
  const pre = await fetch(base + "/api/health", { method: "OPTIONS" });
  assert.equal(pre.status, 204, "OPTIONS 应回 204");
  assert.equal(pre.headers.get("x-ratelimit-cost"), null, "预检不该扣令牌");

  // 每次伪造一个不同的 XFF：默认不信任代理头，额度仍按 socket IP 算 → 依旧会被限住
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(base + "/api/health", { headers: { "x-forwarded-for": "10.0.0." + i } });
    if (res.status === 429) {
      got429 = true;
      break;
    }
  }
  assert.ok(got429, "伪造 XFF 不该绕过限流（要挂反向代理请设 TRUST_PROXY=1 并自行清洗该头）");
});
