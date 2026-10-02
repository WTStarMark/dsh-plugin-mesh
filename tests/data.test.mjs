import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));

test("契约：meta / tags / clusters / nodes / edges 齐备", () => {
  for (const key of ["meta", "tags", "clusters", "nodes", "edges"]) {
    assert.ok(mesh[key], "缺少字段 " + key);
  }
  assert.ok(Array.isArray(mesh.nodes) && mesh.nodes.length > 0, "nodes 不能为空");
  assert.ok(Array.isArray(mesh.edges), "edges 必须是数组");
});

test("节点 id 唯一且必填字段完整", () => {
  const seen = new Set();
  for (const n of mesh.nodes) {
    assert.ok(n.id && typeof n.id === "string", "id 缺失");
    assert.ok(!seen.has(n.id), "id 重复: " + n.id);
    seen.add(n.id);
    assert.equal(typeof n.stars, "number");
    assert.ok(Number.isFinite(n.stars), "stars 非有限数: " + n.id);
    assert.ok(Array.isArray(n.topics), "topics 必须是数组: " + n.id);
    assert.ok(Array.isArray(n.matchedTags) && n.matchedTags.length > 0, "matchedTags 不能为空: " + n.id);
    assert.ok(typeof n.primaryTag === "string" && n.primaryTag.length > 0, "primaryTag 缺失: " + n.id);
  }
});

test("边必须引用存在的节点，且没有自环", () => {
  const ids = new Set(mesh.nodes.map((n) => n.id));
  for (const e of mesh.edges) {
    assert.ok(ids.has(e.source), "悬空 source: " + e.source);
    assert.ok(ids.has(e.target), "悬空 target: " + e.target);
    assert.notEqual(e.source, e.target, "自环: " + e.source);
    assert.ok(["topic", "owner", "fork"].includes(e.type), "未知边类型: " + e.type);
    assert.ok(typeof e.weight === "number" && e.weight > 0, "weight 必须为正数");
  }
});

test("精确命中：每个节点的 matchedTags 都真的出现在其 topics 里", () => {
  const WHITELIST = ["dsh", "dsh-desktop", "dsh-plugin", "dsh-plugin-desktop", "dsh-plugin-market", "dsh-plugins"];
  for (const n of mesh.nodes) {
    for (const tag of n.matchedTags) {
      assert.ok(WHITELIST.includes(tag), "标签不在白名单: " + tag);
      assert.ok(n.topics.includes(tag), n.id + " 的 topics 里没有 " + tag + "（精确命中失败）");
    }
  }
});

test("扇区计数与节点分布一致", () => {
  const counted = new Map();
  for (const n of mesh.nodes) counted.set(n.category, (counted.get(n.category) ?? 0) + 1);
  for (const c of mesh.clusters) {
    assert.equal(c.count, counted.get(c.id) ?? 0, "聚类 " + c.id + " 计数不符");
  }
  assert.equal(
    mesh.clusters.reduce((s, c) => s + c.count, 0),
    mesh.nodes.length,
    "聚类应覆盖全部节点",
  );
});

test("功能分类字段完备：每个节点都有 category / categoryLabel", () => {
  for (const n of mesh.nodes) {
    assert.ok(typeof n.category === "string" && n.category.length > 0, "category 缺失: " + n.id);
    assert.ok(typeof n.categoryLabel === "string" && n.categoryLabel.length > 0, "categoryLabel 缺失: " + n.id);
  }
  assert.ok(mesh.meta.categories, "meta.categories 应记录分类统计");
  // 分类统计描述的是【完整索引】；前端契约只保留星标头部，两者不是同一个集合
  const indexed = mesh.meta.indexedNodes ?? mesh.nodes.length;
  assert.equal(mesh.meta.categories.classified + mesh.meta.categories.unclassified, indexed, "分类统计应对齐完整索引");
  assert.ok(mesh.nodes.length <= indexed, "前端节点数不应超过索引数");
});

test("功能分类不是标签分组：同一标签横跨多个扇区", () => {
  const byTag = new Map();
  for (const n of mesh.nodes) {
    for (const t of n.matchedTags) {
      if (!byTag.has(t)) byTag.set(t, new Set());
      byTag.get(t).add(n.category);
    }
  }
  const pluginCats = byTag.get("dsh-plugin") ?? new Set();
  assert.ok(pluginCats.size >= 5, "dsh-plugin 标签应横跨至少 5 个功能扇区，实际 " + pluginCats.size + "：" + [...pluginCats].join(","));
});

test("同作者连线不遗漏：样本内同一作者的多个仓库必须连通", () => {
  const byOwner = new Map();
  for (const n of mesh.nodes) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n.id);
  }
  const adj = new Map(mesh.nodes.map((n) => [n.id, []]));
  for (const e of mesh.edges) {
    if (e.type !== "owner") continue;
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  let groups = 0;
  for (const [owner, ids] of byOwner) {
    if (ids.length < 2) continue;
    groups += 1;
    const seen = new Set([ids[0]]);
    const stack = [ids[0]];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    for (const id of ids) {
      assert.ok(seen.has(id), "同作者未连通：" + owner + " 的 " + id + " 与其他同伴之间没有连线");
    }
  }
  assert.ok(groups > 10, "样本中多仓库作者数量异常：" + groups);
});

test("回归：Tencent 组曾因度数裁剪被静默丢线", () => {
  const a = mesh.nodes.find((n) => n.id === "Tencent/BrowserSkill");
  const b = mesh.nodes.find((n) => n.id === "Tencent/WeKnora");
  if (!a || !b) return; // 样本里没有就跳过
  const linked = mesh.edges.some(
    (e) => e.type === "owner" && ((e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id)),
  );
  assert.ok(linked, "同作者连线被丢弃（可能又被度数裁剪吃掉了）");
  assert.ok(mesh.meta.ownerEdges > 0, "meta 应记录同作者边数");
});

test("数据必须自带来源与覆盖范围说明", () => {
  // 数据来源可能是离线取样（sample-seed）或每小时采集（hourly-crawl）
  assert.ok(["sample-seed", "hourly-crawl"].includes(mesh.meta.kind), "未知的数据类型：" + mesh.meta.kind);
  assert.ok(mesh.meta.note && mesh.meta.note.length > 0, "必须写明数据覆盖范围（meta.note）");
  assert.ok(mesh.meta.generatedAt, "必须记录生成时间");
  if (mesh.meta.kind === "sample-seed") {
    assert.ok(Array.isArray(mesh.meta.queries) && mesh.meta.queries.length > 0, "取样数据必须记录查询来源");
  }
});
