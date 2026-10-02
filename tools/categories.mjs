/**
 * 功能分类器（纯规则，零 AI）
 *
 * 为什么不能用 AI 分类：500+ 个仓库逐个让模型读一遍就是烧 token，
 * 而且每次结果不稳定、无法 diff。规则表 + 打分是可审计、可复跑、可手改的。
 *
 * 信号来源：仓库名（权重 ×2）+ 描述 + 非白名单 topic。
 * 关键点：白名单标签本身（dsh / dsh-plugin / dsh-desktop ...）**不作为**分类证据，
 * 否则所有仓库都会被"标签"带偏 —— 这正是需求里说的"不要按标签区分"。
 *
 * 匹配规则（v0.4 起）：
 *   - 英文词按【词边界】匹配（允许简单复数），不再裸子串匹配。
 *     修掉的典型误命中：ui←build、cli←client、hub←github、store←restore、rag←storage、api←rapid。
 *   - 中文词仍按子串匹配（中文没有词边界）。
 *   - 分类可声明 gate（准入门槛）/ exclude（排除条件）/ override（自述救回），用来处理歧义分类。
 */

export const WHITELIST_TAGS = [
  "dsh-plugin-desktop",
  "dsh-desktop",
  "dsh-plugin-market",
  "dsh-plugins",
  "dsh-plugin",
  "dsh",
];

/** 未归类 / 长尾合并后的桶 */
export const OTHER = { id: "other", label: "其他" };

const ASCII_WORD = /^[a-z0-9][a-z0-9 .+-]*$/;
const RE_SPECIALS = /[.*+?^$(){}|[\]\\]/g;

function escapeRegExp(text) {
  return text.replace(RE_SPECIALS, "\\$&");
}

/**
 * 造一个词频计数器：
 *   英文 → 词边界 + 允许 s/es 复数（注意 marketplace 不会命中 market，需要另列词条）
 *   中文 → 子串计数
 */
export function makeCounter(term) {
  if (!ASCII_WORD.test(term)) {
    return (text) => {
      if (!text || !term) return 0;
      let n = 0;
      let idx = text.indexOf(term);
      while (idx !== -1) {
        n += 1;
        idx = text.indexOf(term, idx + term.length);
      }
      return n;
    };
  }
  const pattern = new RegExp("\\b" + escapeRegExp(term) + "(?:s|es)?\\b", "g");
  return (text) => (text ? (text.match(pattern) ?? []).length : 0);
}

/** 规则表：可直接手改。priority 越小优先级越高（仅用于同分裁决） */
export const CATEGORY_RULES = [
  {
    id: "skin",
    label: "皮肤美化",
    priority: 1,
    terms: [["skin", 3], ["theme", 2], ["wallpaper", 3], ["皮肤", 3], ["主题", 2], ["壁纸", 3], ["美化", 3], ["外观", 2], ["配色", 2], ["appearance", 2], ["style", 1]],
  },
  {
    id: "notify",
    label: "语音提醒",
    priority: 2,
    terms: [["voice", 2], ["tts", 3], ["speech", 2], ["sound", 2], ["audio", 2], ["notification", 3], ["语音", 3], ["提醒", 3], ["通知", 2], ["音乐", 2], ["mp3", 3], ["播报", 3], ["提示音", 3]],
  },
  {
    id: "market",
    label: "插件市场",
    priority: 3,
    // 只有"自述是汇集插件的汇总"才算市场：
    // 名字带市场/商店/索引/合集/导航/清单，或描述明确说要收录、汇集、汇总插件。
    // 单纯在描述里提一句 market/store 的插件不算。
    // 名字必须【本身就是汇总】：末段/首段是汇总词，或中文名以汇总词结尾。
    // 名字里只是"提到"市场不算（例如 dsh-market-button 是给市场加按钮的插件）。
    gate: {
      name: /((^|[-_ ])(market|marketplace|store|registry|directory|catalog|collection|index|hub)s?$)|(^(awesome|market|marketplace|registry|store|directory|collection|index)[-_ ])|((市场|商店|集市|商城|合集|汇总|导航|索引|大全|清单|目录)$)/,
      desc: /(收录|汇集|汇总|聚合|收集|整理|精选|导航|合集|大全|清单|目录|索引|awesome\s+list|curated|collection\s+of|a\s+list\s+of|list\s+of\s+plugins|index\s+of|directory\s+of|registry\s+of|marketplace|plugin\s+(store|market|registry|directory|index|catalog))/,
    },
    // 门槛已经足够严（名字必须本身就是汇总），不再另设排除规则，
    // 否则像「插件市场」这种名字里天然带"插件"的汇总站会被误伤。
    terms: [["market", 3], ["marketplace", 3], ["registry", 3], ["store", 2], ["awesome", 2], ["directory", 2], ["catalog", 2], ["collection", 1], ["hub", 1], ["市场", 3], ["商店", 3], ["集市", 3], ["商城", 3], ["索引", 2], ["合集", 3], ["汇总", 3], ["收录", 2], ["导航", 2]],
  },
  {
    id: "desktop",
    label: "桌面客户端",
    priority: 4,
    // 只有"自己就是一个客户端"才算：名字像客户端/应用，或描述明确自述做出了客户端
    gate: {
      name: /(desktop|client|app|gui|shell|studio|launcher|workbench|客户端|桌面|启动器|工作台)/,
      desc: /(桌面客户端|客户端应用|桌面应用|桌面端|独立应用|原生应用|desktop\s+(app|client|application)|native\b[^.]{0,24}\b(app|application|client)|standalone\s+(app|client)|electron|tauri|wails|pyqt|gtk|gui\s+(app|client|launcher)|\b(app|client|launcher|frontend|shell|wrapper|dashboard)\s+(for|to)\b|menu\s*bar\s+app|menu\s+bar\s+client)/,
    },
    // 给客户端写的插件不算客户端：名字里带插件/扩展/皮肤标记的一律排除
    exclude: { name: /(plugin|extension|skill|theme|skin|preset|插件|扩展|技能|皮肤|主题)/ },
    override: { desc: /(这是一个?(桌面)?客户端|本仓库是(一个)?客户端|桌面客户端(应用|程序)?[，,。：]|desktop\s+(app|client)\s+(for|that)|is\s+a\s+desktop\s+(app|client)|是对应桌面客户端)/ },
    terms: [["desktop", 2], ["client", 2], ["tauri", 3], ["electron", 3], ["launcher", 3], ["wails", 3], ["macos", 2], ["windows", 1], ["桌面", 2], ["客户端", 2], ["启动器", 3], ["安装包", 3], ["installer", 2]],
  },
  {
    id: "memory",
    label: "记忆上下文",
    priority: 5,
    terms: [["memory", 3], ["knowledge", 2], ["rag", 3], ["记忆", 3], ["上下文", 2], ["知识库", 3], ["长期记忆", 3]],
  },
  {
    id: "model",
    label: "模型接入",
    priority: 6,
    terms: [["llm", 2], ["provider", 3], ["openai", 3], ["claude", 2], ["gemini", 2], ["ollama", 3], ["endpoint", 2], ["proxy", 2], ["模型", 3], ["接入", 2], ["多模态", 2], ["视觉", 2], ["vision", 2], ["api", 1], ["推理", 2]],
  },
  {
    id: "panel",
    label: "界面面板",
    priority: 7,
    terms: [["panel", 2], ["sidebar", 3], ["editor", 2], ["canvas", 2], ["dashboard", 2], ["widget", 2], ["toolbar", 2], ["面板", 3], ["侧边", 3], ["工作台", 3], ["编辑器", 3], ["界面", 2], ["ui", 1]],
  },
  {
    id: "session",
    label: "会话交互",
    priority: 8,
    terms: [["session", 2], ["chat", 1], ["prompt", 1], ["conversation", 2], ["会话", 3], ["对话", 3], ["提示词", 3], ["消息", 2]],
  },
  {
    id: "agent",
    label: "智能体技能",
    priority: 9,
    terms: [["agent", 1], ["skill", 2], ["mcp", 2], ["workflow", 2], ["automation", 2], ["智能体", 3], ["技能", 3], ["自动化", 2], ["工作流", 3], ["编排", 2], ["多智能体", 3], ["子代理", 3]],
  },
  {
    id: "tools",
    label: "工具命令",
    priority: 10,
    terms: [["cli", 2], ["tool", 1], ["command", 1], ["ssh", 2], ["setup", 1], ["generator", 2], ["工具", 3], ["命令", 2], ["一键", 2], ["安装", 2], ["脚本", 2], ["批量", 2], ["命令行", 3]],
  },
  {
    id: "dev",
    label: "开发调试",
    priority: 11,
    terms: [["debug", 2], ["review", 2], ["lint", 2], ["verify", 2], ["调试", 3], ["测试", 2], ["审查", 3], ["日志", 2], ["验证", 2]],
  },
  {
    id: "web",
    label: "Web 前端",
    priority: 12,
    terms: [["browser", 2], ["前端", 2], ["浏览器", 2], ["vue", 2], ["react", 1], ["网页", 2]],
  },
  {
    id: "remote",
    label: "远程访问",
    priority: 13,
    terms: [["remote", 2], ["ssh", 3], ["tunnel", 3], ["lan", 2], ["frp", 3], ["vpn", 3], ["tailscale", 3], ["局域网", 3], ["内网", 3], ["远程", 3], ["端口转发", 3], ["扫码", 2], ["手机访问", 3]],
  },
  {
    id: "secure",
    label: "安全权限",
    priority: 14,
    terms: [["security", 3], ["auth", 3], ["oauth", 3], ["credential", 3], ["secret", 2], ["permission", 3], ["approval", 3], ["sandbox", 3], ["encrypt", 3], ["安全", 3], ["权限", 3], ["密钥", 3], ["审批", 3], ["脱敏", 3], ["加密", 3], ["审计", 2]],
  },
  {
    id: "bridge",
    label: "集成桥接",
    priority: 15,
    terms: [["bridge", 3], ["adapter", 3], ["integration", 3], ["connector", 3], ["connect", 2], ["对接", 3], ["桥接", 3], ["适配", 3], ["互通", 3], ["中转", 2], ["网关", 2]],
  },
  {
    id: "usage",
    label: "用量额度",
    priority: 16,
    terms: [["usage", 3], ["balance", 3], ["quota", 3], ["billing", 3], ["cost", 2], ["credit", 2], ["用量", 3], ["额度", 3], ["余额", 3], ["计费", 3], ["消耗", 2], ["统计", 1], ["监控", 1]],
  },
  {
    id: "doc",
    label: "阅读文档",
    priority: 17,
    terms: [["reader", 3], ["markdown", 3], ["pdf", 3], ["translate", 3], ["translation", 3], ["wiki", 2], ["阅读", 3], ["翻译", 3], ["笔记", 3], ["字幕", 3], ["摘要", 2], ["文档", 1]],
  },
  {
    id: "file",
    label: "文件管理",
    priority: 18,
    terms: [["folder", 3], ["drag", 2], ["drop", 1], ["file", 1], ["文件", 1], ["目录", 1], ["拖拽", 3], ["网盘", 3], ["附件", 1], ["备份", 2]],
  },
  {
    id: "pet",
    label: "桌宠娱乐",
    priority: 19,
    terms: [["pet", 3], ["pokemon", 3], ["live2d", 3], ["game", 2], ["桌宠", 3], ["宠物", 3], ["养成", 3], ["游戏", 2], ["虚拟形象", 3]],
  },
];

/**
 * 细枝分类：每个大扇区内部再分一层。
 * 只在"选中某个扇区"时用来铺满整个圆（大扇区当整圆、细枝当扇区），
 * 命中规则与主分类同一套（词边界 + 权重），所以是"配合精确命中"而不是另起一套。
 */
export const SUBCATEGORY_RULES = {
  skin: [
    { id: "skin-theme", label: "主题皮肤", terms: [["skin", 3], ["theme", 3], ["配色", 3], ["主题", 3], ["皮肤", 3]] },
    { id: "skin-wallpaper", label: "壁纸背景", terms: [["wallpaper", 3], ["background", 2], ["壁纸", 3], ["背景", 2]] },
    { id: "skin-icon", label: "图标字体", terms: [["icon", 3], ["font", 3], ["图标", 3], ["字体", 3]] },
  ],
  notify: [
    { id: "notify-voice", label: "语音播报", terms: [["voice", 3], ["tts", 3], ["speech", 3], ["语音", 3], ["播报", 3], ["朗读", 3]] },
    { id: "notify-push", label: "通知推送", terms: [["notification", 3], ["push", 2], ["通知", 3], ["推送", 3], ["提醒", 2]] },
    { id: "notify-sound", label: "提示音效", terms: [["sound", 3], ["audio", 3], ["mp3", 3], ["提示音", 3], ["音效", 3], ["音乐", 2]] },
  ],
  market: [
    { id: "market-store", label: "市场商店", terms: [["market", 3], ["marketplace", 3], ["store", 3], ["市场", 3], ["商店", 3]] },
    { id: "market-index", label: "索引合集", terms: [["index", 2], ["registry", 3], ["awesome", 3], ["索引", 3], ["合集", 3], ["导航", 3], ["清单", 3]] },
  ],
  desktop: [
    { id: "desktop-client", label: "客户端本体", terms: [["client", 3], ["desktop", 3], ["客户端", 3], ["桌面", 3]] },
    { id: "desktop-launcher", label: "启动器", terms: [["launcher", 3], ["启动器", 3], ["快捷方式", 2]] },
    { id: "desktop-installer", label: "安装分发", terms: [["installer", 3], ["distribution", 3], ["release", 2], ["安装包", 3], ["分发", 3], ["发布", 2]] },
  ],
  memory: [
    { id: "memory-kb", label: "知识库", terms: [["knowledge", 3], ["wiki", 2], ["知识库", 3], ["知识", 2]] },
    { id: "memory-long", label: "长期记忆", terms: [["memory", 3], ["记忆", 3], ["长期", 2], ["上下文", 2]] },
    { id: "memory-rag", label: "检索增强", terms: [["rag", 3], ["embedding", 3], ["retrieval", 3], ["检索", 3], ["向量", 3], ["召回", 2]] },
  ],
  model: [
    { id: "model-provider", label: "模型供应商", terms: [["provider", 3], ["openai", 3], ["claude", 3], ["gemini", 3], ["ollama", 3], ["模型", 3], ["供应商", 3]] },
    { id: "model-gateway", label: "网关代理", terms: [["proxy", 3], ["gateway", 3], ["endpoint", 3], ["网关", 3], ["代理", 3], ["路由", 2], ["中转", 2]] },
    { id: "model-multimodal", label: "多模态", terms: [["vision", 3], ["multimodal", 3], ["多模态", 3], ["视觉", 3], ["图像", 2], ["图片", 2]] },
  ],
  panel: [
    { id: "panel-side", label: "侧边面板", terms: [["sidebar", 3], ["panel", 3], ["面板", 3], ["侧边", 3]] },
    { id: "panel-editor", label: "编辑器", terms: [["editor", 3], ["编辑器", 3], ["画布", 2], ["canvas", 2]] },
    { id: "panel-widget", label: "悬浮组件", terms: [["widget", 3], ["floating", 3], ["悬浮", 3], ["挂件", 3], ["小组件", 3]] },
    { id: "panel-settings", label: "设置仪表盘", terms: [["settings", 3], ["dashboard", 3], ["设置", 3], ["仪表盘", 3], ["配置页", 2]] },
  ],
  session: [
    { id: "session-manage", label: "会话管理", terms: [["session", 3], ["history", 2], ["会话", 3], ["历史", 2]] },
    { id: "session-prompt", label: "提示词", terms: [["prompt", 3], ["提示词", 3], ["提示语", 3]] },
    { id: "session-chat", label: "消息对话", terms: [["chat", 3], ["message", 2], ["conversation", 3], ["对话", 3], ["消息", 2], ["聊天", 2]] },
  ],
  agent: [
    { id: "agent-skill", label: "技能包", terms: [["skill", 3], ["技能", 3]] },
    { id: "agent-mcp", label: "MCP 服务", terms: [["mcp", 3], ["model context protocol", 3], ["mcp-server", 3]] },
    { id: "agent-workflow", label: "工作流编排", terms: [["workflow", 3], ["automation", 3], ["工作流", 3], ["自动化", 3], ["编排", 3]] },
    { id: "agent-sub", label: "子代理", terms: [["subagent", 3], ["agents", 2], ["多智能体", 3], ["子代理", 3]] },
  ],
  tools: [
    { id: "tools-cli", label: "命令行", terms: [["cli", 3], ["command", 3], ["shell", 2], ["命令行", 3], ["终端", 3]] },
    { id: "tools-install", label: "安装部署", terms: [["install", 2], ["setup", 2], ["deploy", 3], ["安装", 3], ["部署", 3]] },
    { id: "tools-script", label: "脚本批量", terms: [["script", 3], ["batch", 2], ["脚本", 3], ["批量", 3]] },
    { id: "tools-gen", label: "生成转换", terms: [["generator", 3], ["converter", 3], ["export", 2], ["生成", 2], ["转换", 2], ["导出", 2]] },
  ],
  dev: [
    { id: "dev-debug", label: "调试排查", terms: [["debug", 3], ["调试", 3], ["排查", 3]] },
    { id: "dev-review", label: "代码审查", terms: [["review", 3], ["lint", 3], ["审查", 3], ["检查", 2]] },
    { id: "dev-test", label: "测试验证", terms: [["test", 2], ["verify", 3], ["测试", 3], ["验证", 3]] },
    { id: "dev-log", label: "日志", terms: [["log", 2], ["日志", 3]] },
  ],
  web: [
    { id: "web-ext", label: "浏览器扩展", terms: [["browser", 3], ["chrome", 3], ["extension", 3], ["浏览器", 3], ["扩展", 3]] },
    { id: "web-page", label: "网页界面", terms: [["web", 2], ["网页", 3], ["前端", 3]] },
    { id: "web-framework", label: "前端框架", terms: [["vue", 3], ["react", 3], ["component", 2], ["组件", 2]] },
  ],
  remote: [
    { id: "remote-control", label: "远程控制", terms: [["remote", 3], ["远程", 3], ["控制", 2]] },
    { id: "remote-tunnel", label: "隧道穿透", terms: [["ssh", 3], ["tunnel", 3], ["frp", 3], ["隧道", 3], ["穿透", 3], ["端口转发", 3]] },
    { id: "remote-lan", label: "局域网", terms: [["lan", 3], ["局域网", 3], ["内网", 3]] },
  ],
  secure: [
    { id: "secure-perm", label: "权限审批", terms: [["permission", 3], ["approval", 3], ["权限", 3], ["审批", 3], ["授权", 3]] },
    { id: "secure-cred", label: "凭据密钥", terms: [["auth", 3], ["oauth", 3], ["token", 3], ["credential", 3], ["密钥", 3], ["凭据", 3]] },
    { id: "secure-sandbox", label: "沙箱隔离", terms: [["sandbox", 3], ["sandboxing", 3], ["沙箱", 3], ["隔离", 3]] },
    { id: "secure-crypto", label: "加密脱敏", terms: [["encrypt", 3], ["privacy", 3], ["加密", 3], ["脱敏", 3], ["隐私", 3]] },
  ],
  bridge: [
    { id: "bridge-bridge", label: "桥接", terms: [["bridge", 3], ["桥接", 3]] },
    { id: "bridge-adapter", label: "适配器", terms: [["adapter", 3], ["adaptor", 3], ["适配", 3]] },
    { id: "bridge-integration", label: "第三方对接", terms: [["integration", 3], ["connect", 2], ["对接", 3], ["互通", 3], ["第三方", 2]] },
  ],
  usage: [
    { id: "usage-balance", label: "余额", terms: [["balance", 3], ["余额", 3]] },
    { id: "usage-stat", label: "用量统计", terms: [["usage", 3], ["quota", 3], ["统计", 3], ["用量", 3], ["额度", 3], ["消耗", 3]] },
    { id: "usage-billing", label: "计费成本", terms: [["billing", 3], ["cost", 3], ["price", 2], ["计费", 3], ["成本", 3], ["价格", 2]] },
  ],
  doc: [
    { id: "doc-read", label: "阅读浏览", terms: [["reader", 3], ["reading", 3], ["阅读", 3], ["浏览", 2]] },
    { id: "doc-translate", label: "翻译", terms: [["translate", 3], ["translation", 3], ["翻译", 3], ["字幕", 2]] },
    { id: "doc-render", label: "渲染导出", terms: [["markdown", 3], ["pdf", 3], ["render", 2], ["渲染", 3], ["导出", 2], ["预览", 2]] },
  ],
  file: [
    { id: "file-path", label: "文件目录", terms: [["file", 3], ["folder", 3], ["path", 2], ["文件", 3], ["目录", 3], ["路径", 3]] },
    { id: "file-drag", label: "拖拽投放", terms: [["drag", 3], ["drop", 3], ["拖拽", 3], ["拖入", 3], ["投放", 2]] },
    { id: "file-sync", label: "网盘备份", terms: [["sync", 2], ["backup", 3], ["网盘", 3], ["备份", 3], ["同步", 2], ["云盘", 3]] },
  ],
  pet: [
    { id: "pet-pet", label: "桌宠养成", terms: [["pet", 3], ["桌宠", 3], ["宠物", 3], ["养成", 3]] },
    { id: "pet-avatar", label: "虚拟形象", terms: [["live2d", 3], ["avatar", 2], ["虚拟形象", 3], ["形象", 2]] },
    { id: "pet-game", label: "游戏娱乐", terms: [["game", 3], ["pokemon", 3], ["游戏", 3], ["娱乐", 2]] },
  ],
};

/** 生产参数：少于 minCount 的并入「其他」，最多保留 maxSectors 个扇区 */
export const DEFAULT_OPTIONS = { minCount: 10, maxSectors: 18 };

const RULE_BY_PRIORITY = [...CATEGORY_RULES].sort((a, b) => a.priority - b.priority);

function textSignals(node) {
  const topics = (node.topics ?? []).filter((t) => !WHITELIST_TAGS.includes(t)).join(" ");
  return {
    name: (node.name ?? node.id ?? "").toLowerCase(),
    desc: (node.description ?? "").toLowerCase(),
    topics: topics.toLowerCase(),
  };
}

/** 门槛：声明了 gate 的分类，必须至少有一路命中才有资格 */
function passesGate(rule, sig) {
  const gate = rule.gate;
  if (!gate) return true;
  if (gate.name && gate.name.test(sig.name)) return true;
  if (gate.desc && gate.desc.test(sig.desc)) return true;
  if (gate.topics && gate.topics.test(sig.topics)) return true;
  return false;
}

/** 排除：命中即失去资格，除非描述里有强自述把它救回来 */
function isExcluded(rule, sig) {
  const exclude = rule.exclude;
  if (!exclude) return false;
  const hit = (exclude.name && exclude.name.test(sig.name)) || (exclude.desc && exclude.desc.test(sig.desc));
  if (!hit) return false;
  const override = rule.override;
  if (override && ((override.name && override.name.test(sig.name)) || (override.desc && override.desc.test(sig.desc)))) {
    return false;
  }
  return true;
}

/** 单仓库分类：返回 {id,label,score,hits,blocked} */
export function classifyNode(node) {
  const sig = textSignals(node);
  let best = null;
  let blocked = null;
  for (const rule of RULE_BY_PRIORITY) {
    let score = 0;
    const hits = [];
    for (const [term, weight] of rule.terms) {
      const count = makeCounter(term);
      const s = count(sig.name) * weight * 2 + count(sig.desc) * weight + count(sig.topics) * weight;
      if (s > 0) {
        score += s;
        hits.push(term);
      }
    }
    if (score <= 0) continue;
    if (!passesGate(rule, sig)) {
      blocked = blocked ?? { id: rule.id, label: rule.label, reason: "未达门槛" };
      continue;
    }
    if (isExcluded(rule, sig)) {
      blocked = blocked ?? { id: rule.id, label: rule.label, reason: "被排除规则拦下" };
      continue;
    }
    if (!best || score > best.score) best = { id: rule.id, label: rule.label, score, hits: hits.slice(0, 4) };
  }
  if (!best) return { id: OTHER.id, label: OTHER.label, score: 0, hits: [], sub: null, blocked };

  // 细枝：在同一套词边界规则下，挑该扇区内部得分最高的细枝
  const subs = SUBCATEGORY_RULES[best.id];
  let sub = null;
  if (subs) {
    for (const rule of subs) {
      let score = 0;
      const hits = [];
      for (const [term, weight] of rule.terms) {
        const count = makeCounter(term);
        const s = count(sig.name) * weight * 2 + count(sig.desc) * weight + count(sig.topics) * weight;
        if (s > 0) {
          score += s;
          hits.push(term);
        }
      }
      if (score > 0 && (!sub || score > sub.score)) sub = { id: rule.id, label: rule.label, score, hits: hits.slice(0, 3) };
    }
  }
  return { ...best, sub };
}

/**
 * 全量归类 + 长尾合并。
 * minCount: 少于这个数量的类别并入「其他」，避免出现一堆只有两三个仓库的扇区。
 * maxSectors: 扇区上限（超过则把最小的并入「其他」）。
 */
export function applyCategories(nodes, options = {}) {
  const minCount = options.minCount ?? DEFAULT_OPTIONS.minCount;
  const maxSectors = options.maxSectors ?? DEFAULT_OPTIONS.maxSectors; // 19 个分类：上限要够，否则新的小类会被并进「其他」
  const raw = new Map();
  for (const node of nodes) raw.set(node.id, classifyNode(node));

  const counts = new Map();
  for (const result of raw.values()) counts.set(result.id, (counts.get(result.id) ?? 0) + 1);

  const labelOf = new Map(CATEGORY_RULES.map((r) => [r.id, r.label]));
  let kept = [...counts.entries()].filter(([id, n]) => id !== OTHER.id && n >= minCount).map(([id]) => id);
  kept.sort((a, b) => counts.get(b) - counts.get(a) || (labelOf.get(a) < labelOf.get(b) ? -1 : 1));
  const dropped = kept.slice(maxSectors);
  kept = kept.slice(0, maxSectors);
  const keptSet = new Set(kept);

  const merged = [...counts.entries()]
    .filter(([id]) => id !== OTHER.id && !keptSet.has(id))
    .map(([id, n]) => ({ id, count: n, reason: dropped.includes(id) ? "超出扇区上限" : "样本过少" }));

  for (const node of nodes) {
    const result = raw.get(node.id);
    const keep = keptSet.has(result.id);
    node.category = keep ? result.id : OTHER.id;
    node.categoryLabel = keep ? result.label : OTHER.label;
    node.categoryScore = result.score;
    node.categoryHits = result.hits;
    node.subcategory = keep && result.sub ? result.sub.id : null;
    node.subcategoryLabel = keep && result.sub ? result.sub.label : null;
    if (keep) delete node.categoryRaw;
    else node.categoryRaw = result.id;
  }

  const finalCounts = new Map();
  for (const node of nodes) finalCounts.set(node.category, (finalCounts.get(node.category) ?? 0) + 1);

  return {
    counts: [...finalCounts.entries()]
      .map(([id, count]) => ({ id, label: id === OTHER.id ? OTHER.label : labelOf.get(id), count }))
      .sort((a, b) => b.count - a.count),
    merged,
    classified: nodes.filter((n) => n.category !== OTHER.id).length,
    unclassified: finalCounts.get(OTHER.id) ?? 0,
    total: nodes.length,
  };
}
