/**
 * app.js —— 状态中枢：把数据、布局、渲染器、面板接起来。
 *
 * 状态变更路径永远是：改 state -> applyHighlight() -> 重绘 / 重渲染面板。
 * 过滤一律「淡化」而非「移除」，保证同一份数据在任意过滤下位置一致、可对比。
 */
import { loadMeshCached, prepare, matches, formatStars, groupColor } from "./mesh-data.js";
import { createStore } from "./cache.js";
import { startStats, formatCount } from "./stats.js";
import { createSectorLayout } from "./layout-sector.js";
import { PALETTES, themeOf, DEFAULT_PALETTE, DEFAULT_MODE } from "./palettes.js";
import { buildLinks, countByType } from "./links.js";
import { createGraphView } from "./graph.js";
import { renderRail, renderInspector, renderTooltip, renderEdgeTypeChips, starThreshold } from "./panels.js";

const dom = {
  rail: document.getElementById("rail"),
  inspector: document.getElementById("inspector"),
  snapshot: document.getElementById("snapshot"),
  loading: document.getElementById("loading"),
  tooltip: document.getElementById("tooltip"),
  hint: document.getElementById("hint"),
  edgeTypes: document.getElementById("edge-types"),
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
  theme: document.getElementById("theme"),
  palette: document.getElementById("palette"),
  deck: document.querySelector(".deck"),
  toggleRail: document.getElementById("toggle-rail"),
  toggleDossier: document.getElementById("toggle-dossier"),
  stats: document.getElementById("stats"),
  telemetry: document.getElementById("telemetry"),
  stage: document.getElementById("stage"),
  canvas: document.getElementById("graph"),
};

/** 圆心：官方仓库 */
const HUB_ID = "deepseek-ai/deepseek-harness";

const state = {
  palette: DEFAULT_PALETTE,
  mode: DEFAULT_MODE,
  avatars: true,
  labels: true,
  hideRail: false,
  hideDossier: false,
  groupBy: "category",
  tags: new Set(),
  minStarsPct: 0,
  minStars: 0,
  pushedDays: 0,
  language: "all",
  hideNoise: false,
  archived: "all",
  clusterFocus: null,
  focusCategory: null, // 单扇区放大：非空时只铺该分类，扇区变成它的细枝分类
  query: "",
  neighborFocus: null,
  selectedId: null,
  // 默认只开"标签"与"头像"：连线一律默认关闭，想看哪类关系自己点开
  edgeTypes: new Set(),
  seed: "mesh-v1",
  lastHit: null,
};

let prepared = null;
let layout = null;
let view = null;
let hoverNode = null;
let topLanguages = new Set();
let activeTheme = themeOf();
let links = [];

/** Top N 语言单独成方向，长尾合并为「其他语言」，避免方向过多 */
function pickTopLanguages(limit = 8) {
  const counts = new Map();
  for (const n of prepared.nodes) {
    if (!n.language || n.id === HUB_ID) continue;
    counts.set(n.language, (counts.get(n.language) ?? 0) + 1);
  }
  topLanguages = new Set(
    [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([k]) => k),
  );
}

/** 方向键：决定一个仓库落在哪个扇区（默认按功能分类，不按 GitHub 标签） */
function groupKeyOf(node) {
  if (state.groupBy === "language") {
    const lang = node.language ?? "未知";
    return topLanguages.has(lang) ? lang : "其他语言";
  }
  return node.category ?? "other";
}

function labelOfGroup(node, key) {
  return state.groupBy === "language" ? key : node.categoryLabel ?? key;
}

function computeGroups() {
  const map = new Map();
  for (const n of prepared.nodes) {
    if (n.id === HUB_ID) continue;
    const key = groupKeyOf(n);
    let g = map.get(key);
    if (!g) {
      g = { id: key, label: labelOfGroup(n, key), count: 0, topId: null, topStars: -1 };
      map.set(key, g);
    }
    g.count += 1;
    if (n.stars > g.topStars) {
      g.topStars = n.stars;
      g.topId = n.id;
    }
  }
  const palette = activeTheme.groups;
  return [...map.values()]
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
    .map((g, i) => ({ ...g, color: palette[i % palette.length] }));
}

/**
 * 布局缓存：从细枝切回全局时，不必把上万个节点重算一遍。
 * 实测这是「切回来卡一下」的根因 —— 全局布局的重排是全量计算，缓存后切换是瞬时的。
 */
const layoutCache = new Map();
const LAYOUT_CACHE_MAX = 6;

/** 缓存命中计数：给测试一个确定性判据，而不是靠掐时间 */
export const internalStats = { layoutBuilds: 0, layoutHits: 0 };

function layoutCacheKey() {
  return [state.seed, state.groupBy, state.focusCategory ?? "-"].join("|");
}

function clearLayoutCache() {
  layoutCache.clear();
}

function buildLayout() {
  const key = layoutCacheKey();
  const cached = layoutCache.get(key);
  if (cached) {
    internalStats.layoutHits += 1;
    return cached;
  }
  internalStats.layoutBuilds += 1;
  const built = buildLayoutUncached();
  if (layoutCache.size >= LAYOUT_CACHE_MAX) layoutCache.clear();
  layoutCache.set(key, built);
  return built;
}

function buildLayoutUncached() {
  const focus = state.focusCategory;
  if (focus) {
    // 单扇区放大：大扇区占满整个圆，扇区本身变成它的「细枝分类」
    const members = prepared.nodes.filter((n) => n.id === HUB_ID || groupKeyOf(n) === focus);
    return createSectorLayout({
      nodes: members,
      centerId: HUB_ID,
      groupOf: (n) => (n.id === HUB_ID ? "__hub" : n.subcategory ?? "misc-" + (n.category ?? "other")),
      labelOf: (n, key) => (n.id === HUB_ID ? "官方仓库" : n.subcategoryLabel ?? "未细分"),
      seed: state.seed + "|focus|" + focus,
    });
  }
  return createSectorLayout({
    nodes: prepared.nodes,
    centerId: HUB_ID,
    groupOf: groupKeyOf,
    labelOf: labelOfGroup,
    seed: state.seed,
  });
}

function refreshLinks() {
  links = buildLinks(prepared, layout);
  if (view) view.setLinks(links);
  return links;
}

function viewInfo() {
  const armOf = new Map();
  if (layout && layout.kind === "radial" && Array.isArray(layout.arms)) {
    for (const arm of layout.arms) {
      arm.members.forEach((m, idx) => armOf.set(m.id, { id: arm.id, label: arm.label, rank: idx + 1, count: arm.count }));
    }
  }
  const linkCounts = Object.fromEntries(
    [...new Set(["neighbor", "owner", "topic"])].map((type) => [type, countByType(links, type)]),
  );
  const arms = (layout?.arms ?? []).map((arm) => ({ id: arm.id, label: arm.label, count: arm.count }));
  return {
    groupBy: state.groupBy,
    hubId: HUB_ID,
    groups: computeGroups(),
    armOf,
    arms,
    focusCategory: state.focusCategory,
    focusLabel: state.focusCategory ? (computeGroups().find((g) => g.id === state.focusCategory)?.label ?? state.focusCategory) : null,
    tagColors: tagColorMap(),
    linkCounts,
  };
}

/** 分类 -> 颜色，保证节点、扇区、左栏列表三处配色一致 */
function groupColorMap() {
  const map = new Map();
  for (const g of computeGroups()) map.set(g.id, g.color);
  return map;
}

function tagColorMap() {
  const map = new Map();
  prepared.tags.forEach((t, i) => map.set(t.id, activeTheme.groups[i % activeTheme.groups.length]));
  return map;
}

/** 应用配色：JS 是唯一真源，直接写 CSS 变量并同步画布 */
function applyTheme() {
  activeTheme = themeOf(state.palette, state.mode);
  const root = document.documentElement;
  root.dataset.palette = activeTheme.palette;
  root.dataset.theme = activeTheme.mode;
  for (const [key, value] of Object.entries(activeTheme.vars)) root.style.setProperty(key, value);
  if (view) {
    view.setTheme(activeTheme);
    view.setGroupColors(groupColorMap());
  }
  if (dom.palette) dom.palette.textContent = activeTheme.label;
  if (dom.theme) dom.theme.textContent = activeTheme.mode === "light" ? "浅色" : "深色";
  try {
    localStorage.setItem("mesh-palette", state.palette);
    localStorage.setItem("mesh-theme", state.mode);
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

function resetView() {
  state.tags = new Set(prepared.tags.map((t) => t.id));
  state.minStarsPct = 0;
  state.minStars = 0;
  state.pushedDays = 0;
  state.language = "all";
  state.hideNoise = false;
  state.archived = "all";
  state.clusterFocus = null;
  state.query = "";
  state.neighborFocus = null;
  state.selectedId = null;
  state.edgeTypes = new Set();
}

function computeHighlight() {
  const now = Date.now();
  const neighborSet = state.neighborFocus
    ? new Set([state.neighborFocus, ...(prepared.adjacency.get(state.neighborFocus) ?? []).map((n) => n.id)])
    : null;
  const set = new Set();
  for (const n of prepared.nodes) {
    // 标签之间取"与"：仓库必须同时具备所有已开启的标签才高亮。
    // 用"或"会失效——标签高度重叠（多数仓库同时挂 dsh 与 dsh-plugin），关掉任何一个都几乎筛不掉东西。
    if (!n.matchedTags.every((t) => state.tags.has(t))) continue;
    if (state.minStars > 0 && n.stars < state.minStars) continue;
    if (state.pushedDays > 0) {
      const ts = n.pushedAt ? Date.parse(n.pushedAt) : 0;
      if (!ts || now - ts > state.pushedDays * 86400000) continue;
    }
    if (state.language !== "all" && n.language !== state.language) continue;
    if (state.hideNoise && n.review) continue;
    if (state.archived === "hide" && n.archived) continue;
    if (state.archived === "only" && !n.archived) continue;
    if (state.clusterFocus && groupKeyOf(n) !== state.clusterFocus) continue;
    if (neighborSet && !neighborSet.has(n.id)) continue;
    if (state.query && !matches(n, state.query)) continue;
    set.add(n.id);
  }
  state.lastHit = set.size;
  if (set.size === prepared.nodes.length) return null;
  return set;
}

function apply(options = {}) {
  const highlight = computeHighlight();
  view.setHighlight(highlight);
  view.setSelected(state.selectedId);
  updateStatus(highlight);
  const info = viewInfo();
  if (view) view.setSectorFocus(state.focusCategory ? null : state.clusterFocus);
  if (options.rail !== false) renderRail(dom.rail, prepared, state, actions, info);
  if (options.inspector !== false) renderInspector(dom.inspector, prepared, state, actions, info);
  if (options.edgeChips !== false) renderEdgeTypeChips(dom.edgeTypes, prepared, state, actions, info);
}

function updateStatus(highlight) {
  const hit = highlight ? highlight.size : prepared.nodes.length;
  const arms = layout && Array.isArray(layout.arms) ? layout.arms.length : 0;
  const by = state.groupBy === "language" ? "语言" : "功能分类";
  const head = "圆心：" + HUB_ID + " · 共 " + arms + " 个扇区，每个 " + (arms ? (360 / arms).toFixed(1) : "0") + "°，按" + by + "划分";
  dom.hint.textContent = head + " · 当前命中 " + hit + " / " + prepared.nodes.length + " 个仓库";
  dom.hint.title = "滚轮缩放 · 拖拽平移 · 单击选中 · 双击聚焦其关联仓库";
}

function rebuildLayout() {
  layout = buildLayout();
  view.setData(prepared, layout);
  refreshLinks();
  view.setGroupColors(groupColorMap());
  view.setEdgeTypes(state.edgeTypes);
  apply();
}

const actions = {
  toggleTag(id) {
    if (state.tags.has(id)) state.tags.delete(id);
    else state.tags.add(id);
    apply();
  },
  setMinStarsPct(pct) {
    state.minStarsPct = pct;
    state.minStars = starThreshold(pct, prepared.maxStars);
    apply({ rail: false, inspector: false, edgeChips: false });
    const label = dom.rail.querySelector(".field b");
    if (label) label.textContent = state.minStars > 0 ? "★ ≥ " + formatStars(state.minStars) : "不限";
  },
  setPushedDays(days) {
    state.pushedDays = days;
    apply();
  },
  setLanguage(lang) {
    state.language = lang;
    apply();
  },
  setHideNoise(on) {
    state.hideNoise = on;
    apply();
  },
  setArchived(mode) {
    state.archived = mode;
    apply();
  },
  focusGroup(id) {
    state.clusterFocus = id ?? null;
    // 只在「按功能分类」时放大：选中的分类铺满整圆，细枝成为新扇区
    state.focusCategory = id && state.groupBy === "category" ? id : null;
    layout = buildLayout();
    refreshLinks();
    if (view) {
      view.setData(prepared, layout);
      view.setSectorFocus(null); // 放大模式下圆里全是该扇区，不需要淡化别的
      view.fit();
    }
    apply();
  },
  /** 放大模式下点细枝：只做高亮淡化，不换布局 */
  focusArm(id) {
    state.clusterFocus = id ?? null;
    apply({ inspector: false });
  },
  setGroupBy(kind) {
    if (state.groupBy === kind) return;
    state.groupBy = kind;
    state.clusterFocus = null;
    state.focusCategory = null;
    state.hubId = HUB_ID;
    state.seed = "mesh-" + Date.now();
    rebuildLayout();
  },
  focusNeighbors(id) {
    state.neighborFocus = id;
    apply();
  },
  centerOn(id) {
    view.focusNode(id);
  },
  selectRepo(id) {
    state.selectedId = id;
    if (id) revealDossier(); // 点项目 → 自动展开右栏（详情在里面）
    view.setSelected(id);
    apply({ rail: false, edgeChips: false });
  },
  toggleEdgeType(type) {
    if (state.edgeTypes.has(type)) state.edgeTypes.delete(type);
    else state.edgeTypes.add(type);
    view.setEdgeTypes(state.edgeTypes);
    renderEdgeTypeChips(dom.edgeTypes, prepared, state, actions, viewInfo());
  },
};

function runSearch() {
  const q = dom.search.value.trim();
  state.query = q;
  dom.searchClear.hidden = !q;
  apply({ inspector: false, edgeChips: false });
}

function firstMatch() {
  const q = dom.search.value.trim();
  if (!q) return null;
  let best = null;
  for (const n of prepared.nodes) {
    if (!matches(n, q)) continue;
    if (!best || n.stars > best.stars) best = n;
  }
  return best;
}

const NARROW_QUERY = "(max-width: 900px)";
function isNarrow() {
  return !!window.matchMedia?.(NARROW_QUERY)?.matches;
}

/** 手机端左右两栏是同一块抽屉区域，必须互斥：同时只留一个 */
function exclusivePanels() {
  if (isNarrow() && !state.hideRail && !state.hideDossier) state.hideDossier = true;
}

/** 选中某个仓库时自动把右栏拉出来（手机上顺带收起左栏） */
function revealDossier() {
  if (!state.hideDossier) return;
  state.hideDossier = false;
  exclusivePanels();
  applyPanels();
}

/** 侧栏收起/展开：改栅格列宽 + 记进 localStorage */
function applyPanels() {
  exclusivePanels();
  if (dom.deck) {
    dom.deck.classList.toggle("hide-rail", state.hideRail);
    dom.deck.classList.toggle("hide-dossier", state.hideDossier);
  }
  if (dom.toggleRail) dom.toggleRail.classList.toggle("on", state.hideRail);
  if (dom.toggleDossier) dom.toggleDossier.classList.toggle("on", state.hideDossier);
  try {
    localStorage.setItem("mesh-panels", JSON.stringify({ rail: state.hideRail, dossier: state.hideDossier }));
  } catch {
    /* 忽略 */
  }
  if (view) view.invalidate(); // 画布尺寸变了，立刻重绘
}

function bindChrome() {
  if (dom.toggleRail)
    dom.toggleRail.addEventListener("click", () => {
      state.hideRail = !state.hideRail;
      if (!state.hideRail) state.hideDossier = true; // 开左栏就收右栏（手机上两者是同一块区域）
      applyPanels();
    });
  if (dom.toggleDossier)
    dom.toggleDossier.addEventListener("click", () => {
      state.hideDossier = !state.hideDossier;
      if (!state.hideDossier) state.hideRail = true;
      applyPanels();
    });
  dom.search.addEventListener("input", runSearch);
  dom.search.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const hit = firstMatch();
    if (!hit) return;
    actions.selectRepo(hit.id);
    view.focusNode(hit.id);
  });
  dom.searchClear.addEventListener("click", () => {
    dom.search.value = "";
    runSearch();
  });

  document.querySelectorAll(".hud-tl button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "zoom-in") view.zoomBy(1.25);
      else if (act === "zoom-out") view.zoomBy(0.8);
      else if (act === "fit") view.fit();
      else if (act === "relayout") {
        state.seed = "mesh-" + Date.now();
        layout.reseed(state.seed);
        refreshLinks(); // 位置变了，近邻连线必须重算
        view.fit();
        view.invalidate();
        apply({ rail: false, inspector: false });
      } else if (act === "labels") {
        state.labels = !view.labels;
        view.setLabels(state.labels);
        btn.classList.toggle("on", state.labels);
      } else if (act === "avatars") {
        state.avatars = !view.avatars;
        view.setAvatars(state.avatars);
        btn.classList.toggle("on", state.avatars);
      }
    });
  });

  dom.theme.addEventListener("click", () => {
    state.mode = state.mode === "light" ? "dark" : "light";
    applyTheme();
  });
  if (dom.palette) {
    dom.palette.addEventListener("click", () => {
      const ids = Object.keys(PALETTES);
      state.palette = ids[(ids.indexOf(state.palette) + 1) % ids.length];
      applyTheme();
    });
  }

  window.addEventListener("keydown", (ev) => {
    const typing = ev.target && ev.target.tagName === "INPUT";
    if (!typing && ev.key === "[") { state.hideRail = !state.hideRail; applyPanels(); return; }
    if (!typing && ev.key === "]") { state.hideDossier = !state.hideDossier; applyPanels(); return; }
    if (ev.key === "Escape") {
      // 有放大就先退回全局，其次才清选中
      if (state.focusCategory) {
        actions.focusGroup(null);
        return;
      }
      state.selectedId = null;
      state.neighborFocus = null;
      view.setSelected(null);
      apply();
    }
  });
}

let booted = false;

/** 用一份数据把界面搭起来；后台校验拿到新数据时用 resetFilters=false 再跑一次 */
function bootMesh(mesh, { resetFilters }) {
  prepared = prepare(mesh);
  if (resetFilters || state.tags.size === 0) resetView();
  pickTopLanguages();
  clearLayoutCache(); // 数据换了，旧布局不能复用
  layout = buildLayout();

  if (!view) {
    view = createActiveView();
    bindChrome();
  }
  syncView();
  dom.loading.hidden = true;
  dom.snapshot.textContent = String(prepared.meta.generatedAt ?? "").slice(0, 10) + " · 抽样";
  if (dom.telemetry) dom.telemetry.textContent = "缩放 " + view.view.k.toFixed(2);
  dom.hint.title = "圆心固定为 " + HUB_ID;

  if (!booted) {
    const jump = new URLSearchParams(location.search).get("repo");
    if (jump && prepared.byId.has(jump)) {
      state.selectedId = jump;
      view.setSelected?.(jump);
      view.focusNode?.(jump);
    }
    booted = true;
  } else if (state.selectedId && !prepared.byId.has(state.selectedId)) {
    state.selectedId = null;
  }
  apply();
}

/** 建视图（v0.4 起只有扇区图；星云模式因屏闪问题已移除） */
function createActiveView() {
  return createGraphView(dom.canvas, viewHooks());
}

/** 把当前数据、主题、开关一次性推给视图（首屏与切模式共用） */
function syncView() {
  view.setData(prepared, layout);
  refreshLinks();
  view.setEdgeTypes(state.edgeTypes);
  view.setAvatars(state.avatars);
  view.setLabels(state.labels);
  applyTheme();
  apply();
}

function viewHooks() {
  return {
    onSelect: (node) => {
      // 走统一的选中入口：点画布上的球同样会自动展开右栏
      actions.selectRepo(node ? node.id : null);
    },
    onHover: (node, pos) => {
      hoverNode = node;
      const rect = dom.stage.getBoundingClientRect();
      renderTooltip(dom.tooltip, node, pos ?? { x: 0, y: 0 }, rect);
    },
    onHoverMove: (pos) => {
      if (dom.tooltip.hidden || !hoverNode) return;
      renderTooltip(dom.tooltip, hoverNode, pos, dom.stage.getBoundingClientRect());
    },
    onFocus: (id) => {
      actions.focusNeighbors(id);
      actions.selectRepo(id);
    },
    onViewChange: ({ k }) => {
      if (dom.telemetry) dom.telemetry.textContent = "缩放 " + k.toFixed(2);
    },
  };
}

async function main() {
  const saved = (() => {
    try {
      return { palette: localStorage.getItem("mesh-palette"), mode: localStorage.getItem("mesh-theme") };
    } catch {
      return { palette: null, mode: null };
    }
  })();
  if (saved.palette && PALETTES[saved.palette]) state.palette = saved.palette;
  if (saved.mode === "dark" || saved.mode === "light") state.mode = saved.mode;
  try {
    const saved = localStorage.getItem("mesh-panels");
    if (saved) {
      const panels = JSON.parse(saved);
      state.hideRail = !!panels.rail;
      state.hideDossier = !!panels.dossier;
    } else if (window.matchMedia?.("(max-width: 900px)").matches) {
      state.hideRail = true; // 手机首屏：画布全屏，侧栏收进抽屉
      state.hideDossier = true;
    }
  } catch {
    /* 忽略 */
  }
  applyPanels();
  const narrow = window.matchMedia?.("(max-width: 900px)");
  narrow?.addEventListener?.("change", (ev) => {
    if (ev.matches && !state.hideRail && !state.hideDossier) {
      state.hideRail = true;
      state.hideDossier = true;
      applyPanels();
    }
  });

  // 访问数 / 同时在线：拿不到就整栏隐藏，绝不影响站点
  startStats({
    onUpdate: (data) => {
      if (!dom.stats) return;
      dom.stats.hidden = false;
      dom.stats.textContent = "访问 " + formatCount(data.visits) + " · 在线 " + formatCount(data.online);
    },
    onUnavailable: () => {
      if (dom.stats) dom.stats.hidden = true;
    },
  });

  // 先吃缓存秒开，再带 ETag 后台校验；数据真的变了才重建
  const store = await createStore();
  const { mesh, fromCache, revalidate } = await loadMeshCached("./data/mesh.json", { store });
  bootMesh(mesh, { resetFilters: true });
  if (fromCache) dom.hint.title = "已用本地缓存渲染，正在后台校验是否有新快照…";

  // 在线实时更新：数据每次核对都带 ETag，没变就是 304（几乎零成本），变了才重建
  let liveGeneration = mesh.meta?.generatedAt ?? null;
  let refreshing = false;
  const pullFresh = async (why) => {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await revalidate();
      if (fresh && (fresh.meta?.generatedAt ?? null) !== liveGeneration) {
        liveGeneration = fresh.meta?.generatedAt ?? null;
        bootMesh(fresh, { resetFilters: false });
        dom.hint.title = "已同步到最新快照（" + String(liveGeneration ?? "").slice(11, 16) + " UTC）";
      } else if (why === "boot" && fromCache) {
        dom.hint.title = "缓存已是最新（" + String(liveGeneration ?? "").slice(11, 16) + " UTC 快照）";
      }
    } catch (err) {
      console.warn("后台校验失败，继续使用缓存数据：", err);
    } finally {
      refreshing = false;
    }
  };

  await pullFresh("boot");
  // 数据每小时更新一次，这里每 5 分钟核对一次；标签页在后台时不打扰
  const liveTimer = setInterval(() => {
    if (!document.hidden) pullFresh("timer");
  }, 5 * 60 * 1000);
  liveTimer?.unref?.(); // Node（测试环境）里别让定时器拖住事件循环
  document.addEventListener?.("visibilitychange", () => {
    if (!document.hidden) pullFresh("visible");
  });
}

main().catch((err) => {
  dom.loading.hidden = false;
  dom.loading.textContent = "载入失败：" + err.message + "（请通过 http 服务打开，不要直接双击 index.html）";
  console.error(err);
});