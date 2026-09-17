#!/bin/sh
set -eu
# MultiCam — collect-files.sh
# Copie des fichiers hote (APK, versions, checks) vers un dossier de preuve
# et produit un sha256 pour chaque fichier.
# Usage: collect-files.sh <dossier_sortie> <fichier> [fichier...]
OUT="${1:-artifacts}"
shift || true
if [ "$#" -eq 0 ]; then
  echo "Usage: collect-files.sh <dossier_sortie> <fichier> [fichier...]" >&2
  exit 2
fi
mkdir -p "$OUT"

rc=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "[COLLECT] $f introuvable"
    rc=1
    continue
  fi
  base="$(basename "$f")"
  cp "$f" "$OUT/$base"
  shasum -a 256 "$f" | awk '{print $1"  "$2}' >"$OUT/$base.sha256"
  echo "[COLLECT] $f -> $OUT/$base ($(shasum -a 256 "$f" | awk '{print $1}'))"
done
exit $rc