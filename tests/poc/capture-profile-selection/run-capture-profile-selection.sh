#!/usr/bin/env bash
# POC Capture Profile Selection — prouver qu'un profil CamcorderProfile explicite
# demande (720P / 1080P) est reellement utilise par MediaRecorder, et que 2160P
# est rejete de facon deterministe (pas de fallback silencieux vers HIGH).
#
# Cycle :
#   0. restore sources plugin PRISTINES (pin 3e5d768) depuis backups .bak-pixelcopy
#      (verifies identiques au commit pinte par le projet) ;
#   1. patch PixelCopy existant (mecanisme deja en place) ;
#   2. patch capture-profile-selection (action generique camcorderProfile) ;
#   3. cordova prepare + recopie des 2 .java patchees dans la plateforme + build ;
#   4. SHA-256 APK ;
#   5. install B (61d54bba7d91) et C (c0d8514d7d87) uniquement ;
#   6. sequence reel par device :
#        camera rear (SurfaceView toBack) -> startRecordVideo(profile) ~4s ->
#        stopRecordVideo -> pull MP4 (run-as, cache) -> ffprobe + checksum.
#        720P puis 1080P sur B et C ; test negatif 2160P sur B.
#
# Exigence runtime : ffprobe/ffmpeg sur l'hote.
# Usage : tests/poc/capture-profile-selection/run-capture-profile-selection.sh
set -um

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP_DIR="$ROOT/app"
OUT="$HERE/evidence"
CDP="$ROOT/tests/e2e/lib/cdp.js"
PATCH="$HERE/patch/apply_capture_profile_patch.py"
FFPROBE="$(command -v ffprobe || echo missing)"

B=61d54bba7d91
C=c0d8514d7d87
APP=fr.emmanuel.multicam
APK="$APP_DIR/platforms/android/app/build/outputs/apk/debug/app-debug.apk"

PLUGIN_JAVA="$APP_DIR/plugins/cordova-plugin-camera-preview/src/android"
PLUGIN_WWW="$APP_DIR/plugins/cordova-plugin-camera-preview/www"
CAMERA_PLATFORM_DIR="$APP_DIR/platforms/android/app/src/main/java/com/cordovaplugincamerapreview"

[ "$FFPROBE" != missing ] || { echo "ERREUR: ffprobe requis (brew install ffmpeg)"; exit 1; }
mkdir -p "$OUT"

echo "=== 0/6 restore sources PRISTINES (pin 3e5d768) ==="
for pair in "CameraActivity.java:$PLUGIN_JAVA/CameraActivity.java" "CameraPreview.java:$PLUGIN_JAVA/CameraPreview.java" "CameraPreview.js:$PLUGIN_WWW/CameraPreview.js"; do
  base="${pair%%:*}"; target="${pair##*:}"
  bak="$target.bak-pixelcopy"
  if [ -f "$bak" ]; then cp "$bak" "$target"; echo "restored $target <- $bak"; else echo "ERREUR: backup $bak absent (plugin pas pinte)"; exit 1; fi
  rm -f "$target.bak-capturecapabilities" "$target.bak-captureprof"
done
rm -f "$PLUGIN_JAVA/CameraActivity.java.bak-capturecapabilities" "$PLUGIN_JAVA/CameraActivity.java.bak-captureprof" 2>/dev/null

echo "=== 1/6 patch PixelCopy (mecanisme existant) ==="
python3 "$APP_DIR/pixelcopy-patch/apply_pixelcopy_patch.py" "$APP_DIR"

echo "=== 2/6 patch capture-profile-selection (generique) ==="
python3 "$PATCH" "$APP_DIR"

echo "=== 3/6 prepare + recopie + fix manifest + build ==="
npx --prefix "$APP_DIR" cordova prepare android
cp "$PLUGIN_JAVA/CameraPreview.java" "$CAMERA_PLATFORM_DIR/CameraPreview.java"
cp "$PLUGIN_JAVA/CameraActivity.java" "$CAMERA_PLATFORM_DIR/CameraActivity.java"
# Le JS empaquete doit conserver le wrapper cordova.define (module charge par
# cordova.js), sous peine de "require is not defined" / Module does not exist.
# prepare ne re-empaquete pas le module d'un plugin deja ajoute : on le
# regenere depuis la source plugin patchee (idempotent).
write_wrapped_camera_js() {
  local src="$PLUGIN_WWW/CameraPreview.js" dst_dir="$1" dst="$1/CameraPreview.js"
  mkdir -p "$dst_dir"
  python3 - "$src" "$dst" <<'PYEOF'
import sys
src_p, dst_p = sys.argv[1], sys.argv[2]
MODULE = 'cordova-plugin-camera-preview.CameraPreview'
body = open(src_p, encoding='utf-8').read().rstrip()
wrapped = 'cordova.define("%s", function(require, exports, module) {\n%s\n});\n' % (MODULE, body)
open(dst_p, 'w', encoding='utf-8').write(wrapped)
print('WRAPPED JS ->', dst_p)
PYEOF
}
write_wrapped_camera_js "$APP_DIR/platforms/android/app/src/main/assets/www/plugins/cordova-plugin-camera-preview/www"
write_wrapped_camera_js "$APP_DIR/platforms/android/platform_www/plugins/cordova-plugin-camera-preview/www"
head -2 "$APP_DIR/platforms/android/app/src/main/assets/www/plugins/cordova-plugin-camera-preview/www/CameraPreview.js" >/dev/null | true
grep -q 'cordova.define' "$APP_DIR/platforms/android/app/src/main/assets/www/plugins/cordova-plugin-camera-preview/www/CameraPreview.js" || { echo "ERREUR: JS asset mal empaquete"; exit 1; }
grep -q 'camcorderProfile' "$APP_DIR/platforms/android/app/src/main/assets/www/plugins/cordova-plugin-camera-preview/www/CameraPreview.js" || { echo "ERREUR: camcorderProfile absent JS empaquete"; exit 1; }
PLATFORM_MANIFEST="$APP_DIR/platforms/android/app/src/main/AndroidManifest.xml"
python3 - "$PLATFORM_MANIFEST" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'READ_MEDIA_IMAGES' not in s:
    anchor = '<uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
    add = (anchor
           + '    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />\n'
           + '    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />\n')
    assert anchor in s, 'manifest RECORD_AUDIO anchor introuvable'
    s = s.replace(anchor, add, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('PATCH manifest platform READ_MEDIA_*')
else:
    print('manifest platform READ_MEDIA_* deja present')
PYEOF
grep -q 'PROFILE_NOT_SUPPORTED' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || { echo "ERREUR: marqueur PROFILE_NOT_SUPPORTED absent"; exit 1; }
grep -q 'PROFILE_UNKNOWN' "$CAMERA_PLATFORM_DIR/CameraActivity.java" || { echo "ERREUR: marqueur PROFILE_UNKNOWN absent"; exit 1; }
grep -q 'camcorderProfile' "$CAMERA_PLATFORM_DIR/CameraPreview.java" || { echo "ERREUR: camcorderProfile absent CameraPreview"; exit 1; }
grep -q 'camcorderProfile' "$APP_DIR/platforms/android/app/src/main/assets/www/plugins/cordova-plugin-camera-preview/www/CameraPreview.js" || { echo "ERREUR: camcorderProfile absent JS empaquete"; exit 1; }
npx --prefix "$APP_DIR" cordova build android "$@" || { cd "$APP_DIR" && npx cordova build android; }

echo "=== 4/6 SHA-256 APK ==="
shasum -a 256 "$APK" | tee "$OUT/apk-sha256.txt"

echo "=== 5/6 install B et C + permissions runtime ==="
for S in $B $C; do
  adb -s "$S" install -r "$APK" >/dev/null || { echo "INSTALL_FAIL $S"; exit 1; }
  for P in android.permission.CAMERA android.permission.RECORD_AUDIO android.permission.READ_MEDIA_IMAGES android.permission.READ_MEDIA_VIDEO android.permission.READ_EXTERNAL_STORAGE android.permission.WRITE_EXTERNAL_STORAGE; do
    adb -s "$S" shell pm grant "$APP" "$P" 2>/dev/null
  done
done

echo "=== 6/6 enregistrements 720P / 1080P (B, C) + negatif 2160P (B) ==="

pull_mp4() {
  local serial="$1" api_path="$2" dest="$3"
  adb -s "$serial" exec-out run-as "$APP" cat "$api_path" > "$dest" 2>/dev/null || return 1
  [ -s "$dest" ] || return 1
}
b64() { python3 -c "import base64,sys;print(base64.b64encode(sys.stdin.buffer.read()).decode())"; }

record_once() {
  local serial="$1" label="$2" profile="$3"
  adb -s "$serial" shell am force-stop "$APP" 2>/dev/null
  adb -s "$serial" logcat -c 2>/dev/null
  adb -s "$serial" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  sleep 8
  local out
  out=$(node "$CDP" "$serial" eval "(async function(){
    if (MultiCamConfig && MultiCamConfig.load) { await MultiCamConfig.load(); }
    var dId = (MultiCamConfig && MultiCamConfig.get ? MultiCamConfig.get() : {}).deviceId || 'unknown';
    var execBridge = window.cordova.exec || window.cordova.require('cordova/exec');
    function exec(action, args){ return new Promise(function(res, rej){ execBridge(res, rej, 'CameraPreview', action, args); }); }
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    try {
      await exec('startCamera', [0, 0, 320, 240, 'back', false, false, true, 1, false, false, false]);
      await sleep(1500);
      var startResult = null;
      try {
        startResult = await exec('startRecordVideo', ['back', 0, 0, 85, false, '$profile']);
      } catch (e) {
        return { deviceId: dId, ok: false, phase: 'startRecordVideo', error: String(e) };
      }
      await sleep(4000);
      var file = null, stopErr = null;
      try { file = await exec('stopRecordVideo', []); } catch (e) { stopErr = String(e); }
      try { await exec('stopCamera', []); } catch (e) {}
      return { deviceId: dId, ok: true, start: startResult, file: file, stopError: stopErr };
    } catch (e) {
      try { await exec('stopCamera', []); } catch (e2) {}
      return { deviceId: dId, ok: false, phase: 'setup', error: String(e) };
    }
  })()")
  echo "$out" > "$OUT/$label.probe.json"
  local file=$(node -e "const d=require('$OUT/$label.probe.json');console.log(d.ok?d.file||'':'')" 2>/dev/null)
  if [ -z "$file" ]; then
    echo "$label -> probe NOK $(node -e "const d=require('$OUT/$label.probe.json');console.log(JSON.stringify(d));" 2>/dev/null)"
    return 1
  fi
  local mp4="$OUT/$label.mp4"
  if pull_mp4 "$serial" "$file" "$mp4"; then
    shasum -a 256 "$mp4" | tee "$OUT/$label.sha256"
    "$FFPROBE" -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate -of json "$mp4" > "$OUT/$label.ffprobe.json"
    echo "$label -> OK file=  proxied=$(b64 < "$OUT/$label.ffprobe.json" | head -c 60)..."
  else
    echo "$label -> PULL FAIL"
    return 1
  fi
  adb -s "$serial" logcat -d -v time 2>/dev/null | grep -E "CameraPreview|Recording rejected|Starting recording" > "$OUT/$label.log"
  return 0
}

negative_2160() {
  local serial="$1" label="$2"
  adb -s "$serial" shell am force-stop "$APP" 2>/dev/null
  adb -s "$serial" logcat -c 2>/dev/null
  adb -s "$serial" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
  sleep 8
  local out
  out=$(node "$CDP" "$serial" eval "(async function(){
    if (MultiCamConfig && MultiCamConfig.load) { await MultiCamConfig.load(); }
    var dId = (MultiCamConfig && MultiCamConfig.get ? MultiCamConfig.get() : {}).deviceId || 'unknown';
    var execBridge = window.cordova.exec || window.cordova.require('cordova/exec');
    function exec(action, args){ return new Promise(function(res, rej){ execBridge(res, rej, 'CameraPreview', action, args); }); }
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    try {
      await exec('startCamera', [0, 0, 320, 240, 'back', false, false, true, 1, false, false, false]);
      await sleep(1500);
      var err = null;
      try { await exec('startRecordVideo', ['back', 0, 0, 85, false, '2160P']); }
      catch (e) { err = String(e); }
      var file = null;
      try { file = await exec('stopRecordVideo', []); } catch (e) {}
      try { await exec('stopCamera', []); } catch (e) {}
      return { deviceId: dId, rejected: err != null, error: err, unexpectedFile: file };
    } catch (e) {
      try { await exec('stopCamera', []); } catch (e2) {}
      return { deviceId: dId, rejected: false, error: 'setup ' + String(e), unexpectedFile: null };
    }
  })()")
  echo "$out" > "$OUT/$label.probe.json"
  adb -s "$serial" logcat -d -v time 2>/dev/null | grep -E "CameraPreview|Recording rejected|Starting recording" > "$OUT/$label.log"
  echo "$label -> $(node -e "const d=require('$OUT/$label.probe.json');console.log('rejected=',d.rejected,'err=',d.error,'unexpectedFile=',d.unexpectedFile);" 2>/dev/null)"
}

record_once "$B" "B-720P" "720P" || exit 1
record_once "$B" "B-1080P" "1080P" || exit 1
record_once "$C" "C-720P" "720P" || exit 1
record_once "$C" "C-1080P" "1080P" || exit 1
negative_2160 "$B" "B-2160P-negative"

echo "=== done ==="
ls -la "$OUT"