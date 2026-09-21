#!/bin/bash
# MultiCam POC — Part A: controlled proof that the fallback ADVANCES when the
# base port is genuinely occupied (deterministic, not timing-dependent), and
# reuses the base when it is free again.
set -u
EVIDENCE="/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2"
CDPJS="$EVIDENCE/cdp/cdp.js"
OUT="$EVIDENCE/fb/part-A3-forced-advance.log"
mkdir -p "$EVIDENCE/fb"
A=61cc29567d91; B=61d54bba7d91
P_A=9241; P_B=9242
IP_A=192.168.92.57; BASE=45102; WIN=10
log() { echo "$(date -u +%FT%TZ)  $*" | tee -a "$OUT"; }
wait_s(){ sleep "$1"; }
click(){ node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
setv(){ node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'; e.value" >/dev/null; }
status(){ node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
logall(){ node "$CDPJS" "$1" "document.getElementById('log').textContent" | grep -a 'FALLBACK' | tee -a "$OUT"; }

log "=== Part A forced-advance: occupy $BASE on A with external NC listener ==="

# fresh A process, stop any auto-started server
adb -s $A shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1; wait_s 1
adb -s $A shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1; wait_s 4
pid=$(adb -s $A shell pidof com.multicam.poc.wsserver | tr -d '\r')
adb -s $A forward --remove tcp:$P_A 2>/dev/null; adb -s $A forward tcp:$P_A "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1
click $P_A btn-server-stop >/dev/null 2>&1; wait_s 1
log "A fresh, server=$(status $P_A server-status)"

# occupy 45102 from outside with toybox nc (foreground adb shell job)
adb -s $A shell "nc -l -p $BASE" </dev/null >/dev/null 2>&1 &
NC_PID=$!
wait_s 2
log "external nc listener started on $BASE (job pid $NC_PID)"
adb -s $A shell "grep -cE '^ *[0-9]+: +$(printf '%02X%02X' $(( $BASE & 0xff )) $(( ($BASE>>8) & 0xff ))) +00000000:0000 +0A' /proc/net/tcp" | tr -d '\r' > /tmp/occ 2>/dev/null
CNT=$(cat /tmp/occ 2>/dev/null)
log "/proc/net/tcp LISTEN entries on :$BASE = ${CNT:-?}"

# plain start should FAIL
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
click $P_A btn-server-start; wait_s 3
S=$(status $P_A server-status); T1=$(python3 -c 'import time;print(int(time.time()*1000))')
log "A plain start with port occupied: $S (+$((T1-T0))ms)"
echo "$S" | grep -q "FAILED\|ERROR" && log "FORCED EADDRINUSE confirmed" || log "WARN: did not fail as expected"

# fallback should advance to 45103
setv $P_A fallback-window $WIN >/dev/null
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
click $P_A btn-server-fallback; wait_s 6
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
S=$(status $P_A server-status); EP=$(status $P_A effective-port)
log "A fallback with base occupied: status=$S effective-port=$EP (+$((T1-T0))ms)"
logall $P_A
[ "$EP" = "$((BASE+1))" ] && log "PASS: fallback advanced to $EP" || log "CHECK: effective=$EP"

# client B connects to the effective port
setv $P_B client-host $IP_A >/dev/null; setv $P_B client-port "$EP" >/dev/null
click $P_B btn-client-connect; wait_s 3
log "B on $EP: $(status $P_B client-status)"

# free the base port, stop server, fallback again -> should return to BASE
kill $NC_PID 2>/dev/null; wait_s 2
click $P_A btn-server-stop >/dev/null 2>&1; wait_s 1
click $P_A btn-server-fallback; wait_s 6
S=$(status $P_A server-status); EP=$(status $P_A effective-port)
log "A fallback after freeing $BASE: status=$S effective-port=$EP"
logall $P_A
[ "$EP" = "$BASE" ] && log "PASS: fallback returned to base $BASE (window recovers)" || log "CHECK: effective=$EP"
log "=== forced-advance end ==="