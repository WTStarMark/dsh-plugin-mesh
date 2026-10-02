"""快照：写契约文件、写历史快照、算 diff、清理旧快照。

每小时一份快照，保留最近若干份；diff 回答"这一小时生态里发生了什么"。
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import KEEP_SNAPSHOTS
from .build import utcnow


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
