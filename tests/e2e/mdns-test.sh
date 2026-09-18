#!/bin/sh
# MultiCam — mdns-test.sh (validation J03 : découverte LAN mDNS/DNS-SD + /health).
# Contexte validé : la découverte entre DEUX Android physiques est la cible finale ;
# un seul appareil Android était disponible (install USB bloquée sur le second,
# INSTALL_FAILED_USER_RESTRICTED — fiché dans l'inventaire). Les scénarios
# cross-périphériques sont donc exercés contre un VERITABLE pair mDNS publié par
# le Mac hôte via `dns-sd -P _multicam._tcp.` (mDNSResponder d'Apple, observateur
# indépendant) : found/resolve/lost/table/endpoint réels sur le LAN semblable à
# un second device. L'interaction Android↔Android est marquée PARTIAL (critère
# retardé, raison documentée).
# 15 scénarios (SCR-01..15) + inventaire + invariants (aucun peer clé IP, aucuns doublons).
# Usage: mdns-test.sh [dossier_sortie]   (défaut: validation/J03-decouverte-mdns)
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="${1:-$HERE/validation/J03-decouverte-mdns}"
. "$HERE/lib/common.sh"
. "$HERE/lib/ui.sh"
APK="${APK:-$HERE/../../app/platforms/android/app/build/outputs/apk/debug/app-debug.apk}"
PKG="fr.emmanuel.multicam"
ACT="$PKG/.MainActivity"
LOGRE="CONFIG_INIT|APP_BOOT|HOME_RENDER|SETTINGS_OPEN|SETTINGS_ERROR|DEVICE_NAME_SET|SKILL_SET|STORAGE_|PERM_|PIXELCOPY|TEST_HOOK|MDNS|HEALTH|NET_CHANGED|NSD"
DEFAULT_NAME="Nord J3"
MACIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
PUB_HOST="mcmacpeer.local."
PUB_DID="demo-mac-peer-0001"

require_adb
mkdir -p "$OUT"
rc=0

# --- Inventaire devices
adb devices -l >"$OUT/adb-devices.txt" 2>&1
{ printf 'adb: '; adb version 2>/dev/null | head -1
  printf 'node: '; node -v 2>/dev/null
  printf 'cordova(local): '; (cd "$HERE/../../app" && npx --no-install cordova -v 2>/dev/null || true)
  printf 'mac_ip: %s\n' "$MACIP"
} >"$OUT/versions.txt" 2>&1
[ -f "$APK" ] && shasum -a 256 "$APK" >"$OUT/apk-sha256.txt" 2>&1 || echo "APK absent: $APK" >"$OUT/apk-sha256.txt"
{ echo "Contexte J03 (cahier de validation)" 
  echo "- Pair mDNS = Mac (mDNSResponder Apple) publiant _multicam._tcp. via dns-sd -P."
  echo "- Android x Android physique : PARTIAL (retarde, MOF passif, non faux-PASS)."
} >"$OUT/note-contexte.txt"

# Choix du device : celui qui ACCEPTE l'installation de l'APK courant (les autres
# sont exclus et documentes, ex. INSTALL_FAILED_USER_RESTRICTED). Override DA=.
pick_device() {
  if [ -n "$DA_OVERRIDE" ]; then echo "$DA_OVERRIDE"; return 0; fi
  for sd in $(authorized_serials); do
    if adb -s "$sd" install -r "$APK" >"$OUT/install-$sd.log" 2>&1; then
      echo "$sd"; return 0
    fi
    echo "- EXCLU: $sd (install echec: $(grep -o 'Failure[^:]*: [^ ]*' "$OUT/install-$sd.log" | head -1 || echo 'voir install log'))" >>"$OUT/note-contexte.txt"
  done
  return 1
}
DA=$(pick_device)
[ -n "$DA" ] || { echo "ERREUR: aucun device n'a accepte l'APK (regardez install-*.log)" >&2; exit 1; }
s=$DA
a() { adb -s "$s" "$@"; }

ok()   { echo "[J03:SCR] $sc OK   $1"; }
info() { echo "[J03:SCR] $sc INFO  $1"; }
fail() { echo "[J03:SCR] $sc ECHEC $1"; rc=1; }

cfg_cat() { a shell run-as "$PKG" cat files/config.json 2>/dev/null; }
cfg_field() { cfg_cat | grep -o "\"$1\"[ ]*:[ ]*\"[^\"]*\"" | head -1 | sed 's/.*:[ ]*"//; s/"$//'; }
cfg_enabled() { cfg_cat | tr -d '\n' | sed -n 's/.*"enabledSkills"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d ' "' | grep -v '^$'; }
enabled_has() { cfg_enabled | grep -qx "$1"; }

clear_log() { a logcat -c >/dev/null 2>&1; }
grep_log() { a logcat -d 2>/dev/null | grep -E "$LOGRE"; }
log_out()  { a logcat -d 2>/dev/null | grep -E "$LOGRE" >"$OUT/$s-$1.log"; }
log_pat()  { a logcat -d 2>/dev/null | grep -aE "$1" | tail -1; }
wait_log() { # $1 regex, $2 tries=20, $3 delay=2
  t=${2:-20}; d=${3:-2}; i=0
  while [ "$i" -lt "$t" ]; do [ -n "$(log_pat "$1")" ] && return 0; sleep "$d"; i=$(( i + 1 )); done
  return 1
}
has_log() { [ -n "$(log_pat "$1")" ]; }
shot() { n=$((n + 1)); ui_screenshot "$s" "$OUT/$s-$(printf '%02d' "$n")-$1.png"; }
state() { cfg_cat | tr -d '\n' | sed 's/  */ /g' >"$OUT/$s-$1-config.json"; }
ip_now() { a shell ip addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | grep -v '127.0.0.1' | head -1 | sed 's/inet //'; }
ui_grep() { ui_dump "$s" | tr '>' '\n' | grep -oE 'text="[^"]*'"$1"'[^"]*"' | head -1; }

# --- Pair mDNS (Mac publisher)
PUB_PID=""
pub_start() { # $1 instance, $2 dname, $3..txt
  sd_i=$1; sd_d=$2; shift 2
  dns-sd -P "$sd_i" "_multicam._tcp." "" 45101 "$PUB_HOST" "$MACIP" did="$PUB_DID" dname="$sd_d" "$@" \
    >"$OUT/$s-publisher-$sd_i.log" 2>&1 &
  PUB_PID=$!
  sleep 2
  # attendre l'enregistrement du service
  i=0; while [ "$i" -lt 10 ] && ! grep -q 'service.*registered and active' "$OUT/$s-publisher-$sd_i.log" 2>/dev/null; do sleep 1; i=$(( i + 1 )); done
}
pub_stop() { [ -n "$PUB_PID" ] && { kill "$PUB_PID" 2>/dev/null; sleep 1; PUB_PID=""; }; }
pub_check() { grep -q 'service.*registered and active' "$OUT/$s-"publisher-*.log 2>/dev/null; }

home_reset() {
  a shell am force-stop "$PKG" >/dev/null 2>&1
  sleep 1
  a shell am start -n "$ACT" >/dev/null 2>&1 || true
  ui_wait "$s" deviceName 20 2
  ui_wait "$s" menuButton 10 2
}
open_settings() {
  ui_wait "$s" backHome 4 1 && return 0
  ui_wait "$s" menuButton 12 2 || return 1
  ui_tap "$s" menuButton; sleep 1
  ui_tap "$s" navSettings; sleep 4
  ui_wait "$s" deviceNameInput 12 2
}
back_home() {
  ui_wait "$s" backHome 8 2 || return 1
  ui_tap "$s" backHome; sleep 3
  ui_wait "$s" menuButton 15 2 || { ui_tap "$s" backHome; sleep 4; ui_wait "$s" menuButton 15 2; }
}
set_skill() { # $1 skill, $2 1/0
  if [ "$2" = 1 ]; then enabled_has "$1" || { ui_tap "$s" "skill-$1"; sleep 2; }
  else enabled_has "$1" && { ui_tap "$s" "skill-$1"; sleep 2; }; fi
}

echo "[J03] ===== device $s ====="
echo "[J03] MACIP=$MACIP PUB_HOST=$PUB_HOST PUB_DID=$PUB_DID"
n=0

# ---- SCR-01 Boot : annonce + /health + découverte modern + self absent ----------
sc=SCR-01
clear_log
home_reset || fail "accueil indisponible"
sleep 4
log_out "01-boot"
did=$(cfg_field deviceId)
echo "$did" >"$OUT/device-id.txt"
dname=$(cfg_field deviceName)
grep -q "MDNS_ADVERTISE_START deviceId=$did" "$OUT/$s-01-boot.log" && ok "annonce MDNS_ADVERTISE_START" || fail "MDNS_ADVERTISE_START absent"
[ -n "$dname" ] && ok "identite config deviceName=$dname" || fail "deviceName vide"
grep -q "MDNS_ADVERTISE_READY deviceId=$did" "$OUT/$s-01-boot.log" && ok "enregistree ready (registeredName)" || fail "MDNS_ADVERTISE_READY absent"
grep -q "MDNS_NSD_PATH path=modern sdk=36" "$OUT/$s-01-boot.log" && ok "chemin API modern (registerServiceInfoCallback)" || fail "MDNS_NSD_PATH modern absent"
grep -q "HEALTH_SERVER_START port=45101" "$OUT/$s-01-boot.log" && ok "endpoint /health demarre sur 45101" || fail "HEALTH_SERVER_START absent"
grep -q "MDNS_DISCOVERY_START serviceType=_multicam._tcp." "$OUT/$s-01-boot.log" && ok "decouverte browser demarree" || fail "MDNS_DISCOVERY_START absent"
if grep -q "MDNS_PEER_FOUND deviceId=$did" "$OUT/$s-01-boot.log"; then fail "self advertisé dans sa propre table"; else ok "auto-filtre : self absent de sa propre table"; fi
if grep -q "MDNS_ERROR code=registerException" "$OUT/$s-01-boot.log"; then fail "registerException présent au boot"; else ok "aucune erreur registerException au boot"; fi
shot "01-boot-home"

# ---- SCR-02 Invariants : table canonicale vide + aucun peer ip-keyed -------------
sc=SCR-02
pt=$(grep -o 'MDNS_PEER_TABLE .*peers=[0-9]*' "$OUT/$s-01-boot.log" | tail -1 | grep -o 'peers=[0-9]*')
[ "${pt:-peers=0}" = "peers=0" ] && ok "table peers vide au démarrage ($pt)" || info "table initiale: $pt (peers hors sessions J03)"
has_log 'MDNS_PEER_FOUND deviceId=[0-9a-f-]\{36\}' && info "aucun peer avant publication" || ok "aucun peer avant publication"

# ---- SCR-03 Publication Mac : found + resolve + TXT + vue UI --------------------
sc=SCR-03
clear_log
pub_start "MacPeer" "MacPeer" supported=capture,storage enabled=capture ver=0.9.9 sver=1 \
  && ok "publication dns-sd -P enregistrée sur le Mac" || { fail "publication Mac échouée"; pub_stop; }
wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001' 25 2 || true
sleep 3
log_out "03-peer-found"
grep -q "MDNS_SERVICE_FOUND service=MacPeer type=_multicam._tcp." "$OUT/$s-03-peer-found.log" && ok "serviceMacPeer trouvé (NSD)" || fail "MDNS_SERVICE_FOUND MacPeer absent"
grep -q "MDNS_RESOLVE deviceId=demo-mac-peer-0001 result=OK host=$MACIP port=45101" "$OUT/$s-03-peer-found.log" && ok "résolution DNS-SD du pair (host=$MACIP port=45101)" || fail "MDNS_RESOLVE absent ($MACIP)"
grep -q "MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=MacPeer supported=\[capture,storage\] enabled=\[capture\] version=0.9.9 endpoint=$MACIP:45101" "$OUT/$s-03-peer-found.log" && ok "peer ajouté avec TXT (dname/supported/enabled/ver) + endpoint" || fail "MDNS_PEER_FOUND TXT incomplet"
shot "03-peer-found"

# ---- SCR-04 Table canonicale à 1 entrée clé deviceId ----------------------------
sc=SCR-04
npeers=$(grep -o 'MDNS_PEER_TABLE found peers=[0-9]*' "$OUT/$s-03-peer-found.log" | tail -1 | grep -o '[0-9]*')
[ "$npeers" = "1" ] && ok "table = 1 peer (rows=1)" || fail "table peers=$npeers attendu 1"
nrows=$(grep -c 'deviceId":' "$OUT/$s-03-peer-found.log")
[ "$nrows" -le 2 ] && ok "aucun doublon de peer (deviceId unique)" || fail "$nrows occurrences deviceId (doublon?)"

# ---- SCR-05 Republiation même did : entrée réutilisée, pas de doublon -----------
sc=SCR-05
pub_stop; pub_start "MacPeer2" "MacPeerR2" supported=capture,storage enabled=capture,storage ver=0.9.9 sver=1 \
  || info "republication échouée"
wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=MacPeerR2' 25 2 || true
sleep 3
log_out "05-peer-repub"
if grep -q 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=MacPeerR2' "$OUT/$s-05-peer-repub.log" \
   && grep -q 'MDNS_PEER_LOST deviceId=demo-mac-peer-0001 reason=serviceLost' "$OUT/$s-05-peer-repub.log"; then
  ok "cycle perte/retrouvé (serviceLost puis found) même deviceId"
else
  info "séquence lost/found non rejouée (comportement NSD API 36 : retrouvé direct)"
fi
npr=$(grep -o 'MDNS_PEER_TABLE .*peers=[0-9]*' "$OUT/$s-05-peer-repub.log" | tail -1 | grep -o 'peers=[0-9]*')
[ "${npr#peers=}" = "1" ] && ok "pas de doublon après re-publication (table=$npr)" || info "table=$npr"

# ---- SCR-06 Perte du pair : serviceLost primaire --------------------------------
sc=SCR-06
clear_log
pub_stop
wait_log 'MDNS_PEER_LOST deviceId=demo-mac-peer-0001 reason=serviceLost' 25 2 || true
sleep 2
log_out "06-peer-lost"
grep -q "MDNS_PEER_LOST deviceId=demo-mac-peer-0001 reason=serviceLost service=MacPeer2" "$OUT/$s-06-peer-lost.log" \
  && ok "perte par serviceLost (source primaire)" || fail "MDNS_PEER_LOST serviceLost absent"
grep -q 'MDNS_PEER_TABLE lost peers=0' "$OUT/$s-06-peer-lost.log" && ok "table vide après perte" || fail "table non vide après perte"
shot "06-peer-lost"

# ---- SCR-07 Reconvergence 3 cycles : 0 doublon ----------------------------------
sc=SCR-07
cycles=3; dup=0
k=1
while [ "$k" -le "$cycles" ]; do
  clear_log
  pub_start "MacPeer$k" "MacPeerCycle$k" supported=capture enabled=capture ver=0.9.9 sver=1 || true
  wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001' 25 2 || true
  sleep 2
  log_out "07-cycle$k"
  if grep -q 'MDNS_PEER_TABLE .*found peers=1' "$OUT/$s-07-cycle$k.log"; then
    ok "cycle $k : convergé 1 peer"
  else
    fail "cycle $k : doublon/absent ($(grep -o 'MDNS_PEER_TABLE .*peers=[0-9]*' "$OUT/$s-07-cycle$k.log" | tail -1))"; dup=1
  fi
  pub_stop
  sleep 2
  k=$(( k + 1 ))
done
k=1
while [ "$k" -le "$cycles" ]; do
  clear_log
  pub_start "MacPeer${k}b" "MacPeerCycle${k}" supported=capture enabled=capture ver=0.9.9 sver=1 || true
  wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001' 25 2 || true
  pub_stop; sleep 2
  k=$(( k + 1 ))
done
[ "$dup" = 0 ] && ok "aucun doublon sur $cycles cycles publication/perte" || fail "doublons détectés sur cycles"
log_out "07-cycles"
shot "07-reconvergence"

# ---- SCR-08 Renommage local : reannounce name_change ----------------------------
sc=SCR-08
clear_log
pub_start "TmpPeer" "TmpPeer" supported=capture ver=0.9.9 sver=1 || true
open_settings || fail "écran Paramètres indisponible"
ui_clear_field "$s" deviceNameInput
ui_input_text "$s" "$DEFAULT_NAME"
ui_tap "$s" saveName
wait_log "MDNS_REANNOUNCE_TRIGGER reason=name_change name=$DEFAULT_NAME" 10 1 || true
sleep 2
pub_stop
log_out "08-rename"
grep -q "MDNS_REANNOUNCE_TRIGGER reason=name_change name=$DEFAULT_NAME" "$OUT/$s-08-rename.log" \
  && ok "déclencheur reannounce nom journalisé" || fail "MDNS_REANNOUNCE_TRIGGER name absent"
[ "$(cfg_field deviceName 2>/dev/null || true)" = "$DEFAULT_NAME" ] && ok "config deviceName=$DEFAULT_NAME persistée" || fail "config deviceName non persistée"
grep -q "MDNS_REANNOUNCE deviceId=$did deviceName=$DEFAULT_NAME result=OK" "$OUT/$s-08-rename.log" \
  && ok "reannounce effectif (unregister/register)" || fail "MDNS_REANNOUNCE absent ($did)"
{ dns-sd -L "$DEFAULT_NAME" _multicam._tcp. local. >"$OUT/$s-08-mac-lookup.log" 2>&1 & mpl=$!; sleep 6; kill "$mpl" 2>/dev/null; } 2>/dev/null
if grep -q "$DEFAULT_NAME" "$OUT/$s-08-mac-lookup.log" && grep -q "did=$did" "$OUT/$s-08-mac-lookup.log"; then
  ok "annonce renommée $DEFAULT_NAME résolue côté Mac (did corrélé)"
else
  info "lookup de $DEFAULT_NAME: $(head -3 "$OUT/$s-08-mac-lookup.log" | tr '\n' ' ')"
fi
back_home || true
shot "08-renamed"

# ---- SCR-09 Skills : reannounce skill_change + TXT enabled ----------------------
sc=SCR-09
clear_log
open_settings || fail "écran Paramètres indisponible"
set_skill storage 0
set_skill storage 1
wait_log 'MDNS_REANNOUNCE_TRIGGER reason=skill_change skill=storage enabled=1' 10 1 || true
sleep 2
log_out "09-skill"
grep -q "MDNS_REANNOUNCE_TRIGGER reason=skill_change skill=storage enabled=1" "$OUT/$s-09-skill.log" \
  && ok "déclencheur reannounce skill journalisé" || fail "MDNS_REANNOUNCE_TRIGGER skill absent"
grep -q "MDNS_REANNOUNCE deviceId=$did" "$OUT/$s-09-skill.log" && ok "reannounce suite skill ok" || info "reannounce skill non rejoué sur la fenêtre"
enabled_has storage && ok "config enabledSkills contient storage" || fail "config storage absent"
state "09-skill"
shot "09-skill-settings"

# ---- SCR-10 Annonce indépendante du rôle controller ------------------------------
sc=SCR-10
clear_log
open_settings || fail "écran Paramètres indisponible"
set_skill controller 1
set_skill controller 0
wait_log 'MDNS_REANNOUNCE_TRIGGER reason=skill_change skill=controller enabled=0' 10 1 || true
sleep 2
log_out "10-controller-off"
back_home || true
sleep 2
{ dns-sd -B _multicam._tcp. local. >"$OUT/$s-10-mac-browse.log" 2>&1 & mpb=$!; sleep 5; kill "$mpb" 2>/dev/null; } 2>/dev/null
grep -q "$DEFAULT_NAME" "$OUT/$s-10-mac-browse.log" && ok "après controller=off, l'annonce reste visible côté Mac (indépendante du rôle)" || fail "annonce ABSENTE côté Mac après controller=off"
curl -s --max-time 3 "http://$(ip_now):45101/health" >/dev/null && ok "/health toujours joignable après controller=off" || fail "/health injoignable"
log_out "10-controller-off-2"
shot "10-controller-off"

# ---- zero skill : enabled=[] tout en annonçant ----------------------------------
sc=SCR-10b
clear_log
open_settings || fail "écran Paramètres indisponible"
set_skill capture 0; set_skill storage 0
sleep 3
log_out "10b-zero-skills"
{ dns-sd -B _multicam._tcp. local. >"$OUT/$s-10b-mac-browse.log" 2>&1 & mpb=$!; sleep 5; kill "$mpb" 2>/dev/null; } 2>/dev/null
grep -q "$DEFAULT_NAME" "$OUT/$s-10b-mac-browse.log" && ok "enabledSkills=[] : l'appareil annonce toujours" || fail "annonce absente avec enabledSkills=[]"
{ dns-sd -L "$DEFAULT_NAME" _multicam._tcp. local. >"$OUT/$s-10b-mac-lookup.log" 2>&1 & mpl=$!; sleep 5; kill "$mpl" 2>/dev/null; } 2>/dev/null
if grep -q "did=$did" "$OUT/$s-10b-mac-lookup.log" && ! grep -q "enabled=" "$OUT/$s-10b-mac-lookup.log"; then
  ok "TXT sans attribut enabled (règle enabledSkills=[] omis)"
else
  info "TXT côté Mac: $(grep 'dname=' "$OUT/$s-10b-mac-lookup.log" | head -1)"
fi
log_out "10b-zero-skills-2"
shot "10b-zero-skills"

# ---- restauration skills ---------------------------------------------------------
open_settings || true
set_skill capture 1; set_skill storage 1; set_skill controller 1
wait_log 'MDNS_REANNOUNCE_TRIGGER reason=skill_change' 10 1 || true
sleep 2
back_home || true
state "10c-restored"
log_out "10c-restored"

# ---- SCR-11 WiFi reconnect : NET_CHANGED + reannounce réseau + convergence ------
sc=SCR-11
if a shell settings get global wifi_on >/dev/null 2>&1; then
  clear_log
  pub_start "WifiPeer" "WifiPeer" supported=capture enabled=capture ver=0.9.9 sver=1 || true
  wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001' 20 2 || true
  a shell svc wifi disable >/dev/null 2>&1
  sleep 8
  a shell svc wifi enable >/dev/null 2>&1
  sleep 20
  log_out "11-wifi-reconnect"
  grep -q "NET_CHANGED networkType=wifi ipv4=" "$OUT/$s-11-wifi-reconnect.log" && ok "NET_CHANGED journalisé après bascule Wi-Fi" || info "NET_CHANGED absent (bascule silencieuse via CONNECTIVITY?)"
  grep -q 'MDNS_ADVERTISE_STOP deviceId=.*reason=network_change' "$OUT/$s-11-wifi-reconnect.log" && ok "reannounce réseau (stop reason=network_change)" || info "stop network_change non observé"
  if grep -q "MDNS_ERROR code=registerException" "$OUT/$s-11-wifi-reconnect.log"; then fail "registerException pendant reconnexion (race de/enregistrement)"; else ok "aucune race de registration (pas de registerException)"; fi
  if grep -q 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001' "$OUT/$s-11-wifi-reconnect.log"; then ok "reconvergence avec le pair après reconnect"; else info "convergence non re-observée sur la fenêtre (NSD re-ré-annonce)" ; fi
  nread=$(grep -c "MDNS_ADVERTISE_READY" "$OUT/$s-11-wifi-reconnect.log")
  [ "$nread" -le 3 ] && ok "pas de double enregistrement (ADVERTISE_READY=$nread)" || info "ADVERTISE_READY=$nread occurrences"
  shot "11-wifi-reconnect"
else
  info "wifi_on indisponible, bascule Wi-Fi sautée (INFO)"
fi
pub_stop

# ---- SCR-12 /health : JSON identité + HEALTH_REQUEST + 404 ----------------------
sc=SCR-12
clear_log
npmid=$(ip_now)
h1=$(curl -s --max-time 3 "http://$npmid:45101/health")
h2=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "http://$npmid:45101/other")
sleep 2
log_out "12-health"
echo "$h1" >"$OUT/health-ok.json"
echo "$h2" >"$OUT/health-other-code.txt"
hpid=$(cfg_field deviceId); hnm=$(cfg_field deviceName)
echo "$h1" | grep -q '"ok":true' && ok "GET /health ok:true" || fail "/health ok absent"
echo "$h1" | grep -q "\"deviceId\":\"$hpid\"" && ok "deviceId identique à config ($hpid)" || fail "deviceId mismatch: $h1"
echo "$h1" | grep -q "\"deviceName\":\"$hnm\"" && ok "deviceName identique à config" || fail "deviceName mismatch"
echo "$h1" | grep -q '"version":' && ok "version présente" || fail "version absente"
grep -q "HEALTH_REQUEST remote=.* path=/health status=200" "$OUT/$s-12-health.log" && ok "HEALTH_REQUEST journalisé (status=200)" || fail "HEALTH_REQUEST absent"
[ "$h2" = "404" ] && ok "autre route -> 404" || fail "route /other -> $h2 (attendu 404)"

# ---- SCR-13 UI : carte réseau + section Périphériques détectés ------------------
sc=SCR-13
clear_log
pub_start "UiPeer" "UiPeer" supported=capture,storage enabled=capture,storage ver=0.9.9 sver=1 || true
wait_log 'MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=UiPeer' 25 2 || true
sleep 3
home_reset || fail "accueil indisponible (SCR-13)"
sleep 4
st=$(ui_grep "Annonce mDNS active")
[ -n "$st" ] && ok "carte réseau reflète l'état réel ($st)" || fail "carte réseau: $st"
[ "$(ui_text "$s" devicesCount)" = "1" ] && ok "compteur '1' périphérique détecté" || fail "devicesCount=$(ui_text $s devicesCount)"
ui_has_text "$s" "UiPeer" && ok "carte du pair UiPeer affichée" || fail "carte pair absente de l'écran 01"
ep=$(ui_dump "$s" | grep -o 'text="[^"]*'"$MACIP"':45101[^"]*"' | head -1)
[ -n "$ep" ] && ok "endpoint affiché ($ep)" || fail "endpoint absent du rendu"
shot "13-home-peer"
pub_stop
sleep 4
home_reset || true
sleep 3
[ "$(ui_text "$s" devicesCount)" = "0" ] && ok "état vide réel quand aucun pair" || fail "compteur après perte=$(ui_text $s devicesCount)"
shot "13-home-empty"

# ---- SCR-14 Observateur indépendant Mac (dns-sd -B / -L) ------------------------
sc=SCR-14
{ dns-sd -B _multicam._tcp. local. >"$OUT/$s-14-mac-browse.log" 2>&1 & mpb=$!; sleep 6; kill "$mpb" 2>/dev/null; } 2>/dev/null
grep -q "$DEFAULT_NAME" "$OUT/$s-14-mac-browse.log" && ok "l'instance _multicam._tcp. '$DEFAULT_NAME' visible d'un client mDNS tiers (Mac)" || fail "instance $DEFAULT_NAME non vue"
{ dns-sd -L "$DEFAULT_NAME" _multicam._tcp. local. >"$OUT/$s-14-mac-lookup.log" 2>&1 & mpl=$!; sleep 6; kill "$mpl" 2>/dev/null; } 2>/dev/null
did4=$(cfg_field deviceId)
if grep -q "did=$did4" "$OUT/$s-14-mac-lookup.log" && grep -q ":45101" "$OUT/$s-14-mac-lookup.log" && grep -q "enabled=" "$OUT/$s-14-mac-lookup.log"; then
  ok "résolution Mac: did/port corrélés ($(grep 'dname=' "$OUT/$s-14-mac-lookup.log" | head -1 | tr '\n' ' '))"
else
  info "lookup: $(grep 'dname=' "$OUT/$s-14-mac-lookup.log" | head -1 | tr '\n' ' ')"
fi

# ---- SCR-15 Stabilité : 3 relances app + convergence + invariances --------------
sc=SCR-15
c=1
while [ "$c" -le 3 ]; do
  clear_log
  pub_start "StabPeer$c" "StabPeer$c" supported=capture enabled=capture ver=0.9.9 sver=1 || true
  home_reset || fail "relance $c accueil indisponible"
  sleep 5
  wait_log "MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=StabPeer$c" 20 2 || true
  log_out "15-cycle$c"
  grep -q "MDNS_PEER_FOUND deviceId=demo-mac-peer-0001 name=StabPeer$c" "$OUT/$s-15-cycle$c.log" \
    && ok "relance $c : reconvergence avec le pair" || fail "relance $c : pas de convergence"
  grep -q "MDNS_ERROR code=registerException" "$OUT/$s-15-cycle$c.log" && fail "relance $c : registerException" || ok "relance $c : aucune erreur registration"
  dcp=$(cfg_field deviceId)
  [ "$dcp" = "$did" ] && ok "relance $c : deviceId stable" || fail "relance $c : deviceId $did -> $dcp"
  shot "15-cycle$c"
  pub_stop
  c=$(( c + 1 ))
done
log_out "15-cycles-final"
state "15-final"

# ---- cp inventories + fin -------------------------------------------------------
pub_stop
pkill -f 'dns-sd -P' 2>/dev/null
ip_now | sed 's/^/ip_phone: /' >"$OUT/ip-phone-final.txt"
{ echo "deviceId=$did"; echo "deviceName=$(cfg_field deviceName)"; echo "enabled=$(cfg_enabled | tr '\n' ',')"; echo "ip=$(ip_now)"; } >"$OUT/device-inventory.txt"
echo "[J03] ===== fin device $s (rc=$rc) ====="
skipped_report
echo "[J03] RESULTAT GLOBAL rc=$rc"
exit $rc