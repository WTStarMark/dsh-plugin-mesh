#!/usr/bin/env node
/**
 * market-sync —— 把现有市场索引同步到最新分类 + 真实核验过的「含界面」标签。
 *
 * 为什么单独一个工具：market-index.mjs 重建一次要重抓近万份 packument；分类和标签是
 * mesh 分类结果与 UI 证据的派生字段，可以在不重抓 registry 的前提下原地同步。
 *
 * 用法：
 *   node tools/market-sync.mjs [--index dist/market/index.json] [--mesh data/mesh.json]
 *                               [--evidence data/cache/market-ui-evidence.json] [--dry-run]
 *
 * 会同时刷新 index.json（紧凑 JSON + gz/br）与 index.strict.json（如果存在）。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText, atomicWriteBuffer } from "./atomic-write.mjs";
import { compressIndex } from "./market-compress.mjs";
import { MARKET_LABELS, MARKET_LABEL_IDS } from "./market-labels.mjs";
import { hiddenLabelIds, marketPaths, readMarketOverrides } from "./market-overrides.mjs";
import { repoKeyFromUrl } from "./repo-dir-verify.mjs";
import { uiEvidenceVerdict } from "./market-ui.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const INDEX = resolve(ROOT, argOf("index", "dist/market/index.json"));
const MESH = resolve(ROOT, argOf("mesh", "data/mesh.json"));
const EVIDENCE = resolve(ROOT, argOf("evidence", "data/cache/market-ui-evidence.json"));
const DRY = argv.includes("--dry-run");

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};

const index = readJson(INDEX, null);
const mesh = readJson(MESH, null);
const evidenceDoc = readJson(EVIDENCE, null);
if (!index || !Array.isArray(index.plugins)) {
  console.error("读不到市场索引：" + INDEX);
  process.exit(1);
}
if (!mesh || !Array.isArray(mesh.nodes)) {
  console.error("读不到 mesh：" + MESH);
  process.exit(1);
}
if (!evidenceDoc || !evidenceDoc.packages) {
  console.error("读不到 UI 证据：" + EVIDENCE + "（先跑 node tools/market-ui-scan.mjs）");
  process.exit(1);
}
/* 证据 v1 只数了文件名、没有 dsh.client 平台与 exports["./client"] 入口，不能用来判定。 */
if (evidenceDoc.version !== 2) {
  console.error("UI 证据是旧格式（version=" + evidenceDoc.version + "）：先重跑 node tools/market-ui-scan.mjs 生成 v2 证据");
  process.exit(1);
}
/* 扫描跑到一半的缓存不能用来改线上索引：否则未扫到的包会被当成“没有界面”清掉标签。 */
const evidenceCount = Object.keys(evidenceDoc.packages).length;
if (evidenceDoc.status !== "complete" || evidenceCount < Math.floor(index.plugins.length * 0.95)) {
  console.error(
    "UI 证据不完整（status=" + (evidenceDoc.status ?? "?") + "，证据 " + evidenceCount + " 条 / 索引 " + index.plugins.length + " 条）：先跑完 node tools/market-ui-scan.mjs",
  );
  process.exit(1);
}

const hidden = hiddenLabelIds(readMarketOverrides(marketPaths(ROOT).overrides));
const evidence = evidenceDoc.packages;

/* repo（owner/repo 小写）→ mesh 节点；同一个仓库多个节点时取第一个（分类一致） */
const byRepo = new Map();
const byId = new Map();
for (const node of mesh.nodes) {
  const key = String(node?.id ?? "").toLowerCase();
  if (key) byId.set(key, node);
  const repo = repoKeyFromUrl(node?.htmlUrl);
  if (repo && !byRepo.has(repo)) byRepo.set(repo, node);
}

/* 分类标题：generator 用的是 mesh 节点上的 categoryLabel；顺序沿用 mesh 里首次出现顺序 */
const categoryLabel = new Map();
for (const node of mesh.nodes) {
  if (node?.category && !categoryLabel.has(node.category)) {
    categoryLabel.set(node.category, node.categoryLabel ?? node.category);
  }
}

const stat = {
  plugins: index.plugins.length,
  categoryChanged: 0,
  categoryRemoved: 0,
  labelAdded: 0,
  labelRemoved: 0,
  noEvidence: 0,
  evidenceVerified: 0,
  evidenceFailed: 0,
  evidenceUi: 0,
};
const categorySamples = [];

for (const plugin of index.plugins) {
  const repo = repoKeyFromUrl(plugin?.repository?.url);
  const node = repo ? byRepo.get(repo) : null;
  const nextCategory = node?.category;
  const prevCategory = plugin.metadata?.category;
  if (nextCategory) {
    if (prevCategory !== nextCategory) {
      plugin.metadata.category = nextCategory;
      stat.categoryChanged += 1;
      if (categorySamples.length < 8) categorySamples.push([plugin.name, prevCategory ?? "—", nextCategory]);
    }
  } else if (prevCategory !== undefined) {
    delete plugin.metadata.category;
    stat.categoryRemoved += 1;
  }

  /* 含界面：只认扫描证据（发布包文件清单 + package.json 的 exports["./client"] 入口）。
   * 未扫描/扫描失败一律不打标签，也不再把旧标签或 dsh.client 声明本身当证据 ——
   * 声明只是作者的话，入口文件真的在发布包里才算。 */
  const record = evidence[plugin.name];
  const labels = new Set(plugin.metadata?.labels ?? []);
  const had = labels.has("has-client");
  const verdict = uiEvidenceVerdict(record);
  if (!record) stat.noEvidence += 1;
  if (record?.ok) {
    stat.evidenceVerified += 1;
    if (verdict.ui) stat.evidenceUi += 1;
  } else if (record) {
    stat.evidenceFailed += 1;
  }
  if (verdict.ui && !hidden.has("has-client")) {
    if (!had) stat.labelAdded += 1;
    labels.add("has-client");
  } else {
    if (had) stat.labelRemoved += 1;
    labels.delete("has-client");
  }
  plugin.metadata.labels = MARKET_LABEL_IDS.filter((id) => labels.has(id) && !hidden.has(id));
}

/* 分类声明：数量写进标题（与 market-index.mjs 同口径）；无条目的分类不声明 */
const categoryCounts = new Map();
for (const plugin of index.plugins) {
  const id = plugin.metadata?.category;
  if (id) categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
}
const declaredCategories = {};
for (const [id, label] of categoryLabel) {
  const count = categoryCounts.get(id) ?? 0;
  if (!count) continue;
  declaredCategories[id] = { title: { en: id + " · " + count, zh: label + " · " + count } };
}

index.metadata = index.metadata ?? {};
index.metadata.categories = declaredCategories;
index.metadata.labels = Object.fromEntries(
  MARKET_LABELS.filter((def) => !hidden.has(def.id)).map((def) => [def.id, { title: { en: def.en, zh: def.zh } }]),
);

/* 后台 build-stats 也顺手对齐（只改派生计数，不伪造构建时间） */
const STATS = resolve(dirname(INDEX), "build-stats.json");
const stats = readJson(STATS, null);
if (stats) {
  const labelCounts = {};
  for (const plugin of index.plugins) for (const label of plugin.metadata?.labels ?? []) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  stats.labels = labelCounts;
  stats.hiddenLabels = [...hidden];
  stats.index = stats.index ?? {};
  stats.index.plugins = index.plugins.length;
  stats.index.categories = Object.keys(declaredCategories).length;
  /* 「含界面」的证据来源一起落盘，后台能看出这个标签是怎么来的、扫了多少、失败多少。 */
  stats.uiEvidence = {
    version: evidenceDoc.version,
    scannedAt: evidenceDoc.updatedAt ?? null,
    packages: Object.keys(evidence).length,
    verified: stat.evidenceVerified,
    failed: stat.evidenceFailed,
    ui: stat.evidenceUi,
  };
  stats.syncedAt = new Date().toISOString();
}

const text = JSON.stringify(index);
const packed = compressIndex(text);
if (!DRY) {
  atomicWriteText(INDEX, text);
  atomicWriteBuffer(INDEX + ".gz", packed.gzip);
  atomicWriteBuffer(INDEX + ".br", packed.br);
  const strictPath = resolve(dirname(INDEX), "index.strict.json");
  if (existsSync(strictPath)) atomicWriteText(strictPath, text);
  if (stats) atomicWriteText(STATS, JSON.stringify(stats, null, 1));
}

console.log(JSON.stringify({
  dryRun: DRY,
  index: INDEX,
  evidence: EVIDENCE,
  ...stat,
  categorySamples,
  labels: Object.fromEntries(MARKET_LABELS.map((def) => [def.id, stats?.labels?.[def.id] ?? index.plugins.filter((p) => (p.metadata?.labels ?? []).includes(def.id)).length])),
  bytes: { raw: text.length, gzip: packed.gzip.length, br: packed.br.length, ms: packed.ms },
}, null, 2));
