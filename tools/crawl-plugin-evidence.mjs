#!/usr/bin/env node
/**
 * 轻量 README 爬虫：只读 raw.githubusercontent.com，低并发（默认 2）+ 固定间隔，
 * 对 review 的“根 package 存在”仓库找 dsh.bundle / cordis.patch.yml / 安装说明等证据。
 *
 * 它不是确认器；只把“值得进一步 tree 扫描”的仓库挑出来，写独立缓存，不碰 repo-manifests.json。
 *
 * 用法：
 *   node tools/crawl-plugin-evidence.mjs --limit 20
 *   node tools/crawl-plugin-evidence.mjs --concurrency 2 --delay 400
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
const MANIFESTS = resolve(ROOT, argOf("--manifests", "data/cache/repo-manifests.json"));
const OUT = resolve(ROOT, argOf("--out", "data/cache/repo-readme-evidence.json"));
const LIMIT = Math.max(0, Number(argOf("--limit", "0")));
const OFFSET = Math.max(0, Number(argOf("--offset", "0")));
const CONCURRENCY = Math.max(1, Math.min(4, Number(argOf("--concurrency", "2"))));
const DELAY_MS = Math.max(100, Number(argOf("--delay", "400")));
const SCOPE = argOf("--scope", "root"); // root | all
const UA = "dsh-plugin-mesh-readme-crawler/0.1 (+https://github.com/WTStarMark/dsh-plugin-mesh)";
const RAW = "https://raw.githubusercontent.com/";
const MAX_BYTES = 512 * 1024;

const mesh = JSON.parse(await readFile(MESH, "utf8"));
const nodeById = new Map((mesh.nodes ?? []).map((n) => [n.id, n]));
const manifests = JSON.parse(await readFile(MANIFESTS, "utf8"));
let cache = { generatedAt: null, repos: {} };
try {
  cache = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  cache = { generatedAt: null, repos: {} };
}
const candidates = Object.entries(manifests.repos)
  .filter(([, r]) => {
    if (r.verdict !== "review") return false;
    if (SCOPE === "root") return r.rootPackageJson === true;
    return true;
  })
  .map(([id]) => id)
  .filter((id) => nodeById.has(id));
const selected = candidates.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined).filter((id) => !cache.repos[id]);
console.log("待爬 README " + selected.length + " / " + candidates.length + " 个 review 仓库（scope=" + SCOPE + "，并发 " + CONCURRENCY + "，间隔 " + DELAY_MS + "ms）");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchReadme(owner, name) {
  const url = RAW + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/HEAD/README.md";
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

const MARKERS = [
  ["dsh-bundle", /dsh\.bundle/i],
  ["cordis-patch", /cordis\.patch\.ya?ml/i],
  ["dsh-plugin-add", /dsh\s+plugin\s+add/i],
  ["dsh-plugin", /dsh[- ]plugin/i],
  ["profile-bundles", /profile\.bundles/i],
];

async function crawl(id) {
  const [owner, name] = id.split("/");
  const text = await fetchReadme(owner, name);
  if (!text) return { hasReadme: false, markers: [], checkedAt: new Date().toISOString() };
  const markers = MARKERS.filter(([, re]) => re.test(text)).map(([key]) => key);
  return { hasReadme: true, markers, checkedAt: new Date().toISOString() };
}

async function save() {
  cache.generatedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  const tmp = OUT + ".tmp";
  await writeFile(tmp, JSON.stringify(cache), "utf8");
  await rename(tmp, OUT);
}

let index = 0;
let done = 0;
async function worker() {
  for (;;) {
    const i = index;
    index += 1;
    if (i >= selected.length) return;
    const id = selected[i];
    cache.repos[id] = await crawl(id);
    done += 1;
    if (done % 50 === 0) {
      await save();
      console.log("  进度 " + done + "/" + selected.length + " | " + id);
    }
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));
await save();
console.log("完成：爬取 " + done + " 个 README → " + OUT);
