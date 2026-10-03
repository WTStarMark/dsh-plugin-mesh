import { readFile, writeFile, chmod } from "node:fs/promises";
const NEW = process.env.NEW_TOKEN ?? "";
if (!NEW.startsWith("github_pat_") && !NEW.startsWith("ghp_")) throw new Error("令牌格式不认识");
let env = await readFile(".env", "utf8");
if (/^GITHUB_TOKEN=/m.test(env)) {
  env = env.replace(/^GITHUB_TOKEN=.*$/m, "GITHUB_TOKEN=" + NEW);
} else {
  env = env.trimEnd() + "\nGITHUB_TOKEN=" + NEW + "\n";
}
await writeFile(".env", env, "utf8");
await chmod(".env", 0o600);
console.log("已写入 .env（长度 " + NEW.length + "，权限 600）");
// 只统计令牌出现次数，脚本里不记录任何令牌、也不记录令牌的任何片段
console.log("是否含旧令牌残留: " + ((env.match(/(github_pat_|ghp_)[A-Za-z0-9_]+/g) ?? []).length > 1 ? "是 ✗" : "否 ✓"));
