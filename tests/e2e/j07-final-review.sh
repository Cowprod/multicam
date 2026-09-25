#!/usr/bin/env bash
# MultiCam — mini-validation physical ciblée D1 + D4 après correctif revue
# humaine J07 :
#   1. modal Ajouter un device affiche « Cam D4 » (plus jamais l'UUID) — J05 ;
#   2. modal D4 Capture + Storage sélectionnés (aucune régression sélection) ;
#   3. convergence terminale ARM entre Masters égaux : D4 Capture = WARNING
#      vu de D1 ET vu de D4 (plus jamais WARNING/ARMING) ;
#   4. détails sincères : « Autorisation à demander » (NOT_REQUESTED), sync
#      distante mesurée (D1) vs « Référence locale » (D4) ;
#   5. Capture WARNING → recEligible = true (REC dock).
#
# AUCUN pm clear : préserve deviceId/noms (Cam D1 / Cam D4).
# Session propre D1+D4 (2 Masters égaux), Take D4 Capture sélectionnée.
# Preuves visuelles ciblées sous J07-arm-sync/final-review/.
#
# Usage : tests/e2e/j07-final-review.sh
set -u
set +B

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/tests/e2e/validation/J07-arm-sync/final-review"
CDP="$HERE/lib/cdp.js"

D1=61cc29567d91
D4=R83Y106V1HF
SNAME="Final Review D1D4"
APP=fr.emmanuel.multicam

mkdir -p "$OUT/screenshots" "$OUT/logs" "$OUT/dumps"

ev()  { node "$CDP" "$1" eval "$2"; }
shot(){ adb -s "$1" exec-out screencap -p > "$OUT/screenshots/$2.png"; echo "shot $2"; }
logs(){ adb -s "$1" logcat -d -v time 2>/dev/null | grep -E "SESSION|WS_|MEMBER|SCREEN0|SCREEN1|HOME_RENDER|APP_BOOT|NSD_|MDNS_|TAKE_|TELEMETRY_|ARM_|CLOCK_|REC_ELIG" > "$OUT/logs/$1-$2.log"; echo "logs $1-$2 (lines=$(wc -l < "$OUT/logs/$1-$2.log"))"; }
dump(){ node "$CDP" "$1" eval "$2" > "$OUT/dumps/$3"; echo "dump $3"; }
arm_view(){ node "$CDP" "$1" eval "(function(){return JSON.stringify(MultiCamArmService.view());})()" > "$OUT/dumps/arm-view-$1.json"; }
mark(){ echo; echo "############ $1 ############"; }

json_field() {
  node -e "const fs=require('fs');let v=fs.readFileSync('$1','utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}};const out=$2;console.log(out===undefined?'':out);"
}

panels_ok() {
  local s="$1" label="$2"
  local n=$(ev "$s" "(function(){var a=document.querySelectorAll('.screen.active');return a.length+'|'+(a[0]?a[0].id:'');})()")
  n="${n//\"/}"; n="${n//\\/}"
  case "$n" in
    1\|*) echo "PANELS_OK $label active=$(echo "$n" | cut -d'|' -f2)" ;;
    *) echo "PANELS_FAIL $label got=$n" ;;
  esac
}

set_pin() {
  local s="$1" p="$2"
  ev "$s" "(function(p){for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;var n=document.createEvent('Event');n.initEvent('input',true,true);b.value=p[i];b.dispatchEvent(n);}return 'PIN_SET_'+p;})('$p')"
}

wait_session_on() {
  local s="$1" sid="$2" label="$3" poll=0
  while [ "$poll" -lt 60 ]; do
    local has=$(ev "$s" "(async function(){var l=await MultiCamSessionStore.list();return l.some(function(x){return x.sessionId==='$sid';})?'yes':'no';})()")
    has="${has//\"/}"
    if [ "$has" = "yes" ]; then echo "SESSION_JOINED $label (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SESSION_JOINED $label TIMEOUT"; return 1
}

# Attendre l'état REQUIS de (device, skill) sur un Master donné.
wait_skill_is() {
  local s="$1" did="$2" skill="$3" want="$4" label="$5" poll=0
  while [ "$poll" -lt 60 ]; do
    local st=$(ev "$s" "(function(){var v=MultiCamArmService.view();var d=(v.devices||[]).filter(function(x){return x.did==='$did';})[0];if(!d)return 'none';var sk=(d.skills||[]).filter(function(x){return x.skill==='$skill';})[0];return sk?sk.status:'noskill';})()")
    st="${st//\"/}"
    if [ "$st" = "$want" ]; then echo "SKILL_OK $label did=$did skill=$skill = $want (t=${poll}s)"; return 0; fi
    sleep 5; poll=$(( poll + 5 ))
  done
  echo "SKILL_TIMEOUT $label did=$did skill=$skill want=$want got=$st"; return 1
}

mark "0 — préconditions : D1+D4 up, identités préservées (aucun pm clear)"
for s in "$D1" "$D4"; do adb -s "$s" logcat -c 2>/dev/null; done
ev "$D1" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"
ev "$D4" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"

mark "1 — création de session sur D1 (hôte Master)"
ev "$D1" "MultiCamNav.show('create'); (function(){document.getElementById('sessionName').value='$SNAME';document.getElementById('createButton').click();return 1;})()" >/dev/null
sleep 6
dump "$D1" "(async function(){var l=await MultiCamSessionStore.list();var s=l.filter(function(x){return x.state!=='closed';}).sort(function(a,b){return (b.updatedAtMs||0)-(a.updatedAtMs||0)})[0]||l[0];return JSON.stringify({found:!!s,sid:s?s.sessionId:'',name:s?s.name:'',state:s?s.state:'',pin:s?s.pin:''});})()" "1-D1-created.json"
read -r SID PIN <<< "$(json_field "$OUT/dumps/1-D1-created.json" "v.sid+' '+v.pin")"
echo "SESSION_CREATED sid=$SID pin=$PIN"

mark "2 — D4 rejoint comme Master (maille D1+D4, 2 Masters égaux)"
sleep 3
dump "$D4" "JSON.stringify({devId:MultiCamSessionWs.status().localDid})" "2-D4-did.json"
read -r DID4 <<< "$(json_field "$OUT/dumps/2-D4-did.json" "v.devId")"
dump "$D4" "JSON.stringify({lan:MultiCamSessionDiscovery.list()})" "2-D4-lan.json"
read -r JHOST JPORT <<< "$(json_field "$OUT/dumps/2-D4-lan.json" "(function(){var s=(v.lan||[]).filter(function(x){return x.sessionId==='$SID';})[0];var ann=((s&&s.announcers)||[]);var a=ann[ann.length-1]||{host:'',port:0};return (a.host||'')+' '+(a.port||0);})()")"
echo "JOIN_TARGET D4 sid=$SID host=$JHOST port=$JPORT"
ev "$D4" "(function(){MultiCamNav.show('join',{mode:'join',sid:'$SID',name:'$SNAME',host:'$JHOST',port:'$JPORT'});for(var i=0;i<4;i++){var b=document.getElementById('pin'+i);if(!b)continue;b.value='$PIN'.charAt(i);b.dispatchEvent(new Event('input',{bubbles:true}));}return 'NAV_AND_PIN_D4';})()" > "$OUT/dumps/2-D4-join.txt"
wait_session_on "$D4" "$SID" "D4"
sleep 3
panels_ok "$D1" "D1"; panels_ok "$D4" "D4"

mark "3 — J05 fix : modal Ajouter affiche « Cam D4 » (plus jamais l'UUID)"
DID1=$(ev "$D1" "MultiCamSessionWs.status().localDid"); DID1="${DID1//\"/}"
echo "DID1=$DID1 DID4=$DID4"
ev "$D1" "MultiCamNav.show('session',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
# D4 est un peer découvert (nom « Cam D4 »), non membre → clic Ajouter → modal.
ev "$D1" "(function(){var b=document.querySelector('.member-add[data-device=\\\"$DID4\\\"]');if(!b)return 'NO_ADD_BTN';b.click();return 'CLICK_ADD_D4';})()" > "$OUT/dumps/3-D1-add-click.txt"
sleep 2
dump "$D1" "(function(){var m=document.getElementById('memberModal');return JSON.stringify({open:m.classList.contains('show'),title:document.getElementById('mmTitle').textContent,name:document.getElementById('mmDeviceName').textContent,proposed:(function(){var c=[];document.querySelectorAll('#mmRoles input[type=checkbox]').forEach(function(i){c.push(i.getAttribute('data-role'));});return c;})()});})()" "3-D1-modal-d4.json"
cat "$OUT/dumps/3-D1-modal-d4.json"; echo
name=$(json_field "$OUT/dumps/3-D1-modal-d4.json" "v.name")
case "$name" in
  "Cam D4") echo "MODAL_NAME_OK nom humain = $name" ;;
  *) echo "MODAL_NAME_FAIL nom=$name (UUID attendu de N'être plus)" ;;
esac
shot "$D1" "FR-01-modal-noCam-D4"

mark "4 — modal D4 : Capture + Storage sélectionnés, enregistrement (sans régression rôles)"
ev "$D1" "(function(){var roles=['capture','storage'];var els=document.querySelectorAll('#mmRoles input[type=checkbox]');els.forEach(function(i){var r=i.getAttribute('data-role');i.checked=roles.indexOf(r)>=0;});return 'ROLES_SELECTED';})()" >/dev/null
sleep 1
dump "$D1" "(function(){var c=[];document.querySelectorAll('#mmRoles input[type=checkbox]:checked').forEach(function(i){c.push(i.getAttribute('data-role'));});return JSON.stringify({selected:c,saveDisabled:document.getElementById('mmSave').disabled});})()" "4-D1-modal-roles.json"
cat "$OUT/dumps/4-D1-modal-roles.json"; echo
shot "$D1" "FR-02-modal-noCam-D4-roles"
ev "$D1" "document.getElementById('mmSave').click(); 'SAVE'" >/dev/null
sleep 4
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');var m=(s.members||[]).filter(function(x){return x.deviceId==='$DID4';})[0];return JSON.stringify({added:!!m,name:m&&m.deviceName,deviceNameIsUuid:m&&/^[0-9a-f]{8}-/.test(m.deviceName),roles:m&&m.sessionRoles});})()" "4-D1-d4-member.json"
cat "$OUT/dumps/4-D1-d4-member.json"; echo
member=$(json_field "$OUT/dumps/4-D1-d4-member.json" "JSON.stringify(v)")
case "$member" in
  *'"name":"Cam D4"'*'"deviceNameIsUuid":false'*) echo "MEMBER_NAME_OK Cam D4 persisté, AUCUN UUID" ;;
  *) echo "MEMBER_NAME_FAIL $member" ;;
esac

mark "5 — Take : D4 Capture sélectionnée (D1+D4 membres, storage conservé)"
ev "$D1" "MultiCamNav.show('take',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 4
ev "$D1" "document.getElementById('tkCaptureAll').click();'CAP'" >/dev/null
ev "$D1" "document.getElementById('tkStorageAll').click();'STO'" >/dev/null
sleep 4
dump "$D1" "(async function(){var s=await MultiCamSessionStore.get('$SID');var t=(s.takes||[])[(s.takes||[]).length-1];return JSON.stringify({take:t.takeNumber,captures:t.captures,storages:t.storages,settings:t.settings});})()" "5-D1-take.json"
cat "$OUT/dumps/5-D1-take.json"; echo
echo "D4_CAPTURE_SELECTED=$(json_field "$OUT/dumps/5-D1-take.json" "(v.captures||[]).indexOf('$DID4')>=0")"

mark "6 — ARM sur D1 : D4 Capture doit converger en WARNING côté requester"
ev "$D1" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 2
panels_ok "$D1" "arm"
wait_skill_is "$D1" "$DID4" "capture" "WARNING" "D1-view-of-D4"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')}),clock:v.clock});})()" "6-D1-arm-d4-warning.json"
cat "$OUT/dumps/6-D1-arm-d4-warning.json"; echo
shot "$D1" "FR-03-d1-arm-warning-d4"

mark "7 — détail D4 vue de D1 : vraie sync distante mesurée"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return b?1:0;})()" >/dev/null; sleep 1
dump "$D1" "(function(){var v=MultiCamArmService.view();var d=(v.devices||[]).filter(function(x){return x.did==='$DID4';})[0];var sk=(d.skills||[]).filter(function(x){return x.skill==='capture';})[0];return JSON.stringify({status:sk.status,checks:sk.checks});})()" "7-D1-d4-detail.json"
cat "$OUT/dumps/7-D1-d4-detail.json"; echo
shot "$D1" "FR-04-d1-detail-d4-sync"
ev "$D1" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1

mark "8 — ARM sur D4 (2e Master) : sa propre Capture doit converger en WARNING (plus jamais ARMING)"
ev "$D4" "MultiCamNav.show('arm',{sid:'$SID'}); 'NAV'" >/dev/null
sleep 3
wait_skill_is "$D4" "$DID4" "capture" "WARNING" "D4-self"
dump "$D4" "(function(){var v=MultiCamArmService.view();return JSON.stringify({armCycleId:v.armCycleId,recEligible:v.recEligible,devices:(v.devices||[]).map(function(d){return d.deviceName+':'+d.skills.map(function(x){return x.skill+'='+x.status}).join(',')}),clock:v.clock});})()" "8-D4-arm-self-warning.json"
cat "$OUT/dumps/8-D4-arm-self-warning.json"; echo
shot "$D4" "FR-05-d4-arm-self-warning"

mark "9 — détail D4 vue de D4 : Autorisation à demander + Référence locale + WARNING"
ev "$D4" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return b?1:0;})()" >/dev/null; sleep 1
dump "$D4" "(function(){var v=MultiCamArmService.view();var d=(v.devices||[]).filter(function(x){return x.did==='$DID4';})[0];var sk=(d.skills||[]).filter(function(x){return x.skill==='capture';})[0];return JSON.stringify({status:sk.status,checks:sk.checks});})()" "9-D4-detail-self.json"
cat "$OUT/dumps/9-D4-detail-self.json"; echo
shot "$D4" "FR-06-d4-detail-self"
ev "$D4" "(function(){var b=document.querySelector('.skill-state[data-device=\\\"$DID4\\\"][data-skill=capture]');if(b)b.click();return 1;})()" >/dev/null; sleep 1

mark "10 — convergence Masters égaux D1/D4 sur le MÊME device/skill"
node -e "
const fs=require('fs');
const ld=(p)=>{let v=fs.readFileSync(p,'utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}}return v;};
const a=ld('$OUT/dumps/6-D1-arm-d4-warning.json');
const b=ld('$OUT/dumps/8-D4-arm-self-warning.json');
const st=(v)=>{const row=(v.devices||[])[0]||'none';const m=/capture=([A-Z]+)/.exec(row);return m?m[1]:'none';};
console.log('D4_status_vu_de_D1='+st(a)+' D4_status_vu_de_D4='+st(b));
console.log('armCycleId_D1='+a.armCycleId+' armCycleId_D4='+b.armCycleId);
console.log('CONVERGENCE='+(st(a)==='WARNING'&&st(b)==='WARNING'?'OK':'FAIL'));
console.log('recEligible_D1='+a.recEligible+' recEligible_D4='+b.recEligible);
process.exit(st(a)==='WARNING'&&st(b)==='WARNING'?0:1);
" || echo "CONVERGENCE_FAIL"

mark "11 — REC dock : recEligible (Capture startable)"
dump "$D1" "(function(){var v=MultiCamArmService.view();return JSON.stringify({recEligible:v.recEligible,dockShown:!document.getElementById('armRecDock').classList.contains('d-none')});})()" "11-D1-rec-dock.json"
cat "$OUT/dumps/11-D1-rec-dock.json"; echo
shot "$D1" "FR-07-rec-dock-eligible"
logs "$D1" "arm"; logs "$D4" "arm"

mark "12 — preuves honnêtes : permission NOT_REQUESTED affichée, pas d'erreur"
node -e "
const fs=require('fs');
const ld=(p)=>{let v=fs.readFileSync(p,'utf8').trim();try{v=JSON.parse(v)}catch(e){};if(typeof v==='string'){try{v=JSON.parse(v)}catch(e){}}return v;};
const a=ld('$OUT/dumps/9-D4-detail-self.json');
const perm=(a.checks||[]).filter(c=>c.key==='permissions')[0]||{};
const sync=(a.checks||[]).filter(c=>c.key==='sync')[0]||{};
console.log('D4_perm='+perm.status+' msg='+perm.message);
console.log('D4_sync='+sync.status+' msg='+sync.message);
console.log('HONNETE='+((perm.message||'').indexOf('Autorisation à demander')>=0 && sync.message==='Référence locale' ? 'OK':'FAIL'));
process.exit((perm.message||'').indexOf('Autorisation à demander')>=0&&sync.message==='Référence locale'?0:1);
" || echo "HONNETE_FAIL"

mark "13 — fermeture propre de la session"
ev "$D1" "MultiCamSessionStore.list().then(function(l){var o=l.filter(function(s){return s.state==='open';});return Promise.all(o.map(function(s){return MultiCamSessionWs.closeSession(s).then(function(c){return c.sessionId+':'+c.state;});}));}).then(function(r){return JSON.stringify(r);})"
sleep 3
echo -n "D1: "; ev "$D1" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"
echo -n "D4: "; ev "$D4" "JSON.stringify({name:MultiCamConfig.get().deviceName,id:MultiCamConfig.get().deviceId})"
panels_ok "$D1" "fin"

echo "############ TERMINÉ (final review D1+D4) ############"
ls -1 "$OUT/screenshots" | wc -l | xargs echo "PNG_TOTAL="
cd "$OUT/screenshots" || exit 1
shasum -a 256 *.png | tee "$OUT/png-shas.txt" >/dev/null