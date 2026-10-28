/**
 * 只读查询 API + 可分享卡片。设计原则：零依赖、零构建（只用 Node 标准库，数据直接读 data/mesh.json）；
 * 只读、无副作用（不接受任何写操作，不接触 .env / 令牌 / 缓存目录）；同端口（由 tools/serve.mjs 挂在同一个
 * HTTP 服务上，本地 8788 / 线上 80）；输出可缓存（数据每小时更新，API 响应给 5 分钟公共缓存）。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { stripNoiseOwners } from "../src/mesh-data.js";
/* 每日界限：按该时区（UTC 偏移小时数）的 00:00 切天，必须与 backend/dsh_mesh/config.py 的 DAY_TZ_OFFSET_HOURS 一致（默认 +8 = 北京时间 00:00 换日，而不是 UTC 00:00 = 北京 08:00）。 */
export const DAY_TZ_OFFSET_HOURS = Number(process.env.DAY_TZ_OFFSET_HOURS ?? 8);

/**
 * 某个时刻落在「哪一天」，按 DAY_TZ_OFFSET_HOURS 的 00:00 切天；接受毫秒数或 ISO 字符串，
 * 解析不出来返回空串（调用方按「不在轴上」处理）。绝不能抛：这里曾经对已经转成毫秒的入参又 Date.parse 一次，
 * 得到 NaN 后 toISOString 抛 RangeError，把 /api/ranking 整个请求挂死。
 */
export const dayOf = (when) => {
  const ms = typeof when === "number" ? when : Date.parse(String(when ?? ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + DAY_TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
};


const DATA_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SITE = "https://www.moc-chen.cn/";
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

const ICON_STAR = "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z";
const ICON_FORK = "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z";

export const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Shell: "#89e051",
  Go: "#00ADD8", Rust: "#dea584", Java: "#b07219", "C#": "#178600", "C++": "#f34b7d",
  C: "#555555", Ruby: "#701516", PHP: "#4F5D95", Swift: "#F05138", Kotlin: "#A97BFF",
  Dart: "#00B4AB", Vue: "#41b883", Svelte: "#ff3e00", HTML: "#e34c26", CSS: "#563d7c",
  SCSS: "#c6538c", Lua: "#000080", Zig: "#ec915c", Nix: "#7e7eff", "Objective-C": "#438eff",
  PowerShell: "#012456", Dockerfile: "#384d54", Makefile: "#427819", "Jupyter Notebook": "#DA5B0B",
  Astro: "#ff5a03", MDX: "#fcb32c", MoonBit: "#b92381", Batchfile: "#C1F12E",
};

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


/** 卡片作者头像：抓 64px PNG 内联成 data URI —— README 里卡片是 <img> 嵌的，外链图片不会加载，
 *  所以必须自包含。成功缓存 24h，失败缓存 10min（避免每次请求都等超时）。DSH_CARD_AVATAR=0 可整体关闭（测试用）。 */
const AVATAR_TTL_MS = 24 * 3600 * 1000;
const AVATAR_FAIL_TTL_MS = 10 * 60 * 1000;
const avatarCache = new Map();
async function fetchAvatarDataUri(owner, fetchImpl = globalThis.fetch) {
  const key = String(owner ?? "").trim().toLowerCase();
  if (!key) return null;
  if (process.env.DSH_CARD_AVATAR === "0") return null;
  const now = Date.now();
  const hit = avatarCache.get(key);
  if (hit && now - hit.at < (hit.uri ? AVATAR_TTL_MS : AVATAR_FAIL_TTL_MS)) return hit.uri;
  try {
    if (typeof fetchImpl !== "function") throw new Error("no-fetch");
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(2500) : undefined;
    const res = await fetchImpl("https://github.com/" + encodeURIComponent(key) + ".png?size=64", {
      signal,
      redirect: "follow",
      headers: { "User-Agent": "dsh-plugin-mesh-card" },
    });
    if (!res || !res.ok) throw new Error("http-" + (res && res.status));
    const type = String((res.headers && res.headers.get && res.headers.get("content-type")) || "");
    if (!/^image\//u.test(type)) throw new Error("not-image");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 300 * 1024) throw new Error("bad-size");
    const uri = "data:" + type.split(";")[0] + ";base64," + bytes.toString("base64");
    avatarCache.set(key, { at: now, uri });
    return uri;
  } catch {
    avatarCache.set(key, { at: now, uri: null });
    return null;
  }
}

export function createApi({ root }) {
  let cache = { at: 0, mesh: null };
  // README 索引（data/cache/readmes.json）在检索时拼成【一个全小写的大字符串】，用 indexOf 找命中位置、
// 再二分定位到仓库 id —— 每次查询只有一次内存扫描，不必对几万篇正文逐篇 toLowerCase()。
  let readmeCache = { mtimeMs: -1, blob: "", ids: [], offsets: [], indexed: 0 };
  const README_SEP = "\u0000";

  async function load() {
    // 按【文件 mtime】缓存，而不是固定 5 分钟 TTL：mesh.json 有 21MB，JSON.parse 要 ~1 秒，而且会阻塞整个
// 事件循环；每 5 分钟重解析一次 = 所有并发请求（含前端每 15 秒一次的 /api/status 轮询）被卡一下。
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
    // 优先读 gzip 版（采集器写的是 readmes.json.gz，约 10MB/1.9 万仓库）；老的 readmes.json 也认，方便迁移期与测试夹具。
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

  /** 三档相关性结论：related / noise / manual。老数据没有 verdict 字段时按 review 兜底（与预计算产物同一套规则） */
  function verdictOf(n) {
    return n.verdict ?? (n.review ? "manual" : "related");
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
      verdict: verdictOf(n),
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
      // 精简行也带判定：列表要能标出噪声、也能按噪声过滤（每个多一个短字符串）
      verdict: verdictOf(n),
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
    // 噪声过滤：默认不过滤（行里照样带 verdict 供标注）。hide = 排除已判定噪声，only = 只看噪声
    const noiseParam = params.get("noise");
    const noiseFilter = noiseParam === "hide" || noiseParam === "only" ? noiseParam : "all";
    // 必须用 hasOwnProperty 之类的方式查表：SORTS["__proto__"] 会拿到 Object.prototype（真值！），
// 接着 hits.sort(Object.prototype) 抛 TypeError —— 一个 &&sort=__proto__ 的查询就是 500。
    const sortParam = String(params.get("sort") ?? "");
    const sortKey = Object.prototype.hasOwnProperty.call(SORTS, sortParam) ? sortParam : "stars";
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
    // 先数后滤：响应里如实报出「这批条件下一共有多少条噪声」，界面才能说清自己藏了什么
    const noiseMatched = hits.filter((n) => verdictOf(n) === "noise").length;
    if (noiseFilter === "hide") hits = hits.filter((n) => verdictOf(n) !== "noise");
    if (noiseFilter === "only") hits = hits.filter((n) => verdictOf(n) === "noise");
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
      query: { q, category, subcategory, tag, language, minStars, archived, noise: noiseFilter, sort: sortKey, limit, offset },
      noise: { filter: noiseFilter, matched: noiseMatched },
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
   * 两个榜单都只用「盘上真的有的东西」算，算不出来的绝不编：周更新 = pushedAt 落在窗口内的仓库按最近推送排序（GitHub 事实）；
   * 周 star = 两个时间点的星标之差，历史点来自 data/cache/star-history.json（采集器每天记一个）或 data/snapshots/*.json（取最老 + 最新两份兜底）。
   * 历史攒不够一个窗口时，不假装是「周」增量：如实返回实际窗口（days），前端照实展示。 */
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


  /* 更新次数：GitHub 只给一个 pushedAt，「一周更新了几次」必须靠采样观测 ——
   * ① 采集器每轮往 data/cache/update-log.json 记「pushedAt 又前进了」的仓库（按天累计）→ 真实频率；
   * ② 没有日志就退一步：用 data/cache/repos.json 里更早的一次 pushedAt 观测比对，只有 2 个观测点，次数上限是 2；
   * ③ 什么都没有：窗口内有推送就记 1 次（GitHub 事实），并在界面上说明还没开始采样。 */
  let updateCache = { key: "", stats: null };

  async function loadUpdateStats(windowStartDay, nodes) {
    const logFile = join(root, "data", "cache", "update-log.json");
    const priorFile = join(root, "data", "cache", "repos.json");
    const logInfo = await stat(logFile).catch(() => null);
    const priorInfo = await stat(priorFile).catch(() => null);
    const key = (logInfo?.mtimeMs ?? -1) + "|" + (priorInfo?.mtimeMs ?? -1);
    if (updateCache.key === key && updateCache.stats) return updateCache.stats;

    const advances = new Map();
    const perDay = new Map();
    const sampledSet = new Set(); // 真正观测过的日子：用来区分「0 次」与「没数据」
    let source = "current-only";
    let observations = 0;
    let sampledDays = 0;

    if (logInfo) {
      try {
        const log = JSON.parse(await readFile(logFile, "utf8"));
        const days = Object.keys(log.days ?? {}).filter((d) => String(d) >= windowStartDay);
        for (const day of log.sampledDays ?? []) if (String(day) >= windowStartDay) sampledSet.add(String(day));
        // 有「观测覆盖」就算有日志口径：哪怕这几天一次推进都没记到，也比重退到两个观测点比对更准（覆盖天数决定趋势柱能不能画）。
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

  /* 版本缓存（data/cache/releases.json，采集器写）：榜单每行带最近几个版本。releases 不在搜索接口的返回里，是采集器按仓库单独抓的（1 个仓库 = 1 次 core 配额）。 */
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
      releasesCache = { mtimeMs: info.mtimeMs, index: { repos: {} } };
    }
    return releasesCache.index;
  }

  /* npm 周下载量（data/cache/npm-downloads.json，采集器写）：可选标注，不进默认排序。
   * 文件不存在 / 损坏 / 单行缺失 → status=unknown、downloads=null，接口绝不崩、也不把缺失写成 0。
   * status=error 表示暂时失败（可重试），与确认无包的 unknown 区分。 */
  const NPM_UNKNOWN = { status: "unknown", package: null, downloads: null, window: null, multiPackage: false };
  let npmCache = { mtimeMs: -2, index: { repos: {}, updatedAt: null } };
  /* 注册表元数据（data/cache/npm-registry.json，tools/market-index.mjs 写）：npm 榜用它判"是不是 DSH 组合包"、
   * 以及"同一个包被多个仓库认领时挑哪个当门面"。缺文件时退回空表，榜会退回只挡官方内部包的弱口径。 */
  let registryCache = { mtimeMs: -2, index: { packages: {}, updatedAt: null } };

  async function loadNpmRegistry() {
    const file = join(root, "data", "cache", "npm-registry.json");
    const info = await stat(file).catch(() => null);
    if (!info) return { packages: {}, updatedAt: null };
    if (registryCache.mtimeMs === info.mtimeMs) return registryCache.index;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const packages = {};
      for (const [name, rec] of Object.entries(data.packages ?? {})) {
        if (rec && typeof rec === "object") packages[name] = rec;
      }
      registryCache = { mtimeMs: info.mtimeMs, index: { packages, updatedAt: data.updatedAt ?? null } };
    } catch {
      registryCache = { mtimeMs: info.mtimeMs, index: { packages: {}, updatedAt: null } };
    }
    return registryCache.index;
  }

  function publicNpm(entry) {
    if (!entry || typeof entry !== "object") return { ...NPM_UNKNOWN };
    const status =
      entry.status === "ok" ||
      entry.status === "private" ||
      entry.status === "no-package" ||
      entry.status === "unknown" ||
      entry.status === "error"
        ? entry.status
        : "unknown";
    const downloads = status === "ok" && typeof entry.downloads === "number" ? entry.downloads : null;
    const window =
      entry.window && entry.window.start && entry.window.end
        ? { start: String(entry.window.start).slice(0, 10), end: String(entry.window.end).slice(0, 10) }
        : null;
    return {
      status: status === "ok" && downloads === null ? "error" : status,
      package: typeof entry.package === "string" ? entry.package : null,
      downloads,
      window,
      multiPackage: !!entry.multiPackage,
    };
  }

  async function loadNpmDownloads() {
    const file = join(root, "data", "cache", "npm-downloads.json");
    const info = await stat(file).catch(() => null);
    if (!info) return { repos: {}, updatedAt: null };
    if (npmCache.mtimeMs === info.mtimeMs) return npmCache.index;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const repos = {};
      for (const [id, entry] of Object.entries(data.repos ?? {})) {
        if (entry && typeof entry === "object") repos[id] = entry;
      }
      npmCache = { mtimeMs: info.mtimeMs, index: { repos, updatedAt: data.updatedAt ?? null } };
    } catch {
      npmCache = { mtimeMs: info.mtimeMs, index: { repos: {}, updatedAt: null } };
    }
    return npmCache.index;
  }

  /* 子目录包（data/cache/npm-packages.json，采集器写）：仓库根没有 package.json、包住在仓库内
     某个目录的那批，按【包名】做 key（一个仓库可能多个包，不能塞进上面那张一对一表）。 */
  let npmPackagesCache = { mtimeMs: -2, index: { packages: {}, updatedAt: null } };

  async function loadNpmPackages() {
    const file = join(root, "data", "cache", "npm-packages.json");
    const info = await stat(file).catch(() => null);
    if (!info) return { packages: {}, updatedAt: null };
    if (npmPackagesCache.mtimeMs === info.mtimeMs) return npmPackagesCache.index;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const packages = {};
      for (const [name, entry] of Object.entries(data.packages ?? {})) {
        if (entry && typeof entry === "object") packages[name] = entry;
      }
      npmPackagesCache = { mtimeMs: info.mtimeMs, index: { packages, updatedAt: data.updatedAt ?? null } };
    } catch {
      npmPackagesCache = { mtimeMs: info.mtimeMs, index: { packages: {}, updatedAt: null } };
    }
    return npmPackagesCache.index;
  }

  /* 逐日星标台账（data/cache/star-daily.json，采集器每轮写）：star 榜逐日趋势柱与窗口增量的【唯一来源】，
   * 两者同源同窗口，所以「行内增量 == 逐日柱加总 + 宽条」由构造成立。
   * 不再用星标环推：环一天只留一个点（同日覆盖），「两个日点的差」只能落在后一天，攒不出逐日形状；而且两个来源各算各的（线上实测 20/20 行的逐日加总都不等于行内增量）。 */
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

  async function ranking(params) {
    const mesh = await load();
    const allNodes = mesh.nodes ?? [];
    // 噪声过滤：默认不过滤（行里带 verdict 供前端标注）；hide / only 由调用方显式要求。
    // 只影响「进榜的是谁」，不改任何排序口径与统计口径 —— 榜单自身仍然是纯 star 增量 / 发版数排序。
    const noiseParam = params.get("noise");
    const noiseFilter = noiseParam === "hide" || noiseParam === "only" ? noiseParam : "all";
    const noiseMatched = allNodes.filter((n) => verdictOf(n) === "noise").length;
    const nodes =
      noiseFilter === "hide"
        ? allNodes.filter((n) => verdictOf(n) !== "noise")
        : noiseFilter === "only"
          ? allNodes.filter((n) => verdictOf(n) === "noise")
          : allNodes;
    const now = Date.now();
    const windowDays = Math.min(30, Math.max(1, Number(params.get("days") ?? 7) || 7));
    const limit = Math.min(RANKING_LIMIT, Math.max(1, Number(params.get("limit") ?? 20) || 20));
    const wantAll = params.get("fields") === "all";
    const releasesIndex = await loadReleases();
    const npmIndex = await loadNpmDownloads();
    const npmExtra = await loadNpmPackages();

    const row = (n) => ({
      id: n.id,
      releases: releasesIndex.repos[n.id] ?? [],
      // 可选标注：周下载量。缺省 → unknown；暂时失败 → error；都不进排序、不写 0
      npm: publicNpm(npmIndex.repos[n.id]),
      name: n.name,
      owner: n.owner,
      avatar: n.avatar ?? null,
      stars: n.stars ?? 0,
      language: n.language ?? null,
      category: n.category ?? null,
      categoryLabel: n.categoryLabel ?? null,
      pushedAt: n.pushedAt ?? null,
      // 三档判定随行返回：榜单上要能标出「已判定噪声」，前端不必再拿 id 回查
      verdict: verdictOf(n),
      ...(wantAll ? { description: n.description ?? "", url: "https://github.com/" + n.id, reason: n.reason ?? null } : {}),
    });

    /* 榜一：周更新热榜（排除归档与复刻：档案馆与镜像刷推送不算「生态在动」）。
     * 排序关键不是「最后一次推送有多新」，而是【一周更新了几次】：updates = 采样到 pushedAt 前进的轮次数（下界），
     * 没采样到也确有推送时保底 1；次数相同时才比最近推送时间、再比星标。 */
    /* 逐日趋势柱的横轴：最近 seriesLen 个「当地日」（含数据快照当天），观测不到的那天给 null —— 界面必须能
     * 区分「当天 0 次」与「当天没观测」。窗口起点必须与横轴对齐（同一组日历日），否则最左边那天的事件会被计数
     * 却不画柱子：线上实测窗口是「现在往前 7×24 小时」（起点 10-01）、横轴只有 10-02…10-08，于是 10-01 的 6 个版本被算进总数（12）却没有柱子（加总只有 6）。 */
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
     * 为什么不是「1 + 采样」：采样到的推进里已经包含「把 pushedAt 推到窗口内的那次推送」，再加 1 就是同一次推送算两遍
     * —— 线上实测前 50 行全部多算 1，趋势柱加总永远比总数少 1。 */
    const updatesOf = (n) => {
      const advances = updateStats.advances.get(n.id) ?? 0;
      if (updateStats.source === "update-log") return Math.max(1, advances);
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
      // 排序：更新次数 desc → 最近推送 desc → 星标 desc（次数相同时，刚刚推过的排在几小时前推过的前面）
      .sort(
        (a, b) =>
          updatesOf(b) - updatesOf(a) ||
          String(b.pushedAt ?? "").localeCompare(String(a.pushedAt ?? "")) ||
          (b.stars ?? 0) - (a.stars ?? 0),
      );

    /* 榜一（v0.5.0 修订）：判定「本周有更新」改用 **releases**（真实发布的版本）。pushedAt 采样数的是「我们采样到
     * 几次推进」，天生是下界，而且会把「只往特性分支推、从不发版」的仓库算成高频更新（线上实据：某项目 24 小时推 41 次）。
     * 计数 = 窗口内真实发布的版本数（不是下界）；排序 = 版本数 → 最新版本日期 → 星标；没有任何 releases 数据时退回采样口径，updatesSource 标清楚。 */
    const meshDay = dayOf(Date.parse(mesh.meta?.generatedAt ?? "") || now);
    const releasesByDay = new Map();
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

    /* 榜二：star 增量。唯一来源是采集器的逐日台账（star-daily）：逐日柱 = 当天各轮真实观测到的星标变化累加
     * （断档那一轮走 spans，不算任何一天）；窗口增量 = Σ(窗口内逐日柱) + Σ(窗口内跨天宽条)。
     * 两者同源同窗口，所以「行内增量 == 逐日柱加总 + 宽条」由构造成立（与更新榜同一条规矩）。
     * 星标环只在台账为空时兜底（冷启动）：那时只能给端点差，攒不出逐日形状，如实降级。 */
    const points = await loadStarHistory();
    const meshAt = Date.parse(mesh.meta?.generatedAt ?? "") || now;
    const starDailyIndex = await loadStarDaily();
    const coveredDays = seriesDays.filter((d) => starDailyIndex.sampled.has(d));
    const hasStarDaily = coveredDays.length > 0;

    const seriesFromDaily = (id) => seriesDays.map((d) => (starDailyIndex.sampled.has(d) ? starDailyIndex.days.get(d)?.get(id) ?? 0 : null));
    const dailySum = (id) => coveredDays.reduce((s, d) => s + (starDailyIndex.days.get(d)?.get(id) ?? 0), 0);
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
    const starDaily = new Map();
    const starSpans = [];
    if (!hasStarDaily) {
      // "现在"的星标：历史里有比 mesh 更新的点就用它，否则用 mesh 自己（都是真实观测值）
      currentStars = useNewer ? newest.stars : Object.fromEntries(nodes.map((n) => [n.id, n.stars ?? 0]));
      const candidates = points.filter((p) => {
        const t = Date.parse(p.at);
        return Number.isFinite(t) && currentAt - t >= 6 * 3600000;
      });
      const target = currentAt - windowDays * 86400000;
      base = candidates.slice().sort((a, b) => Math.abs(Date.parse(a.at) - target) - Math.abs(Date.parse(b.at) - target))[0] ?? null;
      /* star 的逐日趋势（环推）：相邻两次观测间隔 ≤ 26 小时 → 这个差就是「某一天的增量」，画成一根日柱；
       * 间隔更长的（例如只有一个 10-01 的旧观测点，到 10-06 才再观测）算不出逐日，但「这两个时点之间涨了多少」
       * 是真实观测值，所以画成一根【跨 N 天的累计宽柱】，绝不平摊到某一天。 */
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
        // starsAfter - starsBefore === delta 是接口契约（旧路径给的是两个真实观测点）；台账只记「观测到的变化」，起点由终点减回去。
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

    /* 榜三：周 npm 下载量。数据 = data/cache/npm-downloads.json（采集器写）+ data/cache/npm-registry.json（市场索引生成器写）。
     * 三道门槛，缺一不可：
     *   ① status=ok 且带数字 —— 缺数据不是 0，没上榜也不代表没人用；
     *   ② 确实是 DSH 组合包（作者声明 dsh.bundle，或依赖里有 @deepseek-ai/*）—— 与插件市场索引同一套判据；
     *   ③ 不是 @deepseek-ai/* 官方内部模块。
     * 为什么必须有 ②③（线上实据）：不加门槛时榜首 14 行里 12 行是官方内部包被第三方仓库"复制 package.json"顶名
     * （dsh-client-locale 挂在 AlexKaiqi 名下、dsh-session-format 挂在 Chinesezjc 名下），
     * 还有通用 npm 包撞名进榜（platform，920 万周下载，根本不是 DSH 插件）。
     * 再加一道去重：同一个包常被几十个仓库认领（dshmarket 5 个、dsh-whale-widget 11 个），
     * 一个包只留一行；门面优先取 npm 包自己在 repository 里声明的那个仓库。
     * 窗口取自采集时写进缓存的那一段：npm 的 last-week 与另两榜的「最近 7 个自然日」不是同一个周，
     * 所以窗口原样回报（前端写在行上），不假装成同一个「周」。 */
    const registry = await loadNpmRegistry();
    const registryKnown = Object.keys(registry.packages).length > 0;
    const repoKeyOf = (value) => {
      if (!value) return null;
      let url = typeof value === "string" ? value : value.url;
      if (typeof url !== "string" || !url) return null;
      url = url.trim().replace(/^git\+/u, "").replace(/^git@github\.com:/iu, "https://github.com/")
        .replace(/^ssh:\/\/git@github\.com\//iu, "https://github.com/").replace(/^git:\/\//iu, "https://").replace(/\.git$/u, "");
      const hit = /github\.com\/([^/?#]+)\/([^/?#]+)/iu.exec(url);
      return hit ? (hit[1] + "/" + hit[2]).toLowerCase() : null;
    };
    // npm 包自己声明的「家」（registry 的 repository 字段）→ 图节点。
    // 归属时以它为准：根包 private 的 monorepo、官方大仓库、没走 npm 采集的仓库都不会出现在 claimant 里，
    // 只看 claimant 会把复制 package.json 的仓库顶成行主（线上实测 task-board / BrowserSkill / dsh-orb 都是这么错的）。
    const nodeByRepoKey = new Map();
    for (const n of nodes) {
      const key = repoKeyOf(n.htmlUrl) ?? String(n.id ?? "").toLowerCase();
      if (key && !nodeByRepoKey.has(key)) nodeByRepoKey.set(key, n);
    }
    const npmByPkg = new Map();
    let npmSkippedOfficial = 0;
    let npmSkippedNotBundle = 0;
    for (const n of nodes) {
      if (n.archived || n.fork) continue;
      const entry = npmIndex.repos[n.id];
      if (!entry || entry.status !== "ok" || typeof entry.downloads !== "number") continue;
      const pkg = String(entry.package ?? "");
      if (!pkg) continue;
      if (pkg.startsWith("@deepseek-ai/")) {
        npmSkippedOfficial += 1;
        continue;
      }
      const rec = registry.packages[pkg];
      const bundle = !!rec && (rec.isBundle === true || (Array.isArray(rec.dshKeys) && rec.dshKeys.length > 0));
      // 注册表还没生成时（首次部署、生成器失败）退回弱口径：只挡官方内部包，别把整个榜清空
      if (registryKnown && !bundle) {
        npmSkippedNotBundle += 1;
        continue;
      }
      if (!npmByPkg.has(pkg)) npmByPkg.set(pkg, []);
      npmByPkg.get(pkg).push({ node: n, entry, downloads: entry.downloads });
    }
    /* 子目录包（npm 反查发现）：并进同一张榜、一包一行，并标 subdir。
       仓库根已经认到的包优先（同一行不重复）；官方内部模块与"非组合包"沿用同一道门槛。 */
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    let npmSubdirPackages = 0;
    for (const [pkg, rec] of Object.entries(npmExtra.packages)) {
      if (!rec || rec.status !== "ok" || typeof rec.downloads !== "number") continue;
      if (npmByPkg.has(pkg)) continue;
      const node = nodeById.get(String(rec.repoId ?? ""));
      if (!node || node.archived || node.fork) continue;
      if (pkg.startsWith("@deepseek-ai/")) {
        npmSkippedOfficial += 1;
        continue;
      }
      const extraRec = registry.packages[pkg];
      const extraBundle = !!extraRec && (extraRec.isBundle === true || (Array.isArray(extraRec.dshKeys) && extraRec.dshKeys.length > 0));
      if (registryKnown && !extraBundle) {
        npmSkippedNotBundle += 1;
        continue;
      }
      npmByPkg.set(pkg, [{ node, entry: rec, downloads: rec.downloads, subdir: true }]);
      npmSubdirPackages += 1;
    }
    let npmMergedClaimants = 0;
    // claimant 兜底排序：非 fork 优先 → 星标高 → 下载量高 → id 稳定序（只在归属无法核验时才用）
    const claimantRank = (a, b) =>
      (a.node.fork ? 1 : 0) - (b.node.fork ? 1 : 0) ||
      (Number(b.node.stars) || 0) - (Number(a.node.stars) || 0) ||
      b.downloads - a.downloads ||
      String(a.node.id).localeCompare(String(b.node.id));
    const npmAttributionCount = { registryRepo: 0, npmUser: 0, unverified: 0 };
    const npmRows = [];
    for (const [pkg, claimants] of npmByPkg) {
      const registryRec = registry.packages[pkg] ?? null;
      const wanted = repoKeyOf(registryRec?.repository);
      const matched = wanted ? claimants.find((c) => repoKeyOf(c.node.htmlUrl) === wanted) : null;
      const wantedNode = wanted ? nodeByRepoKey.get(wanted) ?? null : null;
      const npmUser = typeof registryRec?.npmUser === "string" ? registryRec.npmUser.toLowerCase() : null;
      const weak = npmUser ? claimants.find((c) => String(c.node.owner ?? "").toLowerCase() === npmUser) ?? null : null;
      const fallback = claimants.slice().sort(claimantRank)[0];
      /* 归属优先级（避免复制作件顶名）：
         ① npm 声明仓库已在图里 → 直接归给它（哪怕它不是 claimant —— 根包 private 的 monorepo / 官方仓库 / 没走 npm 采集都会这样）；
         ② npm 声明仓库不在图里但 npm 维护者与某个 claimant 的 owner 同名 → 弱校验放行（npm-user）；
         ③ 都判不了 → 保留一行数字，但标 unverified，绝不静默把复制件当成真主人。 */
      let chosen = fallback;
      let attribution = "unverified";
      if (wantedNode) {
        // 数字/窗口/逐日都来自同一个 npm 包（按包名查的），拿任一同包 claimant 的 entry 作数据源即可；
        // 优先用 matched / 维护者同名的那个 — 它们就是真仓库自己的缓存条目。
        const dataFrom = matched ?? weak ?? fallback;
        chosen = { node: wantedNode, entry: dataFrom.entry, downloads: dataFrom.downloads, subdir: dataFrom.subdir === true };
        attribution = "registry-repo";
      } else if (weak) {
        chosen = weak;
        attribution = "npm-user";
      }
      npmAttributionCount[attribution === "registry-repo" ? "registryRepo" : attribution === "npm-user" ? "npmUser" : "unverified"] += 1;
      if (claimants.length > 1) npmMergedClaimants += claimants.length - 1;
      const win =
        chosen.entry.window && chosen.entry.window.start && chosen.entry.window.end
          ? { start: chosen.entry.window.start, end: chosen.entry.window.end }
          : null;
      npmRows.push({
        node: chosen.node,
        entry: chosen.entry,
        package: pkg,
        downloads: chosen.downloads,
        window: win,
        days: Array.isArray(chosen.entry.days) ? chosen.entry.days : null,
        subdir: chosen.subdir === true,
        attribution,
        declaredRepo: wanted,
      });
    }
    npmRows.sort((a, b) => b.downloads - a.downloads || (b.node.stars ?? 0) - (a.node.stars ?? 0));
    const shownRows = npmRows.slice(0, limit);
    // 榜面代表窗口 = 「真的会显示出来的那批行」的众数。
    // 不能拿全量 npmRows 算：缓存刷新预算不够时行与行根本不是同一周（线上实测横轴被榜外长尾劫持到 6-25~7-01，
    // 而前 50 行是 10-20~10-26，唯一共享轴让 49/50 行整排变成「没观测」）。行级真横轴见 item.seriesAxis。
    const windowMode = (rows) => {
      const tally = new Map();
      for (const r of rows) {
        if (!r.window) continue;
        const key = r.window.start + "~" + r.window.end;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const npmTopWindow = windowMode(shownRows) ?? windowMode(npmRows);
    // 把 "2026-10-20~2026-10-26" 展开成日期数组（纯日期串运算，跨月/跨年都对）
    const axisOfWindow = (win) => {
      const days = [];
      if (!win) return days;
      const [from, to] = win.split("~");
      for (let d = from; d <= to && days.length < 31; d = dayShift(d, 1)) days.push(d);
      return days;
    };
    // npm 的 7 天与另两榜的 7 个自然日不是同一组日期（npm 按天数据滞后约 5 天），
    // 所以本榜自带一根横轴，绝不与全局 seriesDays 混用。榜级 npmAxis 只是「代表窗口」，行级真横轴见 item.seriesAxis。
    const npmAxis = axisOfWindow(npmTopWindow);
    const npmBoard = {
      label: "周 npm 下载热榜",
      metric: "npm-downloads",
      seriesKind: "npm-downloads",
      available: npmRows.length > 0,
      windowDays,
      total: npmRows.length,
      count: Math.min(limit, npmRows.length),
      maxDownloads: npmRows.length ? npmRows[0].downloads : 0,
      // 代表窗口（榜面行的众数）；每行真正的那一周见 item.npmWindow / item.seriesAxis
      window: npmTopWindow ? { from: npmTopWindow.split("~")[0], to: npmTopWindow.split("~")[1] } : null,
      // 兼容字段：榜级代表横轴；画柱子必须以行级 item.seriesAxis 为准
      seriesAxis: npmAxis,
      seriesRows: npmRows.filter((r) => Array.isArray(r.days)).length,
      coverage: {
        withDownloads: npmRows.length,
        candidates: nodes.length,
        cached: Object.keys(npmIndex.repos).length,
        updatedAt: npmIndex.updatedAt ?? null,
        // 被门槛挡掉的与同名合并的，如实回报 —— 榜小了要能说清"小在哪"
        skippedOfficial: npmSkippedOfficial,
        skippedNotBundle: npmSkippedNotBundle,
        mergedClaimants: npmMergedClaimants,
        subdirPackages: npmSubdirPackages,
        registryKnown,
        // 归属来源分布：registry-repo = npm 声明仓库可对上；npm-user = 只靠维护者同名弱校验；unverified = 判不了
        attribution: npmAttributionCount,
      },
      note:
        "下载量 = npm 官方接口的真实区间计数（不估算、不平摊）。只有确认拿到数字的包能上榜（当前 " +
        npmRows.length + " 个）；未发布 / 没有 package.json / npm 查不到 / 接口暂时失败的一律不进榜 —— 缺数据不是 0。" +
        "只收确实是 DSH 组合包的包：已挡掉 " + npmSkippedOfficial + " 个官方内部模块、" + npmSkippedNotBundle + " 个非组合包；" +
        "同一个包被多个仓库认领时只留一行（合并 " + npmMergedClaimants + " 条）；其中 " + npmSubdirPackages +
        " 个是子目录包（仓库根没有 package.json，包住在仓库内某个目录）。" +
        (npmTopWindow ? " 榜面代表窗口 " + npmTopWindow.split("~")[0] + " ~ " + npmTopWindow.split("~")[1] + "。" : "") +
        " 窗口由采集时写入缓存的 npm 区间决定，可能与另两榜的 " + windowDays + " 个自然日不重合；" +
        "趋势柱用每行自己的横轴（item.seriesAxis，取自该行缓存里的逐日区间）—— 行与行的刷新进度不同，" +
        "窗口可能不是同一周，boards.npm.seriesAxis 只是榜面代表窗口，不再作全榜唯一横轴。" +
        " 归属以 npm 包自报的 repository 为准（对得上图里的仓库就直接归它，哪怕它不是 package.json 的 claimant —— " +
        "根包 private 的 monorepo、官方大仓库、没走 npm 采集的仓库都不会出现在 claimant 里）；对不上时才用 npm 维护者同名做弱校验，" +
        "再判不了就标 npmAttribution=unverified —— 复制 package.json 的仓库不再被静默顶名。",
      items: shownRows.map((r) => {
        // 逐日柱 + 行级横轴都直接来自该行缓存里的逐日数组：加总 == 行内 downloads（采集时就是按逐日求和定的总量）。
        // 不能拿榜级 npmAxis 去查表：行与行的缓存刷新进度不同，共享一根轴时日期对不上的行会整排变 null，
        // 部分重叠的行还会被静默截掉几天（线上实测榜级轴落在 6 月，前 50 行里 49 行一根柱子都没有）。
        const days = Array.isArray(r.days) ? r.days : null;
        return {
          ...row(r.node),
          downloads: r.downloads,
          npmPackage: r.package,
          npmWindow: r.window,
          // 归属来源：registry-repo（npm 声明仓库，可信）/ npm-user（维护者同名弱校验）/ unverified（判不了，别当真主人）
          npmAttribution: r.attribution,
          npmDeclaredRepo: r.declaredRepo,
          // 子目录包：前端据此标注，并可指到仓库里那个目录（packument 的 repository.directory）
          npmSubdir: r.subdir || undefined,
          npmDir: r.subdir ? (registry.packages[r.package]?.repositoryDirectory ?? null) : null,
          seriesAxis: days ? days.map((d) => d.day) : null,
          series: days ? days.map((d) => d.downloads) : null,
          spans: [],
        };
      }),
    };

    return {
      generatedAt: mesh.meta?.generatedAt ?? null,
      now: new Date(now).toISOString(),
      windowDays,
      limit,
      seriesDays,
      dataAgeHours: Number(((now - meshAt) / 3600000).toFixed(1)),
      noise: { filter: noiseFilter, matched: noiseMatched },
      history: { points: points.map((p) => ({ at: p.at, repos: Object.keys(p.stars).length, source: p.source ?? "history" })), latestAt: newest?.at ?? null },
      releases: { cached: Object.keys(releasesIndex.repos).length, updatedAt: releasesIndex.updatedAt ?? null },
      npm: {
        cached: Object.keys(npmIndex.repos).length,
        withDownloads: Object.values(npmIndex.repos).filter((e) => e && e.status === "ok" && typeof e.downloads === "number").length,
        updatedAt: npmIndex.updatedAt ?? null,
      },
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
              // 只有「按天采样」真的在跑时才有逐日序列；退化口径（两个观测点比对）算不出某一天，硬画会变成凭空的柱子 —— 那种情况下一律给 null，让界面显示「暂无逐日数据」。
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
        npm: npmBoard,
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
    // 同作者：数据层为了控制载荷，对成员超过阈值的作者只写「星形拓扑」（枢纽连所有人），直接返回存边会让其余成员的同作者连线只剩一条。
// 这里按 owner 补齐完整关系，与前端画布（ownerSiblings）保持同一套语义。
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
   * 可分享卡片：自包含 SVG，420×168，GitHub 仓库卡片风格（仓库图标 + owner / name、灰阶描述、● 语言色点 / ★ 星标 / ⑂ 复刻 / 更新于）。
   * 交互：整张卡片背景指向站点（options.site），仓库名单独指向 GitHub —— 两个链接是兄弟节点而不是嵌套（SVG 里嵌套 <a> 非法），所以两种点击都能生效。
   */
  /**
   * 可分享卡片：自包含 SVG，420×168，白玻璃卡（作者头像 + owner / repo、灰阶描述、
   * ● 语言色点 / ★ 星标 / ⑂ 复刻 / 更新于、底部分类标签 + 站点入口）。
   * 作者头像抓 64px PNG 内联成 data URI（README 里是 <img> 嵌入，外链不会加载）；失败退回首字母圆标。
   * 交互：整张卡片背景指向站点（options.site），仓库名单独指向 GitHub —— 两个链接是兄弟节点而不是嵌套
   * （SVG 里嵌套 <a> 非法），所以两种点击都能生效。
   */
  async function cardSvg(owner, name, options = {}) {
    const found = await one(owner, name);
    if (!found) return null;
    const n = found.repo;
    const dark = options.theme === "dark";
    const site = options.site || DEFAULT_SITE;
    const host = site.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
    const accent = categoryColor(n.category);
    const fetchAvatar = options.fetchAvatar === undefined ? fetchAvatarDataUri : options.fetchAvatar;
    const avatar = fetchAvatar ? await fetchAvatar(n.owner) : null;

    const c = dark
      ? {
          bgTop: "#161b22", bgBottom: "#0d1117", border: "rgba(255,255,255,0.12)", highlight: "rgba(255,255,255,0.06)",
          owner: "#e6edf3", slash: "#6e7681", repo: "#c9d1d9", desc: "#8b949e", muted: "#8b949e",
          link: "#8b9cff", pill: "rgba(255,255,255,0.08)", pillText: "#c9d1d9", metaLine: "rgba(255,255,255,0.08)", ring: "rgba(255,255,255,0.16)",
        }
      : {
          bgTop: "#ffffff", bgBottom: "#fbfdff", border: "rgba(0,0,0,0.08)", highlight: "rgba(255,255,255,0.9)",
          owner: "#111827", slash: "#9ca3af", repo: "#4b5563", desc: "#4b5563", muted: "#6b7280",
          link: "#4f46e5", pill: "rgba(0,0,0,0.04)", pillText: "#374151", metaLine: "rgba(0,0,0,0.06)", ring: "rgba(0,0,0,0.08)",
        };

    const sector = n.subcategoryLabel ? n.categoryLabel + " · " + n.subcategoryLabel : n.categoryLabel || "未分类";
    const descLines = wrapText(n.description || "（暂无描述）", 13.5, 380, 2);
    const stars = n.stars >= 1000 ? (n.stars / 1000).toFixed(1) + "k" : String(n.stars);
    const forks = n.forks >= 1000 ? (n.forks / 1000).toFixed(1) + "k" : String(n.forks ?? 0);
    const langColor = LANG_COLORS[n.language] || c.muted;
    const updated = relativeTime(n.pushedAt, options.now);
    const initial = String(n.owner || "?").trim().charAt(0).toUpperCase() || "?";

    const t = (x, y, size, fill, weight, text, extra) =>
      '<text x="' + x + '" y="' + y + '" font-family="' + FONT + '" font-size="' + size + '"' +
      (weight ? ' font-weight="' + weight + '"' : "") +
      (extra ?? "") + ' fill="' + fill + '">' + xmlEscape(text) + "</text>";
    const icon = (path, x, y, size, fill) =>
      '<g transform="translate(' + x + " " + y + ') scale(' + size / 16 + ')" fill="' + fill + '"><path d="' + path + '"/></g>';

    // 元信息行：● 语言 · ★ 星标 · ⑂ 复刻 · 更新于（逐项按实测宽度推进，绝不重叠）
    const meta = ['<circle cx="25" cy="120" r="5" fill="' + langColor + '"/>'];
    let mx = 36;
    meta.push(t(mx, 125, 12.5, c.muted, 0, n.language || "未知语言"));
    mx += textWidth(n.language || "未知语言", 12.5) + 14;
    meta.push(icon(ICON_STAR, mx, 114, 13, c.muted));
    mx += 13 + 4;
    meta.push(t(mx, 125, 12.5, c.muted, 0, stars));
    mx += textWidth(stars, 12.5) + 14;
    if (n.forks > 0) {
      meta.push(icon(ICON_FORK, mx, 114, 13, c.muted));
      mx += 13 + 4;
      meta.push(t(mx, 125, 12.5, c.muted, 0, forks));
      mx += textWidth(forks, 12.5) + 14;
    }
    meta.push(t(mx, 125, 12.5, c.muted, 0, "更新于 " + updated));

    const pillW = Math.round(Math.min(280, textWidth(sector, 12) + 24));

    const rows = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="420" height="168" viewBox="0 0 420 168" role="img" aria-label="' + xmlEscape(n.id + " · " + sector) + '">',
      "  <title>" + xmlEscape(n.id) + " · " + xmlEscape(sector) + "</title>",
      "  <desc>" + xmlEscape("点击卡片前往 " + site) + "</desc>",
      "  <defs>",
      '    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.bgTop + '"/><stop offset="1" stop-color="' + c.bgBottom + '"/></linearGradient>',
      '    <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="' + (dark ? "0.45" : "0.10") + '"/></filter>',
      '    <clipPath id="avatarClip"><circle cx="38" cy="38" r="17"/></clipPath>',
      "  </defs>",
      "  <style>.bg{transition:stroke .2s ease}.card:hover .bg{stroke:" + (dark ? "#8b949e" : "#8c959f") + "}.nm:hover{text-decoration:underline}</style>",
      '  <a xlink:href="' + xmlEscape(site) + '" href="' + xmlEscape(site) + '" target="_blank" rel="noopener noreferrer">',
      '    <rect class="bg" x="2" y="2" width="416" height="164" rx="16" fill="url(#cardBg)" stroke="' + c.border + '" filter="url(#cardShadow)"/>',
      '    <rect x="3" y="3" width="414" height="162" rx="15" fill="none" stroke="' + c.highlight + '" stroke-width="1"/>',
      "  </a>",
      avatar
        ? '  <image x="21" y="21" width="34" height="34" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" xlink:href="' + avatar + '" href="' + avatar + '"/>'
        : '  <circle cx="38" cy="38" r="17" fill="' + accent + '" fill-opacity="0.18"/>' + t(38, 43, 14, accent, 700, initial, ' text-anchor="middle"'),
      '  <circle cx="38" cy="38" r="17.5" fill="none" stroke="' + c.ring + '" stroke-width="1"/>',
      '  <a xlink:href="' + xmlEscape(n.url) + '" href="' + xmlEscape(n.url) + '" target="_blank" rel="noopener noreferrer"><text x="66" y="44" font-family="' + FONT + '" font-size="15" font-weight="700">' +
        '<tspan fill="' + c.owner + '">' + xmlEscape(fitText(n.owner, 15, 140)) + "</tspan>" +
        '<tspan fill="' + c.slash + '" font-weight="400"> / </tspan>' +
        '<tspan fill="' + c.repo + '" font-weight="400" class="nm">' + xmlEscape(fitText(n.name, 15, 180)) + "</tspan></text></a>",
      "  " + t(20, 75, 13.5, c.desc, 0, descLines[0] ?? ""),
      ...(descLines[1] ? ["  " + t(20, 94, 13.5, c.desc, 0, descLines[1])] : []),
      '  <line x1="20" y1="108" x2="400" y2="108" stroke="' + c.metaLine + '" stroke-width="1"/>',
      ...meta.map((row) => "  " + row),
      '  <rect x="20" y="138" width="' + pillW + '" height="22" rx="11" fill="' + c.pill + '" stroke="' + c.border + '"/>',
      "  " + t(32, 153, 12, c.pillText, 500, fitText(sector, 12, 264)),
      '  <a xlink:href="' + xmlEscape(site) + '" href="' + xmlEscape(site) + '" target="_blank" rel="noopener noreferrer">' +
        t(400, 153, 12.5, c.link, 600, "插件生态图 · " + host + " ↗", ' text-anchor="end" class="nm"') + "</a>",
      "</svg>",
    ];

    return rows.join("\n") + "\n";
  }

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
      '<a href="' + xmlEscape(site) + '"><img src="/api/card/' + xmlEscape(n.id) + '.svg?theme=dark" alt="' + xmlEscape(n.id) + '" width="420" height="168"></a>',
      "</div>",
      "<h2>Markdown</h2><pre>" + xmlEscape(md) + "</pre>",
      "<h2>HTML</h2><pre>" + xmlEscape(html) + "</pre>",
      "<h2>说明</h2>",
      '<p class="note">卡片是自包含 SVG（无外部依赖、无脚本），贴进 README、博客或文档即可。<br>' +
        "上面两张分别是浅色版与深色版：默认浅色，加 <code>?theme=dark</code> 出深色；换去处加 <code>?link=https://你的站点/</code>（默认 " + xmlEscape(DEFAULT_SITE) + "）。<br>" +
        "作者头像会内联成 data URI（不依赖外链），卡片仍是自包含 SVG；抓不到头像时退回首字母圆标。<br>数据每小时更新，卡片随之变化。<br>仓库信息：<a href=\"/api/repos/" + xmlEscape(n.id) + "\">/api/repos/" + xmlEscape(n.id) + "</a> · 生态总览：<a href=\"/api/categories\">/api/categories</a></p>",
      "</main></body></html>",
    ];
    return body.join("\n");
  }

  /** 紧凑检索：只回命中 id 与计数，供前端搜索框做「高亮 + 放射线」；与 /api/repos 的区别是不返回节点字段（几万个 id 也只有几十 KB），并额外告诉你有多少个是【只有 README 才命中】的。 */
  /** 采集进度状态：读采集器写的 data/cache/status.json，补上服务器时间与数据概况；前端顶栏的「状态」圆环按 nextRunAt 倒计时，浮窗展示进度，文件不存在时 status 为 null。 */
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

  /* 生态图「索引仓库」光环名单：dist/market/index-nodes.json，由 tools/market-index.mjs 与索引一起产出。
     只回 id 列表，不回下载量数字。清单缺失（老部署 / 索引还没生成）时退回旧判据，接口不空白。 */
  let indexNodesCache = { mtimeMs: -2, data: null };

  async function loadIndexNodes() {
    const file = join(root, "dist", "market", "index-nodes.json");
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    if (indexNodesCache.mtimeMs === info.mtimeMs) return indexNodesCache.data;
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const ids = Array.isArray(data.ids) ? data.ids.filter((x) => typeof x === "string" && x) : [];
      indexNodesCache = { mtimeMs: info.mtimeMs, data: { ids, updatedAt: data.generatedAt ?? null } };
    } catch {
      indexNodesCache = { mtimeMs: info.mtimeMs, data: null };
    }
    return indexNodesCache.data;
  }

  /* 哪些仓库配叫「索引仓库」：以【市场索引的归属】为准 —— 索引说这个包归谁，就点亮谁。
     旧判据只看"仓库 package.json 里写了个 npm 上存在的包名"，不校验归属：线上实测 9830 个这样的
     仓库里，2091 个的包在索引里其实归别人（同名抢注，dsh-desktop 一个包名被 97 个仓库声明），
     图上有 10144 个球被标成「索引仓库」，约三分之一名不副实。 */
  async function npmNodes() {
    const npmIndex = await loadNpmDownloads();
    const npmExtra = await loadNpmPackages();
    const ids = [];
    const seen = new Set();
    const halo = await loadIndexNodes();
    if (halo && halo.ids.length) {
      for (const id of halo.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      ids.sort();
      const subdirIds = [...new Set(Object.values(npmExtra.packages)
        .filter((rec) => rec && rec.status === "ok" && rec.repoId)
        .map((rec) => String(rec.repoId)))]
        .filter((id) => seen.has(id))
        .sort();
      return {
        updatedAt: halo.updatedAt ?? npmIndex.updatedAt ?? null,
        count: ids.length,
        subdirCount: subdirIds.length,
        ids,
        subdirIds,
        source: "market-index",
      };
    }
    for (const [id, entry] of Object.entries(npmIndex.repos)) {
      if (!entry || entry.status !== "ok" || !entry.package) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const subdirIds = [];
    for (const rec of Object.values(npmExtra.packages)) {
      const id = rec && rec.status === "ok" ? String(rec.repoId ?? "") : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      subdirIds.push(id);
    }
    ids.sort();
    subdirIds.sort();
    return {
      updatedAt: npmIndex.updatedAt ?? npmExtra.updatedAt ?? null,
      count: ids.length,
      subdirCount: subdirIds.length,
      ids,
      subdirIds,
      source: "npm-downloads",
    };
  }

  return { load, search, searchIds, readmeStats, starDailyStats, status, ranking, categories, one, cardSvg, cardPage, publicNode, slim, npmNodes };
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
      { method: "GET", path: "/api/ranking?days=7&limit=50&fields=all&noise=all|hide|only", desc: "榜单：周更新热榜（本周发过 release 的项目，最多 50 行，含 updates / updatesSource / releases）+ 周 star 热榜（星标历史增量，最多 50 行；历史不足时如实返回实际窗口）+ 周 npm 下载热榜（npm 官方下载量真实计数，只收确认拿到数字的包；窗口取自采集时的 npm 区间，可能与另两榜不重合，见 boards.npm.window）。每行带 verdict（related/noise/manual）与 npm（周下载量可选列：status/package/downloads/window；缺省或失败为 unknown，不进排序）。npm 榜的行还带 npmAttribution（registry-repo = npm 声明仓库可对上 / npm-user = 只靠维护者同名弱校验 / unverified = 归属判不了）与 npmDeclaredRepo（npm 包自报的仓库），复制 package.json 的仓库不再被静默顶名；noise=hide 排除已判定噪声，only 只看噪声，默认 all（只标注不过滤）" },
      { method: "GET", path: "/api/categories", desc: "扇区（功能分类）与细枝及各自数量" },
      { method: "GET", path: "/api/npm-nodes", desc: "有 npm 包的仓库 id 列表（与市场索引源重叠的那批，供生态图画外圈光环用）；只回 id，不回数字" },
      { method: "GET", path: "/api/review-nodes", desc: "在评测站（review.lingshulab.com）有公开测评的仓库：ids + byId（各插件篇数与插件测评页 URL）。数据来自评测站公开接口，每 10 分钟同步、响应缓存 60 秒；失败沿用旧数据并标 stale，超过 7 天标 expired（前端隐藏光环）。注意：这里的 review 是「评测站测评」，不是节点字段 node.review 的「待人工复核」" },
      { method: "GET", path: "/api/repos?q=&category=&subcategory=&tag=&language=&minStars=&archived=&noise=&sort=stars|pushed|created|name&limit=&offset=&fields=all", desc: "检索仓库（默认 20 条，最多 100 条）。行带 verdict；noise=hide|only 按三档判定过滤，默认 all 只标注" },
      { method: "GET", path: "/api/search?q=&limit=", desc: "紧凑检索：只回命中 id 与计数（含 README 正文命中）" },
      { method: "GET", path: "/api/repos/:owner/:name", desc: "单个仓库详情，含同作者/主题共现连线" },
      { method: "GET", path: "/preview.svg?theme=dark|light&size=&sample=", desc: "README 预览图：按当前数据实时渲染的生态图；不带参数时 size=1400、sample=6000（也可走 /api/preview.svg）" },
      { method: "GET", path: "/api/card/:owner/:name.svg?theme=light|dark&link=", desc: "可分享的 SVG 卡片" },
      { method: "GET", path: "/card/:owner/:name", desc: "卡片分享页（预览 + 嵌入代码）" },
      { method: "GET", path: "/api/stats", desc: "访问统计（只读；多节点模式回到各节点合计，raw=1 只回本节点原始计数）" },
      { method: "GET", path: "/api/nodes", desc: "多节点（镜像）清单：后台配置的部署节点，供前台切换；单节点部署时 enabled=false" },
      { method: "GET", path: "/api/manifesto", desc: "倡议书内容（后台可编辑：标题 / 副标题 / 两个页签的正文 HTML）" },
      { method: "POST", path: "/api/ping", desc: "上报一次访问（前端自动调用，唯一接受 POST 的接口）" },
    ],
  };
}
