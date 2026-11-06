#!/usr/bin/env node
/**
 * 分类评测：生成标注表 / 用标注表评估 baseline 与规则变体。
 *
 * 只读离线，不改变线上分类结果。
 *
 * 生成标注表：
 *   node tools/classify-eval.mjs --sample 120 --out docs/classification-labels.csv
 * 评估：
 *   node tools/classify-eval.mjs --labels docs/classification-labels.csv
 *
 * 标注表列：id,name,stars,current_category,current_sub,candidates,description,topics,label,acceptable
 * label 填分类 id（other/agent/...），acceptable 可填逗号分隔的可接受备选；不想标的行留空或填 skip。
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyNode } from "./categories.mjs";
import { candidateScores, classifyVariant } from "./classify-variants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};

const MESH = resolve(ROOT, argOf("--mesh", "data/plugins/mesh.json"));
const OUT = argOf("--out", null);
const LABELS = argOf("--labels", null);
const SAMPLE = Number(argOf("--sample", "0"));
const PER_CAT = Math.max(1, Number(argOf("--percat", "8")));
const SEED = Number(argOf("--seed", "20261106"));

const mesh = JSON.parse(await readFile(MESH, "utf8"));
const nodes = mesh.nodes ?? [];
const byId = new Map(nodes.map((n) => [n.id, n]));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, seed) {
  const rand = rng(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function csvCell(value) {
  const s = String(value ?? "");
  return '"' + s.replace(/"/g, '""') + '"';
}
function csvRow(cells) {
  return cells.map(csvCell).join(",");
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

if (SAMPLE > 0) {
  const groups = new Map();
  for (const n of nodes) {
    if (!groups.has(n.category)) groups.set(n.category, []);
    groups.get(n.category).push(n);
  }
  const picked = [];
  for (const [cat, list] of groups) {
    const need = Math.min(PER_CAT, list.length);
    picked.push(...shuffle(list, SEED + cat.length).slice(0, need));
  }
  // 再补一批 other/低分节点：这些是规则最可能出问题的地方
  const other = shuffle(nodes.filter((n) => n.category === "other"), SEED + 1).slice(0, 15);
  const weak = shuffle(nodes.filter((n) => n.category !== "other" && (n.categoryScore ?? 0) <= 1), SEED + 2).slice(0, 15);
  const all = [...picked, ...other, ...weak].slice(0, SAMPLE);
  const header = ["id", "name", "stars", "current_category", "current_sub", "candidates", "description", "topics", "label", "acceptable"];
  const lines = [csvRow(header)];
  for (const n of all) {
    const candidates = candidateScores(n, 3).map((c) => c.id + ":" + c.score.toFixed(1)).join("|");
    lines.push(csvRow([
      n.id, n.name, n.stars ?? 0, n.category, n.subcategory ?? "", candidates,
      (n.description ?? "").replace(/\s+/g, " ").slice(0, 300),
      (n.topics ?? []).join(" "), "", "",
    ]));
  }
  const text = lines.join("\n") + "\n";
  if (OUT) {
    const file = resolve(ROOT, OUT);
    await writeFile(file, text, "utf8");
    console.log("标注表已写入 " + file + "（" + all.length + " 行）");
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
}

if (!LABELS) {
  console.log("用法：--sample N --out <csv> 或 --labels <csv>");
  process.exit(2);
}

const labelText = await readFile(resolve(ROOT, LABELS), "utf8");
const rows = parseCsv(labelText);
const header = rows[0] ?? [];
const index = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
const labeled = [];
for (const row of rows.slice(1)) {
  const id = row[index.id];
  const label = (row[index.label] ?? "").trim();
  if (!id || !label || label === "skip") continue;
  const node = byId.get(id);
  if (!node) continue;
  const acceptable = (row[index.acceptable] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  labeled.push({ id, label, acceptable });
}
if (!labeled.length) {
  console.log("没有有效标注行（label 为空或 skip）。");
  process.exit(2);
}

function metrics(results) {
  let correct = 0;
  let acceptable = 0;
  let other = 0;
  const labels = new Set();
  const preds = new Set();
  const confusion = new Map();
  for (const { item, result } of results) {
    labels.add(item.label);
    preds.add(result.id);
    if (result.id === item.label) correct += 1;
    if (result.id === item.label || item.acceptable.includes(result.id)) acceptable += 1;
    if (result.id === "other") other += 1;
    const key = item.label + " -> " + result.id;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  const macro = [];
  for (const label of labels) {
    const tp = results.filter((r) => r.item.label === label && r.result.id === label).length;
    const fp = results.filter((r) => r.item.label !== label && r.result.id === label).length;
    const fn = results.filter((r) => r.item.label === label && r.result.id !== label).length;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    macro.push(p + r ? (2 * p * r) / (p + r) : 0);
  }
  return {
    n: results.length,
    accuracy: correct / results.length,
    acceptableAccuracy: acceptable / results.length,
    otherRate: other / results.length,
    macroF1: macro.reduce((a, b) => a + b, 0) / Math.max(1, macro.length),
    confusion: [...confusion.entries()].filter(([k]) => k.split(" -> ")[0] !== k.split(" -> ")[1]).sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

const variants = [
  ["baseline", { promotion: false, weakGate: false }],
  ["promotion", { promotion: true, weakGate: false }],
  ["weakGate", { promotion: false, weakGate: true }],
  ["promotion+weakGate", { promotion: true, weakGate: true }],
];
const summary = {};
for (const [name, options] of variants) {
  const results = labeled.map((item) => {
    const node = byId.get(item.id);
    return { item, node, result: classifyVariant(node, options) };
  });
  summary[name] = metrics(results);
  if (name === "baseline" || name === "promotion+weakGate") {
    const changed = results.filter((r) => r.result.id !== r.node.category);
    console.log("\n== " + name + " ==");
    console.log(JSON.stringify({ ...summary[name], changed: changed.length }, null, 2));
    for (const r of changed.slice(0, 10)) {
      console.log("  " + r.node.id + "  " + r.node.category + " -> " + r.result.id + "  label=" + r.item.label + "  " + (r.node.description ?? "").slice(0, 70));
    }
  }
}
console.log("\n汇总:");
for (const [name] of variants) {
  const m = summary[name];
  console.log("  " + name.padEnd(20) + " acc=" + (m.accuracy * 100).toFixed(1) + "%  可接受=" + (m.acceptableAccuracy * 100).toFixed(1) + "%  macroF1=" + m.macroF1.toFixed(3) + "  other=" + (m.otherRate * 100).toFixed(1) + "%");
}
