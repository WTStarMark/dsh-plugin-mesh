#!/usr/bin/env node
/**
 * 用前端规则重新分类 mesh.json（离线、可重复），并同步 mesh.clusters。
 * 用于规则升级后一次性刷新存量数据；采集器后续轮次会用同一套 Python 规则。
 *
 * 用法：node tools/reclassify-mesh.mjs [--in data/mesh.json] [--out data/mesh.json] [--backup .tmp/mesh-before-classify.json]
 */

import { readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCategories } from "./categories.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const IN = resolve(ROOT, argOf("--in", "data/mesh.json"));
const OUT = resolve(ROOT, argOf("--out", "data/mesh.json"));
const BACKUP = resolve(ROOT, argOf("--backup", ".tmp/mesh-before-classify.json"));
const MAX_SECTORS = Math.max(20, Number(argOf("--max-sectors", "24")));

const mesh = JSON.parse(await readFile(IN, "utf8"));
await copyFile(IN, BACKUP);
let ecosystemBases = [];
try {
  const eco = JSON.parse(await readFile(resolve(ROOT, "tools/ecosystem.json"), "utf8"));
  ecosystemBases = (eco.bases ?? []).map((b) => b.id);
} catch {
  /* 没清单就退回 mesh.meta */
}
const baseIds = new Set([...(mesh.meta?.ecosystemBases ?? []), ...ecosystemBases]);
const before = new Map((mesh.nodes ?? []).map((n) => [n.id, n.category]));
const result = applyCategories(mesh.nodes ?? [], {
  minCount: 10,
  maxSectors: MAX_SECTORS,
  keepIds: ["spec"],
  baseIds,
});
mesh.clusters = result.counts.map((c) => ({ id: c.id, label: c.label, count: c.count }));
let changed = 0;
for (const n of mesh.nodes ?? []) if (before.get(n.id) !== n.category) changed += 1;
const tmp = OUT + ".tmp";
await writeFile(tmp, JSON.stringify(mesh), "utf8");
await rename(tmp, OUT);
console.log(JSON.stringify({
  nodes: mesh.nodes.length,
  sectors: mesh.clusters.length,
  other: result.unclassified,
  changed,
  counts: result.counts,
  backup: BACKUP,
}, null, 2));
