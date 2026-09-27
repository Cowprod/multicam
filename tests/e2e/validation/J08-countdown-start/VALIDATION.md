# J08 — Countdown + START synchronisé — validation

Jalon **J08** de `docs/PLAN-DEVELOPPEMENT-V1.md`. Campagne de validation **technique**
sur 4 devices Android réels. **Aucune acceptation humaine n'est enregistrée à ce
jour** (elle relève de l'humain, pas de ce dossier).

- Branche : `feat/j08-countdown-start`
- Base de la branche : `6017baa` (Merge J07 — ARM distribué + synchronisation horloge)
- APK : `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256 de l'APK : `2cd71860a8a0d97c52c7a939acc31fcad74ade66f6941a4653c89e0f55a034a1`
- Script : `tests/e2e/j08-campaign.sh` (pilote l'UI réelle via CDP, WebView DevTools)
- Console intégrale du run de référence : `logs/campaign-console-run10.log`

## Environnement

| Élément | Valeur |
|---|---|
| cordova-android | `^15.1.0` (déclaré dans `app/package.json`) |
| cordova-plugin-camera-preview | `github:…#3e5d768934b78e142c369e67f0234a618706500c`, patché en place |
| SDK cible / min | `SDK_VERSION=36`, `MIN_SDK_VERSION=24` (`cdv-gradle-config.json`) |
| Node | `v23.10.0` |
| Devices | 4, réels — voir `adb-devices.txt` |
| Rôles du Take 1 | A, B, C = Capture ; D = Storage seul |

## Preuves par section

Les compteurs ci-dessous sont extraits des journaux `logs/<serial>-<section>.log`
(`grep -c`), pas déclarés à la main.

| Section | Attendu | Constaté | Preuve |
|---|---|---|---|
| J08-01 | session créée sur A | `dumps/J08-01-A-created.json` | dump |
| J08-02 | B, C, D rejoignent | 4 `*-joined.json` + `*-join.txt` | dumps |
| J08-03 | rôles A/B/C Capture, D Storage | `dumps/J08-03-*-members.json` | dumps |
| J08-04 | Take 1 = 3 Captures + 1 Storage | `{"takeNumber":1,"captures":3,"storages":1}` | dump |
| J08-05 | ARM distribué READY | `dumps/J08-05-A-arm.json`, `dumps/arm-view-*.json` | dumps |
| J08-06 | appui REC → plan + countdown 5→1 | **3 `CAMERA_REC_OK`** (A, B, C), **0 sur D** ; countdown **NON VALIDÉ**, voir « D1 » plus bas | logs + 9 captures |
| J08-07 | enregistrement RÉEL par Capture | idem J08-06, fichiers produits | logs |
| J08-08 | écart de top sur 3+ Captures | `deltas = 2 / 3 / 2 ms` | `dumps/top-spread.csv` |
| J08-09 | D = badge compact, **sans** plein écran | **NON PROUVÉ PHYSIQUEMENT** — voir Limites | dump + capture |
| J08-10 | arrêt local, preuve fichier | **3 `CAMERA_REC_STOP_OK`** avec `path=`, **0 sur D** | logs + 4 captures |
| J08-11 | plan annulé avant top → rien | **0 `CAMERA_REC_OK`** et `START_CANCEL sessionId=` + `START_PLAN_ABORTED` sur les **4** devices | logs + 4 captures |
| J08-12 | 5 START successifs | **5/5**, `phase=REC` à chaque run, ≤1 ms d'écart | console run10 + 15 captures |
| J08-13 | countdown 5→1, jamais 0 | **NON VALIDÉ** — l'écran 07 affiche « 5 » pendant tout le compte à rebours | `d1-countdown-decroissant/` |

## D1 — compte à rebours décroissant : NON VALIDÉ (défaut avéré)

**Constat : l'écran 07 affiche `5, 5, 5, 5, 5, REC` au lieu de `5, 4, 3, 2, 1, 0, REC`.**
La machine à états décompte correctement ; le rendu de l'UI, non.

Ce que la campagne run10 affirmait ne tient pas : `png-shas.txt` (lignes 7 et 8)
enregistre `J08-06-A-countdown-5.png` et `J08-06-A-countdown-3.png` avec le **même
sha256** `1779b6c8e660cf00…` — deux captures censées montrer « 5 » puis « 3 » sont
strictement identiques. C'est la preuve du défaut, pas d'un countdown fonctionnel.

Re-validation sur **une seule tablette** (A), sans campagne multi-appareils, avec un
APK reconstruit depuis `11787e6`
(sha256 `81e0c639ceb8c84631afb3c0cff5898fecfa0d699643bcb436fdd7fb9886e0bb`, donc
**différent** de l'APK de la campagne run10 en tête de page) :

| Source | Modèle / vue | Écran |
|---|---|---|
| Machine à états (`COUNTDOWN_STATE`) | 5 → 4 → 3 → 2 → 1 | — |
| DOM, 100 ms (`#cdDigitMaster.textContent`, nœud visible) | 5 → 4 → 3 → 2 → 1 | **5 en permanence** |
| Pixels de la zone du chiffre (vidéo `screenrecord`) | — | **5 sur 40 frames, écart 2.15 vs 52.22** |
| Hash de la zone du chiffre | — | **20 frames consécutives byte-identiques = 5.0 s** |

Preuve complète, hypothèses écartées et inventaire sha256 :
[`d1-countdown-decroissant/README.md`](d1-countdown-decroissant/README.md).

**Aucun correctif produit n'a été appliqué** : cette mission établissait la preuve.
La cause est localisée à la chaîne de notification du rendu
(`renderMaster` écrit bien `v.digit`, donc `render` n'est pas appelé à chaque tick) ;
elle reste à confirmer et à corriger dans une mission dédiée.


## Synchronisation du top (J08-08 et J08-12)

`deltaMs = actualMs − (targetStartMs + offset_J07_du_device)`. C'est l'erreur de
**déclenchement de ce device** ; c'est la seule métrique comparable entre
horloges décalées.

- J08-08 (`dumps/top-spread.csv`) : deltas `+2 / +3 / +2 ms` sur 3 Captures.
- J08-12, run par run : `worstAbs` entre `0` et `1 ms`, `ALIGNED_SPREAD` entre
  `1` et `1,5 ms` (Take 3 → 7).
- `INFO_RAW_EPOCH_SPREAD_MS` (~600 ms) et `INFO_ACK_SPREAD_MS` (~0,5–0,8 s) sont
  des **indicateurs de contexte**, pas des erreurs de synchronisation :
  le premier mesure le décalage d'horloge entre devices, le second la latence
  du plugin natif entre l'appel `startRecordVideo` et son ACK.

## Deux choses à ne pas « corriger »

1. **`sync` en WARNING avec `delta −599 ms` sur C** n'est pas un défaut. Le
   panneau d'incidents mesure l'**écart d'horloge** avec le Master
   (`MULTICAM_DECISIONS_REFERENCE.md` : `warn` si `|offset| > 50 ms` ou
   `dispersion > 50 ms`, **jamais bloquant** pour REC). C est réellement en
   avance de ~600 ms ; c'est précisément cet offset que le START applique, d'où
   un déclenchement à ≤1 ms. Les deux nombres mesurent deux choses différentes.
2. **`CAMERA_REC_STOP_OK` avec `path=` en cache applicatif** est attendu : le
   transfert des fichiers vers le Storage est le jalon **J09**, hors périmètre ici.

## Limites connues, assumées

- **J08-09 n'est pas prouvé sur matériel.** D est `Master+Storage` (il a créé la
  session), donc le routeur lui rend la vue Master `cdRec` et n'affiche pas le
  badge : `{"visibleViews":["cdRec"],"badgeHidden":true}`. Le chemin
  `Storage → badge compact, aucun plein écran` est couvert par
  `tests/plugin-lab/session/countdown-ui.test.js` (13 blocs, verts), pas par un
  device. Lever cette limite demanderait un 5ᵉ device non-Master, une API de
  rétrogradation Master→membre, ou une décision sur la **précédence
  `Master+Storage`**, que `ui/07-countdown/README.md` ne tranche pas.
- **J08-12 : un seul run est dans les journaux par device.** Le script vide
  logcat entre chaque run (`logcat -c`) : `logs/<serial>-J08-12.log` contient le
  run 5. La preuve des 5 runs est dans `logs/campaign-console-run10.log` et les
  15 captures d'écran de la section.
- **`dumps/top-spread-all.csv` ne contient que le Take 7.** L'accumulation par
  run (`dumps/top-spread-run<N>.csv`) a été corrigée dans le script **après** ce
  run ; les deltas des runs 1 à 4 ne sont donc persistés que dans la console.
- **Modèle et version Android des devices non capturés** (voir `adb-devices.txt`).
- **Intermittence d'un clic « Nouveau Take »** observée une fois (bouton présent,
  aucun handler au premier commit). Le harnais vérifie désormais le commit et
  rejoue une navigation. **Aucune cause applicative n'est prouvée** : ni confirmée,
  ni corrigée.

## Correctifs de code validés par cette campagne

- `requestStart()` recharge désormais la session **depuis le store** au lieu du
  cache `lastSession` (épinglé à l'adoption d'un plan) : sans cela, un 2ᵉ START
  après « Nouveau Take » armait l'ancien Take et se faisait rejeter en
  `local_stopped_take`. Régression : bloc `[15]` de `start-service.test.js`
  (rouge sans le correctif : `3 !== 4`).
- `apply_video_permission_patch.py` : `startRecordVideo` ne demande plus que
  `CAMERA` + `RECORD_AUDIO` (Android 13+ exigeait `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO`
  à tort), et `onRequestPermissionResult` filtre désormais le `requestCode`.
- `startRecordVideo` n'envoie plus de `quality` textuelle (le wrapper attend un
  nombre 0–100) : le défaut documenté `85` s'applique, `camcorderProfile` reste
  le réglage effectif.

## Régressions unitaires associées

`start-model` 39 blocs · `start-service` 22 blocs · `countdown-ui` 13 blocs ·
`clock-fresh` 6 blocs · `arm-model` exit 0. Tous verts au commit de ces preuves.
