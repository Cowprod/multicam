#!/usr/bin/env bash
# MultiCam — J16-P0 : campagne de VALIDATION PHYSIQUE de la persistance
# résistante aux interruptions (correctif écriture atomique du manifeste).
#
# Objectif : prouver sur APPAREIL que, quel que soit le point d'interruption
# pendant une sauvegarde de session, une version VALIDE reste récupérable au
# redémarrage — sans perte du Take de campagne ni de ses métadonnées
# (stopStates / replications J16-A), et sans recréer une session supprimée.
#
# Montage (identique à J15/J16-A, sessions de TEST uniquement) :
#   A=61cc29567d91  Master (pilotage + stockage du manifeste) "J16P0-A-Master"
#   B=61d54bba7d91  Capture                                  "J16P0-B-Capture"
#   C=c0d8514d7d87  Storage                                  "J16P0-C-Storage"
#
# PROTOCOLE (important) :
#   La state de session est répliquée en CONTINU entre pairs (telemetry_update,
#   §J05 merge "newest wins"). Le NOM n'est donc PAS un marqueur fiable de
#   version. On marque les versions par teneur : la sauvegarde instrumentée ne
#   modifie que `updatedAtMs` (timestamp unique `armedTs`) ; l'app calcule dans
#   la WebView le SHA-256 du texte écrit ; le harnais compare CES empreintes aux
#   bytes réellement présents sur disque (via run-as, build debug).
#
# Instrumentation de test : `window.MultiCamSessionStoreDebug` est INJECTÉ via
# la console WebView (CDP). En production cet objet n'existe pas : chaque
# `stage()` est un no-op (T23 unitaire). L'interruption est un VRAI
# `am force-stop` DURANT l'attente planifiée au point nommé (delayMs).
#
# Phases (chaque phase = snapshot disque AVANT, armation, force-stop,
# snapshot disque APRÈS kill (app morte → aucune contamination WS),
# relance, vérifications store + disque + logs SESSION_RECOVER) :
#   base  — Take 20 s (stopStates + replications persistent) puis 2
#           sauvegardes ordinaires : le bak est créé (rotation).
#   p1 — kill AVANT création du tmp (`before_tmp`)          : primaire inchangé.
#   p2 — kill PENDANT l'écriture tmp (`tmp_truncated`)      : primaire inchangé.
#   p3 — kill APRÈS écriture tmp (`tmp_written`)            : tmp = version armée.
#   p4 — kill APRÈS VÉRIFICATION tmp (`tmp_verified`)       : tmp = version armée.
#   p5 — kill PENDANT la rotation (`bak_removed`)           : primaire + tmp armé.
#   p6 — kill PENDANT le remplacement (`primary_moved`)     : bak + tmp armé.
#   p7 — kill APRÈS commit (`committed`)                    : primaire = version armée.
#   delete — suppression volontaire de la session de test
#          puis redémarrage : AUCUNE résurrection.
#
# Usage : MODE=setup tests/e2e/j16p0-campaign.sh   (puis base, p1..p7, delete)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J16-P0"
CDP="$HERE/lib/cdp.js"
APP=fr.emmanuel.multicam

A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87
DEVS="$A $B $C"
NAME_A="J16P0-A-Master"; NAME_B="J16P0-B-Capture"; NAME_C="J16P0-C-Storage"

mkdir -p "$OUT"/{screenshots,logs,dumps,events}

run_to() { local t="$1"; shift; ( "$@" </dev/null ) & local p=$!; ( sleep "$t"; if kill -0 "$p" 2>/dev/null; then kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null; fi ) >/dev/null 2>&1 & wait "$p" 2>/dev/null; }
ADB() { run_to 25 adb "$@"; }
ev()  { run_to 90 node "$CDP" "$1" eval "$2"; }
evs() { ev "$1" "$2" | tail -1 | sed 's/^"//; s/"$//'; }
shot() { run_to 25 adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "  shot $2"; }

TL=""; LABEL=""; VERDICT=""
mark() { echo "### [$(date +%H:%M:%S)] $1" | tee -a "$TL"; }

logs() { ADB -s "$1" logcat -d -v time 2>/dev/null > "$OUT/logs/$1-raw-$2.log"; \
  grep -E "SESSION_STORE|SESSION_RECOVER|SESSION_REMOVE|SYNC_BROADCAST|RENAME_APPLIED" "$OUT/logs/$1-raw-$2.log" > "$OUT/logs/$1-$2.log" 2>/dev/null; \
  echo "  logs $1-$2 (filtered=$(wc -l < "$OUT/logs/$1-$2.log" | tr -d ' ') lines)"; }

recovers() { # $1=serial $2=tag
  ADB -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION_RECOVER|SESSION_STORE_STAGE|SESSION_STORE_SAVE" | tail -40 > "$OUT/dumps/store-log-$2.txt" 2>/dev/null
  sed 's/^/    /' "$OUT/dumps/store-log-$2.txt" | grep -E "SESSION_RECOVER" | head -8
}

verdict() { echo "$1=$2" | tee -a "$VERDICT"; }
scenario_begin() { LABEL="$1"; TL="$OUT/events/$LABEL-timeline.txt"; VERDICT="$OUT/dumps/verdict-$LABEL.txt"
  : > "$TL"; : > "$VERDICT"
  for s in $DEVS; do ADB -s "$s" logcat -c >/dev/null 2>&1; done
  mark "DEBUT SCENARIO $LABEL"; }
scenario_end() {
  mark "FIN SCENARIO $LABEL"
  for s in $DEVS; do logs "$s" "$LABEL"; done
  echo "---- VERDICT $LABEL ----"; cat "$VERDICT"; echo "-------------------------"; }

get_sid() { cat "$OUT/dumps/sid.txt" 2>/dev/null; }
get_pin() { cat "$OUT/dumps/pin.txt" 2>/dev/null; }

wait_pid() { local s="$1" t="${2:-40}" p=0 pid=""
  while [ "$p" -lt "$t" ]; do
    pid=$(ADB -s "$s" shell pidof "$APP" 2>/dev/null | tr -d '\r')
    [ -n "$pid" ] && { echo "  pid up $s=$pid (t=${p}s)"; return 0; }
    sleep 2; p=$(( p + 2 ))
  done
  echo "  WARN pid absent $s après ${t}s"; return 1; }

relaunch() {
  ADB -s "$1" shell am force-stop "$APP" >/dev/null 2>&1
  ADB -s "$1" logcat -c >/dev/null 2>&1
  ADB -s "$1" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  wait_pid "$1" 60
  sleep 3; }

role_cfg() { ev "$1" "(async function(){await MultiCamConfig.setSkill('capture',$2);await MultiCamConfig.setSkill('storage',$3);await MultiCamConfig.setSkill('controller',$4);await MultiCamConfig.setDeviceName('$5');return JSON.stringify(MultiCamConfig.get().enabledSkills);})()" | tail -1; }

sid_by_name() { local r; r=$(ev "$1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.name==='$2';});return s.length?s[s.length-1].sessionId:'NOT_FOUND';})()"); echo "${r//\"/}"; }

wait_announce() { local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local a=$(ev "$s" "(function(){var l=MultiCamSessionDiscovery.list();var x=l.filter(function(y){return y.sessionId==='$sid';});if(!x.length)return '0';var an=(x[0].announcers||[]);return an.length?an[an.length-1].host+':'+an[an.length-1].port:'0';})()")
    a="${a//\"/}"
    if [ "$a" != "0" ]; then echo "  ANNOUNCE_OK $label $a (t=${poll}s)"; echo "$a" | tr ':' ' ' > "$OUT/dumps/endpoint-$s.txt"; return 0; fi
    sleep 3; poll=$(( poll + 3 ))
  done
  echo "  ANNOUNCE_FAIL $label TIMEOUT 60s"; return 1; }

wait_session_on() { local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 90 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "  SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "  SESSION_JOINED $label TIMEOUT"; return 1; }

# ---------- snapshots disque du manifeste (run-as, build debug) ----------

pull_files() { # $1=serial $2=tag : raw dumps des trois fichiers possibles
  local s="$1" t="$2"
  ADB -s "$s" shell "run-as $APP sh -c 'cat files/sessions/${SID}.json 2>/dev/null'" > "$OUT/dumps/primary-$t.raw" 2>/dev/null
  ADB -s "$s" shell "run-as $APP sh -c 'cat files/sessions/${SID}.json.tmp 2>/dev/null'" > "$OUT/dumps/tmp-$t.raw" 2>/dev/null
  ADB -s "$s" shell "run-as $APP sh -c 'cat files/sessions/${SID}.json.bak 2>/dev/null'" > "$OUT/dumps/bak-$t.raw" 2>/dev/null
  ADB -s "$s" shell "run-as $APP sh -c 'ls -la files/sessions/ 2>/dev/null'" | tr -d '\r' > "$OUT/dumps/ls-$t.txt"
}

# EXACTNESS PROBLEM : `adb shell run-as cat` n'ajoute ni header ni footer, mais
# le CRLF peut être injecté par certaines shells. On NE corrige RIEN :
# le JSON produit par JSON.stringify(...,null,2) ne contient jamais de \r.
# Les tailles/sha sont donc fiables.
disk_state() { # $1=tag : json compact {primary,tmp,bak} = sha + bytes + sid/updated
  node -e "
    const fs=require('fs'),crypto=require('crypto');
    const tag='$1', base='$OUT/dumps';
    function one(n){
      const p=base+'/'+n+'-'+tag+'.raw';
      if(!fs.existsSync(p)) return null;
      const b=fs.readFileSync(p);
      const raw=b.toString('utf8');
      // adb shell tr -d noop: éventuels \r pouvant venir du pipe : on ignore (JSON sans \r)
      const txt=raw.replace(/\r/g,'').replace(/^\n/,'').replace(/\n$/,'');
      const bytes=txt.length;
      if(!bytes) return {sha:'',bytes:0,valid:false};
      try{
        const d=JSON.parse(txt);
        return {sha:crypto.createHash('sha256').update(txt,'utf8').digest('hex'),
                bytes:bytes, valid: !!(d&&d.sessionId==='$SID'),
                updated:d.updatedAtMs||0, name:d.name||'', takes:(d.takes||[]).length,
                pin:d.pin, members:(d.members||[]).length};
      }catch(e){ return {sha:'',bytes:bytes,valid:false}; }
    }
    console.log(JSON.stringify({primary:one('primary'),tmp:one('tmp'),bak:one('bak')}));
  " > "$OUT/dumps/disk-$1.json"
  sed 's/^/    /' "$OUT/dumps/disk-$1.json"; }

verr() { # extraire un champ du disk_state tag
  node -e "
    const d=JSON.parse(require('fs').readFileSync('$OUT/dumps/disk-$1.json','utf8'));
    const [obj,field]=process.argv.slice(1);
    const v=(d[obj]||{}); let out;
    if(field==='sha') out=v.sha?v.sha.slice(0,16):'';
    else out=v[field];
    console.log(out===undefined?'∅':out);
  " "$2" "$3"
}

# ---------- armation CDP (le sha est calculé DANS la WebView) ----------

arm_save() { # $1=serial $2=stage $3=delayms
  local raw
  raw=$(ev "$1" "(async function(){
    window.MultiCamSessionStoreDebug={enabled:true,stage:'$2',delayMs:$3};window.__lastSessionStoreStage='';
    var s=await MultiCamSessionStore.get('$SID');
    if(!s) return 'ARMED_NO_SESSION';
    s.updatedAtMs=Date.now();
    var text=JSON.stringify(s,null,2);
    var digestBuf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    var sha=''; new Uint8Array(digestBuf).forEach(function(b){var h=b.toString(16);if(h.length<2)h='0'+h;sha+=h;});
    window.__P0SHA=sha;
    window.__P0SAVE=MultiCamSessionStore.save(s).then(function(){return 'SAVE_DONE';},function(e){return 'SAVE_ERR '+e;});
    return JSON.stringify({armed:true,stage:'$2',delayMs:$3,len:text.length,sha:sha,updatedAtMs:s.updatedAtMs});
  })()" | tail -1)
  # cdp.js imprime une CHAINE JSON (guillemets externes + echappements internes).
  # La valeur applicative est le resultat de JSON.parse ; on la re-emet VERBATIM
  # pour que les JSON.parse des lignes suivantes recoivent bien le JSON d'origine.
  # Sans cela, l'armation etait lue comme FAIL alors qu'elle avait reussi
  # (constat P1 du 2026-10-25, harnais seul — aucun defaut produit).
  node -e "
    try { var v=JSON.parse(process.argv[1]); process.stdout.write(typeof v==='string'?v:JSON.stringify(v)); }
    catch (e) { process.stdout.write(process.argv[1]); }
  " "$raw"
}

# ---------- sauvegarde ordinaire ----------

do_save() {
  ev "$1" "(function(){return MultiCamSessionStore.get('$SID').then(function(s){if(!s)return 'NO_SESSION';s.updatedAtMs=Date.now();return MultiCamSessionStore.save(s);}).then(function(){return 'SAVE_OK';},function(e){return 'SAVE_ERR '+e;});})()" | tail -1 | sed 's/^"//; s/"$//' | sed 's/^/  /'
}

# destruction soft : on tue le processus à ~milieu de l'attente planifiée
kill_mid() { # $1=delayms
  local secs; secs=$(node -e "console.log($1>=3000?'1.5':($1>=2500?'1.2':'0.8'))")
  sleep "$secs"
  ADB -s "$A" shell am force-stop "$APP" >/dev/null 2>&1
  echo "  FORCE-STOP t=${secs}s après l'armation (delay=${1}ms)"
  sleep 1
  local gone; gone=$(ADB -s "$A" shell pidof "$APP" 2>/dev/null | tr -d '\r')
  if [ -z "$gone" ]; then echo "  PROCESS DEAD ✔"; else
    echo "  PROCESS ALIVE ($gone) — second force-stop"
    ADB -s "$A" shell am force-stop "$APP" >/dev/null 2>&1
    sleep 1
  fi
}

# ---------- vérifications APRÈS relance ----------

verify_store() { # $1=phase-tag
  local PH="$1" UPH; UPH=$(echo "$PH" | tr '[:lower:]' '[:upper:]')
  local svcint
  svcint=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');
    if(!s)return 'MISSING';
    var t1=(s.takes||[]).filter(function(x){return x.takeNumber===1;})[0]||{};
    var sm=t1.summary||{};
    return JSON.stringify({name:s.name,pin:s.pin!=='$PIN'?'CHANGED':'unchanged',state:s.state,
      members:(s.members||[]).length,takes:(s.takes||[]).length,
      stopStates:Object.keys(sm.stopStates||{}).length,
      replications:Object.keys(sm.replications||{}).length,
      sid:s.sessionId==='$SID'?'ok':'MISMATCH'});})()")
  svcint=$(echo "$svcint" | tr -d '\\')
  echo "  store: $svcint"
  verdict "${UPH}_STORE_SERVED" "$svcint"
  echo "$svcint" | grep -q '"sid":"ok"' && echo "$svcint" | grep -q '"takes":[1-9][0-9]*,' \
    && echo "$svcint" | grep -q '"pin":"unchanged"' \
    && verdict "${UPH}_STORE_DATA_INTACT" "PASS" \
    || verdict "${UPH}_STORE_DATA_INTACT" "FAIL"
  echo "$svcint" | grep -q '"stopStates":[1-9][0-9]*,' \
    && verdict "${UPH}_STOPSTATES_SURVIVED" "PASS" \
    || verdict "${UPH}_STOPSTATES_SURVIVED" "FAIL"
  echo "$svcint" | grep -q '"replications":[1-9][0-9]*,' \
    && verdict "${UPH}_REPLICATIONS_SURVIVED" "PASS" \
    || verdict "${UPH}_REPLICATIONS_SURVIVED" "FAIL"
}

do_phase() { # $1=p1..p7
  SID=$(get_sid) PIN=$(get_pin)
  [ -n "$SID" ] || { echo "FATAL: MODE=setup d'abord"; exit 1; }
  local PH="$1" UPH STAGE DELAY
  UPH=$(echo "$PH" | tr '[:lower:]' '[:upper:]')
  case "$PH" in
    p1) STAGE="before_tmp"   ; DELAY=6000 ;;
    p2) STAGE="tmp_truncated"; DELAY=4000 ;;
    p3) STAGE="tmp_written"  ; DELAY=4000 ;;
    p4) STAGE="tmp_verified" ; DELAY=4000 ;;
    p5) STAGE="bak_removed"  ; DELAY=4000 ;;
    p6) STAGE="primary_moved"; DELAY=4000 ;;
    p7) STAGE="committed"    ; DELAY=2000 ;;
  esac

  scenario_begin "PHASE-$PH ($STAGE)"

  mark "PHASE-$PH : snapshot disque AVANT armation"
  pull_files "$A" "$PH-before"; disk_state "$PH-before"
  local H0 B0
  H0=$(verr "$PH-before" primary sha); B0=$(verr "$PH-before" bak sha)
  verdict "${UPH}_PRESHA_PRIMARY" "$H0"
  verdict "${UPH}_PRESHA_BAK" "$B0"

  mark "PHASE-$PH : armation (stage=$STAGE delay=${DELAY}ms)"
  local ARM; ARM=$(arm_save "$A" "$STAGE" "$DELAY")
  echo "  arm=$ARM"
  local HN
  HN=$(node -e "try{console.log(JSON.parse(process.argv[1]).sha||'')}catch(e){console.log('')}" "$ARM" | cut -c1-16)
  local LN
  LN=$(node -e "try{console.log(String(JSON.parse(process.argv[1]).len||''))}catch(e){console.log('')}" "$ARM")
  local ARM_TS
  ARM_TS=$(node -e "try{console.log(String(JSON.parse(process.argv[1]).updatedAtMs||''))}catch(e){console.log('')}" "$ARM")
  if [ -z "$HN" ]; then verdict "${UPH}_ARMED" "FAIL ($ARM)"; scenario_end; verify_store "$PH"; return; fi
  verdict "${UPH}_ARMED_SHA" "$HN"
  verdict "${UPH}_ARMED_LEN" "$LN"
  verdict "${UPH}_ARMED_TS" "$ARM_TS"

  mark "PHASE-$PH : force-stop au cœur de la phase"
  kill_mid "$DELAY"

  mark "PHASE-$PH : snapshot disque APRÈS kill (app morte — aucune contamination WS)"
  pull_files "$A" "$PH-killed"; disk_state "$PH-killed"
  local KP KT KB
  KP=$(verr "$PH-killed" primary sha); KT=$(verr "$PH-killed" tmp sha); KB=$(verr "$PH-killed" bak sha)
  local KPb KTb KBb
  KPb=$(verr "$PH-killed" primary bytes); KTb=$(verr "$PH-killed" tmp bytes); KBb=$(verr "$PH-killed" bak bytes)
  echo "  killed: primary=${KP:0:8}/$KPb tmp=${KT:0:8}/$KTb bak=${KB:0:8}/$KBb"
  case "$PH" in
    p1|p2)
      [ "$KP" = "$H0" ] && verdict "${UPH}_PRIMARY_UNTOUCHED" "PASS" || verdict "${UPH}_PRIMARY_UNTOUCHED" "FAIL (prim=${KP:0:8} att=${H0:0:8})"
      [ "$KTb" -eq 0 ] 2>/dev/null && verdict "${UPH}_TMP_ABSENT" "PASS (tmp absent/vide)" \
        || { [ "$KT" = "$HN" ] && [ "$KP" = "$H0" ] && verdict "${UPH}_TMP_ABSENT" "PASS (tmp complet mais non publié — primaire intact)" \
             || verdict "${UPH}_TMP_ABSENT" "FAIL (tmp=$KTb bytes, primaire modifié)"; } ;;
    p3|p4)
      [ "$KT" = "$HN" ] && [ "$KTb" = "$LN" ] && verdict "${UPH}_TMP_IS_ARMED" "PASS" || verdict "${UPH}_TMP_IS_ARMED" "FAIL (tmp=${KT:0:8}/${KTb}b/armé=${HN:0:8}/${LN})"
      [ "$KP" = "$H0" ] && verdict "${UPH}_PRIMARY_UNTOUCHED" "PASS" || verdict "${UPH}_PRIMARY_UNTOUCHED" "FAIL (prim=${KP:0:8} att=${H0:0:8})" ;;
    p5)
      [ "$KP" = "$H0" ] && verdict "${UPH}_PRIMARY_UNTOUCHED" "PASS" || verdict "${UPH}_PRIMARY_UNTOUCHED" "FAIL (prim=${KP:0:8} att=${H0:0:8})"
      [ "$KT" = "$HN" ] && verdict "${UPH}_TMP_IS_ARMED" "PASS" || verdict "${UPH}_TMP_IS_ARMED" "FAIL" ;;
    p6)
      [ "$KPb" -eq 0 ] 2>/dev/null && verdict "${UPH}_PRIMARY_ABSENT" "PASS" || verdict "${UPH}_PRIMARY_ABSENT" "FAIL (primaire encore présent)"
      [ "$KB" = "$H0" ] && verdict "${UPH}_BAK_IS_OLD_PRIMARY" "PASS" || verdict "${UPH}_BAK_IS_OLD_PRIMARY" "FAIL (bak=${KB:0:8}/$KBb att=${H0:0:8})"
      [ "$KT" = "$HN" ] && verdict "${UPH}_TMP_IS_ARMED" "PASS" || verdict "${UPH}_TMP_IS_ARMED" "FAIL" ;;
    p7)
      [ "$KP" = "$HN" ] && verdict "${UPH}_PRIMARY_IS_ARMED" "PASS" || verdict "${UPH}_PRIMARY_IS_ARMED" "FAIL (prim=${KP:0:8}/$KPb armé=${HN:0:8}/$LN)" ;;
  esac

  mark "PHASE-$PH : relance + récupération"
  relaunch "$A"
  sleep 2
  recovers "$A" "$PH"
  shot "$A" "$PH-A"

  mark "PHASE-$PH : vérifications APRÈS relance"
  verify_store "$PH"

  pull_files "$A" "$PH-after"; disk_state "$PH-after"
  local AP AT AB APb
  AP=$(verr "$PH-after" primary sha); AT=$(verr "$PH-after" tmp sha); AB=$(verr "$PH-after" bak sha)
  APb=$(verr "$PH-after" primary bytes)
  echo "  after: primary=${AP:0:8}/$APb tmp=${AT:0:8} bak=${AB:0:8}"
  case "$PH" in
    p1|p2)
      [ "$AP" = "$H0" ] && verdict "${UPH}_AFTER_PRIMARY_CONVERGED" "PASS (primaire == avant armation)" \
        || verdict "${UPH}_AFTER_PRIMARY_CONVERGED" "INFO (primaire=$AP:8 — convergence possible via merge WS)"
      [ "$APb" -gt 0 ] 2>/dev/null && verdict "${UPH}_AFTER_PRIMARY_KEEP" "PASS (>= 1 version valide)" \
        || verdict "${UPH}_AFTER_PRIMARY_KEEP" "FAIL (aucune version)" ;;
    *)
      { [ "$AP" = "$HN" ] || [ "$AP" = "$H0" ]; } && verdict "${UPH}_AFTER_PRIMARY_CONVERGED" "PASS (primaire ∈ {armé, avant})" \
        || verdict "${UPH}_AFTER_PRIMARY_CONVERGED" "INFO (primaire=$AP:8 — convergence possible via merge WS)"
      [ "$APb" -gt 0 ] 2>/dev/null && verdict "${UPH}_AFTER_PRIMARY_KEEP" "PASS (>= 1 version valide)" \
        || verdict "${UPH}_AFTER_PRIMARY_KEEP" "FAIL (aucune version)" ;;
  esac

  mark "PHASE-$PH : reprise des écritures (sauvegarde ordinaire de consolidation)"
  local RS; RS=$(do_save "$A")
  verdict "${UPH}_RESAVE_OK" "$(echo "$RS" | grep -q "SAVE_OK" && echo PASS || echo "FAIL ($RS)")"
  scenario_end
}

# ---------------------------------------------------------------- setup

do_setup() {
  scenario_begin "SETUP-J16P0"
  ADB devices -l | sed 's/^/  /' | tee "$OUT/dumps/adb-devices.txt"
  for s in $DEVS; do ADB -s "$s" get-state 2>/dev/null | grep -q device || { echo "FATAL: $s indisponible"; exit 1; }; done

  mark "SETUP-1 : skills + relance A/B/C (test devices seulement)"
  for s in $DEVS; do ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
                      ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1; done
  for s in $DEVS; do wait_pid "$s" 60; done
  sleep 4
  role_cfg "$A" false false true  "$NAME_A" 2>/dev/null | tail -1 | sed 's/^/  A roles=/'
  sleep 3
  role_cfg "$B" true  false false "$NAME_B" 2>/dev/null | tail -1 | sed 's/^/  B roles=/'
  sleep 3
  role_cfg "$C" false true  false "$NAME_C" 2>/dev/null | tail -1 | sed 's/^/  C roles=/'
  sleep 2
  for s in $DEVS; do
    ADB -s "$s" shell am force-stop "$APP" >/dev/null 2>&1
    ADB -s "$s" logcat -c >/dev/null 2>&1
    ADB -s "$s" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
    wait_pid "$s" 60
  done
  sleep 4
  for s in $DEVS; do for P in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION POST_NOTIFICATIONS; do
    ADB -s "$s" shell pm grant "$APP" android.permission.$P >/dev/null 2>&1; done; done

  mark "SETUP-2 : session de TEST créée sur A"
  RUN_TAG="P0-$(date +%H%M%S)"; SNAME="Regie $RUN_TAG"
  echo "  SNAME=$SNAME"
  ev "$A" "MultiCamNav.show('create'); 'NAV'" >/dev/null; sleep 2
  ev "$A" "(function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 'CLICKED_CREATE';})()" >/dev/null; sleep 6
  SID=$(sid_by_name "$A" "$SNAME")
  echo "  SESSION_CREATED sid=$SID"
  [ -n "$SID" ] && [ "$SID" != "NOT_FOUND" ] || { echo "FATAL: session introuvable"; exit 1; }
  PIN=$(evs "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');return s.pin;})()")
  echo "  PIN=$PIN"
  echo "$SID" > "$OUT/dumps/sid.txt"; echo "$PIN" > "$OUT/dumps/pin.txt"; echo "$SNAME" > "$OUT/dumps/sname.txt"
  shot "$A" "SETUP-A-session"

  mark "SETUP-3 : B et C rejoignent"
  for dev in $B $C; do
    wait_announce "$dev" "$SID" "SETUP-3-$dev" || { echo "FATAL: $dev ne voit pas $SID"; exit 1; }
    read -r JH JP < "$OUT/dumps/endpoint-$dev.txt"
    ev "$dev" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JH',port:'$JP'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN';})()" >/dev/null
    wait_session_on "$dev" "$SID" "SETUP-3-$dev" || { echo "FATAL: $dev n'a pas rejoint"; exit 1; }
    sleep 2
  done

  mark "SETUP-4 : membres/rôles (B capture, C storage)"
  BDID=$(evs "$B" "MultiCamSessionWs.status().localDid")
  CDID=$(evs "$C" "MultiCamSessionWs.status().localDid")
  ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.addMember(s,{deviceId:'$BDID',deviceName:'$NAME_B',enabledSkills:['capture']},['capture']);r=await MultiCamSessionWs.addMember(r,{deviceId:'$CDID',deviceName:'$NAME_C',enabledSkills:['storage']},['storage']);return JSON.stringify(r.members.map(function(m){return m.deviceName+':'+m.sessionRoles.join('+');}));})()" > "$OUT/dumps/SETUP-4-A-members.json"
  echo -n "  membres sur A : "; tail -c 240 "$OUT/dumps/SETUP-4-A-members.json"; echo
  echo "$BDID" > "$OUT/dumps/did-B.txt"; echo "$CDID" > "$OUT/dumps/did-C.txt"
  shot "$A" "SETUP-A-members"

  mark "SETUP-5 : état disque initial du manifeste"
  pull_files "$A" "setup"; disk_state "setup"
  verdict SETUP_SESSION "PASS"
  scenario_end
}

# ---------------------------------------------------------------- base

do_base() {
  SID=$(get_sid) PIN=$(get_pin)
  [ -n "$SID" ] || { echo "FATAL: MODE=setup d'abord"; exit 1; }
  scenario_begin "BASE-J16P0"

  mark "BASE-1 : Take 20 s nominal (ARM → REC → STOP)"
  ev "$A" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  ev "$A" "document.getElementById('tkCaptureAll').click();'CAP_ALL'" >/dev/null
  ev "$A" "document.getElementById('tkStorageAll').click();'STO_ALL'" >/dev/null
  sleep 4
  shot "$A" "BASE-A-take"
  ev "$A" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null; sleep 3
  local poll=0 armview
  while [ $poll -lt 120 ]; do
    ev "$A" "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$poll.json" 2>/dev/null
    armview=$(node -e "
      const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync('$OUT/dumps/arm-view-$poll.json','utf8'));}catch(e){console.log('no');process.exit(0);}
      if(typeof v==='string')try{v=JSON.parse(v)}catch(e){}
      console.log(v&&v.recEligible===true?'yes':'no');")
    [ "$armview" = "yes" ] && { echo "  ARM_READY (t=${poll}s)"; break; }
    sleep 5; poll=$(( poll + 5 ))
  done
  ev "$A" "(function(){var b=document.getElementById('armRec');if(!b||b.disabled)return 'NO/DIS';b.click();return 'CLICKED';})()" | tail -1 | sed 's/^/    REC: /'
  echo "  phase=$(evs "$A" "MultiCamStartService.view().phase")"
  sleep 20
  ev "$A" "MultiCamStartService.requestStop('P0-base')" >/dev/null 2>&1
  poll=0; local ph=""
  while [ "$ph" = "" ] || { [ "$ph" != "TAKE" ] && [ "$ph" != "IDLE" ] && [ $poll -lt 90 ]; }; do
    ph=$(evs "$A" "MultiCamStartService.view().phase"); sleep 3; poll=$(( poll + 3 )); done
  echo "  REC arrêté → phase=$ph"
  shot "$A" "BASE-A-stopped"

  mark "BASE-2 : résumé Take 1 (stopStates + replications attendus)"
  ev "$A" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[]).filter(function(x){return x.takeNumber===1;})[0];var sm=(t&&t.summary)||{};return JSON.stringify({stopStates:sm.stopStates||{},replications:sm.replications||{}});})()" > "$OUT/dumps/BASE-base-summary.json"
  local n_ss n_rep
  n_ss=$(node -e "const fs=require('fs');let d=JSON.parse(fs.readFileSync('$OUT/dumps/BASE-base-summary.json','utf8'));if(typeof d==='string')d=JSON.parse(d);console.log(Object.keys(d.stopStates||{}).length)" 2>/dev/null)
  n_rep=$(node -e "const fs=require('fs');let d=JSON.parse(fs.readFileSync('$OUT/dumps/BASE-base-summary.json','utf8'));if(typeof d==='string')d=JSON.parse(d);console.log(Object.keys(d.replications||{}).length)" 2>/dev/null)
  verdict BASE_STOP_STATES "$([ "${n_ss:-0}" -ge 1 ] && echo "PASS (stopStates=$n_ss)" || echo "FAIL (stopStates=0)")"
  verdict BASE_REPLICATIONS "$([ "${n_rep:-0}" -ge 1 ] && echo "PASS (replications=$n_rep)" || echo "FAIL (replications=0)")"

  mark "BASE-3 : sauvegardes normales successives (rotation primaire→bak)"
  do_save "$A"; sleep 1
  do_save "$A"; sleep 1
  pull_files "$A" "base"; disk_state "base"
  local AP AB APb ABb
  AP=$(verr "base" primary sha); AB=$(verr "base" bak sha); APb=$(verr "base" primary bytes); ABb=$(verr "base" bak bytes)
  [ "$APb" -gt 0 ] 2>/dev/null && [ "$ABb" -gt 0 ] 2>/dev/null \
    && verdict BASE_ROTATION "PASS (primaire=$APb bytes, bak=$ABb bytes — 2 versions valides)" \
    || verdict BASE_ROTATION "FAIL (primaire=$APb bak=$ABb)"
  scenario_end
}

# ---------------------------------------------------------------- delete

do_delete() {
  SID=$(get_sid) PIN=$(get_pin)
  [ -n "$SID" ] || { echo "FATAL: MODE=setup d'abord"; exit 1; }
  scenario_begin "DELETE-J16P0"
  mark "DELETE : suppression volontaire de la session de TEST"
  ev "$A" "(function(){return MultiCamSessionStore.remove('$SID').then(function(){return 'REMOVED';});})()" | tail -1 | sed 's/^/    /'
  sleep 1
  pull_files "$A" "delete-after"; disk_state "delete-after"
  local PP PB PT2
  PP=$(verr 'delete-after' primary bytes); PB=$(verr 'delete-after' bak bytes); PT2=$(verr 'delete-after' tmp bytes)
  if [ "$PP" -eq 0 ] 2>/dev/null; then verdict DELETE_FILES_GONE 'PASS (primaire retiré)'; else verdict DELETE_FILES_GONE "FAIL (primaire encore présent)"; fi
  if [ "$PB" -eq 0 ] 2>/dev/null && [ "$PT2" -eq 0 ] 2>/dev/null; then verdict DELETE_BAK_TMP_GONE 'PASS (bak+tmp retirés)'; else verdict DELETE_BAK_TMP_GONE "FAIL (bak=$PB tmp=$PT2)"; fi

  mark "DELETE : sauvegarde retardée (tombstone) sur la session supprimée"
  local LATE
  LATE=$(ev "$A" "(function(){window.MultiCamSessionStoreDebug={enabled:true,stage:'before_tmp',delayMs:1500};
    return MultiCamSessionStore.get('$SID').then(function(s){if(!s)return 'ALREADY_GONE';
    s.updatedAtMs=Date.now();return MultiCamSessionStore.save(s).then(function(){return 'SAVE_DONE';},function(e){return 'SAVE_ERR '+e;});});})()" | tail -1 | sed 's/^"//; s/"$//')
  echo "  late=$LATE"
  sleep 4
  pull_files "$A" "delete-late"; disk_state "delete-late"
  local DL
  DL=$(verr 'delete-late' primary bytes)
  if [ "$DL" -eq 0 ] 2>/dev/null; then verdict DELETE_LATE_SAVE_NOREC 'PASS (aucun fichier recréé)'; else verdict DELETE_LATE_SAVE_NOREC "FAIL (fichier recréé)"; fi
  verdict DELETE_STORE_AFTER_REBOOT "$(evs "$A" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'PRESENT':'ABSENT';})()")"

  mark "DELETE : redémarrage → aucune résurrection"
  relaunch "$A"
  sleep 3
  local pres; pres=$(evs "$A" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$SID';})?'PRESENT':'ABSENT';})()")
  echo "  store après redémarrage : $pres"
  pull_files "$A" "delete-reboot"; disk_state "delete-reboot"
  verdict DELETE_SESSION_AFTER_REBOOT "$pres"
  [ "$pres" = "ABSENT" ] && [ "$(verr 'delete-reboot' primary bytes)" -eq 0 ] \
    && verdict DELETE_NO_RESURRECTION "PASS" || verdict DELETE_NO_RESURRECTION "FAIL"
  shot "$A" "DELETE-A-home"
  scenario_end
}

# ---------------------------------------------------------------- status

do_status() {
  SID=$(get_sid); echo "session=${SID:-NONE}"
  for s in $DEVS; do echo "== $s pid=$(ADB -s "$s" shell pidof "$APP" | tr -d '\r')"; done
  [ -n "$SID" ] && { pull_files "$A" "status"; disk_state "status"; }
}

MODE="${MODE:-status}"
case "$MODE" in
  setup)  do_setup ;;
  base)   do_base ;;
  p1|p2|p3|p4|p5|p6|p7) do_phase "$MODE" ;;
  delete) do_delete ;;
  all)    do_setup; do_base; for k in 1 2 3 4 5 6 7; do do_phase "p$k"; done; do_delete ;;
  status) do_status ;;
  *) echo "MODE inconnu: $MODE (setup|base|p1..p7|delete|all|status)"; exit 2 ;;
esac
