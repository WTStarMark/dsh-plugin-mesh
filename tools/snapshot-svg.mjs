#!/usr/bin/env node
/**
 * 生成 README 用的预览图（SVG）。
 *
 * 为什么要自己画：本项目没有无头浏览器，截不了图；但布局与配色的代码就在仓库里，
 * 直接复用同一套 createSectorLayout + 配色，产出的预览图永远和当前代码一致，
 * 不会出现"README 里的图还是三个版本前"的问题。
 *
 * 用法：node tools/snapshot-svg.mjs [--out docs/preview.svg] [--size 1400] [--theme dark]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSectorLayout } from "../src/layout-sector.js";
import { buildLinks } from "../src/links.js";
import { prepare, groupColor } from "../src/mesh-data.js";
import { PALETTES } from "../src/palettes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};

const OUT = resolve(ROOT, argOf("--out", "docs/preview.svg"));
const SIZE = Number(argOf("--size", "1400"));
const THEME_MODE = argOf("--theme", "dark");
const HUB_ID = "deepseek-ai/deepseek-harness";

const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const prepared = prepare(mesh);
const theme = PALETTES.fresh[THEME_MODE];
const canvas = theme.canvas;

const layout = createSectorLayout({
  nodes: prepared.nodes,
  centerId: HUB_ID,
  groupOf: (n) => n.category ?? "other",
  labelOf: (n, key) => n.categoryLabel ?? key,
  seed: "readme-preview",
});

const links = buildLinks(prepared, layout).filter((l) => l.type === "owner");

// 布局坐标 → 画布坐标：等比铺满（坐标在 layout.x/y 数组里，索引用 layout.index）
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < layout.size; i++) {
  minX = Math.min(minX, layout.x[i] - 14); maxX = Math.max(maxX, layout.x[i] + 14);
  minY = Math.min(minY, layout.y[i] - 14); maxY = Math.max(maxY, layout.y[i] + 14);
}
const span = Math.max(maxX - minX, maxY - minY);
const scale = (SIZE * 0.92) / span;
const cx = SIZE / 2;
const cy = SIZE / 2;
const midX = (minX + maxX) / 2;
const midY = (minY + maxY) / 2;
const px = (x) => cx + (x - midX) * scale;
const py = (y) => cy + (y - midY) * scale;

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const colorOf = new Map();
prepared.nodes.forEach((n, i) => {
  const cat = n.category ?? "other";
  if (!colorOf.has(n.id)) colorOf.set(n.id, groupColor(cat, layout.arms.findIndex((a) => a.id === cat)));
});

const parts = [];
parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + SIZE + '" height="' + SIZE + '" viewBox="0 0 ' + SIZE + " " + SIZE + '" role="img" aria-label="插件生态图预览">');
parts.push('<rect width="' + SIZE + '" height="' + SIZE + '" fill="' + canvas.bg + '"/>');

// 扇区柔光
for (const arm of layout.arms) {
  if (!arm.members.length) continue;
  const color = groupColor(arm.id, layout.arms.findIndex((a) => a.id === arm.id));
  const a0 = arm.startAngle;
  const a1 = arm.endAngle;
  const r = arm.endRadius * 1.04;
  const inner = Math.max(4, arm.rMin * 0.5);
  const p = (ang, rad) => [px(Math.cos(ang) * rad), py(Math.sin(ang) * rad)];
  const [x0, y0] = p(a0, inner);
  const [x1, y1] = p(a0, r);
  const [x2, y2] = p(a1, r);
  const [x3, y3] = p(a1, inner);
  parts.push(
    '<path d="M' + x0.toFixed(1) + " " + y0.toFixed(1) + " L" + x1.toFixed(1) + " " + y1.toFixed(1) +
      " A" + r.toFixed(1) + " " + r.toFixed(1) + " 0 0 1 " + x2.toFixed(1) + " " + y2.toFixed(1) +
      " L" + x3.toFixed(1) + " " + y3.toFixed(1) + " Z" + '" fill="' + color + '" opacity="0.07"/>',
  );
}

// 同作者连线
for (const l of links.slice(0, 1200)) {
  if (l.a == null || l.b == null) continue;
  parts.push('<line x1="' + px(layout.x[l.a]).toFixed(1) + '" y1="' + py(layout.y[l.a]).toFixed(1) + '" x2="' + px(layout.x[l.b]).toFixed(1) + '" y2="' + py(layout.y[l.b]).toFixed(1) + '" stroke="' + canvas.accent + '" stroke-width="0.7" opacity="0.18"/>');
}

// 节点：球底色白/黑 + 分类色外环
for (let i = 0; i < layout.size; i++) {
  const n = layout.nodes[i];
  if (!n || n.id === HUB_ID) continue;
  const r = Math.max(2.2, Math.min(11, 2.2 + Math.log10(1 + (n.stars || 0)) * 2.2));
  const color = colorOf.get(n.id) ?? canvas.accent;
  parts.push('<circle cx="' + px(layout.x[i]).toFixed(1) + '" cy="' + py(layout.y[i]).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + canvas.ball + '" stroke="' + color + '" stroke-width="' + Math.max(1.2, r * 0.34).toFixed(1) + '"/>');
}

// 圆心主仓库
const hubIndex = layout.index.get(HUB_ID);
if (hubIndex !== undefined) {
  parts.push('<circle cx="' + px(layout.x[hubIndex]).toFixed(1) + '" cy="' + py(layout.y[hubIndex]).toFixed(1) + '" r="17" fill="' + canvas.ball + '" stroke="' + canvas.accent + '" stroke-width="5"/>');
}

// 扇区标签
parts.push('<g font-family="-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif" font-size="' + Math.round(SIZE / 78) + '" font-weight="600" fill="' + canvas.text + '">');
for (const arm of layout.arms) {
  const dist = arm.endRadius + 30;
  const x = px(Math.cos(arm.angle) * dist);
  const y = py(Math.sin(arm.angle) * dist);
  if (x < 10 || y < 10 || x > SIZE - 10 || y > SIZE - 10) continue;
  const color = groupColor(arm.id, layout.arms.findIndex((a) => a.id === arm.id));
  parts.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" fill="' + color + '">' + esc(arm.label ?? arm.id) + "</text>");
  parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + SIZE / 78 + 3).toFixed(1) + '" text-anchor="middle" font-size="' + Math.round(SIZE / 100) + '" font-weight="400" fill="' + canvas.text + '" opacity="0.6">' + arm.count + " 个仓库</text>");
}
parts.push("</g>");
parts.push("</svg>");

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, parts.join("\n"), "utf8");
console.log("已生成 " + OUT);
console.log("  节点 " + layout.nodes.length + " · 扇区 " + layout.arms.length + " · 同作者连线 " + links.length + " 条 · " + THEME_MODE);
