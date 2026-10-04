/**
 * 顶栏状态圆环 + 浮窗（v0.4.7）。
 *
 * 圆环 = 下一次扫描开始的倒计时：进度 = 已等待 / 采集周期，所以环满即开扫。
 * 点开浮窗看后端进度：当前阶段、分段进度、请求与配额、README 索引、上一轮耗时。
 *
 * 数据来自站点 /api/status（读采集器写的 data/cache/status.json）。拿不到就显示"无采集器状态"，
 * 环保持空环 —— 本地纯静态预览、或采集器没在跑时都是这个样子。
 */

const RING_LEN = 2 * Math.PI * 15.5; // ≈97.4，与 styles.css 的 stroke-dasharray 对齐
const DEFAULT_INTERVAL_S = 3600;
const STATE_TEXT = { crawling: "采集中", building: "构建中", precomputing: "预计算", idle: "空闲", error: "出错" };
const PHASE_TEXT = { segments: "抓取分段", readme: "抓 README", build: "构建索引", write: "写快照", precompute: "预计算布局" };

const pad2 = (n) => String(n).padStart(2, "0");

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
  const s = Math.max(0, Math.round(seconds));
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
 * @param {HTMLElement} opts.chip   顶栏圆环按钮
 * @param {HTMLElement} opts.panel  浮窗容器
 * @param {Function} [opts.fetcher] 拉 /api/status；缺省或抛错时降级为"无采集器状态"
 * @param {number} [opts.pollMs]    轮询间隔（毫秒）
 */
export function createStatusWidget({ chip, panel, fetcher, pollMs = 15000, now = () => Date.now() }) {
  let snapshot = null; // /api/status 的响应
  let skewMs = 0; // 服务器时间 - 本地时间，用来校正倒计时
  let open = false;
  let pollTimer = null;
  let tickTimer = null;

  const ringFill = chip?.querySelector?.(".ring-fill") ?? null;

  const status = () => snapshot?.status ?? null;
  const serverNow = () => now() + skewMs;

  function nextRunMs() {
    const iso = status()?.nextRunAt;
    const t = Date.parse(iso ?? "");
    return Number.isFinite(t) ? t : null;
  }

  function remainingMs() {
    const t = nextRunMs();
    return t === null ? null : t - serverNow();
  }

  /** 环进度：0 = 刚进入等待，1 = 马上开扫 */
  function ringProgress() {
    const interval = (status()?.roundSeconds || DEFAULT_INTERVAL_S) * 1000;
    const left = remainingMs();
    if (left === null || interval <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - left / interval));
  }

  /** 倒计时文案：到点（或状态文件偏旧）时不要显示负数 */
  function countdownText() {
    const left = remainingMs();
    if (left === null) return "—";
    return left <= 1000 ? "即将开始" : formatCountdown(left) + " 后";
  }

  function chipTitle() {
    const s = status();
    if (!s) return "采集状态：无采集器状态（本地预览或采集器未运行）";
    const state = STATE_TEXT[s.state] ?? s.state ?? "未知";
    if (s.state === "crawling" || s.state === "building") return "采集状态：" + state + "，本轮结束约 " + formatCountdown(remainingMs()) + " 后";
    return "采集状态：" + state + "，下次扫描 " + countdownText();
  }

  function row(label, value) {
    const line = el("div", "sp-row");
    line.append(el("i", null, label), el("b", null, value));
    return line;
  }

  function renderPanel() {
    if (!panel) return;
    panel.textContent = "";
    const s = status();
    const mesh = snapshot?.data ?? null;
    panel.append(el("h4", null, "采集状态"));

    if (!s) {
      panel.append(el("div", "sp-note", "拿不到采集器状态。可能是本地静态预览，或后端采集器没在运行。"));
      return;
    }

    const state = STATE_TEXT[s.state] ?? s.state ?? "未知";
    const interval = s.roundSeconds || DEFAULT_INTERVAL_S;
    panel.append(row("后端", state + (s.error ? "（" + String(s.error).slice(0, 60) + "）" : "")));
    const left = countdownText();
    panel.append(row(s.state === "idle" ? "下次扫描" : "本轮结束", s.state === "idle" ? left : "约 " + left));
    if (s.phase) panel.append(row("阶段", PHASE_TEXT[s.phase] ?? s.phase));
    if (s.roundStartedAt) panel.append(row("本轮开始", formatClock(s.roundStartedAt) + "（周期 " + Math.round(interval / 60) + " 分）"));

    const line = [];
    if (s.fetched !== null && s.fetched !== undefined) line.push("抓到 " + s.fetched + " 条");
    if (s.added) line.push("新增 " + s.added);
    if (line.length) panel.append(row("本轮", line.join(" · ")));

    const seg = s.segments;
    if (seg && seg.total) {
      panel.append(row("分段", "已抓 " + (seg.done ?? 0) + " / " + seg.total + (seg.pending ? "（待抓 " + seg.pending + "）" : "")));
    }
    if (s.requests !== null && s.requests !== undefined) {
      panel.append(
        row("请求", s.requests + (s.budget ? " / 预算 " + s.budget : "") + (s.quotaRemaining !== null && s.quotaRemaining !== undefined ? " · 配额余 " + s.quotaRemaining : "")),
      );
    }

    panel.append(el("div", "sp-sep"));
    if (s.indexed) panel.append(row("累积索引", s.indexed + " 个仓库"));
    if (mesh) panel.append(row("前端数据", mesh.nodes + " 个节点 · " + formatClock(mesh.generatedAt)));
    const readme = s.readme;
    if (readme && readme.target) {
      const done = readme.indexed ?? 0;
      panel.append(row("README 索引", done + " / " + readme.target + " 篇"));
      const bar = el("div", "sp-bar");
      const fill = el("span");
      fill.style.width = Math.min(100, Math.round((done / readme.target) * 100)) + "%";
      bar.append(fill);
      panel.append(bar);
    }
    if (s.lastRound?.finishedAt) {
      panel.append(
        row("上一轮", formatClock(s.lastRound.startedAt) + " → " + formatClock(s.lastRound.finishedAt) + "（" + formatDuration(s.lastRound.seconds) + "）"),
      );
    }

    // 状态文件太久没动 = 采集器可能没在跑。与其显示一个过期的"采集中"，不如直说。
    const updated = Date.parse(s.updatedAt ?? "");
    if (Number.isFinite(updated)) {
      const staleMin = Math.round((serverNow() - updated) / 60000);
      if (staleMin >= 10) panel.append(el("div", "sp-note", "状态已 " + staleMin + " 分钟未更新，采集器可能没在运行。"));
    }
  }

  /** 每秒只动环与标题；浮窗内容在打开时与刷新后重建 */
  function render() {
    const p = ringProgress();
    if (ringFill) ringFill.style.strokeDashoffset = String(RING_LEN * (1 - p));
    const state = status()?.state;
    chip?.classList?.toggle?.("crawling", state === "crawling" || state === "building" || state === "precomputing");
    chip?.classList?.toggle?.("error", state === "error");
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

  /**
   * 浮窗默认由 CSS 相对圆环水平居中；只有在贴到视口边缘时（圆环很靠右/很靠左）
   * 才改成贴边，避免浮窗被切掉。测不到视口宽度（Node 桩）时保持 CSS 居中。
   */
  function positionPanel() {
    const rect = chip?.getBoundingClientRect?.();
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
    chip?.setAttribute?.("aria-expanded", open ? "true" : "false");
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

  return { start, stop, refresh, render, setOpen, toggle: () => setOpen(!open), isOpen: () => open, snapshot: () => snapshot };
}
