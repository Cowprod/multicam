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

# Réinstallation propre de CameraPreview à chaque itération.
if npx cordova plugin ls | grep -q '^cordova-plugin-camera-preview '; then
  npx cordova plugin rm cordova-plugin-camera-preview
fi
npx cordova plugin add https://github.com/cordova-plugin-camera-preview/cordova-plugin-camera-preview.git#master

# Patch des sources du plugin conservées dans plugins/.
python3 pixelcopy-patch/apply_pixelcopy_patch.py .

# Cordova copie les sources Java pendant l'installation du plugin. Comme le patch est
# appliqué ensuite, on recopie explicitement les sources patchées vers celles compilées.
CAMERA_PLATFORM_DIR="platforms/android/app/src/main/java/com/cordovaplugincamerapreview"
mkdir -p "$CAMERA_PLATFORM_DIR"
cp plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp plugins/cordova-plugin-camera-preview/src/android/CameraActivity.java "$CAMERA_PLATFORM_DIR/CameraActivity.java"

# Réinstallation du plugin SAF local pour prendre les mises à jour du dépôt.
if npx cordova plugin ls | grep -q '^cordova-plugin-multicam-saf '; then
  npx cordova plugin rm cordova-plugin-multicam-saf
fi
npx cordova plugin add ./local-plugins/cordova-plugin-multicam-saf
npx cordova prepare android

# Le prepare peut remettre les sources du plugin : on recopie les versions patchées.
cp plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp plugins/cordova-plugin-camera-preview/src/android/CameraActivity.java "$CAMERA_PLATFORM_DIR/CameraActivity.java"

echo "=== Vérification PixelCopy natif ==="
grep -q 'CAPTURE_PREVIEW_SURFACE_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action PixelCopy absente de CameraPreview.java compilé"
  exit 1
}
grep -q 'capturePreviewSurface' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || {
  echo "ERREUR: méthode PixelCopy absente de CameraActivity.java compilé"
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
