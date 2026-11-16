#!/bin/bash
# 把仓库里的 cdp-bridge.js 部署到线上 /persistent/cdp/cdp-bridge.js。
#
# 这个脚本只做四件事：备份线上 → 复制 → 校验 sha256 → 提示「不要自动重启桥」。
# 不重启 bridge、不杀 Chrome、不动 profile、不导航任何页面 —— 激活必须由主人手动做。
#
# 用法：
#   bash bridge/deploy.sh                 # 部署（源=本脚本同目录的 cdp-bridge.js）
#   SRC=/path/to/cdp-bridge.js bash bridge/deploy.sh
#   DRY_RUN=1 bash bridge/deploy.sh       # 只显示将要做什么，不写任何文件
#   CDP_BASE=/persistent/cdp bash bridge/deploy.sh
#
# 退出码：0=已部署/无需部署；1=校验失败（已自动回滚）；2=前置条件不满足。
set -eu
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-$HERE/cdp-bridge.js}"
LIVE_BASE="${CDP_BASE:-/persistent/cdp}"
LIVE="$LIVE_BASE/cdp-bridge.js"
BACKUP_DIR="${BACKUP_DIR:-$LIVE_BASE/backup}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/cdp-bridge.js.$STAMP.bak"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "ERR: $*" >&2; exit 2; }
sha() { sha256sum "$1" | awk '{print $1}'; }

command -v sha256sum >/dev/null 2>&1 || die "missing sha256sum"
command -v node >/dev/null 2>&1 || die "missing node"

[ -f "$SRC" ] || die "SRC not found: $SRC"

SRC_SHA="$(sha "$SRC")"
echo "src:         $SRC"
echo "src sha256:  $SRC_SHA"
node --check "$SRC" || die "src syntax check failed: $SRC"

BACK_SHA=""
if [ -f "$LIVE" ]; then
  LIVE_SHA="$(sha "$LIVE")"
  echo "live:        $LIVE"
  echo "live sha256: $LIVE_SHA"
  if [ "$LIVE_SHA" = "$SRC_SHA" ]; then
    echo "already deployed (live sha256 == src sha256) — nothing to do."
    exit 0
  fi
else
  echo "live:        $LIVE (missing, will create)"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would: backup $LIVE -> $BACKUP ; copy $SRC -> $LIVE ; verify sha256 ; refuse to restart"
  exit 0
fi

# 1) 备份线上（有才备份），并校验备份与备份前的 sha256 一致
if [ -f "$LIVE" ]; then
  mkdir -p "$BACKUP_DIR"
  cp -p "$LIVE" "$BACKUP"
  BACK_SHA="$(sha "$BACKUP")"
  [ "$BACK_SHA" = "$LIVE_SHA" ] || die "backup verify failed ($BACK_SHA != $LIVE_SHA)"
  echo "backup:      $BACKUP"
  echo "backup sha256: $BACK_SHA"
fi

rollback() {
  if [ -n "$BACK_SHA" ] && [ -f "$BACKUP" ]; then
    cp -p "$BACKUP" "$LIVE"
    echo "ROLLED BACK: $LIVE <- $BACKUP (sha256=$(sha "$LIVE"))" >&2
  else
    echo "NO BACKUP TO ROLL BACK TO (live was missing before deploy)" >&2
  fi
}

# 2) 复制 + 权限（线上是 700）
cp "$SRC" "$LIVE"
chmod 700 "$LIVE" 2>/dev/null || true

# 3) 校验：sha256 必须等于源；语法必须过
NEW_SHA="$(sha "$LIVE")"
if [ "$NEW_SHA" != "$SRC_SHA" ]; then
  echo "deploy verify FAILED (live=$NEW_SHA src=$SRC_SHA)" >&2
  rollback
  exit 1
fi
if ! node --check "$LIVE"; then
  echo "live syntax check FAILED" >&2
  rollback
  exit 1
fi
echo "deployed:    $LIVE"
echo "live sha256: $NEW_SHA  (== src)"

# 4) 审计记录（谁/何时/哪两个 sha）
mkdir -p "$BACKUP_DIR"
printf '%s src=%s live_sha=%s backup=%s\n' "$STAMP" "$SRC_SHA" "$NEW_SHA" "${BACK_SHA:-none}" >>"$BACKUP_DIR/deploy.log"

# 5) 只读探测：现在跑着的是不是旧进程（新代码要等桥重启才生效）
echo
echo "=== 运行中的桥仍是旧进程（新代码重启后才生效）==="
if [ -S "$LIVE_BASE/bridge.sock" ] && [ -f "$LIVE_BASE/client-stdin.js" ]; then
  PING_OUT="$(printf '%s\n' '{"cmd":"ping"}' | CLIENT_TIMEOUT_MS=5000 node "$LIVE_BASE/client-stdin.js" 2>/dev/null || true)"
  if printf '%s' "$PING_OUT" | grep -q '"capabilities"'; then
    echo "ping: 已带 capabilities（桥已经跑 v2 代码）"
  elif [ -n "$PING_OUT" ]; then
    echo "ping: 老应答（没有 capabilities）→ 需要主人手动重启桥后才生效"
    printf '%s\n' "$PING_OUT" | head -c 400
    echo
  else
    echo "ping: 没拿到应答（桥可能没在跑；重启后由 start.sh 拉起）"
  fi
else
  echo "ping: 没有 bridge.sock 或 client-stdin.js，跳过探测"
fi

cat <<'EOT'

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
不要自动重启桥！
- 本脚本没有重启 bridge、没有杀 Chrome、没有动 profile。
- 代码已落盘，但新命令只有在 bridge 进程重启后才生效。
- 重启会连带关闭当前外部 Chromium 窗口（桥退出时 close 掉 CDP 连接），
  所以必须由主人在确认「没有正在跑的写操作/未提交草稿」后手动执行：

    pid="$(cat /persistent/cdp/bridge.pid 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid"
    sleep 1
    bash /persistent/cdp/start.sh
    bash /persistent/cdp/status.sh          # 看到 ping 带 capabilities 才算新代码生效

- 回滚（同样需要主人手动重启桥）：
    cp -p <上面打印的 backup 路径> /persistent/cdp/cdp-bridge.js
    sha256sum /persistent/cdp/cdp-bridge.js     # 应等于 backup sha256
    # 然后按上面的方式手动重启
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
EOT
