"""构图：把抓到的原始仓库变成前端契约（nodes / edges / clusters / meta）。

与前端 tools/seed-sample.mjs 的构图逻辑保持一致，差异只在于数据规模：
真实采集会有上万条记录，因此多了"前端快照限量"这一步。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from .classify import apply_categories
from .config import DEGREE_CAP, HUB_DF, HUB_ID, OWNER_CLIQUE_MAX, REVIEW_THRESHOLD, WHITELIST_TAGS

_NAME_RE = re.compile(r"(^|[^a-z])dsh([^a-z]|$)|dsh-|dsh_", re.I)
_DESC_RE = re.compile(r"dsh|deepseek[- ]?harness|cordis", re.I)
_CORDIS_RE = re.compile(r"cordis", re.I)


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pick_repo(item: dict) -> dict:
    """从 GitHub 搜索结果里挑出需要的字段（其余丢掉，别把仓库撑肥）。"""
    owner = (item.get("owner") or {})
    license_info = item.get("license") or {}
    return {
        "id": item.get("full_name"),
        "name": item.get("name"),
        "owner": owner.get("login") or "?",
        "ownerType": owner.get("type"),
        "avatar": owner.get("avatar_url"),
        "htmlUrl": item.get("html_url"),
        "stars": item.get("stargazers_count") or 0,
        "forks": item.get("forks_count") or 0,
        "openIssues": item.get("open_issues_count") or 0,
        "createdAt": item.get("created_at"),
        "pushedAt": item.get("pushed_at"),
        "updatedAt": item.get("updated_at"),
        "language": item.get("language"),
        "license": license_info.get("spdx_id"),
        "archived": bool(item.get("archived")),
        "fork": bool(item.get("fork")),
        "description": item.get("description") or "",
        "homepage": item.get("homepage") or None,
        "sizeKb": item.get("size") or 0,
        "topics": item.get("topics") or [],
    }


def normalize_repo(item: dict) -> dict:
    """本地缓存里存的可能已经是裁剪过的记录（owner 是字符串），也可能还是原始 API 响应。"""
    return pick_repo(item) if "full_name" in item else item


def relevance_score(repo: dict) -> int:
    """朴素相关度启发式（0~8）。用于把"挂了标签但不像 DSH 插件"的仓库挑出来复核。"""
    score = 0
    if _NAME_RE.search(repo.get("name") or ""):
        score += 3
    if _DESC_RE.search(repo.get("description") or ""):
        score += 2
    topics = repo.get("topics") or []
    if "deepseek-harness" in topics:
        score += 1
    if sum(1 for t in topics if t in WHITELIST_TAGS) >= 2:
        score += 1
    if _CORDIS_RE.search(repo.get("description") or "") or "cordis" in topics:
        score += 1
    return score


def build_mesh(raw_repos: list[dict], tag_totals: dict | None = None, *, source: str = "GitHub REST Search API") -> dict:
    """主构图流程：精确命中 -> 去重 -> 功能分类 -> 主题/同作者连线 -> 度数裁剪。"""
    tag_totals = tag_totals or {}
    nodes: list[dict] = []
    seen: dict[str, dict] = {}

    for raw in raw_repos:
        repo = normalize_repo(raw)
        matched = [t for t in WHITELIST_TAGS if t in repo["topics"]]
        if not matched or not repo["id"]:
            continue  # 精确命中：标签必须真的在它自己的 topics 里
        matched.sort(key=WHITELIST_TAGS.index)
        if repo["id"] in seen:
            prev = seen[repo["id"]]
            prev["matchedTags"] = sorted(set(prev["matchedTags"]) | set(matched), key=WHITELIST_TAGS.index)
            continue
        rel = relevance_score(repo)
        repo["matchedTags"] = matched
        repo["primaryTag"] = matched[0]
        repo["relevance"] = rel
        repo["noise"] = min(1.0, max(0.0, 1 - rel / 5))
        repo["review"] = rel <= REVIEW_THRESHOLD
        seen[repo["id"]] = repo
        nodes.append(repo)

    categories = apply_categories(nodes)

    # ---------- 连线 ----------
    edge_map: dict[tuple, dict] = {}

    def add_edge(a: str, b: str, kind: str, via: str) -> None:
        src, dst = (a, b) if a < b else (b, a)
        key = (kind, src, dst)
        edge = edge_map.get(key)
        if edge is None:
            edge = {"source": src, "target": dst, "type": kind, "weight": 0, "via": []}
            edge_map[key] = edge
        edge["weight"] += 1
        if via and len(edge["via"]) < 4 and via not in edge["via"]:
            edge["via"].append(via)

    by_topic: dict[str, list[str]] = {}
    for node in nodes:
        for topic in node["topics"]:
            by_topic.setdefault(topic, []).append(node["id"])

    hubs = []
    for topic, ids in sorted(by_topic.items(), key=lambda kv: -len(kv[1])):
        if len(ids) < 2:
            continue
        if len(ids) > HUB_DF:
            hubs.append({"topic": topic, "count": len(ids)})  # 超级枢纽：只展示，不连线
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                add_edge(ids[i], ids[j], "topic", topic)

    by_owner: dict[str, list[dict]] = {}
    for node in nodes:
        by_owner.setdefault(node["owner"], []).append(node)
    owner_edges = 0
    owner_star_edges = 0
    for owner, group in by_owner.items():
        if len(group) < 2:
            continue
        if len(group) <= OWNER_CLIQUE_MAX:
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    add_edge(group[i]["id"], group[j]["id"], "owner", owner)
                    owner_edges += 1
        else:
            hub = max(group, key=lambda n: n["stars"])
            for node in group:
                if node["id"] == hub["id"]:
                    continue
                add_edge(hub["id"], node["id"], "owner", owner)
                owner_star_edges += 1

    # 度数裁剪：只裁"主题共现"；同作者是硬关系，必须保留
    degree: dict[str, int] = {}
    edges: list[dict] = []
    dropped = 0
    for edge in sorted(edge_map.values(), key=lambda e: -e["weight"]):
        if edge["type"] != "topic":
            edges.append(edge)
            continue
        ds = degree.get(edge["source"], 0)
        dt = degree.get(edge["target"], 0)
        if ds >= DEGREE_CAP or dt >= DEGREE_CAP:
            dropped += 1
            continue
        degree[edge["source"]] = ds + 1
        degree[edge["target"]] = dt + 1
        edges.append(edge)

    for node in nodes:
        node["degree"] = degree.get(node["id"], 0)

    tag_counts = [
        {
            "id": tag,
            "sampleCount": sum(1 for n in nodes if tag in n["matchedTags"]),
            "apiTotal": tag_totals.get(tag),
        }
        for tag in WHITELIST_TAGS
    ]

    return {
        "meta": {
            "generatedAt": utcnow(),
            "kind": "crawl",
            "source": source,
            "indexedNodes": len(nodes),
            "sampleNodes": len(nodes),
            "sampleEdges": len(edges),
            "droppedEdges": dropped,
            "ownerEdges": owner_edges + owner_star_edges,
            "ownerStarEdges": owner_star_edges,
            "hubThreshold": HUB_DF,
            "degreeCap": DEGREE_CAP,
            "reviewedAsNoise": sum(1 for n in nodes if n["review"]),
            "categories": {
                "classified": categories["classified"],
                "unclassified": categories["unclassified"],
                "minCount": categories["minCount"],
                "maxSectors": categories["maxSectors"],
                "merged": categories["merged"],
                "distribution": categories["counts"],
            },
        },
        "tags": tag_counts,
        "hubs": hubs[:12],
        "clusters": categories["counts"],
        "nodes": nodes,
        "edges": edges,
    }


def limit_for_frontend(mesh: dict, limit: int, hub_id: str = HUB_ID) -> dict:
    """真实索引可能上万条，前端只吃星标头部；被裁掉的仍计入 meta 以便如实展示。"""
    nodes = mesh["nodes"]
    if limit <= 0 or len(nodes) <= limit:
        mesh["meta"]["frontendLimit"] = None
        return mesh
    ranked = sorted(nodes, key=lambda n: -n["stars"])
    keep: list[dict] = ranked[:limit]
    if hub_id not in {n["id"] for n in keep}:
        hub = next((n for n in nodes if n["id"] == hub_id), None)
        if hub is not None:
            keep.append(hub)
    keep_ids = {n["id"] for n in keep}
    mesh["nodes"] = keep
    mesh["edges"] = [e for e in mesh["edges"] if e["source"] in keep_ids and e["target"] in keep_ids]
    mesh["meta"]["frontendLimit"] = limit
    mesh["meta"]["sampleNodes"] = len(keep)
    mesh["meta"]["sampleEdges"] = len(mesh["edges"])
    counts: dict[str, int] = {}
    for node in keep:
        counts[node["category"]] = counts.get(node["category"], 0) + 1
    mesh["clusters"] = sorted(
        ({"id": cid, "label": next((n["categoryLabel"] for n in keep if n["category"] == cid), cid), "count": n} for cid, n in counts.items()),
        key=lambda c: -c["count"],
    )
    return mesh
