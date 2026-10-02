/**
 * 连线构造：把"关系"变成既有意义又好看的一组边。
 *
 * 关联性来自两类边（v0.4.1 起去掉「同扇区近邻」：位置相近并不等于功能相关，噪声大于信息）：
 *   owner     同作者     —— 同一个作者/组织的多个仓库，天然可信
 *   topic     主题共现   —— 稀有主题共享（超级枢纽标签已排除，否则会变毛线球）
 *
 * 这两类边都不再常驻显示：只有点选某个仓库时，才画出它自己的连线（两种颜色区分）。
 *
 * 观赏性的关键在渲染层：所有连线画成**向远离圆心方向鼓起的弧线**，
 * 交叉时绕开圆心，不会在中心糊成一团（见 src/graph.js 的 drawEdges）。
 */

import { EDGE_TYPE_BY_CODE } from "./mesh-data.js";

/** 汇总所有可绘制的边（索引已解析为布局下标） */
export function buildLinks(prepared, layout, options = {}) {
  const index = layout?.index;
  if (!index) return [];
  const nodes = prepared.nodes ?? [];
  const out = [];
  for (const e of prepared.edges ?? []) {
    let source;
    let target;
    let type;
    if (Array.isArray(e)) {
      // 预计算契约：edges 是 [全局索引, 全局索引, 类型码]
      const na = nodes[e[0]];
      const nb = nodes[e[1]];
      if (!na || !nb) continue;
      source = na.id;
      target = nb.id;
      type = EDGE_TYPE_BY_CODE[e[2]] ?? "topic";
    } else {
      source = e.source;
      target = e.target;
      type = e.type;
    }
    const a = index.get(source);
    const b = index.get(target);
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ a, b, type, weight: 1 });
  }
  return out;
}

export function countByType(links, type) {
  let n = 0;
  for (const l of links) if (l.type === type) n += 1;
  return n;
}
