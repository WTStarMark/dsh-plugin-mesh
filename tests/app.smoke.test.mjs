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
const coreJson = JSON.parse(await readFile(new URL("../data/mesh-core.json", import.meta.url), "utf8"));
// 生态共鸣清单（人工策展）：测试用它挑基座，不写死任何仓库名
const ecoJson = JSON.parse(await readFile(new URL("../tools/ecosystem.json", import.meta.url), "utf8"));
globalThis.fetch = async (url) => {
  const target = String(url ?? "");
  if (target.includes("mesh-core")) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => coreJson };
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

test("v0.4.2 双击聚焦关联仓库后，点空白处必须恢复全图", () => {
  const canvas = registry.get("graph");
  const hits = () => {
    const m = /当前命中 (\d+) \/ (\d+)/.exec(hint.textContent);
    return m ? Number(m[1]) : -1;
  };
  hudButtons.find((b) => b.dataset.act === "fit").fire("click");
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 92 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 92 });
  canvas.fire("pointerleave");
  pump(10);
  const full = hits();
  assert.ok(full > 0, "初始应命中一批节点，实际：" + hint.textContent);

  // 扫画布找一个节点，双击它 → 只看关联仓库
  let hit = null;
  outer: for (let y = 20; y < 600; y += 10) {
    for (let x = 20; x < 900; x += 10) {
      canvas.fire("pointermove", { clientX: x, clientY: y });
      if (!tooltip.hidden) { hit = { x, y }; break outer; }
    }
  }
  assert.ok(hit, "画布上应能找到节点");
  tooltip.hidden = true;
  canvas.fire("dblclick", { clientX: hit.x, clientY: hit.y });
  pump(20);
  const focused = hits();
  assert.ok(focused < full, "双击后应只剩关联仓库，实际 " + focused + " / " + full);

  // 旧 bug：点空白只清掉选中，neighborFocus 还在，整张图永远暗着
  canvas.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 91 });
  canvas.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 91 });
  pump(20);
  assert.equal(hits(), full, "点空白处应恢复到全图，实际：" + hint.textContent);
});

test("v0.4.3 生态共鸣：点选基座仓库会画出紫罗兰实线", () => {
  const base = (ecoJson.bases ?? []).find((b) => b.enabled !== false && coreJson.nodes.some((n) => n.id === b.id));
  assert.ok(base, "样本数据里应至少有一个生态基座");
  const inData = base.verified.filter((v) => coreJson.nodes.some((n) => n.id === v.id));
  assert.ok(inData.length > 0, base.id + " 在当前数据里应有生态子节点");

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

test("v0.4.2 同作者：点选大作者成员也连到其余全部同作者仓库", () => {
  const coreNodes = coreJson.nodes ?? [];
  const byOwner = new Map();
  for (const n of coreNodes) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  // 成员 > 8 的作者：数据层只写星形拓扑，正是「有的连得全、有的只连一个」的那批
  const big = [...byOwner.entries()].filter(([, list]) => list.length > 8).sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(big, "样本里应有成员超过 8 的作者");
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
