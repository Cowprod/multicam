#!/bin/bash
# MultiCam POC — Part A: reproduce the run6 C2-08/09 condition (B AND C connected)
# to determine whether the fallback actually engages.
set -u
EVIDENCE="/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2"
CDPJS="$EVIDENCE/cdp/cdp.js"
OUT="$EVIDENCE/fb/part-A2-repro.log"
mkdir -p "$EVIDENCE/fb"
A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87
P_A=9241; P_B=9242; P_C=9243
IP_A=192.168.92.57; BASE=45102
log() { echo "$(date -u +%FT%TZ)  $*" | tee -a "$OUT"; }
wait_s(){ sleep "$1"; }
evalc(){ node "$CDPJS" "$1" "$2" | tr -d '"'; }
click(){ node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
setv(){ node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'; e.value" >/dev/null; }
status(){ node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
domsel(){ node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
haslog(){ node "$CDPJS" "$1" "document.getElementById('log').textContent" | grep -q "$2" && echo yes || echo no; }
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
port_le(){ printf '%02X%02X' $(( $1 & 0xff )) $(( ($1>>8) & 0xff )); }

hdr="${BASE} tcp state after stampings"
port_le_hex=$(port_le $BASE)
log "=== Part A repro: BOTH clients connected; stop -> immediate rebind ==="

# fresh processes
for s in $A $B $C; do adb -s $s shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1; done
wait_s 1
for s in $A $B $C; do adb -s $s shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1; done
wait_s 4
for pair in "$A $P_A" "$B $P_B" "$C $P_C"; do
  set -- $pair; pid=$(adb -s $1 shell pidof com.multicam.poc.wsserver | tr -d '\r')
  adb -s $1 forward --remove tcp:$2 2>/dev/null; adb -s $1 forward tcp:$2 "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1
done
log "processes up"

# A plain start on BASE
setv $P_A server-port $BASE >/dev/null
click $P_A btn-server-start; wait_s 3
log "A started: $(status $P_A server-status)"
# B and C connect
setv $P_B client-host $IP_A >/dev/null; setv $P_B client-port $BASE >/dev/null
setv $P_C client-host $IP_A >/dev/null; setv $P_C client-port $BASE >/dev/null
click $P_B btn-client-connect; click $P_C btn-client-connect; wait_s 3
log "B=$(status $P_B client-status) C=$(status $P_C client-status) conns=$(domsel $P_A server-conn-list)"

# capture tcp state around stop/rebind
click $P_A btn-server-stop; wait_s 1
log "A stopped: $(status $P_A server-status)"
log "tcp/A on :$BASE after stop ($(port_le_hex)LE):"
adb -s $A shell "grep -E '^ *[0-9]+: +$(port_le $BASE) +[0-9A-F:]+ +[0-9A-F]' /proc/net/tcp" | tee -a "$OUT"

# attempt immediate plain rebind (run6 C2-08 exact step)
T0=$(now_ms)
click $P_A btn-server-start; wait_s 3
S=$(status $P_A server-status); T1=$(now_ms)
log "A rebind(plain) after stop (B+C were connected): $S (+$((T1-T0))ms)"
echo "$S" | grep -q "listening on :$BASE" && log "REBIND-PLAIN OK on $BASE" || log "REBIND-PLAIN FAILED (EADDRINUSE)" 

# attempt fallback right after (fresh stop again)
click $P_A btn-server-stop >/dev/null 2>&1; wait_s 1
click $P_A btn-server-fallback; wait_s 4
S=$(status $P_A server-status); EP=$(status $P_A effective-port)
log "A rebind(fallback) after 2nd stop: status=$S effective-port=$EP"
node "$CDPJS" $P_A "document.getElementById('log').textContent" | grep -a 'FALLBACK' | tee -a "$OUT"

log "reconnect B to effective port:"
setv $P_B client-port "$EP" >/dev/null
click $P_B btn-client-disconnect >/dev/null 2>&1; wait_s 1
click $P_B btn-client-connect; wait_s 3
log "B=$(status $P_B client-status)"
log "=== repro end ==="