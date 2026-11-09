# 市场「含界面 / Has UI」标签：证据口径与审计

> 2026-11-07 · 对应工具：`tools/market-ui-scan.mjs`（取证）、`tools/market-ui.mjs`（判定纯函数）、`tools/market-sync.mjs`（同步进索引）。
> 本文回答三个问题：为什么旧标签不可信、现在的证据是什么、这一轮审计发现了什么。

## 1. 问题

市场索引（`dist/market/index.json`，DSH 插件市场格式 format 1）里每个条目带 `metadata.labels`。
旧口径的 `has-client`（「带界面」）是**直接读 npm package.json 的 `dsh.client` 字段**：

- 那只是作者的声明，没看过发布包里到底有没有浏览器代码；
- 声明了却漏发文件、或把纯 API client 当客户端插件的包，也会被标成「带界面」；
- 反过来，浏览器入口文件名不叫 `client.js` 的包（`lib/theme-studio.web.js`、`dist/client.browser.js`、`plugin.client.js`……）会被旧的文件名启发式漏掉。

对用户来说「含界面」是**事实主张**，不是作者的自我描述。所以改成：只认可复现的发布包内容证据，扫不到就不标。

## 2. 判定口径

`uiEvidenceVerdict()` 的全部输入都来自 npm 已发布内容（见第 3 节），规则按优先级：

| # | 条件 | 结论 |
|---|---|---|
| 1 | 发布包文件清单里有前端资源：`.html/.htm/.css/.scss/.sass/.less/.styl/.vue/.svelte/.jsx/.tsx` | 含界面 |
| 2 | `dsh.client` 存在，且 `exports["./client"]` 指向的**运行时**入口文件真的在发布包里 | 含界面 |
| 3 | `dsh.client` 存在（`platform` 不是 `host`/`headless`），且发布包里有运行时客户端入口文件 | 含界面 |
| 4 | 扫过、但以上都不满足 | 不含界面（verified，不打标签） |
| 5 | 扫描失败/包不可获取 | 未验证（不打标签，不猜） |

排除项（避免把模板/类型/API client 当界面）：

- `.d.ts`、`.d.tsx`、`.map` 不是运行时资源；
- `vendor/node_modules/third_party/test/spec/docs/examples/fixtures/demo/skills/templates/previews/samples/benchmark` 等目录不算；
- `*-template.html`、`report-template.html`、`menu-preview.html` 这类模板/预览/报告文件名不算；
- `platform` 为 `host`/`headless` 的 `dsh.client` 没有浏览器半边，不算；
- 只有客户端路径文件、但**没有** `dsh.client` 自述的，不确认（API client 常这样命名）。

## 3. 证据从哪来

| 证据 | 主来源 | 兜底 |
|---|---|---|
| 发布包文件清单 | jsDelivr `/v1/package/npm/<name>@<ver>/flat` | unpkg `?meta` → npm tarball（`fetchTarball`，有大小上限） |
| package.json（`dsh.client`、`exports["./client"]`） | jsDelivr CDN `/<name>@<ver>/package.json` | unpkg `/package.json` |

- 只读 npm 元数据与文件清单，**不安装、不执行、不读 README**；
- 缓存键 `包名@版本`，可断点续跑（`--refresh` 强制重扫，`--retry-errors` 重试失败条目）；
- `data/cache/market-ui-evidence.json` 记录 `schema/status/updatedAt` 与每包证据；扫描未跑完（`status != complete`）时 `market-sync` 拒绝改线上索引，避免把未扫到的包误清标签。

## 4. 为什么以 `exports["./client"]` 为准

DSH 官方客户端插件包的注释写得很明确：浏览器半边「ships via `exports["./client"]`」，
由 package.json 的 `dsh.client` 声明后被宿主发现（例如 `@deepseek-ai/dsh-client-ui-settings` 等官方包）。
因此「真实检验」= 打开 npm 发布包，确认 `dsh.client` 声明的那个入口文件真的存在。

只按文件名猜会同时踩两个坑：

- **漏报**：`dsh-theme-studio` 的入口是 `lib/theme-studio.web.js`、`dsh-friends` 是 `dist/client.browser.js`、`dsh-treecom` 是 `plugin.client.js`；
- **误报**：`dsh-llm-dumate` 的 `dumate-client.js` 是 HTTP API 客户端，不是人机界面。

## 5. 怎么跑

```bash
# 1) 取证：扫描市场索引里的每个包（按 包名@版本 增量，失败可 --retry-errors）
node tools/market-ui-scan.mjs

# 2) 同步：把最新分类（mesh 分类 v3）与按证据重算的「含界面」写回索引
node tools/market-sync.mjs            # 同时刷新 index.json + .gz/.br + index.strict.json
node tools/market-sync.mjs --dry-run  # 只看统计，不落盘
```

全量重建（`tools/market-index.mjs`）也读同一份 v2 证据；没有证据或证据是旧格式时，本次构建**不输出** `has-client`，并在 stderr 提示先跑扫描。

## 6. 本轮审计快照

（见下方数据；同步前 = 旧口径 6,884 条「含界面」，同步后按证据重算。）

### 6.1 证据覆盖

| 项 | 数量 |
|---|---:|
| 市场条目 | 9,488 |
| 取到发布包文件清单 | 9,484（jsDelivr 9,469 / unpkg 15 / 无 4） |
| 证据完整（可判定） | 9,482 |
| 无法验证（不打标签） | 6（4 条索引版本已从 npm 下架；2 条版本号在 npm 不存在、latest 更旧） |
| 发布包里有前端资源文件 | 843 |
| `exports["./client"]` 入口文件真实存在 | 6,880 |
| 有运行时客户端文件但没有 `dsh.client` 自述 | 170（不计界面） |
| `dsh.client` 平台为 host/headless | 2（不计界面） |

### 6.2 标签结果

- 旧索引（2026-11-06，纯 `dsh.client` 声明口径）：**6,884** 条；
- 现在（发布包证据）：**6,925** 条（+55 / −14）；
- 构成：只有前端资源 54 条、只有 `exports["./client"]` 入口 6,079 条、两者都有 789 条、兜底（声明 + 运行时客户端文件）3 条。

**新增 55 条**：其中 54 条是旧口径完全漏掉的「包里有 HTML/CSS/TSX、但没声明 `dsh.client`」的皮肤/面板/网页类插件（旧口径只认声明，这类一个都进不来），另 1 条凭 `exports["./client"]` 入口。

**移除 14 条**（旧标签是声明推断出来的，按证据不成立）：

| 原因 | 数量 | 条目 |
|---|---:|---|
| 索引里的版本已从 npm 下架 / 不存在，无法取证 | 6 | dsh-fullscreen-settings、dsh-torrent-player、dsh-brain-hub、dsh-subagent-plus、dsh-agent-team-profile-manager、dsh-redteam-mode |
| 没有 `dsh.client` 声明 | 2 | @phillarmonic/dsh-llm-kimi、dsh-handoff-compaction |
| `dsh.client` 平台是 host/headless（没有浏览器半边） | 2 | dsh-matrix-connector、@ashtonsun/dsh-experimental-computer-use-linux-nde-mcp |
| 声明了 web client，但发布包里找不到入口/资源 | 3 | dsh-cue-bank、dsh-img、dsh-cron-scheduler |
| 只有 API client、不是人机界面 | 1 | dsh-llm-dumate（`dumate-client.js` 是 HTTP API 客户端） |

**和 v1 文件名启发式的关系**：v1 实验（只按文件名猜客户端入口）曾把 42 条声明包误删；v2 用 `exports["./client"]` + 真实文件清单恢复 30 条（例如 `dsh-theme-studio` 的 `lib/theme-studio.web.js`、`dsh-friends` 的 `dist/client.browser.js`、`dsh-treecom` 的 `plugin.client.js`，旧启发式都不认），其余 12 条保持不打标签；另有 2 条版本过期的条目从旧标签改为「未验证」。

### 6.3 内容级抽样复核

| 抽样组 | 数量 | 结果 |
|---|---:|---|
| `exports["./client"]` 入口 | 25 | 25/25 抓到真实客户端文件，且都含 React / DOM / `__ModuleLoader__` 等界面信号 |
| 前端资源文件 | 10 | 10/10 是真实 HTML/CSS/TSX（其中 6 个是 CSS/HTML，本来就没有 JS 信号，按口径算界面） |
| 兜底（声明 + 客户端文件） | 3 | 3/3 是真实 `client.js` 且含界面信号 |
| 未标「含界面」的 web 声明包 | 4 | 4/4 主入口均无界面信号（含 dumate 的 API client） |

### 6.4 分类同步（市场 ↔ mesh）

- 市场 9,488 条全部能按仓库映射到 mesh 节点；分类覆盖 **24 / 24** 扇区，与 mesh 分类 v3 一致；
- 分类不一致 **0** 条，`metadata.categories` 标题里的「· N」与条目数不一致 **0** 条；
- 本次复核分类变更为 0（12:28 已同步过 1,799 条，此轮未再变）。

### 6.5 产物与测试

- `index.json`：7,844,744 字节（紧凑 JSON 文本 7,508,595 字符）；gzip 1,630,548 / br 1,059,734 字节；gz/br 解压后与原文逐字节一致；`index.strict.json` 与 `index.json` 一致；
- `dist/market/build-stats.json` 新增 `uiEvidence: { version:2, verified:9482, failed:6, ui:6925 }`（后台可看证据来源）；
- 测试：**408 JS + 182 Python 全过**（含新增的证据判定/同步用例）。

### 6.6 残留问题 / 边界

- 6 条索引版本在 npm 已不存在（4 条整包下架、2 条版本号不存在且 latest 更旧）——这是市场索引的陈旧版本数据，需要重建索引（`tools/market-index.mjs`）才会更新；重建前它们按「未验证」处理，不打「含界面」；
- 判定只到「发布包里真的有入口/资源」，不执行插件代码、不验证运行时渲染；对入口存在但内容与 UI 无关的极端情况仍可能偏宽（本轮 25 条入口抽样未发现）；
- README / 描述 / topics 完全没参与判定，避免「作者自己说」再次变成事实；
- 扫描依赖 jsDelivr / unpkg 的可用性；两者都挂时回退 npm tarball（32MB 上限），失败按未验证处理。
