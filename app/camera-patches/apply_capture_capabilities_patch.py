#!/usr/bin/env python3
"""
Patch J06 Capture Capabilities — plugin cordova-plugin-camera-preview (app).

Ajoute l'action native `getCaptureCapabilities` (getCaptureCapabilities) au
CameraPreview.java de l'app (le plugin est re-installe par cordova a chaque
`platform add`/plugin reinstall, donc le patch est reapplique par
app/setup-android.sh). Derive du POC qualifie
(tests/poc/capture-capabilities/patch/apply_capture_capabilities_patch.py) :
MODELE de donnees identique (sdk/model/manufacturer, applicationCapabilities
{audioMicFeature,gpsFeature,…}, orientationModes, cameras, camcorderProfiles
{720P/1080P/2160P/HIGH…}, legacyVideoSizes) ; aucune logique Take/fallback.

Le JS correspondant (app/www/js/native/capture-capabilities.js) normalise ensuite
en HD/FHD/4K (aucune politique dans la couche native — decision 32).

Reproductible : anchors stables du master pinge
(3e5d768934b78e142c369e67f0234a618706500c) + gardes idempotentes (DEJA OK) +
recopie vers platforms/android + verification markers.

Usage (racine repo ou dossier app) :
  python3 app/camera-patches/apply_capture_capabilities_patch.py .
"""
from pathlib import Path
import sys, shutil

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
APP = ROOT / 'app'
if (APP / 'config.xml').exists():
    ROOT = APP
PLUGIN = ROOT / 'plugins' / 'cordova-plugin-camera-preview'
PREVIEW = PLUGIN / 'src/android/CameraPreview.java'
PLATFORM = ROOT / 'platforms/android/app/src/main/java/com/cordovaplugincamerapreview'

if not PREVIEW.exists():
    raise SystemExit('ERREUR: plugin introuvable (installer d abord): %s' % PREVIEW)

def replace_once(text, old, new, label):
    if new in text:
        print('DEJA OK:', label)
        return text
    if old not in text:
        raise SystemExit('ERREUR: anchor introuvable pour %s' % label)
    return text.replace(old, new, 1)

bak = Path(str(PREVIEW) + '.bak-capturecaps')
if not bak.exists():
    shutil.copy2(PREVIEW, bak)

s = PREVIEW.read_text(encoding='utf-8')

# 0. import CamcorderProfile (si absent)
if 'import android.media.CamcorderProfile;' not in s:
    s = replace_once(s,
        'import android.hardware.camera2.CameraManager;\n',
        'import android.hardware.camera2.CameraManager;\nimport android.media.CamcorderProfile;\n',
        'import CamcorderProfile')

# 1. constante action
s = replace_once(s,
    '  private static final String GET_CAMERA_CHARACTERISTICS_ACTION = "getCameraCharacteristics";\n',
    '  private static final String GET_CAMERA_CHARACTERISTICS_ACTION = "getCameraCharacteristics";\n'
    '  private static final String GET_CAPTURE_CAPABILITIES_ACTION = "getCaptureCapabilities";\n',
    'action constant')

# 2. branche execute()
s = replace_once(s,
    '    } else if (GET_CAMERA_CHARACTERISTICS_ACTION.equals(action)) {\n'
    '      return getCameraCharacteristics(callbackContext);\n'
    '    }\n\n    return false;',
    '    } else if (GET_CAMERA_CHARACTERISTICS_ACTION.equals(action)) {\n'
    '      return getCameraCharacteristics(callbackContext);\n'
    '    } else if (GET_CAPTURE_CAPABILITIES_ACTION.equals(action)) {\n'
    '      return getCaptureCapabilities(callbackContext);\n'
    '    }\n\n    return false;',
    'execute branch')

# 3. methode native (inseree avant getCameraCharacteristics)
anchor = '  private boolean getCameraCharacteristics(CallbackContext callbackContext) {\n'
method = r'''  private boolean getCaptureCapabilities(CallbackContext callbackContext) {
    cordova.getThreadPool().execute(new Runnable() {
      @Override public void run() {
        JSONObject data = new JSONObject();
        final int SDK = Build.VERSION.SDK_INT;
        try {
          data.put("sdk", SDK);
          data.put("model", android.os.Build.MODEL);
          data.put("manufacturer", android.os.Build.MANUFACTURER);

          // Capacites applicatives (permissions currentes du package).
          JSONObject appCaps = new JSONObject();
          appCaps.put("audioMicFeature",
            cordova.getActivity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE));
          appCaps.put("gpsFeature",
            cordova.getActivity().getPackageManager().hasSystemFeature("android.hardware.location.gps"));
          appCaps.put("audioPermissionGranted",
            SDK >= 23 ? cordova.getActivity().checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                      == PackageManager.PERMISSION_GRANTED : true);
          appCaps.put("locationFineGranted",
            SDK >= 23 ? cordova.getActivity().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                      == PackageManager.PERMISSION_GRANTED : true);
          appCaps.put("locationCoarseGranted",
            SDK >= 23 ? cordova.getActivity().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                      == PackageManager.PERMISSION_GRANTED : true);
          data.put("applicationCapabilities", appCaps);

          // Orientation : niveau application (config XML).
          JSONArray orientationModes = new JSONArray();
          orientationModes.put("LANDSCAPE");
          orientationModes.put("PORTRAIT");
          data.put("orientationModes", orientationModes);

          // Cameras via CameraManager (camera2) — enumeration sans preview active.
          CameraManager cManager = (CameraManager) cordova.getActivity().getApplicationContext().getSystemService(Context.CAMERA_SERVICE);
          JSONArray cameras = new JSONArray();
          if (cManager != null) {
            for (String cameraId : cManager.getCameraIdList()) {
              JSONObject cam = new JSONObject();
              try {
                CameraCharacteristics ch = cManager.getCameraCharacteristics(cameraId);
                cam.put("cameraId", cameraId);
                Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
                cam.put("facing", facing == null ? "unknown"
                    : facing.intValue() == CameraCharacteristics.LENS_FACING_FRONT ? "front" : "rear");
                Integer hwLevel = ch.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                cam.put("hardwareLevel", hwLevel == null ? -1 : hwLevel.intValue());
                SizeF phys = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                if (phys != null) {
                  cam.put("sensorPhysicalWidth", phys.getWidth());
                  cam.put("sensorPhysicalHeight", phys.getHeight());
                }
                Size pixelArray = ch.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
                if (pixelArray != null) {
                  cam.put("sensorPixelWidth", pixelArray.getWidth());
                  cam.put("sensorPixelHeight", pixelArray.getHeight());
                }
              } catch (CameraAccessException e) {
                cam.put("cameraId", cameraId);
                cam.put("error", e.getMessage());
              }
              cameras.put(cam);
            }
          }
          data.put("cameras", cameras);

          // Profils CamcorderProfile reallement supportes.
          JSONArray profiles = new JSONArray();
          JSONObject capsMap = new JSONObject();
          capsMap.put("480P", CamcorderProfile.QUALITY_480P);
          capsMap.put("720P", CamcorderProfile.QUALITY_720P);
          capsMap.put("1080P", CamcorderProfile.QUALITY_1080P);
          capsMap.put("2160P", CamcorderProfile.QUALITY_2160P);
          capsMap.put("HIGH", CamcorderProfile.QUALITY_HIGH);
          for (String cameraId : cManager.getCameraIdList()) {
            JSONObject camProfiles = new JSONObject();
            camProfiles.put("cameraId", cameraId);
            JSONArray profs = new JSONArray();
            java.util.Iterator<String> it = capsMap.keys();
            while (it.hasNext()) {
              String name = it.next();
              int quality = capsMap.getInt(name);
              JSONObject p = new JSONObject();
              p.put("quality", name);
              if (CamcorderProfile.hasProfile(Integer.parseInt(cameraId), quality)) {
                CamcorderProfile cp = CamcorderProfile.get(Integer.parseInt(cameraId), quality);
                p.put("available", true);
                p.put("videoFrameWidth", cp.videoFrameWidth);
                p.put("videoFrameHeight", cp.videoFrameHeight);
                p.put("audioChannels", cp.audioChannels);
              } else {
                p.put("available", false);
              }
              profs.put(p);
            }
            camProfiles.put("profiles", profs);
            profiles.put(camProfiles);
          }
          data.put("camcorderProfiles", profiles);

          callbackContext.success(data);
        } catch (JSONException e) {
          callbackContext.error("JSON build failure: " + e.getMessage());
        } catch (CameraAccessException e) {
          callbackContext.error("Camera services inaccessible: " + e.getMessage());
        } catch (Exception e) {
          callbackContext.error("getCaptureCapabilities failure: " + e.getMessage());
        }
      }
    });
    return true;
  }

'''
if method not in s:
    if anchor not in s:
        raise SystemExit('ERREUR: anchor getCameraCharacteristics introuvable')
    s = s.replace(anchor, method + anchor, 1)
else:
    print('DEJA OK: methode getCaptureCapabilities')

PREVIEW.write_text(s, encoding='utf-8')
print('Patch capture-capabilities applique:', PREVIEW)

# --- Copie vers les sources compilees (plateforme) ----------------------------
if PLATFORM.exists():
    shutil.copy2(PREVIEW, PLATFORM / 'CameraPreview.java')
    print('Recopie vers plateforme:', PLATFORM / 'CameraPreview.java')
else:
    print('AVERTISSEMENT: plateforme non presente, pas de recopie')

# --- Verification ---------------------------------------------------------------
compiled = PLATFORM / 'CameraPreview.java'
if compiled.exists():
    t = compiled.read_text(encoding='utf-8')
    for marker in ('GET_CAPTURE_CAPABILITIES_ACTION', 'getCaptureCapabilities'):
        if marker not in t:
            raise SystemExit('ERREUR: %s absent des sources compilees' % marker)
    print('Verification OK: action getCaptureCapabilities presente dans les sources compilees')
else:
    print('AVERTISSEMENT: verif compilee ignoree (plateforme absente)')