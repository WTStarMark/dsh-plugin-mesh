# DSH 插件安装前验证器（V0~V2）

> 状态：本地原型（2026-11-06）。只读 npm 元数据、tarball 与 patch 文件；**不安装 DSH、不运行 pnpm、不执行插件代码**。
> 本文是设计与边界说明，不是对外 API 文档。

## 1. 为什么需要它

现在“这个仓库/包算不算 DSH 插件”有两套不同口径：

- **生态图**：白名单标签/别名，或名字含 `dsh-`，再加“有信号”（topic 或 ≥10 字描述）。没有标准 manifest 检查。
- **市场索引**：候选来自仓库根 package.json 或 npm 反查子目录包；按 `dsh.bundle.patch`（确证）或 `@deepseek-ai/*` 依赖（疑似）判定；疑似也进市场。

官方“添加插件”只接受可安装的组合包（bundle）；没有 `dsh.bundle` 的包会被插件管理器拒绝（`not-bundle`）。因此需要一个**在安装前**执行、但不会执行插件代码的验证器。

## 2. 判定条件（V0~V2）

### V0：manifest 静态检查

包必须同时满足：

1. `package.json` 是合法 JSON；
2. `name` / `version` 存在；
3. `dsh` 是对象；`dsh.manifestVersion` 缺省或为 `1`；
4. `dsh.bundle` 是对象；
5. `dsh.bundle.patch` 是非空字符串或非空字符串数组；
6. 每个 patch 路径：相对路径、不逃出包根、不含反斜杠/绝对路径；
7. patch 文件存在且非空（目录模式检查文件；npm 模式检查 tarball 内容）；
8. `engines.dsh` 若存在，必须是合法 semver range，且与目标 DSH 版本兼容；
9. 市场模式：`private !== true`，且 `repository` 可解析到 GitHub owner/repo；
10. 不在黑名单/人工拒绝名单里（由后续集成层负责）。

`dsh.client` 单独存在不算插件；`dsh.profile` 是 profile 组合，不是插件判定依据。

### V1：tarball 内容检查

- 只下载 npm registry 上的 tarball（不安装）；
- 内存中解析 tar，不落盘；
- 拒绝绝对路径、`..`、符号链接/硬链接；
- 限制压缩后/解压后大小、条目数；
- 确认 `package.json` 与所有 patch 文件**真的在 tarball 里**（`files` 漏了 patch 的话，装上也加载不了）。

### V2：patch 语义检查

- 用 `js-yaml` 的 `JSON_SCHEMA` 解析（不认自定义 JS 标签，除非显式支持）；
- 官方常用 `!!js "表达式"` 做动态配置（如 `disabled: !!js "!ctx.get('profileContext')"`）：只解析成占位对象，**不执行**，并记 warning；
- 拒绝 YAML 锚点/别名（防别名炸弹）；
- 顶层必须是列表；空列表判“可安装但无效果” → **review**，不算确证；
- 至少有一个可识别条目：`insert` 数组里有 id+name/module/config/disabled，或对已有条目做 id + 修改；
- 没有有效条目 → review。

### 市场级（后续集成）

- npm 包必须存在；
- GitHub 仓库必须在插件图里；
- npm `repository` → 图中节点（大小写/改名/别名归一）；
- 仓库 manifest 包名 = npm 包名；monorepo `repository.directory` 必须存在；
- npm 发布者/溯源与仓库 owner 不一致 → review；
- 两边都通过才收录；`dsh-bundle-unconfirmed` 不进市场。

## 3. 为什么不安装 DSH

官方安装流程包含 pnpm 安装、install scripts、插件入口加载；任意包都可能借此执行代码。验证器只做声明性检查：

| 做法 | 执行第三方代码 | 主要风险 |
|---|---|---|
| 装 DSH + 启动 profile | 会 | RCE、供应链、权限逃逸 |
| 只跑 pnpm 安装 | install scripts | 构建脚本、依赖投毒 |
| **本验证器（V0~V2）** | **不会** | 解析器漏洞、压缩炸弹、DoS |

验证器需要防护的残余风险：

- tarball/JSON/YAML 解析器漏洞；
- 压缩炸弹、超大 JSON、YAML 别名炸弹；
- 路径穿越；
- 动态 `!!js` 表达式：只当字符串，不执行；
- 网络超时/大响应：限制域名、大小、超时；解析阶段不联网。

建议运行在独立 worker/子进程或一次性容器中，无密钥、只读、有限内存/CPU/时间。

## 4. 从官方逻辑提取了什么

| 官方位置 | 提取的判定 |
|---|---|
| `@deepseek-ai/dsh-package-manifest` | `DshPackageManifest` / `DshBundleManifest` 字段语义（`dsh.bundle.patch` 字符串/数组） |
| `@deepseek-ai/dsh-app-boot` | `bundlePatchFiles` 的 patch 声明语义；patch 文件解析/应用边界 |
| `@deepseek-ai/dsh-plugin-manager` | 无 `dsh.bundle` → `not-bundle`；安装前的 engines/peer 检查语义 |
| `@deepseek-ai/dsh-plugin-market` | `evaluatePluginCompatibility` 的兼容性口径 |

实现上**按规范重写**，不引入 DSH 运行时；官方包只用于对照测试。固定 DSH 版本（当前 `0.2.1-rc.5`），升级时重跑一致性测试。

## 5. 实现地图

```
tools/plugin-verifier/
  cli.mjs                 CLI
  lib/manifest.mjs        dsh 字段、patch 路径、repository、engines 校验
  lib/patch.mjs           受限 YAML 解析 + 条目有效性
  lib/tarball.mjs         限制大小的下载、gzip/tar 解析
  lib/npm.mjs             版本选择、tarball 获取
  lib/verify.mjs          V0~V2 编排与结果对象
  fixtures/               正反例
  test/                   node:test
```

独立 `package.json` 只用于验证器依赖（`js-yaml`、`semver`），不进入主项目运行时；主项目仍零依赖。

## 6. 用法

```bash
# 本地目录（夹具 / 已下载包）
node tools/plugin-verifier/cli.mjs --package-dir tools/plugin-verifier/fixtures/good

# npm 包（下载 tarball，不安装）
node tools/plugin-verifier/cli.mjs --package dsh-whale-widget --graph data/mesh.json --dsh-version 0.2.1-rc.5

# JSON 输出
node tools/plugin-verifier/cli.mjs --package dsh-market-plus --json
```

测试：

```bash
npm --prefix tools/plugin-verifier test
```

## 7. 结果对象

```jsonc
{
  "target": { "kind": "npm|dir", "label": "...", "name": "...", "version": "..." },
  "verdict": "confirmed | review | rejected",
  "level": "V0 | V1 | V2",
  "checks": [{ "id": "dsh-object", "ok": true, "detail": "..." }],
  "errors": ["..."],
  "reviews": ["..."],
  "warnings": ["..."],
  "manifest": { "name": "...", "repository": "owner/repo", "engines": {...}, "dsh": {...} },
  "patches": [{ "path": "cordis.patch.yml", "items": 1, "inserts": 1, "ok": true }],
  "graph": { "repoId": "owner/repo", "inGraph": true },
  "registry": { "version": "...", "tarballUrl": "...", "tarballBytes": 123 }
}
```

- `rejected`：明确不满足标准；市场/插件图不自动收；
- `review`：证据不足或无法安全验证（如 tarball 过大、patch 无有效条目、`!!js` 动态内容超出静态判断）；进人工/后续复核；
- `confirmed`：V0~V2 全过；市场还需 npm↔GitHub 互证。

**大 tarball**：当前上限 32MB（解压 64MB），超过直接 `review`，不自动确认；后续可改流式解析。

## 8. 当前影响面（本机同步数据，2026-11-06）

- 市场：10,304 个包 → 严格规则（确认 bundle + repo 在插件图）约 **9,488 个包 / 9,158 个唯一仓库**；
- 其中 403 个 `dsh-bundle-unconfirmed` 包（337 仓库）会被排除；
- 187 个无 GitHub 仓库地址、226 个 repo 不在图里的确认包也会被排除；
- 插件视图当前 **35,270 个节点**（24 个扇区）：npm 已确证 + 根 manifest 扫描 + monorepo tree 扫描 + README 证据 + 策划基座；分类 v3 后 `other` **11.8%**、具体细枝覆盖 **73.4%**（另有 14.8% 归「综合」），新增 `efficiency` 效率优化扇区；
- 分类规则已同步 JS/Python，详见 [classification-eval.md](classification-eval.md)。

## 9. 双模式与严格市场（本地已落地）

- 默认视图改为**插件图**：npm 已确证 `dsh.bundle` + 仓库 manifest 扫描确认 + README 明确提到 `dsh.bundle`/`cordis.patch.yml` 的未发 npm 仓库 + 官方主仓库 + 策展基座；顶栏按钮或 `?view=ecosystem` 可切完整生态图。节点带 `pluginEvidence`（`npm-bundle` / `manifest-scan` / `readme-manifest` / `curated`），放在详情分片里。
- 当前插件图 **35,270 节点**；`data/cache/repo-manifests.json` 已保存 47,487 个仓库的扫描结果（34,338 confirmed / 13,149 review），其中 no-root 9,235 个 + 第二轮 crawler 候选 2,485 个已完成 tree 扫描（第二轮确认 690 个）。
- 未确认仓库主要是根 package 无 dsh.bundle、monorepo 子包无有效 patch、patch 缺失/YAML 异常；不是“所有仓库都是插件”，但插件图已覆盖根 manifest 确认、monorepo tree 确认和 README 证据的插件。
- 产物：`data/plugins/mesh.json` 与独立预计算（`mesh-core.*` / `details`），不覆盖生态图产物。
- 构建：`node tools/build-plugin-graph.mjs --apply-market`。
- API 支持 `?scope=plugins`：categories / ranking / repos / search / 详情按插件图取数；默认仍是完整生态图。
- 严格市场：只保留 `dsh-bundle` + 仓库在插件图中；本机 10,304 → **9,488 个包**；原市场备份 `dist/market/index.ecosystem.json`。
- 验证器已可接入市场生成：
  ```bash
  node tools/verify-market.mjs --limit 20 --out dist/market/verification.sample.json
  node tools/build-plugin-graph.mjs --verification dist/market/verification.sample.json --allow-partial --apply-market
  ```
  `verify-market` 对每个包跑 V2（npm tarball + patch + npm↔GitHub 互证），输出验证报告；`build-plugin-graph --verification` 可按报告过滤市场。
- 采样 12 个严格市场包：12/12 confirmed（修复了 tarball 缺 repository 时用 registry/market 条目兜底）。
- 当前限制：完整 9,488 个包的 V2 全量验证耗时/流量大，尚未默认跑；大 tarball（>32MB）仍判 review。

## 10. 仓库 manifest 扫描（已实现）

- `tools/scan-manifests.mjs`：多并发读取仓库根 `package.json`（raw.githubusercontent，不占 API 配额），再读取它声明的 patch 文件并用受限 YAML 校验；不执行任何包代码。
- 结果写 `data/cache/repo-manifests.json`，格式：
  ```jsonc
  { "repos": { "owner/repo": { "verdict": "confirmed|review", "packages": [...], "errors": [...], "checkedAt": "..." } } }
  ```
- `tools/build-plugin-graph.mjs` 读取 confirmed 条目，标 `pluginEvidence=manifest-scan` 并加入插件图；市场仍只收 npm 包。
- 用法：
  ```bash
  node tools/scan-manifests.mjs --concurrency 16 --token-file .tmp/github-token
  node tools/build-plugin-graph.mjs --apply-market
  ```
- 第一遍只扫**根** package.json；monorepo/根没有 package.json 的仓库会进 review。
- 第二遍：`tools/scan-manifests-tree.mjs` 用 GitHub API tree 找子目录 `package.json`，再按同样规则校验；本轮抽样 389 个 no-root 仓库，115 个 confirmed（29.6%），完整扫描因 API 配额限制未跑完。
- 并行轻量爬虫：`tools/crawl-plugin-evidence.mjs` 只读 raw README，默认并发 2 + 400ms 间隔，把根 package 存在但缺 dsh 的 review 仓库按 README 证据分桶；不写 manifest 缓存，不确认插件。
- 复核细节见 [review-audit.md](review-audit.md)。
- 首轮结果（47,487 仓库）：**31,441 confirmed / 16,046 review / 0 failed**；review 原因：根无 package 9,625、根无 dsh.bundle 6,109、YAML 270、patch 缺失 42。
- 复核：修正 YAML 注释误判后 247 个重新 confirmed；根扫描重跑 15,799 个 review 仅新增 1 个 confirmed；monorepo tree 抽样 389 个 no-root 仓库，**115 confirmed**（29.6%）。当前缓存 **31,804 confirmed / 15,683 review**。详见 [review-audit.md](review-audit.md)。
- 扫描是增量的：已有缓存条目会跳过，`--force` 才重扫。

## 11. 非目标 / 后续

- 不做 pnpm 安装、不启动 DSH、不执行插件代码（V3/V4 至少当前不做）；
- 不替代采集器/市场生成器；集成顺序：验证器 → 市场严格化 → 插件图双模式 → 分类评测；
- 根扫描已完成；monorepo/无根 package 的 tree 扫描尚未做，下一步可只对 review 中带插件信号的仓库做 tree 扫描；
- 规则/DSH 版本升级时，用官方样本做一致性对照。
