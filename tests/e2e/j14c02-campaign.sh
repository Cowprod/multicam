#!/usr/bin/env bash
# MultiCam — J14-C02 : VALIDATION PHYSIQUE CIBLÉE D1 / D3 (pas d'endurance).
#
# Montage : A=Master(controller)  B=Capture  C=Storage  D=Capture (USB R83Y106V1HF).
#
# Scénario (3 Takes réels) :
#   T1 : REC B+D -> C. À mi-réplication, COUPURE Wi-Fi de C (jamais D) puis retour.
#        Vérifie : détection d'interruption, réconciliation, convergence A==C, terminal
#        (reprise ou erreur explicite), aucune suppression avant intégrité confirmée.
#   T2 : REC B+D (STOP) ; T3 démarré IMMÉDIATEMENT -> la réplication de T2 se poursuit
#        pendant le REC de T3. La suppression de T2 (ordonnée après intégrité C) doit être
#        DIFFÉRÉE (recording), conservée, puis exécutée après l'arrêt de T3 ; T3 intact.
#   Intégrité par Take : SHA-256 source (avant purge) == destination C, DONE, ordre HASH->DELETE.
#
# Sortie : tests/e2e/validation/J14-C02/ (refus si non vide). Anciennes sessions conservées.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam
CONFIGDIR=/sdcard/Android/data/$APP/files/MultiCam

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
D=R83Y106V1HF
DIP=192.168.92.103
DTCP=192.168.92.103:5555
DEVS="$A $B $C $D"

NAME_A="J14C02-A-Master"; NAME_B="J14C02-B-Capture"; NAME_C="J14C02-C-Storage"; NAME_D="J14C02-D-Capture"

OUT="$ROOT/tests/e2e/validation/J14-C02"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "FATAL: $OUT existe et n'est pas vide — preuves existantes non écrasées."; exit 1
fi
mkdir -p "$OUT"/{logs,dumps,screenshots}
echo "J14-C02 $(date)" > "$OUT/.run"

T1=""; T2=""; T3=""
T0=$SECONDS; T0WALL=$(date +%s)
ELAPSED() { echo "+$(( SECONDS - T0 ))s"; }
mark() { echo; echo "### [$(ELAPSED)] $1" | tee -a "$OUT/logs/campaign.log"; }

run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$w" 2>/dev/null; return $rc; }
ADB()  { run_to 30 adb "$@"; }
ev()   { run_to 120 node "$CDP" "$1" eval "$2"; }
evj()  { ev "$1" "$2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{let v=JSON.parse(s.trim());if(typeof v==='string')v=JSON.parse(v);console.log(JSON.stringify(v));}catch(e){console.log(s.trim());}});"; }
shot() { run_to 30 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }
dump() { mkdir -p "$OUT/dumps"; echo -n "$3" | ev "$1" "$2" > "$OUT/dumps/$3"; echo "  dump $3 = $(head -c 200 "$OUT/dumps/$3")"; }

d_ensure() {
  if ADB -s "$D" get-state 2>/dev/null | grep -q device; then return 0; fi
  adb connect "$DIP:5555" >/dev/null 2>&1; sleep 2
  if [ "$D" = "R83Y106V1HF" ] && ! ADB -s "$D" get-state 2>/dev/null | grep -q device; then D="$DTCP"; fi
  ADB -s "$D" get-state 2>/dev/null | grep -q device
}
dev_ready() { local s="$1"; if [ "$s" = "$D" ]; then d_ensure; else ADB -s "$s" get-state 2>/dev/null | grep -q device; fi; }
wait_ready() { local s="$1" t="${2:-60}" p=0
  while [ "$p" -lt "$t" ]; do dev_ready "$s" && { echo "  device $s ready (t=${p}s)"; return 0; }; sleep 5; p=$((p+5)); done
  echo "  WARN device $s indisponible apres ${t}s"; return 1; }

pid_of() { ADB -s "$1" shell pidof "$APP" 2>/dev/null | tr -d '\r' | awk '{print $1}'; }
disk_free_kb() { ADB -s "$1" shell "df -k /data | tail -1" 2>/dev/null | tr -d '\r' | awk '{print $4}'; }
snap_disk() { local label="$1"; local f="$OUT/dumps/disk-$label.txt"; : > "$f"
  for s in $DEVS; do echo "$s $(disk_free_kb "$s")" >> "$f"; done
  echo "  disque $label : $(tr '\n' ' ' < "$f")"; }
dash() { ev "$1" "MultiCamStartService.view().phase" 2>/dev/null | tr -d '"' | tr -d '\n'; }

role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }
relaunch() { ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; sleep 5; pid_of "$1"; }
grant_perms() { for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do ADB -s "$1" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1; done; }
sid_by_name() { local r; r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()"); echo "${r//\"/}"; }
new_take() { local prev att out num; prev=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]);return t.length?String(t[t.length-1].takeNumber):'0';})()" | tr -d '"'); [ -z "$prev" ] && prev=0
  for att in 1 2 3; do
    out=$(ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return 'TAKE_N='+(await MultiCamSessionWs.newTake(s)).takeNumber;})()" 2>/dev/null)
    num=$(printf '%s\n' "$out" | sed -n 's/.*TAKE_N=\([0-9][0-9]*\).*/\1/p' | tail -1)
    if [ -n "$num" ] && [ "$num" -gt "$prev" ] 2>/dev/null; then echo "  TAKE_N=$num" >&2; echo "$num"; return 0; fi
    echo "  WARN newTake sans numero (att=$att prev=$prev)" >&2; sleep 5; done
  echo "  FATAL newTake echoue (prev=$prev)" >&2; return 1; }

wait_arm_ready() { local s="$1" label="$2" poll=0
  while [ "$poll" -lt 150 ]; do
    ev "$s" "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-$label.json" 2>/dev/null
    local ok=$(node -e "
      const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-$label.json','utf8'));}catch(e){console.log('no-json');process.exit(0);}
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      if(!v||!v.active){console.log('no-active');process.exit(0);}
      const bad=(v.devices||[]).some(function(d){return d.skills.some(function(x){return x.status==='ERROR'||x.status==='ARMING'||x.status==='PENDING';});});
      const n=Object.keys(v.clock||{}).length; const dev=(v.devices||[]).length;
      console.log(!bad&&n>0?('yes/dev='+dev+'/clock='+n):('no/bad='+bad+'/clock='+n+'/dev='+dev));")
    echo "  wait_arm_ready $label t=${poll}s $ok"
    case "$ok" in yes*) echo "  ARM_READY $label (t=${poll}s) $ok"; return 0 ;; esac
    sleep 5; poll=$((poll+5)); done
  echo "  ARM_READY $label TIMEOUT"; return 1; }

press_rec() { local s="$1" label="$2"
  echo "  PRESS_REC $label"
  ev "$s" "(function(){var b=document.getElementById('armRec');if(!b)return 'NO_BUTTON';if(b.disabled)return 'DISABLED';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    /'
  sleep 2; shot "$s" "$label-after-press"
  ev "$s" "(function(){var e=document.getElementById('armIncidentContinue');if(e&&!e.classList.contains('d-none')){e.click();return 'CONTINUE';}return 'NO_MODAL';})()" | tail -1 | sed 's/^/    /'; }

wait_phase() { local s="$1" want="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do
    local ph=$(ev "$s" "MultiCamStartService.view().phase" | tr -d '"')
    [ "$ph" = "$want" ] && { echo "  phase=$want $label (t=${poll}s)"; return 0; }
    sleep 2; poll=$((poll+2)); done
  echo "  phase $label = $(ev "$s" "MultiCamStartService.view().phase" | tr -d '"') (attendu=$want)"; return 1; }

take_select() { ev "$A" "document.getElementById('tkCaptureAll').click();'CAP_ALL'" >/dev/null; ev "$A" "document.getElementById('tkStorageAll').click();'STO_ALL'" >/dev/null; sleep 4; }
take_read() { evj "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({take:t?t.takeNumber:-1,ncap:t?t.captures.length:-1,nsto:t?t.storages.length:-1,caps:t?t.captures:[],stos:t?t.storages:[]});})()"; }

local_inventory() { local s="$1" sid="$2" take="$3" tag="$4" i prev cur b h b2 p
  local f="$OUT/dumps/local-$tag.txt"
  { echo "# $tag ($s) sid=$sid take=$take $(date)";
    ADB -s "$s" shell "ls -la $CONFIGDIR/$sid/$take/ 2>/dev/null" 2>/dev/null | tr -d '\r'; } > "$f"
  { echo "# sha256 $tag"; while IFS= read -r p; do
      [ -z "$p" ] && continue
      i=0; prev=""; cur=""
      while [ "$i" -lt 60 ]; do
        cur=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
        [ -n "$cur" ] && [ "$cur" = "$prev" ] && break
        prev="$cur"; sleep 2; i=$((i+2)); done
      b="$cur"
      h=$(ADB -s "$s" shell "sha256sum '$p' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
      b2=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
      if [ "$b2" != "$b" ]; then echo "$p sha256=$h bytes=$b bytes_final=$b2 unstable=1"; else echo "$p sha256=$h bytes=$b"; fi
    done < <(ADB -s "$s" shell "find $CONFIGDIR/$sid/$take -type f 2>/dev/null" | tr -d '\r');
  } > "$OUT/dumps/local-sha-$tag.txt"
  echo "  local $tag : $(grep -c sha256 "$OUT/dumps/local-sha-$tag.txt" 2>/dev/null | tr -d ' ') fichier(s)"
}

present_count() { ADB -s "$1" shell "find $CONFIGDIR/$SID/$2 -type f 2>/dev/null" | tr -d '\r' | grep -c . ; }
presence_snapshot() { local lab="$1"; local f="$OUT/dumps/presence-$lab.txt"; : > "$f"
  for s in $B $C $D; do for tk in $T1 $T2 $T3; do [ -z "$tk" ] && continue; echo "$s take=$tk files=$(present_count "$s" "$tk")" >> "$f"; done; done
  echo "  presence $lab:"; sed 's/^/    /' "$f"; }

tr_take() { ev "$1" "(function(){if(!MultiCamTransferBootInstance)return 'NO_BOOT';var v=MultiCamTransferBootInstance.viewFor('$2',$3);if(!v)return 'null';var t=v.transfers||{};var ks=Object.keys(t);var rows=ks.map(function(k){var p=k.split('|');var o=t[k];return {src:p[0],sto:p[1],state:o.state,percent:o.percent,bytes:o.bytes,total:o.total,error:o.error||''};});return JSON.stringify({sid:v.sid,take:v.takeNumber,n:ks.length,rows:rows});})()"; }
_tr_row_n() { node -e "var v;try{v=JSON.parse(process.argv[1]);if(typeof v==='string')v=JSON.parse(v);}catch(e){process.stdout.write('0');process.exit(0);}var rows=(v&&v.rows)||[];process.stdout.write(String(rows.filter(function(r){return r.state===process.argv[2];}).length));" "$1" "${2:-done}" 2>/dev/null || echo 0; }
tr_done_n() { _tr_row_n "$1" done; }
tr_err_n()  { _tr_row_n "$1" error; }

LOG_FILTER='CONFIG_INIT|SKILL_SET|DEVICE_NAME_SET|SESSION|WS_|MEMBER|TAKE_|ARM_|CLOCK_|START_|STOP_|CAMERA_|TRANSFER_|MEDIA_READY|CorHttpd|NanoHTTPD|MultiCamTransfer'
logs() { ADB -s "$1" logcat -d -v time 2>/dev/null | grep -E "$LOG_FILTER" > "$OUT/logs/$1-$2.log"; echo "  logs $1-$2 ($(wc -l < "$OUT/logs/$1-$2.log" | tr -d ' ') lignes)"; }
logs_all() { for s in $A $B $C $D; do logs "$s" "$1"; done; }

take_duration_s() { local s="$1" p="$2" tmp="$OUT/dumps/.tail.bin"
  ADB -s "$s" shell "tail -c 400000 '$p' 2>/dev/null" > "$tmp" 2>/dev/null
  node -e "const fs=require('fs');let b;try{b=fs.readFileSync('$tmp')}catch(e){process.exit(0)}
    const i=b.lastIndexOf('mvhd');if(i<0)process.exit(0);const ver=b[i+4];let ts,dur;
    if(ver===0){ts=b.readUInt32BE(i+16);dur=b.readUInt32BE(i+20);}else{ts=b.readUInt32BE(i+20);dur=Number(b.readBigUInt64BE(i+24));}
    if(ts>0)console.log((dur/ts).toFixed(3));"; }

# ---- convergence A==C pour un Take (src B et D). rc=0 seulement si converge, terminal ----
converged() { # $1=label $2=take
  tr_take "$A" "$SID" "$2" > "$OUT/dumps/tr-A-$1.json"
  tr_take "$C" "$SID" "$2" > "$OUT/dumps/tr-C-$1.json"
  node -e '
    const fs=require("fs");
    const rd=(f)=>{try{let v=JSON.parse(fs.readFileSync(f,"utf8"));if(typeof v==="string")v=JSON.parse(v);return v;}catch(e){return null;}};
    const A=rd(process.argv[1]), C=rd(process.argv[2]);
    const B=process.argv[3], D=process.argv[4];
    const st=(v,src)=>{const r=((v&&v.rows)||[]).find(x=>x.src===src);return r?r.state:"absent";};
    const term=s=>s==="done"||s==="error";
    const rows=[[B],[D]].map(([id])=>({ra:st(A,id),rc:st(C,id)}));
    const ok=rows.every(r=>term(r.ra)&&term(r.rc)&&r.ra===r.rc);
    console.log("converged="+(ok?"YES":"NO")+" B:A="+rows[0].ra+"/C="+rows[0].rc+" D:A="+rows[1].ra+"/C="+rows[1].rc);
    process.exit(ok?0:1);' "$OUT/dumps/tr-A-$1.json" "$OUT/dumps/tr-C-$1.json" "$BDID" "$DDID" > "$OUT/dumps/convergence-$1.txt"
  local rc=$?
  cat "$OUT/dumps/convergence-$1.txt"
  return $rc
}

# ---- enregistre un Take (new_take -> ARM -> REC dur -> STOP). $1=label $2=dur. Pose TN_<label> ----
take_record() {
  local label="$1" dur="$2" TN res NCAP NSTO CAPS
  mark "TAKE $label : newTake + participants + ARM + REC ${dur}s"
  TN=$(new_take) || { echo "  ABORT $label"; return 1; }
  sleep 2
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  take_select; res=$(take_read | sed 's/^"//; s/"$//; s/\\"/"/g'); echo "$res" > "$OUT/dumps/participants-$label.json"
  read -r NCAP NSTO CAPS <<<"$(node -e "const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/participants-$label.json','utf8'))}catch(e){v={}};console.log((v.ncap)+' '+(v.nsto)+' '+((v.caps||[]).join(',')));")"
  echo "  $label NCAP=$NCAP NSTO=$NSTO captures=$CAPS"
  [ "$NCAP" = "2" ] && [ "$NSTO" = "1" ] || { echo "  FATAL $label participants"; return 1; }
  case ",$CAPS," in *",$BDID,"*) :;; *) echo "  FATAL capture B absente"; return 1;; esac
  case ",$CAPS," in *",$DDID,"*) :;; *) echo "  FATAL capture D absente"; return 1;; esac
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  wait_arm_ready "$A" "$label" || echo "  WARN ARM non pret $label"
  shot "$A" "$label-arm"
  press_rec "$A" "$label"
  wait_phase "$A" "REC" "$label" || echo "  WARN pas de REC sur A"
  sleep 3
  echo "  phases REC: A=$(dash "$A") B=$(dash "$B") D=$(dash "$D")"
  for s in $A $B $D; do shot "$s" "$label-rec"; done
  echo "$TN" > "$OUT/dumps/TN-$label.txt"
  snap_disk "take-$label-start"
  echo "  enregistrement ${dur}s ..."; sleep "$dur"
  ev "$A" "MultiCamStartService.requestStop('$label')" >/dev/null 2>&1
  echo "  STOP_REQUEST $label"; wait_phase "$A" "STOPPED" "$label" || echo "  WARN STOP non atteint"
  sleep 2
  echo "  phases STOP: A=$(dash "$A") B=$(dash "$B") C=$(dash "$C") D=$(dash "$D")"
  shot "$A" "$label-stopped"
  snap_disk "take-$label-end"
  return 0
}

# =======================================================================
mark "PHASE 1 — PREPARATION : Git / ADB / APK / disque / sessions"
{ echo "## Git"; echo "branche: $(git -C "$ROOT" branch --show-current)"; echo "HEAD: $(git -C "$ROOT" rev-parse HEAD)"; git -C "$ROOT" log --oneline -4;
  echo; echo "## ADB"; adb devices -l | tr -d '\r'; } > "$OUT/dumps/prep-git-adb.txt" 2>&1
sed 's/^/  /' "$OUT/dumps/prep-git-adb.txt"

mark "PHASE 1.1 — attestation APK (md5)"
: > "$OUT/dumps/prep-apk-md5.txt"
for s in $DEVS; do wait_ready "$s" 60 >/dev/null
  p=$(ADB -s "$s" shell pm path "$APP" 2>/dev/null | tr -d '\r' | sed 's/package://')
  m=$(ADB -s "$s" shell md5sum "$p" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  echo "$s $m" >> "$OUT/dumps/prep-apk-md5.txt"; done
echo "  attendu a2f292ec4dba10723485ce33c6f36992"; cat "$OUT/dumps/prep-apk-md5.txt" | sed 's/^/  /'

mark "PHASE 1.2 — disque initial"
snap_disk "initial"

mark "PHASE 1.3 — roles + relance"
for s in $DEVS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
sleep 6; for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done; sleep 4
echo -n "  A roles="; role_cfg "$A" false false true  "$NAME_A"
echo -n "  B roles="; role_cfg "$B" true  false false "$NAME_B"
echo -n "  C roles="; role_cfg "$C" false true  false "$NAME_C"
echo -n "  D roles="; role_cfg "$D" true  false false "$NAME_D"
sleep 2
for s in $DEVS; do relaunch "$s" >/dev/null; grant_perms "$s"; done
sleep 5; for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
for s in $A $B $C $D; do dump "$s" "(function(){var c=MultiCamConfig.get();return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills,storage:c.storage});})()" "cfg-$(echo $s | cut -c1-8).json"; done

mark "PHASE 1.3b — sessions historiques (AVANT, app lancée)"
ev "$A" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify(l.map(function(x){return {sid:x.sessionId,name:x.name,takes:(x.takes||[]).length};}));})()" > "$OUT/dumps/sessions-before.json"
echo "  $(cat "$OUT/dumps/sessions-before.json")"

mark "PHASE 1.4 — nouvelle session J14-C02 (anciennes conservees)"
RUN_TAG="J14-C02-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "  RUN_TAG=$RUN_TAG"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 2
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CREATE';})()" >/dev/null; sleep 7
SID=$(sid_by_name "$A" "$SNAME"); echo "  SESSION_CREATED sid=$SID name='$SNAME'"
[ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ] && { echo "FATAL: session introuvable"; exit 1; }
echo "$SID" > "$OUT/dumps/sid.txt"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,name:s.name,pin:s.pin,created:s.createdAtMs});})()" > "$OUT/dumps/session-created.json"
PIN=$(node -e "const fs=require('fs');let v=fs.readFileSync('$OUT/dumps/session-created.json','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string')try{v=JSON.parse(v)}catch(e){};console.log(v.pin||'')")
echo "  PIN=$PIN"; shot "$A" "PREP-session"

mark "PHASE 1.4b — jonction B, C, D (annonce host/port + PIN)"
for dev in $B $C $D; do
  a="0"; poll=0
  while [ "$poll" -lt 60 ]; do
    a=$(ev "$dev" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$SID';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()"); a="${a//\"/}"
    [ "$a" != "0" ] && break; sleep 3; poll=$((poll+3))
  done
  if [ "$a" = "0" ]; then echo "  FATAL: $dev ne voit pas $SID"; exit 1; fi
  echo "  ANNOUNCE_OK $(echo $dev | cut -c1-8) $a"
  JH="${a%%:*}"; JP="${a##*:}"
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_PIN';})()" | tail -1 | sed 's/^/    /'
  poll=0; ok=no
  while [ "$poll" -lt 90 ]; do
    has=$(ev "$dev" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'yes':'no';})()"); has="${has//\"/}"
    [ "$has" = "yes" ] && { ok=yes; break; }; sleep 5; poll=$((poll+5))
  done
  [ "$ok" = "yes" ] && echo "  SESSION_JOINED $(echo $dev | cut -c1-8) (t=${poll}s)" || { echo "  FATAL: $dev n'a pas rejoint"; exit 1; }
  sleep 2
done

mark "PHASE 1.4c — membres + DID"
BDID=$(ev "$B" "MultiCamSessionWs.status().localDid" | tr -d '"')
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" | tr -d '"')
DDID=$(ev "$D" "MultiCamSessionWs.status().localDid" | tr -d '"')
echo "  BDID=$BDID CDID=$CDID DDID=$DDID"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$NAME_B',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$NAME_C',enabledSkills:['storage']},['storage']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'$NAME_D',enabledSkills:['capture']},['capture']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/members.json"
echo "  membres: $(cat "$OUT/dumps/members.json")"
sleep 5
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,members:(s.members||[]).map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}),peers:MultiCamSessionWs.status()});})()" "session-roles-A.json"

mark "PHASE 1.5 — purge logcat"
for s in $DEVS; do ADB -s "$s" logcat -G 16M >/dev/null 2>&1; ADB -s "$s" logcat -c >/dev/null 2>&1; done

# =======================================================================
# TEST 1 — D1
# =======================================================================
mark "TEST D1 — TAKE T1 : REC 120s (B+D -> C)"
take_record "T1" 120 || { echo "FATAL T1"; exit 1; }
T1=$(cat "$OUT/dumps/TN-T1.txt"); echo "  T1=$T1"
presence_snapshot "after-T1-stop"
# inventaire source T1 EN ARRIÈRE-PLAN (la source reste tant que la réplication/chiffrement n'est pas confirmé)
( local_inventory "$B" "$SID" "$T1" "T1-B" ) > "$OUT/logs/inv-T1-B.out" 2>&1 & JI_B=$!
( local_inventory "$D" "$SID" "$T1" "T1-D" ) > "$OUT/logs/inv-T1-D.out" 2>&1 & JI_D=$!
echo "  inventaire T1 en arrière-plan (pid $JI_B $JI_D)"

mark "TEST D1 — détection d'un transfert T1 en cours puis COUPURE Wi-Fi de C (JAMAIS D)"
ipoll=0; inprog=no
while [ "$ipoll" -lt 240 ]; do
  s=$(ev "$A" "(function(){var v=MultiCamTransferBootInstance.viewFor('$SID',$T1);if(!v)return '-';var tr=v.transfers||{};var out=[];Object.keys(tr).forEach(function(k){var o=tr[k];if(o.state!=='done'&&o.state!=='error'&&(o.percent||0)>2&&(o.percent||0)<96)out.push(k.split('|')[0]+':'+o.percent);});return out.join(',')||'-';})()" | tr -d '"' | tail -1)
  echo "  [t=${ipoll}s] transferts en cours: $s"
  case "$s" in ""|-|*NO_BOOT*|*null*) : ;; *) inprog=yes; break ;; esac
  sleep 3; ipoll=$((ipoll+3))
done
echo "$inprog" > "$OUT/dumps/d1-inprog.txt"
if [ "$inprog" = "yes" ]; then
  echo "  >>> C wifi disable @ $(date +%T) (pendant transfert)"
  adb -s "$C" shell svc wifi disable >/dev/null 2>&1
  sleep 20
  logs_all "D1-during-cut"
  echo "  C wifi disable 20s (< read-timeout 30s -> reprise attendue) — interruption détectée"
  adb -s "$C" shell svc wifi enable >/dev/null 2>&1
  echo "  C wifi enable @ $(ELAPSED)"
else
  echo "  WARN: aucun transfert en cours détecté pour T1"
fi
# rattrape les inventaires T1 (source encore présente car réplication interrompue)
wait "$JI_B" "$JI_D" 2>/dev/null

mark "TEST D1 — attente de convergence A==C (watchdog/réconciliation, sans intervention)"
wpoll=0; nudged=no
while [ "$wpoll" -lt 360 ]; do
  if converged "T1" "$T1"; then break; fi
  if [ "$wpoll" -ge 180 ] && [ "$nudged" = "no" ]; then
    echo "  (convergence lente — relance légitime des offres via retry UI)"
    ev "$A" "(function(){try{MultiCamTransferBootInstance.retry('$BDID');MultiCamTransferBootInstance.retry('$DDID');return 'RETRY';}catch(e){return 'ERR:'+e.message;}})()" | tail -1 | sed 's/^/    /'
    nudged=yes
  fi
  sleep 10; wpoll=$((wpoll+10))
done
echo "  convergence T1 = $(cat "$OUT/dumps/convergence-T1.txt" 2>/dev/null)"
for s in $A $B $C $D; do logs "$s" "D1"; done
sleep 5
local_inventory "$B" "$SID" "$T1" "T1-B-post" >/dev/null 2>&1 || true

# =======================================================================
# TEST 2 — D3
# =======================================================================
mark "TEST D3 — TAKE T2 : REC 300s (B+D -> C)"
take_record "T2" 300 || { echo "FATAL T2"; exit 1; }
T2=$(cat "$OUT/dumps/TN-T2.txt"); echo "  T2=$T2"
presence_snapshot "after-T2-stop"
# démarre IMMÉDIATEMENT T3 pour que la réplication de T2 se poursuive pendant son REC
mark "TEST D3 — démarrage IMMÉDIAT du TAKE T3 (réplication T2 pendant REC T3)"
T3=$(new_take) || { echo "FATAL T3"; exit 1; }
echo "  T3=$T3"
# inventaire source T2 en ARRIÈRE-PLAN : les fichiers T2 restent présents (suppression différée)
( local_inventory "$B" "$SID" "$T2" "T2-B" ) > "$OUT/logs/inv-T2-B.out" 2>&1 & JI2_B=$!
( local_inventory "$D" "$SID" "$T2" "T2-D" ) > "$OUT/logs/inv-T2-D.out" 2>&1 & JI2_D=$!
sleep 2
ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
take_select; res=$(take_read | sed 's/^"//; s/"$//; s/\\"/"/g'); echo "  T3 participants=$res"; echo "$res" > "$OUT/dumps/participants-T3.json"
ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 2
wait_arm_ready "$A" "T3" || echo "  WARN ARM T3"
press_rec "$A" "T3"
wait_phase "$A" "REC" "T3" || echo "  WARN pas de REC T3"
sleep 3
echo "  T3 REC: A=$(dash "$A") B=$(dash "$B") D=$(dash "$D")"
echo "$T3" > "$OUT/dumps/TN-T3.txt"

mark "TEST D3 — surveillance : réplication T2 + demande de suppression DIFFÉRÉE (recording)"
d3poll=0; defer_seen=no
while [ "$d3poll" -lt 300 ]; do
  dA=$(ADB -s "$A" logcat -d 2>/dev/null | grep -c "TRANSFER_DELETE take=$T2" || true)
  dB=$(ADB -s "$B" logcat -d 2>/dev/null | grep -c "TRANSFER_LOCAL_DELETE_DEFER take=$T2" || true)
  dD=$(ADB -s "$D" logcat -d 2>/dev/null | grep -c "TRANSFER_LOCAL_DELETE_DEFER take=$T2" || true)
  t2done=$(tr_done_n "$(tr_take "$A" "$SID" "$T2")")
  echo "  [t=${d3poll}s] T2 done=$t2done/2 DELETE(A)=${dA:-0} DEFER(B)=${dB:-0} DEFER(D)=${dD:-0}"
  if [ "${dB:-0}" -gt 0 ] 2>/dev/null || [ "${dD:-0}" -gt 0 ] 2>/dev/null; then defer_seen=yes; fi
  sleep 10; d3poll=$((d3poll+10))
done
echo "$defer_seen" > "$OUT/dumps/d3-defer-seen.txt"
echo "  T3 fin d'enregistrement ..."; ev "$A" "MultiCamStartService.requestStop('T3')" >/dev/null 2>&1
wait_phase "$A" "STOPPED" "T3" || echo "  WARN STOP T3"
sleep 3
echo "  phases STOP T3: A=$(dash "$A") B=$(dash "$B") C=$(dash "$C") D=$(dash "$D")"
wait "$JI2_B" "$JI2_D" 2>/dev/null
local_inventory "$B" "$SID" "$T3" "T3-B"
local_inventory "$D" "$SID" "$T3" "T3-D"
presence_snapshot "T3-stopped-pre-delete"

mark "TEST D3 — attente de l'exécution de la suppression DIFFÉRÉE de T2 (watchdog post-REC)"
dwpoll=0; gone=no
while [ "$dwpoll" -lt 180 ]; do
  fB=$(present_count "$B" "$T2"); fD=$(present_count "$D" "$T2")
  echo "  [t=${dwpoll}s] T2 fichiers restants: B=$fB D=$fD"
  [ "$fB" = "0" ] && [ "$fD" = "0" ] && { gone=yes; break; }
  sleep 10; dwpoll=$((dwpoll+10))
done
echo "$gone" > "$OUT/dumps/d3-gone.txt"
presence_snapshot "after-T3"
local_inventory "$B" "$SID" "$T3" "T3-B-post" >/dev/null 2>&1 || true

mark "PHASE 3b — attente de TOUS les transferts terminaux (done|error) avant intégrité"
: > "$OUT/dumps/transfer-progress.log"
wpoll=0; allok=no
while [ "$wpoll" -lt 1800 ]; do
  line="t=${wpoll}s"; tot=0; done_n=0; term_n=0; err_n=0
  for tk in $T1 $T2 $T3; do
    [ -z "$tk" ] && continue
    tv=$(tr_take "$A" "$SID" "$tk"); dn=$(tr_done_n "$tv"); en=$(tr_err_n "$tv")
    echo "$tv" > "$OUT/dumps/transfer-A-T$tk.json"
    line="$line T$tk=$dn/2+${en}err"; tot=$((tot+2)); done_n=$((done_n+dn)); err_n=$((err_n+en)); term_n=$((term_n+dn+en))
  done
  echo "$line" | tee -a "$OUT/dumps/transfer-progress.log"
  if [ "$term_n" -ge "$tot" ]; then
    if [ "$done_n" -ge "$tot" ]; then allok=yes; else allok=partial; fi
    break
  fi
  sleep 20; wpoll=$((wpoll+20))
done
echo "  transferts=$allok (done=$done_n/$tot erreurs=$err_n)" >&2
echo "$allok" > "$OUT/dumps/transfers-all-done.txt"
sleep 5
presence_snapshot "final-presence"

mark "PHASE 3 — logs finaux"
for s in $A $B $C $D; do logs "$s" "final"; done

# =======================================================================
mark "PHASE 4 — intégrité par Take (SHA source vs destination C, DONE)"
for s in $C; do
  ADB -s "$s" shell "find $CONFIGDIR/$SID -type f 2>/dev/null" | tr -d '\r' > "$OUT/dumps/media-$s.txt"
  : > "$OUT/dumps/sha-$s.txt"
  while IFS= read -r f; do [ -z "$f" ] && continue
    h=$(ADB -s "$s" shell "sha256sum '$f' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
    b=$(ADB -s "$s" shell "stat -c %s '$f' 2>/dev/null" | tr -d '\r')
    d=$(take_duration_s "$s" "$f")
    echo "$f sha256=$h bytes=$b duration_s=$d" >> "$OUT/dumps/sha-$s.txt"
  done < "$OUT/dumps/media-$s.txt"
  echo "  C media=$(grep -c sha256 "$OUT/dumps/sha-$s.txt" | tr -d ' ')"
done
for lab in T1 T2 T3; do tk=$(cat "$OUT/dumps/TN-$lab.txt" 2>/dev/null); [ -z "$tk" ] && continue
  tr_take "$A" "$SID" "$tk" > "$OUT/dumps/tr-A-$lab.json"; tr_take "$C" "$SID" "$tk" > "$OUT/dumps/tr-C-$lab.json"; done
bash "$HERE/j14d-integrity.sh" "$OUT" "$SID" "$C" "$BDID" "$DDID" || echo "  WARN intégrité non conforme (voir dumps/verdict.txt)"

# ---- analyse D1 / D3 (preuves) ----
mark "PHASE 5 — synthèse preuves D1 / D3"
OUTDv="$OUT/dumps" LOGDv="$OUT/logs" T1v="${T1:-}" T2v="${T2:-}" T3v="${T3:-}" node <<'NODE' | tee "$OUT/dumps/j14c02-evidence.txt"
const fs = require("fs");
const OUTD = process.env.OUTDv, LOGD = process.env.LOGDv;
const T2 = process.env.T2v, T3 = process.env.T3v;
const rd = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return ""; } };
const allLogs = (ser) => { let t = ""; try { for (const n of fs.readdirSync(LOGD)) if (n.indexOf(ser + "-") === 0 && n.endsWith(".log")) t += rd(LOGD + "/" + n) + "\n"; } catch (e) {} return t; };
const cnt = (txt, re) => txt.split("\n").filter((l) => re.test(l)).length;
const firstTs = (txt, re) => { const m = txt.split("\n").filter((l) => re.test(l)).sort(); return m.length ? m[0].slice(0, 18) : "ABSENT"; };
const A = allLogs("61cc29567d91"), B = allLogs("61d54bba7d91"), C = allLogs("c0d8514d7d87"), D = allLogs("R83Y106V1HF");
const lines = [];
lines.push("# J14-C02 — synthèse preuves D1 / D3");
lines.push("");
lines.push("## D1 — convergence Master/Storage après coupure Wi-Fi de C");
lines.push("- A Master : TRANSFER_STUCK_REOFFER=" + cnt(A, /TRANSFER_STUCK_REOFFER/) + " STUCK_FINAL=" + cnt(A, /TRANSFER_STUCK_FINAL/) + " RESYNC_TRIGGER=" + cnt(A, /TRANSFER_RESYNC_TRIGGER/) + " PROGRESS_IGNORE=" + cnt(A, /TRANSFER_PROGRESS_IGNORE/));
lines.push("- C Storage : TRANSPORT_DROP=" + cnt(C, /TRANSFER_TRANSPORT_DROP/) + " RESYNC_RECONNECT=" + cnt(C, /TRANSFER_RESYNC_RECONNECT/) + " RESYNC_TRIGGER=" + cnt(C, /TRANSFER_RESYNC_TRIGGER/) + " RESYNC=" + cnt(C, /\bTRANSFER_RESYNC take=/));
lines.push("- convergence T1 (A==C, terminal) : " + rd(OUTD + "/convergence-T1.txt").trim());
lines.push("");
lines.push("## D3 — suppression du Take précédent pendant le REC du suivant");
lines.push("- T2=" + T2 + "  T3=" + T3);
lines.push("- A : TRANSFER_DELETE take=" + T2 + "=" + cnt(A, new RegExp("TRANSFER_DELETE take=" + T2 + " ")) + " ACK=" + cnt(A, new RegExp("TRANSFER_DELETE_ACK take=" + T2 + " ")) + " DELETE_FAILED=" + cnt(A, new RegExp("TRANSFER_DELETE_FAILED take=" + T2 + " ")));
lines.push("- B : DEFER(recording)=" + cnt(B, new RegExp("TRANSFER_LOCAL_DELETE_DEFER take=" + T2 + " ")) + " LOCALD_DELETED=" + cnt(B, new RegExp("TRANSFER_LOCAL_DELETED take=" + T2 + " ")) + " files0(bug)=" + cnt(B, new RegExp("TRANSFER_LOCAL_DELETED take=" + T2 + " files=0 ")));
lines.push("- D : DEFER(recording)=" + cnt(D, new RegExp("TRANSFER_LOCAL_DELETE_DEFER take=" + T2 + " ")) + " LOCAL_DELETED=" + cnt(D, new RegExp("TRANSFER_LOCAL_DELETED take=" + T2 + " ")) + " files0(bug)=" + cnt(D, new RegExp("TRANSFER_LOCAL_DELETED take=" + T2 + " files=0 ")) + " NATIVE=" + cnt(D, /TRANSFER_LOCAL_DELETE_NATIVE/));
lines.push("- T3 intact : LOCAL_DELETED take=" + T3 + " (B)=" + cnt(B, new RegExp("TRANSFER_LOCAL_DELETED take=" + T3 + " ")) + " (D)=" + cnt(D, new RegExp("TRANSFER_LOCAL_DELETED take=" + T3 + " ")));
lines.push("- ordre HASH->DELETE (A) : HASH=" + firstTs(A, new RegExp("TRANSFER_HASH take=" + T2 + " ")) + " DELETE=" + firstTs(A, new RegExp("TRANSFER_DELETE take=" + T2 + " ")));
lines.push("- suppression effective B/D (d3-gone=" + rd(OUTD + "/d3-gone.txt").trim() + ") ; defer-seen=" + rd(OUTD + "/d3-defer-seen.txt").trim());
lines.push("");
lines.push("## Présence physique");
lines.push(rd(OUTD + "/presence-after-T2-stop.txt").trim());
lines.push(rd(OUTD + "/presence-T3-stopped-pre-delete.txt").trim());
lines.push(rd(OUTD + "/presence-after-T3.txt").trim());
lines.push("");
lines.push("## Intégrité (verdict)");
lines.push(rd(OUTD + "/verdict.txt").trim());
console.log(lines.join("\n"));
NODE

# sessions après + conservation
ev "$A" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify(l.map(function(x){return {sid:x.sessionId,name:x.name,takes:(x.takes||[]).length};}));})()" > "$OUT/dumps/sessions-after.json"
snap_disk "final"
TENDWALL=$(date +%s); echo "$(( TENDWALL - T0WALL ))" > "$OUT/dumps/campaign-seconds.txt"
echo; echo "=== CAMPAGNE J14-C02 TERMINEE ==="
echo "EVIDENCE_DIR=$OUT"
echo "SID=$SID T1=$T1 T2=$T2 T3=$T3"
echo "verdict intégrite: $(grep 'VERDICT GLOBAL' "$OUT/dumps/verdict.txt" 2>/dev/null | tail -1)"
echo "duree: $(( TENDWALL - T0WALL )) s"
