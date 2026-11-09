"""功能分类器：与前端 tools/categories.mjs 逐条对齐的 Python 实现（改一边要改两边）。

不用模型分类：500+ 仓库每次跑模型烧 token 且结果不稳定；规则表 + 打分可审计、可复跑，
verify_parity.py 拿 JS 产物做一致性校验。英文词按词边界匹配并可带 s/es（修掉 ui←build、
cli←client、hub←github 等裸子串误命中），中文词按子串；分类可声明 gate/exclude/override。
"""

from __future__ import annotations

import re

OTHER = {"id": "other", "label": "其他"}

# 非插件语境排除（与 tools/categories.mjs 的 NOT_PLUGIN_PATTERNS 逐条一致）：
# 挂 dsh 标签但 DSH 是别的意思（如 DeepHash-pytorch 的 DSH = Deep Supervised Hashing）。
NOT_PLUGIN_PATTERNS = [
    (re.compile(r"deep\s*hash|deephash|deep hashing|深度哈希|哈希算法|image retrieval|检索演示", re.I),
     "深度哈希类：这里的 DSH 是 Deep Supervised Hashing，不是 DeepSeek Harness"),
    (re.compile(r"digital\s*signal\s*processing|离散时间信号", re.I), "数字信号处理类：DSH 是别的缩写"),
    # LIS3DSH：意法半导体 MEMS 加速度计型号，仓库名里的 dsh 纯属撞车（名字收录把 31 条学术仓库带了进来）。
    (re.compile(r"lis\s*3\s*dsh", re.I),
     "MEMS 传感器：LIS3DSH 是意法半导体加速度计型号，不是 DeepSeek Harness"),
]


def non_plugin_reason(node: dict) -> str | None:
    text = " ".join([
        str(node.get("name") or ""),
        str(node.get("description") or ""),
        " ".join(str(t) for t in (node.get("topics") or [])),
    ])
    for pattern, why in NOT_PLUGIN_PATTERNS:
        if pattern.search(text):
            return why
    topics = [str(t).lower() for t in (node.get("topics") or [])]
    if "deep-hashing" in topics:
        return "深度哈希类：topic 直接写着 deep-hashing"
    return None

_ASCII_WORD = re.compile(r"^[a-z0-9][a-z0-9 .+-]*$")


def make_counter(term: str):
    """英文 → 词边界 + 复数；中文 → 子串计数。与 JS 的 makeCounter 行为一致。"""
    if not _ASCII_WORD.match(term or ""):
        def count_cjk(text: str) -> int:
            if not text or not term:
                return 0
            return text.count(term)

        return count_cjk
    # re.ASCII 很关键：Python 默认 \b 是 Unicode 语义（中文字符算 word char），
    # 而 JS 的 \b 只看 ASCII。不加这个标志，"界面ui" 这种中英混排两边会分叉。
    pattern = re.compile(r"\b" + re.escape(term) + r"(?:s|es)?\b", re.ASCII)
    return lambda text: len(pattern.findall(text)) if text else 0


# 与 tools/categories.mjs 的 CATEGORY_RULES 一一对应（priority 即裁决顺序）
# 「基座」自述 / 「协议规范」自述的正则源（与 JS 端逐字对齐，便于两边同改）
_BASE_WORDS = "底座|基座|脚手架|基础设施|框架|foundation|framework|scaffold|infrastructure"
_ECO_WORDS = "插件|扩展|拓展|生态|三方|宿主|皮肤|面板|侧边栏|工作台|工具链|plugin|extension|ecosystem|host"
# 中间最多 4 个字符且不能跨标点，避免"插件：10 条内置思维框架"这种跨小句巧合算成基座自述
_GAP = r"[^，。；：、,.;:!?|()（）\n]{0,4}"
BASE_SELF_SRC = f"({_BASE_WORDS}){_GAP}({_ECO_WORDS})|({_ECO_WORDS}){_GAP}({_BASE_WORDS})"

# 「强基座自述」比普通自述更严：基座/框架必须紧邻生态级词（插件生态/生态/宿主/三方/拓展/皮肤/面板/侧边栏/工作台/工具链）。
# 单说「X框架插件」「能力底座插件」不算 —— 否则任何自称框架的插件都会被当成生态基座。
_ECO_STRONG_WORDS = (
    "插件生态|生态|宿主|三方|拓展|皮肤|面板|侧边栏|工作台|工具链|"
    "plugin ecosystem|ecosystem|host|sidebar|panel|skin|theme|workbench"
)
BASE_STRONG_SRC = f"({_BASE_WORDS}){_GAP}({_ECO_STRONG_WORDS})|({_ECO_STRONG_WORDS}){_GAP}({_BASE_WORDS})"
SPEC_SELF_SRC = (
    r"(插件|生态|社区)[^\n]{0,10}(规范|标准|公约|共识|契约|协议)|互操作|元协议|meta[- ]protocol|"
    r"plugin[- ](standard|spec|specification|convention|contract|schema|manifest)|"
    r"ecosystem[- ](standard|spec|specification|convention)|community[- ](standard|spec|consensus|convention)|"
    r"conventions every plugin|(standard|specification|protocol)\s+for\s+(dsh|deepseek|plugins?)"
)

# 桌宠扇区自述判据（与 tools/categories.mjs 的 PET_SKIN_SELF / PET_SELF 逐字对齐）：
# 皮肤/主题/壁纸说的是"长什么样"，宠物/陪伴说的是"陪着你的角色"——只有后者能救回；
# 自称"皮肤系列"的仓库不该被"鲸鱼娘/小鲸鱼"拉进桌宠扇区。
_PET_SKIN_SELF = re.compile(r"皮肤|主题|壁纸|外观|美化|配色|skin|theme|wallpaper|appearance", re.I)
_PET_SELF = re.compile(r"(\bpet\b|\bpets\b|桌宠|宠物|养成|pokemon|live2d|mascot|吉祥物|陪伴|看板娘|小鲸鱼)", re.I | re.ASCII)

CATEGORY_RULES = [
    {"id": "skin", "label": "皮肤美化", "priority": 1, "terms": [
        ("skin", 3), ("theme", 2), ("wallpaper", 3), ("background", 2), ("皮肤", 3), ("主题", 2), ("壁纸", 3), ("背景", 2),
        ("美化", 3), ("外观", 2), ("配色", 2), ("appearance", 2), ("style", 1),
        ("开屏", 3), ("开机动画", 3), ("启动动画", 2), ("启动画面", 2), ("splash", 3), ("boot animation", 3), ("boot-animation", 3), ("片头", 3)]},
    {"id": "notify", "label": "通知提醒", "priority": 2, "terms": [
        ("voice", 2), ("tts", 3), ("speech", 2), ("sound", 2), ("notification", 3),
        ("语音", 3), ("提醒", 3), ("通知", 2), ("mp3", 3), ("播报", 3), ("提示音", 3)]},
    {
        "id": "market", "label": "插件市场", "priority": 3,
        # 只有"自述是汇集插件的汇总"才算市场：名字末段/首段就是汇总词，或描述明确说收录、汇集。
        # 名字里只是"提到"市场不算（例如 dsh-market-button 是给市场加按钮的插件）。
        "gate": {
            "name": re.compile(
                # 名字必须本身就是「插件汇总」的招牌词；store/index/catalog/hub 这类泛词不再单独放行
                r"((^|[-_ ])(market|marketplace|registry|awesome)s?$)"
                r"|(^(awesome|market|marketplace|registry)[-_ ])"
                r"|((市场|商店|集市|商城|合集|汇总|导航|索引|大全|清单|目录|精选)$)"
            ),
            "desc": re.compile(
                # 描述必须自述"在汇总插件"：去掉裸 marketplace / 裸 directory of，改成插件语境的正向短语
                r"(收录|汇集|汇总|聚合|收集|整理|精选|导航|合集|大全|清单|目录|索引"
                r"|插件\s*(市场|商店|集市|商城)|插件(目录|合集|总目录|索引)"
                r"|awesome\s+list|curated|collection\s+of|a\s+list\s+of|list\s+of\s+(dsh\s+)?plugins"
                r"|index\s+of\s+(dsh\s+)?plugins|directory\s+of\s+[^。\n]{0,30}plugins"
                r"|registry\s+of\s+[^。\n]{0,30}plugins"
                r"|plugin\s+(hub|directory|list|store|market|marketplace|registry|index|catalog)"
                r"|plugin[- ]market|marketplace\s+(for|of|plugin)|(hub|dsh)\s+marketplace"
                r"|extension\s+(center|hub)|(browsable|searchable)[^。\n]{0,20}directory"
                r"|(browse|search|discover|find)[^。\n]{0,30}(插件|plugins?)"
                r"|(dsh|harness)\s*(插件)?\s*(市场|商店|集市|商城)|marketplace\s+(for|of))"
            ),
        },
        # 名字是「某个细分领域的市场」不算插件市场（股票行情、提示词市场、皮肤市场、模型目录…），交给各自扇区。
        "exclude": {"name": re.compile(r"(stock|finance|trading|trade|quant|crypto|currency|prompt|skin|theme|token|model|image|video|music|game|gating|guard|safety|scanner|audit|checker|health|upgrade|股票|行情|金融|交易|量化|提示词|皮肤|主题)")},
        "terms": [
            ("market", 3), ("marketplace", 3), ("registry", 3), ("store", 2), ("awesome", 2),
            ("directory", 2), ("catalog", 2), ("collection", 1), ("hub", 1), ("市场", 3),
            ("商店", 3), ("集市", 3), ("商城", 3), ("索引", 2), ("合集", 3), ("汇总", 3),
            ("收录", 2), ("导航", 2)],
    },
    {
        "id": "desktop", "label": "客户端应用", "priority": 4,
        # 只认「客户端本体」的自述：名字里 desktop/client 是主体，或描述明确说做出了 App/客户端；
        # 不认 topics 里的 app 标签，也不认「for windows/macos」这种平台限定（大量插件也这么写）。
        "gate": {
            "name": re.compile(r"(^|[-_])(desktop|client|launcher|workbench|pc|客户端|桌面版|启动器|工作台)([-_]|$)"),
            "desc": re.compile(
                r"(这是一个?(桌面|移动|手机|安卓|ios)?\s*客户端(?!\s*(插件|plugin))"
                r"|本仓库是(一个)?客户端(?!\s*(插件|plugin))|桌面客户端(?!\s*(插件|plugin))"
                r"|桌面应用(?!\s*(插件|plugin))|桌面启动器|桌面控制中心|桌面工作台"
                r"|mobile\s+(app|client)(?!\s*(plugin|插件))|android\s+(app|client)|ios\s+(app|client)"
                r"|apk\b|装进口袋|装进\s*(手机|android)|手机本机|本机运行"
                r"|run\s+(deepseek\s+harness|dsh)[^.]{0,40}on\s+(android|ios)"
                r"|(mac|windows|linux)\s*端[^。\n]{0,20}(gui|客户端|app|应用)"
                r"|native\s+(macos|windows|linux)\s+(app|client)"
                r"|desktop\s+(app|client|application)(?!\s*(plugin|插件))|desktop\s+launcher"
                r"|tray\s+(app|launcher)|menu\s*bar\s+app|桌面版[^。\n]{0,10}(deepseek|harness|dsh))",
                re.ASCII,  # 与 JS 的 \b 语义对齐（否则中英混排会分叉）
            ),
        },
        # 给客户端写的插件不算客户端：名字带插件/皮肤类标记，或 client-xxx / desktop-statusbar 这类插件命名，一律排除
        "exclude": {"name": re.compile(r"(plugin|extension|skill|theme|skin|preset|widget|panel|sidebar|toolbar|button|statusbar|notif(y|ier)|badge|tweak|pricing|restart|reload|layout|hotkey|shortcut|indicator|overlay|locale|language|quote|route|icon|connect|bridge|adapter|connector|gateway|integration|automation|control|remote|workspace|paseo|zcode|codex|qwen|workbuddy|chatgpt|(^|[-_])client[-_]|(^|[-_])(api|mcp|vnc|mc|opencode|vectr|collaboration|invoice|pet|whale|obsidian)([-_]|$)|插件|扩展|技能|皮肤|主题|面板|侧边栏)")},
        "override": {
            "desc": re.compile(
                r"(这是一个?(桌面)?客户端|本仓库是(一个)?客户端|桌面客户端(应用|程序)?[，,。：]"
                r"|desktop\s+(app|client)\s+(for|that)|is\s+a\s+desktop\s+(app|client)|是对应桌面客户端)"
            )
        },
        "terms": [
            ("desktop", 2), ("client", 2), ("tauri", 3), ("electron", 3), ("launcher", 3),
            ("wails", 3), ("macos", 2), ("windows", 1), ("android", 2), ("ios", 2),
            ("flutter", 2), ("mobile", 2), ("app", 1), ("gui", 2), ("桌面", 2),
            ("桌面版", 3), ("桌面端", 2), ("桌面应用", 3), ("客户端", 2), ("启动器", 3),
            ("安装包", 3), ("installer", 2), ("手机", 2), ("安卓", 2), ("跨平台", 1)],
    },
    {"id": "memory", "label": "记忆上下文", "priority": 5, "terms": [
        ("memory", 3), ("knowledge", 2), ("rag", 3), ("记忆", 3), ("上下文", 2), ("知识库", 3), ("长期记忆", 3)]},
    {"id": "model", "label": "模型接入", "priority": 6, "terms": [
        ("llm", 2), ("provider", 3), ("openai", 3), ("claude", 2), ("gemini", 2), ("ollama", 3),
        ("endpoint", 2), ("proxy", 2), ("reasoning", 2), ("thinking", 2), ("effort", 2), ("route", 1),
        ("router", 3), ("routing", 2), ("模型", 3), ("接入", 1), ("多模态", 2), ("视觉", 2), ("vision", 2), ("api", 1), ("推理", 2), ("思考", 2),
        ("负载均衡", 2), ("fallback", 2), ("降级", 2)]},
    {"id": "panel", "label": "界面面板", "priority": 7, "terms": [
        ("panel", 2), ("sidebar", 3), ("editor", 2), ("canvas", 2), ("dashboard", 2), ("widget", 2),
        ("toolbar", 2), ("settings", 2), ("button", 2), ("menu", 1), ("hud", 2), ("面板", 3), ("侧边", 3),
        ("工作台", 3), ("编辑器", 3), ("界面", 2), ("设置", 2), ("按钮", 2), ("菜单", 2), ("ui", 1),
        ("悬浮球", 3), ("悬浮窗", 2), ("tui", 3)]},
    {"id": "session", "label": "会话交互", "priority": 8, "terms": [
        ("session", 2), ("chat", 1), ("prompt", 1), ("conversation", 2), ("会话", 3), ("对话", 3),
        ("提示词", 3), ("消息", 2), ("破甲", 4), ("jailbreak", 3), ("越狱", 2), ("prefill", 2), ("拒答", 2),
        ("emoji", 2), ("表情", 2), ("表情包", 3), ("sticker", 2)]},
    {"id": "agent", "label": "智能体技能", "priority": 9, "terms": [
        ("agent", 1), ("skill", 2), ("mcp", 2), ("workflow", 2), ("automation", 2),
        ("智能体", 3), ("技能", 3), ("自动化", 2), ("工作流", 3), ("编排", 2), ("多智能体", 3), ("子代理", 3), ("superagent", 3)]},
    {"id": "tools", "label": "工具命令", "priority": 10, "terms": [
        ("cli", 2), ("tool", 1), ("command", 1), ("ssh", 2), ("setup", 1), ("generator", 2),
        ("retry", 3), ("restart", 2), ("explorer", 2), ("工具", 3), ("命令", 2), ("一键", 2),
        ("安装", 2), ("脚本", 2), ("批量", 2), ("命令行", 3), ("重试", 3), ("重启", 3), ("vscode", 2), ("search", 2), ("搜索", 2), ("检索", 2),
        ("ops", 1), ("devops", 2), ("doctor", 3), ("healthcheck", 3), ("运维", 3), ("健康检查", 3), ("巡检", 3), ("自愈", 3),
        ("诊断", 2), ("修复", 2), ("清理", 2), ("限流", 2)]},
    {"id": "dev", "label": "开发调试", "priority": 11, "terms": [
        ("debug", 2), ("review", 2), ("lint", 2), ("verify", 2), ("调试", 3), ("测试", 2),
        ("审查", 3), ("日志", 2), ("验证", 2)]},
    {"id": "web", "label": "浏览器与前端", "priority": 12, "terms": [
        ("browser", 2), ("前端", 2), ("浏览器", 2), ("vue", 2), ("react", 1), ("网页", 2)]},
    {"id": "remote", "label": "远程访问", "priority": 13, "terms": [
        ("remote", 2), ("ssh", 3), ("tunnel", 3), ("lan", 2), ("frp", 3), ("vpn", 3), ("tailscale", 3),
        ("局域网", 3), ("内网", 3), ("远程", 3), ("端口转发", 3), ("扫码", 2), ("手机访问", 3)]},
    {"id": "secure", "label": "安全权限", "priority": 14, "terms": [
        ("security", 3), ("auth", 3), ("oauth", 3), ("credential", 3), ("secret", 2), ("permission", 3),
        ("approval", 3), ("sandbox", 3), ("encrypt", 3), ("安全", 3), ("权限", 3), ("密钥", 3),
        ("审批", 3), ("脱敏", 3), ("加密", 3), ("审计", 2)]},
    {"id": "bridge", "label": "集成桥接", "priority": 15, "terms": [
        ("bridge", 3), ("adapter", 3), ("integration", 3), ("connector", 3), ("connect", 2),
        ("对接", 3), ("桥接", 3), ("适配", 3), ("互通", 3), ("中转", 2), ("网关", 2),
        ("飞书", 3), ("lark", 3), ("钉钉", 3), ("企业微信", 3), ("telegram", 3), ("discord", 3), ("slack", 3), ("onebot", 2),
        ("qqbot", 3), ("wechat", 3), ("weixin", 3), ("qq", 2), ("机器人", 2), ("消息通道", 3), ("微信", 2)]},
    {"id": "usage", "label": "用量计费", "priority": 16, "terms": [
        # 只保留「用量/额度/余额/计费」语义；监控归 tools-ops，省 Token/加速归 efficiency
        ("usage", 3), ("balance", 3), ("quota", 3), ("billing", 3), ("cost", 2), ("credit", 2),
        ("token", 1), ("gauge", 2), ("wallet", 2), ("用量", 3), ("额度", 3), ("余额", 3),
        ("计费", 3), ("消耗", 2), ("统计", 1), ("令牌", 2), ("钱包", 2)]},
    {"id": "doc", "label": "文档处理", "priority": 17, "terms": [
        ("reader", 3), ("markdown", 3), ("pdf", 3), ("translate", 3), ("translation", 3), ("wiki", 2),
        ("阅读", 3), ("翻译", 3), ("笔记", 3), ("字幕", 3), ("摘要", 2), ("文档", 1),
        ("locale", 2), ("本地化", 2), ("语言包", 2), ("i18n", 2), ("lang", 2),
        ("office", 2), ("word", 2), ("excel", 2), ("ppt", 3), ("pptx", 3), ("slides", 2), ("wps", 3),
        ("onlyoffice", 3), ("docx", 3), ("公文", 3), ("幻灯片", 2), ("办公", 2)]},
    {"id": "file", "label": "文件管理", "priority": 18, "terms": [
        ("folder", 3), ("drag", 2), ("drop", 1), ("file", 1), ("explorer", 2), ("picker", 2),
        ("文件", 1), ("目录", 1), ("拖拽", 3), ("网盘", 3), ("附件", 1), ("备份", 2)]},
    # "鲸鱼娘/小鲸鱼/看板娘"是 DSH 桌宠的通用说法（官方吉祥物是鲸鱼），这里的「娘」指"角色"；
    # 但这些词只说明长相：自述皮肤/主题的仓库先排除，只有自述宠物/陪伴玩法才由 override 救回。
    {"id": "pet", "label": "桌宠陪伴", "priority": 19,
     "exclude": {"name": _PET_SKIN_SELF, "desc": _PET_SKIN_SELF},
     "override": {"name": _PET_SELF, "desc": _PET_SELF, "topics": _PET_SELF},
     "terms": [
        ("pet", 3), ("pokemon", 3), ("live2d", 3), ("game", 2), ("桌宠", 3), ("宠物", 3),
        ("养成", 3), ("游戏", 2), ("虚拟形象", 3),
        ("小鲸鱼", 6), ("鲸鱼娘", 5), ("娘", 3), ("看板娘", 3), ("mascot", 3), ("吉祥物", 3), ("陪伴", 2),
        ("鲸鲸", 3), ("心情", 2), ("情绪", 2), ("搭话", 3), ("人设", 2), ("persona", 2), ("tavern", 3),
        ("酒馆", 2), ("角色卡", 3), ("soul", 2)]},
    # 回答"生态规则与地基由谁定"：协议/规范/标准 + 基座/框架。标准、协议、framework 都是泛词，
    # 所以 gate 要求生态语境或基座自述，strong 让"底座/基座/皮肤框架"这类自述直接胜出。
    {"id": "spec", "label": "协议基座", "priority": 20,
     "gate": {
         "name": re.compile(r"((^|[-_])(std|spec|specs|convention|conventions|covenant|charter)([-_]|$))|((插件|生态)(规范|标准|公约|契约|协议))|(meta[-_]protocol)|(基座|底座)"),
         # 两路取"或"：协议/规范自述，或"给插件生态当基座"的自述（框架/基座须紧邻生态级词，见 BASE_STRONG_SRC）
         "desc": re.compile(SPEC_SELF_SRC + "|" + BASE_STRONG_SRC, re.I),
     },
     "strong": {
         "name": re.compile(r"(基座|底座)"),
         "desc": re.compile(BASE_STRONG_SRC, re.I),
     },
     "terms": [
        ("公约", 2), ("元协议", 3), ("互操作", 3), ("契约", 2), ("约定", 1), ("规范", 2), ("协议", 1), ("标准", 1),
        ("convention", 2), ("specification", 2), ("interoperability", 3), ("interoperable", 3), ("schema", 1),
        ("protocol", 1), ("standard", 1), ("rfc", 1), ("manifest", 1), ("接口定义", 3), ("插件规范", 3), ("插件标准", 3),
        ("基座", 4), ("底座", 4), ("脚手架", 3), ("基础设施", 3), ("框架", 3), ("中间件", 2), ("内核", 2),
        ("foundation", 3), ("framework", 2), ("scaffold", 3), ("infrastructure", 2)]},
    {"id": "media", "label": "媒体内容", "priority": 21,
     "gate": {"name": re.compile(r"(^|[-_ ])(image|video|audio|music|player|render|screenshot|draw|cad|media|comfyui)([-_ ]|$)|图像|图片|视频|音频|音乐|播放|绘图|截图|渲染|媒体|动画|生图|出图|文生图|图生图|comfyui")},
     "terms": [
        ("image", 3), ("video", 3), ("audio", 3), ("music", 2), ("player", 2), ("render", 2),
        ("screenshot", 2), ("draw", 2), ("drawing", 2), ("cad", 2), ("media", 3), ("animation", 2),
        ("图像", 3), ("图片", 2), ("视频", 3), ("音频", 3), ("音乐", 2), ("播放", 2), ("播放器", 2),
        ("绘图", 2), ("截图", 2), ("渲染", 2), ("剪辑", 2), ("媒体", 3), ("动画", 2), ("白板", 2),
        ("comfyui", 3), ("生图", 3), ("出图", 2), ("文生图", 3), ("图生图", 3), ("image gen", 2)]},
    {"id": "data", "label": "数据与行情", "priority": 22,
     "gate": {
         "name": re.compile(r"(^|[-_ ])(data|table|csv|sql|database|analytics|chart|finance|stock|quant)([-_ ]|$)|数据|表格|数据库|分析|图表|行情|股票|量化"),
         "desc": re.compile(r"(行情|股票|金融|基金|指数|大盘|K线|财务|报表|数据大屏|金融数据)"),
     },
     # token/用量类图表属于「用量计费」，不是数据工具（修 dsh-token-chart 被 data 抢走）
     "exclude": {"name": re.compile(r"(token|usage|balance|quota|wallet|余额|额度|用量|计费|钱包)")},
     "terms": [
        ("data", 2), ("table", 2), ("csv", 2), ("sql", 3), ("database", 2), ("analytics", 2),
        ("chart", 2), ("finance", 2), ("stock", 2), ("quant", 2), ("数据", 2), ("表格", 3),
        ("数据库", 2), ("分析", 2), ("图表", 2), ("行情", 2), ("股票", 2), ("量化", 2),
        ("金融", 2), ("基金", 2), ("指数", 2), ("大盘", 2), ("财务", 2)]},
    {"id": "efficiency", "label": "效率优化", "priority": 23,
     "gate": {
         "name": re.compile(r"(token[-_ ]?(sav|opt|effic|diet|slim)|save[-_]?token|省token|效率|加速|performance|terse|caveman|compaction|compact|rtk|efficient|optimiz|frugal|lean)"),
         "desc": re.compile(
             r"(节省|节约|降低|减少)[^。\n]{0,30}(token|消耗|成本|耗时|上下文|工具结果)"
             r"|token[^。\n]{0,20}(减少|降低|节省|优化)|token[- ]?(efficien|sav|diet|opt)"
             r"|cut[s]?\s+token|token\s+cost|reduce\s+token|fewer\s+token|save\s+token"
             r"|execution\s+time|context[- ]?compression|compaction|prune|rtk|terse|caveman"
             r"|efficient|frugal|lean\s+mode|tool[- ]output\s+budget|prompt\s*cache", re.I),
     },
     # 记账类插件不进效率扇区：余额/额度/账单/计费/钱包
     "exclude": {"name": re.compile(r"(^|[-_])(balance|billing|ledger|wallet|quota|cost|meter)([-_]|$)|余额|额度|计费|账单|钱包")},
     "terms": [
        ("节省", 3), ("节约", 3), ("降低消耗", 3), ("减少消耗", 3), ("省token", 3), ("消耗", 3), ("成本", 1),
        ("token", 2), ("token saver", 4), ("token-saver", 4), ("token optimizer", 4), ("token-optimizer", 4),
        ("token optimization", 4), ("token-optimization", 4), ("token efficiency", 4), ("token-efficiency", 4),
        ("save-token", 4), ("token diet", 4), ("token-diet", 4), ("caveman", 3), ("terse", 3),
        ("compaction", 3), ("compact", 2), ("rtk", 3), ("prune", 3), ("tool output", 3), ("工具结果", 3),
        ("上下文压缩", 4), ("压缩", 2), ("低耗", 3), ("效率", 2), ("加速", 2), ("execution time", 3),
        ("reduce token", 4), ("fewer token", 4), ("efficient", 2), ("frugal", 3), ("low-level operations", 3),
        ("底层操作", 3), ("低层操作", 3), ("提效", 3), ("耗时", 2)]},
]

# 细枝分类：与大分类同一套词边界规则，用于「选中扇区后铺满整圆」的二级扇区。
# 由 tools/categories.mjs 的 SUBCATEGORY_RULES 生成，verify_parity.py 校验两边结果一致。
SUBCATEGORY_RULES: dict[str, list[dict]] = {
    "spec": [
        {"id": "spec-interop", "label": "互操作协议", "terms": [("interop", 3), ("interoperability", 3), ("interoperable", 3), ("互操作", 3), ("元协议", 3), ("meta-protocol", 3), ("protocol", 2), ("协议", 2)]},
        {"id": "spec-standard", "label": "生态标准", "terms": [("standard", 3), ("specification", 3), ("spec", 2), ("标准", 3), ("规范", 3), ("共识", 3), ("convention", 2)]},
        {"id": "spec-contract", "label": "接口契约", "terms": [("contract", 3), ("schema", 3), ("manifest", 3), ("契约", 3), ("约定", 2), ("接口", 2)]},
    ],
    "skin": [
        {"id": "skin-theme", "label": "主题皮肤", "terms": [("skin", 3), ("theme", 3), ("配色", 3), ("主题", 3), ("皮肤", 3)]},
        {"id": "skin-wallpaper", "label": "壁纸背景", "terms": [("wallpaper", 3), ("background", 2), ("壁纸", 3), ("背景", 2)]},
        {"id": "skin-icon", "label": "图标字体", "terms": [("icon", 3), ("font", 3), ("图标", 3), ("字体", 3)]},
        {"id": "skin-splash", "label": "开屏动画", "terms": [("开屏", 3), ("开机动画", 3), ("启动动画", 3), ("启动画面", 2), ("splash", 3), ("boot animation", 3), ("片头", 2)]},
    ],
    "notify": [
        {"id": "notify-voice", "label": "语音播报", "terms": [("voice", 3), ("tts", 3), ("speech", 3), ("语音", 3), ("播报", 3), ("朗读", 3)]},
        {"id": "notify-push", "label": "通知推送", "terms": [("notification", 3), ("push", 2), ("通知", 3), ("推送", 3), ("提醒", 2)]},
        {"id": "notify-sound", "label": "提示音效", "terms": [("sound", 3), ("audio", 3), ("mp3", 3), ("提示音", 3), ("音效", 3), ("音乐", 2)]},
    ],
    "market": [
        {"id": "market-store", "label": "市场商店", "terms": [("market", 3), ("marketplace", 3), ("store", 3), ("市场", 3), ("商店", 3)]},
        {"id": "market-index", "label": "索引合集", "terms": [("index", 2), ("registry", 3), ("awesome", 3), ("索引", 3), ("合集", 3), ("导航", 3), ("清单", 3)]},
    ],
    "desktop": [
        {"id": "desktop-client", "label": "客户端本体", "terms": [("client", 3), ("desktop", 3), ("gui", 2), ("mac", 2), ("客户端", 3), ("桌面", 3)]},
        {"id": "desktop-launcher", "label": "启动器", "terms": [("launcher", 3), ("启动器", 3), ("快捷方式", 2)]},
        {"id": "desktop-installer", "label": "安装分发", "terms": [("installer", 3), ("distribution", 3), ("release", 2), ("安装包", 3), ("分发", 3), ("发布", 2)]},
        {"id": "desktop-mobile", "label": "跨端客户端", "terms": [("android", 3), ("ios", 3), ("flutter", 3), ("mobile", 3), ("安卓", 3), ("手机", 3), ("跨端", 3)]},
    ],
    "memory": [
        {"id": "memory-kb", "label": "知识库", "terms": [("knowledge", 3), ("wiki", 2), ("知识库", 3), ("知识", 2)]},
        {"id": "memory-long", "label": "长期记忆", "terms": [("长期", 2), ("上下文", 2)]},
        {"id": "memory-rag", "label": "检索增强", "terms": [("rag", 3), ("embedding", 3), ("retrieval", 3), ("检索", 3), ("向量", 3), ("召回", 2)]},
        {"id": "memory-inject", "label": "记忆注入", "terms": [("注入", 3), ("规则", 3), ("召回", 2), ("检索", 2)]},
    ],
    "model": [
        {"id": "model-provider", "label": "模型供应商", "terms": [("provider", 3), ("openai", 3), ("claude", 3), ("gemini", 3), ("ollama", 3), ("供应商", 3)]},
        {"id": "model-gateway", "label": "网关代理", "terms": [("proxy", 3), ("gateway", 3), ("endpoint", 3), ("网关", 3), ("代理", 3), ("路由", 2), ("中转", 2)]},
        {"id": "model-multimodal", "label": "多模态", "terms": [("vision", 3), ("multimodal", 3), ("多模态", 3), ("视觉", 3), ("图像", 2), ("图片", 2)]},
        {"id": "model-reasoning", "label": "推理思考", "terms": [("reasoning", 3), ("thinking", 3), ("thought", 2), ("推理", 3), ("思考", 3), ("思维链", 3), ("深思", 2)]},
        {"id": "model-preset", "label": "参数预设", "terms": [("preset", 3), ("temperature", 3), ("parameter", 2), ("参数", 3), ("预设", 3), ("调参", 3), ("配置", 1)]},
        {"id": "model-council", "label": "多模型协同", "terms": [("council", 3), ("ensemble", 3), ("multi-model", 3), ("voting", 3), ("会诊", 3), ("多模型", 3), ("投票", 3)]},
        {"id": "model-select", "label": "模型选择切换", "terms": [("选择", 3), ("切换", 3), ("列表", 2), ("对比", 2), ("设置", 2)]},
        {"id": "model-router", "label": "模型路由", "terms": [("router", 3), ("routing", 3), ("模型路由", 3), ("路由", 2), ("负载均衡", 3), ("fallback", 2), ("降级", 2)]},
    ],
    "panel": [
        {"id": "panel-side", "label": "侧边面板", "terms": [("sidebar", 3), ("侧边", 3)]},
        {"id": "panel-editor", "label": "编辑器", "terms": [("editor", 3), ("编辑器", 3), ("画布", 2), ("canvas", 2)]},
        {"id": "panel-widget", "label": "悬浮组件", "terms": [("widget", 3), ("floating", 3), ("悬浮", 3), ("挂件", 3), ("小组件", 3), ("悬浮球", 3), ("悬浮窗", 2)]},
        {"id": "panel-settings", "label": "设置仪表盘", "terms": [("settings", 3), ("dashboard", 3), ("设置", 3), ("仪表盘", 3), ("配置页", 2)]},
        {"id": "panel-mobile", "label": "移动端界面", "terms": [("mobile", 3), ("android", 3), ("ios", 3), ("apk", 3), ("手机", 3), ("移动端", 3), ("窄屏", 3)]},
        {"id": "panel-tui", "label": "终端界面", "terms": [("tui", 3), ("terminal", 3), ("终端", 3), ("ncurses", 3)]},
        {"id": "panel-workbench", "label": "创作工作台", "terms": [("workbench", 3), ("studio", 3), ("creator", 2), ("创作", 3), ("工作台", 3), ("工坊", 3)]},
    ],
    "session": [
        {"id": "session-manage", "label": "会话管理", "terms": [("history", 2), ("历史", 2)]},
        {"id": "session-prompt", "label": "提示词", "terms": [("prompt", 3), ("提示词", 3), ("提示语", 3)]},
        {"id": "session-chat", "label": "消息对话", "terms": [("chat", 3), ("message", 2), ("conversation", 3), ("对话", 3), ("消息", 2), ("聊天", 2), ("emoji", 2), ("表情", 2), ("表情包", 3), ("sticker", 2)]},
        {"id": "session-maintain", "label": "会话维护", "terms": [("删除", 3), ("清理", 3), ("恢复", 2), ("同步", 3), ("备份", 3), ("迁移", 3), ("导入", 2), ("导出", 2), ("归档", 2)]},
        {"id": "session-context", "label": "上下文压缩", "terms": [("context", 3), ("compact", 3), ("压缩", 3), ("上下文", 3), ("摘要", 3)]},
        {"id": "session-jailbreak", "label": "破甲越狱", "terms": [("破甲", 3), ("jailbreak", 3), ("越狱", 2), ("prefill", 2), ("拒答", 2)]},
    ],
    "agent": [
        {"id": "agent-skill", "label": "技能包", "terms": [("skill", 3), ("技能", 3)]},
        {"id": "agent-mcp", "label": "MCP 服务", "terms": [("mcp", 3), ("model context protocol", 3), ("mcp-server", 3)]},
        {"id": "agent-workflow", "label": "工作流编排", "terms": [("workflow", 3), ("automation", 3), ("工作流", 3), ("自动化", 3), ("编排", 3)]},
        {"id": "agent-sub", "label": "子代理", "terms": [("subagent", 3), ("agents", 2), ("多智能体", 3), ("子代理", 3)]},
        {"id": "agent-coding", "label": "编码代理", "terms": [("coding", 3), ("engineer", 2), ("programming", 3), ("developer", 2), ("编码", 3), ("编程", 3), ("写代码", 3), ("软件工程", 3)]},
        {"id": "agent-teams", "label": "多代理协作", "terms": [("team", 3), ("collaboration", 3), ("collaborative", 3), ("协作", 3), ("团队", 3), ("分工", 2), ("多代理", 3)]},
        {"id": "agent-runtime", "label": "运行时预设", "terms": [("runtime", 3), ("preset", 3), ("scheduler", 3), ("loop", 2), ("运行时", 3), ("预设", 3), ("调度", 3)]},
        {"id": "agent-ptc", "label": "PTC 预设", "terms": [("ptc", 3), ("code mode", 3), ("programmatic tool", 3), ("批量工具", 2)]},
    ],
    "tools": [
        {"id": "tools-cli", "label": "命令行", "terms": [("cli", 3), ("command", 3), ("shell", 2), ("命令行", 3), ("终端", 3), ("命令", 3), ("指令", 3), ("slash", 2), ("斜杠", 3)]},
        {"id": "tools-install", "label": "安装部署", "terms": [("install", 2), ("setup", 2), ("deploy", 3), ("安装", 3), ("部署", 3)]},
        {"id": "tools-script", "label": "脚本批量", "terms": [("script", 3), ("batch", 2), ("脚本", 3), ("批量", 3)]},
        {"id": "tools-gen", "label": "生成转换", "terms": [("generator", 3), ("converter", 3), ("export", 2), ("生成", 2), ("转换", 2), ("导出", 2)]},
        {"id": "tools-search", "label": "检索搜索", "terms": [("search", 3), ("query", 3), ("检索", 3), ("搜索", 3), ("查询", 3)]},
        {"id": "tools-git", "label": "版本控制", "terms": [("git", 3), ("github", 2), ("commit", 3), ("branch", 2), ("仓库", 2), ("版本", 2), ("代码托管", 3)]},
        {"id": "tools-media", "label": "媒体处理", "terms": [("image", 2), ("video", 3), ("audio", 3), ("media", 3), ("图片", 3), ("图像", 3), ("视频", 3), ("音频", 3), ("截图", 3)]},
        {"id": "tools-process", "label": "进程运行时", "terms": [("process", 2), ("runtime", 3), ("进程", 3), ("定时", 2), ("运行时", 3)]},
        {"id": "tools-ops", "label": "运维与自检", "terms": [("ops", 3), ("devops", 3), ("doctor", 3), ("healthcheck", 3), ("watchdog", 3), ("daemon", 3), ("运维", 3), ("健康检查", 3), ("巡检", 3), ("自愈", 3), ("守护", 3), ("备份", 2), ("恢复", 2), ("修复", 2), ("重启", 3), ("清理", 2), ("限流", 2), ("日志", 2), ("监控", 2)]},
    ],
    "dev": [
        {"id": "dev-debug", "label": "调试排查", "terms": [("debug", 3), ("调试", 3), ("排查", 3)]},
        {"id": "dev-review", "label": "代码审查", "terms": [("review", 3), ("lint", 3), ("审查", 3), ("检查", 2)]},
        {"id": "dev-test", "label": "测试验证", "terms": [("test", 2), ("verify", 3), ("测试", 3), ("验证", 3)]},
        {"id": "dev-log", "label": "日志", "terms": [("log", 2), ("日志", 3)]},
    ],
    "web": [
        {"id": "web-ext", "label": "浏览器扩展", "terms": [("browser", 3), ("chrome", 3), ("extension", 3), ("浏览器", 3), ("扩展", 3)]},
        {"id": "web-page", "label": "网页界面", "terms": [("web", 2), ("网页", 3), ("前端", 3)]},
        {"id": "web-framework", "label": "前端框架", "terms": [("vue", 3), ("react", 3), ("component", 2), ("组件", 2)]},
    ],
    "remote": [
        {"id": "remote-control", "label": "远程控制", "terms": [("remote", 3), ("远程", 3), ("控制", 2)]},
        {"id": "remote-tunnel", "label": "隧道穿透", "terms": [("ssh", 3), ("tunnel", 3), ("frp", 3), ("隧道", 3), ("穿透", 3), ("端口转发", 3)]},
        {"id": "remote-lan", "label": "局域网", "terms": [("lan", 3), ("局域网", 3), ("内网", 3)]},
    ],
    "secure": [
        {"id": "secure-perm", "label": "权限审批", "terms": [("permission", 3), ("approval", 3), ("权限", 3), ("审批", 3), ("授权", 3)]},
        {"id": "secure-cred", "label": "凭据密钥", "terms": [("auth", 3), ("oauth", 3), ("token", 3), ("credential", 3), ("密钥", 3), ("凭据", 3)]},
        {"id": "secure-sandbox", "label": "沙箱隔离", "terms": [("sandbox", 3), ("sandboxing", 3), ("沙箱", 3), ("隔离", 3)]},
        {"id": "secure-crypto", "label": "加密脱敏", "terms": [("encrypt", 3), ("privacy", 3), ("加密", 3), ("脱敏", 3), ("隐私", 3)]},
        {"id": "secure-audit", "label": "审计扫描", "terms": [("audit", 3), ("scan", 3), ("scanner", 3), ("compliance", 3), ("审计", 3), ("扫描", 3), ("合规", 3), ("检测", 2)]},
        {"id": "secure-guard", "label": "防护拦截", "terms": [("guard", 3), ("defend", 3), ("defense", 3), ("antivirus", 3), ("injection", 3), ("防护", 3), ("防御", 3), ("拦截", 3), ("注入", 3), ("病毒", 3)]},
    ],
    "bridge": [
        {"id": "bridge-bridge", "label": "桥接", "terms": [("bridge", 3), ("桥接", 3)]},
        {"id": "bridge-adapter", "label": "适配器", "terms": [("adapter", 3), ("adaptor", 3), ("适配", 3)]},
        {"id": "bridge-integration", "label": "第三方对接", "terms": [("integration", 3), ("connect", 2), ("对接", 3), ("互通", 3), ("第三方", 2)]},
        {"id": "bridge-im", "label": "IM 渠道", "terms": [("飞书", 3), ("lark", 3), ("钉钉", 3), ("企业微信", 3), ("telegram", 3), ("discord", 3), ("slack", 3), ("onebot", 3), ("微信", 2)]},
    ],
    "usage": [
        {"id": "usage-balance", "label": "余额", "terms": [("balance", 3), ("余额", 3), ("充值", 3)]},
        {"id": "usage-stat", "label": "用量统计", "terms": [("统计", 3), ("用量", 3), ("消耗", 3), ("监控", 3), ("图表", 2), ("token", 2)]},
        {"id": "usage-billing", "label": "计费成本", "terms": [("billing", 3), ("cost", 3), ("price", 2), ("计费", 3), ("成本", 3), ("价格", 2), ("账单", 3), ("峰谷", 2)]},
        {"id": "usage-quota", "label": "配额订阅", "terms": [("quota", 3), ("配额", 3), ("订阅", 3), ("subscription", 3), ("套餐", 3), ("plan", 2), ("额度", 3), ("限流", 2)]},
    ],
    "doc": [
        {"id": "doc-read", "label": "阅读浏览", "terms": [("reader", 3), ("reading", 3), ("阅读", 3), ("浏览", 2)]},
        {"id": "doc-translate", "label": "翻译", "terms": [("translate", 3), ("translation", 3), ("翻译", 3), ("字幕", 2)]},
        {"id": "doc-render", "label": "渲染导出", "terms": [("markdown", 3), ("pdf", 3), ("render", 2), ("渲染", 3), ("导出", 2), ("预览", 2)]},
        {"id": "doc-note", "label": "笔记摘要", "terms": [("笔记", 3), ("摘要", 3), ("总结", 2), ("收藏", 2)]},
        {"id": "doc-locale", "label": "本地化", "terms": [("locale", 3), ("本地化", 3), ("语言包", 3), ("localization", 3), ("i18n", 3), ("lang", 2)]},
        {"id": "doc-office", "label": "办公文档", "terms": [("office", 3), ("word", 2), ("excel", 2), ("ppt", 3), ("pptx", 3), ("slides", 2), ("wps", 3), ("onlyoffice", 3), ("docx", 3), ("公文", 3), ("幻灯片", 2)]},
    ],
    "file": [
        {"id": "file-path", "label": "文件目录", "terms": [("folder", 3), ("path", 2), ("目录", 3), ("路径", 3)]},
        {"id": "file-drag", "label": "拖拽投放", "terms": [("drag", 3), ("drop", 3), ("拖拽", 3), ("拖入", 3), ("投放", 2)]},
        {"id": "file-sync", "label": "网盘备份", "terms": [("sync", 2), ("backup", 3), ("网盘", 3), ("备份", 3), ("同步", 2), ("云盘", 3)]},
        {"id": "file-preview", "label": "预览浏览", "terms": [("预览", 3), ("上传", 2), ("下载", 2), ("打开", 2), ("浏览", 2), ("在线", 1)]},
    ],
    "pet": [
        {"id": "pet-pet", "label": "桌宠养成", "terms": [("pet", 3), ("桌宠", 3), ("宠物", 3), ("养成", 3)]},
        {"id": "pet-avatar", "label": "虚拟形象", "terms": [("live2d", 3), ("avatar", 2), ("虚拟形象", 3), ("形象", 2)]},
        {"id": "pet-game", "label": "游戏娱乐", "terms": [("game", 3), ("pokemon", 3), ("游戏", 3), ("娱乐", 2)]},
        {"id": "pet-persona", "label": "人设陪伴", "terms": [("人设", 3), ("persona", 3), ("tavern", 3), ("酒馆", 3), ("角色卡", 3), ("soul", 2), ("陪伴", 2)]},
    ],
    "media": [
        {"id": "media-image", "label": "图像截图", "terms": [("image", 3), ("screenshot", 3), ("draw", 2), ("drawing", 2), ("cad", 3), ("图像", 3), ("图片", 3), ("截图", 3), ("绘图", 3), ("白板", 3)]},
        {"id": "media-video", "label": "视频剪辑", "terms": [("video", 3), ("animation", 2), ("视频", 3), ("剪辑", 3), ("动画", 2)]},
        {"id": "media-audio", "label": "音频音乐", "terms": [("audio", 3), ("music", 3), ("player", 2), ("音频", 3), ("音乐", 3), ("播放器", 3)]},
        {"id": "media-render", "label": "渲染导出", "terms": [("render", 3), ("export", 2), ("渲染", 3), ("导出", 2)]},
        {"id": "media-gen", "label": "图像生成", "terms": [("comfyui", 3), ("生图", 3), ("出图", 2), ("文生图", 3), ("图生图", 3), ("image gen", 2)]},
    ],
    "data": [
        {"id": "data-table", "label": "表格数据", "terms": [("table", 3), ("csv", 3), ("excel", 3), ("表格", 3)]},
        {"id": "data-db", "label": "数据库", "terms": [("sql", 3), ("database", 3), ("数据库", 3)]},
        {"id": "data-analytics", "label": "分析图表", "terms": [("analytics", 3), ("chart", 3), ("分析", 3), ("图表", 3)]},
        {"id": "data-finance", "label": "行情金融", "terms": [("finance", 3), ("stock", 3), ("quant", 2), ("行情", 3), ("股票", 3), ("量化", 3)]},
    ],
    "efficiency": [
        {"id": "eff-token", "label": "Token 节省", "terms": [("节省", 3), ("节约", 3), ("caveman", 3), ("terse", 3), ("token saver", 3), ("低耗", 3), ("token", 1), ("消耗", 3), ("fewer token", 3), ("token-optimization", 3)]},
        {"id": "eff-context", "label": "上下文压缩", "terms": [("context", 3), ("compaction", 3), ("compress", 3), ("压缩", 3), ("prune", 3), ("裁剪", 3), ("上下文", 2)]},
        {"id": "eff-tool", "label": "工具结果优化", "terms": [("rtk", 3), ("tool output", 3), ("工具结果", 3), ("budget", 2), ("去重", 2), ("降噪", 2), ("low-level operations", 3), ("底层操作", 3), ("ops", 2)]},
        {"id": "eff-preset", "label": "低耗预设", "terms": [("preset", 3), ("预设", 3), ("mode", 2), ("fast", 2), ("低耗", 3), ("efficient", 2)]},
    ],
}

RULE_BY_PRIORITY = sorted(CATEGORY_RULES, key=lambda r: r["priority"])
LABELS = {r["id"]: r["label"] for r in CATEGORY_RULES}
_COUNTERS = {rule["id"]: [(term, weight, make_counter(term)) for term, weight in rule["terms"]] for rule in CATEGORY_RULES}
_sub_counters: dict[str, list] = {}


# 最低置信分：1.5 = 拒绝「只在描述里命中一个权重 1 的泛词」（1 分）；
# 名字命中（×2）、topic 命中（×1.5）、描述里权重 ≥2 的词仍然保留。
MIN_SCORE = 1.5      # 低于它判为「其他」
MIN_SUB_SCORE = 1.5  # 低于它判为「未细分」


def _last_segment(name: str) -> str:
    """名称最后一段：dsh-plugin-skin 里的 skin 通常是这个仓库的关键词。"""
    parts = [p for p in re.split(r"[-_\s]+", name or "") if p]
    return parts[-1] if parts else ""


def _score_of(counter, sig: dict, weight: int) -> float:
    """统一算分：名称 ×2、名称末段额外 +1、描述 ×1、topic ×1.5（与 JS 端逐条一致）。"""
    in_name = counter(sig["name"])
    in_last = counter(sig["last"])
    in_desc = counter(sig["desc"])
    in_topics = counter(sig["topics"])
    in_readme = counter(sig.get("readme") or "")
    if in_name + in_desc + in_topics == 0:
        # README 半权：只有摘要证据时看它给不给得出底分（乘 0.5 之后仍然要过 MIN_SCORE 才能离开「其他」）
        if not in_readme:
            return 0.0
        return (in_readme * 0.5) * weight
    return (in_name * 2 + in_last + in_desc + in_topics * 1.5 + in_readme * 0.5) * weight


def _signals(node: dict, whitelist_tags=None) -> dict:
    """信号来源：仓库名 + 描述 + 非白名单 topic（白名单标签本身不算证据）。
    whitelist_tags：本轮生效的白名单（后台可改）；不传时用内置默认，与 JS 端读同一份配置。"""
    from .config import WHITELIST_TAGS

    tags = {str(t).strip() for t in (whitelist_tags or WHITELIST_TAGS) if str(t).strip()}
    topics = " ".join(t for t in (node.get("topics") or []) if t not in tags)
    name = node.get("name")
    if name is None:
        name = node.get("id") or ""
    lowered = str(name).lower()
    # 2026-11-07 P2：README 摘要也当证据（半权，截 800 字）——实时由 build/reclassify 借给节点，
    # 「other 篮子」里 2763 条有摘要的仓库是它的可判定池；没带 digest 的节点（冻结参照物/实时样本）与老口径逐字一致。
    return {
        "name": lowered,
        "last": _last_segment(lowered),
        "desc": str(node.get("description") or "").lower(),
        "readme": str(node.get("readmeDigest") or "").lower()[:800],
        "topics": topics.lower(),
    }


def _passes_gate(rule: dict, sig: dict) -> bool:
    gate = rule.get("gate")
    if not gate:
        return True
    return any(gate.get(key) and gate[key].search(sig[key]) for key in ("name", "desc", "topics"))


def _is_excluded(rule: dict, sig: dict) -> bool:
    """排除：命中即失去资格，除非 name/desc/topics 里有强自述把它救回来。"""
    exclude = rule.get("exclude")
    if not exclude:
        return False
    hit = any(exclude.get(key) and exclude[key].search(sig[key]) for key in ("name", "desc"))
    if not hit:
        return False
    override = rule.get("override")
    # topics 是作者自己打的标签，与 gate 同权：作者标了 pet/desktop-pet 就算自述
    if override and any(override.get(key) and override[key].search(sig[key]) for key in ("name", "desc", "topics")):
        return False
    return True


def _strong_hit(rule: dict, sig: dict) -> bool:
    """强命中：规则声明 strong（name/desc/topics 三个正则）时，命中即直接胜出，不再比分数。
    只给语义无歧义的"自述"用（如「侧边栏底座」「皮肤框架」），否则会被正文里的 sidebar/皮肤 分流。"""
    strong = rule.get("strong")
    if not strong:
        return False
    return any(strong.get(key) and strong[key].search(sig[key]) for key in ("name", "desc", "topics"))


def classify_node(node: dict, whitelist_tags=None) -> dict:
    """单仓库分类：返回 {id,label,score,hits,blocked}。"""
    sig = _signals(node, whitelist_tags)
    best = None
    blocked = None
    for rule in RULE_BY_PRIORITY:
        score = 0
        hits: list[str] = []
        for term, weight, count in _COUNTERS[rule["id"]]:
            s = _score_of(count, sig, weight)
            if s > 0:
                score += s
                hits.append(term)
        if score <= 0:
            continue
        if not _passes_gate(rule, sig):
            blocked = blocked or {"id": rule["id"], "label": rule["label"], "reason": "未达门槛"}
            continue
        if _is_excluded(rule, sig):
            blocked = blocked or {"id": rule["id"], "label": rule["label"], "reason": "被排除规则拦下"}
            continue
        if _strong_hit(rule, sig):
            best = {"id": rule["id"], "label": rule["label"], "score": score, "hits": hits[:3], "strong": True}
            break
        if best is None or score > best["score"]:
            best = {"id": rule["id"], "label": rule["label"], "score": score, "hits": hits[:4]}
    # 最低置信分：只有一个很弱的描述命中时不硬塞进扇区，留给「其他」
    if best is not None and best["score"] < MIN_SCORE:
        blocked = blocked or {"id": best["id"], "label": best["label"], "reason": "置信分不足"}
        best = None
    # 细枝提父级：父级完全没分，但某个细枝有足够强的名字证据时，用细枝的父扇区兜底。
    # 只在候选唯一时生效，避免两个细枝同分时硬猜。
    if best is None:
        promoted = []
        for parent, rules in SUBCATEGORY_RULES.items():
            parent_rule = next((r for r in CATEGORY_RULES if r["id"] == parent), None)
            # 有 gate 的扇区（market/spec/desktop/media/data）必须由自身门槛决定，不能靠细枝词兜底
            if parent_rule is None or parent_rule.get("gate"):
                continue
            if not _passes_gate(parent_rule, sig) or _is_excluded(parent_rule, sig):
                continue
            for rule in rules:
                score = 0.0
                name_score = 0
                hits: list[str] = []
                for term, weight in rule["terms"]:
                    fn = make_counter(term)
                    s = _score_of(fn, sig, weight)
                    if s > 0:
                        score += s
                        hits.append(term)
                        name_score += fn(sig["name"]) + fn(sig["last"])
                if score > 0:
                    promoted.append((score, name_score, parent, hits))
        promoted.sort(key=lambda x: (-x[0], -x[1]))
        if promoted:
            top = promoted[0]
            second = promoted[1] if len(promoted) > 1 else None
            if top[0] >= 3 and top[1] > 0 and (second is None or top[0] > second[0]):
                best = {"id": top[2], "label": LABELS.get(top[2], top[2]), "score": top[0], "hits": top[3][:4], "promoted": True}
    if best is None:
        return {"id": OTHER["id"], "label": OTHER["label"], "score": 0, "hits": [], "sub": None, "blocked": blocked}

    # 细枝：同一套规则下挑该扇区内部得分最高的细枝
    sub = None
    for rule in SUBCATEGORY_RULES.get(best["id"], []):
        sub_score = 0.0
        name_score = 0
        sub_hits: list[str] = []
        for term, weight, fn in _sub_counters.setdefault(
            rule["id"], [(t, w, make_counter(t)) for t, w in rule["terms"]]
        ):
            s = _score_of(fn, sig, weight)
            if s > 0:
                sub_score += s
                sub_hits.append(term)
                name_score += fn(sig["name"]) + fn(sig["last"])
        better = sub is None or name_score > sub["nameScore"] or (name_score == sub["nameScore"] and sub_score > sub["score"])
        if sub_score > 0 and better:
            sub = {"id": rule["id"], "label": rule["label"], "score": sub_score, "nameScore": name_score, "hits": sub_hits[:3]}
    if sub is not None and sub["score"] < MIN_SUB_SCORE:
        sub = None
    if sub is None and best["id"] != OTHER["id"]:
        sub = {"id": best["id"] + "-general", "label": "综合", "score": 0, "nameScore": 0, "hits": []}
    return {**best, "sub": sub}


# 语义上必须独立成扇区的分类：样本少也不并进「其他」（「公约协议」回答"生态规则由谁定"）。
KEEP_ALWAYS = ("spec",)


def apply_categories(
    nodes: list[dict],
    min_count: int = 10,
    max_sectors: int = 26,
    keep_ids=KEEP_ALWAYS,
    base_ids=(),
    whitelist_tags=None,
) -> dict:
    """全量归类 + 长尾合并，语义与 JS 的 applyCategories 一致。
    base_ids：策展认定的生态基座直接归入协议基座 —— 它们"别人长在上面"，但正文未必写"基座"。"""
    curated = set(base_ids or ())
    spec_label = LABELS.get("spec", "协议基座")
    raw = {
        node["id"]: (
            {"id": "spec", "label": spec_label, "score": 0, "hits": ["策展基座"], "strong": True, "curatedBase": True}
            if node["id"] in curated
            else classify_node(node, whitelist_tags)
        )
        for node in nodes
    }
    counts: dict[str, int] = {}
    for result in raw.values():
        counts[result["id"]] = counts.get(result["id"], 0) + 1

    always = set(keep_ids or ())
    kept = [
        cid for cid, n in counts.items()
        if cid != OTHER["id"] and (n >= min_count or (cid in always and n > 0))
    ]
    kept.sort(key=lambda cid: (-counts[cid], LABELS.get(cid, cid)))
    dropped = kept[max_sectors:]
    kept = kept[:max_sectors]
    kept_set = set(kept)

    merged = [
        {"id": cid, "count": n, "reason": "超出扇区上限" if cid in dropped else "样本过少"}
        for cid, n in counts.items()
        if cid != OTHER["id"] and cid not in kept_set
    ]

    for node in nodes:
        result = raw[node["id"]]
        keep = result["id"] in kept_set
        node["category"] = result["id"] if keep else OTHER["id"]
        node["categoryLabel"] = result["label"] if keep else OTHER["label"]
        node["categoryScore"] = result["score"]
        node["categoryHits"] = result["hits"]
        if result.get("strong"):
            node["categoryStrong"] = True
        else:
            node.pop("categoryStrong", None)
        if result.get("curatedBase"):
            node["categoryCurated"] = True
        else:
            node.pop("categoryCurated", None)
        sub = result.get("sub")
        node["subcategory"] = sub["id"] if (keep and sub) else None
        node["subcategoryLabel"] = sub["label"] if (keep and sub) else None
        if keep:
            node.pop("categoryRaw", None)
        else:
            node["categoryRaw"] = result["id"]

    final: dict[str, int] = {}
    for node in nodes:
        final[node["category"]] = final.get(node["category"], 0) + 1

    return {
        "counts": sorted(
            ({"id": cid, "label": OTHER["label"] if cid == OTHER["id"] else LABELS.get(cid), "count": n} for cid, n in final.items()),
            key=lambda item: -item["count"],
        ),
        "merged": merged,
        "classified": sum(1 for n in nodes if n["category"] != OTHER["id"]),
        "unclassified": final.get(OTHER["id"], 0),
        "total": len(nodes),
        # build_mesh 的契约字段（JS 侧由 seed-sample.mjs 补上，这里直接给出）
        "minCount": min_count,
        "maxSectors": max_sectors,
    }
