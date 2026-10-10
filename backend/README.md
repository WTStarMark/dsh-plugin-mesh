# 采集后端（Python，纯标准库）

每小时更新一次生态快照。全程是脚本行为，不涉及模型调用。

| 约束 | 做法 |
|---|---|
| 不烧 token | 只有规则与 HTTP，没有模型调用；分类器是一张可审计、可复跑的打分表 |
| 不装依赖 | 只用标准库（`urllib` / `json` / `unittest`），不需要 pip、不碰全局环境 |
| 不漏数据 | 分段扫描：切成「标签 × 星标区间」的段，超 1000 条就按创建时间继续细分（年→季度→月），每小时刷新一批，跨轮次累加成完整索引 |
| 不打死配额 | 每轮有请求预算（`--budget`，默认 120），只刷新最久没动的一批；月粒度仍是叶子的段如实记入 truncated |
| 如实记账 | 覆盖不到的部分写进 `meta.note` 与 `last-crawl.json`，前端原样展示 |
| 可续跑 | 单轮失败不影响常驻任务；队列状态与仓库数据都走临时文件 + 原子替换 |

## 用法

```bash
python3 backend/collect.py --once                    # 跑一次（真实抓取）
python3 backend/collect.py --loop --interval 3600    # 常驻，每小时一轮（pm2 下必须用 --loop）
python3 backend/collect.py --from-store              # 改了规则后离线重算契约（不联网、不耗配额）
python3 backend/collect.py --from-raw --dry-run      # 用本地原始记录离线复算
python3 backend/collect.py --releases-budget 300     # 每轮顺带抓 300 个仓库的 releases（0 = 关闭）
```

> 常驻进程在启动时导入规则表：改完分类或相关性规则要重启，否则下一轮会用旧规则表覆盖契约。

## 产物

| 文件 | 内容 |
|---|---|
| `data/mesh.json` | 前端契约（默认收录全部索引到的仓库，`--frontend-limit` 可截断），与 JS 管线逐项一致 |
| `data/snapshots/<时间戳>.json` | 历史快照骨架（id / 星标 / 归档 / 分类），只保留最近 2 份 |
| `data/cache/segments.json` | 分段队列状态（可断点续跑） |
| `data/cache/repos.json` | 累积索引：所有见过的仓库，前端数据的唯一来源 |
| `data/cache/star-history.json` | 星标历史环：每天一个点（`id → stars`，同日重复跑会覆盖），只留 8 天。周 star 榜取它与约 7 天前那个点的差 |
| `data/cache/star-daily.json` | 逐日星标增量：每轮把本轮星标变化累加进当天桶（首见只记基线，掉星记负），只留 8 天，供趋势柱使用 |
| `data/cache/update-log.json` | 更新日志：每轮采样「pushedAt 是否前进」，按天累计次数（首次见到不计数），周更新热榜按它排序 |
| `data/cache/releases.json` | 版本缓存（同时是周更新热榜的判定依据），每仓库留最近 200 个版本（单页上限 100，抓满一页才翻第二页）。刷新优先级见 `dsh_mesh/releases.py`：抓过之后又推过 → 近 7 天发过版（最多放 6 小时）→ 冷仓库超过 3 天 → 从没抓过（保留 25% 预算） |
| `data/last-crawl.json` | 本轮溯源：时间、模式、请求数、重试、配额剩余、各标签总数、与上一份快照的差异 |

每日界限由 `config.DAY_TZ_OFFSET_HOURS = 8` 决定：星标环、更新日志、逐日星标三份按天落盘的缓存都按北京时间 00:00 切天（接口侧 `tools/api.mjs` 有同名常量，测试会断言两边一致）。

每轮结束会打印差异：新增多少、消失多少、新归档多少、星标涨幅最大的几个。

## 收录口径与两条容易混的语义

- 只收「有信号」的仓库：至少一个白名单 topic，或一句 ≥10 字的描述。只有名字里带 dsh、既没描述也没 topic 的空壳（实测 5174 个）不收录，数量记在 `meta.noSignalSkipped`（只计数，`excludedNotPlugin` 留给需要人工复核的「非 DSH 语境」）。
- 共鸣边是「基座 → 插件」的有向边；主题共现、同作者、fork 是对等关系，方向无意义。三类边共用一个 `add_edge`，所以它带 `directed` 开关：对等关系按字母序归一化（顺便去重），`resonance` 保留调用方给的方向。

## 与前端的关系

采集器产出的是同一份契约，前端不用改。`backend/verify_parity.py` 用 Python 复算 JS 的产物并逐项比对：

```bash
python3 backend/verify_parity.py
# JS  : 593 节点 / 1019 连线
# PY  : 593 节点 / 1019 连线
# 一致：节点集合、功能分类、连线集合逐项相同 ✅
```

## 覆盖率与令牌

- 未认证：搜索接口 10 次/分钟，单标签最多拿到 1000 条（实际更少）。
- 有令牌：30 次/分钟、5000 次/小时，配合星标分片可以覆盖全部 1.6 万+ 个仓库。

令牌只从项目根目录的 `.env` 读取（`GITHUB_TOKEN=...`），只读公开数据、不打印、不入库；获取步骤见根目录 `README.md`。

## 定时

- 部署时用 `--loop --interval 3600` 常驻（整点对齐；单轮失败只记状态，进程不退出）。
- 换成 cron 或 systemd timer 也可以，示例：

```cron
0 * * * * cd /path/to/dsh-plugin-mesh && /usr/bin/python3 backend/collect.py --once >> data/crawl.log 2>&1
```

## 测试

```bash
python3 backend/tests/test_collector.py    # 116 项：分类规则 / 跨语言一致性 / 构图 / 快照 diff / 限流重试 / 整点对齐
```
