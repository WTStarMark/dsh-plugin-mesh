#!/usr/bin/env python3
"""采集器测试（标准库 unittest，无需 pytest）。

运行：python3 backend/tests/test_collector.py
"""

from __future__ import annotations

import json
import shutil
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from dsh_mesh import snapshot as snap  # noqa: E402
from dsh_mesh.build import build_mesh, limit_for_frontend, relevance_score  # noqa: E402
from dsh_mesh.classify import apply_categories, classify_node  # noqa: E402
from dsh_mesh.config import HUB_ID, SAMPLE_MESH, SAMPLE_RAW, WHITELIST_TAGS  # noqa: E402
from dsh_mesh.github import GitHubClient, load_token  # noqa: E402
from collect import seconds_until_next  # noqa: E402

TMP = Path(__file__).resolve().parent / ".tmp"


def sample_raw() -> list[dict]:
    return json.loads(SAMPLE_RAW.read_text(encoding="utf-8"))["repos"]


def sample_mesh() -> dict:
    """JS 管线的冻结参照物。data/mesh.json 每小时被采集器覆盖，不能用来做一致性基准。"""
    return json.loads(SAMPLE_MESH.read_text(encoding="utf-8"))


class ClassifyTest(unittest.TestCase):
    def test_skin_and_tools_examples(self):
        self.assertEqual(classify_node({"name": "dsh-skin", "description": "一款 DSH 皮肤主题", "topics": []})["id"], "skin")
        self.assertEqual(classify_node({"name": "dsh-cli-tool", "description": "命令行工具，一键安装", "topics": []})["id"], "tools")

    def test_whitelist_tags_are_not_evidence(self):
        result = classify_node({"name": "repo", "description": "", "topics": list(WHITELIST_TAGS)})
        self.assertEqual(result["id"], "other")
        self.assertEqual(result["score"], 0)

    def test_weights_are_not_duplicated(self):
        """回归：JS 规则表里 review 曾重复一次，导致 31 个仓库被过度归入 dev。"""
        seen = set()
        for rule in __import__("dsh_mesh.classify", fromlist=["CATEGORY_RULES"]).CATEGORY_RULES:
            for term, _weight in rule["terms"]:
                key = (rule["id"], term)
                self.assertNotIn(key, seen, f"规则重复：{key}")
                seen.add(key)

    def test_apply_merges_small_categories(self):
        nodes = [{"id": f"a/{i}", "name": f"dsh-skin-{i}", "description": "皮肤", "topics": []} for i in range(20)]
        # 新规则下"插件市场"四个字不足以判定，需要自述汇总（收录/汇集）
        nodes += [{"id": f"b/{i}", "name": f"dsh-market-{i}", "description": "插件市场，收录所有 dsh 插件", "topics": []} for i in range(3)]
        stats = apply_categories(nodes, min_count=10, max_sectors=10)
        self.assertEqual(stats["unclassified"], 3)
        self.assertEqual(stats["merged"][0]["id"], "market")
        self.assertEqual(nodes[0]["category"], "skin")


class ParityTest(unittest.TestCase):
    """Python 采集器必须与前端 JS 管线产出完全相同的结果。"""

    def test_matches_js_output(self):
        js = sample_mesh()
        py = build_mesh(sample_raw(), {})

        js_ids = {n["id"] for n in js["nodes"]}
        py_ids = {n["id"] for n in py["nodes"]}
        self.assertEqual(js_ids, py_ids, "节点集合不一致")

        js_cat = {n["id"]: n.get("category") for n in js["nodes"]}
        py_cat = {n["id"]: n.get("category") for n in py["nodes"]}
        self.assertEqual(js_cat, py_cat, "功能分类不一致")

        key = lambda e: (e["type"], e["source"], e["target"])  # noqa: E731
        self.assertEqual({key(e) for e in js["edges"]}, {key(e) for e in py["edges"]}, "连线集合不一致")

        js_stars = {n["id"]: n["stars"] for n in js["nodes"]}
        py_stars = {n["id"]: n["stars"] for n in py["nodes"]}
        self.assertEqual(js_stars, py_stars, "星标不一致")


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mesh = build_mesh(sample_raw(), {})

    def test_exact_topic_filter(self):
        for node in self.mesh["nodes"]:
            self.assertTrue(node["matchedTags"], "缺少命中标签：" + node["id"])
            for tag in node["matchedTags"]:
                self.assertIn(tag, node["topics"], f"{node['id']} 的 topics 里没有 {tag}")

    def test_owner_groups_are_connected(self):
        """用户报过的 bug：Tencent 组的同作者连线曾被度数裁剪静默丢弃。"""
        by_owner: dict[str, list[str]] = {}
        for node in self.mesh["nodes"]:
            by_owner.setdefault(node["owner"], []).append(node["id"])
        adj: dict[str, list[str]] = {n["id"]: [] for n in self.mesh["nodes"]}
        for edge in self.mesh["edges"]:
            if edge["type"] != "owner":
                continue
            adj[edge["source"]].append(edge["target"])
            adj[edge["target"]].append(edge["source"])
        groups = 0
        for owner, ids in by_owner.items():
            if len(ids) < 2:
                continue
            groups += 1
            seen, stack = {ids[0]}, [ids[0]]
            while stack:
                for nxt in adj[stack.pop()]:
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            for nid in ids:
                self.assertIn(nid, seen, f"同作者未连通：{owner} / {nid}")
        self.assertGreater(groups, 10)

    def test_topic_edges_are_capped_but_owner_edges_are_not(self):
        self.assertGreater(self.mesh["meta"]["droppedEdges"], 0, "主题边应该被裁剪过")
        tencent = [e for e in self.mesh["edges"] if e["type"] == "owner" and "Tencent/" in e["source"]]
        self.assertTrue(tencent, "Tencent 组的同作者连线不应被裁掉")

    def test_relevance_flags_noise(self):
        spam = {"name": "reactive-resume", "description": "A resume builder", "topics": ["dsh-plugin"]}
        self.assertEqual(relevance_score(spam), 0)
        self.assertTrue(relevance_score({"name": "dsh-desktop", "description": "DSH 桌面版", "topics": ["dsh"]}) >= 5)

    def test_analyze_relevance_three_way(self):
        """三档结论：related / noise / manual，且 review 只在 manual 档为真。"""
        from dsh_mesh.build import analyze_relevance

        def repo(**over):
            base = {"name": "x", "description": "", "topics": [], "matchedTags": ["dsh"], "stars": 0}
            base.update(over)
            return base

        cases = {
            "related": [
                repo(name="dsh-skin-pack"),
                repo(name="my-plugin", description="A plugin for DeepSeek Harness"),
                repo(name="cool", topics=["deepseek-harness"]),
            ],
            "noise": [
                repo(name="reactive-resume", description="A one-of-a-kind resume builder", stars=43705),
                repo(name="enterprise-compliance", description="enterprise-compliance", matchedTags=["dsh", "dsh-plugin", "dsh-plugins", "dsh-plugin-market"]),
                repo(name="marketplace", description="plugin marketplace", topics=["claude-code-plugin", "codex-plugin", "dsh-plugin"]),
                repo(name="law-thesis-review", description="", matchedTags=["dsh-plugin", "dsh-plugins", "dsh-plugin-market"]),
            ],
            "manual": [
                repo(name="task-board-plugin", description="A task board plugin for agents", matchedTags=["dsh-plugin"]),
                repo(name="browser-skill", description="Let agents use your real browser"),
            ],
        }
        for expect, items in cases.items():
            for item in items:
                got = analyze_relevance(item)
                self.assertEqual(got["verdict"], expect, f"{item['name']} 应判 {expect}，实际 {got}")
                self.assertEqual(got["review"], expect == "manual")
                self.assertTrue(got["reason"])

    def test_build_mesh_records_verdict_counts(self):
        # 只挂最宽泛的 dsh 一个标签、正文与 DSH 无关 —— 正是线上那批蹭标签的流行项目
        spam = fake_repo("bob", "reactive-resume", stars=900, topics=("dsh",))
        spam["description"] = "A one-of-a-kind resume builder"
        raws = [fake_repo("alice", "dsh-skin"), spam]
        mesh = build_mesh(raws, {})
        counts = mesh["meta"]["verdictCounts"]
        self.assertEqual(sum(counts.values()), len(mesh["nodes"]))
        self.assertEqual(counts["related"], 1, "dsh-skin 应判相关")
        self.assertEqual(counts["noise"], 1, "蹭标签的流行项目应判噪声")
        self.assertEqual(mesh["meta"]["reviewedAsNoise"], counts["manual"])

    def test_frontend_limit_keeps_hub_and_filters_edges(self):
        mesh = build_mesh(sample_raw(), {})
        total = len(mesh["nodes"])
        limit_for_frontend(mesh, 100)
        self.assertEqual(len(mesh["nodes"]), 100)
        self.assertIn(HUB_ID, {n["id"] for n in mesh["nodes"]}, "圆心仓库必须保留")
        ids = {n["id"] for n in mesh["nodes"]}
        for edge in mesh["edges"]:
            self.assertIn(edge["source"], ids)
            self.assertIn(edge["target"], ids)
        self.assertEqual(mesh["meta"]["indexedNodes"], total)
        self.assertEqual(mesh["meta"]["frontendLimit"], 100)


def fake_repo(owner: str, name: str, stars: int = 0, topics=("dsh", "dsh-plugin")) -> dict:
    """造一条 GitHub 搜索接口形态的原始记录（build_mesh 会走 pick_repo 裁剪）。

    id 用 full_name 代替真实接口的数字 id：累积索引就是按这个字段去重的。
    """
    return {
        "id": f"{owner}/{name}",
        "full_name": f"{owner}/{name}",
        "name": name,
        "owner": {"login": owner, "type": "User", "avatar_url": "https://example.com/a.png"},
        "html_url": f"https://github.com/{owner}/{name}",
        "stargazers_count": stars,
        "forks_count": 0,
        "open_issues_count": 0,
        "created_at": "2026-01-01T00:00:00Z",
        "pushed_at": "2026-01-02T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
        "language": "JavaScript",
        "license": None,
        "archived": False,
        "fork": False,
        "description": "dsh 插件生态相关项目",
        "homepage": None,
        "size": 1,
        "topics": list(topics),
    }


class NoiseBlacklistTest(unittest.TestCase):
    """噪声黑名单：同一作者被收录 >200 个仓库、且每个仓库星标都 <1 => 剔除。"""

    def test_owner_over_threshold_with_all_zero_stars_is_noise(self):
        from dsh_mesh.build import find_noise_owners

        raws = [fake_repo("spammer", f"dsh-spam-{i}") for i in range(201)]
        raws.append(fake_repo("normal", "dsh-good", stars=7))
        mesh = build_mesh(raws, {})
        owners = {n["owner"] for n in mesh["nodes"]}
        self.assertNotIn("spammer", owners, "噪声作者不该出现在契约里")
        self.assertIn("normal", owners)
        self.assertEqual(mesh["meta"]["noiseNodesRemoved"], 201)
        self.assertIn("spammer", mesh["meta"]["noiseBlacklist"])
        self.assertEqual(mesh["meta"]["noiseBlacklist"]["spammer"]["repos"], 201)
        self.assertEqual(find_noise_owners([{"owner": "x", "stars": 0}] * 201)["x"]["maxStars"], 0)

    def test_boundary_exactly_200_is_kept(self):
        mesh = build_mesh([fake_repo("busy", f"dsh-{i}") for i in range(200)], {})
        self.assertEqual(len(mesh["nodes"]), 200, "正好 200 个不算「超过」")
        self.assertEqual(mesh["meta"]["noiseBlacklist"], {})

    def test_one_star_saves_the_owner(self):
        raws = [fake_repo("productive", f"dsh-{i}") for i in range(250)]
        raws.append(fake_repo("productive", "dsh-hit", stars=1))
        mesh = build_mesh(raws, {})
        self.assertEqual(len(mesh["nodes"]), 251, "只要有一个仓库拿到星标就不判噪声")
        self.assertEqual(mesh["meta"]["noiseBlacklist"], {})

    def test_persisted_blacklist_always_wins(self):
        """已判定的黑名单长期生效：下一轮只抓到它两三个仓库也不再收录。"""
        blacklist = {"spammer": {"repos": 900, "maxStars": 0}}
        raws = [fake_repo("spammer", f"dsh-spam-{i}", stars=3) for i in range(3)]
        raws.append(fake_repo("normal", "dsh-good"))
        mesh = build_mesh(raws, {}, blacklist=blacklist)
        self.assertEqual([n["owner"] for n in mesh["nodes"]], ["normal"])
        self.assertEqual(mesh["meta"]["noiseSkipped"], 3)
        self.assertIn("spammer", mesh["meta"]["noiseBlacklist"])

    def test_blacklist_file_round_trip(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "noise-blacklist.json"
            self.assertEqual(snap.load_blacklist(path), {}, "文件不存在时应返回空表")
            snap.write_blacklist({"spammer": {"repos": 201, "maxStars": 0}}, path)
            loaded = snap.load_blacklist(path)
            self.assertEqual(loaded, {"spammer": {"repos": 201, "maxStars": 0}})
            path.write_text("{ 坏掉的 json", encoding="utf-8")
            self.assertEqual(snap.load_blacklist(path), {}, "文件损坏时不能拖垮采集")


class SegmentBlacklistTest(unittest.TestCase):
    """扫描管道：黑名单作者的仓库不进累积索引，已收录的要被清掉。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_merge_skips_and_drop_purges(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s8.json", TMP / "r8.json", blacklist={"spammer"})
        added = store.merge([fake_repo("spammer", "a"), fake_repo("ok", "b")])
        self.assertEqual(added, 1)
        self.assertNotIn("spammer/a", store.repos, "黑名单作者不该进累积索引")

        legacy = SegmentStore(TMP / "s9.json", TMP / "r9.json")
        legacy.merge([fake_repo("bad", "x"), fake_repo("bad", "y"), fake_repo("ok", "z")])
        self.assertEqual(len(legacy.repos), 3)
        removed = legacy.drop_owners({"bad"})
        self.assertEqual(removed, 2, "已收录的噪声仓库必须被清掉")
        self.assertEqual(set(legacy.repos), {"ok/z"})
        self.assertEqual(legacy.merge([fake_repo("bad", "w")]), 0, "拉黑后不再收录")
        self.assertNotIn("bad/w", legacy.repos)

    def test_owner_of_handles_both_record_shapes(self):
        from dsh_mesh.segments import owner_of

        self.assertEqual(owner_of({"owner": {"login": "a"}}), "a")
        self.assertEqual(owner_of({"owner": "b"}), "b")
        self.assertEqual(owner_of({"full_name": "c/d"}), "c")
        self.assertEqual(owner_of({}), "")


class PrecomputeRetryTest(unittest.TestCase):
    """回归：node 偶发 libuv 断言崩溃时要重试一次，否则 core 会冻结在上一小时。"""

    def test_retries_once_then_succeeds(self):
        import collect

        calls = []

        class Result:
            def __init__(self, code):
                self.returncode = code
                self.stdout = "预计算完成（布局 1ms）"
                self.stderr = "node: uv__io_poll: Assertion failed" if code else ""

        def fake_run(*_args, **_kwargs):
            calls.append(1)
            return Result(1) if len(calls) == 1 else Result(0)

        logs: list[str] = []
        with mock.patch("collect.subprocess.run", side_effect=fake_run), mock.patch(
            "collect._core_looks_fresh", return_value=False
        ), mock.patch("collect.time.sleep"):
            collect.run_precompute(logs.append)
        self.assertEqual(len(calls), 2, "第一次失败后必须重试一次")
        self.assertTrue(any("重试" in line for line in logs), str(logs))
        self.assertTrue(any("预计算完成" in line for line in logs), str(logs))

    def test_gives_up_after_two_attempts(self):
        import collect

        calls = []

        class Result:
            returncode = 1
            stdout = ""
            stderr = "node: uv__io_poll: Assertion failed"

        with mock.patch("collect.subprocess.run", side_effect=lambda *a, **k: (calls.append(1), Result())[1]), mock.patch(
            "collect._core_looks_fresh", return_value=False
        ), mock.patch("collect.time.sleep"):
            logs: list[str] = []
            collect.run_precompute(logs.append)
        self.assertEqual(len(calls), 2, "只重试一次，不能无限重试")
        self.assertTrue(any("不影响数据" in line for line in logs), str(logs))

    def test_crash_after_writing_counts_as_success(self):
        """回归：pm2 托管下 node 崩在退出阶段（uv__io_poll 断言），但 core 其实已经写好。
        这种情况不能再报失败，否则每小时刷一条假告警，也没人知道地图其实已经更新。"""
        import collect

        calls = []

        class Result:
            returncode = 134
            stdout = "  节点 18723 · 连线 24574 · 扇区 21"
            stderr = "node: uv__io_poll: Assertion errno == EEXIST failed."

        logs: list[str] = []
        with mock.patch("collect.subprocess.run", side_effect=lambda *a, **k: (calls.append(1), Result())[1]), mock.patch(
            "collect._core_looks_fresh", return_value=True
        ), mock.patch("collect.time.sleep"):
            collect.run_precompute(logs.append)
        self.assertEqual(len(calls), 1, "产物已更新就不必重试")
        self.assertTrue(any("预计算完成" in line and "产物已更新" in line for line in logs), str(logs))

    def test_half_written_core_is_not_success(self):
        """写到一半崩掉会留下半截 JSON —— 这种"产物"绝不能算成功。"""
        import collect
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            core = Path(tmp) / "mesh-core.json"
            core.write_text(json.dumps({"meta": {"layout": "precomputed"}, "nodes": [1, 2, 3]}), encoding="utf-8")
            with mock.patch("dsh_mesh.config.MESH_JSON", Path(tmp) / "mesh.json"):
                self.assertTrue(collect._core_looks_fresh(0, 3), "完整产物应判成功")
                self.assertFalse(collect._core_looks_fresh(0, 18723), "节点数对不上不能算成功")
                core.write_text('{"meta": {"layout": "precomputed"}, "nodes": [1, 2', encoding="utf-8")
                self.assertFalse(collect._core_looks_fresh(0, None), "半截 JSON 不能算成功")


class RunOnceOrderTest(unittest.TestCase):
    """回归：快照必须在裁剪给前端【之前】写，否则记录不到完整索引。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_snapshot_covers_full_index_while_mesh_is_limited(self):
        import collect

        with mock.patch.object(collect, "MESH_JSON", TMP / "mesh.json"), mock.patch.object(
            collect, "SNAPSHOT_DIR", TMP / "snapshots"
        ), mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"):
            code = collect.main(["--from-raw", "--frontend-limit", "100", "--quiet"])
        self.assertEqual(code, 0)

        mesh = json.loads((TMP / "mesh.json").read_text(encoding="utf-8"))
        self.assertEqual(len(mesh["nodes"]), 100, "前端契约应被裁剪到 100 个节点")
        self.assertIn(HUB_ID, {n["id"] for n in mesh["nodes"]})

        snapshot = snap.latest_snapshot(TMP / "snapshots")
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["counts"]["nodes"], 593, "快照必须记录完整索引（593），而不是前端展示的 100")
        self.assertEqual(snapshot["counts"]["indexed"], 593)

        last = json.loads((TMP / "last-crawl.json").read_text(encoding="utf-8"))
        self.assertEqual(last["indexedNodes"], 593)
        self.assertEqual(last["frontendNodes"], 100)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_diff_reports_added_archived_and_star_delta(self):
        prev = {"generatedAt": "t0", "nodes": {"a": {"stars": 10, "archived": False}, "b": {"stars": 5, "archived": False}}}
        curr = {"generatedAt": "t1", "nodes": {"a": {"stars": 25, "archived": False}, "b": {"stars": 5, "archived": True}, "c": {"stars": 1, "archived": False}}}
        diff = snap.diff_snapshots(prev, curr)
        self.assertEqual(diff["added"], ["c"])
        self.assertEqual(diff["archived"], ["b"])
        self.assertEqual(diff["starGainers"][0]["id"], "a")
        self.assertEqual(diff["starGainers"][0]["delta"], 15)
        self.assertFalse(diff["baseline"])

    def test_first_snapshot_is_baseline(self):
        self.assertTrue(snap.diff_snapshots(None, {"nodes": {}})["baseline"])

    def test_prune_keeps_latest(self):
        for i in range(5):
            (TMP / f"2026010{i}-00.json").write_text("{}", encoding="utf-8")
        removed = snap.prune_snapshots(TMP, 2)
        self.assertEqual(len(removed), 3)
        self.assertEqual([p.name for p in sorted(TMP.glob("*.json"))], ["20260103-00.json", "20260104-00.json"])

    def test_write_snapshot_roundtrip(self):
        mesh = build_mesh(sample_raw(), {})
        path, diff = snap.write_snapshot(mesh, TMP, keep=5)
        self.assertTrue(path.exists())
        self.assertTrue(diff["baseline"])
        self.assertEqual(snap.latest_snapshot(TMP)["counts"]["nodes"], len(mesh["nodes"]))


class ScheduleTest(unittest.TestCase):
    def test_aligns_to_hour_boundary(self):
        self.assertEqual(seconds_until_next(0, 3600), 3600)
        self.assertEqual(seconds_until_next(60, 3600), 3540)
        self.assertEqual(seconds_until_next(3599, 3600), 60)  # 至少等 1 分钟，避免紧贴上一轮

    def test_short_interval_still_has_floor(self):
        self.assertEqual(seconds_until_next(10, 120), 110)


class GitHubClientTest(unittest.TestCase):
    def test_token_loading_reads_env_without_leaking(self):
        env = TMP
        env.mkdir(parents=True, exist_ok=True)
        path = env / ".env"
        path.write_text("OTHER=1\nGITHUB_TOKEN=ghp_example\n", encoding="utf-8")
        self.assertEqual(load_token(path), "ghp_example")
        path.write_text("GITHUB_TOKEN=\n", encoding="utf-8")
        self.assertIsNone(load_token(path))
        self.assertIsNone(load_token(env / "不存在"))

    def test_retry_delay_honours_retry_after(self):
        client = GitHubClient(token=None, sleep=lambda _s: None)
        err = urllib.error.HTTPError("https://x", 403, "rate limited", {"Retry-After": "7"}, None)
        self.assertEqual(client._retry_delay(err, 0), 8.0)

    def test_retries_then_succeeds(self):
        class FakeResponse:
            def __init__(self, payload):
                self._body = json.dumps(payload).encode("utf-8")
                self.headers = {"X-RateLimit-Remaining": "42"}

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

        import io

        sleeps: list[float] = []
        client = GitHubClient(token=None, sleep=sleeps.append)
        # 真实 HTTPError 自带可读的 fp；这里也用 BytesIO 构造，避免依赖解释器对 fp=None 的宽容度
        boom = urllib.error.HTTPError("https://x", 403, "rate limited", {"Retry-After": "1"}, io.BytesIO(b'{"message":"rate limited"}'))
        with mock.patch("dsh_mesh.github.urllib.request.urlopen", side_effect=[boom, FakeResponse({"total_count": 1, "items": []})]):
            payload = client.search("topic:dsh", page=1)
        self.assertEqual(payload["total_count"], 1)
        self.assertEqual(client.stats.retries, 1)
        self.assertEqual(client.stats.requests, 2)
        self.assertEqual(client.stats.rate_limit_remaining, 42)
        self.assertEqual(sleeps, [2.0])


class SegmentTest(unittest.TestCase):
    """分段扫描：细分层级、叶子、队列预算、累积索引。"""

    def test_seed_covers_every_tag_and_star_slice(self):
        from dsh_mesh.segments import seed_segments
        from dsh_mesh.config import STAR_SLICES

        segments = seed_segments(["a", "b", "c"])
        self.assertEqual(len(segments), 3 * len(STAR_SLICES))
        keys = {s["key"] for s in segments}
        self.assertEqual(len(keys), len(segments), "段 key 不应重复")

    def test_subdivide_levels_and_leaf(self):
        from dsh_mesh.segments import subdivide

        base = {"key": "k", "topic": "dsh-plugin", "stars": "stars:200..499", "created": None, "level": 0}
        years = subdivide(base)
        self.assertGreaterEqual(len(years), 10)
        self.assertTrue(all(y["level"] == 1 and y["created"].endswith("-12-31") for y in years))

        quarters = subdivide(years[0])
        self.assertEqual(len(quarters), 4, "年应切成 4 个季度")
        months = subdivide(quarters[0])
        self.assertEqual(len(months), 3, "季度应切成 3 个月，不能漏")
        self.assertTrue(all(m["level"] == 3 for m in months))

        halves = subdivide(months[0])
        self.assertEqual(len(halves), 2, "月应切成上下两个半月")
        self.assertTrue(all(h["level"] == 4 for h in halves))

        days = subdivide(halves[0])
        self.assertEqual(len(days), 15, "半月应切成逐日，一天都不能少")
        self.assertTrue(all(d["level"] == 5 for d in days))
        self.assertEqual(subdivide(days[0]), [], "日粒度才是叶子，必须返回空以免无限细分")

    def test_segment_query_builds_valid_query(self):
        from dsh_mesh.segments import segment_query

        self.assertEqual(
            segment_query({"topic": "dsh", "stars": "stars:>=5000", "created": None}),
            "topic:dsh stars:>=5000",
        )
        self.assertEqual(
            segment_query({"topic": "dsh", "stars": "200..499", "created": "2024-01-01..2024-12-31"}),
            "topic:dsh stars:200..499 created:2024-01-01..2024-12-31",
        )

    def test_store_roundtrip_and_merge(self):
        from dsh_mesh.segments import SegmentStore

        state_path, repos_path = TMP / "segments.json", TMP / "repos.json"
        store = SegmentStore(state_path, repos_path)
        self.assertEqual(store.ensure_seeded(["dsh"]), 10)
        self.assertEqual(store.ensure_seeded(["dsh"]), 0, "重复 seed 不应新增")
        self.assertEqual(store.merge([{"id": "a/1"}, {"id": "a/2"}, {"id": "a/1"}]), 2)
        store.save()

        reopened = SegmentStore(state_path, repos_path)
        self.assertEqual(len(reopened.repos), 2)
        self.assertEqual(reopened.pending_summary()["total"], 10)

    def test_unlimited_budget_takes_all_pending(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s2.json", TMP / "r2.json")
        store.ensure_seeded(["dsh", "dsh-plugin"])
        quiet = lambda *a, **k: None
        self.assertEqual(len(store.next_batch(0, 6.0, log=quiet)), 20, "budget=0 应取全部待抓段")
        self.assertLessEqual(len(store.next_batch(40, 6.0, log=quiet)), 4, "预算 40 次请求应限制段数")

    def test_split_when_over_limit_and_truncate_at_leaf(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s3.json", TMP / "r3.json")
        quiet = lambda *a, **k: None
        parent = {"key": "topic:dsh|stars:stars:200..499|created:*", "topic": "dsh", "stars": "stars:200..499", "created": None, "level": 0}
        result = store.complete_segment(parent, [{"id": "x/1"}], 1500, log=quiet)
        self.assertTrue(result["split"])
        self.assertEqual(store.pending_summary()["pending"], result["children"])
        self.assertEqual(store.repos, {}, "被细分的段不应把截断数据并入索引")

        # 日粒度才是叶子：连一天都超上限就只能截断
        leaf = {"key": "topic:dsh|stars:stars:200..499|created:2024-01-05..2024-01-05", "topic": "dsh", "stars": "stars:200..499", "created": "2024-01-05..2024-01-05", "level": 5}
        result = store.complete_segment(leaf, [{"id": "x/2"}], 1200, log=quiet)
        self.assertFalse(result["split"])
        self.assertTrue(result.get("truncated"))
        self.assertEqual(len(store.repos), 1, "叶子段的数据仍然要并入索引")
        self.assertEqual(len(store.state["truncated"]), 1, "截断必须如实记账")


class CrawlOrderTest(unittest.TestCase):
    """抓取顺序：先检索新仓库，后更新旧仓库。"""

    def test_batch_discovers_new_before_refreshing_old(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s5.json", TMP / "r5.json")
        quiet = lambda *a, **k: None  # noqa: E731
        store.ensure_seeded(["dsh"])  # 10 段待抓
        for key in sorted(store.state["segments"])[:3]:
            segment = store.state["segments"][key]
            store.mark(segment, "done", 10, 10)
            store.state["segments"][key]["fetchedAt"] = "2020-01-01T00:00:00Z"  # 很久没更新

        batch = store.next_batch(100, 0.0, log=quiet)  # refresh_hours=0 ⇒ 已抓的也算过期
        pending = [s for s in batch if s.get("state") == "pending"]
        done = [s for s in batch if s.get("state") == "done"]
        self.assertEqual(len(pending), 7, "未抓过的段应全部排上")
        self.assertTrue(done, "过期段也要排上（更新旧仓库）")
        self.assertEqual(batch[: len(pending)], pending, "新仓库必须排在旧仓库之前")
        self.assertLess(len(done), len(pending), "还有新段时，更新阶段只能分到少量预算")

    def test_snapshot_skipped_when_index_unchanged(self):
        from dsh_mesh import snapshot as snap

        mesh = build_mesh(sample_raw(), {})
        snap_dir = TMP / "snaps"
        first, diff1 = snap.write_snapshot(mesh, snap_dir, keep=2)
        self.assertIsNotNone(first, "第一份快照应写入")
        self.assertTrue(diff1["baseline"])

        again, diff2 = snap.write_snapshot(mesh, snap_dir, keep=2)
        self.assertIsNone(again, "索引没变就不该重新生成快照")
        self.assertTrue(diff2.get("skipped"))
        self.assertEqual(len(list(snap_dir.glob("*.json"))), 1)

        changed = build_mesh(sample_raw(), {})
        changed["nodes"][0]["stars"] += 7
        third, _ = snap.write_snapshot(changed, snap_dir, keep=2)
        self.assertIsNotNone(third, "星标变化后应写入新快照")
        self.assertEqual(len(list(snap_dir.glob("*.json"))), 2)


class TruncatedRequeueTest(unittest.TestCase):
    """被截断的段必须能按更细粒度补扫，否则那些仓库永远看不到。"""

    def test_requeue_turns_truncated_month_into_pending_halves(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s6.json", TMP / "r6.json")
        quiet = lambda *a, **k: None  # noqa: E731
        month = {
            "key": "topic:dsh|stars:stars:1..9|created:2026-08-01..2026-08-31",
            "topic": "dsh",
            "stars": "stars:1..9",
            "created": "2026-08-01..2026-08-31",
            "level": 3,
        }
        store.state["segments"][month["key"]] = dict(month, state="done", fetchedAt="2026-08-31T00:00:00Z", count=1000, total=6064)
        store.state["truncated"] = [{"key": month["key"], "total": 6064, "fetched": 1000}]

        self.assertEqual(store.requeue_truncated(log=quiet), 1)
        self.assertEqual(store.pending_summary()["pending"], 2, "应重新排出两个半月段")
        self.assertEqual(store.state["truncated"], [], "重排后不应再挂在截断清单里")
        self.assertEqual(store.state["segments"][month["key"]]["state"], "split")

        self.assertEqual(store.requeue_truncated(log=quiet), 0, "重复调用不应重复排队")
        self.assertEqual(store.pending_summary()["pending"], 2)

    def test_requeue_keeps_true_leaf_truncated(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s7.json", TMP / "r7.json")
        quiet = lambda *a, **k: None  # noqa: E731
        day = {
            "key": "topic:dsh|stars:stars:1..9|created:2026-08-05..2026-08-05",
            "topic": "dsh",
            "stars": "stars:1..9",
            "created": "2026-08-05..2026-08-05",
            "level": 5,
        }
        store.state["segments"][day["key"]] = dict(day, state="done", fetchedAt="2026-08-31T00:00:00Z", count=1000, total=1200)
        store.state["truncated"] = [{"key": day["key"], "total": 1200, "fetched": 1000}]

        self.assertEqual(store.requeue_truncated(log=quiet), 0, "日粒度已是最细，只能保留截断记录")
        self.assertEqual(len(store.state["truncated"]), 1, "截断必须继续如实记账")


class ClassifyAmbiguityTest(unittest.TestCase):
    """两个歧义分类的回归：插件市场只认汇总，桌面客户端不认客户端插件。"""

    def _id(self, name: str, desc: str) -> str:
        return classify_node({"id": "x/" + name, "name": name, "description": desc, "topics": []})["id"]

    def test_market_only_when_repo_is_the_aggregator(self):
        self.assertEqual(self._id("dsh-plugin-market", "DSH 插件市场：收录、汇集各类插件"), "market")
        self.assertEqual(self._id("awesome-dsh", "A curated list of DSH plugins"), "market")
        self.assertEqual(self._id("插件市场", "汇集社区插件"), "market")
        self.assertNotEqual(self._id("dsh-market-button", "给市场加一个按钮的插件"), "market")
        self.assertNotEqual(self._id("dsh-market-pro", "在编辑器里浏览市场的插件"), "market")

    def test_desktop_excludes_client_plugins(self):
        self.assertEqual(self._id("dsh-desktop", "DSH 官方桌面客户端"), "desktop")
        self.assertNotEqual(self._id("dsh-desktop-plugin-notify", "桌面客户端的通知插件"), "desktop")
        self.assertNotEqual(self._id("dsh-plugin-desktop-theme", "给桌面客户端做的主题"), "desktop")

    def test_ascii_terms_use_word_boundaries(self):
        result = classify_node({"id": "x/build", "name": "build-tools", "description": "build and restore tooling for rapid api clients", "topics": []})
        for wrong in ("ui", "store", "api", "cli"):
            self.assertNotIn(wrong, result["hits"], wrong + " 不该被命中")


if __name__ == "__main__":
    unittest.main(verbosity=2)
