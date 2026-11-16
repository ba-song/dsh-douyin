#!/bin/sh
# 重启远程 CDP 桥（会短暂关闭 Chromium 窗口；由主人/Lead 在确认后执行）
# 用法：bash bridge/restart.sh
set -u
BASE="${CDP_BASE:-/persistent/cdp}"
PIDFILE="$BASE/bridge.pid"
CLIENT="$BASE/client-stdin.js"
NODE="$(command -v node || echo /manager/extensions/harness/program/node/bin/node)"

echo "== before =="
if [ -f "$PIDFILE" ]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  echo "old pid=$old"
  [ -n "$old" ] && kill "$old" 2>/dev/null || true
  i=0; while [ $i -lt 20 ]; do kill -0 "$old" 2>/dev/null || break; i=$((i+1)); sleep 0.5; done
else
  echo "no pidfile"
fi

echo "== start =="
sh "$BASE/start.sh" || exit 1
i=0
while [ $i -lt 60 ]; do
  if [ -S "$BASE/bridge.sock" ]; then break; fi
  i=$((i+1)); sleep 0.5
done

echo "== ping =="
printf '%s\n' '{"cmd":"ping"}' | CLIENT_TIMEOUT_MS=8000 "$NODE" "$CLIENT" || { echo "ping failed"; exit 1; }
echo
echo "== health =="
printf '%s\n' '{"cmd":"health"}' | CLIENT_TIMEOUT_MS=8000 "$NODE" "$CLIENT" || true
echo
echo "done. capabilities 出现即新桥生效；没有 capabilities 说明还在跑旧代码。"
