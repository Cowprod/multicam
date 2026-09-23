# Validation — POC Capacités de capture (pré-requis J06)

Statut : **PASS technique** — revue humaine requise. Aucune implémentation J06 démarrée.

## Contexte

- Date : 2026-09-23
- Branche : `poc/capture-capabilities` (issue de `main`, `a0fb97e` Merge J05)
- APK sondé : `sha256` dans `evidence/apk-sha256.txt`
  (`faed1c8622459629cce6a5cca219db394c4a2f73a2b5d6679363ef7efee485ec` = SHA-256 de
  `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`)
- Devices sondés :
  - B = serial `61d54bba7d91`, `deviceId=cc02e8fe-91f8-41cd-bfdc-a112072862db`, `deviceName="Cam 07"`, IP 192.168.92.76
  - C = serial `c0d8514d7d87`, `deviceId=ecfc17ba-481a-4a21-9318-5dec8b4c5e1e`, `deviceName="Cam 07"`, IP 192.168.92.192
- Pile : `app/` Cordova, plugin camera-preview pin `3e5d768…`, patch PixelCopy `app/pixelcopy-patch`, action native
  générique `getCaptureCapabilities` ajoutée (voir `patch/apply_capture_capabilities_patch.py`).

## Procédure exécutée

1. `tests/poc/capture-capabilities/run-capture-capabilities.sh` : patch PixelCopy → patch `getCaptureCapabilities` →
   prepare + recopie `CameraPreview.java` dans `app/platforms/android/.../CameraPreview.java` →
   contrôle marqueurs (constante + branche `execute`) → build `cordova build android` (BUILD SUCCESSFUL) → SHA-256 →
   `adb install -r` B et C → sonde CDP → dumps evidence.
2. `pm grant` des permissions (`CAMERA`, `RECORD_AUDIO`, `ACCESS_FINE/COARSE_LOCATION`) sur B et C, re-sonde.
3. Sonde "sans permission" sur B (app bare) pour prouver le gating par permission.
4. Comparaison B vs C (identité + capacités).

## Critères et résultats

| # | Critère | Résultat | Preuve |
|---|---------|----------|--------|
| P1 | Interroger la liste des caméras sans preview (camera2) | **PASS** — rear + front, facing + `hardwareLevel` + tailles capteur physiques/pixels + focales | `B/C-capabilities.json` → `cameras[]` |
| P2 | Déterminer la récordabilité réelle (480P/720P/1080P/2160P/HIGH) | **PASS** — 1080P et HIGH=1080p dispo ; **2160P indisponible** (pas de 4K) | `camcorderProfiles[]` |
| P3 | Obtenir les tailles vidéo natives (Camera1) | **PASS (sous permission CAMERA)** — max 2560×1440 ; sans permission : `videoSizesAccessError` | `legacyVideoSizes[]` + `B-capabilities-nopermission.json` |
| P4 | Déterminer la disponibilité audio réelle | **PASS** — `audioMicFeature=true` (matériel), `audioPermissionGranted` dépend de la demande runtime | `applicationCapabilities` |
| P5 | Déterminer la capacité GPS matérielle | **PASS / constat** — **`gpsFeature=false` : les devices B et C n'ont pas de GPS matériel** | `applicationCapabilities` |
| P6 | Orientation | **PASS** — LANDSCAPE + PORTRAIT (niveau application `config.xml`) | `orientationModes` |
| P7 | B vs C | **PASS** — capacités strictement identiques (même tableur) ; seule l'identité diffère | diff des 2 JSON |

## Constats exploitables pour J06

1. **Pas de 4K** sur B/C → l'UI Take Preparation ne doit proposer que jusqu'à FHD (1080p) ; `2160P` absent de
   `camcorderProfiles`. La pyramide 480P/720P/1080P est déjà remplie proprement.
2. **Résolution d'enregistrement réelle = profil `QUALITY_HIGH`** (le plugin ignore `width/height/quality` :
   `MediaRecorder.setProfile(QUALITY_HIGH)`). Toute promesse d'une taille custom doit être écartée ou adossée à un
   changement plugin dédié (hors POC).
3. **Pas de GPS matériel** sur B/C (`gpsFeature=false`). Les profils "Éco/Normal/Précis" de J06 devront reposer sur
   une donnée honnête (GPS indisponible → repli/indication), ou un GPS-tagging optionnel via location réseau
   (`coarse/fine` grantables) — décision à poser côté specs, pas implémentée ici.
4. **Audio :** matériel présent, permission accordable → pas de blocage J06 pour REC.
   L'état "permission encore non accordée en app bare" est normal et doit déclencher la demande runtime du plugin.
5. Les tailles cameral signées `legacyVideoSizes[]` (jusqu'à 2560×1440) listent ce que l'encodeur accepte : utiles
   pour information, mais **non engagées** comme résolution de sortie (voir point 2).
6. `hardwareLevel` (LEGACY sur B/C) : pas de modes Camera2 avancés ; sans impact pour Capture (REC 1080p déjà validé).

## Artefacts

- `evidence/B-capabilities.json`, `evidence/C-capabilities.json` — JSON de capacités (permissions accordées)
- `evidence/B-capabilities-nopermission.json` — cas app bare (gating par permission)
- `evidence/B-capabilities.log`, `evidence/C-capabilities.log` — APP_BOOT + CONFIG_INIT par device
- `evidence/apk-sha256.txt` — SHA-256 de l'APK sondé
- `patch/apply_capture_capabilities_patch.py`, `run-capture-capabilities.sh` — rejouables

## Statut final

**PASS technique** : toutes les capacités Capture demandées sont interrogeables via la pile existante + action native
générique, sans redessin de plugin, sans logique applicative. **Revue humaine requise** avant de démarrer J06
(notamment : décision GPS, engagement sur 1080p max, point 2 ci-dessus). J06 non démarré.