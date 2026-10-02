#!/usr/bin/env node
/**
 * 无浏览器时的布局预览：把扇区布局画成 ASCII 图。
 * 用法：node tools/preview-ascii.mjs [category|language]
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare, formatStars } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "deepseek-ai/deepseek-harness";
const groupBy = process.argv[2] === "language" ? "language" : "category";
const W = 104;
const H = 46; // 字符高约为宽的两倍，行列比取 2:1 才不会被拉成椭圆

const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const prepared = prepare(mesh);

const topLanguages = new Set(
  [...prepared.nodes.reduce((m, n) => (n.language && m.set(n.language, (m.get(n.language) ?? 0) + 1), m), new Map())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k),
);
const groupOf = (n) => (groupBy === "language" ? (topLanguages.has(n.language) ? n.language : "其他语言") : n.category);
const labelOf = (n, key) => (groupBy === "language" ? key : n.categoryLabel ?? key);

const layout = createSectorLayout({ nodes: prepared.nodes, centerId: HUB, groupOf, labelOf, seed: "preview" });
layout.run(200);

const b = layout.getBounds(0);
const spanX = Math.max(1, b.maxX - b.minX);
const spanY = Math.max(1, b.maxY - b.minY);
const toCell = (x, y) => [
  Math.min(W - 1, Math.max(0, Math.round(((x - b.minX) / spanX) * (W - 1)))),
  Math.min(H - 1, Math.max(0, Math.round(((y - b.minY) / spanY) * (H - 1)))),
];

const grid = Array.from({ length: H }, () => Array(W).fill(" "));
const put = (x, y, ch) => {
  const [cx, cy] = toCell(x, y);
  grid[cy][cx] = ch;
};

// 扇区轴线（虚线感）
layout.arms.forEach((arm) => {
  const steps = 70;
  for (let k = 2; k <= steps; k += 2) {
    const r = (arm.endRadius * k) / steps;
    put(Math.cos(arm.angle) * r, Math.sin(arm.angle) * r, "·");
  }
});
// 节点：扇区序号
const armIndexOf = new Map();
layout.arms.forEach((arm, i) => arm.members.forEach((m) => armIndexOf.set(m.id, i)));
for (let i = 0; i < layout.size; i++) {
  const node = layout.nodes[i];
  if (node.id === HUB) {
    put(0, 0, "O");
    continue;
  }
  put(layout.x[i], layout.y[i], String((armIndexOf.get(node.id) ?? 0) % 10));
}

console.log(grid.map((r) => r.join("").replace(/\s+$/, "")).join("\n"));
console.log("\n图例（按 " + (groupBy === "language" ? "语言" : "功能分类") + " 分扇区）：");
layout.arms.forEach((a, i) => {
  const wide = (((a.endAngle - a.startAngle) * 180) / Math.PI).toFixed(1);
  const rs = a.members.map((m) => m.r);
  console.log(
    "  " + String(i % 10) + " = " + (a.label ?? a.id).padEnd(7) + a.id.padEnd(10) + String(a.count).padStart(4) +
    " 个 · 扇区 " + wide.padStart(4) + "° · 半径 " + Math.round(Math.min(...rs)) + "~" + Math.round(Math.max(...rs)),
  );
});
console.log("  O = " + HUB + "（圆心 / 官方仓库）");
console.log("\n每个扇区最靠近圆心的 3 个（星标整体由内向外递减）：");
for (const a of layout.arms) {
  console.log("  " + (a.label ?? a.id));
  a.members.slice(0, 3).forEach((m, i) => {
    console.log("    " + (i + 1) + ". r=" + m.r.toFixed(0).padStart(4) + "  " + formatStars(m.stars).padStart(6) + "★  " + m.id);
  });
}
