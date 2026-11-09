#!/usr/bin/env node
/**
 * review-suggest —— 生成「AI 初判复核清单」（先例：classification-labels-seed 的 AI 初判 + 人工复核）。
 * 对复核队列（manual + 疑点）逐条给建议档位：
 *   manifest 确认 / npm 确证 / README 提 DSH → 建议 related；
 *   README 只有别家平台字样且无 DSH 线索（非 loose）→ 建议 noise；
 *   其余 → 建议留人工（不给结论，免得手滑通过）。
 * 输出 docs/review-suggest.csv —— 只是建议，不落任何判定：结论以后台复核页人工点下去的为准。
 *
 * 用法：node tools/review-suggest.mjs [--out docs/review-suggest.csv] [--limit 0]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeshEvidence } from "./noise-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fb) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fb;
};
const OUT = resolve(ROOT, argOf("out", "docs/review-suggest.csv"));
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);

const mesh = JSON.parse(readFileSync(resolve(ROOT, "data/mesh.json"), "utf8"));
const man = JSON.parse(readFileSync(resolve(ROOT, "data/cache/repo-manifests.json"), "utf8"));
const PLUGIN = /plugin|插件|skill|技能|mcp|扩展|extension|皮肤|主题|面板|侧边栏|工作台/i;
const OTHER_HOST = /claude[- ]?(?:code|skills?)?|codex|cursor|gemini[- ]cli|smithery|mcpb|openskills|vscode[- ]extensions?/i;
const DSH_RE = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]|deepseek[\s-]?harness|cordis/i;

const evidence = await loadMeshEvidence();
const isWeak = (n) => {
  if (n.verdict !== "related") return false;
  const d = String(n.description || "").trim();
  const mr = man.repos[n.id];
  if (mr && mr.verdict === "confirmed") return false;
  return (d.length < 20 && (n.stars || 0) <= 1) || (!d && (n.stars || 0) === 0) || ((n.stars || 0) >= 50 && d.length < 40);
};

const rows = [];
for (const n of mesh.nodes ?? []) {
  const isManual = n.verdict === "manual";
  const weak = isWeak(n);
  if (!isManual && !weak) continue;
  const ev = evidence.get(n.id) ?? {};
  const digest = String(ev.readmeDigest || "");
  let verdict = "manual";
  let reason = "线索不足，暂不建议给结论";
  if (ev.manifestOk) {
    verdict = "related";
    reason = "清单扫描确认 dsh 插件（confirmed）";
  } else if (ev.npmOk) {
    verdict = "related";
    reason = "npm 包 dsh.client/入口确证";
  } else if (digest && DSH_RE.test(digest)) {
    verdict = "related";
    reason = "README 摘要明确提 DSH";
  } else if (digest && !DSH_RE.test(digest) && OTHER_HOST.test(digest) && !PLUGIN.test((n.name || "") + " " + String(n.description || ""))) {
    verdict = "noise";
    reason = "README 只讲其他插件平台，无 DSH 线索";
  } else if (digest && !DSH_RE.test(digest) && !PLUGIN.test(digest.slice(0, 400))) {
    verdict = "noise";
    reason = "README 摘要无 DSH 线索且不像插件本体";
  }
  rows.push({
    id: n.id,
    stars: n.stars ?? 0,
    kind: isManual ? "manual" : "suspect",
    suggested_verdict: verdict,
    suggested_reason: reason,
    manifest: ev.manifestOk ? "confirmed" : (man.repos[n.id] ? "review" : ""),
    npm: ev.npmOk ? "dsh.client" : "",
    readme_snip: digest.slice(0, 140),
    description: String(n.description || "").slice(0, 140),
  });
}
rows.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
const picked = LIMIT ? rows.slice(0, LIMIT) : rows;

const esc = (v) => '"' + String(v ?? "").replace(/"/g, "") + '"';
const csv = [
  "id,stars,kind,suggested_verdict,suggested_reason,manifest,npm,readme_snip,description",
  ...picked.map((r) => [
    esc(r.id),
    String(r.stars),
    esc(r.kind),
    esc(r.suggested_verdict),
    esc(r.suggested_reason),
    esc(r.manifest),
    esc(r.npm),
    esc(r.readme_snip),
    esc(r.description),
  ].join(",")),
].join("\n") + "\n";
writeFileSync(OUT, csv, "utf8");
const counts = {};
for (const r of picked) counts[r.kind + ":" + r.suggested_verdict] = (counts[r.kind + ":" + r.suggested_verdict] || 0) + 1;
console.log("清单 " + picked.length + " 行 → " + OUT);
console.log("建议分布:", JSON.stringify(counts));
