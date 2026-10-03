"""分段扫描：把"一轮抓完"改成"每轮抓一部分"，最终覆盖全部仓库。

为什么必须这样：
  - GitHub 搜索接口【单个查询最多返回 1000 条】，topic:dsh-plugin 有 1.7 万个仓库，
    一轮硬抓既超配额又必然截断；
  - 因此把抓取空间切成"段"（topic × 星标区间，必要时再按创建时间细分），
    每轮只刷新最久没动的一批，结果并入【累积索引】；
  - 累积索引保存"所有见过的仓库"，前端因此最终能看到全部项目仓库。

状态文件：
  data/cache/segments.json   每段的抓取时间与计数（可断点续跑）
  data/cache/repos.json      累积索引（前端数据的唯一来源）
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import STAR_SLICES

MAX_PER_QUERY = 1000  # GitHub 搜索接口硬上限
SCHEMA_VERSION = 1
_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")


def segment_query(segment: dict) -> str:
    stars = segment["stars"]
    if not stars.startswith("stars:"):
        stars = "stars:" + stars  # 兼容两种存法：带前缀（config 里的原样）或不带
    parts = ["topic:" + segment["topic"], stars]
    if segment.get("created"):
        parts.append("created:" + segment["created"])
    return " ".join(parts)


def owner_of(record: dict) -> str:
    """从原始 API 记录或裁剪过的记录里取作者名（两种形态都要认）。"""
    owner = record.get("owner")
    if isinstance(owner, dict):
        return str(owner.get("login") or "")
    if isinstance(owner, str):
        return owner
    full = str(record.get("full_name") or record.get("id") or "")
    return full.split("/")[0] if "/" in full else ""


def segment_key(topic: str, stars: str, created: str | None = None) -> str:
    return "|".join(["topic:" + topic, "stars:" + stars, "created:" + (created or "*")])


def seed_segments(tags: list[str]) -> list[dict]:
    """初始段：每个标签 × 每个星标区间。"""
    out = []
    for topic in tags:
        for stars in STAR_SLICES:
            out.append({"key": segment_key(topic, stars), "topic": topic, "stars": stars, "created": None, "level": 0})
    return out


def _days_in_month(year: int, month: int) -> int:
    if month == 2 and year % 4 == 0:
        return 29
    return _DAYS[month - 1]


def _window_start(created: str | None) -> tuple[int, int]:
    text = created or "2014-01-01"
    return int(text[:4]), int(text[5:7])


def _split_created(created: str | None) -> tuple[str, str]:
    start, _, end = (created or "2014-01-01..2014-01-31").partition("..")
    return start, (end or start)


def subdivide(segment: dict, now: datetime | None = None) -> list[dict]:
    """把命中数超过 1000 的段按创建时间细分：星标区间 → 年 → 季度 → 月 → 半月 → 日。

    日粒度才是叶子。此前把"月"当叶子，导致热门月份的段被整段截断
    （实测 7 段共漏掉 1.5 万个仓库），所以必须继续往下切。
    """
    now = now or utcnow()
    level = segment.get("level", 0)
    windows: list[tuple[str, int]] = []
    if level == 0:
        for year in range(2014, now.year + 1):
            windows.append((f"{year}-01-01..{year}-12-31", 1))
    elif level == 1:
        year, _ = _window_start(segment.get("created"))
        for quarter in range(1, 5):
            first = (quarter - 1) * 3 + 1
            last = first + 2
            windows.append((f"{year}-{first:02d}-01..{year}-{last:02d}-{_days_in_month(year, last):02d}", 2))
    elif level == 2:
        year, first_month = _window_start(segment.get("created"))
        for month in range(first_month, first_month + 3):  # 季度 -> 三个月，一个都不能少
            windows.append((f"{year}-{month:02d}-01..{year}-{month:02d}-{_days_in_month(year, month):02d}", 3))
    elif level == 3:
        # 月 -> 上半月 / 下半月
        start, end = _split_created(segment.get("created"))
        year, month = int(start[:4]), int(start[5:7])
        last_day = int(end[8:10])
        middle = min(15, last_day)
        windows.append((f"{year}-{month:02d}-01..{year}-{month:02d}-{middle:02d}", 4))
        if last_day > middle:
            windows.append((f"{year}-{month:02d}-{middle + 1:02d}..{year}-{month:02d}-{last_day:02d}", 4))
    elif level == 4:
        # 半月 -> 逐日
        start, end = _split_created(segment.get("created"))
        year, month = int(start[:4]), int(start[5:7])
        for day in range(int(start[8:10]), int(end[8:10]) + 1):
            windows.append((f"{year}-{month:02d}-{day:02d}..{year}-{month:02d}-{day:02d}", 5))
    else:
        return []  # 日粒度是叶子

    return [
        {
            "key": segment_key(segment["topic"], segment["stars"], created),
            "topic": segment["topic"],
            "stars": segment["stars"],
            "created": created,
            "level": child_level,
        }
        for created, child_level in windows
    ]


class SegmentStore:
    """段队列 + 累积索引。两个文件都可断点续跑。"""

    def __init__(self, state_path: Path, repos_path: Path, blacklist=None):
        self.state_path = state_path
        self.repos_path = repos_path
        self.state = self._load_state()
        self.repos: dict[str, dict] = self._load_repos()
        # 噪声作者黑名单：这些 owner 的仓库一律不进累积索引（省配额、也省得再被剔除一次）
        self.blacklist: set[str] = set(blacklist or ())

    def _load_state(self) -> dict:
        if self.state_path.exists():
            try:
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
                if data.get("version") == SCHEMA_VERSION:
                    return data
            except (OSError, json.JSONDecodeError):
                pass
        return {"version": SCHEMA_VERSION, "updatedAt": None, "segments": {}}

    def _load_repos(self) -> dict[str, dict]:
        if self.repos_path.exists():
            try:
                return json.loads(self.repos_path.read_text(encoding="utf-8")).get("repos", {})
            except (OSError, json.JSONDecodeError):
                pass
        return {}

    def save(self) -> None:
        """落盘。顺序很重要：【先写仓库数据，后写队列状态】。

        如果反过来，进程在两次写入之间被杀（pm2 重启、Ctrl-C、OOM），
        队列会记着"这些段抓完了"，而抓到的仓库却没落盘 —— 数据就永久丢了。
        两次写入都用临时文件 + 原子替换，任何时刻被杀都不会留下半截 JSON。
        """
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state["updatedAt"] = iso()
        _atomic_write(
            self.repos_path,
            json.dumps({"updatedAt": iso(), "count": len(self.repos), "repos": self.repos}, ensure_ascii=False, separators=(",", ":")),
        )
        _atomic_write(self.state_path, json.dumps(self.state, ensure_ascii=False, separators=(",", ":")))

    def ensure_seeded(self, tags: list[str]) -> int:
        added = 0
        for segment in seed_segments(tags):
            if segment["key"] not in self.state["segments"]:
                self.state["segments"][segment["key"]] = dict(segment, state="pending", fetchedAt=None, count=0, total=None)
                added += 1
        return added

    def pending_summary(self) -> dict:
        segs = list(self.state["segments"].values())
        return {
            "total": len(segs),
            "pending": sum(1 for s in segs if s.get("state") == "pending"),
            "done": sum(1 for s in segs if s.get("state") == "done"),
            "split": sum(1 for s in segs if s.get("state") == "split"),
        }

    def next_batch(self, budget_requests: int, refresh_hours: float, log=print, refresh_share: float = 0.25) -> list[dict]:
        """挑这一轮要抓的段，顺序固定为【先检索新仓库，后更新旧仓库】。

        - 发现阶段：从没抓过的段（state=pending）优先，且优先吃预算；
        - 更新阶段：已抓过但超过 refresh_hours 没刷新的段，按最久未更新排序；
          只要还有没抓过的段，更新阶段最多分到 refresh_share 的预算（避免旧仓库一直抢占新仓库的额度）。
        """
        stale_before = utcnow() - timedelta(hours=refresh_hours)
        discovering = [s for s in self.state["segments"].values() if s.get("state") == "pending"]
        discovering.sort(key=lambda s: (s.get("level", 0), s.get("key", "")))
        refreshing = [
            s
            for s in self.state["segments"].values()
            if s.get("state") == "done" and (s.get("fetchedAt") is None or _parse(s["fetchedAt"]) < stale_before)
        ]
        refreshing.sort(key=lambda s: s.get("fetchedAt") or "")

        unlimited = budget_requests <= 0
        has_refresh = bool(refreshing)
        # 预算显式切两段：有旧仓库要更新时，给发现阶段留 (1 - refresh_share)，
        # 否则发现阶段会吃光预算，旧仓库的星标永远刷不到。
        refresh_budget = 0 if unlimited or not has_refresh else max(1, int(budget_requests * refresh_share))
        discover_budget = budget_requests if unlimited or not has_refresh else max(1, budget_requests - refresh_budget)

        # 注意：两个阶段都至少要取一段。否则预算小于单段估算（10 次请求）时会一段都不抓、整轮空转。
        batch: list[dict] = []
        spent = 0
        for segment in discovering:
            pages = _estimate_pages(segment)
            if not unlimited and batch and spent + pages > discover_budget:
                break
            batch.append(segment)
            spent += pages
        refresh_batch: list[dict] = []
        refresh_spent = 0
        for segment in refreshing:
            pages = _estimate_pages(segment)
            if not unlimited and refresh_batch and refresh_spent + pages > refresh_budget:
                break
            refresh_batch.append(segment)
            refresh_spent += pages
        batch.extend(refresh_batch)

        log(
            "本轮选中 " + str(len(batch)) + " 段：发现新仓库 " + str(len(batch) - len(refresh_batch))
            + " 段 / 更新旧仓库 " + str(len(refresh_batch)) + " 段（预计 "
            + str(spent + refresh_spent) + " 次请求，预算 " + str(budget_requests) + "）"
        )
        return batch

    def mark(self, segment: dict, state: str, count: int = 0, total: int | None = None) -> None:
        stored = self.state["segments"].setdefault(segment["key"], dict(segment))
        stored.update({"state": state, "fetchedAt": iso(), "count": count, "total": total})

    def requeue_truncated(self, log=print) -> int:
        """把先前被截断的段按更细的时间粒度（月→半月→日）重新排队。

        细分层级是后来才加深的，已经跑过的截断段不会自动重来；这个方法让它们补扫。
        """
        items = list(self.state.get("truncated") or [])
        requeued = 0
        still: list[dict] = []
        for item in items:
            segment = self.state["segments"].get(item["key"])
            children = subdivide(segment) if segment else []
            if not children:
                still.append(item)
                continue
            for child in children:
                self.state["segments"].setdefault(child["key"], dict(child, state="pending", fetchedAt=None, count=0, total=None))
            self.mark(segment, "split", item.get("fetched", 0), item.get("total"))
            requeued += 1
        self.state["truncated"] = still
        if requeued:
            log("把 " + str(requeued) + " 个截断段按更细粒度重新排队（月 → 半月 → 日），补扫漏掉的仓库")
        return requeued

    def complete_segment(self, segment: dict, records: list[dict], total: int, log=print) -> dict:
        """抓完一段：命中数超上限就细分；已经细到月还超上限就如实记为截断。"""
        if total > MAX_PER_QUERY:
            children = subdivide(segment)
            if children:
                for child in children:
                    self.state["segments"].setdefault(child["key"], dict(child, state="pending", fetchedAt=None, count=0, total=None))
                self.mark(segment, "split", len(records), total)
                log("  段 " + segment["key"] + " 命中 " + str(total) + " 条，超出单查询上限，切成 " + str(len(children)) + " 个子段（按创建时间）")
                return {"split": True, "added": 0, "children": len(children)}
            added = self.merge(records)
            self.mark(segment, "done", len(records), total)
            self.state.setdefault("truncated", []).append({"key": segment["key"], "total": total, "fetched": len(records)})
            log("  ⚠ 段 " + segment["key"] + " 已细到月仍有 " + str(total) + " 条，本段只能取前 " + str(len(records)) + " 条（如实记账）")
            return {"split": False, "added": added, "children": 0, "truncated": True}
        added = self.merge(records)
        self.mark(segment, "done", len(records), total)
        return {"split": False, "added": added, "children": 0}

    def merge(self, records: list[dict]) -> int:
        added = 0
        for record in records:
            rid = record.get("id")
            if not rid:
                continue
            if self.blacklist and owner_of(record) in self.blacklist:
                continue  # 噪声作者：不进累积索引
            if rid not in self.repos:
                added += 1
            self.repos[rid] = record
        return added

    def drop_owners(self, owners) -> int:
        """把噪声作者从累积索引里删掉，并长期拉黑：之后的构建、快照、前端都不会再看到它们。"""
        targets = {str(o) for o in (owners or ()) if o}
        if not targets:
            return 0
        removed = [rid for rid, record in self.repos.items() if owner_of(record) in targets]
        for rid in removed:
            self.repos.pop(rid, None)
        self.blacklist |= targets
        return len(removed)

    def coverage(self) -> dict:
        return {"segments": self.pending_summary(), "repos": len(self.repos)}


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)  # 原子替换：要么是旧内容，要么是完整新内容


def _parse(value: str) -> datetime:
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return datetime(1970, 1, 1, tzinfo=timezone.utc)


def _estimate_pages(segment: dict) -> int:
    total = segment.get("total")
    if total is None:
        return 10
    return max(1, min(10, (min(total, MAX_PER_QUERY) + 99) // 100))
