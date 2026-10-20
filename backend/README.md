# 采集后端（Python，纯标准库）

这是一个每小时跑一次的脚本。它从 GitHub 抓仓库，算好前端要的 `data/mesh.json`。全程只用规则和 HTTP，不调模型，不需要 pip。

| 约束 | 做法 |
|---|---|
| 不烧 token | 只有规则与 HTTP，没有模型调用；分类器是一张可审计、可复跑的打分表 |
| 不装依赖 | 只用标准库（`urllib` / `json` / `unittest`），不碰全局环境 |
| 不漏数据 | 分段扫描：切成「标签 × 星标区间」的段，超 1000 条就按创建时间继续细分（年→季度→月），每轮刷新一批，跨轮次累加成完整索引 |
| 不打死配额 | 每轮有请求预算（`--budget`，默认 120），只刷新最久没动的一批 |
| 如实记账 | 覆盖不到的部分写进 `meta.note` 与 `last-crawl.json`，前端原样展示 |
| 可续跑 | 单轮失败不影响常驻任务；仓库数据与队列状态都走临时文件 + 原子替换 |

## 用法

```bash
python3 backend/collect.py --once                    # 跑一次（真实抓取；不加参数也是这个行为）
python3 backend/collect.py --loop --interval 3600    # 常驻，每小时一轮（pm2 下必须用 --loop）
python3 backend/collect.py --from-store              # 改了规则后离线重算契约（不联网、不耗配额）
python3 backend/collect.py --from-raw --dry-run      # 用本地原始记录离线复算，不写盘
python3 backend/collect.py --releases-budget 0       # 本轮不抓 releases
```

常用参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--loop`（等价 `--watch`） | 关 | 常驻，按 `--interval` 周期执行；pm2 下必须用 `--loop` |
| `--interval` | `3600` | 常驻模式的周期秒数 |
| `--budget` | `120` | 每轮最多消耗多少次搜索请求（0 = 不限） |
| `--from-store` | 关 | 用累积索引 `data/cache/repos.json` 离线重建，不联网 |
| `--from-raw` | 关 | 用 `data/sample-raw.json` 离线复算，不联网 |
| `--tags` | 内置白名单 | 覆盖抓取标签（默认读后台副本 `data/admin/config.json`） |
| `--dry-run` | 关 | 只算不写 |

其余参数：`--readme-budget`（默认 150，0 = 关闭 README 摘要）、`--readme-min-stars`（默认 1，跳过 0 星长尾）、`--readme-max-chars`（默认 2000）、`--releases-budget`（默认 300，0 = 关闭版本采集）、`--frontend-limit`（默认 0 = 不限）、`--min-ratio`（默认 0.8，缩水保护）、`--quiet`。完整清单跑 `python3 backend/collect.py --help`。

> 常驻进程在启动时导入规则表。改完分类或相关性规则要重启，否则下一轮会用旧规则把契约覆盖回去。

## 产物

契约与索引：

| 文件 | 内容 |
|---|---|
| `data/mesh.json` | 前端契约。默认收录全部索引到的仓库，`--frontend-limit` 可截断 |
| `data/snapshots/<时间戳>.json` | 历史快照骨架（id / 星标 / 归档 / 分类），只留最近 2 份 |
| `data/cache/repos.json` | 累积索引：所有见过的仓库，前端数据的唯一来源 |
| `data/cache/segments.json` | 分段扫描队列状态（可断点续跑） |

按轮 / 按天的缓存：

| 文件 | 内容 |
|---|---|
| `data/cache/readmes.json.gz` | README 检索摘要（gzip，供搜索正文用） |
| `data/cache/star-history.json` | 星标历史环：每天一个点，只留 8 天。周 star 榜取它与约 7 天前那个点的差 |
| `data/cache/star-daily.json` | 逐日星标增量：每轮把本轮变化累加进当天桶（首见只记基线，掉星记负），趋势柱用它 |
| `data/cache/update-log.json` | 更新日志：每轮采样「pushedAt 是否前进」，按天累计（首次见到不计数） |
| `data/cache/releases.json` | 版本缓存：每仓库最近 200 个版本（单页上限 100，抓满一页才翻第二页） |
| `data/cache/status.json` | 采集进度状态（后台状态页读它） |
| `data/last-crawl.json` | 本轮溯源：时间、模式、请求数、重试、配额剩余、各标签总数、与上一份快照的差异 |
| `data/noise-blacklist.json` | 噪声作者黑名单，人工可直接编辑 |

每日界限由 `config.DAY_TZ_OFFSET_HOURS = 8` 决定：星标环、逐日星标、更新日志、版本日期都按北京时间 00:00 切天（接口侧 `tools/api.mjs` 有同名常量，测试会断言两边一致）。

每轮结束会打印差异：新增多少、消失多少、新归档多少、星标涨幅最大的几个。

## 配置从哪来

| 配置 | 来源 | 兜底 |
|---|---|---|
| 抓取标签（白名单） | `data/admin/config.json` 的 `whitelistTags`（后台管理副本） | 内置 `WHITELIST_TAGS`；命令行 `--tags` 优先级最高 |
| 生态共鸣清单 | `data/admin/ecosystem.json`（后台管理副本） | `tools/ecosystem.json`（策展产物） |
| 噪声作者黑名单 | `data/noise-blacklist.json` | 文件不存在当空表 |
| GitHub 令牌 | 项目根目录 `.env` 的 `GITHUB_TOKEN` | 匿名模式（配额更低） |

黑名单落盘时会先重读磁盘再合并：后台在采集期间加的人工条目不会被本轮结果冲掉。

## 收录口径与两条容易混的语义

- 只收「有信号」的仓库：至少一个白名单 topic，或一句 ≥10 字的描述。只有名字里带 dsh、既没描述也没 topic 的空壳不收录，数量记在 `meta.noSignalSkipped`（只计数；`excludedNotPlugin` 留给需要人工复核的「非 DSH 语境」）。
- 共鸣边是「基座 → 插件」的有向边；主题共现、同作者、fork 是对等关系，方向无意义。三类边共用一个 `add_edge`，它带 `directed` 开关：对等关系按字母序归一化（顺便去重），`resonance` 保留调用方给的方向。

## 与前端的关系

采集器产出的就是前端要的契约，前端不用改。`backend/verify_parity.py` 用 Python 复算 JS 的产物并逐项比对：

```bash
python3 backend/verify_parity.py
# JS  : 593 节点 / 1019 连线
# PY  : 593 节点 / 1019 连线
# 一致：节点集合、功能分类、连线集合逐项相同 ✅
```

## 覆盖率与令牌

- 未认证：搜索接口 10 次/分钟，单标签最多拿到 1000 条（实际更少）。
- 有令牌：30 次/分钟、5000 次/小时，配合星标分片可以覆盖全部收录到的仓库（本机实测索引 2.8 万+ 个）。
- 令牌只从项目根目录的 `.env` 读取（`GITHUB_TOKEN=...`），只读公开数据、不打印、不入库。获取步骤见根目录 [README.md](../README.md)。

## 定时

- 部署时用 `--loop --interval 3600` 常驻（整点对齐；单轮失败只记状态，进程不退出）。
- 换成 cron 或 systemd timer 也可以，示例：

```cron
0 * * * * cd /path/to/dsh-plugin-mesh && /usr/bin/python3 backend/collect.py --once >> data/crawl.log 2>&1
```

## 测试

```bash
python3 backend/tests/test_collector.py    # 165 项：分类规则 / 跨语言一致性 / 构图 / 快照 diff / 限流重试 / 整点对齐
```
