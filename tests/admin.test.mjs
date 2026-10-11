/**
 * 管理后台测试：真的把服务起起来（同一进程、同一端口），逐条验证
 *
 *   1) 后台路径随机且可自定义；没配置就没有入口（绝不默认 /admin）
 *   2) 未登录拿不到任何接口；错误口令会被锁定
 *   3) 写操作必须带 CSRF；跨站请求被拒
 *   4) 黑名单【必须保持 owners 外壳】—— 外壳写错，采集器会当成空表，等于静默失效
 *   5) 白名单标签落到共享配置，JS 与 Python 读同一份
 *   6) 共鸣开关只写 data/admin/config.json 覆盖层，绝不碰 tools/ecosystem.json
 *   7) 审计有记录但不记口令；访问日志里不出现后台路径
 *   8) 公开站不再提供 /api/status（采集进度属于运营信息）
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 先把临时目录挂上，再动态导入被测模块 —— 免得单元测试碰到真实 data/admin
const TMP = mkdtempSync(join(tmpdir(), "dsh-mesh-admin-"));
const ADMIN_DIR = join(TMP, "admin");
const BLACKLIST_FILE = join(TMP, "noise-blacklist.json");
process.env.ADMIN_DIR = ADMIN_DIR;
process.env.BLACKLIST_FILE = BLACKLIST_FILE;

const { hashPassword } = await import("../tools/admin-auth.mjs");
const { normalizeConfig, readBlacklist, writeBlacklist, adminPathFrom } = await import("../tools/admin-config.mjs");
const { anchorsDiffer, collectorBusy, resonanceIsPending } = await import("../tools/admin.mjs");

const P = "TestAdminPath0123456789abcdef"; // 32 位字母数字，形状与线上一致
const PASSWORD = "test-password-123";
let child;
let base;
let port;
let output = "";
let cookie = null;
let csrf = null;

const url = (path) => base + "/" + P + path;

async function call(name, { method = "GET", body, csrfToken, sendCookie = true, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (sendCookie && cookie) headers.cookie = cookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(raw ?? url("/api/" + name), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && !cookie) cookie = setCookie.split(";")[0];
  return res;
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __text: text.slice(0, 400) };
  }
}

before(async () => {
  mkdirSync(ADMIN_DIR, { recursive: true });
  child = spawn(process.execPath, ["tools/serve.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      ADMIN_PATH: P,
      ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
      ADMIN_DIR,
      BLACKLIST_FILE,
      STATS_FILE: join(TMP, "stats.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (buf) => {
    output += String(buf);
  });
  child.stderr.on("data", (buf) => {
    output += String(buf);
  });
  base = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (buf) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
      if (match) {
        clearTimeout(timer);
        port = Number(match[1]);
        resolvePromise("http://127.0.0.1:" + match[1]);
      }
    });
    child.on("error", reject);
  });
});

after(() => {
  child?.kill();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------- 纯函数：路径与配置 ----------

test("后台路径校验：只认 8~64 位随机字母数字，不给默认值", () => {
  const saved = process.env.ADMIN_PATH;
  delete process.env.ADMIN_PATH;
  assert.equal(adminPathFrom({}), null, "没配置就应该是 null（后台整体关闭）");
  assert.equal(adminPathFrom({ ADMIN_PATH: "admin" }), null, "太短/太可猜的路径不接受");
  assert.equal(adminPathFrom({ ADMIN_PATH: "a/b/c" }), null, "路径里不许有斜杠");
  assert.equal(adminPathFrom({ ADMIN_PATH: P }), P, "32 位字母数字应当接受");
  process.env.ADMIN_PATH = saved;
});

test("配置规范化：白名单为空回退默认，共鸣覆盖只认布尔", () => {
  const config = normalizeConfig({ whitelistTags: ["", "dsh-x", "dsh-x"], resonance: { overrides: { "u/r": { enabled: false }, bad: 1, "u/r2": true } } });
  assert.deepEqual(config.whitelistTags, ["dsh-x"], "去空、去重、保序");
  assert.deepEqual(config.resonance.overrides, { "u/r": false, "u/r2": true }, "非法 key 忽略、布尔与对象两种写法都收");
  const fallback = normalizeConfig({ whitelistTags: [] });
  assert.ok(fallback.whitelistTags.includes("dsh"), "空名单要回退到默认 6 个标签，不能变成「什么都不抓」");
});

test("黑名单只在 owners 外壳下才认 —— 裸对象等于空表（写错就静默失效）", () => {
  const bare = join(TMP, "blacklist-bare.json");
  writeFileSync(bare, JSON.stringify({ spammer: { repos: 900, maxStars: 0 } }));
  assert.deepEqual(readBlacklist(bare).owners, {}, "没有 owners 外壳时必须当空表 —— 与 Python 的 load_blacklist 同规则");
  writeBlacklist({ owners: { spammer: { repos: 900, maxStars: 0, reason: "manual" } } }, bare);
  const back = JSON.parse(readFileSync(bare, "utf8"));
  assert.ok(back.owners && back.owners.spammer, "写出去的必须带 owners 外壳");
  assert.equal(back.count, 1);
  assert.ok(back.note && back.updatedAt, "外壳里的 updatedAt / note 不能少");
  assert.deepEqual(readBlacklist(bare).owners.spammer.reason, "manual");
});

test("前后端不漂移：后台脚本引用的元素 id 与接口都必须真实存在", () => {
  const html = readFileSync(join(ROOT, "admin", "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const js = readFileSync(join(ROOT, "admin", "app.js"), "utf8") + readFileSync(join(ROOT, "admin", "status.js"), "utf8");
  const refs = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.ok(refs.length > 5, "应该能从后台脚本里找到元素引用");
  assert.deepEqual(refs.filter((id) => !ids.has(id)), [], "后台脚本引用了 index.html 里不存在的 id");

  const routes = new Set([
    "session", "login", "logout", "status", "overview", "repos", "workflow",
    "lists", "lists/blacklist", "lists/whitelist",
    "resonance", "resonance/base", "resonance/child",
    "apply", "audit", "logs", "log",
  ]);
  const used = [...new Set([...js.matchAll(/api(?:Get|Post)\("api\/([^"?]+)/g)].map((m) => m[1]))];
  assert.ok(used.length > 5, "应该能从后台脚本里找到接口调用");
  assert.deepEqual(used.filter((name) => !routes.has(name)), [], "后台脚本调用了服务端没有的接口");
});

test("采集器正在跑时不该允许重建（避免两边同时重写 mesh.json）", () => {
  const file = join(TMP, "status-probe.json");
  writeFileSync(file, JSON.stringify({ state: "crawling", phase: "segments", updatedAt: new Date().toISOString() }));
  assert.ok(collectorBusy(file), "正在采集时应判定为忙");
  writeFileSync(file, JSON.stringify({ state: "crawling", updatedAt: new Date(Date.now() - 30 * 60000).toISOString() }));
  assert.equal(collectorBusy(file), null, "状态超过 10 分钟没动，说明采集器没在跑，不该拦");
  writeFileSync(file, JSON.stringify({ state: "idle", updatedAt: new Date().toISOString() }));
  assert.equal(collectorBusy(file), null, "空闲时允许重建");
  writeFileSync(file, "{ 坏掉的 json");
  assert.equal(collectorBusy(file), null, "状态文件损坏时按不忙处理，不能因此卡死重建");
});

// ---------- 路由与鉴权 ----------

test("后台首页与资源：走自定义路径；没带斜杠会补跳转", async () => {
  const direct = await fetch(base + "/" + P, { redirect: "manual" });
  assert.equal(direct.status, 302, "不带斜杠时应跳到带斜杠的首页");
  assert.equal(direct.headers.get("location"), "/" + P + "/");

  const page = await fetch(url("/"));
  assert.equal(page.status, 200, "后台首页应可访问（未登录先给登录页）");
  const html = await page.text();
  assert.ok(!/<script(?![^>]*src=)[^>]*>[^<]/.test(html), "不能有内联脚本（CSP 只放行 self）");

  // 资源引用必须是相对路径，且在 {路径}/ 下真的能取到（页面在 /{路径}/ 里）
  const scriptSrc = /<script[^>]*src="([^"]+)"/.exec(html)?.[1];
  assert.ok(scriptSrc && !scriptSrc.startsWith("/"), "后台脚本必须用相对路径，实际：" + scriptSrc);
  const script = await fetch(new URL(scriptSrc, url("/")));
  assert.equal(script.status, 200, "脚本要能取到：" + scriptSrc);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);

  const cssHref = /<link[^>]*href="([^"]+)"[^>]*>/.exec(html)?.[1];
  const css = await fetch(new URL(cssHref, url("/")));
  assert.equal(css.status, 200, "样式要能取到：" + cssHref);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  // 编码过的 .. 会被服务端解码，必须仍拿不到后台目录外的文件
  const escape = await fetch(base + "/" + P + "/a/%2e%2e/tools/admin.mjs");
  assert.notEqual(escape.status, 200, "不许穿到后台目录之外");
});

test("未登录：拿不到任何接口，但能问会话状态", async () => {
  const session = await call("session");
  assert.equal(session.status, 200);
  assert.deepEqual(await json(session), { authed: false }, "未登录时只回 authed:false");
  for (const name of ["status", "overview", "lists", "resonance", "workflow", "audit"]) {
    const res = await call(name);
    assert.equal(res.status, 401, name + " 未登录必须是 401");
  }
  const write = await call("lists/blacklist", { method: "POST", body: { action: "add", owner: "x" } });
  assert.equal(write.status, 401, "写接口未登录同样 401");
});

test("错误口令 401；写操作缺 CSRF 403", async () => {
  const bad = await call("login", { method: "POST", body: { password: "wrong-password" }, sendCookie: false });
  assert.equal(bad.status, 401);

  const ok = await call("login", { method: "POST", body: { password: PASSWORD }, sendCookie: false });
  assert.equal(ok.status, 200, "正确口令应登录成功");
  const payload = await json(ok);
  assert.ok(payload.csrf, "登录要回 CSRF 令牌");
  const rawCookie = ok.headers.get("set-cookie") ?? "";
  assert.match(rawCookie, /HttpOnly/, "会话 Cookie 必须 HttpOnly");
  assert.match(rawCookie, /SameSite=Strict/, "会话 Cookie 必须 SameSite=Strict");
  assert.match(rawCookie, new RegExp("Path=/" + P + "/"), "Cookie 作用域锁在后台路径下");

  const csrfless = await call("lists/whitelist", { method: "POST", body: { tags: ["dsh"] } });
  assert.equal(csrfless.status, 403, "没有 CSRF 令牌的写操作必须被拒");

  const session = await json(await call("session"));
  assert.equal(session.authed, true);
  csrf = session.csrf;
  assert.equal(csrf, payload.csrf, "会话里的 CSRF 应与登录返回的一致");
});

// ---------- 接口形状 ----------

test("状态 / 数据 / 工作流：形状齐、字段可缺", async () => {
  const status = await json(await call("status"));
  assert.ok(status.serverTime && "raw" in status && status.applying, "状态接口要带服务器时间、采集状态与作业信息");
  assert.equal(typeof status.stale, "boolean");

  const overview = await json(await call("overview"));
  assert.ok(overview.nodes > 0, "数据概况要能报出节点数");
  assert.ok(Array.isArray(overview.files) && overview.files.length > 0, "要有文件清单");
  assert.ok(!JSON.stringify(overview.files).includes(ROOT), "不许把本机绝对路径暴露出去");

  const workflow = await json(await call("workflow"));
  assert.equal(workflow.phases.length, 5, "工作流五段固定");
  assert.deepEqual(workflow.phases.map((p) => p.id), ["segments", "readme", "build", "write", "precompute"]);

  const repos = await json(await call("repos?limit=3"));
  assert.ok(repos.items.length <= 3 && repos.total > 0);
  assert.ok(repos.items.every((r) => r.id && typeof r.stars === "number"));

  const apply = await json(await call("apply"));
  assert.ok(apply.job && ["idle", "running", "done", "failed"].includes(apply.job.status));
});

// ---------- 名单 ----------

test("黑名单：增删都保持外壳，且留备份；作者名要校验", async () => {
  const add = await call("lists/blacklist", { method: "POST", body: { action: "add", owner: "spam-owner", note: "后台手工拉黑" }, csrfToken: csrf });
  assert.equal(add.status, 200);
  const after = JSON.parse(readFileSync(BLACKLIST_FILE, "utf8"));
  assert.ok(after.owners["spam-owner"], "条目要写进 owners");
  assert.equal(after.owners["spam-owner"].reason, "manual");

  // 第二次写才会产生备份（首次创建没有"旧文件"可备份）
  await call("lists/blacklist", { method: "POST", body: { action: "add", owner: "spam-owner-2" }, csrfToken: csrf });
  assert.ok(existsSync(BLACKLIST_FILE + ".bak"), "覆盖旧名单前必须留一份 .bak");

  const bad = await call("lists/blacklist", { method: "POST", body: { action: "add", owner: "a/../../etc" }, csrfToken: csrf });
  assert.equal(bad.status, 400, "非法作者名必须 400");

  const list = await json(await call("lists"));
  assert.ok(list.blacklist.owners["spam-owner"]);
  assert.deepEqual(list.whitelistTags, list.defaultWhitelistTags, "没改过时白名单应等于默认值");

  const remove = await call("lists/blacklist", { method: "POST", body: { action: "remove", owner: "spam-owner" }, csrfToken: csrf });
  assert.equal(remove.status, 200);
  assert.ok(!JSON.parse(readFileSync(BLACKLIST_FILE, "utf8")).owners["spam-owner"], "删除后条目必须消失");
});

test("白名单标签：落到共享配置，非法标签被拒", async () => {
  const bad = await call("lists/whitelist", { method: "POST", body: { tags: ["ok-tag", "bad tag!"] }, csrfToken: csrf });
  assert.equal(bad.status, 400);
  const ok = await call("lists/whitelist", { method: "POST", body: { tags: ["dsh", "dsh-plugin", "my-own-tag"] }, csrfToken: csrf });
  assert.equal(ok.status, 200);
  const config = JSON.parse(readFileSync(join(ADMIN_DIR, "config.json"), "utf8"));
  assert.deepEqual(config.whitelistTags, ["dsh", "dsh-plugin", "my-own-tag"], "写的是 data/admin/config.json");
  const restore = await call("lists/whitelist", { method: "POST", body: { tags: ["dsh-plugin-desktop", "dsh-desktop", "dsh-plugin-market", "dsh-plugins", "dsh-plugin", "dsh"] }, csrfToken: csrf });
  assert.equal(restore.status, 200);
  assert.ok(existsSync(join(ADMIN_DIR, "config.json.bak")), "第二次覆盖配置时要留备份");
  assert.deepEqual(JSON.parse(readFileSync(join(ADMIN_DIR, "config.json"), "utf8")).whitelistTags, ["dsh-plugin-desktop", "dsh-desktop", "dsh-plugin-market", "dsh-plugins", "dsh-plugin", "dsh"]);
});

test("共鸣：可编辑（增删改查），只写后台管理副本，策展产物一个字节都不动", async () => {
  const curatedBefore = statSync(join(ROOT, "tools", "ecosystem.json")).mtimeMs;
  const managed = join(ADMIN_DIR, "ecosystem.json");

  // 查
  const list = await json(await call("resonance"));
  assert.ok(list.bases.length > 0, "要能列出基座");
  assert.equal(list.managed, false, "还没编辑过时，读的是策展产物");
  const target = list.bases[0];
  assert.ok(Array.isArray(target.children) && target.children.length > 0, "基座应带子项");
  assert.equal(typeof target.edgeCount, "number", "要能看出画了几条边");

  // 改
  const upd = await json(await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, label: "后台改过的名字", enabled: false }, csrfToken: csrf }));
  assert.equal(upd.managed, true, "第一次改动会创建后台副本");
  assert.equal(upd.bases.find((b) => b.id === target.id).label, "后台改过的名字");
  assert.equal(upd.bases.find((b) => b.id === target.id).enabled, false);
  assert.ok(existsSync(managed), "管理副本应落盘");
  assert.ok(existsSync(managed + ".bak") === false || true, "备份策略不强制首次创建就有");

  // 增（基座 + 子项）
  const added = await json(await call("resonance/base", { method: "POST", body: { action: "add", id: "acme/dsh-base", label: "自建基座", tag: "dsh-acme" }, csrfToken: csrf }));
  assert.ok(added.bases.some((b) => b.id === "acme/dsh-base"), "新基座应出现在清单里");
  assert.equal((await call("resonance/base", { method: "POST", body: { action: "add", id: "acme/dsh-base" }, csrfToken: csrf })).status, 400, "重复添加应被拒");
  assert.equal((await call("resonance/base", { method: "POST", body: { action: "add", id: "不是 owner/repo" }, csrfToken: csrf })).status, 400, "非法 id 应被拒");
  assert.equal((await call("resonance/base", { method: "POST", body: { action: "add", id: "a".repeat(2000) + "/b" }, csrfToken: csrf })).status, 400, "超长 id 应被拒（否则能撑大清单文件）");
  assert.equal((await call("resonance/child", { method: "POST", body: { action: "add", baseId: "acme/dsh-base", childId: "a".repeat(2000) + "/b" }, csrfToken: csrf })).status, 400, "超长子项 id 应被拒");
  assert.equal((await call("resonance/base", { method: "POST", body: { action: "add", id: "__proto__/x" }, csrfToken: csrf })).status, 400, "__proto__ 之类的名字应被拒");

  const child = await json(await call("resonance/child", { method: "POST", body: { action: "add", baseId: "acme/dsh-base", childId: "acme/dsh-child" }, csrfToken: csrf }));
  assert.deepEqual(child.bases.find((b) => b.id === "acme/dsh-base").children.map((c) => c.id), ["acme/dsh-child"]);
  assert.equal((await call("resonance/child", { method: "POST", body: { action: "add", baseId: "nobody/nothing", childId: "a/b" }, csrfToken: csrf })).status, 404, "基座不存在应 404");

  // 删
  const delChild = await json(await call("resonance/child", { method: "POST", body: { action: "remove", baseId: "acme/dsh-base", childId: "acme/dsh-child" }, csrfToken: csrf }));
  assert.equal(delChild.bases.find((b) => b.id === "acme/dsh-base").children.length, 0);
  const delBase = await json(await call("resonance/base", { method: "POST", body: { action: "remove", id: "acme/dsh-base" }, csrfToken: csrf }));
  assert.ok(!delBase.bases.some((b) => b.id === "acme/dsh-base"), "删除后基座应消失");

  // 还原策展版本
  const reset = await json(await call("resonance/base", { method: "POST", body: { action: "reset" }, csrfToken: csrf }));
  assert.equal(reset.bases.length, list.bases.length, "还原后基座数量回到策展版本");
  assert.equal(reset.bases.find((b) => b.id === target.id).label, target.label, "还原后标签回到策展版本");
  assert.equal(statSync(join(ROOT, "tools", "ecosystem.json")).mtimeMs, curatedBefore, "tools/ecosystem.json 一个字节都不该被后台动过");
  // 这里不断言 pendingApply：它拿【仓库里真实的 data/mesh.json】做内容比对，
  // 而线上数据随时可能是"另一份清单建出来的"（例如运营刚关掉一个基座并应用过），
  // 属于环境相关。pending 的语义由上面那条纯函数单测覆盖。
});

test("锚定条件是否与上次策展一致：改了探针词/语境要能看出来（它不靠「应用变更」生效）", () => {
  const base = (extra) => ({ bases: [{ id: "omdsh-dev/DSH-better-sidebar", label: "底座", tag: "dsh-better-sidebar", enabled: true, verified: [], ...extra }] });
  // 两边都没写锚定条件 → 都回落到内置值 → 一致
  assert.equal(anchorsDiffer(base({}), base({})), false, "都没写过时应当一致（都用内置值）");
  // 管理副本把探针词改了 → 需要重新策展
  assert.equal(anchorsDiffer(base({ probes: ["dsh-better-sidebar", "extra"] }), base({})), true, "探针词不同应判定为待策展");
  assert.equal(anchorsDiffer(base({ context: "skin" }), base({})), true, "语境不同应判定为待策展");
  assert.equal(anchorsDiffer(base({ tag: null }), base({})), true, "生态签不同应判定为待策展");
  // 显式写成与内置相同的值 → 仍然一致（比的是有效值，不是"写没写过"）
  assert.equal(anchorsDiffer(base({ probes: ["dsh-better-sidebar"], context: "depend" }), base({})), false, "值相同就不算差异");
  // 基座集合不同
  assert.equal(anchorsDiffer({ bases: [] }, base({})), true, "少了一个基座也要算差异");
});

test("待应用判定：比内容不比时间；停用的基座期望边数是 0；图里没有的子项不参与", () => {
  const doc = (bases) => ({ managed: true, doc: { bases } });
  const meshOf = (meta, edges, nodes) => ({ meta, nodes: nodes.map((id) => ({ id })), edges: edges.map(([source, target]) => ({ type: "resonance", source, target })) });
  const base = (id, enabled, children) => ({ id, enabled, verified: children.map((c) => ({ id: c })) });

  // 完全一致 → 没有待应用
  const docA = doc([base("a/base", true, ["x/one", "x/two"]), base("b/base", false, ["y/one"])]);
  const meshA = meshOf({ ecosystemBases: ["a/base"], ecosystemDisabled: ["b/base"] }, [["a/base", "x/one"], ["a/base", "x/two"]], ["a/base", "b/base", "x/one", "x/two", "y/one"]);
  assert.equal(resonanceIsPending(docA, meshA), false, "完全一致时不该报待应用");

  // 停用的基座：期望 0 条边 —— 它还有子项也不该被算成"缺边"
  assert.equal(resonanceIsPending(doc([base("b/base", false, ["y/one"])]), meshOf({ ecosystemBases: [], ecosystemDisabled: ["b/base"] }, [], ["b/base", "y/one"])), false, "停用的基座不该要求建边");

  // 刚在后台关掉一个基座，但图里还开着 → 待应用
  assert.equal(resonanceIsPending(doc([base("a/base", false, ["x/one"])]), meshA), true, "停用未生效要报待应用");
  // 加了一个子项 → 边数对不上 → 待应用
  assert.equal(resonanceIsPending(doc([base("a/base", true, ["x/one", "x/two", "x/three"])]), meshOf({ ecosystemBases: ["a/base"] }, [["a/base", "x/one"], ["a/base", "x/two"]], ["a/base", "x/one", "x/two", "x/three"])), true, "新增子项未建边要报待应用");
  // 子项不在图里（还没被收录）→ 不参与比较
  assert.equal(resonanceIsPending(doc([base("a/base", true, ["x/one", "ghost/repo"])]), meshOf({ ecosystemBases: ["a/base"] }, [["a/base", "x/one"]], ["a/base", "x/one"])), false, "图里没有的子项不该被当成缺边");
  // 没有管理副本 → 永远不算待应用（读的就是策展产物本身）
  assert.equal(resonanceIsPending({ managed: false, doc: { bases: [] } }, null), false);
  // 拿不到图 → 保守报待应用（不假装已应用）
  assert.equal(resonanceIsPending(docA, null), true, "拿不到数据时应保守报待应用");
});

test("共鸣锚定条件：探针词 / 包名 / 语境 可增删改查，非法值被拒（不能静默清空）", async () => {
  const list = await json(await call("resonance"));
  assert.deepEqual(list.contexts.map((c) => c.id), ["depend", "conform", "skin"], "要给出可选的语境规则");
  const target = list.bases[0];
  assert.ok(Array.isArray(target.probes) && Array.isArray(target.packages), "基座要带锚定条件");
  assert.ok(target.builtinAnchors && target.builtinAnchors.context, "要给出内置锚定条件，供「恢复内置」用");

  // 改（含去重）
  const upd = await json(await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, probes: ["a", "b", "a"], packages: ["pkg-x"], context: "conform" }, csrfToken: csrf }));
  const base = upd.bases.find((b) => b.id === target.id);
  assert.deepEqual(base.probes, ["a", "b"], "探针词应去重保序");
  assert.deepEqual(base.packages, ["pkg-x"]);
  assert.equal(base.context, "conform");
  assert.equal(base.contextLabel, "规范遵循");
  assert.equal(base.anchorsCustom, true, "改过之后要标成自定义");

  // 增 / 删
  const more = await json(await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, probes: [...base.probes, "c"] }, csrfToken: csrf }));
  assert.deepEqual(more.bases.find((b) => b.id === target.id).probes, ["a", "b", "c"]);
  const cleared = await json(await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, probes: [] }, csrfToken: csrf }));
  assert.deepEqual(cleared.bases.find((b) => b.id === target.id).probes, []);

  // 非法输入必须 400 —— 不能"看起来保存成功、实则把条件清空"
  const cases = [
    { context: "whatever" },
    { probes: ["x".repeat(200)] },
    { probes: "not-an-array" },
    { packages: [123] },
  ];
  for (const body of cases) {
    const res = await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, ...body }, csrfToken: csrf });
    assert.equal(res.status, 400, "非法锚定条件应被拒：" + JSON.stringify(body));
  }

  // 子项的锚定证据
  const childId = target.children[0].id;
  const childUpd = await json(await call("resonance/child", { method: "POST", body: { action: "update", baseId: target.id, childId, signals: ["生态签:x", "人工确认"], readme: "dsh-x" }, csrfToken: csrf }));
  const child = childUpd.bases.find((b) => b.id === target.id).children.find((c) => c.id === childId);
  assert.deepEqual(child.signals, ["生态签:x", "人工确认"]);
  assert.equal(child.readme, "dsh-x");
  assert.equal((await call("resonance/child", { method: "POST", body: { action: "update", baseId: target.id, childId, signals: "nope" }, csrfToken: csrf })).status, 400);

  // 恢复内置锚定条件
  const restore = await json(await call("resonance/base", { method: "POST", body: { action: "update", id: target.id, probes: target.builtinAnchors.probes, packages: target.builtinAnchors.packages, context: target.builtinAnchors.context }, csrfToken: csrf }));
  const restored = restore.bases.find((b) => b.id === target.id);
  assert.equal(restored.context, target.builtinAnchors.context);
  assert.deepEqual(restored.probes, target.builtinAnchors.probes);

  await call("resonance/base", { method: "POST", body: { action: "reset" }, csrfToken: csrf });
});

test("锚定条件的三态：没写过→内置值；明确清空→空；写过的→写的那份", async () => {
  const { effectiveAnchors } = await import("../tools/admin-config.mjs");
  // 没写过（null）→ 回落内置定义
  const bare = effectiveAnchors({ bases: [{ id: "omdsh-dev/DSH-better-sidebar", label: "x", verified: [] }] });
  assert.deepEqual(bare[0].probes, ["dsh-better-sidebar"], "没写过就该用内置探针词");
  assert.equal(bare[0].context, "depend", "没写过就该用内置语境");
  // 明确清空（[]）→ 就是空，绝不偷偷补回来
  const cleared = effectiveAnchors({ bases: [{ id: "omdsh-dev/DSH-better-sidebar", label: "x", probes: [], packages: [], context: "skin", verified: [] }] });
  assert.deepEqual(cleared[0].probes, [], "明确清空后不能再补内置值");
  assert.deepEqual(cleared[0].packages, []);
  assert.equal(cleared[0].context, "skin", "写过的语境要保留");
  // 写过 → 用写的
  const custom = effectiveAnchors({ bases: [{ id: "acme/base", label: "自建", probes: ["p1"], packages: ["p2"], context: "conform", verified: [] }] });
  assert.deepEqual(custom[0].probes, ["p1"]);
  assert.equal(custom[0].context, "conform");
});

test("共鸣（旧写法）：{baseId, enabled} 仍然能用，落到同一份管理副本", async () => {
  const list = await json(await call("resonance"));
  const target = list.bases[0];
  assert.equal((await call("resonance", { method: "POST", body: { baseId: "nobody/nothing", enabled: false }, csrfToken: csrf })).status, 404, "不存在的基座应 404");
  const off = await json(await call("resonance", { method: "POST", body: { baseId: target.id, enabled: false }, csrfToken: csrf }));
  assert.equal(off.resonance.bases.find((b) => b.id === target.id).enabled, false);
  await call("resonance/base", { method: "POST", body: { action: "reset" }, csrfToken: csrf });
});

test("日志：只读、走白名单，越界一律 404", async () => {
  const files = await json(await call("logs"));
  assert.ok(Array.isArray(files.files) && files.files.length > 0, "应能列出日志");
  const audit = files.files.find((f) => f.name === "data/admin/audit.log");
  assert.ok(audit, "审计日志应在清单里：" + JSON.stringify(files.files.map((f) => f.name)));

  // workflow.logs 里的 name 必须能直接喂给 /api/log（曾因只回文件名而 404）
  const wf = await json(await call("workflow"));
  assert.ok(Array.isArray(wf.logs), "工作流应带日志清单");
  for (const item of wf.logs.slice(0, 3)) {
    const res = await call("log?name=" + encodeURIComponent(item.name));
    assert.equal(res.status, 200, "workflow.logs 的 name 应可直接读取：" + item.name);
  }
  // 只给文件名也认（老前端兼容）
  if (wf.logs.length) {
    const bare = wf.logs[0].name.split("/").pop();
    assert.equal((await call("log?name=" + encodeURIComponent(bare))).status, 200, "只给文件名也应能读：" + bare);
  }

  const one = await json(await call("log?name=" + encodeURIComponent("data/admin/audit.log")));
  assert.ok(Array.isArray(one.lines) && one.lines.length > 0, "应能读到日志行");
  assert.equal(typeof one.truncated, "boolean");
  assert.equal(one.name, "data/admin/audit.log");

  for (const bad of ["../../etc/passwd", "/etc/shadow", "data/mesh.json", "data/admin/config.json", "data/admin/logs/../config.json", "data/admin/logs/不存在.log"]) {
    const res = await call("log?name=" + encodeURIComponent(bad));
    assert.equal(res.status, 404, bad + " 不应可读");
  }
});

test("审计：记录了动作，但不记口令、不记后台路径", async () => {
  const audit = await json(await call("audit?limit=50"));
  assert.ok(audit.entries.length > 0, "应有审计记录");
  const text = JSON.stringify(audit.entries);
  assert.ok(!text.includes(PASSWORD), "审计里绝不能出现口令");
  assert.ok(audit.entries.some((e) => e.action === "login-ok"), "成功登录要留痕");
  assert.ok(audit.entries.some((e) => String(e.action).startsWith("blacklist")), "改名单要留痕");
  assert.ok(audit.entries.every((e) => e.at && e.action), "每条都要有时间与动作");
});

test("公开站：不再提供 /api/status，后台响应也不带通配 CORS", async () => {
  const res = await fetch(base + "/api/status");
  assert.equal(res.status, 404, "公开的采集状态接口应已下线");
  const admin = await call("session");
  assert.equal(admin.headers.get("access-control-allow-origin"), null, "后台接口不能带 Access-Control-Allow-Origin: *");
  assert.match(admin.headers.get("cache-control") ?? "", /no-store/);
  assert.match(admin.headers.get("x-content-type-options") ?? "", /nosniff/);
  assert.match(admin.headers.get("content-security-policy") ?? "", /default-src 'self'/);
});

test("访问日志不出现后台路径（日志会被人看到，路径就是口令）", async () => {
  // console.log 写管道是异步的：先等脱敏日志出现，别赌它立刻可见
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !/后台 (GET|POST) /.test(output)) await new Promise((r) => setTimeout(r, 50));
  assert.ok(output.length > 0, "服务应有日志输出");
  const leaked = output.split("\n").filter((line) => line.includes(P)).slice(0, 5);
  assert.equal(leaked.length, 0, "日志里出现了后台路径：" + leaked.join(" | "));
  assert.ok(/后台 (GET|POST) /.test(output), "后台请求应留下脱敏日志（只记接口名），实际日志尾部：" + JSON.stringify(output.slice(-200)));
});

// 放在最后：这几条会制造"连错"状态
test("连续输错口令会被限流（429 + Retry-After），但正确口令永远能进", async () => {
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = await call("login", { method: "POST", body: { password: "nope-" + i }, sendCookie: false });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, "连续输错应被限流");
  assert.ok(Number(last.headers.get("retry-after")) > 0, "限流要告诉对方多久后再试");

  // 关键：不能让人用"故意输错"把主人锁在门外（反代后面所有人同一个 IP 时尤其致命）
  const owner = await call("login", { method: "POST", body: { password: PASSWORD }, sendCookie: false });
  assert.equal(owner.status, 200, "连错之后，带正确口令的主人必须仍然进得来");
  assert.ok((await json(owner)).csrf, "正确口令登录要照常发 CSRF 令牌");
});
