# MultiCam Qualification Lab

Lab Cordova Android utilisé pour qualifier les briques techniques avant intégration dans l'application MultiCam V1.

## État au 17 septembre 2026

La campagne de qualification initiale est terminée.

- **PixelCopy pendant REC : VALIDÉ** sur Samsung SM-A226B / Android 13 / SDK 33.
  - run endurance 300 s ;
  - 300/300 captures OK ;
  - 0 erreur ;
  - 0 callback perdu ;
  - latence moyenne 88 ms, max 266 ms ;
  - vidéo enregistrée OK.
- **Storage Access Framework : VALIDÉ sur stockage principal Android**.
  - sélection dossier ;
  - permission persistante ;
  - création / écriture / suppression réelle OK.
  - microSD réelle à revalider ultérieurement lorsqu'une carte sera disponible.
- **Partage du diagnostic : VALIDÉ** via la feuille de partage Android (`shareWithOptions`).

Le détail et les limites de ces validations sont consignés dans `docs/QUALIFICATION-TECHNIQUE-V1.md`.

## Utilisation du lab

Le lab reste volontairement conservé pour reproduire rapidement un test isolé sur un nouveau device ou une nouvelle version Android.

### Première installation

```sh
git clone https://github.com/Cowprod/multicam.git
cd multicam/tests/plugin-lab
./setup-android.sh
```

APK produit :

```text
platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

Le script termine par l'installation et le lancement sur le device Android connecté avec `cordova run android --device`.

### Itérations suivantes

```sh
cd multicam
git pull
cd tests/plugin-lab
./setup-android.sh
```

Le plugin SAF local est réinstallé à chaque exécution afin que ses évolutions récupérées par `git pull` soient prises en compte.

Le patch PixelCopy est appliqué aux sources CameraPreview puis recopié explicitement dans les sources Android compilées. Le script vérifie sa présence avant de lancer le build.

En cas d'incohérence après une évolution Cordova/Android importante :

```sh
cd multicam/tests/plugin-lab
rm -rf platforms plugins node_modules
./setup-android.sh
```

Cycle normal : `git pull` → `./setup-android.sh` → installation/lancement sur tablette → test → partage du diagnostic.
