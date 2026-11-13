/**
 * 相关性判定（纯规则，零 AI）—— 把「疑似噪声」拆成三档结论：
 *   related 名字/描述/主题里有 DSH 专有线索 → 直接算相关；noise 与 DSH 无关/空壳/堆标签 → 不进生态图；
 *   manual 线索不足 → 才是真正需要人工看的那批（旧版只有一个阈值，一次把上千个仓库丢进「待复核」）。
 * 输出与 backend/dsh_mesh/build.py 的 analyze_relevance 逐条一致（两份实现互为镜像）；
 * 改动请同时改两边。
 */

import { loadAdminConfig, matchRepo, whitelistAliasesOf, whitelistTagsOf } from "./admin-config.mjs";

/** 捕获标签白名单：与 tools/categories.mjs、backend/dsh_mesh/config.py 同源（data/admin/config.json） */
export const WHITELIST = whitelistTagsOf(loadAdminConfig());
/** 白名单别名组（issue#5 第3条）：匹配时展开成规范标签，抓取时完全不用它 */
export const WHITELIST_ALIASES = whitelistAliasesOf(loadAdminConfig());

/**
 * 这个仓库到底挂了哪些白名单标签 —— 别名也算它的规范标签。
 * 别名组是"人显式登记的精确标签"，所以这里仍然是精确比对，不做子串/正则匹配。
 */
export function matchedTagsOf(repo) {
  if (Array.isArray(repo && repo.matchedTags)) return repo.matchedTags;
  return matchRepo(repo, WHITELIST, WHITELIST_ALIASES).canonical;
}

/** DSH 专有线索：dsh 词元 / DeepSeek Harness / Cordis */
const DSH_NAME = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]|deepseek[\s-]?harness|cordis/i;
const DSH_DESC = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]|deepseek[\s-]?harness|cordis/i;
/** 主题里只有这两个（加 cordis-plugin）是 DSH 专有的；单说 deepseek 只表示模型/公司 */
const SPEC_TOPICS = new Set(["deepseek-harness", "cordis", "cordis-plugin"]);
/** 插件/技能形态的线索：正文里有这些词，说明它至少是"生态里的一件东西" */
const PLUGIN_SHAPED = /plugin|插件|skill|技能|mcp|扩展|extension|皮肤|主题|面板|侧边栏|工作台/i;
/** 其他插件生态的标签：同时铺好几个生态的标签，基本是蹭标签 */
const OTHER_ECOSYSTEM_TAGS = new Set([
  "claude-code-plugin", "claude-plugin", "codex-plugin", "cursor-plugin",
  "gemini-cli-extension", "openai-plugin", "vscode-extension", "jetbrains-plugin",
]);

/** 朴素相关度启发式（0~8），沿用旧公式：名字 ×3 / 描述 ×2 / 专有主题 ×1 / 标签数 ×1 / cordis ×1 */
export function relevanceScore(repo) {
  let s = 0;
  if (/(^|[^a-z])dsh([^a-z]|$)|dsh-|dsh_/i.test(repo.name ?? "")) s += 3;
  if (/dsh|deepseek[- ]?harness|cordis/i.test(repo.description ?? "")) s += 2;
  const topics = repo.topics ?? [];
  if (topics.includes("deepseek-harness")) s += 1;
  if (matchedTagsOf(repo).length >= 2) s += 1;
  if (/cordis/i.test(repo.description ?? "") || topics.includes("cordis")) s += 1;
  return s;
}

/** 三档结论。返回 { relevance, review, verdict, reason }（review=true 即仍需人工） */
export function analyzeRelevance(repo) {
  const name = String(repo.name ?? "");
  const desc = String(repo.description ?? "").trim();
  const topics = (repo.topics ?? []).map((t) => String(t).toLowerCase());
  const tags = repo.matchedTags ?? [];
  const relevance = relevanceScore(repo);

  if (DSH_NAME.test(name) || DSH_DESC.test(desc) || topics.some((t) => SPEC_TOPICS.has(t))) {
    return { relevance, review: false, verdict: "related", reason: "名字/描述/主题里有 DSH 专有线索" };
  }
  // ---- 证据层（离线扫描传入的 README/manifest 证据；冻结参照物没有这些字段，规则原样）----
  // 证据强于启发式：根清单校验通过 / README 明确提 DSH 的仓库，就不再落到「堆标签」「只挂宽泛标签」判噪声。
  if (repo.manifestOk) {
    return { relevance, review: false, verdict: "related", reason: "清单扫描确认是 dsh 插件（repo-manifests 校验通过）" };
  }
  if (repo.npmOk) {
    return { relevance, review: false, verdict: "related", reason: "npm 包声明 dsh.client 且入口真实存在（market 证据）" };
  }
  if (repo.readmeHit === true) {
    return { relevance, review: false, verdict: "related", reason: "README 正文明确 DSH 生态线索（README 证据）" };
  }
  // README 文证「只讲别家生态」（与 build.py _OTHER_HOST_RE 同一正则，改一边要改两边）。
  const OTHER_HOST = /\bclaude[- ]?(?:code|skills?)?\b|\bcodex\b|\bcursor\b|\bgemini[- ]cli\b|\bsmithery\b|\bmcpb\b|\bopenskills\b|\bvscode[- ]extensions?\b/i;
  const digestOther = String(repo.readmeDigest || "");
  if (digestOther && !DSH_NAME.test(digestOther) && OTHER_HOST.test(digestOther)) {
    return { relevance, review: false, verdict: "noise", reason: "README 只讲其他插件平台（claude-code / codex 等），无任何 DSH 线索（README 证据）" };
  }
  const loose = PLUGIN_SHAPED.test(name + " " + desc);
  const otherEco = topics.filter((t) => OTHER_ECOSYSTEM_TAGS.has(t)).length;
  if (otherEco >= 2) {
    return { relevance, review: false, verdict: "noise", reason: "同时铺了 " + otherEco + " 个其他插件生态的标签" };
  }
  if (tags.length >= 3 && !loose) {
    return { relevance, review: false, verdict: "noise", reason: "挂了 " + tags.length + " 个 DSH 标签，正文却没有插件线索" };
  }
  if (desc.length < 10 && (repo.stars ?? 0) === 0 && !loose) {
    return { relevance, review: false, verdict: "noise", reason: "空壳仓库：没有描述、0 星" };
  }
  if (tags.length === 1 && !loose) {
    return { relevance, review: false, verdict: "noise", reason: "只挂 1 个最宽泛的 dsh 标签，正文与 DSH 无关" };
  }
  // README 实证「正文没提 DSH」且不以插件形态出现：定性噪声（像不透插件本体，仍留人工）。
  if (repo.readmeHit === false && !loose) {
    return { relevance, review: false, verdict: "noise", reason: "README 正文没有任何 DSH 线索，也不像插件（README 证据）" };
  }
  return {
    relevance,
    review: true,
    verdict: "manual",
    reason: loose ? "正文像插件，但没提 DSH，需要人工确认" : "线索不足，需要人工确认",
  };
}
