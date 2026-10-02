/**
 * 配色方案（两套 × 明暗两式 = 4 种）。
 *
 * 单一真源：JS 里的这张表同时驱动 CSS 变量与 Canvas 取色，
 * 因此不存在"样式表和画布颜色不一致"的漂移。styles.css 里只留默认值的兜底。
 *
 * 结构（圆角 / 字族 / 层模型）仍沿用 DSH 令牌，只替换色相。
 */

/** 清爽：蓝白底，扇区用一整套不同的蓝 */
const FRESH_LIGHT = {
  css: {
    "--bg-base": "#f6faff",
    "--bg-layer-1": "#ffffff",
    "--bg-layer-2": "#eef5fd",
    "--sidebar": "#f2f8ff",
    "--border-l1": "#dbe9f8",
    "--border-l2": "#c2daf2",
    "--label-1": "#0f2540",
    "--label-2": "#4a6b90",
    "--label-3": "#7f9dbd",
    "--hover": "rgba(47,125,246,.08)",
    "--active": "rgba(47,125,246,.16)",
    "--accent": "#2f7df6",
    "--accent-soft": "rgba(47,125,246,.12)",
    "--warn": "#e08a00",
    "--shadow": "0 8px 24px rgba(23,66,124,.10)",
  },
  canvas: { bg: "#f6faff", ink: "#0f2540", dim: "#4a6b90", faint: "#7f9dbd", accent: "#2f7df6", warn: "#e08a00", ball: "#ffffff", text: "#000000" },
  groups: ["#2f7df6", "#4f9bff", "#1f5fd0", "#6db6ff", "#3f8ae0", "#57c7f0", "#2aa8d8", "#7fa8f0", "#1b4fa8", "#8ed0ff", "#4d6ff0", "#26bec0",
    "#0f8bd0", "#5aa8e8", "#2c6fd6", "#79c2f2", "#1a7fb8", "#4a9de0", "#3ec4d4", "#6f9ae8", "#2560b8", "#9ad8f5", "#3b7be0", "#2fb4c8"],
};

const FRESH_DARK = {
  css: {
    "--bg-base": "#0a1524",
    "--bg-layer-1": "#101f33",
    "--bg-layer-2": "#16293f",
    "--sidebar": "#0d1a2b",
    "--border-l1": "#ffffff14",
    "--border-l2": "#ffffff24",
    "--label-1": "#eaf3ff",
    "--label-2": "#a9c3de",
    "--label-3": "#7d97b3",
    "--hover": "#ffffff14",
    "--active": "#ffffff24",
    "--accent": "#5a9dff",
    "--accent-soft": "rgba(90,157,255,.18)",
    "--warn": "#f0a83c",
    "--shadow": "0 10px 28px rgba(0,0,0,.42)",
  },
  canvas: { bg: "#0a1524", ink: "#eaf3ff", dim: "#a9c3de", faint: "#7d97b3", accent: "#5a9dff", warn: "#f0a83c", ball: "#0a0e13", text: "#ffffff" },
  groups: ["#5a9dff", "#7ab8ff", "#4f8ef7", "#9fd4ff", "#6fb6f5", "#6fd3f0", "#4fc4e8", "#9db8ff", "#7f9cf5", "#a8e0ff", "#6f8ffb", "#5fd8d8",
    "#4fb0ff", "#7fc8ff", "#3f8fe8", "#a8d8ff", "#5fc8e8", "#8fbcff", "#6fd8f0", "#4fa8e0", "#9fc8ff", "#bfe4ff", "#5f9fff", "#7fe0f0"],
};

/** 粉黛：粉白底，扇区用一整套粉／藕／莓色 */
const ROUGE_LIGHT = {
  css: {
    "--bg-base": "#fff7fa",
    "--bg-layer-1": "#ffffff",
    "--bg-layer-2": "#fdeef5",
    "--sidebar": "#fdf2f7",
    "--border-l1": "#f6dae7",
    "--border-l2": "#eec3d9",
    "--label-1": "#3d1526",
    "--label-2": "#8a5570",
    "--label-3": "#b98aa3",
    "--hover": "rgba(232,96,143,.08)",
    "--active": "rgba(232,96,143,.16)",
    "--accent": "#e8608f",
    "--accent-soft": "rgba(232,96,143,.14)",
    "--warn": "#d98200",
    "--shadow": "0 8px 24px rgba(120,40,80,.10)",
  },
  canvas: { bg: "#fff7fa", ink: "#3d1526", dim: "#8a5570", faint: "#b98aa3", accent: "#e8608f", warn: "#d98200", ball: "#ffffff", text: "#000000" },
  groups: ["#e8608f", "#f07fa8", "#d94f7f", "#f2a0bd", "#e0709a", "#c86fae", "#b45f9e", "#f5b8cf", "#d98cb0", "#a8557f", "#ef8fb0", "#c9809f",
    "#d9557f", "#e87fa8", "#c44f8f", "#f2a8c8", "#d4708f", "#b8609f", "#c98fb8", "#e8a0c0", "#b8578f", "#f0c0d8", "#dd7fa8", "#bf6f9f"],
};

const ROUGE_DARK = {
  css: {
    "--bg-base": "#1a0f16",
    "--bg-layer-1": "#241521",
    "--bg-layer-2": "#2f1c2a",
    "--sidebar": "#20121b",
    "--border-l1": "#ffffff14",
    "--border-l2": "#ffffff24",
    "--label-1": "#fdeaf3",
    "--label-2": "#d9aec4",
    "--label-3": "#b0869c",
    "--hover": "#ffffff14",
    "--active": "#ffffff24",
    "--accent": "#ff7fae",
    "--accent-soft": "rgba(255,127,174,.18)",
    "--warn": "#f0a83c",
    "--shadow": "0 10px 28px rgba(0,0,0,.42)",
  },
  canvas: { bg: "#1a0f16", ink: "#fdeaf3", dim: "#d9aec4", faint: "#b0869c", accent: "#ff7fae", warn: "#f0a83c", ball: "#160f14", text: "#ffffff" },
  groups: ["#ff7fae", "#ff9dc0", "#f56a97", "#ffb8d2", "#ff8fb5", "#e58fc4", "#d47ab5", "#ffc9dd", "#f0a3c0", "#c4709a", "#ffa0c0", "#e09fb5",
    "#ff6f9f", "#ff8fb8", "#f05f9f", "#ffb0cf", "#ff9fc0", "#e87fb8", "#ffa8d0", "#d98fb0", "#ff7fb0", "#ffc8e0", "#f590b8", "#e58fc0"],
};

export const PALETTES = {
  fresh: { label: "清爽", light: FRESH_LIGHT, dark: FRESH_DARK },
  rouge: { label: "粉黛", light: ROUGE_LIGHT, dark: ROUGE_DARK },
};

export const PALETTE_IDS = Object.keys(PALETTES);
export const DEFAULT_PALETTE = "fresh";
export const DEFAULT_MODE = "light";

/** 取一套主题：{label, mode, palette, vars, canvas, groups} */
export function themeOf(palette = DEFAULT_PALETTE, mode = DEFAULT_MODE) {
  const entry = PALETTES[palette] ?? PALETTES[DEFAULT_PALETTE];
  const tone = entry[mode === "dark" ? "dark" : "light"];
  return {
    palette: PALETTES[palette] ? palette : DEFAULT_PALETTE,
    mode: mode === "dark" ? "dark" : "light",
    label: entry.label,
    vars: tone.css,
    canvas: tone.canvas,
    groups: tone.groups,
  };
}
