/**
 * 只读查询 API 与卡片的测试。
 * 既测引擎（纯函数/查询逻辑），也起一个真实服务测 HTTP 层（状态码、CORS、缓存、转义）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync, brotliDecompressSync } from "node:zlib";
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

test("紧凑检索：计数不被 limit 截断（truncated 标记真实命中数）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-api-trunc-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  const nodes = Array.from({ length: 5 }, (_, i) => ({
    id: "u/alpha-" + i,
    name: "alpha-" + i,
    owner: "u",
    stars: 5,
    description: "alpha 仓库",
    topics: ["dsh-plugin"],
    matchedTags: ["dsh-plugin"],
    category: "tools",
    categoryLabel: "工具命令",
  }));
  await writeFile(join(tmp, "data", "mesh.json"), JSON.stringify({ nodes, edges: [], clusters: [], meta: {} }));
  const local = createApi({ root: tmp });
  const hit = await local.searchIds(new URLSearchParams("q=alpha&limit=2"));
  assert.equal(hit.total, 5, "total 必须是真实命中数，不能被 limit 截成 2");
  assert.equal(hit.ids.length, 2, "id 列表仍按 limit 截断");
  assert.equal(hit.truncated, true, "被截断时要如实标记");
  const full = await local.searchIds(new URLSearchParams("q=alpha&limit=10"));
  assert.equal(full.truncated, false);
  assert.equal(full.ids.length, 5);
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

  const big = await api.ranking(new URLSearchParams("limit=200"));
  assert.equal(big.limit, 50, "榜单行数上限固定 50：请求更大也夹到 50");
  assert.ok((big.boards?.updated?.items ?? []).length <= 50, "周更新热榜最多 50 行");
  assert.ok((big.boards?.stars?.items ?? []).length <= 50, "周 star 热榜最多 50 行");

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

test("榜单行带 npm 周下载量：读 data/cache/npm-downloads.json；缺省/损坏 → unknown，不写 0", async () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const tmp = await mkdtemp(join(tmpdir(), "mesh-npm-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1) },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [
          { id: "a/ok", name: "ok", owner: "a", stars: 5, pushedAt: hoursAgo(2), archived: false, fork: false, matchedTags: ["dsh"], topics: [] },
          { id: "a/miss", name: "miss", owner: "a", stars: 4, pushedAt: hoursAgo(2), archived: false, fork: false, matchedTags: ["dsh"], topics: [] },
        ],
      }),
    );
    // 用 releases 把两行送进周更新热榜（否则没历史时 stars 板也可能是空的）
    await writeFile(
      join(tmp, "data", "cache", "releases.json"),
      JSON.stringify({
        updatedAt: hoursAgo(0.2),
        keep: 5,
        repos: {
          "a/ok": { at: hoursAgo(0.2), releases: [{ tag: "v1", name: "", at: daysAgo(1), pre: false }] },
          "a/miss": { at: hoursAgo(0.2), releases: [{ tag: "v1", name: "", at: daysAgo(1), pre: false }] },
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: hoursAgo(0.2),
        repos: {
          "a/ok": {
            status: "ok",
            package: "dshmarket",
            downloads: 112438,
            window: { start: "2026-10-03", end: "2026-10-09" },
            multiPackage: false,
          },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=5"));
    assert.equal(out.npm.cached, 1);
    assert.equal(out.npm.withDownloads, 1);
    const items = out.boards.updated.items;
    const anyOk = items.find((r) => r.id === "a/ok");
    const anyMiss = items.find((r) => r.id === "a/miss");
    assert.ok(anyOk, "周更新热榜要带上 a/ok");
    assert.equal(anyOk.npm.status, "ok");
    assert.equal(anyOk.npm.downloads, 112438);
    assert.deepEqual(anyOk.npm.window, { start: "2026-10-03", end: "2026-10-09" });
    assert.ok(anyMiss);
    assert.equal(anyMiss.npm.status, "unknown", "缓存没有的行是未知");
    assert.equal(anyMiss.npm.downloads, null, "缺失不能当 0");

    // 损坏文件：整表降级，接口不崩
    await writeFile(join(tmp, "data", "cache", "npm-downloads.json"), "不是 json");
    const broken = createApi({ root: tmp });
    const out2 = await broken.ranking(new URLSearchParams("limit=5"));
    const again = out2.boards.updated.items[0];
    assert.equal(again.npm.status, "unknown");
    assert.equal(again.npm.downloads, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("npm 榜：只收确实是 DSH 组合包的包，同名只留一行，官方内部模块不进榜", async () => {
  // 线上实据（2026-10-17）：不加这三道门槛时，榜首 14 行里 12 行是 @deepseek-ai/* 官方内部包
  // 被第三方仓库"复制 package.json"顶名（dsh-client-locale 挂在 AlexKaiqi 名下），
  // 还有通用 npm 包撞名进榜（platform，920 万周下载）；同一个包还被多个仓库重复占行（dshmarket 5 行）。
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-npmboard-"));
  const node = (id, stars) => ({
    id,
    name: id.split("/")[1],
    owner: id.split("/")[0],
    stars,
    htmlUrl: "https://github.com/" + id,
    pushedAt: hoursAgo(2),
    archived: false,
    fork: false,
    matchedTags: ["dsh"],
    topics: [],
  });
  const dl = (pkg, downloads) => ({
    status: "ok",
    package: pkg,
    downloads,
    window: { start: "2026-10-06", end: "2026-10-12" },
    multiPackage: false,
  });
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1) },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [node("a/real", 10), node("b/copy", 999), node("c/plain", 5000), node("d/official", 1)],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        repos: {
          "a/real": dl("real-plugin", 500),
          "b/copy": dl("real-plugin", 500),
          "c/plain": dl("platform", 9244162),
          "d/official": dl("@deepseek-ai/dsh", 376103),
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-registry.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        packages: {
          "real-plugin": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "https://github.com/a/real" },
          platform: { isBundle: false, dshKeys: [], repository: null },
          "@deepseek-ai/dsh": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: null },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const board = (await local.ranking(new URLSearchParams("limit=10"))).boards.npm;
    assert.equal(
      board.total,
      1,
      "只有 real-plugin 该进榜，实际进了：" + board.items.map((r) => r.npmPackage).join(","),
    );
    assert.equal(board.items[0].npmPackage, "real-plugin");
    assert.equal(board.items[0].id, "a/real", "门面要取 npm 包 repository 声明的仓库，而不是星标更高的顶名仓库");
    assert.equal(board.coverage.skippedOfficial, 1, "官方内部模块要挡掉");
    assert.equal(board.coverage.skippedNotBundle, 1, "撞名的通用包要挡掉");
    assert.equal(board.coverage.mergedClaimants, 1, "同名认领要合并成一行");
    assert.ok(board.note.includes("挡掉"), "口径要写进 note：" + board.note);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("npm 光环名单：只收确认有包（status=ok）的仓库，并带上反查发现的子目录包", async () => {
  const nowIso = new Date().toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-npmnodes-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({ meta: { generatedAt: nowIso }, tags: [], clusters: [], hubs: [], edges: [], nodes: [] }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: nowIso,
        repos: {
          "a/ok": { status: "ok", package: "pkg-a", downloads: 3 },
          "b/none": { status: "no-package", package: null },
          "c/err": { status: "error", package: "pkg-c" },
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-packages.json"),
      JSON.stringify({
        updatedAt: nowIso,
        packages: {
          "@openviking/dsh-memory-plugin": { status: "ok", repoId: "volcengine/OpenViking", downloads: 6601 },
          "bad-pkg": { status: "error", repoId: "x/y" },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.npmNodes();
    assert.deepEqual(out.ids, ["a/ok", "volcengine/OpenViking"], "no-package / error 都不算「有包」");
    assert.deepEqual(out.subdirIds, ["volcengine/OpenViking"], "子目录包要单独列出来");
    assert.equal(out.count, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("npm 榜并进子目录包：仓库根没有 package.json 也能上榜，并标出它在仓库里的目录", async () => {
  // 真实案例：volcengine/OpenViking 根目录没有 package.json（缓存里是 no-package），
  // 官方插件住在 examples/dsh-memory-plugin —— 靠 npm 反查发现的那批就走这条并集路径。
  const nowIso = new Date().toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-subdir-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [{
          id: "volcengine/OpenViking", name: "OpenViking", owner: "volcengine", stars: 40186,
          htmlUrl: "https://github.com/volcengine/OpenViking", pushedAt: nowIso,
          archived: false, fork: false, matchedTags: ["dsh-plugin"], topics: [],
        }],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({ updatedAt: nowIso, repos: { "volcengine/OpenViking": { status: "no-package", package: null, downloads: null } } }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-packages.json"),
      JSON.stringify({
        updatedAt: nowIso,
        packages: {
          "@openviking/dsh-memory-plugin": {
            package: "@openviking/dsh-memory-plugin", repoId: "volcengine/OpenViking", repoKey: "volcengine/openviking",
            status: "ok", downloads: 1234, window: { start: "2026-10-06", end: "2026-10-12" },
            days: [{ day: "2026-10-06", downloads: 1234 }], at: nowIso,
          },
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-registry.json"),
      JSON.stringify({
        updatedAt: nowIso,
        packages: {
          "@openviking/dsh-memory-plugin": {
            isBundle: true, dshKeys: ["@deepseek-ai/dsh-llm"],
            repository: "https://github.com/volcengine/OpenViking",
            repositoryDirectory: "examples/dsh-memory-plugin",
          },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const board = (await local.ranking(new URLSearchParams("limit=10"))).boards.npm;
    assert.equal(board.total, 1, "子目录包应该成一行");
    assert.equal(board.items[0].npmPackage, "@openviking/dsh-memory-plugin");
    assert.equal(board.items[0].id, "volcengine/OpenViking", "行属于它所在的那个仓库节点");
    assert.equal(board.items[0].npmSubdir, true, "要标出这是子目录包");
    assert.equal(board.items[0].npmDir, "examples/dsh-memory-plugin", "要能指到仓库里的目录");
    assert.equal(board.coverage.subdirPackages, 1);
    assert.ok(board.note.includes("子目录包"), "口径要写进 note：" + board.note);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("npm 榜：每行用自己的窗口对齐逐日柱（缓存窗口不一致时不许整排画成「没观测」）", async () => {
  // 线上实测（2026-10-28）：缓存里各行刷新进度不同，榜级横轴被榜外长尾的众数窗口劫持，
  // 前 50 行里 49 行日期对不上 → series 全 null → 界面整排只画虚线底座（看起来"没有柱状图"）。
  // 口径：每行必须带自己的 seriesAxis，series 与该行缓存里的逐日数组逐日对齐、加总 == downloads。
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-npmaxis-"));
  const node = (id) => ({
    id, name: id.split("/")[1], owner: id.split("/")[0], stars: 1,
    htmlUrl: "https://github.com/" + id, pushedAt: hoursAgo(2),
    archived: false, fork: false, matchedTags: ["dsh"], topics: [],
  });
  const week = (start) => {
    const day = (i) => new Date(Date.parse(start + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
    return [0, 1, 2, 3, 4, 5, 6].map((i) => ({ day: day(i), downloads: 10 + i }));
  };
  const entry = (pkg, days) => ({
    status: "ok", package: pkg,
    downloads: days.reduce((s, d) => s + d.downloads, 0),
    window: { start: days[0].day, end: days[days.length - 1].day },
    days, multiPackage: false,
  });
  const nowDays = week("2026-10-20");
  const oldDays = week("2026-10-12");
  const juneDays = week("2026-06-25");
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1) },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [node("a/now"), node("b/old"), node("c/june")],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        repos: {
          "a/now": entry("pkg-now", nowDays),
          "b/old": entry("pkg-old", oldDays),
          "c/june": entry("pkg-june", juneDays),
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-registry.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        packages: {
          "pkg-now": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "https://github.com/a/now" },
          "pkg-old": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "https://github.com/b/old" },
          "pkg-june": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "https://github.com/c/june" },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const board = (await local.ranking(new URLSearchParams("limit=10"))).boards.npm;
    assert.equal(board.total, 3);
    // 榜级代表窗口只取「榜面行」的众数，不再被榜外长尾劫持
    assert.deepEqual(board.seriesAxis, nowDays.map((d) => d.day), "榜级代表横轴 = 榜面行窗口：" + JSON.stringify(board.seriesAxis));
    const byId = new Map(board.items.map((r) => [r.id, r]));
    for (const id of ["a/now", "b/old", "c/june"]) {
      const row = byId.get(id);
      assert.ok(row, "三行都应上榜：" + id);
      assert.ok(Array.isArray(row.seriesAxis), "每行都要带自己的横轴：" + id);
      assert.equal(row.seriesAxis.length, 7, "行轴 7 天：" + id);
      assert.equal(row.seriesAxis[0], row.npmWindow.start, "行轴起点 = 该行窗口起点：" + id);
      assert.equal(row.seriesAxis[6], row.npmWindow.end, "行轴终点 = 该行窗口终点：" + id);
      assert.equal(
        row.series.reduce((s, v) => s + v, 0),
        row.downloads,
        "逐日柱加总必须等于行内下载量：" + id,
      );
      assert.ok(row.series.every((v) => typeof v === "number"), "有逐日缓存的行不许整排 null：" + id);
    }
    // 关键回归：6 月窗口那行不能因为榜级轴是别的月就变空，日期必须是自己那 7 天
    const june = byId.get("c/june");
    assert.equal(june.seriesAxis[0], "2026-06-25");
    assert.equal(june.series[0], 10);
    assert.equal(june.series[6], 16);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("npm 榜归属：以 npm 声明的 repository 为准，复制 package.json 的仓库不再顶名", async () => {
  // 线上实据（2026-10-28）：task-board 真实仓库 zhu1090093659/dsh-web（★9.7k，根包 private）不在 claimant 里，
  // 榜面就把三份 ★0 的复制件之一（cococomeon/damxin）顶成行主；BrowserSkill / dsh-orb 同理。
  // 口径：① 声明仓库在图里 → 直接归它（哪怕不是 claimant）；② 声明仓库不在图里但 npm 维护者与 claimant 的 owner 同名 → 弱校验；
  //       ③ 都判不了 → 保留一行但标 unverified，绝不静默当成真主人。
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const tmp = await mkdtemp(join(tmpdir(), "mesh-npmattr-"));
  const node = (id, stars) => ({
    id, name: id.split("/")[1], owner: id.split("/")[0], stars,
    htmlUrl: "https://github.com/" + id, pushedAt: hoursAgo(2),
    archived: false, fork: false, matchedTags: ["dsh"], topics: [],
  });
  const okEntry = (pkg, downloads) => ({
    status: "ok", package: pkg, downloads,
    window: { start: "2026-10-06", end: "2026-10-12" },
    days: [{ day: "2026-10-06", downloads }], multiPackage: false,
  });
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: hoursAgo(1) },
        tags: [], clusters: [], hubs: [], edges: [],
        nodes: [
          node("z/mono", 5000),        // 真仓库：根包 private，本身不是 claimant
          node("a/copy1", 1),          // 复制件 1（claimant）
          node("b/copy2", 0),          // 复制件 2（claimant）
          node("uowner/thing", 2),     // 无 repository 字段，靠 npmUser 弱校验
          node("x/unknown", 0),        // 声明仓库不在图里 → unverified
        ],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        repos: {
          "a/copy1": okEntry("pkg-real", 1000),
          "b/copy2": okEntry("pkg-real", 1000),
          "z/mono": { status: "private", package: null, downloads: null },
          "uowner/thing": okEntry("pkg-norepo", 500),
          "x/unknown": okEntry("pkg-lost", 300),
        },
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-registry.json"),
      JSON.stringify({
        updatedAt: hoursAgo(1),
        packages: {
          "pkg-real": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "git+https://github.com/z/mono.git", npmUser: "someone-else" },
          "pkg-norepo": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], npmUser: "uowner" },
          "pkg-lost": { isBundle: true, dshKeys: ["@deepseek-ai/cordis"], repository: "https://github.com/nowhere/other.git", npmUser: "someone-else" },
        },
      }),
    );
    const local = createApi({ root: tmp });
    const board = (await local.ranking(new URLSearchParams("limit=10"))).boards.npm;
    const byPkg = new Map(board.items.map((r) => [r.npmPackage, r]));

    const real = byPkg.get("pkg-real");
    assert.ok(real, "pkg-real 应上榜");
    assert.equal(real.id, "z/mono", "归属要落到 npm 声明的仓库，而不是 claimant 里的复制件：实际 " + real.id);
    assert.equal(real.stars, 5000, "行主是图里那个真仓库（★5000）");
    assert.equal(real.npmAttribution, "registry-repo");
    assert.equal(real.npmDeclaredRepo, "z/mono");
    assert.equal(real.downloads, 1000, "数字仍是这个 npm 包的真实下载量");
    assert.ok(Array.isArray(real.seriesAxis) && real.seriesAxis.length === 1, "逐日柱照常带行级横轴");

    const weak = byPkg.get("pkg-norepo");
    assert.equal(weak.id, "uowner/thing", "没有 repository 字段时，用 npm 维护者同名做弱校验");
    assert.equal(weak.npmAttribution, "npm-user");
    assert.equal(weak.npmDeclaredRepo, null);

    const lost = byPkg.get("pkg-lost");
    assert.ok(lost, "归属判不了也要保留一行数字，不能凭空清榜");
    assert.equal(lost.id, "x/unknown", "兜底仍是唯一 claimant，但必须标未核验");
    assert.equal(lost.npmAttribution, "unverified");
    assert.equal(lost.npmDeclaredRepo, "nowhere/other");
    assert.ok(board.items.some((r) => r.id !== "a/copy1" && r.id !== "b/copy2"), "复制件不再被静默顶名");

    assert.deepEqual(board.coverage.attribution, { registryRepo: 1, npmUser: 1, unverified: 1 }, "归属来源要如实统计");
    assert.equal(board.coverage.mergedClaimants, 1, "pkg-real 的两份复制认领仍要如实计数");
    assert.match(board.note, /registry|repository|归属/, "口径要写进 note：" + board.note);
    assert.match(board.note, /unverified/, "note 要写明兜底标记：" + board.note);
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

test("star 榜：逐日柱与窗口增量同源，Σ(逐日) + Σ(宽条) 必须等于行内增量", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-stardaily-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const anchor = dayOf(Date.parse(nowIso));
    const shift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const d0 = shift(anchor, -2);
    const d1 = shift(anchor, -1);
    const d2 = anchor;
    const node = (id, stars) => ({ id, name: id.split("/")[1], owner: id.split("/")[0], stars, archived: false, fork: false, matchedTags: ["dsh"], topics: [] });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({ meta: { generatedAt: nowIso }, nodes: [node("a/big", 200), node("a/gap", 400), node("a/down", 90)], edges: [], clusters: [] }),
    );
    await writeFile(
      join(tmp, "data", "cache", "star-daily.json"),
      JSON.stringify({
        updatedAt: nowIso,
        lastRound: { at: nowIso, day: d2, counted: 3, gained: 42, spans: 1, carried: 0, baseline: false },
        seen: { "a/big": 200, "a/gap": 400, "a/down": 90 },
        // d1 故意"有观测但没变化" => 必须画成 0（浅底座），不是 null（虚线底座）
        sampledDays: [d0, d1, d2],
        days: { [d0]: { "a/big": 30 }, [d2]: { "a/big": 12, "a/down": -5 } },
        spans: [{ from: d0, to: d2, hours: 71, d: { "a/gap": 295 } }],
        rounds: { [d0]: { first: nowIso, last: nowIso } },
      }),
    );
    const local = createApi({ root: tmp });
    const out = await local.ranking(new URLSearchParams("limit=10"));
    const board = out.boards.stars;

    assert.equal(board.seriesSource, "star-daily", "有台账就必须走台账，不许再退回星标环");
    assert.equal(board.available, true, "有台账就该出榜");
    assert.equal(board.coverage.from, d0, "覆盖起点 = 第一个真正观测到的日子");
    assert.equal(board.coverage.to, d2);
    assert.equal(board.coverage.days, 3);
    assert.equal(board.coverage.missing.length, out.seriesDays.length - 3, "其余天如实报成没观测");

    // 不变量：行内增量 === Σ(逐日柱) + Σ(宽条)。由构造保证，谁改口径先看这条。
    for (const it of board.items) {
      const bars = (it.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
      const spans = (it.spans ?? []).reduce((s, x) => s + x.value, 0);
      assert.equal(bars + spans, it.delta, "Σ逐日 + Σ宽条 必须等于行内增量：" + it.id);
    }

    const big = board.items.find((x) => x.id === "a/big");
    assert.ok(big, "a/big 应在榜上");
    assert.equal(big.delta, 42, "30（d0）+ 12（d2）");
    assert.deepEqual(big.series.slice(0, 4), [null, null, null, null], "台账之前的天是「没数据」，不是 0");
    assert.equal(big.series[out.seriesDays.indexOf(d0)], 30);
    assert.equal(big.series[out.seriesDays.indexOf(d1)], 0, "观测到但没变化 = 0，不是 null");
    assert.equal(big.series[out.seriesDays.indexOf(d2)], 12);

    const gap = board.items.find((x) => x.id === "a/gap");
    assert.equal(gap.delta, 295, "跨天涨幅只能走宽条");
    assert.equal(gap.series.filter((v) => typeof v === "number").reduce((s, v) => s + v, 0), 0, "宽条不许落到任何一天");
    assert.equal(gap.spans.length, 1);
    assert.equal(gap.spans[0].value, 295);
    assert.equal(gap.spans[0].from, d0);
    assert.equal(gap.spans[0].to, d2);

    for (const it of board.items) {
      assert.equal(it.starsAfter - it.starsBefore, it.delta, "增量必须等于两端观测之差（接口契约，旧路径同款）：" + it.id);
      assert.ok(it.starsAfter >= it.starsBefore, "只有正增长的仓库才进榜");
    }

    assert.equal(board.items.find((x) => x.id === "a/down"), undefined, "掉星（负增量）不进「热榜」，但已如实记在台账里");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("star 榜：台账为空时如实退回星标环，并在 note 里写明是降级口径", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-starring-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const shift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const older = shift(dayOf(Date.parse(nowIso)), -6);
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        nodes: [{ id: "a/one", name: "one", owner: "a", stars: 150, archived: false, fork: false, matchedTags: ["dsh"], topics: [] }],
        edges: [],
        clusters: [],
      }),
    );
    await writeFile(join(tmp, "data", "cache", "star-history.json"), JSON.stringify({ points: [{ at: older + "T02:00:00Z", stars: { "a/one": 100 } }] }));
    const local = createApi({ root: tmp });
    const board = (await local.ranking(new URLSearchParams("limit=5"))).boards.stars;
    assert.equal(board.seriesSource, "ring", "没有台账只能退回环");
    assert.equal(board.available, true);
    assert.equal(board.coverage, null, "环口径给不出覆盖度，如实为 null");
    assert.ok(board.note.includes("退回星标环"), "note 要写明这是降级口径：" + board.note);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("噪声维度：默认只标注不过滤，noise=hide|only 才过滤（/api/repos）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-noise-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const node = (id, stars, extra) => ({
      id, name: id.split("/")[1], owner: id.split("/")[0], stars,
      description: "一个通用项目", topics: ["dsh-plugin"], matchedTags: ["dsh-plugin"],
      category: "tools", categoryLabel: "工具命令", ...extra,
    });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: new Date().toISOString() },
        nodes: [
          node("big/borrowed", 9000, { verdict: "noise" }), // 蹭标签的通用大项目
          node("small/real", 10, { verdict: "related" }),
          node("mid/manual", 500, { verdict: "manual" }),
          node("old/legacy", 50, { review: true }), // 老数据：没有 verdict，只有 review
        ],
        edges: [], clusters: [], hubs: [], tags: [],
      }),
    );
    const local = createApi({ root: tmp });

    const all = await local.search(new URLSearchParams("sort=stars"));
    assert.equal(all.total, 4, "默认不过滤：噪声照常出现在结果里（只标注）");
    assert.equal(all.noise.filter, "all");
    assert.equal(all.noise.matched, 1, "要如实报出这批条件里有多少条噪声");
    assert.equal(all.items[0].id, "big/borrowed", "默认排序口径不变：星标高的仍然在前");
    assert.equal(all.items[0].verdict, "noise", "精简行也要带 verdict");
    assert.equal(all.items.find((n) => n.id === "old/legacy").verdict, "manual", "老数据靠 review 兜底");

    const hidden = await local.search(new URLSearchParams("noise=hide"));
    assert.equal(hidden.total, 3, "hide 只去掉已判定噪声");
    assert.ok(hidden.items.every((n) => n.verdict !== "noise"));
    assert.equal(hidden.noise.matched, 1, "被藏掉多少条要如实报出来");

    const only = await local.search(new URLSearchParams("noise=only"));
    assert.equal(only.total, 1);
    assert.equal(only.items[0].id, "big/borrowed");
    assert.equal(only.noise.filter, "only");

    const junk = await local.search(new URLSearchParams("noise=whatever"));
    assert.equal(junk.total, 4, "未知取值回落到默认：不过滤");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("噪声维度：榜单行带 verdict，noise=hide 时已判定噪声不再进榜", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rank-noise-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const anchor = dayOf(Date.parse(nowIso));
    const d0 = new Date(Date.parse(anchor + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    const node = (id, stars, verdict) => ({
      id, name: id.split("/")[1], owner: id.split("/")[0], stars,
      archived: false, fork: false, matchedTags: ["dsh"], topics: [], verdict,
    });
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({ meta: { generatedAt: nowIso }, nodes: [node("a/noisy", 50000, "noise"), node("a/real", 120, "related")], edges: [], clusters: [] }),
    );
    await writeFile(
      join(tmp, "data", "cache", "star-daily.json"),
      JSON.stringify({
        updatedAt: nowIso,
        lastRound: { at: nowIso, day: anchor, counted: 2, gained: 830, spans: 0, carried: 0, baseline: false },
        seen: { "a/noisy": 50000, "a/real": 120 },
        sampledDays: [d0, anchor],
        days: { [d0]: { "a/noisy": 800 }, [anchor]: { "a/real": 30 } },
        spans: [],
        rounds: { [d0]: { first: nowIso, last: nowIso } },
      }),
    );
    const local = createApi({ root: tmp });

    const all = await local.ranking(new URLSearchParams("limit=10"));
    assert.equal(all.noise.filter, "all");
    assert.equal(all.noise.matched, 1, "要把数据里的噪声条数报出来");
    const rowsAll = [...all.boards.stars.items, ...all.boards.updated.items];
    assert.ok(all.boards.stars.items.length > 0, "夹具里应有可上榜的 star 行");
    assert.ok(rowsAll.every((r) => typeof r.verdict === "string"), "每一行都要带 verdict");
    assert.ok(all.boards.stars.items.some((r) => r.id === "a/noisy" && r.verdict === "noise"), "默认不过滤：噪声照常上榜（只标注）");

    const hidden = await local.ranking(new URLSearchParams("limit=10&noise=hide"));
    assert.equal(hidden.noise.filter, "hide");
    const rowsHidden = [...hidden.boards.stars.items, ...hidden.boards.updated.items];
    assert.ok(rowsHidden.length > 0, "hide 之后仍有正常行");
    assert.ok(rowsHidden.every((r) => r.verdict !== "noise"), "hide 之后榜单里不该再有噪声行");
    assert.ok(!hidden.boards.stars.items.some((r) => r.id === "a/noisy"));

    const only = await local.ranking(new URLSearchParams("limit=10&noise=only"));
    assert.equal(only.noise.filter, "only");
    assert.ok(only.boards.stars.items.length > 0 && only.boards.stars.items.every((r) => r.verdict === "noise"), "only 只看噪声");
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

test("卡片：合法 SVG、白玻璃卡 + 作者头像、转义正确", async () => {
  const found = await api.search(new URLSearchParams("limit=1&sort=stars"));
  const [owner, name] = found.items[0].id.split("/");
  const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const svg = await api.cardSvg(owner, name, { fetchAvatar: async () => avatar });
  assert.ok(svg.startsWith("<svg"), "应以 <svg 开头");
  assert.ok(svg.trimEnd().endsWith("</svg>"), "应以 </svg> 结尾");
  assert.match(svg, /width="420" height="168"/);
  // 作者头像内联成 data URI：卡片自包含，README 的 <img> 也能显示
  assert.ok(svg.includes("<image"), "应画作者头像");
  assert.ok(svg.includes(avatar), "头像应内联为 data URI");
  assert.ok(svg.includes('clip-path="url(#avatarClip)"'), "头像应裁成圆形");
  assert.ok(!svg.includes("M2 2.5A2.5 2.5 0 0 1 4.5 0"), "不应再画仓库图标");
  // 抓不到头像时退回首字母圆标（不因为外网失败而白卡）
  const fallback = await api.cardSvg(owner, name, { fetchAvatar: async () => null });
  assert.ok(!fallback.includes("<image"), "头像失败应退回圆标");
  assert.ok(fallback.includes('text-anchor="middle"'), "圆标应画首字母");
  // 卡片必须带去处：默认线上站点，且整张卡片可点（直接打开或 <object> 嵌入时生效）
  assert.ok(svg.includes(DEFAULT_SITE), "卡片应包含默认去处 " + DEFAULT_SITE);
  assert.ok(svg.includes("<a "), "卡片应包在链接里");
  assert.ok(svg.includes('target="_blank"'));
  const custom = await api.cardSvg(owner, name, { fetchAvatar: async () => null, site: "https://example.com/" });
  assert.ok(custom.includes("https://example.com/"), "自定义去处应生效");
  // 语言色点 / 相对时间 / 图标
  assert.ok(svg.includes("#f1e05a") || svg.includes("#3178c6"), "应画出该语言的颜色点");
  assert.match(svg, /更新于 /, "应有相对时间");
  assert.ok((svg.match(/<path d="/g) || []).length >= 1, "应包含星标图标");
  // 三个链接：背景→站点、仓库名→GitHub、底部→站点
  const hrefs = [...svg.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 3, "应有三个链接，实际 " + hrefs.length);
  assert.ok(hrefs.includes("https://github.com/" + found.items[0].id), "仓库名应指向 GitHub 原仓库");
  assert.equal(hrefs.filter((h) => h === DEFAULT_SITE).length, 2, "背景与底部都应指向站点");
  assert.ok(svg.includes(found.items[0].id.split("/")[1]), "卡片应含仓库名");
  assert.ok(!/<script/i.test(svg), "卡片不得包含脚本");
  // 默认白玻璃浅色卡；显式 theme=dark 才走深色令牌
  assert.ok(svg.includes("#ffffff") && svg.includes("#4f46e5"), "默认应为白玻璃浅色卡");
  const dark = await api.cardSvg(owner, name, { fetchAvatar: async () => null, theme: "dark" });
  assert.ok(dark.includes("#0d1117"), "深色应有深色底");
  assert.ok(dark.includes("#8b9cff"), "深色用深色链接色");
  assert.notEqual(dark, svg, "两套主题应不同");
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
  const index = apiIndex("0.5.1");
  assert.equal(index.version, "0.5.1");
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
    // 显式清空评测联动配置：测试不该依赖开发机 .env，也不该外呼
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", REVIEWS_SITE_URL: "", REVIEWS_ALLOW_HTTP: "" },
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

/** 用 node:http 直连：fetch 会自动解压，看不到 content-encoding 与压缩后的长度 */
function rawGet(url, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTP：API JSON 走协商压缩（200 行榜单 450KB → 80KB）", async () => {
  const plain = await rawGet(base + "/api/categories");
  assert.equal(plain.status, 200);
  assert.ok(plain.body.length > 1024, "这份响应要大到值得压缩，实际 " + plain.body.length);
  assert.equal(plain.headers["content-encoding"], undefined, "不带 accept-encoding 就不该压缩");

  const gz = await rawGet(base + "/api/categories", { "accept-encoding": "gzip" });
  assert.equal(gz.status, 200);
  assert.match(String(gz.headers["content-encoding"] ?? ""), /^(gzip|br)$/, "带 accept-encoding 应启用压缩");
  assert.match(String(gz.headers["vary"] ?? ""), /accept-encoding/i, "压缩响应必须声明 Vary");
  assert.ok(gz.body.length < plain.body.length, "压缩后要更小：" + gz.body.length + " vs " + plain.body.length);
  assert.equal(gz.headers["content-type"], "application/json; charset=utf-8");
  // 解压回来必须还是同一份 JSON
  const decoded = String(gz.headers["content-encoding"]) === "br" ? brotliDecompressSync(gz.body) : gunzipSync(gz.body);
  assert.deepEqual(JSON.parse(decoded.toString("utf8")), JSON.parse(plain.body.toString("utf8")));
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
  assert.ok(evil.includes(new URL(DEFAULT_SITE).host), "非法 link 应回落到默认站点 " + DEFAULT_SITE);

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

test("回归：恶意排序参数不能把接口打成 500（查表要用 hasOwnProperty）", async () => {
  // SORTS["__proto__"] 会返回 Object.prototype（真值），随后 sort(Object.prototype) 抛 TypeError。
  // 一个 &&sort=__proto__ 的公开查询就能稳定拿 500 —— 这里锁住。
  for (const sort of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "不存在的排序", ""]) {
    const result = await api.search(new URLSearchParams("sort=" + encodeURIComponent(sort) + "&limit=2"));
    assert.equal(result.items.length, 2, "sort=" + sort + " 应回落到默认排序，而不是抛异常");
  }
  const stars = await api.search(new URLSearchParams("sort=stars&limit=3"));
  const desc = stars.items.map((n) => n.stars);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a), "默认/显式排序仍应按星标降序");
});

test("HTTP：写方法被拒，预检请求被放行", async () => {
  const post = await fetch(base + "/api/repos", { method: "POST" });
  assert.ok(post.status === 405 || post.status === 403, "写方法必须被拒，实际 " + post.status);
  const opt = await fetch(base + "/api/repos", { method: "OPTIONS" });
  assert.equal(opt.status, 204, "预检应被放行");
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
});

test("索引仓库光环：以市场索引的归属为准，清单缺失时才退回旧判据", async () => {
  /* 线上事故：/api/npm-nodes 原来看的是"仓库 package.json 里写了个 npm 上存在的包名"，不校验归属。
   * 实测 9830 个这样的仓库里 2091 个的包在索引里其实归别人（dsh-desktop 一个包名被 97 个仓库声明），
   * 图上有 10144 个球被标成「索引仓库」。现在改成读索引自己产出的 dist/market/index-nodes.json。 */
  const tmp = await mkdtemp(join(tmpdir(), "mesh-halo-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    await mkdir(join(tmp, "dist", "market"), { recursive: true });
    // 两个仓库都声明了同一个包名 —— 旧判据会把两个都点亮
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: "2026-10-19T00:00:00Z",
        repos: {
          "real/owner": { status: "ok", package: "dsh-x", downloads: 5 },
          "copycat/one": { status: "ok", package: "dsh-x", downloads: 5 },
        },
      }),
    );
    await writeFile(join(tmp, "data", "cache", "npm-packages.json"), JSON.stringify({ updatedAt: null, packages: {} }));

    const fallback = await createApi({ root: tmp }).npmNodes();
    assert.deepEqual(fallback.ids.slice().sort(), ["copycat/one", "real/owner"], "没有清单时退回旧判据：两个都在");
    assert.equal(fallback.source, "npm-downloads");

    // 索引把 dsh-x 归给了 real/owner
    await writeFile(
      join(tmp, "dist", "market", "index-nodes.json"),
      JSON.stringify({ generatedAt: "2026-10-19T00:00:00Z", count: 1, ids: ["real/owner"] }),
    );
    const fromIndex = await createApi({ root: tmp }).npmNodes();
    assert.deepEqual(fromIndex.ids, ["real/owner"], "有清单时只认索引归属的那个，抢名的不再点亮");
    assert.equal(fromIndex.source, "market-index");
    assert.equal(fromIndex.updatedAt, "2026-10-19T00:00:00Z", "时间戳要透出索引的生成时刻");

    // 清单坏了也不能把接口打成 500，退回旧判据
    await writeFile(join(tmp, "dist", "market", "index-nodes.json"), "{坏掉的 json");
    const broken = await createApi({ root: tmp }).npmNodes();
    assert.ok(broken.ids.length >= 1, "坏清单要退回旧判据，而不是空列表或抛异常");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- 改名（renamedFrom）与身份归一（v0.5.4） ----------------
 * 事故背景：仓库改名后 full_name 变了，所有以 full_name 为键的台账（star-daily / update-log / releases / npm /
 * README）都会「旧名有账、现名无账」。以下用例钉住读取侧的归一行为，防止再出现「dsh-Go 不在周 star 榜」。 */

const RENAME_NODE = (id, stars, renamedFrom, extra = {}) => ({
  id,
  name: id.split("/")[1],
  owner: id.split("/")[0],
  stars,
  archived: false,
  fork: false,
  matchedTags: ["dsh"],
  topics: [],
  ...(renamedFrom ? { renamedFrom } : {}),
  ...extra,
});

test("改名归一：star 台账旧名增量并入现名、旧名不单独成行、Σ 不变式保持、旧名被占用不归", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-star-rename-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const anchor = dayOf(Date.parse(nowIso));
    const shift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const d0 = shift(anchor, -2);
    const d1 = shift(anchor, -1);
    const d2 = anchor;
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        nodes: [
          // 链式改名：a/old → a/mid → a/new
          RENAME_NODE("a/new", 300, ["a/old", "a/mid"]),
          RENAME_NODE("b/new", 50, ["b/old"]),
          // b/old 仍是活节点（名字被另一个仓库占用）：此时不许把 b/old 的账归到 b/new
          RENAME_NODE("b/old", 999),
          RENAME_NODE("c/plain", 10),
        ],
        edges: [],
        clusters: [],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "star-daily.json"),
      JSON.stringify({
        updatedAt: nowIso,
        lastRound: { at: nowIso, day: d2, counted: 3, gained: 130, spans: 0, carried: 0, baseline: false },
        seen: { "a/old": 100, "a/mid": 120, "a/new": 300, "b/old": 900, "b/new": 50, "c/plain": 10 },
        sampledDays: [d0, d1, d2],
        days: {
          [d0]: { "a/old": 40, "b/old": 77 },
          [d1]: { "a/mid": 20 },
          [d2]: { "a/new": 10, "c/plain": 3 },
        },
        spans: [],
        rounds: { [d0]: { first: nowIso, last: nowIso } },
      }),
    );
    const out = await createApi({ root: tmp }).ranking(new URLSearchParams("limit=10"));
    const board = out.boards.stars;
    const byId = new Map(board.items.map((r) => [r.id, r]));
    assert.equal(byId.has("a/old"), false, "旧名不许单独成行");
    assert.equal(byId.has("a/mid"), false, "链式改名的中间名也不许成行");
    const aNew = byId.get("a/new");
    assert.ok(aNew, "现名 a/new 应在榜上");
    assert.equal(aNew.delta, 70, "旧名 40（d0）+ 中间名 20（d1）+ 现名 10（d2）必须全并进来");
    assert.equal(aNew.starsBefore, 230, "starsAfter - starsBefore 必须等于 delta");
    assert.deepEqual(
      aNew.series.slice(out.seriesDays.indexOf(d0), out.seriesDays.indexOf(d2) + 1),
      [40, 20, 10],
      "逐日柱也要把旧名的柱子并到现名那一天",
    );
    // 旧名被占用：b/old 的 77 分给活着的 b/old，绝不归给 b/new
    assert.equal(byId.get("b/new") ?? null, null, "b/new 没有自己的增量就不该因旧名账上榜");
    assert.equal(byId.get("b/old").delta, 77, "旧名仍是活仓库时，它的账留在它自己名下");
    assert.equal(board.aliasMerged, 1, "只有 a/new 这一行是合并旧名来的");
    for (const it of board.items) {
      const bars = (it.series ?? []).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
      const spans = (it.spans ?? []).reduce((s, x) => s + x.value, 0);
      assert.equal(bars + spans, it.delta, "Σ逐日 + Σ宽条 必须等于行内增量：" + it.id);
    }
    // 身份对账：旧名有账但都能被 renamedFrom 指向 → 孤儿为 0
    const identity = await createApi({ root: tmp }).identityStats();
    assert.equal(identity.aliasedLedgerIds, 2, "a/old 与 a/mid 应算已归一的台账旧名");
    assert.equal(identity.orphanLedgerIds, 0, "改名旧名不算孤儿");
    assert.equal(identity.aliasIds, 2, "a/old、a/mid 两条别名；b/old 仍是活节点不算");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("改名兜底：/api/one 旧名可解析（旧链接不 404），README 搜索旧名命中归到现名", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rename-one-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        nodes: [RENAME_NODE("a/new", 12, ["a/old"], { description: "现名仓库" })],
        edges: [],
        clusters: [],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "readmes.json"),
      JSON.stringify({ count: 1, docs: { "a/old": { t: "renamekey 专属关键词在正文里" } } }),
    );
    const local = createApi({ root: tmp });
    const old = await local.one("a", "old");
    assert.ok(old, "旧名必须还能解析（大小写/改名都算）");
    assert.equal(old.repo.id, "a/new", "旧名解析结果指向现名");
    const searched = await local.search(new URLSearchParams("q=renamekey"));
    assert.ok(searched.items.some((n) => n.id === "a/new"), "旧名 README 的命中要归到现名节点");
    assert.equal(searched.readme.total, 1, "README 命中数按归一名算");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("改名归一：周更新榜的 release 记录、以及没有 releases 时的推送采样都跨旧名接续", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rename-updated-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const anchor = dayOf(Date.parse(nowIso));
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        nodes: [RENAME_NODE("r/new", 8, ["r/old"], { pushedAt: nowIso })],
        edges: [],
        clusters: [],
      }),
    );
    // releases 缓存还在旧名下
    await writeFile(
      join(tmp, "data", "cache", "releases.json"),
      JSON.stringify({
        updatedAt: nowIso,
        repos: { "r/old": { at: nowIso, releases: [{ tag: "v2", name: "v2", at: anchor, pre: false }] } },
      }),
    );
    const withReleases = await createApi({ root: tmp }).ranking(new URLSearchParams("limit=10"));
    const row = withReleases.boards.updated.items.find((r) => r.id === "r/new");
    assert.ok(row, "release 记录在旧名下也要能归到现名进榜");
    assert.equal(row.updates, 1, "窗口内旧名下的 release 要算进现名");

    // 没有 releases → 退回 update-log 采样口径，旧名采到的推送同样要并进来
    await rm(join(tmp, "data", "cache", "releases.json"));
    await writeFile(
      join(tmp, "data", "cache", "update-log.json"),
      JSON.stringify({
        updatedAt: nowIso,
        seen: {},
        days: { [anchor]: { "r/old": 2 } },
        sampledDays: [anchor],
      }),
    );
    const sampled = await createApi({ root: tmp }).ranking(new URLSearchParams("limit=10"));
    const sampledRow = sampled.boards.updated.items.find((r) => r.id === "r/new");
    assert.ok(sampledRow, "update-log 里旧名的推送要归到现名");
    assert.equal(sampledRow.updates, 2, "旧名采样到的 2 次推送必须并进现名，而不是被首见重置");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("改名归一：npm 周下载榜现名没有缓存条目时回退旧名", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-rename-npm-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({
        meta: { generatedAt: nowIso },
        nodes: [RENAME_NODE("p/new", 6, ["p/old"], { description: "插件" })],
        edges: [],
        clusters: [],
      }),
    );
    await writeFile(
      join(tmp, "data", "cache", "npm-downloads.json"),
      JSON.stringify({
        updatedAt: nowIso,
        repos: {
          "p/old": { status: "ok", package: "dsh-pkg-x", downloads: 4321, window: { start: "2026-10-20", end: "2026-10-26" } },
        },
      }),
    );
    const out = await createApi({ root: tmp }).ranking(new URLSearchParams("limit=10"));
    const row = out.boards.npm.items.find((x) => x.id === "p/new");
    assert.ok(row, "现名缺 npm 缓存时要回退旧名，不能凭空掉榜");
    assert.equal(row.downloads, 4321);
    assert.equal(row.npmPackage, "dsh-pkg-x");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("身份对账：真孤儿（有增量、无节点、无 renamedFrom 指向）必须能被报出来", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-identity-orphan-"));
  try {
    await mkdir(join(tmp, "data", "cache"), { recursive: true });
    const nowIso = new Date().toISOString();
    const anchor = dayOf(Date.parse(nowIso));
    await writeFile(
      join(tmp, "data", "mesh.json"),
      JSON.stringify({ meta: { generatedAt: nowIso }, nodes: [RENAME_NODE("ok/node", 5)], edges: [], clusters: [] }),
    );
    await writeFile(
      join(tmp, "data", "cache", "star-daily.json"),
      JSON.stringify({
        updatedAt: nowIso,
        seen: {},
        sampledDays: [anchor],
        days: { [anchor]: { "gone/orphan": 33, "ok/node": 2 } },
        spans: [],
        rounds: {},
        lastRound: { at: nowIso, day: anchor, counted: 2, gained: 35, spans: 0, carried: 0, baseline: false },
      }),
    );
    const identity = await createApi({ root: tmp }).identityStats();
    assert.equal(identity.orphanLedgerIds, 1, "真孤儿要报出来");
    assert.equal(identity.orphanTotalDelta, 33);
    assert.equal(identity.orphanSample[0].id, "gone/orphan");
    assert.equal(identity.ledgerAheadOfMesh, false, "同一轮内台账与 mesh 同步时不该打标");

    // 采集器一轮里台账先写、mesh.json 最后写：台账比 mesh 新时 orphan 只是临时现象，必须打标
    const daily = JSON.parse(await readFile(join(tmp, "data", "cache", "star-daily.json"), "utf8"));
    daily.updatedAt = new Date(Date.parse(nowIso) + 5 * 60000).toISOString();
    await writeFile(join(tmp, "data", "cache", "star-daily.json"), JSON.stringify(daily));
    const ahead = await createApi({ root: tmp }).identityStats();
    assert.equal(ahead.ledgerAheadOfMesh, true, "台账领先 mesh 时要标出来");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

