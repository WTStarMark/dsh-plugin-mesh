/**
 * 市场索引的两处格式约束（都是被 DSH 侧行为逼出来的，不是审美）：
 *  1. 描述开头的人气前缀只放数字 —— DSH 的发现页把 description 当检索字段，中文词会被分词切进
 *     **每个**插件的检索词里（实测「周下载」会让搜「下载」命中全部 6589 个插件）。
 *  2. 版本条目不写 engines —— DSH 校验器对它是 optional(...) ?? {}，缺失自动补空对象，写上是纯体积。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toneOf, versionEntries, collectCandidates, keywordsOf, isFreshRelease, seededRandom, shuffled, MIN_STARS_FOR_BADGE, FRESH_RELEASE_DAYS, resolveOwner, auditOwnership, OWNER_EVIDENCE } from "../tools/market-index.mjs";

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

test("默认顺序：洗牌只换位置不丢条目，同一个 seed 可复现", () => {
  const list = Array.from({ length: 80 }, (_, i) => "p" + i);
  const a = shuffled(list, seededRandom(12345));
  const b = shuffled(list, seededRandom(12345));
  assert.deepEqual(a, b, "同一个 seed 必须复现同一次洗牌，否则线上顺序无从追溯");
  assert.deepEqual(a.slice().sort(), list.slice().sort(), "洗牌不能丢条目也不能造条目");
  assert.notDeepEqual(a, list, "80 个条目洗牌后仍与原地顺序相同的概率可以忽略");
  assert.deepEqual(list, Array.from({ length: 80 }, (_, i) => "p" + i), "不能改原数组");
  assert.notDeepEqual(a, shuffled(list, seededRandom(67890)), "不同 seed 应给出不同顺序");
  assert.deepEqual(shuffled([]), [], "空表不能炸");
  assert.deepEqual(shuffled(["only"]), ["only"], "单条就是它自己");
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

/* ---------------------------------------------------------------------------
 * 归属判定：这条线钉的是线上真实事故 —— 6644 行索引里 263 行挂的仓库与 npm 包
 * 自己声明的仓库冲突（222 行是完全不同的作者）。旧写法是
 *   matched ?? claimants.sort(compareRank)[0]
 * 筛不出来就按复刻/星标/下载量/仓库名排序挑一个顶上，等于把猜测当事实输出。
 * 现在的规矩：只有"两边一致 = 确证"和"明说无据 = 待确认"两种状态。
 * ------------------------------------------------------------------------- */
const claimant = (id, opts = {}) => ({
  repoId: id,
  node: { id, owner: id.split("/")[0], htmlUrl: opts.htmlUrl ?? "https://github.com/" + id, stars: opts.stars ?? 0 },
  pkg: "pkg",
  downloads: 5,
  hasDownloads: true,
});

test("归属：npm 声明的仓库就是声明者之一 → 确证", () => {
  const claimants = [claimant("yxxbc/dsh-balance-plugin"), claimant("luokai-demo/dsh-plugins")];
  const r = resolveOwner({ npmRepo: "git+https://github.com/luokai-demo/dsh-plugins.git", claimants });
  assert.equal(r.evidence, OWNER_EVIDENCE.DECLARED_IN_CLAIMANTS);
  assert.equal(r.verified, true, "两边一致才算确证");
  assert.equal(r.owner, "luokai-demo");
  assert.equal(r.node.id, "luokai-demo/dsh-plugins");
});

test("归属：大小写不影响匹配（repoKey 一律小写）", () => {
  const claimants = [claimant("Blank-not-black/dsh-Remote", { htmlUrl: "https://github.com/Blank-not-black/dsh-Remote" })];
  const r = resolveOwner({ npmRepo: "git+https://github.com/blank-not-black/dsh-remote.git", claimants });
  assert.equal(r.verified, true, "GitHub 的 owner/repo 大小写不敏感，不能因为大小写就判成不一致");
  assert.equal(r.node.id, "Blank-not-black/dsh-Remote");
});

test("归属：npm 声明的仓库在图里、但它没声明这个包名 → 用它，但标待确认", () => {
  const meshById = new Map([["blank-not-black/dsh-remote", { id: "Blank-not-black/dsh-Remote", owner: "Blank-not-black", htmlUrl: "https://github.com/Blank-not-black/dsh-Remote" }]]);
  const claimants = [claimant("Blank-not-black/dsh-remote-plugin")];
  const r = resolveOwner({ npmRepo: "git+https://github.com/Blank-not-black/dsh-remote.git", claimants, meshById });
  assert.equal(r.evidence, OWNER_EVIDENCE.DECLARED_IN_MESH);
  assert.equal(r.verified, false, "单边证据不能算确证");
  assert.equal(r.node.id, "Blank-not-black/dsh-Remote", "要拿回真主那份完整画像（头像/分类/星标）");
});

test("归属：npm 没写 repository、只有唯一声明者 → 用它，但标待确认", () => {
  const r = resolveOwner({ npmRepo: null, claimants: [claimant("only/one")] });
  assert.equal(r.evidence, OWNER_EVIDENCE.SOLE_CLAIMANT);
  assert.equal(r.verified, false);
  assert.equal(r.owner, "only");
});

test("回归 dsh-video-studio：npm 声明的仓库已死、两个仓库抢同一个包名 → 谁都不挑，署发布者自己的名", () => {
  // 真实数据：npm 上 dsh-video-studio 的 repository 指向 litao36253（仓库已 404），
  // 而生态图里 jonah791 和 lakeofsky347 都写了同一个包名。
  const claimants = [claimant("jonah791/dsh-video-studio"), claimant("lakeofsky347/dsh-video-studio")];
  const r = resolveOwner({ npmRepo: "git+https://github.com/litao36253/dsh-video-studio.git", claimants, meshById: new Map() });
  assert.equal(r.evidence, OWNER_EVIDENCE.DECLARED_ONLY);
  assert.equal(r.owner, "litao36253", "署名要给 npm 自己声明的发布者");
  assert.equal(r.verified, false);
  assert.notEqual(r.owner, "jonah791");
  assert.notEqual(r.owner, "lakeofsky347");
  assert.equal(r.node, null);
});

test("回归 dsh-plugin-store：真主改了仓库名 → 仍按 npm 声明的旧路径署名，不挑同名的路人", () => {
  // 真主 yunhuantian 把仓库改成了 dsh-plugin-hub，npm 上的旧包 dsh-plugin-store 还指着旧路径。
  const claimants = [claimant("0xKcyzz/dsh-plugin-store"), claimant("maoruoyu/dsh-plugin-store")];
  const r = resolveOwner({ npmRepo: "git+https://github.com/yunhuantian/dsh-plugin-store.git", claimants, meshById: new Map() });
  assert.equal(r.owner, "yunhuantian");
  assert.equal(r.verified, false, "旧路径没法在本地核实，只能标待确认");
  assert.notEqual(r.owner, "0xKcyzz", "旧写法按字母序会挑中 0xKcyzz —— 这是冒名，不是归属");
});

test("归属：npm 没写 repository 且多个仓库抢同一个包名 → 不署名（宁缺毋错）", () => {
  // 真实数据：dsh-schedule 有两个仓库声明，npm 元数据里没有 repository 字段。
  const r = resolveOwner({ npmRepo: null, claimants: [claimant("magicOF2/dsh-schedule"), claimant("Wang-Lin-Chang/dsh-schedule")] });
  assert.equal(r.evidence, OWNER_EVIDENCE.AMBIGUOUS);
  assert.equal(r.owner, null, "拿不到证据就不写作者名，绝不按人气挑一个");
  assert.equal(r.node, null);
  assert.equal(r.verified, false);
});

test("归属：空输入不炸", () => {
  assert.equal(resolveOwner({}).evidence, OWNER_EVIDENCE.AMBIGUOUS);
  assert.equal(resolveOwner({ npmRepo: "not a url", claimants: [] }).owner, null);
});

test("自检：与 npm 声明冲突却没标待确认的条目必须被抓出来", () => {
  const packages = { "pkg-a": { repository: "git+https://github.com/real/owner.git" } };
  const ok = [
    { name: "pkg-a", author: "real", repository: { url: "https://github.com/real/owner" }, metadata: { labels: [] } },
    { name: "pkg-a", author: "real", repository: { url: "https://github.com/real/owner" }, metadata: { labels: ["owner-unverified"] } },
  ];
  assert.deepEqual(auditOwnership(ok, packages), [], "一致、或标了待确认，都不算违规");

  const bad = [{ name: "pkg-a", author: "someone-else", repository: { url: "https://github.com/someone-else/fork" }, metadata: { labels: [] } }];
  const found = auditOwnership(bad, packages);
  assert.equal(found.length, 1, "挂错人又没标记，必须报出来");
  assert.equal(found[0].pkg, "pkg-a");

  const nameless = [{ name: "pkg-a", metadata: { labels: [] } }];
  assert.equal(auditOwnership(nameless, packages).length, 1, "没作者名又没标待确认，同样算违规");
  assert.equal(auditOwnership([], packages).length, 0);
});

