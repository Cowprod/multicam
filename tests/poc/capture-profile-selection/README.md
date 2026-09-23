# POC — Capture Profile Selection

## Objectif

Prouver, avant J06, que le plugin caméra existant (`cordova-plugin-camera-preview`, pin
`3e5d768934b78e142c369e67f0234a618706500c`, v0.14.0) peut être étendu de façon **minimale
et générique** pour qu'un **profil CamcorderProfile explicite** demandé par l'appelant soit
réellement utilisé par `MediaRecorder` :

| Profil demandé | Résultat attendu dans le fichier enregistré |
|---|---|
| `720P` | 1280x720 |
| `1080P` | 1920x1080 |
| `2160P` (non supporté par les devices) | rejet déterministe, **pas** de fallback silencieux vers HIGH |

Verdict des mesures (devices B et C, caméra rear, clips ~3,4 s, piste audio AAC, vidéo H.264) :

| Clip | width x height | codec video | audio | durée (s) | SHA-256 (MP4) |
|---|---|---|---|---|---|
| `B-720P` | **1280x720** | h264 | aac | 3.413 | `ad690616e8a59c929f4645aea03fad8a942f9f06a994485b3cdd0079840ebb9d` |
| `B-1080P` | **1920x1080** | h264 | aac | 3.371 | `713baf65f131ddc9afcb0dff4aea1f07c47857ef2de4bea4481fed3c43a3b4c1` |
| `C-720P` | **1280x720** | h264 | aac | 3.392 | `9e113677136f708e63c3e7c9cd8ad16e35d6b2a4993016ae2316a32dc3b3f9d2` |
| `C-1080P` | **1920x1080** | h264 | aac | 3.392 | `742b541fa6900584b46dfb47f00b8c4aa19f06ebdcb26486d2c4caa5382b708b` |

Test négatif (`B-2160P-negative`) : `rejected=true`, erreur exacte
`PROFILE_NOT_SUPPORTED 2160P cameraId=0`, aucun fichier `.mp4` créé
(`/data/user/0/fr.emmanuel.multicam/cache/` vide après test), aucune trace de
`Starting recording` dans logcat.

## Chose changée (patch générique, rejouable)

`patch/apply_capture_profile_patch.py` (idempotent, backups `*.bak-captureprof`), appliqué
sur les sources du plugin dans `app/plugins/cordova-plugin-camera-preview/` :

1. **JS** (`www/CameraPreview.js`) : `startRecordVideo(opts)` accepte un 6e champ optionnel
   `opts.camcorderProfile`; s'il est absent → `null`, comportement historique inchangé.
2. **CameraPreview.java** : `startRecordVideo(..., String camcorderProfile, ...)` propage
   l'option dans `execute` et dans `onRequestPermissionResult` (re-demande de permission).
3. **CameraActivity.java** :
   - signature `startRecord(..., String camcorderProfile)`;
   - bloc de **validation avant tout effet de bord** (avant `muteStream` / `unlock` /
     création du `MediaRecorder`) : nom inconnu → `PROFILE_UNKNOWN <name>`; profil non
     supporté par la caméra (`CamcorderProfile.hasProfile(defaultCameraId, q)`) →
     `PROFILE_NOT_SUPPORTED <name> cameraId=<id>`. Les deux remontent via
     `onStartRecordVideoError` → erreur déterministe côté JS, **aucun fallback**;
   - sélection : si `camcorderProfile` donné et valide → `CamcorderProfile.get(defaultCameraId, q)`;
     sinon → cascade historique HIGH→480P→720P→1080P→LOW intacte;
   - helper `profileQualityForName()` mappe {LOW, HIGH, QCIF, CIF, QVGA, 480P, 720P, 1080P, 2160P}.
4. **plugin.xml** : déclarations `READ_MEDIA_IMAGES` + `READ_MEDIA_VIDEO` (correctif Android 13+).

### Correctif Android 13+ nécessaire (découvert pendant le POC)

`getVideoPermissions()` du plugin exige, sur Android ≥ 13 (Tiramisu), `READ_MEDIA_IMAGES`
et `READ_MEDIA_VIDEO` **en plus** de `CAMERA` / `RECORD_AUDIO`. Sans déclaration dans
`plugin.xml`, la demande runtime est *automatiquement refusée* par le système et
`onRequestPermissionResult` renvoie `ILLEGAL_ACCESS_EXCEPTION` — l'enregistrement est alors
impossible même avec un profil valide. Le patch ajoute ces deux permissions au manifest de
façon générique. Pour un plateau déjà initialisé, `run-capture-profile-selection.sh` les
injecte aussi dans `platforms/android/app/src/main/AndroidManifest.xml` avant build.

## Notes d'installation des runtime permissions

Les quatre permissions runtime sont octroyées par `adb shell pm grant` dans le script
(`CAMERA`, `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, plus READ/WRITE
_EXTERNAL_STORAGE) — ceci évite tout dialogue système pendant les probes.

## Rejouer

```bash
cd tests/poc/capture-profile-selection
./run-capture-profile-selection.sh
```

Cycle : restore sources plugin PRISTINES (`.bak-pixelcopy`, vérifiées identiques au pin
`3e5d768`) → patch PixelCopy (mécanisme existant) → patch capture-profile →
`cordova prepare` + recopie des 2 `.java` et re-wrapper `cordova.define` du `CameraPreview.js`
→ build → SHA-256 → install B + C → runtime grants → clips 720P/1080P (B, C) + négatif
2160P (B) → pull MP4 (run-as, cache) → ffprobe + checksums + logcat.

## Périmètre du POC

Strictement la **primitive d'enregistrement avec profil explicite**. À dessein, ne traite
PAS (et doit rester HORS de ce POC) : l'UI de Regie, la persistance des Takes, ARM,
l'orchestration REC, la policy J06 de warning/fallback quand une option globale dépasse la
capacité device (l'UI 05 validée autorise global > device avec warning — ce POC ne la
contredit pas et ne l'implémente pas), et toute logique durcie Xiaomi/Redmi.

## Interprétation J06

Rien ici ne réduit les options globales J06 aux capacités device : le POC prouve seulement
que **quand** un profil précis est demandé, le fichier produit correspond exactement. La
policy J06 (fallback / warning) reste à écrire dans J06 à partir de cette primitive.