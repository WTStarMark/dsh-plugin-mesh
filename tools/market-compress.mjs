/**
 * 市场索引预压缩：构建时生成 gzip9 + brotli（默认 q10、lgwin 24），运行时直接发文件。
 *
 * 为什么构建时压：q10/q11 对 7~8MB 要 3~8 秒 CPU，放在请求路径会拖慢首个请求，还会占满 libuv 线程池。
 * 为什么不用 zstd：DSH Host 的 fetch（undici 6.29）只协商 gzip/deflate/br，zstd 到不了客户端；
 *   而且实测 zstd 对这份 JSON 只比 gzip 小 ~10%，收益不值一个客户端改动。
 * 为什么 brotli 默认 q10 而不是 q11：q11 再小 4%，但压缩耗时约 2 倍、内存峰值更高；
 *   线上机器内存紧时可以用 MARKET_BR_QUALITY=9 降到亚秒级。
 */
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const GZIP_LEVEL = 9;
export const BR_LGWIN = 24;

function clampQuality(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return Math.min(11, Math.max(5, Math.round(n)));
}

/** 当前生效的 brotli 质量（构建时读环境变量，便于按机器内存调档）。 */
export const BR_QUALITY = clampQuality(process.env.MARKET_BR_QUALITY);

/**
 * 压缩市场索引文本。
 * @returns {{raw: Buffer, gzip: Buffer, br: Buffer, ms: number, quality: number}}
 */
export function compressIndex(text) {
  const raw = Buffer.from(String(text), "utf8");
  const started = Date.now();
  const gzip = gzipSync(raw, { level: GZIP_LEVEL });
  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BR_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: BR_LGWIN,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  return { raw, gzip, br, ms: Date.now() - started, quality: BR_QUALITY };
}
