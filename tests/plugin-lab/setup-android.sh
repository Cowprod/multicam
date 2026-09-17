#!/bin/sh
set -eu

npm install

if ! npx cordova platform ls | grep -q '^  android '; then
  npx cordova platform add android@15.1.0
fi

add_plugin() {
  name="$1"
  id="$2"
  if npx cordova plugin ls | grep -q "^$id "; then
    echo "=== déjà installé: $id ==="
  else
    echo "=== installation: $name ==="
    npx cordova plugin add "$name"
  fi
}

add_plugin cordova-plugin-device cordova-plugin-device
add_plugin cordova-plugin-android-permissions cordova-plugin-android-per