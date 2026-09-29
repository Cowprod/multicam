#!/bin/sh
# Pilotage UI WebView (J09) — aucune dependance.
# Usage: ui.sh DEVICE dump | tap-id ID | tap-text TEXTE | tap-x-y X Y | screens
set -eu
D="$1"; shift
CMD="$1"; shift || true
XML=/sdcard/mc-ui.xml

dump() { adb -s "$D" shell uiautomator dump "$XML" >/dev/null 2>&1; adb -s "$D" shell cat "$XML" 2>/dev/null; }

case "$CMD" in
  dump) dump | tr '>' '\n' | grep -oE 'text="[^"]*"|resource-id="[^"]*"|bounds="[^"]*"' ;;
  screens) dump | tr '>' '\n' | grep -oE 'resource-id="panel-[a-z]+"' | sort -u ;;
  tap-id)
    B=$(dump | tr '>' '\n' | grep "resource-id=\"$1\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
    [ -n "$B" ] || { echo "NOT_FOUND id=$1" >&2; exit 3; }
    X0=$(echo "$B" | sed -E 's/.*\[([0-9]+),.*/\1/'); Y0=$(echo "$B" | sed -E 's/.*,([0-9]+)\]\[.*/\1/')
    X1=$(echo "$B" | sed -E 's/.*\]\[([0-9]+),.*/\1/'); Y1=$(echo "$B" | sed -E 's/.*,([0-9]+)\]"/\1/')
    X=$(( (X0 + X1) / 2 )); Y=$(( (Y0 + Y1) / 2 ))
    echo "TAP id=$1 ($X,$Y)"
    adb -s "$D" shell input tap "$X" "$Y" ;;
  tap-text)
    B=$(dump | tr '>' '\n' | grep 'text="' | grep -F "$1" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
    [ -n "$B" ] || { echo "NOT_FOUND text=$1" >&2; exit 3; }
    X0=$(echo "$B" | sed -E 's/.*\[([0-9]+),.*/\1/'); Y0=$(echo "$B" | sed -E 's/.*,([0-9]+)\]\[.*/\1/')
    X1=$(echo "$B" | sed -E 's/.*\]\[([0-9]+),.*/\1/'); Y1=$(echo "$B" | sed -E 's/.*,([0-9]+)\]"/\1/')
    X=$(( (X0 + X1) / 2 )); Y=$(( (Y0 + Y1) / 2 ))
    echo "TAP text=$1 ($X,$Y)"
    adb -s "$D" shell input tap "$X" "$Y" ;;
  tap-x-y) echo "TAP raw ($1,$2)"; adb -s "$D" shell input tap "$1" "$2" ;;
  *) echo "usage: ui.sh DEVICE dump|screens|tap-id ID|tap-text TXT|tap-x-y X Y" >&2; exit 2 ;;
esac
