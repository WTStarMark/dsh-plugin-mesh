/**
 * 索引标签（市场里的「分类」胶囊）的唯一清单：生成器写 metadata.labels、后台「索引源 → 标签」页读它。
 *
 * 为什么要独立一份：后台要能列出"可隐藏的标签"，但被隐藏的标签不会出现在产物 metadata.labels 里，
 * 后台就无从知道它的中文名。把清单放这里，生成器与后台共用，不靠各自硬编码。
 *
 * 约定：id 只能是小写字母/数字/短横线；新增标签时同时改这里与生成器的打标逻辑。
 */
export const MARKET_LABELS = [
  { id: "dsh-bundle", en: "DSH bundle", zh: "DSH 组合包" },
  { id: "dsh-bundle-unconfirmed", en: "Likely bundle", zh: "疑似组合包" },
  { id: "has-client", en: "Has UI", zh: "带界面" },
  { id: "recent-release", en: "Updated this week", zh: "近 7 天有新版" },
  { id: "subdir-package", en: "Bundle in subdir", zh: "仓库内子包" },
  { id: "owner-unverified", en: "Owner unverified", zh: "作者待确认" },
  { id: "provenance-verified", en: "Publish provenance verified", zh: "发布溯源已核验" },
  { id: "star-cta", en: "Star it to cheer the author on", zh: "点个Star鼓励对应作者吧" },
];

export const MARKET_LABEL_IDS = MARKET_LABELS.map((item) => item.id);
const BY_ID = new Map(MARKET_LABELS.map((item) => [item.id, item]));

/** 标签 id -> 声明（后台列表用；未知 id 返回 null）。 */
export function marketLabel(id) {
  return BY_ID.get(String(id ?? "")) ?? null;
}
