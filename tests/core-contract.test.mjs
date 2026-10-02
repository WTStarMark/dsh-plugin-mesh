/**
 * 预计算契约的"字段可用性"回归测试。
 * 背景：htmlUrl 被丢进 DROP_FIELDS 后，右栏「在 GitHub 打开」变成了没有 href 的死链；
 *      pushedAt 被挪进详情分片后，「最近推送」筛选会把所有节点过滤掉。
 * 这类 bug 的共性是"前端还在读，但数据已经不在了"，所以这里做机器化检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCore, precomputedLayout } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = JSON.parse(await readFile(join(ROOT, "data/mesh-core.json"), "utf8"));
const full = JSON.parse(await readFile(join(ROOT, "data/mesh.json"), "utf8"));
const detailDir = join(ROOT, "data/details");
const detailFiles = await readdir(detailDir);
const detailKeys = new Set();
for (const f of detailFiles.slice(0, 2)) {
  const bucket = JSON.parse(await readFile(join(detailDir, f), "utf8"));
  for (const v of Object.values(bucket)) for (const k of Object.keys(v)) detailKeys.add(k);
}

test("核心路径下 node.pushedAt 必须可用（否则「最近推送」筛选会清空整张图）", () => {
  const missing = core.nodes.filter((n) => !n.pushedAt).length;
  assert.equal(missing, 0, "有 " + missing + " 个节点缺 pushedAt");
  // 筛选逻辑的等价复现：pushedDays>0 时，缺时间戳的会被 continue 掉
  const now = Date.now();
  const kept = core.nodes.filter((n) => {
    const ts = n.pushedAt ? Date.parse(n.pushedAt) : 0;
    return ts && now - ts <= 90 * 86400000;
  });
  assert.ok(kept.length > core.nodes.length * 0.2, "按最近 90 天筛选后应仍有一批节点，实际 " + kept.length + "/" + core.nodes.length);
});

test("前端读取的字段必须能在 core 或详情分片里找到", async () => {
  const fullKeys = new Set(Object.keys(full.nodes[0]));
  const coreKeys = new Set(Object.keys(core.nodes[0]));
  const srcFiles = (await readdir(join(ROOT, "src"))).filter((f) => f.endsWith(".js"));
  const code = (await Promise.all(srcFiles.map((f) => readFile(join(ROOT, "src", f), "utf8")))).join("\n");
  // 有意丢弃、但前端能自行推导的字段（改这里必须同时改推导处）
  const DERIVED = new Set(["htmlUrl"]); // -> node.htmlUrl ?? "https://github.com/" + node.id
  const broken = [];
  for (const key of fullKeys) {
    if (coreKeys.has(key) || detailKeys.has(key) || DERIVED.has(key)) continue;
    // 该字段被丢弃了 —— 前端若仍在读 node.<key> 就会失效
    if (new RegExp("node\\." + key + "\\b|n\\." + key + "\\b").test(code)) broken.push(key);
  }
  assert.deepEqual(broken, [], "这些字段前端在读但数据里没有：" + broken.join(", "));
});

test("仓库链接：没有 htmlUrl 也要能从 id 推导出可点的 GitHub 地址", () => {
  const hub = core.nodes.find((n) => n.id === "deepseek-ai/deepseek-harness");
  assert.ok(hub, "样本里应有官方仓库");
  const href = hub.htmlUrl ?? "https://github.com/" + hub.id;
  assert.equal(href, "https://github.com/deepseek-ai/deepseek-harness");
  const p = prepareCore(core);
  const node = p.byId.get(hub.id);
  assert.equal(node.htmlUrl ?? "https://github.com/" + node.id, href, "经 prepareCore 后仍应推导出同一地址");
  assert.ok(precomputedLayout(core).index.has(hub.id));
});
