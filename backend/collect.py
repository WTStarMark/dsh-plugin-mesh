#!/usr/bin/env python3
"""DSH 插件生态索引采集器 —— 纯脚本，全程不调用模型。

用法：--once 跑一次；--watch/--loop 常驻；--from-store 改规则后离线重建（不联网）。
产出：data/mesh.json（前端契约）、data/snapshots/*.json（留 48 份）、data/last-crawl.json（溯源）。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from dsh_mesh import admin_config
from dsh_mesh import snapshot as snap
from dsh_mesh.build import build_mesh, limit_for_frontend, normalize_repo, utcnow
from dsh_mesh.config import (
    DEFAULT_BUDGET,
    DEFAULT_INTERVAL,
    FRONTEND_LIMIT,
    KEEP_SNAPSHOTS,
    LAST_CRAWL,
    MESH_JSON,
    NOISE_BLACKLIST,
    REFRESH_HOURS,
    REPO_CACHE,
    SAMPLE_RAW,
    SEGMENT_STATE,
    SNAPSHOT_DIR,
    NPM_DOWNLOADS_CACHE,
    NPM_PACKAGES_CACHE,
    NPM_SEARCH_CACHE,
    RELEASES_CACHE,
    STAR_DAILY,
    STAR_HISTORY,
    UPDATE_LOG,
    README_CACHE,
)
from dsh_mesh.readmes import ReadmeIndex, fetch_batch as fetch_readmes
from dsh_mesh import releases as rel
from dsh_mesh import npm_downloads as npm
from dsh_mesh import npm_packages
from dsh_mesh import npm_search
from dsh_mesh.status import STATUS_FILE, next_run_at, write_status
from dsh_mesh.segments import SegmentStore, segment_query
from dsh_mesh.github import GitHubClient, load_token


RELEASES_BUDGET = 300  # 每轮默认抓 300 个仓库的 releases（core 配额 5000/小时，留足余量）
RELEASES_INTERVAL = 0.12  # 每次请求之间歇一下，别撞二级限流
NPM_BUDGET = 300  # 每轮最多处理多少个仓库的 npm 下载量（含重读 package.json + 刷 last-week）
NPM_INTERVAL = 0.05  # npm 接口不占 GitHub 配额，但仍歇一下避免连不上
NPM_SEARCH_BUDGET = 5000  # 每轮 npm 反查最多处理多少条搜索结果（≈20 页 = 5000 条；0 = 关闭）
NPM_EXTRA_BUDGET = 200    # 每轮查多少个"子目录包"的 npm 周下载量（0 = 关闭）


def tag_totals_from(state: dict) -> dict[str, int]:
    """按标签汇总接口报告的仓库总数（已细分的父段不重复计入）。"""
    totals: dict[str, int] = {}
    for segment in state.get("segments", {}).values():
        if segment.get("state") == "done" and segment.get("total") is not None:
            totals[segment["topic"]] = totals.get(segment["topic"], 0) + segment["total"]
    return totals


def _write_status(**fields) -> None:
    """写采集进度状态；包一层让测试能 mock collect.STATUS_FILE 做路径隔离（直接调会污染真实 data/cache）。"""
    write_status(STATUS_FILE, **fields)


def _report_progress(store, fetched: int, added: int, client, args, **extra) -> None:
    """进度写入 data/status.json（前端"状态"圆环读它）；dry-run 不写。"""
    if getattr(args, "dry_run", False):
        return
    try:
        coverage = store.coverage()
        payload = {
            "phase": "segments",
            "segments": coverage.get("segments"),
            "indexed": coverage.get("repos"),
            "fetched": fetched,
            "added": added,
            "requests": client.stats.requests if client is not None else None,
            "budget": getattr(args, "budget", 0),
            "quotaRemaining": client.stats.rate_limit_remaining if client is not None else None,
            "collectorArgs": getattr(args, "collector", None),
            "collectorSource": getattr(args, "collector_source", None),
        }
        payload.update(extra)
        _write_status(**payload)
    except Exception:  # noqa: BLE001 - 进度上报失败绝不能影响采集
        pass


def fetch_live(args, log, blacklist=None):
    """分段抓取：每轮只刷新一批段，结果并入累积索引，最终覆盖全部仓库。"""
    token = load_token()
    client = GitHubClient(token=token)
    store = SegmentStore(SEGMENT_STATE, REPO_CACHE, blacklist=set(blacklist or ()))
    # 噪声作者从累积索引剔除，后续 merge 直接跳过（不再占配额）
    purged = store.drop_owners(set(blacklist or ()))
    if purged:
        log("噪声黑名单：从累积索引剔除 " + str(purged) + " 个仓库（作者 " + str(len(blacklist)) + " 个）")
        store.save()
    seeded = store.ensure_seeded(args.tags)
    if seeded:
        log("分段队列初始化：新增 " + str(seeded) + " 个待抓分段")
    store.requeue_truncated(log=log)
    before = store.coverage()
    log("累积索引 " + str(before["repos"]) + " 个仓库 | 分段 " + str(before["segments"]))

    batch = store.next_batch(args.budget, args.refresh_hours, log=log)
    fetched = 0
    added_this_round = 0
    split_children = 0
    for index, segment in enumerate(batch):
        if args.budget > 0 and client.stats.requests >= args.budget:
            log("已达本轮请求预算，剩余分段留到下一轮")
            break
        records, total = client.crawl_segment(segment_query(segment), max_pages=args.max_pages, log=log)
        result = store.complete_segment(segment, records, total, log=log)
        fetched += len(records)
        added_this_round += result["added"]
        split_children += result["children"]
        # 长任务要能续跑：每 5 段落盘一次，崩了也不丢整轮
        if (index + 1) % 5 == 0:
            store.save()
            _report_progress(store, fetched, added_this_round, client, args, done=index + 1, total=len(batch))
    store.save()

    # 收尾再报一次：分段数不是 5 的倍数时，面板上的请求数要停在真实值上
    _report_progress(store, fetched, added_this_round, client, args, done=len(batch), total=len(batch))

    after = store.coverage()
    log(
        "本轮抓取 " + str(fetched) + " 条 · 累积索引 " + str(after["repos"]) + " 个仓库（新增 "
        + str(added_this_round) + "）| 分段：待抓 " + str(after["segments"]["pending"])
        + " / 已抓 " + str(after["segments"]["done"]) + " / 已细分 " + str(after["segments"]["split"])
    )
    # README 索引放在爬取之后：热度高的仓库优先，也不挤占分段扫描的请求预算（见 dsh_mesh/readmes.py）。
    readme_stats = None
    if getattr(args, "readme_budget", 0) > 0 and not getattr(args, "from_store", False):
        try:
            min_stars = int(getattr(args, "readme_min_stars", 0) or 0)
            pool = [r for r in store.repos.values() if (r.get("stars") or 0) >= min_stars]
            if min_stars > 0:
                log("README 索引：只看星标 ≥ " + str(min_stars) + " 的仓库（" + str(len(pool)) + " / " + str(len(store.repos)) + "）")
            index = ReadmeIndex(README_CACHE, max_chars=int(getattr(args, "readme_max_chars", 0) or 2000))
            if not getattr(args, "dry_run", False):
                _write_status(phase="readme")
            readme_stats = fetch_readmes(client, index, pool, args.readme_budget, log=log)
            if readme_stats and not getattr(args, "dry_run", False):
                pool_ids = [str(r.get("id")) for r in pool]
                in_pool = index.count_in(pool_ids)
                _write_status(
                    phase="readme",
                    readme={
                        # 分子只算可索引池内的（≤ target）；缓存总量含已不达标的旧条目，直接用会出 14513/14490 这种怪值
                        "indexed": in_pool,
                        "cached": readme_stats.get("indexed"),
                        "target": len(pool),
                        "thisRound": readme_stats.get("requested"),
                        "empty": readme_stats.get("empty"),
                    },
                )
        except Exception as exc:  # noqa: BLE001 - README 索引是加分项，失败不该拖垮采集
            log("⚠ README 索引本轮失败：" + str(exc))

    raws = list(store.repos.values())
    return raws, tag_totals_from(store.state), client.stats, {
        "readme": readme_stats,
        "token": bool(token),
        "mode": "segmented",
        "segments": after["segments"],
        "addedThisRound": added_this_round,
        "splitChildren": split_children,
        "coveredRepos": after["repos"],
        "noisePurged": purged,
    }


def load_from_raw(log):
    cached = json.loads(SAMPLE_RAW.read_text(encoding="utf-8"))
    raws = [normalize_repo(item) for item in cached.get("repos", [])]
    totals: dict[str, int | None] = {}
    for meta in cached.get("queryMeta", []):
        tag = str(meta.get("q", "")).replace("topic:", "")
        if tag and meta.get("totalCount") is not None:
            totals[tag] = max(totals.get(tag) or 0, meta["totalCount"])
    log(f"离线模式：读入 {len(raws)} 条本地原始记录（零网络请求）")
    return raws, totals, None, {"token": False, "mode": "from-raw"}


def previous_index_size() -> int:
    """现有前端契约里记录的索引规模，用于缩水保护。"""
    if not MESH_JSON.exists():
        return 0
    try:
        meta = json.loads(MESH_JSON.read_text(encoding="utf-8")).get("meta", {})
    except (OSError, json.JSONDecodeError):
        return 0
    return int(meta.get("indexedNodes") or 0)


def seconds_until_next(now: float, interval: int) -> float:
    """对齐到整点边界：interval=3600 时永远在下一个整点跑。"""
    return max(60.0, interval - (now % interval))


def _core_looks_fresh(started: float, expected_nodes: int | None = None) -> bool:
    """mesh-core.json 是否在本轮之后被完整重写；只看 mtime 会漏掉写一半就崩的半截 JSON，还要能解析、节点数对得上。"""
    from dsh_mesh.config import MESH_JSON

    path = MESH_JSON.parent / "mesh-core.json"
    try:
        if not path.exists() or path.stat().st_mtime < started - 1:
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return False
    if expected_nodes is not None and len(nodes) != expected_nodes:
        return False
    return data.get("meta", {}).get("layout") == "precomputed"


def _bin_looks_fresh(started: float, data_dir: Path | None = None) -> bool:
    """二进制契约（mesh-core.bin / head.bin）是否也随本轮刷新：只看 mtime，内容正确性由编解码器单测保证。"""
    from dsh_mesh.config import MESH_JSON

    base = Path(data_dir) if data_dir is not None else MESH_JSON.parent
    for name in ("mesh-core.bin", "mesh-core.head.bin"):
        path = base / name
        try:
            if not path.exists() or path.stat().st_mtime < started - 1:
                return False
        except OSError:
            return False
    return True


def run_precompute(log, expected_nodes: int | None = None) -> None:
    """调 Node 工具预计算布局并给载荷瘦身（mesh-core.json + 详情分片）。
    失败不影响数据（前端会回退本地计算）；expected_nodes 校验产物完整，防半截文件。"""
    from dsh_mesh.config import ROOT

    node = shutil.which("node")
    if not node:
        fallback = Path("/opt/dsh-runtime/node/bin/node")
        node = str(fallback) if fallback.exists() else None
    if not node:
        log("未找到 node，跳过预计算（前端会自动回退到本地计算布局）")
        return
    script = ROOT / "tools" / "precompute-layout.mjs"
    if not script.exists():
        log("未找到预计算脚本，跳过")
        return

    def attempt() -> tuple[bool, str]:
        started = time.time()
        try:
            result = subprocess.run(
                [node, str(script)],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=900,
                # pm2 托管下 node 偶发 libuv 断言（uv__io_poll: errno == EEXIST）：独立会话 + 空 stdin 可避开
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:  # noqa: BLE001 - 预计算失败不该拖垮采集
            return False, str(exc)[:160]
        if result.returncode == 0:
            lines = [line for line in result.stdout.strip().splitlines() if line.strip()]
            return True, (lines[-1].strip() if lines else "")
        # 非零退出时 core 可能已写好，但二进制契约常停在崩溃点之前（曾出现 .bin 被冻结 40 小时没人发现），
        # 所以必须同时确认它刷新了才认成功。
        if _core_looks_fresh(started, expected_nodes) and _bin_looks_fresh(started):
            return True, "产物已更新（子进程退出码 " + str(result.returncode) + "，二进制契约已同步刷新）"
        return False, (result.stderr.strip()[:160] or ("退出码 " + str(result.returncode))) + " / 二进制契约未刷新（mesh-core.bin 比本轮旧）"

    # 重试一次：core 冻结在上一小时就等于前端地图不再更新
    for index in (1, 2):
        ok, detail = attempt()
        if ok:
            log("预计算完成：" + detail)
            return
        if index == 1:
            log("预计算失败（不影响数据），5 秒后重试一次：" + detail)
            time.sleep(5)
        else:
            log("预计算失败（不影响数据）：" + detail)


def _market_index_fresh(started: float) -> bool:
    """dist/market/index.json 是否在本轮之后被完整重写。
    只看 mtime 会漏掉"写了一半就崩"的半截 JSON，所以还要能解析出 plugins —— 同 _core_looks_fresh 的思路。"""
    from dsh_mesh.config import ROOT

    path = ROOT / "dist" / "market" / "index.json"
    try:
        if not path.exists() or path.stat().st_mtime < started - 1:
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(data.get("plugins"), list)


def run_market_index(log) -> None:
    """调 Node 工具生成插件市场索引（dist/market/index.json，serve.mjs 直接对外提供）。
    失败不影响采集：索引只服务 DSH 的「发现」页，坏了是那一页拿不到清单，站点与数据都不受影响。
    npm 侧有一份带 24 小时 TTL 的注册表缓存（data/cache/npm-registry.json），所以常规轮次只补过期的包；
    第一次跑（或缓存被删）要全量抓上万份 packument，会明显拖长本轮。"""
    from dsh_mesh.config import ROOT

    node = shutil.which("node")
    if not node:
        fallback = Path("/opt/dsh-runtime/node/bin/node")
        node = str(fallback) if fallback.exists() else None
    if not node:
        log("未找到 node，跳过市场索引生成")
        return
    script = ROOT / "tools" / "market-index.mjs"
    if not script.exists():
        log("未找到市场索引脚本（tools/market-index.mjs），跳过")
        return

    started = time.time()
    try:
        result = subprocess.run(
            # 堆上限兜底：线上实测峰值 RSS 181MB，给它 256MB 天花板 —— 真失控时是"这轮索引没刷新"，
            # 而不是把同机的 web 进程挤到 OOM（那台机器今天已经因为内存崩过一次）。
            [node, "--max-old-space-size=256", str(script), "--limit", "20000", "--concurrency", "4"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=3600,
            # 同 run_precompute：pm2 托管下独立会话 + 空 stdin，避开 node 的 libuv 偶发断言
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001 - 索引失败不该拖垮采集
        log("市场索引生成失败（不影响采集）：" + str(exc)[:160])
        return

    lines = [line for line in (result.stdout or "").strip().splitlines() if line.strip()]
    written = next((line.strip() for line in reversed(lines) if "写入" in line), None)
    detail = written or (lines[-1].strip() if lines else "无输出")
    # 退出码非 0 别急着判失败：线上实测 node 会在**写完文件之后**崩在退出阶段
    # （uv__io_poll: errno == EEXIST，pm2 托管下的老毛病，run_precompute 也踩过）。
    # 产物确实刷新了、且能解析出 plugins，就认成功 —— 与预计算同一套判断。
    if result.returncode == 0:
        log("市场索引已刷新（用时 %.0f 秒）：%s" % (time.time() - started, detail))
    elif _market_index_fresh(started):
        log(
            "市场索引已刷新（子进程退出码 %d，但产物已完整写出）：%s"
            % (result.returncode, detail)
        )
    else:
        log(
            "市场索引失败（退出码 %d，产物未刷新）：%s | %s"
            % (result.returncode, detail, (result.stderr or "").strip()[:160])
        )


def load_from_store(args, log):
    """离线重建：直接用累积索引（data/cache/repos.json）构图，不联网、不消耗配额。
    改完分类/噪声/相关性规则后立刻重算前端契约，不必等下一轮采集（仍走同一套 build_mesh + 预计算）。"""
    store = SegmentStore(SEGMENT_STATE, REPO_CACHE)
    raws = list(store.repos.values())
    log("离线重建：读入累积索引 " + str(len(raws)) + " 条记录（零网络请求）")
    return raws, tag_totals_from(store.state), None, {"mode": "store-rebuild", "token": "-"}


def core_floor(client, configured: int) -> int:
    """core 配额剩多少就收手 —— 按**本次实际拿到的上限**打折，不能写死。

    CORE_FLOOR 原本写死 300，是按"有令牌 core 5000/小时"定的。匿名运行时 core 上限只有
    60/小时，第一次请求之后 remaining 就恒小于 300 —— 于是每轮只抓 1 个仓库就收手
    （线上实测 last-crawl.json 里 releases.fetched = 1、npmDownloads.fetched = 1，两处一起卡住）。
    按上限的一半收手：有令牌时结果不变（5000 → min(300, 2500) = 300），
    匿名时也能把 60 个配额用起来（→ 30），不再空转。
    """
    limit = getattr(getattr(client, "stats", None), "core_limit", None)
    if not limit or limit <= 0:
        return configured
    return max(1, min(configured, int(limit * 0.5)))


def fetch_releases_safe(args, mesh: dict, log) -> dict:
    """跑版本抓取，但永不抛异常：版本缓存只是"周更新热榜"的加分项，失败不该让前端数据不落盘
    （曾有一次 RemoteDisconnected 在写 mesh 前打断整轮，站点白等一小时）。"""
    try:
        return fetch_releases(args, mesh, log)
    except Exception as exc:  # noqa: BLE001 - 这里就是要吞掉它，见上
        log("⚠ 版本抓取本轮失败（不阻塞前端数据）：" + str(exc)[:120])
        return {"enabled": True, "error": str(exc)[:120]}


def fetch_release_pages(client, repo_id: str, keep: int = rel.RELEASES_KEEP) -> list[dict] | None:
    """取一个仓库的 releases，最多 keep 个（单页上限 100，可能要翻页，通常只有高频仓库发第二次请求）。
    返回 None 表示这次没拿到（网络/限流），交给上层跳过。"""
    out: list[dict] = []
    page = 1
    while len(out) < keep and page <= 5:
        want = min(rel.RELEASES_PAGE, keep - len(out))
        chunk = client.releases(repo_id, per_page=want, page=page)
        if chunk is None:
            return None if not out else out  # 第一页就失败 → 整条跳过；后续页失败 → 用已拿到的
        out.extend(chunk)
        if len(chunk) < want:
            break
        page += 1
    return out[:keep]


def fetch_releases(args, mesh: dict, log) -> dict:
    """按预算抓 releases（走 core 配额）并写回 data/cache/releases.json。
    搜索接口不返回 releases，只能一仓库一请求且配额按认证身份共享，故限量 + 按优先级挑
    （见 releases.pick_candidates）；离线模式与 dry-run 跳过，测试因此完全不碰网络。"""
    budget = int(getattr(args, "releases_budget", 0) or 0)
    if budget <= 0 or args.dry_run or args.from_raw or getattr(args, "from_store", False):
        return {"enabled": False, "budget": budget}
    payload = rel.load_releases(RELEASES_CACHE)
    picked = rel.pick_candidates(payload, mesh.get("nodes") or [], limit=budget)
    if not picked:
        log("版本：本轮没有需要刷新的仓库（缓存里已有 " + str(len(payload.get("repos") or {})) + " 个）")
        return {"enabled": True, "budget": budget, "picked": 0, "fetched": 0, "failed": 0, **rel.stats(payload)}
    client = GitHubClient(token=load_token(), sleep=time.sleep)
    fetched = failed = 0
    streak = 0
    for repo_id in picked:
        if client.stats.core_remaining is not None and client.stats.core_remaining < core_floor(client, rel.CORE_FLOOR):
            log("版本：core 配额只剩 " + str(client.stats.core_remaining) + "，本轮提前收手（下一轮接着抓）")
            break
        try:
            items = fetch_release_pages(client, repo_id)
        except Exception as err:  # noqa: BLE001 - 单个仓库失败就跳过：抖动/超时都不该打断整批
            failed += 1
            streak += 1
            log("版本：" + repo_id + " 抓取失败（跳过）：" + str(err)[:80])
            if streak >= 5:
                # 网络真断了别把剩下几百个仓库挨个重试（每个还要退避 3 次，能耗掉一小时）
                log("版本：连续 " + str(streak) + " 个仓库抓取失败，判断为网络/配额异常，本轮提前收手")
                break
            continue
        streak = 0
        if items is None:
            failed += 1
            continue
        rel.put(payload, repo_id, rel.slim_releases(items))
        fetched += 1
        time.sleep(RELEASES_INTERVAL)
    size = rel.save_releases(payload, RELEASES_CACHE)
    info = rel.stats(payload)
    log(
        "版本：本轮抓 " + str(fetched) + " 个仓库（失败 " + str(failed) + "）· 缓存 "
        + str(info["repos"]) + " 个仓库 / " + str(info["versions"]) + " 个版本 · " + str(size // 1024) + "KB"
    )
    return {
        "enabled": True,
        "budget": budget,
        "picked": len(picked),
        "fetched": fetched,
        "failed": failed,
        "coreRemaining": client.stats.core_remaining,
        **info,
    }


def fetch_npm_safe(args, mesh: dict, log) -> dict:
    """跑 npm 下载量采集，但永不抛异常：可选列失败不该让前端数据不落盘。"""
    try:
        return fetch_npm_downloads(args, mesh, log)
    except Exception as exc:  # noqa: BLE001 - 这里就是要吞掉它，见上
        log("⚠ npm 下载量本轮失败（不阻塞前端数据）：" + str(exc)[:120])
        return {"enabled": True, "error": str(exc)[:120]}


def fetch_npm_search_safe(args, log) -> dict:
    """跑 npm 反查发现，但永不抛异常：这是一条可选的新发现通道，失败不该让整轮采集失败。"""
    try:
        return fetch_npm_search(args, log)
    except Exception as exc:  # noqa: BLE001 - 与 fetch_npm_safe 同口径
        log("⚠ npm 反查本轮失败（不阻塞其它产出）：" + str(exc)[:120])
        return {"enabled": True, "error": str(exc)[:120]}


def fetch_npm_search(args, log) -> dict:
    """按关键词扫 npm 搜索接口，把「包 → 仓库」落进 data/cache/npm-search.json（按预算续扫）。

    只做发现与落盘：不判定相关性、不动 mesh.json / npm-downloads.json。
    离线模式（--from-raw / --from-store）与 dry-run 一律跳过 —— 测试与 CI 绝不能因此联网。
    """
    budget = int(getattr(args, "npm_search_budget", 0) or 0)
    if budget <= 0 or args.dry_run or args.from_raw or getattr(args, "from_store", False):
        return {"enabled": False, "budget": budget}
    payload = npm_search.load_cache(NPM_SEARCH_CACHE)
    stats = npm_search.sweep(payload, budget=budget, log=log, sleep=time.sleep)
    size = npm_search.save_cache(payload, NPM_SEARCH_CACHE)
    return {
        "enabled": True,
        "budget": budget,
        "pages": stats["pages"],
        "items": stats["items"],
        "added": stats["added"],
        "skippedNoRepo": stats["skippedNoRepo"],
        "packages": payload["count"],
        "bytes": size,
        "done": stats["done"],
        "settled": stats["settled"],
        "totals": stats["totals"],
        "error": stats["error"],
    }


def fetch_npm_packages_safe(args, mesh: dict, log) -> dict:
    """跑「子目录包」下载量采集，但永不抛异常（与其它可选列同口径）。"""
    try:
        return fetch_npm_packages(args, mesh, log)
    except Exception as exc:  # noqa: BLE001 - 可选列失败不该让整轮采集失败
        log("⚠ npm 子目录包本轮失败（不阻塞其它产出）：" + str(exc)[:120])
        return {"enabled": True, "error": str(exc)[:120]}


def fetch_npm_packages(args, mesh: dict, log) -> dict:
    """给「反查发现、仓库根 package.json 认不出」的包查真实下载量，写 data/cache/npm-packages.json。

    候选来自 data/cache/npm-search.json（npm 反查）∩ 图里的仓库；每个包只花 1 次 npm 请求。
    离线模式与 dry-run 跳过；取不到下载量一律按状态如实记（绝不写 0）。
    """
    budget = int(getattr(args, "npm_extra_budget", 0) or 0)
    if budget <= 0 or args.dry_run or args.from_raw or getattr(args, "from_store", False):
        return {"enabled": False, "budget": budget}
    payload = npm_packages.load(NPM_PACKAGES_CACHE)
    search = npm_search.load_cache(NPM_SEARCH_CACHE)
    downloads = npm.load_downloads(NPM_DOWNLOADS_CACHE)
    picked = npm_packages.pick_candidates(payload, search, downloads, mesh.get("nodes") or [], limit=budget)
    fetched = failed = 0
    for item in picked:
        try:
            hit = npm.fetch_npm_downloads(item["package"], sleep=time.sleep)
        except Exception as err:  # noqa: BLE001 - 单个包失败就跳过，下一轮重试
            failed += 1
            log("npm 子目录包：" + item["package"] + " 查询失败（跳过）：" + str(err)[:80])
            continue
        payload.setdefault("packages", {})[item["package"]] = {
            "package": item["package"],
            "repoId": item["repoId"],
            "repoKey": item["repoKey"],
            "status": hit["status"],
            "downloads": hit.get("downloads"),
            "window": hit.get("window"),
            "days": hit.get("days"),
            "at": utcnow(),
        }
        fetched += 1
    size = npm_packages.save(payload, NPM_PACKAGES_CACHE)
    log(
        "npm 子目录包：本轮查 " + str(len(picked)) + " 个（成功 " + str(fetched) + " / 失败 " + str(failed)
        + "）· 累计 " + str(len(payload.get("packages") or {})) + " 个 · 落盘 " + str(size // 1024) + "KB"
    )
    return {
        "enabled": True,
        "budget": budget,
        "picked": len(picked),
        "fetched": fetched,
        "failed": failed,
        "packages": len(payload.get("packages") or {}),
        "bytes": size,
    }


def fetch_npm_downloads(args, mesh: dict, log) -> dict:
    """按预算解析根 package.json + 刷 npm last-week，写回 data/cache/npm-downloads.json。
    离线模式与 dry-run 跳过，测试因此完全不碰网络。取不到 / 失败一律记 unknown，不写 0。"""
    budget = int(getattr(args, "npm_budget", 0) or 0)
    if budget <= 0 or args.dry_run or args.from_raw or getattr(args, "from_store", False):
        return {"enabled": False, "budget": budget}
    payload = npm.load_downloads(NPM_DOWNLOADS_CACHE)
    nodes = mesh.get("nodes") or []
    pkg_ids = npm.pick_package_candidates(payload, nodes, limit=budget)
    # 下载量刷新不占 GitHub：用剩余预算刷已解析包；与包名候选去重
    remain = max(0, budget - len(pkg_ids))
    dl_ids = [rid for rid in npm.pick_download_candidates(payload, limit=remain + len(pkg_ids)) if rid not in set(pkg_ids)]
    dl_ids = dl_ids[:remain]
    if not pkg_ids and not dl_ids:
        log("npm：本轮没有需要刷新的仓库（缓存里已有 " + str(len(payload.get("repos") or {})) + " 个）")
        return {"enabled": True, "budget": budget, "picked": 0, "fetched": 0, "failed": 0, **npm.stats(payload)}

    client = GitHubClient(token=load_token(), sleep=time.sleep) if pkg_ids else None
    fetched = failed = 0
    streak = 0
    now = utcnow()

    for repo_id in pkg_ids:
        if client is not None and client.stats.core_remaining is not None and client.stats.core_remaining < core_floor(client, npm.CORE_FLOOR):
            log("npm：core 配额只剩 " + str(client.stats.core_remaining) + "，本轮提前收手（下一轮接着抓）")
            break
        try:
            assert client is not None
            text = client.file_raw(repo_id, "package.json")
        except Exception as err:  # noqa: BLE001 - 单个仓库失败就跳过
            failed += 1
            streak += 1
            log("npm：" + repo_id + " 读 package.json 失败（跳过）：" + str(err)[:80])
            if streak >= 5:
                log("npm：连续 " + str(streak) + " 个仓库抓取失败，判断为网络/配额异常，本轮提前收手")
                break
            continue
        streak = 0
        parsed = npm.parse_package_json(text, repo_id=repo_id)
        prev = (payload.get("repos") or {}).get(repo_id) or {}
        # 包名元数据本次一定更新；下载量只有查到才覆盖——npm 挂了保留旧值（与 dl_ids 一致）
        entry = {
            "status": parsed["status"],
            "package": parsed["package"],
            "multiPackage": parsed["multiPackage"],
            # 仓库 package.json 自报的 repository 与 version：归属核对（npm 声明的仓库 ↔ 仓库自报的家）
            # 与复制品识别都靠它。缺了就不写键，前端/工具按"未知"处理，不编值。
            "repository": parsed.get("repository"),
            "version": parsed.get("version"),
            "packageAt": now,
            "downloads": prev.get("downloads") if isinstance(prev.get("downloads"), int) else None,
            "window": prev.get("window") if isinstance(prev.get("window"), dict) else None,
            # 逐日序列（range 口径）：与 downloads 同源；缺一天就整条不给 —— 宁可没柱子，不画假柱子
            "days": prev.get("days") if isinstance(prev.get("days"), list) else None,
            "downloadsAt": prev.get("downloadsAt"),
        }
        if parsed["status"] == "ok" and parsed["package"]:
            hit = npm.fetch_npm_downloads(parsed["package"], sleep=time.sleep)
            entry["package"] = parsed["package"]
            if hit["status"] == "ok":
                entry["status"] = "ok"
                entry["downloads"] = hit["downloads"]
                entry["window"] = hit["window"]
                entry["days"] = hit.get("days")
                entry["downloadsAt"] = now
                entry.pop("terminal", None)
            elif isinstance(prev.get("downloads"), int) and prev.get("status") == "ok":
                # 刷新失败：保留旧下载量与旧窗口，只更新包名侧
                entry["status"] = "ok"
                entry["downloads"] = prev["downloads"]
                entry["window"] = prev.get("window")
                entry["days"] = prev.get("days")
                entry["downloadsAt"] = prev.get("downloadsAt")
                failed += 1
            elif hit["status"] == "unknown":
                # 下载接口 404：可能包真没了，也可能是新包还没统计下载量 —— 以 registry 为准。
                exists = npm.registry_package_exists(parsed["package"])
                entry["downloads"] = None
                entry["window"] = None
                entry["days"] = None
                entry["downloadsAt"] = now
                if exists:
                    # 包存在、下载量暂无：记 ok（市场索引照收，下载量显示为未知），24h 后再刷
                    entry["status"] = "ok"
                    entry.pop("terminal", None)
                elif exists is False:
                    # registry 也 404：确认无包，终态（不再进下载候选）
                    entry["status"] = "unknown"
                    entry["terminal"] = True
                    failed += 1
                else:
                    # registry 探测失败：按暂时失败处理，过 ERROR_RETRY_HOURS 再试
                    entry["status"] = "error"
                    entry.pop("terminal", None)
                    failed += 1
            else:
                # 暂时失败：记 error，保留包名，过 ERROR_RETRY_HOURS 再进候选（绝不写 0）
                entry["status"] = "error"
                entry["downloads"] = None
                entry["window"] = None
                entry["days"] = None
                entry["downloadsAt"] = now
                entry.pop("terminal", None)
                failed += 1
        npm.put(payload, repo_id, entry, now=now)
        fetched += 1
        time.sleep(NPM_INTERVAL)

    for repo_id in dl_ids:
        prev = (payload.get("repos") or {}).get(repo_id) or {}
        package = prev.get("package")
        if not package:
            continue
        hit = npm.fetch_npm_downloads(str(package), sleep=time.sleep)
        if hit["status"] == "ok":
            entry = dict(prev)
            entry["status"] = "ok"
            entry["downloads"] = hit["downloads"]
            entry["window"] = hit["window"]
            entry["days"] = hit.get("days")
            entry["downloadsAt"] = now
            entry.pop("terminal", None)
            npm.put(payload, repo_id, entry, now=now)
            fetched += 1
            time.sleep(NPM_INTERVAL)
            continue
        if hit["status"] == "unknown":
            # 下载接口 404：同样以 registry 为准（包还在但新到没统计 vs 包真没了）
            exists = npm.registry_package_exists(str(package))
            entry = dict(prev)
            entry["downloads"] = None
            entry["window"] = None
            entry["days"] = None
            entry["downloadsAt"] = now
            if exists:
                entry["status"] = "ok"
                entry.pop("terminal", None)
            elif exists is False:
                entry["status"] = "unknown"
                entry["terminal"] = True
                failed += 1
            else:
                entry["status"] = "error"
                entry.pop("terminal", None)
                failed += 1
            npm.put(payload, repo_id, entry, now=now)
            time.sleep(NPM_INTERVAL)
            continue
        # 暂时失败：若已有 ok 旧值则保留；否则标 error 以便日后重试
        if isinstance(prev.get("downloads"), int) and prev.get("status") == "ok":
            failed += 1
            continue
        entry = dict(prev)
        entry["status"] = "error"
        entry["downloads"] = None
        entry["window"] = None
        entry["days"] = None
        entry["downloadsAt"] = now
        entry.pop("terminal", None)
        npm.put(payload, repo_id, entry, now=now)
        failed += 1
        time.sleep(NPM_INTERVAL)

    size = npm.save_downloads(payload, NPM_DOWNLOADS_CACHE)
    info = npm.stats(payload)
    log(
        "npm：本轮处理 "
        + str(fetched)
        + " 个仓库（失败 "
        + str(failed)
        + "）· 缓存 "
        + str(info["repos"])
        + " 个 / 有下载量 "
        + str(info["withDownloads"])
        + " · "
        + str(size // 1024)
        + "KB"
    )
    return {
        "enabled": True,
        "budget": budget,
        "picked": len(pkg_ids) + len(dl_ids),
        "packageCandidates": len(pkg_ids),
        "downloadCandidates": len(dl_ids),
        "fetched": fetched,
        "failed": failed,
        "coreRemaining": client.stats.core_remaining if client is not None else None,
        **info,
    }


def run_once(args, log) -> dict:
    started = time.time()
    log(f"=== 采集开始 {utcnow()} ===")
    if not args.dry_run:
        # 开头就写本轮计数：批次为空时分段循环一次不跑，浮窗会一直挂着上一轮的 "147 / 预算 600"。
        # quotaRemaining=None 是删键：本轮还没发过请求，留旧值等于报假数。
        # --from-store 一个 GitHub 请求都不发，budget 写 0 会被误读成"配额是 0"，故这类轮次删 budget 键；
        # --from-raw 是 CI 的离线复算，预算仍按调用方给的值写（保持测试口径）。
        offline_round = bool(getattr(args, "from_store", False))
        _write_status(
            state="crawling",
            phase="segments",
            roundStartedAt=utcnow(),
            roundSeconds=args.interval,
            nextRunAt=next_run_at(time.time(), args.interval),
            error=None,
            fetched=0,
            added=0,
            requests=0,
            budget=None if offline_round else getattr(args, "budget", 0),
            quotaRemaining=None,
            # 生效的采集参数与来源（cli / config / default）：后台设置页据此标注
            # "这一项被命令行占着，改配置也不生效"，否则用户改完配置会白纳闷。
            collectorArgs=getattr(args, "collector", None),
            collectorSource=getattr(args, "collector_source", None),
        )
    # 噪声黑名单长期生效：命中者不进累积索引、也不进前端契约。
    # 两档语义不同：作者级 = 整账号不可信；单仓库级 = 这个仓库不可信（那人还有真项目）。
    blacklist = snap.load_blacklist(NOISE_BLACKLIST)
    blacklist_repos = snap.load_blacklist_repos(NOISE_BLACKLIST)
    if blacklist:
        log("噪声黑名单：" + str(len(blacklist)) + " 个作者（" + "、".join(sorted(blacklist)[:5]) + ("…" if len(blacklist) > 5 else "") + "）")
    if blacklist_repos:
        log("单仓库黑名单：" + str(len(blacklist_repos)) + " 个仓库（" + "、".join(sorted(blacklist_repos)[:3]) + ("…" if len(blacklist_repos) > 3 else "") + "）")
    if args.from_raw:
        raws, tag_totals, stats, env = load_from_raw(log)
    elif getattr(args, "from_store", False):
        raws, tag_totals, stats, env = load_from_store(args, log)
    else:
        raws, tag_totals, stats, env = fetch_live(args, log, blacklist)

    if not args.dry_run:
        _write_status(state="building", phase="build")
    # 白名单别名组：匹配层展开（仓库只打了同义标签也能归到规范标签上）。
    # 抓取层不用它 —— args.tags 仍然只有规范标签，GitHub 只认精确 topic。
    mesh = build_mesh(
        raws,
        tag_totals,
        blacklist=blacklist,
        blacklist_repos=blacklist_repos,
        whitelist_aliases=admin_config.whitelist_aliases(),
    )
    noise_now = mesh["meta"].get("noiseBlacklist") or {}
    new_noise = {owner: info for owner, info in noise_now.items() if owner not in blacklist}
    if env.get("readme"):
        mesh["meta"]["readmeIndexed"] = env["readme"].get("indexed")
    else:
        # 离线重建不抓 README，但索引还在磁盘上：如实记进 meta，免得后台只显示「—」；读不动就算了。
        try:
            mesh["meta"]["readmeIndexed"] = ReadmeIndex(README_CACHE).stats()["count"]
        except Exception:
            pass
    if args.from_raw:
        mesh["meta"]["kind"], mesh["meta"]["builtFrom"] = "sample-seed", "data/sample-raw.json（离线复算）"
    elif getattr(args, "from_store", False):
        mesh["meta"]["kind"], mesh["meta"]["builtFrom"] = "store-rebuild", "data/cache/repos.json（离线重建）"
    else:
        mesh["meta"]["kind"], mesh["meta"]["builtFrom"] = "hourly-crawl", "GitHub REST Search API"
    total_indexed = len(mesh["nodes"])

    elapsed = time.time() - started
    summary = {
        "generatedAt": utcnow(),
        "mode": env["mode"],
        "tokenUsed": env["token"],
        "tags": args.tags,
        "rawRecords": len(raws),
        "indexedNodes": total_indexed,
        "frontendNodes": None,
        "frontendEdges": None,
        "tagTotals": tag_totals,
        "stats": stats.as_dict() if stats is not None else None,
        "readme": env.get("readme"),
        "seconds": round(elapsed, 1),
    }

    summary["noiseBlacklistSize"] = len(noise_now)
    summary["noiseNodesRemoved"] = mesh["meta"].get("noiseNodesRemoved", 0)
    summary["noisePurged"] = env.get("noisePurged", 0)
    if new_noise:
        log(
            "⚠ 新判定噪声作者 " + str(len(new_noise)) + " 个："
            + "、".join(
                f"{owner}（{info['repos']} 个仓库 · 0 星占比 {round(float(info.get('zeroRatio') or 0) * 100, 1)}% · {info.get('reason') or '?'}）"
                for owner, info in sorted(new_noise.items())[:5]
            )
        )

    if args.dry_run:
        log("dry-run：不写任何文件")
        log(f"索引 {total_indexed} 个仓库 · 前端 {len(mesh['nodes'])} 个节点 / {len(mesh['edges'])} 条连线")
        summary["dryRun"] = True
        return summary

    # 落盘前重读磁盘再取并集：后台可能在采集期间往 noise-blacklist.json 加条目，
    # 只写本轮结果会把人工条目抹掉（冲突时以磁盘为准）。
    previous_noise = snap.load_blacklist(NOISE_BLACKLIST)
    previous_repos = snap.load_blacklist_repos(NOISE_BLACKLIST)
    merged_noise = {**noise_now, **previous_noise}
    new_count = sum(1 for owner in merged_noise if owner not in previous_noise)
    kept_count = len(merged_noise) - new_count
    summary["noiseBlacklistSize"] = len(merged_noise)
    # 单仓库条目来自后台/手改，采集器只负责原样保留：合并写回时绝不能丢（丢了就等于静默解除拉黑）。
    if merged_noise and merged_noise != previous_noise:
        snap.write_blacklist(merged_noise, NOISE_BLACKLIST, repos=previous_repos)
        log(
            "噪声黑名单已写入 data/noise-blacklist.json（新增拉黑 " + str(new_count)
            + " 个 / 保留既有（含人工）" + str(kept_count) + " 个，共 " + str(len(merged_noise)) + " 个作者）"
        )

    # 缩水保护：预热期累积索引很小，不能拿它覆盖已有完整索引；被黑名单剔除的不算缩水，
    # 否则第一次拉黑会被这道保护挡住。
    explained = total_indexed + int(mesh["meta"].get("noiseNodesRemoved") or 0) + int(env.get("noisePurged") or 0)
    previous = previous_index_size()
    if previous and explained < previous * args.min_ratio:
        log(
            f"⚠ 本次只构建出 {total_indexed} 个仓库，低于现有索引 {previous} 的 {int(args.min_ratio * 100)}%，"
            "拒绝覆盖前端数据与快照（分段扫描预热期属正常，等累积索引涨上来再写）"
        )
        summary["skippedWrite"] = True
        summary["previousIndex"] = previous
        summary["minRatio"] = args.min_ratio
        summary["explainedIndex"] = explained
        snap.write_last_crawl(summary, LAST_CRAWL)
        return summary

    # 先按完整索引写快照再裁剪前端（顺序反了 diff 会把"掉出头部"误报成"消失"）；索引没变则跳过写盘。
    if not args.dry_run:
        _write_status(state="building", phase="write")
    path, diff = snap.write_snapshot(mesh, SNAPSHOT_DIR, KEEP_SNAPSHOTS)
    summary["snapshot"] = str(path.relative_to(MESH_JSON.parent.parent)) if path else None
    summary["snapshotSkipped"] = path is None
    summary["diff"] = diff

    # 星标历史环按天记一点（快照只留 48 份，攒不出"周"窗口）；「周 star 热榜」= 与约 7 天前
    # 那个点的星标差，真实观测值。
    history = snap.update_star_history(mesh, STAR_HISTORY)
    summary["starHistory"] = {
        "points": len(history["points"]),
        "latest": history["points"][-1]["at"] if history["points"] else None,
    }

    # 逐日台账：星标环同天只留一点，攒不出逐日形状 —— 每轮把观测到的星标变化记进当天桶。
    # 四条硬规矩见 snapshot.update_star_daily：首轮只落基线 / 断档转 spans / 缺席保留基线 / 首见不计数。
    star_daily = snap.update_star_daily(mesh, STAR_DAILY)
    last = star_daily["lastRound"]
    summary["starDaily"] = {
        "days": len(star_daily["days"]),
        "sampledDays": len(star_daily["sampledDays"]),
        "spans": len(star_daily["spans"]),
        "counted": last["counted"],
        "gained": last["gained"],
        "carried": last["carried"],
        "baseline": last["baseline"],
    }
    log(
        "星标逐日："
        + ("首轮只落基线（不计入逐日）" if last["baseline"] else "本轮有变化的仓库 " + str(last["counted"]) + " 个（净涨 " + str(last["gained"]) + " 星）")
        + " · 观测台账 " + str(len(star_daily["sampledDays"])) + " 天"
        + " / 逐日 " + str(len(star_daily["days"])) + " 天"
        + " / 跨天宽条 " + str(len(star_daily["spans"])) + " 条"
        + (" · 缺席保留基线 " + str(last["carried"]) + " 个" if last["carried"] else "")
    )

    # 每轮采样 pushedAt 是否前进、按天累计；GitHub 只给最后一次推送时间，周更新次数只能这样观测。
    update_log = snap.update_update_log(mesh, UPDATE_LOG)
    summary["updateLog"] = {"days": len(update_log["days"]), "counted": update_log["lastRound"]["counted"]}

    # 版本（releases）：搜索接口不返回，只能按仓库单独取（1 个仓库 = 1 次 core 配额）
    summary["releases"] = fetch_releases_safe(args, mesh, log)

    # npm 周下载量：可选列；写 data/cache/npm-downloads.json，失败不阻塞前端数据
    summary["npmDownloads"] = fetch_npm_safe(args, mesh, log)

    # npm 反查发现：只写 data/cache/npm-search.json（包 → 仓库），给「插件住在仓库子目录」兜底；
    # 消费端（市场索引 / npm 榜）在后面阶段接入，本轮只攒数据。
    summary["npmSearch"] = fetch_npm_search_safe(args, log)

    # 子目录包下载量：反查发现里「仓库根 package.json 认不出」的那批，单独查（按包名存）
    summary["npmPackages"] = fetch_npm_packages_safe(args, mesh, log)

    limit_for_frontend(mesh, args.frontend_limit)
    mesh["meta"]["note"] = (
        f"每小时自动更新一次的快照（{utcnow()}）。"
        + (f"完整索引 {total_indexed} 个仓库，前端展示星标前 {args.frontend_limit} 个。" if mesh["meta"].get("frontendLimit") else f"本次索引 {total_indexed} 个仓库。")
    )
    summary["frontendNodes"] = len(mesh["nodes"])
    summary["frontendEdges"] = len(mesh["edges"])
    _write_status(
        state="idle",
        phase=None,
        error=None,
        nextRunAt=next_run_at(time.time(), args.interval),
        lastRound={
            "startedAt": summary["roundStartedAt"] if "roundStartedAt" in summary else None,
            "finishedAt": utcnow(),
            "seconds": round(time.time() - started, 1),
            "state": "ok",
            "indexed": total_indexed,
        },
        segments=None,
        fetched=None,
        added=None,
    )
    snap.write_mesh(mesh, MESH_JSON)
    snap.write_last_crawl(summary, LAST_CRAWL)

    log(f"索引 {total_indexed} 个仓库 · 前端 {len(mesh['nodes'])} 个节点 / {len(mesh['edges'])} 条连线")
    run_precompute(log, len(mesh["nodes"]))
    run_market_index(log)
    if path is None:
        log("索引与上一份快照一致，本次不生成新快照")
    else:
        log(f"快照写入 {summary['snapshot']}（用时 {elapsed:.1f} 秒）")
    if stats is not None:
        log(f"请求 {stats.requests} 次（重试 {stats.retries}）· 配额剩余 {stats.rate_limit_remaining}")
        if stats.truncated_slices:
            log(f"⚠ 有 {len(stats.truncated_slices)} 个分片超过接口 1000 条上限，数据被截断")
    if diff.get("baseline"):
        log("这是第一份快照（无对比基线）")
    else:
        log(f"与上一份快照相比：新增 {diff['addedCount']} · 消失 {diff['removedCount']} · 新归档 {diff['archivedCount']}")
        for gain in diff["starGainers"][:3]:
            log(f"  星标涨幅 {gain['id']} +{gain['delta']}（现 {gain['stars']}）")
    return summary


# CLI 参数名 ↔ 后台配置键名。两侧的键名必须一致（decision: config.json 里就用 camelCase，
# 前端设置页直接照抄，不做命名转换），改这里就要顺手改 admin_config.DEFAULT_COLLECTOR。
COLLECTOR_ARG_MAP = {
    "budget": "budget",
    "max_pages": "maxPages",
    "refresh_hours": "refreshHours",
    "readme_budget": "readmeBudget",
    "readme_max_chars": "readmeMaxChars",
    "readme_min_stars": "readmeMinStars",
    "releases_budget": "releasesBudget",
    "npm_budget": "npmBudget",
    "npm_search_budget": "npmSearchBudget",
    "npm_extra_budget": "npmExtraBudget",
    "interval": "interval",
    "min_ratio": "minRatio",
    "frontend_limit": "frontendLimit",
}


def resolve_collector_args(args, config_path=None, log=None) -> dict:
    """把采集参数定下来：**后台配置 > 启动参数 > 内置默认值**。

    为什么是这个顺序（而不是常见的"命令行最高"）：这些参数只服务本机这一个采集进程，
    而后台才是给人用的入口 —— 启动参数里的 --budget 600 是当初写死部署命令留下的，
    若让它压过后台，用户就会遇到"后台改了不生效"。所以启动参数退居"初始化默认值"：
    配置里有这个键就听配置的；没写过的键才用启动参数（再没有就用内置默认）。

    返回 {effective, source}；调用方把它挂到 args.collector / args.collector_source，
    由采集器每轮写进状态文件，后台设置页据此标注每一项当前值是从哪来的。
    """
    configured = admin_config.configured_collector_keys(config_path)  # 用户真写过的键
    config = admin_config.collector_config(config_path)
    source: dict[str, str] = {}
    effective: dict[str, int | float] = {}
    for attr, key in COLLECTOR_ARG_MAP.items():
        cli = getattr(args, attr, None)
        if key in configured:
            value = config[key]
            source[key] = "config"
        elif cli is not None:
            value = cli
            source[key] = "cli"
        else:
            value = admin_config.DEFAULT_COLLECTOR.get(key)
            source[key] = "default"
        setattr(args, attr, value)
        effective[key] = value
    if log:
        parts = []
        for label, tag in (("后台配置", "config"), ("启动参数", "cli"), ("内置默认", "default")):
            keys = [k for k, v in source.items() if v == tag]
            parts.append(label + " " + (str(len(keys)) + " 项（" + "、".join(keys) + "）" if keys else "无"))
        log("采集参数：" + " | ".join(parts))
    return {"effective": effective, "source": source}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="DSH 插件生态索引采集器（纯脚本）")
    parser.add_argument("--once", action="store_true", help="只跑一次（默认）")
    parser.add_argument("--watch", "--loop", dest="watch", action="store_true", help="常驻，按 --interval 周期执行（pm2 下必须用 --loop：pm2 会把 --watch 认成它自己的文件监听开关，导致每次落盘都重启进程）")
    parser.add_argument("--interval", type=int, default=None, help="周期秒数（默认：读后台配置；内置 3600）")
    parser.add_argument("--readme-budget", type=int, default=None, help="每轮抓多少个仓库的 README（默认：读后台配置；0 = 完全关闭）")
    parser.add_argument("--readme-max-chars", type=int, default=None, help="每个仓库保留的 README 摘要字符数（默认：读后台配置）")
    parser.add_argument("--readme-min-stars", type=int, default=None, help="只索引星标 ≥ N 的仓库（默认：读后台配置；0 = 全量）")
    parser.add_argument(
        "--releases-budget",
        type=int,
        default=None,
        help="每轮最多抓多少个仓库的 releases（默认：读后台配置；0 = 关闭）",
    )
    parser.add_argument(
        "--npm-budget",
        type=int,
        default=None,
        help="每轮最多处理多少个仓库的 npm 周下载量（默认：读后台配置；0 = 关闭）",
    )
    parser.add_argument(
        "--npm-search-budget",
        type=int,
        default=None,
        help="每轮 npm 反查最多处理多少条搜索结果（默认：读后台配置；0 = 关闭）",
    )
    parser.add_argument(
        "--npm-extra-budget",
        type=int,
        default=None,
        help="每轮查多少个「子目录包」的 npm 周下载量（默认：读后台配置；0 = 关闭）",
    )
    parser.add_argument("--from-raw", action="store_true", help="用 data/sample-raw.json 离线复算，不发网络请求")
    parser.add_argument("--from-store", action="store_true", help="用累积索引 data/cache/repos.json 离线重建前端契约（改规则后立刻重算，不联网）")
    parser.add_argument("--dry-run", action="store_true", help="只算不写")
    parser.add_argument("--max-pages", type=int, default=None, help="每个分段最多翻几页（默认：读后台配置；GitHub 上限 10）")
    parser.add_argument("--budget", type=int, default=None, help="每轮最多消耗多少次搜索请求（默认：读后台配置；0 = 不限）")
    parser.add_argument("--refresh-hours", type=float, default=None, help="超过这个时长没刷新的分段会重新排队（默认：读后台配置）")
    parser.add_argument("--no-slice", action="store_true", help="（已废弃）分段模式一律按星标切片")
    parser.add_argument("--frontend-limit", type=int, default=None, help="前端快照保留多少个节点（默认：读后台配置；0 = 不限）")
    parser.add_argument("--min-ratio", type=float, default=None, help="低于现有索引的这个比例时拒绝覆盖前端数据（默认：读后台配置）")
    parser.add_argument("--tags", nargs="*", default=None, help="要抓取的标签（默认读 data/admin/config.json，缺失/为空时回退内置白名单）")
    parser.add_argument("--quiet", action="store_true", help="少打印")
    args = parser.parse_args(argv)
    log = (lambda *a, **k: None) if args.quiet else (lambda *a, **k: print(*a, **k, flush=True))

    # 采集参数：显式命令行 > 后台配置 > 内置默认值（以前只认命令行，后台改了不生效）。
    # 只能解析一次：这一步会把结果写回 args，再解析一遍会把"来自配置"误判成"来自命令行"。
    resolved = resolve_collector_args(args, log=log)
    args.collector = resolved["effective"]
    args.collector_source = resolved["source"]
    log("本轮生效：预算 " + str(args.budget) + " 次 / 间隔 " + str(args.interval) + " 秒 / 翻页 " + str(args.max_pages))

    # 抓取标签以 data/admin/config.json 为准（缺失/损坏/为空回退白名单），显式 --tags 优先；各入口共用这份解析。
    args.tags = args.tags or admin_config.whitelist_tags()

    if not args.watch:
        run_once(args, log)
        return 0

    log(f"常驻模式：每 {args.interval} 秒（{args.interval / 3600:.1f} 小时）采集一次")
    while True:
        try:
            run_once(args, log)
        except Exception as err:  # 单轮失败不能让常驻任务死掉
            log(f"[错误] 本轮采集失败：{type(err).__name__}: {err}")
            _write_status(state="error", phase=None, error=f"{type(err).__name__}: {err}"[:200])
        wait = seconds_until_next(time.time(), args.interval)
        log(f"下一轮在 {wait / 60:.1f} 分钟后（{utcnow()}）")
        _write_status(nextRunAt=next_run_at(time.time(), args.interval))
        time.sleep(wait)


if __name__ == "__main__":
    sys.exit(main())
