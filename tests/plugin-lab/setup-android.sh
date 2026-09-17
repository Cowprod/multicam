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
add_plugin cordova-plugin-android-permissions cordova-plugin-android-permissions
add_plugin cordova-plugin-file cordova-plugin-file
add_plugin cordova-plugin-x-socialsharing cordova-plugin-x-socialsharing

# CameraPreview doit être patché AVANT que Cordova copie ses sources natives dans platforms/android.
# On le réinstalle donc proprement à chaque itération du lab.
if npx cordova plugin ls | grep -q '^cordova-plugin-camera-preview '; then
  npx cordova plugin rm cordova-plugin-camera-preview
fi
npx cordova plugin add https://github.com/cordova-plugin-camera-preview/cordova-plugin-camera-preview.git#master
python3 pixelcopy-patch/apply_pixelcopy_patch.py .
# Force Cordova à recopier le plugin désormais patché dans la plateforme Android.
npx cordova prepare android

# Réinstallation volontaire : les évolutions récupérées par git pull sont ainsi prises en compte.
if npx cordova plugin ls | grep -q '^cordova-plugin-multicam-saf '; then
  npx cordova plugin rm cordova-plugin-multicam-saf
fi
npx cordova plugin add ./local-plugins/cordova-plugin-multicam-saf
npx cordova prepare android

echo "=== Vérification PixelCopy natif ==="
grep -q 'CAPTURE_PREVIEW_SURFACE_ACTION' platforms/android/app/src/main/java/com/mbppower/CameraPreview.java || {
  echo "ERREUR: le patch PixelCopy n'a pas été copié dans platforms/android"
  exit 1
}
echo "PixelCopy natif présent dans la plateforme Android"

echo "=== Plugins ==="
npx cordova plugin ls

echo "=== Build ==="
npx cordova build android

echo "=== APK ==="
echo "platforms/android/app/build/outputs/apk/debug/app-debug.apk"

echo "=== Installation / lancement sur le device Android connecté ==="
npx cordova run android --device
