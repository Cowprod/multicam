#!/bin/sh
set -eu
# MultiCam — logs-all.sh
# Recupere le logcat complet de chaque device autorise. Exigence : adb logcat -d.
# Usage: logs-all.sh [dossier_sortie]   (defaut: logs)
OUT="${1:-logs}"
. "$(dirname "$0")/lib/common.sh"
require_adb
mkdir -p "$OUT"

rc=0
for s in $(authorized_serials); do
  target="$OUT/$s-logcat.txt"
  if adb -s "$s" logcat -d >"$target" 2>/dev/null && [ -s "$target" ]; then
    echo "[LOG] $s OK ($target, $(wc -l <"$target") lignes)"
  else
    echo "[LOG] $s FAIL"
    rc=1
  fi
done
skipped_report
exit $rc