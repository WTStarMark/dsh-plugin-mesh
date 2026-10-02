/**
 * 扇区散布布局测试。
 * 注意断言的性质变了：从"严格排序 + 同心环"改成"统计趋势 + 离散随机"，
 * 因为需求明确要求看起来自然，而刚性排序/等角环正是"僵硬"的来源。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const HUB = "deepseek-ai/deepseek-harness";

function fixture() {
  const nodes = [{ id: HUB, stars: 240000, category: "core" }];
  const cats = ["skin", "tools", "desktop"];
  let s = 9000;
  for (const c of cats) {
    for (let i = 0; i < 14; i++) nodes.push({ id: c + "/r" + i, stars: s - i * 260, category: c, categoryLabel: c });
    s -= 1000;
  }
  return nodes;
}

const real = () => {
  const prepared = prepare(mesh);
  return { prepared, layout: createSectorLayout({ nodes: prepared.nodes, centerId: HUB, groupOf: (n) => n.category, seed: "real" }) };
};

test("圆心固定在原点，且不属于任何扇区", () => {
  const nodes = fixture();
  const L = createSectorLayout({ nodes, centerId: HUB, seed: 1 });
  assert.equal(L.x[L.index.get(HUB)], 0);
  assert.equal(L.y[L.index.get(HUB)], 0);
  assert.ok(!L.arms.some((a) => a.id === "core"));
});

test("扇区等角分布：3 个分类 => 每个扇区 120°", () => {
  const nodes = fixture();
  const L = createSectorLayout({ nodes, centerId: HUB, groupOf: (n) => n.category, seed: 1 });
  assert.equal(L.arms.length, 3);
  const expected = (Math.PI * 2) / 3;
  for (let i = 1; i < L.arms.length; i++) {
    assert.ok(Math.abs(L.arms[i].angle - L.arms[i - 1].angle - expected) < 1e-12);
  }
  assert.ok(Math.abs(L.angleStep - expected) < 1e-12);
});

test("扇区角度区间互不重叠，且节点都在自己扇区内", () => {
  const { layout: L } = real();
  const spans = L.arms.map((a) => [a.startAngle, a.endAngle]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1] - 1e-12, "扇区重叠");
  const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  for (const arm of L.arms) {
    for (const m of arm.members) {
      const rel = wrap(m.angle - arm.angle);
      assert.ok(Math.abs(rel) <= arm.width / 2 + 1e-9, m.id + " 跑到扇区外");
    }
  }
});

test("需求：分布必须离散自然，不能是同心环/等角排列", () => {
  const { layout: L } = real();
  for (const arm of L.arms) {
    if (arm.members.length < 20) continue;
    // 同心环的特征：一圈上挤着一批半径几乎相同的节点。
    // 判据要跟密度无关，所以用"同密度均匀散布下这条半径带的期望占用"做归一化：
    // 实测散点约为期望的 1.8~2.4 倍（分离约束让局部更密），而同心环会是 5 倍以上。
    const area = 0.5 * arm.width * (arm.rMax ** 2 - arm.rMin ** 2);
    let expected = 0;
    for (const m of arm.members) expected += (arm.width * m.r * 3) / area;
    expected = (expected / arm.members.length) * (arm.members.length - 1);
    const bands = arm.members.map((m) => arm.members.filter((x) => Math.abs(x.r - m.r) <= 1.5).length);
    const meanBand = bands.reduce((s, v) => s + v, 0) / bands.length;
    const ratio = meanBand / Math.max(0.4, expected);
    assert.ok(ratio < 3.5, arm.id + " 同半径带占用是同密度均匀散布的 " + ratio.toFixed(1) + " 倍，像同心环");
    // 角度间隔不应均匀（等角排列的特征）
    const angles = arm.members.map((m) => m.angle).sort((a, b) => a - b);
    const gaps = angles.slice(1).map((a, i) => a - angles[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const dev = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    assert.ok(dev / mean > 0.25, arm.id + " 角度间隔过于均匀（等角排列）：变异系数 " + (dev / mean).toFixed(3));
  }
});

test("星标越多整体越靠内（统计趋势，非刚性排序）", () => {
  const { layout: L } = real();
  const ratios = [];
  for (const arm of L.arms) {
    if (arm.members.length < 30) continue;
    const sorted = [...arm.members].sort((a, b) => b.stars - a.stars);
    const k = Math.floor(sorted.length * 0.25);
    const inner = sorted.slice(0, k).reduce((s, m) => s + m.r, 0) / k;
    const outer = sorted.slice(-k).reduce((s, m) => s + m.r, 0) / k;
    const ratio = inner / outer;
    ratios.push(ratio);
    // 每个扇区都要有可辨的分层（弱扇区成员少、星标接近，允许宽松一些）
    assert.ok(ratio < 0.92, arm.id + " 高星与低星没有分层：内 " + inner.toFixed(0) + " vs 外 " + outer.toFixed(0));
  }
  // 整体上应当是明显的内高星、外低星
  const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  assert.ok(median < 0.75, "整体分层不足，中位比值 " + median.toFixed(2));
});

test("任意两节点不重叠", () => {
  const { layout: L } = real();
  L.run(200);
  let worst = 0;
  let where = "";
  for (let i = 0; i < L.size; i++) {
    if (i === L.center.index) continue;
    for (let j = i + 1; j < L.size; j++) {
      if (j === L.center.index) continue;
      const d = Math.hypot(L.x[i] - L.x[j], L.y[i] - L.y[j]);
      const over = L.radius[i] + L.radius[j] - d;
      if (over > worst) {
        worst = over;
        where = L.nodes[i].id + " <> " + L.nodes[j].id;
      }
    }
  }
  assert.ok(worst < 0.5, "最大重叠 " + worst.toFixed(3) + " @ " + where);
});

test("同种子逐位一致；换种子分布不同（这正是'离散随机'）", () => {
  const nodes = fixture();
  const a = createSectorLayout({ nodes, centerId: HUB, seed: 5 });
  const b = createSectorLayout({ nodes, centerId: HUB, seed: 5 });
  a.run(200);
  b.run(200);
  for (let i = 0; i < nodes.length; i++) {
    assert.equal(a.x[i], b.x[i]);
    assert.equal(a.y[i], b.y[i]);
  }
  const c = createSectorLayout({ nodes, centerId: HUB, seed: 6 });
  let moved = 0;
  for (let i = 0; i < nodes.length; i++) if (Math.hypot(c.x[i] - a.x[i], c.y[i] - a.y[i]) > 1) moved++;
  assert.ok(moved > nodes.length * 0.3, "换种子应明显改变分布，实际变动 " + moved + " 个");
  assert.equal(c.arms.length, a.arms.length);
  assert.ok(Math.abs(c.arms[1].angle - a.arms[1].angle) < 1e-12, "扇区角度不应随种子改变");
});

test("getBounds 用目标位置：入场动画期间 fit 不退化", () => {
  const { layout: L } = real();
  assert.equal(L.progress, 0);
  const b = L.getBounds(0);
  assert.ok(b.maxX - b.minX > 500, "未展开时也应是最终尺寸");
  L.run(200);
  assert.ok(L.alpha < 0.01);
});

test("真实数据：扇区数等于分组数，尺寸可控", () => {
  const { prepared, layout: L } = real();
  assert.equal(L.arms.length, new Set(prepared.nodes.map((n) => n.category)).size);
  // 扇区数随分类数变化（v0.4 起 19 个分类），角度步长必须等于 2π / 扇区数
  assert.ok(Math.abs(L.angleStep - (Math.PI * 2) / L.arms.length) < 1e-12, "角度步长应等于 2π/扇区数");
  const longest = Math.max(...L.arms.map((a) => a.endRadius));
  assert.ok(longest < 4000, "整体尺寸不应失控: " + longest.toFixed(0));
  assert.ok(L.arms[0].count > 100);
});
