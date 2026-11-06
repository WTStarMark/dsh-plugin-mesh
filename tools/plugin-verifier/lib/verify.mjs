/**
 * 插件安装前验证器：V0 manifest / V1 tarball / V2 patch 语义。
 * 不安装 DSH、不运行 pnpm、不加载插件代码。
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { validateManifest } from "./manifest.mjs";
import { validatePatchText } from "./patch.mjs";
import { downloadPackage } from "./npm.mjs";

function text(files, path) {
  const buf = files.get(path);
  return buf ? buf.toString("utf8") : null;
}

function merge(target, source) {
  target.checks.push(...(source.checks || []));
  target.errors.push(...(source.errors || []));
  target.warnings.push(...(source.warnings || []));
}

export function verifyFiles(files, options = {}) {
  const {
    kind = "dir",
    label = "",
    dshVersion = null,
    requirePublishable = false,
    graphIds = null,
    requireGraph = false,
    repositoryFallback = null,
  } = options;
  const result = {
    target: { kind, label, name: null, version: null },
    verdict: "rejected",
    level: kind === "npm" ? "V2" : "V1",
    checks: [],
    errors: [],
    warnings: [],
    reviews: [],
    manifest: null,
    patches: [],
    graph: null,
  };
  const manifestText = text(files, "package.json");
  if (!manifestText) {
    result.errors.push("tarball/目录里没有 package.json");
    return result;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    result.errors.push("package.json 不是合法 JSON：" + err.message);
    return result;
  }
  const v = validateManifest(manifest, { dshVersion, requirePublishable, repositoryFallback });
  result.manifest = {
    name: v.name,
    version: v.version,
    repository: v.repository,
    repositoryDirectory: v.repositoryDirectory,
    engines: v.engines,
    private: manifest.private === true,
    dsh: v.dsh ? { manifestVersion: v.dsh.manifestVersion, bundle: v.dsh.bundle, client: v.dsh.client, profile: v.dsh.profile } : null,
  };
  result.target.name = v.name;
  result.target.version = v.version;
  merge(result, v);

  for (const patchPath of v.patchPaths) {
    const patchText = text(files, patchPath);
    if (!patchText) {
      result.errors.push("patch 文件不在 tarball/目录里：" + patchPath);
      continue;
    }
    const pr = validatePatchText(patchText, patchPath);
    merge(result, pr);
    result.patches.push({
      path: patchPath,
      bytes: Buffer.byteLength(patchText, "utf8"),
      items: pr.items || 0,
      inserts: pr.inserts || 0,
      ok: !pr.errors.length,
    });
    if (!pr.errors.length && pr.review) result.reviews.push("patch 没有有效条目：" + patchPath);
  }

  if (v.repository) {
    if (graphIds) {
      const inGraph = graphIds.has(v.repository);
      result.graph = { repoId: v.repository, inGraph };
      if (!inGraph && requireGraph) result.errors.push("GitHub 仓库不在插件图中：" + v.repository);
      else if (!inGraph) result.warnings.push("GitHub 仓库不在图中：" + v.repository);
    } else {
      result.graph = { repoId: v.repository, inGraph: null };
      if (requireGraph) result.errors.push("要求校验 GitHub 仓库，但没有提供 --graph");
      else result.warnings.push("未提供 --graph，跳过 GitHub 仓库互证");
    }
  } else if (requireGraph || requirePublishable) {
    result.errors.push("package.json 缺少可解析的 GitHub repository");
  }

  result.verdict = result.errors.length ? "rejected" : result.reviews.length ? "review" : "confirmed";
  return result;
}

export async function verifyDirectory(dir, options = {}) {
  const abs = resolve(dir);
  const manifestPath = join(abs, "package.json");
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error("目录里没有 package.json：" + abs);
  const manifestText = await readFile(manifestPath, "utf8");
  const files = new Map([["package.json", Buffer.from(manifestText)]]);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    manifest = {};
  }
  const v = validateManifest(manifest, options);
  for (const patchPath of v.patchPaths) {
    const file = resolve(abs, patchPath);
    if (file !== abs && !file.startsWith(abs + sep)) continue;
    const buf = await readFile(file).catch(() => null);
    if (buf) files.set(patchPath, buf);
  }
  return verifyFiles(files, { ...options, kind: "dir", label: abs });
}

export async function verifyNpmPackage(name, version = null, options = {}) {
  let pkg;
  try {
    pkg = await downloadPackage(name, version, options);
  } catch (err) {
    const tooLarge = err && err.code === "RESPONSE_TOO_LARGE";
    return {
      target: { kind: "npm", label: name + (version ? "@" + version : ""), name, version: version || null },
      verdict: "review",
      level: "V0",
      checks: [],
      errors: [],
      warnings: [],
      reviews: [(tooLarge ? "tarball 过大，未下载校验：" : "下载/读取失败：") + (err && err.message ? err.message : String(err))],
      manifest: null,
      patches: [],
      graph: null,
      downloadError: (err && err.code) || "DOWNLOAD",
    };
  }
  const result = verifyFiles(pkg.files, {
    ...options,
    kind: "npm",
    label: name + "@" + pkg.version,
    requirePublishable: true,
    requireGraph: Boolean(options.graphIds),
    repositoryFallback: pkg.manifest?.repository ?? options.repositoryFallback ?? null,
  });
  result.target.name = result.target.name || name;
  result.target.version = result.target.version || pkg.version;
  result.registry = {
    version: pkg.version,
    tarballUrl: pkg.tarballUrl,
    tarballBytes: [...pkg.files.values()].reduce((n, b) => n + b.length, 0),
  };
  if (result.target.name && result.target.name !== name) result.errors.push("tarball 包名与请求不一致：" + result.target.name + " != " + name);
  if (result.target.version && result.target.version !== pkg.version) result.errors.push("tarball 版本与 packument 不一致：" + result.target.version + " != " + pkg.version);
  result.verdict = result.errors.length ? "rejected" : result.reviews.length ? "review" : "confirmed";
  return result;
}
