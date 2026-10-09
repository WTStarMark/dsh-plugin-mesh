#!/usr/bin/env python3
"""采集器测试（标准库 unittest，无需 pytest）。

运行：python3 backend/tests/test_collector.py
"""

from __future__ import annotations

import json
import shutil
import sys
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from dsh_mesh import snapshot as snap  # noqa: E402
from dsh_mesh import releases as rel  # noqa: E402
from dsh_mesh.build import build_mesh, limit_for_frontend, relevance_score  # noqa: E402
from dsh_mesh import build as build_mod  # noqa: E402
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

    def test_pet_skin_self_description_wins(self):
        """回归：自称皮肤系列的仓库不该被「鲸鱼娘」抢进桌宠（Small-tailqwq/dsh-deep-whale）。"""
        series = classify_node({
            "name": "dsh-deep-whale",
            "description": "Whale Girl skin series for DeepSeek Harness. 适用于 DeepSeek Harness 的，鲸鱼娘系列皮肤。",
            "topics": ["dsh", "dsh-plugin"],
        })
        self.assertEqual(series["id"], "skin")
        # 真桌宠不受影响：自述了宠物/陪伴玩法，或作者自打 pet 标签
        self.assertEqual(
            classify_node({"name": "dsh-whale-pet", "description": "鲸鱼娘桌宠：养成互动、陪聊", "topics": []})["id"], "pet"
        )
        self.assertEqual(
            classify_node({"name": "dsh-maid-whale", "description": "鲸鱼女仆主题插件", "topics": ["pet"]})["id"], "pet"
        )
        self.assertNotEqual(
            classify_node({"name": "dsh-whale-theme", "description": "深海鲸鱼娘主题", "topics": []})["id"], "pet"
        )

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
        # aliases={}：冻结的 JS 参照物不经改名别名表，这里也不能读盘，
        # 否则生产机上检测到的改名会让这条比对假红。
        py = build_mesh(sample_raw(), {}, aliases={})

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


class PrecomputeGuardTest(unittest.TestCase):
    """预计算产物守门（v0.5.0）：二进制契约没刷新就不算成功。"""

    def test_bin_looks_fresh_requires_both_files_and_fresh_mtime(self):
        import os
        import tempfile
        import time

        import collect

        with tempfile.TemporaryDirectory() as tmp:
            from pathlib import Path as _Path

            d = _Path(tmp)
            started = time.time()
            self.assertFalse(collect._bin_looks_fresh(started, d), "两个文件都不存在时应判未刷新")
            (d / "mesh-core.bin").write_bytes(b"x")
            self.assertFalse(collect._bin_looks_fresh(started, d), "只刷新一个也不算")
            (d / "mesh-core.head.bin").write_bytes(b"x")
            self.assertTrue(collect._bin_looks_fresh(started, d), "两个都刷新了才算")
            old = started - 3600
            os.utime(d / "mesh-core.bin", (old, old))
            self.assertFalse(collect._bin_looks_fresh(started, d), "契约比本轮旧 = 未刷新（就是被冻结的情形）")


class NoiseBlacklistTest(unittest.TestCase):
    """噪声黑名单：>300 个仓库且 0 星占比 >98%（主判据），或 >200 个仓库且全是 0 星（老判据）=> 剔除。"""

    def test_avatar_url_gets_size_param(self):
        """头像 URL 必须带尺寸参数：GitHub 默认给 460×460 原图（实测单张最大 282KB）。"""
        from dsh_mesh.build import AVATAR_SIZE, sized_avatar

        self.assertEqual(sized_avatar("https://avatars.githubusercontent.com/u/1?v=4"), "https://avatars.githubusercontent.com/u/1?v=4&s=" + str(AVATAR_SIZE))
        self.assertEqual(sized_avatar("https://avatars.githubusercontent.com/u/2"), "https://avatars.githubusercontent.com/u/2?s=" + str(AVATAR_SIZE))
        self.assertEqual(sized_avatar("https://avatars.githubusercontent.com/u/3?v=4&s=32"), "https://avatars.githubusercontent.com/u/3?v=4&s=32", "已带尺寸的不动")
        self.assertEqual(sized_avatar("https://example.com/a.png"), "https://example.com/a.png", "非 GitHub 头像不动")
        self.assertIsNone(sized_avatar(None))

    def test_mass_publish_owner_is_noise(self):
        """主判据：一个人发 300+ 个仓库、0 星占比超 98% —— 典型批量刷标签号。"""
        raws = [fake_repo("mass", f"dsh-mass-{i}") for i in range(295)]
        raws += [fake_repo("mass", f"dsh-mass-s{i}", stars=1) for i in range(6)]  # 6/301 = 1.99% 有星
        mesh = build_mesh(raws, {})
        self.assertNotIn("mass", {n["owner"] for n in mesh["nodes"]}, "应被剔除")
        info = mesh["meta"]["noiseBlacklist"]["mass"]
        self.assertEqual(info["repos"], 301)
        self.assertGreater(info["zeroRatio"], 0.98)
        self.assertEqual(info["reason"], "mass-publish")
        self.assertEqual(info["maxStars"], 1)

    def test_mass_publish_below_ratio_is_kept(self):
        """0 星占比没超过 98% 就不判（留 2% 余地，但不能无限制放宽）。"""
        raws = [fake_repo("border", f"dsh-b-{i}") for i in range(294)]
        raws += [fake_repo("border", f"dsh-b-s{i}", stars=1) for i in range(7)]  # 7/301 = 2.32%
        mesh = build_mesh(raws, {})
        self.assertIn("border", {n["owner"] for n in mesh["nodes"]})
        self.assertEqual(mesh["meta"]["noiseBlacklist"], {})

    def test_exactly_300_repos_is_kept(self):
        """正好 300 个不算「超过」（这些仓库还有星，老判据也不适用）。"""
        raws = [fake_repo("n300", f"dsh-n-{i}") for i in range(295)]
        raws += [fake_repo("n300", f"dsh-n-s{i}", stars=2) for i in range(5)]
        mesh = build_mesh(raws, {})
        self.assertEqual(len(mesh["nodes"]), 300)
        self.assertEqual(mesh["meta"]["noiseBlacklist"], {})

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
        ), mock.patch("collect._bin_looks_fresh", return_value=True), mock.patch("collect.time.sleep"):
            collect.run_precompute(logs.append)
        self.assertEqual(len(calls), 1, "产物已更新就不必重试")
        self.assertTrue(any("预计算完成" in line and "产物已更新" in line for line in logs), str(logs))

    def test_core_written_but_bin_stale_is_not_success(self):
        """事故回归：core 写好了、二进制契约没刷新 —— 必须判失败并重试（这就是被冻结 40 小时的情形）。"""
        import collect

        calls = []

        class Result:
            returncode = 1
            stdout = "  节点 31958 · 连线 34505 · 扇区 21"
            stderr = "Error: mesh-core.bin 不认识的节点字段：renamedFrom"

        logs: list[str] = []
        with mock.patch("collect.subprocess.run", side_effect=lambda *a, **k: (calls.append(1), Result())[1]), mock.patch(
            "collect._core_looks_fresh", return_value=True
        ), mock.patch("collect._bin_looks_fresh", return_value=False), mock.patch("collect.time.sleep"):
            collect.run_precompute(logs.append)
        self.assertEqual(len(calls), 2, "契约没刷新必须重试一次")
        self.assertTrue(any("二进制契约未刷新" in line or "预计算失败" in line for line in logs), str(logs))

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
        ), mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"), mock.patch.object(
            collect, "STATUS_FILE", TMP / "status.json"
        ), mock.patch.object(collect, "STAR_HISTORY", TMP / "star-history.json"), mock.patch.object(
            collect, "UPDATE_LOG", TMP / "update-log.json"), mock.patch.object(
        collect, "STAR_DAILY", TMP / "star-daily.json"
        ):
            code = collect.main(["--from-raw", "--frontend-limit", "100", "--quiet"])
        self.assertEqual(code, 0)
        # 状态文件也必须落在临时目录：跑测试不能污染真实的 data/cache
        status = json.loads((TMP / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["state"], "idle")
        self.assertEqual(status["lastRound"]["indexed"], 593)

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
        self.assertEqual(last["starHistory"]["points"], 1, "summary 里要报告历史点数")

        # 星标历史也必须落在临时目录：跑测试绝不能往真实的 data/cache 里写"今天"的点，
        # 否则榜单会拿一次测试用的样本当"当前星标"（曾经真的污染过一次）。
        history = snap.load_star_history(TMP / "star-history.json")
        self.assertEqual(len(history["points"]), 1)
        self.assertEqual(history["points"][0]["count"], 593, "历史点记录完整索引（不是被裁剪的 100）")

        # 更新日志同理：不能污染真实 data/cache（首次观测不计数，所以 days 是空的）
        self.assertTrue((TMP / "update-log.json").exists(), "更新日志也必须落在临时目录")
        log = snap.load_update_log(TMP / "update-log.json")
        self.assertEqual(log["days"], {}, "首次观测只记 seen，不计数")
        # seen 只跟"最近 14 天内有推送"的仓库，样本里这类只占一部分
        self.assertGreater(len(log["seen"]), 0, "应记录到样本里近期推送过的仓库")
        self.assertLessEqual(len(log["seen"]), 593)
        self.assertEqual(last["updateLog"]["days"], 0)


class StatusBudgetTest(unittest.TestCase):
    """回归：状态浮窗的「请求 N / 预算 M」必须反映【本轮】参数。

    线上表现：预算早已改成 900，浮窗却还挂着 "147 / 预算 600 · 配额余 20" ——
    那两个数是上一轮爬分段时写的，而这一轮 0 个分段到期，分段循环一次都没跑。
    """

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_round_refreshes_budget_and_clears_stale_quota(self):
        import collect

        status_path = TMP / "status.json"
        # 先摆一份"上一轮"的陈旧状态：请求 147 / 预算 600 · 配额余 20
        status_path.write_text(json.dumps({"requests": 147, "budget": 600, "quotaRemaining": 20}), encoding="utf-8")

        with mock.patch.object(collect, "MESH_JSON", TMP / "mesh.json"), mock.patch.object(
            collect, "SNAPSHOT_DIR", TMP / "snapshots"
        ), mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"), mock.patch.object(
            collect, "STATUS_FILE", status_path
        ), mock.patch.object(collect, "STAR_HISTORY", TMP / "star-history.json"), mock.patch.object(
            collect, "UPDATE_LOG", TMP / "update-log.json"
        ), mock.patch.object(collect, "STAR_DAILY", TMP / "star-daily.json"):
            code = collect.main(["--from-raw", "--budget", "900", "--releases-budget", "1200", "--quiet"])
        self.assertEqual(code, 0)

        status = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(status["budget"], 900, "浮窗要用本轮预算，不能留上一轮的 600")
        self.assertEqual(status["requests"], 0, "本轮请求数从 0 开始，不能留上一轮的 147")
        self.assertNotIn("quotaRemaining", status, "本轮还没发请求，旧的配额余数必须清掉而不是继续显示")


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


class ReadmeIndexTest(unittest.TestCase):
    """README 索引（0.4.6）：支撑"搜索仓库 README 内容"。"""

    def _tmp(self):
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name) / "readmes.json"

    def test_needs_prioritizes_missing_then_stale(self):
        from dsh_mesh.readmes import ReadmeIndex

        idx = ReadmeIndex(self._tmp())
        repos = [{"id": "a/low", "stars": 1}, {"id": "b/high", "stars": 900}, {"id": "c/mid", "stars": 50}]
        picked = idx.needs(repos, 2)
        self.assertEqual([r["id"] for r in picked], ["b/high", "c/mid"], "没抓过的按星标降序优先")

        idx.put("b/high", "内容", fetched_at="2020-01-01T00:00:00Z")  # 很旧 → 属于过期队列
        idx.put("c/mid", "内容", fetched_at="2999-01-01T00:00:00Z")  # 很新
        again = idx.needs(repos, 2)
        self.assertIn("b/high", [r["id"] for r in again], "过期的应被重新排队")
        self.assertNotIn("c/mid", [r["id"] for r in again], "刚抓过的不该重复抓")

    def test_normalize_truncates_and_strips_control_chars(self):
        from dsh_mesh.readmes import ReadmeIndex

        idx = ReadmeIndex(self._tmp(), max_chars=100)
        text = idx.normalize("# 标题\n\n\n\n正文\x00\x07   多个空格    合并" + "x" * 500)
        self.assertLessEqual(len(text), 100)
        self.assertNotIn("\x00", text)
        self.assertNotIn("\x07", text)
        self.assertNotIn("    ", text, "连续空白应被压掉")
        self.assertEqual(idx.normalize(None), "")
        self.assertEqual(idx.normalize(""), "")

    def test_fetch_batch_records_empty_readme_to_avoid_retry(self):
        from dsh_mesh.readmes import ReadmeIndex, fetch_batch

        class FakeClient:
            def __init__(self):
                self.asked = []

            def readme(self, rid):
                self.asked.append(rid)
                return None if rid.startswith("no/") else "# hi"

        idx = ReadmeIndex(self._tmp())
        client = FakeClient()
        repos = [{"id": "has/readme", "stars": 2}, {"id": "no/readme", "stars": 1}]
        out = fetch_batch(client, idx, repos, budget=10, log=lambda *_: None)
        self.assertEqual(sorted(client.asked), ["has/readme", "no/readme"])
        self.assertEqual((out["fetched"], out["empty"]), (1, 1))
        self.assertEqual(idx.docs["no/readme"]["t"], "", "没有 README 也要记账，避免每轮重复试探")
        self.assertEqual(idx.needs(repos, 10), [], "抓过之后（含空）本轮不该再排")

    def test_status_file_merges_and_reports_next_run(self):
        """状态文件：合并式写入（每次只更新自己那几个字段）+ 下一轮时间对齐周期边界。"""
        import json
        import time

        from dsh_mesh.status import next_run_at, read_status, write_status

        path = self._tmp().with_suffix(".status.json")
        write_status(path, state="crawling", roundSeconds=3600, segments={"total": 313, "done": 10})
        write_status(path, segments={"total": 313, "done": 25}, fetched=99)
        data = read_status(path)
        self.assertEqual(data["state"], "crawling", "没提到的字段必须保留")
        self.assertEqual(data["roundSeconds"], 3600)
        self.assertEqual(data["segments"]["done"], 25, "再次写入应覆盖同名字段")
        self.assertEqual(data["fetched"], 99)
        self.assertIn("updatedAt", data)

        write_status(path, phase=None)
        self.assertNotIn("phase", read_status(path), "传 None 表示删除该字段")

        now = 1_700_000_000.0  # 固定时刻，避免测试抖动
        eta = next_run_at(now, 3600)
        self.assertRegex(eta, r"^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$", "应落在整点边界：" + eta)
        self.assertGreaterEqual((__import__("datetime").datetime.strptime(eta, "%Y-%m-%dT%H:%M:%SZ") - __import__("datetime").datetime.utcfromtimestamp(now)).total_seconds(), 60.0)

    def test_status_write_is_atomic_and_tolerates_missing_file(self):
        from dsh_mesh.status import read_status, write_status

        path = self._tmp().with_suffix(".status2.json")
        self.assertEqual(read_status(path), {}, "文件不存在时读成空字典，不抛错")
        write_status(path, state="idle")
        self.assertTrue(path.exists())
        self.assertFalse(path.with_name(path.name + ".tmp").exists(), "临时文件必须已被原子替换掉")

    def test_collector_progress_reporting_respects_dry_run(self):
        """采集器的进度上报入口：真跑时写、dry-run 绝不写，且字段来自当前进度。"""
        import types

        import collect  # backend/collect.py（sys.path 已含 backend）

        class FakeStore:
            def coverage(self):
                return {"segments": {"total": 313, "done": 282, "pending": 0}, "repos": 19008}

        class FakeClient:
            stats = types.SimpleNamespace(requests=750, rate_limit_remaining=4213)

        calls = []

        def fake_write(path, **kw):  # 包装层必须把 STATUS_FILE 传下来，否则测试无法隔离路径
            calls.append({"path": path, **kw})

        original = collect.write_status
        collect.write_status = fake_write
        try:
            args = types.SimpleNamespace(dry_run=True, budget=600)
            collect._report_progress(FakeStore(), 339, 7, FakeClient(), args)
            self.assertEqual(calls, [], "dry-run 不应写状态文件")

            args.dry_run = False
            collect._report_progress(FakeStore(), 339, 7, FakeClient(), args, done=282, total=313)
        finally:
            collect.write_status = original

        self.assertEqual(len(calls), 1, "正常跑应写一次")
        payload = calls[0]
        self.assertEqual(payload["path"], collect.STATUS_FILE, "应写入 STATUS_FILE（测试可 mock 它做隔离）")
        self.assertEqual(payload["phase"], "segments")
        self.assertEqual(payload["segments"]["done"], 282)
        self.assertEqual(payload["indexed"], 19008)
        self.assertEqual(payload["fetched"], 339)
        self.assertEqual(payload["requests"], 750)
        self.assertEqual(payload["quotaRemaining"], 4213)

    def test_readme_save_and_reload_roundtrip(self):
        from dsh_mesh.readmes import ReadmeIndex

        path = self._tmp()
        idx = ReadmeIndex(path)
        idx.put("a/b", "# 标题\n正文")
        idx.save()
        again = ReadmeIndex(path)
        self.assertEqual(again.stats()["count"], 1)
        self.assertIn("正文", again.docs["a/b"]["t"])
        self.assertTrue(path.exists())

    def test_digest_drops_badges_links_html_and_urls(self):
        """只存"检索摘要"：徽章/图片/URL/HTML 都去掉——既省体积，也避免随机串误命中。"""
        from dsh_mesh.readmes import ReadmeIndex

        idx = ReadmeIndex(self._tmp(), max_chars=2000)
        raw = (
            "<h1 align=\"center\">项目名</h1>\n"
            "![build](https://img.shields.io/badge/x-1?style=flat)\n"
            "## 安装\n"
            "看 [文档](https://example.com/very/long/path?a=1) 或访问 https://example.com/other\n"
            "\u0060\u0060\u0060bash\nnpm i foo\n\u0060\u0060\u0060\n"
        )
        out = idx.normalize(raw)
        self.assertNotIn("img.shields.io", out)
        self.assertNotIn("https://", out)
        self.assertNotIn("<h1", out)
        self.assertIn("文档", out, "链接文字要保留")
        self.assertIn("安装", out)
        self.assertIn("npm i foo", out, "代码块里的安装命令要保留")

    def test_gzip_storage_roundtrip_and_size(self):
        """落盘走 gzip：内容能原样读回，且明显小于原 JSON。"""
        import gzip
        import json

        from dsh_mesh.readmes import ReadmeIndex

        path = self._tmp().with_suffix(".json.gz")
        idx = ReadmeIndex(path, max_chars=2000)
        for i in range(20):
            idx.put("u/repo%d" % i, ("# 标题\n" + "正文内容 " * 200))
        idx.save()
        self.assertTrue(path.exists())
        self.assertEqual(path.read_bytes()[:2], b"\x1f\x8b", "应当是 gzip 魔数")
        plain = len(json.dumps({"docs": idx.docs}, ensure_ascii=False).encode("utf-8"))
        self.assertLess(len(gzip.decompress(path.read_bytes())), plain + 1)
        again = ReadmeIndex(path)
        self.assertEqual(again.stats()["count"], 20)
        self.assertEqual(again.docs["u/repo0"]["t"], idx.docs["u/repo0"]["t"])

    def test_gzip_reader_also_accepts_plain_json(self):
        """迁移期兼容：老的 readmes.json 也要能读。"""
        import json

        from dsh_mesh.readmes import ReadmeIndex

        path = self._tmp()
        path.write_text(json.dumps({"count": 1, "docs": {"a/b": {"t": "老格式", "f": "2026-01-01T00:00:00Z"}}}), encoding="utf-8")
        idx = ReadmeIndex(path)
        self.assertEqual(idx.docs["a/b"]["t"], "老格式")

    def test_readme_fetch_failure_does_not_break_collector(self):
        """fetch_batch 里 client.readme 抛异常（网络抖动）时不该把整轮采集带崩。"""
        from dsh_mesh.readmes import ReadmeIndex, fetch_batch

        class BoomClient:
            def readme(self, rid):
                raise RuntimeError("network down")

        idx = ReadmeIndex(self._tmp())
        with self.assertRaises(RuntimeError):
            fetch_batch(BoomClient(), idx, [{"id": "a/b", "stars": 1}], budget=1, log=lambda *_: None)


class RenameTest(unittest.TestCase):
    """改名去重（0.4.4）：full_name 会变、数字 id 不变，索引与构图都要按数字 id 认人。"""

    def test_pick_repo_keeps_github_numeric_id(self):
        from dsh_mesh.build import pick_repo

        record = pick_repo(
            {
                "full_name": "u/name",
                "id": 123456,
                "name": "name",
                "owner": {"login": "u", "type": "User"},
                "stargazers_count": 1,
                "topics": ["dsh-plugin"],
            }
        )
        self.assertEqual(record["id"], "u/name")
        self.assertEqual(record["githubId"], 123456)

    def test_store_merge_treats_rename_as_same_repo(self):
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            store = SegmentStore(Path(tmp) / "segments.json", Path(tmp) / "repos.json")
            before = {"id": "u/old-name", "githubId": 42, "owner": "u", "name": "old-name", "topics": ["dsh-plugin"]}
            after = {"id": "u/new-name", "githubId": 42, "owner": "u", "name": "new-name", "topics": ["dsh-plugin"]}
            self.assertEqual(store.merge([before]), 1)
            self.assertEqual(store.merge([after]), 0, "改名不该被算成新仓库")
            self.assertNotIn("u/old-name", store.repos, "旧名字记录必须挪走，不能新旧并存")
            self.assertIn("u/new-name", store.repos)
            self.assertEqual(store.repos["u/new-name"]["renamedFrom"], ["u/old-name"])

    def test_store_merge_without_github_id_falls_back_to_name(self):
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            store = SegmentStore(Path(tmp) / "segments.json", Path(tmp) / "repos.json")
            rec = {"id": "u/x", "owner": "u", "name": "x", "topics": ["dsh-plugin"]}
            self.assertEqual(store.merge([rec]), 1)
            self.assertEqual(store.merge([rec]), 0)

    def test_store_aliases_move_old_key_on_load(self):
        """别名表（旧名→现名）在加载时就要把旧名键挪走：GitHub 搜索索引延迟时靠它兜底。"""
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "segments.json"
            repos = Path(tmp) / "repos.json"
            repos.write_text(
                json.dumps({"count": 1, "repos": {"u/old": {"id": "u/old", "owner": "u", "name": "old", "updatedAt": "2026-01-01T00:00:00Z"}}}),
                encoding="utf-8",
            )
            (Path(tmp) / "aliases.json").write_text(json.dumps({"aliases": {"u/old": "u/new"}}), encoding="utf-8")
            store = SegmentStore(state, repos)
            self.assertNotIn("u/old", store.repos, "加载时旧名键应被归一")
            self.assertIn("u/new", store.repos)
            self.assertEqual(store.repos["u/new"]["renamedFrom"], ["u/old"])

    def test_store_aliases_canonicalize_incoming_records(self):
        """扫描若拿到旧名（搜索索引延迟），merge 时要归一到现名，而不是再插一条。"""
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "aliases.json").write_text(json.dumps({"aliases": {"u/old": "u/new"}}), encoding="utf-8")
            store = SegmentStore(Path(tmp) / "segments.json", Path(tmp) / "repos.json")
            added = store.merge([{"id": "u/old", "githubId": 5, "owner": "u", "name": "old", "topics": ["dsh-plugin"]}])
            self.assertEqual(added, 1)
            self.assertNotIn("u/old", store.repos)
            self.assertIn("u/new", store.repos)
            self.assertEqual(store.repos["u/new"]["githubId"], 5)
            self.assertEqual(store.repos["u/new"]["renamedFrom"], ["u/old"])

    def test_aliases_follow_chains(self):
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "aliases.json").write_text(
                json.dumps({"aliases": {"a/one": "b/two", "b/two": "c/three"}}), encoding="utf-8"
            )
            store = SegmentStore(Path(tmp) / "segments.json", Path(tmp) / "repos.json")
            self.assertEqual(store.canonical("a/one"), "c/three", "多级别名要跟到底")

    def test_build_dedupes_by_github_id_and_adopts_newer_name(self):
        def rec(full_name, name, updated, gid=7):
            return {
                "id": full_name,
                "githubId": gid,
                "name": name,
                "owner": "u",
                "ownerType": "User",
                "htmlUrl": "https://github.com/" + full_name,
                "stars": 3,
                "forks": 0,
                "openIssues": 0,
                "createdAt": "2026-01-01T00:00:00Z",
                "pushedAt": updated,
                "updatedAt": updated,
                "language": "TS",
                "license": None,
                "archived": False,
                "fork": False,
                "description": "dsh 插件",
                "homepage": None,
                "sizeKb": 1,
                "topics": ["dsh-plugin"],
            }

        mesh = build_mesh(
            [rec("u/old-name", "old-name", "2026-01-01T00:00:00Z"), rec("u/new-name", "new-name", "2026-02-02T00:00:00Z")],
            {},
        )
        self.assertEqual([n["id"] for n in mesh["nodes"]], ["u/new-name"], "同一 githubId 只留一个节点，用更新的名字")


class SegmentTest(unittest.TestCase):
    """分段扫描：细分层级、叶子、队列预算、累积索引。"""

    def test_seed_covers_every_tag_and_star_slice(self):
        from dsh_mesh.segments import NAME_SOURCES, seed_segments
        from dsh_mesh.config import STAR_SLICES

        segments = seed_segments(["a", "b", "c"])
        # 白名单标签 + 名字收录源（name:dsh-）各自 × 星标区间
        self.assertEqual(len(segments), (3 + len(NAME_SOURCES)) * len(STAR_SLICES))
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
        from dsh_mesh.segments import NAME_SOURCES as _NS
        from dsh_mesh.config import STAR_SLICES as _SS

        self.assertEqual(store.ensure_seeded(["dsh"]), (1 + len(_NS)) * len(_SS))
        self.assertEqual(store.ensure_seeded(["dsh"]), 0, "重复 seed 不应新增")
        self.assertEqual(store.merge([{"id": "a/1"}, {"id": "a/2"}, {"id": "a/1"}]), 2)
        store.save()

        reopened = SegmentStore(state_path, repos_path)
        self.assertEqual(len(reopened.repos), 2)
        self.assertEqual(reopened.pending_summary()["total"], (1 + len(_NS)) * len(_SS))

    def test_unlimited_budget_takes_all_pending(self):
        from dsh_mesh.segments import SegmentStore

        store = SegmentStore(TMP / "s2.json", TMP / "r2.json")
        store.ensure_seeded(["dsh", "dsh-plugin"])
        quiet = lambda *a, **k: None
        from dsh_mesh.segments import NAME_SOURCES as _NS2
        from dsh_mesh.config import STAR_SLICES as _SS2

        self.assertEqual(
            len(store.next_batch(0, 6.0, log=quiet)),
            (2 + len(_NS2)) * len(_SS2),
            "budget=0 应取全部待抓段",
        )
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




class StarHistoryTest(unittest.TestCase):
    """星标历史环：前端「周 star 热榜」的唯一真源（每天一个点，同一天覆盖）。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "star-history.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _mesh(at: str, stars: dict) -> dict:
        return {"meta": {"generatedAt": at}, "nodes": [{"id": k, "stars": v} for k, v in stars.items()]}

    def test_missing_or_broken_file_is_an_empty_ring(self):
        self.assertEqual(snap.load_star_history(self.path)["points"], [])
        self.path.write_text("{ 这不是 json", encoding="utf-8")
        self.assertEqual(snap.load_star_history(self.path)["points"], [])
        self.path.write_text('{"points": "坏了"}', encoding="utf-8")
        self.assertEqual(snap.load_star_history(self.path)["points"], [])

    def test_same_day_is_overwritten_not_appended(self):
        # "同一天"按每日界限算（默认北京时间 00:00）：下面两个时刻都是北京 10-01（01:00Z=09:00、12:00Z=20:00）
        snap.update_star_history(self._mesh("2026-10-01T01:00:00Z", {"a": 1}), self.path)
        payload = snap.update_star_history(self._mesh("2026-10-01T12:00:00Z", {"a": 9, "b": 2}), self.path)
        self.assertEqual(len(payload["points"]), 1, "同一个当地日只留一个点")
        self.assertEqual(payload["points"][0]["at"], "2026-10-01T12:00:00Z", "留当天的最后一次观测")
        self.assertEqual(payload["points"][0]["stars"], {"a": 9, "b": 2})

    def test_local_midnight_starts_a_new_point(self):
        # UTC 10-01 15:59 = 北京 23:59（还是 10-01）；UTC 16:00 = 北京 10-02 00:00（换天）
        snap.update_star_history(self._mesh("2026-10-01T15:59:00Z", {"a": 1}), self.path)
        payload = snap.update_star_history(self._mesh("2026-10-01T16:00:00Z", {"a": 2}), self.path)
        self.assertEqual(len(payload["points"]), 2, "跨过北京 00:00 应新增一个点，而不是覆盖")
        self.assertEqual([p["day"] for p in payload["points"]], ["2026-10-01", "2026-10-02"])

    def test_keeps_only_recent_days_and_sorts_ascending(self):
        for day in range(1, 13):
            snap.update_star_history(self._mesh(f"2026-09-{day:02d}T10:00:00Z", {"a": day}), self.path, keep=5)
        payload = snap.load_star_history(self.path)
        self.assertEqual(len(payload["points"]), 5, "只留最近 keep 天")
        ats = [p["at"] for p in payload["points"]]
        self.assertEqual(ats, sorted(ats), "点必须按时间升序")
        self.assertEqual(ats[-1], "2026-09-12T10:00:00Z")
        self.assertEqual(ats[0], "2026-09-08T10:00:00Z")

    def test_written_payload_is_self_describing(self):
        payload = snap.update_star_history(self._mesh("2026-10-03T11:00:25Z", {"x/y": 42}), self.path)
        self.assertEqual(payload["unit"], "stars/day")
        self.assertEqual(payload["keepDays"], snap.STAR_HISTORY_KEEP)
        self.assertIn("周 star 热榜", payload["note"])
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["points"][0]["count"], 1)
        self.assertEqual(on_disk["points"][0]["day"], "2026-10-03")


class UpdateLogTest(unittest.TestCase):
    """更新日志：前端「周更新热榜」按它排序（次数 = 1 + 采样到的推进次数）。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "update-log.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _mesh(at: str, pushes: dict) -> dict:
        return {"meta": {"generatedAt": at}, "nodes": [{"id": k, "pushedAt": v} for k, v in pushes.items()]}

    def test_missing_or_broken_file_is_an_empty_log(self):
        self.assertEqual(snap.load_update_log(self.path)["days"], {})
        self.path.write_text("这不是 json", encoding="utf-8")
        self.assertEqual(snap.load_update_log(self.path)["seen"], {})
        self.path.write_text('{"days": 5}', encoding="utf-8")
        self.assertEqual(snap.load_update_log(self.path)["days"], {})

    def test_first_sight_does_not_count_but_is_remembered(self):
        payload = snap.update_update_log(self._mesh("2026-10-06T10:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        self.assertEqual(payload["days"], {}, "首次见到只记 seen：那是它本来就有的推送，不是我们又看到一次更新")
        self.assertEqual(payload["seen"]["a/x"], "2026-10-06T09:00:00Z")
        self.assertEqual(payload["lastRound"]["counted"], 0)

    def test_only_advances_count_and_they_accumulate_per_day(self):
        snap.update_update_log(self._mesh("2026-10-06T10:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        same = snap.update_update_log(self._mesh("2026-10-06T11:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        self.assertEqual(same["days"], {}, "pushedAt 没前进就不计数")
        one = snap.update_update_log(self._mesh("2026-10-06T12:00:00Z", {"a/x": "2026-10-06T11:30:00Z"}), self.path)
        self.assertEqual(one["days"]["2026-10-06"]["a/x"], 1)
        self.assertEqual(one["lastRound"]["counted"], 1)
        two = snap.update_update_log(self._mesh("2026-10-06T13:00:00Z", {"a/x": "2026-10-06T12:30:00Z"}), self.path)
        self.assertEqual(two["days"]["2026-10-06"]["a/x"], 2, "同一天要累计")
        self.assertEqual(two["seen"]["a/x"], "2026-10-06T12:30:00Z")

    def test_prunes_old_days(self):
        for i in range(1, 12):
            snap.update_update_log(
                self._mesh(f"2026-09-{i:02d}T10:00:00Z", {"a/x": f"2026-09-{i:02d}T09:00:00Z"}), self.path, keep=3
            )
        payload = snap.load_update_log(self.path)
        self.assertEqual(sorted(payload["days"]), ["2026-09-09", "2026-09-10", "2026-09-11"], "只留最近 keep 天")

    def test_stale_repos_are_dropped_from_seen(self):
        snap.update_update_log(self._mesh("2026-10-06T10:00:00Z", {"old/a": "2026-09-01T00:00:00Z"}), self.path)
        self.assertEqual(snap.load_update_log(self.path)["seen"], {}, "太久没推送的仓库不再跟踪，文件不会无限长")

    def test_sampled_days_record_observation_without_counts(self):
        """没推进也要记下"这一天观测过"：界面靠它区分「0 次」和「没数据」。"""
        payload = snap.update_update_log(self._mesh("2026-10-06T10:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        self.assertEqual(payload["days"], {})
        self.assertEqual(payload["sampledDays"], ["2026-10-06"])
        snap.update_update_log(self._mesh("2026-10-06T11:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        self.assertEqual(snap.load_update_log(self.path)["sampledDays"], ["2026-10-06"], "同一天只记一次")

    def test_sampled_days_are_pruned_with_days(self):
        for i in range(1, 12):
            snap.update_update_log(self._mesh(f"2026-09-{i:02d}T10:00:00Z", {"a/x": f"2026-09-{i:02d}T09:00:00Z"}), self.path, keep=3)
        payload = snap.load_update_log(self.path)
        self.assertEqual(payload["sampledDays"], ["2026-09-09", "2026-09-10", "2026-09-11"])

    def test_payload_is_self_describing(self):
        payload = snap.update_update_log(self._mesh("2026-10-06T10:00:00Z", {"a/x": "2026-10-06T09:00:00Z"}), self.path)
        self.assertEqual(payload["unit"], "pushes/day")
        self.assertIn("周更新热榜", payload["note"])
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["keepDays"], snap.UPDATE_LOG_KEEP)


class ReleasesTest(unittest.TestCase):
    """版本采集策略：限量 + 排优先级（配额按认证身份算一个桶，堆令牌不扩容）。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "releases.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _iso(days_ago: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - days_ago * 86400))

    @staticmethod
    def _day(days_ago: float) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(time.time() - days_ago * 86400))

    def test_slim_keeps_four_fields_and_drops_drafts(self):
        payload = [
            {"tag_name": "v1.2.0", "name": "1.2.0", "published_at": "2026-10-01T00:00:00Z", "prerelease": False, "draft": False, "body": "x" * 5000, "assets": [1, 2]},
            {"tag_name": "v1.3.0-rc.1", "name": "rc", "published_at": "2026-10-02T00:00:00Z", "prerelease": True, "draft": False},
            {"tag_name": "draft", "name": "草稿", "published_at": "2026-10-03T00:00:00Z", "draft": True},
        ]
        out = rel.slim_releases(payload)
        self.assertEqual([r["tag"] for r in out], ["v1.2.0", "v1.3.0-rc.1"], "草稿必须丢掉")
        self.assertEqual(out[0], {"tag": "v1.2.0", "name": "1.2.0", "at": "2026-10-01", "pre": False})
        self.assertTrue(out[1]["pre"])
        self.assertLess(len(json.dumps(out, ensure_ascii=False)), 400, "精简后要小到能塞进几 MB 的缓存")

    def test_load_save_roundtrip_is_atomic_and_tolerates_garbage(self):
        self.assertEqual(rel.load_releases(self.path)["repos"], {})
        self.path.write_text("不是 json", encoding="utf-8")
        self.assertEqual(rel.load_releases(self.path)["repos"], {})
        payload = rel.merge(rel.load_releases(self.path), "a/b", [{"tag": "v1", "name": "", "at": "2026-10-01", "pre": False}])
        rel.save_releases(payload, self.path)
        self.assertEqual(rel.load_releases(self.path)["repos"]["a/b"]["releases"][0]["tag"], "v1")
        self.assertFalse(self.path.with_name(self.path.name + ".tmp").exists(), "临时文件必须被 replace 掉")

    def test_candidates_prioritize_recent_push_then_stars(self):
        now = time.time()
        nodes = [
            {"id": "recent/low", "stars": 1, "pushedAt": self._iso(1), "archived": False},
            {"id": "recent/high", "stars": 900, "pushedAt": self._iso(2), "archived": False},
            {"id": "stale/high", "stars": 5000, "pushedAt": self._iso(40), "archived": False},
            {"id": "gone/archived", "stars": 9000, "pushedAt": self._iso(1), "archived": True},
        ]
        picked = rel.pick_candidates({"repos": {}}, nodes, limit=10, now_ts=now)
        self.assertEqual(picked, ["recent/high", "recent/low", "stale/high"], "近 7 天推过的优先、其中星标高的更前；归档跳过")

    def test_candidates_skip_fresh_entries_and_respect_limit(self):
        now = time.time()
        payload = {"repos": {"a/fresh": {"at": self._iso(0.5), "releases": []}}}
        nodes = [
            {"id": "a/fresh", "stars": 9999, "pushedAt": self._iso(1), "archived": False},
            {"id": "a/old", "stars": 10, "pushedAt": self._iso(1), "archived": False},
        ]
        self.assertEqual(rel.pick_candidates(payload, nodes, limit=10, now_ts=now), ["a/old"], "刚抓过的不该重复抓")
        payload2 = {"repos": {"a/old": {"at": self._iso(9), "releases": []}, "a/fresh": {"at": self._iso(0.5), "releases": []}}}
        picked2 = rel.pick_candidates(payload2, nodes, limit=10, now_ts=now)
        self.assertIn("a/old", picked2, "抓过 9 天了要重抓")
        self.assertNotIn("a/fresh", picked2, "才抓过半天的不该重抓")
        self.assertEqual(len(rel.pick_candidates({"repos": {}}, nodes * 5, limit=3, now_ts=now)), 3, "预算就是上限")

    def test_candidates_refresh_after_push_since_last_fetch(self):
        """回归（线上实例）：抓过一次之后又推过的仓库，不能被 REFRESH_DAYS 压住。

        xling001/dsh-reading-companion 在 10-08 发了 4 个版本，缓存却停在 10-07：
        旧口径只看"缓存多少天"，于是周更新热榜少算它一天的版本。
        """
        now = time.time()
        nodes = [{"id": "active/releaser", "stars": 2, "pushedAt": self._iso(0.2), "archived": False}]
        payload = {
            "repos": {
                "active/releaser": {
                    "at": self._iso(1.5),
                    "releases": [
                        {"tag": "v2", "name": "", "at": self._day(1), "pre": False},
                        {"tag": "v1", "name": "", "at": self._day(2), "pre": False},
                    ],
                }
            }
        }
        self.assertEqual(
            rel.pick_candidates(payload, nodes, limit=10, now_ts=now),
            ["active/releaser"],
            "抓过之后又推过的要立刻重抓，哪怕缓存还很新",
        )

    def test_candidates_refresh_active_releaser_after_active_hours(self):
        """近 7 天发过版的仓库最多压 ACTIVE_REFRESH_HOURS，不再压满 REFRESH_DAYS。"""
        now = time.time()
        releases = [{"tag": "v1", "name": "", "at": self._day(1), "pre": False}]
        nodes = [{"id": "a/active", "stars": 10, "pushedAt": self._iso(2), "archived": False}]
        stale = {"repos": {"a/active": {"at": self._iso(8 / 24.0), "releases": releases}}}
        self.assertEqual(rel.pick_candidates(stale, nodes, limit=10, now_ts=now), ["a/active"], "活跃发版仓库超过 6 小时要重抓")
        fresh = {"repos": {"a/active": {"at": self._iso(1 / 24.0), "releases": releases}}}
        self.assertEqual(rel.pick_candidates(fresh, nodes, limit=10, now_ts=now), [], "才抓过 1 小时的不重复抓")

    def test_candidates_keep_a_discovery_share(self):
        """预算不能全给活跃仓库：从没抓过的要留一份，否则新仓库永远发现不了。"""
        now = time.time()
        nodes = [{"id": "hot/" + str(i), "stars": 100 - i, "pushedAt": self._iso(0.1), "archived": False} for i in range(10)]
        nodes += [{"id": "new/" + str(i), "stars": i, "pushedAt": self._iso(1), "archived": False} for i in range(6)]
        payload = {"repos": {}}
        for i in range(10):
            payload["repos"]["hot/" + str(i)] = {"at": self._iso(1.0), "releases": [{"tag": "v1", "name": "", "at": self._day(1), "pre": False}]}
        picked = rel.pick_candidates(payload, nodes, limit=8, now_ts=now)
        self.assertEqual(len(picked), 8, "预算就是上限")
        self.assertTrue(any(p.startswith("new/") for p in picked), "必须给从没抓过的留名额：" + str(picked))
        self.assertTrue(any(p.startswith("hot/") for p in picked), "活跃仓库也不能被挤掉")

    def test_candidates_order_by_window_releases(self):
        """同一档内按"缓存里近 7 天的版本数"排 —— 周榜就是照这个指标排的，星标不能压过它。"""
        now = time.time()
        nodes = [
            {"id": "few/releases", "stars": 9999, "pushedAt": self._iso(0.1), "archived": False},
            {"id": "many/releases", "stars": 1, "pushedAt": self._iso(0.1), "archived": False},
        ]
        many = [{"tag": "v" + str(i), "name": "", "at": self._day(1), "pre": False} for i in range(6)]
        few = [{"tag": "v1", "name": "", "at": self._day(1), "pre": False}]
        payload = {"repos": {
            "few/releases": {"at": self._iso(1), "releases": few},
            "many/releases": {"at": self._iso(1), "releases": many},
        }}
        self.assertEqual(
            rel.pick_candidates(payload, nodes, limit=10, now_ts=now),
            ["many/releases", "few/releases"],
            "窗口内版本多的先抓",
        )

    def test_put_and_stats(self):
        payload = rel.load_releases(self.path)
        rel.put(payload, "a/b", [{"tag": "v1", "name": "", "at": "2026-10-01", "pre": False}])
        rel.put(payload, "a/c", [])
        self.assertEqual(rel.stats(payload), {"repos": 2, "withReleases": 1, "versions": 1})


class InclusionAndDirectionTest(unittest.TestCase):
    """v0.5.0 两条回归防线：无信号空壳不收录、共鸣边保留"基座 → 插件"方向。"""

    def test_name_only_stub_is_not_indexed_and_is_counted(self):
        stub = fake_repo("alice", "dsh-stub", stars=3, topics=())
        stub["description"] = ""  # 只有名字命中 dsh：既没有描述也没有主题标签
        real = fake_repo("bob", "dsh-skin", stars=10)
        mesh = build_mesh([stub, real], {})
        ids = [n["id"] for n in mesh["nodes"]]
        self.assertNotIn("alice/dsh-stub", ids, "只有名字、没有描述也没有主题的空壳不该进索引")
        self.assertIn("bob/dsh-skin", ids, "有信号的照旧收录")
        self.assertEqual(mesh["meta"]["noSignalSkipped"], 1, "剔除数量要如实记账")

    def test_resonance_edge_keeps_direction_even_when_plugin_sorts_first(self):
        eco_path = TMP / "ecosystem-direction.json"
        TMP.mkdir(parents=True, exist_ok=True)
        eco_path.write_text(
            json.dumps({"bases": [{"id": "zzz/base", "label": "测试基座", "enabled": True, "verified": [{"id": "aaa/plugin"}]}]}),
            encoding="utf-8",
        )
        base = fake_repo("zzz", "base", stars=100)
        plugin = fake_repo("aaa", "plugin", stars=5)
        with mock.patch.object(build_mod, "ECOSYSTEM_JSON", eco_path):
            mesh = build_mesh([base, plugin], {})
        reso = [(e["source"], e["target"]) for e in mesh["edges"] if e["type"] == "resonance"]
        self.assertEqual(reso, [("zzz/base", "aaa/plugin")], "共鸣边必须保持 基座 → 插件（插件字母序在前也不能翻转）")

    def test_undirected_edges_are_still_canonicalized(self):
        raws = [fake_repo("alice", "b-repo", stars=1), fake_repo("alice", "a-repo", stars=2)]
        mesh = build_mesh(raws, {})
        owner = [(e["source"], e["target"]) for e in mesh["edges"] if e["type"] == "owner"]
        self.assertEqual(owner, [("alice/a-repo", "alice/b-repo")], "对等关系仍按字母序归一化（去重靠它）")


class StarDailyTest(unittest.TestCase):
    """逐日星标台账的四条硬规矩：首轮只落基线 / 断档转 spans / 缺席保留基线 / 首见不计数，掉星如实记负。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "star-daily.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _mesh(day: str, stars: dict) -> dict:
        return {"meta": {"generatedAt": day + "T00:30:00Z"}, "nodes": [{"id": k, "stars": v} for k, v in stars.items()]}

    def test_first_sighting_only_records_baseline(self):
        out = snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        self.assertEqual(out["days"], {}, "首次见到不该计数（它本来就有这么多星）")
        self.assertEqual(out["seen"]["a/b"], 100, "但要记基线")
        self.assertEqual(out["lastRound"]["counted"], 0)

    def test_deltas_accumulate_into_the_same_day(self):
        snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 130}), self.path)
        out = snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 145, "c/d": 5}), self.path)
        self.assertEqual(out["days"]["2026-10-07"]["a/b"], 45, "同一天的多轮要累加")
        self.assertEqual(out["lastRound"]["counted"], 1, "c/d 是首次见到，不计数")
        self.assertEqual(out["lastRound"]["gained"], 15)

    def test_negative_delta_is_recorded_honestly(self):
        snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        out = snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 90}), self.path)
        self.assertEqual(out["days"]["2026-10-07"]["a/b"], -10, "掉星要如实记负，不能当 0")
        self.assertEqual(out["lastRound"]["gained"], 0, "净涨不含掉星")

    def test_day_rollover_and_keep_window(self):
        for i in range(9):
            day = "2026-10-%02d" % (1 + i)
            self._round(day, 100 + i * 10)
            self._round(day, 100 + i * 10 + 5)
        out = snap.load_star_daily(self.path)
        self.assertEqual(len(out["days"]), 8, "只留最近 8 天（含当天）")
        self.assertNotIn("2026-10-01", out["days"], "最老的一天要被滚掉")
        # 当天桶 = 跨天那一步的变化（+5）+ 当天再涨的（+5）= 10：累加的是"观测到的变化"，不摊派
        self.assertEqual(out["days"]["2026-10-09"]["a/b"], 10)
        self.assertEqual(out["sampledDays"], ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"])

    def _round(self, day: str, stars: int) -> None:
        snap.update_star_daily(self._mesh(day, {"a/b": stars}), self.path)

    def test_missing_repo_keeps_baseline_within_grace(self):
        """部分轮次（分段没跑完 / 配额不够）不许静默吞掉变化：缺席仓库在宽限期内保留基线。

        旧行为是"每轮按当前节点表整表重建"——缺席一次就丢基线，下次出现被当成首次见到，
        这段时间的涨幅静默消失（数字偏小且不自知，比缺一天更危险）。
        """
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T01:05:00Z"}, "nodes": [{"id": "a/b", "stars": 100}, {"id": "c/d", "stars": 50}]}, self.path)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 110}]}, self.path)
        self.assertEqual(sorted(out["seen"].keys()), ["a/b", "c/d"], "缺席一轮不该丢掉基线")
        self.assertEqual(out["lastRound"]["carried"], 1)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T03:05:00Z"}, "nodes": [{"id": "a/b", "stars": 120}, {"id": "c/d", "stars": 70}]}, self.path)
        self.assertEqual(out["days"]["2026-10-07"]["c/d"], 20, "c/d 回来时 50->70 必须被记上（旧实现会当成首次见到，这 20 星静默消失）")

    def test_baseline_dropped_after_grace_window(self):
        """宽限期是有限的：超期才丢，文件不随历史总量无限膨胀（替代旧的"整表重建"断言）。"""
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-01T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 100}, {"id": "z/z", "stars": 10}]}, self.path)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 100}]}, self.path)
        self.assertEqual(sorted(out["seen"].keys()), ["a/b"], "缺席超过宽限期的基线要丢弃")

    def test_first_round_is_baseline_not_a_zero_day(self):
        """首轮只落基线，当天不进 sampledDays。

        否则"还没开始观测"会在榜单上画成"这天涨了 0 星"—— 线上 2026-10-07 正是这么显示的。
        """
        out = snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        self.assertEqual(out["sampledDays"], [], "首轮没有可比对的上一轮，不算观测")
        self.assertEqual(out["days"], {})
        self.assertTrue(out["lastRound"]["baseline"])

    def test_gap_goes_to_spans_not_to_the_day_bucket(self):
        """断档超过 26 小时：这一轮的增量进 spans，绝不塞进恢复日的日柱冒充单日。"""
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-04T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 100}]}, self.path)
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-04T03:05:00Z"}, "nodes": [{"id": "a/b", "stars": 105}]}, self.path)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 400}]}, self.path)
        self.assertEqual(out["days"]["2026-10-04"]["a/b"], 5)
        self.assertNotIn("2026-10-07", out["days"], "跨 71 小时的涨幅不能落进 10-07 的日柱")
        self.assertEqual(len(out["spans"]), 1)
        self.assertEqual(out["spans"][0]["from"], "2026-10-04")
        self.assertEqual(out["spans"][0]["to"], "2026-10-07")
        self.assertEqual(out["spans"][0]["d"]["a/b"], 295)
        self.assertEqual(out["spans"][0]["hours"], 71.0)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T03:05:00Z"}, "nodes": [{"id": "a/b", "stars": 410}]}, self.path)
        self.assertEqual(out["days"]["2026-10-07"]["a/b"], 10, "恢复日只装当天观测到的那 10 星")

    def test_every_round_is_written_even_without_changes(self):
        """每轮都落盘（哪怕 0 变化）：这是"这一轮确实观测过"的唯一证据。"""
        snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        out = snap.update_star_daily(self._mesh("2026-10-07", {"a/b": 100}), self.path)
        self.assertEqual(out["days"], {}, "没有变化就不该有数字")
        self.assertEqual(out["sampledDays"], ["2026-10-07"], "但这一天算观测过：画浅底座 0，而不是虚线「没数据」")

    def test_rounds_ledger_records_every_observed_round(self):
        """观测台账 {当地日 -> {first, last}} 回答"这天到底观测过没有"；基线轮不进台账。"""
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T01:05:00Z"}, "nodes": [{"id": "a/b", "stars": 100}]}, self.path)
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T02:05:00Z"}, "nodes": [{"id": "a/b", "stars": 110}]}, self.path)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T03:05:00Z"}, "nodes": [{"id": "a/b", "stars": 120}]}, self.path)
        self.assertEqual(out["rounds"]["2026-10-07"], {"first": "2026-10-07T02:05:00Z", "last": "2026-10-07T03:05:00Z"})

    def test_tolerates_missing_or_broken_file(self):
        self.assertEqual(snap.load_star_daily(self.path)["days"], {})
        self.path.write_text("不是 json", encoding="utf-8")
        self.assertEqual(snap.load_star_daily(self.path)["seen"], {})


class DayBoundaryTest(unittest.TestCase):
    """每日界限：按 DAY_TZ_OFFSET_HOURS（默认 +8）的 00:00 切天，而不是 UTC 00:00（= 北京 08:00）。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "star-daily.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_day_of_shifts_at_local_midnight(self):
        self.assertEqual(snap.day_of("2026-10-07T15:59:59Z"), "2026-10-07")
        self.assertEqual(snap.day_of("2026-10-07T16:00:00Z"), "2026-10-08", "北京 00:00 就该换日")
        self.assertEqual(snap.day_of("2026-10-07T23:30:00Z"), "2026-10-08")
        self.assertEqual(snap.day_of("2026-10-08T00:30:00Z"), "2026-10-08")
        self.assertEqual(snap.day_of("坏数据"), "坏数据", "解析不了就原样返回，不抛异常")

    def test_buckets_follow_local_day(self):
        # 北京 10-08 00:30（UTC 10-07 16:30）那一轮的增量应进 10-08 的桶
        snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T16:30:00Z"}, "nodes": [{"id": "a/b", "stars": 100}]}, self.path)
        out = snap.update_star_daily({"meta": {"generatedAt": "2026-10-07T16:45:00Z"}, "nodes": [{"id": "a/b", "stars": 130}]}, self.path)
        self.assertEqual(list(out["days"].keys()), ["2026-10-08"], "跨过北京 00:00 后应记进新的一天")
        self.assertEqual(out["days"]["2026-10-08"]["a/b"], 30)
        self.assertEqual(out["sampledDays"], ["2026-10-08"], "sampledDays 也用当地日期")


class RobustnessTest(unittest.TestCase):
    """采集器抗抖动（线上事故回归）。

    事故：2026-10-08 02:08 那一轮，版本抓取时 GitHub 掉了一次连接
    （RemoteDisconnected: Remote end closed connection without response），
    异常一路冒到 run_once，整轮在【写 mesh + 预计算】之前就结束了 ——
    站点数据白等一小时（采集器本身没死，下一轮照跑）。
    """

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "readmes.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_connection_drops_are_retried_then_raised_as_runtime(self):
        import http.client

        sleeps: list[float] = []
        client = GitHubClient(token=None, sleep=sleeps.append)
        boom = http.client.RemoteDisconnected("Remote end closed connection without response")
        with mock.patch("dsh_mesh.github.urllib.request.urlopen", side_effect=boom):
            with self.assertRaises(RuntimeError) as ctx:
                client.search("topic:dsh", page=1)
        # 统一成 RuntimeError：README / releases 两层已经按 RuntimeError 做了降级
        self.assertIn("连接失败", str(ctx.exception))
        self.assertIn("RemoteDisconnected", str(ctx.exception))
        self.assertEqual(client.stats.retries, 3, "重试 3 次后再放弃")
        self.assertEqual(len(sleeps), 3, "每次重试都要退避等待")

    def test_count_in_only_counts_the_current_pool(self):
        """状态面板的分子要用"可索引集合里已索引多少"，不能拿缓存总量当分子。

        线上出现过 README 索引 14513 / 14490（分子大于分母）：缓存留了早期抓过、
        现在星标已不达标的仓库，而分母是"当前星标 ≥ 1 的仓库数"。
        """
        from dsh_mesh.readmes import ReadmeIndex

        index = ReadmeIndex(self.path, max_chars=50)
        index.put("a/ok", "hello")
        index.put("old/gone", "早期抓过、现在已经不达标")
        self.assertEqual(index.count_in(["a/ok", "b/none", "old/gone"]), 2)
        self.assertEqual(index.count_in([]), 0)
        self.assertEqual(index.stats()["count"], 2, "缓存总量仍是 2（含老条目）")

    def test_releases_failure_never_raises_and_reports_error(self):
        import collect

        fake_args = type("A", (), {"releases_budget": 300, "dry_run": False, "from_raw": False, "from_store": False})()
        with mock.patch.object(collect, "fetch_releases", side_effect=RuntimeError("RemoteDisconnected: boom")):
            out = collect.fetch_releases_safe(fake_args, {"nodes": []}, lambda *_a: None)
        self.assertTrue(out.get("enabled"), "失败也要给出可读结果（而不是抛出去）")
        self.assertIn("RemoteDisconnected", out.get("error", ""), "把原因留在 summary 里")

    def test_releases_batch_gives_up_after_five_consecutive_failures(self):
        """连续 5 个仓库失败就本轮收手。

        网络真断时，每个仓库在 _open 里还要退避重试 3 次（约 14 秒），
        300 个仓库挨个试能耗掉一小时 —— 那才是把整轮拖死的原因。
        """
        import collect

        cache = TMP / "releases.json"
        nodes = [{"id": "a/r" + str(i), "stars": 10, "pushedAt": "2026-10-08T00:00:00Z"} for i in range(12)]
        args = type("A", (), {"releases_budget": 12, "dry_run": False, "from_raw": False, "from_store": False})()

        class FakeStats:
            core_remaining = None

        class FakeClient:
            def __init__(self, **_kw):
                self.stats = FakeStats()

            def releases(self, repo_id, per_page=20):
                raise RuntimeError("RemoteDisconnected: boom")

        with mock.patch.object(collect, "RELEASES_CACHE", cache), mock.patch.object(collect, "GitHubClient", FakeClient):
            out = collect.fetch_releases(args, {"nodes": nodes}, lambda *_a: None)
        self.assertEqual(out["failed"], 5, "只试 5 个就收手，实际 " + str(out["failed"]))
        self.assertGreaterEqual(out.get("picked", 0), 5, "本来该抓的仓库数要够触发熔断")


if __name__ == "__main__":
    unittest.main(verbosity=2)

