"""构图：把抓到的原始仓库变成前端契约（nodes / edges / clusters / meta）。

与前端 tools/seed-sample.mjs 的构图逻辑保持一致（改一边要改两边），区别是多了"前端快照限量"。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import admin_config
from .classify import apply_categories, non_plugin_reason
from .config import ROOT  # noqa: E402  (ROOT 在下面 config 段还会用到)


def load_ecosystem(path=None) -> dict:
    """读生态共鸣清单；缺失/损坏都当空表，绝不中断采集。
    后台 resonance.overrides 只覆盖 enabled：关掉的基座不建共鸣边，但仍算协议基座
    （build_mesh 用 ecosystem.keys() 写进 meta）；覆盖里不存在的基座忽略，不凭空造。"""
    # 用哪份清单由 admin_config.ecosystem_path 决定（后台副本优先，其次策展产物）；显式传 path 时不插队。
    path = admin_config.ecosystem_path(path or ECOSYSTEM_JSON) if path is None else path
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 清单是加分项，读不到就只是没有这些边
        return {}
    out: dict[str, dict] = {}
    for base in data.get("bases") or []:
        base_id = str(base.get("id") or "")
        if not base_id:
            continue
        out[base_id] = {
            "label": base.get("label") or "",
            # enabled=False 的基座仍然策展、仍然算基座（归入协议基座），只是不建共鸣边
            "enabled": base.get("enabled") is not False,
            "children": [
                {"id": str(v.get("id")), "label": base.get("label") or "", "signals": v.get("signals") or []}
                for v in (base.get("verified") or [])
                if v.get("id")
            ],
        }
    # 后台启停覆盖：只认清单里已有的基座；resonance_overrides 本身绝不抛异常
    for base_id, enabled in admin_config.resonance_overrides().items():
        info = out.get(base_id)
        if info is not None:
            info["enabled"] = bool(enabled)
    return out
from .config import (
    DEGREE_CAP,
    HUB_DF,
    HUB_ID,
    NOISE_OWNER_MAX_STARS,
    NOISE_OWNER_MIN_REPOS,
    NOISE_OWNER_STRICT_MIN_REPOS,
    NOISE_OWNER_ZERO_RATIO,
    OWNER_CLIQUE_MAX,
    WHITELIST_TAGS,
)

# 生态共鸣清单（人工策展，见 tools/curate-ecosystem.mjs）：基座 → 长在它上面的插件
ECOSYSTEM_JSON = ROOT / "tools" / "ecosystem.json"

_NAME_RE = re.compile(r"(^|[^a-z])dsh([^a-z]|$)|dsh-|dsh_", re.I)
# 名字收录：仓库名里出现 dsh- / dsh_（没有任何白名单 topic 也算）
_NAME_DASH_RE = re.compile(r"dsh[-_]", re.I)
# 由名字收录（而非 topic 命中）的仓库，用这个伪标签做 primaryTag，前端可如实展示来源
NAME_TAG = "dsh-*（名字收录）"
_DESC_RE = re.compile(r"dsh|deepseek[- ]?harness|cordis", re.I)
_CORDIS_RE = re.compile(r"cordis", re.I)


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pick_repo(item: dict) -> dict:
    """从 GitHub 搜索结果里挑出需要的字段（其余丢掉，别把仓库撑肥）。"""
    owner = (item.get("owner") or {})
    license_info = item.get("license") or {}
    return {
        # id 随改名变化；githubId 是稳定数字 id，累积索引靠它识别"同一仓库换了名字"，否则新旧两球都在图里。
        "id": item.get("full_name"),
        "githubId": item.get("id"),
        "name": item.get("name"),
        "owner": owner.get("login") or "?",
        "ownerType": owner.get("type"),
        "avatar": sized_avatar(owner.get("avatar_url")),
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


ALIASES_JSON = ROOT / "data" / "cache" / "aliases.json"


def load_aliases(path=None) -> dict[str, str]:
    """改名别名表（旧名 → 现名），由 tools/dedupe-renames.mjs 经 API 核对后写出。
    SegmentStore 加载/合并时已归一；这里再兜一道，让 --from-raw 之类的离线构建不把旧名当另一个仓库。"""
    path = path or ALIASES_JSON
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 别名表是加分项
        return {}
    raw = data.get("aliases") if isinstance(data, dict) else None
    out: dict[str, str] = {}
    for k, v in (raw or {}).items():
        cur = str(v)
        for _ in range(5):  # 跟随多级链
            nxt = (raw or {}).get(cur)
            if not nxt or nxt == cur:
                break
            cur = str(nxt)
        if k and cur and k != cur:
            out[str(k)] = cur
    return out


def owner_of(repo: dict) -> str:
    """作者名：原始 API 记录里 owner 是 dict（{login}），裁剪过的记录里是字符串。"""
    owner = repo.get("owner")
    if isinstance(owner, dict):
        return str(owner.get("login") or "")
    return str(owner or "")


def relevance_score(repo: dict) -> int:
    """朴素相关度启发式（0~8），作为 analyze_relevance 的参考分。"""
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


# GitHub 默认给 460×460 原图（单张可达几百 KB），图上最大才几十像素；要 64px，视网膜屏也够。
AVATAR_SIZE = 64


def sized_avatar(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return url or None
    if not url.startswith("https://avatars.githubusercontent.com/"):
        return url
    if re.search(r"[?&](s|size)=", url):
        return url
    return url + ("&" if "?" in url else "?") + "s=" + str(AVATAR_SIZE)


def find_noise_owners(
    nodes: list[dict],
    min_repos: int = NOISE_OWNER_MIN_REPOS,
    zero_ratio: float = NOISE_OWNER_ZERO_RATIO,
    strict_min_repos: int = NOISE_OWNER_STRICT_MIN_REPOS,
    max_stars: int = NOISE_OWNER_MAX_STARS,
) -> dict[str, dict]:
    """噪声作者：批量刷标签的垃圾号，两条判据命中任一即可 ——
    1) 仓库数 > min_repos 且 0 星占比 > zero_ratio（默认 300 / 98%）；
    2) 仓库数 > strict_min_repos 且全部 0 星（默认 200，老判据）。
    留 2% 余地：刷号者偶尔互刷或自点一两颗星。结果带 zeroRatio 与 reason 便于排查。"""
    groups: dict[str, list[dict]] = {}
    for node in nodes:
        groups.setdefault(node["owner"], []).append(node)
    noise: dict[str, dict] = {}
    for owner, group in groups.items():
        total = len(group)
        stars = [int(n.get("stars") or 0) for n in group]
        zero = sum(1 for s in stars if s == 0)
        top = max(stars) if stars else 0
        ratio = zero / total if total else 0.0
        reason = None
        if total > min_repos and ratio > zero_ratio:
            reason = "mass-publish"
        elif total > strict_min_repos and top < max_stars:
            reason = "all-zero-stars"
        if reason:
            noise[owner] = {
                "repos": total,
                "zeroStars": zero,
                "zeroRatio": round(ratio, 4),
                "maxStars": top,
                "reason": reason,
            }
    return noise


# ---- 相关性判定（三档结论），与 tools/relevance.mjs 逐条一致 ----
_DSH_NAME_RE = re.compile(r"(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]|deepseek[\s-]?harness|cordis", re.I)
_DSH_DESC_RE = _DSH_NAME_RE
# 主题里只有这几个是 DSH 专有的；单说 deepseek 只表示模型/公司
_SPEC_TOPICS = {"deepseek-harness", "cordis", "cordis-plugin"}
# 插件/技能形态的线索：正文里有这些词，说明它至少是"生态里的一件东西"
_PLUGIN_SHAPED_RE = re.compile(r"plugin|插件|skill|技能|mcp|扩展|extension|皮肤|主题|面板|侧边栏|工作台", re.I)
# 其他插件生态的标签：同时铺好几个生态的标签，基本是蹭标签
OTHER_ECOSYSTEM_TAGS = {
    "claude-code-plugin", "claude-plugin", "codex-plugin", "cursor-plugin",
    "gemini-cli-extension", "openai-plugin", "vscode-extension", "jetbrains-plugin",
}


def analyze_relevance(repo: dict) -> dict:
    """三档结论：related（有 DSH 专有线索）/ noise（与 DSH 无关、空壳、堆标签）/ manual（需人工）。
    能一眼定性的先定掉，只把真正模糊的留给人工队列（否则上千个仓库全进"待复核"）。"""
    name = str(repo.get("name") or "")
    desc = str(repo.get("description") or "").strip()
    topics = [str(t).lower() for t in (repo.get("topics") or [])]
    tags = repo.get("matchedTags") or []
    relevance = relevance_score(repo)

    def out(verdict: str, reason: str, review: bool) -> dict:
        return {"relevance": relevance, "review": review, "verdict": verdict, "reason": reason}

    if _DSH_NAME_RE.search(name) or _DSH_DESC_RE.search(desc) or any(t in _SPEC_TOPICS for t in topics):
        return out("related", "名字/描述/主题里有 DSH 专有线索", False)
    loose = bool(_PLUGIN_SHAPED_RE.search(name + " " + desc))
    other_eco = sum(1 for t in topics if t in OTHER_ECOSYSTEM_TAGS)
    if other_eco >= 2:
        return out("noise", f"同时铺了 {other_eco} 个其他插件生态的标签", False)
    if len(tags) >= 3 and not loose:
        return out("noise", f"挂了 {len(tags)} 个 DSH 标签，正文却没有插件线索", False)
    if len(desc) < 10 and (repo.get("stars") or 0) == 0 and not loose:
        return out("noise", "空壳仓库：没有描述、0 星", False)
    if len(tags) == 1 and not loose:
        return out("noise", "只挂 1 个最宽泛的 dsh 标签，正文与 DSH 无关", False)
    return out("manual", "正文像插件，但没提 DSH，需要人工确认" if loose else "线索不足，需要人工确认", True)


def build_mesh(
    raw_repos: list[dict],
    tag_totals: dict | None = None,
    *,
    source: str = "GitHub REST Search API",
    blacklist: dict | None = None,
    aliases: dict | None = None,
) -> dict:
    """主构图流程：精确命中 -> 剔除黑名单/新识别的噪声作者 -> 去重 -> 分类 -> 连线 -> 裁剪。
    blacklist 是已判定的噪声作者，一旦判定长期生效（data/noise-blacklist.json）。
    aliases（旧名 -> 现名）默认读 data/cache/aliases.json；跨语言一致性校验必须传 {} 不读盘 ——
    冻结的 JS 参照物不经过别名表，读盘会把本机检测过的改名混进比对。"""
    tag_totals = tag_totals or {}
    blacklist = dict(blacklist or {})
    nodes: list[dict] = []
    seen: dict[str, dict] = {}
    skipped_blacklisted = 0
    # 只有名字命中 dsh、却无描述也无主题标签的仓库不收录：分类器无从下手，画进图里是纯噪点。
    # 只计数不逐个记录（excludedNotPlugin 留给"非 DSH 语境"这类需要复核的）。
    no_signal_desc_chars = 10  # 与 non_plugin_reason 里"没有描述"的判据保持一致
    skipped_no_signal = 0
    excluded_repos: dict[str, str] = {}

    if aliases is None:
        aliases = load_aliases()
    for raw in raw_repos:
        repo = normalize_repo(raw)
        if aliases and str(repo.get("id")) in aliases:
            fixed = aliases[str(repo["id"])]
            repo = dict(repo, id=fixed, name=fixed.split("/")[-1], htmlUrl="https://github.com/" + fixed)
        if owner_of(repo) in blacklist:
            skipped_blacklisted += 1
            continue
        if not repo["topics"] and len(str(repo.get("description") or "").strip()) < no_signal_desc_chars:
            skipped_no_signal += 1
            continue
        # 非 DSH 语境（例如 DSH 指 Deep Supervised Hashing）直接不进索引
        not_plugin = non_plugin_reason(repo)
        if not_plugin:
            excluded_repos[str(repo.get("id") or repo.get("name") or "?")] = not_plugin
            continue
        matched = [t for t in WHITELIST_TAGS if t in repo["topics"]]
        # 命中白名单 topic 或名字带 dsh- 都收录（很多插件没打标签，靠名字收录，matchedTags 为空）
        by_name = bool(_NAME_DASH_RE.search(str(repo.get("name") or "")))
        if (not matched and not by_name) or not repo["id"]:
            continue
        matched.sort(key=WHITELIST_TAGS.index)
        # 稳定身份是 githubId（改名不变），老记录退回 id；改名前后两条并存时，展示采用更新的那条。
        key = str(repo.get("githubId") or repo["id"])
        if key in seen:
            prev = seen[key]
            prev["matchedTags"] = sorted(set(prev["matchedTags"]) | set(matched), key=WHITELIST_TAGS.index)
            if str(repo.get("updatedAt") or "") > str(prev.get("updatedAt") or ""):
                for field in ("id", "githubId", "name", "owner", "ownerType", "avatar", "htmlUrl"):
                    if repo.get(field) is not None:
                        prev[field] = repo[field]
            continue
        repo["matchedTags"] = matched
        repo["primaryTag"] = matched[0] if matched else NAME_TAG
        verdict = analyze_relevance(repo)
        rel = verdict["relevance"]
        repo["relevance"] = rel
        repo["noise"] = min(1.0, max(0.0, 1 - rel / 5))
        repo["review"] = verdict["review"]
        repo["verdict"] = verdict["verdict"]
        repo["reason"] = verdict["reason"]
        seen[key] = repo
        nodes.append(repo)

    # 本轮新识别的噪声作者：连同它们的仓库一起剔除，并并入黑名单长期生效
    detected = find_noise_owners(nodes)
    noise_removed = 0
    if detected:
        keep = {owner: info for owner, info in detected.items() if owner not in blacklist}
        blacklist.update(detected)
        if keep:
            noise_removed = sum(info["repos"] for info in keep.values())
        nodes = [n for n in nodes if n["owner"] not in detected]

    # 策展认定的生态基座（tools/ecosystem.json）直接归入协议基座，下面建共鸣边时复用同一份清单
    ecosystem = load_ecosystem()
    categories = apply_categories(nodes, base_ids=set(ecosystem.keys()))

    # ---------- 连线 ----------
    edge_map: dict[tuple, dict] = {}

    def add_edge(a: str, b: str, kind: str, via: str, directed: bool = False) -> None:
        # topic/owner/fork 是对等关系，按字母序归一化去重；resonance 是"基座 → 插件"的有向边，
        # 必须保留方向，否则字母序在前的插件会被翻转成反向边。
        src, dst = (a, b) if (directed or a < b) else (b, a)
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

    # 生态共鸣：基座 → 长在它上面的插件（人工策展 + README 复核，不是规则推导）
    resonance_edges = 0
    node_ids = {n["id"] for n in nodes}
    for base_id, info in ecosystem.items():
        if not info["enabled"] or base_id not in node_ids:
            continue
        for child in info["children"]:
            if child["id"] == base_id or child["id"] not in node_ids:
                continue
            add_edge(base_id, child["id"], "resonance", info["label"] or "生态共鸣", directed=True)
            resonance_edges += 1

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
            # 三档结论计数（manual 已从"疑似噪声"里收敛出来）
            "verdictCounts": {
                "related": sum(1 for n in nodes if n.get("verdict") == "related"),
                "noise": sum(1 for n in nodes if n.get("verdict") == "noise"),
                "manual": sum(1 for n in nodes if n.get("verdict") == "manual"),
            },
            # 黑名单长期生效（人工可从 data/noise-blacklist.json 删条目解除）；excludedNotPlugin* 是"非 DSH 语境"排除。
            "resonanceEdges": resonance_edges,
            "ecosystemBases": sorted(k for k, v in ecosystem.items() if v["enabled"]),
            "ecosystemDisabled": sorted(k for k, v in ecosystem.items() if not v["enabled"]),
            "excludedNotPlugin": dict(sorted(excluded_repos.items())),
            "excludedNotPluginCount": len(excluded_repos),
            "noSignalSkipped": skipped_no_signal,
            "noiseBlacklist": dict(sorted(blacklist.items())),
            "noiseBlacklistSize": len(blacklist),
            "noiseNodesRemoved": noise_removed,
            "noiseSkipped": skipped_blacklisted,
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
