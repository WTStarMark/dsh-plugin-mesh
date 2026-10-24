/**
 * 索引源的人工裁决与名单：生成器（tools/market-index.mjs）与后台（tools/market-admin.mjs）共用的唯一事实来源。
 *
 * 只做三件事：读、规范化、原子写。绝不打印内容、绝不接受任意路径。
 * 目录：data/admin/market-index/（可用环境变量 MARKET_DIR 覆盖，测试用）。
 *
 * overrides.json 形状（version 1）：
 * {
 *   version: 1,
 *   entries: { "<npm 包名>": { decision: "confirmed"|"refuted"|"unverified", reason?, at?, source? } },
 *   lists: {
 *     blacklistPackages: [],   // 直接不收录（精确包名）
 *     blacklistScopes: [],     // 直接不收录（整个 npm 作用域，如 "@chatcode" → @chatcode/* 全不收录）
 *     blacklistPublishers: [], // 该 npm 发布账号的包：不借仓库身份（展示=驳回）
 *     blacklistRepos: [],      // 该仓库的包：只算未核实（仍显示，但打「作者待确认」）
 *     whitelistRepos: []       // 例外：允许该仓库的包按确证展示（人工背书）
 *   }
 * }
 *
 * 优先级：entries（人工裁决） > lists > 自动核验结论。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DECISIONS = ["confirmed", "refuted", "unverified"];

/** 包名：npm 规则（可带 scope），只收 ASCII 安全字符，长度上限 214。 */
export const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
/** 发布账号：npm 用户名（字母数字与 ._-，最长 214）。 */
export const PUBLISHER_RE = /^[a-z0-9][a-z0-9._-]*$/i;
export const REPO_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function marketPaths(root = DEFAULT_ROOT) {
  const base = process.env.MARKET_DIR ? resolve(process.env.MARKET_DIR) : join(root, "data", "admin", "market-index");
  return {
    dir: base,
    overrides: join(base, "overrides.json"),
    overridesBak: join(base, "overrides.json.bak"),
    job: join(base, "job.json"),
    lastBuild: join(base, "last-build.json"),
    drafts: join(base, "drafts"),
    history: join(base, "history"),
    logDir: join(root, "data", "admin", "logs"),
  };
}

export function emptyOverrides() {
  return {
    version: 1,
    entries: {},
    lists: { blacklistPackages: [], blacklistScopes: [], blacklistPublishers: [], blacklistRepos: [], whitelistRepos: [] },
    labels: { hidden: [] },
  };
}

const cleanStrings = (value, max) => [...new Set((Array.isArray(value) ? value : []).map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, max);

/** 规范化：未知字段丢弃、非法条目丢弃、数组去重限量。永不抛异常（读坏文件时上游按空表处理）。 */
export function normalizeOverrides(raw) {
  const out = emptyOverrides();
  if (!raw || typeof raw !== "object") return out;
  const entries = raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries) ? raw.entries : {};
  for (const [name, value] of Object.entries(entries)) {
    const pkg = String(name ?? "").trim();
    if (!PACKAGE_NAME_RE.test(pkg) || pkg.length > 214) continue;
    if (!value || typeof value !== "object" || !DECISIONS.includes(value.decision)) continue;
    const row = { decision: value.decision };
    if (typeof value.reason === "string" && value.reason.trim()) row.reason = value.reason.trim().slice(0, 300);
    if (typeof value.at === "string" && !Number.isNaN(Date.parse(value.at))) row.at = new Date(value.at).toISOString();
    row.source = "manual";
    out.entries[pkg] = row;
  }
  const lists = raw.lists && typeof raw.lists === "object" && !Array.isArray(raw.lists) ? raw.lists : {};
  out.lists.blacklistPackages = cleanStrings(lists.blacklistPackages, 500).filter((x) => PACKAGE_NAME_RE.test(x) && x.length <= 214);
  /* 作用域黑名单：@chatcode 或 chatcode 都接受，统一存成 "@chatcode"；生成器按前缀直接不收录。 */
  out.lists.blacklistScopes = [
    ...new Set(
      cleanStrings(lists.blacklistScopes, 200)
        .map((x) => x.trim().toLowerCase())
        .map((x) => (x.startsWith("@") ? x : "@" + x))
        .filter((x) => /^@[a-z0-9][a-z0-9-]{0,63}$/u.test(x)),
    ),
  ];
  out.lists.blacklistPublishers = cleanStrings(lists.blacklistPublishers, 500).filter((x) => PUBLISHER_RE.test(x) && x.length <= 214);
  out.lists.blacklistRepos = cleanStrings(lists.blacklistRepos, 500).filter((x) => REPO_ID_RE.test(x));
  out.lists.whitelistRepos = cleanStrings(lists.whitelistRepos, 500).filter((x) => REPO_ID_RE.test(x));
  /* 要隐藏的标签（分类胶囊）：后台「索引源 → 标签」写这里；生成器据此从条目与 metadata.labels 里去掉。
   * 只收合法 id 形状，具体 id 是否已知由后台接口校验（生成器只负责过滤，不因未知 id 报错）。 */
  const labels = raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels) ? raw.labels : {};
  out.labels.hidden = cleanStrings(labels.hidden, 50).filter((x) => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(x));
  return out;
}

/** 被隐藏的标签 id 集合（生成器用）。 */
export function hiddenLabelIds(overrides) {
  const list = overrides && overrides.labels && Array.isArray(overrides.labels.hidden) ? overrides.labels.hidden : [];
  return new Set(list);
}

/** 读：文件缺失/损坏一律当空表（与现有名单同口径，绝不因为一个坏文件把索引生成搞崩）。 */
export function readMarketOverrides(path) {
  try {
    return normalizeOverrides(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyOverrides();
  }
}

/**
 * 原子写：先留一份 .bak（只留一份），再 tmp + rename。
 * 返回 { bytes, backedUp }；写失败抛异常（调用方转成 500，并保留原文件）。
 */
export function saveMarketOverrides(path, value) {
  const doc = normalizeOverrides(value);
  mkdirSync(dirname(path), { recursive: true });
  let backedUp = false;
  if (existsSync(path)) {
    try {
      copyFileSync(path, path + ".bak");
      backedUp = true;
    } catch {
      backedUp = false;
    }
  }
  const text = JSON.stringify(doc, null, 1);
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return { bytes: text.length, backedUp };
}

/** 单条裁决（给生成器/后台用）：返回 null 或规范化后的条目。 */
export function decisionFor(overrides, pkg) {
  const row = overrides && overrides.entries ? overrides.entries[pkg] : null;
  return row && DECISIONS.includes(row.decision) ? row : null;
}

/** 名单命中：返回 { kind, value } 或 null（用于日志/审计说明原因）。 */
/** 包名所属的 npm 作用域（小写，含 @）；无作用域返回 null。 */
export function scopeOfPackage(pkg) {
  const hit = /^(@[^/]+)\//u.exec(String(pkg ?? ""));
  return hit ? hit[1].toLowerCase() : null;
}

/**
 * 人工拉黑判定（生成器与后台共用）：精确包名 → 作用域 → 都没命中返回 null。
 * 返回的是"挡掉原因"文案，直接进构建日志与 skipReasons。
 */
export function packageBlacklistReason(lists, pkg) {
  const name = String(pkg ?? "");
  if ((lists?.blacklistPackages ?? []).includes(name)) return "人工拉黑（包名名单）";
  const scope = scopeOfPackage(name);
  if (scope && (lists?.blacklistScopes ?? []).includes(scope)) return "人工拉黑（作者 " + scope + "）";
  return null;
}

export function listHit(overrides, { pkg, publisher, repoId } = {}) {
  const lists = overrides && overrides.lists ? overrides.lists : {};
  if (pkg && (lists.blacklistPackages ?? []).includes(pkg)) return { kind: "package", value: pkg };
  const scope = pkg ? scopeOfPackage(pkg) : null;
  if (scope && (lists.blacklistScopes ?? []).includes(scope)) return { kind: "scope", value: scope };
  if (publisher && (lists.blacklistPublishers ?? []).includes(publisher)) return { kind: "publisher", value: publisher };
  if (repoId && (lists.blacklistRepos ?? []).includes(repoId)) return { kind: "repo", value: repoId };
  if (repoId && (lists.whitelistRepos ?? []).includes(repoId)) return { kind: "whitelist-repo", value: repoId };
  return null;
}
