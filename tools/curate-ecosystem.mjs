#!/usr/bin/env node
/**
 * 生态共鸣策展工具（可复跑）—— 产出 data/ecosystem.json。
 * 「生态共鸣」是人工确认过的生态关系（谁长在谁上面），不是规则推导，所以每条边都要有可复核的证据链：
 *   ① 生态签 ② 名字/描述自述 ③ GitHub 搜 README 提到基座 ④ 真抓 README 复核，且提法必须处于
 *   「依赖/扩展/适配」语境（只在 README 里被顺带提一句的不算生态关系；生态签不存在的基座只能靠 README 复核）。
 * enabled: false 的基座仍然策展与复核，只是不建共鸣边，基座身份不受影响。
 * 用法：node tools/curate-ecosystem.mjs [--mesh dist/live-mesh.json] [--out tools/ecosystem.json] [--dry]
 * 令牌从 .env 的 GITHUB_TOKEN 读（只用于 GitHub API，不打印）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveAnchors, readEcosystem } from "./admin-config.mjs";
import { CONTEXT_RULES, DEFAULT_CONTEXT } from "./ecosystem-bases.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
// 产物放 tools/ 而不是 data/：部署脚本明确不同步 data/（远端有自己的数据），而这份策展清单必须随代码一起到远端。
const OUT = resolve(ROOT, argOf("--out", "tools/ecosystem.json"));
const DRY = argv.includes("--dry");

/**
 * 锚定条件来源：后台管理副本优先（运营可能改过），没有才用手写内置定义（tools/ecosystem-bases.mjs），
 * 这样「后台改条件 → 重跑策展 → 按新条件重新发现子节点」才是一条完整链路。
 */
const ecosystemSource = readEcosystem();
const BASES = effectiveAnchors(ecosystemSource.doc);
console.log(
  "锚定条件来源: " +
    (ecosystemSource.managed ? "data/admin/ecosystem.json（后台管理副本）" : "内置定义 tools/ecosystem-bases.mjs") +
    "，共 " +
    BASES.length +
    " 个基座",
);

const token = (/^GITHUB_TOKEN=(.+)$/m.exec(await readFile(resolve(ROOT, ".env"), "utf8")) ?? [])[1];
if (!token) throw new Error("没有读到 GITHUB_TOKEN");
const HEADERS = { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "mesh-ecosystem-curator" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mesh = JSON.parse(await readFile(MESH, "utf8"));
const byId = new Map(mesh.nodes.map((n) => [n.id.toLowerCase(), n]));

async function searchByReadme(probe) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent('"' + probe + '" in:readme') +
    "&per_page=100";
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn("  搜索失败 " + probe + " → HTTP " + res.status);
    return [];
  }
  const json = await res.json();
  return (json.items ?? []).map((i) => i.full_name.toLowerCase());
}

/** "长在它上面"的语境规则：命名预设来自 tools/ecosystem-bases.mjs（后台可改选的也是这几个） */

async function readmeMentions(id, base) {
  const res = await fetch("https://api.github.com/repos/" + id + "/readme", {
    headers: { ...HEADERS, accept: "application/vnd.github.raw" },
  });
  if (!res.ok) return null;
  const text = (await res.text()).toLowerCase();
  const needles = [base.id.toLowerCase(), ...(base.packages ?? []).map((p) => p.toLowerCase())];
  for (const needle of needles) {
    // 词边界匹配：dsh-stddev / dsh-stdlib 这类"包含"不算提到 dsh-std（实测踩过这个坑）
    const re = new RegExp("(^|[^a-z0-9_-])" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9_-]|$)", "i");
    const m = re.exec(text);
    if (!m) continue;
    const at = m.index + m[1].length;
    const around = text.slice(Math.max(0, at - 140), at + 140);
    const rule = CONTEXT_RULES[base.context] ?? CONTEXT_RULES[DEFAULT_CONTEXT];
    return { needle, chars: text.length, depend: rule.re.test(around) };
  }
  return null;
}

const out = { generatedAt: new Date().toISOString(), mesh: MESH.replace(ROOT + "/", ""), bases: [] };
for (const base of BASES) {
  console.log("=== " + base.id + "（" + base.label + (base.tag ? " · 生态签 " + base.tag : " · 无生态签") + "）===");
  const cand = new Map();
  const baseIds = new Set(BASES.map((b) => b.id.toLowerCase()));
  const add = (id, why) => {
    const key = id.toLowerCase();
    if (key === base.id.toLowerCase()) return;
    if (baseIds.has(key)) return; // 基座之间不互相算"生态子节点"
    if (!byId.has(key)) return; // 只给"图里真实存在的节点"建边
    const node = byId.get(key);
    // 目录/导航类（category === "market"）会在 README 里提到几乎所有插件，那是「收录」不是生态关系；只认「插件的目录」这种语义，不能见到 directory 就排（文件管理插件天天写目录）。
    if (node.category === "market") return;
    if (/(awesome|registry|catalog|合集|汇总|导航|大全|清单|收录)/i.test(node.name ?? "")) return;
    const blurb = String(node.description ?? "") + " " + String(node.name ?? "");
    if (/(plugin|插件|生态)[^。\n]{0,8}(directory|catalog|registry|index|目录|索引|清单|导航|合集)|(directory|catalog|registry|index|目录|索引|清单|导航|合集)[^。\n]{0,8}(of|for)?\s*(plugins|插件)/i.test(blurb)) return;
    if (!cand.has(key)) cand.set(key, { id: node.id, signals: [] });
    const entry = cand.get(key);
    if (!entry.signals.includes(why)) entry.signals.push(why);
  };

  if (base.tag) for (const n of mesh.nodes) if ((n.topics ?? []).some((t) => String(t).toLowerCase() === base.tag)) add(n.id, "生态签:" + base.tag);
  for (const n of mesh.nodes) {
    const text = (n.name ?? "") + " " + (n.description ?? "");
    if (base.probes.some((p) => new RegExp(p.replace(/[-]/g, "[-_]?"), "i").test(text))) add(n.id, "名字/描述提及");
  }
  for (const probe of base.probes) {
    const ids = await searchByReadme(probe);
    for (const id of ids) add(id, "README搜索:" + probe);
    await sleep(1200);
  }
  console.log("  候选（图内、已排除目录类）: " + cand.size);

  const verified = [];
  let checked = 0;
  for (const entry of cand.values()) {
    const mention = await readmeMentions(entry.id, base);
    checked += 1;
    const hasTag = base.tag ? entry.signals.some((s) => s.startsWith("生态签")) : false;
    // README 必须把它写成「依赖/扩展/在用它的格式」才算数：实测有仓库把生态签当曝光标签挂着，正文只是「兼容」一笔带过。
    if (mention && mention.depend) {
      verified.push({
        id: entry.id,
        signals: entry.signals,
        readme: mention.needle,
        depend: mention.depend,
        stars: byId.get(entry.id.toLowerCase())?.stars ?? 0,
      });
    }
    if (checked % 25 === 0) console.log("    …已复核 " + checked + "/" + cand.size);
    await sleep(120);
  }
  verified.sort((a, b) => b.stars - a.stars);
  console.log("  ① 生态签/② 名字/③ 搜索 + ④ README 复核通过: " + verified.length);
  console.log("  " + verified.slice(0, 14).map((v) => v.id).join(", ") + (verified.length > 14 ? " …" : ""));
  // 锚定条件一并写进产物：清单从此自带"它是按什么找出来的"，后台也能直接展示/复跑
  out.bases.push({
    id: base.id,
    label: base.label,
    tag: base.tag ?? null,
    enabled: base.enabled !== false,
    probes: [...(base.probes ?? [])],
    packages: [...(base.packages ?? [])],
    context: base.context ?? DEFAULT_CONTEXT,
    verified,
  });
}

out.note = "生态共鸣是人工确认的生态关系（基座 → 长在它上面的插件），不参与自动分类规则；判据见 tools/curate-ecosystem.mjs 顶部注释。";
if (DRY) {
  console.log("\n（--dry：不写文件）");
  console.log(JSON.stringify(out.bases.map((b) => ({ id: b.id, count: b.verified.length })), null, 1));
} else {
  await writeFile(OUT, JSON.stringify(out, null, 1), "utf8");
  console.log("\n写入 " + OUT.replace(ROOT + "/", "") + "：" + out.bases.map((b) => b.id + "→" + b.verified.length).join(" · "));
}
