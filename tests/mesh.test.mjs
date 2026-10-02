import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));

test("真实数据：扇区散射能在 2 秒内算完", () => {
  const prepared = prepare(mesh);
  const started = Date.now();
  const layout = createSectorLayout({
    nodes: prepared.nodes,
    centerId: "deepseek-ai/deepseek-harness",
    groupOf: (n) => n.category,
    seed: "real",
  });
  layout.run(200);
  const cost = Date.now() - started;
  assert.ok(cost < 2000, "布局耗时过长: " + cost + "ms");
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
