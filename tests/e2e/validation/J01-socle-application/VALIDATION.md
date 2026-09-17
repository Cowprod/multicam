# J01 — Socle application Cordova réel — VALIDATION

## Résumé

| Élément | Valeur |
|---|---|
| Jalon | J01 — Socle application Cordova réel |
| Date / heure | 2026-09-17 14:27–14:33 (heure locale), 12:27–12:33 UTC |
| Commit Git testé | `a64e1e0d80d65141b24990535f08b0e9ce058421` (voir `artifacts/commit.txt`) |
| Verdict | **PASS** |

## Devices testés

Détail complet : `adb-devices.txt`.

| Serial | Constructeur | Modèle | Android | SDK | État |
|---|---|---|---|---|---|
| R9ZT40ALLSN | Samsung | SM-A226B | 13 | 33 | `device` |
| c0d8514d7d87 | Xiaomi | 24075RP89G (codename `flare`) | 16 | 36 | `device` |

Formats écran réels : Samsung 1080×2408 @ 450 dpi (téléphone, portrait) ; Xiaomi 800×1340 @ 213 dpi
(appareil type tablette, portrait, rotation paysage testée en plus).

## Scénario exécuté

1. Construction de l'application réelle `app/` (Cordova Android 15.1.0), plugin caméra épinglé
   `3e5d768934b78e142c369e67f0234a618706500c` + patch PixelCopy (`app/pixelcopy-patch/`).
2. Vérification post-build du patch dans les sources Java réellement compilées.
3. Installation de l'APK sur les deux devices (script `tests/e2e/install-all.sh`).
4. Lancement de l'activité `fr.emmanuel.multicam/.MainActivity` sur les deux devices.
5. Contrôles : process vivant, focus fenêtre, absence de `FATAL EXCEPTION`, logs de démarrage
   parsables (`APP_BOOT`, `PIXELCOPY_READY`, `HOME_RENDER`), rendu de l'écran 01.
6. Capture d'écran écran 01 sur les deux devices + variante paysage sur la tablette.
7. Extraits de la hiérarchie d'accessibilité (proof technique du contenu affiché).

## Commandes principales

```sh
# Build (app/)
cd app && ./setup-android.sh

# Vérification patch (sources compilees)
grep -R "capturePreviewSurface\|CAPTURE_PREVIEW_SURFACE_ACTION" platform//android/app/src/main/java/com/cordovaplugincamerapreview/

# Install multi-device
cd tests/e2e && ./install-all.sh <chemin>app-debug.apk

# Lancement
adb -s <SERIAL> shell am start -W -n fr.emmanuel.multicam/.MainActivity

# Preuves
./devices.sh ../validation/J01-socle-application/adb-devices.txt
./screenshot-all.sh ../validation/J01-socle-application/screenshots
./logs-all.sh ../validation/J01-socle-application/logs
./collect-files.sh ../validation/J01-socle-application/artifacts <apk>
```

## Résultat attendu / résultat réel

| Critère d'acceptation | Attendu | Réel |
|---|---|---|
| Build sans erreur | APK produit | ✅ `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` (3 950 858 octets) |
| Installation sur tous les devices autorisés | 2/2 | ✅ 2/2 (voir note écarts) |
| Lancement sans crash | process vivant, pas de FATAL | ✅ pid vivant + `mCurrentFocus` = activité sur les 2 devices, 0 `FATAL EXCEPTION` |
| Même commit sur plusieurs devices | même APK installé partout | ✅ même APK + SHA-256 `c36581df3ac…cd6b45b` sur les 2 devices |
| Écran 01 visible/cohérent sur ≥2 tailles | titre, badges skills, sections | ✅ contenu identique vérifié sur 3 captures (2 formats + paysage) |
| Structure exploitable pour les jalons suivants | séparation UI/état/natif/réseau | ✅ `www/js/{ui,state,native,net}` + `main.js` |
| Aucune dépendance technique critique cachée dans le lab | PixelCopy intégré à `app/` | ✅ patch copié dans `app/pixelcopy-patch/`, vérifié dans le build `app/` |

Résultat réel détaillé par device (logs) :

- `APP_BOOT app=MultiCam version=0.1.0 deviceName=Cam 07 supportedSkills=[capture,storage,controller] enabledSkills=[capture,storage,controller]`
- `PIXELCOPY_READY method=1` (sur les deux devices)
- `HOME_RENDER deviceName=Cam 07 controllerEnabled=1 recentSessions=0 lanSessions=0`
- Contenu affiché (uiautomator) : `MultiCam`, `Cam 07`, `Disponible sur le réseau`, badges
  `Capture`/`Storage`/`Master`, `SESSIONS RÉCENTES` + **`Aucune session récente`**,
  `SESSIONS DISPONIBLES` + **`Aucune session disponible`**, `+ Nouvelle session`.

## Preuves

| Preuve | Fichier |
|---|---|
| Devices | `adb-devices.txt` |
| Env / versions | `artifacts/versions.txt` |
| Plateformes Cordova | `artifacts/cordova-platforms.txt` |
| Plugins Cordova | `artifacts/cordova-plugins.txt` |
| Patch PixelCopy vérifié | `artifacts/pixelcopy-check.txt` |
| APK + SHA-256 | `artifacts/app-debug.apk` + `artifacts/app-debug.apk.sha256` |
| Commit testé | `artifacts/commit.txt` |
| Écran 01 Samsung (1080×2408) | `screenshots/R9ZT40ALLSN.png` |
| Écran 01 Xiaomi (800×1340) | `screenshots/c0d8514d7d87.png` |
| Écran 01 Xiaomi paysage (1340×800) | `screenshots/c0d8514d7d87-landscape.png` |
| Contenu UI (technique) | `artifacts/ui-texts-R9ZT40ALLSN.txt`, `artifacts/ui-texts-c0d8514d7d87.txt` |
| Logs de démarrage | `logs/R9ZT40ALLSN-logcat.txt`, `logs/c0d8514d7d87-logcat.txt` |

## Écarts et notes

1. **Install Xiaomi — `INSTALL_FAILED_USER_RESTRICTED` sur la 1ʳᵉ tentative `adb install`.**
   Contournement intégré à `install-all.sh` (fallback `push` + `pm install`, exécution en shell).
   Les deux devices passent ensuite `install-all.sh` (voir commentaire du script).
2. **Wrapper JS côté plateforme.** Le wrapper `CameraPreview.js` copié dans les assets de la
   plateforme reste la version upstream (sans la méthode JS). La méthode `capturePreviewSurface`
   est fournie à l'exécution par le shim qualifié (`js/native/pixelcopy.js`), exactement comme le
   lab de qualification. La partie **native Java est patchée et vérifiée** dans les sources
   compilées (`artifacts/pixelcopy-check.txt`). `PIXELCOPY_READY method=1` confirme la méthode
   disponible à l'exécution sur les deux devices.
3. **Scope J01 volontairement limité.** Réseau inactif (stub `js/net/transport.js` — J03+),
   pas d'usage caméra au runtime (patch intégré au build, le REC + previews sont J09),
   pas de plugin SAF (`local-plugins/...` reste dans le lab — J02), identité/skills en valeurs
   temporaires non persistantes (J02). Navigation Historique/Paramètres et Nouvelle session
   volontairement inactives (stub avec toast) conformément aux décisions validées.
4. **Dépendances UI.** Bootstrap 5.3.7/Bootswatch Quartz et Font Awesome 6.7.2 sont désormais
   **bundlés** dans `app/www/vendor/` (pas de CDN) pour rester utilisables hors ligne.
5. La maquette 01 utilise un fond vidéo de démonstration (`ui/assets/`). En J01 l'écran réel
   reste sur fond sombre/vignette, la zone preview caméra native étant réservée (J09).
   Décision validée — pas de donnée de démo fabriquée.

## Verdict

**PASS** — tous les critères d'acceptation J01 sont démontrés par les preuves ci-dessus sur les
deux devices physiques (même APK/commit, build, installation, lancement sans crash, écran 01
cohérent sur 3 formats, structure en couches exploitable, PixelCopy intégré et vérifié).