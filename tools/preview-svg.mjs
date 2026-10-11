/**
 * 预览图渲染（SVG）—— 离线生成与站点实时接口共用同一套代码：
 *   sceneFromCore(core)   读 data/mesh-core.json（站点接口用，不跑布局）
 *   sceneFromLayout(...)  现场跑布局（离线工具用，保证与前端布局代码一致）
 * README 用站点实时接口而非提交静态图：静态图数据一变就过期（曾变成「没画面」）。
 * 尺寸无关：字号 / 图例 / 留白 / 球半径都是按 REF_SIZE 设计的固定像素，统一乘 size/REF_SIZE，
 *   所以 600 与 1400 出的是同一张图的不同分辨率。只缩坐标不缩这些常量的话，小画布上字会互相压、
 *   球会挤成一片 —— 线上 README 预览图（当时落到最小档 600）就是这么坏掉的。
 */
import { groupColor } from "../src/mesh-data.js";
import { PALETTES } from "../src/palettes.js";

const FONT = "-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif";
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/** 预计算契约 → 场景（站点接口路径：不跑布局，直接可用） */
export function sceneFromCore(core) {
  const nodes = (core.nodes ?? []).map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    r: n.r,
    stars: n.stars ?? 0,
    category: n.category ?? "other",
    categoryLabel: n.categoryLabel ?? n.category ?? "其他",
  }));
  const arms = (core.arms ?? []).map((a) => ({
    id: a.id,
    label: a.label ?? a.id,
    count: a.count ?? (a.members?.length ?? 0),
    angle: a.angle,
    startAngle: a.startAngle,
    endAngle: a.endAngle,
    rMin: a.rMin ?? 0,
    endRadius: a.endRadius ?? a.rMax ?? 0,
  }));
  return {
    nodes,
    arms,
    hubId: core.meta?.hubId ?? null,
    total: core.meta?.indexedNodes ?? core.meta?.sampleNodes ?? nodes.length,
    generatedAt: core.meta?.generatedAt ?? "",
    edges: null,
  };
}

export function sceneFromLayout(layout, prepared, links) {
  const nodes = [];
  for (let i = 0; i < layout.size; i++) {
    const n = layout.nodes[i];
    if (!n) continue;
    nodes.push({
      id: n.id,
      x: layout.x[i],
      y: layout.y[i],
      r: layout.radius[i],
      stars: n.stars ?? 0,
      category: n.category ?? "other",
      categoryLabel: n.categoryLabel ?? n.category ?? "其他",
    });
  }
  const arms = layout.arms.map((a) => ({
    id: a.id,
    label: a.label ?? a.id,
    count: a.count ?? a.members.length,
    angle: a.angle,
    startAngle: a.startAngle,
    endAngle: a.endAngle,
    rMin: a.rMin ?? 0,
    endRadius: a.endRadius ?? a.rMax ?? 0,
  }));
  return {
    nodes,
    arms,
    hubId: null,
    total: prepared.nodes.length,
    generatedAt: prepared.meta?.generatedAt ?? "",
    edges: links ?? null,
  };
}

export const radiusOf = (n) => Math.max(2.2, Math.min(11, 2.2 + Math.log10(1 + (n.stars || 0)) * 2.2));

/** 抽样：星标头部 55% + 其余随机 45%（大仓库必在，长尾仍有纹理） */
export function pickSample(nodes, sample) {
  if (sample >= nodes.length) return nodes.slice();
  const byStars = nodes.slice().sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const top = byStars.slice(0, Math.floor(sample * 0.55));
  const taken = new Set(top.map((n) => n.id));
  const rest = nodes.filter((n) => !taken.has(n.id));
  let seed = 20261004;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  while (top.length < sample && rest.length) {
    const i = Math.floor(rnd() * rest.length);
    top.push(rest[i]);
    rest.splice(i, 1);
  }
  return top;
}

/** 参考画布：字号 / 图例 / 留白 / 球半径这些固定像素常量都按这个尺寸设计 */
export const REF_SIZE = 1400;

/** 渲染预览 SVG；scene：{ nodes, arms, total, generatedAt, hubId?, edges? } */
/** 场景 → 画布坐标变换（渲染与"核对图"共用，保证两者完全一致） */
export function previewView(scene, size = REF_SIZE, pad = 96) {
  const k = size / REF_SIZE; // 画布缩放比：固定像素常量都乘它，构图才与画布尺寸无关
  pad *= k; // 留白也跟着缩，否则小画布上图形只占中间一小块，字显得比图还大
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const grow = (x, y, p) => {
    minX = Math.min(minX, x - p);
    maxX = Math.max(maxX, x + p);
    minY = Math.min(minY, y - p);
    maxY = Math.max(maxY, y + p);
  };
  for (const n of scene.nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    grow(n.x, n.y, (n.r ?? 6) + 6);
  }
  for (const a of scene.arms) {
    const r = (a.endRadius ?? 0) * 1.04 + 40;
    grow(-r, -r, 0);
    grow(r, r, 0);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size - pad * 2) / span;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return {
    scale,
    midX,
    midY,
    k,
    px: (x) => size / 2 + (x - midX) * scale,
    py: (y) => size / 2 + (y - midY) * scale,
  };
}

export function renderPreviewSvg(scene, { theme: themeMode = "dark", size = REF_SIZE, sample = 7000 } = {}) {
  const theme = PALETTES.fresh[themeMode] ?? PALETTES.fresh.dark;
  const canvas = theme.canvas;
  const nodes = scene.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  const hub =
    (scene.hubId && nodes.find((n) => n.id === scene.hubId)) ||
    nodes.reduce((best, n) => (best === null || Math.hypot(n.x, n.y) < Math.hypot(best.x, best.y) ? n : best), null);

  const { scale, px, py, k } = previewView(scene, size);
  /** 固定像素常量 → 当前画布像素（画布缩小时字、图例、球一起缩，避免"坐标缩了、字没缩"挤成一团） */
  const at = (v) => Math.round(v * k * 10) / 10;

  const armColor = (id) => groupColor(id, scene.arms.findIndex((a) => a.id === id));
  const colorOfNode = new Map();
  for (const n of nodes) if (!colorOfNode.has(n.id)) colorOfNode.set(n.id, groupColor(n.category, scene.arms.findIndex((a) => a.id === n.category)));

  const draw = pickSample(nodes.filter((n) => n.id !== hub?.id), sample);

  const parts = [];
  parts.push(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size +
      '" role="img" aria-label="插件生态图：功能扇区与仓库球">',
  );
  parts.push('<rect width="' + size + '" height="' + size + '" fill="' + canvas.bg + '"/>');

  for (const a of scene.arms) {
    if (!a.count) continue;
    const color = armColor(a.id);
    const outer = (a.endRadius ?? 0) * 1.04;
    const inner = Math.max(0, (a.rMin ?? 0) * 0.55);
    const P = (ang, rad) => [px(Math.cos(ang) * rad), py(Math.sin(ang) * rad)];
    const [x0, y0] = P(a.startAngle, inner);
    const [x1, y1] = P(a.startAngle, outer);
    const [x2, y2] = P(a.endAngle, outer);
    const [x3, y3] = P(a.endAngle, inner);
    const large = Math.abs(a.endAngle - a.startAngle) > Math.PI ? 1 : 0;
    parts.push(
      '<path d="M' + x0.toFixed(1) + " " + y0.toFixed(1) + " L" + x1.toFixed(1) + " " + y1.toFixed(1) +
        " A" + (outer * scale).toFixed(1) + " " + (outer * scale).toFixed(1) + " 0 " + large + " 1 " + x2.toFixed(1) + " " + y2.toFixed(1) +
        " L" + x3.toFixed(1) + " " + y3.toFixed(1) + " A" + (inner * scale).toFixed(1) + " " + (inner * scale).toFixed(1) + " 0 " + large + " 0 " +
        x0.toFixed(1) + " " + y0.toFixed(1) + ' Z" fill="' + color + '" opacity="0.1"/>',
    );
  }

  // 仓库球（<use> 复用符号，否则近两万个球会把 SVG 写到上兆）
  const symbolOf = new Map();
  const balls = [];
  const idOf = (key) => "s" + key.replace(/[^0-9a-zA-Z]/g, "_");
  for (const n of draw) {
    const color = colorOfNode.get(n.id) ?? canvas.accent;
    const r = Math.round(radiusOf(n) * k * 2) / 2; // 球半径也是固定像素，不缩的话小画布上球会挤成一片
    const key = color.replace("#", "") + "-" + r;
    if (!symbolOf.has(key)) symbolOf.set(key, { color, r });
    balls.push('<use href="#' + idOf(key) + '" x="' + px(n.x).toFixed(1) + '" y="' + py(n.y).toFixed(1) + '"/>');
  }
  const defs = ["<defs>"];
  for (const [key, s] of symbolOf) {
    defs.push(
      '<circle id="' + idOf(key) + '" r="' + s.r + '" fill="' + canvas.ball + '" stroke="' + s.color +
        '" stroke-width="' + Math.max(at(1.1), s.r * 0.34).toFixed(1) + '"/>',
    );
  }
  defs.push("</defs>");
  parts.push(defs.join(""));
  parts.push(balls.join(""));

  if (hub) {
    const hx = px(hub.x);
    const hy = py(hub.y);
    parts.push('<circle cx="' + hx.toFixed(1) + '" cy="' + hy.toFixed(1) + '" r="' + at(20) + '" fill="' + canvas.ball + '" stroke="' + canvas.accent + '" stroke-width="' + at(6) + '"/>');
    parts.push('<text x="' + hx.toFixed(1) + '" y="' + (hy + at(42)).toFixed(1) + '" text-anchor="middle" font-family="' + FONT + '" font-size="' + at(17) + '" font-weight="600" fill="' + canvas.text + '">' + esc(hub.id) + "</text>");
  }

  const fontSize = at(21); // 21px 是按 1400 画布定的，小画布上仍用 21px 就会和邻居压在一起
  parts.push('<g font-family="' + FONT + '" text-anchor="middle">');
  for (const a of scene.arms) {
    if (!a.count) continue;
    const dist = (a.endRadius ?? 0) * 1.04 + 26;
    const x = px(Math.cos(a.angle) * dist);
    const y = py(Math.sin(a.angle) * dist);
    if (x < at(60) || y < at(40) || x > size - at(60) || y > size - at(30)) continue;
    parts.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + fontSize + '" font-weight="600" fill="' + armColor(a.id) + '">' + esc(a.label) + "</text>");
    parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + fontSize - at(2)).toFixed(1) + '" font-size="' + (fontSize - at(5)) + '" fill="' + canvas.text + '" opacity="0.55">' + a.count + "</text>");
  }
  parts.push("</g>");

  const secCount = scene.arms.filter((a) => a.count).length;
  parts.push('<g font-family="' + FONT + '" fill="' + canvas.text + '">');
  parts.push('<text x="' + at(34) + '" y="' + at(52) + '" font-size="' + at(30) + '" font-weight="700">插件生态图</text>');
  parts.push('<text x="' + at(34) + '" y="' + at(82) + '" font-size="' + at(17) + '" opacity="0.62">' + scene.total + " 个仓库 · " + secCount + " 个功能扇区 · 圆心为官方仓库</text>");
  parts.push('<text x="' + at(34) + '" y="' + at(106) + '" font-size="' + at(14) + '" opacity="0.45">图上按星标抽样 ' + draw.length + " 个仓库球；颜色 = 功能分类，半径 = 星标（对数）</text>");
  if (scene.generatedAt) parts.push('<text x="' + at(34) + '" y="' + at(128) + '" font-size="' + at(14) + '" opacity="0.45">数据 ' + esc(scene.generatedAt) + " · 由站点实时渲染</text>");
  parts.push("</g>");

  const legend = scene.arms.filter((a) => a.count).slice(0, 8);
  parts.push('<g font-family="' + FONT + '" font-size="' + at(16) + '">');
  legend.forEach((a, i) => {
    const y = size - at(30) - (legend.length - 1 - i) * at(25);
    parts.push('<circle cx="' + at(40) + '" cy="' + (y - at(5)) + '" r="' + at(7) + '" fill="' + armColor(a.id) + '"/>');
    parts.push('<text x="' + at(56) + '" y="' + y + '" fill="' + canvas.text + '" opacity="0.8">' + esc(a.label) + "（" + a.count + "）</text>");
  });
  parts.push("</g>");
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}
