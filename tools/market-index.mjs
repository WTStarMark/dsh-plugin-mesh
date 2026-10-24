#!/usr/bin/env node
/**
 * market-index —— 把生态图里「确实是 DSH 组合包」的那部分，生成一份插件市场索引（format 1）。
 *
 * 用法：
 *   node tools/market-index.mjs [--limit 200] [--refresh] [--out dist/market/index.json] [--seed 12345]
 *                               [--no-subdir-verify] [--subdir-cache data/cache/repo-dirs.json]
 *                               [--subdir-ttl-hours 168] [--subdir-concurrency 4]
 *
 * 数据来源：
 *   · data/cache/npm-downloads.json —— 仓库 ↔ npm 包名（采集器写）
 *   · data/mesh.json                —— 分类、星标、描述、头像（前端数据）
 *   · registry.npmjs.org            —— 版本列表与发布时间（本脚本自己抓，缓存在 data/cache/npm-registry.json）
 *
 * 取舍（为什么这么做）：
 *   · 只收「依赖或同伴依赖里有 @deepseek-ai/*」的包 —— 这是「它真的是 DSH 插件」最便宜、最可验证的信号。
 *     不是的（纯工具、同名巧合）一律不进索引：市场索引等于一键安装清单，宁缺毋滥。
 *   · 版本只留最近几个（默认 5 个），publishTimestamp 取 registry 的 time；没有发布时间就整个包不要 ——
 *     索引格式要求整数秒，编一个时间戳比少一个包更糟。
 *   · 整个 engines 字段都不写：DSH 的校验器把这一项当可选（缺失时自己补 {}），写上就是纯体积。
 *     仍然不猜 engines.dsh：我们只有 cordis 的同伴依赖范围，推不出 DSH 版本范围，空 = 不限制。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERDICT,
  classifyRepositoryDirectory,
  createGitHubCodeSearchFetcher,
  createGitHubCommitFetcher,
  createGitHubDirectoryHistoryFetcher,
  createGitHubPackageJsonFetcher,
  judgeSubdirCheck,
  loadGitHubToken,
  readRepoDirCache,
  runSubdirVerification,
  writeRepoDirCache,
  createNpmProvenanceFetcher,
  readProvenanceCache,
  runProvenanceVerification,
  writeProvenanceCache,
  repoKeyFromUrl,
} from "./repo-dir-verify.mjs";
import { decisionFor, hiddenLabelIds, listHit, marketPaths, packageBlacklistReason, readMarketOverrides } from "./market-overrides.mjs";
import { MARKET_LABELS } from "./market-labels.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "dsh-plugin-mesh-market-index/0.1 (+https://github.com/WTStarMark/dsh-plugin-mesh)";

/* 打包文档最大字节数：billion-context 那种 4500 个版本的包单文档 16MB，抓下来只为 5 个时间戳不划算。
 * 超限的包直接跳过并在结尾列出来——跳过是可见的，编造是不可接受的。 */
const PACKUMENT_MAX_BYTES = 6 * 1024 * 1024;
const REGISTRY_TTL_MS = 24 * 3600 * 1000;
/* 缓存格式版本：改了"怎么读 packument"就必须改这个数，否则老记录会被当新记录复用
 * （线上实测：把 devDependencies 纳入判定后，缓存里的旧记录让 @xmanrui/dsh-im 继续被漏掉）。 */
/* 4 = 新增 repositoryDirectory（子目录包在仓库里的位置，来自 packument 的 repository.directory）；
 * 老记录没有这个字段，升版本会让它们重抓一次 —— 这是"改了怎么读 packument 就升版本"的既定规矩。 */
const CACHE_VERSION = 4;
const VERSIONS_KEPT = 5;
const DSH_SCOPE = "@deepseek-ai/";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Number(argOf("limit", 200)) || 200;
const REFRESH = argv.includes("--refresh");
const OUT = resolve(ROOT, argOf("out", "dist/market/index.json"));
/* 拿远端清单出索引时，注册表缓存也要能指向远端那份：否则远端清单里的包在本地缓存里没有记录，
 * 会被当成"没有记录"整批跳过（日志里只是一句 skipReasons），索引就少了条目。 */
const REGISTRY_CACHE = resolve(ROOT, argOf("npm-registry", "data/cache/npm-registry.json"));
/* 人工裁决/名单（后台写、生成器读）。文件缺失/损坏 = 空表，完全等同旧行为。 */
const OVERRIDES = resolve(ROOT, argOf("overrides", "data/admin/market-index/overrides.json"));

/* 子目录归属校验（tools/repo-dir-verify.mjs）：npm 自述的 repository.directory 从来没被打开看过。
 * 线上实测 7 个包把 repository 写成官方仓库、directory 写成发布者本机的 .dsh/plugins/…，
 * 索引就把官方仓库的标题/头像/作者/25 万星标搬到了它们前面，还因为「自述仓库 == 认领仓库」被判成确证。
 * 现在生成索引时去仓库里读那个目录的 package.json：只有名字对得上才叫「仓库内子包」。
 * 没配 GITHUB_TOKEN 时跳过（离线/本地跑不至于因为校验把索引搞坏），显式 --no-subdir-verify 也可跳过。 */
const SUBDIR_VERIFY = !argv.includes("--no-subdir-verify");
const SUBDIR_CACHE = resolve(ROOT, argOf("subdir-cache", "data/cache/repo-dirs.json"));
const SUBDIR_TTL_MS = Math.max(1, Number(argOf("subdir-ttl-hours", 168)) || 168) * 3600 * 1000;
const SUBDIR_CONCURRENCY = Math.max(1, Math.min(8, Number(argOf("subdir-concurrency", 4)) || 4));
/* 没有 repository.directory 的子目录候选：只有星标够高的才值得花 code search 配额（10 次/分钟）去查；
 * 其余一律按「未核实」处理（不确证、不挂「仓库内子包」、打「作者待确认」）。 */
const SUBDIR_CODESEARCH_MIN_STARS = Math.max(0, Number(argOf("subdir-codesearch-min-stars", 100)) || 100);
/* npm 发布溯源（SLSA provenance）：只对声称高星仓库的包查（每包 1 次 npm 请求，结论按版本缓存 30 天）。
 * 这是密码学级别证据：CI 用 OIDC 发布时 npm 会签名记录「哪个仓库的哪个 commit 发布的」。 */
const PROVENANCE_VERIFY = !argv.includes("--no-provenance");
const PROVENANCE_CACHE = resolve(ROOT, argOf("provenance-cache", "data/cache/provenance.json"));
const PROVENANCE_MIN_STARS = Math.max(0, Number(argOf("provenance-min-stars", 100)) || 100);
const PROVENANCE_CONCURRENCY = Math.max(1, Math.min(6, Number(argOf("provenance-concurrency", 3)) || 3));

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const toUnixSeconds = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/* 索引要求严格 SemVer：registry 里偶尔混进非 semver 的版本串，一律丢掉 */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * 描述开头的人气前缀：只放数字（★ 星标 · 周下载；星标不足 10 时只放周下载），不放「周下载」这几个字。
 * 理由见下面 entry.description 处的注释：DSH 把 description 当检索字段，中文词会被切进每个插件的检索词里。
 */
export const MIN_STARS_FOR_BADGE = 10;
export const FRESH_RELEASE_DAYS = 7;

/** 「近 7 天有新版」：取这个包最新一次 npm 发布时间（readPackument 按发布时间倒序取前 5）。
 *  实测 80% 的条目 7 天内没有新版本 —— 这个标签能把真正在维护的挑出来。 */
export function isFreshRelease(versions, nowSec = Date.now() / 1000) {
  if (!Array.isArray(versions) || !versions.length) return false;
  const latest = Math.max(...versions.map((v) => Number(v?.ts) || 0));
  return latest > 0 && nowSec - latest < FRESH_RELEASE_DAYS * 86400;
}

/* 关键词兜底：关键词为空的条目在市场搜索里几乎等于不存在（实测 917/6648 条）。
   索引里的条目都已经过「声明 dsh.bundle 或依赖里有 @deepseek-ai/*」的筛选，
   补核心词是如实描述，不是刷词。 */
const CORE_KEYWORDS = ["deepseek-harness", "dsh", "dsh-plugin"];

export function keywordsOf(node, pkg) {
  const topics = Array.isArray(node?.topics) ? node.topics.map(String).filter(Boolean) : [];
  if (topics.length) return topics.slice(0, 12);
  const tokens = String(pkg || "")
    .replace(/^@[^/]+\//u, "")
    .split(/[^a-z0-9]+/iu)
    .filter((t) => t.length >= 3);
  return [...new Set([...CORE_KEYWORDS, ...tokens])].slice(0, 12);
}

export function toneOf(stars, hasDownloads, downloads) {
  // 下载量前面加「↓」：只写两个光秃秃的数字（★87 · 1.8k）会被读成「87 到 1.8k 星」，
  // 实测有用户把 1.8k 当成星标数。符号不是汉字，不会像「周下载」那样把 CJK 词切进每个插件的检索字段。
  const dl = hasDownloads ? "↓" + shortNumber(downloads) : "—";
  const n = Number(stars) || 0;
  // 星标不足 MIN_STARS_FOR_BADGE 就不写 ★：全索引 38% 的条目是 0 星，
  // 以「★0」开头等于在卡片第一行写「没人气」；只留下载量（真实使用量）更中性。
  return n >= MIN_STARS_FOR_BADGE ? "★" + shortNumber(n) + " · " + dl : dl;
}

/** 版本条目：不写 engines —— DSH 校验器对它是 optional(...) ?? {}，缺失自动补空对象，写上是纯体积。 */
export function versionEntries(versions) {
  return versions.map((v) => ({ version: v.version, publishTimestamp: v.ts, source: { type: "npm" } }));
}

/** 大数缩写：1234 → 1.2k、160042 → 160k、1200000 → 1.2M（榜单里也是这把尺子）。 */
function shortNumber(value) {
  const v = Number(value) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/u, "") + "M";
  if (v >= 1e4) return Math.round(v / 1e3) + "k";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/u, "") + "k";
  return String(v);
}

/* 默认顺序随机打乱用：零依赖的可复现伪随机（mulberry32），同一个 seed 出同一串数。 */
export function seededRandom(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌；rand 可注入便于单测。返回新数组，不改原数组。 */
export function shuffled(list, rand = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 把 npm 的 repository 字段或仓库网页地址收成 "owner/repo"（小写）——用来判断"这个包其实住在哪个仓库"。 */
function repoKey(value) {
  if (!value) return null;
  let url = typeof value === "string" ? value : value.url;
  if (typeof url !== "string" || !url) return null;
  url = url
    .trim()
    .replace(/^git\+/u, "")
    .replace(/^git@github\.com:/iu, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//iu, "https://github.com/")
    .replace(/^git:\/\//iu, "https://")
    .replace(/\.git$/u, "");
  const hit = /github\.com\/([^/?#]+)\/([^/?#]+)/iu.exec(url);
  return hit ? (hit[1] + "/" + hit[2]).toLowerCase() : null;
}

/** 带体积上限的 GET：超限就中止，返回 {tooLarge:true} */
async function fetchJsonCapped(url, cap) {
  const res = await fetch(url, {
    // accept-encoding: npm 的 packument 压缩后只有十分之一上下 —— 抓近万个包，这一行省几个 GB
    headers: { accept: "application/json", "accept-encoding": "gzip, deflate", "user-agent": UA },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) return { error: "HTTP " + res.status, status: res.status };
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) {
    try { await res.body?.cancel(); } catch { /* 关不掉也无所谓 */ }
    return { tooLarge: true, bytes: declared };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > cap) {
      try { await res.body.cancel(); } catch { /* 同上 */ }
      return { tooLarge: true, bytes: total };
    }
    chunks.push(chunk);
  }
  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes: total };
  } catch {
    return { error: "不是合法 JSON" };
  }
}

/** 从一份 packument 里抽出索引要的东西；不够用就返回 {skip: 原因} */
function readPackument(doc) {
  if (!doc || typeof doc !== "object" || !doc.versions || !doc.time) return { skip: "没有 versions/time" };
  const latestTag = doc["dist-tags"]?.latest ?? null;
  const rows = [];
  for (const [version, at] of Object.entries(doc.time)) {
    if (version === "created" || version === "modified") continue;
    if (!SEMVER.test(version)) continue;
    const ts = toUnixSeconds(at);
    if (ts === null) continue;
    rows.push({ version, ts, pre: version.includes("-") });
  }
  if (!rows.length) return { skip: "没有可用的版本时间" };
  // 优先稳定版；稳定版不足时再拿预发布兜底。validator 会自己按 semver 优先级排序，这里只负责"挑哪些"。
  const stable = rows.filter((r) => !r.pre);
  const pool = stable.length ? stable : rows;
  pool.sort((a, b) => b.ts - a.ts);
  const picked = pool.slice(0, VERSIONS_KEPT);
  if (latestTag && SEMVER.test(latestTag) && !picked.some((p) => p.version === latestTag)) {
    const hit = rows.find((r) => r.version === latestTag);
    if (hit) picked[picked.length - 1] = hit; // 最新版永远在
  }
  const latestFull = doc.versions[latestTag] ?? doc.versions[picked[0].version] ?? {};
  /* 「它是不是 DSH 组合包」的判定：最新版在 dependencies / peerDependencies / devDependencies 任一处
   * 声明了 @deepseek-ai/* 就算。devDependencies 也认，是因为线上实测有的插件只把 cordis 写在 dev 里
   * （@xmanrui/dsh-im 就是）；不认它就会漏掉真插件。索引格式本身无法验证组合包身份，这条只能靠生成器自律。 */
  const declared = {
    ...(latestFull.devDependencies ?? {}),
    ...(latestFull.peerDependencies ?? {}),
    ...(latestFull.dependencies ?? {}),
  };
  const dshKeys = Object.keys(declared).filter((k) => k.startsWith(DSH_SCOPE));
  /* 最硬的判据：作者自己在 package.json 里声明了 dsh.bundle.patch（组合包层）。
   * 有它就是组合包，没有也不能立刻否定（老包可能还没补这个字段）——所以它是"确证"，不是"唯一依据"。
   * 顺带把 dsh.client 记下来：有浏览器半边的组合包。 */
  const bundle = latestFull.dsh && typeof latestFull.dsh === "object" ? latestFull.dsh.bundle : null;
  const isBundle = !!(bundle && typeof bundle === "object" && typeof bundle.patch === "string" && bundle.patch.trim());
  const hasClient = !!(latestFull.dsh && typeof latestFull.dsh === "object" && latestFull.dsh.client);
  const repository = typeof latestFull.repository === "string" ? latestFull.repository : latestFull.repository?.url ?? null;
  // 子目录包（monorepo 里的插件）在 npm 元数据里声明了自己住在仓库的哪个目录
  const repositoryDirectory =
    latestFull.repository && typeof latestFull.repository === "object" && typeof latestFull.repository.directory === "string"
      ? latestFull.repository.directory
      : null;
  const author = typeof latestFull.author === "string" ? latestFull.author : latestFull.author?.name ?? null;
  /* 发布账号：npm 认证过的"谁按下了发布键"（publish 必须登录）。比作者自己填的 author 字段可信，
   * 用途是"包与包之间的桥"——改包名不会换账号。注意开了 trusted publishing 的包这里是
   * "GitHub Actions"，那种情况该信 provenance 而不是账号。
   * 这三行是**追加式**字段：老缓存记录缺它读到 undefined（= 未知），不会造出错误数据，
   * 所以刻意不升 CACHE_VERSION —— 升了会让下一次全量重抓 7500 份 packument。 */
  /* 发布账号在 version 对象里（doc._npmUser 顶层通常没有，之前一直读成 null）；顺手补上 gitHead：
   * 没有目录声明的包要靠"发布账号 + gitHead 在不在声称仓库里"判断真伪。两者都是追加字段，
   * 老缓存记录读到 undefined = 未知，不必升 CACHE_VERSION。 */
  const npmUser = typeof latestFull._npmUser?.name === "string" ? latestFull._npmUser.name : typeof doc._npmUser?.name === "string" ? doc._npmUser.name : null;
  const gitHead = typeof latestFull.gitHead === "string" ? latestFull.gitHead : null;
  return { versions: picked, dshKeys, repository, repositoryDirectory, author, npmUser, gitHead, latestTag, isBundle, hasClient, bundlePatch: isBundle ? bundle.patch : null };
}

async function loadRegistryCache() {
  const path = REGISTRY_CACHE;
  const cached = readJson(path, null);
  if (cached && cached.packages && typeof cached.packages === "object") return { path, cache: cached };
  return { path, cache: { updatedAt: null, packages: {} } };
}

/**
 * 候选并集：仓库根包（npm-downloads.json）+ 子目录包（npm-packages.json，npm 反查发现）。
 * 子目录包 = "仓库根没有 package.json、插件住在仓库内某个目录"的那批 —— 不并进来它们永远不会
 * 出现在市场索引里（volcengine/OpenViking 的 examples/dsh-memory-plugin 就是这一类）。
 * 两条来源都只收「状态 ok 且下载量已知」的，且仓库必须还在图里（归档的不要）。
 */
export function collectCandidates(downloads, extra, byId) {
  const candidates = [];
  for (const [repoId, entry] of Object.entries(downloads?.repos ?? {})) {
    if (entry?.status !== "ok" || !entry.package) continue;
    const node = byId.get(repoId);
    if (!node || node.archived) continue;
    candidates.push({
      repoId,
      node,
      pkg: String(entry.package),
      downloads: Number(entry.downloads) || 0,
      // 有包名但没拿到下载量（新发布的包 npm 还没统计）——展示时要写「—」，不能写成 0
      hasDownloads: typeof entry.downloads === "number",
    });
  }
  for (const [pkgName, rec] of Object.entries(extra?.packages ?? {})) {
    if (!pkgName || !rec || rec.status !== "ok") continue;
    const node = byId.get(String(rec.repoId ?? ""));
    if (!node || node.archived) continue;
    candidates.push({
      repoId: node.id,
      node,
      pkg: String(pkgName),
      downloads: Number(rec.downloads) || 0,
      hasDownloads: typeof rec.downloads === "number",
      subdir: true,
    });
  }
  return candidates;
}

/** 归属判定的证据级别。只有"有据"和"明说无据"两种状态，没有"大概是"。 */
export const OWNER_EVIDENCE = {
  /** ① 确证：npm 包自己声明的仓库，就是声明了这个包名的候选之一（两边一致） */
  DECLARED_IN_CLAIMANTS: "declared-in-claimants",
  /** ② 未验证：npm 声明的仓库在图里，但它没有声明这个包名（包名标了 private / 改过名 / 没 package.json） */
  DECLARED_IN_MESH: "declared-in-mesh",
  /** ③ 未验证：npm 声明的仓库不在本地数据里（已删 / 已改名 / 没被采集到），只能拿到一个字符串 */
  DECLARED_ONLY: "declared-only",
  /** ④ 未验证：npm 根本没写 repository，但这个名字只有唯一一个声明者 */
  SOLE_CLAIMANT: "sole-claimant",
  /** ⑤ 无从判断：npm 没写 repository，且多个仓库抢同一个包名 —— 谁都不认 */
  AMBIGUOUS: "ambiguous",
};

/**
 * 决定索引里这一行的作者/仓库是谁。
 *
 * 背景：市场索引按 npm 包名收录（一个包名一行），但"这个包是谁的"只有一条证据 ——
 * npm 包自己声明的 repository。历史写法是把它当筛子用（在候选里找），筛不出来就按
 * 复刻/星标/下载量/仓库名排序**挑一个顶上**；线上实测 6644 行里有 263 行挂的仓库与 npm
 * 声明冲突（222 行是完全不同的作者）。把别人的项目说成是你的，比"作者未知"严重得多 ——
 * 所以这里的规矩是：拿不到证据就不署名，绝不硬挑。
 *
 * 优先级：npm 声明的仓库（作者自己的声明，最权威）> 唯一声明者（弱证）> 不署名。
 * 注意**不验证也不猜**的一种情况：npm 声明的仓库不在图里时，我们无法在本地核实它还在不在，
 * 所以照实署名（那是发布者自己的声明），但整条打上 owner-unverified 标签。
 *
 * @param {{npmRepo?: string|null, claimants?: Array<{node: object, repoId: string}>, meshById?: Map<string, object>}} input
 * @returns {{item: object|null, node: object|null, owner: string|null, verified: boolean, evidence: string, repoId: string|null}}
 */
export function resolveOwner({ npmRepo, claimants, meshById } = {}) {
  const list = Array.isArray(claimants) ? claimants : [];
  const wanted = repoKey(npmRepo);
  if (wanted) {
    const hit = list.find((x) => repoKey(x?.node?.htmlUrl) === wanted) ?? null;
    if (hit) {
      const owner = hit.node?.owner ?? wanted.split("/")[0];
      return { item: hit, node: hit.node ?? null, owner, verified: true, evidence: OWNER_EVIDENCE.DECLARED_IN_CLAIMANTS, repoId: wanted };
    }
    const node = meshById?.get(wanted) ?? null;
    if (node) {
      return { item: null, node, owner: node.owner ?? wanted.split("/")[0], verified: false, evidence: OWNER_EVIDENCE.DECLARED_IN_MESH, repoId: node.id ?? wanted };
    }
    return { item: null, node: null, owner: wanted.split("/")[0], verified: false, evidence: OWNER_EVIDENCE.DECLARED_ONLY, repoId: wanted };
  }
  if (list.length === 1) {
    const only = list[0];
    return { item: only, node: only?.node ?? null, owner: only?.node?.owner ?? null, verified: false, evidence: OWNER_EVIDENCE.SOLE_CLAIMANT, repoId: only?.repoId ?? null };
  }
  return { item: null, node: null, owner: null, verified: false, evidence: OWNER_EVIDENCE.AMBIGUOUS, repoId: null };
}

/**
 * 子目录校验结论 -> 这一行怎么署名（纯函数，方便单测；不碰网络、不碰缓存）。
 *
 * · confirmed：仓库里确实有这个包（目录里的 package.json 名字对得上）—— 可以外借仓库身份；
 * · refuted  ：目录不存在或是本地路径。若这一行的归属本来就靠"子目录声明"（chosen.subdir），
 *              就不许再外借标题/头像/作者/星标：仓库里根本没有它，名字是别人替它挂上去的；
 * · unverified/没查过：内容照旧，但不算确证（打「作者待确认」）。没写目录的（非 subdir）
 *              不受目录结论影响，仍按 resolveOwner 的证据走。
 *
 * @returns {{identity: object|null, refuted: boolean, dirConfirmed: boolean, attributionVerified: boolean, subdirLabel: boolean}}
 */
export function decideEntryAttribution({ node = null, resolved = null, chosen = null, check = null } = {}) {
  const dirConfirmed = check?.verdict === "confirmed";
  /* 驳回只在"这一行的归属靠目录声明"时生效：
   *   · chosen.subdir = 采集器反查来的子目录包，归属完全靠 repository.directory；
   *   · !resolved.item = npm 声明的仓库并不声明这个包名（只是图里有这个仓库），
   *     身份（标题/作者/星标）也是从那个仓库借来的 —— 目录又对不上，就该驳回。
   * 反过来，仓库根 package.json 自己写了包名的（resolved.item 且非 subdir），
   * 目录字段写错也不影响"这个仓库有它"这条证据，不在这里一票否决。 */
  const refuted = check?.verdict === "refuted" && Boolean(chosen?.subdir || !resolved?.item);
  const attributionVerified = !refuted && Boolean(resolved?.verified || dirConfirmed) && (!chosen?.subdir || !check || dirConfirmed);
  return {
    identity: refuted ? null : node,
    refuted,
    dirConfirmed,
    attributionVerified,
    // 「仓库内子包」是事实主张：confirmed 才挂；没查过（没配 token/没写 directory）保持原行为
    subdirLabel: Boolean(chosen?.subdir) && (!check || dirConfirmed),
  };
}

/**
 * 人工裁决/名单 -> 最终展示策略（纯函数，单测覆盖）。
 * 优先级：entries（人工裁决） > lists（发布者/仓库名单） > 自动核验结论。
 * base 来自 decideEntryAttribution；node 是声称仓库的节点（人工确证时要用它恢复身份）。
 */
export function applyAttributionOverrides({ pkg, base, node = null, rec = null, repoId = null, overrides = null } = {}) {
  const out = {
    identity: base?.identity ?? null,
    refuted: Boolean(base?.refuted),
    attributionVerified: Boolean(base?.attributionVerified),
    subdirLabel: Boolean(base?.subdirLabel),
    source: "auto",
    provenance: base?.provenance ?? "none",
  };
  if (!overrides) return out;
  const decision = decisionFor(overrides, pkg);
  const hit = listHit(overrides, { pkg, publisher: rec?.npmUser ?? null, repoId });
  if (decision) {
    out.source = "manual:" + decision.decision;
    if (decision.decision === "confirmed") {
      out.refuted = false;
      out.identity = node ?? out.identity;
      out.attributionVerified = true;
    } else if (decision.decision === "refuted") {
      out.refuted = true;
      out.identity = null;
      out.attributionVerified = false;
      out.subdirLabel = false;
    } else {
      out.refuted = false;
      out.attributionVerified = false;
      out.subdirLabel = false;
    }
    return out;
  }
  if (!hit) return out;
  if (hit.kind === "publisher") {
    /* 发布者名单：这个账号的包一律不借仓库身份（展示等同驳回），但条目本身仍可安装。 */
    out.refuted = true;
    out.identity = null;
    out.attributionVerified = false;
    out.subdirLabel = false;
    out.source = "list:publisher";
  } else if (hit.kind === "repo") {
    /* 仓库名单：这个仓库的包只算未核实（仍显示，但打「作者待确认」）。 */
    out.attributionVerified = false;
    out.source = "list:repo";
  } else if (hit.kind === "whitelist-repo") {
    /* 仓库白名单：人工为这个仓库背书，按确证展示。 */
    out.attributionVerified = true;
    out.source = "list:whitelist-repo";
  }
  return out;
}

/**
 * 去掉后台「索引源 → 标签」里被隐藏的标签（纯函数，单测覆盖）。
 * 只影响展示：条目本身的判定/身份不变，DSH 市场里就是不显示这枚胶囊。
 */
export function filterHiddenLabels(labels, hidden) {
  const hide = hidden instanceof Set ? hidden : new Set(Array.isArray(hidden) ? hidden : []);
  return (Array.isArray(labels) ? labels : []).filter((id) => !hide.has(id));
}

/**
 * 第 4 层：npm 发布溯源（provenance）-> 最终展示策略（纯函数，单测覆盖）。
 * · match    ：溯源仓库 == 声称仓库 → 强制确证（这是最强证据，可以恢复被自动驳回的身份）
 * · mismatch ：溯源仓库 != 声称仓库 → 强制驳回（签名声明说了别的仓库，比任何自述都硬）
 * · none/error：没有溯源或拿不到 → 不动原有判定（不能当反证）
 * 人工裁决在下一层，仍然压过这里。
 */
export function applyProvenanceAttribution(base, prov, { node = null, repoKey = null } = {}) {
  const out = { ...(base ?? {}), provenance: "none" };
  if (!prov || !prov.state || prov.state === "none") return out;
  if (prov.state === "error") {
    out.provenance = "error";
    return out;
  }
  if (prov.state !== "ok") return out;
  const provRepo = repoKeyFromUrl(prov.repository);
  const wanted = repoKey ? String(repoKey).toLowerCase() : null;
  if (!provRepo || !wanted) {
    out.provenance = "unknown";
    return out;
  }
  if (provRepo === wanted) {
    out.provenance = "match";
    out.refuted = false;
    out.identity = node ?? out.identity ?? null;
    out.attributionVerified = true;
  } else {
    out.provenance = "mismatch";
    out.refuted = true;
    out.identity = null;
    out.attributionVerified = false;
    out.subdirLabel = false;
  }
  return out;
}

/**
 * 索引不变量自检（第 5 层，产物级）：索引一旦写坏，DSH 市场页会整页异常。
 * 这里只查"格式/契约"能证明的硬约束；归属语义由前面几层负责。
 * @returns {Array<{pkg: string, why: string}>}
 */
export function validateIndex(plugins, labelIds = null) {
  const bad = [];
  const seen = new Set();
  const labelsOk = labelIds instanceof Set ? labelIds : null;
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const pkg = String(p?.name ?? "");
    if (!pkg) { bad.push({ pkg: "(空)", why: "缺少包名" }); continue; }
    if (seen.has(pkg)) bad.push({ pkg, why: "包名重复" });
    seen.add(pkg);
    if (p.title !== pkg) bad.push({ pkg, why: "title 必须等于 npm 包名（当前 " + String(p.title) + "）" });
    const versions = Array.isArray(p.versions) ? p.versions : [];
    if (!versions.length) bad.push({ pkg, why: "没有版本" });
    for (const v of versions) {
      if (!v || typeof v.version !== "string" || !SEMVER.test(v.version)) bad.push({ pkg, why: "版本号不是严格 semver：" + String(v?.version) });
      if (!Number.isInteger(v?.publishTimestamp) || v.publishTimestamp <= 0) bad.push({ pkg, why: "publishTimestamp 必须是正整数秒" });
      if (!v?.source || v.source.type !== "npm") bad.push({ pkg, why: "版本 source 必须是 npm" });
    }
    const labels = p.metadata?.labels ?? [];
    if (!Array.isArray(labels)) bad.push({ pkg, why: "labels 必须是数组" });
    else if (labelsOk) for (const label of labels) if (!labelsOk.has(label)) bad.push({ pkg, why: "未声明的标签：" + String(label) });
    if (labels.includes("owner-unverified") && p.repository && !p.author) {
      // 有仓库却没作者：不是脱身份（驳回）该有的样子，也不是确证；只可能是脏数据
      bad.push({ pkg, why: "有 repository 却没有 author（既非确证也非脱身份）" });
    }
    if (p.repository && p.repository.url && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(p.repository.url)) {
      bad.push({ pkg, why: "repository.url 不是 GitHub 仓库地址" });
    }
    if (p.icon !== undefined && !(typeof p.icon === "string" && p.icon.startsWith("https://"))) bad.push({ pkg, why: "icon 必须是 https URL" });
    const keywords = p.metadata?.keywords;
    if (keywords !== undefined && (!Array.isArray(keywords) || keywords.length > 12)) bad.push({ pkg, why: "keywords 必须是 ≤12 项的数组" });
  }
  return bad;
}

/**
 * 构建后的自检：把"不许猜"这条规矩钉进产物，而不是只写在注释里。
 * 只要有一行的作者/仓库与 npm 包自己的声明冲突、却没打 owner-unverified，就算违规。
 * @returns {Array<{pkg: string, why: string, declared: string|null, listed: string|null}>}
 */
export function auditOwnership(plugins, packages, options = {}) {
  const bad = [];
  /* 后台把 owner-unverified 标签隐藏时，"没作者名就必须挂这枚标签"这条自检自动失效
   * （标签被隐藏是运营者的显式选择，不是生成器把猜测当事实）。仓库冲突那条照查。 */
  const hidden = options.hiddenLabels instanceof Set ? options.hiddenLabels : new Set(Array.isArray(options.hiddenLabels) ? options.hiddenLabels : []);
  const labelHidden = hidden.has("owner-unverified");
  for (const p of plugins ?? []) {
    const declared = repoKey(packages?.[p.name]?.repository);
    const listed = repoKey(p.repository?.url);
    const flagged = (p.metadata?.labels ?? []).includes("owner-unverified");
    if (declared && listed && declared !== listed && !flagged) {
      bad.push({ pkg: p.name, why: "仓库与 npm 声明不一致，却当成确证", declared, listed });
      continue;
    }
    if (!flagged && !p.author && !labelHidden) {
      bad.push({ pkg: p.name, why: "既没写作者名，也没标 owner-unverified", declared, listed });
    }
  }
  return bad;
}

async function main() {
  // --mesh：默认本机前端数据；拿远端清单出索引时一并指向远端那份，避免"清单里有、画像里没有"被静默丢掉
  const meshPath = resolve(ROOT, argOf("mesh", "data/mesh.json"));
  const mesh = readJson(meshPath, null);
  // --npm-cache：默认读本机采集器的缓存；要拿远端的清单出索引时指向别处（远端那份更全）
  const npmCachePath = resolve(ROOT, argOf("npm-cache", "data/cache/npm-downloads.json"));
  const downloads = readJson(npmCachePath, null);
  if (!mesh?.nodes?.length) throw new Error("读不到 " + meshPath + "（先跑采集器或 npm run seed）");
  if (!downloads?.repos) throw new Error("读不到 " + npmCachePath);

  const overrides = readMarketOverrides(OVERRIDES);
  /* 后台「索引源 → 标签」里被隐藏的标签：条目与 metadata.labels 都不再输出（DSH 市场就不显示这枚胶囊）。 */
  const hiddenLabels = hiddenLabelIds(overrides);
  const byId = new Map(mesh.nodes.map((n) => [n.id, n]));
  /* 小写索引：npm 的 repository 字段大小写随意（实测 blank-not-black/dsh-remote 对
   * Blank-not-black/dsh-Remote），而 repoKey() 一律返回小写，所以这条查表必须按小写建。 */
  const meshById = new Map(mesh.nodes.map((n) => [String(n.id).toLowerCase(), n]));
  // 子目录包缓存（采集器的可选产物）：缺失/损坏都当空表，不影响主流程
  const extra = readJson(resolve(ROOT, argOf("npm-packages", "data/cache/npm-packages.json")), null);
  const candidates = collectCandidates(downloads, extra, byId);
  /* 包自己的 npm 描述（npm 反查缓存里就有，不必为此重抓 packument）：
     子目录包的母仓库描述常常讲的是整个产品（OpenViking = "上下文数据库"），不是这个插件。 */
  const searchCache = readJson(resolve(ROOT, argOf("npm-search", "data/cache/npm-search.json")), null);
  const pkgDescriptions = new Map();
  for (const [name, rec] of Object.entries(searchCache?.packages ?? {})) {
    const text = typeof rec?.description === "string" ? rec.description.trim() : "";
    if (text) pkgDescriptions.set(name, text);
  }
  /* 构建统计（给后台「索引源 → 工作流」看）：每个阶段进出多少、被挡在哪、核验与人工介入各多少。
   * 落盘到 <out 所在目录>/build-stats.json；缺失时后台按实时缓存近似展示，不影响索引本身。 */
  const tStart = Date.now();
  const buildStats = {
    format: 1,
    startedAt: new Date().toISOString(),
    inputs: {
      meshNodes: mesh.nodes.length,
      downloadsRepos: Object.keys(downloads.repos ?? {}).length,
      npmSearchPackages: Object.keys(searchCache?.packages ?? {}).length,
      npmSubdirPackages: Object.keys(extra?.packages ?? {}).length,
      registryRecords: 0,
    },
    candidates: {
      total: candidates.length,
      picked: 0,
      fromDownloads: candidates.filter((c) => !c.subdir).length,
      fromSubdir: candidates.filter((c) => c.subdir).length,
    },
    filters: { notBundle: 0, officialModule: 0, manualBlacklist: 0, manualBlacklistScope: 0, noPackument: 0 },
    verification: null,
    overrides: {},
    labels: {},
    verdicts: {},
    skipped: { total: 0, top: [] },
    timings: {},
  };
  /* 同一个 npm 包常被「原仓库 + 一堆复刻」同时认领（远端实测：9080 个候选里 2142 个重名）。
   * 索引规定包名唯一，所以必须挑一个当门面 —— 挑法：优先非复刻 → 星标多 → 下载量多 → 仓库名。 */
  // rankOf：只在「同名认领者」之间挑门面时用（同一个包 downloads 相同，所以先看星标）。
  const rankOf = (item) => [item.node.fork ? 1 : 0, -(Number(item.node.stars) || 0), -item.downloads, item.repoId];
  // orderOf：索引的默认顺序 = 周下载量从高到低（"用的人多"最直观）；星标只当并列时的次序。
  const orderOf = (item) => [-item.downloads, item.node.fork ? 1 : 0, -(Number(item.node.stars) || 0), item.repoId];
  candidates.sort((a, b) => {
    const oa = orderOf(a);
    const ob = orderOf(b);
    for (let i = 0; i < oa.length; i += 1) {
      if (oa[i] < ob[i]) return -1;
      if (oa[i] > ob[i]) return 1;
    }
    return 0;
  });
  /* 不在这里按包名去重：同一个 npm 包常被几十个仓库同时认领（远端实测 dsh-desktop 被 91 个仓库认领）。
   * 认领者共用同一份 packument，多抓它们几乎不额外花钱；等 packument 到手，再用「npm 包自己声明的仓库」
   * 挑出真正的门面 —— 提前按下载量随便留一个，会把复刻/模板仓库当成正主展示。 */
  const picked = candidates.slice(0, LIMIT);
  buildStats.candidates.picked = picked.length;
  console.log("候选（有下载量的仓库记录）: " + candidates.length + "，本轮处理: " + picked.length + "（--limit " + LIMIT + "）");

  const { path: cachePath, cache } = await loadRegistryCache();
  buildStats.inputs.registryRecords = Object.keys(cache.packages ?? {}).length;
  const now = Date.now();
  let fetched = 0, cacheHits = 0, tooLarge = 0, failed = 0, done = 0;

  /* 并发池。为什么要并发：全量要抓近万个 packument，一个一个来要几个小时。
   * 为什么要限并发 + 退避：线上实测 npm 会在突发请求后返回 429（Cloudflare 1015），
   * 越急越封——所以并发默认 6，遇 429 退到 8 秒起步再试。 */
  const concurrency = Math.max(1, Math.min(16, Number(argOf("concurrency", 6)) || 6));
  const writeRecord = (pkg, record) => {
    cache.packages[pkg] = { v: CACHE_VERSION, at: new Date().toISOString(), ...record };
    cache.updatedAt = new Date().toISOString();
  };
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= picked.length) return;
      const item = picked[index];
      const hit = cache.packages[item.pkg];
      if (hit && hit.v === CACHE_VERSION && !REFRESH && hit.at && now - Date.parse(hit.at) < REGISTRY_TTL_MS) {
        cacheHits += 1;
        continue;
      }
      const url = "https://registry.npmjs.org/" + encodeURIComponent(item.pkg).replace(/%40/gu, "@");
      let out = { error: "未开始" };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        out = await fetchJsonCapped(url, PACKUMENT_MAX_BYTES);
        if (!out.error) break;
        await sleep(out.status === 429 ? 8000 * (attempt + 1) : 1200 * (attempt + 1));
      }
      if (out.error) {
        writeRecord(item.pkg, { error: out.error });
        failed += 1;
      } else if (out.tooLarge) {
        writeRecord(item.pkg, { tooLarge: true, bytes: out.bytes ?? null });
        tooLarge += 1;
      } else {
        const read = readPackument(out.data);
        writeRecord(item.pkg, read.skip ? { skip: read.skip } : read);
        fetched += 1;
      }
      done += 1;
      if (done % 250 === 0) {
        console.log("   进度 " + done + "/" + picked.length + "（新抓 " + fetched + " · 缓存 " + cacheHits + " · 失败 " + failed + "）");
      }
      await sleep(80);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  buildStats.timings.registryMs = Date.now() - tStart;
  console.log("registry: 新抓 " + fetched + " · 命中缓存 " + cacheHits + " · 超大跳过 " + tooLarge + " · 失败 " + failed);

  /* ---- 组装索引 ---- */
  const categories = new Map();
  const labels = new Map();
  for (const n of mesh.nodes) {
    if (n.category && !categories.has(n.category)) {
      categories.set(n.category, { title: { en: n.category, zh: n.categoryLabel ?? n.category } });
    }
  }
  /* 标签清单统一放在 tools/market-labels.mjs：后台「索引源 → 标签」要能列出中文名，包括已被隐藏、
   * 不会出现在产物 metadata.labels 里的那些。 */
  for (const def of MARKET_LABELS) labels.set(def.id, { title: { en: def.en, zh: def.zh } });
  if (hiddenLabels.size) console.log("隐藏标签：" + [...hiddenLabels].join("、") + "（后台设置，产物里不输出）");

  const plugins = [];
  const skipReasons = new Map();
  const byPkg = new Map();
  for (const item of picked) {
    const rec = cache.packages[item.pkg];
    const why = !rec ? "没有记录" : rec.error ?? (rec.tooLarge ? "packument 超大" : rec.skip);
    if (why) { skipReasons.set(item.pkg, why); buildStats.filters.noPackument += 1; continue; }
    /* 判据：作者声明了 dsh.bundle.patch（确证）→ 收；没有 dsh 字段但依赖里有 @deepseek-ai/*（老包兜底）→ 也收，
     * 只是标成「疑似」。两条都没有才挡。 */
    const confirmed = rec.isBundle === true;
    const hinted = Array.isArray(rec.dshKeys) && rec.dshKeys.length > 0;
    if (!confirmed && !hinted) {
      skipReasons.set(item.pkg, "不是 DSH 组合包（既没声明 dsh.bundle，依赖里也没有 @deepseek-ai/*）");
      buildStats.filters.notBundle += 1;
      continue;
    }
    /* 官方内部模块不进第三方市场：@deepseek-ai/* 是 DSH 自身拆出来的包（@deepseek-ai/dsh 就是主程序本身），
     * 装进 profile 属于自残；而且它们真正的家在 deepseek-harness 单仓里，本图只能拿到"谁复制了这份 package.json"
     * —— 实测门面会落到 AlexKaiqi/dsh-client-locale 这种顶名仓库上。官方组合包走 DSH 自己的实验性插件入口。 */
    if (item.pkg.startsWith("@deepseek-ai/")) { skipReasons.set(item.pkg, "DSH 官方内部模块（走 DSH 自带入口，不进第三方市场）"); buildStats.filters.officialModule += 1; continue; }
    /* 人工拉黑：精确包名，或整个作用域（如 "@chatcode" → @chatcode/* 全不收录）。 */
    const blacklistReason = packageBlacklistReason(overrides.lists, item.pkg);
    if (blacklistReason) {
      skipReasons.set(item.pkg, blacklistReason);
      buildStats.filters.manualBlacklist += 1;
      if (blacklistReason.includes("作者")) buildStats.filters.manualBlacklistScope += 1;
      continue;
    }
    if (!byPkg.has(item.pkg)) byPkg.set(item.pkg, []);
    byPkg.get(item.pkg).push(item);
  }
  const compareRank = (x, y) => {
    const rx = rankOf(x);
    const ry = rankOf(y);
    for (let i = 0; i < rx.length; i += 1) {
      if (rx[i] < ry[i]) return -1;
      if (rx[i] > ry[i]) return 1;
    }
    return 0;
  };

  /* ---- 子目录归属校验（先查，后组装）----
   * 只对「npm 包自己声明了 repository.directory」的条目查：去那个仓库里读目录下的 package.json，
   * name 对得上 -> confirmed；目录不存在/本地路径 -> refuted；网络/限流 -> unverified（不改写结论）。
   * 这一步是"repo 里确实有它"的唯一直接证据；之前索引在这里完全信 npm 自述，线上被 6 个
   * dsh-ab-* 包（发布账号 aiscope，directory 写 .dsh/plugins/…）+ 1 个 @szx-a 包冒用官方仓库。 */
  const subdirVerdicts = new Map(); // pkg -> { verdict, reason }
  if (SUBDIR_VERIFY) {
    const token = loadGitHubToken({ env: process.env, envFile: join(ROOT, ".env") });
    if (!token) {
      console.log("子目录校验：未配置 GITHUB_TOKEN，跳过（索引仍按 npm 自述归属；要校验请 export GITHUB_TOKEN=…）");
    } else {
      const targets = [];
      const codeTargets = [];
      for (const [pkg, claimants] of byPkg) {
        const rec = cache.packages[pkg];
        const directory = String(rec?.repositoryDirectory ?? "").trim();
        const resolved = resolveOwner({ npmRepo: rec.repository, claimants, meshById });
        const repoKeyForCheck = resolved.repoId ?? claimants.slice().sort(compareRank)[0]?.repoId ?? null;
        if (directory && classifyRepositoryDirectory(directory).kind !== "absent") {
          if (repoKeyForCheck) targets.push({ pkg, repoKey: repoKeyForCheck, directory });
          continue;
        }
        /* 没有 repository.directory 的条目：高星的都用 code search 兜底（见 repo-dir-verify.mjs）。
         * 两类来源都要查：
         *  · 子目录候选（chosen.subdir）：认领关系来自 npm 自述反查，属于循环论证，低星直接判未核实；
         *  · 非子目录但归属未确证（DECLARED_IN_MESH）：典型是 monorepo 子包（dsh-web 的 @linxin666/*），
         *    npm 声明的仓库在图里、但仓库没在根 package.json 里声明包名 —— 仓库里搜 package.json 就能确证。 */
        const fallback = claimants.slice().sort(compareRank)[0] ?? null;
        const chosen = resolved.item ?? fallback;
        const subdirCandidate = Boolean(chosen?.subdir);
        if (!subdirCandidate && resolved.verified) continue; // 已确证的非子目录条目不用再查
        const stars = Number(resolved.node?.stars ?? chosen?.node?.stars ?? 0) || 0;
        if (repoKeyForCheck && stars >= SUBDIR_CODESEARCH_MIN_STARS) {
          codeTargets.push({ pkg, repoKey: repoKeyForCheck, directory: "", gitHead: typeof rec.gitHead === "string" ? rec.gitHead : null, publisher: typeof rec.npmUser === "string" ? rec.npmUser : null });
        } else if (subdirCandidate) {
          subdirVerdicts.set(pkg, { verdict: VERDICT.UNVERIFIED, reason: "no-directory" });
        }
      }
      const tVerify0 = Date.now();
      const verdictRun = await runSubdirVerification({
        targets: [...targets, ...codeTargets],
        cache: readRepoDirCache(SUBDIR_CACHE),
        fetchPackageJson: createGitHubPackageJsonFetcher({ token }),
        // 目录现在不存在时再查一次历史提交：历史里出现过 = 后来搬走了，不当冒充驳回
        fetchDirectoryHistory: createGitHubDirectoryHistoryFetcher({ token }),
        // 没有目录的包改用 code search + gitHead 证据链（code search 自带 7 秒限速）
        fetchCodeSearch: createGitHubCodeSearchFetcher({ token }),
        fetchCommitExists: createGitHubCommitFetcher({ token }),
        ttlMs: SUBDIR_TTL_MS,
        concurrency: SUBDIR_CONCURRENCY,
        log: (line) => console.log("   " + line),
      });
      writeRepoDirCache(SUBDIR_CACHE, verdictRun.cache);
      buildStats.verification = {
        ...verdictRun.stats,
        // 本轮真正发起的 code search 数（缓存命中时是 0）；缓存里已有的结论单独给一个数，工作流页要能看出来
        codeSearchCached: Object.keys(verdictRun.cache.entries ?? {}).filter((key) => String(key).includes("#::")).length,
      };
      buildStats.timings.verifyMs = Date.now() - tVerify0;
      for (const [pkg, entry] of verdictRun.results) subdirVerdicts.set(pkg, judgeSubdirCheck(entry, pkg, entry.repoKey ?? null));
      const counts = { confirmed: 0, unverified: 0, refuted: 0 };
      for (const v of subdirVerdicts.values()) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
      const movedCount = verdictRun.stats.moved;
      console.log(
        "   判定：" + counts.confirmed + " 确证 · " + counts.unverified + " 未核实（其中目录搬走 " + movedCount + "）· " +
          counts.refuted + " 驳回（本地路径/从未存在过的目录）",
      );
      const refuted = [...subdirVerdicts].filter(([, v]) => v.verdict === VERDICT.REFUTED);
      for (const [pkg, v] of refuted.slice(0, 8)) console.log("   · 驳回 " + pkg + "：" + v.reason);
      if (refuted.length > 8) console.log("   · 另有 " + (refuted.length - 8) + " 条驳回");
    }
  }
  /* ---- 第 4 层：npm 发布溯源（provenance）----
   * 只查"声称仓库星标 ≥ 阈值"的包（默认 100）：高星仓库的身份最值得保护，请求量也可控。
   * 结论按 pkg@version 缓存 30 天（版本不可变），后续轮次基本零成本。 */
  const provenanceResults = new Map();
  if (PROVENANCE_VERIFY) {
    const targets = [];
    for (const [pkg, claimants] of byPkg) {
      const rec = cache.packages[pkg];
      const version = typeof rec?.latestTag === "string" && rec.latestTag ? rec.latestTag : null;
      if (!version) continue;
      const resolved = resolveOwner({ npmRepo: rec.repository, claimants, meshById });
      const fallback = claimants.slice().sort(compareRank)[0] ?? null;
      const node = resolved.node ?? fallback?.node ?? null;
      if ((Number(node?.stars) || 0) < PROVENANCE_MIN_STARS) continue;
      if (!resolved.repoId && !fallback?.repoId) continue;
      targets.push({ pkg, version });
    }
    const provRun = await runProvenanceVerification({
      targets,
      cache: readProvenanceCache(PROVENANCE_CACHE),
      fetchProvenance: createNpmProvenanceFetcher(),
      concurrency: PROVENANCE_CONCURRENCY,
      log: (line) => console.log("   " + line),
    });
    writeProvenanceCache(PROVENANCE_CACHE, provRun.cache);
    for (const [pkg, entry] of provRun.results) provenanceResults.set(pkg, entry);
    buildStats.provenance = provRun.stats;
    const matched = [...provenanceResults.values()].filter((x) => x.state === "ok").length;
    console.log("   溯源判定：有 SLSA 溯源 " + matched + " 条（仓库一致/不一致在组装阶段生效）");
  }

  let mergedClaimants = 0;
  /** 人工裁决/名单命中统计（只进日志，不进索引）。 */
  const overrideCounts = new Map();
  /** 展示层判定计数（给工作流页看最终去向）。 */
  const verdictCounts = { confirmed: 0, unverified: 0, refuted: 0, unattributed: 0 };
  const tAssemble0 = Date.now();
  /** 归属证据分布：运维要能一眼看出"多少条是确证的、多少条是待确认的"。 */
  const evidenceCounts = new Map();
  /* 生态图「索引仓库」光环名单：只有"索引把插件归给了它"的仓库才配叫索引仓库。
   * 单独落一份小文件给 /api/npm-nodes 读，免得为了几十 KB 的名单去解析 8.5MB 的索引。 */
  const haloIds = new Set();
  /* 同名认领的统计（只进日志，不进索引）：一个包名被几个仓库抢。 */
  for (const [pkg, claimants] of byPkg) {
    const rec = cache.packages[pkg];
    /* 归属只认证据，不认人气：见 resolveOwner 的注释。
     * compareRank 现在**只**用来挑"这一行显示哪份下载量/排序数字"，不再用来决定作者是谁。 */
    const resolved = resolveOwner({ npmRepo: rec.repository, claimants, meshById });
    evidenceCounts.set(resolved.evidence, (evidenceCounts.get(resolved.evidence) ?? 0) + 1);
    if (claimants.length > 1) mergedClaimants += claimants.length - 1;
    const fallback = claimants.slice().sort(compareRank)[0] ?? null;
    const chosen = resolved.item ?? fallback;
    const node = resolved.node;
    /* 子目录校验的结论（没查过的包没有结论，保持原有行为）：
     * · confirmed  -> 仓库里确实有这个包，可以外借仓库身份，也配叫「仓库内子包」；
     * · refuted    -> 目录不存在/是本地路径：不许再外借标题、头像、作者、星标（identity = null），
     *                 否则官方仓库的名字还会挂在一个并不住在里面的包前面；
     * · unverified -> 查不了（网络/限流/名字对不上），照旧显示但打「作者待确认」，不静默改写。 */
    const check = subdirVerdicts.get(pkg) ?? null;
    const baseDecision = decideEntryAttribution({ node, resolved, chosen, check });
    /* 第 4 层：npm 发布溯源（有签名就压过自动核验；人工裁决仍压过它）。 */
    const withProvenance = applyProvenanceAttribution(baseDecision, provenanceResults.get(pkg) ?? null, {
      node,
      repoKey: resolved.repoId ?? chosen?.repoId ?? null,
    });
    const applied = applyAttributionOverrides({
      pkg,
      base: withProvenance,
      node,
      rec,
      repoId: resolved.repoId ?? chosen?.repoId ?? null,
      overrides,
    });
    const { identity, refuted, attributionVerified, subdirLabel } = applied;
    if (applied.source !== "auto") overrideCounts.set(applied.source, (overrideCounts.get(applied.source) ?? 0) + 1);
    if (refuted) verdictCounts.refuted += 1;
    else if (attributionVerified) verdictCounts.confirmed += 1;
    else if (!identity && !resolved.owner) verdictCounts.unattributed += 1;
    else verdictCounts.unverified += 1;
    // 第 4 层溯源判定分布（match/mismatch/none/error/unknown）
    buildStats.provenanceVerdicts = buildStats.provenanceVerdicts || { match: 0, mismatch: 0, none: 0, error: 0, unknown: 0 };
    const pv = applied.provenance || "none";
    buildStats.provenanceVerdicts[pv] = (buildStats.provenanceVerdicts[pv] ?? 0) + 1;
    const repoUrl = !refuted && identity && typeof identity.htmlUrl === "string" && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+$/u.test(identity.htmlUrl)
      ? identity.htmlUrl
      : !refuted && resolved.repoId
        ? "https://github.com/" + resolved.repoId
        : null;
    const freshRelease = isFreshRelease(rec.versions);
    const entry = {
      name: pkg,
      /* 插件名 = npm 包名：仓库名（dsh-web / dsh-market / deepseek-harness）只说明"它住在哪"，
       * 拿仓库名当插件名会让同一仓库的多个包看起来是同一个插件，也给了冒名者借名字的机会。 */
      title: pkg,
      /* 人气数字：索引格式里**没有"显示数字"的字段**（sortKeys 只进排序菜单，值不显示），
       * 而前端渲染的字段只有 标题 / 标签胶囊 / 描述 / 版本·作者·日期。描述是唯一能放自由文本的位，
       * 且列表里两行截断 —— 所以把数字放**开头**，放结尾会被截掉。
       * 为什么不做分档标签：实测这个生态 97.7% 的插件星标 <100、92% 周下载 <1000，分档会全挤在最低档，没有信息量。
       *
       * 只放数字，不放「周下载」三个字：DSH 的发现页把 description 当检索字段
       * （@deepseek-ai/dsh-plugin-market 的 MarketSearch：fields 含 description，boost 1），
       * 而它的分词把 CJK 串切成相邻二字对 ——「周下载」会切成 周下/下载/载 三个词，
       * 于是**每个**插件的描述都带上这三个词：实测搜「下载」命中全部 6589 个插件，一个常用词就这么废了。
       * 数字本身几乎无害（实测「8k」命中 23 个、「6」命中 199 个），而数字是这套格式里唯一能让用户
       * 看到"人气"的办法，所以保留数字、去掉中文词。数字的含义写在索引级 description 里（那段不进检索）。 */
      description: (() => {
        const tone = toneOf(identity?.stars ?? 0, chosen?.hasDownloads ?? false, chosen?.downloads ?? 0);
        /* 归属没定下来时（evidence=ambiguous / 子目录被驳回）没有仓库描述可用，退回 npm 自己的描述：
         * 宁可描述朴素，也不能拿别人的仓库描述冒充。 */
        const own = chosen?.subdir || !identity ? pkgDescriptions.get(pkg) ?? "" : "";
        const body = own || (typeof identity?.description === "string" ? identity.description.trim() : "");
        return body ? tone + " —— " + body : tone;
      })(),
      icon: identity && typeof identity.avatar === "string" && identity.avatar.startsWith("https://") ? identity.avatar : undefined,
      // 作者名只来自证据：resolveOwner 认不出、或者目录被驳回，就留空，不静默把一个错的名字当事实
      author: refuted ? undefined : resolved.owner ?? undefined,
      repository: repoUrl ? { url: repoUrl } : undefined,
      metadata: {
        category: identity && categories.has(identity.category) ? identity.category : undefined,
        keywords: keywordsOf(identity ?? { topics: [] }, pkg),
        labels: filterHiddenLabels(
          [
            rec.isBundle ? "dsh-bundle" : "dsh-bundle-unconfirmed",
            ...(rec.hasClient ? ["has-client"] : []),
            ...(freshRelease ? ["recent-release"] : []),
            // 「仓库内子包」是事实主张：只有目录里的 package.json 真的写了这个名字才配挂
            ...(subdirLabel ? ["subdir-package"] : []),
            // 第 4 层证据：npm provenance 与声称仓库一致（密码学级别）
            ...(applied.provenance === "match" && attributionVerified && !refuted ? ["provenance-verified"] : []),
            // 作者名不是"两边一致"证实的，就明说待确认 —— 不静默把一个可能错的名字当事实
            ...(attributionVerified ? [] : ["owner-unverified"]),
            "star-cta", // 行动号召：所有条目都挂（用户要求）
          ],
          hiddenLabels,
        ),
        sortKeys: { stars: Number(identity?.stars) || 0, downloads: chosen?.downloads ?? 0 },
      },
      /* 不写 engines：DSH 的校验器（@deepseek-ai/dsh-plugin-market-index 的 marketVersion）对这一项是
       * optional(...) ?? {}，缺失就补一个空对象 —— 写与不写完全等价，21852 个版本各带一个 "engines":{}
       * 纯属白送体积（原始约 280 KB）。 */
      versions: versionEntries(rec.versions),
    };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    if (entry.metadata.category === undefined) delete entry.metadata.category;
    plugins.push(entry);
    /* 光环按【索引的归属】收，不按"仓库里写了个包名"收 —— 后者会把抢名的路人一起点亮。
     * 图里有的用原始 id（大小写必须与节点一致），图外的用 repoKey 的小写（那种本来也没球可点）。 */
    // 驳回的条目不把仓库点亮成「索引仓库」：索引并没有把它归给那个仓库
    if (identity?.id) haloIds.add(identity.id);
    else if (!refuted && resolved.repoId) haloIds.add(resolved.repoId);
  }

  /* ---- 第 5 层：索引不变量自检（产物级）----
   * 前面几层管"归给谁"，这一层管"产物本身有没有写坏"：包名唯一、title=包名、版本/时间戳/标签/仓库格式合法。
   * 与 auditOwnership 一样：写盘之后喊出来，不假装成功。 */
  const visibleLabelIds = new Set([...labels.keys()].filter((id) => !hiddenLabels.has(id)));
  buildStats.hiddenLabels = [...hiddenLabels];
  const selfCheck = validateIndex(plugins, visibleLabelIds);
  buildStats.selfCheck = { violations: selfCheck.length, sample: selfCheck.slice(0, 10) };
  if (selfCheck.length) {
    console.error("✗ 索引不变量自检未通过：" + selfCheck.length + " 条");
    for (const v of selfCheck.slice(0, 8)) console.error("   - " + v.pkg + "：" + v.why);
    process.exitCode = 1;
  } else {
    console.log("✓ 索引不变量自检通过（包名唯一 / title=包名 / 版本与标签合法 / 仓库地址格式正确）");
  }

  /* 分类计数：索引格式里 category 声明**只有 title、没有计数字段**（前端 displayDeclarations 也只渲染 title），
   * 所以把数量直接写进标题 —— 界面上就是「安全权限 · 231」。这个数字是生成那一刻的快照。
   * 一个插件都没有的分类不声明：声明了前端会多出一个点了没结果的空筛选项。 */
  const categoryCounts = new Map();
  for (const plugin of plugins) {
    const id = plugin.metadata.category;
    if (id) categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
  }
  const declaredCategories = {};
  for (const [id, value] of categories) {
    const count = categoryCounts.get(id) ?? 0;
    if (!count) continue;
    declaredCategories[id] = { title: { en: value.title.en + " · " + count, zh: value.title.zh + " · " + count } };
  }

  /* 默认顺序随机打乱：原来按周下载量从高到低，头部永远霸屏，长尾插件几乎没有曝光机会。
     --limit 的截断仍然按人气排序（picked），所以被裁掉的是长尾，不是随机丢。
     用带种子的洗牌并打印 seed：顺序看着不对时，用同一个 --seed 能复现这一次。 */
  const seed = Number(argOf("seed", Date.now())) || Date.now();
  const ordered = shuffled(plugins, seededRandom(seed));
  console.log("默认顺序：随机打乱（seed=" + seed + " · " + ordered.length + " 条）");

  const index = {
    format: 1,
    title: { en: "DSH Plugin Ecosystem · " + plugins.length, zh: "DSH 插件生态图 · " + plugins.length },
    description: {
      en: "Installable DSH plugin bundles catalogued by the dsh-plugin-mesh ecosystem graph. A description starts with GitHub stars (shown once the repo has at least 10) and weekly npm downloads (— when npm has no figure yet). The list order is shuffled on every rebuild, so every plugin gets a turn in front; use the sort menu to order by stars or downloads.",
      zh: "由 dsh-plugin-mesh 生态图整理的可安装 DSH 插件组合包。描述开头是星标数与周 npm 下载量（星标不足 10 的只显示下载量；显示「—」表示 npm 还没统计到）。列表顺序每次重建随机打乱，让每个插件都有机会排到前面；要按星标或下载量排，请用排序菜单。",
    },
    metadata: {
      categories: declaredCategories,
      labels: Object.fromEntries([...labels].filter(([id]) => !hiddenLabels.has(id))),
      sortKeys: {
        stars: { title: { en: "Stars", zh: "星标" }, order: "desc" },
        downloads: { title: { en: "Weekly downloads", zh: "周下载量" }, order: "desc" },
      },
    },
    plugins: ordered,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(index, null, 1));
  /* 生态图外圈光环名单（serve 的 /api/npm-nodes 读它）。
   * 为什么必须由索引产出：旧判据是"仓库 package.json 里写了个 npm 上存在的包名"，不校验归属 ——
   * 线上实测 9830 个这样的仓库里，2091 个的包在索引里其实归别人（同名抢注），
   * 图上有 10144 个球被标成「索引仓库」。名单与索引同源，两处口径就不可能再漂。 */
  const haloPath = join(dirname(OUT), "index-nodes.json");
  writeFileSync(haloPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: haloIds.size, ids: [...haloIds].sort() }));
  console.log("写入 " + haloPath + "：" + haloIds.size + " 个仓库（生态图「索引仓库」光环名单，与索引归属同源）");
  console.log("写入 " + OUT + "：" + plugins.length + " 个插件 · " + (JSON.stringify(index).length / 1024).toFixed(0) + " KB");

  /* 构建统计落盘：后台「索引源 → 工作流」直接读它画流水线（每个阶段进出多少、挡在哪）。
   * 与索引同目录；失败不影响索引本身。 */
  try {
    const labelCounts = {};
    for (const plugin of plugins) for (const label of plugin.metadata.labels ?? []) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
    buildStats.finishedAt = new Date().toISOString();
    buildStats.timings.assembleMs = Date.now() - tAssemble0;
    buildStats.timings.totalMs = Date.now() - tStart;
    buildStats.verdicts = verdictCounts;
    buildStats.labels = labelCounts;
    buildStats.overrides = Object.fromEntries(overrideCounts);
    buildStats.skipped = {
      total: skipReasons.size,
      top: [...skipReasons.entries()].slice(0, 30).map(([pkg, why]) => ({ pkg, why })),
    };
    buildStats.index = { plugins: plugins.length, categories: Object.keys(declaredCategories).length, haloRepos: haloIds.size };
    buildStats.seed = seed;
    writeFileSync(join(dirname(OUT), "build-stats.json"), JSON.stringify(buildStats, null, 1));
  } catch (err) {
    console.log("构建统计写入失败（不影响索引）：" + String(err && err.message ? err.message : err));
  }
  if (mergedClaimants) {
    console.log("同名认领合并: " + mergedClaimants + " 条仓库记录归到同一个包名下");
  }
  /* 归属证据分布必须每次都打：这是"索引里多少条的作者是确证的"唯一可见来源。
   * 数字变差（ambiguous 变多）说明采集侧出问题了，不是"指数正常波动"。 */
  const EVIDENCE_ZH = {
    [OWNER_EVIDENCE.DECLARED_IN_CLAIMANTS]: "确证（npm 声明的仓库就是声明者之一）",
    [OWNER_EVIDENCE.DECLARED_IN_MESH]: "待确认（npm 声明的仓库在图里，但它没声明这个包名）",
    [OWNER_EVIDENCE.DECLARED_ONLY]: "待确认（npm 声明的仓库不在本地数据里）",
    [OWNER_EVIDENCE.SOLE_CLAIMANT]: "待确认（npm 没写仓库，只有唯一声明者）",
    [OWNER_EVIDENCE.AMBIGUOUS]: "不署名（npm 没写仓库且有多个声明者）",
  };
  const evidenceTotal = [...evidenceCounts.values()].reduce((a, b) => a + b, 0) || 1;
  console.log("归属证据：");
  for (const [key, label] of Object.entries(EVIDENCE_ZH)) {
    const n = evidenceCounts.get(key) ?? 0;
    console.log("   " + String(n).padStart(5) + "  " + (100 * n / evidenceTotal).toFixed(1).padStart(5) + "%  " + label);
  }
  /* 统计用内部判定计数（verdictCounts），不用标签数 —— 标签可能被后台隐藏，数字不能跟着消失。 */
  const unverified = verdictCounts.unverified + verdictCounts.refuted + verdictCounts.unattributed;
  const nameless = plugins.filter((p) => !p.author).length;
  console.log("待确认 " + unverified + " 条（其中 " + nameless + " 条没写作者名）· 确证 " + verdictCounts.confirmed + " 条");
  if (overrideCounts.size) {
    console.log("人工介入：" + [...overrideCounts.entries()].map(([k, v]) => k + " " + v + " 条").join(" · "));
  }
  /* 自检：产物已经写盘，这里只做"喊出来"。退出码非 0 不会毁掉这一轮 —— 采集器的
   * _market_index_fresh 只看产物是否完整写出，所以日志里能看到失败、索引仍然可用。 */
  const violations = auditOwnership(plugins, cache.packages, { hiddenLabels });
  if (violations.length) {
    console.error("✗ 归属自检未通过：" + violations.length + " 条把猜测当事实");
    for (const v of violations.slice(0, 8)) {
      console.error("   - " + v.pkg + "：" + v.why + "（npm 声明 " + v.declared + " / 索引写的 " + v.listed + "）");
    }
    process.exitCode = 1;
  } else {
    console.log("✓ 归属自检通过：没有一行把猜测当事实");
  }
  const skipped = [...skipReasons.entries()].map(([pkg, why]) => ({ pkg, why }));
  if (skipped.length) {
    console.log("未收录 " + skipped.length + " 个：");
    for (const s of skipped.slice(0, 12)) console.log("   - " + s.pkg + "：" + s.why);
    if (skipped.length > 12) console.log("   …还有 " + (skipped.length - 12) + " 个");
  }
}

/* 直接执行时跑一次；被 import（例如单测）时什么都不做 —— 否则 import 一下就会真的去抓 npm。 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("market-index 失败：" + (err?.stack ?? err));
    process.exit(1);
  });
}
