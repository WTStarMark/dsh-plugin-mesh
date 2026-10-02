/**
 * 头像加载器：带并发上限、按 URL 去重、失败不重试。
 *
 * 为什么需要它：一个扇区图上有 593 个节点、约 500 个不同作者，
 * 一次性发起 500 个图片请求会堵塞；这里只对"当前画得出来的节点"排队加载。
 */

export function createAvatarStore(options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const onLoad = options.onLoad ?? (() => {});
  const createImage = options.createImage ?? (() => document.createElement("img"));
  const entries = new Map();
  const queue = [];
  let active = 0;
  let loaded = 0;
  let failed = 0;

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const url = queue.shift();
      const entry = entries.get(url);
      if (!entry || entry.state !== "queued") continue;
      entry.state = "loading";
      active += 1;
      let img;
      try {
        img = createImage();
      } catch {
        entry.state = "error";
        active -= 1;
        failed += 1;
        continue;
      }
      img.onload = () => {
        entry.state = "ready";
        entry.img = img;
        active -= 1;
        loaded += 1;
        onLoad();
        pump();
      };
      img.onerror = () => {
        entry.state = "error";
        active -= 1;
        failed += 1;
        pump();
      };
      img.src = url;
    }
  }

  return {
    /** 已就绪返回图片对象，否则排队（幂等）并返回 null */
    ready(url) {
      if (!url) return null;
      let entry = entries.get(url);
      if (!entry) {
        entry = { state: "idle", img: null };
        entries.set(url, entry);
      }
      if (entry.state === "idle") {
        entry.state = "queued";
        queue.push(url);
        pump();
      }
      return entry.state === "ready" ? entry.img : null;
    },
    get stats() {
      return { tracked: entries.size, loaded, failed, pending: queue.length, active };
    },
    clear() {
      entries.clear();
      queue.length = 0;
    },
  };
}
