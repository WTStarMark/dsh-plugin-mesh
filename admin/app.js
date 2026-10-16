/**
 * 管理后台主程序（原生 ES 模块 + DOM，零依赖零构建）：登录层、六个标签页、取数与写操作。
 *
 * 页面挂在 {P}/ 下，所有请求与资源一律用相对 URL（fetch("api/session")、href="admin.css"），绝不带前导 /。
 * 安全约束：CSP 是 default-src 'self' —— 不写内联脚本/样式、不引外链资源，
 * 所有用户可控文本一律走 textContent / createElement，绝不拼 HTML 字符串。
 */

import {
  createStatusWidget,
  formatClock,
  formatCountdown,
  formatDuration,
  isRunningState,
  phaseText,
  stateText,
} from "./status.js";

/* ---------------- 常量 ---------------- */

/** 固定五段流水线：服务端 phases 只用来覆盖 label/desc，顺序以这里为准 */
const PIPELINE = [
  { id: "segments", label: "抓分段", desc: "按 star 区间分段抓取仓库" },
  { id: "readme", label: "读 README", desc: "拉取并索引 README 摘要" },
  { id: "build", label: "构建索引", desc: "合并去重、分类与相关性判定" },
  { id: "write", label: "写快照", desc: "写入版本快照与前端数据" },
  { id: "precompute", label: "预计算布局", desc: "预先算好扇区与画布坐标" },
];

const APPLY_HINT = "已保存，需要点『立即应用』重算一次才会生效";

const APPLY_STATUS_TEXT = { idle: "空闲", running: "进行中", done: "已完成", failed: "失败" };

const APPLY_POLL_MS = 3000;
/** 状态页可见时的自动刷新：空闲 10 秒、有作业在跑 3 秒（切走就停） */
const STATUS_POLL_MS = 10000;
const STATUS_POLL_BUSY_MS = 3000;
const STATUS_FETCH_MIN_GAP_MS = 4000;

/* ---------------- 全局状态 ---------------- */

const state = {
  csrf: "",
  authed: false,
  tab: "status",
  status: null, // GET api/status
  statusError: "",
  overview: null,
  workflow: null,
  lists: null,
  settings: null, // GET api/settings：采集参数当前值 + 默认值 + 范围
  settingsDraft: null, // 设置页的编辑草稿（未保存）
  resonance: null,
  audit: null,
  repos: { items: [], total: 0, limit: 20, offset: 0, q: "", loaded: false },
  whitelistDraft: null,
  collectorBlock: null, // 采集器占用：{state, phase, ageMinutes}
  logs: null, // GET api/logs 的兜底日志清单
  resonanceSelectedId: null, // 左栏选中的基座 id（null = 右栏显示新增表单）
  resonanceShowNew: false, // 右栏是否强制显示「新增基座」
  resonanceNew: null, // 新增基座表单草稿：{id,label,tag,enabled,probes,packages,context}
};

/** 已挂载视图的 DOM 引用；null = 还没建过 */
const V = { status: null, data: null, workflow: null, lists: null, settings: null, resonance: null, audit: null };

let widget = null;
let tickTimer = null;
let loginLockTimer = null;
let toastTimer = null;

/* ---------------- 应用变更（离线重建）的全局状态 ---------------- */

/**
 * 作业来自 GET api/apply（api/status 的 applying 是同一份数据）：状态页 / 共鸣页 / 名单页的提示条
 * 与顶栏「重建中」指示全部从这一份渲染，所以进度与收尾跟当前停在哪个标签页无关。
 */
const applyJob = {
  job: null, // 最近一次作业快照；null = 没有作业
  submitting: false, // POST api/apply 在途
  seenRunning: false, // 见过 running（"running → 结束"的收尾判定用）
  finishedId: null, // 已经收尾过的作业（api/apply 与 api/status 两条线不重复收尾）
  error: null, // 提交失败：{message, kind}
  savedHint: false, // 刚保存过、还没应用（服务端 pending 刷新前的本地兜底）
  savedAt: 0,
  startedMs: null, // 作业开始时间的本地兜底（服务端 startedAt 缺失时用）
  timer: null, // 3 秒轮询定时器（只在作业在跑时存在）
};

let applyChip = null; // 顶栏「重建中」指示
let statusAutoTimer = null; // 状态页可见时的自动刷新
let statusFetchAt = 0; // 最近一次 api/status 取数完成的时刻
let statusFetchStartedAt = 0; // 最近一次 api/status 取数开始的时刻
let statusFetchPromise = null; // 进行中的 api/status 请求（并发合并用）
let resonanceSaving = 0; // 共鸣页在途保存计数
let whitelistSaving = false; // 白名单保存在途

/* ---------------- 通用工具 ---------------- */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  if (node) node.textContent = "";
}

function btn(label, cls, onClick) {
  const b = el("button", "btn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function dash(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/** 取值失败一律 null，避免 Number(null)===0 这种坑 */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(v) {
  const n = numOrNull(v);
  return n === null ? "—" : n.toLocaleString("zh-CN");
}

function fmtBytes(v) {
  const n = numOrNull(v);
  if (n === null || n < 0) return "—";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return (x >= 100 ? Math.round(x) : x.toFixed(1)) + " " + units[i];
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 时间字段兼容三种写法：ISO 字符串、epoch 毫秒数、Date.parse 能吃下的字符串 */
function toDate(v) {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v);
  const t = Date.parse(v ?? "");
  return Number.isFinite(t) ? new Date(t) : null;
}

function fmtDateTime(iso) {
  const d = toDate(iso);
  if (!d) return "—";
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
  );
}

/** 人类可读的相对时间；未来时间或算不出来就返回空串（调用方只显示绝对时间） */
function fmtRelative(v) {
  const d = toDate(v);
  if (!d) return "";
  const diff = serverNow() - d.getTime();
  if (diff < 0) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.floor(hours / 24);
  return days < 30 ? days + " 天前" : "";
}

/** 绝对时间 + 相对时间：2026-10-10 18:55（3 分钟前） */
function fmtWhen(v) {
  const abs = fmtDateTime(v);
  if (abs === "—") return "—";
  const rel = fmtRelative(v);
  return rel ? abs + "（" + rel + "）" : abs;
}

/** 字段名不确定时按候选顺序取第一个有值的（后台接口字段可能缺失） */
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  return numOrNull(v) === null ? undefined : numOrNull(v);
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function detailText(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ---------------- DOM 小部件 ---------------- */

/** 统计指标：primary = 主指标（面板族，跨 2 列、32px）；其余是裸排版族（只靠竖 hairline 分隔） */
function statCard(parent, label, primary) {
  const box = el("div", primary ? "stat primary" : "stat");
  const labelEl = el("span", "stat-label", label);
  const valueEl = el("b", null, "—");
  box.append(labelEl, valueEl);
  parent.append(box);
  return {
    box,
    label: labelEl,
    set: (v) => {
      const text = v === null || v === undefined || v === "" ? "—" : String(v);
      valueEl.textContent = text;
      // 时间戳这类长值降到 14px（20px 会把指标列撑破），纯数字保持 20px；主指标另有 32px 一档
      valueEl.classList.toggle("compact", text.length > 9);
      valueEl.title = text === "—" ? "" : text;
    },
    tone: (name) => {
          for (const t of ["hot", "warn", "err", "ok"]) box.classList.toggle(t, t === name);
    },
  };
}

function liveRow(parent, label) {
  const row = el("div", "kv-row");
  const valueEl = el("b", null, "—");
  row.append(el("i", null, label), valueEl);
  parent.append(row);
  return (v) => {
    valueEl.textContent = v === null || v === undefined || v === "" ? "—" : String(v);
  };
}

/** 区块：默认裸排版（标题 + hairline）；第三个参数传 "panel" 才是玻璃面板（每页最多 3 个） */
function card(title, actions, cls) {
  const sec = el("section", "sec" + (cls ? " " + cls : ""));
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

function tableWrap() {
  return el("div", "table-wrap");
}

function buildTable(headers, tbody) {
  const table = el("table", "table");
  const thead = el("thead");
  const htr = el("tr");
  for (const h of headers) htr.append(el("th", h.cls || null, h.text));
  thead.append(htr);
  table.append(thead, tbody);
  return table;
}

function emptyRow(tbody, cols, text) {
  const tr = el("tr", "empty");
  const td = el("td", null, text);
  td.colSpan = cols;
  tr.append(td);
  tbody.append(tr);
}

/** 进度条 + 右侧百分比：没有分母（缺失 / 0）时显示「—」、条也归零，不假装有进度 */
function progressBar() {
  const row = el("div", "progress-row");
  const box = el("div", "progress");
  const fill = el("span");
  box.append(fill);
  const pct = el("b", "pct none", "—");
  row.append(box, pct);
  return {
    box,
    fill,
    row,
    pct,
    set: (done, total) => {
      const d = numOrNull(done);
      const t = numOrNull(total);
      const has = d !== null && t !== null && t > 0;
      const ratio = has ? Math.max(0, Math.min(1, d / t)) : 0;
      const percent = ratio * 100;
      fill.style.width = percent + "%";
      if (box.style && typeof box.style.setProperty === "function") box.style.setProperty("--pct", percent + "%");
      box.classList.toggle("is-empty", !has || ratio <= 0);
      box.classList.toggle("is-full", has && ratio >= 1);
      pct.textContent = has ? Math.round(percent) + "%" : "—";
      pct.classList.toggle("none", !has);
    },
  };
}

function makeSwitch(checked, onChange) {
  const wrap = el("label", "switch");
  const input = el("input");
  input.type = "checkbox";
  input.checked = !!checked;
  const track = el("span", "track");
  wrap.append(input, track);
  input.addEventListener("change", () => onChange(input.checked, input));
  return { wrap, input };
}

function inputEl(cls, placeholder, value) {
  const node = el("input", "input" + (cls ? " " + cls : ""));
  node.type = "text";
  node.placeholder = placeholder ?? "";
  node.spellcheck = false;
  if (value !== undefined && value !== null) node.value = String(value);
  return node;
}

function inlineField(text, node) {
  const box = el("div", "inline-field");
  box.append(el("span", null, text), node);
  return box;
}

/**
 * 二次确认按钮：先就地展开「说明文案 + 确认 / 取消」，再点确认才执行 ——
 * 文案就在按钮旁边，比 window.confirm 更清楚、也能带上下文（抛错由调用方提示）。
 */
function confirmButton(label, message, onConfirm, confirmLabel) {
  const box = el("span", "confirm-inline");
  const b = btn(label, "danger small");
  const restore = () => {
    clear(box);
    box.append(b);
  };
  b.addEventListener("click", () => {
    if (box.querySelector(".confirm-bar")) return; // 已经在确认态，忽略连点
    const bar = el("span", "confirm-bar");
    bar.append(el("span", "confirm-text", message));
    const no = btn("取消", "small", restore);
    const yes = btn(confirmLabel || "确认删除", "danger small");
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      no.disabled = true;
      yes.textContent = "处理中…"; // 二次确认后的请求也要有在途反馈
      try {
        await onConfirm();
      } catch (e) {
      }
      restore();
    });
    bar.append(yes, no);
    clear(box);
    box.append(bar);
  });
  box.append(b);
  return box;
}

/* ---------------- 提示条 / 轻提示 ---------------- */

function noticeEl() {
  const n = el("div", "notice");
  n.hidden = true;
  return n;
}

function setNotice(node, text, kind, actions) {
  if (!node) return;
  node.textContent = "";
  node.className = "notice" + (kind ? " " + kind : "");
  node.append(el("span", "notice-text", text));
  if (Array.isArray(actions)) {
    for (const a of actions) node.append(btn(a.label, a.cls, a.onClick));
  }
  node.hidden = false;
}

function hideNotice(node) {
  if (!node) return;
  node.hidden = true;
  node.className = "notice";
  node.textContent = "";
  node.__meshSig = null; // 清掉签名缓存，下次同签名的内容也要重建
  node.__meshText = null;
}

/**
 * 通知条渲染：文本每秒都会变（重建进度），所以按 mode + 按钮集合缓存 DOM ——
 * 只有状态真的变了才重建按钮，避免每秒重绘冲掉按钮的禁用态与焦点。
 */
function renderNotice(node, model) {
  if (!node) return null;
  if (!model) {
    hideNotice(node); // 没有内容就收起来，别把上一条残留在界面上
    return null;
  }
  const actions = Array.isArray(model.actions) ? model.actions.filter(Boolean) : [];
  const sig = String(model.mode ?? "") + "|" + actions.map((a) => a.key || a.label).join(",");
  if (node.__meshSig === sig && node.__meshText) {
    node.__meshText.textContent = model.text;
    return node.__meshText;
  }
  node.textContent = "";
  node.className = "notice" + (model.kind ? " " + model.kind : "");
  const textEl = el("span", "notice-text", model.text);
  node.append(textEl);
  for (const a of actions) node.append(btn(a.label, a.cls, a.onClick));
  node.__meshSig = sig;
  node.__meshText = textEl;
  node.hidden = false;
  return textEl;
}

/** 每秒只改文案：节点没被重绘过就安全地更新，不重建 DOM */
function updateNoticeText(node, text) {
  if (!node || node.hidden) return;
  const textEl = node.__meshText;
  if (textEl && typeof textEl.textContent === "string") textEl.textContent = text;
}

/**
 * 保存类操作成功后统一提示：改动要点『立即应用』才真正生效 ——
 * 交给各页面的"应用状态条"渲染，服务端 pending 刷新之前也不会漏提示、还能就地提交。
 */
function applyHintNotice() {
  applyJob.savedHint = true;
  applyJob.savedAt = Date.now();
  renderApplyAll();
}

const CURATION_HINT = "已保存：锚定条件只在【重新策展】时用来发现子节点，不会改变现有连线";

/**
 * 保存成功后的提示分三档，别一律让人去点「立即应用」：
 *   graph    会画出来的东西（开关、增删、标签、还原）→ 提示去应用
 *   curation 只改锚定条件（探针词/包名/语境/生态签）→ 应用改不了它，得重新策展
 *   saved    纯记录（signals / README 复核词）→ 只说已保存
 */
function afterSaveHint(kind) {
  if (kind === "graph") {
    applyHintNotice();
    toast(APPLY_HINT, "ok");
    return;
  }
  if (kind === "curation") {
    toast(CURATION_HINT, "ok");
    return;
  }
  toast("已保存", "ok");
}

function toast(text, kind) {
  const node = $("toast");
  if (!node) return;
  node.className = "toast" + (kind ? " " + kind : "");
  node.textContent = text;
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === "err" ? 8000 : 5000);
  toastTimer?.unref?.();
}

function reportError(e) {
  if (!e || e.status === 401) return; // 401 已由 API 层退回登录层
  toast(e.message || "操作失败", "err");
}


class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function finish(res) {
  const data = await readJson(res);
  if (res.status === 401) {
    showLogin("登录已过期，请重新输入口令。");
    throw new ApiError(401, (data && data.error) || "未登录");
  }
  if (!res.ok) {
    const msg = data && typeof data.error === "string" && data.error ? data.error : "请求失败（HTTP " + res.status + "）";
    throw new ApiError(res.status, msg, data);
  }
  return data && typeof data === "object" ? data : {};
}

async function apiGet(path) {
  const res = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  return finish(res);
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CSRF-Token": state.csrf,
    },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return finish(res);
}

function serverNow() {
  return widget ? widget.serverNow() : Date.now();
}

/* ============================================================
   通用只读日志弹窗（工作流页与状态页共用）
   Esc / 点遮罩 / 点关闭都能关；关闭后焦点回到触发按钮，打开时锁 body 滚动。
   ============================================================ */

let logDialog = null;
let logTrigger = null;

function buildLogDialog() {
  const mask = el("div", "modal");
  mask.hidden = true;
  mask.setAttribute("role", "dialog");
  mask.setAttribute("aria-modal", "true");
  mask.setAttribute("aria-label", "日志查看");

  const panel = el("div", "modal-panel");
  const head = el("div", "modal-head");
  const titleBox = el("div", "modal-title-box");
  const title = el("div", "modal-title", "日志");
  const meta = el("div", "modal-meta");
  titleBox.append(title, meta);
  const close = btn("关闭", "small");
  close.classList.add("modal-close");
  head.append(titleBox, close);

  const body = el("div", "modal-body");
  panel.append(head, body);
  mask.append(panel);
  document.body.append(mask);

  close.addEventListener("click", closeLogDialog);
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) closeLogDialog(); // 只有点遮罩本身才关，点面板内部不关
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLogDialog();
  });

  logDialog = { mask, title, meta, body, close };
  return logDialog;
}

function isLogDialogOpen() {
  return !!(logDialog && logDialog.mask && !logDialog.mask.hidden);
}

function closeLogDialog() {
  if (!isLogDialogOpen()) return;
  logDialog.mask.hidden = true;
  document.body.classList.remove("modal-open");
  const back = logTrigger;
  logTrigger = null;
  if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
}

function logMetaText(data, fallback) {
  const bytes = numOrNull(data && data.bytes) ?? numOrNull(fallback && fallback.bytes);
  const mtime = pick(data, ["mtime", "modified", "at"]) ?? (fallback ? fallback.mtime : undefined);
  const lines = data && Array.isArray(data.lines) ? data.lines.length : null;
  const bits = [];
  if (bytes !== null) bits.push("占用空间 " + fmtBytes(bytes));
  if (mtime) bits.push("修改 " + fmtWhen(mtime));
  bits.push(lines === null ? "行数未知" : "共 " + fmtNum(lines) + " 行");
  return bits.join(" · ");
}

/** api/log：带路径取不到时退回文件名再试一次（旧版接口可能只认文件名） */
async function fetchLogPayload(name) {
  const params = new URLSearchParams();
  params.set("name", name);
  try {
    return await apiGet("api/log?" + params.toString());
  } catch (e) {
    if (e && e.status === 404 && name.includes("/")) {
      const again = new URLSearchParams();
      again.set("name", name.split("/").pop());
      return await apiGet("api/log?" + again.toString());
    }
    throw e;
  }
}

/**
 * 打开只读日志弹窗。opts.name 是 api/log 的入参（工作流清单里的 name，或作业对象里的 log 路径）；
 * opts 另可带 title / bytes / mtime / trigger（trigger 用于关闭后还焦点）。
 */
async function openLogDialog(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) {
    toast("这条记录没有日志文件名", "err");
    return;
  }
  const dlg = logDialog || buildLogDialog();
  logTrigger = o.trigger && typeof o.trigger.focus === "function" ? o.trigger : document.activeElement || null;

  dlg.mask.hidden = false;
  document.body.classList.add("modal-open");
  dlg.title.textContent = o.title ? String(o.title) : name;
  dlg.meta.textContent = "正在载入…";
  clear(dlg.body);
  dlg.body.append(el("div", "modal-err", "正在载入日志…"));
  if (typeof dlg.close.focus === "function") dlg.close.focus();

  let data = null;
  try {
    data = await fetchLogPayload(name);
  } catch (e) {
    if (isLogDialogOpen()) {
      dlg.meta.textContent = "";
      clear(dlg.body);
      dlg.body.append(el("div", "modal-err", (e && e.message) || "读取日志失败"));
    }
    return;
  }
  if (!isLogDialogOpen()) return; // 载入期间被关掉了，就别再改内容

  const lines = data && Array.isArray(data.lines) ? data.lines.map((x) => (typeof x === "string" ? x : detailText(x))) : [];
  clear(dlg.body);
  dlg.title.textContent = data && typeof data.name === "string" && data.name ? data.name : name;
  dlg.meta.textContent = logMetaText(data, o);
  if (data && data.truncated === true) {
    dlg.body.append(el("div", "modal-note", "文件较大，只显示最后 " + lines.length + " 行"));
  }
  const pre = el("div", "modal-log" + (lines.length ? "" : " empty"));
  pre.textContent = lines.length ? lines.join("\n") : "（这个日志文件是空的）";
  dlg.body.append(pre);
  dlg.body.scrollTop = 0;
}


function setLoginMsg(text, kind) {
  const node = $("login-msg");
  if (!node) return;
  node.className = "login-msg" + (kind ? " " + kind : "");
  node.textContent = text || "";
}

/** 429：禁用按钮若干秒，并逐秒显示剩余时间 */
function lockLogin(seconds) {
  const input = $("login-password");
  const submit = $("login-submit");
  let left = Math.max(1, Math.round(numOrNull(seconds) ?? 30));
  if (loginLockTimer) clearInterval(loginLockTimer);
  submit.disabled = true;
  input.disabled = true; // 请求期间禁用开关，避免连点
  const paint = () => setLoginMsg("尝试过多，请稍后再试（" + left + " 秒后可重试）");
  paint();
  loginLockTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(loginLockTimer);
      loginLockTimer = null;
      submit.disabled = false;
      input.disabled = false;
      setLoginMsg("");
      input.focus();
      return;
    }
    paint();
  }, 1000);
  loginLockTimer?.unref?.();
}

async function onLoginSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = $("login-password");
  const submit = $("login-submit");
  const password = input ? input.value : "";
  if (!password) {
    setLoginMsg("请输入管理口令");
    if (input) input.focus();
    return;
  }
  submit.disabled = true;
  setLoginMsg("正在登录…", "ok");
  try {
    const res = await fetch("api/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await readJson(res);
    if (res.status === 401) {
      setLoginMsg("口令不正确");
      input.select();
      return;
    }
    if (res.status === 429) {
      lockLogin(data && data.retryAfter);
      return;
    }
    if (!res.ok) {
      setLoginMsg((data && data.error) || "登录失败（HTTP " + res.status + "）");
      return;
    }
    input.value = "";
    setLoginMsg("");
    if (data && data.csrf) state.csrf = String(data.csrf);
    const session = await apiGet("api/session");
    if (session && session.authed) {
      enterApp(session);
    } else {
      setLoginMsg("登录后仍未通过会话校验，请重试");
    }
  } catch (e) {
    if (e && e.status === 401) setLoginMsg("口令不正确");
    else if (e && e.status === 429) lockLogin(30);
    else setLoginMsg("无法连接服务：" + (e && e.message ? e.message : e));
  } finally {
    if (!loginLockTimer) submit.disabled = false;
  }
}

function enterApp(session) {
  state.authed = true;
  if (session && session.csrf) state.csrf = String(session.csrf);
  const expires = $("session-expires");
  if (expires) expires.textContent = session && session.expiresAt ? fmtDateTime(session.expiresAt) : "—";
  $("login").hidden = true;
  $("app").hidden = false;
  startStatusWidget();
  switchTab(state.tab || "status");
  initApply().catch(() => {}); // 页面刷新后若作业还在跑，把顶栏指示与 3 秒轮询补上
}

function showLogin(message) {
  state.authed = false;
  state.csrf = "";
  state.status = null;
  state.statusError = "";
  state.overview = null;
  state.workflow = null;
  state.lists = null;
  state.resonance = null;
  state.audit = null;
  state.whitelistDraft = null;
  state.logs = null;
  state.resonanceSelectedId = null;
  state.resonanceShowNew = false;
  state.resonanceNew = null;
  state.repos.loaded = false;
  if (widget) widget.stop();
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  resetApplyJob();
  $("app").hidden = true;
  $("login").hidden = false;
  if (message) setLoginMsg(message);
  const input = $("login-password");
  if (input) {
    input.value = "";
    input.disabled = false;
    input.focus();
  }
  const submit = $("login-submit");
  if (submit && !loginLockTimer) submit.disabled = false;
}

async function onLogout() {
  const restore = busyStart($("logout"), "退出中…");
  try {
    await apiPost("api/logout", {});
  } catch (e) {
  }
  restore();
  showLogin("");
  setLoginMsg("");
}

function startStatusWidget() {
  if (!widget) {
    widget = createStatusWidget({
      chip: $("status-chip"),
      panel: $("status-panel"),
      labelEl: $("status-chip-text"),
      pollMs: 15000,
      fetcher: async () => {
        try {
          const data = await fetchStatusShared();
          try {
            applyStatusSnapshot(data);
          } catch (renderErr) {
            state.statusError = "渲染状态失败：" + (renderErr && renderErr.message ? renderErr.message : renderErr);
            renderStatusView();
          }
          return data;
        } catch (e) {
          if (!e || e.status !== 401) {
            state.statusError = e && e.message ? e.message : "读取状态失败";
            renderStatusView();
          }
          throw e;
        }
      },
    });
    const chip = $("status-chip");
    if (chip) chip.addEventListener("click", () => widget.toggle());
  }
  widget.start();
  if (tickTimer === null) {
    tickTimer = setInterval(tickCountdown, 1000);
    tickTimer?.unref?.();
  }
}


async function switchTab(name) {
  state.tab = name;
  if (name === "status") {
    scheduleStatusAuto();
  } else {
    stopStatusAuto();
    // 名单 / 共鸣页的"未应用改动"提示来自 api/status：切过来时强制补一次，
    // 免得要等顶栏圆环那 15 秒；一次切页最多一个请求
    if (name === "lists" || name === "settings" || name === "resonance") refreshStatusQuiet(true).catch(() => {});
  }
  const tabs = $("tabs");
  if (tabs) {
    for (const b of tabs.querySelectorAll(".tab")) {
      const on = b.dataset.tab === name;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  const views = $("views");
  if (views) {
    for (const s of views.querySelectorAll(".view")) s.hidden = s.dataset.view !== name;
  }
  if (name === "status") await loadStatusView();
  else if (name === "data") await loadDataView();
  else if (name === "workflow") await loadWorkflowView();
  else if (name === "lists") await loadListsView();
  else if (name === "settings") await loadSettingsView();
  else if (name === "resonance") await loadResonanceView();
  else if (name === "audit") await loadAuditView();
}


function buildStatusView(root) {
  clear(root);
  const refs = {};

  refs.notice = noticeEl();
  root.append(refs.notice);
  refs.pendingNote = noticeEl();
  root.append(refs.pendingNote);
  refs.healthNote = noticeEl();
  root.append(refs.healthNote);

  refs.refreshBtn = btn("刷新", null, () => loadStatusView());
  const sec1 = card("运行概览", [refs.refreshBtn]);
  const cards = el("div", "cards");
  // 主指标（后端状态）跨 2 列、数字 32px；其余指标退回裸排版
  refs.state = statCard(cards, "后端状态", true);
  refs.countdown = statCard(cards, "下一轮 / 本轮结束");
  refs.phase = statCard(cards, "当前阶段");
  refs.roundStart = statCard(cards, "本轮开始");
  refs.cycle = statCard(cards, "采集周期");
  sec1.append(cards);
  refs.stale = el("div", "notice warn");
  refs.stale.hidden = true;
  sec1.append(refs.stale);
  root.append(sec1);

  const sec2 = card("本轮进度");
  const kv2 = el("div", "kv");
  refs.fetched = liveRow(kv2, "抓取");
  refs.segments = liveRow(kv2, "分段");
  refs.requests = liveRow(kv2, "请求");
  refs.quota = liveRow(kv2, "配额");
  sec2.append(kv2);
  const segBar = progressBar();
  refs.segBar = segBar;
  sec2.append(segBar.row);
  root.append(sec2);

  const sec3 = card("README 索引");
  const kv3 = el("div", "kv");
  refs.readme = liveRow(kv3, "已索引");
  refs.readmeTarget = liveRow(kv3, "目标");
  sec3.append(kv3);
  const readmeBar = progressBar();
  refs.readmeBar = readmeBar;
  sec3.append(readmeBar.row);
  root.append(sec3);

  const sec4 = card("上一轮");
  const kv4 = el("div", "kv");
  refs.lastRound = liveRow(kv4, "起止");
  refs.lastSeconds = liveRow(kv4, "耗时");
  refs.lastExtra = liveRow(kv4, "结果");
  sec4.append(kv4);
  root.append(sec4);

  refs.applyBtn = btn("应用变更", null, onApplyClick);
  const sec5 = card("应用变更", [refs.applyBtn], "panel");
  sec5.append(el("div", "hint", "写入数据与快照；运行期间采集暂停。"));
  refs.applyNotice = noticeEl();
  sec5.append(refs.applyNotice);
  refs.collectorNotice = noticeEl();
  sec5.append(refs.collectorNotice);
  const kv5 = el("div", "kv");
  refs.applyStatus = liveRow(kv5, "作业状态");
  refs.applyPhase = liveRow(kv5, "进行中的阶段");
  refs.applyStarted = liveRow(kv5, "开始");
  refs.applyFinished = liveRow(kv5, "结束");
  refs.applyExit = liveRow(kv5, "退出码");
  sec5.append(kv5);

  // 日志块：没有日志就整块 hidden（连边框都没有）；有日志收进 <details>，默认折叠；
  // 「查看完整日志」按钮留在 <summary> 行右端（flex + space-between）
  refs.applyLogPath = "";
  refs.applyLogSummaryText = el("span", "log-summary-text", "日志尾部（0 行）");
  refs.applyLogView = btn("查看完整日志", "small");
  refs.applyLogView.addEventListener("click", (ev) => {
    // 按钮在 <summary> 里：挡掉默认动作，点它只开弹窗，不展开/收起日志
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    if (refs.applyLogPath) openLogDialog({ name: refs.applyLogPath, title: refs.applyLogPath, trigger: refs.applyLogView });
  });
  refs.applyLogSummary = el("summary");
  refs.applyLogSummary.append(refs.applyLogSummaryText, refs.applyLogView);
  refs.applyLog = el("pre", "log");
  refs.applyLogDetails = el("details", "raw");
  refs.applyLogDetails.append(refs.applyLogSummary, refs.applyLog);
  refs.applyLogBox = el("div", "log-box");
  refs.applyLogBox.append(refs.applyLogDetails);
  refs.applyLogBox.hidden = true;
  sec5.append(refs.applyLogBox);
  root.append(sec5);

  return refs;
}

function mountStatus() {
  if (!V.status) V.status = buildStatusView($("view-status"));
  return V.status;
}

async function loadStatusView() {
  const refs = mountStatus();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    applyStatusSnapshot(await fetchStatusShared(true));
  } catch (e) {
    if (!e || e.status !== 401) state.statusError = e && e.message ? e.message : "读取状态失败";
    renderStatusView();
  } finally {
    restore();
  }
  renderApplyAll();
}

function staleMinutesFrom(data) {
  if (!data || typeof data !== "object") return null;
  const raw = data.raw && typeof data.raw === "object" ? data.raw : {};
  const updated = Date.parse(raw.updatedAt ?? "");
  const byTime = Number.isFinite(updated) ? Math.round((serverNow() - updated) / 60000) : null;
  if (data.stale === true) {
    const m = numOrNull(data.staleMinutes);
    if (m !== null) return Math.max(m, byTime ?? 0);
    return byTime === null ? 10 : Math.max(byTime, 10);
  }
  return byTime;
}

function updateStaleBanner(refs, data) {
  const mins = staleMinutesFrom(data);
  const isStale = !!(data && data.stale === true);
  if ((mins !== null && mins >= 10) || isStale) {
    refs.stale.hidden = false;
    refs.stale.textContent =
      mins !== null
        ? "状态已 " + Math.max(mins, 10) + " 分钟未更新，采集器可能没在运行。"
        : "状态超过 10 分钟未更新，采集器可能没在运行。";
  } else {
    refs.stale.hidden = true;
  }
}

function tickCountdown() {
  tickApplyProgress(); // 「已运行 N 秒」自己走，不重建 DOM
  const refs = V.status;
  if (!refs) return;
  const data = state.status;
  const raw = data && data.raw && typeof data.raw === "object" ? data.raw : null;
  if (!raw) {
    refs.countdown.set("—");
    if (data) updateStaleBanner(refs, data);
    return;
  }
  const target = Date.parse(raw.nextRunAt ?? "");
  if (!Number.isFinite(target)) {
    refs.countdown.set("—");
  } else {
    const left = target - serverNow();
    const text = left <= 1000 ? "即将开始" : formatCountdown(left) + " 后";
    refs.countdown.set(raw.state === "idle" ? text : "约 " + text);
  }
  refs.countdown.label.textContent = raw.state === "idle" ? "下一次扫描" : "本轮结束";
  updateStaleBanner(refs, data);
}

function renderStatusView() {
  const refs = V.status;
  if (!refs) return;
  const data = state.status;
  const raw = data && data.raw && typeof data.raw === "object" ? data.raw : null;

  if (state.statusError) setNotice(refs.notice, state.statusError, "err");
  else hideNotice(refs.notice);


  if (raw && raw.state === "error" && raw.error) {
    setNotice(refs.healthNote, "采集器报错：" + truncate(raw.error, 80), "err");
  } else {
    hideNotice(refs.healthNote);
  }

  if (!raw) {
    refs.state.set("—");
    refs.countdown.set("—");
    refs.phase.set("—");
    refs.roundStart.set("—");
    refs.cycle.set("—");
    refs.fetched("—");
    refs.segments("—");
    refs.requests("—");
    refs.quota("—");
    refs.segBar.set(null, null);
    refs.readme("—");
    refs.readmeTarget("—");
    refs.readmeBar.set(null, null);
    refs.lastRound("—");
    refs.lastSeconds("—");
    refs.lastExtra("—");
    refs.stale.hidden = true;
    return;
  }

  refs.state.set(stateText(raw.state) + (raw.error ? "（" + truncate(raw.error, 80) + "）" : ""));
  refs.state.tone(raw.state === "error" ? "err" : isRunningState(raw.state) ? "hot" : "");
  refs.phase.set(raw.phase ? phaseText(raw.phase) : "—");
  refs.roundStart.set(raw.roundStartedAt ? fmtDateTime(raw.roundStartedAt) : "—");
  const cycle = numOrNull(raw.roundSeconds);
  refs.cycle.set(cycle !== null && cycle > 0 ? Math.round(cycle / 60) + " 分钟" : "—");

  const fetchedBits = [];
  if (numOrNull(raw.fetched) !== null) fetchedBits.push("抓到 " + fmtNum(raw.fetched) + " 条");
  if (numOrNull(raw.added) !== null) fetchedBits.push("新增 " + fmtNum(raw.added));
  if (numOrNull(raw.indexed) !== null) fetchedBits.push("累积索引 " + fmtNum(raw.indexed) + " 个");
  refs.fetched(fetchedBits.length ? fetchedBits.join(" · ") : "—");

  const seg = raw.segments && typeof raw.segments === "object" ? raw.segments : null;
  const segDone = seg ? numOrNull(seg.done) : null;
  const segTotal = seg ? numOrNull(seg.total) : null;
  if (seg && segTotal !== null && segTotal > 0) {
    const done = segDone ?? 0;
    refs.segments(
      "已抓 " + fmtNum(done) + " / " + fmtNum(segTotal) +
        (numOrNull(seg.pending) !== null && numOrNull(seg.pending) > 0 ? "（待抓 " + fmtNum(seg.pending) + "）" : "") +
        (numOrNull(seg.thisRound) !== null ? " · 本轮 " + fmtNum(seg.thisRound) : "")
    );
    refs.segBar.set(done, segTotal);
  } else {
    refs.segments(segDone !== null ? "已抓 " + fmtNum(segDone) + "（无总数）" : "—");
    refs.segBar.set(null, null); // 没有分母：条归零、百分比显示「—」
  }

  const req = numOrNull(raw.requests);
  const budget = numOrNull(raw.budget);
  refs.requests(req === null ? "—" : "已用 " + fmtNum(req) + (budget !== null ? " / 预算 " + fmtNum(budget) : "") + " 次");
  const quota = numOrNull(raw.quotaRemaining);
  refs.quota(quota === null ? "—" : "剩余 " + fmtNum(quota));

  const readme = raw.readme && typeof raw.readme === "object" ? raw.readme : null;
  const rDone = readme ? numOrNull(readme.indexed) : null;
  const rTarget = readme ? numOrNull(readme.target) : null;
  if (readme && rTarget !== null && rTarget > 0) {
    const done = rDone ?? 0;
    refs.readme(fmtNum(done) + " / " + fmtNum(rTarget) + " 篇" + (numOrNull(readme.thisRound) !== null ? "（本轮 +" + fmtNum(readme.thisRound) + "）" : ""));
    refs.readmeBar.set(done, rTarget);
    refs.readmeTarget(fmtNum(rTarget) + " 篇");
  } else {
    refs.readme(rDone !== null ? fmtNum(rDone) + " 篇（无目标值）" : "—");
    refs.readmeBar.set(null, null);
    refs.readmeTarget(numOrNull(readme && readme.cached) !== null ? "无（缓存 " + fmtNum(readme.cached) + " 篇）" : "—");
  }

  const last = raw.lastRound && typeof raw.lastRound === "object" ? raw.lastRound : null;
  if (last && (last.startedAt || last.finishedAt)) {
    refs.lastRound(formatClock(last.startedAt) + " → " + formatClock(last.finishedAt));
    refs.lastSeconds(formatDuration(last.seconds));
    const bits = [];
    if (last.state) bits.push(last.state === "ok" ? "正常完成" : String(last.state));
    if (numOrNull(last.indexed) !== null) bits.push("索引 " + fmtNum(last.indexed));
    if (numOrNull(last.added) !== null) bits.push("新增 " + fmtNum(last.added));
    refs.lastExtra(bits.length ? bits.join(" · ") : "—");
  } else {
    refs.lastRound("—");
    refs.lastSeconds("—");
    refs.lastExtra("—");
  }

  tickCountdown();
}

/* ---------------- 应用变更 ---------------- */

/** 接口的 pending：{lists, resonance, since}；字段缺失按 false，也兼容 pending:true 这种简写 */
function pendingOf(data) {
  const p = data && typeof data.pending === "object" && data.pending ? data.pending : null;
  const parts = [];
  if (p && p.lists === true) parts.push("名单");
  if (p && p.resonance === true) parts.push("共鸣");
  if (!parts.length && data && data.pending === true) parts.push("名单/共鸣");
  return {
    lists: !!(p && p.lists === true),
    resonance: !!(p && p.resonance === true),
    since: p ? p.since ?? null : null,
    parts,
    any: parts.length > 0,
  };
}

/**
 * 只在真正拿到一份新的 api/status 时才刷新占用判断（busy:true 上锁、busy:false 解锁）；
 * 接口没给 collector 就保持本地判断 —— 否则 409 刚带回来的占用会被上一轮旧快照冲掉。
 */
function syncCollector(data) {
  const c = data && data.collector && typeof data.collector === "object" ? data.collector : null;
  if (!c) return;
  if (c.busy === false) {
    state.collectorBlock = null;
    return;
  }
  if (c.busy === true) {
    state.collectorBlock = { state: c.state ?? null, phase: c.phase ?? null, ageMinutes: c.ageMinutes ?? null };
  }
}

function collectorInfo() {
  return state.collectorBlock && typeof state.collectorBlock === "object" ? state.collectorBlock : null;
}

function collectorText(info) {
  const label = info.phase ? phaseText(info.phase) : info.state ? stateText(info.state) : "忙碌";
  const age = numOrNull(info.ageMinutes);
  return "采集器正在跑（" + label + "），等这一轮结束再试。" + (age !== null ? "（状态 " + age + " 分钟前更新）" : "");
}

function pickJob(data) {
  if (!data || typeof data !== "object") return null;
  if (data.job && typeof data.job === "object") return data.job;
  if (data.applying && typeof data.applying === "object") return data.applying;
  return data;
}

function normalizeJob(data) {
  const raw = pickJob(data);
  if (!raw || typeof raw !== "object") return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!status || status === "idle") return null;
  return raw;
}

function jobRunning(job) {
  return !!job && job.status === "running";
}

function jobStartMs(job) {
  const d = toDate(job && job.startedAt);
  return d ? d.getTime() : applyJob.startedMs;
}

function jobElapsedSeconds(job) {
  const start = jobStartMs(job);
  if (start === null || start === undefined) return null;
  return Math.max(0, Math.round((serverNow() - start) / 1000));
}

/** 作业耗时（秒）：开始与结束都有才算得出来 */
function jobDurationSeconds(job) {
  const start = jobStartMs(job);
  const end = toDate(job && job.finishedAt);
  if (start === null || start === undefined || !end) return null;
  return Math.max(0, Math.round((end.getTime() - start) / 1000));
}

function applyPhaseLabel() {
  const raw = state.status && state.status.raw && typeof state.status.raw === "object" ? state.status.raw : null;
  return raw && raw.phase ? phaseText(raw.phase) : "";
}

function applyRunningText(job) {
  const phase = applyPhaseLabel();
  const secs = jobElapsedSeconds(job);
  let text = phase ? "正在重建：" + phase : "正在重建";
  if (secs !== null) text += "（已运行 " + secs + " 秒）";
  return text;
}

function applyFailureText(job) {
  const exit = job && job.exitCode !== null && job.exitCode !== undefined ? "（退出码 " + job.exitCode + "）" : "";
  const note = job && job.note ? "：" + String(job.note) : "";
  return "应用变更失败" + exit + note + "。日志尾部见状态页下方。";
}

/** 只认自有键，避免把 "toString" 之类的原型属性当成状态文案 */
function applyStatusLabel(status) {
  return Object.prototype.hasOwnProperty.call(APPLY_STATUS_TEXT, status) ? APPLY_STATUS_TEXT[status] : dash(status);
}

/** 把一份作业响应并进全局状态；拿不到作业时不动现有快照（避免旧响应把新作业冲掉） */
function absorbJob(data) {
  const job = normalizeJob(data);
  if (!job) return null;
  const changed = !applyJob.job || String(applyJob.job.id ?? "") !== String(job.id ?? "");
  applyJob.job = job;
  const started = toDate(job.startedAt);
  if (started) applyJob.startedMs = started.getTime();
  // 换了作业又没有 startedAt：用本地时间兜底，别拿上一轮的开始时间算出个天文数字
  else if (changed) applyJob.startedMs = jobRunning(job) ? Date.now() : null;
  if (jobRunning(job)) {
    applyJob.seenRunning = true;
    applyJob.error = null;
    applyJob.savedHint = false;
  }
  return job;
}

/* ---------------- 取数与轮询（全局，不依赖当前标签页） ---------------- */

/** api/status 的唯一取数口：同一时刻只发一个请求，几秒内的重复请求直接复用 */
function fetchStatusShared(force) {
  if (!force && statusFetchPromise) return statusFetchPromise;
  if (!force && statusFetchAt && Date.now() - statusFetchAt < STATUS_FETCH_MIN_GAP_MS) return Promise.resolve(state.status);
  statusFetchStartedAt = Date.now();
  statusFetchAt = statusFetchStartedAt;
  statusFetchPromise = apiGet("api/status").then(
    (data) => {
      statusFetchPromise = null;
      return data;
    },
    (err) => {
      statusFetchPromise = null;
      throw err;
    }
  );
  return statusFetchPromise;
}

function applyStatusSnapshot(data) {
  state.status = data;
  syncCollector(data);
  state.statusError = "";
  const job = absorbJob(data); // api/status 的 applying 与 GET api/apply 是同一份作业
  if (jobRunning(job)) scheduleApplyPoll();
  // 服务端明确说"没有未应用改动"，且这份数据是保存之后才取的 → 本地"刚保存"提示可以收了
  if (applyJob.savedHint && !pendingOf(data).any && statusFetchStartedAt >= applyJob.savedAt) applyJob.savedHint = false;
  renderStatusView();
  renderApplyAll();
  if (V.workflow) renderWorkflow();
}

async function refreshStatusQuiet(force) {
  try {
    applyStatusSnapshot(await fetchStatusShared(!!force));
    return true;
  } catch (e) {
    if (!e || e.status !== 401) state.statusError = e && e.message ? e.message : "读取状态失败";
    renderStatusView();
    return false;
  }
}

/** 3 秒作业轮询：只在作业在跑时存在，跑完自动停（全局，跟当前标签页无关） */
function scheduleApplyPoll() {
  if (applyJob.timer !== null) return;
  applyJob.timer = setTimeout(pollApply, APPLY_POLL_MS);
  applyJob.timer?.unref?.();
}

function stopApplyPoll() {
  if (applyJob.timer !== null) {
    clearTimeout(applyJob.timer);
    applyJob.timer = null;
  }
}

async function pollApply() {
  applyJob.timer = null;
  let data = null;
  try {
    data = await apiGet("api/apply");
  } catch (e) {
    if (e && e.status === 401) return;
    if (jobRunning(applyJob.job)) scheduleApplyPoll(); // 单次失败下一轮再试
    return;
  }
  const prev = applyJob.job;
  const next = normalizeJob(data);
  if (next) absorbJob(next);
  const finished = await checkJobFinished(prev, next);
  if (!finished) {
    if (!next && prev && !jobRunning(prev)) applyJob.job = null; // 作业文件没了
    renderApplyAll();
  }
  if (!finished && jobRunning(applyJob.job)) scheduleApplyPoll();
}

/** 登录后初始化：拉一次 api/apply，页面刷新前就在跑的作业照样能看到进度 */
async function initApply() {
  applyChip = ensureApplyChip();
  try {
    const job = absorbJob(await apiGet("api/apply"));
    if (jobRunning(job)) scheduleApplyPoll();
  } catch (e) {
  }
  renderApplyAll();
}

/** 收尾后按当前标签页刷新数据（审计页是历史记录，不用刷） */
async function refreshCurrentTab() {
  try {
    if (state.tab === "data") await loadDataView();
    else if (state.tab === "workflow") await loadWorkflowView();
    else if (state.tab === "lists") await loadListsView();
    else if (state.tab === "settings") await loadSettingsView();
    else if (state.tab === "resonance") await loadResonanceView();
  } catch (e) {
  }
}

function finishKey(job) {
  return job ? String(job.id ?? "") + "|" + String(job.finishedAt ?? "") : "";
}

/**
 * 作业从 running 变成结束的那一刻才收尾：先记住"我见过它在跑"，再用 finishedId 去重 ——
 * api/apply 与 api/status 两条线都看得到这份作业，不能各收一次尾。
 */
async function checkJobFinished(prev, next) {
  if (!prev || prev.status !== "running") return false;
  if (next && next.status === "running") return false;
  const same = !!(next && next.id === prev.id);
  const key = finishKey(same ? next : prev);
  if (!key || applyJob.finishedId === key) return false;
  applyJob.finishedId = key;
  await finishApplyJob(same ? next : null, prev);
  return true;
}

/**
 * 收尾（关键路径）：立刻重拉 api/status、刷新当前标签页数据、按结果 toast；
 * pending 仍为 true 时保留提示，不假装成功。
 */
async function finishApplyJob(doneJob, prevJob) {
  stopApplyPoll();
  const job =
    doneJob ||
    {
      ...prevJob,
      status: "failed",
      finishedAt: prevJob.finishedAt || new Date().toISOString(),
      note: prevJob.note || "作业状态丢失（服务可能重启过）",
    };
  applyJob.job = job;
  applyJob.error = null;
  applyJob.savedHint = false;

  if (state.tab === "status") await loadStatusView();
  else {
    await refreshStatusQuiet(true);
    await refreshCurrentTab();
  }
  renderApplyAll();

  const secs = jobDurationSeconds(job);
  const secsText = secs === null ? "" : "（用时 " + formatDuration(secs) + "）";
  if (!doneJob) {
    toast("重建作业状态丢失，请重新点『立即应用』或刷新页面。", "err");
    return;
  }
  if (job.status === "done") {
    const still = pendingOf(state.status).any;
    toast("应用变更已完成" + secsText + (still ? "，但仍有未应用的改动，请看提示条。" : ""), still ? "" : "ok");
  } else {
    const exit = job.exitCode === null || job.exitCode === undefined ? "" : "（退出码 " + job.exitCode + "）";
    toast("应用变更失败" + exit + (job.note ? "：" + String(job.note) : "") + " 顶栏『重建失败』可看日志。", "err");
  }
}

/* ---------------- 在途反馈 ---------------- */

function triggerButtonOf(trigger) {
  if (!trigger) return null;
  if (trigger.currentTarget && trigger.currentTarget.tagName === "BUTTON") return trigger.currentTarget;
  if (trigger.tagName === "BUTTON") return trigger;
  return null;
}

/**
 * 在途反馈：立刻换文案 + 禁用，返回还原函数。
 * 若期间节点被重绘换掉（isConnected === false），还原函数自动失效，不会写回旧节点。
 */
function busyStart(node, label) {
  if (!node) return () => {};
  const prevText = node.textContent;
  const prevDisabled = !!node.disabled;
  node.disabled = true;
  if (label) node.textContent = label;
  return () => {
    if (node.isConnected === false) return;
    if (label) node.textContent = prevText;
    node.disabled = prevDisabled;
  };
}

/** 提交应用变更：先把被点的按钮就地变成"提交中…"，保证点下去立刻有反应 */
async function onApplyClick(trigger) {
  if (applyJob.submitting) return;
  if (jobRunning(applyJob.job)) {
    toast("已有一个重建任务在跑，等它结束。", "warn");
    return;
  }
  const restoreTrigger = busyStart(triggerButtonOf(trigger), "提交中…");
  applyJob.submitting = true;
  applyJob.error = null;
  renderApplyAll();

  let submitted = false;
  try {
    const data = await apiPost("api/apply", {});
  const job = absorbJob(data); // api/status 的 applying 与 GET api/apply 是同一份作业
    state.collectorBlock = null;
    applyJob.error = null;
    if (jobRunning(job)) scheduleApplyPoll();
    submitted = true;
    toast(job && job.id ? "已提交重建作业：" + job.id : "已提交应用变更作业", "ok");
  } catch (e) {
    const bodyJob = e && e.body && e.body.job && typeof e.body.job === "object" ? e.body.job : null;
    if (bodyJob) {
      absorbJob(bodyJob);
      if (jobRunning(bodyJob)) scheduleApplyPoll();
    }
    if (!e || e.status === 401) {
    } else if (e.status === 409 && e.body && e.body.collector && typeof e.body.collector === "object") {
          const c = e.body.collector;
      state.collectorBlock = { state: c.state ?? null, phase: c.phase ?? null, ageMinutes: c.ageMinutes ?? null };
      applyJob.error = { message: e.message || collectorText(state.collectorBlock), kind: "collector" };
      toast(applyJob.error.message, "err");
    } else if (e.status === 409 && bodyJob && bodyJob.status === "running") {
      applyJob.error = { message: "已有一个重建任务在跑，进度见上方提示。", kind: "running" };
    } else {
      applyJob.error = { message: e.message || "提交失败", kind: "submit" };
      reportError(e);
    }
  } finally {
    applyJob.submitting = false;
    restoreTrigger();
    renderApplyAll();
  }
  if (submitted) await refreshStatusQuiet(true); // 立刻对齐阶段 / 未应用状态 / 作业信息
}

/* ---------------- 渲染：顶栏指示 / 状态页 / 共鸣页 / 名单页 ---------------- */

/**
 * 应用状态条的统一模型：状态页、共鸣页、名单页共用，只有 pending 文案不同。
 * 优先级：提交中 > 重建中 > 提交失败(可重试) > 作业失败(可看日志/重试) > 未应用 > 刚保存。
 */
function applyBannerModel(pendingText, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const job = applyJob.job;
  if (applyJob.submitting) return { mode: "submitting", kind: "hot", text: "正在提交应用变更…", actions: [] };
  if (jobRunning(job)) return { mode: "running", kind: "hot", text: applyRunningText(job), actions: [] };
  if (applyJob.error) {
    return {
      mode: "error:" + (applyJob.error.kind || ""),
      kind: "err",
      text: applyJob.error.message,
      actions: [{ key: "retry", label: "重试", cls: "primary", onClick: onApplyClick }],
    };
  }
  if (job && job.status === "failed") {
    const actions = [{ key: "retry", label: "重试", cls: "primary", onClick: onApplyClick }];
    if (job.log) {
      actions.unshift({
        key: "log",
        label: "查看日志",
        cls: null,
        onClick: (ev) => openLogDialog({ name: job.log, title: job.log, trigger: ev && ev.currentTarget }),
      });
    }
    return { mode: "failed", kind: "err", text: applyFailureText(job), actions };
  }
  if (pendingText) {
    return {
      mode: "pending:" + pendingText,
      kind: "hot",
      text: pendingText,
      // 共鸣页页头已经有同一颗按钮：那边传 pendingActions:false，避免一屏放两遍
      actions: o.pendingActions === false ? [] : [{ key: "apply", label: "立即应用", cls: "primary", onClick: onApplyClick }],
    };
  }
  if (applyJob.savedHint) {
    return {
      mode: "saved",
      kind: "ok",
      text: APPLY_HINT,
      actions:
        o.pendingActions === false
          ? []
          : [
              { key: "apply", label: "立即应用", cls: "primary", onClick: onApplyClick },
              { key: "go", label: "去状态页", cls: null, onClick: () => switchTab("status") },
            ],
    };
  }
  return null;
}

function renderApplyAll() {
  renderApplyChip();
  renderStatusApply();
  renderResonanceApply();
  renderListsApply();
}

function renderStatusApply() {
  const refs = V.status;
  if (!refs) return;
  const job = applyJob.job;
  const running = jobRunning(job);
  const collector = collectorInfo();
  const pend = pendingOf(state.status);

  const pendingText = pend.any ? pend.parts.join("/") + "有改动尚未应用，点『立即应用』重算一次才会生效。" : "";
  renderNotice(refs.pendingNote, applyBannerModel(pendingText));

  refs.applyBtn.disabled = running || applyJob.submitting || !!collector;
  refs.applyBtn.textContent = collector ? "采集器占用中" : running ? "进行中" : applyJob.submitting ? "提交中…" : "应用变更";
  refs.applyBtn.classList.toggle("primary", pend.any && !running && !applyJob.submitting && !collector);

  if (collector) {
    const text = collectorText(collector);
    renderNotice(refs.collectorNotice, {
      mode: "collector:" + text,
      kind: "warn",
      text,
      actions: [
        {
          key: "retry",
          label: "再试一次",
          cls: null,
          onClick: () => {
                      state.collectorBlock = null;
            renderApplyAll();
            onApplyClick();
          },
        },
      ],
    });
  } else {
    hideNotice(refs.collectorNotice);
  }

  const elapsed = running ? jobElapsedSeconds(job) : null;
  refs.applyStatus(job ? applyStatusLabel(job.status) + (elapsed === null ? "" : "（已运行 " + elapsed + " 秒）") : "—");
  refs.applyPhase(applyPhaseLabel() || "—");
  refs.applyStarted(job && job.startedAt ? fmtDateTime(job.startedAt) : "—");
  refs.applyFinished(job && job.finishedAt ? fmtDateTime(job.finishedAt) : "—");
  const exit = job && job.exitCode !== null && job.exitCode !== undefined ? String(job.exitCode) : "—";
  refs.applyExit(exit);

  const tail = job && Array.isArray(job.logTail) ? job.logTail.map((x) => (typeof x === "string" ? x : detailText(x))) : [];
  refs.applyLogPath = job && typeof job.log === "string" ? job.log : "";
  const hasTail = tail.length > 0;
  const hasFile = !!refs.applyLogPath;
  refs.applyLogBox.hidden = !hasTail && !hasFile;
  refs.applyLogDetails.hidden = !hasTail;
  if (hasTail) {
    refs.applyLogSummaryText.textContent = "日志尾部（" + tail.length + " 行）";
    refs.applyLog.textContent = tail.join("\n");
  } else {
      refs.applyLogSummaryText.textContent = "";
    refs.applyLog.textContent = "";
    refs.applyLogDetails.open = false;
  }
  refs.applyLogView.hidden = !hasFile;
  const logViewParent = hasTail ? refs.applyLogSummary : refs.applyLogBox;
  if (refs.applyLogView.parentNode !== logViewParent) logViewParent.append(refs.applyLogView);
  refs.applyLogBox.classList.toggle("solo", !hasTail && hasFile);

  if (job && job.status === "failed") {
    setNotice(
      refs.applyNotice,
      "应用变更失败（退出码 " + exit + "）" + (job.note ? "：" + String(job.note) : "") + "。日志尾部见下方。",
      "err"
    );
  } else if (job && job.status === "done") {
    setNotice(refs.applyNotice, "最近一次应用变更已完成。", "ok");
  } else {
    hideNotice(refs.applyNotice);
  }
}

function renderResonanceApply() {
  const refs = V.resonance;
  if (!refs) return;
  const data = state.resonance && typeof state.resonance === "object" ? state.resonance : {};
  const pend = data.pendingApply === true || pendingOf(state.status).resonance;
  const job = applyJob.job;

  if (refs.pendingHint) {
      const showHint = applyJob.submitting || ((pend || applyJob.savedHint) && !jobRunning(job));
    refs.pendingHint.hidden = !showHint;
    refs.pendingHint.disabled = applyJob.submitting;
    refs.pendingHint.textContent = applyJob.submitting ? "提交中…" : "立即应用";
  }
  if (refs.pendingBadge) refs.pendingBadge.hidden = !pend;

  const text = pend ? "共鸣清单有改动尚未应用，点『立即应用』重算一次才会生效。" : "";
  renderNotice(refs.applyNotice, applyBannerModel(text, { pendingActions: false }));
}

function renderListsApply() {
  const refs = V.lists;
  if (!refs) return;
  const pend = pendingOf(state.status).lists;
  const text = pend ? "名单有改动尚未应用，点『立即应用』重算一次才会生效。" : "";
  renderNotice(refs.applyNote, applyBannerModel(text));
}

function ensureApplyChip() {
  if (applyChip) return applyChip;
  const top = document.querySelector(".top-right");
  if (!top) return null;
  const box = el("button", "apply-chip");
  box.type = "button";
  box.hidden = true;
  box.setAttribute("aria-live", "polite");
  const spin = el("span", "apply-spinner");
  spin.setAttribute("aria-hidden", "true");
  const text = el("span", "apply-chip-text", "重建中");
  box.append(spin, text);
  box.addEventListener("click", () => switchTab("status"));
  top.insertBefore(box, top.firstChild);
  applyChip = { box, text };
  return applyChip;
}

function applyChipText(job) {
  const bits = [];
  const phase = applyPhaseLabel();
  if (phase) bits.push(phase);
  const secs = jobElapsedSeconds(job);
  if (secs !== null) bits.push(secs + "s");
  return "重建中" + (bits.length ? " · " + bits.join(" · ") : "");
}

function renderApplyChip() {
  const chip = ensureApplyChip();
  if (!chip) return;
  const job = applyJob.job;
  const running = jobRunning(job);
  const failed = !applyJob.submitting && !running && !!job && job.status === "failed";
  const show = applyJob.submitting || running || failed;
  chip.box.hidden = !show;
  if (!show) return;
  chip.box.className = "apply-chip" + (failed ? " err" : applyJob.submitting ? " pending" : " busy");
  chip.box.title = failed ? "最近一次重建失败：点开状态页看日志尾部" : "离线重建进行中：点开状态页看进度";
  chip.text.textContent = applyJob.submitting
    ? "正在提交应用变更…"
    : running
      ? applyChipText(job)
      : "重建失败 · 点开看日志";
}

function tickApplyProgress() {
  const job = applyJob.job;
  if (!jobRunning(job)) return;
  const text = applyRunningText(job);
  if (applyChip && !applyChip.box.hidden) applyChip.text.textContent = applyChipText(job);
  updateNoticeText(V.status && V.status.pendingNote, text);
  updateNoticeText(V.resonance && V.resonance.applyNotice, text);
  updateNoticeText(V.lists && V.lists.applyNote, text);
}

/* ---------------- 状态页自动刷新（切走就停） ---------------- */

function scheduleStatusAuto() {
  stopStatusAuto();
  if (!state.authed || state.tab !== "status") return;
  const ms = jobRunning(applyJob.job) ? STATUS_POLL_BUSY_MS : STATUS_POLL_MS;
  statusAutoTimer = setTimeout(async () => {
    statusAutoTimer = null;
    if (state.authed && state.tab === "status" && !document.hidden) await refreshStatusQuiet(false);
    scheduleStatusAuto();
  }, ms);
  statusAutoTimer?.unref?.();
}

function stopStatusAuto() {
  if (statusAutoTimer !== null) {
    clearTimeout(statusAutoTimer);
    statusAutoTimer = null;
  }
}

/** 退出登录：作业轮询、自动刷新、顶栏指示统统收掉 */
function resetApplyJob() {
  stopApplyPoll();
  stopStatusAuto();
  applyJob.job = null;
  applyJob.submitting = false;
  applyJob.seenRunning = false;
  applyJob.finishedId = null;
  applyJob.error = null;
  applyJob.savedHint = false;
  applyJob.savedAt = 0;
  applyJob.startedMs = null;
  state.collectorBlock = null;
  if (applyChip) applyChip.box.hidden = true;
}


function buildDataView(root) {
  clear(root);
  const refs = {};

  refs.notice = noticeEl();
  root.append(refs.notice);

  refs.refreshBtn = btn("刷新", null, () => loadDataView());
  const sec1 = card("总量", [refs.refreshBtn]);
  const cards = el("div", "cards");
  refs.nodes = statCard(cards, "节点", true);
  refs.edges = statCard(cards, "连线");
  refs.sectors = statCard(cards, "扇区");
  refs.nodes.tone("hot");
  refs.generatedAt = statCard(cards, "生成时间");
  refs.version = statCard(cards, "版本");
  sec1.append(cards);
  root.append(sec1);

  const sec2 = card("关键文件");
  refs.filesBody = el("tbody");
  const filesWrap = tableWrap();
  filesWrap.append(buildTable([{ text: "文件" }, { text: "占用空间", cls: "num" }, { text: "修改时间" }], refs.filesBody));
  sec2.append(filesWrap);
  root.append(sec2);

  const sec3 = card("README 索引");
  const kv3 = el("div", "kv");
  refs.readme = liveRow(kv3, "已索引");
  refs.readmeTarget = liveRow(kv3, "目标");
  refs.readmeDisk = liveRow(kv3, "磁盘占用");
  refs.readmeMemory = liveRow(kv3, "内存占用");
  refs.readmeEmpty = liveRow(kv3, "空 README");
  sec3.append(kv3);
  const readmeBar = progressBar();
  refs.readmeBar = readmeBar;
  sec3.append(readmeBar.row);
  root.append(sec3);

  const sec4 = card("快照列表");
  refs.snapBody = el("tbody");
  const snapWrap = tableWrap();
  snapWrap.append(buildTable([{ text: "名称" }, { text: "占用空间", cls: "num" }, { text: "时间" }], refs.snapBody));
  sec4.append(snapWrap);
  root.append(sec4);

  const sec5 = card("仓库检索");
  refs.reposInput = el("input", "input grow");
  refs.reposInput.type = "search";
  refs.reposInput.placeholder = "搜索仓库名 / 作者 / 描述，回车开始检索";
  const form = el("div", "form-row");
  refs.reposBtn = btn("检索", "primary", () => loadRepos(0));
  form.append(refs.reposInput, refs.reposBtn);
  refs.reposInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") loadRepos(0);
  });
  sec5.append(form);
  refs.reposInfo = el("div", "hint", "正在准备检索…");
  sec5.append(refs.reposInfo);
  refs.reposBody = el("tbody");
  const reposWrap = tableWrap();
  reposWrap.append(
    buildTable(
      [{ text: "仓库" }, { text: "星标", cls: "num" }, { text: "分类" }, { text: "最近推送" }, { text: "标记" }],
      refs.reposBody,
    ),
  );
  sec5.append(reposWrap);
  refs.prevBtn = btn("上一页", null, () => loadRepos(Math.max(0, state.repos.offset - state.repos.limit)));
  refs.nextBtn = btn("下一页", null, () => loadRepos(state.repos.offset + state.repos.limit));
  const pager = el("div", "form-row pager");
  pager.append(refs.prevBtn, refs.nextBtn);
  sec5.append(pager);
  root.append(sec5);

  return refs;
}

function mountDataView() {
  if (!V.data) V.data = buildDataView($("view-data"));
  return V.data;
}

async function loadDataView() {
  const refs = mountDataView();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    try {
      state.overview = await apiGet("api/overview");
      hideNotice(refs.notice);
    } catch (e) {
      if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取数据概览失败", "err");
    }
    renderOverview();
    if (!state.repos.loaded) await loadRepos(0);
  } finally {
    restore();
  }
}

function renderOverview() {
  const refs = V.data;
  if (!refs) return;
  const data = state.overview || {};

  refs.nodes.set(fmtNum(data.nodes));
  refs.edges.set(fmtNum(data.edges));
  refs.sectors.set(fmtNum(data.sectors));
  refs.generatedAt.set(data.generatedAt ? fmtDateTime(data.generatedAt) : "—");
  refs.version.set(dash(data.version));

  const files = Array.isArray(data.files) ? data.files : [];
  clear(refs.filesBody);
  if (!files.length) {
    emptyRow(refs.filesBody, 3, "没有文件信息。");
  } else {
    for (const f of files) {
      const tr = el("tr");
      const tdPath = el("td", "mono");
      tdPath.append(el("div", null, dash(f && f.path)));
      if (f && f.label) tdPath.append(el("div", "sub", String(f.label)));
      tr.append(tdPath);
      tr.append(el("td", "num", f ? fmtBytes(f.bytes) : "—"));
      tr.append(el("td", "mono", f ? fmtDateTime(f.mtime) : "—"));
      refs.filesBody.append(tr);
    }
  }

  const readme = data.readme && typeof data.readme === "object" ? data.readme : {};
  const done = numOrNull(readme.indexed);
  const target = numOrNull(readme.target);
  refs.readme(done === null ? "—" : fmtNum(done) + " 篇");
  refs.readmeTarget(
    target !== null && target > 0
      ? fmtNum(target) + " 篇"
      : numOrNull(readme.cached) === null
        ? "—"
        : "无（缓存 " + fmtNum(readme.cached) + " 篇）"
  );
  refs.readmeDisk(numOrNull(readme.diskKB) === null ? "—" : fmtNum(readme.diskKB) + " KB");
  refs.readmeMemory(numOrNull(readme.memoryBytes) === null ? "—" : fmtBytes(readme.memoryBytes));
  refs.readmeEmpty(numOrNull(readme.empty) === null ? "—" : fmtNum(readme.empty) + " 篇");
  refs.readmeBar.set(done, target);

  const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
  clear(refs.snapBody);
  if (!snaps.length) {
    emptyRow(refs.snapBody, 3, "没有快照。");
  } else {
    for (const s of snaps) {
      const tr = el("tr");
      tr.append(el("td", "mono", dash(s && s.name)));
      tr.append(el("td", "num", s ? fmtBytes(s.bytes) : "—"));
      tr.append(el("td", "mono", s ? fmtDateTime(s.mtime) : "—"));
      refs.snapBody.append(tr);
    }
  }
}

async function loadRepos(offset) {
  const refs = mountDataView();
  const q = refs.reposInput ? refs.reposInput.value.trim() : "";
  const limit = state.repos.limit || 20;
  const nextOffset = Math.max(0, numOrNull(offset) ?? 0);
  refs.reposInfo.textContent = "正在检索…";
  refs.prevBtn.disabled = true;
  refs.nextBtn.disabled = true;
  const restore = busyStart(refs.reposBtn, "检索中…");
  try {
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("limit", String(limit));
    params.set("offset", String(nextOffset));
    const data = await apiGet("api/repos?" + params.toString());
    state.repos.items = Array.isArray(data.items) ? data.items : [];
    state.repos.total = numOrNull(data.total) ?? state.repos.items.length;
    state.repos.limit = numOrNull(data.limit) ?? limit;
    state.repos.offset = numOrNull(data.offset) ?? nextOffset;
    state.repos.q = q;
    state.repos.loaded = true;
    hideNotice(refs.notice);
  } catch (e) {
    state.repos.items = [];
    state.repos.offset = nextOffset;
    state.repos.q = q;
    state.repos.loaded = true;
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "检索失败", "err");
  } finally {
    restore();
  }
  renderRepos();
}

function renderRepos() {
  const refs = V.data;
  if (!refs || !refs.reposBody) return;
  const r = state.repos;
  const items = Array.isArray(r.items) ? r.items : [];
  clear(refs.reposBody);

  if (!items.length) {
    emptyRow(refs.reposBody, 5, r.loaded ? "没有匹配的仓库。" : "正在载入…");
  } else {
    for (const item of items) {
      const tr = el("tr");
      if (item && item.archived) tr.classList.add("mark", "warn");
      const tdName = el("td");
      const full = [item && item.owner, item && item.name].filter(Boolean).join("/") || dash(item && item.id);
      // 只放行 http(s)：数据里万一混进 javascript: / data: 之类的值，也绝不能变成可点的链接
      const rawHref = item && typeof item.htmlUrl === "string" ? item.htmlUrl : "";
      const href = /^https?:\/\//i.test(rawHref) ? rawHref : "";
      if (href) {
        const a = el("a", null, full);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        tdName.append(a);
      } else {
        tdName.append(el("span", "mono", full));
      }
      if (item && item.description) tdName.append(el("div", "sub", String(item.description)));
      tr.append(tdName);
      tr.append(el("td", "num", fmtNum(item && item.stars)));
      tr.append(el("td", null, dash(item && item.categoryLabel)));
      tr.append(el("td", "mono", item ? fmtDateTime(item.pushedAt) : "—"));
      const marks = el("td");
      if (item && item.archived) marks.append(el("span", "badge warn", "已归档"));
      if (item && item.fork) marks.append(el("span", "badge", "复刻"));
      if (!marks.childNodes.length) marks.append(el("span", "muted", "—"));
      tr.append(marks);
      refs.reposBody.append(tr);
    }
  }

  const total = numOrNull(r.total) ?? items.length;
  const from = items.length ? r.offset + 1 : 0;
  const to = r.offset + items.length;
  refs.reposInfo.textContent = r.loaded
    ? "共 " + fmtNum(total) + " 条 · 当前第 " + fmtNum(from) + "–" + fmtNum(to) + " 条" + (r.q ? " · 关键词「" + r.q + "」" : "")
    : "正在载入…";
  refs.prevBtn.disabled = r.offset <= 0;
  refs.nextBtn.disabled = !items.length || to >= total;
}


function buildWorkflowView(root) {
  clear(root);
  const refs = { phases: [] };

  refs.notice = noticeEl();
  root.append(refs.notice);

  refs.refreshBtn = btn("刷新", null, () => loadWorkflowView());
  const sec1 = card("流水线", [refs.refreshBtn]);
  const pipe = el("div", "pipeline");
  PIPELINE.forEach((p, i) => {
    const box = el("div", "phase");
    box.append(el("div", "phase-no", "第 " + (i + 1) + " 段"));
    const label = el("div", "phase-label", p.label);
    const desc = el("div", "phase-desc", p.desc);
    const badge = el("span", "badge", "待执行");
    box.append(label, desc, badge);
    refs.phases.push({ box, label, desc, badge });
    if (i > 0) pipe.append(el("div", "phase-arrow", "→"));
    pipe.append(box);
  });
  sec1.append(pipe);
  refs.phaseNote = el("div", "hint");
  sec1.append(refs.phaseNote);
  root.append(sec1);

  const sec2 = card("最近一次运行 · 溯源");
  const kv = el("div", "kv");
  refs.crawlGenerated = liveRow(kv, "生成时间");
  refs.crawlMode = liveRow(kv, "模式");
  refs.crawlRequests = liveRow(kv, "请求 / 预算");
  refs.crawlQuota = liveRow(kv, "配额余量");
  refs.crawlChars = liveRow(kv, "README 字数 / 篇数");
  refs.crawlSeconds = liveRow(kv, "耗时");
  refs.crawlAdded = liveRow(kv, "新增 / 移除");
  refs.crawlSnapshot = liveRow(kv, "快照文件");
  refs.crawlIndexed = liveRow(kv, "索引 / 前端节点");
  sec2.append(kv);
  refs.crawlRaw = el("pre", "log");
  const det = el("details", "raw");
  det.append(el("summary", null, "原始字段"), refs.crawlRaw);
  sec2.append(det);
  root.append(sec2);

  const sec3 = card("日志文件");
  refs.logsBody = el("tbody");
  const wrap = tableWrap();
  wrap.append(
    buildTable(
      [{ text: "名称" }, { text: "占用空间", cls: "num" }, { text: "修改时间" }, { text: "操作", cls: "cell-actions" }],
      refs.logsBody
    )
  );
  sec3.append(wrap);
  root.append(sec3);

  return refs;
}

function mountWorkflowView() {
  if (!V.workflow) V.workflow = buildWorkflowView($("view-workflow"));
  return V.workflow;
}

async function loadWorkflowView() {
  const refs = mountWorkflowView();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    state.workflow = await apiGet("api/workflow");
    hideNotice(refs.notice);
  } catch (e) {
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取工作流失败", "err");
  } finally {
    restore();
  }
  const own = state.workflow && Array.isArray(state.workflow.logs) ? state.workflow.logs : [];
  if (!own.length) {
    try {
      state.logs = await apiGet("api/logs");
    } catch {
      state.logs = null;
    }
  }
  renderWorkflow();
}

function workflowLogs() {
  const wf = state.workflow && typeof state.workflow === "object" ? state.workflow : {};
  const own = Array.isArray(wf.logs) ? wf.logs : [];
  if (own.length) return own;
  return state.logs && Array.isArray(state.logs.files) ? state.logs.files : [];
}

function logNameOf(entry) {
  const raw = pick(entry, ["name", "file", "path"]);
  return raw === undefined ? "" : String(raw);
}

function logBytes(entry) {
  return numOrNull(pick(entry, ["bytes", "size", "sizeBytes"]));
}

function renderWorkflow() {
  const refs = V.workflow;
  if (!refs) return;
  const wf = state.workflow && typeof state.workflow === "object" ? state.workflow : {};
  const raw = state.status && state.status.raw && typeof state.status.raw === "object" ? state.status.raw : null;
  const currentId = (raw && raw.phase) || wf.currentPhase || null;

  const byId = new Map();
  const apiPhases = Array.isArray(wf.phases) ? wf.phases : [];
  for (const p of apiPhases) if (p && p.id) byId.set(String(p.id), p);

  const idx = PIPELINE.findIndex((p) => p.id === String(currentId));
  PIPELINE.forEach((p, i) => {
    const item = refs.phases[i];
    const meta = byId.get(p.id);
    item.label.textContent = meta && meta.label ? String(meta.label) : p.label;
    item.desc.textContent = meta && meta.desc ? String(meta.desc) : p.desc;
    let cls = "phase";
    let text = "待执行";
    let badgeCls = "badge";
    if (idx >= 0) {
      if (i < idx) {
        cls += " done";
        text = "已完成";
        badgeCls = "badge ok";
      } else if (i === idx) {
        cls += " on";
        text = raw && raw.state && raw.state !== "idle" ? "进行中" : "当前";
        badgeCls = "badge hot";
      }
    }
    item.box.className = cls;
    item.badge.className = badgeCls;
    item.badge.textContent = text;
  });

  if (idx >= 0) {
    refs.phaseNote.textContent =
      "当前阶段：" + phaseText(currentId) + (raw && raw.state ? " · 后端状态 " + stateText(raw.state) : "");
  } else if (currentId) {
    refs.phaseNote.textContent = "当前阶段：" + String(currentId) + "（不在五段内）";
  } else if (raw && raw.state === "idle") {
    refs.phaseNote.textContent = "当前空闲：本轮已结束。";
  } else {
    refs.phaseNote.textContent = "拿不到当前阶段。";
  }

  const lc = wf.lastCrawl && typeof wf.lastCrawl === "object" ? wf.lastCrawl : {};
  const stats = lc.stats && typeof lc.stats === "object" ? lc.stats : {};
  const diff = lc.diff && typeof lc.diff === "object" ? lc.diff : {};
  const readme = lc.readme && typeof lc.readme === "object" ? lc.readme : {};
  const hasLc = Object.keys(lc).length > 0;

  refs.crawlGenerated(fmtDateTime(pick(lc, ["generatedAt", "finishedAt", "at"])));
  refs.crawlMode(dash(pick(lc, ["mode", "kind", "source", "builtFrom"])));

  const requests = numOrNull(pick(stats, ["requests"])) ?? numOrNull(pick(lc, ["requests"]));
  const retries = numOrNull(pick(stats, ["retries"]));
  // last-crawl.json 本身不带 budget（采集器只在状态文件里写），取不到就回落到状态文件的本轮预算
  const statusBudget = raw ? numOrNull(raw.budget) : null;
  const budget = numOrNull(pick(lc, ["budget"])) ?? numOrNull(pick(stats, ["budget"])) ?? statusBudget;
  refs.crawlRequests(
    requests === null
      ? "—"
      : fmtNum(requests) +
          (budget !== null ? " / 预算 " + fmtNum(budget) : "") +
          (retries !== null ? "（重试 " + fmtNum(retries) + "）" : "")
  );

  const quota = numOrNull(pick(stats, ["rateLimitRemaining", "coreRemaining"])) ?? numOrNull(pick(lc, ["quotaRemaining", "rateLimitRemaining"]));
  refs.crawlQuota(quota === null ? "—" : fmtNum(quota));

  const readmeStats =
    lc.readmeStats && typeof lc.readmeStats === "object"
      ? lc.readmeStats
      : lc.readmeCache && typeof lc.readmeCache === "object"
        ? lc.readmeCache
        : {};
  const chars =
    numOrNull(pick(readme, ["chars", "charCount"])) ??
    numOrNull(pick(readmeStats, ["chars", "charCount"])) ??
    numOrNull(pick(lc, ["readmeChars", "chars", "words"]));
  const readmeCount = numOrNull(pick(readme, ["count", "indexed"])) ?? numOrNull(pick(lc, ["readmeIndexed"]));
  const charBits = [];
  if (chars !== null) charBits.push(fmtNum(chars) + " 字符");
  if (readmeCount !== null) charBits.push(fmtNum(readmeCount) + " 篇");
  refs.crawlChars(charBits.length ? charBits.join(" · ") : "—");

  const seconds = numOrNull(pick(lc, ["seconds", "durationSeconds", "duration", "elapsed"]));
  refs.crawlSeconds(seconds === null ? "—" : formatDuration(seconds));

  const added = countOf(pick(diff, ["addedCount", "added"])) ?? countOf(pick(lc, ["addedCount", "added"]));
  const removed = countOf(pick(diff, ["removedCount", "removed"])) ?? countOf(pick(lc, ["removedCount", "removed"]));
  const archived = countOf(pick(diff, ["archivedCount", "archived"]));
  if (added === undefined && removed === undefined) {
    refs.crawlAdded("—");
  } else {
    refs.crawlAdded(
      "新增 " + (added === undefined ? "—" : fmtNum(added)) +
        " · 移除 " + (removed === undefined ? "—" : fmtNum(removed)) +
        (archived === undefined ? "" : " · 新归档 " + fmtNum(archived))
    );
  }

  const snap = pick(lc, ["snapshot", "snapshotFile", "snapshotName"]);
  refs.crawlSnapshot(snap === undefined ? "—" : String(snap).split("/").pop());

  const indexed = numOrNull(pick(lc, ["indexedNodes", "indexed"]));
  const frontNodes = numOrNull(pick(lc, ["frontendNodes", "nodes"]));
  const frontEdges = numOrNull(pick(lc, ["frontendEdges", "edges"]));
  const idxBits = [];
  if (indexed !== null) idxBits.push("索引 " + fmtNum(indexed));
  if (frontNodes !== null) idxBits.push("前端 " + fmtNum(frontNodes) + " 节点");
  if (frontEdges !== null) idxBits.push(fmtNum(frontEdges) + " 条连线");
  refs.crawlIndexed(idxBits.length ? idxBits.join(" · ") : "—");

  refs.crawlRaw.textContent = hasLc ? JSON.stringify(lc, null, 2) : "（接口没有返回 lastCrawl 数据）";

  const logs = workflowLogs();
  clear(refs.logsBody);
  if (!logs.length) {
    emptyRow(refs.logsBody, 4, "没有日志文件。");
  } else {
    for (const l of logs) {
      const name = logNameOf(l);
      const bytes = logBytes(l);
      const mtime = pick(l, ["mtime", "modified", "at"]);
      const tr = el("tr");
      tr.append(el("td", "mono", dash(name)));
      tr.append(el("td", "num", fmtBytes(bytes)));
      tr.append(el("td", "mono", fmtWhen(mtime)));
      const td = el("td", "cell-actions");
      const view = btn("查看", "small");
      view.disabled = !name;
      view.addEventListener("click", () => openLogDialog({ name, bytes, mtime, trigger: view }));
      td.append(view);
      tr.append(td);
      refs.logsBody.append(tr);
    }
  }
}


function sameTags(a, b) {
  const norm = (list) =>
    Array.from(new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))).sort();
  const A = norm(a);
  const B = norm(b);
  if (A.length !== B.length) return false;
  return A.every((x, i) => x === B[i]);
}

function zeroRatioText(info) {
  if (!info || typeof info !== "object") return "—";
  const r = info.zeroRatio;
  const asPercent = (pct) => (pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10) + "%";
  if (typeof r === "number" && Number.isFinite(r)) return asPercent(r <= 1 ? r * 100 : r);
  if (typeof r === "string" && r) return r;
  const zero = numOrNull(info.zeroStars);
  const repos = numOrNull(info.repos);
  if (zero !== null && repos !== null && repos > 0) return asPercent((zero / repos) * 100);
  return "—";
}

function buildListsView(root) {
  clear(root);
  const refs = {};

  refs.notice = noticeEl();
  root.append(refs.notice);
  refs.applyNote = noticeEl();
  root.append(refs.applyNote);

  refs.refreshBtn = btn("刷新", null, () => loadListsView());
  const sec1 = card("噪声黑名单", [refs.refreshBtn]);
  refs.blInfo = el("div", "sec-sub");
  sec1.append(refs.blInfo);

  refs.blOwner = el("input", "input owner");
  refs.blOwner.type = "text";
  refs.blOwner.placeholder = "作者名（owner，必填）";
  refs.blNote = el("input", "input note");
  refs.blNote.type = "text";
  refs.blNote.placeholder = "备注（可选）：为什么拉黑";
  const blForm = el("div", "form-row");
  refs.blAdd = btn("添加", "primary", onAddBlacklist);
  blForm.append(refs.blOwner, refs.blNote, refs.blAdd);
  for (const input of [refs.blOwner, refs.blNote]) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") onAddBlacklist(ev);
    });
  }
  sec1.append(blForm);

  // 单仓库级：那个人还有真项目，只想剔掉他名下某一个仓库时用这条（作者级会连真项目一起删）
  refs.blRepo = el("input", "input owner");
  refs.blRepo.type = "text";
  refs.blRepo.placeholder = "仓库（owner/repo，只剔这一个）";
  refs.blRepoNote = el("input", "input note");
  refs.blRepoNote.type = "text";
  refs.blRepoNote.placeholder = "备注（可选）";
  const blRepoForm = el("div", "form-row");
  refs.blRepoAdd = btn("添加仓库", null, onAddBlacklistRepo);
  blRepoForm.append(refs.blRepo, refs.blRepoNote, refs.blRepoAdd);
  for (const input of [refs.blRepo, refs.blRepoNote]) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") onAddBlacklistRepo(ev);
    });
  }
  sec1.append(blRepoForm);

  refs.blBody = el("tbody");
  const blWrap = tableWrap();
  blWrap.append(
    buildTable(
      [
        { text: "作者" },
        { text: "收录仓库", cls: "num" },
        { text: "0 星占比", cls: "num" },
        { text: "最高星标", cls: "num" },
        { text: "原因" },
        { text: "人工添加" },
        { text: "操作", cls: "cell-actions" },
      ],
      refs.blBody,
    ),
  );
  sec1.append(blWrap);
  root.append(sec1);

  refs.wlBadge = el("span", "badge", "与默认值一致");
  refs.wlSave = btn("保存", "primary", onSaveWhitelist);
  refs.wlReset = btn("还原默认", null, onResetWhitelist);
  const sec2 = card("白名单标签", [refs.wlBadge, refs.wlSave, refs.wlReset]);
  sec2.append(el("div", "sec-sub", "改动需点『应用变更』生效。"));
  refs.wlTags = el("div", "tags");
  sec2.append(refs.wlTags);
  refs.wlInput = el("input", "input tag");
  refs.wlInput.type = "text";
  refs.wlInput.placeholder = "新标签，如 dsh-plugin";
  const wlForm = el("div", "form-row");
  wlForm.append(refs.wlInput, btn("添加标签", null, onAddTag));
  refs.wlInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") onAddTag(ev);
  });
  sec2.append(wlForm);
  refs.wlNote = el("div", "hint", "");
  sec2.append(refs.wlNote);

  // 别名组（issue#5 第3条）：白名单条目仍是精确 topic，这里登记同义标签。
  // 一行一组：[规范标签] = [别名1, 别名2]。规范标签必须已经在白名单里，否则忽略（防止凭空扩大抓取口径）。
  sec2.append(el("div", "sec-sub", "别名组：匹配时把它当同义标签归到规范标签上（不改变抓取口径）。一行一组，如 dsh = awesome-dsh, dsh-awesome"));
  refs.wlAlias = el("textarea", "input alias-input");
  refs.wlAlias.rows = 4;
  refs.wlAlias.placeholder = "dsh = awesome-dsh, dsh-tui";
  refs.wlAlias.addEventListener("input", () => {
    refs.wlAlias.dataset.dirty = "1"; // 有未保存的输入时不要被渲染回填冲掉
    renderLists();
  });
  sec2.append(refs.wlAlias);
  refs.wlAliasNote = el("div", "hint", "");
  sec2.append(refs.wlAliasNote);
  root.append(sec2);

  return refs;
}

function mountListsView() {
  if (!V.lists) V.lists = buildListsView($("view-lists"));
  return V.lists;
}

async function loadListsView() {
  const refs = mountListsView();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    state.lists = await apiGet("api/lists");
    state.whitelistDraft = null;
    hideNotice(refs.notice);
  } catch (e) {
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取名单失败", "err");
  } finally {
    restore();
  }
    renderLists(); // 由渲染决定最终禁用态（改回原值后「保存」应当继续置灰）
}

async function reloadLists() {
  state.lists = await apiGet("api/lists");
  state.whitelistDraft = null;
  renderLists();
}

/**
 * 就地把响应里的名单挂上（不再多打一次 api/lists）。
 * 带 impact 的响应（黑名单加/删）走"追加"而不是"替换"：不需要重建 DOM，
 * 调用方也就不会拿到已经被 renderLists() 换掉的 refs.notice 旧节点。
 */
function adoptLists(data, opts) {
  if (!(data && data.lists && typeof data.lists === "object")) return false;
  const append = !!(opts && opts.append);
  state.lists = append ? { ...(state.lists || {}), ...data.lists } : data.lists;
  state.whitelistDraft = null;
  renderLists();
  return true;
}

/** 别名组的文本格式解析：[规范标签] = [别名, 别名]。空行、# 开头都忽略；没写 = 那组不生效。 */
function parseAliasText(text) {
  const groups = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const tag = line.slice(0, eq).trim();
    const aliases = line
      .slice(eq + 1)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tag || !aliases.length) continue;
    groups.push({ tag, aliases });
  }
  return groups;
}

function aliasTextOf(groups) {
  return (Array.isArray(groups) ? groups : []).map((g) => g.tag + " = " + (g.aliases || []).join(", ")).join("\n");
}

function ensureDraft() {
  if (!Array.isArray(state.whitelistDraft)) {
    const tags = state.lists && Array.isArray(state.lists.whitelistTags) ? state.lists.whitelistTags : [];
    state.whitelistDraft = tags.map(String);
  }
}

function removeOwnerButton(owner) {
  return removeBlacklistButton({ action: "remove", payload: { owner } }, owner);
}

function removeBlacklistRepoButton(repoId) {
  return removeBlacklistButton({ action: "remove-repo", payload: { repoId } }, repoId);
}

/** 两级黑名单的删除按钮：两段式确认（先"确认删除"再真删），避免误点。 */
function removeBlacklistButton({ action, payload }, label) {
  const b = btn("删除", "danger small");
  let armed = false;
  let timer = null;
  const reset = () => {
    armed = false;
    b.textContent = "删除";
    b.classList.remove("armed");
    b.disabled = false;
  };
  b.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      b.textContent = "确认删除";
      b.classList.add("armed");
      timer = setTimeout(reset, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    b.textContent = "删除中…";
    b.disabled = true;
    try {
      const data = await apiPost("api/lists/blacklist", { action, ...payload });
      if (!adoptLists(data, { append: true })) await reloadLists();
      applyHintNotice();
      toast("已移除 " + label, "ok");
    } catch (e) {
      reportError(e);
      setNotice(V.lists.notice, (e && e.message) || "移除 " + label + " 失败", "err");
      reset();
    }
  });
  return b;
}

function renderLists() {
  const refs = V.lists;
  if (!refs) return;
  const data = state.lists && typeof state.lists === "object" ? state.lists : {};
  const blacklist = data.blacklist && typeof data.blacklist === "object" ? data.blacklist : {};
  const owners = blacklist.owners && typeof blacklist.owners === "object" ? blacklist.owners : {};
  const repoEntries = Object.entries(blacklist.repos && typeof blacklist.repos === "object" ? blacklist.repos : {}).sort(
    (a, b) => (a[0] < b[0] ? -1 : 1),
  );
  const entries = Object.entries(owners);
  entries.sort((a, b) => {
    const ra = a[1] && typeof a[1] === "object" ? numOrNull(a[1].repos) ?? -1 : -1;
    const rb = b[1] && typeof b[1] === "object" ? numOrNull(b[1].repos) ?? -1 : -1;
    return rb - ra;
  });

  const totalBlacklisted = entries.length + repoEntries.length;
  refs.blInfo.textContent =
    "共 " + fmtNum(entries.length) + " 个作者 + " + fmtNum(repoEntries.length) + " 个仓库" +
    (blacklist.updatedAt ? " · 更新于 " + fmtDateTime(blacklist.updatedAt) : "");
  clear(refs.blBody);
  // 仓库级条目接在同一张表下面：两段 <tbody> 共享一套列，加一行分隔标注不会串位
  const repoBody = el("tbody");
  if (!totalBlacklisted) {
    emptyRow(refs.blBody, 7, "黑名单是空的。");
  } else if (!entries.length) {
    emptyRow(refs.blBody, 7, "没有作者级条目（下面只有单仓库条目）。");
  } else {
    for (const [owner, info] of entries) {
      const rec = info && typeof info === "object" ? info : {};
      const tr = el("tr");
      tr.append(el("td", "mono", owner));
      tr.append(el("td", "num", fmtNum(rec.repos)));
      tr.append(el("td", "num", zeroRatioText(rec)));
      tr.append(el("td", "num", fmtNum(rec.maxStars)));
      tr.append(el("td", "wrap", rec.note ? String(rec.note) : rec.reason === "manual" ? "人工添加" : dash(rec.reason)));
      const manual = rec.manual === true || typeof rec.addedAt === "string" || rec.reason === "manual";
      if (manual) tr.classList.add("mark");
      const manualTd = el("td");
      manualTd.append(el("span", "badge" + (manual ? " hot" : ""), manual ? "是" : "否"));
      tr.append(manualTd);
      const actTd = el("td", "cell-actions");
      actTd.append(removeOwnerButton(owner));
      tr.append(actTd);
      refs.blBody.append(tr);
    }
  }

  if (repoEntries.length) {
    const head = el("tr");
    const headTd = el("td", "wrap", "单仓库级（只剔这一个仓库，不动他名下别的项目）");
    headTd.colSpan = 7;
    head.append(headTd);
    const headRow = el("tbody");
    headRow.append(head);
    refs.blBody.parentNode.append(headRow);
    for (const [repoId, info] of repoEntries) {
      const rec = info && typeof info === "object" ? info : {};
      const tr = el("tr");
      tr.append(el("td", "mono", repoId));
      tr.append(el("td", "num", "—"));
      tr.append(el("td", "num", "—"));
      tr.append(el("td", "num", "—"));
      tr.append(el("td", "wrap", rec.note ? String(rec.note) : "单仓库拉黑"));
      const manualTd = el("td");
      manualTd.append(el("span", "badge hot", "是"));
      tr.append(manualTd);
      const actTd = el("td", "cell-actions");
      actTd.append(removeBlacklistRepoButton(repoId));
      tr.append(actTd);
      repoBody.append(tr);
    }
    refs.blBody.parentNode.append(repoBody);
  }

  ensureDraft();
  const draft = state.whitelistDraft;
  const saved = Array.isArray(data.whitelistTags) ? data.whitelistTags.map(String) : [];
  const defaults = Array.isArray(data.defaultWhitelistTags) ? data.defaultWhitelistTags.map(String) : [];
  const sameAsSaved = sameTags(draft, saved);
  const sameAsDefault = sameTags(draft, defaults);

  clear(refs.wlTags);
  if (!draft.length) {
    refs.wlTags.append(el("span", "muted", "（没有标签，采集会拿不到任何仓库）"));
  } else {
    draft.forEach((tag, i) => {
      const chip = el("span", "tag-chip");
      chip.title = tag;
      chip.append(el("span", "chip-value" + (/[\u3400-\u9fff]/.test(tag) ? "" : " mono"), tag));
      const x = el("button", null, "✕");
      x.type = "button";
      x.title = "移除标签 " + tag;
      x.addEventListener("click", () => {
        state.whitelistDraft.splice(i, 1);
        renderLists();
      });
      chip.append(x);
      refs.wlTags.append(chip);
    });
  }

  refs.wlBadge.className = "badge" + (sameAsDefault ? "" : " warn");
  refs.wlBadge.textContent = sameAsDefault ? "与默认值一致" : "与默认值不同";
  refs.wlReset.hidden = sameAsDefault;
  refs.wlSave.disabled = sameAsSaved || whitelistSaving;
  refs.wlNote.textContent = sameAsSaved
    ? "已与保存值一致（共 " + draft.length + " 个标签）。"
    : "有未保存的改动（" + draft.length + " 个标签），点『保存』写入。";

  if (refs.wlAlias) {
    const aliasDirty = refs.wlAlias.dataset.dirty === "1";
    if (!aliasDirty) refs.wlAlias.value = aliasTextOf(data.whitelistAliases);
    const parsed = parseAliasText(refs.wlAlias.value);
    const known = new Set([...draft, ...defaults]);
    const unknown = parsed.filter((g) => !known.has(g.tag)).map((g) => g.tag);
    const tagCount = parsed.reduce((n, g) => n + g.aliases.length, 0);
    refs.wlAliasNote.className = "hint" + (unknown.length ? " warn" : "");
    refs.wlAliasNote.textContent = !parsed.length
      ? "没有别名组（匹配只认精确标签）。"
      : parsed.length + " 组 / " + tagCount + " 个别名" + (unknown.length ? "；这些规范标签不在白名单里，会被忽略：" + unknown.join("、") : "");
  }

  renderListsApply();
}

/**
 * 设置页：采集参数（以前只活在命令行/代码里，后台看不见也改不了）。
 * 三件事必须同时摆在界面上，否则用户改完只会更迷惑：当前值、默认值、以及"这一项是不是被命令行占着"。
 */
function buildSettingsView(root) {
  const refs = {};
  refs.notice = noticeEl();
  refs.applyNote = noticeEl();
  root.append(refs.notice, refs.applyNote);

  refs.badge = el("span", "badge", "与默认值一致");
  const sec = card("采集参数", [refs.badge, btn("保存", "primary", onSaveSettings), btn("还原默认", null, onResetSettings)]);
  refs.body = el("div", "settings");
  sec.append(refs.body);
  root.append(sec);

  const sec2 = card("采集器当前生效值");
  refs.cLive = el("div", "kv");
  refs.cPath = el("div", "hint", "");
  refs.cNote = el("div", "hint", "");
  sec2.append(refs.cLive, refs.cPath, refs.cNote);
  root.append(sec2);

  return refs;
}

function mountSettingsView() {
  if (!V.settings) V.settings = buildSettingsView($("view-settings"));
  return V.settings;
}

async function loadSettingsView() {
  const refs = mountSettingsView();
  const restore = busyStart(refs.badge, "读取中…");
  try {
    state.settings = await apiGet("api/settings");
    state.settingsDraft = null;
    hideNotice(refs.notice);
  } catch (e) {
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取采集参数失败", "err");
  } finally {
    restore();
  }
  renderSettings();
  renderSettingsLive();
}

function ensureSettingsDraft() {
  if (!state.settingsDraft && state.settings) {
    const values = {};
    for (const field of state.settings.fields) values[field.key] = state.settings.collector[field.key];
    state.settingsDraft = values;
  }
  return state.settingsDraft;
}

/** 数值输入：字符串（空/半截数字）原样留着，交给保存时校验，别边打字边抹掉用户输入 */
function settingsInputValue(v) {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function rangeText(spec) {
  if (!spec) return "";
  return spec.type === "float" ? spec.min + " ~ " + spec.max : spec.min + " ~ " + spec.max;
}

function renderSettings() {
  const refs = V.settings;
  const view = state.settings;
  if (!refs || !view || !Array.isArray(view.fields)) return;
  if (!state.settingsDraft) ensureSettingsDraft();
  const draft = state.settingsDraft || {};
  const defaults = view.defaults || {};
  const ranges = view.ranges || {};
  refs.body.textContent = "";
  const draftKeys = [];
  for (const field of view.fields) {
    const spec = ranges[field.key] || {};
    const row = el("div", "set-item");
    const head = el("div", "set-head");
    const label = el("label", "set-label", field.label);
    label.htmlFor = "set-" + field.key;
    const input = el("input", "input set-value");
    input.id = "set-" + field.key;
    input.type = "number";
    input.step = spec.type === "float" ? "0.05" : "1";
    if (spec.min !== undefined) input.min = String(spec.min);
    if (spec.max !== undefined) input.max = String(spec.max);
    input.value = settingsInputValue(draft[field.key]);
    input.addEventListener("input", () => {
      draft[field.key] = input.value;
      settingsSetStatus(refs, field.key, "");
    });
    head.append(label, el("span", "set-unit", field.unit || ""), input);
    row.append(head);
    row.append(el("div", "hint", field.hint || ""));
    const foot = el("div", "set-foot");
    foot.append(el("span", "set-status", ""));
    foot.append(el("span", "set-range", "范围 " + rangeText(spec) + " · 默认 " + fmtSetting(defaults[field.key])));
    row.append(foot);
    refs.body.append(row);
    draftKeys.push(field.key);
  }
  refs.draftKeys = draftKeys;
  renderSettingsBadge();
}

function renderSettingsBadge() {
  const refs = V.settings;
  const view = state.settings;
  if (!refs || !view || !refs.badge) return;
  const draft = state.settingsDraft || {};
  const changed = Object.keys(draft).filter((key) => settingsNum(draft[key]) !== settingsNum(view.collector[key]));
  const differsFromDefault = Object.keys(view.defaults || {}).some((key) => settingsNum(view.collector[key]) !== settingsNum(view.defaults[key]));
  refs.badge.className = "badge" + (differsFromDefault ? " warn" : "");
  refs.badge.textContent = changed.length ? "有 " + changed.length + " 项未保存" : differsFromDefault ? "与默认值不同" : "与默认值一致";
}

function settingsNum(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtSetting(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** 单格结果：kind 空字符串 = 清掉（含正在输入中的合法值，别一直红着） */
function settingsSetStatus(refs, key, kind, text) {
  const input = refs.body && refs.body.querySelector("#set-" + key);
  if (!input) return;
  const row = input.closest(".set-item");
  const el2 = row ? row.querySelector(".set-status") : null;
  if (el2) {
    el2.textContent = text || "";
    el2.className = "set-status" + (kind ? " " + kind : "");
  }
  input.classList.toggle("bad", kind === "bad");
}

/** 采集器侧：本轮真正生效的参数，以及它来自哪里（cli / config / default） */
function renderSettingsLive() {
  const refs = V.settings;
  if (!refs || !refs.cLive) return;
  const view = state.settings;
  refs.cPath.textContent = view ? "配置文件：" + view.configPath : "";
  refs.cNote.textContent = view && view.note ? view.note : "";
  const status = state.status || {};
  const live = status.collectorArgs && typeof status.collectorArgs === "object" ? status.collectorArgs : null;
  const source = status.collectorSource && typeof status.collectorSource === "object" ? status.collectorSource : {};
  refs.cLive.textContent = "";
  if (!live) {
    refs.cLive.append(el("div", "hint", "采集器还没上报过（它每轮开始时写一次）。保存的配置下一轮自动生效。"));
    return;
  }
  for (const field of (view && view.fields) || []) {
    const value = live[field.key];
    if (value === undefined) continue;
    const from = source[field.key] || "default";
    const row = el("div", "kv-row");
    row.append(el("span", "kv-k", field.label));
    row.append(el("span", "kv-v", fmtSetting(value) + (field.unit ? " " + field.unit : "")));
    const chip = el("span", "badge" + (from === "cli" ? " warn" : ""), from === "cli" ? "命令行" : from === "config" ? "后台配置" : "内置默认");
    row.append(chip);
    refs.cLive.append(row);
  }
  refs.cLive.append(el("div", "hint", "「后台配置」= 这一页保存的值（优先）；「启动参数」= 只在这一项没配置时生效；「内置默认」= 出厂值。"));
}

async function onSaveSettings(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const refs = V.settings;
  if (!refs || !state.settings) return;
  const draft = ensureSettingsDraft() || {};
  const patch = {};
  let bad = 0;
  for (const key of refs.draftKeys || []) {
    const spec = (state.settings.ranges || {})[key] || {};
    const n = settingsNum(draft[key]);
    if (n === null) {
      settingsSetStatus(refs, key, "bad", "必须是数字");
      bad += 1;
      continue;
    }
    if (spec.type === "int" && !Number.isInteger(n)) {
      settingsSetStatus(refs, key, "bad", "必须是整数");
      bad += 1;
      continue;
    }
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
      settingsSetStatus(refs, key, "bad", "超出范围 " + rangeText(spec));
      bad += 1;
      continue;
    }
    settingsSetStatus(refs, key, "");
    patch[key] = n;
  }
  if (bad) {
    setNotice(refs.notice, "有 " + bad + " 项不合法，先改好再保存。", "err");
    return;
  }
  const restore = busyStart($("tabs"), "保存中…");
  try {
    const data = await apiPost("api/settings", { collector: patch });
    state.settings = data;
    state.settingsDraft = null;
    renderSettings();
    renderSettingsLive();
    if (Array.isArray(data.rejected) && data.rejected.length) {
      setNotice(refs.notice, "这些项没被接受（超出范围或不是数字）：" + data.rejected.join("、") + "。它们已回退到默认值。", "warn");
    } else {
      setNotice(refs.notice, "已保存。下一轮采集自动按新值跑（不必重启）。", "ok");
    }
  } catch (e) {
    reportError(e);
    setNotice(refs.notice, (e && e.message) || "保存失败", "err");
  } finally {
    restore();
  }
}

function onResetSettings(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const refs = V.settings;
  if (!refs || !state.settings) return;
  state.settingsDraft = { ...state.settings.defaults };
  renderSettings();
  setNotice(refs.notice, "已填回内置默认值，点『保存』才会写进配置。", "warn");
}

async function onAddBlacklist(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const refs = V.lists;
  if (!refs) return;
  const owner = refs.blOwner.value.trim();
  const note = refs.blNote.value.trim();
  if (!owner) {
    setNotice(refs.notice, "请先填写作者名（owner）。", "err");
    refs.blOwner.focus();
    return;
  }
  if (owner.includes("/")) {
    setNotice(refs.notice, "只填作者名（owner），不要带 / 或仓库名。", "err");
    return;
  }
  if (/\s/.test(owner)) {
    setNotice(refs.notice, "作者名不能包含空格。", "err");
    return;
  }
  const restore = busyStart(refs.blAdd, "添加中…");
  try {
    const data = await apiPost("api/lists/blacklist", { action: "add", owner, note });
    refs.blOwner.value = "";
    refs.blNote.value = "";
    // 追加式挂载：保住函数开头拿到的 refs.notice，后面 hideNotice 才清得掉旧红条
    if (!adoptLists(data, { append: true })) await reloadLists();
    applyHintNotice();
    return reportBlacklistAdded(refs, owner, data);
  } catch (e) {
    reportError(e);
    setNotice(refs.notice, (e && e.message) || "添加失败", "err");
  } finally {
    restore();
  }
}

/**
 * 加完黑名单后的反馈。三条铁律（issue#5 第2条）：
 *  ① 旧的红条必须先清掉 —— 否则"上一次失败 + 这一次成功"同屏，看着就像又失败了；
 *  ② 一定要说清"要等『立即应用』才生效"—— 文件是立刻落盘的，图不是；
 *  ③ repos=0 必须直说"他当前不在数据里" —— 这才叫如实反馈，回一句"已加入"是骗人。
 */
function reportBlacklistAdded(refs, owner, data) {
  const impact = data && data.impact ? data.impact : null;
  const repos = impact && Number.isFinite(impact.repos) ? impact.repos : null;
  const stars = impact && Number.isFinite(impact.totalStars) ? impact.totalStars : 0;
  if (data && data.created === false) {
    setNotice(refs.notice, owner + " 已在黑名单里，本次只更新了备注" + (repos ? "；" + affectedReposText(repos, stars) : "") + "。", "warn");
    toast("已更新备注：" + owner, "ok");
    return;
  }
  if (repos === null) {
    toast("已加入黑名单：" + owner + "（需点『立即应用』才生效）", "ok");
    return;
  }
  if (repos === 0) {
    setNotice(refs.notice, "已加入黑名单：" + owner + " —— 但他当前不在数据里（累积索引 0 个仓库），加名单不会有可见变化。", "warn");
    toast("已加入黑名单：" + owner + "（当前不在数据里）", "warn");
    return;
  }
  toast("已加入黑名单：" + owner + "（" + affectedReposText(repos, stars) + "）", "ok");
}

/** 影响预估的统一措辞：影响的是"点应用之后会被剔出图"的仓库数。 */
function affectedReposText(repos, stars) {
  return "点『立即应用』后将移除 " + repos + " 个仓库" + (stars ? "（合计 " + stars + " star）" : "");
}

/** 单仓库级黑名单：目标明确（就这一个），不需要作者级那样的影响预估，但同样要等『立即应用』才进图。 */
async function onAddBlacklistRepo(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const refs = V.lists;
  if (!refs || !refs.blRepo) return;
  const repoId = refs.blRepo.value.trim();
  const note = refs.blRepoNote ? refs.blRepoNote.value.trim() : "";
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoId)) {
    setNotice(refs.notice, "要写成 owner/repo，例如 deepseek-ai/deepseek-harness", "err");
    refs.blRepo.focus();
    return;
  }
  const restore = busyStart(refs.blRepoAdd, "添加中…");
  try {
    const data = await apiPost("api/lists/blacklist", { action: "add-repo", repoId, note });
    refs.blRepo.value = "";
    if (refs.blRepoNote) refs.blRepoNote.value = "";
    if (!adoptLists(data, { append: true })) await reloadLists();
    applyHintNotice();
    hideNotice(refs.notice);
    toast("已加入仓库黑名单：" + repoId + "（点『立即应用』后从图里移除）", "ok");
  } catch (e) {
    reportError(e);
    setNotice(refs.notice, (e && e.message) || "添加失败", "err");
  } finally {
    restore();
  }
}

function onAddTag(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const refs = V.lists;
  if (!refs) return;
  const tag = refs.wlInput.value.trim();
  if (!tag) {
    setNotice(refs.notice, "请先输入标签。", "err");
    refs.wlInput.focus();
    return;
  }
  if (/\s/.test(tag)) {
    setNotice(refs.notice, "标签不能包含空格。", "err");
    return;
  }
  ensureDraft();
  if (state.whitelistDraft.includes(tag)) {
    setNotice(refs.notice, "标签已在列表里：" + tag, "warn");
  } else {
    state.whitelistDraft.push(tag);
    hideNotice(refs.notice);
  }
  refs.wlInput.value = "";
  renderLists();
}

async function onSaveWhitelist() {
  const refs = V.lists;
  if (!refs) return;
  ensureDraft();
  whitelistSaving = true;
  const restore = busyStart(refs.wlSave, "保存中…");
  try {
    const payload = { tags: state.whitelistDraft.slice() };
    if (refs.wlAlias) {
      payload.whitelistAliases = parseAliasText(refs.wlAlias.value);
      refs.wlAlias.dataset.dirty = "0"; // 保存成功后允许服务端规范化结果回填
    }
    const data = await apiPost("api/lists/whitelist", payload);
    if (!adoptLists(data)) await reloadLists();
    applyHintNotice();
    toast("白名单已保存", "ok");
  } catch (e) {
    reportError(e);
    setNotice(refs.notice, (e && e.message) || "保存失败", "err");
  } finally {
    whitelistSaving = false;
    restore();
    renderLists(); // 由渲染决定最终禁用态（改回原值后「保存」应当继续置灰）
  }
}

function onResetWhitelist() {
  const refs = V.lists;
  if (!refs) return;
  const data = state.lists && typeof state.lists === "object" ? state.lists : {};
  const defaults = Array.isArray(data.defaultWhitelistTags) ? data.defaultWhitelistTags.map(String) : [];
  state.whitelistDraft = defaults.slice();
  renderLists();
  refs.wlNote.textContent = "已填入默认标签（" + defaults.length + " 个），点『保存』写入。";
}

/* ============================================================
   标签 5：共鸣 —— 左栏基座列表（选中高亮），右栏选中基座的详情
   （基本信息 / 锚定条件 / 子项表格）；写操作走 POST api/resonance/base|child，
   接口回整份 GET 结构，直接采用。
   ============================================================ */

function stringList(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function hasField(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function fact(label, value) {
  const box = el("span", "fact");
  box.append(el("i", null, label), el("b", null, value));
  return box;
}

/**
 * 可编辑标签胶囊组：每个胶囊带「✕」删除，末尾一个「＋ 添加」输入框（回车提交）；
 * 数组由组件自己维护，增删后回调 onChange(next)，由调用方决定落库还是只改草稿。
 */
function chipEditor(values, onChange, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const box = el("div", "chip-editor" + (o.compact ? " compact" : ""));
  const list = stringList(values);

  const commit = () => {
    if (typeof onChange === "function") onChange(list.slice());
  };

  const render = () => {
    clear(box);
    list.forEach((value, i) => {
      const chip = el("span", "tag-chip");
      chip.title = value;
      // "前缀:值" 的信号（如 README搜索:xxx）拆两段：前缀弱化、值用等宽
      // 纯中文值不上等宽，避免中英混排别扭
      const cut = value.indexOf(":");
      const tail = cut > 0 ? value.slice(cut + 1) : value;
      if (cut > 0) chip.append(el("span", "chip-prefix", value.slice(0, cut + 1)));
      chip.append(el("span", "chip-value" + (/[\u3400-\u9fff]/.test(tail) ? "" : " mono"), tail));
      const x = el("button", null, "✕");
      x.type = "button";
      x.title = "移除 " + value;
      x.addEventListener("click", () => {
        list.splice(i, 1);
        render();
        commit();
      });
      chip.append(x);
      box.append(chip);
    });
    const input = el("input", "input chip-add");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = o.placeholder || "＋ 添加";
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const value = input.value.trim();
      input.value = "";
      if (!value || list.includes(value)) return;
      list.push(value);
      render();
      commit();
      const next = box.querySelector(".chip-add");
      if (next && typeof next.focus === "function") next.focus();
    });
    box.append(input);
  };

  render();
  return box;
}

function anchorRow(label, control) {
  const row = el("div", "anchor-row");
  row.append(el("div", "anchor-label", label));
  const value = el("div", "anchor-value");
  value.append(control);
  row.append(value);
  return row;
}

function inputWithSave(cls, placeholder, value, onSave) {
  const box = el("div", "inline-save");
  const input = inputEl(cls, placeholder, value);
  const save = btn("保存", "small", () => onSave(input.value.trim()));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onSave(input.value.trim());
    }
  });
  box.append(input, save);
  return box;
}

/** 语境选项：优先用接口返回的 contexts；接口没给（或漏项）时用基座自带的 context 兜底 */
function contextOptions(data, base, bases) {
  const out = [];
  const seen = new Set();
  const push = (id, label, desc) => {
    const key = String(id ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, label: String(label ?? "").trim() || key, desc: String(desc ?? "").trim() });
  };
  const list = data && Array.isArray(data.contexts) ? data.contexts : [];
  for (const c of list) {
    if (c && typeof c === "object") {
      push(pick(c, ["id", "value", "key"]), pick(c, ["label", "name", "title"]), pick(c, ["desc", "description", "note"]));
    }
  }
  const all = Array.isArray(bases) ? bases : [];
  for (const b of all.concat([base])) {
    if (b && b.context) push(b.context, b.contextLabel);
  }
  return out;
}

function contextSelect(options, current, onChange, allowEmpty) {
  const sel = el("select", "input ctx");
  if (allowEmpty) {
    const empty = el("option", null, "未设置");
    empty.value = "";
    sel.append(empty);
  }
  for (const item of options) {
    const opt = el("option", null, item.label);
    opt.value = item.id;
    if (item.desc) opt.title = item.desc;
    sel.append(opt);
  }
  const want = String(current ?? "");
  sel.value = want;
  if (sel.value !== want) sel.value = !allowEmpty && options.length ? options[0].id : "";
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function meshDot(inMesh) {
  const dot = el("span", "dot" + (inMesh === true ? " on" : inMesh === false ? " off" : ""));
  dot.title = inMesh === true ? "在图中" : inMesh === false ? "未入图" : "未知";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", dot.title);
  return dot;
}

function buildResonanceView(root) {
  clear(root);
  const refs = {};

  refs.notice = noticeEl();
  root.append(refs.notice);

  const bar = el("section", "sec");
  const head = el("div", "sec-h");
  refs.sourceBadge = el("span", "badge", "后台副本");
  refs.sourceBadge.hidden = true;
  refs.pendingBadge = el("span", "badge warn", "有未应用改动");
  refs.pendingBadge.hidden = true;
  refs.curationBadge = el("span", "badge", "锚定条件待重新策展");
  refs.curationBadge.hidden = true;
  refs.curationBadge.title = "锚定条件与上次策展不同。它只在重新策展时用来发现子节点，「立即应用」不会改变现有连线；要按新条件重跑：node tools/curate-ecosystem.mjs";
  head.append(el("span", "sec-title", "生态共鸣"), refs.sourceBadge, refs.pendingBadge, refs.curationBadge);
  const actions = el("div", "sec-actions");
  refs.savingNote = el("span", "hint tight", ""); 
  refs.savingNote.hidden = true;
  refs.pendingHint = btn("立即应用", "primary small", onApplyClick);
  refs.pendingHint.hidden = true;
  refs.pendingHint.title = "用累积索引离线重算一次，让共鸣清单的改动生效";
  refs.refreshBtn = btn("刷新", null, () => loadResonanceView());
  actions.append(refs.savingNote, refs.pendingHint, refs.refreshBtn);
  head.append(actions);
  bar.append(head);
  refs.applyNotice = noticeEl();
  bar.append(refs.applyNotice);
  refs.facts = el("div", "res-facts");
  bar.append(refs.facts);
  refs.managedNote = noticeEl();
  bar.append(refs.managedNote);
  root.append(bar);

  refs.newBtn = btn("＋ 新增基座", "small", onNewBaseClick);
  const listSec = card("基座", [refs.newBtn]);
  refs.listBox = el("div", "res-list");
  listSec.append(refs.listBox);
  refs.resetBtn = confirmButton(
    "还原策展版本",
    "会用策展版本覆盖后台副本，手工改动都会丢。",
    onResetResonance,
    "确认还原"
  );
  const resetRow = el("div", "form-row tight");
  resetRow.append(refs.resetBtn);
  listSec.append(resetRow);

  refs.detail = el("div", "res-detail");

  const left = el("div", "res-col");
  left.append(listSec);
  const right = el("div", "res-col");
  right.append(refs.detail);
  const layout = el("div", "res-layout");
  layout.append(left, right);
  root.append(layout);

  return refs;
}

function mountResonanceView() {
  if (!V.resonance) V.resonance = buildResonanceView($("view-resonance"));
  return V.resonance;
}

async function loadResonanceView() {
  const refs = mountResonanceView();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    state.resonance = await apiGet("api/resonance");
    hideNotice(refs.notice);
  } catch (e) {
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取共鸣配置失败", "err");
  } finally {
    restore();
  }
  renderResonance();
}


function renderResonanceSaving() {
  const refs = V.resonance;
  if (!refs || !refs.savingNote) return;
  refs.savingNote.hidden = resonanceSaving === 0;
  refs.savingNote.textContent = resonanceSaving ? "保存中…" : "";
}

async function withResonanceSaving(fn) {
  resonanceSaving += 1;
  renderResonanceSaving();
  try {
    return await fn();
  } finally {
    resonanceSaving = Math.max(0, resonanceSaving - 1);
    renderResonanceSaving();
  }
}

function validRepoId(id) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(id);
}

function baseEnabled(base) {
  return typeof base.enabled === "boolean" ? base.enabled : base.enabled !== false;
}

function newBaseDraft() {
  return { id: "", label: "", tag: "", enabled: true, probes: [], packages: [], context: "" };
}

/** 共鸣写接口按契约回整份 GET 结构，直接采用；万一只回 {ok:true} 就补一次 GET */
async function adoptResonance(data) {
  const payload =
    data && data.resonance && typeof data.resonance === "object" && Array.isArray(data.resonance.bases)
      ? data.resonance
      : data;
  if (payload && Array.isArray(payload.bases)) {
    state.resonance = payload;
    renderResonance();
    return;
  }
  await loadResonanceView();
}

/**
 * POST api/resonance/base。
 * 兼容旧版后台：没有 /base 子路由时（404「未知后台接口」）开关退回 POST api/resonance{baseId,enabled}。
 */
async function postResonanceBase(body) {
  try {
    return await apiPost("api/resonance/base", body);
  } catch (e) {
    const missingRoute =
      e && e.status === 404 && e.body && typeof e.body.error === "string" && e.body.error.includes("未知后台接口");
    const simpleToggle =
      body && body.action === "update" && typeof body.enabled === "boolean" && Object.keys(body).length === 3;
    if (missingRoute && simpleToggle) return await apiPost("api/resonance", { baseId: body.id, enabled: body.enabled });
    throw e;
  }
}

function postResonanceChild(body) {
  return apiPost("api/resonance/child", body);
}

async function afterResonanceSave(data, kind = "graph") {
  await adoptResonance(data);
  afterSaveHint(kind);
}

async function onUpdateBase(base, fields) {
  const refs = V.resonance;
  const body = { action: "update", id: base.id };
  for (const key of ["label", "tag", "enabled", "probes", "packages", "context"]) {
    if (hasField(fields, key)) body[key] = fields[key];
  }
  const touchesGraph = hasField(fields, "enabled") || hasField(fields, "label");
  const kind = touchesGraph ? "graph" : hasField(fields, "tag") || hasField(fields, "probes") || hasField(fields, "packages") || hasField(fields, "context") ? "curation" : "saved";
  await withResonanceSaving(async () => {
    try {
      await afterResonanceSave(await postResonanceBase(body), kind);
    } catch (e) {
      reportError(e);
      if (refs) setNotice(refs.notice, (e && e.message) || "保存锚定条件失败", "err");
      renderResonance(); // 回到服务端那份，别把没存上的改动留在界面上
    }
  });
}

async function onUpdateChild(base, child, fields) {
  const refs = V.resonance;
  const body = { action: "update", baseId: base.id, childId: child.id };
  if (hasField(fields, "signals")) body.signals = fields.signals;
  if (hasField(fields, "readme")) body.readme = fields.readme;
  return await withResonanceSaving(async () => {
    try {
      await afterResonanceSave(await postResonanceChild(body), "saved");
      return true;
    } catch (e) {
      reportError(e);
      if (refs) setNotice(refs.notice, (e && e.message) || "保存子项失败", "err");
      renderResonance();
      return false;
    }
  });
}

async function onToggleBase(base, checked, input) {
  input.disabled = true; // 请求期间禁用开关，避免连点
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceBase({ action: "update", id: base.id, enabled: !!checked });
      await adoptResonance(data);
      applyHintNotice();
      toast("已保存：" + (base.label || base.id) + (checked ? " 启用" : " 停用"), "ok");
    } catch (e) {
      reportError(e);
      input.checked = !checked;
      input.disabled = false;
      setNotice(V.resonance.notice, (e && e.message) || "保存失败", "err");
    }
  });
}

function onNewBaseClick() {
  state.resonanceShowNew = true;
  state.resonanceSelectedId = null;
  state.resonanceNew = newBaseDraft();
  renderResonance();
}

async function onAddBase(idInput, trigger) {
  const refs = V.resonance;
  if (!refs) return;
  const draft = state.resonanceNew && typeof state.resonanceNew === "object" ? state.resonanceNew : newBaseDraft();
  const id = String(draft.id ?? "").trim().replace(/^\/+|\/+$/g, "");
  const focusId = () => {
    if (idInput && typeof idInput.focus === "function") idInput.focus();
  };
  if (!id) {
    setNotice(refs.notice, "请先填写基座 id（owner/repo）。", "err");
    focusId();
    return;
  }
  if (!validRepoId(id)) {
    setNotice(refs.notice, "基座 id 必须是 owner/repo 形式（只含字母数字与 . _ -）。", "err");
    focusId();
    return;
  }
  const label = String(draft.label ?? "").trim();
  const tag = String(draft.tag ?? "").trim();
  const context = String(draft.context ?? "").trim();
  const body = {
    action: "add",
    id,
    enabled: draft.enabled !== false,
    probes: stringList(draft.probes),
    packages: stringList(draft.packages),
  };
  if (label) body.label = label;
  if (tag) body.tag = tag;
  if (context) body.context = context;
  const restore = busyStart(triggerButtonOf(trigger), "添加中…");
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceBase(body);
      state.resonanceNew = newBaseDraft();
      state.resonanceSelectedId = id;
      state.resonanceShowNew = false;
      await adoptResonance(data);
      applyHintNotice();
      toast("已新增基座：" + id, "ok");
    } catch (e) {
      reportError(e);
      setNotice(refs.notice, (e && e.message) || "新增基座失败", "err");
    } finally {
      restore();
    }
  });
}

async function onSaveBase(base, fields, trigger) {
  const refs = V.resonance;
  const label = fields.label.value.trim();
  const restore = busyStart(triggerButtonOf(trigger), "保存中…");
  await withResonanceSaving(async () => {
    try {
      const enabledChanged = !!fields.enabled.checked !== !!base.enabled;
      const labelChanged = label !== (base.label ?? "");
      const data = await postResonanceBase({ action: "update", id: base.id, label, enabled: !!fields.enabled.checked });
      await adoptResonance(data);
      if (enabledChanged || labelChanged) {
        applyHintNotice();
        toast("已保存：" + (label || base.id) + "（需点『立即应用』生效）", "ok");
      } else {
        toast("已保存：" + (label || base.id), "ok");
      }
    } catch (e) {
      reportError(e);
      if (refs) setNotice(refs.notice, (e && e.message) || "保存基座失败", "err");
    } finally {
      restore();
    }
  });
}

async function onRemoveBase(base) {
  const refs = V.resonance;
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceBase({ action: "remove", id: base.id });
      if (state.resonanceSelectedId === String(base.id)) state.resonanceSelectedId = null;
      state.resonanceShowNew = false;
      await adoptResonance(data);
      applyHintNotice();
      toast("已删除基座：" + (base.label || base.id), "ok");
    } catch (e) {
      reportError(e);
      if (refs) setNotice(refs.notice, (e && e.message) || "删除基座失败", "err");
    }
  });
}

async function onResetResonance() {
  const refs = V.resonance;
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceBase({ action: "reset" });
      state.resonanceSelectedId = null;
      state.resonanceShowNew = false;
      state.resonanceNew = newBaseDraft();
      await adoptResonance(data);
      applyHintNotice();
      toast("已还原为策展版本", "ok");
    } catch (e) {
      reportError(e);
      if (refs) setNotice(refs.notice, (e && e.message) || "还原失败", "err");
    }
  });
}

async function onAddChild(base, input, trigger) {
  const id = input.value.trim();
  if (!id) {
    setNotice(V.resonance.notice, "请先填写子项 id（owner/repo）。", "err");
    input.focus();
    return;
  }
  if (!validRepoId(id)) {
    setNotice(V.resonance.notice, "子项 id 必须是 owner/repo 形式。", "err");
    input.focus();
    return;
  }
  const restore = busyStart(triggerButtonOf(trigger), "添加中…");
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceChild({ action: "add", baseId: base.id, childId: id });
      input.value = "";
      await adoptResonance(data);
      applyHintNotice();
      toast("已添加子项：" + id, "ok");
    } catch (e) {
      reportError(e);
      setNotice(V.resonance.notice, (e && e.message) || "添加子项失败", "err");
    } finally {
      restore();
    }
  });
}

async function onRemoveChild(base, child) {
  await withResonanceSaving(async () => {
    try {
      const data = await postResonanceChild({ action: "remove", baseId: base.id, childId: child.id });
      await adoptResonance(data);
      applyHintNotice();
      toast("已移除子项：" + child.id, "ok");
    } catch (e) {
      reportError(e);
      setNotice(V.resonance.notice, (e && e.message) || "移除子项失败", "err");
    }
  });
}

/* ---------------- 右栏三块：基本信息 / 锚定条件 / 子项 ---------------- */

function baseInfoCard(base) {
  const label = inputEl("grow", "显示名", pick(base, ["label", "name"]) ?? "");
  const sw = makeSwitch(baseEnabled(base), (checked, input) => onToggleBase(base, checked, input));
  const saveBtn = btn("保存", "primary small"); 
  const save = (ev) => onSaveBase(base, { label, enabled: sw.input }, triggerButtonOf(ev) || saveBtn);
  saveBtn.addEventListener("click", save);
  label.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      save(ev);
    }
  });
  const sec = card("基本信息", [
    confirmButton("删除基座", "只从清单删除，不影响仓库本身。", () => onRemoveBase(base)),
    saveBtn,
  ]);
  const row = el("div", "form-row tight");
  row.append(inlineField("显示名", label), inlineField("启用", sw.wrap));
  sec.append(row);

  const facts = el("div", "res-facts");
  facts.append(el("span", "mono", dash(base.id)));
  if (base.inMesh === true) facts.append(el("span", "badge ok", "在图中"));
  else if (base.inMesh === false) facts.append(el("span", "badge warn", "未入图"));
  facts.append(fact("子项", fmtNum(Array.isArray(base.children) ? base.children.length : 0)));
  const edges = numOrNull(pick(base, ["edgeCount", "edges"]));
  facts.append(fact("共鸣边", edges === null ? "—" : fmtNum(edges)));
  const verified = numOrNull(pick(base, ["verifiedCount", "verified", "curatedCount"]));
  if (verified !== null) facts.append(fact("策展复核", fmtNum(verified)));
  sec.append(facts);
  return sec;
}

function anchorsCard(base, data, bases) {
  const builtin = base.builtinAnchors && typeof base.builtinAnchors === "object" ? base.builtinAnchors : null;
  const actions = [];
  if (builtin) {
    actions.push(
      confirmButton(
        "恢复内置锚定条件",
        "会用内置策展定义覆盖当前的探针词 / 包名 / 语境 / 生态签。",
        () =>
          onUpdateBase(base, {
            probes: stringList(builtin.probes),
            packages: stringList(builtin.packages),
            context: builtin.context ?? "",
            tag: builtin.tag ?? "",
          }),
        "确认恢复"
      )
    );
  }
  const sec = card("锚定条件", actions);

  const known =
    hasField(base, "probes") || hasField(base, "packages") || hasField(base, "context") || hasField(base, "tag") || !!builtin;
  if (!known) {
    sec.append(el("div", "hint tight", "接口没有返回锚定条件字段，暂时无法编辑。"));
    return sec;
  }

  sec.append(
    anchorRow(
      "探针词",
      chipEditor(stringList(base.probes), (next) => onUpdateBase(base, { probes: next }), { placeholder: "＋ 添加探针词" })
    )
  );
  sec.append(
    anchorRow(
      "包名 / 标识",
      chipEditor(stringList(base.packages), (next) => onUpdateBase(base, { packages: next }), { placeholder: "＋ 添加包名" })
    )
  );

  const options = contextOptions(data, base, bases);
  if (options.length) {
    sec.append(
      anchorRow("语境规则", contextSelect(options, base.context, (v) => onUpdateBase(base, { context: v }), !base.context))
    );
  } else {
    sec.append(
      anchorRow("语境规则", inputWithSave("ctx", "语境 id", base.context ?? "", (v) => onUpdateBase(base, { context: v })))
    );
  }

  sec.append(
    anchorRow("生态签", inputWithSave("tag", "GitHub topic，可为空", base.tag ?? "", (v) => onUpdateBase(base, { tag: v })))
  );
  return sec;
}

function childReadmeCell(base, child) {
  const saved = typeof child.readme === "string" ? child.readme : "";
  const input = inputEl("readme", "README 复核词", saved);
  const note = el("span", "save-note", "");
  let last = saved;
  let busy = false;
  const submit = () => {
    if (busy || !input.isConnected) return;
    const value = input.value.trim();
    if (value === last) return;
    busy = true;
    note.textContent = "保存中…";
    Promise.resolve(onUpdateChild(base, child, { readme: value }))
      .then((ok) => {
        if (ok) last = value;
        note.textContent = ok ? "已保存" : "保存失败";
        if (ok) {
          const timer = setTimeout(() => {
            if (note.textContent === "已保存") note.textContent = "";
          }, 2000);
          timer?.unref?.();
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  });
  input.addEventListener("blur", submit);
  const box = el("div", "inline-save");
  box.append(input, note);
  return box;
}

function childrenCard(base, children) {
  const sec = card("子项");
  const tbody = el("tbody");
  if (!children.length) {
    emptyRow(tbody, 6, "还没有子项，可以在下面添加。");
  } else {
    for (const child of children) {
      const tr = el("tr");
          if (stringList(child.signals).some((s) => s.indexOf("人工") >= 0)) tr.classList.add("mark");
      tr.append(el("td", "mono", dash(child.id)));

      const dotTd = el("td", "dot-cell");
      dotTd.append(meshDot(child.inMesh));
      tr.append(dotTd);

      tr.append(el("td", "num", fmtNum(child.stars)));

      const signalTd = el("td", "signal-cell");
      signalTd.append(
        chipEditor(stringList(child.signals), (next) => onUpdateChild(base, child, { signals: next }), {
          compact: true,
          placeholder: "＋ 信号",
        })
      );
      tr.append(signalTd);

      const readmeTd = el("td");
      readmeTd.append(childReadmeCell(base, child));
      tr.append(readmeTd);

      const act = el("td", "cell-actions");
      act.append(confirmButton("移除", "只从共鸣清单移除该插件，不影响仓库本身。", () => onRemoveChild(base, child)));
      tr.append(act);

      tbody.append(tr);
    }
  }
  const wrap = tableWrap();
  wrap.classList.add("fixed");
  wrap.append(
    buildTable(
      [
        { text: "插件 id" },
        { text: "在图中" },
        { text: "星标", cls: "num" },
        { text: "归属信号" },
        { text: "README 复核" },
        { text: "操作", cls: "cell-actions" },
      ],
      tbody
    )
  );
  sec.append(wrap);

  const input = inputEl("grow", "owner/repo");
  const addBtn = btn("添加子项", "small");
  const add = (ev) => onAddChild(base, input, triggerButtonOf(ev) || addBtn);
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      add(ev);
    }
  });
  const addRow = el("div", "form-row tight");
  addRow.append(input, addBtn);
  sec.append(addRow);
  return sec;
}

function addBaseCard(data, bases) {
  const draft = state.resonanceNew && typeof state.resonanceNew === "object" ? state.resonanceNew : newBaseDraft();
  state.resonanceNew = draft;
  const sec = card("新增基座");

  const idInput = inputEl("grow", "owner/repo（必填）", draft.id);
  const labelInput = inputEl("grow", "显示名（可选）", draft.label);
  const tagInput = inputEl("tag", "GitHub topic（可为空）", draft.tag);
  const sw = makeSwitch(draft.enabled !== false, (checked) => {
    draft.enabled = checked;
  });
  idInput.addEventListener("input", () => {
    draft.id = idInput.value;
  });
  labelInput.addEventListener("input", () => {
    draft.label = labelInput.value;
  });
  tagInput.addEventListener("input", () => {
    draft.tag = tagInput.value;
  });

  const row1 = el("div", "form-row");
  row1.append(idInput, labelInput, inlineField("生态签", tagInput), inlineField("启用", sw.wrap));
  sec.append(row1);

  sec.append(
    anchorRow(
      "探针词",
      chipEditor(draft.probes, (next) => {
        draft.probes = next;
      }, { placeholder: "＋ 添加探针词" })
    )
  );
  sec.append(
    anchorRow(
      "包名 / 标识",
      chipEditor(draft.packages, (next) => {
        draft.packages = next;
      }, { placeholder: "＋ 添加包名" })
    )
  );

  const options = contextOptions(data, null, bases);
  if (options.length) {
    if (!draft.context || !options.some((o) => o.id === draft.context)) draft.context = options[0].id;
    sec.append(
      anchorRow(
        "语境规则",
        contextSelect(options, draft.context, (v) => {
          draft.context = v;
        })
      )
    );
  } else {
    const ctxInput = inputEl("grow", "语境 id", draft.context);
    ctxInput.addEventListener("input", () => {
      draft.context = ctxInput.value;
    });
    sec.append(anchorRow("语境规则", ctxInput));
  }

  const addBtn = btn("添加基座", "primary");
  const add = (ev) => onAddBase(idInput, triggerButtonOf(ev) || addBtn);
  addBtn.addEventListener("click", add);
  const row2 = el("div", "form-row tight");
  row2.append(addBtn);
  if (bases.length) {
    row2.append(
      btn("取消", null, () => {
        state.resonanceShowNew = false;
        state.resonanceSelectedId = null;
        state.resonanceNew = newBaseDraft();
        renderResonance();
      })
    );
  }
  sec.append(row2);
  for (const node of [idInput, labelInput, tagInput]) {
    node.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        add(ev);
      }
    });
  }
  return sec;
}

/* ---------------- 左右两栏渲染 ---------------- */

function renderBaseList(refs, bases) {
  clear(refs.listBox);
  if (!bases.length) {
    refs.listBox.append(el("div", "hint tight", "还没有基座，右侧可以新增。"));
    return;
  }
  for (const base of bases) {
    const id = String(base.id);
    const on = !state.resonanceShowNew && id === state.resonanceSelectedId;
    const item = el("div", "res-item" + (on ? " on" : "") + (baseEnabled(base) ? "" : " off"));

    const main = el("button", "res-item-btn");
    main.type = "button";
    const label = pick(base, ["label", "name"]);
    main.append(el("span", "res-item-label", dash(label === undefined ? id : label)));
    main.append(el("span", "res-item-id mono", id));
    main.addEventListener("click", () => {
      state.resonanceSelectedId = id;
      state.resonanceShowNew = false;
      renderResonance();
    });

    const side = el("div", "res-item-side");
    const kids = Array.isArray(base.children) ? base.children.length : 0;
    const count = el("span", "res-item-count", fmtNum(kids));
    count.title = "子项 " + kids + " 个";
    side.append(count);
    const sw = makeSwitch(baseEnabled(base), (checked, input) => onToggleBase(base, checked, input));
    side.append(sw.wrap);

    item.append(main, side);
    refs.listBox.append(item);
  }
}

function renderResonance() {
  const refs = V.resonance;
  if (!refs) return;
  const data = state.resonance && typeof state.resonance === "object" ? state.resonance : {};
  const bases = (Array.isArray(data.bases) ? data.bases : []).filter((b) => b && typeof b === "object");

  const managedKnown = typeof data.managed === "boolean";
  refs.sourceBadge.hidden = !managedKnown;
  refs.sourceBadge.className = "badge" + (data.managed === true ? " hot" : "");
  refs.sourceBadge.textContent = data.managed === true ? "后台副本" : "策展版本";
  if (refs.pendingBadge) refs.pendingBadge.hidden = data.pendingApply !== true;
  if (refs.curationBadge) refs.curationBadge.hidden = data.needsCuration !== true;

  const childTotal = bases.reduce((n, b) => n + (Array.isArray(b.children) ? b.children.length : 0), 0);
  const enabledCount = bases.filter((b) => baseEnabled(b)).length;
  clear(refs.facts);
  refs.facts.append(
    fact("基座", fmtNum(bases.length)),
    fact("已启用", fmtNum(enabledCount)),
    fact("子项", fmtNum(childTotal)),
    fact("共鸣边", fmtNum(data.meshResonanceEdges))
  );

  if (data.managed === false) setNotice(refs.managedNote, "改动会自动创建后台副本。", "warn");
  else hideNotice(refs.managedNote);

  if (state.resonanceSelectedId !== null && !bases.some((b) => String(b.id) === state.resonanceSelectedId)) {
    state.resonanceSelectedId = null;
  }
  if (state.resonanceSelectedId === null && !state.resonanceShowNew && bases.length) {
    state.resonanceSelectedId = String(bases[0].id);
  }
  const selected = state.resonanceShowNew
    ? null
    : bases.find((b) => String(b.id) === state.resonanceSelectedId) || null;

  renderBaseList(refs, bases);
  renderResonanceApply();

  clear(refs.detail);
  if (!selected) {
    refs.detail.append(addBaseCard(data, bases));
    return;
  }
  const children = (Array.isArray(selected.children) ? selected.children : []).filter((c) => c && typeof c === "object");
  refs.detail.append(baseInfoCard(selected), anchorsCard(selected, data, bases), childrenCard(selected, children));
}


function buildAuditView(root) {
  clear(root);
  const refs = {};

  refs.notice = noticeEl();
  root.append(refs.notice);

  refs.refreshBtn = btn("刷新", null, () => loadAuditView());
  const sec = card("审计日志", [refs.refreshBtn]);
  refs.info = el("div", "sec-sub", "最近 100 条（只读）。");
  sec.append(refs.info);
  refs.body = el("tbody");
  const wrap = tableWrap();
  wrap.append(
    buildTable([{ text: "时间" }, { text: "IP" }, { text: "动作" }, { text: "详情" }], refs.body),
  );
  sec.append(wrap);
  root.append(sec);

  return refs;
}

function mountAuditView() {
  if (!V.audit) V.audit = buildAuditView($("view-audit"));
  return V.audit;
}

async function loadAuditView() {
  const refs = mountAuditView();
  const restore = busyStart(refs.refreshBtn, "刷新中…");
  try {
    state.audit = await apiGet("api/audit?limit=100");
    hideNotice(refs.notice);
  } catch (e) {
    if (!e || e.status !== 401) setNotice(refs.notice, (e && e.message) || "读取审计日志失败", "err");
  } finally {
    restore();
  }
  renderAudit();
}

function renderAudit() {
  const refs = V.audit;
  if (!refs) return;
  const data = state.audit && typeof state.audit === "object" ? state.audit : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];

  clear(refs.body);
  if (!entries.length) {
    emptyRow(refs.body, 4, "暂无审计记录。");
    return;
  }
  for (const item of entries) {
    const e = item && typeof item === "object" ? item : {};
    const action = dash(pick(e, ["action", "act"]));
    const tr = el("tr");
    if (/fail|error|denied|reject/i.test(action)) tr.classList.add("mark", "warn");
    tr.append(el("td", "mono", fmtDateTime(pick(e, ["at", "time", "ts"]))));
    tr.append(el("td", "mono", dash(pick(e, ["ip", "addr"]))));
    tr.append(el("td", null, action));
    tr.append(el("td", "wrap", detailText(pick(e, ["detail", "details", "info"]))));
    refs.body.append(tr);
  }
}

/* ============================================================
   配色（清爽 / 粉黛）：颜色全在 admin.css 的令牌里，这里只切 <html data-palette="…">。
   按钮与 localStorage 都可能不存在（测试桩 / 隐私模式），一律空值安全：取不到就跳过。
   ============================================================ */

const PALETTES = [
  { id: "fresh", label: "清爽" },
  { id: "rouge", label: "粉黛" },
];
const PALETTE_KEY = "mesh-admin-palette";
const PALETTE_FALLBACK = PALETTES[0].id;

function paletteId(value) {
  return PALETTES.some((p) => p.id === value) ? value : PALETTE_FALLBACK;
}

function paletteLabel(id) {
  const hit = PALETTES.find((p) => p.id === id);
  return hit ? hit.label : PALETTES[0].label;
}

function readStoredPalette() {
  try {
    return typeof localStorage === "undefined" ? "" : localStorage.getItem(PALETTE_KEY) || "";
  } catch {
    return "";
  }
}

function storePalette(id) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PALETTE_KEY, id);
  } catch {
  }
}

function applyPalette(id) {
  const next = paletteId(id);
  const root = document.documentElement;
  if (root) {
    if (root.dataset) root.dataset.palette = next;
    else if (typeof root.setAttribute === "function") root.setAttribute("data-palette", next);
  }
  const btn = $("palette");
  if (btn) btn.textContent = paletteLabel(next);
  return next;
}

function togglePalette() {
  const ids = PALETTES.map((p) => p.id);
  const root = document.documentElement;
  const now = paletteId(root && root.dataset ? root.dataset.palette : "");
  storePalette(applyPalette(ids[(ids.indexOf(now) + 1) % ids.length]));
}

/* ---------------- 启动 ---------------- */

function bindTop() {
  const loginSubmit = $("login-submit");
  if (loginSubmit) loginSubmit.addEventListener("click", onLoginSubmit);
  const loginPassword = $("login-password");
  if (loginPassword) {
    loginPassword.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") onLoginSubmit(ev);
    });
  }

  const logout = $("logout");
  if (logout) logout.addEventListener("click", onLogout);

  const paletteBtn = $("palette");
  if (paletteBtn) paletteBtn.addEventListener("click", togglePalette);

  const tabs = $("tabs");
  if (tabs) {
    tabs.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || typeof target.closest !== "function") return;
      const b = target.closest(".tab");
      if (b && b.dataset && b.dataset.tab) switchTab(b.dataset.tab);
    });
  }

  document.addEventListener("click", (ev) => {
    if (!widget || !widget.isOpen()) return;
    const wrap = document.querySelector(".status-wrap");
    const target = ev.target;
    if (wrap && target && typeof wrap.contains === "function" && wrap.contains(target)) return;
    widget.setOpen(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && widget && widget.isOpen()) widget.setOpen(false);
  });
}

async function boot() {
  bindTop();
  try {
    const session = await apiGet("api/session");
    if (session && session.authed) {
      enterApp(session);
    } else {
      showLogin("");
    }
  } catch (e) {
    if (e && e.status === 401) return; 
    showLogin("");
    setLoginMsg("无法连接服务：" + (e && e.message ? e.message : e));
  }
}

// 配色早于取数贴上去：进后台前就把上次的选择定好，避免先闪一下默认色
applyPalette(readStoredPalette());

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
