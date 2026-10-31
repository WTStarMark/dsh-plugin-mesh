/**
 * 原子写小工具：市场索引 / 策展产物 / 取样器都靠它，写一半被杀不能留下半截文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteBuffer, atomicWriteJson, atomicWriteText } from "../tools/atomic-write.mjs";

const dir = mkdtempSync(join(tmpdir(), "mesh-atomic-"));
test.after?.(() => rmSync(dir, { recursive: true, force: true }));

test("原子写：覆盖旧内容，且不留临时文件", () => {
  const file = join(dir, "index.json");
  writeFileSync(file, "旧内容", "utf8");
  atomicWriteText(file, "新内容");
  assert.equal(readFileSync(file, "utf8"), "新内容");
  assert.deepEqual(readdirSync(dir), ["index.json"], "不应残留 .tmp 文件");
});

test("原子写二进制：内容逐字节一致，失败也清理临时文件", () => {
  const file = join(dir, "index.json.br");
  const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00]);
  assert.equal(atomicWriteBuffer(file, payload), payload.length);
  assert.deepEqual(readFileSync(file), payload);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
});

test("原子写 JSON：可读缩进与紧凑两种", () => {
  const pretty = join(dir, "pretty.json");
  const compact = join(dir, "compact.json");
  atomicWriteJson(pretty, { a: 1 }, 2);
  atomicWriteJson(compact, { a: 1 }, 0);
  assert.match(readFileSync(pretty, "utf8"), /\n  "a": 1/);
  assert.equal(readFileSync(compact, "utf8"), '{"a":1}');
});

test("原子写失败：旧目标不受影响，临时文件被清理", () => {
  const target = join(dir, "target-dir");
  mkdirSync(target);
  assert.throws(() => atomicWriteText(target, "x"), "目标是目录时 rename 应失败");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "失败后必须清掉临时文件");
  assert.deepEqual(readdirSync(target), [], "旧目标（目录）保持原样");
});
