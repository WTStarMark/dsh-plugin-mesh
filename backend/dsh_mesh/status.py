"""采集进度状态：给前端顶栏的"状态"圆环与浮窗用。

采集器在几个关键点写一份小 JSON（data/status.json），站点 /api/status 读出来再加服务器时间。
写入是"合并式"的：每次只更新传入的字段，其余保留 —— 采集流程各处只关心自己那点进度，
不必在每处都拼一个全量对象。

典型内容：
    {
      "state": "crawling",                     # crawling / building / precomputing / idle / error
      "roundStartedAt": "2026-10-04T10:00:00Z",
      "roundSeconds": 3600,                    # 采集周期（倒计时的分母）
      "nextRunAt": "2026-10-04T11:00:00Z",      # 下一轮开始时间（前端据此倒计时）
      "phase": "segments",                     # segments / readme / build / precompute
      "segments": {"done": 282, "total": 313, "pending": 0, "thisRound": 15},
      "fetched": 339, "indexed": 19008, "added": 0,
      "requests": 750, "budget": 600, "quotaRemaining": 4200,
      "readme": {"indexed": 1200, "target": 9826, "thisRound": 150},
      "lastRound": {"startedAt": "...", "finishedAt": "...", "seconds": 123, "state": "ok", "added": 0},
      "updatedAt": "..."
    }
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import STATUS_FILE
from .segments import _atomic_write


def _iso(ts: float | None = None) -> str:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def read_status(path: Path | None = None) -> dict:
    path = Path(path or STATUS_FILE)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_status(path: Path | None = None, **fields) -> dict:
    """合并写入（读-改-写 + 原子替换）。fields 里值为 None 的键会被删掉。"""
    path = Path(path or STATUS_FILE)
    data = read_status(path)
    for key, value in fields.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    data["updatedAt"] = _iso()
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return data


def next_run_at(now: float, interval: int) -> str:
    """下一轮开始时间：与 collect.seconds_until_next 的口径一致（对齐到 interval 边界）。"""
    if interval <= 0:
        return _iso(now)
    return _iso(now + max(60.0, interval - (now % interval)))
