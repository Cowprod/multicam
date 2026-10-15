#!/bin/sh
# MultiCam — controle de packaging D-SERVE (pre-build, reproductible).
#
# Garantit qu'un APK construit depuis cette arborescence embarque REELLEMENT le
# routeur HTTP multi-Take (D-SERVE) et non une copie perimee du plugin
# cordova-plugin-multicam-httpd.
#
# Pourquoi ce controle : `cordova prepare` NE rafraichit PAS un plugin deja
# present dans plugins/ (cordova-lib/src/cordova/restore-util.js : "Plugin
# already exists"). Une modification de local-plugins/ reste donc invisible au
# build tant que le plugin n'est pas re-installe (plugin rm + plugin add).
#
# Verifie, pour cordova-plugin-multicam-httpd :
#   1. presence de TakeRouterImpl cote Java (source ET copies compilees) ;
#   2. presence de registerTake/unregisterTake dans le pont Cordova JS ;
#   3. coherence OCTET A OCTET local-plugins/ <-> plugins/ <-> platforms/.
#
# Sortie : code 1 des qu'une copie est absente ou perimee, avec la raison.
#
# Usage : scripts/check-dserve-packaging.sh [APP_DIR]
#   APP_DIR par defaut = repertoire parent du script (../ depuis scripts/).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=${1:-"$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"}

PLUGIN_ID="cordova-plugin-multicam-httpd"
JAVA_PKG="com/rjfun/cordova/httpd"

SRC="$APP_DIR/local-plugins/$PLUGIN_ID"
REG="$APP_DIR/plugins/$PLUGIN_ID"
PLAT_JAVA="$APP_DIR/platforms/android/app/src/main/java/$JAVA_PKG"
PLAT_WWW_PLATFORM_DIR="$APP_DIR/platforms/android/platform_www/plugins/$PLUGIN_ID/www"
PLAT_WWW_ASSETS_DIR="$APP_DIR/platforms/android/app/src/main/assets/www/plugins/$PLUGIN_ID/www"

JAVA_FILES="CorHttpd.java NanoHTTPD.java WebServer.java AndroidFile.java"

FAIL=0
fail() { echo "  ERREUR  $1"; FAIL=$((FAIL + 1)); }
ok()   { echo "  ok      $1"; }

echo "=== Controle packaging D-SERVE ($PLUGIN_ID) ==="
echo "APP_DIR=$APP_DIR"

# --- 0. presence des arborescences -----------------------------------------
for d in "$SRC" "$REG" "$PLAT_JAVA"; do
  if [ ! -d "$d" ]; then fail "arborescence absente: $d"; fi
done
if [ "$FAIL" -ne 0 ]; then
  echo "Resultat: ECHEC ($FAIL)"
  exit 1
fi

# --- 1. marqueurs Java du routeur ------------------------------------------
echo "--- Java: routeur multi-Take ---"
if grep -q "TakeRouterImpl" "$SRC/src/android/CorHttpd.java"; then
  ok "source local-plugins: TakeRouterImpl present"
else
  fail "source local-plugins: TakeRouterImpl ABSENT ($SRC/src/android/CorHttpd.java)"
fi
if grep -q "setTakeRouter" "$SRC/src/android/NanoHTTPD.java"; then
  ok "source local-plugins: setTakeRouter present"
else
  fail "source local-plugins: setTakeRouter ABSENT ($SRC/src/android/NanoHTTPD.java)"
fi
if grep -q "take not registered" "$PLAT_JAVA/CorHttpd.java"; then
  ok "plateforme compilee: routeur present (chaine 'take not registered')"
else
  fail "plateforme compilee: routeur ABSENT dans $PLAT_JAVA/CorHttpd.java (APK perime)"
fi

# --- 2. marqueurs du pont Cordova JS ---------------------------------------
echo "--- JS: pont registerTake/unregisterTake ---"
check_js() {
  loc="$1"; file="$2"
  if [ ! -f "$file" ]; then fail "$loc: fichier absent ($file)"; return; fi
  if grep -q "registerTake" "$file" && grep -q "unregisterTake" "$file"; then
    ok "$loc: registerTake + unregisterTake presents"
  else
    fail "$loc: registerTake/unregisterTake ABSENTS ($file)"
  fi
}
check_js "local-plugins" "$SRC/www/CorHttpd.js"
check_js "plugins"       "$REG/www/CorHttpd.js"
check_js "platform_www"  "$PLAT_WWW_PLATFORM_DIR/CorHttpd.js"
check_js "assets/www"    "$PLAT_WWW_ASSETS_DIR/CorHttpd.js"

# --- 3. coherence octet a octet --------------------------------------------
echo "--- Coherence des copies (cmp) ---"
for f in $JAVA_FILES; do
  if cmp -s "$SRC/src/android/$f" "$REG/src/android/$f"; then
    ok "plugins/ == local-plugins/ : $f"
  else
    fail "plugins/ PERIME vs local-plugins/ : $f"
  fi
  if cmp -s "$SRC/src/android/$f" "$PLAT_JAVA/$f"; then
    ok "platforms/ == local-plugins/ : $f"
  else
    fail "platforms/ PERIME vs local-plugins/ : $f (sera compile dans l'APK)"
  fi
done
if cmp -s "$SRC/www/CorHttpd.js" "$REG/www/CorHttpd.js"; then
  ok "plugins/ == local-plugins/ : www/CorHttpd.js"
else
  fail "plugins/ PERIME vs local-plugins/ : www/CorHttpd.js"
fi
# Le JS de plateforme est ENVELOPPE par Cordova (cordova.define) : il n'est pas
# comparable octet a octet a la source ; sa coherence est deja couverte par les
# marqueurs registerTake/unregisterTake ci-dessus.

echo "---"
if [ "$FAIL" -ne 0 ]; then
  echo "Resultat: ECHEC ($FAIL) — re-installer le plugin local :"
  echo "  cd $APP_DIR && cordova plugin rm $PLUGIN_ID && cordova plugin add local-plugins/$PLUGIN_ID"
  exit 1
fi
echo "Resultat: OK — les copies sont synchronisees et le routeur D-SERVE est present."
exit 0
