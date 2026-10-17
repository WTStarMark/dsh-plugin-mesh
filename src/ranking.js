/**
 * 榜单弹窗：画布顶端那枚奖杯 → 「周更新热榜」/「周 star 热榜」。
 * 数据来自 GET /api/ranking（服务端读 data/mesh.json 与 data/cache/star-history.json）：
 * 历史还没攒够一个窗口时，服务端如实返回「实际窗口天数」，这里原样展示，绝不把它说成「周增量」。
 * 接口拿不到就直说拿不到，不编任何数字。
 */

const TAB_LABEL = { updated: "周更新热榜", stars: "周 star 热榜", npm: "周 npm 热榜" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** SVG 节点：浏览器走 createElementNS；DOM 桩只有 createElement 时也能跑 */
function svgEl(name, attrs = {}) {
  const node = document.createElementNS
    ? document.createElementNS("http://www.w3.org/2000/svg", name)
    : document.createElement(name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute?.(k, v);
  return node;
}

/** 下载量前缀小图标：与奖杯同款 currentColor SVG，避开 ↓ 基线偏移 */
function npmDownloadMark() {
  const mark = el("i", "npm-mark");
  mark.setAttribute?.("aria-hidden", "true");
  const svg = svgEl("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" });
  // 箭头落入托盘：在 10px 下仍能认，线宽跟 UI 细描边一致
  svg.append(
    svgEl("path", {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      d: "M8 2.5v7.2M5.2 7.2 8 10l2.8-2.8M3.5 13.2h9",
    }),
  );
  mark.append(svg);
  return mark;
}

/** 千分位星标：12.3k / 1.2M —— 与站点其它地方一致 */
export function formatStars(value) {
  const v = Number(value) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return v.toLocaleString("en-US");
}

/** 相对时间：只在榜单里用，所以就地实现，不依赖面板模块 */
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "—";
  const min = Math.floor(Math.max(0, now - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  const day = Math.floor(hour / 24);
  if (day < 30) return day + " 天前";
  return Math.floor(day / 30) + " 个月前";
}

/**
 * opts：{ button, modal, tabs, body, close, fetcher, onPick, noiseToggle, noiseBox, noiseLabel, npmToggle, npmBox, npmLabel }。
 * fetcher 失败时如实显示「拿不到」，onPick 回调仓库 id；
 * noiseToggle / noiseBox / noiseLabel = 弹窗头部那枚「隐藏噪声」开关（可选，没有就只标注不隐藏）；
 * npmToggle / npmBox / npmLabel = 「显示周下载」开关（默认关；打开后在名称行挂胶囊，不进排序）。
 */
export function createRankingBoard({ button, modal, tabs, body, close, fetcher, onPick, noiseToggle, noiseBox, noiseLabel, npmToggle, npmBox, npmLabel }) {
  let data = null;
  let loadedAt = 0;
  let tab = "updated";
  let open = false;
  let loading = false;
  let error = null;
  // 只隐藏、不重排：被藏起来的行仍然占着它原来的名次，后面的行不会被顶上来（名次是榜位，不是显示序号）
  let hideNoise = false;
  let showNpm = false;

  /** 大数缩写：12.3k / 1.2M —— 下载量榜与星标榜共用同一把尺子 */
  function formatCount(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return v.toLocaleString("en-US");
  }

  /** 周下载量展示：有数字就千分位；没数字时按状态给具体原因（缺失不能当 0） */
  function formatNpm(npm) {
    if (npm && npm.status === "ok" && typeof npm.downloads === "number") {
      return formatCount(npm.downloads);
    }
    if (npm && npm.status === "private") return "未发布";
    if (npm && npm.status === "no-package") return "无 npm 包";
    return "未知";
  }

  /** 悬停说明：把「为什么没有数字」讲清楚（unknown=确认无包；error=暂时失败可重试） */
  function npmReason(npm) {
    if (!npm) return "本次没有采到这个仓库的 npm 信息";
    if (npm.status === "private") return "该仓库 package.json 标了 private，未发布到 npm";
    if (npm.status === "no-package") return "该仓库没有 package.json";
    if (npm.status === "error") return "未取到下载量（接口暂时失败，稍后会重试）";
    if (npm.status === "unknown") return "npm 上没有这个包（或包名对不上）";
    return "未取到下载量";
  }

  const STALE_MS = 5 * 60 * 1000;

  function syncTabs() {
    // 三原色：当前榜的身份色挂在弹窗元素上，行内名次/指标/趋势柱都从 --board 取色
    if (modal && modal.dataset) modal.dataset.board = tab;
    if (!tabs) return;
    for (const btn of tabs.children ?? []) {
      const on = btn.dataset?.tab === tab;
      btn.classList?.toggle?.("on", on);
      btn.setAttribute?.("aria-selected", on ? "true" : "false");
    }
  }

  function rowsOf() {
    const board = data?.boards?.[tab];
    return board?.items ?? [];
  }

  /** 近 7 日趋势柱：null = 那天没观测（不是 0）——有数据画实心、0 画浅底座、没观测画虚线底座 */
  function sparkline(item, board) {
    const values = Array.isArray(item.series) ? item.series : null;
    // 横轴：本榜自带 seriesAxis 时优先用它（npm 榜的 7 天与另两榜不是同一组日期，混用会整排错位）
    const axis = Array.isArray(board?.seriesAxis) && board.seriesAxis.length ? board.seriesAxis : data?.seriesDays;
    const days = Array.isArray(axis) ? axis : [];
    const rawKind = board?.seriesKind ?? board?.metric;
    const kind =
      rawKind === "star-gain" ? "star-gain" : rawKind === "releases" ? "releases" : rawKind === "npm-downloads" ? "npm-downloads" : "updates";
    const spans = (Array.isArray(item.spans) ? item.spans : []).filter((s) => s.value > 0);
    const wrap = el("div", "spark" + (values ? "" : " spark-empty"));
    if (!values && !spans.length) return wrap;
    if (!values) {
      // 只有跨天累计、没有逐日数据：仍然把这根宽柱画出来（槽位留空即可，位置按百分比算）
      for (const s of spans) {
        const n = days.length || 7;
        const span = el("span", "spark-span");
        span.style.left = (s.fromIdx / n) * 100 + "%";
        span.style.width = ((s.toIdx - s.fromIdx + 1) / n) * 100 + "%";
        span.title = s.from + " → " + s.to + "：+" + formatStars(s.value) + (kind === "star-gain" ? " ★" : "");
        wrap.append(span);
      }
      return wrap;
    }
    // 每行按自己的峰值归一（看的是这一周的起伏形状，绝对值看右侧指标）；全榜统一比例尺会让长尾行的柱子几乎看不见。
    const peak = Math.max(1, ...values.map((v) => (typeof v === "number" && v > 0 ? v : 0)));
    const BAR_MAX = 18;
    values.forEach((v, i) => {
      const nodata = v === null || v === undefined;
      const down = !nodata && v < 0; // 掉星：star 榜会真的出现负数，如实画出来（不显示成 0）
      const bar = el("span", "spark-bar" + (nodata ? " none" : down ? " down" : v > 0 ? (v >= peak ? " peak" : "") : " zero"));
      if (!nodata) bar.style.height = Math.max(3, Math.round((Math.abs(v) / peak) * BAR_MAX)) + "px";
      const label =
        kind === "star-gain"
          ? v > 0 ? "+" + v + " ★" : v < 0 ? v + " ★" : "0 ★"
          : kind === "releases" ? v + " 个版本" : kind === "npm-downloads" ? v + " 次下载" : v + " 次";
      bar.title = (days[i] ?? "第 " + (i + 1) + " 天") + "：" + (nodata ? "—" : label);
      wrap.append(bar);
    });
    // 跨多天的观测画成一根压在底部的宽柱，并标出它覆盖了哪几天；绝不平摊到某一天——那会变成凭空的日柱。
    for (const s of spans) {
      const n = values.length || 7;
      const span = el("span", "spark-span");
      span.style.left = (s.fromIdx / n) * 100 + "%";
      span.style.width = ((s.toIdx - s.fromIdx + 1) / n) * 100 + "%";
      span.title = s.from + " → " + s.to + "：+" + formatStars(s.value) + (kind === "star-gain" ? " ★" : "");
      wrap.append(span);
    }
    return wrap;
  }

  function renderRow(item, index) {
    const board = data?.boards?.[tab];
    const row = el("div", "rank-row" + (index < 3 ? " top" + (index + 1) : ""));
    row.append(el("span", "rk", String(index + 1)));
    if (item.avatar) {
      const img = el("img", "av");
      img.src = item.avatar;
      img.alt = "";
      img.loading = "lazy";
      row.append(img);
    } else {
      row.append(el("span", "av"));
    }
    const who = el("div", "who");
    const line = el("div", "line");
    line.append(el("b", null, item.name || item.id));
    // 三档判定随接口返回（verdict）：noise 只标注，不隐藏、不降权 —— 隐藏要用户自己点开关
    if (item.verdict === "noise") {
      const chip = el("span", "noise", "噪声");
      chip.title = item.reason ? "已判定为噪声：" + item.reason : "已判定为噪声（与 DSH 生态无关或蹭标签的通用项目）";
      line.append(chip);
    }
    // 版本（采集器单独抓的 releases）：最新一个做成小胶囊，其余在悬停里列全
    const versions = Array.isArray(item.releases) ? item.releases : [];
    if (versions.length) {
      const newest = versions[0];
      line.append(el("span", "ver" + (newest.pre ? " pre" : ""), newest.tag || "—"));
    }
    // 周下载：和噪声/版本同一行的胶囊，不另开列、不挤 metric（可选列，默认关）
    // npm 榜自己就是按下载量排的，指标列已经写着数字，这里不再重复挂一枚胶囊
    if (showNpm && tab !== "npm") {
      const npm = item.npm;
      const label = formatNpm(npm);
      const ok = npm && npm.status === "ok" && typeof npm.downloads === "number";
      // 有数时：小下载 icon + 数字（同 metric「★ 数字」结构，icon 用 SVG 避免字形基线问题）
      const chip = el("span", "npm-tag" + (ok ? "" : " unk"));
      if (ok) chip.append(npmDownloadMark(), el("span", "npm-num", label));
      else chip.textContent = label;
      const win = npm && npm.window ? npm.window.start + " ~ " + npm.window.end : "";
      const pkg = npm && npm.package ? npm.package : "";
      chip.title =
        (pkg ? "npm:" + pkg : "无包名") +
        (win ? " · 窗口 " + win : "") +
        (npm && npm.multiPackage ? " · 多包（只计根 package.json）" : "") +
        " · " +
        (ok ? "上周下载 " + label : npmReason(npm));
      line.append(chip);
    }
    who.append(line);
    const bits = [item.owner, item.categoryLabel].filter(Boolean);
    who.append(el("span", null, bits.join(" · ") || item.id));
    row.append(who);
    row.append(sparkline(item, board));

    const metric = el("div", "metric");
    if (board?.metric === "releases") {
      // 次行只留星标：版本已在左侧胶囊，避免「最新 v… · ★ …」在窄列里被截断
      metric.append(
        el("b", null, (item.updates ?? 0) + " 个版本"),
        el("span", null, "★ " + formatStars(item.stars)),
      );
    } else if (board?.metric === "updates") {
      metric.append(
        el("b", null, "≥" + (item.updates ?? 1) + " 次"),
        el("span", null, timeAgo(item.pushedAt) + " · ★ " + formatStars(item.stars)),
      );
    } else if (board?.metric === "npm-downloads") {
      // 指标列 = 周下载量（真实计数），次行给星标与该数字对应的 npm 窗口（窗口与另两榜可能不重合，所以写在行上）
      const win =
        item.npmWindow && item.npmWindow.start && item.npmWindow.end
          ? item.npmWindow.start.slice(5) + "~" + item.npmWindow.end.slice(5)
          : "";
      metric.append(
        el("b", null, formatCount(item.downloads)),
        el("span", null, "★ " + formatStars(item.stars) + (win ? " · " + win : "")),
      );
    } else {
      const w = board?.window?.days;
      metric.append(
        el("b", null, "+" + formatStars(item.delta)),
        el("span", null, "★ " + formatStars(item.starsAfter ?? item.stars) + (typeof w === "number" ? " · " + w + " 天" : "")),
      );
    }
    row.append(metric);
    const verText = versions.length
      ? " · 版本：" + versions.map((v) => (v.tag || "—") + (v.at ? "@" + String(v.at).slice(5) : "") + (v.pre ? "（预发布）" : "")).join("、")
      : "";
    row.title = item.id + verText;
    row.addEventListener("click", () => {
      setOpen(false);
      if (typeof onPick === "function") onPick(item.id);
    });
    return row;
  }

  function renderBody() {
    if (!body) return;
    body.textContent = "";
    if (loading && !data) {
      body.append(el("div", "rank-empty", "正在取榜单…"));
      return;
    }
    if (error) {
      body.append(el("div", "rank-empty", error));
      return;
    }
    const board = data?.boards?.[tab];
    if (!board) {
      body.append(el("div", "rank-empty", "还没有榜单数据。"));
      return;
    }
    if (board.available === false && board.metric !== "pushed") {
      body.append(el("div", "rank-empty", board.note || "这个榜单暂时算不出来。"));
      return;
    }
    const items = rowsOf();
    if (!items.length) {
      body.append(el("div", "rank-empty", "这个窗口里没有可上榜的仓库。"));
      return;
    }
    // 名次按原榜算：隐藏一行不会让后面的行往上顶（名次是榜位，不是显示序号）
    const shown = items.map((item, i) => ({ item, rank: i })).filter((x) => !(hideNoise && x.item.verdict === "noise"));
    if (!shown.length) {
      body.append(el("div", "rank-empty", "这个榜单里都是已判定噪声。想看得见上面「隐藏噪声」开关关掉。"));
      return;
    }
    shown.forEach((x) => body.append(renderRow(x.item, x.rank)));
  }

  /** 开关状态：没有噪声行时用 visibility 藏起占位，避免「显示周下载」左右跳 */
  function syncNoise() {
    const n = rowsOf().filter((it) => it.verdict === "noise").length;
    if (noiseBox) {
      noiseBox.checked = hideNoise;
      noiseBox.setAttribute?.("aria-checked", hideNoise ? "true" : "false");
    }
    if (noiseToggle) {
      noiseToggle.hidden = false;
      noiseToggle.classList?.toggle?.("is-idle", n === 0);
      noiseToggle.setAttribute?.("aria-hidden", n === 0 ? "true" : "false");
      noiseToggle.title = n ? "隐藏噪声（" + n + " 条）：只藏显示，不重排名次" : "";
    }
    if (noiseLabel) noiseLabel.textContent = "隐藏噪声";
  }

  function syncNpm() {
    if (npmBox) {
      npmBox.checked = showNpm;
      npmBox.setAttribute?.("aria-checked", showNpm ? "true" : "false");
    }
    if (npmLabel) npmLabel.textContent = "显示周下载";
    if (npmToggle) {
      npmToggle.hidden = false;
      npmToggle.title = "可选标注：覆盖不全；取不到按状态显示「未发布 / 无 npm 包 / 未知」";
    }
  }

  function render() {
    syncTabs();
    syncNoise();
    syncNpm();
    renderBody();
    // 前端不再展示任何口径解释（列表、标签页都不挂）：口径在接口字段里（updatesSource / window.days / dataAgeHours / seriesSource / note），文档里也写着。
  }

  async function refresh() {
    if (typeof fetcher !== "function") {
      error = "拿不到榜单：当前没有可用的接口（本地静态预览时属正常）。";
      render();
      return;
    }
    loading = true;
    error = null;
    render();
    try {
      const payload = await fetcher();
      if (payload && payload.boards) {
        data = payload;
        loadedAt = Date.now();
        error = null;
      } else {
        error = "拿不到榜单数据（接口没返回可识别的结构）。";
      }
    } catch {
      error = "拿不到榜单数据：请求失败。稍后再试。";
    }
    loading = false;
    render();
  }

  function setTab(next) {
    if (!TAB_LABEL[next]) return;
    tab = next;
    render();
  }

  function setOpen(value) {
    open = !!value;
    if (modal) modal.hidden = !open;
    if (button) button.setAttribute?.("aria-expanded", open ? "true" : "false");
    if (!open) return;
    render();
    if (!data || Date.now() - loadedAt > STALE_MS) refresh();
    close?.focus?.();
  }

  if (tabs) {
    for (const btn of tabs.children ?? []) {
      btn.addEventListener?.("click", () => setTab(btn.dataset?.tab));
    }
  }
  if (noiseBox) {
    noiseBox.addEventListener?.("change", () => {
      hideNoise = !!noiseBox.checked;
      render();
    });
  }
  if (npmBox) {
    npmBox.addEventListener?.("change", () => {
      showNpm = !!npmBox.checked;
      render();
    });
  }
  button?.addEventListener?.("click", (ev) => {
    ev?.stopPropagation?.();
    setOpen(!open);
  });
  close?.addEventListener?.("click", () => setOpen(false));
  if (modal) {
    for (const node of modal.children ?? []) {
      if (node.dataset?.close) node.addEventListener?.("click", () => setOpen(false));
    }
  }

  return {
    setOpen,
    toggle: () => setOpen(!open),
    isOpen: () => open,
    setTab,
    tab: () => tab,
    refresh,
    render,
    data: () => data,
    error: () => error,
    /** Tab 键之外：Esc 由 app.js 统一分发（弹窗在最上层，优先关它） */
    labels: TAB_LABEL,
  };
}
