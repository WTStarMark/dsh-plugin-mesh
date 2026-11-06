# 分类评测（2026-11-06 本地）

## 目标

不靠感觉改规则：在**插件图**（当前 35,270 节点）上抽样、标注、评估规则变体；本轮已经把验证有效的改动落进分类器。

## 本轮改了什么

- 新增两个大扇区：**media 媒体内容**（图像/视频/音频/音乐/绘图/CAD，当前 624 个节点）、**data 数据工具**（表格/数据库/分析/行情，当前 127 个节点）；
- 补充既有扇区词表：panel 的 settings/button/menu/HUD，tools 的 retry/restart/explorer，model 的 reasoning/thinking/effort/route，usage 的 token/gauge/wallet，file 的 explorer/picker，skin 的 background；
- 落地**细枝提父级**：父级 0 分、细枝得分 ≥3 且名字命中时，用细枝父扇区兜底；
- 子分类覆盖：父级已确认但细枝证据不足时归入「综合」；
- 扇区上限 20 → 24；JS `tools/categories.mjs` 与 Python `backend/dsh_mesh/classify.py` 同步。

## 效果

| 指标 | 优化前 | 优化后 |
|---|---:|---:|
| 种子标注 top-1（59 条 AI 初判） | 83.1% | **86.4%** |
| 种子标注可接受率 | 93.2% | **98.3%** |
| 种子标注 macro-F1 | 0.813 | **0.835** |
| 插件图 `other` | 14.8% | **11.1%** |
| 插件图子分类覆盖 | 77.0% | **88.8%** |
| 大扇区数 | 21 | **23** |

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
- [classification-labels-seed.csv](classification-labels-seed.csv)：59 行种子标注（AI 初判，人工复核用）。

## 仍需注意

- 种子标注只有 59 条，不能替代人工验收；大改动前至少补到 200 条；
- 新增 media/data 的边界仍有少量歧义（例如 `dsh-token-chart` 被 data 抢走，按 usage 更合理）；
- 根 package 没有 dsh 的仓库仍有很多不是插件，分类准确不等于收录准确。

## 下一步

1. 人工补齐/校正 120~500 条 label；
2. 用更大标注集复跑，重点看 media/data 与 panel/usage 的边界；
3. 若稳定，再把规则同步进后端并由采集器重建；本轮已同步 Python 并重建本地数据。
