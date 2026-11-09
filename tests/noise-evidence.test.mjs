import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRelevance } from "../tools/relevance.mjs";
import { normalizeReadme, readmeHit, applyEvidence, stripEvidence } from "../tools/noise-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Python analyze_relevance 的逐条对照（跨语言一致性：同一批证据字段必须给出同一结论）。 */
function pyAnalyze(repo) {
  const script = [
    "import sys, json",
    "sys.path.insert(0, 'backend')",
    "from dsh_mesh.build import analyze_relevance",
    "repo = json.load(sys.stdin)",
    "print(json.dumps(analyze_relevance(repo), ensure_ascii=False))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script], { input: JSON.stringify(repo), encoding: "utf8", cwd: ROOT }));
}

const BASE = { name: "some-repo", description: "", topics: ["dsh-plugin"], matchedTags: ["dsh-plugin"], stars: 0 };

const CASES = [
  { ...BASE },
  { ...BASE, manifestOk: true },
  { ...BASE, manifestOk: true, readmeHit: false },
  { ...BASE, readmeHit: true },
  { ...BASE, readmeHit: false },
  { ...BASE, readmeHit: null },
  { ...BASE, name: "nice-plugin", description: "我的漂亮工具插件", topics: [], matchedTags: ["dsh-plugin"], stars: 3, readmeHit: false },
  { ...BASE, name: "nice-plugin", description: "一个 skill 工具", topics: [], matchedTags: [], stars: 3, readmeHit: false },
  { ...BASE, name: "dsh-tool", description: "workspace 工具", topics: [], matchedTags: [], stars: 42, readmeHit: false },
  { ...BASE, name: "dsh-tool", description: "workspace 工具", topics: [], matchedTags: [], stars: 42, readmeHit: true },
  { ...BASE, topics: ["dsh-plugin", "claude-plugin", "cursor-plugin"], manifestOk: true },
  { ...BASE, description: " Agents 数据面板 ", readmeHit: false },
  { ...BASE, name: "nice-tool", description: "工具", matchedTags: ["dsh-plugin"], stars: 3, readmeHit: false, readmeDigest: "fe claude-code 的插件安装与 smithery 市集" },
  { ...BASE, name: "dsh-tool", description: "工具", matchedTags: [], stars: 42, readmeHit: false, readmeDigest: "fe mcp server for claude-code" },
  { ...BASE, manifestOk: true, readmeHit: false, readmeDigest: "claude-code 插件但 manifest 确认过" },
];

test("证据规则：JS 与 Python 两份实现逐条同结论", () => {
  for (const repo of CASES) {
    const js = analyzeRelevance(structuredClone(repo));
    const py = pyAnalyze(structuredClone(repo));
    assert.deepEqual({ verdict: js.verdict, reason: js.reason, review: js.review, relevance: js.relevance },
      { verdict: py.verdict, reason: py.reason, review: py.review, relevance: py.relevance },
      "JS/Python 结论不一致：" + JSON.stringify(repo));
  }
});

test("证据规则语义：manifest/README 正证据 → related；README 反证 + 非插件形态 → noise；否则保持老口径", () => {
  assert.equal(analyzeRelevance({ ...BASE, manifestOk: true }).verdict, "related");
  assert.equal(analyzeRelevance({ ...BASE, readmeHit: true }).verdict, "related");
  assert.equal(analyzeRelevance({ ...BASE, readmeHit: false }).verdict, "noise");
  // 正文像插件但没提 DSH（README 反证）仍留人工，宁可漏判不给用户藏错
  const looseRepo = { ...BASE, description: "一个漂亮的小工具插件", readmeHit: false };
  const looseOut = analyzeRelevance(looseRepo);
  assert.equal(looseOut.verdict, "manual");
  // 没有任何证据字段（冻结参照物）：与老口径逐字一致（用 Python 对照钉死，不靠手写预期）
  const plain = analyzeRelevance({ ...BASE });
  assert.deepEqual(plain, pyAnalyze({ ...BASE }));
});

test("README 摘要 normalize 与 Python ReadmeIndex.normalize 同口径", () => {
  const script = [
    "import sys, json",
    "sys.path.insert(0, 'backend')",
    "from dsh_mesh.readmes import ReadmeIndex",
    "samples = json.load(sys.stdin)",
    "idx = ReadmeIndex.__new__(ReadmeIndex)",
    "idx.max_chars = 2000",
    "print(json.dumps([idx.normalize(s) for s in samples], ensure_ascii=False))",
  ].join("\n");
  const samples = [
    "# Title\n\n![badge](https://img)\n\n安装：[DeepSeek Harness 插件](https://example.com) 的 dsh plugin\n\n<script>alert(1)</script> https://url.example间谍  **粗体** _斜体_ > 引用",
    "deepseek harness 手册 —— cordis 插件\n_fields\n",
    "",
  ];
  const py = JSON.parse(execFileSync("python3", ["-c", script], { input: JSON.stringify(samples), encoding: "utf8", cwd: ROOT }));
  samples.forEach((raw, i) => assert.equal(normalizeReadme(raw), py[i], "normalize 不一致：样例 " + i));
  assert.ok(readmeHit("高效 DSH 插件管理"));
  assert.equal(readmeHit("普通 markdown 说明"), false);
  assert.equal(readmeHit(""), false);
});

test("applyEvidence/stripEvidence：判定完字段要摘干净，不污染节点", () => {
  const node = { id: "a/b", stars: 0 };
  const added = applyEvidence(node, { manifestOk: true, readmeHit: false });
  assert.equal(analyzeRelevance(node).verdict, "related");
  stripEvidence(node, added);
  assert.ok(!("manifestOk" in node) && !("readmeHit" in node), "证据字段必须摘掉");
  // 节点自带字段时不覆盖、判定完也不摘（不是本分支写入的）
  const owned = { ...BASE, readmeHit: true };
  const added2 = applyEvidence(owned, { manifestOk: false, readmeHit: false });
  assert.deepEqual(added2, ["manifestOk"]);
});
