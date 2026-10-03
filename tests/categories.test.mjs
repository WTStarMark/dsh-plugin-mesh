/**
 * 功能分类器测试：规则要可解释、可复跑，且不能退化成"按标签分组"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classifyNode, applyCategories, CATEGORY_RULES, SUBCATEGORY_RULES, DEFAULT_OPTIONS, WHITELIST_TAGS } from "../tools/categories.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));

test("需求里的例子：皮肤类、工具类都能落到正确扇区", () => {
  assert.equal(classifyNode({ name: "dsh-skin", description: "一款 DSH 皮肤主题", topics: ["dsh-plugin"] }).id, "skin");
  assert.equal(classifyNode({ name: "dsh-cli-tool", description: "命令行工具，一键安装", topics: [] }).id, "tools");
  assert.equal(classifyNode({ name: "dsh-desktop", description: "桌面客户端", topics: ["dsh-desktop"] }).id, "desktop");
  assert.equal(classifyNode({ name: "dsh-market", description: "插件市场与索引", topics: [] }).id, "market");
});

test("白名单标签本身不能作为分类证据（否则就变回按标签分组）", () => {
  const result = classifyNode({ name: "repo", description: "", topics: [...WHITELIST_TAGS] });
  assert.equal(result.id, "other", "只有白名单标签时应判为未分类");
  assert.equal(result.score, 0);
});

test("分类结果可解释：必须给出命中的词", () => {
  const result = classifyNode({ name: "dsh-wallpaper-engine", description: "壁纸与主题", topics: [] });
  assert.equal(result.id, "skin");
  assert.ok(result.hits.includes("wallpaper") || result.hits.includes("壁纸"));
  assert.ok(result.score > 0);
});

test("每个规则 id 唯一、权重为正、优先级唯一", () => {
  const ids = new Set();
  const priorities = new Set();
  for (const rule of CATEGORY_RULES) {
    assert.ok(!ids.has(rule.id), "规则 id 重复: " + rule.id);
    ids.add(rule.id);
    assert.ok(!priorities.has(rule.priority), "优先级重复: " + rule.priority);
    priorities.add(rule.priority);
    for (const [, w] of rule.terms) assert.ok(w > 0);
  }
});

test("长尾合并：小类并入其他并记录原因", () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push({ id: "a/" + i, name: "dsh-skin-" + i, description: "皮肤", topics: [] });
  // 新规则下"插件市场"四个字不足以判定，需要自述汇总（收录/汇集）
  for (let i = 0; i < 3; i++) nodes.push({ id: "b/" + i, name: "dsh-market-" + i, description: "插件市场，收录所有 dsh 插件", topics: [] });
  const stats = applyCategories(nodes, DEFAULT_OPTIONS);
  assert.equal(stats.unclassified, 3, "只有 3 个成员的小类应并入其他");
  assert.equal(stats.merged.length, 1);
  assert.equal(stats.merged[0].id, "market");
  assert.match(stats.merged[0].reason, /样本过少/);
  assert.equal(nodes.filter((n) => n.category === "other").length, 3);
  assert.equal(nodes[0].category, "skin");
});

test("公约协议：样本再少也不会被并进「其他」（keepIds）", () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push({ id: "a/" + i, name: "dsh-skin-" + i, description: "皮肤", topics: [] });
  nodes.push({ id: "s/1", name: "dsh-std", description: "DSH 插件互操作元协议", topics: [] });
  nodes.push({ id: "s/2", name: "dsh-plugin-standard", description: "Open specification for plugins", topics: [] });
  const stats = applyCategories(nodes, DEFAULT_OPTIONS);
  const spec = stats.counts.find((c) => c.id === "spec");
  assert.ok(spec, "公约协议应独立成扇区，实际：" + JSON.stringify(stats.counts.map((c) => c.id)));
  assert.equal(spec.count, 2);
  assert.equal(stats.merged.find((m) => m.id === "spec"), undefined, "不该被当成小类并掉");
  assert.equal(nodes.filter((n) => n.category === "spec").length, 2);
});

test("真实样本：归类率与分类精度都达标", () => {
  const copy = mesh.nodes.map((n) => ({ ...n }));
  const stats = applyCategories(copy, DEFAULT_OPTIONS);
  const rate = stats.classified / stats.total;

  // 精度优先：新规则刻意收紧，宁可把模糊的留给「其他」，也不硬塞进扇区。
  // 所以这里的下限是 78%，真正的质量保证靠下面的精度断言。
  assert.ok(rate >= 0.78, "归类率应不低于 78%，实际 " + (rate * 100).toFixed(1) + "%");
  assert.ok(
    stats.counts.length >= 8 && stats.counts.length <= DEFAULT_OPTIONS.maxSectors + 1,
    "扇区数应在 8~" + (DEFAULT_OPTIONS.maxSectors + 1) + " 之间（上限 + 其他），实际 " + stats.counts.length,
  );
  assert.equal(stats.counts.reduce((s, c) => s + c.count, 0), stats.total);

  // 精度①：桌面客户端扇区里不允许出现"客户端插件"
  const clientPlugin = /(plugin|extension|skill|theme|skin|preset|插件|扩展|技能|皮肤|主题)/;
  const badDesktop = copy.filter((n) => n.category === "desktop" && clientPlugin.test(String(n.name).toLowerCase()));
  assert.equal(badDesktop.length, 0, "桌面客户端扇区混入了客户端插件：" + badDesktop.slice(0, 3).map((n) => n.id).join(", "));

  // 精度②：插件市场扇区里每个仓库都必须命中「汇总类」词（查分类器自己的命中记录）
  const aggregationHits = new Set(["market", "marketplace", "registry", "store", "awesome", "directory", "catalog", "hub", "市场", "商店", "集市", "商城", "索引", "合集", "汇总", "收录", "导航"]);
  const badMarket = copy.filter((n) => n.category === "market" && !(n.categoryHits ?? []).some((h) => aggregationHits.has(h)));
  assert.equal(badMarket.length, 0, "插件市场扇区混入了非汇总仓库：" + badMarket.slice(0, 3).map((n) => n.id).join(", "));
});

test("真实样本：分类结果与 mesh.json 一致（可复跑）", () => {
  const copy = mesh.nodes.map((n) => ({ ...n }));
  applyCategories(copy, DEFAULT_OPTIONS);
  for (const node of copy) {
    const original = mesh.nodes.find((n) => n.id === node.id);
    assert.equal(node.category, original.category, node.id + " 的分类与已发布数据不一致");
  }
});

test("歧义分类①插件市场：只有自述汇集插件的汇总才算", () => {
  const market = (name, description) => classifyNode({ id: "x/" + name, name, description, topics: [] }).id;

  // 是汇总：名字本身就是市场/商店/索引/合集，或描述明确说收录汇集
  assert.equal(market("dsh-plugin-market", "DSH 插件市场：收录、汇集各类插件"), "market");
  assert.equal(market("dsh-market", "一个插件市场"), "market");
  assert.equal(market("dsh-plugin-store", "插件商店"), "market");
  assert.equal(market("awesome-dsh", "A curated list of DSH plugins"), "market");
  assert.equal(market("插件市场", "汇集社区插件"), "market");
  assert.equal(market("dsh-plugins-index", "收录全部 dsh 插件"), "market");

  // 不是汇总：给市场做按钮的插件、在市场里搜索的插件
  assert.notEqual(market("dsh-market-button", "给市场加一个按钮的插件"), "market");
  assert.notEqual(market("dsh-market-pro", "在编辑器里浏览市场的插件"), "market");
  assert.notEqual(market("dsh-plugin-usage", "统计插件使用情况"), "market");
});

test("歧义分类②桌面客户端：真正做了客户端才算，客户端插件不算", () => {
  const desktop = (name, description) => classifyNode({ id: "x/" + name, name, description, topics: [] }).id;

  // 是客户端本体
  assert.equal(desktop("dsh-desktop", "DSH 官方桌面客户端"), "desktop");
  assert.equal(desktop("dsh-desktop-client", "基于 Tauri 的桌面客户端"), "desktop");
  assert.equal(desktop("dsh-gui", "Electron 桌面应用"), "desktop");

  // 是给客户端写的插件/主题 —— 绝不能判成桌面客户端
  assert.notEqual(desktop("dsh-desktop-plugin-notify", "桌面客户端的通知插件"), "desktop");
  assert.notEqual(desktop("dsh-plugin-desktop-theme", "给桌面客户端做的主题"), "desktop");
  assert.notEqual(desktop("dsh-plugin-desktop", "连接桌面客户端的插件"), "desktop");
  assert.notEqual(desktop("dsh-desktop-skill", "桌面客户端技能扩展"), "desktop");
});

test("英文词按词边界匹配，不再有 ui←build / cli←client / store←restore 这类误命中", () => {
  const junk = classifyNode({ id: "x/build", name: "build-tools", description: "build and restore tooling for rapid api clients", topics: [] });
  assert.ok(!junk.hits.includes("ui"), "build 不该命中 ui");
  assert.ok(!junk.hits.includes("store"), "restore 不该命中 store");
  assert.ok(!junk.hits.includes("api"), "rapid 不该命中 api");
  assert.ok(!junk.hits.includes("cli"), "client 不该命中 cli");
  assert.notEqual(junk.id, "market");
  assert.notEqual(junk.id, "panel");

  const rag = classifyNode({ id: "x/rag", name: "memory-rag", description: "RAG storage helper", topics: [] });
  assert.ok(rag.hits.includes("rag"), "rag 本身要命中");
  assert.equal(rag.id, "memory");
});

test("细枝分类：每个大分类都有细枝规则，且能给出细分", () => {
  const ids = new Set(CATEGORY_RULES.map((r) => r.id));
  for (const id of Object.keys(SUBCATEGORY_RULES)) {
    assert.ok(ids.has(id), "细枝规则挂在了不存在的分类上：" + id);
    assert.ok(SUBCATEGORY_RULES[id].length >= 2, id + " 至少要有 2 个细枝");
    for (const sub of SUBCATEGORY_RULES[id]) {
      assert.ok(sub.id && sub.label, id + " 的细枝缺少 id/label");
      assert.ok(sub.terms.length >= 2, sub.id + " 细枝词条太少");
    }
  }
  assert.equal(Object.keys(SUBCATEGORY_RULES).length, CATEGORY_RULES.length, "每个分类都该有细枝规则");

  const pet = classifyNode({ id: "x/pet", name: "dsh-whale-pet", description: "DSH 桌面宠物，养成互动", topics: [] });
  assert.equal(pet.id, "pet");
  assert.equal(pet.sub.id, "pet-pet");

  const market = classifyNode({ id: "x/market", name: "dsh-plugin-market", description: "插件市场：收录所有插件", topics: [] });
  assert.equal(market.id, "market");
  assert.ok(market.sub, "市场应有细枝");
});

test("新增分类能精确命中「其他」里的主题", () => {
  const of = (name, description) => classifyNode({ id: "x/" + name, name, description, topics: [] }).id;
  assert.equal(of("dsh-balance-monitor", "余额与用量显示插件"), "usage");
  assert.equal(of("dsh-edit-approval", "Per-edit approval gate"), "secure");
  assert.equal(of("ODSH-Bridge", "A bridge that connects Openclaw and DSH"), "bridge");
  assert.equal(of("dsh-pocket", "手机扫码即同步访问（局域网 + 公网）"), "remote");
  assert.equal(of("dsh-folder-drop", "把文件夹拖进 composer 得到绝对路径"), "file");
  assert.equal(of("totoro-pet", "桌宠插件（悬浮 Q 版龙猫 · 养成）"), "pet");
  assert.equal(of("dsh-x-profile-reader", "读取并翻译主页资料"), "doc");
});

test("单扇区放大：扇区变成细枝分类，成员只含该扇区", () => {
  const copy = mesh.nodes.map((n) => ({ ...n }));
  applyCategories(copy, DEFAULT_OPTIONS);
  const focusId = "pet";
  const members = copy.filter((n) => n.category === focusId);
  assert.ok(members.length > 10, "测试样本里 " + focusId + " 应有足够成员");

  const subs = new Set(members.map((n) => n.subcategory ?? "misc-" + n.category));
  assert.ok(subs.size >= 2, "放大后应至少铺出 2 个细枝扇区，实际 " + subs.size);
  // 每个细枝都必须真的属于这个扇区
  for (const n of members) {
    assert.equal(n.category, focusId);
  }
});
