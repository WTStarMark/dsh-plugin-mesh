/**
 * 管理后台：同端口、同进程提供页面与接口，不额外起服务、不额外占端口。
 * 路由前缀是一段 32 位随机串（.env 的 ADMIN_PATH，部署时由 tools/admin-setup.mjs 自动填充）：
 *   GET /{P}/ 页面 · GET /{P}/a/{file} 后台静态资源 · ANY /{P}/api/... 后台接口（会话、状态、数据、工作流、名单、共鸣、应用、审计）。
 * 与公开站刻意分开：不给 Access-Control-Allow-Origin: *（后台接口只服务同源页面）；一律 Cache-Control: no-store + X-Robots-Tag: noindex；
 * 安全头沿用公开站那套（CSP 仍限 self，所以后台页面不能有内联脚本/样式）；写操作要 CSRF 令牌，POST 只收 JSON。
 * 「直接生效」= POST /api/apply 起一次【离线重建】（python3 backend/collect.py --from-store --budget 0）：不联网、不抓 GitHub，
 * 用本机累积索引重算 mesh.json 并自动跑预计算 —— 所以【黑名单】【共鸣开关】点一下就能生效；【白名单标签】改的是抓取口径，必须等下一轮真实采集。
 */

import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { COOKIE_NAME, createAuth, parseCookies } from "./admin-auth.mjs";
import {
  ADMIN_DIR,
  BLACKLIST_FILE,
  CONFIG_FILE,
  DEFAULT_WHITELIST_TAGS,
  ECOSYSTEM_FILE,
  JOB_FILE,
  LOG_DIR,
  ROOT,
  appendAudit,
  adminPathFrom,
  atomicWriteJson,
  ensureDir,
  fileInfo,
  listDir,
  COLLECTOR_FIELDS,
  collectorRanges,
  DEFAULT_COLLECTOR,
  loadAdminConfig,
  loadManifesto,
  saveManifesto,
  MANIFESTO_FILE,
  normalizeAliases,
  normalizeCluster,
  normalizeCollector,
  selfNodeId,
  numSettingFor,
  readAudit,
  relFromRoot,
  readBlacklist,
  CONTEXTS,
  MANAGED_ECOSYSTEM_FILE,
  cleanList,
  effectiveAnchors,
  estimateOwnerImpact,
  fileMtimeMs,
  listLogs,
  readEcosystem,
  readEnv,
  readLogTail,
  resonanceOverridesOf,
  resetEcosystem,
  saveAdminConfig,
  validOwner,
  validRepoId,
  validTag,
  writeBlacklist,
  writeEcosystem,
} from "./admin-config.mjs";
import { CONTEXT_IDS, CONTEXT_RULES, DEFAULT_CONTEXT, builtinBase } from "./ecosystem-bases.mjs";
import { createMarketAdmin } from "./market-admin.mjs";

const BODY_LIMIT = 256 * 1024;
// 采集参数的合法键集合：POST 时用来分辨"这个键我们不认识"
const COLLECTOR_RANGES_KEYS = collectorRanges();
const ASSETS = {
  "admin.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "status.js": "text/javascript; charset=utf-8",
  "market.js": "text/javascript; charset=utf-8",
};
const PHASES = [
  { id: "segments", label: "抓分段", desc: "按星标区间分片抓 GitHub 搜索接口，逐段入累积索引" },
  { id: "readme", label: "读 README", desc: "按星标优先补抓 README 摘要，供正文检索" },
  { id: "build", label: "构建索引", desc: "噪声判定 → 分类 → 相关性三档 → 生态共鸣边" },
  { id: "write", label: "写快照", desc: "写 mesh.json / 快照 / 星标历史 / 更新日志" },
  { id: "precompute", label: "预计算布局", desc: "生成 mesh-core.* 与详情分片（前端首屏读它）" },
];

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const rel = (file) => (String(file).startsWith(ROOT + "/") ? String(file).slice(ROOT.length + 1) : String(file));

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tailLines(file, lines = 40) {
  try {
    const info = statSync(file);
    const size = Math.min(info.size, 256 * 1024);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size);
    readFileSync(fd, buf, 0, size, info.size - size);
    closeSync(fd);
    return buf
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
      .slice(-lines)
      .map((line) => line.slice(0, 300));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 采集器是否正在跑（写 mesh.json）？两边同时重写会互相覆盖，所以「应用变更」要先看它一眼。
 * 状态是 crawling/building/precomputing 且 10 分钟内更新过 → 判定为忙；状态文件太久没动说明它其实没在运行（本地纯预览就是这样），不拦。
 */
export function collectorBusy(file = join(ROOT, "data", "cache", "status.json"), now = Date.now()) {
  const status = readJsonSafe(file);
  if (!status || typeof status !== "object") return null;
  if (!["crawling", "building", "precomputing"].includes(status.state)) return null;
  const updated = Date.parse(status.updatedAt ?? "");
  if (!Number.isFinite(updated)) return null;
  const ageMinutes = (now - updated) / 60000;
  if (ageMinutes > 10) return null;
  return { state: status.state, phase: status.phase ?? null, updatedAt: status.updatedAt, ageMinutes: Math.round(ageMinutes * 10) / 10 };
}

/** 锚定条件是否与「上次策展用的那份」不同（纯函数，方便单测）：不同 = 需要重跑策展工具，离线重建（应用变更）改不了这个。 */
export function anchorsDiffer(managed, curated) {
  const mine = new Map(effectiveAnchors(managed).map((b) => [b.id, b]));
  const last = new Map(effectiveAnchors(curated).map((b) => [b.id, b]));
  if (mine.size !== last.size) return true;
  const key = (list) => [...list].sort().join("\u0000");
  for (const [id, a] of mine) {
    const b = last.get(id);
    if (!b) return true;
    if ((a.tag ?? null) !== (b.tag ?? null)) return true;
    if (a.context !== b.context) return true;
    if (key(a.probes) !== key(b.probes)) return true;
    if (key(a.packages) !== key(b.packages)) return true;
  }
  return false;
}

/**
 * 共鸣清单相对当前数据「有没有未应用的改动」（纯函数，方便单测）。判定依据是**内容**而不是文件时间：
 * 管理副本里启用/停用的基座集合，以及每个基座在【当前图里】应有的共鸣边数，与 mesh.meta 完全对上才算已应用
 * —— 点一次「还原」时间就变了、内容却没变，用 mtime 判定会误报。
 * 注意两个容易踩的点：① 清单里的子项可能不在图里（仓库还没被收录），这些不参与比较；② 停用的基座期望边数是 0，而不是「它有多少子项」。
 */
export function resonanceIsPending(eco, mesh) {
  if (!eco || !eco.managed) return false;
  if (!mesh || !mesh.meta) return true;
  const ids = new Set((mesh.nodes ?? []).map((n) => n.id));
  const edges = new Map();
  for (const edge of mesh.edges ?? []) {
    if (edge.type === "resonance") edges.set(edge.source, (edges.get(edge.source) ?? 0) + 1);
  }
  const enabled = eco.doc.bases.filter((b) => b.enabled).map((b) => b.id).sort();
  const disabled = eco.doc.bases.filter((b) => !b.enabled).map((b) => b.id).sort();
  const haveEnabled = [...(mesh.meta.ecosystemBases ?? [])].sort();
  const haveDisabled = [...(mesh.meta.ecosystemDisabled ?? [])].sort();
  if (JSON.stringify(enabled) !== JSON.stringify(haveEnabled)) return true;
  if (JSON.stringify(disabled) !== JSON.stringify(haveDisabled)) return true;
  for (const base of eco.doc.bases) {
    const expected = base.enabled ? base.verified.filter((c) => ids.has(c.id)).length : 0;
    if (expected !== (edges.get(base.id) ?? 0)) return true;
  }
  return false;
}

/**
 * 把请求体里的锚定条件写进目标基座；不合法时返回中文错误串。
 * 关键点：给了非空数组却全被过滤掉（长度超限、类型不对）必须报错 —— 否则界面以为保存成功，
 * 实际把条件清空了，下一次策展会突然什么都匹配不到。
 */
function applyAnchors(target, source, label) {
  if (source.probes !== undefined) {
    if (!Array.isArray(source.probes)) return label + "：探针词必须是字符串数组";
    const list = cleanList(source.probes);
    if (source.probes.length && !list.length) return label + "：探针词不合法（每条 1~80 字、最多 50 条）";
    target.probes = list;
  }
  if (source.packages !== undefined) {
    if (!Array.isArray(source.packages)) return label + "：包名/标识必须是字符串数组";
    const list = cleanList(source.packages);
    if (source.packages.length && !list.length) return label + "：包名/标识不合法（每条 1~80 字、最多 50 条）";
    target.packages = list;
  }
  if (source.context !== undefined) {
    if (!CONTEXT_IDS.includes(source.context)) return label + "：语境规则只能是 " + CONTEXT_IDS.join(" / ") + " 之一";
    target.context = source.context;
  }
  return null;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function createAdmin({ version, api, securityHeaders }) {
  const env = readEnv();
  const base = adminPathFrom(env);
  if (!base) {
    return {
      enabled: false,
      basePath: null,
      reason: "未配置 ADMIN_PATH —— 跑一次 node tools/admin-setup.mjs 会自动生成",
      match: () => false,
      handle: async () => {},
    };
  }
  // 进程环境变量优先（测试/临时部署用），其次 .env
  const secret = process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD || null;
  const auth = createAuth({ secret, basePath: "/" + base + "/" });
  const prefix = "/" + base;
  let child = null;

  const headers = (extra) => ({
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...securityHeaders,
    ...extra,
  });

  function sendJson(res, code, data, extra) {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(code, headers({ "content-type": "application/json; charset=utf-8", "content-length": body.length, ...(extra ?? {}) }));
    res.end(body);
  }

  function sendText(res, code, text, type) {
    const body = Buffer.from(text);
    res.writeHead(code, headers({ "content-type": type ?? "text/plain; charset=utf-8", "content-length": body.length }));
    res.end(body);
  }

  /* 索引源后台：同进程挂载，复用本文件的会话/CSRF/审计；路由前缀 api/market/*。 */
  const marketAdmin = createMarketAdmin({ root: ROOT, sendJson, readJsonBody });

  async function readJsonBody(req) {
    return new Promise((resolvePromise) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolvePromise(value);
      };
      req.on("data", (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > BODY_LIMIT) {
          // 不能 destroy：socket 一断，400 发不出去（客户端只会看到空响应）。丢弃剩余 body，正常回包。
          chunks.length = 0;
          req.resume();
          finish({ error: "请求体过大" });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) return;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return finish({ value: {} });
        try {
          const value = JSON.parse(raw);
          if (!value || typeof value !== "object" || Array.isArray(value)) return finish({ error: "请求体必须是 JSON 对象" });
          finish({ value });
        } catch {
          finish({ error: "请求体不是合法 JSON" });
        }
      });
      req.on("error", () => finish({ error: "读取请求体失败" }));
    });
  }

  /**
   * 限速用的客户端 IP：默认只信 socket 地址（X-Forwarded-For 客户端可以随便伪造）。
   * 只有明确挂了可信反代时才设 TRUST_PROXY=1 —— 那时按真实客户端 IP 分桶，
   * 否则反代后面所有请求共用同一个桶，一个人乱试就会把所有人一起限住。
   */
  const ipOf = (req) => {
    if (process.env.TRUST_PROXY === "1") {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (xff) return xff;
    }
    return String(req.socket?.remoteAddress ?? "?");
  };
  // Cookie 的 Secure 标记：代理声明 https 就加；线上也可以直接用 ADMIN_COOKIE_SECURE=1 强开，免得代理漏发 X-Forwarded-Proto 时会话 Cookie 在 http 上裸奔。
  const secureOf = (req) =>
    process.env.ADMIN_COOKIE_SECURE === "1" || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";

  function sessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return { sid, session: auth.session(sid) };
  }

  /** 同源校验：浏览器发 POST 时会带 Origin；带了就必须与本请求 Host 一致 */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === String(req.headers.host ?? "");
    } catch {
      return false;
    }
  }

  // ---------- 「直接生效」作业 ----------

  function jobState() {
    const job = readJsonSafe(JOB_FILE);
    if (!job || !job.id) return { id: null, status: "idle", logTail: [] };
    if (job.status === "running") {
      const alive = (child && child.exitCode === null) || isAlive(job.pid);
      if (!alive) {
        job.status = "failed";
        job.note = (job.note ? job.note + " · " : "") + "进程已不在（服务重启或进程被终止）";
      }
    }
    job.logTail = job.log ? tailLines(join(ROOT, job.log), 40) : [];
    return job;
  }

  function startApply(ip) {
    const current = jobState();
    if (current.status === "running") return { busy: true, job: current };
    ensureDir(LOG_DIR);
    const id = nowIso().replace(/[-:]/g, "").slice(0, 15);
    const logFile = join(LOG_DIR, "apply-" + id + ".log");
    // 不带 --budget：离线重建一个请求都不发，带上它只会把状态里的「预算」写成 0，界面上看着像「配额是 0」。
    const args = ["backend/collect.py", "--from-store"];
    const fd = openSync(logFile, "a");
    let proc;
    try {
      proc = spawn(process.env.PYTHON ?? "python3", args, { cwd: ROOT, stdio: ["ignore", fd, fd] });
    } catch (err) {
      closeSync(fd);
      return { error: "无法启动重建进程：" + String(err && err.message ? err.message : err) };
    }
    closeSync(fd);
    const job = {
      id,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      exitCode: null,
      pid: proc.pid ?? null,
      command: "python3 " + args.join(" "),
      log: rel(logFile),
      note: "离线重建：不联网，用累积索引重算 mesh.json 并自动跑预计算",
    };
    atomicWriteJson(JOB_FILE, job);
    child = proc;
    appendAudit({ ip, action: "apply-started", detail: job.command });
    proc.on("exit", (code, signal) => {
      child = null;
      const finished = { ...job, status: code === 0 ? "done" : "failed", exitCode: code, signal: signal ?? null, finishedAt: nowIso() };
      atomicWriteJson(JOB_FILE, finished);
      appendAudit({ ip, action: "apply-finished", detail: "exit=" + String(code) });
    });
    proc.on("error", (err) => {
      child = null;
      atomicWriteJson(JOB_FILE, { ...job, status: "failed", finishedAt: nowIso(), note: String(err && err.message ? err.message : err) });
      appendAudit({ ip, action: "apply-failed", detail: String(err && err.message ? err.message : err) });
    });
    return { job: jobState() };
  }

  // ---------- 只读数据 ----------

  /** 名单：配置文件比 mesh.json 新就算"可能改过"（名单很难比内容，mtime 是够用的近似） */
  function pendingLists() {
    const meshMtime = fileMtimeMs(join(ROOT, "data", "mesh.json"));
    const newest = Math.max(fileMtimeMs(BLACKLIST_FILE), fileMtimeMs(CONFIG_FILE));
    return newest > 0 && newest > meshMtime ? new Date(newest).toISOString() : null;
  }

  async function resonancePending() {
    return resonanceIsPending(readEcosystem(), await api.load().catch(() => null));
  }

  async function pendingPayload() {
    const listsAt = pendingLists();
    return {
      lists: !!listsAt,
      resonance: await resonancePending(),
      since: listsAt,
    };
  }

  async function statusPayload() {
    const snapshot = await api.status();
    const raw = snapshot.status ?? null;
    const updated = Date.parse((raw && raw.updatedAt) || "");
    const staleMinutes = Number.isFinite(updated) ? Math.round((Date.now() - updated) / 60000) : null;
    const collector = collectorBusy();
    // 不能只看状态文件多久没更新 —— 采集器每轮之间要睡将近一小时，一刀切 10 分钟会每小时误报 50 分钟。
    // 规则：正在跑（crawling/building/precomputing）时按 10 分钟判定；空闲时看下一次开跑时间，到点后再宽限 5 分钟还没动静才算异常；没有 nextRunAt 的老数据退回 10 分钟规则。
    const running = ["crawling", "building", "precomputing"].includes(raw && raw.state);
    const nextRun = Date.parse((raw && raw.nextRunAt) || "");
    const stale = running || !Number.isFinite(nextRun) ? staleMinutes === null || staleMinutes >= 10 : Date.now() > nextRun + 5 * 60000;
    return {
      serverTime: snapshot.serverTime,
      data: snapshot.data,
      readme: snapshot.readme,
      raw,
      stale,
      staleMinutes,
      collector: { busy: !!collector, ...(collector ?? {}) },
      pending: await pendingPayload(),
      applying: jobState(),
    };
  }

  async function overviewPayload() {
    const cats = await api.categories().catch(() => null);
    const mesh = await api.load().catch(() => null);
    const files = [
      ["data/mesh.json", "前端契约（采集器写）"],
      ["data/mesh-core.json", "预计算契约"],
      ["data/mesh-core.bin", "二进制主干（后台补全）"],
      ["data/mesh-core.head.bin", "首屏主干（前 3000 节点）"],
      ["data/last-crawl.json", "最近一次采集溯源"],
      ["data/cache/status.json", "采集进度状态"],
      ["data/cache/repos.json", "累积索引"],
      ["data/cache/segments.json", "分段队列状态"],
      ["data/cache/readmes.json.gz", "README 摘要索引"],
      ["data/cache/star-history.json", "星标历史环"],
      ["data/cache/star-daily.json", "逐日星标增量"],
      ["data/cache/update-log.json", "更新日志"],
      ["data/cache/releases.json", "版本缓存"],
      ["data/noise-blacklist.json", "噪声作者黑名单"],
      ["data/admin/config.json", "后台共享配置"],
    ]
      .map(([file, label]) => fileInfo(join(ROOT, file), label))
      .filter(Boolean);
    // README 索引的"目标/空篇数"只有采集状态文件里才有，合并进来免得界面只好显示「—」
    const statusRaw = readJsonSafe(join(ROOT, "data", "cache", "status.json"));
    const readmeStats = await api.readmeStats().catch(() => null);
    const readme = readmeStats
      ? {
          ...readmeStats,
          target: (statusRaw && statusRaw.readme && statusRaw.readme.target) ?? null,
          cached: (statusRaw && statusRaw.readme && statusRaw.readme.cached) ?? null,
          empty: (statusRaw && statusRaw.readme && statusRaw.readme.empty) ?? null,
          thisRound: (statusRaw && statusRaw.readme && statusRaw.readme.thisRound) ?? null,
        }
      : null;
    return {
      version,
      generatedAt: (cats && cats.generatedAt) || (mesh && mesh.meta && mesh.meta.generatedAt) || null,
      nodes: (cats && cats.total) || (mesh ? mesh.nodes.length : null),
      edges: mesh ? mesh.edges.length : null,
      sectors: cats && cats.sectors ? cats.sectors.length : null,
      resonanceEdges: (mesh && mesh.meta && mesh.meta.resonanceEdges) ?? null,
      files,
      readme,
      starDaily: await api.starDailyStats().catch(() => null),
      snapshots: listDir(join(ROOT, "data", "snapshots")).slice(0, 20),
      lastCrawl: readJsonSafe(join(ROOT, "data", "last-crawl.json")),
    };
  }

  async function reposPayload(url) {
    const params = new URLSearchParams(url.searchParams);
    params.set("limit", String(clamp(params.get("limit"), 1, 100, 20)));
    params.set("offset", String(clamp(params.get("offset"), 0, 100000, 0)));
    const result = await api.search(params);
    return {
      total: result.total,
      limit: Number(params.get("limit")),
      offset: Number(params.get("offset")),
      items: (result.items ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        owner: n.owner,
        stars: n.stars,
        description: n.description,
        categoryLabel: n.categoryLabel,
        pushedAt: n.pushedAt,
        htmlUrl: n.htmlUrl,
        archived: !!n.archived,
        fork: !!n.fork,
        verdict: n.verdict ?? null,
      })),
    };
  }

  async function workflowPayload(statusData) {
    const lastCrawl = readJsonSafe(join(ROOT, "data", "last-crawl.json"));
    // 与 GET /api/logs 用同一份清单：里面的 name 可以【直接】喂给 GET /api/log?name=（早先这里只回文件名，前端拿它去请求会被白名单挡成 404）。
    const logs = listLogs().slice(0, 30);
    const crawlLog = fileInfo(join(ROOT, "data", "crawl.log"), "采集器日志");
    return {
      phases: PHASES,
      currentPhase: (statusData.raw && statusData.raw.phase) || null,
      state: (statusData.raw && statusData.raw.state) || null,
      status: statusData,
      lastCrawl: lastCrawl
        ? {
            generatedAt: lastCrawl.generatedAt ?? null,
            mode: lastCrawl.mode ?? null,
            seconds: lastCrawl.seconds ?? null,
            rawRecords: lastCrawl.rawRecords ?? null,
            indexedNodes: lastCrawl.indexedNodes ?? null,
            frontendNodes: lastCrawl.frontendNodes ?? null,
            frontendEdges: lastCrawl.frontendEdges ?? null,
            requests: lastCrawl.stats ? lastCrawl.stats.requests : null,
            // 预算不在 last-crawl 里，只有状态文件记着（就是上一轮用的那个值）
            budget: (statusData.raw && statusData.raw.budget) ?? null,
            pages: lastCrawl.stats ? lastCrawl.stats.pages : null,
            quotaRemaining: lastCrawl.stats ? lastCrawl.stats.rateLimitRemaining : null,
            readme: lastCrawl.readme ?? null,
            snapshot: lastCrawl.snapshot ?? null,
            addedCount: lastCrawl.diff ? lastCrawl.diff.addedCount : null,
            removedCount: lastCrawl.diff && Array.isArray(lastCrawl.diff.removed) ? lastCrawl.diff.removed.length : null,
            tags: lastCrawl.tags ?? null,
          }
        : null,
      logs,
      crawlLog,
    };
  }

  function listsPayload() {
    const config = loadAdminConfig();
    return {
      blacklist: readBlacklist(),
      whitelistTags: config.whitelistTags,
      whitelistAliases: (config.whitelistAliases || []).map((g) => ({ tag: g.tag, aliases: [...g.aliases] })),
      defaultWhitelistTags: [...DEFAULT_WHITELIST_TAGS],
      whitelistNeedsCrawl: true,
      note: "黑名单/共鸣改动点『应用变更』（离线重算）即可生效；白名单标签改的是抓取口径，要等下一轮真实采集才会改口径。",
      settings: settingsPayload(),
    };
  }

  /**
   * 采集参数（settings 页）。三件事必须一起给前端，否则界面只能瞎猜：
   *  collector 当前值 · 内置默认值 · 每项的合法范围与说明。
   * 「命令行是否覆盖了它」得由采集器自己报告（它才知道启动参数），见 status 里的 collectorArgs。
   */
  function settingsPayload() {
    const config = loadAdminConfig();
    return {
      collector: normalizeCollector(config.collector),
      defaults: { ...DEFAULT_COLLECTOR },
      ranges: collectorRanges(),
      fields: COLLECTOR_FIELDS.map((f) => ({ ...f })),
      configPath: relFromRoot(CONFIG_FILE),
      note: "采集参数存 data/admin/config.json，这一页说了算：保存后下一轮采集自动按新值跑（配置压过启动参数，启动参数只在某项没配置时当默认值）。白名单标签仍要重启采集器，因为规则表是进程启动时读的。",
    };
  }

  /** 共鸣清单：后台编辑的是管理副本 data/admin/ecosystem.json（没有就先按策展产物显示）；附带「每个基座/子项在不在当前图里、画了几条边」，方便一眼看出改动有没有生效。 */
  async function resonancePayload() {
    const eco = readEcosystem();
    const mesh = await api.load().catch(() => null);
    const nodeStars = new Map();
    const edgeCount = new Map();
    if (mesh) {
      for (const node of mesh.nodes ?? []) nodeStars.set(node.id, node.stars ?? 0);
      for (const edge of mesh.edges ?? []) {
        if (edge.type === "resonance") edgeCount.set(edge.source, (edgeCount.get(edge.source) ?? 0) + 1);
      }
    }
    return {
      source: eco.source,
      managed: eco.managed,
      curatedAt: eco.curatedAt,
      updatedAt: eco.updatedAt,
      note: eco.doc.note,
      pendingApply: await resonancePending(),
      // 锚定条件改了但还没重新策展？应用变更（离线重建）改不了它 —— 只有重跑 tools/curate-ecosystem.mjs 才会按新条件重新发现子节点。
      needsCuration: anchorsDiffer(eco.doc, eco.curated),
      meshResonanceEdges: (mesh && mesh.meta && mesh.meta.resonanceEdges) ?? null,
      // 语境规则是命名预设，直接把可选列表给前端，别让界面写死文案
      contexts: CONTEXTS,
      bases: eco.doc.bases.map((b) => {
        const builtin = builtinBase(b.id);
        const context = b.context ?? (builtin ? builtin.context : DEFAULT_CONTEXT);
        return {
          id: b.id,
          label: b.label,
          tag: b.tag,
          enabled: b.enabled,
          // 锚定条件：管理副本里"压根没写过"（null）才回落到内置值；显式清空就是清空
          probes: b.probes === null ? (builtin ? [...builtin.probes] : []) : b.probes,
          packages: b.packages === null ? (builtin ? [...builtin.packages] : []) : b.packages,
          context,
          contextLabel: CONTEXT_RULES[context] ? CONTEXT_RULES[context].label : context,
          anchorsCustom: b.probes !== null || b.packages !== null || b.context !== null,
          builtinAnchors: builtin
            ? { tag: builtin.tag ?? null, probes: [...builtin.probes], packages: [...builtin.packages], context: builtin.context }
            : null,
          verifiedCount: b.verified.length,
          inMesh: nodeStars.has(b.id),
          edgeCount: edgeCount.get(b.id) ?? 0,
          children: b.verified.map((c) => ({
            id: c.id,
            inMesh: nodeStars.has(c.id),
            stars: nodeStars.has(c.id) ? nodeStars.get(c.id) : Number.isFinite(c.stars) ? c.stars : null,
            signals: Array.isArray(c.signals) ? c.signals : [],
            readme: typeof c.readme === "string" ? c.readme : null,
          })),
        };
      }),
      hint: "清单改动不会自动生效：回状态页点『应用变更』，用累积索引离线重算一次即可。",
    };
  }

  // ---------- 路由 ----------

  function match(pathname) {
    return pathname === prefix || pathname.startsWith(prefix + "/");
  }

  function serveAsset(res, name, method) {
    if (!Object.prototype.hasOwnProperty.call(ASSETS, name)) {
      sendText(res, 404, "404 未知资源");
      return;
    }
    const file = join(ROOT, "admin", name);
    try {
      const body = readFileSync(file);
      res.writeHead(200, headers({ "content-type": ASSETS[name], "content-length": body.length }));
      if (method === "HEAD") res.end();
      else res.end(body);
    } catch {
      sendText(res, 503, "503 后台前端资源缺失：" + rel(file), "text/plain; charset=utf-8");
    }
  }

  async function handleApi(name, req, res, method, url) {
    const ip = ipOf(req);
    const write = (action, detail) => appendAudit({ ip, action, detail });

    if (name === "login") {
      if (method !== "POST") return sendJson(res, 405, { error: "只允许 POST" });
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "跨站请求被拒绝" });
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      if (!auth.enabled) return sendJson(res, 503, { error: "服务端未配置登录口令，请跑 node tools/admin-setup.mjs" });
      const result = await auth.login(String(parsed.value.password ?? ""), ip);
      if (!result.ok) {
        if (result.reason === "locked") {
          write("login-locked", "retryAfter=" + result.retryAfter);
          return sendJson(res, 429, { error: "尝试过多，请稍后再试", retryAfter: result.retryAfter }, { "retry-after": String(result.retryAfter ?? 60) });
        }
        write("login-failed", "remaining=" + String(result.remaining ?? ""));
        return sendJson(res, 401, { error: "口令不正确" });
      }
      res.setHeader("set-cookie", auth.cookieHeader(result.sid, secureOf(req)));
      write("login-ok", null);
      return sendJson(res, 200, { ok: true, csrf: result.csrf, expiresAt: result.expiresAt });
    }

    const { sid, session } = sessionOf(req);

    if (name === "session") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "只允许 GET" });
      if (!session) return sendJson(res, 200, { authed: false });
      return sendJson(res, 200, { authed: true, csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() });
    }

    if (!session) return sendJson(res, 401, { error: "未登录或会话已过期" });

    if (name === "logout") {
      if (method !== "POST") return sendJson(res, 405, { error: "只允许 POST" });
      if (!sameOrigin(req) || !auth.csrfOk(session, req.headers["x-csrf-token"])) return sendJson(res, 403, { error: "CSRF 校验失败，请刷新页面重试" });
      auth.logout(sid);
      res.setHeader("set-cookie", auth.clearCookie());
      write("logout", null);
      return sendJson(res, 200, { ok: true });
    }

    const isWrite = method === "POST" || method === "PUT" || method === "DELETE";
    if (isWrite) {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "跨站请求被拒绝" });
      // 只认请求头：查询串里的令牌会进浏览器历史/代理日志/分享链接，属于自找麻烦
      const token = req.headers["x-csrf-token"];
      if (!auth.csrfOk(session, token)) return sendJson(res, 403, { error: "CSRF 校验失败，请刷新页面重试" });
    } else if (method !== "GET" && method !== "HEAD") {
      return sendJson(res, 405, { error: "只允许 GET / POST" });
    }

    if (name === "status") return sendJson(res, 200, await statusPayload());
    if (name === "overview") return sendJson(res, 200, await overviewPayload());
    if (name === "repos") return sendJson(res, 200, await reposPayload(url));
    if (name === "workflow") return sendJson(res, 200, await workflowPayload(await statusPayload()));
    if (name === "lists") return sendJson(res, 200, listsPayload());
    if (name === "resonance") {
      if (!isWrite) return sendJson(res, 200, await resonancePayload());
      // 兼容旧写法 {baseId, enabled}：改成直接落到管理副本的 enabled 上，只保留一个事实来源
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const baseId = String(parsed.value.baseId ?? "");
      const enabled = parsed.value.enabled;
      if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled 必须是布尔值" });
      const eco = readEcosystem();
      const base = eco.doc.bases.find((b) => b.id === baseId);
      if (!base) return sendJson(res, 404, { error: "清单里没有这个基座：" + baseId });
      base.enabled = enabled;
      writeEcosystem(eco.doc);
      write("resonance-set", baseId + "=" + String(enabled));
      return sendJson(res, 200, { ok: true, resonance: await resonancePayload() });
    }

    if (name === "resonance/base" || name === "resonance/child") {
      if (!isWrite) return sendJson(res, 405, { error: "只允许 POST" });
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const body = parsed.value;
      const action = String(body.action ?? "");
      const eco = readEcosystem();
      const doc = eco.doc;

      if (name === "resonance/base") {
        if (action === "reset") {
          if (!resetEcosystem()) return sendJson(res, 500, { error: "读不到策展产物 tools/ecosystem.json，无法还原" });
          write("resonance-reset", null);
          return sendJson(res, 200, await resonancePayload());
        }
        const id = String(body.id ?? "").trim();
        if (!validRepoId(id)) return sendJson(res, 400, { error: "基座 id 必须是 owner/repo 形式" });
        const index = doc.bases.findIndex((b) => b.id === id);
        if (action === "add") {
          if (index >= 0) return sendJson(res, 400, { error: "清单里已经有这个基座：" + id });
          const fresh = {
            id,
            label: String(body.label ?? "").trim().slice(0, 80) || id,
            tag: body.tag ? String(body.tag).trim().slice(0, 80) : null,
            enabled: body.enabled !== false,
            probes: [],
            packages: [],
            context: null,
            verified: [],
          };
          const anchorError = applyAnchors(fresh, body, "新增基座");
          if (anchorError) return sendJson(res, 400, { error: anchorError });
          doc.bases.push(fresh);
        } else if (action === "update") {
          if (index < 0) return sendJson(res, 404, { error: "清单里没有这个基座：" + id });
          const base = doc.bases[index];
          if (body.label !== undefined) base.label = String(body.label).trim().slice(0, 80) || id;
          if (body.tag !== undefined) base.tag = body.tag ? String(body.tag).trim().slice(0, 80) : null;
          if (typeof body.enabled === "boolean") base.enabled = body.enabled;
          const anchorError = applyAnchors(base, body, "锚定条件");
          if (anchorError) return sendJson(res, 400, { error: anchorError });
        } else if (action === "remove") {
          if (index < 0) return sendJson(res, 404, { error: "清单里没有这个基座：" + id });
          doc.bases.splice(index, 1);
        } else {
          return sendJson(res, 400, { error: "action 只能是 add / update / remove / reset" });
        }
        writeEcosystem(doc);
        write("resonance-base-" + action, id);
        return sendJson(res, 200, await resonancePayload());
      }

      const baseId = String(body.baseId ?? "").trim();
      const childId = String(body.childId ?? "").trim();
      if (!validRepoId(baseId) || !validRepoId(childId)) return sendJson(res, 400, { error: "基座与子项都必须是 owner/repo 形式" });
      const base = doc.bases.find((b) => b.id === baseId);
      if (!base) return sendJson(res, 404, { error: "清单里没有这个基座：" + baseId });
      const at = base.verified.findIndex((c) => c.id === childId);
      if (action === "add") {
        if (at >= 0) return sendJson(res, 400, { error: "这个子项已经在清单里：" + childId });
        const signals = cleanList(body.signals, 20, 120);
        base.verified.push({
          id: childId,
          signals: signals.length ? signals : ["后台人工添加"],
          readme: typeof body.readme === "string" && body.readme.trim() ? body.readme.trim().slice(0, 120) : baseId,
          depend: true,
        });
      } else if (action === "update") {
        if (at < 0) return sendJson(res, 404, { error: "这个子项不在清单里：" + childId });
        const child = base.verified[at];
        if (body.signals !== undefined) {
          if (!Array.isArray(body.signals)) return sendJson(res, 400, { error: "归属信号必须是字符串数组" });
          const signals = cleanList(body.signals, 20, 120);
          if (body.signals.length && !signals.length) {
            return sendJson(res, 400, { error: "归属信号不合法（每条 1~120 字、最多 20 条）" });
          }
          child.signals = signals;
        }
        if (body.readme !== undefined) child.readme = String(body.readme).trim().slice(0, 120);
      } else if (action === "remove") {
        if (at < 0) return sendJson(res, 404, { error: "这个子项不在清单里：" + childId });
        base.verified.splice(at, 1);
      } else {
        return sendJson(res, 400, { error: "action 只能是 add / remove" });
      }
      writeEcosystem(doc);
      write("resonance-child-" + action, baseId + " ← " + childId);
      return sendJson(res, 200, await resonancePayload());
    }

    if (name === "logs") {
      return sendJson(res, 200, { files: listLogs() });
    }
    if (name === "log") {
      const log = readLogTail(url.searchParams.get("name"));
      if (!log) return sendJson(res, 404, { error: "日志不存在，或不在可读白名单里" });
      return sendJson(res, 200, log);
    }
    if (name === "lists/blacklist") {
      if (!isWrite) return sendJson(res, 405, { error: "只允许 POST" });
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const action = String(parsed.value.action ?? "");
      const owner = String(parsed.value.owner ?? "").trim();
      // 单仓库级（issue#5 第1条）：add-repo/remove-repo 用的是 repoId 而不是 owner。
      // 语义差别很实在 —— 作者级 = 整个账号不可信；仓库级 = 那人还有真项目，只剔这一个。
      if (action === "add-repo" || action === "remove-repo") {
        const repoId = String(parsed.value.repoId ?? parsed.value.id ?? "").trim();
        if (!validRepoId(repoId)) return sendJson(res, 400, { error: "仓库要写成 owner/repo" });
        const lists = readBlacklist();
        if (action === "add-repo") {
          const note = String(parsed.value.note ?? "").slice(0, 200);
          lists.repos[repoId] = { note: note || null, addedAt: nowIso() };
        } else if (!lists.repos[repoId]) {
          return sendJson(res, 404, { error: "仓库黑名单里没有这个仓库：" + repoId });
        } else {
          delete lists.repos[repoId];
        }
        const written = writeBlacklist(lists);
        write("blacklist-" + action, repoId);
        return sendJson(res, 200, { ok: true, repoId, lists: listsPayload(), backedUp: written.backedUp });
      }
      if (action !== "add" && action !== "remove") return sendJson(res, 400, { error: "action 只能是 add / remove / add-repo / remove-repo" });
      if (!validOwner(owner)) return sendJson(res, 400, { error: "作者名不合法（GitHub 用户名规则：字母数字与短横线，最长 39 位）" });
      const blacklist = readBlacklist();
      // 影响预估：累积索引里这个作者当前有多少个仓库、合计多少星。
      // repos=0 说明"他压根不在数据里"——加了也不会有任何可见变化，必须如实告诉用户，
      // 否则就是 issue#5 第2条说的"无实际反馈"（回一句"已加入"却什么都没变）。
      const impact = action === "add" ? estimateOwnerImpact(owner) : null;
      const existed = action === "add" ? !!blacklist.owners[owner] : false;
      if (action === "add") {
        const note = String(parsed.value.note ?? "").slice(0, 200);
        const previous = blacklist.owners[owner];
        blacklist.owners[owner] = {
          repos: previous && Number.isFinite(previous.repos) ? previous.repos : 0,
          zeroStars: previous && Number.isFinite(previous.zeroStars) ? previous.zeroStars : 0,
          zeroRatio: previous && Number.isFinite(previous.zeroRatio) ? previous.zeroRatio : 0,
          maxStars: previous && Number.isFinite(previous.maxStars) ? previous.maxStars : 0,
          reason: "manual",
          note: note || null,
          addedAt: nowIso(),
        };
      } else if (!blacklist.owners[owner]) {
        return sendJson(res, 404, { error: "黑名单里没有这个作者：" + owner });
      } else {
        delete blacklist.owners[owner];
      }
      const written = writeBlacklist(blacklist);
      write("blacklist-" + action, owner);
      return sendJson(res, 200, {
        ok: true,
        created: action === "add" ? !existed : false,
        impact: impact ? { ...impact, before: !!existed } : null,
        lists: listsPayload(),
        backedUp: written.backedUp,
      });
    }
    if (name === "settings") {
      if (!isWrite) return sendJson(res, 200, settingsPayload());
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const patch = parsed.value && typeof parsed.value.collector === "object" && parsed.value.collector ? parsed.value.collector : parsed.value;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return sendJson(res, 400, { error: "请求体应是 {collector:{...}}" });
      }
      const normalized = normalizeCollector(patch);
      // rejected = 传进来但没能按原样生效的键。判定必须直接查"这个值本身合不合法"，
      // 不能拿归一化结果反推：坏值会被回退成默认值，而默认值恰好等于你传的值时
      // 会被误判成"接受"（budget:120 传了个坏值也说成功）。
      const rejected = Object.keys(patch).filter((key) => {
        const spec = COLLECTOR_RANGES_KEYS[key];
        if (!spec) return true; // 不认识的键
        return numSettingFor(patch[key], spec) === null;
      });
      saveAdminConfig({ collector: normalized });
      write("settings-set", JSON.stringify(normalized));
      return sendJson(res, 200, { ok: true, applied: normalized, rejected, ...settingsPayload() });
    }
    // 倡议书：后台直接编辑标题/副标题/两个页签的正文（HTML 片段），保存后前台 /api/manifesto 立刻生效
    if (name === "manifesto") {
      if (!isWrite) {
        return sendJson(res, 200, { manifesto: loadManifesto(), isDefault: !existsSync(MANIFESTO_FILE) });
      }
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const body = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value : {};
      const doc = saveManifesto(body.reset === true ? null : { title: body.title, subtitle: body.subtitle, pages: body.pages });
      write(body.reset === true ? "manifesto-reset" : "manifesto-set", "pages=" + doc.pages.length);
      return sendJson(res, 200, { ok: true, manifesto: doc, isDefault: false });
    }
    // 多节点（镜像）配置：节点清单 + 是否聚合各节点的「访问 / 在线」；前台 /api/nodes 用公开投影
    if (name === "cluster") {
      const config = loadAdminConfig();
      if (!isWrite) {
        return sendJson(res, 200, {
          cluster: config.cluster,
          nodeId: process.env.NODE_ID ?? "",
          self: selfNodeId(config.cluster),
          siteUrl: process.env.SITE_URL ?? "",
        });
      }
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const cluster = normalizeCluster(parsed.value);
      saveAdminConfig({ cluster });
      write("cluster-set", "nodes=" + cluster.nodes.length + " enabled=" + cluster.enabled + " aggregate=" + cluster.aggregateStats);
      return sendJson(res, 200, { ok: true, cluster, nodeId: process.env.NODE_ID ?? "" });
    }
    if (name === "lists/whitelist") {
      if (!isWrite) return sendJson(res, 405, { error: "只允许 POST" });
      const parsed = await readJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      if (!Array.isArray(parsed.value.tags)) return sendJson(res, 400, { error: "tags 必须是字符串数组" });
      const raw = parsed.value.tags.map((t) => String(t).trim()).filter(Boolean);
      const bad = raw.filter((t) => !validTag(t));
      if (bad.length) return sendJson(res, 400, { error: "标签不合法：" + bad.slice(0, 3).join("、") });
      const tags = [...new Set(raw)];
      if (tags.length > 50) return sendJson(res, 400, { error: "标签最多 50 个" });
      // 别名组可选：只传 tags 时保持原样（老前端不会把别名组抹掉）
      const config = loadAdminConfig();
      const aliases = Array.isArray(parsed.value.whitelistAliases)
        ? normalizeAliases(parsed.value.whitelistAliases, tags)
        : config.whitelistAliases;
      saveAdminConfig({ ...config, whitelistTags: tags, whitelistAliases: aliases });
      write("whitelist-set", tags.join(",") + " | 别名组 " + aliases.length + " 个");
      return sendJson(res, 200, { ok: true, lists: listsPayload() });
    }
    if (name === "apply") {
      if (!isWrite) return sendJson(res, 200, { job: jobState() });
      // 采集器正在跑就别掺和：两边同时重写 mesh.json，谁也说不清最后是哪份
      const busy = collectorBusy();
      if (busy) {
        return sendJson(res, 409, {
          error: "采集器正在跑（" + busy.state + (busy.phase ? " · " + busy.phase : "") + "），等这一轮结束再点「应用变更」",
          collector: busy,
        });
      }
      const started = startApply(ip);
      if (started.busy) return sendJson(res, 409, { error: "已有一个重建任务在跑", job: started.job });
      if (started.error) return sendJson(res, 500, { error: started.error });
      return sendJson(res, 200, { ok: true, job: started.job });
    }
    if (name === "audit") {
      const limit = clamp(url.searchParams.get("limit"), 1, 1000, 100);
      return sendJson(res, 200, { entries: readAudit(limit) });
    }
    /* 索引源管理（tools/market-admin.mjs）：总览/复核/构建/差异/发布/回滚。 */
    if (name === "market" || name.startsWith("market/")) {
      return await marketAdmin.handle(name, { req, res, method, url, isWrite, write, sendJson, readJsonBody });
    }
    return sendJson(res, 404, { error: "未知后台接口：" + name });
  }

  async function handle(req, res, method, pathname, url) {
    const rest = pathname.slice(prefix.length);
    try {
      if (rest === "") {
        res.writeHead(302, headers({ location: prefix + "/" }));
        res.end();
        return;
      }
      if (rest === "/") {
        if (method !== "GET" && method !== "HEAD") return sendText(res, 405, "405 只允许 GET / HEAD");
        try {
          const body = readFileSync(join(ROOT, "admin", "index.html"));
          res.writeHead(200, headers({ "content-type": "text/html; charset=utf-8", "content-length": body.length }));
          res.end(method === "HEAD" ? undefined : body);
        } catch {
          sendText(res, 503, "503 后台页面还没就绪：admin/index.html 不存在");
        }
        return;
      }
      // 资源两种写法都收：/{路径}/a/app.js（显式）与 /{路径}/app.js（页面相对引用）
      if (rest.startsWith("/a/") || (rest.length > 1 && !rest.slice(1).includes("/"))) {
        if (method !== "GET" && method !== "HEAD") return sendText(res, 405, "405 只允许 GET / HEAD");
        return serveAsset(res, rest.startsWith("/a/") ? rest.slice(3) : rest.slice(1), method);
      }
      if (rest.startsWith("/api/")) {
        return await handleApi(rest.slice(5), req, res, method, url);
      }
      sendText(res, 404, "404 未知后台路径");
    } catch (err) {
      const where = err && err.stack ? String(err.stack).split("\n")[0] : String(err);
      console.error("后台接口异常 " + name(rest) + " -> " + where);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: "后台内部错误" });
        else res.end();
      } catch {
        try {
          res.destroy();
        } catch {
          /* 连接已断 */
        }
      }
    }
  }

  /** 日志用：只留接口名，绝不把后台路径写进日志 */
  function name(rest) {
    return rest.startsWith("/api/") ? "api/" + rest.slice(5) : "page";
  }

  return { enabled: true, basePath: base, match, handle, logName: name, authStats: () => auth.stats() };
}

export { ADMIN_DIR, BLACKLIST_FILE, CONFIG_FILE, JOB_FILE, LOG_DIR };
