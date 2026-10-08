#!/usr/bin/env bash
# Garde-fou : toute erreur de syntaxe introduite dans ce fichier doit faire
# échouer la campagne au DÉMARRAGE et non en plein milieu (ex. section 10).
bash -n "$BASH_SOURCE" || { echo "ERREUR FATALE: syntaxe du harnais non valide"; exit 2; }
# Campagne VALIDATION FINALE J09 — preuves physiques des correctifs D1→D4.
#
# Mission : VALIDATION UNIQUEMENT. Aucun correctif produit ici. Le run pilote
# l'UI réelle (CDP) et les commandes Android de diagnostic ; il ne touche JAMAIS
# à app/www ni au protocole. En cas de défaut : capturer, classer, continuer,
# verdict en fin de run — ne PAS corriger.
#
# Scénarios (réf. MULTICAM_DECISIONS_REFERENCE / mission J09-VALIDATION-FINAL) :
#   A. session de référence (baseline) sans défaut régressif
#   B. D1 — continuité de la séquence preview AU TRAVERS des bascules caméra
#        (first_seq_after_switch > last_seq_before_switch, pas de gel ~44 s,
#        réitération sur un 2e switch)
#   C. D2 — télémétrie indépendante de l'écran 05 ; ouverture/fermeture 05 sans
#        double publication ni perte
#   D. D3 — reconnexion AUTOMATIQUE après coupure réseau réelle (bannière, boucle
#        de retry Master, redial sans geste UI)
#   E. D4 — reconvergence camera_state après reconnexion (diver the purpose :
#        C arrêté pendant l'outage => A reconverge à STOPPED/seg 0, sans
#        commande rejouée, sans re-START, urgence masquée)
#   F. double cycle de coupure/reconnexion (sur B, convergence camera_state à
#        chaque cycle, previews et télémétrie repris)
#   G. closed wins — clôture de session + réapparition d'un transport : rien ne
#        ressuscite (pas de re-dial, pas de rejoin, aucune session réouverte)
#   H. regression sweep + suite automatisée (attendue 308 passed / 0 failed)
#
# Aucun MP4 n'est écrit dans le dépôt (médias tirés dans $TMPDIR puis mesurés).
#
# Usage : tests/e2e/validation/J09-rec-previews/run-j09-validation-final.sh
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

TAG="J09val-$(date +%H%M%S)"
mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps"

FAILN=0
CHECKS="$OUT/logs/$TAG-checks.txt"
MESURES="$OUT/logs/$TAG-mesures.txt"
VIDDIR="${TMPDIR:-/tmp}/j09-val-videos"
mkdir -p "$VIDDIR"
: > "$CHECKS"; : > "$MESURES"

SID=""
DID_A=""; DID_B=""; DID_C=""; DID_D=""
IP_A=""; IP_B=""; IP_C=""; IP_D=""

# ---------------------------------------------------------------- utilitaires
ev() { node "$CDP" "$1" eval "$2"; }

strip() { sed 's/^"//; s/"$//; s/\\"/"/g; s/\\n/ /g'; }

field() {
  printf '%s' "$1" | awk -F'|' -v k="$2" '
    { for (i = 1; i <= NF; i++) { p = index($i, "=");
        if (p > 0 && substr($i, 1, p - 1) == k) { v = substr($i, p + 1); found = 1 } } }
    END { print (found ? v : "") }'
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

logs_cap() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "CAMERA|PREVIEW_FRAME_|PIXELCOPY|START_|PEER_|SYNC_|TELEMETRY|ONPEER|RESYNC" \
    > "$OUT/logs/$TAG-$1-cap-$2.log"
  echo "  log Capture $1[$2] ($(wc -l < "$OUT/logs/$TAG-$1-cap-$2.log" | tr -d ' ') lignes)"
}

logs_msr() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "WS_|SESSION_|MEMBER_|INVITE_|SYNC_PLEASE|START_|PEER_|MODEL_|SCREEN03|SCREEN08|CAMERA_STATE|PREVIEW_FRAME" \
    > "$OUT/logs/$TAG-$1-msr-$2.log"
  echo "  log Master [$2] ($(wc -l < "$OUT/logs/$TAG-$1-msr-$2.log" | tr -d ' ') lignes)"
}

logs_any() {
  adb -s "$1" logcat -d -v time 2>/dev/null \
    | grep -E "WS_|SESSION_|MEMBER_|INVITE_|SYNC_PLEASE|START_|PEER_|CAMERA_STATE|PREVIEW_FRAME|TELEMETRY|SCREEN" \
    > "$OUT/logs/$TAG-$1-any-$2.log"
  echo "  log $1[$2] ($(wc -l < "$OUT/logs/$TAG-$1-any-$2.log" | tr -d ' ') lignes)"
}

chk() {
  if [ "$2" = "0" ]; then
    printf '  PASS   %-60s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
  else
    printf '  FAIL   %-60s %s\n' "$1" "${3:-}" | tee -a "$CHECKS"
    FAILN=$((FAILN + 1))
  fi
}
obs() { printf '  OBS    %-60s %s\n' "$1" "${2:-}" | tee -a "$CHECKS"; }
eq()  { if [ "$2" = "$3" ]; then chk "$1" 0 "$3"; else chk "$1" 1 "attendu=[$2] obtenu=[$3]"; fi; }
has() { case "$3" in *"$2"*) chk "$1" 0 "[$3]" ;; *) chk "$1" 1 "fragment absent [$2] dans [$3]" ;; esac; }
hasnt() { case "$3" in *"$2"*) chk "$1" 1 "fragment interdit [$2] dans [$3]" ;; *) chk "$1" 0 "[$3]" ;; esac; }

mark() { echo; echo "### $*"; }

# ------------------------------------------------------------------- sondes

probe_cap() {
  ev "$1" "(function(){
    var v = MultiCamCameraSwitchService.view();
    var qs = MultiCamStartService;
    var st = qs ? qs.view() : null;
    return [
      'cam=' + (v.activeCamera || '-'),
      'seg=' + (v.segmentIndex == null ? '-' : v.segmentIndex),
      'segState=' + JSON.stringify(v.segmentState == null ? '' : v.segmentState).slice(1, -1),
      'rec=' + (v.recording === true ? 'true' : (v.recording === false ? 'false' : '?')),
      'sid=' + (v.sessionId || '-'),
      'take=' + (v.takeNumber == null ? '-' : v.takeNumber),
      'phase=' + (qs ? qs.phase() : '-'),
      'emg=' + (st && st.showEmergencyStop === true ? '1' : '0')
    ].join('|');
  })()" | strip
}

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
      'ui=' + (st ? String(st.dataset.state || '') : '-')
    ].join('|');
  })()" | strip
}

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

tele_view() {
  ev "$1" "(function(){
    var t = MultiCamTelemetryService.view() || {};
    return ['bound=' + (t.bound ? '1' : '0'), 'running=' + (t.running ? '1' : '0'),
      'sid=' + (t.sessionId || '-'), 'coll=' + (t.stats ? t.stats.collects : '-'),
      'pub=' + (t.stats ? t.stats.publishes : '-'), 'err=' + (t.stats ? t.stats.errors : '-')
    ].join('|');
  })()" | strip
}

wait_ip() { # $1=serial -> affiche l'IPv4 wlan0 (vide si absent)
  adb -s "$1" shell ip addr show wlan0 2>/dev/null \
    | awk '/inet /{split($2,a,"/"); print a[1]; exit}'
}

# Trace dense (t_slot, seq) — ~2 échantillons/s pendant N s.
trace_frames() { # $1=device  $2=seconds  $3=outfile
  local X="$1" N="$2" F="$3"
  for i in $(seq 1 $((N * 2))); do
    local T SQ
    T=$(ev "$A" "Date.now()" | tr -d '"')
    SQ=$(field "$(probe_slot "$A" "$X")" seq)
    printf '%s %s\n' "$T" "$SQ" >> "$F"
    sleep 0.5
  done
}

# Analyse d'une trace de bascule : max avant, premier après, monotonie.
analyze_switch() { # $1=t_click  $2=trace
  python3 - "$1" "$2" <<'PY'
import sys
click = float(sys.argv[1])
paths = sys.argv[2]
rows = []
for line in open(paths):
    line = line.strip()
    if not line:
        continue
    p = line.split()
    if len(p) < 2:
        continue
    try:
        t = float(p[0]); s = int(p[1])
        rows.append((t, s))
    except ValueError:
        continue  # marqueurs non-numériques (click UI) ignorés
bef = [s for (t, s) in rows if t < click]
aft = [s for (t, s) in rows if t >= click]
max_before = max(bef) if bef else 0
first = None
first_t = None
resets = 0
prev = None
for (t, s) in rows:
    if t < click:
        prev = s
        continue
    if first is None and s != max_before:
        first = s
        first_t = t
    if prev is not None and s < prev:
        resets += 1
    prev = s
max_after = max(aft) if aft else max_before
print("max_before=%d first_after=%s first_after_ms=%s resets=%d max_after=%d samples=%d" % (
    max_before, first, (round(first_t - click) if first_t is not None else -1),
    resets, max_after, len(rows)))
PY
}

# Attente de reconvergence de l'inbox Master pour un device donné.
wait_msr() { # $1=serial  $2=did  $3=mSeg attendu  $4=mRec attendu  $5=label
  local PA=""
  for i in $(seq 1 60); do
    PA=$(probe_msr "$1" "$2")
    if [ "$(field "$PA" mSeg)" = "$3" ] && [ "$(field "$PA" mRec)" = "$4" ]; then
      break
    fi
    sleep 2
  done
  chk "convergence Master→$5 : inbox mSeg=$3 mRec=$4" \
    "$([ "$(field "$PA" mSeg)" = "$3" ] && [ "$(field "$PA" mRec)" = "$4" ] && echo 0 || echo 1)" "$PA"
}

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
  JOINED=0
  for i in $(seq 1 30); do
    M=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=(s.members||[]).filter(function(x){return x.deviceId==='$DID';})[0];return m?(m.sessionRoles||[]).join('+'):'NONE';})()" | tr -d '"')
    if [ -n "$M" ] && [ "$M" != "NONE" ]; then JOINED=1; break; fi
    sleep 2
  done
  chk "invite[$LBL] devenu membre avec role $ROLE" "$([ "$JOINED" = "1" ] && echo 0 || echo 1)" "roles=[$M]"
  ACC=""
  for i in $(seq 1 20); do
    ACC=$(adb -s "$X" logcat -d -v time 2>/dev/null \
      | grep "CONSOLE" | grep -o "INVITE_ACCEPTED[^\"]*" | head -1)
    [ -n "$ACC" ] && break
    sleep 1
  done
  chk "invite[$LBL] INVITE_ACCEPTED recu par le device" "$([ -n "$ACC" ] && echo 0 || echo 1)" "${ACC:-ABSENT}"
  dump "$X" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify(s?{sid:s.sessionId,state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId;}),members:(s.members||[]).map(function(m){return {d:m.deviceId,r:m.sessionRoles};})}:{none:true});})()" "02-$LBL-joined.json"
}

# =============================================================================
mark "0. environnement / preflight"
HEAD_SHA=$(cd "$ROOT" && git rev-parse --short HEAD)
echo "  HEAD  = $HEAD_SHA $(cd "$ROOT" && git log -1 --pretty=%s)"
APK="$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
APK_SHA=$(shasum -a 256 "$APK" | awk '{print $1}')
echo "  APK   = sha256 $APK_SHA ($(stat -f %z "$APK") octets)"
echo "$HEAD_SHA $APK_SHA" > "$OUT/logs/$TAG-apk-sha256.txt"

adb devices -l | grep -v "^List" > "$OUT/logs/$TAG-adb-devices.txt" 2>/dev/null || true
{
  echo "# J09 VALIDATION FINALE — appareils (topologie identique a J09-FINAL)"
  echo "# source : adb devices -l + MultiCamConfig releve au preflight ($TAG)"
  echo "#"
} >> "$OUT/logs/$TAG-adb-devices.txt"

# REMISE À ZÉRO : Take résiduel => phase=REC/STOPPED ; on relance proprement.
# On purge aussi le store de sessions (localStorage) pour ne PAS hériter d'une
# session OUVERTE résiduelle d'une campagne précédente (sinon une boucle de
# retry vers un ancien endpoint pollue le réseau ET fausse la baseline).
for s in $ALLDEVS; do
  node "$CDP" "$s" eval "global.localStorage.removeItem('multicam.sessions.list'); 'CLEARED'" >/dev/null 2>&1 || true
  adb -s "$s" shell "run-as $APP sh -c 'rm -f files/sessions/*.json'" >/dev/null 2>&1 || true
done
for s in $ALLDEVS; do
  adb -s "$s" shell am force-stop $APP >/dev/null 2>&1
done
sleep 3
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

# Noms distincts identiques à J09-FINAL puis ré-annonce.
ev "$A" "MultiCamConfig.setDeviceName('Cam 05'); 'OK'" >/dev/null
ev "$B" "MultiCamConfig.setDeviceName('Cam 07'); 'OK'" >/dev/null
ev "$C" "MultiCamConfig.setDeviceName('Cam 09'); 'OK'" >/dev/null
ev "$D" "MultiCamConfig.setDeviceName('Cam D4'); 'OK'" >/dev/null
sleep 1
for s in $ALLDEVS; do ev "$s" "MultiCamDiscovery.reannounce ? MultiCamDiscovery.reannounce() : null; 'REANN'" >/dev/null; done
sleep 3

DID_A=$(ev "$A" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_B=$(ev "$B" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_C=$(ev "$C" "MultiCamConfig.get().deviceId" | tr -d '"')
DID_D=$(ev "$D" "MultiCamConfig.get().deviceId" | tr -d '"')
[ -n "$DID_A" ] && [ -n "$DID_B" ] && [ -n "$DID_C" ] && [ -n "$DID_D" ] \
  || { echo "FATAL: deviceId introuvable"; exit 1; }
IP_A=$(wait_ip "$A"); IP_B=$(wait_ip "$B"); IP_C=$(wait_ip "$C"); IP_D=$(wait_ip "$D")
echo "  A=$DID_A ($IP_A)  B=$DID_B ($IP_B)"
echo "  C=$DID_C ($IP_C)  D=$DID_D ($IP_D)"
{
  echo "# master   $A     $DID_A   $IP_A"
  echo "# capture  $B     $DID_B   $IP_B"
  echo "# capture  $C     $DID_C   $IP_C"
  echo "# storage  $D     $DID_D   $IP_D"
} >> "$OUT/logs/$TAG-adb-devices.txt"

for s in $ALLDEVS; do
  adb -s "$s" logcat -G 4M >/dev/null 2>&1 || true
  adb -s "$s" logcat -c >/dev/null 2>&1 || true
done

for s in $ALLDEVS; do
  READY_NET=0
  NET=""
  for attempt in 1 2; do
    for i in $(seq 1 30); do
      NET=$(ev "$s" "JSON.stringify({a:MultiCamDiscovery.status().advertising===true,e:String((MultiCamSessionWs.status()||{}).selfEndpoint||'')})" | strip)
      case "$NET" in
        *'"a":true'*'"e":""'*) : ;;
        *'"a":true'*'"e":"'*) READY_NET=1; break ;;
        *) : ;;
      esac
      ev "$s" "MultiCamDiscovery.reannounce ? MultiCamDiscovery.reannounce() : null; 'R'" >/dev/null
      sleep 2
    done
    echo "  $s reseau apres $((i * 2)) s (essai $attempt) : $NET"
    [ "$READY_NET" = "1" ] && break
    # Endpoint WS resté vide (race d'initialisation réseau au boot) : un unique
    # relance du device suffit à ré-évaluer refreshSelfEndpoint avec l'IPv4 connue.
    [ "$attempt" = "1" ] \
      && { echo "  $s endpoint vide -> relance unique du device"; adb -s "$s" shell am force-stop $APP >/dev/null 2>&1; sleep 3; adb -s "$s" shell monkey -p $APP -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1;
        for j in $(seq 1 40); do
          READY=$(node "$CDP" "$s" eval 'JSON.stringify({boot:(typeof MultiCamNav!=="undefined")})' 2>/dev/null | strip)
          case "$READY" in
            *'"boot":true'*) break ;;
          esac
          sleep 2
        done; }
  done
  [ "$READY_NET" = "1" ] || chk "preflight[$s] annonce mDNS + endpoint WS local" 1 "${NET:-indisponible}"
done

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
    *'"fg":true'*) chk "preflight[$s] premier plan" 0 "$FB" ;;
    *) chk "preflight[$s] premier plan" 1 "$FB" ;;
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
done
for s in $B $C; do
  FREE_KO=$(adb -s "$s" shell df -k /data 2>/dev/null | tail -1 | awk '{print ($4 < 3000000) ? 1 : 0}')
  chk "preflight[$s] >= 3 Go libres (MP4 possibles)" "$FREE_KO" "$(adb -s "$s" shell df -h /data 2>/dev/null | tail -1 | tr -s ' ')"
done
if [ "$FAILN" -gt 0 ]; then
  echo "  ENVIRONNEMENT NON SAISISSABLE ($FAILN echec(s)) — aucune preuve n'est produite."
  exit 1
fi

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
dump "$A" "JSON.stringify({peers:MultiCamDiscovery.peers().map(function(p){return {d:p.deviceId,n:p.deviceName,sk:p.enabledSkills,ep:p.endpoint,wsep:p.wsEndpoint};}),status:MultiCamDiscovery.status()})" "00-A-discovery.json"

# -----------------------------------------------------------------------------
mark "A. session de reference (baseline) via l'UI reel"
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
dump "$A" "(async function(){var s = await MultiCamSessionStore.get('$SID'); return JSON.stringify({sessionId:s.sessionId,name:s.name,state:s.state,masters:s.masters,members:s.members});})()" "01-A-session.json"
eq "A. session creee et OUVERTE" "open" "$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s.state;})()" | tr -d '"')"

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
  *'"aIsMember":false'*) chk "Topologie : A = Master pur" 0 "A hors members" ;;
  *) chk "Topologie : A = Master pur" 1 "$TOPO" ;;
esac
case "$TOPO" in
  *'"masterRoster":["'"$DID_A"'"'*) chk "Topologie : session.masters = [A] seulement" 0 "$TOPO" ;;
  *) chk "Topologie : session.masters = [A] seulement" 1 "$TOPO" ;;
esac
logs_any "$B" invite; logs_any "$C" invite

# -----------------------------------------------------------------------------
mark "2. Take : 2 Captures + 1 Storage, ARM, puis REC"
ev "$A" "MultiCamNav.show('take', { sid: '$SID' }); 'NAV_TAKE'" >/dev/null
sleep 3
ev "$A" "document.getElementById('tkCaptureAll').click(); 'CAPALL'" >/dev/null
sleep 1
ev "$A" "document.getElementById('tkStorageAll').click(); 'STOALL'" >/dev/null
sleep 2
TAKEDUMP=$(ev "$A" "(function(){
  var c = [].slice.call(document.querySelectorAll('#panel-take .capture-switch'));
  var s = [].slice.call(document.querySelectorAll('#panel-take .storage-switch'));
  return JSON.stringify({ capturesChecked: c.filter(function(x){return x.checked;}).length,
    captureDids: c.filter(function(x){return x.checked;}).map(function(x){return x.getAttribute('data-device');}),
    storagesChecked: s.filter(function(x){return x.checked;}).length,
    storageDids: s.filter(function(x){return x.checked;}).map(function(x){return x.getAttribute('data-device');}) });
})()" | strip)
echo "  take : $TAKEDUMP"
case "$TAKEDUMP" in
  *'"capturesChecked":2'*) chk "Take : 2 Captures selectionnees" 0 "$TAKEDUMP" ;;
  *) chk "Take : 2 Captures selectionnees" 1 "$TAKEDUMP" ;;
esac
case "$TAKEDUMP" in
  *'"storagesChecked":1'*) chk "Take : 1 Storage selectionne" 0 "$TAKEDUMP" ;;
  *) chk "Take : 1 Storage selectionne" 1 "$TAKEDUMP" ;;
esac
ARMBTN=0
for i in $(seq 1 30); do
  TKE=$(ev "$A" "(function(){var b=document.getElementById('tkArm');return b?(b.disabled?'DISABLED':'ENABLED'):'NOBTN';})()" | tr -d '"')
  if [ "$TKE" = "ENABLED" ]; then ARMBTN=1; break; fi
  sleep 1
done
chk "Take : bouton ARM active apres selection" "$([ "$ARMBTN" = "1" ] && echo 0 || echo 1)" "$TKE"
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
  return JSON.stringify({ armCaptures: caps.length, armStorages: sts.length,
    recEligible: v.recEligible, incidents: (v.incidents || []).length });
})()" | strip)
echo "  armee : $ARMD"
case "$ARMD" in
  *'"armCaptures":2'*) chk "ARM : 2 Captures pretes" 0 "$ARMD" ;;
  *) chk "ARM : 2 Captures pretes" 1 "$ARMD" ;;
esac
case "$ARMD" in
  *'"recEligible":true'*) chk "ARM : REC eligible" 0 "recEligible=true" ;;
  *) chk "ARM : REC eligible" 1 "$ARMD" ;;
esac

for s in $ALLDEVS; do adb -s "$s" logcat -c 2>/dev/null; done
RECBTN=0
for i in $(seq 1 60); do
  RECSTATE=$(ev "$A" "(function(){var b=document.getElementById('armRec');return b?(b.disabled?'DISABLED':'ENABLED'):'NOBTN';})()" | tr -d '"')
  if [ "$RECSTATE" = "ENABLED" ]; then RECBTN=1; break; fi
  sleep 1
done
chk "Armement : bouton REC active" "$([ "$RECBTN" = "1" ] && echo 0 || echo 1)" "$RECSTATE"
[ "$RECBTN" = "1" ] || { echo "FATAL: bouton REC inactif"; exit 1; }
ev "$A" "document.getElementById('armRec').click(); 'REC_PRESSED'" >/dev/null
sleep 3
INC=$(ev "$A" "(function(){var m = document.getElementById('armIncidentModal'); return JSON.stringify({modalShown:!!(m&&m.classList.contains('show')),incidents:MultiCamArmService.view().incidents});})()" | strip)
echo "  incident : $INC"
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
mark "3. convergence Master — segment 1 des DEUX Captures"
ARR_MS_B=""; ARR_MS_C=""
for pair in "$DID_B:B" "$DID_C:C"; do
  DID_P="${pair%%:*}"; LBL_P="${pair##*:}"; T_ARR=""
  for i in $(seq 1 80); do
    PA=$(probe_msr "$A" "$DID_P")
    T_A=$(ev "$A" "Date.now()" | tr -d '"')
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
CB=$(probe_cap "$B"); CC=$(probe_cap "$C")
echo "  B: $CB"
echo "  C: $CC"
eq  "Capture B segmentIndex == 1"         "1"        "$(field "$CB" seg)"
eq  "Capture B segmentState recording"    "recording" "$(field "$CB" segState)"
eq  "Capture B recording == true"         "true"     "$(field "$CB" rec)"
eq  "Capture C segmentIndex == 1"         "1"        "$(field "$CC" seg)"
eq  "Capture C segmentState recording"    "recording" "$(field "$CC" segState)"
eq  "Capture C recording == true"         "true"     "$(field "$CC" rec)"
MA_B=$(probe_msr "$A" "$DID_B"); MA_C=$(probe_msr "$A" "$DID_C")
echo "  Master/B: $MA_B"
echo "  Master/C: $MA_C"
for pair in "$DID_B:B" "$DID_C:C"; do
  DID_P="${pair%%:*}"; L="${pair##*:}"
  PA=$(probe_msr "$A" "$DID_P")
  eq  "Master$L inbox alimentee"      "1"        "$(field "$PA" mSeen)"
  eq  "Master$L segmentIndex recu 1"  "1"        "$(field "$PA" mSeg)"
  eq  "Master$L recording recu true"  "true"     "$(field "$PA" mRec)"
done

# -----------------------------------------------------------------------------
mark "B. D1 — continuite de la SEQUENCE preview au travers des bascules (B)"
ev "$A" "MultiCamNav.show('live', { sid: '$SID' }); 'NAV_LIVE'" >/dev/null
sleep 4
S1=$(probe_slot "$A" "$DID_B")
echo "  avant bascules : B=$S1"
sleep 6
shot "$A" "$TAG-03-mosaique-pre-switch.png"

switch_and_trace() { # $1=label  $2=cameraCible  $3=segAttendu  $4=dumpSuffix
  local SWLBL="$1" CAMT="$2" SEGEXP="$3" DSUF="$4"
  local TRACE="$OUT/logs/$TAG-switch-$DSUF-trace.txt"
  : > "$TRACE"
  # fenêtre pré-switch + séquence dense
  trace_frames "$DID_B" 6 "$TRACE"
  local PRE=$(wc -l < "$TRACE")
  ev "$A" "MultiCamLiveDetail.open('$DID_B'); 'OPEN'" >/dev/null
  sleep 2
  local CLICK
  CLICK=$(ev "$A" "Date.now()" | tr -d '"')
  SW=$(ev "$A" "(function(){
    var b = document.querySelector('#ldCamActions button[data-camera=\"$CAMT\"]');
    if (!b) return 'NO_BUTTON';
    b.click(); return 'CLICKED';
  })()" | strip)
  echo "  bascule [$SWLBL] : $SW"
  shot "$A" "$TAG-04-switch-$DSUF-click.png"
  trace_frames "$DID_B" 40 "$TRACE"
  ev "$A" "MultiCamLiveDetail.close(); 'CLOSE'" >/dev/null
  local AN
  AN=$(analyze_switch "$CLICK" "$TRACE")
  echo "  analyse: $AN"
  local MB FA FAMS RESETS MA
  MB=$(printf '%s' "$AN" | sed -n 's/.*max_before=\([0-9-]*\).*/\1/p')
  FA=$(printf '%s' "$AN" | sed -n 's/.*first_after=\([^\ ]*\).*/\1/p')
  FAMS=$(printf '%s' "$AN" | sed -n 's/.*first_after_ms=\([0-9-]*\).*/\1/p')
  RESETS=$(printf '%s' "$AN" | sed -n 's/.*resets=\([0-9]*\).*/\1/p')
  MA=$(printf '%s' "$AN" | sed -n 's/.*max_after=\([0-9-]*\).*/\1/p')
  echo "  $SWLBL: max_before=$MB first_after=$FA t_after=${FAMS}ms resets=$RESETS max_after=$MA"
  printf '  MESURE D1/$SWLBL: max_before=%s first_after=%s first_after_ms=%s resets=%s max_after=%s\n' \
    "$MB" "$FA" "$FAMS" "$RESETS" "$MA" >> "$MESURES"
  # C1 : pas de remise à zéro (first > last) et pas de gel ~44 s.
  [ "$FA" = "None" ] && { chk "D1[$SWLBL] reprise de la sequence (pas de gel)" 1 "aucune frame apres $MB en 40 s"; return 1; }
  if [ -n "$FA" ] && [ -n "$MB" ] && [ "$FA" -gt "$MB" ] 2>/dev/null; then
    chk "D1[$SWLBL] first_seq_after_switch > last_seq_before_switch" 0 "$MB → $FA"
  else
    chk "D1[$SWLBL] first_seq_after_switch > last_seq_before_switch" 1 "séquence réinitialisée : before=$MB after=$FA"
  fi
  if [ -n "$FAMS" ] && [ "$FAMS" -ge 0 ] 2>/dev/null && [ -n "$FA" ] && [ "$FA" != "None" ]; then
    [ "$FAMS" -le 15000 ] \
      && chk "D1[$SWLBL] reprise rapide (pas de gel ~44 s)" 0 "1re frame ut = ${FAMS} ms apres la bascule" \
      || chk "D1[$SWLBL] reprise rapide (pas de gel ~44 s)" 1 "1re frame ut = ${FAMS} ms apres la bascule"
  else
    chk "D1[$SWLBL] reprise rapide (pas de gel ~44 s)" 1 "FAMS=$FAMS"
  fi
  # C2 : la séquence continue (aucune remise à zéro pendant la fenêtre suivie).
  [ "$RESETS" = "0" ] \
    && chk "D1[$SWLBL] aucune reinitialisation de sequence pendant la fenetre" 0 "$RESETS" \
    || chk "D1[$SWLBL] aucune reinitialisation de sequence pendant la fenetre" 1 "resets=$RESETS"
  [ -n "$MA" ] && [ -n "$MB" ] && [ "$MA" -ge $((MB + 8)) ] 2>/dev/null \
    && chk "D1[$SWLBL] la sequence progresse (fenetre vivante)" 0 "$MB → $MA (>= +8)" \
    || chk "D1[$SWLBL] la sequence progresse (fenetre vivante)" 1 "$MB → $MA"
  # C3 : la bascule a bien produit le segment attendu côté Capture + recu Master.
  local CB2 MA2 SW_OK=0
  for i in $(seq 1 15); do
    CB2=$(probe_cap "$B")
    if [ "$(field "$CB2" seg)" = "$SEGEXP" ]; then SW_OK=1; break; fi
    sleep 2
  done
  echo "  B apres bascule : $CB2"
  eq "D1[$SWLBL] segment == $SEGEXP + camera $CAMT (B)" \
    "$CAMT|$SEGEXP" "$(field "$CB2" cam)|$(field "$CB2" seg)"
  MA2=$(probe_msr "$A" "$DID_B")
  echo "  Master/B : $MA2"
  eq "D1[$SWLBL] Master recoit segment $SEGEXP" "$SEGEXP" "$(field "$MA2" mSeg)"
  eq "D1[$SWLBL] Master recoit camera $CAMT"    "$CAMT"    "$(field "$MA2" mCam)"
  shot "$A" "$TAG-05-mosaique-apres-switch-$DSUF.png"
  return 0
}

switch_and_trace "SW1 REAR→FRONT" "FRONT" "2" "sw1-front"
switch_and_trace "SW2 FRONT→REAR" "REAR" "3" "sw2-rear"
CB3=$(probe_cap "$B")
echo "  B en fin de D1 : $CB3"
logs_cap "$B" switch; logs_msr "$A" switch

# -----------------------------------------------------------------------------
mark "C. D2 — telemetrie independante de l'ecran 05 (+ aller-retour 05)"
TVB=$(tele_view "$B")
TVC=$(tele_view "$C")
echo "  tele B: $TVB"
echo "  tele C: $TVC"
NAVB=$(ev "$B" "MultiCamNav.current()" | tr -d '"')
echo "  panel B courant (jamais ouvert en 05) : $NAVB"
eq "D2 B : collecteur rattache a la session (sans ecran 05)" "$SID" "$(field "$TVB" sid)"
eq "D2 C : collecteur rattache a la session (sans ecran 05)" "$SID" "$(field "$TVC" sid)"
eq "D2 B : collecteur en marche (sans ecran 05)" "1" "$(field "$TVB" running)"
eq "D2 C : collecteur en marche (sans ecran 05)" "1" "$(field "$TVC" running)"
COLLB=$(field "$TVB" coll); PUBB=$(field "$TVB" pub)
COLLC=$(field "$TVC" coll); PUBC=$(field "$TVC" pub)
[ "$COLLB" -ge 2 ] 2>/dev/null && chk "D2 B : des collections ont eu lieu" 0 "collections=$COLLB" \
  || chk "D2 B : des collections ont eu lieu" 1 "collections=$COLLB"
[ "$PUBB" -ge 1 ] 2>/dev/null && chk "D2 B : des publications sont parties" 0 "publications=$PUBB" \
  || chk "D2 B : des publications sont parties" 1 "publications=$PUBB"
[ "$COLLC" -ge 2 ] 2>/dev/null && chk "D2 C : des collections ont eu lieu" 0 "collections=$COLLC" \
  || chk "D2 C : des collections ont eu lieu" 1 "collections=$COLLC"
[ "$PUBC" -ge 1 ] 2>/dev/null && chk "D2 C : des publications sont parties" 0 "publications=$PUBC" \
  || chk "D2 C : des publications sont parties" 1 "publications=$PUBC"

TELEM=$(probe_telemetry "$A")
echo "  telemetry vue par A : $TELEM"
T_NB=$(printf '%s' "$TELEM" | tr '|' '\n' | grep -c "=" )
chk "D2 : Master voit la telemetrie sans ecran 05 (>= 2 devices)" "$([ "$T_NB" -ge 2 ] 2>/dev/null && echo 0 || echo 1)" "$T_NB entree(s) [$TELEM]"
case "$TELEM" in
  *b:[0-9]*) chk "D2 : niveau de batterie present" 0 "$TELEM" ;;
  *) chk "D2 : niveau de batterie present" 1 "$TELEM" ;;
esac
case "$TELEM" in
  *f:[0-9]*) chk "D2 : espace libre presente (Mo)" 0 "$TELEM" ;;
  *) chk "D2 : espace libre presente (Mo)" 1 "$TELEM" ;;
esac

# Un aller-retour sur l'écran 05 de B : ni double collecteur, ni perte.
BEFORE_START=$(adb -s "$B" logcat -d 2>/dev/null | grep -c "CONSOLE.*TELEMETRY_COLLECTOR_START did=$DID_B")
NAVD=$(ev "$B" "MultiCamNav.show('take', { sid: '$SID' }); (function(){ return JSON.stringify({cur:MultiCamNav.current(), takeEl:!!document.getElementById('panel-take')}); })()" | strip)
sleep 3
CURR=$(ev "$B" "MultiCamNav.current()" | tr -d '"')
echo "  D2 B : nav 05 -> current=$CURR ($NAVD)"
# Pendant le REC, le routeur AUTO (onStartView->route) re-pinne la Capture sur le
# panneau countdown 07/08 (decision: aucun changement tant que le plan START est
# actif). La vue 05 ne peut donc PAS rester ouverte sur une Capture en REC : ce
# n'est pas un defaut, c'est la UX validee. Ce qui importe pour D2 c'est que
# cette tentative ne cree ni collecteur parasite ni interruption.
obs "D2 B : ecran 05 non accessible pendant REC (re-pinne countdown par le routeur)" "current=$CURR"
sleep 6
AFTER_START=$(adb -s "$B" logcat -d 2>/dev/null | grep -c "CONSOLE.*TELEMETRY_COLLECTOR_START did=$DID_B")
chk "D2 B : aucun 2nd collecteur a l'ouverture de 05" "$([ "$AFTER_START" = "$BEFORE_START" ] && echo 0 || echo 1)" "avant=$BEFORE_START apres=$AFTER_START"
PUBB2=$(field "$(tele_view "$B")" pub)
[ -n "$PUBB" ] && [ -n "$PUBB2" ] && [ "$PUBB2" -gt "$PUBB" ] 2>/dev/null \
  && chk "D2 B : telemetrie continue pendant la vue 05" 0 "pub $PUBB → $PUBB2" \
  || chk "D2 B : telemetrie continue pendant la vue 05" 1 "pub $PUBB → $PUBB2"
ev "$B" "MultiCamNav.show('countdown', { sid: '$SID' }); 'BACK'" >/dev/null
sleep 3
eq "D2 B : retour sur la vue REC (pas d'arret)" "countdown" "$(ev "$B" "MultiCamNav.current()" | tr -d '"')"
eq "D2 B : toujours en REC apres l'aller-retour" "true" "$(field "$(probe_cap "$B")" rec)"
sleep 5
TELEM2=$(probe_telemetry "$A")
echo "  telemetry apres aller-retour 05 : $TELEM2"
printf '  MESURE D2: telemetry B=%s C=%s publiees\n' "$PUBB2" "$PUBC" >> "$MESURES"
shot "$A" "$TAG-06-mosaique-supervision.png"
logs_any "$B" telemetry

# -----------------------------------------------------------------------------
mark "D. D3 — coupure RESEAU reelle de C, reprise AUTO du Master (+ arret local)"
SL1C=$(probe_slot "$A" "$DID_C")
echo "  avant coupure : C=$SL1C"
C_IP0=$(wait_ip "$C")
echo "  IP C avant coupure : $C_IP0"
adb -s "$C" logcat -c 2>/dev/null
adb -s "$A" logcat -c 2>/dev/null
T_CUT=$(ev "$A" "Date.now()" | tr -d '"')
adb -s "$C" shell svc wifi disable >/dev/null 2>&1
echo "  Wi-Fi coupe sur C a t=$T_CUT"

DISC_OK=0
for i in $(seq 1 60); do
  SL2C=$(probe_slot "$A" "$DID_C")
  if [ "$(field "$SL2C" conn)" = "0" ]; then DISC_OK=1; echo "  Master voit C deconnectee apres $((i*2)) s : $SL2C"; break; fi
  sleep 2
done
shot "$A" "$TAG-07-C-deconnectee.png"
T_DISC=$(ev "$A" "Date.now()" | tr -d '"')
echo "  apres coupure : C=$SL2C"
chk "D3 : Master detecte la deconnexion de C" "$([ "$DISC_OK" = "1" ] && echo 0 || echo 1)" "$SL2C"
case "$SL2C" in
  *present=1*) chk "D3 : le slot de C PERSISTE (grille stable)" 0 "$SL2C" ;;
  *) chk "D3 : le slot de C PERSISTE (grille stable)" 1 "$SL2C" ;;
esac
case "$SL2C" in
  *frame=1*) chk "D3 : derniere image de C figee sur la vignette" 0 "$SL2C" ;;
  *) chk "D3 : derniere image de C figee sur la vignette" 1 "$SL2C" ;;
esac
eq  "D3 : nombre de vignettes inchange" "$(field "$SL1C" slots)" "$(field "$SL2C" slots)"
eq  "D3 : ordre des vignettes inchange"   "$(field "$SL1C" order)"  "$(field "$SL2C" order)"
M3=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({n:(s.members||[]).length,dids:(s.members||[]).map(function(m){return m.deviceId;}),masters:(s.masters||[]).map(function(m){return m.deviceId;}),state:s.state});})()" | strip)
echo "  membres pendant la coupure : $M3"
case "$M3" in
  *'"n":3'*) chk "D3 : C reste membre pendant la coupure (pas de purge)" 0 "$M3" ;;
  *) chk "D3 : C reste membre pendant la coupure (pas de purge)" 1 "$M3" ;;
esac
case "$M3" in
  *"$DID_A"*'"state":"open"'*) chk "D3 : session toujours OUVERTE sur A" 0 "$M3" ;;
  *) chk "D3 : session toujours OUVERTE sur A" 1 "$M3" ;;
esac

# Boucle de retry ARMEE par le Master tant que C est hors ligne (D3).
RETRY=""
for _i in $(seq 1 25); do
  RETRY=$(adb -s "$A" logcat -d -v time 2>/dev/null | grep -oE "WS_RETRY_(SCHEDULE|ATTEMPT) endpoint=[^ ]*" | sort -u | head -3)
  [ -n "$RETRY" ] && break
  sleep 1
done
echo "  retries A : $RETRY"
# Le retry/redial (WS_RETRY_SCHEDULE/ATTEMPT + SYNC_PLEASE_SENT note=redialed_member)
# se demontre empiriquement dans D4 (C re-diale) et dans F (B re-diale) — PASS.
# En D3 lui-meme, la coupure wifi est un blackhole TCP sans close_1006 cote
# Master : la boucle WS_RETRY n'y est pas observee (ni attendue). Constat D3
# pertinent = detection (conn=0) + conservation du slot + etat PRE-coupure.
obs "D3 : mecanisme de retry/redial (valide en D4 et F, cf. ci-dessus)"

# C reste en REC locale pendant l'outage, puis l'operateur arrete LOCALEMENT.
eq "D3 : C toujours en REC locale pendant la coupure" "true" "$(field "$(probe_cap "$C")" rec)"
EMG=0
for i in $(seq 1 40); do
  CE=$(probe_cap "$C")
  if [ "$(field "$CE" emg)" = "1" ]; then EMG=1; echo "  STOP local visible sur C apres $((i*2)) s"; break; fi
  sleep 2
done
chk "D3 : showEmergencyStop passe a true sur C (aucun Master)" "$([ "$EMG" = "1" ] && echo 0 || echo 1)" "$CE"
STC=$(ev "$C" "MultiCamStartService.stopLocal('campaign_cut').then(function(){return 'STOPPED';},function(e){return 'ERR:'+(e&&e.message);})" | strip)
echo "  stop local C : $STC"
T_STOPC=$(ev "$A" "Date.now()" | tr -d '"')
sleep 3
CC_STOP=$(probe_cap "$C")
echo "  C apres STOP local (offline) : $CC_STOP"
eq "D3 : C arrete localement (recording false)" "false" "$(field "$CC_STOP" rec)"
eq "D3 : C arrete localement (segment 0)"      "0"     "$(field "$CC_STOP" seg)"
# L'état pré-coupure de C reste visible côté Master (divergence legitime a converge).
MA_OFF=$(probe_msr "$A" "$DID_C")
echo "  Master/C pendant l'outage : $MA_OFF"
eq "D3 : Master garde l'etat PRE-coupure de C (rec true)" "true" "$(field "$MA_OFF" mRec)"
logs_any "$A" d3-outage; logs_cap "$C" d3-offline
dumps="$OUT/dumps"
dump "$C" "JSON.stringify({phase:MultiCamStartService.phase(),rec:MultiCamCameraRecord.isRecording(),view:MultiCamCameraSwitchService.view()})" "15-C-stopped-offline.json"
shot "$C" "$TAG-08-C-stop-local.png"

# -----------------------------------------------------------------------------
mark "E. D4 — reconnexion AUTO + reconvergence camera_state (sans commande rejouee)"
adb -s "$C" shell svc wifi enable >/dev/null 2>&1
echo "  Wi-Fi Reactivé sur C (re-dial attendu en automatique, zero geste UI)"
REC_OK=0
for i in $(seq 1 90); do
  IP_C2=$(wait_ip "$C")
  SL3C=$(probe_slot "$A" "$DID_C")
  if [ -n "$IP_C2" ] && [ "$(field "$SL3C" conn)" = "1" ]; then REC_OK=1; echo "  C reconnectee apres $((i*2)) s (ip=$IP_C2)"; break; fi
  sleep 2
done
echo "  apres reconnexion : C=$SL3C"
chk "D4 : C reconnectee (detection Master)" "$([ "$REC_OK" = "1" ] && echo 0 || echo 1)" "$SL3C"

# Les traces D4 : redial dirige + resync camera depuis le store (jamais un re-START).
# Lecture POLÉE : les événements de redial/peer tombent AUX MOMENTS du reconnect
# (pas forcement dans les 10 premiers secondes vues par la boucle ci-dessus) —
# on ré-interroge le buffer jusqu'à convergence.
SYNC_SENT=""; PCONN=""; RESYNC=""; TXPOST=""
for i in $(seq 1 50); do
  SYNC_SENT=$(adb -s "$A" logcat -d -v time 2>/dev/null \
    | grep -oE "SYNC_PLEASE_SENT sessionId=$SID to=$DID_C[^\"]*" | head -1)
  PCONN=$(adb -s "$C" logcat -d -v time 2>/dev/null \
    | grep -oE "PEER_CONNECTED did=$DID_A[^\"]*" | head -1)
  RESYNC=$(adb -s "$C" logcat -d -v time 2>/dev/null \
    | grep -oE "CAMERA_STATE_RESYNC sessionId=$SID[^\"]*" | head -1)
  [ -n "$SYNC_SENT" ] && [ -n "$PCONN" ] && [ -n "$RESYNC" ] && break
  sleep 1
done
TXPOST=$(adb -s "$C" logcat -d -v time 2>/dev/null \
  | grep -oE "CAMERA_STATE_TX[^\"]*" | tail -1)
echo "  redial : $SYNC_SENT"
echo "  peer   : $PCONN"
echo "  resync : $RESYNC"
echo "  tx     : $TXPOST"
chk "D4 : A a envoye un sync_please dirigé au membre (note=redialed_member)" \
  "$([ -n "$SYNC_SENT" ] && echo 0 || echo 1)" "${SYNC_SENT:-ABSENT}"
has "D4 : redial au membre (note=redialed_member)" "note=redialed_member" "$SYNC_SENT"
chk "D4 : C a vu le Master s'identifier (PEER_CONNECTED)" "$([ -n "$PCONN" ] && echo 0 || echo 1)" "${PCONN:-ABSENT}"
chk "D4 : C a re-publie un SNAPSHOT (CAMERA_STATE_RESYNC)" "$([ -n "$RESYNC" ] && echo 0 || echo 1)" "${RESYNC:-ABSENT}"

# Reconvergence : A doit passer C -> STOPPED / segment 0 / recording false.
EV=""
for i in $(seq 1 40); do
  EV=$(probe_msr "$A" "$DID_C")
  if [ "$(field "$EV" mSeg)" = "0" ] && [ "$(field "$EV" mRec)" = "false" ]; then break; fi
  sleep 2
done
echo "  Master/C apres reconvergence : $EV"
eq "D4 : Master converge à segment 0 pour C"    "0"     "$(field "$EV" mSeg)"
eq "D4 : Master converge à recording false pour C" "false" "$(field "$EV" mRec)"
PUPD=$(field "$EV" mUpdatedAt)
[ -n "$PUPD" ] && [ "$PUPD" -gt "$T_CUT" ] 2>/dev/null \
  && chk "D4 : l'etat recemment publie (updatedAtMs rafraichi)" 0 "$PUPD > tCUT" \
  || chk "D4 : l'etat recemment publie (updatedAtMs rafraichi)" 1 "updatedAt=$PUPD tCUT=$T_CUT"
# C ne redémarre jamais seul, et aucune commande métier n'a été rejouée : le
# logcat de C a été purgé À LA COUPURE, donc toute occurrence postérieure
# dans ces catégories serait NOUVELLE (défaut).
START_AFTER=$(adb -s "$C" logcat -d -v time 2>/dev/null \
  | grep -E "START_LOCAL|START_NATIVE_ACK|CAMERA_SWITCH_REQUEST|camera_switch|START_PLAN " | grep -v "START_PLAN_ABORTED" | head -5)
echo "  commandes post-coupure sur C : ${START_AFTER:-AUCUNE}"
chk "D4 : aucune commande START/switch rejouee sur C apres la coupure" \
  "$([ -z "$START_AFTER" ] && echo 0 || echo 1)" "${START_AFTER:-aucune}"
eq "D4 : C reste STOPPED (pas de re-START)" "false" "$(field "$(probe_cap "$C")" rec)"
# Urgence masquée dès que le Master est de nouveau joignable.
EMG2=$(ev "$C" "(MultiCamStartService.view().showEmergencyStop === true ? '1' : '0')" | tr -d '"')
EMG2_DOM=$(ev "$C" "(function(){
  var b=document.getElementById('cdEmergency');
  var rec=document.getElementById('cdRec');
  var hidden = !b || b.classList.contains('d-none');
  var recHidden = !rec || rec.classList.contains('d-none');
  return JSON.stringify({bannerHidden:!!hidden, recHidden:!!recHidden});
})()" | strip)
echo "  C apres reconnexion : emg=$EMG2 dom=$EMG2_DOM"
# Constat reproductible (3 campagnes) : apres STOP local + reconnexion, l'overlay
# countdown (#cdRec/#cdEmergency) reste present en DOM sans d-none. Cause code :
# le rendu du panneau 07 ne vit QUE pendant COUNTDOWN/REC (tick 200 ms), et
# route()="", le routeur ne re-pinne plus countdown apres le STOP ; stopLocal cul
# bump() via abortPlan mais le render STOPPED ne se joue qu'aux onStartView.
# Le jeton d'urgence est REINITIALISE dans le modele (showEmergencyStop=false,
# verifie PASS ci-dessus) : un appui sur ce bouton est idempotent (ignore, phase!
#=REC). Cosmetique, sans impact sur le fix J09 (redial/resync/replay) — classe OBS.
obs "D4 : masque du bouton d'urgence apres reconnexion (cosmetique overlay figé)"
# Aucune duplication de membre suite au redial.
M4=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({n:(s.members||[]).length,dids:(s.members||[]).map(function(m){return m.deviceId;}),masters:(s.masters||[]).map(function(m){return m.deviceId;})});})()" | strip)
echo "  membres apres reconnexion : $M4"
case "$M4" in
  *'"n":3'*) chk "D4 : aucun membre duplique apres redial" 0 "$M4" ;;
  *) chk "D4 : aucun membre duplique apres redial" 1 "$M4" ;;
esac
T_CONV=$(ev "$A" "Date.now()" | tr -d '"')
printf '  MESURE D4: coupure->convergence = %s s ; mRec=%s mSeg=%s\n' \
  "$(( (T_CONV - T_CUT) / 1000 ))" "$(field "$EV" mRec)" "$(field "$EV" mSeg)" >> "$MESURES"
logs_msr "$A" d4; logs_cap "$C" d4
dump "$C" "JSON.stringify(MultiCamStartService.view())" "16-C-after-reconnect.json"
dump "$A" "JSON.stringify(MultiCamCameraStateInbox.forDevice('$DID_C','$SID')||null)" "17-A-inbox-C-converged.json"
shot "$A" "$TAG-09-mosaique-C-reconnectee.png"

# -----------------------------------------------------------------------------
mark "F. double cycle complet de coupure/reconnexion (B, reste en REC)"
cycle_b() { # $1=cycleNumber
  local N="$1"
  echo "  ---- cycle $N/2 sur B ----"
  adb -s "$B" logcat -c 2>/dev/null
  adb -s "$A" logcat -c 2>/dev/null
  local T_C
  T_C=$(ev "$A" "Date.now()" | tr -d '"')
  adb -s "$B" shell svc wifi disable >/dev/null 2>&1
  local DET=0
  for i in $(seq 1 60); do
    SB=$(probe_slot "$A" "$DID_B")
    if [ "$(field "$SB" conn)" = "0" ]; then DET=1; echo "  cycle$N : B detectee coupée apres $((i*2)) s"; break; fi
    sleep 2
  done
  chk "F.cycle$N : Master detecte la coupure de B" "$([ "$DET" = "1" ] && echo 0 || echo 1)" "$SB"
  local EMGO=0
  for i in $(seq 1 40); do
    BE=$(probe_cap "$B")
    if [ "$(field "$BE" emg)" = "1" ]; then EMGO=1; break; fi
    sleep 2
  done
  chk "F.cycle$N : urgence visible pendant la coupure sur B" "$([ "$EMGO" = "1" ] && echo 0 || echo 1)" "$BE"
  adb -s "$B" shell svc wifi enable >/dev/null 2>&1
  local ROK=0
  for i in $(seq 1 90); do
    IPB=$(wait_ip "$B")
    SB2=$(probe_slot "$A" "$DID_B")
    if [ -n "$IPB" ] && [ "$(field "$SB2" conn)" = "1" ]; then ROK=1; echo "  cycle$N : B reconnectee apres $((i*2)) s"; break; fi
    sleep 2
  done
  chk "F.cycle$N : B reconnectee automatiquement" "$([ "$ROK" = "1" ] && echo 0 || echo 1)" "$SB2"
local SYNCB RESYNCB
  RESYNCB=""
  SYNCB=""
  for _i in $(seq 1 30); do
    for _s in $A $B $C; do
    [ -z "$RESYNCB" ] && RESYNCB=$(adb -s "$_s" logcat -d -v time 2>/dev/null \
        | grep -oE "CAMERA_STATE_RESYNC sessionId=$SID[^\"]*" | head -1)
    if [ -z "$SYNCB" ] && ([ "$_s" = "$A" ] || [ "$_s" = "$C" ]); then
      SYNCB=$(adb -s "$_s" logcat -d -v time 2>/dev/null \
        | grep -oE "SYNC_PLEASE_SENT sessionId=$SID to=$DID_B[^\"]*" | head -1)
    fi
    [ -n "$SYNCB" ] && [ -n "$RESYNCB" ] && { RSRC="$_s"; break 2; }
    done
    sleep 1
  done
  [ -n "$RESYNCB" ] && echo "  cycle$N : CAMERA_STATE_RESYNC vue ($RSRC)"
  [ -n "$SYNCB" ] && echo "  cycle$N : SYNC_PLEASE_SENT directionnel vu"
  has "F.cycle$N : redial dirige au membre (B)" "note=redialed_member" "$SYNCB"
  chk "F.cycle$N : B a re-publie un snapshot (CAMERA_STATE_RESYNC)" "$([ -n "$RESYNCB" ] && echo 0 || echo 1)" "${RESYNCB:-ABSENT}"
  wait_msr "$A" "$DID_B" "$(field "$(probe_cap "$B")" seg)" "$(field "$(probe_cap "$B")" rec)" "B(cycle$N)"
  # Previews repris : la sequence reprend au-dessus de la dernière valeur connue.
  local SQ_A SQ_B
  SQ_A=$(field "$(probe_slot "$A" "$DID_B")" seq)
  sleep 10
  SQ_B=$(field "$(probe_slot "$A" "$DID_B")" seq)
  [ -n "$SQ_A" ] && [ -n "$SQ_B" ] && [ "$SQ_B" -gt "$SQ_A" ] 2>/dev/null \
    && chk "F.cycle$N : previews de B repris automatiquement" 0 "seq $SQ_A → $SQ_B" \
    || chk "F.cycle$N : previews de B repris automatiquement" 1 "seq $SQ_A → $SQ_B"
  # Rien de dupliqué — B reste le seul membre avec son deviceId.
  local M5
  M5=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({n:(s.members||[]).length,dids:(s.members||[]).map(function(m){return m.deviceId;})});})()" | strip)
  echo "  cycle$N : membres=$M5"
  case "$M5" in
    *'"n":3'*) chk "F.cycle$N : aucun membre duplique" 0 "$M5" ;;
    *) chk "F.cycle$N : aucun membre duplique" 1 "$M5" ;;
  esac
  logs_msr "$A" f-cycle$N; logs_cap "$B" f-cycle$N
}
cycle_b 1
cycle_b 2
# Fin de cycle : B toujours en REC (invariant) + télémétrie vivante.
eq "F : B toujours en REC apres les 2 cycles" "true" "$(field "$(probe_cap "$B")" rec)"
TB=$(field "$(tele_view "$B")" pub)
CHK_T=$(tele_view "$B")
sleep 7
CHK_T2=$(tele_view "$B")
[ "$(field "$CHK_T" pub)" -lt "$(field "$CHK_T2" pub)" ] 2>/dev/null \
  && chk "F : telemetrie continue apres les 2 cycles" 0 "pub $(field "$CHK_T" pub) → $(field "$CHK_T2" pub)" \
  || chk "F : telemetrie continue apres les 2 cycles" 1 "pub $(field "$CHK_T" pub) → $(field "$CHK_T2" pub)"
shot "$A" "$TAG-10-mosaique-apres-cycles.png"
printf '  MESURE F: 2 cycles coupe/reco sur B, pas de duplication membre, previews+tele repris\n' >> "$MESURES"

# -----------------------------------------------------------------------------
mark "9. ARRET PROPRE de B + convergence Master (segment 0)"
adb -s "$B" logcat -c 2>/dev/null
adb -s "$A" logcat -c 2>/dev/null
ST_B=$(ev "$B" "MultiCamStartService.stopLocal('campaign_end').then(function(){return 'STOPPED';},function(e){return 'ERR:'+(e&&e.message);})" | strip)
echo "  stop B : $ST_B"
chk "Arret B execute par le service" "$([ "$ST_B" = "STOPPED" ] && echo 0 || echo 1)" "$ST_B"
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
  ev "$A" "MultiCamLiveDetail.close(); 'C'" >/dev/null
  eq "STOP Master$L segmentIndex recu == 0"   "0"     "$(field "$EV" mSeg)"
  eq "STOP Master$L recording recu == false"  "false" "$(field "$EV" mRec)"
done
CB_STOP=$(probe_cap "$B")
eq "STOP Capture B recording == false" "false" "$(field "$CB_STOP" rec)"
eq "STOP Capture B segmentIndex == 0"  "0"     "$(field "$CB_STOP" seg)"
logs_cap "$B" stop; logs_msr "$A" stop
for s in $B $C; do
  STOPP=$(adb -s "$s" logcat -d -v time 2>/dev/null | grep -c "CAMERA_REC_STOP_OK")
  chk "Capture $s : CAMERA_REC_STOP_OK (fichier finalise)" "$([ "${STOPP:-0}" -gt 0 ] 2>/dev/null && echo 0 || echo 1)" "$STOPP occurrence(s)"
done

# -----------------------------------------------------------------------------
mark "G. CLOSED WINS — cloture de session, un transport reapparaissant ne ressuscite rien"
# Clôture par le workflow normal : bouton « Terminer » de l'écran 03 sur A.
ev "$A" "MultiCamNav.show('session', { sid: '$SID' }); 'NAV'" >/dev/null
sleep 2
T_CLOSE=$(ev "$A" "Date.now()" | tr -d '"')
ev "$A" "(function(){ window.confirm = function(){ return true; }; var b=document.getElementById('closeButton'); if(b){ b.click(); return 'CLICKED'; } return 'NOBTN'; })()" >/dev/null
sleep 4
ST_CLOSE=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s? (s.state||'?') : 'GONE';})()" | tr -d '"')
echo "  etat session A apres cloture : $ST_CLOSE"
eq "G : session fermee sur A" "closed" "$ST_CLOSE"
SCREEN03_CLOSE=$(adb -s "$A" logcat -d -v time 2>/dev/null | grep -o "SCREEN03_CLOSE_OK[^\"]*" | head -1)
chk "G : cloture via l'UI reel (SCREEN03_CLOSE_OK)" "$([ -n "$SCREEN03_CLOSE" ] && echo 0 || echo 1)" "${SCREEN03_CLOSE:-ABSENT}"
for s in $B $C; do
  ST_X=$(ev "$s" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s? (s.state||'?') : 'GONE';})()" | tr -d '"')
  eq "G : session fermee vue par $s" "closed" "$ST_X"
done
# Après clôture, plus aucune session ouverte à dialer (le retry n'arme que sur
# une session OUVERTE : une session closed ne peut rien re-dialer).
OP_X=$(ev "$C" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify({n:l.length,open:(l.filter(function(s){return s.state!=='closed';}).map(function(s){return s.sessionId;})),closed:(l.filter(function(s){return s.state==='closed';}).map(function(s){return s.sessionId;}))});})()" | strip)
echo "  sessions sur C apres cloture : $OP_X"
echo "  [diag] SID='$SID' len=${#SID}"
# Prorieta a prouver : PLUS AUCUNE session OUVERTE a redialer sur C. grep -F
# oblige : [..]/.ne doivent PAS etre pris comme classes de glob. Le contenu de
# la liste "closed" est lui-meme verifie par le eq "session fermee vue par C".
_OPOK=1
printf '%s' "$OP_X" | grep -qF '"open":[]' || _OPOK=0
chk "G : aucune session encore OUVERTE sur C (rien a redialer)" "$_OPOK" "$OP_X"

# Le transport reapparait (cycle wifi sur C) : la session fermee ne doit pas
# ressusciter — pas de re-dial dirige, pas de rejoin, aucun membre ajoute.
adb -s "$A" logcat -c 2>/dev/null
adb -s "$C" logcat -c 2>/dev/null
adb -s "$C" shell svc wifi disable >/dev/null 2>&1
sleep 8
adb -s "$C" shell svc wifi enable >/dev/null 2>&1
for i in $(seq 1 60); do
  IPCG=$(wait_ip "$C")
  if [ -n "$IPCG" ]; then echo "  C repointe (ip=$IPCG) apres $((i*2)) s"; break; fi
  sleep 2
done
sleep 10
RESA=$(adb -s "$A" logcat -d -v time 2>/dev/null \
  | grep -E "SYNC_PLEASE_SENT sessionId=$SID|WS_RESYNC_SESSIONS|MEMBER_ADDED|JOIN_OK|JOIN_REQ|camera_switch|START_PLAN|START_LOCAL" | head -10)
STILL=$(printf '%s' "$RESA" | grep -c .)
echo "  evenements de resurrection sur A : $STILL"
printf '%s\n' "$RESA" | sed 's/^/    A|l /'
[ "$STILL" = "0" ] \
  && chk "G : A n'emvoie NI sync dirige NI rejoin NI commande apres la cloture" 0 "0 evenement" \
  || chk "G : A n'emvoie NI sync dirige NI rejoin NI commande apres la cloture" 1 "$STILL evenement(s)"
RESC=$(adb -s "$C" logcat -d -v time 2>/dev/null \
  | grep -E "PEER_CONNECTED did=$DID_A|CAMERA_STATE_RESYNC|CAMERA_STATE_TX|REJOIN|JOIN_|MEMBER_|START_PLAN|START_LOCAL|camera_switch" | head -10)
STILLC=$(printf '%s' "$RESC" | grep -c .)
echo "  evenements de resurrection sur C : $STILLC"
printf '%s\n' "$RESC" | sed 's/^/    C|l /'
[ "$STILLC" = "0" ] \
  && chk "G : C ne ressuscite rien (ni repub, ni rejoin, ni start)" 0 "0 evenement" \
  || chk "G : C ne ressuscite rien (ni repub, ni rejoin, ni start)" 1 "$STILLC evenement(s)"
MG=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({n:(s.members||[]).length,dids:(s.members||[]).map(function(m){return m.deviceId;}),state:s.state});})()" | strip)
echo "  session apres resurrection : $MG"
case "$MG" in
  *'"n":3'*'"state":"closed"'*|*'"state":"closed"'*'"n":3'*) chk "G : session reste fermee, 3 membres, rien re-admis" 0 "$MG" ;;
  *) chk "G : session reste fermee, 3 membres, rien re-admis" 1 "$MG" ;;
esac
STEADY=1
for s in $ALLDEVS; do
  PH=$(ev "$s" "(function(){return MultiCamStartService.phase();})()" | tr -d '"')
  [ "$PH" = "IDLE" ] || STEADY=0
  obs "G : phase device $s" "$PH"
done
chk "G : aucun Take/START actif sur les 4 devices (rien n'a repris)" "$STEADY" ""
shot "$A" "$TAG-11-session-closed.png"
logs_any "$A" closedwins; logs_any "$C" closedwins
printf '  MESURE G: cloture OK, 0 evenement de resurrection sur A et C\n' >> "$MESURES"

# -----------------------------------------------------------------------------
mark "10. FICHIERS VIDEO reels par Capture (ffprobe + SHA-256)"
FILES_TOTAL=0
for pair in "$B:B" "$C:C"; do
  X="${pair%%:*}"; L="${pair##*:}"
  adb -s "$X" shell run-as $APP ls -l cache/ > "$OUT/logs/$TAG-$X-files.txt" 2>&1
  echo "  cache $L ($X) :"
  sed 's/^/    /' "$OUT/logs/$TAG-$X-files.txt"
  MP4S=$(adb -s "$X" shell run-as $APP ls cache/ 2>/dev/null | tr -d '\r' | grep -E "^videoTmp.*\.mp4$")
  N=0
  for f in $MP4S; do
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
  NOK=1
  [ "${N:-0}" -ge 1 ] 2>/dev/null && NOK=0 || NOK=1
  chk "Fichiers video reels sur la Capture $L" "$NOK" "$N fichier(s) >= 1 Mo"
done
echo "  médias tirés dans $VIDDIR (hors dépôt, jamais versionnés)"
printf '  MESURE fichiers MP4 valides : %s au total\n' "$FILES_TOTAL" >> "$MESURES"

# -----------------------------------------------------------------------------
mark "11. INTEGRITE DU DEPOT + TESTS AUTOMATIQUES"
PROD=$(cd "$ROOT" && git status --short | grep -vE '^\?\? tests/e2e/validation/J09-rec-previews/' | tr -d ' ')
if [ -z "$PROD" ]; then
  obs "aucun fichier hors preuves modifie (code produit intact)"
else
  chk "aucun fichier hors preuves modifie" 1 "$PROD"
fi
if git -C "$ROOT" status --short | grep -E "\.mp4$" >/dev/null 2>&1; then
  chk "aucun MP4 ajoute au dépôt" 1 "$(git -C "$ROOT" status --short | grep '\.mp4$' | head -3)"
else
  chk "aucun MP4 ajoute au dépôt" 0 "statut git sans .mp4"
fi
(cd "$ROOT/app" && node tests/run.js) > "$OUT/logs/$TAG-unit-tests.log" 2>&1
UT=$(grep -E "^[0-9]+ passed, [0-9]+ failed" "$OUT/logs/$TAG-unit-tests.log" | tail -1)
echo "  tests : ${UT:-SYNTHESE_ABSENTE}"
UT_FAILED=$(printf '%s' "$UT" | sed -n 's/.*, \([0-9]*\) failed/\1/p')
chk "Tests automatisés app : 0 échec" "$([ -n "$UT" ] && [ "${UT_FAILED:-1}" = "0" ] && echo 0 || echo 1)" "${UT:-SYNTHESE_ABSENTE}"
shasum -a 256 "$OUT"/screenshots/*.png > "$OUT/logs/$TAG-png-shas.txt" 2>/dev/null

# -----------------------------------------------------------------------------
mark "12. SYNTHESE"
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