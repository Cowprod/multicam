#!/bin/sh
# MultiCam — helpers UI adb pour les tests e2e (uiautomator + input).
# Sélecteurs : resource-id, text ou content-desc (égalité exacte).
# Espace de coordonnées : celui de l'arbre UiAutomator (identique à `input tap`).

UI_REMOTE="/sdcard/multicam-ui.xml"

ui_dump() { # $1 serial
  adb -s "$1" shell uiautomator dump "$UI_REMOTE" >/dev/null 2>&1
  adb -s "$1" shell cat "$UI_REMOTE" 2>/dev/null
}

ui_node() { # $1 serial, $2 selector
  ui_dump "$1" | tr '>' '\n' | grep -F -e "resource-id=\"$2\"" -e "text=\"$2\"" -e "content-desc=\"$2\"" | head -1
}

ui_exists() { # $1 serial, $2 selector
  [ -n "$(ui_node "$1" "$2")" ]
}

ui_text() { # $1 serial, $2 selector -> valeur de l'attribut text
  ui_node "$1" "$2" | grep -o 'text="[^"]*"' | head -1 | sed 's/^text="//; s/"$//'
}

ui_checked() { # $1 serial, $2 selector -> "true"/"false"
  ui_node "$1" "$2" | grep -o 'checked="[^"]*"' | head -1 | sed 's/^checked="//; s/"$//'
}

ui_attr() { # $1 serial, $2 selector, $3 attr
  ui_node "$1" "$2" | grep -o "$3=\"[^\"]*\"" | head -1 | sed "s/^$3=\"//; s/\"$//"
}

ui_has_text() { # $1 serial, $2 texte exact
  ui_dump "$1" | grep -q "text=\"$2\""
}

ui_bounds() { # $1 serial, $2 selector -> "x1 y1 x2 y2"
  ui_node "$1" "$2" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p'
}

ui_wait() { # $1 serial, $2 selector, $3 tries=10, $4 delay=2
  ui_tries=${3:-10}; ui_delay=${4:-2}; ui_i=0
  while [ "$ui_i" -lt "$ui_tries" ]; do
    if ui_exists "$1" "$2"; then return 0; fi
    sleep "$ui_delay"; ui_i=$(( ui_i + 1 ))
  done
  return 1
}

ui_tap() { # $1 serial, $2 selector
  ui_s="$1"; ui_sel="$2"
  ui_b=$(ui_bounds "$ui_s" "$ui_sel")
  if [ -z "$ui_b" ]; then echo "UI_TAP_MISS selector=$ui_sel" >&2; return 1; fi
  ui_x1=$(echo "$ui_b" | awk '{print $1}'); ui_y1=$(echo "$ui_b" | awk '{print $2}')
  ui_x2=$(echo "$ui_b" | awk '{print $3}'); ui_y2=$(echo "$ui_b" | awk '{print $4}')
  adb -s "$ui_s" shell input tap $(( (ui_x1 + ui_x2) / 2 )) $(( (ui_y1 + ui_y2) / 2 ))
}

ui_tap_xy() { adb -s "$1" shell input tap "$2" "$3"; }

ui_input_text() { # $1 serial, $2 texte (espaces -> %s)
  ui_enc=$(printf '%s' "$2" | sed 's/ /%s/g')
  adb -s "$1" shell input text "$ui_enc"
}

ui_clear_field() { # $1 serial, $2 selector (focus puis suppression)
  ui_s="$1"; ui_sel="$2"
  ui_tap "$ui_s" "$ui_sel" || return 1
  sleep 1
  adb -s "$ui_s" shell input keyevent KEYCODE_MOVE_END >/dev/null 2>&1
  ui_del=""
  ui_k=0
  while [ "$ui_k" -lt 40 ]; do ui_del="$ui_del 67"; ui_k=$(( ui_k + 1 )); done
  adb -s "$ui_s" shell input keyevent $ui_del >/dev/null 2>&1
  sleep 1
}

ui_screenshot() { adb -s "$1" exec-out screencap -p >"$2" 2>/dev/null; }

# Extrait le champ JSON "...": valeur d'un objet config.json (usage preuve).
json_field() { # $1 fichier, $2 clé de premier niveau
  grep -o "\"$2\"[ ]*:[ ]*\"[^\"]*\"" "$1" | head -1 | sed 's/.*:[ ]*"//; s/"$//'
}