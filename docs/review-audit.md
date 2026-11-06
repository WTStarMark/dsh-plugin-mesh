# 待复核仓库复核报告（2026-11-06）

## 结果概览

首轮扫描 47,487 个仓库：31,441 confirmed / 16,046 review。

复核后（根扫描重跑 + YAML 解析修正 + no-root tree 全量扫描）：

- confirmed：**34,338**
- review：**13,149**
- 插件图：**35,270 节点**（npm 9,158 + root manifest + monorepo tree + README + 基座）
- 严格市场：9,488 个 npm 包，不变。

## review 具体是什么情况

| 类型 | 首轮数量 | 说明 |
|---|---:|---|
| 根目录没有 package.json | 9,625 | monorepo 子包、非 JS 仓库、桌面壳等；不是“没有插件”，需要 tree 扫描找子目录 manifest |
| 根 package 没有 dsh 对象 | 4,938 | 多数是桌面客户端/应用（如 dsh-desktop、DeepSeekGUI），不是可安装 bundle |
| 根 package 有 dsh、缺 dsh.bundle | 1,171 | manifest 不完整或不是插件，不能安装 |
| YAML 锚点/别名误判 | 248 | 主要是注释里的 `*after` 被正则误判；已修正，247 个重新确认 |
| patch 文件不存在 | 42 | 声明了 patch 路径但默认分支没有该文件；可能是构建产物/分支问题 |

## 这次做的重新校验

1. **修正 YAML 误判**：`tools/plugin-verifier/lib/patch.mjs` 不再用正则一刀切拒绝锚点/别名；改为按 YAML 解析，并增加 10,000 节点上限防别名放大。注释里的 `*after` 也不再误杀。
2. **重扫 15,799 个 review**：根 package/patch 重新校验，除已修复的 247 个 YAML 外，只新增 1 个 confirmed，说明根目录层面的 review 基本稳定。
3. **新增 monorepo tree 扫描**：`tools/scan-manifests-tree.mjs` 对“根没有 package.json”的仓库读取 GitHub tree，找子目录 package.json + patch。
   - 抽样 389 个仓库：**115 confirmed（29.6%）**；
   - 典型：`yu-wenchao/dsh-opencode-free-models` → `plugin/...`；`Mrzhailiming/deepseek-pet` → `dsh-pet-plugin/`；`PPawnsir/task-board-plugin` → `packages/dsh-agent-board/`；
   - 因 API 配额约 5,000 次/小时，完整 9,600+ tree 扫描预计 2 小时以上；本轮扫描到 440 个后主动停止，保留结果。

## 结论

- 首轮 review 里，**YAML 误判是确定的假阴性**，已修复；
- **根目录没有 package.json 的仓库里确实有大量 monorepo 插件**，抽样确认率约 30%；
- 根 package 没有 dsh 的 4,938 个绝大多数是应用，不应强行标成插件；
- 剩余 review 不是“扫描失败”，而是“无法凭根 manifest 确认”；要进一步提高插件图覆盖，应继续 tree 扫描 no-root 仓库。

## 可继续执行的命令

```bash
# 继续 tree 扫描（token 用完删除）
node tools/scan-manifests-tree.mjs --concurrency 4 --token-file .tmp/github-token
node tools/build-plugin-graph.mjs --apply-market
```

## 当前 review 分布（15,683）

| 类型 | 数量 |
|---|---:|
| 根无 package.json，未 tree 扫描 | 9,179 |
| 根无 package.json，tree 扫描后仍未确认 | 274 |
| 根 package 无 dsh 对象 | 4,938 |
| 根 package 有 dsh、缺 dsh.bundle | 1,115 |
| patch 缺失 | 42 |
| YAML 解析异常 | 23 |
| 其他 | 112 |

根无 package 的 9,179 个是后续最值得继续 tree 扫描的部分；按 389 个抽样 29.6% 的确认率，预计还能补约 2,700 个插件。

## README 爬虫结果（并行，低压力）

- 爬取 6,162 个 review 且根 package 存在的仓库；并发 2、间隔 400ms；只读 raw README。
- 2,485 个 README 命中 `dsh.bundle` / `cordis.patch.yml` 等 manifest 标记：
  - 根 package 无 dsh 对象：1,541
  - 根 package 有 dsh、缺 dsh.bundle：883
  - 其他：61
- 输出：`data/cache/repo-readme-evidence.json`；候选清单：`.tmp/crawler-candidates.txt`（临时）。
- 这些候选会进入第二轮 tree 扫描；tree scanner 已支持 `--ids-file` 指定任意 review 仓库。

## 全量 no-root tree 扫描完成（2026-11-06）

- 扫描 9,235 个“根没有 package.json”的 review 仓库；
- 确认 **1,844** 个 monorepo 子包插件，7,391 个仍 review；
- 缓存累计：**33,648 confirmed / 13,839 review**；tree 扫描 7,238 个，其中 1,959 confirmed；
- 插件图更新为 **34,775 节点 / 32,523 连线**；市场仍 9,488 个 npm 包。
- 第二轮针对 README 爬虫候选的 tree 扫描正在进行（2,485 个根 package 候选）。

## README 候选第二轮 tree（已完成）

- 2,485 个根 package 候选全部扫完；
- **690 confirmed / 1,795 review**；
- 加上第一轮 no-root tree，tree 累计确认 1,959+690 个仓库（以缓存为准）；
- 当前缓存：34,338 confirmed / 13,149 review；插件图 35,270 节点。
