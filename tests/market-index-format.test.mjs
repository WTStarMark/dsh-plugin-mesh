/**
 * 市场索引的两处格式约束（都是被 DSH 侧行为逼出来的，不是审美）：
 *  1. 描述开头的人气前缀只放数字 —— DSH 的发现页把 description 当检索字段，中文词会被分词切进
 *     **每个**插件的检索词里（实测「周下载」会让搜「下载」命中全部 6589 个插件）。
 *  2. 版本条目不写 engines —— DSH 校验器对它是 optional(...) ?? {}，缺失自动补空对象，写上是纯体积。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toneOf, versionEntries, collectCandidates, keywordsOf, isFreshRelease, MIN_STARS_FOR_BADGE, FRESH_RELEASE_DAYS } from "../tools/market-index.mjs";

test("人气前缀只放两个数字，不放中文词", () => {
  assert.equal(toneOf(6786, true, 160042), "★6.8k · 160k");
  assert.equal(toneOf(196, true, 70473), "★196 · 70k");
  assert.equal(toneOf(9999999, true, 1200000), "★10M · 1.2M");
});

test("星标不足阈值就不写 ★：别在卡片第一行写「没人气」", () => {
  assert.equal(toneOf(MIN_STARS_FOR_BADGE - 1, true, 31000), "31k", "9 星只写下载量");
  assert.equal(toneOf(0, true, 2000), "2k", "0 星不写 ★0");
  assert.equal(toneOf(0, false, 0), "—");
  assert.equal(toneOf(MIN_STARS_FOR_BADGE, true, 2000), "★10 · 2k", "到阈值就写 ★");
});

test("关键词兜底：没打 topic 的条目也要能被搜到（核心词 + 包名分词）", () => {
  assert.deepEqual(keywordsOf({ topics: ["memory", "dsh-plugin"] }, "x"), ["memory", "dsh-plugin"], "有 topic 就用 topic");
  const out = keywordsOf({ topics: [] }, "@scope/dsh-auto-memory");
  assert.deepEqual(out.slice(0, 3), ["deepseek-harness", "dsh", "dsh-plugin"], "空 topic 要补核心词");
  assert.ok(out.includes("dsh") && out.includes("auto") && out.includes("memory"), "包名里的功能词也要带上：" + out.join(","));
  assert.ok(!out.includes("scope"), "去掉 scope 段");
  assert.ok(keywordsOf({ topics: [] }, "dsh").length <= 12, "别超 12 个");
});

test("「近 7 天有新版」只看最新发布时间，拿不到时间就不打标", () => {
  const now = 1_800_000_000;
  assert.equal(isFreshRelease([{ ts: now - 3600 }], now), true, "一小时前发版 → 算新");
  assert.equal(isFreshRelease([{ ts: now - (FRESH_RELEASE_DAYS + 1) * 86400 }], now), false, "超过 7 天 → 不算");
  assert.equal(isFreshRelease([{ ts: now - 30 * 86400 }, { ts: now - 3600 }], now), true, "取最新那个版本算");
  assert.equal(isFreshRelease([{ ts: 0 }], now), false, "没有时间戳 → 不打标，别猜");
  assert.equal(isFreshRelease([], now), false);
  assert.equal(isFreshRelease(undefined, now), false);
});

test("拿不到下载量时写「—」，不写 0（0 会被当成真实数字读）", () => {
  assert.equal(toneOf(12, false, 0), "★12 · —");
  // 0 星又不写 ★（见上一条规则）：此时前缀只剩那个「—」
  assert.equal(toneOf(0, false, undefined), "—");
});

test("前缀里不许出现任何汉字：这是检索污染的唯一防线", () => {
  const samples = [toneOf(1, true, 1), toneOf(999999, false, 0), toneOf(0, true, 0)];
  for (const s of samples) {
    // 用 Script=Han 而不是 scx=Han：U+00B7「·」的 Script_Extensions 里也含 Han，scx 会把它误判成汉字
    assert.ok(!/\p{Script=Han}/u.test(s), "前缀出现汉字会被 DSH 的分词切进检索字段：" + s);
  }
});

test("候选并集：仓库根包 + 子目录包都要进，归档/未拿到下载量的不进", () => {
  const byId = new Map([
    ["a/root", { id: "a/root", archived: false }],
    ["volcengine/OpenViking", { id: "volcengine/OpenViking", archived: false }],
    ["a/archived", { id: "a/archived", archived: true }],
  ]);
  const downloads = {
    repos: {
      "a/root": { status: "ok", package: "root-pkg", downloads: 10 },
      "a/archived": { status: "ok", package: "old-pkg", downloads: 3 },
      "a/pending": { status: "unknown", package: "nope" },
    },
  };
  const extra = {
    packages: {
      "@openviking/dsh-memory-plugin": { status: "ok", repoId: "volcengine/OpenViking", downloads: 7 },
      "failed-pkg": { status: "error", repoId: "volcengine/OpenViking" },
      "orphan-pkg": { status: "ok", repoId: "who/knows", downloads: 1 },
    },
  };
  const out = collectCandidates(downloads, extra, byId);
  assert.deepEqual(
    out.map((c) => [c.pkg, !!c.subdir, c.downloads]),
    [
      ["root-pkg", false, 10],
      ["@openviking/dsh-memory-plugin", true, 7],
    ],
    "归档仓库、未知状态、图外仓库都不能进；子目录包要带 subdir 标记",
  );
  assert.deepEqual(collectCandidates(downloads, null, byId).map((c) => c.pkg), ["root-pkg"], "缺 npm-packages.json 也要能跑");
  assert.deepEqual(collectCandidates(null, extra, byId).map((c) => c.pkg), ["@openviking/dsh-memory-plugin"], "缺 npm-downloads.json 同理");
});

test("版本条目不写 engines：与 DSH 校验器补出来的空对象等价", () => {
  const out = versionEntries([{ version: "1.66.35", ts: 1792228258 }]);
  assert.deepEqual(out, [{ version: "1.66.35", publishTimestamp: 1792228258, source: { type: "npm" } }]);
  assert.ok(!("engines" in out[0]), "engines 缺失时 DSH 自己补 {}，写上是纯体积");
  assert.deepEqual(versionEntries([]), []);
});
