#!/usr/bin/env node
/**
 * seed-fixture — 用仓库里的 data/sample-raw.json 离线生成一份夹具数据集。
 *
 * 为什么需要：data/mesh.json 与预计算产物是运行时产物，不入库；干净克隆与 CI 里
 * 没有它们，而测试要读。走采集器的 --from-raw 路径，不联网、不消耗配额。
 *
 * 安全：本机已有真实 data/mesh.json 时拒绝执行（免得把真数据覆盖成夹具），除非 --force。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const meshPath = resolve(ROOT, "data/mesh.json");
const force = process.argv.includes("--force");

if (existsSync(meshPath) && !force) {
  console.log("data/mesh.json 已存在，按本机真实数据对待，不覆盖。要重建夹具加 --force");
  process.exit(0);
}

const run = spawnSync("python3", ["backend/collect.py", "--from-raw", "--frontend-limit", "2000", "--quiet"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (run.error) {
  console.error("跑不动 python3：" + run.error.message);
  process.exit(1);
}
if (run.status !== 0) {
  console.error("夹具生成失败，退出码 " + run.status);
  process.exit(run.status ?? 1);
}
console.log("夹具数据集已生成：data/mesh.json、mesh-core.json、mesh-core.bin（来源 data/sample-raw.json）");
