#!/usr/bin/env python3
"""
Patch J08 Video Permissions — plugin cordova-plugin-camera-preview (app).

Corrige un blocage camerasque durable du master : sur Android 13+ (TIRAMISU),
`getVideoPermissions()` exige QUATRE permissions avant d'appeler
`startRecordVideo` :

    CAMERA, RECORD_AUDIO, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO

READ_MEDIA_IMAGES/READ_MEDIA_VIDEO ne sont PAS declarees dans le manifest de
l'app (l'app n'ecrit que dans son cache : `getCacheDir()/videoTmp.mp4`, cf.
CameraActivity.startRecord). La demande runtime est donc refusee sans dialogue,
`onRequestPermissionResult` tombe dans sa branche PERMISSION_DENIED et renvoie
`PluginResult.Status.ILLEGAL_ACCESS_EXCEPTION` → le JS recoit exactement
"Illegal access" (le message generique de `PluginResult.StatusMessages[2]`).

Consequence observee sur les 4 devices de la campagne J08 :
`startRecordVideo_failed:Illegal access` sur TOUTES les Captures, sans aucun log
cote camera (le native n'echoue jamais : il n'est jamais appele). La
synchronisation du top, elle, etait correcte (ecarts 1,5–2,5 ms).

Le patch :
 1. `getVideoPermissions()` ne demande plus que CAMERA + RECORD_AUDIO — les
    seules permissions reellement necessaires a MediaRecorder vers le cache ;
 2. `onRequestPermissionResult` n'agit QUE sur ses propres requestCode
    (CAM_REQ_CODE / VID_REQ_CODE) au lieu de repondre "Illegal access" a un
    callback perime pour tout refus d'une AUTRE demande de permission
    (POST_NOTIFICATIONS, stockage, localisation...). C'est la source du message
    trompeur : le symptome designait la camera alors que la cause etait une
    permission sans rapport.

Reproductible : anchors stables du master pinge + gardes idempotentes (DEJA OK)
+ recopie vers platforms/android + verification markers.

Usage (racine repo ou dossier app) :
  python3 app/camera-patches/apply_video_permission_patch.py .
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


bak = Path(str(PREVIEW) + '.bak-videoperm')
if not bak.exists():
    shutil.copy2(PREVIEW, bak)

s = PREVIEW.read_text(encoding='utf-8')

# --- 1. getVideoPermissions() : CAMERA + RECORD_AUDIO seulement ---------------
s = replace_once(
    s,
    '  private String[] getVideoPermissions() {\n'
    '    ArrayList<String> permissions = new ArrayList<>();\n'
    '\n'
    '    permissions.add(Manifest.permission.CAMERA);\n'
    '    permissions.add(Manifest.permission.RECORD_AUDIO);\n'
    '\n'
    '    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {\n'
    '      permissions.add(Manifest.permission.READ_MEDIA_IMAGES);\n'
    '      permissions.add(Manifest.permission.READ_MEDIA_VIDEO);\n'
    '    } else {\n'
    '      // Android API 32 or lower\n'
    '      permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE);\n'
    '      permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);\n'
    '    }\n'
    '\n'
    '    return permissions.toArray(new String[0]);\n'
    '  }\n',
    '  private String[] getVideoPermissions() {\n'
    '    // PATCH J08 : seules les permissions exiges par MediaRecorder vers le\n'
    '    // cache de l app. READ_MEDIA_IMAGES/VIDEO (API 33+) et le stockage\n'
    '    // externe ne sont pas declares au manifest et ne sont pas necessaires\n'
    '    // pour enregistrer : leur demander faisait echouer startRecordVideo\n'
    '    // avec "Illegal access" sur les 4 devices de la campagne J08.\n'
    '    ArrayList<String> permissions = new ArrayList<>();\n'
    '\n'
    '    permissions.add(Manifest.permission.CAMERA);\n'
    '    permissions.add(Manifest.permission.RECORD_AUDIO);\n'
    '\n'
    '    return permissions.toArray(new String[0]);\n'
    '  }\n',
    'getVideoPermissions (2 permissions)')

# --- 2. la branche execute() ne teste plus 4 permissions ----------------------
s = replace_once(
    s,
    '      if (cordova.hasPermission(videoPermissions[0]) && cordova.hasPermission(videoPermissions[1]) && cordova.hasPermission(videoPermissions[2]) && cordova.hasPermission(videoPermissions[3])) {\n',
    '      if (cordova.hasPermission(videoPermissions[0]) && cordova.hasPermission(videoPermissions[1])) {\n',
    'execute: test de permissions video (2 au lieu de 4)')

# --- 3. onRequestPermissionResult : ne repond que a ses propres requestCode ---
s = replace_once(
    s,
    '  public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {\n'
    '    for(int r:grantResults){\n'
    '      if(r == PackageManager.PERMISSION_DENIED){\n'
    '        execCallback.sendPluginResult(new PluginResult(PluginResult.Status.ILLEGAL_ACCESS_EXCEPTION));\n'
    '        return;\n'
    '      }\n'
    '    }\n'
    '\n'
    '    if(requestCode == CAM_REQ_CODE){\n',
    '  public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {\n'
    '    // PATCH J08 : ce callback est distribue a TOUS les plugins par Cordova.\n'
    '    // Sans ce filtre, le refus d une permission sans rapport (notifications,\n'
    '    // stockage, localisation) repondait "Illegal access" a un callback\n'
    '    // perime et masquait la vraie cause de l echec.\n'
    '    if(requestCode != CAM_REQ_CODE && requestCode != VID_REQ_CODE){\n'
    '      return;\n'
    '    }\n'
    '    for(int r:grantResults){\n'
    '      if(r == PackageManager.PERMISSION_DENIED){\n'
    '        if(execCallback != null){\n'
    '          execCallback.sendPluginResult(new PluginResult(PluginResult.Status.ILLEGAL_ACCESS_EXCEPTION));\n'
    '        }\n'
    '        return;\n'
    '      }\n'
    '    }\n'
    '\n'
    '    if(requestCode == CAM_REQ_CODE){\n',
    'onRequestPermissionResult (filtre requestCode)')

PREVIEW.write_text(s, encoding='utf-8')
print('Patch video-permissions applique:', PREVIEW)

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
    for forbidden in ('permissions.add(Manifest.permission.READ_MEDIA_',
                      'permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)',
                      'permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)',
                      'hasPermission(videoPermissions[2])',
                      'hasPermission(videoPermissions[3])'):
        if forbidden in t:
            raise SystemExit('ERREUR: startRecordVideo exige encore %s' % forbidden)
    for marker in ('PATCH J08', 'requestCode != CAM_REQ_CODE && requestCode != VID_REQ_CODE'):
        if marker not in t:
            raise SystemExit('ERREUR: %s absent des sources compilees' % marker)
    print('Verification OK: startRecordVideo n exige plus que CAMERA + RECORD_AUDIO')
else:
    print('AVERTISSEMENT: verif compilee ignoree (plateforme absente)')
