# 分类评测（2026-11-07，规则 v3 本地）

## 目标

不靠感觉改规则：在**插件图**（当前 35,270 节点）上抽样、标注、评估规则变体，并持续收紧误收、补齐新主题。v3 在 v2.1 基础上处理「用量额度」歧义（dsh-ops 误收）、新增「效率优化」扇区，并补了一批细枝。

## 本轮改了什么（v3）

- **usage 改名「用量计费」**：只保留余额/额度/配额/用量统计/计费语义；「监控」移到工具扇区。细枝拆成 `usage-balance`（余额/充值）、`usage-quota`（配额/订阅/套餐/限流）、`usage-billing`（计费/峰谷/账单）、`usage-stat`（用量/热力图/token 计量）。
- **新增 efficiency「效率优化」**（303 节点 / 约 1.0 万★）：以「降低 token / 上下文 / 耗时」为目的，而不是记账。旗舰样本 `T-Auto/dsh-ops`（5,332★，原 usage-stat）、`ranxianglei/billion-context`（4,129★，上下文压缩）。细枝：`eff-token` Token 节省、`eff-context` 上下文压缩、`eff-tool` 工具结果优化、`eff-preset` 低耗预设。余额/账单类插件用 exclude 挡在 efficiency 外。
- **ops 不单开顶层**：审计显示运维长尾除 dsh-ops 外量级不足，改为 tools 下的 `tools-ops`「运维与自检」细枝（341 节点）：健康检查、巡检、备份恢复、守护/重启、日志监控；dsh-ops 本身归 efficiency/eff-tool。
- **notify 改名「通知提醒」**（原本叫「语音提醒」，但含大量通知/推送）；同时把 doc→「文档处理」、pet→「桌宠陪伴」、data→「数据与行情」、web→「浏览器与前端」。
- **跨扇区补词**：bridge 补 QQ/WeChat/机器人/消息通道（qqbot 544★、wechat 407★ 归 IM 渠道）、model 的「接入」降权、doc 补 Office（doc-office 220）、pet 补人设/酒馆/角色卡（pet-persona 194）。
- **新增细枝**：`session-jailbreak` 破甲越狱、`skin-splash` 开屏动画、`media-gen` 图像生成、`bridge-im` IM 渠道、`doc-locale` 本地化、`model-router` 模型路由、`agent-ptc` PTC 预设。
- **词典补齐**：破甲/jailbreak/prefill、开屏/开机动画/boot-animation、ComfyUI/生图/文生图、飞书/Lark/钉钉/Telegram、locale/语言包、model router/负载均衡、金融行情/指数（修营销大屏被 usage 收走）、悬浮球、TUI 等。
- **数据/指标**：`other` 4,963→4,344（14.1%→12.3%）；具体细枝覆盖 69.9%→72.9%；扇区 23→24；`maxSectors` 24→26。
- **种子标注人工复核**：v3 边界变化后，复核修正 2 条旧 AI 初判（`dsh-web-search-insights` web→tools、`dsh-plugin-overview` market→tools）；不是为迁就模型，而是这两条原标签与自述不符。

## 效果

| 指标 | v2.1 | v3 |
|---|---:|---:|
| 种子标注 top-1（59 条，v3 复核 2 条） | 91.5% | **91.5%** |
| 种子标注可接受率 | 100% | **100%** |
| 种子标注 macro-F1 | 0.873 | **0.874** |
| 插件图 `other` | 14.1%（4,963） | **11.8%**（4,176/35,270） |
| 具体细枝覆盖（不含「综合」） | 69.9% | **73.4%**（25,871/35,270） |
| 「综合」细枝 | 16.0% | **14.8%**（5,223） |
| 大扇区数 | 23 | **24** |
| efficiency | — | **302**（约 1.03 万★） |
| usage | 1,907 | **1,861** |

说明：

- `dsh-ops` 已从 `usage/usage-stat` 移到 `efficiency/eff-tool`；usage 的余额/计费主体不受影响（usage 仍 1,861 个）。
- efficiency 的上下文压缩与 session/memory 有边界：以「省钱/省 token 为卖点」的压缩插件归 efficiency，纯记忆体系仍归 memory。
- tools 因补入 search/ops 词表从 1,882→2,542；其中 `tools-search`、`tools-ops` 是新增的主力细枝。
- v3 的种子标注仍是 59 条 AI 初判 + 2 条人工复核，不能替代人工验收。

## 评测工具

```bash
# 生成标注表（分层抽样：每扇区 3~8 条 + other/低分补充）
node tools/classify-eval.mjs --sample 120 --out docs/classification-labels.csv

# 用标注表评估（label 填分类 id；不标填 skip）
node tools/classify-eval.mjs --labels docs/classification-labels.csv
```

标注列：`id,name,stars,current_category,current_sub,candidates,description,topics,label,acceptable`。

## 已生成文件

- [classification-labels.csv](classification-labels.csv)：120 行待标注样本（label 空）；
- [classification-labels-seed.csv](classification-labels-seed.csv)：59 行种子标注（AI 初判 + v3 复核 2 条）。

## 仍需注意

- 种子标注只有 59 条，不能替代人工验收；大改动前至少补到 200 条；
- efficiency 与 session-context / memory 的边界、tools-ops 与 dev 的边界仍有少量歧义；
- market/desktop 的残余边界（空描述真汇总、平台工具误入客户端）留给下一轮；
- `other` 已到 11.8%，继续降 `other` 应补高置信词/新扇区，而不是放宽置信门槛。

## 下一步

1. 人工补齐/校正 120~500 条 label；
2. 用更大标注集复跑，重点看 efficiency/ops、session/agent/model/panel 的边界；
3. 规则改动后跑全量 JS/Python 一致性与插件图重建（`node tools/build-plugin-graph.mjs`）。
