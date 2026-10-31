/**
 * 市场索引预压缩：构建时生成 gzip9 + brotli，serve 直发文件；这里只保证"压得开、解得回来、确实更小"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressIndex, BR_QUALITY, GZIP_LEVEL } from "../tools/market-compress.mjs";

test("预压缩：gzip/brotli 都能解回原文，且明显小于原文", () => {
  const text = JSON.stringify({
    format: 1,
    plugins: Array.from({ length: 500 }, (_, i) => ({
      name: "pkg-" + i,
      description: "★" + i + " —— 一个可安装的 DSH 组合包",
      metadata: { labels: ["dsh-bundle", "star-cta"], sortKeys: { stars: i, downloads: i * 10 } },
      versions: [{ version: "1.0." + i, publishTimestamp: 1790000000 + i, source: { type: "npm" } }],
    })),
  });
  const packed = compressIndex(text);
  assert.equal(gunzipSync(packed.gzip).toString("utf8"), text);
  assert.equal(brotliDecompressSync(packed.br).toString("utf8"), text);
  assert.ok(packed.gzip.length < packed.raw.length * 0.2, "gzip 应压到 1/5 以下");
  assert.ok(packed.br.length < packed.gzip.length, "brotli 应小于 gzip");
  assert.equal(packed.quality, BR_QUALITY);
  assert.equal(GZIP_LEVEL, 9);
});

test("预压缩：空对象也不炸", () => {
  const packed = compressIndex("{}");
  assert.equal(gunzipSync(packed.gzip).toString("utf8"), "{}");
  assert.equal(brotliDecompressSync(packed.br).toString("utf8"), "{}");
});
