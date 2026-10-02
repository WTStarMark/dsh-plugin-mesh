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
  neighbor: { label: "同扇区近邻", color: null, alpha: 0.3, curv: 0.05, dash: [] },
  owner: { label: "同作者", color: "#7f8ea6", alpha: 0.34, curv: 0.16, dash: [4, 4] },
  topic: { label: "主题共现", color: "#9aa8bb", alpha: 0.15, curv: 0.22, dash: [] },
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

/** 把原始契约整理成渲染/交互所需的索引结构 */
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
