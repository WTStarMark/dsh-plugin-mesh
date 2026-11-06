#!/usr/bin/env node
/**
 * 生成插件图与严格市场索引（本地/离线）。
 *
 * 用法：
 *   node tools/build-plugin-graph.mjs [--mesh data/mesh.json] [--market dist/market/index.json] [--out data/plugins] [--apply-market]
 *
 * 产出：
 *   data/plugins/mesh.json + precompute 产物（mesh-core.* / details）
 *   dist/market/index.strict.json
 *   --apply-market 时备份原 index.json 到 index.ecosystem.json，并用严格版替换本地 index.json
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginMesh, filterMarketIndex, filterMarketIndexByVerification, repoOfPlugin, HUB_ID } from "./plugin-graph.mjs";
import { compressIndex } from "./market-compress.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
const MARKET = resolve(ROOT, argOf("--market", "dist/market/index.json"));
const OUT = resolve(ROOT, argOf("--out", "data/plugins"));
const APPLY = argv.includes("--apply-market");
const VERIFY_REPORT = argOf("--verification", null);
const ALLOW_PARTIAL = argv.includes("--allow-partial");
const NO_README = argv.includes("--no-readme-evidence");

const mesh = JSON.parse(await readFile(MESH, "utf8"));
const market = JSON.parse(await readFile(MARKET, "utf8"));
const bases = mesh.meta?.ecosystemBases ?? [];

// 证据分级：
//   npm-bundle   = 市场里 dsh-bundle 且仓库在图里（强制 npm）
//   manifest-scan = 仓库 manifest 扫描缓存（data/cache/repo-manifests.json）确认有 dsh.bundle
//   readme-manifest = README 明确提到 dsh.bundle / cordis.patch.yml，但没走 npm 市场（插件图收录，市场不收）
//   curated      = 官方主仓库 / 策展基座
const npmEvidence = new Set();
for (const plugin of market.plugins ?? []) {
  if (!(plugin.metadata?.labels ?? []).includes("dsh-bundle")) continue;
  const repo = repoOfPlugin(plugin);
  if (repo) npmEvidence.add(repo);
}
const readmeEvidence = new Set();
if (!NO_README) {
  try {
    const raw = gunzipSync(await readFile(join(ROOT, "data", "cache", "readmes.json.gz")));
    const docs = JSON.parse(raw.toString("utf8")).docs ?? {};
    for (const [id, doc] of Object.entries(docs)) {
      const key = String(id).toLowerCase();
      if (npmEvidence.has(key)) continue;
      const text = String(doc?.t ?? "").toLowerCase();
      if (text.includes("dsh.bundle") || text.includes("cordis.patch.yml")) readmeEvidence.add(key);
    }
  } catch (err) {
    console.warn("README 证据读取失败，跳过：" + err.message);
  }
}
// 仓库 manifest 扫描缓存（扫描器暂停中；未来写入 confirmed 后自动进插件图）
const manifestEvidence = new Set();
try {
  const cache = JSON.parse(await readFile(join(ROOT, "data", "cache", "repo-manifests.json"), "utf8"));
  const repos = cache.repos ?? cache;
  for (const [id, rec] of Object.entries(repos ?? {})) {
    if (rec && (rec.verdict === "confirmed" || rec.plugin === true)) manifestEvidence.add(String(id).toLowerCase());
  }
} catch {
  /* 缓存不存在 = 还没扫描 */
}
const pluginMesh = buildPluginMesh(mesh, market, { extraIds: [HUB_ID, ...bases, ...manifestEvidence, ...readmeEvidence] });
const curated = new Set([HUB_ID.toLowerCase(), ...bases.map((x) => String(x).toLowerCase())]);
const evidenceCounts = {};
for (const node of pluginMesh.nodes) {
  const key = String(node.id).toLowerCase();
  node.pluginEvidence = npmEvidence.has(key)
    ? "npm-bundle"
    : manifestEvidence.has(key)
      ? "manifest-scan"
      : readmeEvidence.has(key)
        ? "readme-manifest"
        : curated.has(key)
          ? "curated"
          : "unknown";
  evidenceCounts[node.pluginEvidence] = (evidenceCounts[node.pluginEvidence] ?? 0) + 1;
}
pluginMesh.meta.pluginEvidenceCounts = evidenceCounts;
pluginMesh.meta.note =
  "DSH 插件图：npm 已确证 dsh.bundle + 仓库 manifest 扫描确认 + README 提到标准 manifest 的未发 npm 插件 + 官方主仓库/策展基座；市场仍只收 npm 包。";
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "mesh.json"), JSON.stringify(pluginMesh), "utf8");
console.log("插件图 mesh: " + pluginMesh.nodes.length + " 节点 / " + pluginMesh.edges.length + " 连线 → " + OUT + "/mesh.json");
console.log("插件证据: " + JSON.stringify(evidenceCounts));

const run = spawnSync(process.execPath, ["tools/precompute-layout.mjs", "--in", join(OUT, "mesh.json"), "--out", OUT], {
  cwd: ROOT,
  stdio: "inherit",
});
if (run.status !== 0) process.exit(run.status ?? 1);

const allowed = new Set(pluginMesh.nodes.map((n) => String(n.id).toLowerCase()));
let strict = filterMarketIndex(market, allowed);
if (VERIFY_REPORT) {
  const report = JSON.parse(await readFile(resolve(ROOT, VERIFY_REPORT), "utf8"));
  strict = filterMarketIndexByVerification(strict, report, { allowPartial: ALLOW_PARTIAL });
  console.log("已按 V2 验证报告过滤市场 → " + strict.plugins.length + " 个包");
}
await mkdir(dirname(MARKET), { recursive: true });
await writeFile(join(dirname(MARKET), "index.strict.json"), JSON.stringify(strict), "utf8");
console.log("严格市场: " + strict.plugins.length + " 个包 → " + join(dirname(MARKET), "index.strict.json"));

if (APPLY) {
  const backup = join(dirname(MARKET), "index.ecosystem.json");
  if (!existsSync(backup)) await copyFile(MARKET, backup);
  const text = JSON.stringify(strict);
  const packed = compressIndex(text);
  await writeFile(MARKET, text, "utf8");
  await writeFile(MARKET + ".gz", packed.gzip);
  await writeFile(MARKET + ".br", packed.br);
  console.log("已应用到本地 " + MARKET + "（预压缩同步，原始备份 index.ecosystem.json）");
}
