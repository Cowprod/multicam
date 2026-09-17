#!/bin/sh
# MultiCam — librairie commune aux scripts e2e (exigence infra J01).
# Enumere les devices a partir de `adb devices`, ignore proprement les devices
# offline/unauthorized et les signale dans le rapport (regle du plan de dev).

# serial des devices autorises (un par ligne)
authorized_serials() {
  adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}'
}

# rapport des devices ignores (offline / unauthorized / autre)
skipped_report() {
  adb devices 2>/dev/null | awk 'NR>1 && $2!="device" && $1!="" {print "[SKIPPED] " $1 " state=" $2}'
}

require_adb() {
  if ! command -v adb >/dev/null 2>&1; then
    echo "ERREUR: adb introuvable dans le PATH" >&2
    exit 1
  fi
}