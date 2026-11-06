#!/usr/bin/env node
/**
 * 扫描 GitHub 仓库的 package.json / patch，判定是否 DSH 插件（可安装 bundle）。
 *
 * 第一遍只扫仓库根 package.json + 它声明的 patch 文件（raw.githubusercontent，不占 API 配额）；
 * 结果写 data/cache/repo-manifests.json，供 tools/build-plugin-graph.mjs 读取。
 *
 * 用法：
 *   node tools/scan-manifests.mjs --limit 20
 *   node tools/scan-manifests.mjs --concurrency 12
 *   node tools/scan-manifests.mjs --force --offset 0 --limit 0
 *
 * 安全：只读公开仓库；不执行任何包代码；token 只用于 API 备用路径，不打印。
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
const CONCURRENCY = Math.max(1, Math.min(32, Number(argOf("--concurrency", "12"))));
const FORCE = argv.includes("--force");
const IDS_FILE = argOf("--ids-file", null);
const TOKEN_FILE = argOf("--token-file", null);
const TOKEN = TOKEN_FILE ? (await readFile(resolve(ROOT, TOKEN_FILE), "utf8")).trim() : "";

const UA = "dsh-plugin-mesh-manifest-scanner/0.1";
const RAW = "https://raw.githubusercontent.com/";
const MAX_BYTES = 2 * 1024 * 1024;

const mesh = JSON.parse(await readFile(MESH, "utf8"));
const nodes = mesh.nodes ?? [];
let cache = { generatedAt: null, repos: {} };
try {
  cache = JSON.parse(await readFile(CACHE, "utf8"));
  if (!cache.repos) cache.repos = {};
} catch {
  /* 首次运行 */
}
let idFilter = null;
if (IDS_FILE) {
  const text = await readFile(resolve(ROOT, IDS_FILE), "utf8");
  idFilter = new Set(text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
}
const selected = nodes
  .slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined)
  .filter((n) => (!idFilter || idFilter.has(n.id)) && (FORCE || !cache.repos[n.id]));
console.log("待扫描 " + selected.length + " / " + nodes.length + " 个仓库（缓存已有 " + Object.keys(cache.repos).length + "）");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { timeoutMs = 20000, maxBytes = MAX_BYTES } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": UA, ...(TOKEN ? { authorization: "Bearer " + TOKEN } : {}) },
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) {
        const retry = Number(res.headers.get("retry-after") || 0);
        await sleep(Math.max(1000, retry * 1000 || 2 ** attempt * 1000));
        continue;
      }
      if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
      return text;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function scanRepo(node) {
  const [owner, name] = String(node.id).split("/");
  if (!owner || !name) return { verdict: "review", errors: ["非法仓库 id"] };
  const pkgUrl = RAW + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/HEAD/package.json";
  let text;
  try {
    text = await fetchText(pkgUrl);
  } catch (err) {
    return { verdict: "review", errors: ["读取 package.json 失败：" + err.message] };
  }
  if (text === null) {
    return { verdict: "review", rootPackageJson: false, errors: ["仓库根没有 package.json（可能是 monorepo/未发布）"] };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    return { verdict: "review", rootPackageJson: true, errors: ["package.json 不是合法 JSON：" + err.message] };
  }
  const v = validateManifest(manifest, {});
  const packages = [];
  if (!v.errors.length && v.patchPaths.length) {
    const patches = [];
    for (const patchPath of v.patchPaths) {
      const patchUrl = RAW + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/HEAD/" + patchPath.split("/").map(encodeURIComponent).join("/");
      let patchText;
      try {
        patchText = await fetchText(patchUrl, { maxBytes: 1024 * 1024 });
      } catch (err) {
        return { verdict: "review", rootPackageJson: true, errors: ["读取 patch 失败：" + patchPath + "：" + err.message] };
      }
      if (patchText === null) {
        packages.push({ name: v.name, dir: "", patch: v.patchPaths, error: "patch 文件不存在" });
        return { verdict: "review", rootPackageJson: true, packages, errors: ["patch 文件不存在：" + patchPath] };
      }
      const pr = validatePatchText(patchText, patchPath);
      patches.push({ path: patchPath, ok: !pr.errors.length, errors: pr.errors, review: pr.review });
      if (pr.errors.length) {
        packages.push({ name: v.name, dir: "", patch: v.patchPaths, error: pr.errors[0] });
        return { verdict: "review", rootPackageJson: true, packages, errors: pr.errors };
      }
    }
    packages.push({ name: v.name, dir: "", patch: v.patchPaths });
    return { verdict: "confirmed", plugin: true, rootPackageJson: true, packages, patches, manifest: { name: v.name, version: v.version } };
  }
  return {
    verdict: "review",
    rootPackageJson: true,
    packages,
    errors: v.errors.length ? v.errors : ["根 package.json 没有 dsh.bundle.patch"],
    manifest: { name: v.name, version: v.version, dsh: v.dsh ? { bundle: v.dsh.bundle } : null },
  };
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
let failed = 0;
async function worker() {
  for (;;) {
    const i = index;
    index += 1;
    if (i >= selected.length) return;
    const node = selected[i];
    let result;
    try {
      result = await scanRepo(node);
    } catch (err) {
      result = { verdict: "review", errors: ["扫描异常：" + err.message] };
    }
    result.checkedAt = new Date().toISOString();
    cache.repos[node.id] = result;
    done += 1;
    if (result.verdict === "confirmed") confirmed += 1;
    else if (result.verdict === "review") review += 1;
    else failed += 1;
    if (done % 25 === 0) {
      await saveCache();
      console.log("  进度 " + done + "/" + selected.length + " | confirmed " + confirmed + " · review " + review + " · failed " + failed + " | " + node.id);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));
await saveCache();
console.log("完成：扫描 " + done + " | confirmed " + confirmed + " | review " + review + " | failed " + failed);
console.log("缓存 → " + CACHE);
