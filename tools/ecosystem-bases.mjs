/**
 * 生态共鸣基座的内置定义 —— 「锚定条件」的出厂值。有两个使用方，定义只能有一处：
 *   1) tools/curate-ecosystem.mjs 按这些条件发现「长在基座上的插件」；
 *   2) 管理后台展示内置/当前锚定条件并允许运营改写（写 data/admin/ecosystem.json，策展工具下次优先读它）。
 * 锚定条件四件套：tag 生态签（最硬的归属信号，可为空）、probes 探针词、packages 包名/标识（README 复核认哪些写法）、
 * context 语境规则（提到它时什么上下文才算「长在它上面」，避免「挂个标签」就算）。
 */

/** 语境规则（命名预设，不给后台开放任意正则 —— 任意正则等于把 ReDoS 请进门） */
export const CONTEXT_RULES = {
  depend: {
    label: "依赖 / 扩展",
    desc: "README 说「基于 / 依赖 / 扩展 / 适配」它；插件型基座的默认规则",
    re: /(基于|依赖|需要|配合|搭配|集成|适配|内嵌|内置|安装|前置|built\s+on|based\s+on|depends?\s+on|requires?|powered\s+by|extends?|extension\s+for|plugin\s+for|addon|wrapper|compatible\s+with|integrat)/i,
  },
  conform: {
    label: "规范遵循",
    desc: "README 说「遵循 / 符合 / 实现 / 对齐」它；规范、元协议类基座用",
    re: /(遵循|遵从|符合|依照|参考|实现|采用|基于|依赖|兼容|对齐|conform|comply|follow|adopt|implement|based\s+on|compatible)/i,
  },
  skin: {
    label: "皮肤包格式",
    desc: "README 说「导入 / 导出 / 格式 / 皮肤包」；文件格式类基座用",
    re: /(导入|导出|import|export|格式|format|皮肤包|skin\s*(file|pack)|payload|换肤|url\s*scheme)/i,
  },
};

export const CONTEXT_IDS = Object.keys(CONTEXT_RULES);

export const DEFAULT_CONTEXT = "depend";

/** 内置基座：出厂锚定条件。enabled=false 表示"照旧策展、只是不建边"。 */
export const BUILTIN_BASES = [
  {
    id: "omdsh-dev/DSH-better-sidebar",
    label: "侧边栏底座",
    tag: "dsh-better-sidebar",
    enabled: true,
    probes: ["dsh-better-sidebar"],
    packages: ["dsh-better-sidebar"],
    context: "depend",
  },
  {
    id: "ccch1mneyyy/dsh-TUI",
    label: "TUI 基座",
    tag: "dsh-tui-ecosystem",
    enabled: true,
    probes: ["dsh-tui", "dsh-tui-ecosystem"],
    packages: ["@deepseek-harness-tui/dsh-tui", "dsh-tui"],
    context: "depend",
  },
  {
    id: "T-Auto/dsh-std",
    label: "互操作元协议",
    tag: null,
    enabled: true,
    probes: ["dsh-std"],
    packages: ["dsh-std"],
    context: "conform",
  },
  {
    id: "T-Auto/dsh-ecosystem-spec",
    label: "生态共识规范",
    tag: null,
    enabled: true,
    probes: ["dsh-ecosystem-spec"],
    packages: ["dsh-ecosystem-spec"],
    context: "conform",
  },
  {
    id: "WTStarMark/dsh-myskin",
    label: "皮肤框架",
    // 暂时关闭它的生态共鸣；保留定义而不是删掉，改回 true 即可恢复。
    enabled: false,
    tag: null,
    probes: ["dsh-myskin", "dshskin"],
    packages: ["dsh-myskin", ".dshskin"],
    context: "skin",
  },
];

export function builtinBase(id) {
  return BUILTIN_BASES.find((b) => b.id === id) ?? null;
}
