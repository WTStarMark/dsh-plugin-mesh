#!/usr/bin/env node
/**
 * 改名去重（0.4.4）：把"改了名、图里还留着旧球"的仓库合并回一个。
 *
 * 为什么会新旧并存：GitHub 改名后 full_name 变了，而累积索引/图数据以 full_name 为键。
 * 0.4.4 起采集记录里带上了 GitHub 的数字 id（githubId，改名不变），从此不会再新增重复；
 * 但对【已经存下来的老数据】，需要用这个工具做一次迁移。
 *
 * 判定链（每条都有据可查，不做"猜"）：
 *   ① 先按 githubId 找：同一数字 id 出现两次 → 铁定是同一个仓库
 *   ② 老记录没有 githubId：把"同作者 + 同创建时间"的节点当嫌疑组（created_at 不可变）
 *   ③ 对嫌疑节点逐個问 GitHub（GET /repos/{owner}/{name}，改名会自动跟到新名字）→ 拿到数字 id 与当前 full_name
 *   ④ 同一数字 id 的节点收敛成一个：保留"当前 full_name"那条，删掉旧名字那条，并记录改名历史
 *
 * 用法：
 *   node tools/dedupe-renames.mjs [--mesh data/mesh.json] [--dry]     # 修前端契约
 *   node tools/dedupe-renames.mjs --cache data/cache/repos.json [--dry] # 修累积索引（治本：下轮构建就不会再带重复）
 * 逐個顺序请求 GitHub（不并发）：几千个嫌疑节点也就几分钟，对接口更友好。
 * 产物：
 *   合并后的 mesh.json（原文件先备份成 data/mesh.json.bak-<时间戳>）+ data/renames.json（改名账本）
 */
import { readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 嫌疑分组：同作者 + 同创建时间（created_at 一旦创建就不再变，改名不会改它） */
export function findSuspects(nodes) {
  const byGithub = new Map();
  const byOwnerCreated = new Map();
  for (const n of nodes) {
    if (n.githubId !== undefined && n.githubId !== null) {
      const k = String(n.githubId);
      if (!byGithub.has(k)) byGithub.set(k, []);
      byGithub.get(k).push(n);
    }
    const k = String(n.owner ?? "?") + "|" + String(n.createdAt ?? "?");
    if (!byOwnerCreated.has(k)) byOwnerCreated.set(k, []);
    byOwnerCreated.get(k).push(n);
  }
  const sameId = [...byGithub.values()].filter((g) => g.length > 1);
  const sameStamp = [...byOwnerCreated.values()].filter((g) => g.length > 1);
  const ids = new Set();
  for (const g of [...sameId, ...sameStamp]) for (const n of g) ids.add(n.id);
  return { suspectIds: ids, sameId, sameStamp };
}

/**
 * 规划合并方案（纯逻辑，网络访问通过 resolve 注入，便于离线测试）。
 * resolve(id) → { githubId, fullName } | null
 */
export async function planRenames(nodes, resolveOne, { log = () => {} } = {}) {
  const { suspectIds } = findSuspects(nodes);
  const list = nodes.filter((n) => suspectIds.has(n.id));
  const identity = new Map(); // node.id → { githubId, fullName } | null
  let checked = 0;
  for (const n of list) {
    identity.set(n.id, await resolveOne(n));
    checked += 1;
    if (checked % 25 === 0) log("    …已核对 " + checked + "/" + list.length);
  }
  const clusters = new Map(); // githubId → [{node, ident}]
  const unresolved = [];
  const resolved = []; // 核对到的稳定身份，回填进数据（下次不必再问接口）
  for (const n of list) {
    const ident = identity.get(n.id);
    if (!ident || ident.githubId === undefined || ident.githubId === null) {
      unresolved.push(n.id);
      continue;
    }
    resolved.push({ id: n.id, githubId: ident.githubId, fullName: ident.fullName });
    const k = String(ident.githubId);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push({ node: n, ident });
  }
  const drops = [];
  const renames = [];
  const updates = []; // 只有旧名字在数据里：就地改名（不删节点）
  const existing = new Set(nodes.map((n) => n.id.toLowerCase()));
  for (const [githubId, group] of clusters) {
    if (group.length < 2) {
      const only = group[0];
      const target = String(only.ident.fullName ?? "");
      if (!target || target.toLowerCase() === only.node.id.toLowerCase()) continue;
      // 目标名字已经被别的节点占了 → 冲突，交给下一轮（不动，避免撞 id）
      if (existing.has(target.toLowerCase()) && target.toLowerCase() !== only.node.id.toLowerCase()) continue;
      updates.push({ from: only.node.id, to: target, githubId: Number(githubId) });
      continue;
    }
    // 保留"当前 full_name"的那条；都不匹配时保留最近推送的
    const canonical =
      group.find((g) => g.node.id.toLowerCase() === String(g.ident.fullName).toLowerCase()) ??
      [...group].sort((a, b) => String(b.node.pushedAt ?? "").localeCompare(String(a.node.pushedAt ?? "")))[0];
    for (const g of group) {
      if (g.node.id === canonical.node.id) continue;
      drops.push(g.node.id);
      renames.push({ from: g.node.id, to: canonical.node.id, githubId: Number(githubId) });
    }
  }
  return { drops, renames, updates, unresolved, resolved, checked, suspects: list.length };
}

/** 真的去问 GitHub：/repos/{owner}/{name} 会自动跟随改名 */
function makeResolver(token) {
  const headers = { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "mesh-dedupe" };
  return async (node) => {
    try {
      const res = await fetch("https://api.github.com/repos/" + node.id, { headers });
      if (!res.ok) return null; // 404（已删/不可见）、403（限流）都当"这次认不出"
      const json = await res.json();
      return { githubId: json.id, fullName: json.full_name };
    } catch {
      return null;
    }
  };
}

/** 缓存模式：累积索引 {updatedAt,count,repos:{键:记录}} —— 治本，改完下一轮构建就没有重复了 */
/** 有没有采集器正在跑？它在内存里存着整份索引，我们边跑边改会被它的定期保存覆盖。 */
async function collectorRunning() {
  try {
    const { readdir, readFile: rf } = await import("node:fs/promises");
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = (await rf("/proc/" + pid + "/cmdline", "utf8")).replace(/\0/g, " ");
        if (/collect\.py/.test(cmd) && !cmd.includes("dedupe-renames")) return pid;
      } catch {
        /* 进程刚好退出 */
      }
    }
  } catch {
    /* 非 Linux 或没权限：跳过检查 */
  }
  return null;
}

async function runCacheMode(cachePath, DRY, token) {
  const running = await collectorRunning();
  if (running && !process.argv.includes("--force")) {
    console.error("检测到采集器正在运行（pid " + running + "）：它会在每 5 段/每轮结束时把内存里的旧索引写回磁盘，");
    console.error("现在改会被覆盖。请先停采集器（pm2 stop dsh-mesh-collector）再跑本工具，确认无误后可用 --force 跳过此检查。");
    process.exit(3);
  }
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  const repos = cache.repos ?? {};
  const records = Object.values(repos);
  const before = records.length;
  const { suspectIds, sameId, sameStamp } = findSuspects(records);
  console.log("累积索引 " + before + " 条 | 同 githubId 重复组 " + sameId.length + " | 同作者+同创建时间嫌疑组 " + sameStamp.length + " | 待核对 " + suspectIds.size);
  const plan = await planRenames(records, makeResolver(token), { log: console.log });
  console.log("核对完成：合并 " + plan.renames.length + " 对、就地改名 " + plan.updates.length + " 个，认不出 " + plan.unresolved.length + " 个");
  for (const r of plan.renames.slice(0, 30)) console.log("   合并 " + r.from + "  →  " + r.to);
  for (const u of plan.updates.slice(0, 30)) console.log("   改名 " + u.from + "  →  " + u.to);
  if (DRY) {
    console.log("（--dry：不写文件）");
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  await copyFile(cachePath, cachePath.replace(/\.json$/, "") + ".bak-" + stamp + ".json");
  const drop = new Set(plan.drops);
  const idMap = new Map(plan.updates.map((u) => [u.from, u.to]));
  const gidOf = new Map(plan.resolved.map((r) => [r.id, r.githubId]));
  const renamedTo = new Map([...idMap.entries()].map(([from, to]) => [to, from]));
  const out = {};
  let rekeyed = 0;
  let backfilled = 0;
  for (const [key, rec] of Object.entries(repos)) {
    if (drop.has(rec.id) || drop.has(key)) continue;
    const to = idMap.get(rec.id);
    const finalId = to ?? rec.id;
    const gid = gidOf.get(rec.id) ?? gidOf.get(renamedTo.get(finalId) ?? "");
    const next = { ...rec, id: finalId, name: finalId.split("/")[1] ?? rec.name, htmlUrl: "https://github.com/" + finalId };
    if (gid !== undefined && next.githubId === undefined) {
      next.githubId = gid;
      backfilled += 1;
    }
    if (to) rekeyed += 1;
    out[finalId] = next;
  }
  const json = JSON.stringify({ updatedAt: new Date().toISOString(), count: Object.keys(out).length, repos: out });
  const tmp = cachePath + ".tmp";
  await writeFile(tmp, json, "utf8");
  await rename(tmp, cachePath);
  console.log("累积索引 " + before + " → " + Object.keys(out).length + "（删除旧名 " + drop.size + "、就地改名 " + rekeyed + "、回填 githubId " + backfilled + "）");
  console.log("备份: " + cachePath.replace(ROOT + "/", "") + ".bak-" + stamp + ".json");

  // 写别名表：采集器下次加载/合并时会按它把旧名归一，避免搜索索引延迟又把旧名带回来
  const aliasPath = resolve(dirname(cachePath), "aliases.json");
  let aliasDoc = { aliases: {} };
  try {
    aliasDoc = JSON.parse(await readFile(aliasPath, "utf8"));
  } catch {
    /* 首次 */
  }
  const aliases = { ...(aliasDoc.aliases ?? {}) };
  // 历史上（本功能上线前）做过的改名也要并进来：它们只记在账本里，
  // 否则采集器遇到那些旧名字时仍然认不出来（EAC 那几对就是这么漏掉的）。
  try {
    const ledger = JSON.parse(await readFile(resolve(ROOT, "data/renames.json"), "utf8"));
    for (const r of [...(ledger.renames ?? []), ...(ledger.renamesInPlace ?? [])]) aliases[r.from] = r.to;
  } catch {
    /* 没有账本就只写本次的 */
  }
  for (const r of [...plan.renames, ...plan.updates]) aliases[r.from] = r.to;
  // 链式别名归一：A→B、B→C 时把 A 直接指到 C
  const resolveAlias = (to) => {
    let cur = to;
    for (let i = 0; i < 5 && aliases[cur]; i++) cur = aliases[cur];
    return cur;
  };
  for (const k of Object.keys(aliases)) aliases[k] = resolveAlias(aliases[k]);
  await writeFile(aliasPath, JSON.stringify({ updatedAt: new Date().toISOString(), aliases }, null, 1), "utf8");
  console.log("别名表: " + aliasPath.replace(ROOT + "/", "") + "（共 " + Object.keys(aliases).length + " 条，采集器会按它把旧名归一）");
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i > -1 ? argv[i + 1] : fallback;
  };
  const CACHE = argv.includes("--cache") ? resolve(ROOT, argOf("--cache", "data/cache/repos.json")) : null;
  const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
  const DRY = argv.includes("--dry");
  const token = (/^GITHUB_TOKEN=(.+)$/m.exec(await readFile(resolve(ROOT, ".env"), "utf8")) ?? [])[1];
  if (!token) throw new Error("没有读到 GITHUB_TOKEN");

  if (CACHE) {
    await runCacheMode(CACHE, DRY, token);
    return;
  }
  const mesh = JSON.parse(await readFile(MESH, "utf8"));
  const nodes = mesh.nodes ?? [];
  const before = nodes.length;
  const { suspectIds, sameId, sameStamp } = findSuspects(nodes);
  console.log("节点 " + before + " 个 | 同 githubId 的重复组 " + sameId.length + " | 同作者+同创建时间的嫌疑组 " + sameStamp.length + " | 待核对节点 " + suspectIds.size);

  const resolver = makeResolver(token);
  const plan = await planRenames(nodes, resolver, { log: console.log });
  console.log(
    "核对完成：" + plan.checked + " 个节点，识别出改名合并 " + plan.renames.length + " 对、就地改名 " + plan.updates.length +
      " 个，认不出 " + plan.unresolved.length + " 个",
  );
  for (const r of plan.renames.slice(0, 40)) console.log("   合并 " + r.from + "  →  " + r.to);
  for (const u of plan.updates.slice(0, 40)) console.log("   改名 " + u.from + "  →  " + u.to);

  // 除了合并/改名，还要把核对到的 githubId 回填进数据（下次不必再问接口）
  const needBackfill = plan.resolved.some((r) => {
    const n = nodes.find((x) => x.id === r.id);
    return n && n.githubId === undefined;
  });
  if (plan.drops.length === 0 && plan.updates.length === 0 && !needBackfill) {
    console.log("没有需要合并的重复节点，也没有可回填的身份 ✅");
    return;
  }
  if (DRY) {
    if (argv.includes("--json")) console.log(JSON.stringify(plan, null, 1));
    else console.log("（--dry：不写文件）");
    return;
  }

  const drop = new Set(plan.drops);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const backup = MESH.replace(/\.json$/, "") + ".bak-" + stamp + ".json";
  await copyFile(MESH, backup);
  mesh.nodes = nodes.filter((n) => !drop.has(n.id));
  // 就地改名：节点 id、名字、链接与所有引用它的边一起改
  const idMap = new Map(plan.updates.map((u) => [u.from, u.to]));
  // 回填稳定身份：核对过的节点都带上 githubId（就地改名的目标 id 也算）
  const renamedTo = new Map([...idMap.entries()].map(([from, to]) => [to, from]));
  const gidOf = new Map(plan.resolved.map((r) => [r.id, r.githubId]));
  let backfilled = 0;
  for (const n of mesh.nodes) {
    const gid = gidOf.get(n.id) ?? gidOf.get(renamedTo.get(n.id) ?? "");
    if (gid !== undefined && n.githubId === undefined) {
      n.githubId = gid;
      backfilled += 1;
    }
  }
  mesh.meta.githubIdBackfilled = backfilled;
  for (const n of mesh.nodes) {
    const to = idMap.get(n.id);
    if (!to) continue;
    n.id = to;
    n.name = to.split("/")[1] ?? n.name;
    n.htmlUrl = "https://github.com/" + to;
  }
  const seenEdge = new Set();
  mesh.edges = (mesh.edges ?? [])
    .map((e) => ({ ...e, source: idMap.get(e.source) ?? e.source, target: idMap.get(e.target) ?? e.target }))
    .filter((e) => {
      if (drop.has(e.source) || drop.has(e.target)) return false;
      if (e.source === e.target) return false; // 改名后可能撞成自环
      const key = e.type + "|" + e.source + "|" + e.target;
      if (seenEdge.has(key)) return false; // 改名后可能与已有边重复
      seenEdge.add(key);
      return true;
    });
  // 账本累积，不覆盖：第二次只回填身份时，不该把第一次的改名记录抹掉
  const mergeBy = (old, fresh) => {
    const by = new Map((old ?? []).map((r) => [r.from + "→" + r.to, r]));
    for (const r of fresh) by.set(r.from + "→" + r.to, r);
    return [...by.values()];
  };
  mesh.meta.renames = mergeBy(mesh.meta.renames, plan.renames);
  mesh.meta.renamesInPlace = mergeBy(mesh.meta.renamesInPlace, plan.updates);
  mesh.meta.renamedMerged = mesh.meta.renames.length;
  mesh.meta.renamedInPlace = mesh.meta.renamesInPlace.length;
  mesh.meta.sampleNodes = mesh.nodes.length;
  mesh.meta.sampleEdges = mesh.edges.length;
  // 删掉的是索引里的仓库，完整索引规模也要跟着减（否则分类统计与索引数对不上）
  const indexed = mesh.meta.indexedNodes ?? before;
  mesh.meta.indexedNodes = Math.max(mesh.nodes.length, indexed - drop.size);
  await writeFile(MESH, JSON.stringify(mesh), "utf8");
  // 账本按 from→to 合并历史，而不是覆盖：多次运行的记录都留着才可审计
  const ledgerPath = resolve(ROOT, "data/renames.json");
  let ledger = { renames: [], renamesInPlace: [] };
  try {
    ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch {
    /* 首次运行没有账本 */
  }
  const mergeLedger = (old, fresh) => {
    const by = new Map((old ?? []).map((r) => [r.from + "→" + r.to, r]));
    for (const r of fresh) by.set(r.from + "→" + r.to, r);
    return [...by.values()];
  };
  await writeFile(
    ledgerPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mesh: MESH.replace(ROOT + "/", ""),
        renames: mergeLedger(ledger.renames, plan.renames),
        renamesInPlace: mergeLedger(ledger.renamesInPlace, plan.updates),
      },
      null,
      1,
    ),
    "utf8",
  );
  console.log(
    "节点 " + before + " → " + mesh.nodes.length + "（删除旧名节点 " + drop.size + " 个，就地改名 " + idMap.size +
      " 个，回填 githubId " + backfilled + " 个）",
  );
  console.log("备份: " + backup.replace(ROOT + "/", "") + " | 账本: data/renames.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
