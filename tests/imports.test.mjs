import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");

async function sourceFiles() {
  const names = await readdir(SRC);
  return names.filter((f) => f.endsWith(".js"));
}

test("src/ 下每个相对 import 都能解析到真实文件", async () => {
  const files = await sourceFiles();
  assert.ok(files.length >= 5, "src/ 下模块数量异常: " + files.join(","));
  for (const file of files) {
    const code = await readFile(resolve(SRC, file), "utf8");
    const specs = [...code.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = resolve(SRC, spec);
      await assert.doesNotReject(
        () => readFile(target),
        file + " 引用了不存在的模块 " + spec,
      );
    }
  }
});

test("index.html 引用的静态资源存在", async () => {
  const html = await readFile(resolve(ROOT, "index.html"), "utf8");
  for (const spec of [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1])) {
    await assert.doesNotReject(() => readFile(resolve(ROOT, spec)), "index.html 引用了缺失资源 " + spec);
  }
});

test("前端模块不在导入期触碰 DOM（保证可被 Node 单测导入）", async () => {
  for (const file of ["layout-sector.js", "rng.js", "mesh-data.js", "graph.js"]) {
    const mod = await import("../src/" + file);
    assert.ok(Object.keys(mod).length > 0, file + " 未导出任何内容");
  }
});
