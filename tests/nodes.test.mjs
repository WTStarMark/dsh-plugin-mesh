import { test } from "node:test";
import assert from "node:assert/strict";

/** 最小 DOM 桩：createNodeSwitcher 只用到 createElement / append / addEventListener / classList / hidden */
function makeNode(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    hidden: false,
    disabled: false,
    className: "",
    _text: "",
    get textContent() { return node._text; },
    set textContent(value) {
      node._text = String(value ?? "");
      if (value === "") node.children.length = 0; // 真实 DOM 里 textContent="" 会清空子节点
    },
    attrs: {},
    handlers: {},
    append(...items) { node.children.push(...items.flat()); },
    setAttribute(key, value) { node.attrs[key] = value; },
    addEventListener(type, fn) { (node.handlers[type] ??= []).push(fn); },
    fire(type, ev = {}) { for (const fn of node.handlers[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: node, ...ev }); },
    classList: {
      toggle(name, on) { node.classes = node.classes || new Set(); if (on) node.classes.add(name); else node.classes.delete(name); },
      add(name) { node.classes = node.classes || new Set(); node.classes.add(name); },
      contains(name) { return !!node.classes && node.classes.has(name); },
    },
  };
  return node;
}
globalThis.document = { createElement: (tag) => makeNode(tag) };

const { createNodeSwitcher, currentNodeId } = await import("../src/nodes.js");

const NODES = [
  { id: "aws", label: "主节点 · 悉尼", url: "https://www.moc-chen.cn", role: "primary" },
  { id: "la", label: "镜像 · 洛杉矶", url: "https://104.129.51.126", role: "mirror" },
];

test("currentNodeId：按 origin 精确匹配，匹配不到退回第一个节点", () => {
  assert.equal(currentNodeId(NODES, "https://www.moc-chen.cn"), "aws");
  assert.equal(currentNodeId(NODES, "https://104.129.51.126"), "la");
  assert.equal(currentNodeId(NODES, "https://unknown.example"), "aws");
  assert.equal(currentNodeId([], "https://www.moc-chen.cn"), null);
});

test("多节点：按钮显示；当前节点禁用；点其它节点跳转", () => {
  const button = makeNode("button");
  const panel = makeNode("div");
  const name = makeNode("b");
  const list = makeNode("ul");
  const jumped = [];
  const switcher = createNodeSwitcher({ button, panel, nameNode: name, listNode: list, nodes: NODES, currentUrl: "https://www.moc-chen.cn", navigate: (url) => jumped.push(url) });

  assert.equal(button.hidden, false, "两个节点时按钮必须显示");
  assert.equal(button.attrs["aria-expanded"], "false");
  assert.equal(name.textContent, "主节点 · 悉尼", "按钮上显示当前节点名");

  switcher.open();
  assert.equal(panel.hidden, false);
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.equal(list.children.length, 2);

  const [first, second] = list.children;
  const firstBtn = first.children[0];
  const secondBtn = second.children[0];
  assert.equal(firstBtn.disabled, true, "当前节点不可点");
  assert.equal(secondBtn.disabled, false);
  secondBtn.fire("click");
  assert.deepEqual(jumped, ["https://104.129.51.126"], "点镜像节点应跳转到它的地址");
});

test("单节点：按钮隐藏，setNodes 后编号与当前标记同步", () => {
  const button = makeNode("button");
  const list = makeNode("ul");
  const name = makeNode("b");
  const switcher = createNodeSwitcher({ button, panel: makeNode("div"), nameNode: name, listNode: list, nodes: [NODES[0]], currentUrl: "https://www.moc-chen.cn" });
  assert.equal(button.hidden, true, "单节点隐藏入口");
  switcher.setNodes(NODES);
  assert.equal(button.hidden, false, "补到两个节点后应显示");
  assert.equal(name.textContent, "主节点 · 悉尼");
  assert.equal(switcher.currentId(), "aws");
});
