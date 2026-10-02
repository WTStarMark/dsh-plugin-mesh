/**
 * DSH 一致性测试。
 *
 * 分工：
 *   - **结构**（圆角 / 字族 / 层模型）仍取自本机 DSH 主题令牌，这里继续守着；
 *   - **配色**改由 src/palettes.js 驱动（清爽 / 粉黛 两套），因此不再断言具体的 DSH 中性色。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readDshTokens, DSH_ROOT } from "../tools/dsh-tokens.mjs";
import { themeOf } from "../src/palettes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(await readFile(resolve(ROOT, "data/dsh-tokens.json"), "utf8"));
const css = await readFile(resolve(ROOT, "styles.css"), "utf8");
const graph = await readFile(resolve(ROOT, "src/graph.js"), "utf8");

const dark = (key) => snapshot.key[key]?.dark;

test("令牌快照覆盖结构相关的关键项", () => {
  for (const key of ["--dsw-radius-sm", "--dsw-radius-md", "--dsw-radius-lg", "--dsw-font-family", "--dsw-alias-bg-base", "--dsw-alias-state-warn-primary"]) {
    assert.ok(snapshot.key[key], "快照缺少 " + key);
    assert.ok(snapshot.key[key].dark, key + " 缺少暗色值");
  }
});

test("圆角与字族仍逐项等于 DSH 令牌（结构对齐）", () => {
  assert.equal(dark("--dsw-radius-md"), "12px");
  assert.ok(css.includes("--r-sm: " + dark("--dsw-radius-sm")), "控件圆角应等于 DSH radius-sm");
  assert.ok(css.includes("--r-md: " + dark("--dsw-radius-md")), "卡片圆角应等于 DSH radius-md");
  assert.ok(css.includes("--r-lg: " + dark("--dsw-radius-lg")), "大圆角应等于 DSH radius-lg");
  const font = dark("--dsw-font-family");
  for (const family of ["-apple-system", "BlinkMacSystemFont", "PingFang SC", "Microsoft YaHei"]) {
    assert.ok(font.includes(family), "DSH 字族应含 " + family);
    assert.ok(css.includes(family), "styles.css 字族应含 " + family);
  }
});

test("配色改由 palettes.js 驱动：样式表兜底 = 默认主题，且不再硬编码旧中性色", () => {
  const t = themeOf("fresh", "light");
  for (const [key, value] of Object.entries(t.vars)) {
    if (key === "--shadow") continue;
    assert.ok(css.includes(key + ": " + value), "styles.css 缺少默认主题值 " + key + ": " + value);
  }
  assert.ok(!css.includes("#151517"), "不应再硬编码旧的 DSH 中性底色");
  assert.ok(!css.includes("#232324"), "不应再硬编码旧的 DSH 卡片面");
});

test("画布不再自带写死的主题表，改用注入的主题", () => {
  assert.ok(graph.includes("setTheme"), "画布应支持注入主题");
  assert.ok(!/#151517|#f9fafb/i.test(graph), "画布不应再写死 DSH 中性色");
  assert.ok(graph.includes("createAvatarStore"), "画布应接入头像加载器");
});

test("回归防线：不应残留上一版的霓虹/扫描线视觉", () => {
  assert.ok(!/conic-gradient/.test(css), "不应再有雷达扫掠");
  assert.ok(!/repeating-linear-gradient/.test(css), "不应再有扫描线");
  assert.ok(!/#5ee7ff/i.test(css), "不应再有霓虹青 #5ee7ff");
});

test("与本机安装的 DSH 主题一致（防止 DSH 升级后静默漂移）", { skip: !existsSync(resolve(DSH_ROOT, "node_modules/.pnpm")) }, () => {
  const live = readDshTokens();
  if (live === null) return;
  for (const key of Object.keys(snapshot.key)) {
    const liveValue = live.dark[key] ?? live.light[key];
    const snapValue = snapshot.key[key].dark ?? snapshot.key[key].light;
    assert.equal(liveValue ?? null, snapValue ?? null, key + " 与本机 DSH 现值不一致，请重跑 node tools/dsh-tokens.mjs");
  }
  assert.equal(live.pkg, snapshot.source.themePackage, "DSH 主题包版本已变化，请重跑 node tools/dsh-tokens.mjs");
});
