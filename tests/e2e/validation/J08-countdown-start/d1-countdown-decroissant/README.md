# D1 — Compte à rebours décroissant : DÉFAUT PROUVÉ, PUIS CORRIGÉ ET VALIDÉ

**Verdict : D1 VALIDÉ.** Le défaut est confirmé (§1 à §6, inchangés, preuve d'origine),
puis corrigé et re-validé sur appareil (§7 à §11).

| | Avant correctif | Après correctif |
|---|---|---|
| Modèle (`view().digit`) | 5 → 4 → 3 → 2 → 1 | 5 → 4 → 3 → 2 → 1 |
| **Écran (`#cdDigitMaster`)** | **« 5 » en permanence** | **5 → 4 → 3 → 2 → 1** |
| **Pixels de la zone du chiffre** | **« 5 » pendant 5,0 s** | **5, 4, 3, 2, 1 (pixel-exact)** |
| Séquence à l'écran | `5, 5, 5, 5, 5, REC` | `5, 4, 3, 2, 1, REC` |

**Cause exacte** : `tick()` mettait à jour `state.digit` et `state.recElapsedMs` sans
jamais appeler `bump()`, donc sans déclencher `deps.onChange()`. Le modèle était correct,
l'UI ne recevait aucune nouvelle révision à redessiner. Correctif : un `bump()`
conditionnel dans `tick()`. Détail et preuve : **§7**.

Ce document remplace la preuve D1 précédente (`J08-06-A-countdown-5.png` /
`J08-06-A-countdown-3.png`, deux PNG strictement identiques), qui était elle-même
la preuve correcte d'un défaut mais était classée « conforme ».

**§1 à §6 sont le relevé d'origine du défaut, conservé tel quel** (ils documentent ce
qui a été observé avant toute modification du code). **§7 à §11 sont la preuve
post-correctif** ; les artefacts sont dans `post-correctif/`.

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

## 4. Localisation du défaut (relevé d'origine — cause établie depuis, voir §7)

> **Rectificatif.** Ce paragraphe contenait une erreur de lecture de code, signalée
> plus bas dans sa version d'origine : `start-model.js:253` **n'est pas** un appel à
> chaque tick, c'est l'appel `deps.onChange()` **à l'intérieur de `bump()`**, que rien
> ne déclenche depuis `tick()`. C'est précisément la cause du défaut, et elle était
> sous les yeux dans le fichier. La lecture d'origine est conservée ci-dessous telle
> quelle, avec la mention de l'erreur.

Ce qui est **établi** par la lecture du code, et qui recoupe l'observation :

1. ~~Le modèle est correct : `app/www/js/state/start-model.js:253` appelle
   `deps.onChange()` à chaque tick, et le service le fournit
   (`app/www/js/state/start-service.js:352`).~~ **FAUX** : la ligne 253 est dans
   `bump()`. `bump()` est bien la fonction qui appelle `deps.onChange()`, et le service
   la fournit bien — mais `tick()` ne l'appelle jamais, donc le subscriber n'est
   jamais prévenu du temps qui passe. La logique de décompte est correcte, la
   **notification** ne l'est pas.
2. Le rendu écrit bien le chiffre courant : `app/www/js/ui/countdown.js:99`
   (`renderMaster` → `cdDigitMaster.textContent = String(v.digit || …)`), et
   `render()` est idempotent (« il reconstruit la vue courante à chaque révision »).
3. Or `cdDigitMaster.textContent` reste à « 5 » alors que `v.digit` vaut 4, 3, 2 puis 1.

Les points 2 et 3 sont incompatibles : **si `render(v)` était appelé à chaque tick avec
la vue à jour, le chiffre suivrait.** L'observation localise donc le défaut dans la
chaîne de notification du rendu, et non dans la logique de compte à rebours ni dans
`renderMaster`. Points d'entrée examinés :

- `app/www/js/main.js:138` — `if (current === "countdown") screen.render(v);` : le rendu
  est déclenché par `onStartView`, lui-même alimenté par la seule chaîne de
  notification. Chaîne intacte, alimentée à tort.
- `app/www/js/ui/countdown.js:257` — `state.lastRev = -1;` : un reset de révision au
  `show()` du panneau. Écarté : le défaut est antérieur à tout `show()`.

**Cause exacte établie en §7** : `tick()` (`app/www/js/state/start-model.js:327`) met à
jour l'état sans appeler `bump()`. **Aucun correctif n'avait été appliqué au moment de
ce relevé** ; la correction est décrite et prouvée en §7.


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

---
---

# PARTIE 2 — CORRECTIF ET PREUVE POST-CORRECTIF

## 7. La cause exacte et le correctif

### 7.1 Chaîne de notification, telle qu'elle est

`main.js:onStartView` → `screen.render(v)` n'est appelé que sur notification. La
chaîne complète est :

```
tick()  (200 ms)  →  met à jour state.digit / state.recElapsedMs
                          ↓
                     bump()  →  state.rev++ puis deps.onChange()
                          ↓
              start-service.js:352  →  relaie onChange aux listeners
                          ↓
              main.js:onStartView  →  screen.render(v)
                          ↓
              countdown.js:99  →  cdDigitMaster.textContent = v.digit
```

Les 12 appels à `bump()` existants étaient **tous** dans des fonctions événementielles
(adoption du plan, horloge prête, réception d'un plan, changement de readiness, arrêt…).
**Aucun n'était dans `tick()`.** Le compteur lui-même était juste ; personne ne
prévenait l'UI que le temps venait de changer.

### 7.2 Le correctif (17 lignes, un seul fichier)

`app/www/js/state/start-model.js`, fonction `tick()` uniquement :

```js
var notify = false;                                   // au début de tick()
// … phase COUNTDOWN :
if (d > 0 && d !== state.digit) { state.digit = d; notify = true; … }
// … phase REC :
var elapsedBefore = state.recElapsedMs;
state.recElapsedMs = now() - state.recStartedAtMs;
if (state.recElapsedMs !== elapsedBefore) notify = true;
// … en fin de tick(), une seule fois, après toutes les mises à jour de l'état :
if (notify) bump();
```

Pourquoi cette forme :

| Exigence | Comment elle est tenue |
|---|---|
| Le subscriber suit le temps affiché | `bump()` une fois par changement de chiffre, une fois par tick en REC |
| Pas de notification inutile | `notify` n'est mis à vrai que si la valeur **observable** change ; ~25 ticks en countdown → **4 notifications** |
| Pas de timer d'interface ajouté | rien d'autre que `TICK_MS = 200`, inchangé ; le modèle reste la source unique du temps |
| Pas de notification hors COUNTDOWN/REC | `tick()` ne se reprogramme que dans ces deux phases (ligne inchangée) |
| Transitions préservées | ni adoption, ni top, ni annulation, ni arrêt, ni START_MASTER_LOST : aucune ligne de contrôle modifiée |

**Non modifié** : `countdown.js`, `start-service.js`, `main.js`, `TICK_MS`, le plan
d'armement, la logique de décompte. Aucun refactor.

### 7.3 Verrou de non-régression (test rouge avant correctif)

6 blocs ajoutés à `tests/plugin-lab/session/start-model.test.js` (39 → 45). Le harnais
enregistre désormais chaque notification avec la vue lue **à cet instant**, comme le
fait `main.js`. Test **rouge** sur le code d'origine, puis vert après correctif :

| | Sans le correctif | Avec le correctif |
|---|---|---|
| Valeurs publiées pendant le countdown | `[5,5,5,5]` — **le défaut, reproduit** | `[5,4,3,2,1]` |
| Notifications de tick | 0 | 4 |
| `remainingMs` publiés | — | `4000, 3000, 2000, 1000` |
| Aucun `0` publié | oui | oui |
| Notifications en REC (1,2 s) | 0 | 6, croissantes |
| Après arrêt | — | 0 parasite |

```
$ git stash push app/www/js/state/start-model.js && node tests/plugin-lab/session/start-model.test.js
[40] D1 : le subscriber est prévenu à chaque CHANGEMENT de chiffre
ECHEC : valeurs observables successives = [5] — AUCUNE notification de tick : l'UI reste
figée sur 5 alors que le journal COUNTDOWN_STATE descend 5→4→3→2→1
$ node tests/plugin-lab/session/start-model.test.js     # avec le correctif
OK — 45 blocs, tous verts.
```

Le test rouge reproduit exactement le symptôme physique (`5, 5, 5, 5, 5`).

Blocs de test : 40 sequence `[5,4,3,2,1]` · 41 information_stride (rev et remainingMs
strictement croissants/décroissants) · 42 aucun `0` + cohérence avec le journal ·
43 `recElapsedMs` notifié en REC · 44 `TICK_MS` inchangé et 4 notifications pour
~25 ticks · 45 tick désarmé au repos, aucune notification parasite.

## 8. Environnement du run post-correctif

| Élément | Valeur |
|---|---|
| Tablette (unique) | `61cc29567d91` (« Cam D1 ») — **seule tablette touchée** |
| deviceId | `d5f6b2a1-2387-4207-836d-90b0072a6cee` |
| APK | `app-debug.apk`, sha256 `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212` |
| Installation | `lastUpdateTime=2026-09-27 16:35:12` |
| Correctif embarqué vérifié | `unzip -p app-debug.apk assets/www/js/state/start-model.js \| grep -c "if (notify) bump();"` → `1` |
| Session / take | `4UMGBHEV` / take 1, `countdownSeconds = 5` |
| Membre synthétique | `0000d1d1-0000-4000-8000-000000000001`, **le même répondant qu'avant** |
| Durée du run | 16 s d'écran, échantillonnage 100 ms, 172 échantillons |

Conditions volontairement identiques à la preuve d'origine : même tablette, même
session, même take, même membre synthétique, même durée, même méthode d'identification
par pixels, **mêmes images de calibration** (`calibration-vue-master/digit-{0..5}.png`,
inchangées). La seule variable est le code embarqué.

## 9. Preuve 1 — trace DOM : le nœud affiché suit enfin le modèle

`post-correctif/dumps/d1-dom-trace-run4.jsonl`, colonnes
`t_ms|phase|digit|remainingMs|recElapsedMs|cdDigitMaster|cdDigitCap|zone_visible|ecran|rect` :

```
 5302|COUNTDOWN|5|4993|0|5|5|cdDigitMaster=5|panel-countdown|430x87x146x230
 6302|COUNTDOWN|4|3979|0|4|4|cdDigitMaster=4|panel-countdown|430x87x146x230
 7301|COUNTDOWN|3|2975|0|3|3|cdDigitMaster=3|panel-countdown|430x87x146x230
 8301|COUNTDOWN|2|1971|0|2|2|cdDigitMaster=2|panel-countdown|430x87x146x230
 9301|COUNTDOWN|1|967|0|1|1|cdDigitMaster=1|panel-countdown|430x87x146x230
10302|REC|0|163|40|1|1|AUCUN_VISIBLE|panel-countdown|
10501|REC|0|242|242|1|1|AUCUN_VISIBLE|panel-countdown|
10700|REC|0|443|443|1|1|AUCUN_VISIBLE|panel-countdown|
10911|REC|0|645|645|1|1|AUCUN_VISIBLE|panel-countdown|
11101|REC|0|846|846|1|1|AUCUN_VISIBLE|panel-countdown|
```

Sur 50 échantillons en COUNTDOWN :

- **séquence affichée : `5 → 4 → 3 → 2 → 1`** ; 1 seule valeur distincte avant correctif ;
- **0 ligne où le DOM diffère du modèle** (`cdDigitMaster` == `digit`, sans exception) ;
- **aucun `0` publié** (0 = instant du top, jamais affiché) ;
- intervalle de 1000 ms entre deux changements, soit le premier tick de 200 ms qui voit
  le nouveau palier ;
- **le timer REC défile aussi** : `recElapsedMs` = 40, 242, 443, 645, 846 … cadence
  ~200 ms, et à l'écran `cdRecTimer` passe de `00:40` à `00:45` en 4 s. Avant le
  correctif, ce timer était figé pour la même raison.

Comparatif : `post-correctif/analyse/trace-dom-avant-apres.txt`.

## 10. Preuve 2 — identification PAR PIXELS (mêmes références qu'avant)

`post-correctif/analyse/identite-chiffre-par-pixels-postfix.txt`. Méthode **inchangée**
par rapport à §3.2 : boîte de lecture `x=570..768`, `y=166..436`, écart absolu moyen sur
1 octet RGB sur 7, comparé aux 6 rendus de référence d'origine.

| Capture | Lu | Écart | 2e meilleur | Verdict |
|---|---|---|---|---|
| `D1-postfix-countdown-5.png` | **5** | **0.00** | 3 à 51.14 | conforme |
| `D1-postfix-countdown-4.png` | **4** | **0.00** | 1 à 85.57 | conforme |
| `D1-postfix-countdown-3.png` | **3** | **0.00** | 2 à 46.60 | conforme |
| `D1-postfix-countdown-2.png` | **2** | **0.00** | 3 à 46.60 | conforme |
| `D1-postfix-countdown-1.png` | **1** | **0.00** | 2 à 80.10 | conforme |
| `D1-postfix-rec.png` | — | 56.88 | 4 à 83.68 | hors countdown (attendu) |

Écart **0.00** : les captures sont identiques au pixel près aux rendus de référence de
l'application. Séparation de 46 à 85 face au 2e candidat : l'identification est certaine.

Contraste avec §3.2, même méthode et mêmes fichiers de calibration :

| | Avant | Après |
|---|---|---|
| Chiffres identifiés | 5 **seulement**, 40 frames | 5, 4, 3, 2, 1 |
| Écart du meilleur | 2.15 | **0.00** |
| Zone du chiffre stable | 5,0 s de frames identiques | 5 valeurs distinctes |

## 11. Ce qui reste inchangé, et ce qui ne l'est pas

**Validé sur appareil** : `5 → 4 → 3 → 2 → 1 → REC` à l'écran, chiffres pixel-exacts,
aucun `0`, timer REC vivant, `STOP local` toujours opérationnel (phase `STOPPED`, retour
`panel-arm`), aucune erreur JavaScript dans le logcat.

**Non concerné par cette mission, volontairement** : D2 (déjà corrigé), D3, D4, D5
(aucune action), D6, D7, D8. Aucune campagne multi-appareils, aucun preview caméra,
aucun refactor. Seul `tick()` a changé, et uniquement pour notifier.

**Point d'attention** (inchangé, hors périmètre) : le membre synthétique étant arrêté
en fin de run, `START_MASTER_LOST` est journalisé une fois pendant le countdown avec
`countdownContinues=1` — comportement nominal et documenté (le plan survit à la perte
des Masters), sans rapport avec le correctif.

## 12. Inventaire des preuves post-correctif (sha256)

| Fichier | sha256 |
|---|---|
| `post-correctif/videos/d1-ecran-run4.mp4` | `954219b7cf20c2c3f635c6631d1f4efd7103fbcf99b4010d3230c8c51ac8c29a` |
| `post-correctif/logs/A-D1-run4.log` | `4076cc8ddfd8d65db9e4a909aa3c9f6ee04f8f099056a0ef9f549932fe79489c` |
| `post-correctif/dumps/d1-dom-trace-run4.jsonl` | `ca8af10a475cc016a2703acfeea2a45cb790220521f610f3050764dd76f6a99c` |
| `post-correctif/analyse/identite-chiffre-par-pixels-postfix.txt` | `7c540a34edeeb2e753ecc96184f1ac9c77bae9a19d93869d090e8a5bb1f72576` |
| `post-correctif/analyse/trace-dom-avant-apres.txt` | `0797d762a5b040d1e6597ebff9d4e92179897c99f10a752f157f358d73b246db` |
| `post-correctif/screenshots/D1-postfix-countdown-5.png` | `c11fde38ad8df467a5ce4d7639d5d8cee521af6f54aa8cf9fe2a1d64a9e01c63` |
| `post-correctif/screenshots/D1-postfix-countdown-4.png` | `222ffbf178c4643b98569203e680b6add6920ee80a8ab29eea0e0ddf08be79b2` |
| `post-correctif/screenshots/D1-postfix-countdown-3.png` | `b682c3173208aefe6b5032198aa491cade2d58b1bb0898f0456367a9b1a7772a` |
| `post-correctif/screenshots/D1-postfix-countdown-2.png` | `adaad3567a952d3c7dcd9fbb04487892d77ed6da6fc986af344417ad335eb3a5` |
| `post-correctif/screenshots/D1-postfix-countdown-1.png` | `f8f24290f57c4a7a36d871f6498cf86fdc8b9310b301439e9e420934120977d4` |
| `post-correctif/screenshots/D1-postfix-rec.png` | `c96ba7a1b60214d9ef80938649fc632436bc4f2e4ba4e0d100649b0c3cf8ba6c` |
| `post-correctif/screenshots/D1-postfix-rec-t1.png` | `41390a5f2d0264bc89951d29dd8b5f7f18ecbe9a28a5ef1838f9d56826b8932a` |
| `post-correctif/screenshots/D1-postfix-rec-t2.png` | `afe3c8f49dced77f4483402a227e16b4a834f6e6175925c1679b70f3a8e599d6` |

APK testé : `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`,
sha256 `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212`.
Le répondant synthétique (`/tmp/d1/clock-responder.js`) est un dispositif de test
hors dépôt, comme dans la preuve d'origine.
