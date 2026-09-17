#!/bin/sh
set -eu
# MultiCam — screenshot-all.sh
# Capture un screenshot par device autorise. Exigence : adb exec-out screencap.
# Usage: screenshot-all.sh [dossier_sortie]   (defaut: screenshots)
OUT="${1:-screenshots}"
. "$(dirname "$0")/lib/common.sh"
require_adb
mkdir -p "$OUT"

rc=0
for s in $(authorized_serials); do
  target="$OUT/$s.png"
  if adb -s "$s" exec-out screencap -p >"$target" 2>/dev/null && [ -s "$target" ]; then
    echo "[SCREENSHOT] $s OK ($target, $(wc -c <"$target") octets)"
  else
    echo "[SCREENSHOT] $s FAIL"
    rc=1
  fi
done
skipped_report
exit $rc