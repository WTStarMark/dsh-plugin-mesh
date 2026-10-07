/**
 * 榜单弹窗（v0.5.0）：画布顶端那枚奖杯 → 「周更新热榜」/「周 star 热榜」。
 *
 * 数据来自 GET /api/ranking（服务端读 data/mesh.json 与 data/cache/star-history.json）：
 *   · 周更新热榜 = pushedAt 落在窗口内的仓库，按最近推送排序 —— GitHub 事实，直接可用
 *   · 周 star 热榜 = 两个时间点的星标之差（真实观测）。历史还没攒够一个窗口时，
 *     服务端会如实返回"实际窗口天数"，这里原样展示，绝不把它说成"周增量"。
 * 接口拿不到就直说拿不到，不编任何数字。
 */

const TAB_LABEL = { updated: "周更新热榜", stars: "周 star 热榜" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
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

function stamp(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.button  奖杯按钮
 * @param {HTMLElement} opts.modal   弹窗容器（带 hidden）
 * @param {HTMLElement} opts.tabs    两个榜单的切换条（.seg）
 * @param {HTMLElement} opts.body    列表容器
 * @param {HTMLElement} opts.close   关闭按钮
 * @param {Function} [opts.fetcher]  拉 /api/ranking；缺省或失败时如实显示"拿不到"
 * @param {Function} [opts.onPick]   点某一行：回调仓库 id（调用方负责选中/居中）
 */
export function createRankingBoard({ button, modal, tabs, body, close, fetcher, onPick }) {
  let data = null;
  let loadedAt = 0;
  let tab = "updated";
  let open = false;
  let loading = false;
  let error = null;

  const STALE_MS = 5 * 60 * 1000;

  function syncTabs() {
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

  /**
   * 近 7 日趋势柱：服务端给的是逐日序列（null = 那天没观测，不是 0）。
   * 有数据的天画实心柱，0 画一条浅底座，没观测的画虚线底座 —— 三种状态必须一眼能分开。
   */
  function sparkline(item, board) {
    const values = Array.isArray(item.series) ? item.series : null;
    const days = Array.isArray(data?.seriesDays) ? data.seriesDays : [];
    const kind = (board?.seriesKind ?? board?.metric) === "star-gain" ? "star-gain" : "updates";
    const spans = (Array.isArray(item.spans) ? item.spans : []).filter((s) => s.value > 0);
    const wrap = el("div", "spark" + (values ? "" : " spark-empty"));
    if (!values && !spans.length) {
      wrap.title = "这次响应里没有逐日趋势数据";
      return wrap;
    }
    if (!values) {
      // 只有跨天累计、没有逐日数据：仍然把这根宽柱画出来（槽位留空即可，位置按百分比算）
      for (const s of spans) {
        const n = (Array.isArray(data?.seriesDays) && data.seriesDays.length) || 7;
        const span = el("span", "spark-span");
        span.style.left = (s.fromIdx / n) * 100 + "%";
        span.style.width = ((s.toIdx - s.fromIdx + 1) / n) * 100 + "%";
        span.title =
          s.from + " → " + s.to + " 累计 +" + formatStars(s.value) + (kind === "star-gain" ? " ★" : "") +
          "（跨 " + s.days + " 天，期间没有逐日观测）";
        wrap.append(span);
      }
      wrap.title = "近 7 日" + (kind === "star-gain" ? " star 增量" : "更新次数") + "：只有跨天累计（宽条），没有逐日观测";
      return wrap;
    }
    // 每行按自己的峰值归一：看的是"这一周的起伏形状"，绝对值看右侧指标与悬停明细。
    // （全榜统一比例尺试过，长尾行的柱子会几乎看不见，不合适。）
    const peak = Math.max(1, ...values.map((v) => (typeof v === "number" && v > 0 ? v : 0)));
    const BAR_MAX = 18; // px
    values.forEach((v, i) => {
      const nodata = v === null || v === undefined;
      const bar = el("span", "spark-bar" + (nodata ? " none" : v > 0 ? (v >= peak ? " peak" : "") : " zero"));
      if (!nodata) bar.style.height = Math.max(3, Math.round((v / peak) * BAR_MAX)) + "px";
      const label = kind === "star-gain" ? (v > 0 ? "+" + v + " ★" : "0 ★") : v + " 次更新";
      bar.title = (days[i] ?? "第 " + (i + 1) + " 天") + "：" + (nodata ? "没有观测数据" : label);
      wrap.append(bar);
    });
    // 跨多天的观测（例如只有一个旧观测点）：画成一根压在底部的宽柱，标出它覆盖了哪几天。
    // 绝不平摊到某一天 —— 那会变成凭空的日柱。
    for (const s of spans) {
      const n = values.length || 7;
      const span = el("span", "spark-span");
      span.style.left = (s.fromIdx / n) * 100 + "%";
      span.style.width = ((s.toIdx - s.fromIdx + 1) / n) * 100 + "%";
      span.title =
        s.from + " → " + s.to + " 累计 +" + formatStars(s.value) + (kind === "star-gain" ? " ★" : "") +
        "（跨 " + s.days + " 天，期间没有逐日观测）";
      wrap.append(span);
    }
    wrap.title = "近 7 日" + (kind === "star-gain" ? " star 增量" : "更新次数") + "（按本行峰值归一；虚线 = 那天没有观测数据）";
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
    // 版本（采集器单独抓的 releases）：最新一个做成小胶囊，其余在悬停里列全
    const versions = Array.isArray(item.releases) ? item.releases : [];
    if (versions.length) {
      const newest = versions[0];
      line.append(el("span", "ver" + (newest.pre ? " pre" : ""), newest.tag || "—"));
    }
    who.append(line);
    const bits = [item.owner, item.categoryLabel].filter(Boolean);
    who.append(el("span", null, bits.join(" · ") || item.id));
    row.append(who);
    row.append(sparkline(item, board));

    const metric = el("div", "metric");
    if (board?.metric === "updates") {
      // 主指标 = 近 7 天更新次数（1 + 采样到的额外推进），次行才是"最后一次推送有多新"
      metric.append(el("b", null, (item.updates ?? 1) + " 次"), el("span", null, timeAgo(item.pushedAt) + " · ★ " + formatStars(item.stars)));
    } else {
      metric.append(el("b", null, "+" + formatStars(item.delta)), el("span", null, "★ " + formatStars(item.starsAfter ?? item.stars)));
    }
    row.append(metric);
    const verText = versions.length
      ? " · 版本：" + versions.map((v) => (v.tag || "—") + (v.at ? "@" + String(v.at).slice(5) : "") + (v.pre ? "（预发布）" : "")).join("、")
      : "";
    row.title = item.id + verText + "（点击跳到画布上它所在的位置）";
    row.addEventListener("click", () => {
      setOpen(false);
      if (typeof onPick === "function") onPick(item.id);
    });
    return row;
  }

  /** 口径文字（不上屏）：挂在列表与标签页的悬停提示上 —— 信息不丢，但不占版面 */
  function boardCaption(board) {
    if (!board) return "";
    const hint = seriesHint(board);
    if (board.metric === "updates") {
      return (
        "窗口 " + (data?.windowDays ?? 7) + " 天 · 共 " + (board.total ?? 0) + " 个仓库有推送，按【更新次数】→ 最近推送 → 星标排序（已排除归档与复刻）" +
        (board.note ? " · " + board.note : "") +
        (hint ? " · " + hint : "")
      );
    }
    if (board.available && board.window) {
      const w = board.window;
      const short = w.days < (w.target ?? 7) - 0.5;
      return (
        "实际窗口 " + w.days + " 天（" + stamp(w.from) + " → " + stamp(w.to) + "）" +
        (short ? " · star 历史还没攒够 " + (w.target ?? 7) + " 天，先按现有历史算（采集器每天记一个点）" : " · 完整周窗口") +
        (hint ? " · " + hint : "")
      );
    }
    return board.note ?? "";
  }

  /** 趋势柱的诚实说明：7 天里有几天是真的观测过的 */
  function seriesHint(board) {
    const total = Array.isArray(data?.seriesDays) ? data.seriesDays.length : 0;
    const observed = typeof board?.seriesDays === "number" ? board.seriesDays : 0;
    const spans = board?.spanCount ?? 0;
    if (!total) return "";
    if (!observed && !spans) return "趋势柱：还没有逐日数据（采集器按天记录，攒到第一天后这里就会出现柱子）";
    if (!observed) return "趋势柱：还没有逐日数据；" + spans + " 段" + (spans > 1 ? "" : "") + "跨天累计用底部宽条标出（悬停看明细，不平摊到某一天）";
    if (observed >= total && !spans) return "";
    const extra = spans ? "；另有 " + spans + " 段跨天累计用底部宽条标出" : "";
    return "趋势柱：近 " + total + " 天里只有 " + observed + " 天有观测数据（虚线 = 没观测，不是 0）" + extra;
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
    items.forEach((item, i) => body.append(renderRow(item, i)));
  }

  /** 页脚信息（不上屏）：数据快照新旧 + 本页规模 */
  function footCaption(board) {
    const parts = [];
    if (data?.generatedAt) {
      const age = typeof data.dataAgeHours === "number" ? "（" + (data.dataAgeHours < 1 ? "刚更新" : Math.round(data.dataAgeHours) + " 小时前") + "）" : "";
      parts.push("数据快照 " + stamp(data.generatedAt) + age);
    }
    if (board?.metric === "updates") {
      parts.push("窗口 " + (data?.windowDays ?? 7) + " 天：共 " + (board.total ?? 0) + " 个仓库有推送，这里按更新次数取前 " + (board.count ?? 0) + " 个");
      parts.push("榜上次数最高 " + (board.maxUpdates ?? 1) + " 次");
    } else if (board?.available) {
      const w = board.window;
      const short = w && w.days < (w.target ?? 7) - 0.5;
      parts.push("star 增量窗口 " + (w ? w.days + " 天" : "—") + (short ? "（历史还没攒够 " + (w.target ?? 7) + " 天，先按现有历史算）" : "（完整窗口）"));
      parts.push("两端可比 " + (board.matched ?? 0) + " 个仓库，其中 " + (board.total ?? 0) + " 个涨了星");
    }
    if (board?.note) parts.push(board.note);
    parts.push("点任意一行 → 跳到画布上它所在的位置");
    return parts.join(" · ");
  }

  function render() {
    syncTabs();
    renderBody();
    // 榜单上方/下方不再有任何文字：口径与数据新旧挂到悬停提示（列表 + 标签页），需要时悬停即可看到
    const board = data?.boards?.[tab];
    if (body) body.title = [boardCaption(board), footCaption(board)].filter(Boolean).join(" · ");
    if (tabs) {
      for (const btn of tabs.children ?? []) {
        const b = data?.boards?.[btn.dataset?.tab];
        if (!b) continue;
        const text = [boardCaption(b), footCaption(b)].filter(Boolean).join(" · ");
        if (text) btn.title = text;
      }
    }
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
    if (next !== "updated" && next !== "stars") return;
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
