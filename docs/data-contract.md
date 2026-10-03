# 前端数据契约（`data/mesh.json`）

前端只认这一份结构。将来后端采集器产出同样结构，前端一行都不用改。

```jsonc
{
  "meta": {
    "generatedAt": "ISO 时间",
    "kind": "sample-seed | full-crawl",   // 前端据此显示"取样/全量"提示
    "note": "必须写明数据局限",
    "source": "GitHub REST Search API",
    "sampleNodes": 593, "sampleEdges": 1006, "droppedEdges": 109,
    "hubThreshold": 8, "degreeCap": 14, "reviewedAsNoise": 120,
    // 噪声黑名单（v0.4.2）：同一作者被收录 > 200 个仓库且每个仓库星标都 < 1 => 判为垃圾账号。
    // 这类节点与它们的边不会出现在 nodes / edges 里；下面几个字段只是如实记账。
    "noiseBlacklist": { "spammer": { "repos": 1285, "maxStars": 0 } },
    "noiseBlacklistSize": 1, "noiseNodesRemoved": 1285, "noiseSkipped": 0,
    // 非 DSH 语境排除（v0.4.3）：挂着 dsh 标签但 DSH 是别的意思（深度哈希…），不进索引
    "excludedNotPlugin": { "owner/repo": "深度哈希类：这里的 DSH 是 Deep Supervised Hashing…" },
    "excludedNotPluginCount": 1,
    // 生态共鸣（v0.4.3）：人工策展的边数，清单在 tools/ecosystem.json
    "resonanceEdges": 24, "ecosystemBases": ["omdsh-dev/DSH-better-sidebar"],
    "queries": [ { "id", "q", "page", "sort", "totalCount", "fetched", "rateRemaining" } ],
    "errors": []
  },
  "tags":    [ { "id": "dsh-plugin", "sampleCount": 556, "apiTotal": 16981 } ],
  "hubs":    [ { "topic": "deepseek-harness", "count": 306 } ],
  "clusters":[ { "id": "desktop", "label": "桌面客户端", "count": 132 } ],   // = 功能扇区（v0.2 起，不再等于标签）
  "nodes":   [ Node ],
  "edges":   [ Edge ]
}
```

## Node

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `owner/name`，全局唯一，前端的主键 |
| `name` / `owner` / `ownerType` | string | ownerType 为 `User` / `Organization` |
| `avatar` / `htmlUrl` / `homepage` | string \| null | 外链与头像 |
| `stars` / `forks` / `openIssues` | number | 星标决定节点半径（对数） |
| `createdAt` / `pushedAt` | ISO string | 用于时间过滤 |
| `language` / `license` | string \| null | 语言与许可 |
| `archived` / `fork` | boolean | 归档与 fork 标记 |
| `description` | string | 仅用于展示，前端一律 textContent 写入（不拼 HTML） |
| `topics` | string[] | 仓库真实主题数组 |
| `matchedTags` | string[] | **白名单里精确命中的标签**，至少 1 个 |
| `relevance` / `noise` | number | 相关度评分（0~8）与噪声分（`1 - relevance/5`，仅展示用） |
| `verdict` | `"related" \| "noise" \| "manual"` | **三档相关性结论**（v0.4.2）：确认相关 / 确认噪声（可一键隐藏）/ 仍需人工复核 |
| `reason` | string | 上面那条结论的一句话原因，面板直接展示 |
| `review` | boolean | 等价于 `verdict === "manual"`，保留给老前端 |
| `primaryTag` | string | 最具体的命中标签（仅用于筛选与展示，**不再决定颜色与扇区**） |
| `category` | string | **功能分类 id**（扇区归属），由 `tools/categories.mjs` 规则判定 |
| `categoryLabel` | string | 功能分类中文名，如「皮肤美化」 |
| `categoryScore` | number | 分类得分（可解释性） |
| `categoryHits` | string[] | 命中的规则词，如 `["skin","皮肤"]` |
| `categoryRaw` | string? | 被长尾合并前的原始分类（仅当被并入「其他」时存在） |
| `relevance` | number | 相关度评分（当前为占位启发式） |
| `noise` / `review` | number / boolean | 疑似噪声分与"是否进待复核队列" |
| `degree` | number | 度数（用于标签显示优先级） |

## Edge

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` / `target` | string | 必须是已存在的 `node.id`，且不得自环 |
| `type` | `"topic" \| "owner" \| "fork" \| "resonance"` | 主题共现 / 同作者 / fork 血缘 / **生态共鸣**（人工策展：基座 → 长在它上面的插件，见 `tools/ecosystem.json`） |
| `weight` | number > 0 | 共现次数或权重，决定线宽与粗细 |
| `via` | string[] | 产生这条边的中间实体（主题名或作者名），用于"为什么它们连着" |

## 硬性不变式（`tests/data.test.mjs` 强制校验）

1. `node.id` 唯一；`stars` 必须是有限数。
2. 每条边的两端都必须存在于 `nodes` 中，且 `source !== target`。
3. `matchedTags` 里的每个标签都必须真的出现在该节点的 `topics` 里（**精确命中**，不靠搜索接口的模糊结果）。
4. 每个节点都必须有 `category` 与 `categoryLabel`；扇区计数之和 = 节点总数。
5. **功能分类不得退化为标签分组**：同一个 GitHub 标签必须横跨多个扇区（`tests/data.test.mjs` 强制校验）。
5. `meta.kind === "sample-seed"` 时必须带 `note` 与 `queries`（取样数据必须自带局限说明）。
