#!/usr/bin/env python3
"""DSH 插件生态索引采集器 —— 纯脚本，全程不涉及任何模型调用。

用法：
    python3 backend/collect.py --once                  # 跑一次（真实抓取）
    python3 backend/collect.py --from-raw --dry-run    # 用本地原始记录离线复算，不写盘
    python3 backend/collect.py --watch --interval 3600 # 常驻，每小时一份快照

产出：
    data/mesh.json                 前端契约（星标头部，默认 2000 个节点）
    data/snapshots/<时间戳>.json    历史快照（保留最近 48 份）
    data/last-crawl.json           本次采集的溯源信息（请求数、配额、差异）
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

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
    RELEASES_CACHE,
    STAR_DAILY,
    STAR_HISTORY,
    UPDATE_LOG,
    README_CACHE,
    WHITELIST_TAGS,
)
from dsh_mesh.readmes import ReadmeIndex, fetch_batch as fetch_readmes
from dsh_mesh import releases as rel
from dsh_mesh.status import STATUS_FILE, next_run_at, write_status
from dsh_mesh.segments import SegmentStore, segment_query
from dsh_mesh.github import GitHubClient, load_token


RELEASES_BUDGET = 300  # 每轮默认抓 300 个仓库的 releases（core 配额 5000/小时，留足余量）
RELEASES_INTERVAL = 0.12  # 每次请求之间歇一下，别撞二级限流


def tag_totals_from(state: dict) -> dict[str, int]:
    """按标签汇总接口报告的仓库总数（已细分的父段不重复计入）。"""
    totals: dict[str, int] = {}
    for segment in state.get("segments", {}).values():
        if segment.get("state") == "done" and segment.get("total") is not None:
            totals[segment["topic"]] = totals.get(segment["topic"], 0) + segment["total"]
    return totals


def _write_status(**fields) -> None:
    """写采集进度状态。包一层是为了让测试能 mock collect.STATUS_FILE 做路径隔离 ——
    直接调 dsh_mesh.status.write_status 的话，路径写死在模块里，测试跑一轮就会污染真实的 data/cache。"""
    write_status(STATUS_FILE, **fields)


def _report_progress(store, fetched: int, added: int, client, args, **extra) -> None:
    """把当前进度写进 data/status.json（前端顶栏的"状态"圆环/浮窗读它）。dry-run 不写。"""
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
    # 已判定的噪声作者：从累积索引里清掉，并让后续 merge 直接跳过（不再占配额）
    purged = store.drop_owners(set(blacklist or ()))
    if purged:
        log("噪声黑名单：从累积索引剔除 " + str(purged) + " 个仓库（作者 " + str(len(blacklist)) + " 个）")
        store.save()
    seeded = store.ensure_seeded(args.tags)
    if seeded:
        log("分段队列初始化：新增 " + str(seeded) + " 个待抓分段")
    store.requeue_truncated(log=log)  # 之前被截断的段，按更细粒度补扫
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

    after = store.coverage()
    log(
        "本轮抓取 " + str(fetched) + " 条 · 累积索引 " + str(after["repos"]) + " 个仓库（新增 "
        + str(added_this_round) + "）| 分段：待抓 " + str(after["segments"]["pending"])
        + " / 已抓 " + str(after["segments"]["done"]) + " / 已细分 " + str(after["segments"]["split"])
    )
    # README 索引：抓完仓库后按预算补一批（供"搜索 README 内容"用，见 dsh_mesh/readmes.py）。
    # 放在爬取之后：热度高的仓库优先，且不挤占分段扫描的请求预算。
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
                        # 面板要的是"可索引的仓库里索引了多少"（≤ target）；
                        # 缓存总量含早期抓过、现已不达标的条目，直接当分子会出现 14513 / 14490 这种怪值
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
    """mesh-core.json 是否在这次尝试之后被完整重写过。

    只看 mtime 不够：子进程可能在写文件写到一半时崩，留下半截 JSON。
    所以还要能解析、节点数对得上、layout 标记正确，才认这次预计算成功。
    """
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
    """二进制契约（mesh-core.bin / head.bin）是否也随本轮刷新了。

    只看 mtime：内容正确性由编解码器的单测与往返比对保证（Python 侧不重复实现一遍格式解析）。
    data_dir 可显式传入（测试用），默认取配置里的数据目录。
    """
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

    失败不影响数据本身：前端拿不到 core 会自动回退到本地计算布局。
    expected_nodes：本轮 mesh.json 的节点数，用来校验产物是否完整（防半截文件）。
    """
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
        """跑一次预计算。成功 / 产物已更新都算成功。"""
        started = time.time()
        try:
            result = subprocess.run(
                [node, str(script)],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=900,
                # pm2 托管下 node 偶发 libuv 断言（uv__io_poll: errno == EEXIST）；
                # 独立会话 + 空 stdin 能避开父进程进程组/信号带来的干扰
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:  # noqa: BLE001 - 预计算失败不该拖垮采集
            return False, str(exc)[:160]
        if result.returncode == 0:
            lines = [line for line in result.stdout.strip().splitlines() if line.strip()]
            return True, (lines[-1].strip() if lines else "")
        # 非零退出：core 可能已经写好了，但【二进制契约常常就停在崩溃点之前】——
        # 事故复盘：mesh-core.json 一直更新，mesh-core.bin 被冻结了 40 小时，
        # 而这里把退出码 1 记成"退出阶段崩溃不影响结果"，于是没人发现。
        # 所以非零退出必须同时确认二进制契约也刷新了，才认成功。
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


def load_from_store(args, log):
    """离线重建：直接用累积索引（data/cache/repos.json）构图，不联网、不消耗配额。

    改了分类 / 噪声 / 相关性规则后，用它立刻把前端契约按新规则重算一遍，
    不必等下一轮采集。跑的仍然是同一套 build_mesh + 预计算，只是数据源换成已抓到的记录。
    """
    store = SegmentStore(SEGMENT_STATE, REPO_CACHE)
    raws = list(store.repos.values())
    log("离线重建：读入累积索引 " + str(len(raws)) + " 条记录（零网络请求）")
    return raws, tag_totals_from(store.state), None, {"mode": "store-rebuild", "token": "-"}


def fetch_releases_safe(args, mesh: dict, log) -> dict:
    """跑版本抓取，但**永不抛异常**。

    版本缓存是"周更新热榜"的判定依据，却是加分项：它失败不该让本轮的前端数据不落盘。
    线上踩过：一次 RemoteDisconnected 在写 mesh 之前把整轮打断，站点白等一小时。
    """
    try:
        return fetch_releases(args, mesh, log)
    except Exception as exc:  # noqa: BLE001 - 这里就是要吞掉它，见上
        log("⚠ 版本抓取本轮失败（不阻塞前端数据）：" + str(exc)[:120])
        return {"enabled": True, "error": str(exc)[:120]}


def fetch_releases(args, mesh: dict, log) -> dict:
    """按预算抓 releases（走 core 配额），并写回 data/cache/releases.json。

    为什么单独一轮一步：搜索接口不返回 releases，只能一个仓库一次请求；
    配额实测是"按认证身份一个桶"（同账号多令牌共享），所以这里只能限量 + 排优先级：
    先抓"近 7 天推过 / 星标高 / 从没抓过或过期"的仓库（见 releases.pick_candidates）。

    离线模式（--from-raw / --from-store）与 dry-run 一律跳过 —— 测试因此完全不碰网络。
    """
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
    streak = 0  # 连续失败计数
    for repo_id in picked:
        if client.stats.core_remaining is not None and client.stats.core_remaining < rel.CORE_FLOOR:
            log("版本：core 配额只剩 " + str(client.stats.core_remaining) + "，本轮提前收手（下一轮接着抓）")
            break
        try:
            items = client.releases(repo_id, per_page=rel.RELEASES_KEEP)
        except Exception as err:  # noqa: BLE001 - 单个仓库失败就跳过：抖动/超时都不该打断整批
            failed += 1
            streak += 1
            log("版本：" + repo_id + " 抓取失败（跳过）：" + str(err)[:80])
            if streak >= 5:
                # 网络真断了的话，别把剩下几百个仓库挨个重试（每个还要退避 3 次，能耗掉一小时）
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


def run_once(args, log) -> dict:
    started = time.time()
    log(f"=== 采集开始 {utcnow()} ===")
    if not args.dry_run:
        _write_status(
            state="crawling",
            phase="segments",
            roundStartedAt=utcnow(),
            roundSeconds=args.interval,
            nextRunAt=next_run_at(time.time(), args.interval),
            error=None,
            fetched=0,
            added=0,
        )
    # 噪声作者黑名单：长期生效。命中者既不进累积索引、也不进前端契约。
    blacklist = snap.load_blacklist(NOISE_BLACKLIST)
    if blacklist:
        log("噪声黑名单：" + str(len(blacklist)) + " 个作者（" + "、".join(sorted(blacklist)[:5]) + ("…" if len(blacklist) > 5 else "") + "）")
    if args.from_raw:
        raws, tag_totals, stats, env = load_from_raw(log)
    elif getattr(args, "from_store", False):
        raws, tag_totals, stats, env = load_from_store(args, log)
    else:
        raws, tag_totals, stats, env = fetch_live(args, log, blacklist)

    if not args.dry_run:
        _write_status(state="building", phase="build")
    mesh = build_mesh(raws, tag_totals, blacklist=blacklist)
    noise_now = mesh["meta"].get("noiseBlacklist") or {}
    new_noise = {owner: info for owner, info in noise_now.items() if owner not in blacklist}
    if env.get("readme"):
        mesh["meta"]["readmeIndexed"] = env["readme"].get("indexed")
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
        "frontendNodes": None,  # 裁剪后回填
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

    # 黑名单落盘：下一轮抓取会直接跳过这些作者（人工删条目即可解除）
    if new_noise or (noise_now and not NOISE_BLACKLIST.exists()):
        snap.write_blacklist(noise_now, NOISE_BLACKLIST)
        log("噪声黑名单已写入 data/noise-blacklist.json（共 " + str(len(noise_now)) + " 个作者）")

    # 缩水保护：分段扫描预热期累积索引必然很小，绝不能拿它覆盖已有的完整索引。
    # 但被黑名单剔除的仓库不算"缩水"——它们本来就不该再展示，否则第一次拉黑会被这道保护挡住。
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

    # 先按【完整索引】写快照，再裁剪给前端。
    # 顺序反了的话，快照只会记录前端展示的头部，diff 会把"掉出头部"误报成"消失"。
    # 索引与上一份完全一致时跳过写盘：不重复生成快照。
    if not args.dry_run:
        _write_status(state="building", phase="write")
    path, diff = snap.write_snapshot(mesh, SNAPSHOT_DIR, KEEP_SNAPSHOTS)
    summary["snapshot"] = str(path.relative_to(MESH_JSON.parent.parent)) if path else None
    summary["snapshotSkipped"] = path is None
    summary["diff"] = diff

    # 星标历史环：按天记一个点（快照只留 KEEP_SNAPSHOTS 份，攒不出"周"窗口）。
    # 前端「周 star 热榜」= 最近这个点与"约 7 天前"那个点的星标之差，真实观测值，不是估算。
    history = snap.update_star_history(mesh, STAR_HISTORY)
    summary["starHistory"] = {
        "points": len(history["points"]),
        "latest": history["points"][-1]["at"] if history["points"] else None,
    }

    # 逐日星标增量：星标环一天只留一个点（同天覆盖），攒不出逐日形状 —— 这里每轮把
    # "本轮星标变化"累加进当天桶，star 榜的逐日趋势柱用它（每天都是真实观测的累加值）。
    star_daily = snap.update_star_daily(mesh, STAR_DAILY)
    summary["starDaily"] = {
        "days": len(star_daily["days"]),
        "counted": star_daily["lastRound"]["counted"],
        "gained": star_daily["lastRound"]["gained"],
    }
    log(
        "星标逐日：本轮有变化的仓库 "
        + str(star_daily["lastRound"]["counted"])
        + " 个（净涨 "
        + str(star_daily["lastRound"]["gained"])
        + " 星）· 已记 "
        + str(len(star_daily["days"]))
        + " 天"
    )

    # 更新日志：每轮采样"pushedAt 比上次前进了吗"，按天累计次数。
    # 前端「周更新热榜」按它排序 —— GitHub 只给最后一次推送时间，"一周更新几次"只能这样观测。
    update_log = snap.update_update_log(mesh, UPDATE_LOG)
    summary["updateLog"] = {"days": len(update_log["days"]), "counted": update_log["lastRound"]["counted"]}

    # 版本（releases）：搜索接口不返回，只能按仓库单独取（1 个仓库 = 1 次 core 配额）
    summary["releases"] = fetch_releases_safe(args, mesh, log)

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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="DSH 插件生态索引采集器（纯脚本）")
    parser.add_argument("--once", action="store_true", help="只跑一次（默认）")
    parser.add_argument("--watch", "--loop", dest="watch", action="store_true", help="常驻，按 --interval 周期执行（pm2 下必须用 --loop：pm2 会把 --watch 认成它自己的文件监听开关，导致每次落盘都重启进程）")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="周期秒数，默认 3600（每小时）")
    parser.add_argument("--readme-budget", type=int, default=150, help="每轮抓多少个仓库的 README（供搜索 README 内容；0 = 完全关闭）")
    parser.add_argument("--readme-max-chars", type=int, default=2000, help="每个仓库保留的 README 摘要字符数（越大越全、索引越大）")
    parser.add_argument("--readme-min-stars", type=int, default=1, help="只索引星标 ≥ N 的仓库（默认 1：跳过 0 星长尾，索引约减半；设 0 = 全量）")
    parser.add_argument(
        "--releases-budget",
        type=int,
        default=RELEASES_BUDGET,
        help="每轮最多抓多少个仓库的 releases（1 个仓库 = 1 次 core 配额；0 = 关闭）",
    )
    parser.add_argument("--from-raw", action="store_true", help="用 data/sample-raw.json 离线复算，不发网络请求")
    parser.add_argument("--from-store", action="store_true", help="用累积索引 data/cache/repos.json 离线重建前端契约（改规则后立刻重算，不联网）")
    parser.add_argument("--dry-run", action="store_true", help="只算不写")
    parser.add_argument("--max-pages", type=int, default=10, help="每个分段最多翻几页（GitHub 上限 10 页 = 1000 条）")
    parser.add_argument("--budget", type=int, default=DEFAULT_BUDGET, help="每轮最多消耗多少次搜索请求（0 = 不限）")
    parser.add_argument("--refresh-hours", type=float, default=REFRESH_HOURS, help="超过这个时长没刷新的分段会重新排队")
    parser.add_argument("--no-slice", action="store_true", help="（已废弃）分段模式一律按星标切片")
    parser.add_argument("--frontend-limit", type=int, default=FRONTEND_LIMIT, help="前端快照保留多少个节点（0 = 不限）")
    parser.add_argument("--min-ratio", type=float, default=0.8, help="低于现有索引的这个比例时拒绝覆盖前端数据")
    parser.add_argument("--tags", nargs="*", default=WHITELIST_TAGS, help="要抓取的标签")
    parser.add_argument("--quiet", action="store_true", help="少打印")
    args = parser.parse_args(argv)
    log = (lambda *a, **k: None) if args.quiet else (lambda *a, **k: print(*a, **k, flush=True))

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
