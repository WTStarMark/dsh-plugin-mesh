/**
 * 只读查询 API 与卡片的测试。
 * 既测引擎（纯函数/查询逻辑），也起一个真实服务测 HTTP 层（状态码、CORS、缓存、转义）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, categoryColor, xmlEscape, validNamePart, apiIndex, MAX_LIMIT, textWidth, wrapText, DEFAULT_SITE, DAY_TZ_OFFSET_HOURS, dayOf } from "../tools/api.mjs";
import { skipUnless, hasFreshPushes } from "./helpers/dataset.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = createApi({ root: ROOT });

test("分类总览：扇区与细枝计数自洽", async () => {
  const cats = await api.categories();
  assert.ok(cats.sectors.length >= 5, "应有多个扇区");
  const sum = cats.sectors.reduce((n, s) => n + s.count, 0);
  assert.equal(sum, cats.total, "扇区计数之和必须等于节点总数");
  for (const s of cats.sectors) {
    const subSum = s.subcategories.reduce((n, x) => n + x.count, 0);
    assert.ok(subSum <= s.count, "细枝计数不能超过所属扇区：" + s.id);
  }
});

test("紧凑检索：README 正文命中也能搜到，并如实区分（v0.4.6）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-api-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  const node = (id, description) => ({
    id,
    name: id.split("/")[1],
    owner: id.split("/")[0],
    stars: 5,
    description,
    topics: ["dsh-plugin"],
    matchedTags: ["dsh-plugin"],
    category: "tools",
    categoryLabel: "工具命令",
  });
  await writeFile(
    join(tmp, "data", "mesh.json"),
    JSON.stringify({ nodes: [node("u/plain", "普通仓库，描述里没有那个词"), node("u/readme-only", "描述里也没有")], edges: [], clusters: [], meta: {} }),
  );
  await writeFile(
    join(tmp, "data", "cache", "readmes.json"),
    JSON.stringify({ count: 1, docs: { "u/readme-only": { t: "这里写着 zzz-unique-token 的用法", f: "2026-10-04T00:00:00Z" } } }),
  );
  const local = createApi({ root: tmp });

  const byReadme = await local.searchIds(new URLSearchParams("q=zzz-unique-token"));
  assert.deepEqual(byReadme.ids, ["u/readme-only"], "README 正文命中应能搜到");
  assert.equal(byReadme.readme.total, 1, "应如实标记为 README 命中");
  assert.equal(byReadme.readme.indexed, 1, "应回传已索引篇数");

  const byField = await local.searchIds(new URLSearchParams("q=plain"));
  assert.ok(byField.ids.includes("u/plain"), "本地字段命中照常");
  assert.equal(byField.readme.total, 0, "不是 README 命中的不该混进来");

  const repos = await local.search(new URLSearchParams("q=zzz-unique-token"));
  assert.equal(repos.total, 1, "/api/repos 也要能按 README 正文搜到");
  assert.equal(repos.readme.total, 1);

  const empty = await local.searchIds(new URLSearchParams("q="));
  assert.deepEqual(empty.ids, [], "空查询不返回结果");
  await rm(tmp, { recursive: true, force: true });
});

test("紧凑检索：采集器写的 gzip 索引（readmes.json.gz）也能读（v0.4.6 主路径）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-api-gz-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  await writeFile(
    join(tmp, "data", "mesh.json"),
    JSON.stringify({
      nodes: [{ id: "u/only-readme", name: "only-readme", owner: "u", stars: 3, description: "描述里没有", topics: ["dsh-plugin"], matchedTags: ["dsh-plugin"], category: "tools", categoryLabel: "工具命令" }],
      edges: [],
      clusters: [],
      meta: {},
    }),
  );
  const payload = { count: 1, docs: { "u/only-readme": { t: "摘要里写着 zzz-gz-token", f: "2026-10-04T00:00:00Z" } } };
  await writeFile(join(tmp, "data", "cache", "readmes.json.gz"), gzipSync(Buffer.from(JSON.stringify(payload))));
  const local = createApi({ root: tmp });
  const hit = await local.searchIds(new URLSearchParams("q=zzz-gz-token"));
  assert.deepEqual(hit.ids, ["u/only-readme"], "gzip 索引应能直接读");
  assert.equal(hit.readme.indexed, 1);
  await rm(tmp, { recursive: true, force: true });
});

test("状态接口：采集器状态文件存在时透出进度，缺失时降级为 null（v0.4.7）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-status-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  await writeFile(
    join(tmp, "data", "mesh.json"),
    JSON.stringify({ nodes: [{ id: "u/a", name: "a", owner: "u", stars: 1, description: "", topics: [], matchedTags: [], category: "tools", categoryLabel: "工具命令" }], edges: [], clusters: [], meta: { generatedAt: "2026-10-04T10:00:00Z" } }),
  );
  const local = createApi({ root: tmp });

  const before = await local.status();
  assert.equal(before.status, null, "没有状态文件时 status 应为 null（本地静态预览）");
  assert.equal(before.data.nodes, 1, "顺手带回数据概况");
  assert.ok(Date.parse(before.serverTime) > 0, "必须给服务器时间，前端用它校正倒计时");

  await writeFile(
    join(tmp, "data", "cache", "status.json"),
    JSON.stringify({ state: "crawling", roundSeconds: 3600, nextRunAt: "2026-10-04T14:00:00Z", segments: { total: 313, done: 282 } }),
  );
  const after = await local.status();
  assert.equal(after.status.state, "crawling");
  assert.equal(after.status.roundSeconds, 3600);
  assert.equal(after.status.segments.done, 282);
  await rm(tmp, { recursive: true, force: true });
});

test("检索：过滤、排序、分页都真的生效（从数据自身推导，不写死数字）", async () => {
  const all = await api.search(new URLSearchParams("limit=5&fields=all"));
  assert.equal(all.items.length, 5, "应返回 5 条");
  assert.ok(all.total > 5, "总数应大于一页");
  const stars = all.items.map((n) => n.stars);
  assert.deepEqual(stars, [...stars].sort((a, b) => b - a), "默认按星标降序");

  const cats = await api.categories();
  const sector = cats.sectors[0];
  const only = await api.search(new URLSearchParams("category=" + sector.id + "&limit=100&fields=all"));
  assert.equal(only.total, sector.count, "按扇区过滤的命中数应与总览一致");
  assert.ok(only.items.every((n) => n.category === sector.id), "过滤后每条都应属于该扇区");

  const page1 = await api.search(new URLSearchParams("limit=3&offset=0&sort=stars"));
  const page2 = await api.search(new URLSearchParams("limit=3&offset=3&sort=stars"));
  assert.notEqual(page1.items[0].id, page2.items[0].id, "翻页应换一批");
  assert.equal(page2.offset, 3);

  const capped = await api.search(new URLSearchParams("limit=9999"));
  assert.equal(capped.limit, MAX_LIMIT, "limit 必须被夹到上限");
  assert.ok(capped.count <= MAX_LIMIT);
});

test("榜单：周更新榜按更新次数排序，star 榜给真实增量与真实窗口（不写死数字）", async (t) => {
  // 样例数据是 2026-10-01 取的，会随时间过期；窗口内没有推送时周更新榜必然为空
  if (skipUnless(t, hasFreshPushes, "当前数据集最近 7 天没有推送（样本已过期），周更新榜必然是空的")) return;
  const out = await api.ranking(new URLSearchParams("limit=5"));
  assert.equal(out.windowDays, 7, "默认窗口 7 天");
  assert.ok(out.generatedAt, "应带数据快照时间");
  assert.equal(typeof out.dataAgeHours, "number", "应如实报告数据新旧");
  assert.ok(out.now && out.history, "应报告服务器时间与星标历史点");

  // 周更新热榜：窗口内、按【更新次数】排序、次数相同才比最近推送，排除归档与复刻
  const updated = out.boards.updated;
  assert.ok(updated.items.length > 0, "应有最近推送过的仓库");
  const counts = updated.items.map((n) => n.updates);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), "周更新热榜必须按更新次数排序（这是它的关键指标）");
  assert.ok(counts.every((u) => Number.isInteger(u) && u >= 1), "窗口内确实推送过的仓库至少算 1 次，实际 " + counts.join(","));
  assert.ok(counts[0] <= (updated.maxUpdates ?? 1), "榜首次数应与 maxUpdates 一致");
  // 排序链随口径走：按发版判定时比"最新版本日期"，采样口径才比"最近推送"
  if (updated.metric === "releases") {
    const latest = updated.items.map((n) => String(n.latestReleaseAt ?? ""));
    for (let i = 1; i < updated.items.length; i++) {
      if (counts[i] === counts[i - 1]) assert.ok(latest[i] <= latest[i - 1], "版本数相同时应按最新版本日期降序");
    }
    assert.ok(updated.items.every((n) => (n.series ?? []).some((v) => v !== null)), "按发版判定时逐日柱来自发布日期，不该全空");
  } else {
    const times = updated.items.map((n) => Date.parse(n.pushedAt));
    for (let i = 1; i < updated.items.length; i++) {
      if (counts[i] === counts[i - 1]) assert.ok(times[i] <= times[i - 1], "次数相同时应按最近推送降序");
    }
  }
  assert.ok(
    ["releases", "update-log", "epoch-pair", "current-only"].includes(updated.updatesSource),
    "必须说明次数是怎么观测来的（releases = 按发版，其余是 pushedAt 采样），实际 " + updated.updatesSource,
  );
  assert.ok((updated.note ?? "").length > 0, "必须写明采样口径");

  // 口径自洽：次数 = 采样到的推进次数（1 是下限，不是加数），且等于逐日趋势柱的加总
  if (updated.updatesSource === "update-log") {
    // 有采样推进的行：次数 = 采样次数（1 是下限不是加数），且等于逐日柱加总
    for (const n of updated.items.filter((x) => (x.observedAdvances ?? 0) > 0)) {
      assert.equal(n.updates, n.observedAdvances, "次数应等于采样到的推进次数（不能再 +1）：" + n.id);
      const bars = (n.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
      assert.equal(bars, n.observedAdvances, "逐日趋势柱的加总必须等于采样次数（同一次推送不能算两遍）：" + n.id);
    }
    // 一次推进都没采样到的行（例：刚建索引时"首见不计数"）：按下限记 1
    for (const n of updated.items.filter((x) => (x.observedAdvances ?? 0) === 0)) {
      assert.equal(n.updates, 1, "没采样到推进时按下限记 1：" + n.id);
      const bars = (n.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
      assert.equal(bars, 0, "没有推进就不该有柱子：" + n.id);
    }
  }
  const since = Date.parse(out.now) - out.windowDays * 86400000;
  if (updated.metric === "releases") {
    const floorDay = new Date(since).toISOString().slice(0, 10);
    assert.ok(
      updated.items.every((n) => String(n.latestReleaseAt ?? "") >= floorDay),
      "按发版判定时，最新版本日期必须落在窗口内",
    );
  } else {
    assert.ok(updated.items.every((n) => Date.parse(n.pushedAt) >= since), "每条都要落在窗口内");
  }
  assert.ok(updated.total >= updated.items.length, "总数不小于一页");
  assert.ok(updated.items.every((n) => n.id && n.name && typeof n.stars === "number"), "行字段要齐");

  // 周 star 热榜：有历史就给真增量 + 真窗口；没有就如实说明，绝不编数字
  const stars = out.boards.stars;
  if (stars.available) {
    assert.ok(stars.window && stars.window.days > 0, "必须给出真实窗口");
    assert.ok(stars.window.days <= 8, "窗口不该超过 8 天，实际 " + stars.window.days);
    assert.equal(stars.window.target, 7, "窗口目标应写出来");
    assert.ok(stars.items.length > 0, "应有涨星的仓库");
    const deltas = stars.items.map((n) => n.delta);
    assert.deepEqual(deltas, [...deltas].sort((a, b) => b - a), "必须按增量降序");
    assert.ok(deltas.every((d) => d > 0), "榜上只能有正增长");
    assert.ok(deltas[0] <= stars.items[0].starsAfter, "增量不可能超过它当前的星标数（下限是 0 星）");
    for (const item of stars.items) {
      assert.equal(item.starsAfter - item.starsBefore, item.delta, "增量必须等于两端观测之差");
      assert.ok(item.starsAfter >= item.starsBefore);
    }
    assert.ok(stars.matched > 0, "应报告两端可比的仓库数");
  } else {
    assert.equal(stars.items.length, 0, "算不出增量就不该给任何行");
    assert.ok((stars.note ?? "").length > 0, "必须说明为什么算不出来");
  }

  // 逐日趋势柱：横轴近 7 天，每行 7 个槽位；槽位只能是 null（没观测）或非负数
  assert.equal(out.seriesDays.length, 7, "趋势柱横轴应为近 7 天");
  assert.deepEqual(out.seriesDays, [...out.seriesDays].sort(), "横轴必须按时间升序");
  assert.match(out.seriesDays[6], /^\d{4}-\d{2}-\d{2}$/, "横轴是日期");

  for (const item of updated.items) {
    assert.equal(item.series.length, 7, "每行都要有 7 个槽位：" + item.id);
    assert.ok(item.series.every((v) => v === null || (Number.isFinite(v) && v >= 0)), "槽位只能是 null 或非负数");
  }
  if (updated.updatesSource === "releases") {
    // 按发版判定：逐日柱来自"发布日期"，窗口内的天数就该非 0
    assert.ok(updated.seriesDays > 0, "按发版判定时应有窗口天数，实际 " + updated.seriesDays);
  } else if (updated.updatesSource !== "update-log") {
    assert.equal(updated.seriesDays, 0, "没有按天采样时应报告 0 天");
    assert.ok(updated.items.every((it) => it.series.every((v) => v === null)), "没有按天采样时绝不许编柱子");
  }
  if (stars.available) {
    assert.equal(stars.items[0].series.length, 7, "star 榜每行也要有 7 个槽位");
    assert.ok(Array.isArray(stars.items[0].spans), "每行都要带跨天累计段（可以是空数组）");
    if (stars.spanCount > 0) {
      const row = stars.items.find((it) => it.spans.length > 0);
      assert.ok(row, "报告有跨天段时，至少一行要带得上");
      const seg = row.spans[0];
      assert.ok(seg.toIdx > seg.fromIdx, "跨天段必须覆盖多于一个槽位");
      assert.ok(seg.days > 1 && seg.value > 0, "跨天段要有跨度天数与正增量，实际 " + JSON.stringify(seg));
      assert.match(seg.from, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(seg.to, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(seg.toIdx <= out.seriesDays.length - 1, "跨天段不能超出横轴");
    }
  }

  const capped = await api.ranking(new URLSearchParams("limit=9999"));
  assert.ok(capped.limit <= 50, "榜单 limit 应被夹住，实际 " + capped.limit);
});

test("榜单行带版本列表：读采集器抓的 data/cache/releases.json（并按发版判定周更新）", async () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rel-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1) },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [{ id: "a/one", name: "one", owner: "a", stars: 5, pushedAt: hoursAgo(2), archived: false, fork: false, matchedTags: ["dsh"], topics: [] }],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "releases.json"),
      JSON.stringify({
        updatedAt: hoursAgo(0.2),
        keep: 5,
        // 日期用相对时间造：写死日期过一周就掉出窗口，测试会变定时炸弹
        repos: {
          "a/one": {
            at: hoursAgo(0.2),
            releases: [
              { tag: "v1.2.3", name: "1.2.3", at: daysAgo(3), pre: false },
              { tag: "v1.2.4-rc.1", name: "rc", at: daysAgo(2), pre: true },
              { tag: "v1.2.0", name: "1.2.0", at: daysAgo(40), pre: false }, // 窗口外的老版本：不该计数
            ],
          },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=5"));
    assert.equal(out.releases.cached, 1, "要报告版本缓存规模");
    const row = out.boards.updated.items[0];
    assert.equal(row.releases.length, 3, "行里要带完整的版本列表（含窗口外的老版本）");
    assert.equal(row.releases[0].tag, "v1.2.3");
    assert.equal(row.releases[1].pre, true, "预发布标记要透传");
    assert.ok(Array.isArray(out.boards.stars.items?.[0]?.releases ?? []), "没有版本数据时给空数组，不是 undefined");

    // 周更新热榜改用 releases 判定"本周有更新"：计数 = 窗口内真实发布的版本数（不是采样下界）
    const board = out.boards.updated;
    assert.equal(board.metric, "releases", "有 releases 数据时按发版判定，实际 " + board.metric);
    assert.equal(board.updatesSource, "releases");
    assert.equal(board.total, 1, "只有 1 个仓库本周发过版");
    assert.equal(board.maxUpdates, 2, "计数 = 窗口内的版本数（窗口外那 2 个老版本不算）");
    assert.equal(row.updates, 2, "行里的次数就是发版数");
    assert.equal(row.latestReleaseAt, daysAgo(2), "要带上本周最新那个版本的日期");
    const bars = (row.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
    assert.equal(bars, 2, "逐日柱加总 = 本周发版数（用发布日期算，真实计数）");
    assert.match(board.note, /release/, "口径要写清是按 release 判定：" + board.note);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("周更新热榜：窗口与横轴对齐（最左那天的版本必须被画出来）", async () => {
  // 复现过的线上 bug：窗口按"现在往前 7x24 小时"（起点比横轴早一天），
  // 于是最早那天的版本被算进总数却不画柱子（实测第 5 行 12 个版本 vs 柱子和 6）。
  const shift = (day, delta) => new Date(Date.parse(day + "T00:00:00Z") + delta * 86400000).toISOString().slice(0, 10);
  const localDay = new Date(Date.now() + DAY_TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
  const axisFirst = shift(localDay, -6);
  const nowIso = new Date().toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-align-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [{ id: "a/one", name: "one", owner: "a", stars: 5, pushedAt: nowIso, archived: false, fork: false, matchedTags: ["dsh"], topics: [] }],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "releases.json"),
      JSON.stringify({
        updatedAt: nowIso,
        keep: 20,
        repos: {
          "a/one": {
            at: nowIso,
            releases: [
              { tag: "v4", name: "", at: shift(axisFirst, -1), pre: false },
              { tag: "v3", name: "", at: axisFirst, pre: false },
              { tag: "v2", name: "", at: shift(axisFirst, 3), pre: false },
            ],
          },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=5"));
    const board = out.boards.updated;
    assert.equal(out.seriesDays[0], axisFirst, "横轴起点 = 数据快照当天往前 6 天（当地日）");
    assert.equal(board.seriesDays, 7, "横轴 7 个当地日");
    const row = board.items[0];
    assert.equal(row.updates, 2, "只算横轴覆盖的那两天：横轴之前那个不算，实际 " + row.updates);
    const bars = (row.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
    assert.equal(bars, row.updates, "总数必须等于逐日柱加总（窗口与横轴同一组日历日）");
    assert.equal(row.series[0], 1, "最左那天的版本要画出来，不能被漏掉：" + JSON.stringify(row.series));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("dayOf：坏时间戳不许抛异常（曾经让 /api/ranking 挂死 30 秒）", () => {
  assert.equal(dayOf(1759886400000), "2025-10-08", "毫秒数要能吃");
  assert.equal(dayOf("2026-10-06T23:08:14Z"), "2026-10-07", "ISO 串按当地日界换算");
  assert.equal(dayOf("2026-10-07T15:59:59Z"), "2026-10-07");
  assert.equal(dayOf("2026-10-07T16:00:00Z"), "2026-10-08", "北京 00:00 换日");
  for (const bad of [null, undefined, "", "坏数据", NaN, Infinity]) {
    assert.equal(dayOf(bad), "", "解析不了就返回空串，绝不能抛：" + String(bad));
  }
});

test("star 历史里有坏时间点也不许把榜单接口带崩", async () => {
  // 线上事故：obs[].at 已经是毫秒数，dayOf 又 Date.parse 一遍得到 NaN，toISOString 抛 RangeError，
  // 而接口层没有兜底 → /api/ranking 挂满 30 秒、前端一直转圈。
  const nowIso = new Date().toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-badstar-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [{ id: "a/one", name: "one", owner: "a", stars: 9, pushedAt: nowIso, archived: false, fork: false, matchedTags: ["dsh"], topics: [] }],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "star-history.json"),
      JSON.stringify({
        updatedAt: nowIso,
        points: [
          { at: null, day: null, stars: { "a/one": 1 } },
          { at: "不是时间", day: "x", stars: { "a/one": 2 } },
          { at: new Date(Date.now() - 51 * 3600000).toISOString(), day: null, stars: { "a/one": 3 } },
        ],
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=3"));
    assert.ok(out.boards.stars, "榜单要正常返回，而不是抛异常挂住请求");
    assert.equal(out.seriesDays.length, 7);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("每日界限：接口与采集器用同一个时区偏移（北京时间 00:00 换日）", async () => {
  const py = await readFile(resolve(ROOT, "backend", "dsh_mesh", "config.py"), "utf8");
  const found = /DAY_TZ_OFFSET_HOURS\s*=\s*(-?\d+)/.exec(py);
  assert.ok(found, "config.py 里应有 DAY_TZ_OFFSET_HOURS");
  assert.equal(DAY_TZ_OFFSET_HOURS, Number(found[1]), "接口与采集器的每日界限必须一致，否则按天的桶会对不上");
  assert.equal(DAY_TZ_OFFSET_HOURS, 8, "默认按北京时间 00:00 换日");

  // 横轴末位 = 数据快照那天的"当地日期"，不是 UTC 日期
  const out = await api.ranking(new URLSearchParams("limit=1"));
  const localDay = new Date(Date.parse(out.generatedAt) + DAY_TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
  assert.equal(out.seriesDays[out.seriesDays.length - 1], localDay, "横轴末位应是快照当天的当地日期：" + out.generatedAt);
});

test("周更新热榜排序：次数相同时，越近推送的排越前（次数 → 最近推送 → 星标）", async () => {
  // 用相对时间造夹具，别写死日期（否则过一周就掉出 7 天窗口，测试变成定时炸弹）
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const node = (id, stars, pushedAt) => ({ id, name: id.split("/")[1], owner: id.split("/")[0], stars, pushedAt, archived: false, fork: false, matchedTags: ["dsh"], topics: [] });
  const t1 = hoursAgo(1); // 同一时刻推的两个仓库：用来验证"同时刻再比星标"
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rank-"));
  try {
    await mkdir(join(tmp, "data"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1), indexedNodes: 5 },
        tags: [],
        clusters: [],
        hubs: [],
        edges: [],
        nodes: [
          node("a/two-hours", 1, hoursAgo(2)),
          node("a/one-hour", 5, t1),
          node("a/three-hours", 999, hoursAgo(3)), // 星标最高，但推送最旧
          node("a/same-time-hi", 500, t1), // 与 a/one-hour 同一时刻 → 比星标
          node("a/stale", 10, hoursAgo(24 * 20)),
        ],
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=10"));
    assert.deepEqual(
      out.boards.updated.items.map((n) => n.id),
      ["a/same-time-hi", "a/one-hour", "a/two-hours", "a/three-hours"],
      "次数都是 1：先按最近推送降序（1 小时前的排在 2 小时前的前面），同一时刻再比星标；星标再高也不能插到更近的前面",
    );
    assert.equal(out.boards.updated.total, 4, "20 天前推送的不该进 7 天窗口");
    assert.ok(out.boards.updated.items.every((n) => n.updates === 1), "没有按天日志时次数按 1 计");
    assert.equal(out.boards.updated.seriesDays, 0, "没有按天日志时不该报告有逐日数据");
    assert.ok(out.boards.updated.items.every((n) => n.series.every((v) => v === null)), "没有按天日志时序列必须是 null");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("单仓库详情：连线两端都指向它，计数与列表一致", async () => {
  const found = await api.search(new URLSearchParams("limit=1&sort=stars"));
  const id = found.items[0].id;
  const [owner, name] = id.split("/");
  const one = await api.one(owner, name);
  assert.ok(one, "应能查到星标最高的仓库");
  assert.equal(one.repo.id, id);
  assert.equal(one.repo.url, "https://github.com/" + id);
  const counts = Object.values(one.linkCounts).reduce((a, b) => a + b, 0);
  assert.equal(counts, one.links.length, "连线计数应与列表长度一致");
  assert.ok(one.links.every((l) => l.id !== id), "不应出现自环");
});

test("v0.4.2 单仓库详情：同作者连线是完整关系（不受数据层星形拓扑省略影响）", async (t) => {
  const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
  const byOwner = new Map();
  for (const n of mesh.nodes ?? []) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  // 成员超过 8 的作者：数据层只写星形拓扑，正是"有的连得全、有的只连一个"的那批
  const [owner, list] = [...byOwner.entries()].filter(([, g]) => g.length > 8).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (!owner) {
    t.skip("当前数据里没有成员 > 8 的作者（限扫数据集），跳过这项");
    return;
  }

  const target = list[0];
  const one = await api.one(owner, target.name);
  assert.ok(one, "应能查到 " + target.id);
  const ownerLinks = one.links.filter((l) => l.type === "owner");
  assert.equal(ownerLinks.length, list.length - 1, owner + " 的同作者连线应为 " + (list.length - 1) + " 条");
  assert.equal(one.linkCounts.owner, ownerLinks.length, "同作者计数应与列表一致");
  assert.ok(ownerLinks.every((l) => l.id !== target.id), "同作者连线不应指向自己");
  assert.ok(ownerLinks.every((l) => l.id.startsWith(owner + "/")), "同作者连线必须同属一个作者");
});

test("卡片：合法 SVG、含关键信息、转义正确", async () => {
  const found = await api.search(new URLSearchParams("limit=1&sort=stars"));
  const [owner, name] = found.items[0].id.split("/");
  const svg = await api.cardSvg(owner, name, {});
  assert.ok(svg.startsWith("<svg"), "应以 <svg 开头");
  assert.ok(svg.trimEnd().endsWith("</svg>"), "应以 </svg> 结尾");
  assert.match(svg, /width="420" height="168"/);
  // 卡片必须带去处：默认线上站点，且整张卡片可点（直接打开或 <object> 嵌入时生效）
  assert.ok(svg.includes(DEFAULT_SITE), "卡片应包含默认去处 " + DEFAULT_SITE);
  assert.ok(svg.includes("<a "), "卡片应包在链接里");
  assert.ok(svg.includes('target="_blank"'));
  const custom = await api.cardSvg(owner, name, { site: "https://example.com/" });
  assert.ok(custom.includes("https://example.com/"), "自定义去处应生效");
  // 语言色点 / 相对时间 / 图标
  assert.ok(svg.includes("#f1e05a") || svg.includes("#3178c6"), "应画出该语言的颜色点");
  assert.match(svg, /更新于 /, "应有相对时间");
  assert.ok((svg.match(/<path d="/g) || []).length >= 2, "应包含仓库图标与星标图标");
  // 三个链接：背景→站点、仓库名→GitHub、底部→站点
  const hrefs = [...svg.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 3, "应有三个链接，实际 " + hrefs.length);
  assert.ok(hrefs.includes("https://github.com/" + found.items[0].id), "仓库名应指向 GitHub 原仓库");
  assert.equal(hrefs.filter((h) => h === DEFAULT_SITE).length, 2, "背景与底部都应指向站点");
  assert.ok(svg.includes(found.items[0].id.split("/")[1]), "卡片应含仓库名");
  assert.ok(!/<script/i.test(svg), "卡片不得包含脚本");

  // 默认就是 GitHub 深色；显式 light 才走浅色令牌
  assert.ok(svg.includes("#0d1117"), "默认应为 GitHub 深色底 #0d1117");
  assert.ok(svg.includes("#58a6ff"), "深色用 GitHub 深色链接色");
  const light = await api.cardSvg(owner, name, { theme: "light" });
  assert.ok(light.includes("#d0d7de"), "浅色应使用 GitHub 浅色边框令牌");
  assert.notEqual(light, svg, "两套主题应不同");
  assert.ok(svg.includes('class="bg"'), "卡片应有可点的背景矩形");

  // 不存在的仓库返回 null（由 HTTP 层转成 404 占位卡片）
  assert.equal(await api.cardSvg("no-such-owner", "no-such-repo-xyz"), null);

  // 转义：名称里的尖括号/引号必须被转义，不能破坏 XML
  assert.equal(xmlEscape('<a & "b">'), "&lt;a &amp; &quot;b&quot;&gt;");

  // 描述必须换行显示，而不是被切掉半句
  const longDesc = wrapText("DSH 通用皮肤框架：可视化自定义 + 实时预览 + 「皮肤管理」，可以随心设计你的专属皮肤，并通过分发皮肤包和你的小伙伴们分享", 12.5, 428, 2);
  assert.equal(longDesc.length, 2, "长描述应排成两行，实际 " + longDesc.length);
  assert.ok(longDesc.every((l) => textWidth(l, 12.5) <= 428), "每行都不得超出可用宽度");
  assert.ok(!longDesc[1].endsWith("…"), "恰好两行放得下时不应加省略号");
  assert.ok(!longDesc[0].endsWith("…"), "第一行不应带省略号");
  // 确实放不下时才省略（用同一段文字重复三倍构造超长输入）
  const tooLong = wrapText(new Array(4).join("DSH 通用皮肤框架：可视化自定义 + 实时预览 + 「皮肤管理」，可以随心设计你的专属皮肤。"), 12.5, 428, 2);
  assert.equal(tooLong.length, 2, "再长也只排两行");
  assert.match(tooLong[1], /…$/, "放不下时最后一行应以省略号收尾");
  assert.ok(tooLong.every((l) => textWidth(l, 12.5) <= 428), "省略后仍不得超宽");
  const shortDesc = wrapText("简短描述", 12.5, 428, 2);
  assert.deepEqual(shortDesc, ["简短描述"], "短描述应只有一行且不加省略号");

  // 版式：卡片宽 480，任何一行文字（含锚点）都不得超出边界
  const segments = (svgText) => {
    const out = [];
    const re = /<text x="(\d+(?:\.\d+)?)" y="[\d.]+"(?:[^>]*?)font-size="([\d.]+)"(?:[^>]*?)text-anchor="end"[^>]*>([^<]*)<\/text>|<text x="(\d+(?:\.\d+)?)" y="[\d.]+"(?:[^>]*?)font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(svgText))) {
      if (m[1]) out.push({ x: Number(m[1]) - textWidth(m[3], Number(m[2])), size: Number(m[2]), text: m[3] });
      else out.push({ x: Number(m[4]), size: Number(m[5]), text: m[6] });
    }
    return out;
  };
  const rows = segments(svg);
  assert.ok(rows.length >= 5, "卡片应有若干文本行，实际 " + rows.length);
  for (const row of rows) {
    const w = textWidth(row.text, row.size);
    assert.ok(row.x >= 0 && row.x + w <= 420, "文字超出卡片：" + JSON.stringify(row.text) + " 从 " + row.x.toFixed(0) + " 宽 " + w.toFixed(0));
  }

  // 长中文描述也不能溢出（曾经按 62 字裁剪，12.5px 下约 775px）
  const cjk = await api.search(new URLSearchParams("limit=1&fields=all"));
  const cjkId = cjk.items[0].id.split("/");
  const cjkSvg = await api.cardSvg(cjkId[0], cjkId[1], {});
  for (const row of segments(cjkSvg)) {
    assert.ok(row.x + textWidth(row.text, row.size) <= 420, "真实数据的卡片文字超出边界：" + row.text);
  }
});

test("颜色与名称校验：稳定、可预期", () => {
  assert.equal(categoryColor("agent"), categoryColor("agent"), "同一分类颜色必须稳定");
  assert.notEqual(categoryColor("agent"), categoryColor("model"), "不同分类颜色应不同");
  assert.match(categoryColor("x"), /^#[0-9a-f]{6}$/);
  assert.ok(validNamePart("deepseek-ai") && validNamePart("a.b_c-1"));
  assert.ok(!validNamePart("../etc"), "路径穿越必须被拒");
  assert.ok(!validNamePart("a b") && !validNamePart("") && !validNamePart("a".repeat(101)));
});

test("API 自描述：端点清单完整", () => {
  const index = apiIndex("0.5.0");
  assert.equal(index.version, "0.5.0");
  const paths = index.endpoints.map((e) => e.path).join(" ");
  for (const need of ["/api/health", "/api/categories", "/api/repos", "/api/ranking", "/api/card", "/card/"]) {
    assert.ok(paths.includes(need), "清单应包含 " + need);
  }
});

// ---------- HTTP 层 ----------
let child;
let base;

before(async () => {
  const port = 18000 + Math.floor(Math.random() * 900);
  base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, [resolve(ROOT, "tools/serve.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("服务未能在 6 秒内启动");
});

after(() => {
  if (child) child.kill();
});

test("HTTP：端点可用、类型正确、带 CORS 与缓存头", async () => {
  const health = await fetch(base + "/api/health");
  assert.equal(health.status, 200);
  const data = await health.json();
  assert.equal(data.ok, true);
  assert.ok(data.nodes > 0, "应报告节点数");
  assert.equal(health.headers.get("access-control-allow-origin"), "*", "只读公开接口应允许跨域");
  assert.match(health.headers.get("cache-control") ?? "", /max-age=300/);

  const index = await fetch(base + "/api");
  assert.equal(index.status, 200, "/api 应可用（不能被静态白名单挡成 403）");
  assert.ok((await index.json()).endpoints.length > 0);

  const cats = await fetch(base + "/api/categories");
  assert.equal(cats.status, 200);
  assert.ok((await cats.json()).sectors.length > 0);

  const rankingRes = await fetch(base + "/api/ranking?limit=3");
  assert.equal(rankingRes.status, 200, "榜单接口应可用");
  const ranking = await rankingRes.json();
  assert.ok(typeof ranking.boards.updated.updatesSource === "string", "要带次数来源");
  // 榜单行数依赖"窗口内有没有推送"：样本过期时为空，不为空时必须自洽
  if (hasFreshPushes) {
    assert.ok(ranking.boards?.updated?.items?.length > 0, "HTTP 也要能拿到周更新榜");
    assert.ok(ranking.boards.updated.items[0].updates >= 1, "HTTP 返回的行也要带更新次数");
  }
  assert.ok(ranking.boards?.stars, "HTTP 也要能拿到 star 榜");
  assert.equal(rankingRes.headers.get("access-control-allow-origin"), "*");
  assert.match(rankingRes.headers.get("cache-control") ?? "", /max-age=300/);

  const list = await fetch(base + "/api/repos?limit=2");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 2);
});

test("HTTP：卡片是 SVG，分享页是 HTML，错误码正确", async () => {
  const list = await (await fetch(base + "/api/repos?limit=1")).json();
  const id = list.items[0].id;

  const svg = await fetch(base + "/api/card/" + id + ".svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.ok((await svg.text()).includes("<svg"));

  const dark = await fetch(base + "/api/card/" + id + ".svg?theme=dark");
  assert.equal(dark.status, 200);

  // ?link= 只在 http/https 下生效，非法值回落到默认站点（挡 javascript: 之类）
  const custom = await (await fetch(base + "/api/card/" + id + ".svg?link=https://example.com/page")).text();
  assert.ok(custom.includes("https://example.com/"), "合法 link 应生效");
  const evil = await (await fetch(base + "/api/card/" + id + ".svg?link=javascript:alert(1)")).text();
  assert.ok(!/javascript:/i.test(evil), "非法 link 必须被丢弃");
  assert.ok(evil.includes("104.129.51.126"), "非法 link 应回落到默认站点");

  const page = await fetch(base + "/card/" + id);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.includes("/api/card/" + id + ".svg"), "分享页应给出嵌入地址");
  assert.ok(html.includes("Markdown"), "分享页应给出 Markdown 片段");

  assert.equal((await fetch(base + "/api/repos/no-such/repo-xyz")).status, 404);
  assert.equal((await fetch(base + "/api/repos/a%20b/c")).status, 400);
  assert.equal((await fetch(base + "/card/no-such/repo-xyz")).status, 404);
  const missing = await fetch(base + "/api/card/no-such/repo-xyz.svg");
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /image\/svg\+xml/, "卡片缺失也应回一张占位 SVG");
});

test("HTTP：写方法被拒，预检请求被放行", async () => {
  const post = await fetch(base + "/api/repos", { method: "POST" });
  assert.ok(post.status === 405 || post.status === 403, "写方法必须被拒，实际 " + post.status);
  const opt = await fetch(base + "/api/repos", { method: "OPTIONS" });
  assert.equal(opt.status, 204, "预检应被放行");
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
});
