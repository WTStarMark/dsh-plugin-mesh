#!/usr/bin/env node
/**
 * noise-evidence-scan —— 给噪声识别算法补证据：把「待人工」和疑点 related 队列里
 * README 索引还没覆盖到的仓库拿去读一遍 README（raw.githubusercontent，低并发，
 * 只读不安装不执行），摘要正文 + 判出有没有 DSH 专有线索，写独立缓存
 * data/cache/noise-evidence.json，供 build.py / reclassify.mjs 在判定时引用。
 *
 * 目标清单（--scope queue，默认）：
 *   1) verdict === "manual"        → 人工积压，README 证据能把它们定性成 related/noise；
 *   2) 疑点 related（描述 <20 字 && 星 ≤1，或 无描述 && 0 星）→ 防噪声漏网的抽样复核。
 * README 索引已有的（data/cache/readmes.json.gz，digest 空也算查过了）一律跳过。
 *
 * 用法：
 *   node tools/noise-evidence-scan.mjs                     # 默认队列，断点续跑
 *   node tools/noise-evidence-scan.mjs --limit 100         # 先试 100 条
 *   node tools/noise-evidence-scan.mjs --concurrency 4 --delay 600
 *   node tools/noise-evidence-scan.mjs --refresh           # 推倒重扫本队列
 */
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { normalizeReadme, readmeHit } from "./noise-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("mesh", "data/mesh.json"));
const READMES = resolve(ROOT, argOf("readmes", "data/cache/readmes.json.gz"));
const OUT = resolve(ROOT, argOf("out", "data/cache/noise-evidence.json"));
const CONCURRENCY = Math.max(1, Math.min(6, Number(argOf("concurrency", "3")) || 3));
const DELAY_MS = Math.max(0, Number(argOf("delay", "500")) || 0);
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);
const SCOPE = argOf("scope", "queue"); // queue | manual | all
const REFRESH = argv.includes("--refresh");
const UA = "dsh-plugin-mesh-noise-evidence/0.1 (+https://github.com/WTStarMark/dsh-plugin-mesh)";
const RAW = "https://raw.githubusercontent.com/";
const MAX_BYTES = 512 * 1024; // README 太大不读全文（同 crawl-plugin-evidence 口径）
const SCHEMA = 1;
// 摘要 normalize 与 DSH 命中口径从 tools/noise-evidence.mjs import（与 Python 同镜像，测试在 tests/noise-evidence.test.mjs）。

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function loadReadmes() {
  try {
    const buf = readFileSync(READMES);
    const raw = READMES.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    const doc = JSON.parse(raw);
    return doc.docs && typeof doc.docs === "object" ? doc.docs : {};
  } catch { return {}; }
}
function sleep(ms) { return new Promise((done) => setTimeout(done, ms)); }

const mesh = loadJson(MESH, null);
if (!mesh || !Array.isArray(mesh.nodes)) {
  console.error("读不到 mesh：" + MESH);
  process.exit(1);
}
const prev = loadJson(OUT, null);
const cache = prev && prev.repos && typeof prev.repos === "object"
  ? { version: SCHEMA, updatedAt: null, repos: { ...prev.repos } }
  : { version: SCHEMA, updatedAt: null, repos: {} };
cache.version = SCHEMA;

const known = loadReadmes();
const isWeakRelated = (n) =>
  n.verdict === "related" &&
  ((String(n.description ?? "").trim().length < 20 && (n.stars ?? 0) <= 1) ||
    (!String(n.description ?? "").trim() && (n.stars ?? 0) === 0));

const targets = mesh.nodes.filter((n) => {
  if (n.verdict === "manual") return SCOPE === "queue" || SCOPE === "manual" || SCOPE === "all";
  if (SCOPE === "queue" || SCOPE === "all") return isWeakRelated(n);
  return false;
}).map((n) => n.id).filter(Boolean);

const selected = targets
  .filter((id) => REFRESH || !(id in known || id in cache.repos))
  .slice(0, LIMIT || undefined);
console.log(
  "目标队列 " + targets.length + "（manual " + mesh.nodes.filter((n) => n.verdict === "manual").length +
  " + 疑点 related），未索引待扫 " + selected.length + "（并发 " + CONCURRENCY + "，间隔 " + DELAY_MS + "ms）"
);

async function fetchReadme(id) {
  const url = RAW + encodeURIComponent(id) + "/HEAD/README.md";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) {
        const retry = Number(res.headers.get("retry-after") || 0);
        await sleep(Math.max(1000, retry * 1000 || 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      return Buffer.byteLength(text, "utf8") > MAX_BYTES ? null : text;
    } catch {
      if (attempt === 2) return null;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

let cursor = 0;
let done = 0;
const startedAt = Date.now();
const hits = { dsh: 0, plain: 0, empty: 0 };

async function save() {
  cache.updatedAt = new Date().toISOString();
  const tmp = OUT + ".tmp";
  await writeFile(tmp, JSON.stringify(cache), "utf8");
  await rename(tmp, OUT);
}

async function worker() {
  for (;;) {
    const i = cursor;
    cursor += 1;
    if (i >= selected.length) return;
    const id = selected[i];
    const text = await fetchReadme(id);
    const digest = normalizeReadme(text);
    cache.repos[id] = { t: digest, f: new Date().toISOString() };
    if (digest) hits[readmeHit(digest) ? "dsh" : "plain"] += 1;
    else hits.empty += 1;
    done += 1;
    if (done % 50 === 0 || done === selected.length) {
      await save();
      console.log("进度 " + done + "/" + selected.length + " · dsh命中 " + hits.dsh +
        " · 无dsh命中 " + hits.plain + " · 抓不到 " + hits.empty + " · " +
        ((Date.now() - startedAt) / 1000).toFixed(0) + "s");
    }
    if (DELAY_MS) await sleep(DELAY_MS);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));
await save();
console.log("完成：" + JSON.stringify(hits) + "；缓存：" + OUT + "（共 " + Object.keys(cache.repos).length + " 条）");
