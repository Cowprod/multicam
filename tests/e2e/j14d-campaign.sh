#!/usr/bin/env bash
# MultiCam — J14 CAMPAGNE D'ENDURANCE V2 (reprise post-B02/B03, >= 60 min, 6 Takes, 2 Captures B+D, 1 Storage C).
#
# Montage : A=Master(controller)  B=Capture  C=Storage  D=Capture (USB R83Y106V1HF, repli TCP 192.168.92.103:5555 — même appareil).
# Scénario : session NOUVELLE (anciennes sessions conservées), 6 Takes de REC cumulés >= 40 min.
#            transferts B->C et D->C laissés se chevaucher avec les Takes suivants (chevauchement documenté).
#            incidents contrôlés (Wi-Fi Capture/Storage, interruption de transfert).
# Surveille B02 (SESSION_ADVERTISE_SKIP / RE_SYNC_THROTTLED, latence CDP), crashes/ANR, espace disque.
# Intégrité par Take : SHA-256 source (avant purge) vs destination C, DONE, ordre HASH->DELETE.
# Sortie   : tests/e2e/validation/J14-endurance/campagne-v2/ (refus si déjà rempli).
#
# Aucune modification applicative, aucune suppression manuelle de média, aucun nettoyage de session.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91
B=61d54bba7d91
C=c0d8514d7d87
DUSB=R83Y106V1HF
DTCP=192.168.92.103:5555
DIP=192.168.92.103
# D : USB de préférence (stable), repli TCP — MÊME appareil, jamais un 5e device.
if adb -s "$DUSB" get-state 2>/dev/null | grep -q device; then D="$DUSB"; else adb connect "$DIP:5555" >/dev/null 2>&1; sleep 2; D="$DTCP"; fi
DEVS="$A $B $C $D"

NAME_A="J14D-A-Master"; NAME_B="J14D-B-Capture"; NAME_C="J14D-C-Storage"; NAME_D="J14D-D-Capture"

OUT="$ROOT/tests/e2e/validation/J14-endurance/campagne-v2"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "FATAL: $OUT existe et n'est pas vide — preuves existantes non écrasées."; exit 1
fi
mkdir -p "$OUT"/{logs,dumps,screenshots}
echo "campagne-v2" > "$OUT/.run"

T0=$SECONDS
T0WALL=$(date +%s)
ELAPSED() { echo "+$(( SECONDS - T0 ))s"; }
mark() { echo; echo "### [$(ELAPSED)] $1" | tee -a "$OUT/logs/campaign.log"; }

run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$w" 2>/dev/null; return $rc; }
ADB()  { run_to 30 adb "$@"; }
ev()   { run_to 120 node "$CDP" "$1" eval "$2"; }
evj()  { ev "$1" "$2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{let v=JSON.parse(s.trim());if(typeof v==='string')v=JSON.parse(v);console.log(JSON.stringify(v));}catch(e){console.log(s.trim());}});"; }
shot() { run_to 30 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }
dump() { mkdir -p "$OUT/dumps"; echo -n "$3" | ev "$1" "$2" > "$OUT/dumps/$3"; echo "  dump $3 = $(head -c 220 "$OUT/dumps/$3")"; }

# ---- D (Wi-Fi TCP) : reconnexion douce, jamais de kill-server global ----
d_ensure() {
  if ADB -s "$D" get-state 2>/dev/null | grep -q device; then return 0; fi
  if [ "$D" = "$DTCP" ]; then adb connect "$DIP:5555" >/dev/null 2>&1; sleep 2; else adb connect "$DIP:5555" >/dev/null 2>&1; sleep 2; D="$DTCP"; fi
  ADB -s "$D" get-state 2>/dev/null | grep -q device
}
dev_ready() { local s="$1"; if [ "$s" = "$D" ]; then d_ensure; else ADB -s "$s" get-state 2>/dev/null | grep -q device; fi; }

wait_ready() { local s="$1" t="${2:-60}" p=0
  while [ "$p" -lt "$t" ]; do dev_ready "$s" && { echo "  device $s ready (t=${p}s)"; return 0; }; sleep 5; p=$((p+5)); done
  echo "  WARN device $s indisponible apres ${t}s"; return 1; }

# ---- inventaire / métriques ----
pid_of() { ADB -s "$1" shell pidof "$APP" 2>/dev/null | tr -d '\r' | awk '{print $1}'; }
disk_free_kb() { ADB -s "$1" shell "df -k /data | tail -1" 2>/dev/null | tr -d '\r' | awk '{print $4}'; }
snap_disk() { local label="$1"; local f="$OUT/dumps/disk-$label.txt"; : > "$f"
  for s in $DEVS; do echo "$s $(disk_free_kb "$s")" >> "$f"; done
  echo "  disque $label : $(tr '\n' ' ' < "$f")"; }

dash() { ev "$1" "MultiCamStartService.view().phase" 2>/dev/null | tr -d '"' | tr -d '\n'; }

b02_count() { # $1=serial -> "skip=N resync=N crash=N" (1 seul dump logcat, depuis purge, buffer 16M)
  ADB -s "$1" logcat -d 2>/dev/null | awk '
    /SESSION_ADVERTISE_SKIP/ {sk++}
    /RE_SYNC_THROTTLED/ {rs++}
    /FATAL EXCEPTION|ANR in fr\.emmanuel\.multicam|am_crash|am_anr/ {cr++}
    END {printf "skip=%d resync=%d crash=%d\n", sk+0, rs+0, cr+0}'
}
cdp_latency_ms() { # latence d'un eval CDP trivial sur A (réactivité WebView)
  local t0 t1
  t0=$(node -e 'console.log(Date.now())')
  ev "$A" "'PING'" >/dev/null 2>&1
  t1=$(node -e 'console.log(Date.now())')
  echo $(( t1 - t0 ))
}
sample_line() {
  local pid_a pid_b pid_c pid_d fB fC fD bA bB bC bD lat crash
  pid_a=$(pid_of "$A"); pid_b=$(pid_of "$B"); pid_c=$(pid_of "$C"); pid_d=$(pid_of "$D")
  fB=$(disk_free_kb "$B"); fC=$(disk_free_kb "$C"); fD=$(disk_free_kb "$D")
  bA=$(b02_count "$A"); bB=$(b02_count "$B"); bC=$(b02_count "$C"); bD=$(b02_count "$D")
  lat=$(cdp_latency_ms)
  crash=$(echo "$bA $bB $bC $bD" | tr ' ' '\n' | sed -n 's/.*crash=\([0-9]*\).*/\1/p' | awk '{s+=$1} END{print s+0}')
  echo "{\"t\":$(date +%s),\"elapsed\":$(( SECONDS - T0 )),\"pidA\":\"$pid_a\",\"pidB\":\"$pid_b\",\"pidC\":\"$pid_c\",\"pidD\":\"$pid_d\",\"freeB\":${fB:-0},\"freeC\":${fC:-0},\"freeD\":${fD:-0},\"cdpMs\":${lat:-99999},\"crashAnr\":${crash:-0},\"b02A\":\"$bA\",\"b02B\":\"$bB\",\"b02C\":\"$bC\",\"b02D\":\"$bD\"}" >> "$OUT/dumps/timeline.jsonl"
}
sampler_loop() { while [ -f "$OUT/.sampler" ]; do sample_line 2>/dev/null; sleep 30; done; }

# ---- helpers session/take (repris de dserve-two-takes.sh) ----
role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }
relaunch() { ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; sleep 5; pid_of "$1"; }
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
      const n=Object.keys(v.clock||{}).length;
      const dev=(v.devices||[]).length;
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

# ---- inventaire local d'une Capture pour un Take (avant purge D-SERVE) ----
local_inventory() { local s="$1" sid="$2" take="$3" tag="$4"
  local f="$OUT/dumps/local-$tag.txt"
  { echo "# $tag ($s) sid=$sid take=$take $(date)";
    ADB -s "$s" shell "ls -la /sdcard/Android/data/$APP/files/MultiCam/$sid/$take/ 2>/dev/null" 2>/dev/null | tr -d '\r';
  } > "$f"
  # sha256 + bytes : attend la stabilité de la taille (finalisation du muxer post-STOP) AVANT stat+sha.
  # Correctif J14 : stat saisi pendant l'écriture → bytes stale (479 Mo) alors que sha256sum, lancé ensuite,
  # hachait le fichier complet (768 Mo) — les « écarts de taille à sha égal » du verdict étaient cet artefact.
  local i prev cur b h b2
  { echo "# sha256 $tag"; while IFS= read -r p; do
      [ -z "$p" ] && continue
      i=0; prev=""; cur=""
      while [ "$i" -lt 60 ]; do
        cur=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
        [ -n "$cur" ] && [ "$cur" = "$prev" ] && break
        prev="$cur"; sleep 2; i=$((i+2))
      done
      b="$cur"
      h=$(ADB -s "$s" shell "sha256sum '$p' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
      b2=$(ADB -s "$s" shell "stat -c %s '$p' 2>/dev/null" | tr -d '\r')
      if [ "$b2" != "$b" ]; then echo "$p sha256=$h bytes=$b bytes_final=$b2 unstable=1"
      else echo "$p sha256=$h bytes=$b"; fi
    done < <(ADB -s "$s" shell "find /sdcard/Android/data/$APP/files/MultiCam/$sid/$take -type f 2>/dev/null" | tr -d '\r');
  } > "$OUT/dumps/local-sha-$tag.txt"
  echo "  local $tag : $(grep -c sha256 "$OUT/dumps/local-sha-$tag.txt" 2>/dev/null | tr -d ' ') fichier(s)"
}

# ---- vues transfert ----
tr_take() { ev "$1" "(function(){if(!MultiCamTransferBootInstance)return 'NO_BOOT';var v=MultiCamTransferBootInstance.viewFor('$2',$3);if(!v)return 'null';var t=v.transfers||{};var ks=Object.keys(t);var rows=ks.map(function(k){var p=k.split('|');var o=t[k];return {src:p[0],sto:p[1],state:o.state,percent:o.percent,bytes:o.bytes,total:o.total,error:o.error||'',files:(o.files||[]).map(function(f){return {rel:f.rel,state:f.state,received:f.received,bytes:f.bytes,sha256:f.sha256};})};});return JSON.stringify({sid:v.sid,take:v.takeNumber,n:ks.length,rows:rows});})()"; }
# N comptabilise les TRANSFERTS en state=done (lignes rows) — PAS les états files[] inclus dans chaque row.
# Correctif J14 : l'ancien grep '"state":"done"' comptait row + files (4 au lieu de 2) → PHASE 3 déclarait
# « transferts complets=yes » à t=0s pendant que 4 transferts n'avaient même pas démarré.
_tr_row_n() { node -e "var v;try{v=JSON.parse(process.argv[1]);if(typeof v==='string')v=JSON.parse(v);}catch(e){process.stdout.write('0');process.exit(0);}var rows=(v&&v.rows)||[];process.stdout.write(String(rows.filter(function(r){return r.state===process.argv[2];}).length));" "$1" "${2:-done}" 2>/dev/null || echo 0; }
tr_done_n() { _tr_row_n "$1" done; }
tr_err_n()  { _tr_row_n "$1" error; }

LOG_FILTER='APP_BOOT|CONFIG_INIT|SKILL_SET|DEVICE_NAME_SET|SESSION|WS_|MEMBER|TAKE_|ARM_|CLOCK_|START_|STOP_|CAMERA_|TRANSFER_|MEDIA_READY|PREVIEW_|CorHttpd|NanoHTTPD|MultiCamTransfer|EADDRINUSE|Address already|NAV_'
logs() { ADB -s "$1" logcat -d -v time 2>/dev/null | grep -E "$LOG_FILTER" > "$OUT/logs/$1-$2.log"; echo "  logs $1-$2 ($(wc -l < "$OUT/logs/$1-$2.log" | tr -d ' ') lignes)"; }
logs_all() { for s in $A $B $C $D; do logs "$s" "$1"; done; }

take_duration_s() { # $1=dev $2=path -> secondes (mvhd)
  local s="$1" p="$2" tmp="$OUT/dumps/.tail.bin"
  ADB -s "$s" shell "tail -c 400000 '$p' 2>/dev/null" > "$tmp" 2>/dev/null
  node -e "
    const fs=require('fs');let b;try{b=fs.readFileSync('$tmp')}catch(e){process.exit(0)}
    const i=b.lastIndexOf('mvhd');if(i<0)process.exit(0);
    const ver=b[i+4];let ts,dur;
    if(ver===0){ts=b.readUInt32BE(i+16);dur=b.readUInt32BE(i+20);}else{ts=b.readUInt32BE(i+20);dur=Number(b.readBigUInt64BE(i+24));}
    if(ts>0)console.log((dur/ts).toFixed(3));"
}

# =======================================================================
mark "PHASE 1 — PREPARATION : Git / ADB / APK / disque / roles"
{
  echo "## Git"; echo "branche: $(git -C "$ROOT" branch --show-current)"; echo "HEAD: $(git -C "$ROOT" rev-parse HEAD)"; git -C "$ROOT" log --oneline -4;
  echo; echo "## ADB"; adb devices -l | tr -d '\r';
} > "$OUT/dumps/prep-git-adb.txt" 2>&1
cat "$OUT/dumps/prep-git-adb.txt" | sed 's/^/  /'

mark "PHASE 1.1 — attestation APK (md5 sur chaque device)"
: > "$OUT/dumps/prep-apk-md5.txt"
for s in $DEVS; do
  wait_ready "$s" 60 >/dev/null
  p=$(ADB -s "$s" shell pm path "$APP" 2>/dev/null | tr -d '\r' | sed 's/package://')
  m=$(ADB -s "$s" shell md5sum "$p" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  echo "$s $m $p" >> "$OUT/dumps/prep-apk-md5.txt"
done
echo "  local $(md5 -q "$ROOT/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk")" >> "$OUT/dumps/prep-apk-md5.txt"
cat "$OUT/dumps/prep-apk-md5.txt" | sed 's/^/  /'

mark "PHASE 1.2 — disque initial"
snap_disk "initial"

mark "PHASE 1.3 — anciennes sessions (AVANT)"
ev "$A" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify(l.map(function(x){return {sid:x.sessionId,name:x.name,takes:(x.takes||[]).length};}));})()" > "$OUT/dumps/sessions-before.json"
echo "  $(cat "$OUT/dumps/sessions-before.json")"

mark "PHASE 1.4 — roles + relance des 4 devices"
for s in $DEVS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1; ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
sleep 6
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
sleep 4
echo -n "  A roles="; role_cfg "$A" false false true  "$NAME_A"
echo -n "  B roles="; role_cfg "$B" true  false false "$NAME_B"
echo -n "  C roles="; role_cfg "$C" false true  false "$NAME_C"
echo -n "  D roles="; role_cfg "$D" true false false "$NAME_D"
sleep 2
for s in $DEVS; do relaunch "$s" >/dev/null; grant_perms "$s"; done
sleep 5
for s in $DEVS; do wait_ready "$s" 60 >/dev/null; done
for s in $A $B $C $D; do dump "$s" "(function(){var c=MultiCamConfig.get();return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills,storage:c.storage});})()" "cfg-$(echo $s | cut -c1-8).json"; done

mark "PHASE 1.5 — nouvelle session sur A (anciennes conservées)"
RUN_TAG="J14D-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"; echo "  RUN_TAG=$RUN_TAG"
ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 2
ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CREATE';})()" >/dev/null; sleep 7
SID=$(sid_by_name "$A" "$SNAME"); echo "  SESSION_CREATED sid=$SID name='$SNAME'"
[ -z "$SID" ] || [ "$SID" = "NOT_FOUND" ] && { echo "FATAL: session introuvable"; exit 1; }
echo "$SID" > "$OUT/dumps/sid.txt"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,name:s.name,pin:s.pin,created:s.createdAtMs});})()" > "$OUT/dumps/session-created.json"
PIN=$(node -e "const fs=require('fs');let v=fs.readFileSync('$OUT/dumps/session-created.json','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string')try{v=JSON.parse(v)}catch(e){};console.log(v.pin||'')")
echo "  PIN=$PIN"
shot "$A" "PREP-session"

mark "PHASE 1.6 — jonction B, C, D (host/port annoncés + PIN)"
for dev in $B $C $D; do
  lbl="JOIN-$(echo $dev | cut -c1-8)"
  a="0"; poll=0
  while [ "$poll" -lt 60 ]; do
    a=$(ev "$dev" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$SID';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()"); a="${a//\"/}"
    [ "$a" != "0" ] && break; sleep 3; poll=$((poll+3))
  done
  if [ "$a" = "0" ]; then echo "  FATAL: $dev ne voit pas $SID"; exit 1; fi
  echo "  ANNOUNCE_OK $lbl $a"
  JH="${a%%:*}"; JP="${a##*:}"
  ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_PIN';})()" | tail -1 | sed 's/^/    /'
  poll=0; ok=no
  while [ "$poll" -lt 90 ]; do
    has=$(ev "$dev" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'yes':'no';})()"); has="${has//\"/}"
    [ "$has" = "yes" ] && { ok=yes; break; }; sleep 5; poll=$((poll+5))
  done
  [ "$ok" = "yes" ] && echo "  SESSION_JOINED $lbl (t=${poll}s)" || { echo "  FATAL: $dev n'a pas rejoint"; exit 1; }
  sleep 2
done

BDID=$(ev "$B" "MultiCamSessionWs.status().localDid" | tr -d '"')
CDID=$(ev "$C" "MultiCamSessionWs.status().localDid" | tr -d '"')
DDID=$(ev "$D" "MultiCamSessionWs.status().localDid" | tr -d '"')
echo "  BDID=$BDID CDID=$CDID DDID=$DDID"
ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$NAME_B',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$NAME_C',enabledSkills:['storage']},['storage']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$DDID',deviceName:'$NAME_D',enabledSkills:['capture']},['capture']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/members.json"
echo "  membres: $(cat "$OUT/dumps/members.json")"
sleep 5
dump "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,members:(s.members||[]).map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}),peers:MultiCamSessionWs.status()});})()" "session-roles-A.json"
for s in $B $C $D; do dump "$s" "(function(){return JSON.stringify({peers:MultiCamSessionWs.status(),skills:MultiCamConfig.get().enabledSkills});})()" "sync-$(echo $s | cut -c1-8).json"; done

mark "PHASE 1.7 — purge logcat + démarrage échantillonneur"
for s in $DEVS; do ADB -s "$s" logcat -G 16M >/dev/null 2>&1; ADB -s "$s" logcat -c >/dev/null 2>&1; done
: > "$OUT/dumps/timeline.jsonl"; touch "$OUT/.sampler"; sampler_loop & SAMPLER=$!; echo "  sampler pid=$SAMPLER"

# =======================================================================
# EXECUTION
# =======================================================================
run_take() { # $1=label $2=duree_s
  local label="$1" dur="$2" TN res
  # preuve du scénario « Take pendant la réplication du précédent » : état des transferts avant ARM
  tr_take "$A" "$SID" "${PREV_TK:-0}" > "$OUT/dumps/overlap-transfers-before-$label.json" 2>/dev/null
  echo "  overlap avant $label : $(tr_done_n "$(cat "$OUT/dumps/overlap-transfers-before-$label.json" 2>/dev/null)") done sur take precedent"
  mark "TAKE $label : nouvel Take + sélection participants + ARM"
  TN=$(new_take) || { echo "  ABORT $label"; return 1; }
  sleep 2
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  take_select; res=$(take_read | sed 's/^"//; s/"$//; s/\\"/"/g')
  echo "  $label participants=$res"
  echo "$res" > "$OUT/dumps/participants-$label.json"
  read -r NCAP NSTO CAPS <<<"$(node -e "const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/participants-$label.json','utf8'))}catch(e){v={}};console.log((v.ncap)+' '+(v.nsto)+' '+((v.caps||[]).join(',')));")"
  echo "  $label NCAP=$NCAP NSTO=$NSTO captures=$CAPS"
  if [ "$NCAP" != "2" ] || [ "$NSTO" != "1" ]; then echo "  FATAL $label participants NCAP=$NCAP NSTO=$NSTO (attendu 2 captures / 1 storage)"; return 1; fi
  case ",$CAPS," in *",$BDID,"*) :;; *) echo "  FATAL $label capture B ($BDID) absente"; return 1;; esac
  case ",$CAPS," in *",$DDID,"*) :;; *) echo "  FATAL $label capture D ($DDID) absente"; return 1;; esac
  shot "$A" "$label-take"
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  wait_arm_ready "$A" "$label" || echo "  WARN ARM non pret $label"
  shot "$A" "$label-arm"
  mark "TAKE $label : REC ${dur}s"
  press_rec "$A" "$label"
  wait_phase "$A" "REC" "$label" || echo "  WARN pas de REC sur A"
  sleep 3
  echo "  phases REC: A=$(dash "$A") B=$(dash "$B") D=$(dash "$D")"
  for s in $A $B $D; do shot "$s" "$label-rec"; done
  echo "$TN" > "$OUT/dumps/take-$label.txt"
  snap_disk "take-$label-start"
  echo "  enregistrement ${dur}s ..."; sleep "$dur"
  ev "$A" "MultiCamStartService.requestStop('$label')" >/dev/null 2>&1
  echo "  STOP_REQUEST $label"
  wait_phase "$A" "STOPPED" "$label" || echo "  WARN STOP non atteint sur A"
  sleep 2
  echo "  phases STOP: A=$(dash "$A") B=$(dash "$B") C=$(dash "$C") D=$(dash "$D")"
  dump "$A" "(function(){var v=MultiCamStartService.view();return JSON.stringify({phase:v.phase,take:v.takeNumber,startPlanId:v.startPlanId,localStoppedTake:v.localStoppedTake,stop:v.stop});})()" "startview-A-$label.json"
  dump "$B" "(function(){var v=MultiCamStartService.view();return JSON.stringify({phase:v.phase,take:v.takeNumber,startPlanId:v.startPlanId,localStoppedTake:v.localStoppedTake});})()" "startview-B-$label.json"
  dump "$D" "(function(){var v=MultiCamStartService.view();return JSON.stringify({phase:v.phase,take:v.takeNumber,startPlanId:v.startPlanId,localStoppedTake:v.localStoppedTake});})()" "startview-D-$label.json"
  dump "$C" "(function(){var v=MultiCamStartService.view();return JSON.stringify({phase:v.phase,take:v.takeNumber,startPlanId:v.startPlanId});})()" "startview-C-$label.json"
  dump "$A" "(function(){var v=MultiCamStartService.view();return JSON.stringify({stopStates:v.stopStates,localStopInfo:v.localStopInfo});})()" "stopstate-A-$label.json"
  shot "$A" "$label-stopped"
  # inventaire local immédiat des 2 captures (avant suppression post-réplication)
  local_inventory "$B" "$SID" "$TN" "$label-B"
  local_inventory "$D" "$SID" "$TN" "$label-D"
  snap_disk "take-$label-end"
  echo "$TN" > "$OUT/dumps/TN-$label.txt"
  PREV_TK="$TN"
  logs_all "$label"
  return 0
}

mark "VERIFICATION PREP : Take 1 (2 min) sert aussi de contrôle Capture B+D simultanées"
run_take "T1" 120 || { echo "FATAL T1"; exit 1; }
T1=$(cat "$OUT/dumps/TN-T1.txt")
snap_disk "after-T1"

mark "INCIDENT 1 (après T1) : Wi-Fi Capture B coupé 30s puis rétabli"
IDX=$(date +%s)
adb -s "$B" shell svc wifi disable >/dev/null 2>&1; echo "  B wifi disable @ $IDX"
sleep 30
adb -s "$B" shell svc wifi enable >/dev/null 2>&1; echo "  B wifi enable"
sleep 25
echo "  B wifi_on=$(ADB -s "$B" shell settings get global wifi_on | tr -d '\r') phase=$(dash "$B")"
logs_all "INC1"

mark "TAKE T2 : REC 5 min"
run_take "T2" 300 || { echo "FATAL T2"; exit 1; }
T2=$(cat "$OUT/dumps/TN-T2.txt"); snap_disk "after-T2"

mark "TAKE T3 : REC 10 min"
run_take "T3" 600 || { echo "FATAL T3"; exit 1; }
T3=$(cat "$OUT/dumps/TN-T3.txt"); snap_disk "after-T3"

mark "TAKE T4 : REC 3 min"
run_take "T4" 180 || { echo "FATAL T4"; exit 1; }
T4=$(cat "$OUT/dumps/TN-T4.txt"); snap_disk "after-T4"

mark "INCIDENT 2 (après T4) : Wi-Fi Storage C coupé 30s puis rétabli"
adb -s "$C" shell svc wifi disable >/dev/null 2>&1; echo "  C wifi disable"
sleep 30
adb -s "$C" shell svc wifi enable >/dev/null 2>&1; echo "  C wifi enable"
sleep 25
echo "  C wifi_on=$(ADB -s "$C" shell settings get global wifi_on | tr -d '\r') phase=$(dash "$C")"
logs_all "INC2"

mark "INCIDENT 3 (après T4) : interruption d'un transfert en cours (Wi-Fi C coupé pendant download)"
# attend qu'un transfert soit réellement en cours (percent entre 2 et 95)
ipoll=0; inprog=no
while [ "$ipoll" -lt 240 ]; do
  s=$(ev "$A" "(function(){var B=MultiCamTransferBootInstance;var out=[];[$(cat "$OUT/dumps/TN-T1.txt"),$(cat "$OUT/dumps/TN-T2.txt"),$(cat "$OUT/dumps/TN-T3.txt"),$(cat "$OUT/dumps/TN-T4.txt")].forEach(function(tk){var v=B.viewFor('$SID',tk);if(!v)return;var tr=v.transfers||{};Object.keys(tr).forEach(function(k){var o=tr[k];if(o.state!=='done'&&(o.percent||0)>2&&(o.percent||0)<95)out.push(tk+':'+k.split('|')[0]+':'+o.percent);});});return out.join(',')||'-';})()" | tr -d '"')
  echo "  transferts en cours: $s"
  if [ "$s" != "-" ] && [ -n "$s" ]; then echo "  TRANSFERT EN COURS -> coupure Wi-Fi C"; inprog=yes; break; fi
  # sinon : relancer l'offre des derniers Takes non terminés (reprise)
  ev "$A" "(function(){try{if(MultiCamTransferBootInstance._resumePaused)MultiCamTransferBootInstance._resumePaused();MultiCamTransferBootInstance.retry('$BDID');MultiCamTransferBootInstance.retry('$DDID');return 'RESUME';}catch(e){return 'ERR:'+e.message;}})()" >/dev/null 2>&1
  sleep 10; ipoll=$((ipoll+10))
done
if [ "$inprog" = "yes" ]; then
  adb -s "$C" shell svc wifi disable >/dev/null 2>&1; echo "  C wifi disable (pendant transfert)"; sleep 25
  adb -s "$C" shell svc wifi enable >/dev/null 2>&1; echo "  C wifi enable"; sleep 15
  echo "  relance des offres (reprise attendue avec offset Range)"
  ev "$A" "(function(){try{MultiCamTransferBootInstance.retry('$BDID');MultiCamTransferBootInstance.retry('$DDID');return 'RETRY_OFFER';}catch(e){return 'ERR:'+e.message;}})()" | tail -1 | sed 's/^/    /'
  sleep 20
else
  echo "  WARN: aucun transfert en cours détecté (poursuite du scénario)"
fi
echo "$inprog" > "$OUT/dumps/incident3-inprog.txt"
logs_all "INC3"

mark "TAKE T5 : REC 15 min"
run_take "T5" 900 || { echo "FATAL T5"; exit 1; }
T5=$(cat "$OUT/dumps/TN-T5.txt"); snap_disk "after-T5"

mark "TAKE T6 : REC 5 min"
run_take "T6" 300 || { echo "FATAL T6"; exit 1; }
T6=$(cat "$OUT/dumps/TN-T6.txt"); snap_disk "after-T6"

echo "$T1 $T2 $T3 $T4 $T5 $T6" > "$OUT/dumps/takes.txt"

# =======================================================================
mark "PHASE 3 — attente de TOUS les transferts (B->C et D->C pour les 6 Takes)"
: > "$OUT/dumps/transfer-progress.log"
wpoll=0; allok=no
# Sortie sur états terminaux (done|error) : un transfert en erreur définitive ne doit pas faire
# patienter la campagne 1800 s, mais ne compte JAMAIS comme complet.
while [ "$wpoll" -lt 1800 ]; do
  line="t=${wpoll}s"; tot=0; done_n=0; term_n=0; err_n=0
  for tk in $T1 $T2 $T3 $T4 $T5 $T6; do
    tv=$(tr_take "$A" "$SID" "$tk"); dn=$(tr_done_n "$tv"); en=$(tr_err_n "$tv")
    echo "$tv" > "$OUT/dumps/transfer-A-T$tk.json"
    line="$line T$tk=$dn/2+${en}err"; tot=$((tot+2)); done_n=$((done_n+dn)); err_n=$((err_n+en)); term_n=$((term_n+dn+en))
  done
  echo "$line" | tee -a "$OUT/dumps/transfer-progress.log"
  if [ "$term_n" -ge "$tot" ]; then
    if [ "$done_n" -ge "$tot" ]; then allok=yes; else allok=partial; fi
    break
  fi
  # relance périodique des offres pour les transferts coincés (reprise avec offset)
  if [ "$wpoll" -gt 0 ] && [ $(( wpoll % 120 )) -eq 0 ]; then
    ev "$A" "(function(){try{MultiCamTransferBootInstance.retry('$BDID');MultiCamTransferBootInstance.retry('$DDID');return 'NUDGE';}catch(e){return 'ERR';}})()" >/dev/null 2>&1
  fi
  sleep 20; wpoll=$((wpoll+20))
done
echo "  transferts complets=$allok (done=$done_n/$tot erreurs=$err_n)"
for tk in $T1 $T2 $T3 $T4 $T5 $T6; do
  tr_take "$C" "$SID" "$tk" > "$OUT/dumps/transfer-C-T$tk.json"
done
echo "$allok" > "$OUT/dumps/transfers-all-done.txt"

# =======================================================================
mark "PHASE 5 — INTEGRITE : inventaire final, SHA-256, durées, disque"
for s in $A $B $C $D; do logs "$s" "J14D"; done
stop_sampler() { rm -f "$OUT/.sampler"; kill "$SAMPLER" 2>/dev/null; }
stop_sampler

CONFIGDIR=/sdcard/Android/data/$APP/files/MultiCam
for s in $B $C $D; do
  # tous les fichiers, 0 octet inclus (une copie échouée à 0 octet doit échouer explicitement, pas disparaître)
  ADB -s "$s" shell "find $CONFIGDIR/$SID -type f 2>/dev/null" | tr -d '\r' > "$OUT/dumps/media-$s.txt"
  : > "$OUT/dumps/sha-$s.txt"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    h=$(ADB -s "$s" shell "sha256sum '$f' 2>/dev/null" | tr -d '\r' | awk '{print $1}')
    b=$(ADB -s "$s" shell "stat -c %s '$f' 2>/dev/null" | tr -d '\r')
    d=$(take_duration_s "$s" "$f")
    echo "$f sha256=$h bytes=$b duration_s=$d" >> "$OUT/dumps/sha-$s.txt"
  done < "$OUT/dumps/media-$s.txt"
  echo "  $s media=$(wc -l < "$OUT/dumps/media-$s.txt" | tr -d ' ') (sha: $(grep -c sha256 "$OUT/dumps/sha-$s.txt" | tr -d ' '))"
done

ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return JSON.stringify({sid:s.sessionId,name:s.name,pin:s.pin,takes:(s.takes||[]).map(function(t){return {takeNumber:t.takeNumber,captures:t.captures,storages:t.storages,settings:t.settings};})});})()" > "$OUT/dumps/A-takes-final.json"
ev "$A" "(async function(){var l=await MultiCamSessionStore.list();return JSON.stringify(l.map(function(x){return {sid:x.sessionId,name:x.name,takes:(x.takes||[]).length};}));})()" > "$OUT/dumps/sessions-after.json"
ev "$A" "(function(){return JSON.stringify(MultiCamTransferBootInstance.view());})()" > "$OUT/dumps/transfer-A-view-final.json"
dump "$A" "(function(){return JSON.stringify(MultiCamStartService.view());})()" "startview-A-final.json"
for s in $A $B $C $D; do shot "$s" "final-$(echo $s | cut -c1-8)"; done
snap_disk "final"
for s in $B $C $D; do
  ADB -s "$s" shell "du -sk $CONFIGDIR 2>/dev/null" | tr -d '\r' >> "$OUT/dumps/du-final.txt"
done

# --- compteurs B02 finaux (depuis purge logcat de la PHASE 1.7, buffer 16M) ---
: > "$OUT/dumps/b02-final.txt"
for s in $A $B $C $D; do
  skip=$(ADB -s "$s" logcat -d 2>/dev/null | grep -cE 'SESSION_ADVERTISE_SKIP' | tr -d ' ')
  rs=$(ADB -s "$s" logcat -d 2>/dev/null | grep -cE 'RE_SYNC_THROTTLED' | tr -d ' ')
  echo "$s SESSION_ADVERTISE_SKIP=${skip:-0} RE_SYNC_THROTTLED=${rs:-0}" >> "$OUT/dumps/b02-final.txt"
done
cat "$OUT/dumps/b02-final.txt" | sed 's/^/  /'

# --- PHASE 6 : intégrité par Take : SHA source (inventaire local, avant purge) vs SHA destination C ---
mark "PHASE 6 — INTEGRITE PAR TAKE (source vs destination, DONE, ordre HASH->DELETE)"
: > "$OUT/dumps/verdict.txt"
for label in T1 T2 T3 T4 T5 T6; do
  tk=$(cat "$OUT/dumps/TN-$label.txt" 2>/dev/null); [ -z "$tk" ] && continue
  tr_take "$A" "$SID" "$tk" > "$OUT/dumps/tr-A-$label.json" 2>/dev/null
  tr_take "$C" "$SID" "$tk" > "$OUT/dumps/tr-C-$label.json" 2>/dev/null
done
if ! bash "$HERE/j14d-integrity.sh" "$OUT" "$SID" "$C" "$BDID" "$DDID"; then
  echo "  WARN: intégrité NON conforme — voir $OUT/dumps/verdict.txt"
fi

# --- ordre HASH -> DELETE (suppression source après confirmation d'intégrité), PAR Take x Source ---
mark "PHASE 6.1 — ordre TRANSFER_HASH puis TRANSFER_DELETE (Master, par Take x Source)"
# dump logcat frais (le snapshot PHASE 5 peut précéder les derniers HASH/DELETE — ex. T6)
for s in "$A" "$B" "$D"; do
  ADB -s "$s" logcat -d -v time 2>/dev/null > "$OUT/dumps/logcat-$s-phase61.log"
done
# état RÉEL des sources à l'instant du verdict (preuve directefiles: le fichier est-il encore là ?)
for s in "$B" "$D"; do
  ADB -s "$s" shell "find $CONFIGDIR/$SID -type f 2>/dev/null" | tr -d '\r' > "$OUT/dumps/media-$s-phase61.txt"
done
OUTDv="$OUT/dumps" ASERv="$A" BSERv="$B" DSERv="$D" BDIDv="$BDID" DDIDv="$DDID" node <<'NODE' | tee "$OUT/dumps/delete-order.txt"
const fs = require("fs");
const OUTD = process.env.OUTDv, ASER = process.env.ASERv, BSER = process.env.BSERv, DSER = process.env.DSERv;
const BDID = process.env.BDIDv, DDID = process.env.DDIDv;
const tagOf = (src) => src === BDID ? "B" : src === DDID ? "D" : "?";
// source SHA -> tag (attribution déterministe des lignes TRANSFER_HASH, qui ne portent pas le deviceId)
const shaMap = {};
for (const tag of ["B", "D"]) for (let tk = 1; tk <= 6; tk++) {
  const f = OUTD + "/local-sha-T" + tk + "-" + tag + ".txt";
  if (!fs.existsSync(f)) continue;
  for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    const m = l.match(/sha256=([0-9a-f]{64})/);
    if (m && !/^e3b0c442/.test(m[1])) shaMap[m[1]] = tag;
  }
}
const readFile = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return ""; } };
const evs = []; const seen = new Set();
const push = (o) => { const k = [o.type, o.take, o.src || o.sha, o.ts].join("|"); if (seen.has(k)) return; seen.add(k); evs.push(o); };
const scan = (txt, fTag) => {
  for (const l of txt.split("\n")) {
    let m;
    if ((m = l.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+).*"TRANSFER_HASH take=(\d+) sourceSha256=([0-9a-f]+) storageSha256=(\S+)"/)))
      push({ type: "hash", ts: m[1], take: +m[2], sha: m[3], valid: m[4] !== "—" && m[4] !== "-" });
    else if ((m = l.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+).*"TRANSFER_DELETE take=(\d+) source=(\S+)"/)))
      push({ type: "del", ts: m[1], take: +m[2], src: m[3] });
    else if ((m = l.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+).*"TRANSFER_DELETE_ACK take=(\d+) source=(\S+)"/)))
      push({ type: "ack", ts: m[1], take: +m[2], src: m[3] });
    else if ((m = l.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+).*"TRANSFER_LOCAL_DELETED take=(\d+) files=(\d+)"/)))
      push({ type: "local", ts: m[1], take: +m[2], files: +m[3], tag: fTag });
  }
};
// Master : tous les snapshots de la campagne + dump frais PHASE 6.1
// (les buffers logcat tournent : une ligne peut n'exister que dans un snapshot par Take/INC)
const LOGD = OUTD + "/../logs";
const scanAll = (ser, fTag) => {
  let names = [];
  try { names = fs.readdirSync(LOGD); } catch (e) {}
  for (const n of names.filter((x) => x.startsWith(ser + "-") && x.endsWith(".log")))
    scan(readFile(LOGD + "/" + n), fTag);
  scan(readFile(OUTD + "/logcat-" + ser + "-phase61.log"), fTag);
};
scanAll(ASER, "A");
// sources : LOCAL_DELETED (ligne locale au device, sans deviceId → tag déduit du fichier)
scanAll(BSER, "B");
scanAll(DSER, "D");
const first = (p) => { const c = evs.filter(p).sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0); return c[0]; };
const short = (x) => x ? x.ts.replace(/^\d\d-\d\d /, "") : "ABSENT";
// source encore présente sur le device ? (find PHASE 6.1 : .../<SID>/<take>/[<did>/]fichier)
const present = (ser, tk) => readFile(OUTD + "/media-" + ser + "-phase61.txt").split("\n").some((l) => l.indexOf("/" + tk + "/") >= 0);
const lines = ["# take,source,hash_ts,hash_valid,delete_req_ts,ack_ts,local_files,source_presente,ordre,verdict"];
for (const src of [BDID, DDID]) for (let tk = 1; tk <= 6; tk++) {
  const tag = tagOf(src);
  const hv = first((e) => e.type === "hash" && e.take === tk && e.valid && shaMap[e.sha] === tag);
  const hi = first((e) => e.type === "hash" && e.take === tk && !e.valid && shaMap[e.sha] === tag);
  const del = first((e) => e.type === "del" && e.take === tk && e.src === src);
  const ack = first((e) => e.type === "ack" && e.take === tk && e.src === src);
  const loc = first((e) => e.type === "local" && e.take === tk && e.tag === tag);
  let ordre;
  if (del && hv) ordre = hv.ts <= del.ts ? "OK" : "ECHEC_HASH_APRES_DELETE";
  else if (del && !hv) ordre = "ECHEC_SUPPRESSION_SANS_HASH";
  else if (!del && hv) ordre = "SUPPRESSION_ABSENTE";
  else ordre = "OK_AUCUNE_SUPPRESSION";
  const files = loc === undefined ? "?" : String(loc.files);
  const pres = present(src === BDID ? BSER : DSER, tk) ? "oui" : "non";
  let verdict = "OK";
  if (del && files === "0" && pres === "oui") verdict = "ANOMALIE_CONFIRMEE_SOURCE_PRESENTE";
  else if (del && files === "0" && pres === "non") verdict = "OK";
  else if (del && files !== "0" && pres === "oui") verdict = "ECHEC_SUPPRESSION_INCOMPLETE";
  else if (!del && pres === "oui") verdict = "OK_SOURCE_CONSERVEE";
  else if (!del && pres === "non") verdict = "ECHEC_DISPARITION_SANS_DELETE";
  else if (ordre.startsWith("ECHEC")) verdict = "ECHEC";
  else if (files === "?") verdict = "INCONNU";
  lines.push([tk, tag, short(hv || hi), hv ? "oui" : (hi ? "non" : "ABSENT"), short(del), short(ack), files, pres, ordre, verdict].join(","));
}
console.log(lines.join("\n"));
NODE

TENDWALL=$(date +%s)
echo "$(( TENDWALL - T0WALL ))" > "$OUT/dumps/campaign-seconds.txt"

echo
echo "=== CAMPAGNE TERMINEE ==="
echo "EVIDENCE_DIR=$OUT"
echo "SID=$SID takes: $T1 $T2 $T3 $T4 $T5 $T6"
echo "duree totale: $(( TENDWALL - T0WALL )) s"
echo "verdict integrite: $(grep 'VERDICT GLOBAL' "$OUT/dumps/verdict.txt" | tail -1)"
