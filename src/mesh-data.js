/**
 * 数据层：载入 data/mesh.json（前端数据契约）并派生视图需要的索引。
 * 契约见 docs/data-contract.md；后端采集器只需产出同样结构即可直接驱动本前端。
 * 载入带本地缓存：二次访问先秒开缓存，再后台用 ETag 校验。
 */
import { createStore } from "./cache.js";

export const TAG_COLORS = {
  "dsh-plugin-desktop": "#9b8cf0",
  "dsh-desktop": "#4fb3d9",
  "dsh-plugin-market": "#3fb8a8",
  "dsh-plugins": "#8bbf5e",
  "dsh-plugin": "#5686fe",
  dsh: "#d97b7b",
  misc: "#9aa5b1",
};

/**
 * 连线样式。color 为 null 时用端点所属扇区的颜色（近邻连线因此与扇区同色）。
 * curv：弧线鼓起的程度（相对弦长），值越大越远离圆心 —— 观赏性的关键参数。
 */
export const EDGE_STYLES = {
  // 选中时画的两类连线：颜色明显区分（同作者=主题主色，主题共现=琥珀）
  owner: { label: "同作者", color: null, alpha: 0.85, curv: 0.16, dash: [] },
  topic: { label: "主题共现", color: "#e08a00", alpha: 0.5, curv: 0.22, dash: [5, 4] },
  fork: { label: "复刻血缘", color: "#a08a6a", alpha: 0.3, curv: 0.14, dash: [2, 3] },
};

/** 功能扇区配色：以 DSH 主色 #5686fe 领衔的柔和色阶，与 DSH 中性灰底共存不刺眼 */
export const GROUP_PALETTE = [
  "#5686fe", "#7f9cf5", "#4fb3d9", "#3fb8a8", "#57b894", "#8bbf5e",
  "#d9b053", "#dd8f5f", "#d97b7b", "#c98ac9", "#9b8cf0", "#9aa5b1",
  "#5aa8e8", "#6fd3c8", "#a8c06a", "#e0a86a", "#e08f9f", "#b09ae8",
  "#7fc0d8", "#8fd0a8", "#d8b87f", "#cc8fc0", "#9fb0d8", "#c0a0a8",
];

export function colorOfTag(tag) {
  return TAG_COLORS[tag] ?? TAG_COLORS.misc;
}

/** 方向（分组）配色：命中标签用标签色，其余（语言/作者等）按固定调色板分配 */
export function groupColor(id, index = 0) {
  return TAG_COLORS[id] ?? GROUP_PALETTE[index % GROUP_PALETTE.length];
}

export async function loadMesh(url = "./data/mesh.json") {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("载入 " + url + " 失败：HTTP " + res.status);
  return res.json();
}

const MESH_CACHE_KEY = "mesh:v1";

/**
 * 带缓存的载入：先把本地缓存的数据交出去（秒开），再带 ETag 去后台校验。
 * 返回 { mesh, fromCache, revalidate }；revalidate() 返回新数据或 null（表示没变）。
 */
export async function loadMeshCached(url = "./data/mesh.json", options = {}) {
  const store = options.store ?? (await createStore());
  let cached = null;
  try {
    cached = await store.get(MESH_CACHE_KEY);
  } catch {
    cached = null;
  }

  const fetchFresh = async () => {
    const headers = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const res = await fetch(url, { headers, cache: "no-store" });
    if (res.status === 304) return null; // 服务端说没变，直接用缓存
    if (!res.ok) throw new Error("载入 " + url + " 失败：HTTP " + res.status);
    const etag = res.headers?.get?.("etag") ?? null;
    const mesh = await res.json();
    cached = { etag, mesh };
    try {
      await store.put(MESH_CACHE_KEY, cached);
    } catch {
      /* 配额不足等情况忽略，不影响本次渲染 */
    }
    return mesh;
  };

  if (cached?.mesh) return { mesh: cached.mesh, fromCache: true, revalidate: fetchFresh };
  const mesh = await fetchFresh();
  return { mesh, fromCache: false, revalidate: async () => null };
}

/**
 * 优先载入预计算契约（mesh-core.json）：体积小一半、且浏览器不用再算布局。
 * 没有 core 就回退到整份 mesh.json（老数据/老部署照常能用）。
 */
export async function loadMeshBest(url = "./data/mesh.json", options = {}) {
  const coreUrl = options.coreUrl ?? "./data/mesh-core.json";
  try {
    const res = await fetch(coreUrl, { cache: "no-store" });
    if (res.ok) {
      const core = await res.json();
      if (core?.nodes?.length && core.meta?.layout === "precomputed") {
        return { mesh: core, core: true, fromCache: false, revalidate: async () => null };
      }
    }
  } catch {
    /* 回退 */
  }
  const result = await loadMeshCached(url, options);
  return { ...result, core: false };
}

/** 预计算契约里的连线类型编码 */
export const EDGE_TYPE_BY_CODE = ["owner", "topic", "fork", "neighbor"];

/**
 * 从预计算契约（mesh-core.json）构建，产物与 prepare() 同形。
 * 区别：节点已经带好 x/y/r，连线已经是索引三元组（不再需要 buildLinks）。
 */
export function prepareCore(core) {
  const nodes = core.nodes ?? [];
  const triples = core.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const links = [];
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b, code] of triples) {
    const na = nodes[a];
    const nb = nodes[b];
    if (!na || !nb) continue;
    const type = EDGE_TYPE_BY_CODE[code] ?? "topic";
    links.push({ a, b, type });
    adjacency.get(na.id).push({ id: nb.id, type, weight: 1, via: [] });
    adjacency.get(nb.id).push({ id: na.id, type, weight: 1, via: [] });
  }

  const review = nodes.filter((n) => n.review).sort((a, b) => b.stars - a.stars);
  return {
    mesh: core,
    core: true,
    nodes,
    edges: triples,
    links,
    byId,
    adjacency,
    languages: [...new Set(nodes.map((n) => n.language).filter(Boolean))].sort(),
    owners: new Set(nodes.map((n) => n.owner)),
    maxStars: nodes.reduce((m, n) => Math.max(m, n.stars || 0), 0),
    review,
    meta: core.meta ?? {},
    tags: core.tags ?? [],
    clusters: core.clusters ?? [],
    hubs: core.hubs ?? [],
    edgeTypes: [...new Set(links.map((l) => l.type))],
  };
}

/**
 * 预计算布局 → 与 createSectorLayout 同接口的轻量对象。
 * 坐标直接来自数据，浏览器不再做上万节点的松弛迭代（这正是卡顿的根因）。
 * 入场动画仍保留：从圆心扩散到最终位置。
 */
export function precomputedLayout(core) {
  const nodes = core.nodes ?? [];
  const size = nodes.length;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const tx = Float64Array.from(nodes, (n) => n.x ?? 0);
  const ty = Float64Array.from(nodes, (n) => n.y ?? 0);
  // 立即用最终坐标填充（不能再等 tick 动画，否则所有点会先挤在圆心）
  const x = Float64Array.from(tx);
  const y = Float64Array.from(ty);
  const radius = Float32Array.from(nodes, (n) => n.r ?? 3);
  // 坐标立即就位：视图的沉降判定是 alpha > 0.004（原布局 alpha 从 1 递减到 0），
  // 预计算模式没有可沉降的东西，所以直接给最终坐标 + alpha = 1，第一次 tick 就归零。
  let alpha = 1;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < size; i++) {
    if (tx[i] < minX) minX = tx[i];
    if (tx[i] > maxX) maxX = tx[i];
    if (ty[i] < minY) minY = ty[i];
    if (ty[i] > maxY) maxY = ty[i];
  }
  // 扇区成员：预计算里存的是索引，这里还原成面板需要的 {id} 结构（顺序即离圆心远近）
  const arms = (core.arms ?? []).map((arm) => ({
    ...arm,
    members: (arm.members ?? []).map((i) => ({ id: nodes[i]?.id, index: i })).filter((m) => m.id),
  }));
  const hubIndex = index.get("deepseek-ai/deepseek-harness");
  return {
    kind: "radial",
    precomputed: true,
    seed: core.meta?.layoutSeed ?? "precomputed",
    size,
    index,
    nodes,
    x,
    y,
    radius,
    arms,
    // 视图读的是 center.index（原布局的 center 是带 index 的成员对象），这里必须给同形结构
    center: hubIndex !== undefined ? { ...nodes[hubIndex], index: hubIndex } : null,
    get alpha() {
      return alpha;
    },
    tick() {
      // 预计算布局没有沉降过程：一帧内结束，坐标已经是最终值
      alpha = 0;
      return false;
    },
    getBounds(padding = 0) {
      return { minX: minX - padding, maxX: maxX + padding, minY: minY - padding, maxY: maxY + padding };
    },
    /** 预计算模式下"重排"由 app 层改走本地重算，这里只做占位 */
    reseed() {
      alpha = 0;
    },
  };
}

/** 星标分位阈值：给「最少星标」滑块用（纯函数，放数据层免得为了它加载整个面板模块） */
export function starThreshold(pct, maxStars) {
  return Math.round(maxStars * Math.pow(pct / 100, 3));
}

export function prepare(mesh) {
  const nodes = mesh.nodes ?? [];
  const edges = mesh.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const adjacency = new Map();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adjacency.get(e.source).push({ id: e.target, type: e.type, weight: e.weight || 1, via: e.via ?? [] });
    adjacency.get(e.target).push({ id: e.source, type: e.type, weight: e.weight || 1, via: e.via ?? [] });
  }
  for (const list of adjacency.values()) list.sort((a, b) => b.weight - a.weight);

  const languages = [...new Set(nodes.map((n) => n.language).filter(Boolean))].sort();
  const owners = new Set(nodes.map((n) => n.owner));
  const maxStars = nodes.reduce((m, n) => Math.max(m, n.stars || 0), 0);
  const review = nodes.filter((n) => n.review).sort((a, b) => b.stars - a.stars);

  return {
    mesh,
    nodes,
    edges,
    byId,
    adjacency,
    languages,
    owners,
    maxStars,
    review,
    meta: mesh.meta ?? {},
    tags: mesh.tags ?? [],
    clusters: mesh.clusters ?? [],
    hubs: mesh.hubs ?? [],
    edgeTypes: [...new Set(edges.map((e) => e.type))],
  };
}

/** 搜索匹配：仓库名 / 作者 / 描述 / 标签 */
export function matches(node, query) {
  if (!query) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    node.id.toLowerCase().includes(q) ||
    (node.description ?? "").toLowerCase().includes(q) ||
    (node.topics ?? []).some((t) => t.toLowerCase().includes(q))
  );
}

export function formatStars(v) {
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + "k";
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  return String(v);
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
