/**
 * 访问数与同时在线：向同端口的 /api/stats 与 /api/ping 打招呼。
 *
 * 设计原则：统计拿不到绝不能影响站点 —— 所有失败都静默吞掉，
 * 界面上的统计栏自动隐藏（例如换成纯静态服务器时）。
 */

const CLIENT_KEY = "mesh-client-id";
const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;

function clientId() {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved && ID_PATTERN.test(saved)) return saved;
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
    localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return ""; // 隐私模式等：不发统计，也不报错
  }
}

async function ping(first) {
  const id = clientId();
  if (!id) return null;
  const res = await fetch("/api/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, first }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "--";
  return number.toLocaleString("zh-CN");
}

/**
 * 开始上报。onUpdate 收到 { visits, visitors, online }。
 * 返回 { stop }。
 */
export function startStats({ onUpdate, intervalMs = 20000, onUnavailable } = {}) {
  let timer = null;
  let stopped = false;

  const tick = async (first) => {
    if (stopped) return;
    try {
      const data = await ping(first);
      if (data && !stopped) onUpdate?.(data);
    } catch {
      // 第一次就失败说明这个部署没有统计接口：静默隐藏，不再重试刷屏
      if (first) {
        stopped = true;
        onUnavailable?.();
      }
    }
  };

  tick(true);
  timer = setInterval(() => tick(false), intervalMs);
  // Node 环境（测试）里定时器会拖住事件循环，显式放行；浏览器里 setInterval 返回数字，安全跳过
  timer?.unref?.();

  // 切回前台立刻补一次心跳，保证"在线"不失真
  const onVisible = () => {
    if (!stopped && document.visibilityState === "visible") tick(false);
  };
  document.addEventListener?.("visibilitychange", onVisible);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
    },
  };
}
