/**
 * 改名去重测试（0.4.4）：
 * GitHub 改名后 full_name 变了、数字 id 不变。图数据以 full_name 为键，
 * 于是改名前后会各留一个球。这里守住判定链：同 id 必合并、同作者+同创建时间才去核对、
 * 认不出的不动、就地改名不与其他节点撞 id。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSuspects, planRenames } from "../tools/dedupe-renames.mjs";

const node = (id, owner, createdAt, extra = {}) => ({
  id,
  owner,
  createdAt,
  pushedAt: "2026-02-01T00:00:00Z",
  stars: 3,
  ...extra,
});

test("嫌疑分组：只挑「同 githubId」和「同作者+同创建时间」两类", () => {
  const nodes = [
    node("u/a", "u", "2026-01-01T00:00:00Z"),
    node("u/b", "u", "2026-01-01T00:00:00Z"),
    node("u/solo", "u", "2026-04-04T00:00:00Z"),
    node("v/dup", "v", "2026-05-05T00:00:00Z", { githubId: 99 }),
    node("v/dup2", "v", "2026-05-05T00:00:00Z", { githubId: 99 }),
  ];
  const s = findSuspects(nodes);
  assert.deepEqual([...s.suspectIds].sort(), ["u/a", "u/b", "v/dup", "v/dup2"]);
  assert.equal(s.sameId.length, 1, "同 githubId 的组应被单独识别");
  assert.ok(!s.suspectIds.has("u/solo"), "独苗不该进嫌疑池（否则要对全图发请求）");
});

test("同一数字 id 的两个名字 → 合并：保留当前名字那条", async () => {
  const nodes = [
    node("u/old-name", "u", "2026-01-01T00:00:00Z"),
    node("u/new-name", "u", "2026-01-01T00:00:00Z"),
  ];
  const resolve = async () => ({ githubId: 7, fullName: "u/new-name" });
  const plan = await planRenames(nodes, resolve);
  assert.deepEqual(plan.drops, ["u/old-name"]);
  assert.deepEqual(plan.renames, [{ from: "u/old-name", to: "u/new-name", githubId: 7 }]);
  assert.equal(plan.updates.length, 0, "有重复时走合并，不该再就地改名");
});

test("同作者同秒创建的不同仓库 → 不动（数字 id 不同）", async () => {
  const nodes = [node("u/a", "u", "2026-01-01T00:00:00Z"), node("u/b", "u", "2026-01-01T00:00:00Z")];
  const plan = await planRenames(nodes, async (n) => ({ githubId: n.id === "u/a" ? 11 : 12, fullName: n.id }));
  assert.deepEqual(plan.drops, []);
  assert.deepEqual(plan.updates, []);
});

test("只有旧名字在数据里 → 就地改名（不删节点）", async () => {
  const nodes = [node("u/a", "u", "2026-01-01T00:00:00Z"), node("u/b", "u", "2026-01-01T00:00:00Z")];
  const plan = await planRenames(nodes, async (n) =>
    n.id === "u/a" ? { githubId: 7, fullName: "u/a-renamed" } : { githubId: 8, fullName: "u/b" },
  );
  assert.deepEqual(plan.updates, [{ from: "u/a", to: "u/a-renamed", githubId: 7 }]);
  assert.deepEqual(plan.drops, []);
});

test("目标名字已被别的节点占用 → 不就地改名（避免撞 id）", async () => {
  const nodes = [
    node("u/a", "u", "2026-01-01T00:00:00Z"),
    node("u/b", "u", "2026-01-01T00:00:00Z"),
    node("u/taken", "u", "2026-07-07T00:00:00Z"),
  ];
  const plan = await planRenames(nodes, async (n) =>
    n.id === "u/a" ? { githubId: 7, fullName: "u/taken" } : { githubId: 8, fullName: n.id },
  );
  assert.deepEqual(plan.updates, []);
});

test("认不出（404/限流）时不动手，但如实记账", async () => {
  const nodes = [node("u/a", "u", "2026-01-01T00:00:00Z"), node("u/b", "u", "2026-01-01T00:00:00Z")];
  const plan = await planRenames(nodes, async () => null);
  assert.deepEqual(plan.drops, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.unresolved.sort(), ["u/a", "u/b"]);
});
