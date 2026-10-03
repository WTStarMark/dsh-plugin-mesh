#!/usr/bin/env node
/**
 * 生态共鸣策展工具（可复跑）——产出 data/ecosystem.json。
 *
 * 「生态共鸣」不是规则推导出来的边，而是【人工确认过的生态关系】：
 * 某几个"基座"仓库（侧边栏底座 / TUI / 皮肤框架）会引出一整片插件生态，
 * 这条边就是"谁长在谁上面"。既然不靠规则，就必须有可复核的证据链。
 *
 * 策展流程（多重校验，任一单点都不算数）：
 *   ① 生态签：候选仓库的 topics 里带着该基座的生态签（如 dsh-better-sidebar）
 *   ② 名字/描述：候选的 name/description 直接提到基座短名
 *   ③ GitHub 搜索：README 里提到基座（"<id>" in:readme）
 *   ④ README 复核：真的把候选仓库的 README 抓下来，确认里面提到基座的 owner/name 或包名
 * 入库条件（多重校验，缺一不可）：
 *   - 归属信号：带生态签（如 dsh-better-sidebar）或名字/描述自述属于该基座
 *   - README 复核：README 里真的提到该基座，且提法处于"依赖/扩展/适配"语境
 *     （只在 README 里被顺带提一句的，例如桌面客户端因为兼容而列了它，不算生态关系）
 *   生态签不存在的基座（如 dsh-tui-ecosystem 目前 GitHub 上 0 个仓库）就只能靠后者，
 *   这也正是"不要仅靠生态签定位"的原因。
 *
 * enabled: false 的基座【仍然策展与复核】，只是管线不建共鸣边（临时关闭用，可随时改回）。
 * 注意：基座身份（归入协议基座）不受 enabled 影响 —— 关的是"共鸣边"，不是"它是基座"。
 *
 * 用法：
 *   node tools/curate-ecosystem.mjs [--mesh dist/live-mesh.json] [--out tools/ecosystem.json] [--dry]
 * 令牌从 .env 的 GITHUB_TOKEN 读（只用于 GitHub API，不打印）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const MESH = resolve(ROOT, argOf("--mesh", "data/mesh.json"));
// 注意：产物放在 tools/ 而不是 data/ —— 部署脚本明确不同步 data/（远端有自己的数据），
// 而这份策展清单必须随代码一起到远端，否则线上就没有生态共鸣边。
const OUT = resolve(ROOT, argOf("--out", "tools/ecosystem.json"));
const DRY = argv.includes("--dry");

/** 基座清单：id + 生态签 + 用于搜索/匹配的探针词 */
const BASES = [
  {
    id: "omdsh-dev/DSH-better-sidebar",
    label: "侧边栏底座",
    tag: "dsh-better-sidebar",
    probes: ["dsh-better-sidebar"],
    packages: ["dsh-better-sidebar"],
  },
  {
    id: "ccch1mneyyy/dsh-TUI",
    label: "TUI 基座",
    tag: "dsh-tui-ecosystem",
    probes: ["dsh-tui", "dsh-tui-ecosystem"],
    packages: ["@deepseek-harness-tui/dsh-tui", "dsh-tui"],
  },
  {
    id: "T-Auto/dsh-std",
    label: "互操作元协议",
    tag: null, // 规范类基座同样没有生态签：靠"谁的 README 在遵循它"来定位
    probes: ["dsh-std"],
    packages: ["dsh-std"],
    // 规范类基座的提法不是"依赖"而是"遵循/实现/对齐"
    contextRe: /(遵循|遵从|符合|依照|参考|实现|采用|基于|依赖|兼容|对齐|conform|comply|follow|adopt|implement|based\s+on|compatible)/i,
  },
  {
    id: "T-Auto/dsh-ecosystem-spec",
    label: "生态共识规范",
    tag: null,
    probes: ["dsh-ecosystem-spec"],
    packages: ["dsh-ecosystem-spec"],
    contextRe: /(遵循|遵从|符合|依照|参考|实现|采用|基于|依赖|兼容|对齐|conform|comply|follow|adopt|implement|based\s+on|compatible)/i,
  },
  {
    id: "WTStarMark/dsh-myskin",
    label: "皮肤框架",
    // 暂时关闭它的生态共鸣（2026-10：用户要求）。放在这里而不是删掉：
    // 证据与子节点照旧策展、照旧复核，只是管线不建边；改回 true 即可恢复。
    enabled: false,
    tag: null, // 这个基座没有生态签：只能靠 README 提到它自己或它的皮肤包格式 .dshskin
    probes: ["dsh-myskin", "dshskin"],
    packages: ["dsh-myskin", ".dshskin"],
    // 皮肤包格式的语境：必须是"导入/导出/格式/皮肤包"这种在用它，
    // 光是路径里出现 dshskin 目录、或者一个叫 dshskin.exe 的二进制，都不算
    contextRe: /(导入|导出|import|export|格式|format|皮肤包|skin\s*(file|pack)|payload|换肤|url\s*scheme)/i,
  },
];

const token = (/^GITHUB_TOKEN=(.+)$/m.exec(await readFile(resolve(ROOT, ".env"), "utf8")) ?? [])[1];
if (!token) throw new Error("没有读到 GITHUB_TOKEN");
const HEADERS = { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "mesh-ecosystem-curator" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mesh = JSON.parse(await readFile(MESH, "utf8"));
const byId = new Map(mesh.nodes.map((n) => [n.id.toLowerCase(), n]));

/** ③ GitHub 仓库搜索：README 里提到这些词 */
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

/** "长在它上面"的语境：依赖 / 扩展 / 适配 / 基于 —— 只提一句名字不算 */
const DEPEND_RE =
  /(基于|依赖|需要|配合|搭配|集成|适配|内嵌|内置|安装|前置|built\s+on|based\s+on|depends?\s+on|requires?|powered\s+by|extends?|extension\s+for|plugin\s+for|addon|wrapper|compatible\s+with|integrat)/i;

/** ④ README 复核：抓真实 README，确认提到基座，并判断提法是不是"依赖/扩展"语境 */
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
    return { needle, chars: text.length, depend: (base.contextRe ?? DEPEND_RE).test(around) };
  }
  return null;
}

const out = { generatedAt: new Date().toISOString(), mesh: MESH.replace(ROOT + "/", ""), bases: [] };
for (const base of BASES) {
  console.log("=== " + base.id + "（" + base.label + (base.tag ? " · 生态签 " + base.tag : " · 无生态签") + "）===");
  const cand = new Map(); // id -> signals[]
  const baseIds = new Set(BASES.map((b) => b.id.toLowerCase()));
  const add = (id, why) => {
    const key = id.toLowerCase();
    if (key === base.id.toLowerCase()) return;
    if (baseIds.has(key)) return; // 基座之间不互相算"生态子节点"
    if (!byId.has(key)) return; // 只给"图里真实存在的节点"建边
    const node = byId.get(key);
    // 目录/导航类会在 README 里提到几乎所有插件，那是"收录"不是"生态关系"，排除。
    // 注意只认"插件的目录"这种语义，不能见到 directory 就排（文件管理插件天天写目录/directory）。
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
    // 判定：README 必须把它写成"依赖/扩展/在用它的格式"，光挂生态签不够 ——
    // 实测有仓库把 dsh-better-sidebar 当曝光标签挂着，正文里只是"兼容/支持"一笔带过。
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
  out.bases.push({ id: base.id, label: base.label, tag: base.tag ?? null, enabled: base.enabled !== false, verified });
}

out.note = "生态共鸣是人工确认的生态关系（基座 → 长在它上面的插件），不参与自动分类规则；判据见 tools/curate-ecosystem.mjs 顶部注释。";
if (DRY) {
  console.log("\n（--dry：不写文件）");
  console.log(JSON.stringify(out.bases.map((b) => ({ id: b.id, count: b.verified.length })), null, 1));
} else {
  await writeFile(OUT, JSON.stringify(out, null, 1), "utf8");
  console.log("\n写入 " + OUT.replace(ROOT + "/", "") + "：" + out.bases.map((b) => b.id + "→" + b.verified.length).join(" · "));
}
