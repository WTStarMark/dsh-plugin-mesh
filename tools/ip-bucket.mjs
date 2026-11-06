/**
 * 限流分桶用的 IP 归一化。
 *
 * 为什么需要：令牌桶按 IP 字符串做 key 时，IPv6 一个 /64 网段里可以无成本轮换源地址，
 * 等于给刷接口的人开了无限额度。这里把 IPv6 收敛到 /64、把 IPv4-mapped 还原成 IPv4，
 * 再交给限流器当 key；展示/日志里用的仍是原始地址，互不影响。
 */

import { isIPv4, isIPv6 } from "node:net";

/** 把 IPv6 展开成 8 组（不处理内嵌 IPv4，调用方先做 IPv4-mapped 还原） */
function expandIPv6(addr) {
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(":") : []) : null;
  if (tail === null) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
}

/**
 * 限流桶 key：IPv4 原样；IPv6 取前 64 位并加 "/64" 后缀；非法/未知地址原样返回。
 * 例：2001:db8:1:2::1 与 2001:db8:1:2:ffff::9 → 同一个 key。
 */
export function bucketIp(raw) {
  let addr = String(raw ?? "?").trim();
  if (!addr) return "?";
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1];
  if (isIPv4(addr)) return addr;
  if (!isIPv6(addr)) return addr;
  const groups = expandIPv6(addr);
  if (!groups) return addr;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+/, "") || "0").join(":") + "::/64";
}
