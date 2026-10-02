import json, collections
r = json.load(open("/opt/dsh-plugin-mesh/data/cache/repos.json"))
repos = r["repos"]
print("索引总数:", len(repos))
sample = next(iter(repos.values()))
print("字段:", sorted(sample.keys()))
by_month = collections.Counter()
for v in repos.values():
    created = v.get("createdAt") or ""
    by_month[created[:7]] += 1
print("按创建月份分布（前 8）:")
for month, count in sorted(by_month.items(), reverse=True)[:8]:
    print("   %s → %d" % (month or "(空)", count))
