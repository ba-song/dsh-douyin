#!/bin/bash
# 启动/复用远程 CDP bridge。
#
# 生命周期原则（2026-11-14 主人要求 B）：
#  - bridge 活着且能 ping 通 → 直接复用，不重启、不杀 Chrome、不导航页面；
#  - 只有 bridge 进程真的不在时才 launch；
#  - Playwright 用 --remote-debugging-pipe（不监听 CDP TCP），因此 bridge 死了但
#    Chromium 还活着时**无法 attach**。这种情况只报告、绝不自动 kill（避免误杀正在用的页面），
#    由人确认后按提示清理。
set -eu
umask 077

BASE=/persistent/cdp
NODE=/manager/extensions/harness/program/node/bin/node
PROFILE=/persistent/chrome-profile
export DISPLAY="${DISPLAY:-:20}"
export XAUTHORITY="${XAUTHORITY:-/manager/extensions/desktop/Xauthority}"
export PLAYWRIGHT_BROWSERS_PATH=/persistent/pw-browsers
# 2026-11-14 实测：/ 和 ?recommend=1 都会在数秒后落到 /jingxuan（精选）；
# 只有导航「推荐」链接完整 URL（?recommend=1&from_nav=1）稳定停在推荐页。
export START_URL="${START_URL:-https://www.douyin.com/?recommend=1&from_nav=1}"

mkdir -p "$BASE" "$BASE/shots" "$PROFILE"
chmod 700 "$BASE" "$BASE/shots" "$PROFILE" 2>/dev/null || true

if [ -x "$NODE" ] && [ -f "$BASE/cdp-bridge.js" ]; then :; else
  echo "missing node or bridge: $NODE $BASE/cdp-bridge.js" >&2
  exit 2
fi
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "desktop $DISPLAY not ready" >&2
  exit 3
fi


ping_json() {
  CLIENT_TIMEOUT_MS=5000 "$NODE" "$BASE/client-stdin.js" <<'JSON' 2>/dev/null
{"cmd":"ping"}
JSON
}

ping_ready() {
  local out
  out="$(ping_json || true)"
  case "$out" in
    *'"browser":true'*'"launching":false'*) return 0 ;;
    *) return 1 ;;
  esac
}

LOCK="$BASE/.start.lock"
# 串行化启动：watchdog 和人工可能同时调 start.sh；只允许一个真正 launch。
locked=0
i=0
while [ "$i" -lt 360 ]; do
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" > "$LOCK/pid" 2>/dev/null || true
    locked=1
    break
  fi
  # 陈旧锁：占锁进程已经不在 → 清掉重试；绝不并发 launch 浏览器。
  lpid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$lpid" ] && ! kill -0 "$lpid" 2>/dev/null; then
    rm -f "$LOCK/pid" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || true
    continue
  fi
  # 另一个 start.sh 正在启动：等它把 bridge 带起来就直接复用
  if ping_ready; then
    echo "another start.sh is launching; bridge is ready, reuse"
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done
if [ "$locked" -ne 1 ]; then
  echo "another start.sh is still launching (lock=$LOCK); not starting a second browser" >&2
  exit 4
fi
trap 'rm -f "$LOCK/pid" 2>/dev/null || true; rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

# 只找“主 Chromium 进程”（排除 renderer/zygote/crashpad），且必须带本插件 profile。
chrome_main_pids() {
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *chrome-linux-arm64/chrome*"--user-data-dir=$PROFILE"*)
        case "$cmd" in *"--type="*) continue ;; esac
        echo "${p#/proc/}"
        ;;
    esac
  done
}

pid=""
if [ -f "$BASE/bridge.pid" ]; then
  pid="$(cat "$BASE/bridge.pid" 2>/dev/null || true)"
fi

if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  # 进程在：最多等 180s 从“启动中”变成 ready；绝不 kill。
  i=0
  while [ "$i" -lt 360 ]; do
    if ping_ready; then
      echo "bridge already running pid=$pid (browser reused, not restarted)"
      exit 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  echo "bridge pid=$pid alive but not ready; refusing to kill it automatically." >&2
  echo "manual recovery: kill $pid; sh $BASE/start.sh" >&2
  exit 4
fi

# pid 文件是死的：清掉陈旧 socket/endpoint/pid；不碰任何 Chromium。
if [ -n "$pid" ]; then
  rm -f "$BASE/bridge.pid"
fi
rm -f "$BASE/bridge.sock" "$BASE/endpoint.json" "$BASE/.ping.json"

# 2026-11-15：本机改用「Chromium 150 + CDP 9222 + connectOverCDP」，
# 已运行的 Chromium 不再是 orphan，直接交给 bridge 连接即可（原 pipe 模式才不能 attach）。
orphans="$(chrome_main_pids | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$orphans" ]; then
  echo "reusing running chromium with profile=$PROFILE: $orphans (CDP mode)" >&2
fi

echo "launching bridge $(date -Is)"
setsid nohup "$NODE" "$BASE/cdp-bridge.js" >>"$BASE/bridge.log" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$BASE/bridge.pid"
chmod 600 "$BASE/bridge.pid" 2>/dev/null || true

# 三 tab（main/notify/dm）首次加载可能比单页慢；给 180s。
i=0
while [ "$i" -lt 360 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "bridge process exited during startup; bridge.log tail:" >&2
    tail -40 "$BASE/bridge.log" >&2 2>/dev/null || true
    rm -f "$BASE/.ping.json"
    exit 1
  fi
  if ping_ready; then
    ping_json >"$BASE/.ping.json" || true
    cat "$BASE/.ping.json"
    rm -f "$BASE/.ping.json"
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done

echo "bridge did not become ready in 180s; bridge.log tail:" >&2
tail -60 "$BASE/bridge.log" >&2 2>/dev/null || true
rm -f "$BASE/.ping.json"
exit 1
