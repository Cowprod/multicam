#!/bin/sh
set -eu
# MultiCam — menu-open-test.sh
# Test d'interaction explicite du menu hamburger sur chaque device autorise.
# Regle e2e : un element interactif n'est pas valide parce qu'il est present
# dans l'arbre d'accessibilite ; son etat ouvert doit etre exerce et verifie.
# Verifications :
#   1. demarrage force-stop puis lancement : menu FERME (items absents) ;
#   2. tap sur le bouton menu (aria-label "Menu") ;
#   3. menu OUVERT (conteneur + items "Historique" / "Paramètres" presents) ;
#   4. position geometrique : panneau ancre haut-droit sous le header (jamais en bas d'ecran) ;
#   5. captures d'ecran ferme + ouvert.
# Espace de coordonnees : celui de l'arbre UiAutomator (racine du dump), identique
# a celui de `input tap` (verifie empiriquement sur R9ZT40ALLSN et c0d8514d7d87).
# Usage: menu-open-test.sh [dossier_sortie]   (defaut: menu-open)
OUT="${1:-menu-open}"
. "$(dirname "$0")/lib/common.sh"
require_adb
mkdir -p "$OUT"

rc=0

for s in $(authorized_serials); do
  adb -s "$s" shell am force-stop fr.emmanuel.multicam
  sleep 1
  adb -s "$s" shell am start -n fr.emmanuel.multicam/.MainActivity >/dev/null 2>&1 || true
  sleep 4

  wait_dump() {  # $1 = marqueur attendu ("" = seulement un dump non vide)
    i=0
    while [ "$i" -lt 10 ]; do
      adb -s "$s" shell uiautomator dump /sdcard/menu.dump.xml >/dev/null 2>&1 || true
      d=$(adb -s "$s" shell cat /sdcard/menu.dump.xml 2>/dev/null)
      if [ -n "$d" ] && { [ -z "$1" ] || echo "$d" | grep -q "$1"; }; then
        echo "$d"
        return 0
      fi
      sleep 2
      i=$(( i + 1 ))
    done
    return 1
  }

  bounds_of() {  # $1 = ligne XML noeud ; imprime "x1 y1 x2 y2"
    echo "$1" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p'
  }

  d=$(wait_dump 'resource-id="menuButton"') || {
    echo "[MENUTEST] $s KO arbre UI indisponible (menuButton jamais expose)"
    rc=1
    continue
  }
  nodes=$(echo "$d" | tr '>' '\n')

  root=$(echo "$nodes" | grep -m1 'class="android.widget.FrameLayout"')
  r=$(bounds_of "$root")
  set -- $r
  W=${3:-0}; H=${4:-0}
  [ "$W" -gt 0 ] && [ "$H" -gt 0 ] || { echo "[MENUTEST] $s KO dimensions arbre"; rc=1; continue; }

  if echo "$nodes" | grep -q 'Historique"'; then
    echo "[MENUTEST] $s ECHEC: Historique deja visible a l'etat initial (menu attendu ferme apres force-stop)"
    rc=1
    continue
  fi

  # capture d'ecran etat FERME (verifie ci-dessus)
  adb -s "$s" exec-out screencap -p >"$OUT/$s-menu-closed.png" 2>/dev/null || true

  btn=$(echo "$nodes" | grep 'resource-id="menuButton"' | head -1)
  b=$(bounds_of "$btn")
  set -- $b
  bx1=${1:-}; by1=${2:-}; bx2=${3:-}; by2=${4:-}
  if [ "$#" -ne 4 ]; then
    echo "[MENUTEST] $s KO bounds bouton Menu invalides: '$b'"
    rc=1
    continue
  fi
  cx=$(( (bx1 + bx2) / 2 )); cy=$(( (by1 + by2) / 2 ))

  adb -s "$s" shell input tap "$cx" "$cy"
  sleep 2

  d=$(wait_dump 'resource-id="menu"') || {
    echo "[MENUTEST] $s ECHEC: menu non ouvert apres tap (conteneur menu jamais expose)"
    rc=1
    adb -s "$s" exec-out screencap -p >"$OUT/$s-menu-open.png" 2>/dev/null || true
    continue
  }
  nodes=$(echo "$d" | tr '>' '\n')

  mnode=$(echo "$nodes" | grep 'resource-id="menu"' | head -1)
  m=$(bounds_of "$mnode")
  set -- $m
  mx1=${1:-}; my1=${2:-}; mx2=${3:-}; my2=${4:-}

  hist=$(echo "$nodes" | grep 'resource-id="navHistory"' | head -1)
  prms=$(echo "$nodes" | grep 'resource-id="navSettings"' | head -1)

  if [ "$#" -ne 4 ] || [ -z "$hist" ] || [ -z "$prms" ]; then
    echo "[MENUTEST] $s ECHEC: menu ouvert incomplet (conteneur=$([ "$#" -eq 4 ] && echo ok || echo ko), Historique=$([ -n "$hist" ] && echo present || echo absent), Parametres=$([ -n "$prms" ] && echo present || echo absent))"
    rc=1
  else
    anchored_top=$([ "$my1" -le $(( H * 25 / 100 )) ] && echo 1 || echo 0)
    anchored_right=$([ "$mx2" -ge $(( W * 82 / 100 )) ] && echo 1 || echo 0)
    echo "[MENUTEST] $s OK menu ouvert conteneur=($mx1,$my1)->($mx2,$my2) WxH=${W}x${H} top=${anchored_top} right=${anchored_right}"
    if [ "$anchored_top" != 1 ] || [ "$anchored_right" != 1 ]; then
      echo "[MENUTEST] $s ECHEC: menu ouvert mais ancre hors zone header (top=$anchored_top right=$anchored_right)"
      rc=1
    fi
  fi

  # capture d'ecran etat OUVERT (verifie ci-dessus)
  adb -s "$s" exec-out screencap -p >"$OUT/$s-menu-open.png" 2>/dev/null || true
  [ -s "$OUT/$s-menu-open.png" ] || { echo "[MENUTEST] $s ECHEC capture menu ouvert"; rc=1; }
done

skipped_report
exit $rc