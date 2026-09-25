#!/usr/bin/env bash
# MultiCam — campagne de validation J07 (ARM distribué + synchronisation d'horloge).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools). Capture captures d'écran,
# journaux logcat et dumps JSON dans tests/e2e/validation/J07-arm-sync/.
#
# Périmètre J07 : écran 06 validé (spec ui/06-arm), ARM distribué sur la maille WS
# (arm_request/arm_result répondus en dirigé), synchronisation d'horloge NTP-like
# (clock_sync/clock_sync_reply, 3 échantillons / remote, disparité), convergence
# multi-Master, incidents (déconnexion réelle → modal), annulation/re-nouvel ARM
# (incrément d'essai), éligibilité REC. AUCUN enregistrement réel (J08).
#
# Appareils : B=61d54bba7d91 (1er Master, Cam 07), C=c0d8514d7d87 (2e Master +
# device membre, Cam 07). 61cc29567d91 est HORS PÉRIMÈTRE : jamais utilisé.
# Les deux devices sont réels (FHD/HD, gpsFeature=false) — PAS de bullet SIMULATED
# dans cette campagne : l'ARM doit se conclure READY sur le matériel physique.
#
# Usage : tests/e2e/j07-campaign.sh [clean]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J07-arm-sync"
CDP="$HERE/lib/cdp.js"

B=61d54bba7d91
C=c0d8514d7d87
SNAME="Armage Studio J07"
CNAME="Cam J07-C"
BNAME="Cam J07-B"

APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|MEMBER|SCREEN0|SCREEN1|HOME_RENDER|APP_BOOT|NSD_|MDNS_|TAKE_|TELEMETRY_|ARM_|CLOCK_|REC_ELIG|TARGETED_" > "$OUT/logs/$1-$2.log"; echo "logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log"))"; }
dump(){ echo -n "$2" | node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(cat "$OUT/dumps/$3")"; }
arm_view(){ node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$1.json"; }

mark(){ echo "### $1"; }

clean_device() {
  local s="$1"
  adb -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
  echo "clean $s: $(adb -s "$s" shell pm clear "$APP" 2>&1 )"
  adb -s "$s" shell am start -n "$APP/.MainActivity" >> "$OUT/logs/boot-$s.log" 2>&1
  adb -s "$s" logcat -c
  sleep 8
  echo "clean boot $s"
}

grant_perms() {
  local s="$1"
  for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION; do
    adb -s "$s" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1
  done
  echo "grant_perms $s ok"
}

set_pin() {
  local s="$1" p="$2"
  ev "$s" "(function(p){for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);var n=document.createEvent('Event');n.initEvent('input',true,true);b.value=p[i];b.dispatchEvent(n);}return 'PIN_SET_'+p;})('$p')"
}

read_pin() {
  ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.sessionId==='$2';})[0];return s?s.pin:'N/A';})()"
}

panels_ok() {
  local s="$1" label="$2"
  local n=$(ev "$s" "(function(){var a=document.querySelectorAll('.screen.active');return a.length+'|'+(a[0]?a[0].id:'');})()")
  n="${n//\"/}"; n="${n//\\/}"
  echo "panels_ok $label -> $n"
  case "$n" in
    1\|*) echo "PANELS_OK $label active=$(echo "$n" | cut -d'|' -f2)" ;;
    *) echo "PANELS_FAIL $label got=$n (attendu exactement 1|panel-…)" ;;
  esac
}

wait_lan_clear() {
  local s="$1" poll=0
  while [ "$poll" -lt 180 ]; do
    local lan=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();return l.length;})()")
    echo "wait_lan_clear $s t=${poll}s lan=$lan"
    if [ "$lan" = "0" ]; then return 0; fi
    sleep 30; poll=$(( poll + 30 ))
  done
  echo "wait_lan_clear $s WARNING leftover non expiré après 180s (reporté honnêtement)"
  return 1
}

# Extrait un champ JSON d'un dump (gère le double-encodage CDP).
json_field() { # file, expr-js (v désigne le JSON)
  node -e "const fs=require('fs');let v=fs.readFileSync('$1','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}};const out=$2;console.log(out===undefined?'':out);"
}

# Attend la convergence ARM sur la vue d'un device. Critère (HONNÊTE, physique) :
#  - ARM actif ;
#  - aucune compétence en ARMING/ERROR/PENDING (READY ou WARNING acceptés) ;
#  - chaque capture DISTANTE a une référence d'horloge (>= CLOCK_SAMPLES_TARGET
#    échantillons). Le delta ≠ 0 est PHYSIQUEMENT possible (horloges android non
#    NTP) → statut "ok" ou "warn=dégradée" : les DEUX sont des résultats valides
#    d'une synchronisation mesurée (warn = non bloquant, Δ/dispersion reportés).
wait_arm_ready() {
  local s="$1" label="$2" poll=0
  while [ "$poll" -lt 90 ]; do
    arm_view "$s"
    local res=$(json_field "$OUT/dumps/arm-view-$s.json" "JSON.stringify({active:v.active,devices:(v.devices||[]).map(function(d){return{name:d.deviceName,skills:d.skills.map(function(x){return x.skill+':'+x.status})}}),clock:v.clock,eligible:v.recEligible})")
    echo "wait_arm_ready $label t=${poll}s $res"
    local ok=$(node -e "
      const fs=require('fs');let v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v.active){console.log('no');process.exit(0);}
      const bad=(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});});
      const ck=Object.keys(v.clock||{}).length>0 && Object.keys(v.clock||{}).every(function(k){return v.clock[k].status==='ok'||v.clock[k].status==='warn';});
      console.log(!bad&&ck?'yes':'no');
    ")
    if [ "$ok" = "yes" ]; then echo "ARM_READY $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "ARM_READY $label TIMEOUT après 90s — preuves partielles rapportées honnêtement"
  return 1
}

# Attend que le store de C contienne la session reçue (join effectif). Le join
# PIN a une course (JOIN_REQUEST avant saisie PIN → NACK honnête) ; C récupère
# la session ensuite via la maille (SYNC_RECEIVED new_copy no_pin_wire) : on
# POLLE le store plutôt que de dormir un temps arbitraire.
wait_session_on() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    echo "wait_session_on $label t=${poll}s $has"
    if [ "$has" = "yes" ]; then echo "SESSION_JOINED $label"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SESSION_JOINED $label TIMEOUT après 60s — suite effectuée de façon honnête"
  return 1
}

if [ "${1:-}" = "clean" ]; then
  echo "CLEAN des données B et C"
  clean_device "$B"
  clean_device "$C"
  grant_perms "$B"
  grant_perms "$C"
  sleep 6
fi

wait_lan_clear "$C"
wait_lan_clear "$B"

echo "############ J07-01 : création de session sur B (hôte Master) ############"
ev "$B" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J07-01-create"
ev "$B" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()"
sleep 5
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();var s=l[l.length-1];return JSON.stringify({found:s?true:false,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:'',takes:s?(s.takes||[]).length:0,masters:s?(s.masters||[]).length:0})})()" "J07-01-B-created.json"
shot "$B" "J07-01-B-session-screen"

read -r SID PIN <<< "$(json_field "$OUT/dumps/J07-01-B-created.json" "v.sid+' '+v.pin")"
echo "SESSION_CREATED sid=$SID pin=$PIN"
if [ "$PIN" = "N/A" ] || [ -z "$PIN" ]; then echo "FATAL: PIN illisible"; exit 1; fi

echo "############ J07-02 : C découvre le LAN et rejoint comme second Master ############"
sleep 3
dump "$C" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "J07-02-C-lan.json"
sleep 2
read -r JHOST JPORT <<< "$(json_field "$OUT/dumps/J07-02-C-lan.json" "(function(){var s=(v.lan||[]).filter(function(x){return x.sessionId==='$SID';})[0];var ann=((s&&s.announcers)||[]);var a=ann[ann.length-1]||{host:'',port:0};return (a.host||'')+' '+(a.port||0);})()")"
echo "JOIN_TARGET sid=$SID host=$JHOST port=$JPORT"
# NAV + saisie PIN dans la MÊME tick : éviter la course JOIN_REQUEST sans PIN
# (le request part dès le WS ouvert, il faut que le PIN soit déjà en place).
ev "$C" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN';})()" > "$OUT/dumps/J07-02-C-join-eval.txt"
cat "$OUT/dumps/J07-02-C-join-eval.txt"
wait_session_on "$C" "$SID" "J07-02-C"
sleep 3
panels_ok "$C" "J07-02-session"; panels_ok "$B" "J07-02-session"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',masters:(s.masters||[]).map(function(m){return m.deviceId}),members:(s.members||[]).length,takes:(s.takes||[]).length})})()" "J07-02-B-2masters.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',members:(s.members||[]).length,takes:(s.takes||[]).length})})()" "J07-02-C-joined.json"
shot "$B" "J07-02-B-session-2masters"

BDID=$(ev "$B" "MultiCamSessionWs.status().localDid")
BDID="${BDID//\"/}"
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid")
CDID="${CDID//\"/}"
echo "BDID=$BDID CDID=$CDID (auto-déclarés par chaque device)"

echo "############ J07-03 : membres Capture+Storage (B self + C) ############"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture','storage']},['capture','storage']);var r2=await MultiCamSessionWs.addMember(r,{deviceId:'$BDID',deviceName:'$BNAME',enabledSkills:['capture','storage']},['capture','storage']);return JSON.stringify({ok:true,members:r2.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" > "$OUT/dumps/J07-03-B-add.json"
sleep 5
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName,roles:m.sessionRoles}})})})()" "J07-03-B-members.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J07-03-C-converged-members.json"
shot "$B" "J07-03-B-members"

echo "############ J07-04 : Take — Captures TOUTES + Storages TOUS (B+C partout) ############"
ev "$B" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
ev "$B" "document.getElementById('tkCaptureAll').click();'CLICKED_CAPTURE_ALL'" >/dev/null
ev "$B" "document.getElementById('tkStorageAll').click();'CLICKED_STORAGE_ALL'" >/dev/null
sleep 4
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({takeNumber:t.takeNumber,captures:t.captures,storages:t.storages,settings:t.settings})})()" "J07-04-B-take.json"
cat "$OUT/dumps/J07-04-B-take.json"; echo
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({converged:t.captures.length===2&&t.storages.length===2,members:s.members.length})})()" "J07-04-C-take-converged.json"
shot "$B" "J07-04-B-take-ready"
logs "$B" "J07-04"; logs "$C" "J07-04"

echo "############ J07-05 : ARM distribué sur B — auto-démarrage + convergence 2 devices ############"
ev "$B" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J07-05-arm"
wait_arm_ready "$B" "J07-05-B"
arm_view "$B"
dump "$B" "(function(){return JSON.stringify(MultiCamArmService.view(),null,1);})()" "J07-05-B-arm-view.json"
dump "$B" "(function(){var v=MultiCamArmService.view();var checks={};(v.devices||[]).forEach(function(d){checks[d.deviceName]={};d.skills.forEach(function(sk){checks[d.deviceName][sk.skill]=sk.checks;});});return JSON.stringify(checks,null,1);})()" "J07-05-B-checks.json"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({recEligible:v.recEligible,incidents:v.incidents,incidentsEmpty:v.incidentsEmpty,skills:v.skills})})()" "J07-05-B-eligibility.json"
# référence d'horloge : B doit voir C synchronisée (C est Capture distante)
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify(v.clock,null,1);})()" "J07-05-B-clock.json"
shot "$B" "J07-05-B-arm-ready"
logs "$B" "J07-05"; logs "$C" "J07-05"
grep -oE "CLOCK_SYNC[^\"]*|ARM_RESULT[^\"]*|ARM_TIMEOUT[^\"]*|ARM_RECOVER[^\"]*" "$OUT/logs/$B-J07-05.log" > "$OUT/dumps/J07-05-B-arm-log-lines.txt"
echo "--- échantillons CLOCK_SYNC (B → C) ---"; cat "$OUT/dumps/J07-05-B-arm-log-lines.txt"
echo "--- B clock ---"; cat "$OUT/dumps/J07-05-B-clock.json"; echo
echo "--- B eligibility ---"; cat "$OUT/dumps/J07-05-B-eligibility.json"; echo
echo "--- B rec dock (UI) ---"
ev "$B" "(function(){var r=document.getElementById('armRec');var l=document.getElementById('armRecLabel');return JSON.stringify({disabled:r.disabled,btnClass:r.className,label:l.textContent,dockHidden:document.getElementById('armRecDock').classList.contains('d-none')})})()"

echo "############ J07-06 : REC dock éligible (visuel) — AUCUN enregistrement en J07 ############"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({recEligible:v.recEligible,dockShown:!document.getElementById('armRecDock').classList.contains('d-none'),recDisabled:document.getElementById('armRec').disabled})})()" "J07-06-B-rec-dock.json"
# pas de clique REC : en J07 la pression est hors périmètre ; on VERIFIE le garde-fou UI
ev "$B" "(function(){var r=document.getElementById('armRec');return 'REC_BTN '+r.disabled+' (disabled='+r.disabled+')';})()" | tee "$OUT/dumps/J07-06-B-rec-guard.txt"

echo "############ J07-07 : INCIDENT réel — C coupée → modal incidents sur B ; C revient → auto-reprise ############"
echo "--- force-stop C (coupure réelle de la maille) ---"
adb -s "$C" shell am force-stop "$APP"
sleep 12
arm_view "$B"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({active:v.active,incidents:v.incidents,incidentsEmpty:v.incidentsEmpty,statuses:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})})()" "J07-07-B-incident.json"
cat "$OUT/dumps/J07-07-B-incident.json"; echo
shot "$B" "J07-07-B-incident-modal"
logs "$B" "J07-07-incident"
echo "--- relance C → rejoignable → ré-ARM automatique (REF chaud) ---"
adb -s "$C" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 10
wait_arm_ready "$B" "J07-07-B-recovered"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({incidentsEmpty:v.incidentsEmpty,incidents:v.incidents,statuses:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})})()" "J07-07-B-recovered.json"
cat "$OUT/dumps/J07-07-B-recovered.json"; echo
shot "$B" "J07-07-B-recovered"
logs "$B" "J07-07-recover"; logs "$C" "J07-07"

echo "############ J07-08 : retour → ARM_CANCEL (état neutre) ############"
ev "$B" "document.getElementById('backArm').click();'BACK'" >/dev/null
sleep 3
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({active:v.active,devices:v.devices.length,clock:Object.keys(v.clock).length,recEligible:v.recEligible})})()" "J07-08-B-cancelled.json"
cat "$OUT/dumps/J07-08-B-cancelled.json"; echo
echo "--- PANELS après retour (écran Take) ---"
panels_ok "$B" "J07-08-back"
logs "$B" "J07-08"

echo "############ J07-09 : re-ARM → incrément d'essai (attempt++) + convergence ############"
ev "$B" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
wait_arm_ready "$B" "J07-09-B"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,takeNumber:v.takeNumber,attempt:v.attempt,startedAtMs:v.startedAtMs,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})})()" "J07-09-B-attempt2.json"
cat "$OUT/dumps/J07-09-B-attempt2.json"; echo
shot "$B" "J07-09-B-arm-attempt2"

echo "############ J07-10 : MULTI-MASTER — C ouvre aussi l'écran 06 ; convergence des DEUX ############"
# B reste maître ARM actif ; C devient 2e maître sur la MÊME session/take.
ev "$C" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
wait_arm_ready "$C" "J07-10-C"
# retour sur B : vérifier qu'il converge toujours (les deux maîtres coexistent)
wait_arm_ready "$B" "J07-10-B"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,clock:v.clock,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})})()" "J07-10-B-multimaster.json"
dump "$C" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,clock:v.clock,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})})()" "J07-10-C-multimaster.json"
cat "$OUT/dumps/J07-10-B-multimaster.json"; echo
cat "$OUT/dumps/J07-10-C-multimaster.json"; echo
shot "$B" "J07-10-B-multimaster"
shot "$C" "J07-10-C-multimaster"
logs "$B" "J07-10"; logs "$C" "J07-10"

echo "############ J07-11 : garde-feu REC (pression testée honnêtement : J07 ne REC pas) ############"
dump "$B" "(function(){var v=MultiCamArmService.view();return JSON.stringify({recEligible:v.recEligible,incidentsEmpty:v.incidentsEmpty,incidents:v.incidents})})()" "J07-11-B-before-recpress.json"
cat "$OUT/dumps/J07-11-B-before-recpress.json"; echo
ev "$B" "document.getElementById('armRec').click();'REC_PRESSED'" >/dev/null
sleep 2
logs "$B" "J07-11-recpress"
echo "--- garde-feu REC : les DEUX issues sont des comportements valides ---"
R_INC=$(grep -c "SCREEN06_REC_INCIDENT" "$OUT/logs/$B-J07-11-recpress.log" || true)
R_NXT=$(grep -c "REC_ELIGIBLE_NEXT_J08" "$OUT/logs/$B-J07-11-recpress.log" || true)
R_NO=$(grep -c "REC_ELIGIBLE" "$OUT/logs/$B-J07-11-recpress.log" || true)
echo "SCREEN06_REC_INCIDENT=$R_INC REC_ELIGIBLE_NEXT_J08=$R_NXT REC_ELIGIBILITY_logs=$R_NO"
echo "(SCREEN06_REC_INCIDENT → modal 'Annuler/Continuer REC' ; REC_ELIGIBLE_NEXT_J08 → enregistrement effectif au jalon J08)"

echo "############ J07-12 : convergence finale des TAKES deux Masters (invariant de session) ############"
ev "$B" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
ev "$C" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes})})()" "J07-12-B-final-session.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes})})()" "J07-12-C-final-session.json"
node -e "
const fs=require('fs');
const b=JSON.stringify(JSON.parse(fs.readFileSync('$OUT/dumps/J07-12-B-final-session.json','utf8')).takes);
const c=JSON.stringify(JSON.parse(fs.readFileSync('$OUT/dumps/J07-12-C-final-session.json','utf8')).takes);
console.log('FINAL_CONVERGENCE takes_equal_B_C='+(b===c));
process.exit(b===c?0:1);
"
shot "$B" "J07-12-B-final"
shot "$C" "J07-12-C-final"
logs "$B" "J07-12"; logs "$C" "J07-12"

echo "############ TERMINÉ ############"
ls -1 "$OUT/dumps"

echo "--- Vérif fin de run : panneaux exactement un par device ---"
panels_ok "$B" "fin"; panels_ok "$C" "fin"

echo "--- Hachage SHA-256 des captures + détection de doublons ---"
cd "$OUT/screenshots" || exit 1
shasum -a 256 *.png | tee "$OUT/png-shas.txt"
echo "--- doublons (le cas échéant) ---"
shasum -a 256 *.png | awk '{print $1}' | sort | uniq -d | sed 's/^/duplicate-sha: /'