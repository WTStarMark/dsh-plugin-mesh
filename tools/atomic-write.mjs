/**
 * 原子写小工具：同目录临时文件 + rename 顶替，读者永远看不到半截文件。
 *
 * 项目里 mesh / 快照 / 后台配置都走这套；市场索引、策展产物、取样器以前是裸 writeFile，
 * 崩溃或并发读会拿到半截 JSON（市场索引还被站点直接对外提供）。统一到这里，别再各写一份。
 */
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** 原子写文本；返回写入的字节数。失败时清掉临时文件并抛原异常，旧文件保持完整。 */
export function atomicWriteText(file, text) {
  const payload = String(text);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now().toString(36);
  try {
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err;
  }
  return Buffer.byteLength(payload);
}

/** 原子写 JSON；indent 传 1/2 可读，0 表示紧凑。 */
export function atomicWriteJson(file, value, indent = 0) {
  return atomicWriteText(file, JSON.stringify(value, null, indent));
}
