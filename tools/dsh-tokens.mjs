#!/usr/bin/env node
/**
 * dsh-tokens —— 从本机安装的 DSH 里解析真实设计令牌（--dsw-*），落成 data/dsh-tokens.json。
 * 需求是「跟 DSH 一样的风格」，凭感觉调色一定走样，所以直接读 DSH 主题包并顺着 var() 引用求值。
 * DSH 升级后重跑本脚本即可同步；tests/dsh-theme.test.mjs 会用本机现值校验快照是否漂移。
 * 用法：node tools/dsh-tokens.mjs [--print]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DSH_ROOT = process.env.DSH_ROOT ?? "/opt/dsh-web";

function declarations(text) {
  const out = {};
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name.startsWith("--")) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

function blocks(css) {
  const out = [];
  for (let i = 0; i < css.length; i++) {
    if (css[i] !== "{") continue;
    let depth = 1;
    let j = i + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
    }
    const body = css.slice(i + 1, j - 1);
    if (!body.includes("--dsw-")) continue;
    let k = i - 1;
    while (k >= 0 && css[k] !== "}" && css[k] !== "{" && css[k] !== ";") k -= 1;
    out.push({ selector: css.slice(k + 1, i).trim(), body });
  }
  return out;
}

export function findThemeCss(root = DSH_ROOT) {
  const store = path.join(root, "node_modules", ".pnpm");
  if (!fs.existsSync(store)) return null;
  const dirs = fs
    .readdirSync(store)
    .filter((n) => n.startsWith("@deepseek-ai+dsh-client-ui-theme@"))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const file = path.join(store, dir, "node_modules", "@deepseek-ai", "dsh-client-ui-theme", "lib", "client.js");
    if (fs.existsSync(file)) return { css: fs.readFileSync(file, "utf8"), pkg: dir };
  }
  return null;
}

export function readDshTokens(root = DSH_ROOT) {
  const found = findThemeCss(root);
  if (found === null) return null;
  const statics = {};   // 层叠来源：--dsw-* 原始/别名；:root 基准层（圆角、字族、字号）；body 亮色别名；body[data-ds-dark-theme] 暗色覆盖
  const roots = {};
  const light = {};
  const dark = {};
  for (const block of blocks(found.css)) {
    const declared = declarations(block.body);
    const sel = block.selector;
    // 选择器可能被 JS 字符串包裹，用 includes 比全等稳
    if (sel.includes("data-ds-dark-theme")) Object.assign(dark, declared);
    else if (sel.includes(":root")) Object.assign(roots, declared);
    else if (/(^|[^\w-])body\b/.test(sel)) Object.assign(light, declared);
    for (const [name, value] of Object.entries(declared)) {
      if (name.startsWith("--dsw-static-")) statics[name] = value;
    }
  }
  if (Object.keys(light).length === 0) return null;
  /**
   * 解析 CSS var()：支持嵌套 fallback（var(--x, var(--y))）与作用域内任意声明，而不再只认
   * “整值恰好是一个 var(--x)”且只查 --dsw-static-*。DSH 升级后 --dsw-font-family 变成了
   * var(--dsh-font-family-text, var(--dsh-font-family-text-default)), …，旧解析器会原样留在快照里。
   */
  const expandVars = (value, scope, level = 0) => {
    const text = String(value ?? "");
    if (!text || level > 12) return text;
    let out = "";
    let cursor = 0;
    while (cursor < text.length) {
      const at = text.indexOf("var(", cursor);
      if (at < 0) { out += text.slice(cursor); break; }
      out += text.slice(cursor, at);
      // 找到与 var( 配对的右括号（fallback 里可能还有嵌套 var()）
      let depth = 0;
      let end = at + 4;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      if (end >= text.length) { out += text.slice(at); break; }
      const inner = text.slice(at + 4, end);
      // 在深度 0 处切第一个逗号：前面是变量名，后面是 fallback
      let comma = -1;
      let innerDepth = 0;
      for (let i = 0; i < inner.length; i += 1) {
        if (inner[i] === "(") innerDepth += 1;
        else if (inner[i] === ")") innerDepth -= 1;
        else if (inner[i] === "," && innerDepth === 0) { comma = i; break; }
      }
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
      let replacement = scope[name];
      if (replacement === undefined || replacement === null) replacement = fallback;
      if (replacement === undefined || replacement === null) {
        out += text.slice(at, end + 1);
      } else {
        out += expandVars(replacement, scope, level + 1);
      }
      cursor = end + 1;
    }
    return out;
  };
  const lightScope = { ...statics, ...roots, ...light };
  const darkScope = { ...statics, ...roots, ...light, ...dark };
  const all = (map, scope) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandVars(v, scope)]));
  const lightAll = all({ ...roots, ...light }, lightScope);
  const darkAll = all({ ...roots, ...light, ...dark }, darkScope);
  return { pkg: found.pkg, light: lightAll, dark: darkAll, statics };
}

/** 前端真正会用到的关键令牌（其余留在快照里备查） */
export const KEY_TOKENS = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-specific-sidebar-fill",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-active",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-radius-xs",
  "--dsw-radius-sm",
  "--dsw-radius-md",
  "--dsw-radius-lg",
  "--dsw-radius-panel",
  "--dsw-font-family",
  "--dsw-font-family-brand",
];

function main() {
  const tokens = readDshTokens();
  if (tokens === null) {
    console.error("未找到已安装的 DSH 主题包（DSH_ROOT=" + DSH_ROOT + "）");
    process.exit(1);
  }
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: { dshRoot: DSH_ROOT, themePackage: tokens.pkg },
    note: "由 tools/dsh-tokens.mjs 从本机 DSH 主题包解析；前端配色以此为准。",
    key: Object.fromEntries(KEY_TOKENS.map((k) => [k, { light: tokens.light[k] ?? null, dark: tokens.dark[k] ?? null }])),
    all: { light: tokens.light, dark: tokens.dark },
  };
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "dsh-tokens.json"), JSON.stringify(snapshot, null, 1));
  console.log("已写入 data/dsh-tokens.json（来源 " + tokens.pkg + "）");
  console.log("亮色令牌 " + Object.keys(tokens.light).length + " 个 / 暗色 " + Object.keys(tokens.dark).length + " 个");
  if (process.argv.includes("--print")) {
    for (const k of KEY_TOKENS) {
      console.log("  " + k.padEnd(44) + "dark=" + String(tokens.dark[k] ?? "—").padEnd(22) + "light=" + String(tokens.light[k] ?? "—"));
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("dsh-tokens.mjs")) main();
