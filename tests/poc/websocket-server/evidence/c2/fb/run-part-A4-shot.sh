#!/bin/bash
set -u
EVIDENCE="/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2"
CDPJS="$EVIDENCE/cdp/cdp.js"
OUT="$EVIDENCE/fb/part-A3-shot4788.log"
A=61cc29567d91; BASE=45102
log(){ echo "$(date -u +%FT%TZ) $*" | tee -a "$OUT"; }
wait_s(){ sleep "$1"; }
click(){ node "$CDPJS" 9241 "document.getElementById('$1').click(); 'ok'" >/dev/null; }

log "=== capture forced-advance effective-port=45103 on screen ==="
adb -s $A shell am force-stop com.multicam.poc.wsserver >/dev/null 2>&1; wait_s 2
# occupy base
adb -s $A shell "nc -l -p $BASE" </dev/null >/dev/null 2>&1 &
NC=$!; wait_s 2
adb -s $A shell am start -n com.multicam.poc.wsserver/.MainActivity >/dev/null 2>&1
wait_s 5
pid=$(adb -s $A shell pidof com.multicam.poc.wsserver | tr -d '\r')
adb -s $A forward --remove tcp:9241 2>/dev/null; adb -s $A forward tcp:9241 "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1
wait_s 2
click auto-fallback-boot >/dev/null 2>&1  # no-op safety
setv(){ node "$CDPJS" 9241 "var e=document.getElementById('$1'); e.value='$2'; e.value" >/dev/null; }
setv fallback-window 10
click btn-server-stop >/dev/null 2>&1; wait_s 1
click btn-server-fallback
wait_s 6
EP=$(node "$CDPJS" 9241 "document.getElementById('effective-port').textContent" | tr -d '"')
S=$(node "$CDPJS" 9241 "document.getElementById('server-status').textContent" | tr -d '"')
log "capture state: effective-port=$EP status=$S"
adb -s $A exec-out screencap -p > "$EVIDENCE/fb/shots/partA-effective-45103.png"
kill $NC 2>/dev/null
log "shot saved partA-effective-45103.png"
log "=== end ==="