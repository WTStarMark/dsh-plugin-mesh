#!/usr/bin/env node
/**
 * DSH 插件安装前验证器 CLI。
 *
 * 只读取 package.json / npm tarball / patch YAML；不安装 DSH、不运行 pnpm、不执行插件代码。
 */

import { readFile } from "node:fs/promises";
import { verifyDirectory, verifyNpmPackage } from "./lib/verify.mjs";

function usage() {
  console.log([
    "用法:",
    "  node tools/plugin-verifier/cli.mjs --package-dir <dir> [--package-dir ...]",
    "  node tools/plugin-verifier/cli.mjs --package <name>[@version] [...]",
    "  node tools/plugin-verifier/cli.mjs --package dsh-pet --graph data/mesh.json",
    "",
    "选项:",
    "  --graph <mesh.json>     提供后检查 GitHub 仓库是否在图里（市场规则）",
    "  --dsh-version <ver>     检查 engines.dsh 兼容性（例如 0.2.1-rc.5）",
    "  --json                  输出 JSON",
    "  --fail-on-review        有 review 时也返回非零",
    "  --help",
  ].join("\n"));
}

function parseArgs(argv) {
  const out = { dirs: [], packages: [], graph: null, dshVersion: null, json: false, failOnReview: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--fail-on-review") out.failOnReview = true;
    else if (arg === "--package-dir") out.dirs.push(argv[++i]);
    else if (arg === "--package") out.packages.push(argv[++i]);
    else if (arg === "--graph") out.graph = argv[++i];
    else if (arg === "--dsh-version") out.dshVersion = argv[++i];
    else throw new Error("未知参数：" + arg);
  }
  return out;
}

function splitSpec(spec) {
  const value = String(spec);
  let match = /^(@[^/]+\/[^@]+)(?:@(.+))?$/.exec(value);
  if (match) return { name: match[1], version: match[2] || null };
  match = /^([^@]+)(?:@(.+))?$/.exec(value);
  if (match) return { name: match[1], version: match[2] || null };
  return { name: value, version: null };
}

function printResult(result) {
  const t = result.target || {};
  console.log("\n" + (t.name || "?") + (t.version ? "@" + t.version : "") + "  [" + t.kind + "]  => " + String(result.verdict).toUpperCase() + " (" + result.level + ")");
  if (result.registry) console.log("  来源: " + result.registry.tarballUrl);
  for (const p of result.patches || []) console.log("  patch: " + p.path + " (" + p.items + " 条 / " + p.inserts + " inserts) " + (p.ok ? "ok" : "FAIL"));
  if (result.graph) console.log("  GitHub: " + result.graph.repoId + (result.graph.inGraph === null ? "（未校验）" : result.graph.inGraph ? " 在图里" : " 不在图里"));
  for (const e of result.errors || []) console.log("  ✗ " + e);
  for (const r of result.reviews || []) console.log("  ? " + r);
  for (const w of result.warnings || []) console.log("  · " + w);
}

async function loadGraphIds(path) {
  const mesh = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(mesh.nodes)) throw new Error("graph 文件没有 nodes 数组");
  return new Set(mesh.nodes.map((n) => String(n.id).toLowerCase()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (!args.dirs.length && !args.packages.length) { usage(); return 2; }
  const graphIds = args.graph ? await loadGraphIds(args.graph) : null;
  const opts = { dshVersion: args.dshVersion, graphIds };
  const results = [];
  for (const dir of args.dirs) {
    try { results.push(await verifyDirectory(dir, opts)); }
    catch (err) { results.push({ target: { kind: "dir", label: dir }, verdict: "rejected", level: "V0", errors: [err.message], warnings: [], reviews: [], checks: [] }); }
  }
  for (const spec of args.packages) {
    const { name, version } = splitSpec(spec);
    try { results.push(await verifyNpmPackage(name, version, opts)); }
    catch (err) { results.push({ target: { kind: "npm", label: spec, name, version }, verdict: "rejected", level: "V0", errors: [err.message], warnings: [], reviews: [], checks: [] }); }
  }
  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) printResult(r);
    const counts = results.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {});
    console.log("\n汇总: " + JSON.stringify(counts));
  }
  if (results.some((r) => r.verdict === "rejected")) return 1;
  if (args.failOnReview && results.some((r) => r.verdict === "review")) return 2;
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("验证器异常：" + (err && err.stack ? err.stack : err));
  process.exit(3);
});
