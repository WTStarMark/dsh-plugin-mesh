/**
 * 评测站取数模块单测：全部注入 fetch / 定时器 / 时钟，不发真实网络请求。
 * 覆盖：分页聚合、主插件规则、全有或全无、退避、过期、非法条目、关闭、page_size 降级、
 * wrapper 校验、快照非阻塞、start/stop。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewSource } from "../tools/review-source.mjs";

const SITE = "https://reviews.example";
const silent = { log() {}, warn() {} };

const uuid = (n) => ("0000000" + Number(n).toString(16)).slice(-8) + "-1111-7000-8000-000000000000";
const repoId = (n) => "owner" + n + "/dsh-plugin-" + n;
const plugin = (n, repo, count, path = ".") => ({
  pluginId: uuid(n),
  pluginPath: path,
  repositoryFullName: repo,
  publicReviewCount: count,
  // 不依赖的字段：模块必须忽略（上游随时可能增删）
  description: "不该被读取",
  ownerLogin: "someone",
});

/** 假定时器：只记录、不自动执行；测试自己决定何时触发 */
function fakeTimers() {
  const handles = [];
  return {
    handles,
    setTimer(fn, ms) {
      const handle = { fn, ms, cleared: false };
      handle.unref = () => handle;
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.cleared = true;
    },
    pending() {
      return handles.filter((h) => !h.cleared);
    },
    /** 触发一个定时器（触发过的不再算 pending） */
    fire(handle) {
      handle.cleared = true;
      handle.fn();
    },
    lastPending() {
      const list = this.pending();
      return list[list.length - 1] ?? null;
    },
  };
}

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function pagePayload({ page, items, totalPages = 1, total, hasNext, pageSize = 50 }) {
  return {
    ok: true,
    data: {
      items,
      page,
      page_size: pageSize,
      total: total ?? items.length,
      total_pages: totalPages,
      has_previous: page > 1,
      has_next: typeof hasNext === "boolean" ? hasNext : page < totalPages,
    },
  };
}

/** 用「页 → 条目」表造 fetchImpl；calls 记录 {url, headers} */
function pagedFetch(pages, { failPage = null, status = 500 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page"));
    if (failPage === page) return jsonResponse({ error: "boom" }, status);
    return jsonResponse(pagePayload({ page, items: pages[page - 1] ?? [], totalPages: pages.length, total: pages.flat().length }));
  };
  return { fetchImpl, calls };
}

test("分页聚合：篇数、主插件规则（篇数 → 根目录 → 字典序）与插件页 URL", async () => {
  const repoA = repoId(1);
  const repoB = repoId(2);
  const { fetchImpl, calls } = pagedFetch([
    [
      plugin(1, repoA, 5, "packages/a"),
      plugin(2, repoA, 5, "."), // 同篇数 → 根目录优先，主插件应是它
      plugin(3, repoA, 2, "packages/c"),
      plugin(4, repoB, 1, "."),
      plugin(5, repoB, 0, "."), // 0 篇：不点亮
    ],
  ]);
  const source = createReviewSource({ siteUrl: SITE + "/", fetchImpl, autoRefresh: false, log: silent });
  const snap = await source.refresh({ force: true });

  assert.equal(snap.enabled, true);
  assert.equal(snap.ok, true);
  assert.equal(snap.loading, false);
  assert.equal(snap.count, 2);
  assert.equal(snap.reviews, 13);
  assert.deepEqual(snap.ids, [repoA, repoB]);
  assert.equal(snap.byId[repoA].count, 12);
  assert.equal(snap.byId[repoA].url, SITE + "/plugins/" + uuid(2), "主插件应落根目录那个");
  assert.deepEqual(
    snap.byId[repoA].plugins.map((p) => p.pluginPath),
    [".", "packages/a", "packages/c"],
  );
  assert.equal(snap.byId[repoB].count, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/plugins\?page=1&page_size=50$/);
  assert.match(String(calls[0].headers["user-agent"]), /dsh-plugin-mesh/);
  assert.equal(calls[0].headers.accept, "application/json");
});

test("分页：has_next 缺失时用 total_pages 兜底，空页直接停", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    calls.push(page);
    if (page === 1) {
      return jsonResponse({ ok: true, data: { items: [plugin(1, repoId(1), 1)], page: 1, total_pages: 2, total: 2 } });
    }
    return jsonResponse({ ok: true, data: { items: [plugin(2, repoId(2), 1)], page: 2, total_pages: 2, total: 2, has_next: false } });
  };
  const source = createReviewSource({ siteUrl: SITE, fetchImpl, autoRefresh: false, log: silent });
  const snap = await source.refresh({ force: true });
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(snap.ids, [repoId(1), repoId(2)]);

  // 分页元数据说还有下一页，但当前页为空：直接停，不空转
  const emptyCalls = [];
  const emptyFetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    emptyCalls.push(page);
    return jsonResponse({ ok: true, data: { items: [], page, total_pages: 9, total: 99, has_next: true } });
  };
  const emptySource = createReviewSource({ siteUrl: SITE, fetchImpl: emptyFetch, autoRefresh: false, log: silent });
  await emptySource.refresh({ force: true });
  assert.deepEqual(emptyCalls, [1]);
});

test("任一分页失败都不发布半截：保留旧快照并标 stale", async () => {
  const pages = [[plugin(1, repoId(1), 2)], [plugin(2, repoId(2), 3)]];
  let fail = false;
  const fetchImpl = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    if (fail && page === 2) return jsonResponse({}, 500);
    return jsonResponse(pagePayload({ page, items: pages[page - 1] ?? [], totalPages: 2, total: 2 }));
  };
  const source = createReviewSource({ siteUrl: SITE, fetchImpl, autoRefresh: false, log: silent });
  const first = await source.refresh({ force: true });
  assert.equal(first.count, 2);

  fail = true;
  const second = await source.refresh({ force: true });
  assert.equal(second.count, 2, "旧数据必须保留");
  assert.equal(second.ok, true, "旧数据仍可用");
  assert.equal(second.stale, true);
  assert.match(second.error, /HTTP 500/);
  assert.equal(second.fetchedAt, first.fetchedAt, "失败不应改写快照时间");
});

test("失败退避：60s 起翻倍、封顶 10 分钟；成功后回到 TTL", async () => {
  const timers = fakeTimers();
  let ok = false;
  const fetchImpl = async (url) => {
    if (!ok) return jsonResponse({}, 500);
    return jsonResponse(pagePayload({ page: 1, items: [plugin(1, repoId(1), 1)], totalPages: 1 }));
  };
  const source = createReviewSource({
    siteUrl: SITE,
    fetchImpl,
    autoRefresh: true,
    ttlMs: 300_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: silent,
  });
  await source.refresh({ force: true });
  assert.equal(timers.lastPending().ms, 60_000);
  await source.refresh({ force: true });
  assert.equal(timers.lastPending().ms, 120_000);
  await source.refresh({ force: true });
  assert.equal(timers.lastPending().ms, 240_000);
  for (let i = 0; i < 5; i += 1) await source.refresh({ force: true });
  assert.equal(timers.lastPending().ms, 600_000, "封顶 10 分钟");

  ok = true;
  const snap = await source.refresh({ force: true });
  assert.equal(snap.ok, true);
  assert.equal(timers.lastPending().ms, 300_000, "成功后回到 TTL");
});

test("旧数据超过 maxStaleMs → expired 且 ok=false（但仍保留数据供排障）", async () => {
  let now = 1_000_000;
  const { fetchImpl } = pagedFetch([[plugin(1, repoId(1), 1)]]);
  const source = createReviewSource({
    siteUrl: SITE,
    fetchImpl,
    autoRefresh: false,
    now: () => now,
    maxStaleMs: 1_000,
    log: silent,
  });
  await source.refresh({ force: true });
  assert.equal(source.snapshot().expired, false);
  now += 1_001;
  const snap = source.snapshot();
  assert.equal(snap.expired, true);
  assert.equal(snap.ok, false);
  assert.equal(snap.count, 1);
});

test("非法条目被丢弃并计数，合法条目照常保留", async () => {
  const items = [
    plugin(1, repoId(1), 2),
    { pluginId: "not-a-uuid", repositoryFullName: repoId(2), publicReviewCount: 1 },
    { pluginId: uuid(3), repositoryFullName: "bad name", publicReviewCount: 1 },
    { pluginId: uuid(4), repositoryFullName: repoId(3), publicReviewCount: "不是数字" },
    { pluginId: uuid(1), repositoryFullName: repoId(1), publicReviewCount: 9 }, // 同一插件重复：只认第一条
  ];
  const { fetchImpl } = pagedFetch([items]);
  const source = createReviewSource({ siteUrl: SITE, fetchImpl, autoRefresh: false, log: silent });
  const snap = await source.refresh({ force: true });
  assert.equal(snap.count, 1);
  assert.equal(snap.byId[repoId(1)].count, 2, "重复条目不能把篇数叠加");
  assert.equal(snap.invalid, 4);
});

test("未配置 / 关闭 / 非 https 时不发任何请求", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(pagePayload({ page: 1, items: [] }));
  };
  for (const options of [
    {},
    { siteUrl: "" },
    { siteUrl: SITE, enabled: false },
    { siteUrl: "http://reviews.example" }, // 默认只允许 https
    { siteUrl: "不是地址" },
  ]) {
    const source = createReviewSource({ ...options, fetchImpl, autoRefresh: false, log: silent });
    const snap = source.snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.count, 0);
    assert.ok(snap.error, "关闭态应给出原因");
    await source.refresh({ force: true });
  }
  assert.equal(calls, 0, "关闭态绝不能外呼");

  // 测试允许 http（只给本地 stub 用）
  const local = createReviewSource({ siteUrl: "http://127.0.0.1:9/", allowHttp: true, fetchImpl: async () => jsonResponse({}, 500), autoRefresh: false, log: silent });
  assert.equal(local.enabled, true);
});

test("page_size 被拒（400）自动降到 20 重试一次", async () => {
  const sizes = [];
  const fetchImpl = async (url) => {
    const size = new URL(String(url)).searchParams.get("page_size");
    sizes.push(size);
    if (size === "50") return jsonResponse({}, 400);
    return jsonResponse(pagePayload({ page: 1, items: [plugin(1, repoId(1), 1)], totalPages: 1, pageSize: 20 }));
  };
  const source = createReviewSource({ siteUrl: SITE, fetchImpl, autoRefresh: false, log: silent });
  const snap = await source.refresh({ force: true });
  assert.deepEqual(sizes, ["50", "20"]);
  assert.equal(snap.count, 1);
});

test("上游 wrapper 变形（ok:false / 缺 data / items 非数组 / 非 JSON）按失败处理，不抛异常", async () => {
  const cases = [
    { ok: false, error: "broken" },
    { ok: true },
    { ok: true, data: { items: "not-an-array" } },
    null,
  ];
  for (const body of cases) {
    const source = createReviewSource({
      siteUrl: SITE,
      fetchImpl: async () => jsonResponse(body),
      autoRefresh: false,
      log: silent,
    });
    const snap = await source.refresh({ force: true });
    assert.equal(snap.ok, false);
    assert.equal(snap.loading, false);
    assert.ok(snap.error, "应带一句话原因");
  }
});

test("刷新进行中 snapshot() 立即返回（请求路径零等待）", async () => {
  let release;
  const fetchImpl = () => new Promise((resolve) => { release = resolve; });
  const source = createReviewSource({ siteUrl: SITE, fetchImpl, autoRefresh: false, log: silent });
  const pending = source.refresh({ force: true });

  const started = Date.now();
  const mid = source.snapshot();
  assert.ok(Date.now() - started < 50, "snapshot 不能等待网络");
  assert.equal(mid.loading, true);
  assert.equal(mid.ok, false);

  release(jsonResponse(pagePayload({ page: 1, items: [plugin(1, repoId(1), 1)], totalPages: 1 })));
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(done.loading, false);
});

test("start() 预热一次，stop() 清掉定时器", async () => {
  const timers = fakeTimers();
  const fetchImpl = async () => jsonResponse(pagePayload({ page: 1, items: [], totalPages: 1 }));
  const source = createReviewSource({
    siteUrl: SITE,
    fetchImpl,
    autoRefresh: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: silent,
  });
  source.start();
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].ms, 0, "启动应立刻预热");
  timers.fire(timers.pending()[0]);
  await new Promise((r) => setImmediate(r));
  assert.equal(source.snapshot().ok, true);
  assert.equal(timers.lastPending().ms, 10 * 60 * 1000, "成功后按 TTL 排下一次");

  source.stop();
  assert.equal(timers.pending().length, 0);
});
