#!/usr/bin/env node
/**
 * 第二遍：对“根目录没有 package.json”的 review 仓库做 GitHub tree 扫描，
 * 找 monorepo 子目录里的 package.json + dsh.bundle.patch，确认插件。
 *
 * 只使用 GitHub REST API 读取 tree 和 raw 文件；不执行任何代码。
 * 用法：
 *   node tools/scan-manifests-tree.mjs --limit 20 --token-file .tmp/github-token
 *   node tools/scan-manifests-tree.mjs --token-file .tmp/github-token --concurrency 4
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./plugin-verifier/lib/manifest.mjs";
import { validatePatchText } from "./plugin-verifier/lib/patch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
const CACHE = resolve(ROOT, argOf("--cache", "data/cache/repo-manifests.json"));
const LIMIT = Math.max(0, Number(argOf("--limit", "0")));
const OFFSET = Math.max(0, Number(argOf("--offset", "0")));
const CONCURRENCY = Math.max(1, Math.min(12, Number(argOf("--concurrency", "4"))));
const TOKEN_FILE = argOf("--token-file", null);
const IDS_FILE = argOf("--ids-file", null);
const TOKEN = TOKEN_FILE ? (await readFile(resolve(ROOT, TOKEN_FILE), "utf8")).trim() : "";
const UA = "dsh-plugin-mesh-tree-scanner/0.1";
const RAW = "https://raw.githubusercontent.com/";
const API = "https://api.github.com/repos/";
const MAX_TREE_ENTRIES = 20000;

const mesh = JSON.parse(await readFile(MESH, "utf8"));
const nodes = mesh.nodes ?? [];
const nodeById = new Map(nodes.map((n) => [n.id, n]));
let cache = { generatedAt: null, repos: {} };
try {
  cache = JSON.parse(await readFile(CACHE, "utf8"));
} catch {
  cache = { generatedAt: null, repos: {} };
}
const reviewNoRoot = Object.entries(cache.repos)
  .filter(([, r]) => r.verdict === "review" && r.rootPackageJson === false && !r.treeBranch)
  .map(([id]) => id);
let idFilter = null;
if (IDS_FILE) {
  const text = await readFile(resolve(ROOT, IDS_FILE), "utf8");
  idFilter = new Set(text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
}
// 无 ids 时只扫“根无 package”；有 ids 时允许指定任意 review 仓库（例如 README 爬虫挑出的根 package 候选）
const pool = idFilter
  ? Object.entries(cache.repos)
      .filter(([, r]) => r.verdict === "review" && !r.treeBranch)
      .map(([id]) => id)
  : reviewNoRoot;
const selected = pool
  .slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined)
  .filter((id) => nodeById.has(id) && (!idFilter || idFilter.has(id)));
console.log("待 tree 扫描 " + selected.length + " / " + reviewNoRoot.length + " 个无根 package 仓库");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, { headers: { authorization: "Bearer " + TOKEN, "user-agent": UA, accept: "application/vnd.github+json" } });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
      const wait = reset > Date.now() ? reset - Date.now() : Math.max(2000, 2 ** attempt * 2000);
      console.log("  API 限流，等待 " + Math.ceil(wait / 1000) + "s");
      await sleep(Math.min(wait, 120000));
      continue;
    }
    if (!res.ok) throw new Error("API HTTP " + res.status + " " + url);
    return res.json();
  }
  return null;
}

async function rawText(url, maxBytes = 1024 * 1024) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("raw HTTP " + res.status);
  const text = await res.text();
  return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
}

async function findTree(owner, name) {
  // 先猜 main/master，省一次 repo 元数据请求；都 404 再查默认分支。
  for (const branch of ["main", "master"]) {
    const tree = await apiGet(API + owner + "/" + name + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1").catch(() => null);
    if (tree && Array.isArray(tree.tree)) return { branch, tree: tree.tree };
  }
  const meta = await apiGet(API + owner + "/" + name).catch(() => null);
  if (!meta?.default_branch) return null;
  const tree = await apiGet(API + owner + "/" + name + "/git/trees/" + encodeURIComponent(meta.default_branch) + "?recursive=1").catch(() => null);
  return tree && Array.isArray(tree.tree) ? { branch: meta.default_branch, tree: tree.tree } : null;
}

async function confirmPackage(owner, name, path) {
  const dir = path === "package.json" ? "" : path.replace(/\/package\.json$/, "");
  const pkgUrl = RAW + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/HEAD/" + path.split("/").map(encodeURIComponent).join("/");
  const text = await rawText(pkgUrl).catch(() => null);
  if (!text) return null;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  const v = validateManifest(manifest, {});
  if (v.errors.length || !v.patchPaths.length) return null;
  const patches = [];
  for (const patchPath of v.patchPaths) {
    const url = RAW + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/HEAD/" + [dir, patchPath].filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/");
    const patchText = await rawText(url).catch(() => null);
    if (!patchText) return null;
    const pr = validatePatchText(patchText, patchPath);
    if (pr.errors.length) return null;
    patches.push({ path: patchPath, ok: true });
  }
  return { name: v.name, dir, patch: v.patchPaths, patches };
}

async function scanRepo(id) {
  const [owner, name] = id.split("/");
  const found = await findTree(owner, name);
  if (!found) return { verdict: "review", rootPackageJson: false, errors: ["无法读取仓库 tree（权限/空仓库/分支）"] };
  const pkgPaths = found.tree
    .map((x) => x.path)
    .filter((p) => typeof p === "string" && /(^|\/)package\.json$/.test(p) && !p.includes("node_modules"))
    .slice(0, 80);
  if (!pkgPaths.length) return { verdict: "review", rootPackageJson: false, treeBranch: found.branch, treePackageJsonCount: 0, errors: ["tree 里没有 package.json"] };
  const packages = [];
  const errors = [];
  for (const p of pkgPaths) {
    try {
      const pkg = await confirmPackage(owner, name, p);
      if (pkg) packages.push(pkg);
    } catch (err) {
      errors.push(p + "：" + err.message);
    }
  }
  if (packages.length) {
    return { verdict: "confirmed", plugin: true, rootPackageJson: false, treeBranch: found.branch, treePackageJsonCount: pkgPaths.length, packages, patches: packages.flatMap((p) => p.patches ?? []) };
  }
  return { verdict: "review", rootPackageJson: false, treeBranch: found.branch, treePackageJsonCount: pkgPaths.length, errors: errors.length ? errors : ["tree 里有 package.json，但没有有效 dsh.bundle.patch"] };
}

async function saveCache() {
  cache.generatedAt = new Date().toISOString();
  await mkdir(dirname(CACHE), { recursive: true });
  const tmp = CACHE + ".tmp";
  await writeFile(tmp, JSON.stringify(cache), "utf8");
  await rename(tmp, CACHE);
}

let index = 0;
let done = 0;
let confirmed = 0;
let review = 0;
async function worker() {
  for (;;) {
    const i = index;
    index += 1;
    if (i >= selected.length) return;
    const id = selected[i];
    let result;
    try {
      result = await scanRepo(id);
    } catch (err) {
      result = { verdict: "review", rootPackageJson: false, errors: ["tree 扫描异常：" + err.message] };
    }
    result.checkedAt = new Date().toISOString();
    cache.repos[id] = result;
    done += 1;
    if (result.verdict === "confirmed") confirmed += 1;
    else review += 1;
    if (done % 10 === 0) {
      await saveCache();
      console.log("  进度 " + done + "/" + selected.length + " | confirmed " + confirmed + " · review " + review + " | " + id);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));
await saveCache();
console.log("完成：扫描 " + done + " | confirmed " + confirmed + " | review " + review);
