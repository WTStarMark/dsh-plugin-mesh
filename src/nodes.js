/**
 * 顶栏「镜像节点」：多节点部署时，让访客在几个站点之间切换。
 *
 * 节点清单来自服务端 GET /api/nodes（后台可配置）；本模块只负责把清单画进气泡、
 * 以及点节点时跳转。无副作用：模块顶层不碰 DOM，只在 createNodeSwitcher 里操作传进来的节点。
 */
function toOrigin(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "";
  }
}

/** 当前页面对应的节点：按 origin 精确匹配，匹配不到再用当前 host 兜底 */
export function currentNodeId(nodes, currentOrigin) {
  const origin = toOrigin(currentOrigin);
  const list = Array.isArray(nodes) ? nodes : [];
  if (origin) {
    const exact = list.find((n) => n && toOrigin(n.url) === origin);
    if (exact) return exact.id;
  }
  return list[0]?.id ?? null;
}

/**
 * opts：{ button, panel, nameNode, listNode, nodes, currentUrl, navigate }。
 * 点击节点 = 跳到该节点站点（默认 location.assign）。只有一个节点时不显示按钮。
 */
export function createNodeSwitcher({ button, panel, nameNode, listNode, nodes, currentUrl, navigate } = {}) {
  const list = [];
  let open = false;
  const current = () => currentNodeId(list, currentUrl ?? (typeof location !== "undefined" ? location.origin : ""));
  const go = typeof navigate === "function" ? navigate : (url) => {
    if (typeof location !== "undefined" && url) location.assign(url);
  };

  function render() {
    const active = current();
    const activeNode = list.find((n) => n && n.id === active) ?? list[0];
    if (nameNode) nameNode.textContent = activeNode ? activeNode.label || activeNode.id : "";
    if (button) {
      button.hidden = list.length < 2 && !open;
      button.title = list.length
        ? "镜像节点：共 " + list.length + " 个部署节点，点击切换"
        : "镜像节点：当前是单节点部署";
    }
    if (!listNode) return;
    listNode.textContent = "";
    for (const node of list) {
      if (!node || !node.id) continue;
      const item = document.createElement("li");
      const isSelf = node.id === active;
      const a = document.createElement("button");
      a.type = "button";
      a.className = "node-item" + (isSelf ? " current" : "");
      const label = document.createElement("b");
      label.textContent = node.label || node.id;
      const meta = document.createElement("span");
      meta.textContent = isSelf ? "当前节点" : (node.url || "未配置地址");
      a.append(label, meta);
      a.disabled = isSelf || !node.url;
      if (!isSelf && node.url) {
        a.addEventListener("click", (ev) => {
          ev.stopPropagation();
          go(node.url);
        });
      }
      item.append(a);
      listNode.append(item);
    }
    if (!list.length) {
      const li = document.createElement("li");
      const hint = document.createElement("span");
      hint.className = "node-empty";
      hint.textContent = "当前是单节点部署";
      li.append(hint);
      listNode.append(li);
    }
  }

  function sync() {
    if (button) {
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.classList.toggle("on", open);
    }
    if (panel) panel.hidden = !open;
    if (open) render();
  }

  function setNodes(value) {
    list.length = 0;
    for (const node of Array.isArray(value) ? value : []) {
      if (node && typeof node === "object") list.push(node);
    }
    render();
    return list;
  }

  function setOpen(value) {
    open = !!value;
    sync();
  }

  button?.addEventListener?.("click", (ev) => {
    ev?.stopPropagation?.();
    setOpen(!open);
  });

  setNodes(nodes);
  sync();
  return {
    setNodes,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    nodes: () => list.slice(),
    currentId: () => current(),
  };
}
