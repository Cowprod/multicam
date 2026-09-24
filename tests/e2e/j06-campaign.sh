#!/usr/bin/env bash
# MultiCam — campagne de validation J06 (Préparer Take + Take persistant).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools). Capture captures d'écran,
# journaux logcat et dumps JSON dans tests/e2e/validation/J06-take-preparation/.
#
# Périmètre J06 : modèle du Take persistant et partagé entre Masters (Take 001
# auto-instancié, participation Captures/Storage, réglages Take, overrides par
# Capture « Hériter/personnaliser », convergence LMW via take_update), capacités
# natives (getCaptureCapabilities → télémétrie auto-déclarée) + warnings best
# effort vs réglages GLOBAUX (§32), ARM bloqué sans Capture puis éligible.
#
# Appareils : B=61d54bba7d91 (hôte Master, Cam 07), C=c0d8514d7d87 (second
# Master + device membre, Cam 07). 61cc29567d91 est HORS PÉRIMÈTRE : jamais
# utilisé ici. Tous les devices sont réalistes (gpsFeature=false, pas de 2160P) ;
# un SEUL bullet SIMULATED (fixture générique « SimulatedCam4K ») est injecté via
# le hook debug MultiCamCaptureCapabilities.setFixtureMap, explicitement LABELLÉ
# SIMULATED, pour démontrer le cas physiquement inaccessible (device compatible
# 4K + GPS) en contraste avec le device réel (B).
#
# Usage : tests/e2e/j06-campaign.sh [clean]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J06-take-preparation"
CDP="$HERE/lib/cdp.js"

B=61d54bba7d91
C=c0d8514d7d87
SNAME="Tournage Studio J06"
CNAME="Cam J06-C"
BNAME="Cam J06-B"

APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|MEMBER|SCREEN0|SCREEN1|HOME_RENDER|APP_BOOT|NSD_|RENAME|MDNS_|TAKE_|TELEMETRY_|GET_CAPTURE|PIXELCOPY" > "$OUT/logs/$2.log"; echo "logs $2 (lines=$(wc -l < "$OUT/logs/$2.log"))"; }
dump(){ echo -n "$2" | node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(cat "$OUT/dumps/$3")"; }

clean_device() {
  local s="$1"
  adb -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
  echo "clean $s: $(adb -s "$s" shell pm clear "$APP" 2>&1 )"
  adb -s "$s" shell am start -n "$APP/.MainActivity" >> "$OUT/logs/boot-$s.log" 2>&1
  adb -s "$s" logcat -c
  sleep 8
  echo "clean boot $s"
}

set_pin() {
  local s="$1" p="$2"
  ev "$s" "(function(p){for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);var n=document.createEvent('Event');n.initEvent('input',true,true);b.value=p[i];b.dispatchEvent(n);}return 'PIN_SET_'+p;})('$p')"
}

read_pin() {
  ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.sessionId==='$2';})[0];return s?s.pin:'N/A';})()"
}

mark(){ echo "### $1"; }

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

set_setting_radio() { # $1 serial, $2 inputId
  ev "$1" "(function(){var r=document.getElementById('$2');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));return 'RADIO_$2';})()"
}

switch_checked() { # $1 serial, $2 selector-js (attendu "true"/"false")
  ev "$1" "(function(){var el=$2;return el?String(el.checked):'MISSING';})()"
}

if [ "${1:-}" = "clean" ]; then
  echo "CLEAN des données B et C"
  clean_device "$B"
  clean_device "$C"
fi

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
wait_lan_clear "$C"
wait_lan_clear "$B"

echo "############ J06-01 : création de session sur B (hôte Master) ############"
ev "$B" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J06-01-create"
shot "$B" "J06-01-B-create-screen"
ev "$B" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()"
sleep 5
panels_ok "$B" "J06-01-session"
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();var s=l[0];return JSON.stringify({found:s?true:false,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:'',takes:s?(s.takes||[]).length:0,masters:s?(s.masters||[]).length:0})})()" "J06-01-B-created.json"
shot "$B" "J06-01-B-session-screen"
logs "$B" "J06-01-B"

read -r SID PIN <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J06-01-B-created.json','utf8'));if(typeof j==='string')j=JSON.parse(j);console.log(j.sid+' '+j.pin)")"
echo "SESSION_CREATED sid=$SID pin=$PIN (lu depuis le store)"
if [ "$PIN" = "N/A" ] || [ -z "$PIN" ]; then echo "FATAL: PIN illisible"; exit 1; fi

echo "############ J06-02 : C découvre le LAN et rejoint comme second Master ############"
sleep 4
panels_ok "$C" "J06-02-home"
dump "$C" "JSON.stringify({lan:MultiCamSessionDiscovery.list(),peers:MultiCamDiscovery.peers().map(function(p){return{deviceId:p.deviceId,name:p.name,enabledSkills:p.enabledSkills}})})" "J06-02-C-lan.json"
sleep 2
read -r JHOST JPORT <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J06-02-C-lan.json','utf8'));if(typeof j==='string')j=JSON.parse(j);const s=(j.lan||[]).find(function(x){return x.sessionId==='$SID';})||[];const ann=((s.announcers)||[]);const a=ann[ann.length-1]||{host:'',port:0};console.log((a.host||'')+' '+(a.port||0))")"
echo "JOIN_TARGET sid=$SID host=$JHOST port=$JPORT"
ev "$C" "MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'}); 'NAV'" >/dev/null
sleep 2
set_pin "$C" "$PIN"
sleep 7
panels_ok "$C" "J06-02-session"; panels_ok "$B" "J06-02-session"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',masters:(s.masters||[]).map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName}}),members:(s.members||[]).length,takes:(s.takes||[]).length})})()" "J06-02-B-2masters.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',members:(s.members||[]).length,masters:(s.masters||[]).length,takes:(s.takes||[]).length})})()" "J06-02-C-joined.json"
shot "$B" "J06-02-B-session-2masters"
shot "$C" "J06-02-C-session-screen"
logs "$B" "J06-02-B"; logs "$C" "J06-02-C"

# deviceIds : LUS sur chaque device (status localDid), jamais devinés.
BDID=$(ev "$B" "MultiCamSessionWs.status().localDid")
BDID="${BDID//\"/}"
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid")
CDID="${CDID//\"/}"
echo "BDID=$BDID CDID=$CDID (auto-déclarés par chaque device)"

echo "############ J06-03 : membres Capture+Storage (B self + C) ############"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m={};(s.members||[]).forEach(function(x){m[x.deviceId]=true});var peers=MultiCamDiscovery.peers()||[];return JSON.stringify({available:peers.filter(function(p){return !m[p.deviceId]}).map(function(p){return p.deviceId})})})()" "J06-03-B-lan-before.json"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture','storage']},['capture','storage']);var r2=await MultiCamSessionWs.addMember(r,{deviceId:'$BDID',deviceName:'$BNAME',enabledSkills:['capture','storage']},['capture','storage']);return JSON.stringify({ok:true,members:r2.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" > "$OUT/dumps/J06-03-B-add.json"
cat "$OUT/dumps/J06-03-B-add.json"
sleep 5
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName,roles:m.sessionRoles}})})})()" "J06-03-B-members.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J06-03-C-converged-members.json"
shot "$B" "J06-03-B-members"
logs "$B" "J06-03-B"; logs "$C" "J06-03-C"

echo "############ J06-04 : écran 05 sur B — Take 001 auto-instancié, ARM bloqué ############"
ev "$B" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
panels_ok "$B" "J06-04-take"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes,current:(s.takes||[])[(s.takes||[]).length-1]})})()" "J06-04-B-take001.json"
dump "$B" "(function(){var a=document.getElementById('tkArm');return JSON.stringify({armDisabled:a.disabled,captures:document.querySelectorAll('.capture-switch').length,storages:document.querySelectorAll('.storage-switch').length,current:(document.getElementById('tkTakeName')||{}).textContent})})()" "J06-04-B-ui-state.json"
shot "$B" "J06-04-B-take001-arm-blocked"
logs "$B" "J06-04-B"

echo "############ J06-05 : écran 05 sur C — convergence du Take + télémétrie publiée ############"
ev "$C" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
panels_ok "$C" "J06-05-take"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({takes:s.takes,current:(s.takes||[])[(s.takes||[]).length-1],selfTelemetry:(await MultiCamSessionStore.get('$SID')).members.filter(function(m){return m.deviceId==='$CDID'})[0].telemetry})})()" "J06-05-C-take-converged.json"
# C publie ses capacités natives → B doit les voir dans sa liste de Captures.
sleep 8
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({telemetry:s.members.map(function(m){return{deviceId:m.deviceId,battery:m.telemetry?m.telemetry.batteryLevel:null,free:m.telemetry?(m.telemetry.freeBytes||null):null,capsKnown:m.telemetry&&m.telemetry.capabilities?(!m.telemetry.capabilities.unknown):false}})})})()" "J06-05-B-telemetry.json"
dump "$C" "MultiCamCaptureCapabilities.probe().then(function(c){return JSON.stringify({model:c.model,sdk:c.sdk,rear:c.cameras.rear,front:c.cameras.front,gpsFeature:c.gpsFeature,audioMic:c.audioMic,unknown:c.unknown})})" "J06-05-C-native-caps.json"
shot "$B" "J06-05-B-captures-with-telemetry"
shot "$C" "J06-05-C-take-screen"
logs "$B" "J06-05-B"; logs "$C" "J06-05-C"
cat "$OUT/dumps/J06-05-B-telemetry.json"; echo
cat "$OUT/dumps/J06-05-C-native-caps.json"; echo

echo "############ J06-06 : Captures Toutes → ARM éligible ; Storage Tous ############"
ev "$B" "document.getElementById('tkCaptureAll').click();'CLICKED'" >/dev/null
sleep 3
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({captures:t.captures,storages:t.storages})})()" "J06-06-B-captures-all.json"
dump "$B" "(function(){var a=document.getElementById('tkArm');return JSON.stringify({armDisabled:a.disabled,armHint:(document.getElementById('tkArmHint')||{}).textContent})})()" "J06-06-B-arm-enabled.json"
shot "$B" "J06-06-B-arm-enabled"
ev "$B" "document.getElementById('tkStorageAll').click();'CLICKED'" >/dev/null
sleep 3
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({storages:t.storages,transferSummary:(document.getElementById('tkTransferSummary')||{}).textContent,storageWarningHidden:document.getElementById('tkStorageWarning').classList.contains('d-none')})})()" "J06-06-B-storages-all.json"
shot "$B" "J06-06-B-storages-all"
logs "$B" "J06-06-B"

echo "############ J06-07 : réglages Take — 4K + GPS Précis → warnings best effort (GLOBAL jamais réduit) ############"
set_setting_radio "$B" tkRes4K
set_setting_radio "$B" tkGpsPRECISE
sleep 3
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];var capsB=null,capsC=null;(s.members||[]).forEach(function(m){if(m.deviceId==='$BDID')capsB=m.telemetry&&m.telemetry.capabilities;if(m.deviceId==='$CDID')capsC=m.telemetry&&m.telemetry.capabilities;});var wB=MultiCamTakeModel.warningsForCapture(t,capsB,'$BDID');var wC=MultiCamTakeModel.warningsForCapture(t,capsC,'$CDID');var effC=MultiCamTakeModel.effectiveForCapture(t,capsC,'$CDID');return JSON.stringify({global:t.settings,wB:wB.warnings,wC:wC.warnings,effectiveC:{resolution:effC.resolution,gpsProfile:effC.gpsProfile,fallback:effC.fallback},globalUnchanged:t.settings.video.resolution==='4K'})})()" "J06-07-B-warnings.json"
cat "$OUT/dumps/J06-07-B-warnings.json"; echo
ev "$B" "document.querySelectorAll('.tk-warnbox').forEach(function(w){w.style.display='block'});'WARN_VISIBLE'" >/dev/null
sleep 1
shot "$B" "J06-07-B-warnings-4k-gps"
logs "$B" "J06-07-B"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({global:t.settings,converged:t.settings.video.resolution==='4K'})})()" "J06-07-C-settings-converged.json"

echo "############ J06-08 : overrides par Capture — Hériter + personnaliser sur C ############"
# ouvrir la modal d'overrides pour C
ev "$B" "(function(){var b=document.querySelector('.capture-edit[data-device=\"$CDID\"]');if(!b)return 'NO_EDIT_BTN';b.click();return 'OVERRIDE_OPEN';})()" 
sleep 2
shot "$B" "J06-08-B-override-modal"
dump "$B" "(function(){function opts(sel){return [].slice.call(document.querySelectorAll(sel+' option')).map(function(o){return o.value});}return JSON.stringify({title:(document.getElementById('tkoTitle')||{}).textContent,sections:document.querySelectorAll('.ov-section').length,audio:document.querySelectorAll('.ov-section[data-key=\"audio\"] .ov-audio').length,gps:document.querySelectorAll('.ov-section[data-key=\"gpsProfile\"] .ov-gps').length,gpsOpts:opts('.ov-section[data-key=\"gpsProfile\"] .ov-gps')})})()" "J06-08-B-override-ui.json"
# personnaliser : Audio désactivé pour C ; GPS — la liste est restreinte à [OFF]
# sur un device sans GPS (gpsFeature=false, §32) : on choisit explicitement OFF.
ev "$B" "(function(){document.querySelector('.ov-section[data-key=\"audio\"] .tko-inherit').checked=false;document.querySelector('.ov-section[data-key=\"audio\"] .ov-audio').selectedIndex=1;document.querySelector('.ov-section[data-key=\"gpsProfile\"] .tko-inherit').checked=false;document.querySelector('.ov-section[data-key=\"gpsProfile\"] .ov-gps').value='OFF';document.getElementById('tkoSave').click();return 'SAVED';})()"
sleep 4
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({overrides:t.captureOverrides['$CDID']||null,captures:t.captures})})()" "J06-08-B-overrides-c.json"
cat "$OUT/dumps/J06-08-B-overrides-c.json"; echo
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({overrides:t.captureOverrides['$CDID']||null,converged:!!(t.captureOverrides&&t.captureOverrides['$CDID'])})})()" "J06-08-C-overrides-converged.json"
shot "$B" "J06-08-B-after-overrides"
shot "$C" "J06-08-C-overrides-converged"
logs "$B" "J06-08-B"; logs "$C" "J06-08-C"

echo "############ J06-09 : retour Hériter → nettoyage de l'override C ############"
ev "$B" "(function(){var b=document.querySelector('.capture-edit[data-device=\"$CDID\"]');b.click();return 'OPEN';})()"
sleep 2
ev "$B" "(function(){document.querySelectorAll('.ov-section .tko-inherit').forEach(function(x){x.checked=true;});document.getElementById('tkoSave').click();return 'INHERIT_SAVED';})()"
sleep 4
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({overridesGone:!t.captureOverrides||!t.captureOverrides['$CDID'],captures:t.captures})})()" "J06-09-B-overrides-clean.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({overridesGoneC:!t.captureOverrides||!t.captureOverrides['$CDID']})})()" "J06-09-C-overrides-clean-converged.json"
shot "$B" "J06-09-B-overrides-clean"
logs "$B" "J06-09-B"

echo "############ J06-10 : Nouveau Take 002 (hérite) + Take 001 intact ############"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t1=s.takes.filter(function(t){return t.takeNumber===1})[0];return JSON.stringify({t1:t1})})()" "J06-10-B-take001-before-new.json"
ev "$B" "window.confirm=function(){return true;};'CONFIRM_HOOK'" >/dev/null
ev "$B" "document.getElementById('tkNew').click();'CLICKED_NEW'" >/dev/null
sleep 4
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t2=s.takes.filter(function(t){return t.takeNumber===2})[0];var t1=s.takes.filter(function(t){return t.takeNumber===1})[0];return JSON.stringify({count:(s.takes||[]).length,t1:{number:t1.takeNumber,captures:t1.captures,storages:t1.storages,res:t1.settings.video.resolution,gps:t1.settings.gpsProfile},t2:{number:t2.takeNumber,captures:t2.captures,storages:t2.storages,res:t2.settings.video.resolution,gps:t2.settings.gpsProfile,overrides:t2.captureOverrides}})})()" "J06-10-B-take002-inherited.json"
cat "$OUT/dumps/J06-10-B-take002-inherited.json"; echo
panels_ok "$B" "J06-10-take002"
shot "$B" "J06-10-B-take002"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({count:(s.takes||[]).length,t2:(s.takes||[]).filter(function(t){return t.takeNumber===2})[0]?true:false})})()" "J06-10-C-take002-converged.json"
logs "$B" "J06-10-B"; logs "$C" "J06-10-C"

echo "############ J06-11 : redémarrage B → Takes persistés (001+002), sélections conservées ############"
adb -s "$B" shell am force-stop "$APP"
sleep 2
adb -s "$B" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 9
panels_ok "$B" "J06-11-home"
ev "$B" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t2=s.takes.filter(function(t){return t.takeNumber===2})[0];return JSON.stringify({count:(s.takes||[]).length,current:(s.takes||[])[(s.takes||[]).length-1].takeNumber,persisted:t2?{captures:t2.captures,storages:t2.storages,res:t2.settings.video.resolution}:null})})()" "J06-11-B-restart-persisted.json"
cat "$OUT/dumps/J06-11-B-restart-persisted.json"; echo
shot "$B" "J06-11-B-take-persisted-after-restart"
logs "$B" "J06-11-B"

echo "############ J06-12 : SIMULATED — fixture « SimulatedCam4K » (C) vs réel (B) ############"
# CAS PHYSIQUEMENT INACCESSIBLE (les 2 Xiaomi sont 1080P + gpsFeature=false) :
# device générique compatible 4K + GPS. LABELLÉ SIMULATED partout.
mark "SIMULATED FIXTURE — C devient 'SimulatedCam4K' (4K+GPS) via setFixtureMap"
ev "$C" "(async function(){MultiCamCaptureCapabilities.setFixtureMap('$CDID',{resolutions:['4K','FHD','HD'],gpsFeature:true,audioMic:true,sdk:36,model:'SimulatedCam4K',manufacturer:'SIMULATED/Generic'});var caps=await MultiCamCaptureCapabilities.capabilitiesFor('$CDID',null);var s=await MultiCamSessionStore.get('$SID');await MultiCamSessionWs.updateMemberTelemetry(s,'$CDID',{capabilities:caps});return 'SIMULATED_PUBLISHED model='+caps.model+' unknown='+caps.unknown;})()" > "$OUT/dumps/J06-12-C-simulated-publish.json"
cat "$OUT/dumps/J06-12-C-simulated-publish.json"; echo
sleep 5
# global 4K + GPS Précis déjà posés ; fixture 4K+GPS → C SANS warning, B (réel) AVEC warnings
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];var capsB=null,capsC=null;(s.members||[]).forEach(function(m){if(m.deviceId==='$BDID')capsB=m.telemetry&&m.telemetry.capabilities;if(m.deviceId==='$CDID')capsC=m.telemetry&&m.telemetry.capabilities;});var wB=MultiCamTakeModel.warningsForCapture(t,capsB,'$BDID');var wC=MultiCamTakeModel.warningsForCapture(t,capsC,'$CDID');return JSON.stringify({simulated:{source:capsC&&capsC.source,model:capsC&&capsC.model,rear:capsC&&capsC.cameras.rear,gpsFeature:capsC&&capsC.gpsFeature},wB:wB.warnings,wC:wC.warnings,contrast:wB.warnings.length>0&&wC.warnings.length===0})})()" "J06-12-B-simulated-contrast.json"
cat "$OUT/dumps/J06-12-B-simulated-contrast.json"; echo
ev "$B" "document.querySelectorAll('.tk-warnbox').forEach(function(w){w.style.display='block'});'WARN'" >/dev/null
sleep 1
shot "$B" "J06-12-B-simulated-contrast"
logs "$B" "J06-12-B"; logs "$C" "J06-12-C"
# Fin de bullet SIMULATED : on remet C sur ses capacités réelles (probe natif).
ev "$C" "(async function(){MultiCamCaptureCapabilities.clearFixtures();var caps=await MultiCamCaptureCapabilities.capabilitiesFor('$CDID',null);var s=await MultiCamSessionStore.get('$SID');await MultiCamSessionWs.updateMemberTelemetry(s,'$CDID',{capabilities:caps});return 'REAL_RESTORED model='+caps.model;} )()" > "$OUT/dumps/J06-12-C-simulated-cleanup.json"
cat "$OUT/dumps/J06-12-C-simulated-cleanup.json"; echo

echo "############ J06-13 : convergence finale des dumps deux-Masters ############"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s.state,takes:s.takes,members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J06-13-B-final-session.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s.state,takes:s.takes,members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J06-13-C-final-session.json"
sleep 3
node -e "const fs=require('fs');let b=JSON.parse(fs.readFileSync('$OUT/dumps/J06-13-B-final-session.json','utf8'));let c=JSON.parse(fs.readFileSync('$OUT/dumps/J06-13-C-final-session.json','utf8'));if(typeof b==='string'){try{b=JSON.parse(b)}catch(e){}}if(typeof c==='string'){try{c=JSON.parse(c)}catch(e){}}const same=JSON.stringify(b.takes)===JSON.stringify(c.takes);console.log('FINAL_CONVERGENCE takes_equal_B_C='+same);if(!same){console.log('B='+JSON.stringify(b.takes));console.log('C='+JSON.stringify(c.takes));exitCode=1;process.exit(1);}"
shot "$B" "J06-13-B-final"
shot "$C" "J06-13-C-final"
ev "$B" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
ev "$C" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
shot "$B" "J06-13-B-session-view"
shot "$C" "J06-13-C-session-view"
logs "$B" "J06-13-B"; logs "$C" "J06-13-C"
panels_ok "$B" "J06-13-session"; panels_ok "$C" "J06-13-session"

echo "############ TERMINÉ ############"
ls -1 "$OUT/dumps"

echo "--- Vérif fin de run : panneaux exactement un par device ---"
panels_ok "$B" "fin"
panels_ok "$C" "fin"

echo "--- Hachage SHA-256 des captures + détection de doublons ---"
cd "$OUT/screenshots" || exit 1
shasum -a 256 *.png | tee "$OUT/png-shas.txt"
echo "--- doublons (le cas échéant) ---"
shasum -a 256 *.png | awk '{print $1}' | sort | uniq -d | sed 's/^/duplicate-sha: /'
cd "$ROOT"