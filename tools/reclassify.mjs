#!/usr/bin/env node
/**
 * 就地重建：不重新采集，用当前规则重算 data/mesh.json 的派生字段。
 *
 *  1) 非插件语境排除（DSH 是别的意思，例如 DeepHash-pytorch 的 DSH = Deep Supervised Hashing）
 *     —— 这一步会真的删节点与相关边，并用 meta.excludedNotPlugin 记账
 *  2) 功能分类 + 细枝（tools/categories.mjs）
 *  3) 相关性三档判定（tools/relevance.mjs）
 *  4) 生态共鸣边重建（tools/ecosystem.json，人工策展 + README 复核）
 *
 * 节点集合只允许因"排除规则"减少，不允许增加。改完记得跑 tools/precompute-layout.mjs。
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCategories, DEFAULT_OPTIONS, nonPluginReason } from "./categories.mjs";
import { analyzeRelevance } from "./relevance.mjs";
import ecosystem from "./ecosystem.json" with { type: "json" };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(ROOT, "data/mesh.json");

const mesh = JSON.parse(await readFile(FILE, "utf8"));
const nodeCount = mesh.nodes.length;

// ---- 1) 非插件语境排除 ----
const excluded = [];
const keep = new Set();
for (const node of mesh.nodes) {
  const why = nonPluginReason(node);
  if (why) excluded.push({ id: node.id, why });
  else keep.add(node.id);
}
if (excluded.length) {
  mesh.nodes = mesh.nodes.filter((n) => keep.has(n.id));
  mesh.edges = (mesh.edges ?? []).filter((e) => keep.has(e.source) && keep.has(e.target));
  mesh.meta.excludedNotPlugin = Object.fromEntries(excluded.map((e) => [e.id, e.why]));
  mesh.meta.excludedNotPluginCount = excluded.length;
  const indexed = mesh.meta.indexedNodes ?? nodeCount;
  mesh.meta.indexedNodes = Math.max(mesh.nodes.length, indexed - excluded.length);
}
const ids = new Set(mesh.nodes.map((n) => n.id));

// ---- 2) 功能分类 + 细枝 ----
const before = new Map(mesh.nodes.map((n) => [n.id, n.category]));
const stats = applyCategories(mesh.nodes, {
  ...DEFAULT_OPTIONS,
  baseIds: (ecosystem.bases ?? []).map((b) => b.id),
});

const moves = new Map();
for (const node of mesh.nodes) {
  const from = before.get(node.id);
  if (from !== node.category) {
    const key = from + " → " + node.category;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }
}

// ---- 3) 相关性三档判定 ----
const verdicts = { related: 0, noise: 0, manual: 0 };
for (const node of mesh.nodes) {
  const v = analyzeRelevance(node);
  node.relevance = v.relevance;
  node.review = v.review;
  node.verdict = v.verdict;
  node.reason = v.reason;
  verdicts[v.verdict] += 1;
}

// ---- 4) 生态共鸣边：先清掉旧的，再按策展清单重建（两端都在图里才建）----
const edges = (mesh.edges ?? []).filter((e) => e.type !== "resonance");
let resonance = 0;
const missing = [];
for (const base of ecosystem.bases ?? []) {
  if (base.enabled === false) continue; // 临时关闭的基座不建边
  if (!ids.has(base.id)) {
    missing.push(base.id);
    continue;
  }
  for (const child of base.verified ?? []) {
    if (!child.id || child.id === base.id || !ids.has(child.id)) continue;
    edges.push({ source: base.id, target: child.id, type: "resonance", weight: 1, via: [base.label ?? "生态共鸣"] });
    resonance += 1;
  }
}
mesh.edges = edges;
mesh.meta.resonanceEdges = resonance;
mesh.meta.ecosystemBases = (ecosystem.bases ?? []).filter((b) => b.enabled !== false).map((b) => b.id);
mesh.meta.ecosystemDisabled = (ecosystem.bases ?? []).filter((b) => b.enabled === false).map((b) => b.id);

// ---- 派生字段与计数 ----
mesh.meta.categories = {
  classified: stats.classified,
  unclassified: stats.unclassified,
  minCount: DEFAULT_OPTIONS.minCount,
  maxSectors: DEFAULT_OPTIONS.maxSectors,
  keepIds: DEFAULT_OPTIONS.keepIds,
  merged: stats.merged,
  distribution: stats.counts,
};
mesh.meta.reviewedAsNoise = verdicts.manual;
mesh.meta.verdictCounts = { related: verdicts.related, noise: verdicts.noise, manual: verdicts.manual };
mesh.meta.sampleNodes = mesh.nodes.length;
mesh.meta.sampleEdges = mesh.edges.length;
mesh.clusters = stats.counts.map((c) => ({ id: c.id, label: c.label, count: c.count }));
mesh.tags = (mesh.tags ?? []).map((t) => ({
  ...t,
  sampleCount: mesh.nodes.filter((n) => (n.matchedTags ?? []).includes(t.id)).length,
}));

await writeFile(FILE, JSON.stringify(mesh), "utf8");

// ---- 自检 ----
const expected = nodeCount - excluded.length;
if (mesh.nodes.length !== expected) {
  console.error("节点数异常：期望 " + expected + "（原 " + nodeCount + " - 排除 " + excluded.length + "），实际 " + mesh.nodes.length);
  process.exit(1);
}
console.log("节点 " + nodeCount + " → " + mesh.nodes.length + "（排除 " + excluded.length + " 个非插件语境仓库）");
for (const e of excluded) console.log("  排除 " + e.id + "：" + e.why);
console.log("归类:", stats.classified, "| 未分类:", stats.unclassified);
console.log("分类发生变化的节点:", [...moves.values()].reduce((a, b) => a + b, 0));
for (const [key, count] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log("   " + key.padEnd(26) + count);
console.log("相关性判定：相关", verdicts.related, "| 确认噪声", verdicts.noise, "| 仍需人工", verdicts.manual);
console.log(
  "生态共鸣边:",
  resonance,
  "| 基座:",
  (ecosystem.bases ?? []).map((b) => b.id + "→" + (b.verified ?? []).length + (b.enabled === false ? "(已关闭)" : "")).join(" · "),
);
if (missing.length) console.log("  注意：这些基座不在当前数据里，未建边：" + missing.join(", "));
console.log("扇区分布:", stats.counts.map((c) => c.id + "(" + c.count + ")").join(" "));
