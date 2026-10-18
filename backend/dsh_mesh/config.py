"""全局配置：捕获标签、路径、限流与构图常量。

约定：只用标准库（不引入需要全局安装的依赖）、不调用模型、凭据只从本机 .env 读取且绝不打印。
"""

from pathlib import Path

# 仓库根目录（backend/ 的上一级）
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
SAMPLE_RAW = DATA_DIR / "sample-raw.json"
MESH_JSON = DATA_DIR / "mesh.json"
SAMPLE_MESH = DATA_DIR / "sample-mesh.json" # JS 管线的冻结参照物（跨语言一致性校验用）
LAST_CRAWL = DATA_DIR / "last-crawl.json"
REPO_CACHE = CACHE_DIR / "repos.json"          # 累积索引（所有见过的仓库）
SEGMENT_STATE = CACHE_DIR / "segments.json"
README_CACHE = CACHE_DIR / "readmes.json.gz"    # README 检索摘要（gzip）
STATUS_FILE = CACHE_DIR / "status.json"         # 采集进度状态（前端"状态"圆环读它）
# 三个按天台账：星标环（周 star 榜）、更新日志（周更新榜）、逐日增量（star 趋势柱）。
STAR_HISTORY = CACHE_DIR / "star-history.json"
UPDATE_LOG = CACHE_DIR / "update-log.json"
RELEASES_CACHE = CACHE_DIR / "releases.json"     # 版本缓存（每仓库最近几个 release）
NPM_DOWNLOADS_CACHE = CACHE_DIR / "npm-downloads.json"  # npm 周下载量（可选列；不动 mesh.json）
NPM_SEARCH_CACHE = CACHE_DIR / "npm-search.json"        # npm 反查发现：包 → 仓库（可含子目录）；同样不动 mesh.json
NPM_PACKAGES_CACHE = CACHE_DIR / "npm-packages.json"    # 反查发现的子目录包 + 真实下载量（按包名做 key）
STAR_DAILY = CACHE_DIR / "star-daily.json"

# 按该时区的 00:00 切天，而不是 UTC 00:00（否则北京时间早 8 点才换天）；前端 tools/api.mjs 有同一常量。
DAY_TZ_OFFSET_HOURS = 8

# 逐日星标台账的两条判定线：相邻两轮相隔超过它就把增量转记 spans（跨天宽条），绝不塞进日柱
# 冒充单日（停机恢复会把几天涨幅写成"这一天涨了 N 星"）；本轮缺席的仓库基线保留 N 天，超期才丢弃。
STAR_OBS_GAP_HOURS = 26
STAR_SEEN_GRACE_DAYS = 3

DEFAULT_BUDGET = 120     # 每轮最多消耗多少次搜索请求
REFRESH_HOURS = 6.0      # 超过这个时长没刷新的段会重新排队
ENV_FILE = ROOT / ".env"

# 捕获标签的内置默认值：实际以 data/admin/config.json 的 whitelistTags 为准（见 admin_config.py），
# 后台未配置/为空/损坏才回退到这里；其它模块按常量名 import，不要改名。
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
REVIEW_THRESHOLD = 2  # 旧口径，已由 analyze_relevance 的三档结论取代，保留供参考

# 噪声黑名单：命中任一判据即视为批量刷标签的垃圾号（主判据：仓库数 > MIN_REPOS 且 0 星占比 >
# ZERO_RATIO，允许极少数仓库拿一两星；老判据：仓库数 > STRICT_MIN_REPOS 且全部 0 星）。
# 命中后从累积索引与扫描管道剔除（不再消耗配额），前端契约里也不再出现。
NOISE_OWNER_MIN_REPOS = 300          # 主判据：仓库数门槛（超过，不含等于）
NOISE_OWNER_ZERO_RATIO = 0.98        # 主判据：0 星占比门槛（超过，不含等于）
NOISE_OWNER_STRICT_MIN_REPOS = 200   # 老判据：仓库数门槛
NOISE_OWNER_MAX_STARS = 1            # 老判据：最高星标门槛
NOISE_BLACKLIST = DATA_DIR / "noise-blacklist.json"  # 已判定的噪声作者（人工可编辑）

FRONTEND_LIMIT = 0      # 0 = 不限；配合 gzip + 浏览器缓存，全量进前端也不卡
KEEP_SNAPSHOTS = 2
DEFAULT_INTERVAL = 3600

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
