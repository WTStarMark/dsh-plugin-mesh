#!/usr/bin/env python3
"""诊断：确认 .env 里的令牌是否真的生效。

只打印配额数字，绝不打印令牌内容。
用法：python3 backend/check_token.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dsh_mesh.github import load_token  # noqa: E402


def main() -> int:
    token = load_token()
    print("令牌读取:", "成功" if token else "未找到")
    headers = {"User-Agent": "dsh-plugin-mesh/0.1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com/rate_limit", headers=headers)
    data = json.load(urllib.request.urlopen(request, timeout=20))
    search = data["resources"]["search"]
    core = data["resources"]["core"]
    print("search 上限 %d / 剩余 %d" % (search["limit"], search["remaining"]))
    print("core   上限 %d / 剩余 %d" % (core["limit"], core["remaining"]))
    print("判定:", "令牌生效（30 次/分档）" if search["limit"] >= 30 else "未生效（10 次/分档）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
