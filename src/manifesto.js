/**
 * 顶栏「倡议书」：把这张图想干什么、怎么收录、以及我们的承诺讲清楚。
 *
 * 弹窗里有两页：倡议书正文 + API 调用说明。开关、分页、关闭方式都由这里管，
 * 每次打开都回到第一页 —— 用户下次点开想看到的还是正文，而不是上次翻到的那页。
 *
 * 无副作用：模块顶层不碰 DOM，只在 createManifesto 里操作传进来的节点（便于 Node 单测）。
 */
export function createManifesto({ button, modal, close, mask, pages } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && p.node);
  const first = list[0]?.id ?? null;
  let open = false;
  let page = first;

  function syncPages() {
    for (const p of list) {
      p.node.hidden = p.id !== page;
      p.tab?.setAttribute?.("aria-selected", p.id === page ? "true" : "false");
      p.tab?.classList?.toggle?.("on", p.id === page);
    }
  }

  function sync() {
    button?.setAttribute?.("aria-expanded", open ? "true" : "false");
    if (modal) modal.hidden = !open;
    button?.classList?.toggle?.("on", open);
    syncPages();
  }

  function setPage(id) {
    if (!list.some((p) => p.id === id)) return;
    page = id;
    syncPages();
  }

  function setOpen(value) {
    open = !!value;
    if (open) page = first; // 每次打开都回到第一页
    sync();
  }

  button?.addEventListener?.("click", () => setOpen(!open));
  close?.addEventListener?.("click", () => setOpen(false));
  mask?.addEventListener?.("click", () => setOpen(false));
  for (const p of list) p.tab?.addEventListener?.("click", () => setPage(p.id));

  return {
    isOpen: () => open,
    setOpen,
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    page: () => page,
    setPage,
  };
}
