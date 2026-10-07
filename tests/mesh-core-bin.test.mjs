/**
 * 二进制契约 mesh-core.bin 的测试（v0.4.8）。
 *
 * 这是"换契约"的改动，所以验证方式是把【真实 core JSON】编成二进制再解回来，
 * 逐节点逐字段比对：允许的差异只有三类（已量化/已归一/已降精度），其余必须完全一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BIN_MAGIC, CORE_BIN_VERSION, AVATAR_SIZE, avatarIdOf, avatarUrlOf, decodeCore, encodeCore, subsetCore } from "../src/mesh-core-bin.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonBytes = await readFile(resolve(ROOT, "data/mesh-core.json"));
const core = JSON.parse(jsonBytes.toString("utf8"));
const bin = encodeCore(core);
const back = decodeCore(bin);

test("往返回收：节点/连线/扇区数量与结构完全一致", () => {
  assert.equal(back.nodes.length, core.nodes.length);
  assert.equal(back.edges.length, core.edges.length);
  assert.equal(back.arms.length, core.arms.length);
  assert.equal(
    back.arms.reduce((s, a) => s + a.members.length, 0),
    core.arms.reduce((s, a) => s + a.members.length, 0),
  );
  for (let i = 0; i < core.edges.length; i++) {
    assert.deepEqual(back.edges[i], core.edges[i], "第 " + i + " 条连线应完全一致");
  }
  for (let i = 0; i < core.arms.length; i++) {
    assert.equal(back.arms[i].id, core.arms[i].id);
    assert.deepEqual(back.arms[i].members, core.arms[i].members, "扇区 " + core.arms[i].id + " 成员索引应一致");
  }
  assert.equal(back.meta.generatedAt, core.meta.generatedAt);
});

test("往返回收：每个节点每个字段都一致（只允许量化/归一/降精度三类差异）", () => {
  const canonAvatar = (u) => avatarUrlOf(avatarIdOf(u)) ?? u ?? null;
  const canonDay = (v) => (v ? String(v).slice(0, 10) : null);
  const near = (a, b, tol) => Math.abs((a ?? 0) - (b ?? 0)) <= tol;
  const problems = new Map();
  for (let i = 0; i < core.nodes.length; i++) {
    const a = core.nodes[i];
    const b = back.nodes[i];
    for (const k of Object.keys(a)) {
      let ok;
      if (k === "avatar") ok = canonAvatar(a.avatar) === b.avatar;
      else if (k === "pushedAt") ok = canonDay(a.pushedAt) === canonDay(b.pushedAt);
      else if (k === "archived" || k === "fork" || k === "noise" || k === "review") ok = !!a[k] === !!b[k];
      else if (k === "x" || k === "y" || k === "r") ok = near(a[k], b[k], 0.15);
      else if (k === "categoryScore") ok = near(a[k], b[k], 0.01);
      else if (k === "forks") ok = (a[k] ?? 0) === b[k] || ((a[k] ?? 0) > 65535 && b[k] === 65535);
      else ok = JSON.stringify(a[k]) === JSON.stringify(b[k]);
      if (!ok) {
        problems.set(k, (problems.get(k) ?? 0) + 1);
        if (problems.get(k) === 1) assert.fail("字段 " + k + " 不一致：" + a.id + " " + JSON.stringify(a[k]) + " ≠ " + JSON.stringify(b[k]));
      }
    }
    assert.equal(Object.keys(b).length, Object.keys(a).length, "字段个数应一致：" + a.id);
  }
  assert.equal(problems.size, 0, "不一致字段：" + [...problems.keys()].join(", "));
});

test("体积：二进制明显小于 JSON，主干分片再小一截", (t) => {
  if ((core.nodes ?? []).length <= 3000) {
    t.skip("数据集不足 3000 节点：主干分片就等于整份，这项体积断言在限扫数据上没有意义");
    return;
  }
  const jsonBr = brotliCompressSync(jsonBytes).length;
  const binBr = brotliCompressSync(bin).length;
  const head = subsetCore(core, 3000);
  const headBr = brotliCompressSync(encodeCore(head)).length;
  assert.ok(bin.length < jsonBytes.length / 6, "二进制原始体积应小于 JSON 的 1/6：实际 " + bin.length + " vs " + jsonBytes.length);
  assert.ok(binBr < jsonBr * 0.8, "二进制 brotli 应明显小于 JSON brotli：实际 " + binBr + " vs " + jsonBr);
  assert.ok(headBr < binBr * 0.4, "主干分片（3000 个）应远小于整份：实际 " + headBr + " vs " + binBr);
  assert.equal(head.meta.partial, true);
  assert.equal(head.nodes.length, 3000);
  assert.ok(encodeCore(head).length > 0);
  void gzipSync(bin); // 顺带确认可再次压缩而不抛错
});

test("边界：少于分片上限时 subsetCore 原样返回；异常字段不炸", () => {
  const tiny = { meta: {}, tags: {}, hubs: [], clusters: [], arms: [], nodes: [{ id: "a/b", x: 1, y: 2, r: 3, stars: 1 }], edges: [] };
  assert.equal(subsetCore(tiny, 10), tiny, "节点数不超过上限时应原样返回");

  const weird = {
    meta: {},
    tags: {},
    hubs: [],
    clusters: [],
    arms: [{ id: "s", members: [0] }],
    nodes: [
      { id: "no-slash", x: -0.004, y: 0, r: 0.1, stars: 0, pushedAt: null, language: null, avatar: "https://example.com/x.png", matchedTags: [], categoryHits: [] },
      { id: "b/c", x: 0, y: 0, r: 1, stars: 4294967295, forks: 999999, pushedAt: "not-a-date", matchedTags: ["a", "b"] },
    ],
    edges: [[0, 1, 2]],
  };
  const rt = decodeCore(encodeCore(weird));
  assert.equal(rt.nodes[0].id, "no-slash");
  assert.equal(rt.nodes[0].name, "no-slash", "没有斜杠时 name 退回整个 id");
  assert.equal(rt.nodes[0].owner, "no-slash");
  assert.equal(rt.nodes[0].avatar, "https://example.com/x.png", "非标准头像走例外表原样保留");
  assert.equal(rt.nodes[0].pushedAt, null);
  assert.equal(rt.nodes[1].forks, 65535, "超出 Uint16 的上限截断");
  assert.equal(rt.nodes[1].pushedAt, null, "时间解析失败记 0 → null");
  assert.deepEqual(rt.edges[0], [0, 1, 2]);
});

test("魔数与版本：对不上要明确报错，而不是解出垃圾数据", () => {
  assert.equal(CORE_BIN_MAGIC, "MESHCORE");
  assert.equal(CORE_BIN_VERSION, 1);
  assert.equal(AVATAR_SIZE, 64);
  const bad = bin.slice();
  bad[0] = 0x58; // 改魔数
  assert.throws(() => decodeCore(bad), /不是 mesh-core/);
  const badVersion = bin.slice();
  new DataView(badVersion.buffer).setUint16(8, 99, true);
  assert.throws(() => decodeCore(badVersion), /版本不匹配/);
});
