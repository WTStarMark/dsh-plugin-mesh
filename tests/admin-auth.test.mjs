/**
 * 后台鉴权的两条硬约束（回归）：
 *   ① 并发闸门只挡 CPU，不做时间窗口 —— 正确口令永远不会被人用"故意输错"锁死；
 *   ② 失败计数可观测、可清理（旧实现 f.until 从未赋值，stats.locked 永远是 0）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, hashPassword } from "../tools/admin-auth.mjs";

const PASSWORD = "correct-horse-battery";

test("并发闸门：超出上限的登录快速返回 busy，正确口令随后仍能登录", async () => {
  const auth = createAuth({ secret: await hashPassword(PASSWORD), basePath: "/x/" });
  const attempts = [];
  for (let i = 0; i < 8; i += 1) attempts.push(auth.login("wrong-" + i, "10.0.0.1"));
  const results = await Promise.all(attempts);
  assert.ok(results.some((r) => r.reason === "busy"), "同时挤进来超过并发上限的请求应被快速拒绝");
  const good = await auth.login(PASSWORD, "10.0.0.2");
  assert.equal(good.ok, true, "并发闸门不能把正确口令挡在外面");
  assert.ok(good.csrf, "登录成功要发 CSRF 令牌");
});

test("连续失败：只退避失败路径，正确口令始终可用，stats.locked 如实反映", async () => {
  const auth = createAuth({ secret: await hashPassword(PASSWORD), basePath: "/x/" });
  let last = null;
  for (let i = 0; i < 5; i += 1) last = await auth.login("nope-" + i, "10.0.0.9");
  assert.equal(last.reason, "locked", "连续失败应进入退避（429 + Retry-After）");
  assert.ok(Number(last.retryAfter) > 0);
  assert.equal(auth.stats().locked, 1, "被退避的 IP 数要可观测（旧实现永远 0）");

  const good = await auth.login(PASSWORD, "10.0.0.9");
  assert.equal(good.ok, true, "正确口令必须始终可用：不能被人故意输错锁死");
  assert.equal(auth.stats().locked, 0, "登录成功后失败计数要清掉");
});

test("未配置口令时整体禁用（不给默认可猜入口）", async () => {
  const auth = createAuth({ secret: null, basePath: "/x/" });
  assert.equal(auth.enabled, false);
  assert.equal((await auth.login(PASSWORD, "10.0.0.1")).reason, "disabled");
});
