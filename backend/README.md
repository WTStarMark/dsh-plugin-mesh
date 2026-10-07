# 采集后端（Python，纯标准库）

每小时更新一次生态快照。**全程是脚本行为，不涉及任何模型调用** —— 不需要为"抓数据"烧 token。

## 为什么这么设计

| 约束 | 做法 |
|---|---|
| 不烧 token | 只有规则与 HTTP，没有模型调用；分类器是打分表，可审计可复跑 |
| 不装依赖 | 只用标准库（`urllib` / `json` / `unittest`），不需要 pip、不碰全局环境 |
| 不漏数据 | **分段扫描**：切成「标签 × 星标区间」的段，超 1000 条就按创建时间继续细分（年→季度→月），每小时刷新一批，跨轮次累加成完整索引 |
| 不打死配额 | 每轮有请求预算（`--budget`，默认 120），只刷新最久没动的一批；月粒度仍是叶子的段如实记入 truncated |
| 不骗人 | 覆盖不到就写进 `meta.note` 与 `last-crawl.json`，前端会原样展示 |
| 可续跑 | 单轮失败不影响常驻任务；快照保留最近 48 份（约两天）可回溯 |

## 用法

```bash
python3 backend/collect.py --once                    # 跑一次（真实抓取）
python3 backend/collect.py --loop --interval 3600    # 常驻，每小时一轮（pm2 下必须用 --loop，见上）
python3 backend/collect.py --from-raw --dry-run      # 用本地原始记录离线复算，零网络请求
python3 backend/collect.py --no-slice --max-pages 3  # 未认证时的保守配置
python3 backend/collect.py --releases-budget 300    # 每轮顺带抓 300 个仓库的 releases（0 = 关闭）
python3 backend/collect.py                           # 有令牌时的全量配置（默认：按星标分片，每片最多 10 页）
```

## 产物

| 文件 | 内容 |
|---|---|
| `data/mesh.json` | 前端契约（默认全部索引到的仓库；`--frontend-limit` 可截断），与 JS 管线**逐项一致** |
| `data/snapshots/<时间戳>.json` | 历史快照骨架（id / 星标 / 归档 / 分类），**只保留最近 2 份** |
| `data/cache/segments.json` | 分段队列状态（可断点续跑） |
| `data/cache/repos.json` | 累积索引：所有见过的仓库，前端数据的唯一来源 |
| `data/cache/star-history.json` | **星标历史环**：每天一个点（`id → stars`，同一天重复跑会覆盖），只留 8 天。前端「周 star 热榜」= 最近点与约 7 天前那个点的差 —— 快照只留 2 份，攒不出周窗口，所以单独存这一份 |
| `data/cache/update-log.json` | **更新日志**：每轮采样"pushedAt 又前进了吗"，按天累计次数（首次见到不计数）。前端「周更新热榜」按它排序 —— GitHub 只给最后一次推送时间，一周更新几次只能靠这样观测 |
| `data/cache/releases.json` | **版本缓存**：每个仓库最近 5 个 release（tag/名称/发布日期/是否预发布，约 560B/仓库）。搜索接口不返回 releases，只能按仓库单独抓（1 个仓库 = 1 次 core 配额），每轮预算见 `--releases-budget`（默认 300） |
| `data/last-crawl.json` | 本次溯源：时间、模式、请求数、重试、配额剩余、各标签总数、与上一份快照的差异 |

每轮结束会打印差异：新增多少、消失多少、新归档多少、星标涨幅最大的几个。

### 收录口径与两条容易搞混的语义（v0.5.0）

- **只收"有信号"的仓库**：至少一个白名单 topic，**或**一句像样的描述（≥10 字）。
  只有名字里带 dsh、既没描述也没 topic 的空壳（实测 5174 个）不收录 —— 分类器无从下手（谈不上归错类），
  画进图里也只是噪点：会把「其他」扇区从 2370 撑到 7510，把布局严重重叠从 0.9% 顶到 9%。
  剔除数量记在 `meta.noSignalSkipped`（只计数、不逐个记 id：`excludedNotPlugin` 留给需要人工复核的"非 DSH 语境"）。
- **共鸣边是"基座 → 插件"的有向边**，其它三类（主题共现 / 同作者 / fork）是对等关系、方向无意义。
  两者共用一个 `add_edge`，所以它带 `directed` 开关：对等关系按字母序归一化（去重靠它），
  `resonance` 必须保留调用方给的方向 —— 修之前一律归一化，插件 id 字母序在基座前面时方向就被翻转。

## 与前端的关系

采集器产出的是**同一份契约**，前端一行都不用改。为了不让两边悄悄跑偏，
`backend/verify_parity.py` 会用 Python 复算 JS 的产物并逐项比对：

```bash
python3 backend/verify_parity.py
# JS  : 593 节点 / 1019 连线
# PY  : 593 节点 / 1019 连线
# 一致：节点集合、功能分类、连线集合逐项相同 ✅
```

这条校验已经抓到过真问题：JS 规则表里 `review` 重复了一次，导致 31 个仓库被过度归入"开发调试"。

## 覆盖率与令牌

- **未认证**：搜索接口 10 次/分钟，单标签最多拿到 1000 条（实际按页数限制更少）。
- **有令牌**：30 次/分钟、5000 次/小时，配合星标分片可以覆盖全部 1.6 万+ 个仓库。

令牌只从项目根目录的 `.env` 读取（`GITHUB_TOKEN=...`），**只读公开数据、不打印、不入库**。
获取步骤见根目录 `README.md`；`.gitignore` 已排除 `.env`。

## 定时

- 部署时用 `--loop --interval 3600` 常驻（整点对齐；单轮失败只记状态、不会让进程退出）。
- 想换成 cron 或 systemd timer 属于**系统级改动**，需明确同意后再动；示例（仅供参考）：

```cron
0 * * * * cd /path/to/dsh-plugin-mesh && /usr/bin/python3 backend/collect.py --once >> data/crawl.log 2>&1
```

## 测试

```bash
python3 backend/tests/test_collector.py    # 19 项：分类规则 / 跨语言一致性 / 构图 / 快照 diff / 限流重试 / 整点对齐
```
