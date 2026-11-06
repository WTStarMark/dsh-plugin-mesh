/**
 * 大文件并发闸门：全局上限、单 IP 上限、release 幂等。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLargeFileGuard } from "../tools/large-file-guard.mjs";

test("单 IP 上限生效，释放后可再次获取", () => {
  const g = createLargeFileGuard({ globalMax: 4, perIpMax: 1 });
  const a = g.acquire("1.1.1.1");
  assert.equal(a.ok, true);
  assert.equal(g.acquire("1.1.1.1").ok, false, "同 IP 超过上限应拒绝");
  a.release();
  assert.equal(g.acquire("1.1.1.1").ok, true, "释放后应能重新获取");
});

test("全局上限生效，release 幂等", () => {
  const g = createLargeFileGuard({ globalMax: 2, perIpMax: 2 });
  const a = g.acquire("a");
  const b = g.acquire("b");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(g.acquire("c").ok, false, "全局满了应拒绝");
  b.release();
  b.release(); // 重复释放不能把计数减成负数
  assert.deepEqual(g.stats, { active: 1, ips: 1, globalMax: 2, perIpMax: 2 });
});
