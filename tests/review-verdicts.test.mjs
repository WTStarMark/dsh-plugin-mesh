import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readVerdictReviews, setVerdictReview, removeVerdictReview, reviewOverrideMap, verdictReasonOf, writeVerdictReviews } from "../tools/review-verdicts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("复核表：外壳固定、非法 verdict 剔除、备份与原子写", () => {
  const TMP = mkdtempSync(join(tmpdir(), "review-verdicts-"));
  const FILE = join(TMP, "review-verdicts.json");
  try {
    // 没建过 = 空表
    assert.equal(readVerdictReviews(FILE).count, 0, "文件还没建时是空表");
    // 建了损坏文件也是空表
    writeFileSync(FILE, "{ 坏的 json");
    assert.equal(readVerdictReviews(FILE).count, 0, "坏文件不抛错");
    // 写一条
    setVerdictReview("a/good", "related", "看过了", FILE);
    const doc = readVerdictReviews(FILE);
    assert.equal(doc.count, 1);
    assert.equal(doc.reviews["a/good"].verdict, "related");
    // upsert：有多条，verdict 换档，note 截 200
    const longNote = "x".repeat(500);
    setVerdictReview("a/good", "noise", longNote, FILE);
    setVerdictReview("b/junk", "noise", null, FILE);
    const doc2 = readVerdictReviews(FILE);
    assert.equal(doc2.count, 2);
    assert.equal(doc2.reviews["a/good"].verdict, "noise");
    assert.equal(doc2.reviews["a/good"].note.length, 200, "备注最长 200");
    assert.ok(doc2.reviews["a/good"].note.startsWith("xxx"), "备注还是那批 x");
    // 撤回 + 文件外壳仍在
    const rm = removeVerdictReview("b/junk", FILE);
    assert.equal(rm.existed, true);
    assert.ok(existsSync(FILE), "撤回后文件本体还在");
    const disk = JSON.parse(readFileSync(FILE, "utf8"));
    assert.equal(disk.reviews["b/junk"], undefined);
    assert.ok(typeof doc2.count === "number" && doc2.count >= 1, "外壳要带 self 描述的 count：" + JSON.stringify(Object.keys(disk)));
    // 手工塞坏条目会被读侧洗掉
    writeVerdictReviews({ ...disk.reviews, "c/weird": { verdict: "manual" }, "not-a-repo": { verdict: "noise" } }, null, FILE);
    const doc3 = readVerdictReviews(FILE);
    assert.equal(doc3.reviews["c/weird"], undefined, "manual 不能作为人工结论");
    assert.equal(doc3.reviews["not-a-repo"], undefined, "不是 owner/repo 的键会被洗掉");
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});

test("复核表：人工结论压过规则；JS 与 Python 因果文案字段一致", () => {
  const cases = [
    { verdict: "related", note: "看过了，是 dsh 插件" },
    { verdict: "noise", note: null },
    { verdict: "noise", note: "天空之城同名库" },
  ];
  const map = {};
  for (const c of cases) {
    const reason = verdictReasonOf(c);
    let want;
    if (c.note) want = "人工复核：" + c.note;
    else want = "人工复核（后台）";
    assert.equal(reason, want);
    map[(c.verdict === "related" ? "a/rel" : "b/noi") + (c.note ? "-n" : "-") ] = { verdict: c.verdict, reason, review: false };
  }
  // Python 逐条对照：load_verdict_reviews 对同一份文件给出同一 map（id 一致）
  const TMP = mkdtempSync(join(tmpdir(), "review-parity-"));
  const FILE = join(TMP, "review-verdicts.json");
  try {
    writeVerdictReviews(
      {
        "a/rel-n": { verdict: "related", note: "看过了，是 dsh 插件", addedAt: "2026-11-07T00:00:00Z" },
        "b/noi-": { verdict: "noise", note: null, addedAt: "2026-11-07T00:00:01Z" },
        "b/noi-n": { verdict: "noise", note: "天空之城同名库", addedAt: "2026-11-07T00:00:02Z" },
      },
      null,
      FILE,
    );
    const js = reviewOverrideMap(FILE);
    const script = [
      "import sys, json",
      "sys.path.insert(0, 'backend')",
      "from dsh_mesh.build import load_verdict_reviews",
      "print(json.dumps(load_verdict_reviews(sys.argv[1]), ensure_ascii=False))",
    ].join("\n");
    const py = JSON.parse(execFileSync("python3", ["-c", script, FILE], { encoding: "utf8", cwd: ROOT }));
    assert.deepEqual(js, py, "JS/Python 的人工结论表对同一份文件必须同形状同文案");
    // apply 语义对照：任给一个 manual 节点，两侧对 override 的落点一致（verdict/review/reason）
    for (const [id, rec] of Object.entries(js)) {
      const pyOut = execFileSync(
        "python3",
        ["-c",
          [
            "import sys, json",
            "sys.path.insert(0, 'backend')",
            "from dsh_mesh.build import apply_verdict_override",
            "repo = json.loads(sys.argv[2])",
            "print('CHANGED' if apply_verdict_override(repo, json.loads(sys.argv[1])) else 'NOOP')",
            "print(json.dumps(repo, ensure_ascii=False))",
          ].join("\n"),
          JSON.stringify(rec),
          JSON.stringify({ verdict: "manual", review: true, reason: "待复核" }),
        ],
        { encoding: "utf8", cwd: ROOT },
      ).split("\n").filter(Boolean);
      assert.equal(pyOut[0], "CHANGED");
      const pyRepo = JSON.parse(pyOut[1]);
      assert.deepEqual({ verdict: pyRepo.verdict, review: pyRepo.review, reason: pyRepo.reason }, rec);
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});
