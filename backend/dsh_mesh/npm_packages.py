"""npm 子目录包：把「反查发现、但仓库根 package.json 认不出」的包补上真实下载量。

为什么单独一个文件：npm-downloads.json 是「仓库 → 一个包」的一对一结构（读仓库根的
package.json）；反查发现的包天然可能一个仓库多个，混进那张表会破坏它的 key 语义。
本文件按【包名】做 key，只收「反查发现 + 仓库确实在图里」的包 —— 图外的先不进来
（要不要为图外仓库建节点是另一码事，见方案讨论）。

状态口径与 npm-downloads 完全一致：ok / unknown（404，终态）/ error（可重试）；
取不到下载量绝不许写成 0。
"""

from __future__ import annotations

import calendar
import json
import os
import time
from pathlib import Path

REFRESH_HOURS = 24.0  # ok 的包一天刷一次
ERROR_RETRY_HOURS = 72.0  # error 的包隔三天再试，避免永久卡死
DEFAULT_BUDGET = 200  # 每轮最多查多少个包（每个 = 1 次 npm 请求，不占 GitHub 配额）


def empty_payload() -> dict:
    return {"updatedAt": None, "count": 0, "packages": {}}


def _ts(iso) -> float | None:
    try:
        return float(calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S")))
    except (ValueError, TypeError):
        return None


def _age_hours(iso, now_ts: float) -> float:
    ts = _ts(iso)
    return 1e9 if ts is None else (now_ts - ts) / 3600.0


def load(path) -> dict:
    """读缓存；文件缺失/损坏一律当空表（绝不因为一个缓存文件中断采集）。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty_payload()
    if not isinstance(data, dict) or not isinstance(data.get("packages"), dict):
        return empty_payload()
    packages = {}
    for name, rec in data["packages"].items():
        if isinstance(rec, dict):
            packages[str(name)] = rec
    return {"updatedAt": data.get("updatedAt"), "count": len(packages), "packages": packages}


def save(payload: dict, path) -> int:
    """原子写（临时文件 + replace），返回写入字节数。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = dict(payload)
    out["count"] = len(out.get("packages") or {})
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return len(text)


def due_for_refresh(entry: dict, now_ts: float, refresh_hours: float = REFRESH_HOURS, error_retry_hours: float = ERROR_RETRY_HOURS) -> bool:
    """这个包该不该重新查：ok 超窗口才刷；error 隔久再试；unknown（npm 确认 404）不再试。"""
    if not isinstance(entry, dict):
        return True
    status = entry.get("status")
    age = _age_hours(entry.get("at"), now_ts)
    if status == "ok":
        return age >= refresh_hours
    if status == "unknown":
        return False
    return age >= error_retry_hours


def pick_candidates(
    payload: dict,
    search_payload: dict,
    downloads_payload: dict,
    nodes,
    *,
    limit: int,
    now_ts: float | None = None,
    refresh_hours: float = REFRESH_HOURS,
) -> list[dict]:
    """挑这一轮该查下载量的子目录包。

    过滤顺序（每条都要能说清"为什么没进"）：
      1) 仓库根 package.json 已经认到的包（npm-downloads）不再重复查；
      2) 仓库必须在图里（按 repoKey 小写比对节点 id）；
      3) 已 ok 且没过期的不查；error 到期才重试；unknown 不重试。
    排序：星标多的仓库优先（先让大项目被看见），同星标按包名。
    """
    now_ts = now_ts if now_ts is not None else time.time()
    by_key = {}
    for node in nodes or []:
        node_id = str(node.get("id") or "")
        if not node_id or node.get("archived"):
            continue
        by_key[node_id.lower()] = node
    covered = set()
    for entry in (downloads_payload.get("repos") or {}).values():
        pkg = (entry or {}).get("package") if isinstance(entry, dict) else None
        if isinstance(pkg, str) and pkg:
            covered.add(pkg.lower())

    stored = payload.get("packages") or {}
    out = []
    for name, rec in (search_payload.get("packages") or {}).items():
        pkg = str(name or "")
        if not pkg or pkg.lower() in covered:
            continue
        repo_key = str((rec or {}).get("repoKey") or "")
        node = by_key.get(repo_key)
        if node is None:
            continue
        if not due_for_refresh(stored.get(pkg), now_ts, refresh_hours):
            continue
        out.append({"package": pkg, "repoId": node["id"], "repoKey": repo_key, "stars": int(node.get("stars") or 0)})
    out.sort(key=lambda item: (-item["stars"], item["package"]))
    return out[: max(0, int(limit))]
