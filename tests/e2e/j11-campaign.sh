#!/usr/bin/env bash
# MultiCam — campagne de validation J11 (Transfert / Storage / réplication).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools). Captures d'écran,
# logcat et dumps JSON dans tests/e2e/validation/J11-transfert-storage/.
#
# Le device D (R83Y106V1HF) est OPTIONNEL : observé instable (déconnexions USB
# en boucle). S'il est présent, le montage devient multi-destination (2 storages)
# et valide l'indépendance des destinations ; sinon on tourne sur 3 devices
# stables (1 storage) et l'indépendance multi-destination reste couverte par les
# tests unitaires app/tests (j11-*).
#
# Montage (rôles DISTINCTS — un device multi-rôle n'est pas géré par le boot J11) :
#   A=61cc29567d91  Master seul (skill controller)
#   B=61d54bba7d91  Capture seule (skill capture)     → produit le média
#   C=c0d8514d7d87  Storage seul (skill storage)      → destination 1
#   D=R83Y106V1HF   Storage seul (skill storage)      → destination 2 (si stable)
#
# Le rôle du boot de transfert vient de `cfg.enabledSkills` (priorité
# controller > capture > storage) : il est CONFIGURÉ puis l'app relancée avant
# toute session (le boot est assemblé une fois au démarrage).
#
# Usage : tests/e2e/j11-campaign.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J11-transfert-storage"
CDP="$HERE/lib/cdp.js"
APK="$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk"

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
DOPT=R83Y106V1HF
APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

# Anti-blocage : aucune commande adb/node ne doit attendre indéfiniment (le
# « waiting for device » d'adb a déjà bloqué 30 min quand D a disparu).
run_to() { # secondes, commande...
  local t="$1"; shift
  ( "$@" ) & local p=$!
  ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) & local w=$!
  wait "$p" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null
  return $rc
}
ADB() { run_to 25 adb "$@"; }
ev()  { run_to 45 node "$CDP" "$1" eval "$2"; }

shot() { run_to 25 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
mark() { echo "### $1"; }

logs() { ADB -s "$1" logcat -d -v time 2>/dev/null \
  | grep -E "APP_BOOT|CONFIG_INIT|SKILL_SET|DEVICE_NAME_SET|SESSION|WS_|MEMBER|TAKE_|ARM_|CLOCK_|START_|STOP_|CAMERA_|TRANSFER_|MEDIA_READY|SCREEN0|NAV_AUTO" \
  > "$OUT/logs/$1-$2.log"; echo "logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log"))"; }
dump() { echo -n "$2" | ev "$1" "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(head -c 400 "$OUT/dumps/$3")"; }

json_field() {
  node -e "const fs=require('fs');let v=fs.readFileSync('$1','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}};const out=$2;console.log(out===undefined?'':out);"
}

available() { ADB -s "$1" get-state 2>/dev/null | grep -q "device"; }
dev_state() { ADB -s "$1" get-state 2>/dev/null | tr -d '\r' | head -1; }

grant_perms() {
  for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do
    ADB -s "$1" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1
  done
  echo "grant_perms $1 ok"
}

relaunch() {
  ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1
  ADB -s "$1" logcat -c >/dev/null 2>&1
  ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  sleep 8
  echo "relaunch $1 deviceId=$(ev "$1" "MultiCamSessionWs.status().localDid" 2>/dev/null)"
}

sid_by_name() {
  local r
  r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()")
  echo "${r//\"/}"
}

wait_announce() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local a=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$sid';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()")
    a="${a//\"/}"
    if [ "$a" != "0" ]; then echo "ANNOUNCE_OK $label $a (t=${poll}s)"; echo "$a" | tr ':' ' ' > "$OUT/dumps/endpoint-$s.txt"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "ANNOUNCE_FAIL $label TIMEOUT 60s"; return 1
}

wait_session_on() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SESSION_JOINED $label TIMEOUT"; return 1
}

wait_arm_ready() {
  local s="$1" label="$2" poll=0
  while [ "$poll" -lt 120 ]; do
    ev "$s" "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$s.json" 2>/dev/null
    local ok=$(node -e "
      const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));}catch(e){console.log('no-json');process.exit(0);}
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v||!v.active){console.log('no-active');process.exit(0);}
      const bad=(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});});
      const n=Object.keys(v.clock||{}).length;
      console.log(!bad&&n>0?'yes':'no-active/bad='+bad+'/clock='+n);
    ")
    echo "wait_arm_ready $label t=${poll}s $ok"
    case "$ok" in yes) echo "ARM_READY $label (t=${poll}s)"; return 0 ;; esac
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "ARM_READY $label TIMEOUT"; return 1
}

press_rec() {
  local s="$1" label="$2"
  echo "PRESS_REC $label"
  ev "$s" "(function(){var b=document.getElementById('armRec');if(!b)return 'NO_BUTTON';if(b.disabled)return 'DISABLED';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/  /'
  sleep 2
  shot "$s" "$label-after-press"
  ev "$s" "(function(){var e=document.getElementById('armIncidentContinue');if(e&&!e.classList.contains('d-none')){e.click();return 'CONTINUE';}return 'NO_MODAL';})()" | tail -1 | sed 's/^/  /'
}

wait_start_phase() {
  local s="$1" want="$2" label="$3" poll=0
  while [ "$poll" -lt 30 ]; do
    local ph=$(ev "$s" "MultiCamStartService.view().phase" | tr -d '"')
    echo "wait_start_phase $label t=${poll}s phase=$ph"
    if [ "$ph" = "$want" ]; then return 0; fi
    sleep 1; poll=$(( poll + 1 ))
  done
  echo "wait_start_phase $label TIMEOUT (attendu=$want)"; return 1
}

tr_view() {
  ev "$1" "(function(){if(!MultiCamTransferBootInstance)return 'NO_BOOT';var v=MultiCamTransferBootInstance.viewFor('$2',$3);if(!v)return 'null';var t=v.transfers||{};var ks=Object.keys(t);var rows=ks.map(function(k){var p=k.split('|');return {src:p[0],sto:p[1],state:t[k].state,percent:t[k].percent,bytes:t[k].bytes,total:t[k].total};});return JSON.stringify({sid:v.sid,take:v.takeNumber,n:ks.length,rows:rows});})()"
}

echo "==============================================================="
echo " MultiCam J11 — Transfert / Storage / réplication (campagne réelle)"
echo "==============================================================="

echo "############ J11-00 : devices + installation ############"
ADB devices -l | sed 's/^/  /' | tee "$OUT/dumps/adb-devices.txt"

for s in "$A" "$B" "$C"; do
  if ! available "$s"; then echo "FATAL: device stable $s indisponible"; exit 1; fi
done
PARTICIPANTS="$A $B $C"
STORAGES="$C"
HAS_D=0
if available "$DOPT"; then HAS_D=1; PARTICIPANTS="$A $B $C $DOPT"; STORAGES="$C $DOPT"; fi
NSTO_EXPECT=1; [ "$HAS_D" = "1" ] && NSTO_EXPECT=2
echo "PARTICIPANTS=$PARTICIPANTS (D present=$HAS_D, storages attendus=$NSTO_EXPECT)"

for s in $PARTICIPANTS; do
  if [ "${J11_SKIP_INSTALL:-0}" != "1" ] && [ -f "$APK" ]; then ADB -s "$s" install -r "$APK" 2>&1 | tail -1 | sed "s/^/  install $s: /"; fi
  grant_perms "$s"
done

echo "############ J11-01 : rôles configurés (enabledSkills) puis relance ############"
for s in $PARTICIPANTS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
sleep 8
role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }
echo -n "  A roles="; role_cfg "$A" false false true  "J11-A-Master"
echo -n "  B roles="; role_cfg "$B" true  false false "J11-B-Capture"
echo -n "  C roles="; role_cfg "$C" false true  false "J11-C-Storage1"
[ "$HAS_D" = "1" ] && { echo -n "  D roles="; role_cfg "$DOPT" false true false "J11-D-Storage2"; }
sleep 2
for s in $PARTICIPANTS; do relaunch "$s"; done
for s in $PARTICIPANTS; do logs "$s" "J11-01"; echo -n "  $s -> "; grep -oE "TRANSFER_BOOT_ARMED role=[a-z]+" "$OUT/logs/$s-J11-01.log" | tail -1 || echo "(pas de TRANSFER_BOOT_ARMED)"; done

echo "############ J11-02 : session créée sur A (Master) ############"
RUN_TAG="J11-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "RUN_TAG=$RUN_TAG"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()" >/dev/null
sleep 6
SID=$(sid_by_name "$A" "$SNAME")
echo "SESSION_CREATED sid=$SID name='$SNAME'"
if [ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ]; then echo "FATAL: session introuvable"; exit 1; fi
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,name:s.name,pin:s.pin});})()" "J11-02-A-created.json"
PIN=$(json_field "$OUT/dumps/J11-02-A-created.json" "v.pin")
echo "PIN=$PIN"; echo "$SID" > "$OUT/dumps/sid.txt"
shot "$A" "J11-02-A-session"

echo "############ J11-03 : les autres devices rejoignent la session ############"
ADID=$(ev "$A" "MultiCamSessionWs.status().localDid" | tr -d '"'); echo "DID A=$ADID"
declare_ids=""
for dev in $PARTICIPANTS; do
  [ "$dev" = "$A" ] && continue
  did=$(ev "$dev" "MultiCamSessionWs.status().localDid" | tr -d '"')
  echo "DID $dev=$did"
  declare_ids="$declare_ids
$dev=$did"
  if ! wait_announce "$dev" "$SID" "J11-03-$dev"; then echo "FATAL: $dev ne voit pas $SID"; exit 1; fi
  read -r JH JP < "$OUT/dumps/endpoint-$dev.txt"
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN';})()" >/dev/null
  wait_session_on "$dev" "$SID" "J11-03-$dev" || { echo "FATAL: $dev n'a pas rejoint"; exit 1; }
  sleep 2
done
printf '%s\n' "$declare_ids" > "$OUT/dumps/device-ids.txt"

echo "############ J11-04 : membres — B capture, storages, A master ############"
BDID=$(ev "$B" "MultiCamSessionWs.status().localDid" | tr -d '"')
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" | tr -d '"')
DDID=""; [ "$HAS_D" = "1" ] && DDID=$(ev "$DOPT" "MultiCamSessionWs.status().localDid" | tr -d '"')
ADD_ALL="var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'J11-B-Capture',enabledSkills:['capture']},['capture']);"
ADD_ALL="$ADD_ALL r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'J11-C-Storage1',enabledSkills:['storage']},['storage']);"
[ "$HAS_D" = "1" ] && ADD_ALL="$ADD_ALL r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'J11-D-Storage2',enabledSkills:['storage']},['storage']);"
# A (Master) N'EST PAS un membre : le Master vient de la création de session
# (liste `masters`). « controller » n'est pas un rôle de session VALID_ROLES.
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');$ADD_ALL return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/J11-04-A-members.json"
sleep 6
echo -n "  membres sur A : "; cat "$OUT/dumps/J11-04-A-members.json"; echo
shot "$A" "J11-04-A-members"

echo "############ J11-05 : Take — capture B + storages ############"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return 'TAKE_N='+(await MultiCamSessionWs.newTake(s)).takeNumber;})()" | tail -1 | sed 's/^/  /'
sleep 3
ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 3
take_select() { ev "$A" "document.getElementById('tkCaptureAll').click();'CAP_ALL'" >/dev/null; ev "$A" "document.getElementById('tkStorageAll').click();'STO_ALL'" >/dev/null; sleep 4; }
take_read() { TAKE=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return String(t?t.takeNumber:-1);})()" | tr -d '"'); NCAP=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return String(t?t.captures.length:-1);})()" | tr -d '"'); NSTO=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return String(t?t.storages.length:-1);})()" | tr -d '"'); }
take_select; take_read
if [ "${NCAP:-0}" -lt 1 ] 2>/dev/null || [ "${NSTO:-0}" -lt "$NSTO_EXPECT" ] 2>/dev/null; then
  echo "  WARN sélection incomplète — re-sélection"; ev "$A" "MultiCamNav.show('home');'H'" >/dev/null; sleep 2
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'});'N2'" >/dev/null; sleep 3; take_select; take_read
fi
echo "TAKE=$TAKE captures=$NCAP storages=$NSTO (attendu storages=$NSTO_EXPECT)"
shot "$A" "J11-05-A-take"
if [ "${NCAP:-0}" -lt 1 ] 2>/dev/null || [ "${NSTO:-0}" -lt "$NSTO_EXPECT" ] 2>/dev/null; then echo "FATAL: Take incomplet"; exit 1; fi

echo "############ J11-06 : ARM + REC réel + STOP ############"
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 3
wait_arm_ready "$A" "J11-06-A"
shot "$A" "J11-06-A-arm"
for s in $PARTICIPANTS; do ADB -s "$s" logcat -c >/dev/null 2>&1; done
press_rec "$A" "J11-06-A"
wait_start_phase "$A" "REC" "J11-06-A" || echo "  WARN: pas de REC (rapporté)"
for s in "$A" "$B"; do shot "$s" "J11-06-$s-rec"; done
echo "  enregistrement 12 s…"; sleep 12
ev "$A" "MultiCamStartService.requestStop('j11_campaign')" >/dev/null 2>&1
echo "STOP_REQUEST envoyé par A"
sleep 3
for s in $PARTICIPANTS; do shot "$s" "J11-06-$s-stopped"; done
for s in "$A" "$B"; do echo "  $s phase=$(ev "$s" "MultiCamStartService.view().phase" | tr -d '"')"; done

echo "############ J11-07 : attente de la fin des transferts ############"
ev "$A" "MultiCamNav.show('take-stopped',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 1
wait_transfers() {
  local poll=0
  while [ "$poll" -lt 50 ]; do
    local va vc vd
    va=$(tr_view "$A" "$SID" "$TAKE"); vc=$(tr_view "$C" "$SID" "$TAKE")
    vd="{}"; [ "$HAS_D" = "1" ] && vd=$(tr_view "$DOPT" "$SID" "$TAKE")
    echo "  t=${poll}s A=$va"
    echo "         C=$vc"
    [ "$HAS_D" = "1" ] && echo "         D=$vd"
    local done_a done_c done_d
    # tr_view rend du JSON ESCAPÉ (\"state\":\"done\") : on retire les
    # backslashes avant de compter, sinon la détection échoue toujours.
    done_a=$(echo "$va" | tr -d '\\' | grep -o '"state":"done"' | wc -l | tr -d ' ')
    done_c=$(echo "$vc" | tr -d '\\' | grep -o '"state":"done"' | wc -l | tr -d ' ')
    done_d=$(echo "$vd" | tr -d '\\' | grep -o '"state":"done"' | wc -l | tr -d ' ')
    if [ "${done_a:-0}" -ge "$NSTO_EXPECT" ] && [ "${done_c:-0}" -ge 1 ] && { [ "$HAS_D" != "1" ] || [ "${done_d:-0}" -ge 1 ]; }; then
      echo "ALL_TRANSFERS_DONE"; return 0
    fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "TRANSFERS_INCOMPLETE"; return 1
}
wait_transfers || true
tr_view "$A" "$SID" "$TAKE" > "$OUT/dumps/J11-07-A-transfers.json"
tr_view "$C" "$SID" "$TAKE" > "$OUT/dumps/J11-07-C-transfers.json"
[ "$HAS_D" = "1" ] && tr_view "$DOPT" "$SID" "$TAKE" > "$OUT/dumps/J11-07-D-transfers.json"
shot "$A" "J11-07-A-take-stopped"
for s in $PARTICIPANTS; do logs "$s" "J11-07"; done

echo "############ J11-08 : preuve fichiers destination + SHA-256 ############"
list_dest() {
  ev "$1" "(function(){return new Promise(function(res){var p=MultiCamStorage.defaultPath()+'MultiCam/$SID/$TAKE/';resolveLocalFileSystemURL(p,function(d){var r=d.createReader();r.readEntries(function(es){res(JSON.stringify(es.map(function(e){return {name:e.name,isFile:e.isFile};})));},function(e){res('ERR:'+e);});},function(e){res('NO_DIR');});});})()" > "$OUT/dumps/J11-08-$2-listing.json"
  echo "  $2 listing = $(cat "$OUT/dumps/J11-08-$2-listing.json")"
}
list_dest "$C" "C"; [ "$HAS_D" = "1" ] && list_dest "$DOPT" "D"
echo "--- SHA-256 / progression (TRANSFER_HASH source vs destination) ---"
for s in "$A" "$C" $STORAGES; do
  echo "== $s =="
  grep -oE "MEDIA_READY[^\"]*|TRANSFER_OFFER[^\"]*|TRANSFER_HASH[^\"]*|TRANSFER_RESULT[^\"]*" "$OUT/logs/$s-J11-07.log" | tail -12 || echo "(aucune ligne)"
done
echo "--- serveur média de la Capture B ---"
grep -oE "TRANSFER_SERVE[^\"]*|TRANSFER_ANNOUNCE_TRIGGER[^\"]*|TRANSFER_ANNOUNCE_ERROR[^\"]*|TRANSFER_ANNOUNCE_SKIP[^\"]*" "$OUT/logs/$B-J11-07.log" || echo "(aucune ligne)"

echo "############ J11-09 : écran 09 (Master) + vue Storage ############"
dump "$A" "(function(){var v=MultiCamStartService.view();var tv=(MultiCamTransferBootInstance?MultiCamTransferBootInstance.view():{transfers:{}});return JSON.stringify({phase:v.phase,takeStateText:(document.getElementById('tsState')||{}).textContent,transfers:Object.keys(tv.transfers||{}).length});})()" "J11-09-A-screen09.json"
cat "$OUT/dumps/J11-09-A-screen09.json"; echo
for s in $STORAGES; do ev "$s" "MultiCamNav.show('storage'); 'NAV'" >/dev/null; sleep 2; shot "$s" "J11-09-$s-storage-view"; done
dump "$C" "(function(){var s=document.getElementById('stSessions');return JSON.stringify({devices:(document.getElementById('stDeviceName')||{}).textContent,free:(document.getElementById('stFree')||{}).textContent,net:(document.getElementById('stNetwork')||{}).textContent,rows:s?document.querySelectorAll('.st-device').length:-1});})()" "J11-09-C-storage-dom.json"
cat "$OUT/dumps/J11-09-C-storage-dom.json"; echo

echo "############ J11-10 : Réessayer (ré-émission ciblée) ############"
echo -n "  retry(B) sur le Master = "; ev "$A" "(function(){try{var r=MultiCamTransferBootInstance.retry('$BDID');return 'RETRY='+(r&&r.length);}catch(e){return 'RETRY_ERR:'+e.message;}})()" | tail -1; echo

echo "############ SYNTHÈSE ############"
echo "SID=$SID TAKE=$TAKE captures=$NCAP storages=$NSTO (D present=$HAS_D)"
echo "--- logs TRANSFER_*/MEDIA_READY par device ---"
for s in $PARTICIPANTS; do n=$(grep -c "TRANSFER_\|MEDIA_READY" "$OUT/logs/$s-J11-07.log" 2>/dev/null || true); echo "  $s : $n ligne(s)"; done
echo "--- NB synthèse ---"
{ echo "SID=$SID"; echo "TAKE=$TAKE"; echo "captures=$NCAP"; echo "storages=$NSTO"; echo "has_d=$HAS_D"; } > "$OUT/dumps/summary.txt"
echo "--- fin ---"
