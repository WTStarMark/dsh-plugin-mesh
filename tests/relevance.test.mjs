/**
 * 相关性判定测试（v0.4.2）：把"疑似噪声"拆成三档结论
 *   related（有 DSH 专有线索）/ noise（确认噪声）/ manual（仍需人工）
 * 目标：待复核队列显著缩小，且不能把真插件误判成噪声。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRelevance, relevanceScore } from "../tools/relevance.mjs";
import { prepareCore } from "../src/mesh-data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mesh = JSON.parse(readFileSync(join(ROOT, "data/mesh.json"), "utf8"));
const core = JSON.parse(readFileSync(join(ROOT, "data/mesh-core.json"), "utf8"));

const repo = (over = {}) => ({ name: "x", description: "", topics: [], matchedTags: ["dsh"], stars: 0, ...over });

test("related：名字/描述/主题里有 DSH 专有线索就直接算相关", () => {
  assert.equal(analyzeRelevance(repo({ name: "dsh-skin-pack" })).verdict, "related");
  assert.equal(analyzeRelevance(repo({ name: "my-plugin", description: "A plugin for DeepSeek Harness" })).verdict, "related");
  assert.equal(analyzeRelevance(repo({ name: "my-plugin", description: "基于 Cordis 的插件" })).verdict, "related");
  assert.equal(analyzeRelevance(repo({ name: "cool-thing", topics: ["deepseek-harness"] })).verdict, "related");
  // 只有 deepseek（模型/公司）不算 DSH 专有线索，别把模型仓库当成插件
  assert.notEqual(analyzeRelevance(repo({ name: "deepseek-balance", topics: ["deepseek"] })).verdict, "related");
});

test("noise：空壳 / 堆标签 / 蹭其他生态标签 / 只挂最宽泛的 dsh", () => {
  const shell = analyzeRelevance(repo({ name: "law-thesis-review", description: "", stars: 0, matchedTags: ["dsh-plugin", "dsh-plugins", "dsh-plugin-market"] }));
  assert.equal(shell.verdict, "noise");
  assert.match(shell.reason, /DSH 标签|空壳/);

  const stuffer = analyzeRelevance(repo({ name: "enterprise-compliance", description: "enterprise-compliance", matchedTags: ["dsh", "dsh-plugin", "dsh-plugins", "dsh-plugin-market"] }));
  assert.equal(stuffer.verdict, "noise", "挂了 4 个标签却没有任何插件线索：" + JSON.stringify(stuffer));

  const eco = analyzeRelevance(repo({ name: "marketplace", description: "plugin marketplace", topics: ["claude-code-plugin", "codex-plugin", "dsh-plugin"] }));
  assert.equal(eco.verdict, "noise");
  assert.match(eco.reason, /其他插件生态/);

  const unrelated = analyzeRelevance(repo({ name: "reactive-resume", description: "A one-of-a-kind resume builder", stars: 43705, matchedTags: ["dsh"] }));
  assert.equal(unrelated.verdict, "noise", "流行项目蹭 dsh 标签也算噪声");
  assert.match(unrelated.reason, /只挂 1 个/);
});

test("manual：真像插件、只是没提 DSH 的，留给人工，不误杀", () => {
  const plugin = analyzeRelevance(repo({ name: "task-board-plugin", description: "A task board plugin for agents", matchedTags: ["dsh-plugin"] }));
  assert.equal(plugin.verdict, "manual");
  assert.equal(plugin.review, true);
  assert.match(plugin.reason, /人工/);

  const skill = analyzeRelevance(repo({ name: "browser-skill", description: "Let agents use your real browser", matchedTags: ["dsh"] }));
  assert.equal(skill.verdict, "manual", "名字里有 Skill 的不该被当成噪声");
});

test("三档结论互斥且覆盖全部：review 只在 manual 档为真", () => {
  for (const n of mesh.nodes) {
    const v = analyzeRelevance(n);
    assert.ok(["related", "noise", "manual"].includes(v.verdict), "未知档位：" + v.verdict);
    assert.equal(v.review, v.verdict === "manual");
    assert.ok(typeof v.reason === "string" && v.reason.length > 0);
    assert.equal(typeof v.relevance, "number");
    assert.equal(v.relevance, relevanceScore(n));
  }
});

test("真实数据：待复核队列比旧口径（相关度<=2）明显缩小", () => {
  const oldQueue = mesh.nodes.filter((n) => n.relevance <= 2).length;
  const now = mesh.nodes.filter((n) => n.review).length;
  assert.ok(oldQueue > 0, "样本里应有旧口径的待复核仓库");
  assert.ok(now < oldQueue, "新口径应把能定性的先定掉：" + now + " vs " + oldQueue);
  const noise = mesh.nodes.filter((n) => n.verdict === "noise").length;
  assert.ok(noise > 0, "样本里应有确认噪声");
  assert.equal(now + noise + mesh.nodes.filter((n) => n.verdict === "related").length, mesh.nodes.length, "三档必须覆盖全部节点");
});

test("前端契约：prepareCore 暴露确认噪声列表，且与 verdict 一致", () => {
  const prepared = prepareCore(core);
  assert.equal(prepared.noise.length, core.nodes.filter((n) => n.verdict === "noise").length);
  assert.ok(prepared.noise.every((n) => n.verdict === "noise"));
  assert.ok(prepared.review.every((n) => n.verdict === "manual" || n.verdict === undefined));
  // 列表按星标降序，面板直接截前几个展示
  const stars = prepared.noise.map((n) => n.stars);
  assert.deepEqual(stars, [...stars].sort((a, b) => b - a));
});
