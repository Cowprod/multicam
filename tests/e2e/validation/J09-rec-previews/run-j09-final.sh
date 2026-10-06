#!/usr/bin/env bash
# Campagne FINALE J09 — REC multicam + previews Master, sur 4 devices réels.
#
# Le run valide le jalon J09 dans son ensemble, avec la topologie attendue :
#   A = Master pur (invite les 3 autres depuis l'écran 03)
#   B, C = Captures (enregistrent réellement)
#   D = Storage (zone Stockage sous la mosaïque)
#
# Aucun développement produit : le script pilote l'UI réelle (CDP) et les
# commandes Android de diagnostic. Aucun MP4 n'est écrit dans le dépôt
# (les médias sont tirés dans $TMPDIR puis mesurés : ffprobe + SHA-256).
#
# Usage : tests/e2e/validation/J09-rec-previews/run-j09-final.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="$HERE"
CDP="$ROOT/tests/e2e/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91          # Master  « Cam 05 »
B=61d54bba7d91          # Capture « Cam 07 »
C=c0d8514d7d87          # Capture « Cam 09 »
D=R83Y106V1HF           # Storage « Cam D4 »
ALLDEVS="$A $B $C $D"

TAG="J09final-$(date +%H%M%S)"
mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps"

FAILN=0
CHECKS="$OUT/logs/$TAG-checks.txt"
MESURES="$OUT/logs/$TAG-mesures.txt"
VIDDIR="${TMPDIR:-/tmp}/j09-final-videos"
mkdir -p "$VIDDIR"
: > "$CHECKS"; : > "$MESURES"

SID=""
# DIDs remplis au preflight (source : MultiCamConfig des devices eux-mêmes).
DID_A=""; DID_B=""; DID_C=""; DID_D=""

# ---------------------------------------------------------------- utilitaires
ev() { node "$CDP" "$1" eval "$2"; }

strip() { sed 's/^"//; s/"$//; s/\\"/"/g; s/\\n/ /g'; }

# Valeurs textuelles avec espaces : séparateur `|`, champ lu au PREMIER `=`.
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

console_raw() {
  adb -s "$1" logcat -d -v time 2>/dev/null | grep "CONSOLE" \
    > "$OUT/logs/$TAG-$1-$2-console.log"
}

# Logs ciblés d'une Capture (émission) — `logs_cap <serial> <suffixe>`.
logs_cap() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_STATE_TX|CAMERA_STATE_NOT_PUBLISHED|CAMERA_SEGMENT_|CAMERA_REC_|CAMERA_PREVIEW_|PREVIEW_FRAME_|PIXELCOPY|START_PLAN|START_LOCAL|START_NATIVE_ACK|START_MASTER_LOST|START_STOP_LOCAL|CLOCK_SYNC|SCREEN08" \
    > "$OUT/logs/$TAG-$1-cap-$2.log"
  echo "  log Capture $1[$2] ($(wc -l < "$OUT/logs/$TAG-$1-cap-$2.log" | tr -d ' ') lignes)"
}

# Logs ciblés du Master (réception + supervision).
logs_msr() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA_STATE_DROP|CAMERA_TRANSPORT_DROP|CAMERA_STATE_TX|PREVIEW_FRAME_|PREVIEW_FRAME_RX|WS_|SESSION_|MEMBER_|INVITE_|START_|TAKE_|ARM_|LIVE_|SCREEN03|SCREEN05|SCREEN08" \
    > "$OUT/logs/$TAG-$1-msr-$2.log"
  echo "  log Master [$2] ($(wc -l < "$OUT/logs/$TAG-$1-msr-$2.log" | tr -d ' ') lignes)"
}

# Logs d'un device (tous rôles) — utilisé pour D et pour les cycles réseau.
logs_any() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "WS_|MEMBER_|INVITE_|PREVIEW_|CAMERA_|START_|SCREEN0|MDNS_" \
    > "$OUT/logs/$TAG-$1-any-$2.log"
  echo "  log $1[$2] ($(wc -l < "$OUT/logs/$TAG-$1-any-$2.log" | tr -d ' ') lignes)"
}

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

# ------------------------------------------------------------------- sondes

# État PUBLIÉ par une Capture (ce qui part vers le Master) + zones UI locales.
probe_cap() {
  ev "$1" "(function(){
    var v = MultiCamCameraSwitchService.view();
    var l = document.getElementById('cdRecCamLabel');
    var g = document.getElementById('cdRecSeg');
    var st = MultiCamStartService.view();
    return [
      'cam=' + (v.activeCamera || '-'),
      'seg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'segState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'rec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'sid=' + (v.sessionId || '-'),
      'take=' + (v.takeNumber == null ? '-' : v.takeNumber),
      'phase=' + MultiCamStartService.phase(),
      'emg=' + (st && st.showEmergencyStop === true ? '1' : '0'),
      'cdRecCam=' + (l ? l.textContent : '-'),
      'cdRecSeg=' + (g ? g.textContent : '-')
    ].join('|');
  })()" | strip
}

# État REÇU par le Master pour une Capture donnée (inbox).
probe_msr() {
  ev "$1" "(function(){
    var v = MultiCamCameraStateInbox.forDevice('$2', '$SID') || {};
    return [
      'mCam=' + (v.activeCamera || '-'),
      'mSeg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'mSegState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'mRec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'mTake=' + (v.takeNumber == null ? '-' : v.takeNumber),
      'mUpdatedAt=' + (v.updatedAtMs || 0),
      'mSeen=' + (v.deviceId ? '1' : '0')
    ].join('|');
  })()" | strip
}

# Vignette mosaïque côté Master (J09 : grille stable, image figée, reprise).
# `grid` = vignettes DOM réellement peintes ; `ui`/`uilab` = état projeté dans
# le DOM (`.tile-state`), distinct de `disp` (modèle).
probe_slot() {
  ev "$1" "(function(){
    var v = null;
    try { v = MultiCamLiveModel.view(); } catch (e) { v = null; }
    var slots = (v && v.slots) || [];
    var s = slots.filter(function (x) { return x.deviceId === '$2'; })[0] || null;
    var cards = document.querySelectorAll('#liveGrid [data-device-id]');
    var tile = document.querySelector('#liveGrid [data-device-id=\"$2\"]');
    var st = tile ? tile.querySelector('.tile-state') : null;
    return [
      'slots=' + slots.length,
      'order=' + JSON.stringify((v && v.order) || []).replace(/[\\[\\]\"]+/g, ''),
      'grid=' + cards.length,
      'present=' + (s ? '1' : '0'),
      'conn=' + (s ? (s.connected === true ? '1' : '0') : '-'),
      'frame=' + (s ? (s.hasFrame ? '1' : '0') : '-'),
      'seq=' + (s ? (s.lastFrameSeq || 0) : '-'),
      'disp=' + (s ? String(s.displayState || '') : '-'),
      'status=' + (s ? String(s.status || '') : '-'),
      'ui=' + (st ? String(st.dataset.state || '') : '-'),
      'uilab=' + (st ? String(st.textContent || '').replace(/^\\s+|\\s+$/g, '').replace(/\\s+/g, ' ') : '-')
    ].join('|');
  })()" | strip
}

# Télémétrie de supervision (batterie/espace) vue par le Master.
# Entrée du store = { telemetry, atMs, local } : les mesures sont dans
# `entry.telemetry` (batteryLevel, freeBytes).
probe_telemetry() {
  ev "$1" "(function(){
    var t = (typeof MultiCamTelemetryStore !== 'undefined' && MultiCamTelemetryStore.all)
      ? MultiCamTelemetryStore.all('$SID') : {};
    var out = [];
    Object.keys(t).forEach(function (k) {
      var e = t[k] || {};
      var m = e.telemetry || {};
      out.push(k.slice(0, 8) + '=' + JSON.stringify({
        b: m.batteryLevel,
        f: (typeof m.freeBytes === 'number' ? Math.round(m.freeBytes / 1e6) : null),
        at: e.atMs || 0
      }).replace(/[\\{\\}\"]/g, ''));
    });
    return out.join('|');
  })()" | strip
}

wait_ip() { # $1=serial -> affiche l'IPv4 wlan0 (vide si absent)
  adb -s "$1" shell ip addr show wlan0 2>/dev/null \
    | awk '/inet /{split($2,a,"/"); print a[1]; exit}'
}

# =============================================================================
mark "0. environnement"
HEAD_SHA=$(cd "$ROOT" && git rev-parse --short HEAD)
echo "  HEAD  = $HEAD_SHA $(cd "$ROOT" && git log -1 --pretty=%s)"
APK="$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
APK_SHA=$(shasum -a 256 "$APK" | awk '{print $1}')
echo "  APK   = sha256 $APK_SHA ($(stat -f %z "$APK") octets)"
echo "$HEAD_SHA $APK_SHA" > "$OUT/apk-sha256.txt"

adb devices -l | grep -v "^List" > "$OUT/adb-devices.txt" 2>/dev/null || true
{
  echo "# J09 — appareils de la campagne finale"
  echo "# source : adb devices -l + MultiCamConfig relevé au preflight ($TAG)"
  echo "#"
  echo "# role      serial           deviceId                            ip"
} >> "$OUT/adb-devices.txt"

# REMISE À ZÉRO : le Take laisse phase=REC/STOPPED ; un run précédent bloquerait
# l'ARM suivant. On relance proprement les 4 devices puis on ATTEND le boot.
for s in $ALLDEVS; do
  adb -s "$s" shell am force-stop $APP >/dev/null 2>&1
done
sleep 3
# Cache vidé pendant que les apps sont arrêtées : toute preuve vidéo du run
# provient forcément de CE run (pas d'un artefact des campagnes précédentes).
for s in $ALLDEVS; do
  adb -s "$s" shell "run-as $APP sh -c 'rm -f cache/videoTmp*.mp4'" >/dev/null 2>&1 || true
  LEFT=$(adb -s "$s" shell run-as $APP ls cache/ 2>/dev/null | tr -d '\r' | grep -c '\.mp4$')
  echo "  cache $s : purge videoTmp* -> ${LEFT:-0} fichier(s) .mp4 restant(s)"
done
for s in $ALLDEVS; do
  adb -s "$s" shell monkey -p $APP -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
done
BOOT_OK=0
for s in $ALLDEVS; do
  OK_HERE=0
  for i in $(seq 1 40); do
    READY=$(node "$CDP" "$s" eval 'JSON.stringify({boot:(typeof MultiCamNav!=="undefined"&&typeof MultiCamStartService!=="undefined"),phase:(typeof MultiCamStartService!=="undefined"?MultiCamStartService.phase():"?")})' 2>/dev/null | strip)
    case "$READY" in
      *'"boot":true'*'"phase":"IDLE"'*) OK_HERE=1; echo "  $s boot=$i $READY"; break ;;
    esac
    sleep 2
  done
  BOOT_OK=$((BOOT_OK + OK_HERE))
done
[ "$BOOT_OK" = "4" ] || { echo "FATAL: boot non obtenu sur les 4 devices ($BOOT_OK/4)"; exit 1; }

# Noms distincts (sans eux la modal Master affiche deux fois le même libellé).
ev "$A" "MultiCamConfig.setDeviceName('Cam 05'); 'OK'" >/dev/null
ev "$B" "MultiCamConfig.setDeviceName('Cam 07'); 'OK'" >/dev/null
ev "$C" "MultiCamConfig.setDeviceName('Cam 09'); 'OK'" >/dev/null
ev "$D" "MultiCamConfig.setDeviceName('Cam D4'); 'OK'" >/dev/null
sleep 1
# Ré-annonce pour que les pairs voient le nom fraîchement publié.
for s in $ALLDEVS; do ev "$s" "MultiCamDiscovery.reannounce ? MultiCamDiscovery.reannounce() : null; 'REANN'" >/dev/null; done
sleep 3

DID_A=$(ev "$A" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_B=$(ev "$B" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_C=$(ev "$C" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_D=$(ev "$D" "MultiCamConfig.get().deviceId" | tr -d '"')
[ -n "$DID_A" ] && [ -n "$DID_B" ] && [ -n "$DID_C" ] && [ -n "$DID_D" ] \
  || { echo "FATAL: deviceId introuvable"; exit 1; }
echo "  A=$DID_A  B=$DID_B"
echo "  C=$DID_C  D=$DID_D"

{
  echo "# master   $A     $DID_A   $(wait_ip $A)"
  echo "# capture  $B     $DID_B   $(wait_ip $B)"
  echo "# capture  $C     $DID_C   $(wait_ip $C)"
  echo "# storage  $D     $DID_D   $(wait_ip $D)"
} >> "$OUT/adb-devices.txt"

# Tampon logcat : 4 Mo puis purge AVANT le run (les journaux du REC doivent
# survivre au run, pas être purgés en cours de route).
for s in $ALLDEVS; do
  adb -s "$s" logcat -G 4M >/dev/null 2>&1 || true
  adb -s "$s" logcat -c >/dev/null 2>&1 || true
done

# Attente de l'ANNONCE mDNS et de l'endpoint WS local (`selfEndpoint`) sur les
# 4 devices : l'un et l'autre mettent quelques secondes après un redémarrage, et
# `selfEndpoint` vide = TXT `wsep` vide = rien à dialer pour le Master.
for s in $ALLDEVS; do
  READY_NET=0
  for i in $(seq 1 30); do
    NET=$(ev "$s" "JSON.stringify({a:MultiCamDiscovery.status().advertising===true,e:String((MultiCamSessionWs.status()||{}).selfEndpoint||'')})" | strip)
    case "$NET" in
      *'"a":true'*'"e":""'*) : ;;                       # annonce OK, endpoint encore vide
      *'"a":true'*'"e":"'*) READY_NET=1; break ;;       # les deux sont là
      *) : ;;
    esac
    ev "$s" "MultiCamDiscovery.reannounce ? MultiCamDiscovery.reannounce() : null; 'R'" >/dev/null
    sleep 2
  done
  echo "  $s reseau apres $((i * 2)) s : $NET"
  [ "$READY_NET" = "1" ] || chk "preflight[$s] annonce mDNS + endpoint WS local" 1 "${NET:-indisponible}"
  [ "$READY_NET" = "1" ] && chk "preflight[$s] annonce mDNS + endpoint WS local" 0 "$NET"
done

# PREFLIGHT — un état qui fausse la mesure invalide la preuve.
for s in $ALLDEVS; do
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
      phase: MultiCamStartService.phase() });
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
  IP=$(wait_ip "$s")
  [ -n "$IP" ] && chk "preflight[$s] IPv4 wifi" 0 "$IP" || chk "preflight[$s] IPv4 wifi" 1 "absente"
  DISC=$(ev "$s" "JSON.stringify(MultiCamDiscovery.status())" | strip)
  case "$DISC" in
    *'"advertising":true'*) chk "preflight[$s] annonce mDNS" 0 "$DISC" ;;
    *) chk "preflight[$s] annonce mDNS" 1 "$DISC" ;;
  esac
  DF=$(adb -s "$s" shell df -h /data 2>/dev/null | tail -1 | tr -s ' ')
  obs "preflight[$s] espace /data" "$DF"
done
# L'espace des deux Captures est un prérequis de la preuve « fichiers produits ».
for s in $B $C; do
  FREE_KO=$(adb -s "$s" shell df -k /data 2>/dev/null | tail -1 | awk '{print ($4 < 3000000) ? 1 : 0}')
  chk "preflight[$s] >= 3 Go libres (MP4 possibles)" "$FREE_KO" "$(adb -s "$s" shell df -h /data 2>/dev/null | tail -1 | tr -s ' ')"
done
if [ "$FAILN" -gt 0 ]; then
  echo "  ENVIRONNEMENT NON SAISISSABLE ($FAILN echech(s)) — aucune preuve n'est produite."
  exit 1
fi

# Découverte croisée : le Master doit voir les 3 devices AVEC leur endpoint WS
# (TXT `wsep`) — sans lui, `inviteAddedDevice` n'a rien à dialer (§31.2).
sleep 5
PEERS=$(ev "$A" "JSON.stringify(MultiCamDiscovery.peers().map(function(p){return {d:p.deviceId.slice(0,8),n:p.deviceName,ep:p.wsEndpoint};}))" | strip)
echo "  peers vus par A : $PEERS"
for pair in "${DID_B:0:8}" "${DID_C:0:8}" "${DID_D:0:8}"; do
  case "$PEERS" in
    *'"d":"'"$pair"'"'*'"ep":""'*) chk "discovery A→$pair endpoint WS publie" 1 "$PEERS" ;;
    *'"d":"'"$pair"'"'*)          chk "discovery A→$pair endpoint WS publie" 0 "$PEERS" ;;
    *)                            chk "discovery A→$pair vu par le Master" 1 "$PEERS" ;;
  esac
done
for s in $B $C $D; do
  SE=$(ev "$s" "JSON.stringify(MultiCamDiscovery.peers().filter(function(p){return p.wsEndpoint;}).length)" | tr -d '"')
  chk "discovery $s voit des pairs avec endpoint" "$([ "$SE" -ge 1 ] 2>/dev/null && echo 0 || echo 1)" "pairsAvecEndpoint=$SE"
done
dump "$A" "JSON.stringify({peers:MultiCamDiscovery.peers().map(function(p){return {d:p.deviceId,n:p.deviceName,sk:p.enabledSkills,ep:p.endpoint,wsep:p.wsEndpoint};}),status:MultiCamDiscovery.status()})" "00-A-discovery.json"

mark "1. session creee sur A (Master) par l'UI reel"
SNAME="Regie $TAG"
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
dump "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return JSON.stringify({sessionId:s.sessionId,name:s.name,masters:s.masters,members:s.members});})()" "01-A-session.json"

# -----------------------------------------------------------------------------
mark "2. invitation des 3 devices par le CHEMIN UI REEL (ecran 03 → Ajouter)"
# Le flux PIN (« Rejoindre une session ») inscrit le joiner dans session.masters
# et fausserait `connectedMasters()` côté Capture : la campagne finale utilise
# donc le flux INVITE, celui de l'opérateur (décision 31.2).
invite_member() { # $1=serial  $2=role  $3=did  $4=label
  local X="$1" ROLE="$2" DID="$3" LBL="$4"
  adb -s "$X" logcat -c 2>/dev/null
  ev "$A" "MultiCamNav.show('session', { sid: '$SID' }); 'NAV'" >/dev/null
  sleep 2
  FOUND=0
  for i in $(seq 1 30); do
    R=$(ev "$A" "(function(){var b=document.querySelector('.member-add[data-device=\"$DID\"]');return b?'FOUND':'WAITING';})()" | strip)
    if [ "$R" = "FOUND" ]; then FOUND=1; break; fi
    sleep 2
  done
  if [ "$FOUND" = "1" ]; then
    ev "$A" "(function(){var b=document.querySelector('.member-add[data-device=\"$DID\"]'); if(b) b.click(); return 'MODAL';})()" >/dev/null
    sleep 2
    BOX=$(ev "$A" "(function(){var i=document.querySelector('#mmRoles input[data-role=\"$ROLE\"]'); if(i && !i.checked) i.click(); return i?'BOX':'NOBOX';})()" | strip)
    sleep 1
    SAVE=$(ev "$A" "(function(){var b=document.getElementById('mmSave'); if(b && !b.disabled) { b.click(); return 'SAVED'; } return b ? 'DISABLED' : 'NOBTN';})()" | strip)
    echo "  $LBL : add=$FOUND box=$BOX save=$SAVE"
  else
    echo "  $LBL : bouton Ajouter introuvable dans la liste LAN"
  fi
  # Le device invité rejoint : MEMBER_ADD_LOCAL côté A + INVITE_ACCEPTED côté X.
  JOINED=0
  for i in $(seq 1 30); do
    M=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=(s.members||[]).filter(function(x){return x.deviceId==='$DID';})[0];return m?(m.sessionRoles||[]).join('+'):'NONE';})()" | tr -d '"')
    if [ -n "$M" ] && [ "$M" != "NONE" ]; then JOINED=1; break; fi
    sleep 2
  done
  chk "invite[$LBL] devenu membre avec role $ROLE" "$([ "$JOINED" = "1" ] && echo 0 || echo 1)" "roles=[$M]"
  ACC=$(adb -s "$X" logcat -d -v time 2>/dev/null | grep -o "INVITE_ACCEPTED[^\"]*" | head -1)
  chk "invite[$LBL] INVITE_ACCEPTED recu par le device" "$([ -n "$ACC" ] && echo 0 || echo 1)" "${ACC:-ABSENT}"
  dump "$X" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify(s?{sid:s.sessionId,state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId;}),members:(s.members||[]).map(function(m){return {d:m.deviceId,r:m.sessionRoles};})}:{none:true});})()" "02-$LBL-joined.json"
}

ev "$A" "MultiCamNav.show('session', { sid: '$SID' }); 'NAV'" >/dev/null
sleep 2
shot "$A" "$TAG-01-session-lan.png"
invite_member "$B" "capture" "$DID_B" "B"
invite_member "$C" "capture" "$DID_C" "C"
invite_member "$D" "storage" "$DID_D" "D"
sleep 2
ev "$A" "MultiCamNav.show('session', { sid: '$SID' }); 'NAV'" >/dev/null
sleep 3
shot "$A" "$TAG-02-session-membres.png"

TOPO=$(ev "$A" "(async function(){
  var s = await MultiCamSessionStore.get('$SID');
  var mem = s.members || [];
  var caps = mem.filter(function (x) { return (x.sessionRoles || []).indexOf('capture') >= 0; });
  var sts = mem.filter(function (x) { return (x.sessionRoles || []).indexOf('storage') >= 0; });
  var aInMembers = mem.some(function (x) { return x.deviceId === '$DID_A'; });
  return JSON.stringify({ members: mem.length,
    memberRoles: mem.map(function (x) { return x.deviceId.slice(0, 8) + '=' + (x.sessionRoles || []).join('+'); }),
    captures: caps.length, captureDids: caps.map(function (x) { return x.deviceId; }),
    storages: sts.length, storageDids: sts.map(function (x) { return x.deviceId; }),
    aIsMember: aInMembers,
    masterRoster: (s.masters || []).map(function (m) { return m.deviceId; }) });
})()" | strip)
echo "  topologie : $TOPO"
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,masters:s.masters,members:s.members});})()" "03-A-members.json"

case "$TOPO" in
  *'"members":3'*) chk "Topologie : 3 membres admis (B, C, D)" 0 "$TOPO" ;;
  *) chk "Topologie : 3 membres admis (B, C, D)" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"captures":2'*) chk "Topologie : 2 Captures (B et C)" 0 "$TOPO" ;;
  *) chk "Topologie : 2 Captures (B et C)" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"storages":1'*) chk "Topologie : 1 Storage (D)" 0 "$TOPO" ;;
  *) chk "Topologie : 1 Storage (D)" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"aIsMember":false'*) chk "Topologie : A = Master pur (aucun role membre)" 0 "A hors members" ;;
  *) chk "Topologie : A = Master pur (aucun role membre)" 1 "$TOPO" ;;
esac
# POINT DE VIGILANCE J09 : le flux INVITE ne doit PAS inscrire les Captures dans
# session.masters (sinon start-service.isMasterRole() leur donnerait le rôle
# Master et connectedMasters() ne retomberait jamais à 0).
case "$TOPO" in
  *'"masterRoster":["'"$DID_A"'"'*) chk "Topologie : session.masters = [A] seulement" 0 "$TOPO" ;;
  *) chk "Topologie : session.masters = [A] seulement" 1 "$TOPO" ;;
esac
INV_SENT=$(adb -s "$A" logcat -d -v time 2>/dev/null | grep -c "INVITE_SENT")
chk "invite : 3 INVITE_SENT emis par A" "$([ "${INV_SENT:-0}" -ge 3 ] 2>/dev/null && echo 0 || echo 1)" "INVITE_SENT=$INV_SENT"
logs_msr "$A" invite
logs_any "$B" invite; logs_any "$C" invite; logs_any "$D" invite

# -----------------------------------------------------------------------------
mark "3. Take : 2 Captures + 1 Storage, ARM, puis REC"
ev "$A" "MultiCamNav.show('take', { sid: '$SID' }); 'NAV_TAKE'" >/dev/null
sleep 3
ev "$A" "document.getElementById('tkCaptureAll').click(); 'CAPALL'" >/dev/null
sleep 1
ev "$A" "document.getElementById('tkStorageAll').click(); 'STOALL'" >/dev/null
sleep 2
TAKEDUMP=$(ev "$A" "(function(){
  var c = [].slice.call(document.querySelectorAll('#panel-take .capture-switch'));
  var s = [].slice.call(document.querySelectorAll('#panel-take .storage-switch'));
  return JSON.stringify({ captures: c.length, capturesChecked: c.filter(function(x){return x.checked;}).length,
    captureDids: c.filter(function(x){return x.checked;}).map(function(x){return x.getAttribute('data-device');}),
    storages: s.length, storagesChecked: s.filter(function(x){return x.checked;}).length,
    storageDids: s.filter(function(x){return x.checked;}).map(function(x){return x.getAttribute('data-device');}) });
})()" | strip)
echo "  take : $TAKEDUMP"
dump "$A" "(function(){var c=[].slice.call(document.querySelectorAll('#panel-take .capture-switch'));var s=[].slice.call(document.querySelectorAll('#panel-take .storage-switch'));return JSON.stringify({captures:c.map(function(x){return {d:x.getAttribute('data-device'),on:x.checked};}),storages:s.map(function(x){return {d:x.getAttribute('data-device'),on:x.checked};})});})()" "04-A-take-selections.json"
shot "$A" "$TAG-03-take-preparation.png"
case "$TAKEDUMP" in
  *'"capturesChecked":2'*) chk "Take : 2 Captures selectionnees" 0 "$TAKEDUMP" ;;
  *) chk "Take : 2 Captures selectionnees" 1 "$TAKEDUMP" ;;
esac
case "$TAKEDUMP" in
  *'"storagesChecked":1'*) chk "Take : 1 Storage selectionne" 0 "$TAKEDUMP" ;;
  *) chk "Take : 1 Storage selectionne" 1 "$TAKEDUMP" ;;
esac

# `#tkArm` est désactivé tant que le Take n'a pas au moins une Capture : on
# attend l'activation RÉELLE du bouton (un .click() sur un bouton disabled est
# ignoré par le navigateur).
ARMBTN=0
for i in $(seq 1 30); do
  TKE=$(ev "$A" "(function(){var b=document.getElementById('tkArm');return b?(b.disabled?'DISABLED':'ENABLED'):'NOBTN';})()" | tr -d '"')
  if [ "$TKE" = "ENABLED" ]; then ARMBTN=1; break; fi
  sleep 1
done
chk "Take : bouton ARM activé apres selection" "$([ "$ARMBTN" = "1" ] && echo 0 || echo 1)" "$TKE"
[ "$ARMBTN" = "1" ] || { echo "FATAL: bouton ARM inactif"; exit 1; }
ev "$A" "document.getElementById('tkArm').click(); 'ARMED'" >/dev/null
sleep 5
ARMD=$(ev "$A" "(function(){
  var v = MultiCamArmService.view() || {};
  var caps = (v.devices || []).filter(function (d) {
    return (d.skills || []).some(function (x) { return x.skill === 'capture'; });
  });
  var sts = (v.devices || []).filter(function (d) {
    return (d.skills || []).some(function (x) { return x.skill === 'storage'; });
  });
  return JSON.stringify({ armDevices: (v.devices || []).length, armCaptures: caps.length,
    armStorages: sts.length, recEligible: v.recEligible, incidents: (v.incidents || []).length });
})()" | strip)
echo "  armee : $ARMD"
dump "$A" "JSON.stringify(MultiCamArmService.view())" "04-A-arm-view.json"
case "$ARMD" in
  *'"armCaptures":2'*) chk "ARM : 2 Captures pretes" 0 "$ARMD" ;;
  *) chk "ARM : 2 Captures pretes" 1 "$ARMD" ;;
esac
case "$ARMD" in
  *'"recEligible":true'*) chk "ARM : REC eligible apres ARM" 0 "recEligible=true" ;;
  *) chk "ARM : REC eligible apres ARM" 1 "$ARMD" ;;
esac

# Purge juste AVANT le REC : la 1re CAMERA_STATE_TX du tampon sera celle du
# segment 1 ; idem pour les logs des Captures.
for s in $ALLDEVS; do adb -s "$s" logcat -c 2>/dev/null; done
# `#armRec` reste disabled tant que `recEligible` est faux (horloges, rôles) :
# on attend l'activation réelle avant de déclencher.
RECBTN=0
for i in $(seq 1 60); do
  RECSTATE=$(ev "$A" "(function(){var b=document.getElementById('armRec');return b?(b.disabled?'DISABLED':'ENABLED'):'NOBTN';})()" | tr -d '"')
  if [ "$RECSTATE" = "ENABLED" ]; then RECBTN=1; break; fi
  sleep 1
done
chk "Armement : bouton REC activé" "$([ "$RECBTN" = "1" ] && echo 0 || echo 1)" "$RECSTATE"
[ "$RECBTN" = "1" ] || { echo "FATAL: bouton REC inactif"; exit 1; }
ev "$A" "document.getElementById('armRec').click(); 'REC_PRESSED'" >/dev/null
sleep 3
INC=$(ev "$A" "(function(){var m = document.getElementById('armIncidentModal'); return JSON.stringify({modalShown:!!(m&&m.classList.contains('show')),recDisabled:document.getElementById('armRec').disabled,eligible:MultiCamArmService.view().recEligible,incidents:MultiCamArmService.view().incidents});})()" | strip)
echo "  incident : $INC"
dump "$A" "(function(){var m=document.getElementById('armIncidentModal');return JSON.stringify({modalShown:!!(m&&m.classList.contains('show')),incidents:MultiCamArmService.view().incidents});})()" "04-A-incident.json"
case "$INC" in
  *'"modalShown":true'*)
    echo "  modal d'incident ouvert -> « Continuer REC »"
    ev "$A" "document.getElementById('armIncidentContinue').click(); 'CONTINUE'" >/dev/null ;;
  *) echo "  aucun incident : REC direct" ;;
esac

RECREADY=0
for i in $(seq 1 30); do
  STB=$(ev "$B" "(MultiCamCameraRecord.isRecording() ? 'REC' : (MultiCamStartService.phase() || '?'))" | tr -d '"')
  STC=$(ev "$C" "(MultiCamCameraRecord.isRecording() ? 'REC' : (MultiCamStartService.phase() || '?'))" | tr -d '"')
  if [ "$STB" = "REC" ] && [ "$STC" = "REC" ]; then RECREADY=1; echo "  B et C en REC apres $i tentatives"; break; fi
  sleep 2
done
[ "$RECREADY" = "1" ] || { echo "FATAL: les 2 Captures ne sont pas en REC (B=$STB C=$STC)"; exit 1; }
T_REC=$(ev "$A" "Date.now()" | tr -d '"')
echo "  tRec (horloge A) = $T_REC"

# -----------------------------------------------------------------------------
mark "4. CONVERGENCE MASTER — segment 1 recu pour les DEUX Captures"
ARR_TRACE="$OUT/logs/$TAG-arrivee-master.txt"
: > "$ARR_TRACE"
ARR_MS_B=""; ARR_MS_C=""
for pair in "$DID_B:B" "$DID_C:C"; do
  DID_P="${pair%%:*}"; LBL_P="${pair##*:}"; T_ARR=""
  for i in $(seq 1 80); do
    PA=$(probe_msr "$A" "$DID_P")
    T_A=$(ev "$A" "Date.now()" | tr -d '"')
    printf '%s %s mSeg=%s mRec=%s mCam=%s mSeen=%s\n' "$T_A" "$LBL_P" \
      "$(field "$PA" mSeg)" "$(field "$PA" mRec)" "$(field "$PA" mCam)" "$(field "$PA" mSeen)" >> "$ARR_TRACE"
    if [ "$(field "$PA" mSeg)" = "1" ]; then
      T_ARR="$T_A"
      if [ "$LBL_P" = "B" ]; then ARR_MS_B=$(( T_A - T_REC )); else ARR_MS_C=$(( T_A - T_REC )); fi
      break
    fi
    sleep 0.5
  done
  if [ -n "$T_ARR" ]; then
    echo "  $LBL_P segment 1 recu (+$([ "$LBL_P" = "B" ] && echo "$ARR_MS_B" || echo "$ARR_MS_C") ms)"
  else
    echo "  $LBL_P : AUCUN segment 1 recu en 40 s"
  fi
done
sed 's/^/    /' "$ARR_TRACE" | head -10

CB=$(probe_cap "$B"); CC=$(probe_cap "$C")
echo "  B: $CB"
echo "  C: $CC"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "10-B-view-seg1.json"
dump "$C" "JSON.stringify(MultiCamCameraSwitchService.view())" "10-C-view-seg1.json"

eq  "Capture B segmentIndex == 1"         "1"        "$(field "$CB" seg)"
eq  "Capture B segmentState recording"    "recording" "$(field "$CB" segState)"
eq  "Capture B recording == true"         "true"     "$(field "$CB" rec)"
eq  "Capture B rattachee au Take"         "1"        "$(python3 -c "import sys; v='$(field "$CB" take)'; print(0 if v.isdigit() and int(v) >= 1 else 1)")"
eq  "Capture C segmentIndex == 1"         "1"        "$(field "$CC" seg)"
eq  "Capture C segmentState recording"    "recording" "$(field "$CC" segState)"
eq  "Capture C recording == true"         "true"     "$(field "$CC" rec)"
eq  "Capture C rattachee au Take"         "1"        "$(python3 -c "import sys; v='$(field "$CC" take)'; print(0 if v.isdigit() and int(v) >= 1 else 1)")"

ev "$A" "MultiCamNav.show('live', { sid: '$SID' }); 'NAV_LIVE'" >/dev/null
sleep 4
ev "$A" "MultiCamLiveDetail.open('$DID_B'); 'OPEN_B'" >/dev/null
sleep 2
MA_B=$(probe_msr "$A" "$DID_B")
echo "  Master/B: $MA_B"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$DID_B','$SID')||null)" "11-A-inbox-B-seg1.json"
shot "$A" "$TAG-04-master-modal-B-seg1.png"
ev "$A" "MultiCamLiveDetail.close(); 'CLOSE'" >/dev/null
sleep 1
ev "$A" "MultiCamLiveDetail.open('$DID_C'); 'OPEN_C'" >/dev/null
sleep 2
MA_C=$(probe_msr "$A" "$DID_C")
echo "  Master/C: $MA_C"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$DID_C','$SID')||null)" "11-A-inbox-C-seg1.json"
shot "$A" "$TAG-05-master-modal-C-seg1.png"
# Lu TANT QUE la modal est ouverte : c'est elle qui projette l'état caméra.
LDCAM_C=$(ev "$A" "((document.getElementById('ldCamState')||{}).textContent || '-')" | strip)
echo "  ldCamState (modal C) : $LDCAM_C"
ev "$A" "MultiCamLiveDetail.close(); 'CLOSE'" >/dev/null
sleep 1

for pair in "$MA_B:B" "$MA_C:C"; do
  P="${pair%%:*}"; L="${pair##*:}"
  eq  "Master$L camera_state recu (inbox alimentee)" "1" "$(field "$P" mSeen)"
  eq  "Master$L segmentIndex recu == 1"      "1"        "$(field "$P" mSeg)"
  eq  "Master$L segmentState recu"           "recording" "$(field "$P" mSegState)"
  eq  "Master$L recording recu == true"      "true"     "$(field "$P" mRec)"
done
eq "MasterB meme activeCamera que B" "$(field "$CB" cam)" "$(field "$MA_B" mCam)"
eq "MasterC meme activeCamera que C" "$(field "$CC" cam)" "$(field "$MA_C" mCam)"
has "UI Master : état caméra de C affiché (modal)" "Caméra" "$LDCAM_C"
hasnt "UI Master C plus « Caméra inconnue »" "inconnue" "$LDCAM_C"

# -----------------------------------------------------------------------------
mark "5. PREVIEWS — cadence reguliere, REC non bloque (J09)"
sleep 2
S1=$(probe_slot "$A" "$DID_B"); S1C=$(probe_slot "$A" "$DID_C")
IN1=$(ev "$A" "JSON.stringify(MultiCamPreviewInbox.stats())" | strip)
echo "  t0  B=$S1"
echo "  t0  C=$S1C"
echo "  inbox t0 : $IN1"
shot "$A" "$TAG-06-mosaique-rec.png"
sleep 12
S2=$(probe_slot "$A" "$DID_B"); S2C=$(probe_slot "$A" "$DID_C")
IN2=$(ev "$A" "JSON.stringify(MultiCamPreviewInbox.stats())" | strip)
echo "  t1  B=$S2"
echo "  t1  C=$S2C"
echo "  inbox t1 : $IN2"
shot "$A" "$TAG-07-mosaique-rec-t12.png"
dump "$A" "JSON.stringify({slots:MultiCamLiveModel.view().slots,inbox:MultiCamPreviewInbox.stats()})" "20-A-previews-t12.json"
printf '  MESURE previews Master : stats t0=%s t1=%s\n' "$IN1" "$IN2" >> "$MESURES"

SEQ1B=$(field "$S1" seq); SEQ2B=$(field "$S2" seq)
SEQ1C=$(field "$S1C" seq); SEQ2C=$(field "$S2C" seq)
chk "Preview B presente sur la mosaïque (hasFrame)" "$([ "$(field "$S2" frame)" = "1" ] && echo 0 || echo 1)" "$S2"
chk "Preview C presente sur la mosaïque (hasFrame)" "$([ "$(field "$S2C" frame)" = "1" ] && echo 0 || echo 1)" "$S2C"
[ -n "$SEQ1B" ] && [ -n "$SEQ2B" ] && [ "$SEQ2B" -gt "$SEQ1B" ] 2>/dev/null \
  && chk "Preview B avance entre t0 et t12 (derniere image figee NON)" 0 "seq $SEQ1B → $SEQ2B" \
  || chk "Preview B avance entre t0 et t12" 1 "seq $SEQ1B → $SEQ2B"
[ -n "$SEQ1C" ] && [ -n "$SEQ2C" ] && [ "$SEQ2C" -gt "$SEQ1C" ] 2>/dev/null \
  && chk "Preview C avance entre t0 et t12 (derniere image figee NON)" 0 "seq $SEQ1C → $SEQ2C" \
  || chk "Preview C avance entre t0 et t12" 1 "seq $SEQ1C → $SEQ2C"
R1=$(printf '%s' "$IN1" | sed -n 's/.*"received":\([0-9]*\).*/\1/p')
R2=$(printf '%s' "$IN2" | sed -n 's/.*"received":\([0-9]*\).*/\1/p')
[ -n "$R1" ] && [ -n "$R2" ] && [ "$R2" -gt "$R1" ] 2>/dev/null \
  && chk "Inbox preview du Master alimentee en continu" 0 "received $R1 → $R2" \
  || chk "Inbox preview du Master alimentee en continu" 1 "received $R1 → $R2"
# REC non bloquee par la preview : le timer local avance toujours.
T_A1=$(ev "$A" "Date.now()" | tr -d '"')
TIM1=$(ev "$A" "(document.getElementById('liveTimer')||{}).textContent" | strip)
sleep 4
TIM2=$(ev "$A" "(document.getElementById('liveTimer')||{}).textContent" | strip)
[ -n "$TIM1" ] && [ "$TIM1" != "$TIM2" ] \
  && chk "REC non bloque par les previews (timer Master avance)" 0 "$TIM1 → $TIM2" \
  || chk "REC non bloque par les previews (timer Master avance)" 1 "$TIM1 → $TIM2"
eq "Capture B toujours en REC pendant les previews" "true" "$(field "$(probe_cap "$B")" rec)"
eq "Capture C toujours en REC pendant les previews" "true" "$(field "$(probe_cap "$C")" rec)"
# Zone Storage (J09-09c) : le Storage D doit être visible SOUS la mosaïque,
# en lecture seule, pendant le REC.
STORES_UI=$(ev "$A" "(function(){
  var z = document.getElementById('liveStores');
  var l = document.getElementById('liveStoreList');
  var rows = l ? l.querySelectorAll('.lv-store-row') : [];
  var first = rows[0] ? rows[0].querySelector('.lv-store-state') : null;
  return JSON.stringify({ hidden: z ? z.classList.contains('d-none') : null,
    rows: rows.length, state: first ? (first.textContent || '') : '-',
    text: l ? (l.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : '' });
})()" | strip)
echo "  zone Storage : $STORES_UI"
dump "$A" "JSON.stringify({stores:(document.getElementById('liveStores')||{}).className,list:(document.getElementById('liveStoreList')||{}).textContent})" "21-A-live-stores.json"
case "$STORES_UI" in
  *'"hidden":false'*'"rows":1'*) chk "Zone Storage visible sous la mosaïque (1 ligne)" 0 "$STORES_UI" ;;
  *) chk "Zone Storage visible sous la mosaïque (1 ligne)" 1 "$STORES_UI" ;;
esac
obs "Zone Storage : contenu affiche" "$STORES_UI"

logs_msr "$A" previews
logs_cap "$B" previews; logs_cap "$C" previews
console_raw "$B" previews; console_raw "$A" previews
# PixelCopy côté Capture : la frame JPEG part bien du plugin patché.
PX_B=$(grep -c "PREVIEW_FRAME_SENT" "$OUT/logs/$TAG-$B-cap-previews.log" 2>/dev/null | tr -d ' ')
PX_A=$(grep -c "PREVIEW_FRAME_RECEIVED\|PREVIEW_FRAME_RX" "$OUT/logs/$TAG-$A-msr-previews.log" 2>/dev/null | tr -d ' ')
chk "Capture B emet des previews (PREVIEW_FRAME_SENT)" "$([ "${PX_B:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$PX_B emission(s)"
chk "Master recoit des previews (PREVIEW_FRAME_*)" "$([ "${PX_A:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$PX_A reception(s)"
printf '  MESURE previews emises/recues : B=%s A=%s (fenêtre ~16 s)\n' "${PX_B:-0}" "${PX_A:-0}" >> "$MESURES"

# -----------------------------------------------------------------------------
mark "6. BASCULE DE CAMERA distante (B : REAR → FRONT, segment 2)"
ev "$A" "MultiCamLiveDetail.open('$DID_B'); 'OPEN'" >/dev/null
sleep 2
SW=$(ev "$A" "(function(){
  var b = document.querySelector('#ldCamActions button[data-camera=\"FRONT\"]');
  if (!b) return 'NO_BUTTON';
  b.click(); return 'CLICKED';
})()" | strip)
echo "  bascule : $SW"
SW_OK=0
for i in $(seq 1 30); do
  CB2=$(probe_cap "$B")
  if [ "$(field "$CB2" seg)" = "2" ] && [ "$(field "$CB2" cam)" = "FRONT" ]; then SW_OK=1; break; fi
  sleep 2
done
echo "  B apres bascule : $CB2"
dump "$B" "JSON.stringify(MultiCamCameraSwitchService.view())" "12-B-view-seg2.json"
MA_B2=$(probe_msr "$A" "$DID_B")
echo "  Master/B apres bascule : $MA_B2"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$DID_B','$SID')||null)" "13-A-inbox-B-seg2.json"
shot "$A" "$TAG-08-master-modal-seg2.png"
shot "$B" "$TAG-09-capture-B-front.png"

chk "Bascule B : segmentIndex == 2 + activeCamera FRONT" "$([ "$SW_OK" = "1" ] && echo 0 || echo 1)" "B: $CB2"
eq "Master B : segmentIndex recu == 2"   "2"     "$(field "$MA_B2" mSeg)"
eq "Master B : activeCamera recu FRONT"  "FRONT" "$(field "$MA_B2" mCam)"
eq "Master B : segmentState recording"   "recording" "$(field "$MA_B2" mSegState)"
# C n'est PAS touche par la bascule : chaque Capture a son propre segment.
eq "Capture C intacte par la bascule (segment 1)" "1" "$(field "$(probe_cap "$C")" seg)"
ev "$A" "MultiCamLiveDetail.close(); 'CLOSE'" >/dev/null
logs_msr "$A" switch
logs_cap "$B" switch
SWLOG=$(grep -o "CAMERA_SWITCH_[A-Z]*[^\"]*" "$OUT/logs/$TAG-$B-cap-switch.log" 2>/dev/null | head -1)
obs "Bascule B : trace native" "${SWLOG:-ABSENTE}"
SEG2=$(grep -c "CAMERA_SEGMENT_OPEN segmentIndex=2" "$OUT/logs/$TAG-$B-cap-switch.log" 2>/dev/null | tr -d ' ')
chk "Bascule B : segment 2 reellement ouvert (CAMERA_SEGMENT_OPEN)" "$([ "${SEG2:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$SEG2 occurrence(s)"

# -----------------------------------------------------------------------------
mark "7. DECONNEXION de C : grille stable, image figee, STOP local d'urgence visible"
SL1=$(probe_slot "$A" "$DID_B"); SL1C=$(probe_slot "$A" "$DID_C")
ORDER1=$(field "$SL1C" order); SLOTS1=$(field "$SL1C" slots)
echo "  avant coupure : B=$SL1"
echo "  avant coupure : C=$SL1C"
C_IP=$(wait_ip "$C")
adb -s "$C" shell svc wifi disable >/dev/null 2>&1
echo "  Wi-Fi coupe sur C (avant : $C_IP)"
adb -s "$C" logcat -c 2>/dev/null

DISC_OK=0
for i in $(seq 1 60); do
  SL2C=$(probe_slot "$A" "$DID_C")
  if [ "$(field "$SL2C" conn)" = "0" ]; then DISC_OK=1; echo "  Master voit C deconnectee apres $((i*2)) s : $SL2C"; break; fi
  sleep 2
done
shot "$A" "$TAG-10-mosaique-C-deconnectee.png"
dump "$A" "JSON.stringify(MultiCamLiveModel.view())" "14-A-slots-C-offline.json"
echo "  apres coupure : C=$SL2C"
echo "  apres coupure : B=$(probe_slot "$A" "$DID_B")"

chk "Deconnexion C detectee par le Master" "$([ "$DISC_OK" = "1" ] && echo 0 || echo 1)" "$SL2C"
case "$SL2C" in
  *present=1*) chk "Grille : le slot de C PERSISTE (pas de re-arrangement)" 0 "$SL2C" ;;
  *) chk "Grille : le slot de C PERSISTE (pas de re-arrangement)" 1 "$SL2C" ;;
esac
case "$SL2C" in
  *frame=1*) chk "Grille : dernierne image de C FIGEE sur la vignette" 0 "$SL2C" ;;
  *) chk "Grille : dernierne image de C FIGEE sur la vignette" 1 "$SL2C" ;;
esac
eq "Grille : nombre de vignettes inchange" "$SLOTS1" "$(field "$SL2C" slots)"
eq "Grille : ordre des vignettes inchange" "$ORDER1" "$(field "$SL2C" order)"
eq "Grille : vignettes DOM = vignettes modele" "$(field "$SL2C" slots)" "$(field "$SL2C" grid)"
case "$SL2C" in
  *disp=DECONNECTED*) chk "Modèle Master : displayState de C = DECONNECTED" 0 "$SL2C" ;;
  *) chk "Modèle Master : displayState de C = DECONNECTED" 1 "$SL2C" ;;
esac
case "$SL2C" in
  *uilab=Déconnecté*) chk "Grille : libellé « Déconnecté » affiché pour C" 0 "$SL2C" ;;
  *) chk "Grille : libellé « Déconnecté » affiché pour C" 1 "$SL2C" ;;
esac
case "$SL2C" in
  *uilab=REC*) chk "Grille : libellé de C n'est plus « REC »" 1 "$SL2C" ;;
  *) chk "Grille : libellé de C n'est plus « REC »" 0 "$SL2C" ;;
esac
# La Capture B, elle, continue : c'est ce que « ne pas bloquer le REC » implique.
SL2B=$(probe_slot "$A" "$DID_B")
SEQB_OFF=$(field "$SL2B" seq)
sleep 10
SL3B=$(probe_slot "$A" "$DID_B")
SEQB_OFF2=$(field "$SL3B" seq)
[ -n "$SEQB_OFF" ] && [ -n "$SEQB_OFF2" ] && [ "$SEQB_OFF2" -gt "$SEQB_OFF" ] 2>/dev/null \
  && chk "Capture B continue d'envoyer ses previews pendant la coupe de C" 0 "seq $SEQB_OFF → $SEQB_OFF2" \
  || chk "Capture B continue d'envoyer ses previews pendant la coupe de C" 1 "seq $SEQB_OFF → $SEQB_OFF2"
eq "Capture B toujours en REC pendant la coupe de C" "true" "$(field "$(probe_cap "$B")" rec)"
eq "Capture C toujours en REC localement pendant la coupe" "true" "$(field "$(probe_cap "$C")" rec)"

# STOP local d'urgence : il ne doit devenir visible que lorsque PLUS AUCUN
# Master n'est connecté (invariant UI 07 / critère J10).
EMG=0
for i in $(seq 1 60); do
  CB_OFF=$(probe_cap "$C")
  if [ "$(field "$CB_OFF" emg)" = "1" ]; then EMG=1; echo "  STOP local visible sur C apres $((i*2)) s"; break; fi
  sleep 2
done
EMG_DOM=$(ev "$C" "(function(){var b=document.getElementById('cdEmergency');return b && !b.classList.contains('d-none') ? 'VISIBLE' : 'HIDDEN';})()" | strip)
echo "  C : $CB_OFF  bouton=$EMG_DOM"
dump "$C" "(function(){return JSON.stringify({view:MultiCamStartService.view(),emgDom:(function(){var b=document.getElementById('cdEmergency');return b?{cls:b.className,txt:b.textContent.trim()}:null;})()});})()" "15-C-emergency.json"
shot "$C" "$TAG-11-C-stop-local-urgence.png"
chk "Capture C : showEmergencyStop passe a true (aucun Master)" "$([ "$EMG" = "1" ] && echo 0 || echo 1)" "$CB_OFF"
chk "Capture C : bouton « STOP local » visible dans le DOM" "$([ "$EMG_DOM" = "VISIBLE" ] && echo 0 || echo 1)" "$EMG_DOM"
logs_cap "$C" offline
MLOST=$(grep -c "START_MASTER_LOST" "$OUT/logs/$TAG-$C-cap-offline.log" 2>/dev/null | tr -d ' ')
chk "Capture C : START_MASTER_LOST journalise" "$([ "${MLOST:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$MLOST occurrence(s)"
MLOST_LINE=$(grep -o "START_MASTER_LOST[^\"]*" "$OUT/logs/$TAG-$C-cap-offline.log" 2>/dev/null | head -1)
obs "Capture C : trace MASTER_LOST" "${MLOST_LINE:-ABSENTE}"

# -----------------------------------------------------------------------------
mark "8. RECONNEXION de C : reprise automatique des previews + bouton masque"
adb -s "$C" shell svc wifi enable >/dev/null 2>&1
REC_OK=0
for i in $(seq 1 60); do
  IP_C=$(wait_ip "$C")
  SL3C=$(probe_slot "$A" "$DID_C")
  if [ -n "$IP_C" ] && [ "$(field "$SL3C" conn)" = "1" ]; then REC_OK=1; echo "  C reconnectee apres $((i*2)) s (ip=$IP_C) : $SL3C"; break; fi
  sleep 2
done
echo "  apres reconnexion : C=$SL3C"
dump "$A" "JSON.stringify(MultiCamLiveModel.view())" "16-A-slots-C-reconnected.json"
chk "Reconnexion C detectee par le Master" "$([ "$REC_OK" = "1" ] && echo 0 || echo 1)" "$SL3C"
SEQR1=$(field "$SL3C" seq)
sleep 10
SL4C=$(probe_slot "$A" "$DID_C")
SEQR2=$(field "$SL4C" seq)
echo "  reprise previews C : seq $SEQR1 → $SEQR2"
shot "$A" "$TAG-12-mosaique-C-reconnectee.png"
[ -n "$SEQR1" ] && [ -n "$SEQR2" ] && [ "$SEQR2" -gt "$SEQR1" ] 2>/dev/null \
  && chk "Reconnexion : previews de C repris automatiquement" 0 "seq $SEQR1 → $SEQR2" \
  || chk "Reconnexion : previews de C repris automatiquement" 1 "seq $SEQR1 → $SEQR2"
case "$SL4C" in
  *frame=1*) chk "Reconnexion : vignette de C de nouveau vivante" 0 "$SL4C" ;;
  *) chk "Reconnexion : vignette de C de nouveau vivante" 1 "$SL4C" ;;
esac
EMG2_DOM=$(ev "$C" "(function(){var b=document.getElementById('cdEmergency');return b && !b.classList.contains('d-none') ? 'VISIBLE' : 'HIDDEN';})()" | strip)
EMG2=$(ev "$C" "(MultiCamStartService.view().showEmergencyStop === true ? '1' : '0')" | tr -d '"')
echo "  C apres reconnexion : emg=$EMG2 dom=$EMG2_DOM"
chk "Reconnexion : STOP local d'urgence masque de nouveau" "$([ "$EMG2" = "0" ] && [ "$EMG2_DOM" = "HIDDEN" ] && echo 0 || echo 1)" "emg=$EMG2 dom=$EMG2_DOM"
dump "$C" "JSON.stringify(MultiCamStartService.view())" "17-C-after-reconnect.json"
eq "Reconnexion : Capture C toujours en REC" "true" "$(field "$(probe_cap "$C")" rec)"
# L'état du Master revient à REC (et non à « Déconnecté »).
case "$SL4C" in
  *uilab=Déconnecté*|*disp=DECONNECTED*) chk "Master : C n'est plus « Déconnecté »" 1 "$SL4C" ;;
  *) chk "Master : C n'est plus « Déconnecté »" 0 "$SL4C" ;;
esac
logs_cap "$C" reconnect
logs_msr "$A" reconnect

# -----------------------------------------------------------------------------
mark "9. SUPERVISION : batterie / espace / etat des 4 devices"
TELEM=$(probe_telemetry "$A")
echo "  telemetry : $TELEM"
dump "$A" "JSON.stringify(MultiCamTelemetryStore.all('$SID'))" "18-A-telemetry.json"
T_NB=$(printf '%s' "$TELEM" | tr '|' '\n' | grep -c "=" )
chk "Supervision : télémétrie publiee par les devices du Take" "$([ "$T_NB" -ge 2 ] 2>/dev/null && echo 0 || echo 1)" "$T_NB entree(s) [$TELEM]"
case "$TELEM" in
  *b=[0-9]*) chk "Supervision : niveau de batterie present" 0 "$TELEM" ;;
  *) chk "Supervision : niveau de batterie present" 1 "$TELEM" ;;
esac
case "$TELEM" in
  *f=[0-9]*) chk "Supervision : espace libre presente (Mo)" 0 "$TELEM" ;;
  *) chk "Supervision : espace libre presente (Mo)" 1 "$TELEM" ;;
esac
shot "$A" "$TAG-13-mosaique-supervision.png"

# -----------------------------------------------------------------------------
mark "10. ARRET PROPRE des 2 Captures, convergence Master au segment 0"
# Le bouton UI « STOP local » n'est visible QUE hors connexion Master (invariant
# UI 07) : l'arrêt propre se fait donc par la même entrée de service que le
# bouton (`MultiCamStartService.stopLocal`), ici exécutée AVEC le Master
# connecté pour prouver la convergence de l'état final.
for s in $B $C; do adb -s "$s" logcat -c 2>/dev/null; done
adb -s "$A" logcat -c 2>/dev/null
ST_B=$(ev "$B" "MultiCamStartService.stopLocal('campaign_end').then(function(){return 'STOPPED';},function(e){return 'ERR:'+(e&&e.message);})" | strip)
sleep 2
ST_C=$(ev "$C" "MultiCamStartService.stopLocal('campaign_end').then(function(){return 'STOPPED';},function(e){return 'ERR:'+(e&&e.message);})" | strip)
echo "  stop B=$ST_B  stop C=$ST_C"
chk "Arret B execute par le service" "$([ "$ST_B" = "STOPPED" ] && echo 0 || echo 1)" "$ST_B"
chk "Arret C execute par le service" "$([ "$ST_C" = "STOPPED" ] && echo 0 || echo 1)" "$ST_C"
sleep 8

for pair in "$DID_B:B" "$DID_C:C"; do
  DID_P="${pair%%:*}"; L="${pair##*:}"
  ev "$A" "MultiCamLiveDetail.open('$DID_P'); MultiCamLiveDetail.refresh(); 'R'" >/dev/null
  sleep 2
  EV=""
  for i in $(seq 1 20); do
    EV=$(probe_msr "$A" "$DID_P")
    if [ "$(field "$EV" mSeg)" = "0" ] && [ "$(field "$EV" mRec)" = "false" ]; then break; fi
    sleep 2
  done
  echo "  Master/$L apres STOP : $EV"
  dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$DID_P','$SID')||null)" "30-A-inbox-$L-after-stop.json"
  shot "$A" "$TAG-14-master-modal-stop-$L.png"
  ev "$A" "MultiCamLiveDetail.close(); 'C'" >/dev/null
  eq "STOP Master$L segmentIndex recu == 0"   "0"     "$(field "$EV" mSeg)"
  eq "STOP Master$L recording recu == false"  "false" "$(field "$EV" mRec)"
done
CB_STOP=$(probe_cap "$B"); CC_STOP=$(probe_cap "$C")
echo "  B apres STOP : $CB_STOP"
echo "  C apres STOP : $CC_STOP"
dump "$B" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),view:MultiCamCameraSwitchService.view()})" "31-B-after-stop.json"
dump "$C" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),view:MultiCamCameraSwitchService.view()})" "31-C-after-stop.json"
eq "STOP Capture B recording == false" "false" "$(field "$CB_STOP" rec)"
eq "STOP Capture B segmentIndex == 0" "0"     "$(field "$CB_STOP" seg)"
eq "STOP Capture C recording == false" "false" "$(field "$CC_STOP" rec)"
eq "STOP Capture C segmentIndex == 0" "0"     "$(field "$CC_STOP" seg)"
logs_cap "$B" stop; logs_cap "$C" stop; logs_msr "$A" stop
console_raw "$B" stop; console_raw "$C" stop; console_raw "$A" stop
for s in $B $C; do
  STOPP=$(grep -c "CAMERA_REC_STOP_OK" "$OUT/logs/$TAG-$s-cap-stop.log" 2>/dev/null | tr -d ' ')
  chk "Capture $s : CAMERA_REC_STOP_OK (fichier finalise)" "$([ "${STOPP:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$STOPP occurrence(s)"
done

# -----------------------------------------------------------------------------
mark "11. FICHIERS VIDEO reels par Capture (ffprobe + SHA-256)"
FILES_TOTAL=0
for pair in "$B:B" "$C:C"; do
  X="${pair%%:*}"; L="${pair##*:}"
  adb -s "$X" shell run-as $APP ls -l cache/ > "$OUT/logs/$TAG-$X-files.txt" 2>&1
  echo "  cache $L ($X) :"
  sed 's/^/    /' "$OUT/logs/$TAG-$X-files.txt"
  MP4S=$(adb -s "$X" shell run-as $APP ls cache/ 2>/dev/null | tr -d '\r' | grep -E "^videoTmp.*\.mp4$")
  N=0
  for f in $MP4S; do
    # Toute preuve vidéo doit être née pendant ce run (cache vidé en préambule).
    T0="$VIDDIR/${X}-${f}"
    adb -s "$X" exec-out run-as $APP cat "cache/$f" > "$T0" 2>/dev/null
    SZ=$(wc -c < "$T0" | tr -d ' ')
    if [ "$SZ" -lt 1000000 ]; then
      chk "Fichier $L/$f taille significative" 1 "size=$SZ"
      rm -f "$T0"
      continue
    fi
    FP=$(ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height \
      -of default=noprint_wrappers=1 "$T0" 2>&1 | tr '\n' ' ')
    SH=$(shasum -a 256 "$T0" | awk '{print $1}')
    echo "    $f size=$SZ sha256=${SH:0:16}… $FP" | tee -a "$OUT/logs/$TAG-$X-ffprobe.log"
    N=$((N + 1))
    case "$FP" in
      *"codec_name=h264"*) chk "Fichier $L/$f : flux video h264 present" 0 "size=$SZ" ;;
      *) chk "Fichier $L/$f : flux video h264 present" 1 "$FP" ;;
    esac
    DUR=$(printf '%s' "$FP" | sed -n 's/.*duration=\([0-9.]*\).*/\1/p')
    OKD=$(python3 -c "print(0 if float('${DUR:-0}') >= 5.0 else 1)" 2>/dev/null || echo 1)
    chk "Fichier $L/$f : duree >= 5 s" "$OKD" "duree=${DUR:-?} s"
    printf '  MESURE fichier %s/%s : %s octets, %s s, sha256=%s\n' "$L" "$f" "$SZ" "${DUR:-?}" "$SH" >> "$MESURES"
  done
  FILES_TOTAL=$((FILES_TOTAL + N))
  chk "Fichiers video reels sur la Capture $L" "$([ "$N" -ge 1 ] && echo 0 || echo 1)" "$N fichier(s) >= 1 Mo"
done
echo "  médias tirés dans $VIDDIR (hors dépôt, jamais versionnés)"
printf '  MESURE fichiers MP4 valides : %s au total\n' "$FILES_TOTAL" >> "$MESURES"

# -----------------------------------------------------------------------------
mark "12. INTEGRITE DU DEPOT + TESTS AUTOMATIQUES"
PROD=$(cd "$ROOT" && git status --short | grep -vE '^\?\? tests/e2e/validation/J09-rec-previews/' | tr -d ' ')
if [ -z "$PROD" ]; then
  obs "aucun fichier HORS preuves modifie (code produit intact)"
else
  chk "aucun fichier hors preuves modifie" 1 "$PROD"
fi
if git -C "$ROOT" status --short | grep -E "\.mp4$" >/dev/null 2>&1; then
  chk "aucun MP4 ajoute au dépôt" 1 "$(git -C "$ROOT" status --short | grep '\.mp4$' | head -3)"
else
  chk "aucun MP4 ajoute au dépôt" 0 "statut git sans .mp4"
fi
(cd "$ROOT/app" && node tests/run.js) > "$OUT/logs/$TAG-unit-tests.log" 2>&1
# Le log contient des NOMS de tests contenant « passed/failed » : on ne lit que
# la ligne de synthèse finale (`288 passed, 0 failed`).
UT=$(grep -E "^[0-9]+ passed, [0-9]+ failed" "$OUT/logs/$TAG-unit-tests.log" | tail -1)
echo "  tests : ${UT:-SYNTHESE_ABSENTE}"
UT_FAILED=$(printf '%s' "$UT" | sed -n 's/.*, \([0-9]*\) failed/\1/p')
chk "Tests automatisés app : 0 échec" "$([ -n "$UT" ] && [ "${UT_FAILED:-1}" = "0" ] && echo 0 || echo 1)" "${UT:-SYNTHESE_ABSENTE}"
shasum -a 256 "$OUT"/screenshots/*.png > "$OUT/logs/$TAG-png-shas.txt" 2>/dev/null

# -----------------------------------------------------------------------------
mark "13. SYNTHESE"
echo "  media   : $VIDDIR ($FILES_TOTAL fichier(s) valides)"
echo "  checks  : $CHECKS"
echo "  mesures :"
sed 's/^/    /' "$MESURES" 2>/dev/null
echo "  controles non conformes : $FAILN"
if [ "$FAILN" -gt 0 ]; then
  echo "  RESULTAT : NON CONFORME ($FAILN) — NE PAS corriger ici, rapporter."
  exit 1
fi
echo "  RESULTAT : CONFORME"
exit 0
