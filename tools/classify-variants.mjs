/**
 * 分类评测用的可切换变体（只用于离线评测，不改变线上分类结果）。
 *
 * baseline：现有 classifyNode。
 * promotion：父级 0 分、但细枝命中足够强时，用细枝的父扇区兜底（已内置在 classifyNode，以下实现与生产逐条对齐）。
 * weakGate：仅由一个泛词（agent/tool/ui/style/api/file/chat/prompt/command/collection）在描述里命中时，不硬塞扇区。
 */

import {
  CATEGORY_RULES,
  SUBCATEGORY_RULES,
  MIN_SCORE,
  classifyNode,
  makeCounter,
  passesGate,
  isExcluded,
  scoreOf,
  strongHit,
  textSignals,
} from "./categories.mjs";

const LABEL = new Map(CATEGORY_RULES.map((r) => [r.id, r.label]));
export const WEAK_TERMS = new Set(["agent", "tool", "ui", "style", "api", "file", "chat", "prompt", "command", "collection"]);

function parentHits(rule, sig) {
  let score = 0;
  const hits = [];
  for (const [term, weight] of rule.terms) {
    const s = scoreOf(makeCounter(term), sig, weight);
    if (s > 0) {
      score += s;
      hits.push(term);
    }
  }
  return { score, hits };
}

/** 前 N 个候选扇区（考虑 gate/exclude/strong），供标注表和评测诊断用 */
export function candidateScores(node, limit = 3) {
  const sig = textSignals(node);
  const rows = [];
  for (const rule of CATEGORY_RULES) {
    const { score, hits } = parentHits(rule, sig);
    if (score <= 0) continue;
    if (!passesGate(rule, sig)) continue;
    if (isExcluded(rule, sig)) continue;
    rows.push({ id: rule.id, label: rule.label, score, hits, strong: strongHit(rule, sig) });
  }
  rows.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score);
  return rows.slice(0, limit);
}

/** 细枝提父级：只在父级完全没分时生效，避免改动已经分好的节点 */
export function classifyWithPromotion(node, { threshold = 3 } = {}) {
  const base = classifyNode(node);
  if (base.id !== "other") return base;
  const sig = textSignals(node);
  const subs = [];
  for (const [parent, rules] of Object.entries(SUBCATEGORY_RULES)) {
    const parentRule = CATEGORY_RULES.find((r) => r.id === parent);
    // 与生产一致：有 gate 的扇区不能靠细枝词提升；gate/exclude 不通过也不提升
    if (!parentRule || parentRule.gate) continue;
    if (!passesGate(parentRule, sig) || isExcluded(parentRule, sig)) continue;
    for (const rule of rules) {
      let score = 0;
      let nameScore = 0;
      const hits = [];
      for (const [term, weight] of rule.terms) {
        const counter = makeCounter(term);
        const s = scoreOf(counter, sig, weight);
        if (s > 0) {
          score += s;
          hits.push(term);
          nameScore += counter(sig.name) + counter(sig.last);
        }
      }
      if (score > 0) subs.push({ parent, parentLabel: LABEL.get(parent) ?? parent, sub: rule, score, nameScore, hits });
    }
  }
  subs.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore);
  const best = subs[0];
  if (!best || best.score < threshold || best.nameScore <= 0) return base;
  const second = subs[1];
  if (second && second.score === best.score) return base; // 两个细枝同分，不硬猜
  return {
    id: best.parent,
    label: best.parentLabel,
    score: best.score,
    hits: best.hits.slice(0, 4),
    sub: { id: best.sub.id, label: best.sub.label, score: best.score, nameScore: best.nameScore, hits: best.hits.slice(0, 3) },
    promoted: true,
  };
}

/** 弱词门禁：score<=1 且命中词全是泛词且没出现在名字里 → other */
export function classifyWithWeakGate(node) {
  const base = classifyNode(node);
  if (base.id === "other") return base;
  const hits = base.hits ?? [];
  if (base.score > 1 || !hits.length) return base;
  if (!hits.every((h) => WEAK_TERMS.has(String(h)))) return base;
  const sig = textSignals(node);
  const nameHit = hits.some((term) => makeCounter(term)(sig.name) + makeCounter(term)(sig.last) > 0);
  if (nameHit) return base;
  return { id: "other", label: "其他", score: 0, hits: [], sub: null, blocked: { id: base.id, label: base.label, reason: "弱词单独命中，置信不足" } };
}

export function classifyVariant(node, { promotion = false, weakGate = false, threshold = 3 } = {}) {
  let result = classifyNode(node);
  if (promotion && result.id === "other") result = classifyWithPromotion(node, { threshold });
  if (weakGate && result.id !== "other") result = classifyWithWeakGate(node);
  return result;
}
