/**
 * 人工复核结论（生态图「待人工」队列的复核页）：人工给某个仓库下的 verdict 结论（related / noise）
 * 存 data/review-verdicts.json，**压过规则与证据判定**；撤回条目即回退为规则判定。
 *
 * 三条铁律（与黑名单同款纪律）：
 *   1) 外壳固定 { updatedAt, note, reviews }，reviews 里的 verdict 只认 related / noise；
 *   2) Python 侧（backend/dsh_mesh/build.py:load_verdict_reviews / apply_verdict_override）逐条同镜像，
 *      字段名、默认因果文案一字不能差 —— 改一边要改两边，tests/review-verdicts.test.mjs 钉死了对照；
 *   3) 写侧一律走这里：覆盖前留一份 .bak（backupOnce 同款），绝不在别处裸写。
 * 仓库 id（owner/repo）是身份：仓库改名后旧条目自然变「未在图中」，复核页会如实标出，不猜新名。
 */
import { existsSync, readFileSync, renameSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REVIEW_FILE = process.env.REVIEW_FILE ? resolve(process.env.REVIEW_FILE) : resolve(ROOT, "data", "review-verdicts.json");

export const VERDICT_REVIEW_NOTE =
  "人工复核结论压过规则判定（撤回即回退）；保存后点『应用变更』离线重算生效。";
/** 允许人工下的两档：manual 不能手工下（等于「无需复核」，与队列语义打架） */
const ALLOWED_VERDICTS = new Set(["related", "noise"]);

/** 人工结论的因果文案：JS/Python 两侧一字不差。 */
export function verdictReasonOf(entry) {
  const note = entry && typeof entry === "object" ? String(entry.note || "").trim() : "";
  return note ? "人工复核：" + note : "人工复核（后台）";
}

/** 读复核表：坏文件/没建过都当空表（缺失=没有人复核过，绝不假装成规则结论）。 */
export function readVerdictReviews(file = REVIEW_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    const reviews = raw.reviews && typeof raw.reviews === "object" ? raw.reviews : {};
    const clean = {};
    for (const [id, rec] of Object.entries(reviews)) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(id))) continue;
      const verdict = rec && typeof rec === "object" ? String(rec.verdict || "") : "";
      if (!ALLOWED_VERDICTS.has(verdict)) continue;
      clean[id] = {
        verdict,
        note: rec.note && typeof rec.note === "string" ? rec.note : null,
        addedAt: typeof rec.addedAt === "string" ? rec.addedAt : null,
      };
    }
    return {
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      note: typeof raw.note === "string" && raw.note ? raw.note : VERDICT_REVIEW_NOTE,
      count: Object.keys(clean).length,
      reviews: clean,
    };
  } catch {
    return { updatedAt: null, note: VERDICT_REVIEW_NOTE, count: 0, reviews: {} };
  }
}

function backupOnce(file) {
  let backedUp = false;
  try {
    if (existsSync(file)) {
      copyFileSync(file, file + ".bak");
      backedUp = true;
    }
  } catch {
    /* 备份失败不拦写入：.bak 是加分项 */
  }
  return backedUp;
}

const sortRecord = (rec) => Object.fromEntries(Object.entries(rec ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** 写整表（admin 与批量清洗共用）；返回 { review, backedUp }。 */
export function writeVerdictReviews(reviews, note, file = REVIEW_FILE) {
  const next = {
    updatedAt: iso(),
    note: typeof note === "string" && note ? note : VERDICT_REVIEW_NOTE,
    count: Object.keys(reviews).length,
    reviews: sortRecord(reviews),
  };
  mkdirSync(dirname(file), { recursive: true });
  const backedUp = backupOnce(file);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 1) + "\n");
  renameSync(tmp, file);
  return { review: next, backedUp };
}

/** upsert 一条人工结论；冲突时后写赢。返回写后的整表。 */
export function setVerdictReview(repoId, verdict, note = null, file = REVIEW_FILE) {
  if (!ALLOWED_VERDICTS.has(verdict)) throw new Error("verdict 只能是 related / noise：" + verdict);
  const doc = readVerdictReviews(file);
  const reviews = { ...doc.reviews };
  reviews[repoId] = {
    verdict,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null,
    addedAt: iso(),
  };
  return writeVerdictReviews(reviews, doc.note, file);
}

export function removeVerdictReview(repoId, file = REVIEW_FILE) {
  const doc = readVerdictReviews(file);
  if (!doc.reviews[repoId]) return { review: doc, backedUp: false, existed: false };
  const reviews = { ...doc.reviews };
  delete reviews[repoId];
  return { review: writeVerdictReviews(reviews, doc.note, file).review, backedUp: true, existed: true };
}

/** 管线用：把复核表压成 {repoId: {verdict, reason, review: false}}（规则侧要的是这个形状）。 */
export function reviewOverrideMap(file = REVIEW_FILE) {
  const doc = readVerdictReviews(file);
  const out = {};
  for (const [id, rec] of Object.entries(doc.reviews)) {
    out[id] = { verdict: rec.verdict, reason: verdictReasonOf(rec), review: false };
  }
  return out;
}

/** npm 侧确证集合（与 build.py:load_npm_plugin_evidence 同底数据）——给复核页行内速览用。 */
export async function npmOkSet() {
  let ui = null;
  let idx = null;
  try {
    ui = JSON.parse(readFileSync(resolve(ROOT, "data", "cache", "market-ui-evidence.json"), "utf8"));
    idx = JSON.parse(readFileSync(resolve(ROOT, "dist", "market", "index.json"), "utf8"));
  } catch {
    return new Set();
  }
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
  const out = new Set();
  for (const pkg of Object.values(ui.packages ?? {})) {
    if (!(pkg && pkg.ok && (pkg.dshClient || pkg.clientEntry))) continue;
    const pl = byName.get(pkg.name);
    const rid = pl && repoOf(pl);
    if (rid) out.add(rid);
  }
  return out;
}
