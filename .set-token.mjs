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
console.log("是否含旧令牌残留: " + (/github_pat_(?!REDACTED)/.test(env) ? "是 ✗" : "否 ✓"));
