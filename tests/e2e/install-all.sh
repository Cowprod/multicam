#!/bin/sh
set -eu
# MultiCam — install-all.sh
# Installe l'APK fourni sur tous les devices autorises.
# Usage: install-all.sh <chemin.apk>
APK="${1:-}"
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "Usage: install-all.sh <chemin.apk>" >&2
  exit 2
fi
. "$(dirname "$0")/lib/common.sh"
require_adb

rc=0
for s in $(authorized_serials); do
  log="/tmp/multicam-install-$s.log"
  if adb -s "$s" install -r "$APK" >"$log" 2>&1; then
    echo "[INSTALL] $s OK (adb install)"
    continue
  fi
  # Fallback : certaines ROM (Xiaomi/HyperOS) bloquent `adb install`
  # alors que `pm install` depuis adb shell fonctionne.
  apk_remote="/data/local/tmp/multicam-install.apk"
  if adb -s "$s" push "$APK" "$apk_remote" >"$log" 2>&1 \
     && adb -s "$s" shell pm install -r "$apk_remote" >>"$log" 2>&1; then
    echo "[INSTALL] $s OK (push + pm install)"
  else
    echo "[INSTALL] $s FAIL"
    cat "$log"
    rc=1
  fi
done
skipped_report
exit $rc