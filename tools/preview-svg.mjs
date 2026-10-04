/**
 * 预览图渲染（SVG）—— 离线生成与站点实时接口共用同一套代码。
 *
 * 两条数据来源：
 *   sceneFromCore(core)              读 data/mesh-core.json（预计算契约，已带 x/y/r 与扇区几何）→ 站点接口用
 *   sceneFromLayout(layout, prepared) 现场跑布局 → 离线工具用（保证与前端布局代码一致）
 *
 * 为什么要有站点接口：README 里的预览图如果是提交进仓库的静态文件，
 * 数据一变就过期（上次就是这么变成"没画面"的）。改由站点按当前数据实时渲染，
 * 每次采集之后图自己就更新了。
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

/** 现场布局 → 场景（离线路径） */
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

/**
 * 渲染预览 SVG。
 * scene：{ nodes, arms, total, generatedAt, hubId?, edges? }
 */
/** 场景 → 画布坐标变换（渲染与"核对图"共用，保证两者完全一致） */
export function previewView(scene, size = 1400, pad = 96) {
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
    px: (x) => size / 2 + (x - midX) * scale,
    py: (y) => size / 2 + (y - midY) * scale,
  };
}

export function renderPreviewSvg(scene, { theme: themeMode = "dark", size = 1400, sample = 7000 } = {}) {
  const theme = PALETTES.fresh[themeMode] ?? PALETTES.fresh.dark;
  const canvas = theme.canvas;
  const nodes = scene.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  const hub =
    (scene.hubId && nodes.find((n) => n.id === scene.hubId)) ||
    nodes.reduce((best, n) => (best === null || Math.hypot(n.x, n.y) < Math.hypot(best.x, best.y) ? n : best), null);

  const { scale, px, py } = previewView(scene, size);

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

  // 扇区柔光
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
    const key = color.replace("#", "") + "-" + Math.round(radiusOf(n) * 2) / 2;
    if (!symbolOf.has(key)) symbolOf.set(key, { color, r: Math.round(radiusOf(n) * 2) / 2 });
    balls.push('<use href="#' + idOf(key) + '" x="' + px(n.x).toFixed(1) + '" y="' + py(n.y).toFixed(1) + '"/>');
  }
  const defs = ["<defs>"];
  for (const [key, s] of symbolOf) {
    defs.push(
      '<circle id="' + idOf(key) + '" r="' + s.r + '" fill="' + canvas.ball + '" stroke="' + s.color +
        '" stroke-width="' + Math.max(1.1, s.r * 0.34).toFixed(1) + '"/>',
    );
  }
  defs.push("</defs>");
  parts.push(defs.join(""));
  parts.push(balls.join(""));

  if (hub) {
    const hx = px(hub.x);
    const hy = py(hub.y);
    parts.push('<circle cx="' + hx.toFixed(1) + '" cy="' + hy.toFixed(1) + '" r="20" fill="' + canvas.ball + '" stroke="' + canvas.accent + '" stroke-width="6"/>');
    parts.push('<text x="' + hx.toFixed(1) + '" y="' + (hy + 42).toFixed(1) + '" text-anchor="middle" font-family="' + FONT + '" font-size="17" font-weight="600" fill="' + canvas.text + '">' + esc(hub.id) + "</text>");
  }

  // 扇区标签（沿中轴朝外）
  const fontSize = 21;
  parts.push('<g font-family="' + FONT + '" text-anchor="middle">');
  for (const a of scene.arms) {
    if (!a.count) continue;
    const dist = (a.endRadius ?? 0) * 1.04 + 26;
    const x = px(Math.cos(a.angle) * dist);
    const y = py(Math.sin(a.angle) * dist);
    if (x < 60 || y < 40 || x > size - 60 || y > size - 30) continue;
    parts.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + fontSize + '" font-weight="600" fill="' + armColor(a.id) + '">' + esc(a.label) + "</text>");
    parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + fontSize - 2).toFixed(1) + '" font-size="' + (fontSize - 5) + '" fill="' + canvas.text + '" opacity="0.55">' + a.count + "</text>");
  }
  parts.push("</g>");

  const secCount = scene.arms.filter((a) => a.count).length;
  parts.push('<g font-family="' + FONT + '" fill="' + canvas.text + '">');
  parts.push('<text x="34" y="52" font-size="30" font-weight="700">插件生态图</text>');
  parts.push('<text x="34" y="82" font-size="17" opacity="0.62">' + scene.total + " 个仓库 · " + secCount + " 个功能扇区 · 圆心为官方仓库</text>");
  parts.push('<text x="34" y="106" font-size="14" opacity="0.45">图上按星标抽样 ' + draw.length + " 个仓库球；颜色 = 功能分类，半径 = 星标（对数）</text>");
  if (scene.generatedAt) parts.push('<text x="34" y="128" font-size="14" opacity="0.45">数据 ' + esc(scene.generatedAt) + " · 由站点实时渲染</text>");
  parts.push("</g>");

  const legend = scene.arms.filter((a) => a.count).slice(0, 8);
  parts.push('<g font-family="' + FONT + '" font-size="16">');
  legend.forEach((a, i) => {
    const y = size - 30 - (legend.length - 1 - i) * 25;
    parts.push('<circle cx="40" cy="' + (y - 5) + '" r="7" fill="' + armColor(a.id) + '"/>');
    parts.push('<text x="56" y="' + y + '" fill="' + canvas.text + '" opacity="0.8">' + esc(a.label) + "（" + a.count + "）</text>");
  });
  parts.push("</g>");
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}
