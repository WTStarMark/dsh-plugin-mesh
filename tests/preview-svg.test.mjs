/**
 * 预览图渲染测试：构图必须与画布尺寸无关。
 * 背景：线上 README 的预览图一度落到最小档 600px，而字号 / 图例 / 留白 / 球半径都是按 1400 画布写死的
 * 固定像素，于是"坐标缩了、字没缩"，21 个扇区标签在圆心挤成一团（实测 51 对文字重叠）。
 * 这里锁住两条不变量：①参考尺寸下这些常量保持原值；②任何尺寸出的都是同一张图的不同分辨率。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPreviewSvg, previewView, REF_SIZE } from "../tools/preview-svg.mjs";

const K600 = 600 / REF_SIZE;

/** 造一个小场景：3 个扇区 + 1 个圆心 + 若干仓库球，不依赖 data/ 下的运行时数据 */
function scene() {
  const nodes = [{ id: "o/hub", x: 0, y: 0, r: 8, stars: 900, category: "core", categoryLabel: "核心" }];
  for (let i = 0; i < 36; i++) {
    const arm = i % 3;
    const angle = -Math.PI / 2 + arm * ((Math.PI * 2) / 3) + (i % 5) * 0.02;
    const r = 30 + (i % 7) * 12;
    nodes.push({
      id: "o/r" + i,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      r: 3,
      stars: (i * 37) % 500,
      category: ["core", "ui", "doc"][arm],
      categoryLabel: ["核心", "界面", "文档"][arm],
    });
  }
  const arm = (id, label, count, angle) => ({
    id, label, count, angle,
    startAngle: angle - 0.5,
    endAngle: angle + 0.5,
    rMin: 30,
    endRadius: 150,
  });
  return {
    nodes,
    arms: [arm("core", "核心", 12, -Math.PI / 2), arm("ui", "界面", 9, Math.PI / 6), arm("doc", "文档", 4, Math.PI * 0.8)],
    hubId: "o/hub",
    total: 123,
    generatedAt: "2026-10-11T00:00:00Z",
  };
}

const attrMap = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};

/** 解析 <text>：font-size / text-anchor 要按 SVG 规则从 <g> 继承，否则框算错 */
function textBoxes(svg, scale = 1) {
  const out = [];
  const stack = [];
  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const tag = m[0];
    if (tag.startsWith("</")) {
      if (tag.startsWith("</g")) stack.pop();
      continue;
    }
    const name = (tag.match(/^<([a-zA-Z]+)/) ?? [])[1];
    if (name === "g") {
      stack.push(attrMap(tag));
      continue;
    }
    if (name !== "text") continue;
    const end = svg.indexOf("</text>", tagRe.lastIndex);
    const merged = Object.assign({}, ...stack, attrMap(tag));
    const size = +(merged["font-size"] ?? 16) / scale;
    const x = +merged.x / scale;
    const y = +merged.y / scale;
    let w = 0;
    for (const ch of svg.slice(tagRe.lastIndex, end)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55;
    const left = (merged["text-anchor"] ?? "start") === "middle" ? x - w / 2 : x;
    out.push({ text: svg.slice(tagRe.lastIndex, end), size, x0: left, x1: left + w, y0: y - size * 0.82, y1: y + size * 0.14 });
    tagRe.lastIndex = end + "</text>".length;
  }
  return out;
}

const overlapCount = (boxes) => {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox * oy >= 6) n++;
  }
  return n;
};

const fontSizeOf = (svg, text) => {
  const hit = textBoxes(svg).find((b) => b.text === text);
  return hit ? hit.size : null;
};

test("画布尺寸与请求一致", () => {
  for (const size of [600, 800, 1400]) {
    const svg = renderPreviewSvg(scene(), { size, sample: 50 });
    assert.match(svg, new RegExp('width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '"'));
  }
});

test("参考尺寸 1400 下字号 / 留白保持原值（改这里等于改设计稿）", () => {
  const svg = renderPreviewSvg(scene(), { size: REF_SIZE, sample: 50 });
  assert.equal(fontSizeOf(svg, "插件生态图"), 30, "标题 30px");
  assert.equal(fontSizeOf(svg, "核心"), 21, "扇区标签 21px");
  const view = previewView(scene(), REF_SIZE);
  assert.equal(view.k, 1, "参考尺寸的缩放比必须是 1");
});

test("字号与球半径都随画布等比缩放", () => {
  const big = renderPreviewSvg(scene(), { size: REF_SIZE, sample: 50 });
  const small = renderPreviewSvg(scene(), { size: 600, sample: 50 });
  assert.ok(Math.abs(fontSizeOf(small, "插件生态图") - 30 * K600) < 0.06, "600 画布标题应为 30×0.43");
  assert.ok(Math.abs(fontSizeOf(small, "核心") - 21 * K600) < 0.06, "600 画布扇区标签应为 21×0.43");

  const maxR = (svg) => Math.max(...[...svg.matchAll(/<circle id="[^"]*" r="([\d.]+)"/g)].map((m) => +m[1]));
  const ratio = maxR(small) / maxR(big);
  assert.ok(Math.abs(ratio - K600) < 0.06, "球半径应随画布缩放，实际比值 " + ratio.toFixed(3));
});

test("构图与画布尺寸无关：600 与 1400 是同一张图的不同分辨率", () => {
  const big = renderPreviewSvg(scene(), { size: REF_SIZE, sample: 50 });
  const small = renderPreviewSvg(scene(), { size: 600, sample: 50 });
  const a = textBoxes(big, 1);
  const b = textBoxes(small, K600); // 归一化回 1400 画布
  assert.equal(b.length, a.length, "文本条数应一致");
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].text, a[i].text, "第 " + i + " 条文本应一致");
    for (const key of ["size", "x0", "x1", "y0", "y1"]) {
      assert.ok(Math.abs(a[i][key] - b[i][key]) < 1.5, "「" + a[i].text + "」的 " + key + " 应缩放一致：" + a[i][key] + " vs " + b[i][key]);
    }
  }
  assert.equal(overlapCount(b), overlapCount(a), "同构图的重叠对数必须相同");
});

test("小画布不再把标签挤成一团（回归：600 画布重叠对数 <= 1400 画布）", () => {
  const big = renderPreviewSvg(scene(), { size: REF_SIZE, sample: 50 });
  const small = renderPreviewSvg(scene(), { size: 600, sample: 50 });
  assert.ok(overlapCount(textBoxes(small, 1)) <= overlapCount(textBoxes(big, 1)), "600 画布的文字重叠不应比 1400 更多");
});
