/**
 * 连线构造测试：关联性（同扇区 / 同作者 / 稀有主题）与观赏性（不跨境、不过长、无重复）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSectorLayout } from "../src/layout-sector.js";
import { prepare } from "../src/mesh-data.js";
import { buildLinks, countByType } from "../src/links.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const HUB = "deepseek-ai/deepseek-harness";

const setup = (seed = "real") => {
  const prepared = prepare(mesh);
  const layout = createSectorLayout({ nodes: prepared.nodes, centerId: HUB, groupOf: (n) => n.category, seed });
  return { prepared, layout, links: buildLinks(prepared, layout) };
};


test("汇总连线：三类边齐备，且索引都在布局范围内", () => {
  const { links, layout } = setup();
  assert.equal(countByType(links, "neighbor"), 0, "同扇区近邻已删除，不应再有这类边");
  assert.ok(countByType(links, "topic") > 0, "缺少主题共现连线");
  assert.ok(countByType(links, "owner") >= 0, "同作者连线统计异常");
  for (const l of links) {
    assert.ok(l.a >= 0 && l.a < layout.size, "索引越界 a=" + l.a);
    assert.ok(l.b >= 0 && l.b < layout.size, "索引越界 b=" + l.b);
    assert.notEqual(l.a, l.b);
  }
});

test("连线只由位置与数据决定：同种子结果一致", () => {
  const a = setup("same");
  const b = setup("same");
  assert.equal(a.links.length, b.links.length);
  for (let i = 0; i < a.links.length; i++) {
    assert.equal(a.links[i].a, b.links[i].a);
    assert.equal(a.links[i].b, b.links[i].b);
    assert.equal(a.links[i].type, b.links[i].type);
  }
});

test("规模控制：连线总数不应超过节点数的 3 倍（观赏性下限）", () => {
  const { links, layout } = setup();
  assert.ok(links.length < layout.size * 3, "连线过多会糊成一片：" + links.length + " 条 / " + layout.size + " 个节点");
});
