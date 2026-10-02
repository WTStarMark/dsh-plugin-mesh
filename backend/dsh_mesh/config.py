"""全局配置：捕获标签、路径、限流与构图常量。

设计原则（沿用前端项目的一贯约定）：
  - 只用 Python 标准库，不引入第三方依赖，避免全局安装；
  - 采集是脚本行为，不涉及任何模型调用；
  - 凭据只从本机 .env 读取，绝不打印。
"""

from pathlib import Path

# 仓库根目录（backend/ 的上一级）
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
SAMPLE_RAW = DATA_DIR / "sample-raw.json"
MESH_JSON = DATA_DIR / "mesh.json"          # 由采集器每小时更新
SAMPLE_MESH = DATA_DIR / "sample-mesh.json" # JS 管线的冻结参照物（跨语言一致性校验用）
LAST_CRAWL = DATA_DIR / "last-crawl.json"
REPO_CACHE = CACHE_DIR / "repos.json"          # 累积索引（所有见过的仓库）
SEGMENT_STATE = CACHE_DIR / "segments.json"     # 分段扫描队列状态
DEFAULT_BUDGET = 120     # 每轮最多消耗多少次搜索请求
REFRESH_HOURS = 6.0      # 超过这个时长没刷新的段会重新排队
ENV_FILE = ROOT / ".env"

# 捕获标签：精确命中这些 topic 的仓库才纳入索引
WHITELIST_TAGS = [
    "dsh-plugin-desktop",
    "dsh-desktop",
    "dsh-plugin-market",
    "dsh-plugins",
    "dsh-plugin",
    "dsh",
]

# 圆心：官方仓库
HUB_ID = "deepseek-ai/deepseek-harness"

# 构图常量（与前端 tools/seed-sample.mjs 保持一致）
HUB_DF = 8            # 主题出现次数超过它 => 只展示不连线，避免毛线球
DEGREE_CAP = 14       # 只裁剪"主题共现"边；"同作者"是硬关系，不裁剪
OWNER_CLIQUE_MAX = 8  # 同作者成员不超过它就两两相连，超过则用星形拓扑
REVIEW_THRESHOLD = 2  # 相关度评分 <= 它 => 进入待复核队列

# 快照
FRONTEND_LIMIT = 0      # 0 = 不限：所有索引到的仓库都进前端（配合 gzip + 浏览器缓存，避免卡顿）
KEEP_SNAPSHOTS = 2      # 只保留最近 2 份快照
DEFAULT_INTERVAL = 3600  # 每小时一次

# 搜索 API 分片：GitHub 单个查询最多返回 1000 条，按星标区间切片才能覆盖全量
STAR_SLICES = [
    "stars:>=5000",
    "stars:2000..4999",
    "stars:1000..1999",
    "stars:500..999",
    "stars:200..499",
    "stars:100..199",
    "stars:50..99",
    "stars:10..49",
    "stars:1..9",
    "stars:0",
]

USER_AGENT = "dsh-plugin-mesh-collector/0.1 (+local script, no AI)"
API_ROOT = "https://api.github.com"
