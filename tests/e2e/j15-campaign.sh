#!/usr/bin/env bash
# MultiCam — J15 : campagne de VALIDATION PHYSIQUE de la reprise automatique.
#
# Pilote l'UI Cordova réelle (CDP) sur 3 appareils, produit screenshots, logcat,
# dumps, inventaires SHA-256 et chronologies dans tests/e2e/validation/J15/.
#
# Montage (rôles DISTINCTS) :
#   A=61cc29567d91  Master seul (controller)   "J15-A-Master"
#   B=61d54bba7d91  Capture seule (capture)    "J15-B-Capture"
#   C=c0d8514d7d87  Storage seule (storage)    "J15-C-Storage"
# Stockage INTERNE partout (un Storage SAF ne passe jamais la vérif SHA : J14-L5).
#
# MODES :
#   MODE=setup : skills, session, rejoindre, membres, état initial.
#   MODE=p01   : transfert nominal + SHA-256 + convergence des états.
#   MODE=p02   : coupure Wi-Fi C pendant transfert → reprise auto + SHA.
#   MODE=p03   : coupure + redémarrage app Storage → journal + reprise auto.
#   MODE=p04   : deux Takes successifs (reprise du 1er sans gêner le 2e).
#   MODE=p05   : suppression locale STRICTEMENT post-réplication vérifiée.
#   MODE=status: état courant (devices, session, transferts).
#
# Usage : MODE=setup tests/e2e/j15-campaign.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J15"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87
DEVS="$A $B $C"
NAME_A="J15-A-Master"; NAME_B="J15-B-Capture"; NAME_C="J15-C-Storage"
BASE_MEDIA="/sdcard/Android/data/$APP/files/MultiCam"

mkdir -p "$OUT"/{screenshots,logs,dumps,events}

# Anti-blocage : aucune commande adb/node ne doit attendre indéfiniment.
run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; if kill -0 "$p" 2>/dev/null; then kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null; fi ) >/dev/null 2>&1 & wait "$p" 2>/dev/null; }
ADB() { run_to 25 adb "$@"; }
ev()  { run_to 90 node "$CDP" "$1" eval "$2"; }
evs() { ev "$1" "$2" | tail -1 | sed 's/^"//; s/"$//'; }
shot() { run_to 25 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }

TL=""
mark() { echo "### [$(date +%H:%M:%S)] $1" | tee -a "$TL"; }
tl()   { echo "[$(date +%H:%M:%S)] $1" >> "$TL"; }

logs() { ADB -s "$1" logcat -d -v time 2>/dev/null \
  | grep -E "APP_BOOT|CONFIG_INIT|SKILL_SET|DEVICE_NAME_SET|SESSION|WS_|MEMBER|TAKE_|ARM_|CLOCK_|START_|STOP_|CAMERA_|TRANSFER_|MEDIA_READY|NAV_|NET_CHANGED|STORAGE_|CorHttpd|MultiCamTransfer" \
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
      if(v.recEligible===true && !(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});})){
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

# Option du Take sur A : suppression locale après réplication.
# Pilote le vrai switch #tkDeleteLocal (même chemin que l'utilisateur :
# change → enqueueTakeUpdate → upsertTake → broadcast aux pairs).
set_delete_local() { # $1 = true|false
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'});'NAV'" >/dev/null; sleep 4
  ev "$A" "(function(){var e=document.getElementById('tkDeleteLocal');if(!e)return 'NO_CB';e.checked=$1;e.dispatchEvent(new Event('change',{bubbles:true}));return 'CB_'+$1;})()" | tail -1 | sed 's/^/  set_delete_local /'
  sleep 5
  local got; got=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);if(!t.length)return 'NO_TAKE';return String(t[t.length-1].settings.deleteLocalAfterVerifiedReplication);})()")
  echo "  deleteLocalAfterVerifiedReplication(lu=$got attendu=$1)"
  [ "$got" = "$1" ]
}

tr_view() { ev "$1" "(function(){if(!MultiCamTransferBootInstance)return 'NO_BOOT';var v=MultiCamTransferBootInstance.viewFor('$SID',$2);if(!v)return 'null';var t=v.transfers||{};var ks=Object.keys(t);var rows=ks.map(function(k){var p=k.split('|');var o=t[k];return {src:p[0],sto:p[1],state:o.state,percent:o.percent,bytes:o.bytes,total:o.total,error:o.error||'',files:(o.files||[]).map(function(f){return {rel:f.rel,state:f.state,received:f.received,bytes:f.bytes};})};});return JSON.stringify({sid:v.sid,take:v.takeNumber,n:ks.length,rows:rows});})()"; }

state_count() { echo "$1" | tr -d '\\' | grep -o "\"state\":\"$2\"" | wc -l | tr -d ' '; }
bytes_max() { echo "$1" | tr -d '\\' | grep -oE '"received":[0-9]+' | cut -d: -f2 | sort -n | tail -1; }
states_of() { echo "$1" | tr -d '\\' | grep -oE '"state":"[a-z_]+"' | sort | uniq -c | tr '\n' ' '; }

wait_done() { # $1=serial $2=take $3=nb_done_attendus $4=timeout_s
  local sid="$1" take="$2" nd="$3" tmax="${4:-120}" poll=0 v d
  while [ "$poll" -lt "$tmax" ]; do
    v=$(tr_view "$sid" "$take")
    d=$(state_count "$v" "done")
    if [ "${d:-0}" -ge "$nd" ]; then echo "  TRANSFERS_DONE take=$take (t=${poll}s) $v"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "  TRANSFERS_INCOMPLETE take=$take (t=${poll}s) $v"; return 1; }

# Inventaire SHA-256 d'un Take sur un device (source ou destination).
inventory() { # $1=serial $2=take $3=tag
  local s="$1"; local tk="$2"; local tag="$3"; local f="$OUT/dumps/sha-$tag.txt"
  { echo "# sha256 $tag serial=$s take=$tk date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      local b h
      b=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
      h=$(ADB -s "$s" shell "sha256sum '$p' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
      echo "$p sha256=$h bytes=${b:-0}"
    done < <(ADB -s "$s" shell "find $BASE_MEDIA/$SID/$tk -type f -size +0c 2>/dev/null" | tr -d '\r')
  } > "$f"
  echo "  inventory $tag : $(grep -c sha256= "$f" | tr -d ' ') fichier(s) → $f"
}

count_files() { ADB -s "$1" shell "find $BASE_MEDIA/$2 -type f -size +0c 2>/dev/null | wc -l" | tr -d '\r' | tr -d ' '; }

wifi() { # $1=serial $2=disable|enable
  ADB -s "$1" shell "svc wifi $2" >/dev/null 2>&1
  mark "WIFI_$2 $1"
  tl "WIFI_$2 serial=$1"
}

verdict() { echo "$1=$2" | tee -a "$VERDICT"; }
scenario_begin() { LABEL="$1"; TL="$OUT/events/$LABEL-timeline.txt"; VERDICT="$OUT/dumps/verdict-$LABEL.txt"
  : > "$TL"; : > "$VERDICT"
  for s in $DEVS; do ADB -s "$s" logcat -c >/dev/null 2>&1; done
  mark "DEBUT SCENARIO $LABEL"; }

scenario_end() {
  mark "FIN SCENARIO $LABEL"
  for s in $DEVS; do logs "$s" "$LABEL"; done
  echo "---- VERDICT $LABEL ----"; cat "$VERDICT"; echo "-------------------------"; }

# Un Take complet de bout en bout.
#  $1=label  $2=durée REC (s)  $3=attendre_transferts(0/1)
#  $4=deleteLocalAfterVerifiedReplication (vide = ne pas toucher)
#  $5=watch(0/1) : après STOP, surveille C jusqu'aux premiers octets reçus
#                  (globals WATCH_OK/WATCH_BYTES/WATCH_TAKE pour la coupure).
do_take() {
  local label="$1" dur="$2" wait="${3:-0}" del="${4:-}" watch="${5:-0}"
  WATCH_OK=0; WATCH_BYTES=0; WATCH_TAKE=""
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
  echo "  $label TAKE=$TAKE captures=$NCAP storages=$NSTO (attendu 1/1)"
  if [ -n "$del" ]; then set_delete_local "$del" || echo "  WARN: deleteLocal non appliqué (attendu=$del)"; fi
  shot "$A" "$label-take"
  mark "$label : ARM + REC ${dur}s + STOP"
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  wait_arm_ready "$A" "$label" || echo "  WARN: ARM pas prêt"
  shot "$A" "$label-arm"
  press_rec "$A" "$label"
  wait_start_phase "$A" "REC" "$label" || echo "  WARN: pas de REC (rapporté)"
  local bph; bph=$(phase_of "$B")
  [ "$bph" != "REC" ] && echo "  WARN: phase B = $bph (attendu REC)"
  shot "$B" "$label-rec"
  echo "  enregistrement ${dur} s…"; sleep "$dur"
  echo "$TAKE" > "$OUT/dumps/last-take.txt"
  mark "$label : STOP demandé (take=$TAKE)"
  ev "$A" "MultiCamStartService.requestStop('$label')" >/dev/null 2>&1

  if [ "$watch" = "1" ]; then
    WATCH_TAKE="$TAKE"
    mark "$label : surveillance C jusqu'aux premiers octets transférés"
    local poll=0 v
    while [ "$poll" -lt 60 ]; do
      v=$(tr_view "$C" "$TAKE"); WATCH_BYTES=$(bytes_max "$v")
      echo "  watch t=${poll}s bytes=${WATCH_BYTES:-0} $(states_of "$v")"
      if [ "${WATCH_BYTES:-0}" -gt 0 ] 2>/dev/null; then WATCH_OK=1; break; fi
      if echo "$v" | grep -q '"state":"done"'; then WATCH_OK=2; break; fi
      sleep 1; poll=$(( poll + 1 ))
    done
    echo "  WATCH_OK=$WATCH_OK WATCH_BYTES=$WATCH_BYTES" | tee -a "$TL"
    tr_view "$C" "$TAKE" > "$OUT/dumps/$label-C-watch.json"
  fi

  wait_not_rec "$A" "$label" || true
  for s in $DEVS; do echo "  $s phase=$(phase_of "$s")"; done
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
  for s in $DEVS; do
    local md5p; md5p=$(ADB -s "$s" shell "pm path $APP | sed 's/package://'" | tr -d '\r' | head -1)
    echo "  $s apk=$(ADB -s "$s" shell "md5sum $md5p" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
    echo "  $s boot=$(grep -oE "TRANSFER_BOOT_ARMED role=[a-z]+" <(ADB -s "$s" logcat -d 2>/dev/null | grep -E "APP_BOOT|TRANSFER_BOOT_ARMED" | tail -5) | tail -1)"
  done

  mark "SETUP-2 : session créée sur A"
  RUN_TAG="J15-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "  RUN_TAG=$RUN_TAG"
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
  scenario_begin "J15-P01"
  SID=$(get_sid)
  [ -z "$SID" ] && { echo "FATAL: pas de session (MODE=setup d'abord)"; exit 1; }
  mark "P01 : Take nominal (suppression locale INACTIVÉE pour pouvoir relever le SHA source)"
  do_take "P01" 45 0 false
  local tk="$TAKE"
  mark "P01 : inventaire SOURCE sur B (take=$tk)"
  inventory "$B" "$tk" "P01-source-B"
  local src_n; src_n=$(grep -c sha256= "$OUT/dumps/sha-P01-source-B.txt" | tr -d ' ')
  verdict P01_SOURCE_FILES "$([ "$src_n" -ge 1 ] 2>/dev/null && echo "PASS ($src_n fichier(s))" || echo "FAIL ($src_n)")"
  mark "P01 : attente transfert B→C"
  wait_done "$A" "$tk" 1 180 || true
  wait_done "$C" "$tk" 1 180 || true
  tr_view "$A" "$tk" > "$OUT/dumps/P01-A-transfers.json"
  tr_view "$C" "$tk" > "$OUT/dumps/P01-C-transfers.json"
  shot "$A" "P01-A-final"; shot "$C" "P01-C-final"

  local va vc st_a st_c
  va=$(cat "$OUT/dumps/P01-A-transfers.json"); vc=$(cat "$OUT/dumps/P01-C-transfers.json")
  st_a=$(state_count "$va" "done"); st_c=$(state_count "$vc" "done")
  verdict P01_STATE_MASTER "$([ "$st_a" -ge 1 ] && echo PASS || echo "FAIL (done=$st_a)")"
  verdict P01_STATE_STORAGE "$([ "$st_c" -ge 1 ] && echo PASS || echo "FAIL (done=$st_c)")"

  mark "P01 : inventaire DESTINATION sur C"
  inventory "$C" "$tk" "P01-dest-C"
  local cmp; cmp=$(node -e "
    const fs=require('fs');
    const rd=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.includes('sha256=')).map(l=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:{}}).filter(Boolean);
    const src=rd('$OUT/dumps/sha-P01-source-B.txt'), dst=rd('$OUT/dumps/sha-P01-dest-C.txt');
    if(!src.length||!dst.length){console.log('EMPTY src='+src.length+' dst='+dst.length);process.exit(0);}
    let ok=true,lines=[];
    for(const s of src){const d=dst.find(x=>x.base===s.base);
      if(!d){lines.push('MANQUANT '+s.base);ok=false;continue;}
      const shaOk=d.sha===s.sha, sizeOk=d.bytes===s.bytes;
      lines.push(s.base+' sha_src='+s.sha.slice(0,12)+' sha_dst='+d.sha.slice(0,12)+' '+(shaOk?'SHA_OK':'SHA_DIFF')+' '+(sizeOk?'SIZE_OK':'SIZE_DIFF(bytes '+s.bytes+'/'+d.bytes+')'));
      if(!shaOk) ok=false;}
    console.log(lines.join('\n'));console.log(ok?'COMPARE_OK':'COMPARE_FAIL');")
  echo "$cmp" > "$OUT/dumps/P01-sha-compare.txt"
  if echo "$cmp" | grep -q COMPARE_OK; then verdict P01_SHA256 "PASS (source == destination)"; else verdict P01_SHA256 "FAIL"; fi
  scenario_end
}

# ---------------------------------------------------------------- P02

do_p02() {
  scenario_begin "J15-P02"
  SID=$(get_sid)
  mark "P02 : Take de 120 s (fichier assez gros pour interrompre EN cours de transfert)"
  do_take "P02" 120 0 true 1
  local tk="$TAKE"

  if [ "$WATCH_OK" != "1" ]; then
    verdict P02_CUT "BLOCKED (transfert non interruptible: WATCH_OK=$WATCH_OK)"
    tr_view "$C" "$tk" > "$OUT/dumps/P02-C-transfers.json"; scenario_end; return 1
  fi
  local bytes_cut="$WATCH_BYTES"
  echo "$bytes_cut" > "$OUT/dumps/P02-bytes-at-cut.txt"
  tl "CUT wifi C bytes_at_cut=$bytes_cut"
  shot "$C" "P02-at-cut"
  inventory "$B" "$tk" "P02-source-B"   # source encore présente (transfert incomplet)
  wifi "$C" disable
  mark "P02 : coupure 30 s — état C pendant la coupure"
  sleep 12
  v=$(tr_view "$C" "$tk"); echo "$v" > "$OUT/dumps/P02-C-during-cut.json"
  tr_view "$A" "$tk" > "$OUT/dumps/P02-A-during-cut.json"
  echo "  état C pendant coupure : $(states_of "$v")"
  echo "  état A pendant coupure : $(states_of "$(tr_view "$A" "$tk")")"
  shot "$C" "P02-during-cut"
  local w err
  w=$(state_count "$v" "waiting_network"); err=$(state_count "$v" "error")
  verdict P02_WAITING_NETWORK "$([ "$w" -ge 1 ] && echo PASS || echo "FAIL (waiting=$w)")"
  verdict P02_NO_PREMATURE_TERMINAL "$([ "$err" -eq 0 ] && echo PASS || echo "FAIL (error=$err)")"
  local src_after_cut; src_after_cut=$(count_files "$B" "$SID/$tk")
  verdict P02_SOURCE_INTACT_DURING_CUT "$([ "$src_after_cut" -ge 1 ] && echo "PASS ($src_after_cut fichier(s))" || echo "FAIL")"
  sleep 18
  wifi "$C" enable
  mark "P02 : retour réseau — attente reprise automatique (sans action utilisateur)"
  local poll2=0 resumed=0
  while [ "$poll2" -lt 240 ]; do
    v=$(tr_view "$C" "$tk")
    echo "  post t=${poll2}s C=$(echo "$v" | tr -d '\\' | grep -oE '"state":"[a-z_]+"' | sort | uniq -c | tr '\n' ' ')"
    if [ "$(state_count "$v" "done")" -ge 1 ]; then resumed=1; echo "  P02 REPRISE → done (t=${poll2}s)"; break; fi
    sleep 5; poll2=$(( poll2 + 5 ))
  done
  verdict P02_AUTO_RESUME "$([ "$resumed" = "1" ] && echo "PASS (${poll2}s)" || echo "FAIL (aucune reprise en ${poll2}s)")"
  tr_view "$C" "$tk" > "$OUT/dumps/P02-C-transfers.json"
  tr_view "$A" "$tk" > "$OUT/dumps/P02-A-transfers.json"
  shot "$C" "P02-final"; shot "$A" "P02-final"

  mark "P02 : vérification intégrité finale"
  inventory "$C" "$tk" "P02-dest-C"
  local cmp; cmp=$(node -e "
    const fs=require('fs');
    const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
    const parse=t=>t.split('\n').filter(l=>l.includes('sha256=')).map(l=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:{}}).filter(Boolean);
    const src=parse(rd('$OUT/dumps/sha-P02-source-B.txt')), dst=parse(rd('$OUT/dumps/sha-P02-dest-C.txt'));
    if(!src.length||!dst.length){console.log('EMPTY src='+src.length+' dst='+dst.length);process.exit(0);}
    let ok=true,lines=[];
    for(const s of src){const d=dst.find(x=>x.base===s.base);
      if(!d){lines.push('MANQUANT '+s.base);ok=false;continue;}
      lines.push(s.base+' '+(d.sha===s.sha?'SHA_OK':'SHA_DIFF')+' '+(d.bytes===s.bytes?'SIZE_OK':'SIZE_DIFF'));
      if(d.sha!==s.sha) ok=false;}
    console.log(lines.join('\n'));console.log(ok?'COMPARE_OK':'COMPARE_FAIL');")
  echo "$cmp" > "$OUT/dumps/P02-sha-compare.txt"
  if echo "$cmp" | grep -q COMPARE_OK; then verdict P02_SHA256 "PASS (source == destination)"; else verdict P02_SHA256 "FAIL"; fi
  scenario_end
}

# ---------------------------------------------------------------- P03

do_p03() {
  scenario_begin "J15-P03"
  SID=$(get_sid)
  mark "P03 : Take de 120 s puis coupure Wi-Fi C + redémarrage de l'app Storage"
  do_take "P03" 120 0 true 1
  local tk="$TAKE"
  if [ "$WATCH_OK" != "1" ]; then
    verdict P03_CUT "BLOCKED (WATCH_OK=$WATCH_OK)"; tr_view "$C" "$tk" > "$OUT/dumps/P03-C-transfers.json"; scenario_end; return 1
  fi
  tl "CUT wifi C bytes_at_cut=$WATCH_BYTES"
  inventory "$B" "$tk" "P03-source-B"
  wifi "$C" disable
  sleep 10
  v=$(tr_view "$C" "$tk"); echo "$v" > "$OUT/dumps/P03-C-during-cut.json"
  local w; w=$(state_count "$v" "waiting_network")
  verdict P03_WAITING_BEFORE_RESTART "$([ "$w" -ge 1 ] && echo PASS || echo "FAIL (waiting=$w)")"

  mark "P03 : journal persistant sur C AVANT redémarrage"
  ADB -s "$C" shell "run-as $APP sh -c 'ls -la files/transfers/ 2>/dev/null'" | tr -d '\r' | tee "$OUT/dumps/P03-journal-before.txt"
  ADB -s "$C" shell "run-as $APP sh -c 'cat files/transfers/*.json 2>/dev/null'" | tr -d '\r' > "$OUT/dumps/P03-journal-content-before.json"
  local jn_before; jn_before=$(ADB -s "$C" shell "run-as $APP sh -c 'ls files/transfers/ 2>/dev/null | wc -l'" | tr -d '\r' | tr -d ' ')
  verdict P03_JOURNAL_FILE_BEFORE "$([ "${jn_before:-0}" -ge 1 ] && echo "PASS ($jn_before fichier(s))" || echo "FAIL ($jn_before)")"

  mark "P03 : force-stop + relance de l'app sur C (Wi-Fi toujours coupé)"
  ADB -s "$C" shell am force-stop "$APP" >/dev/null 2>&1
  sleep 3
  echo "  C pid après force-stop = $(ADB -s "$C" shell pidof "$APP" | tr -d '\r')"
  ADB -s "$C" logcat -c >/dev/null 2>&1
  ADB -s "$C" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  wait_pid "$C" 60
  sleep 10
  grant_perms "$C"
  dump "$C" "(function(){return JSON.stringify({did:MultiCamSessionWs.status().localDid,skills:MultiCamConfig.get().enabledSkills});})()" "P03-C-after-restart.json"
  shot "$C" "P03-after-restart"
  ADB -s "$C" shell "run-as $APP sh -c 'ls -la files/transfers/ 2>/dev/null'" | tr -d '\r' | tee "$OUT/dumps/P03-journal-after.txt"

  v=$(tr_view "$C" "$tk"); echo "$v" > "$OUT/dumps/P03-C-after-restart.json"
  echo "  état C après redémarrage (hors réseau) : $(states_of "$v")"
  local w2 d2 st_err jn_after
  w2=$(state_count "$v" "waiting_network"); d2=$(state_count "$v" "done"); st_err=$(state_count "$v" "error")
  jn_after=$(ADB -s "$C" shell "run-as $APP sh -c 'ls files/transfers/ 2>/dev/null | wc -l'" | tr -d '\r' | tr -d ' ')
  verdict P03_JOURNAL_FILE_AFTER_RESTART "$([ "${jn_after:-0}" -ge 1 ] && echo "PASS ($jn_after fichier(s) persistant)" || echo "FAIL ($jn_after)")"
  local did_after; did_after=$(evs "$C" "MultiCamSessionWs.status().localDid")
  verdict P03_DEVICE_ID_RESTORED "$([ -n "$did_after" ] && [ "$did_after" != "null" ] && [ "$did_after" = "$(cat "$OUT/dumps/did-C.txt" 2>/dev/null)" ] && echo "PASS ($did_after)" || echo "FAIL ($did_after)")"

  mark "P03 : retour réseau — restauration journal + reprise SANS action utilisateur"
  wifi "$C" enable
  local poll3=0 resumed=0 restored=0 recovered=0 err_seen=0
  while [ "$poll3" -lt 300 ]; do
    v=$(tr_view "$C" "$tk")
    echo "  post-t=${poll3}s C=$(states_of "$v")"
    [ "$restored" = "0" ] && ADB -s "$C" logcat -d 2>/dev/null | grep -q "TRANSFER_JOURNAL_APPLIED" && { restored=1; echo "  TRANSFER_JOURNAL_APPLIED à t=${poll3}s"; }
    if [ "$(state_count "$v" "waiting_network")" -ge 1 ] || [ "$(state_count "$v" "pending")" -ge 1 ] || [ "$(state_count "$v" "transferring")" -ge 1 ]; then recovered=1; fi
    [ "$(state_count "$v" "error")" -ge 1 ] && err_seen=1
    if [ "$(state_count "$v" "done")" -ge 1 ]; then resumed=1; echo "  P03 REPRISE → done (t=${poll3}s)"; break; fi
    sleep 5; poll3=$(( poll3 + 5 ))
  done
  ADB -s "$C" logcat -d -v time 2>/dev/null | grep -E "TRANSFER_JOURNAL|TRANSFER_RESUME|TRANSFER_OFFER|TRANSFER_WAITING|WS_|APP_BOOT" > "$OUT/logs/C-P03-restore.log"
  verdict P03_JOURNAL_RESTORED "$([ "$restored" = "1" ] && echo PASS || echo "FAIL (TRANSFER_JOURNAL_APPLIED absent)")"
  if [ "$recovered" = "1" ] || { [ "$restored" = "1" ] && [ "$resumed" = "1" ]; }; then verdict P03_STATE_RECOVERABLE "PASS (état restauré hors-ligne=$recovered, journal_applied=$restored)"; else verdict P03_STATE_RECOVERABLE "FAIL (w2=$w2 d2=$d2)"; fi
  verdict P03_NO_TERMINAL_ERROR "$([ "$err_seen" = "0" ] && echo PASS || echo "FAIL (état error observé)")"
  verdict P03_AUTO_RESUME "$([ "$resumed" = "1" ] && echo "PASS (${poll3}s)" || echo "FAIL (aucune reprise en ${poll3}s)")"
  tr_view "$C" "$tk" > "$OUT/dumps/P03-C-transfers.json"
  shot "$C" "P03-final"; shot "$A" "P03-final"

  mark "P03 : intégrité finale"
  inventory "$C" "$tk" "P03-dest-C"
  local cmp; cmp=$(node -e "
    const fs=require('fs');
    const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
    const parse=t=>t.split('\n').filter(l=>l.includes('sha256=')).map(l=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:{}}).filter(Boolean);
    const src=parse(rd('$OUT/dumps/sha-P03-source-B.txt')), dst=parse(rd('$OUT/dumps/sha-P03-dest-C.txt'));
    if(!src.length||!dst.length){console.log('EMPTY src='+src.length+' dst='+dst.length);process.exit(0);}
    let ok=true,lines=[];
    for(const s of src){const d=dst.find(x=>x.base===s.base);
      if(!d){lines.push('MANQUANT '+s.base);ok=false;continue;}
      lines.push(s.base+' '+(d.sha===s.sha?'SHA_OK':'SHA_DIFF')+' '+(d.bytes===s.bytes?'SIZE_OK':'SIZE_DIFF'));
      if(d.sha!==s.sha) ok=false;}
    console.log(lines.join('\n'));console.log(ok?'COMPARE_OK':'COMPARE_FAIL');")
  echo "$cmp" > "$OUT/dumps/P03-sha-compare.txt"
  if echo "$cmp" | grep -q COMPARE_OK; then verdict P03_SHA256 "PASS (source == destination)"; else verdict P03_SHA256 "FAIL"; fi
  scenario_end
}

# ---------------------------------------------------------------- P04

do_p04() {
  scenario_begin "J15-P04"
  SID=$(get_sid)
  mark "P04 : Take 1 (45 s) — coupure Wi-Fi C pendant son transfert"
  do_take "P04-T1" 90 0 false 1
  local t1="$TAKE"
  if [ "$WATCH_OK" = "1" ]; then wifi "$C" disable; tl "CUT wifi C (take1) bytes=$WATCH_BYTES"
  else tl "P04-T1 transfert non interrompu (WATCH_OK=$WATCH_OK) — coupure maintenue pour le Take 2"; wifi "$C" disable; fi
  sleep 5
  v=$(tr_view "$C" "$t1"); echo "$v" > "$OUT/dumps/P04-T1-waiting.json"
  local w1 d1t; w1=$(state_count "$v" "waiting_network"); d1t=$(state_count "$v" "done")
  if [ "${w1:-0}" -ge 1 ] || [ "${d1t:-0}" -ge 1 ]; then verdict P04_T1_WAITING_OR_DONE "PASS (waiting=$w1 done=$d1t)"; else verdict P04_T1_WAITING_OR_DONE "FAIL ($(states_of "$v"))"; fi
  inventory "$B" "$t1" "P04-T1-source-B"

  mark "P04 : Take 2 ENREGISTRÉ pendant que le Take 1 est en attente réseau"
  do_take "P04-T2" 45 0 false
  local t2="$TAKE"
  # Preuve : la REC du Take 2 s'est déroulée normalement malgré l'attente du Take 1.
  local ph n2; ph=$(phase_of "$A"); n2=$(count_files "$B" "$SID/$t2")
  if [ "$t2" != "$t1" ] && [ "${n2:-0}" -ge 1 ]; then verdict P04_T2_RECORDED "PASS (take $t1 → $t2, phase A=$ph, source=$n2 fichier(s))"
  else verdict P04_T2_RECORDED "FAIL (take $t1 → $t2, phase A=$ph, source=${n2:-0})"; fi
  inventory "$B" "$t2" "P04-T2-source-B"
  tr_view "$C" "$t1" > "$OUT/dumps/P04-T1-C-before-restore.json"
  tr_view "$C" "$t2" > "$OUT/dumps/P04-T2-C-before-restore.json"
  shot "$A" "P04-after-T2"; shot "$C" "P04-after-T2"

  mark "P04 : retour réseau — reprise des DIFFÉRÉS des deux Takes"
  wifi "$C" enable
  local poll2=0 ok1=0 ok2=0
  while [ "$poll2" -lt 300 ]; do
    local v1 v2; v1=$(tr_view "$C" "$t1"); v2=$(tr_view "$C" "$t2")
    echo "  t=${poll2}s T1=$(echo "$v1" | tr -d '\\' | grep -oE '"state":"[a-z_]+"' | sort | uniq -c | tr '\n' ' ') | T2=$(echo "$v2" | tr -d '\\' | grep -oE '"state":"[a-z_]+"' | sort | uniq -c | tr '\n' ' ')"
    [ "$(state_count "$v1" "done")" -ge 1 ] && ok1=1
    [ "$(state_count "$v2" "done")" -ge 1 ] && ok2=1
    [ "$ok1" = "1" ] && [ "$ok2" = "1" ] && break
    sleep 5; poll2=$(( poll2 + 5 ))
  done
  verdict P04_T1_RESUMED "$([ "$ok1" = "1" ] && echo "PASS" || echo "FAIL")"
  verdict P04_T2_TRANSFERRED "$([ "$ok2" = "1" ] && echo "PASS" || echo "FAIL")"
  tr_view "$C" "$t1" > "$OUT/dumps/P04-T1-C-final.json"
  tr_view "$C" "$t2" > "$OUT/dumps/P04-T2-C-final.json"
  shot "$C" "P04-final"

  mark "P04 : intégrité des deux Takes"
  inventory "$C" "$t1" "P04-T1-dest-C"
  inventory "$C" "$t2" "P04-T2-dest-C"
  local cmp; cmp=$(node -e "
    const fs=require('fs');
    const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
    const parse=t=>t.split('\n').filter(l=>l.includes('sha256=')).map(l=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:{}}).filter(Boolean);
    let ok=true,lines=[];
    for(const t of ['T1','T2']){
      const src=parse(rd('$OUT/dumps/sha-P04-'+t+'-source-B.txt')), dst=parse(rd('$OUT/dumps/sha-P04-'+t+'-dest-C.txt'));
      if(!src.length||!dst.length){lines.push(t+': EMPTY src='+src.length+' dst='+dst.length);ok=false;continue;}
      for(const s of src){const d=dst.find(x=>x.base===s.base);
        if(!d){lines.push(t+' MANQUANT '+s.base);ok=false;continue;}
        lines.push(t+' '+s.base+' '+(d.sha===s.sha?'SHA_OK':'SHA_DIFF')+' '+(d.bytes===s.bytes?'SIZE_OK':'SIZE_DIFF'));
        if(d.sha!==s.sha) ok=false;}}
    console.log(lines.join('\n'));console.log(ok?'COMPARE_OK':'COMPARE_FAIL');")
  echo "$cmp" > "$OUT/dumps/P04-sha-compare.txt"
  if echo "$cmp" | grep -q COMPARE_OK; then verdict P04_SHA256 "PASS (les 2 Takes)"; else verdict P04_SHA256 "FAIL"; fi
  scenario_end
}

# ---------------------------------------------------------------- P05

do_p05() {
  scenario_begin "J15-P05"
  SID=$(get_sid)
  mark "P05 : Take de 120 s — suppression locale à vérifier STRICTEMENT post-réplication"
  do_take "P05" 120 0 true 1
  local tk="$TAKE"
  local del_set; del_set=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].settings.deleteLocalAfterVerifiedReplication):'NO_TAKE';})()")
  verdict P05_DELETE_LOCAL_SETTING "$([ "$del_set" = "true" ] && echo "PASS (deleteLocalAfterVerifiedReplication=$del_set)" || echo "FAIL ($del_set)")"
  if [ "$WATCH_OK" != "1" ]; then
    verdict P05_CUT "BLOCKED (WATCH_OK=$WATCH_OK)"; tr_view "$C" "$tk" > "$OUT/dumps/P05-C-transfers.json"; scenario_end; return 1
  fi
  tl "CUT wifi C (P05) bytes_at_cut=$WATCH_BYTES"
  wifi "$C" disable
  sleep 12
  inventory "$B" "$tk" "P05-source-B"
  local n_wait; n_wait=$(count_files "$B" "$SID/$tk")
  verdict P05_SOURCE_PRESENT_WHILE_INCOMPLETE "$([ "$n_wait" -ge 1 ] && echo "PASS ($n_wait fichier(s) source encore présents)" || echo "FAIL (source déjà purgée)")"
  v=$(tr_view "$C" "$tk"); echo "$v" > "$OUT/dumps/P05-C-waiting.json"
  verdict P05_STORAGE_INCOMPLETE "$([ "$(state_count "$v" "done")" -eq 0 ] && echo PASS || echo "FAIL (done anticipé)")"
  shot "$B" "P05-source-present"; shot "$C" "P05-waiting"

  mark "P05 : retour réseau → réplication complète → suppression autorisée"
  wifi "$C" enable
  local poll2=0 resumed=0
  while [ "$poll2" -lt 240 ]; do
    v=$(tr_view "$C" "$tk")
    if [ "$(state_count "$v" "done")" -ge 1 ]; then resumed=1; break; fi
    sleep 5; poll2=$(( poll2 + 5 ))
  done
  verdict P05_REPLICATION_COMPLETED "$([ "$resumed" = "1" ] && echo "PASS (${poll2}s)" || echo "FAIL")"
  inventory "$C" "$tk" "P05-dest-C"

  # Suppression sur B : attendue après confirmation (transfer_delete → TRANSFER_LOCAL_DELETED).
  local poll3=0 deleted=0 n_after=999
  while [ "$poll3" -lt 120 ]; do
    n_after=$(count_files "$B" "$SID/$tk")
    if ADB -s "$B" logcat -d 2>/dev/null | grep -q "TRANSFER_LOCAL_DELETED"; then deleted=1; fi
    if [ "${n_after:-9}" = "0" ]; then deleted=1; break; fi
    sleep 5; poll3=$(( poll3 + 5 ))
  done
  echo "$n_after" > "$OUT/dumps/P05-source-files-after.txt"
  verdict P05_LOCAL_DELETE "$([ "$deleted" = "1" ] && echo "PASS (source purgée après confirmation)" || echo "FAIL (source encore présente: $n_after)")"
  shot "$B" "P05-after-delete"
  ADB -s "$B" logcat -d -v time 2>/dev/null | grep -E "TRANSFER_DELETE|TRANSFER_LOCAL|TRANSFER_RESULT|TRANSFER_HASH" > "$OUT/logs/B-P05-delete.log"
  ADB -s "$A" logcat -d -v time 2>/dev/null | grep -E "TRANSFER_DELETE|TRANSFER_RESULT|maybeRequestDelete" > "$OUT/logs/A-P05-delete.log"
  local l_done l_del
  l_done=$(grep -n "TRANSFER_RESULT" "$OUT/logs/B-P05-delete.log" | grep "state=done" | head -1 | cut -d: -f1)
  l_del=$(grep -n "TRANSFER_LOCAL_DELETED" "$OUT/logs/B-P05-delete.log" | head -1 | cut -d: -f1)
  verdict P05_DELETE_AFTER_DONE "$([ -n "${l_done:-}" ] && [ -n "${l_del:-}" ] && [ "$l_del" -gt "$l_done" ] && echo "PASS (state=done ligne $l_done < TRANSFER_LOCAL_DELETED ligne $l_del)" || echo "FAIL (done=${l_done:-∅} delete=${l_del:-∅})")"

  local cmp; cmp=$(node -e "
    const fs=require('fs');
    const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch(e){return ''}};
    const parse=t=>t.split('\n').filter(l=>l.includes('sha256=')).map(l=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:{}}).filter(Boolean);
    const src=parse(rd('$OUT/dumps/sha-P05-source-B.txt')), dst=parse(rd('$OUT/dumps/sha-P05-dest-C.txt'));
    if(!src.length||!dst.length){console.log('EMPTY src='+src.length+' dst='+dst.length);process.exit(0);}
    let ok=true,lines=[];
    for(const s of src){const d=dst.find(x=>x.base===s.base);
      if(!d){lines.push('MANQUANT '+s.base);ok=false;continue;}
      lines.push(s.base+' '+(d.sha===s.sha?'SHA_OK':'SHA_DIFF')+' '+(d.bytes===s.bytes?'SIZE_OK':'SIZE_DIFF'));
      if(d.sha!==s.sha) ok=false;}
    console.log(lines.join('\n'));console.log(ok?'COMPARE_OK':'COMPARE_FAIL');")
  echo "$cmp" > "$OUT/dumps/P05-sha-compare.txt"
  if echo "$cmp" | grep -q COMPARE_OK; then verdict P05_SHA256 "PASS (source == destination)"; else verdict P05_SHA256 "FAIL"; fi
  scenario_end
}

# ---------------------------------------------------------------- status

do_status() {
  SID=$(get_sid)
  echo "session=${SID:-NONE}"
  for s in $DEVS; do
    echo "== $s pid=$(ADB -s "$s" shell pidof "$APP" | tr -d '\r') phase=$(phase_of "$s") wifi=$(ADB -s "$s" shell 'dumpsys wifi 2>/dev/null | head -1' | tr -d '\r')"
    [ -n "$SID" ] && tr_view "$s" "$(cat "$OUT/dumps/last-take.txt" 2>/dev/null || echo 1)" | sed 's/^/  /'
  done
}

# ---------------------------------------------------------------- main

MODE="${MODE:-status}"
case "$MODE" in
  setup)  do_setup ;;
  p01)    do_p01 ;;
  p02)    do_p02 ;;
  p03)    do_p03 ;;
  p04)    do_p04 ;;
  p05)    do_p05 ;;
  status) do_status ;;
  *) echo "MODE inconnu: $MODE (setup|p01|p02|p03|p04|p05|status)"; exit 2 ;;
esac
