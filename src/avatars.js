/**
 * 头像加载器：按当前可见性排序、并发有上限、工作集有上限。
 * 必须限流——上万张头像解码后常驻内存（460×460 原图约 850KB/张），一路缩放平移会撑爆。
 * 每帧由绘制方声明 want 与优先级（屏幕上越大越优先）；并发 6；工作集上限 500，
 * 超出则淘汰「这一帧不想要、优先级最低」的；同一 URL 只请求一次，失败不重试。
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
        // 在途的也要取消，否则「这一帧要了 150 个」会撑破上限；取消 = 清 src，回调回来时不再记账。
        e.cancelled = true;
        try {
          e.img.src = "";
        } catch {
        }
        active = Math.max(0, active - 1);
      }
      entries.delete(url);
      stats.evicted += 1;
    }
  }

  return {
    beginFrame() {
      frame += 1;
    },
    /** priority 越大越先加载（一般传屏幕半径） */
    want(url, priority = 0) {
      if (!url) return null;
      const e = entryOf(url);
      e.wantedFrame = frame;
      e.priority = priority;
      if (e.state === "ready") return e.img;
      if (e.state === "idle") pump();
      return null;
    },
    endFrame() {
      evict();
    },
    /** 兼容旧调用：等价于 want() */
    ready(url, priority = 0) {
      return this.want(url, priority);
    },
    /** 保留旧字段名 loaded/failed/active，老调用方与测试照常可用 */
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
