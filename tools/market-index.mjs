#!/usr/bin/env node
/**
 * market-index —— 把生态图里「确实是 DSH 组合包」的那部分，生成一份插件市场索引（format 1）。
 *
 * 用法：
 *   node tools/market-index.mjs [--limit 200] [--refresh] [--out dist/market/index.json]
 *
 * 数据来源：
 *   · data/cache/npm-downloads.json —— 仓库 ↔ npm 包名（采集器写）
 *   · data/mesh.json                —— 分类、星标、描述、头像（前端数据）
 *   · registry.npmjs.org            —— 版本列表与发布时间（本脚本自己抓，缓存在 data/cache/npm-registry.json）
 *
 * 取舍（为什么这么做）：
 *   · 只收「依赖或同伴依赖里有 @deepseek-ai/*」的包 —— 这是「它真的是 DSH 插件」最便宜、最可验证的信号。
 *     不是的（纯工具、同名巧合）一律不进索引：市场索引等于一键安装清单，宁缺毋滥。
 *   · 版本只留最近几个（默认 5 个），publishTimestamp 取 registry 的 time；没有发布时间就整个包不要 ——
 *     索引格式要求整数秒，编一个时间戳比少一个包更糟。
 *   · 整个 engines 字段都不写：DSH 的校验器把这一项当可选（缺失时自己补 {}），写上就是纯体积。
 *     仍然不猜 engines.dsh：我们只有 cordis 的同伴依赖范围，推不出 DSH 版本范围，空 = 不限制。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "dsh-plugin-mesh-market-index/0.1 (+https://github.com/WTStarMark/dsh-plugin-mesh)";

/* 打包文档最大字节数：billion-context 那种 4500 个版本的包单文档 16MB，抓下来只为 5 个时间戳不划算。
 * 超限的包直接跳过并在结尾列出来——跳过是可见的，编造是不可接受的。 */
const PACKUMENT_MAX_BYTES = 6 * 1024 * 1024;
const REGISTRY_TTL_MS = 24 * 3600 * 1000;
/* 缓存格式版本：改了"怎么读 packument"就必须改这个数，否则老记录会被当新记录复用
 * （线上实测：把 devDependencies 纳入判定后，缓存里的旧记录让 @xmanrui/dsh-im 继续被漏掉）。 */
const CACHE_VERSION = 3;
const VERSIONS_KEPT = 5;
const DSH_SCOPE = "@deepseek-ai/";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Number(argOf("limit", 200)) || 200;
const REFRESH = argv.includes("--refresh");
const OUT = resolve(ROOT, argOf("out", "dist/market/index.json"));

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const toUnixSeconds = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/* 索引要求严格 SemVer：registry 里偶尔混进非 semver 的版本串，一律丢掉 */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * 描述开头的人气前缀：只放两个数字（★ 星标 · 周下载），不放「周下载」这几个字。
 * 理由见下面 entry.description 处的注释：DSH 把 description 当检索字段，中文词会被切进每个插件的检索词里。
 */
export function toneOf(stars, hasDownloads, downloads) {
  return "★" + shortNumber(stars) + " · " + (hasDownloads ? shortNumber(downloads) : "—");
}

/** 版本条目：不写 engines —— DSH 校验器对它是 optional(...) ?? {}，缺失自动补空对象，写上是纯体积。 */
export function versionEntries(versions) {
  return versions.map((v) => ({ version: v.version, publishTimestamp: v.ts, source: { type: "npm" } }));
}

/** 大数缩写：1234 → 1.2k、160042 → 160k、1200000 → 1.2M（榜单里也是这把尺子）。 */
function shortNumber(value) {
  const v = Number(value) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/u, "") + "M";
  if (v >= 1e4) return Math.round(v / 1e3) + "k";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/u, "") + "k";
  return String(v);
}

/** 把 npm 的 repository 字段或仓库网页地址收成 "owner/repo"（小写）——用来判断"这个包其实住在哪个仓库"。 */
function repoKey(value) {
  if (!value) return null;
  let url = typeof value === "string" ? value : value.url;
  if (typeof url !== "string" || !url) return null;
  url = url
    .trim()
    .replace(/^git\+/u, "")
    .replace(/^git@github\.com:/iu, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//iu, "https://github.com/")
    .replace(/^git:\/\//iu, "https://")
    .replace(/\.git$/u, "");
  const hit = /github\.com\/([^/?#]+)\/([^/?#]+)/iu.exec(url);
  return hit ? (hit[1] + "/" + hit[2]).toLowerCase() : null;
}

/** 带体积上限的 GET：超限就中止，返回 {tooLarge:true} */
async function fetchJsonCapped(url, cap) {
  const res = await fetch(url, {
    // accept-encoding: npm 的 packument 压缩后只有十分之一上下 —— 抓近万个包，这一行省几个 GB
    headers: { accept: "application/json", "accept-encoding": "gzip, deflate", "user-agent": UA },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) return { error: "HTTP " + res.status, status: res.status };
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) {
    try { await res.body?.cancel(); } catch { /* 关不掉也无所谓 */ }
    return { tooLarge: true, bytes: declared };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > cap) {
      try { await res.body.cancel(); } catch { /* 同上 */ }
      return { tooLarge: true, bytes: total };
    }
    chunks.push(chunk);
  }
  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes: total };
  } catch {
    return { error: "不是合法 JSON" };
  }
}

/** 从一份 packument 里抽出索引要的东西；不够用就返回 {skip: 原因} */
function readPackument(doc) {
  if (!doc || typeof doc !== "object" || !doc.versions || !doc.time) return { skip: "没有 versions/time" };
  const latestTag = doc["dist-tags"]?.latest ?? null;
  const rows = [];
  for (const [version, at] of Object.entries(doc.time)) {
    if (version === "created" || version === "modified") continue;
    if (!SEMVER.test(version)) continue;
    const ts = toUnixSeconds(at);
    if (ts === null) continue;
    rows.push({ version, ts, pre: version.includes("-") });
  }
  if (!rows.length) return { skip: "没有可用的版本时间" };
  // 优先稳定版；稳定版不足时再拿预发布兜底。validator 会自己按 semver 优先级排序，这里只负责"挑哪些"。
  const stable = rows.filter((r) => !r.pre);
  const pool = stable.length ? stable : rows;
  pool.sort((a, b) => b.ts - a.ts);
  const picked = pool.slice(0, VERSIONS_KEPT);
  if (latestTag && SEMVER.test(latestTag) && !picked.some((p) => p.version === latestTag)) {
    const hit = rows.find((r) => r.version === latestTag);
    if (hit) picked[picked.length - 1] = hit; // 最新版永远在
  }
  const latestFull = doc.versions[latestTag] ?? doc.versions[picked[0].version] ?? {};
  /* 「它是不是 DSH 组合包」的判定：最新版在 dependencies / peerDependencies / devDependencies 任一处
   * 声明了 @deepseek-ai/* 就算。devDependencies 也认，是因为线上实测有的插件只把 cordis 写在 dev 里
   * （@xmanrui/dsh-im 就是）；不认它就会漏掉真插件。索引格式本身无法验证组合包身份，这条只能靠生成器自律。 */
  const declared = {
    ...(latestFull.devDependencies ?? {}),
    ...(latestFull.peerDependencies ?? {}),
    ...(latestFull.dependencies ?? {}),
  };
  const dshKeys = Object.keys(declared).filter((k) => k.startsWith(DSH_SCOPE));
  /* 最硬的判据：作者自己在 package.json 里声明了 dsh.bundle.patch（组合包层）。
   * 有它就是组合包，没有也不能立刻否定（老包可能还没补这个字段）——所以它是"确证"，不是"唯一依据"。
   * 顺带把 dsh.client 记下来：有浏览器半边的组合包。 */
  const bundle = latestFull.dsh && typeof latestFull.dsh === "object" ? latestFull.dsh.bundle : null;
  const isBundle = !!(bundle && typeof bundle === "object" && typeof bundle.patch === "string" && bundle.patch.trim());
  const hasClient = !!(latestFull.dsh && typeof latestFull.dsh === "object" && latestFull.dsh.client);
  const repository = typeof latestFull.repository === "string" ? latestFull.repository : latestFull.repository?.url ?? null;
  const author = typeof latestFull.author === "string" ? latestFull.author : latestFull.author?.name ?? null;
  return { versions: picked, dshKeys, repository, author, latestTag, isBundle, hasClient, bundlePatch: isBundle ? bundle.patch : null };
}

async function loadRegistryCache() {
  const path = join(ROOT, "data", "cache", "npm-registry.json");
  const cached = readJson(path, null);
  if (cached && cached.packages && typeof cached.packages === "object") return { path, cache: cached };
  return { path, cache: { updatedAt: null, packages: {} } };
}

async function main() {
  // --mesh：默认本机前端数据；拿远端清单出索引时一并指向远端那份，避免"清单里有、画像里没有"被静默丢掉
  const meshPath = resolve(ROOT, argOf("mesh", "data/mesh.json"));
  const mesh = readJson(meshPath, null);
  // --npm-cache：默认读本机采集器的缓存；要拿远端的清单出索引时指向别处（远端那份更全）
  const npmCachePath = resolve(ROOT, argOf("npm-cache", "data/cache/npm-downloads.json"));
  const downloads = readJson(npmCachePath, null);
  if (!mesh?.nodes?.length) throw new Error("读不到 " + meshPath + "（先跑采集器或 npm run seed）");
  if (!downloads?.repos) throw new Error("读不到 " + npmCachePath);

  const byId = new Map(mesh.nodes.map((n) => [n.id, n]));
  const candidates = [];
  for (const [repoId, entry] of Object.entries(downloads.repos)) {
    if (entry?.status !== "ok" || !entry.package) continue;
    const node = byId.get(repoId);
    if (!node || node.archived) continue;
    candidates.push({
      repoId,
      node,
      pkg: String(entry.package),
      downloads: Number(entry.downloads) || 0,
      // 有包名但没拿到下载量（新发布的包 npm 还没统计）——展示时要写「—」，不能写成 0
      hasDownloads: typeof entry.downloads === "number",
    });
  }
  /* 同一个 npm 包常被「原仓库 + 一堆复刻」同时认领（远端实测：9080 个候选里 2142 个重名）。
   * 索引规定包名唯一，所以必须挑一个当门面 —— 挑法：优先非复刻 → 星标多 → 下载量多 → 仓库名。 */
  // rankOf：只在「同名认领者」之间挑门面时用（同一个包 downloads 相同，所以先看星标）。
  const rankOf = (item) => [item.node.fork ? 1 : 0, -(Number(item.node.stars) || 0), -item.downloads, item.repoId];
  // orderOf：索引的默认顺序 = 周下载量从高到低（"用的人多"最直观）；星标只当并列时的次序。
  const orderOf = (item) => [-item.downloads, item.node.fork ? 1 : 0, -(Number(item.node.stars) || 0), item.repoId];
  candidates.sort((a, b) => {
    const oa = orderOf(a);
    const ob = orderOf(b);
    for (let i = 0; i < oa.length; i += 1) {
      if (oa[i] < ob[i]) return -1;
      if (oa[i] > ob[i]) return 1;
    }
    return 0;
  });
  /* 不在这里按包名去重：同一个 npm 包常被几十个仓库同时认领（远端实测 dsh-desktop 被 91 个仓库认领）。
   * 认领者共用同一份 packument，多抓它们几乎不额外花钱；等 packument 到手，再用「npm 包自己声明的仓库」
   * 挑出真正的门面 —— 提前按下载量随便留一个，会把复刻/模板仓库当成正主展示。 */
  const picked = candidates.slice(0, LIMIT);
  console.log("候选（有下载量的仓库记录）: " + candidates.length + "，本轮处理: " + picked.length + "（--limit " + LIMIT + "）");

  const { path: cachePath, cache } = await loadRegistryCache();
  const now = Date.now();
  let fetched = 0, cacheHits = 0, tooLarge = 0, failed = 0, done = 0;

  /* 并发池。为什么要并发：全量要抓近万个 packument，一个一个来要几个小时。
   * 为什么要限并发 + 退避：线上实测 npm 会在突发请求后返回 429（Cloudflare 1015），
   * 越急越封——所以并发默认 6，遇 429 退到 8 秒起步再试。 */
  const concurrency = Math.max(1, Math.min(16, Number(argOf("concurrency", 6)) || 6));
  const writeRecord = (pkg, record) => {
    cache.packages[pkg] = { v: CACHE_VERSION, at: new Date().toISOString(), ...record };
    cache.updatedAt = new Date().toISOString();
  };
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= picked.length) return;
      const item = picked[index];
      const hit = cache.packages[item.pkg];
      if (hit && hit.v === CACHE_VERSION && !REFRESH && hit.at && now - Date.parse(hit.at) < REGISTRY_TTL_MS) {
        cacheHits += 1;
        continue;
      }
      const url = "https://registry.npmjs.org/" + encodeURIComponent(item.pkg).replace(/%40/gu, "@");
      let out = { error: "未开始" };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        out = await fetchJsonCapped(url, PACKUMENT_MAX_BYTES);
        if (!out.error) break;
        await sleep(out.status === 429 ? 8000 * (attempt + 1) : 1200 * (attempt + 1));
      }
      if (out.error) {
        writeRecord(item.pkg, { error: out.error });
        failed += 1;
      } else if (out.tooLarge) {
        writeRecord(item.pkg, { tooLarge: true, bytes: out.bytes ?? null });
        tooLarge += 1;
      } else {
        const read = readPackument(out.data);
        writeRecord(item.pkg, read.skip ? { skip: read.skip } : read);
        fetched += 1;
      }
      done += 1;
      if (done % 250 === 0) {
        console.log("   进度 " + done + "/" + picked.length + "（新抓 " + fetched + " · 缓存 " + cacheHits + " · 失败 " + failed + "）");
      }
      await sleep(80);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log("registry: 新抓 " + fetched + " · 命中缓存 " + cacheHits + " · 超大跳过 " + tooLarge + " · 失败 " + failed);

  /* ---- 组装索引 ---- */
  const categories = new Map();
  const labels = new Map();
  for (const n of mesh.nodes) {
    if (n.category && !categories.has(n.category)) {
      categories.set(n.category, { title: { en: n.category, zh: n.categoryLabel ?? n.category } });
    }
  }
  labels.set("dsh-bundle", { title: { en: "DSH bundle", zh: "DSH 组合包" } });
  labels.set("dsh-bundle-unconfirmed", { title: { en: "Likely bundle", zh: "疑似组合包" } });
  labels.set("has-client", { title: { en: "Has UI", zh: "带界面" } });

  const plugins = [];
  const skipReasons = new Map();
  const byPkg = new Map();
  for (const item of picked) {
    const rec = cache.packages[item.pkg];
    const why = !rec ? "没有记录" : rec.error ?? (rec.tooLarge ? "packument 超大" : rec.skip);
    if (why) { skipReasons.set(item.pkg, why); continue; }
    /* 判据：作者声明了 dsh.bundle.patch（确证）→ 收；没有 dsh 字段但依赖里有 @deepseek-ai/*（老包兜底）→ 也收，
     * 只是标成「疑似」。两条都没有才挡。 */
    const confirmed = rec.isBundle === true;
    const hinted = Array.isArray(rec.dshKeys) && rec.dshKeys.length > 0;
    if (!confirmed && !hinted) {
      skipReasons.set(item.pkg, "不是 DSH 组合包（既没声明 dsh.bundle，依赖里也没有 @deepseek-ai/*）");
      continue;
    }
    /* 官方内部模块不进第三方市场：@deepseek-ai/* 是 DSH 自身拆出来的包（@deepseek-ai/dsh 就是主程序本身），
     * 装进 profile 属于自残；而且它们真正的家在 deepseek-harness 单仓里，本图只能拿到"谁复制了这份 package.json"
     * —— 实测门面会落到 AlexKaiqi/dsh-client-locale 这种顶名仓库上。官方组合包走 DSH 自己的实验性插件入口。 */
    if (item.pkg.startsWith("@deepseek-ai/")) { skipReasons.set(item.pkg, "DSH 官方内部模块（走 DSH 自带入口，不进第三方市场）"); continue; }
    if (!byPkg.has(item.pkg)) byPkg.set(item.pkg, []);
    byPkg.get(item.pkg).push(item);
  }
  const compareRank = (x, y) => {
    const rx = rankOf(x);
    const ry = rankOf(y);
    for (let i = 0; i < rx.length; i += 1) {
      if (rx[i] < ry[i]) return -1;
      if (rx[i] > ry[i]) return 1;
    }
    return 0;
  };
  let mergedClaimants = 0;
  for (const [pkg, claimants] of byPkg) {
    const rec = cache.packages[pkg];
    /* 门面怎么挑：npm 包自己 repository 指的仓库最权威；没写或对不上，再退回「非复刻 → 星标多 → 下载量多」。 */
    const wanted = repoKey(rec.repository);
    const matched = wanted ? claimants.find((x) => repoKey(x.node.htmlUrl) === wanted) : null;
    const chosen = matched ?? claimants.slice().sort(compareRank)[0];
    if (claimants.length > 1) mergedClaimants += claimants.length - 1;
    const node = chosen.node;
    const repoUrl = typeof node.htmlUrl === "string" && /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+$/u.test(node.htmlUrl) ? node.htmlUrl : null;
    const entry = {
      name: pkg,
      title: node.name && node.name !== pkg ? node.name : undefined,
      /* 人气数字：索引格式里**没有"显示数字"的字段**（sortKeys 只进排序菜单，值不显示），
       * 而前端渲染的字段只有 标题 / 标签胶囊 / 描述 / 版本·作者·日期。描述是唯一能放自由文本的位，
       * 且列表里两行截断 —— 所以把数字放**开头**，放结尾会被截掉。
       * 为什么不做分档标签：实测这个生态 97.7% 的插件星标 <100、92% 周下载 <1000，分档会全挤在最低档，没有信息量。
       *
       * 只放数字，不放「周下载」三个字：DSH 的发现页把 description 当检索字段
       * （@deepseek-ai/dsh-plugin-market 的 MarketSearch：fields 含 description，boost 1），
       * 而它的分词把 CJK 串切成相邻二字对 ——「周下载」会切成 周下/下载/载 三个词，
       * 于是**每个**插件的描述都带上这三个词：实测搜「下载」命中全部 6589 个插件，一个常用词就这么废了。
       * 数字本身几乎无害（实测「8k」命中 23 个、「6」命中 199 个），而数字是这套格式里唯一能让用户
       * 看到"人气"的办法，所以保留数字、去掉中文词。数字的含义写在索引级 description 里（那段不进检索）。 */
      description: (() => {
        const tone = toneOf(node.stars, chosen.hasDownloads, chosen.downloads);
        const body = typeof node.description === "string" ? node.description.trim() : "";
        return body ? tone + " —— " + body : tone;
      })(),
      icon: typeof node.avatar === "string" && node.avatar.startsWith("https://") ? node.avatar : undefined,
      author: node.owner ?? undefined,
      repository: repoUrl ? { url: repoUrl } : undefined,
      metadata: {
        category: categories.has(node.category) ? node.category : undefined,
        keywords: Array.isArray(node.topics) ? node.topics.slice(0, 12).map(String) : [],
        labels: [
          rec.isBundle ? "dsh-bundle" : "dsh-bundle-unconfirmed",
          ...(rec.hasClient ? ["has-client"] : []),
        ],
        sortKeys: { stars: Number(node.stars) || 0, downloads: chosen.downloads },
      },
      /* 不写 engines：DSH 的校验器（@deepseek-ai/dsh-plugin-market-index 的 marketVersion）对这一项是
       * optional(...) ?? {}，缺失就补一个空对象 —— 写与不写完全等价，21852 个版本各带一个 "engines":{}
       * 纯属白送体积（原始约 280 KB）。 */
      versions: versionEntries(rec.versions),
    };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    if (entry.metadata.category === undefined) delete entry.metadata.category;
    plugins.push(entry);
  }

  /* 分类计数：索引格式里 category 声明**只有 title、没有计数字段**（前端 displayDeclarations 也只渲染 title），
   * 所以把数量直接写进标题 —— 界面上就是「安全权限 · 231」。这个数字是生成那一刻的快照。
   * 一个插件都没有的分类不声明：声明了前端会多出一个点了没结果的空筛选项。 */
  const categoryCounts = new Map();
  for (const plugin of plugins) {
    const id = plugin.metadata.category;
    if (id) categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
  }
  const declaredCategories = {};
  for (const [id, value] of categories) {
    const count = categoryCounts.get(id) ?? 0;
    if (!count) continue;
    declaredCategories[id] = { title: { en: value.title.en + " · " + count, zh: value.title.zh + " · " + count } };
  }

  const index = {
    format: 1,
    title: { en: "DSH Plugin Ecosystem · " + plugins.length, zh: "DSH 插件生态图 · " + plugins.length },
    description: {
      en: "Installable DSH plugin bundles catalogued by the dsh-plugin-mesh ecosystem graph. The two numbers at the start of a description are GitHub stars and weekly npm downloads (— when npm has no figure yet).",
      zh: "由 dsh-plugin-mesh 生态图整理的可安装 DSH 插件组合包。每条描述开头的两个数字是星标数与周 npm 下载量（显示「—」表示 npm 还没统计到）。",
    },
    metadata: {
      categories: declaredCategories,
      labels: Object.fromEntries(labels),
      sortKeys: {
        stars: { title: { en: "Stars", zh: "星标" }, order: "desc" },
        downloads: { title: { en: "Weekly downloads", zh: "周下载量" }, order: "desc" },
      },
    },
    plugins,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(index, null, 1));
  console.log("写入 " + OUT + "：" + plugins.length + " 个插件 · " + (JSON.stringify(index).length / 1024).toFixed(0) + " KB");
  if (mergedClaimants) {
    console.log("同名认领合并: " + mergedClaimants + " 条仓库记录归到同一个包名下（挑的是 npm 包自己声明的那个仓库）");
  }
  const skipped = [...skipReasons.entries()].map(([pkg, why]) => ({ pkg, why }));
  if (skipped.length) {
    console.log("未收录 " + skipped.length + " 个：");
    for (const s of skipped.slice(0, 12)) console.log("   - " + s.pkg + "：" + s.why);
    if (skipped.length > 12) console.log("   …还有 " + (skipped.length - 12) + " 个");
  }
}

/* 直接执行时跑一次；被 import（例如单测）时什么都不做 —— 否则 import 一下就会真的去抓 npm。 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("market-index 失败：" + (err?.stack ?? err));
    process.exit(1);
  });
}
