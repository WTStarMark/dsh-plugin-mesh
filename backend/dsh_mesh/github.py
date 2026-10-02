"""GitHub 搜索 API 客户端：令牌、限流、退避重试、按星标分片翻页。

为什么必须分片：GitHub 搜索接口对任何查询最多只返回 1000 条结果
（per_page=100 时就是 10 页）。topic:dsh-plugin 有 1.6 万+ 个仓库，
不分片就永远只能拿到前 1000 个，而且**不会报错**——这是最容易踩的坑。
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .config import API_ROOT, ENV_FILE, STAR_SLICES, USER_AGENT

MAX_PER_QUERY = 1000  # GitHub 搜索接口的硬上限


def load_token(path: Path = ENV_FILE) -> str | None:
    """从 .env 读取令牌。只返回值，绝不打印内容。"""
    if not path.exists():
        return None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() in ("GITHUB_TOKEN", "GH_TOKEN"):
            token = value.strip().strip("'\"")
            if token:
                return token
    return None


@dataclass
class CrawlStats:
    """一次采集的配额与请求统计，写进 last-crawl.json 供溯源。"""

    requests: int = 0
    retries: int = 0
    pages: int = 0
    items: int = 0
    truncated_slices: list[str] = field(default_factory=list)
    rate_limit_remaining: int | None = None
    seconds: float = 0.0

    def as_dict(self) -> dict:
        return {
            "requests": self.requests,
            "retries": self.retries,
            "pages": self.pages,
            "items": self.items,
            "truncatedSlices": self.truncated_slices,
            "rateLimitRemaining": self.rate_limit_remaining,
            "seconds": round(self.seconds, 1),
        }


class GitHubClient:
    """极简搜索客户端：够用就好，不做通用封装。"""

    def __init__(self, token: str | None = None, sleep=time.sleep, dry_run: bool = False):
        self.token = token
        self._sleep = sleep
        self.dry_run = dry_run
        self.stats = CrawlStats()
        self._search_limit_reset: float | None = None

    # ---------- 底层请求 ----------
    def _headers(self) -> dict:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
            "Accept-Encoding": "gzip",
        }
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        return headers

    def _request(self, url: str, attempt: int = 0) -> dict:
        if self.dry_run:
            raise RuntimeError("dry-run 模式不应发起真实请求")
        req = urllib.request.Request(url, headers=self._headers())
        try:
            self.stats.requests += 1
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                remaining = resp.headers.get("X-RateLimit-Remaining")
                if remaining is not None:
                    self.stats.rate_limit_remaining = int(remaining)
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as err:
            # 有些环境下 HTTPError 没有可读的 body（fp 为空），读失败也不能把重试路径带崩
            try:
                body = err.read().decode("utf-8", "replace")[:200]
            except Exception:
                body = "<无响应体>"
            # 403/429：限流或二级限流，按官方建议退避
            if err.code in (403, 429) and attempt < 5:
                self.stats.retries += 1
                wait = self._retry_delay(err, attempt)
                self._sleep(wait)
                return self._request(url, attempt + 1)
            if err.code >= 500 and attempt < 3:
                self.stats.retries += 1
                self._sleep(2 ** attempt)
                return self._request(url, attempt + 1)
            raise RuntimeError(f"GitHub 返回 {err.code}：{body}") from err

    def _retry_delay(self, err: urllib.error.HTTPError, attempt: int) -> float:
        retry_after = err.headers.get("Retry-After") if err.headers else None
        if retry_after:
            try:
                return max(1.0, float(retry_after)) + 1
            except ValueError:
                pass
        reset = err.headers.get("X-RateLimit-Reset") if err.headers else None
        if reset:
            try:
                return max(1.0, float(reset) - time.time()) + 2
            except ValueError:
                pass
        return min(60.0, 5.0 * (2 ** attempt))

    # ---------- 搜索 ----------
    def search(self, query: str, page: int = 1, per_page: int = 100, sort: str = "stars") -> dict:
        url = (
            f"{API_ROOT}/search/repositories?q={urllib.parse.quote(query)}"
            f"&sort={sort}&order=desc&per_page={per_page}&page={page}"
        )
        payload = self._request(url)
        self.stats.pages += 1
        self.stats.items += len(payload.get("items", []))
        return payload

    def crawl_segment(self, query: str, max_pages: int = 10, log=print) -> tuple[list[dict], int]:
        """抓一个分段：返回（裁剪后的记录, 接口报告总数）。

        到 GitHub 的 1000 条上限就停；上限之外的由上层把该段再细分（见 segments.subdivide）。
        """
        from .build import pick_repo  # 延迟导入避免循环依赖

        out: list[dict] = []
        total = 0
        for page in range(1, max_pages + 1):
            payload = self.search(query, page=page)
            items = payload.get("items") or []
            if page == 1:
                total = payload.get("total_count", 0)
            out.extend(pick_repo(item) for item in items)
            if len(items) < 100:
                break
            if page * 100 >= min(total, MAX_PER_QUERY):
                break
        log("  " + query + " → " + str(len(out)) + " 条（接口报告 " + str(total) + "）")
        return out, total

    def crawl_tag(self, tag: str, max_pages_per_slice: int = 10, sliced: bool = True, log=print) -> tuple[list[dict], int]:
        """抓一个标签下的仓库（按星标分片翻页）。

        返回 (原始记录, 该标签的接口报告总数)。分片的星标区间互不重叠，
        因此各分片的 total_count 之和就是该标签的真实总数。
        """
        queries = [f"topic:{tag} {s}" for s in STAR_SLICES] if sliced else [f"topic:{tag}"]
        out: list[dict] = []
        total_count = 0
        for query in queries:
            first_page = True
            for page in range(1, max_pages_per_slice + 1):
                payload = self.search(query, page=page)
                items = payload.get("items") or []
                out.extend(items)
                if first_page:
                    total_count += payload.get("total_count", 0)
                    first_page = False
                if len(items) < 100:
                    break
                # 命中数超过接口 1000 条上限时分页会静默截断，必须如实记一笔
                if page * 100 >= min(payload.get("total_count", 0), MAX_PER_QUERY):
                    if payload.get("total_count", 0) > MAX_PER_QUERY:
                        self.stats.truncated_slices.append(query)
                    break
            log(f"  [{tag}] {query} 累计 {len(out)} 条")
        return out, total_count
