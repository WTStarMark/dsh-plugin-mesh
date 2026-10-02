/**
 * Canvas 渲染器 + 交互（对齐 DSH 视觉）。
 *
 * 主题由 src/palettes.js 注入（清爽 / 粉黛 × 浅色 / 深色），结构令牌沿用 DSH；
 * 球体在足够大时显示作者头像（并发受限、按 URL 去重、失败不重试）。
 * 画法刻意保持克制：细线、低对比、柔和光点与柔和扇区光。
 */
import { colorOfTag, groupColor, EDGE_STYLES } from "./mesh-data.js";
import { themeOf } from "./palettes.js";
import { createAvatarStore } from "./avatars.js";

const LABEL_MAX = 90;
const RING_STEPS = [200, 500, 1000, 2000, 4000, 8000];
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
  let selectedId = null;
  let hoverId = null;
  let showLabels = true;
  let edgeTypes = new Set(["topic", "owner"]);
  let groupColors = new Map();
  let links = [];
  let sectorFocus = null;
  let focusIds = null;
  let theme = themeOf();
  let gridRGB = hexParts(theme.canvas.ink);
  let showAvatars = true;
  const avatars = createAvatarStore({
    concurrency: 6,
    onLoad: () => {
      dirty = true;
      wake();
    },
  });
  let running = false;
  let dirty = true;
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

  /** 底图：极淡的距离环（表示离官方仓库多远），其余留白 */
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

  /** 一条边：向"远离圆心"的方向鼓起的二次曲线，避免所有线穿过中心 */
  function edgePath(l, curv) {
    const [x1, y1] = toScreen(layout.x[l.a], layout.y[l.a]);
    const [x2, y2] = toScreen(layout.x[l.b], layout.y[l.b]);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [ox, oy] = toScreen(0, 0);
    let nx = mx - ox;
    let ny = my - oy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const bulge = curv * len;
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx + nx * bulge, my + ny * bulge, x2, y2);
  }

  function edgeColor(l, style) {
    if (style.color) return style.color;
    const node = layout.nodes[l.a];
    return groupColors.get(node.category) ?? colorOfTag(node.primaryTag);
  }

  function drawEdges() {
    if (!layout || links.length === 0) return;
    const focus = hoverId ?? selectedId;
    // 选中的仓库：无论「同作者」开关开没开，都把它自己的同作者连线画出来
    const selectedIndex = selectedId != null ? layout.index.get(selectedId) : undefined;
    const visible = [];
    for (const l of links) {
      const pinned = selectedIndex !== undefined && l.type === "owner" && (l.a === selectedIndex || l.b === selectedIndex);
      if (!pinned && !edgeTypes.has(l.type)) continue;
      const a = layout.nodes[l.a];
      const b = layout.nodes[l.b];
      // 选中的仓库：同作者连线连开关和淡化过滤都豁免（兄弟仓库往往不匹配当前筛选词）
      if (!pinned && (!isActive(a) || !isActive(b))) continue;
      visible.push(l);
    }
    if (visible.length === 0) return;
    // 第一遍：背景连线（有焦点时进一步压暗，保留上下文但不抢戏）
    const dim = focus ? 0.18 : 1;
    const byType = new Map();
    for (const l of visible) {
      const touches = focus && (layout.nodes[l.a].id === focus || layout.nodes[l.b].id === focus);
      if (touches) continue;
      if (!byType.has(l.type)) byType.set(l.type, []);
      byType.get(l.type).push(l);
    }
    for (const [type, list] of byType) {
      const style = EDGE_STYLES[type] ?? { alpha: 0.2, curv: 0.14, dash: [] };
      ctx.save();
      ctx.setLineDash(style.dash ?? []);
      ctx.lineWidth = 1;
      for (const l of list) {
        ctx.beginPath();
        ctx.strokeStyle = hexA(edgeColor(l, style), style.alpha * dim);
        edgePath(l, style.curv ?? 0.14);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 第二遍：焦点节点的连线，用主色提亮画在最上层
    if (focus) {
      ctx.save();
      ctx.lineWidth = 1.6;
      for (const l of visible) {
        if (layout.nodes[l.a].id !== focus && layout.nodes[l.b].id !== focus) continue;
        const style = EDGE_STYLES[l.type] ?? {};
        ctx.beginPath();
        ctx.strokeStyle = hexA(p().accent, 0.55);
        edgePath(l, style.curv ?? 0.14);
        ctx.stroke();
      }
      ctx.restore();
    }
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
        const img = avatars.ready(node.avatar);
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
      if (node.review && active && r > 2.6) {
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

  /** 圆心：官方仓库（柔和同心环 + 主色实心核） */
  function drawHub() {
    if (!hasArms() || layout.center.index < 0) return;
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
    ctx.fillText("官方仓库", sx, sy + r * 3.6 + 25);
    ctx.textAlign = "left";
  }

  function drawLabels() {
    if (!layout || !showLabels) return;
    const p = P();
    const nodes = layout.nodes;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "11px " + FONT;
    let drawn = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isActive(node)) continue;
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
      if (a.id === focus) set.add(b.id);
      else if (b.id === focus) set.add(a.id);
    }
    // 该仓库在已开启的连线里没有任何关联时，不做全场压暗（否则会出现"只剩它一个亮"的突兀效果）
    return set.size > 1 ? set : null;
  }

  function draw() {
    if (!prepared) return;
    focusIds = computeFocusIds();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop();
    drawSectors();
    drawEdges();
    drawNodes();
    drawHub();
    drawLabels();
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
      resize();
      fit();
      wake();
    },
    setHighlight(set) {
      highlight = set;
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
