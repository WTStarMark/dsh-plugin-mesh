/**
 * 生态共鸣测试（v0.4.3）：
 * 「生态共鸣」不是规则推导的边，而是人工策展 + README 复核出来的"谁长在谁上面"。
 * 这里守住三件事：清单本身自洽、数据里的边与清单一致、前端认识这个新类型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_STYLES, EDGE_TYPE_BY_CODE, prepare, prepareCore } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eco = JSON.parse(readFileSync(join(ROOT, "tools/ecosystem.json"), "utf8"));
const mesh = JSON.parse(readFileSync(join(ROOT, "data/mesh.json"), "utf8"));
const core = JSON.parse(readFileSync(join(ROOT, "data/mesh-core.json"), "utf8"));

test("清单自洽：每个基座都有标签与证据，子节点不重复、不指向自己", () => {
  assert.ok((eco.bases ?? []).length >= 3, "至少应有三条基座");
  for (const base of eco.bases) {
    assert.ok(base.id && base.label, "基座缺少 id/label：" + JSON.stringify(base));
    // 允许"已启用但暂时没有子项"的基座（等新格式公开）；有子项时仍逐条校验证据链
    assert.ok(Array.isArray(base.verified), base.id + " verified 必须是数组");
    const seen = new Set();
    for (const v of base.verified) {
      assert.ok(v.id && v.id !== base.id, base.id + " 的子节点非法：" + v.id);
      assert.ok(!seen.has(v.id), base.id + " 的子节点重复：" + v.id);
      seen.add(v.id);
      assert.ok(Array.isArray(v.signals) && v.signals.length > 0, v.id + " 缺少归属信号");
      assert.ok(v.readme, v.id + " 缺少 README 复核证据（提到的是哪个词）");
    }
  }
});

test("策展基座在数据里必须归入「协议基座」", () => {
  const byId = new Map(mesh.nodes.map((n) => [n.id, n]));
  let checked = 0;
  for (const base of eco.bases) {
    const node = byId.get(base.id);
    if (!node) continue; // 该基座不在当前数据里（本地快照可能没有）
    checked += 1;
    assert.equal(node.category, "spec", base.id + " 是策展认定的生态基座，应归入协议基座，实际 " + node.category);
    assert.equal(node.categoryCurated, true, base.id + " 应带 categoryCurated 标记（便于排查它为何在协议基座）");
  }
  assert.ok(checked > 0, "当前数据里应至少有一个策展基座");
});

test("临时关闭的基座（enabled: false）不建共鸣边，但基座身份不变", () => {
  const disabled = eco.bases.filter((b) => b.enabled === false);
  // 不假定"清单里一定有关闭的基座"（那是数据状态，会随运营变化）：
  // 有关闭的就验证规则，没有就验证 meta 如实为空。
  if (disabled.length === 0) {
    assert.deepEqual(mesh.meta.ecosystemDisabled ?? [], [], "没有关闭的基座时 meta.ecosystemDisabled 应为空");
    for (const base of eco.bases) {
      // 只看"有已核验子项"的基座：启用但暂时没有子项的基座（等新格式公开）不该硬要求有边
      if ((base.verified ?? []).length === 0) continue;
      const edges = (mesh.edges ?? []).filter((e) => e.type === "resonance" && (e.source === base.id || e.target === base.id));
      assert.ok(edges.length > 0, base.id + " 已启用且有子项，应画出共鸣边");
    }
    return;
  }
  const ids = new Set(mesh.nodes.map((n) => n.id));
  for (const base of disabled) {
    const edges = (mesh.edges ?? []).filter((e) => e.type === "resonance" && (e.source === base.id || e.target === base.id));
    assert.equal(edges.length, 0, base.id + " 已关闭，不该还有共鸣边");
    // 但"它是基座"这件事不受影响：仍然归入协议基座
    const node = mesh.nodes.find((n) => n.id === base.id);
    if (node) assert.equal(node.category, "spec", base.id + " 虽关闭共鸣，仍应是协议基座");
  }
  assert.ok((mesh.meta.ecosystemDisabled ?? []).includes(disabled[0].id), "meta.ecosystemDisabled 应记录被关闭的基座");
});

test("数据落地：mesh.json 的共鸣边 = 清单（启用的基座）∩ 图内节点", () => {
  const ids = new Set(mesh.nodes.map((n) => n.id));
  const expected = new Set();
  for (const base of eco.bases) {
    if (base.enabled === false) continue; // 临时关闭的基座不建边
    if (!ids.has(base.id)) continue;
    for (const v of base.verified) if (ids.has(v.id)) expected.add(base.id + " → " + v.id);
  }
  const actual = new Set(
    (mesh.edges ?? []).filter((e) => e.type === "resonance").map((e) => e.source + " → " + e.target),
  );
  assert.deepEqual([...actual].sort(), [...expected].sort(), "共鸣边与策展清单不一致");
  assert.equal(mesh.meta.resonanceEdges, actual.size, "meta.resonanceEdges 应与实际边数一致");
  // 每条共鸣边都要带得上基座标签（右栏文案要用）
  for (const e of (mesh.edges ?? []).filter((x) => x.type === "resonance")) {
    assert.ok(Array.isArray(e.via) && e.via.length > 0, "共鸣边缺少 via 标签：" + e.source);
  }
});

test("预计算契约：共鸣边的类型码可编码可解码", () => {
  assert.equal(EDGE_TYPE_BY_CODE[4], "resonance", "类型码 4 必须留给 resonance（新增只能往后追加）");
  assert.equal(EDGE_TYPE_BY_CODE[0], "owner");
  const code = EDGE_TYPE_BY_CODE.indexOf("resonance");
  const encoded = core.edges.filter((e) => e[2] === code).length;
  assert.equal(encoded, mesh.meta.resonanceEdges, "core 里的共鸣边数量应与 mesh 一致");
  const prepared = prepareCore(core);
  assert.equal(prepared.links.filter((l) => l.type === "resonance").length, encoded);
  // 邻接表里也要有，右栏「关联」才列得出来
  const base = eco.bases.find((b) => core.nodes.some((n) => n.id === b.id));
  const list = prepared.adjacency.get(base.id) ?? [];
  assert.ok(list.some((x) => x.type === "resonance"), base.id + " 的邻接表里应有生态共鸣");
});

test("样式与图例：共鸣边有独立颜色，且与同作者/主题共现都不同", () => {
  const style = EDGE_STYLES.resonance;
  assert.ok(style, "缺少 EDGE_STYLES.resonance");
  assert.equal(style.label, "生态共鸣");
  assert.match(style.color, /^#[0-9a-f]{6}$/i);
  assert.notEqual(style.color.toLowerCase(), String(EDGE_STYLES.topic.color).toLowerCase());
  assert.equal(style.dash.length, 0, "共鸣边画实线，避免和琥珀虚线的主题共现混淆");
});

test("prepare() 之后：共鸣边两端都还在节点集合里（不悬空）", () => {
  const prepared = prepare(mesh);
  for (const e of mesh.edges.filter((x) => x.type === "resonance")) {
    assert.ok(prepared.byId.has(e.source), "悬空 source: " + e.source);
    assert.ok(prepared.byId.has(e.target), "悬空 target: " + e.target);
  }
});
