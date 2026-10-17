import { test } from "node:test";
import assert from "node:assert/strict";
import { indexSourceUrl, createIndexSource } from "../src/index-source.js";

/** 最小 DOM 桩：只实现这个模块真正用到的东西（不引第三方库，与项目其它测试一致） */
function stub(tag = "div") {
  const node = {
    tag,
    hidden: false,
    textContent: "",
    attrs: {},
    classes: new Set(),
    handlers: {},
    setAttribute(key, value) {
      node.attrs[key] = value;
    },
    addEventListener(type, fn) {
      (node.handlers[type] ??= []).push(fn);
    },
    fire(type, ev = {}) {
      for (const fn of node.handlers[type] ?? []) fn(ev);
    },
  };
  node.classList = {
    toggle(name, on) {
      if (on) node.classes.add(name);
      else node.classes.delete(name);
    },
  };
  return node;
}

test("索引地址按当前 origin 现算，而不是写死公网域名", () => {
  assert.equal(indexSourceUrl("https://www.moc-chen.cn"), "https://www.moc-chen.cn/market/index.json");
  assert.equal(indexSourceUrl("http://192.168.22.250:8788"), "http://192.168.22.250:8788/market/index.json");
  assert.equal(indexSourceUrl("http://127.0.0.1:8788"), "http://127.0.0.1:8788/market/index.json");
});

test("origin 缺失或不合法时退回公网地址，绝不产出半个 URL", () => {
  assert.equal(indexSourceUrl(""), "https://www.moc-chen.cn/market/index.json");
  assert.equal(indexSourceUrl("不是地址"), "https://www.moc-chen.cn/market/index.json");
  assert.equal(indexSourceUrl(undefined), "https://www.moc-chen.cn/market/index.json");
});

test("展开 / 收起：aria-expanded 与 hidden 同步，且地址已写进节点", () => {
  const button = stub("button");
  const panel = stub("div");
  const urlNode = stub("code");
  const view = createIndexSource({ button, panel, urlNode, origin: "https://www.moc-chen.cn" });

  assert.equal(urlNode.textContent, "https://www.moc-chen.cn/market/index.json", "地址要写进可见节点");
  assert.equal(view.isOpen(), false);
  assert.equal(panel.hidden, true, "默认收起");
  assert.equal(button.attrs["aria-expanded"], "false");

  button.fire("click", { stopPropagation() {} });
  assert.equal(view.isOpen(), true);
  assert.equal(panel.hidden, false);
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.ok(button.classes.has("on"), "展开时胶囊要带 on（用于旋转箭头）");

  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(panel.hidden, true);
  assert.equal(button.attrs["aria-expanded"], "false");
});

test("复制：走注入的剪贴板写入，成功后按钮文字变成「已复制」", async () => {
  const button = stub("button");
  const copyButton = stub("button");
  copyButton.textContent = "复制";
  const written = [];
  const view = createIndexSource({
    button,
    copyButton,
    origin: "https://www.moc-chen.cn",
    writeClipboard: async (text) => written.push(text),
  });

  const ok = await view.copy();
  assert.equal(ok, true);
  assert.deepEqual(written, ["https://www.moc-chen.cn/market/index.json"]);
  assert.equal(copyButton.textContent, "已复制");
});

test("复制失败不静默：按钮明说「复制失败」，且不抛异常", async () => {
  const copyButton = stub("button");
  copyButton.textContent = "复制";
  const view = createIndexSource({
    copyButton,
    origin: "https://www.moc-chen.cn",
    writeClipboard: async () => {
      throw new Error("被浏览器拒绝");
    },
  });
  const ok = await view.copy();
  assert.equal(ok, false, "Node 里没有 document，兜底也复制不了 → 必须返回 false");
  assert.equal(copyButton.textContent, "复制失败");
});

test("没有按钮时不炸：模块返回可用的空壳（静态预览等场景）", () => {
  const view = createIndexSource({});
  assert.equal(view.isOpen(), false);
  view.toggle();
  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(typeof view.url, "string");
});
