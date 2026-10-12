"""npm 周下载量采集：可选列，不进默认排序、不动 mesh.json / mesh-core.bin。

数据单独放 data/cache/npm-downloads.json（照 releases.json 的写法）。
包名取根 package.json 的 name；private 排除；取不到 / 接口失败一律记 unknown，绝不写 0。
monorepo（根上有 workspaces）只取根包，并标 multiPackage=true。
"""

from __future__ import annotations

import calendar
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .build import utcnow
from .config import USER_AGENT

# 刷新：一天一次；GitHub 侧只重读「新入库 / 有新提交」的仓库（包名很少变）。
# npm 侧对已解析出的包每天刷一次 last-week（不占 GitHub 配额）。
REFRESH_HOURS = 24.0
# 暂时失败（error）与旧版误记的 unknown+包名：隔这么久再进下载候选，避免永久卡死。
ERROR_RETRY_HOURS = 72.0
DISCOVERY_SHARE = 0.25
CORE_FLOOR = 300
NPM_TIMEOUT = 20
NPM_MAX_ATTEMPTS = 4

# 包名改名表：根 package.json 的 name → 实际 npm 包名（或按仓库 id 覆盖）。
# dsh-market 仓库历史上 name 与 registry 不一致时靠这里兜底。
PACKAGE_RENAMES: dict[str, str] = {
    "dsh-market": "dshmarket",
}
REPO_PACKAGE_OVERRIDES: dict[str, str] = {
    # "dsh-market/dsh-market": "dshmarket",
}

# ok=有下载量；private / no-package=确认终态；
# unknown=npm 上确认没有该包（404，终态）；error=暂时失败（可重试）。
STATUSES = ("ok", "unknown", "private", "no-package", "error")


def load_downloads(path: Path) -> dict:
    """读下载量缓存。文件不存在或损坏都当空表 —— 绝不因为一个缓存文件中断采集。"""
    empty = {"updatedAt": None, "repos": {}}
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
        if isinstance(entry, dict):
            repos[str(repo_id)] = dict(entry)
    return {"updatedAt": data.get("updatedAt"), "repos": repos}


def save_downloads(payload: dict, path: Path) -> int:
    """原子写：临时文件 + replace。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return len(text)


def put(payload: dict, repo_id: str, entry: dict, *, now: str | None = None) -> None:
    """原地写入一个仓库的结果。"""
    stamped = dict(entry)
    stamped["at"] = now or utcnow()
    payload.setdefault("repos", {})[repo_id] = stamped
    payload["updatedAt"] = now or utcnow()


def _ts(iso: str | None) -> float | None:
    try:
        return float(calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S")))
    except (ValueError, TypeError):
        return None


def _age_hours(iso: str | None, now_ts: float) -> float:
    ts = _ts(iso)
    if ts is None:
        return 1e9
    return (now_ts - ts) / 3600.0


def resolve_package_name(raw_name: str | None, *, repo_id: str | None = None) -> str | None:
    """把 package.json 的 name 收成可查的 npm 包名；改名表 / 仓库覆盖优先。"""
    if repo_id and repo_id in REPO_PACKAGE_OVERRIDES:
        return REPO_PACKAGE_OVERRIDES[repo_id]
    if not isinstance(raw_name, str):
        return None
    name = raw_name.strip()
    if not name or name.startswith("http://") or name.startswith("https://"):
        return None
    return PACKAGE_RENAMES.get(name, name)


def parse_package_json(text: str | None, *, repo_id: str | None = None) -> dict:
    """解析根 package.json → {status, package, multiPackage}。
    private=true → private；无 name / 坏 JSON → unknown；其余 ok / 经改名表映射。"""
    if text is None:
        return {"status": "no-package", "package": None, "multiPackage": False}
    try:
        data = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return {"status": "unknown", "package": None, "multiPackage": False}
    if not isinstance(data, dict):
        return {"status": "unknown", "package": None, "multiPackage": False}
    multi = bool(data.get("workspaces"))
    if data.get("private") is True:
        return {"status": "private", "package": None, "multiPackage": multi}
    pkg = resolve_package_name(data.get("name"), repo_id=repo_id)
    if not pkg:
        return {"status": "unknown", "package": None, "multiPackage": multi}
    return {"status": "ok", "package": pkg, "multiPackage": multi}


def npm_downloads_url(package: str) -> str:
    # scoped 包：@scope/name → @scope%2Fname（整段 quote 会把 @ 也编码，npm 接口两者都认，统一 quote）
    return "https://api.npmjs.org/downloads/point/last-week/" + urllib.parse.quote(package, safe="@")


def fetch_npm_downloads(package: str, *, sleep=time.sleep, opener=None) -> dict:
    """查 npm last-week。
    成功 → status=ok；404 → status=unknown（确认无包，终态）；
    网络/5xx 耗尽重试 → status=error（暂时失败，可再进候选）。绝不返回 downloads=0 冒充「没人装」。"""
    url = npm_downloads_url(package)
    open_fn = opener or urllib.request.urlopen
    last_err = None
    for attempt in range(NPM_MAX_ATTEMPTS):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with open_fn(req, timeout=NPM_TIMEOUT) as resp:
                body = resp.read()
            data = json.loads(body.decode("utf-8"))
            downloads = data.get("downloads")
            start = data.get("start")
            end = data.get("end")
            if not isinstance(downloads, int) or downloads < 0:
                return {
                    "status": "error",
                    "downloads": None,
                    "window": {"start": start, "end": end} if start and end else None,
                }
            return {
                "status": "ok",
                "downloads": downloads,
                "window": {"start": str(start)[:10], "end": str(end)[:10]} if start and end else None,
            }
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code == 404:
                return {"status": "unknown", "downloads": None, "window": None}
            if err.code in (403, 429) or err.code >= 500:
                sleep(min(30.0, 2.0 ** attempt))
                continue
            return {"status": "error", "downloads": None, "window": None}
        except (OSError, json.JSONDecodeError, UnicodeError) as err:
            last_err = err
            sleep(min(30.0, 2.0 ** attempt))
            continue
    _ = last_err
    return {"status": "error", "downloads": None, "window": None}


def pick_package_candidates(
    payload: dict,
    nodes,
    *,
    limit: int,
    now_ts: float | None = None,
    refresh_hours: float = REFRESH_HOURS,
    discovery_share: float = DISCOVERY_SHARE,
) -> list[str]:
    """挑这一轮该重读 package.json 的仓库：新入库，或抓过之后又推过，且距上次 ≥ refresh_hours。
    归档跳过。预算里给从没抓过的留 discovery_share。"""
    now_ts = now_ts if now_ts is not None else time.time()
    repos = payload.get("repos") or {}
    hot: list[tuple[int, str]] = []
    never: list[tuple[int, str]] = []
    for node in nodes or []:
        repo_id = node.get("id")
        if not repo_id or node.get("archived"):
            continue
        stars = int(node.get("stars") or 0)
        entry = repos.get(repo_id)
        if not entry:
            never.append((stars, repo_id))
            continue
        if _age_hours(entry.get("packageAt") or entry.get("at"), now_ts) < refresh_hours:
            continue
        pushed_ts = _ts(node.get("pushedAt"))
        fetched_ts = _ts(entry.get("packageAt") or entry.get("at"))
        if pushed_ts is not None and fetched_ts is not None and pushed_ts > fetched_ts:
            hot.append((stars, repo_id))
    hot.sort(key=lambda item: (-item[0], item[1]))
    never.sort(key=lambda item: (-item[0], item[1]))

    limit = max(0, int(limit))
    if limit == 0:
        return []
    quota = min(len(never), limit, max(1, int(round(limit * discovery_share)))) if (hot and never) else 0
    hot_ids = [item[1] for item in hot]
    never_ids = [item[1] for item in never]
    picked = hot_ids[: max(0, limit - quota)] + never_ids[:quota]
    if len(picked) < limit:
        picked += (hot_ids[max(0, limit - quota) :] + never_ids[quota:])[: limit - len(picked)]
    return picked


def _download_retryable(entry: dict) -> bool:
    """暂时失败要重试；npm 404（unknown 终态）不重试。
    旧缓存里「首次失败误记成 unknown 但留着包名」的也要捞回来，否则会永久卡死。"""
    status = entry.get("status")
    if status == "error":
        return True
    if status == "unknown" and isinstance(entry.get("package"), str) and entry.get("package"):
        # 新写法：404 会带 terminal=True；没这个字段的旧数据按可重试处理
        return entry.get("terminal") is not True
    return False


def pick_download_candidates(
    payload: dict,
    *,
    limit: int,
    now_ts: float | None = None,
    refresh_hours: float = REFRESH_HOURS,
    error_retry_hours: float = ERROR_RETRY_HOURS,
) -> list[str]:
    """下载量候选（只打 npm，不占 GitHub 配额）：
    - status=ok 且超过 refresh_hours → 日常刷新；
    - status=error（或旧版误记的 unknown+包名）且超过 error_retry_hours → 重试，避免永久「未知」。"""
    now_ts = now_ts if now_ts is not None else time.time()
    out: list[tuple[str, str]] = []
    for repo_id, entry in (payload.get("repos") or {}).items():
        if not isinstance(entry, dict):
            continue
        package = entry.get("package")
        if not isinstance(package, str) or not package:
            continue
        status = entry.get("status")
        age_ref = entry.get("downloadsAt") or entry.get("at")
        if status == "ok":
            if _age_hours(age_ref, now_ts) < refresh_hours:
                continue
        elif _download_retryable(entry):
            if _age_hours(age_ref, now_ts) < error_retry_hours:
                continue
        else:
            continue
        out.append((repo_id, package))
    out.sort(key=lambda item: item[0])
    return [repo_id for repo_id, _ in out[: max(0, int(limit))]]


def public_entry(entry: dict | None) -> dict:
    """给 API 用的精简字段：缺省 / 损坏一律 unknown，downloads 永不伪造 0。"""
    if not isinstance(entry, dict):
        return {"status": "unknown", "package": None, "downloads": None, "window": None, "multiPackage": False}
    status = entry.get("status") if entry.get("status") in STATUSES else "unknown"
    downloads = entry.get("downloads")
    if status != "ok" or not isinstance(downloads, int):
        downloads = None
        if status == "ok":
            status = "error"
    window = entry.get("window")
    if not (isinstance(window, dict) and window.get("start") and window.get("end")):
        window = None
    else:
        window = {"start": str(window["start"])[:10], "end": str(window["end"])[:10]}
    pkg = entry.get("package") if isinstance(entry.get("package"), str) else None
    return {
        "status": status,
        "package": pkg,
        "downloads": downloads,
        "window": window,
        "multiPackage": bool(entry.get("multiPackage")),
    }


def stats(payload: dict) -> dict:
    repos = payload.get("repos") or {}
    ok = sum(1 for e in repos.values() if isinstance(e, dict) and e.get("status") == "ok" and isinstance(e.get("downloads"), int))
    unknown = sum(1 for e in repos.values() if isinstance(e, dict) and e.get("status") == "unknown")
    errors = sum(1 for e in repos.values() if isinstance(e, dict) and e.get("status") == "error")
    return {"repos": len(repos), "withDownloads": ok, "unknown": unknown, "errors": errors}
