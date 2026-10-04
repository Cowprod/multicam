#!/usr/bin/env bash
# Preuve J09-07 — bascule de caméra CIBLEE et SEGMENTEE pendant un REC.
#
# Ce que ce script cherche à prouver, et rien d'autre :
#
#   1. une bascule demandée par le Master pendant le REC NE FAIT PAS tomber le
#      REC : le Take reste un seul REC, pas deux ;
#   2. le fichier est segmenté : le segment N est fermé AVANT l'ouverture du
#      segment N+1 (aucun chevauchement) ;
#   3. la bascule est CONFIRMÉE par un fait natif lu APRES le `startRecordVideo`
#      du nouveau segment — jamais déduite de l'intention ;
#   4. un facing hors modèle est refusé SANS fermeer de segment (fail-closed) ;
#   5. le Master voit converger l'état de la Capture (`camera_state`), sans
#      jamais l'annoncer lui-même.
#
# Oracles : logs logcat parsables (CAMERA_SWITCH_*, CAMERA_SEG_*, CAMERA_REC_*),
# état JS réel via CDP, et pixels (png_stats.py) pour prouver que la preview
# n'a pas disparu pendant la bascule.
#
# Appareils : A = Master + Capture, B = Capture. Les deux réels, APK identique.
# Usage : tests/e2e/validation/J09-rec-previews/run-camera-switch.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="$HERE"
CDP="$ROOT/tests/e2e/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91          # Master + Capture (« Cam 05 »)
B=61d54bba7d91          # Capture seule (« Cam 07 »)
BDID=""                 # deviceId de B, résolu au démarrage

mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps"

ev()   { node "$CDP" "$1" eval "$2"; }
# `screencap` n'a pas d'extension : c'est a nous de la poser, une seule fois.
shot() {
  case "$2" in
    *.png) NAME="$2" ;;
    *)     NAME="$2.png" ;;
  esac
  adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$NAME"
  echo "  shot $NAME"
}
mark() { echo; echo "### $*"; }
dump() { ev "$1" "$2" > "$OUT/dumps/$3"; echo "  dump $3 = $(cat "$OUT/dumps/$3")"; }

# Les natifs J09-07 + tout ce dont la bascule a besoin pour être interprétable.
logs() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_SWITCH_|CAMERA_SEG_|CAMERA_REC_|CAMERA_PREP_|CAMERA_PREVIEW_|SESSION|WS_|START_|TAKE_|MEMBER|CLOCK_|ARM_" \
    > "$OUT/logs/$1-$2.log"
  echo "  logs $1-$2 ($(wc -l < "$OUT/logs/$1-$2.log") lignes)"
}

pixel() {
  # L'appelant peut passer `03-capture-rec-before` ou `...png` : on ne doit pas
  # exiger de le deviner, sinon la preuve sort VIDE sans le moindre avertissement.
  F="$OUT/screenshots/$1"
  [ -f "$F" ] || F="$F.png"
  if [ ! -f "$F" ]; then
    echo "  (pas de capture : $1)"
    return
  fi
  echo "  $(basename "$F") : $(python3 "$HERE/png_stats.py" "$F" 2>/dev/null | tr '\n' ' ')"
}

echo "== 0. preparation =="
for s in $A $B; do
  PID=$(adb -s "$s" shell pidof $APP | tr -d '\r' | awk '{print $1}')
  [ -n "$PID" ] || { echo "FATAL: $s ne tourne pas"; exit 1; }
  echo "  $s pid=$PID"
done
BDID=$(ev "$B" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
ADID=$(ev "$A" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
# La sortie CDP echappe les guillemets : on retire les extremes ET les
# antislashs, sinon le litteral injecte dans le JS est invalide.
BSKILLS=$(ev "$B" "JSON.stringify((MultiCamConfig.get()||{}).enabledSkills||[])" | sed 's/^"//; s/"$//; s/\\//g')
echo "  A(deviceId)=$ADID  B(deviceId)=$BDID skills=$BSKILLS"
[ -n "$BDID" ] || { echo "FATAL: deviceId de B introuvable"; exit 1; }

RUN_TAG="J0907-$(date +%H%M%S)"
SNAME="Regie $RUN_TAG"

mark "1. creation de la session sur A (Master)"
ev "$A" "MultiCamNav.show('create');'NAV'" >/dev/null
sleep 2
ev "$A" "(function(){
  var n=document.getElementById('sessionName');
  /* On declenche 'input' : poser .value seul ne suffit pas toujours a faire
   * descendre la valeur dans l'etat du formulaire, et la session creee
   * porterait alors le nom par defaut. */
  if(n){ n.value='$SNAME'; n.dispatchEvent(new Event('input',{bubbles:true})); }
  document.getElementById('createButton').click();
  return 'CREATED';
})()" >/dev/null
sleep 3
# On identifie la session par le nom SI possible, sinon par recence : le nom
# reste un agrement, la preuve ne doit pas en dependre.
SID=$(ev "$A" "(async function(){
  var l=await MultiCamSessionStore.list(), named=null, newest=null;
  for(var i=0;i<l.length;i++){
    if(l[i].name==='$SNAME') named=l[i];
    if(!newest || (l[i].addedAtMs||0) > (newest.addedAtMs||0)) newest=l[i];
  }
  var s=named||newest;
  return s ? (s.sessionId+'|'+(named?'par_nom':'par_recence')+'|'+s.name) : 'NOT_FOUND';
})()" | tr -d '"')
SID_ID="${SID%%|*}"
SID_NAME_HINT="${SID#*|}"
SID_NAME_HINT="${SID_NAME_HINT#*|}"
echo "  SESSION sid=$SID_ID ($SID_NAME_HINT)"
[ "$SID_ID" = "NOT_FOUND" ] || [ -z "$SID_ID" ] && { echo "FATAL: session introuvable"; exit 1; }

PIN=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID_ID');return String(s.pin||'');})()" | tr -d '"')
echo "  pin=$PIN"

mark "2. B rejoint la session (Capture) par le CHEMIN UI REEL"
# On passe par ecran 01 -> ecran 02 et on tape le PIN dans les vraies cases.
# L'appel direct a joinSession() suffisait a faire annoncer B, mais laissait la
# session SANS membre : c'est le flux UI (waitOutcome + ajout de membre par le
# Master) qui fait le travail. Un script qui court-circuite l'UI mesurerait donc
# autre chose que l'application.
adb -s "$B" logcat -c
EP=$(ev "$B" "(async function(){
  var deadline=Date.now()+25000, inst=null;
  while(Date.now()<deadline && !inst){
    var l=(MultiCamSessionDiscovery.list()||[]);
    for(var i=0;i<l.length;i++){
      if(l[i] && l[i].sessionId==='$SID_ID'){
        var ann=l[i].announcers||[];
        /* L'endpoint annonce par le MASTER de la session, pas celui de B. */
        for(var j=0;j<ann.length;j++){
          if(ann[j].deviceId && ann[j].deviceId!==MultiCamCameraSwitchService.view().deviceId){ inst=ann[j]; break; }
        }
        if(!inst && ann.length) inst=ann[ann.length-1];
        if(inst) break;
      }
    }
    if(!inst) await new Promise(function(r){setTimeout(r,700);});
  }
  return inst ? inst.host+':'+inst.port : 'NOT_DISCOVERED';
})()" | tr -d '"')
echo "  endpoint annonce = $EP"
case "$EP" in
  *:*) ;;
  *) echo "FATAL: endpoint introuvable ($EP)"; exit 1 ;;
esac
JH="${EP%%:*}"; JP="${EP##*:}"

ev "$B" "(function(){
  MultiCamNav.show('join',{mode:'join',sid:'$SID_ID',name:'$SID_NAME_HINT',host:'$JH',port:'$JP'});
  return 'NAV_JOIN';
})()" >/dev/null
sleep 3
# Le 4e chiffre declenche submitJoin() tout seul : on saisit donc les 4 cases
# avec de vrais evenements 'input', dans l'ordre.
for i in 0 1 2 3; do
  ev "$B" "(function(){
    var b=document.getElementById('pin$i'); if(!b) return 'NO_BOX';
    b.focus(); b.value='$PIN'.charAt($i);
    b.dispatchEvent(new Event('input',{bubbles:true}));
    return 'TYPED';
  })()" >/dev/null
  sleep 1
done
sleep 9
JOINLOG=$(adb -s "$B" logcat -d -v brief 2>/dev/null | grep -oE "SCREEN02_JOIN_(OK|NACK)[^ ]*.*" | tail -1)
echo "  join (logcat) = ${JOINLOG:-AUCUNE_LIGNE}"
dump "$B" "(function(){return JSON.stringify({panel:(document.querySelector('.screen.active')||{}).id,pinStatus:(document.getElementById('pinStatus')||{}).textContent});})()" "02-B-join-ui.json"
# A ce stade B n'est qu'ANNONCEUR : l'appartenance vient a l'etape suivante.
echo "  B a rejoint (annonceur) — l'appartenance est posee a l'etape 3"

mark "3. le Master ADMET B comme membre Capture"
# Rejoindre ne suffit pas : l announcing n'est pas une appartenance. C'est le
# Master qui, sur l'ecran 03, ajoute le membre AVEC ses skills annonces et son
# endpoint de session. Sans cela le Take ne peut pas etre prepare et le REC ne
# demarre pas — la bascule serait alors inverifiable pour une raison etrangere.
dump "$A" "(async function(){
  var s=await MultiCamSessionStore.get('$SID_ID');
  var ann=(s.masters||[]).filter(function(m){return m.deviceId==='$BDID';})[0];
  if(!ann) return 'NO_ANNOUNCER';
  var skills=$BSKILLS;
  try {
    await MultiCamSessionWs.addMember(s,{
      deviceId:'$BDID',
      deviceName:ann.deviceName||'Cam',
      enabledSkills:skills,
      endpoint:ann.endpoint||''
    },['capture']);
  } catch(e){ return 'ADD_KO:'+(e&&e.message); }
  var t=await MultiCamSessionStore.get('$SID_ID');
  var m=(t.members||[]).filter(function(x){return x.deviceId==='$BDID';})[0];
  return JSON.stringify({did:'$BDID',member:!!m,roles:m&&m.sessionRoles});
})()" "03-B-role.json"
MEM=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID_ID');return String((s.members||[]).length);})()" | tr -d '"')
echo "  membres sur A = $MEM"
[ "$MEM" != "0" ] && [ -n "$MEM" ] || { echo "FATAL: B n'est pas membre de la session"; exit 1; }

mark "3b. roles confirms"
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID_ID');return JSON.stringify({sid:s.sessionId,masters:(s.masters||[]).map(function(m){return m.deviceId}),members:(s.members||[]).map(function(m){return m.deviceId})});})()" "03-A-members.json"
shot "$A" "01-master-home.png"

mark "4. selection de la Capture B dans le Take + ARM + REC"
ev "$A" "MultiCamNav.show('take',{sid:'$SID_ID'});'NAV_TAKE'" >/dev/null
sleep 3
ev "$A" "(function(){var c=document.querySelector('#panel-take input[type=checkbox]');if(c&&!c.checked){var b=[].slice.call(document.querySelectorAll('#panel-take button')).filter(function(x){return x.textContent.trim()==='Toutes';})[0];if(b)b.click();}return 'SEL';})()" >/dev/null
sleep 2
shot "$A" "02-master-take.png"
ev "$A" "document.getElementById('tkArm').click();'ARMED'" >/dev/null
sleep 5

# ATTENTION A L'ORDRE. Si une Capture revient en WARNING (permission
# NOT_REQUESTED, stockage < 1 Go...), le bouton REC n'est pas inerte : il OUVRE
# le modal d'incident, et c'est « Continuer REC » qui declenche reellement le
# top. Fermer le modal avant d'avoir clique REC ne sert donc a rien — c'est ce
# que faisait ce script, et il aboutissait a un REC jamais parti.
adb -s "$A" logcat -c; adb -s "$B" logcat -c
ev "$A" "document.getElementById('armRec').click();'REC_PRESSED'" >/dev/null
sleep 3
dump "$A" "(function(){var m=document.getElementById('armIncidentModal');return JSON.stringify({modalShown:!!(m&&m.classList.contains('show')),recDisabled:document.getElementById('armRec').disabled,eligible:MultiCamArmService.view().recEligible,incidents:MultiCamArmService.view().incidents});})()" "04-A-incident.json"
# Les dumps sont des chaines JSON : les guillemets y sont echappes. On retire
# les backslashes avant de comparer, sinon `"modalShown":true` ne matche jamais.
INC=$(sed 's/\\//g' "$OUT/dumps/04-A-incident.json")
case "$INC" in
  *'"modalShown":true'*)
    echo "  modal d'incident ouvert (B en WARNING) -> passage par « Continuer REC »"
    ev "$A" "document.getElementById('armIncidentContinue').click();'CONTINUE'" >/dev/null ;;
  *) echo "  aucun incident : REC direct" ;;
esac
sleep 8
# On ATTEND que B soit reellement en REC (et pas seulement arme) : la bascule
# est le sujet, le top ne doit pas pouvoir la contaminer.
RECREADY=0
for i in $(seq 1 20); do
  ST=$(ev "$B" "(function(){return (MultiCamCameraRecord.isRecording()?'REC':(MultiCamStartService.phase()||'?'));})()" | tr -d '"')
  if [ "$ST" = "REC" ]; then RECREADY=1; echo "  B en REC apres ${i} tentatives"; break; fi
  sleep 2
done
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),switch:MultiCamCameraSwitchService.view()})" "04-B-rec-on.json"
shot "$B" "03-capture-rec-before.png"
BEFORE=$(sed 's/\\//g' "$OUT/dumps/04-B-rec-on.json")
echo "  B avant bascule : $BEFORE"
case "$BEFORE" in
  *'"rec":true'*) echo "  REC actif sur B: OK" ;;
  *) echo "FATAL: le REC n'est pas actif sur B — bascule non mesurable"; exit 1 ;;
esac

mark "5. BASCULE demandée par le Master pendant le REC (B -> FRONT)"
# `date +%s%3N` est une extension GNU : sur macOS (BSD) il renvoie litteralement
# `N` en fin de chaine, et l'arithmetique qui suit explose. On passe par Python.
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }
REC_START=$(nowms)
dump "$A" "(function(){var p=MultiCamCameraSwitchService.requestSwitchRemote({targetDeviceId:'$BDID',camera:'FRONT'});return 'ORDER_SENT';})()" "05-A-order.json"
# On ne fige PAS le résultat ici : l'ACK peut arriver après. On le lit ensuite.
sleep 8
REC_END=$(nowms)
echo "  fenêtre REC->ACK : $((REC_END - REC_START)) ms (mur, hors horloge du device)"
dump "$A" "JSON.stringify(MultiCamCameraSwitchService.view())" "06-A-after-switch.json"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "07-B-after-switch.json"
dump "$B" "(function(){return JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),native:MultiCamCameraRecord.view()});})()" "08-B-native-after.json"
shot "$B" "04-capture-rec-after.png"

mark "6. convergence de l'etat chez le Master (camera_state)"
dump "$A" "(function(){var v=MultiCamCameraStateInbox.forDevice('$BDID','$SID_ID');return JSON.stringify(v||null);})()" "09-A-inbox.json"

mark "7. preuve que le REC n'a PAS ete interrompu"
# Un REC interrompu se lirait dans les logs : deux CAMERA_REC_OK sans
# CAMERA_REC_STOP_OK entre eux, ou un segment rouvert sans fermeture.
dump "$B" "JSON.stringify({starts:MultiCamCameraRecord.view().starts,recording:MultiCamCameraRecord.isRecording(),prepared:MultiCamCameraRecord.view().prepared})" "10-B-rec-integrity.json"

mark "8. facing hors modele refuse SANS fermer de segment"
dump "$A" "(function(){var p=MultiCamCameraSwitchService.requestSwitchRemote({targetDeviceId:'$BDID',camera:'NONE'});return 'ORDER_NONE';})()" "11-A-order-none.json"
sleep 6
dump "$A" "JSON.stringify(MultiCamCameraSwitchService.view())" "12-A-after-none.json"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "13-B-after-none.json"

mark "9. STOP local sur B"
ev "$B" "(function(){var b=document.getElementById('cdEmergency');if(b)b.click();return 'STOP_DIALOG';})()" >/dev/null
sleep 2
ev "$B" "(function(){var b=document.getElementById('cdStopConfirm');if(b)b.click();return 'STOPPED';})()" >/dev/null
sleep 6
shot "$B" "05-capture-after-stop.png"
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),switch:MultiCamCameraSwitchService.view()})" "14-B-after-stop.json"

mark "10. collecte des preuves"
for s in $A $B; do logs "$s" "camera-switch"; done
echo
echo "== oracles CAMERA_SWITCH / CAMERA_SEG (device B) =="
grep -E "CAMERA_SWITCH_|CAMERA_SEG_" "$OUT/logs/$B-camera-switch.log" 2>/dev/null | sed 's/^/  /' | head -40
echo
echo "== les 2 REC de B (doivent etre encadres par des segments) =="
grep -E "CAMERA_REC_OK|CAMERA_REC_STOP_OK|CAMERA_SEG_" "$OUT/logs/$B-camera-switch.log" 2>/dev/null | sed 's/^/  /'
echo
echo "== proofs de pixels (la preview doit rester visible) =="
echo -n "  avant bascule : "; pixel "03-capture-rec-before.png"
echo -n "  apres bascule : "; pixel "04-capture-rec-after.png"
echo -n "  apres STOP    : "; pixel "05-capture-after-stop.png"

echo
echo "Preuves : $OUT/logs, $OUT/dumps, $OUT/screenshots"