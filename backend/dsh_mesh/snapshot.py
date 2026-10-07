"""快照：写契约文件、写历史快照、算 diff、清理旧快照。

每小时一份快照，保留最近若干份；diff 回答"这一小时生态里发生了什么"。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from .config import DAY_TZ_OFFSET_HOURS, KEEP_SNAPSHOTS
from .build import utcnow


def day_of(at: str, offset_hours: int = DAY_TZ_OFFSET_HOURS) -> str:
    """把 UTC 时间戳换算成"哪一天" —— 按 offset_hours 时区的 00:00 切天。

    默认 UTC+8：北京时间 00:00 换日（原来按 UTC 切，等于北京时间早上 08:00 才换日，
    前半夜的数据会被算到前一天）。
    """
    text = str(at)
    try:
        stamp = datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return text[:10]
    return (stamp + timedelta(hours=offset_hours)).strftime("%Y-%m-%d")


def _write_json(path: Path, payload) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text)


def write_mesh(mesh: dict, path: Path) -> int:
    return _write_json(path, mesh)


def summarize(mesh: dict) -> dict:
    """快照只存"可比较的骨架"：id / 星标 / 归档 / 分类。"""
    return {
        "generatedAt": mesh["meta"].get("generatedAt"),
        "kind": mesh["meta"].get("kind"),
        "nodes": {n["id"]: {"stars": n["stars"], "archived": n["archived"], "category": n.get("category")} for n in mesh["nodes"]},
        "counts": {
            "nodes": len(mesh["nodes"]),
            "edges": len(mesh["edges"]),
            "indexed": mesh["meta"].get("indexedNodes"),
            "review": mesh["meta"].get("reviewedAsNoise"),
        },
    }


def has_changes(diff: dict, min_star_delta: int = 1) -> bool:
    """这一轮索引是否真的有变化 —— 没变化就不该重新生成快照。"""
    if diff.get("baseline"):
        return True
    if diff.get("addedCount") or diff.get("removedCount") or diff.get("archivedCount"):
        return True
    for item in diff.get("starGainers", []) + diff.get("starLosers", []):
        if abs(item.get("delta", 0)) >= min_star_delta:
            return True
    return False


def write_snapshot(mesh: dict, directory: Path, keep: int = KEEP_SNAPSHOTS, force: bool = False) -> tuple[Path | None, dict]:
    """写一份快照。索引与上一份完全一致时跳过，避免生成一堆没意义的快照。"""
    directory.mkdir(parents=True, exist_ok=True)
    previous = latest_snapshot(directory)
    current = summarize(mesh)
    diff = diff_snapshots(previous, current)
    if not force and not has_changes(diff):
        diff["skipped"] = True
        return None, diff
    stamp = (current["generatedAt"] or utcnow()).replace(":", "").replace("-", "")[:13]
    path = directory / f"{stamp}.json"
    suffix = 1
    while path.exists():  # 同一时间戳重复写入时不要互相覆盖
        path = directory / f"{stamp}-{suffix}.json"
        suffix += 1
    _write_json(path, current)
    prune_snapshots(directory, keep)
    return path, diff


STAR_HISTORY_KEEP = 8  # 星标历史只留最近 8 个"天点"：算 7 天增量够用，再留一天余量


def load_star_history(path: Path) -> dict:
    """读星标历史环。文件不存在/损坏都当空环 —— 绝不因为一个历史文件中断采集。"""
    empty = {"updatedAt": None, "unit": "stars/day", "points": []}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("points"), list):
        return empty
    points = [p for p in data["points"] if isinstance(p, dict) and p.get("at") and isinstance(p.get("stars"), dict)]
    points.sort(key=lambda p: str(p["at"]))
    return {"updatedAt": data.get("updatedAt"), "unit": data.get("unit") or "stars/day", "points": points}


def update_star_history(mesh: dict, path: Path, keep: int = STAR_HISTORY_KEEP, now: str | None = None) -> dict:
    """把本轮星标记成"每天一个点"的历史环（前端「周 star 热榜」的唯一真源）。

    为什么单独存：历史快照只保留 KEEP_SNAPSHOTS 份（约两小时），攒不出"周"窗口；
    而周增量只需要一个"7 天前的星标基线"，所以按天存、只留最近 keep 个点最省。

    - 同一天重复跑：覆盖当天的点（一天只留最后一次观测）
    - 只留最近 keep 个点（= keep 天），文件大小约 keep × 全量仓库数
    """
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)  # 按 DAY_TZ_OFFSET_HOURS 时区的 00:00 切天
    previous = load_star_history(path)
    stars = {n["id"]: n.get("stars", 0) for n in mesh.get("nodes", []) if n.get("id")}
    points = [p for p in previous["points"] if day_of(p.get("at")) != day]
    points.append({"at": at, "day": day, "count": len(stars), "stars": stars})
    points.sort(key=lambda p: str(p["at"]))
    payload = {
        "updatedAt": now or utcnow(),
        "unit": "stars/day",
        "keepDays": keep,
        "note": "每天一个点（同一天重复跑会覆盖当天），供前端算「周 star 热榜」的真实星标增量；只保留最近 keepDays 天。",
        "points": points[-keep:],
    }
    _write_json(path, payload)
    return payload



STAR_DAILY_KEEP = 8  # 逐日星标增量按天保留 8 天（算 7 天窗口够用）


def load_star_daily(path: Path) -> dict:
    """读逐日星标增量。文件不存在/损坏都当空表 —— 绝不因为一个缓存文件中断采集。"""
    empty = {"updatedAt": None, "unit": "stars/day", "keepDays": STAR_DAILY_KEEP, "seen": {}, "days": {}, "sampledDays": []}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict):
        return empty
    seen = {str(k): int(v) for k, v in (data.get("seen") or {}).items() if isinstance(v, (int, float))}
    days: dict[str, dict[str, int]] = {}
    for day, bucket in (data.get("days") or {}).items():
        if isinstance(bucket, dict):
            days[str(day)] = {str(k): int(v) for k, v in bucket.items() if isinstance(v, (int, float))}
    return {
        "updatedAt": data.get("updatedAt"),
        "unit": data.get("unit") or "stars/day",
        "keepDays": int(data.get("keepDays") or STAR_DAILY_KEEP),
        "seen": seen,
        "days": days,
        "sampledDays": [str(d) for d in (data.get("sampledDays") or [])],
    }


def update_star_daily(mesh: dict, path: Path, *, keep: int = STAR_DAILY_KEEP, now: str | None = None) -> dict:
    """每轮把「本轮星标变化」累加进【当天】的桶 —— 前端 star 榜的逐日趋势柱用它。

    为什么需要它：星标历史环一天只留一个点（同一天重复跑会覆盖），所以"两个日点的差"只能落在
    后一天，攒不出逐日形状（线上实测：只有 2 个点时，一天的涨幅全堆到最后一天）。
    这里每轮（默认 1 小时）跟上一轮比一次、把变化累加进当天桶：每天都是真实观测的累加值，
    **既不跨天摊派，也不编数字**（负数是掉星，如实记为负）。

    - 首次见到某个仓库只记基线，不计数（与更新日志同一套规矩）
    - seen 每轮按当前节点表重建，所以文件大小只跟索引规模走，不会无限增长
    - days 只留最近 keep 天
    """
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)  # 同上
    payload = load_star_daily(path)
    seen = dict(payload["seen"])
    days = {k: dict(v) for k, v in payload["days"].items()}
    sampled = set(payload.get("sampledDays") or []) | {day}

    bucket = dict(days.get(day) or {})
    next_seen: dict[str, int] = {}
    counted = 0
    gained = 0
    for node in mesh.get("nodes", []):
        nid = node.get("id")
        stars = node.get("stars")
        if not nid or not isinstance(stars, (int, float)):
            continue
        stars = int(stars)
        next_seen[nid] = stars
        before = seen.get(nid)
        if before is None:
            continue  # 首次见到：只记基线，"它本来就有这么多星"不是这一轮的增量
        delta = stars - before
        if delta:
            bucket[nid] = int(bucket.get(nid, 0)) + delta
            counted += 1
            if delta > 0:
                gained += delta
    if bucket:
        days[day] = bucket

    keep_floor = _day_shift(day, -(keep - 1))  # 含当天在内共 keep 天
    days = {d: c for d, c in days.items() if d >= keep_floor and c}
    sampled = {d for d in sampled if d >= keep_floor}
    out = {
        "updatedAt": now or utcnow(),
        "unit": "stars/day",
        "keepDays": keep,
        "note": "每轮跟上一轮比一次星标，把变化累加进当天（首次见到不计数）。前端 star 榜的逐日趋势柱用它：每天都是真实观测的累加值，不跨天摊派、不编数字；负数是掉星。",
        "lastRound": {"at": at, "counted": counted, "gained": gained},
        "seen": dict(sorted(next_seen.items())),
        "days": dict(sorted(days.items())),
        "sampledDays": sorted(sampled),
    }
    _write_json(path, out)
    return out


UPDATE_LOG_KEEP = 8  # 更新日志按天保留 8 天（算 7 天窗口够用）
UPDATE_LOG_SEEN_DAYS = 14  # seen 表只跟最近 14 天内有推送的仓库：不活跃的不必记


def load_update_log(path: Path) -> dict:
    """读更新日志。文件不存在/损坏都当空表 —— 绝不因为一个日志文件中断采集或接口。"""
    empty = {"updatedAt": None, "keepDays": UPDATE_LOG_KEEP, "seen": {}, "days": {}, "sampledDays": []}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict):
        return empty
    seen = data.get("seen") if isinstance(data.get("seen"), dict) else {}
    days = data.get("days") if isinstance(data.get("days"), dict) else {}
    sampled = data.get("sampledDays") if isinstance(data.get("sampledDays"), list) else []
    clean_days = {}
    for day, counts in days.items():
        if isinstance(counts, dict):
            clean_days[str(day)] = {str(k): int(v) for k, v in counts.items() if isinstance(v, (int, float)) and v > 0}
    return {
        "updatedAt": data.get("updatedAt"),
        "keepDays": int(data.get("keepDays") or UPDATE_LOG_KEEP),
        "seen": {str(k): str(v) for k, v in seen.items() if v},
        "days": clean_days,
        # 没有这一项的老文件按"有计数的那些天"兜底：至少能标出确实观测过的日子
        "sampledDays": sorted({str(d) for d in sampled if d} | set(clean_days)),
    }


def _day_shift(day: str, delta: int) -> str:
    from datetime import date, timedelta

    try:
        base = date.fromisoformat(day)
    except ValueError:
        return day
    return (base + timedelta(days=delta)).isoformat()


def update_update_log(mesh: dict, path: Path, *, keep: int = UPDATE_LOG_KEEP, now: str | None = None) -> dict:
    """每轮采样一次「这个仓库又推了新东西吗」，按天累计次数（前端「周更新热榜」的排序依据）。

    为什么需要它：GitHub 只给一个 pushedAt（最后一次推送），"一周更新了几次"盘上原本无从得知。
    采集器每小时看一次，只要 pushedAt 比上次观测前进了，就记一次推进 —— 这是**观测到的下界**，
    同一次推送最多记一次（采样间隔内的多次推送会合并成一次），界面上也照这个口径写清楚。

    - 首次见到某个仓库不计数（那是"它本来就有推送"，不是"我们又看到它更新了"）
    - 只跟最近 UPDATE_LOG_SEEN_DAYS 天内有推送的仓库：文件不会随仓库总数无限增长
    - days 只留最近 keep 天
    """
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)  # 同上：按北京时间的 00:00 切天
    payload = load_update_log(path)
    seen = dict(payload["seen"])
    days = {k: dict(v) for k, v in payload["days"].items()}
    sampled = set(payload.get("sampledDays") or []) | {day}  # 本轮观测过 = 这一天在观测

    floor = _day_shift(day, -UPDATE_LOG_SEEN_DAYS)
    counted = 0
    for node in mesh.get("nodes", []):
        nid = node.get("id")
        pushed = node.get("pushedAt")
        if not nid or not pushed:
            continue
        pushed = str(pushed)
        if day_of(pushed) < floor:
            seen.pop(nid, None)  # 太久没动：不再跟踪，也不必计数
            continue
        before = seen.get(nid)
        if before is not None and pushed > before:
            days.setdefault(day, {})
            days[day][nid] = int(days[day].get(nid, 0)) + 1
            counted += 1
        seen[nid] = pushed

    keep_floor = _day_shift(day, -(keep - 1))  # 含当天在内共 keep 天
    days = {d: c for d, c in days.items() if d >= keep_floor and c}
    sampled = {d for d in sampled if d >= keep_floor}
    out = {
        "updatedAt": now or utcnow(),
        "unit": "pushes/day",
        "keepDays": keep,
        "note": "每轮采样一次：pushedAt 比上次观测前进了就记一次推进（同一次推送最多记一次，首次见到不记）。前端「周更新热榜」的次数 = 这个推进次数（每轮最多记一次，是下界），窗口内确有推送但没采样到时保底记 1。",
        "lastRound": {"at": at, "counted": counted},
        "seen": dict(sorted(seen.items())),
        "days": dict(sorted(days.items())),
        # 逐日趋势图要区分「当天 0 次」与「当天没观测」：这里记的是观测到的日子
        "sampledDays": sorted(sampled),
    }
    _write_json(path, out)
    return out


def latest_snapshot(directory: Path) -> dict | None:
    if not directory.exists():
        return None
    files = sorted(directory.glob("*.json"))
    if not files:
        return None
    try:
        return json.loads(files[-1].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def diff_snapshots(previous: dict | None, current: dict) -> dict:
    if not previous:
        return {"baseline": True, "added": [], "removed": [], "archived": [], "starGainers": [], "starLosers": []}
    prev_nodes = previous.get("nodes") or {}
    curr_nodes = current.get("nodes") or {}
    added = [nid for nid in curr_nodes if nid not in prev_nodes]
    removed = [nid for nid in prev_nodes if nid not in curr_nodes]
    archived = [nid for nid, n in curr_nodes.items() if n.get("archived") and not (prev_nodes.get(nid) or {}).get("archived")]
    deltas = []
    for nid, node in curr_nodes.items():
        before = prev_nodes.get(nid)
        if before is None:
            continue
        delta = node.get("stars", 0) - before.get("stars", 0)
        if delta:
            deltas.append({"id": nid, "delta": delta, "stars": node.get("stars", 0)})
    deltas.sort(key=lambda d: -d["delta"])
    return {
        "baseline": False,
        "since": previous.get("generatedAt"),
        "added": sorted(added)[:50],
        "addedCount": len(added),
        "removed": sorted(removed)[:50],
        "removedCount": len(removed),
        "archived": sorted(archived)[:50],
        "archivedCount": len(archived),
        "starGainers": deltas[:10],
        "starLosers": deltas[-10:][::-1],
    }


def prune_snapshots(directory: Path, keep: int) -> list[str]:
    files = sorted(directory.glob("*.json"))
    removed = []
    for path in files[:-keep] if keep > 0 else []:
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    return removed


def write_last_crawl(payload: dict, path: Path) -> int:
    return _write_json(path, payload)


def load_blacklist(path: Path) -> dict:
    """读噪声作者黑名单。文件不存在/损坏都当空表处理，绝不因此中断采集。"""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    owners = data.get("owners") if isinstance(data, dict) else None
    if not isinstance(owners, dict):
        return {}
    return {str(owner): info for owner, info in owners.items() if owner}


def write_blacklist(owners: dict, path: Path, *, updated_at: str | None = None) -> int:
    """写黑名单。人工删掉某个 owner 再跑一轮即可解除拉黑。"""
    payload = {
        "updatedAt": updated_at or utcnow(),
        "count": len(owners),
        "note": "噪声作者（同一作者被收录超过阈值个仓库、且每个仓库星标都低于阈值）。删除条目即可解除拉黑。",
        "owners": dict(sorted(owners.items())),
    }
    return _write_json(path, payload)
