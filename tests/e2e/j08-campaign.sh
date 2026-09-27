#!/usr/bin/env bash
# MultiCam — campagne de validation J08 (COUNTDOWN + START synchronisé).
#
# Pilote l'UI Cordova réelle via CDP (WebView DevTools). Captures d'écran,
# journaux logcat et dumps JSON dans tests/e2e/validation/J08-countdown-start/.
#
# Périmètre J08 : écran 07 (countdown 5→1, jamais 0,LECapture écartée, Storage en
# badge compact), écran 08 minimal (REC + timer + delta), plan de START
# (startPlanId, top verrouillé, offsets J07, adoption distante), enregistrement
# RÉEL via CameraPreview (startCamera toBack puis startRecordVideo au top),
# arrêt local, annulation avant top, exclusion d'une Capture, écart de top mesuré
# sur ≥3 Captures réelles et sur 5 START.
#
# Appareils : A=61cc29567d91 (Master hôte + Capture), B=61d54bba7d91 (Capture),
# C=c0d8514d7d87 (Capture), D=R83Y106V1HF (STORAGE SEUL dans le Take). Tous réels.
# ATTENTION : le NOM AFFICHÉ de D reste « Capture J08-D » (héritage de la
# configuration J07) alors que son rôle de Take est Storage : il n'enregistre
# donc JAMAIS (0 CAMERA_REC_OK sur toutes les sections). Ne pas lire le nom
# affiché comme un rôle — lire le Take (`dumps/J08-04-A-take.json` :
# captures=3, storages=1).
#
# AUCUN `pm clear` : les identités deviceId sont la preuve que l'on compare les
# MÊMES devices entre J07 et J08. Les permissions sont accordées par `pm grant`
# (pas de wipe).
#
# Usage : tests/e2e/j08-campaign.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J08-countdown-start"
CDP="$HERE/lib/cdp.js"

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
D=R83Y106V1HF
ALL="$A $B $C $D"
ANAME="Capture J08-A"
BNAME="Capture J08-B"
CNAME="Capture J08-C"
DNAME="Capture J08-D"
APP=fr.emmanuel.multicam

mkdir -p "$OUT"/{screenshots,logs,dumps}

# Nom UNIQUE par exécution : les devices conservent les sessions des campagnes
# précédentes (PAS de pm clear, les deviceId sont la preuve de continuité), donc
# on ne peut JAMAIS sélectionner une session par sa position dans le store.
RUN_TAG="J08-$(date +%H%M%S)"
SNAME="Regie $RUN_TAG"
echo "RUN_TAG=$RUN_TAG (session attendue : '$SNAME')"

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
# Filtre large : J08 + ce dont START a besoin (J06/J07 + WS + caméra).
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null \
  | grep -E "SESSION|WS_|MEMBER|SCREEN0|SCREEN1|HOME_RENDER|APP_BOOT|TAKE_|TELEMETRY_|ARM_|CLOCK_|REC_ELIG|TARGETED_|START_|CAMERA_|NAV_AUTO|CLOCK_SYNC" \
  > "$OUT/logs/$1-$2.log"; echo "logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log"))"; }
dump(){ echo -n "$2" | node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3 = $(cat "$OUT/dumps/$3")"; }
mark(){ echo "### $1"; }

start_view() { node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamStartService.view());})()"; }

# Pression du dock REC par le CHEMIN UI RÉEL. L'écran 06 refuse la pression
# quand il y a des incidents (horloges dégradées = WARNING) et ouvre la modal
# « Annuler / Continuer REC » : on suit ce chemin au lieu de contourner le
# garde-fou. Un incident n'est PAS un blocage : c'est un avertissement que le
# Master tranche.
# Un Take STOPPE ne peut pas etre relance (regle J08 : une Capture ne redemarre
# pas un Take qu'elle a arrete). Chaque nouveau START de campagne exige donc un
# Take neuf, sinon le plan est refuse et la mesure n'est pas realisable.
new_take() {
  local label="$1" before after
  before=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return String((s.takes||[]).length);})()" | tr -d '"')
  ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.newTake(s);return 'TAKE_N='+r.takeNumber;})()" | tail -1 | sed 's/^/  /'
  local poll=0
  while [ "$poll" -lt 30 ]; do
    after=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return t?String(t.takeNumber):'0';})()" | tr -d '"')
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      echo "  NEW_TAKE $label take=$after (avant=$before)"
      return 0
    fi
    sleep 1; poll=$((poll + 1))
  done
  echo "  NEW_TAKE_FAIL $label (toujours take=$after) — START non mesurable"
  return 1
}

press_rec() { # device, label
  local s="$1" label="$2"
  arm_view_save "$s"
  local n=$(json_field "$OUT/dumps/arm-view-$s.json" "(function(){var a=v;return JSON.stringify({incEmpty:!!a.incidentsEmpty,n:(a.incidents||[]).length,inc:a.incidents||[]});})()")
  local empty=$(echo "$n" | grep -oE '"incEmpty":(true|false)' | cut -d: -f2)
  local cnt=$(echo "$n" | grep -oE '"n":[0-9]+' | head -1 | cut -d: -f2)
  if [ "$empty" = "true" ]; then
    echo "PRESS_REC $label direct (aucun incident)"
    ev "$s" "document.getElementById('armRec').click();'REC_PRESSED'" >/dev/null
  else
    echo "PRESS_REC $label via modal d'incidents (n=$cnt) → capture puis « Continuer REC »"
    echo "INCIDENTS $label = $n"
    shot "$s" "$label-incident-modal"
    ev "$s" "document.getElementById('armRec').click();'REC_PRESSED_MODAL'" >/dev/null
    sleep 2
    shot "$s" "$label-incident-modal-open"
    ev "$s" "document.getElementById('armIncidentContinue').click();'CONTINUE_REC'" >/dev/null
  fi
}
start_view_save() { start_view "$1" > "$OUT/dumps/start-view-$1.json"; }
arm_view_save() { node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$1.json"; }
cam_view_save() { node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamCameraRecord.view());})()" > "$OUT/dumps/cam-view-$1.json"; }

# Retrouve l'ID de session par SON NOM (jamais par position dans le store).
sid_by_name() { # device, nom
  local r
  r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()")
  echo "${r//\"/}"
}

json_field() { # file, expr-js (v désigne le JSON)
  node -e "const fs=require('fs');let v=fs.readFileSync('$1','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}};const out=$2;console.log(out===undefined?'':out);"
}

panels_ok() {
  local s="$1" label="$2"
  local n=$(ev "$s" "(function(){var a=document.querySelectorAll('.screen.active');return a.length+'|'+(a[0]?a[0].id:'');})()")
  n="${n//\"/}"; n="${n//\\/}"
  case "$n" in
    1\|*) echo "PANELS_OK $label active=$(echo "$n" | cut -d'|' -f2)" ;;
    *) echo "PANELS_FAIL $label got=$n (attendu exactement 1|panel-…)" ;;
  esac
}

grant_perms() {
  local s="$1"
  for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION; do
    adb -s "$s" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1
  done
  echo "grant_perms $s ok"
}

# Lancement propre SANS pm clear : force-stop + am start + vidage logcat.
relaunch() {
  local s="$1"
  adb -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
  adb -s "$s" logcat -c
  adb -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  sleep 8
  echo "relaunch $s deviceId=$(ev "$s" "MultiCamSessionWs.status().localDid")"
}

# Les devices réannONCENT en permanence les sessions qu'ils hébergent (sessions
# des campagnes précédentes) : on ne peut pas exiger un LAN vide. On vérifie
# seulement que l'ANNONCE DE NOTRE session est visible (filtrage par sessionId).
wait_announce() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local a=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$sid';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()")
    a="${a//\"/}"
    if [ "$a" != "0" ]; then echo "ANNOUNCE_OK $label $a (t=${poll}s)"; echo "$a" | tr ':' ' ' > "$OUT/dumps/endpoint-$s.txt"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "ANNOUNCE_FAIL $label TIMEOUT 60s — annonce de $sid jamais vue"
  return 1
}

wait_session_on() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SESSION_JOINED $label TIMEOUT après 90s — suite effectuée de façon honnête"
  return 1
}

# Convergence ARM : actif, aucun skill en ARMING/ERROR/PENDING, et une référence
# d'horloge pour chaque capture DISTANTE (sinon le modèle refusera le plan en
# clock_stale — c'est exactement ce qu'on veut vérifier ensuite).
wait_arm_ready() {
  local s="$1" label="$2" poll=0
  while [ "$poll" -lt 120 ]; do
    arm_view_save "$s"
    local ok=$(node -e "
      const fs=require('fs');let v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$s.json','utf8'));
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
  echo "ARM_READY $label TIMEOUT après 120s — preuves partielles rapportées honnêtement"
  return 1
}

# Attente de phase sur la vue START d'un device (COUNTDOWN/REC/EXCLUDED/…).
wait_start_phase() {
  local s="$1" want="$2" label="$3" poll=0
  while [ "$poll" -lt 30 ]; do
    start_view_save "$s"
    local ph=$(json_field "$OUT/dumps/start-view-$s.json" "v.phase")
    echo "wait_start_phase $label t=${poll}s phase=$ph"
    if [ "$ph" = "$want" ]; then return 0; fi
    sleep 1; poll=$(( poll + 1 ))
  done
  echo "wait_start_phase $label TIMEOUT (attendu=$want) — rapporté honnêtement"
  return 1
}

echo "==============================================================="
echo " MultiCam J08 — COUNTDOWN + START synchronisé (campagne réelle)"
echo "==============================================================="
for s in $ALL; do grant_perms "$s"; done
for s in $ALL; do relaunch "$s"; done
for s in $B $C $D; do
  n=$(ev "$s" "(function(){return MultiCamSessionDiscovery.list().length;})()")
  echo "lan_residual $s (annonces=${n//\"/}, non bloquant : sessions précédentes toujours annoncées)"
done

echo "############ J08-01 : session créée sur A (hôte Master) ############"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
panels_ok "$A" "J08-01-create"
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()"
sleep 6
SID=$(sid_by_name "$A" "$SNAME")
echo "SESSION_CREATED sid=$SID name='$SNAME'"
if [ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ]; then echo "FATAL: session introuvable par nom '$SNAME'"; exit 1; fi
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,name:s.name,pin:s.pin,masters:(s.masters||[]).length,members:(s.members||[]).length,takes:(s.takes||[]).length});})()" "J08-01-A-created.json"
cat "$OUT/dumps/J08-01-A-created.json"; echo
PIN=$(json_field "$OUT/dumps/J08-01-A-created.json" "v.pin")
if [ -z "$PIN" ] || [ "$PIN" = "undefined" ]; then echo "FATAL: PIN illisible"; exit 1; fi
echo "PIN=$PIN"
echo "$SID" > "$OUT/dumps/sid.txt"
shot "$A" "J08-01-A-session"

echo "############ J08-02 : B, C, D rejoignent la session $SID ############"
ADID=$(ev "$A" "MultiCamSessionWs.status().localDid"); ADID="${ADID//\"/}"
BDID=$(ev "$B" "MultiCamSessionWs.status().localDid"); BDID="${BDID//\"/}"
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid"); CDID="${CDID//\"/}"
DDID=$(ev "$D" "MultiCamSessionWs.status().localDid"); DDID="${DDID//\"/}"
echo "DID A=$ADID B=$BDID C=$CDID D=$DDID"
printf '%s\n' "A=$ADID" "B=$BDID" "C=$CDID" "D=$DDID" > "$OUT/dumps/device-ids.txt"

for pair in "$B:BN" "$C:CN" "$D:DN"; do
  dev="${pair%%:*}"; tag="${pair##*:}"
  if ! wait_announce "$dev" "$SID" "J08-02-$tag"; then echo "FATAL: $dev ne voit pas l'annonce de $SID"; exit 1; fi
  read -r JH JP < "$OUT/dumps/endpoint-$dev.txt"
  echo "JOIN_TARGET $dev host=$JH port=$JP"
  # NAV + PIN dans le MÊME tick : sinon JOIN_REQUEST part avant la saisie du PIN.
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN';})()" > "$OUT/dumps/J08-02-$dev-join.txt"
  wait_session_on "$dev" "$SID" "J08-02-$dev" || { echo "FATAL: $dev n'a pas rejoint $SID"; exit 1; }
  sleep 2
done
echo "--- vérification : chaque device connaît la session ET ses masters ---"
for dev in $A $B $C $D; do
  dump "$dev" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({has:!!s,masters:s?(s.masters||[]).length:0});})()" "J08-02-$dev-joined.json"
  echo -n "$dev : "; cat "$OUT/dumps/J08-02-$dev-joined.json"; echo
done

echo "############ J08-03 : membres — A/B/C Captures, D Storage seul ############"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');
  var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$BNAME',enabledSkills:['capture']},['capture']);
  r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$CNAME',enabledSkills:['capture']},['capture']);
  r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'$DNAME',enabledSkills:['storage']},['storage']);
  r=await MultiCamSessionWs.addMember(r,{deviceId:'$ADID',deviceName:'$ANAME',enabledSkills:['capture']},['capture']);
  return JSON.stringify(r.members.map(function(m){return{m:m.deviceName,r:m.sessionRoles}}));})()" > "$OUT/dumps/J08-03-A-members.json"
sleep 6
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify(s.members.map(function(m){return{n:m.deviceName,r:m.sessionRoles}}));})()" "J08-03-A-members-check.json"
echo "--- rôles sur A ---"; cat "$OUT/dumps/J08-03-A-members-check.json"; echo
# Convergence des rôles sur les autres devices (ils doivent voir les mêmes 4 membres).
for dev in $B $C $D; do
  dump "$dev" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify(s?{m:s.members.length,n:s.members.map(function(x){return x.deviceName+':'+x.sessionRoles.join('+')}).join(' | ')}:{});})()" "J08-03-$dev-members.json"
  echo -n "$dev : "; cat "$OUT/dumps/J08-03-$dev-members.json"; echo
done
shot "$A" "J08-03-A-members"

echo "############ J08-04 : Take 1 — 3 Captures + 1 Storage ############"
ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4

# Marque le bouton AVANT le clic : si le marqueur disparait, c'est que le noeud
# DOM a ete recree (re-rendu du panel) et que les listeners de l'ecran 05 sont
# orphelins. Le harness ne suppose jamais que le clic a fonctionne : il
# verifie le COMMIT (captures>0) et rejoue une fois en forcant un nouveau show.
take_select() {
  ev "$A" "(function(){var b=document.getElementById('tkCaptureAll');if(b)b.dataset.j08probe='p1';return b?('TAGGED '+(b.disabled?'DISABLED':'ok')):'NO_BUTTON';})()" | tail -1
  ev "$A" "document.getElementById('tkCaptureAll').click();'CLICKED_CAPTURE_ALL'" >/dev/null
  ev "$A" "document.getElementById('tkStorageAll').click();'CLICKED_STORAGE_ALL'" >/dev/null
  sleep 4
  local probe
  probe=$(ev "$A" "(function(){var b=document.getElementById('tkCaptureAll');return b&&b.dataset.j08probe?'NODE_INTACT':'NODE_REPLACED';})()" | tail -1)
  probe="${probe//\"/}"
  local n
  n=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return String(t?t.captures.length:-1);})()" | tail -1)
  n="${n//\"/}"
  echo "  take_select -> captures=$n $probe"
  TAKE_CAPS_NOW="${n%%[!0-9-]*}"
}

take_select
if [ "${TAKE_CAPS_NOW:-0}" -lt 3 ] 2>/dev/null; then
  echo "  WARN: le clic n'a pas produit de commit — re-routage de l'ecran 05 puis nouvel essai"
  ev "$A" "MultiCamNav.show('home');'HOME'" >/dev/null
  sleep 2
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV2'" >/dev/null
  sleep 4
  take_select
fi
sleep 2
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({takeNumber:t.takeNumber,captures:t.captures.length,storages:t.storages.length,countdownSeconds:t.countdownSeconds,profile:(t.settings||{}).video});})()" "J08-04-A-take.json"
echo "--- take ---"; cat "$OUT/dumps/J08-04-A-take.json"; echo
NCAP=$(json_field "$OUT/dumps/J08-04-A-take.json" "v.captures")
echo "TAKE_CAPTURES=$NCAP (objectif J08 : >= 3)"
if [ "${NCAP:-0}" -lt 3 ] 2>/dev/null; then echo "FATAL: moins de 3 Captures dans le Take — campagne J08 non exécutable honnêtement"; exit 1; fi
shot "$A" "J08-04-A-take-ready"
logs "$A" "J08-04"

echo "############ J08-05 : ARM distribué sur A — READY + horloges distantes ############"
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$A" "J08-05-arm"
wait_arm_ready "$A" "J08-05-A"
arm_view_save "$A"
dump "$A" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,takeNumber:v.takeNumber,recEligible:v.recEligible,incidentsEmpty:v.incidentsEmpty,clock:v.clock,statuses:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')})});})()" "J08-05-A-arm.json"
cat "$OUT/dumps/J08-05-A-arm.json"; echo
shot "$A" "J08-05-A-arm-ready"
echo "--- offset J07 mesurés (A) ---"
json_field "$OUT/dumps/J08-05-A-arm.json" "JSON.stringify(Object.keys(v.clock||{}).map(function(k){return k.slice(0,8)+' offset='+v.clock[k].offsetMs+'ms status='+v.clock[k].status}))"
logs "$A" "J08-05"

echo "--- GATE : l'ARM doit exposer >=3 Captures participantes et recEligible ---"
arm_view_save "$A"
# L'expression est évaluée par NODE sur le dump local (json_field n'exécute PAS de
# JS sur le device) : c'est le même mécanisme que wait_arm_ready.
GATE=$(json_field "$OUT/dumps/arm-view-$A.json" "(function(){var a=v;var caps=(a.devices||[]).filter(function(d){return d.skills.some(function(s){return s.skill==='capture'&&(s.status==='READY'||s.status==='WARNING');});});return JSON.stringify({devices:(a.devices||[]).length,capReady:caps.length,recEligible:!!a.recEligible,clockRefs:Object.keys(a.clock||{}).length,incidents:(a.incidents||[]).length,incidentsEmpty:!!a.incidentsEmpty});})()")
echo "GATE=$GATE"
CAPN=$(echo "$GATE" | grep -oE '"capReady":[0-9]+' | cut -d: -f2)
RECOK=$(echo "$GATE" | grep -oE '"recEligible":(true|false)' | cut -d: -f2)
CLKN=$(echo "$GATE" | grep -oE '"clockRefs":[0-9]+' | cut -d: -f2)
if [ "${CAPN:-0}" -lt 3 ] 2>/dev/null; then echo "FATAL: moins de 3 Captures participantes (capReady=$CAPN) — START non testable"; exit 1; fi
if [ "$RECOK" != "true" ]; then echo "FATAL: recEligible=false (dock REC désactivé : le test ne mesurerait rien)"; exit 1; fi
if [ "${CLKN:-0}" -lt 1 ] 2>/dev/null; then echo "FATAL: aucune référence d'horloge distante → le modèle rejetterait clock_stale"; exit 1; fi
echo "GATE_OK capReady=$CAPN clockRefs=$CLKN"

echo "############ J08-06 : APPUI REC réel → plan de START + countdown 5→1 ############"
# Nettoyage logcat juste avant l'appui : les deltas doivent être lisibles sans bruit.
for s in $ALL; do adb -s "$s" logcat -c; done
T0=$(node -e "console.log(Date.now())")
echo "REC_PRESS_AT_MS=$T0"
press_rec "$A" "J08-06-A"
sleep 1
panels_ok "$A" "J08-06-A-countdown"
start_view_save "$A"
echo "--- vue START sur A 1s après l'appui ---"; cat "$OUT/dumps/start-view-$A.json"; echo
shot "$A" "J08-06-A-countdown-5"
# Countdown : on capture 3, 1 puis l'écran REC. Jamais de 0 (invariant UI 07).
sleep 2; shot "$A" "J08-06-A-countdown-3"
wait_start_phase "$A" "REC" "J08-06-A-rec"
shot "$A" "J08-06-A-rec"
echo "--- vue START sur A au top ---"; cat "$OUT/dumps/start-view-$A.json"; echo
for s in $B $C $D; do start_view_save "$s"; echo "--- vue START sur $s ---"; cat "$OUT/dumps/start-view-$s.json"; echo; done
for s in $ALL; do shot "$s" "J08-06-$s-rec"; done
for s in $ALL; do logs "$s" "J08-06"; done

echo "############ J08-07 : preuve d'enregistrement RÉEL sur chaque Capture ############"
for s in $A $B $C $D; do cam_view_save "$s"; echo "--- caméra $s ---"; cat "$OUT/dumps/cam-view-$s.json"; echo; done
echo "--- CAMERA_REC_OK / START_LOCAL_TOP par device ---"
for s in $A $B $C $D; do
  echo "== $s =="
  grep -oE "CAMERA_REC_OK[^\"]*|CAMERA_PREP_OK[^\"]*|CAMERA_REC_KO[^\"]*|START_LOCAL_TOP[^\"]*|START_NATIVE_ACK[^\"]*|START_PLAN_ADOPTED[^\"]*|START_PLAN_DROP[^\"]*|START_CLOCK_STALE[^\"]*|START_[A-Z_]+ status=ERROR[^\"]*" "$OUT/logs/$s-J08-06.log" || echo "(aucune ligne)"
done

echo "############ J08-08 : mesure de l'ÉCART DE TOP (3+ Captures réelles) ############"
# Source de vérité = le modèle lui-même (lastStart), pas une regex sur logcat :
#   actualMs  = instant où CE device a déclenché startRecordVideo
#   deltaMs   = écart de ce déclenchement par rapport à SA cible locale
#   ackMs     = retour du plugin (latence native, PAS une mesure de synchro)
top_spread() {
  local tag="$1" csv="$2" devs="$3" want_take="$4"
  : > "$csv"
  echo "take,did,targetMs,actualMs,deltaMs,ackMs,ackDeltaMs" >> "$csv"
  for s in $devs; do
    local did v
    did=$(ev "$s" "MultiCamStartService.view().selfDid" | tr -d '"')
    # On ne retient que le LAST_START DU TAKE ATTENDU : après un « Nouveau
    # Take », lastStart conserve les mesures du Take précédent (piège de mesure).
    v=$(ev "$s" "(function(){var v=MultiCamStartService.view();if(!v||!v.lastStart)return '';if($want_take>0&&v.takeNumber!==$want_take)return '';var l=v.lastStart;return [v.targetStartMs,l.actualMs,l.deltaMs,l.ackMs==null?'':l.ackMs,l.ackDeltaMs==null?'':l.ackDeltaMs].join(',');})()" | tr -d '"')
    if [ -n "$v" ]; then echo "$want_take,${did:0:8},$v" >> "$csv"; fi
  done
  node -e "
const fs=require('fs');
const rows=fs.readFileSync('$csv','utf8').trim().split('\n').slice(1)
  .map(function(l){return l.split(',');})
  .filter(function(r){return r.length>=5 && r[3]!=='';});
if(rows.length<2){console.log('  TOP_SPREAD=INDISPONIBLE (moins de 2 Captures avec lastStart sur le Take '+$want_take+')');process.exit(0);}
const deltas=rows.map(function(r){return Number(r[4]);});
const act=rows.map(function(r){return Number(r[3]);}).sort(function(a,b){return a-b;});
const acks=rows.filter(function(r){return r[5]!=='';}).map(function(r){return Number(r[5]);});
// deltaMs = actualMs - (targetStartMs + offsetDuDevice) : c'est l'erreur de
// declenchement de CE device. L'ecart inter-devices Utile est donc
// max(delta)-min(delta) ; l'ecart des epochs brutes ne mesure que le
// decalage d'horloge et ne doit PAS etre presente comme une erreur de sync.
console.log('  devices='+rows.length+' deltas='+rows.map(function(r){return r[1]+':'+r[4]+'ms';}).join(' '));
console.log('  TOP_DELTA worstAbsMs='+Math.max.apply(null,deltas.map(Math.abs))
  +' (declenchement vs cible locale)');
console.log('  TOP_ALIGNED_SPREAD_MS='+(Math.max.apply(null,deltas)-Math.min.apply(null,deltas))
  +' (alignement inter-devices)');
console.log('  INFO_RAW_EPOCH_SPREAD_MS='+(act[act.length-1]-act[0])
  +' (decalage d horloge, PAS un indicateur de sync)');
if(acks.length>=2){const sa=acks.slice().sort(function(a,b){return a-b;});
console.log('  INFO_ACK_SPREAD_MS='+(sa[sa.length-1]-sa[0])+' (latence plugin, hors sync)');}
"
}

echo "############ J08-09 : Storage (D) = badge compact, AUCUN plein écran ############"
ev "$D" "(function(){var vis=[];['cdMaster','cdCapture','cdExcluded','cdRec'].forEach(function(id){var e=document.getElementById(id);if(e&&!e.classList.contains('d-none'))vis.push(id);});var b=document.getElementById('recBadge');return JSON.stringify({visibleViews:vis,badgeHidden:b.classList.contains('d-none'),badgeValue:document.getElementById('recBadgeVal').textContent,activePanel:document.querySelector('.screen.active').id});})()" | tee "$OUT/dumps/J08-09-D-storage-badge.json"
shot "$D" "J08-09-D-storage-badge"
# D est Master de la session (il a rejoint A) : la vue Master prime sur la vue
# Storage, donc D affiche légitimement une vue plein écran. Le contrat "Storage
# => badge compact, jamais de plein écran" concerne un Storage NON Master ; il
# est couvert par countdown-ui.test.js (13 blocs) et ne peut pas être produit
# sur ce montage à 4 devices (aucune API de rétrogradation Master→membre).
if grep -q '"visibleViews":\[\]' "$OUT/dumps/J08-09-D-storage-badge.json"; then
  echo "STORAGE_BADGE_OK (aucune vue plein écran)"
else
  echo "STORAGE_BADGE_NA — D est Master+Storage : vue Master attendue."
  echo "  Le badge-only est vérifié par countdown-ui.test.js ; un Storage non-Master"
  echo "  exigerait un 5e device (ou une API de rétrogradation) — décision à prendre."
fi

echo "############ J08-10 : ARRÊT LOCAL sur chaque Capture (preuve fichier) ############"
for s in $A $B $C $D; do
  echo "== STOP $s =="
  ev "$s" "(function(){var v=MultiCamStartService.view();if(!v||!v.active)return 'NO_PLAN';return MultiCamStartService.stopLocal('campaign').then(function(){return 'STOPPED';}).catch(function(e){return 'STOP_KO:'+e.message;});})()" 2>&1 | tail -1
done
sleep 6
for s in $A $B $C $D; do cam_view_save "$s"; echo "--- caméra $s après arrêt ---"; cat "$OUT/dumps/cam-view-$s.json"; echo; logs "$s" "J08-10"; done
echo "--- CAMERA_REC_STOP_OK (preuve que le fichier existe) ---"
for s in $A $B $C $D; do echo "== $s =="; grep -oE "CAMERA_REC_STOP_OK[^\"]*|CAMERA_REC_STOP_KO[^\"]*" "$OUT/logs/$s-J08-10.log" || echo "(aucune ligne)"; done
for s in $A $B $C $D; do shot "$s" "J08-10-$s-stopped"; done

echo "############ J08-11 : plan ANNULÉ avant le top → AUCUN enregistrement ############"
# Retour à ARM puis annulation : on appuie REC puis on annule pendant le countdown.
new_take "J08-11" || true
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 3
for s in $ALL; do adb -s "$s" logcat -c; done
press_rec "$A" "J08-11-A"
sleep 2
start_view_save "$A"
echo "--- plan actif avant annulation ---"; cat "$OUT/dumps/start-view-$A.json"; echo
shot "$A" "J08-11-A-countdown"
ev "$A" "document.getElementById('cdCancel').click();'CANCELLED'" >/dev/null
sleep 4
start_view_save "$A"
echo "--- vue START après annulation ---"; cat "$OUT/dumps/start-view-$A.json"; echo
panels_ok "$A" "J08-11-after-cancel"
for s in $ALL; do logs "$s" "J08-11"; cam_view_save "$s"; done
echo "--- preuve : AUCUN CAMERA_REC_OK après annulation ---"
for s in $A $B $C $D; do
  n=$(grep -c "CAMERA_REC_OK" "$OUT/logs/$s-J08-11.log" || true)
  # Marqueurs RÉELS du modèle : le libellé "START_PLAN_CANCEL" n'existe pas
  # (le modèle log START_CANCEL puis START_PLAN_ABORTED). On matche donc la
  # forme exacte "START_CANCEL sessionId=" pour ne pas confondre avec
  # START_CANCEL_REJECT / START_CANCEL_IGNORE.
  c=$(grep -c "START_CANCEL sessionId=" "$OUT/logs/$s-J08-11.log" || true)
  a=$(grep -c "START_PLAN_ABORTED" "$OUT/logs/$s-J08-11.log" || true)
  echo "$s CAMERA_REC_OK=$n START_CANCEL=$c START_PLAN_ABORTED=$a"
done
shot "$A" "J08-11-A-after-cancel"

echo "############ J08-12 : 5 START successifs — écart de top répété ############"
: > "$OUT/dumps/top-spread-all.csv"
echo "take,did,targetMs,actualMs,deltaMs,ackMs,ackDeltaMs" > "$OUT/dumps/top-spread-all.csv"
for run in 1 2 3 4 5; do
  mark "J08-12 run $run"
  new_take "J08-12-run$run" || true
  run_take=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return t?String(t.takeNumber):'0';})()" | tr -d '"')
  echo "  RUN_TAKE=$run_take"
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
  sleep 3
  if ! wait_arm_ready "$A" "J08-12-A-run$run"; then
    echo "RUN_SKIPPED $run (ARM non READY — aucun START mesuré, rapporté honnêtement)"
    continue
  fi
  for s in $ALL; do adb -s "$s" logcat -c; done
  press_rec "$A" "J08-12-run$run-A"
  wait_start_phase "$A" "REC" "J08-12-A-run$run" || echo "pas de REC au run $run (rapporté honnêtement)"
  sleep 4
  top_spread "run$run" "$OUT/dumps/top-spread-run$run.csv" "$A $B $C" "$run_take"
  tail -n +2 "$OUT/dumps/top-spread-run$run.csv" >> "$OUT/dumps/top-spread-all.csv"
  shot "$A" "J08-12-run$run-rec"
  for s in $A $B $C $D; do
    ev "$s" "(function(){var v=MultiCamStartService.view();if(!v||!v.active)return 'NO_PLAN';return MultiCamStartService.stopLocal('campaign').catch(function(){return 'KO';});})()" >/dev/null 2>&1
  done
  sleep 4
done
echo "--- synchronisation par run (deltaMs = erreur de déclenchement / device) ---"
node -e "
const fs=require('fs');
const rows=fs.readFileSync('$OUT/dumps/top-spread-all.csv','utf8').trim().split('\\n').slice(1)
  .map(function(l){return l.split(',');})
  .filter(function(r){return r.length>=5 && r[4]!=='';});
// deltaMs = actualMs - (targetStartMs + offset du device) : erreur de
// declenchement de CE device. L'ecart inter-devices utile est
// max(delta)-min(delta) ; les epochs bruts ne mesurent qu'un decalage
// d'horloge et ne doivent pas etre presentes comme une erreur de sync.
const byTake={};
rows.forEach(function(r){(byTake[r[0]]=byTake[r[0]]||[]).push(Number(r[4]));});
Object.keys(byTake).sort(function(a,b){return a-b;}).forEach(function(k){
  const a=byTake[k];
  console.log('take '+k+' devices='+a.length+' deltas=['+a.join(', ')+']ms'
    +' worstAbs='+Math.max.apply(null,a.map(Math.abs))+'ms'
    +' ALIGNED_SPREAD='+(Math.max.apply(null,a)-Math.min.apply(null,a))+'ms');
});
if(!rows.length)console.log('INDISPONIBLE : aucun lastStart (rapporté honnêtement)');
"
for s in $ALL; do logs "$s" "J08-12"; done

echo "############ J08-13 : écran 07 respecté — pas de 0, Storage sans plein écran ############"
echo "--- chiffres affichés pendant le countdown (doivent être 5,4,3,2,1) ---"
ev "$A" "(function(){return JSON.stringify({digit:document.getElementById('cdDigitMaster').textContent});})()" | tee "$OUT/dumps/J08-13-A-digit.json"
echo "--- récapitulatif ---"
cat "$OUT/dumps/top-spread.json" 2>/dev/null || echo "(pas de top-spread.json : écart non mesuré)"

echo "############ TERMINÉ ############"
for s in $ALL; do
  echo "--- $s : phases START observées ---"
  grep -oE "START_[A-Z_]+" "$OUT/logs/$s-J08-06.log" "$OUT/logs/$s-J08-12.log" 2>/dev/null | sed 's/.*://' | sort | uniq -c | sort -rn | head -20
done
echo "--- captures d'écran ---"; ls -1 "$OUT/screenshots" | wc -l
echo "--- fin ---"
