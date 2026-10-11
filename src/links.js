/**
 * 连线构造：owner 同作者、topic 稀有主题共现两类边。
 * 不画「同扇区近邻」——位置相近不等于功能相关，噪声大于信息；超级枢纽主题也排除，否则会变毛线球。
 * 边不常驻显示，只在点选某个仓库时画出它自己的连线；渲染成远离圆心的弧线，避免在中心糊成一团。
 */

import { EDGE_TYPE_BY_CODE } from "./mesh-data.js";

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
