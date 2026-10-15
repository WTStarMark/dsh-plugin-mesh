# 管理后台（同进程、同端口）

## 一句话

管理后台**不是第二个服务**：它长在现有 Node 进程 `tools/serve.mjs` 里，跟站点共用端口与 pm2 进程。
入口路径是一段 32 位随机字母数字，写在 `.env` 的 `ADMIN_PATH`。没有它，后台整体关闭 —— 不会留一个默认可猜的入口。

## 界面长什么样

登录后是六个标签页：**状态 / 数据 / 工作流 / 名单 / 共鸣 / 审计**。顶栏还有四样东西：采集状态圆环、会话到期时间、配色键、退出。圆环表示下一次扫描的倒计时。

- **配色只有「清爽 / 粉黛」两套，都是浅色**，没有明暗切换。点配色键即换，选择记在浏览器本地（`localStorage("mesh-admin-palette")`）。
- 界面用三种"表面"来区分信息层级。表面就是区块的视觉处理方式：
  - **面板族**：玻璃底 + 不规则圆角 + 细边。放最重要的信息，一页最多三块。
  - **凹槽族**：只有底色 + 内阴影。用来装表格和日志。
  - **裸排版族**：没有盒子，只靠细线和字号分层。放键值、流水线阶段、次要统计。
- 发光只给"数据"：进度填充、状态圆环、主色数字、选中的标签页与基座项。标题和装饰不发光。

## 启动与口令

```bash
node tools/admin-setup.mjs           # 缺什么补什么：缺路径就生成 32 位随机路径，缺口令就生成随机口令
node tools/admin-setup.mjs --show    # 只看后台地址（不改文件、不打印口令）
node tools/admin-setup.mjs --force-password --password 'xxx'   # 改口令
node tools/admin-setup.mjs --path-only                          # 只补路径（部署脚本用，避免口令进部署日志）

npm run serve                        # 本地：http://127.0.0.1:8788/<ADMIN_PATH>/
```

- 口令以 **scrypt 哈希**存 `.env`（`ADMIN_PASSWORD_HASH`）。也兼容直接写明文 `ADMIN_PASSWORD`，便于手工起步。
- 登录成功换 **HttpOnly + SameSite=Strict** 的会话 Cookie。`Path` 锁死在后台路径下，有效期 12 小时，**只存内存**（进程重启需重新登录）。
- 所有写操作要 **CSRF 令牌**（登录后由 `api/session` 下发，请求头 `X-CSRF-Token`），并校验同源。
- 连续输错 5 次，按 IP 锁 10 分钟（`429 + Retry-After`）。
- **访问日志只记接口名**（`后台 GET api/status`），绝不写后台路径 —— 路径本身就是一道口令。

## 接口一览

前缀统一为 `/<ADMIN_PATH>/`。

会话与状态：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 后台页面（未登录先给登录页） |
| GET | `/api/session` | 会话状态（未登录回 `{authed:false}`） |
| POST | `/api/login` `/api/logout` | 登录 / 退出 |
| GET | `/api/status` | 采集状态 + 应用作业进度 + `collector`（采集器是否在跑）+ `pending`（名单/共鸣有没有改了没应用） |

数据与流水线：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 数据概况：节点/连线/扇区、关键文件、快照、最近一次采集 |
| GET | `/api/repos` | 仓库检索（分页，复用公开 API 的查询实现） |
| GET | `/api/workflow` | 五段采集流水线 + 上一次运行的溯源信息 |
| GET | `/api/lists` | 黑名单 + 白名单标签（含默认值） |

名单与共鸣：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/lists/blacklist` | `{action:"add"\|"remove", owner, note?}` |
| POST | `/api/lists/whitelist` | `{tags:[...], whitelistAliases?:[{tag,aliases:[...]}]}`（不传别名组时保留原值） |
| POST | `/api/lists/blacklist` | `{action:"add-repo"\|"remove-repo", repoId:"owner/repo", note?}` —— 单仓库级拉黑 |
| GET/POST | `/api/settings` | 采集参数（预算/翻页/间隔…）：读当前值+默认值+范围；POST `{collector:{...}}` 保存 |
| GET | `/api/resonance` | 生态共鸣清单（管理副本优先）+ 每个基座的**锚定条件** + 每个子项的归属证据 + 是否在当前图里、画了几条边 |
| POST | `/api/resonance/base` | `{action:"add"\|"update"\|"remove"\|"reset", id, label?, tag?, enabled?}` |
| POST | `/api/resonance/child` | `{action:"add"\|"remove", baseId, childId}` |
| POST | `/api/resonance` | 旧写法 `{baseId, enabled}`，仍然可用（落到同一份管理副本） |

日志与作业：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/logs` | 可读日志清单（应用变更日志 / 采集器日志 / 审计日志） |
| GET | `/api/log?name=` | 只读日志尾部（最多最后 512KB / 2000 行），白名单之外一律 404 |
| GET/POST | `/api/apply` | 查应用作业 / 触发一次离线重建 |
| GET | `/api/audit?limit=` | 审计日志 |

## 四项能力落在哪、怎么生效

| 能力 | 写在哪 | 生效方式 |
|---|---|---|
| **噪声黑名单** | `data/noise-blacklist.json`（外壳 `owners/count/note`，人工条目 `reason:"manual"`） | 点「应用变更」→ 离线重建，采集管道与前端契约同时剔除。加人时后台会先算**影响预估**：该作者在累积索引里有几个仓库、点应用后会少几个；**一个都没有就直说"他当前不在数据里，加名单不会有可见变化"** |
| **白名单标签 + 别名组** | `data/admin/config.json` 的 `whitelistTags` 与 `whitelistAliases` | JS 工具（categories / relevance / seed-sample）与 Python 采集器**读同一份**；改的是**抓取口径**，必须等下一轮真实采集。别名组只影响**匹配**，不影响抓取（见下） |
| **生态共鸣清单 + 锚定条件** | `data/admin/ecosystem.json`（后台管理副本，可增删改查） | 点「应用变更」→ 离线重建时由 `build.load_ecosystem()` 读取；重跑 `tools/curate-ecosystem.mjs` 时也会**按后台改过的锚定条件**重新发现子节点 |
| **状态 / 数据 / 工作流** | 只读 | 直接读 `data/cache/status.json`、`data/last-crawl.json` 等 |

⚠️ **共鸣清单刻意不写 `tools/ecosystem.json`**：那份是策展产物。部署时 `tools/deploy-remote.sh` 会把整个 `tools/` 同步到线上，复跑 `tools/curate-ecosystem.mjs` 也会整体重写它。写进去迟早被覆盖。

后台读清单的顺序（Node 与 Python 同规则）：

1. `data/admin/ecosystem.json` **存在且结构可用 → 用它**（这是后台第一次编辑时自动创建的副本）；
2. 否则用 `tools/ecosystem.json`（策展产物，只读展示）。

所以：**不编辑就完全等同于以前的行为**。编辑之后，部署与策展复跑都动不了你的改动。想回到策展版本，点后台的「还原策展版本」（会用 `tools/ecosystem.json` 覆盖副本）。

### 别名组是什么、为什么不是"模糊匹配"

白名单标签默认是**精确命中**（仓库的 topics 里得完整写着这个标签）。可生态里同一个意思有好几种写法：`dsh`、`awesome-dsh`、`dsh-tui`……

直接把匹配改成"包含 dsh 就算"会撞上一个已经存在的判据：**挂了 ≥3 个 DSH 标签、正文又没有插件线索的仓库会被判成噪声**（`backend/dsh_mesh/build.py`）。用包含匹配时，一个仓库的 `dsh-plugin-desktop` 会同时命中 `dsh`、`dsh-plugin`、`dsh-plugin-desktop` 三个 → `matchedTags` 从 1 变 3 → **直接误杀**。而且任意正则能把常驻采集器拖死（回溯爆炸），项目早就有结论不开放。

所以走**显式登记**：在名单页的「别名组」里一行写一组：

```
dsh = awesome-dsh, dsh-awesome
dsh-plugin = dsh-plugin-x
```

- 左边是**规范标签**，必须已经在白名单里；不在白名单里的组会被**忽略**（否则等于凭空扩大抓取口径，而抓取层又抓不到它）。
- 右边是**别名**，匹配时把它归到左边的规范标签上：仓库只打了 `awesome-dsh`，也算 `dsh` 标签的仓库。
- **抓取层只抓规范标签**：GitHub 搜索只认精确 topic，拿别名去搜纯属白烧配额。
- 全组去重、每组最多 20 个、最多 50 组；别名必须满足标签字符规则（字母数字开头，含 `._-`）。

**默认不内置任何别名组** —— 每加一个标签就多一份抓取口径，由你自己按需填。

## 锚定条件（每个基座的四件套）

先说清楚两个词。**基座**：被插件依赖的那个主程序或框架。**锚定条件**：这个基座靠什么发现自己名下的插件。

后台可增删改查，改完写进管理副本：

| 条件 | 作用 | 例子 |
|---|---|---|
| `tag` 生态签 | GitHub topic，最硬的归属信号（可空） | `dsh-better-sidebar` |
| `probes` 探针词 | 在仓库名/描述里匹配，并去 GitHub 搜 README | `dsh-tui`、`dshskin` |
| `packages` 包名/标识 | README 复核时认哪些写法 | `@deepseek-harness-tui/dsh-tui`、`.dshskin` |
| `context` 语境规则 | README 提到它时，什么上下文才算"长在它上面" | 依赖/扩展、规范遵循、皮肤包格式（命名预设，**不开放任意正则**：任意正则等于把 ReDoS 请进门） |

- 每个**子项**的锚定证据（`signals` 归属信号、`readme` 复核词）也能在后台逐个改。
- `probes` / `packages` / `context` 在管理副本里用 **null 表示"没写过"**（界面展示内置值），**空数组表示"明确清空"**。两者分开，否则你永远删不掉内置条件。
- 内置出厂值在 [tools/ecosystem-bases.mjs](tools/ecosystem-bases.mjs)。后台的「恢复内置锚定条件」按钮就是取它。
- 改锚定条件只影响**下次重新策展怎么找子节点**。要让改动进图，得跑 `node tools/curate-ecosystem.mjs`；「应用变更」只重画现有清单的边。页面上的「锚定条件待重新策展」徽章就是在提示这件事。

## 「应用变更」到底做了什么

```
python3 backend/collect.py --from-store
```

- **不联网、不抓 GitHub**：用本机累积索引 `data/cache/repos.json` 重算 `data/mesh.json`；
- 结束前自动调用 `tools/precompute-layout.mjs`，刷新 `mesh-core.json / .bin / .head.bin` 与详情分片；
- 所以后台是**异步执行 + 轮询进度**，不会卡住页面。本机实测：2.8 万节点的数据，整轮约 **25~40 秒**（构建约 10 秒 + 预计算约 15 秒）。数据越大越久；
- 进度落在 `data/admin/job.json`，输出在 `data/admin/logs/apply-<时间>.log`，界面直接读它们的尾部。

## 安全边界（与公开站刻意分开）

- 后台响应一律 `Cache-Control: no-store` + `X-Robots-Tag: noindex`；
- 后台接口**不带** `Access-Control-Allow-Origin: *`（只服务同源页面）；
- 沿用公开站的安全头（CSP 限 `self`）→ 后台页面不能有内联脚本/样式，也不能引 CDN；
- 公开站不再提供任何采集进度接口。

## 日志（只读）

- 能看的只有三类：`data/admin/logs/apply-*.log`（应用变更）、`data/crawl.log`（采集器）、`data/admin/audit.log`（审计）；
- 接口只接受白名单里的相对路径名，**不接受任意路径**（路径穿越一律 404）；
- 单次最多回最后 512KB / 2000 行。`truncated:true` 表示"只给了尾巴"。不会把几百 MB 日志塞进浏览器；
- 页面里用弹窗查看（`Esc` / 点遮罩关闭），不下载、不执行任何内容。

## 备份、审计与回滚

- 每次覆盖 `config.json` / `noise-blacklist.json` 前会留一份 `.bak`（只留一份）；
- 审计一行一条 JSON：`data/admin/audit.log`（时间 / IP / 动作 / 详情，**不记口令**）；
- 回滚：把 `.bak` 拷回原名即可；名单也可以直接在后台改回去。

## 生产部署安全清单（照着勾）

- [ ] **必须走 HTTPS**：后台口令与会话 Cookie 在 http 上是明文。本地 `0.0.0.0:8788` 只用于内网自测，测完就关掉或绑回 `127.0.0.1`。
- [ ] 设 `ADMIN_COOKIE_SECURE=1`：即使代理漏发 `X-Forwarded-Proto`，会话 Cookie 也强制带 `Secure`（只在 https 下才发）。
- [ ] 确认代理发了 `X-Forwarded-Proto: https`；没发就靠上一条兜底。
- [ ] 挂在可信反代后面时设 `TRUST_PROXY=1`：限速与登录失败计数改按真实客户端 IP 分桶。
      **只在反代可信时设** —— 否则任何人伪造 `X-Forwarded-For` 就能绕过限速。
- [ ] 后台路径（`ADMIN_PATH`）与口令都不要外传。路径在 `.env` 里，用 `node tools/admin-setup.mjs --show` 查看。别贴进聊天、工单或截图。
- [ ] 有条件的再加一层：Cloudflare Access / 反代 Basic Auth / IP 白名单 —— 后台只有口令这一道锁。
- [ ] SSH 改用密钥：`.env` 里现在放着 `DSH_SSH_PASS`（部署机的 root 口令）。它一旦泄露，等于生产机失守。

## 常见问题

访问与登录：

| 现象 | 原因 / 处理 |
|---|---|
| 访问后台地址 403 | Host 头不在白名单（`ALLOW_HOSTS`）；或路径敲错，后台路径区分大小写 |
| 页面 503「后台页面还没就绪」 | `admin/` 前端资源缺失：确认部署时同步了 `admin/` 目录 |
| 登录一直 429 | 触发锁定，等 10 分钟；或换一个 IP。想立刻解锁：重启进程（会话与锁定都在内存） |
| 列表里看不到 `data/crawl.log` | 该文件只在采集器写日志时才存在；没有就是没有（不是权限问题） |
| 采集状态显示「可能没在运行」 | `data/cache/status.json` 超过 10 分钟没更新，检查 `dsh-mesh-collector` 进程 |

数据与变更：

| 现象 | 原因 / 处理 |
|---|---|
| 「应用变更」失败 | 看 `data/admin/logs/apply-*.log` 尾部；常见是缺 `data/cache/repos.json`（没跑过采集）或磁盘满 |
| 改了白名单标签但数据没变 | 预期行为：白名单是抓取口径，要等下一轮真实采集 |
| 改了共鸣清单但图上没变 | 回状态页点「应用变更」；页面顶部的 `pending.resonance` 提示就是干这个的 |
| 点「应用变更」报 409 | 采集器正在跑（同一份 mesh.json 不能被两边同时写）；状态页会显示它跑到哪一步，等这轮结束再点 |
| 改了锚定条件但没反应 | 预期行为：它只在重新策展时用来发现子节点，跑 `node tools/curate-ecosystem.mjs` 才生效 |
