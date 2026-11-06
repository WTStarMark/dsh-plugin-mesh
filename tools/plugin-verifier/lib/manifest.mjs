/**
 * DSH 插件 manifest 的声明性校验（对应 @deepseek-ai/dsh-package-manifest 的字段定义）。
 * 只读数据，不执行任何包内代码。
 */

import { posix } from "node:path";
import semver from "semver";

export const DSH_MANIFEST_VERSION = 1;

export function normalizePatchPath(raw) {
  const value = String(raw ?? "").trim();
  if (!value || value.includes("\\") || posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

export function normalizeRepository(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  const cleaned = String(raw).replace(/^git\+/, "").replace(/\.git$/i, "");
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(cleaned);
  if (!match) return null;
  return (match[1] + "/" + match[2]).replace(/\.git$/i, "").toLowerCase();
}

export function validateManifest(manifest, options = {}) {
  const { dshVersion = null, requirePublishable = false, repositoryFallback = null } = options;
  const checks = [];
  const errors = [];
  const warnings = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) errors.push(detail);
  };

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { errors: ["package.json 不是对象"], checks: [{ id: "manifest", ok: false, detail: "package.json 不是对象" }], warnings, patchPaths: [] };
  }
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  check("name", Boolean(name), "缺少 package.json.name");
  check("version", Boolean(version), "缺少 package.json.version");
  if (requirePublishable) check("publishable", manifest.private !== true, "package.json.private=true，不可发布到 npm");

  const dsh = manifest.dsh;
  check("dsh-object", Boolean(dsh && typeof dsh === "object" && !Array.isArray(dsh)), "缺少 dsh 对象");
  if (dsh && typeof dsh === "object" && !Array.isArray(dsh)) {
    if (dsh.manifestVersion !== undefined) {
      check("manifest-version", dsh.manifestVersion === DSH_MANIFEST_VERSION, "dsh.manifestVersion 必须是 " + DSH_MANIFEST_VERSION);
    }
    check("bundle-object", Boolean(dsh.bundle && typeof dsh.bundle === "object" && !Array.isArray(dsh.bundle)), "缺少 dsh.bundle 对象");
    if (dsh.client !== undefined) warnings.push("声明了 dsh.client；它单独不构成可安装插件，仅记录");
    if (dsh.profile !== undefined) warnings.push("声明了 dsh.profile；它是 profile 组合，不是插件判定依据");
  }

  const bundle = dsh && typeof dsh === "object" ? dsh.bundle : null;
  const patchRaw = bundle && typeof bundle === "object" ? bundle.patch : null;
  let patchList = [];
  if (typeof patchRaw === "string") patchList = [patchRaw];
  else if (Array.isArray(patchRaw)) patchList = patchRaw;
  check("bundle-patch-declared", patchList.length > 0, "dsh.bundle.patch 必须是非空字符串或非空字符串数组");
  patchList = patchList.filter((x) => typeof x === "string" && x.trim());
  check("bundle-patch-nonempty", patchList.length > 0, "dsh.bundle.patch 含空值或全部不是字符串");

  const patchPaths = [];
  for (const raw of patchList) {
    const normalized = normalizePatchPath(raw);
    if (!normalized) errors.push("非法 patch 路径：" + String(raw));
    else patchPaths.push(normalized);
  }
  check("bundle-patch-path", errors.every((e) => !e.startsWith("非法 patch 路径")), "存在非法 patch 路径");

  let engines = null;
  const enginesDsh = manifest.engines && typeof manifest.engines === "object" ? manifest.engines.dsh : undefined;
  if (enginesDsh !== undefined) {
    const range = typeof enginesDsh === "string" ? semver.validRange(enginesDsh) : null;
    check("engines-dsh-syntax", Boolean(range), "engines.dsh 不是合法 semver range：" + String(enginesDsh));
    if (range) {
      engines = { dsh: enginesDsh };
      if (dshVersion) {
        const ok = semver.satisfies(dshVersion, range, { includePrerelease: true });
        check("engines-dsh-compatible", ok, "engines.dsh=" + enginesDsh + " 与当前 DSH " + dshVersion + " 不兼容");
      } else {
        warnings.push("engines.dsh 已记录，但未提供 --dsh-version，未做兼容性判定");
      }
    }
  } else {
    warnings.push("未声明 engines.dsh；官方安装通常允许，但兼容性未知");
  }

  // tarball 里的 package.json 可能省略 repository；registry 的版本 manifest 常有，作为互证兜底
  const repository = normalizeRepository(manifest.repository) || normalizeRepository(repositoryFallback);
  const repositoryDirectory = typeof manifest.repository === "object" && typeof manifest.repository?.directory === "string" ? manifest.repository.directory : null;
  return { name, version, dsh, bundle, patchPaths, engines, repository, repositoryDirectory, checks, errors, warnings };
}
