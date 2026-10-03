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
    WHITELIST_TAGS,
)
from dsh_mesh.segments import SegmentStore, segment_query
from dsh_mesh.github import GitHubClient, load_token


def tag_totals_from(state: dict) -> dict[str, int]:
    """按标签汇总接口报告的仓库总数（已细分的父段不重复计入）。"""
    totals: dict[str, int] = {}
    for segment in state.get("segments", {}).values():
        if segment.get("state") == "done" and segment.get("total") is not None:
            totals[segment["topic"]] = totals.get(segment["topic"], 0) + segment["total"]
    return totals


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
    store.save()

    after = store.coverage()
    log(
        "本轮抓取 " + str(fetched) + " 条 · 累积索引 " + str(after["repos"]) + " 个仓库（新增 "
        + str(added_this_round) + "）| 分段：待抓 " + str(after["segments"]["pending"])
        + " / 已抓 " + str(after["segments"]["done"]) + " / 已细分 " + str(after["segments"]["split"])
    )
    raws = list(store.repos.values())
    return raws, tag_totals_from(store.state), client.stats, {
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
        # 崩在退出阶段也不影响产物：core 完整重写过（能解析、节点数对得上）就算成功
        if _core_looks_fresh(started, expected_nodes):
            return True, "产物已更新（子进程退出码 " + str(result.returncode) + "，退出阶段崩溃不影响结果）"
        return False, result.stderr.strip()[:160] or ("退出码 " + str(result.returncode))

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


def run_once(args, log) -> dict:
    started = time.time()
    log(f"=== 采集开始 {utcnow()} ===")
    # 噪声作者黑名单：长期生效。命中者既不进累积索引、也不进前端契约。
    blacklist = snap.load_blacklist(NOISE_BLACKLIST)
    if blacklist:
        log("噪声黑名单：" + str(len(blacklist)) + " 个作者（" + "、".join(sorted(blacklist)[:5]) + ("…" if len(blacklist) > 5 else "") + "）")
    if args.from_raw:
        raws, tag_totals, stats, env = load_from_raw(log)
    else:
        raws, tag_totals, stats, env = fetch_live(args, log, blacklist)

    mesh = build_mesh(raws, tag_totals, blacklist=blacklist)
    noise_now = mesh["meta"].get("noiseBlacklist") or {}
    new_noise = {owner: info for owner, info in noise_now.items() if owner not in blacklist}
    mesh["meta"]["kind"] = "sample-seed" if args.from_raw else "hourly-crawl"
    mesh["meta"]["builtFrom"] = "data/sample-raw.json（离线复算）" if args.from_raw else "GitHub REST Search API"
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
        "seconds": round(elapsed, 1),
    }

    summary["noiseBlacklistSize"] = len(noise_now)
    summary["noiseNodesRemoved"] = mesh["meta"].get("noiseNodesRemoved", 0)
    summary["noisePurged"] = env.get("noisePurged", 0)
    if new_noise:
        log(
            "⚠ 新判定噪声作者 " + str(len(new_noise)) + " 个："
            + "、".join(f"{owner}（{info['repos']} 个仓库 · 最高 {info['maxStars']} 星）" for owner, info in sorted(new_noise.items())[:5])
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
    path, diff = snap.write_snapshot(mesh, SNAPSHOT_DIR, KEEP_SNAPSHOTS)
    summary["snapshot"] = str(path.relative_to(MESH_JSON.parent.parent)) if path else None
    summary["snapshotSkipped"] = path is None
    summary["diff"] = diff

    limit_for_frontend(mesh, args.frontend_limit)
    mesh["meta"]["note"] = (
        f"每小时自动更新一次的快照（{utcnow()}）。"
        + (f"完整索引 {total_indexed} 个仓库，前端展示星标前 {args.frontend_limit} 个。" if mesh["meta"].get("frontendLimit") else f"本次索引 {total_indexed} 个仓库。")
    )
    summary["frontendNodes"] = len(mesh["nodes"])
    summary["frontendEdges"] = len(mesh["edges"])
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
    parser.add_argument("--from-raw", action="store_true", help="用 data/sample-raw.json 离线复算，不发网络请求")
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
        wait = seconds_until_next(time.time(), args.interval)
        log(f"下一轮在 {wait / 60:.1f} 分钟后（{utcnow()}）")
        time.sleep(wait)


if __name__ == "__main__":
    sys.exit(main())
