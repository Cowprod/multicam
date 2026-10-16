#!/usr/bin/env bash
# MultiCam — J14-B02 : MESURE de la tempête d'annonces/reSync (avant/après correctif).
#
# Montage : A=Master  B=Capture  C=Storage  D=Capture (tablette, Wi-Fi TCP).
# Scénario COURT et REJOUABLE : session neuve, jonction B/C/D, un Take court
# (2 Captures + 1 Storage, transferts B->C et D->C). Le pilotage du Take est
# INJECTÉ dans la WebView (un seul appel CDP) pour ne pas être bloqué par la
# saturation du thread quand la tempête est active ; la mesure se fait par logcat.
#
# Usage : j14b02-measure.sh <label>   (ex: before | after). Sortie :
#   tests/e2e/validation/J14-B02/measure-<label>/
# Aucune modification applicative, aucune suppression de média/session.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
DTCP=192.168.92.103:5555
DIP=192.168.92.103
DEVS="$A $B $C $DTCP"

LABEL="${1:-measure}"
OUT="$HERE/validation/J14-B02/measure-$LABEL"
mkdir -p "$OUT/dumps" "$OUT/logs"

T0=$SECONDS
ELAPSED() { echo "+$(( SECONDS - T0 ))s"; }
mark() { echo; echo "### [$(ELAPSED)] $1" | tee -a "$OUT/measure.log"; }

run_to() { local t="$1"; shift
  ( "$@" </dev/null ) & local p=$!
  ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) & local w=$!
  local rc=0
  wait "$p" 2>/dev/null || rc=$?
  kill -TERM "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc; }
ADB()  { run_to 30 adb "$@"; }
ev()   { run_to 150 env CDP_TIMEOUT_MS=90000 node "$CDP" "$1" eval "$2"; }

d_ensure() { if ADB -s "$DTCP" get-state 2>/dev/null | grep -q device; then return 0; fi
  adb connect "$DIP:5555" >/dev/null 2>&1; sleep 2; ADB -s "$DTCP" get-state 2>/dev/null | grep -q device; }
dev_ready() { local s="$1"; if [ "$s" = "$DTCP" ]; then d_ensure; else ADB -s "$s" get-state 2>/dev/null | grep -q device; fi; }
wait_ready() { local s="$1" t="${2:-60}" p=0
  while [ "$p" -lt "$t" ]; do dev_ready "$s" && return 0; sleep 5; p=$((p+5)); done; return 1; }

role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }
relaunch() { adb -s "$1" shell am force-stop "$APP" >/dev/null 2>&1; adb -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; sleep 5; }
grant_perms() { for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do adb -s "$1" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1; done; }
sid_by_name() { local r; r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()"); echo "${r//\"/}"; }

EVPAT='SESSION_ADVERTISE_SKIP|SESSION_ADVERTISE |SESSION_ADVERTISE_ERROR|RE_SYNC_THROTTLED|SYNC_BROADCAST|TARGETED_BROADCAST|TAKE_CHANGED|TAKE_RECEIVED|MEMBER_TELEMETRY|TRANSFER_PROGRESS'
cap_counts() { # $1 = tag
  local tag="$1"
  echo "device SESSION_ADVERTISE_SKIP RE_SYNC_THROTTLED SYNC_BROADCAST TARGETED_BROADCAST TAKE_CHANGED TAKE_RECEIVED MEMBER_TELEMETRY TRANSFER_PROGRESS" | tee "$OUT/dumps/counts-$tag.txt"
  for s in $DEVS; do
    local f="$OUT/logs/${s//[:\/]/_}-$tag.log"
    adb -s "$s" logcat -d -v time 2>/dev/null | grep -E "$EVPAT" > "$f"
    local n
    n=$(grep -c 'SESSION_ADVERTISE_SKIP' "$f"); printf '%s %s ' "$s" "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'RE_SYNC_THROTTLED' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'SYNC_BROADCAST' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'TARGETED_BROADCAST' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'TAKE_CHANGED' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'TAKE_RECEIVED' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'MEMBER_TELEMETRY' "$f"); printf '%s ' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
    n=$(grep -c 'TRANSFER_PROGRESS' "$f"); printf '%s\n' "${n:-0}" | tee -a "$OUT/dumps/counts-$tag.txt" >/dev/null
  done
}
clear_logs() { for s in $DEVS; do adb -s "$s" logcat -c >/dev/null 2>&1; done; }

mark "PHASE 0 — git / adb"
{ echo "HEAD: $(git -C "$HERE/../.." rev-parse HEAD)"; git -C "$HERE/../.." log --oneline -1; echo; adb devices -l | tr -d '\r'; } > "$OUT/dumps/prep.txt" 2>&1
sed 's/^/  /' "$OUT/dumps/prep.txt"

mark "PHASE 1 — roles + relance des 4 devices"
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
for s in $DEVS; do adb -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; adb -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
sleep 45
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
sleep 10
echo -n "  A roles="; role_cfg "$A" false false true  "J14B02-A-Master"
echo -n "  B roles="; role_cfg "$B" true  false false "J14B02-B-Capture"
echo -n "  C roles="; role_cfg "$C" false true  false "J14B02-C-Storage"
echo -n "  D roles="; role_cfg "$DTCP" true false false "J14B02-D-Capture"
sleep 2
for s in $DEVS; do relaunch "$s"; grant_perms "$s"; done
sleep 45
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
sleep 10
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done

mark "PHASE 2 — session sur A + jonction B/C/D"
SNAME="J14B02-$LABEL-$(date +%H%M%S)"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 2
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CREATE';})()" >/dev/null; sleep 7
SID=$(sid_by_name "$A" "$SNAME"); echo "  SESSION_CREATED sid=$SID name='$SNAME'"
if [ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ]; then echo "FATAL: session introuvable"; exit 1; fi
echo "$SID" > "$OUT/dumps/sid.txt"
PIN=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s.pin;})()" | tr -d '"' | tail -1)
echo "  PIN=$PIN"
for dev in $B $C $DTCP; do
  a="0"; poll=0
  while [ "$poll" -lt 60 ]; do
    a=$(ev "$dev" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$SID';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()"); a="${a//\"/}"
    [ "$a" != "0" ] && break; sleep 3; poll=$((poll+3))
  done
  if [ "$a" = "0" ]; then echo "  FATAL: $dev ne voit pas $SID"; exit 1; fi
  echo "  ANNOUNCE_OK $dev $a"
  JH="${a%%:*}"; JP="${a##*:}"
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_PIN';})()" | tail -1 | sed 's/^/    /'
  poll=0; ok=no
  while [ "$poll" -lt 90 ]; do
    has=$(ev "$dev" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'yes':'no';})()"); has="${has//\"/}"
    [ "$has" = "yes" ] && { ok=yes; break; }; sleep 5; poll=$((poll+5))
  done
  if [ "$ok" != "yes" ]; then echo "  FATAL: $dev n'a pas rejoint"; exit 1; fi
  echo "  SESSION_JOINED $dev (t=${poll}s)"
  sleep 2
done
BDID=$(ev "$B" "MultiCamSessionWs.status().localDid" | tr -d '"'); CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" | tr -d '"'); DDID=$(ev "$DTCP" "MultiCamSessionWs.status().localDid" | tr -d '"')
echo "  BDID=$BDID CDID=$CDID DDID=$DDID" | tee "$OUT/dumps/dids.txt"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'B-Capture',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'C-Storage',enabledSkills:['storage']},['storage']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'D-Capture',enabledSkills:['capture']},['capture']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/members.txt"
echo "  membres: $(cat "$OUT/dumps/members.txt" 2>/dev/null)"
sleep 5

mark "PHASE 3 — MESURE IDLE (60 s)"
sleep 5
clear_logs
sleep 60
cap_counts "idle"
sed 's/^/  /' "$OUT/dumps/counts-idle.txt"

mark "PHASE 4 — Take court (REC 30 s, 2 captures + 1 storage) — pilotage injecté"
clear_logs
DRIVER="(function(){
  window.__j14b02_driver=(async function(){
    const sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
    const log=function(m){console.log('J14B02_DRIVER '+m);};
    try{
      var s=await MultiCamSessionStore.get('$SID');
      var prev=(s.takes||[]).length?(s.takes||[])[(s.takes||[]).length-1].takeNumber:0;
      var r=await MultiCamSessionWs.newTake(s);
      log('newtake prev='+prev+' tn='+r.takeNumber);
      await sleep(2500);
      MultiCamNav.show('take',{sid:'$SID'});
      await sleep(3500);
      var ca=document.getElementById('tkCaptureAll'); if(ca) ca.click();
      var sa=document.getElementById('tkStorageAll'); if(sa) sa.click();
      await sleep(6000);
      var s2=await MultiCamSessionStore.get('$SID');
      var t=(s2.takes||[])[(s2.takes||[]).length-1];
      log('participants ncap='+(t?t.captures.length:-1)+' nsto='+(t?t.storages.length:-1)+' caps='+JSON.stringify(t?t.captures:[]));
      MultiCamNav.show('arm',{sid:'$SID'});
      await sleep(18000);
      var b=document.getElementById('armRec');
      log('armrec present='+!!b+' disabled='+(b?b.disabled:'na'));
      if(b&&!b.disabled) b.click();
      await sleep(4000);
      var e=document.getElementById('armIncidentContinue');
      if(e&&!e.classList.contains('d-none')){e.click();log('incident_continue');}
      log('rec_start phase='+MultiCamStartService.view().phase);
      await sleep(30000);
      MultiCamStartService.requestStop('MEASURE');
      log('stop_requested');
      await sleep(6000);
      log('phase_after='+MultiCamStartService.view().phase);
      log('DONE');
    }catch(err){ log('ERROR '+err); }
  })();
  return 'DRIVER_STARTED';
})()"
echo -n "  inject="; ev "$A" "$DRIVER" | tail -1
echo "  attente du Take (poll DONE)…"
poll=0
while [ "$poll" -lt 200 ]; do
  adb -s "$A" logcat -d 2>/dev/null | grep -q 'J14B02_DRIVER DONE' && break
  sleep 5; poll=$((poll+5))
done
sleep 5
adb -s "$A" logcat -d 2>/dev/null | grep -E 'J14B02_DRIVER' | sed 's/.*J14B02_DRIVER/J14B02_DRIVER/' | tr -d '\r' | tee "$OUT/dumps/driver-markers.txt" | sed 's/^/    /'
cap_counts "take"
sed 's/^/  /' "$OUT/dumps/counts-take.txt"

mark "PHASE 5 — post-réplication (120 s)"
clear_logs
sleep 120
cap_counts "postrep"
sed 's/^/  /' "$OUT/dumps/counts-postrep.txt"

mark "TERMINÉ — evidence=$OUT sid=$SID"
echo "$LABEL" > "$OUT/dumps/label.txt"
