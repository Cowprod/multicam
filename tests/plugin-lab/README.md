# MultiCam Qualification Lab v0.10.0

Lab Cordova Android utilisé pour qualifier les briques techniques avant intégration dans l'application MultiCam V1.

## Tests actuellement ciblés

- PixelCopy pendant REC : test 1, 3 ou 5 minutes, capture visée environ 1 fois/s, latence et erreurs journalisées.
- Storage Access Framework / microSD : choix d'un dossier Android avec permission persistante et test réel création/écriture/suppression.
- Diagnostic : export JSON et envoi du journal par mail.

## Première installation

```sh
git clone https://github.com/Cowprod/multicam.git
cd multicam/tests/plugin-lab
chmod +x setup-android.sh
./setup-android.sh
```

APK produit :

```text
platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

## Itérations suivantes

```sh
cd multicam
git pull
cd tests/plugin-lab
./setup-android.sh
```

Le plugin SAF local est réinstallé à chaque exécution afin que ses évolutions récupérées par `git pull` soient prises en compte.

En cas d'incohérence après une évolution Cordova/Android importante :

```sh
cd multicam/tests/plugin-lab
rm -rf platforms plugins node_modules
./setup-android.sh
```

Cycle normal : `git pull` → `./setup-android.sh` → installation APK sur tablette → test → export diagnostic / log mail.
