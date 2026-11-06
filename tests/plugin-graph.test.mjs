import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPluginMesh, filterMarketIndex, filterMarketIndexByVerification, confirmedRepoIds } from "../tools/plugin-graph.mjs";

const HUB = "deepseek-ai/deepseek-harness";
const node = (id, category) => ({ id, name: id.split("/")[1], owner: id.split("/")[0], category, categoryLabel: category, matchedTags: [], topics: [], verdict: "related" });
const mesh = {
  meta: { generatedAt: "2026-01-01T00:00:00Z", ecosystemBases: ["base/repo"] },
  tags: [{ id: "dsh-plugin", sampleCount: 3 }],
  hubs: [{ topic: "dsh-plugin", count: 3 }],
  clusters: [{ id: "agent", label: "智能体技能", count: 1 }, { id: "panel", label: "界面面板", count: 2 }, { id: "other", label: "其他", count: 0 }],
  nodes: [node(HUB, "agent"), node("a/plugin", "panel"), node("b/unconfirmed", "panel"), node("base/repo", "agent"), node("c/other", "agent")],
  edges: [
    { source: HUB, target: "a/plugin", type: "owner" },
    { source: "a/plugin", target: "b/unconfirmed", type: "topic" },
  ],
};
const plugin = (name, repo, labels, category = "panel") => ({
  name,
  repository: repo ? { url: "https://github.com/" + repo } : undefined,
  metadata: { category, labels },
});
const market = {
  format: 1,
  title: { en: "DSH Plugin Ecosystem · 9", zh: "DSH 插件生态图 · 9" },
  metadata: { categories: { panel: { title: { en: "panel · 9", zh: "界面面板 · 9" } }, agent: { title: { en: "agent · 9", zh: "智能体技能 · 9" } } } },
  plugins: [
    plugin("pkg-a", "a/plugin", ["dsh-bundle"], "panel"),
    plugin("pkg-b", "b/unconfirmed", ["dsh-bundle-unconfirmed"], "panel"),
    plugin("pkg-c", "c/other", ["dsh-bundle"], "agent"),
    plugin("pkg-x", "x/not-in-mesh", ["dsh-bundle"], "agent"),
    plugin("pkg-norepo", null, ["dsh-bundle"], "agent"),
  ],
};

test("buildPluginMesh：只保留已确证仓库 + 主仓库 + 额外基座，边两端筛选", () => {
  const out = buildPluginMesh(mesh, market, { extraIds: [HUB, "base/repo"] });
  assert.deepEqual(out.nodes.map((n) => n.id).sort(), [HUB, "a/plugin", "base/repo", "c/other"].sort());
  assert.equal(out.edges.length, 1);
  assert.equal(out.meta.scope, "plugins");
  assert.equal(out.meta.indexedNodes, 4);
  assert.equal(out.meta.detailBase, "./data/plugins/details/");
  assert.deepEqual(out.clusters.map((c) => c.id).sort(), ["agent", "panel"]);
});

test("confirmedRepoIds：unconfirmed 不算确证", () => {
  const ids = confirmedRepoIds(market);
  assert.ok(ids.has("a/plugin"));
  assert.ok(ids.has("c/other"));
  assert.ok(ids.has("x/not-in-mesh")); // 只表示"市场确认"，是否在图里由 buildPluginMesh 再筛
  assert.ok(!ids.has("b/unconfirmed"));
  assert.ok(!ids.has("norepo"));
});

test("filterMarketIndex：只留 dsh-bundle + 仓库在允许集合，并更新计数", () => {
  const allowed = new Set([HUB.toLowerCase(), "a/plugin", "base/repo"]);
  const out = filterMarketIndex(market, allowed);
  assert.deepEqual(out.plugins.map((p) => p.name), ["pkg-a"]);
  assert.equal(out.metadata.marketScope, "plugins-only");
  assert.match(out.title.zh, /· 1$/);
  assert.match(out.metadata.categories.panel.title.zh, /· 1$/);
  assert.match(out.metadata.categories.agent.title.zh, /· 0$/);
  assert.equal(out.plugins[0].metadata.labels.includes("dsh-bundle-unconfirmed"), false);
});

test("filterMarketIndexByVerification：只留 V2 confirmed，报告不完整默认拒绝", () => {
  const allowed = new Set([HUB.toLowerCase(), "a/plugin", "base/repo"]);
  const strict = filterMarketIndex(market, allowed);
  const report = { level: "V2", entries: [{ name: "pkg-a", verdict: "confirmed" }] };
  const out = filterMarketIndexByVerification(strict, report);
  assert.deepEqual(out.plugins.map((p) => p.name), ["pkg-a"]);
  assert.equal(out.metadata.verification.confirmed, 1);
  assert.throws(() => filterMarketIndexByVerification(market, report), /验证报告只覆盖/);
  const partial = filterMarketIndexByVerification(strict, report, { allowPartial: true });
  assert.equal(partial.plugins.length, 1);
});
