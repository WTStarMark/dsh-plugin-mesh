/**
 * 索引源管理后台：挂在现有后台（tools/admin.mjs）的 /<ADMIN_PATH>/api/market/* 下。
 *
 * 不是第二个服务：复用同一进程、同一端口、同一套登录/CSRF/审计/日志白名单。
 * 职责：
 *   · 只读：索引总览、条目库、单条详情、复核队列、校验缓存统计、构建历史；
 *   · 人工裁决：写 data/admin/market-index/overrides.json（生成器读它，优先级最高）；
 *   · 构建闸门：spawn tools/market-index.mjs 把结果写进 drafts/<jobId>/，算 diff，人工确认后
 *     原子替换 dist/market/index.json，并留 history 备份支持回滚。
 *
 * 安全边界：不接受任意命令/任意路径；日志只读白名单；所有写操作由 admin.mjs 统一做 CSRF + 同源校验，
 * 这里只负责参数校验与业务。浏览器永远拿不到 GitHub/npm token。
 */

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson, ensureDir, fileMtimeMs, relFromRoot } from "./admin-config.mjs";
import { DECISIONS, PACKAGE_NAME_RE, decisionFor, listHit, marketPaths, readMarketOverrides, saveMarketOverrides } from "./market-overrides.mjs";
import { VERDICT, judgeSubdirCheck, readRepoDirCache, repoDirCacheKey } from "./repo-dir-verify.mjs";
import { MARKET_LABELS, marketLabel } from "./market-labels.mjs";

const HISTORY_KEEP = 10;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const safeJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const repoKeyOf = (url) => {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(String(url ?? ""));
  return m ? (m[1] + "/" + m[2]).toLowerCase() : null;
};
const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};
const tailLines = (file, limit = 80) => {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).slice(-limit);
  } catch {
    return [];
  }
};

export function createMarketAdmin({ root, sendJson, readJsonBody } = {}) {
  const base = resolve(root);
  const paths = marketPaths(base);
  const distIndex = join(base, "dist", "market", "index.json");
  const distNodes = join(base, "dist", "market", "index-nodes.json");
  const registryFile = join(base, "data", "cache", "npm-registry.json");
  const repoDirsFile = join(base, "data", "cache", "repo-dirs.json");
  const statusFile = join(base, "data", "cache", "status.json");
  const meshFile = join(base, "data", "mesh.json");
  const downloadsFile = join(base, "data", "cache", "npm-downloads.json");
  const searchFile = join(base, "data", "cache", "npm-search.json");
  const packagesFile = join(base, "data", "cache", "npm-packages.json");
  const distStatsFile = join(base, "dist", "market", "build-stats.json");

  const loadIndex = (file) => {
    const doc = safeJson(file, null);
    return doc && Array.isArray(doc.plugins) ? doc : null;
  };
  const loadRegistry = () => {
    const doc = safeJson(registryFile, {});
    return (doc && doc.packages) || {};
  };
  const loadVerdicts = () => readRepoDirCache(repoDirsFile).entries;
  const loadOverrides = () => readMarketOverrides(paths.overrides);

  /** 单条证据/判定：缓存里的原始证据 + 人工裁决/名单的覆盖结果（后台与生成器同一套口径）。 */
  function evidenceOf(pkg, rec, cacheEntries, overrides) {
    const repository = rec && typeof rec.repository === "string" ? rec.repository : rec && rec.repository && typeof rec.repository.url === "string" ? rec.repository.url : null;
    const repoId = repoKeyOf(repository);
    const directory = rec && typeof rec.repositoryDirectory === "string" && rec.repositoryDirectory.trim() ? rec.repositoryDirectory.trim() : "";
    const key = repoId ? repoDirCacheKey(repoId, directory, pkg) : null;
    const check = key ? cacheEntries[key] ?? null : null;
    const judged = judgeSubdirCheck(check, pkg, check?.repoKey ?? null);
    const manual = decisionFor(overrides, pkg);
    const publisher = rec && typeof rec.npmUser === "string" ? rec.npmUser : null;
    let verdict = judged.verdict;
    let reason = judged.reason;
    let source = "auto";
    if (manual) {
      verdict = manual.decision;
      reason = "manual" + (manual.reason ? ":" + manual.reason : "");
      source = "manual";
    } else {
      const hit = listHit(overrides, { pkg, publisher, repoId });
      if (hit && hit.kind === "publisher") {
        verdict = VERDICT.REFUTED;
        reason = "list:publisher:" + hit.value;
        source = "list";
      } else if (hit && hit.kind === "scope") {
        verdict = VERDICT.REFUTED;
        reason = "list:scope:" + hit.value;
        source = "list";
      } else if (hit && hit.kind === "repo") {
        verdict = VERDICT.UNVERIFIED;
        reason = "list:repo:" + hit.value;
        source = "list";
      } else if (hit && hit.kind === "whitelist-repo") {
        verdict = VERDICT.CONFIRMED;
        reason = "list:whitelist-repo:" + hit.value;
        source = "list";
      }
    }
    return { repository, repoId, directory: directory || null, check, verdict, reason, source, publisher };
  }

  /**
   * 展示层判定：优先认人工/名单，其次认缓存证据，最后回落到索引标签（与用户在市场里看到的一致）。
   * 没有身份、也没有缓存证据的条目单列 unattributed（历史 ambiguous，不冒充"驳回"）。
   */
  function displayVerdict(entry, ev) {
    if (!entry) return ev.verdict;
    if (ev.source !== "auto") return ev.verdict;
    if (!ev.check) {
      const labels = (entry.metadata && entry.metadata.labels) || [];
      if (!labels.includes("owner-unverified")) return VERDICT.CONFIRMED;
      if (entry.author || entry.repository) return VERDICT.UNVERIFIED;
      return "unattributed";
    }
    if (ev.verdict === VERDICT.UNVERIFIED && entry.author && entry.repository) return VERDICT.UNVERIFIED;
    return ev.verdict;
  }

  /** 最近一次构建的结构化统计：优先取当前作业草稿里的 build-stats.json，其次 dist 旁边那份。 */
  function latestBuildStats() {
    const job = jobState();
    const candidates = [];
    if (job && job.id) candidates.push(join(draftDirOf(job.id), "build-stats.json"));
    candidates.push(distStatsFile);
    for (const file of candidates) {
      const doc = safeJson(file, null);
      if (doc && typeof doc === "object" && doc.inputs) return { job, stats: doc, source: relFromRoot(file) };
    }
    return { job, stats: null };
  }

  function countJson(file, pick) {
    const doc = safeJson(file, null);
    if (!doc || typeof doc !== "object") return 0;
    try {
      return pick(doc);
    } catch {
      return 0;
    }
  }

  /**
   * 工作流：把「采集输入 → 候选池 → 组合包筛选 → 归属解析 → 位置核验 → 人工叠加 → 组装自检 → 草稿发布」
   * 八个阶段的进出数字拼成一条流水线。有构建统计用统计（精确），没有就按实时缓存近似（标注 live）。
   */
  function workflowPayload() {
    const dist = loadIndex(distIndex);
    const plugins = dist ? dist.plugins : [];
    const registry = loadRegistry();
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const built = latestBuildStats();
    const stats = built.stats || null;
    const job = built.job || jobState();
    const live = {
      inputs: {
        meshNodes: countJson(meshFile, (d) => (Array.isArray(d.nodes) ? d.nodes.length : 0)),
        downloadsRepos: countJson(downloadsFile, (d) => Object.keys(d.repos || {}).length),
        npmSearchPackages: countJson(searchFile, (d) => Object.keys(d.packages || {}).length),
        npmSubdirPackages: countJson(packagesFile, (d) => Object.keys(d.packages || {}).length),
        registryRecords: Object.keys(registry).length,
      },
      index: { plugins: plugins.length, labels: {}, verdicts: verdictCounts(plugins, registry, cacheEntries, overrides) },
      cache: { entries: Object.keys(cacheEntries).length, states: {} },
      overrides: { entries: Object.keys(overrides.entries || {}).length, lists: overrides.lists },
      dist: { generatedAt: fileMtimeMs(distIndex) ? new Date(fileMtimeMs(distIndex)).toISOString() : null, bytes: fileMtimeMs(distIndex) ? statSync(distIndex).size : 0 },
      mesh: { updatedAt: fileMtimeMs(meshFile) ? new Date(fileMtimeMs(meshFile)).toISOString() : null },
      collector: collectorBusy(),
      job: { id: job.id ?? null, status: job.status ?? "idle", startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null, plugins: job.plugins ?? null, log: job.log ?? null },
      history: historyList().slice(0, 5),
    };
    for (const e of Object.values(cacheEntries)) live.cache.states[e.state] = (live.cache.states[e.state] ?? 0) + 1;
    live.cache.codeSearch = Object.keys(cacheEntries).filter((key) => String(key).includes("#::")).length;
    for (const p of plugins) for (const label of (p.metadata && p.metadata.labels) || []) live.index.labels[label] = (live.index.labels[label] ?? 0) + 1;

    const s = stats || {};
    const inputs = s.inputs || live.inputs;
    const cand = s.candidates || { total: null, picked: null, fromDownloads: null, fromSubdir: null };
    const filters = s.filters || {};
    const verify = s.verification || null;
    const verdicts = (s.verdicts && Object.keys(s.verdicts).length ? s.verdicts : live.index.verdicts) || {};
    const stages = [
      {
        id: "inputs",
        label: "采集输入",
        desc: "npm 下载缓存 + 关键词反查 + 生态图节点；这些是索引的原料",
        nums: [
          ["生态图节点", inputs.meshNodes],
          ["npm 下载缓存仓库", inputs.downloadsRepos],
          ["npm 反查包", inputs.npmSearchPackages],
          ["子目录包缓存", inputs.npmSubdirPackages],
        ],
      },
      {
        id: "candidates",
        label: "候选池",
        desc: "仓库根 package.json 的包 + npm 反查发现、住在子目录里的包",
        nums: [
          ["候选", cand.total],
          ["本轮处理", cand.picked],
          ["来自仓库根", cand.fromDownloads],
          ["来自子目录", cand.fromSubdir],
        ],
      },
      {
        id: "filter",
        label: "组合包筛选",
        desc: "声明了 dsh.bundle 或依赖 @deepseek-ai/* 才算 DSH 包；官方内部模块与人工拉黑不进市场",
        nums: [
          ["收录", s.index ? s.index.plugins : live.index.plugins],
          ["不是 DSH 包", filters.notBundle],
          ["官方内部模块", filters.officialModule],
          ["人工拉黑包", filters.manualBlacklist],
          ["无 packument", filters.noPackument],
        ],
      },
      {
        id: "owner",
        label: "归属解析",
        desc: "npm 自述仓库 vs 认领仓库：两边一致才算「确证」，只有弱证据就打「作者待确认」",
        nums: [
          ["确证", verdicts.confirmed],
          ["待确认", verdicts.unverified],
          ["驳回", verdicts.refuted],
          ["未归属", verdicts.unattributed],
        ],
      },
      {
        id: "verify",
        label: "位置核验",
        desc: "目录 package.json 实名核对 → 404 查历史 → 没目录走 code search + gitHead",
        nums: verify
          ? [
              ["待核验", verify.targets],
              ["确证", verify.verified],
              ["目录搬走", verify.moved],
              ["目录不存在", verify.missing],
              ["本地路径", verify.local],
              ["code search 结论", live.cache.codeSearch],
              ["有发布溯源", s.provenance ? s.provenance.ok : null],
            ]
          : [
              ["缓存结论", live.cache.entries],
              ...Object.entries(live.cache.states),
            ],
      },
      {
        id: "override",
        label: "人工叠加",
        desc: "人工裁决 > 名单 > 自动核验；裁决与名单都写在 overrides.json",
        nums: [
          ["人工裁决", live.overrides.entries],
          ["包名黑名单", (live.overrides.lists.blacklistPackages || []).length],
          ["作者作用域黑名单", (live.overrides.lists.blacklistScopes || []).length],
          ["发布者名单", (live.overrides.lists.blacklistPublishers || []).length],
          ["仓库名单", (live.overrides.lists.blacklistRepos || []).length],
          ["命中条目", Object.values(s.overrides || {}).reduce((a, b) => a + b, 0)],
        ],
      },
      {
        id: "assemble",
        label: "组装与自检",
        desc: "插件名 = 包名；驳回脱身份、未核实打标签；最后跑归属自检",
        nums: [
          ["索引条目", s.index ? s.index.plugins : live.index.plugins],
          ["分类", s.index ? s.index.categories : null],
          ["索引仓库光环", s.index ? s.index.haloRepos : null],
          ["作者待确认", live.index.labels["owner-unverified"]],
          ["仓库内子包", live.index.labels["subdir-package"]],
        ],
      },
      {
        id: "publish",
        label: "草稿与发布",
        desc: "构建只写草稿 → 差异预览 → 人工发布 → 原子替换 dist；保留最近 10 版可回滚",
        nums: [
          ["线上条目", live.index.plugins],
          ["历史版本", live.history.length],
          ["最近构建", live.job.status],
          ["dist 生成", live.dist.generatedAt ? live.dist.generatedAt.replace("T", " ").slice(0, 16) : null],
        ],
      },
    ];
    return {
      generatedAt: nowIso(),
      live,
      lastBuild: (() => {
        const startedAt = job.startedAt ?? (stats && stats.startedAt) ?? null;
        const finishedAt = job.finishedAt ?? (stats && stats.finishedAt) ?? null;
        return {
          jobId: job.id ?? null,
          status: job.status ?? (stats ? "stats-only" : "idle"),
          startedAt,
          finishedAt,
          durationMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
        statsSource: stats ? built.source : null,
        stats: stats
          ? {
              inputs: s.inputs || null,
              candidates: s.candidates || null,
              filters: s.filters || null,
              verification: s.verification || null,
              provenance: s.provenance || null,
              provenanceVerdicts: s.provenanceVerdicts || null,
              selfCheck: s.selfCheck || null,
              verdicts: s.verdicts || null,
              overrides: s.overrides || null,
              labels: s.labels || null,
              timings: s.timings || null,
              index: s.index || null,
              skipped: s.skipped || null,
              seed: s.seed ?? null,
            }
          : null,
          skippedTop: (s.skipped && Array.isArray(s.skipped.top) ? s.skipped.top : []).slice(0, 20),
          logTail: job.log ? tailLines(join(base, job.log), 40) : [],
        };
      })(),
      stages,
    };
  }

  function collectorBusy() {
    const doc = safeJson(statusFile, null);
    if (!doc || !doc.state) return null;
    const running = ["crawling", "building", "precomputing"].includes(String(doc.state));
    if (!running) return null;
    const updated = Date.parse(String(doc.updatedAt ?? ""));
    if (Number.isFinite(updated) && Date.now() - updated > 10 * 60000) return null;
    return { state: String(doc.state), updatedAt: doc.updatedAt ?? null, nextRunAt: doc.nextRunAt ?? null };
  }

  function jobState() {
    const job = safeJson(paths.job, null);
    if (!job || !job.id) return { id: null, status: "idle", logTail: [] };
    if (job.status === "running" && Number.isFinite(Date.parse(String(job.startedAt ?? ""))) && Date.now() - Date.parse(job.startedAt) > BUILD_TIMEOUT_MS) {
      job.status = "failed";
      job.note = "构建超时（进程可能已不在）";
    }
    job.logTail = job.log ? tailLines(join(base, job.log), 60) : [];
    return job;
  }

  const draftDirOf = (jobId) => join(paths.drafts, String(jobId ?? "").replace(/[^A-Za-z0-9_-]/g, ""));

  function historyList() {
    try {
      return readdirSync(paths.history)
        .filter((f) => /^index-\d{8}T\d{4,6}\.json$/.test(f))
        .sort()
        .reverse()
        .map((f) => {
          const file = join(paths.history, f);
          const doc = loadIndex(file);
          return { ts: f.replace(/^index-/, "").replace(/\.json$/, ""), file: f, bytes: statSync(file).size, plugins: doc ? doc.plugins.length : null, builtAt: doc && doc.title ? null : null };
        });
    } catch {
      return [];
    }
  }

  // ---------- 只读载荷 ----------

  function verdictCounts(plugins, registry, cacheEntries, overrides) {
    const out = { confirmed: 0, unverified: 0, refuted: 0, unattributed: 0, manual: 0 };
    for (const p of plugins) {
      const ev = evidenceOf(p.name, registry[p.name], cacheEntries, overrides);
      const verdict = displayVerdict(p, ev);
      out[verdict] = (out[verdict] ?? 0) + 1;
      if (ev.source !== "auto") out.manual += 1;
    }
    return out;
  }

  function overviewPayload() {
    const dist = loadIndex(distIndex);
    const registry = loadRegistry();
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const plugins = dist ? dist.plugins : [];
    const counts = verdictCounts(plugins, registry, cacheEntries, overrides);
    const labelCounts = {};
    for (const p of plugins) for (const label of (p.metadata && p.metadata.labels) || []) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
    const cacheStates = {};
    for (const e of Object.values(cacheEntries)) cacheStates[e.state] = (cacheStates[e.state] ?? 0) + 1;
    const job = jobState();
    const meshMtime = fileMtimeMs(meshFile);
    const distMtime = fileMtimeMs(distIndex);
    const overridesEntries = Object.keys(overrides.entries || {}).length;
    const draft = job.status === "running" || job.status === "done" || job.status === "failed" ? job : null;
    return {
      plugins: plugins.length,
      verdicts: counts,
      labels: labelCounts,
      cache: { entries: Object.keys(cacheEntries).length, states: cacheStates },
      overrides: { entries: overridesEntries, lists: overrides.lists },
      dist: { generatedAt: distMtime ? new Date(distMtime).toISOString() : null, bytes: distMtime ? statSync(distIndex).size : 0, nodesBytes: fileMtimeMs(distNodes) ? statSync(distNodes).size : 0 },
      mesh: { updatedAt: meshMtime ? new Date(meshMtime).toISOString() : null, lagSeconds: distMtime && meshMtime ? Math.round((meshMtime - distMtime) / 1000) : null },
      collector: collectorBusy(),
      job,
      draft: draft ? { id: draft.id, status: draft.status, startedAt: draft.startedAt ?? null, publishable: draft.status === "done" } : null,
      history: historyList().slice(0, 5),
    };
  }

  function listPlugins(url) {
    const dist = loadIndex(distIndex);
    const plugins = dist ? dist.plugins : [];
    const registry = loadRegistry();
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
    const state = String(url.searchParams.get("state") ?? "").trim();
    const label = String(url.searchParams.get("label") ?? "").trim();
    const page = clampInt(url.searchParams.get("page"), 1, 100000, 1);
    const size = clampInt(url.searchParams.get("size"), 1, 200, 50);
    const rows = [];
    for (const p of plugins) {
      const labels = (p.metadata && p.metadata.labels) || [];
      if (label && !labels.includes(label)) continue;
      const ev = evidenceOf(p.name, registry[p.name], cacheEntries, overrides);
      const verdict = displayVerdict(p, ev);
      if (state && verdict !== state) continue;
      const author = p.author || "";
      const repoUrl = (p.repository && p.repository.url) || "";
      if (q) {
        const hay = (p.name + " " + (p.title || "") + " " + author + " " + repoUrl).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      rows.push({
        name: p.name,
        title: p.title || null,
        author: p.author || null,
        repository: repoUrl || null,
        verdict,
        reason: ev.reason,
        source: ev.source,
        stars: (p.metadata && p.metadata.sortKeys && p.metadata.sortKeys.stars) || 0,
        downloads: (p.metadata && p.metadata.sortKeys && p.metadata.sortKeys.downloads) || 0,
        labels,
        version: p.versions && p.versions[0] ? p.versions[0].version : null,
      });
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const total = rows.length;
    return { total, page, size, rows: rows.slice((page - 1) * size, page * size) };
  }

  function pluginDetail(name) {
    const dist = loadIndex(distIndex);
    const entry = dist ? dist.plugins.find((p) => p.name === name) ?? null : null;
    const registry = loadRegistry();
    const rec = registry[name] ?? null;
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const ev = evidenceOf(name, rec, cacheEntries, overrides);
    return {
      name,
      entry,
      evidence: ev,
      verdict: displayVerdict(entry, ev),
      manual: decisionFor(overrides, name),
      npm: rec ? { publisher: rec.npmUser ?? null, repository: ev.repository, directory: ev.directory, latest: rec.latestTag ?? null, versions: (rec.versions || []).length } : null,
      install: entry && entry.versions && entry.versions[0] ? name + "@" + entry.versions[0].version : null,
    };
  }

  function queuePayload(url) {
    const type = String(url.searchParams.get("type") ?? "refuted").trim();
    const size = clampInt(url.searchParams.get("size"), 1, 200, 50);
    const dist = loadIndex(distIndex);
    const plugins = dist ? dist.plugins : [];
    const registry = loadRegistry();
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const rows = [];
    for (const p of plugins) {
      const ev = evidenceOf(p.name, registry[p.name], cacheEntries, overrides);
      const verdict = displayVerdict(p, ev);
      const match =
        (type === "refuted" && verdict === VERDICT.REFUTED) ||
        (type === "nodir" && verdict === VERDICT.UNVERIFIED && String(ev.reason || "").startsWith("no-directory")) ||
        (type === "unattributed" && verdict === "unattributed") ||
        (type === "manual" && ev.source !== "auto") ||
        (type === "error" && ev.check && ev.check.state === "error");
      if (!match) continue;
      rows.push({ name: p.name, reason: ev.reason, source: ev.source, repository: ev.repository, publisher: ev.publisher, directory: ev.directory, verdict });
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { type, total: rows.length, rows: rows.slice(0, size) };
  }

  // ---------- 写操作：人工裁决 ----------

  function decisionImpact(name, decision) {
    const dist = loadIndex(distIndex);
    const entry = dist ? dist.plugins.find((p) => p.name === name) : null;
    if (!entry) return "当前索引里没有这个包；裁决已保存，下次出现时生效。";
    const labels = (entry.metadata && entry.metadata.labels) || [];
    const hadIdentity = Boolean(entry.author || entry.repository);
    if (decision === "refuted") return hadIdentity ? "会脱掉仓库身份（标题/作者/仓库/星标）并挂「作者待确认」。" : "本来就未借身份，效果是确认驳回标记。";
    if (decision === "confirmed") return hadIdentity ? "会按确证展示（去掉「作者待确认」）。" : "会把声称的仓库身份恢复为确证展示。";
    return hadIdentity ? "保留身份展示，但挂「作者待确认」。" : "保持不署名并挂「作者待确认」。";
  }

  function saveDecision(body) {
    const name = String(body.name ?? "").trim();
    if (!PACKAGE_NAME_RE.test(name) || name.length > 214) return { error: "包名不合法" };
    const decision = String(body.decision ?? "").trim();
    if (!DECISIONS.includes(decision)) return { error: "decision 只能是 " + DECISIONS.join(" / ") };
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    const overrides = loadOverrides();
    overrides.entries[name] = { decision, reason, at: nowIso(), source: "manual" };
    const written = saveMarketOverrides(paths.overrides, overrides);
    return { ok: true, name, decision, impact: decisionImpact(name, decision), backedUp: written.backedUp };
  }

  function removeDecision(name) {
    const pkg = String(name ?? "").trim();
    if (!PACKAGE_NAME_RE.test(pkg)) return { error: "包名不合法" };
    const overrides = loadOverrides();
    if (!overrides.entries[pkg]) return { ok: true, name: pkg, removed: false };
    delete overrides.entries[pkg];
    const written = saveMarketOverrides(paths.overrides, overrides);
    return { ok: true, name: pkg, removed: true, backedUp: written.backedUp };
  }

  // ---------- 写操作：构建/差异/发布/回滚 ----------

  function startBuild(body) {
    const current = jobState();
    if (current.status === "running") return { busy: true, job: current };
    const busy = collectorBusy();
    if (busy) return { conflict: "采集器正在跑（" + busy.state + "），等这轮结束再重建索引", collector: busy };
    const id = nowIso().replace(/[-:]/g, "").slice(0, 15);
    const dir = draftDirOf(id);
    ensureDir(dir);
    ensureDir(paths.logDir);
    const logFile = join(paths.logDir, "market-index-" + id + ".log");
    const args = [
      "--max-old-space-size=256",
      join(base, "tools", "market-index.mjs"),
      "--limit",
      String(clampInt(body.limit, 1, 50000, 20000)),
      "--concurrency",
      String(clampInt(body.concurrency, 1, 8, 4)),
      "--out",
      join(dir, "index.json"),
      "--overrides",
      paths.overrides,
    ];
    if (body.seed !== undefined) args.push("--seed", String(clampInt(body.seed, 0, 2 ** 31, 1)));
    if (body.noCodeSearch === true) args.push("--no-subdir-verify");
    const fd = openSync(logFile, "a");
    let proc;
    try {
      proc = spawn(process.execPath, args, { cwd: base, stdio: ["ignore", fd, fd], env: process.env });
    } catch (err) {
      closeSync(fd);
      return { error: "无法启动构建进程：" + String(err && err.message ? err.message : err) };
    }
    closeSync(fd);
    const job = {
      id,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      exitCode: null,
      pid: proc.pid ?? null,
      command: "node tools/market-index.mjs --out " + relFromRoot(join(dir, "index.json")),
      log: relFromRoot(logFile),
      draft: relFromRoot(join(dir, "index.json")),
      note: "索引重建：先写草稿，需人工确认后发布",
    };
    atomicWriteJson(paths.job, job);
    proc.on("exit", (code, signal) => {
      const draftFile = join(dir, "index.json");
      const doc = loadIndex(draftFile);
      const summary = summarizeDraft(doc, draftFile);
      const finished = {
        ...job,
        status: code === 0 && doc ? "done" : "failed",
        exitCode: code,
        signal: signal ?? null,
        finishedAt: nowIso(),
        plugins: doc ? doc.plugins.length : null,
        stats: summary,
      };
      if (!doc) finished.note = "构建没有产出可用草稿（看日志）";
      atomicWriteJson(paths.job, finished);
      atomicWriteJson(paths.lastBuild, { ...finished, jobId: id });
    });
    proc.on("error", (err) => {
      atomicWriteJson(paths.job, { ...job, status: "failed", finishedAt: nowIso(), note: String(err && err.message ? err.message : err) });
    });
    return { job: jobState() };
  }

  function summarizeDraft(doc) {
    if (!doc || !Array.isArray(doc.plugins)) return null;
    const registry = loadRegistry();
    const cacheEntries = loadVerdicts();
    const overrides = loadOverrides();
    const counts = { confirmed: 0, unverified: 0, refuted: 0, manual: 0 };
    for (const p of doc.plugins) {
      const ev = evidenceOf(p.name, registry[p.name], cacheEntries, overrides);
      counts[ev.verdict] = (counts[ev.verdict] ?? 0) + 1;
      if (ev.source !== "auto") counts.manual += 1;
    }
    return counts;
  }

  const fieldOf = (p, field) => {
    if (!p) return null;
    if (field === "stars") return (p.metadata && p.metadata.sortKeys && p.metadata.sortKeys.stars) || 0;
    if (field === "labels") return ((p.metadata && p.metadata.labels) || []).slice().sort().join(",");
    if (field === "title") return p.title || p.name || null; // title 省略时按 name 比，避免发布后整表报「标题变化」
    if (field === "author") return p.author || null;
    if (field === "repository") return (p.repository && p.repository.url) || null;
    if (field === "version") return p.versions && p.versions[0] ? p.versions[0].version : null;
    return null;
  };

  /** 草稿 vs 线上：新增/移除/标签/身份/标题·描述 五组差异。 */
  function diffIndexes(nextDoc, prevDoc) {
    const next = new Map((nextDoc && nextDoc.plugins ? nextDoc.plugins : []).map((p) => [p.name, p]));
    const prev = new Map((prevDoc && prevDoc.plugins ? prevDoc.plugins : []).map((p) => [p.name, p]));
    const out = { added: [], removed: [], labelChanged: [], identityChanged: [], titleChanged: [] };
    for (const [name, p] of next) if (!prev.has(name)) out.added.push({ name });
    for (const [name, p] of prev) if (!next.has(name)) out.removed.push({ name });
    for (const [name, p] of next) {
      const before = prev.get(name);
      if (!before) continue;
      if (fieldOf(p, "labels") !== fieldOf(before, "labels")) {
        out.labelChanged.push({ name, before: fieldOf(before, "labels"), after: fieldOf(p, "labels") });
      }
      const idFields = ["author", "repository", "stars"];
      if (idFields.some((f) => fieldOf(p, f) !== fieldOf(before, f))) {
        out.identityChanged.push({
          name,
          author: { before: fieldOf(before, "author"), after: fieldOf(p, "author") },
          repository: { before: fieldOf(before, "repository"), after: fieldOf(p, "repository") },
          stars: { before: fieldOf(before, "stars"), after: fieldOf(p, "stars") },
        });
      }
      if (fieldOf(p, "title") !== fieldOf(before, "title")) out.titleChanged.push({ name, before: fieldOf(before, "title"), after: fieldOf(p, "title") });
    }
    return out;
  }

  function diffPayload(jobId) {
    const dir = draftDirOf(jobId);
    const draft = loadIndex(join(dir, "index.json"));
    if (!draft) return { error: "没有这个构建草稿：" + String(jobId ?? "") };
    const current = loadIndex(distIndex);
    const diff = diffIndexes(draft, current);
    const brief = {
      added: diff.added.length,
      removed: diff.removed.length,
      labelChanged: diff.labelChanged.length,
      identityChanged: diff.identityChanged.length,
      titleChanged: diff.titleChanged.length,
    };
    atomicWriteJson(join(dir, "diff.json"), { jobId, at: nowIso(), brief, diff });
    return { jobId, brief, draft: { plugins: draft.plugins.length }, current: { plugins: current ? current.plugins.length : 0 }, diff };
  }

  function publish(jobId) {
    const id = String(jobId ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return { error: "jobId 不合法" };
    const dir = draftDirOf(id);
    const draftFile = join(dir, "index.json");
    const draft = loadIndex(draftFile);
    if (!draft || !draft.plugins.length) return { error: "草稿不存在或为空，先构建" };
    ensureDir(paths.history);
    ensureDir(dirname(distIndex));
    const ts = nowIso().replace(/[-:]/g, "").slice(0, 15);
    if (existsSync(distIndex)) copyFileSync(distIndex, join(paths.history, "index-" + ts + ".json"));
    if (existsSync(distNodes)) copyFileSync(distNodes, join(paths.history, "nodes-" + ts + ".json"));
    for (const f of readdirSync(paths.history).filter((f) => /^(index|nodes)-\d{8}T\d{4,6}\.json$/.test(f)).sort().reverse().slice(HISTORY_KEEP * 2)) {
      try {
        unlinkSync(join(paths.history, f));
      } catch {
        /* 清理失败不影响发布 */
      }
    }
    writeFileSync(draftFile + ".publish", readFileSync(draftFile));
    renameSync(draftFile + ".publish", distIndex);
    const draftNodes = join(dir, "index-nodes.json");
    if (existsSync(draftNodes)) {
      writeFileSync(distNodes + ".publish", readFileSync(draftNodes));
      renameSync(distNodes + ".publish", distNodes);
    }
    /* 预压缩产物随发布一起更新：草稿里没有（老构建/旧版本）就删掉线上旧压缩件，
       让 serve.mjs 回落到运行时压缩，绝不能把旧 .gz/.br 配着新 index.json 发出去。 */
    for (const ext of [".gz", ".br"]) {
      const draftPack = draftFile + ext;
      const distPack = distIndex + ext;
      if (existsSync(draftPack)) {
        writeFileSync(distPack + ".publish", readFileSync(draftPack));
        renameSync(distPack + ".publish", distPack);
      } else {
        try {
          unlinkSync(distPack);
        } catch {
          /* 本来就没有 */
        }
      }
    }
    return { ok: true, jobId: id, backupTs: ts, plugins: draft.plugins.length };
  }

  function rollback(ts) {
    const stamp = String(ts ?? "").replace(/[^0-9T]/g, "");
    const src = join(paths.history, "index-" + stamp + ".json");
    if (!existsSync(src)) return { error: "没有这个历史版本：" + stamp };
    const doc = loadIndex(src);
    if (!doc || !doc.plugins.length) return { error: "历史版本不可用" };
    writeFileSync(distIndex + ".rollback", readFileSync(src));
    renameSync(distIndex + ".rollback", distIndex);
    const nodes = join(paths.history, "nodes-" + stamp + ".json");
    if (existsSync(nodes)) {
      writeFileSync(distNodes + ".rollback", readFileSync(nodes));
      renameSync(distNodes + ".rollback", distNodes);
    }
    // 历史备份只有 index.json：删掉当前预压缩件，避免旧 .gz/.br 配上回滚后的 index.json
    for (const ext of [".gz", ".br"]) {
      try {
        unlinkSync(distIndex + ext);
      } catch {
        /* 没有就算了 */
      }
    }
    return { ok: true, ts: stamp, plugins: doc.plugins.length };
  }

  // ---------- 路由 ----------

  function cachePayload(url) {
    const entries = loadVerdicts();
    const state = String(url.searchParams.get("state") ?? "").trim();
    const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
    const page = clampInt(url.searchParams.get("page"), 1, 100000, 1);
    const size = clampInt(url.searchParams.get("size"), 1, 200, 50);
    const stats = {};
    const rows = [];
    for (const [key, entry] of Object.entries(entries)) {
      stats[entry.state] = (stats[entry.state] ?? 0) + 1;
      if (state && entry.state !== state) continue;
      if (q && !key.toLowerCase().includes(q)) continue;
      rows.push({ key, state: entry.state, reason: entry.reason ?? null, name: entry.name ?? null, at: entry.at ?? null, via: entry.via ?? null });
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : 1));
    return { total: rows.length, page, size, states: stats, entries: rows.slice((page - 1) * size, page * size), file: { bytes: fileMtimeMs(repoDirsFile) ? statSync(repoDirsFile).size : 0, updatedAt: fileMtimeMs(repoDirsFile) ? new Date(fileMtimeMs(repoDirsFile)).toISOString() : null } };
  }

  /** 标签（市场里的「分类」胶囊）：清单 + 当前是否隐藏 + 产物里的条目数。 */
  function labelsPayload() {
    const dist = loadIndex(distIndex);
    const plugins = dist ? dist.plugins : [];
    const declared = (dist && dist.metadata && dist.metadata.labels) || {};
    const overrides = loadOverrides();
    const hidden = new Set((overrides.labels && overrides.labels.hidden) || []);
    const counts = new Map();
    for (const p of plugins) for (const id of (p.metadata && p.metadata.labels) || []) counts.set(id, (counts.get(id) ?? 0) + 1);
    const ids = [...new Set([...MARKET_LABELS.map((item) => item.id), ...Object.keys(declared), ...counts.keys(), ...hidden])];
    const labels = ids
      .map((id) => {
        const def = marketLabel(id);
        const title = (declared[id] && declared[id].title) || (def ? { en: def.en, zh: def.zh } : { en: id, zh: id });
        return { id, title, hidden: hidden.has(id), count: counts.get(id) ?? 0 };
      })
      .sort((a, b) => (a.hidden === b.hidden ? b.count - a.count : a.hidden ? 1 : -1));
    return { labels, hidden: [...hidden] };
  }

  /** 保存隐藏标签：写 overrides.labels.hidden（重建 + 发布后生效）。 */
  function saveLabels(body) {
    const action = String(body?.action ?? "set");
    const overrides = loadOverrides();
    const current = new Set((overrides.labels && overrides.labels.hidden) || []);
    if (action === "set") {
      if (!Array.isArray(body.hidden)) return { error: "hidden 必须是数组" };
      const unknown = body.hidden.map(String).filter((id) => !marketLabel(id));
      if (unknown.length) return { error: "未知标签：" + unknown.slice(0, 5).join("、") };
      overrides.labels.hidden = [...new Set(body.hidden.map(String))];
    } else if (action === "hide" || action === "show") {
      const id = String(body.id ?? "");
      if (!marketLabel(id)) return { error: "未知标签：" + id };
      if (action === "hide") current.add(id);
      else current.delete(id);
      overrides.labels.hidden = [...current];
    } else {
      return { error: "action 只能是 set / hide / show" };
    }
    const written = saveMarketOverrides(paths.overrides, overrides);
    const payload = labelsPayload();
    const hidden = new Set(payload.hidden);
    const impacted = payload.labels.filter((label) => hidden.has(label.id)).reduce((sum, label) => sum + label.count, 0);
    return { ok: true, ...payload, impacted, backedUp: written.backedUp };
  }

  function listsPayload() {
    const overrides = loadOverrides();
    return { entries: Object.entries(overrides.entries).map(([name, row]) => ({ name, ...row })), lists: overrides.lists };
  }

  function logsPayload(url) {
    const name = String(url.searchParams.get("name") ?? "").trim();
    if (name) {
      if (!/^market-index-\d{8}T\d{4,6}\.log$/.test(name)) return { error: "日志不存在，或不在可读白名单里" };
      return { name, lines: tailLines(join(paths.logDir, name), 200) };
    }
    const files = existsSync(paths.logDir) ? readdirSync(paths.logDir).filter((f) => /^market-index-\d{8}T\d{4,6}\.log$/.test(f)).sort().reverse().slice(0, 20) : [];
    return { files };
  }

  async function handle(name, ctx) {
    const send = ctx.sendJson ?? sendJson;
    const readBody = ctx.readJsonBody ?? readJsonBody;
    const write = ctx.write ?? (() => {});
    const method = ctx.method;
    const url = ctx.url;
    const isGet = method === "GET" || method === "HEAD";
    const route = String(name || "").replace(/^market\/?/u, "");
    const requireGet = () => (isGet ? null : send(ctx.res, 405, { error: "只允许 GET" }));

    if (route === "overview") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, overviewPayload());
    }
    if (route === "workflow") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, workflowPayload());
    }
    if (route === "plugins") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, listPlugins(url));
    }
    if (route === "plugin") {
      const bad = requireGet();
      if (bad !== null) return bad;
      const pkg = String(url.searchParams.get("name") ?? "").trim();
      if (!pkg) return send(ctx.res, 400, { error: "缺少 name" });
      return send(ctx.res, 200, pluginDetail(pkg));
    }
    if (route === "queue") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, queuePayload(url));
    }
    if (route === "cache") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, cachePayload(url));
    }
    if (route === "lists") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, listsPayload());
    }
    if (route === "labels") {
      if (isGet) return send(ctx.res, 200, labelsPayload());
      if (method !== "POST") return send(ctx.res, 405, { error: "只允许 GET / POST" });
      const parsed = await readBody(ctx.req);
      if (parsed.error) return send(ctx.res, 400, { error: parsed.error });
      const result = saveLabels(parsed.value);
      if (result.error) return send(ctx.res, 400, { error: result.error });
      write("market-labels-set", "hidden=" + (result.hidden.join(",") || "(none)") + " impacted=" + result.impacted);
      return send(ctx.res, 200, result);
    }
    if (route === "history") {
      const bad = requireGet();
      if (bad !== null) return bad;
      return send(ctx.res, 200, { history: historyList() });
    }
    if (route === "logs") {
      const bad = requireGet();
      if (bad !== null) return bad;
      const payload = logsPayload(url);
      if (payload.error) return send(ctx.res, 404, { error: payload.error });
      return send(ctx.res, 200, payload);
    }
    if (route === "decision") {
      if (method === "DELETE") {
        const result = removeDecision(url.searchParams.get("name"));
        if (result.error) return send(ctx.res, 400, { error: result.error });
        write("market-decision-removed", result.name);
        return send(ctx.res, 200, result);
      }
      if (method !== "POST") return send(ctx.res, 405, { error: "只允许 POST / DELETE" });
      const parsed = await readBody(ctx.req);
      if (parsed.error) return send(ctx.res, 400, { error: parsed.error });
      if (parsed.value.remove === true) {
        const removed = removeDecision(parsed.value.name);
        if (removed.error) return send(ctx.res, 400, { error: removed.error });
        write("market-decision-removed", removed.name);
        return send(ctx.res, 200, removed);
      }
      const result = saveDecision(parsed.value);
      if (result.error) return send(ctx.res, 400, { error: result.error });
      write("market-decision", result.name + " -> " + result.decision + (parsed.value.reason ? "：" + String(parsed.value.reason).slice(0, 120) : ""));
      return send(ctx.res, 200, result);
    }
    if (route === "build") {
      if (isGet) return send(ctx.res, 200, { job: jobState() });
      if (method !== "POST") return send(ctx.res, 405, { error: "只允许 GET / POST" });
      const parsed = await readBody(ctx.req);
      if (parsed.error) return send(ctx.res, 400, { error: parsed.error });
      const started = startBuild(parsed.value || {});
      if (started.busy) return send(ctx.res, 409, { error: "已有一个构建任务在跑", job: started.job });
      if (started.conflict) return send(ctx.res, 409, { error: started.conflict, collector: started.collector });
      if (started.error) return send(ctx.res, 500, { error: started.error });
      write("market-build-started", started.job && started.job.id ? started.job.id : "");
      return send(ctx.res, 200, { ok: true, job: started.job });
    }
    if (route === "diff") {
      const bad = requireGet();
      if (bad !== null) return bad;
      const jobId = String(url.searchParams.get("jobId") ?? "").trim();
      if (!jobId) return send(ctx.res, 400, { error: "缺少 jobId" });
      const payload = diffPayload(jobId);
      if (payload.error) return send(ctx.res, 404, { error: payload.error });
      return send(ctx.res, 200, payload);
    }
    if (route === "publish") {
      if (method !== "POST") return send(ctx.res, 405, { error: "只允许 POST" });
      const parsed = await readBody(ctx.req);
      if (parsed.error) return send(ctx.res, 400, { error: parsed.error });
      if (parsed.value.confirm !== true) return send(ctx.res, 400, { error: "发布是线上变更，需要 confirm:true" });
      const result = publish(parsed.value.jobId);
      if (result.error) return send(ctx.res, 400, { error: result.error });
      write("market-published", "job=" + result.jobId + " plugins=" + result.plugins + " backup=" + result.backupTs);
      return send(ctx.res, 200, result);
    }
    if (route === "rollback") {
      if (method !== "POST") return send(ctx.res, 405, { error: "只允许 POST" });
      const parsed = await readBody(ctx.req);
      if (parsed.error) return send(ctx.res, 400, { error: parsed.error });
      if (parsed.value.confirm !== true) return send(ctx.res, 400, { error: "回滚是线上变更，需要 confirm:true" });
      const result = rollback(parsed.value.ts);
      if (result.error) return send(ctx.res, 400, { error: result.error });
      write("market-rollback", "ts=" + result.ts + " plugins=" + result.plugins);
      return send(ctx.res, 200, result);
    }
    return send(ctx.res, 404, { error: "未知索引源接口：" + route });
  }

  return { handle, paths, overviewPayload, workflowPayload, listPlugins, pluginDetail, queuePayload, cachePayload, listsPayload, labelsPayload, saveLabels, saveDecision, removeDecision, startBuild, jobState, diffPayload, diffIndexes, publish, rollback, historyList, evidenceOf };
}
