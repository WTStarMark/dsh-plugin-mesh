/**
 * 噪声黑名单测试（v0.4.2）：
 * 判据 —— 同一作者被收录【超过 200】个仓库，且每个仓库星标都【低于 1】（默认全是 0 星）。
 * 命中者：从扫描管道剔除（后端已测），并且**不展示在前端**。
 * 前端这一道是"旧快照兜底"：数据文件里如果还留着它们，也不能画出来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepare, prepareCore, precomputedLayout, noiseOwners, stripNoiseOwners } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(readFileSync(join(ROOT, "data/mesh.json"), "utf8"));
const core = JSON.parse(readFileSync(join(ROOT, "data/mesh-core.json"), "utf8"));

const node = (owner, i, stars = 0, category = "tools") => ({
  id: owner + "/repo-" + i,
  name: "repo-" + i,
  owner,
  stars,
  category,
  categoryLabel: category,
  matchedTags: ["dsh"],
  primaryTag: "dsh",
  topics: ["dsh"],
  review: false,
  archived: false,
  pushedAt: "2026-01-01T00:00:00Z",
  language: "JavaScript",
});

test("判据：超过 200 个仓库且全是 0 星才算噪声，两个条件缺一不可", () => {
  const spam = Array.from({ length: 201 }, (_, i) => node("spammer", i));
  assert.deepEqual([...noiseOwners(spam).keys()], ["spammer"]);

  const exactly200 = Array.from({ length: 200 }, (_, i) => node("busy", i));
  assert.equal(noiseOwners(exactly200).size, 0, "正好 200 个不算「超过」");

  const oneStar = [...Array.from({ length: 250 }, (_, i) => node("productive", i)), node("productive", "hit", 1)];
  assert.equal(noiseOwners(oneStar).size, 0, "只要有一个仓库拿到星标就不判噪声");

  const mixed = [...spam, ...exactly200, node("normal", "x", 12)];
  const found = noiseOwners(mixed);
  assert.deepEqual([...found.keys()], ["spammer"]);
  assert.equal(found.get("spammer").repos, 201);
  assert.equal(found.get("spammer").maxStars, 0);
});

test("mesh.json 契约：剔除噪声作者及其边，并如实改掉计数", () => {
  const spam = Array.from({ length: 201 }, (_, i) => node("spammer", i));
  const data = {
    meta: { generatedAt: "2026-01-01T00:00:00Z", indexedNodes: 204, sampleNodes: 204, sampleEdges: 2 },
    nodes: [...spam, node("a", 1, 30), node("b", 1, 20), node("c", 1, 10)],
    clusters: [{ id: "tools", label: "工具命令", count: 204 }],
    edges: [
      { source: "a/repo-1", target: "b/repo-1", type: "topic" },
      { source: "a/repo-1", target: "spammer/repo-0", type: "topic" },
      { source: "spammer/repo-0", target: "spammer/repo-1", type: "owner" },
    ],
  };
  const out = stripNoiseOwners(data);
  assert.equal(out.nodes.length, 3);
  assert.ok(!out.nodes.some((n) => n.owner === "spammer"));
  assert.equal(out.edges.length, 1, "指向噪声节点的边必须一起删掉");
  assert.deepEqual(out.edges[0], { source: "a/repo-1", target: "b/repo-1", type: "topic" });
  assert.deepEqual(out.clusters, [{ id: "tools", label: "工具命令", count: 3 }]);
  assert.equal(out.meta.sampleNodes, 3);
  assert.equal(out.meta.sampleEdges, 1);
  assert.equal(out.meta.indexedNodes, 3);
  assert.equal(out.meta.noiseNodesRemoved, 201);
  assert.deepEqual(out.meta.noiseBlacklist.spammer, { repos: 201, maxStars: 0 });

  // 经由 prepare() 也不能留下悬空邻接
  const prepared = prepare(data);
  assert.equal(prepared.nodes.length, 3);
  for (const list of prepared.adjacency.values()) for (const nb of list) assert.ok(prepared.byId.has(nb.id));
  assert.ok(!prepared.owners.has("spammer"));
});

test("mesh-core.json 契约：删节点后索引与扇区成员必须重排", () => {
  const spam = Array.from({ length: 201 }, (_, i) => node("spammer", i));
  const data = {
    meta: { layout: "precomputed", generatedAt: "2026-01-01T00:00:00Z", indexedNodes: 205, sampleNodes: 205 },
    nodes: [node("a", 1, 30), ...spam, node("b", 1, 20), node("c", 1, 10), node("d", 1, 5)],
    clusters: [{ id: "tools", label: "工具命令", count: 205 }],
    // 下标：0=a，1..201=噪声，202=b，203=c，204=d
    arms: [{ id: "tools", label: "工具命令", count: 205, members: [0, 1, 2, 203, 204] }],
    edges: [
      [0, 202, 1], // a -> b（主题）
      [0, 1, 1], // a -> spam（必须删）
      [202, 204, 0], // b -> d（同作者）
    ],
  };
  const out = stripNoiseOwners(data);
  assert.equal(out.nodes.length, 4);
  assert.deepEqual(out.nodes.map((n) => n.id), ["a/repo-1", "b/repo-1", "c/repo-1", "d/repo-1"]);
  // 索引必须指向同一个人：重排后 0=a 1=b 2=c 3=d
  assert.deepEqual(out.edges, [[0, 1, 1], [1, 3, 0]]);
  // 保留 a(0) / c(2) / d(3) 三个成员，噪声成员全部滤掉
  assert.deepEqual(out.arms[0].members, [0, 2, 3], "扇区成员索引要跟着重排");
  assert.equal(out.arms[0].count, 3);
  assert.equal(out.meta.noiseNodesRemoved, 201);

  // 重排后的 core 必须能直接被 prepareCore + precomputedLayout 使用
  const prepared = prepareCore(out);
  const layout = precomputedLayout(out);
  assert.equal(layout.size, 4);
  for (const [a, b] of out.edges) {
    assert.ok(layout.nodes[a] && layout.nodes[b], "连线端点必须是有效索引");
    assert.ok(prepared.links.some((l) => l.a === a && l.b === b));
  }
  for (const arm of out.arms) for (const i of arm.members) assert.ok(layout.nodes[i], "扇区成员索引越界");
});

test("查询 API 也不吐噪声仓库（旧快照兜底）", async () => {
  const { createApi } = await import("../tools/api.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "mesh-noise-api-"));
  try {
    const spam = Array.from({ length: 201 }, (_, i) => node("spammer", i));
    const data = {
      meta: { generatedAt: "2026-01-01T00:00:00Z", kind: "hourly-crawl", note: "测试用", indexedNodes: 202 },
      tags: [],
      hubs: [],
      clusters: [{ id: "tools", label: "工具命令", count: 1 }],
      nodes: [...spam, node("normal", 1, 42)],
      edges: [],
    };
    mkdirSync(join(tmp, "data"), { recursive: true });
    writeFileSync(join(tmp, "data", "mesh.json"), JSON.stringify(data), "utf8");
    const api = createApi({ root: tmp });
    const found = await api.search(new URLSearchParams("limit=100"));
    assert.equal(found.total, 1, "接口不该再返回噪声仓库");
    assert.equal(found.items[0].id, "normal/repo-1");
    const one = await api.one("spammer", "repo-0");
    assert.equal(one, null, "噪声仓库的详情接口应查不到");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("真实数据没有噪声作者：stripNoiseOwners 必须是零成本的空操作", () => {
  assert.equal(stripNoiseOwners(mesh), mesh, "mesh.json 不该被复制重建");
  assert.equal(stripNoiseOwners(core), core, "mesh-core.json 不该被复制重建");
  assert.equal(noiseOwners(mesh.nodes).size, 0);
});

test("预计算产物：喂进去的噪声作者不会出现在 mesh-core.json 里", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mesh-noise-"));
  try {
    const spam = Array.from({ length: 201 }, (_, i) => node("spammer", i));
    const normal = Array.from({ length: 12 }, (_, i) => node("normal" + i, 1, 100 - i, i % 2 ? "tools" : "ui"));
    const input = {
      meta: { generatedAt: "2026-01-01T00:00:00Z", kind: "hourly-crawl", indexedNodes: 213, sampleNodes: 213, sampleEdges: 0, seed: "noise-test" },
      tags: [],
      hubs: [],
      clusters: [{ id: "tools", label: "工具命令", count: 201 + 6 }, { id: "ui", label: "界面面板", count: 6 }],
      nodes: [...spam, ...normal],
      edges: [],
    };
    const inPath = join(tmp, "mesh.json");
    writeFileSync(inPath, JSON.stringify(input), "utf8");
    execFileSync(process.execPath, [join(ROOT, "tools/precompute-layout.mjs"), "--in", inPath, "--out", join(tmp, "out"), "--chunks", "2"], { cwd: ROOT, stdio: "pipe" });
    const out = JSON.parse(readFileSync(join(tmp, "out", "mesh-core.json"), "utf8"));
    assert.ok(!out.nodes.some((n) => n.owner === "spammer"), "预计算产物里不能有噪声作者");
    assert.equal(out.nodes.length, 12);
    assert.equal(out.meta.noiseNodesRemoved, 201, "meta 要如实记录剔除了多少");
    for (const arm of out.arms) for (const i of arm.members) assert.ok(out.nodes[i], "扇区成员索引越界");
    const details = JSON.parse(readFileSync(join(tmp, "out", "details", "0.json"), "utf8"));
    const all = { ...details, ...JSON.parse(readFileSync(join(tmp, "out", "details", "1.json"), "utf8")) };
    assert.ok(!Object.keys(all).some((id) => id.startsWith("spammer/")), "详情分片里也不该有噪声仓库");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
