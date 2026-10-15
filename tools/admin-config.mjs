/**
 * 管理后台的共享配置与数据文件（Node 侧）—— 与 Python 侧的 backend/dsh_mesh/admin_config.py 对齐。
 * 单独一层的原因：① 白名单标签原来硬编码在 4 个文件里，后台一改就前后端分叉，现在统一成 data/admin/config.json
 * 一份数据，两边都读它；② 后台要写名单和开关，必须【原子写 + 留备份】，否则采集器可能读到半截 JSON；
 * ③ 后台路径与口令放 .env（0600、不入库），启动时读，绝不打印明文。
 * 铁律：读取时文件缺失/损坏/类型不对一律回退默认值，绝不抛异常 —— 服务与采集都不能因为一份配置文件坏掉而挂。
 */

import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync as readSyncCompat, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_BASES, CONTEXT_IDS, CONTEXT_RULES, DEFAULT_CONTEXT, builtinBase } from "./ecosystem-bases.mjs";

export const CONTEXTS = CONTEXT_IDS.map((id) => ({ id, label: CONTEXT_RULES[id].label, desc: CONTEXT_RULES[id].desc }));

/** 锚定条件里的字符串数组：去空、去重、限长、限量。非法条目直接丢，整表不合法由调用方判断。 */
export function cleanList(value, maxItems = 50, maxLen = 80) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || text.length > maxLen) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = join(ROOT, "data");
// ADMIN_DIR / BLACKLIST_FILE 支持环境变量覆盖：测试用临时目录，绝不碰真实数据
export const ADMIN_DIR = process.env.ADMIN_DIR ? resolve(process.env.ADMIN_DIR) : join(DATA_DIR, "admin");
// 累积索引所在目录：与 Python 侧 config.py 的 CACHE_DIR 同一处，只读用途（影响预估）
export const CACHE_DIR = process.env.CACHE_DIR ? resolve(process.env.CACHE_DIR) : join(DATA_DIR, "cache");
export const CONFIG_FILE = join(ADMIN_DIR, "config.json");
export const JOB_FILE = join(ADMIN_DIR, "job.json");
export const AUDIT_FILE = join(ADMIN_DIR, "audit.log");
export const LOG_DIR = join(ADMIN_DIR, "logs");
export const BLACKLIST_FILE = process.env.BLACKLIST_FILE ? resolve(process.env.BLACKLIST_FILE) : join(DATA_DIR, "noise-blacklist.json");
export const ECOSYSTEM_FILE = join(ROOT, "tools", "ecosystem.json");
export const ENV_FILE = join(ROOT, ".env");

/** 默认捕获标签：必须与 backend/dsh_mesh/config.py 的 WHITELIST_TAGS 完全一致 */
export const DEFAULT_WHITELIST_TAGS = ["dsh-plugin-desktop", "dsh-desktop", "dsh-plugin-market", "dsh-plugins", "dsh-plugin", "dsh"];

/** 后台路径：32 位随机字母/数字；允许 8~64 位是为了让人能手工改成别的长度 */
export const ADMIN_PATH_RE = /^[A-Za-z0-9]{8,64}$/;

// 与 backend/dsh_mesh/snapshot.py:write_blacklist 的 note 必须一字不差（两边各写一份，靠测试盯住）
const BLACKLIST_NOTE = "噪声黑名单：自动判据是同作者收录超过阈值个仓库、且每个仓库星标都低于阈值；也可以在后台手工加。删除条目即可解除拉黑。";
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

/** 只回相对仓库根的路径：后台页面上不暴露本机绝对路径 */
export function relFromRoot(file) {
  const text = String(file);
  return text.startsWith(ROOT + "/") ? text.slice(ROOT.length + 1) : text;
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行，去掉成对引号。不展开变量、不打印内容。 */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

export function readEnv(file = ENV_FILE) {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** 后台路径：进程环境变量优先（测试用），其次 .env；非法一律视为未配置 => 后台整体关闭 */
export function adminPathFrom(env = {}) {
  const raw = String(process.env.ADMIN_PATH ?? env.ADMIN_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
  return ADMIN_PATH_RE.test(raw) ? raw : null;
}

export function validOwner(value) {
  return OWNER_RE.test(String(value ?? ""));
}

export function validTag(value) {
  return TAG_RE.test(String(value ?? ""));
}

// ---------- 原子写 ----------

/** 原子写 JSON：同目录临时文件 + rename；失败清掉临时文件，绝不留半截文件。 */
export function atomicWriteJson(file, value) {
  ensureDir(dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now().toString(36);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err;
  }
}

/** 覆盖前留一份 .bak（只留一份，反复保存不会堆垃圾）。返回是否留下了备份。 */
function backupOnce(file) {
  if (!existsSync(file)) return false;
  try {
    copyFileSync(file, file + ".bak");
    return true;
  } catch {
    return false;
  }
}

// ---------- 采集参数（data/admin/config.json 的 collector 块）----------
// 存在的理由：这些值以前只活在命令行参数里（pm2 启动命令），后台看不见也改不了 ——
// 想调预算就得登机器改命令重启。现在放进共享配置，两侧按同一张表校验。
// 注意：JSON 里写字符串数字也认（"600" → 600），但非数字/坏值一律回退默认值，绝不写坏配置。

export const DEFAULT_COLLECTOR = {
  budget: 120, // 每轮最多消耗多少次搜索请求（0 = 不限）
  maxPages: 10, // 每个分段最多翻几页
  refreshHours: 6, // 超过这个时长没刷新的分段重新排队
  readmeBudget: 150, // 每轮抓多少篇 README
  readmeMaxChars: 2000,
  readmeMinStars: 1,
  releasesBudget: 300,
  npmBudget: 300,
  interval: 3600, // 常驻模式的轮询间隔（秒）
  minRatio: 0.8, // 低于现有索引的这个比例时拒绝覆盖前端数据
  frontendLimit: 0, // 0 = 不限
};

const COLLECTOR_NUM = {
  budget: { type: "int", min: 0, max: 100000 },
  maxPages: { type: "int", min: 1, max: 10 }, // GitHub 搜索单查询硬上限就是 10 页
  refreshHours: { type: "float", min: 0.5, max: 720 },
  readmeBudget: { type: "int", min: 0, max: 100000 },
  readmeMaxChars: { type: "int", min: 200, max: 20000 },
  readmeMinStars: { type: "int", min: 0, max: 1000000 },
  releasesBudget: { type: "int", min: 0, max: 100000 },
  npmBudget: { type: "int", min: 0, max: 100000 },
  interval: { type: "int", min: 60, max: 86400 },
  minRatio: { type: "float", min: 0, max: 1 },
  frontendLimit: { type: "int", min: 0, max: 1000000 },
};

/** 后台设置页的展示元数据（顺序即渲染顺序）。fieldMeta 会随 api/lists 一起下发。 */
export const COLLECTOR_FIELDS = [
  { key: "budget", label: "搜索请求预算", unit: "次/轮", hint: "每轮最多消耗多少次 GitHub 搜索请求；0 = 不限。" },
  { key: "maxPages", label: "单段最多翻页", unit: "页", hint: "每个星标分段最多翻几页；GitHub 搜索单查询硬上限是 10 页。" },
  { key: "refreshHours", label: "刷新窗口", unit: "小时", hint: "超过这个时长没刷新的分段会重新排队。" },
  { key: "readmeBudget", label: "README 抓取量", unit: "篇/轮", hint: "每轮抓多少篇 README 做正文检索。" },
  { key: "readmeMaxChars", label: "README 摘要长度", unit: "字符", hint: "每个仓库保留的摘要长度，越大索引越全。" },
  { key: "readmeMinStars", label: "README 星标门槛", unit: "星", hint: "只索引星标不低于它的仓库；0 = 全量。" },
  { key: "releasesBudget", label: "releases 预算", unit: "个/轮", hint: "每轮抓多少个仓库的 release（1 个 = 1 次 core 配额）。" },
  { key: "npmBudget", label: "npm 下载量预算", unit: "个/轮", hint: "每轮查多少个仓库的 npm 周下载量。" },
  { key: "interval", label: "轮询间隔", unit: "秒", hint: "常驻采集每轮之间等多久。" },
  { key: "minRatio", label: "最小覆盖率", unit: "比例", hint: "低于现有索引的这个比例时拒绝覆盖前端数据（防手滑清库）。" },
  { key: "frontendLimit", label: "前端节点上限", unit: "个", hint: "前端快照保留多少节点；0 = 不限。" },
];

/** 范围表的只读视图：后台用它做前端校验，避免提交必然被拒的值。 */
export function collectorRanges() {
  return Object.fromEntries(Object.entries(COLLECTOR_NUM).map(([key, spec]) => [key, { ...spec }]));
}

/**
 * 单个设置的校验（供 admin.mjs 判断"这个键是不是被接受了"复用，别再写第二份范围判断）。
 * 合法返回数值，坏值/越界返回 null。
 */
export function numSettingFor(value, spec) {
  return numSetting(value, spec);
}

function numSetting(value, spec) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return null;
  if (!Number.isFinite(n)) return null;
  if (spec.type === "int" && !Number.isInteger(n)) return null;
  if (n < spec.min || n > spec.max) return null;
  return n;
}

/** 采集参数规范化：逐键校验，坏键静默回退默认值（与白名单同一条铁律：配置坏不能拖垮服务）。 */
export function normalizeCollector(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, spec] of Object.entries(COLLECTOR_NUM)) {
    const v = numSetting(source[key], spec);
    out[key] = v === null ? DEFAULT_COLLECTOR[key] : v;
  }
  return out;
}

// ---------- 白名单别名组（whitelistAliases）----------
// 要解决的问题（issue#5 第3条）：白名单匹配是精确的，仓库打了 dsh-theme / awesome-dsh 这类
// 同义标签就漏掉了。但直接把匹配改成"包含"会出事：build.py 有"挂 ≥3 个 DSH 标签又没有插件线索
// 就判噪声"的规则，一个仓库会同时命中 dsh、dsh-plugin、dsh-plugin-desktop 三个而误杀。
// 所以走显式登记：条目仍是精确 topic，别名由人写进来；匹配层展开，抓取层只抓规范标签。

export const MAX_ALIAS_GROUPS = 50;
export const MAX_ALIASES_PER_GROUP = 20;

/**
 * 规范化别名组：{tag, aliases: string[]}。
 * tag 必须本身就在白名单里 —— 否则"别名"等于凭空扩大抓取口径，而抓取层又抓不到它，
 * 结果只会是一堆永远匹配不上、又没人知道为什么的配置。
 */
export function normalizeAliases(raw, whitelistTags) {
  const allowed = new Set(Array.isArray(whitelistTags) ? whitelistTags : []);
  const out = [];
  const seenTag = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tag = String(item.tag ?? "").trim();
    if (!TAG_RE.test(tag) || !allowed.has(tag) || seenTag.has(tag)) continue;
    const aliases = [];
    const seenAlias = new Set();
    for (const value of Array.isArray(item.aliases) ? item.aliases : []) {
      const alias = String(value ?? "").trim();
      if (!TAG_RE.test(alias) || alias === tag || seenAlias.has(alias) || allowed.has(alias)) continue;
      seenAlias.add(alias);
      aliases.push(alias);
      if (aliases.length >= MAX_ALIASES_PER_GROUP) break;
    }
    if (!aliases.length) continue;
    seenTag.add(tag);
    out.push({ tag, aliases });
    if (out.length >= MAX_ALIAS_GROUPS) break;
  }
  return out;
}

/**
 * 匹配用的标签集合 = 白名单 + 各别名组展开出来的别名。
 * 抓取层【绝不】用这个列表：它只负责比对，不负责去 GitHub 搜。
 */
export function expandTags(whitelistTags, aliases) {
  const tags = [...new Set((Array.isArray(whitelistTags) ? whitelistTags : []).map((t) => String(t).trim()).filter(Boolean))];
  const allowed = new Set(tags);
  const expanded = [...tags];
  const aliasToCanon = new Map();
  for (const group of normalizeAliases(aliases, tags)) {
    for (const alias of group.aliases) {
      if (!aliasToCanon.has(alias)) aliasToCanon.set(alias, group.tag);
      if (!allowed.has(alias)) {
        allowed.add(alias);
        expanded.push(alias);
      }
    }
  }
  return { tags: expanded, aliasToCanon };
}

/**
 * 一个仓库命中白名单的真实情况：用哪些规范标签算它、主标签是谁。
 * matched = 仓库 topics 与该仓库相关的标签（规范标签 + 别名），primary = 主标签。
 * 判断逻辑集中在这里，等 ES 模块化后 Python 侧照这份语义抄；现在两边各实现一份，由测试盯住一致性。
 */
export function matchRepo(repo, whitelistTags, aliases) {
  const topics = Array.isArray(repo && repo.topics) ? repo.topics.map((t) => String(t)) : [];
  const tagSet = new Set(topics);
  const { aliasToCanon, tags } = expandTags(whitelistTags, aliases);
  const canonicals = [];
  const addCanon = (tag) => {
    if (tag && !canonicals.includes(tag)) canonicals.push(tag);
  };
  // 规范标签直接命中
  for (const tag of Array.isArray(whitelistTags) ? whitelistTags : []) if (tagSet.has(tag)) addCanon(tag);
  // 别名命中要归到它的规范标签上（仓库只打了别名时，matchedTags 也得记成 dsh，否则它会像"没有标签"
  // 一样被 primaryTag / tagCounts 漏掉 —— 那就等于白登记别名了）
  for (const alias of tags) if (tagSet.has(alias)) addCanon(aliasToCanon.get(alias));
  const order = new Map((Array.isArray(whitelistTags) ? whitelistTags : []).map((t, i) => [t, i]));
  canonicals.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  const matched = tags.filter((t) => tagSet.has(t));
  return {
    canonical: canonicals,
    matched,
    // 只挂最宽泛的 dsh 标签：build.py / relevance.mjs 用它区分"真相关"与"蹭标签"
    broadOnly: canonicals.length === 1 && canonicals[0] === "dsh",
  };
}

// ---------- 共享配置 ----------

export function normalizeConfig(raw) {
  const tags = Array.isArray(raw && raw.whitelistTags)
    ? [...new Set(raw.whitelistTags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))]
    : [];
  const overrides = {};
  const src = raw && raw.resonance && typeof raw.resonance === "object" ? raw.resonance.overrides : null;
  if (src && typeof src === "object") {
    for (const [key, value] of Object.entries(src)) {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(key)) continue;
      const enabled = typeof value === "boolean" ? value : value && typeof value === "object" ? value.enabled : undefined;
      if (typeof enabled === "boolean") overrides[key] = enabled;
    }
  }
  const whitelistTags = tags.length ? tags : [...DEFAULT_WHITELIST_TAGS];
  return {
    version: 1,
    updatedAt: typeof (raw && raw.updatedAt) === "string" ? raw.updatedAt : null,
    whitelistTags,
    // 别名组：只认"规范标签本身在白名单里"的组，其余忽略（见 normalizeAliases）
    whitelistAliases: normalizeAliases(raw && raw.whitelistAliases, whitelistTags),
    resonance: { overrides },
    // 采集参数：读的时候没法区分"用户显式设过"和"用的是默认值"，所以保存入口会带 mark 再回写一次
    collector: normalizeCollector(raw && raw.collector),
  };
}

export function loadAdminConfig(file = CONFIG_FILE) {
  try {
    return normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return normalizeConfig(null);
  }
}

/** 读原始配置（不做规范化）。它是**唯一**能做"保留未知键"的地方：规范化后的对象认不出别的键。 */
function readRawConfig(file = CONFIG_FILE) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * 写共享配置。两条契约：
 *  ① 保留未知键 —— 以前这里只回写已知的四个键，手工往 config.json 里加的采集参数
 *     只要在后台保存一次白名单就被静默抹掉，特别容易让人白查半天；
 *  ② 采集参数（collector）只按显式传入的值更新 —— 读进来的都是"补过默认值"的完整块，
 *     直接回写会把"没有配置"变成"配置等于默认值"，两者语义不同（后者会盖住命令行参数）。
 */
export function saveAdminConfig(next, file = CONFIG_FILE) {
  const raw = readRawConfig(file);
  const merged = { ...raw, ...(next && typeof next === "object" ? next : {}) };
  const known = normalizeConfig(merged);
  const config = {
    ...merged,
    version: known.version,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    whitelistTags: known.whitelistTags,
    whitelistAliases: known.whitelistAliases,
    resonance: known.resonance,
    collector: Object.prototype.hasOwnProperty.call(next || {}, "collector") ? known.collector : raw.collector ?? known.collector,
  };
  ensureDir(dirname(file));
  const backedUp = backupOnce(file);
  atomicWriteJson(file, config);
  return { config, backedUp };
}

export function whitelistTagsOf(config) {
  return normalizeConfig(config).whitelistTags;
}

export function whitelistAliasesOf(config) {
  return normalizeConfig(config).whitelistAliases;
}

/** 抓取层用的标签：**只有规范标签**。别名拿去搜 GitHub 是白花配额（GitHub 只认精确 topic）。 */
export function crawlTagsOf(config) {
  return whitelistTagsOf(config);
}

export function resonanceOverridesOf(config) {
  return normalizeConfig(config).resonance.overrides;
}

// ---------- 累积索引的只读投影（给「影响预估」用）----------
// 目的：后台加黑名单时先说清"这人当前收录了几个仓库、点『立即应用』后会少几个"，
// 而不是回一句"已加入"却什么也不变（"加了没反应"的根因）。
// 索引 29MB / 4.4 万条，解析一次约 0.25s，所以按 (mtime,size) 缓存；采集每轮重写一次 => 自动失效。

const CACHE_FILE = join(CACHE_DIR, "repos.json");
let indexCache = null; // { mtimeMs, size, mtimeIso, ownerCount, reposCount, ownerRepos, ownerStars }

function emptyIndex() {
  return { mtimeMs: 0, size: 0, mtimeIso: null, ownerCount: 0, reposCount: 0, ownerRepos: new Map(), ownerStars: new Map() };
}

/**
 * 把累积索引投影成"作者 → 仓库数 / 星标合计"。文件缺失、损坏、结构不对都回退空索引，
 * 绝不让一份缓存文件坏掉就拖垮后台接口（与 loadAdminConfig 同一条铁律）。
 */
function buildIndex(raw) {
  const repos = raw && typeof raw === "object" && raw.repos && typeof raw.repos === "object" ? raw.repos : {};
  const ownerRepos = new Map();
  const ownerStars = new Map();
  for (const entry of Object.values(repos)) {
    if (!entry || typeof entry !== "object") continue;
    const owner = String(entry.owner ?? String(entry.id ?? "").split("/")[0]).trim();
    if (!owner) continue;
    ownerRepos.set(owner, (ownerRepos.get(owner) ?? 0) + 1);
    const stars = Number.isFinite(entry.stars) ? entry.stars : Number(entry.stars) || 0;
    ownerStars.set(owner, (ownerStars.get(owner) ?? 0) + stars);
  }
  return { ownerCount: ownerRepos.size, reposCount: Object.keys(repos).length, ownerRepos, ownerStars };
}

/** 注入式投影：测试用（不读磁盘），也是 estimateOwnerImpact 的唯一计算入口。 */
export function ownerImpactFromIndex(raw, owner) {
  const built = buildIndex(raw);
  const key = String(owner ?? "").trim();
  const repos = key ? built.ownerRepos.get(key) ?? 0 : 0;
  return { owner: key, repos, totalStars: repos ? built.ownerStars.get(key) ?? 0 : 0, indexedAt: null, inData: repos > 0 };
}

function readIndex(file = CACHE_FILE) {
  try {
    const info = statSync(file);
    if (indexCache && indexCache.mtimeMs === info.mtimeMs && indexCache.size === info.size) return indexCache;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const built = buildIndex(raw);
    indexCache = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      mtimeIso: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(info.mtimeMs).toISOString(),
      ...built,
    };
  } catch {
    indexCache = indexCache ?? emptyIndex();
  }
  return indexCache;
}

/**
 * 作者级黑名单的影响预估：当前累积索引里这个作者有多少个仓库、合计多少星。
 * repos = 0 说明"加名单不会有可见变化"（他压根不在数据里）—— 这正是 issue#5 第2条抱怨的根源。
 */
export function estimateOwnerImpact(owner, file = CACHE_FILE) {
  const idx = readIndex(file);
  const key = String(owner ?? "").trim();
  const repos = key ? idx.ownerRepos.get(key) ?? 0 : 0;
  return { owner: key, repos, totalStars: repos ? idx.ownerStars.get(key) ?? 0 : 0, indexedAt: idx.mtimeIso, inData: repos > 0 };
}

// ---------- 噪声黑名单（外壳格式必须与 snapshot.py:write_blacklist 完全一致）----------

/**
 * 合格的单仓库黑名单条目：{ note, addedAt }，键是 "owner/repo"。
 * 坏条目直接丢（手改文件是常态），绝不让一条脏数据把整份名单带崩。
 */
function normalizeRepoEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { note: null, addedAt: null };
  return {
    note: typeof value.note === "string" && value.note ? value.note.slice(0, 200) : null,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : null,
  };
}

/** 键排序 + 去重，保证写盘结果可复现（同一份名单两次保存应当逐字节相同）。 */
function sortRecord(source) {
  const out = {};
  for (const key of Object.keys(source || {}).sort()) out[key] = source[key];
  return out;
}

/**
 * 读黑名单：只认 owners / repos 两个键 —— 与 Python 的 load_blacklist / write_blacklist 同规则，
 * 少了这层外壳，采集器会当成空表，等于静默失效。
 *   owners = 作者级（一个人整批刷标签，整账号剔除）
 *   repos  = 单仓库级（那个人还有真项目，只剔这一个）—— issue#5 第1条
 */
export function normalizeBlacklistRepoEntry(value) {
  return normalizeRepoEntry(value);
}

export function readBlacklist(file = BLACKLIST_FILE) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const owners = data && typeof data === "object" && data.owners && typeof data.owners === "object" ? data.owners : {};
    const repos = data && typeof data === "object" && data.repos && typeof data.repos === "object" ? data.repos : {};
    return {
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      // count = 两个名单的条目总数（外壳自述，方便一眼看出删没删干净）
      count: Object.keys(owners).length + Object.keys(repos).length,
      ownerCount: Object.keys(owners).length,
      repoCount: Object.keys(repos).length,
      note: typeof data.note === "string" ? data.note : BLACKLIST_NOTE,
      owners,
      repos,
    };
  } catch {
    return { updatedAt: null, count: 0, ownerCount: 0, repoCount: 0, note: BLACKLIST_NOTE, owners: {}, repos: {} };
  }
}

export function writeBlacklist(payload, file = BLACKLIST_FILE) {
  const owners = sortRecord((payload && payload.owners) || {});
  const repos = sortRecord((payload && payload.repos) || {});
  const next = {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    count: Object.keys(owners).length + Object.keys(repos).length,
    note: typeof (payload && payload.note) === "string" && payload.note ? payload.note : BLACKLIST_NOTE,
    owners,
    repos,
  };
  ensureDir(dirname(file));
  const backedUp = backupOnce(file);
  atomicWriteJson(file, next);
  return { blacklist: next, backedUp };
}

// ---------- 审计 ----------

/** 审计日志：一行一条 JSON，只记"何时 / 哪个 IP / 干了什么"，不记口令、不记后台路径。 */
export function appendAudit(entry, file = AUDIT_FILE) {
  const line = JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...entry }) + "\n";
  try {
    ensureDir(dirname(file));
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    /* 审计写失败不能打断业务 */
  }
}

export function readAudit(limit = 100, file = AUDIT_FILE) {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const take = Math.max(1, Math.min(1000, Number(limit) || 100));
    return lines.slice(-take).reverse().map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { at: null, action: "?", detail: line.slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}

// ---------- 生态共鸣清单（后台管理副本）----------

/**
 * 共鸣清单的读取顺序：**后台管理副本优先**，没有才用策展产物。
 * 管理副本放 data/admin/ecosystem.json，因为它必须活过两次覆盖：tools/deploy-remote.sh 会同步整个 tools/
 * （编辑 tools/ecosystem.json 会在下次部署被冲掉），tools/curate-ecosystem.mjs 复跑也会整体重写它；
 * data/ 下这两个都碰不到（部署明确排除 data/），想回到策展版本点后台的「还原」即可。
 */
export const MANAGED_ECOSYSTEM_FILE = join(ADMIN_DIR, "ecosystem.json");

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 每段最多 100 字符（GitHub 上限：owner 39 / repo 100），整体另设 200 上限 —— 不限长的话，一个 4000 字符的 id 会被原样写进清单，撑大文件、拖慢每一次读取。
const ID_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export function validRepoId(value) {
  const text = String(value ?? "");
  if (text.length > 200 || !ID_RE.test(text)) return false;
  // 防御性：__proto__ 不是合法 GitHub 名，别让它出现在清单里（哪怕当前代码只把它当字符串用）
  return text.split("/").every((part) => part !== "__proto__");
}

/** 按 id 去重 + 过滤非法 id（清单是人工编辑的，坏条目不能带崩整页） */
function uniqueById(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((item) => {
    if (!item || !validRepoId(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function normalizeEcosystem(raw) {
  return {
    version: 1,
    mesh: raw && typeof raw.mesh === "string" ? raw.mesh : "data/mesh.json",
    note: raw && typeof raw.note === "string" ? raw.note : null,
    generatedAt: raw && typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    updatedAt: raw && typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    bases: uniqueById(raw && raw.bases).map((b) => {
        const base = {
          id: b.id,
          label: typeof b.label === "string" && b.label ? b.label : b.id,
          tag: typeof b.tag === "string" && b.tag ? b.tag : null,
          enabled: b.enabled !== false,
          // 锚定条件：null 表示「这份清单里根本没写」（展示时回落到内置值），空数组 [] 表示「运营明确清空了」——两者必须区分，否则用户永远删不掉内置条件。
          probes: Array.isArray(b.probes) ? cleanList(b.probes) : null,
          packages: Array.isArray(b.packages) ? cleanList(b.packages) : null,
          context: CONTEXT_IDS.includes(b.context) ? b.context : null,
          verified: uniqueById(b.verified).map((c) => ({
            ...c,
            signals: cleanList(c.signals, 20, 120),
            readme: typeof c.readme === "string" ? c.readme.slice(0, 120) : c.readme,
          })),
        };
        for (const key of ["search", "signals", "signalNote"]) if (b[key] !== undefined) base[key] = b[key];
        return base;
      }),
  };
}

export function readEcosystem() {
  const curated = readJsonFile(ECOSYSTEM_FILE);
  const managedRaw = existsSync(MANAGED_ECOSYSTEM_FILE) ? readJsonFile(MANAGED_ECOSYSTEM_FILE) : null;
  const managedOk = !!(managedRaw && Array.isArray(managedRaw.bases));
  const raw = managedOk ? managedRaw : curated;
  return {
    doc: normalizeEcosystem(raw),
    source: managedOk ? relFromRoot(MANAGED_ECOSYSTEM_FILE) : relFromRoot(ECOSYSTEM_FILE),
    managed: managedOk,
    curatedAt: curated && typeof curated.generatedAt === "string" ? curated.generatedAt : null,
    updatedAt: managedOk && typeof managedRaw.updatedAt === "string" ? managedRaw.updatedAt : null,
    curated: normalizeEcosystem(curated),
  };
}

export function writeEcosystem(doc) {
  const normalized = normalizeEcosystem(doc);
  // 管理副本要能自解释：**没写过的**锚定条件补成内置值（null 才算没写过；显式空数组要尊重），策展工具读它时不必再猜「空数组是什么意思」。
  for (const base of normalized.bases) {
    const builtin = builtinBase(base.id);
    if (!builtin) continue;
    if (base.probes === null) base.probes = [...builtin.probes];
    if (base.packages === null) base.packages = [...builtin.packages];
    if (!base.context) base.context = builtin.context;
  }
  const next = { ...normalized, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  ensureDir(dirname(MANAGED_ECOSYSTEM_FILE));
  const backedUp = backupOnce(MANAGED_ECOSYSTEM_FILE);
  atomicWriteJson(MANAGED_ECOSYSTEM_FILE, next);
  return { doc: next, backedUp };
}

/** 用策展产物覆盖后台副本（后台的「还原策展版本」） */
export function resetEcosystem() {
  const curated = readJsonFile(ECOSYSTEM_FILE);
  if (!curated || !Array.isArray(curated.bases)) return null;
  return writeEcosystem(curated);
}

/** 把一份清单换算成「策展工具实际要用的锚定条件」：写了就用写的（空数组 = 明确清空），没写（null）回落到内置定义；纯函数，方便单测，tools/curate-ecosystem.mjs 直接用它。 */
export function effectiveAnchors(doc) {
  return normalizeEcosystem(doc).bases.map((b) => {
    const builtin = builtinBase(b.id);
    return {
      id: b.id,
      label: b.label,
      tag: b.tag,
      enabled: b.enabled,
      probes: b.probes === null ? (builtin ? [...builtin.probes] : []) : [...b.probes],
      packages: b.packages === null ? (builtin ? [...builtin.packages] : []) : [...b.packages],
      context: b.context ?? (builtin ? builtin.context : DEFAULT_CONTEXT),
    };
  });
}

export function fileMtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- 日志（只读，白名单路径）----------

/** 日志白名单：只有这三类能被后台读出来；名字是给接口用的相对路径，落盘时再映射绝对路径 —— 绝不吃用户传进来的路径本身。 */
export function resolveLogName(name) {
  const clean = String(name ?? "").replace(/^\.\//, "").trim();
  if (/^data\/admin\/logs\/[A-Za-z0-9._-]+\.log$/.test(clean)) return { path: join(LOG_DIR, clean.slice("data/admin/logs/".length)), name: clean };
  // 只给文件名也认（早期 workflow.logs 只回文件名）——只在已知的那几份日志里按文件名匹配
  if (/^[A-Za-z0-9._-]+\.log$/.test(clean)) {
    const known = [
      [AUDIT_FILE, "data/admin/audit.log"],
      [join(DATA_DIR, "crawl.log"), "data/crawl.log"],
      [join(LOG_DIR, clean), "data/admin/logs/" + clean],
    ];
    for (const [candidate, name] of known) {
      if (candidate.split("/").pop() === clean) return { path: candidate, name };
    }
  }
  if (clean === "data/crawl.log") return { path: join(DATA_DIR, "crawl.log"), name: clean };
  if (clean === "data/admin/audit.log") return { path: AUDIT_FILE, name: clean };
  return null;
}

export function listLogs() {
  const files = [];
  for (const item of listDir(LOG_DIR)) {
    files.push({ name: "data/admin/logs/" + item.name, bytes: item.bytes, mtime: item.mtime });
  }
  for (const [file, name] of [[join(DATA_DIR, "crawl.log"), "data/crawl.log"], [AUDIT_FILE, "data/admin/audit.log"]]) {
    const info = fileInfo(file);
    if (info) files.push({ name, bytes: info.bytes, mtime: info.mtime });
  }
  return files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 只读日志尾部：最多取最后 512KB / 2000 行，避免把几百 MB 的日志塞进浏览器 */
export function readLogTail(name, { maxBytes = 512 * 1024, maxLines = 2000 } = {}) {
  const resolved = resolveLogName(name);
  if (!resolved) return null;
  let info;
  try {
    info = statSync(resolved.path);
  } catch {
    return null;
  }
  const size = Math.min(info.size, maxBytes);
  const buf = Buffer.alloc(size);
  let fd;
  let got = 0;
  try {
    fd = openSync(resolved.path, "r");
    // 文件可能在 stat 与 read 之间被截断/轮转，按实际读到的字节数截断，免得读出尾部一串 \0
    got = readSyncCompat(fd, buf, 0, size, Math.max(0, info.size - size));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const text = buf.subarray(0, got > 0 ? got : 0).toString("utf8");
  let lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const truncated = info.size > size || lines.length > maxLines;
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  return {
    name: resolved.name,
    bytes: info.size,
    mtime: new Date(info.mtimeMs).toISOString(),
    truncated,
    lines: lines.map((line) => line.slice(0, 500)),
  };
}

// ---------- 文件概况 ----------

export function fileInfo(file, label) {
  try {
    const info = statSync(file);
    const relative = String(file).startsWith(ROOT + "/") ? String(file).slice(ROOT.length + 1) : String(file);
    return { path: relative, label: label ?? null, bytes: info.size, mtime: new Date(info.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

export function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const info = statSync(join(dir, d.name));
        return { name: d.name, bytes: info.size, mtime: new Date(info.mtimeMs).toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}
