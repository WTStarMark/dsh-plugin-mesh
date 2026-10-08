/**
 * 数据集探针：一处判断当前 data/ 是"真实数据"还是 CI 夹具。
 *
 * 背景：data/mesh.json 与预计算产物是运行时产物，不入库。干净克隆与 CI 里
 * 只有 data/sample-raw.json 夹具，CI 会先跑 `npm run seed:fixture` 生成一份
 * 593 节点的夹具数据集。凡是"按真实规模/真实新鲜度才成立"的断言，
 * 在夹具上必须显式跳过并写明原因，而不是失败。
 */
import { readFileSync } from "node:fs";
import { dayOf, DAY_TZ_OFFSET_HOURS } from "../../tools/api.mjs";

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return null;
  }
}

export const mesh = readJson(new URL("../../data/mesh.json", import.meta.url));
export const NODE_COUNT = Array.isArray(mesh?.nodes) ? mesh.nodes.length : 0;
export const HAS_DATASET = NODE_COUNT > 0;

/** 真实数据的最小节点数：CI 夹具 593，本机限扫 1451 起步，线上 2.7 万 */
export const REAL_DATASET_MIN_NODES = 1000;
export const hasRealDataset = NODE_COUNT >= REAL_DATASET_MIN_NODES;

/**
 * 窗口里有没有"最近推送"：样本采集时间会越来越旧，过期后周更新榜必然为空。
 * 窗口起点与接口保持一致 —— 用当地日历日算（dayOf + DAY_TZ_OFFSET_HOURS 都从 tools/api.mjs 来），
 * 而不是"现在往前 7×24 小时"：两者最多差一天，差一天就会误判榜单该不该有行。
 */
export const hasFreshPushes = (() => {
  const nodes = mesh?.nodes ?? [];
  if (!nodes.length) return false;
  const anchorDay = dayOf(Date.now());
  const startDay = new Date(Date.parse(anchorDay + "T00:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
  const floor = Date.parse(startDay + "T00:00:00Z") - DAY_TZ_OFFSET_HOURS * 3600000;
  return nodes.some((n) => n.pushedAt && Date.parse(n.pushedAt) >= floor);
})();

/** 不满足条件就跳过并写明原因；返回 true 表示已跳过，调用方直接 return */
export function skipUnless(t, ok, why) {
  if (ok) return false;
  t.skip(why);
  return true;
}

/** "按真实规模才成立"的断言用这个：夹具上跳过 */
export function skipUnlessReal(t, what) {
  if (hasRealDataset) return false;
  const how = NODE_COUNT ? "数据集只有 " + NODE_COUNT + " 个节点（CI 夹具）" : "data/mesh.json 不存在";
  t.skip(how + "：" + what + "按真实规模才成立");
  return true;
}
