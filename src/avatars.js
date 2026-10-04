/**
 * 头像加载器：带并发上限、按【当前可见性】排序、工作集有上限。
 *
 * 为什么要限制：图上 1.7 万个节点、1.1 万个不同作者，用户一路缩放平移下来会累计
 * 上千张头像 —— 每张都解码成位图常驻内存（460×460 原图约 850KB/张）。
 * 规则：
 *   1. 每帧由绘制方声明"这一帧想要的"（want），并给出优先级（屏幕上越大越优先）；
 *   2. 队列按优先级排序，并发 6 张；
 *   3. 工作集上限 maxActive（默认 500）：超出时淘汰"这一帧不想要、优先级最低"的那些；
 *   4. 同一 URL 只请求一次；失败不重试。
 */

export function createAvatarStore(options = {}) {
  const maxActive = Math.max(1, options.maxActive ?? 500);
  // 并发不能超过工作集上限，否则"在途数"本身就会突破上限
  const concurrency = Math.min(maxActive, Math.max(1, options.concurrency ?? 6));
  const onLoad = options.onLoad ?? (() => {});
  const createImage = options.createImage ?? (() => document.createElement("img"));

  const entries = new Map(); // url -> { state, img, priority, wantedFrame }
  let active = 0;
  let frame = 0;
  let stats = { loaded: 0, failed: 0, evicted: 0, requests: 0 };

  function entryOf(url) {
    let e = entries.get(url);
    if (!e) {
      e = { state: "idle", img: null, priority: 0, wantedFrame: 0 };
      entries.set(url, e);
    }
    return e;
  }

  /** 排队中（或还没排上）的按优先级从高到低；同优先级先到先服务 */
  function pending() {
    const list = [];
    for (const [url, e] of entries) if (e.state === "idle") list.push([url, e]);
    list.sort((a, b) => b[1].priority - a[1].priority || 0);
    return list;
  }

  function pump() {
    if (active >= concurrency) return;
    for (const [url, entry] of pending()) {
      if (active >= concurrency) return;
      entry.state = "loading";
      active += 1;
      stats.requests += 1;
      let img;
      try {
        img = createImage();
      } catch {
        entry.state = "error";
        active -= 1;
        stats.failed += 1;
        continue;
      }
      img.onload = () => {
        if (entry.cancelled) return; // 已被淘汰：别再记账
        entry.state = "ready";
        entry.img = img;
        active -= 1;
        stats.loaded += 1;
        onLoad();
        pump();
      };
      img.onerror = () => {
        if (entry.cancelled) return;
        entry.state = "error";
        active -= 1;
        stats.failed += 1;
        pump();
      };
      img.src = url;
    }
  }

  /** 淘汰：只留"这一帧想要"的 priority 最高的前 maxActive 个（在途/已就绪都算） */
  function evict() {
    if (entries.size <= maxActive) return;
    const keep = new Set();
    const ranked = [...entries.entries()]
      .filter(([, e]) => e.state !== "error")
      .sort((a, b) => {
        const aw = a[1].wantedFrame === frame ? 1 : 0;
        const bw = b[1].wantedFrame === frame ? 1 : 0;
        return bw - aw || (b[1].priority ?? 0) - (a[1].priority ?? 0);
      });
    for (const [url] of ranked.slice(0, maxActive)) keep.add(url);
    for (const [url, e] of [...entries]) {
      if (keep.has(url)) continue;
      if (e.state === "loading") {
        // 在途的也要取消，否则"这一帧要了 150 个"就会把上限撑破；
        // 取消 = 清掉 src 并标记，等它的回调回来时不再记账。
        e.cancelled = true;
        try {
          e.img.src = "";
        } catch {
          /* 忽略 */
        }
        active = Math.max(0, active - 1);
      }
      entries.delete(url);
      stats.evicted += 1;
    }
  }

  return {
    /** 一帧开始：之后调用的 want/ready 都按这一帧记账 */
    beginFrame() {
      frame += 1;
    },
    /** 这一帧想画这张头像；priority 越大越先加载（一般传屏幕半径） */
    want(url, priority = 0) {
      if (!url) return null;
      const e = entryOf(url);
      e.wantedFrame = frame;
      e.priority = priority;
      if (e.state === "ready") return e.img;
      if (e.state === "idle") pump();
      return null;
    },
    /** 一帧结束：把超出的部分淘汰掉 */
    endFrame() {
      evict();
    },
    /** 兼容旧调用：等价于 want()（不参与帧记账时按当前帧算） */
    ready(url, priority = 0) {
      return this.want(url, priority);
    },
    /** 统计（保留旧字段名 loaded/failed/active，老调用方与测试照常可用） */
    get stats() {
      let ready = 0;
      let queued = 0;
      let loading = 0;
      for (const e of entries.values()) {
        if (e.state === "ready") ready += 1;
        else if (e.state === "idle") queued += 1;
        else if (e.state === "loading") loading += 1;
      }
      return { ...stats, active, loading, queued, ready, size: entries.size, maxActive, frame };
    },

    /** 当前工作集与统计（测试与调试用） */
    inspect() {
      const byState = { idle: 0, loading: 0, ready: 0, error: 0 };
      for (const e of entries.values()) byState[e.state] += 1;
      return { size: entries.size, frame, active, maxActive, ...stats, byState };
    },
  };
}
