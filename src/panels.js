/**
 * 面板层：左栏（总览 / 划分依据 / 捕获标签 / 筛选 / 功能扇区 / 高频标签）、
 * 右栏（仓库档案 / 命中标签 / 仓库主题 / 关联）、悬浮提示、连线开关。
 * 界面文案一律使用规范中文；专有名词（GitHub、DSH、仓库 id）保持原样。
 */
import { colorOfTag, countReposByOwner, starPercentile, starThreshold, EDGE_STYLES, formatStars, formatDate, ownerSiblings, isConfirmedNoise, NOISE_OWNER_MIN_REPOS, NOISE_OWNER_MAX_STARS } from "./mesh-data.js";

const EDGE_ORDER = ["neighbor", "owner", "topic", "resonance", "fork"];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "on") {
      for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  appendAll(node, children);
  return node;
}

/** 递归拍平子节点：嵌套数组若只拍一层，会被 String() 成 "[object ...]" */
function appendAll(node, children) {
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendAll(node, child);
      continue;
    }
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

/** 分区：一条发丝线 + 中文小标题 */
function sec(title, children) {
  return el("section", { class: "sec" }, [el("h3", { class: "sec-h", text: title }), ...[].concat(children)]);
}

/** 过滤项：标签在上、控件独占一行，侧栏再窄也不会溢出 */
function field(label, control, value) {
  return el("div", { class: "field" }, [el("label", { text: label }), el("div", { class: "ctl" }, [control, value ?? null])]);
}

export { starThreshold } from "./mesh-data.js";

export function reviewReason(node) {
  const desc = (node.description ?? "").toLowerCase();
  const family = (node.matchedTags ?? []).length;
  if (!/dsh|deepseek|harness|cordis|plugin/.test(desc)) return "项目描述中没有任何 DSH／Harness／插件相关线索";
  if (family <= 1 && !/dsh|deepseek/i.test(node.name)) return "仅命中一个捕获标签，且仓库名不含 DSH";
  return "相关度评分偏低，建议人工确认";
}

function starText(value) {
  return value > 0 ? "≥ " + formatStars(value) : "不限";
}

export function renderRail(root, prepared, state, actions, view = {}) {
  const { meta, nodes, edges, owners, review, tags, hubs } = prepared;
  const confirmed = prepared.noise ?? [];
  const hit = state.lastHit ?? null;
  const groups = view.groups ?? prepared.clusters;
  const hubId = view.hubId ?? "—";
  const byCategory = view.groupBy !== "language";
  const tagColor = (id) => view.tagColors?.get(id) ?? colorOfTag(id);

  const stat = (value, label, cls) =>
    el("div", { class: "stat" + (cls ? " " + cls : "") }, [el("b", { text: String(value) }), el("span", { text: label })]);

  const tagRows = tags.map((tag) => {
    const on = state.tags.has(tag.id);
    return el(
      "div",
      {
        class: "tag-row" + (on ? "" : " off"),
        title: "点击" + (on ? "隐藏" : "显示") + "该标签",
        on: { click: () => actions.toggleTag(tag.id) },
      },
      [
        el("span", { class: "dot", style: { background: tagColor(tag.id) } }),
        el("span", { class: "name", text: tag.id }),
        el("span", { class: "num", text: String(tag.sampleCount) + (tag.apiTotal ? " / " + tag.apiTotal : "") }),
      ],
    );
  });

  // 滑块位置与数值框双向同步：有绝对星标时按逆映射定位，否则用分位
  const pct = state.minStars > 0 ? starPercentile(state.minStars, prepared.maxStars) : state.minStarsPct ?? 0;
  const slider = el("input", {
    type: "range",
    min: "0",
    max: "100",
    step: "1",
    value: String(pct),
    on: {
      input: (ev) => {
        const pct = Number(ev.target.value);
        ev.target.style?.setProperty?.("--fill", pct + "%");
        actions.setMinStarsPct(pct);
        // 回写数值框：滑块拖到哪，数值框就显示对应星标（双向同步）
        if (starNum) starNum.value = String(starThreshold(pct, prepared.maxStars));
      },
    },
  });
  slider.style.setProperty("--fill", pct + "%");
  // 星标下限也可以直接输入数值（滑块按分位，输入框按绝对值）
  const starNum = el("input", {
    type: "number",
    class: "num-in",
    min: "0",
    step: "1",
    value: String(state.minStars ?? 0),
    title: "星标下限：直接输入数值",
    on: { change: (ev) => actions.setMinStars(Math.max(0, Number(ev.target.value) || 0)) },
  });

  const languageCounts = new Map();
  for (const n of nodes) if (n.language) languageCounts.set(n.language, (languageCounts.get(n.language) ?? 0) + 1);
  const languageSelect = el(
    "select",
    { on: { change: (ev) => actions.setLanguage(ev.target.value) } },
    [el("option", { value: "all", text: "全部语言" })].concat(
      [...languageCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([lang, count]) => el("option", { value: lang, text: lang + "（" + count + " 个）", selected: state.language === lang })),
    ),
  );

  const pushedSelect = el("select", { on: { change: (ev) => actions.setPushedDays(Number(ev.target.value)) } }, [
    el("option", { value: "0", text: "不限" }),
    el("option", { value: "30", text: "最近 30 天", selected: state.pushedDays === 30 }),
    el("option", { value: "90", text: "最近 90 天", selected: state.pushedDays === 90 }),
    el("option", { value: "180", text: "最近半年", selected: state.pushedDays === 180 }),
    el("option", { value: "365", text: "最近一年", selected: state.pushedDays === 365 }),
  ]);

  const archivedSelect = el("select", { on: { change: (ev) => actions.setArchived(ev.target.value) } }, [
    el("option", { value: "all", text: "全部" }),
    el("option", { value: "hide", text: "排除已归档", selected: state.archived === "hide" }),
    el("option", { value: "only", text: "仅看已归档", selected: state.archived === "only" }),
  ]);

  // 单扇区放大时：扇区行改为列「细枝分类」
  const subRows = (view.arms ?? []).map((arm) =>
    el(
      "div",
      {
        class: "sector-row" + (state.clusterFocus === arm.id ? " active" : ""),
        on: { click: () => actions.focusArm(state.clusterFocus === arm.id ? null : arm.id) },
      },
      [
        el("span", { class: "bar", style: { background: colorOfTag(arm.id) } }),
        el("span", { class: "name", text: arm.label ?? arm.id }),
        el("span", { class: "num", text: String(arm.count) }),
      ],
    ),
  );
  const focusBanner = view.focusCategory
    ? el("div", { class: "focus-banner" }, [
        el("div", { class: "fb-text", text: "单扇区放大：" + (view.focusLabel ?? view.focusCategory) }),
        el("button", { class: "key", text: "← 返回全局", on: { click: () => actions.focusGroup(null) } }),
      ])
    : null;

  const groupRows = groups.map((g) =>
    el(
      "div",
      {
        class: "sector-row" + (state.clusterFocus === g.id ? " active" : ""),
        title: g.topId ? "最靠近圆心：" + g.topId + "（星标 " + formatStars(g.topStars ?? 0) + "）" : "",
        on: { click: () => actions.focusGroup(state.clusterFocus === g.id ? null : g.id) },
      },
      [
        el("span", { class: "bar", style: { background: g.color ?? colorOfTag(g.id) } }),
        el("span", { class: "name", text: g.label ?? g.id }),
        el("span", { class: "num", text: String(g.count) }),
      ],
    ),
  );

  const overviewSec = sec("总览", [
      el("div", { class: "readout-grid" }, [
        stat(nodes.length, "仓库数", "hot"),
        stat(edges.length, "关系对数"),
        stat(owners.size, "作者数"),
        stat(review.length, "待复核", "warn"),
      ]),
      el("div", {
        class: "note",
        text: meta.note ?? (meta.kind === "sample-seed" ? "当前为抽样数据（每个标签按星标取前若干页），并非全量索引。" : "数据来源：" + (meta.source ?? "未知")),
      }),
      hit !== null ? el("div", { class: "note", text: "当前筛选命中 " + hit + " / " + nodes.length + " 个仓库" }) : null,
      el("div", {
        class: "note",
        text:
          "相关性判定：已确认相关 " + Math.max(0, nodes.length - review.length - confirmed.length)
          + " · 确认噪声 " + confirmed.length + "（可一键隐藏）· 仍需人工复核 " + review.length + "。",
      }),
      (meta.noiseBlacklistSize ?? 0) > 0
        ? el("div", {
            class: "note",
            text:
              "噪声黑名单：" + meta.noiseBlacklistSize + " 个作者（" + (meta.noiseNodesRemoved ?? 0)
              + " 个仓库）已被剔除，不再展示 —— 判据是同一作者收录超过 " + NOISE_OWNER_MIN_REPOS + " 个仓库且每个仓库星标都低于 " + NOISE_OWNER_MAX_STARS + "。",
          })
        : null,
    ]);
  const basisSec = sec("扇区划分依据", [
      field(
        "划分依据",
        el("select", { on: { change: (ev) => actions.setGroupBy(ev.target.value) } }, [
          el("option", { value: "category", text: "功能分类（按规则判定）", selected: byCategory }),
          el("option", { value: "language", text: "语言（前 8 种 + 其他）", selected: !byCategory }),
        ]),
      ),
      el("div", {
        class: "note",
        text: "圆心固定为官方仓库 " + hubId + "。每个分类对应一束柔和的光，方向之间等角分布；扇区内离散随机散布，星标越多整体越靠近圆心。",
      }),
    ]);
  const tagsSec = sec("捕获标签", [
      tagRows,
      el("div", { class: "note", text: "仓库需同时具备所有已开启的标签才会高亮；关掉某个标签即可筛掉带它的仓库。" }),
    ]);
  // 作者仓库数区间：一条双滑块（上下限都能拖，也能直接输入数值）
  const ownerCounts = countReposByOwner(prepared.nodes);
  // 轴上限固定 300：定位批量发布的作者，300 以上都归到轴顶（= 不限上限）
  const AXIS_MAX = 300;
  const maxOwnerRepos = AXIS_MAX;
  const ownerMin = Math.max(0, state.ownerRepoMin ?? 0);
  const ownerMax = state.ownerRepoMax === null || state.ownerRepoMax === undefined ? maxOwnerRepos : state.ownerRepoMax;
  const ownerLo = el("input", {
    type: "range",
    class: "dual-lo",
    min: "0",
    max: String(maxOwnerRepos),
    step: "1",
    value: String(Math.min(ownerMin, ownerMax)),
    title: "仓库数下限（拖这条或直接输入）",
    on: { input: (ev) => commitAxis(Number(ev.target.value), Number(ownerHi.value), "lo") },
  });
  const ownerHi = el("input", {
    type: "range",
    class: "dual-hi",
    min: "0",
    max: String(maxOwnerRepos),
    step: "1",
    value: String(Math.max(ownerMin, ownerMax)),
    title: "仓库数上限（拖这条或直接输入）",
    on: { input: (ev) => commitAxis(Number(ownerLo.value), Number(ev.target.value), "hi") },
  });
  const drFill = el("span", { class: "dr-fill" });
  const pctOf = (v) => (maxOwnerRepos > 0 ? Math.round((v / maxOwnerRepos) * 100) : 0);
  const ownerLoNum = el("input", { type: "number", class: "num-in", min: "0", max: String(maxOwnerRepos), step: "1" });
  const ownerHiNum = el("input", { type: "number", class: "num-in", min: "0", max: String(maxOwnerRepos), step: "1" });
  // 轴与两个数值框实时双向同步：拖轴改数值框，改数值框改轴
  const syncAxis = () => {
    const a = Number(ownerLo.value);
    const b = Number(ownerHi.value);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    drFill.style.left = pctOf(lo) + "%";
    drFill.style.right = 100 - pctOf(hi) + "%";
    ownerLoNum.value = String(lo);
    ownerHiNum.value = String(hi);
  };
  const commitAxis = (lo, hi, from) => {
    if (from !== "lo") ownerLo.value = String(Math.max(0, Math.min(maxOwnerRepos, lo)));
    if (from !== "hi") ownerHi.value = String(Math.max(0, Math.min(maxOwnerRepos, hi)));
    const l = Number(ownerLo.value);
    const h = Number(ownerHi.value);
    syncAxis();
    // 上限拖到轴顶 = "300 及以上"，按不限处理，否则 >=300 的作者会被误排除
    actions.setOwnerRepos(Math.min(l, h), Math.max(l, h) >= maxOwnerRepos ? null : Math.max(l, h));
  };
  ownerLoNum.addEventListener("change", () => commitAxis(Number(ownerLoNum.value) || 0, Number(ownerHi.value), "lo"));
  ownerHiNum.addEventListener("change", () => commitAxis(Number(ownerLo.value), Number(ownerHiNum.value) || 0, "hi"));
  const ownerRange = el("div", { class: "dual-range" }, [
    el("div", { class: "dr-track" }, [drFill]),
    ownerLo,
    ownerHi,
  ]);
  const ownerAxis = el("div", {}, [
    ownerRange,
    el("div", { class: "dr-ends" }, [el("span", { text: "0" }), el("span", { text: String(maxOwnerRepos) })]),
  ]);
  syncAxis();

  const filterSec = sec("筛选", [
      field(
        "作者仓库数",
        el("div", { class: "dr-col" }, [
          ownerAxis,
          el("div", { class: "dual-nums" }, [ownerLoNum, el("span", { class: "tilde", text: "~" }), ownerHiNum]),
        ]),
      ),
      field("星标下限", slider, starNum, el("b", { text: starText(state.minStars) })),
      field("推送时间", pushedSelect),
      field("仓库语言", languageSelect),
      field("归档状态", archivedSelect),
      el("label", { class: "switch" }, [
        el("input", { type: "checkbox", checked: state.hideNoise, on: { change: (ev) => actions.setHideNoise(ev.target.checked) } }),
        "隐藏确认噪声（" + confirmed.length + " 个）",
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "key", text: "重置筛选", title: "清空标签/语言/归档/星标/搜索，并退出放大与关联聚焦", on: { click: () => actions.resetFilters() } }),
      ]),
      el("div", { class: "note", text: "筛选只做淡化、不移除节点：布局位置保持不变，便于前后对照。" }),
    ]);
  const sectorsSec = sec(view.focusCategory ? "细枝分类" : "功能扇区", [
      view.focusCategory ? subRows : groupRows,
      el("div", {
        class: "note",
        text: view.focusCategory
          ? "已放大到「" + (view.focusLabel ?? view.focusCategory) + "」：整个圆都是它，扇区是它的细枝分类。点细枝可高亮，Esc 或上方按钮返回全局。"
          : "共 " + groups.length + " 个扇区，每个约 " + (groups.length ? (360 / groups.length).toFixed(1) : "0") + "°。点击可放大该扇区（圆内再按细枝分类铺开）。",
      }),
    ]);
  const hubsSec = hubs.length
    ? sec("高频共享标签", [
        el("div", { class: "hubchips" }, hubs.slice(0, 10).map((h) => el("span", { class: "hubchip", text: h.topic + "（" + h.count + "）" }))),
        el("div", { class: "note", text: "出现次数超过阈值的标签，若两两连线会形成一团乱麻，因此只作为属性展示，不参与连线。" }),
      ])
    : null;

  // 左栏顺序（v0.4.3 用户指定）：总览 → 功能扇区 → 筛选 → 其余照常
  // （其余 = 扇区划分依据 / 捕获标签 / 高频共享标签，保持它们原本的相对顺序）
  root.replaceChildren(...[focusBanner, overviewSec, sectorsSec, filterSec, basisSec, tagsSec, hubsSec].filter(Boolean));
}

export function renderInspector(root, prepared, state, actions, view = {}) {
  const node = state.selectedId ? prepared.byId.get(state.selectedId) : null;
  const arm = view.armOf && node ? view.armOf.get(node.id) : null;
  const counts = view.linkCounts ?? {};

  // 右栏固定的前两段（v0.4.3 用户指定）：1. 图例  2. 操作提示；其余小节照旧排在它们后面
  const legendSec = sec("图例", [
      el(
        "div",
        { class: "legend" },
        EDGE_ORDER.filter((type) => (counts[type] ?? 0) > 0 || prepared.edgeTypes.includes(type)).map((type) => {
          const style = EDGE_STYLES[type] ?? { label: type, color: "#8899aa", dash: [] };
          const n = counts[type] ?? prepared.edges.filter((e) => e.type === type).length;
          return el("div", { class: "row" }, [
            el("span", { class: "line", style: { borderTopColor: style.color ?? "var(--accent)", borderTopStyle: style.dash?.length ? "dashed" : "solid" } }),
            // 同作者这类完整关系数可能上十万，用紧凑写法免得撑破侧栏
            el("span", { text: style.label + "（" + (n >= 10000 ? formatStars(n) : n) + "）" }),
          ]);
        }),
      ),
      el("div", { class: "note", text: "连线一律画成背离圆心的弧线，交叉时绕开圆心，不会在中心糊成一团。" }),
      el("div", {
        class: "note",
        text: "同作者按完整关系计数：点选任意仓库都会连到它全部同作者仓库。因此这里的数比数据文件里存的边多 —— 超大作者在数据层只存「枢纽连线」的星形拓扑，否则载荷会爆。",
      }),
      el("div", { class: "note", text: "节点配色表示功能分类，半径表示星标（对数）。" }),
  ]);
  const hintsSec = sec("操作提示", [
      el("div", {
        class: "note",
        text: "· 滚轮缩放，按住拖拽平移，单击选中仓库，双击聚焦其关联仓库\n· 左侧筛选只淡化、不移除节点，位置保持不变\n· 琥珀色虚线圆环表示疑似噪声，等待人工复核\n· 扇区标签沿中轴朝外，通常越靠近圆心星标越高",
    }),
  ]);

  if (!node) {
    root.replaceChildren(
      legendSec,
      hintsSec,
      sec(
        "待复核仓库（" + prepared.review.length + " 个）",
        prepared.review.slice(0, 8).map((n) =>
          el("div", { class: "review-item", on: { click: () => actions.selectRepo(n.id) } }, [
            el("b", { text: n.id }),
            // reason 来自采集器的三档判定；老数据没有这个字段时退回本地启发式
            el("p", { text: "星标 " + formatStars(n.stars) + " · " + (n.reason ?? reviewReason(n)) }),
          ]),
        ),
      ),

    );
    return;
  }

  const neighbors = prepared.adjacency.get(node.id) ?? [];
  const byType = new Map();
  for (const nb of neighbors) {
    if (!byType.has(nb.type)) byType.set(nb.type, []);
    byType.get(nb.type).push(nb);
  }
  // 同作者（v0.4.2）：以 owner 索引为准。数据层对大作者只存星形拓扑，
  // 只看存边会让大部分兄弟"消失"（画布上也是同一个毛病）。
  const ownerIds = ownerSiblings(prepared, node.id);
  if (ownerIds.length > 0) byType.set("owner", ownerIds.map((id) => ({ id, type: "owner", weight: 1, via: [] })));
  const relatedCount = [...byType.values()].reduce((sum, list) => sum + list.length, 0);

  // 点开项目球后：图例与操作提示让位给档案内容，压到最底部（覆盖性修复）
  root.replaceChildren(
    el("section", { class: "sec" }, [
      el("div", { class: "d-head" }, [
        node.avatar ? el("img", { src: node.avatar, alt: "", loading: "lazy", on: { error: (ev) => (ev.target.style.visibility = "hidden") } }) : null,
        el("div", { class: "who" }, [
          el("h2", { text: node.name }),
          el("div", { class: "owner", text: node.owner + (node.ownerType === "Organization" ? "（组织）" : "") }),
        ]),
      ]),
      node.description ? el("p", { class: "desc", text: node.description }) : null,
      el("div", { class: "pills" }, [
        isConfirmedNoise(node)
          ? el("span", { class: "badge warn", text: "确认噪声：" + (node.reason ?? "与 DSH 无关") })
          : node.review
            ? el("span", { class: "badge warn", text: "待复核：" + (node.reason ?? "线索不足") })
            : el("span", { class: "badge ok", text: "相关度 " + node.relevance + " / 8" }),
        el("span", { class: "badge", text: "所属扇区：" + (node.categoryLabel ?? node.category ?? "未分类") }),
        node.archived ? el("span", { class: "badge", text: "已归档" }) : null,
        node.fork ? el("span", { class: "badge", text: "复刻仓库" }) : null,
      ]),
      arm ? el("div", { class: "note", text: "所属扇区：" + (arm.label ?? arm.id) + " · 距圆心第 " + arm.rank + " / " + arm.count + " 近（按星标由内向外）" }) : null,
      node.category
        ? el("div", {
            class: "note",
            text: "功能分类：" + (node.categoryLabel ?? node.category) + (node.categoryHits?.length ? "（规则命中 " + node.categoryHits.join("、") + "）" : "（无规则命中，归入其他）"),
          })
        : null,
      el("div", { class: "kv" }, [
        el("div", {}, [el("em", { text: "星标" }), el("b", { text: formatStars(node.stars) })]),
        el("div", {}, [el("em", { text: "复刻数" }), el("b", { text: formatStars(node.forks) })]),
        el("div", {}, [el("em", { text: "创建于" }), el("b", { text: formatDate(node.createdAt) })]),
        el("div", {}, [el("em", { text: "最近推送" }), el("b", { text: formatDate(node.pushedAt) })]),
        el("div", {}, [el("em", { text: "语言" }), el("b", { text: node.language ?? "—" })]),
        el("div", {}, [el("em", { text: "许可证" }), el("b", { text: node.license ?? "—" })]),
      ]),
      el("div", { class: "links" }, [
        // 预计算契约里没有 htmlUrl（为省载荷丢弃），统一从 id 推导；老数据仍可用 htmlUrl
        el("a", { href: node.htmlUrl ?? "https://github.com/" + node.id, target: "_blank", rel: "noreferrer", text: "在 GitHub 打开" }),
        node.homepage ? el("a", { href: node.homepage, target: "_blank", rel: "noreferrer", text: "项目主页" }) : null,
      ]),
      el("div", { class: "links" }, [
        el("a", {
          href: "#",
          text: state.neighborFocus === node.id ? "取消关联聚焦" : "只看关联仓库",
          on: {
            click: (ev) => {
              ev.preventDefault();
              actions.focusNeighbors(state.neighborFocus === node.id ? null : node.id);
            },
          },
        }),
        el("a", { href: "#", text: "居中显示", on: { click: (ev) => { ev.preventDefault(); actions.centerOn(node.id); } } }),
      ]),
    ]),
    sec("命中标签", el("div", { class: "pills" }, node.matchedTags.map((t) => el("span", { class: "pill hit", text: t })))),
    sec("仓库主题（" + (node.topics?.length ?? 0) + " 个）", el("div", { class: "pills" }, (node.topics ?? []).slice(0, 18).map((t) => el("span", { class: "pill", text: t })))),
    sec(
      "关联（" + relatedCount + " 个）",
      [...byType.entries()].flatMap(([type, list]) => [
        el("div", { class: "note", text: (EDGE_STYLES[type]?.label ?? type) + " · " + list.length + " 个" }),
        ...list.slice(0, 14).map((nb) => {
          const other = prepared.byId.get(nb.id);
          return el("div", { class: "neigh", on: { click: () => actions.selectRepo(nb.id) } }, [
            el("span", { class: "dot", style: { background: colorOfTag(other?.primaryTag) } }),
            el("span", { class: "nm", text: nb.id }),
            el("span", {
              class: "w",
              text:
                type === "owner"
                  ? "同一作者：" + node.owner
                  : type === "resonance"
                    ? "生态共鸣：" + (nb.via?.[0] ?? "基座")
                    : nb.via?.length
                      ? "共同主题：" + nb.via.slice(0, 2).join("、")
                      : "权重 ×" + nb.weight,
            }),
          ]);
        }),
        // 同作者动辄几十上百个，列全了右栏就没法看；如实说明只列了前 14 个
        list.length > 14 ? el("div", { class: "note", text: "以上按星标取前 14 个，共 " + list.length + " 个" }) : null,
      ]),
    ),
    // 展示仓库档案时，图例与操作提示排在最后（未选中时才在最前）
    legendSec,
    hintsSec,
  );
}

export function renderTooltip(tooltipEl, node, pos, stageRect) {
  if (!node) {
    tooltipEl.hidden = true;
    return;
  }
  // 注意：replaceChildren 不过滤 null（真实 DOM 会插入文本 "null"），必须自己拍平
  tooltipEl.replaceChildren(
    ...[
      el("b", { text: node.id }),
      el("div", {
        class: "tt-sub",
        text: "★ " + formatStars(node.stars) + " · " + (node.language ?? "未知语言") + " · 最近推送 " + formatDate(node.pushedAt) + " · " + (node.categoryLabel ?? node.category ?? "未分类"),
      }),
      node.description ? el("div", { class: "tt-desc", text: node.description.slice(0, 150) }) : null,
      el("div", { class: "pills" }, (node.matchedTags ?? []).map((t) => el("span", { class: "pill hit", text: t }))),
    ].filter(Boolean),
  );
  tooltipEl.hidden = false;
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  let x = pos.x + 16;
  let y = pos.y + 14;
  if (x + tw > stageRect.width - 8) x = pos.x - tw - 16;
  if (y + th > stageRect.height - 8) y = pos.y - th - 14;
  tooltipEl.style.left = Math.max(8, x) + "px";
  tooltipEl.style.top = Math.max(8, y) + "px";
}

/**
 * 连线图例（v0.4.1 取代原来的连线开关）：
 * 连线不再常驻，只有点选某个仓库时才画出它自己的两类关系，所以这里只做"说明 + 计数"。
 */
export function renderLinkLegend(root, prepared, state, actions, view = {}) {
  // 实时计数：跟随当前悬停的项目，没悬停就跟随选中项；都没有就是 0。
  // 不再显示提示语 —— 计数本身就在说明：点选后会画出这些连线。
  const id = view.activeId ?? state.selectedId ?? null;
  const row = (color, dash, label, count) =>
    el("span", { class: "edge-chip on" }, [
      el("span", {
        class: "edge-swatch",
        style: {
          background: dash ? "transparent" : color,
          borderColor: color,
          borderStyle: dash ? "dashed" : "solid",
        },
      }),
      el("span", { text: label + " " + count }),
    ]);

  const linked = (type) => {
    if (!id) return 0;
    // 同作者以 owner 索引计数：数据层对大作者只存星形拓扑，数存边会少一大截（v0.4.2）
    if (type === "owner") return ownerSiblings(prepared, id).length;
    if (!prepared.adjacency) return 0;
    const list = prepared.adjacency.get(id);
    if (!list) return 0;
    let n = 0;
    for (const e of list) if (e.type === type) n += 1;
    return n;
  };
  const accent = view.colors?.accent ?? "#2f7df6";
  const topicColor = view.colors?.topic ?? "#e08a00";
  const resonanceColor = EDGE_STYLES.resonance?.color ?? "#a86bff";
  root.replaceChildren(
    ...[
      row(accent, false, "同作者", linked("owner")),
      row(topicColor, true, "主题共现", linked("topic")),
      // 生态共鸣是人工策展的边（基座 → 生态），也在这里显示当前选中项的条数
      row(resonanceColor, false, "生态共鸣", linked("resonance")),
    ],
  );
}
