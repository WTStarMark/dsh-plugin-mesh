/**
 * 连线构造：把"关系"变成既有意义又好看的一组边。
 *
 * 关联性来自三类边：
 *   neighbor  同扇区近邻 —— 位置相近 ⇒ 功能相近，短、局部、不跨境
 *   owner     同作者     —— 同一个作者/组织的多个仓库，天然可信
 *   topic     主题共现   —— 稀有主题共享（超级枢纽标签已排除，否则会变毛线球）
 *
 * 观赏性的关键在渲染层：所有连线画成**向远离圆心方向鼓起的弧线**，
 * 交叉时绕开圆心，不会在中心糊成一团（见 src/graph.js 的 drawEdges）。
 */

/**
 * 同扇区近邻连线：每个节点取本扇区内最近的若干候选，全局按距离升序贪心接受，
 * 并且**限制每个节点的度数**——否则一个枢纽节点会被上百个邻居同时选中，
 * 扇区里就出现一张"蜘蛛网"（实测未限流时最大度数 131）。
 */
export function buildNeighborLinks(layout, options = {}) {
  const percentile = options.percentile ?? 0.85;
  const degreeCap = options.degreeCap ?? 2;
  const candidatesPerNode = options.candidatesPerNode ?? 4;
  const arms = layout?.arms ?? [];
  if (!layout) return [];
  // 必须用目标位置：入场动画没跑完时 x/y 还全叠在圆心，会算出满屏零距离
  const px = (i) => (layout.tx ? layout.tx[i] : layout.x[i]);
  const py = (i) => (layout.ty ? layout.ty[i] : layout.y[i]);
  const dist = (i, j) => Math.hypot(px(i) - px(j), py(i) - py(j));

  const candidates = [];
  for (const arm of arms) {
    const members = arm.members ?? [];
    if (members.length < 2) continue;
    for (const m of members) {
      const near = members
        .filter((o) => o.index !== m.index)
        .map((o) => ({ index: o.index, d: dist(m.index, o.index) }))
        .sort((p, q) => p.d - q.d)
        .slice(0, candidatesPerNode);
      for (const n of near) {
        candidates.push({ a: Math.min(m.index, n.index), b: Math.max(m.index, n.index), d: n.d });
      }
    }
  }
  const unique = new Map();
  for (const c of candidates) {
    const key = c.a + "-" + c.b;
    const prev = unique.get(key);
    if (!prev || c.d < prev.d) unique.set(key, c);
  }
  const sorted = [...unique.values()].sort((p, q) => p.d - q.d);
  if (sorted.length === 0) return [];
  const cutoff = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))].d;
  const degree = new Map();
  const picked = [];
  for (const c of sorted) {
    if (c.d > cutoff) break; // 已按距离升序，后面只会更长
    if ((degree.get(c.a) ?? 0) >= degreeCap || (degree.get(c.b) ?? 0) >= degreeCap) continue;
    degree.set(c.a, (degree.get(c.a) ?? 0) + 1);
    degree.set(c.b, (degree.get(c.b) ?? 0) + 1);
    picked.push({ a: c.a, b: c.b, type: "neighbor", weight: 1 });
  }
  return picked;
}

/** 汇总所有可绘制的边（索引已解析为布局下标） */
export function buildLinks(prepared, layout, options = {}) {
  const index = layout?.index;
  if (!index) return [];
  const out = [];
  for (const e of prepared.edges ?? []) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ a, b, type: e.type, weight: e.weight || 1 });
  }
  out.push(...buildNeighborLinks(layout, options));
  return out;
}

export function countByType(links, type) {
  let n = 0;
  for (const l of links) if (l.type === type) n += 1;
  return n;
}
