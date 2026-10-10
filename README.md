# 插件生态图

把带 `dsh` 系列 GitHub 标签的仓库，按功能铺成一张可交互的生态网络图：圆心固定为官方仓库 `deepseek-ai/deepseek-harness`，向外是 21 个功能扇区，扇区下再分细枝。数据由 Python 采集器每小时刷新一次。

[![在线访问](https://img.shields.io/badge/在线访问-104.129.51.126-2f7df6?style=flat-square)](http://104.129.51.126/)
[![测试](https://img.shields.io/badge/tests-207%20JS%20%2B%20109%20Python-3fb8a8?style=flat-square)](#测试与-ci)
[![依赖](https://img.shields.io/badge/dependencies-0-57b894?style=flat-square)](#技术选型)
[![版本](https://img.shields.io/badge/version-v0.5.1-9b8cf0?style=flat-square)]()

在线地址：<http://104.129.51.126/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="http://104.129.51.126/preview.svg?theme=dark">
  <source media="(prefers-color-scheme: light)" srcset="http://104.129.51.126/preview.svg?theme=light">
  <img alt="插件生态图预览：功能扇区与仓库球，圆心是官方仓库" src="http://104.129.51.126/preview.svg?theme=light" width="100%">
</picture>

> 预览图由站点实时渲染（`/preview.svg?theme=dark|light`），读 `data/mesh-core.json`，随采集更新。静态副本：[`docs/preview.svg`](docs/preview.svg)、[`docs/preview-light.svg`](docs/preview-light.svg)（`node tools/snapshot-svg.mjs --theme dark`）。

本项目是独立站点：静态前端 + Python 采集后端 + 同端口的只读查询 API，不依赖 DSH 运行时，也不是 DSH 插件。

## 功能

| 能力 | 说明 |
|---|---|
| 扇区布局 | 按功能分区、同心散布；坐标由可播种 PRNG 生成，同一 seed 逐点可复现 |
| 单扇区放大 | 点扇区 → 该扇区铺满整圆，圆内按细枝重新分区；`Esc` 或左栏「返回全景」退回 |
| 双击聚焦 | 双击任一仓库 → 以它为中心重建扇形图（圆心＝它，扇区＝它的关联仓库按当前划分依据分类）；双击官方仓库直接回全景 |
| 生态榜单 | 顶栏奖杯弹窗两个榜，各最多 50 行：**周更新热榜**（本周真实发过 release 的项目，按「本周版本数 → 最新版本日期 → 星标」排序；没有 releases 数据时退回 pushedAt 采样口径并标成 `≥N 次`）与 **周 star 热榜**（星标历史增量）。每行带版本胶囊、近 7 日趋势柱，排除归档与复刻 |
| 关联居中 | 右栏点关联仓库 → 选中并把镜头移过去；目标不在当前画面时，改以它为中心另建扇形图 |
| 三类连线 | 同作者（完整关系，不受度数上限影响）、主题共现（琥珀虚线）、生态共鸣（紫罗兰实线，基座 → 插件，有向） |
| 搜索 | 本地即时匹配仓库名 / 作者 / 描述 / topics；README 正文走 `GET /api/search`，只回命中 id。命中超过 100 个只高亮、不画线 |
| 筛选 | 标签「与」语义、语言、归档状态、作者仓库数区间（0~300 双滑块）、星标下限；筛选只淡化、位置不变 |
| 状态圆环 | 顶栏圆环 = 下一轮扫描倒计时；点开看采集阶段、分段、请求与配额 |
| 访问统计 | 同端口最小 API：访问数与同时在线；拿不到接口时整栏隐藏 |
| 移动端 | ≤900px 画布全屏、侧栏变底部抽屉且左右互斥、双指缩放、安全区适配 |
| 双主题 | 清爽（蓝白）/ 粉黛，各带明暗两套 |
| README 索引 | 采集器每轮补抓一批（`--readme-budget`，默认 150，星标高优先），只存 gzip 摘要供搜索正文用；`--readme-min-stars`（默认 1）跳过长尾，`--readme-budget 0` 关闭 |
| 头像 | 并发 6、按 URL 去重、球太小不发请求；URL 统一补 `s=64`，单张 1~8KB |
| 缓存 | Brotli + ETag/304 + IndexedDB 秒开 + 后台校验 |
| 二进制契约 | 首屏先拉 `data/mesh-core.bin` 主干分片（约 260KB）出图，整份（约 2.1MB）后台补齐；JSON 契约兜底 |

## 本地运行

零依赖，只需 Node ≥ 22（见 `package.json` 的 `engines`）与 Python 3：

```bash
git clone https://github.com/WTStarMark/dsh-plugin-mesh && cd dsh-plugin-mesh
python3 backend/collect.py --from-raw    # 用仓库里的样本离线算一份前端契约（零网络、不耗配额）
npm run serve:lan                        # http://<局域网IP>:8788/
npm test                                 # 207 项前端 + 109 项后端
npm run test:js                          # 只跑前端；npm run test:py 只跑后端
```

运行数据（`data/mesh.json`、`mesh-core.*`、`last-crawl.json`、`cache/`、`snapshots/`、`details/`）体积大且每小时都变，不入库，由部署机上的采集器生成。干净克隆先跑 `--from-raw`，就有一份可看可测的数据。

采集数据（需要 GitHub 令牌，见下一节）：

```bash
cp .env.example .env     # 填入 GITHUB_TOKEN=...
python3 backend/collect.py --once                  # 跑一轮
python3 backend/collect.py --loop --interval 3600  # 常驻，每小时一轮
python3 backend/collect.py --from-store            # 改了规则后离线重算契约（不联网、不耗配额）
```

两点注意：

- pm2 下必须用 `--loop`：pm2 会把 `--watch` 认成自己的文件监听开关。
- 改完分类或相关性规则要重启常驻采集器：规则表是进程启动时导入的，不重启的话下一个整点那轮会用旧规则覆盖契约。`pm2 restart dsh-mesh-collector` 之后它会立刻按新规则跑一轮。

## GitHub 令牌

采集器只读公开仓库的搜索接口，令牌不需要任何仓库权限，唯一作用是提高配额：

| 项 | 要求 |
|---|---|
| 类型 | Fine-grained personal access token（推荐）或 classic token |
| 权限 / scopes | 全都不勾（公开搜索不需要权限） |
| 仓库访问 | Public repositories（fine-grained 下选 "Public Repositories (read-only)"） |
| 有效期 | 90 天左右，到期换新 |
| 效果 | 搜索接口 30 次/分（匿名 10 次/分），core 5000 次/时 |

获取步骤：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token → Repository access 选 *Public repositories* → Permissions 全部留空 → 复制 `github_pat_...`。

放到项目根目录的 `.env`（已在 `.gitignore` 里）：

```
GITHUB_TOKEN=github_pat_xxxxxxxx
```

配置后用自检脚本确认（只打印配额数字，不打印令牌）：

```bash
python3 backend/check_token.py
# 期望：search 上限 30 / 判定: 令牌生效（30 次/分档）
```

## 数据管线

Python 标准库实现，零 pip 依赖、零模型调用：

```
GitHub 搜索 API
   └─ 分段扫描（segments.py）
        ├─ 抓取空间切成「标签 × 星标区间」的段
        ├─ 一段命中数 > 1000（接口上限）就按创建时间继续细分：年 → 季度 → 月 → 半月 → 日
        ├─ 每轮只刷新最久没动的一批（默认预算 120 次请求），先发现新仓库、后更新旧仓库
        ├─ 黑名单作者的仓库直接跳过（不消耗配额、不进索引）
        └─ 结果并入累积索引 data/cache/repos.json，跨轮次累加
   └─ 构建（build.py）
        ├─ 噪声黑名单判定与长期拉黑
        ├─ 无信号空壳不收录（只有名字命中 dsh、既无描述也无 topic）
        ├─ 功能分类（classify.py，与前端规则逐条对齐）
        ├─ 同作者 / 主题共现连线 + 生态共鸣连线（tools/ecosystem.json，人工策展）
        └─ 产出 data/mesh.json（前端契约）+ data/snapshots/<时间戳>.json + data/last-crawl.json
```

**收录口径**：只收「有信号」的仓库 —— 至少一个白名单 topic，或一句 ≥10 字的描述。只有名字带 dsh、既没描述也没 topic 的空壳（实测 5174 个）不入库，数量记在 `meta.noSignalSkipped`。

**标签与名字**：白名单标签为 `dsh`、`dsh-desktop`、`dsh-plugin`、`dsh-plugin-desktop`、`dsh-plugin-market`、`dsh-plugins`；名字里含 `dsh-` 的仓库也收（不少插件没打标签）。

**其余硬规矩**：

- 共鸣边是**有向**边（基座 → 插件）；主题共现、同作者、fork 是对等关系，按字母序归一化以便去重。两类边共用一个 `add_edge`，方向语义不能混。
- 缩水保护：某轮构建出的索引不足现有规模的 80% 时，拒绝覆盖前端数据与快照。
- 截断记账：连一天都超过 1000 条的段如实写进 `segments.json` 的 truncated 列表。
- 无变化不写快照；快照只留最近 2 份（`KEEP_SNAPSHOTS = 2`）。
- 每日界限是北京时间 00:00（`DAY_TZ_OFFSET_HOURS = 8`）：星标历史环、更新日志、逐日星标三份按天落盘的缓存都按它切天。
- 星标历史环（`cache/star-history.json`）每天一个点、留 8 天，周 star 榜取它与约 7 天前那个点的差；历史不足时接口如实返回实际窗口天数。
- 逐日星标（`cache/star-daily.json`）每轮把本轮星标变化累加进当天桶（首见只记基线，掉星记负），趋势柱用它，不跨天摊派。
- 更新日志（`cache/update-log.json`）每轮采样一次「pushedAt 是否前进」，按天累计；GitHub 只给最后一次推送时间，所以它是下界，界面按这个口径标注。
- 版本缓存（`cache/releases.json`）每仓库留最近 **200** 个 release（周榜按"窗口内版本数"排，留 20 会把高频项目截在 20）。版本日期按**北京时间切天**（与星标环 / 更新日志 / 榜单横轴同一条日界线 `DAY_TZ_OFFSET_HOURS=8`）—— 直接取 UTC 日会把北京 00:00~08:00 发的版本记到前一天。搜索接口不返回 releases，只能按仓库单抓（1 个仓库 = 1 次 core 配额，GitHub 单页上限 100，要 200 个版本得翻第二页——只有第一页就抓满 100 的仓库才会发第二次请求）。每轮预算见 `--releases-budget`（默认 300）。刷新优先级：抓过之后又推过 → 近 7 天发过版（最多放 6 小时）→ 冷仓库超过 3 天 → 从没抓过（保留 25% 预算），同一档内按「缓存里近 7 天的版本数」排 —— 高频发版的项目不会被压满 3 天。`per_page=20` 时平均约 320KB/仓库，带宽吃紧就调小 `--releases-budget`。
- 落盘用临时文件 + 原子替换，且先写仓库数据、后写队列状态。
- 噪声黑名单长期生效（`data/noise-blacklist.json`），删掉条目即解除；阈值在 `backend/dsh_mesh/config.py`。

## 分类算法

规则表在 `tools/categories.mjs` 与 `backend/dsh_mesh/classify.py`，两份逐条一致，由 `backend/verify_parity.py` 逐项校验。

| 机制 | 说明 |
|---|---|
| 信号 | 仓库名（权重 ×2）+ 描述 + 非白名单 topic；白名单标签本身不作为分类证据，否则会退化成按标签分组 |
| 词边界 | 英文词按词边界匹配（允许简单复数），中文按子串。修掉过裸子串误命中：`ui`←build、`cli`←client、`hub`←github、`store`←restore、`rag`←storage、`api`←rapid |
| 门槛 gate | 插件市场必须「名字本身就是汇总」（末段/首段是 market/store/registry/合集/导航…）或描述自述「收录/汇集」；给市场加按钮的插件不算 |
| 排除 exclude | 桌面客户端排除客户端插件（名字带 plugin/extension/skill/theme/插件/皮肤…，描述自述「本仓库是客户端」可救回）；桌宠娱乐排除自述是皮肤/主题/壁纸的仓库（`鲸鱼娘/小鲸鱼` 只说明角色长相，正文/名字/topic 里有 pet/桌宠/宠物/养成/live2d/mascot… 才算陪伴玩法） |
| 强命中 strong | 协议基座：生态规范、互操作协议、接口契约，以及侧边栏底座、皮肤框架这类基座；「基座自述」命中即直接胜出。样本再少也不并进「其他」（keepIds） |
| 细枝 | 每个扇区内按同一套规则挑 3~8 个细枝，共 79 条，用于单扇区放大 |
| 改名 | `data/cache/aliases.json`（旧名 → 现名）与 `githubId` 双保险：改名即就地挪键并记 `renamedFrom`，构图时按 `githubId` 兜底去重；存量数据用 `tools/dedupe-renames.mjs` 迁移 |
| 非插件排除 | 挂 dsh 标签但 DSH 是别的意思（如 DeepHash-pytorch 的 DSH = Deep Supervised Hashing）的仓库不入索引，判据是两份实现里的 `NOT_PLUGIN_PATTERNS` |
| 生态共鸣 | 人工策展的「基座 → 长在它上面的插件」（紫罗兰实线）：归属信号用生态签或名字自述，再逐仓抓 README 复核。清单 `tools/ecosystem.json`，策展工具可复跑；每个基座带 `enabled` 开关，置 false 只停共鸣边 |
| 三档判定 | 相关性给出 related / noise / manual + 一句话原因（JS 在 `tools/relevance.mjs`，Python 在 `build.py`） |
| re.ASCII | Python 的 `\b` 默认是 Unicode 语义（中文算 word char），必须加 `re.ASCII` 才与 JS 一致 |

## 安全

本项目只监听一个端口（线上 80），预览服务按最小暴露面加固：

- 路径白名单：只提供 `/`、`/index.html`、`/styles.css`、`/src/*.js`、`/data/mesh.json` 等前端必需文件；`backend/`、`tests/`、`docs/`、`data/cache/`、`.env` 一律 403
- 方法白名单：只允许 `GET` / `HEAD`，接口只认 `GET /api/stats` 与 `POST /api/ping`
- Host 白名单：只接受本机地址，挡掉 DNS rebinding 型伪造 Host
- 安全响应头：CSP（script/style/connect 限 self，图片只放行 GitHub 头像域）、`nosniff`、`no-referrer`、`CORP: same-origin`、`frame-ancestors 'none'`
- 统计接口防滥用：id 正则校验、请求体上限 1KB、每 IP 每分钟 60 次限流
- `tests/serve.test.mjs` 会真的把服务起起来逐条验证上述每一条

## 测试与 CI

```bash
npm test                 # 前端 207 项 + 后端 109 项
npm run test:js          # 前端：布局 / 连线 / 分类 / 细枝 / 相关性 / 生态共鸣 / 面板 / 双击聚焦 / 榜单 / 主题 / 噪声黑名单 / 服务加固 / 限流 / 冒烟
npm run test:py          # 后端：分类 / 分段扫描 / 快照 / 调度 / 采集顺序 / 噪声黑名单 / 三档判定 / 预计算容错 / 星标历史环 / 更新日志 / 版本采集 / 收录口径与共鸣边方向 / 抗网络抖动
npm run seed:fixture     # 用 data/sample-raw.json 离线生成夹具数据集（npm test 会自动调用；本机已有真实数据时自动跳过）
python3 backend/verify_parity.py   # 跨语言一致性（JS 管线 vs Python 采集器）
```

- 数据前提：`data/mesh.json` 等运行时产物不入库。干净克隆里 `npm test` 会先跑 `npm run seed:fixture`（走采集器 `--from-raw`，零网络），生成 593 个节点的夹具数据集。
- 按真实规模才成立的断言：数据集不够大或样本过期时，相关用例会显式跳过并写明原因（统一判断在 `tests/helpers/dataset.mjs`）。夹具上跳过的项，在采集器跑过一轮的机器上会真的执行。
- CI：`.github/workflows/ci.yml` 在每次 push 与 PR 上跑「语法自检 → 生成夹具 → `npm test`」，矩阵为 Node 22 × Python 3.9 / 3.12，与线上（Node 22.23 + Python 3.9）对齐；仓库无第三方依赖，CI 不装任何包。

## 部署（pm2 + 端口 80）

```bash
cd /opt/dsh-plugin-mesh
export PATH=/opt/dsh-runtime/node/bin:$PATH
HOST=0.0.0.0 PORT=80 pm2 start tools/serve.mjs --name dsh-plugin-mesh
pm2 start backend/collect.py --name dsh-mesh-collector --interpreter python3 -- --loop --interval 3600 --budget 600
pm2 save && pm2 startup systemd
```

`tools/deploy-remote.sh` 是配套的同步脚本：只同步代码（`data/`、`.env`、`.git` 不动），用远端自己的数据重算预计算产物并重启 pm2。

## 目录结构

```
index.html  styles.css            前端外壳与样式
src/
  app.js            应用装配：状态、筛选、动作、主题
  graph.js          Canvas 2D 渲染（扇区光锥 / 节点 / 连线 / 头像 / 标签）
  layout-sector.js  扇区散布布局（可播种、可复现）
  panels.js         左栏 / 右栏 / 悬浮提示
  mesh-data.js      数据层 + 预览图配色
  palettes.js       清爽 / 粉黛 × 明暗，共 4 套主题
  ranking.js        奖杯弹窗：周更新热榜 / 周 star 热榜
  links.js  rng.js  avatars.js  cache.js  stats.js  mesh-core-bin.js
tools/
  serve.mjs             加固版静态服务（白名单 + 统计 API）
  api.mjs               只读查询 API + 卡片 SVG（与前端同端口）
  precompute-layout.mjs 预计算：坐标 + 二进制契约（mesh-core.bin / .head.bin）
  categories.mjs        分类规则表（与 Python 逐条对齐）
  relevance.mjs         相关性三档判定（与 Python 逐条对齐）
  reclassify.mjs        就地重分类（不重新采集）
  curate-ecosystem.mjs  生态共鸣策展（产出 tools/ecosystem.json）
  dedupe-renames.mjs    存量改名去重迁移
  dsh-tokens.mjs        从本机 DSH 解析设计令牌（--dsw-*）
  preview-svg.mjs       预览渲染核心（站点 /preview.svg 与离线副本共用）
  snapshot-svg.mjs      README 预览图离线副本（--png 可生成核对图）
  seed-sample.mjs  seed-fixture.mjs  preview-ascii.mjs  deploy-remote.sh
backend/
  collect.py        采集入口（--once / --loop / --from-store / --from-raw / --budget / --releases-budget）
  dsh_mesh/         github / segments / classify / build / snapshot / releases / readmes / config
  verify_parity.py  跨语言一致性校验
  check_token.py    令牌自检（只打印配额数字）
  tests/            109 项测试（前端 207 项在根目录 tests/）
docs/               data-contract.md 与预览图
```

## 技术选型

- 前端零依赖、无构建：ES 模块 + Canvas 2D，`node:test` 单测；不引框架、不引 three.js
- 后端零 pip：只用 Python 标准库（urllib / json / unittest），`python3 backend/collect.py` 直接跑
- 不用模型分类：规则表可审计、可复跑、可手改，结果稳定且能 diff

## 查询 API

`http://104.129.51.126` 上，API 与前端共用同一个端口：不需要另外开服务、不需要密钥、不占额外端口。零依赖、只读、允许跨域（`Access-Control-Allow-Origin: *`），响应带 5 分钟公共缓存。

### 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api` | 端点清单（自描述） |
| GET | `/api/health` | 健康检查 + 数据概况（节点数、生成时间、README 索引规模） |
| GET | `/api/categories` | 扇区（功能分类）与细枝及各自数量 |
| GET | `/api/repos` | 检索仓库（过滤 / 排序 / 翻页），`q` 同时匹配 README 正文 |
| GET | `/api/search?q=&limit=` | 紧凑检索：只回命中 id 与计数（含 README 命中） |
| GET | `/api/status` | 采集进度：`nextRunAt`、阶段、分段与 README 进度、请求与配额；不缓存 |
| GET | `/api/ranking?days=7&limit=50&fields=all` | 榜单：周更新热榜（含 `updates`、`updatesSource`、`releases`）+ 周 star 热榜（含 `window.days`、`matched`）；两个榜都最多 50 行，响应含 `dataAgeHours` |
| GET | `/api/repos/:owner/:name` | 单个仓库详情 + 同作者 / 主题共现连线 |
| GET | `/api/card/:owner/:name.svg` | SVG 卡片 |
| GET | `/preview.svg`（同 `/api/preview.svg`） | 预览图：按当前数据实时渲染（`?theme=dark|light&size=&sample=`），ETag + 5 分钟缓存 |
| GET | `/card/:owner/:name` | 卡片分享页（预览 + 嵌入代码） |
| GET | `/api/stats` | 访问统计（只读） |
| POST | `/api/ping` | 上报一次访问（前端自动调用，唯一接受 POST 的接口） |

### 快速上手

```bash
BASE=http://104.129.51.126

curl -s "$BASE/api/repos?sort=stars&limit=5"              # 星标最高的 5 个仓库
curl -s "$BASE/api/repos?q=皮肤&limit=3&fields=all"        # 搜关键词（owner/name、描述、topics、命中标签）
curl -s "$BASE/api/search?q=sidebar&limit=500"            # 检索（含 README 正文），只回 id 与计数
curl -s "$BASE/api/repos?category=skin&sort=stars&limit=10"  # 某个扇区下的仓库
curl -s "$BASE/api/repos/WTStarMark/dsh-myskin"           # 单个仓库的完整档案
curl -s "$BASE/api/categories"                            # 扇区 + 细枝分布
curl -s "$BASE/api/ranking?limit=10" | jq '.boards.updated.items[] | {id, updates, pushedAt, releases: [.releases[].tag]}'
# 榜单每行字段：updates / updatesSource / pushedAt / stars / series（近 7 日趋势）/ releases / spans（跨天累计）
```

### 限流（所有 `/api` 共用）

- 令牌桶，按 IP：默认 90 令牌/分钟、每秒回填 1.5 个；可用 `RATE_LIMIT_MAX` / `RATE_LIMIT_REFILL` 调。
- 按接口权重扣：`/api/ranking` 记 5 个、卡片 SVG 记 4 个、`/api/repos` 与 `/api/categories` 记 2 个、其余 1 个。
- 每个响应都带 `X-RateLimit-Limit` / `Remaining` / `Reset` / `Cost`；超限返回 429 + `Retry-After`（秒）。
- 数据每小时才更新一次，响应本身有 5 分钟公共缓存，按 `Retry-After` 退避即可。
- 默认只信 socket 地址（`X-Forwarded-For` 可伪造）；挂了反向代理再设 `TRUST_PROXY=1`，并自行清洗该头。

### 检索参数（`/api/repos`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | 关键词，匹配 `owner/name`、描述、topics、命中标签（不区分大小写） |
| `category` | — | 扇区 id，如 `agent` / `skin` / `desktop` |
| `subcategory` | — | 细枝 id，如 `skin-theme` |
| `tag` | — | 采集标签：`dsh` / `dsh-plugin` / `dsh-desktop` / `dsh-plugin-desktop` / `dsh-plugin-market` / `dsh-plugins` |
| `language` | — | 主语言，如 `TypeScript` |
| `minStars` | `0` | 最低星标数 |
| `archived` | — | `hide` = 隐藏归档；`only` = 只看归档 |
| `sort` | `stars` | `stars` / `pushed` / `created` / `name` |
| `limit` | `20` | 每页条数，上限 100（超出自动夹到 100） |
| `offset` | `0` | 偏移量，用于翻页 |
| `fields` | 精简 | 传 `all` 返回完整字段（描述、topics、许可证、主页、创建/推送时间、归档与复核标记） |

### 响应示例

```json
{
  "query": { "q": "harness", "sort": "stars", "limit": 2, "offset": 0 },
  "total": 1981,
  "count": 2,
  "offset": 0,
  "limit": 2,
  "generatedAt": "2026-10-01T17:00:42Z",
  "items": [
    {
      "id": "deepseek-ai/deepseek-harness",
      "stars": 241610,
      "categoryLabel": "智能体技能",
      "subcategoryLabel": null,
      "language": "TypeScript",
      "description": "…"
    }
  ]
}
```

### 约定与错误码

- 只读：非 `GET`/`HEAD` 一律 405（仅 `/api/ping` 接受 `POST`）；`OPTIONS` 返回 204。
- 缓存：`Cache-Control: public, max-age=300`。
- 跨域：允许任意来源引用（公开只读数据）。
- 校验：仓库名按 GitHub 字符集做白名单校验，非法 400；未收录 404（卡片请求的 404 回一张占位图，不会裂图）。

| 状态码 | 含义 |
|---|---|
| 200 | 正常 |
| 204 | 预检通过（OPTIONS） |
| 400 | 仓库名不合法 |
| 404 | 未收录该仓库 |
| 405 | 使用了写方法 |
| 429 | 请求过于频繁 |

## SVG 卡片

任何被收录的仓库都有一张自包含 SVG 卡片：无脚本、无外部字体、无外部依赖，420×168，GitHub 仓库卡片风格（默认深色，`?theme=light` 出浅色）。卡面含仓库图标、`owner / name`、两行简介、语言色点、星标、复刻数、更新时间与所属扇区；点卡片背景去站点，点仓库名去 GitHub。

[![dsh-myskin 卡片示例（深色）](docs/card-example-dark.svg)](http://104.129.51.126/)

[![dsh-myskin 卡片示例（浅色）](docs/card-example.svg)](http://104.129.51.126/)

上面两张是仓库内的静态样本（按当前数据生成、随仓库版本化），点图去线上站点；真实卡片（每小时更新）见 <http://104.129.51.126/api/card/WTStarMark/dsh-myskin.svg>。

贴进 README：

```markdown
[![dsh-myskin](http://104.129.51.126/api/card/WTStarMark/dsh-myskin.svg)](http://104.129.51.126/)
```

贴进网页（用 `img` 嵌入时 SVG 内部链接不生效，所以去处也印在卡面上）：

```html
<a href="http://104.129.51.126/">
  <img src="http://104.129.51.126/api/card/WTStarMark/dsh-myskin.svg" alt="dsh-myskin" width="420" height="168">
</a>
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `theme` | `dark` | 传 `light` 出浅色版（SVG 读不到 prefers-color-scheme，需要显式指定） |
| `link` | `http://104.129.51.126/` | 点击去处，只接受 `http`/`https`（其他协议回落默认），保留完整路径 |

打开 `http://104.129.51.126/card/<owner>/<name>` 可实时预览两版并复制 Markdown / HTML 代码；换默认去处用环境变量 `SITE_URL=https://your-site.example pm2 restart dsh-plugin-mesh --update-env`。

## 许可

代码以 MIT 许可发布，见 [LICENSE](LICENSE)。数据来自 GitHub 公开搜索接口，版权归各仓库作者所有。
