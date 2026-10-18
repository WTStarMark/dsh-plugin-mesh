"""npm 反查发现：按关键词扫 npm registry 的搜索接口，把「仓库根没有 package.json、
插件住在仓库子目录」的包也找出来（例如 volcengine/OpenViking 的 examples/dsh-memory-plugin）。

为什么需要它：本图的收录单元是【GitHub 仓库】—— 发现靠 topic 搜索，npm 归属靠仓库根
package.json。插件住在 monorepo 子目录时，这两条路都看不见它；而 npm 的搜索接口能按
「包 → repository」反推到仓库，再借 packument 的 repository.directory 拿到子目录。

接口实测（2026-10-17，只读探测）：
  · /-/v1/search?text=keywords:<词>&size=250&from=N —— 单页最多 250 条，深翻页正常；
  · 关键词总量：deepseek-harness ≈ 10990、dsh-plugin ≈ 8775、dsh ≈ 10999；
  · 结果约 98% 带 links.repository，拿不到的整条跳过（绝不猜仓库）。
本模块【不做】相关性判定：关键词池是混杂池（dsh 也可能是别的缩写），精度过滤留给消费端
复用市场索引那套判据（声明了 dsh.bundle.patch，或依赖里有 @deepseek-ai/*）。

落盘只写 data/cache/npm-search.json（新文件），不碰 npm-downloads.json / mesh.json。
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .build import utcnow
from .config import USER_AGENT

SEARCH_URL = "https://registry.npmjs.org/-/v1/search"
PAGE_SIZE = 250  # npm 搜索接口单页上限（实测 250 有效）
# 关键词表：三个词覆盖 DSH 生态的常见写法。改这张表就等于改"能发现什么"，别随手加宽泛词。
DEFAULT_KEYWORDS = ["deepseek-harness", "dsh-plugin", "dsh"]
DEFAULT_BUDGET = 5000  # 每轮最多处理多少条搜索结果（≈ 20 页/轮），暂定值
TIMEOUT = 25
MAX_ATTEMPTS = 3
# 深翻页会重复甚至回卷：实测 from=5000 的四页里只有一半是不重复的包，from≈8500 之后直接跳回
# 搜索结果的开头。所以"连续两页零新增"就判定该关键词已扫尽（结果集见底或已回卷），不再烧请求。
STALE_PAGES = 2

_GITHUB_RE = re.compile(r"github\.com/([^/?#]+)/([^/?#]+)", re.I)


def repo_key(value) -> str | None:
    """把 npm 的 repository 字段收成 "owner/repo"（小写）。

    口径与 tools/market-index.mjs / tools/api.mjs 里的 repoKey 一致（那边也返回小写），
    这样跨来源比对时只需两边都小写 —— 注意本图的节点 id 是保留大小写的（volcengine/OpenViking）。
    """
    if isinstance(value, dict):
        value = value.get("url")
    if not isinstance(value, str) or not value.strip():
        return None
    url = value.strip()
    url = re.sub(r"^git\+", "", url)
    url = re.sub(r"^git@github\.com:", "https://github.com/", url, flags=re.I)
    url = re.sub(r"^ssh://git@github\.com/", "https://github.com/", url, flags=re.I)
    url = re.sub(r"^git://", "https://", url)
    url = re.sub(r"\.git$", "", url)
    hit = _GITHUB_RE.search(url)
    return (hit.group(1) + "/" + hit.group(2)).lower() if hit else None


def slim_object(obj) -> dict | None:
    """把一条搜索结果收成缓存记录；没有包名或没有 GitHub 仓库的返回 None（调用方计数）。"""
    pkg = obj.get("package") if isinstance(obj, dict) else None
    if not isinstance(pkg, dict):
        return None
    name = str(pkg.get("name") or "").strip()
    if not name:
        return None
    links = pkg.get("links") if isinstance(pkg.get("links"), dict) else {}
    raw_repo = links.get("repository")
    key = repo_key(raw_repo)
    if not key:
        return None
    kws = pkg.get("keywords")
    return {
        "name": name,
        "version": str(pkg.get("version") or ""),
        "description": str(pkg.get("description") or "")[:300],
        "keywords": [str(k) for k in (kws if isinstance(kws, list) else [])][:12],
        "repoUrl": str(raw_repo or ""),
        "repoKey": key,
        "publishedAt": str(pkg.get("date") or ""),
    }


def search_page(keyword: str, offset: int = 0, *, size: int = PAGE_SIZE, opener=None, sleep=time.sleep) -> dict:
    """取一页搜索结果：返回 {total, objects}。限流/5xx/连接抖动重试耗尽后抛 RuntimeError。"""
    query = urllib.parse.urlencode({"text": "keywords:" + str(keyword), "size": int(size), "from": max(0, int(offset))})
    url = SEARCH_URL + "?" + query
    open_fn = opener or urllib.request.urlopen
    last_err = None
    for attempt in range(MAX_ATTEMPTS):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with open_fn(req, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if not isinstance(data, dict):
                raise RuntimeError("npm 搜索返回的不是对象")
            return {"total": int(data.get("total") or 0), "objects": data.get("objects") or []}
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code in (403, 429) or err.code >= 500:
                sleep(min(30.0, 2.0 ** attempt))
                continue
            raise RuntimeError("npm 搜索返回 " + str(err.code)) from err
        except (urllib.error.URLError, OSError, ValueError) as err:  # 含 JSONDecodeError（ValueError 子类）
            last_err = err
            sleep(min(30.0, 2.0 ** attempt))
    raise RuntimeError("npm 搜索失败：" + type(last_err).__name__ + " " + str(last_err)[:120])


def empty_payload(keywords=None) -> dict:
    """空缓存骨架：cursor 记每个关键词下一页的 from，done 记已扫完。"""
    kws = [str(k) for k in (keywords or DEFAULT_KEYWORDS)]
    return {
        "updatedAt": None,
        "keywords": kws,
        "pageSize": PAGE_SIZE,
        "cursor": {k: 0 for k in kws},
        "totals": {},
        "done": {k: False for k in kws},
        "settled": {},
        "count": 0,
        "packages": {},
    }


def load_cache(path, keywords=None) -> dict:
    """读缓存；文件缺失/损坏一律当空表 —— 绝不因为一个缓存文件中断采集。"""
    empty = empty_payload(keywords)
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("packages"), dict):
        return empty
    kws = [str(k) for k in (data.get("keywords") or []) if str(k)]
    if kws:
        empty["keywords"] = kws
        for k in kws:
            empty["cursor"].setdefault(k, 0)
            empty["done"].setdefault(k, False)
    for field in ("cursor", "totals", "done", "settled"):
        value = data.get(field)
        if isinstance(value, dict):
            empty[field].update({str(k): v for k, v in value.items()})
    packages = {}
    for name, rec in data["packages"].items():
        if isinstance(rec, dict):
            packages[str(name)] = rec
    empty["packages"] = packages
    empty["count"] = len(packages)
    empty["updatedAt"] = data.get("updatedAt")
    if isinstance(data.get("pageSize"), int) and data["pageSize"] > 0:
        empty["pageSize"] = data["pageSize"]
    return empty


def save_cache(payload: dict, path) -> int:
    """原子写（临时文件 + replace），返回写入的字节数。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = dict(payload)
    out["count"] = len(out.get("packages") or {})
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return len(text)


def sweep(payload: dict, *, budget: int = DEFAULT_BUDGET, keywords=None, opener=None, sleep=time.sleep, log=None) -> dict:
    """按预算续扫：从各关键词的 cursor 接着翻页，直到预算用尽或全部扫完。

    预算单位是【搜索结果条目数】（250 条/页），不是请求数 —— 后台填 5000 就是约 20 页/轮，
    因此单轮可能略微超出预算（最多一页）。单个关键词失败只记一笔并停手：已抓到的先落盘，
    绝不抛异常打断采集。返回统计，不返回 packages（调用方自己 save_cache）。
    """
    kws = [str(k) for k in (keywords or payload.get("keywords") or DEFAULT_KEYWORDS)]
    for k in kws:
        payload.setdefault("cursor", {}).setdefault(k, 0)
        payload.setdefault("done", {}).setdefault(k, False)
    packages = payload.setdefault("packages", {})
    totals = payload.setdefault("totals", {})
    budget = max(0, int(budget))
    pages = items = added = skipped = 0
    error = None
    settled = payload.setdefault("settled", {})
    for keyword in kws:
        stale = 0
        while items < budget and not payload["done"].get(keyword):
            offset = int(payload["cursor"].get(keyword) or 0)
            try:
                page = search_page(keyword, offset, opener=opener, sleep=sleep)
            except Exception as err:  # noqa: BLE001 - 单关键词失败不该拖垮整轮
                error = keyword + "：" + type(err).__name__ + " " + str(err)[:120]
                break
            objects = page["objects"]
            totals[keyword] = page["total"]
            pages += 1
            items += len(objects)
            page_added = 0
            for obj in objects:
                rec = slim_object(obj)
                if rec is None:
                    skipped += 1
                    continue
                at = utcnow()
                prev = packages.get(rec["name"]) if isinstance(packages.get(rec["name"]), dict) else None
                rec = dict(rec, keyword=keyword, at=at)
                rec["firstSeenAt"] = (prev or {}).get("firstSeenAt") or at
                if prev is None:
                    added += 1
                    page_added += 1
                packages[rec["name"]] = rec
            payload["cursor"][keyword] = offset + len(objects)
            if not objects or payload["cursor"][keyword] >= page["total"]:
                payload["done"][keyword] = True
            elif page_added == 0:
                # 整页都是见过的包：要么结果集见底，要么已经回卷到开头 —— 结算该关键词
                stale += 1
                if stale >= STALE_PAGES:
                    payload["done"][keyword] = True
                    settled[keyword] = payload["cursor"][keyword]
            else:
                stale = 0
        if error or items >= budget:
            break
    payload["updatedAt"] = utcnow()
    payload["count"] = len(packages)
    if log:
        remaining = [k for k in kws if not payload["done"].get(k)]
        log(
            "npm 反查：+" + str(pages) + " 页 / " + str(items) + " 条 / 新增 " + str(added)
            + " 个包（跳过无仓库 " + str(skipped) + "）· 累计 " + str(len(packages)) + " 个"
            + ("· 未扫完：" + "、".join(remaining) if remaining else "· 三词已扫完")
        )
    return {
        "pages": pages,
        "items": items,
        "added": added,
        "skippedNoRepo": skipped,
        "count": len(packages),
        "cursor": dict(payload.get("cursor") or {}),
        "done": dict(payload.get("done") or {}),
        "settled": dict(settled),
        "totals": dict(totals),
        "keywords": kws,
        "error": error,
    }
