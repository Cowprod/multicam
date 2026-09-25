#!/usr/bin/env bash
# MultiCam — revue complémentaire J07 sur 4 devices (D1-D4), en attente revue humaine.
#
# Objectifs :
#   - session avec les 4 devices (2 Masters simultanés : D1 + D4 Samsung) ;
#   - membership 4, noms uniques, rôles corrects, aucune identité dupliquée/ancienne ;
#   - Take multi-Captures multi-Storages (Samsung = Capture + Storage) ;
#   - ARM distribué 4 devices (réponses indépendantes, convergence entre Masters) ;
#   - échantillons horloge réels (t0..t3, RTT, offset, dispersion) par Capture distante ;
#   - permissions honnêtes (NOT_REQUESTED → « Autorisation à demander »), D1/D4 ;
#   - incidents réels (force-stop) → modal REC + récupération automatique (aucun Retry) ;
#   - preuves visuelles A-I pour la revue humaine.
#
# AUCUN pm clear : préserve les noms stabilisés (Cam D1..D4) et les deviceId.
# AUCUN enregistrement réel (J08) : pression REC stoppée au garde-fou de J07.
#
# Usage : tests/e2e/j07-review-4dev.sh
set -u
set +B

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J07-arm-sync/four-devices"
CPL="$ROOT/tests/e2e/validation/J07-arm-sync"   # compléments (logs globaux)
CDP="$HERE/lib/cdp.js"

D1=61cc29567d91; D2=61d54bba7d91; D3=c0d8514d7d87; D4=R83Y106V1HF
SNAME="Revue 4D J07"
APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|MEMBER|SCREEN0|SCREEN1|HOME_RENDER|APP_BOOT|NSD_|MDNS_|TAKE_|TELEMETRY_|ARM_|CLOCK_|REC_ELIG|TARGETED_" > "$OUT/logs/$1-$2.log"; echo "logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log"))"; }
dump(){ node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(node -e "const fs=require('fs');const t=fs.readFileSync('$OUT/dumps/$3','utf8').trim();let v=t;try{v=JSON.parse(t);if(typeof v!=='string')v=v;}catch(e){v=t;}console.log(String(v).slice(0,200));")"; }
arm_view(){ node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$1.json"; }
mark(){ echo; echo "############ $1 ############"; }

json_field() {
  node -e "const fs=require('fs');let v=fs.readFileSync('$1','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}};const out=$2;console.log(out===undefined?'':out);"
}

panels_ok() {
  local s="$1" label="$2"
  local n=$(ev "$s" "(function(){var a=document.querySelectorAll('.screen.active');return a.length+'|'+(a[0]?a[0].id:'');})()")
  n="${n//\"/}"; n="${n//\\/}"
  case "$n" in
    1\|*) echo "PANELS_OK $label active=$(echo "$n" | cut -d'|' -f2)" ;;
    *) echo "PANELS_FAIL $label got=$n" ;;
  esac
}

set_pin() {
  local s="$1" p="$2"
  ev "$s" "(function(p){for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;var n=document.createEvent('Event');n.initEvent('input',true,true);b.value=p[i];b.dispatchEvent(n);}return 'PIN_SET_'+p;})('$p')"
}

wait_session_on() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SESSION_JOINED $label TIMEOUT"
  return 1
}

wait_arm_ready() {
  local s="$1" label="$2" poll=0
  while [ "$poll" -lt 90 ]; do
    arm_view "$s"
    echo "wait_arm_ready $label t=${poll}s $(json_field "$OUT/dumps/arm-view-$s.json" "JSON.stringify({active:v.active,rec:v.recEligible,incidents:(v.incidents||[]).length,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})})")"
    local ok=$(node -e "
      const fs=require('fs');let v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v.active){console.log('no');process.exit(0);}
      const bad=(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});});
      const ck=Object.keys(v.clock||{}).length>0 && Object.keys(v.clock||{}).every(function(k){return (v.clock[k].status||'')==='ok'||(v.clock[k].status||'')==='warn';});
      console.log(!bad&&ck?'yes':'no');
    ")
    if [ "$ok" = "yes" ]; then echo "ARM_READY $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "ARM_READY $label TIMEOUT"
  return 1
}

# Multi-master : second Master — convergence = aucune erreur, au moins un
# échantillon d'horloge réel, REC éligible. Un ARMING résiduel sur le row
# "self" est toléré (permission NOT_REQUESTED → pending → ARMING honnête, §33) ;
# tout statut ERROR est un défaut.
wait_mm_converged() {
  local s="$1" label="$2" poll=0
  while [ "$poll" -lt 60 ]; do
    arm_view "$s"
    local ok=$(node -e "
      const fs=require('fs');let v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v.active||!v.recEligible){console.log('no');process.exit(0);}
      if(Object.keys(v.clock||{}).length===0){console.log('no');process.exit(0);}
      const bad=(v.devices||[]).filter(function(d){
        return d.skills.some(function(x){return x.status==='ERROR';});
      }).length;
      console.log(bad===0?'yes':'no');
    ")
    if [ "$ok" = "yes" ]; then echo "MM_CONVERGED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "MM_CONVERGED $label TIMEOUT"
  return 1
}

mark "0 — préconditions : 4 apps up, noms/identités préservés (aucun pm clear)"
for s in "$D1" "$D2" "$D3" "$D4"; do adb -s "$s" logcat -c 2>/dev/null; done
for K in "$D1 D1" "$D2 D2" "$D3 D3" "$D4 D4"; do
  set -- $K
  ev "$1" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"
done

mark "R1 — création de session sur D1 (hôte Master)"
ev "$D1" "MultiCamNav.show('create'); (function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 1;})()" >/dev/null
sleep 6
dump "$D1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.state!=='closed';}).sort(function(a,b){return (b.updatedAtMs||0)-(a.updatedAtMs||0)})[0]||l[0];return JSON.stringify({found:!!s,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:''});})()" "R1-D1-created.json"
read -r SID PIN <<< "$(json_field "$OUT/dumps/R1-D1-created.json" "v.sid+' '+v.pin")"
echo "SESSION_CREATED sid=$SID pin=$PIN"
shot "$D1" "J07-R10-d1-session-created"

mark "R2 — D2, D3, D4 rejoignent comme Masters (maille 4 devices)"
sleep 3
for K in "$D2 D2" "$D3 D3" "$D4 D4"; do
  set -- $K
  dump "$1" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "R2-$2-lan.json"
  read -r JHOST JPORT <<< "$(json_field "$OUT/dumps/R2-$2-lan.json" "(function(){var s=(v.lan||[]).filter(function(x){return x.sessionId==='$SID';})[0];var ann=((s&&s.announcers)||[]);var a=ann[ann.length-1]||{host:'',port:0};return (a.host||'')+' '+(a.port||0);})()")"
  echo "JOIN_TARGET $2 sid=$SID host=$JHOST port=$JPORT"
  ev "$1" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN_$2';})()" > "$OUT/dumps/R2-$2-join.txt"
  cat "$OUT/dumps/R2-$2-join.txt"
  wait_session_on "$1" "$SID" "R2-$2"
done
sleep 3
for K in "$D1 D1" "$D2 D2" "$D3 D3" "$D4 D4"; do
  set -- $K; panels_ok "$1" "R2-$2"
done
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId}),members:(s.members||[]).length});})()" "R2-D1-4masters.json"
cat "$OUT/dumps/R2-D1-4masters.json"; echo
shot "$D1" "J07-R11-d1-session-4-devices"

mark "R3 — membership : rôles J05 (aucune identité ancienne)"
DID1=$(ev "$D1" "MultiCamSessionWs.status().localDid"); DID1="${DID1//\"/}"
DID2=$(ev "$D2" "MultiCamSessionWs.status().localDid"); DID2="${DID2//\"/}"
DID3=$(ev "$D3" "MultiCamSessionWs.status().localDid"); DID3="${DID3//\"/}"
DID4=$(ev "$D4" "MultiCamSessionWs.status().localDid"); DID4="${DID4//\"/}"
echo "DID1=$DID1 DID2=$DID2 DID3=$DID3 DID4=$DID4"
ev "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');
  var add=function(sess,did,nm,roles){return MultiCamSessionWs.addMember(sess,{deviceId:did,deviceName:nm,enabledSkills:['capture','storage']},roles);};
  var a=await add(s,'$DID1','Cam D1',['capture','storage']);
  var b=await add(a,'$DID2','Cam D2',['capture']);
  var c=await add(b,'$DID3','Cam D3',['storage']);
  var d=await add(c,'$DID4','Cam D4',['capture','storage']);
  return JSON.stringify({members:d.members.map(function(m){return m.deviceName+'='+(m.sessionRoles||[]).join('+')})});})()" > "$OUT/dumps/R3-D1-roles.json"
cat "$OUT/dumps/R3-D1-roles.json"; echo
sleep 5
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');var ids=s.members.map(function(m){return m.deviceId;});return JSON.stringify({count:s.members.length,ids:ids,dup:(new Set(ids)).size!==ids.length,legacy:ids.filter(function(i){return ['d5f6b2a1-2387-4207-836d-90b0072a6cee','4bbeef26-3e46-40e5-9f0b-d3fb459c9472','92d58e97-c418-47cc-87c5-6a080aff5faf','23c5cf6e-beab-4e40-b3ab-6dc6dfed0437'].indexOf(i)<0;})});})()" "R3-D1-members-integrity.json"
cat "$OUT/dumps/R3-D1-members-integrity.json"; echo
shot "$D1" "J07-R12-d1-members-roles"

mark "R4 — Take : Captures [C1,C2,C4] Storages [C1,C3,C4] (Samsung Capture+Storage)"
ev "$D1" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
ev "$D1" "document.getElementById('tkCaptureAll').click();'CAP'" >/dev/null
ev "$D1" "document.getElementById('tkStorageAll').click();'STO'" >/dev/null
sleep 4
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({take:t.takeNumber,captures:t.captures,storages:t.storages,settings:t.settings});})()" "R4-D1-take.json"
cat "$OUT/dumps/R4-D1-take.json"; echo
dump "$D4" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({converged:t&&t.captures.length===3&&t.storages.length===3});})()" "R4-D4-take-converged.json"
cat "$OUT/dumps/R4-D4-take-converged.json"; echo
shot "$D1" "J07-R13-d1-take-4devices"
logs "$D1" "R4-ta"; logs "$D2" "R4-ta"; logs "$D3" "R4-ta"; logs "$D4" "R4-ta"

mark "R5 — ARM distribué sur 4 devices (D1 hôte, captions + storages)"
ev "$D1" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$D1" "R5-arm"
wait_arm_ready "$D1" "R5-D1"
dump "$D1" "(function(){return JSON.stringify(MultiCamArmService.view(),null,1);})()" "R5-D1-arm-view.json"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,take:v.takeNumber,attempt:v.attempt,recEligible:v.recEligible,devices:(v.devices||[]).map(function(x){return{name:x.deviceName,did:x.did,skills:x.skills.map(function(sk){return{skill:sk.skill,status:sk.status,checks:sk.checks}})}})});})()" "R5-D1-arm-details.json"
actor=$(ev "$D1" "(function(){var v=MultiCamArmService.view();var d=v.devices.filter(function(x){return x.deviceName==='Cam D2'||x.deviceName==='Cam D4'||x.deviceName==='Cam D3'||x.deviceName==='Cam D1';});return JSON.stringify({names:d.map(function(x){return x.deviceName;}),dupsInArm:(new Set(d.map(function(x){return x.did;})).size!==d.length)});})()")
echo "ARM_PROBE $actor"
shot "$D1" "J07-R14-arm-4devices"
logs "$D1" "R5-arm"
grep -oE "CLOCK_SYNC[^\"]*|ARM_REQUEST[^\"]*|ARM_RESULT[^\"]*|ARM_TIMEOUT[^\"]*|ARM_RECOVER[^\"]*|ARM_RESULT_SENT[^\"]*" "$OUT/logs/$D1-R5-arm.log" > "$OUT/dumps/R5-D1-clock-lines.txt"
echo "--- échantillons CLOCK_SYNC (D1 → D2/D4) ---"; cat "$OUT/dumps/R5-D1-clock-lines.txt"
echo "--- clock par Capture distante ---"
json_field "$OUT/dumps/arm-view-$D1.json" "JSON.stringify({clock:v.clock,rec:v.recEligible,incidents:v.incidents,incidentsEmpty:v.incidentsEmpty})"

mark "R6 — REC dock éligible (aucun enregistrement en J07)"
dump "$D1" "(function(){return JSON.stringify({recEligible:MultiCamArmService.view().recEligible,dockShown:!document.getElementById('armRecDock').classList.contains('d-none'),recDisabled:document.getElementById('armRec').disabled});})()" "R6-D1-rec-dock.json"
cat "$OUT/dumps/R6-D1-rec-dock.json"; echo
shot "$D1" "J07-R15-rec-dock-eligible"

mark "R7 — PREUVES visuelles A-I (accordéons de détail réels)"
# B — détail Capture READY (D4 Samsung : locales READY, sync mesurée avec delta réel)
KEY_D4="capture"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return b?'CLICK_D4_CAP':'MISSING';})()" >/dev/null; sleep 1
shot "$D1" "J07-R16-detail-capture-d4-samsung"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
# C — détail Capture WARNING (D1 self : raison = permissions NOT_REQUESTED + micro à autoriser)
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID1\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
shot "$D1" "J07-R17-detail-capture-warning-permissions"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID1\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
# E — détail Storage (D3)
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID3\\\"][data-skill=storage]');if(b)b.click();return b?'CLICK_D3_STO':'MISSING';})()" >/dev/null; sleep 1
shot "$D1" "J07-R18-detail-storage-d3"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID3\\\"][data-skill=storage]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
# A — ARM global 4 devices (sans accordéon)
shot "$D1" "J07-R19-arm-global-4devices"
logs "$D1" "R7-detail"

mark "R8 — INCIDENT réel : force-stop D2 → incident + modal REC (au moins une Capture startable)"
adb -s "$D2" shell am force-stop "$APP"
sleep 12
arm_view "$D1"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({active:v.active,recEligible:v.recEligible,incidentsEmpty:v.incidentsEmpty,incidents:v.incidents,statuses:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})});})()" "R8-D1-incident.json"
cat "$OUT/dumps/R8-D1-incident.json"; echo
# G — device déconnecté sans faire disparaître les autres
shot "$D1" "J07-R20-incident-device-d2-error"
ev "$D1" "document.getElementById('armRec').click();'REC_PRESSED'" >/dev/null
sleep 2
dump "$D1" "(function(){var v=MultiCamArmService.view();var m=document.getElementById('armIncidentModal');return JSON.stringify({modalShown:m.classList.contains('show'),incidents:v.incidents,recEligible:v.recEligible});})()" "R8-D1-rec-modal.json"
cat "$OUT/dumps/R8-D1-rec-modal.json"; echo
# F — vraie modal incidents REC visible (Annuler / Continuer REC)
shot "$D1" "J07-R21-modal-incidents-rec"
ev "$D1" "document.getElementById('armIncidentCancel').click();'CANCEL'" >/dev/null
sleep 1
logs "$D1" "R8-incident"

mark "R9 — RÉCUPÉRATION automatique : relance D2 → re-ARM sans bouton Retry"
adb -s "$D2" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 12
wait_arm_ready "$D1" "R9-D1"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({incidentsEmpty:v.incidentsEmpty,recEligible:v.recEligible,noRetryBtn:document.querySelectorAll('#armList .skill-state.retry').length===0,statuses:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})});})()" "R9-D1-recovered.json"
cat "$OUT/dumps/R9-D1-recovered.json"; echo
# H — D2 repassé automatiquement ARMING→READY/WARNING
shot "$D1" "J07-R22-recovery-d2"
logs "$D1" "R9-recover"; logs "$D2" "R9-recover"

mark "R10 — MULTI-MASTER : D4 (Samsung) ouvre aussi l'écran 06"
ev "$D4" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 3
wait_mm_converged "$D4" "R10-D4"
dump "$D4" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')}),clock:v.clock});})()" "R10-D4-multimaster.json"
cat "$OUT/dumps/R10-D4-multimaster.json"; echo
wait_arm_ready "$D1" "R10-D1"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')}),clock:v.clock});})()" "R10-D1-multimaster.json"
cat "$OUT/dumps/R10-D1-multimaster.json"; echo
shot "$D1" "J07-R23-multimaster-d1"
shot "$D4" "J07-R24-multimaster-d4-samsung"
# I — détail Samsung depuis son propre écran (état ARM réel + contrôles)
ev "$D4" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
shot "$D4" "J07-R25-d4-samsung-arm-detail"
ev "$D4" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1
logs "$D1" "R10-mm"; logs "$D4" "R10-mm"

mark "R11 — convergence finale des TAKES (D1 vs D4, invariants de session)"
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes});})()" "R11-D1-final.json"
dump "$D4" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes});})()" "R11-D4-final.json"
node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync('$OUT/dumps/R11-D1-final.json','utf8'));
const b=JSON.parse(fs.readFileSync('$OUT/dumps/R11-D4-final.json','utf8'));
const same=JSON.stringify(a.takes)===JSON.stringify(b.takes);
console.log('FINAL_CONVERGENCE takes_equal_D1_D4='+same);
process.exit(same?0:1);
"
shot "$D1" "J07-R26-final-d1"; shot "$D4" "J07-R27-final-d4-samsung"
logs "$D1" "R11-final"; logs "$D4" "R11-final"

mark "R12 — fermeture propre de la session (preuves conservées, aucune identité touchée)"
ev "$D1" "MultiCamSessionStore.list().then(function(l){var o=l.filter(function(s){return s.state==='open';});return Promise.all(o.map(function(s){return MultiCamSessionWs.closeSession(s).then(function(c){return c.sessionId+':'+c.state;});}));}).then(function(r){return JSON.stringify(r);})"
sleep 3
for K in "$D1 D1" "$D2 D2" "$D3 D3" "$D4 D4"; do
  set -- $K
  echo -n "$2 identities: "; ev "$1" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"
done
panels_ok "$D1" "fin"

echo "############ TERMINÉ (revue 4 devices) ############"
ls -1 "$OUT/screenshots" | wc -l | xargs echo "PNG_TOTAL="
cd "$OUT/screenshots" || exit 1
shasum -a 256 *.png | tee "$OUT/png-shas.txt" >/dev/null
echo "--- doublons byte-identiques ---"
shasum -a 256 *.png | awk '{print $1}' | sort | uniq -d | sed 's/^/duplicate-sha: /'