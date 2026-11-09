#!/usr/bin/env node
/**
 * market-ui-scan —— 真实扫描 npm 包发布内容，为「含界面 / Has UI」标签提供证据。
 *
 * 对市场索引里的每个包读取两样东西：
 *   1. package.json（jsDelivr CDN → unpkg）：dsh.client 声明、exports["./client"] 客户端入口；
 *   2. 发布包文件清单（jsDelivr flat → unpkg ?meta → npm tarball）：真实装进包里的文件。
 * 只有「文件真的在发布包里」才算证据；扫描失败 = 未验证 = 不打标签。
 * 只读 npm 内容，不安装、不执行；缓存按 包名@版本 记录，可断点续跑。
 *
 * 用法：
 *   node tools/market-ui-scan.mjs [--index dist/market/index.json] [--out data/cache/market-ui-evidence.json]
 *                                  [--concurrency 8] [--limit 0] [--refresh] [--retry-errors]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText } from "./atomic-write.mjs";
import { analyzeClientEntry, analyzeUiFiles, tarballUrl } from "./market-ui.mjs";
import { fetchTarball } from "./plugin-verifier/lib/tarball.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const INDEX = resolve(ROOT, argOf("index", "dist/market/index.json"));
const OUT = resolve(ROOT, argOf("out", "data/cache/market-ui-evidence.json"));
const CONCURRENCY = Math.max(1, Math.min(16, Number(argOf("concurrency", "8")) || 8));
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);
const REFRESH = argv.includes("--refresh");
const RETRY_ERRORS = argv.includes("--retry-errors");
const UA = "dsh-plugin-mesh-market-ui-scan/0.2 (+https://github.com/WTStarMark/dsh-plugin-mesh)";
/* 证据格式版本：v1 只有文件计数、没有 dsh.client 平台与 exports 入口，不能用来判定。 */
const SCHEMA = 2;

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

const index = loadJson(INDEX, null);
if (!index || !Array.isArray(index.plugins)) {
  console.error("读不到市场索引：" + INDEX);
  process.exit(1);
}
const prev = loadJson(OUT, null);
const cache = prev && prev.packages && typeof prev.packages === "object"
  ? { ...prev, packages: { ...prev.packages } }
  : { version: SCHEMA, updatedAt: null, packages: {} };
cache.version = SCHEMA;
/* 扫描未跑完时 status=running：market-sync 拒绝用半份证据改线上标签。 */
cache.status = "running";

function versionOf(plugin) {
  const v = plugin?.versions?.[0]?.version;
  return typeof v === "string" && v ? v : null;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function fetchJson(url, timeout) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

/** jsDelivr 的 npm 文件清单：一条 JSON，不下载整包。 */
async function jsdelivrFiles(name, version) {
  const doc = await fetchJson("https://data.jsdelivr.com/v1/package/npm/" + name + "@" + version + "/flat", 25000);
  const files = Array.isArray(doc?.files) ? doc.files : null;
  if (!files) throw new Error("jsDelivr 没有 files 数组");
  return files.map((f) => (typeof f === "string" ? f : f && typeof f.name === "string" ? f.name : "")).filter(Boolean);
}

/** unpkg 的 ?meta：同样是文件清单（大包也能列），是 jsDelivr 失败时的第一兜底。 */
async function unpkgFiles(name, version) {
  const doc = await fetchJson("https://unpkg.com/" + name + "@" + version + "/?meta", 60000);
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node.path === "string" && node.type !== "directory") {
      out.push(node.path.replace(/^\/+/, ""));
    }
    for (const child of Array.isArray(node.files) ? node.files : []) walk(child);
  };
  walk(doc);
  if (!out.length) throw new Error("unpkg 没有文件清单");
  return out;
}

/** package.json：dsh.client 声明与 exports["./client"] 入口。 */
async function packageJsonDoc(name, version) {
  const sources = [
    ["jsdelivr", "https://cdn.jsdelivr.net/npm/" + name + "@" + version + "/package.json"],
    ["unpkg", "https://unpkg.com/" + name + "@" + version + "/package.json"],
  ];
  const errors = [];
  for (const [source, url] of sources) {
    try {
      const doc = await fetchJson(url, 20000);
      if (doc && typeof doc === "object" && typeof doc.name === "string") return { source, doc };
      errors.push(source + ": 不是合法 package.json");
    } catch (err) {
      errors.push(source + ": " + err.message);
    }
  }
  return { error: errors.join("；") };
}

async function npmTarball(name, version) {
  const files = await fetchTarball(tarballUrl(name, version));
  return [...files.keys()];
}

async function scanOne(plugin) {
  const name = String(plugin?.name ?? "");
  const version = versionOf(plugin);
  if (!name || !version) return null;
  const old = cache.packages[name];
  /* package.json 没拿到的记录不算完整证据：下次跑时重试（否则 dsh.client 声明读不到，
   * 入口判定会退化成“未验证”，把真界面插件误清掉）。 */
  const complete = old && old.ok === true && !old.pkgError;
  if (!REFRESH && old && old.version === version && old.schema === SCHEMA && (complete || (!RETRY_ERRORS && old.error))) return old;
  const record = { name, version, schema: SCHEMA, ok: false, at: new Date().toISOString() };
  const errors = [];
  let paths = null;
  /* 文件清单：jsDelivr → unpkg → npm tarball（最后兜底，大包可能超上限） */
  for (const [source, load] of [["jsdelivr", jsdelivrFiles], ["unpkg", unpkgFiles], ["tarball", npmTarball]]) {
    try {
      paths = await load(name, version);
      record.source = source;
      break;
    } catch (err) {
      errors.push(source + ": " + err.message);
    }
    if (source === "jsdelivr") await sleep(400);
  }
  if (!paths) {
    record.error = errors.join("；");
    return record;
  }
  const pkg = await packageJsonDoc(name, version);
  if (!pkg.doc) {
    /* 文件清单在、package.json 却 404：多半是索引里的版本已从 npm 下架/撤包。
     * 证据不完整，按“未验证”处理（不猜 dsh.client），不能拿半份证据打「含界面」。 */
    record.pkgError = pkg.error;
    record.error = "package.json 读取失败（索引版本可能已从 npm 下架）：" + pkg.error;
    Object.assign(record, { dshClient: null, platform: null, clientExport: [], clientEntry: null });
    Object.assign(record, analyzeUiFiles(paths));
    return record;
  }
  record.pkgSource = pkg.source;
  Object.assign(record, analyzeClientEntry(pkg.doc, paths));
  Object.assign(record, { ok: true }, analyzeUiFiles(paths));
  return record;
}

const candidates = index.plugins.filter((p) => versionOf(p));
const picked = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
console.log("市场条目 " + index.plugins.length + "，可扫描 " + picked.length + "（并发 " + CONCURRENCY + "，证据格式 v" + SCHEMA + "）");
let cursor = 0;
let done = 0;
let errors = 0;
const startedAt = Date.now();
const sourceCount = {};

async function save() {
  cache.updatedAt = new Date().toISOString();
  cache.index = INDEX;
  atomicWriteText(OUT, JSON.stringify(cache));
}

async function worker() {
  while (cursor < picked.length) {
    const plugin = picked[cursor++];
    let record = null;
    try {
      record = await scanOne(plugin);
    } catch (err) {
      record = { name: String(plugin?.name ?? ""), version: versionOf(plugin), schema: SCHEMA, ok: false, at: new Date().toISOString(), error: String(err?.message ?? err) };
    }
    done += 1;
    if (record) {
      cache.packages[record.name] = record;
      if (record.source) sourceCount[record.source] = (sourceCount[record.source] ?? 0) + 1;
      if (!record.ok) errors += 1;
    }
    if (done % 50 === 0 || done === picked.length) {
      await save();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log("进度 " + done + "/" + picked.length + " · 错误 " + errors + " · " + elapsed + "s");
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
cache.status = "complete";
await save();
const records = Object.values(cache.packages);
const ok = records.filter((r) => r.ok);
const ui = ok.filter((r) => r.uiFiles > 0);
const entry = ok.filter((r) => r.clientEntry);
console.log("完成：" + ok.length + " 条已扫描 / " + records.length + " 条缓存，错误 " + records.filter((r) => !r.ok).length + " 条");
console.log("其中前端资源 " + ui.length + " 条、exports[./client] 入口真实存在 " + entry.length + " 条；文件清单来源 " + JSON.stringify(sourceCount));
console.log("缓存：" + OUT);
