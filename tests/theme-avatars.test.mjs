import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PALETTES, PALETTE_IDS, themeOf } from "../src/palettes.js";
import { createAvatarStore } from "../src/avatars.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = await readFile(resolve(ROOT, "styles.css"), "utf8");

test("两套配色 × 明暗两式，变量齐备且合法", () => {
  assert.deepEqual(PALETTE_IDS.sort(), ["fresh", "rouge"]);
  const required = ["--bg-base", "--bg-layer-1", "--bg-layer-2", "--sidebar", "--border-l1", "--border-l2", "--label-1", "--label-2", "--label-3", "--accent", "--accent-soft", "--warn", "--hover", "--active", "--shadow"];
  for (const id of PALETTE_IDS) {
    for (const mode of ["light", "dark"]) {
      const theme = themeOf(id, mode);
      for (const key of required) {
        assert.ok(theme.vars[key], id + "/" + mode + " 缺少 CSS 变量 " + key);
      }
      assert.ok(theme.groups.length >= 19, id + "/" + mode + " 扇区色要够 19 个分类用，实际 " + theme.groups.length);
      for (const c of theme.groups) assert.match(c, /^#[0-9a-f]{6}$/i, "扇区色必须是 6 位 hex: " + c);
      assert.match(theme.canvas.bg, /^#[0-9a-f]{6}$/i);
    }
  }
});

test("清爽 = 蓝白：底色接近白，主色与扇区色都是蓝", () => {
  const t = themeOf("fresh", "light");
  const blue = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return b > r + 30 && b >= g; // 蓝通道显著高于红
  };
  const whites = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) > 700; // 很亮
  };
  assert.ok(whites(t.vars["--bg-base"]), "清爽底色应是蓝白，实际 " + t.vars["--bg-base"]);
  assert.ok(blue(t.vars["--accent"]), "清爽主色应是蓝");
  const blueCount = t.groups.filter(blue).length;
  assert.ok(blueCount >= 10, "清爽的扇区色应绝大多数是蓝，实际 " + blueCount + "/12");
});

test("粉黛 = 粉色系：主色与扇区色都偏粉", () => {
  const t = themeOf("rouge", "light");
  const pink = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return r > g + 20 && r >= b - 60 && b > g; // 红显著高于绿
  };
  assert.ok(pink(t.vars["--accent"]), "粉黛主色应偏粉，实际 " + t.vars["--accent"]);
  const pinkCount = t.groups.filter(pink).length;
  assert.ok(pinkCount >= 10, "粉黛的扇区色应绝大多数偏粉，实际 " + pinkCount + "/12");
});

test("styles.css 的兜底默认值与默认主题一致（避免首屏闪色）", () => {
  const t = themeOf("fresh", "light");
  for (const [key, value] of Object.entries(t.vars)) {
    if (key === "--shadow") continue;
    assert.ok(css.includes(key + ": " + value), "styles.css 缺少默认值 " + key + ": " + value);
  }
});

// ---------------- 头像加载器 ----------------
function fakeImages() {
  const created = [];
  const factory = () => {
    const img = { onload: null, onerror: null, src: "", complete: false };
    created.push(img);
    return img;
  };
  return { created, factory };
}

test("头像：同一 URL 只创建一张图片，且就绪前返回 null", () => {
  const { created, factory } = fakeImages();
  const store = createAvatarStore({ createImage: factory, concurrency: 2 });
  assert.equal(store.ready("https://x/a.png"), null);
  assert.equal(store.ready("https://x/a.png"), null);
  assert.equal(created.length, 1, "同一 URL 不应重复创建图片");
  created[0].onload();
  assert.equal(store.ready("https://x/a.png"), created[0], "加载完成后应返回图片对象");
  assert.equal(store.stats.loaded, 1);
});

test("头像：并发不超过上限，加载完自动补位", () => {
  const { created, factory } = fakeImages();
  const store = createAvatarStore({ createImage: factory, concurrency: 2 });
  for (let i = 0; i < 5; i++) store.ready("https://x/" + i + ".png");
  assert.equal(created.length, 2, "并发上限应为 2，实际 " + created.length);
  created[0].onload();
  assert.equal(created.length, 3, "完成一个应补位一个");
  assert.equal(store.stats.active <= 2, true);
});

test("头像：加载失败不重试、不卡住队列", () => {
  const { created, factory } = fakeImages();
  let reloads = 0;
  const store = createAvatarStore({ createImage: () => { reloads += 1; return factory(); }, concurrency: 1 });
  store.ready("https://x/bad.png");
  created[0].onerror();
  store.ready("https://x/bad.png"); // 失败后再问不应重新入队
  assert.equal(reloads, 1, "失败的 URL 不应重试");
  assert.equal(store.stats.failed, 1);
  store.ready("https://x/good.png");
  assert.equal(reloads, 2, "队列不应被失败项卡住");
});
