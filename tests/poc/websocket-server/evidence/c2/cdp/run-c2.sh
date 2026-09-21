#!/bin/bash
# MultiCam POC — C2 patched — physical test runner (evidence generator).
# Phase "base":      C2-01..C2-11, payload sizes, cleartext.  Leaves the ring topology ACTIVE.
# Phase "sustained": C2-12 — heartbeat on the active ring for 10+ minutes + statistics (separate script).
#
# Requires: adb, node (CDP), three devices with c2-test installed and CDP forwarded.
# CDP forwarding is re-derived for device A after its force-stop in C2-09.
#
# v2 (final qualification): haslog() is scoped to the LOG DELTA since the last
# evaluation point (mark); a marker is never matched against stale earlier log
# lines, so a PASS cannot be inferred from a previous test's success.
set -u

EVIDENCE="${EVIDENCE:-/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2}"
CDPJS="$EVIDENCE/cdp/cdp.js"
RUN="$EVIDENCE/run"
SHOTS="$EVIDENCE/shots"
mkdir -p "$RUN" "$SHOTS"

SERIALS[0]=61cc29567d91   # A
SERIALS[1]=61d54bba7d91   # B
SERIALS[2]=c0d8514d7d87   # C
ROLE_A=${SERIALS[0]}; ROLE_B=${SERIALS[1]}; ROLE_C=${SERIALS[2]}

P_A=9223; P_B=9224; P_C=9225
LOG_MARK=()  # per-port watermark of last consumed log length

wait_s() { sleep "$1"; }

# --- low-level helpers -------------------------------------------------
evalc() { node "$CDPJS" "$1" "$2" | tr -d '"'; }          # $1=port $2=expr
click() { node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
setv()  { node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'; e.value"; }
status() { node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
domsel() { node "$CDPJS" "$1" "var s=document.getElementById('$2'); var n=s.options.length; var t=''; for(var i=0;i<n;i++){if(i)t+=',';t+=s.options[i].text;} t+' #'+n"; }
logtail() { node "$CDPJS" "$1" "document.getElementById('log').textContent.split('\n').filter(Boolean).slice(-$2).join('\n')"; }
snap() { adb -s "$2" exec-out screencap -p > "$SHOTS/$1.png"; }   # $1=name $2=serial

# mark $1=port : remember current log length (next haslog will only see new lines)
mark() {
  LOG_MARK[$1]=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length")
}
# haslog $1=port $2=label $3=needle : assert that needle appears in the log delta
haslog() {
  local len full m tail
  len=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length")
  full=$(node "$CDPJS" "$1" "document.getElementById('log').textContent")
  m=${LOG_MARK[$1]:-0}
  [ "$m" -gt "$len" ] && m=0
  tail=${full:$m}
  LOG_MARK[$1]=$len
  if ! printf '%s' "$tail" | grep -qF -- "$3"; then
    echo "  [FAIL] $2: not found in log delta: $3"
    return 1
  fi
  echo "  [PASS] $2: $3"
}

port_for() { # $1=A|B|C
  case $1 in
    A) echo "$P_A";; B) echo "$P_B";; C) echo "$P_C";;
  esac
}
serial_of() {
  case $1 in
    A) echo "$ROLE_A";; B) echo "$ROLE_B";; C) echo "$ROLE_C";;
  esac
}

reattach_A() {
  P_A=$P_A    # keep same tcp port; re-forward to new pid
  adb -s "$ROLE_A" forward --remove tcp:$P_A >/dev/null 2>&1
  local pid; pid=$(adb -s "$ROLE_A" shell pidof com.multicam.poc.wsserver | tr -d '\r')
  adb -s "$ROLE_A" forward tcp:$P_A "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1
  node "$CDPJS" "$P_A" "document.title" >/dev/null 2>&1 && echo "reattached A pid=$pid"
}

# --- start a clear, labeled per-test evidence file ----------------------
start_test() { # $1 = C2-XX
  echo "=============================================================="
  echo "== $1 $(date -u +%FT%TZ)"
  echo "=============================================================="
}
done_test() { echo "  [OK] $1 complete"; echo; }

# =====================================================================
# C2-01 — Server start on A (port 45102, LAN listening)
# =====================================================================
start_test C2-01
setv $P_A server-port 45102 >/dev/null
click $P_A btn-server-start
wait_s 1
S=$(status $P_A server-status); echo "  A server-status: $S"
echo "$S" | grep -q "listening on :45102" && echo "  C2-01 PASS (listening :45102)" || echo "  C2-01 FAIL"
snap c2-01-A-start "$ROLE_A"
done_test C2-01

# =====================================================================
# C2-02 — Standard WebView client: B -> A via new WebSocket("ws://A_IP:45102")
# =====================================================================
start_test C2-02
mark $P_B
setv $P_B client-host 192.168.92.57 >/dev/null
setv $P_B client-port 45102 >/dev/null
click $P_B btn-client-connect
wait_s 2
CS=$(status $P_B client-status); echo "  B client-status: $CS"
[ "$CS" = "OPEN" ] && echo "  C2-02 PASS (B client OPEN)" || echo "  C2-02 FAIL (B client: $CS)"
echo "  A conn-list: $(domsel $P_A server-conn-list)"
logtail $P_A 4
snap c2-02-B-connected "$ROLE_B"
done_test C2-02

# =====================================================================
# C2-03 — Bidirectional JSON, payload integrity
# =====================================================================
start_test C2-03
mark $P_B
node "$CDPJS" $P_B "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"
click $P_B btn-send
wait_s 1
echo "  --- B log (client->server exchange) ---"; logtail $P_B 6
haslog $P_B 0 "roundtrip OK" && echo "  C2-03a PASS (B->A JSON, A auto-echo integrity OK)" || echo "  C2-03a CHECK"
node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); s.selectedIndex=0; s.value"
node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-text'; m.value"
click $P_A btn-send
wait_s 1
echo "  --- B log (server->client exchange) ---"; logtail $P_B 4
haslog $P_B 0 "client got test" && echo "  C2-03b PASS (A->B JSON, B integrity verified)" || echo "  C2-03b FAIL"
done_test C2-03

# =====================================================================
# C2-04 — Multiple clients B and C on A, distinct connection IDs
# =====================================================================
start_test C2-04
setv $P_C client-host 192.168.92.57 >/dev/null
setv $P_C client-port 45102 >/dev/null
click $P_C btn-client-connect
wait_s 2
echo "  A conn-list: $(domsel $P_A server-conn-list)"
CL=$(domsel $P_A server-conn-list); echo "$CL" | grep -q ',' && echo "  C2-04 PASS (2 distinct connections)" || echo "  C2-04 FAIL"
echo "$CL" | grep -q "192.168.92.76" && echo "  distinct ids: B present" || echo "  distinct ids: B MISSING"
echo "$CL" | grep -q "192.168.92.192" && echo "  distinct ids: C present" || echo "  distinct ids: C MISSING"
snap c2-04-A-two-clients "$ROLE_A"
done_test C2-04

# =====================================================================
# C2-05 — Individual send to B only (verify C does not receive)
# =====================================================================
start_test C2-05
CLEN_C=$(node "$CDPJS" $P_C "document.getElementById('log').textContent.length")
mark $P_B
node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); for(var i=0;i<s.options.length;i++){if(s.options[i].text.indexOf('192.168.92.76')>=0){s.selectedIndex=i;break;}} s.value"
node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-text'; m.value"
click $P_A btn-send
wait_s 1
haslog $P_B 0 "client got test" && echo "  C2-05 PASS (B received)" || echo "  C2-05 FAIL (B did not receive)"
CLEN_C2=$(node "$CDPJS" $P_C "document.getElementById('log').textContent.length")
[ "$CLEN_C2" = "$CLEN_C" ] && echo "  C2-05 PASS (C log unchanged — not received)" || echo "  C2-05 FAIL (C log grew: $CLEN_C -> $CLEN_C2)"
done_test C2-05

# =====================================================================
# C2-06 — JS broadcast (iterate connections, plugin send() per conn)
# =====================================================================
start_test C2-06
mark $P_B; mark $P_C
node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-broadcast-text'; m.value"
click $P_A btn-send
wait_s 1
haslog $P_B 0 "client got test" && echo "  C2-06 PASS (B received via JS broadcast)" || echo "  C2-06 FAIL (B)"
haslog $P_C 0 "client got test" && echo "  C2-06 PASS (C received via JS broadcast)" || echo "  C2-06 FAIL (C)"
logtail $P_A 3
done_test C2-06

# =====================================================================
# C2-07 — Disconnect/reconnect of B; stale-state bookkeeping on A
# =====================================================================
start_test C2-07
mark $P_A
click $P_B btn-client-disconnect
wait_s 2
echo "  A conn-list after B disconnect: $(domsel $P_A server-conn-list)"
haslog $P_A 0 "onClose" && echo "  C2-07 PASS (A detected onClose)" || echo "  C2-07 FAIL (no onClose on A)"
CL=$(domsel $P_A server-conn-list); echo "$CL" | grep -q "192.168.92.192" && echo "  C2-07 PASS (C still listed)" || echo "  C2-07 FAIL (C dropped)"
echo "$CL" | grep -q "192.168.92.76" && echo "  C2-07 FAIL (stale B conn remains)" || echo "  C2-07 PASS (B conn removed)"
click $P_B btn-client-connect
wait_s 2
[ "$(status $P_B client-status)" = "OPEN" ] && echo "  C2-07 PASS (B reconnected)" || echo "  C2-07 FAIL (reconnect)"
mark $P_B
node "$CDPJS" $P_B "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"
click $P_B btn-send
wait_s 1
haslog $P_B 0 "roundtrip OK" && echo "  C2-07 PASS (traffic resumed after reconnect)" || echo "  C2-07 FAIL (no traffic after reconnect)"
done_test C2-07

# =====================================================================
# C2-08 — Server stop/restart on A same port; client-side loss visible
# =====================================================================
start_test C2-08
mark $P_B; mark $P_C
click $P_A btn-server-stop
wait_s 2
echo "  A server-status: $(status $P_A server-status)"
haslog $P_B 0 "client CLOSE" && echo "  C2-08 PASS (B observed server loss)" || echo "  C2-08 CHECK (B close code)"
haslog $P_C 0 "client CLOSE" && echo "  C2-08 PASS (C observed server loss)" || echo "  C2-08 CHECK (C close code)"
click $P_A btn-server-start
wait_s 2
S=$(status $P_A server-status); echo "  A server-status after restart: $S"
echo "$S" | grep -q "listening on :45102" && echo "  C2-08 PASS (restart on same port 45102, no bind error)" || echo "  C2-08 FAIL (restart/bind)"
snap c2-08-A-restarted "$ROLE_A"
done_test C2-08

# =====================================================================
# C2-09 — Application force-stop/restart on A; rebind 45102; reconnect B/C
# =====================================================================
start_test C2-09
adb -s "$ROLE_A" shell am force-stop com.multicam.poc.wsserver
wait_s 2
adb -s "$ROLE_A" shell monkey -p com.multicam.poc.wsserver -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
wait_s 3
reattach_A
mark $P_A
click $P_A btn-server-start
wait_s 2
S=$(status $P_A server-status); echo "  A server-status after force-stop restart: $S"
echo "$S" | grep -q "listening on :45102" && echo "  C2-09 PASS (server rebound 45102 after app restart)" || echo "  C2-09 FAIL (rebind)"
haslog $P_A 0 "onFailure" && echo "  C2-09 FAIL (onFailure/error seen)" || echo "  C2-09 PASS (no bind/rebind error)"
click $P_B btn-client-connect
click $P_C btn-client-connect
wait_s 2
echo "  A conn-list: $(domsel $P_A server-conn-list)"
CL=$(domsel $P_A server-conn-list)
echo "$CL" | grep -q "192.168.92.76" && echo "$CL" | grep -q "192.168.92.192" && echo "  C2-09 PASS (B and C reconnected)" || echo "  C2-09 FAIL (reconnect after force-stop)"
done_test C2-09

# =====================================================================
# C2-10 — Simultaneous server + client: A<->B both ways
# =====================================================================
start_test C2-10
setv $P_B server-port 45102 >/dev/null; click $P_B btn-server-start; wait_s 1
echo "  B server-status: $(status $P_B server-status)"
setv $P_A client-host 192.168.92.76 >/dev/null; setv $P_A client-port 45102 >/dev/null
click $P_A btn-client-connect      # A client -> B server
wait_s 2
[ "$(status $P_A client-status)" = "OPEN" ] && echo "  C2-10 PASS (A client OPEN to B)" || echo "  C2-10 FAIL (A client)"
echo "  B conn-list: $(domsel $P_B server-conn-list)"
mark $P_A
node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"
click $P_A btn-send                # A client -> B server, B auto-echo
wait_s 1
haslog $P_A 0 "roundtrip OK" && echo "  C2-10 PASS (A->B server->A JSON OK)" || echo "  C2-10 FAIL (A->B json)"
snap c2-10-A-hosts-and-clients "$ROLE_A"
node "$CDPJS" $P_B "var s=document.getElementById('server-conn-list'); s.selectedIndex=0; s.value"
node "$CDPJS" $P_B "var m=document.getElementById('msg-mode'); m.value='server-select-text'; m.value"
click $P_B btn-send                # B server -> A client
wait_s 1
haslog $P_A 0 "client got test" && echo "  C2-10 PASS (B server -> A client JSON, integrity)" || echo "  C2-10 FAIL (B->A json)"
snap c2-10-B-hosts-and-clients "$ROLE_B"
done_test C2-10

# =====================================================================
# C2-11 — Three-device ring: each device hosts AND is client
#   C -> A  (C client to A server)
#   A -> B  (A client to B server)
#   B -> C  (B client to C server, B leaves A)
#   exact topology recorded.
# =====================================================================
start_test C2-11
setv $P_C server-port 45102 >/dev/null; click $P_C btn-server-start; wait_s 1
echo "  C server-status: $(status $P_C server-status)"
click $P_B btn-client-disconnect; wait_s 1                    # B leaves A's server
setv $P_B client-host 192.168.92.192 >/dev/null; setv $P_B client-port 45102 >/dev/null
click $P_B btn-client-connect                                # B -> C
wait_s 2
echo "  RING LINKS:"
echo "   A server <- $(domsel $P_A server-conn-list)"
echo "   B server <- $(domsel $P_B server-conn-list)"
echo "   C server <- $(domsel $P_C server-conn-list)"
echo "   A client -> $(status $P_A client-status) (host $(node "$CDPJS" $P_A "document.getElementById('client-host').value"))"
echo "   B client -> $(status $P_B client-status) (host $(node "$CDPJS" $P_B "document.getElementById('client-host').value"))"
echo "   C client -> $(status $P_C client-status) (host $(node "$CDPJS" $P_C "document.getElementById('client-host').value"))"
DB=$(domsel $P_B server-conn-list); DC=$(domsel $P_C server-conn-list); DA=$(domsel $P_A server-conn-list)
echo "$DA" | grep -q "192.168.92.192" && echo "  C2-11 link C->A OK" || echo "  C2-11 link C->A MISSING"
echo "$DB" | grep -q "192.168.92.57" && echo "  C2-11 link A->B OK" || echo "  C2-11 link A->B MISSING"
echo "$DC" | grep -q "192.168.92.76" && echo "  C2-11 link B->C OK" || echo "  C2-11 link B->C MISSING"
[ "$(status $P_A client-status)" = "OPEN" ] && [ "$(status $P_B client-status)" = "OPEN" ] && [ "$(status $P_C client-status)" = "OPEN" ] \
  && echo "  C2-11 PASS (3 devices: each simultaneously server+client)" || echo "  C2-11 FAIL"
# exchange across the ring: C client -> A server (echo back), A client -> B, B client -> C
mark $P_C; node "$CDPJS" $P_C "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"; click $P_C btn-send; wait_s 1
haslog $P_C 0 "roundtrip OK" && echo "  C2-11 ring exchange C->A->C OK" || echo "  C2-11 ring FAIL (C->A)"
mark $P_A; node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"; click $P_A btn-send; wait_s 1
haslog $P_A 0 "roundtrip OK" && echo "  C2-11 ring exchange A->B->A OK" || echo "  C2-11 ring FAIL (A->B)"
mark $P_B; node "$CDPJS" $P_B "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value"; click $P_B btn-send; wait_s 1
haslog $P_B 0 "roundtrip OK" && echo "  C2-11 ring exchange B->C->B OK" || echo "  C2-11 ring FAIL (B->C)"
snap c2-11-A-ring "$ROLE_A"; snap c2-11-B-ring "$ROLE_B"; snap c2-11-C-ring "$ROLE_C"
done_test C2-11

# =====================================================================
# Payload sizes — text & binary, both directions (on-bridge: A<->B ring)
# =====================================================================
start_test PAYLOAD
mark $P_A; mark $P_C
for sz in tiny 50 100 150; do
  # client -> server text
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-text'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value"
  click $P_A btn-send; wait_s 1
  haslog $P_A 0 "crc=OK" && echo "  PAYLOAD client->server text $sz: PASS" || echo "  PAYLOAD client->server text $sz: CHECK/FAIL"
  # server -> client text (A server -> C client)
  node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); for(var i=0;i<s.options.length;i++){if(s.options[i].text.indexOf('192.168.92.192')>=0){s.selectedIndex=i;break;}} s.value"
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-text'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value"
  click $P_A btn-send; wait_s 1
  haslog $P_C 0 "client got test" && echo "  PAYLOAD server->client text $sz: PASS" || echo "  PAYLOAD server->client text $sz: CHECK/FAIL"
done
for sz in 50 100 150; do
  # client -> server binary (A client -> B server; B echoes binary back)
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-binary'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value"
  click $P_A btn-send; wait_s 2
  haslog $P_A 0 "client binary VERIFIED" && echo "  PAYLOAD client->server binary $sz (echo): PASS" || echo "  PAYLOAD client->server binary $sz: CHECK/FAIL"
  # server -> client binary (A server -> C client)
  node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); for(var i=0;i<s.options.length;i++){if(s.options[i].text.indexOf('192.168.92.192')>=0){s.selectedIndex=i;break;}} s.value"
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-binary'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value"
  click $P_A btn-send; wait_s 2
  haslog $P_C 0 "client binary VERIFIED" && echo "  PAYLOAD server->client binary $sz: PASS" || echo "  PAYLOAD server->client binary $sz: CHECK/FAIL"
done
snap payload-A "$ROLE_A"; snap payload-C "$ROLE_C"
done_test PAYLOAD

echo "=== BASE PHASE COMPLETE $(date -u +%FT%TZ) — ring topology active, ready for C2-12 ==="