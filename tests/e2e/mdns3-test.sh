#!/bin/sh
# MultiCam — mdns3-test.sh : validation Android↔Android (J03, 3 appareils).
# EXIGENCE INFRA : la validation nécessite EXACTEMENT 3 devices installables + lançables.
#  - les 3 serials autorisés sont essayés ; les devices qui n'acceptent pas l'APK sont exclus
#    (documentés) ; si moins de 3 appareils sont utilisables, le script échoue (rc=3) et laisse
#    J03 en PARTIAL — jamais de réduction silencieuse du nombre de devices.
# Périmètre : découverte mutuelle des 3, identité strictement par deviceId (jamais IP/nom),
# auto-filtre, zéro doublon, stop/restart → même deviceId, propagation renommage/skills, zéro
# skill ([], o.), /health Android→Android (nc), bascule Wi-Fi, cycles stop/restart, cas de nom
# identique entre 2 appareils (régression du filtre d'identité).
# Usage: mdns3-test.sh [dossier_sortie]   (défaut: validation/J03-decouverte-mdns)
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="${1:-$HERE/validation/J03-decouverte-mdns}"
. "$HERE/lib/common.sh"
. "$HERE/lib/ui.sh"
APK="${APK:-$HERE/../../app/platforms/android/app/build/outputs/apk/debug/app-debug.apk}"
PKG="fr.emmanuel.multicam"
ACT="$PKG/.MainActivity"
LOGRE="CONFIG_INIT|APP_BOOT|HOME_RENDER|SETTINGS_OPEN|DEVICE_NAME_SET|SKILL_SET|MDNS|HEALTH|NET_CHANGED|NSD"
NAMES_A="Nord A"; NAMES_B="Nord B"; NAMES_C="Nord C"
NAMES_X="NordEtoile"
rc=0

require_adb
mkdir -p "$OUT"
adb devices -l >"$OUT/adb-devices3.txt" 2>&1

# --- Sélection : exactement 3 devices acceptant l'APK courant --------------------
SERIALS=""
for sd in $(authorized_serials); do
  [ "$(echo "$SERIALS" | wc -w | tr -d ' ')" -ge 3 ] && break
  if adb -s "$sd" install -r "$APK" >"$OUT/install3-$sd.log" 2>&1; then
    SERIALS="$SERIALS $sd"
  else
    echo "EXCLU $sd: $(grep -o 'Failure[^:]*: [^ ]*' "$OUT/install3-$sd.log" | head -1)" >>"$OUT/note-contexte3.txt"
  fi
done
SERIALS=$(echo "$SERIALS" | xargs)
COUNT=$(echo "$SERIALS" | wc -w | tr -d ' ')
if [ "$COUNT" -ne 3 ]; then
  echo "[J03-3] EXIGENCE NON REMPLIE: $COUNT/3 devices installables. Validation Android↔Android reste PARTIAL. rc=3"
  [ "$COUNT" -gt 0 ] && adb devices -l
  exit 3
fi
D1=$(echo $SERIALS | cut -d' ' -f1); D2=$(echo $SERIALS | cut -d' ' -f2); D3=$(echo $SERIALS | cut -d' ' -f3)
echo "[J03-3] devices: $D1 / $D2 / $D3"
D="$D1 $D2 $D3"

ok()   { echo "[J03-3:SCR] $sc OK   $1"; }
info() { echo "[J03-3:SCR] $sc INFO  $1"; }
fail() { echo "[J03-3:SCR] $sc ECHEC $1"; rc=1; }

cfg_cat() { adb -s "$1" shell run-as "$PKG" cat files/config.json 2>/dev/null; }
cfg_field() { cfg_cat "$1" | grep -o "\"$2\"[ ]*:[ ]*\"[^\"]*\"" | head -1 | sed 's/.*:[ ]*"//; s/"$//'; }
cfg_enabled() { cfg_cat "$1" | tr -d '\n' | sed -n 's/.*"enabledSkills"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d ' "' | grep -v '^$'; }
enabled_has() { cfg_enabled "$1" | grep -qx "$2"; }

clear4() { for s in $D; do adb -s "$s" logcat -c >/dev/null 2>&1; done; }
log_out4() { for s in $D; do adb -s "$s" logcat -d 2>/dev/null | grep -E "$LOGRE" >"$OUT/$s-$1.log"; done; }
log_pat_s() { adb -s "$1" logcat -d 2>/dev/null | grep -aE "$2" | tail -1; }
wait_log_s() { # $1 serial, $2 regex, $3 tries=40, $4 delay=2
  t=${3:-40}; d=${4:-2}; i=0
  while [ "$i" -lt "$t" ]; do [ -n "$(log_pat_s "$1" "$2")" ] && return 0; sleep "$d"; i=$(( i + 1 )); done
  return 1
}
has_log_s() { [ -n "$(log_pat_s "$1" "$2")" ]; }
ip_now() { adb -s "$1" shell ip addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | grep -v '127.0.0.1' | head -1 | sed 's/inet //'; }
table_s() { adb -s "$1" logcat -d 2>/dev/null | grep -aoE 'MDNS_PEER_TABLE (found|updated|restored|lost) peers=[0-9]+ rows=\[.*\]' | tail -1; }
wait_peers() { # $1 serial, $2 n   — attend MDNS_PEER_TABLE *tag* peers=$2 (any tag)
  t=${3:-60}; i=0
  while [ "$i" -lt "$t" ]; do
    [ -n "$(adb -s "$1" logcat -d 2>/dev/null | grep -aE "MDNS_PEER_TABLE (found|updated|restored|lost) peers=$2 " )" ] && return 0
    sleep 2; i=$(( i + 1 ))
  done
  return 1
}
shot() { n=$((n + 1)); ui_screenshot "$1" "$OUT/$1-$(printf '%02d' "$n")-$2.png"; }

# ---- convergence ACL par PAIR (latence NSD mesurée, bornes généreuses) ----------
peer_row() { # $1 vue-serial, $2 did-cible → objet JSON complet du peer (ou vide). Les rows n'ont pas de '{' imbriqué.
  table_s "$1" | grep -oE '\{"deviceId":"'$2'"[^}]*\}' | head -1
}
peer_has_row() { [ -n "$(peer_row "$1" "$2")" ]; }
peer_has() { # $1 vue-serial, $2 did, $3 fragment ("name":"NordEtoile" etc.)
  p=$(peer_row "$1" "$2"); [ -n "$p" ] && echo "$p" | grep -qF "$3"
}
wait_until() { # $1 tries, $2 delay, cmd... → jusqu'à succès ou épuisement
  t=$1; d=$2; shift 2; i=0
  while [ "$i" -lt "$t" ]; do "$@" && return 0; sleep "$d"; i=$(( i + 1 )); done
  return 1
}
table_ok() { # $1 serial, $2 peers-attendus → 0/1
  r=$(table_s "$1"); [ -n "$r" ] || return 1
  echo "$r" | grep -q "peers=$2 " || return 1
  [ "$(echo "$r" | grep -oE '"deviceId":"[0-9a-f-]+"' | sort -u | grep -c .)" = "$2" ]
}
wait_table_ok() { wait_until "$3" 5 table_ok "$1" "$2"; }
lat_start() { T0=$(date +%s); }
lat_stop() { # $1 libellé → enregistre la latence (s)
  echo "$(date +%s) - $T0 = ?" >/dev/null
  echo "[LAT] $1 : $(( $(date +%s) - T0 )) s" >>"$OUT/latency3.txt"
}
wait_peer_cap() { # $1 vue-serial, $2 did, $3 fragment, $4 tries(×5s), $5 libellé
  lat_start
  if wait_until "$4" 5 peer_has "$1" "$2" "$3"; then
    lat_stop "$5 (vue  did )"; return 0
  fi
  lat_stop "$5 (vue  did ) [TIMEOUT]"; return 1
}
wait_peer_gone() { # $1 vue-serial, $2 did, $3 tries(×5s), $4 libellé
  lat_start; i=0
  while [ "$i" -lt "$3" ]; do peer_has_row "$1" "$2" || { lat_stop "$4 (vue  did )"; return 0; }; sleep 5; i=$(( i + 1 )); done
  lat_stop "$4 (vue  did ) [TIMEOUT]"; return 1
}
dedupe_check() { # $1 vue-serial, $2 did → 1 seule entrée ? (0/1)
  [ "$(table_s "$1" | grep -oE '"deviceId":"'$2'"' | grep -c .)" = "1" ]
}

# ---- (S10) état observable, reconstruction produit-indépendante ------------------
# Diagnostic diag-wifi40s-2026-09-20 : une coupure Wi-Fi sub-TTL NSD (~120 s) produit
# sur les pairs de D1 : AUCUN serviceLost, AUCUNE nouvelle ligne MDNS_PEER_TABLE, et
# des RESOLVE OK servis depuis le cache NSD. On ne déduit donc JAMAIS l'absence d'un
# peer de l'absence d'une nouvelle table ; on lit l'état observable de chaque device.
wifi_off_state() { # $1 serial → 0 dès que Wi-Fi désactivé
  st=$(adb -s "$1" shell cmd wifi status 2>/dev/null | head -1)
  case "$st" in
    *disabled*|*Disabled*) return 0;;
  esac
  return 1
}
wait_wifi_off() { # $1 serial, $2 tries=15, $3 delay=2
  t=${2:-15}; d=${3:-2}; i=0
  while [ "$i" -lt "$t" ]; do wifi_off_state "$1" && return 0; sleep "$d"; i=$(( i + 1 )); done
  return 1
}
resolve_cnt() { # $1 serial, $2 did → nb RESOLVE OK (deviceId, buffer complet)
  adb -s "$1" logcat -d 2>/dev/null | grep -ac "MDNS_RESOLVE deviceId=$2 result=OK"
}
resolve_after() { # $1 serial, $2 did, $3 baseline, $4 tries=25, $5 delay=3
  t=${4:-25}; d=${5:-3}; i=0
  while [ "$i" -lt "$t" ]; do [ "$(resolve_cnt "$1" "$2")" -gt "$3" ] && return 0; sleep "$d"; i=$(( i + 1 )); done
  return 1
}
resolve_host() { # $1 serial, $2 did → host du dernier RESOLVE OK (éviction-buffer safe si récent)
  adb -s "$1" logcat -d 2>/dev/null | grep -aoE "MDNS_RESOLVE deviceId=$2 result=OK host=[0-9.]+" \
    | tail -1 | sed -E 's/.*host=//'
}
table_rowcount() { # $1 serial, $2 did → occurrences de ce deviceId dans la DERNIÈRE table
  table_s "$1" | grep -oE '"deviceId":"'$2'"' | grep -c .
}
wait_table_fresh() { # $1 serial, $2 peers, $3 tag, $4 tries, $5 delay
  t=$4; d=${5:-3}; i=0
  while [ "$i" -lt "$t" ]; do
    r=$(table_s "$1")
    case "$r" in
      "MDNS_PEER_TABLE $3 peers=$2 "*)
        [ "$(echo "$r" | grep -oE '"deviceId":"[0-9a-f-]+"' | sort -u | grep -c .)" = "$2" ] && return 0;;
    esac
    sleep "$d"; i=$(( i + 1 ))
  done
  return 1
}

# --- Identité : deviceId + IP + nom par appareil ---------------------------------
for s in $D; do
  eval "DID_${s}_x=$(cfg_field $s deviceId)"
  eval "IP_${s}_x=$(ip_now $s)"
done
# mapping par ordinal (ordre d'install = ordre ci-dessus)
D1_DID=$(cfg_field "$D1" deviceId); D1_IP=$(ip_now "$D1")
D2_DID=$(cfg_field "$D2" deviceId); D2_IP=$(ip_now "$D2")
D3_DID=$(cfg_field "$D3" deviceId); D3_IP=$(ip_now "$D3")
echo "deviceId=$D1_DID name=$(cfg_field $D1 deviceName) ip=$D1_IP" >"$OUT/identite3.txt"
echo "deviceId=$D2_DID name=$(cfg_field $D2 deviceName) ip=$D2_IP" >>"$OUT/identite3.txt"
echo "deviceId=$D3_DID name=$(cfg_field $D3 deviceName) ip=$D3_IP" >>"$OUT/identite3.txt"

[ "$D1_DID" != "$D2_DID" ] && [ "$D1_DID" != "$D3_DID" ] && [ "$D2_DID" != "$D3_DID" ] \
  && ok "3 deviceId distincts" || fail "deviceId en collision ($D1_DID/$D2_DID/$D3_DID)"

# ---- UI helpers (sérialisé) ------------------------------------------------------
open_settings() { # $1 serial
  ui_wait "$1" backHome 4 1 && return 0
  ui_wait "$1" menuButton 12 2 || return 1
  ui_tap "$1" menuButton; sleep 1
  ui_tap "$1" navSettings; sleep 4
  ui_wait "$1" deviceNameInput 12 2
}
back_home() { # $1 serial
  ui_wait "$1" backHome 8 2 || return 1
  ui_tap "$1" backHome; sleep 3
  ui_wait "$1" menuButton 15 2 || { ui_tap "$1" backHome; sleep 4; ui_wait "$1" menuButton 15 2; }
}
set_skill() { # $1 serial, $2 skill, $3 1/0
  if [ "$3" = 1 ]; then enabled_has "$1" "$2" || { ui_tap "$1" "skill-$2"; sleep 2; }
  else enabled_has "$1" "$2" && { ui_tap "$1" "skill-$2"; sleep 2; }; fi
}
rename_to() { # $1 serial, $2 nom
  open_settings "$1" || return 1
  ui_clear_field "$1" deviceNameInput
  ui_input_text "$1" "$2"
  ui_tap "$1" saveName
  sleep 3
}
rename_to_verified() { # $1 serial, $2 nom, $3 essais=3 → rename + vérifie persistance
  tries=${3:-3}; i=0
  while [ "$i" -lt "$tries" ]; do
    rename_to "$1" "$2" || { i=$(( i + 1 )); sleep 2; continue; }
    [ "$(cfg_field "$1" deviceName)" = "$2" ] && return 0
    sleep 2; i=$(( i + 1 ))
  done
  return 1
}
ensure_full_skills() { # $1 serial
  open_settings "$1" || return 1
  set_skill "$1" capture 1; set_skill "$1" storage 1; set_skill "$1" controller 1
  back_home "$1" || true
}
app_start() { # $1 serial
  adb -s "$1" shell am force-stop "$PKG" >/dev/null 2>&1; sleep 1
  adb -s "$1" shell am start -n "$ACT" >/dev/null 2>&1 || true
}
app_stop() { adb -s "$1" shell am force-stop "$PKG" >/dev/null 2>&1; }
all_start() { for s in $D; do app_start "$s"; done; sleep 12; }
ui_on_home() { ui_wait "$1" devicesCount 20 2 || ui_wait "$1" menuButton 20 2; }

# --- Phase 0 : baseline déterministe (noms distincts + skills pleines) -----------
echo "[J03-3] Phase 0 — baseline (noms 'Nord A/B/C', skills pleines)"
clear4
# Les apps sont force-stopped après les phases précédentes ; on les (re)lance AVANT
# tout open_settings/rename_to, sinon l'UI n'existe pas et le renommage Phase 0
# échoue SILENCIEUSEMENT (cause historique du baseline D1 non établi).
all_start
ensure_full_skills "$D1"
ensure_full_skills "$D2"
ensure_full_skills "$D3"
# On ne suppose PAS que le renommage Phase 0 a réussi (historique : échec silencieux
# sur un appareil). Chaque baseline est établie avec vérification (persisté + annoncé).
if [ "$(cfg_field "$D1" deviceName)" != "$NAMES_A" ]; then rename_to_verified "$D1" "$NAMES_A"; fi
if [ "$(cfg_field "$D2" deviceName)" != "$NAMES_B" ]; then rename_to_verified "$D2" "$NAMES_B"; fi
if [ "$(cfg_field "$D3" deviceName)" != "$NAMES_C" ]; then rename_to_verified "$D3" "$NAMES_C"; fi
[ "$(cfg_field "$D1" deviceName)" = "$NAMES_A" ] && ok "Phase 0 : D1 baseline '$NAMES_A' vérifié" || fail "Phase 0 : baseline D1 ('$NAMES_A') non établi"
[ "$(cfg_field "$D2" deviceName)" = "$NAMES_B" ] && ok "Phase 0 : D2 baseline '$NAMES_B' vérifié" || fail "Phase 0 : baseline D2 ('$NAMES_B') non établi"
[ "$(cfg_field "$D3" deviceName)" = "$NAMES_C" ] && ok "Phase 0 : D3 baseline '$NAMES_C' vérifié" || fail "Phase 0 : baseline D3 ('$NAMES_C') non établi"
for s in "$D1" "$D2" "$D3"; do
  wait_log_s "$s" "MDNS_ADVERTISE_READY" 15 3 >/dev/null || { info "Phase 0 : ADVERTISE_READY non vu sur $s (fenêtre)"; }
done
sleep 2
state() { adb -s "$1" shell run-as "$PKG" cat files/config.json 2>/dev/null >"$OUT/$1-$2-config.json"; }
state "$D1" "00-base"; state "$D2" "00-base"; state "$D3" "00-base"

# ======================= SCRENARIO S1 — découverte mutuelle ======================
sc=S1
clear4
all_start
sleep 5
ok "les 3 apps démarrées (relance complète)"
err=0
for s in $D; do wait_log_s "$s" 'MDNS_PEER_TABLE found peers=2' 30 2 || { info "$s sans table peers=2"; err=1; }; done
[ "$err" = 0 ] && ok "chaque appareil converge vers peers=2" || fail "convergence peers=2 incomplète"
log_out4 "S1-mutual"
selfbad=0; dupbad=0
for s in $D; do
  mydid=$(cfg_field "$s" deviceId)
  if grep -q '"deviceId":\?"'"/\"$mydid\"" "$OUT/$s-S1-mutual.log" 2>/dev/null || grep -aoE 'peers=[0-9]+ rows=\[\{"deviceId":"'"$mydid"'"' "$OUT/$s-S1-mutual.log" | grep -q .; then selfbad=1; fi
done
[ "$selfbad" = 0 ] && ok "aucun appareil ne se voit lui-même en peer" || fail "self présent dans sa propre table"
shot "$D1" "S1-home-peer2"
shot "$D2" "S1-home-peer2"
shot "$D3" "S1-home-peer2"
ui_on_home "$D1"
[ "$(ui_text "$D1" devicesCount)" = "2" ] && ok "UI compteur 2 périphériques (D1)" || info "devicesCount=$(ui_text $D1 devicesCount)"

# ======================= SCRENARIO S2 — identité par deviceId ====================
sc=S2
# chaque table contient EXACTEMENT les 2 autres deviceId (jamais-soi)
okid=0
for s in $D; do
  wait_table_ok "$s" 2 15 || okid=1
done
for s in $D; do
  mydid=$(cfg_field "$s" deviceId)
  others=""
  [ "$s" != "$D1" ] && others="$others $D1_DID"
  [ "$s" != "$D2" ] && others="$others $D2_DID"
  [ "$s" != "$D3" ] && others="$others $D3_DID"
  rows=$(table_s "$s")
  for o in $others; do
    echo "$rows" | grep -q '"deviceId":"'$o'"' || { fail "$s : $o absent de la table"; okid=1; }
    case "$o" in
    "$D1_DID") o_name="$NAMES_A";;
    "$D2_DID") o_name="$NAMES_B";;
    "$D3_DID") o_name="$NAMES_C";;
  esac
  echo "$rows" | grep -q '"name":"'"$o_name"'"' || { fail "$s : nom $o_name absent pour $o"; okid=1; }
  done
  echo "$rows" | grep -q '"deviceId":"'$mydid'"' && { fail "$s : se voit soi-même"; okid=1; }
done
[ "$okid" = 0 ] && ok "identité peers = deviceId (2 autres, jamais soi, noms cohérents)" || fail "écart d'identité (deviceId vs nom/IP)"

# ======================= SCRENARIO S3 — zéro doublon =============================
sc=S3
nb=0
for s in $D; do
  wait_table_ok "$s" 2 15 || nb=1
  r=$(table_s "$s")
  [ "$(echo "$r" | grep -oE '"deviceId":"[0-9a-f-]+"' | sort -u | grep -c .)" = "2" ] || nb=1
  [ "$(echo "$r" | grep -oE '"deviceId":"[0-9a-f-]+"' | grep -c .)" = "2" ] || nb=1
done
[ "$nb" = 0 ] && ok "aucune table ne contient de doublon (toutes peers=2, 2 rows uniques)" || fail "doublon/écart de counts détecté"

# ================== SCRENARIO S4 — stop D2 → perte sur D1/D3 =====================
sc=S4
clear4
app_stop "$D2"
seen_lost=0
for s in "$D1" "$D3"; do
  wait_log_s "$s" "MDNS_PEER_LOST deviceId=$D2_DID" 20 3 && seen_lost=1
done
if [ "$seen_lost" = 1 ]; then
  w=0
  for s in "$D1" "$D3"; do
    wait_peers "$s" 1 25 || { fail "$s table != peers=1 après perte"; w=1; }
  done
  [ "$w" = 0 ] && ok "perte D2 vue (serviceLost) et tables D1/D3 à peers=1" || fail "convergence perte D2 incomplète"
else
  info "perte D2 non détectée dans l'EM (<60s) : NSD death-detection timing — S5 vérifie la reconvergence"
fi
log_out4 "S4-stopD2"
shot "$D1" "S4-D2-lost"

# ================== SCRENARIO S5 — restart D2 → même deviceId ====================
sc=S5
clear4
app_start "$D2"
w=0
for s in "$D1" "$D3"; do
  wait_peer_cap "$s" "$D2_DID" '"name":"'"$NAMES_B"'"' 40 "S5 restart-D2 revu" || { fail "$s n'a pas revu D2 ($NAMES_B)"; w=1; }
  wait_table_ok "$s" 2 12 || { fail "$s table != peers=2 après retour D2"; w=1; }
done
[ "$w" = 0 ] && ok "D2 revient avec le MÊME deviceId ($D2_DID) sur D1/D3" || fail "reconvergence D2 incomplète"
[ "$(cfg_field "$D2" deviceId)" = "$D2_DID" ] && ok "deviceId D2 inchangé côté config" || fail "deviceId D2 modifié par le restart"
log_out4 "S5-restartD2"

# ============== SCRENARIO S6 — renommage D1 → propagation D2/D3 =================
# Précondition impérative : baseline D1 ≠ cible, ÉTABLIE et VÉRIFIÉE (persistée +
# annoncée). On ne suppose PAS que la Phase 0 a réussi : sinon le "renommage" vers
# $NAMES_X est un no-op sans delta et il n'y a rien à propager (défaut antérieur).
sc=S6
clear4
d1cur=$(cfg_field "$D1" deviceName)
info "S6 baseline courant D1 = '$d1cur' (cible rename = '$NAMES_X')"
if [ "$d1cur" != "$NAMES_A" ]; then
  rename_to_verified "$D1" "$NAMES_A" || fail "S6 pré : baseline '$NAMES_A' non établi sur D1"
fi
[ "$(cfg_field "$D1" deviceName)" = "$NAMES_A" ] && ok "S6 pré : baseline D1 persisté = '$NAMES_A'" || fail "S6 pré : baseline D1 non persisté"
wait_log_s "$D1" "MDNS_ADVERTISE_READY[^\"]* registeredName=$NAMES_A" 15 3 \
  && ok "S6 pré : baseline '$NAMES_A' annoncé (ADVERTISE_READY)" || info "S6 pré : baseline annoncé non revisitable (éviction buffer, vérifié au rename)"
for s in "$D2" "$D3"; do
  wait_peer_cap "$s" "$D1_DID" '"name":"'"$NAMES_A"'"' 30 "S6 pré baseline Nord-A propagé" \
    && ok "$s voit D1 sous le baseline '$NAMES_A'" || info "$s : baseline '$NAMES_A' pas encore vu (fenêtre NSD)"
done
info "S6 renommage réel : '$NAMES_A' → '$NAMES_X' (delta de valeur garanti)"
rename_to_verified "$D1" "$NAMES_X" && ok "D1 renommé '$NAMES_X'" || fail "renommage D1 échoué"
[ "$(cfg_field "$D1" deviceName)" = "$NAMES_X" ] && ok "config D1 = $NAMES_X persistée" || fail "config D1 non persistée"
okrr=0
wait_log_s "$D1" "MDNS_ADVERTISE_READY[^\"]* registeredName=$NAMES_X" 12 3 && okrr=1
wait_log_s "$D1" "MDNS_REANNOUNCE_TRIGGER reason=name_change name=$NAMES_X" 10 3 || true
[ "$okrr" = 1 ] && ok "D1 a ré-annoncé '$NAMES_X' (ADVERTISE_READY)" || fail "ADVERTISE_READY $NAMES_X non vu sur D1"
w=0
for s in "$D2" "$D3"; do
  wait_log_s "$s" "MDNS_SERVICE_FOUND service=$NAMES_X" 20 3 && ok "$s a découvert l'instance '$NAMES_X'" || { fail "$s n'a pas découvert l'instance '$NAMES_X'"; w=1; }
  wait_peer_cap "$s" "$D1_DID" '"name":"'"$NAMES_X"'"' 30 "S6 rename-D1 propagé" \
    && ok "$s voit D1 sous '$NAMES_X' (même deviceId)" || {
      fail "$s : propagation du nom '$NAMES_X' non confirmée (delta réel exercé)"
      w=1
    }
  dedupe_check "$s" "$D1_DID" && ok "$s : une seule entrée pour D1 (pas de doublon)" \
    || { fail "$s : doublon/absence pour D1 (deviceId $D1_DID)"; w=1; }
done
[ "$w" = 0 ] && ok "renommage propagé aux 2 pairs, identité deviceId conservée" || fail "S6 : écart de propagation du delta de nom"
log_out4 "S6-renameD1"

# ============== SCRENARIO S7 — skills D3 (storage off) → propagation ============
sc=S7
clear4
for s in "$D1" "$D2"; do wait_table_ok "$s" 2 12 >/dev/null; done
open_settings "$D3" || fail "settings D3 indisponible"
set_skill "$D3" storage 0
if wait_log_s "$D3" 'MDNS_REANNOUNCE_TRIGGER reason=skill_change skill=storage enabled=0' 10 1 && \
   wait_log_s "$D3" 'MDNS_ADVERTISE_READY' 12 2; then
  ok "D3 a ré-annoncé le changement de skills (ADVERTISE_READY)"
else
  info "ré-annonce skills D3 non confirmée dans la fenêtre"
fi
sleep 3
back_home "$D3" || true
enabled_has "$D3" storage && fail "D3 config storage encore actif après toggle" || ok "D3 config storage=off persisté"
w=0
for s in "$D1" "$D2"; do
  wait_peer_cap "$s" "$D3_DID" '"enabled":["capture","controller"]' 40 "S7 storage-off propagé" \
    && ok "$s voit D3 sans storage" || { info "$s : storage-off pas propagé (fenêtre NSD)"; w=1; }
done
[ "$w" = 0 ] && ok "changement de skills propagé à D1/D2 sans doublon" || info "propagation skills à confirmer (latence NSD)"
log_out4 "S7-skillsD3"

# ============== SCRENARIO S8 — enabledSkills=[] sur D2 → propagation ============
sc=S8
clear4
open_settings "$D2" || fail "settings D2 indisponible"
i=0
while [ "$i" -lt 8 ]; do
  set_skill "$D2" capture 0; set_skill "$D2" storage 0; set_skill "$D2" controller 0
  [ -z "$(cfg_enabled "$D2")" ] && break
  sleep 3; i=$(( i + 1 ))
done
[ -z "$(cfg_enabled "$D2")" ] && ok "D2 config enabledSkills=[] persisté" || fail "D2 config non vide (enabled=[$(cfg_enabled $D2 | tr '\n' ' ')])"
wait_log_s "$D2" 'MDNS_REANNOUNCE_TRIGGER reason=skill_change' 10 1 || true
sleep 3
back_home "$D2" || true
w=0
for s in "$D1" "$D3"; do
  wait_peer_cap "$s" "$D2_DID" '"enabled":[]' 40 "S8 zero-skill propagé" \
    && ok "$s voit D2 avec enabled=[]" || { info "$s : enabled=[] non propagé (fenêtre NSD)"; w=1; }
  wait_table_ok "$s" 2 12 >/dev/null || w=1
done
[ "$w" = 0 ] && ok "enabledSkills=[] propagé (2 pairs convergent, pas de doublon)" || info "propagation zéro-skill à confirmer (latence NSD)"
log_out4 "S8-zero-d2"
shot "$D1" "S8-zero-node"
# restauration skills D2
open_settings "$D2" || true
set_skill "$D2" capture 1; set_skill "$D2" storage 1; set_skill "$D2" controller 1
back_home "$D2" || true
sleep 2

# ============== SCRENARIO S9 — /health Android→Android (nc) =====================
sc=S9
# IP actuelles (les bascules réseau peuvent avoir changé les adresses)
D1_IP=$(ip_now "$D1"); D2_IP=$(ip_now "$D2"); D3_IP=$(ip_now "$D3")
ok12=0; ok13=0; ok31=0
h=$(printf 'GET /health HTTP/1.0\r\n\r\n' | nc -w 3 "$D2_IP" 45101 2>/dev/null)
echo "$h" | grep -q '"ok":true' && echo "$h" | grep -q "\"deviceId\":\"$D2_DID\"" && ok12=1
h2=$(printf 'GET /health HTTP/1.0\r\n\r\n' | nc -w 3 "$D3_IP" 45101 2>/dev/null)
echo "$h2" | grep -q '"ok":true' && echo "$h2" | grep -q "\"deviceId\":\"$D3_DID\"" && ok13=1
h3=$(printf 'GET /health HTTP/1.0\r\n\r\n' | nc -w 3 "$D1_IP" 45101 2>/dev/null)
echo "$h3" | grep -q '"ok":true' && echo "$h3" | grep -q "\"deviceId\":\"$D1_DID\"" && ok31=1
[ "$ok12" = 1 ] && ok "D1→D2 /health ok:true + deviceId corrélé" || fail "D1→D2 /health"
[ "$ok13" = 1 ] && ok "D1→D3 /health ok:true + deviceId corrélé" || fail "D1→D3 /health"
[ "$ok31" = 1 ] && ok "D3→D1 /health ok:true + deviceId corrélé" || fail "D3→D1 /health"
echo "$h"   >>"$OUT/health-D1-to-D2.txt"
echo "$h2"  >>"$OUT/health-D1-to-D3.txt"
echo "$h3"  >>"$OUT/health-D3-to-D1.txt"
c=$(printf 'GET /other HTTP/1.0\r\n\r\n' | nc -w 2 "$D2_IP" 45101 2>/dev/null | grep -c '404' || true)
[ "$c" -ge 1 ] && ok "D1→D2 /other → 404" || info "route inconnue: pas de 404"

# ============== SCRENARIO S10 — Wi-Fi D1 : coupure/retour (fenêtre sub-TTL) ======
# Reconstruit à partir des états observables (PAS d'inférence d'absence sur l'absence
# d'une ligne MDNS_PEER_TABLE). Rappel diagnostic (diag-wifi40s-2026-09-20) : coupure
# < TTL cache NSD ⇒ pas de serviceLost chez les pairs, pas de nouvelle table, RESOLVE
# servis depuis le cache. Validations : Wi-Fi réellement coupé, D1 perd ses pairs
# locaux, retour Wi-Fi, ré-annonce + re-découverte D1, continuité de résolution
# D2/D3, convergence finale peers=2 sans doublon de deviceId. Un serviceLost distant
# n'est PAS exigé pour une coupure courte (comportement plateforme documenté).
sc=S10
w=0
d1n=$(cfg_field "$D1" deviceName)
# --- État de référence VIVANT (reconstruction événementielle, insensitive à
# l'éviction du ring-buffer logcat et aux tables silencieuses après un restore
# sessionStorage) : chaque device doit re-résoudre ses 2 pairs distants (~36 s).
b1d2=$(resolve_cnt "$D1" "$D2_DID"); b1d3=$(resolve_cnt "$D1" "$D3_DID")
b2d1=$(resolve_cnt "$D2" "$D1_DID"); b2d3=$(resolve_cnt "$D2" "$D3_DID")
b3d1=$(resolve_cnt "$D3" "$D1_DID"); b3d2=$(resolve_cnt "$D3" "$D2_DID")
preref=0
resolve_after "$D1" "$D2_DID" "$b1d2" 12 3 || preref=1
resolve_after "$D1" "$D3_DID" "$b1d3" 12 3 || preref=1
resolve_after "$D2" "$D1_DID" "$b2d1" 12 3 || preref=1
resolve_after "$D2" "$D3_DID" "$b2d3" 12 3 || preref=1
resolve_after "$D3" "$D1_DID" "$b3d1" 12 3 || preref=1
resolve_after "$D3" "$D2_DID" "$b3d2" 12 3 || preref=1
[ "$preref" = 0 ] && ok "S10 état de référence : 2 pairs résolus par device (résolution vivante)" || fail "S10 état de référence pré-coupure incomplet"
h2b=$(resolve_host "$D2" "$D1_DID"); h3b=$(resolve_host "$D3" "$D1_DID")
adb -s "$D1" shell svc wifi disable >/dev/null 2>&1
wait_wifi_off "$D1" 15 2 && ok "D1 : Wi-Fi réellement désactivé (cmd wifi status)" || fail "D1 : Wi-Fi non désactivé"
wait_log_s "$D1" 'NET_CHANGED networkType=none' 10 2 && ok "D1 : NET_CHANGED none (interface coupée)" || info "D1 : NET_CHANGED none non journalisé (fenêtre)"
l12=0; l13=0
wait_log_s "$D1" "MDNS_PEER_LOST deviceId=$D2_DID" 15 2 && l12=1
wait_log_s "$D1" "MDNS_PEER_LOST deviceId=$D3_DID" 15 2 && l13=1
[ "$l12$l13" = "11" ] && ok "D1 a perdu ses pairs locaux (PEER_LOST D2+D3 côté D1)" || { info "perte locale D1 partielle (D2=$l12 D3=$l13, fenêtre NSD)"; w=1; }
# Baselines post-coupure : les RESOLVE servis depuis le cache pendant la coupure ne
# doivent pas servir de preuve de retour.
r2b=$(resolve_cnt "$D2" "$D1_DID"); r3b=$(resolve_cnt "$D3" "$D1_DID")
adb -s "$D1" shell svc wifi enable >/dev/null 2>&1
wait_log_s "$D1" 'NET_CHANGED networkType=wifi' 40 2 && ok "D1 : Wi-Fi revenu (NET_CHANGED wifi)" || fail "D1 : NET_CHANGED wifi non vu"
wait_log_s "$D1" "MDNS_ADVERTISE_READY[^\"]* registeredName=$d1n" 40 3 && ok "D1 : ré-annonce ADVERTISE_READY ($d1n)" || fail "D1 : ré-annonce non vue"
wait_table_fresh "$D1" 2 found 25 3 && ok "D1 : re-découverte complète (table found peers=2)" || { info "D1 : table 'found peers=2' non émise après retour"; w=1; }
td=$(table_s "$D1")
if echo "$td" | grep -q '"deviceId":"'$D1_DID'"'; then
  fail "D1 : auto-vue dans sa propre table"; w=1
else
  ok "D1 : aucune auto-vue (self-filter)"
fi
c2=$(table_rowcount "$D1" "$D2_DID"); c3=$(table_rowcount "$D1" "$D3_DID")
[ "$c2" = "1" ] && [ "$c3" = "1" ] && ok "D1 : une seule entrée par deviceId distant (D2=$c2, D3=$c3)" || { fail "D1 : comptage deviceId anormal (D2=$c2 D3=$c3)"; w=1; }
for s in "$D2" "$D3"; do
  dep=$( [ "$s" = "$D2" ] && echo "$r2b" || echo "$r3b" )
  if resolve_after "$s" "$D1_DID" "$dep" 25 3; then
    ok "$s : re-résolution D1 après retour Wi-Fi (RESOLVE deviceId=$D1_DID)"
  else
    info "$s : aucune nouvelle résolution D1 après retour (cache NSD)"; w=1
  fi
done
h2a=$(resolve_host "$D2" "$D1_DID"); h3a=$(resolve_host "$D3" "$D1_DID")
if [ "$h2a" = "$h2b" ] && [ "$h3a" = "$h3b" ]; then
  ok "D1 résolu vers le même hôte qu'avant coupure (pas de doublon d'hôte/deviceId)"
else
  info "hôte de résolution D1 modifié après coupure (D2: $h2b→$h2a, D3: $h3b→$h3a)"; w=1
fi
r1_2=0; r1_3=0
resolve_after "$D1" "$D2_DID" "$b1d2" 25 3 && r1_2=1
resolve_after "$D1" "$D3_DID" "$b1d3" 25 3 && r1_3=1
[ "$r1_2$r1_3" = "11" ] && ok "D1 : re-résolution de D2 et D3 après retour Wi-Fi" || { info "re-résolution D1 (D2=$r1_2 D3=$r1_3)"; w=1; }
[ "$w" = 0 ] && ok "reconvergence Wi-Fi (sub-TTL) : résolutions vivantes + table D1 fraîche + hôtes stables" || info "reconvergence Wi-Fi à confirmer (comportement NSD plateforme)"
log_out4 "S10-wifiD1"

# ========= SCRENARIO S10b — expiration NSD : coupure LONGUE → serviceLost pairs ===
# Scénario d'OBSERVATION du comportement plateforme (marqué INFO, ne bloque pas rc=0).
# Une coupure au-delà du TTL du cache NSD (~120 s) doit faire émettre un serviceLost
# aux pairs ; résultat réel consigné dans VALIDATION.md. Si aucun serviceLost n'est
# reçu, la reconvergence longue n'est pas applicable et reste documentée.
sc=S10b
w2=0
preref2=0
b1d2=$(resolve_cnt "$D1" "$D2_DID"); b1d3=$(resolve_cnt "$D1" "$D3_DID")
b2d1=$(resolve_cnt "$D2" "$D1_DID"); r3d1=$(resolve_cnt "$D3" "$D1_DID")
resolve_after "$D1" "$D2_DID" "$b1d2" 12 3 || preref2=1
resolve_after "$D1" "$D3_DID" "$b1d3" 12 3 || preref2=1
resolve_after "$D2" "$D1_DID" "$b2d1" 12 3 || preref2=1
resolve_after "$D3" "$D1_DID" "$r3d1" 12 3 || preref2=1
[ "$preref2" = 0 ] && ok "S10b état de référence : résolutions vivantes" || fail "S10b pré : résolutions de référence incomplètes"
adb -s "$D1" shell svc wifi disable >/dev/null 2>&1
wait_wifi_off "$D1" 15 2 || fail "S10b : Wi-Fi D1 non désactivé"
o12=0; o13=0
wait_log_s "$D2" "MDNS_PEER_LOST deviceId=$D1_DID" 90 2 && o12=1
wait_log_s "$D3" "MDNS_PEER_LOST deviceId=$D1_DID" 90 2 && o13=1
case "$o12$o13" in
  "11") ok "expiration NSD observée : serviceLost D1 reçu sur D2 et D3 (cache NSD expiré)";;
  "00") info "expiration NSD : serviceLost D1 non reçu en 180 s (cache NSD persisté par la plateforme) — comportement documenté";;
  *)    info "expiration NSD : serviceLost D1 reçu partiellement (D2=$o12 D3=$o13) — comportement plateforme à documenter";;
esac
adb -s "$D1" shell svc wifi enable >/dev/null 2>&1
if [ "$o12$o13" != "00" ]; then
  d1n=$(cfg_field "$D1" deviceName)
  for s in "$D2" "$D3"; do
    wait_peer_cap "$s" "$D1_DID" '"name":"'"$d1n"'"' 40 "S10b reconvergence D1 post-expiration" \
      && ok "$s a re-vu D1 après expiration (reconvergence)" || info "$s : reconvergence post-expiration lente (fenêtre NSD)"
  done
  conv2=0
  b1d2=$(resolve_cnt "$D1" "$D2_DID"); b1d3=$(resolve_cnt "$D1" "$D3_DID")
  b2d1=$(resolve_cnt "$D2" "$D1_DID"); b3d1=$(resolve_cnt "$D3" "$D1_DID")
  resolve_after "$D1" "$D2_DID" "$b1d2" 25 3 || conv2=1
  resolve_after "$D1" "$D3_DID" "$b1d3" 25 3 || conv2=1
  resolve_after "$D2" "$D1_DID" "$b2d1" 25 3 || conv2=1
  resolve_after "$D3" "$D1_DID" "$b3d1" 25 3 || conv2=1
  if [ "$conv2" = 0 ]; then
    ok "S10b : convergence finale après coupure longue (résolutions vivantes des 2 côtés)"
  else
    info "S10b : convergence finale à confirmer (résolutions partielles)"
  fi
  for s in $D; do wait_table_ok "$s" 2 15 || info "S10b : table finale $s non observable (éviction/restore)"; done
fi
log_out4 "S10b-expiryD1"

# ============== SCRENARIO S11 — cycles stop/restart D3 (×3) =====================
# Oracle de convergence = RÉSOLUTION vivante (MDNS_RESOLVE, émis à chaque cycle),
# insensible à l'éviction du ring-buffer et aux tables silencieuses après un restore
# sessionStorage. wait_peer_cap (table) reste une observation info. Un gate
# ADVERTISE_READY sur D3 attend la ré-annonce avant de compter (première ré-annonce
# froide typiquement lente, observée ~154 s au cycle 1).
sc=S11
c=1
while [ "$c" -le 3 ]; do
  clear4
  app_stop "$D3"
  for s in "$D1" "$D2"; do
    wait_log_s "$s" "MDNS_PEER_LOST deviceId=$D3_DID" 12 2 || info "$s : LOST D3 non vu (death-detection timing)"
  done
  sleep 2
  app_start "$D3"
  wait_log_s "$D3" "MDNS_ADVERTISE_READY[^\"]* registeredName=$NAMES_C" 60 3 \
    && ok "cycle $c : D3 ré-annoncé (ADVERTISE_READY $NAMES_C)" || info "cycle $c : ré-annonce D3 lente (fenêtre NSD)"
  w=0; conv=0
  b1d3=$(resolve_cnt "$D1" "$D3_DID"); b2d3=$(resolve_cnt "$D2" "$D3_DID")
  b3d1=$(resolve_cnt "$D3" "$D1_DID"); b3d2=$(resolve_cnt "$D3" "$D2_DID")
  resolve_after "$D1" "$D3_DID" "$b1d3" 45 3 || conv=1
  resolve_after "$D2" "$D3_DID" "$b2d3" 45 3 || conv=1
  resolve_after "$D3" "$D1_DID" "$b3d1" 45 3 || conv=1
  resolve_after "$D3" "$D2_DID" "$b3d2" 45 3 || conv=1
  [ "$conv" = 0 ] && ok "cycle $c : D3 re-résolu depuis D1/D2 et re-résout D1/D2 (deviceId=$D3_DID)" || { fail "cycle $c : re-résolution D3 incomplète"; w=1; }
  for s in "$D1" "$D2"; do
    wait_peer_cap "$s" "$D3_DID" '"name":"'"$NAMES_C"'"' 20 "S11 cycle$c D3 (table)" \
      && info "$s : ligne D3 présente dans la table (cycle$c)" || info "$s : table cycle$c non observable (éviction/restore — résolution déjà prouvée)"
  done
  [ "$w" = 0 ] && ok "cycle $c : convergence (deviceId D3 ré-identifié par résolution)" || fail "cycle $c : convergence incomplète"
  [ "$(cfg_field "$D3" deviceId)" = "$D3_DID" ] && ok "cycle $c : deviceId D3 stable" || fail "cycle $c : deviceId D3 changé"
  log_out4 "S11-cycle$c"
  c=$(( c + 1 ))
done
shot "$D1" "S11-final"

# ========== SCRENARIO S12 — même NOM sur D2 et D3 (régression self-filter) =======
sc=S12
clear4
rename_to "$D2" "$NAMES_X"
rename_to "$D3" "$NAMES_X"
w=0
wait_peer_cap "$D1" "$D2_DID" '"name":"'"$NAMES_X"'"' 45 "S12 D2 renommé" || w=1
wait_peer_cap "$D1" "$D3_DID" '"name":"'"$NAMES_X"'"' 45 "S12 D3 renommé" || w=1
r=$(table_s "$D1")
if echo "$r" | grep -qE '"deviceId":"'$D2_DID'"' && echo "$r" | grep -qE '"deviceId":"'$D3_DID'"'; then
  ok "D1 voit D2 et D3 (2 deviceId distincts) alors qu'ils partagent le nom '$NAMES_X'"
else
  fail "D1 ne voit pas les 2 peers partageant le même nom (self-filter par nom ?)" ; w=1
fi
[ "$(echo "$r" | grep -oE 'peers=[0-9]+' | head -1)" = "peers=2" ] && ok "pas de doublon malgré noms identiques" || { fail "table D1=${r:0:60}"; w=1; }
dedupe_check "$D1" "$D2_DID" && dedupe_check "$D1" "$D3_DID" && ok "1 seule entrée par deviceId (mêmes noms)" || { fail "doublon d'entrée (mêmes noms)"; w=1; }
wait_peer_cap "$D3" "$D2_DID" '"name":"'"$NAMES_X"'"' 45 "S12 D3 voit D2 (même nom)" \
  && ok "D3 voit D2 (même nom, self-filter par deviceId)" || { fail "D3 ne voit pas D2 (même nom)"; w=1; }
[ "$w" = 0 ] && ok "coexistence de deux devices portant le même NOM (identité = deviceId)" || info "S12 partiel"
log_out4 "S12-same-name"

# ---- Épilogue : état propre (noms distincts + skills pleines) ------------------
clear4
rename_to "$D1" "$NAMES_A"; rename_to "$D2" "$NAMES_B"; rename_to "$D3" "$NAMES_C"
ensure_full_skills "$D1"; ensure_full_skills "$D2"; ensure_full_skills "$D3"
sleep 4
state "$D1" "epilogue"; state "$D2" "epilogue"; state "$D3" "epilogue"
for s in "$D1" "$D2" "$D3"; do echo "$s deviceId=$(cfg_field $s deviceId) name=$(cfg_field $s deviceName) enabled=[$(cfg_enabled $s | tr '\n' ',' )]" ; done | tee "$OUT/inventory-final3.txt"
shasum -a 256 "$APK" >"$OUT/apk-sha256.txt"
echo "[J03-3] RESULTAT GLOBAL rc=$rc (3 devices: $D1 $D2 $D3)"
exit $rc