/**
 * 噪声判定的离线证据表（可缺省）—— backend/dsh_mesh/build.py:load_noise_evidence 的逐字镜像。
 * 改动请同时改两边。
 *
 * 证据缓存（都允许缺失，读不到当空表，规则退回老口径）：
 *   - data/cache/repo-manifests.json（tools/scan-manifests-tree.mjs）：verdict=confirmed 视为真 dsh 插件；
 *   - data/cache/noise-evidence.json（tools/noise-evidence-scan.mjs）：README 索引未覆盖队列的补扫摘要；
 *   - data/cache/readmes.json.gz（采集器 README 索引）：覆盖最全；
 *   - data/cache/market-ui-evidence.json × dist/market/index.json：npm 侧独立确证
 *     （dsh.client 声明 / ./client 入口真实存在）——manifest 之外的第二条「确认插件」通道。
 * 输出 {id: {manifestOk, npmOk, readmeHit, readmeDigest}}：
 *   readmeHit=True  摘要非空且含 DSH 专有线索；False 摘要非空但没提 DSH（README 实证）；null 没有摘要；
 *   readmeDigest  证据摘要原文（判定时借给节点，判定完摘掉；npm/manifest 主证据不含它时为空串）。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFESTS = resolve(ROOT, "data/cache/repo-manifests.json");
const NOISE_EVIDENCE = resolve(ROOT, "data/cache/noise-evidence.json");
const README_INDEX = resolve(ROOT, "data/cache/readmes.json.gz");

/* README 摘要与命中口径（backend/dsh_mesh/readmes.py normalize 与 build.py _DSH_NAME_RE 的镜像）。 */
const BADGE_IMG = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAG = /<[^>]+>/g;
const MD_MARKS = /[#*`>|_~]{1,}/g;
const MAX_CHARS = 2000;

/** README 原文 → 检索摘要（python ReadmeIndex.normalize 的逐字镜像。空串 = README 不存在/抓不到。） */
export function normalizeReadme(text) {
  if (!text) return "";
  let cleaned = "";
  for (const ch of text) if (ch === "\n" || ch === "\t" || ch.charCodeAt(0) >= 32) cleaned += ch;
  cleaned = cleaned.replace(BADGE_IMG, " ");
  cleaned = cleaned.replace(MD_LINK, "$1");
  cleaned = cleaned.replace(HTML_TAG, " ");
  cleaned = cleaned.replace(/\bhttps?:\/\/\S+/g, " ");
  cleaned = cleaned.replace(MD_MARKS, " ");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
}

/** README 摘要里有没有 DSH 专有线索。 */
export function readmeHit(digest) {
  return DSH_RE.test(digest || "");
}

/** 与 build.py _DSH_NAME_RE 同一正则（README 摘要搜 DSH 专有线索）。 */
const DSH_RE = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]|deepseek[\s-]?harness|cordis/i;

function loadDocs(path) {
  try {
    const buf = readFileSync(path);
    const raw = String(path).endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    const doc = JSON.parse(raw);
    const docs = doc && typeof doc === "object" ? doc.docs : null;
    return docs && typeof docs === "object" ? docs : {};
  } catch {
    return {};
  }
}

const freshRec = () => ({ manifestOk: false, npmOk: false, readmeHit: null, readmeDigest: "" });

export async function loadMeshEvidence() {
  const evidence = new Map();
  try {
    const man = JSON.parse(readFileSync(MANIFESTS, "utf8"));
    for (const [rid, rec] of Object.entries(man.repos ?? {})) {
      if (rec && typeof rec === "object" && rec.verdict === "confirmed") {
        if (!evidence.has(rid)) evidence.set(rid, freshRec());
        evidence.get(rid).manifestOk = true;
      }
    }
  } catch {
    /* 清单没了/坏了就当空表 */
  }
  for (const path of [NOISE_EVIDENCE, README_INDEX]) {
    const docs = loadDocs(path);
    for (const [rid, doc] of Object.entries(docs)) {
      if (!evidence.has(rid)) evidence.set(rid, freshRec());
      const ev = evidence.get(rid);
      if (ev.readmeHit !== null) continue; // 先到的证据优先，不回退
      const digest = String((doc && doc.t) || "");
      if (!digest) continue; // README 不存在/抓不到 = 没有证据，留 null
      ev.readmeHit = DSH_RE.test(digest);
      ev.readmeDigest = digest;
    }
  }
  await mergeNpmEvidence(evidence);
  return evidence;
}

/** npm 侧独立确证（与 build.py:load_npm_plugin_evidence 同镜像）：
 *  market-ui-evidence 里 dsh.client 声明或 ./client 入口「真实存在」的包，反查到仓库 → npmOk=true
 *  （manifest confirmed 之外的第二条通道；conflict 时已 confirmed 的不动）。 */
async function mergeNpmEvidence(evidence) {
  let ui = null;
  let idx = null;
  try {
    ui = JSON.parse(readFileSync(join(ROOT, "data", "cache", "market-ui-evidence.json"), "utf8"));
    idx = JSON.parse(readFileSync(join(ROOT, "dist", "market", "index.json"), "utf8"));
  } catch {
    return; // 证据缺席：规则退回无此结论
  }
  /* URL 归一不吃正则：直接 indexOf("github.com/") 截尾 + 字面去掉 ".git"，与 python 侧同一手写逻辑。 */
  const normalizeRepo = (v) => {
    const s = String(v || "");
    const i = s.indexOf("github.com/");
    const rid = i >= 0 ? s.slice(i + "github.com/".length) : s;
    return rid.replace(".git", "");
  };
  const repoOf = (pl) => {
    let url = pl?.source ?? null;
    const repo = pl?.repository;
    if (typeof repo === "string") url = repo;
    else if (repo && typeof repo === "object" && typeof repo.url === "string") url = repo.url;
    return url ? normalizeRepo(url) : null;
  };
  const byName = new Map((idx.plugins ?? []).map((pl) => [pl.name, pl]));
  for (const pkg of Object.values(ui.packages ?? {})) {
    if (!(pkg && pkg.ok && (pkg.dshClient || pkg.clientEntry))) continue;
    const pl = byName.get(pkg.name);
    const rid = pl && repoOf(pl);
    if (!rid) continue;
    if (!evidence.has(rid)) evidence.set(rid, freshRec());
    const ev = evidence.get(rid);
    if (!ev.manifestOk) ev.npmOk = true;
  }
}

/** 把证据字段借给节点参与判定；返回名单（判定完按名单摘掉，落盘口径不变）。 */
export function applyEvidence(node, ev) {
  if (!ev) return [];
  const added = [];
  if (!("manifestOk" in node)) { node.manifestOk = !!ev.manifestOk; added.push("manifestOk"); }
  if (!("npmOk" in node) && ev.npmOk) { node.npmOk = true; added.push("npmOk"); }
  if (!("readmeHit" in node)) { node.readmeHit = ev.readmeHit; added.push("readmeHit"); }
  if (!("readmeDigest" in node) && ev.readmeDigest) { node.readmeDigest = ev.readmeDigest; added.push("readmeDigest"); }
  return added;
}

export function stripEvidence(node, keys) {
  for (const key of keys ?? []) delete node[key];
}
