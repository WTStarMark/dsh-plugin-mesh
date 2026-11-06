/**
 * 限流分桶的 IP 归一化：IPv6 一个 /64 只能算一个桶，否则换地址就能绕过限流。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketIp } from "../tools/ip-bucket.mjs";

test("同一 /64 下的不同 IPv6 地址共用同一个限流桶", () => {
  assert.equal(bucketIp("2001:db8:1:2::1"), bucketIp("2001:db8:1:2:ffff::9"));
  assert.equal(bucketIp("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(bucketIp("2001:db8:1:2:0:0:0:abcd"), "2001:db8:1:2::/64");
});

test("不同 /64 仍是不同桶；IPv4 保持原样", () => {
  assert.notEqual(bucketIp("2001:db8:1:2::1"), bucketIp("2001:db8:1:3::1"));
  assert.equal(bucketIp("1.2.3.4"), "1.2.3.4");
  assert.equal(bucketIp("10.0.0.9"), "10.0.0.9");
});

test("IPv4-mapped、方括号、zone id 都能归一", () => {
  assert.equal(bucketIp("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(bucketIp("[2001:db8:1:2::1]"), "2001:db8:1:2::/64");
  assert.equal(bucketIp("fe80::1%eth0"), bucketIp("fe80::2"));
});

test("非法/空地址不崩，原样当桶", () => {
  assert.equal(bucketIp(""), "?");
  assert.equal(bucketIp(null), "?");
  assert.equal(bucketIp("not-an-ip"), "not-an-ip");
});
