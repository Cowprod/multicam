#!/usr/bin/env bash
# Preuve J09-08g — MINI-SMOKE PHYSIQUE du camera_state initial.
#
# Une seule question, sans switch caméra et sans campagne longue :
# le Master reçoit-il le camera_state du SEGMENT 1 dès le début du REC ?
#
# Contexte : `060fd88` avait gelé l'échec (CAMERA_STATE_TX … masters=0 au
# segment 1), `184fc30` l'a corrigé en rendant la session du Take obligatoire
# à la publication. Ce script rejoue le terrain avec les faits, jamais les
# opinions.
#
# Appareils : A = Master, B = Capture. Aucun MP4 n'est tiré ni versionné.
#
# Usage : tests/e2e/validation/J09-rec-previews/run-j09-08g.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="$HERE"
CDP="$ROOT/tests/e2e/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91          # Master (« Cam 05 »)
B=61d54bba7d91          # Capture (« Cam 07 »)
BDID=""
ADID=""
SID=""

TAG="J0908g-$(date +%H%M%S)"
mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps"

FAILN=0
CHECKS="$OUT/logs/$TAG-checks.txt"
MESURES="$OUT/logs/$TAG-mesures.txt"
: > "$CHECKS"; : > "$MESURES"

# ---------------------------------------------------------------- utilitaires
ev() { node "$CDP" "$1" eval "$2"; }

strip() { sed 's/^"//; s/"$//; s/\\"/"/g; s/\\n/ /g'; }

# Les valeurs textuelles contiennent des espaces : le séparateur est `|`, et
# chaque champ est lu à son PREMIER `=`.
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

# `sfx` sépare les fenêtres de temps : `rec` = collecté avant le STOP, `stop`
# = collecté après. Sans ce suffixe, la seconde collecte ÉCRASE la première et
# la preuve du REC disparaît (constaté sur le run 1).
console_raw() {
  adb -s "$1" logcat -d -v time 2>/dev/null | grep "CONSOLE" \
    > "$OUT/logs/$TAG-$1-$2-console.log"
}

# Log CIBLÉ : la mission ne veut pas d'un logcat complet mais des lignes qui
# font foi pour cet objet (émission côté Capture, réception côté Master).
logs_capture() {
  adb -s "$B" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_STATE_TX|CAMERA_STATE_NOT_PUBLISHED|CAMERA_STATE_SESSION_MISSING|CAMERA_SEGMENT_|CAMERA_REC_|CAMERA_ACTIVE_ADOPT|CAMERA_SWITCH_ATTACH|START_PLAN|START_NATIVE_ACK|SCREEN08" \
    > "$OUT/logs/$TAG-$B-capture-$1.log"
  echo "  log Capture ciblé[$1] ($(wc -l < "$OUT/logs/$TAG-$B-capture-$1.log" | tr -d ' ') lignes)"
}

logs_master() {
  adb -s "$A" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP|CAMERA_STATE_TX|CAMERA_STATE_NOT_PUBLISHED|WS_|SESSION_|MEMBER_|START_|TAKE_|PREVIEW_FRAME_RX" \
    > "$OUT/logs/$TAG-$A-master-$1.log"
  echo "  log Master ciblé[$1] ($(wc -l < "$OUT/logs/$TAG-$A-master-$1.log" | tr -d ' ') lignes)"
}

# chk <libellé> <0=conforme 1=non conforme> <observé>
chk() {
  if [ "$2" = "0" ]; then
    printf '  PASS   %-58s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
  else
    printf '  FAIL   %-58s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
    FAILN=$((FAILN + 1))
  fi
}
obs() { printf '  OBS    %-58s %s\n' "$1" "${2:-}" | tee -a "$CHECKS"; }
eq()  { if [ "$2" = "$3" ]; then chk "$1" 0 "$3"; else chk "$1" 1 "attendu=[$2] obtenu=[$3]"; fi; }
has() { case "$3" in *"$2"*) chk "$1" 0 "[$3]" ;; *) chk "$1" 1 "fragment absent [$2] dans [$3]" ;; esac; }
hasnt() { case "$3" in *"$2"*) chk "$1" 1 "fragment interdit [$2] dans [$3]" ;; *) chk "$1" 0 "[$3]" ;; esac; }

mark() { echo; echo "### $*"; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# ------------------------------------------------------------------- sondes
# Capture : les faits PUBLIES par le service local (c'est ce qui part vers le
# Master), plus les zones de l'écran REC local.
probe_cap() {
  ev "$1" "(function(){
    var v = MultiCamCameraSwitchService.view();
    var l = document.getElementById('cdRecCamLabel');
    var g = document.getElementById('cdRecSeg');
    return [
      'cam=' + (v.activeCamera || '-'),
      'seg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'segState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'rec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'sid=' + (v.sessionId || '-'),
      'take=' + (v.takeNumber == null ? '-' : v.takeNumber),
      'cdRecCam=' + (l ? l.textContent : '-'),
      'cdRecSeg=' + (g ? g.textContent : '-')
    ].join('|');
  })()" | strip
}

# Master : ce qui a été REÇU pour B (inbox), plus les zones de la modal.
probe_msr() {
  ev "$1" "(function(){
    var v = MultiCamCameraStateInbox.forDevice('$BDID', '$SID') || {};
    var st = document.getElementById('ldCamState');
    var nt = document.getElementById('ldCamNote');
    return [
      'mCam=' + (v.activeCamera || '-'),
      'mSeg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'mSegState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'mRec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'mTake=' + (v.takeNumber == null ? '-' : v.takeNumber),
      'mUpdatedAt=' + (v.updatedAtMs || 0),
      'mAtMs=' + (v.atMs || 0),
      'mSeen=' + (v.deviceId ? '1' : '0'),
      'ldCamState=' + (st ? st.textContent : '-'),
      'ldCamNote=' + (nt ? nt.textContent : '-')
    ].join('|');
  })()" | strip
}

# =============================================================================
echo "== 0. preparation =="
HEAD_SHA=$(cd "$ROOT" && git rev-parse --short HEAD)
echo "  HEAD  = $HEAD_SHA $(cd "$ROOT" && git log -1 --pretty=%s)"
APK="$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
APK_SHA=$(shasum -a 256 "$APK" | awk '{print $1}')
echo "  APK   = sha256 $APK_SHA ($(stat -f %z "$APK") octets)"
echo "$HEAD_SHA $APK_SHA" > "$OUT/logs/$TAG-apk.txt"

# REMISE À ZÉRO : le Take laisse `phase=REC` (Master) / `STOPPED` (Capture)
# jusqu'à une nouvelle session — c'est le comportement de référence (J09-08e
# s'arrête aussi en STOP local). Un run précédent laisserait donc un état qui
# bloque l'ARM du suivant. On relance proprement, puis on ATTEND le boot
# plutôt que de dormir au jugé.
for s in $A $B; do
  adb -s "$s" shell am force-stop $APP >/dev/null 2>&1
done
sleep 3
for s in $A $B; do
  adb -s "$s" shell monkey -p $APP -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
done
BOOT_OK=0
for s in $A $B; do
  OK_HERE=0
  for i in $(seq 1 40); do
    READY=$(node "$CDP" "$s" eval 'JSON.stringify({boot:(typeof MultiCamNav!=="undefined"&&typeof MultiCamStartService!=="undefined"),phase:(typeof MultiCamStartService!=="undefined"?MultiCamStartService.phase():"?"),ready:document.readyState})' 2>/dev/null | strip)
    case "$READY" in
      *'"boot":true'*'"phase":"IDLE"'*) OK_HERE=1; echo "  $s boot=$i $READY"; break ;;
    esac
    sleep 2
  done
  BOOT_OK=$((BOOT_OK + OK_HERE))
done
[ "$BOOT_OK" = "2" ] || { echo "FATAL: boot non obtenu sur les 2 devices ($BOOT_OK/2)"; exit 1; }

# Deux noms distincts : sans eux, la modal Master affiche « Cam 07 » pour les
# deux devices et la preuve à l'œil devient illisible.
ev "$A" "MultiCamConfig.setDeviceName('Cam 05'); 'NOMOK'" >/dev/null
ev "$B" "MultiCamConfig.setDeviceName('Cam 07'); 'NOMOK'" >/dev/null
sleep 1

BDID=$(ev "$B" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
ADID=$(ev "$A" "MultiCamCameraSwitchService.view().deviceId" | tr -d '"')
[ -n "$BDID" ] && [ -n "$ADID" ] || { echo "FATAL: deviceId introuvable"; exit 1; }
BSKILLS=$(ev "$B" "JSON.stringify((MultiCamConfig.get()||{}).enabledSkills||[])" | sed 's/^"//; s/"$//; s/\\//g')
ASKILLS=$(ev "$A" "JSON.stringify((MultiCamConfig.get()||{}).enabledSkills||[])" | sed 's/^"//; s/"$//; s/\\//g')
echo "  A(master)=$ADID name=$(ev "$A" "MultiCamConfig.get().deviceName" | tr -d '"') skills=$ASKILLS"
echo "  B(capture)=$BDID name=$(ev "$B" "MultiCamConfig.get().deviceName" | tr -d '"') skills=$BSKILLS"

# Tampon logcat : on agrandit et on vide AVANT le run. Le run 1 a perdu les
# journaux du REC (tampon purgé puis rempli par la suite) — une preuve qui
# disparaît ne prouve rien.
for s in $A $B; do
  adb -s "$s" logcat -G 4M >/dev/null 2>&1 || true
  adb -s "$s" logcat -c >/dev/null 2>&1 || true
done

# PREFLIGHT — le run 1 a été INVALIDÉ par l'environnement : RECORD_AUDIO non
# accordé → le dialogue système recouvrait la Capture → app en arrière-plan →
# le recorder natif n'a jamais démarré (NPE sur MediaRecorder.stop) → aucun
# segment ouvert → aucun camera_state. On refuse désormais de produire une
# preuve dans un état dont on sait qu'il fausse la mesure.
for s in $A $B; do
  P=$(adb -s "$s" shell dumpsys package $APP 2>/dev/null \
      | grep -E "android.permission.(CAMERA|RECORD_AUDIO):" \
      | tr -d '\r' | grep -c "granted=true")
  F=$(adb -s "$s" shell dumpsys window 2>/dev/null | grep mCurrentFocus | tr -d '\r')
  chk "preflight[$s] CAMERA+RECORD_AUDIO accordees" "$(( 2 - P ))" "accordees=$P/2"
  case "$F" in
    *fr.emmanuel.multicam*MainActivity*) chk "preflight[$s] app au premier plan" 0 "focus=MultiCam" ;;
    *) chk "preflight[$s] app au premier plan" 1 "$F" ;;
  esac
  FB=$(ev "$s" "(function(){
    var pv = MultiCamPreviewService.view() || {};
    return JSON.stringify({ fg: pv.foreground === true, act: pv.active === true,
      phase: MultiCamStartService.phase(), sid: MultiCamCameraSwitchService.view().sessionId });
  })()" | strip)
  case "$FB" in
    *'"fg":true'*) chk "preflight[$s] capture au premier plan" 0 "$FB" ;;
    *) chk "preflight[$s] capture au premier plan" 1 "$FB" ;;
  esac
  case "$FB" in
    *'"act":true'*) chk "preflight[$s] preview camera ouverte" 0 "$FB" ;;
    *) chk "preflight[$s] preview camera ouverte" 1 "$FB" ;;
  esac
  case "$FB" in
    *'"phase":"IDLE"'*) chk "preflight[$s] aucun Take residuel" 0 "IDLE" ;;
    *) chk "preflight[$s] aucun Take residuel" 1 "$FB" ;;
  esac
done
if [ "$FAILN" -gt 0 ]; then
  echo "  ENVIRONNEMENT NON SAISISSABLE ($FAILN echech(s)) — aucune preuve n'est produite."
  exit 1
fi
dump "$A" "JSON.stringify({role:'master',deviceId:MultiCamConfig.get().deviceId,deviceName:MultiCamConfig.get().deviceName,skills:MultiCamConfig.get().enabledSkills})" "00-A-boot.json"
dump "$B" "JSON.stringify({role:'capture',deviceId:MultiCamConfig.get().deviceId,deviceName:MultiCamConfig.get().deviceName,skills:MultiCamConfig.get().enabledSkills})" "00-B-boot.json"

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

mark "3. le Master ADMET B comme Capture"
dump "$A" "(async function(){
  var s = await MultiCamSessionStore.get('$SID');
  var ann = (s.masters || []).filter(function (m) { return m.deviceId === '$BDID'; })[0];
  if (!ann) return 'NO_ANNOUNCER';
  try {
    await MultiCamSessionWs.addMember(s, {
      deviceId: '$BDID', deviceName: ann.deviceName || 'Cam 07',
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
dump "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return JSON.stringify({sid:s.sessionId,masters:(s.masters||[]).map(function(m){return m.deviceId}),members:(s.members||[]).map(function(m){return {d:m.deviceId,r:m.sessionRoles}})});})()" "03-A-members.json"
TOPO=$(ev "$A" "(async function(){
  var s = await MultiCamSessionStore.get('$SID');
  var mem = s.members || [];
  var caps = mem.filter(function (x) { return (x.sessionRoles || []).indexOf('capture') >= 0; });
  var aInMembers = mem.some(function (x) { return x.deviceId === '$ADID'; });
  return JSON.stringify({ members: mem.length,
    memberRoles: mem.map(function (x) { return x.deviceId.slice(0, 8) + '=' + (x.sessionRoles || []).join('+'); }),
    captures: caps.length, captureDids: caps.map(function (x) { return x.deviceId; }),
    aIsMember: aInMembers,
    masterRoster: (s.masters || []).map(function (m) { return m.deviceId; }) });
})()" | strip)
echo "  topologie : $TOPO"
# Les RÔLES sont dans `members` : « 1 Master + 1 Capture » se lit là. Le roster
# `session.masters` n'est PAS une liste de rôles : tout joiner y est upserté
# (`session-ws.js:1306`), et la campagne de référence J09-08e y avait
# exactement 2 entrées. On le consigne en OBS, on n'en fait pas un contrôle.
case "$TOPO" in
  *'"members":1'*) chk "Topologie : exactement UN membre (A est Master, sans rôle)" 0 "$TOPO" ;;
  *) chk "Topologie : exactement UN membre (A est Master, sans rôle)" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"captures":1'*) chk "Topologie : exactement UNE Capture" 0 "$TOPO" ;;
  *) chk "Topologie : exactement UNE Capture" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"captureDids":["'"$BDID"'"'*) chk "Topologie : la Capture est B" 0 "$BDID" ;;
  *) chk "Topologie : la Capture est B" 1 "B=$BDID observe dans [$TOPO]" ;;
esac
case "$TOPO" in
  *'"aIsMember":false'*) chk "Topologie : A n'a aucun rôle de membre (Master pur)" 0 "A hors members" ;;
  *) chk "Topologie : A n'a aucun rôle de membre (Master pur)" 1 "$TOPO" ;;
esac
obs "roster session.masters (pairs connus, pas des rôles)" "$TOPO"

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
dump "$A" "(function(){var c=[].slice.call(document.querySelectorAll('#panel-take .capture-switch'));return JSON.stringify({captures:c.length,checked:c.filter(function(x){return x.checked;}).length,devices:c.map(function(x){return x.getAttribute('data-device');})});})()" "04-A-take-cases.json"
shot "$A" "$TAG-01-master-take.png"
ev "$A" "document.getElementById('tkArm').click(); 'ARMED'" >/dev/null
sleep 5
# Le mission impose 1 Master + 1 Capture : on prouve le décompte, on ne le
# suppose pas. La topologie vient de la session ; le décompte de sélection
# vient du panneau Take.
ARMD=$(ev "$A" "(function(){
  var v = MultiCamArmService.view() || {};
  var caps = (v.devices || []).filter(function (d) {
    return (d.skills || []).some(function (x) { return x.skill === 'capture'; });
  });
  var rows = [].slice.call(document.querySelectorAll('#panel-take .capture-switch'));
  return JSON.stringify({ armDevices: (v.devices || []).length, armCaptures: caps.length,
    armCaptureDids: caps.map(function (d) { return d.did; }),
    selCaptures: rows.length,
    selCaptureDids: rows.filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-device'); }),
    recEligible: v.recEligible });
})()" | strip)
echo "  armee : $ARMD"
dump "$A" "JSON.stringify(MultiCamArmService.view())" "04-A-arm-view.json"
case "$ARMD" in
  *'"selCaptures":1'*) chk "Take : UNE seule Capture proposee" 0 "$ARMD" ;;
  *) chk "Take : UNE seule Capture proposee" 1 "$ARMD" ;;
esac
case "$ARMD" in
  *'"selCaptureDids":["'"$BDID"'"'*) chk "Take : la Capture proposee est B" 0 "$BDID" ;;
  *) chk "Take : la Capture proposee est B" 1 "B=$BDID observe dans [$ARMD]" ;;
esac
case "$ARMD" in
  *'"recEligible":true'*) chk "Take : REC eligible apres ARM" 0 "recEligible=true" ;;
  *) chk "Take : REC eligible apres ARM" 1 "$ARMD" ;;
esac

# On purge le logcat juste AVANT le REC : la première ligne CAMERA_STATE_TX du
# tampon sera donc celle de l'ouverture du segment 1.
adb -s "$A" logcat -c 2>/dev/null; adb -s "$B" logcat -c 2>/dev/null
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
# L'horloge de RÉFÉRENCE est celle du Master : mesurer sur le Mac puis comparer
# à Date.now() d'Android mélangerait deux horloges et fausserait le délai.
T_REC=$(ev "$A" "Date.now()" | tr -d '"')
echo "  tRec (horloge A) = $T_REC"

mark "5. CONVERGENCE MASTER — le segment 1 arrive-t-il SANS bascule ?"
ARR_TRACE="$OUT/logs/$TAG-arrivee-master.txt"
: > "$ARR_TRACE"
ARR_VAL=""; ARR_MS=""; T_ARR=""
for i in $(seq 1 80); do
  PA=$(probe_msr "$A")
  MS=$(field "$PA" mSeg)
  T_A=$(ev "$A" "Date.now()" | tr -d '"')
  printf '%s mSeg=%s mSegState=%s mRec=%s mCam=%s mSeen=%s\n' \
    "$T_A" "$MS" "$(field "$PA" mSegState)" "$(field "$PA" mRec)" \
    "$(field "$PA" mCam)" "$(field "$PA" mSeen)" >> "$ARR_TRACE"
  if [ "$MS" = "1" ]; then
    ARR_VAL="$PA"
    T_ARR="$T_A"
    ARR_MS=$(( T_A - T_REC ))
    break
  fi
  sleep 0.5
done
if [ -n "$ARR_VAL" ]; then
  echo "  segment 1 recu par le Master (borne haute +${ARR_MS} ms, horloge A) : $ARR_VAL"
else
  echo "  AUCUN segment 1 recu par le Master en 40 s"
fi
sed 's/^/    /' "$ARR_TRACE" | head -8

# =============================================================================
mark "6. CAPTURE — les faits publies au moment du segment 1"
sleep 2
CB=$(probe_cap "$B")
echo "  B: $CB"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "10-B-view-seg1.json"
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording()})" "10-B-rec-seg1.json"

eq  "Capture  segmentIndex == 1"          "1"        "$(field "$CB" seg)"
eq  "Capture  segmentState == recording"  "recording" "$(field "$CB" segState)"
eq  "Capture  recording == true"          "true"     "$(field "$CB" rec)"
hasnt "Capture  activeCamera confirmee (non vide)" "-"  "$(field "$CB" cam)"
eq  "Capture  rattachee a un Take (pas de pseudo-session)" "0" \
    "$(python3 -c "import sys; v='$(field "$CB" take)'; print(0 if v.isdigit() and int(v) >= 1 else 1)")"

# =============================================================================
mark "7. MASTER — reception + UI de la modal"
ev "$A" "(function(){
  var slots = (MultiCamLiveModel.view().slots || []).map(function (s) { return s.deviceId; });
  if (slots.indexOf('$BDID') < 0) { MultiCamNav.show('live', { sid: '$SID' }); return 'NAV_LIVE'; }
  return 'SLOT_OK';
})()" >/dev/null
sleep 3
ev "$A" "MultiCamLiveDetail.open('$BDID'); 'MODAL_OPEN'" >/dev/null
sleep 2
ev "$A" "MultiCamLiveDetail.refresh(); 'REFRESH'" >/dev/null
sleep 1
DUMP_VIEW=$(ev "$A" "(function(){
  var slot = (MultiCamLiveModel.view().slots || []).filter(function (x) { return x.deviceId === '$BDID'; })[0] || null;
  return JSON.stringify({ slot: !!slot, open: !!MultiCamLiveDetail.isOpen(), text: (document.getElementById('ldCamState')||{}).textContent });
})()" | strip)
echo "  modal A : $DUMP_VIEW"
case "$DUMP_VIEW" in
  *'"open":true'*) : ;;
  *) echo "  la modal ne s'est pas ouverte"; ;;
esac
MA=$(probe_msr "$A")
echo "  A: $MA"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$BDID','$SID')||null)" "11-A-inbox-seg1.json"
dump "$A" "(function(){var s=MultiCamLiveModel.view().slots.filter(function(x){return x.deviceId==='$BDID';})[0]||{};return JSON.stringify(MultiCamLiveDetail.detailOf(s,{nowMs:Date.now()}));})()" "12-A-detail-seg1.json"
shot "$A" "$TAG-02-master-modal-seg1.png"

eq  "Master  camera_state recu (inbox alimentee)" "1" "$(field "$MA" mSeen)"
eq  "Master  segmentIndex recu == 1"      "1"        "$(field "$MA" mSeg)"
eq  "Master  segmentState recu"           "recording" "$(field "$MA" mSegState)"
eq  "Master  recording recu == true"      "true"     "$(field "$MA" mRec)"
eq  "Master  meme activeCamera que B"     "$(field "$CB" cam)" "$(field "$MA" mCam)"
eq  "Master  take rattache au meme Take"  "$(field "$CB" take)" "$(field "$MA" mTake)"
MAT=$(field "$MA" mAtMs)
if [ -n "$MAT" ] && [ "$MAT" -gt 0 ] 2>/dev/null; then
  chk "Master  le paquet porte une mesure de la Capture (atMs>0)" 0 "atMs=$MAT"
else
  chk "Master  le paquet porte une mesure de la Capture (atMs>0)" 1 "atMs=[$MAT]"
fi
if [ -n "$ARR_MS" ] && [ "$ARR_MS" -ge 0 ] 2>/dev/null; then
  chk "Master  segment 1 observe PENDANT le REC (horloge A)" 0     "tArr-tRec=+${ARR_MS} ms (borne haute, horloge Master)"
else
  chk "Master  segment 1 observe PENDANT le REC (horloge A)" 1 "ARR_MS=[$ARR_MS]"
fi

# ---- UI Master : la Capture n'est plus « Caméra inconnue »
hasnt "UI Master  plus « Caméra inconnue »" "Caméra inconnue" "$(field "$MA" ldCamState)"
has "UI Master  camera active visible avant toute bascule" "$(label_for "$(field "$CB" cam)")" "$(field "$MA" ldCamState)"
has "UI Master  segment 1 visible"        "segment 1"  "$(field "$MA" ldCamState)"
has "UI Master  etat enregistrement visible" "enregistrement" "$(field "$MA" ldCamState)"
echo "  modal A = [$(field "$MA" ldCamState)]  note = [$(field "$MA" ldCamNote)]"
printf '  MESURE delai reception segment 1 (Master) : %s ms\n' "${ARR_MS:-?}" >> "$MESURES"

# =============================================================================
mark "8. CAMERA_STATE_TX — la preuve d'emission (masters=1)"
logs_capture rec
console_raw "$B" rec
console_raw "$A" rec
TXN=$(grep -c "CAMERA_STATE_TX" "$OUT/logs/$TAG-$B-capture-rec.log" 2>/dev/null | tr -d ' ')
TX1=$(grep -o "CAMERA_STATE_TX[^\"]*" "$OUT/logs/$TAG-$B-capture-rec.log" 2>/dev/null | head -1)
echo "  emissions CAMERA_STATE_TX : ${TXN:-0}"
echo "  1re ligne : ${TX1:-ABSENTE}"
if [ "${TXN:-0}" -gt 0 ] 2>/dev/null; then
  chk "Capture  CAMERA_STATE_TX emis au segment 1" 0 "$TXN emission(s)"
  has "Capture  la 1re emission porte masters=1" "masters=1" "$TX1"
  hasnt "Capture  aucun masters=0 (le defaut gele par 060fd88)" "masters=0" "$TX1"
  has "Capture  la 1re emission porte activeCamera=$(field "$CB" cam)" "activeCamera=$(field "$CB" cam)" "$TX1"
else
  chk "Capture  CAMERA_STATE_TX emis au segment 1" 1 "aucune ligne CAMERA_STATE_TX"
fi
SEG1=$(grep -o "CAMERA_SEGMENT_OPEN segmentIndex=1[^\"]*" "$OUT/logs/$TAG-$B-capture-rec.log" 2>/dev/null | head -1)
if [ -n "$SEG1" ]; then chk "Capture  segment 1 ouvert (CAMERA_SEGMENT_OPEN)" 0 "$SEG1"; else chk "Capture  segment 1 ouvert (CAMERA_SEGMENT_OPEN)" 1 "absent"; fi

logs_master rec
if grep -qE "CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP" "$OUT/logs/$TAG-$A-master-rec.log" 2>/dev/null; then
  chk "Master  aucun camera_state rejete" 1 \
    "$(grep -hoE '(CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP)[^"]*' "$OUT/logs/$TAG-$A-master-rec.log" | head -3 | tr '\n' ' ')"
else
  chk "Master  aucun camera_state rejete" 0 "ni CAMERA_STATE_DROP ni CAMERA_TRANSPORT_DROP"
fi
RECN=$(grep -c "CAMERA_REC_OK" "$OUT/logs/$TAG-$B-capture-rec.log" 2>/dev/null | tr -d ' ')
if [ "${RECN:-0}" -gt 0 ] 2>/dev/null; then
  chk "Capture  recorder natif demarre (CAMERA_REC_OK)" 0 "$RECN occurrence(s)"
else
  chk "Capture  recorder natif demarre (CAMERA_REC_OK)" 1 "absent : le recorder natif n'a jamais tourne"
fi

# =============================================================================
mark "9. STOP propre sur B"
ev "$B" "(function(){var b = document.getElementById('cdEmergency'); if (b) b.click(); return 'STOP_DIALOG';})()" >/dev/null
sleep 2
ev "$B" "(function(){var b = document.getElementById('cdStopConfirm'); if (b) b.click(); return 'STOP_SENT';})()" >/dev/null
sleep 9
ev "$A" "MultiCamLiveDetail.open('$BDID'); MultiCamLiveDetail.refresh(); 'R'" >/dev/null
sleep 2
CB2=$(probe_cap "$B"); MA2=$(probe_msr "$A")
echo "  B apres STOP : $CB2"
echo "  A apres STOP : $MA2"
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),view:MultiCamCameraSwitchService.view()})" "30-B-after-stop.json"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$BDID','$SID')||null)" "31-A-inbox-after-stop.json"
shot "$A" "$TAG-03-master-modal-stop.png"

eq "STOP Capture recording == false"        "false" "$(field "$CB2" rec)"
eq "STOP Capture segmentIndex == 0"         "0"     "$(field "$CB2" seg)"
eq "STOP Capture segmentState vide"         ""      "$(field "$CB2" segState)"
eq "STOP Master segmentIndex recu == 0"     "0"     "$(field "$MA2" mSeg)"
eq "STOP Master recording recu == false"    "false" "$(field "$MA2" mRec)"
has "STOP Master modal « aucun segment actif »" "aucun segment actif" "$(field "$MA2" ldCamState)"
hasnt "STOP Master pas de « segment 0 »"    "segment 0" "$(field "$MA2" ldCamState)"
ev "$A" "MultiCamLiveDetail.close(); 'C'" >/dev/null
logs_capture stop
logs_master stop
console_raw "$B" stop
console_raw "$A" stop

# =============================================================================
mark "10. VALIDATION LOGIQUE"
PROD=$(cd "$ROOT" && git status --short | grep -vE '^\?\? tests/e2e/validation/J09-rec-previews/' | tr -d ' ')
if [ -z "$PROD" ]; then
  obs "aucun fichier HORS preuves modifie pendant le run (code produit intact)"
else
  chk "aucun fichier hors preuves modifie pendant le run" 1 "$PROD"
fi

mark "11. SYNTHESE"
echo "  controles non conformes : $FAILN"
echo "  liste complete          : $CHECKS"
[ -s "$MESURES" ] && { echo "  mesures :"; sed 's/^/    /' "$MESURES"; }
if [ "$FAILN" -gt 0 ]; then
  echo "  RESULTAT : NON CONFORME ($FAILN) — NE PAS corriger ici, rapporter."
  exit 1
fi
echo "  RESULTAT : CONFORME"
