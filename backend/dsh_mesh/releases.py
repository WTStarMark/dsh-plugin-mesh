"""版本（releases）采集：按仓库单独取，1 个仓库 = 1 次 core 配额请求。

盘上原本没有任何版本数据（搜索接口不返回 releases），而 issue #1 要"列出版本及对应信息"。

配额现实（本机实测）：主配额按【认证身份】算一个桶，同一账号的多个令牌共享 —— 堆令牌不扩容，
所以只有两条路：**限量**（每轮预算）与**排优先级**（先抓最可能发版的仓库）。

存法：`data/cache/releases.json`，每个仓库只留最近 keep 个版本的四个字段
（tag / 名称 / 发布时间 / 是否预发布）。原始响应 60~95KB/仓库，精简后约 560B。
"""

from __future__ import annotations

import calendar
import json
import os
import time
from pathlib import Path

from .build import utcnow

# 每个仓库留几个版本。放 20 是为了"周更新热榜按发版判定"能数准一周的版本数
# （留 5 时，一周发版超过 5 次的项目会被截在 5）。代价是拉取体积：
# per_page=20 平均约 320KB/仓库（版本说明很长），按每轮 300 个仓库算 ≈ 93MB/轮
# —— 嫌带宽大就调小 --releases-budget，别调小这个上限（否则周榜计数又会被截）。
RELEASES_KEEP = 20
# 刷新策略（2026-10-09 修）：旧口径只有"REFRESH_DAYS 之内不重抓"，于是抓过一次的仓库
# 会被硬压 3 天 —— 一天发好几个版本的高频项目（周更新热榜的主力）因此长期少算，
# 线上实例：xling001/dsh-reading-companion 10-08 发了 4 个版本，榜单却停在 10-07。
REFRESH_DAYS = 3.0  # 冷仓库（近 RECENT_RELEASE_DAYS 天没有版本）：抓过这么久才重抓
ACTIVE_REFRESH_HOURS = 6.0  # 活跃发版仓库（缓存里近 7 天有版本）：至多放这么久
RECENT_RELEASE_DAYS = 7.0  # "还在发版"的判定窗口，与周榜窗口同量级
RECENT_PUSH_DAYS = 7.0  # "近 7 天推过"的仓库优先：最可能刚发版
DISCOVERY_SHARE = 0.25  # 预算里留给"从没抓过"的份额，否则新仓库永远排在有缓存的后面
CORE_FLOOR = 300  # core 配额剩这么少就收手，别把 README/详情的份吃掉


def load_releases(path: Path) -> dict:
    """读版本缓存。文件不存在或损坏都当空表 —— 绝不因为一个缓存文件中断采集。"""
    empty = {"updatedAt": None, "keep": RELEASES_KEEP, "repos": {}}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("repos"), dict):
        return empty
    repos = {}
    for repo_id, entry in data["repos"].items():
        if isinstance(entry, dict) and isinstance(entry.get("releases"), list):
            repos[str(repo_id)] = {"at": entry.get("at"), "releases": entry["releases"]}
    return {"updatedAt": data.get("updatedAt"), "keep": int(data.get("keep") or RELEASES_KEEP), "repos": repos}


def save_releases(payload: dict, path: Path) -> int:
    """原子写：临时文件 + replace，进程被杀也不会留下半截缓存。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    # 文件里的 keep 描述的是"当前保留策略"，不能沿用旧文件里的值（否则上限调大了它还写着旧数）
    payload["keep"] = RELEASES_KEEP
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return len(text)


def slim_releases(payload, keep: int = RELEASES_KEEP) -> list[dict]:
    """把 GitHub 的 releases 响应裁成"版本列表"要用的最小字段。

    draft 直接丢掉：草稿只有仓库有权者能看到，公开抓取本来也拿不到。
    """
    out = []
    for item in payload or []:
        if not isinstance(item, dict) or item.get("draft"):
            continue
        out.append(
            {
                "tag": str(item.get("tag_name") or "")[:80],
                "name": str(item.get("name") or "")[:80],
                "at": str(item.get("published_at") or item.get("created_at") or "")[:10],
                "pre": bool(item.get("prerelease")),
            }
        )
        if len(out) >= keep:
            break
    return out


def put(payload: dict, repo_id: str, releases: list[dict], *, now: str | None = None) -> None:
    """原地写入一个仓库的结果（抓取循环用；别用 merge，那是给纯测试用的）。"""
    payload.setdefault("repos", {})[repo_id] = {"at": now or utcnow(), "releases": releases}
    payload["updatedAt"] = now or utcnow()


def merge(payload: dict, repo_id: str, releases: list[dict], *, now: str | None = None) -> dict:
    """把一个仓库的抓取结果并进缓存（整体覆盖该仓库，不追历史）。"""
    repos = dict(payload.get("repos") or {})
    repos[repo_id] = {"at": now or utcnow(), "releases": releases}
    return {"updatedAt": now or utcnow(), "keep": payload.get("keep") or RELEASES_KEEP, "repos": repos}


def _age_days(iso: str | None, now_ts: float) -> float:
    """ISO(UTC) 距今多少天。用 timegm 而不是 mktime：后者按本地时区解释，会整体偏 8 小时。"""
    try:
        return (now_ts - calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))) / 86400
    except (ValueError, TypeError):
        return 1e9


def _ts(iso: str | None) -> float | None:
    """ISO(UTC) -> epoch 秒；解析不了返回 None。用来比"这次抓取之后仓库又推过没有"。"""
    try:
        return float(calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S")))
    except (ValueError, TypeError):
        return None


def _window_release_count(entry: dict | None, now_ts: float, days: float = RECENT_RELEASE_DAYS) -> int:
    """缓存里"最近 days 天内发布"的版本数。0 = 近期没发版（含从没抓到过）。"""
    count = 0
    for item in (entry or {}).get("releases") or []:
        at = _ts(str((item or {}).get("at") or "")[:10] + "T00:00:00")
        if at is not None and (now_ts - at) / 86400 <= days:
            count += 1
    return count


def pick_candidates(
    payload: dict,
    nodes,
    *,
    limit: int,
    now_ts: float | None = None,
    refresh_days: float = REFRESH_DAYS,
    active_hours: float = ACTIVE_REFRESH_HOURS,
    discovery_share: float = DISCOVERY_SHARE,
) -> list[str]:
    """挑这一轮该抓哪些仓库（按优先级排序，最多 limit 个）。

    优先级（同一档内先按"缓存里近 7 天的版本数"降序 —— 周榜就是照它排的，
    再按最近一次推送的新鲜度、星标降序）：
      4) 上次抓取之后仓库又推过，且缓存里近 7 天有版本 —— 板上竞品，且已知有新动静
      3) 上次抓取之后又推过 —— 很可能刚发了新版
      2) 近 7 天发过版、缓存已超过 active_hours —— 高频发版仓库不能压满 refresh_days
      1) 冷仓库（近 7 天没有版本）且缓存超过 refresh_days
      0) 从没抓过 —— 单独留 discovery_share 的预算，否则永远排在有缓存的仓库后面
    归档仓库直接跳过（不会发新版）。
    """
    now_ts = now_ts if now_ts is not None else time.time()
    repos = payload.get("repos") or {}
    hot: list[tuple[int, int, float, int, str]] = []
    never: list[tuple[int, int, str]] = []
    for node in nodes or []:
        repo_id = node.get("id")
        if not repo_id or node.get("archived"):
            continue
        pushed_ts = _ts(node.get("pushedAt"))
        recent = 1 if pushed_ts is not None and (now_ts - pushed_ts) / 86400 <= RECENT_PUSH_DAYS else 0
        stars = int(node.get("stars") or 0)
        entry = repos.get(repo_id)
        if not entry:
            never.append((recent, stars, repo_id))
            continue
        fetched_ts = _ts(entry.get("at"))
        age_days = (now_ts - fetched_ts) / 86400 if fetched_ts is not None else 1e9
        in_window = _window_release_count(entry, now_ts)
        pushed_after = pushed_ts is not None and fetched_ts is not None and pushed_ts > fetched_ts
        if pushed_after and in_window:
            tier = 4
        elif pushed_after:
            tier = 3
        elif in_window and age_days >= active_hours / 24.0:
            tier = 2
        elif age_days >= refresh_days:
            tier = 1
        else:
            continue  # 还新鲜，跳过
        hot.append((tier, in_window, -(pushed_ts or 0.0), stars, repo_id))
    hot.sort(key=lambda item: (-item[0], -item[1], item[2], -item[3], item[4]))
    never.sort(key=lambda item: (-item[0], -item[1], item[2]))

    limit = max(0, int(limit))
    if limit == 0:
        return []
    # 预算切分：两类都有时，给"从没抓过"的留一份，剩下的按上面的档位排
    quota = min(len(never), limit, max(1, int(round(limit * discovery_share)))) if (hot and never) else 0
    hot_ids = [item[4] for item in hot]
    never_ids = [item[2] for item in never]
    picked = hot_ids[: limit - quota] + never_ids[:quota]
    if len(picked) < limit:  # 一边不够就用另一边补齐
        picked += (hot_ids[limit - quota :] + never_ids[quota:])[: limit - len(picked)]
    return picked


def stats(payload: dict) -> dict:
    """缓存概况（进 last-crawl / 状态文件用，只有数字）。"""
    repos = payload.get("repos") or {}
    with_releases = sum(1 for entry in repos.values() if entry.get("releases"))
    versions = sum(len(entry.get("releases") or []) for entry in repos.values())
    return {"repos": len(repos), "withReleases": with_releases, "versions": versions}
