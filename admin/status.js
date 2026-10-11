/**
 * 采集状态圆环 + 浮窗（管理后台版）：圆环 = 下一次扫描的倒计时（环满即开扫）。
 *
 * 独立于公开页自带一份，绝不能 import 公开页任何模块（公开页删掉这组件也不影响这里）。
 * 数据来自 GET api/status：raw 就是采集器写的 status.json；拿不到就显示"拿不到采集器状态"、环保持空环。
 */

const RING_LEN = 2 * Math.PI * 15.5; // ≈97.4，与 admin.css 的 stroke-dasharray 对齐
const DEFAULT_INTERVAL_S = 3600;

export const STATE_TEXT = { crawling: "采集中", building: "构建中", precomputing: "预计算", idle: "空闲", error: "出错" };
/** 「正在进行」的三种后端状态：界面上的进行中色 / 转动动画都以它为准 */
export const RUNNING_STATES = ["crawling", "building", "precomputing"];
export const PHASE_TEXT = { segments: "抓取分段", readme: "读 README", build: "构建索引", write: "写快照", precompute: "预计算布局" };

const pad2 = (n) => String(n).padStart(2, "0");

/** 只认自有键，否则 sort=__proto__ 这类值会把原型属性当状态文案 */
function lookup(map, key) {
  if (key === null || key === undefined) return null;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

export function stateText(state) {
  return lookup(STATE_TEXT, state) || (state ? String(state) : "未知");
}

/** 采集/构建/预计算进行中？空闲与出错都不算 */
export function isRunningState(state) {
  return RUNNING_STATES.includes(state);
}

export function phaseText(phase) {
  return lookup(PHASE_TEXT, phase) || (phase ? String(phase) : "—");
}

export function formatCountdown(ms) {
  if (ms === null || ms === undefined) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
}

export function formatClock(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return s + " 秒";
  const m = Math.floor(s / 60);
  return m < 60 ? m + " 分 " + pad2(s % 60) + " 秒" : Math.floor(m / 60) + " 时 " + pad2(m % 60) + " 分";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.chip     顶栏圆环按钮
 * @param {HTMLElement} opts.panel    浮窗容器
 * @param {HTMLElement} [opts.labelEl] 圆环右侧文字（显示当前后端状态）
 * @param {Function} [opts.fetcher]   拉 api/status；抛错时保留上一次快照
 * @param {number} [opts.pollMs]      轮询间隔（毫秒）
 */
export function createStatusWidget({ chip, panel, labelEl, fetcher, pollMs = 15000, now = () => Date.now() }) {
  let snapshot = null; // api/status 的响应
  let skewMs = 0; // 服务器时间 - 本地时间，用来校正倒计时
  let open = false;
  let pollTimer = null;
  let tickTimer = null;

  const ringFill = chip && typeof chip.querySelector === "function" ? chip.querySelector(".ring-fill") : null;

  /** raw 才是采集器写的状态；接口直接返回 status.json 时也能兜住 */
  const status = () => {
    if (!snapshot || typeof snapshot !== "object") return null;
    return snapshot.raw && typeof snapshot.raw === "object" ? snapshot.raw : snapshot;
  };

  /** 校正后的服务器时间：倒计时必须按它算，本地时钟偏了也不会数错 */
  const serverNow = () => now() + skewMs;

  function nextRunMs() {
    const t = Date.parse(status()?.nextRunAt ?? "");
    return Number.isFinite(t) ? t : null;
  }

  function remainingMs() {
    const t = nextRunMs();
    return t === null ? null : t - serverNow();
  }

  /** 环进度：0 = 刚进入等待，1 = 马上开扫 */
  function ringProgress() {
    const interval = (Number(status()?.roundSeconds) || DEFAULT_INTERVAL_S) * 1000;
    const left = remainingMs();
    if (left === null || interval <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - left / interval));
  }

  /** 倒计时文案：到点（或状态文件偏旧）时不能显示负数 */
  function countdownText() {
    const left = remainingMs();
    if (left === null) return "—";
    return left <= 1000 ? "即将开始" : formatCountdown(left) + " 后";
  }

  function chipTitle() {
    const s = status();
    if (!s) return "采集状态：拿不到采集器状态";
    const label = stateText(s.state);
    if (s.state === "crawling" || s.state === "building" || s.state === "precomputing") {
      return "采集状态：" + label + "，本轮结束约 " + formatCountdown(remainingMs()) + " 后";
    }
    return "采集状态：" + label + "，下次扫描 " + countdownText();
  }

  function row(label, value) {
    const line = el("div", "sp-row");
    line.append(el("i", null, label), el("b", null, value));
    return line;
  }

  /** 进度条 + 右侧百分比：没有分母（缺失 / 0）时显示「—」并归零，不假装有进度 */
  function bar(done, total) {
    const row = el("div", "sp-bar-row");
    const box = el("div", "sp-bar");
    const fill = el("span");
    const d = Number(done);
    const t = Number(total);
    const has = Number.isFinite(d) && Number.isFinite(t) && t > 0;
    const pct = has ? Math.max(0, Math.min(100, Math.round((d / t) * 100))) : 0;
    fill.style.width = pct + "%"; // CSSOM 赋值，不受 CSP style-src 影响
    // 与主进度条同一套「中间断开」规则：--pct 给 ::after 定位，边界态交给两个类
    if (box.style && typeof box.style.setProperty === "function") box.style.setProperty("--pct", pct + "%");
    box.classList.toggle("is-empty", pct <= 0);
    box.classList.toggle("is-full", pct >= 100);
    box.append(fill);
    row.append(box, el("b", "sp-pct" + (has ? "" : " none"), has ? pct + "%" : "—"));
    return row;
  }

  /** 浮窗内容：打开时与每次刷新后重建（节点很少，重建比逐项改字简单） */
  function renderPanel() {
    if (!panel) return;
    panel.textContent = "";
    const s = status();
    panel.append(el("h4", null, "采集状态"));

    if (!s) {
      panel.append(el("div", "sp-note", "拿不到采集器状态：后端可能没在运行。"));
      return;
    }

    const label = stateText(s.state);
    panel.append(row("后端", label + (s.error ? "（" + String(s.error).slice(0, 60) + "）" : "")));
    const left = countdownText();
    panel.append(row(s.state === "idle" ? "下次扫描" : "本轮结束", s.state === "idle" ? left : "约 " + left));
    if (s.phase) panel.append(row("阶段", phaseText(s.phase)));
    if (s.roundStartedAt) panel.append(row("本轮开始", formatClock(s.roundStartedAt)));
    if (s.roundSeconds) panel.append(row("采集周期", Math.round(Number(s.roundSeconds) / 60) + " 分钟"));

    const line = [];
    if (s.fetched !== null && s.fetched !== undefined) line.push("抓到 " + s.fetched + " 条");
    if (s.added) line.push("新增 " + s.added);
    if (line.length) panel.append(row("本轮", line.join(" · ")));

    const seg = s.segments;
    if (seg && seg.total) {
      panel.append(row("分段", "已抓 " + (seg.done ?? 0) + " / " + seg.total + (seg.pending ? "（待抓 " + seg.pending + "）" : "")));
      panel.append(bar(Number(seg.done) || 0, Number(seg.total) || 0));
    }
    if (s.requests !== null && s.requests !== undefined) {
      panel.append(
        row(
          "请求",
          s.requests
            + (s.budget ? " / 预算 " + s.budget : "")
            + (s.quotaRemaining !== null && s.quotaRemaining !== undefined ? " · 配额余 " + s.quotaRemaining : ""),
        ),
      );
    }

    panel.append(el("div", "sp-sep"));
    if (s.indexed !== null && s.indexed !== undefined) panel.append(row("累积索引", s.indexed + " 个仓库"));
    const readme = s.readme;
    if (readme && readme.target) {
      const done = readme.indexed ?? 0;
      panel.append(row("README 索引", done + " / " + readme.target + " 篇"));
      panel.append(bar(Number(done) || 0, Number(readme.target) || 0));
    }
    if (s.lastRound && s.lastRound.finishedAt) {
      panel.append(
        row(
          "上一轮",
          formatClock(s.lastRound.startedAt) + " → " + formatClock(s.lastRound.finishedAt) + "（" + formatDuration(s.lastRound.seconds) + "）",
        ),
      );
    }

    // 状态文件太久没动 = 采集器可能没在跑：与其显示一个过期的"采集中"，不如直说
    const staleMin = staleMinutes();
    if (staleMin !== null && staleMin >= 10) {
      panel.append(el("div", "sp-note", "状态已 " + staleMin + " 分钟未更新，采集器可能没在运行。"));
    }
  }

  /** 距上次状态写入多少分钟（优先用接口给的 stale/staleMinutes 口径） */
  function staleMinutes() {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : null;
    const s = status();
    const updated = Date.parse(s?.updatedAt ?? "");
    const byTime = Number.isFinite(updated) ? Math.round((serverNow() - updated) / 60000) : null;
    if (snap && snap.stale === true) {
      const m = Number(snap.staleMinutes);
      if (Number.isFinite(m)) return Math.max(m, byTime ?? 0);
      return byTime === null ? 10 : Math.max(byTime, 10);
    }
    return byTime;
  }

  /** 每秒只动环与标题；浮窗内容在打开时与刷新后重建（见 renderPanel） */
  function render() {
    const p = ringProgress();
    if (ringFill) ringFill.style.strokeDashoffset = String(RING_LEN * (1 - p));
    const s = status();
    const state = s?.state;
    if (labelEl) labelEl.textContent = s ? stateText(state) : "状态";
    if (chip && chip.classList) {
      chip.classList.toggle("crawling", isRunningState(state));
      chip.classList.toggle("error", state === "error");
    }
    if (chip) chip.title = chipTitle();
    if (open) renderPanel();
  }

  async function refresh() {
    if (typeof fetcher !== "function") {
      render();
      return;
    }
    try {
      const data = await fetcher();
      if (data && typeof data === "object") {
        snapshot = data;
        if (data.serverTime) {
          const t = Date.parse(data.serverTime);
          if (Number.isFinite(t)) skewMs = t - now();
        }
      }
    } catch {
      /* 接口不可用：保留上一次快照，环照旧走 */
    }
    render();
  }

  /** 浮窗默认由 CSS 相对圆环居中；贴到视口边缘时才改贴边，避免被切掉 */
  function positionPanel() {
    const rect = chip && typeof chip.getBoundingClientRect === "function" ? chip.getBoundingClientRect() : null;
    const viewport = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 0;
    if (!panel || !rect || !viewport) return;
    panel.style.left = "";
    panel.style.transform = "";
    const width = panel.offsetWidth || 320;
    const center = rect.left + rect.width / 2;
    const wanted = center - width / 2;
    const min = 8;
    const max = Math.max(min, viewport - width - 8);
    const clamped = Math.min(Math.max(wanted, min), max);
    if (Math.abs(clamped - wanted) > 0.5) {
      panel.style.left = Math.round(clamped - rect.left) + "px";
      panel.style.transform = "none";
    }
  }

  function setOpen(value) {
    open = !!value;
    if (panel) panel.hidden = !open;
    if (open) positionPanel();
    if (chip && typeof chip.setAttribute === "function") chip.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderPanel();
      refresh();
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      if (open) positionPanel();
    });
  }

  function start() {
    refresh();
    if (pollTimer === null) pollTimer = setInterval(refresh, pollMs);
    if (tickTimer === null) tickTimer = setInterval(render, 1000);
    // Node（测试）里定时器会拖住事件循环，显式放行；浏览器里返回数字，安全跳过
    pollTimer?.unref?.();
    tickTimer?.unref?.();
  }

  function stop() {
    if (pollTimer !== null) clearInterval(pollTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  return {
    start,
    stop,
    refresh,
    render,
    setOpen,
    toggle: () => setOpen(!open),
    isOpen: () => open,
    snapshot: () => snapshot,
    serverNow,
    staleMinutes,
  };
}
