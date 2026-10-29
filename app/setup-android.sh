#!/bin/sh
set -eu

CAMERA_PLUGIN_REF="https://github.com/cordova-plugin-camera-preview/cordova-plugin-camera-preview.git#3e5d768934b78e142c369e67f0234a618706500c"
CAMERA_PLATFORM_DIR="platforms/android/app/src/main/java/com/cordovaplugincamerapreview"

npm install

if ! npx cordova platform ls | grep -q '^  android '; then
  npx cordova platform add android@15.1.0
fi

# Plugins registry qualifies (installation rappelée à chaque itération via npm install).
add_plugin() {
  name="$1"
  id="$2"
  if npx cordova plugin ls | grep -q "^$id "; then
    echo "=== deja installe: $id ==="
  else
    echo "=== installation: $name ==="
    npx cordova plugin add "$name"
  fi
}
add_plugin cordova-plugin-device cordova-plugin-device
add_plugin cordova-plugin-file cordova-plugin-file
add_plugin cordova-plugin-battery-status cordova-plugin-battery-status
add_plugin cordova-plugin-network-information cordova-plugin-network-information
add_plugin cordova.plugins.diagnostic cordova.plugins.diagnostic

# Installation du plugin caméra à un commit upstream validé (pas de master mouvant).
if npx cordova plugin ls | grep -q '^cordova-plugin-camera-preview '; then
  npx cordova plugin rm cordova-plugin-camera-preview
fi
npx cordova plugin add "${CAMERA_PLUGIN_REF}"

# Patch PixelCopy applique sur les sources du plugin conservees dans plugins/.
python3 pixelcopy-patch/apply_pixelcopy_patch.py .

# J06 — selection explicite du profil CamcorderProfile au demarrage d'enregistrement
# (greffe generique qualifiee en POC, idempotente) : le plugin est re-installe a
# chaque passage ici, donc le patch est re-applique systématiquement.
python3 ../tests/poc/capture-profile-selection/patch/apply_capture_profile_patch.py .

# J06 — capacites Capture natives (getCaptureCapabilities : camcorderProfiles,
# gpsFeature, audioMicFeature) — derive du POC capture-capabilities.
python3 camera-patches/apply_capture_capabilities_patch.py .

# J08 — permissions video : startRecordVideo n exige plus que CAMERA +
# RECORD_AUDIO. Sans ce patch, les READ_MEDIA_* (API 33+) non declares au
# manifest sont refuses et l enregistrement echoue avec "Illegal access".
python3 camera-patches/apply_video_permission_patch.py .

# J09-07 — bascule camera CIBLEE + etat natif honnete (switchCameraTo /
# getCameraState). Indispensable pour §35.3 : switchCamera() upstream ne vise
# aucune camera et ne confirme rien, et ne met pas a jour defaultCameraId
# (profil CamcorderProfile du prochain segment).
python3 camera-patches/apply_camera_switch_patch.py .

# Cordova copie les sources Java pendant l'installation du plugin. Comme le patch est
# applique ensuite, on recopie explicitement les sources patchees vers celles compilees.
mkdir -p "$CAMERA_PLATFORM_DIR"
cp plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp plugins/cordova-plugin-camera-preview/src/android/CameraActivity.java "$CAMERA_PLATFORM_DIR/CameraActivity.java"

# Le hook after_prepare versionne reapplique les patchs natifs et reconstruit
# les wrappers JS avec cordova.define dans platform_www/ ET assets/www/.
# Ainsi un simple cordova build ne peut plus embarquer le plugin upstream nu.

# Plugins locaux MultiCam (sources prises depuis app/local-plugins).
add_local_plugin() {
  id="$1"
  path="$2"
  if npx cordova plugin ls | grep -q "^$id "; then
    npx cordova plugin rm "$id"
  fi
  echo "=== installation locale: $id ==="
  npx cordova plugin add "$path"
}
add_local_plugin cordova-plugin-multicam-saf local-plugins/cordova-plugin-multicam-saf
add_local_plugin cordova-plugin-multicam-platform local-plugins/cordova-plugin-multicam-platform
# D-SERVE : le serveur media HTTP unique vit dans ce plugin. Il DOIT etre
# re-installe a chaque iter pour que la source local-plugins/ (routeur
# multi-Take) soit propagee a plugins/ et platforms/. `cordova prepare` ne
# rafraichit pas un plugin deja present (restore-util.js), donc sans cette
# ligne l'APK embarquerait une copie perimee.
add_local_plugin cordova-plugin-multicam-httpd local-plugins/cordova-plugin-multicam-httpd
# J14-C01 : le client de téléchargement natif (doRemove/existed, garde de
# troncature) vit dans ce plugin. Comme pour httpd, `cordova prepare` ne
# rafraîchit PAS un plugin déjà présent : sans cette ré-installation, l'APK
# embarquerait la copie périmée et le correctif D2/D3 serait absent du build.
add_local_plugin cordova-plugin-multicam-transfer local-plugins/cordova-plugin-multicam-transfer
add_local_plugin cordova-plugin-multicam-nsd local-plugins/cordova-plugin-multicam-nsd
add_local_plugin cordova-websocket-server local-plugins/cordova-websocket-server

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

echo "=== Verification J06 (sources compilees par le build) ==="
grep -q 'GET_CAPTURE_CAPABILITIES_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action getCaptureCapabilities absente de CameraPreview.java compile"
  exit 1
}
grep -q 'getCaptureCapabilities' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: methode getCaptureCapabilities absente de CameraPreview.java compile"
  exit 1
}
grep -q 'final String camcorderProfile' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || {
  echo "ERREUR: profil CamcorderProfile explicite absent de CameraActivity.java compile"
  exit 1
}
echo "J06 capture-capabilities + camcorderProfile presents dans la plateforme Android"

echo "=== Verification J09-07 (sources compilees par le build) ==="
grep -q 'public String switchCameraTo(String facing)' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || {
  echo "ERREUR: switchCameraTo cible absent de CameraActivity.java compile"
  exit 1
}
grep -q 'public String cameraStateJson()' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || {
  echo "ERREUR: cameraStateJson absent de CameraActivity.java compile"
  exit 1
}
grep -q 'SWITCH_CAMERA_TO_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action switchCameraTo absente de CameraPreview.java compile"
  exit 1
}
grep -q 'GET_CAMERA_STATE_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action getCameraState absente de CameraPreview.java compile"
  exit 1
}
grep -q 'switchCameraTo = function' plugins/cordova-plugin-camera-preview/www/CameraPreview.js || {
  echo "ERREUR: wrapper JS switchCameraTo absent"
  exit 1
}
echo "J09-07 switchCameraTo + getCameraState presents dans la plateforme Android"

echo "=== Plugins ==="
npx cordova plugin ls

echo "=== Controle packaging D-SERVE (pre-build) ==="
sh scripts/check-dserve-packaging.sh

echo "=== Build ==="
npx cordova build android

echo "=== APK ==="
echo "platforms/android/app/build/outputs/apk/debug/app-debug.apk"