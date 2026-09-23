# VALIDATION — POC Capture Profile Selection

Date : 2026-09-23
Branche : `poc/capture-profile-selection`
Point de départ : `main` (`a0fb97e`)
Plugin épinglé : `cordova-plugin-camera-preview` commit `3e5d768934b78e142c369e67f0234a618706500c` (v0.14.0)

## Apk testé

- APK : `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256 : `75c85e376df290d6f878f4efb8156b1fb54f153c12029c7ba2fcf95a0750934b`
  (see `evidence/apk-sha256.txt`)
- Installé sur B (`61d54bba7d91`, deviceId `cc02e8fe-91f8-41cd-bfdc-a112072862db`) et
  C (`c0d8514d7d87`, deviceId `ecfc17ba-481a-4a21-9318-5dec8b4c5e1e`).
  Tablettes identiques Xiaomi `24075RP89G`, Android SDK 36, 2 caméras, hardware LEGACY.

## Critères et résultats

### 720P → réellement 1280x720

| Cible | ffprobe width x height | Stream |
|---|---|---|
| B | 1280x720 | video h264 299/12 fps + audio aac |
| C | 1280x720 | video h264 299/12 fps + audio aac |

Preuves : `evidence/B-720P.ffprobe.json`, `evidence/C-720P.ffprobe.json`.

### 1080P → réellement 1920x1080

| Cible | ffprobe width x height | Stream |
|---|---|---|
| B | 1920x1080 | video h264 299/12 fps + audio aac |
| C | 1920x1080 | video h264 299/12 fps + audio aac |

Preuves : `evidence/B-1080P.ffprobe.json`, `evidence/C-1080P.ffprobe.json`.

### Négatif 2160P → rejet déterministe, pas de fallback

| Champ | Valeur |
|---|---|
| `rejected` | `true` |
| erreur exacte | `PROFILE_NOT_SUPPORTED 2160P cameraId=0` |
| `unexpectedFile` | `null` |
| logcat | `Recording rejected (explicit profile): PROFILE_NOT_SUPPORTED 2160P cameraId=0` — aucune ligne `Starting recording` ensuite |

Preuves : `evidence/B-2160P-negative.probe.json`, `evidence/B-2160P-negative.log`.
Coherence device : B et C sont les seuls devices `adb` connectés pendant le run ; les
deviceId (`cc02e8fe…`, `ecfc17ba…`) correspondent au POC capture-capabilities précédent.

## Preuves complémentaires

- `evidence/*.probe.json` — transcriptions JS (startRecordVideo / stopRecordVideo / stopCamera,
  l'erreur négative exacte).
- `evidence/*.log` — logcat filtré (CameraPreview / CameraActivity) montrant le passage
  `startRecord` → `Starting recording` pour chaque clip, ou le rejet 2160P.
- `evidence/*.sha256` — checksums des MP4 (les MP4 eux-mêmes ne sont **pas** committés,
  conformément aux conventions du dépôt).
- `evidence/apk-sha256.txt` — SHA-256 exact de l'APK testé.

## Constats technique (nouveaux, à retenir pour J06)

1. `startRecord()` du plugin **ignore** width/height/quality (JS) pour la vidéo et pilote
   exclusivement par `CamcorderProfile`. Le patch rend ce choix explicite côté appelant.
2. Vidéo H.264 + audio AAC (VOICE_RECOGNITION) systématiquement présents.
3. 2160P **absent** des CamcorderProfile de B/C → j0 {480P, 720P, 1080P, HIGH=1080p} ;
   cohérent avec `QUALIFICATION-TECHNIQUE-V1.md`.
4. Android 13+ : sans READ_MEDIA_* déclarés, l'enregistrement est bloqué par la demande de
   permission runtime (ILLEGAL_ACCESS) — correctif inclus dans le patch (plugin.xml + manifest).

## Statut

**PASS technique** — tous les critères du POC sont démontrés par les mesures ffprobe et logs
ci-dessus (720P→1280x720, 1080P→1920x1080 sur B et C; 2160P rejeté de façon déterministe).
Revue humaine du diff de patch recommandée avant intégration (par convention du projet).

J06 **non démarré** (hors périmètre). La primitive est prête pour l'écriture honnête du
fallback / warning HD-FHD de J06.