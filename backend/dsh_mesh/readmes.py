"""README 文本索引：支撑「搜索仓库 README 内容」。
README 正文太大，塞不进前端契约：采集器每轮按预算抓一小批（可断点续跑），截断后落盘
data/cache/readmes.json.gz，站点 API（tools/api.mjs）读同一文件做子串检索，浏览器只拿命中 id 去高亮。
体积三层压缩：只留检索摘要（去徽章/URL/HTML/markdown 记号，实测 ~3.9KB→~1.6KB 且匹配更准）、
截断到 MAX_CHARS（关键信息在前半段）、gzip 落盘（19k 仓库约 10MB）。抓不到的记空串，避免每轮重试 404。
"""

from __future__ import annotations

import gzip
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .segments import _atomic_write

MAX_CHARS = 2000
REFRESH_DAYS = 45
_BADGE_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_HTML_TAG = re.compile(r"<[^>]+>")
_URL = re.compile(r"https?://\S+")
_MD_MARKS = re.compile(r"[#*`>|_~]{1,}")
_WS = re.compile(r"\s+")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).strftime("%Y-%m-%dT%H:%M:%SZ")


class ReadmeIndex:
    """README 文本索引（一个 JSON 文件：{updatedAt, count, maxChars, docs}）。"""

    def __init__(self, path: Path, max_chars: int = MAX_CHARS):
        self.path = Path(path)
        self.max_chars = max_chars
        self.docs: dict[str, dict] = {}
        self._load()

    # ---------- 读写 ----------
    def _load(self) -> None:
        self.docs = {}
        for candidate in self._read_paths():
            try:
                if str(candidate).endswith(".gz"):
                    raw = gzip.decompress(candidate.read_bytes())
                else:
                    raw = candidate.read_bytes()
                data = json.loads(raw.decode("utf-8"))
            except (OSError, json.JSONDecodeError, EOFError):
                continue
            docs = data.get("docs") if isinstance(data, dict) else None
            if isinstance(docs, dict):
                self.docs = docs
                return

    def _read_paths(self) -> list[Path]:
        """优先读 .gz；同时兼容老的 .json（迁移期两种都可能存在）。"""
        base = str(self.path)
        paths = [self.path]
        if base.endswith(".gz"):
            paths.append(Path(base[:-3]))
        else:
            paths.append(Path(base + ".gz"))
        return [p for p in paths if p.exists()]

    def save(self) -> None:
        payload = {
            "updatedAt": _iso(),
            "count": len(self.docs),
            "maxChars": self.max_chars,
            "docs": self.docs,
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if str(self.path).endswith(".gz"):
            _atomic_write(self.path, gzip.compress(body, 9))
        else:
            _atomic_write(self.path, body)

    # ---------- 文本处理 ----------
    def normalize(self, text: str | None) -> str:
        """README 原文 → 检索摘要（见模块顶部"体积控制"）。空/None 一律记成空串。"""
        if not text:
            return ""
        cleaned = "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)
        cleaned = _BADGE_IMG.sub(" ", cleaned)
        cleaned = _MD_LINK.sub(r"\1", cleaned)  # 链接保留可见文字，丢掉 URL
        cleaned = _HTML_TAG.sub(" ", cleaned)
        cleaned = _URL.sub(" ", cleaned)
        cleaned = _MD_MARKS.sub(" ", cleaned)
        cleaned = _WS.sub(" ", cleaned).strip()
        return cleaned[: self.max_chars]

    # ---------- 队列 ----------
    def needs(self, repos: list[dict], limit: int, refresh_days: int = REFRESH_DAYS) -> list[dict]:
        """挑出这一轮该抓的仓库：先没抓过的（星标高优先），再过期的（久没刷新的优先）。"""
        if limit <= 0:
            return []
        fresh: list[dict] = []
        stale: list[tuple[str, dict]] = []
        cutoff = _iso(_now() - timedelta(days=refresh_days))
        for repo in repos:
            rid = str(repo.get("id") or "")
            if not rid:
                continue
            doc = self.docs.get(rid)
            if doc is None:
                fresh.append(repo)
                continue
            fetched = str(doc.get("f") or "")
            if fetched < cutoff:
                stale.append((fetched, repo))
        fresh.sort(key=lambda r: -(r.get("stars") or 0))
        stale.sort(key=lambda item: item[0])
        picked = fresh[:limit]
        if len(picked) < limit:
            picked.extend(repo for _, repo in stale[: limit - len(picked)])
        return picked

    def put(self, repo_id: str, text: str | None, fetched_at: str | None = None) -> None:
        self.docs[str(repo_id)] = {"t": self.normalize(text), "f": fetched_at or _iso()}

    def count_in(self, ids) -> int:
        """这些 id 里有多少个已经有 README。
        面板分子只算可索引池；缓存总量含早期抓过、现已不达标的仓库，直接用会出 14513/14490 这种怪值。"""
        return sum(1 for rid in ids if str(rid) in self.docs)

    def stats(self) -> dict:
        chars = sum(len(d.get("t") or "") for d in self.docs.values())
        empty = sum(1 for d in self.docs.values() if not (d.get("t") or ""))
        return {"count": len(self.docs), "empty": empty, "chars": chars, "maxChars": self.max_chars}


def fetch_batch(client, index: ReadmeIndex, repos: list[dict], budget: int, log=print) -> dict:
    """按预算抓一批 README 并落盘。返回本轮统计（供采集日志与 meta 使用）。"""
    todo = index.needs(repos, budget)
    if not todo:
        log("README 索引：本轮无需抓取（共 " + str(index.stats()["count"]) + " 个已索引）")
        return {"requested": 0, "fetched": 0, "empty": 0, "indexed": index.stats()["count"]}
    fetched = 0
    empty = 0
    # 这里**不**吞异常：单个失败让整批抛给 collect.py 的护栏（记一行"本轮失败"后继续跑），
    # 测试 test_readme_fetch_failure_does_not_break_collector 钉住了这个契约。
    for i, repo in enumerate(todo, 1):
        text = client.readme(str(repo["id"]))
        if text:
            fetched += 1
        else:
            empty += 1
        index.put(str(repo["id"]), text)
        if i % 25 == 0:
            index.save()  # 长任务可断点续跑
    index.save()
    stats = index.stats()
    disk = index.path.stat().st_size if index.path.exists() else 0
    log(
        "README 索引：本轮抓 " + str(len(todo)) + " 个（成功 " + str(fetched) + " · 无 README " + str(empty)
        + "）· 累计 " + str(stats["count"]) + " 个 / 摘要 " + str(round(stats["chars"] / 1024))
        + " KB / 磁盘 " + str(round(disk / 1024)) + " KB"
    )
    return {"requested": len(todo), "fetched": fetched, "empty": empty, "indexed": stats["count"]}
