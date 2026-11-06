#!/usr/bin/env node
/**
 * 对市场索引里的包跑 V2 安装前验证（npm tarball + patch 语义 + npm↔GitHub 互证），
 * 产出验证报告；可选按报告过滤市场索引。
 *
 * 不安装 DSH、不跑 pnpm、不执行插件代码。
 *
 * 用法：
 *   node tools/verify-market.mjs --limit 50
 *   node tools/verify-market.mjs --limit 0 --out dist/market/verification.json
 *   node tools/verify-market.mjs --apply-verified dist/market/index.verified.json --allow-partial
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNpmPackage } from "./plugin-verifier/lib/verify.mjs";
import { filterMarketIndexByVerification } from "./plugin-graph.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MARKET = resolve(ROOT, argOf("--market", "dist/market/index.json"));
const GRAPH = resolve(ROOT, argOf("--graph", "data/plugins/mesh.json"));
const OUT = resolve(ROOT, argOf("--out", "dist/market/verification.json"));
const CACHE = resolve(ROOT, argOf("--cache", "data/cache/plugin-verification.json"));
const LIMIT = Math.max(0, Number(argOf("--limit", "20")));
const OFFSET = Math.max(0, Number(argOf("--offset", "0")));
const CONCURRENCY = Math.max(1, Math.min(8, Number(argOf("--concurrency", "4"))));
const DSH_VERSION = argOf("--dsh-version", "0.2.1-rc.5");
const APPLY = argOf("--apply-verified", null);
const ALLOW_PARTIAL = argv.includes("--allow-partial");
const TTL_MS = 7 * 24 * 3600 * 1000;
const VERIFIER_VERSION = "0.2"; // 验证语义变化时递增，旧缓存自动忽略

const market = JSON.parse(await readFile(MARKET, "utf8"));
const graph = JSON.parse(await readFile(GRAPH, "utf8"));
const graphIds = new Set((graph.nodes ?? []).map((n) => String(n.id).toLowerCase()));
let cache = { entries: {} };
try {
  cache = JSON.parse(await readFile(CACHE, "utf8"));
} catch {
  /* 首次运行 */
}
const plugins = (market.plugins ?? []).slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
console.log("待验证 " + plugins.length + " / " + (market.plugins ?? []).length + " 个市场包");

const results = [];
let done = 0;
async function one(plugin) {
  const name = String(plugin.name ?? "");
  const version = String(plugin.versions?.[0]?.version ?? "") || null;
  const key = name + "@" + (version ?? "latest");
  const cached = cache.entries[key];
  if (cached && cached.verifierVersion === VERIFIER_VERSION && Date.now() - Date.parse(cached.checkedAt) < TTL_MS) return cached;
  let result;
  try {
    result = await verifyNpmPackage(name, version, { graphIds, dshVersion: DSH_VERSION, repositoryFallback: plugin.repository });
  } catch (err) {
    result = { verdict: "review", level: "V0", errors: [], reviews: ["验证异常：" + err.message], patches: [], target: { name, version } };
  }
  const entry = {
    name,
    version: result.target?.version ?? version,
    verdict: result.verdict,
    level: result.level,
    errors: result.errors ?? [],
    reviews: result.reviews ?? [],
    patches: (result.patches ?? []).map((p) => ({ path: p.path, items: p.items, inserts: p.inserts, ok: p.ok })),
    verifierVersion: VERIFIER_VERSION,
    checkedAt: new Date().toISOString(),
  };
  cache.entries[key] = entry;
  return entry;
}

async function worker() {
  for (;;) {
    const index = done;
    done += 1;
    if (index >= plugins.length) return;
    const entry = await one(plugins[index]);
    results.push(entry);
    const n = results.length;
    if (n % 10 === 0 || n === plugins.length) console.log("  已验证 " + n + "/" + plugins.length + "（" + entry.name + "：" + entry.verdict + "）");
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plugins.length) }, () => worker()));

const counts = results.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {});
const report = {
  generatedAt: new Date().toISOString(),
  level: "V2",
  dshVersion: DSH_VERSION,
  market: MARKET,
  checked: results.length,
  total: (market.plugins ?? []).length,
  counts,
  entries: results.sort((a, b) => a.name.localeCompare(b.name)),
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");
await mkdir(dirname(CACHE), { recursive: true });
await writeFile(CACHE, JSON.stringify(cache), "utf8");
console.log("验证报告 → " + OUT + " " + JSON.stringify(counts));

if (APPLY) {
  try {
    const verified = filterMarketIndexByVerification(market, report, { allowPartial: ALLOW_PARTIAL });
    const out = resolve(ROOT, APPLY);
    await writeFile(out, JSON.stringify(verified), "utf8");
    console.log("已写出验证后市场：" + out + "（" + verified.plugins.length + " 个包）");
  } catch (err) {
    console.error("过滤失败：" + err.message);
    process.exitCode = 2;
  }
}
