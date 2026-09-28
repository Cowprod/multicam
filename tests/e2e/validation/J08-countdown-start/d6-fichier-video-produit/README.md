# D6 — Un fichier vidéo RÉEL est bien produit (preuve persistée)

**Verdict : D6 VALIDÉ.** Sur **une seule tablette**, un enregistrement J08 réel a
produit un fichier MP4 non vide, mesuré, tiré et archivé dans ce dossier — chemin,
taille exacte en octets, durée, codec, résolution et SHA-256 sont tous traçables
dans les artefacts ci-dessous.

Ce que cette mission corrige, c'est une **lacune de preuve** et non un défaut
produit : `VALIDATION.md` affirmait « J08-07 — enregistrement RÉEL par Capture,
*fichiers produits* » en s'appuyant sur les seuls compteurs `CAMERA_REC_OK` /
`CAMERA_REC_STOP_OK`, sans qu'aucun artefact ne relie un chemin à une taille ni à
une durée. `CAMERA_REC_STOP_OK` transporte un `path=`, mais **le fichier n'était
jamais ouvert, mesuré, ni archivé** : rien ne prouvait qu'un octet avait été écrit.
Aucun fichier produit n'a été modifié pour cette mission.

---

## 1. Environnement

| Élément | Valeur |
|---|---|
| Tablette (unique, pas de campagne multi-appareils) | `61cc29567d91` (ADB model `24075RP89G`, « Cam D1 ») |
| deviceId | `d5f6b2a1-2387-4207-836d-90b0072a6cee` |
| Branche | `feat/j08-countdown-start` |
| Commit APK | **`0774ea6`** |
| APK | sha256 `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212` |
| `lastUpdateTime` sur A | `2026-09-27 16:35:12` |
| Session / take | `4UMGBHEV` / take 1, `countdownSeconds = 5` |
| Rôle sur le take | Capture (A) |
| Membre synthétique | `0000d1d1-0000-4000-8000-000000000001`, répondant `clock_sync` minimal |
| Durée d'enregistrement visée | 10 s, au-delà des 5 s du countdown |

### Pas de rebuild : l'APK installé embarque déjà `0774ea6`

L'APK n'a pas été reconstruit. Le fichier produit embarqué a été comparé à la
version dans HEAD :

```
$ git show 0774ea6:app/www/js/state/start-model.js | shasum -a 256
26f63394417e2ee10fa60fa64bccbef0669e4a766072456afaf07e201907855f  -
$ unzip -p app-debug.apk assets/www/js/state/start-model.js | shasum -a 256
26f63394417e2ee10fa60fa64bccbef0669e4a766072456afaf07e201907855f  -
```

Identiques : l'APK déjà installé **est** celui de `0774ea6`. Reconstruire aurait
été du bruit.

---

## 2. Procédure exécutée

1. Relance de l'app (`am force-stop` + `monkey`), contexte JS neuf : `localStoppedTakes`
   ne peut plus interdire de redémarrer le take 1 arrêté au run D1 précédent.
2. Navigation réelle : `panel-home` → session `4UMGBHEV` → `Préparer Take` → `ARM`.
3. **Membre synthétique démarré APRÈS** la relance de l'app, puis `logcat -c` juste
   avant l'appui REC : rien d'antérieur ne peut polluer la preuve.
4. Appui sur `R.E.C.` (`#armRec`) → confirmation de l'indicateur d'incident.
5. Attente 18 s = countdown 5 s + 10 s d'enregistrement + marge.
6. Arrêt propre : `#cdEmergency` puis confirmation `#cdStopConfirm`.
7. `adb logcat -d` **après** l'arrêt — c'est ce qui rend `CAMERA_REC_STOP_OK`
   observable (le run D1 avait été arrêté après son dump logcat, d'où l'absence du
   marqueur dans ces traces).
8. Mesures sur le device, puis pull et mesures côté Mac.

### Le premier essai a échoué, et pourquoi

Un premier essai a donné `START_REJECTED reason=clock_stale`
(`START_SERVICE_CLOCK_READY fresh=0 waitedMs=4005 reason=timeout`) : le répondant
synthétique avait été lancé **avant** le `am force-stop`, qui tue le serveur
WebSocket du master. Le répondant s'est fait fermer (`CLOSE code=1006`) et ne se
reconnecte pas. Le START était alors légitimement refusé — comportement correct du
produit, pas un défaut. Corrigé en lançant le répondant après la relance de l'app,
comme pour D1. Le log de l'essai raté est conservé dans `logs/responder.log`.

---

## 3. Le fichier produit

| Élément | Valeur | Où c'est prouvé |
|---|---|---|
| **Chemin exact** | `/data/user/0/fr.emmanuel.multicam/cache/videoTmp_11.mp4` | `mesures/extrait-log-liant-path.txt` (unique ligne du log qui porte ce chemin) |
| **Taille exacte** | **33 594 520 octets** | `mesures/device-ls-stat.txt` (`ls -l`, `stat`, `du -b`) + `mesures/mesures-fichier-video.txt` |
| Taille du fichier pullé | 33 594 520 octets — **identique**, pull bit à bit | idem |
| **Durée** | **13,440000 s** | `mesures/ffprobe-videoTmp_11.txt` |
| Vidéo | **h264, 1920×1080**, ~24,92 fps, 332 frames, 19 939 061 bps | `mesures/ffprobe-videoTmp_11.txt` |
| Audio | **aac**, 192 000 bps, 630 frames | `mesures/ffprobe-videoTmp_11.txt` |
| Décodage intégral | `ffmpeg -f null -` → code 0, **0 erreur** → non tronqué | `mesures/ffprobe-videoTmp_11.txt` |
| **SHA-256** | `876b4875dd4db6a8c3a7e4b168163f7bcfa9fdfb4927199aec6d465d9f2a13c3` | `mesures/mesures-fichier-video.txt` |
| mtime / permissions | `2026-09-28 10:15:11.074 +0200`, `-rw------- u0_a332:u0_a332_cache` | `mesures/device-ls-stat.txt` |

Le fichier lui-même est archivé : `media/videoTmp_11.mp4` (33,6 Mo, le pull est
raisonnable). Il porte donc sa propre preuve — quiconque le réceptionne peut
recontrôler le SHA-256, la durée et le codec sans device.

### La chaîne path ↔ marqueurs, dans le log

`mesures/extrait-log-liant-path.txt` extrait de `logs/A-J08-D6.log` :

```
10:14:55.354  START_LOCAL startPlanId=4UMGBHEV#1#1#1 take=1 target=10:14:55.350
               actual=10:14:55.352 deltaMs=2 countdown=5 status=OK
10:14:55.357  CAMERA_REC_REQUEST startPlanId=4UMGBHEV#1#1#1 take=1 w=1280 h=720
               quality=plugin_default qualityLabel=medium profile=auto
10:14:56.742  CAMERA_REC_OK startPlanId=4UMGBHEV#1#1#1 take=1 ackAtMs=1790583296738
               callDt=1383ms detail="OK"
10:15:11.109  CAMERA_REC_STOP_OK atMs=1790583311108
               path=/data/user/0/fr.emmanuel.multicam/cache/videoTmp_11.mp4
10:15:11.514  START_STOP_LOCAL startPlanId=4UMGBHEV#1#1#1 take=1 reason=emergency_no_master
```

**Une seule ligne du log entier mentionne ce chemin**, et c'est
`CAMERA_REC_STOP_OK` (ligne 12748 de `logs/A-J08-D6.log`) : le lien entre le chemin
annoncé par le produit et le fichier mesuré est donc direct, pas inféré.

### Cohérence des durées

| Grandeur | Valeur |
|---|---|
| `CAMERA_REC_OK ackAtMs` → `CAMERA_REC_STOP_OK atMs` | 14 370 ms (fenêtre REC) |
| `recElapsedMs` relevé par le modèle juste avant l'arrêt | 12 890 ms |
| **Durée du fichier** | **13 440 ms** |

La durée du fichier est **contenue dans la fenêtre REC** et cohérente avec le
compteur du modèle. Une durée hors de cette fenêtre aurait signé un fichier
erroné ou réutilisé.

### La caméra a bien été ouverte

Ce n'est pas un fichier vide écrit par un chemin de code qui n'enregistre pas :

```
10:14:50.139  mtkcam-dev3: [CameraDevice3Impl::open] open camera3 device
              (device@1.1/internal/0)
10:14:56.148  MPEG4Writer: limits: 4503599627370495/0 bytes/us, bit rate: 20192000 bps
10:14:57.229  MPEG4Writer: setStartTimestampUs: 6786
```

HAL caméra ouvert, `MPEG4Writer` actif au débit annoncé, première image horodatée.

---

## 4. Le fichier contient-il de l'imagerie réelle ?

`mesures/statistiques-images.txt` : luminance de frames extraites à 8 instants
répartis sur tout le film (frame 1920×1080 convertie en niveaux de gris).

| t (s) | moyenne | max | écart-type | valeurs distinctes |
|---|---|---|---|---|
| 0 | 4,37 | 123 | 4,65 | 115 |
| 4 | 4,40 | 127 | 4,68 | 118 |
| 8 | 4,36 | 124 | 4,67 | 116 |
| 12 | 4,39 | 122 | 4,67 | 112 |
| 13,2 | 4,41 | 121 | 4,68 | 115 |

Une image **noire plate** donnerait moyenne 0,00, écart-type 0,00 et une seule
valeur distincte. Ici : **112 à 118 valeurs distinctes** et un écart-type stable de
~4,7 → ce sont des images encodées à partir d'une scène réelle, pas un aplat.

`media/frame-t5s.jpg` (2,1 Ko, 480 px de large) est archivé comme indice visuel.

---

## 5. Ce que D6 ne prouve pas, et deux observations honestes

D6 porte sur **la production et la persistance d'un fichier**, pas sur la qualité
de la prise de vue. Deux observations relevées pendant cette preuve sont
**signalées, pas corrigées** : aucune modification produit n'a été faite.

1. **Imagerie très sombre sur tout le film** (moyenne ~4,4/255). La scène du test
   était sombre ; le fichier est néanmoins porteur d'images réelles (§4). Dire si la
   caméra a capturé la *bonne* scène — éclairage, orientation, choix de l'objectif —
   demanderait un travail caméra (aperçu, settings) explicitement hors périmètre de
   cette mission. À traiter dans un jalon dédié, pas ici.

2. **`CAMERA_REC_REQUEST w=1280 h=720`, fichier réellement en 1920×1080.** La
   résolution demandée n'est pas celle obtenue. C'est un écart de réglage
   observable, hors périmètre D6 (qui ne porte que sur « un fichier est produit »),
   et non un défaut de production : le fichier existe, est complet et est décodable.
   Signalé pour un jalon ultérieur.

`START_STOP_LOCAL reason=emergency_no_master` est **nominal** : A est elle-même le
seul Master du plan, donc `connectedMasters()` est vide et le bouton d'arrêt
d'urgence est proposé. Le même `START_MASTER_LOST … countdownContinues=1` a déjà été
documenté et écarté pour D1.

---

## 6. Inventaire des artefacts (sha256)

| Fichier | sha256 |
|---|---|
| `media/videoTmp_11.mp4` | `876b4875dd4db6a8c3a7e4b168163f7bcfa9fdfb4927199aec6d465d9f2a13c3` |
| `media/frame-t5s.jpg` | `0795c7d95de49ca615eb0b43778acfcb732e495a7ef4b1838b5d6db9955802e1` |
| `logs/A-J08-D6.log` | `b478731e78ee45b63538bd0c5e80d72dde6e72b22cd297b541df9107f2bb4c5d` |
| `logs/responder.log` | `16e29f90157f77acd79123f482f5d428b7ea125d5eba7cb0f56ad21799a125e3` |
| `mesures/ffprobe-videoTmp_11.txt` | `a1a7bb869d0c837bce53a75c6fa39f6867211cdd7bdf89d557f53ba40f12f935` |
| `mesures/mesures-fichier-video.txt` | `18cc4cb21fa6700372fcee8c7059a5dbe2a2551352c3e56151b833d025060696` |
| `mesures/device-ls-stat.txt` | `1750fa9af2dbf21a1e063e58d43d88c93e4b90e114d9d7ebffca9f6831b1c9a0` |
| `mesures/extrait-log-liant-path.txt` | `a72401f1e546c15ab7618b49c67da3160282d754e43e3f3ee425f2e37c08b4bc` |
| `mesures/statistiques-images.txt` | `aa277cf83d128618d67712b2f452674b507110a84b0995d902179c55c1ea7a6f` |
| `dumps/vue-avant-stop.json` | `0160f8766ec2af42db3ef4546d21553e828ab86682c34e7f7ec3dbe305c47dfe` |
| `mesures/t0_ms.txt` | `4f89326db845423485b794d03fb68f821de6280427fc314953655e2de0aef99e` |
| `mesures/t1_ms.txt` | `c4bf1cd7ad8b9210ad4302c807c2204e19c59925192ab6a86956368ba0bc9f32` |
| `dumps/vue-apres-stop.json` | `9c0bad971662ebb4ba27cf13855f7098fa370210dd30e52d9d3987dd48e5d356` |

`logs/A-J08-D6.log` = `adb logcat -d` de la tablette, vidé juste avant l'appui REC.
`mesures/t0_ms.txt` et `mesures/t1_ms.txt` = horodatages de l'appui REC et de la fin du run
(epoch Mac) ; leur différence donne la durée totale de run citée en §1.
`mesures/device-ls-stat.txt` = `ls -l` / `stat` / `du -b` exécutés **sur le device**
via `run-as` (l'APK est debuggable, ce qui rend le stockage privé lisible).
Aucun chiffre de ce README n'est declaration manuelle : tous sont recalculables
depuis ces fichiers.
