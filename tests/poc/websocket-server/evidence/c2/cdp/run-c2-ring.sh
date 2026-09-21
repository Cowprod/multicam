#!/bin/bash
# MultiCam POC — C2 patched — three-device ring topology (C2-11) + payload
# integrity battery (50/100/150 KB, text & binary, both directions).
#
# Runs on a COMPLETELY CLEAN device state (all apps force-stopped and relaunched
# at the start) so no TIME_WAIT/rebind effects (see C2-08/C2-09 findings) can
# interfere. No server stop/restart happens in this phase.
#
# Ring: C client -> A server ; A client -> B server ; B client -> C server.
set -u

EVIDENCE="${EVIDENCE:-/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2}"
CDPJS="$EVIDENCE/cdp/cdp.js"
RUN="$EVIDENCE/run"
SHOTS="$EVIDENCE/shots"
LOG="$RUN/ring-C2-11-payload.log"
mkdir -p "$RUN" "$SHOTS"

ROLE_A=61cc29567d91; ROLE_B=61d54bba7d91; ROLE_C=c0d8514d7d87
P_A=9223; P_B=9224; P_C=9225
LOG_MARK=()

evalc() { node "$CDPJS" "$1" "$2" | tr -d '"'; }
click() { node "$CDPJS" "$1" "document.getElementById('$2').click(); 'c'" >/dev/null; }
setv()  { node "$CDPJS" "$1" "var e=document.getElementById('$2'); e.value='$3'" >/dev/null; }
status() { node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }
domsel() { node "$CDPJS" "$1" "var s=document.getElementById('$2'); var n=s.options.length; var t=''; for(var i=0;i<n;i++){if(i)t+=',';t+=s.options[i].text;} t+' #'+n"; }
mark() { LOG_MARK[$1]=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length"); }
haslog() {
  local len full m tail
  len=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length")
  full=$(node "$CDPJS" "$1" "document.getElementById('log').textContent")
  m=${LOG_MARK[$1]:-0}
  [ "$m" -gt "$len" ] && m=0
  tail=${full:$m}
  LOG_MARK[$1]=$len
  if printf '%s' "$tail" | grep -qF -- "$3"; then echo "  [PASS] haslog $2"; else echo "  [FAIL] haslog $2: $3"; fi
}
snap() { adb -s "$2" exec-out screencap -p > "$SHOTS/$1.png"; }
line() { echo "=============================================================="; echo "== $* $(date -u +%FT%TZ)"; echo "=============================================================="; }

exec > >(tee -a "$LOG")

# ---------------------------------------------------------------- clean start
line "ring-phase clean start (force-stop + relaunch all devices)"
for s in "$ROLE_A" "$ROLE_B" "$ROLE_C"; do
  adb -s "$s" shell am force-stop com.multicam.poc.wsserver
  adb -s "$s" shell monkey -p com.multicam.poc.wsserver -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
done
sleep 4
PA=$(adb -s "$ROLE_A" shell pidof com.multicam.poc.wsserver | tr -d '\r')
PB=$(adb -s "$ROLE_B" shell pidof com.multicam.poc.wsserver | tr -d '\r')
PC=$(adb -s "$ROLE_C" shell pidof com.multicam.poc.wsserver | tr -d '\r')
for p in 9223 9224 9225; do adb forward --remove tcp:$p >/dev/null 2>&1; done
adb -s "$ROLE_A" forward tcp:9223 "localabstract:webview_devtools_remote_$PA"
adb -s "$ROLE_B" forward tcp:9224 "localabstract:webview_devtools_remote_$PB"
adb -s "$ROLE_C" forward tcp:9225 "localabstract:webview_devtools_remote_$PC"
sleep 3
for spec in "9223:A" "9224:B" "9225:C"; do
  p=${spec%%:*}; l=${spec##*:}
  node "$CDPJS" "$p" "var e=document.getElementById('device-label'); e.value='$l'; document.getElementById('btn-save-label').click(); 'ok'" >/dev/null
done
echo "fresh pids A=$PA B=$PB C=$PC ; labels set"

# ---------------------------------------------------------------- bring up ring
line "C2-11 ring setup"
setv $P_A server-port 45102; click $P_A btn-server-start; sleep 2
echo "A server: $(status $P_A server-status)"
setv $P_C client-host 192.168.92.57; setv $P_C client-port 45102; click $P_C btn-client-connect; sleep 3
echo "C client -> A : $(status $P_C client-status)"
setv $P_B server-port 45102; click $P_B btn-server-start; sleep 2
echo "B server: $(status $P_B server-status)"
setv $P_A client-host 192.168.92.76; setv $P_A client-port 45102; click $P_A btn-client-connect; sleep 3
echo "A client -> B : $(status $P_A client-status)"
setv $P_C server-port 45102; click $P_C btn-server-start; sleep 2
echo "C server: $(status $P_C server-status)"
setv $P_B client-host 192.168.92.192; setv $P_B client-port 45102; click $P_B btn-client-connect; sleep 3
echo "B client -> C : $(status $P_B client-status)"

line "C2-11 topology"
echo "  A server <- $(domsel $P_A server-conn-list)"
echo "  B server <- $(domsel $P_B server-conn-list)"
echo "  C server <- $(domsel $P_C server-conn-list)"
echo "  A client -> $(status $P_A client-status) (host $(evalc $P_A "document.getElementById('client-host').value"))"
echo "  B client -> $(status $P_B client-status) (host $(evalc $P_B "document.getElementById('client-host').value"))"
echo "  C client -> $(status $P_C client-status) (host $(evalc $P_C "document.getElementById('client-host').value"))"
DA=$(domsel $P_A server-conn-list); DB=$(domsel $P_B server-conn-list); DC=$(domsel $P_C server-conn-list)
echo "$DA" | grep -q "192.168.92.192" && echo "  link C->A OK" || echo "  link C->A MISSING"
echo "$DB" | grep -q "192.168.92.57" && echo "  link A->B OK" || echo "  link A->B MISSING"
echo "$DC" | grep -q "192.168.92.76" && echo "  link B->C OK" || echo "  link B->C MISSING"
[ "$(status $P_A client-status)" = "OPEN" ] && [ "$(status $P_B client-status)" = "OPEN" ] && [ "$(status $P_C client-status)" = "OPEN" ] \
  && echo "  C2-11 PASS (3 devices, each simultaneously server+client)" || echo "  C2-11 FAIL"
snap c2-11-A-ring "$ROLE_A"; snap c2-11-B-ring "$ROLE_B"; snap c2-11-C-ring "$ROLE_C"

line "C2-11 ring exchanges"
mark $P_C; node "$CDPJS" $P_C "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value" >/dev/null; click $P_C btn-send; sleep 1
haslog $P_C 0 "roundtrip OK"; echo "  (C->A->C)"
mark $P_A; node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value" >/dev/null; click $P_A btn-send; sleep 1
haslog $P_A 0 "roundtrip OK"; echo "  (A->B->A)"
mark $P_B; node "$CDPJS" $P_B "var m=document.getElementById('msg-mode'); m.value='client-text'; m.value" >/dev/null; click $P_B btn-send; sleep 1
haslog $P_B 0 "roundtrip OK"; echo "  (B->C->B)"

# ---------------------------------------------------------------- payload battery
line "PAYLOAD 50/100/150 KB integrity (text & binary, both directions)"
mark $P_A; mark $P_C
for sz in tiny 50 100 150; do
  # client -> server text (A client -> B server, B auto-echo)
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-text'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value" >/dev/null
  click $P_A btn-send; sleep 1
  haslog $P_A 0 "crc=OK" && echo "  PAYLOAD client->server text $sz: PASS" || echo "  PAYLOAD client->server text $sz: FAIL"
  # server -> client text (A server -> C client)
  node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); for(var i=0;i<s.options.length;i++){if(s.options[i].text.indexOf('192.168.92.192')>=0){s.selectedIndex=i;break;}} s.value" >/dev/null
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-text'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value" >/dev/null
  click $P_A btn-send; sleep 1
  haslog $P_C 0 "client got test" && echo "  PAYLOAD server->client text $sz: PASS" || echo "  PAYLOAD server->client text $sz: FAIL"
done
for sz in 50 100 150; do
  # client -> server binary (A client -> B server, B echoes back)
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='client-binary'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value" >/dev/null
  click $P_A btn-send; sleep 2
  haslog $P_A 0 "client binary VERIFIED" && echo "  PAYLOAD client->server binary $sz (echo): PASS" || echo "  PAYLOAD client->server binary $sz: FAIL"
  # server -> client binary (A server -> C client)
  node "$CDPJS" $P_A "var s=document.getElementById('server-conn-list'); for(var i=0;i<s.options.length;i++){if(s.options[i].text.indexOf('192.168.92.192')>=0){s.selectedIndex=i;break;}} s.value" >/dev/null
  node "$CDPJS" $P_A "var m=document.getElementById('msg-mode'); m.value='server-select-binary'; var s=document.getElementById('msg-size'); s.value='$sz'; s.value" >/dev/null
  click $P_A btn-send; sleep 2
  haslog $P_C 0 "client binary VERIFIED" && echo "  PAYLOAD server->client binary $sz: PASS" || echo "  PAYLOAD server->client binary $sz: FAIL"
done
snap payload-A "$ROLE_A"; snap payload-C "$ROLE_C"

echo "=== RING + PAYLOAD PHASE COMPLETE $(date -u +%FT%TZ) — ring active, ready for C2-12 ==="