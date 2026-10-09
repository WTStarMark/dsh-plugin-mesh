/**
 * 只读查询 API + 可分享卡片。
 *
 * 设计原则：
 *   1. 零依赖、零构建：只用 Node 标准库，数据直接读 data/mesh.json。
 *   2. 只读、无副作用：不接受任何写操作，不接触 .env / 令牌 / 缓存目录。
 *   3. 同端口：由 tools/serve.mjs 挂在同一个 HTTP 服务上（本地 8788 / 线上 80）。
 *   4. 输出可缓存：数据每小时更新，API 响应给 5 分钟公共缓存。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { stripNoiseOwners } from "../src/mesh-data.js";
/* 每日界限：按该时区（UTC 偏移小时数）的 00:00 切天，必须与 backend/dsh_mesh/config.py 的
 * DAY_TZ_OFFSET_HOURS 一致（默认 +8 = 北京时间 00:00 换日，而不是 UTC 00:00 = 北京 08:00）。 */
export const DAY_TZ_OFFSET_HOURS = Number(process.env.DAY_TZ_OFFSET_HOURS ?? 8);

/**
 * 某个时刻落在"哪一天"，按 DAY_TZ_OFFSET_HOURS 的 00:00 切天。
 * 接受毫秒数或 ISO 字符串；解析不出来返回空串（调用方按"不在轴上"处理）。
 * 绝不能抛：这里曾经对已经转成毫秒的入参又 Date.parse 一次，得到 NaN 后
 * toISOString 抛 RangeError，把 /api/ranking 整个请求挂死。
 */
export const dayOf = (when) => {
  const ms = typeof when === "number" ? when : Date.parse(String(when ?? ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + DAY_TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
};


const DATA_TTL_MS = 5 * 60 * 1000;
/** 卡片默认去处：线上站点（可用 SITE_URL 环境变量或 ?link= 覆盖） */
export const DEFAULT_SITE = "http://104.129.51.126/";
export const MAX_LIMIT = 100;
/** 榜单弹窗的行数上限：周更新热榜与周 star 热榜都是 50 行 */
export const RANKING_LIMIT = 50;
const SORTS = {
  stars: (a, b) => (b.stars ?? 0) - (a.stars ?? 0),
  pushed: (a, b) => String(b.pushedAt ?? "").localeCompare(String(a.pushedAt ?? "")),
  created: (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  name: (a, b) => String(a.id).localeCompare(String(b.id)),
};

export function xmlEscape(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 粗略估算文本像素宽度：中日韩全角按 1 em，其余按 0.55 em（不引外部字体度量） */
export function textWidth(text, size) {
  let w = 0;
  for (const ch of String(text ?? "")) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60]/.test(ch) ? size : size * 0.55;
  return w;
}

/** 按可用宽度裁剪（比按字符数裁剪可靠：中文一行放不下 62 个字） */
export function fitText(text, size, maxWidth) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (textWidth(s, size) <= maxWidth) return s;
  let out = "";
  for (const ch of s) {
    if (textWidth(out + ch + "…", size) > maxWidth) break;
    out += ch;
  }
  return out + "…";
}

/** 按宽度换行（最多 maxLines 行，最后一行超出才省略）—— 卡片描述用 */
const NO_LINE_START = "，。、；：？！）】》」』”’…—·%,.;:?!)]}";

export function wrapText(text, size, maxWidth, maxLines = 2) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const lines = [];
  let rest = s;
  while (rest && lines.length < maxLines) {
    if (textWidth(rest, size) <= maxWidth) {
      lines.push(rest);
      rest = "";
      break;
    }
    let cut = 0;
    let acc = "";
    for (const ch of rest) {
      if (textWidth(acc + ch, size) > maxWidth) break;
      acc += ch;
      cut += ch.length;
    }
    // 避头尾：标点不能出现在行首，把它拉回上一行
    const head = rest.slice(cut);
    if (head && NO_LINE_START.includes(head[0])) {
      acc += head[0];
      cut += 1;
    }
    if (lines.length === maxLines - 1) {
      // 最后一行：裁剪到放得下省略号
      let last = "";
      for (const ch of rest) {
        if (textWidth(last + ch + "…", size) > maxWidth) break;
        last += ch;
      }
      lines.push(last + "…");
      rest = "";
      break;
    }
    lines.push(acc);
    rest = rest.slice(cut).trim();
  }
  return lines;
}

export function clip(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** 稳定的扇区主色：同一分类永远同一颜色，与主题无关（卡片要能独立成立） */
export function categoryColor(key) {
  let hash = 0;
  const s = String(key ?? "other");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) % 360;
  return hslToHex(hash, 62, 58);
}

function hslToHex(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}

/** 仓库名分段合法性：只允许 GitHub 允许的字符，挡住路径穿越类尝试 */
export function validNamePart(part) {
  return typeof part === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(part);
}

/** GitHub 仓库 / 星标 / 复刻 图标（Octicons 16×16 路径） */
const ICON_REPO = "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z";
const ICON_STAR = "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z";
const ICON_FORK = "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z";

/** 语言色点：取自 GitHub linguist 的常用语言颜色 */
export const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Shell: "#89e051",
  Go: "#00ADD8", Rust: "#dea584", Java: "#b07219", "C#": "#178600", "C++": "#f34b7d",
  C: "#555555", Ruby: "#701516", PHP: "#4F5D95", Swift: "#F05138", Kotlin: "#A97BFF",
  Dart: "#00B4AB", Vue: "#41b883", Svelte: "#ff3e00", HTML: "#e34c26", CSS: "#563d7c",
  SCSS: "#c6538c", Lua: "#000080", Zig: "#ec915c", Nix: "#7e7eff", "Objective-C": "#438eff",
  PowerShell: "#012456", Dockerfile: "#384d54", Makefile: "#427819", "Jupyter Notebook": "#DA5B0B",
  Astro: "#ff5a03", MDX: "#fcb32c", MoonBit: "#b92381", Batchfile: "#C1F12E",
};

/** 相对时间：GitHub 卡片的「更新于 …」 */
export function relativeTime(iso, now = Date.now()) {
  const ts = Date.parse(String(iso ?? ""));
  if (!ts) return "未知";
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  const day = Math.floor(hour / 24);
  if (day < 30) return day + " 天前";
  const month = Math.floor(day / 30);
  if (month < 12) return month + " 个月前";
  return Math.floor(month / 12) + " 年前";
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif";

export function createApi({ root }) {
  let cache = { at: 0, mesh: null };
  // README 索引：采集器每轮抓一批，落盘 data/cache/readmes.json。
  // 检索时把它拼成【一个全小写的大字符串】，用 indexOf 找命中位置、再二分定位到仓库 id——
  // 这样每次查询只有一次内存扫描，不必对几万篇正文逐篇 toLowerCase()。
  let readmeCache = { mtimeMs: -1, blob: "", ids: [], offsets: [], indexed: 0 };
  const README_SEP = "\u0000";

  async function load() {
    // 按【文件 mtime】缓存，而不是固定 5 分钟 TTL：
    // mesh.json 有 21MB，JSON.parse 要 ~1 秒，而且会阻塞整个事件循环；
    // 每 5 分钟重解析一次 = 所有并发请求（含前端每 15 秒一次的 /api/status 轮询）被卡一下。
    const file = join(root, "data", "mesh.json");
    const info = await stat(file).catch(() => null);
    if (cache.mesh && info && cache.mtimeMs === info.mtimeMs) return cache.mesh;
    const raw = await readFile(file, "utf8");
    // 噪声黑名单兜底：旧快照里若还留着垃圾账号，接口也不该再吐出来（无噪声时是空操作）
    const mesh = stripNoiseOwners(JSON.parse(raw));
    cache = { at: Date.now(), mtimeMs: info?.mtimeMs ?? -1, mesh };
    return mesh;
  }

  async function loadReadmes() {
    // 优先读 gzip 版（采集器写的是 readmes.json.gz，约 10MB/1.9 万仓库）；
    // 老的 readmes.json 也认，方便迁移期与测试夹具。
    let file = null;
    let info = null;
    for (const candidate of [join(root, "data", "cache", "readmes.json.gz"), join(root, "data", "cache", "readmes.json")]) {
      const s = await stat(candidate).catch(() => null);
      if (s) {
        file = candidate;
        info = s;
        break;
      }
    }
    if (!file) return readmeCache;
    if (readmeCache.mtimeMs === info.mtimeMs) return readmeCache;
    try {
      const raw = await readFile(file);
      const data = JSON.parse(file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
      const docs = data.docs ?? {};
      const parts = [];
      const ids = [];
      const offsets = [];
      let at = 0;
      for (const [id, doc] of Object.entries(docs)) {
        const text = String(doc?.t ?? "").toLowerCase();
        if (!text) continue;
        ids.push(id);
        offsets.push(at);
        parts.push(text);
        at += text.length + 1;
      }
      readmeCache = { mtimeMs: info.mtimeMs, blob: parts.join(README_SEP), ids, offsets, indexed: Number(data.count ?? ids.length) || ids.length };
    } catch {
      readmeCache = { mtimeMs: info.mtimeMs, blob: "", ids: [], offsets: [], indexed: 0 };
    }
    return readmeCache;
  }

  /** README 命中集合（小写子串；q 需已小写） */
  function readmeHits(q) {
    const out = new Set();
    const { blob, ids, offsets } = readmeCache;
    if (!q || !blob) return out;
    let i = blob.indexOf(q);
    while (i !== -1) {
      let lo = 0;
      let hi = offsets.length - 1;
      let hit = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= i) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      out.add(ids[hit]);
      i = blob.indexOf(q, i + 1);
    }
    return out;
  }

  function publicNode(n) {
    return {
      id: n.id,
      name: n.name,
      owner: n.owner,
      stars: n.stars ?? 0,
      forks: n.forks ?? 0,
      language: n.language ?? null,
      category: n.category ?? null,
      categoryLabel: n.categoryLabel ?? null,
      subcategory: n.subcategory ?? null,
      subcategoryLabel: n.subcategoryLabel ?? null,
      tags: n.matchedTags ?? [],
      description: n.description ?? "",
      topics: n.topics ?? [],
      license: n.license ?? null,
      homepage: n.homepage ?? null,
      createdAt: n.createdAt ?? null,
      pushedAt: n.pushedAt ?? null,
      archived: !!n.archived,
      review: !!n.review,
      verdict: n.verdict ?? (n.review ? "manual" : "related"),
      reason: n.reason ?? null,
      url: "https://github.com/" + n.id,
    };
  }

  function slim(n) {
    return {
      id: n.id,
      stars: n.stars ?? 0,
      categoryLabel: n.categoryLabel ?? null,
      subcategoryLabel: n.subcategoryLabel ?? null,
      language: n.language ?? null,
      description: clip(n.description, 120),
    };
  }

  async function search(params) {
    const mesh = await load();
    const nodes = mesh.nodes ?? [];
    const q = String(params.get("q") ?? "").trim().toLowerCase();
    const category = params.get("category");
    const subcategory = params.get("subcategory");
    const tag = params.get("tag");
    const language = params.get("language");
    const minStars = Number(params.get("minStars") ?? 0) || 0;
    const archived = params.get("archived");
    const sortKey = SORTS[params.get("sort")] ? params.get("sort") : "stars";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get("limit") ?? 20) || 20));
    const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
    const wantAll = params.get("fields") === "all";

    let hits = nodes;
    if (category) hits = hits.filter((n) => n.category === category);
    if (subcategory) hits = hits.filter((n) => n.subcategory === subcategory);
    if (tag) hits = hits.filter((n) => (n.matchedTags ?? []).includes(tag));
    if (language) hits = hits.filter((n) => n.language === language);
    if (minStars > 0) hits = hits.filter((n) => (n.stars ?? 0) >= minStars);
    if (archived === "hide") hits = hits.filter((n) => !n.archived);
    if (archived === "only") hits = hits.filter((n) => n.archived);
    let readme = { indexed: 0, total: 0 };
    if (q) {
      await loadReadmes();
      const viaReadme = readmeHits(q);
      readme = { indexed: readmeCache.indexed, total: 0 };
      const before = hits.length;
      hits = hits.filter((n) => {
        const hay = [n.id, n.description, (n.topics ?? []).join(" "), (n.matchedTags ?? []).join(" ")]
          .join(" ")
          .toLowerCase();
        return hay.includes(q) || viaReadme.has(n.id);
      });
      // 只看 README 才命中的那部分（用于响应里如实区分）
      readme.total = hits.filter((n) => viaReadme.has(n.id)).length;
      void before;
    }
    const total = hits.length;
    hits = hits.slice().sort(SORTS[sortKey]);
    const page = hits.slice(offset, offset + limit);
    return {
      query: { q, category, subcategory, tag, language, minStars, archived, sort: sortKey, limit, offset },
      readme,
      total,
      count: page.length,
      offset,
      limit,
      generatedAt: mesh.meta?.generatedAt ?? null,
      items: page.map((n) => (wantAll ? publicNode(n) : slim(n))),
    };
  }


  /* ---------------- 榜单（v0.5.0）：周更新热榜 / 周 star 热榜 ----------------
   * 两个榜单都只用"盘上真的有的东西"算，算不出来的绝不编：
   *   周更新热榜 = pushedAt 落在窗口内的仓库，按最近推送排序（GitHub 事实，直接可用）
   *   周 star 热榜 = 两个时间点的星标之差。历史点来自：
   *     ① data/cache/star-history.json —— 采集器每天记一个点（id → stars），保留最近若干天
   *     ② data/snapshots/*.json —— 快照骨架本身就是"某时刻的 id → stars"，取最老 + 最新两份兜底
   *   历史攒不够一个窗口时，不假装是"周"增量：如实返回实际窗口（days），前端照实展示。
   */
  let starCache = { key: "", points: [] };

  function mergeStarPoints(list) {
    // 同一天只留一个点：历史环（rank 2）优先于快照骨架（rank 1）
    const byDay = new Map();
    for (const p of list) {
      if (!p || !p.at || !p.stars) continue;
      const day = String(p.at).slice(0, 10);
      const prev = byDay.get(day);
      if (!prev || (p.rank ?? 0) >= (prev.rank ?? 0)) byDay.set(day, p);
    }
    return [...byDay.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  async function loadStarHistory() {
    const file = join(root, "data", "cache", "star-history.json");
    const info = await stat(file).catch(() => null);
    const dir = join(root, "data", "snapshots");
    const snaps = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
    // 缓存键：历史环 mtime + 快照目录首尾文件名（目录内容变了就要重算）
    const key = (info?.mtimeMs ?? -1) + "|" + snaps.length + "|" + (snaps[0] ?? "") + "|" + (snaps[snaps.length - 1] ?? "");
    if (starCache.key === key) return starCache.points;

    const raw = [];
    if (info) {
      try {
        const data = JSON.parse(await readFile(file, "utf8"));
        for (const p of data.points ?? []) {
          if (p && p.at && p.stars) raw.push({ at: p.at, stars: p.stars, source: "star-history", rank: 2 });
        }
      } catch {
        /* 历史文件损坏：当作没有，不影响其它接口 */
      }
    }
    // 快照兜底只读最老 + 最新两份：目录里可能有 48 份，全读一遍没必要
    const picks = snaps.length > 1 ? [snaps[0], snaps[snaps.length - 1]] : snaps;
    for (const name of picks) {
      try {
        const snap = JSON.parse(await readFile(join(dir, name), "utf8"));
        const stars = {};
        for (const [id, node] of Object.entries(snap.nodes ?? {})) {
          if (node && typeof node.stars === "number") stars[id] = node.stars;
        }
        raw.push({ at: snap.generatedAt ?? name, stars, source: "snapshot", rank: 1 });
      } catch {
        /* 单份快照坏了不影响整体 */
      }
    }
    starCache = { key, points: mergeStarPoints(raw) };
    return starCache.points;
  }


  /* 更新次数：GitHub 只给一个 pushedAt，"一周更新了几次"必须靠采样观测。
   *   ① 采集器每轮往 data/cache/update-log.json 记"pushedAt 又前进了"的仓库（按天累计）→ 真实频率
   *   ② 没有日志时退一步：盘上若有更早的一次 pushedAt 观测（data/cache/repos.json 累积索引），
   *      比对一次就能看出"这期间又推过" —— 只有 2 个观测点，所以次数上限是 2
   *   ③ 什么都没有：窗口内有推送就记 1 次（GitHub 事实），并在界面上说明还没开始采样
   */
  let updateCache = { key: "", stats: null };

  async function loadUpdateStats(windowStartDay, nodes) {
    const logFile = join(root, "data", "cache", "update-log.json");
    const priorFile = join(root, "data", "cache", "repos.json");
    const logInfo = await stat(logFile).catch(() => null);
    const priorInfo = await stat(priorFile).catch(() => null);
    const key = (logInfo?.mtimeMs ?? -1) + "|" + (priorInfo?.mtimeMs ?? -1);
    if (updateCache.key === key && updateCache.stats) return updateCache.stats;

    const advances = new Map();
    const perDay = new Map(); // day -> Map<id, 次数>：逐日趋势柱用它
    const sampledSet = new Set(); // 真正观测过的日子：用来区分「0 次」与「没数据」
    let source = "current-only";
    let observations = 0;
    let sampledDays = 0;

    if (logInfo) {
      try {
        const log = JSON.parse(await readFile(logFile, "utf8"));
        const days = Object.keys(log.days ?? {}).filter((d) => String(d) >= windowStartDay);
        for (const day of log.sampledDays ?? []) if (String(day) >= windowStartDay) sampledSet.add(String(day));
        // 有"观测覆盖"就算有日志口径：哪怕这几天一次推进都没记到，也比重退到两个观测点比对更准
        // （覆盖天数决定趋势柱能不能画，见 seriesDays）。
        if (sampledSet.size || days.length) {
          source = "update-log";
          sampledDays = sampledSet.size;
          observations = sampledSet.size;
          for (const day of days) {
            sampledSet.add(day);
            sampledDays = sampledSet.size;
            const counts = new Map();
            for (const [id, n] of Object.entries(log.days[day] ?? {})) {
              const v = Number(n) || 0;
              if (!v) continue;
              counts.set(id, v);
              advances.set(id, (advances.get(id) ?? 0) + v);
            }
            perDay.set(day, counts);
          }
        }
      } catch {
        /* 日志坏了就当没有，下面还有兜底 */
      }
    }

    if (source === "current-only" && priorInfo) {
      try {
        const prior = JSON.parse(await readFile(priorFile, "utf8"));
        const prev = prior.repos ?? {};
        let compared = 0;
        for (const n of nodes) {
          const before = prev[n.id];
          if (!before || !before.pushedAt || !n.pushedAt) continue;
          compared += 1;
          if (String(n.pushedAt) > String(before.pushedAt)) advances.set(n.id, 1);
        }
        if (compared > 0) {
          source = "epoch-pair";
          observations = 2;
        }
      } catch {
        /* 累积索引读不了也无所谓 */
      }
    }

    const note =
      source === "update-log"
        ? "次数 = 采样到 pushedAt 前进的轮次数（每轮最多记一次，同一轮里的多次推送会合并 —— 所以是**下界**；窗口内确有推送但一次都没采样到时记 1）。已观测 " + sampledSet.size + " 天"
        : source === "epoch-pair"
          ? "还没有按轮的采样日志：只能用盘上一次更早的观测比对，次数上限是 2；采集器跑起来后会变成真实频率"
          : "只看得到最后一次推送时间，次数一律按 1 计；采集器跑起来后按轮采样";
    const stats = { advances, perDay, sampledSet, source, observations, sampledDays, note };
    updateCache = { key, stats };
    return stats;
  }

  /* 版本缓存（data/cache/releases.json，采集器写）：榜单每行带最近几个版本。
   * releases 不在搜索接口的返回里，是采集器按仓库单独抓的（1 个仓库 = 1 次 core 配额）。 */
  let releasesCache = { mtimeMs: -2, index: { repos: {} } };

  async function loadReleases() {
    const file = join(root, "data", "cache", "releases.json");
    const info = await stat(file).catch(() => null);
    if (!info) return { repos: {} };
    if (releasesCache.mtimeMs === info.mtimeMs) return releasesCache.index;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const repos = {};
      for (const [id, entry] of Object.entries(data.repos ?? {})) {
        if (entry && Array.isArray(entry.releases)) repos[id] = entry.releases;
      }
      releasesCache = { mtimeMs: info.mtimeMs, index: { repos, updatedAt: data.updatedAt ?? null } };
    } catch {
      releasesCache = { mtimeMs: info.mtimeMs, index: { repos: {} } }; // 缓存坏了就当没有
    }
    return releasesCache.index;
  }

  /* 逐日星标台账（data/cache/star-daily.json，采集器每轮写）：star 榜的逐日趋势柱与
   * 窗口增量的【唯一来源】。两者同源同窗口，所以 "行内增量 == 逐日柱加总 + 宽条" 由构造成立。
   * 为什么不再用星标环推：环一天只留一个点（同日覆盖），"两个日点的差"只能落在后一天，
   * 攒不出逐日形状；而且两个来源各算各的 —— 线上实测 20/20 行的逐日加总都不等于行内增量。 */
  function emptyStarDaily() {
    return { days: new Map(), sampled: new Set(), spans: [], rounds: new Map(), baselined: 0, lastRound: null, updatedAt: null };
  }
  let starDailyCache = { mtimeMs: -2, index: emptyStarDaily() };

  async function loadStarDaily() {
    const file = join(root, "data", "cache", "star-daily.json");
    const info = await stat(file).catch(() => null);
    if (!info) return emptyStarDaily();
    if (starDailyCache.mtimeMs === info.mtimeMs) return starDailyCache.index;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const days = new Map();
      for (const [day, bucket] of Object.entries(data.days ?? {})) {
        const map = new Map();
        for (const [id, delta] of Object.entries(bucket ?? {})) if (typeof delta === "number") map.set(id, delta);
        days.set(day, map);
      }
      // 跨天宽条：采集端已经按 (from, to) 分好组（断档那一轮的增量不进日柱）
      const spans = [];
      for (const s of data.spans ?? []) {
        if (!s || !s.from || !s.to || !s.d) continue;
        const d = new Map();
        for (const [id, delta] of Object.entries(s.d)) if (typeof delta === "number") d.set(id, delta);
        if (d.size) spans.push({ from: String(s.from), to: String(s.to), hours: Number(s.hours) || 0, d });
      }
      const rounds = new Map();
      for (const [day, r] of Object.entries(data.rounds ?? {})) {
        if (r && r.first && r.last) rounds.set(day, { first: String(r.first), last: String(r.last) });
      }
      starDailyCache = {
        mtimeMs: info.mtimeMs,
        index: {
          days,
          sampled: new Set(data.sampledDays ?? []),
          spans,
          rounds,
          baselined: Object.keys(data.seen ?? {}).length,
          lastRound: data.lastRound ?? null,
          updatedAt: data.updatedAt ?? null,
        },
      };
    } catch {
      starDailyCache = { mtimeMs: info.mtimeMs, index: emptyStarDaily() };
    }
    return starDailyCache.index;
  }

  /** 逐日观测覆盖度：回答"这几天到底有几天是真的有观测" —— 没有它，"7 天齐不齐"只能靠猜 */
  async function starDailyStats() {
    const index = await loadStarDaily();
    const anchorDay = dayOf(Date.now());
    const axis = [];
    for (let i = 6; i >= 0; i--) axis.push(dayShift(anchorDay, -i));
    const covered = axis.filter((d) => index.sampled.has(d));
    return {
      axis,
      coveredDays: covered,
      missingDays: axis.filter((d) => !index.sampled.has(d)),
      firstDay: covered[0] ?? null,
      lastDay: covered[covered.length - 1] ?? null,
      spans: index.spans.length,
      baselined: index.baselined,
      lastRound: index.lastRound,
      updatedAt: index.updatedAt,
    };
  }

  /** 'YYYY-MM-DD' 加减天数：逐日趋势柱的横轴用（纯日期串运算，与时区无关） */
  const dayShift = (day, delta) => new Date(Date.parse(day + "T00:00:00Z") + delta * 86400000).toISOString().slice(0, 10);

  /** 两个榜单：周更新热榜（更新频率）+ 周 star 热榜（星标历史增量，历史不足时如实降级窗口） */
  async function ranking(params) {
    const mesh = await load();
    const nodes = mesh.nodes ?? [];
    const now = Date.now();
    const windowDays = Math.min(30, Math.max(1, Number(params.get("days") ?? 7) || 7));
    const limit = Math.min(RANKING_LIMIT, Math.max(1, Number(params.get("limit") ?? 20) || 20));
    const wantAll = params.get("fields") === "all";
    const releasesIndex = await loadReleases();

    const row = (n) => ({
      id: n.id,
      // 版本列表（采集器抓的，可能为空）：tag / 名称 / 发布日期 / 是否预发布
      releases: releasesIndex.repos[n.id] ?? [],
      name: n.name,
      owner: n.owner,
      avatar: n.avatar ?? null,
      stars: n.stars ?? 0,
      language: n.language ?? null,
      category: n.category ?? null,
      categoryLabel: n.categoryLabel ?? null,
      pushedAt: n.pushedAt ?? null,
      ...(wantAll ? { description: n.description ?? "", url: "https://github.com/" + n.id } : {}),
    });

    /* 榜一：周更新热榜（排除归档与复刻：档案馆与镜像刷推送不算"生态在动"）
     * 排序关键不是"最后一次推送有多新"，而是【一周更新了几次】：
     *   updates = 采样到 pushedAt 前进的轮次数（下界）；没采样到也确有推送时保底 1
     * 次数相同时才比最近推送时间、再比星标。 */
    /* 逐日趋势柱的横轴：最近 seriesLen 个"当地日"（含数据快照当天）。
     * 观测不到的那天给 null —— 界面必须能区分「当天 0 次」与「当天没观测」。
     * 注意：窗口起点必须与横轴对齐（同一组日历日），否则最左边那天的事件会被计数却不画柱子
     * —— 线上实测过：窗口是"现在往前 7×24 小时"（起点 10-01），横轴却只有 10-02…10-08，
     * 于是 10-01 的 6 个版本被算进总数（12）却没有柱子（加总只有 6）。 */
    const meshAtMs = Date.parse(mesh.meta?.generatedAt ?? "");
    const anchorDay = dayOf(Number.isFinite(meshAtMs) ? meshAtMs : now);
    const seriesLen = Math.min(7, windowDays);
    const seriesDays = [];
    for (let i = seriesLen - 1; i >= 0; i--) seriesDays.push(dayShift(anchorDay, -i));
    const windowStartDay = seriesDays[0]; // 窗口 = 横轴覆盖的那几天（当地日历日）
    // 窗口起点对应的时刻：当地 00:00（= UTC 减去时区偏移），供"最近推送"过滤用
    const since = Date.parse(windowStartDay + "T00:00:00Z") - DAY_TZ_OFFSET_HOURS * 3600000;
    const updateStats = await loadUpdateStats(windowStartDay, nodes);
    /* 次数 = 采样到的推进次数（每轮最多记一次，是**下界**）；一次都没采样到、但窗口内确有推送时保底 1。
     * 为什么不是 "1 + 采样"：采样到的推进里已经包含"把 pushedAt 推到窗口内的那次推送"，
     * 再加 1 就是同一次推送算两遍 —— 线上实测前 50 行全部多算 1，趋势柱加总永远比总数少 1。 */
    const updatesOf = (n) => {
      const advances = updateStats.advances.get(n.id) ?? 0;
      if (updateStats.source === "update-log") return Math.max(1, advances);
      // 退化口径：两个观测点比对（上限 2）/ 只见最后一次推送（恒为 1），文案里已写明
      return 1 + advances;
    };
    const seriesOfUpdates = (id) =>
      updateStats.source === "update-log"
        ? seriesDays.map((d) => (updateStats.sampledSet.has(d) ? updateStats.perDay.get(d)?.get(id) ?? 0 : null))
        : seriesDays.map(() => null);
    const updatedAll = nodes
      .filter((n) => {
        if (n.archived || n.fork) return false;
        const t = Date.parse(n.pushedAt ?? "");
        return Number.isFinite(t) && t >= since;
      })
      // 排序：更新次数 desc → 最近推送 desc → 星标 desc
      // （次数相同时，刚刚推过的排在几小时前推过的前面）
      .sort(
        (a, b) =>
          updatesOf(b) - updatesOf(a) ||
          String(b.pushedAt ?? "").localeCompare(String(a.pushedAt ?? "")) ||
          (b.stars ?? 0) - (a.stars ?? 0),
      );

    /* 榜一（v0.5.0 修订）：判定"本周有更新"改用 **releases**（真实发布的版本）。
     * 为什么换：pushedAt 采样数的是"我们采样到几次推进"，天生是下界，而且会把
     * "只往特性分支推、从不发版"的仓库算成高频更新（线上实据：某项目 24 小时推 41 次）。
     * 计数 = 窗口内真实发布的版本数（不是下界）；排序 = 版本数 → 最新版本日期 → 星标。
     * 没有任何 releases 数据时（老部署 / 采集器还没跑）退回采样口径，updatesSource 里标清楚。 */
    const meshDay = dayOf(Date.parse(mesh.meta?.generatedAt ?? "") || now);
    const releasesByDay = new Map(); // day -> Map<id, 当天发布的版本数>
    const releaseRows = [];
    for (const n of nodes) {
      if (n.archived || n.fork) continue;
      const list = releasesIndex.repos[n.id];
      if (!Array.isArray(list) || !list.length) continue;
      const inWindow = list.filter((r) => typeof r.at === "string" && r.at >= windowStartDay && r.at <= meshDay);
      if (!inWindow.length) continue;
      for (const r of inWindow) {
        let bucket = releasesByDay.get(r.at);
        if (!bucket) {
          bucket = new Map();
          releasesByDay.set(r.at, bucket);
        }
        bucket.set(n.id, (bucket.get(n.id) ?? 0) + 1);
      }
      releaseRows.push({ node: n, count: inWindow.length, latest: inWindow.map((r) => r.at).sort().pop() });
    }
    releaseRows.sort(
      (a, b) => b.count - a.count || String(b.latest ?? "").localeCompare(String(a.latest ?? "")) || (b.node.stars ?? 0) - (a.node.stars ?? 0),
    );
    const seriesOfReleases = (id) =>
      seriesDays.map((d) => (d >= windowStartDay && d <= meshDay ? releasesByDay.get(d)?.get(id) ?? 0 : null));
    const useReleases = releaseRows.length > 0;




    /* 榜二：star 增量
     * 唯一来源是采集器的逐日台账（star-daily）：
     *   逐日柱   = 当天各轮真实观测到的星标变化累加（断档那一轮走 spans，不算任何一天）
     *   窗口增量 = Σ(窗口内逐日柱) + Σ(窗口内跨天宽条)
     * 两者同源同窗口，所以 "行内增量 == 逐日柱加总 + 宽条" 由构造成立（与更新榜同一条规矩）。
     * 星标环只在台账为空时兜底（冷启动）：那时只能给端点差，攒不出逐日形状，如实降级。 */
    const points = await loadStarHistory();
    const meshAt = Date.parse(mesh.meta?.generatedAt ?? "") || now;
    const starDailyIndex = await loadStarDaily();
    const coveredDays = seriesDays.filter((d) => starDailyIndex.sampled.has(d));
    const hasStarDaily = coveredDays.length > 0;

    // 逐日台账：只读，不做任何推算（没观测到的日 = null，不是 0）
    const seriesFromDaily = (id) => seriesDays.map((d) => (starDailyIndex.sampled.has(d) ? starDailyIndex.days.get(d)?.get(id) ?? 0 : null));
    const dailySum = (id) => coveredDays.reduce((s, d) => s + (starDailyIndex.days.get(d)?.get(id) ?? 0), 0);
    // 跨天宽条：写入端已按 (from, to) 分好组，这里只做窗口过滤与横轴下标映射
    const spansFromDaily = (id) =>
      starDailyIndex.spans
        .map((s) => {
          const toIdx = seriesDays.indexOf(s.to);
          if (toIdx < 0) return null; // 终点不在窗口里：整段丢弃，不硬塞到别的天
          return { fromIdx: Math.max(0, seriesDays.indexOf(s.from)), toIdx, from: s.from, to: s.to, hours: s.hours, value: s.d.get(id) ?? 0 };
        })
        .filter((s) => s && s.value > 0);

    /* —— 兜底：台账还没有数据（刚部署 / 文件没生成）时，用星标环给端点差 —— */
    const newest = points[points.length - 1] ?? null;
    const useNewer = !!newest && Date.parse(newest.at) > meshAt + 60000;
    let currentAt = useNewer ? Date.parse(newest.at) : meshAt;
    let currentStars = {};
    let base = null;
    const starDaily = new Map(); // day -> Map<id, delta>
    const starSpans = []; // [{ fromIdx, toIdx, from, to, days, values }]
    if (!hasStarDaily) {
      // "现在"的星标：历史里有比 mesh 更新的点就用它，否则用 mesh 自己（都是真实观测值）
      currentStars = useNewer ? newest.stars : Object.fromEntries(nodes.map((n) => [n.id, n.stars ?? 0]));
      const candidates = points.filter((p) => {
        const t = Date.parse(p.at);
        return Number.isFinite(t) && currentAt - t >= 6 * 3600000;
      });
      const target = currentAt - windowDays * 86400000;
      base = candidates.slice().sort((a, b) => Math.abs(Date.parse(a.at) - target) - Math.abs(Date.parse(b.at) - target))[0] ?? null;
      /* star 的逐日趋势（环推）：
       *   · 相邻两次观测间隔 ≤ 26 小时 → 这个差就是"某一天的增量"，画成一根日柱；
       *   · 间隔更长的（例如只有一个 10-01 的旧观测点，到 10-06 才再观测）→ 算不出逐日，
       *     但"这两个时点之间涨了多少"是真实观测值，所以画成一根【跨 N 天的累计宽柱】，
       *     绝不平摊到某一天。 */
      const obs = points.map((p) => ({ at: Date.parse(p.at), stars: p.stars }));
      if (!useNewer) obs.push({ at: currentAt, stars: currentStars });
      // obs[].at 已经是毫秒数；dayOf 两种入参都吃，坏数据返回空串 → indexOf 得 -1 → 上层跳过
      const dayIndex = (at) => seriesDays.indexOf(dayOf(at));
      for (let i = 1; i < obs.length; i++) {
        const gapH = (obs[i].at - obs[i - 1].at) / 3600000;
        if (!(gapH > 0)) continue;
        if (gapH > 26) {
          const fromIdx = dayIndex(obs[i - 1].at);
          const toIdx = dayIndex(obs[i].at);
          // 两端都要落在 7 天横轴上才画（否则没有可放的位置）
          if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) continue;
          const values = new Map();
          for (const [id, value] of Object.entries(obs[i].stars)) {
            const before = obs[i - 1].stars[id];
            if (typeof before !== "number" || typeof value !== "number") continue;
            const d = value - before;
            if (d > 0) values.set(id, d);
          }
          starSpans.push({
            fromIdx,
            toIdx,
            from: seriesDays[fromIdx],
            to: seriesDays[toIdx],
            days: Number((gapH / 24).toFixed(2)),
            values,
          });
          continue;
        }
        const day = dayOf(obs[i].at);
        if (!seriesDays.includes(day)) continue;
        let bucket = starDaily.get(day);
        if (!bucket) {
          bucket = new Map();
          starDaily.set(day, bucket);
        }
        for (const [id, value] of Object.entries(obs[i].stars)) {
          const before = obs[i - 1].stars[id];
          if (typeof before !== "number" || typeof value !== "number") continue;
          const d = value - before;
          if (d) bucket.set(id, (bucket.get(id) ?? 0) + d);
        }
      }
    }
    const spansForStars = (id) =>
      starSpans
        .map((s) => ({ fromIdx: s.fromIdx, toIdx: s.toIdx, from: s.from, to: s.to, days: s.days, value: s.values.get(id) ?? 0 }))
        .filter((s) => s.value > 0);
    const seriesForStars = (id) => seriesDays.map((d) => (starDaily.has(d) ? starDaily.get(d).get(id) ?? 0 : null));

    const starsBoard = {
      label: "周 star 热榜",
      metric: "star-gain",
      available: false,
      window: null,
      total: 0,
      count: 0,
      items: [],
      matched: 0,
      note: "",
      seriesKind: "star-gain",
      seriesSource: hasStarDaily ? "star-daily" : "ring",
      seriesDays: hasStarDaily ? coveredDays.length : starDaily.size,
      spanCount: hasStarDaily ? starDailyIndex.spans.length : starSpans.length,
      // 覆盖度：逐日观测从哪天到哪天、缺了哪几天 —— 没有它，"7 天齐不齐"只能靠猜
      coverage: hasStarDaily
        ? {
            from: coveredDays[0],
            to: coveredDays[coveredDays.length - 1],
            days: coveredDays.length,
            missing: seriesDays.filter((d) => !starDailyIndex.sampled.has(d)),
          }
        : null,
    };
    if (hasStarDaily) {
      /* 首选：逐日台账。窗口增量与逐日柱同源，所以下面这条恒等式由构造成立：
       *   delta === Σ(series 里的数值) + Σ(spans 的 value)
       * 谁动这里的口径，先看 tests/api.test.mjs 的同名断言。 */
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const observed = new Set();
      for (const d of coveredDays) for (const id of starDailyIndex.days.get(d)?.keys() ?? []) observed.add(id);
      for (const s of starDailyIndex.spans) for (const id of s.d.keys()) observed.add(id);
      const gains = [];
      for (const id of observed) {
        const node = byId.get(id);
        if (!node || node.archived || node.fork) continue;
        const spans = spansFromDaily(id);
        const delta = dailySum(id) + spans.reduce((s, x) => s + x.value, 0);
        if (delta > 0) gains.push({ node, delta, spans });
      }
      gains.sort((a, b) => b.delta - a.delta || (b.node.stars ?? 0) - (a.node.stars ?? 0));
      starsBoard.available = true;
      starsBoard.matched = starDailyIndex.baselined;
      starsBoard.source = "star-daily";
      starsBoard.window = { from: coveredDays[0], to: coveredDays[coveredDays.length - 1], days: coveredDays.length, target: windowDays };
      starsBoard.total = gains.length;
      starsBoard.count = Math.min(limit, gains.length);
      starsBoard.maxDelta = gains.length ? gains[0].delta : 0;
      starsBoard.items = gains.slice(0, limit).map((g) => ({
        ...row(g.node),
        delta: g.delta,
        // starsAfter - starsBefore === delta 是接口契约（旧路径给的是两个真实观测点）。
        // 台账只记"观测到的变化"，起点由终点减回去 —— 算术上精确，且与逐日柱同源。
        starsAfter: g.node.stars ?? 0,
        starsBefore: (g.node.stars ?? 0) - g.delta,
        series: seriesFromDaily(g.node.id),
        spans: g.spans,
      }));
      const missingDays = seriesDays.length - coveredDays.length;
      starsBoard.note =
        "增量 = 窗口内每一天真实观测到的星标变化之和（不估算、不平摊；已排除归档与复刻）。已观测 " +
        coveredDays.length + " 天（" + coveredDays[0] + " 起）" +
        (missingDays > 0 ? "，另有 " + missingDays + " 天没有观测 —— 那是「未知」而不是「零增长」" : "") +
        (starDailyIndex.spans.length ? "；" + starDailyIndex.spans.length + " 段跨天观测画成宽条，不计入任何一天" : "") +
        "。";
    } else if (base) {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const gains = [];
      let matched = 0;
      for (const [id, value] of Object.entries(currentStars)) {
        const before = base.stars[id];
        if (typeof before !== "number" || typeof value !== "number") continue;
        matched += 1;
        const delta = value - before;
        const node = byId.get(id);
        if (delta > 0 && node && !node.archived && !node.fork) gains.push({ node, delta, before, after: value });
      }
      gains.sort((a, b) => b.delta - a.delta || (b.after ?? 0) - (a.after ?? 0));
      const fromMs = Date.parse(base.at);
      starsBoard.available = true;
      starsBoard.matched = matched;
      starsBoard.source = base.source ?? "history";
      starsBoard.window = { from: base.at, to: new Date(currentAt).toISOString(), days: Number(((currentAt - fromMs) / 86400000).toFixed(2)), target: windowDays };
      starsBoard.total = gains.length;
      starsBoard.count = Math.min(limit, gains.length);
      starsBoard.maxDelta = gains.length ? gains[0].delta : 0;
      starsBoard.items = gains.slice(0, limit).map((g) => ({
        ...row(g.node),
        delta: g.delta,
        starsBefore: g.before,
        starsAfter: g.after,
        series: seriesForStars(g.node.id),
        spans: spansForStars(g.node.id),
      }));
      starsBoard.note =
        "增量 = 两个时间点的星标之差（真实观测，非估算；已排除归档与复刻）。窗口 " + starsBoard.window.days + " 天" +
        (starsBoard.window.days < windowDays - 0.5 ? "（历史还没攒够 " + windowDays + " 天，先按现有历史算）" : "") +
        "，两端共 " + matched + " 个仓库可比 —— 只有这些仓库能算增量，其余是「未知」而不是「零增长」。" +
        "（逐日台账还没有数据，此处退回星标环口径，只能给窗口总量、攒不出逐日形状）";
    } else {
      starsBoard.note = points.length
        ? "星标历史点还不够早（至少要比现在早 6 小时），暂时算不出增量。采集器每天记一个点，攒够后这里会自动出现。"
        : "还没有星标历史：采集器每天会把当天的星标记一个点，跑起来之后这里就有真实的周增量。";
    }

    return {
      generatedAt: mesh.meta?.generatedAt ?? null,
      now: new Date(now).toISOString(),
      windowDays,
      limit,
      seriesDays, // 趋势柱的横轴（最近 7 天，含数据快照当天）
      dataAgeHours: Number(((now - meshAt) / 3600000).toFixed(1)),
      history: { points: points.map((p) => ({ at: p.at, repos: Object.keys(p.stars).length, source: p.source ?? "history" })), latestAt: newest?.at ?? null },
      releases: { cached: Object.keys(releasesIndex.repos).length, updatedAt: releasesIndex.updatedAt ?? null },
      starDaily: {
        days: starDailyIndex.days.size,
        sampledDays: starDailyIndex.sampled.size,
        spans: starDailyIndex.spans.length,
        baselined: starDailyIndex.baselined,
        updatedAt: starDailyIndex.updatedAt ?? null,
        lastRound: starDailyIndex.lastRound,
      },
      boards: {
        updated: useReleases
          ? {
              label: "周更新热榜",
              metric: "releases",
              seriesKind: "releases",
              windowDays,
              total: releaseRows.length,
              count: Math.min(limit, releaseRows.length),
              updatesSource: "releases",
              releasesIndexed: Object.keys(releasesIndex.repos).length,
              note:
                "判定依据 = 仓库本周真实发布的 release（采集器按仓库抓最近几个版本；" +
                "活跃发版仓库最多 6 小时刷新一次，抓过之后又有推送的立刻重抓）。" +
                "计数 = 窗口内发布的版本数，是真实计数；缓存里只留最近几个版本，超出部分看不到。",
              maxUpdates: releaseRows.length ? releaseRows[0].count : 0,
              seriesDays: seriesDays.filter((d) => d >= windowStartDay && d <= meshDay).length,
              items: releaseRows.slice(0, limit).map((r) => ({
                ...row(r.node),
                updates: r.count,
                latestReleaseAt: r.latest ?? null,
                series: seriesOfReleases(r.node.id),
              })),
            }
          : {
              label: "周更新热榜",
              metric: "updates",
              windowDays,
              total: updatedAll.length,
              count: Math.min(limit, updatedAll.length),
              updatesSource: updateStats.source,
              updatesObservations: updateStats.observations,
              updatesSampledDays: updateStats.sampledDays,
              note: "还没有 releases 数据（采集器按仓库抓，需要几轮铺开）：先用 pushedAt 采样口径 —— " + updateStats.note,
              maxUpdates: updatedAll.length ? updatesOf(updatedAll[0]) : 0,
              seriesKind: "updates",
              // 只有"按天采样"真的在跑时才有逐日序列；退化口径（两个观测点比对）算不出某一天，
              // 硬画会变成凭空的柱子 —— 那种情况下一律给 null，让界面显示"暂无逐日数据"。
              seriesDays: updateStats.source === "update-log" ? seriesDays.filter((d) => updateStats.sampledSet.has(d)).length : 0,
              items: updatedAll.slice(0, limit).map((n) => ({
                ...row(n),
                updates: updatesOf(n),
                observedAdvances: updateStats.advances.get(n.id) ?? 0,
                // 逐日趋势：没观测到的天给 null，界面画成"无数据"而不是 0
                series: seriesOfUpdates(n.id),
              })),
            },
        stars: starsBoard,
      },
    };
  }

  async function categories() {
    const mesh = await load();
    const sectors = new Map();
    for (const n of mesh.nodes ?? []) {
      const key = n.category ?? "other";
      if (!sectors.has(key)) {
        sectors.set(key, { id: key, label: n.categoryLabel ?? key, count: 0, subs: new Map() });
      }
      const sector = sectors.get(key);
      sector.count += 1;
      if (n.subcategory) {
        if (!sector.subs.has(n.subcategory)) {
          sector.subs.set(n.subcategory, { id: n.subcategory, label: n.subcategoryLabel ?? n.subcategory, count: 0 });
        }
        sector.subs.get(n.subcategory).count += 1;
      }
    }
    const list = [...sectors.values()]
      .map((s) => ({ id: s.id, label: s.label, count: s.count, subcategories: [...s.subs.values()].sort((a, b) => b.count - a.count) }))
      .sort((a, b) => b.count - a.count);
    return {
      total: (mesh.nodes ?? []).length,
      generatedAt: mesh.meta?.generatedAt ?? null,
      sectors: list,
    };
  }

  async function one(owner, name) {
    const mesh = await load();
    const id = owner + "/" + name;
    const nodes = mesh.nodes ?? [];
    const node = nodes.find((n) => n.id.toLowerCase() === id.toLowerCase());
    if (!node) return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = [];
    const counts = {};
    const seen = new Set();
    for (const e of mesh.edges ?? []) {
      if (e.source !== node.id && e.target !== node.id) continue;
      const other = e.source === node.id ? e.target : e.source;
      const target = byId.get(other);
      links.push({
        type: e.type,
        id: other,
        stars: target?.stars ?? 0,
        categoryLabel: target?.categoryLabel ?? null,
        url: "https://github.com/" + other,
      });
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      seen.add(e.type + "|" + other);
    }
    // 同作者：数据层为了控制载荷，对成员超过阈值的作者只写"星形拓扑"（枢纽连所有人），
    // 直接返回存边会让其余成员的同作者连线只剩一条。这里按 owner 补齐完整关系，
    // 与前端画布（ownerSiblings）保持同一套语义。
    if (node.owner) {
      const siblings = nodes
        .filter((n) => n.owner === node.owner && n.id !== node.id)
        .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
      for (const s of siblings) {
        const key = "owner|" + s.id;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          type: "owner",
          id: s.id,
          stars: s.stars ?? 0,
          categoryLabel: s.categoryLabel ?? null,
          url: "https://github.com/" + s.id,
        });
        counts.owner = (counts.owner ?? 0) + 1;
      }
    }
    return { repo: publicNode(node), links, linkCounts: counts };
  }


  /**
   * 可分享卡片：自包含 SVG，420×168，GitHub 仓库卡片风格。
   *
   * 视觉参照 GitHub：仓库图标 + owner / name、灰阶描述、● 语言色点 / ★ 星标 / ⑂ 复刻 / 更新于。
   * 交互：整张卡片背景指向站点（options.site），仓库名单独指向 GitHub——两个链接是兄弟节点，
   *       不是嵌套（SVG 里嵌套 <a> 非法），所以两种点击都能生效。
   */
  async function cardSvg(owner, name, options = {}) {
    const found = await one(owner, name);
    if (!found) return null;
    const n = found.repo;
    const dark = options.theme !== "light"; // 默认深色（与 GitHub 深色界面一致）
    const site = options.site || DEFAULT_SITE;
    const host = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const accent = categoryColor(n.category);

    // GitHub 深色 / 浅色两套令牌
    const c = dark
      ? { bg: "#0d1117", border: "#30363d", fg: "#e6edf3", muted: "#8b949e", link: "#58a6ff", pill: "#21262d", pillBorder: "#30363d" }
      : { bg: "#ffffff", border: "#d0d7de", fg: "#1f2328", muted: "#656d76", link: "#0969da", pill: "#eff2f5", pillBorder: "#d0d7de" };

    const sector = n.subcategoryLabel ? n.categoryLabel + " · " + n.subcategoryLabel : n.categoryLabel || "未分类";
    const descLines = wrapText(n.description || "（暂无描述）", 13, 380, 2);
    const stars = n.stars >= 1000 ? (n.stars / 1000).toFixed(1) + "k" : String(n.stars);
    const forks = n.forks >= 1000 ? (n.forks / 1000).toFixed(1) + "k" : String(n.forks ?? 0);
    const langColor = LANG_COLORS[n.language] || c.muted;
    const updated = relativeTime(n.pushedAt, options.now);

    const t = (x, y, size, fill, weight, text, extra) =>
      '<text x="' + x + '" y="' + y + '" font-family="' + FONT + '" font-size="' + size + '"' +
      (weight ? ' font-weight="' + weight + '"' : "") +
      (extra ?? "") + ' fill="' + fill + '">' + xmlEscape(text) + "</text>";
    const icon = (path, x, y, size, fill) =>
      '<g transform="translate(' + x + " " + y + ') scale(' + size / 16 + ')" fill="' + fill + '"><path d="' + path + '"/></g>';

    const rows = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="420" height="168" viewBox="0 0 420 168" role="img" aria-label="' + xmlEscape(n.id + " · " + sector) + '">',
      "  <title>" + xmlEscape(n.id) + " · " + xmlEscape(sector) + "</title>",
      "  <desc>" + xmlEscape("点击卡片前往 " + site) + "</desc>",
      "  <style>.bg{transition:stroke .2s ease}.card:hover .bg{stroke:" + (dark ? "#8b949e" : "#8c959f") + "}.nm:hover{text-decoration:underline}</style>",
      // 整张卡片背景 = 站点链接（透明矩形承载点击）
      '  <a xlink:href="' + xmlEscape(site) + '" href="' + xmlEscape(site) + '" target="_blank">',
      '    <rect class="bg" x="0.5" y="0.5" width="419" height="167" rx="12" fill="' + c.bg + '" stroke="' + c.border + '"/>',
      '    <rect x="0.5" y="0.5" width="6" height="167" rx="3" fill="' + accent + '"/>',
      "  </a>",
      // 标题行：仓库图标 + owner / name（name 单独指向 GitHub）
      "  " + icon(ICON_REPO, 20, 22, 16, c.muted),
      '  <a xlink:href="' + xmlEscape(n.url) + '" href="' + xmlEscape(n.url) + '" target="_blank">' +
        '<text x="42" y="37" font-family="' + FONT + '" font-size="16" font-weight="600">' +
        '<tspan fill="' + c.muted + '">' + xmlEscape(fitText(n.owner + " / ", 16, 150)) + "</tspan>" +
        '<tspan fill="' + c.link + '" class="nm">' + xmlEscape(fitText(n.name, 16, 230)) + "</tspan></text></a>",
      "  " + t(20, 66, 13, c.muted, 0, descLines[0] ?? ""),
      ...(descLines[1] ? ["  " + t(20, 85, 13, c.muted, 0, descLines[1])] : []),
      // 元信息行：● 语言 · ★ 星标 · ⑂ 复刻 · 更新于（逐项按实测宽度推进，绝不重叠）
      '  <circle cx="25" cy="104" r="5.5" fill="' + langColor + '"/>',
      ...metaRow(
        [
          { text: n.language || "未知语言" },
          { icon: ICON_STAR, text: stars },
          ...(n.forks > 0 ? [{ icon: ICON_FORK, text: forks }] : []),
          { text: "更新于 " + updated },
        ],
        c.muted,
      ),
      // 底部：扇区标签（同色淡底） + 去处
      '  <rect x="20" y="129" width="' + Math.round(Math.min(280, textWidth(sector, 11.5) + 24)) + '" height="22" rx="11" fill="' + c.pill + '" stroke="' + c.pillBorder + '"/>',
      "  " + t(32, 144, 11.5, accent, 500, fitText(sector, 11.5, 264)),
      '  <a xlink:href="' + xmlEscape(site) + '" href="' + xmlEscape(site) + '" target="_blank">' +
        t(400, 144, 11.5, c.link, 0, "插件生态图 · " + host + " ↗", ' text-anchor="end" class="nm"') + "</a>",
      "</svg>",
    ];

    /** 元信息行：从 x=36 起逐项排布（图标 + 文本 + 16px 间距） */
    function metaRow(items, fill) {
      const out = [];
      let x = 36;
      for (const item of items) {
        if (item.icon) {
          out.push("  " + icon(item.icon, x, 97, 14, fill));
          x += 14 + 5;
        }
        out.push("  " + t(x, 108, 12.5, fill, 0, item.text));
        x += textWidth(item.text, 12.5) + 16;
      }
      return out;
    }

    return rows.join("\n") + "\n";
  }

  /** 卡片分享页：预览 + 复制即用的嵌入代码（自包含样式，不依赖站点 CSS） */
  async function cardPage(owner, name, origin, options = {}) {
    const found = await one(owner, name);
    if (!found) return null;
    const n = found.repo;
    const site = options.site || origin;
    const base = origin + "/api/card/" + n.id + ".svg";
    const md = "[![" + n.id + "](" + base + ")](" + site + ")";
    const html = '<a href="' + site + '"><img src="' + base + '" alt="' + n.id + '" width="420" height="168"></a>';
    const style = [
      ":root{color-scheme:light dark}",
      "body{margin:0;padding:32px 20px;font:15px/1.7 " + FONT + ";background:#f6f8fc;color:#1d2433}",
      "main{max-width:820px;margin:0 auto}",
      "h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;color:#5f6b80}",
      ".row{display:flex;gap:16px;flex-wrap:wrap}",
      "pre{background:#fff;border:1px solid #e6eaf2;border-radius:10px;padding:12px 14px;overflow:auto;font-size:12.5px}",
      "a{color:#2f6df6}.note{color:#5f6b80;font-size:13px}",
      "@media (prefers-color-scheme:dark){body{background:#0f1219;color:#e8ecf6}pre{background:#151823;border-color:#252a38}h2,.note{color:#98a2b8}a{color:#6aa9ff}}",
    ].join("");
    const body = [
      "<!doctype html>",
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<title>" + xmlEscape(n.id) + " · 卡片</title>",
      "<style>" + style + "</style></head><body><main>",
      "<h1>" + xmlEscape(n.id) + "</h1>",
      '<div class="note">★ ' + n.stars + " · " + xmlEscape(n.categoryLabel || "未分类") +
        (n.subcategoryLabel ? " · " + xmlEscape(n.subcategoryLabel) : "") + " · " + xmlEscape(n.language || "未知语言") +
        " · 卡片点击后前往 " + xmlEscape(site) + "</div>",
      '<div class="row">',
      '<a href="' + xmlEscape(site) + '"><img src="/api/card/' + xmlEscape(n.id) + '.svg" alt="' + xmlEscape(n.id) + '" width="420" height="168"></a>',
      '<a href="' + xmlEscape(site) + '"><img src="/api/card/' + xmlEscape(n.id) + '.svg?theme=light" alt="' + xmlEscape(n.id) + '" width="420" height="168"></a>',
      "</div>",
      "<h2>Markdown</h2><pre>" + xmlEscape(md) + "</pre>",
      "<h2>HTML</h2><pre>" + xmlEscape(html) + "</pre>",
      "<h2>说明</h2>",
      '<p class="note">卡片是自包含 SVG（无外部依赖、无脚本），贴进 README、博客或文档即可。<br>' +
        "上面是深色版，换浅色加 <code>?theme=light</code>；换去处加 <code>?link=https://你的站点/</code>（默认 " + xmlEscape(DEFAULT_SITE) + "）。<br>" +
        "数据每小时更新，卡片随之变化。<br>仓库信息：<a href=\"/api/repos/" + xmlEscape(n.id) + "\">/api/repos/" + xmlEscape(n.id) + "</a> · 生态总览：<a href=\"/api/categories\">/api/categories</a></p>",
      "</main></body></html>",
    ];
    return body.join("\n");
  }

  /**
   * 紧凑检索：只回命中 id 与计数，供前端搜索框做"高亮 + 放射线"。
   * 与 /api/repos 的区别是不返回节点字段（几万个 id 也只有几十 KB），
   * 并且额外告诉你有多少个是【只有 README 才命中】的。
   */
  /**
   * 采集进度状态：读采集器写的 data/cache/status.json，补上服务器时间与数据概况。
   * 前端顶栏的"状态"圆环按 nextRunAt 倒计时，浮窗展示进度；文件不存在时 status 为 null。
   */
  let statusCache = { mtimeMs: -1, data: null };
  async function status() {
    const file = join(root, "data", "cache", "status.json");
    const info = await stat(file).catch(() => null);
    let data = null;
    if (info) {
      if (statusCache.mtimeMs !== info.mtimeMs) {
        try {
          statusCache = { mtimeMs: info.mtimeMs, data: JSON.parse(await readFile(file, "utf8")) };
        } catch {
          statusCache = { mtimeMs: info.mtimeMs, data: null };
        }
      }
      data = statusCache.data;
    }
    const mesh = await load().catch(() => null);
    return {
      serverTime: new Date().toISOString(), // 前端用它校正倒计时（防客户端时钟不准）
      data: mesh ? { nodes: (mesh.nodes ?? []).length, generatedAt: mesh.meta?.generatedAt ?? null } : null,
      readme: await readmeStats().catch(() => null),
      status: data,
    };
  }

  /** README 索引概况（给 /api/health 用：让"堆了多少数据"是可观测的） */
  async function readmeStats() {
    await loadReadmes();
    let bytes = 0;
    for (const candidate of [join(root, "data", "cache", "readmes.json.gz"), join(root, "data", "cache", "readmes.json")]) {
      const s = await stat(candidate).catch(() => null);
      if (s) {
        bytes = s.size;
        break;
      }
    }
    return { indexed: readmeCache.indexed, diskKB: Math.round(bytes / 1024), memoryBytes: readmeCache.blob.length };
  }

  async function searchIds(params) {
    const mesh = await load();
    const q = String(params.get("q") ?? "").trim().toLowerCase();
    const cap = Math.min(2000, Math.max(1, Number(params.get("limit") ?? 500) || 500));
    if (!q) return { q: "", total: 0, ids: [], readme: { indexed: 0, total: 0, ids: [] } };
    await loadReadmes();
    const viaReadme = readmeHits(q);
    const ids = [];
    const readmeIds = [];
    for (const n of mesh.nodes ?? []) {
      const hay = [n.id, n.description, (n.topics ?? []).join(" "), (n.matchedTags ?? []).join(" ")].join(" ").toLowerCase();
      const local = hay.includes(q);
      const readme = viaReadme.has(n.id);
      if (!local && !readme) continue;
      if (ids.length < cap) ids.push(n.id);
      if (readme && readmeIds.length < cap) readmeIds.push(n.id);
    }
    return {
      q,
      total: ids.length < cap ? ids.length : ids.length,
      ids,
      readme: { indexed: readmeCache.indexed, total: readmeIds.length, ids: readmeIds },
    };
  }

  return { load, search, searchIds, readmeStats, starDailyStats, status, ranking, categories, one, cardSvg, cardPage, publicNode, slim };
}

/** API 自描述：给调用者一份可发现的端点清单 */
export function apiIndex(version) {
  return {
    name: "插件生态图 · 只读查询 API",
    version,
    docs: "只读、无需鉴权、与前端同端口。数据每小时更新，响应带 5 分钟公共缓存。",
    endpoints: [
      { method: "GET", path: "/api", desc: "本清单" },
      { method: "GET", path: "/api/health", desc: "健康检查与数据概况（含 README 索引规模）" },
      { method: "GET", path: "/api/status", desc: "采集进度状态：下一轮开始时间、阶段、分段与 README 进度、配额（顶栏状态圆环用）" },
      { method: "GET", path: "/api/ranking?days=7&limit=50&fields=all", desc: "榜单：周更新热榜（本周发过 release 的项目，最多 50 行，含 updates / updatesSource / releases）+ 周 star 热榜（星标历史增量，最多 50 行；历史不足时如实返回实际窗口）" },
      { method: "GET", path: "/api/categories", desc: "扇区（功能分类）与细枝及各自数量" },
      { method: "GET", path: "/api/repos?q=&category=&subcategory=&tag=&language=&minStars=&archived=&sort=stars|pushed|created|name&limit=&offset=&fields=all", desc: "检索仓库（默认 20 条，最多 100 条）" },
      { method: "GET", path: "/api/search?q=&limit=", desc: "紧凑检索：只回命中 id 与计数（含 README 正文命中）" },
      { method: "GET", path: "/api/repos/:owner/:name", desc: "单个仓库详情，含同作者/主题共现连线" },
      { method: "GET", path: "/preview.svg?theme=dark|light&size=&sample=", desc: "README 预览图：按当前数据实时渲染的生态图（也可走 /api/preview.svg）" },
      { method: "GET", path: "/api/card/:owner/:name.svg?theme=light|dark&link=", desc: "可分享的 SVG 卡片" },
      { method: "GET", path: "/card/:owner/:name", desc: "卡片分享页（预览 + 嵌入代码）" },
      { method: "GET", path: "/api/stats", desc: "访问统计（只读）" },
      { method: "POST", path: "/api/ping", desc: "上报一次访问（前端自动调用，唯一接受 POST 的接口）" },
    ],
  };
}
