#!/usr/bin/env node
/**
 * 初始化管理后台凭据（部署时自动跑，也可以手工跑）：
 *
 *   node tools/admin-setup.mjs                   # 缺什么补什么：缺 ADMIN_PATH 就生成 32 位随机路径
 *   node tools/admin-setup.mjs --show            # 只打印后台地址，不改文件、不打印口令
 *   node tools/admin-setup.mjs --path-only       # 只补 ADMIN_PATH，不碰口令（部署脚本用：不能让口令进部署日志）
 *   node tools/admin-setup.mjs --password 'xxx'  # 指定登录口令（缺哈希或配合 --force-password 时写入）
 *   node tools/admin-setup.mjs --force-password  # 重新生成/覆盖口令
 *
 * 只写仓库根目录的 .env（0600、不入库）；缺失的键才追加，绝不覆盖已有内容。
 * 口令只在这里打印一次 —— 之后 .env 里只剩 scrypt 哈希。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ENV_FILE, adminPathFrom, readEnv } from "./admin-config.mjs";
import { hashPassword } from "./admin-auth.mjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * 就地覆盖 .env 里的键值：同名键只保留一条（写在新值的位置，其余重复行删除），
 * 原本没有的键追加到末尾。文件末尾统一补一个换行。
 *
 * 单独抽出来是为了能测 —— 这个函数以前是内联"追加"，线上因此出现两条
 * ADMIN_PASSWORD_HASH，重置口令后服务读到的仍是旧哈希，登录怎么都进不去。
 */
export function upsertEnvValues(text, updates) {
  const wanted = new Map(updates);
  const kept = [];
  const written = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!m || !wanted.has(m[1])) {
      if (line !== "" || kept.length) kept.push(line);
      continue;
    }
    const key = m[1];
    if (!written.has(key)) {
      kept.push(key + "=" + wanted.get(key));
      written.add(key);
    }
    // 同名重复行：丢掉
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  for (const [key, value] of wanted) if (!written.has(key)) kept.push(key + "=" + value);
  return kept.join("\n") + "\n";
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const env = readEnv();
const existingPath = adminPathFrom(env);

if (flag("show")) {
  console.log(existingPath ? "后台地址: http://<host>:<port>/" + existingPath + "/" : "尚未配置后台路径，请先跑 node tools/admin-setup.mjs");
  process.exit(0);
}

const lines = [];
let plainPassword = null;
const path = existingPath ?? randomString(32);
if (!existingPath) lines.push(["ADMIN_PATH", path]);

// 为什么必须"替换"而不是"追加"（2026-10-15 线上踩过）：
// 这个脚本原来只会往末尾追加 ADMIN_PASSWORD_HASH=...，于是 .env 里出现两条同名键。
// 而服务读取时只认第一条 —— 结果就是"重置完口令还是登不上"，新旧口令都对不上，极难排查。
// 凭据这种键必须就地覆盖：同名只留一条。
if (!flag("path-only") && (flag("force-password") || !env.ADMIN_PASSWORD_HASH)) {
  plainPassword = argOf("password") ?? randomString(16);
  // 后台只有口令这一道锁（路径本身也是秘密）：手工指定的口令至少 12 位，别让弱口令把限流当摆设。
  if (String(plainPassword).length < 12) {
    console.error("口令太短：至少 12 位（随机生成的是 16 位）。后台路径泄露时，口令是唯一防线。");
    process.exit(2);
  }
  lines.push(["ADMIN_PASSWORD_HASH", await hashPassword(plainPassword)]);
}

if (lines.length) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  writeFileSync(ENV_FILE, upsertEnvValues(text, lines), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

console.log("后台地址: http://<host>:<port>/" + path + "/");
if (plainPassword) console.log("登录口令（只显示这一次）: " + plainPassword);
else if (flag("path-only")) console.log("只补了路径；口令由运维单独设置：node tools/admin-setup.mjs --force-password");
else console.log("口令未改动（已有 ADMIN_PASSWORD_HASH）。要改口令：node tools/admin-setup.mjs --force-password");
