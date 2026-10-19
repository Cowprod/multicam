#!/usr/bin/env bash
# MultiCam — J14-C01 CAMPAGNE PHYSIQUE COURTE (D2, confirmée sur appareils).
#
# Objet : prouver sur appareils le correctif D2 (transfert de fichiers > 2 Gio).
#   - matrice de tailles : 1 Mio, juste sous 2 Gio, EXACTEMENT 2 Gio, > 2 Gio (2,5 Gio) ;
#   - reprise après interruption avec offset AU-DESSUS de 2 Gio (zone de débordement) ;
#   - deux téléchargements SIMULTANÉS (B->C et D->C) vers le même Storage C.
#   Preuve : SHA-256 source == SHA-256 destination + taille exacte (retour natif).
#
# Montage : B=source (capture)   D=source (capture)   C=destination (storage)   A=référence.
#   Test au niveau des briques natives (CorHttpd + MultiCamTransfer), pas de
#   l'orchestration applicative : D2 est un défaut serveur/transport, prouvé bout-en-bout.
#
# Sortie : tests/e2e/validation/J14-C01/campagne/ (refus si déjà rempli).
# Aucune suppression de média J14 : seuls les répertoires synthétiques _d2c01*/ sont nettoyés.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
D=R83Y106V1HF
DEVS="$A $B $C $D"

BASE=/sdcard/Android/data/$APP/files/MultiCam
BDIR=$BASE/_d2c01/1
DDIR=$BASE/_d2c01d/1
CDIR=$BASE/_d2c01/1

OUT="$ROOT/tests/e2e/validation/J14-C01/campagne"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "FATAL: $OUT existe et n'est pas vide — preuves existantes non écrasées."; exit 1
fi
mkdir -p "$OUT"/{logs,dumps,screenshots}
echo "demarre $(date)" > "$OUT/.run"

T0=$SECONDS
mark() { echo; echo "### [+$(( SECONDS - T0 ))s] $1" | tee -a "$OUT/logs/campaign.log"; }
run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!; wait "$p"; local r=$?; kill "$w" 2>/dev/null; return $r; }
ADB() { run_to 180 adb "$@"; }
ev() { CDP_TIMEOUT_MS=900000 run_to 900 node "$CDP" "$1" eval "$2"; }
uq() { tr -d '"'; }
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let v;try{v=JSON.parse(s)}catch(e){v={}}if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}}console.log((v&&v.$1)||'')})"; }

apk_md5_dev() { local p; p=$(ADB -s "$1" shell pm path "$APP" 2>/dev/null | uq | sed 's/package://' | head -1); ADB -s "$1" shell md5sum "$p" 2>/dev/null | awk '{print $1}'; }

# =====================================================================
mark "PHASE 0 — préparation (git / adb / APK)"
{
  echo "## Git"; echo "branche: $(git -C "$ROOT" branch --show-current)"; echo "HEAD: $(git -C "$ROOT" rev-parse HEAD)"; git -C "$ROOT" log --oneline -4
  echo; echo "## ADB"; adb devices -l | tr -d '\r'
  echo; echo "## APK local md5: $(md5 -q "$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk" 2>/dev/null)"
} > "$OUT/dumps/prep.txt" 2>&1
cat "$OUT/dumps/prep.txt" | sed 's/^/  /'

mark "PHASE 0.1 — attestation APK (md5 par appareil)"
: > "$OUT/dumps/apk-md5.txt"
for s in $A $B $C $D; do
  ADB -s "$s" get-state 2>/dev/null | grep -q device || { echo "  FATAL: $s absent"; exit 1; }
  echo "$s $(apk_md5_dev "$s")" >> "$OUT/dumps/apk-md5.txt"
done
cat "$OUT/dumps/apk-md5.txt" | sed 's/^/  /'

mark "PHASE 0.2 — démarrage de l'app sur A/B/C/D (WebView prête)"
for s in $A $B $C $D; do
  ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
  ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
done
sleep 8
for s in $A $B $C $D; do
  pid=""; tries=0
  while [ -z "$pid" ] && [ "$tries" -lt 12 ]; do
    pid=$(ADB -s "$s" shell pidof "$APP" 2>/dev/null | tr -d '\r'); [ -z "$pid" ] && sleep 3; tries=$((tries+1))
  done
  echo "  $s pid=${pid:-ABSENT}"
  [ -z "$pid" ] && { echo "  FATAL: app absente sur $s"; exit 1; }
done

# =====================================================================
mark "PHASE 1 — fichiers synthétiques sur les sources"
TINY=$(( 1 * 1024 * 1024 ))     # 1 Mio
UNDER=2147483000                # juste sous 2 Gio
EXACT=2147483648                # 2 Gio pile
OVER=2684354560                 # 2,5 Gio
CONC=$(( 512 * 1024 * 1024 ))   # 512 Mio (concurrence)
RESUME_OFF=2362232000           # ~2,2 Gio (> 2 Gio : zone de débordement int)

gen_file() { # $1=serial $2=path $3=bytes $4=rand|zero
  local s="$1" p="$2" n="$3" kind="$4" odir
  odir="${p%/*}"
  ADB -s "$s" shell "mkdir -p '$odir'" >/dev/null 2>&1
  if [ "$kind" = rand ]; then
    ADB -s "$s" shell "dd if=/dev/urandom of='$p' bs=1048576 count=$(( n / 1048576 )) 2>/dev/null" >/dev/null 2>&1
  fi
  ADB -s "$s" shell "truncate -s $n '$p'" >/dev/null 2>&1
  local got; got=$(ADB -s "$s" shell "stat -c %s '$p'" 2>/dev/null | tr -d '\r')
  echo "  $s $(basename "$p") attendu=$n obtenu=${got:-?}"
  [ "$got" = "$n" ]
}

gen_file "$B" "$BDIR/tiny.bin"  "$TINY"  rand || { echo "  FATAL gen tiny";  exit 1; }
gen_file "$B" "$BDIR/under.bin" "$UNDER" zero || { echo "  FATAL gen under"; exit 1; }
gen_file "$B" "$BDIR/exact.bin" "$EXACT" zero || { echo "  FATAL gen exact"; exit 1; }
gen_file "$B" "$BDIR/over.bin"  "$OVER"  zero || { echo "  FATAL gen over";  exit 1; }
gen_file "$B" "$BDIR/conc.bin"  "$CONC"  zero || { echo "  FATAL gen concB"; exit 1; }
gen_file "$D" "$DDIR/conc.bin"  "$CONC"  zero || { echo "  FATAL gen concD"; exit 1; }

mark "PHASE 1.1 — SHA-256 et taille des sources"
: > "$OUT/dumps/sources-sha.txt"
src_sha() { grep "^$1 $2 " "$OUT/dumps/sources-sha.txt" | awk '{for(i=1;i<=NF;i++)if($i ~ /^sha256=/){sub(/^sha256=/,"",$i);print $i}}'; }
for spec in "$B tiny.bin $BDIR" "$B under.bin $BDIR" "$B exact.bin $BDIR" "$B over.bin $BDIR" "$B conc.bin $BDIR" "$D conc.bin $DDIR"; do
  set -- $spec; s="$1"; f="$2"; dir="$3"
  h=$(ADB -s "$s" shell "sha256sum '$dir/$f'" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  z=$(ADB -s "$s" shell "stat -c %s '$dir/$f'" 2>/dev/null | tr -d '\r')
  echo "$s $f bytes=$z sha256=$h" >> "$OUT/dumps/sources-sha.txt"
done
cat "$OUT/dumps/sources-sha.txt" | sed 's/^/  /'

# =====================================================================
mark "PHASE 2 — serveurs média + autorisations (B et D)"
BURL=$(ev "$B" "(async function(){var u=await MultiCamTransferApi.serveStart({root:'$BDIR',port:8077,token:'d2tok'});await MultiCamTransferApi.serveRegister({sessionId:'_d2c01',takeNumber:1,root:'$BDIR',token:'d2tok'});return u;})()" | tail -1 | uq)
DURL=$(ev "$D" "(async function(){var u=await MultiCamTransferApi.serveStart({root:'$DDIR',port:8077,token:'d2dok'});await MultiCamTransferApi.serveRegister({sessionId:'_d2c01d',takeNumber:1,root:'$DDIR',token:'d2dok'});return u;})()" | tail -1 | uq)
echo "  BURL=$BURL"; echo "  DURL=$DURL"
echo "$BURL" > "$OUT/dumps/server-B.url"; echo "$DURL" > "$OUT/dumps/server-D.url"
case "$BURL" in http*) : ;; *) echo "  FATAL: serveur B"; exit 1 ;; esac
case "$DURL" in http*) : ;; *) echo "  FATAL: serveur D"; exit 1 ;; esac

# =====================================================================
verdict() { # $1=tag $2=cond(0/1)
  if [ "$2" = 0 ]; then echo "  RESULT $1 PASS"; echo PASS > "$OUT/dumps/result-$1.txt"; else echo "  RESULT $1 FAIL"; echo FAIL > "$OUT/dumps/result-$1.txt"; fi
}

one_dl() { # $1=tag $2=fichier $3=bytes
  local tag="$1" f="$2" n="$3" url res dsha dsz ssha
  mark "TEST $tag : B->C $f (expected=$n)"
  url="$BURL/_d2c01/1/$f"
  res=$(ev "$C" "(async function(){var r=await MultiCamTransferApi.download({url:'$url',dest:'$CDIR/$f',token:'d2tok',expected:$n},function(){});return JSON.stringify(r);})()" | tail -1)
  echo "  result=$res" | tee -a "$OUT/logs/campaign.log"
  echo "$res" > "$OUT/dumps/dl-$tag.json"
  dsha=$(echo "$res" | jget sha256)
  dsz=$(ADB -s "$C" shell "stat -c %s '$CDIR/$f'" 2>/dev/null | tr -d '\r')
  ssha=$(src_sha "$B" "$f")
  echo "  src sha=$ssha"; echo "  dst sha=$dsha size=$dsz"
  [ "$dsha" = "$ssha" ] && [ "$dsz" = "$n" ]; verdict "$tag" $?
}

one_dl "tiny"  "tiny.bin"  "$TINY"
one_dl "under" "under.bin" "$UNDER"
one_dl "exact" "exact.bin" "$EXACT"
one_dl "over"  "over.bin"  "$OVER"

# =====================================================================
mark "TEST resume : offset=$RESUME_OFF (> 2 Gio) — Range/206 au-delà de la borne 32 bits"
ADB -s "$C" shell "truncate -s $RESUME_OFF '$CDIR/over.bin'" >/dev/null 2>&1
Rres=$(ev "$C" "(async function(){var r=await MultiCamTransferApi.download({url:'$BURL/_d2c01/1/over.bin',dest:'$CDIR/over.bin',token:'d2tok',offset:$RESUME_OFF,expected:$OVER},function(){});return JSON.stringify(r);})()" | tail -1)
echo "  result=$Rres" | tee -a "$OUT/logs/campaign.log"
echo "$Rres" > "$OUT/dumps/dl-resume.json"
rsha=$(echo "$Rres" | jget sha256)
rsz=$(ADB -s "$C" shell "stat -c %s '$CDIR/over.bin'" 2>/dev/null | tr -d '\r')
echo "  src sha=$(src_sha "$B" over.bin)"; echo "  dst sha=$rsha size=$rsz"
[ "$rsha" = "$(src_sha "$B" over.bin)" ] && [ "$rsz" = "$OVER" ]; verdict "resume" $?

# =====================================================================
mark "TEST concurrence : B->C et D->C SIMULTANÉS (512 Mio chacun)"
Cres=$(ev "$C" "(async function(){var p1=MultiCamTransferApi.download({url:'$BURL/_d2c01/1/conc.bin',dest:'$CDIR/concB.bin',token:'d2tok',expected:$CONC},function(){}).catch(function(e){return {err:''+e};});var p2=MultiCamTransferApi.download({url:'$DURL/_d2c01d/1/conc.bin',dest:'$CDIR/concD.bin',token:'d2dok',expected:$CONC},function(){}).catch(function(e){return {err:''+e};});var r=await Promise.all([p1,p2]);return JSON.stringify(r);})()" | tail -1)
echo "  result=$Cres" | tee -a "$OUT/logs/campaign.log"
echo "$Cres" > "$OUT/dumps/dl-conc.json"
cshaB=$(ADB -s "$C" shell "sha256sum '$CDIR/concB.bin' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
cshaD=$(ADB -s "$C" shell "sha256sum '$CDIR/concD.bin'" 2>/dev/null | tr -d '\r' | awk '{print $1}')
cszB=$(ADB -s "$C" shell "stat -c %s '$CDIR/concB.bin'" 2>/dev/null | tr -d '\r')
cszD=$(ADB -s "$C" shell "stat -c %s '$CDIR/concD.bin'" 2>/dev/null | tr -d '\r')
echo "  B src=$(src_sha "$B" conc.bin) dstB=$cshaB sizeB=$cszB"
echo "  D src=$(src_sha "$D" conc.bin) dstD=$cshaD sizeD=$cszD"
[ "$cshaB" = "$(src_sha "$B" conc.bin)" ] && [ "$cszB" = "$CONC" ] && [ "$cshaD" = "$(src_sha "$D" conc.bin)" ] && [ "$cszD" = "$CONC" ]; verdict "concurrence" $?

# =====================================================================
mark "PHASE 3 — logs + nettoyage des répertoires synthétiques"
LOG_FILTER='TRANSFER_NATIVE|MultiCamTransfer|CorHttpd|NanoHTTPD|Range|FORBIDDEN|serve'
for s in $B $C $D; do
  ADB -s "$s" logcat -d -v time 2>/dev/null | grep -E "$LOG_FILTER" > "$OUT/logs/$s.log"
  echo "  logs $s ($(wc -l < "$OUT/logs/$s.log" | tr -d ' ') lignes)"
done
for s in $B $C $D; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; done
for s in $B $D; do ADB -s "$s" shell "rm -rf '$BASE/_d2c01' '$BASE/_d2c01d'" >/dev/null 2>&1; done
ADB -s "$C" shell "rm -rf '$CDIR'" >/dev/null 2>&1
echo "  nettoyage effectué (médias J14 intacts)"

# =====================================================================
mark "RÉSUMÉ"
PASS=0; FAIL=0
for t in tiny under exact over resume concurrence; do
  r=$(cat "$OUT/dumps/result-$t.txt" 2>/dev/null || echo MISSING)
  printf "  %-12s %s\n" "$t" "$r" | tee -a "$OUT/logs/campaign.log"
  if [ "$r" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
done
echo "  => $PASS PASS / $FAIL FAIL" | tee -a "$OUT/logs/campaign.log"
echo "$PASS $FAIL" > "$OUT/dumps/summary.txt"
echo
echo "=== CAMPAGNE D2 TERMINÉE ==="
echo "EVIDENCE_DIR=$OUT"
echo "durée=$(( SECONDS - T0 ))s  PASS=$PASS FAIL=$FAIL"
