/**
 * 详情分片加载器：右栏要看的字段不跟首屏一起下，点开时只拉所在的那一片
 * （默认 8 片、单片几百 KB 以内），空闲时预取其余分片。
 * 拉不到就当没有详情，界面照常——详情不是必需资源。
 */

const cache = new Map();

function idle(callback) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 2000 });
  else setTimeout(callback, 200);
}

export function createDetailStore(meta = {}) {
  const chunks = Math.max(1, Number(meta.chunks ?? 8));
  let pending = null;

  async function loadChunk(index) {
    if (cache.has(index)) return cache.get(index);
    if (!pending) pending = new Map();
    if (pending.has(index)) return pending.get(index);
    const task = fetch("./data/details/" + index + ".json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
      .then((data) => {
        cache.set(index, data);
        pending.delete(index);
        return data;
      });
    pending.set(index, task);
    return task;
  }

  return {
    chunks,
    /** 未加载返回 null，调用方自行决定是否 await */
    get(id, index) {
      const bucket = cache.get(((index % chunks) + chunks) % chunks);
      return bucket ? (bucket[id] ?? null) : null;
    },
    async ensure(id, index, onReady) {
      const bucket = await loadChunk(((index % chunks) + chunks) % chunks);
      const detail = bucket[id] ?? null;
      if (detail && onReady && cache.size >= 1) onReady(detail);
      return detail;
    },
    prefetch(onChunk) {
      let i = 0;
      const step = () => {
        if (i >= chunks) return;
        loadChunk(i).then((data) => {
          onChunk?.(data);
          i += 1;
          idle(step);
        });
      };
      idle(step);
    },
  };
}
