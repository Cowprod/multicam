# D1 — Compte à rebours décroissant : PREUVE D'UN DEFAUT

**Verdict : D1 NON VALIDÉ — l'écran 07 affiche « 5 » en permanence pendant les 5 s du
compte à rebours. La machine à états, elle, décompte correctement.**

Ce document remplace la preuve D1 précédente (`J08-06-A-countdown-5.png` /
`J08-06-A-countdown-3.png`, deux PNG strictement identiques), qui était elle-même
la preuve correcte d'un défaut mais était classée « conforme ».

**Aucun correctif produit n'a été appliqué** : cette mission consistait à établir
la preuve, pas à corriger. La correction est à faire dans une mission dédiée.

---

## 1. Environnement

| Élément | Valeur |
|---|---|
| Tablette (unique, pas de campagne multi-appareils) | `61cc29567d91` (ADB model `24075RP89G`, « Cam D1 ») |
| deviceId | `d5f6b2a1-2387-4207-836d-90b0072a6cee` |
| Branche / commit testé | `feat/j08-countdown-start` @ `11787e6` |
| APK | `app-debug.apk`, sha256 `81e0c639ceb8c84631afb3c0cff5898fecfa0d699643bcb436fdd7fb9886e0bb` (construit depuis `11787e6`, installé sur A seulement) |
| Session | `4UMGBHEV` — « Regie D1-150859 », PIN 4266 |
| Take | 1, `settings.countdownSeconds = 5` (aucun champ `countdownSeconds` racine) |
| Résolution écran / vidéo | 1340 x 800 |

### Prérequis de démarrage START

`requestStart` exige au moins une Capture distante. Deux participants ont donc été
utilisés :

- la tablette A (capture réelle) ;
- un membre **synthétique non participant** `0000d1d1-0000-4000-8000-000000000001`
  (« Capture D1-hors-ligne »), présent uniquement dans le manifeste JSON, adossé à un
  répondant WebSocket minimal qui répond à `ping` et `clock_sync` et **à rien d'autre** :
  il ne rejoint aucun START, n'enregistre rien, ne produit aucun pixel.

Ce répondant est un **dispositif de test**, il n'est pas dans le dépôt. Sans sa réponse
à `clock_sync`, le START est légitimement refusé (`START_REJECTED reason=clock_stale`) :
c'est le comportement correct du produit, pas un défaut.

---

## 2. Comportement observé

Deux exécutions indépendantes (run 1 et run 3) donnent le même résultat.

| Source | Run 1 | Run 3 |
|---|---|---|
| Machine à états (`COUNTDOWN_STATE`) | 5 → 4 → 3 → 2 → 1 | 5 → 4 → 3 → 2 → 1 |
| Vue `view().digit` (DOM, 100 ms) | 5 → 4 → 3 → 2 → 1 | 5 → 4 → 3 → 2 → 1 |
| **Texte du nœud affiché `#cdDigitMaster.textContent`** | **« 5 » du début à la fin** | **« 5 » du début à la fin** |
| **Pixels de la zone du chiffre (vidéo)** | **« 5 » sur toute la durée** | **« 5 » sur toute la durée** |
| Passage en REC | oui | oui |

**Séquence réellement observée à l'écran : `5, 5, 5, 5, 5, REC`** (et non `5, 4, 3, 2, 1, 0, REC`).

Le nœud concerné est bien celui qui est paints : pendant tout le compte à rebours,
`document.querySelector('.screen.active').id === 'panel-countdown'`, le nœud
`cdDigitMaster` est le seul nœud de chiffre visible (`offsetParent !== null`), et son
`getBoundingClientRect()` vaut `430x87x146x230` — identique à la géométrie utilisée pour
la calibration pixel. Il ne s'agit donc pas d'un nœud masqué ni d'une mesure hors écran.

---

## 3. Les trois preuves

### 3.1 Trace DOM à 100 ms — `dumps/run{1,3}-trace-dom-100ms.jsonl`

Échantillonnage de `MultiCamStartService.view()` et du texte des nœuds de chiffre
toutes les 100 ms pendant toute l'exécution. Lignes **littérales** du run 3 :

```
5215|COUNTDOWN|5|4994|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
6200|COUNTDOWN|4|3981|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
7300|COUNTDOWN|3|2975|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
8301|COUNTDOWN|2|1971|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
9300|COUNTDOWN|1|967|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
10212|REC|0|163|5|5|AUCUN_VISIBLE|panel-countdown|
```

Colonnes : `t(ms) | phase | digit(vue) | remainingMs | #cdDigitMaster.textContent |
#cdDigitCap.textContent | nœud de chiffre réellement visible | écran actif | rect du nœud visible`.

La 3ᵉ colonne décompte (5→1) ; la 5ᵉ reste à « 5 » ; la 7ᵉ confirme que
`cdDigitMaster` est bien le nœud affiché. 170 échantillons sur le run 3, 100 % des
échantillons en phase COUNTDOWN montrent `digit=5…1` et `visible=5`.

### 3.2 Identification du chiffre par pixels — `analyse/identite-chiffre-par-pixels.txt`

Références = rendus de l'élément `.cd-digit` de l'application pour les 6 valeurs
(`calibration-vue-master/digit-{0..5}.png`), capturés sur A avec `panel-countdown` en
seul écran actif. Zone de lecture = boîte d'encrage du chiffre, `x=570..768`,
`y=166..436` (199 x 271 px), obtenue par différence pixel entre les références 5 et 4.

Chaque frame est comparée aux 6 références (écart = écart absolu moyen, 1 octet RGB sur 7) :

- **40 frames identifiées « 5 »** (20 par run), écart **2.15** ;
- 2e meilleur candidat toujours « 3 » à **52.22** (séparation d'un facteur 24) ;
- **0 frame** identifiée 4, 3, 2, 1 ou 0 ;
- 24 frames hors compte à rebours (ARM avant, REC après) : meilleur écart ≥ 56, donc
  aucun chiffre — cohérent.

Run 1 : 20 frames « 5 » de t = 3.50 s à 8.25 s. Run 3 : 20 frames « 5 » de
t = 4.75 s à 9.50 s. Dans les deux cas la durée est de 5.0 s, soit exactement
`countdownSeconds = 5`.

La séparation 2.15 / 52.22 rend l'identification certaine : ces frames sont le rendu
de « 5 » de l'application, pas une ressemblance.

### 3.3 Hash de la zone du chiffre — `analyse/hash-zone-chiffre.txt`

Preuve sans hypothèse de calibration : on hache la zone du chiffre de chaque frame.

Run 3 (encodage propre) : **20 frames consécutives strictement identiques**
(t = 4.75 s … 9.50 s, soit 5.0 s) avec un sha256 unique
`54468de852705513b717464a83bf8351f33b9da75e4687f0742a38da222217a8`.

20 frames à 4 fps = 5.0 s = la durée exacte de `countdownSeconds = 5`. Avant (écran ARM)
et après (écran REC) la zone change bien : l'écran évolue, mais pas le chiffre.

Run 1 : zone stable par blocs d'environ 1 s mais sha différent d'un bloc au suivant
(artefacts de compression H.264) — d'où la nécessité de la preuve 3.2, dont le résultat
est identique sur les deux runs.

---

## 4. Localisation du défaut (lecture de code, cause exacte à confirmer)

Ce qui est **établi** par la lecture du code, et qui recoupe l'observation :

1. Le modèle est correct : `app/www/js/state/start-model.js:253` appelle
   `deps.onChange()` à chaque tick, et le service le fournit
   (`app/www/js/state/start-service.js:352`).
2. Le rendu écrit bien le chiffre courant : `app/www/js/ui/countdown.js:99`
   (`renderMaster` → `cdDigitMaster.textContent = String(v.digit || …)`), et
   `render()` est idempotent (« il reconstruit la vue courante à chaque révision »).
3. Or `cdDigitMaster.textContent` reste à « 5 » alors que `v.digit` vaut 4, 3, 2 puis 1.

Les points 2 et 3 sont incompatibles : **si `render(v)` était appelé à chaque tick avec
la vue à jour, le chiffre suivrait.** L'observation localize donc le défaut dans la
chaîne de notification du rendu, pas dans la logique de compte à rebours ni dans
`renderMaster`. Point d'entrée à examiner en priorité :

- `app/www/js/main.js:138` — `if (current === "countdown") screen.render(v);` : le rendu
  est conditionné à l'état du routeur, pas à une révision de la vue.
- `app/www/js/ui/countdown.js:257` — `state.lastRev = -1;` : un reset de révision au
  `show()` du panneau, à mettre en regard du chemin de notification.

**La cause exacte n'est pas établie** (elle demanderait une instrumentation runtime,
hors périmètre de cette mission de preuve) et **aucun correctif n'a été appliqué**.
La logique de compte à rebours est correcte ; c'est le rendu de l'UI qui ne suit pas.

---

## 5. Hypothèses écartées pendant l'établissement de la preuve

| Hypothèse | Résultat |
|---|---|
| « La zone change toutes les secondes, donc le chiffre change » | Faux. Les changements venaient d'autres éléments (aperçu caméra, indicateurs) hors de la zone du chiffre. La zone du chiffre est figée. |
| « Le run 2 contredit le run 1 » | Faux. Le run 2 n'a jamais lancé de compte à rebours : `START_REJECTED reason=local_stopped_take` (`state.localStoppedTakes[1]`, état mémoire) — extrait dans `analyse/run2-start-refuse-extrait.log`. Ses médias ont été supprimés : sans valeur probante. |
| « La vidéo du run 2 montre un autre écran car la tablette était en veille » | Sans objet, le run 2 est invalide. |
| « La box de calibration est mal alignée » | Écarté : la zone déduite du DOM live (`430x87x146x230`) contient la zone de lecture, et l'identification par référence est stable à 2.15 sur les deux runs. |
| « Le nœud `cdDigitMaster` est masqué, on mesure un nœud caché » | Écarté : `offsetParent !== null`, seul nœud de chiffre visible, écran actif = `panel-countdown`. |

---

## 6. Inventaire des preuves (sha256)

| Fichier | sha256 |
|---|---|
| `videos/run3-ecran.mp4` | `070c4e0a488c5d0cfdf2beb168cbe34f8ba6ad88b2f7b9852f3755c6c07c86b7` |
| `videos/run1-ecran.mp4` | `fb90811dc941d3b9b76192c492698f544a5bc8dcc22e8bc894ce5b0238b007e6` |
| `logs/run3.log` | `b1bbf8d2723a720e6df5d503942cd306195268524b459ff16f4384dfdfe5b598` |
| `logs/run1.log` | `945391500d064089bfc75e615c33514feea17fd7324d808334521f665b8c0b41` |
| `dumps/run3-trace-dom-100ms.jsonl` | `c5d38732b10ad97b13d8b7dfc3599b204bd0f7eadd3731045894241447022b7b` |
| `dumps/run1-trace-dom-100ms.jsonl` | `84f8f0203882cb5ec5578b3aba9a38eddcf108e2309a4ef5fa7eb7d629c5ea1d` |
| `dumps/run1-vue-apres-top.json` | `1de4f04455f091f87a3883a6b6e672518743e8e9cfba572fab419d5f9d71949f` |
| `analyse/identite-chiffre-par-pixels.txt` | `89ecfa70aeacb0873ae6622b483e0bae35ac19a30d9185e14efa9acc91f4a7b3` |
| `analyse/hash-zone-chiffre.txt` | `f55e4fe3489dc70c7bc9f26367f97d232c90934249d1d93dc2b3e70590f009fd` |
| `analyse/run2-start-refuse-extrait.log` | `672c7a178aa21d5875db57a0cb107d4fbb7399e4f44466fe0632db51b100828e` |
| `screenshots/run3-ecran-chiffre-5.png` | `d9ea6e9032d9782fdd4d1ac37ebcad06e0664934c2bb3326b9af126f41d81934` |
| `screenshots/run3-ecran-rec.png` | `310de4126cb18147e49dd86e74c9eb4ee2902fdbaa40b189e50743cea4d9a821` |
| `screenshots/run1-ecran-chiffre-5.png` | `4f56a36cc1ca53563381263c492a71b0ec8789a72b3d65ffdadf5ea4b5af850a` |
| `screenshots/run1-ecran-rec.png` | `e81e2b54f0878c8dff68c2e956cc5d33e9dbfeedbb9eb7455063755eb622b5b1` |
| `calibration-vue-master/digit-5.png` | `2c0a4c909db0d6503af8b90f862723136c76e2e550646e06e3b60f0d27384e5c` |
| `calibration-vue-master/digit-4.png` | `a4c93ffd493080f29ec7ed4225a895a2b4a296d686db87bb57b8f993538945fb` |
| `calibration-vue-master/digit-3.png` | `6bc6e0d3bb45755e10a040d896d6b40d11dbf1f0cf400a9023fd2f69675e70db` |
| `calibration-vue-master/digit-2.png` | `1be894544453759edf07878f89240749cc0634ef7376c02c987a61c7fff078c2` |
| `calibration-vue-master/digit-1.png` | `4164e2ad15ea2163c3407eb3e9f676ec7ac8dc8d9c12e6289c8ad4980dd6eec1` |
| `calibration-vue-master/digit-0.png` | `a23a9a636a6c88fbefea960dabe9eded4a108359ab81b499dc9de38f3d36fa31` |

`videos/` = `adb screenrecord`, 1340x800. `logs/` = `adb logcat -d`. `dumps/` = sortie CDP.
