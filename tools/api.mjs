/**
 * 只读查询 API + 可分享卡片。
 *
 * 设计原则：
 *   1. 零依赖、零构建：只用 Node 标准库，数据直接读 data/mesh.json。
 *   2. 只读、无副作用：不接受任何写操作，不接触 .env / 令牌 / 缓存目录。
 *   3. 同端口：由 tools/serve.mjs 挂在同一个 HTTP 服务上（本地 8788 / 线上 80）。
 *   4. 输出可缓存：数据每小时更新，API 响应给 5 分钟公共缓存。
 */

import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { stripNoiseOwners } from "../src/mesh-data.js";

const DATA_TTL_MS = 5 * 60 * 1000;
/** 卡片默认去处：线上站点（可用 SITE_URL 环境变量或 ?link= 覆盖） */
export const DEFAULT_SITE = "http://104.129.51.126/";
export const MAX_LIMIT = 100;
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
        "换主题加 <code>?theme=dark</code>；换去处加 <code>?link=https://你的站点/</code>（默认 " + xmlEscape(DEFAULT_SITE) + "）。<br>" +
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

  return { load, search, searchIds, readmeStats, status, categories, one, cardSvg, cardPage, publicNode, slim };
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
      { method: "GET", path: "/api/categories", desc: "扇区（功能分类）与细枝及各自数量" },
      { method: "GET", path: "/api/repos?q=&category=&subcategory=&tag=&language=&minStars=&archived=&sort=stars|pushed|created|name&limit=&offset=&fields=all", desc: "检索仓库（默认 20 条，最多 100 条）" },
      { method: "GET", path: "/api/search?q=&limit=", desc: "紧凑检索：只回命中 id 与计数（含 README 正文命中）" },
      { method: "GET", path: "/api/repos/:owner/:name", desc: "单个仓库详情，含同作者/主题共现连线" },
      { method: "GET", path: "/preview.svg?theme=dark|light&size=&sample=", desc: "README 预览图：按当前数据实时渲染的生态图（也可走 /api/preview.svg）" },
    { method: "GET", path: "/api/card/:owner/:name.svg?theme=light|dark", desc: "可分享的 SVG 卡片" },
      { method: "GET", path: "/card/:owner/:name", desc: "卡片分享页（预览 + 嵌入代码）" },
    ],
  };
}
