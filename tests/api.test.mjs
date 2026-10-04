/**
 * 只读查询 API 与卡片的测试。
 * 既测引擎（纯函数/查询逻辑），也起一个真实服务测 HTTP 层（状态码、CORS、缓存、转义）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, categoryColor, xmlEscape, validNamePart, apiIndex, MAX_LIMIT, textWidth, wrapText, DEFAULT_SITE } from "../tools/api.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = createApi({ root: ROOT });

test("分类总览：扇区与细枝计数自洽", async () => {
  const cats = await api.categories();
  assert.ok(cats.sectors.length >= 5, "应有多个扇区");
  const sum = cats.sectors.reduce((n, s) => n + s.count, 0);
  assert.equal(sum, cats.total, "扇区计数之和必须等于节点总数");
  for (const s of cats.sectors) {
    const subSum = s.subcategories.reduce((n, x) => n + x.count, 0);
    assert.ok(subSum <= s.count, "细枝计数不能超过所属扇区：" + s.id);
  }
});

test("紧凑检索：README 正文命中也能搜到，并如实区分（v0.4.6）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-api-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  const node = (id, description) => ({
    id,
    name: id.split("/")[1],
    owner: id.split("/")[0],
    stars: 5,
    description,
    topics: ["dsh-plugin"],
    matchedTags: ["dsh-plugin"],
    category: "tools",
    categoryLabel: "工具命令",
  });
  await writeFile(
    join(tmp, "data", "mesh.json"),
    JSON.stringify({ nodes: [node("u/plain", "普通仓库，描述里没有那个词"), node("u/readme-only", "描述里也没有")], edges: [], clusters: [], meta: {} }),
  );
  await writeFile(
    join(tmp, "data", "cache", "readmes.json"),
    JSON.stringify({ count: 1, docs: { "u/readme-only": { t: "这里写着 zzz-unique-token 的用法", f: "2026-10-04T00:00:00Z" } } }),
  );
  const local = createApi({ root: tmp });

  const byReadme = await local.searchIds(new URLSearchParams("q=zzz-unique-token"));
  assert.deepEqual(byReadme.ids, ["u/readme-only"], "README 正文命中应能搜到");
  assert.equal(byReadme.readme.total, 1, "应如实标记为 README 命中");
  assert.equal(byReadme.readme.indexed, 1, "应回传已索引篇数");

  const byField = await local.searchIds(new URLSearchParams("q=plain"));
  assert.ok(byField.ids.includes("u/plain"), "本地字段命中照常");
  assert.equal(byField.readme.total, 0, "不是 README 命中的不该混进来");

  const repos = await local.search(new URLSearchParams("q=zzz-unique-token"));
  assert.equal(repos.total, 1, "/api/repos 也要能按 README 正文搜到");
  assert.equal(repos.readme.total, 1);

  const empty = await local.searchIds(new URLSearchParams("q="));
  assert.deepEqual(empty.ids, [], "空查询不返回结果");
  await rm(tmp, { recursive: true, force: true });
});

test("紧凑检索：采集器写的 gzip 索引（readmes.json.gz）也能读（v0.4.6 主路径）", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-api-gz-"));
  await mkdir(join(tmp, "data", "cache"), { recursive: true });
  await writeFile(
    join(tmp, "data", "mesh.json"),
    JSON.stringify({
      nodes: [{ id: "u/only-readme", name: "only-readme", owner: "u", stars: 3, description: "描述里没有", topics: ["dsh-plugin"], matchedTags: ["dsh-plugin"], category: "tools", categoryLabel: "工具命令" }],
      edges: [],
      clusters: [],
      meta: {},
    }),
  );
  const payload = { count: 1, docs: { "u/only-readme": { t: "摘要里写着 zzz-gz-token", f: "2026-10-04T00:00:00Z" } } };
  await writeFile(join(tmp, "data", "cache", "readmes.json.gz"), gzipSync(Buffer.from(JSON.stringify(payload))));
  const local = createApi({ root: tmp });
  const hit = await local.searchIds(new URLSearchParams("q=zzz-gz-token"));
  assert.deepEqual(hit.ids, ["u/only-readme"], "gzip 索引应能直接读");
  assert.equal(hit.readme.indexed, 1);
  await rm(tmp, { recursive: true, force: true });
});

test("检索：过滤、排序、分页都真的生效（从数据自身推导，不写死数字）", async () => {
  const all = await api.search(new URLSearchParams("limit=5&fields=all"));
  assert.equal(all.items.length, 5, "应返回 5 条");
  assert.ok(all.total > 5, "总数应大于一页");
  const stars = all.items.map((n) => n.stars);
  assert.deepEqual(stars, [...stars].sort((a, b) => b - a), "默认按星标降序");

  const cats = await api.categories();
  const sector = cats.sectors[0];
  const only = await api.search(new URLSearchParams("category=" + sector.id + "&limit=100&fields=all"));
  assert.equal(only.total, sector.count, "按扇区过滤的命中数应与总览一致");
  assert.ok(only.items.every((n) => n.category === sector.id), "过滤后每条都应属于该扇区");

  const page1 = await api.search(new URLSearchParams("limit=3&offset=0&sort=stars"));
  const page2 = await api.search(new URLSearchParams("limit=3&offset=3&sort=stars"));
  assert.notEqual(page1.items[0].id, page2.items[0].id, "翻页应换一批");
  assert.equal(page2.offset, 3);

  const capped = await api.search(new URLSearchParams("limit=9999"));
  assert.equal(capped.limit, MAX_LIMIT, "limit 必须被夹到上限");
  assert.ok(capped.count <= MAX_LIMIT);
});

test("单仓库详情：连线两端都指向它，计数与列表一致", async () => {
  const found = await api.search(new URLSearchParams("limit=1&sort=stars"));
  const id = found.items[0].id;
  const [owner, name] = id.split("/");
  const one = await api.one(owner, name);
  assert.ok(one, "应能查到星标最高的仓库");
  assert.equal(one.repo.id, id);
  assert.equal(one.repo.url, "https://github.com/" + id);
  const counts = Object.values(one.linkCounts).reduce((a, b) => a + b, 0);
  assert.equal(counts, one.links.length, "连线计数应与列表长度一致");
  assert.ok(one.links.every((l) => l.id !== id), "不应出现自环");
});

test("v0.4.2 单仓库详情：同作者连线是完整关系（不受数据层星形拓扑省略影响）", async () => {
  const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
  const byOwner = new Map();
  for (const n of mesh.nodes ?? []) {
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  // 成员超过 8 的作者：数据层只写星形拓扑，正是"有的连得全、有的只连一个"的那批
  const [owner, list] = [...byOwner.entries()].filter(([, g]) => g.length > 8).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  assert.ok(owner, "样本里应有成员超过 8 的作者");

  const target = list[0];
  const one = await api.one(owner, target.name);
  assert.ok(one, "应能查到 " + target.id);
  const ownerLinks = one.links.filter((l) => l.type === "owner");
  assert.equal(ownerLinks.length, list.length - 1, owner + " 的同作者连线应为 " + (list.length - 1) + " 条");
  assert.equal(one.linkCounts.owner, ownerLinks.length, "同作者计数应与列表一致");
  assert.ok(ownerLinks.every((l) => l.id !== target.id), "同作者连线不应指向自己");
  assert.ok(ownerLinks.every((l) => l.id.startsWith(owner + "/")), "同作者连线必须同属一个作者");
});

test("卡片：合法 SVG、含关键信息、转义正确", async () => {
  const found = await api.search(new URLSearchParams("limit=1&sort=stars"));
  const [owner, name] = found.items[0].id.split("/");
  const svg = await api.cardSvg(owner, name, {});
  assert.ok(svg.startsWith("<svg"), "应以 <svg 开头");
  assert.ok(svg.trimEnd().endsWith("</svg>"), "应以 </svg> 结尾");
  assert.match(svg, /width="420" height="168"/);
  // 卡片必须带去处：默认线上站点，且整张卡片可点（直接打开或 <object> 嵌入时生效）
  assert.ok(svg.includes(DEFAULT_SITE), "卡片应包含默认去处 " + DEFAULT_SITE);
  assert.ok(svg.includes("<a "), "卡片应包在链接里");
  assert.ok(svg.includes('target="_blank"'));
  const custom = await api.cardSvg(owner, name, { site: "https://example.com/" });
  assert.ok(custom.includes("https://example.com/"), "自定义去处应生效");
  // 语言色点 / 相对时间 / 图标
  assert.ok(svg.includes("#f1e05a") || svg.includes("#3178c6"), "应画出该语言的颜色点");
  assert.match(svg, /更新于 /, "应有相对时间");
  assert.ok((svg.match(/<path d="/g) || []).length >= 2, "应包含仓库图标与星标图标");
  // 三个链接：背景→站点、仓库名→GitHub、底部→站点
  const hrefs = [...svg.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 3, "应有三个链接，实际 " + hrefs.length);
  assert.ok(hrefs.includes("https://github.com/" + found.items[0].id), "仓库名应指向 GitHub 原仓库");
  assert.equal(hrefs.filter((h) => h === DEFAULT_SITE).length, 2, "背景与底部都应指向站点");
  assert.ok(svg.includes(found.items[0].id.split("/")[1]), "卡片应含仓库名");
  assert.ok(!/<script/i.test(svg), "卡片不得包含脚本");

  // 默认就是 GitHub 深色；显式 light 才走浅色令牌
  assert.ok(svg.includes("#0d1117"), "默认应为 GitHub 深色底 #0d1117");
  assert.ok(svg.includes("#58a6ff"), "深色用 GitHub 深色链接色");
  const light = await api.cardSvg(owner, name, { theme: "light" });
  assert.ok(light.includes("#d0d7de"), "浅色应使用 GitHub 浅色边框令牌");
  assert.notEqual(light, svg, "两套主题应不同");
  assert.ok(svg.includes('class="bg"'), "卡片应有可点的背景矩形");

  // 不存在的仓库返回 null（由 HTTP 层转成 404 占位卡片）
  assert.equal(await api.cardSvg("no-such-owner", "no-such-repo-xyz"), null);

  // 转义：名称里的尖括号/引号必须被转义，不能破坏 XML
  assert.equal(xmlEscape('<a & "b">'), "&lt;a &amp; &quot;b&quot;&gt;");

  // 描述必须换行显示，而不是被切掉半句
  const longDesc = wrapText("DSH 通用皮肤框架：可视化自定义 + 实时预览 + 「皮肤管理」，可以随心设计你的专属皮肤，并通过分发皮肤包和你的小伙伴们分享", 12.5, 428, 2);
  assert.equal(longDesc.length, 2, "长描述应排成两行，实际 " + longDesc.length);
  assert.ok(longDesc.every((l) => textWidth(l, 12.5) <= 428), "每行都不得超出可用宽度");
  assert.ok(!longDesc[1].endsWith("…"), "恰好两行放得下时不应加省略号");
  assert.ok(!longDesc[0].endsWith("…"), "第一行不应带省略号");
  // 确实放不下时才省略（用同一段文字重复三倍构造超长输入）
  const tooLong = wrapText(new Array(4).join("DSH 通用皮肤框架：可视化自定义 + 实时预览 + 「皮肤管理」，可以随心设计你的专属皮肤。"), 12.5, 428, 2);
  assert.equal(tooLong.length, 2, "再长也只排两行");
  assert.match(tooLong[1], /…$/, "放不下时最后一行应以省略号收尾");
  assert.ok(tooLong.every((l) => textWidth(l, 12.5) <= 428), "省略后仍不得超宽");
  const shortDesc = wrapText("简短描述", 12.5, 428, 2);
  assert.deepEqual(shortDesc, ["简短描述"], "短描述应只有一行且不加省略号");

  // 版式：卡片宽 480，任何一行文字（含锚点）都不得超出边界
  const segments = (svgText) => {
    const out = [];
    const re = /<text x="(\d+(?:\.\d+)?)" y="[\d.]+"(?:[^>]*?)font-size="([\d.]+)"(?:[^>]*?)text-anchor="end"[^>]*>([^<]*)<\/text>|<text x="(\d+(?:\.\d+)?)" y="[\d.]+"(?:[^>]*?)font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(svgText))) {
      if (m[1]) out.push({ x: Number(m[1]) - textWidth(m[3], Number(m[2])), size: Number(m[2]), text: m[3] });
      else out.push({ x: Number(m[4]), size: Number(m[5]), text: m[6] });
    }
    return out;
  };
  const rows = segments(svg);
  assert.ok(rows.length >= 5, "卡片应有若干文本行，实际 " + rows.length);
  for (const row of rows) {
    const w = textWidth(row.text, row.size);
    assert.ok(row.x >= 0 && row.x + w <= 420, "文字超出卡片：" + JSON.stringify(row.text) + " 从 " + row.x.toFixed(0) + " 宽 " + w.toFixed(0));
  }

  // 长中文描述也不能溢出（曾经按 62 字裁剪，12.5px 下约 775px）
  const cjk = await api.search(new URLSearchParams("limit=1&fields=all"));
  const cjkId = cjk.items[0].id.split("/");
  const cjkSvg = await api.cardSvg(cjkId[0], cjkId[1], {});
  for (const row of segments(cjkSvg)) {
    assert.ok(row.x + textWidth(row.text, row.size) <= 420, "真实数据的卡片文字超出边界：" + row.text);
  }
});

test("颜色与名称校验：稳定、可预期", () => {
  assert.equal(categoryColor("agent"), categoryColor("agent"), "同一分类颜色必须稳定");
  assert.notEqual(categoryColor("agent"), categoryColor("model"), "不同分类颜色应不同");
  assert.match(categoryColor("x"), /^#[0-9a-f]{6}$/);
  assert.ok(validNamePart("deepseek-ai") && validNamePart("a.b_c-1"));
  assert.ok(!validNamePart("../etc"), "路径穿越必须被拒");
  assert.ok(!validNamePart("a b") && !validNamePart("") && !validNamePart("a".repeat(101)));
});

test("API 自描述：端点清单完整", () => {
  const index = apiIndex("0.4.6");
  assert.equal(index.version, "0.4.6");
  const paths = index.endpoints.map((e) => e.path).join(" ");
  for (const need of ["/api/health", "/api/categories", "/api/repos", "/api/card", "/card/"]) {
    assert.ok(paths.includes(need), "清单应包含 " + need);
  }
});

// ---------- HTTP 层 ----------
let child;
let base;

before(async () => {
  const port = 18000 + Math.floor(Math.random() * 900);
  base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, [resolve(ROOT, "tools/serve.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("服务未能在 6 秒内启动");
});

after(() => {
  if (child) child.kill();
});

test("HTTP：端点可用、类型正确、带 CORS 与缓存头", async () => {
  const health = await fetch(base + "/api/health");
  assert.equal(health.status, 200);
  const data = await health.json();
  assert.equal(data.ok, true);
  assert.ok(data.nodes > 0, "应报告节点数");
  assert.equal(health.headers.get("access-control-allow-origin"), "*", "只读公开接口应允许跨域");
  assert.match(health.headers.get("cache-control") ?? "", /max-age=300/);

  const index = await fetch(base + "/api");
  assert.equal(index.status, 200, "/api 应可用（不能被静态白名单挡成 403）");
  assert.ok((await index.json()).endpoints.length > 0);

  const cats = await fetch(base + "/api/categories");
  assert.equal(cats.status, 200);
  assert.ok((await cats.json()).sectors.length > 0);

  const list = await fetch(base + "/api/repos?limit=2");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 2);
});

test("HTTP：卡片是 SVG，分享页是 HTML，错误码正确", async () => {
  const list = await (await fetch(base + "/api/repos?limit=1")).json();
  const id = list.items[0].id;

  const svg = await fetch(base + "/api/card/" + id + ".svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.ok((await svg.text()).includes("<svg"));

  const dark = await fetch(base + "/api/card/" + id + ".svg?theme=dark");
  assert.equal(dark.status, 200);

  // ?link= 只在 http/https 下生效，非法值回落到默认站点（挡 javascript: 之类）
  const custom = await (await fetch(base + "/api/card/" + id + ".svg?link=https://example.com/page")).text();
  assert.ok(custom.includes("https://example.com/"), "合法 link 应生效");
  const evil = await (await fetch(base + "/api/card/" + id + ".svg?link=javascript:alert(1)")).text();
  assert.ok(!/javascript:/i.test(evil), "非法 link 必须被丢弃");
  assert.ok(evil.includes("104.129.51.126"), "非法 link 应回落到默认站点");

  const page = await fetch(base + "/card/" + id);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.includes("/api/card/" + id + ".svg"), "分享页应给出嵌入地址");
  assert.ok(html.includes("Markdown"), "分享页应给出 Markdown 片段");

  assert.equal((await fetch(base + "/api/repos/no-such/repo-xyz")).status, 404);
  assert.equal((await fetch(base + "/api/repos/a%20b/c")).status, 400);
  assert.equal((await fetch(base + "/card/no-such/repo-xyz")).status, 404);
  const missing = await fetch(base + "/api/card/no-such/repo-xyz.svg");
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /image\/svg\+xml/, "卡片缺失也应回一张占位 SVG");
});

test("HTTP：写方法被拒，预检请求被放行", async () => {
  const post = await fetch(base + "/api/repos", { method: "POST" });
  assert.ok(post.status === 405 || post.status === 403, "写方法必须被拒，实际 " + post.status);
  const opt = await fetch(base + "/api/repos", { method: "OPTIONS" });
  assert.equal(opt.status, 204, "预检应被放行");
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
});
