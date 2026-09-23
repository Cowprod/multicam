# POC — Capacités de capture (pré-requis J06)

Qualification technique ciblée : déterminer ce que la pile Android/plugin existante permet d'interroger, **par appareil physique**, en termes de capacités de capture réelles, pour alimenter honnêtement l'écran Take Preparation (J06) — sans implémenter J06.

## Périmètre

- **Question** : par appareil physique (B et C), quelles capacités peut-on déterminer côté matériel / pile native ?
- **Hors périmètre** : UI J06, persistance Take, politique de repli, logique Master/session, redémarrage des fonctionnalités déjà validées (preview, REC local, GPS, batterie, orientation, permissions, PixelCopy).
- **Devices** : uniquement B (`61d54bba7d91`, `deviceId=cc02e8fe-91f8-41cd-bfdc-a112072862db`, 192.168.92.76) et C (`c0d8514d7d87`, `deviceId=ecfc17ba-481a-4a21-9318-5dec8b4c5e1e`, 192.168.92.192).
- **Chaîne technique** : `app/` (Cordova), `cordova-plugin-camera-preview` pin `3e5d768…` (v0.14.0), patch existant PixelCopy + **patch générique `getCaptureCapabilities`** (action native, aucune logique applicative).

## Architecture du POC

```
tests/poc/capture-capabilities/
├── README.md                                  ← ce fichier
├── VALIDATION.md                              ← procédure + constats
├── patch/apply_capture_capabilities_patch.py  ← greffe de l'action native générique
├── run-capture-capabilities.sh                ← build + install + sonde (rejouable)
└── evidence/
    ├── B-capabilities.json / C-capabilities.json   ← JSON bruts normés (permissions accordées)
    ├── B-capabilities-nopermission.json             ← preuve du gating par permission (app bare)
    ├── B-capabilities.log / C-capabilities.log      ← APP_BOOT + CONFIG_INIT par device
    └── apk-sha256.txt                               ← SHA-256 de l'APK sondé
```

## Schéma JSON produit par appareil

Extrait de `CameraPreview.java` (`getCaptureCapabilities`), action générique exécutée dans le thread pool. Aucune logique Take / repli / Master.

| Champ | Source | Interprétation J06 |
|---|---|---|
| `sdk`, `model`, `manufacturer`, `appPackage` | `Build` / contexte | contexte device |
| `applicationCapabilities.audioPermissionGranted` | `checkSelfPermission(RECORD_AUDIO)` | dépend de la demande de permission runtime (plugin via `startRecordVideo`) |
| `applicationCapabilities.audioMicFeature` | `hasSystemFeature(FEATURE_MICROPHONE)` | matériel micro réel |
| `applicationCapabilities.locationFine/CoarseGranted` | `checkSelfPermission(ACCESS_FINE/COARSE_LOCATION)` | permission package |
| `applicationCapabilities.gpsFeature` | `hasSystemFeature("android.hardware.location.gps")` | **matériel GPS réel** |
| `orientationModes` | niveau application (`config.xml` `Orientation=default`) | capable LANDSCAPE + PORTRAIT |
| `cameras[]` (CameraManager/camera2, sans preview) | `getCameraCharacteristics` | facing, `hardwareLevel` (LEGACY=1), taille capteur (physique/pixels), focales |
| `camcorderProfiles[]` | `CamcorderProfile.hasProfile/get` par qualité | **récordabilité réelle** (cf. note ci-dessous) |
| `legacyVideoSizes[]` | Camera1 (`Camera.open` + `getSupportedVideoSizes`) | tailles vidéo natives ; **requiert permission CAMERA** |

### Note critique — résolution d'enregistrement réelle

`startRecordVideo` du plugin **ignore** `width/height/quality` passés en JS et écrit le fichier via
`MediaRecorder.setProfile(CamcorderProfile.get(cameraId, QUALITY_HIGH))`. La résolution réellement enregistrée
est donc **celle du profil `QUALITY_HIGH` supporté par l'appareil**, pas une taille choisie. D'où l'exigence de
reporter uniquement `camcorderProfiles` (vérité de l'appareil) plutôt que de promettre une taille arbitraire.

## Résultats consolidés (B = C, hardware identique Xiaomi `24075RP89G`)

| Capacité | Valeurs constatées | Dérivé de |
|---|---|---|
| Caméras | rear (capteur 3264×2448), front (2592×1944) | camera2 (CameraManager) |
| Hardware level | LEGACY (1) — camera2 émule Camera1 | camera2 |
| Enregistrement vidéo | 480P / 720P / **1080P** dispo, **2160P indisponible**, HIGH=1080p (20 Mbps, 30 fps, H.264/AAC) | CamcorderProfile |
| Tailles vidéo natives | jusqu'à **2560×1440** (liste complète via camera1, permission CAMERA requise) | Camera1 |
| Audio | micro matériel présent ; RECORD_AUDIO accordable | feature + permission |
| **GPS** | **`gpsFeature=false` → pas de GPS matériel** sur B et C | feature |
| Orientation | LANDSCAPE + PORTRAIT possibles | config app |

Différence B vs C : **aucune** sur les capacités ; seule l'identité (`deviceId`, serial) diffère → même tableur `24075RP89G`, prévisible pour J06.

## Rejouer le POC

```bash
./tests/poc/capture-capabilities/run-capture-capabilities.sh
```

Le script : (1) patch PixelCopy existant, (2) patch `getCaptureCapabilities`, (3) `cordova prepare` + recopie
`CameraPreview.java` dans la plateforme + build, (4) SHA-256 + contrôle des marqueurs, (5) install + sonde B/C
via CDP (`getCaptureCapabilities` → JSON d'evidence).

Sonde manuelle après install :
```bash
node tests/e2e/lib/cdp.js <serial> eval "(async function(){ await MultiCamConfig.load();
  return new Promise(r => window.cordova.exec(
    res => r({deviceId:MultiCamConfig.get().deviceId, ok:true, data:res}),
    err => r({deviceId:MultiCamConfig.get().deviceId, ok:false, error:String(err)}),
    'CameraPreview','getCaptureCapabilities',[])); })()"
```

Cas "sans permission" (app bare) : la sonde retourne `videoSizesAccessError:"Fail to connect to camera service"`
et `audioPermissionGranted:false` — preuve que l'interrogation des tailles/vidéo est **gatée par permission**
(`pm grant android.permission.CAMERA` + `RECORD_AUDIO` nécessaires).

## Limites connues

- `hardwareLevel=LEGACY` : les données camera2 proviennent d'une émulation Camera1 — cohérentes, mais pas les
  modes plein Camera2 d'un device de niveau FULL/LIMITED.
- Les `supportedVideoSizes` (camera1) listent des tailles que l'**encodeur** peut accepter ; ce qui est réellement
  écrit sur disque reste piloté par le profil `HIGH` du plugin (voir note critique).
- La latence/performance d'encodage n'est **pas** testée ici (déjà qualifiée en plugin-lab pour 1080p).