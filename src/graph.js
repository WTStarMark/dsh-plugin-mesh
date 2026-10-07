/**
 * Canvas 渲染器 + 交互（对齐 DSH 视觉）。
 *
 * 主题由 src/palettes.js 注入（清爽 / 粉黛 × 浅色 / 深色），结构令牌沿用 DSH；
 * 球体在足够大时显示作者头像（并发受限、按 URL 去重、失败不重试）。
 * 画法刻意保持克制：细线、低对比、柔和光点与柔和扇区光。
 */
import { colorOfTag, groupColor, EDGE_STYLES, ownerSiblings, RAY_HIT_LIMIT } from "./mesh-data.js";
import { themeOf } from "./palettes.js";
import { createAvatarStore } from "./avatars.js";

const LABEL_MAX = 90;
const RING_STEPS = [200, 500, 1000, 2000, 4000, 8000];

/**
 * 线段两端各退让 stopA / stopB（纯几何，独立出来便于单测）。
 *
 * 用途：被指向的球外面套着同色光圈，连线要停在【光圈外沿】而不是画到球心，
 * 否则线会从球里穿出来压在光圈上。退让量按弦长的一半夹住，两球贴太近时线也不会被翻过来。
 */
export function trimSegment(x1, y1, x2, y2, stopA = 0, stopB = 0) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const sa = Math.min(Math.max(0, stopA), len * 0.45);
  const sb = Math.min(Math.max(0, stopB), len * 0.45);
  return { ax: x1 + ux * sa, ay: y1 + uy * sa, bx: x2 - ux * sb, by: y2 - uy * sb, len, ux, uy, sa, sb };
}
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/** #rrggbb -> "r,g,b"（用于 rgba() 拼 alpha） */
function hexParts(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}

/** 头像只在"球足够大"时才画：太小时头像只是一团糊色，不如纯色点 */
const AVATAR_MIN_RADIUS = 4.5;

export function createGraphView(canvas, hooks = {}) {
  const ctx = canvas.getContext("2d");
  const view = { x: 0, y: 0, k: 1 };
  const pointer = { x: 0, y: 0, inside: false };

  let dpr = 1;
  let cssW = 1;
  let cssH = 1;
  let layout = null;
  let prepared = null;
  let highlight = null;
  let searchHits = null; // 搜索命中集合：从圆心向它们画放射线
  // 同作者兄弟缓存：一帧可能要画上千条线，别每帧都重新过滤一遍 owner 索引
  let siblingCache = { id: null, ids: null };
  function siblingsOf(id) {
    if (siblingCache.id !== id) siblingCache = { id, ids: ownerSiblings(prepared, id) };
    return siblingCache.ids;
  }
  let selectedId = null;
  let hoverId = null;
  // 被连线指向的球（按边类型分组）：点选后给它们套同色光圈（见 drawTargetRings）
  const linkTargets = { owner: [], topic: [], resonance: [] };
  let showLabels = true;
  let edgeTypes = new Set(["topic", "owner"]);
  let groupColors = new Map();
  let links = [];
  let sectorFocus = null;
  let focusIds = null;
  let theme = themeOf();
  let gridRGB = hexParts(theme.canvas.ink);
  let showAvatars = true;
  // 头像是一张张流式到货的：每张都触发整画布重绘（1.7 万球 + 2.3 万边）会变成持续卡顿。
  // 合并成 250ms 一次；流式期间顺便降 LOD（复用手势那套低细节渲染），最后一张仍会补画。
  let avatarPaintAt = 0;
  let avatarPaintTimer = 0;
  let avatarBurstTimer = 0;
  const avatars = createAvatarStore({
    concurrency: 6,
    onLoad: () => {
      lowDetail = true;
      clearTimeout(avatarBurstTimer);
      avatarBurstTimer = setTimeout(() => {
        lowDetail = false;
        invalidate();
      }, 320);
      const now = Date.now();
      if (now - avatarPaintAt < 250) {
        if (!avatarPaintTimer) {
          avatarPaintTimer = setTimeout(() => {
            avatarPaintTimer = 0;
            avatarPaintAt = Date.now();
            dirty = true;
            wake();
          }, 250);
        }
        return;
      }
      avatarPaintAt = now;
      dirty = true;
      wake();
    },
  });
  let running = false;
  let dirty = true;
  // 交互期降 LOD：拖拽/缩放进行中先不画连线与标签，停手 140ms 后再画精细版
  let lowDetail = false;
  let lowDetailTimer = 0;
  function bumpInteraction() {
    lowDetail = true;
    clearTimeout(lowDetailTimer);
    lowDetailTimer = setTimeout(() => {
      lowDetail = false;
      invalidate();
    }, 140);
  }
  let drag = null;
  let raf = 0;

  const P = () => ({
    bg: theme.canvas.bg,
    ink: theme.canvas.ink,
    dim: theme.canvas.dim,
    faint: theme.canvas.faint,
    accent: theme.canvas.accent,
    warn: theme.canvas.warn,
    ball: theme.canvas.ball ?? "#ffffff",
    text: theme.canvas.text ?? "#ffffff",
    grid: gridRGB,
  });
  const rgba = (parts, a) => "rgba(" + parts + "," + a + ")";
  const p = () => P();

  function hasArms() {
    return !!layout && Array.isArray(layout.arms) && layout.arms.length > 0;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    dirty = true;
    wake();
  }

  const toScreen = (x, y) => [x * view.k + view.x, y * view.k + view.y];
  const toWorld = (sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];

  function pick(mx, my) {
    if (!layout) return null;
    const nodes = layout.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
      const r = Math.max(7, layout.radius[i] * view.k + 4);
      if ((mx - sx) ** 2 + (my - sy) ** 2 <= r * r) return nodes[i].id;
    }
    return null;
  }

  const isActive = (node) => !highlight || highlight.has(node.id);

  /** 底图：极淡的距离环（表示离圆心多远：全景＝离官方仓库，以某仓库为中心时＝离它），其余留白 */
  function drawBackdrop() {
    const p = P();
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    if (!hasArms()) return;
    const [cx, cy] = toScreen(0, 0);
    const reach = Math.hypot(cssW, cssH);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "10.5px " + FONT;
    for (const R of RING_STEPS) {
      const r = R * view.k;
      if (r < 30 || r > reach) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(p.grid, 0.045);
      ctx.stroke();
      ctx.fillStyle = hexA(p.text, 0.32);
      ctx.fillText(String(R), cx + 6, cy - r - 8);
    }
  }

  /** 扇区：柔和底色 + 细边界 + 外弧 + 平放标签（不做旋转与刻度） */
  /** 画一层扇形光（可指定角宽与强度），用于"整体弱 + 内核强"的柔化叠加 */
  function paintWedge(cx, cy, rEnd, a0, a1, color, scale) {
    if (rEnd < 8 || scale <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rEnd, a0, a1);
    ctx.closePath();
    ctx.clip();
    const inner = Math.max(8, 30 * view.k);
    const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, rEnd));
    grad.addColorStop(0, hexA(color, 0));
    grad.addColorStop(0.2, hexA(color, 0.1 * scale));
    grad.addColorStop(0.55, hexA(color, 0.19 * scale));
    grad.addColorStop(0.86, hexA(color, 0.1 * scale));
    grad.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rEnd, cy - rEnd, rEnd * 2, rEnd * 2);
    ctx.restore();
  }

  function drawSectors() {
    if (!hasArms()) return;
    const p = P();
    const [cx, cy] = toScreen(0, 0);
    layout.arms.forEach((arm, i) => {
      const color = groupColors.get(arm.id) ?? groupColor(arm.id, i);
      const rEnd = Math.max(8, (arm.endRadius ?? 0) * view.k);
      const a0 = arm.startAngle ?? arm.angle - 0.2;
      const a1 = arm.endAngle ?? arm.angle + 0.2;
      // 扇区 = 一束柔和的光。两层叠加：整扇区一层弱光 + 内层窄一点、亮一点，
      // 这样边缘自然柔化，扇区本身比原来明显得多（强化扇区）。
      const dim = sectorFocus && sectorFocus !== arm.id ? 0.32 : 1;
      paintWedge(cx, cy, rEnd, a0, a1, color, dim);
      const mid = (a0 + a1) / 2;
      const half = ((a1 - a0) / 2) * 0.62;
      paintWedge(cx, cy, rEnd * 0.99, mid - half, mid + half, color, dim * 0.8);
      if (rEnd < 60) return;
      const lx = cx + Math.cos(arm.angle) * (rEnd + 16);
      const ly = cy + Math.sin(arm.angle) * (rEnd + 16);
      const flip = Math.cos(arm.angle) < 0;
      ctx.beginPath();
      ctx.arc(flip ? lx + 4 : lx - 4, ly - 4, 3, 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, 0.9);
      ctx.fill();
      ctx.textAlign = flip ? "right" : "left";
      ctx.textBaseline = "middle";
      ctx.font = "600 14px " + FONT;
      ctx.fillStyle = hexA(p.text, sectorFocus && sectorFocus !== arm.id ? 0.32 : 0.98);
      ctx.fillText(arm.label ?? arm.id, flip ? lx - 2 : lx + 11, ly - 5);
      ctx.font = "12px " + FONT;
      ctx.fillStyle = hexA(color, sectorFocus && sectorFocus !== arm.id ? 0.3 : 0.85);
      ctx.fillText(arm.count + " 个仓库", flip ? lx - 2 : lx + 11, ly + 12);
      ctx.textAlign = "left";
    });
  }

  /**
   * 一条边：向"远离圆心"的方向鼓起的二次曲线，避免所有线穿过中心（只建路径，不描边）。
   *
   * stopA / stopB 是两端各自要退让的屏幕距离（v0.4.3）：
   * 被指向的球外面套着同色光圈，线要是还画到球心，就会从球里穿出来、压在光圈上——
   * 所以两端各退让到【光圈外沿】，看起来才是"线接到光圈上"。
   */
  function edgePath(a, b, curv, stopA = 0, stopB = 0) {
    const [x1, y1] = toScreen(layout.x[a], layout.y[a]);
    const [x2, y2] = toScreen(layout.x[b], layout.y[b]);
    const { ax, ay, bx, by, len, sa, sb } = trimSegment(x1, y1, x2, y2, stopA, stopB);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const [ox, oy] = toScreen(0, 0);
    let nx = mx - ox;
    let ny = my - oy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const bulge = curv * Math.max(1, len - sa - sb);
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(mx + nx * bulge, my + ny * bulge, bx, by);
  }

  /** 目标球光圈外沿的屏幕距离：公式必须与 drawTargetRings 的半径一致，线才正好接到光圈上 */
  function ringStop(i, slot) {
    return Math.max(2, layout.radius[i] * view.k) + 3 + slot * 2.4 + 1;
  }

  /** 出发端：从选中项自己的球外侧起步（不画到球心，省得在球里藏一截线） */
  function sourceStop(i) {
    return Math.max(2, layout.radius[i] * view.k) + 2;
  }

  function edgeColor(l, style) {
    if (style.color) return style.color;
    const node = layout.nodes[l.a];
    return groupColors.get(node.category) ?? colorOfTag(node.primaryTag);
  }

  function drawEdges() {
    if (!layout) return;
    // 连线不再常驻：只有点选某个仓库时，才画它自己的两类连线——
    // 同作者（主题主色 · 实线）与主题共现（琥珀色 · 虚线），颜色区分开。
    if (selectedId == null) return;
    const center = layout.index.get(selectedId);
    if (center === undefined) return;
    // 注意：拖拽/缩放中也照样画选中节点的连线（数量很少，而且正是用户要看的东西）

    // 同作者（v0.4.2）：以 owner 索引为准，不再只看数据里存的边——
    // 大作者在数据层是星形拓扑，只看存边会出现"有的能连到其余全部、有的只连到一个"。
    // 成批建路径后一次描边：同作者可能几十上百个，逐条 stroke 会明显掉帧。
    const ownerTargets = [];
    for (const sibling of siblingsOf(selectedId)) {
      const i = layout.index.get(sibling);
      if (i !== undefined && i !== center) ownerTargets.push(i);
    }
    linkTargets.owner = ownerTargets;
    linkTargets.topic = [];
    linkTargets.resonance = [];
    if (ownerTargets.length > 0) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.7;
      ctx.strokeStyle = hexA(p().accent, 0.85);
      ctx.beginPath();
      const from = sourceStop(center);
      for (const i of ownerTargets) edgePath(center, i, 0.16, from, ringStop(i, 0));
      ctx.stroke();
      ctx.restore();
    }

    // 主题共现：稀有主题共享，仍是数据里的存边
    let topicOn = false;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = hexA(EDGE_STYLES.topic?.color ?? "#e08a00", 0.55);
    ctx.beginPath();
    for (const l of links) {
      if (l.type !== "topic") continue;
      if (l.a !== center && l.b !== center) continue;
      const other = l.a === center ? l.b : l.a;
      if (other === center || !layout.nodes[other]) continue;
      edgePath(center, other, 0.22, sourceStop(center), ringStop(other, 1));
      linkTargets.topic.push(other);
      topicOn = true;
    }
    if (topicOn) ctx.stroke();
    ctx.restore();

    // 生态共鸣：人工策展的"基座 → 长在它上面的插件"（紫罗兰实线，与规则推导的两类区分）
    const reso = EDGE_STYLES.resonance ?? {};
    let resoOn = false;
    ctx.save();
    ctx.setLineDash(reso.dash ?? []);
    ctx.lineWidth = 1.9;
    ctx.strokeStyle = hexA(reso.color ?? "#a86bff", reso.alpha ?? 0.75);
    ctx.beginPath();
    for (const l of links) {
      if (l.type !== "resonance") continue;
      if (l.a !== center && l.b !== center) continue;
      const other = l.a === center ? l.b : l.a;
      if (other === center || !layout.nodes[other]) continue;
      edgePath(center, other, reso.curv ?? 0.2, sourceStop(center), ringStop(other, 2));
      linkTargets.resonance.push(other);
      resoOn = true;
    }
    if (resoOn) ctx.stroke();
    ctx.restore();
  }

  /**
   * 被指向的球套光圈（v0.4.3）：谁被连线指着，谁的球边缘就亮一圈【对应颜色】的光圈——
   * 同作者=主题主色、主题共现=琥珀、生态共鸣=紫罗兰，与线色一一对应。
   *
   * 同一个球可能同时被两类线指着，光圈按类型依次外扩（3px 一档），两种颜色都看得见。
   * 每一类成批描边（一次 path + 一次 stroke），几百个目标也只有 3 次 stroke。
   */
  function drawTargetRings() {
    if (!layout || selectedId == null) return;
    const rings = [
      { type: "owner", color: p().accent, alpha: 0.85, width: 1.6 },
      { type: "topic", color: EDGE_STYLES.topic?.color ?? "#e08a00", alpha: 0.7, width: 1.4 },
      { type: "resonance", color: EDGE_STYLES.resonance?.color ?? "#a86bff", alpha: 0.85, width: 1.8 },
    ];
    for (let slot = 0; slot < rings.length; slot++) {
      const ring = rings[slot];
      const targets = linkTargets[ring.type];
      if (!targets || targets.length === 0) continue;
      // 目标多的时候不画外发光：几百个 shadowBlur 会明显掉帧
      const glow = targets.length <= 80;
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = ring.width;
      ctx.strokeStyle = hexA(ring.color, ring.alpha);
      if (glow) {
        ctx.shadowColor = hexA(ring.color, 0.55);
        ctx.shadowBlur = 9;
      }
      ctx.beginPath();
      for (const i of targets) {
        const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
        if (sx < -30 || sy < -30 || sx > cssW + 30 || sy > cssH + 30) continue; // 屏外不画
        const r = Math.max(2, layout.radius[i] * view.k);
        const rr = r + 3 + slot * 2.4;
        // moveTo 先跳到圆的起点，避免和上一个圆之间连出一条直线
        ctx.moveTo(sx + rr, sy);
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 搜索指向（v0.4.2）：从圆心打出一道光，照向每一个命中的仓库球。
   * 与"点选后的关联连线"是两回事：这道光只说明「搜索命中了它」，不表示两者有关系。
   * 画在扇区光之上、节点之下，命中球本身由 highlight 负责压暗其余节点来凸显。
   *
   * 三道叠加（都成批描边，几千个命中也只有 3 次 stroke）：
   *   1. 外层光晕：粗、半透明、带 shadowBlur —— 低倍率下也能看见
   *   2. 内层光芯：细一些、更亮 —— 近看像一道光束
   *   3. 落点光斑：命中球上的一圈光，说明光"打"在了它身上
   * 光束用【一个以圆心为中心的径向渐变】着色：靠近圆心处淡、越接近目标越亮，
   * 一个渐变对象服务所有光束，不必逐个建渐变（那会拖垮帧率）。
   */
  function drawSearchRays() {
    if (!layout || !searchHits || searchHits.size === 0) return;
    // 命中太多就不画（v0.4.6）：上万条路径会让每帧的建路径+描边把主线程占满，
    // 用户看到的就是"搜索一卡一卡"。高亮照旧，状态栏会说明为什么没有放射线。
    if (searchHits.size > RAY_HIT_LIMIT) return;
    const hub = layout.center && layout.center.index >= 0 ? layout.center.index : -1;
    const [cx, cy] = hub >= 0 ? toScreen(layout.x[hub], layout.y[hub]) : toScreen(0, 0);

    const targets = [];
    let reach = 1;
    for (const id of searchHits) {
      const i = layout.index.get(id);
      if (i === undefined || i === hub) continue;
      const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
      // 屏外的命中不画：既看不见，也白白吃描边开销
      if (sx < -24 || sy < -24 || sx > cssW + 24 || sy > cssH + 24) continue;
      const len = Math.hypot(sx - cx, sy - cy);
      if (len < 6) continue;
      const r = Math.max(2, layout.radius[i] * view.k);
      reach = Math.max(reach, len);
      targets.push({ sx, sy, r, ux: (sx - cx) / len, uy: (sy - cy) / len, len });
    }
    if (targets.length === 0) return;

    const accent = p().accent;
    const many = targets.length > 220;
    const mid = targets.length > 60;
    // 光束宽度：按"屏幕上恒定偏粗"来定，低倍率（缩小看全景）时反而更宽，
    // 否则 1px 细线在 k≈0.3 的全景下等于看不见。
    const width = Math.min(14, Math.max(2.2, 3.4 / Math.max(view.k, 0.12)));

    // 一个径向渐变服务所有光束：圆心处淡、命中球方向亮
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, reach));
    grad.addColorStop(0, hexA(accent, many ? 0.25 : 0.4));
    grad.addColorStop(0.45, hexA(accent, many ? 0.5 : 0.8));
    grad.addColorStop(1, hexA(accent, 1));

    const beam = () => {
      ctx.beginPath();
      for (const t of targets) {
        const stop = Math.max(0, (t.len - Math.max(2, t.r + 2)) / t.len); // 停在球边上，不插进球里
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (t.sx - cx) * stop, cy + (t.sy - cy) * stop);
      }
    };

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    ctx.strokeStyle = grad;

    // 1) 外层光晕
    ctx.globalAlpha = many ? 0.22 : mid ? 0.34 : 0.5;
    ctx.lineWidth = width * (many ? 1.6 : 2.3);
    if (!many) {
      ctx.shadowColor = hexA(accent, 0.55);
      ctx.shadowBlur = 12 + width * 1.6;
    }
    beam();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 2) 内层光芯
    ctx.globalAlpha = many ? 0.5 : 0.8;
    ctx.lineWidth = Math.max(1.1, width * 0.55);
    beam();
    ctx.stroke();

    // 3) 落点光斑：光打在命中球上亮一圈（命中太多就省略，免得糊成一片）
    ctx.globalAlpha = many ? 0.3 : 0.55;
    ctx.fillStyle = hexA(accent, 0.5);
    ctx.beginPath();
    for (const t of targets) {
      ctx.moveTo(t.sx + t.r + width * 0.9, t.sy);
      ctx.arc(t.sx, t.sy, t.r + width * 0.9, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  /** 节点：柔和光点（填充核 + 淡外环）；悬停/选中用柔光而非硬框 */
  function drawNodes() {
    if (!layout) return;
    const p = P();
    const nodes = layout.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const active = isActive(node);
      const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
      if (sx < -40 || sy < -40 || sx > cssW + 40 || sy > cssH + 40) continue;
      const r = Math.max(2, layout.radius[i] * view.k);
      const color = groupColors.get(node.category) ?? colorOfTag(node.primaryTag);
      const isSel = node.id === selectedId;
      const isHov = node.id === hoverId;
      const glow = isSel || isHov;
      const inFocus = focusIds === null || focusIds.has(node.id);
      if (glow && active) {
        ctx.shadowBlur = isSel ? 16 : 10;
        ctx.shadowColor = hexA(color, 0.6);
      }
      // 底色：浅色主题白、深色主题黑（头像裁在球里，白/黑底最耐看）；
      // 分类色只体现在外环上。聚焦时非关联节点退到 22%。
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (active) ctx.fillStyle = hexA(P().ball, inFocus ? 0.98 : 0.24);
      else ctx.fillStyle = hexA(color, 0.14);
      ctx.fill();
      ctx.shadowBlur = 0;
      // 作者头像：球够大时才画，未加载/失败时保留上面的底色圆
      if (showAvatars && active && inFocus && r >= AVATAR_MIN_RADIUS && node.avatar) {
        // 优先级用屏幕半径：越大的球越先加载；加载器每帧结束会淘汰看不见的
        const img = avatars.want(node.avatar, r);
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(1, r - 0.5), 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
          ctx.restore();
        }
      }
      ctx.beginPath();
      ctx.arc(sx, sy, r + (glow ? 3.5 : 1), 0, Math.PI * 2);
      ctx.lineWidth = glow ? 1.6 : 1.1;
      ctx.strokeStyle = hexA(color, active ? (glow ? 0.95 : inFocus ? 0.62 : 0.16) : 0.1);
      ctx.stroke();
      if ((node.review || node.verdict === "noise") && active && r > 2.6) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4.5, 0, Math.PI * 2);
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = hexA(p.warn, 0.55);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 8, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = hexA(p.accent, 0.9);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }

  /** 圆心（全景=官方仓库；以某仓库为中心重建扇形图时=那个仓库）：柔和同心环 + 主色实心核 */
  function drawHub() {
    // 只看"有没有圆心"，不看"有没有扇区"：以孤点为中心时扇区为空，圆心照样要画出来
    if (!layout || !layout.center || !(layout.center.index >= 0)) return; // center 契约：必须带 index
    const p = P();
    const i = layout.center.index;
    const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
    const r = Math.max(5, layout.radius[i] * view.k);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 3.6, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(p.accent, 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, r * 2.1, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(p.accent, 0.35);
    ctx.stroke();
    // 圆心与项目球一致：白（浅色主题）／黑（深色主题）底 + 主色外环，作者头像裁在里面
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = hexA(p.ball, 0.98);
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = hexA(p.accent, 0.95);
    ctx.stroke();
    const hubNode = layout.nodes[i];
    if (showAvatars && hubNode.avatar) {
      const img = avatars.ready(hubNode.avatar);
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1, r - 1), 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
        ctx.restore();
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "600 13px " + FONT;
    ctx.fillStyle = hexA(p.text, 0.98);
    ctx.fillText(layout.nodes[i].id, sx, sy + r * 3.6 + 8);
    ctx.font = "11.5px " + FONT;
    ctx.fillStyle = hexA(p.text, 0.62);
    ctx.fillText(layout.center.label ?? "官方仓库", sx, sy + r * 3.6 + 25);
    ctx.textAlign = "left";
  }

  function drawLabels() {
    if (!layout || !showLabels || lowDetail) return; // 交互中不画标签，优先跟手
    const p = P();
    const nodes = layout.nodes;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "11px " + FONT;
    let drawn = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isActive(node)) continue;
      if (layout.center && node.id === layout.center.id) continue; // 圆心注记由 drawHub 负责，避免同一个 id 叠两遍
      if (focusIds !== null && !focusIds.has(node.id)) continue;
      const important =
        node.id === selectedId ||
        node.id === hoverId ||
        node.degree >= 9 ||
        node.stars >= 800 ||
        (view.k > (hasArms() ? 0.45 : 1.6) && node.stars >= 60);
      if (!important || drawn >= LABEL_MAX) continue;
      const [sx, sy] = toScreen(layout.x[i], layout.y[i]);
      if (sx < 0 || sy < 0 || sx > cssW || sy > cssH) continue;
      const ty = sy + Math.max(6, layout.radius[i] * view.k + 6);
      ctx.lineWidth = 3;
      ctx.strokeStyle = hexA(p.bg, 0.85);
      ctx.strokeText(node.id, sx, ty);
      ctx.fillStyle = hexA(p.text, 0.94);
      ctx.fillText(node.id, sx, ty);
      drawn++;
    }
    ctx.textAlign = "left";
  }

  /** 聚焦集合：当前悬停/选中的仓库 + 与它相连的仓库（只看已开启的连线类型） */
  function computeFocusIds() {
    const focus = hoverId ?? selectedId;
    if (!focus || !layout) return null;
    const set = new Set([focus]);
    for (const l of links) {
      if (!edgeTypes.has(l.type)) continue;
      const a = layout.nodes[l.a];
      const b = layout.nodes[l.b];
      // 连线与布局必须同源；万一对不上就跳过，别让 draw() 抛错——
      // frame() 没有 try/catch，一次异常会让 running 永远停在 true，画布从此不再重绘。
      if (!a || !b) continue;
      if (a.id === focus) set.add(b.id);
      else if (b.id === focus) set.add(a.id);
    }
    // 同作者同样以 owner 索引为准：存边对大作者只是星形拓扑，会漏掉大部分兄弟
    if (edgeTypes.has("owner")) for (const sibling of siblingsOf(focus)) set.add(sibling);
    // 该仓库在已开启的连线里没有任何关联时，不做全场压暗（否则会出现"只剩它一个亮"的突兀效果）
    return set.size > 1 ? set : null;
  }

  function draw() {
    // 头像加载器按"这一帧想要哪些"做优先级排序与淘汰（工作集上限 100）
    avatars.beginFrame();
    if (!prepared) return;
    focusIds = computeFocusIds();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop();
    drawSectors();
    drawSearchRays();
    drawEdges();
    drawNodes();
    drawTargetRings(); // 被指向的球套同色光圈（画在球之上，才像"框选"）
    drawHub();
    drawLabels();
    avatars.endFrame(); // 这一帧没要、且超出上限的头像在这里被淘汰
  }

  function frame() {
    if (!layout) {
      running = false;
      return;
    }
    const settling = layout.alpha > 0.004;
    if (settling) layout.tick();
    if (settling || dirty) draw();
    dirty = false;
    if (settling) {
      raf = requestAnimationFrame(frame);
    } else {
      running = false;
      if (hooks.onSettled) hooks.onSettled();
    }
  }

  function wake() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function invalidate() {
    dirty = true;
    wake();
  }
  function viewChanged() {
    if (hooks.onViewChange) hooks.onViewChange({ k: view.k, x: view.x, y: view.y });
  }

  const localPoint = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  };

  // 触屏支持：多指时进入双指缩放（单指仍是拖拽平移 + 点选）
  const activePointers = new Map();
  let pinch = null;

  function onPointerDown(ev) {
    const [mx, my] = localPoint(ev);
    canvas.setPointerCapture(ev.pointerId);
    activePointers.set(ev.pointerId, { x: mx, y: my });
    if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null; // 双指时不再平移
      canvas.classList.remove("dragging");
      return;
    }
    drag = { mx, my, moved: 0, vx: view.x, vy: view.y };
    canvas.classList.add("dragging");
  }

  function onPointerMove(ev) {
    const [mx, my] = localPoint(ev);
    pointer.x = mx;
    pointer.y = my;
    pointer.inside = true;
    if (activePointers.has(ev.pointerId)) activePointers.set(ev.pointerId, { x: mx, y: my });
    if (pinch && activePointers.size >= 2) {
      const [a, b] = [...activePointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.dist > 6 && dist > 6) zoomBy(dist / pinch.dist, [(a.x + b.x) / 2, (a.y + b.y) / 2]);
      pinch.dist = dist;
      return;
    }
    if (drag) {
      const dx = mx - drag.mx;
      const dy = my - drag.my;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      bumpInteraction();
      invalidate();
      return;
    }
    const id = pick(mx, my);
    if (id !== hoverId) {
      hoverId = id;
      canvas.classList.toggle("pointing", !!id);
      invalidate();
      if (hooks.onHover) hooks.onHover(id ? prepared.byId.get(id) : null, { x: mx, y: my });
    } else if (id && hooks.onHoverMove) {
      hooks.onHoverMove({ x: mx, y: my });
    }
  }

  function onPointerUp(ev) {
    const wasPinching = activePointers.size >= 2;
    activePointers.delete(ev.pointerId);
    if (activePointers.size < 2) pinch = null;
    if (wasPinching) return; // 双指结束时不要误判成点选
    if (!drag) return;
    const wasDrag = drag.moved > 4;
    drag = null;
    canvas.classList.remove("dragging");
    if (wasDrag) return;
    const [mx, my] = localPoint(ev);
    const id = pick(mx, my);
    selectedId = id;
    invalidate();
    if (hooks.onSelect) hooks.onSelect(id ? prepared.byId.get(id) : null);
  }

  function onWheel(ev) {
    ev.preventDefault();
    bumpInteraction();
    const [mx, my] = localPoint(ev);
    zoomBy(Math.exp(-ev.deltaY * 0.0016), [mx, my]);
  }

  function onDoubleClick(ev) {
    const [mx, my] = localPoint(ev);
    const id = pick(mx, my);
    if (id && hooks.onFocus) hooks.onFocus(id);
  }

  function onLeave() {
    pointer.inside = false;
    dirty = true;
    if (hoverId) {
      hoverId = null;
      if (hooks.onHover) hooks.onHover(null);
    }
    wake();
  }

  function onEnter() {
    pointer.inside = true;
  }

  function zoomBy(factor, anchor) {
    const [ax, ay] = anchor ?? [cssW / 2, cssH / 2];
    const next = Math.max(0.02, Math.min(6, view.k * factor));
    const scale = next / view.k;
    view.x = ax - (ax - view.x) * scale;
    view.y = ay - (ay - view.y) * scale;
    view.k = next;
    viewChanged();
    invalidate();
  }

  function fit(padding = 86) {
    if (!layout || !layout.size) return;
    const b = layout.getBounds(0);
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const k = Math.max(0.02, Math.min(2.4, Math.min((cssW - padding * 2) / w, (cssH - padding * 2) / h)));
    view.k = k;
    view.x = cssW / 2 - ((b.minX + b.maxX) / 2) * k;
    view.y = cssH / 2 - ((b.minY + b.maxY) / 2) * k;
    viewChanged();
    invalidate();
  }

  function focusNode(id) {
    if (!layout) return;
    const i = layout.index.get(id);
    if (i === undefined) return;
    const targetK = Math.max(view.k, 1.1);
    view.k = targetK;
    view.x = cssW / 2 - layout.x[i] * targetK;
    view.y = cssH / 2 - layout.y[i] * targetK;
    viewChanged();
    invalidate();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerenter", onEnter);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  return {
    get element() {
      return canvas;
    },
    get view() {
      return view;
    },
    setData(nextPrepared, nextLayout) {
      prepared = nextPrepared;
      layout = nextLayout;
      siblingCache = { id: null, ids: null }; // 数据换了，兄弟缓存必须作废
      linkTargets.owner = [];
      linkTargets.topic = [];
      linkTargets.resonance = [];
      resize();
      fit();
      wake();
    },
    setHighlight(set) {
      highlight = set;
      invalidate();
    },
    /** 搜索命中集合：非空时从圆心画放射线指向每一个命中的仓库球 */
    setSearchHits(set) {
      searchHits = set && set.size ? set : null;
      invalidate();
    },
    setGroupColors(map) {
      groupColors = map instanceof Map ? map : new Map();
      invalidate();
    },
    /** 连线由应用层构造好（含索引），渲染器只负责画 */
    setLinks(next) {
      links = Array.isArray(next) ? next : [];
      invalidate();
    },
    /** 聚焦某个功能扇区：其余扇区的光与标签减弱 */
    setSectorFocus(id) {
      sectorFocus = id ?? null;
      invalidate();
    },
    setTheme(next) {
      theme = next ?? themeOf();
      gridRGB = hexParts(theme.canvas.ink);
      invalidate();
    },
    setAvatars(on) {
      // 只控制画不画，保留已加载的缓存：来回切换才不会重新下载
      showAvatars = !!on;
      invalidate();
    },
    get avatars() {
      return showAvatars;
    },
    get avatarStats() {
      return avatars.stats;
    },
    setSelected(id) {
      selectedId = id;
      invalidate();
    },
    setLabels(on) {
      showLabels = !!on;
      invalidate();
    },
    get labels() {
      return showLabels;
    },
    setEdgeTypes(set) {
      edgeTypes = new Set(set);
      invalidate();
    },
    get edgeTypeSet() {
      return new Set(edgeTypes);
    },
    zoomBy,
    fit,
    focusNode,
    invalidate,
    wake,
    destroy() {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
    },
  };
}

/** #rrggbb + alpha -> rgba() */
export function hexA(hex, a) {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
