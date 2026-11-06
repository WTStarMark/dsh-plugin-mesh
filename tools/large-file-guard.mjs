/**
 * 大静态文件并发闸门。
 *
 * 目的：大文件响应（流式或压缩）在慢客户端上会占住 socket 与内存，单进程服务扛不住 30 个并发。
 * 这里按「全局上限 + 每 IP 上限」计并发；拿不到槽位就回 429，而不是继续分配缓冲。
 * 纯内存计数，进程重启自动清空；release 幂等，重复调用不会把计数减成负数。
 */

export function createLargeFileGuard({ globalMax = 6, perIpMax = 2 } = {}) {
  const gMax = Math.max(1, Number(globalMax) || 6);
  const ipMax = Math.max(1, Number(perIpMax) || 2);
  let active = 0;
  const byIp = new Map();

  function acquire(ip) {
    const key = String(ip ?? "?");
    const used = byIp.get(key) ?? 0;
    if (active >= gMax || used >= ipMax) return { ok: false, retryAfter: 1 };
    active += 1;
    byIp.set(key, used + 1);
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        const left = (byIp.get(key) ?? 1) - 1;
        if (left <= 0) byIp.delete(key);
        else byIp.set(key, left);
      },
    };
  }

  return {
    acquire,
    get stats() {
      return { active, ips: byIp.size, globalMax: gMax, perIpMax: ipMax };
    },
  };
}
