/**
 * 扇区散布布局（唯一布局）
 *
 * 规则：
 *   1. 官方仓库固定在圆心；
 *   2. 每个功能分类占一个扇区，等角分布（N 个扇区 => 360/N 度）；
 *   3. 扇区内**离散随机散布**：随机角度 + 随机半径抖动，再松弛去重叠，
 *      不是同心环、不是等角排列、更不是一条线；
 *   4. 星标越多整体越靠近圆心（统计趋势，不做刚性排序 —— 刚性排序就是"僵硬"的来源）。
 *
 * 位置只由"星标 + 种子"决定，因此可复现、可 diff。
 */
import { mulberry32, hashSeed } from "./rng.js";

const START_ANGLE = -Math.PI / 2;

export function createSectorLayout(options = {}) {
  const nodes = options.nodes ?? [];
  const centerId = options.centerId ?? null;
  const groupOf = options.groupOf ?? ((n) => n.category || "other");
  const labelOf = options.labelOf ?? ((n, key) => n.categoryLabel || key);
  const seedInput = options.seed ?? 1;
  const gap = options.gap ?? 7;
  const minRadius = options.minRadius ?? 96;
  const sectorFill = options.sectorFill ?? 0.92;
  const scatter = options.scatter ?? 0.26; // 半径抖动幅度：越大越散
  const softIterations = options.softIterations ?? 110;
  const hardIterations = options.hardIterations ?? 160;
  const packing = options.packing ?? 1.2; // 随机散布装不满理想面积，留 20% 余量

  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const radius = new Float64Array(n);
  const targetR = new Float64Array(n);
  const sectorOf = new Int32Array(n).fill(-1);

  let maxStars = 1;
  for (const node of nodes) maxStars = Math.max(maxStars, node.stars || 0);
  const maxLog = Math.log10(maxStars + 1);
  for (let i = 0; i < n; i++) radius[i] = 4.5 + 17 * (Math.log10((nodes[i].stars || 0) + 1) / maxLog);
  let maxNodeRadius = 1;
  for (let i = 0; i < n; i++) maxNodeRadius = Math.max(maxNodeRadius, radius[i]);

  const centerIndex = centerId !== null && index.has(centerId) ? index.get(centerId) : -1;

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    if (i === centerIndex) continue;
    const key = groupOf(nodes[i]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const specs = [...groups.entries()]
    .map(([id, members]) => ({ id, label: labelOf(nodes[members[0]], id), members, bounds: null }))
    .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));

  const sectorCount = specs.length;
  const angleStep = sectorCount > 0 ? (Math.PI * 2) / sectorCount : 0;
  const sectorWidth = angleStep * sectorFill;

  let currentSeed = typeof seedInput === "number" ? seedInput >>> 0 : hashSeed(String(seedInput));
  let progress = 0;
  const arms = [];

  const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

  function separate(strength) {
    const cell = Math.max(28, maxNodeRadius * 2 + gap);
    const grid = new Map();
    const key = (gx, gy) => gx * 100003 + gy;
    for (let i = 0; i < n; i++) {
      if (i === centerIndex) continue;
      const k = key(Math.floor(tx[i] / cell), Math.floor(ty[i] / cell));
      let bucket = grid.get(k);
      if (!bucket) {
        bucket = [];
        grid.set(k, bucket);
      }
      bucket.push(i);
    }
    let worst = 0;
    for (let i = 0; i < n; i++) {
      if (i === centerIndex) continue;
      const gx = Math.floor(tx[i] / cell);
      const gy = Math.floor(ty[i] / cell);
      for (let ax = gx - 1; ax <= gx + 1; ax++) {
        for (let ay = gy - 1; ay <= gy + 1; ay++) {
          const bucket = grid.get(key(ax, ay));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            let dx = tx[j] - tx[i];
            let dy = ty[j] - ty[i];
            let d = Math.sqrt(dx * dx + dy * dy);
            const need = radius[i] + radius[j] + gap;
            if (d >= need) continue;
            if (d < 1e-6) {
              dx = Math.cos(i * 12.9898) * 0.05;
              dy = Math.sin(i * 78.233) * 0.05;
              d = 0.05;
            }
            const push = ((need - d) / d) * 0.5 * strength;
            tx[i] -= dx * push;
            ty[i] -= dy * push;
            tx[j] += dx * push;
            ty[j] += dy * push;
            worst = Math.max(worst, need - d);
          }
        }
      }
    }
    return worst;
  }

  function constrain(spring) {
    for (let i = 0; i < n; i++) {
      if (i === centerIndex) continue;
      const si = sectorOf[i];
      if (si < 0) continue;
      const b = specs[si].bounds;
      let r = Math.hypot(tx[i], ty[i]);
      let a = Math.atan2(ty[i], tx[i]);
      const lim = sectorWidth / 2 - Math.min(0.05, sectorWidth * 0.05);
      const rel = wrap(a - b.axis);
      if (rel < -lim) a = b.axis - lim;
      else if (rel > lim) a = b.axis + lim;
      r = Math.max(b.rMin, Math.min(b.rMax * 1.12, r));
      if (spring > 0) r += (targetR[i] - r) * spring;
      r = Math.max(b.rMin, Math.min(b.rMax * 1.16, r));
      tx[i] = Math.cos(a) * r;
      ty[i] = Math.sin(a) * r;
    }
  }

  function build() {
    const rnd = mulberry32(currentSeed);
    arms.length = 0;
    if (centerIndex >= 0) {
      tx[centerIndex] = 0;
      ty[centerIndex] = 0;
    }
    specs.forEach((spec, si) => {
      const axis = START_ANGLE + si * angleStep;
      const half = sectorWidth / 2;
      let need = 0;
      for (const i of spec.members) need += (radius[i] * 2 + gap) ** 2;
      const rMax = Math.max(minRadius * 1.5, Math.sqrt(minRadius * minRadius + (2 * need * packing) / Math.max(0.05, sectorWidth)));
      spec.bounds = { axis, start: axis - half, end: axis + half, rMin: minRadius, rMax };
      for (const i of spec.members) {
        const t = Math.log10((nodes[i].stars || 0) + 1) / maxLog;
        targetR[i] = spec.bounds.rMin + (spec.bounds.rMax - spec.bounds.rMin) * (1 - t);
        sectorOf[i] = si;
        // 离散随机：半径抖动 + 扇区内随机角度
        const wobble = 1 + (rnd() * 2 - 1) * scatter;
        const r = Math.max(spec.bounds.rMin, Math.min(spec.bounds.rMax * 1.05, targetR[i] * wobble));
        const a = spec.bounds.start + rnd() * sectorWidth;
        tx[i] = Math.cos(a) * r;
        ty[i] = Math.sin(a) * r;
      }
    });

    for (let it = 0; it < softIterations; it++) {
      separate(0.62);
      constrain(0.02);
    }
    for (let it = 0; it < hardIterations; it++) {
      const worst = separate(1);
      constrain(0);
      if (worst < 0.05) break;
    }

    specs.forEach((spec, si) => {
      const b = spec.bounds;
      const members = spec.members
        .map((i) => ({ id: nodes[i].id, index: i, r: Math.hypot(tx[i], ty[i]), angle: Math.atan2(ty[i], tx[i]), stars: nodes[i].stars || 0 }))
        .sort((p, q) => p.r - q.r);
      let endRadius = b.rMin;
      for (const m of members) endRadius = Math.max(endRadius, m.r + radius[m.index]);
      endRadius += 26;
      arms.push({
        id: spec.id,
        label: spec.label,
        index: si,
        angle: b.axis,
        startAngle: b.start,
        endAngle: b.end,
        width: sectorWidth,
        count: members.length,
        rings: 0,
        rMin: b.rMin,
        rMax: b.rMax,
        endRadius,
        endX: Math.cos(b.axis) * endRadius,
        endY: Math.sin(b.axis) * endRadius,
        topId: members.length ? members[0].id : null,
        topStars: members.length ? members[0].stars : 0,
        members,
      });
    });
  }
  build();

  const ease = (t) => 1 - Math.pow(1 - t, 3);

  function tick() {
    if (progress >= 1) return 0;
    progress = Math.min(1, progress + 0.03);
    const e = ease(progress);
    for (let i = 0; i < n; i++) {
      xs[i] = tx[i] * e;
      ys[i] = ty[i] * e;
    }
    return 1 - progress;
  }

  const reheat = () => {
    progress = 0;
    xs.fill(0);
    ys.fill(0);
  };

  function getBounds(padding = 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, tx[i] - radius[i] - padding);
      minY = Math.min(minY, ty[i] - radius[i] - padding);
      maxX = Math.max(maxX, tx[i] + radius[i] + padding);
      maxY = Math.max(maxY, ty[i] + radius[i] + padding);
    }
    if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    return { minX, minY, maxX, maxY };
  }

  return {
    kind: "sector",
    nodes,
    size: n,
    index,
    radius,
    links: [],
    clusterIds: specs.map((s) => s.id),
    angleStep,
    sectorWidth,
    startAngle: START_ANGLE,
    center: { id: centerId, index: centerIndex },
    get arms() {
      return arms;
    },
    get alpha() {
      return 1 - progress;
    },
    get progress() {
      return progress;
    },
    get x() {
      return xs;
    },
    get y() {
      return ys;
    },
    /** 目标位置：入场动画未跑完时，x/y 还叠在圆心，算连线必须用这一组 */
    get tx() {
      return tx;
    },
    get ty() {
      return ty;
    },
    get seed() {
      return currentSeed;
    },
    tick,
    run(ticks) {
      for (let i = 0; i < ticks; i++) {
        if (progress >= 1) break;
        tick();
      }
      return 1 - progress;
    },
    reheat,
    reseed(next) {
      currentSeed = typeof next === "number" ? next >>> 0 : hashSeed(String(next));
      build();
      reheat();
      return currentSeed;
    },
    getBounds,
  };
}
