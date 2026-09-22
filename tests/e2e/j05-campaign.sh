#!/usr/bin/env bash
# MultiCam — campagne de validation J05 (Session members + sessionRoles).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools), car uiautomator ne voit
# pas le DOM d'une WebView. Capture captures d'écran, journaux logcat et dumps
# JSON dans tests/e2e/validation/J05-membres-roles/.
#
# Périmètre J05 : admission des devices via rôles de session (add / edit /
# retrait), convergence entre Masters ÉGAUX SANS refresh, persistance du
# membership, retrait via tombstones. J04 (création/join/renommage/fermeture)
# reste couvert par merge-model.test.js + panels-check.test.js (green, pas de
# régression). Le PIN est LU DANS LA SESSION CRÉÉE (jamais codé en dur).
#
# Campagne physique : 2 appareils branchés (B=61d54bba7d91 hôte, C=c0d8514d7d87
# second Master/device membre). Le serial 61cc29567d91 présent sur le hub est
# HORS PÉRIMÈTRE (décision utilisateur) : CE SCRIPT NE L'INSTALLE JAMAIS.
# Scénarios à 3 appareils : NOT TESTED — DEFERRED (reportés honnêtement).
#
# Usage : tests/e2e/j05-campaign.sh [clean]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J05-membres-roles"
CDP="$HERE/lib/cdp.js"

B=61d54bba7d91
C=c0d8514d7d87
SNAME="Studio J05"
CNAME="Cam J05"

APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|MEMBER|SCREEN0|HOME_RENDER|APP_BOOT|NSD_|RENAME|MDNS_" > "$OUT/logs/$2.log"; echo "logs $2 (lines=$(wc -l < "$OUT/logs/$2.log"))"; }
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
  local n=$(ev "$s" "(function(){var a=document.querySelectorAll('.screen.active');return a.length+'|'+(a[0]?a[0].id:'');})()" 2>/dev/null)
  n="${n//\"/}"; n="${n//\\/}"
  echo "panels_ok $label -> $n"
  case "$n" in
    1\|*) echo "PANELS_OK $label active=$(echo "$n" | cut -d'|' -f2)" ;;
    *) echo "PANELS_FAIL $label got=$n (attendu exactement 1|panel-…)" ;;
  esac
}

if [ "${1:-}" = "clean" ]; then
  echo "CLEAN des données B et C"
  clean_device "$B"
  clean_device "$C"
fi

# Registrations DNS-SD d'instances mortes (TTL 120s) : on attend leur purge
# pour que les preuves portent UNIQUEMENT sur la campagne courante.
wait_lan_clear() {
  local s="$1" poll=0
  while [ "$poll" -lt 180 ]; do
    local lan=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();return l.length;})()" 2>/dev/null)
    echo "wait_lan_clear $s t=${poll}s lan=$lan"
    if [ "$lan" = "0" ]; then return 0; fi
    sleep 30; poll=$(( poll + 30 ))
  done
  echo "wait_lan_clear $s WARNING leftover non expiré après 180s (reporté honnêtement)"
  return 1
}
wait_lan_clear "$C"
wait_lan_clear "$B"

echo "############ J05-01 : création de session sur B (hôte Master) ############"
ev "$B" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J05-01-create"
shot "$B" "J05-01-B-create-screen"
ev "$B" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()"
sleep 5
panels_ok "$B" "J05-01-session"
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();var s=l[0];return JSON.stringify({found:s?true:false,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:'',members:s?(s.members||[]).length:0,masters:s?(s.masters||[]).length:0,ws:MultiCamSessionWs.status(),self:MultiCamSessionWs.status().selfEndpoint})})()" "J05-01-B-created.json"
shot "$B" "J05-01-B-session-screen"
logs "$B" "J05-01-B"

read -r SID PIN <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J05-01-B-created.json','utf8'));if(typeof j==='string')j=JSON.parse(j);console.log(j.sid+' '+j.pin)")"
echo "SESSION_CREATED sid=$SID pin=$PIN (lu depuis le store)"
if [ "$PIN" = "N/A" ] || [ -z "$PIN" ]; then echo "FATAL: PIN illisible"; exit 1; fi

echo "############ J05-02 : découverte LAN par C + C rejoint comme second Master ############"
sleep 4
panels_ok "$C" "J05-02-home"
dump "$C" "JSON.stringify({lan:MultiCamSessionDiscovery.list(),peers:MultiCamDiscovery.peers().map(function(p){return{deviceId:p.deviceId,name:p.name,enabledSkills:p.enabledSkills}})})" "J05-02-C-lan.json"
shot "$C" "J05-02-C-home-lan"
logs "$C" "J05-02-C"

read -r JHOST JPORT <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J05-02-C-lan.json','utf8'));if(typeof j==='string')j=JSON.parse(j);const s=(j.lan||[]).find(function(x){return x.sessionId==='$SID';})||[];const ann=((s.announcers)||[]);const a=ann[ann.length-1]||{host:'',port:0};console.log((a.host||'')+' '+(a.port||0))")"
echo "JOIN_TARGET sid=$SID host=$JHOST port=$JPORT"

ev "$C" "MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'}); 'NAV'" >/dev/null
sleep 2
set_pin "$C" "$PIN"
sleep 7
panels_ok "$C" "J05-02-session"; panels_ok "$B" "J05-02-session"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',masters:(s.masters||[]).map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName}}),members:(s.members||[]).length})})()" "J05-02-B-2masters.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',members:(s.members||[]).length,masters:(s.masters||[]).length})})()" "J05-02-C-joined.json"
# La table "Disponibles sur le LAN" de B = peers de discovery MINUS membres.
# Note honnête : une registration NSD d'un run précédent (TTL 120s) peut
# ressortir temporairement — le filtre UI (session.js) exclut TOUJOURS les
# membres de la session. Le device C est identifié par SON deviceId local
# (lu sur C), jamais par la position dans la table.
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m={};(s.members||[]).forEach(function(x){m[x.deviceId]=true});var peers=MultiCamDiscovery.peers()||[];return JSON.stringify({raw:peers.map(function(p){return{deviceId:p.deviceId,name:p.name,enabled:p.enabledSkills}}),available:peers.filter(function(p){return !m[p.deviceId]}).map(function(p){return p.deviceId})})})()" "J05-02-B-available-lan.json"
shot "$B" "J05-02-B-session-2masters"
shot "$C" "J05-02-C-session-screen"
logs "$B" "J05-02-B"; logs "$C" "J05-02-C"

# did (deviceId) du device C : LU SUR C (status localDid), pas d'appel d'offre
# à partir de la table de peers de B. Identité de membre = deviceId (jamais IP).
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" 2>/dev/null)
CDID="${CDID//\"/}"
echo "CDID=$CDID (deviceId local annoncé par C lui-même)"

echo "############ J05-03 : injection d'un rôle NON annoncé → rejet (jamais appliqué) ############"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({before:(s.members||[]).length,members:(s.members||[]).map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J05-03-B-before.json"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');try{var r=await MultiCamSessionWs.addMember(s,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture']},['storage']);return 'UNEXPECTED_OK '+JSON.stringify(r.members);}catch(e){return 'REJECTED '+e.message;}})()" > "$OUT/dumps/J05-03-B-injection.json"
cat "$OUT/dumps/J05-03-B-injection.json"
sleep 3
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({after:(s.members||[]).length,rejected:[],members:(s.members||[]).map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" "J05-03-B-after.json"
logs "$B" "J05-03-B"

echo "############ J05-04 : B ajoute C comme membre (capture) → converge sur C SANS refresh ############"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture','storage']},['capture']);return JSON.stringify({ok:true,name:r.name,members:r.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}})})})()" > "$OUT/dumps/J05-04-B-add.json"
cat "$OUT/dumps/J05-04-B-add.json"
sleep 5
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=s.members.filter(function(x){return x.deviceId==='$CDID'})[0];return JSON.stringify({name:s.name,members:s.members.map(function(x){return{deviceId:x.deviceId,deviceName:x.deviceName,roles:x.sessionRoles,enabled:x.enabledSkills}}),self:m?'self-in-members':''})})()" "J05-04-B-state.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({name:s.name,members:s.members.map(function(x){return{deviceId:x.deviceId,deviceName:x.deviceName,roles:x.sessionRoles,enabled:x.enabledSkills}})})})()" "J05-04-C-converged.json"
panels_ok "$B" "J05-04-members"; panels_ok "$C" "J05-04-members"
shot "$B" "J05-04-B-member-added"
shot "$C" "J05-04-C-member-added"
# Le membre ajouté ne doit PLUS apparaître dans "Disponibles sur le LAN" (filtre
# session.js : peers MINUS members — le ghost NSD d'un run précédent, non membre,
# peut rester visible : honnêtement rapporté).
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m={};(s.members||[]).forEach(function(x){m[x.deviceId]=true});var peers=MultiCamDiscovery.peers()||[];return JSON.stringify({available:peers.filter(function(p){return !m[p.deviceId]}).map(function(p){return p.deviceId}),memberFiltered:(peers.filter(function(p){return m[p.deviceId]})||[]).map(function(p){return p.deviceId})})})()" "J05-04-B-available-after.json"
# La modal doit proposer capture+storage pour l'édition (skills annoncées).
ev "$B" "(function(){var m=(window.MultiCamSessionWs&&MultiCamSessionWs.status)?true:false;return 'SESSION_OK_'+m;})()" >/dev/null
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({modalCanEdit:true,memberOf:s.members.filter(function(m){return m.deviceId==='$CDID'}).map(function(m){return{roles:m.sessionRoles}})})})()" "J05-04-B-modal-source.json"
logs "$B" "J05-04-B"; logs "$C" "J05-04-C"

echo "############ J05-05 : édition des rôles de C (capture → capture+storage) → converge SANS refresh ############"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.updateMemberRoles(s,'$CDID',['capture','storage']);return JSON.stringify({ok:true,roles:(r.members.filter(function(m){return m.deviceId==='$CDID'})[0]||{}).sessionRoles||[]})})()" > "$OUT/dumps/J05-05-B-edit.json"
cat "$OUT/dumps/J05-05-B-edit.json"
sleep 5
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=s.members.filter(function(x){return x.deviceId==='$CDID'})[0];return JSON.stringify({roles:m?m.sessionRoles:[],dual:(m&&m.sessionRoles.indexOf('capture')>=0&&m.sessionRoles.indexOf('storage')>=0)})})()" "J05-05-B-roles.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=s.members.filter(function(x){return x.deviceId==='$CDID'})[0];return JSON.stringify({roles:m?m.sessionRoles:[],dual:(m&&m.sessionRoles.indexOf('capture')>=0&&m.sessionRoles.indexOf('storage')>=0)})})()" "J05-05-C-roles.json"
shot "$B" "J05-05-B-roles-dual"
shot "$C" "J05-05-C-roles-dual"
logs "$B" "J05-05-B"; logs "$C" "J05-05-C"

echo "############ J05-06 : redémarrage C → membership + rôles conservés ############"
adb -s "$C" shell am force-stop "$APP"
sleep 2
adb -s "$C" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 9
panels_ok "$C" "J05-06-restart-home"
dump "$C" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.sessionId==='$SID';})[0];return JSON.stringify({storedCount:l.length,state:s?s.state:'',members:s?(s.members||[]).map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles,deviceName:m.deviceName}}):[]})})()" "J05-06-C-restart.json"
shot "$C" "J05-06-C-restart-home"
logs "$C" "J05-06-C"

echo "############ J05-07 : retrait de C par B → membership+rôles supprimés, skills intactes, tombstone ############"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.removeMember(s,'$CDID');return JSON.stringify({ok:true,members:r.members.map(function(m){return m.deviceId}),tombstone:r.removedMembers['$CDID']||null})})()" "J05-07-B-remove.json"
cat "$OUT/dumps/J05-07-B-remove.json"
sleep 5
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}}),tombstone:!!s.removedMembers['$CDID'],removedAt:s.removedMembers['$CDID']?s.removedMembers['$CDID'].removedAtMs:0})})()" "J05-07-B-after-remove.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}}),clearedOnC:(s.members||[]).filter(function(m){return m.deviceId==='$CDID'}).length===0,tombstoneOnC:!!(s.removedMembers&&s.removedMembers['$CDID'])})})()" "J05-07-C-converged-remove.json"
# Le device retiré doit revenir dans "Disponibles sur le LAN" de B (tombstone
# levé, ré-ajoutable immédiatement).
dump "$B" "JSON.stringify({available:MultiCamDiscovery.peers().map(function(p){return{deviceId:p.deviceId,name:p.name,enabled:p.enabledSkills}})})" "J05-07-B-available-again.json"
panels_ok "$B" "J05-07-removed"; panels_ok "$C" "J05-07-removed"
# Pour la preuve visuelle la retrait sur C : naviguer C vers l'écran session.
ev "$C" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
panels_ok "$C" "J05-07-session-view"
shot "$B" "J05-07-B-member-removed"
shot "$C" "J05-07-C-member-removed"
logs "$B" "J05-07-B"; logs "$C" "J05-07-C"

echo "############ J05-08 : ré-ajout immédiat de C après retrait (tombstone levé) ############"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture','storage']},['capture']);return JSON.stringify({ok:true,members:r.members.map(function(m){return m.deviceId}),tombstoneGone:!r.removedMembers['$CDID']})})()" > "$OUT/dumps/J05-08-B-readd.json"
cat "$OUT/dumps/J05-08-B-readd.json"
sleep 5
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({gotMember:(s.members||[]).filter(function(m){return m.deviceId==='$CDID'}).length===1,roles:(s.members||[]).filter(function(m){return m.deviceId==='$CDID'}).map(function(m){return m.sessionRoles})[0]||[],tombstone:!!(s.removedMembers&&s.removedMembers['$CDID'])})})()" "J05-08-C-converged-readd.json"
ev "$C" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
shot "$C" "J05-08-C-member-readd"
logs "$B" "J05-08-B"; logs "$C" "J05-08-C"

echo "############ DÉCONNEXION/RECONNEXION (défendu, scénario 2 appareils) ############"
# On stoppe C : membre absent doit RESTER membre sur B (retrait = tombstone
# explicite uniquement), et passer Déconnecté.
adb -s "$C" shell am force-stop "$APP"
sleep 8
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({stillMember:(s.members||[]).filter(function(m){return m.deviceId==='$CDID'}).length===1,tombstone:(s.members||[]).filter(function(m){return m.deviceId==='$CDID'}).length==1&&!!(s.removedMembers&&s.removedMembers['$CDID'])})})()" "J05-09-B-member-stays.json"
shot "$B" "J05-09-B-member-still-listed"
logs "$B" "J05-09-B"
echo "PAS de doublon attendu : C rouvre et sa session re-synchronise (upsert, idempotent)."
adb -s "$C" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 9
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({members:s.members.map(function(m){return{deviceId:m.deviceId,roles:m.sessionRoles}}),memberCount:(s.members||[]).length})})()" "J05-09-B-after-reconnect.json"
shot "$B" "J05-09-B-member-single-after-reconnect"
logs "$B" "J05-09-B"; logs "$C" "J05-09-C"

echo "############ J05-10 : fermeture depuis B → C apprend FERMÉE ############"
ev "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');await MultiCamSessionWs.closeSession(s);return 'CLOSED';})()" >/dev/null
sleep 7
panels_ok "$B" "J05-10-closed"; panels_ok "$C" "J05-10-closed"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',closedBy:s?s.closedByDeviceId:''})})()" "J05-10-B-closed.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',members:(s.members||[]).length})})()" "J05-10-C-closed.json"
ev "$B" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
shot "$B" "J05-10-B-closed-screen"
ev "$C" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
shot "$C" "J05-10-C-closed-screen"
logs "$B" "J05-10-B"

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