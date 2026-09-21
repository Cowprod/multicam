#!/bin/bash
# MultiCam POC — Part A: immediate restart with port fallback qualification.
# A1 normal stop -> immediate rebind attempt base..base+window
# A2 force-stop -> immediate relaunch -> incremental port attempt -> peer connects
# A3 repeated stop/restart cycles -> does the window get permanently consumed?
#
# Uses c2-test build "e6470947..." (adds: Start(fallback) button, #effective-port,
# 'FALLBACK' log trail, auto-fallback-boot via localStorage c2autofb=1).
set -u

EVIDENCE="/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2"
FB="$EVIDENCE/fb"
CDPJS="$EVIDENCE/cdp/cdp.js"
mkdir -p "$FB"
OUT="$FB/part-A.log"
SHOTS="$FB/shots"; mkdir -p "$SHOTS"

A=61cc29567d91; B=61d54bba7d91; IP_A=192.168.92.57
P_A=9241; P_B=9242          # dedicated CDP ports for Part A (avoid clashing with stale 9223/9224)
BASE=45102; WIN=10

LOG_MARK=0
wait_s() { sleep "$1"; }
evalc() { node "$CDPJS" "$1" "$2" | tr -d '"'; }
click() { node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
setv()  { node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'; e.value" >/dev/null; }
status() { node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
logtail() { node "$CDPJS" "$1" "document.getElementById('log').textContent.split('\n').filter(Boolean).slice(-$2).join('\n')"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
log() { echo "$(date -u +%FT%TZ)  $*" | tee -a "$OUT"; }
hdr() { echo; echo "==============================================================" | tee -a "$OUT"; echo "== $1 $(date -u +%FT%TZ)" | tee -a "$OUT"; echo "==============================================================" | tee -a "$OUT"; }

check_cdp() { # $1 port
  node "$CDPJS" "$1" "document.title" >/dev/null 2>&1
}

forward() { # $1 serial $2 tcp-port
  local pid=""
  adb -s "$1" forward --remove "tcp:$2" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    pid=$(adb -s "$1" shell pidof com.multicam.poc.wsserver | tr -d '\r')
    [ -n "$pid" ] && break
    wait_s 1
  done
  adb -s "$1" forward "tcp:$2" "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 7 8 9 10; do check_cdp "$2" && break; wait_s 1; done
  check_cdp "$2" && echo "cdp-ready pid=$pid" || echo "cdp-FAIL pid=$pid"
}

relaunch() { # $1 serial  — fresh process, keeps localStorage (autofb persists)
  adb -s "$1" shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1
  wait_s 1
  adb -s "$1" shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1
  wait_s 2
}

void_marks() {
  LOG_MARK=$(node "$CDPJS" "$P_A" "document.getElementById('log').textContent.length")
}
fb_log_delta() { # read 'FALLBACK' lines from A since last mark
  local len full m tail
  len=$(node "$CDPJS" "$P_A" "document.getElementById('log').textContent.length")
  full=$(node "$CDPJS" "$P_A" "document.getElementById('log').textContent")
  m=$LOG_MARK; [ "$m" -gt "$len" ] && m=0
  tail=${full:$m}; LOG_MARK=$len
  printf '%s' "$tail" | grep -a 'FALLBACK' | tee -a "$OUT"
}
fb_log_all() { # full-log FALLBACK lines (fresh process boot): log is empty at boot
  node "$CDPJS" "$P_A" "document.getElementById('log').textContent" | grep -a 'FALLBACK' | tee -a "$OUT"
}
wait_listening() { # $1=sec timeout: poll effective-port until set
  local t=0
  while [ "$t" -lt "$1" ]; do
    local ep; ep=$(status $P_A effective-port)
    [ -n "$ep" ] && { echo "$ep"; return 0; }
    wait_s 1; t=$((t+1))
  done
  echo ""; return 1
}
# little-endian hex of local port for /proc/net/tcp lookup
port_le_hex() { printf '%02X%02X' $(( $1 & 0xff )) $(( ($1 >> 8) & 0xff )); }
# wait until no TIME_WAIT (state 0B) entry for local port $1 on device A
wait_tw_clear() {
  local le t=0
  le=$(port_le_hex "$1")
  while [ "$t" -lt 90 ]; do
    local hits; hits=$(adb -s "$A" shell "grep -cE '^ *[0-9]+: +${le} +[0-9A-F:]+ +0B' /proc/net/tcp" 2>/dev/null | tr -d '\r')
    [ "${hits:-0}" = "0" ] && { echo "tw-clear port=$1 (after ${t}s)"; return 0; }
    wait_s 5; t=$((t+5))
  done
  echo "tw-timeout port=$1 still in TIME_WAIT"; return 1
}

# ---------------------------------------------------------------------
log "=== Part A start — c2-test build e6470947 (fallback) ==="
hdr "SETUP — fresh process on all devices, autofb=1 persisted"
for s in "$A" "$B"; do relaunch "$s"; done
forward "$A" $P_A
forward "$B" $P_B
# persist autofb after fresh boot (fresh boot rebuilds localStorage on first run)
setv $P_A server-port $BASE >/dev/null 2>&1 && setv $P_A fallback-window $WIN >/dev/null 2>&1
node "$CDPJS" $P_A "var c=document.getElementById('auto-fallback-boot'); c.checked=true; c.onchange(); 'ok'" >/dev/null 2>&1
node "$CDPJS" $P_A "localStorage.getItem('c2autofb')"
wait_s 3   # let localStorage flush to disk before force-stop
log "autofb persisted on A"
# cold boot without autostart this time: drive manually to keep clean state
relaunch "$A"; forward "$A" $P_A
log "fresh A process up (autofb flag kept for A2/A3)"

# ---------------------------------------------------------------------
hdr "A1 — normal server stop on $BASE then immediate fallback attempt"
wait_tw_clear $BASE
# force a clean plain bind on $BASE (stop any auto-started fallback first)
click $P_A btn-server-stop >/dev/null 2>&1; wait_s 1
setv $P_A server-port $BASE >/dev/null; setv $P_A fallback-window 0 >/dev/null
click $P_A btn-server-start; wait_s 3
EP=$(wait_listening 10); S=$(status $P_A server-status)
log "A1 setup A server: $S (effective-port=$EP)"
[ "$EP" != "$BASE" ] && { log "A1 SETUP FAIL: expected $BASE, got $EP"; exit 1; }
log "A1 PASS precondition: A binds $BASE (no TIME_WAIT)"; setv $P_A fallback-window $WIN >/dev/null

setv $P_B client-host $IP_A >/dev/null; setv $P_B client-port $BASE >/dev/null
click $P_B btn-client-connect; wait_s 2
CS=$(status $P_B client-status); log "A1 B connected to $BASE: $CS"
[ "$CS" != "OPEN" ] && { log "A1 FAIL: B not OPEN at setup"; exit 1; }

click $P_A btn-server-stop; wait_s 1
S=$(status $P_A server-status); log "A1 A stopped: $S"

void_marks
T0=$(now_ms)
click $P_A btn-server-fallback; wait_s 4
T1=$(now_ms)
EP=$(status $P_A effective-port); S=$(status $P_A server-status)
log "A1 immediate fallback after stop: effective-port=$EP status=$S"
echo "  A1 wall-clock fallback result (ms): $((T1-T0))" | tee -a "$OUT"
fb_log_delta
[ -n "$EP" ] && [ "$EP" != "$BASE" ] && { log "A1 PASS: $BASE refused (TIME_WAIT), rebound on $EP"; }
[ -n "$EP" ] || { log "A1 FAIL: no port recovered"; exit 1; }

FALLBACK_PORT="$EP"
setv $P_B client-port "$FALLBACK_PORT" >/dev/null
click $P_B btn-client-disconnect >/dev/null 2>&1; wait_s 1
click $P_B btn-client-connect; wait_s 2
CS=$(status $P_B client-status); log "A1 B reconnected to $FALLBACK_PORT: $CS"
[ "$CS" = "OPEN" ] && log "A1 PASS: client resumes on effective port $FALLBACK_PORT" || log "A1 FAIL: B=$CS"

# ---------------------------------------------------------------------
hdr "A2 — force-stop app on A then immediate relaunch (autofb boot)"
log "A2 pre: A currently serving on $FALLBACK_PORT (B connected)"
T0=$(now_ms)
adb -s "$A" shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1
T_FS=$(now_ms)
wait_s 1
log "A2 force-stop done (+$((T_FS-T0))ms)"
adb -s "$A" shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1
T_START=$(now_ms)
log "A2 am start issued"
forward "$A" $P_A
T_CDP=$(now_ms)
log "A2 CDP reattached (+$((T_CDP-T_START))ms from launch)"
EP=$(wait_listening 20)
T_L=$(now_ms)
log "A2 server listening on effective-port=$EP (+$((T_L-T_START))ms from am start)"
fb_log_all
if [ -n "$EP" ]; then log "A2 PASS: app relaunched and rebound on $EP"; else log "A2 FAIL: no port"; exit 1; fi
A2_PORT="$EP"

setv $P_B client-host $IP_A >/dev/null; setv $P_B client-port "$A2_PORT" >/dev/null
click $P_B btn-client-connect; wait_s 2
CS=$(status $P_B client-status); log "A2 B connected to $A2_PORT: $CS"
[ "$CS" = "OPEN" ] && log "A2 PASS: remote peer connected to effective port $A2_PORT" || log "A2 FAIL: B=$CS"

# ---------------------------------------------------------------------
hdr "A3 — repeated forced stop/restart cycles (no TIME_WAIT waiting)"
CYCLES=6
declare -a PORTS_SEEN=()
prev=""
for i in $(seq 1 $CYCLES); do
  [ -n "${prev:-}" ] && { setv $P_B client-port "$prev" >/dev/null; click $P_B btn-client-connect >/dev/null 2>&1; wait_s 1; }
  log "A3 cycle #$i — peer connected to current port ${prev:-none}"
  adb -s "$A" shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1
  wait_s 1
  adb -s "$A" shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1
  T_START=$(now_ms)
  forward "$A" $P_A >/dev/null
  EP=$(wait_listening 20)
  T_L=$(now_ms)
  log "A3 cycle #$i -> effective-port=$EP (+$((T_L-T_START))ms)"
  fb_log_all
  PORTS_SEEN+=("${EP:-none}")
  prev="$EP"
  wait_s 1
done
echo "  A3 ports seen over $CYCLES cycles: ${PORTS_SEEN[*]}" | tee -a "$OUT"
cnt=$(printf '%s\n' "${PORTS_SEEN[@]}" | grep -c . )
uniq=$(printf '%s\n' "${PORTS_SEEN[@]}" | sort -u | tr '\n' ' ')
log "A3 distinct ports used: $uniq"

# demonstrate the window is NOT permanently consumed: wait TIME_WAIT out, retry base
hdr "A3 follow-up — after ${TIME_WAIT_WAIT:-75}s, base $BASE must bind again"
T_W=$(now_ms)
log "A3 waiting 75s for TIME_WAIT to expire..."
wait_s 75
void_marks
click $P_A btn-server-stop >/dev/null 2>&1; wait_s 1
setv $P_A server-port $BASE >/dev/null
click $P_A btn-server-fallback; wait_s 3
EP=$(status $P_A effective-port)
log "A3 after wait: rebind base -> effective-port=$EP (waited $(( $(now_ms)-T_W ))ms)"
if [ "$EP" = "$BASE" ]; then log "A3 PASS: $BASE reusable after TIME_WAIT — window recovers"; else log "A3 CHECK: base not yet reusable (EP=$EP)"; fi

log "=== Part A complete ==="