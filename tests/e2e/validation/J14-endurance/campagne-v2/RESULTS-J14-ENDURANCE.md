# RESULTS — J14 campagne d'endurance multicaméra

- **Date** : 2026-10-18
- **Session** : `CCQM6BFH` — « Regie J14D-210338 » (session neuve, anciennes conservées)
- **Dossier de preuves** : `tests/e2e/validation/J14-endurance/campagne-v2/`
- **Mode** : campagne réelle 4 devices, ~57 min, 6 Takes, 3 incidents Wi-Fi injectés
- **Verdict global** : **PARTIAL** (stabilité et intégrité des données acquises ; complétude de réplication en échec — cf. §13)

> Toutes les preuves brutes (dumps, captures d'écran, logcat filtrés) sont dans ce dossier.
> Aucun média ancien n'a été supprimé, aucune campagne précédente n'a été écrasée.
> Les logcat bruts de campagne (330 Mo) restent dans `logs/` (working tree, non committés — taille) ;
> les relevés nécessaires à l'audit sont dans `dumps/`, `live/` et `reanalyse/`.

---

## 1. Configuration et versions

| Élément | Valeur |
|---|---|
| Dépôt / branche | `feat/j11-media-transfer` |
| HEAD (à la préparation) | `1f3905efba35f6175d6bfab017865e1b8e59d472` (propre) |
| Application | `fr.emmanuel.multicam` |
| APK md5 (4 devices) | `db14e5d0cf282b5bb647f01ad65fa322` — **identique sur A/B/C/D et identique à l'APK local** |
| Android | Cordova + `cordova-plugin-camera-preview` (patché PixelCopy `capturePreviewSurface`) |

| Device | Serial | Modèle | Rôle | DID |
|---|---|---|---|---|
| A | `61cc29567d91` | 24075RP89G (flare) | Master / Régie | — |
| B | `61d54bba7d91` | 24075RP89G (flare) | Capture | `19848326-0070-44cb-8de3-0d0d4ec7eb19` |
| C | `c0d8514d7d87` | 24075RP89G (flare) | Storage (destination) | `ece36247-72e3-4268-a3b7-d0dcf80f4bfa` |
| D | `R83Y106V1HF` | SM-X110 (gta9wifi) | Capture | `d618012d-c15b-4a08-8097-88e75f126cd4` |

D est le même appareil en USB (`R83Y106V1HF`) et en Wi-Fi (`192.168.92.103:5555`).
Incidents réseau injectés sur **B et C uniquement** (`svc wifi disable|enable`).

## 2. Durée réelle de la campagne

- **3430 s = 57 min 10 s** (t0 `21:02:52` → fin officielle `22:00:01`), cf. `dumps/campaign-seconds.txt`.
- Échantillonnage de monitoring : **66 relevés** de `elapsed=78 s` à `3217 s` (`dumps/timeline.jsonl`).
- **Débordement post-campagne** : le dernier transfert (T6-D) ne s'est terminé qu'à **22:02:40**,
  soit **+159 s après la fin officielle** (le harnais a clos avant — bug harnais, cf. §12).

## 3. Nombre de Takes

**6 Takes** (T1→T6), tous ARMés et enregistrés.

| Take | REC cible | ARM attempt | REC réel B (s) | REC réel D (s) |
|---|---|---|---|---|
| T1 | 120 s | 1 | 128.473 | 128.873 |
| T2 | 300 s | 2 | 310.059 | 309.961 |
| T3 | 600 s | 2 | 609.600 | 609.078 |
| T4 | 180 s | 2 | 188.523 | 188.818 |
| T5 | 900 s | 2 | 908.501 | 908.705 |
| T6 | 300 s | 2 | 308.416 | 308.560 |

Durées mesurées sur l'atome `mvhd` des vidéos (lecture read-only, `tail` + parseur). Les durées
réelles dépassent la cible de ~2,5 à 8 s (latence de démarrage/arrêt). `recEligible=true` sur les
6 ARM ; skills à l'ARM : `WARNING, WARNING, READY`. Somme REC ≈ **2454 s (41 min)**.

## 4. Nombre de médias produits

12 sources = 6 Takes × 2 captures (B, D) — **18,67 Go** au total (vérité live, fichiers stables).

| Take | B (octets) | D (octets) |
|---|---|---|
| T1 | 320 202 463 | 808 398 208 |
| T2 | 772 539 998 | 1 946 232 248 |
| T3 | 1 519 218 334 | 3 552 831 571 |
| T4 | 469 792 477 | 908 016 745 |
| T5 | 2 264 233 103 | 4 381 274 991 |
| T6 | 768 569 758 | 961 552 107 |

Copies sur C (destination) : **12 entrées** — 8 complètes, 2 partielles (T2-D 1 713 382 016 ;
T5-D 86 307 695), 2 de 0 octet (T3-D, T5-B).

## 5. Transferts réussis / échoués

**8 / 12 réussis** (état `done`, SHA identique) — 4 échecs.

| Take×Source | État Master (A) | État Storage (C) | Résultat |
|---|---|---|---|
| T1-B | done | done | ✅ |
| T1-D | done | done | ✅ |
| T2-B | done | done | ✅ |
| T2-D | **transferring 88 %** | **error download_failed** | ❌ stall / divergence M↔S |
| T3-B | done | done | ✅ |
| T3-D | error | error | ❌ `ProtocolException: unexpected end of stream` (×3) |
| T4-B | done | done | ✅ |
| T4-D | done | done | ✅ |
| T5-B | error | error | ❌ `ProtocolException` (×3) |
| T5-D | error | error | ❌ `ProtocolException` (×3) |
| T6-B | done | done | ✅ |
| T6-D | done | done | ✅ (terminé à 22:02:40, hors campagne) |

Détail partiel/0 octet : T2-D copie partielle 1,71 Go (jamais récupérée) ; T5-D copie partielle
86 Mo (2 %) ; T3-D et T5-B : fichiers **0 octet** présents sur C (échecs précoces).

## 6. Vérification SHA-256

Inventaire SHA-256 complet des sources (B/D) **et** de la destination (C) en live, `sha256sum`
sur les fichiers stables (`live/sha-*.txt`), comparé à l'inventaire au STOP (`dumps/local-sha-*`).

| Take×Source | SHA source | SHA destination | Verdict |
|---|---|---|---|
| T1-B | `bacbab77…` | `bacbab77…` | identique |
| T1-D | `9dc05542…` | `9dc05542…` | identique |
| T2-B | `1f82392e…` | `1f82392e…` | identique |
| T2-D | `2cf772af…` | `c9344d3b…` | **différent** (copie partielle) |
| T3-B | `93992d83…` | `93992d83…` | identique |
| T3-D | `fbd8d657…` | `e3b0c442…` (vide) | **différent** |
| T4-B | `edaee458…` | `edaee458…` | identique |
| T4-D | `2233c12a…` | `2233c12a…` | identique |
| T5-B | `f7f56d78…` | `e3b0c442…` (vide) | **différent** |
| T5-D | `83fcae7c…` | `a6f05ec5…` | **différent** (2 %) |
| T6-B | `51130079…` | `51130079…` | identique |
| T6-D | `3a94452a…` | `3a94452a…` | identique |

Les 8 transferts `done` ont un **SHA source ↔ copie rigoureusement identique** : **0 corruption**.
Verdicts complets : `reanalyse/dumps/verdict.txt` (T1 PASS, T2 FAIL, T3 FAIL, T4 PASS, T5 FAIL, T6 PASS).

> **Artefact stat/sha** : l'inventaire source était lancé pendant la finalisation du muxer.
> Les `bytes` source de T2-B/T3-B/T4-D/T5-B/T6-B ont été figés trop tôt (notes « tailles
> divergentes … arbitrage par SHA »). Pour T5-B le SHA **lui-même** a été calculé sur un
> fichier partiel (`716feafb`, 520 Mo) au lieu du final (`f7f56d78`, 2,26 Go) — la vérité live a
> été substituée en re-analyse ; le verdict d'échec T5-B est inchangé (copie = 0 octet).

## 7. Interruptions réseau injectées

| Incident | Moment | Cible | Durée | Effet observé |
|---|---|---|---|---|
| INC1 | +248 s (`21:07:00`) | Wi-Fi **B** | 30 s | T1-B interrompu puis **complété** après rétablissement |
| INC2 | +1641 s (`21:30:13`) | Wi-Fi **C** | 30 s | T2-D cesse de progresser (dernier PROGRESS = 21:30:13) et **ne reprend jamais** ; T4-B/D reprennent correctement (`RETRY_OFFER`/Range à 21:33:15 et 21:38:26) |
| INC3 | +1721 s (`21:31:33`) | Wi-Fi **C** pendant un download | 30 s | T5-B/T5-D passent en `error` définitif (21:49:23 / 21:49:54) |

**À noter** : T3-D est tombé en erreur (`ProtocolException` ×3, 21:25:59–21:26:03) **sans aucun
incident réseau injecté**. Et T2-D, bien que déclenché par INC2, illustre un **stall silencieux**
(cf. §12, défaut D1).

## 8. Évolution des compteurs B02

B02 = `SESSION_ADVERTISE_SKIP` / `RE_SYNC_THROTTLED`. Baseline J14-B02 (correctif post-incident) :
~674 SKIP / 75 s en Take et ~1100 / 120 s après réplication (≈ 9/s borné).

| Device | Premier relevé (78 s) | Dernier relevé (3217 s) | Final (`b02-final.txt`) |
|---|---|---|---|
| A | skip=47 resync=15 | skip=33672 resync=13171 | 36377 / 14475 |
| B | skip=29 resync=6 | skip=17018 resync=5484 | 17384 / 5724 |
| C | skip=34 resync=11 | skip=33080 resync=12621 | 36083 / 14093 |
| D | skip=10 resync=2 | skip=1187 resync=555 | 2986 / 1930 |

Moyenne A ≈ 11,3 skip/s sur 3217 s — **cohérent avec la baseline B02**, sans emballement ;
D, en USB, est très en dessous (≈ 0,4 skip/s). Pas de dérive croissante en fin de campagne.

## 9. Réactivité de la WebView (CDP)

`node lib/cdp.js <ser> eval` — 66 mesures (`dumps/timeline.jsonl`, champ `cdpMs`) :

| min | p50 | p90 | p95 | max |
|---|---|---|---|---|
| 147 ms | 177 ms | 215 ms | 219 ms | 227 ms |

Aucune valeur > 500 ms, aucune rupture de réponse sur la durée : **PASS**.

## 10. Stabilité des 4 devices

- **PID identiques sur les 66 relevés** (A 12336, B 31236, C 15241, D 29554) — aucun redémarrage d'app.
- **`crashAnr` = 0** sur l'ensemble des relevés ; aucun ANR/crash dans les logcat.
- Disque `/data` (Ko libres) : initial A 35 635 336 / B 38 037 296 / C 36 195 648 / D 40 095 732 →
  final A 35 611 840 / B 33 591 716 / **C 28 636 200** / **D 27 789 948** (la destination C se
  remplit, les captures B/D baissent). **Aucun device n'a saturé**.

## 11. État final médias / sessions

- Sessions : **13 au total** — session `CCQM6BFH` (6 Takes, 2 captures + 1 storage chacune) +
  **12 sessions historiques conservées** (`dumps/sessions-before.json` ⊂ `sessions-after.json`).
- Destination C : 12 entrées (8 complètes + 2 partielles + 2 de 0 octet), cf. §4–6.
- Sources **conservées** (8) : B T2 `1f82392e`, B T3 `93992d83`, B T5 `f7f56d78`,
  D T1 `9dc05542`, D T2 `2cf772af`, D T3 `fbd8d657`, D T4 `2233c12a`, D T5 `83fcae7c`
  (≈ 16,15 Go).
- Sources **supprimées** (4, post-vérification SHA par l'app) : B T1, B T4, B T6, D T6
  (≈ 2,52 Go). **Aucune perte de données, aucune corruption.**

## 12. Incidents et réserves

### Défauts de l'application (diagnostic — aucune correction applicative apportée)

- **D1 — Stall silencieux + divergence d'état Master/Storage (T2-D)** : après coupure Wi-Fi
  pendant le download, la reprise re-offerte ne progresse plus (dernier PROGRESS 21:30:13) ;
  A reste bloqué sur `transferring 88 %` alors que C est en `error download_failed`. **Aucun
  timeout ni erreur côté Master** : l'UI Master affiche un état mensonger. Transfert jamais récupéré.
- **D2 — Échecs `ProtocolException: unexpected end of stream` sans retry automatique**
  (T3-D 3× 21:25:59–21:26:03 ; T5-B 3× 21:49:23 ; T5-D 3× 21:49:54) : passage en `error`
  définitif, **aucune nouvelle tentative** après échec. T3-D s'est produit **sans incident réseau**.
- **D3 — Suppression source ACKée mais non effectuée pendant un enregistrement actif** :
  `TRANSFER_LOCAL_DELETED files=0` alors que la source est toujours présente, en corrélation
  100 % avec « device en train d'enregistrer le Take suivant ». 4 cas confirmés
  (`reanalyse/dumps/delete-order.txt`) : **B take2, B take3, D take1, D take4**
  (≈ 4,0 Go non libérés) ; T4-D en `ECHEC_SUPPRESSION_INCOMPLETE`. Suppression réelle quand le
  device est idle (B T1/T4 avant ARM du suivant, T6 après le dernier Take).
- **D4 — Divergence d'état Master vs Storage** : conséquence de D1 (A `transferring` / C `error`).

### Défauts du harnais (corrigés — harnais uniquement, `tests/e2e/j14d-*.sh`)

- **H1** `stateOf` parsait mal le JSON double-encodé des transferts → `err` partout, `DONE` inexploitable.
- **H2** `tr_done_n` comptait rows + fichiers → « transferts complets=yes » dès t=0 s → PHASE 5/6
  lancées pendant T6 → SHA/verdict de campagne partiels et `delete-order` incomplet.
- **H3** `local_inventory` : `stat` avant `sha256sum` pendant finalisation → `bytes`/`sha` périmés (§6).
- **H4** `delete-order` par Take (sans Source) et ne traitait pas `storageSha256=—` → verdicts INCOMPLET/faux.
- **H5** `find -size +0c` excluait les copies 0 octet → « MANQUANT » au lieu d'`ECHEC` (T3-D, T5-B).

### Réserves

- **Le harnais de campagne a clos avant la fin réelle** (T6-D à 22:02:40, +159 s) : les artefacts de
  campagne (`dumps/verdict.txt`, `dumps/delete-order.txt`) sont **conservés tels quels comme preuve du
  bug** ; seule la re-analyse (`reanalyse/`) est corrigée.
- Horodatages = horloge PC (rapprochés par `CLOCK_SYNC`, offsets/rtt dans `dumps/sync-*.json`).
- Logcat bruts (330 Mo) non committés (taille) ; copies filtrées `TRANSFER_` dans `reanalyse/dumps/`
  et `live/transfers-post-campagne.txt` (preuve T6).

## 13. Verdict global

| Critère | Résultat | Démonstration |
|---|---|---|
| Endurance ~57 min, 4 devices, sans redémarrage | **PASS** | PID stables, `crashAnr`=0 (§10) |
| 6 Takes enregistrés (cible REC) | **PASS** | durées `mvhd` conformes (§3) |
| Réactivité WebView | **PASS** | CDP max 227 ms (§9) |
| Compteurs B02 bornés | **PASS** | §8 |
| Intégrité des transferts **complétés** | **PASS** | 8/8 SHA identiques, 0 corruption (§6) |
| Ordre HASH→DELETE respecté | **PASS** | `reanalyse/dumps/delete-order.txt` (aucune suppression sans hash) |
| **Complétude de réplication (12/12)** | **FAIL** | 8/12 — T2-D, T3-D, T5-B, T5-D (§5) |
| **Suppression effective après ACK** | **FAIL** | 4 anomalies `files=0` (D3, §12) |
| Résilience réseau (reprise) | **PARTIAL** | 2/3 récupérés (INC1 OK, INC2 partiel, INC3 échec) ; T3-D sans incident |
| Aucune perte de données | **PASS** | 8 sources conservées + 4 supprimées post-hash (§11) |

**VERDICT GLOBAL : PARTIAL.**

- Le **cœur du jour « endurance »** est acquis : 4 devices stables ~57 min, 6 Takes enregistrés,
  monitoring réactif, **aucune corruption, aucune perte de données**, sources non répliquées conservées.
- La **fiabilité de réplication échoue** sur ce run (4/12) à cause de deux défauts app identifiés
  (stall silencieux + divergence d'état Master/Storage, et échecs `ProtocolException` sans retry
  automatique), plus une anomalie de suppression (D3).
- Conséquence : le critère « tous les transferts répliqués » est **FAIL** ; si l'on ne retenait que
  ce critère, le verdict serait FAIL. Le verdict global retenu est **PARTIAL** au vu de la grille ci-dessus.
