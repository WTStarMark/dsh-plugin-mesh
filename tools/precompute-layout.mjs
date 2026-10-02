#!/usr/bin/env node
/**
 * 预计算：把"浏览器每次都要算一遍"的东西提前算好，并给载荷瘦身。
 *
 * 产出三样：
 *   data/mesh-core.json    首屏必需：精简节点 + 预计算坐标 + 索引化连线（体积约为原 mesh.json 的一半）
 *   data/details/N.json    右栏详情分片（默认 8 片），点到才拉、空闲时后台预取
 *   （坐标直接写在 core 里，前端不再做 1.8 万节点的松弛布局）
 *
 * 用法：node tools/precompute-layout.mjs [--in data/mesh.json] [--out data] [--chunks 8]
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSectorLayout } from "../src/layout-sector.js";
import { buildLinks } from "../src/links.js";
import { prepare } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};

const IN = resolve(ROOT, argOf("--in", "data/mesh.json"));
const OUT_DIR = resolve(ROOT, argOf("--out", "data"));
const CHUNKS = Math.max(1, Number(argOf("--chunks", "8")));
const HUB_ID = "deepseek-ai/deepseek-harness";

/** 挪到详情分片的字段：只有点开右栏才需要 */
const DETAIL_FIELDS = ["description", "topics", "license", "homepage", "sizeKb", "openIssues", "createdAt", "pushedAt", "updatedAt"];
/** 完全丢弃：能从 id 推出来，或者前端根本没用 */
const DROP_FIELDS = ["htmlUrl"];

const mesh = JSON.parse(await readFile(IN, "utf8"));
const prepared = prepare(mesh);

const t0 = performance.now();
const layout = createSectorLayout({
  nodes: prepared.nodes,
  centerId: HUB_ID,
  groupOf: (n) => n.category ?? "other",
  labelOf: (n, key) => n.categoryLabel ?? key,
  seed: mesh.meta?.seed ?? "mesh-v1",
});
const links = buildLinks(prepared, layout);
const t1 = performance.now();

const ids = prepared.nodes.map((n) => n.id);
const indexOf = new Map(ids.map((id, i) => [id, i]));

// 节点瘦身 + 直接写入坐标（四舍五入到 0.1，够画了）
let droppedBytes = 0;
const nodes = prepared.nodes.map((node, i) => {
  const slim = {};
  for (const [key, value] of Object.entries(node)) {
    if (DETAIL_FIELDS.includes(key) || DROP_FIELDS.includes(key)) {
      droppedBytes += JSON.stringify(value ?? null).length + key.length + 4;
      continue;
    }
    slim[key] = value;
  }
  // 注意：layout.x/y 是【动画当前坐标】（起始全 0），最终位置在 tx/ty —— 读错就会得到一堆 0
  slim.x = Math.round(layout.tx[i] * 10) / 10;
  slim.y = Math.round(layout.ty[i] * 10) / 10;
  slim.r = Math.round(layout.radius[i] * 10) / 10;
  return slim;
});

// 连线：id 字符串 → 索引三元组，体积掉到十分之一
const TYPE_CODE = { owner: 0, topic: 1, fork: 2, neighbor: 3 };
const edges = [];
for (const l of links) {
  edges.push([l.a, l.b, TYPE_CODE[l.type] ?? 3]);
}
const originalEdges = mesh.edges ?? [];
for (const e of originalEdges) {
  const a = indexOf.get(e.source ?? e.a);
  const b = indexOf.get(e.target ?? e.b);
  if (a === undefined || b === undefined) continue;
  const code = TYPE_CODE[e.type] ?? 1;
  // 避免与 buildLinks 产出的重复
  if (!edges.some((x) => x[0] === a && x[1] === b && x[2] === code)) edges.push([a, b, code]);
}

// 防呆：坐标读错（例如误用动画起始坐标）会得到全 0，这里直接失败，别把坏数据写出去
let maxAbs = 0;
for (const n of nodes) maxAbs = Math.max(maxAbs, Math.abs(n.x ?? 0), Math.abs(n.y ?? 0));
if (!(maxAbs > 1)) {
  console.error("预计算失败：坐标全是 0（布局的最终坐标在 tx/ty，不是 x/y）");
  process.exit(1);
}

const arms = layout.arms.map((arm) => ({
  id: arm.id,
  label: arm.label,
  count: arm.count,
  angle: Number(arm.angle.toFixed(4)),
  startAngle: Number(arm.startAngle.toFixed(4)),
  endAngle: Number(arm.endAngle.toFixed(4)),
  rMin: Number(arm.rMin.toFixed(1)),
  rMax: Number(arm.rMax.toFixed(1)),
  endRadius: Number(arm.endRadius.toFixed(1)),
  topId: arm.topId ?? null,
  // 成员索引（按离圆心远近排序），供面板显示"距圆心第 N 近"
  members: arm.members.map((m) => indexOf.get(m.id)).filter((i) => i !== undefined),
}));

const core = {
  meta: {
    ...mesh.meta,
    kind: "mesh-core",
    layout: "precomputed",
    layoutSeed: mesh.meta?.seed ?? "mesh-v1",
    layoutMs: Math.round(t1 - t0),
    chunks: CHUNKS,
    builtAt: new Date().toISOString(),
  },
  tags: mesh.tags,
  hubs: mesh.hubs,
  clusters: mesh.clusters,
  arms,
  nodes,
  edges,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "mesh-core.json"), JSON.stringify(core), "utf8");

// 详情分片：按索引取模，稳定且均匀
const detailDir = join(OUT_DIR, "details");
await rm(detailDir, { recursive: true, force: true });
await mkdir(detailDir, { recursive: true });
const buckets = Array.from({ length: CHUNKS }, () => ({}));
prepared.nodes.forEach((node, i) => {
  const detail = {};
  for (const field of DETAIL_FIELDS) {
    if (node[field] !== undefined) detail[field] = node[field];
  }
  if (Object.keys(detail).length) buckets[i % CHUNKS][node.id] = detail;
});
let detailBytes = 0;
for (let i = 0; i < CHUNKS; i++) {
  const text = JSON.stringify(buckets[i]);
  detailBytes += text.length;
  await writeFile(join(detailDir, i + ".json"), text, "utf8");
}

const coreBytes = JSON.stringify(core).length;
const originalBytes = JSON.stringify(mesh).length;
console.log("预计算完成（布局 " + Math.round(t1 - t0) + "ms）");
console.log("  原始 mesh.json : " + (originalBytes / 1048576).toFixed(1) + " MB");
console.log("  mesh-core.json : " + (coreBytes / 1048576).toFixed(1) + " MB  （省 " + (100 - (coreBytes / originalBytes) * 100).toFixed(0) + "%）");
console.log("  详情 " + CHUNKS + " 片     : " + (detailBytes / 1048576).toFixed(1) + " MB（点开右栏才拉）");
console.log("  节点 " + nodes.length + " · 连线 " + edges.length + " · 扇区 " + arms.length);
