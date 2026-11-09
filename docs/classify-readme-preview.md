# 分类 gate 打开预览：仅凭 README 摘要（半权 0.5）的 30 条高星样本（未落任何数据）

> 本文件只是 2026-11-07 复核链路上的「预览样本」：分类器的 gate（准入门槛）目前刻意只看 name/desc/topics，
> 所以 README 半权证据在真实管线上迁移为 0。要打开就在 `_passes_gate`/`passesGate` 里加 `gate.readme`——先看下面这批样例质量再决定。

预估可判量（忽略 gate/exclude 的简化口径）：**1890** 条 / 队列里 README 摘要可用 22013 条。「other」篮子会从 6,140 往下走。

## 样例（按星标排序，30 条）

| id | stars | 建议扇区 | score | readme 命中词 | README 摘要片段 |
|---|---:|---|---:|---|---|
| sopaco/deepwiki-rs | 3164 | 智能体技能 | 2.0 | agent | Litho (deepwiki-rs) English 中文 💪🏻 High-performance AI-driven intelligent document generator (DeepWiki-like) bu |
| Alterssss/dsh-bili-whale | 930 | 文档处理 | 7.5 | 字幕 | dsh-bili-whale 给 DSH 装一条 有日子的鱼 ：它自己按作息刷 B 站、真看懂视频、写两本日记，把值得的 @ 你 。 不是"定时任务 + 关键词搜索"，是 生物钟 + 偏好 + 克制 ：每天只醒一两次，筛 |
| vb2250158/RabiRoute | 492 | 智能体技能 | 2.5 | agent | English 简体中文 RabiRoute Let Agents connect everything around us. Send chat, voice, scheduled, and device messag |
| ECNU/EduWork | 298 | 模型接入 | 8.0 | 模型,接入 | EduWork 基于 DSH 的教育发行版。 单点登录 · 插件与技能 · Knowledge Studio 简体中文 English 项目官网 · 发行版关系 · 插件 · 技能 · 单点登录 · Studio · 开 |
| ZiPengWei/dsh-purge | 283 | 会话交互 | 8.0 | prompt,会话,提示词,jailbreak | dsh-purge DSH Web UI plugin · 指令权威性清除（Jailbreak）—— 叫我小杨同学·，强制读取设置的规则，三层清除 8 patch，npm 升级后自动重清。 English 中文 为 De |
| Duskriver/dsh-opencode-go | 253 | 模型接入 | 15.5 | 模型,api | dsh-opencode-go English 功能：让你在 DeepSeek Harness 中完美使用 OpenCode Go 订阅模型，支持流式回复、工具调用和图片输入。 插件会自动添加 OpenCode Go 所 |
| InariNGT-Ofiicial/dsh-bili-humanism | 248 | 工具命令 | 5.0 | 工具,安装 | DSH B站内容学习插件 寄往明日的信笺｜让AI看见多彩的世界 最终目标：用多彩的人类世界，训练 DSH 的人格。 让 AI 在人的创作与生活中学习理解人，认真对待人。这里通过信笺、反思和持久的人格上下文，让经历逐渐影响 |
| deepseek-ai/dsh-libreoffice-kit | 212 | 文档处理 | 5.0 | pdf,office | --- description: "Font-friendly Office-to-PDF conversion in Node.js, with prebuilt LibreOffice engines." kind: |
| antinomie-lab/dsh-explore | 175 | 文档处理 | 6.5 | pdf,阅读,文档 | Deepseek Harness Explore English · 简体中文 本仓库汇集了关于 Cordis & Deepseek Harness 的解读文章，以及未来会更新的 DeepSeek Harness 的相关 |
| Yan-Zero/dsh-std | 136 | 协议基座 | 5.5 | interoperability,protocol,standard | DSH Standard English 中文 In plain terms, DSH Standard is a set of universal interoperability protocols . Its go |
| MichengAI/dsh-codex-desktop | 128 | 客户端应用 | 31.5 | desktop,macos,windows,installer | DSH Codex Desktop Download once. Open a ready-to-use local AI workspace. 简体中文 · Download · Changelog · Report  |
| bugmaker2/dsh-plugin-template | 103 | 远程访问 | 4.0 | remote | dsh-plugin-template English 中文 A complete dual-side DeepSeek Harness plugin template. It demonstrates the full |
| eleckoi/ElecKoi | 96 | 工具命令 | 10.5 | 工具,脚本,搜索,检索 | 电子爱 简体中文 English 电子爱是一款免费开源的 AI 角色扮演和角色卡创作软件，支持 Windows PC 和 Android。你可以与 AI 角色聊天、体验故事，也可以创建和编辑自己的角色卡，让 AI 帮你完 |
| plolpl789/dsh-raw-html | 94 | 媒体内容 | 13.0 | 渲染 | dsh-raw-html · VCP 视觉通感协议规范插件 在 DeepSeek Harness Web GUI 中实现 VCP（Visual-Synesthesia，视觉通感）协议 ： 消息里的 HTML 从「一坨源码 |
| plolpl789/dsh-raw-html-v2 | 92 | 媒体内容 | 13.0 | 渲染,动画 | dsh-raw-html-v2（VCP 视觉通感协议插件 · 官方 Slot API 版） 让 AI 在 DeepSeek Harness 对话正文中直接输出裸 HTML，渲染成视觉卡片（卡片 / KaTeX 公式 /  |
| FNOSP/fnos-dsh | 91 | 工具命令 | 9.0 | cli,工具,安装 | fnOS DSH &nbsp;&nbsp;&middot;&nbsp;&nbsp; 飞牛 fnOS 上的 DeepSeek Harness 应用与插件生态项目。 项目简介 本项目用于将 DeepSeek Harness  |
| sol5766/dshm | 80 | 客户端应用 | 11.5 | electron,macos,windows,桌面 | DSHM 在 HarmonyOS 上自足运行 DeepSeek Harness 的应用 DSHM 把 DeepSeek Harness（dsh）的 运行本体 装进一个鸿蒙应用：HAP 内自带 Node 运行时与 dsh  |
| multica-ai/dsh-multica-runtime | 77 | 集成桥接 | 3.0 | bridge,integration | Multica DSH Runtime Private, out-of-tree runtime bridge between Multica and the public DeepSeek Harness. It ex |
| Anchorite-no/dsh-zju-assistant | 71 | 客户端应用 | 13.0 | macos,windows,桌面,桌面版 | ZJU All-in-One Assistant 浙大学生的一站式校园 AI 助手。原来是一个自己打包的桌面应用（Windows 和 macOS），现在改成了 DeepSeek Harness 的插件，名字不变，Wind |
| dshbox/cordis-rs | 70 | 协议基座 | 3.0 |  | Cordis English 简体中文 Cordis is a typed runtime for long-lived, plugin-oriented Rust applications. It gives appl |
| yjh051108/dsh-agi-harness | 66 | 模型接入 | 8.5 | 模型,降级 | dsh-agi-harness 给聪明模型一副「可托付的身体」：责任、可信度与学习能力的外部化。 模型强在单次生成，但训练只优化「这一次答得好」——诚实（说到做到）、索取（缺料主动要）、经验沉淀与唤醒（学过的记下、下次会 |
| a179-sanae/dsh-auto-collapse | 61 | 模型接入 | 9.0 | 推理,思考 | dsh-auto-collapse DSH Web 工作段折叠：保留原生一级，把正文之间的思考、工具和上下文合成一个二级；展开后显示原生三级。 English · 插件市场 展示方式 text 正文 A ▸ 已思考 ·  |
| Vithrive/Deepseek-Harness-for-VS-Code | 59 | 集成桥接 | 9.0 | 桥接,适配 | DeepSeek Harness for VS Code 一个零依赖的 VS Code 扩展，把 DeepSeek Harness (DSH) 接入 VS Code 的两种形态： 1. 忠实窗口 ：把 DSH 的 Web |
| lzszq/dsh-scholar | 57 | 会话交互 | 3.0 | chat,prompt,conversation | DSH Scholar 简体中文 English DSH Scholar is an AI research workspace for computational research. It keeps project  |
| luckui/dsh-livestream | 57 | 媒体内容 | 6.0 | 视频 | dsh-livestream DeepSeek Harness 的直播插件：让 DSH 里的 agent 在 B 站直播间当主播。 默认角色是「大肥鱼」。她自己看弹幕、谢礼物、点播视频、给观众写私信，用自己的声音说话。  |
| Nyasers/DSHana | 57 | 工具命令 | 9.5 | 安装,重试 | DSHana Hana App ID： dshana 把 DeepSeek Harness 接入 HanaAgent，作为 受管子代理执行器 ：App 加载后拉起一个受管 Node runtime（ ctx.runtim |
| ChaoMixian/dsh2shell | 57 | 模型接入 | 3.0 | llm,provider,api | dsh2shell Unauthenticated RCE PoC for exposed DeepSeek Harness (dsh) web instances. Principle : spoofing the H |
| ExElectron/dsh-gov-portal | 55 | 集成桥接 | 4.0 | integration,对接,网关 | dsh-gov-portal · Deepseek Harness 综合智能办事平台 一个以 中国地方政务网站视觉规范 为设计基准的独立 WebUI 插件：在独立端口（默认 3081 ）提供政务风办事大厅界面，通过宿主进 |
| Ephemeral-AI-Lab/dsh-plugins | 54 | 插件市场 | 7.0 | marketplace,registry,catalog | 🧩 Mayfly / DSH Plugin Marketplace The official plugin marketplace for Mayfly and DeepSeek Harness (dsh) : Ephe |
| Lyutoon/macOS_DSH_LPE | 52 | 客户端应用 | 7.0 | macos,gui | macOS LPE to root via DesktopServicesHelper chown primitive + auth.db hijack root your macOS in 2 seconds. Dis |

## 扇区计数（全部可判，非样例）

- 工具命令: 451
- 客户端应用: 284
- 会话交互: 221
- 模型接入: 157
- 界面面板: 157
- 智能体技能: 106
- 媒体内容: 97
- 插件市场: 47
- 数据与行情: 45
- 安全权限: 45
- 文档处理: 34
- 文件管理: 33
- 用量计费: 30
- 集成桥接: 28
- 通知提醒: 24
- 皮肤美化: 23
- 记忆上下文: 22
- 效率优化: 20
- 协议基座: 16
- 开发调试: 16
- 远程访问: 15
- 桌宠陪伴: 11
- 浏览器与前端: 8
