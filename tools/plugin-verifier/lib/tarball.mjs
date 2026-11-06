/**
 * 安全地读取 npm tarball 与 registry JSON。
 *
 * 设计约束：
 * - 只下载、不安装、不执行；
 * - 流式读取并限制字节数，防压缩炸弹/超大响应；
 * - tar 只在内存里解析，不落盘；拒绝绝对路径、..、符号链接/硬链接；
 * - 解析失败只返回错误，不把异常抛给调用方进程。
 */

import { gunzipSync } from "node:zlib";

export const LIMITS = {
  packumentBytes: 16 * 1024 * 1024,
  tarballBytes: 32 * 1024 * 1024,
  uncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 5000,
  maxPatchBytes: 1024 * 1024,
  timeoutMs: 30000,
};

function cstr(buf, offset, length) {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) end += 1;
  return buf.subarray(offset, end).toString("utf8");
}

function parseOctal(buf, offset, length) {
  const raw = cstr(buf, offset, length).trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(i, space).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length) break;
    const record = data.subarray(space + 1, i + len).toString("utf8").replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function safeRelativePath(raw) {
  let p = String(raw || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/")) return null;
  p = p.replace(/^package\//, "");
  if (!p) return null;
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "" || s === ".")) return null;
  return p;
}

/** 解析 tar（未压缩）为 Map<相对路径, Buffer>；忽略目录/符号链接/硬链接。 */
export function parseTar(buf, limits = LIMITS) {
  const files = new Map();
  let offset = 0;
  let total = 0;
  let entries = 0;
  let longName = null;
  let paxPath = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    entries += 1;
    if (entries > limits.maxEntries) throw new Error("tar 条目数超过上限 " + limits.maxEntries);
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const size = parseOctal(header, 124, 12);
    if (size < 0 || size > limits.uncompressedBytes) throw new Error("tar 条目声明大小异常：" + size);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error("tar 条目越界");
    const data = buf.subarray(dataStart, dataEnd);
    if (type === "L") {
      longName = cstr(data, 0, data.length).replace(/\0$/, "");
    } else if (type === "x") {
      const pax = parsePax(data);
      paxPath = pax.path ?? paxPath;
    } else if (type === "0" || type === "7") {
      const rel = safeRelativePath(paxPath || longName || (prefix ? prefix + "/" + name : name));
      paxPath = null;
      longName = null;
      if (rel) {
        total += size;
        if (total > limits.uncompressedBytes) throw new Error("tar 解压后总大小超过上限 " + limits.uncompressedBytes);
        files.set(rel, Buffer.from(data));
      }
    } else {
      paxPath = null;
      longName = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchLimited(url, { maxBytes, timeoutMs = LIMITS.timeoutMs, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { "user-agent": "dsh-plugin-verifier/0.1", ...headers },
    });
    if (!res.ok) throw new Error("HTTP " + res.status + "：" + url);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) {
      const err = new Error("响应声明大小超过上限：" + declared + " 字节（上限 " + maxBytes + "）");
      err.code = "RESPONSE_TOO_LARGE";
      throw err;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        const err = new Error("响应超过上限 " + maxBytes + " 字节");
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPackument(name, options = {}) {
  const url = "https://registry.npmjs.org/" + encodeURIComponent(name);
  // 用 registry 的 abbreviated packument：只含版本/dist 摘要，避免大包 60MB+ 的完整文档。
  const buf = await fetchLimited(url, {
    maxBytes: LIMITS.packumentBytes,
    headers: { accept: "application/vnd.npm.install-v1+json" },
    ...options,
  });
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new Error("packument 不是合法 JSON：" + err.message);
  }
}

/** 直接取某个版本的 manifest（单版本文档很小），避免大包完整 packument 的 60MB+。 */
export async function fetchVersionManifest(name, version = null) {
  const encoded = encodeURIComponent(name);
  let ver = version;
  if (!ver) {
    const tagsBuf = await fetchLimited("https://registry.npmjs.org/-/package/" + encoded + "/dist-tags", {
      maxBytes: 256 * 1024,
    });
    let tags;
    try {
      tags = JSON.parse(tagsBuf.toString("utf8"));
    } catch (err) {
      throw new Error("dist-tags 不是合法 JSON：" + err.message);
    }
    ver = tags.latest;
  }
  if (!ver) throw new Error("registry 没有 latest 版本：" + name);
  const buf = await fetchLimited("https://registry.npmjs.org/" + encoded + "/" + encodeURIComponent(ver), {
    maxBytes: LIMITS.packumentBytes,
  });
  let manifest;
  try {
    manifest = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new Error("版本 manifest 不是合法 JSON：" + err.message);
  }
  return { version: ver, manifest };
}

export async function fetchTarball(url, options = {}) {
  const gz = await fetchLimited(url, { maxBytes: LIMITS.tarballBytes, ...options });
  let raw;
  try {
    raw = gunzipSync(gz, { maxOutputLength: LIMITS.uncompressedBytes });
  } catch (err) {
    throw new Error("tarball 解压失败：" + err.message);
  }
  return parseTar(raw);
}
