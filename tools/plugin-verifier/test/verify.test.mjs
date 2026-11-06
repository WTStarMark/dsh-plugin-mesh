import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyDirectory } from "../lib/verify.mjs";
import { pickVersion } from "../lib/npm.mjs";
import { normalizePatchPath, normalizeRepository, validateManifest } from "../lib/manifest.mjs";
import { validatePatchText } from "../lib/patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(HERE, "..", "fixtures", name);

test("good：bundle + patch 有效 => confirmed", async () => {
  const r = await verifyDirectory(fixture("good"), { dshVersion: "0.2.1-rc.5" });
  assert.equal(r.verdict, "confirmed");
  assert.deepEqual(r.errors, []);
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].inserts, 1);
  assert.equal(r.manifest.repository, "example/dsh-hello");
});

test("good-array：patch 数组两文件都校验 => confirmed", async () => {
  const r = await verifyDirectory(fixture("good-array"));
  assert.equal(r.verdict, "confirmed");
  assert.equal(r.patches.length, 2);
  assert.equal(r.patches.reduce((n, p) => n + p.inserts, 0), 2);
});

test("good-js-tag：官方常用的 !!js 动态值只记录、不执行 => confirmed", async () => {
  const r = await verifyDirectory(fixture("good-js-tag"), { dshVersion: "0.2.1-rc.5" });
  assert.equal(r.verdict, "confirmed");
  assert.ok(r.warnings.some((w) => w.includes("!!js")));
});

test("bad-missing：patch 文件不在包里 => rejected", async () => {
  const r = await verifyDirectory(fixture("bad-missing"));
  assert.equal(r.verdict, "rejected");
  assert.ok(r.errors.some((e) => e.includes("patch 文件不在")));
});

test("bad-empty：patch 为空列表 => review（可安装但无效果）", async () => {
  const r = await verifyDirectory(fixture("bad-empty"));
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.length > 0);
});

test("bad-insert：没有有效条目 => review", async () => {
  const r = await verifyDirectory(fixture("bad-insert"));
  assert.equal(r.verdict, "review");
});

test("bad-traversal：patch 路径逃出包根 => rejected", async () => {
  const r = await verifyDirectory(fixture("bad-traversal"));
  assert.equal(r.verdict, "rejected");
  assert.ok(r.errors.some((e) => e.includes("非法 patch 路径")));
});

test("bad-client-only：只有 dsh.client => rejected", async () => {
  const r = await verifyDirectory(fixture("bad-client-only"));
  assert.equal(r.verdict, "rejected");
});

test("bad-yaml：patch 不是合法 YAML => rejected", async () => {
  const r = await verifyDirectory(fixture("bad-yaml"));
  assert.equal(r.verdict, "rejected");
});

test("bad-engines：engines.dsh 与目标 DSH 不兼容 => rejected", async () => {
  const r = await verifyDirectory(fixture("bad-engines"), { dshVersion: "0.2.1-rc.5" });
  assert.equal(r.verdict, "rejected");
  assert.ok(r.errors.some((e) => e.includes("不兼容")));
});

test("private：不可发布 => rejected（市场模式）", async () => {
  const r = await verifyDirectory(fixture("private"), { requirePublishable: true });
  assert.equal(r.verdict, "rejected");
});

test("graph：仓库不在图里 => 市场模式 rejected", async () => {
  const r = await verifyDirectory(fixture("good"), { graphIds: new Set(["other/repo"]), requireGraph: true });
  assert.equal(r.verdict, "rejected");
  assert.equal(r.graph.inGraph, false);
});

test("归一化：patch 路径与 GitHub 仓库", () => {
  assert.equal(normalizePatchPath("./cordis.patch.yml"), "cordis.patch.yml");
  assert.equal(normalizePatchPath("../x.yml"), null);
  assert.equal(normalizePatchPath("/etc/passwd"), null);
  assert.equal(normalizeRepository({ url: "git+https://github.com/Example/Repo.git" }), "example/repo");
  assert.equal(normalizeRepository("https://gitlab.com/a/b"), null);
});

test("patch 注释里的 *after 不能被误判成 YAML 别名", () => {
  const v = validatePatchText("- id: x\n  disabled: true\n# a third-party bundle lands *after* the built-in row\n");
  assert.deepEqual(v.errors, []);
  assert.equal(v.items, 1);
});

test("repository fallback：tarball 没写 repository 时可用 registry/market 条目兜底", () => {
  const v = validateManifest({ name: "x", version: "1.0.0", dsh: { bundle: { patch: "./x.yml" } } }, {
    repositoryFallback: { url: "git+https://github.com/Example/Repo.git" },
  });
  assert.equal(v.repository, "example/repo");
});

test("pickVersion：优先 dist-tags.latest，否则最高稳定版", () => {
  const p = { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "2.0.0": {}, "3.0.0-rc.1": {} } };
  assert.equal(pickVersion(p).version, "2.0.0");
  const q = { versions: { "1.0.0": {}, "1.2.0": {}, "1.3.0-rc.1": {} } };
  assert.equal(pickVersion(q).version, "1.2.0");
  assert.equal(pickVersion(q, "1.0.0").version, "1.0.0");
  assert.equal(pickVersion(q, "9.9.9"), null);
});
