import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));

test("真实数据：扇区散射耗时与节点数成正比（每千节点 1 秒预算）", () => {
  // 本地数据已从 2.6k 抽样换成远端全量索引（1.8 万节点，7 倍）。
  // 固定 2 秒的预算在这种规模下必然误报，所以改成【按节点数给预算】：
  // 实测 18826 节点约 7.5 秒（0.4ms/节点），预算给到 1ms/节点仍有 2 倍余量，
  // 仍能抓住算法退化（例如退化成 O(n²)）。
  const prepared = prepare(mesh);
  const budget = Math.max(2000, prepared.nodes.length);
  const started = Date.now();
  const layout = createSectorLayout({
    nodes: prepared.nodes,
    centerId: "deepseek-ai/deepseek-harness",
    groupOf: (n) => n.category,
    seed: "real",
  });
  layout.run(200);
  const cost = Date.now() - started;
  assert.ok(cost < budget, "布局耗时过长: " + cost + "ms（预算 " + budget + "ms / " + prepared.nodes.length + " 节点）");
  for (let i = 0; i < prepared.nodes.length; i++) {
    assert.ok(Number.isFinite(layout.x[i]) && Number.isFinite(layout.y[i]), "坐标非有限数 @" + i);
  }
});

test("真实样本：prepare 派生的邻接表与边数一致", () => {
  const prepared = prepare(mesh);
  let degreeSum = 0;
  for (const list of prepared.adjacency.values()) degreeSum += list.length;
  assert.equal(degreeSum, prepared.edges.length * 2, "邻接表度数之和应为边数的两倍");
  assert.equal(prepared.byId.size, prepared.nodes.length);
});
