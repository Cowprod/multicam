# J08 — Countdown + START synchronisé — validation

Jalon **J08** de `docs/PLAN-DEVELOPPEMENT-V1.md`. Campagne de validation **technique**
sur 4 devices Android réels, complétée par des validations ciblées D1, D3 et D6.
**Validation technique J08 : PASS. Revue humaine fonctionnelle : PASS. Acceptation finale du jalon à confirmer avant merge.**

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
| J08-06 | appui REC → plan + countdown 5→1 | **VALIDÉ** — 3 `CAMERA_REC_OK` (A, B, C), 0 sur D ; countdown 5→4→3→2→1 corrigé et re-validé en D1 | logs + `d1-countdown-decroissant/` |
| J08-07 | enregistrement RÉEL par Capture | **VALIDÉ (D6)** — fichier réel mesuré : `videoTmp_11.mp4`, **33 594 520 octets**, **13,440 s**, h264 1920×1080 + aac, décodage sans erreur | `d6-fichier-video-produit/` |
| J08-08 | écart de top sur 3+ Captures | `deltas = 2 / 3 / 2 ms` | `dumps/top-spread.csv` |
| J08-09 | affichage selon rôles | **RÈGLE FIGÉE (D7)** — Master prioritaire sur Storage pendant countdown/REC ; badge compact réservé au Storage qui n'est ni Master ni Capture. Le chemin Storage seul reste couvert par les tests UI | `MULTICAM_DECISIONS_REFERENCE.md` §34.1 + tests UI |
| J08-10 | arrêt local, preuve fichier | **3 `CAMERA_REC_STOP_OK`** avec `path=`, **0 sur D** ; le `path=` est désormais **ouvert et mesuré** — voir D6 | logs + 4 captures + `d6-fichier-video-produit/` |
| J08-11 | plan annulé avant top → rien | **0 `CAMERA_REC_OK`** et `START_CANCEL sessionId=` + `START_PLAN_ABORTED` sur les **4** devices | logs + 4 captures |
| J08-12 | 5 START successifs | **5/5**, `phase=REC` à chaque run, ≤1 ms d'écart | console run10 + 15 captures |
| J08-13 | countdown 5→1, jamais 0 | **VALIDÉ** après correctif D1 (écart 0.00, pixel-exact) ; l'écart initial « 5 » pendant tout le compte à rebours est documenté et corrigé | `d1-countdown-decroissant/` |

## D1 — compte à rebours décroissant : VALIDÉ (défaut avéré, corrigé, re-validé)

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

### Correctif et re-validation

La cause exacte a été établie : `tick()` (`app/www/js/state/start-model.js`) mettait à
jour `state.digit` et `state.recElapsedMs` **sans jamais appeler `bump()`**, donc sans
`deps.onChange()` — le subscriber de `main.js:onStartView` n'était jamais prévenu. (La
lecture de code initiale, qui affirmait le contraire, est rectifiée en §4 du README.)

Correctif : un `bump()` conditionnel dans `tick()` — une notification par **changement
de chiffre**, une par tick en REC, rien hors COUNTDOWN/REC, `TICK_MS = 200` inchangé,
aucun timer d'interface ajouté. 17 lignes, un seul fichier ; `countdown.js`,
`start-service.js`, `main.js` non modifiés.

Verrou de non-régression : 6 blocs ajoutés à `tests/plugin-lab/session/start-model.test.js`
(39 → 45), **rouges sur le code d'origine** (valeurs publiées `[5,5,5,5]` — le défaut
reproduit) puis verts. Rejeu : `start-model` 45/45, `start-service` 26/26,
`countdown-ui` 13/13, `node --check` sur les deux fichiers modifiés.

Re-validation physique, **une seule tablette** (A), APK reconstruit
sha256 `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212`
(« correctif embarqué » vérifié dans l'APK), conditions identiques à la preuve
d'origine (même session `4UMGBHEV`, même take, même membre synthétique, **mêmes images
de calibration**) :

| Source | Avant correctif | Après correctif |
|---|---|---|
| DOM, 100 ms (`#cdDigitMaster.textContent`) | **5 en permanence** | **5 → 4 → 3 → 2 → 1** |
| Lignes où le DOM diffère du modèle | 50 / 50 | **0 / 50** |
| Un `0` publié | non | non |
| Pixels de la zone du chiffre | 5 sur 40 frames, écart 2.15 | **5, 4, 3, 2, 1, écart 0.00** (pixel-exact) |
| Timer REC (`cdRecTimer`) | figé | `00:40` → `00:45` en 4 s |
| Erreur JavaScript | — | aucune |

Preuve complète, correctif détaillé et inventaire sha256 :
[`d1-countdown-decroissant/README.md`](d1-countdown-decroissant/README.md) (§7 à §12),
artefacts dans `d1-countdown-decroissant/post-correctif/`.

**D1 est donc validé.**


## D6 — fichier vidéo réellement produit : VALIDÉ (preuve persistée)

**Ce qui manquait.** `CAMERA_REC_OK` et `CAMERA_REC_STOP_OK` existaient, et
`CAMERA_REC_STOP_OK` transporte bien un `path=`. Mais **aucun artefact n'ouvrait ce
chemin** : la ligne J08-07 affirmait « fichiers produits » en s'appuyant sur les seuls
compteurs du log, sans qu'une taille, une durée ou un hash n'ait jamais été mesuré
pour un fichier donné. Rien ne prouvait qu'un octet avait été écrit sur disque.

**Ce qui est établi maintenant**, sur **une seule tablette** (`61cc29567d91`),
commit APK `0774ea6`, APK sha256 `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212`
(identique à celui déjà installé : le fichier produit embarqué est bit-à-bit égal à
celui de HEAD, donc **pas de rebuild**), session `4UMGBHEV` / take 1, ~10 s
d'enregistrement après le countdown de 5 s, arrêt propre :

| Mesure | Valeur | Provenance |
|---|---|---|
| Chemin | `/data/user/0/fr.emmanuel.multicam/cache/videoTmp_11.mp4` | `CAMERA_REC_STOP_OK` — **unique** ligne du log portant ce chemin (ligne 12748) |
| **Taille exacte** | **33 594 520 octets** | `ls -l` + `stat` + `du -b` **sur le device**, et fichier pullé de taille identique |
| **Durée** | **13,440000 s** | `ffprobe` sur le fichier pullé |
| Vidéo / audio | h264 **1920×1080** (~24,92 fps, 332 frames) + aac 192 kbps | `mesures/ffprobe-videoTmp_11.txt` |
| Intégrité | `ffmpeg -f null -` → code 0, 0 erreur → **non tronqué** | idem |
| **SHA-256** | `876b4875dd4db6a8c3a7e4b168163f7bcfa9fdfb4927199aec6d465d9f2a13c3` | sur le fichier pullé, archivé dans le dépôt |
| Cohérence des durées | fenêtre REC 14 370 ms, `recElapsedMs` 12 890 ms, **durée fichier 13 440 ms** | logcat + vue live |
| Caméra | HAL ouverte (`open camera3 device`), `MPEG4Writer` actif, 1re image horodatée | logcat |
| Imagerie réelle | 112–118 valeurs de gris distinctes par frame, écart-type ~4,7 (une image noire plate donnerait 1 valeur) | `mesures/statistiques-images.txt` |

Le fichier de 33,6 Mo est **archivé** (`media/videoTmp_11.mp4`) : le SHA-256, la durée
et le codec sont recontrôlables sans device. Aucun chiffre de cette section n'est
déclaratif — tous se recalculent depuis les artefacts.

Preuve complète, procédure, hypothèses écartées et inventaire sha256 :
[`d6-fichier-video-produit/README.md`](d6-fichier-video-produit/README.md).

**Deux observations signalées, non corrigées** (hors périmètre D6, qui porte sur la
production et la persistance d'un fichier, pas sur la qualité de prise de vue) :

1. l'imagerie est **très sombre** sur tout le film (luminance moyenne ~4,4/255) — la
   scène du test était sombre ; le fichier reste porteur d'images réelles ;
2. `CAMERA_REC_REQUEST w=1280 h=720` alors que le fichier est en **1920×1080** : la
   résolution demandée n'est pas celle obtenue.

Aucune de ces deux observations n'empêche la production du fichier ; toutes deux
relèvent d'un jalon ultérieure. **Aucun fichier produit n'a été modifié pour cette
mission.**


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

- **J08-09 / D7 : ambiguïté levée par décision produit.** La précédence
  `Master+Storage` est désormais figée dans `MULTICAM_DECISIONS_REFERENCE.md`
  §34.1 : Master est prioritaire pendant countdown/REC. Le badge compact concerne
  un Storage qui n'est ni Master ni Capture. Le chemin Storage seul reste couvert
  par `tests/plugin-lab/session/countdown-ui.test.js` ; aucune nouvelle preuve
  physique n'a été inventée pour ce cas.
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

## D3 — perte de TOUS les Masters pendant le countdown : VALIDÉ (preuve persistée)

**Ce qui manquait.** Le comportement « le plan survit à la perte du Master » est couvert
par le modèle (`START_MASTER_LOST` journalisé une fois, `countdownContinues=1`,
`showEmergencyStop` quand `connectedMasters().length === 0`), mais **jamais prouvé sur
appareil réel**. Seul le risque inverse — un Master qui ne répond pas, donc un plan que
personne n'annule — avait été observé.

**Ce qui est établi maintenant**, sur **deux devices** : A = Master `61cc29567d91`,
B = Capture `61d54bba7d91` (192.168.92.76), session `UX8ZA4FT` / take 1,
`captures=[B]`, `countdownSeconds=5`, HEAD `85a0b48`, APK sha256
`502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212`.

B a d'abord été réinstallé avec l'APK de HEAD : il tournait sur un build **périmé**
(`start-service.js` différent de HEAD, correctif D1 absent). Sans cela la mission aurait
mesuré du code obsolète.

Un vrai `adb shell am force-stop fr.emmanuel.multicam` est passé sur A **1 492 ms après le
début du countdown de B** (fenêtre hôte 1790585220881 → 1790585221175, 294 ms), soit
3,5 s de countdown encore à couler. B est ensuite observé seul.

| Exigence | Résultat | Preuve |
|---|---|---|
| countdown **non annulé** | **oui** — `COUNTDOWN` tenu 4 892 ms d'échantillons, dont 3 121 ms après la mort du Master | `chronologie-comptoir.txt` |
| `START_MASTER_LOST` **une seule fois** | **oui** — `count= 1` sur le logcat complet | `extrait-master-lost.txt` |
| `countdownContinues=1` | **oui** — `phase=COUNTDOWN remainingMs=3940 countdownContinues=1` | idem |
| REC au **top prévu** | **oui** — `localTopMs 1790585224331.5` = `targetStartMs 1790585224415` + `offset −83,5` ; `startPlanId` inchangé | `B-rec-avec-stop-urgence-resume.json` |
| `CAMERA_REC_OK` réel | **oui** — `detail="OK"`, `callDt=1194ms` | `extrait-master-lost.txt` |
| UI REC affichée | **oui** — vue active `cdRec` | idem + capture |
| **STOP d'urgence disponible** | **oui** — `showEmergencyStop=true`, `d-none` absent, boîte `160x54` ; bascule 56 ms après le REC | `chronologie-comptoir.txt` |
| STOP effectué | **oui** — via la **modale de confirmation** du produit (`Confirmer STOP` / `Annuler`) | `B-modal-confirmation-stop.json` |
| `CAMERA_REC_STOP_OK` | **oui** — `path=/data/user/0/…/cache/videoTmp.mp4` | `extrait-stop-local.txt` |
| fichier produit non nul | **oui** — **80 253 952 octets** (D6 non refait) | `fichier-video-apres-stop.txt` |

`START_STOP_LOCAL … reason=emergency_no_master` : la raison est bien « plus aucun Master ».
La bascule du STOP d'urgence est **conditionnée** et non par défaut : `showEmergencyStop`
valait `false` au countdown (A encore connecté) et `true` seulement en REC sans Master.

**Limite assumée.** Un second `logcat -c` a été passé sur B juste avant le STOP local, donc
`logs/B-J08-D3.log` ne couvre que la phase STOP (10:47:31 → 10:47:46). La phase
countdown → perte Master → REC est couverte par les **extraits** pris aux bons instants,
les **dumps de vue** horodatés et l'**échantillonneur 100 ms** (833 échantillons,
IDLE → COUNTDOWN → REC → STOPPED). Le scénario n'a pas été relancé pour obtenir un logcat
unique. Le REC a duré 34 442 ms et non 5 s : les preuves ont été ramassées avant de
déclencher le STOP, comme l'impose la procédure.

Aucun fichier de `app/` ou `ui/` n'a été modifié. `MultiCamSessionWs.addMember` a été
appelé sur A pour que B devienne membre `capture` (le `join` renseigne `masters` mais ne
crée pas d'entrée dans `members`, donc B n'était pas sélectionnable comme Capture) : c'est
une étape de mise en place, pas une correction.

Preuve complète, chronologie, hypothèses écartées et inventaire :
[`d3-perte-masters-countdown/README.md`](d3-perte-masters-countdown/README.md).

## D4 — portée de la synchronisation J08

J08 valide la **synchronisation du top logique START**. Les mesures de top corrigées
des offsets d'horloge sont dans la cible du jalon (J08-08/J08-12).

Le délai entre ce top logique et l'ACK du pipeline natif d'enregistrement
(`CAMERA_REC_OK`) mesure la latence du plugin/encodeur ; il ne constitue pas
l'erreur de synchronisation J08. L'alignement effectif des médias/images sera
qualifié dans le jalon ultérieur prévu pour le REC multicam et ses médias (J09).
Aucune correction J08 n'est donc ouverte sur la seule base de cette latence.

## D5 — fraîcheur des offsets : clos sans correction

Le Master rafraîchit les offsets immédiatement avant de verrouiller le plan START.
Avec un countdown maximal de 10 s et sans mécanisme de replay/persistance des plans
dans le transport WS, aucun TTL supplémentaire côté Capture n'est requis pour J08.
Aucun défaut produit n'a été retenu.

## D7 — précédence Master + Storage : décision produit

Décision §34.1 du référentiel : pendant countdown et REC, **Master est prioritaire
sur Storage**. Le rôle Storage est principalement utile en fin de Take pour la
réplication/transfert ; il ne masque pas les commandes Master pendant la prise.

## Revue humaine — intégration effective d'un device ajouté

La revue humaine a révélé qu'un device visible dans « Disponibles sur le LAN » pouvait
être ajouté comme membre tout en restant inconnu de la session et donc réellement
déconnecté. Le libellé « Déconnecté » était exact ; le défaut portait sur le workflow
d'ajout, qui ne contactait pas le device distant.

Le correctif `39faa53` implémente l'intégration effective décidée en §31.2 :
endpoint WS device publié via TXT `wsep`, invitation `invite_req/invite_ok/invite_nack`,
serveur WS disponible avant toute session locale et endpoint transmis lors de l'ajout.

Smoke physique final A+B, sans interaction sur B : invitation acceptée, session et rôle
Capture connus de B, connexion WS réelle visible par A, passage à « Déconnecté » après
coupure puis reconnexion automatique au boot. Preuves :
`d7-integration-add-device/`.

Le device invité comme Capture n'est pas promu Master ; il mémorise le véritable Master
pour permettre la reconnexion. Le PIN reste absent de DNS-SD.

## Revue humaine — workflow d'ajout et capability Controller

La revue humaine a également relevé que `controller` était annoncé à côté de
`capture` / `storage` dans « Disponibles sur le LAN », alors qu'il ne s'agit pas
d'un `sessionRole` attribuable dans ce workflow.

Décision produit §31.2 et correctifs associés :

- `41249ed` masque `controller` sur la carte LAN et dans la popup d'ajout, sans
  modifier la donnée de découverte ;
- `57a73b8` exclut de « Disponibles sur le LAN » tout device qui n'annonce aucun
  rôle attribuable `capture` / `storage`, notamment un device `controller` seul ;
- les tests ciblés `lan-skills-display.test.js` couvrent les combinaisons
  Capture/Storage/Controller et garantissent que la donnée technique reste intacte.

Le smoke physique du correctif `41249ed` a confirmé sur les devices disponibles que
les cartes et la popup n'exposent plus `controller`. Le complément `57a73b8` est
verrouillé par le test de rendu ciblé ; il ne modifie ni découverte, ni transport,
ni membership.

## Synthèse technique finale J08

**PASS technique.** D1, D2, D3 et D6 sont fermés par correction ou preuve ciblée ; l'intégration effective d'un device ajouté depuis le Master est corrigée et validée physiquement par `39faa53` ;
D5 est clos sans correction ; D7 est tranché par décision produit. D4 est explicitement
hors métrique de synchronisation logique J08 et reporté à la qualification média J09.
La revue humaine fonctionnelle des anomalies relevées pendant J08 est désormais PASS. L'acceptation finale explicite du jalon et le merge vers `main` restent distincts de ce PASS.

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
