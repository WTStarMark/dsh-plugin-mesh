/**
 * 索引源后台页面（挂载到现有管理后台的「索引源」标签页）。
 *
 * 视觉完全沿用后台既有的三族语言，不另造一套：
 *   · 区块 = .sec（裸排版，标题带序号与 hairline）/ .sec.panel（玻璃面板，一页最多一块）
 *   · 指标 = .cards + .stat（第一个 .stat.primary 是主指标）
 *   · 键值 = .kv + .kv-row（i + b）
 *   · 表格 = .table-wrap + .table（凹槽，表头 sticky）
 *   · 动作 = .btn / .btn.primary / .btn.small / 就地二次确认（.confirm-inline）
 *   · 语义 = .badge.ok/.warn/.err、.notice、.hint、.log
 *
 * 只依赖挂载时注入的 request(GET) / post(POST) / toast；CSP 限制下不写内联脚本/样式、不拼 HTML 字符串。
 */

const PAGES = [
  { id: "overview", label: "总览" },
  { id: "workflow", label: "工作流" },
  { id: "review", label: "复核台" },
  { id: "build", label: "构建与发布" },
];
const QUEUE_TYPES = [
  { id: "refuted", label: "驳回" },
  { id: "nodir", label: "无目录未核实" },
  { id: "unattributed", label: "未归属" },
  { id: "manual", label: "人工已裁决" },
  { id: "error", label: "缓存异常" },
];
const VERDICT_TEXT = { confirmed: "确证", unverified: "待确认", refuted: "驳回", unattributed: "未归属" };
const VERDICT_CLASS = { confirmed: "ok", unverified: "warn", refuted: "err", unattributed: "" };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};
const btn = (label, cls, onClick) => {
  const b = el("button", "btn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
};
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
const fmtNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
};
const fmtTime = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
};
const fmtBytes = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB"];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return (x >= 100 ? Math.round(x) : x.toFixed(1)) + " " + units[i];
};

/** 区块：默认裸排版；panel=true 才是玻璃面板（一页最多一块） */
function section(title, actions, panel) {
  const sec = el("section", "sec" + (panel ? " panel" : ""));
  const head = el("div", "sec-h");
  head.append(el("span", "sec-title", title));
  if (Array.isArray(actions) && actions.length) {
    const box = el("div", "sec-actions");
    for (const a of actions) if (a) box.append(a);
    head.append(box);
  }
  sec.append(head);
  return sec;
}
function kvList() {
  const box = el("div", "kv");
  const put = (label, value) => {
    const row = el("div", "kv-row");
    row.append(el("i", null, label), el("b", null, dash(value)));
    box.append(row);
    return row;
  };
  return { box, put };
}
function stat(parent, label, value, opts) {
  const o = opts || {};
  const box = el("div", "stat" + (o.primary ? " primary" : "") + (o.tone ? " " + o.tone : ""));
  box.append(el("span", "stat-label", label), el("b", o.compact ? "compact" : null, value));
  parent.append(box);
  return box;
}
function badge(text, kind) {
  return el("span", "badge" + (kind ? " " + kind : ""), text);
}
function tableWrap(headers, opts) {
  const wrap = el("div", "table-wrap" + (opts && opts.fixed ? " fixed" : ""));
  const table = el("table", "table");
  const thead = el("thead");
  const tr = el("tr");
  for (const h of headers) tr.append(el("th", h.cls || null, h.text));
  thead.append(tr);
  const tbody = el("tbody");
  table.append(thead, tbody);
  wrap.append(table);
  return { wrap, tbody, table };
}
function emptyRow(tbody, cols, text) {
  const tr = el("tr", "empty");
  const td = el("td", null, text);
  td.colSpan = cols;
  tr.append(td);
  tbody.append(tr);
}
/** 就地二次确认：说明文案 + 确认/取消，比 window.confirm 更贴近后台其它页 */
function confirmButton(label, message, onConfirm, opts) {
  const o = opts || {};
  const box = el("span", "confirm-inline");
  const start = btn(label, o.cls || "danger small");
  const restore = () => {
    clear(box);
    box.append(start);
  };
  start.addEventListener("click", () => {
    if (box.querySelector(".confirm-bar")) return;
    const bar = el("span", "confirm-bar");
    bar.append(el("span", "confirm-text", message));
    const no = btn("取消", "small", restore);
    const yes = btn(o.confirmLabel || "确认", "danger small");
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      no.disabled = true;
      yes.textContent = "处理中…";
      try {
        await onConfirm();
      } catch (e) {
        if (o.onError) o.onError(e);
      }
      restore();
    });
    bar.append(yes, no);
    clear(box);
    box.append(bar);
  });
  box.append(start);
  return box;
}

export function mountMarketView(root, { request, post, toast } = {}) {
  const state = { page: "overview", detail: null, queueType: "refuted", timer: null };
  const nav = el("div", "mk-subtabs");
  const body = el("div");
  const pages = new Map();
  for (const p of PAGES) {
    const b = el("button", "tab" + (p.id === state.page ? " on" : ""), p.label);
    b.type = "button";
    b.dataset.page = p.id;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => switchPage(p.id));
    nav.append(b);
    const sectionEl = el("div", "mk-page");
    sectionEl.hidden = p.id !== state.page;
    pages.set(p.id, sectionEl);
    body.append(sectionEl);
  }
  root.append(nav, body);

  function stopTimer() {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
  async function switchPage(id) {
    state.page = id;
    stopTimer();
    for (const b of nav.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.page === id);
    for (const [pid, node] of pages) node.hidden = pid !== id;
    try {
      await render();
    } catch (e) {
      toast(e && e.message ? e.message : "加载失败", "err");
    }
  }
  async function render() {
    if (state.page === "overview") await renderOverview();
    else if (state.page === "workflow") await renderWorkflow();
    else if (state.page === "review") await renderReview();
    else await renderBuild();
  }

  // ---------------- 总览 ----------------

  async function renderOverview() {
    const page = pages.get("overview");
    const data = await request("api/market/overview");
    clear(page);

    const cards = el("div", "cards");
    stat(cards, "索引条目", fmtNum(data.plugins), { primary: true, compact: false });
    stat(cards, "确证", fmtNum(data.verdicts.confirmed), { tone: "ok" });
    stat(cards, "待确认", fmtNum(data.verdicts.unverified), { tone: "warn" });
    stat(cards, "驳回", fmtNum(data.verdicts.refuted), { tone: "err" });
    stat(cards, "未归属", fmtNum(data.verdicts.unattributed || 0));
    stat(cards, "人工介入", fmtNum(data.verdicts.manual));
    page.append(cards);

    const health = section("索引健康", null, true);
    const kv = kvList();
    kv.put("dist 生成", fmtTime(data.dist.generatedAt));
    kv.put("mesh 数据", fmtTime(data.mesh.updatedAt));
    const lag = data.mesh.lagSeconds;
    kv.put("数据落后", lag === null ? "—" : lag > 60 ? Math.round(lag / 60) + " 分钟" : lag + " 秒");
    kv.put("采集器", data.collector ? "运行中 · " + data.collector.state : "空闲");
    kv.put("最近构建", data.job && data.job.id ? data.job.status + " · " + fmtTime(data.job.finishedAt || data.job.startedAt) : "无");
    kv.put("校验缓存", data.cache.entries + " 条");
    health.append(kv.box);
    const states = Object.entries(data.cache.states || {});
    if (states.length) {
      const facts = el("div", "res-facts");
      for (const [k, v] of states) {
        const f = el("span", "fact");
        f.append(el("i", null, k), el("b", null, fmtNum(v)));
        facts.append(f);
      }
      health.append(facts);
    }
    page.append(health);

    const queues = section("待处理队列", null);
    queues.append(el("p", "sec-sub", "点条目跳到复核台；裁决写 overrides.json，重建并发布后才进入线上索引。"));
    const row = el("div", "form-row");
    const chip = (label, type) => btn(label, "small" + (state.queueType === type ? " primary" : ""), () => {
      state.queueType = type;
      switchPage("review");
    });
    row.append(
      chip("驳回 " + fmtNum(data.verdicts.refuted), "refuted"),
      chip("无目录未核实", "nodir"),
      chip("未归属 " + fmtNum(data.verdicts.unattributed || 0), "unattributed"),
      chip("人工已裁决 " + fmtNum(data.verdicts.manual), "manual"),
      chip("缓存异常", "error"),
    );
    queues.append(row);
    page.append(queues);

    const hist = section("最近发布");
    const t = tableWrap([{ text: "时间" }, { text: "条目", cls: "num" }, { text: "体积", cls: "num" }], { fixed: true });
    for (const h of (data.history || []).slice(0, 6)) {
      const tr = el("tr");
      tr.append(el("td", "mono", h.ts), el("td", "num", h.plugins === null ? "—" : fmtNum(h.plugins)), el("td", "num", fmtBytes(h.bytes)));
      t.tbody.append(tr);
    }
    if (!(data.history || []).length) emptyRow(t.tbody, 3, "还没有已发布的历史版本");
    hist.append(t.wrap);
    page.append(hist);
  }


  // ---------------- 工作流 ----------------

  function flowNums(parent, pairs) {
    const box = el("div", "mk-phase-nums");
    for (const [label, value] of pairs) {
      if (value === null || value === undefined || value === "") continue;
      const span = el("span");
      span.append(el("i", null, label + " "), el("b", null, typeof value === "number" ? fmtNum(value) : String(value)));
      box.append(span);
    }
    parent.append(box);
  }

  async function renderWorkflow() {
    const page = pages.get("workflow");
    const data = await request("api/market/workflow");
    clear(page);

    const flow = section("索引源流水线", null, true);
    flow.append(el("p", "sec-sub", "从 npm/GitHub 原料到线上 dist 的八个阶段；括号里是本轮构建统计，缺失时用实时缓存近似。"));
    const pipeline = el("div", "pipeline");
    data.stages.forEach((stage, i) => {
      const phase = el("div", "phase");
      phase.append(el("span", "phase-no", String(i + 1).padStart(2, "0")));
      phase.append(el("span", "phase-label", stage.label));
      phase.append(el("span", "phase-desc", stage.desc));
      flowNums(phase, stage.nums || []);
      pipeline.append(phase);
      if (i < data.stages.length - 1) pipeline.append(el("span", "phase-arrow", "→"));
    });
    flow.append(pipeline);
    page.append(flow);

    const live = data.live || {};
    const snapshot = section("当前数据快照");
    const kv = kvList();
    kv.put("生态图节点", fmtNum(live.inputs.meshNodes));
    kv.put("npm 下载缓存仓库", fmtNum(live.inputs.downloadsRepos));
    kv.put("npm 反查包", fmtNum(live.inputs.npmSearchPackages));
    kv.put("子目录包缓存", fmtNum(live.inputs.npmSubdirPackages));
    kv.put("packument 缓存", fmtNum(live.inputs.registryRecords));
    kv.put("索引条目", fmtNum(live.index.plugins));
    kv.put("校验缓存", fmtNum(live.cache.entries));
    kv.put("人工裁决", fmtNum(live.overrides.entries));
    kv.put("dist 生成", fmtTime(live.dist.generatedAt));
    kv.put("mesh 数据", fmtTime(live.mesh.updatedAt));
    kv.put("采集器", live.collector ? "运行中 · " + live.collector.state : "空闲");
    kv.put("最近构建", live.job.id ? live.job.status + " · " + fmtTime(live.job.finishedAt || live.job.startedAt) : "无");
    snapshot.append(kv.box);
    page.append(snapshot);

    const outcome = section("索引条目去向");
    const facts = el("div", "res-facts");
    for (const [key, label] of [["confirmed", "确证"], ["unverified", "待确认"], ["refuted", "驳回"], ["unattributed", "未归属"]]) {
      const f = el("span", "fact");
      f.append(el("i", null, label), el("b", null, fmtNum(live.index.verdicts[key] || 0)));
      facts.append(f);
    }
    outcome.append(facts);
    const labels = Object.entries(live.index.labels || {}).sort((a, b) => b[1] - a[1]);
    if (labels.length) {
      const t = tableWrap([{ text: "标签" }, { text: "条目", cls: "num" }], { fixed: true });
      for (const [label, count] of labels) {
        const tr = el("tr");
        tr.append(el("td", "mono", label), el("td", "num", fmtNum(count)));
        t.tbody.append(tr);
      }
      outcome.append(t.wrap);
    }
    page.append(outcome);

    const layers = section("多重校验层", "本次构建（或当前数据）各层覆盖与拦截");
    const lb0 = data.lastBuild || {};
    const st = lb0.stats || {};
    const ver = st.verification || null;
    const prov = st.provenance || null;
    const pv = st.provenanceVerdicts || null;
    const sc = st.selfCheck || null;
    const layerRows = [
      ["L1 组合包声明", "dsh.bundle 或依赖 @deepseek-ai/*；官方内部模块/人工拉黑不进市场", "收录 " + fmtNum(st.index ? st.index.plugins : live.index.plugins) + (st.filters ? " · 挡掉 " + fmtNum(st.filters.notBundle) : "")],
      ["L2 归属认领", "npm 自述仓库 vs 认领仓库；两边一致才算确证", "确证 " + fmtNum((st.verdicts || live.index.verdicts).confirmed) + " · 待确认 " + fmtNum((st.verdicts || live.index.verdicts).unverified)],
      ["L3 目录实名", "目录里的 package.json 必须真的声明这个包名", ver ? "确证 " + fmtNum(ver.verified) + " / 待核 " + fmtNum(ver.targets) : "缓存 " + fmtNum(live.cache.entries) + " 条"],
      ["L4 目录字段一致", "package.json 自己的 repository 必须指向同一仓库（monorepo 相对路径忽略）", "随 L3 一起判"],
      ["L5 目录历史", "目录 404 时查提交历史：搬走 vs 从未存在", ver ? "搬走 " + fmtNum(ver.moved) + " · 不存在 " + fmtNum(ver.missing) + " · 本地路径 " + fmtNum(ver.local) : "—"],
      ["L6 code search 兜底", "没有 repository.directory 的高星候选：仓库里搜 package.json 并核 name", "结论 " + fmtNum(live.cache.codeSearch) + (ver && ver.codeAbsent ? " · 驳回 " + fmtNum(ver.codeAbsent) : "")],
      ["L7 npm 发布溯源", "SLSA provenance（GitHub Actions OIDC 签名）：溯源仓库必须等于声称仓库", prov ? "有溯源 " + fmtNum(prov.ok) + " · 无 " + fmtNum(prov.none) + (pv ? " · 一致 " + fmtNum(pv.match) + " / 不一致 " + fmtNum(pv.mismatch) : "") : "尚未跑过"],
      ["L8 人工裁决 / 名单", "人工裁决 > 名单 > 以上自动结论", "裁决 " + fmtNum(live.overrides.entries) + " 条 · 命中 " + fmtNum(Object.values(st.overrides || {}).reduce((a, b) => a + b, 0))],
      ["L9 索引不变量自检", "包名唯一 / title=包名 / 版本与标签合法 / 仓库地址格式", sc ? (sc.violations ? "✗ " + fmtNum(sc.violations) + " 条违规" : "✓ 通过") : "—"],
    ];
    const lt = tableWrap([{ text: "层" }, { text: "校验内容" }, { text: "本次结果" }], { fixed: true });
    for (const row of layerRows) {
      const tr = el("tr");
      tr.append(el("td", "mono", row[0]), el("td", "sub", row[1]), el("td", "sub", row[2]));
      lt.tbody.append(tr);
    }
    layers.append(lt.wrap);
    page.append(layers);

    const build = section("最近一次构建");
    const lb = data.lastBuild || {};
    if (lb.stats) {
      const kv2 = kvList();
      kv2.put("作业", lb.jobId);
      kv2.put("状态", lb.status);
      kv2.put("开始", fmtTime(lb.startedAt));
      kv2.put("结束", fmtTime(lb.finishedAt));
      kv2.put("耗时", lb.durationMs ? Math.round(lb.durationMs / 1000) + " 秒" : "—");
      kv2.put("统计来源", lb.statsSource);
      if (lb.stats.seed !== null && lb.stats.seed !== undefined) kv2.put("随机种子", lb.stats.seed);
      if (lb.stats.timings) {
        const t = lb.stats.timings;
        kv2.put("阶段耗时", "registry " + Math.round((t.registryMs || 0) / 1000) + "s · 核验 " + Math.round((t.verifyMs || 0) / 1000) + "s · 组装 " + Math.round((t.assembleMs || 0) / 1000) + "s · 合计 " + Math.round((t.totalMs || 0) / 1000) + "s");
      }
      build.append(kv2.box);
      const filterFacts = el("div", "res-facts");
      const addFact = (label, value) => {
        if (value === null || value === undefined) return;
        const f = el("span", "fact");
        f.append(el("i", null, label), el("b", null, fmtNum(value)));
        filterFacts.append(f);
      };
      if (lb.stats.filters) {
        addFact("收录", lb.stats.index && lb.stats.index.plugins);
        addFact("不是 DSH 包", lb.stats.filters.notBundle);
        addFact("官方模块", lb.stats.filters.officialModule);
        addFact("人工拉黑", lb.stats.filters.manualBlacklist);
        addFact("无 packument", lb.stats.filters.noPackument);
      }
      if (lb.stats.verification) {
        addFact("核验确证", lb.stats.verification.verified);
        addFact("目录搬走", lb.stats.verification.moved);
        addFact("目录不存在", lb.stats.verification.missing);
        addFact("本地路径", lb.stats.verification.local);
        addFact("code search 结论", lb.stats.verification.codeSearchCached);
        if (lb.stats.provenance) {
          addFact("有发布溯源", lb.stats.provenance.ok);
          addFact("溯源一致", lb.stats.provenanceVerdicts ? lb.stats.provenanceVerdicts.match : null);
          addFact("溯源不一致", lb.stats.provenanceVerdicts ? lb.stats.provenanceVerdicts.mismatch : null);
        }
        if (lb.stats.selfCheck) addFact("不变量违规", lb.stats.selfCheck.violations);
      }
      build.append(filterFacts);
      if (lb.skippedTop && lb.skippedTop.length) {
        build.append(el("p", "sec-sub", "被挡掉的候选（前 " + lb.skippedTop.length + " 条，共 " + fmtNum(lb.stats.skipped && lb.stats.skipped.total) + "）"));
        const t = tableWrap([{ text: "包名" }, { text: "原因" }], { fixed: true });
        for (const row of lb.skippedTop) {
          const tr = el("tr");
          tr.append(el("td", "mono", row.pkg), el("td", "sub", row.why));
          t.tbody.append(tr);
        }
        build.append(t.wrap);
      }
    } else {
      build.append(el("p", "hint", "还没有结构化构建统计（build-stats.json）。下一次「构建与发布 → 重建索引」后这里会显示每阶段的进出数字与挡掉的候选。"));
    }
    page.append(build);

    const cache = section("校验缓存状态");
    const cacheStates = Object.entries(live.cache.states || {});
    if (cacheStates.length) {
      const t = tableWrap([{ text: "状态" }, { text: "条目", cls: "num" }], { fixed: true });
      for (const [stateName, count] of cacheStates) {
        const tr = el("tr");
        tr.append(el("td", "mono", stateName), el("td", "num", fmtNum(count)));
        t.tbody.append(tr);
      }
      cache.append(t.wrap);
      cache.append(el("p", "hint", "确证/不存在 7 天有效，错误/暂无数 6 小时后重试；90 天没再出现的结论会被清理。"));
    } else {
      cache.append(el("p", "hint", "还没有校验缓存记录。"));
    }
    page.append(cache);
  }

  // ---------------- 复核台 ----------------

  async function renderReview() {
    const page = pages.get("review");
    const data = await request("api/market/queue?type=" + encodeURIComponent(state.queueType) + "&size=200");
    clear(page);

    const bar = section("复核队列", [btn("刷新", "small", () => renderReview().catch((e) => toast(e && e.message ? e.message : "加载失败", "err")))]);
    const filters = el("div", "form-row");
    for (const q of QUEUE_TYPES) {
      filters.append(btn(q.label, "small" + (q.id === state.queueType ? " primary" : ""), () => {
        state.queueType = q.id;
        state.detail = null;
        renderReview().catch((e) => toast(e && e.message ? e.message : "加载失败", "err"));
      }));
    }
    filters.append(el("span", "hint", "共 " + fmtNum(data.total) + " 条"));
    bar.append(filters);
    page.append(bar);

    const layout = el("div", "mk-review");
    const left = el("div");
    const t = tableWrap([{ text: "包名" }, { text: "判定" }, { text: "原因" }, { text: "声称仓库" }]);
    for (const r of data.rows) {
      const tr = el("tr", state.detail && state.detail.name === r.name ? "mark" : null);
      const nameTd = el("td", "mono");
      nameTd.append(el("span", null, r.name));
      const verdictTd = el("td");
      verdictTd.append(badge(VERDICT_TEXT[r.verdict] || r.verdict, VERDICT_CLASS[r.verdict] || ""));
      tr.append(nameTd, verdictTd, el("td", "sub", dash(r.reason)), el("td", "mono", dash(r.repository)));
      tr.addEventListener("click", async () => {
        for (const x of t.tbody.querySelectorAll("tr")) x.classList.remove("mark");
        tr.classList.add("mark");
        try {
          const detail = await request("api/market/plugin?name=" + encodeURIComponent(r.name));
          state.detail = detail;
          renderDetail(detailBox, detail);
        } catch (e) {
          toast(e && e.message ? e.message : "加载失败", "err");
        }
      });
      t.tbody.append(tr);
    }
    if (!data.rows.length) emptyRow(t.tbody, 4, "这个队列是空的");
    left.append(t.wrap);
    const detailBox = el("div", "res-detail");
    if (state.detail) renderDetail(detailBox, state.detail);
    else detailBox.append(el("p", "hint", "点左边一条看证据并裁决。"));
    layout.append(left, detailBox);
    page.append(layout);
  }

  function renderDetail(box, detail) {
    clear(box);
    const ev = detail.evidence || {};
    const head = el("div", "res-facts");
    const nameFact = el("span", "fact");
    nameFact.append(el("i", null, "包名"), el("b", "mono", detail.name));
    const verdictFact = el("span", "fact");
    verdictFact.append(el("i", null, "当前判定"), badge(VERDICT_TEXT[detail.verdict] || detail.verdict || "—", VERDICT_CLASS[detail.verdict] || ""));
    head.append(nameFact, verdictFact);
    box.append(head);

    const kv = kvList();
    kv.put("判定原因", ev.reason);
    kv.put("证据来源", ev.source);
    kv.put("npm 发布者", ev.publisher);
    kv.put("声称仓库", ev.repoId);
    kv.put("声称目录", ev.directory);
    kv.put("缓存结论", ev.check ? ev.check.state + (ev.check.reason ? "（" + ev.check.reason + "）" : "") : "无缓存记录");
    kv.put("人工裁决", detail.manual ? detail.manual.decision + (detail.manual.reason ? "：" + detail.manual.reason : "") : "未裁决");
    if (detail.entry) {
      kv.put("当前标题", detail.entry.title);
      kv.put("当前作者", detail.entry.author);
      kv.put("当前星标", fmtNum((detail.entry.metadata && detail.entry.metadata.sortKeys && detail.entry.metadata.sortKeys.stars) || 0));
      kv.put("当前版本", (detail.entry.versions && detail.entry.versions[0] && detail.entry.versions[0].version) || "—");
      kv.put("安装目标", detail.install);
    }
    box.append(kv.box);

    const actions = el("div", "form-row");
    const reason = el("input", "input note");
    reason.type = "text";
    reason.placeholder = "裁决备注（可选，进审计）";
    const submit = (decision) => async () => {
      try {
        const result = await post("api/market/decision", { name: detail.name, decision, reason: reason.value });
        toast("已记录：" + detail.name + "。" + (result.impact || ""), "ok");
        await renderReview();
      } catch (e) {
        toast(e && e.message ? e.message : "保存失败", "err");
      }
    };
    actions.append(
      reason,
      btn("确认归属", "primary small", submit("confirmed")),
      btn("驳回", "danger small", submit("refuted")),
      btn("标记未核实", "small", submit("unverified")),
      confirmButton("恢复自动", "撤销人工裁决后按自动核验结果展示，确认？", async () => {
        try {
          await post("api/market/decision", { name: detail.name, remove: true });
          toast("已撤销人工裁决：" + detail.name, "ok");
          await renderReview();
        } catch (e) {
          toast(e && e.message ? e.message : "撤销失败", "err");
        }
      }, { cls: "small" }),
    );
    box.append(actions);
    box.append(el("p", "hint", "裁决只写 overrides.json；去「构建与发布」重建 → 看差异 → 发布后才进入线上索引。"));
  }

  // ---------------- 构建与发布 ----------------

  async function renderBuild() {
    const page = pages.get("build");
    const data = await request("api/market/build");
    const job = data.job || {};
    clear(page);

    const rebuild = btn(job.status === "running" ? "构建中…" : "重建索引", "primary small", async () => {
      try {
        const res = await post("api/market/build", { limit: 20000, concurrency: 4 });
        toast("已提交构建：" + ((res.job && res.job.id) || ""), "ok");
        stopTimer();
        state.timer = setTimeout(() => renderBuild().catch(() => {}), 1500);
      } catch (e) {
        toast(e && e.message ? e.message : "提交失败", "err");
      }
    });
    if (job.status === "running") rebuild.disabled = true;
    const bar = section("构建草稿", [
      rebuild,
      btn("刷新", "small", () => renderBuild().catch((e) => toast(e && e.message ? e.message : "加载失败", "err"))),
    ]);
    bar.append(el("p", "sec-sub", "构建只写草稿（data/admin/market-index/drafts/<jobId>/），不会动线上 dist；采集器在跑时会拒绝。"));
    const kv = kvList();
    if (job.id) {
      kv.put("作业", job.id);
      kv.put("状态", job.status);
      kv.put("开始", fmtTime(job.startedAt));
      kv.put("结束", fmtTime(job.finishedAt));
      kv.put("退出码", job.exitCode === null || job.exitCode === undefined ? "—" : job.exitCode);
      if (job.plugins !== undefined && job.plugins !== null) kv.put("草稿条目", fmtNum(job.plugins));
      if (job.stats) kv.put("判定分布", "确证 " + fmtNum(job.stats.confirmed) + " · 待确认 " + fmtNum(job.stats.unverified) + " · 驳回 " + fmtNum(job.stats.refuted) + " · 人工 " + fmtNum(job.stats.manual));
      if (job.note) kv.put("备注", job.note);
      bar.append(kv.box);
      if (job.log) {
        const details = el("details", "raw");
        details.append(el("summary", null, "构建日志（尾部）"));
        const pre = el("pre", "log");
        pre.textContent = (job.logTail || []).join("\n");
        details.append(pre);
        bar.append(details);
      }
      if (job.status === "running") {
        stopTimer();
        state.timer = setTimeout(() => renderBuild().catch(() => {}), 3000);
      }
    } else {
      bar.append(el("p", "hint", "还没有构建记录。点「重建索引」生成一版待发布产物。"));
    }
    page.append(bar);

    if (job.id && job.status === "done") {
      let diff = null;
      try {
        diff = await request("api/market/diff?jobId=" + encodeURIComponent(job.id));
      } catch (e) {
        const fail = section("差异预览");
        fail.append(el("p", "hint", "差异计算失败：" + (e && e.message ? e.message : e)));
        page.append(fail);
      }
      if (diff) {
        const brief = diff.brief || {};
        const sec = section("差异预览", [
          confirmButton("发布这一版", "发布会原子替换线上 dist/market/index.json（先备份到 history）。确认发布？", async () => {
            try {
              const res = await post("api/market/publish", { jobId: job.id, confirm: true });
              toast("已发布 " + fmtNum(res.plugins) + " 条，备份 " + res.backupTs, "ok");
              await renderBuild();
            } catch (e) {
              toast(e && e.message ? e.message : "发布失败", "err");
            }
          }, { cls: "primary", confirmLabel: "确认发布" }),
        ]);
        sec.append(el("p", "sec-sub", "草稿 " + fmtNum(diff.draft && diff.draft.plugins) + " 条 · 线上 " + fmtNum(diff.current && diff.current.plugins) + " 条"));
        const facts = el("div", "res-facts");
        for (const [key, label] of [["added", "新增"], ["removed", "移除"], ["identityChanged", "身份变化"], ["labelChanged", "标签变化"], ["titleChanged", "标题变化"]]) {
          const f = el("span", "fact");
          f.append(el("i", null, label), el("b", null, fmtNum(brief[key] || 0)));
          facts.append(f);
        }
        sec.append(facts);
        const group = (title, rows, renderRow, headers) => {
          if (!rows || !rows.length) return;
          const box = el("div", "mk-diff-rows");
          box.append(el("p", "sec-sub", title + "（" + fmtNum(rows.length) + "）"));
          const t = tableWrap(headers || [{ text: "包名" }, { text: "变化" }], { fixed: true });
          for (const r of rows.slice(0, 20)) {
            const tr = el("tr");
            renderRow(tr, r);
            t.tbody.append(tr);
          }
          if (rows.length > 20) emptyRow(t.tbody, 2, "…还有 " + fmtNum(rows.length - 20) + " 条");
          box.append(t.wrap);
          sec.append(box);
        };
        group("身份变化", diff.diff.identityChanged, (tr, r) => {
          tr.append(el("td", "mono", r.name), el("td", "sub", "作者 " + dash(r.author.before) + " → " + dash(r.author.after) + " · 星标 " + fmtNum(r.stars.before) + " → " + fmtNum(r.stars.after)));
        });
        group("移除", diff.diff.removed, (tr, r) => tr.append(el("td", "mono", r.name), el("td", "sub", "不再收录")));
        group("新增", diff.diff.added, (tr, r) => tr.append(el("td", "mono", r.name), el("td", "sub", "新条目")));
        group("标签变化", diff.diff.labelChanged, (tr, r) => tr.append(el("td", "mono", r.name), el("td", "sub", dash(r.before) + " → " + dash(r.after))));
        group("标题变化", diff.diff.titleChanged, (tr, r) => tr.append(el("td", "mono", r.name), el("td", "sub", dash(r.before) + " → " + dash(r.after))));
        page.append(sec);
      }
    }

    const hist = section("发布历史", [btn("刷新", "small", () => renderBuild().catch((e) => toast(e && e.message ? e.message : "加载失败", "err")))]);
    try {
      const hdata = await request("api/market/history");
      const t = tableWrap([{ text: "时间" }, { text: "条目", cls: "num" }, { text: "体积", cls: "num" }, { text: "操作", cls: "cell-actions" }], { fixed: true });
      for (const h of hdata.history || []) {
        const tr = el("tr");
        const act = el("td", "cell-actions");
        act.append(confirmButton("回滚", "回滚到 " + h.ts + "：会把线上 dist 换成该历史版本（当前版本先备份）。确认？", async () => {
          try {
            const res = await post("api/market/rollback", { ts: h.ts, confirm: true });
            toast("已回滚到 " + res.ts + "：" + fmtNum(res.plugins) + " 条", "ok");
            await renderBuild();
          } catch (e) {
            toast(e && e.message ? e.message : "回滚失败", "err");
          }
        }, { cls: "small", confirmLabel: "确认回滚" }));
        tr.append(el("td", "mono", h.ts), el("td", "num", h.plugins === null ? "—" : fmtNum(h.plugins)), el("td", "num", fmtBytes(h.bytes)), act);
        t.tbody.append(tr);
      }
      if (!(hdata.history || []).length) emptyRow(t.tbody, 4, "还没有发布历史");
      hist.append(t.wrap);
    } catch (e) {
      hist.append(el("p", "hint", "读取历史失败：" + (e && e.message ? e.message : e)));
    }
    page.append(hist);
  }

  return {
    async refresh() {
      await render();
      return true;
    },
    switchPage,
  };
}
