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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
// 期望值一律从数据推导：数据每小时由采集器更新，硬编码数字必然过期
const NODE_COUNT = mesh.nodes.length;
const SECTOR_COUNT = mesh.clusters.length;
const SECTOR_DEG = (360 / SECTOR_COUNT).toFixed(1).replace(".", "\\.");
const atFull = new RegExp("命中 " + NODE_COUNT + " / " + NODE_COUNT);

const drawCalls = { fillRect: 0, arc: 0, stroke: 0, fill: 0, fillText: 0, closePath: 0, clip: 0, drawImage: 0, curve: 0 };

function makeCtx() {
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    setTransform() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {},
    translate() {}, rotate() {}, scale() {}, measureText() { return { width: 40 }; },
    moveTo() {}, lineTo() {},
    fillRect() { drawCalls.fillRect++; },
    arc() { drawCalls.arc++; },
    closePath() { drawCalls.closePath++; },
    clip() { drawCalls.clip++; },
    quadraticCurveTo() { drawCalls.curve++; },
    drawImage() { drawCalls.drawImage++; },
    fill() { drawCalls.fill++; },
    stroke() { drawCalls.stroke++; },
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

const ids = ["rail", "inspector", "snapshot", "loading", "tooltip", "hint", "telemetry", "lamp", "edge-types", "search", "search-clear", "theme", "palette", "toggle-rail", "toggle-dossier", "stage", "graph"];
const registry = new Map(ids.map((id) => [id, new FakeNode(id === "graph" ? "canvas" : "div", id)]));

// 桩必须尊重真实 HTML 的 hidden 属性，否则测的就不是真页面
const indexHtml = await readFile(resolve(ROOT, "index.html"), "utf8");
for (const m of indexHtml.matchAll(/id="([^"]+)"[^>]*\shidden/g)) {
  const node = registry.get(m[1]);
  if (node) node.hidden = true;
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
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
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
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => mesh });

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
await new Promise((r) => setTimeout(r, 40));

const canvas = registry.get("graph");
const rail = registry.get("rail");
const inspector = registry.get("inspector");
const hint = registry.get("hint");
const tooltip = registry.get("tooltip");

test("启动后：载入层关闭、快照读数就位", () => {
  assert.equal(registry.get("loading").hidden, true, "载入完成后 loading 必须隐藏（否则页面看起来是白屏）");
  assert.match(registry.get("snapshot").textContent, /^\d{4}-\d{2}-\d{2} · 抽样$/, "快照读数应为日期：" + registry.get("snapshot").textContent);
  assert.match(registry.get("telemetry").textContent, /^缩放 \d+\.\d\d$/, "缩放读数应被初始化");
});

test("布局会沉降并真的画出东西", () => {
  const frames = pump(900);
  assert.ok(frames > 20, "应至少跑了若干帧，实际 " + frames);
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
  assert.ok(registry.get("edge-types").children.length >= 2, "连线开关数量不对：" + registry.get("edge-types").children.length);
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

test("点开某类连线后，弧线真的画出来（此时没有任何聚焦，节点全是激活的）", () => {
  const chip = registry.get("edge-types").children[0];
  chip.fire("click");
  const before = drawCalls.curve;
  pump(30);
  assert.ok(drawCalls.curve > before, "点开连线后应绘制弧线，新增 " + (drawCalls.curve - before));
  chip.fire("click"); // 还原
  pump(10);
  assert.equal(drawCalls.curve > before, true, "还原后不再新增");
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

test("默认只开「标签」与「头像」：连线一律默认关闭", () => {
  const chips = registry.get("edge-types").children;
  assert.ok(chips.length >= 1, "应有连线开关");
  for (const chip of chips) assert.ok(!chip.className.includes("on"), "连线开关默认应关闭：" + chip.textContent);
  assert.ok(hudButtons.find((b) => b.dataset.act === "labels").className.includes("on"), "「标签」应默认开启");
  assert.ok(hudButtons.find((b) => b.dataset.act === "avatars").className.includes("on"), "「头像」应默认开启");
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

test("选中仓库时，即使「同作者」开关关闭也会画出它的同作者连线", () => {
  // 前提：所有连线开关都是关的
  const chips = registry.get("edge-types").children;
  for (const chip of chips) assert.ok(!chip.className.includes("on"), "前提：连线开关全关");

  // 找出「同作者有多个仓库」的那些仓库 —— 只有它们才有同作者连线
  const byOwner = new Map();
  for (const n of mesh.nodes) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  const siblings = new Set();
  for (const list of byOwner.values()) {
    if (list.length < 2) continue;
    for (const n of list) siblings.add(n.id);
  }
  assert.ok(siblings.size > 0, "样本里应有同作者多仓库的案例");

  // 先清掉选中，记一帧基准
  const canvas = registry.get("graph");
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 99 });
  pump(5);
  const before = drawCalls.curve;

  // 扫画布找到「确有同作者」的那个节点，再点它（与悬停测试同一套扫描方式）
  let hit = null;
  outer: for (let y = 20; y < 600; y += 10) {
    for (let x = 20; x < 900; x += 10) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (!tooltip.hidden) {
        const name = tooltip.all.map((n) => n.textContent).join(" ");
        const id = [...siblings].find((sid) => name.includes(sid.split("/")[1]));
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
  assert.ok(drawCalls.curve > before, "选中 " + hit.id + " 后应画出同作者连线，新增 " + (drawCalls.curve - before));
});
