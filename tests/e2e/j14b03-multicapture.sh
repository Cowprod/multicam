#!/usr/bin/env bash
# MultiCam — J14-B03 : intégrité des transferts multi-captures.
#
# Montage : A=61cc29567d91 (Master), B=61d54bba7d91 (Capture),
#           C=c0d8514d7d87 (Storage), D=R83Y106V1HF (Capture, SM-X110).
#
# Preuves :
#  - T1 : B et D capturent le MÊME Take vers UN SEUL Storage C.
#         C doit contenir 2 fichiers DISTINCTS (sous-dossier par source),
#         SHA-256 destination == SHA-256 source pour CHACUN (pas de collision).
#  - T2 : coupure Wi-Fi de C EN PLEIN transfert puis reprise (Range) :
#         SHA-256 final toujours == source (pas de corruption d'offset).
#
# Aucune suppression de session/média, aucun écrasement de preuves existantes.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CDP="$ROOT/tests/e2e/lib/cdp.js"
APP=fr.emmanuel.multicam
A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87; D=R83Y106V1HF
DEVS="$A $B $C $D"
NAME_A="J14B03-A-Master"; NAME_B="J14B03-B-Capture"; NAME_C="J14B03-C-Storage"; NAME_D="J14B03-D-Capture"

OUT="$ROOT/tests/e2e/validation/J14-B03"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "FATAL: $OUT existe et n'est pas vide — preuves existantes non écrasées."; exit 1
fi
mkdir -p "$OUT"/{logs,dumps,screenshots}
echo "j14b03" > "$OUT/.run"

T0=$SECONDS
mark() { echo; echo "### [+$(( SECONDS - T0 ))s] $1" | tee -a "$OUT/logs/campaign.log"; }

run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$w" 2>/dev/null; return $rc; }
ADB() { run_to 30 adb "$@"; }
ev()  { run_to 120 node "$CDP" "$1" eval "$2"; }
shot() { run_to 30 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }
dump() { echo -n "$3" | ev "$1" "$2" > "$OUT/dumps/$3"; echo "  dump $3 = $(head -c 200 "$OUT/dumps/$3")"; }

# ---- rôle / session / take (repris de j14c-campaign.sh) ----
role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }
relaunch() { ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; sleep 5; }
grant_perms() { for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do ADB -s "$1" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1; done; }
sid_by_name() { local r; r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()"); echo "${r//\"/}"; }
new_take() { local prev att out num; prev=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].takeNumber):'0';})()" | tr -d '"'); [ -z "$prev" ] && prev=0
  for att in 1 2 3; do
    out=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return 'TAKE_N='+(await MultiCamSessionWs.newTake(s)).takeNumber;})()" 2>/dev/null)
    num=$(printf '%s\n' "$out" | sed -n 's/.*TAKE_N=\([0-9][0-9]*\).*/\1/p' | tail -1)
    if [ -n "$num" ] && [ "$num" -gt "$prev" ] 2>/dev/null; then echo "  TAKE_N=$num" >&2; echo "$num"; return 0; fi
    echo "  WARN newTake sans numero (att=$att prev=$prev out=${out:-vide})" >&2; sleep 5; done
  echo "  FATAL newTake echoue (prev=$prev)" >&2; return 1; }
wait_arm_ready() { local s="$1" label="$2" poll=0
  while [ "$poll" -lt 180 ]; do
    ev "$s" "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-$label.json" 2>/dev/null
    local ok=$(node -e "
      const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-$label.json','utf8'));}catch(e){console.log('no-json');process.exit(0);}
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v||!v.active){console.log('no-active');process.exit(0);}
      const bad=(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});});
      const n=Object.keys(v.clock||{}).length;const dev=(v.devices||[]).length;
      console.log(!bad&&n>0?('yes/dev='+dev+'/clock='+n):('no/bad='+bad+'/clock='+n+'/dev='+dev));")
    echo "  wait_arm_ready $label t=${poll}s $ok"
    case "$ok" in yes*) echo "  ARM_READY $label (t=${poll}s) $ok"; return 0 ;; esac
    sleep 5; poll=$((poll+5)); done
  echo "  ARM_READY $label TIMEOUT"; return 1; }
press_rec() { local s="$1" label="$2"; echo "  PRESS_REC $label"
  ev "$s" "(function(){var b=document.getElementById('armRec');if(!b)return 'NO_BUTTON';if(b.disabled)return 'DISABLED';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 2; shot "$s" "$label-after-press"
  ev "$s" "(function(){var e=document.getElementById('armIncidentContinue');if(e&&!e.classList.contains('d-none')){e.click();return 'CONTINUE';}return 'NO_MODAL';})()" | tail -1 | sed 's/^/    /'; }
# STOP explicite : évite d'attendre le REC dur (vidéos courtes).
wait_phase() { local s="$1" want="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do local ph=$(ev "$s" "MultiCamStartService.view().phase" | tr -d '"'); [ "$ph" = "$want" ] && { echo "  phase=$want $label (t=${poll}s)"; return 0; }; sleep 2; poll=$((poll+2)); done
  echo "  phase $label = $(ev "$s" "MultiCamStartService.view().phase" | tr -d '"') (attendu=$want)"; return 1; }
take_select() { ev "$A" "document.getElementById('tkCaptureAll').click();'CAP_ALL'" >/dev/null; ev "$A" "document.getElementById('tkStorageAll').click();'STO_ALL'" >/dev/null; sleep 4; }
take_read() { ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({take:t?t.takeNumber:-1,ncap:t?t.captures.length:-1,nsto:t?t.storages.length:-1,caps:t?t.captures:[],stos:t?t.storages:[]});})()"; }

# ---- vues transfert ----
tr_view() { ev "$1" "(function(){var B=MultiCamTransferBootInstance;var v=B.viewFor('$2',$3);if(!v)return 'null';var t=v.transfers||{};return JSON.stringify(Object.keys(t).map(function(k){var o=t[k];return {k:k,state:o.state,percent:o.percent,bytes:o.bytes,total:o.total,error:o.error||'',files:(o.files||[]).map(function(f){return {rel:f.rel,state:f.state,received:f.received,bytes:f.bytes,sha256:f.sha256};})};}));})()"; }
tr_wait_done() { local sid="$1" take="$2" label="$3" bdid="$4" ddid="$5" cdid="$6" poll=0
  while [ "$poll" -lt 600 ]; do
    ev "$A" "(function(){var B=MultiCamTransferBootInstance;var v=B.viewFor('$sid',$take);if(!v)return 'null';var t=v.transfers||{};return JSON.stringify(Object.keys(t).map(function(k){var o=t[k];return k+'='+o.state+'/'+o.percent;}));})()" > "$OUT/dumps/tr-$label-${poll}s.json" 2>/dev/null
    local ok=$(node -e "
      const fs=require('fs');let s=fs.readFileSync('$OUT/dumps/tr-$label-${poll}s.json','utf8').trim();let v;try{v=JSON.parse(s)}catch(e){v=[]}if(typeof v==='string')try{v=JSON.parse(v)}catch(e){v=[]}
      if(!Array.isArray(v)){v=[]}
      const want={'$bdid|$cdid':1,'$ddid|$cdid':1};
      const seen={};
      v.forEach(x=>{const k=x.split('=')[0];const st=x.split('=')[1].split('/')[0];seen[k]=st;});
      const okB=seen['$bdid|$cdid']==='done', okD=seen['$ddid|$cdid']==='done';
      console.log((okB&&okD)?'yes':'no/'+JSON.stringify(seen));")
    echo "  tr_wait_done $label t=${poll}s $ok"
    case "$ok" in yes) return 0 ;; esac
    sleep 5; poll=$((poll+5))
  done
  echo "  tr_wait_done $label TIMEOUT"; return 1; }

logs() { ADB -s "$1" logcat -d -v time 2>/dev/null | grep -E 'TRANSFER_|MEDIA_READY|MultiCamTransfer|CorHttpd|NanoHTTPD|START_|STOP_' > "$OUT/logs/$1-$2.log"; echo "  logs $1-$2 ($(wc -l < "$OUT/logs/$1-$2.log" | tr -d ' ') lignes)"; }
logs_all() { for s in $DEVS; do logs "$s" "$1"; done; }
pid_of() { ADB -s "$1" shell pidof "$APP" 2>/dev/null | tr -d '\r' | awk '{print $1}'; }
# inventaire local Capture (source) + sha256
local_inventory() { local s="$1" sid="$2" take="$3" tag="$4"; local f="$OUT/dumps/local-sha-$tag.txt"; : > "$f"
  while IFS= read -r p; do [ -z "$p" ] && continue
    b=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
    h=$(ADB -s "$s" shell "sha256sum '$p' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
    echo "$p sha256=$h bytes=$b" >> "$f"
  done < <(ADB -s "$s" shell "find /sdcard/Android/data/$APP/files/MultiCam/$sid/$take -type f -size +0c 2>/dev/null" | tr -d '\r')
  echo "  local $tag : $(grep -c sha256 "$f" 2>/dev/null | tr -d ' ') fichier(s)"; }
# manifeste (SHA-256 source calculés par la Capture, survivent à la purge locale)
manifest_capture() { local s="$1" did="$2" tag="$3"
  ev "$s" "(function(){var v=MultiCamTransferBootInstance.view();var src=(v.sources||{})['$did'];return JSON.stringify(src?src.files:[]);})()" > "$OUT/dumps/manifest-$tag.raw"
  node -e "const fs=require('fs');let s=fs.readFileSync('$OUT/dumps/manifest-$tag.raw','utf8').trim();let v;try{v=JSON.parse(s)}catch(e){v=[]}if(typeof v==='string')try{v=JSON.parse(v)}catch(e){v=[]}if(!Array.isArray(v))v=[];console.log(v.map(f=>f.rel+' sha256='+f.sha256+' bytes='+f.bytes).join('\n'));" > "$OUT/dumps/manifest-$tag.txt" 2>/dev/null || : > "$OUT/dumps/manifest-$tag.txt"
  echo "  manifest $tag : $(grep -c sha256 "$OUT/dumps/manifest-$tag.txt" 2>/dev/null | tr -d ' ') segment(s)"; }
# inventaire Storage (destination) + sha256
dest_inventory() { local s="$1" sid="$2" take="$3" tag="$4"; local f="$OUT/dumps/dest-sha-$tag.txt"; : > "$f"
  while IFS= read -r p; do [ -z "$p" ] && continue
    b=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
    h=$(ADB -s "$s" shell "sha256sum '$p' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
    echo "$p sha256=$h bytes=$b" >> "$f"
  done < <(ADB -s "$s" shell "find /sdcard/Android/data/$APP/files/MultiCam/$sid/$take -type f -size +0c 2>/dev/null" | tr -d '\r')
  echo "  dest $tag : $(grep -c sha256 "$f" 2>/dev/null | tr -d ' ') fichier(s)"; }

# =======================================================================
mark "PHASE 1 — PREPARATION (git, adb, APK, rôles)"
{ echo "## Git"; echo "branche: $(git -C "$ROOT" branch --show-current)"; echo "HEAD: $(git -C "$ROOT" rev-parse HEAD)"; git -C "$ROOT" log --oneline -4; echo; echo "## ADB"; adb devices -l | tr -d '\r'; } > "$OUT/dumps/prep-git-adb.txt" 2>&1
sed 's/^/  /' "$OUT/dumps/prep-git-adb.txt"

mark "PHASE 1.1 — attestation APK (md5 local + installé sur les 4 devices)"
LOCAL_MD5=$(md5 -q "$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk")
{ echo "local_md5=$LOCAL_MD5"; for s in $DEVS; do p=$(ADB -s "$s" shell pm path "$APP" 2>/dev/null | tr -d '\r' | sed 's/package://'); m=$(ADB -s "$s" shell md5sum "$p" 2>/dev/null | tr -d '\r' | awk '{print $1}'); echo "$s md5=$m $([ "$m" = "$LOCAL_MD5" ] && echo MATCH || echo MISMATCH)"; done; } | tee "$OUT/dumps/apk-md5.txt"

mark "PHASE 1.2 — rôles + relance des 4 devices"
for s in $DEVS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
sleep 10
echo -n "  A="; role_cfg "$A" false false true "$NAME_A"
echo -n "  B="; role_cfg "$B" true false false "$NAME_B"
echo -n "  C="; role_cfg "$C" false true false "$NAME_C"
echo -n "  D="; role_cfg "$D" true false false "$NAME_D"
for s in $DEVS; do relaunch "$s"; grant_perms "$s"; done
sleep 6

mark "PHASE 1.3 — nouvelle session sur A (anciennes conservées)"
RUN_TAG="J14B03-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "  RUN_TAG=$RUN_TAG"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 3
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CREATE';})()" >/dev/null; sleep 8
SID=$(sid_by_name "$A" "$SNAME"); echo "  SESSION_CREATED sid=$SID name='$SNAME'"
{ [ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ]; } && { echo "FATAL: session introuvable"; exit 1; }
echo "$SID" > "$OUT/dumps/sid.txt"
PIN=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s.pin;})()" | tr -d '"')
echo "  PIN=$PIN"

mark "PHASE 1.4 — jonction B, C, D"
for dev in $B $C $D; do
  a="0"; poll=0
  while [ "$poll" -lt 90 ]; do
    a=$(ev "$dev" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$SID';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()"); a="${a//\"/}"
    [ "$a" != "0" ] && break; sleep 3; poll=$((poll+3))
  done
  [ "$a" = "0" ] && { echo "  FATAL: $dev ne voit pas $SID"; exit 1; }
  echo "  ANNOUNCE_OK $(echo "$dev" | cut -c1-8) $a"
  JH="${a%%:*}"; JP="${a##*:}"
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_PIN';})()" >/dev/null
  poll=0; ok=no
  while [ "$poll" -lt 120 ]; do
    has=$(ev "$dev" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'yes':'no';})()"); has="${has//\"/}"
    [ "$has" = "yes" ] && { ok=yes; break; }; sleep 5; poll=$((poll+5))
  done
  [ "$ok" = "yes" ] && echo "  SESSION_JOINED $(echo "$dev" | cut -c1-8) (t=${poll}s)" || { echo "  FATAL: $dev n'a pas rejoint"; exit 1; }
done

BDID=$(ev "$B" "MultiCamSessionWs.status().localDid" | tr -d '"')
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" | tr -d '"')
DDID=$(ev "$D" "MultiCamSessionWs.status().localDid" | tr -d '"')
echo "  BDID=$BDID CDID=$CDID DDID=$DDID"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$NAME_B',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$NAME_C',enabledSkills:['storage']},['storage']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'$NAME_D',enabledSkills:['capture']},['capture']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/members.json"
echo "  membres: $(cat "$OUT/dumps/members.json")"; sleep 5

# =======================================================================
# T1 : preuve anti-collision (2 captures → 1 storage)
# =======================================================================
mark "TAKE T1 — 2 captures (B+D) → 1 storage (C)"
T1=$(new_take); echo "  T1=$T1"
ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
take_select; take_read > "$OUT/dumps/participants-T1.json"; echo "  participants=$(cat "$OUT/dumps/participants-T1.json")"
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
wait_arm_ready "$A" "T1" || echo "  WARN ARM non pret T1"
press_rec "$A" "T1"
wait_phase "$A" "REC" "T1" || echo "  WARN pas de REC T1"
sleep 3; echo "  phases REC: A=$(ev "$A" 'MultiCamStartService.view().phase' | tr -d '"') B=$(ev "$B" "MultiCamStartService.view().phase" | tr -d '"') D=$(ev "$D" "MultiCamStartService.view().phase" | tr -d '"')"
for s in $A $B $D; do shot "$s" "T1-rec"; done
echo "  enregistrement 60s..."; sleep 60
ev "$A" "MultiCamStartService.requestStop('T1')" >/dev/null 2>&1; echo "  STOP_REQUEST T1"
wait_phase "$A" "STOPPED" "T1" || echo "  WARN STOP non atteint T1"
sleep 3
echo "  phases STOP: A=$(ev "$A" 'MultiCamStartService.view().phase' | tr -d '"') B=$(ev "$B" "MultiCamStartService.view().phase" | tr -d '"') D=$(ev "$D" "MultiCamStartService.view().phase" | tr -d '"')"
shot "$A" "T1-stopped"
# inventaire local des sources IMMÉDIATEMENT (avant purge post-réplication)
local_inventory "$B" "$SID" "$T1" "T1-B"
local_inventory "$D" "$SID" "$T1" "T1-D"
manifest_capture "$B" "$BDID" "T1-B"
manifest_capture "$D" "$DDID" "T1-D"
# attente transferts B→C et D→C
tr_wait_done "$SID" "$T1" "T1" "$BDID" "$DDID" "$CDID" || echo "  WARN transfers T1 non terminés dans le délai"
tr_view "$A" "$SID" "$T1" > "$OUT/dumps/tr-A-T1.json"
tr_view "$C" "$SID" "$T1" > "$OUT/dumps/tr-C-T1.json"
sleep 3
# inventaire destination sur C : DOIT contenir un sous-dossier par source
dest_inventory "$C" "$SID" "$T1" "T1-C"
ADB -s "$C" shell "find /sdcard/Android/data/$APP/files/MultiCam/$SID/$T1 -type d 2>/dev/null" | tr -d '\r' > "$OUT/dumps/dirs-C-T1.txt"
logs_all "T1"

# =======================================================================
# T2 : preuve de reprise (coupure Wi-Fi C en plein transfert)
# =======================================================================
mark "TAKE T2 — coupure Wi-Fi C en plein transfert puis reprise (Range)"
T2=$(new_take); echo "  T2=$T2"
ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
take_select; take_read > "$OUT/dumps/participants-T2.json"; echo "  participants=$(cat "$OUT/dumps/participants-T2.json")"
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
wait_arm_ready "$A" "T2" || echo "  WARN ARM non pret T2"
press_rec "$A" "T2"
wait_phase "$A" "REC" "T2" || echo "  WARN pas de REC T2"
sleep 60
ev "$A" "MultiCamStartService.requestStop('$T2')" >/dev/null 2>&1; echo "  STOP_REQUEST T2"
wait_phase "$A" "STOPPED" "T2" || echo "  WARN STOP non atteint T2"
# surveille l'apparition d'une progression PUREMENT partielle sur C, puis coupe
ipoll=0; caught=no
while [ "$ipoll" -lt 40 ]; do
  js=$(ev "$C" "(function(){var B=MultiCamTransferBootInstance;var out=[];['$BDID','$DDID'].forEach(function(src){var v=B.viewFor('$SID',$T2);if(!v)return;var o=(v.transfers||{})[src+'|$CDID'];if(!o)return;o.files.forEach(function(f){if(f.received>0&&f.received<f.bytes)out.push(src+':'+f.received+'/'+f.bytes);});});return out.join(',');})()" | tr -d '"')
  echo "  [t=${ipoll}s] partiel: ${js:--}"
  case "$js" in *":"*"/"*) caught=yes; break ;; esac
  sleep 1; ipoll=$((ipoll+1))
done
echo "  caught_partial=$caught" | tee "$OUT/dumps/t2-caught-partial.txt"
if [ "$caught" = "yes" ]; then
  adb -s "$C" shell svc wifi disable >/dev/null 2>&1; echo "  C wifi disable (plein transfert)"
  sleep 20
  adb -s "$C" shell svc wifi enable >/dev/null 2>&1; echo "  C wifi enable"
  sleep 20
  ev "$A" "(function(){try{MultiCamTransferBootInstance.retry('$BDID');MultiCamTransferBootInstance.retry('$DDID');return 'RETRY';}catch(e){return 'ERR';}})()" >/dev/null 2>&1
else
  echo "  WARN: pas de transfert partiel capté — coupure non exercée"
fi
local_inventory "$B" "$SID" "$T2" "T2-B"
local_inventory "$D" "$SID" "$T2" "T2-D"
manifest_capture "$B" "$BDID" "T2-B"
manifest_capture "$D" "$DDID" "T2-D"
tr_wait_done "$SID" "$T2" "T2" "$BDID" "$DDID" "$CDID" || echo "  WARN transfers T2 non terminés dans le délai"
tr_view "$A" "$SID" "$T2" > "$OUT/dumps/tr-A-T2.json"
tr_view "$C" "$SID" "$T2" > "$OUT/dumps/tr-C-T2.json"
sleep 3
dest_inventory "$C" "$SID" "$T2" "T2-C"
logs_all "T2"

# =======================================================================
# RAPPORT DE VÉRIFICATION
# =======================================================================
mark "PHASE 5 — vérification intégrité (source vs destination, par source)"
: > "$OUT/dumps/verdict.txt"
verify_take() { local take="$1" label="$2"
  OUTD="$OUT/dumps" TAKEv="$take" LABELv="$label" BDIDv="$BDID" DDIDv="$DDID" SIDv="$SID" node <<'NODE'
const fs=require('fs');
const OUTD=process.env.OUTD, TAKE=process.env.TAKEv, LABEL=process.env.LABELv, BDID=process.env.BDIDv, DDID=process.env.DDIDv, SID=process.env.SIDv;
const read=(f)=>{try{return fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean);}catch(e){return[]}};
const parse=(l)=>{const m=l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);return m?{p:m[1],base:m[1].split('/').pop(),sha:m[2],bytes:m[3]}:null};
function srcOf(did,tag){let s=read(OUTD+'/local-sha-'+tag+'.txt').map(parse).filter(Boolean); let k='local'; if(!s.length){s=read(OUTD+'/manifest-'+tag+'.txt').map(parse).filter(Boolean);k='manifest';} return {did,k,rows:s};}
const dst=read(OUTD+'/dest-sha-'+LABEL+'-C.txt').map(parse).filter(Boolean);
const B=srcOf(BDID,LABEL+'-B'), D=srcOf(DDID,LABEL+'-D');
let ok=true, lines=['## '+LABEL+' (take='+TAKE+') sid='+SID];
lines.push('destination C fichiers: '+dst.length);
function cmp(S,t){ lines.push(t+' ('+S.k+'): '+S.rows.length+' segment(s)'); if(!S.rows.length){ok=false; lines.push('  -> ECHEC AUCUNE SOURCE'); return;} S.rows.forEach(s=>{const d=dst.find(x=>x.p.includes('/'+S.did+'/')&&x.base===s.base); if(!d){ok=false; lines.push('  '+s.base+' -> MANQUANT'); return;} const same=(d.sha===s.sha&&String(d.bytes)===String(s.bytes)); if(!same)ok=false; lines.push('  '+s.base+' src.sha='+s.sha+' dst.sha='+d.sha+' src.b='+s.bytes+' dst.b='+d.bytes+' '+(same?'OK':'ECHEC'));});}
cmp(B,'B'); cmp(D,'D');
const bf=dst.filter(x=>x.p.includes('/'+BDID+'/')), df=dst.filter(x=>x.p.includes('/'+DDID+'/'));
const distinct=bf.length>0&&df.length>0&&bf.every(b=>!df.some(d=>d.p===b.p));
if(!distinct)ok=false;
lines.push('anti-collision: B.files='+bf.length+' D.files='+df.length+' chemins_distincts='+distinct);
lines.push('VERDICT '+LABEL+': '+(ok?'PASS':'FAIL'));
fs.appendFileSync(OUTD+'/verdict.txt', lines.join('\n')+'\n');
console.log(lines.join('\n'));
NODE
}

verify_take "$T1" "T1"
verify_take "$T2" "T2"

echo
echo "=== J14-B03 TERMINÉ ==="
echo "EVIDENCE_DIR=$OUT"
echo "SID=$SID T1=$T1 T2=$T2"
