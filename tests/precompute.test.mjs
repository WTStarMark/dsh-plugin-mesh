/**
 * 0.4.1 预计算契约测试：布局提前算好、载荷瘦身、详情分片。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCore, precomputedLayout, prepare } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "mesh-precompute-"));
execFileSync(process.execPath, [join(ROOT, "tools/precompute-layout.mjs"), "--out", tmp, "--chunks", "4"], { cwd: ROOT, stdio: "pipe" });

const core = JSON.parse(readFileSync(join(tmp, "mesh-core.json"), "utf8"));
const original = JSON.parse(readFileSync(join(ROOT, "data/mesh.json"), "utf8"));

test("预计算契约：节点带坐标、连线是索引三元组、扇区齐备", () => {
  assert.equal(core.meta.layout, "precomputed");
  assert.equal(core.nodes.length, original.nodes.length, "节点数必须与原始数据一致");
  for (const n of core.nodes.slice(0, 50)) {
    assert.equal(typeof n.x, "number");
    assert.equal(typeof n.y, "number");
    assert.equal(typeof n.r, "number");
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), "坐标必须是有限数");
  }
  for (const e of core.edges.slice(0, 50)) {
    assert.equal(e.length, 3);
    assert.ok(e[0] >= 0 && e[0] < core.nodes.length && e[1] >= 0 && e[1] < core.nodes.length, "连线端点必须是有效索引");
  }
  assert.ok(core.arms.length >= 5, "扇区信息应当保留");
  assert.ok(core.arms.every((a) => Number.isFinite(a.startAngle) && Number.isFinite(a.endAngle)));
});

test("载荷瘦身：core 明显小于原始，详情字段已挪走", () => {
  const coreBytes = JSON.stringify(core).length;
  const originalBytes = JSON.stringify(original).length;
  assert.ok(coreBytes < originalBytes * 0.7, "core 至少要比原始小 30%，实际 " + (coreBytes / originalBytes * 100).toFixed(0) + "%");
  const sample = core.nodes[0];
  assert.equal(sample.description, undefined, "描述应挪到详情分片");
  assert.equal(sample.topics, undefined, "topics 应挪到详情分片");
  assert.ok(sample.stars !== undefined && sample.category, "首屏必需字段必须保留");
});

test("详情分片：覆盖全部仓库，且每个仓库只在一片中", () => {
  const chunks = 4;
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < chunks; i++) {
    const path = join(tmp, "details", i + ".json");
    assert.ok(existsSync(path), "分片 " + i + " 应存在");
    const bucket = JSON.parse(readFileSync(path, "utf8"));
    for (const id of Object.keys(bucket)) {
      assert.ok(!seen.has(id), id + " 出现在多个分片里");
      seen.add(id);
      total += 1;
    }
  }
  assert.ok(seen.size > core.nodes.length * 0.9, "详情应覆盖绝大多数仓库，实际 " + seen.size + "/" + core.nodes.length);
  assert.ok(total > 0);
});

test("前端契约：prepareCore 与 prepare 同形，precomputedLayout 可直接喂给视图", () => {
  const p = prepareCore(core);
  assert.equal(p.nodes.length, core.nodes.length);
  assert.equal(p.byId.size, core.nodes.length);
  assert.ok(p.links.length > 0, "索引化连线应转成 links");
  assert.equal(p.adjacency.size, core.nodes.length);
  assert.equal(typeof p.maxStars, "number");

  const L = precomputedLayout(core);
  assert.equal(L.size, core.nodes.length);

  // 回归：曾经因为读了动画起始坐标（layout.x/y 而非 tx/ty），所有点挤在圆心 → 整张图"消失"
  let spread = 0;
  let maxRadius = 0;
  for (let i = 0; i < L.size; i++) {
    const r = Math.hypot(L.x[i], L.y[i]);
    if (r > 50) spread += 1;
    if (r > maxRadius) maxRadius = r;
  }
  assert.ok(spread > L.size * 0.9, "构造完成时就应有真实坐标，实际只有 " + spread + "/" + L.size + " 个点离开圆心");
  assert.ok(maxRadius > 200, "布局应当铺开，实际最远半径 " + maxRadius.toFixed(0));

  // 回归：扇区成员不能是空的（否则右栏"所属扇区/距圆心第 N 近"会失效）
  const withMembers = L.arms.filter((a) => a.members.length > 0);
  assert.ok(withMembers.length >= L.arms.length - 1, "扇区应带上成员，实际 " + withMembers.length + "/" + L.arms.length);
  assert.ok(withMembers[0].members[0].id, "成员应还原成 {id} 结构");
  assert.equal(L.index.get(p.nodes[0].id), 0);
  // 预计算布局没有沉降动画：alpha 起始为 1（视图据此判定"已就位"），一次 tick 归零
  assert.equal(L.alpha, 1, "构造后应标记为已就位");
  L.tick();
  assert.equal(L.alpha, 0, "tick 后应结束沉降判定");
  const bounds = L.getBounds(10);
  assert.ok(bounds.minX < bounds.maxX && bounds.minY < bounds.maxY);
  for (let i = 0; i < L.size; i++) {
    assert.ok(L.x[i] >= bounds.minX - 1 && L.x[i] <= bounds.maxX + 1, "所有点应落在包围盒内");
  }
  for (let i = 0; i < 5; i++) L.tick();
  assert.equal(L.alpha, 0, "预计算布局没有沉降动画，重复 tick 也应保持已就位");
});

test("回退路径：没有 core 时 prepare() 照常工作（老部署不受影响）", () => {
  const p = prepare(original);
  assert.equal(p.nodes.length, original.nodes.length);
  assert.ok(p.edges.length > 0);
  assert.equal(p.links, undefined, "老路径不带预计算连线，视图会自行重算");
});

test.after?.(() => rmSync(tmp, { recursive: true, force: true }));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
