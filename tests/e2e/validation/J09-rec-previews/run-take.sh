#!/bin/sh
# Rejeu complet J09-02 : ARM -> countdown -> REC -> STOP local, avec capture
# du logcat de la CAPTURE dans un seul fichier de preuve.
# Usage: ./run-take.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
M=61d54bba7d91                 # Capture (Cam 07)
MTR=R83Y106V1HF                # Master (tablette Cam D4)
A=fr.emmanuel.multicam
LOG="$HERE/logs/03-take-capture-full.log"

cd "$HERE"

echo "== 1. retour Master a l'ecran Take =="
SID=${SID:-RGR4M7AA}
CDP_PORT=9222 node cdp.js "MultiCamNav.show(\"take\", {sid: \"$SID\"}); document.querySelector(\".screen.active\").id"
sleep 2

echo "== 2. selection de toutes les Captures (uniquement si vide) =="
CDP_PORT=9222 node cdp.js 'var c=document.querySelector("#panel-take input[type=checkbox]"); if(c && !c.checked){var b=[...document.querySelectorAll("#panel-take button")].find(x=>x.textContent.trim()==="Toutes"); if(b) b.click();} "captureChk="+(c?c.checked:null) + " armDis=" + document.getElementById("tkArm").disabled'
sleep 1

echo "== 3. ARM =="
CDP_PORT=9222 node cdp.js 'document.getElementById("tkArm").click(); "armed"'
sleep 4

echo "== 4. lever l'incident d'armement eventuel =="
CDP_PORT=9222 node cdp.js 'var c=document.getElementById("armIncidentContinue"); if(document.getElementById("armIncidentModal").classList.contains("show") && c) c.click(); "incident-ok"'
sleep 2

echo "== 5. REC (Master) — depart du log de la Capture =="
adb -s "$M" logcat -c
CDP_PORT=9222 node cdp.js 'document.getElementById("armRec").click(); "rec"'

sleep 8
echo "== 6. etat Capture pendant REC =="
CDP_PORT=9223 node cdp.js 'JSON.stringify({scr:document.querySelector(".screen.active").id, cam:MultiCamCameraRecord.view(), pv:MultiCamPreviewService.view()})'
adb -s "$M" exec-out screencap -p > "$HERE/screenshots/04-capture-rec.png"

echo "== 7. STOP local sur la Capture =="
CDP_PORT=9223 node cdp.js 'document.getElementById("cdEmergency").click(); "stop-dialog"'
sleep 2
adb -s "$M" exec-out screencap -p > "$HERE/screenshots/05a-capture-stop-confirm.png"
CDP_PORT=9223 node cdp.js 'document.getElementById("cdStopConfirm").click(); "stopped"'
sleep 5

echo "== 8. etat Capture apres STOP =="
CDP_PORT=9223 node cdp.js 'JSON.stringify({scr:document.querySelector(".screen.active").id, cam:MultiCamCameraRecord.view(), pv:MultiCamPreviewService.view()})'
adb -s "$M" exec-out screencap -p > "$HERE/screenshots/05b-capture-after-stop.png"

echo "== 9. sauvegarde du log =="
adb -s "$M" logcat -d -v time 2>/dev/null | grep -E "CONSOLE" > "$LOG" || true
echo "log -> $LOG ($(wc -l < "$LOG") lignes)"
echo "CAMERA_PREVIEW_STOP dans le log : $(grep -c 'CAMERA_PREVIEW_STOP' "$LOG" || true)"
echo "CAMERA_PREP_  dans le log       : $(grep -c 'CAMERA_PREP_' "$LOG" || true)"
