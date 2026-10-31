/**
 * 索引源后台（tools/market-admin.mjs + tools/market-overrides.mjs）单元测试。
 *
 * 盯的是"人工裁决不能把索引改坏"这条线：
 *  · overrides 规范化/原子写/坏文件兜底；
 *  · 裁决优先级（entries > 名单 > 自动）；
 *  · diff 五组差异；
 *  · publish/rollback 的备份与原子替换；
 *  · 构建防并发（采集器/已有构建在跑时拒绝）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realMarketDir = process.env.MARKET_DIR;
delete process.env.MARKET_DIR;

const {
  normalizeOverrides,
  readMarketOverrides,
  saveMarketOverrides,
  decisionFor,
  hiddenLabelIds,
  listHit,
  marketPaths,
  packageBlacklistReason,
  scopeOfPackage,
} = await import("../tools/market-overrides.mjs");
const { applyAttributionOverrides } = await import("../tools/market-index.mjs");
const { createMarketAdmin } = await import("../tools/market-admin.mjs");

const AUTO_BASE = { identity: { id: "a/b" }, refuted: false, attributionVerified: true, subdirLabel: false };

function nodeOf(id) {
  return { id, name: id.split("/")[1], owner: id.split("/")[0], stars: 100 };
}

test("overrides 规范化：非法条目丢弃、名单去重限量、未知字段不保留", () => {
  const doc = normalizeOverrides({
    version: 99,
    entries: {
      "dsh-market-plus": { decision: "refuted", reason: "仓库无此包", at: "2026-10-23T14:20:00Z", other: 1 },
      "bad name": { decision: "refuted" },
      "x": { decision: "maybe" },
    },
    lists: {
      blacklistPackages: ["@chatcode/cco-market", "@chatcode/cco-market", "bad name"],
      blacklistPublishers: ["owltechcode", "owltechcode"],
      blacklistRepos: ["dsh-market/dsh-market", "nope"],
      whitelistRepos: ["zhu1090093659/dsh-web"],
    },
  });
  assert.equal(doc.version, 1);
  assert.deepEqual(Object.keys(doc.entries), ["dsh-market-plus"]);
  assert.equal(doc.entries["dsh-market-plus"].decision, "refuted");
  assert.equal(doc.entries["dsh-market-plus"].other, undefined);
  assert.deepEqual(doc.lists.blacklistPackages, ["@chatcode/cco-market"]);
  assert.deepEqual(doc.lists.blacklistPublishers, ["owltechcode"]);
  assert.deepEqual(doc.lists.blacklistRepos, ["dsh-market/dsh-market"]);
  assert.deepEqual(doc.lists.whitelistRepos, ["zhu1090093659/dsh-web"]);
  assert.equal(decisionFor(doc, "dsh-market-plus").decision, "refuted");
  assert.equal(listHit(doc, { publisher: "owltechcode" }).kind, "publisher");
  assert.equal(listHit(doc, { repoId: "zhu1090093659/dsh-web" }).kind, "whitelist-repo");
});

test("overrides 读/写：留 .bak、原子替换、坏文件当空表", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-overrides-"));
  try {
    const file = join(dir, "overrides.json");
    assert.deepEqual(readMarketOverrides(file).entries, {}, "文件不存在 = 空表");
    saveMarketOverrides(file, { entries: { "a": { decision: "confirmed" } } });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).entries.a.decision, "confirmed");
    const second = saveMarketOverrides(file, { entries: {} });
    assert.equal(second.backedUp, true, "第二次写要留 .bak");
    assert.ok(existsSync(file + ".bak"));
    writeFileSync(file, "{broken");
    assert.deepEqual(readMarketOverrides(file).entries, {}, "坏文件不能把生成器搞崩");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("裁决优先级：entries > 名单 > 自动", () => {
  const node = nodeOf("dsh-market/dsh-market");
  const overrides = normalizeOverrides({
    entries: { "pkg-manual": { decision: "confirmed" } },
    lists: { blacklistPublishers: ["owltechcode"], blacklistRepos: ["dsh-market/dsh-market"], whitelistRepos: ["zhu1090093659/dsh-web"] },
  });
  // 自动确证，但没有 overrides：原样
  const auto = applyAttributionOverrides({ pkg: "pkg-a", base: AUTO_BASE, node, rec: { npmUser: "owner" }, repoId: "a/b", overrides: null });
  assert.equal(auto.attributionVerified, true);
  assert.equal(auto.source, "auto");
  // 发布者名单 -> 展示等同驳回（脱身份）
  const pub = applyAttributionOverrides({ pkg: "pkg-b", base: AUTO_BASE, node, rec: { npmUser: "owltechcode" }, repoId: "a/b", overrides });
  assert.equal(pub.refuted, true);
  assert.equal(pub.identity, null);
  assert.equal(pub.source, "list:publisher");
  // 仓库名单 -> 保留身份但不算确证
  const repo = applyAttributionOverrides({ pkg: "pkg-c", base: AUTO_BASE, node, rec: { npmUser: "someone" }, repoId: "dsh-market/dsh-market", overrides });
  assert.equal(repo.attributionVerified, false);
  assert.deepEqual(repo.identity, AUTO_BASE.identity, "仓库名单只降级、不抹掉原来的身份");
  // 仓库白名单 -> 人工背书按确证
  const white = applyAttributionOverrides({ pkg: "pkg-d", base: { ...AUTO_BASE, attributionVerified: false }, node, rec: {}, repoId: "zhu1090093659/dsh-web", overrides });
  assert.equal(white.attributionVerified, true);
  // 人工裁决压过名单
  const manual = applyAttributionOverrides({ pkg: "pkg-manual", base: { ...AUTO_BASE, refuted: true, identity: null, attributionVerified: false }, node, rec: { npmUser: "owltechcode" }, repoId: "dsh-market/dsh-market", overrides });
  assert.equal(manual.refuted, false);
  assert.equal(manual.identity, node);
  assert.equal(manual.attributionVerified, true);
  assert.equal(manual.source, "manual:confirmed");
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "market-admin-"));
  mkdirSync(join(root, "dist", "market"), { recursive: true });
  mkdirSync(join(root, "data", "cache"), { recursive: true });
  mkdirSync(join(root, "data", "admin", "market-index", "drafts"), { recursive: true });
  mkdirSync(join(root, "data", "admin", "market-index", "history"), { recursive: true });
  const plugin = (name, extra) => ({
    name,
    title: name,
    metadata: { labels: ["dsh-bundle"], sortKeys: { stars: 10, downloads: 1 } },
    versions: [{ version: "1.0.0", publishTimestamp: 1, source: { type: "npm" } }],
    ...extra,
  });
  const index = (plugins) => ({ format: 1, title: { en: "t", zh: "t" }, plugins });
  writeFileSync(join(root, "dist", "market", "index.json"), JSON.stringify(index([plugin("pkg-a", { author: "a" }), plugin("pkg-b")])));
  writeFileSync(join(root, "data", "cache", "npm-registry.json"), JSON.stringify({ packages: { "pkg-a": { repository: "https://github.com/a/repo", repositoryDirectory: "packages/a", npmUser: "a", versions: [{ version: "1.0.0", ts: 1, pre: false }] } } }));
  writeFileSync(join(root, "data", "cache", "repo-dirs.json"), JSON.stringify({ version: 1, entries: {} }));
  writeFileSync(join(root, "data", "cache", "status.json"), JSON.stringify({ state: "idle", updatedAt: new Date().toISOString() }));
  writeFileSync(join(root, "data", "mesh.json"), "{}");
  return root;
}

test("后台只读载荷：总览/条目/队列/详情都能从 dist + 缓存算出来", async () => {
  const root = makeRoot();
  try {
    const admin = createMarketAdmin({ root });
    const overview = admin.overviewPayload();
    assert.equal(overview.plugins, 2);
    assert.ok(overview.verdicts.confirmed >= 0);
    const list = admin.listPlugins(new URL("http://x/api/market/plugins?q=pkg-a"));
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].name, "pkg-a");
    const detail = admin.pluginDetail("pkg-a");
    assert.equal(detail.name, "pkg-a");
    assert.equal(detail.install, "pkg-a@1.0.0");
    const queue = admin.queuePayload(new URL("http://x/api/market/queue?type=refuted"));
    assert.ok(Array.isArray(queue.rows));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("人工裁决写盘 + 撤销", async () => {
  const root = makeRoot();
  try {
    const admin = createMarketAdmin({ root });
    const saved = admin.saveDecision({ name: "pkg-a", decision: "refuted", reason: "仓库无此包" });
    assert.equal(saved.ok, true);
    assert.match(saved.impact, /身份/);
    const paths = marketPaths(root);
    const doc = readMarketOverrides(paths.overrides);
    assert.equal(doc.entries["pkg-a"].decision, "refuted");
    assert.equal(admin.saveDecision({ name: "not-in-index", decision: "refuted" }).impact.includes("没有这个包"), true);
    assert.equal(admin.saveDecision({ name: "bad name", decision: "refuted" }).error.length > 0, true);
    assert.equal(admin.saveDecision({ name: "ok-pkg", decision: "maybe" }).error.length > 0, true);
    assert.equal(admin.removeDecision("pkg-a").removed, true);
    assert.equal(readMarketOverrides(paths.overrides).entries["pkg-a"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diff：新增/移除/标签/身份/标题五组", async () => {
  const root = makeRoot();
  try {
    const admin = createMarketAdmin({ root });
    const next = {
      plugins: [
        { name: "pkg-a", title: "pkg-a", author: null, metadata: { labels: ["dsh-bundle", "owner-unverified"], sortKeys: { stars: 0 } }, versions: [{ version: "1.0.0" }] },
        { name: "pkg-c", metadata: { labels: ["dsh-bundle"], sortKeys: { stars: 1 } }, versions: [{ version: "1.0.0" }] },
      ],
    };
    const prev = { plugins: [{ name: "pkg-a", title: "pkg-a", author: "a", metadata: { labels: ["dsh-bundle"], sortKeys: { stars: 10 } }, versions: [{ version: "1.0.0" }] }, { name: "pkg-b", metadata: { labels: ["dsh-bundle"], sortKeys: { stars: 2 } } }] };
    const diff = admin.diffIndexes(next, prev);
    assert.deepEqual(diff.added.map((x) => x.name), ["pkg-c"]);
    assert.deepEqual(diff.removed.map((x) => x.name), ["pkg-b"]);
    assert.equal(diff.labelChanged.length, 1);
    assert.equal(diff.identityChanged.length, 1);
    assert.equal(diff.identityChanged[0].author.after, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("发布/回滚：草稿原子替换、history 备份、回滚恢复", async () => {
  const root = makeRoot();
  try {
    const admin = createMarketAdmin({ root });
    const paths = marketPaths(root);
    const jobId = "20261023T140000";
    const dir = join(paths.drafts, jobId);
    mkdirSync(dir, { recursive: true });
    const draft = { format: 1, title: { en: "d", zh: "d" }, plugins: [{ name: "pkg-new", title: "pkg-new", metadata: { labels: [], sortKeys: { stars: 0 } }, versions: [{ version: "1.0.0" }] }] };
    writeFileSync(join(dir, "index.json"), JSON.stringify(draft));
    writeFileSync(join(dir, "index-nodes.json"), JSON.stringify({ count: 1, ids: ["a/repo"] }));
    const published = admin.publish(jobId);
    assert.equal(published.ok, true);
    const dist = JSON.parse(readFileSync(join(root, "dist", "market", "index.json"), "utf8"));
    assert.equal(dist.plugins[0].name, "pkg-new");
    const history = admin.historyList();
    assert.equal(history.length, 1, "发布前要留一份 history 备份");
    // 发布不带 confirm 的检查在路由层，这里直接测 rollback
    const back = admin.rollback(history[0].ts);
    assert.equal(back.ok, true);
    const restored = JSON.parse(readFileSync(join(root, "dist", "market", "index.json"), "utf8"));
    assert.deepEqual(restored.plugins.map((p) => p.name), ["pkg-a", "pkg-b"]);
    assert.equal(admin.publish("../../etc").error.length > 0, true, "jobId 不能带路径");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("发布/回滚：预压缩件随发布同步；草稿没有压缩件时清掉线上旧件，回滚也不留陈旧件", async () => {
  const root = makeRoot();
  try {
    const admin = createMarketAdmin({ root });
    const paths = marketPaths(root);
    const distDir = join(root, "dist", "market");

    // 草稿带 .gz/.br：发布要一起同步
    const job1 = "20261023T150000";
    const dir1 = join(paths.drafts, job1);
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "index.json"), JSON.stringify({ format: 1, title: { en: "d", zh: "d" }, plugins: [{ name: "pkg-new", metadata: { labels: [], sortKeys: { stars: 0 } }, versions: [{ version: "1.0.0" }] }] }));
    writeFileSync(join(dir1, "index.json.gz"), "GZ-DRAFT");
    writeFileSync(join(dir1, "index.json.br"), "BR-DRAFT");
    assert.equal(admin.publish(job1).ok, true);
    assert.equal(readFileSync(join(distDir, "index.json.gz"), "utf8"), "GZ-DRAFT");
    assert.equal(readFileSync(join(distDir, "index.json.br"), "utf8"), "BR-DRAFT");

    // 草稿没有压缩件：线上旧件必须删掉，否则 serve 会发陈旧内容
    const job2 = "20261023T160000";
    const dir2 = join(paths.drafts, job2);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "index.json"), JSON.stringify({ format: 1, title: { en: "d", zh: "d" }, plugins: [{ name: "pkg-next", metadata: { labels: [], sortKeys: { stars: 0 } }, versions: [{ version: "1.0.0" }] }] }));
    assert.equal(admin.publish(job2).ok, true);
    assert.equal(existsSync(join(distDir, "index.json.gz")), false, "草稿没有 .gz 时要删掉线上旧 .gz");
    assert.equal(existsSync(join(distDir, "index.json.br")), false, "草稿没有 .br 时要删掉线上旧 .br");

    // 回滚也不留陈旧压缩件
    const history = admin.historyList();
    assert.equal(admin.rollback(history[0].ts).ok, true);
    assert.equal(existsSync(join(distDir, "index.json.gz")), false);
    assert.equal(existsSync(join(distDir, "index.json.br")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overrides 支持隐藏标签：去重、非法 id 丢弃", () => {
  const doc = normalizeOverrides({ labels: { hidden: ["owner-unverified", "owner-unverified", "Bad Label", "star-cta", "x".repeat(80)] } });
  assert.deepEqual(doc.labels.hidden, ["owner-unverified", "star-cta"]);
  assert.deepEqual([...hiddenLabelIds(doc)], ["owner-unverified", "star-cta"]);
  assert.deepEqual(normalizeOverrides({}).labels.hidden, [], "老文件没有 labels 段也要能读");
});


test("作者作用域黑名单：@chatcode/* 整片不收录", async () => {
  const doc = normalizeOverrides({ lists: { blacklistScopes: ["@chatcode", "chatcode", "@chatcode", "@Bad Scope"] } });
  assert.deepEqual(doc.lists.blacklistScopes, ["@chatcode"]);
  assert.equal(packageBlacklistReason(doc.lists, "@chatcode/cco-tui"), "人工拉黑（作者 @chatcode）");
  assert.equal(packageBlacklistReason(doc.lists, "@chatcode/cco-market"), "人工拉黑（作者 @chatcode）");
  assert.equal(packageBlacklistReason(doc.lists, "@other/pkg"), null);
  assert.deepEqual(listHit(doc, { pkg: "@ChatCode/cco-market" }), { kind: "scope", value: "@chatcode" });
  assert.equal(scopeOfPackage("@ChatCode/x"), "@chatcode");
  assert.equal(scopeOfPackage("plain-pkg"), null);

  // 后台名单接口要把作用域黑名单带出去（运营能看到当前挡了哪些作者）
  const root = makeRoot();
  try {
    const overrides = normalizeOverrides({ lists: { blacklistScopes: ["@chatcode"] } });
    saveMarketOverrides(marketPaths(root).overrides, overrides);
    const admin = createMarketAdmin({ root });
    assert.deepEqual(admin.listsPayload().lists.blacklistScopes, ["@chatcode"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("后台标签开关：列出计数、隐藏写盘、未知标签拒绝", async () => {
  const root = makeRoot();
  try {
    const distFile = join(root, "dist", "market", "index.json");
    const doc = JSON.parse(readFileSync(distFile, "utf8"));
    doc.metadata = {
      labels: {
        "dsh-bundle": { title: { en: "DSH bundle", zh: "DSH 组合包" } },
        "owner-unverified": { title: { en: "Owner unverified", zh: "作者待确认" } },
      },
    };
    doc.plugins[1].metadata.labels = ["dsh-bundle", "owner-unverified"];
    writeFileSync(distFile, JSON.stringify(doc));

    const admin = createMarketAdmin({ root });
    const before = admin.labelsPayload();
    const byId = Object.fromEntries(before.labels.map((l) => [l.id, l]));
    assert.equal(byId["owner-unverified"].count, 1);
    assert.equal(byId["owner-unverified"].hidden, false);
    assert.equal(byId["owner-unverified"].title.zh, "作者待确认");

    const saved = admin.saveLabels({ action: "set", hidden: ["owner-unverified"] });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.hidden, ["owner-unverified"]);
    assert.equal(saved.impacted, 1);
    assert.equal(readMarketOverrides(marketPaths(root).overrides).labels.hidden[0], "owner-unverified");

    assert.ok(admin.saveLabels({ action: "set", hidden: ["nope"] }).error.length > 0);
    assert.ok(admin.saveLabels({ action: "hide", id: "not-a-label" }).error.length > 0);
    assert.ok(admin.saveLabels({ action: "hide", id: "star-cta" }).hidden.includes("star-cta"));
    assert.equal(admin.saveLabels({ action: "show", id: "star-cta" }).hidden.includes("star-cta"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工作流：八阶段 + 实时快照 + 构建统计", async () => {
  const root = makeRoot();
  try {
    // 补上工作流读取的输入缓存与一次构建统计
    mkdirSync(join(root, "data", "admin", "market-index", "drafts", "J1"), { recursive: true });
    writeFileSync(join(root, "data", "cache", "npm-downloads.json"), JSON.stringify({ repos: { "a/repo": { package: "pkg-a" }, "b/repo": { package: "pkg-b" } } }));
    writeFileSync(join(root, "data", "cache", "npm-search.json"), JSON.stringify({ packages: { "pkg-a": {}, "pkg-b": {}, "pkg-c": {} } }));
    writeFileSync(join(root, "data", "cache", "npm-packages.json"), JSON.stringify({ packages: { "pkg-c": {} } }));
    writeFileSync(
      join(root, "data", "admin", "market-index", "drafts", "J1", "build-stats.json"),
      JSON.stringify({
        format: 1,
        inputs: { meshNodes: 10, downloadsRepos: 2, npmSearchPackages: 3, npmSubdirPackages: 1, registryRecords: 3 },
        candidates: { total: 3, picked: 3, fromDownloads: 2, fromSubdir: 1 },
        filters: { notBundle: 1, officialModule: 2, manualBlacklist: 0, noPackument: 0 },
        verification: { targets: 2, verified: 1, moved: 1, missing: 0, local: 0, error: 0, codeSearch: 0 },
        verdicts: { confirmed: 1, unverified: 1, refuted: 1, unattributed: 0 },
        overrides: { "manual:refuted": 1 },
        labels: { "dsh-bundle": 2, "owner-unverified": 1 },
        timings: { registryMs: 100, verifyMs: 200, assembleMs: 50, totalMs: 400 },
        index: { plugins: 2, categories: 1, haloRepos: 1 },
        skipped: { total: 1, top: [{ pkg: "pkg-x", why: "不是 DSH 组合包" }] },
        seed: 1,
      }),
    );
    writeFileSync(join(root, "data", "admin", "market-index", "job.json"), JSON.stringify({ id: "J1", status: "done", startedAt: "2026-10-23T14:00:00Z", finishedAt: "2026-10-23T14:01:00Z", plugins: 2, log: "data/admin/logs/x.log" }));
    const admin = createMarketAdmin({ root });
    const wf = admin.workflowPayload();
    assert.equal(wf.stages.length, 8, "流水线要有八个阶段");
    assert.equal(wf.stages[0].id, "inputs");
    assert.equal(wf.stages[7].id, "publish");
    assert.equal(wf.live.inputs.downloadsRepos, 2);
    assert.equal(wf.live.inputs.npmSearchPackages, 3);
    assert.equal(wf.lastBuild.jobId, "J1");
    assert.equal(wf.lastBuild.stats.filters.notBundle, 1);
    assert.equal(wf.lastBuild.skippedTop[0].pkg, "pkg-x");
    assert.equal(wf.live.overrides.entries, 0);
    // 没有统计文件时也不能崩：只给实时近似
    rmSync(join(root, "data", "admin", "market-index", "drafts", "J1", "build-stats.json"), { force: true });
    const wf2 = admin.workflowPayload();
    assert.equal(wf2.lastBuild.stats, null);
    assert.equal(wf2.stages.length, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("构建防并发：采集器在跑时拒绝", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "data", "cache", "status.json"), JSON.stringify({ state: "building", updatedAt: new Date().toISOString() }));
    const admin = createMarketAdmin({ root });
    const started = admin.startBuild({});
    assert.match(started.conflict, /采集器/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
