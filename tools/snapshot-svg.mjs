#!/usr/bin/env node
/**
 * 生成 README 用的预览图（离线副本）。
 *
 * 现在 README 默认用站点实时接口 http://104.129.51.126/preview.svg（每次采集后自动更新），
 * 本工具用于两种场景：
 *   1. 生成仓库内的静态副本 docs/preview*.svg（断网/接口挂了也能看，且随版本留档）
 *   2. 本地核对：--png 自己 rasterize 一张，在没有浏览器/rsvg 的机器上也能"肉眼看图"
 *
 * 用法：
 *   node tools/snapshot-svg.mjs --out docs/preview.svg       --theme dark
 *   node tools/snapshot-svg.mjs --out docs/preview-light.svg --theme light
 *   node tools/snapshot-svg.mjs --layout --png dist/check.png   # 现场跑布局（mesh-core 不存在时）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPreviewSvg, sceneFromCore, sceneFromLayout, previewView, pickSample, radiusOf } from "./preview-svg.mjs";
import { PALETTES } from "../src/palettes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const OUT = resolve(ROOT, argOf("--out", "docs/preview.svg"));
const SIZE = Number(argOf("--size", "1400"));
const THEME = argOf("--theme", "dark");
const SAMPLE = Number(argOf("--sample", "7000"));
const PNG = argv.includes("--png") ? resolve(ROOT, argOf("--png", "dist/preview-check.png")) : null;
const HUB_ID = "deepseek-ai/deepseek-harness";

let scene;
if (argv.includes("--layout")) {
  const [{ createSectorLayout }, { prepare, groupColor }] = await Promise.all([
    import("../src/layout-sector.js"),
    import("../src/mesh-data.js"),
  ]);
  const mesh = JSON.parse(await readFile(resolve(ROOT, "data/mesh.json"), "utf8"));
  const prepared = prepare(mesh);
  const layout = createSectorLayout({
    nodes: prepared.nodes,
    centerId: HUB_ID,
    groupOf: (n) => n.category ?? "other",
    labelOf: (n, key) => n.categoryLabel ?? key,
    seed: "readme-preview",
  });
  layout.run(200); // 必须真跑布局，否则节点全在原点、扇区楔形会被甩到画布外
  scene = sceneFromLayout(layout, prepared);
  scene.hubId = HUB_ID;
  void groupColor;
} else {
  const core = JSON.parse(await readFile(resolve(ROOT, argOf("--core", "data/mesh-core.json")), "utf8"));
  scene = sceneFromCore(core);
  scene.hubId = scene.hubId ?? HUB_ID;
}

const svg = renderPreviewSvg(scene, { theme: THEME, size: SIZE, sample: SAMPLE });
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, svg, "utf8");
console.log("已生成 " + OUT.replace(ROOT + "/", ""));
console.log(
  "  主题 " + THEME + " · 仓库 " + scene.total + " · 扇区 " + scene.arms.filter((a) => a.count).length +
    " · 画了 " + (svg.match(/<use /g) ?? []).length + " 个球 · " + (svg.length / 1024).toFixed(0) + " KB",
);

// ---- 可选：自己 rasterize 一张 PNG，供无浏览器环境肉眼核对 ----
if (PNG) {
  const W = Number(argOf("--png-size", "900"));
  const canvas = (PALETTES.fresh[THEME] ?? PALETTES.fresh.dark).canvas;
  const { scale, px, py, midX, midY } = previewView(scene, SIZE);
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const bg = hex2rgb(canvas.bg);
  const buf = Buffer.alloc(W * W * 3);
  for (let i = 0; i < W * W; i++) {
    buf[i * 3] = bg[0];
    buf[i * 3 + 1] = bg[1];
    buf[i * 3 + 2] = bg[2];
  }
  const k = W / SIZE;
  const { groupColor } = await import("../src/mesh-data.js");
  const armColor = (id) => hex2rgb(groupColor(id, scene.arms.findIndex((a) => a.id === id)));
  // 扇区
  for (const a of scene.arms) {
    if (!a.count) continue;
    const c = armColor(a.id);
    const outer = (a.endRadius ?? 0) * 1.04;
    const inner = Math.max(0, (a.rMin ?? 0) * 0.55);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const lx = midX + (x / k - SIZE / 2) / scale;
        const ly = midY + (y / k - SIZE / 2) / scale;
        const r = Math.hypot(lx, ly);
        if (r > outer || r < inner) continue;
        let ang = Math.atan2(ly, lx);
        while (ang < a.startAngle) ang += Math.PI * 2;
        if (ang > a.endAngle) continue;
        const o = (y * W + x) * 3;
        buf[o] = Math.round(buf[o] * 0.9 + c[0] * 0.1);
        buf[o + 1] = Math.round(buf[o + 1] * 0.9 + c[1] * 0.1);
        buf[o + 2] = Math.round(buf[o + 2] * 0.9 + c[2] * 0.1);
      }
    }
  }
  // 球（与渲染用同一套抽样，不靠正则反推）
  const drawNodes = pickSample(
    scene.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.id !== scene.hubId),
    SAMPLE,
  );
  for (const n of drawNodes) {
    const c = hex2rgb(groupColor(n.category, scene.arms.findIndex((a) => a.id === n.category)) ?? canvas.accent);
    const cx0 = Math.round(px(n.x) * k);
    const cy0 = Math.round(py(n.y) * k);
    const rr = Math.max(1, Math.round(radiusOf(n) * k));
    for (let y = cy0 - rr; y <= cy0 + rr; y++) for (let x = cx0 - rr; x <= cx0 + rr; x++) {
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      if ((x - cx0) ** 2 + (y - cy0) ** 2 > rr * rr) continue;
      const o = (y * W + x) * 3;
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
    }
  }
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await mkdir(dirname(PNG), { recursive: true });
  await writeFile(PNG, png);
  console.log("  核对图 " + PNG.replace(ROOT + "/", "") + "（" + (png.length / 1024).toFixed(0) + " KB）");
}
