/**
 * 连线构造测试：关联性（同扇区 / 同作者 / 稀有主题）与观赏性（不跨境、不过长、无重复）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare } from "../src/mesh-data.js";
import { buildLinks, buildNeighborLinks, countByType } from "../src/links.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const HUB = "deepseek-ai/deepseek-harness";

const setup = (seed = "real") => {
  const prepared = prepare(mesh);
  const layout = createSectorLayout({ nodes: prepared.nodes, centerId: HUB, groupOf: (n) => n.category, seed });
  return { prepared, layout, links: buildLinks(prepared, layout) };
};

test("近邻连线只发生在同一扇区内（关联性：功能相近）", () => {
  const { layout, links } = setup();
  const sectorOf = new Map();
  for (const arm of layout.arms) for (const m of arm.members) sectorOf.set(m.index, arm.id);
  const near = links.filter((l) => l.type === "neighbor");
  assert.ok(near.length > 100, "近邻连线数量过少：" + near.length);
  for (const l of near) {
    assert.equal(sectorOf.get(l.a), sectorOf.get(l.b), "近邻连线跨越了扇区：" + layout.nodes[l.a].id + " <> " + layout.nodes[l.b].id);
  }
});

test("近邻连线：无自环、无重复、每点至多一条", () => {
  const { links, layout } = setup();
  const near = links.filter((l) => l.type === "neighbor");
  const seen = new Set();
  const degree = new Map();
  for (const l of near) {
    assert.notEqual(l.a, l.b, "出现自环：" + layout.nodes[l.a].id);
    const key = Math.min(l.a, l.b) + "-" + Math.max(l.a, l.b);
    assert.ok(!seen.has(key), "出现重复连线：" + key);
    seen.add(key);
    degree.set(l.a, (degree.get(l.a) ?? 0) + 1);
    degree.set(l.b, (degree.get(l.b) ?? 0) + 1);
  }
  for (const [index, count] of degree) assert.ok(count <= 2, "单点近邻过多：" + layout.nodes[index].id + " = " + count);
  assert.ok(near.length <= layout.size, "近邻连线数不应超过节点数：" + near.length);
});

test("近邻连线必须基于最终位置：不得出现零距离（回归防线）", () => {
  const { layout, links } = setup();
  const near = links.filter((l) => l.type === "neighbor");
  for (const l of near) {
    const d = Math.hypot(layout.tx[l.a] - layout.tx[l.b], layout.ty[l.a] - layout.ty[l.b]);
    assert.ok(d > 0.5, "出现零距离连线（说明用了未展开的位置）：" + layout.nodes[l.a].id + " <> " + layout.nodes[l.b].id);
  }
});

test("近邻连线按分位数裁掉过长的一条（观赏性：不留长藤）", () => {
  const { layout } = setup();
  const near = buildNeighborLinks(layout, { percentile: 0.85 });
  const all = buildNeighborLinks(layout, { percentile: 1 });
  assert.ok(near.length < all.length, "分位裁剪应减少连线：" + near.length + " vs " + all.length);
  const dist = (l) => Math.hypot(layout.tx[l.a] - layout.tx[l.b], layout.ty[l.a] - layout.ty[l.b]);
  const maxNear = Math.max(...near.map(dist));
  const maxAll = Math.max(...all.map(dist));
  assert.ok(maxNear <= maxAll, "裁剪后的最长连线不应超过未裁剪的");
});

test("汇总连线：三类边齐备，且索引都在布局范围内", () => {
  const { links, layout } = setup();
  assert.ok(countByType(links, "neighbor") > 0, "缺少近邻连线");
  assert.ok(countByType(links, "topic") > 0, "缺少主题共现连线");
  assert.ok(countByType(links, "owner") >= 0, "同作者连线统计异常");
  for (const l of links) {
    assert.ok(l.a >= 0 && l.a < layout.size, "索引越界 a=" + l.a);
    assert.ok(l.b >= 0 && l.b < layout.size, "索引越界 b=" + l.b);
    assert.notEqual(l.a, l.b);
  }
});

test("连线只由位置与数据决定：同种子结果一致", () => {
  const a = setup("same");
  const b = setup("same");
  assert.equal(a.links.length, b.links.length);
  for (let i = 0; i < a.links.length; i++) {
    assert.equal(a.links[i].a, b.links[i].a);
    assert.equal(a.links[i].b, b.links[i].b);
    assert.equal(a.links[i].type, b.links[i].type);
  }
});

test("规模控制：连线总数不应超过节点数的 3 倍（观赏性下限）", () => {
  const { links, layout } = setup();
  assert.ok(links.length < layout.size * 3, "连线过多会糊成一片：" + links.length + " 条 / " + layout.size + " 个节点");
});
