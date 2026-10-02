/**
 * 详情分片加载器：右栏要看的字段不跟首屏一起下，而是按需拉取。
 *
 * 策略：
 *   1. 点开某个仓库时，只拉它所在的那一片（默认 8 片，单片几百 KB 以内）
 *   2. 空闲时后台把剩下的分片预取完，之后搜索描述、看详情都是瞬时的
 *   3. 拉不到就当没有详情，界面照常（详情不是必需资源）
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
    /** 某个 id 的详情；未加载返回 null（调用方自己决定要不要 await） */
    get(id, index) {
      const bucket = cache.get(((index % chunks) + chunks) % chunks);
      return bucket ? (bucket[id] ?? null) : null;
    },
    /** 按需加载：拿到详情后调用 onReady 重绘 */
    async ensure(id, index, onReady) {
      const bucket = await loadChunk(((index % chunks) + chunks) % chunks);
      const detail = bucket[id] ?? null;
      if (detail && onReady && cache.size >= 1) onReady(detail);
      return detail;
    },
    /** 空闲时把全部分片预取完（搜索描述、随意点选都不再等）；每拉到一片就回调一次 */
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
