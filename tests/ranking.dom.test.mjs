/**
 * 榜单弹窗的 DOM 桩测试：没有无头浏览器，就用最小 DOM 桩把 src/ranking.js 跑一遍。
 * 重点不是像素，而是：口径（窗口/新旧）有没有如实说、接口挂了会不会编数字、点一行是否真的回调。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 1;
    this.children = [];
    this.classList = { _set: new Set(), add: (c) => this.classList._set.add(c), remove: (c) => this.classList._set.delete(c), toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)), contains: (c) => this.classList._set.has(c) };
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.className = "";
    this.style = {};
    this.hidden = false;
    this._text = "";
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  focus() { this.focused = true; }
  fire(ev) { for (const fn of this.listeners[ev] ?? []) fn({ preventDefault() {}, stopPropagation() {} }); }
  get all() { return this.children.flatMap((c) => [c, ...(c.all ?? [])]); }
  find(pred) { return this.all.find(pred); }
}

globalThis.document = { createElement: (tag) => new FakeNode(tag) };

const { createRankingBoard, formatStars, timeAgo } = await import("../src/ranking.js");

const payload = {
  generatedAt: "2026-10-03T11:00:25Z",
  now: "2026-10-06T14:00:00Z",
  windowDays: 7,
  limit: 20,
  dataAgeHours: 75,
  // 相对时间必须按"现在"造：写死日期的话，过一天断言就从"3 天前"变成"4 天前"（时间炸弹）

  seriesDays: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"],
  history: { points: [{ at: "2026-10-01T17:00:42Z", repos: 2625, source: "snapshot" }], latestAt: "2026-10-01T17:00:42Z" },
  boards: {
    updated: {
      label: "周更新热榜", metric: "updates", windowDays: 7, total: 3392, count: 2, maxUpdates: 8,
      updatesSource: "update-log", updatesObservations: 4, updatesSampledDays: 4, seriesKind: "updates", seriesDays: 4,
      note: "次数 = 采样到 pushedAt 前进的轮次数（每轮最多记一次，是下界；窗口内确有推送但没采样到时记 1）。已观测 4 天",
      items: [
        { id: "acme/one", name: "one", owner: "acme", avatar: null, stars: 12, pushedAt: new Date(Date.now() - 3.2 * 86400000).toISOString(), categoryLabel: "其他", updates: 8, observedAdvances: 8, series: [null, 2, null, 1, 0, null, 5], releases: [{ tag: "v1.66.9", name: "1.66.9", at: "2026-10-05", pre: false }, { tag: "v1.66.8", name: "1.66.8", at: "2026-10-01", pre: false }] },
        { id: "acme/two", name: "two", owner: "acme", avatar: null, stars: 3, pushedAt: new Date(Date.now() - 4.2 * 86400000).toISOString(), categoryLabel: "Web 前端", updates: 2, series: [null, null, 1, null, null, null, 1], releases: [{ tag: "v2.0.0-rc.1", name: "rc", at: "2026-10-06", pre: true }] },
      ],
    },
    stars: {
      label: "周 star 热榜", metric: "star-gain", seriesKind: "star-gain", available: true,
      window: { from: "2026-10-01T17:00:42Z", to: "2026-10-03T11:00:25Z", days: 1.75, target: 7 },
      total: 479, count: 1, matched: 2621, seriesDays: 0, spanCount: 1,
      note: "增量 = 两个时间点的星标之差（真实观测，非估算）。",
      items: [{
        id: "acme/one", name: "one", owner: "acme", avatar: null, stars: 242570, delta: 960,
        starsBefore: 241610, starsAfter: 242570, categoryLabel: "协议基座",
        series: [null, null, null, null, null, null, null],
        spans: [{ fromIdx: 1, toIdx: 6, from: "2026-10-01", to: "2026-10-06", days: 4.92, value: 960 }],
      }],
    },
  },
};

function mount({ data = payload, fail = false } = {}) {
  const nodes = {
    button: new FakeNode("button"),
    modal: new FakeNode("div"),
    tabs: new FakeNode("div"),
    body: new FakeNode("div"),
    foot: new FakeNode("div"),
    close: new FakeNode("button"),
  };
  nodes.modal.hidden = true;
  const mask = new FakeNode("div");
  mask.dataset.close = "1";
  nodes.modal.append(mask);
  const t1 = new FakeNode("button");
  t1.dataset.tab = "updated";
  t1.className = "on";
  const t2 = new FakeNode("button");
  t2.dataset.tab = "stars";
  nodes.tabs.append(t1, t2);
  const picked = [];
  const board = createRankingBoard({
    ...nodes,
    fetcher: async () => {
      if (fail) throw new Error("boom");
      return data;
    },
    onPick: (id) => picked.push(id),
  });
  return { ...nodes, board, picked, t1, t2, mask };
}

const rows = (node) => node.all.filter((n) => n.className?.startsWith("rank-row"));
const settle = () => new Promise((r) => setTimeout(r, 5));

test("formatStars / timeAgo：站点口径的紧凑格式", () => {
  assert.equal(formatStars(960), "960");
  assert.equal(formatStars(12345), "12.3k");
  assert.equal(formatStars(242570), "242.6k");
  assert.equal(formatStars(1200000), "1.2M");
  assert.equal(timeAgo("2026-10-03T10:01:33Z", Date.parse("2026-10-03T12:00:00Z")), "1 小时前");
  assert.equal(timeAgo("2026-09-30T12:00:00Z", Date.parse("2026-10-03T12:00:00Z")), "3 天前");
  assert.equal(timeAgo("坏了"), "—");
});

test("点奖杯：拉数据、渲染两个榜单（榜单上下不放文字，也不挂悬停解释）", async () => {
  const ui = mount();
  assert.equal(ui.modal.hidden, true, "默认关闭");
  ui.button.fire("click");
  assert.equal(ui.modal.hidden, false, "点一下应弹出");
  assert.equal(ui.button.attrs["aria-expanded"], "true");
  await settle();

  const list = rows(ui.body);
  assert.equal(list.length, 2, "周更新榜应有两行");
  const text = ui.body.all.map((n) => n.textContent ?? "").join(" ");
  // 前端不展示口径解释：列表上下没有文字，列表与标签页也不挂悬停解释（口径只在接口字段里）
  assert.doesNotMatch(text, /窗口 7 天/, "列表上不该有口径文字：" + text);
  assert.ok(!ui.body.title, "列表不该挂悬停解释：" + ui.body.title);
  assert.ok(!ui.t1.title && !ui.t2.title, "标签页不该挂悬停解释：" + ui.t1.title + " / " + ui.t2.title);
  assert.equal(ui.body.children.filter((n) => !n.className?.startsWith("rank-row")).length, 0, "列表里除了行不该有别的段落");
  assert.match(text, /≥8 次/, "主指标应显示更新轮次，并标明这是采样下界（≥）：" + text);
  assert.match(text, /3 天前/, "次行应显示最近推送时间：" + text);
  // 近 7 日趋势柱：7 个槽位，实心 / 浅底座（0）/ 虚线（没观测）三种状态分得开
  const spark = list[0].find((n) => n.className === "spark");
  assert.ok(spark, "行里应有趋势柱：" + list[0].all.map((n) => n.className).join(","));
  const bars = spark.children;
  assert.equal(bars.length, 7, "趋势柱应有 7 个槽位（近 7 日）");
  assert.equal(bars.filter((b) => b.className === "spark-bar none").length, 3, "没观测的天画虚线底座");
  assert.equal(bars.filter((b) => b.className === "spark-bar zero").length, 1, "0 次画浅底座，和没观测区分");
  assert.equal(bars.filter((b) => b.className.includes("peak")).length, 1, "峰值柱单独加重，只应有一根");

  // 每行按自己的峰值归一：柱高 = 值 / 本行峰值 × 18px
  assert.equal(bars[6].style.height, "18px", "本行峰值（5 次）铺满 18px");
  assert.equal(bars[1].style.height, "7px", "2/5 → 7px");
  assert.equal(bars[3].style.height, "4px", "1/5 → 4px");
  const second = rows(ui.body)[1];
  const secondBars = second.find((n) => n.className === "spark").children;
  assert.equal(secondBars[2].style.height, "18px", "另一行的峰值（1 次）也铺满 —— 各行按自己的峰值归一，互不影响");
  // 悬停只留数据（日期 + 数值），不写解释；没观测的天用破折号
  assert.match(bars[1].title, /2026-10-01：2 次$/, "柱子悬停只给「日期：数值」：" + bars[1].title);
  assert.match(bars[0].title, /2026-09-30：—$/, "没观测的天用破折号，不写解释：" + bars[0].title);
  assert.ok(!spark.title, "趋势柱本身不该挂解释：" + spark.title);

  // 版本：最新一个做成胶囊，预发布用 pre 修饰；全量版本在行悬停里
  const ver = list[0].find((n) => n.className === "ver");
  assert.ok(ver, "有版本数据的行应显示版本胶囊：" + list[0].all.map((n) => n.className).join(","));
  assert.equal(ver.textContent, "v1.66.9", "胶囊显示最新版本号");
  const preVer = rows(ui.body)[1].find((n) => n.className?.startsWith("ver"));
  assert.ok(preVer.className.includes("pre"), "预发布版本要能区分：" + preVer.className);
  assert.match(list[0].title, /版本：v1\.66\.9@10-05、v1\.66\.8@10-01/, "行悬停要列全部版本：" + list[0].title);
  assert.match(rows(ui.body)[1].title, /（预发布）/, "预发布要标出来");
  assert.match(text, /one/, "应渲染仓库名：" + text);
  assert.match(text, /acme/, "应渲染作者");
  assert.match(text, /其他/, "应渲染所属扇区");
  assert.match(list[0].title, /^acme\/one/, "行上应有完整 id 的悬浮说明，实际：" + list[0].title);

});

test("周更新热榜按发版判定时：显示 N 个版本（真实计数，不加 ≥）", async () => {
  const data = JSON.parse(JSON.stringify(payload));
  data.boards.updated.metric = "releases";
  data.boards.updated.seriesKind = "releases";
  data.boards.updated.maxUpdates = 3;
  data.boards.updated.items = [
    { ...data.boards.updated.items[0], updates: 3, latestReleaseAt: "2026-10-05", series: [null, null, null, null, null, 0, 3] },
  ];
  const ui = mount({ data });
  ui.button.fire("click");
  await settle();
  const text = ui.body.all.map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /3 个版本/, "按发版判定时显示本周版本数：" + text);
  assert.doesNotMatch(text, /≥/, "真实计数不加下界符号：" + text);
  const bars = rows(ui.body)[0].find((n) => n.className === "spark").children;
  assert.match(bars[6].title, /2026-10-06：3 个版本$/, "逐日柱按发布日期算：" + bars[6].title);
});

test("切到 star 榜：显示真实增量与窗口天数（不堆解释文字）", async () => {
  const ui = mount();
  ui.button.fire("click");
  await settle();
  ui.t2.fire("click");
  const text = ui.body.all.map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /\+960/, "应显示增量：" + text);
  assert.doesNotMatch(text, /实际窗口/, "列表里不该有窗口文字：" + text);
  assert.ok(!ui.body.title && !ui.t2.title, "star 榜也不挂悬停解释：" + ui.body.title);
  // 窗口只有 1.75 天时不能让人误读成"一周"，所以把窗口作为数据放在次行
  assert.match(text, /1\.75 天/, "次行要带真实窗口天数（数据，不是解释）：" + text);
  assert.equal(ui.t2.attrs["aria-selected"], "true");
  assert.equal(ui.t1.attrs["aria-selected"], "false");

  // 跨天累计：只有两个观测点时，不平摊到某一天，而是画一根压在底部的宽条
  const row = rows(ui.body)[0];
  const span = row.find((n) => n.className === "spark-span");
  assert.ok(span, "跨天累计应画成宽条：" + row.all.map((n) => n.className).join(","));
  assert.match(span.style.left, /^14\.28/, "宽条左端对齐 10-01 那个槽位：" + span.style.left);
  assert.match(span.style.width, /^85\.71/, "宽条覆盖 10-01 → 10-06 共 6 个槽位：" + span.style.width);
  assert.match(span.title, /^2026-10-01 → 2026-10-06：\+960 ★$/, "宽条悬停只给起止与数值：" + span.title);
});

test("还没有逐日数据时：柱子全部虚化，并直说原因（不假装是 0）", async () => {
  const data = JSON.parse(JSON.stringify(payload));
  data.boards.updated.seriesDays = 0;
  data.boards.updated.items = data.boards.updated.items.map((it) => ({ ...it, series: [null, null, null, null, null, null, null] }));
  const ui = mount({ data });
  ui.button.fire("click");
  await settle();
  const list = rows(ui.body);
  const spark = list[0].find((n) => n.className === "spark");
  assert.equal(spark.children.filter((n) => n.className === "spark-bar none").length, 7, "7 个槽位都应是「没观测」");
  assert.equal(spark.children.filter((n) => n.className === "spark-bar zero").length, 0, "绝不能把没观测画成 0");
  assert.ok(!ui.body.title, "没有逐日数据也不写解释，柱子自会显示为虚线：" + ui.body.title);
});

test("降级口径（只能靠有限观测）时榜单照常渲染，不堆解释", async () => {
  const data = JSON.parse(JSON.stringify(payload));
  data.boards.updated.updatesSource = "epoch-pair";
  data.boards.updated.note = "还没有按轮的采样日志：只能用盘上一次更早的观测比对，次数上限是 2";
  const ui = mount({ data });
  ui.button.fire("click");
  await settle();
  assert.equal(rows(ui.body).length, 2, "降级口径下照样出榜单");
  assert.ok(!ui.body.title, "降级也不在界面上堆解释：" + ui.body.title);
});

test("趋势图左侧严格对齐：整行列宽必须固定（auto 列会让每行参差）", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const block = /\.rank-row\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const cols = /grid-template-columns:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "";
  assert.ok(cols, "找不到 .rank-row 的列定义");
  assert.ok(!/(^|\s)auto(\s|$)/.test(cols), "列宽里不能有 auto（会随内容变宽，趋势图就会左右参差）：" + cols);
  assert.ok(/(^|\s)\d+px\s+\d+px(\s|$)/.test(cols), "列宽要用固定 px：" + cols);
  assert.ok(/minmax\(0,\s*1fr\)/.test(cols), "只留仓库名那一列伸缩：" + cols);
  const spark = /\.spark\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(/width:\s*\d+px/.test(spark), "趋势图本身也要固定宽度：" + spark);
});

test("点一行：回调仓库 id 并自动关闭弹窗", async () => {
  const ui = mount();
  ui.button.fire("click");
  await settle();
  const first = rows(ui.body)[0];
  first.fire("click");
  assert.deepEqual(ui.picked, ["acme/one"], "应把仓库 id 交给调用方");
  assert.equal(ui.modal.hidden, true, "点完应关闭");
  assert.equal(ui.button.attrs["aria-expanded"], "false");
});

test("遮罩与关闭按钮都能关，Esc 由 app.js 分发（这里只测关闭入口）", async () => {
  const ui = mount();
  ui.button.fire("click");
  await settle();
  ui.mask.fire("click");
  assert.equal(ui.modal.hidden, true, "点遮罩应关闭");
  ui.button.fire("click");
  await settle();
  ui.close.fire("click");
  assert.equal(ui.modal.hidden, true, "点关闭按钮应关闭");
});

test("接口挂了就说拿不到，绝不编数字", async () => {
  const ui = mount({ fail: true });
  ui.button.fire("click");
  await settle();
  const text = ui.body.all.map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /拿不到榜单数据/, "应如实报错，实际：" + text);
  assert.equal(rows(ui.body).length, 0, "失败时不该有任何榜单行");
  assert.equal(ui.board.error() !== null, true);
});

test("star 历史不足：不编增量，直接说明什么时候会有", async () => {
  const data = JSON.parse(JSON.stringify(payload));
  data.boards.stars = { label: "周 star 热榜", metric: "star-gain", available: false, window: null, total: 0, count: 0, items: [], matched: 0, note: "还没有星标历史：采集器每天会把当天的星标记一个点，跑起来之后这里就有真实的周增量。" };
  const ui = mount({ data });
  ui.button.fire("click");
  await settle();
  ui.t2.fire("click");
  const text = ui.body.all.map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /还没有星标历史/, "应原样展示服务端的说明：" + text);
  assert.equal(rows(ui.body).length, 0, "算不出来就不该有行");
  assert.doesNotMatch(text, /\+\d/, "绝不允许出现凭空的增量数字");
});

test("没有接口（静态预览）：按钮照旧能开，正文如实说明", async () => {
  const nodes = { button: new FakeNode("button"), modal: new FakeNode("div"), tabs: new FakeNode("div"), body: new FakeNode("div"), foot: new FakeNode("div"), close: new FakeNode("button") };
  nodes.modal.hidden = true;
  const board = createRankingBoard({ ...nodes, fetcher: null });
  nodes.button.fire("click");
  await settle();
  const text = nodes.body.all.map((n) => n.textContent ?? "").join(" ");
  assert.match(text, /拿不到榜单/, "应说明接口不可用：" + text);
  assert.equal(board.isOpen(), true);
});
