import json
s = json.load(open("/opt/dsh-plugin-mesh/data/cache/segments.json"))
r = json.load(open("/opt/dsh-plugin-mesh/data/cache/repos.json"))
segs = s["segments"]
trunc = s.get("truncated", [])
print("分段总数:", len(segs), "| 索引仓库:", r["count"])
print("截断段数:", len(trunc), "| 因截断少抓的条数合计:", sum(t["total"] - t["fetched"] for t in trunc))
print()
print("各标签：已抓条数 vs 接口报告总数")
totals = {}
for seg in segs.values():
    if seg.get("state") == "done" and seg.get("total") is not None:
        t = seg["topic"]
        totals.setdefault(t, [0, 0])
        totals[t][0] += seg["total"]
        totals[t][1] += seg.get("count", 0)
for topic, (total, got) in sorted(totals.items()):
    print("  %-20s 报告 %6d | 实抓 %6d | 缺 %d" % (topic, total, got, max(0, total - got)))
print()
print("截断最多的 6 段：")
for t in sorted(trunc, key=lambda x: -(x["total"] - x["fetched"]))[:6]:
    print("  %-58s 报告 %5d 抓了 %4d 缺 %4d" % (t["key"], t["total"], t["fetched"], t["total"] - t["fetched"]))
