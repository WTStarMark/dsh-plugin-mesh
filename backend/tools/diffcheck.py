"""对照实验：随机取几个日段，看抓回来的记录有多少已在累积索引里。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "/opt/dsh-plugin-mesh/backend")
from dsh_mesh.build import pick_repo
from dsh_mesh.github import GitHubClient, load_token

repos = json.load(open("/opt/dsh-plugin-mesh/data/cache/repos.json"))["repos"]
known = set(repos)
print("索引现有:", len(known))
print("repos.json 修改时间:", Path("/opt/dsh-plugin-mesh/data/cache/repos.json").stat().st_mtime)
print()

client = GitHubClient(token=load_token())
for query in [
    "topic:dsh-plugin stars:1..9 created:2026-08-20",
    "topic:dsh-plugin stars:0 created:2026-08-14",
    "topic:dsh stars:1..9 created:2026-08-16..2026-08-31",
]:
    payload = client.search(query, page=1)
    items = [pick_repo(i) for i in payload.get("items") or []]
    ids = {i["id"] for i in items}
    new = ids - known
    print("%-52s 返回 %3d | 已索引 %3d | 新增 %3d" % (query, len(ids), len(ids & known), len(new)))
    for rid in list(new)[:3]:
        print("     新: " + str(rid))
