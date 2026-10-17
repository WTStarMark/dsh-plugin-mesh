/**
 * 顶栏「索引源」：展开一条可直接复制的 DSH 插件市场索引地址。
 *
 * 地址按当前站点的 origin 现算，**不写死**：公网站点复制出来就是
 * https://www.moc-chen.cn/market/index.json；局域网自建实例复制出来是它自己的地址 ——
 * 写死的话，局域网用户复制到的是一个他访问不到的域名。
 *
 * 无副作用：不碰 DOM 的模块顶层，只在 createIndexSource 里操作传进来的节点（便于 Node 单测）。
 */
const PATH = "/market/index.json";
const FALLBACK_ORIGIN = "https://www.moc-chen.cn";

/** 当前站点上的索引地址；origin 为空时退回公网地址。 */
export function indexSourceUrl(origin) {
  const base =
    typeof origin === "string" && origin
      ? origin
      : typeof location !== "undefined" && location.origin
        ? location.origin
        : FALLBACK_ORIGIN;
  try {
    return new URL(PATH, base).href;
  } catch {
    return FALLBACK_ORIGIN + PATH;
  }
}

/** 剪贴板兜底：老浏览器 / 非安全上下文里 navigator.clipboard 不存在时用一次性的 textarea。 */
function legacyCopy(text) {
  if (typeof document === "undefined" || !document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand?.("copy") === true;
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * opts：{ button, panel, urlNode, copyButton, origin, clipboard, writeClipboard }。
 * 只处理「展开 / 收起 / 复制」三件事；Esc 与点外部由调用方（app.js）统一分发，与榜单弹窗同一套规矩。
 */
export function createIndexSource({ button, panel, urlNode, copyButton, origin, writeClipboard } = {}) {
  const url = indexSourceUrl(origin);
  if (urlNode) urlNode.textContent = url;
  let open = false;
  let resetTimer = null;

  function sync() {
    button?.setAttribute?.("aria-expanded", open ? "true" : "false");
    if (panel) panel.hidden = !open;
    button?.classList?.toggle?.("on", open);
  }

  function setOpen(value) {
    open = !!value;
    sync();
  }

  function copyLabel(text) {
    if (!copyButton) return;
    copyButton.textContent = text;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copyButton.textContent = "复制";
    }, 1600);
    resetTimer?.unref?.();
  }

  async function copy() {
    let ok = false;
    try {
      const write =
        typeof writeClipboard === "function"
          ? writeClipboard
          : typeof navigator !== "undefined" && navigator.clipboard
            ? navigator.clipboard.writeText.bind(navigator.clipboard)
            : null;
      if (write) {
        await write(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = legacyCopy(url);
    copyLabel(ok ? "已复制" : "复制失败");
    return ok;
  }

  button?.addEventListener?.("click", (ev) => {
    ev?.stopPropagation?.();
    setOpen(!open);
  });
  copyButton?.addEventListener?.("click", (ev) => {
    ev?.stopPropagation?.();
    copy();
  });

  sync();
  return { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!open), isOpen: () => open, url, copy };
}
