import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runSync(files) {
  return spawnSync(process.execPath, [
    "tools/market-sync.mjs",
    "--index", join(files.tmp, "index.json"),
    "--mesh", join(files.tmp, "mesh.json"),
    "--evidence", join(files.tmp, "evidence.json"),
  ], {
    cwd: ROOT,
    env: { ...process.env, MARKET_DIR: join(files.tmp, "data", "admin", "market-index") },
    encoding: "utf8",
  });
}

async function fixture(t, evidenceVersion = 2) {
  const tmp = await mkdtemp(join(tmpdir(), "mesh-market-sync-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(join(tmp, "data", "admin", "market-index"), { recursive: true });
  await writeFile(join(tmp, "mesh.json"), JSON.stringify({
    nodes: [
      { id: "a/one", htmlUrl: "https://github.com/a/one", category: "efficiency", categoryLabel: "效率优化" },
      { id: "a/two", htmlUrl: "https://github.com/a/two", category: "doc", categoryLabel: "文档处理" },
    ],
  }));
  await writeFile(join(tmp, "index.json"), JSON.stringify({
    format: 1,
    metadata: { categories: { stale: { title: { en: "stale · 1", zh: "旧扇区 · 1" } } }, labels: {} },
    plugins: [
      { name: "pkg-one", repository: { url: "https://github.com/a/one" }, metadata: { category: "usage", labels: ["dsh-bundle", "has-client", "star-cta"] } },
      { name: "pkg-two", repository: { url: "https://github.com/a/two" }, metadata: { category: "doc", labels: ["dsh-bundle", "star-cta"] } },
      { name: "pkg-three", metadata: { category: "panel", labels: ["dsh-bundle", "has-client", "star-cta"] } },
      { name: "pkg-four", metadata: { category: "panel", labels: ["dsh-bundle", "has-client", "star-cta"] } },
      { name: "pkg-five", metadata: { category: "panel", labels: ["dsh-bundle", "has-client", "star-cta"] } },
    ],
  }));
  await writeFile(join(tmp, "evidence.json"), JSON.stringify({
    version: evidenceVersion,
    status: "complete",
    packages: {
      "pkg-one": { ok: true, uiFiles: 2, clientFiles: 0 },
      "pkg-two": { ok: true, uiFiles: 0, clientFiles: 0 },
      "pkg-three": { ok: true, dshClient: true, platform: "web", uiFiles: 0, clientFiles: 1, clientEntry: null },
      "pkg-four": { ok: true, dshClient: true, platform: "web", uiFiles: 0, clientFiles: 0, clientEntry: "lib/client.js" },
      "pkg-five": { ok: true, dshClient: true, platform: "host", uiFiles: 0, clientFiles: 1, clientEntry: "lib/client.js" },
    },
  }));
  await writeFile(join(tmp, "data", "admin", "market-index", "overrides.json"), JSON.stringify({ version: 1, labels: { hidden: [] } }));
  return tmp;
}

test("market-sync：同步最新分类 + 只按发布包证据打「含界面」", async (t) => {
  const tmp = await fixture(t);
  const run = runSync({ tmp });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const out = JSON.parse(await readFile(join(tmp, "index.json"), "utf8"));
  const by = (name) => out.plugins.find((p) => p.name === name);
  const one = by("pkg-one");
  assert.equal(one.metadata.category, "efficiency", "旧 usage 分类应同步为 efficiency");
  assert.ok(one.metadata.labels.includes("has-client"), "pkg-one 有 UI 资源，应带含界面");
  assert.equal(by("pkg-two").metadata.labels.includes("has-client"), false, "没有前端证据，不该带含界面");
  assert.equal(by("pkg-three").metadata.category, undefined, "没有仓库身份的分类应清掉");
  assert.ok(by("pkg-three").metadata.labels.includes("has-client"), "声明 web client 且有运行时客户端文件");
  assert.ok(by("pkg-four").metadata.labels.includes("has-client"), "exports[./client] 入口真实存在，应带含界面");
  assert.equal(by("pkg-five").metadata.labels.includes("has-client"), false, "platform=host 不该带含界面");
  assert.equal(out.metadata.categories.efficiency.title.zh, "效率优化 · 1");
  assert.equal(out.metadata.labels["has-client"].title.zh, "含界面");
  await readFile(join(tmp, "index.json.gz"));
  await readFile(join(tmp, "index.json.br"));
});

test("market-sync：v1 证据（只数文件名）拒绝使用，提示重跑扫描", async (t) => {
  const tmp = await fixture(t, 1);
  const run = runSync({ tmp });
  assert.notEqual(run.status, 0, "旧格式证据不能用来判定");
  assert.match(run.stderr, /v2|旧格式|market-ui-scan/);
});
