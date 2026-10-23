#!/usr/bin/env node
/**
 * 子目录归属校验：npm 包自己声明的 repository.directory 到底是不是真的。
 *
 * 为什么需要（线上实测）：市场索引按 npm 包名收录，归属证据只有一条 —— 包在 packument 里
 * 自述的 repository。有人把 repository 写成 github.com/deepseek-ai/deepseek-harness、
 * directory 写成 .dsh/plugins/dsh-ab-wechat-scrape（那是发布者本机 DSH_HOME 的路径，
 * 官方仓库里根本没有这个目录，历史上也没有），索引就把官方仓库的标题、头像、作者、25 万星标
 * 一起搬到了第三方包前面，还因为「自述仓库 == 认领仓库」被判成「确证」。
 *
 * 本模块只回答一个问题：打开 repo/directory/package.json，里面声明的 name 是不是
 * 就是这个包名。
 *   · 是             -> confirmed：仓库里确实住着这个包，可以外借仓库身份；
 *   · 本地路径       -> refuted  ：repository.directory 的定义是仓库内相对路径；
 *   · 目录不存在     -> 看历史：
 *       · 历史里出现过 -> moved/unverified：只是后来改目录了，包多半是正经的，照旧显示但打「作者待确认」；
 *       · 历史里也没有 -> refuted：这个位置从来没有过，索引不再外借仓库身份；
 *   · 网络/限流/未知 -> unverified：只打「作者待确认」，不改写已有结论、也不当否定。
 *
 * 几个刻意的取舍：
 * - 只信 200 + name 一致。200 但没 name、name 对不上都只算 unverified，不算 refuted：
 *   包改名、目录挪走之后老版本仍可能合法发布过，不能凭现在对不上就判假。
 * - 目录 404 才算 refuted：对一份一键安装清单来说，继续外借一个已经不存在的仓库位置，
 *   比少显示一个作者更糟。
 * - 本地路径不联网直接判 refuted，而且上级目录、绝对路径、Windows 盘符、反斜杠一律按本地对待。
 * - 请求失败不污染结论：失败时沿用缓存里的旧结果（哪怕过期），缓存里也没有才记 unverified。
 * - 结果按 repo#dir 缓存（data/cache/repo-dirs.json，不入库）：7 天有效，错误 6 小时后重试。
 *
 * 测试：tests/repo-dir-verify.test.mjs（全部注入 fetchImpl，不联网）。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** 缓存格式版本：改了怎么判定/怎么读就升，老缓存整体作废。 */
export const REPO_DIR_CACHE_VERSION = 1;
/** 确证/不存在的结论保留多久：仓库目录搬迁不频繁，7 天足够，也把 GitHub 配额压到 ~80 次/轮。 */
export const REPO_DIR_TTL_MS = 7 * 24 * 3600 * 1000;
/** 失败（网络/限流/5xx）结论 6 小时后重试，别把一次断网记成一周的结论。 */
export const REPO_DIR_ERROR_TTL_MS = 6 * 3600 * 1000;
export const REPO_DIR_CHECK_CONCURRENCY = 4;
/** 缓存条目最长保留 90 天：包名/目录会不断更替，不清理的话缓存文件只增不减。 */
export const REPO_DIR_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
export const REPO_DIR_UA = "dsh-plugin-mesh-market-index/0.1 (+https://github.com/WTStarMark/dsh-plugin-mesh)";

/** 归属判定只有三种结果，没有"大概是"。 */
export const VERDICT = {
  /** 目录里的 package.json 确实声明了这个包名 */
  CONFIRMED: "confirmed",
  /** 没查到/查不了 —— 不确证也不否定 */
  UNVERIFIED: "unverified",
  /** 自述的位置不成立（目录不存在 / 是本地路径）—— 不许再外借仓库身份 */
  REFUTED: "refuted",
};

/**
 * 从任意 repository 写法里取 owner/repo（小写）：支持 "git+https://…"、"git@github.com:…"、
 * {url, directory}、以及 GitHub 网页 URL；取不到返回 null（相对路径、非 GitHub 都算取不到）。
 */
export function repoKeyFromUrl(value) {
  const raw = typeof value === "string" ? value : value && typeof value === "object" ? value.url ?? "" : "";
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const hit = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(text);
  return hit ? (hit[1] + "/" + hit[2]).toLowerCase() : null;
}

/** 把 repository.directory 收成「仓库内相对路径」或「本地路径」。 */
export function classifyRepositoryDirectory(directory) {
  const raw = typeof directory === "string" ? directory.trim() : "";
  if (!raw) return { kind: "absent", reason: null };
  // 开头的 ./ 与没有它等价；但 ./.dsh/... 仍然要按本地路径处理
  const stripped = raw.replace(/^[.]\//u, "").replace(/^\/+|\/+$/gu, "");
  const lower = stripped.toLowerCase();
  // DSH_HOME 的插件目录：发布者本机的 .dsh/plugins/... 被当成了仓库目录（线上实测的冒名来源）
  if (lower === ".dsh" || lower.startsWith(".dsh/") || lower.startsWith(".dsh" + String.fromCharCode(92))) {
    return { kind: "local", reason: "dsh-home-path" };
  }
  if (/^[a-zA-Z]:[\\/]/u.test(raw)) return { kind: "local", reason: "windows-absolute" };
  if (raw.startsWith("/")) return { kind: "local", reason: "absolute-path" };
  if (raw.startsWith(String.fromCharCode(92))) return { kind: "local", reason: "absolute-path" };
  if (raw.startsWith("~")) return { kind: "local", reason: "home-path" };
  if (raw.includes(String.fromCharCode(92))) return { kind: "local", reason: "backslash-path" };
  if (stripped.split("/").some((seg) => seg === "..")) return { kind: "local", reason: "parent-escape" };
  if (!stripped || stripped === ".") return { kind: "absent", reason: null };
  return { kind: "repo", reason: null };
}

/** 缓存 key：仓库大小写不敏感，目录按字面（同一仓库里大小写不同就是不同目录）。
 *  没有目录的包用 `repo#::包名`，与目录结论分开存。 */
export function repoDirCacheKey(repoKey, directory, pkg = "") {
  const repo = String(repoKey ?? "").toLowerCase();
  const dir = String(directory ?? "")
    .trim()
    .replace(/^[.]\//u, "")
    .replace(/\/+$/u, "");
  if (dir) return repo + "#" + dir;
  return repo + "#::" + String(pkg ?? "").trim();
}

function cacheEntryFresh(entry, now, ttlMs, errorTtlMs) {
  const at = Date.parse(String(entry?.at ?? ""));
  if (!Number.isFinite(at)) return false;
  const age = Math.max(0, now - at);
  // 失败/暂无数（error / nodir）6 小时后就重试；确证、驳回、搬走这类结论 7 天有效。
  const ttl = entry?.state === "error" || entry?.state === "nodir" ? errorTtlMs : ttlMs;
  return age < ttl;
}

/** 读缓存；文件缺失/损坏一律当空表 —— 校验是可选增强，不能因为它把索引生成搞崩。 */
export function readRepoDirCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && data.entries && typeof data.entries === "object") {
      return { version: REPO_DIR_CACHE_VERSION, updatedAt: data.updatedAt ?? null, entries: data.entries };
    }
  } catch {
    /* 落空表 */
  }
  return { version: REPO_DIR_CACHE_VERSION, updatedAt: null, entries: {} };
}

/** 原子写缓存（同目录 .tmp + rename），写到一半被杀也不会留半截 JSON。 */
export function writeRepoDirCache(file, cache) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = JSON.stringify({
    version: REPO_DIR_CACHE_VERSION,
    updatedAt: cache?.updatedAt ?? new Date().toISOString(),
    entries: cache?.entries ?? {},
  });
  const tmp = file + ".tmp";
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
  return payload.length;
}

/** 令牌只从进程环境或 .env 读，绝不打印内容；读不到返回 null（调用方决定是否跳过校验）。 */
export function loadGitHubToken({ env = {}, envFile = null } = {}) {
  const fromEnv = String(env?.GITHUB_TOKEN ?? env?.GH_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  if (!envFile) return null;
  let text = "";
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim().replace(/^export\s+/u, "");
    if (key !== "GITHUB_TOKEN" && key !== "GH_TOKEN") continue;
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    if (value) return value;
  }
  return null;
}

/**
 * 校验结论 -> 三档判定。pkg 是 npm 包名（大小写不敏感比较：npm 包名规范里本来就只允许小写，
 * 但缓存/历史数据里出现过大小写混写，比较时统一小写）。
 */
export function judgeSubdirCheck(entry, pkg, repoKey = null) {
  if (!entry) return { verdict: VERDICT.UNVERIFIED, reason: "not-checked" };
  if (entry.state === "local") return { verdict: VERDICT.REFUTED, reason: "local-path:" + String(entry.reason ?? "local") };
  /* 目录现在不存在、但历史提交里出现过 = 后来搬走了，不驳回（只算未核实）；从没出现过才驳回。 */
  if (entry.state === "moved") return { verdict: VERDICT.UNVERIFIED, reason: "directory-moved" };
  if (entry.state === "missing") return { verdict: VERDICT.REFUTED, reason: "directory-missing" };
  /* 没有目录声明的包：仓库里搜不到声明的 package.json，且发布账号也不是仓库主人、gitHead 也不在仓库里
   * —— 三条证据凑齐就驳回（dsh-market-plus / @chatcode/* 属于这一类）。 */
  if (entry.state === "absent") return { verdict: VERDICT.REFUTED, reason: "not-in-repo:" + String(entry.reason ?? "absent") };
  /* 没有目录声明、暂时拿不到结论：保留展示但打「作者待确认」，不当确证、也不驳回。 */
  if (entry.state === "nodir") return { verdict: VERDICT.UNVERIFIED, reason: "no-directory:" + String(entry.reason ?? "unknown") };
  if (entry.state === "verified") {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return { verdict: VERDICT.UNVERIFIED, reason: "package-json-without-name" };
    if (name.toLowerCase() !== String(pkg ?? "").trim().toLowerCase()) {
      return { verdict: VERDICT.UNVERIFIED, reason: "package-name-mismatch" };
    }
    /* 第二重：目录里的 package.json 自己写的 repository 必须指向同一个仓库。
     * monorepo 里常见的 {url, directory} / "git+https://…" 都能解析；相对路径取不到 key 就不管。 */
    const declaredRepo = repoKeyFromUrl(entry.repository);
    if (repoKey && declaredRepo && declaredRepo !== String(repoKey).toLowerCase()) {
      return { verdict: VERDICT.UNVERIFIED, reason: "package-json-repository-mismatch" };
    }
    return { verdict: VERDICT.CONFIRMED, reason: "package-json-name" };
  }
  return { verdict: VERDICT.UNVERIFIED, reason: String(entry.reason ?? entry.state ?? "unknown") };
}

/**
 * GitHub contents API 的取数器：读 repo/directory/package.json 的原始内容。
 * 返回 { state: "verified", name } / { state: "missing" } / { state: "error", reason }。
 * 404 = 目录里没有 package.json；403/429 且配额为 0 = 限流（别把限流当不存在）。
 */
export function createGitHubPackageJsonFetcher({
  token = null,
  fetchImpl = globalThis.fetch,
  userAgent = REPO_DIR_UA,
  sleepFn = (ms) => new Promise((done) => setTimeout(done, ms)),
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createGitHubPackageJsonFetcher 需要 fetch");
  const headers = { Accept: "application/vnd.github.raw", "User-Agent": userAgent };
  if (token) headers.Authorization = "Bearer " + token;
  return async function fetchPackageJson(repoKey, directory) {
    const parts = String(directory ?? "")
      .replace(/^[.]\//u, "")
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .filter(Boolean);
    if (!parts.length) return { state: "error", reason: "empty-directory" };
    const url =
      "https://api.github.com/repos/" +
      String(repoKey ?? "").trim() +
      "/contents/" +
      parts.map(encodeURIComponent).join("/") +
      "/package.json";
    let last = "unknown";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (err) {
        last = "network:" + String(err?.name ?? "Error");
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      const status = Number(response?.status) || 0;
      if (status === 200) {
        const text = await response.text();
        try {
          const doc = JSON.parse(text);
          return {
            state: "verified",
            name: typeof doc?.name === "string" ? doc.name : null,
            version: typeof doc?.version === "string" ? doc.version : null,
            // package.json 自己的 repository 字段：与声称仓库不一致 = 这份 package.json 不是给这个仓库写的
            repository: doc?.repository ?? null,
          };
        } catch {
          return { state: "error", reason: "bad-json" };
        }
      }
      if (status === 404) return { state: "missing" };
      const remaining = typeof response?.headers?.get === "function" ? response.headers.get("x-ratelimit-remaining") : null;
      if (status === 403 || status === 429) {
        if (remaining === "0") return { state: "error", reason: "rate-limited" };
        last = "http-" + status;
        await sleepFn(1500 * (attempt + 1));
        continue;
      }
      last = "http-" + status;
      if (status >= 500) {
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      return { state: "error", reason: last };
    }
    return { state: "error", reason: last };
  };
}

/**
 * 目录历史取数器：GET /repos/{repo}/commits?path={directory}&per_page=1。
 * 目录现在不存在时用它区分「后来搬走了」（历史里有提交）和「从来没有过」（历史也空）。
 * 只认 200 + 数组：空数组 = 从没出现过；网络/限流/404 仓库没了 = 拿不到结论（不当否定）。
 */
export function createGitHubDirectoryHistoryFetcher({
  token = null,
  fetchImpl = globalThis.fetch,
  userAgent = REPO_DIR_UA,
  sleepFn = (ms) => new Promise((done) => setTimeout(done, ms)),
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createGitHubDirectoryHistoryFetcher 需要 fetch");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": userAgent };
  if (token) headers.Authorization = "Bearer " + token;
  return async function fetchDirectoryHistory(repoKey, directory) {
    const parts = String(directory ?? "")
      .replace(/^[.]\//u, "")
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .filter(Boolean);
    if (!parts.length) return { state: "none" };
    const url =
      "https://api.github.com/repos/" +
      String(repoKey ?? "").trim() +
      "/commits?path=" +
      parts.map(encodeURIComponent).join("/") +
      "&per_page=1";
    let last = "unknown";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (err) {
        last = "network:" + String(err?.name ?? "Error");
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      const status = Number(response?.status) || 0;
      if (status === 200) {
        try {
          const list = JSON.parse(await response.text());
          return { state: Array.isArray(list) && list.length > 0 ? "history" : "none" };
        } catch {
          return { state: "error", reason: "bad-json" };
        }
      }
      const remaining = typeof response?.headers?.get === "function" ? response.headers.get("x-ratelimit-remaining") : null;
      if (status === 403 || status === 429) {
        if (remaining === "0") return { state: "error", reason: "rate-limited" };
        last = "http-" + status;
        await sleepFn(1500 * (attempt + 1));
        continue;
      }
      if (status >= 500) {
        last = "http-" + status;
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      return { state: "error", reason: status === 404 ? "repo-missing" : "http-" + status };
    }
    return { state: "error", reason: last };
  };
}

/**
 * GitHub code search 取数器：没有 repository.directory 的包，用「仓库里有没有一个声明了这个包名的
 * package.json」来判真伪。查询带 `filename:package.json` 缩进，只认 package.json 里的命中；
 * 命中后调用方还要拉那个文件核对 name（docs/README 里提到的名字不算）。
 *
 * 为什么要限速：code search 配额是 10 次/分钟（认证后），比 core 配额紧得多；
 * 默认 7 秒一次，只对高星候选跑，结果进缓存后不再重复。
 */
export function createGitHubCodeSearchFetcher({
  token = null,
  fetchImpl = globalThis.fetch,
  userAgent = REPO_DIR_UA,
  sleepFn = (ms) => new Promise((done) => setTimeout(done, ms)),
  minIntervalMs = 7000,
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createGitHubCodeSearchFetcher 需要 fetch");
  const headers = { Accept: "application/vnd.github.text-match+json", "User-Agent": userAgent };
  if (token) headers.Authorization = "Bearer " + token;
  let lastAt = 0;
  return async function searchPackageInRepo(repoKey, pkg) {
    const wait = minIntervalMs - (Date.now() - lastAt);
    if (wait > 0) await sleepFn(wait);
    lastAt = Date.now();
    const query = 'repo:' + String(repoKey ?? "").trim() + ' filename:package.json "' + String(pkg ?? "").trim() + '"';
    const url = "https://api.github.com/search/code?q=" + encodeURIComponent(query);
    let last = "unknown";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (err) {
        last = "network:" + String(err?.name ?? "Error");
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      const status = Number(response?.status) || 0;
      if (status === 200) {
        try {
          const data = JSON.parse(await response.text());
          const items = Array.isArray(data?.items) ? data.items : [];
          /* 命中可能不止一个：有的是"依赖里提到这个名字"的 package.json（根包/聚合包），
           * 有的是它自己的 package.json。全带回去，调用方逐个核 name 直到对上。 */
          const paths = items
            .map((item) => (typeof item?.path === "string" ? item.path : ""))
            .filter((path) => /(^|\/)package\.json$/u.test(path))
            .slice(0, 10);
          return paths.length ? { state: "found", paths, path: paths[0] } : { state: "none" };
        } catch {
          return { state: "error", reason: "bad-json" };
        }
      }
      const remaining = typeof response?.headers?.get === "function" ? response.headers.get("x-ratelimit-remaining") : null;
      if (status === 403 || status === 429) {
        if (remaining === "0") return { state: "error", reason: "rate-limited" };
        last = "http-" + status;
        await sleepFn(8000 * (attempt + 1));
        continue;
      }
      if (status >= 500) {
        last = "http-" + status;
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      return { state: "error", reason: "http-" + status };
    }
    return { state: "error", reason: last };
  };
}

/**
 * 提交存在性取数器：GET /repos/{repo}/commits/{sha}。
 * 200 = 这个 gitHead 确实在声称的仓库里；422/404 = 不在（发布者是从别的仓库发出来的包）。
 */
export function createGitHubCommitFetcher({
  token = null,
  fetchImpl = globalThis.fetch,
  userAgent = REPO_DIR_UA,
  sleepFn = (ms) => new Promise((done) => setTimeout(done, ms)),
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createGitHubCommitFetcher 需要 fetch");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": userAgent };
  if (token) headers.Authorization = "Bearer " + token;
  return async function commitExists(repoKey, sha) {
    if (!sha) return { state: "missing" };
    const url = "https://api.github.com/repos/" + String(repoKey ?? "").trim() + "/commits/" + encodeURIComponent(String(sha));
    let last = "unknown";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (err) {
        last = "network:" + String(err?.name ?? "Error");
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      const status = Number(response?.status) || 0;
      if (status === 200) return { state: "exists" };
      if (status === 422 || status === 404) return { state: "missing" };
      const remaining = typeof response?.headers?.get === "function" ? response.headers.get("x-ratelimit-remaining") : null;
      if (status === 403 || status === 429) {
        if (remaining === "0") return { state: "error", reason: "rate-limited" };
        last = "http-" + status;
        await sleepFn(1500 * (attempt + 1));
        continue;
      }
      if (status >= 500) {
        last = "http-" + status;
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      return { state: "error", reason: "http-" + status };
    }
    return { state: "error", reason: last };
  };
}

/**
 * 跑一批校验。targets: [{ pkg, repoKey, directory }]；directory 为空的是「没有目录声明」的包，
 * 走 code search + gitHead 证据链（见 createGitHubCodeSearchFetcher）。
 * 返回 { cache, results: Map<pkg, entry>, stats }；results 里没有的 target 表示没有目录可查。
 * 注入 fetchPackageJson 让测试完全不联网。
 */
export async function runSubdirVerification({
  targets = [],
  cache = null,
  fetchPackageJson,
  fetchDirectoryHistory = null,
  fetchCodeSearch = null,
  fetchCommitExists = null,
  now = Date.now(),
  ttlMs = REPO_DIR_TTL_MS,
  errorTtlMs = REPO_DIR_ERROR_TTL_MS,
  concurrency = REPO_DIR_CHECK_CONCURRENCY,
  maxCacheAgeMs = REPO_DIR_MAX_AGE_MS,
  log = () => {},
} = {}) {
  const base = cache && cache.entries && typeof cache.entries === "object" ? cache : { version: REPO_DIR_CACHE_VERSION, updatedAt: null, entries: {} };
  const entries = { ...base.entries };
  const results = new Map();
  const stats = { targets: 0, local: 0, cached: 0, fetched: 0, missing: 0, moved: 0, newMoved: 0, errors: 0, verified: 0, codeSearch: 0, codeConfirmed: 0, codeAbsent: 0, codeUnverified: 0 };
  const queue = [];
  const codeQueue = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const pkg = String(target?.pkg ?? "").trim();
    if (!pkg) continue;
    stats.targets += 1;
    const directory = String(target?.directory ?? "").trim();
    const cls = classifyRepositoryDirectory(directory);
    if (cls.kind === "local") {
      const at = new Date(now).toISOString();
      const entry = { state: "local", reason: cls.reason, at, repoKey: String(target?.repoKey ?? ""), directory };
      entries[repoDirCacheKey(target?.repoKey, directory)] = entry;
      results.set(pkg, entry);
      stats.local += 1;
      continue;
    }
    if (cls.kind !== "repo") {
      /* 没有 repository.directory 的包：没目录可查，改用 code search + gitHead 证据链。
       * 调用方没注入 fetchCodeSearch（或不是高星候选）时整条跳过，由调用方按"未核实"处理。 */
      if (!target?.repoKey || typeof fetchCodeSearch !== "function") continue;
      const key = repoDirCacheKey(target.repoKey, "", pkg);
      const cached = entries[key];
      if (cached && cacheEntryFresh(cached, now, ttlMs, errorTtlMs)) {
        results.set(pkg, cached);
        stats.cached += 1;
        continue;
      }
      codeQueue.push({ pkg, key, repoKey: String(target.repoKey), gitHead: target.gitHead ?? null, publisher: target.publisher ?? null, cached: cached ?? null });
      continue;
    }
    const key = repoDirCacheKey(target.repoKey, directory);
    const cached = entries[key];
    if (cached && cacheEntryFresh(cached, now, ttlMs, errorTtlMs)) {
      results.set(pkg, cached);
      stats.cached += 1;
      continue;
    }
    queue.push({ pkg, key, repoKey: String(target.repoKey), directory, cached: cached ?? null });
  }
  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || REPO_DIR_CHECK_CONCURRENCY));
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      const job = queue[index];
      let outcome;
      try {
        outcome = await fetchPackageJson(job.repoKey, job.directory);
      } catch (err) {
        outcome = { state: "error", reason: "fetch-threw:" + String(err?.name ?? "Error") };
      }
      const at = new Date(now).toISOString();
      let entry;
      if (outcome?.state === "verified") {
        entry = {
          state: "verified",
          name: typeof outcome.name === "string" ? outcome.name : null,
          version: typeof outcome.version === "string" ? outcome.version : null,
          repository: outcome.repository ?? null,
          at,
          repoKey: job.repoKey,
          directory: job.directory,
        };
        stats.fetched += 1;
      } else if (outcome?.state === "missing") {
        /* 目录现在没有：如果历史提交里出现过，就是"后来搬走了"，不能当冒充驳回；
         * 历史也空的才算声称了一个从来没存在过的位置。历史查不到（网络/限流）时退回 error。 */
        let history = null;
        if (typeof fetchDirectoryHistory === "function") {
          try {
            history = await fetchDirectoryHistory(job.repoKey, job.directory);
          } catch (err) {
            history = { state: "error", reason: "fetch-threw:" + String(err?.name ?? "Error") };
          }
        }
        if (history?.state === "history") {
          entry = { state: "moved", at, repoKey: job.repoKey, directory: job.directory };
          stats.newMoved += 1;
        } else if (history?.state === "none" || history === null) {
          entry = { state: "missing", at, repoKey: job.repoKey, directory: job.directory };
          stats.missing += 1;
        } else {
          stats.errors += 1;
          entry = job.cached ?? { state: "error", reason: String(history.reason ?? "history-unknown"), at, repoKey: job.repoKey, directory: job.directory };
        }
      } else {
        stats.errors += 1;
        entry = job.cached ?? { state: "error", reason: String(outcome?.reason ?? "unknown"), at, repoKey: job.repoKey, directory: job.directory };
      }
      entries[job.key] = entry;
      results.set(job.pkg, entry);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  /* code search 串行跑：自带 7 秒限速（GitHub 10 次/分钟），只对高星无目录候选生效。
   * 命中 -> 拉命中路径的 package.json 核对 name（docs 里提到不算）；没命中 -> 看 gitHead 与发布账号：
   * 仓库里搜不到 + 发布账号不是仓库主人 + gitHead 也不在仓库里 = 三条证据齐了才驳回。 */
  for (const job of codeQueue) {
    const at = new Date(now).toISOString();
    let search = { state: "error", reason: "no-fetcher" };
    try {
      search = await fetchCodeSearch(job.repoKey, job.pkg);
    } catch (err) {
      search = { state: "error", reason: "fetch-threw:" + String(err?.name ?? "Error") };
    }
    stats.codeSearch += 1;
    let entry;
    if (search?.state === "found" && (Array.isArray(search.paths) ? search.paths.length : typeof search.path === "string")) {
      const paths = Array.isArray(search.paths) && search.paths.length ? search.paths : [search.path];
      let name = null;
      let directory = null;
      /* 逐个候选核 name：第一个命中常常是"聚合包/根包的 package.json"（在 dependencies 里提到这个名字），
       * 不是它自己的 manifest。最多试 5 个，对上为止。 */
      for (const path of paths.slice(0, 5)) {
        const dir = String(path).replace(/\/?package\.json$/u, "");
        try {
          const pj = await fetchPackageJson(job.repoKey, dir);
          if (pj?.state === "verified" && typeof pj.name === "string" && pj.name.trim().toLowerCase() === job.pkg.toLowerCase()) {
            name = pj.name;
            directory = dir;
            break;
          }
        } catch {
          /* 单个候选失败继续试下一个 */
        }
      }
      if (name) {
        entry = { state: "verified", name, at, repoKey: job.repoKey, directory, via: "code-search" };
        stats.codeConfirmed += 1;
      } else {
        entry = { state: "nodir", reason: "code-search-hit-unconfirmed", at, repoKey: job.repoKey, pkg: job.pkg };
        stats.codeUnverified += 1;
      }
    } else if (search?.state === "none") {
      const owner = String(job.repoKey).split("/")[0] ?? "";
      const publisher = String(job.publisher ?? "").trim();
      const publisherIsOwner = Boolean(publisher) && publisher.toLowerCase() === owner.toLowerCase();
      const publisherIsCI = publisher.toLowerCase() === "github actions";
      let commit = null;
      if (job.gitHead && typeof fetchCommitExists === "function") {
        try {
          commit = await fetchCommitExists(job.repoKey, job.gitHead);
        } catch {
          commit = { state: "error" };
        }
      }
      const publisherMismatch = Boolean(publisher) && !publisherIsOwner && !publisherIsCI;
      if (publisherMismatch && commit?.state !== "exists") {
        entry = { state: "absent", reason: "not-in-repo+publisher-mismatch", at, repoKey: job.repoKey, pkg: job.pkg };
        stats.codeAbsent += 1;
      } else {
        entry = { state: "nodir", reason: commit?.state === "exists" ? "published-from-repo-not-in-tree" : "no-evidence", at, repoKey: job.repoKey, pkg: job.pkg };
        stats.codeUnverified += 1;
      }
    } else {
      stats.errors += 1;
      entry = job.cached ?? { state: "nodir", reason: "code-search-" + String(search?.reason ?? "error"), at, repoKey: job.repoKey, pkg: job.pkg };
      stats.codeUnverified += 1;
    }
    entries[job.key] = entry;
    results.set(job.pkg, entry);
  }

  for (const entry of results.values()) {
    if (entry.state === "verified") stats.verified += 1;
    if (entry.state === "moved") stats.moved += 1; // 含缓存命中的搬走结论，日志里的数字才是本轮真实分布
  }
  /* 清理长期没再出现的条目：缓存只服务本轮出现过的包，90 天没被碰过的结论不必留着。 */
  for (const [key, entry] of Object.entries(entries)) {
    if (!cacheEntryFresh(entry, now, maxCacheAgeMs, maxCacheAgeMs)) delete entries[key];
  }
  const out = { version: REPO_DIR_CACHE_VERSION, updatedAt: new Date(now).toISOString(), entries };
  const codeNote = stats.codeSearch
    ? " · 无目录代码检索 " + stats.codeSearch + " 条（命中 " + stats.codeConfirmed + " / 驳回 " + stats.codeAbsent + " / 待确认 " + stats.codeUnverified + "）"
    : "";
  log(
    "子目录校验：" + stats.targets + " 条待查（确证 " + stats.verified + " · 目录搬走 " + stats.moved + " · 目录不存在 " + stats.missing +
      " · 本地路径 " + stats.local + " · 缓存命中 " + stats.cached + " · 新请求 " + (stats.fetched + stats.missing + stats.newMoved) +
      " · 失败 " + stats.errors + codeNote + "）",
  );
  return { cache: out, results, stats };
}

/* ============================================================================================
 * npm 发布溯源（provenance）校验：密码学级别的"这个版本确实从声称仓库的 CI 发布出来"
 *
 * npm 对走 trusted publishing（GitHub Actions OIDC）的包会附带 SLSA provenance：
 *   GET https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<version>
 * 里面 slsa.dev/provenance/v1 的 payload（base64）带 buildDefinition：
 *   externalParameters.workflow.repository = https://github.com/<owner>/<repo>
 *   resolvedDependencies[0].uri              = git+https://github.com/<owner>/<repo>@refs/tags/…
 *   resolvedDependencies[0].digest.gitCommit = <sha>
 * 这份声明由 npm 侧签名，伪造不了 —— 仓库对得上就是最强证据，对不上就是最强反证。
 *
 * 注意：只有部分包有 provenance（走 CI 发布的）。没有 = 中性（不确证也不否定），不能当反证。
 * ============================================================================================ */

export const PROVENANCE_CACHE_VERSION = 1;
export const PROVENANCE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PROVENANCE_ERROR_TTL_MS = 24 * 3600 * 1000;

export function provenanceCacheKey(pkg, version) {
  return String(pkg ?? "").trim() + "@" + String(version ?? "").trim();
}

export function readProvenanceCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && data.entries && typeof data.entries === "object") {
      return { version: PROVENANCE_CACHE_VERSION, updatedAt: data.updatedAt ?? null, entries: data.entries };
    }
  } catch {
    /* 空表 */
  }
  return { version: PROVENANCE_CACHE_VERSION, updatedAt: null, entries: {} };
}

export function writeProvenanceCache(file, cache) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = JSON.stringify({ version: PROVENANCE_CACHE_VERSION, updatedAt: cache?.updatedAt ?? new Date().toISOString(), entries: cache?.entries ?? {} });
  const tmp = file + ".tmp";
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
  return payload.length;
}

/** 从一条 attestation 的 DSSE payload 里抽 SLSA 溯源信息；抽不到返回 null。 */
export function parseProvenancePayload(attestations) {
  for (const item of Array.isArray(attestations) ? attestations : []) {
    const predicateType = String(item?.predicateType ?? "");
    if (!predicateType.includes("slsa.dev/provenance")) continue;
    const payload = item?.bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string" || !payload) continue;
    try {
      const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      const pred = statement?.predicate ?? {};
      const def = pred.buildDefinition ?? {};
      const workflow = def.externalParameters?.workflow ?? {};
      const deps = Array.isArray(def.resolvedDependencies) ? def.resolvedDependencies : [];
      const dep = deps[0] ?? {};
      const repository = typeof workflow.repository === "string" ? workflow.repository : typeof dep.uri === "string" ? dep.uri : null;
      const commit = dep.digest?.gitCommit ?? null;
      const builder = pred.runDetails?.builder?.id ?? null;
      const workflowPath = typeof workflow.path === "string" ? workflow.path : null;
      const ref = typeof workflow.ref === "string" ? workflow.ref : null;
      if (!repository) return null;
      return { repository, commit, builder, workflowPath, ref };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * npm provenance 取数器：只认 200 + SLSA payload；404（没有 attestation）记 none；
 * 网络/5xx 记 error（不当地否定）。不打印任何 token（npm 公开接口，无需凭据）。
 */
export function createNpmProvenanceFetcher({
  fetchImpl = globalThis.fetch,
  userAgent = REPO_DIR_UA,
  sleepFn = (ms) => new Promise((done) => setTimeout(done, ms)),
  maxAttempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createNpmProvenanceFetcher 需要 fetch");
  const headers = { Accept: "application/json", "User-Agent": userAgent };
  return async function fetchProvenance(pkg, version) {
    const url = "https://registry.npmjs.org/-/npm/v1/attestations/" + encodeURIComponent(pkg).replace(/%40/gu, "@") + "@" + encodeURIComponent(String(version ?? ""));
    let last = "unknown";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch (err) {
        last = "network:" + String(err?.name ?? "Error");
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      const status = Number(response?.status) || 0;
      if (status === 200) {
        try {
          const doc = JSON.parse(await response.text());
          const parsed = parseProvenancePayload(doc?.attestations);
          if (!parsed) return { state: "none", reason: "no-slsa" };
          return { state: "ok", ...parsed };
        } catch {
          return { state: "error", reason: "bad-json" };
        }
      }
      if (status === 404) return { state: "none", reason: "no-attestation" };
      if (status === 429 || status === 403) {
        last = "http-" + status;
        await sleepFn(2000 * (attempt + 1));
        continue;
      }
      if (status >= 500) {
        last = "http-" + status;
        await sleepFn(600 * (attempt + 1));
        continue;
      }
      return { state: "error", reason: "http-" + status };
    }
    return { state: "error", reason: last };
  };
}

/**
 * 跑一批 provenance 校验：targets: [{ pkg, version }]；返回 { cache, results: Map<pkg, entry>, stats }。
 * 结论按 pkg@version 缓存 30 天（同一版本不可变）；错误 1 天后重试。
 */
export async function runProvenanceVerification({
  targets = [],
  cache = null,
  fetchProvenance,
  now = Date.now(),
  ttlMs = PROVENANCE_TTL_MS,
  errorTtlMs = PROVENANCE_ERROR_TTL_MS,
  concurrency = 3,
  maxCacheAgeMs = 180 * 24 * 3600 * 1000,
  log = () => {},
} = {}) {
  const base = cache && cache.entries && typeof cache.entries === "object" ? cache : { version: PROVENANCE_CACHE_VERSION, updatedAt: null, entries: {} };
  const entries = { ...base.entries };
  const results = new Map();
  const stats = { targets: 0, cached: 0, fetched: 0, ok: 0, none: 0, errors: 0 };
  const queue = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const pkg = String(target?.pkg ?? "").trim();
    const version = String(target?.version ?? "").trim();
    if (!pkg || !version) continue;
    stats.targets += 1;
    const key = provenanceCacheKey(pkg, version);
    const cached = entries[key];
    const at = Date.parse(String(cached?.at ?? ""));
    const ttl = cached?.state === "error" ? errorTtlMs : ttlMs;
    if (cached && Number.isFinite(at) && now - at < ttl) {
      results.set(pkg, cached);
      stats.cached += 1;
      continue;
    }
    queue.push({ pkg, version, key, cached: cached ?? null });
  }
  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 3));
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      const job = queue[index];
      let outcome;
      try {
        outcome = await fetchProvenance(job.pkg, job.version);
      } catch (err) {
        outcome = { state: "error", reason: "fetch-threw:" + String(err?.name ?? "Error") };
      }
      const stamp = new Date(now).toISOString();
      let entry;
      if (outcome?.state === "ok") {
        entry = { state: "ok", repository: outcome.repository ?? null, commit: outcome.commit ?? null, builder: outcome.builder ?? null, workflowPath: outcome.workflowPath ?? null, ref: outcome.ref ?? null, at: stamp };
        stats.ok += 1;
      } else if (outcome?.state === "none") {
        entry = { state: "none", reason: String(outcome.reason ?? "no-attestation"), at: stamp };
        stats.none += 1;
      } else {
        stats.errors += 1;
        entry = job.cached ?? { state: "error", reason: String(outcome?.reason ?? "unknown"), at: stamp };
      }
      entries[job.key] = entry;
      results.set(job.pkg, entry);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  stats.fetched = queue.length - stats.errors;
  for (const [key, entry] of Object.entries(entries)) {
    const at = Date.parse(String(entry?.at ?? ""));
    if (!Number.isFinite(at) || now - at > maxCacheAgeMs) delete entries[key];
  }
  const out = { version: PROVENANCE_CACHE_VERSION, updatedAt: new Date(now).toISOString(), entries };
  log("发布溯源：" + stats.targets + " 条待查（有溯源 " + stats.ok + " · 无溯源 " + stats.none + " · 缓存 " + stats.cached + " · 失败 " + stats.errors + "）");
  return { cache: out, results, stats };
}
