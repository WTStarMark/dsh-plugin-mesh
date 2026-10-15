"""管理后台共享配置（data/admin/config.json）的读取层。
后台由 tools/serve.mjs 在同一端口提供，会往该文件写白名单标签与生态共鸣基座启停；
采集器每轮读它，后台改动立刻生效。铁律：本模块所有读取函数【绝不抛异常】—— 文件缺失、
JSON 损坏、顶层类型不对、没有读权限一律退回默认值，后台写坏配置不能让采集器停摆。
依赖方向：本模块可 import config；config 不允许 import 本模块（会循环导入）。
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

from .config import DATA_DIR, ROOT, WHITELIST_TAGS

ADMIN_DIR = DATA_DIR / "admin"
CONFIG_FILE = ADMIN_DIR / "config.json"
# 生态共鸣清单：后台管理副本（可编辑）与策展产物（curate-ecosystem.mjs 生成）
MANAGED_ECOSYSTEM_FILE = ADMIN_DIR / "ecosystem.json"
ECOSYSTEM_FILE = ROOT / "tools" / "ecosystem.json"

# 采集参数（collector 块）的默认值与取值范围。tools/admin-config.mjs 的 DEFAULT_COLLECTOR /
# COLLECTOR_NUM 必须与本表逐键一致 —— 两侧各写一份，靠 backend/tests 与 tests/admin.test.mjs 对表盯住。
# 键名用 camelCase：它同时出现在 config.json 里，前端直接照着渲染，不做命名转换。
DEFAULT_COLLECTOR: dict = {
    "budget": 120,        # 每轮最多消耗多少次搜索请求（0 = 不限）
    "maxPages": 10,       # 每个分段最多翻几页（GitHub 搜索单查询硬上限 10）
    "refreshHours": 6,    # 超过这个时长没刷新的分段重新排队
    "readmeBudget": 150,  # 每轮抓多少篇 README
    "readmeMaxChars": 2000,
    "readmeMinStars": 1,
    "releasesBudget": 300,
    "npmBudget": 300,
    "interval": 3600,     # 常驻模式轮询间隔（秒）
    "minRatio": 0.8,      # 低于现有索引的这个比例时拒绝覆盖前端数据
    "frontendLimit": 0,   # 0 = 不限
}

_COLLECTOR_RANGE: dict = {
    "budget": ("int", 0, 100000),
    "maxPages": ("int", 1, 10),
    "refreshHours": ("float", 0.5, 720),
    "readmeBudget": ("int", 0, 100000),
    "readmeMaxChars": ("int", 200, 20000),
    "readmeMinStars": ("int", 0, 1000000),
    "releasesBudget": ("int", 0, 100000),
    "npmBudget": ("int", 0, 100000),
    "interval": ("int", 60, 86400),
    "minRatio": ("float", 0, 1),
    "frontendLimit": ("int", 0, 1000000),
}

# 默认配置：文件缺失/损坏/类型不对时返回它的深拷贝；resonance.overrides 为空表示按策展清单走。
DEFAULT_CONFIG: dict = {
    "version": 1,
    "updatedAt": None,
    "whitelistTags": list(WHITELIST_TAGS),
    "resonance": {"overrides": {}},
    "collector": dict(DEFAULT_COLLECTOR),
}


def _num(raw, spec):
    """按范围校验一个数值设置；字符串数字也认（JSON 里手写成 "600" 很常见），坏值返回 None。"""
    kind, low, high = spec
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            value: float = float(text)
        except ValueError:
            return None
    elif isinstance(raw, (int, float)):
        value = float(raw)
    else:
        return None
    if value != value or value in (float("inf"), float("-inf")):  # NaN / 无穷
        return None
    if kind == "int":
        if value != int(value):
            return None
        value = int(value)
    if value < low or value > high:
        return None
    return value


def normalize_collector(raw) -> dict:
    """采集参数规范化：逐键校验，坏键静默回退默认值（配置坏不能拖垮采集）。"""
    source = raw if isinstance(raw, dict) else {}
    out: dict = {}
    for key, spec in _COLLECTOR_RANGE.items():
        value = _num(source.get(key), spec)
        out[key] = DEFAULT_COLLECTOR[key] if value is None else value
    return out


def _deep_merge(base: dict, patch: dict) -> dict:
    """一层深合并：嵌套 dict（resonance / collector）也合，浅 merge 会把整块换掉。"""
    out = dict(base)
    for key, value in patch.items():
        current = out.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            out[key] = _deep_merge(current, value)
        else:
            out[key] = value
    return out


# 别名组上限（与 Node 侧 MAX_ALIAS_GROUPS / MAX_ALIASES_PER_GROUP 一致）
MAX_ALIAS_GROUPS = 50
MAX_ALIASES_PER_GROUP = 20


def whitelist_aliases(path=None) -> list[dict]:
    """后台配置的白名单别名组（已规范化）。"""
    return list(load_admin_config(path).get("whitelistAliases") or [])


def default_config() -> dict:
    """默认配置的深拷贝：调用方随便改都不会污染模块级常量。"""
    return copy.deepcopy(DEFAULT_CONFIG)


TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")


def normalize_aliases(raw, whitelist_tags=None) -> list[dict]:
    """规范化别名组 [{tag, aliases}]。与 Node tools/admin-config.mjs 的 normalizeAliases 同规则：
    tag 必须本身就在白名单里（否则等于凭空扩大抓取口径，而抓取层又抓不到它）。
    非法字符、重复、别名等于规范名、别名已在白名单里 —— 一律丢弃，绝不写进配置。
    """
    allowed = {str(t).strip() for t in (whitelist_tags or []) if str(t).strip()}
    out: list[dict] = []
    seen_tag: set = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag") or "").strip()
        if not TAG_RE.match(tag) or tag not in allowed or tag in seen_tag:
            continue
        aliases: list[str] = []
        seen_alias: set = set()
        for value in item.get("aliases") if isinstance(item.get("aliases"), list) else []:
            alias = str(value or "").strip()
            if not TAG_RE.match(alias) or alias == tag or alias in seen_alias or alias in allowed:
                continue
            seen_alias.add(alias)
            aliases.append(alias)
            if len(aliases) >= MAX_ALIASES_PER_GROUP:
                break
        if not aliases:
            continue
        seen_tag.add(tag)
        out.append({"tag": tag, "aliases": aliases})
        if len(out) >= MAX_ALIAS_GROUPS:
            break
    return out


def effective_tags(whitelist_tags, aliases) -> tuple[list[str], dict]:
    """匹配用的标签集合 = 白名单 + 展开出来的别名；以及 别名 -> 规范标签 的映射。
    抓取层【绝不】用它去搜 GitHub —— GitHub 只认精确 topic，拿别名去搜纯属白烧配额。
    """
    tags = [str(t).strip() for t in (whitelist_tags or []) if str(t).strip()]
    effective = list(tags)
    allowed = set(tags)
    alias_to_canon: dict[str, str] = {}
    for group in normalize_aliases(aliases, tags):
        for alias in group["aliases"]:
            alias_to_canon.setdefault(alias, group["tag"])
            if alias not in allowed:
                allowed.add(alias)
                effective.append(alias)
    return effective, alias_to_canon


def load_admin_config(path=None) -> dict:
    """读 data/admin/config.json；任何异常都退回默认值（深拷贝），绝不抛异常。
    顶层对象缺字段时用默认值补齐（后台只写一部分也能用）。"""
    target = Path(path) if path is not None else CONFIG_FILE
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 配置坏了也必须能采集，见模块 docstring
        return default_config()
    if not isinstance(data, dict):
        return default_config()
    merged = _deep_merge(default_config(), data)
    merged["collector"] = normalize_collector(merged.get("collector"))
    if not isinstance(merged.get("whitelistTags"), list):
        merged["whitelistTags"] = list(WHITELIST_TAGS)
    merged["whitelistAliases"] = normalize_aliases(merged.get("whitelistAliases"), merged["whitelistTags"])
    return merged


def _read_raw_config(path=None) -> dict:
    """读**原始**配置（不补默认值）。唯一的用途是分辨"用户真写过哪些键"：
    load_admin_config 会把缺的键全部补上，拿它判断"没写过"就永远判不出来。
    与 load_admin_config 同一条铁律：文件缺失/损坏/类型不对一律当空对象，绝不抛异常。
    """
    target = Path(path) if path is not None else CONFIG_FILE
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 见模块 docstring
        return {}
    return data if isinstance(data, dict) else {}


def _clean_tags(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        tag = item.strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
    return out


def whitelist_tags(path=None) -> list[str]:
    """后台配置的抓取标签；没有有效标签时回退内置 config.WHITELIST_TAGS。"""
    tags = _clean_tags(load_admin_config(path).get("whitelistTags"))
    if tags:
        return tags
    return _clean_tags(WHITELIST_TAGS)


def collector_config(path=None) -> dict:
    """后台配置的采集参数（已按范围校验、缺键补默认值）。"""
    return normalize_collector(_read_raw_config(path).get("collector"))


def configured_collector_keys(path=None) -> set:
    """用户在 config.json 里**真写过**的采集参数键（不是补默认值补出来的）。"""
    raw = _read_raw_config(path).get("collector")
    return set(raw) if isinstance(raw, dict) else set()


def ecosystem_path(curated=None) -> Path:
    """生态共鸣清单实际用哪一份（规则与 Node 侧 tools/admin-config.mjs 的 readEcosystem() 完全一致）。
    调用方显式指定别的文件就用它；否则后台管理副本 data/admin/ecosystem.json 存在且结构可用就用它；
    再否则退回策展产物 tools/ecosystem.json。管理副本放 data/ 下是为了活过两次覆盖：
    部署脚本会同步整个 tools/，策展工具复跑也会整体重写 tools/ecosystem.json。
    """
    curated_path = Path(curated) if curated is not None else ECOSYSTEM_FILE
    if curated is not None and curated_path != ECOSYSTEM_FILE:
        return curated_path
    try:
        if MANAGED_ECOSYSTEM_FILE.is_file():
            data = json.loads(MANAGED_ECOSYSTEM_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("bases"), list):
                return MANAGED_ECOSYSTEM_FILE
    except Exception:  # noqa: BLE001 - 管理副本坏掉就当没有，绝不拖垮采集
        pass
    return curated_path


def resonance_overrides(path=None) -> dict[str, bool]:
    """后台对生态共鸣基座的启停覆盖：{baseId: enabled}。
    契约是 {"owner/repo": {"enabled": false}}，值直接写布尔也认；键非空字符串、值有布尔 enabled 才采纳。"""
    config = load_admin_config(path)
    resonance = config.get("resonance")
    overrides = resonance.get("overrides") if isinstance(resonance, dict) else None
    if not isinstance(overrides, dict):
        return {}
    out: dict[str, bool] = {}
    for raw_id, raw_value in overrides.items():
        if not isinstance(raw_id, str):
            continue
        base_id = raw_id.strip()
        if not base_id:
            continue
        if isinstance(raw_value, dict):
            enabled = raw_value.get("enabled")
        elif isinstance(raw_value, bool):
            enabled = raw_value
        else:
            enabled = None
        if isinstance(enabled, bool):
            out[base_id] = enabled
    return out
