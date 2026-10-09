#!/usr/bin/env python3
"""一致性校验：用 Python 采集器复算前端 JS 版的产物，逐项比对。

存在的意义：采集器要长期接管数据生产，必须证明它与既有 JS 管线结果一致，
否则前端会在无人察觉的情况下换到一份"看着差不多、其实不一致"的数据。

用法：python3 backend/verify_parity.py [--js data/mesh.json] [--raw data/sample-raw.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dsh_mesh.build import build_mesh
from dsh_mesh.config import SAMPLE_MESH, SAMPLE_RAW


def edge_key(edge: dict) -> str:
    return "{}|{}|{}".format(edge["type"], edge["source"], edge["target"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Python 采集器与 JS 管线的一致性校验")
    parser.add_argument("--js", type=Path, default=SAMPLE_MESH, help="JS 管线产出的参照契约（冻结文件）")
    parser.add_argument("--raw", type=Path, default=SAMPLE_RAW)
    args = parser.parse_args(argv)

    js = json.loads(args.js.read_text(encoding="utf-8"))
    raw = json.loads(args.raw.read_text(encoding="utf-8"))
    # 冻结参照物（JS 管线 --from-raw）不经过改名别名表，这里同样不读盘
    py = build_mesh(raw["repos"], {}, aliases={})

    problems: list[str] = []

    js_ids = {n["id"] for n in js["nodes"]}
    py_ids = {n["id"] for n in py["nodes"]}
    if js_ids != py_ids:
        only_js = sorted(js_ids - py_ids)[:5]
        only_py = sorted(py_ids - js_ids)[:5]
        problems.append(f"节点集合不一致：仅 JS 有 {only_js}；仅 Python 有 {only_py}（JS {len(js_ids)} / PY {len(py_ids)}）")

    js_cat = {n["id"]: n.get("category") for n in js["nodes"]}
    py_cat = {n["id"]: n.get("category") for n in py["nodes"]}
    mismatched = [nid for nid in js_cat.keys() & py_cat.keys() if js_cat[nid] != py_cat[nid]]
    if mismatched:
        sample = [(nid, js_cat[nid], py_cat[nid]) for nid in mismatched[:5]]
        problems.append(f"功能分类不一致 {len(mismatched)} 个，例如 {sample}")

    js_edges = {edge_key(e) for e in js["edges"]}
    py_edges = {edge_key(e) for e in py["edges"]}
    if js_edges != py_edges:
        problems.append(
            "连线集合不一致：仅 JS 有 {} 条，仅 Python 有 {} 条，例如 仅JS={} 仅PY={}".format(
                len(js_edges - py_edges),
                len(py_edges - js_edges),
                sorted(js_edges - py_edges)[:3],
                sorted(py_edges - js_edges)[:3],
            )
        )

    print(f"JS  : {len(js['nodes'])} 节点 / {len(js['edges'])} 连线")
    print(f"PY  : {len(py['nodes'])} 节点 / {len(py['edges'])} 连线")
    if problems:
        print("\n发现不一致：")
        for p in problems:
            print("  - " + p)
        return 1
    print("\n一致：节点集合、功能分类、连线集合逐项相同 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
