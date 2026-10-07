/**
 * DOM 桩测试：没有无头浏览器，就用最小 DOM 桩把面板层跑一遍。
 * 目的是抓「运行时才会炸」的错误（属性名写错、分支未覆盖、颜色没赋上）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = tag === "#text" ? 3 : 1;
    this.children = [];
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
    this.attrs = {};
    this.className = "";
    this.listeners = {};
    this.offsetWidth = 220;
    this.offsetHeight = 84;
    this.hidden = false;
    this._text = "";
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  querySelector() { return null; }
  get all() { return this.children.flatMap((c) => [c, ...(c.all ?? [])]); }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const n = new FakeNode("#text");
    n.textContent = text;
    return n;
  },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const { prepare } = await import("../src/mesh-data.js");
const panels = await import("../src/panels.js");

const prepared = prepare(mesh);
const calls = [];
const actions = new Proxy({}, { get: (_t, prop) => (...args) => calls.push([String(prop), ...args]) });
const baseState = () => ({
  tags: new Set(prepared.tags.map((t) => t.id)),
  minStarsPct: 0,
  minStars: 0,
  pushedDays: 0,
  language: "all",
  hideNoise: false,
  archived: "all",
  clusterFocus: null,
  neighborFocus: null,
  selectedId: null,
  edgeTypes: new Set(prepared.edgeTypes),
  lastHit: prepared.nodes.length,
});

test("renderRail：渲染统计、标签色块与聚类条", () => {
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions);
  const flat = root.all;
  assert.equal(flat.filter((n) => n.className?.startsWith("stat")).length, 4, "应有 4 个读数格");
  assert.ok(flat.some((n) => n.className === "stat hot"), "NODES 读数应带高亮修饰");
  assert.ok(flat.some((n) => n.className === "stat warn"), "FLAGGED 读数应带告警修饰");
  const dots = flat.filter((n) => n.className === "dot");
  assert.equal(dots.length, prepared.tags.length, "每个标签一个色块");
  for (const dot of dots) {
    assert.ok(typeof dot.style.background === "string" && dot.style.background.startsWith("#"), "色块必须带上颜色，实际=" + dot.style.background);
  }
  assert.ok(flat.some((n) => n.className === "sector-row"), "应有功能扇区行");
  assert.ok(flat.some((n) => n.tagName === "input" && n.attrs.type === "range"), "应有星标滑块");
});

test("左栏顺序（v0.4.3）：总览 → 功能扇区 → 筛选 → 其余", () => {
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions);
  const titles = root.children.filter((c) => c.className === "sec").map((c) => c.children[0].textContent);
  assert.deepEqual(
    titles.slice(0, 3),
    ["总览", "功能扇区", "筛选"],
    "左栏前三段必须是 总览 / 功能扇区 / 筛选，实际：" + titles.join(" → "),
  );
  // 其余照常：保持原来的相对顺序
  assert.deepEqual(titles.slice(3), ["扇区划分依据", "捕获标签", ...(titles.includes("高频共享标签") ? ["高频共享标签"] : [])]);
  // 单扇区放大时，第二段变成「细枝分类」，位置不变
  const focused = new FakeNode("aside");
  panels.renderRail(focused, prepared, baseState(), actions, { focusCategory: prepared.clusters[0].id, focusLabel: prepared.clusters[0].label, arms: [] });
  const ftitles = focused.children.filter((c) => c.className === "sec").map((c) => c.children[0].textContent);
  assert.equal(ftitles[0], "总览");
  assert.equal(ftitles[1], "细枝分类");
  assert.equal(ftitles[2], "筛选");
});

test("右栏顺序（v0.4.3）：未选中时 图例 → 操作提示 在最前；点开项目球后压到最底部", () => {
  const empty = new FakeNode("aside");
  panels.renderInspector(empty, prepared, baseState(), actions, { linkCounts: { owner: 3, topic: 2, resonance: 1 } });
  const emptyTitles = empty.children.filter((c) => c.className === "sec").map((c) => c.children[0].textContent);
  assert.equal(emptyTitles[0], "图例", "未选中时右栏第一段应是图例，实际：" + emptyTitles.join(" → "));
  assert.equal(emptyTitles[1], "操作提示", "未选中时右栏第二段应是操作提示，实际：" + emptyTitles.join(" → "));
  assert.ok(/^待复核仓库/.test(emptyTitles[2] ?? ""), "其余照常：待复核清单排在它们后面，实际：" + emptyTitles.join(" → "));

  const picked = prepared.nodes.find((n) => (prepared.adjacency.get(n.id) ?? []).length > 0);
  const filled = new FakeNode("aside");
  panels.renderInspector(filled, prepared, { ...baseState(), selectedId: picked.id }, actions, { linkCounts: { owner: 3, topic: 2, resonance: 1 } });
  const titles = filled.children.map((c) => c.children[0]?.textContent);
  // 第一段是仓库档案（首个子节点是 d-head，没有 h3 标题）
  assert.equal(filled.children[0].className, "sec", "点开后第一段应是仓库档案小节");
  assert.ok(!/^(图例|操作提示)$/.test(titles[0] ?? ""), "点开后图例不该还占着顶部，实际：" + titles.join(" → "));
  assert.deepEqual(titles.slice(-2), ["图例", "操作提示"], "点开后图例与操作提示应压在右栏最底部，实际：" + titles.join(" → "));
  assert.ok(titles.some((t) => /^关联（/.test(t ?? "")), "档案内容仍照常排在前面，实际：" + titles.join(" → "));
});

test("面板里不允许出现 [object ...] 这类拼接事故", () => {
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions);
  panels.renderInspector(root, prepared, baseState(), actions);
  const target = prepared.nodes.find((n) => (prepared.adjacency.get(n.id) ?? []).length > 0);
  panels.renderInspector(root, prepared, { ...baseState(), selectedId: target.id }, actions);
  const bad = root.all.filter((n) => n.nodeType === 3 && /\[object /.test(n.textContent));
  assert.equal(bad.length, 0, "发现被 String() 掉的 DOM 数组: " + bad.map((b) => b.textContent.slice(0, 60)).join(" | "));
});

test("renderRail：点击标签行会回调 toggleTag", () => {
  calls.length = 0;
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions);
  const row = root.all.find((n) => n.className?.startsWith("tag-row"));
  row.listeners.click[0]();
  assert.equal(calls[0][0], "toggleTag");
  assert.ok(prepared.tags.some((t) => t.id === calls[0][1]), "回调参数应是真实标签 id");
});

test("renderInspector：无选中时展示待复核队列", () => {
  const root = new FakeNode("aside");
  panels.renderInspector(root, prepared, baseState(), actions);
  const items = root.all.filter((n) => n.className === "review-item");
  assert.equal(items.length, Math.min(8, prepared.review.length));
  assert.ok(prepared.review.length > 0, "样本里应有疑似噪声节点");
  assert.ok(panels.reviewReason(prepared.review[0]).length > 0);
});

test("renderInspector：选中时展示仓库详情与邻居", () => {
  const target = [...prepared.nodes].sort((a, b) => (prepared.adjacency.get(b.id)?.length ?? 0) - (prepared.adjacency.get(a.id)?.length ?? 0))[0];
  const state = { ...baseState(), selectedId: target.id };
  const root = new FakeNode("aside");
  panels.renderInspector(root, prepared, state, actions);
  const flat = root.all;
  assert.ok(flat.some((n) => n.tagName === "h2" && n.textContent === target.name), "应展示仓库名");
  assert.ok(flat.filter((n) => n.className === "neigh").length > 0, "应展示邻居列表");
  assert.ok(flat.filter((n) => n.className === "pill hit").length === target.matchedTags.length, "命中标签 pill 数量不符");
  const links = flat.filter((n) => n.tagName === "a").map((n) => n.attrs.href);
  assert.ok(links.includes(target.htmlUrl), "应有 GitHub 外链");
  assert.ok(links.every((h) => typeof h === "string" && h.length > 0), "所有链接都要有 href");
});

test("renderInspector：点击「关联」里的仓库会回调 openRelated（选中并居中）", () => {
  calls.length = 0;
  const target = prepared.nodes.find((n) => (prepared.adjacency.get(n.id)?.length ?? 0) > 0);
  const state = { ...baseState(), selectedId: target.id };
  const root = new FakeNode("aside");
  panels.renderInspector(root, prepared, state, actions);
  const neigh = root.all.find((n) => n.className === "neigh");
  const rowId = neigh.all.find((n) => n.className === "nm").textContent;
  neigh.listeners.click[0]();
  assert.equal(calls[0][0], "openRelated", "关联行点击应走 openRelated（选中并自动居中），实际：" + calls[0][0]);
  assert.equal(calls[0][1], rowId, "回调的应是这一行展示的仓库");
  assert.ok(prepared.byId.has(calls[0][1]));
});

test("renderRail：以某仓库为中心时给出「返回全景」横幅", () => {
  calls.length = 0;
  const centerId = prepared.nodes.find((n) => n.id !== "deepseek-ai/deepseek-harness").id;
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions, { centerId, arms: [], hubId: "deepseek-ai/deepseek-harness" });
  const banner = root.children[0];
  assert.equal(banner?.className, "focus-banner", "横幅应排在左栏最前，实际：" + banner?.className);
  const text = banner.all.map((n) => n.textContent ?? "").join(" ");
  assert.ok(text.includes(centerId), "横幅应点名当前圆心，实际：" + text);
  const back = banner.all.find((n) => String(n.textContent ?? "").includes("返回全景"));
  assert.ok(back, "横幅里应有「返回全景」按钮");
  back.listeners.click[0]();
  assert.equal(calls[0][0], "exitCenter");
});

test("renderRail：不在中心视图时不该出现返回横幅", () => {
  const root = new FakeNode("aside");
  panels.renderRail(root, prepared, baseState(), actions, { arms: [], hubId: "deepseek-ai/deepseek-harness" });
  assert.equal(root.children.filter((n) => n.className === "focus-banner").length, 0);
});

test("renderTooltip：定位落在画布内且显示节点信息", () => {
  const tip = new FakeNode("div");
  const node = prepared.nodes[0];
  panels.renderTooltip(tip, node, { x: 100, y: 100 }, { width: 800, height: 600 });
  assert.equal(tip.hidden, false);
  assert.ok(/px$/.test(tip.style.left) && /px$/.test(tip.style.top), "tooltip 必须被定位");
  assert.ok(tip.all.some((n) => n.textContent === node.id), "tooltip 应含仓库名");
  panels.renderTooltip(tip, null, { x: 0, y: 0 }, { width: 800, height: 600 });
  assert.equal(tip.hidden, true, "传入 null 应隐藏");
});

test("renderLinkLegend：实时显示同作者/主题共现计数（无提示语）", () => {
  const root = new FakeNode();
  const info = { colors: { accent: "#2f7df6", topic: "#e08a00" } };

  // 无选中、无悬停 → 两个 0，且不再有提示语
  panels.renderLinkLegend(root, prepared, {}, {}, info);
  const empty = root.all.map((n) => n.textContent).join(" ");
  assert.match(empty, /同作者 0/, "未选中时应显示 0，实际 " + empty);
  assert.match(empty, /主题共现 0/, "未选中时应显示 0，实际 " + empty);
  assert.ok(!/点选/.test(empty), "不应再出现提示语");

  // 有选中 → 显示该仓库的实际计数
  const target = prepared.nodes.find((n) => (prepared.adjacency.get(n.id) ?? []).some((e) => e.type === "owner"));
  assert.ok(target, "样本里应有带同作者连线的仓库");
  panels.renderLinkLegend(root, prepared, { selectedId: target.id }, {}, info);
  const text = root.all.map((n) => n.textContent).join(" ");
  const owner = (prepared.adjacency.get(target.id) ?? []).filter((e) => e.type === "owner").length;
  assert.match(text, new RegExp("同作者 " + owner), "应显示实际同作者数，实际 " + text);
  assert.match(text, /主题共现 \d+/, "应显示主题共现数");
});

test("starThreshold：0 到 maxStars 单调递增", () => {
  let prev = -1;
  for (let pct = 0; pct <= 100; pct += 10) {
    const v = panels.starThreshold(pct, prepared.maxStars);
    assert.ok(v >= prev, "阈值必须单调不减");
    prev = v;
  }
  assert.equal(panels.starThreshold(0, prepared.maxStars), 0);
  assert.equal(panels.starThreshold(100, prepared.maxStars), prepared.maxStars);
});

test("回归：右栏「在 GitHub 打开」必须有真实 href（核心路径没有 htmlUrl 字段）", () => {
  const root = new FakeNode();
  const node = prepared.nodes.find((n) => !n.htmlUrl) ?? prepared.nodes[0]; // 模拟预计算契约：无 htmlUrl
  const bare = { ...node };
  delete bare.htmlUrl;
  panels.renderInspector(root, prepared, { ...baseState(), selectedId: bare.id }, actions);
  const link = root.all.find((n) => String(n.textContent ?? "") === "在 GitHub 打开");
  assert.ok(link, "应渲染出「在 GitHub 打开」按钮");
  assert.equal(link.attrs.href, "https://github.com/" + bare.id, "href 必须由 id 推导，实际 " + link.attrs.href);
  assert.equal(link.attrs.target, "_blank");
  // 老数据仍带 htmlUrl 时优先用它
  const root2 = new FakeNode();
  const withUrl = { ...bare, htmlUrl: "https://github.com/example/custom" };
  const prepared2 = { ...prepared, byId: new Map(prepared.byId).set(bare.id, withUrl) };
  panels.renderInspector(root2, prepared2, { ...baseState(), selectedId: bare.id }, actions);
  const link2 = root2.all.find((n) => String(n.textContent ?? "") === "在 GitHub 打开");
  assert.equal(link2.attrs.href, "https://github.com/example/custom", "有 htmlUrl 时应优先使用");
});
