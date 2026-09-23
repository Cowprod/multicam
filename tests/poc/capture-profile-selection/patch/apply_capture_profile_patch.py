#!/usr/bin/env python3
# POC Capture Profile Selection — greffe generique d'une selection explicite de
# profil CamcorderProfile a l'enregistrement video.
#
# Principe (strictement generique, aucune logique Take / fallback / modele) :
#   - JS  : startRecordVideo(opts) accepte un 6e champ optionnel
#           opts.camcorderProfile (ex. "720P", "1080P", "2160P", "HIGH").
#   - natif: CameraPreview.startRecordVideo / CameraActivity.startRecord
#           propagent cette option. Si presente :
#             * nom inconnu            -> erreur "PROFILE_UNKNOWN ..."
#             * profil non supporte    -> erreur "PROFILE_NOT_SUPPORTED ..."
#               via onStartRecordVideoError AVANT tout demarrage d'enregistrement.
#               Aucun fallback silencieux vers HIGH.
#             * profil supporte        -> CamcorderProfile.get(id, quality)
#           Si absente : comportement heritage (HIGH, puis cascade) conserve.
#
# Idempotent (marqueurs). Backup *-bak-captureprof.
#
# Usage : python3 apply_capture_profile_patch.py <ROOT_DIR>   (racine = app/)
from pathlib import Path
import sys, shutil

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
PLUGIN = ROOT / 'plugins' / 'cordova-plugin-camera-preview'
files = {'activity': PLUGIN/'src/android/CameraActivity.java',
         'preview': PLUGIN/'src/android/CameraPreview.java',
         'js': PLUGIN/'www/CameraPreview.js',
         'pluginxml': PLUGIN/'plugin.xml'}
for path in files.values():
    if not path.exists():
        raise SystemExit('ERREUR: fichier introuvable: %s' % path)


def backup(path):
    bak = Path(str(path) + '.bak-captureprof')
    if not bak.exists():
        shutil.copy2(path, bak)


def replace_once(text, old, new, label):
    if new in text:
        print('DEJA OK:', label)
        return text
    if old not in text:
        raise SystemExit('ERREUR: anchor introuvable pour %s' % label)
    return text.replace(old, new, 1)


# ---------------------------------------------------------------- CameraActivity
p = files['activity']; backup(p); s = p.read_text(encoding='utf-8')

s = replace_once(s,
    '  public void startRecord(final String filePath, final String camera, final int width, final int height, final int quality, final boolean withFlash){\n',
    '  public void startRecord(final String filePath, final String camera, final int width, final int height, final int quality, final boolean withFlash, final String camcorderProfile){\n',
    'signature startRecord')

# Validation explicite du profil AVANT tout effet de bord (avant muteStream/unlock).
anchor_activity = '    if(mCamera != null) {\n      Activity activity = getActivity();\n      muteStream(true, activity);\n'
validation = (
    '    if(mCamera != null) {\n'
    '      Activity activity = getActivity();\n'
    '      // ---- POC capture-profile-selection : profil CamcorderProfile explicite ----\n'
    '      CamcorderProfile requestedProfile = null;\n'
    '      String profileError = null;\n'
    '      if (camcorderProfile != null && !camcorderProfile.trim().isEmpty()) {\n'
    '        Integer profileQuality = profileQualityForName(camcorderProfile);\n'
    '        if (profileQuality == null) {\n'
    '          profileError = "PROFILE_UNKNOWN " + camcorderProfile.trim();\n'
    '        } else if (!CamcorderProfile.hasProfile(defaultCameraId, profileQuality)) {\n'
    '          profileError = "PROFILE_NOT_SUPPORTED " + camcorderProfile.trim() + " cameraId=" + defaultCameraId;\n'
    '        } else {\n'
    '          requestedProfile = CamcorderProfile.get(defaultCameraId, profileQuality);\n'
    '        }\n'
    '      }\n'
    '      if (profileError != null) {\n'
    '        Log.e(TAG, "Recording rejected (explicit profile): " + profileError);\n'
    '        eventListener.onStartRecordVideoError(profileError);\n'
    '        return;\n'
    '      }\n'
    '      muteStream(true, activity);\n'
)
if validation not in s:
    if anchor_activity not in s:
        raise SystemExit('ERREUR: anchor startRecord debut introuvable')
    s = s.replace(anchor_activity, validation, 1)
else:
    print('DEJA OK: validation explicite profil')

# Remplacement de la sequence hardcodee par : profil demande OU chaine historique.
old_chain = (
    '        CamcorderProfile profile;\n'
    '        if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_HIGH)) {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_HIGH);\n'
    '        } else {\n'
    '          if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_480P)) {\n'
    '            profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_480P);\n'
    '          } else {\n'
    '            if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_720P)) {\n'
    '              profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_720P);\n'
    '            } else {\n'
    '              if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_1080P)) {\n'
    '                profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_1080P);\n'
    '              } else {\n'
    '                profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_LOW);\n'
    '              }\n'
    '            }\n'
    '          }\n'
    '        }\n'
)
new_chain = (
    '        CamcorderProfile profile;\n'
    '        if (requestedProfile != null) {\n'
    '          profile = requestedProfile;\n'
    '        } else if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_HIGH)) {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_HIGH);\n'
    '        } else if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_480P)) {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_480P);\n'
    '        } else if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_720P)) {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_720P);\n'
    '        } else if (CamcorderProfile.hasProfile(defaultCameraId, CamcorderProfile.QUALITY_1080P)) {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_1080P);\n'
    '        } else {\n'
    '          profile = CamcorderProfile.get(defaultCameraId, CamcorderProfile.QUALITY_LOW);\n'
    '        }\n'
)
if new_chain not in s:
    if old_chain not in s:
        raise SystemExit('ERREUR: anchor chaine profil introuvable')
    s = s.replace(old_chain, new_chain, 1)
    print('PATCH: chaine profil explicite')
else:
    print('DEJA OK: chaine profil explicite')

# Helper de mapping nom -> constante CamcorderProfile.
helper_anchor = '  public int calculateOrientationHint() {\n'
helper = (
    '  private static Integer profileQualityForName(String name) {\n'
    '    if (name == null) return null;\n'
    '    String n = name.trim().toUpperCase();\n'
    '    if ("LOW".equals(n)) return CamcorderProfile.QUALITY_LOW;\n'
    '    if ("HIGH".equals(n)) return CamcorderProfile.QUALITY_HIGH;\n'
    '    if ("QCIF".equals(n)) return CamcorderProfile.QUALITY_QCIF;\n'
    '    if ("CIF".equals(n)) return CamcorderProfile.QUALITY_CIF;\n'
    '    if ("QVGA".equals(n)) return CamcorderProfile.QUALITY_QVGA;\n'
    '    if ("480P".equals(n)) return CamcorderProfile.QUALITY_480P;\n'
    '    if ("720P".equals(n)) return CamcorderProfile.QUALITY_720P;\n'
    '    if ("1080P".equals(n)) return CamcorderProfile.QUALITY_1080P;\n'
    '    if ("2160P".equals(n)) return CamcorderProfile.QUALITY_2160P;\n'
    '    return null;\n'
    '  }\n'
    '\n'
)
if helper not in s:
    if helper_anchor not in s:
        raise SystemExit('ERREUR: anchor calculateOrientationHint introuvable')
    s = s.replace(helper_anchor, helper + helper_anchor, 1)
    print('PATCH: helper profileQualityForName')
else:
    print('DEJA OK: helper profileQualityForName')

p.write_text(s, encoding='utf-8')

# ------------------------------------------------------------------- CameraPreview
p = files['preview']; backup(p); s = p.read_text(encoding='utf-8')

s = replace_once(s,
    'return startRecordVideo(args.getString(0), args.getInt(1), args.getInt(2), args.getInt(3), args.getBoolean(4), callbackContext);',
    'return startRecordVideo(args.getString(0), args.getInt(1), args.getInt(2), args.getInt(3), args.getBoolean(4), args.optString(5, null), callbackContext);',
    'execute -> startRecordVideo + camcorderProfile')

s = replace_once(s,
    'startRecordVideo(this.execArgs.getString(0), this.execArgs.getInt(1), this.execArgs.getInt(2), this.execArgs.getInt(3), this.execArgs.getBoolean(4),  this.execCallback);',
    'startRecordVideo(this.execArgs.getString(0), this.execArgs.getInt(1), this.execArgs.getInt(2), this.execArgs.getInt(3), this.execArgs.getBoolean(4), this.execArgs.optString(5, null), this.execCallback);',
    'onRequestPermissionResult -> startRecordVideo + camcorderProfile')

s = replace_once(s,
    'private boolean startRecordVideo(final String camera, final int width, final int height, final int quality, final boolean withFlash, CallbackContext callbackContext) {',
    'private boolean startRecordVideo(final String camera, final int width, final int height, final int quality, final boolean withFlash, final String camcorderProfile, CallbackContext callbackContext) {',
    'startRecordVideo signature + camcorderProfile')

s = replace_once(s,
    'fragment.startRecord(getFilePath(filename), camera, width, height, quality, withFlash);',
    'fragment.startRecord(getFilePath(filename), camera, width, height, quality, withFlash, camcorderProfile);',
    'fragment.startRecord + camcorderProfile')

p.write_text(s, encoding='utf-8')

# -------------------------------------------------------------------------- JS
p = files['js']; backup(p); s = p.read_text(encoding='utf-8')

s = replace_once(s,
    '  exec(onSuccess, onError, PLUGIN_NAME, "startRecordVideo", [opts.cameraDirection, opts.width, opts.height, opts.quality, opts.withFlash]);',
    '  exec(onSuccess, onError, PLUGIN_NAME, "startRecordVideo", [opts.cameraDirection, opts.width, opts.height, opts.quality, opts.withFlash, opts.camcorderProfile || null]);',
    'JS wrapper + camcorderProfile')

p.write_text(s, encoding='utf-8')

# ------------------------------------------------------------------------ plugin.xml
# Correctif necessaire (Android 13+) : getVideoPermissions() exige
# READ_MEDIA_IMAGES / READ_MEDIA_VIDEO a l'enregistrement, mais le plugin ne les
# declare pas. Sans declaration, la demande runtime est automatiquement refusee
# (ILLEGAL_ACCESS_EXCEPTION) AVANT la creation du MediaRecorder. Declarations
# ajoutees de facon generique.
p = files['pluginxml']; backup(p); s = p.read_text(encoding='utf-8')

xml_anchor = '      <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
xml_add = (
    '      <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
    '      <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />\n'
    '      <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />\n'
)
if 'READ_MEDIA_IMAGES' in s:
    print('DEJA OK: plugin.xml READ_MEDIA_*')
else:
    if xml_anchor not in s:
        raise SystemExit('ERREUR: anchor RECORD_AUDIO plugin.xml introuvable')
    s = s.replace(xml_anchor, xml_add, 1)
    print('PATCH: plugin.xml READ_MEDIA_*')
p.write_text(s, encoding='utf-8')

print('Patch Capture Profile Selection appliqué:', PLUGIN)