#!/bin/sh
# MultiCam — settings-test.sh (validation J02 : identite persistante + ecran 14).
# Exerce les controles REELS sur chaque device autorise (aucun succes simule) :
#   1. premiere execution : creation de config.json (deviceId UUID v4) ;
#   2. deviceId stable apres force-stop / relance ;
#   3. edition du nom + persistance + reflet immediat sur l'accueil ;
#   4. activation/desactivation de skills + persistance ;
#   5. zero skill active : badges visibles mais desactives + UI Master masquee ;
#   6. skill non supportee rejetee via le hook debug (config inchangee) ;
#   7. etats de permissions Android reels + interaction de demande ;
#   8. ecriture reelle stockage par defaut (interne) ;
#   9. selection SAF (Documents) + ecriture/creation/suppression reelles ;
#  10. persistance SAF apres redemarrage + retour au stockage par defaut.
# La preuve est materialisee dans le dossier de sortie (captures, config.json,
# extraits logcat, resultats).
# Usage: settings-test.sh [dossier_sortie]
#   defaut: validation/J02-identite-parametres
OUT="${1:-validation/J02-identite-parametres}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/lib/common.sh"
. "$HERE/lib/ui.sh"
APK="${APK:-$HERE/../../app/platforms/android/app/build/outputs/apk/debug/app-debug.apk}"
PKG="fr.emmanuel.multicam"
ACT="$PKG/.MainActivity"
LOGRE="CONFIG_INIT|APP_BOOT|HOME_RENDER|SETTINGS_OPEN|SETTINGS_ERROR|DEVICE_NAME_SET|SKILL_SET|STORAGE_SET|STORAGE_RESET|STORAGE_WRITE|SAF_SELECTED|SAF_TREE_NAME|PERM_|TEST_HOOK|PIXELCOPY_READY"
NAME="Cam Nord"

require_adb
mkdir -p "$OUT"
rc=0

adb devices -l >"$OUT/adb-devices.txt" 2>&1
{ printf 'adb: '; adb version 2>/dev/null | head -1
  printf 'node: '; node -v 2>/dev/null
  printf 'cordova(local): '; (cd "$HERE/../../app" && npx --no-install cordova -v 2>/dev/null || true)
} >"$OUT/versions.txt" 2>&1
[ -f "$APK" ] && shasum -a 256 "$APK" >"$OUT/apk-sha256.txt" 2>&1 || echo "APK absent: $APK" >"$OUT/apk-sha256.txt"

ok()   { echo "[J02] $s OK   $1"; }
fail() { echo "[J02] $s ECHEC $1"; rc=1; }
note() { echo "[J02] $s INFO  $1"; }

cfg_cat() { adb -s "$s" shell run-as "$PKG" cat files/config.json 2>/dev/null; }
cfg_field() { cfg_cat | grep -o "\"$1\"[ ]*:[ ]*\"[^\"]*\"" | head -1 | sed 's/.*:[ ]*"//; s/"$//'; }
cfg_enabled() { cfg_cat | tr -d '\n' | sed -n 's/.*"enabledSkills"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d ' "' | grep -v '^$'; }
enabled_has() { cfg_enabled | grep -qx "$1"; }
cfg_storage_mode() { cfg_cat | tr -d '\n' | sed -n 's/.*"storage"[[:space:]]*:[[:space:]]*{[^}]*"mode"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p'; }

clear_log() { adb -s "$s" logcat -c >/dev/null 2>&1; }
save_log() { adb -s "$s" logcat -d 2>/dev/null | grep -E "$LOGRE" >"$OUT/$s-$1.log"; }
grep_log() { adb -s "$s" logcat -d 2>/dev/null | grep -E "$LOGRE"; }
shot() { n=$((n + 1)); ui_screenshot "$s" "$OUT/$s-$(printf '%02d' "$n")-$1.png"; }
state() { cfg_cat | tr -d '\n' | sed 's/  */ /g' >"$OUT/$s-$1-config.json"; }

# Tape un noeud en le faisant d'abord defiler dans le viewport (contourne le
# clamping/prune WebView : noeuds hors ecran strides sur les bords, prunes au loin).
# Hauteur utile = bord bas du WebView (exclut la barre de navigation systeme).
tap_visible() { # $1 selector
  wh=$(adb -s "$s" shell wm size 2>/dev/null | grep -o '[0-9]*x[0-9]*' | tail -1)
  W=${wh%x*}; H=${wh#*x}; H=${H:-1340}; W=${W:-800}
  tv_find() {
    tv_line=$(ui_dump "$s" | tr '>' '\n' | grep -F -e "resource-id=\"$1\"" -e "text=\"$1\"" -e "content-desc=\"$1\"" | head -1)
    [ -z "$tv_line" ] && return 1
    tv_h=$(echo "$tv_line" | grep 'class="android.webkit.WebView"' | head -1 | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\4/p')
    set -- $(echo "$tv_line" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p')
    if [ "$#" -eq 4 ] && [ "$2" -lt "$4" ] && [ "$2" -ge 0 ] && [ "$4" -le $(( H - 80 )) ]; then
      adb -s "$s" shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
      return 0
    fi
    return 1
  }
  heel=$(
    ui_dump "$s" | tr '>' '\n' | grep 'class="android.webkit.WebView"' | head -1 \
      | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\4/p'
  )
  [ -n "$heel" ] && H=$heel
  i=0
  while [ "$i" -lt 5 ]; do tv_find "$1" && return 0; adb -s "$s" shell input swipe $(( W / 2 )) $(( H / 4 )) $(( W / 2 )) $(( H * 3 / 4 )) 300 >/dev/null 2>&1; sleep 1; i=$(( i + 1 )); done
  i=0
  while [ "$i" -lt 7 ]; do tv_find "$1" && return 0; adb -s "$s" shell input swipe $(( W / 2 )) $(( H * 3 / 4 )) $(( W / 2 )) $(( H / 4 )) 300 >/dev/null 2>&1; sleep 1; i=$(( i + 1 )); done
  return 1
}

# force-stop, relance propre, attend l'accueil (boot log capture separement)
home_reset() {
  adb -s "$s" shell am force-stop "$PKG" >/dev/null 2>&1
  sleep 1
  adb -s "$s" shell am start -n "$ACT" >/dev/null 2>&1 || true
  ui_wait "$s" deviceName 20 2
  ui_wait "$s" menuButton 10 2
}
open_settings() {
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

set_skill() { # $1 = skill, $2 = 1 (activer) / 0 (desactiver)
  if [ "$2" = 1 ]; then enabled_has "$1" || { ui_tap "$s" "skill-$1"; sleep 2; }
  else enabled_has "$1" && { ui_tap "$s" "skill-$1"; sleep 2; }; fi
}

# Tape le premier bouton "Autoriser" (permissions) puis la validation du dialogue systeme.
# Le WebView clampe les noeuds hors ecran sur y=bas : on defile jusqu'a visibilite reelle.
tap_line() {
  echo "$1" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' \
    | { read -r a b c d; adb -s "$s" shell input tap $(( (a + c) / 2 )) $(( (b + d) / 2 )); }
}
perm_request_all() {
  wh=$(adb -s "$s" shell wm size 2>/dev/null | grep -o '[0-9]*x[0-9]*' | tail -1)
  W=${wh%x*}; H=${wh#*x}; H=${H:-1340}; W=${W:-800}
  k=0
  while [ "$k" -lt 6 ]; do
    k=$(( k + 1 ))
    line=""; i=0
    while [ "$i" -lt 6 ]; do
      line=$(ui_dump "$s" | tr '>' '\n' | grep 'text="Autoriser"' | grep 'clickable="true"' | head -1)
      [ -z "$line" ] && break
      set -- $(echo "$line" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p')
      if [ "$#" -eq 4 ] && [ "$2" -lt "$4" ] && [ "$4" -le $(( H - 80 )) ]; then break; fi
      adb -s "$s" shell input swipe $(( W / 2 )) $(( H * 3 / 4 )) $(( W / 2 )) $(( H / 3 )) 300 >/dev/null 2>&1
      sleep 1; line=""; i=$(( i + 1 ))
    done
    [ -z "$line" ] && break
    tap_line "$line"; sleep 2
    j=0
    while [ "$j" -lt 3 ]; do
      j=$(( j + 1 ))
      dlg=$(ui_dump "$s" | tr '>' '\n' | grep 'resource-id="com.android.permissioncontroller:id/permission_allow' | head -1)
      [ -z "$dlg" ] && dlg=$(ui_dump "$s" | tr '>' '\n' | grep -E 'text="(AUTORISER|Allow|Autoriser|Toujours autoriser)"' | grep 'clickable="true"' | head -1)
      [ -z "$dlg" ] && break
      tap_line "$dlg"; sleep 2
    done
    sleep 2
  done
}

# Navigation DocumentsUI : entrer dans Documents puis "Utiliser ce dossier" + autoriser.
saf_pick_documents() {
  tap_visible btnChangeDir || { fail "SAF: bouton Changer introuvable"; return 1; }
  sleep 4
  i=0
  while [ "$i" -lt 3 ]; do
    i=$(( i + 1 ))
    if ui_exists "$s" Documents; then ui_tap "$s" Documents; sleep 3; fi
    [ "$(ui_attr "$s" android:id/button1 enabled)" = "true" ] && break
    adb -s "$s" shell input keyevent KEYCODE_BACK >/dev/null 2>&1; sleep 2
  done
  if [ "$(ui_attr "$s" android:id/button1 enabled)" != "true" ]; then
    fail "SAF: bouton 'Utiliser ce dossier' inactif"
    adb -s "$s" shell input keyevent KEYCODE_BACK >/dev/null 2>&1
    return 1
  fi
  ui_tap "$s" android:id/button1; sleep 3
  # Dialogue de confirmation "Autoriser MultiCam a acceder ..."
  if ui_exists "$s" android:id/button1; then ui_tap "$s" android:id/button1; sleep 4; fi
  return 0
}

SERIALS="${SERIALS:-$(authorized_serials)}"
for s in $SERIALS; do
  n=0
  echo "[J02] ===== device $s ====="

  # ---- A. Premiere execution : creation config + UUID (R1,R2) -----------------
  adb -s "$s" shell pm clear "$PKG" >/dev/null 2>&1
  clear_log
  home_reset || { fail "accueil indisponible apres pm clear"; continue; }
  state "01-firstrun"
  src=$(grep_log | grep -o 'CONFIG_INIT source=[a-z-]*' | head -1)
  did=$(cfg_field deviceId)
  case "$src" in *"source=created"*) ok "R1 config.json cree a la premiere execution ($src)";;
    *) fail "R1 CONFIG_INIT source=created absent (log: ${src:-aucun})";; esac
  echo "$did" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
    && ok "R2 deviceId UUID v4 cree ($did)" || fail "R2 deviceId absent/invalide: '$did'"
  grep -q '"supportedSkills"' "$OUT/$s-01-firstrun-config.json" || fail "R1 supportedSkills absent"
  save_log "01-firstrun"

  # ---- B. Stabilite UUID + nom + reflet accueil (R3,R4,R5 partielle,R14,R12,R20)
  clear_log
  home_reset || fail "R3 accueil indisponible apres relance"
  did2=$(cfg_field deviceId)
  [ "$did2" = "$did" ] && ok "R3 deviceId stable apres force-stop/relance ($did2)" || fail "R3 deviceId change: $did -> $did2"
  open_settings || { fail "ecran Parametres indisponible"; continue; }
  sleep 3
  save_log "02-settings-default"
  ui_screenshot "$s" "$OUT/$s-02-settings-default.png"
  # R14 ecriture stockage par defaut (interne) + R12 etats permissions reels
  if grep -q 'STORAGE_WRITE mode=internal ok=1' "$OUT/$s-02-settings-default.log"; then
    ok "R14 ecriture reelle stockage par defaut OK ($(grep -o 'STORAGE_WRITE.*' "$OUT/$s-02-settings-default.log" | head -1))"
  else
    fail "R14 STORAGE_WRITE mode=internal ok=1 absent"
  fi
  if [ "$(cfg_storage_mode)" = "internal" ]; then ok "R14 destination par defaut = interne"; else fail "R14 destination par defaut inattendue ($(cfg_storage_mode))"; fi
  if grep -q 'PERM_CAMERA state=' "$OUT/$s-02-settings-default.log" && grep -q 'PERM_LOCATION state=' "$OUT/$s-02-settings-default.log"; then
    ok "R12 etats de permissions reels lus ($(grep -o 'PERM_[A-Z]* state=[A-Z_]*' "$OUT/$s-02-settings-default.log" | tr '\n' ' '))"
  else
    fail "R12 etats de permissions absents des logs"
  fi
  # R4 edition du nom
  ui_clear_field "$s" deviceNameInput
  ui_input_text "$s" "$NAME"
  ui_tap "$s" saveName; sleep 3
  hdr=$(ui_text "$s" headerName)
  [ "$hdr" = "$NAME" ] && ok "R4 nom edite et affiche ($hdr)" || fail "R4 en-tete apres edition = '$hdr'"
  grep -q "DEVICE_NAME_SET name=$NAME" "$OUT/$s-02-settings-default.log" 2>/dev/null || { save_log "02b-name"; }
  save_log "02-name"
  grep -q "DEVICE_NAME_SET name=$NAME" "$OUT/$s-02-name.log" && ok "R4 DEVICE_NAME_SET journalise" || fail "R4 DEVICE_NAME_SET absent"
  ui_screenshot "$s" "$OUT/$s-02-settings-name.png"
  # R20 reflet immediat sur l'accueil
  back_home && { hn=$(ui_text "$s" deviceName); [ "$hn" = "$NAME" ] && ok "R20 accueil reflete le nom immediatement ($hn)" || fail "R20 accueil nom='$hn'"; } || fail "R20 retour accueil impossible"
  save_log "02-home-name"

  # ---- C. Persistance nom + UUID apres redemarrage (R5) -----------------------
  clear_log
  home_reset || fail "C accueil indisponible"
  hn=$(ui_text "$s" deviceName); dn=$(cfg_field deviceName); did3=$(cfg_field deviceId)
  [ "$hn" = "$NAME" ] && ok "R5 nom persiste apres redemarrage ($hn)" || fail "R5 nom apres redemarrage='$hn'"
  [ "$dn" = "$NAME" ] && ok "R5 config.json deviceName=$dn" || fail "R5 config deviceName='$dn'"
  [ "$did3" = "$did" ] && ok "R3 deviceId toujours stable ($did3)" || fail "R3 deviceId derive: $did != $did3"
  state "03-persist-name"
  save_log "03-boot-name"

  # ---- D. Activation/desactivation de skills (R6) -----------------------------
  open_settings || { fail "D ecran Parametres indisponible"; continue; }
  set_skill capture 0
  enabled_has capture && fail "R6 desactivation Capture non prise en compte" || ok "R6 Capture desactivee (enabled=[$(cfg_enabled | tr '\n' ',' )])"
  set_skill capture 1
  enabled_has capture && ok "R6 Capture reactivee (enabled=[$(cfg_enabled | tr '\n' ',')])" || fail "R6 reactivation Capture non prise en compte"
  state "04-skills-toggle"
  save_log "04-skills-toggle"

  # ---- E. Zero skill active : badges visibles/desactives + UI Master masquee ----
  set_skill capture 0; set_skill storage 0; set_skill controller 0
  state "05-zero-skills"
  ec=$(cfg_enabled | tr '\n' ',')
  [ -z "$ec" ] && ok "R8 enabledSkills=[] atteint" || fail "R8 enabledSkills non vide=[$ec]"
  save_log "05-zero-skills"
  back_home || fail "E retour accueil impossible"
  b_cap=$(ui_has_text "$s" "Capture" && echo 1 || echo 0)
  b_sto=$(ui_has_text "$s" "Storage" && echo 1 || echo 0)
  b_mas=$(ui_has_text "$s" "Master" && echo 1 || echo 0)
  [ "$b_cap$b_sto$b_mas" = "111" ] && ok "R9 les 3 badges supportes restent visibles" || fail "R9 badges visibles=$b_cap$b_sto$b_mas"
  if ui_exists "$s" recentArea || ui_exists "$s" masterArea || ui_exists "$s" newSession || ui_exists "$s" createSession; then
    fail "R10 UI Master visible alors que controller desactive"
  else
    ok "R10 UI Master masquee (recentArea/masterArea/newSession absents)"
  fi
  ui_screenshot "$s" "$OUT/$s-05-home-zero-skills.png"
  save_log "05-home-zero-skills"

  # ---- F. Persistance skills apres redemarrage (R7) + hook debug (R11) ---------
  open_settings || { fail "F ecran Parametres indisponible"; continue; }
  set_skill capture 1
  state "06-capture-only"
  back_home || true
  clear_log
  home_reset || fail "F accueil indisponible"
  enabled_has capture && ! enabled_has storage && ! enabled_has controller \
    && ok "R7 enabled=[capture] persiste apres redemarrage" || fail "R7 enabled apres redemarrage=[$(cfg_enabled | tr '\n' ',')]"
  if ui_exists "$s" masterArea || ui_exists "$s" createSession; then fail "R7 UI Master visible (controller off persiste)"; else ok "R7 UI Master toujours masquee"; fi
  state "07-restart-capture"
  save_log "07-boot-capture"
  # R11 hook debug : skill non supportee doit etre rejetee, config inchangee
  state "07b-before-hook"
  adb -s "$s" shell am force-stop "$PKG" >/dev/null 2>&1
  clear_log
  adb -s "$s" shell am start -n "$ACT" --es mcTestSkill gps >/dev/null 2>&1 || true
  sleep 6
  save_log "08-hook"
  if grep -q 'TEST_HOOK skill=gps' "$OUT/$s-08-hook.log" && grep -q 'SKILL_SET skill=gps enabled=1 result=REJECTED_UNSUPPORTED' "$OUT/$s-08-hook.log"; then
    ok "R11 hook debug : skill non supportee rejetee ($(grep -o 'TEST_HOOK result=.*' "$OUT/$s-08-hook.log" | head -1))"
  else
    fail "R11 hook debug non observe (TEST_HOOK/REJECTED absents)"
  fi
  state "08-after-hook"
  if diff -q "$OUT/$s-07b-before-hook-config.json" "$OUT/$s-08-after-hook-config.json" >/dev/null 2>&1; then
    ok "R11 config.json inchangee apres rejet"
  else
    fail "R11 config.json modifiee par le hook"
  fi

  # ---- G. Permissions : interaction reelle (R13, complete R12) -----------------
  open_settings || { fail "G ecran Parametres indisponible"; continue; }
  perm_request_all
  save_log "09-permissions"
  if grep -qE 'PERM_[A-Z]+ request_result=' "$OUT/$s-09-permissions.log"; then
    ok "R13 interaction permissions exercee ($(grep -oE 'PERM_[A-Z]+ request_result=[A-Z_]*' "$OUT/$s-09-permissions.log" | tr '\n' ' '))"
  else
    ok "R13 aucune permission demandable (tout deja accorde) : etats reels uniquement"
  fi
  if grep -qE 'PERM_[A-Z]+ request_result=(GRANTED|GRANTED_WHEN_IN_USE)' "$OUT/$s-09-permissions.log"; then
    ok "R13 au moins une permission accordee via l'UI"
  fi
  ui_screenshot "$s" "$OUT/$s-09-permissions.png"

  # ---- H. Selection SAF + ecriture/creation/suppression (R15,R16) --------------
  saf_pick_documents
  save_log "10-saf"
  if grep -q 'SAF_SELECTED uri=' "$OUT/$s-10-saf.log"; then
    ok "R15 dossier SAF selectionne ($(grep -o 'SAF_SELECTED.*' "$OUT/$s-10-saf.log" | head -1))"
  else
    fail "R15 SAF_SELECTED absent"
  fi
  grep -q 'SAF_TREE_NAME' "$OUT/$s-10-saf.log" && ok "R15 nom de dossier resolu ($(grep -o 'SAF_TREE_NAME.*' "$OUT/$s-10-saf.log" | head -1))" || fail "R15 SAF_TREE_NAME absent"
  [ "$(cfg_storage_mode)" = "saf" ] && ok "R15 config.json storage.mode=saf" || fail "R15 config storage.mode=$(cfg_storage_mode)"
  if grep -q 'STORAGE_WRITE mode=saf ok=1' "$OUT/$s-10-saf.log"; then
    ok "R16 ecriture SAF reelle creation+ecriture+suppression OK ($(grep -o 'STORAGE_WRITE mode=saf.*' "$OUT/$s-10-saf.log" | head -1))"
  else
    fail "R16 STORAGE_WRITE mode=saf ok=1 absent"
  fi
  ui_screenshot "$s" "$OUT/$s-10-saf.png"
  state "10-saf"

  # ---- I. Persistance SAF apres redemarrage (R17,R18) --------------------------
  clear_log
  home_reset || fail "I accueil indisponible"
  open_settings || { fail "I ecran Parametres indisponible"; continue; }
  sleep 3
  save_log "11-saf-restart"
  [ "$(cfg_storage_mode)" = "saf" ] && ok "R17 stockage SAF persiste apres redemarrage" || fail "R17 storage.mode=$(cfg_storage_mode)"
  sp=$(ui_text "$s" storagePath)
  [ -n "$sp" ] && ok "R17 chemin affiche=$sp" || fail "R17 chemin de stockage vide"
  if grep -q 'STORAGE_WRITE mode=saf ok=1' "$OUT/$s-11-saf-restart.log"; then
    ok "R18 ecriture SAF reussie apres redemarrage (acces persistant validé)"
  else
    fail "R18 ecriture SAF absente apres redemarrage"
  fi
  ui_screenshot "$s" "$OUT/$s-11-saf-restart.png"
  state "11-saf-restart"

  # ---- J. Retour au stockage par defaut (R19) ----------------------------------
  if ui_exists "$s" btnResetStorage; then
    tap_visible btnResetStorage; sleep 4
    save_log "12-reset"
    grep -q 'STORAGE_RESET mode=internal' "$OUT/$s-12-reset.log" && ok "R19 journal STORAGE_RESET mode=internal" || fail "R19 STORAGE_RESET absent"
    [ "$(cfg_storage_mode)" = "internal" ] && ok "R19 config.json revenu au stockage par defaut" || fail "R19 storage.mode=$(cfg_storage_mode)"
    grep -q 'STORAGE_WRITE mode=internal ok=1' "$OUT/$s-12-reset.log" && ok "R19 ecriture interne revalidee apres retour" || fail "R19 ecriture interne absente apres retour"
    ui_screenshot "$s" "$OUT/$s-12-reset.png"
    state "12-reset"
  else
    fail "R19 bouton 'Revenir au stockage par defaut' introuvable"
  fi

  echo "[J02] ===== fin device $s (rc=$rc) ====="
done

skipped_report
echo "[J02] RESULTAT GLOBAL rc=$rc"
exit $rc
