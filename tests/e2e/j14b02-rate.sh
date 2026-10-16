#!/usr/bin/env bash
# MultiCam — J14-B02 : mesure de débit d'événements sur une session EXISTANTE.
# Réutilise la session courante (aucun setup) pour comparer AVANT/APRÈS correctif
# à topologie identique : injecte le même pilote de Take, puis compte via logcat.
# Usage : j14b02-rate.sh <label>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CDP="$HERE/lib/cdp.js"
A=61cc29567d91; B=61d54bba7d91; C=c0d8514d7d87; DTCP=192.168.92.103:5555
DEVS="$A $B $C $DTCP"
LABEL="${1:-rate}"
SID="$(cat "$HERE/validation/J14-B02/measure-after/dumps/sid.txt" 2>/dev/null)"
OUT="$HERE/validation/J14-B02/measure-$LABEL"; mkdir -p "$OUT/dumps" "$OUT/logs"
[ -z "$SID" ] && { echo "FATAL: SID introuvable"; exit 1; }
ev() { (env CDP_TIMEOUT_MS=90000 node "$CDP" "$1" eval "$2" > /tmp/rate-ev.txt 2>&1 &); sleep 12; cat /tmp/rate-ev.txt; }
clear_logs() { for s in $DEVS; do adb -s "$s" logcat -c >/dev/null 2>&1; done; }
EVPAT='SESSION_ADVERTISE_SKIP|SESSION_ADVERTISE |SESSION_ADVERTISE_ERROR|RE_SYNC_THROTTLED|SYNC_BROADCAST|TARGETED_BROADCAST|TAKE_CHANGED|TAKE_RECEIVED|MEMBER_TELEMETRY|TRANSFER_PROGRESS'
cap() { local tag="$1"; echo "device SKIP RS SYNC TGT TAKE_CHG TAKE_RCV MT TRANSFER_PROG" > "$OUT/dumps/counts-$tag.txt"
  for s in $DEVS; do local f="$OUT/logs/${s//[:\/]/_}-$tag.log"; adb -s "$s" logcat -d -v time 2>/dev/null | grep -E "$EVPAT" > "$f"
    echo "$s $(grep -c SESSION_ADVERTISE_SKIP "$f") $(grep -c RE_SYNC_THROTTLED "$f") $(grep -c SYNC_BROADCAST "$f") $(grep -c TARGETED_BROADCAST "$f") $(grep -c TAKE_CHANGED "$f") $(grep -c TAKE_RECEIVED "$f") $(grep -c MEMBER_TELEMETRY "$f") $(grep -c TRANSFER_PROGRESS "$f")" >> "$OUT/dumps/counts-$tag.txt"; done }

DRIVER="(function(){window.__r=(async function(){const sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};const log=function(m){console.log('RATE '+m);};try{var s=await MultiCamSessionStore.get('$SID');var r=await MultiCamSessionWs.newTake(s);log('newtake tn='+r.takeNumber);await sleep(2500);MultiCamNav.show('take',{sid:'$SID'});await sleep(3500);var ca=document.getElementById('tkCaptureAll');if(ca)ca.click();var sa=document.getElementById('tkStorageAll');if(sa)sa.click();await sleep(6000);var s2=await MultiCamSessionStore.get('$SID');var t=(s2.takes||[])[(s2.takes||[]).length-1];log('participants ncap='+(t?t.captures.length:-1)+' nsto='+(t?t.storages.length:-1));MultiCamNav.show('arm',{sid:'$SID'});await sleep(18000);var b=document.getElementById('armRec');log('armrec disabled='+(b?b.disabled:'na'));if(b&&!b.disabled)b.click();await sleep(4000);var e=document.getElementById('armIncidentContinue');if(e&&!e.classList.contains('d-none'))e.click();await sleep(30000);MultiCamStartService.requestStop('RATE');log('stop');await sleep(6000);log('phase='+MultiCamStartService.view().phase);log('DONE');}catch(err){log('ERROR '+err);}})();return 'DRIVER_STARTED';})()"

echo "== $LABEL : sid=$SID =="
clear_logs
echo -n "inject="; ev "$A" "$DRIVER" | tail -1
poll=0; while [ "$poll" -lt 200 ]; do adb -s "$A" logcat -d 2>/dev/null | grep -q 'RATE DONE' && break; sleep 5; poll=$((poll+5)); done
sleep 5
adb -s "$A" logcat -d 2>/dev/null | grep -E 'RATE ' | sed -E 's/.*RATE /RATE /; s/", source.*//' | tee "$OUT/dumps/markers.txt"
cap "take"; echo "--- take ---"; cat "$OUT/dumps/counts-take.txt"
clear_logs; echo "postrep 120s…"; sleep 120; cap "postrep"; echo "--- postrep ---"; cat "$OUT/dumps/counts-postrep.txt"
echo "== $LABEL DONE =="
