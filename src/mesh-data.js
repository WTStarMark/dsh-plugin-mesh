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
  // 选中时画的三类连线：颜色明显区分（同作者=主题主色，主题共现=琥珀，生态共鸣=紫罗兰）
  owner: { label: "同作者", color: null, alpha: 0.85, curv: 0.16, dash: [] },
  topic: { label: "主题共现", color: "#e08a00", alpha: 0.5, curv: 0.22, dash: [5, 4] },
  // 生态共鸣：人工策展的"谁长在谁上面"（基座 → 生态），与规则推导的边区分开
  resonance: { label: "生态共鸣", color: "#a86bff", alpha: 0.75, curv: 0.2, dash: [] },
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

/** 预计算契约里的连线类型编码（新增类型只能往后追加，老数据才不会错位） */
export const EDGE_TYPE_BY_CODE = ["owner", "topic", "fork", "neighbor", "resonance"];

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
  const noise = nodes.filter(isConfirmedNoise).sort((a, b) => b.stars - a.stars);
  const ownerIndex = indexByOwner(nodes);
  return {
    mesh: core,
    noise,
    core: true,
    nodes,
    edges: triples,
    links,
    byId,
    adjacency,
    ownerIndex,
    ownerPairs: countOwnerPairs(ownerIndex),
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

/**
 * 作者索引：owner -> 该作者的全部仓库 id（星标降序）。
 *
 * 为什么需要单独建索引：数据层为了控制载荷，同一作者成员超过 OWNER_CLIQUE_MAX 时
 * 只存"星形拓扑"（枢纽连所有人、其余人只连枢纽）。只看存下来的边就会出现
 * 「几个同作者仓库里，有的能指到其余全部、有的只指到一个」。这里按 owner 还原
 * 完整关系，渲染与面板一律以它为准 —— 不论几个同作者仓库，彼此都能指到。
 */
function indexByOwner(nodes) {
  const groups = new Map();
  for (const n of nodes) {
    if (!n.owner) continue;
    const list = groups.get(n.owner);
    if (list) list.push(n);
    else groups.set(n.owner, [n]);
  }
  const index = new Map();
  for (const [owner, list] of groups) {
    list.sort((a, b) => (b.stars || 0) - (a.stars || 0) || (a.id < b.id ? -1 : 1));
    index.set(owner, list.map((n) => n.id));
  }
  return index;
}

/** 完整同作者关系对数（每个作者 C(n,2) 累加）：图例与统计用，不含星形拓扑的省略 */
function countOwnerPairs(ownerIndex) {
  let pairs = 0;
  for (const list of ownerIndex.values()) pairs += (list.length * (list.length - 1)) / 2;
  return pairs;
}

const EMPTY_IDS = [];

/** 噪声作者阈值：与后端 backend/dsh_mesh/config.py 保持一致（两边都拦一道） */
export const NOISE_OWNER_MIN_REPOS = 300; // 主判据：仓库数（超过）
export const NOISE_OWNER_ZERO_RATIO = 0.98; // 主判据：0 星占比（超过）
export const NOISE_OWNER_STRICT_MIN_REPOS = 200; // 老判据：仓库数（超过）
export const NOISE_OWNER_MAX_STARS = 1; // 老判据：最高星标（低于）

/**
 * 噪声作者：批量刷标签的垃圾号。两条判据命中任一 ——
 *   1) 收录仓库数 > minRepos，且 0 星占比 > zeroRatio（默认 300 / 98%）
 *   2) 收录仓库数 > strictMinRepos，且每个仓库都是 0 星（默认 200，老判据保留）
 * 判定结果带 zeroRatio 与 reason，前端可显示"为什么被判"。
 */
export function noiseOwners(nodes, options = {}) {
  const minRepos = options.minRepos ?? NOISE_OWNER_MIN_REPOS;
  const zeroRatio = options.zeroRatio ?? NOISE_OWNER_ZERO_RATIO;
  const strictMinRepos = options.strictMinRepos ?? NOISE_OWNER_STRICT_MIN_REPOS;
  const maxStars = options.maxStars ?? NOISE_OWNER_MAX_STARS;
  const groups = new Map();
  for (const n of nodes ?? []) {
    if (!n.owner) continue;
    let group = groups.get(n.owner);
    if (!group) groups.set(n.owner, (group = { repos: 0, zeroStars: 0, maxStars: 0 }));
    group.repos += 1;
    const stars = n.stars || 0;
    if (stars === 0) group.zeroStars += 1;
    group.maxStars = Math.max(group.maxStars, stars);
  }
  const noise = new Map();
  for (const [owner, group] of groups) {
    group.zeroRatio = group.repos ? group.zeroStars / group.repos : 0;
    if (group.repos > minRepos && group.zeroRatio > zeroRatio) {
      group.reason = "mass-publish";
      noise.set(owner, group);
    } else if (group.repos > strictMinRepos && group.maxStars < maxStars) {
      group.reason = "all-zero-stars";
      noise.set(owner, group);
    }
  }
  return noise;
}

/**
 * 把噪声作者从一份数据里剔除（两种契约都支持）：
 *   mesh.json      —— edges 是 {source,target,type}，按 id 过滤即可
 *   mesh-core.json —— edges 是 [索引,索引,类型码]，删了节点必须重排索引
 * 没有噪声作者时原样返回（零成本，正常路径不受影响）。
 *
 * 采集管道已经会剔除它们；这里再拦一道，是为了让**已经写出去的旧快照**也不再展示。
 */
export function stripNoiseOwners(mesh) {
  const nodes = mesh?.nodes ?? [];
  const noise = noiseOwners(nodes);
  if (noise.size === 0) return mesh;

  const keep = [];
  const remap = new Map(); // 旧下标 -> 新下标
  const droppedIds = new Set();
  for (let i = 0; i < nodes.length; i++) {
    if (noise.has(nodes[i].owner)) {
      droppedIds.add(nodes[i].id);
      continue;
    }
    remap.set(i, keep.length);
    keep.push(nodes[i]);
  }

  const indexed = Array.isArray(mesh.edges?.[0]);
  const edges = [];
  for (const e of mesh.edges ?? []) {
    if (indexed) {
      const a = remap.get(e[0]);
      const b = remap.get(e[1]);
      if (a === undefined || b === undefined) continue;
      edges.push([a, b, e[2]]);
    } else if (!droppedIds.has(e.source) && !droppedIds.has(e.target)) {
      edges.push(e);
    }
  }

  // 预计算契约里的扇区成员是节点索引，必须跟着重排；否则面板会指到别人的球上
  const arms = Array.isArray(mesh.arms)
    ? mesh.arms
        .map((arm) => {
          if (!Array.isArray(arm.members)) return arm;
          const members = [];
          for (const i of arm.members) {
            const mapped = remap.get(i);
            if (mapped !== undefined) members.push(mapped);
          }
          return { ...arm, members, count: members.length };
        })
        .filter((arm) => !Array.isArray(arm.members) || arm.members.length > 0)
    : null;

  const clusterCounts = new Map();
  for (const n of keep) clusterCounts.set(n.category, (clusterCounts.get(n.category) ?? 0) + 1);
  const clusters = Array.isArray(mesh.clusters)
    ? mesh.clusters
        .map((c) => ({ ...c, count: clusterCounts.get(c.id) ?? 0 }))
        .filter((c) => c.count > 0)
    : null;

  const removed = nodes.length - keep.length;
  const meta = { ...(mesh.meta ?? {}) };
  meta.sampleNodes = keep.length;
  meta.sampleEdges = edges.length;
  if (typeof meta.indexedNodes === "number") meta.indexedNodes = Math.max(keep.length, meta.indexedNodes - removed);
  // 分类统计也必须跟着剔除走：否则 meta.categories 还写着旧总数，
  // 与 indexedNodes / nodes 对不上（数据自洽性回归测试会当场抓到）。
  if (meta.categories && typeof meta.categories === "object") {
    const counts = new Map();
    for (const n of keep) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
    const labels = new Map((meta.categories.distribution ?? []).map((d) => [d.id, d.label]));
    meta.categories = {
      ...meta.categories,
      classified: keep.reduce((sum, n) => sum + (n.category === "other" ? 0 : 1), 0),
      unclassified: counts.get("other") ?? 0,
      distribution: [...counts.entries()]
        .map(([id, count]) => ({ id, label: labels.get(id) ?? id, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
  meta.noiseBlacklist = Object.fromEntries(
    [...noise].map(([owner, g]) => [owner, { repos: g.repos, zeroRatio: g.zeroRatio, maxStars: g.maxStars, reason: g.reason }]),
  );
  meta.noiseBlacklistSize = noise.size;
  meta.noiseNodesRemoved = removed;

  const out = { ...mesh, nodes: keep, edges, meta };
  if (arms) out.arms = arms;
  if (clusters) out.clusters = clusters;
  return out;
}

/**
 * 同作者兄弟：与 id 同一个作者（owner）的其它仓库，按星标降序。
 * 这是"完整"的同作者关系，不从存下来的边推导；没有伙伴时返回空数组。
 */
export function ownerSiblings(prepared, id) {
  if (!prepared?.byId || !prepared.ownerIndex) return EMPTY_IDS;
  const node = prepared.byId.get(id);
  const group = node ? prepared.ownerIndex.get(node.owner) : null;
  if (!group || group.length < 2) return EMPTY_IDS;
  const out = [];
  for (const other of group) if (other !== id) out.push(other);
  return out;
}

/** 星标分位阈值：给「最少星标」滑块用（纯函数，放数据层免得为了它加载整个面板模块） */
export function starThreshold(pct, maxStars) {
  return Math.round(maxStars * Math.pow(pct / 100, 3));
}

export function prepare(mesh) {
  mesh = stripNoiseOwners(mesh); // 噪声作者不展示（旧快照兜底，正常数据是空操作）
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
  const noise = nodes.filter(isConfirmedNoise).sort((a, b) => b.stars - a.stars);
  const ownerIndex = indexByOwner(nodes);

  return {
    mesh,
    noise,
    nodes,
    edges,
    byId,
    adjacency,
    ownerIndex,
    ownerPairs: countOwnerPairs(ownerIndex),
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

/**
 * 是否"确认噪声"：采集器给出的三档结论里的 noise 档
 * （名字/描述/主题都没有 DSH 专有线索，且空壳、堆标签或只挂最宽泛的 dsh 标签）。
 * 老数据（没有 verdict 字段）退回到"相关度 0 且在待复核里"，其余仍按待复核处理。
 */
export function isConfirmedNoise(node) {
  if (!node) return false;
  if (node.verdict) return node.verdict === "noise";
  return !!node.review && !(node.relevance > 0);
}

/**
 * 搜索命中的"最多画多少条放射线"（v0.4.6）。
 * 命中一多（比如搜 "dsh" 命中上万），每帧要建上万条路径 + 描边，浏览器直接卡死；
 * 超过这个数就只做高亮、不画放射线，并在状态栏说明原因。
 */
export const RAY_HIT_LIMIT = 100;

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
