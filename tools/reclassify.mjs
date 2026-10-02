#!/usr/bin/env node
/**
 * 就地重分类：用新的规则表重新给 data/mesh.json 的节点打分类，节点集合完全不动。
 *
 * 用途：分类规则改进后，不必重新采集就能让本地数据用上新算法。
 * 只改 category* 字段、meta.categories、clusters；连线与节点集合保持不变。
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCategories, DEFAULT_OPTIONS } from "./categories.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(ROOT, "data/mesh.json");

const mesh = JSON.parse(await readFile(FILE, "utf8"));
const before = new Map(mesh.nodes.map((n) => [n.id, n.category]));
const nodeCount = mesh.nodes.length;

const stats = applyCategories(mesh.nodes, { ...DEFAULT_OPTIONS });

const moves = new Map();
for (const node of mesh.nodes) {
  const from = before.get(node.id);
  const to = node.category;
  if (from !== to) {
    const key = String(from) + " → " + String(to);
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }
}

mesh.meta.categories = {
  classified: stats.classified,
  unclassified: stats.unclassified,
  minCount: 10,
  maxSectors: 18,
  merged: stats.merged,
  distribution: stats.counts,
};
mesh.clusters = stats.counts.map((c) => ({ id: c.id, label: c.label, count: c.count }));

await writeFile(FILE, JSON.stringify(mesh), "utf8");

if (mesh.nodes.length !== nodeCount) {
  console.error("节点数发生变化，这是不允许的！");
  process.exit(1);
}
console.log("节点数（应保持不变）:", mesh.nodes.length);
console.log("归类:", stats.classified, "| 未分类:", stats.unclassified);
console.log("扇区分布:", stats.counts.map((c) => c.id + "(" + c.count + ")").join(" "));
console.log("分类发生变化的节点:", [...moves.values()].reduce((a, b) => a + b, 0));
const top = [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [key, count] of top) console.log("   " + key.padEnd(28) + count);
