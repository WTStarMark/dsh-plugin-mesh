"""管理后台共享配置（data/admin/config.json）的读取层。
后台由 tools/serve.mjs 在同一端口提供，会往该文件写白名单标签与生态共鸣基座启停；
采集器每轮读它，后台改动立刻生效。铁律：本模块所有读取函数【绝不抛异常】—— 文件缺失、
JSON 损坏、顶层类型不对、没有读权限一律退回默认值，后台写坏配置不能让采集器停摆。
依赖方向：本模块可 import config；config 不允许 import 本模块（会循环导入）。
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .config import DATA_DIR, ROOT, WHITELIST_TAGS

ADMIN_DIR = DATA_DIR / "admin"
CONFIG_FILE = ADMIN_DIR / "config.json"
# 生态共鸣清单：后台管理副本（可编辑）与策展产物（curate-ecosystem.mjs 生成）
MANAGED_ECOSYSTEM_FILE = ADMIN_DIR / "ecosystem.json"
ECOSYSTEM_FILE = ROOT / "tools" / "ecosystem.json"

# 默认配置：文件缺失/损坏/类型不对时返回它的深拷贝；resonance.overrides 为空表示按策展清单走。
DEFAULT_CONFIG: dict = {
    "version": 1,
    "updatedAt": None,
    "whitelistTags": list(WHITELIST_TAGS),
    "resonance": {"overrides": {}},
}


def default_config() -> dict:
    """默认配置的深拷贝：调用方随便改都不会污染模块级常量。"""
    return copy.deepcopy(DEFAULT_CONFIG)


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
    merged = default_config()
    merged.update(data)
    return merged


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
