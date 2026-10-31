#!/usr/bin/env python3
"""采集器测试（标准库 unittest，无需 pytest）。

运行：python3 backend/tests/test_collector.py
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
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
from dsh_mesh import npm_downloads as npm  # noqa: E402
from dsh_mesh import npm_packages as npmp  # noqa: E402
from dsh_mesh import npm_search as npms  # noqa: E402
from dsh_mesh import admin_config as admin_cfg  # noqa: E402
from dsh_mesh.build import build_mesh, limit_for_frontend, relevance_score  # noqa: E402
from dsh_mesh import build as build_mod  # noqa: E402
from dsh_mesh.classify import apply_categories, classify_node  # noqa: E402
from dsh_mesh.config import HUB_ID, ROOT, SAMPLE_MESH, SAMPLE_RAW, WHITELIST_TAGS  # noqa: E402
from dsh_mesh.github import GitHubClient, load_token  # noqa: E402
from collect import count_explained_missing, seconds_until_next, core_floor  # noqa: E402

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
        # 同理，管理后台的运行态是"本机状态"，不能参与这条跨语言比对：
        #   · data/admin/config.json（白名单/旧版开关覆盖）
        #   · data/admin/ecosystem.json（共鸣清单的管理副本：后台关掉一个基座，本地就会少建共鸣边）
        # 两个都指向不存在的文件，等于强制回落到内置默认与策展产物。
        with mock.patch.object(admin_cfg, "CONFIG_FILE", TMP / "no-such-admin-config.json"), mock.patch.object(
            admin_cfg, "MANAGED_ECOSYSTEM_FILE", TMP / "no-such-managed-ecosystem.json"
        ):
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
            payload = json.loads(path.read_text(encoding="utf-8"))
            # repos 是单仓库级名单（issue#5 第1条）：外壳也必须带它，且与 owners 一起参与 count
            self.assertEqual(sorted(payload), ["count", "note", "owners", "repos", "updatedAt"], "外壳键位是前后端的硬契约")
            self.assertEqual(payload["count"], len(payload["owners"]) + len(payload["repos"]), "count = 两个名单的条目总数")
            # Node 侧 tools/admin-config.mjs 的 BLACKLIST_NOTE 与本文件必须一字不差：
            # 两边各存一份文案，分叉了也没人会发现，所以在这里钉死。
            js = (ROOT / "tools" / "admin-config.mjs").read_text(encoding="utf-8")
            match = re.search(r'const BLACKLIST_NOTE = "(.*?)";', js)
            self.assertIsNotNone(match, "admin-config.mjs 里应定义 BLACKLIST_NOTE")
            self.assertEqual(match.group(1), snap.BLACKLIST_NOTE, "JS 与 Python 的黑名单文案必须一致")
            path.write_text("{ 坏掉的 json", encoding="utf-8")
            self.assertEqual(snap.load_blacklist(path), {}, "文件损坏时不能拖垮采集")
            self.assertEqual(snap.load_blacklist_repos(path), {}, "损坏时单仓库名单同样当空表")

    def test_repo_level_blacklist_round_trip_and_merge(self):
        """单仓库级名单：写出去能读回来；只改作者名单时不能把仓库条目抹掉（静默解除拉黑）。"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "noise-blacklist.json"
            snap.write_blacklist(
                {"spammer": {"repos": 900}},
                path,
                repos={"xing-shuyin/noise-one": {"note": "手工", "addedAt": "2026-10-14T00:00:00Z"}},
            )
            self.assertEqual(
                snap.load_blacklist_repos(path),
                {"xing-shuyin/noise-one": {"note": "手工", "addedAt": "2026-10-14T00:00:00Z"}},
            )
            # 采集器只更新作者名单时必须原样保留仓库条目
            snap.write_blacklist({"spammer": {"repos": 900}, "other": {"repos": 1}}, path, repos=snap.load_blacklist_repos(path))
            self.assertIn("xing-shuyin/noise-one", snap.load_blacklist_repos(path))
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["count"], 3, "2 个作者 + 1 个仓库")
            self.assertEqual(payload["owners"]["spammer"]["repos"], 900)

    def test_build_mesh_skips_repo_and_owner_blacklists(self):
        """两种黑名单都要在构图时被剔掉，并各自计数（作者级 / 单仓库级分开记）。"""
        raws = [
            fake_repo("good", "dsh-keep", stars=5),
            fake_repo("good", "dsh-drop", stars=4),
            fake_repo("bad", "dsh-gone", stars=3),
        ]
        mesh = build_mesh(raws, {}, blacklist={"bad": {"repos": 9}}, blacklist_repos={"good/dsh-drop": {"note": "手工"}})
        ids = {n["id"] for n in mesh["nodes"]}
        self.assertEqual(ids, {"good/dsh-keep"}, "作者级与单仓库级都要生效，且不能连累同作者的别的仓库")
        self.assertEqual(mesh["meta"]["noiseSkipped"], 1, "作者级剔掉 1 个")
        self.assertEqual(mesh["meta"]["noiseReposSkipped"], 1, "单仓库级剔掉 1 个")
        self.assertEqual(mesh["meta"]["noiseBlacklistReposSize"], 1)
        self.assertIn("good/dsh-drop", mesh["meta"]["noiseBlacklistRepos"])


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

        # 观测时刻钉死：样本是 2026-10-01 冻结的，而"是否近期推送"的 14 天窗口以本轮观测日为基准。
        # 用真实的"今天"当基准，样本会随日期一天天滑出窗口 —— 2026-10-16 线上 CI 正是这样红的
        # （前一天还是绿的）。固定观测时刻后，"样本里近期推送过的仓库必须进 seen" 才有稳定含义。
        frozen = "2026-10-02T00:00:00Z"

        with mock.patch.object(build_mod, "utcnow", lambda: frozen), mock.patch.object(
            collect, "utcnow", lambda: frozen
        ), mock.patch.object(snap, "utcnow", lambda: frozen), mock.patch.object(
            collect, "MESH_JSON", TMP / "mesh.json"
        ), mock.patch.object(
            collect, "SNAPSHOT_DIR", TMP / "snapshots"
        ), mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"), mock.patch.object(
            collect, "STATUS_FILE", TMP / "status.json"
        ), mock.patch.object(collect, "STAR_HISTORY", TMP / "star-history.json"), mock.patch.object(
            collect, "UPDATE_LOG", TMP / "update-log.json"), mock.patch.object(
        collect, "STAR_DAILY", TMP / "star-daily.json"
        # 预计算与市场索引都会调 node、按真实 data/ 重写产物（mesh-core.* 与 dist/market/index.json）；
        # 测试一律用临时目录，两条都要挡掉 —— 漏挡一条，跑测试就会把线上那份索引写成本地贫瘠数据。
        ), mock.patch.object(collect, "run_precompute", lambda *_a, **_k: None), mock.patch.object(collect, "run_market_index", lambda *_a, **_k: None):
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
        ), mock.patch.object(
            collect, "STAR_DAILY", TMP / "star-daily.json"
        # 同上：别让测试里的预计算去改真实 data/ 目录
        ), mock.patch.object(collect, "run_precompute", lambda *_a, **_k: None), mock.patch.object(collect, "run_market_index", lambda *_a, **_k: None):
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

    def test_release_day_uses_the_same_boundary_as_the_board(self):
        """回归：版本日期必须按北京时间的日界线切，不能直接用 UTC 日。

        线上实例：hol-guard v3.38.0 发布于 UTC 2026-10-09 20:20 = 北京 10-10 04:20，
        旧实现存成 "2026-10-09"，周榜就把它算进前一天，当天(10-10)计数为 0。
        """
        payload = [
            {"tag_name": "北京凌晨发的", "published_at": "2026-10-09T20:20:22Z"},   # 北京 10-10 04:20
            {"tag_name": "北京昨晚发的", "published_at": "2026-10-09T15:54:13Z"},   # 北京 10-09 23:54
            {"tag_name": "北京零点整", "published_at": "2026-10-09T16:00:00Z"},     # 北京 10-10 00:00
            {"tag_name": "只有日期", "published_at": None, "created_at": "2026-10-08"},
        ]
        out = rel.slim_releases(payload)
        self.assertEqual(
            [r["at"] for r in out],
            ["2026-10-10", "2026-10-09", "2026-10-10", "2026-10-08"],
            "UTC 日与北京时间日必须按 DAY_TZ_OFFSET_HOURS 对齐",
        )
        self.assertEqual(rel.local_day("2026-10-09T15:59:59Z"), "2026-10-09")
        self.assertEqual(rel.local_day("2026-10-09T16:00:00Z"), "2026-10-10")

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

    def test_release_pages_keep_up_to_the_cap(self):
        """版本上限 200：GitHub 单页上限 100，所以要翻页；普通仓库仍只发一次请求。"""
        import collect

        self.assertEqual(rel.RELEASES_KEEP, 200, "周榜计数不能被截在 20")
        self.assertEqual(rel.RELEASES_PAGE, 100)

        class FakeClient:
            def __init__(self, pages):
                self.pages = pages
                self.calls = []

            def releases(self, repo_id, per_page=100, page=1):
                self.calls.append((repo_id, per_page, page))
                return self.pages.get(page)

        many = FakeClient({1: [{"tag": "v%d" % i} for i in range(100)], 2: [{"tag": "w%d" % i} for i in range(30)]})
        out = collect.fetch_release_pages(many, "a/many")
        self.assertEqual(len(out), 130)
        self.assertEqual([c[2] for c in many.calls], [1, 2], "第一页抓满就该翻第二页")

        few = FakeClient({1: [{"tag": "v1"}]})
        self.assertEqual(len(collect.fetch_release_pages(few, "a/few")), 1)
        self.assertEqual(len(few.calls), 1, "一次就抓完的不该翻页")

        down = FakeClient({1: None})
        self.assertIsNone(collect.fetch_release_pages(down, "a/down"), "第一页就失败 → 整条跳过")

        flaky = FakeClient({1: [{"tag": "v%d" % i} for i in range(100)], 2: None})
        self.assertEqual(len(collect.fetch_release_pages(flaky, "a/flaky")), 100, "第二页失败就用已拿到的")

    def test_put_and_stats(self):
        payload = rel.load_releases(self.path)
        rel.put(payload, "a/b", [{"tag": "v1", "name": "", "at": "2026-10-01", "pre": False}])
        rel.put(payload, "a/c", [])
        self.assertEqual(rel.stats(payload), {"repos": 2, "withReleases": 1, "versions": 1})


class NpmDownloadsTest(unittest.TestCase):
    """npm 周下载量：包名映射、private/多包、缺失=未知、一天一次只刷新提交/新入库。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "npm-downloads.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _iso(hours_ago: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - hours_ago * 3600))

    def test_parse_package_json_scoped_private_rename_and_workspaces(self):
        base = {"repository": None, "version": None}
        self.assertEqual(
            npm.parse_package_json('{"name":"@deepseek-harness-tui/dsh-tui"}'),
            {"status": "ok", "package": "@deepseek-harness-tui/dsh-tui", "multiPackage": False, **base},
        )
        self.assertEqual(
            npm.parse_package_json('{"name":"secret","private":true}'),
            {"status": "private", "package": None, "multiPackage": False, **base},
        )
        self.assertEqual(
            npm.parse_package_json('{"name":"dsh-market"}'),
            {"status": "ok", "package": "dshmarket", "multiPackage": False, **base},
            "改名表：dsh-market → dshmarket",
        )
        self.assertEqual(
            npm.parse_package_json('{"name":"root","workspaces":["packages/*"]}'),
            {"status": "ok", "package": "root", "multiPackage": True, **base},
            "有 workspaces 只取根，标多包",
        )
        self.assertEqual(npm.parse_package_json(None)["status"], "no-package")
        self.assertEqual(npm.parse_package_json("{bad")["status"], "unknown")
        self.assertEqual(npm.parse_package_json("{}")["status"], "unknown")

    def test_parse_package_json_keeps_repository_and_version(self):
        """归属核对与"复制品识别"都靠这两个字段，必须原样存下来。

        真实数据：dsh-plugin-wallpaper-engine 这个包名有 4 个仓库声明，其中 2 个复制品的
        repository 都指向真主 elysia395/dsh-wallpaper-engine —— 照抄 package.json 会把这行一起抄过来。
        """
        parsed = npm.parse_package_json(
            '{"name":"dsh-plugin-wallpaper-engine","version":"1.3.3",'
            '"repository":{"type":"git","url":"git+https://github.com/elysia395/dsh-wallpaper-engine.git"}}'
        )
        self.assertEqual(parsed["repository"], "git+https://github.com/elysia395/dsh-wallpaper-engine.git")
        self.assertEqual(parsed["version"], "1.3.3")
        self.assertEqual(
            npm.parse_package_json('{"name":"x","repository":"https://github.com/a/b"}')["repository"],
            "https://github.com/a/b",
            "字符串形式的 repository 也要认",
        )
        self.assertEqual(
            npm.parse_package_json('{"name":"s","private":true,"repository":"https://github.com/a/b"}')["repository"],
            "https://github.com/a/b",
            "private 的仓库也要记：它可能正是 npm 上那个包的真主",
        )
        self.assertIsNone(npm.parse_package_json('{"name":"x"}')["repository"])
        self.assertIsNone(npm.parse_package_json('{"name":"x","version":"   "}')["version"], "空白版本号当没有")
        self.assertIsNone(npm.parse_package_json("{}")["repository"])

    def test_registry_package_exists_distinguishes_new_package_from_missing(self):
        """新包刚发布时下载接口还没统计（range 404），但 registry 已有 —— 不能当成「包不存在」落终态。"""
        import urllib.error

        class FakeResp:
            status = 200

            def read(self, n=-1):
                return b'{"name":"dsh-region-edit"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        self.assertTrue(npm.registry_package_exists("dsh-region-edit", opener=lambda req, timeout=0: FakeResp()))
        def missing(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", None, None)
        self.assertFalse(npm.registry_package_exists("dsh-region-edit", opener=missing))
        def boom(req, timeout=0):
            raise OSError("network down")
        self.assertIsNone(npm.registry_package_exists("dsh-region-edit", opener=boom))

    def test_core_floor_adapts_to_the_real_limit(self):
        """写死 300 的收手线是线上"每轮只抓 1 个仓库"的根因，必须按实际上限打折。"""

        class FakeClient:
            def __init__(self, limit):
                self.stats = type("S", (), {"core_limit": limit, "core_remaining": None})()

        self.assertEqual(core_floor(FakeClient(None), 300), 300, "拿不到上限就沿用配置值")
        self.assertEqual(core_floor(FakeClient(5000), 300), 300, "有令牌（5000/小时）时行为不变")
        self.assertEqual(core_floor(FakeClient(60), 300), 30, "匿名（60/小时）时要真能把配额花掉，而不是每轮抓 1 个就收手")
        self.assertEqual(core_floor(FakeClient(0), 300), 300, "上限为 0 视为未知")

    def test_fetch_npm_downloads_ok_404_and_retry(self):
        class FakeResp:
            def __init__(self, body: bytes):
                self._body = body

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        sleeps: list[float] = []

        def opener_ok(req, timeout=20):
            # range 口径：逐日数组；总量由逐日求和得出（112438 = 50000 + 62438）
            return FakeResp(
                b'{"downloads":[{"day":"2026-10-03","downloads":50000},{"day":"2026-10-09","downloads":62438}],'
                b'"start":"2026-10-03","end":"2026-10-09","package":"dshmarket"}'
            )

        hit = npm.fetch_npm_downloads("dshmarket", sleep=sleeps.append, opener=opener_ok)
        self.assertEqual(hit["status"], "ok")
        self.assertEqual(hit["downloads"], 112438)
        self.assertEqual(hit["window"], {"start": "2026-10-03", "end": "2026-10-09"})
        self.assertEqual([d["day"] for d in hit["days"]], ["2026-10-03", "2026-10-09"], "逐日数组按日期升序带回")
        self.assertEqual(sum(d["downloads"] for d in hit["days"]), hit["downloads"], "总量必须等于逐日求和")
        self.assertEqual(npm.parse_npm_range({"downloads": [{"day": "2026-10-01", "downloads": 1}]})["downloads"], 1)
        self.assertIsNone(npm.parse_npm_range({"downloads": []}), "空逐日 → 判失败，不编 0")
        self.assertIsNone(npm.parse_npm_range({"downloads": [{"day": "2026-10-01", "downloads": -1}]}), "负值 → 判失败")

        def opener_404(req, timeout=20):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", hdrs=None, fp=None)

        miss = npm.fetch_npm_downloads("dsh-market", sleep=sleeps.append, opener=opener_404)
        self.assertEqual(miss["status"], "unknown", "404 = 确认无包（终态）")
        self.assertIsNone(miss["downloads"], "取不到不能写 0")

        calls = {"n": 0}

        def opener_flaky(req, timeout=20):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.HTTPError(req.full_url, 500, "boom", hdrs=None, fp=None)
            return FakeResp(b'{"downloads":[{"day":"2026-10-04","downloads":10}],"start":"2026-10-04","end":"2026-10-10"}')

        recovered = npm.fetch_npm_downloads("picgo", sleep=sleeps.append, opener=opener_flaky)
        self.assertEqual(recovered["status"], "ok")
        self.assertEqual(recovered["downloads"], 10)
        self.assertGreaterEqual(len(sleeps), 2, "5xx 要退避重试")

        def opener_down(req, timeout=20):
            raise OSError("network down")

        err = npm.fetch_npm_downloads("picgo", sleep=lambda *_a: None, opener=opener_down)
        self.assertEqual(err["status"], "error", "网络耗尽 → error（可重试），不是终态 unknown")
        self.assertIsNone(err["downloads"])

    def test_load_save_and_public_entry_never_fake_zero(self):
        self.assertEqual(npm.load_downloads(self.path)["repos"], {})
        self.path.write_text("不是 json", encoding="utf-8")
        self.assertEqual(npm.load_downloads(self.path)["repos"], {})
        payload = npm.load_downloads(self.path)
        npm.put(
            payload,
            "a/ok",
            {
                "status": "ok",
                "package": "dshmarket",
                "downloads": 100,
                "window": {"start": "2026-10-03", "end": "2026-10-09"},
                "multiPackage": False,
                "packageAt": "2026-10-11T00:00:00Z",
                "downloadsAt": "2026-10-11T00:00:00Z",
            },
        )
        npm.save_downloads(payload, self.path)
        loaded = npm.load_downloads(self.path)
        self.assertEqual(loaded["repos"]["a/ok"]["downloads"], 100)
        self.assertEqual(npm.public_entry(None)["status"], "unknown")
        self.assertIsNone(npm.public_entry(None)["downloads"])
        self.assertIsNone(npm.public_entry({"status": "ok", "downloads": "nope"})["downloads"])
        self.assertEqual(npm.public_entry({"status": "ok", "downloads": "nope"})["status"], "error")

    def test_pick_package_candidates_only_new_or_pushed_once_a_day(self):
        now = time.time()
        nodes = [
            {"id": "new/one", "stars": 10, "pushedAt": self._iso(1), "archived": False},
            {"id": "pushed/again", "stars": 50, "pushedAt": self._iso(1), "archived": False},
            {"id": "fresh/today", "stars": 99, "pushedAt": self._iso(1), "archived": False},
            {"id": "stale/quiet", "stars": 80, "pushedAt": self._iso(48), "archived": False},
            {"id": "gone/archived", "stars": 900, "pushedAt": self._iso(1), "archived": True},
        ]
        payload = {
            "repos": {
                "pushed/again": {"at": self._iso(48), "packageAt": self._iso(48), "status": "ok", "package": "x"},
                "fresh/today": {"at": self._iso(2), "packageAt": self._iso(2), "status": "ok", "package": "y"},
                "stale/quiet": {"at": self._iso(48), "packageAt": self._iso(48), "status": "ok", "package": "z"},
            }
        }
        # pushed/again：上次抓之后又推过，且已超过 24h → 进候选
        # fresh/today：又推过但 2 小时前刚抓过 → 跳过（一天一次）
        # stale/quiet：超过 24h 但没有新提交 → 不重读 package.json
        # new/one：从没抓过 → 进候选
        picked = npm.pick_package_candidates(payload, nodes, limit=10, now_ts=now)
        self.assertIn("new/one", picked)
        self.assertIn("pushed/again", picked)
        self.assertNotIn("fresh/today", picked)
        self.assertNotIn("stale/quiet", picked)
        self.assertNotIn("gone/archived", picked)

    def test_pick_download_candidates_daily_for_known_packages(self):
        now = time.time()
        payload = {
            "repos": {
                "a/stale": {"status": "ok", "package": "a", "downloadsAt": self._iso(30)},
                "a/fresh": {"status": "ok", "package": "b", "downloadsAt": self._iso(2)},
                "a/priv": {"status": "private", "package": None, "downloadsAt": self._iso(30)},
            }
        }
        picked = npm.pick_download_candidates(payload, limit=10, now_ts=now)
        self.assertEqual(picked, ["a/stale"])

    def test_pick_retries_stale_error_and_legacy_unknown_with_package(self):
        """回归：首次失败不能永久卡死；status=unknown 且 downloadsAt 是 3 天前 + 有包名 → 必须进候选。"""
        now = time.time()
        payload = {
            "repos": {
                "a/error": {
                    "status": "error",
                    "package": "ghost",
                    "downloads": None,
                    "downloadsAt": self._iso(80),  # > 72h
                },
                "a/ghost": {
                    "status": "unknown",
                    "package": "ghost-legacy",
                    "downloads": None,
                    "downloadsAt": self._iso(80),  # 旧版误记；无 terminal
                },
                "a/404": {
                    "status": "unknown",
                    "package": "gone",
                    "downloads": None,
                    "downloadsAt": self._iso(80),
                    "terminal": True,  # npm 404 终态
                },
                "a/fresh-err": {
                    "status": "error",
                    "package": "soon",
                    "downloadsAt": self._iso(10),  # < 72h，先别烦
                },
            }
        }
        picked = npm.pick_download_candidates(payload, limit=10, now_ts=now)
        self.assertIn("a/error", picked)
        self.assertIn("a/ghost", picked, "旧版 unknown+包名必须能重试")
        self.assertNotIn("a/404", picked, "确认 404 的终态不再刷")
        self.assertNotIn("a/fresh-err", picked)

    def test_file_raw_404_vs_network(self):
        client = GitHubClient(token=None, sleep=lambda *_a: None)
        with mock.patch.object(client, "_open", side_effect=RuntimeError("GitHub 返回 404：missing")):
            self.assertIsNone(client.file_raw("a/b", "package.json"))
        with mock.patch.object(client, "_open", side_effect=RuntimeError("GitHub 连接失败（Timeout）：x")):
            with self.assertRaises(RuntimeError):
                client.file_raw("a/b", "package.json")

    def test_npm_failure_never_raises_and_offline_skips(self):
        import collect

        fake_args = type("A", (), {"npm_budget": 300, "dry_run": False, "from_raw": False, "from_store": False})()
        with mock.patch.object(collect, "fetch_npm_downloads", side_effect=RuntimeError("boom")):
            out = collect.fetch_npm_safe(fake_args, {"nodes": []}, lambda *_a: None)
        self.assertTrue(out.get("enabled"))
        self.assertIn("boom", out.get("error", ""))

        offline = type("A", (), {"npm_budget": 300, "dry_run": False, "from_raw": True, "from_store": False})()
        skipped = collect.fetch_npm_downloads(offline, {"nodes": [{"id": "a/b"}]}, lambda *_a: None)
        self.assertEqual(skipped.get("enabled"), False)

    def test_market_index_hook_never_raises(self):
        """市场索引是给 DSH「发现」页读的：生成失败只能记一行日志，绝不许拖垮采集本身。"""
        import collect

        logs = []
        with mock.patch.object(collect.subprocess, "run", side_effect=RuntimeError("boom")):
            collect.run_market_index(logs.append)  # 不抛异常
        self.assertTrue(any("市场索引生成失败" in line for line in logs), logs)
        self.assertTrue(any("boom" in line for line in logs), logs)

    def test_market_index_hook_reports_nonzero_exit(self):
        """退出码非 0 也要如实记下来（含 stderr 摘要），而不是当成成功。"""
        import collect

        logs = []

        class Done:
            returncode = 1
            stdout = "候选（有下载量的仓库记录）: 10，本轮处理: 10\n"
            stderr = "ReferenceError: boom"

        with mock.patch.object(collect.subprocess, "run", return_value=Done()), mock.patch.object(
            collect, "_market_index_fresh", lambda *_a, **_k: False
        ):
            collect.run_market_index(logs.append)
        joined = " ".join(logs)
        self.assertIn("市场索引失败", joined)
        self.assertIn("ReferenceError", joined)

    def test_market_index_hook_treats_fresh_artifact_as_success(self):
        """线上实测 node 会在**写完文件之后**崩在退出阶段（libuv 断言）：产物刷新了就算成功，别误报失败。"""
        import collect

        logs = []

        class Done:
            returncode = -6
            stdout = "写入 /tmp/x/index.json：42 个插件 · 9 KB\n"
            stderr = "uv__io_poll: Assertion `errno == EEXIST' failed."

        with mock.patch.object(collect.subprocess, "run", return_value=Done()), mock.patch.object(
            collect, "_market_index_fresh", lambda *_a, **_k: True
        ):
            collect.run_market_index(logs.append)
        joined = " ".join(logs)
        self.assertIn("市场索引已刷新", joined)
        self.assertIn("-6", joined)
        self.assertNotIn("失败", joined)

    def test_market_index_hook_logs_success_line(self):
        """成功时把生成器那行「写入 …」摘要带到采集日志里，便于回溯这批索引是哪一轮生成的。"""
        import collect

        logs = []

        class Done:
            returncode = 0
            stdout = "候选（有下载量的仓库记录）: 10\n写入 /tmp/x/index.json：42 个插件 · 9 KB\n"
            stderr = ""

        with mock.patch.object(collect.subprocess, "run", return_value=Done()):
            collect.run_market_index(logs.append)
        joined = " ".join(logs)
        self.assertIn("市场索引已刷新", joined)
        self.assertIn("42 个插件", joined)

    def test_pkg_resolve_keeps_old_downloads_when_npm_blips(self):
        """回归：重读 package.json 后 npm 挂了，不得把已有周下载量抹成 unknown。"""
        import collect

        cache = TMP / "npm-downloads.json"
        npm.save_downloads(
            {
                "updatedAt": "2026-10-10T00:00:00Z",
                "repos": {
                    "a/ok": {
                        "status": "ok",
                        "package": "dshmarket",
                        "downloads": 112438,
                        "window": {"start": "2026-10-03", "end": "2026-10-09"},
                        "multiPackage": False,
                        "packageAt": self._iso(48),
                        "downloadsAt": self._iso(48),
                    }
                },
            },
            cache,
        )
        nodes = [{"id": "a/ok", "stars": 10, "pushedAt": self._iso(1), "archived": False}]
        args = type("A", (), {"npm_budget": 10, "dry_run": False, "from_raw": False, "from_store": False})()

        class FakeClient:
            stats = type("S", (), {"core_remaining": 5000})()

            def file_raw(self, repo_id, path):
                return '{"name":"dshmarket"}'

        with mock.patch.object(collect, "NPM_DOWNLOADS_CACHE", cache), \
             mock.patch.object(collect, "GitHubClient", return_value=FakeClient()), \
             mock.patch.object(collect, "load_token", return_value=None), \
             mock.patch.object(npm, "fetch_npm_downloads", return_value={"status": "unknown", "downloads": None, "window": None}), \
             mock.patch.object(collect.time, "sleep", lambda *_a: None):
            out = collect.fetch_npm_downloads(args, {"nodes": nodes}, lambda *_a: None)

        loaded = npm.load_downloads(cache)["repos"]["a/ok"]
        self.assertEqual(loaded["status"], "ok", "npm 短暂失败不能改写 status")
        self.assertEqual(loaded["downloads"], 112438, "旧下载量必须保留")
        self.assertEqual(loaded["window"], {"start": "2026-10-03", "end": "2026-10-09"})
        self.assertEqual(loaded["package"], "dshmarket")
        self.assertGreaterEqual(out.get("failed", 0), 1)


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


class WhitelistScopeTest(unittest.TestCase):
    """后台白名单必须同时作用于「抓取」与「构建」：新增 / 删除 / 别名三种场景。

    回归：build_mesh 曾经只认内置 6 个标签，后台加标签只改了抓取，新仓库抓回来又被构图丢掉；
    后台删标签则完全无效。见 docs/admin.md 的 FAQ。
    """

    def test_custom_whitelist_tag_is_indexed(self):
        repo = fake_repo("alice", "foo-plugin", stars=5, topics=("dsh-theme",))
        mesh = build_mesh([repo], {}, whitelist_tags=["dsh", "dsh-theme"])
        self.assertIn("alice/foo-plugin", [n["id"] for n in mesh["nodes"]], "后台新增的标签必须能进图")
        self.assertIn("dsh-theme", [t["id"] for t in mesh["tags"]], "契约里的标签清单也要跟着生效白名单走")

    def test_default_whitelist_still_drops_custom_tag(self):
        repo = fake_repo("alice", "foo-plugin", stars=5, topics=("dsh-theme",))
        mesh = build_mesh([repo], {})
        self.assertNotIn("alice/foo-plugin", [n["id"] for n in mesh["nodes"]])
        self.assertEqual(mesh["meta"]["notMatchedSkipped"], 1, "被白名单挡掉的仓库要如实记账（缩水保护要用）")

    def test_removed_tag_stops_being_indexed(self):
        repo = fake_repo("alice", "foo-plugin", stars=5, topics=("dsh",))
        mesh = build_mesh([repo], {}, whitelist_tags=["dsh-theme"])
        self.assertNotIn("alice/foo-plugin", [n["id"] for n in mesh["nodes"]], "后台删掉的标签必须不再收录")

    def test_alias_under_custom_tag_is_matched(self):
        repo = fake_repo("alice", "foo-plugin", stars=5, topics=("awesome-theme",))
        aliases = [{"tag": "dsh-theme", "aliases": ["awesome-theme"]}]
        mesh = build_mesh([repo], {}, whitelist_tags=["dsh", "dsh-theme"], whitelist_aliases=aliases)
        self.assertIn("alice/foo-plugin", [n["id"] for n in mesh["nodes"]], "自定义标签下的别名也要能命中")


class SegmentPruneTest(unittest.TestCase):
    """删白名单标签后，旧标签的分段必须从队列里清掉，否则会一直吃刷新预算。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def _store(self, tags):
        from dsh_mesh.segments import SegmentStore, seed_segments

        store = SegmentStore(TMP / "segments.json", TMP / "repos.json")
        store.state["segments"] = {s["key"]: dict(s, state="pending") for s in seed_segments(tags)}
        return store

    def test_prune_topics_removes_removed_tags_but_keeps_name_sources(self):
        from dsh_mesh.segments import NAME_SOURCES

        store = self._store(["dsh", "old-tag"])
        before = len(store.state["segments"])
        pruned = store.prune_topics(["dsh"])
        self.assertGreater(pruned, 0)
        topics = {s["topic"] for s in store.state["segments"].values()}
        self.assertEqual(topics, {"dsh", *NAME_SOURCES}, "名字收录源不能被清掉")
        self.assertEqual(len(store.state["segments"]), before - pruned)

    def test_empty_tags_does_not_wipe_queue(self):
        store = self._store(["dsh"])
        before = len(store.state["segments"])
        self.assertEqual(store.prune_topics([]), 0, "配置读不到时不能把队列清空")
        self.assertEqual(len(store.state["segments"]), before)


class ShrinkExplanationTest(unittest.TestCase):
    """缩水保护要能解释「白名单删标签 / 黑名单 / 改名」造成的减少，否则后台删标签永远被拒。"""

    def test_known_reasons_are_explained_unknown_is_not(self):
        prev = {
            "nodes": [
                {"id": "a/one", "topics": ["dsh"]},      # 作者黑名单
                {"id": "b/two", "topics": ["dsh"]},      # 单仓库黑名单
                {"id": "c/old", "topics": ["dsh"]},      # 改名
                {"id": "d/three", "topics": ["old-tag"]},  # 白名单删标签
                {"id": "e/four", "topics": ["dsh"]},     # 说不出的减少（数据故障）
            ]
        }
        cur = {"nodes": [{"id": "c/new"}, {"id": "x/keep"}]}
        explained = count_explained_missing(
            prev,
            cur,
            blacklist={"a"},
            blacklist_repos={"b/two"},
            whitelist_tags=["dsh"],
            aliases={"c/old": "c/new"},
        )
        self.assertEqual(explained, 4, "a/b/c/d 四个能解释，e/four 不能")
        self.assertEqual(count_explained_missing(None, cur), 0, "没有上一份数据时不解释")

    def test_renamed_node_not_double_counted_when_still_present(self):
        prev = {"nodes": [{"id": "c/old", "topics": ["dsh"]}]}
        cur = {"nodes": [{"id": "c/new", "topics": ["dsh"]}]}
        self.assertEqual(count_explained_missing(prev, cur, aliases={"c/old": "c/new"}), 1)


class CollectWiringTest(unittest.TestCase):
    """collect.run_once 必须把「本轮生效白名单」传给构建层（后台改标签才能真正生效）。"""

    def test_run_once_passes_effective_whitelist_to_build(self):
        import collect

        captured = {}
        real_build = collect.build_mesh

        def spy(raws, totals, **kwargs):
            captured.update(kwargs)
            return real_build(raws, totals, **kwargs)

        args = argparse.Namespace(
            dry_run=True,
            from_raw=True,
            from_store=False,
            tags=["dsh", "dsh-theme"],
            interval=3600,
            budget=0,
            collector=None,
            collector_source=None,
        )
        with mock.patch.object(collect, "build_mesh", spy):
            summary = collect.run_once(args, lambda *a, **k: None)
        self.assertEqual(captured.get("whitelist_tags"), ["dsh", "dsh-theme"], "run_once 必须把生效白名单传给 build_mesh")
        self.assertEqual(summary.get("mode"), "from-raw")
        self.assertTrue(summary.get("dryRun"), "dry-run 不应写盘")


class HeartbeatTest(unittest.TestCase):
    """长耗时阶段的心跳：后台靠 status.updatedAt 判活，心跳必须真的刷新它，且失败不能打断采集。"""

    def setUp(self):
        import collect

        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.collect = collect
        self._old_status = collect.STATUS_FILE
        self.path = TMP / "status.json"
        collect.STATUS_FILE = self.path

    def tearDown(self):
        self.collect.STATUS_FILE = self._old_status
        shutil.rmtree(TMP, ignore_errors=True)

    def test_heartbeat_refreshes_updated_at_and_keeps_state(self):
        self.collect._write_status(state="precomputing", phase="precompute")
        first = json.loads(self.path.read_text(encoding="utf-8"))["updatedAt"]
        time.sleep(1.1)  # updatedAt 是秒级时间戳，必须跨过一秒
        with self.collect._heartbeat(interval=0.05, phase="precompute"):
            time.sleep(0.3)
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["state"], "precomputing", "心跳不能把 state 写丢")
        self.assertEqual(data["phase"], "precompute")
        self.assertNotEqual(data["updatedAt"], first, "心跳必须刷新 updatedAt（否则后台仍会判死）")

    def test_heartbeat_write_failure_is_swallowed(self):
        blocker = TMP / "blocker"
        blocker.write_text("x", encoding="utf-8")
        self.collect.STATUS_FILE = blocker / "status.json"  # 父路径是文件 → 写入必失败
        with self.collect._heartbeat(interval=0.05, phase="precompute"):
            time.sleep(0.2)  # 不抛异常即通过


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


class AdminConfigTest(unittest.TestCase):
    """管理后台共享配置（data/admin/config.json）：缺失/损坏/正常三态都要能用，永不抛异常。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.path = TMP / "admin" / "config.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def _write(self, payload):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        self.path.write_text(text, encoding="utf-8")
        return self.path

    def test_missing_file_returns_deep_copied_default(self):
        cfg = admin_cfg.load_admin_config(self.path)
        self.assertEqual(cfg["version"], 1)
        self.assertEqual(cfg["whitelistTags"], list(WHITELIST_TAGS))
        self.assertEqual(cfg["resonance"], {"overrides": {}})
        # 默认值必须是深拷贝：调用方改它不能污染模块级默认值 / 下一次读取
        cfg["whitelistTags"].append("污染")
        cfg["resonance"]["overrides"]["a/b"] = {"enabled": False}
        again = admin_cfg.load_admin_config(self.path)
        self.assertEqual(again["whitelistTags"], list(WHITELIST_TAGS))
        self.assertEqual(again["resonance"], {"overrides": {}})

    def test_broken_and_wrong_type_files_never_raise(self):
        for text in ("{ 坏掉的 json", "[1, 2, 3]", '"只是字符串"', "null", ""):
            self._write(text)
            self.assertEqual(admin_cfg.load_admin_config(self.path)["version"], 1, text)
            self.assertEqual(admin_cfg.whitelist_tags(self.path), list(WHITELIST_TAGS), text)
            self.assertEqual(admin_cfg.resonance_overrides(self.path), {}, text)
        # 路径指向目录（read_text 抛 IsADirectoryError）也只能回退，不能抛
        self.path.unlink()
        self.path.mkdir(parents=True, exist_ok=True)
        self.assertEqual(admin_cfg.whitelist_tags(self.path), list(WHITELIST_TAGS))

    def test_normal_config_is_read(self):
        self._write({
            "version": 1,
            "updatedAt": "2026-10-11T00:00:00Z",
            "whitelistTags": ["dsh-plugin", "dsh-custom"],
            "resonance": {"overrides": {"owner/repo": {"enabled": False}}},
        })
        self.assertEqual(admin_cfg.load_admin_config(self.path)["updatedAt"], "2026-10-11T00:00:00Z")
        self.assertEqual(admin_cfg.whitelist_tags(self.path), ["dsh-plugin", "dsh-custom"])
        self.assertEqual(admin_cfg.resonance_overrides(self.path), {"owner/repo": False})

    def test_whitelist_cleans_dedupes_and_falls_back(self):
        self._write({"whitelistTags": [" dsh-plugin ", "", "dsh-plugin", 42, None, "dsh-x", "dsh-x"]})
        self.assertEqual(admin_cfg.whitelist_tags(self.path), ["dsh-plugin", "dsh-x"], "去空、去重、保序")
        for bad in ([], [1, None, "   "], "dsh", {"dsh": True}):
            self._write({"whitelistTags": bad})
            self.assertEqual(admin_cfg.whitelist_tags(self.path), list(WHITELIST_TAGS), repr(bad))

    def test_resonance_overrides_ignore_illegal_entries(self):
        self._write({"resonance": {"overrides": {
            "a/b": {"enabled": False},
            "c/d": {"enabled": True},
            "e/f": {"enabled": "no"},  # enabled 不是布尔 => 忽略
            "g/h": {},                 # 缺 enabled => 忽略
            "": {"enabled": False},    # 空键 => 忽略
            "i/j": None,               # 值不是对象/布尔 => 忽略
            "k/l": True,               # 容错：直接写布尔也认
        }}})
        self.assertEqual(admin_cfg.resonance_overrides(self.path), {"a/b": False, "c/d": True, "k/l": True})
        for bad in ("坏", {"overrides": []}, {"overrides": {"a/b": {"enabled": 1}}}):
            self._write({"resonance": bad})
            self.assertEqual(admin_cfg.resonance_overrides(self.path), {}, repr(bad))

    def test_main_resolves_tags_from_admin_config_offline_too(self):
        """--tags 省略时读后台配置；离线路径（--from-raw）也走同一份解析结果。"""
        import collect

        cfg = self._write({"whitelistTags": ["dsh-custom"]})
        seen = {}
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg), mock.patch.object(
            collect, "run_once", side_effect=lambda args, log: seen.update(tags=args.tags)
        ):
            collect.main(["--from-raw", "--quiet"])
            self.assertEqual(seen["tags"], ["dsh-custom"])
            collect.main(["--from-raw", "--quiet", "--tags", "a", "b"])
            self.assertEqual(seen["tags"], ["a", "b"], "显式 --tags 优先于后台配置")
            cfg.unlink()
            collect.main(["--from-raw", "--quiet"])
            self.assertEqual(seen["tags"], list(WHITELIST_TAGS), "后台配置缺失时回退内置白名单")


    # ---------- 采集参数（issue#5 第4条）：显式命令行 > 后台配置 > 内置默认 ----------

    def _null_args(self, **overrides):
        import collect  # backend/collect.py（sys.path 已含 backend）

        args = argparse.Namespace()
        for attr in collect.COLLECTOR_ARG_MAP:
            setattr(args, attr, None)  # 命令行 default 必须是 None："没写"与"写了 0"才分得开
        for key, value in overrides.items():
            setattr(args, key, value)
        return args

    def test_collector_args_precedence_config_beats_cli(self):
        """后台配置 > 启动参数 > 内置默认值：后台是给人用的入口，启动参数只当初始化默认。

        反面教材：线上部署命令写着 --budget 600，若让它压过配置，用户在后台把预算改成 200
        会毫无效果 —— 那正是 issue#5 第4条要解决的"改了不生效"。
        """
        import collect

        cfg = self._write({"collector": {"budget": 200}})
        # 配置写了 budget=200，启动参数是 --budget 600：必须听配置的
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg):
            resolved = collect.resolve_collector_args(self._null_args(budget=600), log=None)
        self.assertEqual(resolved["effective"]["budget"], 200, "配置要压过启动参数")
        self.assertEqual(resolved["source"]["budget"], "config")

        # 配置里没写过的键：启动参数当初始化默认值
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg):
            resolved = collect.resolve_collector_args(self._null_args(interval=1800), log=None)
        self.assertEqual(resolved["effective"]["interval"], 1800, "没配置的项用启动参数")
        self.assertEqual(resolved["source"]["interval"], "cli")

        # 既没配置也没启动参数：内置默认值
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg):
            resolved = collect.resolve_collector_args(self._null_args(), log=None)
        self.assertEqual(resolved["effective"]["maxPages"], 10)
        self.assertEqual(resolved["source"]["maxPages"], "default")

        # 配置损坏：整份当没配置，启动参数 + 内置默认兜底，绝不炸
        cfg = self._write("{ 坏掉的 json")
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg):
            resolved = collect.resolve_collector_args(self._null_args(budget=42), log=None)
        self.assertEqual(resolved["effective"]["budget"], 42, "配置坏了退回启动参数")
        self.assertEqual(resolved["source"]["budget"], "cli")
        self.assertEqual(resolved["effective"]["maxPages"], 10)

        # 坏值/越界：值回退默认，但来源照样记 config（用户确实写过，只是值没被采纳）
        cfg = self._write({"collector": {"budget": -5, "maxPages": 99}})
        with mock.patch.object(admin_cfg, "CONFIG_FILE", cfg):
            resolved = collect.resolve_collector_args(self._null_args(), log=None)
        self.assertEqual(resolved["effective"]["budget"], 120, "越界值回退内置默认")
        self.assertEqual(resolved["source"]["budget"], "config")
        self.assertEqual(resolved["effective"]["maxPages"], 10)

    # ---------- 白名单别名组（issue#5 第3条）：匹配层展开，抓取层不展开 ----------

    def test_whitelist_aliases_expand_for_matching_only(self):
        groups = admin_cfg.normalize_aliases(
            [
                {"tag": "dsh", "aliases": ["awesome-dsh", "dsh-awesome", "dsh", "bad tag!"]},
                {"tag": "not-in-whitelist", "aliases": ["x"]},
            ],
            ["dsh", "dsh-plugin"],
        )
        self.assertEqual(groups, [{"tag": "dsh", "aliases": ["awesome-dsh", "dsh-awesome"]}], "非法/重复/等于规范名/不在白名单的组都要丢掉")

        effective, alias_to_canon = admin_cfg.effective_tags(["dsh", "dsh-plugin"], groups)
        self.assertEqual(effective, ["dsh", "dsh-plugin", "awesome-dsh", "dsh-awesome"], "匹配集合含别名")
        self.assertEqual(alias_to_canon, {"awesome-dsh": "dsh", "dsh-awesome": "dsh"})
        # 抓取层永远只用规范标签：GitHub 搜索只认精确 topic，拿别名去搜等于白烧配额
        self.assertEqual(admin_cfg.whitelist_tags.__name__, "whitelist_tags")
        self.assertNotIn("awesome-dsh", ["dsh", "dsh-plugin"])

    def test_build_mesh_matches_alias_but_keeps_canonical_tags(self):
        raws = [
            fake_repo("aliasco", "some-tool", stars=3),  # topics 只有别名
            fake_repo("plainco", "dsh-plain", stars=2),
        ]
        raws[0]["topics"] = ["awesome-dsh"]
        with mock.patch.object(build_mod, "WHITELIST_TAGS", ["dsh", "dsh-plugin"]):
            mesh = build_mesh(raws, {}, whitelist_aliases=[{"tag": "dsh", "aliases": ["awesome-dsh"]}])
        by_id = {n["id"]: n for n in mesh["nodes"]}
        self.assertIn("aliasco/some-tool", by_id, "打了别名标签的仓库要能进索引")
        self.assertEqual(by_id["aliasco/some-tool"]["matchedTags"], ["dsh"], "别名要归到规范标签上")
        self.assertEqual(by_id["aliasco/some-tool"]["primaryTag"], "dsh", "主标签也要是规范标签")
        # 不传别名组 = 老行为（精确命中），冻结的跨语言参照物靠这个默认值保持原样
        with mock.patch.object(build_mod, "WHITELIST_TAGS", ["dsh", "dsh-plugin"]):
            old = build_mesh(raws, {})
        self.assertNotIn("aliasco/some-tool", {n["id"] for n in old["nodes"]}, "不传别名组时别名不算命中")

    def test_offline_round_records_collector_args_and_source(self):
        """状态文件要带上"本轮生效值 + 它来自哪"：后台设置页靠它标注每一项的来源。

        用 main(--from-store --dry-run) 走一遍：dry-run 在开头写完状态就返回，
        既不用碰真实 data/，也不会真的重建数据，正好验证那次写入。
        """
        import collect

        captured = {}
        real_write = collect._write_status

        def spying_status(**fields):
            if "collectorArgs" in fields:
                captured.update(fields)
            return real_write(**fields)

        fake_store = type("S", (), {
            "drop_owners": lambda self, owners: 0,
            "ensure_seeded": lambda self, tags: 0,
            "requeue_truncated": lambda self, log=None: 0,
            "coverage": lambda self: {"repos": 0, "segments": {"total": 0, "done": 0, "pending": 0, "split": 0}},
            "save": lambda self: None,
        })()
        # 输出路径全部指向临时目录：run_once 会真的写 mesh/快照，绝不能碰仓库里的 data/
        patches = [
            mock.patch.object(collect, "STATUS_FILE", TMP / "params-status.json"),
            mock.patch.object(collect, "MESH_JSON", TMP / "mesh.json"),
            mock.patch.object(collect, "SNAPSHOT_DIR", TMP / "snapshots"),
            mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"),
            mock.patch.object(collect, "STAR_HISTORY", TMP / "star-history.json"),
            mock.patch.object(collect, "UPDATE_LOG", TMP / "update-log.json"),
            mock.patch.object(collect, "STAR_DAILY", TMP / "star-daily.json"),
            mock.patch.object(collect, "run_precompute", lambda *_a, **_k: None), mock.patch.object(collect, "run_market_index", lambda *_a, **_k: None),
            mock.patch.object(collect, "SegmentStore", lambda *a, **k: fake_store),
            mock.patch.object(
                collect,
                "load_from_store",
                lambda a, log: (
                    [],
                    {},
                    type("St", (), {
                        "requests": 0,
                        "retries": 0,
                        "rate_limit_remaining": None,
                        "truncated_slices": [],
                        # 采集统计以后还会加字段；测试关心的是状态写入，不该被每个新字段绊倒
                        "__getattr__": lambda self, name: None,
                        "as_dict": lambda self: {},
                    })(),
                    {"mode": "store-rebuild", "token": "-"},
                ),
            ),
            mock.patch.object(collect, "_write_status", spying_status),
        ]
        for p in patches:
            p.start()
        try:
            code = collect.main(["--from-store", "--quiet"])
        finally:
            for p in reversed(patches):
                p.stop()
        self.assertEqual(code, 0)
        self.assertTrue(captured, "开头那次状态写入要带上采集参数")
        self.assertEqual(captured.get("state"), "crawling")
        self.assertEqual(set(captured["collectorArgs"]), set(collect.COLLECTOR_ARG_MAP.values()), "11 项参数都要记")
        self.assertIn("collectorSource", captured, "状态里必须记录每个值的来源")


class ResonanceOverrideTest(unittest.TestCase):
    """后台启停覆盖：enabled=false 的基座不建共鸣边，但仍归入协议基座。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.eco = TMP / "ecosystem.json"
        self.eco.write_text(json.dumps({"bases": [
            {"id": "zzz/base", "label": "开着的基座", "enabled": True, "verified": [{"id": "aaa/plugin"}]},
            {"id": "yyy/base", "label": "后台关掉的基座", "enabled": True, "verified": [{"id": "bbb/plugin"}]},
            {"id": "xxx/off", "label": "策展就关掉的基座", "enabled": False, "verified": [{"id": "ccc/plugin"}]},
        ]}), encoding="utf-8")
        self.admin = TMP / "admin" / "config.json"
        self.admin.parent.mkdir(parents=True, exist_ok=True)
        self.admin.write_text(json.dumps({"resonance": {"overrides": {
            "yyy/base": {"enabled": False},
            "nope/missing": {"enabled": False},  # 清单里没有的基座：忽略，不凭空造
        }}}), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_disabled_base_is_kept_in_meta_but_builds_no_edge(self):
        raws = [
            fake_repo("zzz", "base", stars=100),
            fake_repo("aaa", "plugin", stars=5),
            fake_repo("yyy", "base", stars=90),
            fake_repo("bbb", "plugin", stars=4),
            fake_repo("xxx", "off", stars=80),
            fake_repo("ccc", "plugin", stars=3),
        ]
        with mock.patch.object(build_mod, "ECOSYSTEM_JSON", self.eco), mock.patch.object(
            admin_cfg, "CONFIG_FILE", self.admin
        ):
            mesh = build_mesh(raws, {})
        reso = {(e["source"], e["target"]) for e in mesh["edges"] if e["type"] == "resonance"}
        self.assertEqual(reso, {("zzz/base", "aaa/plugin")}, "被关掉的基座不能建共鸣边")
        self.assertEqual(mesh["meta"]["ecosystemBases"], ["zzz/base"])
        self.assertEqual(mesh["meta"]["ecosystemDisabled"], ["xxx/off", "yyy/base"])
        # 关掉的基座仍然是"协议基座"：apply_categories 的 base_ids 用全部基座（含关闭的）
        by_id = {n["id"]: n for n in mesh["nodes"]}
        self.assertTrue(by_id["yyy/base"].get("categoryCurated"), "后台关掉的基座仍要归入协议基座")
        self.assertEqual(by_id["yyy/base"]["category"], "spec")
        self.assertNotIn("nope/missing", mesh["meta"]["ecosystemBases"], "覆盖里不存在的基座不能凭空造出来")

    # ---------- 采集参数（issue#5 第4条）：显式命令行 > 后台配置 > 内置默认 ----------

    def test_missing_admin_config_leaves_curated_state(self):
        raws = [fake_repo("zzz", "base", stars=100), fake_repo("aaa", "plugin", stars=5)]
        with mock.patch.object(build_mod, "ECOSYSTEM_JSON", self.eco), mock.patch.object(
            admin_cfg, "CONFIG_FILE", TMP / "no-such-config.json"
        ):
            mesh = build_mesh(raws, {})
        reso = [(e["source"], e["target"]) for e in mesh["edges"] if e["type"] == "resonance"]
        self.assertEqual(reso, [("zzz/base", "aaa/plugin")], "后台没配置时按策展清单走")


class AtomicWriteTest(unittest.TestCase):
    """_write_json 原子落盘：临时文件 + os.replace；失败不留垃圾、原文件不动。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def _temps(self):
        return sorted(p.name for p in TMP.glob("*.tmp"))

    def test_failure_keeps_original_and_cleans_temp(self):
        path = TMP / "last-crawl.json"
        snap._write_json(path, {"n": 1})
        before = path.read_bytes()
        with mock.patch("dsh_mesh.snapshot.os.replace", side_effect=OSError("磁盘满了")):
            with self.assertRaises(OSError):
                snap._write_json(path, {"n": 2})
        self.assertEqual(path.read_bytes(), before, "写入失败时原文件必须保持原样")
        self.assertEqual(self._temps(), [], "失败不能留下临时文件")

    def test_replaces_content_and_keeps_original_mode(self):
        path = TMP / "mesh.json"
        path.write_text("旧内容", encoding="utf-8")
        os.chmod(path, 0o640)
        snap._write_json(path, {"v": 2})
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"v": 2})
        self.assertEqual(path.stat().st_mode & 0o777, 0o640, "权限要与原文件一致")
        self.assertEqual(self._temps(), [])

    def test_temp_file_is_not_treated_as_snapshot(self):
        (TMP / "2026010100.json").write_text("{}", encoding="utf-8")
        (TMP / "2026010200.json").write_text('{"ok": true}', encoding="utf-8")
        (TMP / "2026010300.json.99999.tmp").write_text("{写到一半", encoding="utf-8")
        self.assertEqual(snap.latest_snapshot(TMP), {"ok": True}, "枚举快照必须跳过 .tmp")
        removed = snap.prune_snapshots(TMP, 1)
        self.assertEqual(removed, ["2026010100.json"])
        self.assertEqual(self._temps(), ["2026010300.json.99999.tmp"], "prune 不能把 tmp 当正式快照")

    def test_write_snapshot_leaves_no_temp_file(self):
        mesh = build_mesh(sample_raw(), {}, aliases={})
        path, _diff = snap.write_snapshot(mesh, TMP, keep=5)
        self.assertIsNotNone(path)
        self.assertEqual(self._temps(), [])
        self.assertEqual(snap.latest_snapshot(TMP)["counts"]["nodes"], len(mesh["nodes"]))


class AdminBlacklistPersistenceTest(unittest.TestCase):
    """后台人工黑名单条目不能被采集器的自动落盘抹掉：落盘 = 现有 ∪ 本轮新判定。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)
        self.raw = TMP / "raw.json"
        raws = [fake_repo("mass", "dsh-mass-%d" % i) for i in range(201)]  # >200 个全 0 星 => 判噪声
        self.raw.write_text(json.dumps({"repos": raws, "queryMeta": []}), encoding="utf-8")
        self.blacklist = TMP / "noise-blacklist.json"

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def _write_blacklist(self, owners):
        self.blacklist.write_text(
            json.dumps({"updatedAt": "x", "count": len(owners), "owners": owners}), encoding="utf-8"
        )

    def _run_round(self, patch_build=None):
        import collect

        patches = [
            mock.patch.object(collect, "SAMPLE_RAW", self.raw),
            mock.patch.object(collect, "NOISE_BLACKLIST", self.blacklist),
            mock.patch.object(collect, "MESH_JSON", TMP / "mesh.json"),
            mock.patch.object(collect, "SNAPSHOT_DIR", TMP / "snapshots"),
            mock.patch.object(collect, "LAST_CRAWL", TMP / "last-crawl.json"),
            mock.patch.object(collect, "STATUS_FILE", TMP / "status.json"),
            mock.patch.object(collect, "STAR_HISTORY", TMP / "star-history.json"),
            mock.patch.object(collect, "STAR_DAILY", TMP / "star-daily.json"),
            mock.patch.object(collect, "UPDATE_LOG", TMP / "update-log.json"),
            # 预计算会调 node 写真实 data/ 目录：测试里必须挡掉（测试一律用临时目录）
            mock.patch.object(collect, "run_precompute", lambda *_a, **_k: None), mock.patch.object(collect, "run_market_index", lambda *_a, **_k: None),
            # 隔离真实运行态的 data/admin/config.json
            mock.patch.object(admin_cfg, "CONFIG_FILE", TMP / "admin" / "config.json"),
        ]
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            if patch_build is not None:
                stack.enter_context(mock.patch.object(collect, "build_mesh", side_effect=patch_build))
            with contextlib.redirect_stdout(out):
                code = collect.main(["--from-raw"])
        return code, out.getvalue()

    def test_existing_manual_entry_survives_automatic_write(self):
        self._write_blacklist({"human/manual": {"repos": 1, "reason": "人工"}})
        code, out = self._run_round()
        self.assertEqual(code, 0)
        owners = snap.load_blacklist(self.blacklist)
        self.assertIn("human/manual", owners, "采集开始前就存在的人工条目必须保留")
        self.assertIn("mass", owners, "本轮新判定的噪声作者必须写入")
        self.assertIn("新增拉黑 1 个", out)
        self.assertIn("保留既有（含人工）1 个", out)

    def test_entry_added_by_admin_during_round_is_not_overwritten(self):
        self._write_blacklist({})
        real_build = build_mod.build_mesh

        def build_then_admin_adds(*args, **kwargs):
            mesh = real_build(*args, **kwargs)
            # 模拟后台在采集期间往黑名单里加人：run_once 开头读到的还是空表，
            # 只写"本轮解析结果"就会把这行人工条目抹掉。
            payload = json.loads(self.blacklist.read_text(encoding="utf-8"))
            payload.setdefault("owners", {})["human/midround"] = {"repos": 2, "reason": "后台期间人工添加"}
            self.blacklist.write_text(json.dumps(payload), encoding="utf-8")
            return mesh

        code, _out = self._run_round(patch_build=build_then_admin_adds)
        self.assertEqual(code, 0)
        owners = snap.load_blacklist(self.blacklist)
        self.assertIn("human/midround", owners, "采集期间后台新增的人工条目不能被本轮落盘覆盖")
        self.assertIn("mass", owners, "本轮新判定的噪声作者仍要写入")


class EcosystemSourceTest(unittest.TestCase):
    """共鸣清单的来源：后台管理副本优先，其次策展产物（与 Node 侧 readEcosystem 同规则）。

    管理副本放 data/admin/ 下是为了活过两次覆盖：部署脚本同步整个 tools/，
    策展工具复跑也会整体重写 tools/ecosystem.json。
    """

    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.managed = self.dir / "ecosystem.json"
        self.curated = self.dir / "curated.json"
        self.curated.write_text(
            json.dumps({"bases": [{"id": "curated/base", "label": "策展基座", "enabled": True, "verified": []}]}),
            encoding="utf-8",
        )

    def test_managed_copy_wins(self):
        self.managed.write_text(
            json.dumps({"bases": [{"id": "managed/base", "label": "后台基座", "enabled": True, "verified": []}]}),
            encoding="utf-8",
        )
        with mock.patch.object(admin_cfg, "MANAGED_ECOSYSTEM_FILE", self.managed):
            self.assertEqual(admin_cfg.ecosystem_path(), self.managed, "有后台副本就该用它")
            eco = build_mod.load_ecosystem()
            self.assertIn("managed/base", eco)
            self.assertNotIn("curated/base", eco, "有副本时不该再读策展产物")

    def test_broken_managed_copy_falls_back(self):
        self.managed.write_text("{ 坏掉的 json", encoding="utf-8")
        with mock.patch.object(admin_cfg, "MANAGED_ECOSYSTEM_FILE", self.managed):
            self.assertEqual(admin_cfg.ecosystem_path(), admin_cfg.ECOSYSTEM_FILE, "副本坏了要退回策展产物，不能拖垮采集")

    def test_explicit_path_never_gets_hijacked(self):
        self.managed.write_text(json.dumps({"bases": []}), encoding="utf-8")
        with mock.patch.object(admin_cfg, "MANAGED_ECOSYSTEM_FILE", self.managed):
            self.assertEqual(admin_cfg.ecosystem_path(self.curated), self.curated, "显式指定的清单不能被管理副本插队")
            eco = build_mod.load_ecosystem(self.curated)
            self.assertIn("curated/base", eco)


class NpmSearchTest(unittest.TestCase):
    """npm 反查发现：分页、预算、断点、容错。

    关键词池是混杂池（dsh 也可能是别的缩写），本模块只负责"如实抓到包 → 仓库"，
    精度过滤留给消费端复用市场索引那套判据 —— 所以这里断言的都是"抓没抓对、断没断对"。
    """

    class _Resp:
        def __init__(self, body: bytes):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    @staticmethod
    def _pkg(name: str, repo: str) -> dict:
        return {
            "package": {
                "name": name,
                "version": "1.0.0",
                "description": "d",
                "keywords": ["dsh"],
                "date": "2026-01-01T00:00:00.000Z",
                "links": {"repository": repo},
            }
        }

    @staticmethod
    def _opener(pages: dict, total: int):
        """按 URL 里的 from= 返回对应页；每页几条由数据决定（不依赖真实分页大小）。"""
        import urllib.parse as up

        def open_(req, timeout=25):
            query = up.parse_qs(up.urlparse(req.full_url).query)
            offset = int((query.get("from") or ["0"])[0])
            return NpmSearchTest._Resp(json.dumps({"total": total, "objects": pages.get(offset, [])}).encode())

        return open_

    @staticmethod
    def _fake_search_page(pages: dict, total: int):
        """给 collect.fetch_npm_search 用：sweep 调的是模块级 search_page(keyword, offset, **kw)。"""

        def page(keyword, offset, **_kw):
            return {"total": total, "objects": pages.get(offset, [])}

        return page

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    def test_repo_key_normalizes_github_urls(self):
        self.assertEqual(npms.repo_key("git+https://github.com/volcengine/OpenViking.git"), "volcengine/openviking")
        self.assertEqual(npms.repo_key({"url": "git@github.com:Owner/Repo.git"}), "owner/repo")
        self.assertEqual(npms.repo_key("ssh://git@github.com/a/b.git"), "a/b")
        self.assertEqual(npms.repo_key("git://github.com/a/b"), "a/b")
        self.assertEqual(npms.repo_key("https://github.com/a/b/"), "a/b")
        self.assertIsNone(npms.repo_key("https://gitlab.com/a/b"))
        self.assertIsNone(npms.repo_key(None))
        self.assertIsNone(npms.repo_key(""))

    def test_slim_object_keeps_repo_and_skips_others(self):
        rec = npms.slim_object(self._pkg("@openviking/dsh-memory-plugin", "git+https://github.com/volcengine/OpenViking.git"))
        self.assertEqual(rec["name"], "@openviking/dsh-memory-plugin")
        self.assertEqual(rec["repoKey"], "volcengine/openviking")
        self.assertEqual(rec["repoUrl"], "git+https://github.com/volcengine/OpenViking.git")
        self.assertIsNone(npms.slim_object({"package": {"name": "x", "links": {}}}), "没有仓库就跳过，绝不猜")
        self.assertIsNone(npms.slim_object({"package": {"name": "", "links": {"repository": "https://github.com/a/b"}}}))
        self.assertIsNone(npms.slim_object({}))

    def test_sweep_respects_budget_and_resumes_from_cursor(self):
        pages = {
            0: [self._pkg("a", "https://github.com/o/a"), self._pkg("b", "https://github.com/o/b")],
            2: [self._pkg("c", "https://github.com/o/c"), self._pkg("d", "https://github.com/o/d")],
        }
        payload = npms.empty_payload(["kw"])
        stats = npms.sweep(payload, budget=3, opener=self._opener(pages, 100), sleep=lambda _s: None)
        self.assertEqual(stats["pages"], 2, "预算 3 条、每页 2 条 → 取两页（允许超出一页）")
        self.assertEqual(stats["items"], 4)
        self.assertEqual(payload["cursor"]["kw"], 4, "断点必须落在游标上")
        self.assertFalse(payload["done"]["kw"], "没扫完不许标 done")
        self.assertEqual(sorted(payload["packages"]), ["a", "b", "c", "d"])
        self.assertEqual(stats["added"], 4)

        pages[4] = [self._pkg("e", "https://github.com/o/e")]
        stats2 = npms.sweep(payload, budget=10, opener=self._opener(pages, 5), sleep=lambda _s: None)
        self.assertEqual(payload["cursor"]["kw"], 5)
        self.assertTrue(payload["done"]["kw"], "游标追平 total 才算扫完")
        self.assertEqual(stats2["added"], 1)
        self.assertEqual(payload["count"], 5)

    def test_sweep_dedupes_and_keeps_first_seen(self):
        pages = {0: [self._pkg("a", "https://github.com/o/a")]}
        payload = npms.empty_payload(["kw1", "kw2"])
        npms.sweep(payload, budget=10, opener=self._opener(pages, 1), sleep=lambda _s: None)
        self.assertEqual(payload["count"], 1, "两个关键词抓到同一个包只算一个")
        first = payload["packages"]["a"]["firstSeenAt"]
        payload["cursor"]["kw2"] = 0
        payload["done"]["kw2"] = False
        stats = npms.sweep(payload, budget=10, keywords=["kw2"], opener=self._opener(pages, 1), sleep=lambda _s: None)
        self.assertEqual(stats["added"], 0, "见过的包不再计入新增")
        self.assertEqual(payload["packages"]["a"]["firstSeenAt"], first, "firstSeenAt 不能被后来的抓取覆盖")

    def test_sweep_settles_when_pages_stop_adding_new_packages(self):
        # 深翻页会重复甚至回卷：整页都是见过的包，连续两页就结算，别继续烧请求
        pages = {0: [self._pkg("a", "https://github.com/o/a")], 1: [self._pkg("a", "https://github.com/o/a")], 2: [self._pkg("a", "https://github.com/o/a")]}
        payload = npms.empty_payload(["kw"])
        stats = npms.sweep(payload, budget=5000, opener=self._opener(pages, 100), sleep=lambda _s: None)
        self.assertEqual(stats["pages"], 3, "第 1 页有新增、后两页零新增后结算")
        self.assertTrue(payload["done"]["kw"], "结算后必须标 done")
        self.assertEqual(payload["settled"]["kw"], 3, "结算位置要记下来（溯源用）")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(stats["added"], 1)

    def test_sweep_never_raises_and_keeps_cache_on_network_error(self):
        def boom(req, timeout=25):
            raise urllib.error.URLError("断网")

        payload = npms.empty_payload(["kw"])
        stats = npms.sweep(payload, budget=5000, opener=boom, sleep=lambda _s: None)
        self.assertIsNotNone(stats["error"], "失败要如实记一笔")
        self.assertEqual(stats["pages"], 0)
        self.assertEqual(payload["packages"], {}, "失败不写脏数据")
        self.assertEqual(payload["cursor"]["kw"], 0, "失败不能推进游标")
        self.assertFalse(payload["done"]["kw"], "失败不能标扫完")

    def test_cache_roundtrip_and_corruption(self):
        path = TMP / "npm-search.json"
        payload = npms.empty_payload()
        payload["packages"]["a"] = {"name": "a", "repoKey": "o/a"}
        self.assertGreater(npms.save_cache(payload, path), 0)
        loaded = npms.load_cache(path)
        self.assertEqual(loaded["packages"]["a"]["repoKey"], "o/a")
        self.assertEqual(loaded["count"], 1)
        self.assertEqual(loaded["keywords"], npms.DEFAULT_KEYWORDS)
        path.write_text("{坏掉的 json", encoding="utf-8")
        self.assertEqual(npms.load_cache(path)["packages"], {}, "坏文件当空表，绝不抛")
        self.assertEqual(npms.load_cache(TMP / "missing.json")["count"], 0)

    def test_collect_step_offline_guard_and_persist(self):
        import collect

        offline = argparse.Namespace(npm_search_budget=10, dry_run=False, from_raw=True, from_store=False)
        self.assertFalse(collect.fetch_npm_search(offline, lambda *a: None)["enabled"], "--from-raw 绝不联网")
        zero = argparse.Namespace(npm_search_budget=0, dry_run=False, from_raw=False, from_store=False)
        self.assertFalse(collect.fetch_npm_search(zero, lambda *a: None)["enabled"], "预算 0 = 关闭")

        path = TMP / "npm-search.json"
        pages = {0: [self._pkg("@openviking/dsh-memory-plugin", "git+https://github.com/volcengine/OpenViking.git")]}
        args = argparse.Namespace(npm_search_budget=10, dry_run=False, from_raw=False, from_store=False)
        with mock.patch.object(collect, "NPM_SEARCH_CACHE", path), mock.patch.object(
            collect.npm_search, "search_page", self._fake_search_page(pages, 1)
        ):
            summary = collect.fetch_npm_search(args, lambda *a: None)
        self.assertTrue(summary["enabled"])
        self.assertEqual(summary["added"], 1)
        # 默认三个关键词各翻一页（同一个包在三个关键词下都被抓到，只算一次新增）
        self.assertEqual(summary["pages"], len(npms.DEFAULT_KEYWORDS))
        self.assertEqual(summary["packages"], 1)
        self.assertTrue(all(summary["done"].values()), "三词都扫完了")
        self.assertIn("settled", summary, "结算位置要能进 last-crawl.json 溯源")
        self.assertTrue(path.exists(), "必须落盘到指定缓存路径")
        saved = npms.load_cache(path)
        self.assertEqual(saved["packages"]["@openviking/dsh-memory-plugin"]["repoKey"], "volcengine/openviking")


class NpmPackagesTest(unittest.TestCase):
    """子目录包：候选挑选（谁该查、谁不该查）与采集步落盘。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _ago(hours: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - hours * 3600))

    def test_due_for_refresh_states(self):
        now = time.time()
        self.assertTrue(npmp.due_for_refresh(None, now), "没查过的要查")
        self.assertFalse(npmp.due_for_refresh({"status": "ok", "at": self._ago(1)}, now), "刚查过的不重查")
        self.assertTrue(npmp.due_for_refresh({"status": "ok", "at": self._ago(48)}, now), "过了刷新窗口要重查")
        self.assertFalse(npmp.due_for_refresh({"status": "unknown", "at": self._ago(999)}, now), "npm 确认 404 是终态，不再试")
        self.assertTrue(npmp.due_for_refresh({"status": "error", "at": self._ago(100)}, now), "暂时失败要重试")
        self.assertFalse(npmp.due_for_refresh({"status": "error", "at": self._ago(1)}, now), "刚失败过先别急着重试")

    def test_pick_candidates_filters_and_sorts(self):
        search = {
            "packages": {
                "root-pkg": {"repoKey": "o/a"},
                "extra-new": {"repoKey": "o/a"},
                "outside": {"repoKey": "o/none"},
                "fresh": {"repoKey": "o/b"},
                "retry": {"repoKey": "o/c"},
                "gone": {"repoKey": "o/d"},
                "in-archived": {"repoKey": "o/arch"},
            }
        }
        downloads = {"repos": {"o/a": {"package": "root-pkg", "status": "ok"}}}
        payload = {
            "packages": {
                "fresh": {"status": "ok", "at": self._ago(1)},
                "retry": {"status": "error", "at": self._ago(100)},
                "gone": {"status": "unknown", "at": self._ago(999)},
            }
        }
        nodes = [
            {"id": "o/a", "stars": 10, "archived": False},
            {"id": "o/b", "stars": 5, "archived": False},
            {"id": "o/c", "stars": 30, "archived": False},
            {"id": "o/d", "stars": 50, "archived": False},
            {"id": "o/arch", "stars": 99, "archived": True},
        ]
        picked = npmp.pick_candidates(payload, search, downloads, nodes, limit=10)
        self.assertEqual([p["package"] for p in picked], ["retry", "extra-new"], "根包/图外/未到期/终态/归档 都不该进")
        self.assertEqual(picked[0]["repoId"], "o/c", "按星标排序，大项目优先")
        self.assertEqual(npmp.pick_candidates(payload, search, downloads, nodes, limit=1), picked[:1], "预算要生效")

    def test_collect_step_offline_guard_and_persist(self):
        import collect

        offline = argparse.Namespace(npm_extra_budget=5, dry_run=False, from_raw=True, from_store=False)
        self.assertFalse(collect.fetch_npm_packages(offline, {"nodes": []}, lambda *a: None)["enabled"])
        zero = argparse.Namespace(npm_extra_budget=0, dry_run=False, from_raw=False, from_store=False)
        self.assertFalse(collect.fetch_npm_packages(zero, {"nodes": []}, lambda *a: None)["enabled"])

        search_path, downloads_path, packages_path = TMP / "npm-search.json", TMP / "npm-downloads.json", TMP / "npm-packages.json"
        search_path.write_text(
            json.dumps({"packages": {"@openviking/dsh-memory-plugin": {"repoKey": "volcengine/openviking"}}}), encoding="utf-8"
        )
        downloads_path.write_text(json.dumps({"repos": {}}), encoding="utf-8")
        mesh = {"nodes": [{"id": "volcengine/OpenViking", "stars": 40186, "archived": False}]}
        args = argparse.Namespace(npm_extra_budget=5, dry_run=False, from_raw=False, from_store=False)
        hit = {"status": "ok", "downloads": 42, "window": {"start": "2026-10-06", "end": "2026-10-12"}, "days": [{"day": "2026-10-06", "downloads": 42}]}
        with mock.patch.object(collect, "NPM_PACKAGES_CACHE", packages_path), mock.patch.object(
            collect, "NPM_SEARCH_CACHE", search_path
        ), mock.patch.object(collect, "NPM_DOWNLOADS_CACHE", downloads_path), mock.patch.object(
            collect.npm, "fetch_npm_downloads", lambda pkg, sleep=None: dict(hit, package=pkg)
        ):
            summary = collect.fetch_npm_packages(args, mesh, lambda *a: None)
        self.assertEqual(summary["fetched"], 1)
        self.assertEqual(summary["failed"], 0)
        entry = npmp.load(packages_path)["packages"]["@openviking/dsh-memory-plugin"]
        self.assertEqual(entry["downloads"], 42, "下载量按包名落盘")
        self.assertEqual(entry["repoId"], "volcengine/OpenViking", "要记住它属于哪个节点")
        self.assertEqual(sum(entry["days"][i]["downloads"] for i in range(len(entry["days"]))), 42, "逐日求和 == 总量")


class RenameIdentityTest(unittest.TestCase):
    """改名身份归一（v0.5.4）：采集器的两份台账都要在改名当轮接续，别名表要自动维护。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(TMP, ignore_errors=True)

    @staticmethod
    def _mesh(at: str, nodes: list[dict]) -> dict:
        return {"meta": {"generatedAt": at}, "nodes": nodes}

    def test_star_daily_rename_carries_old_baseline_instead_of_baselining(self):
        path = TMP / "star-daily.json"
        snap.update_star_daily(self._mesh("2026-10-07T00:30:00Z", [{"id": "u/old", "stars": 100}, {"id": "u/keep", "stars": 50}]), path)
        out = snap.update_star_daily(
            self._mesh("2026-10-07T02:30:00Z", [
                {"id": "u/keep", "stars": 50},
                {"id": "u/new", "stars": 130, "renamedFrom": ["u/old"]},
            ]),
            path,
        )
        self.assertEqual(out["days"]["2026-10-07"]["u/new"], 30, "改名当轮必须用旧基线接续（130-100），不能被当成首见丢掉")
        self.assertEqual(out["lastRound"]["renamed"], 1)
        self.assertNotIn("u/old", out["seen"], "旧名基线要退出，否则新旧并存会重复算")
        self.assertNotIn("u/old", out["seenCarry"])
        self.assertEqual(out["seen"]["u/new"], 130)

        out2 = snap.update_star_daily(
            self._mesh("2026-10-07T03:30:00Z", [
                {"id": "u/keep", "stars": 50},
                {"id": "u/new", "stars": 140, "renamedFrom": ["u/old"]},
            ]),
            path,
        )
        self.assertEqual(out2["days"]["2026-10-07"]["u/new"], 40, "改名后按现名基线正常累加，不能重复计")

    def test_star_daily_rename_chain_and_alive_old_name(self):
        """链式 A→B→C 要接上；旧名仍是活节点（被别的仓库占用）时不许归。"""
        path = TMP / "star-daily.json"
        snap.update_star_daily(
            self._mesh("2026-10-07T00:30:00Z", [
                {"id": "c/orig", "stars": 10},
                {"id": "c/mid", "stars": 20},
                {"id": "live/old", "stars": 900},
            ]),
            path,
        )
        # 第二次改名：c/orig → c/mid（历史 renamedFrom 开始累积）
        snap.update_star_daily(
            self._mesh("2026-10-07T01:30:00Z", [
                {"id": "c/mid", "stars": 20, "renamedFrom": ["c/orig"]},
                {"id": "live/old", "stars": 920},
            ]),
            path,
        )
        out = snap.update_star_daily(
            self._mesh("2026-10-07T02:30:00Z", [
                {"id": "c/new", "stars": 55, "renamedFrom": ["c/orig", "c/mid"]},
                {"id": "live/old", "stars": 950},
                {"id": "live/new", "stars": 30, "renamedFrom": ["live/old"]},
            ]),
            path,
        )
        self.assertEqual(out["days"]["2026-10-07"]["c/new"], 35, "链式改名要接到最近一次已计数观测（20 → 55）")
        self.assertEqual(out["days"]["2026-10-07"]["live/old"], 50, "旧名仍是活节点时，它的变化留在自己名下")
        self.assertNotIn("live/new", out["days"]["2026-10-07"], "旧名被占用时不许把它的账归到新名")
        self.assertEqual(out["lastRound"]["renamed"], 1, "只有链式那一对算改名接续")

    def test_update_log_rename_keeps_push_continuity(self):
        path = TMP / "update-log.json"
        snap.update_update_log(self._mesh("2026-10-07T00:30:00Z", [{"id": "u/old", "pushedAt": "2026-10-06T00:00:00Z"}]), path)
        out = snap.update_update_log(
            self._mesh("2026-10-07T01:30:00Z", [{"id": "u/new", "pushedAt": "2026-10-07T00:10:00Z", "renamedFrom": ["u/old"]}]),
            path,
        )
        self.assertEqual(out["days"]["2026-10-07"]["u/new"], 1, "改名当轮旧名的 pushedAt 要接着比，不能被首见重置")
        self.assertEqual(out["lastRound"]["renamed"], 1)
        self.assertNotIn("u/old", out["seen"], "旧名基线要退出")

    def test_store_save_auto_maintains_aliases_json(self):
        """采集器 save() 后，aliases.json 要自动从 renamedFrom 派生，不再依赖手工跑 dedupe-renames。"""
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "segments.json"
            repos = Path(tmp) / "repos.json"
            store = SegmentStore(state, repos)
            store.merge([{"id": "u/old", "githubId": 42, "owner": "u", "name": "old", "topics": ["dsh-plugin"]}])
            store.merge([{"id": "u/new", "githubId": 42, "owner": "u", "name": "new", "topics": ["dsh-plugin"]}])
            store.save()
            aliases = json.loads((Path(tmp) / "aliases.json").read_text(encoding="utf-8"))
            self.assertEqual(aliases["aliases"].get("u/old"), "u/new", "改名要自动写进别名表")

    def test_store_alias_does_not_merge_repo_reusing_old_name(self):
        """旧名被另一个仓库占用（githubId 不同）时，加载/合并都不许把两家并成一家。"""
        import tempfile

        from dsh_mesh.segments import SegmentStore

        with tempfile.TemporaryDirectory() as tmp:
            repos = Path(tmp) / "repos.json"
            repos.write_text(
                json.dumps({
                    "repos": {
                        "u/old": {"id": "u/old", "githubId": 1, "owner": "u", "name": "old"},
                        "u/new": {"id": "u/new", "githubId": 2, "owner": "u", "name": "new"},
                    }
                }),
                encoding="utf-8",
            )
            (Path(tmp) / "aliases.json").write_text(json.dumps({"aliases": {"u/old": "u/new"}}), encoding="utf-8")
            store = SegmentStore(Path(tmp) / "segments.json", repos)
            self.assertIn("u/old", store.repos, "名字被复用时不许把活仓库并走")
            self.assertIn("u/new", store.repos)
            # 搜索索引延迟返回旧名（原仓库 githubId=1）：不许把它并进占用这个名字的 u/new(githubId=2)
            store.merge([{"id": "u/old", "githubId": 1, "owner": "u", "name": "old", "topics": ["dsh-plugin"]}])
            self.assertIn("u/old", store.repos)
            self.assertEqual(store.repos["u/old"]["githubId"], 1, "旧名记录要留在原地，不能被别名并走")
            self.assertEqual(store.repos["u/new"]["githubId"], 2, "占用旧名的新仓库也不能被覆盖")


if __name__ == "__main__":
    unittest.main(verbosity=2)

