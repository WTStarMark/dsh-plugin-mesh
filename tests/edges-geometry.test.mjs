/**
 * 连线几何测试（v0.4.3）：
 * 被指向的球外面套着同色光圈，所以连线两端要退让到【光圈外沿】再画，
 * 否则线会插进球里、压在光圈上，看起来"穿透"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimSegment } from "../src/graph.js";

test("退让量按两端各自的距离切掉，方向保持原线段方向", () => {
  const seg = trimSegment(0, 0, 100, 0, 10, 20);
  assert.equal(seg.ax, 10);
  assert.equal(seg.ay, 0);
  assert.equal(seg.bx, 80);
  assert.equal(seg.by, 0);
  assert.equal(seg.len, 100);
  // 斜线：退化量沿方向按比例切
  const diag = trimSegment(0, 0, 30, 40, 5, 5); // 长度 50，方向 (0.6, 0.8)
  assert.equal(Math.round(diag.ax * 100) / 100, 3);
  assert.equal(Math.round(diag.ay * 100) / 100, 4);
  assert.equal(Math.round(diag.bx * 100) / 100, 27);
  assert.equal(Math.round(diag.by * 100) / 100, 36);
});

test("两球贴得很近时退让被夹住：线不会被翻过来（起点仍在终点之前）", () => {
  const near = trimSegment(0, 0, 10, 0, 40, 40);
  assert.equal(near.ax, 4.5, "退让量应被夹到弦长的一半");
  assert.equal(near.bx, 5.5);
  assert.ok(near.ax < near.bx, "端点顺序保持，不能翻转");
});

test("不退让时与原始端点完全一致（零值安全）", () => {
  const seg = trimSegment(3, 4, 6, 8);
  assert.equal(seg.ax, 3);
  assert.equal(seg.ay, 4);
  assert.equal(seg.bx, 6);
  assert.equal(seg.by, 8);
});
