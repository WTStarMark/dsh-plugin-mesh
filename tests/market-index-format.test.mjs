/**
 * 市场索引的两处格式约束（都是被 DSH 侧行为逼出来的，不是审美）：
 *  1. 描述开头的人气前缀只放数字 —— DSH 的发现页把 description 当检索字段，中文词会被分词切进
 *     **每个**插件的检索词里（实测「周下载」会让搜「下载」命中全部 6589 个插件）。
 *  2. 版本条目不写 engines —— DSH 校验器对它是 optional(...) ?? {}，缺失自动补空对象，写上是纯体积。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toneOf, versionEntries } from "../tools/market-index.mjs";

test("人气前缀只放两个数字，不放中文词", () => {
  assert.equal(toneOf(6786, true, 160042), "★6.8k · 160k");
  assert.equal(toneOf(196, true, 70473), "★196 · 70k");
  assert.equal(toneOf(9999999, true, 1200000), "★10M · 1.2M");
});

test("拿不到下载量时写「—」，不写 0（0 会被当成真实数字读）", () => {
  assert.equal(toneOf(12, false, 0), "★12 · —");
  assert.equal(toneOf(0, false, undefined), "★0 · —");
});

test("前缀里不许出现任何汉字：这是检索污染的唯一防线", () => {
  const samples = [toneOf(1, true, 1), toneOf(999999, false, 0), toneOf(0, true, 0)];
  for (const s of samples) {
    // 用 Script=Han 而不是 scx=Han：U+00B7「·」的 Script_Extensions 里也含 Han，scx 会把它误判成汉字
    assert.ok(!/\p{Script=Han}/u.test(s), "前缀出现汉字会被 DSH 的分词切进检索字段：" + s);
  }
});

test("版本条目不写 engines：与 DSH 校验器补出来的空对象等价", () => {
  const out = versionEntries([{ version: "1.66.35", ts: 1792228258 }]);
  assert.deepEqual(out, [{ version: "1.66.35", publishTimestamp: 1792228258, source: { type: "npm" } }]);
  assert.ok(!("engines" in out[0]), "engines 缺失时 DSH 自己补 {}，写上是纯体积");
  assert.deepEqual(versionEntries([]), []);
});
