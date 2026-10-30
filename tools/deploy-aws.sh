#!/usr/bin/env bash
# 部署到 AWS 主节点（13.239.177.223）：只同步代码，远端数据一律保留。
#
# 与 tools/deploy-remote.sh（104 镜像）同模式。差别：13 是 ec2-user + 密钥登录 + sudo 落盘/pm2，
# 且没有 rsync、node/pm2 不在非交互 PATH（位于 /opt/dsh-runtime/node/bin）。
#
# 用法：
#   MOC_KEY=/path/to/MOC.pem bash tools/deploy-aws.sh [--dry-run] [--serve-only]
#   --serve-only  只重启查询服务（dsh-plugin-mesh），不动采集器（dsh-mesh-collector）
# 硬约束：data/、.env*、.git 一律不同步；部署前后远端 mesh.json 节点数必须完全一致。
set -euo pipefail

HOST="ec2-user@13.239.177.223"
REMOTE_DIR="/opt/dsh-plugin-mesh"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="/opt/dsh-runtime/node/bin/node"
PM2BIN="/opt/dsh-runtime/node/bin"
KEY="${MOC_KEY:-/root/.ssh/MOC.pem}"
DRY=""
SERVE_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY="--dry-run" ;;
    --serve-only) SERVE_ONLY="1" ;;
  esac
done

[ -f "$KEY" ] || { echo "缺少密钥：$KEY（用 MOC_KEY 指定）" >&2; exit 2; }

ssh_run() {
  ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$HOST" "$@"
}
sudo_run() {
  ssh_run "sudo -n bash -c $(printf '%q' "$1")"
}

EXCLUDES=(--exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./.bak
          --exclude=./.env --exclude=./.env.local --exclude=./.env.bak-*
          --exclude=./.push-github.mjs --exclude=./.git-token
          --exclude='./.remote-*.sh' --exclude='./.verify*' --exclude=./tools/.askpass.sh
          --exclude=./tools/.git-askpass.sh
          --exclude=./.tmp --exclude=./.commit-msg.txt --exclude=./docs/frontend-design.md
          --exclude='./.gh-*.mjs' --exclude='./.last-*'
          --exclude=./data)

echo "=== 0. 远端基线 ==="
BEFORE=$(ssh_run "cd $REMOTE_DIR && python3 -c \"import json;print(len(json.load(open('data/mesh.json'))['nodes']))\"" | tr -d '[:space:]')
REMOTE_VER=$(ssh_run "cd $REMOTE_DIR && python3 -c 'import json;print(json.load(open(\"package.json\"))[\"version\"])'")
echo "  基线节点数: $BEFORE | 远端版本: $REMOTE_VER"

echo
echo "=== 1. 将同步的代码文件 ==="
echo "  文件数: $(tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | tar tzf - | wc -l)"
if [ "$DRY" = "--dry-run" ]; then
  tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | tar tzf - | grep -E '(src|tools|backend)/' | head -12 | sed 's/^/    /'
  echo "  （dry-run，未传输）"
  exit 0
fi

echo
echo "=== 2. 备份远端代码（不含 data/.env） ==="
STAMP=$(date -u +%Y%m%dT%H%M%S)
sudo_run "tar czf /opt/dsh-plugin-mesh.code-bak-$STAMP.tgz -C $REMOTE_DIR --warning=no-file-changed --exclude=./data --exclude=./.env --exclude=./.env.bak-* --exclude=./.git-token . >/dev/null 2>&1 || true"
echo "  /opt/dsh-plugin-mesh.code-bak-$STAMP.tgz"

echo
echo "=== 3. 传输（tar 流，远端 sudo 解压；不含 data/） ==="
tar czf - "${EXCLUDES[@]}" -C "$LOCAL_DIR" . | ssh_run "sudo -n tar xzf - -C $REMOTE_DIR"
echo "  传输完成"

echo
echo "=== 4. 预计算产物（默认跳过：采集器每轮结束会自己跑 precompute，13 内存紧，部署时不抢内存） ==="
if [ "${PRECOMPUTE:-0}" = "1" ]; then
  sudo_run "cd $REMOTE_DIR && $NODE tools/precompute-layout.mjs 2>&1 | tail -4" | sed 's/^/  /'
else
  echo "  跳过 precompute（下一轮采集结束会自动重建；需要立刻重建就 PRECOMPUTE=1）"
fi

echo
echo "=== 5. 重启 pm2（只动本项目的进程） ==="
if [ -n "$SERVE_ONLY" ]; then
  NAMES=(dsh-plugin-mesh)
else
  NAMES=(dsh-plugin-mesh dsh-mesh-collector)
fi
for n in "${NAMES[@]}"; do
  sudo_run "export PATH=$PM2BIN:\$PATH; pm2 describe $n >/dev/null 2>&1 && pm2 restart $n --update-env >/dev/null 2>&1 && echo '  已重启 $n' || echo '  跳过 $n（不存在）'"
done
sudo_run "export PATH=$PM2BIN:\$PATH; pm2 list --no-color | sed -n '4,8p'" | sed 's/^/  /'

echo
echo "=== 6. 远端本机验证 ==="
ssh_run "for p in / /api /api/health /api/categories '/api/repos?limit=2' /api/card/WTStarMark/dsh-myskin.svg; do printf '  %-42s %s\\n' \"\$p\" \"\$(curl -sS -o /dev/null -w '%{http_code}' \"http://127.0.0.1:8080\$p\")\"; done" | sed 's/^/  /'
echo "  站点自报:"; ssh_run "curl -sS http://127.0.0.1:8080/api/health" | python3 -c "import sys,json;d=json.load(sys.stdin);print('   ',json.dumps({k:d.get(k) for k in ('ok','version','nodes','generatedAt')},ensure_ascii=False));print('    identity:',json.dumps(d.get('identity'),ensure_ascii=False))" | sed 's/^/  /'

echo
echo "=== 7. 数据保留校验 ==="
AFTER=$(ssh_run "cd $REMOTE_DIR && python3 -c \"import json;print(len(json.load(open('data/mesh.json'))['nodes']))\"" | tr -d '[:space:]')
echo "  部署前 $BEFORE → 部署后 $AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "  ✗ 节点数变了！请立即人工检查" >&2; exit 1; }
NEW_VER=$(ssh_run "cd $REMOTE_DIR && python3 -c \"import json;print(json.load(open('package.json'))['version'])\"")
echo "  远端版本: $REMOTE_VER → $NEW_VER"
echo "  ✓ 远端数据未被改动"
