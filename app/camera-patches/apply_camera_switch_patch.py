#!/usr/bin/env python3
"""
Patch J09-07 Camera Switch cible — plugin cordova-plugin-camera-preview (app).

Deux actions natives greffees, strictement generiques (aucune logique Take,
segment, WS ni UI) :

  1. `switchCameraTo(facing)` — bascule CIBLEE vers un facing explicite
     ("back" | "front"), au lieu du cycle aveugle `(locked + 1) % N` de
     `switchCamera()`. Renvoie la camera REELLEMENT ouverte.

  2. `getCameraState()` — etat natif honnete : facing demande, facing
     effectivement verrouillé, cameraId du recorder, nombre de cameras,
     preview presente, enregistrement en cours.

Pourquoi un patch est indispensable (§35.3 « confirmation reelle ») :
  - `switchCamera()` (upstream) ne prend AUCUN argument : impossible de viser
    REAR ou FRONT sur un appareil 3+ cameras ;
  - `getCameraCharacteristics()` (upstream) renvoie les caracteristiques de
    TOUTES les cameras, jamais celle qui est ouverte ;
  - `switchCamera()` ne met PAS a jour `defaultCameraId`. Or `startRecord()`
    choisit son `CamcorderProfile` via `defaultCameraId` : apres une bascule en
    place, un nouvel enregistrement demarrerait avec le profil de l'ANCIENNE
    camera. Le patch aligne `defaultCameraId` ET `defaultCamera` sur la camera
    reellement ouverte (la camera devient « sticky » : un cycle
    arriere-plan/premier-plan rebascule sur la camera choisie, pas sur celle du
    demarrage d'origine).
  - `startCamera()` refuse explicitement (« Camera already started ») tant que
    le fragment existe : la reconfiguration passe donc par `switchCameraTo`, qui
    conserve le meme SurfaceView (pas de destruction de fragment, donc pas de
    blip de preview et pas de renegociation du cycle de vie par
    `preview-service.js`).

Ancrages : commit upstream epingle 3e5d768934b78e142c369e67f0234a618706500c.
Idempotent (marqueurs + « DEJA OK »). Backup *-bak-camswitch.
Recopie vers platforms/android + verification des marqueurs.

Usage (racine repo ou dossier app) :
  python3 app/camera-patches/apply_camera_switch_patch.py .
"""
from pathlib import Path
import sys, shutil

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
APP = ROOT / 'app'
if (APP / 'config.xml').exists():
    ROOT = APP
PLUGIN = ROOT / 'plugins' / 'cordova-plugin-camera-preview'
ACTIVITY = PLUGIN / 'src/android/CameraActivity.java'
PREVIEW = PLUGIN / 'src/android/CameraPreview.java'
JS = PLUGIN / 'www/CameraPreview.js'
PLATFORM = ROOT / 'platforms/android/app/src/main/java/com/cordovaplugincamerapreview'

for path in (ACTIVITY, PREVIEW, JS):
    if not path.exists():
        raise SystemExit('ERREUR: fichier introuvable (installer le plugin d abord): %s' % path)


def replace_once(text, old, new, label, marker=None):
    # `marker` teste l'idempotence sur un FRAGMENT stable plutot que sur `new`
    # en entier. Indispensable ici : nos ancres sont des lignes DE CONSTANTES
    # voisines, et le test `new in text` suppose qu'elles le restent. Or les
    # autres patchs (J06, J09-07) insèrent eux aussi des constantes juste
    # apres cette meme ligne : le bloc insere se retrouve alors non adjacent,
    # `new in text`echoue, et une re-application duplique la declaration — ce
    # que le compilateur Android refuse ("already defined in class"). Un test
    # par marqueur rend le patch idempotent quel que soit l'ordre d'application.
    probe = marker if marker is not None else new
    if probe in text:
        print('DEJA OK:', label)
        return text
    if old not in text:
        raise SystemExit('ERREUR: anchor introuvable pour %s' % label)
    return text.replace(old, new, 1)


# =========================================================== CameraActivity.java
p = ACTIVITY
bak = Path(str(p) + '.bak-camswitch')
if not bak.exists():
    shutil.copy2(p, bak)
s = p.read_text(encoding='utf-8')

s = replace_once(s,
    'import org.apache.cordova.LOG;\n',
    'import org.apache.cordova.LOG;\n\nimport org.json.JSONException;\nimport org.json.JSONObject;\n',
    'import org.json (CameraActivity)')

ACTIVITY_METHODS = r'''  // ---- J09-07 : bascule camera CIBLEE + etat natif honnete ----------------
  // getters d etat (lecture seule, aucun effet de bord)
  public int getCameraCurrentlyLocked() {
    return cameraCurrentlyLocked;
  }

  public int getDefaultCameraId() {
    return defaultCameraId;
  }

  public int getAvailableCameraCount() {
    return Camera.getNumberOfCameras();
  }

  public boolean isRecordingNow() {
    return mRecorder != null;
  }

  // Resout un facing ("back"|"front") en cameraId de l API Camera (legacy).
  // Renvoie -1 si aucune camera ne porte ce facing.
  private int resolveCameraIdForFacing(String facing) {
    int wanted = "front".equals(facing)
        ? Camera.CameraInfo.CAMERA_FACING_FRONT
        : Camera.CameraInfo.CAMERA_FACING_BACK;
    int n = Camera.getNumberOfCameras();
    Camera.CameraInfo info = new Camera.CameraInfo();
    for (int i = 0; i < n; i++) {
      try {
        Camera.getCameraInfo(i, info);
      } catch (Throwable t) {
        continue;
      }
      if (info.facing == wanted) return i;
    }
    return -1;
  }

  public String facingForCameraId(int id) {
    if (id < 0) return null;
    Camera.CameraInfo info = new Camera.CameraInfo();
    try {
      Camera.getCameraInfo(id, info);
    } catch (Throwable t) {
      return null;
    }
    if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) return "front";
    if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) return "back";
    return null;
  }

  // Bascule vers un facing EXPLICITE. Remplace le cycle `(locked + 1) % N`.
  // Retourne un JSON string ; "ok":"false" = echec avec camera restauree.
  public String switchCameraTo(String facing) {
    long t0 = System.currentTimeMillis();
    JSONObject res = new JSONObject();
    int n = Camera.getNumberOfCameras();
    try {
      res.put("requestedFacing", facing);
      res.put("numberOfCameras", n);

      if (n < 1) {
        res.put("ok", false);
        res.put("error", "NO_CAMERA");
        return res.toString();
      }
      // Garde-fou natif : la camera est DEVERROUILLEE et tenue par le
      // MediaRecorder pendant un enregistrement. La relacher detruirait le
      // segment en cours. Le JS segment deja (stop avant bascule) ; cette
      // porte refuse un eventuel appel concurrent errone.
      if (mRecorder != null) {
        res.put("ok", false);
        res.put("error", "RECORDING_IN_PROGRESS");
        res.put("cameraCurrentlyLocked", cameraCurrentlyLocked);
        return res.toString();
      }
      int targetId = resolveCameraIdForFacing(facing);
      if (targetId < 0) {
        res.put("ok", false);
        res.put("error", "FACING_NOT_AVAILABLE");
        return res.toString();
      }
      res.put("targetCameraId", targetId);

      // Idempotence native : deja active -> succes immediat, AUCUN toggle.
      if (mCamera != null && targetId == cameraCurrentlyLocked) {
        defaultCameraId = targetId;
        defaultCamera = facing;
        res.put("ok", true);
        res.put("alreadyActive", true);
        res.put("cameraCurrentlyLocked", cameraCurrentlyLocked);
        res.put("facing", facing);
        res.put("durationMs", System.currentTimeMillis() - t0);
        return res.toString();
      }

      int previousId = cameraCurrentlyLocked;
      // 1. liberer la camera courante (identique a switchCamera() upstream)
      if (mCamera != null) {
        try { mCamera.stopPreview(); } catch (Throwable t) { }
        mPreview.setCamera(null, -1);
        mCamera.release();
        mCamera = null;
      }
      // 2. ouvrir la camera cible
      Camera opened;
      try {
        opened = Camera.open(targetId);
      } catch (Throwable t) {
        // restauration de la camera precedente avant de rendre la main
        if (previousId >= 0 && previousId < n) {
          try {
            mCamera = Camera.open(previousId);
            cameraCurrentlyLocked = previousId;
            mPreview.switchCamera(mCamera, cameraCurrentlyLocked);
            mCamera.startPreview();
            Log.d(TAG, "switchCameraTo: restauration camera " + previousId);
          } catch (Throwable t2) {
            mCamera = null;
          }
        }
        res.put("ok", false);
        res.put("error", "CAMERA_OPEN_FAILED");
        res.put("message", t.getMessage() == null ? t.toString() : t.getMessage());
        res.put("cameraCurrentlyLocked", cameraCurrentlyLocked);
        return res.toString();
      }
      mCamera = opened;
      // 3. aligner l ETAT sur la camera reellement ouverte (correction du
      //    defaultCameraId perime qui ferait demarrer le prochain recorder
      //    avec le CamcorderProfile de l ancienne camera).
      cameraCurrentlyLocked = targetId;
      defaultCameraId = targetId;
      defaultCamera = facing;
      // 4. reconfigurer la PreviewSurface et relancer l apercu
      mPreview.switchCamera(mCamera, cameraCurrentlyLocked);
      mCamera.startPreview();

      res.put("ok", true);
      res.put("alreadyActive", false);
      res.put("cameraCurrentlyLocked", cameraCurrentlyLocked);
      res.put("defaultCameraId", defaultCameraId);
      res.put("facing", facing);
      res.put("recording", mRecorder != null);
      res.put("durationMs", System.currentTimeMillis() - t0);
      Log.d(TAG, "J09_CAMERA_SWITCH_NATIVE from=" + previousId + " to=" + targetId
          + " facing=" + facing + " dt=" + (System.currentTimeMillis() - t0) + "ms");
      return res.toString();
    } catch (JSONException e) {
      return "{\"ok\":false,\"error\":\"JSON_BUILD_FAILURE\"}";
    } catch (Throwable t) {
      return "{\"ok\":false,\"error\":\"SWITCH_UNEXPECTED\"}";
    }
  }

  public String cameraStateJson() {
    JSONObject res = new JSONObject();
    try {
      res.put("defaultCamera", defaultCamera == null ? JSONObject.NULL : defaultCamera);
      res.put("defaultCameraId", defaultCameraId);
      res.put("cameraCurrentlyLocked", cameraCurrentlyLocked);
      res.put("facing", facingForCameraId(cameraCurrentlyLocked));
      res.put("numberOfCameras", Camera.getNumberOfCameras());
      res.put("hasCamera", mCamera != null);
      res.put("recording", mRecorder != null);
      res.put("recordFilePath", recordFilePath == null ? "" : recordFilePath);
      res.put("ok", true);
    } catch (JSONException e) {
      return "{\"ok\":false,\"error\":\"JSON_BUILD_FAILURE\"}";
    }
    return res.toString();
  }

  public void setCameraParameters(Camera.Parameters params) {'''

s = replace_once(s,
    '  public void setCameraParameters(Camera.Parameters params) {',
    ACTIVITY_METHODS,
    'methodes J09-07 (switchCameraTo / cameraStateJson / getters)')

p.write_text(s, encoding='utf-8')
print('Patch CameraActivity applique:', ACTIVITY)


# ============================================================ CameraPreview.java
p = PREVIEW
bak = Path(str(p) + '.bak-camswitch')
if not bak.exists():
    shutil.copy2(p, bak)
s = p.read_text(encoding='utf-8')

s = replace_once(s,
    '  private static final String GET_CAMERA_CHARACTERISTICS_ACTION = "getCameraCharacteristics";\n',
    '  private static final String GET_CAMERA_CHARACTERISTICS_ACTION = "getCameraCharacteristics";\n'
    '  private static final String SWITCH_CAMERA_TO_ACTION = "switchCameraTo";\n'
    '  private static final String GET_CAMERA_STATE_ACTION = "getCameraState";\n',
    'actions switchCameraTo / getCameraState',
    marker='private static final String SWITCH_CAMERA_TO_ACTION')

s = replace_once(s,
    '    } else if (GET_CAMERA_CHARACTERISTICS_ACTION.equals(action)) {\n'
    '      return getCameraCharacteristics(callbackContext);\n',
    '    } else if (GET_CAMERA_CHARACTERISTICS_ACTION.equals(action)) {\n'
    '      return getCameraCharacteristics(callbackContext);\n'
    '    } else if (SWITCH_CAMERA_TO_ACTION.equals(action)) {\n'
    '      return switchCameraTo(args.getString(0), callbackContext);\n'
    '    } else if (GET_CAMERA_STATE_ACTION.equals(action)) {\n'
    '      return getCameraState(callbackContext);\n',
    'execute branch switchCameraTo / getCameraState',
    marker='SWITCH_CAMERA_TO_ACTION.equals(action)')

PREVIEW_METHODS = r'''  // ---- J09-07 ----------------------------------------------------------------
  // Le fragment doit etre pose : on refuse explicitement plutot que de
  // renvoyer un succes qui ne correspondrait a aucune bascule reelle.
  private boolean switchCameraTo(String facing, CallbackContext callbackContext) {
    if (this.hasView(callbackContext) == false) {
      return true;
    }
    final String want = (facing == null || facing.isEmpty())
        ? ((fragment.defaultCamera == null) ? "back" : fragment.defaultCamera)
        : facing;
    cordova.getThreadPool().execute(new Runnable() {
      @Override public void run() {
        String raw = fragment.switchCameraTo(want);
        Log.d(TAG, "J09_CAMERA_SWITCH_RESULT target=" + want + " detail=" + raw);
        try {
          JSONObject data = new JSONObject(raw);
          if (data.optBoolean("ok", false)) {
            callbackContext.success(data);
          } else {
            // echec natif remonte tel quel : le JS ne doit PAS annoncer un
            // succes de bascule sur un simple callback Cordova.
            callbackContext.error(raw);
          }
        } catch (JSONException e) {
          callbackContext.error("{\"ok\":false,\"error\":\"PARSE_FAILURE\"}");
        }
      }
    });
    return true;
  }

  private boolean getCameraState(CallbackContext callbackContext) {
    if (fragment == null) {
      try {
        JSONObject data = new JSONObject();
        data.put("ok", true);
        data.put("hasCamera", false);
        data.put("recording", false);
        data.put("numberOfCameras", android.hardware.Camera.getNumberOfCameras());
        data.put("defaultCamera", org.json.JSONObject.NULL);
        data.put("facing", null);
        data.put("cameraCurrentlyLocked", -1);
        data.put("defaultCameraId", -1);
        data.put("recordFilePath", "");
        callbackContext.success(data);
      } catch (JSONException e) {
        callbackContext.error("{\"ok\":false,\"error\":\"JSON_BUILD_FAILURE\"}");
      }
      return true;
    }
    try {
      callbackContext.success(new JSONObject(fragment.cameraStateJson()));
    } catch (JSONException e) {
      callbackContext.error("{\"ok\":false,\"error\":\"JSON_BUILD_FAILURE\"}");
    }
    return true;
  }

  private boolean getCameraCharacteristics(CallbackContext callbackContext) {'''

s = replace_once(s,
    '  private boolean getCameraCharacteristics(CallbackContext callbackContext) {',
    PREVIEW_METHODS,
    'methodes plugin switchCameraTo / getCameraState')

p.write_text(s, encoding='utf-8')
print('Patch CameraPreview applique:', PREVIEW)


# ============================================================ www/CameraPreview.js
p = JS
bak = Path(str(p) + '.bak-camswitch')
if not bak.exists():
    shutil.copy2(p, bak)
s = p.read_text(encoding='utf-8')

s = replace_once(s,
    'CameraPreview.switchCamera = function(onSuccess, onError) {\n'
    '  exec(onSuccess, onError, PLUGIN_NAME, "switchCamera", []);\n'
    '};\n',
    'CameraPreview.switchCamera = function(onSuccess, onError) {\n'
    '  exec(onSuccess, onError, PLUGIN_NAME, "switchCamera", []);\n'
    '};\n'
    '\n'
    'CameraPreview.switchCameraTo = function(facing, onSuccess, onError) {\n'
    '  exec(onSuccess, onError, PLUGIN_NAME, "switchCameraTo", [facing]);\n'
    '};\n'
    '\n'
    'CameraPreview.getCameraState = function(onSuccess, onError) {\n'
    '  exec(onSuccess, onError, PLUGIN_NAME, "getCameraState", []);\n'
    '};\n',
    'wrapper JS switchCameraTo / getCameraState')

p.write_text(s, encoding='utf-8')
print('Patch wrapper JS applique:', JS)


# --------------------------------------------- copie vers les sources compilees
if PLATFORM.exists():
    shutil.copy2(ACTIVITY, PLATFORM / 'CameraActivity.java')
    shutil.copy2(PREVIEW, PLATFORM / 'CameraPreview.java')
    print('Recopie vers plateforme:', PLATFORM)
else:
    print('AVERTISSEMENT: plateforme non presente, pas de recopie')


# ------------------------------------------------------------------ verification
checks = [
    (PLATFORM / 'CameraActivity.java', ('public String switchCameraTo(String facing)',
                                        'public String cameraStateJson()',
                                        'public int getCameraCurrentlyLocked()')),
    (PLATFORM / 'CameraPreview.java', ('SWITCH_CAMERA_TO_ACTION', 'GET_CAMERA_STATE_ACTION',
                                       'private boolean switchCameraTo(',
                                       'private boolean getCameraState(')),
]
for path, markers in checks:
    if not path.exists():
        print('AVERTISSEMENT: verification ignoree (%s absent)' % path)
        continue
    t = path.read_text(encoding='utf-8')
    for marker in markers:
        if marker not in t:
            raise SystemExit('ERREUR: %s absent des sources compilees %s' % (marker, path))
    print('Verification OK:', path.name, 'marqueurs J09-07 presents')