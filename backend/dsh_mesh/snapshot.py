"""快照：写契约文件、写历史快照、算 diff、清理旧快照。

每小时一份快照，保留最近若干份；diff 回答"这一小时生态里发生了什么"。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

from .config import DAY_TZ_OFFSET_HOURS, KEEP_SNAPSHOTS, STAR_OBS_GAP_HOURS, STAR_SEEN_GRACE_DAYS
from .build import utcnow


def day_of(at: str, offset_hours: int = DAY_TZ_OFFSET_HOURS) -> str:
    """把 UTC 时间戳换算成"哪一天" —— 按 offset_hours 时区的 00:00 切天。
    默认 UTC+8：按 UTC 切等于北京时间早上 08:00 才换日，前半夜的数据会被算到前一天。"""
    text = str(at)
    try:
        stamp = datetime.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return text[:10]
    return (stamp + timedelta(hours=offset_hours)).strftime("%Y-%m-%d")


def _write_json(path: Path, payload) -> int:
    """原子写 JSON：先写同目录临时文件，再 os.replace 顶替原文件。
    write_text 中途被杀/磁盘满会留半截 JSON，前端正好读到就当整份损坏；临时名 "<原名>.<pid>.tmp"
    不是 *.json，不会被当成正式快照，带 pid 避免两个采集进程互踩；失败删临时文件并抛异常。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    _replace_text(path, text)
    return len(text)


def _replace_text(path: Path, text: str) -> None:
    """同目录临时文件 + os.replace 的原子落盘；权限与原文一致（新文件按 umask）。"""
    try:
        mode = path.stat().st_mode & 0o777  # 原文件存在时沿用它的权限位
    except OSError:
        mode = None
    tmp = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o666)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        if mode is not None:
            os.chmod(tmp, mode)  # umask 会截掉旧文件里的权限位，这里对齐原文
        os.replace(tmp, path)
    except BaseException:
        # 失败不能留下临时垃圾，更不能碰原文件
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


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
    历史快照只留约两小时，攒不出"周"窗口；按天存基线最省：同一天重复跑覆盖当天，只留最近 keep 个点。"""
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)
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
    """读逐日星标台账；文件不存在/损坏都当空表，绝不中断采集。
    字段与 tools/api.mjs 的 loadStarDaily 逐字段对应：seen=当前基线；seenCarry=缺席仍保留基线的
    仓库（体积只跟"缺了几个"走）；days=逐日柱；spans=跨天宽条；rounds=观测台账；sampledDays=比对过的日。"""
    empty = {
        "updatedAt": None, "unit": "stars/day", "keepDays": STAR_DAILY_KEEP,
        "seen": {}, "seenCarry": {}, "days": {}, "spans": [], "rounds": {}, "sampledDays": [], "lastRound": None,
    }
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict):
        return empty
    seen = {str(k): int(v) for k, v in (data.get("seen") or {}).items() if isinstance(v, (int, float))}
    carry = {str(k): str(v) for k, v in (data.get("seenCarry") or {}).items() if v}
    days: dict[str, dict[str, int]] = {}
    for day, bucket in (data.get("days") or {}).items():
        if isinstance(bucket, dict):
            days[str(day)] = {str(k): int(v) for k, v in bucket.items() if isinstance(v, (int, float))}
    spans: list[dict] = []
    for s in data.get("spans") or []:
        if not isinstance(s, dict) or not s.get("from") or not s.get("to") or not isinstance(s.get("d"), dict):
            continue
        deltas = {str(k): int(v) for k, v in s["d"].items() if isinstance(v, (int, float))}
        if deltas:
            spans.append({"from": str(s["from"]), "to": str(s["to"]), "hours": s.get("hours"), "d": deltas})
    rounds: dict[str, dict[str, str]] = {}
    for day, r in (data.get("rounds") or {}).items():
        if isinstance(r, dict) and r.get("first") and r.get("last"):
            rounds[str(day)] = {"first": str(r["first"]), "last": str(r["last"])}
    return {
        "updatedAt": data.get("updatedAt"),
        "unit": data.get("unit") or "stars/day",
        "keepDays": int(data.get("keepDays") or STAR_DAILY_KEEP),
        "seen": seen,
        "seenCarry": carry,
        "days": days,
        "spans": spans,
        "rounds": rounds,
        "sampledDays": [str(d) for d in (data.get("sampledDays") or [])],
        "lastRound": data.get("lastRound") if isinstance(data.get("lastRound"), dict) else None,
    }


def _hours_between(a: str, b: str) -> float:
    """两个 UTC 时间戳相隔几小时；任一个解析不出来返回 0（按"没断档"处理，不制造假宽条）。"""
    try:
        ta = datetime.strptime(str(a)[:19], "%Y-%m-%dT%H:%M:%S")
        tb = datetime.strptime(str(b)[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return 0.0
    return max(0.0, (tb - ta).total_seconds() / 3600.0)


def rename_alias_maps(nodes: list[dict]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """改名别名：旧 full_name → 现 full_name，以及现名 → [旧名...]（数据来自节点上的 renamedFrom）。

    规则与 tools/api.mjs 的 aliasIndexOf 保持一致：
    ① 旧名若仍是活节点（改名后旧名被别的仓库占用）→ 不归一，否则会把那个仓库的账算到别人头上；
    ② A→B→C 链式收敛，≤5 跳，防环；
    ③ 只认「现名确实在本次节点里」的映射。
    所有以 full_name 为键的台账（star-daily / update-log）都必须过这张表，否则改名当轮会把「改名」当「首次见到」，
    旧名下的历史增量再也对不上现名。
    """
    alive = {str(n.get("id")) for n in nodes if n.get("id")}
    alias: dict[str, str] = {}
    for node in nodes:
        nid = str(node.get("id") or "")
        if not nid or nid not in alive:
            continue
        for old in node.get("renamedFrom") or []:
            old = str(old)
            if old and old != nid and old not in alive:
                alias[old] = nid
    for old in list(alias):
        cur = alias[old]
        seen_chain = {old}
        hops = 0
        while cur in alias and cur not in seen_chain and hops < 5:
            seen_chain.add(cur)
            cur = alias[cur]
            hops += 1
        alias[old] = cur
    olds_of: dict[str, list[str]] = {}
    for old, cur in alias.items():
        olds_of.setdefault(cur, []).append(old)
    return alias, olds_of


def update_star_daily(
    mesh: dict,
    path: Path,
    *,
    keep: int = STAR_DAILY_KEEP,
    gap_hours: float = STAR_OBS_GAP_HOURS,
    grace_days: int = STAR_SEEN_GRACE_DAYS,
    now: str | None = None,
) -> dict:
    """每轮把「本轮观测到的星标变化」记进台账 —— 前端 star 榜的逐日趋势柱用它。
    星标环一天只留一个点，"两个日点的差"只能落在后一天，攒不出逐日形状，所以必须有这份台账。四条硬规矩：
    1) 首轮只记基线，当天不进 sampledDays（否则"还没开始观测"会画成"这天涨 0 星"）；
    2) 基线超过 gap_hours 的增量写进 spans 不进当天桶（一次停机恢复不能把几天涨幅塞进恢复日）；
    3) 缺席仓库在 grace_days 内保留基线，否则下次出现会被当"首次见到"、这段变化被静默吞掉；
    4) 首次见到只记基线不计数。每轮都落盘（0 变化也写），这是"这轮确实观测过"的唯一证据。
    5) 改名：现名首次出现、但旧名在 seen 里有基线时，用【旧基线】接续计数（改名当轮不丢空档），旧名从台账退出。
    """
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)
    payload = load_star_daily(path)
    seen = dict(payload["seen"])
    carry = dict(payload["seenCarry"])
    nodes = mesh.get("nodes", [])
    alias_to_new, olds_of = rename_alias_maps(nodes)
    aliased_old = set(alias_to_new)  # 这些旧名已归一到现名，本轮不再作为独立基线保留/携带
    days = {k: dict(v) for k, v in payload["days"].items()}
    spans = [dict(s) for s in payload["spans"]]
    rounds = {k: dict(v) for k, v in payload["rounds"].items()}
    sampled = set(payload["sampledDays"])

    prev_round = payload.get("lastRound") or {}
    prev_at = prev_round.get("at") or payload.get("updatedAt")
    has_baseline = bool(seen) and bool(prev_at)

    bucket = dict(days.get(day) or {})
    span_groups: dict[tuple[str, str], dict] = {}
    next_seen: dict[str, int] = {}
    next_carry: dict[str, str] = {}
    present: set[str] = set()
    counted = 0
    gained = 0
    alias_used = 0

    for node in nodes:
        nid = node.get("id")
        stars = node.get("stars")
        if not nid or not isinstance(stars, (int, float)):
            continue
        stars = int(stars)
        present.add(nid)
        next_seen[nid] = stars
        before = seen.get(nid)
        alias_src = None
        if before is None:
            # 改名当轮：现名首见，但旧名有基线 → 用最近观测到的旧基线接续（不是「首见不计数」）
            candidates = [old for old in olds_of.get(nid, []) if old in seen]
            if candidates:
                alias_src = max(candidates, key=lambda old: str(carry.get(old, "")))
                before = seen[alias_src]
                alias_used += 1
        if before is None:
            continue  # 首次见到：只记基线
        delta = stars - before
        if not delta:
            continue
        counted += 1
        if delta > 0:
            gained += delta
        obs_at = carry.get(alias_src or nid, prev_at)  # 这份基线是什么时候观测到的
        gap = _hours_between(obs_at, at)
        if gap > gap_hours:
            key = (day_of(obs_at), day)
            group = span_groups.setdefault(key, {"d": {}, "hours": 0.0})
            group["d"][nid] = int(group["d"].get(nid, 0)) + delta
            group["hours"] = round(max(group["hours"], gap), 2)
        else:
            bucket[nid] = int(bucket.get(nid, 0)) + delta

    # 本轮缺席：宽限期内保留基线，超期丢弃
    grace_floor = _day_shift(day, -grace_days)
    carried = 0
    for nid, stars in seen.items():
        if nid in present or nid in aliased_old:
            continue
        last = carry.get(nid, prev_at)
        if last and day_of(last) >= grace_floor:
            next_seen[nid] = stars
            next_carry[nid] = last
            carried += 1

    span_added = 0
    if has_baseline:
        sampled.add(day)
        record = rounds.setdefault(day, {})
        record.setdefault("first", at)
        record["last"] = at
        if bucket:
            days[day] = bucket
        for (frm, to), group in sorted(span_groups.items()):
            spans.append({"from": frm, "to": to, "hours": group["hours"], "d": group["d"]})
            span_added += 1

    keep_floor = _day_shift(day, -(keep - 1))  # 含当天在内共 keep 天
    days = {d: c for d, c in days.items() if d >= keep_floor and c}
    spans = [s for s in spans if str(s.get("to") or "") >= keep_floor and s.get("d")]
    rounds = {d: r for d, r in rounds.items() if d >= keep_floor}
    sampled = {d for d in sampled if d >= keep_floor}

    out = {
        "updatedAt": now or utcnow(),
        "unit": "stars/day",
        "keepDays": keep,
        "note": (
            "逐日柱 = 当天各轮真实观测到的星标变化的累加（首次见到不计数，负数是掉星）。"
            "断档超过 " + str(gap_hours) + " 小时的那一轮不进日柱，单独记在 spans 里；"
            "没有观测的日子不落进 days/sampledDays，读取端据此画成「没数据」而不是 0。"
        ),
        "lastRound": {
            "at": at,
            "day": day,
            "counted": counted,
            "gained": gained,
            "spans": span_added,
            "carried": carried,
            "baseline": not has_baseline,
            "renamed": alias_used,
        },
        "seen": dict(sorted(next_seen.items())),
        "seenCarry": dict(sorted(next_carry.items())),
        "days": dict(sorted(days.items())),
        "spans": spans,
        "rounds": dict(sorted(rounds.items())),
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
    """每轮采样「这个仓库又推了新东西吗」，按天累计（前端「周更新热榜」的排序依据）。
    GitHub 只给一个 pushedAt（最后一次推送），"一周更新了几次"只能这样观测：pushedAt 比上次
    观测前进就记一次，是**观测到的下界**（采样间隔内的多次推送会合并成一次），界面照此口径写明。
    首次见到不计数；seen 只跟最近 UPDATE_LOG_SEEN_DAYS 天内有推送的仓库；days 只留最近 keep 天。"""
    at = (mesh.get("meta") or {}).get("generatedAt") or now or utcnow()
    day = day_of(at)
    payload = load_update_log(path)
    seen = dict(payload["seen"])
    days = {k: dict(v) for k, v in payload["days"].items()}
    sampled = set(payload.get("sampledDays") or []) | {day}  # 本轮观测过 = 这一天在观测
    nodes = mesh.get("nodes", [])
    alias_to_new, olds_of = rename_alias_maps(nodes)
    aliased_old = set(alias_to_new)

    floor = _day_shift(day, -UPDATE_LOG_SEEN_DAYS)
    counted = 0
    renamed = 0
    for node in nodes:
        nid = node.get("id")
        pushed = node.get("pushedAt")
        if not nid or not pushed:
            continue
        pushed = str(pushed)
        if day_of(pushed) < floor:
            seen.pop(nid, None)  # 太久没动：不再跟踪，也不必计数
            continue
        before = seen.get(nid)
        if before is None:
            # 改名当轮：旧名的 pushedAt 接着比，避免把「改名」当「首次见到」把推送计数重置
            candidates = [old for old in olds_of.get(nid, []) if old in seen]
            if candidates:
                alias_src = max(candidates, key=lambda old: str(seen.get(old, "")))
                before = seen[alias_src]
                renamed += 1
        if before is not None and pushed > before:
            days.setdefault(day, {})
            days[day][nid] = int(days[day].get(nid, 0)) + 1
            counted += 1
        seen[nid] = pushed
    for old in aliased_old:
        seen.pop(old, None)  # 旧名基线退出，避免改名后新旧两条同时计数

    keep_floor = _day_shift(day, -(keep - 1))  # 含当天在内共 keep 天
    days = {d: c for d, c in days.items() if d >= keep_floor and c}
    sampled = {d for d in sampled if d >= keep_floor}
    out = {
        "updatedAt": now or utcnow(),
        "unit": "pushes/day",
        "keepDays": keep,
        "note": "每轮采样一次：pushedAt 比上次观测前进了就记一次推进（同一次推送最多记一次，首次见到不记）。前端「周更新热榜」的次数 = 这个推进次数（每轮最多记一次，是下界），窗口内确有推送但没采样到时保底记 1。",
        "lastRound": {"at": at, "counted": counted, "renamed": renamed},
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


def _read_blacklist_payload(path: Path) -> dict:
    """读黑名单原始外壳。文件不存在/损坏都当空表处理，绝不因此中断采集。"""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_blacklist(path: Path) -> dict:
    """读【作者级】黑名单：一个人整批刷标签，整账号剔除。"""
    owners = _read_blacklist_payload(path).get("owners")
    if not isinstance(owners, dict):
        return {}
    return {str(owner): info for owner, info in owners.items() if owner}


def load_blacklist_repos(path: Path) -> dict:
    """读【单仓库级】黑名单：那个人还有真项目，只剔这一个仓库（issue#5 第1条）。
    与作者级分开，是因为两者语义不同 —— 作者级是"整账号不可信"，仓库级是"这个仓库不可信"。"""
    repos = _read_blacklist_payload(path).get("repos")
    if not isinstance(repos, dict):
        return {}
    out: dict = {}
    for rid, info in repos.items():
        key = str(rid).strip()
        if not key:
            continue
        out[key] = info if isinstance(info, dict) else {}
    return out


# 黑名单文件的说明文案。tools/admin-config.mjs 的 BLACKLIST_NOTE 必须与本行一字不差
# （后台写、采集器读同一份文件，文案分叉会让两侧的测试互相打架）。
BLACKLIST_NOTE = "噪声黑名单：自动判据是同作者收录超过阈值个仓库、且每个仓库星标都低于阈值；也可以在后台手工加。删除条目即可解除拉黑。"


def write_blacklist(owners: dict, path: Path, *, repos: dict | None = None, updated_at: str | None = None) -> int:
    """写黑名单（作者级 + 单仓库级）。人工删掉某个条目再跑一轮即可解除拉黑。

    两个键都必须写出去：只写 owners 会把后台加的单仓库条目静默抹掉
    —— Node 侧 writeBlacklist 曾经就是这么丢数据的，别再犯一遍。
    """
    owner_map = dict(sorted((owners or {}).items()))
    repo_map = dict(sorted((repos or {}).items()))
    payload = {
        "updatedAt": updated_at or utcnow(),
        "count": len(owner_map) + len(repo_map),
        "note": BLACKLIST_NOTE,
        "owners": owner_map,
        "repos": repo_map,
    }
    return _write_json(path, payload)
