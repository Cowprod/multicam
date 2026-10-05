#!/usr/bin/env bash
# Preuve J09-08e — VALIDATION PHYSIQUE FINALE caméra + UI.
#
# Ce script ne prouve QUE la convergence, sur devices réels, de deux choses qui
# n'avaient jamais été confrontées l'une à l'autre :
#
#   1. l'état caméra/segment PUBLIE par la Capture (faits natifs relus) ;
#   2. ce que l'UI affiche, localement sur la Capture et dans la modal du Master.
#
# Aucun développement ici : ce script pilote l'application comme un opérateur
# (appels UI, clics, attentes) et LIT les faits. Toute anomalie est rapportée,
# jamais corrigée sur place.
#
# Appareils : A = Master (+ Capture locale si les skills le permettent),
#             B = Capture basculée. Les MP4 restent HORS dépôt (MEDIA).
#
# Usage : tests/e2e/validation/J09-rec-previews/run-j09-08e.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="$HERE"
CDP="$ROOT/tests/e2e/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91          # Master (« Cam 05 »)
B=61d54bba7d91          # Capture (« Cam 07 ») — c'est elle qui est basculée
BDID=""                 # deviceId de B
ADID=""                 # deviceId de A
SID=""                  # sessionId

MEDIA="/Volumes/SSD1TO/testia/openCode/_J09-08e-media"   # hors dépôt
TAG="J0908e-$(date +%H%M%S)"

mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps" "$MEDIA"

FAILN=0
CHECKS="$OUT/logs/$TAG-checks.txt"
MESURES="$OUT/logs/$TAG-mesures.txt"
FICHES="$OUT/logs/$TAG-fichiers.txt"
: > "$CHECKS"; : > "$MESURES"; : > "$FICHES"

# ---------------------------------------------------------------- utilitaires
ev() { node "$CDP" "$1" eval "$2"; }

strip() { sed 's/^"//; s/"$//; s/\\"/"/g; s/\\n/ /g'; }

# Les valeurs textuelles contiennent des espaces : le séparateur de champs est
# donc `|`, et chaque champ est lu à son PREMIER `=`.
field() {
  printf '%s' "$1" | awk -F'|' -v k="$2" '
    { for (i = 1; i <= NF; i++) { p = index($i, "=");
        if (p > 0 && substr($i, 1, p - 1) == k) { v = substr($i, p + 1); found = 1 } } }
    END { print (found ? v : "") }'
}

label_for() {
  case "$1" in
    REAR)  echo "Arrière" ;;
    FRONT) echo "Selfie" ;;
    *)     echo "$1" ;;
  esac
}

shot() {
  case "$2" in *.png) N="$2" ;; *) N="$2.png" ;; esac
  adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$N"
  echo "  shot $N ($(wc -c < "$OUT/screenshots/$N" | tr -d ' ') octets)"
}

dump() { ev "$1" "$2" > "$OUT/dumps/$TAG-$3"; }

logs() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_SWITCH_|CAMERA_SEGMENT_|CAMERA_REC_|CAMERA_PREP_|CAMERA_PREVIEW_|CAMERA_SAMPLER_|CAMERA_ACTIVE_|CAMERA_STATE_|CAMERA_TRANSPORT_|SESSION|WS_|START_|TAKE_|MEMBER|CLOCK_|ARM_|PREVIEW_" \
    > "$OUT/logs/$TAG-$1-$2.log"
  echo "  logs $TAG-$1-$2 ($(wc -l < "$OUT/logs/$TAG-$1-$2.log" | tr -d ' ') lignes)"
}

# chk <libellé> <0=conforme 1=non conforme> <observé>
chk() {
  if [ "$2" = "0" ]; then
    printf '  PASS   %-56s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
  else
    printf '  FAIL   %-56s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
    FAILN=$((FAILN + 1))
  fi
}

# obs : un fait constaté, ni conforme ni non conforme (limite de l'outillage).
obs() { printf '  OBS    %-56s %s\n' "$1" "${2:-}" | tee -a "$CHECKS"; }

eq()  { if [ "$2" = "$3" ]; then chk "$1" 0 "$3"; else chk "$1" 1 "attendu=[$2] obtenu=[$3]"; fi; }
has() { case "$3" in *"$2"*) chk "$1" 0 "[$3]" ;; *) chk "$1" 1 "fragment absent [$2] dans [$3]" ;; esac; }
hasnt() { case "$3" in *"$2"*) chk "$1" 1 "fragment interdit [$2] dans [$3]" ;; *) chk "$1" 0 "[$3]" ;; esac; }

mark() { echo; echo "### $*"; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# Un `segmentState` VIDE est un fait (aucun segment en cours) : il ne doit pas
# se confondre avec une valeur absente. On le sérialise pour le distinguer de `-`.
# J09-08b4 : l'UI ne doit jamais présenter la caméra CIBLE comme ACTIVE avant
# confirmation native. Annoncer « Bascule vers X… » est au contraire EXIGE (c'est
# l'état transitoire) : seule une mention de la cible HORS marqueur de transition
# serait une promotion.
claim_ok() { # claim_ok <texte(s) UI> <label caméra> -> 0 si la cible n'est PAS présentée
  case "$1" in
    *Bascule\ vers*|*Changement\ vers*|*bascule\ vers*|*changement\ vers*) echo 0 ;;
    *"$2"*) echo 1 ;;
    *) echo 0 ;;
  esac
}

# ------------------------------------------------------------------- sondes
# Capture : faits PUBLIES par le service local, VRAIE vue REC locale (`cdRec*`),
# ligne du device local de l'écran live, dernier JPEG produit par la sonde.
probe_cap() {
  ev "$1" "(function(){
    var v = MultiCamCameraSwitchService.view();
    var s = MultiCamPreviewSampler.peek();
    var l = document.getElementById('cdRecCamLabel');
    var g = document.getElementById('cdRecSeg');
    var er = document.getElementById('cdRecErr');
    var lc = document.getElementById('liveLocalCam');
    return [
      'cam=' + (v.activeCamera || '-'),
      'sw=' + (v.switchingCamera || '-'),
      'req=' + (v.requestedCamera || '-'),
      'seg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'segState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'rec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'err=' + (v.lastErrorCode || '-'),
      'swMs=' + (v.lastSwitchDurationMs == null ? '-' : v.lastSwitchDurationMs),
      'smp=' + (s && s.completedAt ? s.completedAt : '-'),
      'cdRecCam=' + (l ? l.textContent : '-'),
      'cdRecSeg=' + (g ? g.textContent : '-'),
      'cdRecErr=' + (er ? er.textContent : '-'),
      'liveLocalCam=' + (lc ? lc.textContent : '-')
    ].join('|');
  })()" | strip
}

# Master : faits REÇUS pour B (camera_state), dernier JPEG reçu, ligne locale,
# et les trois zones caméra de la modal de B.
probe_msr() {
  ev "$1" "(function(){
    var v = MultiCamCameraStateInbox.forDevice('$BDID', '$SID') || {};
    var m = (MultiCamPreviewInbox.view() || {}).stats || {};
    var lc = document.getElementById('liveLocalCam');
    var st = document.getElementById('ldCamState');
    var nt = document.getElementById('ldCamNote');
    var bs = [].slice.call(document.querySelectorAll('#ldCamActions button'));
    return [
      'mCam=' + (v.activeCamera || '-'),
      'mSw=' + (v.switchingCamera || '-'),
      'mReq=' + (v.requestedCamera || '-'),
      'mSeg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'mSegState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'mRec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'mErr=' + (v.lastErrorCode || '-'),
      'mSwMs=' + (v.lastSwitchDurationMs == null ? '-' : v.lastSwitchDurationMs),
      'jpeg=' + (m.lastReceivedAtMs || 0),
      'liveLocalCam=' + (lc ? lc.textContent : '-'),
      'ldCamState=' + (st ? st.textContent : '-'),
      'ldCamNote=' + (nt ? nt.textContent : '-'),
      'ldBtn=' + bs.length,
      'ldBtnOff=' + bs.filter(function (b) { return b.disabled; }).length
    ].join('|');
  })()" | strip
}

# =============================================================================
echo "== 0. preparation =="
HEAD_SHA=$(cd "$ROOT" && git rev-parse --short HEAD)
echo "  HEAD  = $HEAD_SHA $(cd "$ROOT" && git log -1 --pretty=%s)"
APK="$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
echo "  APK   = $APK"
echo "  APK   = sha256 $(shasum -a 256 "$APK" | awk '{print $1}') ($(stat -f %z "$APK") octets)"
echo "  media (hors dépôt) = $MEDIA"
echo "$HEAD_SHA $(shasum -a 256 "$APK" | awk '{print $1}')" > "$OUT/logs/$TAG-apk.txt"

for s in $A $B; do
  PID=$(adb -s "$s" shell pidof $APP | tr -d '\r' | awk '{print $1}')
  if [ -z "$PID" ]; then
    echo "  $s : l'app ne tourne pas — lancement"
    adb -s "$s" shell monkey -p $APP -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    sleep 12
    PID=$(adb -s "$s" shell pidof $APP | tr -d '\r' | awk '{print $1}')
  fi
  [ -n "$PID" ] || { echo "FATAL: $s ne lance pas"; exit 1; }
  echo "  $s pid=$PID model=$(adb -s "$s" shell getprop ro.product.model | tr -d '\r') sdk=$(adb -s "$s" shell getprop ro.build.version.sdk | tr -d '\r')"
done

BDID=$(ev "$B" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
ADID=$(ev "$A" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
[ -n "$BDID" ] && [ -n "$ADID" ] || { echo "FATAL: deviceId introuvable"; exit 1; }

# Purge STRICTE des MP4 du cache applicatif AVANT le run : sans elle, un run
# précédent rendrait l'attribution segmentIndex <-> fichier impossible. Le motif
# est validé avant toute suppression, et rien d'autre n'est touché.
for s in $A $B; do
  adb -s "$s" exec-out run-as $APP ls cache 2>/dev/null | tr -d '\r' | grep -E '^videoTmp(_\d+)?\.mp4$' | while read -r f; do
    adb -s "$s" exec-out run-as $APP rm -f "cache/$f" >/dev/null 2>&1
    echo "  purge $s $f"
  done
done
BSKILLS=$(ev "$B" "JSON.stringify((MultiCamConfig.get()||{}).enabledSkills||[])" | sed 's/^"//; s/"$//; s/\\//g')
ASKILLS=$(ev "$A" "JSON.stringify((MultiCamConfig.get()||{}).enabledSkills||[])" | sed 's/^"//; s/"$//; s/\\//g')
echo "  A(deviceId)=$ADID skills=$ASKILLS"
echo "  B(deviceId)=$BDID skills=$BSKILLS"
dump "$A" "JSON.stringify({ts:Date.now(),skills:$ASKILLS})" "00-A-boot.json"
dump "$B" "JSON.stringify({ts:Date.now(),skills:$BSKILLS})" "00-B-boot.json"

SNAME="Regie $TAG"

mark "1. session propre creee sur A (Master)"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null
sleep 2
ev "$A" "(function(){
  var n = document.getElementById('sessionName');
  if (n) { n.value = '$SNAME'; n.dispatchEvent(new Event('input', { bubbles: true })); }
  document.getElementById('createButton').click();
  return 'CREATED';
})()" >/dev/null
sleep 3
SID=$(ev "$A" "(async function(){
  var l = await MultiCamSessionStore.list(), named = null, newest = null;
  for (var i = 0; i < l.length; i++) {
    if (l[i].name === '$SNAME') named = l[i];
    if (!newest || (l[i].addedAtMs || 0) > (newest.addedAtMs || 0)) newest = l[i];
  }
  var s = named || newest;
  return s ? s.sessionId : 'NOT_FOUND';
})()" | tr -d '"')
[ -n "$SID" ] && [ "$SID" != "NOT_FOUND" ] || { echo "FATAL: session introuvable"; exit 1; }
PIN=$(ev "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return String(s.pin || '');})()" | tr -d '"')
echo "  SESSION sid=$SID pin=$PIN"
dump "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return JSON.stringify({sessionId:s.sessionId,name:s.name,masters:s.masters});})()" "01-A-session.json"

mark "2. B rejoint par le CHEMIN UI REEL (annonceur)"
adb -s "$B" logcat -c
EP=$(ev "$B" "(async function(){
  var deadline = Date.now() + 25000, inst = null;
  while (Date.now() < deadline && !inst) {
    var l = MultiCamSessionDiscovery.list() || [];
    for (var i = 0; i < l.length; i++) {
      if (l[i] && l[i].sessionId === '$SID') {
        var ann = l[i].announcers || [];
        for (var j = 0; j < ann.length; j++) {
          if (ann[j] && ann[j].deviceId && ann[j].deviceId !== MultiCamCameraSwitchService.view().deviceId) { inst = ann[j]; break; }
        }
        if (!inst && ann.length) inst = ann[ann.length - 1];
        if (inst) break;
      }
    }
    if (!inst) await new Promise(function (r) { setTimeout(r, 700); });
  }
  return inst ? inst.host + ':' + inst.port : 'NOT_DISCOVERED';
})()" | tr -d '"')
echo "  endpoint = $EP"
case "$EP" in
  *:*) ;;
  *) echo "FATAL: endpoint introuvable ($EP)"; exit 1 ;;
esac
JH="${EP%%:*}"; JP="${EP##*:}"
ev "$B" "(function(){
  MultiCamNav.show('join', { mode: 'join', sid: '$SID', name: '$SNAME', host: '$JH', port: '$JP' });
  return 'NAV_JOIN';
})()" >/dev/null
sleep 3
for i in 0 1 2 3; do
  ev "$B" "(function(){
    var b = document.getElementById('pin$i'); if (!b) return 'NO_BOX';
    b.focus(); b.value = '$PIN'.charAt($i);
    b.dispatchEvent(new Event('input', { bubbles: true }));
    return 'TYPED';
  })()" >/dev/null
  sleep 1
done
sleep 9
dump "$B" "(function(){return JSON.stringify({panel:(document.querySelector('.screen.active')||{}).id,pinStatus:(document.getElementById('pinStatus')||{}).textContent});})()" "02-B-join-ui.json"

mark "3. le Master ADMET B (Capture), puis tente un device LOCAL qui enregistre"
dump "$A" "(async function(){
  var s = await MultiCamSessionStore.get('$SID');
  var ann = (s.masters || []).filter(function (m) { return m.deviceId === '$BDID'; })[0];
  if (!ann) return 'NO_ANNOUNCER';
  try {
    await MultiCamSessionWs.addMember(s, {
      deviceId: '$BDID', deviceName: ann.deviceName || 'Cam',
      enabledSkills: $BSKILLS, endpoint: ann.endpoint || ''
    }, ['capture']);
  } catch (e) { return 'ADD_KO:' + (e && e.message); }
  var t = await MultiCamSessionStore.get('$SID');
  var m = (t.members || []).filter(function (x) { return x.deviceId === '$BDID'; })[0];
  return JSON.stringify({ deviceId: '$BDID', member: !!m, roles: m && m.sessionRoles });
})()" "03-B-role.json"
echo "  B   -> $(sed 's/\\//g' "$OUT/dumps/$TAG-03-B-role.json")"
MEM=$(ev "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return String((s.members||[]).length);})()" | tr -d '"')
echo "  membres sur A = $MEM"
[ "$MEM" != "0" ] && [ -n "$MEM" ] || { echo "FATAL: B n'est pas membre"; exit 1; }

# La LIGNE LOCALE de l'écran live (`liveLocalCam`, J09-08d) ne s'affiche que si le
# device LOCAL capture. On tente donc d'ajouter A comme Capture de sa propre
# session. Cet essai est un fait à rapporter, pas une exigence du plan : sans
# lui, la ligne locale reste vide et la preuve se fait sur B.
# Le skill qui autorise l'enregistrement est `capture` (les skills J01 sont
# `capture` / `storage` / `controller`).
LOCALCAP=0
case "$ASKILLS" in
  *capture*) ;;
  *) echo "  A n'a pas le skill capture : pas de Capture locale possible" ;;
esac
case "$ASKILLS" in
  *capture*)
    dump "$A" "(async function(){
      var s = await MultiCamSessionStore.get('$SID');
      var me = (s.masters || []).filter(function (m) { return m.deviceId === '$ADID'; })[0];
      try {
        await MultiCamSessionWs.addMember(s, {
          deviceId: '$ADID', deviceName: (me && me.deviceName) || 'Master-Capture',
          enabledSkills: $ASKILLS, endpoint: (me && me.endpoint) || ''
        }, ['capture']);
      } catch (e) { return 'ADD_LOCAL_KO:' + (e && e.message); }
      var t = await MultiCamSessionStore.get('$SID');
      var m = (t.members || []).filter(function (x) { return x.deviceId === '$ADID'; })[0];
      return JSON.stringify({ deviceId: '$ADID', member: !!m, roles: m && m.sessionRoles });
    })()" "03-A-local-role.json"
    echo "  A   -> $(sed 's/\\//g' "$OUT/dumps/$TAG-03-A-local-role.json")"
    case "$(sed 's/\\//g' "$OUT/dumps/$TAG-03-A-local-role.json")" in
      *'"member":true'*) LOCALCAP=1 ;;
    esac ;;
esac
echo "  Capture locale sur A = $LOCALCAP"
dump "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return JSON.stringify({sid:s.sessionId,masters:(s.masters||[]).map(function(m){return m.deviceId}),members:(s.members||[]).map(function(m){return {d:m.deviceId,r:m.sessionRoles}})});})()" "03-A-members.json"
shot "$A" "$TAG-01-master-session.png"

mark "4. selection des Captures + ARM + REC"
ev "$A" "MultiCamNav.show('take', { sid: '$SID' }); 'NAV_TAKE'" >/dev/null
sleep 3
ev "$A" "(function(){
  var c = document.querySelector('#panel-take input[type=checkbox]');
  if (c && !c.checked) {
    var b = [].slice.call(document.querySelectorAll('#panel-take button')).filter(function (x) { return x.textContent.trim() === 'Toutes'; })[0];
    if (b) b.click();
  }
  return 'SEL';
})()" >/dev/null
sleep 2
dump "$A" "(function(){var c=[].slice.call(document.querySelectorAll('#panel-take input[type=checkbox]'));return JSON.stringify({cases:c.length,checked:c.filter(function(x){return x.checked;}).length});})()" "04-A-take-cases.json"
shot "$A" "$TAG-02-master-take.png"
ev "$A" "document.getElementById('tkArm').click(); 'ARMED'" >/dev/null
sleep 5

adb -s "$A" logcat -c; adb -s "$B" logcat -c
ev "$A" "document.getElementById('armRec').click(); 'REC_PRESSED'" >/dev/null
sleep 3
dump "$A" "(function(){var m = document.getElementById('armIncidentModal'); return JSON.stringify({modalShown:!!(m&&m.classList.contains('show')),recDisabled:document.getElementById('armRec').disabled,eligible:MultiCamArmService.view().recEligible,incidents:MultiCamArmService.view().incidents});})()" "04-A-incident.json"
INC=$(sed 's/\\//g' "$OUT/dumps/$TAG-04-A-incident.json")
case "$INC" in
  *'"modalShown":true'*)
    echo "  modal d'incident ouvert -> « Continuer REC »"
    ev "$A" "document.getElementById('armIncidentContinue').click(); 'CONTINUE'" >/dev/null ;;
  *) echo "  aucun incident : REC direct" ;;
esac

echo "  attente REC reel sur B"
RECREADY=0
for i in $(seq 1 25); do
  ST=$(ev "$B" "(function(){return (MultiCamCameraRecord.isRecording() ? 'REC' : (MultiCamStartService.phase() || '?'));})()" | tr -d '"')
  if [ "$ST" = "REC" ]; then RECREADY=1; echo "  B en REC apres $i tentatives"; break; fi
  sleep 2
done
[ "$RECREADY" = "1" ] || { echo "FATAL: B n'est pas en REC"; exit 1; }

# -----------------------------------------------------------------------------
# ATTENTE DE CONVERGENCE COTE MASTER — la question de fond de cette mission :
# le segment 1 existe-t-il pour le Master's SANS attendre une bascule ?
# `broadcastState("rec_started")` existe justement pour cela. On mesure donc le
# délai d'ARRIVEE reel du premier camera_state, et ce qu'il contient.
echo "  convergence Master (segment 1) — sondage toutes les 500 ms"
ARR_TRACE="$OUT/logs/$TAG-arrivee-master.txt"
: > "$ARR_TRACE"
ARR_MS=""; ARR_VAL=""; T_REC=$(nowms); I=0
while [ $I -lt 80 ]; do
  I=$((I + 1))
  PA=$(probe_msr "$A")
  MS=$(field "$PA" mSeg)
  printf '%s mSeg=%s mSegState=%s mRec=%s mCam=%s mReq=%s\n' \
    "$(nowms)" "$MS" "$(field "$PA" mSegState)" "$(field "$PA" mRec)" \
    "$(field "$PA" mCam)" "$(field "$PA" mReq)" >> "$ARR_TRACE"
  if [ -n "$ARR_VAL" ] && [ -n "$MS" ] && [ "$MS" != "-" ] && [ "$MS" != "0" ]; then break; fi
  sleep 0.5
done
# premiere ligne non vide du trace = premiere CONNAISSANCE du Master
FIRST=$(grep -v "mSeg=- " "$ARR_TRACE" | head -1)
if [ -n "$FIRST" ]; then
  ARR_MS=$(( $(printf '%s' "$FIRST" | awk '{print $1}') - T_REC ))
  ARR_VAL="$FIRST"
  echo "  1er camera_state recu par le Master : $FIRST  (+${ARR_MS} ms apres REC confirme)"
else
  echo "  AUCUN camera_state recu par le Master en 40 s"
fi
sed 's/^/    /' "$ARR_TRACE" | head -12
logs "$A" "arrivee"; logs "$B" "arrivee"

# =============================================================================
mark "B. SEGMENT 1 — etat publie + UI"
CB=$(probe_cap "$B"); echo "  B: $CB"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "10-B-view-seg1.json"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$BDID','$SID')||null)" "11-A-inbox-seg1.json"
ev "$A" "MultiCamLiveDetail.open('$BDID'); 'MODAL_OPEN'" >/dev/null
sleep 2
ev "$A" "MultiCamLiveDetail.refresh(); 'REFRESH'" >/dev/null
sleep 1
MA=$(probe_msr "$A"); echo "  A: $MA"
dump "$A" "(function(){var s=MultiCamLiveModel.view().slots.filter(function(x){return x.deviceId==='$BDID';})[0]||{};return JSON.stringify(MultiCamLiveDetail.detailOf(s,{nowMs:Date.now()}));})()" "12-A-detail-seg1.json"

eq  "B  segmentIndex == 1"           "1" "$(field "$CB" seg)"
eq  "B  segmentState == recording"   "recording" "$(field "$CB" segState)"
eq  "B  recording == true"           "true" "$(field "$CB" rec)"
hasnt "B  activeCamera confirme (non vide)" "-" "$(field "$CB" cam)"
eq  "A  segmentIndex recu == 1"      "1" "$(field "$MA" mSeg)"
eq  "A  segmentState recu"           "recording" "$(field "$MA" mSegState)"
eq  "A  recording recu == true"      "true" "$(field "$MA" mRec)"
eq  "A  meme activeCamera que B"     "$(field "$CB" cam)" "$(field "$MA" mCam)"
chk "A  requestedCamera non promu en actif" "$(claim_ok "$(field "$MA" ldCamState)" "$(label_for "$(field "$MA" mReq)")")" "modal=[$(field "$MA" ldCamState)]"
obs "A  requestedCamera recu (derniere demande, jamais lue comme active)" "actif=$(field "$MA" mCam) demande=$(field "$MA" mReq)"
has "UI locale B  camera reelle"    "$(label_for "$(field "$CB" cam)")" "$(field "$CB" cdRecCam)"
has "UI locale B  segment 1"        "Segment 1" "$(field "$CB" cdRecSeg)"
has "modal A  camera reelle"        "$(label_for "$(field "$MA" mCam)")" "$(field "$MA" ldCamState)"
has "modal A  segment 1"            "segment 1" "$(field "$MA" ldCamState)"
has "modal A  enregistrement"       "enregistrement" "$(field "$MA" ldCamState)"
eq  "modal A  2 boutons camera"     "2" "$(field "$MA" ldBtn)"
# J09-08b : le bouton de la caméra ACTIVE est désactivé par construction
# (live-detail.js : `disabled = !connected || switching || (c === camActive)`),
# et les deux le sont pendant une bascule. « 0 bouton désactivé » serait donc
# une attente FAUSSE : c'est 1 au repos.
if [ "$(field "$MA" ldBtn)" -ge 2 ] 2>/dev/null; then
  eq  "modal A  1 bouton desactive (la camera active)" "1" "$(field "$MA" ldBtnOff)"
else
  obs "modal A  aucun bouton (camera inconnue : aucun ordre propose)" "ldBtn=$(field "$MA" ldBtn)"
fi
echo "  liveLocalCam(B) = [$(field "$CB" liveLocalCam)]"
echo "  liveLocalCam(A) = [$(field "$MA" liveLocalCam)]"
# Le delai d'arrivee du segment 1 est une MESURE, pas une opinion.
if [ -n "$ARR_VAL" ]; then
  chk "Master : segment 1 recu SANS attendre de bascule" 0 "$ARR_VAL"
  printf '  MESURE delai 1er camera_state (segment 1) : %s ms\n' "$ARR_MS" >> "$MESURES"
else
  chk "Master : segment 1 recu SANS attendre de bascule" 1 "aucun camera_state en 40 s (voir $ARR_TRACE)"
fi
if [ "$LOCALCAP" = "1" ]; then
  # La ligne locale de A décrit LES FAITS DE A (sa camera, SON segment) : c'est
  # le controle anti-detournement de slot (J09-08b). On la compare donc aux faits
  # de A, jamais aux faits recus pour B.
  CA=$(probe_cap "$A")
  LOCAL_A_LINE=$(field "$CA" liveLocalCam)
  echo "  A local : $CA"
  has "ligne locale A  camera reelle (celle de A)" "$(label_for "$(field "$CA" cam)")" "$(field "$CA" liveLocalCam)"
  has "ligne locale A  segment 1 (le sien)"      "segment 1" "$(field "$CA" liveLocalCam)"
  has "ligne locale A  enregistrement"           "enregistrement" "$(field "$CA" liveLocalCam)"
else
  obs "ligne locale A vide (A n'enregistre pas : pas de Capture locale)" "[$(field "$MA" liveLocalCam)]"
fi
shot "$A" "$TAG-03-master-modal-seg1.png"
shot "$B" "$TAG-04-capture-seg1.png"

# =============================================================================
# Une bascule = état TRANSITOIRE puis CONFIRMATION. On sonde les deux devices
# pendant l'opération et on garde chaque sondage (trame de preuve).
switch_do() { # switch_do <CIBLE> <etiquette> <index attendu>
  TARGET="$1"; LABEL="$2"; EXPECT="$3"
  TRACE="$OUT/logs/$TAG-switch-$LABEL-trace.txt"
  : > "$TRACE"
  echo "-- bascule $LABEL -> $TARGET (segment attendu $EXPECT)"

  ev "$A" "MultiCamLiveDetail.refresh(); 'R'" >/dev/null
  PRE_B=$(probe_cap "$B"); PRE_A=$(probe_msr "$A")
  B_SMP0=$(field "$PRE_B" smp); A_JPEG0=$(field "$PRE_A" jpeg)
  printf '%s B[%s]\n' "$(nowms)" "$PRE_B" >> "$TRACE"
  printf '%s A[%s]\n' "$(nowms)" "$PRE_A" >> "$TRACE"

  T0=$(nowms)
  # Le tampon logcat de ce device est un anneau de 2 MiB : sans purge, le
  # spam SESSION_ADVERTISE_SKIP et les logs HAL camera evintent la chronologie
  # caméra avant qu'on puisse la lire. On purge donc juste AVANT chaque bascule.
  adb -s "$A" logcat -c 2>/dev/null; adb -s "$B" logcat -c 2>/dev/null
  ev "$A" "(function(){var p = MultiCamCameraSwitchService.requestSwitchRemote({ targetDeviceId: '$BDID', camera: '$TARGET' }); return 'ORDER_SENT';})()" >/dev/null

  SEEN_SW=0; SEEN_FACT=0; SEEN_UI=""; CONF_B=""
  i=0
  while [ $i -lt 45 ]; do
    i=$((i + 1))
    sleep 0.3
    PB=$(probe_cap "$B"); PA=$(probe_msr "$A")
    printf '%s B[%s]\n' "$(nowms)" "$PB" >> "$TRACE"
    printf '%s A[%s]\n' "$(nowms)" "$PA" >> "$TRACE"
    # Le transitoire est-il publié comme FAIT ?
    if [ "$(field "$PB" sw)" = "$TARGET" ] || [ "$(field "$PA" mSw)" = "$TARGET" ]; then SEEN_FACT=1; fi
    # ... et est-il VISIBLE dans l'UI au même moment ?
    if [ "$SEEN_SW" = "0" ]; then
      UIB=$(field "$PB" cdRecCam); UIL=$(field "$PB" liveLocalCam); UIA=$(field "$PA" ldCamState)
      case "$UIB$UIL$UIA" in
        *Changement*|*changement*|*Bascule*|*bascule*)
          SEEN_SW=1; SEEN_UI="B.cdRecCam=[$UIB] B.liveLocalCam=[$UIL] A.ldCamState=[$UIA]"
          # J09-08b4 : PENDANT la bascule, ni B ni le Master ne doivent
          # présenter la caméra CIBLE comme active. On le contrôle sur le texte
          # réellement affiché pendant le transitoire.
          chk "$LABEL transitoire : cible JAMAIS presentee comme active" \
            "$(claim_ok "$UIB$UIA" "$(label_for "$TARGET")")" "B=[$UIB] A=[$UIA]"
          shot "$A" "$TAG-$LABEL-a-transitoire.png"
          shot "$B" "$TAG-$LABEL-b-transitoire.png" ;;
      esac
    fi
    if [ "$(field "$PB" sw)" != "$TARGET" ] && [ "$(field "$PB" cam)" = "$TARGET" ] && [ -z "$CONF_B" ]; then
      CONF_B="$PB"; CONF_MS=$(( $(nowms) - T0 )); break
    fi
  done

  if [ "$SEEN_SW" = "1" ]; then
    chk "$LABEL transitoire « bascule en cours » visible dans l'UI" 0 "$SEEN_UI"
  elif [ "$SEEN_FACT" = "1" ]; then
    obs "$LABEL transitoire PUBLIE mais non capture par le sondage (~1 s/iteration)" "voir $TRACE"
  else
    chk "$LABEL transitoire « bascule en cours » visible dans l'UI" 1 "ni les faits ni l'UI ne l'ont montre"
  fi
  if [ -z "$CONF_B" ]; then chk "$LABEL confirmation native atteinte" 1 "pas de confirmation en ~18 s"; return 1; fi
  chk "$LABEL confirmation native atteinte" 0 "cam=$(field "$CONF_B" cam) seg=$(field "$CONF_B" seg) en ${CONF_MS} ms"

  sleep 3
  ev "$A" "MultiCamLiveDetail.refresh(); 'R'" >/dev/null
  sleep 1
  CB=$(probe_cap "$B"); MA=$(probe_msr "$A")
  printf '%s B[%s]\n' "$(nowms)" "$CB" >> "$TRACE"
  printf '%s A[%s]\n' "$(nowms)" "$MA" >> "$TRACE"

  eq  "$LABEL B  activeCamera == $TARGET"      "$TARGET" "$(field "$CB" cam)"
  eq  "$LABEL B  segmentIndex == $EXPECT"      "$EXPECT" "$(field "$CB" seg)"
  eq  "$LABEL B  segmentState == recording"    "recording" "$(field "$CB" segState)"
  eq  "$LABEL B  recording == true"            "true" "$(field "$CB" rec)"
  eq  "$LABEL A  activeCamera recu == $TARGET" "$TARGET" "$(field "$MA" mCam)"
  eq  "$LABEL A  segmentIndex recu == $EXPECT" "$EXPECT" "$(field "$MA" mSeg)"
  eq  "$LABEL A  segmentState recu"            "recording" "$(field "$MA" mSegState)"
  eq  "$LABEL A  recording recu == true"       "true" "$(field "$MA" mRec)"
  obs "$LABEL A  requestedCamera recu (derniere demande)" "actif=$(field "$MA" mCam) demande=$(field "$MA" mReq)"
  has "UI locale B  camera $TARGET"       "$(label_for "$TARGET")" "$(field "$CB" cdRecCam)"
  has "UI locale B  segment $EXPECT"      "Segment $EXPECT" "$(field "$CB" cdRecSeg)"
  has "modal A  camera $TARGET"           "$(label_for "$TARGET")" "$(field "$MA" ldCamState)"
  has "modal A  segment $EXPECT"          "segment $EXPECT" "$(field "$MA" ldCamState)"
  has "modal A  enregistrement"           "enregistrement" "$(field "$MA" ldCamState)"
if [ "$(field "$MA" ldBtn)" -ge 2 ] 2>/dev/null; then
  eq  "$LABEL modal A  1 bouton desactive (la camera active)" "1" "$(field "$MA" ldBtnOff)"
else
  obs "$LABEL modal A  aucun bouton (camera inconnue)" "ldBtn=$(field "$MA" ldBtn)"
fi
# A n'est PAS bascule : sa ligne locale doit rester decrite par ses propres
# faits. Si elle suivait B, c'est un vol de slot (J09-08b).
if [ "$LOCALCAP" = "1" ] && [ -n "$LOCAL_A_LINE" ]; then
  eq  "$LABEL ligne locale A  inchangee (B n'a pas vole le slot)" "$LOCAL_A_LINE" "$(field "$MA" liveLocalCam)"
fi

  # Reprise preview (Capture) et reprise JPEG (Master) : deux horloges de device,
  # donc deux deltas INTRA-device — jamais de soustraction entre devices.
  SMP1=$(field "$CB" smp); JPEG1=$(field "$MA" jpeg)
  GAP_CAP=$(( SMP1 - B_SMP0 )); GAP_MSR=$(( JPEG1 - A_JPEG0 ))
  echo "  $LABEL : confirmation ${CONF_MS} ms (mur) · swMs=$(field "$CB" swMs) · reprise preview ${GAP_CAP} ms · reprise JPEG Master ${GAP_MSR} ms"
  printf '%s confMs=%s swMs=%s reprisePreviewMs=%s repriseJpegMasterMs=%s\n' \
    "$LABEL" "$CONF_MS" "$(field "$CB" swMs)" "$GAP_CAP" "$GAP_MSR" >> "$MESURES"
  logs "$A" "$LABEL"; logs "$B" "$LABEL"
  shot "$A" "$TAG-$LABEL-a-confirme.png"
  shot "$B" "$TAG-$LABEL-b-confirme.png"
  return 0
}

mark "C. BASCULE demandee par le Master : REAR -> FRONT (segment 2)"
switch_do FRONT c-switch1 2

mark "D. BASCULE demandee par le Master : FRONT -> REAR (segment 3)"
switch_do REAR d-switch2 3

# `MultiCamLiveScreen.view(modelView, rec)` EXIGE ses deux arguments : appelé
# sans, il renvoie une mosaique vide par construction (faux défaut). On lui
# passe donc la VRAIE vue modele et le contexte d'enregistrement.
dump "$A" "(function(){var mv=MultiCamLiveModel.view();var s=MultiCamLiveScreen.view(mv,{phase:(MultiCamStartService.phase()||'REC'),recStartedAtMs:Date.now(),sessionName:'',nowMs:Date.now()});return JSON.stringify({count:s.count,tiles:s.tiles.map(function(t){return t.deviceId;}),grid:s.gridClass,local:s.localCamera,slots:(mv.slots||[]).map(function(x){return x.deviceId;})});})()" "20-A-mosaic-seg3.json"
MOS=$(sed 's/\\//g' "$OUT/dumps/$TAG-20-A-mosaic-seg3.json")
TILES=$(printf '%s' "$MOS" | grep -o '"tiles":\[[^]]*\]')
NT=$(printf '%s' "$TILES" | tr ',' '\n' | grep -c '[0-9a-f]\{8\}-[0-9a-f]\{4\}-')
DISTINCT=$(printf '%s' "$TILES" | tr ',' '\n' | grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' | sort -u | wc -l | tr -d ' ')
echo "  mosaique : $NT vignette(s) / $DISTINCT device(s) distinct(s)"
eq  "mosaique : une vignette par Capture (2 : locale + basculee)" "2" "$NT"
eq  "mosaique : aucune duplication de slot" "$NT" "$DISTINCT"
obs "ordre de la mosaique" "$TILES"

# =============================================================================
mark "E. STOP local propre sur B"
ev "$A" "MultiCamLiveDetail.close(); 'MODAL_CLOSED'" >/dev/null
adb -s "$A" logcat -c 2>/dev/null; adb -s "$B" logcat -c 2>/dev/null
ev "$B" "(function(){var b = document.getElementById('cdEmergency'); if (b) b.click(); return 'STOP_DIALOG';})()" >/dev/null
sleep 2
ev "$B" "(function(){var b = document.getElementById('cdStopConfirm'); if (b) b.click(); return 'STOP_SENT';})()" >/dev/null
sleep 9
ev "$A" "MultiCamLiveDetail.open('$BDID'); MultiCamLiveDetail.refresh(); 'R'" >/dev/null
sleep 2
CB=$(probe_cap "$B"); MA=$(probe_msr "$A")
echo "  B apres STOP : $CB"
echo "  A apres STOP : $MA"
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),view:MultiCamCameraSwitchService.view(),integrity:MultiCamCameraRecord.view()})" "30-B-after-stop.json"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$BDID','$SID')||null)" "31-A-inbox-after-stop.json"

eq      "STOP B  recording == false"        "false" "$(field "$CB" rec)"
eq      "STOP B  segmentIndex == 0"         "0"     "$(field "$CB" seg)"
eq      "STOP B  segmentState vide"         ""      "$(field "$CB" segState)"
eq      "STOP A  segmentIndex recu == 0"    "0"     "$(field "$MA" mSeg)"
eq      "STOP A  recording recu == false"   "false" "$(field "$MA" mRec)"
has     "STOP modal A  « aucun segment actif »" "aucun segment actif" "$(field "$MA" ldCamState)"
has     "STOP modal A  « n'enregistre pas »"    "n'enregistre pas"   "$(field "$MA" ldCamState)"
has     "STOP modal A  camera courante conservee" "$(label_for "$(field "$MA" mCam)")" "$(field "$MA" ldCamState)"
hasnt   "STOP modal A  pas de « segment 0 »"      "segment 0" "$(field "$MA" ldCamState)"
if [ -n "$(field "$CB" liveLocalCam)" ]; then
  has   "STOP ligne locale B  « aucun segment actif »" "aucun segment actif" "$(field "$CB" liveLocalCam)"
  hasnt "STOP ligne locale B  pas de « segment 0 »"    "segment 0" "$(field "$CB" liveLocalCam)"
else
  obs "STOP ligne locale B indisponible (B n'a pas d'écran live rendu)" "[$(field "$CB" liveLocalCam)]"
fi
# Preview permanente : ce qui doit survivre au STOP est la PREVIEW NATIVE du
# device (`CAMERA_REC_STOP_OK previewKept=1`, verifie en F). Le flux JPEG vers
# le Master, lui, est lie au REC par construction (preview-service : la sonde ne
# demarre qu'apres l'ACK du REC et s'arrete a `stopRecording`, cf. J09-03) :
# on le CONSTATE donc sans le declarer non conforme.
J1=$(field "$MA" jpeg)
sleep 7
MA2=$(probe_msr "$A")
J2=$(field "$MA2" jpeg)
if [ "${J2:-0}" -gt "${J1:-0}" ] 2>/dev/null; then
  obs "STOP flux JPEG Master : encore vivant apres le STOP" "jpeg $J1 -> $J2"
else
  obs "STOP flux JPEG Master : gele apres le STOP (sonde liee au REC, J09-03)" "jpeg $J1 -> $J2"
fi
ev "$A" "MultiCamLiveDetail.close(); 'C'" >/dev/null
shot "$A" "$TAG-05-master-modal-stop.png"
shot "$B" "$TAG-06-capture-stop.png"

# =============================================================================
mark "F. COHERENCE DES FICHIERS (hors Git)"
# Les logs sont collected ICI, avant toute autre activité : le tampon logcat est
# un anneau de 2 MiB et la chronologie caméra se fait évincer.
for s in $A $B; do logs "$s" "stop"; done
echo "  pulls dans $MEDIA"
# Seul B est l' Capture BASCULÉE : ses 3 segments sont l'objet de la preuve. La
# Capture LOCALE du Master (A) ne peut pas être arrêtée depuis sa propre vue
# Master (le STOP global du dock est volontairement vide en J09) : son fichier
# resterait non finalisé, on ne le tire donc pas et on ne conclut rien dessus.
# L'attribution segmentIndex <-> camera <-> fichier est lue dans l'ETAT de B
# (source de verite), pas devinee : on ne tire que ces trois fichiers.
SEGLIST=$(ev "$B" "(function(){var v=MultiCamCameraSwitchService.view();return (v.segments||[]).map(function(s){return s.segmentIndex+' '+s.camera+' '+String(s.path||'').split('/').pop()+' '+s.state;}).join('|');})()" | strip)
echo "  segments B (etat) = $SEGLIST" | tee -a "$FICHES"
NBF=0
if [ -z "$SEGLIST" ]; then
  obs "aucun segment dans l'etat de B" "F sans preuve"
else
  echo "  == $B ==" | tee -a "$FICHES"
  # `read` SANS newline finale perd le DERNIER element du flux : on en ajoute une.
  printf '%s\n' "$SEGLIST" | tr '|' '\n' | while read -r IDX CAMNM NM ST; do
    [ -n "$NM" ] || continue
    DST="$MEDIA/$B-$NM"
    SIZE=$(adb -s "$B" exec-out run-as $APP ls -l "cache/$NM" 2>/dev/null | awk '{print $5}')
    adb -s "$B" exec-out run-as $APP cat "cache/$NM" > "$DST" 2>/dev/null
    HSH=$(shasum -a 256 "$DST" | awk '{print $1}')
    FP=$(ffprobe -v error -show_entries format=format_name,duration,size \
         -show_entries stream=codec_type,codec_name,width,height,channels,sample_rate \
         -of default=noprint_wrappers=1 "$DST" 2>/dev/null | tr '\n' ' ')
    {
      echo "  segment $IDX camera=$CAMNM etat=$ST"
      echo "  fichier  : $NM"
      echo "  chemin   : $DST"
      echo "  octets   : $(wc -c < "$DST" | tr -d ' ')  (ls annonce $SIZE)"
      echo "  sha256   : $HSH"
      echo "  ffprobe  : $FP"
    } | tee -a "$FICHES"
  done
  NBF=$(printf '%s\n' "$SEGLIST" | tr '|' '\n' | grep -c 'videoTmp')
  eq  "F  B a produit exactement 3 segments (1/2/3)" "3" "$NBF"
  eq  "F  les 3 segments sont distincts (1/2/3)" "3" "$(printf '%s\n' "$SEGLIST" | tr '|' '\n' | grep -o 'videoTmp[^ ]*' | sort -u | wc -l | tr -d ' ')"
fi
DUP=$(for f in "$MEDIA"/61d54bba7d91-*.mp4; do shasum -a 256 "$f"; done 2>/dev/null | awk '{print $1}' | sort | uniq -d | wc -l | tr -d ' ')
chk "F  segments distincts (aucun sha256 en double)" 0 "$DUP doublon(s)"
echo "  == attribution segmentIndex <-> camera <-> fichier (logs B) ==" | tee -a "$FICHES"
{ grep -hE "CAMERA_SEGMENT_(OPEN|FINAL|FAILED)" "$OUT/logs/$TAG-$B"*.log 2>/dev/null
  grep -hE "CAMERA_REC_STOP_OK" "$OUT/logs/$TAG-$B"*.log 2>/dev/null; } \
  | sed -E 's/^.*"?(CAMERA_[A-Z_]+)/\1/; s/", source.*//' | tee -a "$FICHES"

mark "F2. PREUVES D'EMISSION / DE RECEPTION (logs)"
# ---- preview native conservee apres le STOP (l'invariant de preview permanente)
if grep -hq "CAMERA_REC_STOP_OK" "$OUT/logs/$TAG-$B"*.log 2>/dev/null; then
  PK=$(grep -ho "previewKept=[01]" "$OUT/logs/$TAG-$B"*.log | tail -1)
  chk "F2 preview NATIVE conservee apres le STOP (previewKept=1)" \
    "$( [ "$PK" = "previewKept=1" ] && echo 0 || echo 1 )" "$PK"
else
  chk "F2 preview NATIVE conservee apres le STOP (previewKept=1)" 1 "CAMERA_REC_STOP_OK absent des logs"
fi
# ---- la Capture a-t-elle EMIS son etat ? (TX, avec le compte de masters)
TXN=$(grep -h "CAMERA_STATE_TX" "$OUT/logs/$TAG-$B"*.log 2>/dev/null | wc -l | tr -d ' ')
TX1=$(grep -h "CAMERA_STATE_TX" "$OUT/logs/$TAG-$B"*.log 2>/dev/null | head -1 \
      | sed -E 's/.*(activeCamera=[^ ]*) (switchingCamera=[^ ]*) (masters=[0-9]+).*/\1 \2 \3/')
if [ "${TXN:-0}" -gt 0 ]; then
  chk "F2 la Capture EMIT des camera_state (TX)" 0 "$TXN emission(s) · 1re=$TX1"
  obs "F2 emissions camera_state de B (1re)" "$TX1"
else
  chk "F2 la Capture EMIT des camera_state (TX)" 1 "aucune ligne CAMERA_STATE_TX dans les logs de B"
fi
# ---- le segment 1 a-t-il ete ouvert par la Capture ?
if grep -hq "CAMERA_SEGMENT_OPEN" "$OUT/logs/$TAG-$B"*.log 2>/dev/null; then
  chk "F2 segment 1 ouvert par la Capture (CAMERA_SEGMENT_OPEN)" 0 \
    "$(grep -h 'CAMERA_SEGMENT_OPEN' "$OUT/logs/$TAG-$B"*.log | head -1 | sed -E 's/^[0-9-]+ [0-9:.]+//; s/", source.*//')"
else
  chk "F2 segment 1 ouvert par la Capture (CAMERA_SEGMENT_OPEN)" 1 "absent des logs de B"
fi
if grep -hqiE "CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP" "$OUT/logs/$TAG-$A"*.log 2>/dev/null; then
  obs "F2 le Master a REJETE un camera_state (cote reception)" \
    "$(grep -hoiE '(CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP)[^"]*' "$OUT/logs/$TAG-$A"*.log | head -3 | tr '\n' ' ')"
else
  obs "F2 le Master n'a journalise AUCUN rejet de camera_state" "ni CAMERA_STATE_DROP ni CAMERA_TRANSPORT_DROP"
fi
# ---- vrai delai de reprise de la preview (horloge INTRA-device, timestamps logcat)
for LB in c-switch1 d-switch2; do
  MAXGAP=$(grep -h "PREVIEW_FRAME_TX" "$OUT/logs/$TAG-$B-$LB.log" 2>/dev/null | awk '{
      t=$2; split(t,a,":"); ms=(a[1]*3600+a[2]*60+a[3])*1000;
      if (prev>0) { d=ms-prev; if (d>max) max=d } prev=ms } END { print max+0 }')
  NFR=$(grep -h "PREVIEW_FRAME_TX" "$OUT/logs/$TAG-$B-$LB.log" 2>/dev/null | wc -l | tr -d ' ')
  obs "$LB reprise preview : plus grand intervalle entre 2 JPEG emis" "${MAXGAP:-?} ms (${NFR:-0} image(s) sur la fenetre)"
  printf '%s previewGapMaxMs=%s framesTx=%s\n' "$LB" "${MAXGAP:-?}" "${NFR:-0}" >> "$MESURES"
done

mark "G. ECHEC CONTROLE (optionnel)"
# Un restart_failed rejoué exigerait d'injecter une panne dans le plugin ou le
# produit. Cette mission ne modifie rien : on constate l'existant.
if grep -qhE "CAMERA_SEGMENT_FAILED" "$OUT/logs/$TAG-$B"*.log 2>/dev/null; then
  grep -hE "CAMERA_SEGMENT_FAILED" "$OUT/logs/$TAG-$B"*.log | sed 's/^/  /' | head -5
else
  obs "restart_failed non injecte (hors perimetre : aucune modification produit)"
fi

mark "H. PREUVES"
echo "== chronologie camera (device B, tous fichiers collectes) =="
cat "$OUT/logs/$TAG-$B"*.log 2>/dev/null \
  | grep -E "CAMERA_REC_OK|CAMERA_REC_STOP_OK|CAMERA_SEGMENT_|CAMERA_SWITCH_" \
  | sed -E 's/^([0-9-]+ [0-9:]{8})\.[0-9]+.*"(CAMERA_[A-Z_]+)/\1 \2/; s/", source.*//' | head -40

mark "I. VALIDATION LOGIQUE"
if [ -z "$(cd "$ROOT" && git status --short)" ]; then
  obs "aucun fichier produit modifie -> pas de re-run de tests necessaire"
else
  echo "  ATTENTION : arbre de travail non propre :"
  (cd "$ROOT" && git status --short)
fi

mark "J. SYNTHESE"
echo "  controles non conformes : $FAILN"
echo "  liste complete          : $CHECKS"
[ -s "$MESURES" ] && { echo "  mesures :"; sed 's/^/    /' "$MESURES"; }
echo "  media hors depot        : $MEDIA"
if [ "$FAILN" -gt 0 ]; then
  echo "  RESULTAT : NON CONFORME ($FAILN) — NE PAS corriger ici, rapporter."
  exit 1
fi
echo "  RESULTAT : CONFORME"