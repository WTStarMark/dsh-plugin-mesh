/**
 * 功能分类器（纯规则，零 AI）：规则表 + 打分，可审计、可复跑、可手改 ——
 * 500+ 个仓库逐个让模型读一遍就是烧 token，而且每次结果不稳定、无法 diff。
 * 信号：仓库名（权重 ×2）+ 描述 + 非白名单 topic。关键点：白名单标签本身（dsh / dsh-plugin …）
 * 不作为分类证据，否则所有仓库都会被「标签」带偏 —— 这正是需求里「不要按标签区分」的意思。
 * 英文词按【词边界】匹配（允许简单复数），修掉过 ui←build、cli←client、hub←github、store←restore、rag←storage 等误命中；中文词仍按子串。
 * 分类可声明 gate（准入门槛）/ exclude（排除条件）/ override（自述救回），用来处理歧义分类。
 */

import { loadAdminConfig, whitelistAliasesOf, whitelistTagsOf } from "./admin-config.mjs";

/**
 * 捕获标签白名单：以 data/admin/config.json 为准（管理后台里可改），文件不存在/损坏时回退默认值。
 * Python 侧 backend/dsh_mesh/config.py 读同一份数据，后台改一次两边同时变，不会再出现「只改了一处」的分叉。
 */
export const WHITELIST_TAGS = whitelistTagsOf(loadAdminConfig());
export const WHITELIST_ALIASES = whitelistAliasesOf(loadAdminConfig());
/** 分类证据里要剔除的标签 = 白名单 + 别名（别名同样是"生态签"，留着会把分类带偏） */
export const SIGNAL_TAGS = new Set([...WHITELIST_TAGS, ...WHITELIST_ALIASES.flatMap((g) => g.aliases)]);

export const OTHER = { id: "other", label: "其他" };

/**
 * 非插件语境排除：这些仓库确实挂着 dsh 标签，但 DSH 在它们那里是【别的意思】
 * （典型：DeepHash-pytorch 的 DSH = Deep Supervised Hashing），这类不进索引、不进前端。
 * 判据刻意写窄：只认「另一个 DSH 全称」的直接证据，不靠「看起来不像插件」，免得误伤描述写得少的真插件。
 */
export const NOT_PLUGIN_PATTERNS = [
  { re: /deep\s*hash|deephash|deep hashing|深度哈希|哈希算法|image retrieval|检索演示/i, why: "深度哈希类：这里的 DSH 是 Deep Supervised Hashing，不是 DeepSeek Harness" },
  { re: /digital\s*signal\s*processing|离散时间信号/i, why: "数字信号处理类：DSH 是别的缩写" },
];
/** 命中即"不是 DSH 插件"，返回原因；没命中返回 null */
export function nonPluginReason(node) {
  const text = (node.name ?? "") + " " + (node.description ?? "") + " " + (node.topics ?? []).join(" ");
  for (const { re, why } of NOT_PLUGIN_PATTERNS) if (re.test(text)) return why;
  const topics = (node.topics ?? []).map((t) => String(t).toLowerCase());
  if (topics.includes("deep-hashing")) return "深度哈希类：topic 直接写着 deep-hashing";
  return null;
}

const ASCII_WORD = /^[a-z0-9][a-z0-9 .+-]*$/;
const RE_SPECIALS = /[.*+?^$(){}|[\]\\]/g;

function escapeRegExp(text) {
  return text.replace(RE_SPECIALS, "\\$&");
}

/**
 * 造一个词频计数器：英文按词边界 + 允许 s/es 复数（注意 marketplace 不会命中 market，需要另列词条）；
 * 中文按子串计数。
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

/**
 * 「基座」自述：基座/底座/框架/脚手架… 紧邻插件生态词（插件/扩展/皮肤/面板/侧边栏/工作台…）。
 * 刻意要求「相邻」：单说 framework 的仓库满大街都是，只有「给插件生态当底座」的自述才算数。
 */
const BASE_WORDS = "底座|基座|脚手架|基础设施|框架|foundation|framework|scaffold|infrastructure";
const ECO_WORDS = "插件|扩展|拓展|生态|三方|宿主|皮肤|面板|侧边栏|工作台|工具链|plugin|extension|ecosystem|host";
// 中间最多 4 个字符，且不能跨标点 —— 否则「插件：10 条内置思维框架」「框架逻辑可测试。dsh-plugin」这种跨小句的巧合也会算成「基座自述」。
const GAP = "[^，。；：、,.;:!?|()（）\\n]{0,4}";
const BASE_SELF_SRC = "(" + BASE_WORDS + ")" + GAP + "(" + ECO_WORDS + ")|(" + ECO_WORDS + ")" + GAP + "(" + BASE_WORDS + ")";
const BASE_SELF_DESC = new RegExp(BASE_SELF_SRC, "i");

/**
 * 「强基座自述」比普通自述更严：基座/框架必须紧邻生态级词（插件生态/生态/宿主/三方/拓展/皮肤/面板/侧边栏/工作台/工具链）。
 * 单说「X框架插件」「能力底座插件」不算 —— 否则任何自称框架的插件都会被当成生态基座。
 */
const ECO_STRONG_WORDS = "插件生态|生态|宿主|三方|拓展|皮肤|面板|侧边栏|工作台|工具链|plugin ecosystem|ecosystem|host|sidebar|panel|skin|theme|workbench";
const BASE_STRONG_SRC = "(" + BASE_WORDS + ")" + GAP + "(" + ECO_STRONG_WORDS + ")|(" + ECO_STRONG_WORDS + ")" + GAP + "(" + BASE_WORDS + ")";
const BASE_STRONG_DESC = new RegExp(BASE_STRONG_SRC, "i");

/** 「协议/规范」自述判据 */
const SPEC_SELF_SRC =
  "(插件|生态|社区)[^\\n]{0,10}(规范|标准|公约|共识|契约|协议)|互操作|元协议|meta[- ]protocol|plugin[- ](standard|spec|specification|convention|contract|schema|manifest)|ecosystem[- ](standard|spec|specification|convention)|community[- ](standard|spec|consensus|convention)|conventions every plugin|(standard|specification|protocol)\\s+for\\s+(dsh|deepseek|plugins?)";

/**
 * 桌宠扇区的「自述」判据（与 backend/dsh_mesh/classify.py 逐字对齐）：
 * PET_SKIN_SELF 说的是「长什么样」，PET_SELF 说的才是「陪着你的角色」——「鲸鱼娘/小鲸鱼」只说明角色长相，
 * 自称「皮肤系列」的仓库不该被它拉进桌宠扇区。
 */
const PET_SKIN_SELF = /皮肤|主题|壁纸|外观|美化|配色|skin|theme|wallpaper|appearance/i;
const PET_SELF = /\bpet\b|\bpets\b|桌宠|宠物|养成|pokemon|live2d|mascot|吉祥物|陪伴|看板娘|小鲸鱼/i;

/** 规则表：可直接手改。priority 越小优先级越高（仅用于同分裁决） */
export const CATEGORY_RULES = [
  {
    id: "skin",
    label: "皮肤美化",
    priority: 1,
    terms: [["skin", 3], ["theme", 2], ["wallpaper", 3], ["background", 2], ["皮肤", 3], ["主题", 2], ["壁纸", 3], ["背景", 2], ["美化", 3], ["外观", 2], ["配色", 2], ["appearance", 2], ["style", 1], ["开屏", 3], ["开机动画", 3], ["启动动画", 2], ["启动画面", 2], ["splash", 3], ["boot animation", 3], ["boot-animation", 3], ["片头", 3]],
  },
  {
    id: "notify",
    label: "通知提醒",
    priority: 2,
    terms: [["voice", 2], ["tts", 3], ["speech", 2], ["sound", 2], ["notification", 3], ["语音", 3], ["提醒", 3], ["通知", 2], ["mp3", 3], ["播报", 3], ["提示音", 3]],
  },
  {
    id: "market",
    label: "插件市场",
    priority: 3,
    // 只有「自述是汇集插件的汇总」才算市场：名字带市场/商店/索引/合集/导航/清单，或描述明确说要收录、汇集、汇总插件；
// 名字里只是「提到」市场不算（例如 dsh-market-button 是给市场加按钮的插件）。
    gate: {
      // 名字必须本身就是「插件汇总」的招牌词；store/index/catalog/hub 这类泛词不再单独放行（避免 workspace-hub、context-catalog 混入）
      name: /((^|[-_ ])(market|marketplace|registry|awesome)s?$)|(^(awesome|market|marketplace|registry)[-_ ])|((市场|商店|集市|商城|合集|汇总|导航|索引|大全|清单|目录|精选)$)/,
      // 描述必须自述"在汇总插件"：去掉裸 marketplace / 裸 directory of，改成插件语境的正向短语
      desc: /(收录|汇集|汇总|聚合|收集|整理|精选|导航|合集|大全|清单|目录|索引|插件\s*(市场|商店|集市|商城)|插件(目录|合集|总目录|索引)|awesome\s+list|curated|collection\s+of|a\s+list\s+of|list\s+of\s+(dsh\s+)?plugins|index\s+of\s+(dsh\s+)?plugins|directory\s+of\s+[^。\n]{0,30}plugins|registry\s+of\s+[^。\n]{0,30}plugins|plugin\s+(hub|directory|list|store|market|marketplace|registry|index|catalog)|plugin[- ]market|marketplace\s+(for|of|plugin)|(hub|dsh)\s+marketplace|extension\s+(center|hub)|(browsable|searchable)[^。\n]{0,20}directory|(browse|search|discover|find)[^。\n]{0,30}(插件|plugins?)|(dsh|harness)\s*(插件)?\s*(市场|商店|集市|商城)|marketplace\s+(for|of))/,
    },
    // 名字是「某个细分领域的市场」不算插件市场（股票行情、提示词市场、皮肤市场、模型目录…），交给各自扇区。
    exclude: { name: /(stock|finance|trading|trade|quant|crypto|currency|prompt|skin|theme|token|model|image|video|music|game|gating|guard|safety|scanner|audit|checker|health|upgrade|股票|行情|金融|交易|量化|提示词|皮肤|主题)/ },
    terms: [["market", 3], ["marketplace", 3], ["registry", 3], ["store", 2], ["awesome", 2], ["directory", 2], ["catalog", 2], ["collection", 1], ["hub", 1], ["市场", 3], ["商店", 3], ["集市", 3], ["商城", 3], ["索引", 2], ["合集", 3], ["汇总", 3], ["收录", 2], ["导航", 2]],
  },
  {
    id: "desktop",
    label: "客户端应用",
    priority: 4,
    // 只有"自己就是一个客户端"才算：名字像客户端/应用，或描述明确自述做出了客户端
    gate: {
      // 只认「客户端本体」的自述：名字里 desktop/client 是主体，或描述明确说做出了 App/客户端；
      // 不认 topics 里的 app 标签，也不认「for windows/macos」这种平台限定（大量插件也这么写）。
      name: /(^|[-_])(desktop|client|launcher|workbench|pc|客户端|桌面版|启动器|工作台)([-_]|$)/,
      desc: /(这是一个?(桌面|移动|手机|安卓|ios)?\s*客户端(?!\s*(插件|plugin))|本仓库是(一个)?客户端(?!\s*(插件|plugin))|桌面客户端(?!\s*(插件|plugin))|桌面应用(?!\s*(插件|plugin))|桌面启动器|桌面控制中心|桌面工作台|mobile\s+(app|client)(?!\s*(plugin|插件))|android\s+(app|client)|ios\s+(app|client)|apk\b|装进口袋|装进\s*(手机|android)|手机本机|本机运行|run\s+(deepseek\s+harness|dsh)[^.]{0,40}on\s+(android|ios)|(mac|windows|linux)\s*端[^。\n]{0,20}(gui|客户端|app|应用)|native\s+(macos|windows|linux)\s+(app|client)|desktop\s+(app|client|application)(?!\s*(plugin|插件))|desktop\s+launcher|tray\s+(app|launcher)|menu\s*bar\s+app|桌面版[^。\n]{0,10}(deepseek|harness|dsh))/,
    },
    // 给客户端写的插件不算客户端：名字带插件/皮肤类标记，或 client-xxx / desktop-statusbar 这类插件命名，一律排除
    exclude: { name: /(plugin|extension|skill|theme|skin|preset|widget|panel|sidebar|toolbar|button|statusbar|notif(y|ier)|badge|tweak|pricing|restart|reload|layout|hotkey|shortcut|indicator|overlay|locale|language|quote|route|icon|connect|bridge|adapter|connector|gateway|integration|automation|control|remote|workspace|paseo|zcode|codex|qwen|workbuddy|chatgpt|(^|[-_])client[-_]|(^|[-_])(api|mcp|vnc|mc|opencode|vectr|collaboration|invoice|pet|whale|obsidian)([-_]|$)|插件|扩展|技能|皮肤|主题|面板|侧边栏)/ },
    override: { desc: /(这是一个?(桌面)?客户端|本仓库是(一个)?客户端|桌面客户端(应用|程序)?[，,。：]|desktop\s+(app|client)\s+(for|that)|is\s+a\s+desktop\s+(app|client)|是对应桌面客户端)/ },
    terms: [["desktop", 2], ["client", 2], ["tauri", 3], ["electron", 3], ["launcher", 3], ["wails", 3], ["macos", 2], ["windows", 1], ["android", 2], ["ios", 2], ["flutter", 2], ["mobile", 2], ["app", 1], ["gui", 2], ["桌面", 2], ["桌面版", 3], ["桌面端", 2], ["桌面应用", 3], ["客户端", 2], ["启动器", 3], ["安装包", 3], ["installer", 2], ["手机", 2], ["安卓", 2], ["跨平台", 1]],
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
    terms: [["llm", 2], ["provider", 3], ["openai", 3], ["claude", 2], ["gemini", 2], ["ollama", 3], ["endpoint", 2], ["proxy", 2], ["reasoning", 2], ["thinking", 2], ["effort", 2], ["route", 1], ["router", 3], ["routing", 2], ["模型", 3], ["接入", 1], ["多模态", 2], ["视觉", 2], ["vision", 2], ["api", 1], ["推理", 2], ["思考", 2], ["负载均衡", 2], ["fallback", 2], ["降级", 2]],
  },
  {
    id: "panel",
    label: "界面面板",
    priority: 7,
    terms: [["panel", 2], ["sidebar", 3], ["editor", 2], ["canvas", 2], ["dashboard", 2], ["widget", 2], ["toolbar", 2], ["settings", 2], ["button", 2], ["menu", 1], ["hud", 2], ["面板", 3], ["侧边", 3], ["工作台", 3], ["编辑器", 3], ["界面", 2], ["设置", 2], ["按钮", 2], ["菜单", 2], ["ui", 1], ["悬浮球", 3], ["悬浮窗", 2], ["tui", 3]],
  },
  {
    id: "session",
    label: "会话交互",
    priority: 8,
    terms: [["session", 2], ["chat", 1], ["prompt", 1], ["conversation", 2], ["会话", 3], ["对话", 3], ["提示词", 3], ["消息", 2], ["破甲", 4], ["jailbreak", 3], ["越狱", 2], ["prefill", 2], ["拒答", 2], ["emoji", 2], ["表情", 2], ["表情包", 3], ["sticker", 2]],
  },
  {
    id: "agent",
    label: "智能体技能",
    priority: 9,
    terms: [["agent", 1], ["skill", 2], ["mcp", 2], ["workflow", 2], ["automation", 2], ["智能体", 3], ["技能", 3], ["自动化", 2], ["工作流", 3], ["编排", 2], ["多智能体", 3], ["子代理", 3], ["superagent", 3]],
  },
  {
    id: "tools",
    label: "工具命令",
    priority: 10,
    terms: [["cli", 2], ["tool", 1], ["command", 1], ["ssh", 2], ["setup", 1], ["generator", 2], ["retry", 3], ["restart", 2], ["explorer", 2], ["工具", 3], ["命令", 2], ["一键", 2], ["安装", 2], ["脚本", 2], ["批量", 2], ["命令行", 3], ["重试", 3], ["重启", 3], ["vscode", 2], ["search", 2], ["搜索", 2], ["检索", 2], ["ops", 1], ["devops", 2], ["doctor", 3], ["healthcheck", 3], ["运维", 3], ["健康检查", 3], ["巡检", 3], ["自愈", 3], ["诊断", 2], ["修复", 2], ["清理", 2], ["限流", 2]],
  },
  {
    id: "dev",
    label: "开发调试",
    priority: 11,
    terms: [["debug", 2], ["review", 2], ["lint", 2], ["verify", 2], ["调试", 3], ["测试", 2], ["审查", 3], ["日志", 2], ["验证", 2]],
  },
  {
    id: "web",
    label: "浏览器与前端",
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
    terms: [["bridge", 3], ["adapter", 3], ["integration", 3], ["connector", 3], ["connect", 2], ["对接", 3], ["桥接", 3], ["适配", 3], ["互通", 3], ["中转", 2], ["网关", 2], ["飞书", 3], ["lark", 3], ["钉钉", 3], ["企业微信", 3], ["telegram", 3], ["discord", 3], ["slack", 3], ["onebot", 2], ["qqbot", 3], ["wechat", 3], ["weixin", 3], ["qq", 2], ["机器人", 2], ["消息通道", 3], ["微信", 2]],
  },
  {
    id: "usage",
    label: "用量计费",
    priority: 16,
    // 只保留「用量/额度/余额/计费」语义；监控归 ops，省 Token/加速归 efficiency
    terms: [["usage", 3], ["balance", 3], ["quota", 3], ["billing", 3], ["cost", 2], ["credit", 2], ["token", 1], ["gauge", 2], ["wallet", 2], ["用量", 3], ["额度", 3], ["余额", 3], ["计费", 3], ["消耗", 2], ["统计", 1], ["令牌", 2], ["钱包", 2]],
  },
  {
    id: "doc",
    label: "文档处理",
    priority: 17,
    terms: [["reader", 3], ["markdown", 3], ["pdf", 3], ["translate", 3], ["translation", 3], ["wiki", 2], ["阅读", 3], ["翻译", 3], ["笔记", 3], ["字幕", 3], ["摘要", 2], ["文档", 1], ["locale", 2], ["本地化", 2], ["语言包", 2], ["i18n", 2], ["lang", 2], ["office", 2], ["word", 2], ["excel", 2], ["ppt", 3], ["pptx", 3], ["slides", 2], ["wps", 3], ["onlyoffice", 3], ["docx", 3], ["公文", 3], ["幻灯片", 2], ["办公", 2]],
  },
  {
    id: "file",
    label: "文件管理",
    priority: 18,
    terms: [["folder", 3], ["drag", 2], ["drop", 1], ["file", 1], ["explorer", 2], ["picker", 2], ["文件", 1], ["目录", 1], ["拖拽", 3], ["网盘", 3], ["附件", 1], ["备份", 2]],
  },
  {
    id: "pet",
    label: "桌宠陪伴",
    priority: 19,
    // 「鲸鱼娘/小鲸鱼/看板娘」是 DSH 桌宠的通用说法，但权重给得克制：只有确实是「陪着你的角色」时才压得过别的扇区分数。
// 这些词说的仍是角色长相，所以自述是皮肤/主题/壁纸的仓库先被排除，只有同时自述宠物/陪伴玩法（或作者自打 pet 标签）才救回。
    exclude: { name: PET_SKIN_SELF, desc: PET_SKIN_SELF },
    override: { name: PET_SELF, desc: PET_SELF, topics: PET_SELF },
    terms: [
      ["pet", 3], ["pokemon", 3], ["live2d", 3], ["game", 2], ["桌宠", 3], ["宠物", 3], ["养成", 3], ["游戏", 2], ["虚拟形象", 3],
      // 「娘」在这批语料里就是"角色/看板娘"的标记（鲸鱼娘/看板娘/女仆娘），不是"姑娘"那种泛用
      ["小鲸鱼", 6], ["鲸鱼娘", 5], ["娘", 3], ["看板娘", 3], ["mascot", 3], ["吉祥物", 3], ["陪伴", 2],
      ["鲸鲸", 3], ["心情", 2], ["情绪", 2], ["搭话", 3], ["人设", 2], ["persona", 2], ["tavern", 3], ["酒馆", 2], ["角色卡", 3], ["soul", 2],
    ],
  },
  {
    id: "spec",
    label: "协议基座",
    priority: 20,
    // gate 回答「这个生态的规则与地基由谁定」：① 协议/规范/标准（dsh-std、插件互操作元协议、接口契约…）② 基座/框架（侧边栏底座、皮肤框架、工作台基座…）。
// 「标准/协议/公约」「framework/infrastructure」都是泛词（最大公约数、HTTP 协议、各种 AI 基础设施），所以 gate 要求【生态语境】或【基座自述】，strong 让「底座/基座/皮肤框架」直接胜出。
    gate: {
      name: /((^|[-_])(std|spec|specs|convention|conventions|covenant|charter)([-_]|$))|((插件|生态)(规范|标准|公约|契约|协议))|(meta[-_]protocol)|(基座|底座)/,
      // 两路取"或"：协议/规范自述，或"给插件生态当基座"的自述（框架/基座须紧邻生态级词，见 BASE_STRONG_SRC）
      desc: new RegExp(SPEC_SELF_SRC + "|" + BASE_STRONG_SRC, "i"),
    },
    // 自述是"生态基座"的，直接胜出（否则会被 panel/skin 的分数分走）
    strong: { name: /(基座|底座)/, desc: BASE_STRONG_DESC },
    terms: [
      ["公约", 2], ["元协议", 3], ["互操作", 3], ["契约", 2], ["约定", 1], ["规范", 2], ["协议", 1], ["标准", 1],
      ["convention", 2], ["specification", 2], ["interoperability", 3], ["interoperable", 3], ["schema", 1],
      ["protocol", 1], ["standard", 1], ["rfc", 1], ["manifest", 1], ["接口定义", 3], ["插件规范", 3], ["插件标准", 3],
      ["基座", 4], ["底座", 4], ["脚手架", 3], ["基础设施", 3], ["框架", 3], ["中间件", 2], ["内核", 2],
      ["foundation", 3], ["framework", 2], ["scaffold", 3], ["infrastructure", 2],
    ],
  },
  {
    id: "media",
    label: "媒体内容",
    priority: 21,
    gate: {
      name: /(^|[-_ ])(image|video|audio|music|player|render|screenshot|draw|cad|media|comfyui)([-_ ]|$)|图像|图片|视频|音频|音乐|播放|绘图|截图|渲染|媒体|动画|生图|出图|文生图|图生图|comfyui/,
    },
    terms: [
      ["image", 3], ["video", 3], ["audio", 3], ["music", 2], ["player", 2], ["render", 2],
      ["screenshot", 2], ["draw", 2], ["drawing", 2], ["cad", 2], ["media", 3], ["animation", 2],
      ["图像", 3], ["图片", 2], ["视频", 3], ["音频", 3], ["音乐", 2], ["播放", 2], ["播放器", 2],
      ["绘图", 2], ["截图", 2], ["渲染", 2], ["剪辑", 2], ["媒体", 3], ["动画", 2], ["白板", 2],
      ["comfyui", 3], ["生图", 3], ["出图", 2], ["文生图", 3], ["图生图", 3], ["image gen", 2],
    ],
  },
  {
    id: "data",
    label: "数据与行情",
    priority: 22,
    gate: {
      name: /(^|[-_ ])(data|table|csv|sql|database|analytics|chart|finance|stock|quant)([-_ ]|$)|数据|表格|数据库|分析|图表|行情|股票|量化/,
      desc: /(行情|股票|金融|基金|指数|大盘|K线|财务|报表|数据大屏|金融数据)/,
    },
    // token/用量类图表属于「用量计费」，不是数据工具（修 dsh-token-chart 被 data 抢走）
    exclude: { name: /(token|usage|balance|quota|wallet|余额|额度|用量|计费|钱包)/ },
    terms: [
      ["data", 2], ["table", 2], ["csv", 2], ["sql", 3], ["database", 2], ["analytics", 2],
      ["chart", 2], ["finance", 2], ["stock", 2], ["quant", 2], ["数据", 2], ["表格", 3],
      ["数据库", 2], ["分析", 2], ["图表", 2], ["行情", 2], ["股票", 2], ["量化", 2], ["金融", 2], ["基金", 2], ["指数", 2], ["大盘", 2], ["财务", 2],
    ],
  },
  {
    id: "efficiency",
    label: "效率优化",
    priority: 23,
    // 以「降低 token / 上下文 / 耗时」为目的的插件：省 token、上下文压缩、RTK、工具结果裁剪、低耗 preset
    gate: {
      name: /(token[-_ ]?(sav|opt|effic|diet|slim)|save[-_]?token|省token|效率|加速|performance|terse|caveman|compaction|compact|rtk|efficient|optimiz|frugal|lean)/,
      desc: /(节省|节约|降低|减少)[^。\n]{0,30}(token|消耗|成本|耗时|上下文|工具结果)|token[^。\n]{0,20}(减少|降低|节省|优化)|token[- ]?(efficien|sav|diet|opt)|cut[s]?\s+token|token\s+cost|reduce\s+token|fewer\s+token|save\s+token|execution\s+time|context[- ]?compression|compaction|prune|rtk|terse|caveman|efficient|frugal|lean\s+mode|tool[- ]output\s+budget|prompt\s*cache/i,
    },
    // 记账类插件不进效率扇区：余额/额度/账单/计费/钱包
    exclude: { name: /(^|[-_])(balance|billing|ledger|wallet|quota|cost|meter)([-_]|$)|余额|额度|计费|账单|钱包/ },
    terms: [
      ["节省", 3], ["节约", 3], ["降低消耗", 3], ["减少消耗", 3], ["省token", 3], ["消耗", 3], ["成本", 1],
      ["token", 2], ["token saver", 4], ["token-saver", 4], ["token optimizer", 4], ["token-optimizer", 4],
      ["token optimization", 4], ["token-optimization", 4], ["token efficiency", 4], ["token-efficiency", 4],
      ["save-token", 4], ["token diet", 4], ["token-diet", 4], ["caveman", 3], ["terse", 3], ["compaction", 3], ["compact", 2],
      ["rtk", 3], ["prune", 3], ["tool output", 3], ["工具结果", 3], ["上下文压缩", 4], ["压缩", 2],
      ["低耗", 3], ["效率", 2], ["加速", 2], ["execution time", 3], ["reduce token", 4], ["fewer token", 4],
      ["efficient", 2], ["frugal", 3], ["low-level operations", 3], ["底层操作", 3], ["低层操作", 3], ["提效", 3], ["耗时", 2],
    ],
  },
];

/** 细枝分类：每个大扇区内部再分一层，只在选中某个扇区时用来铺满整个圆；命中规则与主分类同一套（词边界 + 权重）。 */
export const SUBCATEGORY_RULES = {
  spec: [
    { id: "spec-interop", label: "互操作协议", terms: [["interop", 3], ["interoperability", 3], ["interoperable", 3], ["互操作", 3], ["元协议", 3], ["meta-protocol", 3], ["protocol", 2], ["协议", 2]] },
    { id: "spec-standard", label: "生态标准", terms: [["standard", 3], ["specification", 3], ["spec", 2], ["标准", 3], ["规范", 3], ["共识", 3], ["convention", 2]] },
    { id: "spec-contract", label: "接口契约", terms: [["contract", 3], ["schema", 3], ["manifest", 3], ["契约", 3], ["约定", 2], ["接口", 2]] },
  ],
  skin: [
    { id: "skin-theme", label: "主题皮肤", terms: [["skin", 3], ["theme", 3], ["配色", 3], ["主题", 3], ["皮肤", 3]] },
    { id: "skin-wallpaper", label: "壁纸背景", terms: [["wallpaper", 3], ["background", 2], ["壁纸", 3], ["背景", 2]] },
    { id: "skin-icon", label: "图标字体", terms: [["icon", 3], ["font", 3], ["图标", 3], ["字体", 3]] },
    { id: "skin-splash", label: "开屏动画", terms: [["开屏", 3], ["开机动画", 3], ["启动动画", 3], ["启动画面", 2], ["splash", 3], ["boot animation", 3], ["片头", 2]] },
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
    { id: "desktop-client", label: "客户端本体", terms: [["client", 3], ["desktop", 3], ["gui", 2], ["mac", 2], ["客户端", 3], ["桌面", 3]] },
    { id: "desktop-launcher", label: "启动器", terms: [["launcher", 3], ["启动器", 3], ["快捷方式", 2]] },
    { id: "desktop-installer", label: "安装分发", terms: [["installer", 3], ["distribution", 3], ["release", 2], ["安装包", 3], ["分发", 3], ["发布", 2]] },
    { id: "desktop-mobile", label: "跨端客户端", terms: [["android", 3], ["ios", 3], ["flutter", 3], ["mobile", 3], ["安卓", 3], ["手机", 3], ["跨端", 3]] },
  ],
  memory: [
    { id: "memory-kb", label: "知识库", terms: [["knowledge", 3], ["wiki", 2], ["知识库", 3], ["知识", 2]] },
    { id: "memory-long", label: "长期记忆", terms: [["长期", 2], ["上下文", 2]] },
    { id: "memory-rag", label: "检索增强", terms: [["rag", 3], ["embedding", 3], ["retrieval", 3], ["检索", 3], ["向量", 3], ["召回", 2]] },
    { id: "memory-inject", label: "记忆注入", terms: [["注入", 3], ["规则", 3], ["召回", 2], ["检索", 2]] },
  ],
  model: [
    { id: "model-provider", label: "模型供应商", terms: [["provider", 3], ["openai", 3], ["claude", 3], ["gemini", 3], ["ollama", 3], ["供应商", 3]] },
    { id: "model-gateway", label: "网关代理", terms: [["proxy", 3], ["gateway", 3], ["endpoint", 3], ["网关", 3], ["代理", 3], ["路由", 2], ["中转", 2]] },
    { id: "model-multimodal", label: "多模态", terms: [["vision", 3], ["multimodal", 3], ["多模态", 3], ["视觉", 3], ["图像", 2], ["图片", 2]] },
    { id: "model-reasoning", label: "推理思考", terms: [["reasoning", 3], ["thinking", 3], ["thought", 2], ["推理", 3], ["思考", 3], ["思维链", 3], ["深思", 2]] },
    { id: "model-preset", label: "参数预设", terms: [["preset", 3], ["temperature", 3], ["parameter", 2], ["参数", 3], ["预设", 3], ["调参", 3], ["配置", 1]] },
    { id: "model-council", label: "多模型协同", terms: [["council", 3], ["ensemble", 3], ["multi-model", 3], ["voting", 3], ["会诊", 3], ["多模型", 3], ["投票", 3]] },
    { id: "model-select", label: "模型选择切换", terms: [["选择", 3], ["切换", 3], ["列表", 2], ["对比", 2], ["设置", 2]] },
    { id: "model-router", label: "模型路由", terms: [["router", 3], ["routing", 3], ["模型路由", 3], ["路由", 2], ["负载均衡", 3], ["fallback", 2], ["降级", 2]] },
  ],
  panel: [
    { id: "panel-side", label: "侧边面板", terms: [["sidebar", 3], ["侧边", 3]] },
    { id: "panel-editor", label: "编辑器", terms: [["editor", 3], ["编辑器", 3], ["画布", 2], ["canvas", 2]] },
    { id: "panel-widget", label: "悬浮组件", terms: [["widget", 3], ["floating", 3], ["悬浮", 3], ["挂件", 3], ["小组件", 3], ["悬浮球", 3], ["悬浮窗", 2]] },
    { id: "panel-settings", label: "设置仪表盘", terms: [["settings", 3], ["dashboard", 3], ["设置", 3], ["仪表盘", 3], ["配置页", 2]] },
    { id: "panel-mobile", label: "移动端界面", terms: [["mobile", 3], ["android", 3], ["ios", 3], ["apk", 3], ["手机", 3], ["移动端", 3], ["窄屏", 3]] },
    { id: "panel-tui", label: "终端界面", terms: [["tui", 3], ["terminal", 3], ["终端", 3], ["ncurses", 3]] },
    { id: "panel-workbench", label: "创作工作台", terms: [["workbench", 3], ["studio", 3], ["creator", 2], ["创作", 3], ["工作台", 3], ["工坊", 3]] },
  ],
  session: [
    { id: "session-manage", label: "会话管理", terms: [["history", 2], ["历史", 2]] },
    { id: "session-prompt", label: "提示词", terms: [["prompt", 3], ["提示词", 3], ["提示语", 3]] },
    { id: "session-chat", label: "消息对话", terms: [["chat", 3], ["message", 2], ["conversation", 3], ["对话", 3], ["消息", 2], ["聊天", 2], ["emoji", 2], ["表情", 2], ["表情包", 3], ["sticker", 2]] },
    { id: "session-maintain", label: "会话维护", terms: [["删除", 3], ["清理", 3], ["恢复", 2], ["同步", 3], ["备份", 3], ["迁移", 3], ["导入", 2], ["导出", 2], ["归档", 2]] },
    { id: "session-context", label: "上下文压缩", terms: [["context", 3], ["compact", 3], ["压缩", 3], ["上下文", 3], ["摘要", 3]] },
    { id: "session-jailbreak", label: "破甲越狱", terms: [["破甲", 3], ["jailbreak", 3], ["越狱", 2], ["prefill", 2], ["拒答", 2]] },
  ],
  agent: [
    { id: "agent-skill", label: "技能包", terms: [["skill", 3], ["技能", 3]] },
    { id: "agent-mcp", label: "MCP 服务", terms: [["mcp", 3], ["model context protocol", 3], ["mcp-server", 3]] },
    { id: "agent-workflow", label: "工作流编排", terms: [["workflow", 3], ["automation", 3], ["工作流", 3], ["自动化", 3], ["编排", 3]] },
    { id: "agent-sub", label: "子代理", terms: [["subagent", 3], ["agents", 2], ["多智能体", 3], ["子代理", 3]] },
    { id: "agent-coding", label: "编码代理", terms: [["coding", 3], ["engineer", 2], ["programming", 3], ["developer", 2], ["编码", 3], ["编程", 3], ["写代码", 3], ["软件工程", 3]] },
    { id: "agent-teams", label: "多代理协作", terms: [["team", 3], ["collaboration", 3], ["collaborative", 3], ["协作", 3], ["团队", 3], ["分工", 2], ["多代理", 3]] },
    { id: "agent-runtime", label: "运行时预设", terms: [["runtime", 3], ["preset", 3], ["scheduler", 3], ["loop", 2], ["运行时", 3], ["预设", 3], ["调度", 3]] },
    { id: "agent-ptc", label: "PTC 预设", terms: [["ptc", 3], ["code mode", 3], ["programmatic tool", 3], ["批量工具", 2]] },
  ],
  tools: [
    { id: "tools-cli", label: "命令行", terms: [["cli", 3], ["command", 3], ["shell", 2], ["命令行", 3], ["终端", 3], ["命令", 3], ["指令", 3], ["slash", 2], ["斜杠", 3]] },
    { id: "tools-install", label: "安装部署", terms: [["install", 2], ["setup", 2], ["deploy", 3], ["安装", 3], ["部署", 3]] },
    { id: "tools-script", label: "脚本批量", terms: [["script", 3], ["batch", 2], ["脚本", 3], ["批量", 3]] },
    { id: "tools-gen", label: "生成转换", terms: [["generator", 3], ["converter", 3], ["export", 2], ["生成", 2], ["转换", 2], ["导出", 2]] },
    { id: "tools-search", label: "检索搜索", terms: [["search", 3], ["query", 3], ["检索", 3], ["搜索", 3], ["查询", 3]] },
    { id: "tools-git", label: "版本控制", terms: [["git", 3], ["github", 2], ["commit", 3], ["branch", 2], ["仓库", 2], ["版本", 2], ["代码托管", 3]] },
    { id: "tools-media", label: "媒体处理", terms: [["image", 2], ["video", 3], ["audio", 3], ["media", 3], ["图片", 3], ["图像", 3], ["视频", 3], ["音频", 3], ["截图", 3]] },
    { id: "tools-process", label: "进程运行时", terms: [["process", 2], ["runtime", 3], ["进程", 3], ["定时", 2], ["运行时", 3]] },
    { id: "tools-ops", label: "运维与自检", terms: [["ops", 3], ["devops", 3], ["doctor", 3], ["healthcheck", 3], ["watchdog", 3], ["daemon", 3], ["运维", 3], ["健康检查", 3], ["巡检", 3], ["自愈", 3], ["守护", 3], ["备份", 2], ["恢复", 2], ["修复", 2], ["重启", 3], ["清理", 2], ["限流", 2], ["日志", 2], ["监控", 2]] },
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
    { id: "secure-audit", label: "审计扫描", terms: [["audit", 3], ["scan", 3], ["scanner", 3], ["compliance", 3], ["审计", 3], ["扫描", 3], ["合规", 3], ["检测", 2]] },
    { id: "secure-guard", label: "防护拦截", terms: [["guard", 3], ["defend", 3], ["defense", 3], ["antivirus", 3], ["injection", 3], ["防护", 3], ["防御", 3], ["拦截", 3], ["注入", 3], ["病毒", 3]] },
  ],
  bridge: [
    { id: "bridge-bridge", label: "桥接", terms: [["bridge", 3], ["桥接", 3]] },
    { id: "bridge-adapter", label: "适配器", terms: [["adapter", 3], ["adaptor", 3], ["适配", 3]] },
    { id: "bridge-integration", label: "第三方对接", terms: [["integration", 3], ["connect", 2], ["对接", 3], ["互通", 3], ["第三方", 2]] },
    { id: "bridge-im", label: "IM 渠道", terms: [["飞书", 3], ["lark", 3], ["钉钉", 3], ["企业微信", 3], ["telegram", 3], ["discord", 3], ["slack", 3], ["onebot", 3], ["微信", 2]] },
  ],
  usage: [
    { id: "usage-balance", label: "余额", terms: [["balance", 3], ["余额", 3], ["充值", 3]] },
    { id: "usage-stat", label: "用量统计", terms: [["统计", 3], ["用量", 3], ["消耗", 3], ["监控", 3], ["图表", 2], ["token", 2]] },
    { id: "usage-billing", label: "计费成本", terms: [["billing", 3], ["cost", 3], ["price", 2], ["计费", 3], ["成本", 3], ["价格", 2], ["账单", 3], ["峰谷", 2]] },
    { id: "usage-quota", label: "配额订阅", terms: [["quota", 3], ["配额", 3], ["订阅", 3], ["subscription", 3], ["套餐", 3], ["plan", 2], ["额度", 3], ["限流", 2]] },
  ],
  doc: [
    { id: "doc-read", label: "阅读浏览", terms: [["reader", 3], ["reading", 3], ["阅读", 3], ["浏览", 2]] },
    { id: "doc-translate", label: "翻译", terms: [["translate", 3], ["translation", 3], ["翻译", 3], ["字幕", 2]] },
    { id: "doc-render", label: "渲染导出", terms: [["markdown", 3], ["pdf", 3], ["render", 2], ["渲染", 3], ["导出", 2], ["预览", 2]] },
    { id: "doc-note", label: "笔记摘要", terms: [["笔记", 3], ["摘要", 3], ["总结", 2], ["收藏", 2]] },
    { id: "doc-locale", label: "本地化", terms: [["locale", 3], ["本地化", 3], ["语言包", 3], ["localization", 3], ["i18n", 3], ["lang", 2]] },
    { id: "doc-office", label: "办公文档", terms: [["office", 3], ["word", 2], ["excel", 2], ["ppt", 3], ["pptx", 3], ["slides", 2], ["wps", 3], ["onlyoffice", 3], ["docx", 3], ["公文", 3], ["幻灯片", 2]] },
  ],
  file: [
    { id: "file-path", label: "文件目录", terms: [["folder", 3], ["path", 2], ["目录", 3], ["路径", 3]] },
    { id: "file-drag", label: "拖拽投放", terms: [["drag", 3], ["drop", 3], ["拖拽", 3], ["拖入", 3], ["投放", 2]] },
    { id: "file-sync", label: "网盘备份", terms: [["sync", 2], ["backup", 3], ["网盘", 3], ["备份", 3], ["同步", 2], ["云盘", 3]] },
    { id: "file-preview", label: "预览浏览", terms: [["预览", 3], ["上传", 2], ["下载", 2], ["打开", 2], ["浏览", 2], ["在线", 1]] },
  ],
  pet: [
    { id: "pet-pet", label: "桌宠养成", terms: [["pet", 3], ["桌宠", 3], ["宠物", 3], ["养成", 3]] },
    { id: "pet-avatar", label: "虚拟形象", terms: [["live2d", 3], ["avatar", 2], ["虚拟形象", 3], ["形象", 2]] },
    { id: "pet-game", label: "游戏娱乐", terms: [["game", 3], ["pokemon", 3], ["游戏", 3], ["娱乐", 2]] },
    { id: "pet-persona", label: "人设陪伴", terms: [["人设", 3], ["persona", 3], ["tavern", 3], ["酒馆", 3], ["角色卡", 3], ["soul", 2], ["陪伴", 2]] },
  ],
  media: [
    { id: "media-image", label: "图像截图", terms: [["image", 3], ["screenshot", 3], ["draw", 2], ["drawing", 2], ["cad", 3], ["图像", 3], ["图片", 3], ["截图", 3], ["绘图", 3], ["白板", 3]] },
    { id: "media-video", label: "视频剪辑", terms: [["video", 3], ["animation", 2], ["视频", 3], ["剪辑", 3], ["动画", 2]] },
    { id: "media-audio", label: "音频音乐", terms: [["audio", 3], ["music", 3], ["player", 2], ["音频", 3], ["音乐", 3], ["播放器", 3]] },
    { id: "media-render", label: "渲染导出", terms: [["render", 3], ["export", 2], ["渲染", 3], ["导出", 2]] },
    { id: "media-gen", label: "图像生成", terms: [["comfyui", 3], ["生图", 3], ["出图", 2], ["文生图", 3], ["图生图", 3], ["image gen", 2]] },
  ],
  data: [
    { id: "data-table", label: "表格数据", terms: [["table", 3], ["csv", 3], ["excel", 3], ["表格", 3]] },
    { id: "data-db", label: "数据库", terms: [["sql", 3], ["database", 3], ["数据库", 3]] },
    { id: "data-analytics", label: "分析图表", terms: [["analytics", 3], ["chart", 3], ["分析", 3], ["图表", 3]] },
    { id: "data-finance", label: "行情金融", terms: [["finance", 3], ["stock", 3], ["quant", 2], ["行情", 3], ["股票", 3], ["量化", 3]] },
  ],
  efficiency: [
    { id: "eff-token", label: "Token 节省", terms: [["节省", 3], ["节约", 3], ["caveman", 3], ["terse", 3], ["token saver", 3], ["低耗", 3], ["token", 1], ["消耗", 3], ["fewer token", 3], ["token-optimization", 3]] },
    { id: "eff-context", label: "上下文压缩", terms: [["context", 3], ["compaction", 3], ["compress", 3], ["压缩", 3], ["prune", 3], ["裁剪", 3], ["上下文", 2]] },
    { id: "eff-tool", label: "工具结果优化", terms: [["rtk", 3], ["tool output", 3], ["工具结果", 3], ["budget", 2], ["去重", 2], ["降噪", 2], ["low-level operations", 3], ["底层操作", 3], ["ops", 2]] },
    { id: "eff-preset", label: "低耗预设", terms: [["preset", 3], ["预设", 3], ["mode", 2], ["fast", 2], ["低耗", 3], ["efficient", 2]] },
  ],
};

/**
 * 生产参数：少于 minCount 的并入「其他」，最多保留 maxSectors 个扇区。
 * keepIds 是不因样本少被并掉的分类：「公约协议」天然是小样本（定规矩的仓库就那么几个），
 * 但它回答的是「这个生态的规则由谁定」，不该沉进「其他」。
 */
export const DEFAULT_OPTIONS = { minCount: 10, maxSectors: 26, keepIds: ["spec"] };

export const RULE_BY_PRIORITY = [...CATEGORY_RULES].sort((a, b) => a.priority - b.priority);
const LABEL = new Map(CATEGORY_RULES.map((r) => [r.id, r.label]));

/**
 * 最低置信分：低于它判为「其他」/「未细分」。
 * 1.5 = 拒绝「只在描述里命中一个权重 1 的泛词」（得分恰好 1）的证据；
 * 名字命中（×2）、topic 命中（×1.5）、描述里权重 ≥2 的词仍然保留。
 */
export const MIN_SCORE = 1.5;
export const MIN_SUB_SCORE = 1.5;

/** 名称最后一段：dsh-plugin-skin 里的 skin 通常是这个仓库的关键词 */
export function lastSegment(name) {
  const parts = String(name ?? "").split(/[-_\s]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** 统一算分：名称 ×2、名称末段额外 +1（末段命中即 ×3）、描述 ×1、topic ×1.5 —— topic 是作者自己标的，比描述里的客套话可信。 */
export function scoreOf(counter, sig, weight) {
  const inName = counter(sig.name);
  const inLast = counter(sig.last);
  const inDesc = counter(sig.desc);
  const inTopics = counter(sig.topics);
  const inReadme = counter(sig.readme ?? "");
  if (inName + inDesc + inTopics === 0) {
    // README 半权：只有摘要证据时看它给不给得出底分（乘 0.5 之后仍然要过 MIN_SCORE 才能离开「其他」）
    if (!inReadme) return 0;
    return inReadme * 0.5 * weight;
  }
  return (inName * 2 + inLast + inDesc + inTopics * 1.5 + inReadme * 0.5) * weight;
}

export function textSignals(node) {
  const topics = (node.topics ?? []).filter((t) => !SIGNAL_TAGS.has(t)).join(" ");
  const name = (node.name ?? node.id ?? "").toLowerCase();
  // 2026-11-07 P2：README 摘要也是证据（半权，截 800 字；build/reclassify 借来即还）。
  return {
    name,
    last: lastSegment(name),
    desc: (node.description ?? "").toLowerCase(),
    readme: String(node.readmeDigest ?? "").toLowerCase().slice(0, 800),
    topics: topics.toLowerCase(),
  };
}

/** 门槛：声明了 gate 的分类，必须至少有一路命中才有资格 */
export function passesGate(rule, sig) {
  const gate = rule.gate;
  if (!gate) return true;
  if (gate.name && gate.name.test(sig.name)) return true;
  if (gate.desc && gate.desc.test(sig.desc)) return true;
  if (gate.topics && gate.topics.test(sig.topics)) return true;
  return false;
}

/** 排除：命中即失去资格，除非 name/desc/topics 里有强自述把它救回来 */
export function isExcluded(rule, sig) {
  const exclude = rule.exclude;
  if (!exclude) return false;
  const hit = (exclude.name && exclude.name.test(sig.name)) || (exclude.desc && exclude.desc.test(sig.desc));
  if (!hit) return false;
  const override = rule.override;
  if (
    override &&
    ((override.name && override.name.test(sig.name)) ||
      (override.desc && override.desc.test(sig.desc)) ||
      // topics 是作者自己打的标签，与 gate 同权：作者标了 pet/desktop-pet 就算自述
      (override.topics && override.topics.test(sig.topics)))
  ) {
    return false;
  }
  return true;
}

/**
 * 强命中：规则可声明 strong（name/desc/topics 三个正则），命中即【直接胜出】、不再比分数。
 * 只给语义无歧义的「自述」用（如「侧边栏底座」「皮肤框架」），否则会被正文里的 sidebar/皮肤 分流去界面面板或皮肤美化。
 */
export function strongHit(rule, sig) {
  const strong = rule.strong;
  if (!strong) return false;
  return Boolean(
    (strong.name && strong.name.test(sig.name)) ||
      (strong.desc && strong.desc.test(sig.desc)) ||
      (strong.topics && strong.topics.test(sig.topics)),
  );
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
      const s = scoreOf(makeCounter(term), sig, weight);
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
    if (strongHit(rule, sig)) {
      best = { id: rule.id, label: rule.label, score, hits: hits.slice(0, 3), strong: true };
      break;
    }
    if (!best || score > best.score) best = { id: rule.id, label: rule.label, score, hits: hits.slice(0, 4) };
  }
  // 最低置信分：只有一个很弱的描述命中（1 分）时不硬塞进扇区，留给「其他」
  if (best && best.score < MIN_SCORE) {
    blocked = blocked ?? { id: best.id, label: best.label, reason: "置信分不足" };
    best = null;
  }
  // 细枝提父级：父级完全没分，但某个细枝有足够强的名字证据时，用细枝的父扇区兜底。
  // 只在前三档候选唯一时生效，避免两个细枝同分时硬猜。
  if (!best) {
    const promoted = [];
    for (const [parent, rules] of Object.entries(SUBCATEGORY_RULES)) {
      const parentRule = CATEGORY_RULES.find((r) => r.id === parent);
      // 有 gate 的扇区（market/spec/desktop/media/data）必须由自身门槛决定，不能靠细枝词兜底：
      // 否则 dsh-spec-ponytail、dsh-title-index 这类只靠名字里的 spec/index 就被提升。
      if (!parentRule || parentRule.gate) continue;
      if (!passesGate(parentRule, sig) || isExcluded(parentRule, sig)) continue;
      for (const rule of rules) {
        let score = 0;
        let nameScore = 0;
        const hits = [];
        for (const [term, weight] of rule.terms) {
          const counter = makeCounter(term);
          const s = scoreOf(counter, sig, weight);
          if (s > 0) {
            score += s;
            hits.push(term);
            nameScore += counter(sig.name) + counter(sig.last);
          }
        }
        if (score > 0) promoted.push({ parent, parentLabel: LABEL.get(parent) ?? parent, score, nameScore, hits });
      }
    }
    promoted.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore);
    const top = promoted[0];
    const second = promoted[1];
    if (top && top.score >= 3 && top.nameScore > 0 && (!second || top.score > second.score)) {
      best = {
        id: top.parent,
        label: top.parentLabel,
        score: top.score,
        hits: top.hits.slice(0, 4),
        promoted: true,
      };
    }
  }
  if (!best) return { id: OTHER.id, label: OTHER.label, score: 0, hits: [], sub: null, blocked };

  const subs = SUBCATEGORY_RULES[best.id];
  let sub = null;
  if (subs) {
    for (const rule of subs) {
      let score = 0;
      const hits = [];
      let nameScore = 0;
      for (const [term, weight] of rule.terms) {
        const counter = makeCounter(term);
        const s = scoreOf(counter, sig, weight);
        if (s > 0) {
          score += s;
          hits.push(term);
          nameScore += counter(sig.name) + counter(sig.last);
        }
      }
      // 细枝更信名字里写了什么：名字有命中的细枝优先于只在描述里出现的
      if (score > 0 && (!sub || nameScore > sub.nameScore || (nameScore === sub.nameScore && score > sub.score))) {
        sub = { id: rule.id, label: rule.label, score, nameScore, hits: hits.slice(0, 3) };
      }
    }
  }
  if (sub && sub.score < MIN_SUB_SCORE) sub = null; // 细枝同理：太弱的归入「未细分」
  // 子分类覆盖：父级已确认但细枝证据不足时，归入「综合」，避免大量节点显示未细分。
  if (!sub && best.id !== OTHER.id) sub = { id: best.id + "-general", label: "综合", score: 0, nameScore: 0, hits: [] };
  return { ...best, sub };
}

/** 全量归类 + 长尾合并：少于 minCount 的类别并入「其他」，超过 maxSectors 时把最小的并入「其他」。 */
export function applyCategories(nodes, options = {}) {
  const minCount = options.minCount ?? DEFAULT_OPTIONS.minCount;
  const maxSectors = options.maxSectors ?? DEFAULT_OPTIONS.maxSectors; // 20 个扇区：上限要够，否则新的小类会被并进「其他」
  const keepIds = new Set(options.keepIds ?? DEFAULT_OPTIONS.keepIds ?? []);
  // 策展认定的生态基座（tools/ecosystem.json 的 bases）直接归入协议基座：它们是「别人长在上面」的那批
// （侧边栏底座 / TUI 基座 / 互操作元协议…），正文未必写着「基座」二字，靠人工策展 + README 证据认定，比硬编码仓库名可审计。
  const baseIds = new Set(options.baseIds ?? []);
  const specRule = CATEGORY_RULES.find((r) => r.id === "spec");
  const raw = new Map();
  for (const node of nodes) {
    if (baseIds.has(node.id)) {
      raw.set(node.id, { id: "spec", label: specRule?.label ?? "协议基座", score: 0, hits: ["策展基座"], strong: true, curatedBase: true });
      continue;
    }
    raw.set(node.id, classifyNode(node));
  }

  const counts = new Map();
  for (const result of raw.values()) counts.set(result.id, (counts.get(result.id) ?? 0) + 1);

  const labelOf = new Map(CATEGORY_RULES.map((r) => [r.id, r.label]));
  let kept = [...counts.entries()]
    .filter(([id, n]) => id !== OTHER.id && (n >= minCount || (keepIds.has(id) && n > 0)))
    .map(([id]) => id);
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
    if (result.strong) node.categoryStrong = true;
    else delete node.categoryStrong;
    if (result.curatedBase) node.categoryCurated = true;
    else delete node.categoryCurated;
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
