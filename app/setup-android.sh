#!/bin/sh
set -eu

CAMERA_PLUGIN_REF="https://github.com/cordova-plugin-camera-preview/cordova-plugin-camera-preview.git#3e5d768934b78e142c369e67f0234a618706500c"
CAMERA_PLATFORM_DIR="platforms/android/app/src/main/java/com/cordovaplugincamerapreview"

npm install

if ! npx cordova platform ls | grep -q '^  android '; then
  npx cordova platform add android@15.1.0
fi

# Installation du plugin caméra à un commit upstream validé (pas de master mouvant).
if npx cordova plugin ls | grep -q '^cordova-plugin-camera-preview '; then
  npx cordova plugin rm cordova-plugin-camera-preview
fi
npx cordova plugin add "${CAMERA_PLUGIN_REF}"

# Patch PixelCopy applique sur les sources du plugin conservees dans plugins/.
python3 pixelcopy-patch/apply_pixelcopy_patch.py .

# Cordova copie les sources Java pendant l'installation du plugin. Comme le patch est
# applique ensuite, on recopie explicitement les sources patchees vers celles compilees.
mkdir -p "$CAMERA_PLATFORM_DIR"
cp plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp plugins/cordova-plugin-camera-preview/src/android/CameraActivity.java "$CAMERA_PLATFORM_DIR/CameraActivity.java"

npx cordova prepare android

# Le prepare peut remettre les sources du plugin : on recopie les versions patchees.
cp plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp plugins/cordova-plugin-camera-preview/src/android/CameraActivity.java "$CAMERA_PLATFORM_DIR/CameraActivity.java"

echo "=== Verification PixelCopy natif (sources compilees par le build) ==="
grep -q 'CAPTURE_PREVIEW_SURFACE_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action PixelCopy absente de CameraPreview.java compile"
  exit 1
}
grep -q 'capturePreviewSurface' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || {
  echo "ERREUR: methode PixelCopy absente de CameraActivity.java compile"
  exit 1
}
grep -q 'capturePreviewSurface' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action capteur PixelCopy absente de CameraPreview.java compile"
  exit 1
}
echo "PixelCopy natif present dans la plateforme Android (sources compilees)"

echo "=== Plugins ==="
npx cordova plugin ls

echo "=== Build ==="
npx cordova build android

echo "=== APK ==="
echo "platforms/android/app/build/outputs/apk/debug/app-debug.apk"