#!/bin/bash
# 远程 CDP bridge 看门狗。
#
# 2026-11-14 主人要求 B：健康检查不能误杀。
#  - ping 失败不立刻重启：连续 3 次失败且 bridge 进程真的不在，才调用 start.sh；
#  - bridge 进程还活着但不响应 → 只告警，绝不自动 kill（kill bridge 会连带关掉浏览器）；
#  - start.sh 自己会复用活着的 bridge，也不会按 profile 杀 Chrome。
set -u

BASE=/persistent/cdp
NODE=/manager/extensions/harness/program/node/bin/node
export DISPLAY="${DISPLAY:-:20}"
export XAUTHORITY="${XAUTHORITY:-/manager/extensions/desktop/Xauthority}"
export PLAYWRIGHT_BROWSERS_PATH=/persistent/pw-browsers

log() { echo "$(date -Is) $*" >>"$BASE/watchdog.log"; }
last_desktop=""
fails=0
last_unresponsive_alert=0

ping_ok() {
  local out
  out="$(CLIENT_TIMEOUT_MS=8000 "$NODE" "$BASE/client-stdin.js" <<'JSON' 2>/dev/null
{"cmd":"ping"}
JSON
)"
  case "$out" in
    *'"ok":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

bridge_pid() {
  [ -f "$BASE/bridge.pid" ] || return 1
  local pid
  pid="$(cat "$BASE/bridge.pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

while :; do
  if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    if [ "$last_desktop" != "down" ]; then
      log "desktop $DISPLAY down; waiting (watchdog does not start desktop)"
      last_desktop="down"
    fi
    sleep 15
    continue
  fi
  if [ "$last_desktop" != "up" ]; then
    log "desktop $DISPLAY up"
    last_desktop="up"
  fi

  if ping_ok; then
    if [ "$fails" -gt 0 ]; then
      log "bridge ping recovered after $fails failure(s)"
    fi
    fails=0
    sleep 15
    continue
  fi

  fails=$((fails + 1))
  pid="$(bridge_pid || true)"
  if [ -z "$pid" ]; then
    # 进程真的不在：连续 3 次再启动，避免启动/退出瞬间误判。
    if [ "$fails" -lt 3 ]; then
      sleep 5
      continue
    fi
    log "bridge process missing (ping failed $fails times); running start.sh"
    sh "$BASE/start.sh" >>"$BASE/watchdog.log" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then log "start.sh failed rc=$rc; will retry"; fi
    fails=0
    sleep 15
    continue
  fi

  # 进程在但 ping 不通：可能是单条命令排队/浏览器忙；只告警，不杀。
  if [ "$fails" -ge 3 ]; then
    now="$(date +%s)"
    if [ $((now - last_unresponsive_alert)) -ge 300 ]; then
      last_unresponsive_alert="$now"
      log "bridge pid=$pid alive but unresponsive (ping failed $fails times); NOT killing automatically (would also close the browser). manual: kill $pid; sh $BASE/start.sh"
    fi
  fi
  sleep 15
done
