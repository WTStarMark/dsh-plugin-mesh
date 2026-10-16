/**
 * 后台前端「可执行性」回归测试。
 *
 * 事故背景（2026-10-16 定位）：admin/app.js 里有一个裸的 async 关键字，
 * 它后面隔着注释换行才接 function —— JS 语法规定 async 与 function 之间不能有换行，
 * 于是它不被当成 async 函数声明，而被当成标识符求值：模块一加载就抛
 *   ReferenceError: async is not defined
 * 结果：登录按钮的 click 监听从来没绑上，界面上点「登录」毫无反应。
 * 而 node --check 只做语法解析、不做求值，所以「语法自检」查不出这一类问题。
 *
 * 这里用最小 DOM 桩，真的把 admin/app.js 当 ES 模块求值一次，再真跑一次登录点击。
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";

/* ---------------- 最小 DOM 桩 ---------------- */

const nodes = new Map();
function makeNode(name) {
  const listeners = {};
  return {
    tagName: String(name || "div").toUpperCase(),
    value: "", textContent: "", className: "", hidden: false, disabled: false,
    checked: false, scrollTop: 0, files: [], children: [], parentNode: null,
    dataset: {}, style: {}, options: [], selectedIndex: 0, isConnected: true,
    _listeners: listeners,
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) { for (const f of listeners[t] || []) f(ev); },
    appendChild(c) { this.children.push(c); if (c && typeof c === "object") c.parentNode = this; return c; },
    append(...cs) { for (const c of cs) { this.children.push(c); if (c && typeof c === "object") c.parentNode = this; } },
    insertBefore(c) { return this.appendChild(c); },
    replaceChildren(...cs) { this.children = cs; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return k in this ? this[k] : null; },
    removeAttribute(k) { delete this[k]; },
    hasAttribute() { return false; },
    contains() { return false; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 20 }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    click() { this.dispatch("click", { preventDefault() {}, target: this }); },
  };
}
const byId = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };

const doc = makeNode("document");
doc.readyState = "complete";
doc.documentElement = makeNode("html");
doc.body = makeNode("body");
doc.head = makeNode("head");
doc.getElementById = byId;
doc.createElement = (t) => makeNode(t);
doc.createDocumentFragment = () => makeNode("fragment");
doc.createTextNode = (t) => ({ textContent: t });
doc.querySelector = () => null;
doc.querySelectorAll = () => [];

globalThis.document = doc;
globalThis.window = globalThis;
Object.defineProperty(globalThis, "location", { value: { href: "http://test/ztx/", origin: "http://test" }, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "dom-stub" }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.addEventListener = () => {};

/* ---------------- 假网络：不联网，全部本地应答 ---------------- */

const calls = [];
let sessionAuthed = false;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  calls.push({ url, method, body: init.body });
  const reply = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
  if (url === "api/session") return reply({ authed: sessionAuthed, csrf: "csrf-1", expiresAt: "2026-10-17T00:00:00.000Z" });
  if (url === "api/login") { sessionAuthed = true; return reply({ ok: true, csrf: "csrf-1", expiresAt: "2026-10-17T00:00:00.000Z" }); }
  return reply({});
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 用例 ---------------- */

test("admin/app.js 作为 ES 模块求值不抛错，并绑定登录交互（回归：裸 async 导致模块崩溃）", async () => {
  let err = null;
  try {
    await import("../admin/app.js");
  } catch (e) {
    err = e;
  }
  await tick(50);
  assert.equal(err, null, "模块求值抛错：" + (err && err.message));
  assert.ok(byId("login-submit")._listeners.click?.length > 0, "登录按钮没有绑定 click —— 点「登录」会毫无反应");
  assert.ok(byId("login-password")._listeners.keydown?.length > 0, "口令框没有绑定回车提交");
  assert.ok(calls.some((c) => c.url === "api/session"), "启动时应当请求一次 api/session 判断是否已登录");
});

test("模拟登录：点「登录」→ POST api/login → 会话通过 → 收起登录层", async () => {
  calls.length = 0;
  sessionAuthed = false;
  byId("login-password").value = "test-password-123";
  byId("login-submit").dispatch("click", { preventDefault() {}, target: byId("login-submit") });
  assert.equal(byId("login-msg").textContent, "正在登录…", "点击后应当立刻显示在途提示");
  await tick(120);
  const login = calls.find((c) => c.url === "api/login");
  assert.ok(login, "没有发出 api/login 请求");
  assert.equal(login.method, "POST");
  assert.equal(JSON.parse(login.body).password, "test-password-123", "提交口令应当与输入一致");
  assert.equal(byId("login").hidden, true, "登录成功后应当收起登录层");
  assert.equal(byId("app").hidden, false, "登录成功后应当显示主界面");
});

after(() => {
  // 明确收尾：这条测试只改本进程内的全局桩，不产生任何文件
});
