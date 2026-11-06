/**
 * cordis.patch.yml 的受限校验：只解析、不应用、不执行。
 */

import { load, JSON_SCHEMA, Type } from "js-yaml";

export const MAX_PATCH_BYTES = 1024 * 1024;

/**
 * 官方组合包会用 !!js "表达式" 做动态配置（例如 disabled: !!js "!ctx.get(...)"）。
 * 我们只把它解析成占位对象，不执行表达式；否则会误杀官方合法 bundle。
 */
const JS_TAG = new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data) => ({ __dynamicJs: String(data) }),
});
const SCHEMA = JSON_SCHEMA.extend([JS_TAG]);

function hasMeaningfulEntry(items) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  return items.some((item) => {
    if (!isObj(item)) return false;
    if (Array.isArray(item.insert) && item.insert.length > 0) {
      return item.insert.every((entry) => isObj(entry) && typeof entry.id === "string" && entry.id.trim()) &&
        item.insert.some((entry) => typeof entry.name === "string" || typeof entry.module === "string" || entry.config !== undefined || entry.disabled !== undefined);
    }
    if (typeof item.id === "string" && item.id.trim()) {
      return ["name", "config", "disabled", "group", "inject", "intercept", "isolate"].some((k) => item[k] !== undefined);
    }
    return false;
  });
}

export function validatePatchText(text, filePath = "") {
  const errors = [];
  const warnings = [];
  const checks = [];
  const detail = (id, ok, message) => {
    checks.push({ id, ok, detail: message });
    if (!ok) errors.push(message);
  };
  if (typeof text !== "string" || !text.trim()) {
    return { errors: ["patch 文件为空：" + filePath], warnings, checks: [{ id: "patch-nonempty", ok: false, detail: "patch 文件为空" }], items: 0, inserts: 0, review: false };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) {
    return { errors: ["patch 文件超过 " + MAX_PATCH_BYTES + " 字节：" + filePath], warnings, checks: [], items: 0, inserts: 0, review: false };
  }
  // 锚点/别名是合法 YAML；官方/社区 patch 会用。之前用正则一刀切会把注释里的 “*after” 误判成别名。
  // 这里允许解析，但限制解析后的节点数量，防止 YAML 别名爆炸。
  if (/(^|[\s[,{])(?:&|\*)[A-Za-z0-9_]/.test(text)) {
    warnings.push("patch 含 YAML 锚点/别名，已解析但不应用：" + filePath);
    checks.push({ id: "patch-yaml-anchors", ok: true, detail: "含 YAML 锚点/别名，按 YAML 标准解析" });
  }
  const dynamicTags = (text.match(/(^|[\s:\[,])(?:!!|!)js\b/g) || []).length;
  if (dynamicTags > 0) {
    checks.push({ id: "patch-dynamic-js", ok: true, detail: "含 " + dynamicTags + " 个 !!js 动态表达式（不执行，仅记录）" });
    warnings.push("patch 含 " + dynamicTags + " 个 !!js 动态表达式，已作为占位值解析、不执行：" + filePath);
  }
  let data;
  try {
    data = load(text, { schema: SCHEMA, json: false });
  } catch (err) {
    return { errors: ["patch YAML 解析失败：" + filePath + "：" + err.message], warnings, checks: [], items: 0, inserts: 0, review: false };
  }
  // 别名可能放大结构；解析后做节点数上限（10k）与环检测，超限不确认。
  const seen = new WeakSet();
  let nodes = 0;
  let stack = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    nodes += 1;
    if (nodes > 10000) {
      return { errors: ["patch 解析后结构超过 10000 个节点（疑似 YAML 别名放大）：" + filePath], warnings, checks, items: 0, inserts: 0, review: false };
    }
    if (Array.isArray(cur)) stack.push(...cur);
    else stack.push(...Object.values(cur));
  }
  detail("patch-array", Array.isArray(data), "patch 顶层必须是列表：" + filePath);
  if (!Array.isArray(data)) return { errors, warnings, checks, items: 0, inserts: 0, review: false };
  const nonempty = data.length > 0;
  checks.push({ id: "patch-nonempty", ok: nonempty, detail: "patch 列表为空：" + filePath });
  if (!nonempty) warnings.push("patch 列表为空，可安装但没有实际效果：" + filePath);
  const inserts = data.reduce((n, item) => n + (item && Array.isArray(item.insert) ? item.insert.length : 0), 0);
  const meaningful = hasMeaningfulEntry(data);
  checks.push({ id: "patch-meaningful", ok: meaningful, detail: "patch 没有有效条目：" + filePath });
  if (!meaningful) warnings.push("patch 没有可识别的 insert/条目修改，可能是无效或占位文件：" + filePath);
  return { errors, warnings, checks, items: data.length, inserts, review: !meaningful };
}
