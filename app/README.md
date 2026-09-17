# MultiCam — application Android

Application Cordova Android MultiCam (widget `fr.emmanuel.multicam`, version 0.1.0).

Structure couches (exigence J01 : séparation UI / état local / services natifs / réseau) :

```text
www/
├── index.html
├── css/app.css
├── vendor/                 # Bootstrap 5 / Bootswatch Quartz + Font Awesome bundles (hors ligne)
└── js/
    ├── main.js             # point d'entrée (deviceready, logs parsables APP_BOOT)
    ├── state/config.js     # état local (valeurs temporaires J01, persistance en J02)
    ├── ui/home.js          # interface écran 01 (Accueil / Découverte)
    ├── native/device.js    # services natifs — informations device
    ├── native/pixelcopy.js # brique PixelCopy qualifiée (wrapper + shim)
    └── net/transport.js    # couche réseau — inactive à J01 (J03+)
```

Build :

```sh
cd app
./setup-android.sh          # npm install + platform android@15.1.0 + plugin caméra épinglé + patch PixelCopy + build
```

APK produit :

```text
app/platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

Le plugin `cordova-plugin-camera-preview` est installé à un commit upstream épinglé
(`3e5d768934b78e142c369e67f0234a618706500c`) puis patché par `pixelcopy-patch/`
(action native `capturePreviewSurface` / PixelCopy). Le script vérifie la présence du
patch dans les sources Java réellement compilées avant chaque build.

Déploiement multi-device : voir `tests/e2e/` (install-all.sh, screenshot-all.sh, etc.).