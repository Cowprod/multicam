#!/bin/bash
# MultiCam POC — C2 patched — controlled reproduction of the C2-08/C2-09
# rebind failure. Establishes the exact root cause of "Address already in use"
# after stop()/force-stop with connected clients, then proves recovery once the
# TCP TIME_WAIT window (~60s on Linux/Android) has elapsed.
#
# Expectation (validated with Java-WebSocket 1.6.0 bytecode):
#   - Java-WebSocket binds WITHOUT SO_REUSEADDR (WebSocketServer ctor calls
#     setReuseAddr(false); the plugin never overrides it).
#   - accepted connections reuse the listener's local port (45102); after
#     stop()/close their sockets linger in TIME_WAIT on A:45102.
#   - an immediate rebind of 45102 therefore fails with EADDRINUSE;
#   - once the TIME_WAIT entries age out, rebinding succeeds.
set -u

EVIDENCE="${EVIDENCE:-/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2}"
CDPJS="$EVIDENCE/cdp/cdp.js"
OUT="$EVIDENCE/run/rebind-repro-C2-08-09.log"
P_A=9223; P_B=9224
ROLE_A=61cc29567d91
ROLE_B=61d54bba7d91

evalc() { node "$CDPJS" "$1" "$2" | tr -d '"'; }
click() { node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
setv()  { node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'; e.value" >/dev/null; }
status() { node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
wait_s() { sleep "$1"; }

log() { echo "$(date -u +%FT%TZ)  $*" | tee -a "$OUT"; }

log "=== rebind reproduction (C2-08/C2-09) start — ring state may be changed by this run ==="

# In this experiment A holds the server; B plays the connected client.
setv $P_A server-port 45102
click $P_A btn-server-start; wait_s 2
s=$(status $P_A server-status); log "step1 A server start: $s"

setv $P_B client-host 192.168.92.57; setv $P_B client-port 45102
click $P_B btn-client-connect; wait_s 2
cs=$(status $P_B client-status); log "step2 B client to A: $cs"
log "step2 A conns: $(node "$CDPJS" $P_A "document.getElementById('server-conn-list').options.length") client(s)"

click $P_A btn-server-stop; wait_s 2
log "step3 A server stop: $(status $P_A server-status)"

log "step4 A rebind immediately after stop (clients were connected):"
click $P_A btn-server-start; wait_s 3
s=$(status $P_A server-status); log "step4 A server start (immediate): $s"

log "step4 /proc/net/tcp state (A, port 45102 = 0xB02E):"
adb -s "$ROLE_A" shell "cat /proc/net/tcp" | tee -a "$OUT" | grep -i "B02E" || log "step4 no 45102 entry visible in /proc/net/tcp"

click $P_A btn-server-stop; wait_s 2
log "step4b A server stopped again: $(status $P_A server-status)"

log "step5 waiting 75s for TCP TIME_WAIT to expire..."
wait_s 75

log "step5 A rebind AFTER TIME_WAIT window:"
click $P_A btn-server-start; wait_s 3
s=$(status $P_A server-status); log "step5 A server start (after wait): $s"

log "=== rebind reproduction end ==="