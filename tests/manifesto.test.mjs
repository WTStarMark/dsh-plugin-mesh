import { test } from "node:test";
import assert from "node:assert/strict";
import { createManifesto } from "../src/manifesto.js";

/** 最小 DOM 桩：只实现这个模块真正用到的东西（与 index-source 的测试同一套写法） */
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

test("默认收起；点按钮开、再点关，aria-expanded 与 hidden 同步", () => {
  const button = stub("button");
  const modal = stub();
  modal.hidden = true;
  const m = createManifesto({ button, modal });
  assert.equal(m.isOpen(), false, "默认必须是收起的");
  assert.equal(modal.hidden, true);

  button.fire("click");
  assert.equal(m.isOpen(), true);
  assert.equal(modal.hidden, false, "打开后弹窗必须可见");
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.ok(button.classes.has("on"), "按钮要进按下态");

  button.fire("click");
  assert.equal(m.isOpen(), false);
  assert.equal(modal.hidden, true);
  assert.equal(button.attrs["aria-expanded"], "false");
});

test("✕ 与遮罩都能关；close() 可重复调用", () => {
  const button = stub("button");
  const modal = stub();
  const close = stub("button");
  const mask = stub();
  modal.hidden = true;
  const m = createManifesto({ button, modal, close, mask });

  m.setOpen(true);
  close.fire("click");
  assert.equal(m.isOpen(), false, "✕ 应关闭");

  m.setOpen(true);
  mask.fire("click");
  assert.equal(m.isOpen(), false, "点遮罩应关闭");

  m.close();
  m.close();
  assert.equal(m.isOpen(), false);
  assert.equal(modal.hidden, true);
});

test("分页：切页只显示对应那一页，重新打开回到第一页", () => {
  const button = stub("button");
  const modal = stub();
  modal.hidden = true;
  const letter = stub();
  const ai = stub();
  ai.hidden = true;
  const tabLetter = stub("button");
  const tabAi = stub("button");
  const m = createManifesto({
    button,
    modal,
    pages: [
      { id: "letter", node: letter, tab: tabLetter },
      { id: "ai", node: ai, tab: tabAi },
    ],
  });

  assert.equal(m.page(), "letter", "默认在第一页");
  assert.equal(letter.hidden, false);
  assert.equal(ai.hidden, true);

  tabAi.fire("click");
  assert.equal(m.page(), "ai");
  assert.equal(letter.hidden, true, "切页后第一页必须隐藏");
  assert.equal(ai.hidden, false);
  assert.equal(tabAi.attrs["aria-selected"], "true");
  assert.equal(tabLetter.attrs["aria-selected"], "false");
  assert.ok(tabAi.classes.has("on"));

  m.setPage("不存在的一页");
  assert.equal(m.page(), "ai", "无效页名不该把状态改坏");

  button.fire("click");
  assert.equal(m.page(), "letter", "重新打开要回到第一页");
  assert.equal(letter.hidden, false);
  assert.equal(ai.hidden, true);
});

test("节点缺失也不抛：只在拿到节点时才挂事件", () => {
  const m = createManifesto({});
  assert.equal(m.isOpen(), false);
  m.setOpen(true);
  assert.equal(m.isOpen(), true);
  m.close();
  assert.equal(m.isOpen(), false);
});

test("applyManifestoContent：把服务端内容写进标题/页签/正文，保留静态兜底", async () => {
  const { applyManifestoContent } = await import("../src/manifesto.js");
  const title = stub();
  const subtitle = stub();
  const letter = stub();
  const ai = stub();
  const tabLetter = stub();
  const tabAi = stub();
  const ok = applyManifestoContent(
    {
      title: "新倡议书",
      subtitle: "新副标题",
      pages: [
        { id: "letter", label: "正文", html: "<p>新正文</p>" },
        { id: "ai", label: "API", html: "<p>新 API</p>" },
      ],
    },
    { title, subtitle, pages: { letter, ai }, tabs: { letter: tabLetter, ai: tabAi } },
  );
  assert.equal(ok, true);
  assert.equal(title.textContent, "新倡议书");
  assert.equal(subtitle.textContent, "新副标题");
  assert.equal(tabLetter.textContent, "正文");
  assert.equal(tabAi.textContent, "API");
  assert.equal(letter.innerHTML, "<p>新正文</p>");
  assert.equal(ai.innerHTML, "<p>新 API</p>");
});

test("applyManifestoContent：字段缺失时不动静态内容", async () => {
  const { applyManifestoContent } = await import("../src/manifesto.js");
  const title = stub();
  title.textContent = "原来的标题";
  const letter = stub();
  letter.innerHTML = "原来的正文";
  const ok = applyManifestoContent({ pages: [] }, { title, pages: { letter } });
  assert.equal(ok, false);
  assert.equal(title.textContent, "原来的标题");
  assert.equal(letter.innerHTML, "原来的正文");
});
