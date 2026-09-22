#!/usr/bin/env bash
# MultiCam — campagne de validation J04 (Sessions + second Master).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools), car uiautomator ne voit
# pas le DOM d'une WebView. Capture captures d'écran, journaux logcat et dumps
# JSON dans tests/e2e/validation/J04-sessions/.
#
# SPA : les écrans sont des panneaux de index.html — pas de URL documentaire.
# Le PIN est LU DANS LA SESSION CRÉÉE (jamais codé en dur). Données vierges.
# Le but du script : produire PREUVES HONNÊTES (logs parsables + dumps) pour
# chaque scénario ; le verdict PASS/FAIL est porté par l'inspection des dumps.
#
# Campagne physique : 2 appareils branchés (B=61d54bba7d91 hôte, C=c0d8514d7d87
# second Master). Décision utilisateur (2026-09-22) : A indisponible pour
# installation (INSTALL_FAILED_USER_RESTRICTED) ; les scénarios à 3 appareils
# (déterminisme à 3 Masters, défauts 3e jonction) sont reportés, PAS affaiblis.
# Usage : tests/e2e/j04-campaign.sh [clean]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J04-sessions"
CDP="$HERE/lib/cdp.js"

B=61d54bba7d91
C=c0d8514d7d87
SNAME="Studio J04"
RNAME="Studio J04 renommee"

APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|SCREEN02|SCREEN03|HOME_RENDER|APP_BOOT|NSD_|RENAME" > "$OUT/logs/$2.log"; echo "logs $2 (lines=$(wc -l < "$OUT/logs/$2.log"))"; }
dump(){ echo -n "$2" | node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(cat "$OUT/dumps/$3")"; }

clean_device() {
  local s="$1"
  adb -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
  echo "clean $s: $(adb -s "$s" shell pm clear "$APP" 2>&1 )"
  # relance propre : boot vierge (SESSION_BOOT stored=0)
  adb -s "$s" shell am start -n "$APP/.MainActivity" >> "$OUT/logs/boot-$s.log" 2>&1
  adb -s "$s" logcat -c
  sleep 8
  echo "clean boot $s"
}

set_pin() { # $1 serial — tape le PIN dans le panneau Rejoindre (événement input réel)
  local s="$1" p="$2"
  ev "$s" "(function(p){for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);var n=document.createEvent('Event');n.initEvent('input',true,true);b.value=p[i];b.dispatchEvent(n);}return 'PIN_SET_'+p;})('$p')"
}

read_pin() { # $1 serial $2 sid -> PIN (lu depuis la session créée)
  ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.sessionId==='$2';})[0];return s?s.pin:'N/A';})()"
}

mark(){ echo "### $1"; }

# Invariant SPA : à chaque navigation, EXACTEMENT un panneau .screen.active.
# (défaut corrigé J04 : panneaux empilés — revue visuelle humaine 2026-09-22)
# Invariant SPA : à chaque navigation, EXACTEMENT un panneau .screen.active.
# (défaut corrigé J04 : panneaux empilés — revue visuelle humaine 2026-09-22)
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

# Les registrations DNS-SD d'instances mortes (TTL 120s) peuvent polluer la
# table LAN d'un run précédent. On attend qu'elles expirent pour que les preuves
# portent UNIQUEMENT sur la campagne courante (J04-04).
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

echo "############ J04-01 : création de session sur B ############"
ev "$B" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J04-01-create"
shot "$B" "J04-01-B-create-screen"
ev "$B" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()"
sleep 5
panels_ok "$B" "J04-01-session"
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();var s=l[0];return JSON.stringify({found:s?true:false,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:'',masters:s?(s.masters||[]).length:0,ws:MultiCamSessionWs.status(),self:MultiCamSessionWs.status().selfEndpoint})})()" "J04-01-B-created.json"
shot "$B" "J04-01-B-session-screen"
logs "$B" "J04-01-B"

read -r SID PIN <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J04-01-B-created.json','utf8'));if(typeof j==='string')j=JSON.parse(j);console.log(j.sid+' '+j.pin)")"
echo "SESSION_CREATED sid=$SID pin=$PIN (lu depuis le store, pas codé en dur)"
if [ "$PIN" = "N/A" ] || [ -z "$PIN" ]; then echo "FATAL: PIN illisible"; exit 1; fi

echo "############ J04-02 : découverte LAN de la session par C ############"
sleep 4
panels_ok "$C" "J04-02-home"
dump "$C" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "J04-02-C-lan.json"
shot "$C" "J04-02-C-home-lan"
logs "$C" "J04-02-C"

read -r JHOST JPORT <<< "$(node -e "const fs=require('fs');let j=JSON.parse(fs.readFileSync('$OUT/dumps/J04-02-C-lan.json','utf8'));if(typeof j==='string')j=JSON.parse(j);const s=(j.lan||[]).find(function(x){return x.sessionId==='$SID';})||[];const ann=((s.announcers)||[]);const a=ann[ann.length-1]||{host:'',port:0};console.log((a.host||'')+' '+(a.port||0))")"
echo "JOIN_TARGET sid=$SID host=$JHOST port=$JPORT"

echo "############ J04-05 : PIN erroné sur C -> rejet vérifié (session inchangée sur B) ############"
ev "$C" "MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$C" "J04-05-join"
shot "$C" "J04-05-C-join-screen"
set_pin "$C" "1111"
sleep 6
panels_ok "$C" "J04-05-rejected"
dump "$C" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({storedCount:l.length,panelVisible:!!document.getElementById('panel-join').classList.contains('active'),pinStatus:document.getElementById('pinStatus').textContent})})()" "J04-05-C-reject.json"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',pin:s?s.pin:'',masters:s?(s.masters||[]).length:0})})()" "J04-05-B-unchanged.json"
shot "$C" "J04-05-C-wrong-pin"
logs "$C" "J04-05-C"

echo "############ J04-03 : C rejoint avec le PIN réel -> convergence 2 Masters ############"
ev "$C" "MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'}); 'NAV'" >/dev/null
sleep 2
set_pin "$C" "$PIN"
sleep 7
panels_ok "$C" "J04-03-session"; panels_ok "$B" "J04-03-session"
dump "$C" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({sessions:l.map(function(s){return{sid:s.sessionId,name:s.name,state:s.state,pin:s.pin,masters:(s.masters||[]).map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName}})}}),ws:MultiCamSessionWs.status(),panel:['panel-session','panel-join'].filter(function(id){return document.getElementById(id).classList.contains('active')})})})()" "J04-03-C-joined.json"
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({sessions:l.map(function(s){return{sid:s.sessionId,name:s.name,state:s.state,pin:s.pin,masters:(s.masters||[]).map(function(m){return{deviceId:m.deviceId,deviceName:m.deviceName}})}}),serverConns:MultiCamSessionWs.status().serverConns,clientConns:MultiCamSessionWs.status().clientConns})})()" "J04-03-B-converged.json"
shot "$B" "J04-03-B-session-2masters"
shot "$C" "J04-03-C-session-screen"
logs "$B" "J04-03-B"; logs "$C" "J04-03-C"

echo "############ J04-04 : renommage depuis C -> propagé sur B + TXT DNS-SD ############"
ev "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');await MultiCamSessionWs.renameSession(s,'$RNAME');return 'RENAMED';})()" >/dev/null
sleep 6
panels_ok "$B" "J04-04-renamed"; panels_ok "$C" "J04-04-renamed"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({name:s?s.name:'',nameBy:s?s.nameByDeviceId:''})})()" "J04-04-B-name.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({name:s?s.name:'',nameBy:s?s.nameByDeviceId:''})})()" "J04-04-C-name.json"
dump "$B" "JSON.stringify(MultiCamSessionDiscovery.list())" "J04-04-B-lan-txt.json"
shot "$B" "J04-04-B-renamed"
shot "$C" "J04-04-C-renamed"

echo "############ J04-08 : redémarrage B -> session conservée, PAS de nouvelle session ############"
adb -s "$B" shell am force-stop "$APP"
sleep 2
adb -s "$B" shell am start -n "$APP/.MainActivity" >/dev/null
sleep 9
panels_ok "$B" "J04-08-restart-home"
dump "$B" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({count:l.length,sessions:l.map(function(s){return{sid:s.sessionId,name:s.name,state:s.state,pin:s.pin,masters:(s.masters||[]).length}})})})()" "J04-08-B-restart.json"
shot "$B" "J04-08-B-restart-home"
logs "$B" "J04-08-B"

echo "############ J04-06 : fermeture depuis C -> B apprend fermé, LAN vidé ############"
ev "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');await MultiCamSessionWs.closeSession(s);return 'CLOSED';})()" >/dev/null
sleep 7
panels_ok "$B" "J04-06-closed"; panels_ok "$C" "J04-06-closed"
dump "$B" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:'',closedBy:s?s.closedByDeviceId:''})})()" "J04-06-B-closed.json"
dump "$C" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({state:s?s.state:''})})()" "J04-06-C-closed.json"
dump "$B" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "J04-06-B-lan-after-close.json"
# Preuve visuelle FERMÉE : panneau session (badge FERMÉE) puis Accueil (session
# récente FERMÉE) — les deux états doivent être visibles, jamais OUVERTE.
ev "$B" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J04-06-closed-session"
shot "$B" "J04-06-B-closed-screen"
ev "$B" "MultiCamNav.show('home'); 'NAV'" >/dev/null
sleep 2
panels_ok "$B" "J04-06-closed-home"
shot "$B" "J04-06-B-home-closed"
shot "$C" "J04-06-C-closed-screen"
logs "$B" "J04-06-B"

echo "############ J04-09 : purge DNS-SD de la session fermée (< fenêtre stale 150s) ############"
sleep 170
dump "$B" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "J04-09-B-lan-purged.json"
logs "$B" "J04-09-B"

echo "############ J04-07 : re-jonction d'une session fermée refusée (C) ############"
ev "$C" "MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'}); 'NAV'" >/dev/null
sleep 2
set_pin "$C" "$PIN"
sleep 6
dump "$C" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({storedCount:l.length,panelVisible:!!document.getElementById('panel-join').classList.contains('active'),pinStatus:document.getElementById('pinStatus').textContent})})()" "J04-07-C-closed-reject.json"
logs "$C" "J04-07-C"

echo "############ TERMINÉ ############"
ls -1 "$OUT/dumps"

echo "--- Vérif fin de run : panneaux exactement un par device (doit être 1|panel-…) ---"
panels_ok "$B" "fin"
panels_ok "$C" "fin"

echo "--- Hachage SHA-256 des captures + détection de doublons ---"
cd "$OUT/screenshots" || exit 1
shasum -a 256 *.png | tee "$OUT/png-shas.txt"
echo "--- doublons (le cas échéant) ---"
shasum -a 256 *.png | awk '{print $1}' | sort | uniq -d | sed 's/^/duplicate-sha: /'
cd "$ROOT"