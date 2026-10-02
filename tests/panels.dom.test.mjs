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

test("renderInspector：点击邻居会回调 selectRepo", () => {
  calls.length = 0;
  const target = prepared.nodes.find((n) => (prepared.adjacency.get(n.id)?.length ?? 0) > 0);
  const state = { ...baseState(), selectedId: target.id };
  const root = new FakeNode("aside");
  panels.renderInspector(root, prepared, state, actions);
  const neigh = root.all.find((n) => n.className === "neigh");
  neigh.listeners.click[0]();
  assert.equal(calls[0][0], "selectRepo");
  assert.ok(prepared.byId.has(calls[0][1]));
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

test("renderEdgeTypeChips：每个边类型一个开关，点击回调 toggleEdgeType", () => {
  calls.length = 0;
  const root = new FakeNode("div");
  const state = baseState();
  panels.renderEdgeTypeChips(root, prepared, state, actions);
  assert.equal(root.children.length, 2, "样本里应有 topic / owner 两类边");
  root.children[0].listeners.click[0]();
  assert.equal(calls[0][0], "toggleEdgeType");
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
