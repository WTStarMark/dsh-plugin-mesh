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
README_CACHE = CACHE_DIR / "readmes.json.gz"    # README 检索摘要（gzip；供"搜索 README 内容"，约 10MB/1.9 万仓库）
STATUS_FILE = CACHE_DIR / "status.json"         # 采集进度状态（前端顶栏"状态"圆环/浮窗读它）
STAR_HISTORY = CACHE_DIR / "star-history.json"   # 星标历史环：每天一个"id → stars"点，前端「周 star 热榜」算真实增量用
UPDATE_LOG = CACHE_DIR / "update-log.json"       # 更新日志：每轮采样到的"推送推进"次数（按天计数），前端「周更新热榜」按它排序
RELEASES_CACHE = CACHE_DIR / "releases.json"     # 版本缓存：每个仓库最近几个 release（tag/名称/时间/预发布），榜单"版本列表"用
STAR_DAILY = CACHE_DIR / "star-daily.json"       # 逐日星标增量：每轮把本轮变化累加进当天桶，star 榜的逐日趋势柱用它

# 每日界限：按该时区（UTC 偏移小时数）的 00:00 切天，而不是 UTC 00:00（= 北京时间 08:00）。
# 星标环 / 更新日志 / 逐日星标三个"按天"的落盘都用它；前端接口里有一份同样的常量（tools/api.mjs）。
DAY_TZ_OFFSET_HOURS = 8
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
REVIEW_THRESHOLD = 2  # 旧口径（相关度 <= 它 => 待复核）已由 analyze_relevance 的三档结论取代，保留供参考

# 噪声黑名单：命中任一判据即视为批量刷标签的垃圾号 ——
#   1) 主判据：收录仓库数【超过】NOISE_OWNER_MIN_REPOS，且 0 星仓库占比【超过】NOISE_OWNER_ZERO_RATIO
#      （按一个人发布 300+ 个仓库、几乎全都无人关注来判断；允许极少数仓库拿到一两颗星）
#   2) 老判据：收录仓库数【超过】NOISE_OWNER_STRICT_MIN_REPOS，且每个仓库都是 0 星
# 命中后：
#   1) 从累积索引与后续扫描管道里剔除（不再消耗请求配额）；
#   2) 前端契约（mesh.json / mesh-core.json）里不再出现。
NOISE_OWNER_MIN_REPOS = 300          # 主判据：仓库数门槛（超过，不含等于）
NOISE_OWNER_ZERO_RATIO = 0.98        # 主判据：0 星占比门槛（超过，不含等于）
NOISE_OWNER_STRICT_MIN_REPOS = 200   # 老判据：仓库数门槛
NOISE_OWNER_MAX_STARS = 1            # 老判据：最高星标门槛
NOISE_BLACKLIST = DATA_DIR / "noise-blacklist.json"  # 已判定的噪声作者（人工可编辑）

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
