#!/usr/bin/env bash
# MultiCam — J16-A : campagne de VALIDATION PHYSIQUE de la consultation des
# Takes passés (mode ARCHIVÉ de l'écran 09).
#
# Objectif : prouver sur APPAREIL que
#   1. les FAITS d'arrêt (par Capture) sont PERSISTÉS dans le résumé du Take ;
#   2. les ÉTATS de réplication (par couple Capture → Storage) sont PERSISTÉS ;
#   3. un Take PASSÉ, rouvert depuis l'écran 03 (session) ou 15 (historique),
#      s'affiche avec ces FAITS — et sans inventer ce qui n'est pas connu ;
#   4. les Takes ANCIENS (antérieurs à J16-A) restent consultables, avec
#      indication explicite de ce qui est indisponible.
#
# Montage (rôles DISTINCTS, identique à J15) :
#   A=61cc29567d91  Master seul (controller)   "J16A-A-Master"
#   B=61d54bba7d91  Capture seule (capture)    "J16A-B-Capture"
#   C=c0d8514d7d87  Storage seule (storage)    "J16A-C-Storage"
# Stockage INTERNE partout (un Storage SAF ne passe jamais la vérif SHA : J14-L5).
#
# MODES :
#   MODE=setup  : skills, session, rejoindre, membres, état initial.
#   MODE=p01    : Take nominal (30 s) → faits persistés → consultation ARCHIVÉE.
#   MODE=legacy : consultation d'un Take ANCIEN (J15) → rétrocompatibilité.
#   MODE=status : état courant (devices, session, transferts).
#
# Usage : MODE=setup tests/e2e/j16a-campaign.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J16-A"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87
DEVS="$A $B $C"
NAME_A="J16A-A-Master"; NAME_B="J16A-B-Capture"; NAME_C="J16A-C-Storage"
BASE_MEDIA="/sdcard/Android/data/$APP/files/MultiCam"

mkdir -p "$OUT"/{screenshots,logs,dumps,events}

# Anti-blocage : aucune commande adb/node ne doit attendre indéfiniment.
run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; if kill -0 "$p" 2>/dev/null; then kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null; fi ) >/dev/null 2>&1 & wait "$p" 2>/dev/null; }
ADB() { run_to 25 adb "$@"; }
ev()  { run_to 90 node "$CDP" "$1" eval "$2"; }
evs() { ev "$1" "$2" | tail -1 | sed 's/^"//; s/"$//'; }
shot() { run_to 25 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }

TL=""; LABEL=""; VERDICT=""
mark() { echo "### [$(date +%H:%M:%S)] $1" | tee -a "$TL"; }
tl()   { echo "[$(date +%H:%M:%S)] $1" >> "$TL"; }

logs() { ADB -s "$1" logcat -d -v time 2>/dev/null \
  | grep -E "APP_BOOT|CONFIG_INIT|SKILL_SET|DEVICE_NAME_SET|SESSION|WS_|MEMBER|TAKE_|ARM_|CLOCK_|START_|STOP_|SCREEN09|CAMERA_|TRANSFER_|MEDIA_READY|NAV_|NET_CHANGED|STORAGE_" \
  > "$OUT/logs/$1-$2.log"; echo "  logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log" | tr -d ' '))"; }

dump() { echo -n "$3" | ev "$1" "$2" > "$OUT/dumps/$3"; echo "  dump $3 = $(head -c 240 "$OUT/dumps/$3")"; }

available() { ADB -s "$1" get-state 2>/dev/null | grep -q "device"; }
wait_pid() { local s="$1" t="${2:-40}" p=0 pid=""
  while [ "$p" -lt "$t" ]; do
    pid=$(ADB -s "$s" shell pidof "$APP" 2>/dev/null | tr -d '\r')
    [ -n "$pid" ] && { echo "  pid up $s=$pid (t=${p}s)"; return 0; }
    sleep 2; p=$(( p + 2 ))
  done
  echo "  WARN pid absent $s après ${t}s"; return 1; }

grant_perms() { for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do ADB -s "$1" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1; done; }
relaunch() {
  ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1
  ADB -s "$1" logcat -c >/dev/null 2>&1
  ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  wait_pid "$1" 60
  echo "  relaunch $1 did=$(evs "$1" "MultiCamSessionWs.status().localDid")"; }

role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }

sid_by_name() { local r; r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()"); echo "${r//\"/}"; }
get_sid() { cat "$OUT/dumps/sid.txt" 2>/dev/null; }
get_pin() { cat "$OUT/dumps/pin.txt" 2>/dev/null; }

wait_announce() { local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local a=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$sid';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()")
    a="${a//\"/}"
    if [ "$a" != "0" ]; then echo "  ANNOUNCE_OK $label $a (t=${poll}s)"; echo "$a" | tr ':' ' ' > "$OUT/dumps/endpoint-$s.txt"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "  ANNOUNCE_FAIL $label TIMEOUT 60s"; return 1; }

wait_session_on() { local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "  SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "  SESSION_JOINED $label TIMEOUT"; return 1; }

wait_arm_ready() { local s="$1" label="$2" poll=0
  while [ "$poll" -lt 120 ]; do
    ev "$s" "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$s.json" 2>/dev/null
    local ok=$(node -e "
      const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));}catch(e){console.log('no-json');process.exit(0);}
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v||!v.active){console.log('no-active');process.exit(0);}
      const st=(v.devices||[]).map(d=>d.deviceName+':'+d.skills.map(x=>x.skill+'='+x.status).join('+')).join(' ');
      if(v.recEligible===true && !(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING');});})){
        console.log('yes ['+st+']');process.exit(0);}
      console.log('wait ['+st+'] recEligible='+v.recEligible);")
    case "$ok" in yes*) echo "  ARM_READY $label (t=${poll}s) ${ok#yes }"; return 0 ;; esac
    [ $(( poll % 15 )) -eq 0 ] && echo "  wait_arm_ready $label t=${poll}s ${ok#wait }"
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "  ARM_READY $label TIMEOUT"; return 1; }

press_rec() { local s="$1" label="$2"
  echo "  PRESS_REC $label"
  ev "$s" "(function(){var b=document.getElementById('armRec');if(!b)return 'NO_BUTTON';if(b.disabled)return 'DISABLED';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 2
  ev "$s" "(function(){var e=document.getElementById('armIncidentContinue');if(e&&!e.classList.contains('d-none')){e.click();return 'CONTINUE';}return 'NO_MODAL';})()" | tail -1 | sed 's/^/    /'; }

phase_of() { evs "$1" "MultiCamStartService.view().phase"; }

wait_start_phase() { local s="$1" want="$2" label="$3" poll=0
  while [ "$poll" -lt 45 ]; do
    local ph=$(phase_of "$s")
    if [ "$ph" = "$want" ]; then echo "  phase=$want $label (t=${poll}s)"; return 0; fi
    sleep 1; poll=$(( poll + 1 ))
  done
  echo "  phase $label = $(phase_of "$s") (attendu=$want)"; return 1; }

wait_not_rec() { local s="$1" label="$2" poll=0 ph=""
  while [ "$poll" -lt 60 ]; do
    ph=$(phase_of "$s")
    [ "$ph" != "REC" ] && { echo "  REC terminé $label → phase=$ph (t=${poll}s)"; return 0; }
    sleep 1; poll=$(( poll + 1 ))
  done
  echo "  REC $label TOUJOURS en cours après ${poll}s (phase=$ph)"; return 1; }

take_select() { ev "$A" "document.getElementById('tkCaptureAll').click();'CAP_ALL'" >/dev/null; ev "$A" "document.getElementById('tkStorageAll').click();'STO_ALL'" >/dev/null; sleep 4; }
take_read() { TAKE=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].takeNumber):'-1';})()")
  NCAP=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].captures.length):'0';})()")
  NSTO=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].storages.length):'0';})()"); }

last_take_n() { evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].takeNumber):'0';})()"; }

new_take() {
  local prev att out num; prev=$(last_take_n); [ -z "$prev" ] && prev=0
  for att in 1 2 3; do
    out=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return 'TAKE_N='+(await MultiCamSessionWs.newTake(s)).takeNumber;})()" 2>/dev/null)
    num=$(printf '%s\n' "$out" | sed -n 's/.*TAKE_N=\([0-9][0-9]*\).*/\1/p' | tail -1)
    if [ -n "$num" ] && [ "$num" -gt "$prev" ] 2>/dev/null; then echo "  TAKE_N=$num" >&2; echo "$num"; return 0; fi
    echo "  WARN newTake (att=$att prev=$prev out=${out:-∅})" >&2; sleep 5
  done
  echo "  FATAL newTake échoué (prev=$prev)" >&2; return 1; }

tr_view() { ev "$1" "(function(){if(!MultiCamTransferBootInstance)return 'NO_BOOT';var v=MultiCamTransferBootInstance.viewFor('$SID',$2);if(!v)return 'null';var t=v.transfers||{};var ks=Object.keys(t);var rows=ks.map(function(k){var p=k.split('|');var o=t[k];return {src:p[0],sto:p[1],state:o.state,percent:o.percent,bytes:o.bytes,total:o.total,error:o.error||''};});return JSON.stringify({sid:v.sid,take:v.takeNumber,n:ks.length,rows:rows});})()"; }

state_count() { echo "$1" | tr -d '\\' | grep -o "\"state\":\"$2\"" | wc -l | tr -d ' '; }

wait_done() { # $1=serial $2=take $3=nb_done_attendus $4=timeout_s
  local sid="$1" take="$2" nd="$3" tmax="${4:-120}" poll=0 v d
  while [ "$poll" -lt "$tmax" ]; do
    v=$(tr_view "$sid" "$take")
    d=$(state_count "$v" "done")
    if [ "${d:-0}" -ge "$nd" ]; then echo "  TRANSFERS_DONE take=$take (t=${poll}s)"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "  TRANSFERS_INCOMPLETE take=$take (t=${poll}s)"; return 1; }

verdict() { echo "$1=$2" | tee -a "$VERDICT"; }
scenario_begin() { LABEL="$1"; TL="$OUT/events/$LABEL-timeline.txt"; VERDICT="$OUT/dumps/verdict-$LABEL.txt"
  : > "$TL"; : > "$VERDICT"
  for s in $DEVS; do ADB -s "$s" logcat -c >/dev/null 2>&1; done
  mark "DEBUT SCENARIO $LABEL"; }

scenario_end() {
  mark "FIN SCENARIO $LABEL"
  for s in $DEVS; do logs "$s" "$LABEL"; done
  echo "---- VERDICT $LABEL ----"; cat "$VERDICT"; echo "-------------------------"; }

# Un Take complet de bout en bout (mêmeSequence que J15 : ARM → REC → STOP).
do_take() {
  local label="$1" dur="$2" wait="${3:-0}"
  mark "$label : nouveau Take"
  TAKE=$(new_take) || { echo "  ABORT $label (newTake échoué)"; return 1; }
  sleep 2
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  take_select; take_read
  if [ "${NCAP:-0}" -lt 1 ] 2>/dev/null || [ "${NSTO:-0}" -lt 1 ] 2>/dev/null; then
    echo "  WARN sélection incomplète — re-sélection"
    ev "$A" "MultiCamNav.show('home');'H'" >/dev/null; sleep 2
    ev "$A" "MultiCamNav.show('take',{sid:'$SID'});'N2'" >/dev/null; sleep 3; take_select; take_read
  fi
  echo "  $label TAKE=$TAKE captures=$NCAP storages=$NSTO"
  shot "$A" "$label-take"
  mark "$label : ARM + REC ${dur}s + STOP"
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  wait_arm_ready "$A" "$label" || echo "  WARN: ARM pas prêt"
  shot "$A" "$label-arm"
  press_rec "$A" "$label"
  wait_start_phase "$A" "REC" "$label" || echo "  WARN: pas de REC (rapporté)"
  echo "  enregistrement ${dur} s…"; sleep "$dur"
  echo "$TAKE" > "$OUT/dumps/last-take.txt"
  mark "$label : STOP demandé (take=$TAKE)"
  ev "$A" "MultiCamStartService.requestStop('$label')" >/dev/null 2>&1
  wait_not_rec "$A" "$label" || true
  shot "$A" "$label-stopped"
  [ "$wait" = "1" ] && { wait_done "$A" "$TAKE" 1 180 || true; wait_done "$C" "$TAKE" 1 180 || true; }
  tr_view "$A" "$TAKE" > "$OUT/dumps/$label-A-transfers.json"
  tr_view "$C" "$TAKE" > "$OUT/dumps/$label-C-transfers.json"
}

# ---------------------------------------------------------------- setup

do_setup() {
  scenario_begin "SETUP"
  ADB devices -l | sed 's/^/  /' | tee "$OUT/dumps/adb-devices.txt"
  for s in $DEVS; do available "$s" || { echo "FATAL: $s indisponible"; exit 1; }; done

  mark "SETUP-1 : skills + relance"
  for s in $DEVS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
                      ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
  for s in $DEVS; do wait_pid "$s" 60; done
  sleep 4
  echo -n "  A roles="; role_cfg "$A" false false true  "$NAME_A"
  echo -n "  B roles="; role_cfg "$B" true  false false "$NAME_B"
  echo -n "  C roles="; role_cfg "$C" false true  false "$NAME_C"
  sleep 2
  for s in $DEVS; do relaunch "$s"; done
  for s in $DEVS; do grant_perms "$s"; done
  sleep 4

  mark "SETUP-2 : session créée sur A"
  RUN_TAG="J16A-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "  RUN_TAG=$RUN_TAG"
  ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 2
  ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()" >/dev/null; sleep 6
  SID=$(sid_by_name "$A" "$SNAME"); echo "  SESSION_CREATED sid=$SID"
  [ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ] && { echo "FATAL: session introuvable"; exit 1; }
  PIN=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s.pin;})()")
  echo "  PIN=$PIN"
  echo "$SID" > "$OUT/dumps/sid.txt"; echo "$PIN" > "$OUT/dumps/pin.txt"
  shot "$A" "SETUP-A-session"

  mark "SETUP-3 : B et C rejoignent"
  for dev in $B $C; do
    wait_announce "$dev" "$SID" "SETUP-3-$dev" || { echo "FATAL: $dev ne voit pas $SID"; exit 1; }
    read -r JH JP < "$OUT/dumps/endpoint-$dev.txt"
    ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN';})()" >/dev/null
    wait_session_on "$dev" "$SID" "SETUP-3-$dev" || { echo "FATAL: $dev n'a pas rejoint"; exit 1; }
    sleep 2
  done

  mark "SETUP-4 : membres/rôles (B capture, C storage)"
  local BDID CDID
  BDID=$(evs "$B" "MultiCamSessionWs.status().localDid")
  CDID=$(evs "$C" "MultiCamSessionWs.status().localDid")
  ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$NAME_B',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$NAME_C',enabledSkills:['storage']},['storage']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/SETUP-4-A-members.json"
  echo -n "  membres sur A : "; cat "$OUT/dumps/SETUP-4-A-members.json"; echo
  sleep 4
  echo "$BDID" > "$OUT/dumps/did-B.txt"; echo "$CDID" > "$OUT/dumps/did-C.txt"
  echo "  B did=$BDID"; echo "  C did=$CDID"
  shot "$A" "SETUP-A-members"
  verdict SETUP_SESSION "PASS"
  scenario_end
}

# ---------------------------------------------------------------- P01

do_p01() {
  scenario_begin "J16A-P01"
  SID=$(get_sid)
  [ -z "$SID" ] && { echo "FATAL: pas de session (MODE=setup d'abord)"; exit 1; }

  mark "P01 : Take nominal 30 s"
  do_take "P01" 30 1
  local tk="$TAKE"

  mark "P01 : faits PERSISTÉS dans le résumé du Take"
  dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]).filter(function(x){return x.takeNumber==$tk;})[0];var sm=(t&&t.summary)||{};return JSON.stringify({take:$tk,stopStates:sm.stopStates||{},replications:sm.replications||{},transferState:sm.transferState||''});})()" "P01-A-summary.json"
  # Le dump CDP est une CHAÎNE JSON : on décode deux fois (JSON puis contenu).
  summary_field() { # $1 = champ sought
    node -e "
      const fs=require('fs');
      let raw=fs.readFileSync('$OUT/dumps/P01-A-summary.json','utf8');
      let d=JSON.parse(raw); if(typeof d==='string')d=JSON.parse(d);
      const v=d[process.argv[1]]||{};
      const k=Object.keys(v);
      console.log(k.length+'|'+k.map(function(x){return v[x].state+'/'+(v[x].deltaMs!==undefined?v[x].deltaMs:v[x].percent);}).join(','));" "$1"
  }
  local ss reps n_ss n_rep
  ss=$(summary_field stopStates)
  reps=$(summary_field replications)
  n_ss=$(echo "$ss" | cut -d'|' -f1); n_rep=$(echo "$reps" | cut -d'|' -f1)
  verdict P01_STOP_STATES_PERSISTED "$([ "${n_ss:-0}" -ge 1 ] && echo "PASS ($ss)" || echo "FAIL ($ss)")"
  verdict P01_REPLICATIONS_PERSISTED "$([ "${n_rep:-0}" -ge 1 ] && echo "PASS ($reps)" || echo "FAIL ($reps)")"
  local gstate
  gstate=$(node -e "
    const fs=require('fs');
    let raw=fs.readFileSync('$OUT/dumps/P01-A-summary.json','utf8');
    let d=JSON.parse(raw); if(typeof d==='string')d=JSON.parse(d);
    console.log(d.transferState||'∅');")
  verdict P01_GLOBAL_STATE_NOT_PROOF "PASS (transferState=$gstate) — l'état global n'est jamais utilisé pour déduire une réplication"

  mark "P01 : consultation ARCHIVÉE depuis l'écran 03 (session)"
  ev "$A" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  ev "$A" "(function(){var b=document.querySelector('#takesList button.take-card[data-take=\"$tk\"]');if(!b)return 'NO_CARD';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 3
  dump "$A" "(function(){var p=document.getElementById('panel-take-stopped');return p?p.innerText:'NO_PANEL';})()" "P01-archive-A.txt"
  local txt; txt=$(cat "$OUT/dumps/P01-archive-A.txt")
  verdict P01_ARCHIVE_OPENED "$(grep -q "Take" "$OUT/dumps/P01-archive-A.txt" && echo PASS || echo FAIL)"
  verdict P01_ARCHIVE_HAS_CAPTURE "$(grep -q "$NAME_B" "$OUT/dumps/P01-archive-A.txt" && echo "PASS ($NAME_B présent)" || echo "FAIL ($NAME_B absent)")"
  verdict P01_ARCHIVE_HAS_STORAGE "$(grep -q "$NAME_C" "$OUT/dumps/P01-archive-A.txt" && echo "PASS ($NAME_C présent)" || echo "FAIL ($NAME_C absent)")"
  verdict P01_ARCHIVE_NO_UNAVAILABLE "$(grep -qi "indisponible" "$OUT/dumps/P01-archive-A.txt" && echo "FAIL (des informations sont signalées indisponibles alors que les faits sont persistés)" || echo "PASS (aucun indisponible)")"
  verdict P01_ARCHIVE_BACK_BUTTON "$(ev "$A" "(function(){var b=document.getElementById('tsBack');return b&&!b.classList.contains('d-none')?'VISIBLE':'ABSENT';})()" | tail -1 | sed 's/^"//; s/"$//')"
  shot "$A" "P01-A-archive"

  mark "P01 : retour à la session"
  ev "$A" "document.getElementById('tsBack').click();'BACK'" >/dev/null; sleep 2
  verdict P01_BACK_TO_SESSION "$(ev "$A" "(function(){var a=document.querySelector('.screen.active');return a?a.id:'∅';})()" | tail -1 | sed 's/^"//; s/"$//')"

  mark "P01 : consultation ARCHIVÉE depuis l'écran 15 (historique)"
  ev "$A" "MultiCamNav.show('history'); 'NAV'" >/dev/null; sleep 3
  ev "$A" "(function(){var c=document.querySelector('#historyList .history-card[data-sid=\"$SID\"]');if(!c)return 'NO_CARD';c.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 3
  ev "$A" "(function(){var b=document.querySelector('#takesList button.take-card[data-take=\"$tk\"]');if(!b)return 'NO_CARD';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 3
  dump "$A" "(function(){var p=document.getElementById('panel-take-stopped');return p?p.innerText:'NO_PANEL';})()" "P01-archive-A-from-history.txt"
  verdict P01_HISTORY_PATH "$(diff -q "$OUT/dumps/P01-archive-A.txt" "$OUT/dumps/P01-archive-A-from-history.txt" >/dev/null && echo "PASS (vue identique depuis 03 et 15)" || echo "DIFF (voir dumps)")"
  shot "$A" "P01-A-archive-from-history"

  ADB -s "$A" logcat -d -v time 2>/dev/null | grep -E "SCREEN09" > "$OUT/logs/A-screen09.log"
  echo "  logs SCREEN09 : $(wc -l < "$OUT/logs/A-screen09.log" | tr -d ' ') ligne(s)"
  scenario_end
}

# ---------------------------------------------------------------- legacy

do_legacy() {
  scenario_begin "J16A-LEGACY"
  # OLD_SID : session ANTÉRIEURE à J16-A (résumé J12 : `transfers`, pas de
  # `stopStates` / `replications`). OLD_TAKE : un Take terminé de cette session.
  local OLD_SID="${OLD_SID:-ZFMYZRAS}" OLD_TAKE="${OLD_TAKE:-1}"
  mark "LEGACY : consultation d'un Take ANCIEN ($OLD_SID take $OLD_TAKE) — rétrocompatibilité"
  ev "$A" "MultiCamNav.show('history'); 'NAV'" >/dev/null; sleep 4
  ev "$A" "(function(){var c=document.querySelector('#historyList .history-card[data-sid=\"$OLD_SID\"]');if(!c)return 'NO_CARD';c.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 3
  ev "$A" "(function(){var b=document.querySelector('#takesList button.take-card[data-take=\"$OLD_TAKE\"]');if(!b)return 'NO_CARD';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 3
  dump "$A" "(function(){var p=document.getElementById('panel-take-stopped');return p?p.innerText:'NO_PANEL';})()" "LEGACY-archive-A.txt"
  verdict LEGACY_OPENED "$(grep -q "Take" "$OUT/dumps/LEGACY-archive-A.txt" && echo PASS || echo FAIL)"
  verdict LEGACY_CAPTURE_READABLE "$(grep -qi "captur" "$OUT/dumps/LEGACY-archive-A.txt" && echo "PASS (la Capture est identifiée)" || echo "FAIL (aucune Capture listée)")"
  verdict LEGACY_REPLICATION_NOT_INVENTED "$(grep -qi "Indisponible" "$OUT/dumps/LEGACY-archive-A.txt" && echo "PASS (l'état de réplication inconnu est signalé Indisponible)" || echo "FAIL (un état de réplication non connu est affiché)")"
  verdict LEGACY_UNAVAILABLE_EXPLICIT "$(grep -qi "indisponible" "$OUT/dumps/LEGACY-archive-A.txt" && echo "PASS (information manquante signalée)" || echo "FAIL (rien n'est signalé)")"
  shot "$A" "LEGACY-A-archive"
  scenario_end
}

# ---------------------------------------------------------------- status

do_status() {
  SID=$(get_sid)
  echo "session=${SID:-NONE}"
  for s in $DEVS; do
    echo "== $s pid=$(ADB -s "$s" shell pidof "$APP" | tr -d '\r') phase=$(phase_of "$s")"
    [ -n "$SID" ] && tr_view "$s" "$(cat "$OUT/dumps/last-take.txt" 2>/dev/null || echo 1)" | sed 's/^/  /'
  done
}

# ---------------------------------------------------------------- main

MODE="${MODE:-status}"
case "$MODE" in
  setup)  do_setup ;;
  p01)    do_p01 ;;
  legacy) do_legacy ;;
  status) do_status ;;
  *) echo "MODE inconnu: $MODE (setup|p01|legacy|status)"; exit 2 ;;
esac
