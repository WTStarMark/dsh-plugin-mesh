/**
 * 评测站（review.lingshulab.com）只读取数源 —— mesh 侧唯一的 reviews 依赖。
 *
 * 为什么在服务端取数：mesh 的 CSP 是 connect-src 'self'，浏览器直连 reviews 会被拦；
 * 而 reviews 的公开接口也不带 CORS 头（实测）。所以由 serve 进程按 TTL 拉取公开的
 * /api/plugins 分页，聚合出「仓库 → 测评篇数 → 插件页 URL」，前端通过同源的
 * /api/review-nodes 读取。
 *
 * 与「不碰 reviews」的边界一致：
 *   · 只读 GET 公开接口，UA 标识，串行分页，正常流量 3 页 / 10 分钟；
 *   · 不要求 reviews 做任何改动（CORS、接口、缓存策略都不动）；
 *   · 全有或全无：任一分页失败都不发布半截数据，保留上一份并标 stale；
 *   · 纯内存：不落盘、不写 data/、不碰采集器与 mesh 契约；
 *   · 严格校验：上游字段缺失/变形一律按失败处理，绝不把坏数据当成功；
 *   · 不存、不传播评论者/作者等身份信息，只用仓库名、插件 id、篇数。
 *
 * 请求路径永远不 await 网络：serve 启动时预热一次，之后每 ttl 刷新一次；
 * 失败按 60s→…→10min 退避。快照超过 maxStaleMs 标 expired，前端隐藏光环。
 */

const UA = "dsh-plugin-mesh/0.5.3 (+https://www.moc-chen.cn)";
const SOURCE = "plugins-pages";
const PAGE_SIZE = 50;
const FALLBACK_PAGE_SIZE = 20;
const MAX_STALE_MS = 7 * 24 * 3600 * 1000;

/** 插件 id 是 UUID（拼跳转 URL 用，必须严格校验） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** GitHub 仓库全名 owner/repo：与 mesh 节点 id 同形，字符集按 GitHub 白名单 */
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

export function createReviewSource(options = {}) {
  const rawSite = String(options.siteUrl ?? "").trim().replace(/\/+$/, "");
  let siteUrl = rawSite;
  let siteError = null;
  if (rawSite) {
    try {
      const parsed = new URL(rawSite);
      const allowHttp = options.allowHttp === true;
      if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
        siteError = "评测站地址必须是 https（测试可用 REVIEWS_ALLOW_HTTP=1）";
      }
    } catch {
      siteError = "评测站地址不合法";
    }
  }
  const enabled = (options.enabled !== false) && rawSite !== "" && !siteError && typeof (options.fetchImpl ?? globalThis.fetch) === "function";
  const disabledReason = !rawSite
    ? "未配置评测站地址（REVIEWS_SITE_URL）"
    : siteError ?? (enabled ? null : "当前环境没有 fetch");

  const ttlMs = positiveInt(options.ttlMs, 10 * 60 * 1000);
  const pageTimeoutMs = positiveInt(options.pageTimeoutMs, 6 * 1000);
  const refreshTimeoutMs = positiveInt(options.refreshTimeoutMs, 20 * 1000);
  const maxPages = positiveInt(options.maxPages, 40);
  const maxStaleMs = positiveInt(options.maxStaleMs, MAX_STALE_MS);
  const backoffBaseMs = positiveInt(options.backoffBaseMs, 60 * 1000);
  const backoffMaxMs = positiveInt(options.backoffMaxMs, 10 * 60 * 1000);
  const autoRefresh = options.autoRefresh !== false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const log = options.log ?? console;

  /** 上一次成功拉取的完整快照；失败时保留它，只打 stale 标记 */
  let lastGood = null;
  let inflight = null;
  let timer = null;
  let stopped = false;
  let failures = 0;
  let lastError = null;

  function emptySnapshot() {
    return {
      enabled,
      loading: !!inflight,
      ok: false,
      stale: false,
      expired: false,
      error: lastError ?? (enabled ? null : disabledReason),
      source: SOURCE,
      site: siteUrl,
      fetchedAt: null,
      count: 0,
      reviews: 0,
      ids: [],
      byId: {},
      invalid: 0,
    };
  }

  /** 同步快照：请求路径只读它，绝不等网络 */
  function snapshot() {
    if (!enabled) return { ...emptySnapshot(), loading: false };
    if (!lastGood) return emptySnapshot();
    const age = now() - lastGood.fetchedAt;
    const expired = age > maxStaleMs;
    return {
      enabled,
      loading: false,
      ok: !expired,
      stale: !!lastError,
      expired,
      error: lastError,
      source: SOURCE,
      site: siteUrl,
      fetchedAt: new Date(lastGood.fetchedAt).toISOString(),
      count: lastGood.count,
      reviews: lastGood.reviews,
      ids: lastGood.ids,
      byId: lastGood.byId,
      invalid: lastGood.invalid,
    };
  }

  function schedule(delayMs) {
    if (!autoRefresh || stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void refresh({ force: true });
    }, Math.max(0, delayMs));
    timer?.unref?.();
  }

  async function refresh({ force = false } = {}) {
    if (!enabled || stopped) return snapshot();
    if (inflight) {
      await inflight;
      return snapshot();
    }
    if (!force && lastGood && now() - lastGood.fetchedAt < ttlMs) return snapshot();
    const task = runRefresh();
    inflight = task;
    try {
      await task;
    } finally {
      inflight = null;
    }
    return snapshot();
  }

  async function runRefresh() {
    const controller = new AbortController();
    // 整体预算：3 页 × 6s 单页超时 = 18s < 20s；超预算整轮按失败处理（走退避，不发布半截）
    const totalTimer = setTimer(() => controller.abort(), refreshTimeoutMs);
    totalTimer?.unref?.();
    try {
      const agg = await fetchAll(controller.signal);
      lastGood = { fetchedAt: now(), ...agg };
      lastError = null;
      failures = 0;
      log.log(
        "[review-source] 同步完成：" + agg.count + " 个仓库 / " + agg.reviews + " 篇测评 / " + agg.pages + " 页" +
          (agg.invalid ? " / 丢弃非法条目 " + agg.invalid : ""),
      );
      schedule(ttlMs);
    } catch (err) {
      failures += 1;
      lastError = String(err && err.message ? err.message : err).slice(0, 200);
      log.warn?.(
        "[review-source] 同步失败：" + lastError + (lastGood ? "（沿用上一次成功的数据）" : "（暂无可用数据）"),
      );
      schedule(Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failures - 1)));
    } finally {
      clearTimer(totalTimer);
    }
  }

  async function fetchAll(signal) {
    const items = [];
    let page = 1;
    let pageSize = PAGE_SIZE;
    let hasNext = true;
    let totalPages = 1;

    while (hasNext && page <= maxPages) {
      const data = await fetchPage(page, pageSize, signal, (next) => (pageSize = next));
      if (!Array.isArray(data.items)) throw new Error("接口结构变化：items 不是数组（第 " + page + " 页）");
      items.push(...data.items);
      totalPages = Number(data.total_pages) || totalPages;
      hasNext = typeof data.has_next === "boolean" ? data.has_next : page < totalPages;
      if (!data.items.length) break; // 空页直接停，别为了错误的分页元数据空转
      page += 1;
    }
    return aggregate(items, page - 1);
  }

  async function fetchPage(page, pageSize, signal, onFallback) {
    const url = siteUrl + "/api/plugins?page=" + page + "&page_size=" + pageSize;
    // 单页超时：与整体预算组合（任一触发即中止本页）
    let pageSignal = signal;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      try {
        pageSignal = AbortSignal.any([signal, AbortSignal.timeout(pageTimeoutMs)]);
      } catch {
        pageSignal = signal;
      }
    }
    const res = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: pageSignal,
    });
    // 上游只允许 10/20/50；若哪天 50 被拒，自动降到 20 重试一次
    if (res.status === 400 && pageSize !== FALLBACK_PAGE_SIZE) {
      onFallback(FALLBACK_PAGE_SIZE);
      return fetchPage(page, FALLBACK_PAGE_SIZE, signal, onFallback);
    }
    if (!res.ok) throw new Error("HTTP " + res.status + "（第 " + page + " 页）");
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new Error("返回不是合法 JSON（第 " + page + " 页）");
    }
    if (!payload || payload.ok !== true || !payload.data || typeof payload.data !== "object") {
      throw new Error("接口结构变化（第 " + page + " 页）");
    }
    return payload.data;
  }

  /** 把插件条目聚合成「仓库 → 篇数 / 插件列表 / 主插件 URL」；非法条目丢弃并计数 */
  function aggregate(items, pages) {
    const repos = new Map();
    let invalid = 0;
    for (const item of items) {
      if (!item || typeof item !== "object") {
        invalid += 1;
        continue;
      }
      const pluginId = String(item.pluginId ?? "");
      const repoId = String(item.repositoryFullName ?? "");
      const count = Number(item.publicReviewCount);
      const pluginPath = typeof item.pluginPath === "string" && item.pluginPath ? item.pluginPath : ".";
      if (!UUID_RE.test(pluginId) || !REPO_RE.test(repoId) || !Number.isFinite(count) || count < 0) {
        invalid += 1;
        continue;
      }
      const reviews = Math.trunc(count);
      if (reviews <= 0) continue; // publicReviewCount=0 的插件没有公开测评，不点亮任何仓库
      let repo = repos.get(repoId);
      if (!repo) {
        repo = { plugins: new Map(), count: 0 };
        repos.set(repoId, repo);
      }
      if (repo.plugins.has(pluginId)) {
        invalid += 1; // 同一个插件重复出现：只认第一条
        continue;
      }
      repo.plugins.set(pluginId, { pluginId, pluginPath, count: reviews });
      repo.count += reviews;
    }

    const ids = [...repos.keys()].sort((a, b) => a.localeCompare(b));
    const byId = {};
    let reviews = 0;
    for (const id of ids) {
      const repo = repos.get(id);
      // 主插件规则：篇数最多 → 根目录（.）优先 → 路径字典序
      const plugins = [...repo.plugins.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (a.pluginPath === "." || b.pluginPath === ".") {
          if (a.pluginPath === b.pluginPath) return 0;
          return a.pluginPath === "." ? -1 : 1;
        }
        return a.pluginPath.localeCompare(b.pluginPath);
      });
      byId[id] = {
        count: repo.count,
        // 跳转落点：插件测评页（用户指定）
        url: siteUrl + "/plugins/" + plugins[0].pluginId,
        plugins,
      };
      reviews += repo.count;
    }
    return { ids, byId, count: ids.length, reviews, invalid, pages };
  }

  /** 启动预热 + 周期刷新（不阻塞任何请求；测试里 autoRefresh:false 可关掉） */
  function start() {
    if (!enabled || stopped) return;
    schedule(0);
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    enabled,
    start,
    stop,
    snapshot,
    refresh,
  };
}
