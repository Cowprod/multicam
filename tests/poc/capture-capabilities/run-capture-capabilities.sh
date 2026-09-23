#!/usr/bin/env bash
# POC Capture Capabilities — qualification ciblee des capacites reellement
# interrogeables par stack Android/plugin sur les appareils B et C.
#
# Cycle :
#   1. applique le patch generique getCaptureCapabilities sur le plugin
#      cordova-plugin-camera-preview (appelant le mecanisme pixelcopy existant,
#      puis le patch capture-capabilities, recopie dans la plateforme) ;
#   2. build APK + verification grep des marqueurs compiles ;
#   3. installation sur B (61d54bba7d91) et C (c0d8514d7d87) uniquement
#      (le serial 61cc29567d91 reste HORS PERIMETRE) ;
#   4. probe CDP sur chaque device -> JSON diagnostique brut + logcat ;
#   5. archive SHA-256 APK et evidence.
#
# Usage : tests/poc/capture-capabilities/run-capture-capabilities.sh
set -um

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP_DIR="$ROOT/app"
OUT="$HERE/evidence"
CDP="$ROOT/tests/e2e/lib/cdp.js"
PATCH="$HERE/patch/apply_capture_capabilities_patch.py"

B=61d54bba7d91
C=c0d8514d7d87
APP=fr.emmanuel.multicam
APK="$APP_DIR/platforms/android/app/build/outputs/apk/debug/app-debug.apk"

mkdir -p "$OUT"

echo "=== 1/5 patch PixelCopy (mecanisme existant) ==="
python3 "$APP_DIR/pixelcopy-patch/apply_pixelcopy_patch.py" "$APP_DIR"

echo "=== 2/5 patch capture-capabilities (generique) ==="
python3 "$PATCH" "$APP_DIR"

echo "=== 3/5 prepare + recopie + build ==="
CAMERA_PLATFORM_DIR="$APP_DIR/platforms/android/app/src/main/java/com/cordovaplugincamerapreview"
python3 "$PATCH" "$APP_DIR"
npx --prefix "$APP_DIR" cordova prepare android
cp "$APP_DIR/plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java" "$CAMERA_PLATFORM_DIR/CameraPreview.java"
grep -q 'GET_CAPTURE_CAPABILITIES_ACTION' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || {
  echo "ERREUR: action absente des sources compilees"; exit 1
}
npx --prefix "$APP_DIR" cordova build android "$@" || { cd "$APP_DIR" && npx cordova build android; }

echo "=== 4/5 verification marqueurs APK + SHA-256 ==="
shasum -a 256 "$APK" | tee "$OUT/apk-sha256.txt"

echo "=== 5/5 installation B et C + probe ==="
for S in $B $C; do
  adb -s "$S" install -r "$APK" >/dev/null || { echo "INSTALL_FAIL $S"; exit 1; }
done

probe() {
  local serial="$1" label="$2"
  adb -s "$serial" shell am force-stop "$APP" 2>/dev/null
  adb -s "$serial" logcat -c 2>/dev/null
  adb -s "$serial" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  sleep 9
  local pid
  pid=$(adb -s "$serial" shell pidof "$APP" | tr -d '\r\n')
  echo "probe $label pid=$pid"
  # Expression CDP : promesse qui appelle le plugin + recupere deviceId local.
  node "$CDP" "$serial" eval "(async function(){
    if (MultiCamConfig && MultiCamConfig.load) { await MultiCamConfig.load(); }
    var dId = (MultiCamConfig && MultiCamConfig.get ? MultiCamConfig.get() : {}).deviceId || 'unknown';
    return new Promise(function(resolve){
      if (typeof window.CameraPreview === 'undefined') return resolve({deviceId:dId, ok:false, error:'CameraPreview_undefined'});
      var exec = window.cordova && window.cordova.exec;
      if (typeof exec !== 'function') return resolve({deviceId:dId, ok:false, error:'cordova_exec_missing'});
      exec(function(res){ resolve({deviceId:dId, ok:true, data:res}); },
           function(err){ resolve({deviceId:dId, ok:false, error:String(err)}); },
           'CameraPreview', 'getCaptureCapabilities', []);
    });
  })()" > "$OUT/$label.json"
  adb -s "$serial" logcat -d -v time 2>/dev/null | grep -E "CameraPreview|CAP_|APP_BOOT|CONFIG_INIT" > "$OUT/$label.log"
  echo "probe $label -> $OUT/$label.json ($(wc -c < "$OUT/$label.json") bytes)"
}

probe "$B" "B-capabilities"
probe "$C" "C-capabilities"

echo "=== done ==="
ls -la "$OUT"