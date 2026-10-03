/**
 * 同作者完整性回归（v0.4.2）：
 * 数据层为了控制载荷，对成员超过 OWNER_CLIQUE_MAX 的作者只写"星形拓扑"
 * （枢纽连所有人、其余人只连枢纽）。只看存下来的边，画布上就会出现
 * 「几个同作者仓库里，有的能连到其余全部、有的只连到一个」。
 * 前端改用 owner 索引还原完整关系，这里把这条规矩钉死。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepare, prepareCore, ownerSiblings } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
const core = JSON.parse(await readFile(resolve(ROOT, "data/mesh-core.json"), "utf8"));

/** owner -> 仓库 id 列表（直接来自节点数据，与存边无关） */
const groupByOwner = (nodes) => {
  const map = new Map();
  for (const n of nodes) {
    const list = map.get(n.owner);
    if (list) list.push(n.id);
    else map.set(n.owner, [n.id]);
  }
  return map;
};

/** 存边里每个节点的同作者边数（星形拓扑下非枢纽成员只有 1 条） */
const storedOwnerDegree = (coreData) => {
  const degree = new Map();
  const nodes = coreData.nodes ?? [];
  for (const [a, b, code] of coreData.edges ?? []) {
    if (code !== 0) continue; // 0 = owner
    degree.set(nodes[a].id, (degree.get(nodes[a].id) ?? 0) + 1);
    degree.set(nodes[b].id, (degree.get(nodes[b].id) ?? 0) + 1);
  }
  return degree;
};

for (const [label, prepared, groups] of [
  ["mesh.json", prepare(mesh), groupByOwner(mesh.nodes)],
  ["mesh-core.json", prepareCore(core), groupByOwner(core.nodes)],
]) {
  test(label + "：每个仓库都能指向其余全部同作者仓库", () => {
    let multi = 0;
    for (const [owner, ids] of groups) {
      if (ids.length < 2) continue;
      multi += 1;
      for (const id of ids) {
        const siblings = ownerSiblings(prepared, id);
        assert.equal(siblings.length, ids.length - 1, owner + " / " + id + " 的同作者兄弟数不对");
        assert.ok(!siblings.includes(id), "同作者兄弟里不应包含自己：" + id);
        for (const other of ids) {
          if (other === id) continue;
          assert.ok(siblings.includes(other), owner + " / " + id + " 漏掉了同作者仓库 " + other);
        }
      }
    }
    assert.ok(multi > 10, "样本里多仓库作者太少：" + multi);
  });
}

test("回归：星形拓扑的大作者，前端也必须补成完整关系", () => {
  const prepared = prepareCore(core);
  const groups = groupByOwner(core.nodes);
  const big = [...groups.entries()].filter(([, ids]) => ids.length > 8);
  assert.ok(big.length > 0, "样本里应有成员超过 8 的作者（星形拓扑的那批）");

  const stored = storedOwnerDegree(core);
  let starOnly = 0;
  for (const [owner, ids] of big) {
    for (const id of ids) {
      if ((stored.get(id) ?? 0) < ids.length - 1) starOnly += 1; // 存边连不全 = 星形拓扑的非枢纽成员
      assert.equal(ownerSiblings(prepared, id).length, ids.length - 1, owner + " / " + id + " 没有被补全");
    }
  }
  assert.ok(starOnly > 0, "样本里应真的存在连不全的成员，否则这条回归没有意义");
});

test("ownerPairs 与逐个 ownerSiblings 的结果一致（图例计数用的就是它）", () => {
  const prepared = prepare(mesh);
  let sum = 0;
  for (const id of prepared.byId.keys()) sum += ownerSiblings(prepared, id).length;
  assert.equal(sum % 2, 0, "同作者关系必然是成对的");
  assert.equal(sum / 2, prepared.ownerPairs, "完整同作者关系对数与图例计数不一致");
  assert.ok(prepared.ownerPairs >= (mesh.meta.ownerEdges ?? 0), "完整关系数不应少于存边里的同作者边数");
});

test("边界：没有同作者伙伴 / 未知 id / 缺 prepared 都不抛错", () => {
  const prepared = prepare(mesh);
  const single = prepared.nodes.find((n) => ownerSiblings(prepared, n.id).length === 0);
  assert.ok(single, "样本里应至少有一个独立作者");
  assert.deepEqual(ownerSiblings(prepared, single.id), []);
  assert.deepEqual(ownerSiblings(prepared, "不存在的/仓库"), []);
  assert.deepEqual(ownerSiblings(null, "任意"), []);
  assert.deepEqual(ownerSiblings({}, "任意"), []);
});
