#!/usr/bin/env node
/**
 * seed-sample — 临时取样器（非正式采集器）
 *
 * 目的：只跑一次，为「前端原型」取一份真实、可信的样本数据。
 * 正式采集器（增量、缓存、去噪、快照 diff）尚未开工，见 README 的路线图。
 *
 * 输出：
 *   data/sample-raw.json  原始 API 响应（裁剪字段，作为可追溯来源）
 *   data/mesh.json        前端数据契约（meta / tags / clusters / nodes / edges）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { applyCategories, DEFAULT_OPTIONS } from "./categories.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const API = "https://api.github.com";

/** 白名单：项目要捕获的 6 个标签 */
const WHITELIST = [
  "dsh-plugin-desktop",
  "dsh-desktop",
  "dsh-plugin-market",
  "dsh-plugins",
  "dsh-plugin",
  "dsh",
];

const HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "dsh-plugin-mesh-seed/0.1 (frontend prototype sampling)",
  "x-github-api-version": "2022-11-28",
};

const QUERIES = [
  { id: "plugin-1", q: "topic:dsh-plugin", sort: "stars", page: 1 },
  { id: "plugin-2", q: "topic:dsh-plugin", sort: "stars", page: 2 },
  { id: "plugins-1", q: "topic:dsh-plugins", sort: "stars", page: 1 },
  { id: "desktop-plugin-1", q: "topic:dsh-plugin-desktop", sort: "stars", page: 1 },
  { id: "desktop-plugin-2", q: "topic:dsh-plugin-desktop", sort: "stars", page: 2 },
  { id: "market-1", q: "topic:dsh-plugin-market", sort: "stars", page: 1 },
  { id: "desktop-1", q: "topic:dsh-desktop", sort: "stars", page: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function pickRepo(it) {
  return {
    id: it.full_name,
    name: it.name,
    owner: it.owner?.login ?? "?",
    ownerType: it.owner?.type ?? null,
    avatar: it.owner?.avatar_url ?? null,
    htmlUrl: it.html_url,
    stars: it.stargazers_count ?? 0,
    forks: it.forks_count ?? 0,
    openIssues: it.open_issues_count ?? 0,
    createdAt: it.created_at ?? null,
    pushedAt: it.pushed_at ?? null,
    language: it.language ?? null,
    license: it.license?.spdx_id ?? null,
    archived: !!it.archived,
    fork: !!it.fork,
    description: it.description ?? "",
    homepage: it.homepage || null,
    sizeKb: it.size ?? 0,
    topics: Array.isArray(it.topics) ? it.topics : [],
  };
}

/** 朴素相关度启发式：正式设计待后端阶段重做，这里只用于原型演示「疑似噪声」概念 */
function relevanceScore(r) {
  let s = 0;
  if (/(^|[^a-z])dsh([^a-z]|$)|dsh-|dsh_/i.test(r.name)) s += 3;
  if (/dsh|deepseek[- ]?harness|cordis/i.test(r.description)) s += 2;
  if (r.topics.includes("deepseek-harness")) s += 1;
  const family = r.topics.filter((t) => WHITELIST.includes(t)).length;
  if (family >= 2) s += 1;
  if (/cordis/i.test(r.description) || r.topics.includes("cordis")) s += 1;
  return s; // 0..8
}

function buildMesh(rawRepos, queryMeta) {
  const nodes = [];
  const seen = new Map();
  for (const r of rawRepos) {
    const matchedTags = WHITELIST.filter((t) => r.topics.includes(t));
    if (!matchedTags.length) continue; // 精确命中才算数：只认 topics[] 里的白名单标签
    if (seen.has(r.id)) {
      const prev = seen.get(r.id);
      prev.matchedTags = [...new Set([...prev.matchedTags, ...matchedTags])].sort(
        (a, b) => WHITELIST.indexOf(a) - WHITELIST.indexOf(b),
      );
      continue;
    }
    const rel = relevanceScore(r);
    const node = {
      ...r,
      matchedTags,
      primaryTag: WHITELIST.find((t) => matchedTags.includes(t)) ?? "dsh",
      relevance: rel,
      noise: clamp(1 - rel / 5, 0, 1),
      review: rel <= 2,
    };
    seen.set(r.id, node);
    nodes.push(node);
  }

  // ---- 边：主题共现（只连稀有主题）+ 同作者 ----
  const edgeMap = new Map();
  const addEdge = (a, b, type, via) => {
    const [s, t] = a < b ? [a, b] : [b, a];
    const key = type + ":" + s + "|" + t;
    let e = edgeMap.get(key);
    if (!e) {
      e = { source: s, target: t, type, weight: 0, via: [] };
      edgeMap.set(key, e);
    }
    e.weight += 1;
    if (via && e.via.length < 4 && !e.via.includes(via)) e.via.push(via);
  };

  const byTopic = new Map();
  for (const n of nodes) {
    for (const t of n.topics) {
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t).push(n.id);
    }
  }
  const hubs = [];
  const HUB_DF = 8; // 出现次数 > 8 的主题视为超级枢纽，只展示不连线（否则图变毛线球）
  for (const [topic, ids] of [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (ids.length < 2) continue;
    if (ids.length > HUB_DF) {
      hubs.push({ topic, count: ids.length });
      continue;
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j], "topic", topic);
    }
  }

  // 同作者：成员少的两两相连；成员多的用星形（星标最高的连到其余），既不断链也不炸成 n²
  const OWNER_CLIQUE_MAX = 8;
  const byOwner = new Map();
  for (const n of nodes) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  let ownerEdges = 0;
  let ownerStars = 0;
  for (const [owner, group] of byOwner) {
    if (group.length < 2) continue;
    if (group.length <= OWNER_CLIQUE_MAX) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          addEdge(group[i].id, group[j].id, "owner", owner);
          ownerEdges++;
        }
      }
    } else {
      const hub = [...group].sort((a, b) => b.stars - a.stars)[0];
      for (const n of group) {
        if (n.id === hub.id) continue;
        addEdge(hub.id, n.id, "owner", owner);
        ownerStars++;
      }
    }
  }

  // ---- 度数上限：只裁剪"主题共现"边；同作者是硬关系，必须保留 ----
  // （曾经的 bug：高星仓库先被主题边占满配额，Tencent/BrowserSkill 与 Tencent/WeKnora 的同作者边被静默丢掉）
  const DEGREE_CAP = 14;
  const sorted = [...edgeMap.values()].sort((a, b) => b.weight - a.weight);
  const degree = new Map();
  const edges = [];
  let dropped = 0;
  for (const e of sorted) {
    if (e.type !== "topic") {
      edges.push(e);
      continue;
    }
    const ds = degree.get(e.source) ?? 0;
    const dt = degree.get(e.target) ?? 0;
    if (ds >= DEGREE_CAP || dt >= DEGREE_CAP) {
      dropped++;
      continue;
    }
    degree.set(e.source, ds + 1);
    degree.set(e.target, dt + 1);
    edges.push(e);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;

  // ---- 功能分类：纯规则打分，不按标签分组（见 tools/categories.mjs）----
  const categoryStats = applyCategories(nodes, { ...DEFAULT_OPTIONS });
  const clusters = categoryStats.counts.map((c) => ({ id: c.id, label: c.label, count: c.count }));

  const tagCounts = WHITELIST.map((t) => ({
    id: t,
    sampleCount: nodes.filter((n) => n.matchedTags.includes(t)).length,
    apiTotal: queryMeta.find((m) => m.q === "topic:" + t)?.totalCount ?? null,
  }));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      kind: "sample-seed",
      note: "临时取样（每标签按星标取头部若干页），非全量采集；全量索引见后端设计。",
      source: "GitHub REST Search API",
      sampleNodes: nodes.length,
      sampleEdges: edges.length,
      droppedEdges: dropped,
      ownerEdges,
      hubThreshold: HUB_DF,
      degreeCap: DEGREE_CAP,
      reviewedAsNoise: nodes.filter((n) => n.review).length,
      ownerEdges,
      ownerStarEdges: ownerStars,
      topicEdgesDroppedByCap: dropped,
      categories: {
        classified: categoryStats.classified,
        unclassified: categoryStats.unclassified,
        minCount: 10,
        maxSectors: 18,
        merged: categoryStats.merged,
        distribution: categoryStats.counts,
      },
      queries: queryMeta,
    },
    tags: tagCounts,
    hubs: hubs.slice(0, 12),
    clusters,
    nodes,
    edges,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const rawRepos = [];
  const queryMeta = [];
  const errors = [];
  const fromRaw = process.argv.includes("--from-raw");

  if (fromRaw) {
    // 离线重建：只读本地原始记录，零网络请求（改分类规则后用这个，别重复消耗配额）
    const cached = JSON.parse(await readFile(resolve(DATA_DIR, "sample-raw.json"), "utf8"));
    rawRepos.push(...cached.repos);
    queryMeta.push(...(cached.queryMeta ?? []));
    errors.push(...(cached.errors ?? []));
    console.log("离线重建：载入 " + rawRepos.length + " 条原始记录（零网络请求）");
  }

  for (let i = 0; !fromRaw && i < QUERIES.length; i++) {
    const spec = QUERIES[i];
    const url =
      API +
      "/search/repositories?q=" +
      encodeURIComponent(spec.q) +
      "&sort=" + spec.sort +
      "&order=desc&per_page=100&page=" + spec.page;
    try {
      const res = await fetch(url, { headers: HEADERS });
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (!res.ok) {
        errors.push({ id: spec.id, status: res.status, body: (await res.text()).slice(0, 200) });
        console.error("[warn] " + spec.id + " HTTP " + res.status);
      } else {
        const json = await res.json();
        const items = (json.items ?? []).map(pickRepo);
        rawRepos.push(...items);
        queryMeta.push({
          id: spec.id, q: spec.q, page: spec.page, sort: spec.sort,
          totalCount: json.total_count ?? null,
          fetched: items.length,
          incomplete: !!json.incomplete_results,
          rateRemaining: remaining ? Number(remaining) : null,
        });
        console.log("[ok] " + spec.id + " total=" + json.total_count + " fetched=" + items.length + " rate_left=" + remaining);
      }
    } catch (err) {
      errors.push({ id: spec.id, status: 0, body: String(err).slice(0, 200) });
      console.error("[warn] " + spec.id + " " + err);
    }
    if (i < QUERIES.length - 1) await sleep(8000); // 搜索接口未认证 10 次/分钟
  }

  const mesh = buildMesh(rawRepos, queryMeta);
  mesh.meta.errors = errors;
  mesh.meta.builtFrom = fromRaw ? "sample-raw.json（离线重建）" : "GitHub REST Search API（本次抓取）";
  if (!fromRaw) {
    await writeFile(resolve(DATA_DIR, "sample-raw.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), queryMeta, errors, repos: rawRepos }, null, 1));
  }
  const outIndex = process.argv.indexOf("--out");
  const outPath = outIndex > -1 ? resolve(process.cwd(), process.argv[outIndex + 1]) : resolve(DATA_DIR, "mesh.json");
  await writeFile(outPath, JSON.stringify(mesh, null, 1));
  console.log("契约写入 " + outPath);

  console.log("\n=== 取样结果 ===");
  console.log("nodes=" + mesh.meta.sampleNodes + " edges=" + mesh.meta.sampleEdges + " dropped=" + mesh.meta.droppedEdges + " review=" + mesh.meta.reviewedAsNoise);
  console.log("功能扇区=" + mesh.clusters.map((c) => c.id + "(" + c.count + ")").join(" "));
  console.log("未分类=" + mesh.meta.categories.unclassified + " / " + mesh.nodes.length);
  if (mesh.meta.categories.merged.length) console.log("并入其他=" + mesh.meta.categories.merged.map((m) => m.id + "(" + m.count + "," + m.reason + ")").join(" "));
  console.log("hubs=" + JSON.stringify(mesh.hubs.slice(0, 6)));
  if (errors.length) console.log("errors=" + JSON.stringify(errors));
}

main().catch((e) => { console.error(e); process.exit(1); });
