#!/usr/bin/env node
/**
 * 一次性「改名补账」工具：把旧 full_name 名下的星标逐日台账迁移到现名，并把连续性锚点接回「最后一次已计数观测」。
 *
 * 背景：star-daily.json 以 full_name 为键，改名后旧名有账、现名无账；采集器 v0.5.4 起会在改名当轮用旧基线接续，
 * 但【已经发生过的】改名（例如 2026-10-30 的 ccch1mneyyy/dsh-go → dsh-Go）当轮已经按「首见基线」处理过，
 * 那段空档只能靠本工具补回来。默认 dry-run，只打印计划；--apply 才写盘（先备份）。
 *
 * 安全条件（缺一不可）：
 *   ① 旧名不是活节点（名字没被别的仓库占用）—— 由 aliasIndexOf 保证；
 *   ② 现名在台账里还没有任何日桶/宽条增量 —— 说明改名后还没开始计数，用旧基线接续不会双算；
 *      若现名已经在正常计数，只迁移旧日桶（展示等价于接口别名合并），不改 seen 锚点。
 * 只动 data/cache/star-daily.json；star-history 是绝对值快照、只作冷启动兜底，接口读取时按别名处理，不迁。
 *
 * 用法：
 *   node tools/repair-identities.mjs [--root <dir>] [--mesh <path>] [--star-daily <path>] [--apply] [--json]
 */
import { readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasIndexOf } from "./api.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argOf(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

function atomicWriteJson(path, value) {
  const tmp = path + ".tmp";
  return writeFile(tmp, JSON.stringify(value), "utf8").then(() => rename(tmp, path));
}

export function planStarDailyRepair(daily, alias) {
  const seen = { ...(daily.seen ?? {}) };
  const carry = { ...(daily.seenCarry ?? {}) };
  const days = {};
  for (const [day, bucket] of Object.entries(daily.days ?? {})) days[day] = { ...(bucket ?? {}) };
  const spans = (daily.spans ?? []).map((s) => ({ ...s, d: { ...(s.d ?? {}) } }));
  const hasGain = (id) => {
    if (!id) return false;
    if (Object.values(days).some((bucket) => (bucket[id] ?? 0) !== 0)) return true;
    return spans.some((s) => (s.d[id] ?? 0) !== 0);
  };

  const moved = [];
  const skipped = [];
  for (const [oldName, newName] of alias) {
    const oldHad = hasGain(oldName);
    if (!oldHad) continue;
    const newHad = hasGain(newName);
    let dayRows = 0;
    let spanRows = 0;
    for (const bucket of Object.values(days)) {
      if (oldName in bucket) {
        bucket[newName] = (bucket[newName] ?? 0) + (bucket[oldName] ?? 0);
        delete bucket[oldName];
        dayRows += 1;
      }
    }
    for (const s of spans) {
      if (oldName in s.d) {
        s.d[newName] = (s.d[newName] ?? 0) + (s.d[oldName] ?? 0);
        delete s.d[oldName];
        spanRows += 1;
      }
    }
    let seenAdjusted = false;
    if (newHad) {
      // 现名已经在计数：只搬历史桶，不动 seen（否则会把已经计过的天数再算一遍）
      skipped.push({ old: oldName, new: newName, reason: "现名已在计数中，只迁移历史桶、不接连续性锚点" });
    } else if (oldName in seen) {
      seen[newName] = seen[oldName];
      if (carry[oldName]) carry[newName] = carry[oldName];
      seenAdjusted = true;
    }
    if (seenAdjusted || newHad) {
      delete seen[oldName];
      delete carry[oldName];
    }
    moved.push({ old: oldName, new: newName, dayRows, spanRows, seenAdjusted, newHad });
  }
  return {
    plan: moved,
    skipped,
    output: { ...daily, seen, seenCarry: carry, days, spans },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const root = resolve(argOf(argv, "--root", ROOT));
  const meshPath = resolve(argOf(argv, "--mesh", join(root, "data", "mesh.json")));
  const dailyPath = resolve(argOf(argv, "--star-daily", join(root, "data", "cache", "star-daily.json")));
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");

  const mesh = JSON.parse(await readFile(meshPath, "utf8"));
  const alias = aliasIndexOf(mesh.nodes ?? []);
  const daily = JSON.parse(await readFile(dailyPath, "utf8"));
  const { plan, skipped, output } = planStarDailyRepair(daily, alias);

  const totalDelta = plan.reduce((sum, p) => {
    let s = 0;
    for (const bucket of Object.values(daily.days ?? {})) s += bucket?.[p.old] ?? 0;
    for (const sp of daily.spans ?? []) s += sp?.d?.[p.old] ?? 0;
    return sum + s;
  }, 0);

  const summary = {
    mesh: meshPath,
    starDaily: dailyPath,
    aliases: alias.size,
    pairs: plan.length,
    totalDelta,
    plan,
    skipped,
    applied: false,
  };
  if (apply && plan.length) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const backup = dailyPath.replace(/\.json$/, "") + ".bak-" + stamp + ".json";
    await copyFile(dailyPath, backup);
    output.updatedAt = new Date().toISOString();
    output.note = String(output.note ?? "") + "（改名补账 " + plan.length + " 对，工具 tools/repair-identities.mjs）";
    await atomicWriteJson(dailyPath, output);
    summary.applied = true;
    summary.backup = backup;
  }
  if (json) {
    console.log(JSON.stringify(summary, null, 1));
  } else {
    console.log("改名补账计划（" + (apply ? "apply" : "dry-run") + "）");
    console.log("  台账: " + dailyPath);
    console.log("  别名: " + alias.size + " 条 | 需要补账: " + plan.length + " 对 | 涉及的旧名增量合计: " + totalDelta);
    for (const p of plan) {
      console.log("    " + p.old + "  →  " + p.new + "  | 日桶 " + p.dayRows + " 行 / 宽条 " + p.spanRows + " 行" + (p.seenAdjusted ? " / 已接回连续性锚点" : ""));
    }
    for (const s of skipped) console.log("    (仅搬桶) " + s.old + " → " + s.new + "：" + s.reason);
    console.log(apply ? "已写盘，备份: " + summary.backup : "（dry-run：未写任何文件；确认后加 --apply）");
  }
}

if (process.argv[1] && import.meta.url === new URL("file://" + resolve(process.argv[1])).href) {
  await main();
}
