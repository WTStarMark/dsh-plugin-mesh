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

const BLACKLIST_NOTE = "噪声作者（同一作者被收录超过阈值个仓库、且每个仓库星标都低于阈值）。删除条目即可解除拉黑。";
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
  return {
    version: 1,
    updatedAt: typeof (raw && raw.updatedAt) === "string" ? raw.updatedAt : null,
    whitelistTags: tags.length ? tags : [...DEFAULT_WHITELIST_TAGS],
    resonance: { overrides },
  };
}

export function loadAdminConfig(file = CONFIG_FILE) {
  try {
    return normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return normalizeConfig(null);
  }
}

export function saveAdminConfig(next, file = CONFIG_FILE) {
  const config = normalizeConfig({ ...next, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  ensureDir(dirname(file));
  const backedUp = backupOnce(file);
  atomicWriteJson(file, config);
  return { config, backedUp };
}

export function whitelistTagsOf(config) {
  return normalizeConfig(config).whitelistTags;
}

export function resonanceOverridesOf(config) {
  return normalizeConfig(config).resonance.overrides;
}

// ---------- 噪声黑名单（外壳格式必须与 snapshot.py:write_blacklist 完全一致）----------

/** 读黑名单：只认 owners 键 —— 与 Python 的 load_blacklist 同规则，少了这层外壳，采集器会当成空表，等于静默失效。 */
export function readBlacklist(file = BLACKLIST_FILE) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const owners = data && typeof data === "object" && data.owners && typeof data.owners === "object" ? data.owners : {};
    return {
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      count: Object.keys(owners).length,
      note: typeof data.note === "string" ? data.note : BLACKLIST_NOTE,
      owners,
    };
  } catch {
    return { updatedAt: null, count: 0, note: BLACKLIST_NOTE, owners: {} };
  }
}

export function writeBlacklist(payload, file = BLACKLIST_FILE) {
  const owners = {};
  for (const key of Object.keys((payload && payload.owners) || {}).sort()) owners[key] = payload.owners[key];
  const next = {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    count: Object.keys(owners).length,
    note: typeof (payload && payload.note) === "string" && payload.note ? payload.note : BLACKLIST_NOTE,
    owners,
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
