/**
 * 头像加载器测试：工作集上限 + 可见性优先级（v0.4.8）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAvatarStore } from "../src/avatars.js";

function fakeImage() {
  const img = { src: "", onload: null, onerror: null };
  queueMicrotask(() => {});
  return img;
}

test("并发上限：同时在途不超过 concurrency", () => {
  const created = [];
  const store = createAvatarStore({ concurrency: 3, maxActive: 100, createImage: () => { const i = fakeImage(); created.push(i); return i; } });
  store.beginFrame();
  for (let i = 0; i < 20; i++) store.want("u/" + i, i);
  assert.equal(created.length, 3, "一开始只应发出 3 个请求（并发上限）");
  created[0].onload();
  assert.equal(created.length, 4, "一个加载完成后才继续下一个");
  store.endFrame();
  assert.equal(store.inspect().byState.loading, 3, "在途数应回到并发上限");
});

test("优先级：屏幕上更大的（priority 高）先加载", () => {
  const urls = [];
  const store = createAvatarStore({ concurrency: 1, maxActive: 100, createImage: () => { const i = fakeImage(); return i; } });
  store.beginFrame();
  store.want("small", 1);
  const first = store.inspect().byState.loading;
  assert.equal(first, 1, "第一个请求已发出");
  store.want("big", 100);
  store.want("mid", 50);
  // 让在途的完成，下一个应该是最优先的 big
  store.endFrame();
  const order = [];
  const probe = createAvatarStore({ concurrency: 1, maxActive: 100, createImage: () => { const i = { src: "", onload: null, onerror: null }; order.push(i); return i; } });
  probe.beginFrame();
  probe.want("a", 1);
  probe.want("b", 100);
  probe.want("c", 50);
  order[0].onload(); // 完成后按优先级取下一个
  assert.equal(order.length, 2);
  assert.equal(order[1].src, "b", "下一个应是优先级最高的 b，实际 " + order[1].src);
  probe.endFrame();
  urls.length = 0;
});

test("默认工作集上限是 500", () => {
  const store = createAvatarStore({ concurrency: 6, createImage: () => ({ src: "", onload: null, onerror: null }) });
  assert.equal(store.inspect().maxActive, 500, "默认上限应为 500（可用 options.maxActive 覆盖）");
});

test("工作集上限：超出上限时按优先级淘汰（含取消在途请求）", () => {
  const store = createAvatarStore({ concurrency: 100, maxActive: 100, createImage: () => ({ src: "", onload: null, onerror: null }) });
  store.beginFrame();
  for (let i = 0; i < 150; i++) store.want("seen/" + i, i); // 同一帧里全都要
  store.endFrame();
  const s1 = store.inspect();
  assert.equal(s1.size, 100, "同一帧要了 150 个，工作集应被压到 100，实际 " + s1.size);
  assert.ok(s1.evicted >= 50, "应淘汰掉 50 个，实际 " + s1.evicted);
  assert.ok(s1.byState.error === 0);

  // 换一帧：只要两个新的，旧的自然被淘汰
  store.beginFrame();
  store.want("fresh/a", 5);
  store.want("fresh/b", 4);
  store.endFrame();
  const s2 = store.inspect();
  assert.ok(s2.size <= 100, "工作集始终不超过上限");
  assert.ok(s2.size >= 2);
});

test("同一 URL 只请求一次；加载失败不重试", () => {
  let created = 0;
  const imgs = [];
  const store = createAvatarStore({ concurrency: 5, maxActive: 100, createImage: () => { created += 1; const i = { src: "", onload: null, onerror: null }; imgs.push(i); return i; } });
  store.beginFrame();
  store.want("dup", 1);
  store.want("dup", 9);
  store.want("dup", 3);
  assert.equal(created, 1, "同一 URL 只应创建一个 img");
  imgs[0].onerror();
  store.beginFrame();
  store.want("dup", 1);
  assert.equal(created, 1, "失败的 URL 不再重试");
  store.endFrame();
  assert.equal(store.inspect().byState.error, 1);
});

test("ready() 兼容旧调用：已就绪返回图片对象，未就绪返回 null", () => {
  const imgs = [];
  const store = createAvatarStore({ concurrency: 2, maxActive: 10, createImage: () => { const i = { src: "", onload: null, onerror: null }; imgs.push(i); return i; } });
  store.beginFrame();
  assert.equal(store.ready("x"), null, "还在加载时应返回 null");
  imgs[0].onload();
  assert.equal(store.ready("x"), imgs[0], "加载完成后返回图片对象");
  store.endFrame();
});
