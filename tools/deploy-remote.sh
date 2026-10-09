#!/usr/bin/env bash
# 部署到远端（104.129.51.126）：只同步代码，远端数据一律保留。
#
# 用法：DSH_SSH_PASS='<密码>' bash tools/deploy-remote.sh [--dry-run]
#
# 远端实情（已探明）：没有 rsync；node/pm2 不在非交互 PATH，位于 /opt/dsh-runtime/node/bin
# 硬约束：data/、.env、.git 一律不同步；部署前后远端 mesh.json 节点数必须完全一致。

set -euo pipefail

HOST="root@104.129.51.126"
REMOTE_DIR="/opt/dsh-plugin-mesh"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="/opt/dsh-runtime/node/bin/node"
PM2BIN="/opt/dsh-runtime/node/bin"
DRY="${1:-}"

export SSH_ASKPASS="$LOCAL_DIR/tools/.askpass.sh"
export SSH_ASKPASS_REQUIRE=force
ssh_run() { setsid -w ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 "$HOST" "$@"; }

[ -n "${DSH_SSH_PASS:-}" ] || { echo "缺少 DSH_SSH_PASS" >&2; exit 2; }

# 同步范围：代码 + docs + 随代码走的夹具；运行时产物与本地草稿一律不同步。
# data/ 只同步三个 tracked 夹具（sample-raw.json / sample-mesh.json / dsh-tokens.json），
# 其余全部排除 —— 远端靠自己的采集器与缓存活着，覆盖了就真丢数据。
EXCLUDES=(--exclude=./.git --exclude=./node_modules --exclude=./dist
          --exclude=./.env --exclude=./.env.local --exclude=./.push-github.mjs
          --exclude='./.remote-*.sh' --exclude='./.verify*' --exclude=./tools/.askpass.sh
          --exclude=./tools/.git-askpass.sh
          --exclude=./.tmp --exclude=./.commit-msg.txt --exclude=./docs/frontend-design.md
          --exclude='./.gh-*.mjs'
          --exclude=./data/mesh.json --exclude=./data/mesh-core.json
          --exclude=./data/mesh-core.bin --exclude=./data/mesh-core.head.bin
          --exclude=./data/last-crawl.json --exclude=./data/details
          --exclude=./data/snapshots --exclude=./data/cache --exclude=./data/stats.json
          --exclude=./data/crawl.log --exclude=./data/noise-blacklist.json
          --exclude=./data/renames.json --exclude='./data/*.bak-*.json'
          --exclude='./data/*.stale-*' --exclude='./data/*.bak-*')

echo "=== 0. 远端基线 ==="
ssh_run "cd $REMOTE_DIR && python3 -c \"import json;d=json.load(open('data/mesh.json'));print('  节点',len(d['nodes']),'| 连线',len(d['edges']))\""
BEFORE=$(ssh_run "cd $REMOTE_DIR && python3 -c \"import json;print(len(json.load(open('data/mesh.json'))['nodes']))\"" | tr -d '[:space:]')
echo "  基线节点数: $BEFORE"

echo
echo "=== 1. 将同步的代码文件 ==="
echo "  文件数: $(tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | tar tzf - | wc -l)"
if [ "$DRY" = "--dry-run" ]; then
  echo "  抽样:"
  tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | tar tzf - | grep -E '(src|tools|backend)/' | head -12 | sed 's/^/    /'
  echo "  （dry-run，未传输）"
  exit 0
fi

echo
echo "=== 2. 传输（tar 流，远端解压；不含 data/）==="
tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | ssh_run "tar xzf - -C $REMOTE_DIR"
echo "  传输完成"

echo
echo "=== 3. 用【远端自己的数据】重算预计算产物 ==="
ssh_run "cd $REMOTE_DIR && $NODE tools/precompute-layout.mjs 2>&1 | tail -6" | sed 's/^/  /'

echo
echo "=== 4. 重启 pm2（只重启本项目的两个进程，不动同机其它 pm2 应用）==="
ssh_run "export PATH=$PM2BIN:\$PATH; cd $REMOTE_DIR
for n in dsh-plugin-mesh dsh-mesh-collector; do
  if pm2 describe \"\$n\" >/dev/null 2>&1; then
    pm2 restart \"\$n\" --update-env >/dev/null 2>&1 && echo \"  已重启 \$n\";
  else
    echo \"  跳过 \$n（远端没有这个进程）\";
  fi
done
pm2 list --no-color | sed -n '1,9p'" | sed 's/^/  /'

echo
echo "=== 5. 远端本机验证 ==="
ssh_run "for p in / /api /api/health /api/categories '/api/repos?limit=2' /api/card/WTStarMark/dsh-myskin.svg /card/WTStarMark/dsh-myskin; do printf '  %-42s %s\\n' \"\$p\" \"\$(curl -sS -o /dev/null -w '%{http_code}' \"http://127.0.0.1\$p\")\"; done" | sed 's/^/  /'
echo "  站点自报:"; ssh_run "curl -sS http://127.0.0.1/api/health" | sed 's/^/    /'
echo "  页面版本:"; ssh_run "curl -sS http://127.0.0.1/ | grep -o '插件生态扇区图 · v[0-9.]*'" | sed 's/^/    /'

echo
echo "=== 6. 数据保留校验 ==="
AFTER=$(ssh_run "cd $REMOTE_DIR && python3 -c \"import json;print(len(json.load(open('data/mesh.json'))['nodes']))\"" | tr -d '[:space:]')
echo "  部署前 $BEFORE → 部署后 $AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "  ✗ 节点数变了！请立即人工检查" >&2; exit 1; }
echo "  ✓ 远端数据未被改动"
