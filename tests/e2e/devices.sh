#!/bin/sh
set -eu
# MultiCam — devices.sh
# Affiche tous les devices Android autorises (serial, manufacturer, model, Android, SDK).
# Usage: devices.sh [fichier_sortie]
. "$(dirname "$0")/lib/common.sh"
require_adb

OUT="${1:-}"

report() {  # $1 = signature (fichier ou vide)
  echo "# MultiCam — devices adb"
  echo "# date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for s in $(authorized_serials); do
    line="$s state=device"
    for prop in ro.product.manufacturer ro.product.model ro.build.version.release ro.build.version.sdk; do
      v=$(adb -s "$s" shell getprop "$prop" 2>/dev/null | tr -d '\r')
      line="$line $prop=$v"
    done
    echo "$line"
  done
  echo "# --- devices ignores (offline/unauthorized) ---"
  skipped_report
}

if [ -n "$OUT" ]; then
  report | tee "$OUT"
else
  report
fi