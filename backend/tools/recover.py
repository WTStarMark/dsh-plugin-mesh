"""恢复：把"队列里标记完成、但抓到的数据没落盘"的段重新排回待抓。

背景：pm2 的 --watch 与采集器抢参数，导致每次落盘都被 SIGINT 打断，
save() 里先写队列后写数据，于是队列说"抓完了"而 repos.json 没更新。
离线判断依据：段的 fetchedAt 晚于 repos.json 最后一次成功落盘时间。
"""

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/opt/dsh-plugin-mesh/backend")
from dsh_mesh.config import REPO_CACHE, SEGMENT_STATE  # noqa: E402


def main() -> int:
    mtime = os.path.getmtime(REPO_CACHE)
    state = json.load(open(SEGMENT_STATE, encoding="utf-8"))
    reset = 0
    for segment in state["segments"].values():
        if segment.get("state") != "done" or not segment.get("fetchedAt"):
            continue
        stamp = datetime.strptime(segment["fetchedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        if stamp >= mtime - 90:  # 晚于最后一次成功落盘 → 数据可能丢了
            segment.update({"state": "pending", "fetchedAt": None, "count": 0})
            reset += 1
    print("repos.json 最后成功落盘:", datetime.fromtimestamp(mtime, timezone.utc).strftime("%H:%M:%S UTC"))
    print("重新排队的分段:", reset)
    with open(SEGMENT_STATE, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
