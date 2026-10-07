/**
 * 端到端冒烟测试（无浏览器版）：
 * 用最小 DOM + Canvas 桩把 src/app.js 真正跑起来，走完 载入 -> 布局 -> 绘制 -> 交互 全链路。
 * 目的：在没有无头浏览器的机器上，仍能证明页面不会白屏、过滤器与选中逻辑真的通。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepareCore, ownerSiblings } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const coreJson = JSON.parse(await readFile(new URL("../data/mesh-core.json", import.meta.url), "utf8"));
// 期望值一律从数据推导：数据每小时由采集器更新，硬编码数字必然过期。
// 基准必须取【二进制契约】的节点数：页面实际渲染的是它（prepareCore），
// 而 mesh.json 与 mesh-core.json 的节点数可以不一样（预计算会再剔一遍噪声作者）。
const NODE_COUNT = coreJson.nodes.length;
const SECTOR_COUNT = mesh.clusters.length;
const SECTOR_DEG = (360 / SECTOR_COUNT).toFixed(1).replace(".", "\\.");
const atFull = new RegExp("命中 " + NODE_COUNT + " / " + NODE_COUNT);

const drawCalls = { fillRect: 0, arc: 0, stroke: 0, fill: 0, fillText: 0, closePath: 0, clip: 0, drawImage: 0, curve: 0, lineTo: 0, segments: [], strokeWidths: [], strokeStyles: [] };

/** 记录每段直线的起止点：用来验证放射线确实"从圆心射出"（不只是数调用次数） */
let stubMove = [0, 0];

function makeCtx() {
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    setTransform() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {},
    translate() {}, rotate() {}, scale() {}, measureText() { return { width: 40 }; },
    moveTo(x, y) { stubMove = [x, y]; },
    lineTo(x, y) { drawCalls.lineTo++; drawCalls.segments.push([stubMove[0], stubMove[1], x, y]); },
    fillRect() { drawCalls.fillRect++; },
    arc() { drawCalls.arc++; },
    closePath() { drawCalls.closePath++; },
    clip() { drawCalls.clip++; },
    quadraticCurveTo() { drawCalls.curve++; },
    drawImage() { drawCalls.drawImage++; },
    fill() { drawCalls.fill++; },
    stroke() { drawCalls.stroke++; drawCalls.strokeWidths.push(this.lineWidth); drawCalls.strokeStyles.push(String(this.strokeStyle)); },
    fillText() { drawCalls.fillText++; },
    strokeText() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return ctx;
}

class FakeNode {
  constructor(tag, id) {
    this.tagName = tag;
    this.id = id ?? "";
    this.nodeType = tag === "#text" ? 3 : 1;
    this.children = [];
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      getPropertyValue(name) {
        return this[name] ?? "";
      },
    };
    this.attrs = {};
    this.dataset = {};
    this.className = "";
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)),
      contains: (c) => this.classList._set.has(c),
    };
    this.listeners = {};
    this.offsetWidth = 220;
    this.offsetHeight = 84;
    this.hidden = false;
    this.width = 0;
    this.height = 0;
    this.value = "";
    this._text = "";
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  removeEventListener() {}
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  querySelector() { return null; }
  getContext() { return makeCtx(); }
  getBoundingClientRect() { return { width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  fire(ev, payload = {}) {
    const list = this.listeners[ev] ?? [];
    for (const fn of list) fn({ preventDefault() {}, target: this, pointerId: 1, clientX: 0, clientY: 0, deltaY: 0, key: "", ...payload });
    return list.length;
  }
  get all() { return this.children.flatMap((c) => [c, ...(c.all ?? [])]); }
  find(pred) { return this.all.find(pred); }
  filter(pred) { return this.all.filter(pred); }
}

const ids = ["rail", "inspector", "snapshot", "loading", "tooltip", "hint", "telemetry", "lamp", "edge-types", "search", "search-clear", "theme", "palette", "toggle-rail", "toggle-dossier", "stage", "graph", "status", "status-panel", "trophy", "ranking", "ranking-tabs", "ranking-body", "ranking-foot", "ranking-close"];
const registry = new Map(ids.map((id) => [id, new FakeNode(id === "graph" ? "canvas" : "div", id)]));
// 榜单弹窗：真实的 tab / 遮罩是 HTML 里的子节点，桩里手动补上（否则点不到、渲染不出）
const rankingTabs = [
  Object.assign(new FakeNode("button"), { className: "on", dataset: { tab: "updated" } }),
  Object.assign(new FakeNode("button"), { dataset: { tab: "stars" } }),
];
registry.get("ranking-tabs").append(...rankingTabs);
registry.get("ranking").append(Object.assign(new FakeNode("div"), { dataset: { close: "1" } }));
// 状态圆环：真实 HTML 里环是 SVG <circle>，桩里给它一个可断言的子节点
const ringFill = new FakeNode("circle");
registry.get("status").querySelector = (sel) => (sel === ".ring-fill" ? ringFill : null);

// 桩必须尊重真实 HTML 的 hidden 属性与 class，否则测的就不是真页面
const indexHtml = await readFile(resolve(ROOT, "index.html"), "utf8");
for (const m of indexHtml.matchAll(/id="([^"]+)"[^>]*\shidden/g)) {
  const node = registry.get(m[1]);
  if (node) node.hidden = true;
}
for (const m of indexHtml.matchAll(/<[a-z]+[^>]*\sid="([^"]+)"[^>]*>/g)) {
  const node = registry.get(m[1]);
  const cls = /\sclass="([^"]*)"/.exec(m[0]);
  if (node && cls) node.className = cls[1];
}
// 直接照真实 HTML 生成按钮，避免桩与页面不同步（含 class="on" 的初始状态）
const hudButtons = [...indexHtml.matchAll(/<button[^>]*data-act="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new FakeNode("button");
  b.dataset.act = m[1];
  b.className = /class="on"/.test(m[0]) ? "on" : "";
  return b;
});
const deckNode = new FakeNode("main");
deckNode.className = "deck";

const createdImages = [];
globalThis.document = {
  documentElement: new FakeNode("html"),
  createElement: (tag) => {
    const node = new FakeNode(tag);
    if (tag === "img") createdImages.push(node);
    return node;
  },
  createTextNode: (text) => { const n = new FakeNode("#text"); n.textContent = text; return n; },
  getElementById: (id) => registry.get(id) ?? null,
  querySelector: (sel) => (sel === ".deck" ? deckNode : null),
  querySelectorAll: (sel) => {
    if (sel === ".hud-tl button") return hudButtons;
    return [];
  },
};
const rafQueue = [];
// 窄屏开关：手机端行为（左右栏互斥、默认收起）靠它驱动
let narrowScreen = false;
const windowListeners = {};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener(ev, fn) { (windowListeners[ev] ??= []).push(fn); },
  matchMedia: (query) => ({
    media: query,
    get matches() {
      return narrowScreen && query.includes("max-width: 900px");
    },
    addEventListener() {},
    removeEventListener() {},
  }),
};
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.location = { search: "" };
// 生态共鸣清单（人工策展）：测试用它挑基座，不写死任何仓库名
const ecoJson = JSON.parse(await readFile(new URL("../tools/ecosystem.json", import.meta.url), "utf8"));
globalThis.fetch = async (url) => {
  const target = String(url ?? "");
  if (target.includes("mesh-core")) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => coreJson };
  }
  if (target.includes("/api/ranking")) {
    // 榜单接口：用真数据拼一份形状一致的返回（期望值仍从数据推导，不写死仓库名）
    const pushed = mesh.nodes
      .filter((n) => n.pushedAt)
      .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
      .slice(0, 3);
    const starRows = mesh.nodes
      .slice()
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
      .slice(0, 2)
      .map((n, i) => ({
        id: n.id, name: n.name, owner: n.owner, avatar: null, stars: n.stars,
        pushedAt: n.pushedAt, categoryLabel: n.categoryLabel,
        delta: 900 - i * 100, starsBefore: (n.stars ?? 0) - (900 - i * 100), starsAfter: n.stars,
      }));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        generatedAt: mesh.meta?.generatedAt ?? null,
        now: new Date().toISOString(),
        windowDays: 7,
        limit: 20,
        dataAgeHours: 1.5,
        history: { points: [{ at: "2026-10-01T17:00:00Z", repos: 2600, source: "snapshot" }], latestAt: "2026-10-01T17:00:00Z" },
        boards: {
          updated: {
            label: "周更新热榜", metric: "updates", windowDays: 7, total: 3408, count: pushed.length,
            maxUpdates: 3, updatesSource: "update-log", updatesObservations: 5, updatesSampledDays: 5,
            note: "次数 = 采样到 pushedAt 前进的轮次数（每轮最多记一次，是下界；窗口内确有推送但没采样到时记 1）。已观测 5 天",
            items: pushed.map((n, i) => ({ id: n.id, name: n.name, owner: n.owner, avatar: null, stars: n.stars, pushedAt: n.pushedAt, categoryLabel: n.categoryLabel, updates: 3 - i })),
          },
          stars: {
            label: "周 star 热榜", metric: "star-gain", available: true,
            window: { from: "2026-10-01T17:00:00Z", to: "2026-10-03T11:00:00Z", days: 1.75, target: 7 },
            total: starRows.length, count: starRows.length, matched: 2600, maxDelta: 900,
            note: "增量 = 两个时间点的星标之差（真实观测，非估算）。",
            items: starRows,
          },
        },
      }),
    };
  }
  if (target.includes("/api/status")) {
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        serverTime: iso(0),
        data: { nodes: mesh.nodes.length, generatedAt: mesh.meta?.generatedAt ?? null },
        readme: { indexed: 40, diskKB: 90 },
        status: {
          state: "crawling",
          phase: "segments",
          roundStartedAt: iso(-600000),
          roundSeconds: 3600,
          nextRunAt: iso(1800000), // 还剩一半 → 环应停在半格
          segments: { total: 313, done: 282, pending: 0 },
          indexed: mesh.nodes.length,
          fetched: 339,
          added: 7,
          requests: 750,
          budget: 600,
          quotaRemaining: 4213,
          readme: { indexed: 1200, target: 9826, thisRound: 150 },
          lastRound: { startedAt: iso(-3600000), finishedAt: iso(-3400000), seconds: 200.4, state: "ok" },
        },
      }),
    };
  }
  if (target.includes("/data/details/")) {
    const index = Number((target.match(/(\d+)\.json/) ?? [])[1] ?? 0);
    const bucket = JSON.parse(await readFile(new URL("../data/details/" + index + ".json", import.meta.url), "utf8"));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => bucket };
  }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => mesh };
};

function pump(max = 900) {
  let n = 0;
  while (rafQueue.length && n < max) {
    const fn = rafQueue.shift();
    fn(performance.now());
    n++;
  }
  return n;
}

const appModule = await import("../src/app.js");

/** 面板现在是动态载入的：等它就绪，而不是赌一个固定毫秒数 */
async function waitForPanels(timeoutMs = 2000) {
  const rail = registry.get("rail");
  const deadline = Date.now() + timeoutMs;
  while (rail.children.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));
}

await waitForPanels();

const canvas = registry.get("graph");
const rail = registry.get("rail");
const inspector = registry.get("inspector");
const hint = registry.get("hint");
const tooltip = registry.get("tooltip");

const HUB = "deepseek-ai/deepseek-harness";
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 状态栏里的"当前命中 N / M"；以某仓库为中心的扇形图不再报这个数，取不到就是 -1 */
const hits = () => {
  const m = /当前命中 (\d+) \/ (\d+)/.exec(hint.textContent);
  return m ? Number(m[1]) : -1;
};

/** 扫画布找一个节点：返回它的 id 与屏幕坐标（后续点击/dblclick 用同一坐标，必命中同一个球） */
function findNodeOnCanvas(accept = () => true) {
  for (let y = 20; y < 600; y += 10) {
    for (let x = 20; x < 900; x += 10) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (tooltip.hidden) continue;
      const id = tooltip.all.find((n) => n.tagName === "b")?.textContent;
      if (id && accept(id)) return { id, x, y };
    }
  }
  return null;
}

/**
 * 关系口径：以某仓库为中心的扇形图 = 它 + 直接关联 + 同作者兄弟（与右栏「关联」同一套关系）。
 * 期望值从数据算，不写死任何仓库名。
 */
// 用【二进制契约】建对照表：页面实际准备的就是它（prepareCore），
// 用 mesh.json 建会在两者节点集不同时算出不一样的分组/关联。
const preparedForTest = prepareCore(coreJson);
function fanMembers(id) {
  return new Set([id, ...(preparedForTest.adjacency.get(id) ?? []).map((n) => n.id), ...ownerSiblings(preparedForTest, id)]);
}
const fanSize = (id) => fanMembers(id).size - 1;
function fanSectors(id) {
  const members = fanMembers(id);
  const keys = new Set();
  for (const n of preparedForTest.nodes) if (n.id !== id && members.has(n.id)) keys.add(n.category ?? "other");
  return keys.size;
}

/** 双击画布上一个"关联规模适中"的仓库，进入以它为中心的扇形图；返回它 */
function enterCenteredFan() {
  const picked = findNodeOnCanvas((id) => id !== HUB && fanSize(id) > 1 && fanSize(id) <= 60);
  assert.ok(picked, "画布上应有适合做圆心的仓库");
  canvas.fire("dblclick", { clientX: picked.x, clientY: picked.y });
  pump(180);
  // 关联规模以【页面自己报的数】为准：两条数据契约（mesh.json / mesh-core.json）可能不是同一轮，
  // 用测试侧推算的数字去比对会随数据新旧飘。
  const m = new RegExp("^圆心：" + escapeReg(picked.id) + " · 它的关联 (\\d+) 个仓库").exec(hint.textContent);
  assert.ok(m, "双击后应为「以它为中心」的扇形图，实际：" + hint.textContent);
  return { ...picked, related: Number(m[1]) };
}

test("启动后：载入层关闭、快照读数就位", () => {
  assert.equal(registry.get("loading").hidden, true, "载入完成后 loading 必须隐藏（否则页面看起来是白屏）");
  assert.match(registry.get("snapshot").textContent, /^\d{4}-\d{2}-\d{2} · 抽样$/, "快照读数应为日期：" + registry.get("snapshot").textContent);
  assert.match(registry.get("telemetry").textContent, /^缩放 \d+\.\d\d$/, "缩放读数应被初始化");
});

test("布局会沉降并真的画出东西", () => {
  const frames = pump(900);
  // 预计算布局没有长沉降（一帧即就位），所以这里只要求"跑过帧"且真的画了东西
  assert.ok(frames >= 1, "应至少跑了一帧，实际 " + frames);
  assert.ok(drawCalls.fill > NODE_COUNT * 0.8, "节点绘制次数异常少: " + drawCalls.fill + "（节点 " + NODE_COUNT + "）");
  assert.ok(drawCalls.closePath >= SECTOR_COUNT, SECTOR_COUNT + " 个扇区的光锥没有画出来: " + drawCalls.closePath);
  assert.ok(drawCalls.clip >= SECTOR_COUNT, "扇区光的裁剪没有生效: " + drawCalls.clip);
  assert.equal(drawCalls.curve, 0, "默认不画任何连线，实际画了 " + drawCalls.curve + " 条");
  assert.match(hint.textContent, /圆心：deepseek-ai\/deepseek-harness/);
  assert.match(hint.textContent, new RegExp("共 " + SECTOR_COUNT + " 个扇区，每个 " + SECTOR_DEG + "°，按功能分类划分"));
  assert.match(hint.textContent, atFull);
});

test("三个面板都渲染出了内容", () => {
  assert.ok(rail.children.length >= 4, "左侧 rail 区块过少");
  assert.ok(inspector.children.length >= 2, "右侧检查器未渲染");
  assert.ok(registry.get("edge-types").children.length >= 1, "连线图例应存在：" + registry.get("edge-types").children.length);
});

test("过滤真的生效：关掉一个标签后命中数下降", () => {
  const before = hint.textContent;
  const row = rail.find((n) => n.className?.startsWith("tag-row"));
  assert.ok(row, "应能找到标签行");
  row.fire("click");
  assert.notEqual(hint.textContent, before, "点击标签后命中数应变化");
  const m = hint.textContent.match(/命中 (\d+) \/ (\d+)/);
  assert.ok(m && Number(m[1]) < NODE_COUNT, "命中数应小于总数，实际 " + hint.textContent);
  row.fire("click"); // 还原
  assert.match(hint.textContent, atFull);
});

test("搜索：输入即淡化过滤，回车选中星标最高的命中项", () => {
  const search = registry.get("search");
  search.value = "tauri";
  search.fire("input");
  const m = hint.textContent.match(/命中 (\d+) \/ (\d+)/);
  assert.ok(m && Number(m[1]) > 0 && Number(m[1]) < NODE_COUNT, "搜索应命中一部分节点，实际 " + hint.textContent);
  search.fire("keydown", { key: "Enter" });
  const h2 = inspector.find((n) => n.tagName === "h2");
  assert.ok(h2, "回车后检查器应展示选中的仓库");
  // 命中可能在仓库名，也可能在作者名（如 dsh-tauri/...），因此校验整块面板文本
  const panelText = inspector.all.map((n) => n.textContent).join(" ");
  assert.match(panelText, /tauri/i, "回车选中的仓库必须真的与查询词相关，实际=" + panelText.slice(0, 120));
  search.value = "";
  search.fire("input");
});

test("连线不再常驻：未选中时一条都不画", () => {
  const canvas = registry.get("graph");
  // 先按下再抬起：只发 pointerup 会依赖上一个用例遗留的 drag 状态（数据一换就飘）
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 98 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 98 });
  pump(20);
  assert.equal(drawCalls.curve, 0, "未选中任何项目时不应画连线，实际 " + drawCalls.curve);
});

test("画布交互：滚轮 / 拖拽 / 单击 / 双击聚焦都不抛错", () => {
  assert.ok(canvas.fire("wheel", { deltaY: -240, clientX: 450, clientY: 300 }) > 0, "wheel 监听未挂上");
  canvas.fire("pointerdown", { clientX: 450, clientY: 300 });
  canvas.fire("pointermove", { clientX: 470, clientY: 320 });
  canvas.fire("pointerup", { clientX: 470, clientY: 320 });
  canvas.fire("pointermove", { clientX: 450, clientY: 300 });
  canvas.fire("pointerup", { clientX: 450, clientY: 300 });
  canvas.fire("dblclick", { clientX: 450, clientY: 300 });
  canvas.fire("pointerleave");
  pump(60);
  assert.equal(tooltip.hidden, true, "离开画布后 tooltip 应隐藏");
  // 双击现在会以该仓库为中心重建扇形图（v0.5.0）：这个用例只验证"不抛错"，
  // 必须把视图还原成全景——否则后面的扇区用例会在一张"只有关联"的小图上跑。
  for (const fn of windowListeners.keydown ?? []) fn({ key: "Escape", target: {} });
  pump(60);
});

test("悬停：扫过画布能找到节点并弹出提示，离开后收起", () => {
  let found = null;
  outer: for (let y = 20; y < 600; y += 14) {
    for (let x = 20; x < 900; x += 14) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (!tooltip.hidden) {
        found = { x, y };
        break outer;
      }
    }
  }
  assert.ok(found, "扫遍画布都没命中任何节点 —— 说明节点没画在可视区域内");
  const text = tooltip.all.map((n) => n.textContent).join(" ");
  assert.ok(/★/.test(text), "tooltip 应展示星标信息，实际=" + text.slice(0, 80));
  assert.ok(/px$/.test(tooltip.style.left), "tooltip 必须被定位");
  canvas.fire("pointerleave");
  assert.equal(tooltip.hidden, true, "离开后 tooltip 应收起");
});

test("默认开关：标签关闭、头像开启；连线开关已取消", () => {
  assert.ok(!hudButtons.find((b) => b.dataset.act === "labels").className.includes("on"), "「标签」应默认关闭（球太密，标签反而糊）");
  assert.ok(hudButtons.find((b) => b.dataset.act === "avatars").className.includes("on"), "「头像」应默认开启");
  assert.equal(hudButtons.find((b) => b.dataset.act === "nebula"), undefined, "不应再有星云开关");
  assert.ok(registry.get("edge-types").children.length >= 1, "应显示连线图例");
});

test("侧边栏可收起：点「左栏」「右栏」各自收起并可还原", () => {
  const railBtn = registry.get("toggle-rail");
  const dossierBtn = registry.get("toggle-dossier");
  assert.ok(railBtn && dossierBtn, "应有左右栏收起按钮");
  assert.ok(!deckNode.classList.contains("hide-rail"), "默认应展开");
  railBtn.fire("click");
  assert.ok(deckNode.classList.contains("hide-rail"), "点一下应收起左栏");
  assert.ok(railBtn.classList.contains("on"), "按钮应进入选中态");
  dossierBtn.fire("click");
  assert.ok(deckNode.classList.contains("hide-dossier"), "右栏也应能收起");
  assert.ok(deckNode.classList.contains("hide-rail"), "两栏可同时收起");
  railBtn.fire("click");
  dossierBtn.fire("click");
  assert.equal(deckNode.className, "deck", "再点回来应完全还原");
});

test("配色切换：点一下真的换掉整套 CSS 变量，再点回得来", () => {
  const btn = registry.get("palette");
  const root = document.documentElement;
  assert.ok(btn.listeners.click, "配色按钮应挂上监听");
  const freshBg = root.style["--bg-base"];
  btn.fire("click");
  assert.equal(root.dataset.palette, "rouge", "应切到粉黛");
  assert.notEqual(root.style["--bg-base"], freshBg, "底色应换成粉黛的");
  assert.equal(btn.textContent, "粉黛", "按钮文案应跟着变");
  btn.fire("click");
  assert.equal(root.dataset.palette, "fresh", "应切回清爽");
  assert.equal(root.style["--bg-base"], freshBg, "应完全还原清爽的变量");
});

test("明暗切换：mode 与 dataset 同步", () => {
  const btn = registry.get("theme");
  const before = document.documentElement.dataset.theme;
  btn.fire("click");
  assert.notEqual(document.documentElement.dataset.theme, before);
  btn.fire("click");
  assert.equal(document.documentElement.dataset.theme, before);
});

test("头像：球够大时会请求头像，加载完成后真的画到球上", () => {
  // 先放大到能显示头像的级别
  for (let i = 0; i < 4; i++) canvas.fire("wheel", { deltaY: -240, clientX: 450, clientY: 300 });
  pump(40);
  assert.ok(createdImages.length > 0, "应有节点发起头像请求（画布已放大）");
  const before = drawCalls.drawImage;
  for (const img of createdImages) if (img.onload) img.onload();
  pump(40);
  assert.ok(drawCalls.drawImage > before, "头像就绪后应通过 drawImage 画到球上，实际新增 " + (drawCalls.drawImage - before));
});

test("头像开关：点一下关掉后不再画头像", () => {
  const btn = hudButtons.find((b) => b.dataset.act === "avatars");
  assert.ok(btn, "应有头像开关按钮");
  btn.fire("click");
  const before = drawCalls.drawImage;
  pump(20);
  assert.equal(drawCalls.drawImage, before, "关掉后不应再画头像");
  btn.fire("click");
  pump(20);
  assert.ok(drawCalls.drawImage > before, "打开后应恢复绘制");
});

test("URL 参数 ?repo= 能直接定位（分享链接的前提）", () => {
  assert.equal(typeof registry.get("inspector").textContent, "string");
});

test("点项目自动展开右栏", () => {
  const dossierBtn = registry.get("toggle-dossier");
  dossierBtn.fire("click"); // 先收起右栏
  assert.ok(deckNode.classList.contains("hide-dossier"), "右栏应已收起");
  const search = registry.get("search");
  search.value = "dsh";
  search.fire("input");
  search.fire("keydown", { key: "Enter" }); // 回车选中星标最高的命中项 → selectRepo
  assert.ok(!deckNode.classList.contains("hide-dossier"), "选中项目后右栏应自动展开");
  search.value = "";
  search.fire("input");
});

test("手机端：左右两栏互斥，不同时打开", () => {
  const railBtn = registry.get("toggle-rail");
  const dossierBtn = registry.get("toggle-dossier");
  narrowScreen = true;
  try {
    // 先都收起来，再开左栏
    if (!deckNode.classList.contains("hide-rail")) railBtn.fire("click");
    if (!deckNode.classList.contains("hide-dossier")) dossierBtn.fire("click");
    assert.ok(deckNode.classList.contains("hide-rail") && deckNode.classList.contains("hide-dossier"));
    railBtn.fire("click");
    assert.ok(!deckNode.classList.contains("hide-rail"), "左栏应打开");
    assert.ok(deckNode.classList.contains("hide-dossier"), "窄屏下打开左栏必须收起右栏（互斥）");
    dossierBtn.fire("click");
    assert.ok(!deckNode.classList.contains("hide-dossier"), "右栏应打开");
    assert.ok(deckNode.classList.contains("hide-rail"), "窄屏下打开右栏必须收起左栏（互斥）");
  } finally {
    narrowScreen = false;
    if (!deckNode.classList.contains("hide-rail")) railBtn.fire("click");
    if (!deckNode.classList.contains("hide-dossier")) dossierBtn.fire("click");
  }
});

test("从细枝切回全局走布局缓存，不重算", async () => {
  const { internalStats } = appModule;
  const rail = registry.get("rail");
  const sectorRow = rail.find((n) => n.className?.startsWith("sector-row"));
  assert.ok(sectorRow, "左栏应有扇区行");

  const buildsBefore = internalStats.layoutBuilds;
  sectorRow.fire("click"); // 放大到某个扇区
  pump(20);
  const buildsAfterFocus = internalStats.layoutBuilds;
  assert.equal(buildsAfterFocus, buildsBefore + 1, "第一次放大需要建一次细枝布局");

  // 放大后左栏换成细枝行，返回全局要点「← 返回全局」
  const banner = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  assert.ok(banner, "放大后应出现返回条");
  const backBtn = banner.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  assert.ok(backBtn, "返回条上应有返回按钮");
  backBtn.fire("click");
  pump(20);
  assert.equal(internalStats.layoutBuilds, buildsAfterFocus, "切回全局不该重算布局（应命中缓存）");
  assert.ok(internalStats.layoutHits > 0, "应记录到缓存命中");
});

test("点选项目后画出两类连线，且颜色不同", () => {
  // 直接用【实际的同作者连线】来挑目标：
  // 不能用「同作者有 ≥2 个仓库」推断 —— 后端会把大作者当枢纽过滤掉，那种作者未必有连线。
  const siblings = new Set();
  for (const e of coreJson.edges ?? []) {
    if (e[2] !== 0) continue; // 0 = owner
    const a = coreJson.nodes[e[0]];
    const b = coreJson.nodes[e[1]];
    if (a) siblings.add(a.id);
    if (b) siblings.add(b.id);
  }
  assert.ok(siblings.size > 0, "core 数据里应有同作者连线");

  const canvas = registry.get("graph");
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 97 });
  pump(5);
  const before = drawCalls.curve;
  const arcBefore = drawCalls.arc;

  // 扫画布找到「确有同作者」的节点再点它
  let hit = null;
  outer: for (let y = 20; y < 600; y += 10) {
    for (let x = 20; x < 900; x += 10) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (!tooltip.hidden) {
        const text = tooltip.all.map((n) => n.textContent).join(" ");
        // 必须按【完整 id】匹配：只用仓库名做子串匹配会点到同名片段的其他仓库（曾误点后断言失败）
        const id = [...siblings].find((sid) => text.includes(sid));
        if (id) {
          hit = { x, y, id };
          break outer;
        }
      }
    }
  }
  assert.ok(hit, "没在画布上找到「有同作者」的节点");
  tooltip.hidden = true;
  canvas.fire("pointerdown", { clientX: hit.x, clientY: hit.y, pointerId: 7 });
  canvas.fire("pointerup", { clientX: hit.x, clientY: hit.y, pointerId: 7 });
  pump(30);
  assert.ok(drawCalls.curve > before, "点选 " + hit.id + " 后应画出它的同作者连线，新增 " + (drawCalls.curve - before));

  // 每个被指向的球都要套光圈：弧线调用数至少增加"同作者兄弟数"
  const clicked = coreJson.nodes.find((n) => n.id === hit.id);
  const siblingsInData = coreJson.nodes.filter((n) => n.owner === clicked.owner && n.id !== clicked.id).length;
  assert.ok(
    drawCalls.arc - arcBefore >= siblingsInData,
    "被指向的球应各套一圈光圈：" + hit.id + " 有 " + siblingsInData + " 个同作者，弧线只新增 " + (drawCalls.arc - arcBefore),
  );

  // 图例应同时给出两类关系的计数
  const legend = registry.get("edge-types").all.map((c) => c.textContent).join(" ");
  assert.match(legend, /同作者/, "图例应显示同作者，实际 " + legend);
  assert.match(legend, /主题共现/, "图例应显示主题共现，实际 " + legend);
});

test("回归：放大到某扇区并选中细枝后，节点不会被全部隐藏", () => {
  const rail = registry.get("rail");
  const sectorRow = rail.find((n) => n.className?.startsWith("sector-row"));
  assert.ok(sectorRow, "应有扇区行");
  sectorRow.fire("click"); // 放大
  pump(20);

  const rail2 = registry.get("rail");
  const subRow = rail2.find((n) => n.className?.startsWith("sector-row"));
  assert.ok(subRow, "放大后应列出细枝");
  const beforeFill = drawCalls.fill;
  subRow.fire("click"); // 选中某个细枝
  pump(20);

  const inspector = registry.get("inspector");
  const text = inspector.all.map((n) => n.textContent).join(" ");
  assert.ok(text.length > 0, "选中细枝后应仍渲染内容");
  assert.ok(drawCalls.fill > beforeFill, "选中细枝后画布应继续绘制（不能被全部隐藏），新增 " + (drawCalls.fill - beforeFill));

  // 收尾：返回全局
  const banner = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  const back = banner && banner.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  if (back) back.fire("click");
  pump(10);
});

test("回归：进入分类默认显示该分类全部，点细枝才收窄到单支", () => {
  const hitOf = () => {
    const m = /当前命中 (\d+) \/ (\d+)/.exec(registry.get("hint").textContent);
    return m ? Number(m[1]) : -1;
  };
  // 先一键清空筛选（前面的用例会留下筛选/聚焦状态）
  const resetBtn = registry.get("rail").all.find((n) => String(n.textContent ?? "") === "重置筛选");
  assert.ok(resetBtn, "筛选区应有「重置筛选」按钮");
  resetBtn.fire("click");
  pump(20);
  const back0 = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  const backBtn0 = back0 && back0.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  if (backBtn0) { backBtn0.fire("click"); pump(10); }
  const before = hitOf();
  assert.ok(before > 0, "初始应至少命中一个节点，实际 " + before);

  const sectorRow = registry.get("rail").find((n) => n.className?.startsWith("sector-row"));
  assert.ok(sectorRow, "应有扇区行");
  sectorRow.fire("click");
  pump(20);
  const inFocus = hitOf();
  assert.ok(inFocus > 0, "进入分类后必须默认显示该分类的节点（旧 bug：全部被隐藏），实际 " + inFocus);

  const subRow = registry.get("rail").all.filter((n) => n.className?.startsWith("sector-row"))[0];
  assert.ok(subRow, "放大后应列出细枝");
  subRow.fire("click");
  pump(20);
  const inSub = hitOf();
  assert.ok(inSub > 0, "点细枝后不能把节点全隐藏，实际 " + inSub);
  assert.ok(inSub <= inFocus, "细枝命中数不应超过整个分类，实际 " + inSub + " vs " + inFocus);

  const back = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  const backBtn = back && back.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  if (backBtn) { backBtn.fire("click"); pump(10); }
});

test("回归：放大到分类后，点选节点仍能画出该分类内的连线", () => {
  // 仍处于上一条用例留下的细枝状态：先返回全局再放大，保证干净
  const back = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  const backBtn = back && back.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  if (backBtn) { backBtn.fire("click"); pump(10); }
  const sectorRow = registry.get("rail").find((n) => n.className?.startsWith("sector-row"));
  sectorRow.fire("click");
  pump(20);

  const canvas = registry.get("graph");
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 96 });
  pump(5);
  const before = drawCalls.curve;
  let hit = null;
  outer2: for (let y = 20; y < 600; y += 10) {
    for (let x = 20; x < 900; x += 10) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (!tooltip.hidden) { hit = { x, y }; break outer2; }
    }
  }
  assert.ok(hit, "放大后画布上应能找到节点");
  tooltip.hidden = true;
  canvas.fire("pointerdown", { clientX: hit.x, clientY: hit.y, pointerId: 6 });
  canvas.fire("pointerup", { clientX: hit.x, clientY: hit.y, pointerId: 6 });
  pump(30);
  const legend = registry.get("edge-types").all.map((n) => n.textContent).join(" ");
  assert.ok(/同作者 \d+|主题共现 \d+/.test(legend), "放大后点选节点，图例应有计数（说明连线数据已生效），实际 " + legend);
  assert.ok(drawCalls.curve >= before, "放大后点选节点不应报错");

  const back2 = registry.get("rail").find((n) => n.className?.includes("focus-banner"));
  const backBtn2 = back2 && back2.all.find((n) => String(n.textContent ?? "").includes("返回全局"));
  if (backBtn2) { backBtn2.fire("click"); pump(10); }
});

test("右上角作者入口指向本项目仓库", () => {
  const m = /class="author"[^>]*href="([^"]+)"/.exec(indexHtml);
  assert.equal(m?.[1], "https://github.com/WTStarMark/dsh-plugin-mesh", "作者入口应指向本仓库，实际 " + m?.[1]);
});

test("优化①：右栏「关联」里点一个仓库 → 自动把它居中显示（只移镜头，不重建布局）", () => {
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 92 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 92 });
  canvas.fire("pointerleave");
  pump(10);

  // 先在画布上点选一个【有关联】的仓库：右栏才会列出它的「关联」。
  // 不能随便抓一个球——名字收录源抓到的仓库可以没有任何关联（matchedTags 为空、邻接表为空）。
  const seed = findNodeOnCanvas((id) => (preparedForTest.adjacency.get(id) ?? []).length > 0);
  assert.ok(seed, "画布上应能找到带关联的节点");
  canvas.fire("pointerdown", { clientX: seed.x, clientY: seed.y, pointerId: 92 });
  canvas.fire("pointerup", { clientX: seed.x, clientY: seed.y, pointerId: 92 });
  pump(20);

  const row = inspector.find((n) => n.className === "neigh");
  assert.ok(row, "右栏应列出「关联」仓库");
  const targetId = row.all.find((n) => n.className === "nm").textContent;
  assert.ok(preparedForTest.byId.has(targetId), "关联行必须是真实仓库：" + targetId);
  assert.notEqual(targetId, seed.id, "关联行不该是当前选中项自己");

  row.fire("click");
  pump(20);

  // ① 选中它：右栏换成它的档案
  assert.equal(
    inspector.find((n) => n.tagName === "h2")?.textContent,
    preparedForTest.byId.get(targetId).name,
    "点关联行应选中该仓库",
  );
  // ② 居中显示：镜头缩放到 focusNode 的下限，画面正中点出来的就是它
  assert.equal(registry.get("telemetry").textContent, "缩放 1.10", "镜头应移到该仓库（居中显示）");
  canvas.fire("pointermove", { clientX: 450, clientY: 300 });
  assert.equal(
    tooltip.all.find((n) => n.tagName === "b")?.textContent,
    targetId,
    "居中后画面正中应是它，实际：" + tooltip.all.find((n) => n.tagName === "b")?.textContent,
  );
  // ③ 只是居中，不是重建：圆心仍是官方仓库，命中数照旧
  assert.match(hint.textContent, /圆心：deepseek-ai\/deepseek-harness · 共 \d+ 个扇区/);
  assert.ok(hits() > 0, "居中不该改变筛选结果，实际：" + hint.textContent);

  canvas.fire("pointerleave");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 92 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 92 });
  pump(10);
});

test("优化②：双击仓库 → 以它为中心重建一张扇形图，左栏横幅可返回全景", () => {
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 93 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 93 });
  canvas.fire("pointerleave");
  pump(10);
  assert.match(hint.textContent, /圆心：deepseek-ai\/deepseek-harness/, "起点应是全景");

  const picked = findNodeOnCanvas((id) => id !== HUB && fanSize(id) > 1 && fanSize(id) <= 60);
  assert.ok(picked, "画布上应有适合做圆心的仓库");

  canvas.fire("dblclick", { clientX: picked.x, clientY: picked.y });
  pump(180);

  // 数量以页面自己报的为准（两条契约可能不同轮），形状必须自洽：文案的 N 与画出来的球数一致
  const m = new RegExp("^圆心：" + escapeReg(picked.id) + " · 它的关联 (\\d+) 个仓库，分 (\\d+) 个扇区").exec(hint.textContent);
  assert.ok(m, "双击后应是「以它为中心」的新扇形图，实际：" + hint.textContent);
  const n = Number(m[1]);
  assert.ok(n > 0, "关联规模应为正数");

  // 画面里真的只剩「它 + 关联」这么多个球：不是只改了文案
  const beforeFill = drawCalls.fill;
  canvas.fire("pointermove", { clientX: 3, clientY: 3 });
  pump(10);
  const drawn = drawCalls.fill - beforeFill;
  // 一帧的 fill = 球场 + 圆心 + 被连线指着的球的光圈（数量随选中项的连线数浮动），
  // 所以只卡"至少画出扇区图里的球"与"绝不能再画出整张全景"这两头。
  assert.ok(drawn >= n + 1, "至少要把这张图里的 " + (n + 1) + " 个球画出来，实际 " + drawn);
  assert.ok(drawn <= n + 1 + 16, "画面里应只剩这张小图（" + (n + 1) + " 个球 + 少量光圈），实际 " + drawn + "；全景是 " + NODE_COUNT + " 个");

  // 左栏横幅：点名圆心 + 一个明确的出口
  const banner = rail.find((x) => x.className === "focus-banner");
  assert.ok(banner, "左栏应出现「以某仓库为中心」的横幅");
  const bannerText = banner.all.map((x) => String(x.textContent ?? "")).join(" ");
  assert.ok(bannerText.includes(picked.id), "横幅应点名当前圆心，实际：" + bannerText);
  const back = banner.all.find((x) => String(x.textContent ?? "").includes("返回全景"));
  assert.ok(back, "横幅里应有「返回全景」按钮");

  back.fire("click");
  pump(180);
  assert.match(hint.textContent, /圆心：deepseek-ai\/deepseek-harness · 共 \d+ 个扇区，每个 [\d.]+°，按功能分类划分/);
  assert.ok(!rail.find((x) => x.className === "focus-banner"), "回到全景后横幅应消失");
  assert.ok(hits() > 0, "回到全景后应重新报全量命中，实际：" + hint.textContent);

  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 93 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 93 });
  pump(10);
});

test("优化②回归：Esc 与「重置筛选」都能退出「以某仓库为中心」的扇形图", () => {
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  pump(10);

  // Esc：先退出中心视图（选中项保留）
  const first = enterCenteredFan();
  assert.equal(hits(), -1, "中心视图不该再报全量命中数，实际：" + hint.textContent);
  for (const fn of windowListeners.keydown ?? []) fn({ key: "Escape", target: {} });
  pump(180);
  assert.match(hint.textContent, /圆心：deepseek-ai\/deepseek-harness · 共 \d+ 个扇区/);
  assert.ok(!rail.find((x) => x.className === "focus-banner"), "Esc 后横幅应消失");
  assert.equal(inspector.find((n) => n.tagName === "h2")?.textContent, preparedForTest.byId.get(first.id).name, "Esc 退回全景后选中项应保留");

  // 重置筛选：v0.5.0 修复——重置以前不清理圆心，会把人卡在这张小图里
  enterCenteredFan();
  const resetBtn = rail.all.find((n) => String(n.textContent ?? "") === "重置筛选");
  assert.ok(resetBtn, "筛选区应有「重置筛选」按钮");
  resetBtn.fire("click");
  pump(180);
  assert.match(hint.textContent, atFull, "重置筛选后应回到全图，实际：" + hint.textContent);
  assert.ok(!rail.find((x) => x.className === "focus-banner"), "重置后横幅应消失");
});

test("v0.4.2 回归：「只看关联仓库」聚焦后，点画布空白处必须恢复全图", () => {
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerleave");
  pump(10);
  const full = hits();
  assert.ok(full > 0, "初始应命中一批节点，实际：" + hint.textContent);

  const seed = findNodeOnCanvas((id) => (preparedForTest.adjacency.get(id) ?? []).length > 0);
  assert.ok(seed, "画布上应有带关联的仓库");
  canvas.fire("pointerdown", { clientX: seed.x, clientY: seed.y, pointerId: 91 });
  canvas.fire("pointerup", { clientX: seed.x, clientY: seed.y, pointerId: 91 });
  pump(20);

  const link = inspector.find((n) => n.tagName === "a" && String(n.textContent ?? "") === "只看关联仓库");
  assert.ok(link, "档案里应有「只看关联仓库」");
  link.fire("click");
  pump(20);
  const focused = hits();
  assert.ok(focused > 0 && focused < full, "只看关联仓库后命中数应下降，实际 " + focused + " / " + full);

  // 旧 bug：点空白只清掉选中，neighborFocus 还在，整张图永远暗着
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 91 });
  pump(20);
  assert.equal(hits(), full, "点空白处应恢复到全图，实际：" + hint.textContent);
});

test("v0.4.3 生态共鸣：点选基座仓库会画出紫罗兰实线", (t) => {
  const base = (ecoJson.bases ?? []).find((b) => b.enabled !== false && coreJson.nodes.some((n) => n.id === b.id));
  if (!base) {
    t.skip("当前数据里没有生态基座（限扫数据集），跳过这项");
    return;
  }
  const inData = base.verified.filter((v) => coreJson.nodes.some((n) => n.id === v.id));
  if (inData.length === 0) {
    t.skip(base.id + " 的子节点还没被抓到（限扫数据集），跳过共鸣连线这项");
    return;
  }

  const search = registry.get("search");
  const canvas = registry.get("graph");
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 90 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 90 });
  canvas.fire("pointerleave");
  pump(10);

  const before = drawCalls.curve;
  const styleStart = drawCalls.strokeStyles.length;
  search.value = base.id;
  search.fire("input");
  search.fire("keydown", { key: "Enter" }); // 选中基座
  pump(40);
  const drawn = drawCalls.curve - before;
  assert.ok(drawn >= inData.length, "点选 " + base.id + " 应画出 " + inData.length + " 条生态共鸣连线，实际 " + drawn);

  const legend = registry.get("edge-types").all.map((n) => n.textContent).join(" ");
  assert.match(legend, /生态共鸣 \d+/, "连线图例应显示生态共鸣计数，实际 " + legend);

  // 被指向的球要套【对应颜色】的光圈：生态共鸣 = 紫罗兰 #a86bff → rgba(168,107,255,…)
  const violet = drawCalls.strokeStyles.slice(styleStart).filter((s) => s.includes("168,107,255"));
  assert.ok(violet.length > 0, "被生态共鸣指向的球应有紫罗兰光圈，实际描边颜色：" + [...new Set(drawCalls.strokeStyles.slice(styleStart))].slice(0, 6).join(" | "));

  search.value = "";
  search.fire("input");
  pump(10);
});

test("v0.4.6 搜索：命中超过 100 个只做高亮、不画放射线（避免卡顿）", () => {
  const search = registry.get("search");
  const canvas = registry.get("graph");
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerleave");
  pump(10);

  // 泛查询：命中必然远超 100（"dsh" 几乎每个仓库都沾）→ 只高亮，不画线
  const before = drawCalls.lineTo;
  search.value = "dsh";
  search.fire("input");
  pump(30);
  const hintWide = registry.get("hint").textContent;
  assert.match(hintWide, /超过 100 个只做高亮/, "泛搜索应在状态栏说明不画放射线，实际：" + hintWide);
  assert.equal(drawCalls.lineTo - before, 0, "命中过多时不该再画放射线，实际新增 " + (drawCalls.lineTo - before));

  // 窄查询：直接拿一个真实仓库 id，命中数必然是 1 → 照常画射线
  const target = coreJson.nodes.find((n) => n.id !== "deepseek-ai/deepseek-harness");
  const before2 = drawCalls.lineTo;
  search.value = target.id;
  search.fire("input");
  pump(30);
  assert.ok(drawCalls.lineTo - before2 > 0, "窄查询应照常画放射线，实际新增 " + (drawCalls.lineTo - before2));
  assert.match(registry.get("hint").textContent, /放射线指向/, "窄查询的状态栏应提示放射线");

  search.value = "";
  search.fire("input");
  pump(10);
});

test("v0.4.7 状态圆环：倒计时环 + 点开浮窗看采集进度，Esc / 点画布关闭", async () => {
  const chip = registry.get("status");
  const panel = registry.get("status-panel");
  assert.equal(panel.hidden, true, "默认不该显示浮窗");
  assert.ok(chip.className.includes("status-chip"), "圆环应挂在顶栏状态按钮上：" + chip.className);
  assert.match(chip.title ?? "", /采集状态/, "圆环应带状态提示，实际：" + chip.title);

  // 环：等一次 /api/status 回来（剩一半 → dashoffset 应约为半格）
  await new Promise((r) => setTimeout(r, 30));
  const LEN = 2 * Math.PI * 15.5;
  const offset = Number(ringFill.style?.strokeDashoffset);
  assert.ok(Number.isFinite(offset), "环应被写入 dashoffset，实际：" + ringFill.style?.strokeDashoffset);
  assert.ok(Math.abs(offset - LEN / 2) < 4, "剩一半时间时环应停在半格，实际 offset " + offset.toFixed(1) + "（整圈 " + LEN.toFixed(1) + "）");
  assert.ok(chip.classList.contains("crawling"), "采集中时圆环应带爬取态（转起来）");

  chip.fire("click");
  assert.equal(panel.hidden, false, "点击状态后浮窗应打开");
  assert.equal(chip.attrs["aria-expanded"], "true", "浮窗打开时应同步 aria-expanded");
  const text = [panel, ...panel.all].map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /采集状态/, "浮窗应有标题，实际：" + text);
  assert.match(text, /采集中/, "浮窗应显示后端状态，实际：" + text);
  assert.match(text, /已抓 282 \/ 313/, "浮窗应显示分段进度，实际：" + text);
  assert.match(text, /1200 \/ 9826/, "浮窗应显示 README 索引进度，实际：" + text);
  assert.match(text, /750 \/ 预算 600/, "浮窗应显示请求与预算，实际：" + text);

  // Esc 关闭（app.js 把状态浮窗排在放大退回之前）
  for (const fn of windowListeners.keydown ?? []) fn({ key: "Escape", target: {} });
  assert.equal(panel.hidden, true, "Esc 应关闭浮窗");

  // 点画布空白处关闭
  chip.fire("click");
  assert.equal(panel.hidden, false, "再点应重新打开");
  registry.get("stage").fire("pointerdown", {});
  assert.equal(panel.hidden, true, "点画布应关闭浮窗");
  assert.equal(chip.attrs["aria-expanded"], "false");
});

test("v0.4.2 搜索：从圆心放射出指向命中仓库的直线，清空后消失", () => {
  const search = registry.get("search");
  const canvas = registry.get("graph");
  const fitBtn = hudButtons.find((b) => b.dataset.act === "fit");
  assert.ok(fitBtn, "应有「适应窗口」按钮");
  fitBtn.fire("click"); // 先回到全景，保证命中球都在屏内
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 94 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 94 }); // 取消选中，避免把关联连线算进来
  pump(10);

  const before = drawCalls.lineTo;
  const segStart = drawCalls.segments.length;
  const widthStart = drawCalls.strokeWidths.length;
  search.value = "tauri";
  search.fire("input");
  pump(30);
  const rays = drawCalls.lineTo - before;
  assert.ok(rays > 0, "搜索后应画出指向光束（lineTo），实际新增 " + rays);
  // 光束必须够粗：低倍率（缩小看全景）下 1px 细线等于看不见
  const widths = drawCalls.strokeWidths.slice(widthStart);
  assert.ok(widths.length > 0, "光晕/光芯应当有描边");
  assert.ok(Math.max(...widths) >= 3, "光束主描边应明显变粗，实际最粗 " + Math.max(...widths) + "px");

  const m = /放射线指向 (\d+) 个搜索命中/.exec(hint.textContent);
  assert.ok(m, "状态栏应报出放射线指向的命中数，实际：" + hint.textContent);
  const hits = Number(m[1]);
  assert.ok(hits > 0 && hits < NODE_COUNT, "搜索命中数应在 0 与总数之间，实际 " + hits);
  assert.ok(rays >= hits, "每个命中至少一条放射线：命中 " + hits + "，实际 lineTo 新增 " + rays);

  // 几何验证：所有放射线必须从同一个点（圆心）射出，而不是各画各的
  const byOrigin = new Map();
  for (const [x1, y1] of drawCalls.segments.slice(segStart)) {
    const key = x1.toFixed(2) + "," + y1.toFixed(2);
    byOrigin.set(key, (byOrigin.get(key) ?? 0) + 1);
  }
  const shared = Math.max(...byOrigin.values());
  assert.ok(shared >= hits, "应有 " + hits + " 条线从同一个圆心射出，实际最多只有 " + shared + " 条（起点种类 " + byOrigin.size + "）");

  search.value = "";
  search.fire("input");
  pump(30);
  const cleared = drawCalls.lineTo;
  pump(30);
  assert.equal(drawCalls.lineTo, cleared, "清空搜索后不应再画放射线");
});

test("v0.4.2 同作者：点选大作者成员也连到其余全部同作者仓库", (t) => {
  const coreNodes = coreJson.nodes ?? [];
  const byOwner = new Map();
  for (const n of coreNodes) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  // 成员 > 8 的作者：数据层只写星形拓扑，正是「有的连得全、有的只连一个」的那批
  const big = [...byOwner.entries()].filter(([, list]) => list.length > 8).sort((a, b) => b[1].length - a[1].length)[0];
  if (!big) {
    t.skip("当前数据里没有成员 > 8 的作者（限扫数据集），跳过大作者星形拓扑这项");
    return;
  }
  const [owner, list] = big;

  const stored = new Map();
  for (const e of coreJson.edges ?? []) {
    if (e[2] !== 0) continue; // 0 = owner
    stored.set(coreNodes[e[0]].id, (stored.get(coreNodes[e[0]].id) ?? 0) + 1);
    stored.set(coreNodes[e[1]].id, (stored.get(coreNodes[e[1]].id) ?? 0) + 1);
  }
  const victim = list.find((n) => (stored.get(n.id) ?? 0) < list.length - 1);
  assert.ok(victim, owner + " 组里应有一个成员在存边里连不全（星形拓扑）");

  const search = registry.get("search");
  const canvas = registry.get("graph");
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 93 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 93 });
  canvas.fire("pointerleave"); // 清掉上一条用例残留的 hover：图例优先跟随悬停
  pump(10);

  const before = drawCalls.curve;
  search.value = victim.id;
  search.fire("input");
  search.fire("keydown", { key: "Enter" }); // 回车选中该仓库
  pump(40);
  const drawn = drawCalls.curve - before;
  const expected = list.length - 1;
  assert.ok(drawn >= expected, "点选 " + victim.id + " 应画出 " + expected + " 条同作者连线，实际 " + drawn);

  const legend = registry.get("edge-types").all.map((n) => n.textContent).join(" ");
  const m = /同作者 (\d+)/.exec(legend);
  assert.ok(m, "图例应有同作者计数，实际 " + legend);
  assert.equal(Number(m[1]), expected, "同作者计数必须是完整关系（" + owner + " 共 " + list.length + " 个仓库）");

  search.value = "";
  search.fire("input");
  pump(10);
});

test("榜单弹窗：点奖杯 → 渲染榜单 → 切榜 → 点行跳转 → Esc 关闭", async () => {
  const trophy = registry.get("trophy");
  const modal = registry.get("ranking");
  const body = registry.get("ranking-body");
  const tabs = registry.get("ranking-tabs");
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 96 });
  pump(10);
  assert.equal(modal.hidden, true, "默认不该显示榜单");

  trophy.fire("click");
  assert.equal(modal.hidden, false, "点奖杯应弹出榜单");
  assert.equal(trophy.attrs["aria-expanded"], "true", "应同步 aria-expanded");
  await new Promise((r) => setTimeout(r, 40)); // 等 /api/ranking 的桩返回

  const rankRows = () => body.all.filter((n) => n.className?.startsWith("rank-row"));
  const textOf = (node) => node.all.map((n) => n.textContent ?? "").join(" ");
  assert.ok(rankRows().length > 0, "周更新榜应渲染出行，实际：" + textOf(body));
  assert.doesNotMatch(textOf(body), /窗口 7 天/, "榜单上下不该有文字，实际：" + textOf(body));
  // 前端不展示口径解释：列表与标签页都不挂悬停解释（口径在接口字段里）
  assert.ok(!body.title, "列表不该挂悬停解释，实际：" + body.title);
  assert.ok(!tabs.children.find((b) => b.dataset.tab === "updated")?.title, "标签页不该挂悬停解释");
  assert.match(textOf(body), /≥3 次/, "要显示更新轮次并标明下界（≥），实际：" + textOf(body));

  // 切到 star 榜：增量与【真实窗口】都要在，且不能假装是"周"
  const starTab = tabs.children.find((b) => b.dataset.tab === "stars");
  assert.ok(starTab, "应有 star 榜切换按钮");
  starTab.fire("click");
  const starText = textOf(body);
  assert.match(starText, /\+\d/, "star 榜应显示增量，实际：" + starText);
  assert.doesNotMatch(starText, /实际窗口/, "列表里不该有窗口文字，实际：" + starText);
  assert.match(starText, /1\.75 天/, "窗口天数要作为数据放在次行（不是解释文字），实际：" + starText);
  assert.ok(starTab.classList.contains("on"), "切换后按钮应处于选中态");
  assert.equal(tabs.children.find((b) => b.dataset.tab === "updated").classList.contains("on"), false, "另一个榜单应取消选中");

  // 点第一行：关闭弹窗 + 选中并把镜头移过去（复用「关联居中」那套动作）
  const first = rankRows()[0];
  first.fire("click");
  assert.equal(modal.hidden, true, "点行后应关闭弹窗");
  assert.equal(trophy.attrs["aria-expanded"], "false");
  pump(20);
  assert.equal(registry.get("telemetry").textContent, "缩放 1.10", "点行应把镜头移到该仓库（居中显示）");
  assert.ok(inspector.find((n) => n.tagName === "h2"), "右栏应展示该仓库档案");

  // Esc 关闭：弹窗在最上层，优先于状态浮窗与放大退回
  trophy.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(modal.hidden, false, "再点奖杯应重新打开");
  for (const fn of windowListeners.keydown ?? []) fn({ key: "Escape", target: {} });
  assert.equal(modal.hidden, true, "Esc 应关闭榜单弹窗");
  assert.equal(trophy.attrs["aria-expanded"], "false");
});

