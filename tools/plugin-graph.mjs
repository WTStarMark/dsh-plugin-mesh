/**
 * 插件图/严格市场的纯函数构建。
 *
 * 输入：现有 mesh.json（完整生态图）+ 市场索引（dist/market/index.json）。
 * 插件集合口径（当前阶段）：
 *   - 市场条目里带 dsh-bundle 标签（官方 packument 判定的可安装组合包）；
 *   - 仓库能在 mesh 里找到；
 *   - 额外保留官方主仓库与策展基座（它们不是 bundle，但图需要）。
 * 未扫描的“没发 npm 的插件”暂不包含。
 */

const HUB_ID = "deepseek-ai/deepseek-harness";

function repoOfPlugin(plugin) {
  const url = plugin?.repository?.url ?? "";
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(String(url));
  return match ? (match[1] + "/" + match[2]).replace(/\.git$/i, "").toLowerCase() : null;
}

export function confirmedRepoIds(marketIndex) {
  const out = new Set();
  for (const plugin of marketIndex?.plugins ?? []) {
    if (!(plugin.metadata?.labels ?? []).includes("dsh-bundle")) continue;
    const repo = repoOfPlugin(plugin);
    if (repo) out.add(repo);
  }
  return out;
}

function countBy(nodes, fn) {
  const map = new Map();
  for (const n of nodes) map.set(fn(n), (map.get(fn(n)) ?? 0) + 1);
  return map;
}

export function buildPluginMesh(mesh, marketIndex, { extraIds = [] } = {}) {
  const keep = new Set([...confirmedRepoIds(marketIndex), ...extraIds.map((x) => String(x).toLowerCase())]);
  keep.add(HUB_ID);
  const nodes = (mesh.nodes ?? []).filter((n) => keep.has(String(n.id).toLowerCase()));
  const ids = new Set(nodes.map((n) => String(n.id).toLowerCase()));
  const edges = (mesh.edges ?? []).filter((e) => {
    const a = e.source ?? e.a;
    const b = e.target ?? e.b;
    return ids.has(String(a).toLowerCase()) && ids.has(String(b).toLowerCase());
  });
  const catCounts = countBy(nodes, (n) => n.category ?? "other");
  const clusters = (mesh.clusters ?? [])
    .map((c) => ({ ...c, count: catCounts.get(c.id) ?? 0 }))
    .filter((c) => c.count > 0);
  const tags = (mesh.tags ?? [])
    .map((t) => ({ ...t, sampleCount: nodes.filter((n) => (n.matchedTags ?? []).includes(t.id)).length }))
    .filter((t) => t.sampleCount > 0);
  const topicCounts = countBy(nodes.flatMap((n) => (n.topics ?? []).map((topic) => ({ topic }))), (x) => x.topic);
  const hubs = (mesh.hubs ?? [])
    .map((h) => ({ ...h, count: topicCounts.get(h.topic) ?? 0 }))
    .filter((h) => h.count > 0);
  const verdictCounts = countBy(nodes, (n) => n.verdict ?? "unknown");
  const meta = {
    ...mesh.meta,
    scope: "plugins",
    indexedNodes: nodes.length,
    sampleNodes: nodes.length,
    frontendNodes: nodes.length,
    sampleEdges: edges.length,
    frontendEdges: edges.length,
    verdictCounts: Object.fromEntries(verdictCounts),
    detailBase: "./data/plugins/details/",
    note: "DSH 插件图：仅含 npm 已确证 dsh.bundle 的仓库、官方主仓库与策展基座；未扫描的未发布插件暂不包含。",
  };
  return { meta, tags, hubs, clusters, nodes, edges };
}

function recountMarketIndex(marketIndex, plugins, metadataExtra = {}) {
  const counts = countBy(plugins, (p) => p.metadata?.category ?? "other");
  const categories = {};
  for (const [id, def] of Object.entries(marketIndex?.metadata?.categories ?? {})) {
    const en = String(def?.title?.en ?? id).replace(/\s*·\s*\d+\s*$/, "");
    const zh = String(def?.title?.zh ?? id).replace(/\s*·\s*\d+\s*$/, "");
    categories[id] = { ...def, title: { en: en + " · " + (counts.get(id) ?? 0), zh: zh + " · " + (counts.get(id) ?? 0) } };
  }
  const strip = (s) => String(s ?? "").replace(/\s*·\s*\d+\s*$/, "");
  const title = {
    en: strip(marketIndex?.title?.en ?? "DSH Plugin Ecosystem") + " · " + plugins.length,
    zh: strip(marketIndex?.title?.zh ?? "DSH 插件生态图") + " · " + plugins.length,
  };
  return {
    ...marketIndex,
    title,
    plugins,
    metadata: {
      ...(marketIndex?.metadata ?? {}),
      categories,
      marketScope: "plugins-only",
      ...metadataExtra,
    },
  };
}

export function filterMarketIndex(marketIndex, allowedRepoIds) {
  const plugins = (marketIndex?.plugins ?? []).filter((p) => {
    if (!(p.metadata?.labels ?? []).includes("dsh-bundle")) return false;
    const repo = repoOfPlugin(p);
    return Boolean(repo && allowedRepoIds.has(repo));
  });
  return recountMarketIndex(marketIndex, plugins);
}

/** 按验证报告过滤：只保留 V2 verdict=confirmed 的包；报告不完整时调用方必须显式 allowPartial */
export function filterMarketIndexByVerification(marketIndex, report, { allowPartial = false } = {}) {
  const entries = report?.entries ?? [];
  const confirmed = new Set(entries.filter((e) => e.verdict === "confirmed").map((e) => e.name));
  const total = marketIndex?.plugins?.length ?? 0;
  if (!allowPartial && entries.length < total) {
    throw new Error("验证报告只覆盖 " + entries.length + "/" + total + " 个包；完整过滤请用 --allow-partial");
  }
  const plugins = (marketIndex?.plugins ?? []).filter((p) => confirmed.has(p.name));
  return recountMarketIndex(marketIndex, plugins, {
    verification: { level: report?.level ?? "V2", checked: entries.length, confirmed: confirmed.size, appliedAt: new Date().toISOString() },
  });
}

export { repoOfPlugin, HUB_ID };
