# J15 — Validation PHYSIQUE de la reprise automatique des transferts interrompus

**État : PASS — 30 critères sur 30, aucun FAIL, aucun BLOCKED.**

| | |
|---|---|
| Date | 2026-10-20, 19:44 → 20:25 (heure locale appareils) |
| Branche / commit | `feat/j11-media-transfer` @ `0f58f8964a69c0a930b6b558d8611b4025382b16` (arbre propre, aucun code modifié pour la campagne) |
| APK testé | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`, md5 `3a480337c806f49ffab90393241c80ae` (identique installé sur A, B, C — vérifié par `pm path` + `md5sum`) |
| Session | `DEBNCYNA` (« Regie J15-194458 »), PIN `9573` |
| Pilote | `tests/e2e/j15-campaign.sh` (CDP + adb, aucun résultat simulé) |
| Rapport implémentation | `RESULTS-J15-IMPLEMENTATION.md` (471 tests unitaires / 41 J15, même commit) |

---

## 1. Montage matériel

| Rôle | Série adb | deviceName | did |
|---|---|---|---|
| **A** — Master / Regie (controller seul) | `61cc29567d91` (Redmi 24075RP89G, USB) | `J15-A-Master` | `9d714526-9cb5-4e66-a5ab-9886a6117dfa` |
| **B** — Capture seule (capture) | `61d54bba7d91` (USB) | `J15-B-Capture` | `19848326-0070-44cb-8de3-0d0d4ec7eb19` |
| **C** — Storage seule (storage) | `c0d8514d7d87` (USB) | `J15-C-Storage` | `ece36247-72e3-4268-a3b7-d0dcf80f4bfa` |

- Wi-Fi commun `192.168.92.0/24`. **adb reste sur USB pendant les coupures Wi-Fi** : la collecte de preuves n'est jamais affectée par les scénarios de coupure.
- Stockage **interne** partout (`/sdcard/Android/data/fr.emmanuel.multicam/files/MultiCam/...`), conformément à la leçon J14-L5 (SAF hors périmètre de vérification SHA).
- Coupure réseau = `adb shell svc wifi disable|enable` sur C uniquement (procédure éprouvée en J14).
- Chaque scénario efface le logcat des 3 appareils au démarrage, puis archive logcat horodaté, captures d'écran, dumps JSON de vue de transfert et chronologie.

**Arborescence des preuves** : `tests/e2e/validation/J15/{logs,screenshots,dumps,events}/` — 19 Mo de logs, 40 captures d'écran, 64 dumps, 5 chronologies.

---

## 2. Résultat global

| Scénario | Critère | Verdict |
|---|---|---|
| SETUP | Session + rejoindre + membres/rôles | PASS |
| **P01** nominal | Source présente, état `done` Master + Storage, SHA-256 == | **4/4 PASS** |
| **P02** coupure Wi-Fi | `waiting_network`, pas d'état terminal prématuré, source intacte, reprise auto, SHA-256 == | **5/5 PASS** |
| **P03** redémarrage Storage | `waiting_network` avant redémarrage, journal persistant (avant/après), did restauré, `TRANSFER_JOURNAL_APPLIED`, état récupérable, pas d'`error`, reprise auto, SHA-256 == | **9/9 PASS** |
| **P04** deux Takes successifs | Take 1 en attente, Take 2 enregistré (fichier prouvé), reprise des 2 Takes, SHA-256 == les 2 | **5/5 PASS** |
| **P05** suppression locale | Réglage actif, source présente tant que réplication incomplète, réplication complète, purge après confirmation, **ordre `done` avant `delete`**, SHA-256 == | **7/7 PASS** |

Fichiers de verdicts : `dumps/verdict-SETUP.txt`, `dumps/verdict-J15-P0{1..5}.txt`.

---

## 3. SETUP (19:44:36 → 19:45:17)

- 3 appareils vus par `adb devices`, APK md5 identique partout.
- `APP_BOOT` + `TRANSFER_BOOT_ARMED role=master|capture|storage` confirmés dans logcat sur A/B/C respectivement.
- Rôles posés puis app relancée : `A roles=["controller"]`, `B roles=["capture"]`, `C roles=["storage"]`.
- Session créée côté A, B et C rejoignent : `ANNOUNCE_OK` puis `SESSION_JOINED` sur B puis sur C (PIN saisi par CDP), `dumps/endpoint-61d54bba7d91.txt` / `endpoint-c0d8514d7d87.txt`.
- Membres ajoutés sur A : `["J15-B-Capture:capture","J15-C-Storage:storage"]` (`dumps/SETUP-4-A-members.json`).
- Preuves : `screenshots/SETUP-A-session.png`, `SETUP-A-members.png`, `logs/*-SETUP.log`, `dumps/adb-devices.txt`.

---

## 4. P01 — Transfert nominal (19:57:03 → 19:58:51) — Take 2

| Critère | Mesure | Verdict |
|---|---|---|
| Fichier source sur B | 1 fichier, `117 675 191` o | PASS |
| État Master | `"state":"done"`, `117675191/117675191`, `percent:100` | PASS |
| État Storage (C) | `"state":"done"`, même totaux | PASS |
| SHA-256 source == destination | `70367338522b92194fe13231585435575a69046da7851c0671a047927cc13ab5` (117 675 191 o) des deux côtés | PASS |

- Suppression locale **désactivée** pour ce Take (`deleteLocalAfterVerifiedReplication=false`, relecture confirmée) afin de pouvoir relever le SHA source : le scénario P01 porte sur l'intégrité et la convergence des états, la purge est couverte par P05.
- Transfert terminé 21 s après le STOP (`dumps/P01-A-transfers.json`, `P01-C-transfers.json`).
- Preuves : `dumps/sha-P01-{source-B,dest-C}.txt`, `dumps/P01-sha-compare.txt` (`COMPARE_OK`), `logs/*-J15-P01.log`, screenshots `P01-*`.

---

## 5. P02 — Coupure Wi-Fi pendant le transfert (20:00:29 → 20:04:32) — Take 3

Fichier : **304 196 104 o** (REC 120 s).

| Événement | Horodatage | Preuve |
|---|---|---|
| STOP demandé, début transfert | 20:03:03 | chronologie `events/J15-P02-timeline.txt` |
| Coupure Wi-Fi à **872 648 o reçus** (0,29 %) | 20:03:11 | `dumps/P02-bytes-at-cut.txt`, `P02-C-watch.json` |
| `NET_CHANGED networkType=none` | 20:03:11.692 | `logs/c0d8514d7d87-J15-P02.log` |
| `TRANSFER_WAITING ... cause=network` (ConnectException) | 20:03:13.063 | idem |
| `TRANSFER_WAITING_NETWORK ... nextInMs=3022` puis `TRANSFER_RESUME_PLANNED` | 20:03:13.065 | idem |
| Tentatives automatiques pendant la coupure (`TRANSFER_RESUME_SKIP reason=already_planned`) | 20:03:17 → 20:03:43 | idem |
| `NET_CHANGED networkType=wifi ipv4=192.168.92.192` | 20:03:45.393 | idem |
| `TRANSFER_RESUME_PLANNED inMs=0` + `TRANSFER_RESUME_SCAN planned=1` + `TRANSFER_RESUME_RUN` | 20:03:45.398 | idem |
| `TRANSFER_RESULT take=3 ... state=done` | 20:04:28.433 | idem |

| Critère | Mesure | Verdict |
|---|---|---|
| État `waiting_network` sur C pendant la coupure | observé (`dumps/P02-C-during-cut.json`) | PASS |
| Absence d'état terminal prématuré | 0 état `error` sur C ; **Master reste `transferring`** (`dumps/P02-A-during-cut.json`) | PASS |
| Source intacte pendant la coupure | 1 fichier présent sur B | PASS |
| Reprise **automatique** (aucune action utilisateur) | `done` 45 s après le retour Wi-Fi (reprise effective dès `NET_CHANGED`) | PASS |
| SHA-256 source == destination | `ee46cc9f104ba956c3c865ad19e54046e5c40f98549af99546b1d3c5650a95ec` (304 196 104 o) | PASS |

---

## 6. P03 — Coupure + redémarrage de l'app Storage (20:06:09 → 20:10:20) — Take 4

Fichier : **304 374 716 o**. Coupure à **8 045 o** reçus, puis `force-stop` de l'app sur C **avec Wi-Fi toujours coupé**.

| Critère | Mesure | Verdict |
|---|---|---|
| `waiting_network` avant redémarrage | observé (`dumps/P03-C-during-cut.json`) | PASS |
| Journal persistant AVANT redémarrage | `files/transfers/` = 4 fichiers ; `DEBNCYNA_4_...json` (666 o) | PASS |
| Journal persistant APRÈS redémarrage | 4 fichiers toujours là, contenu inchangé | PASS |
| did restauré à l'identique | `ece36247-72e3-4268-a3b7-d0dcf80f4bfa` (`dumps/P03-C-after-restart.json`) | PASS |
| Restauration du journal | `TRANSFER_JOURNAL_APPLIED sid=DEBNCYNA take=4 files=1` à 20:09:34.686 | PASS |
| État récupérable | juste après l'application du journal : `TRANSFER_RESUME_SCAN planned=1` (20:09:34.693) → `TRANSFER_RESUME_RUN` (20:09:34.701), état `transferring` réapparu sans intervention | PASS |
| Aucun état terminal `error` | 0 observation sur toute la séquence | PASS |
| Reprise **automatique** sans action utilisateur | `TRANSFER_RESULT take=4 ... state=done` à 20:10:13.521 (59 s après le retour Wi-Fi à 20:09:15) | PASS |
| SHA-256 source == destination | `c6b53e227ae175911c95d2a5124dd0b31174415b6526f33a8b79874781089e9b` (304 374 716 o) | PASS |

Compléments observés (preuves positives) :

- Reconnexion WS de C en boucle sur les 3 endpoints (`WS_RETRY_SCHEDULE`, `WS_RETRY_ATTEMPT`) puis `NET_CHANGED wifi` à 20:09:17.
- **Ré-offre du Master** déclenchée par le watchdog de transfert bloqué : `TRANSFER_STUCK_REOFFER ... attempt=1` + `TRANSFER_OFFER_TX ... sent=1` à 20:09:35.130 (2ᵉ mécanisme de reprise, en complément du journal côté Storage).
- Preuves : `dumps/P03-journal-{before,after}.txt`, `P03-journal-content-before.json`, `logs/C-P03-restore.log`, screenshots `P03-*`.

---

## 7. P04 — Deux Takes successifs (20:11:59 → 20:18:51) — Takes 5 et 6

| Phase | Fait | Verdict |
|---|---|---|
| Take 1 (90 s REC, 229 458 904 o) interrompu à **1 448 o** reçus → C passe en `waiting_network` | 20:14:08 coupure, état `waiting=2 done=0` | PASS |
| Take 2 enregistré **pendant** l'attente réseau du Take 1 | Take 5 → Take 6, **fichier source de 117 080 643 o effectivement créé sur B**, phase A = STOPPED | PASS |
| Reprise du Take 1 | `TRANSFER_RESULT take=5 ... done` à 20:18:22.447 (37 s après retour Wi-Fi) | PASS |
| Take 2 transféré | `TRANSFER_RESULT take=6 ... done` à 20:18:47.913 | PASS |
| SHA-256 des 2 Takes | Take 5 : `832706df3a162b252c98ac9d3850684f191c110bb8e25b537e4c527ee8fda808` ; Take 6 : `4f120781a40c7a28a19bd28fa4450f12b6ef1d98b2ebc4444ca4c049fbf6e38c` — source == destination pour les deux | PASS |

Point de vigilance constaté **et documenté** : pendant que C est hors-ligne, l'écran ARM du Master affiche `storage=ERROR check=connection` (cycle `DEBNCYNA#6#1`) alors que `recEligible=true`. Le démarrage de la REC passe par la confirmation de l'incident (`#armIncidentContinue`) ; l'enregistrement du Take 2 se déroule normalement. Au retour du réseau : `ARM_RECOVER ... skill=storage from=ERROR to=READY`.

---

## 8. P05 — Suppression locale strictement post-réplication (20:20:27 → 20:24:42) — Take 7

Fichier : **304 065 361 o**, coupure à **1 773 304 o** reçus.

| Critère | Mesure | Verdict |
|---|---|---|
| Réglage actif sur le Take | `deleteLocalAfterVerifiedReplication=true` (relecture sur A) | PASS |
| Source encore présente tant que la réplication est incomplète | 1 fichier sur B pendant la coupure (`dumps/sha-P05-source-B.txt`) ; état Storage non `done` (`P05-C-waiting.json`) | PASS |
| Réplication complétée au retour réseau | `TRANSFER_RESULT ... state=done` à 20:24:35.983, soit **71 s** après le retour Wi-Fi (20:23:25) | PASS |
| Suppression locale après confirmation | `files=1 removed=1` sur B, 0 fichier restant | PASS |
| **Ordre chronologique** | B : `TRANSFER_HASH` (SHA identique) → `TRANSFER_RESULT ... state=done` (20:24:36.205) → `TRANSFER_LOCAL_DELETE_NATIVE` → `TRANSFER_LOCAL_DELETED` (20:24:36.349) → `TRANSFER_DELETE_ACK`. A : `TRANSFER_RESULT done` (…490) → `TRANSFER_DELETE_TX` (…492) → `TRANSFER_DELETE` (…493) → `TRANSFER_DELETE_ACK` (…655) | PASS |
| SHA-256 source == destination | `7d962c0797999fcdc86b6cd935df847bb8ea41f13c4e1c9726cfe9c48f949dc8` (304 065 361 o) | PASS |

Preuves : `logs/B-P05-delete.log`, `logs/A-P05-delete.log`, `dumps/sha-P05-{source-B,dest-C}.txt`, screenshots `P05-source-present.png` (source présente avant la purge) et `P05-after-delete.png`.

---

## 9. Observations (non bloquantes)

1. **Aucune exception JS** dans les logs archivés des 6 scénarios validés (`grep -iE "EVAL_EXCEPTION|FATAL|Uncaught" logs/*.log` → 0 occurrence).
2. `TRANSFER_RESUME_NO_ENDPOINT` et `TRANSFER_RESUME_QUEUE_FULL` : **0 occurrence**. Le risque identifié en analyse préalable (endpoint mémoire perdu après redémarrage Storage → `NO_ENDPOINT`) ne s'est **pas** matérialisé : la réunion de session restaure l'endpoint et le journal se réapplique immédiatement, et le Master émet de son côté `TRANSFER_STUCK_REOFFER`.
3. `TRANSFER_JOURNAL_WRITE` : 420 écritures, dont une toutes les ~1 s pendant la REC (`files=0`) — la coalescence (1 s) est respectée, aucun impact fonctionnel observé, mais le volume de journaux pourrait être réduit en n'écrivant qu'aux changements d'état utiles.
4. ARM : le skill `capture` de B reste en `WARNING` (`check=sync`, dispersion ~50 ms / delta ~-280 ms sur ce LAN). Cela déclenche le modal d'incident à chaque démarrage de REC ; confirmé par `#armIncidentContinue`, la REC part bien (phase `REC` atteinte en ~5 s sur les 3 appareils). `ARM_RECOVER` de C après retour réseau validé en P04.
5. Délais de reprise observés (retour Wi-Fi → `done`) : P02 **45 s**, P03 **60 s**, P04 **37 s** (Take 1) puis **63 s** (Take 2), P05 **71 s**. Le réveil est immédiat à `NET_CHANGED` ; le temps restant correspond au débit de reprise du fichier (~300 Mo) et aux backoffs.
6. Débit constaté : ~25 Mo/s en transfert nominal, ~7 Mo/s après reprise.

---

## 10. Limites de la campagne

- **Stockage interne uniquement** (le mode SAF n'est pas vérifiable par SHA-256 fichier, décision J14-L5) — hors périmètre J15.
- Une seule session, **un seul Storage (C)** : les scénarios multi-destinations (file d'attente, `QUEUE_FULL`) ne sont pas exercés en matériel (couverts en unitaires).
- Une coupure et un redémarrage par scénario, coupure toujours sur le même device (C) : la reprise d'un device *capture* hors-ligne n'est pas testée ici (aucun transfert ne part de C).
- Verdicts d'ordre : les critères d'intégrité comparent SHA-256 **calculé sur les deux appareils via adb**, pas l'artefact natif de l'app (le log `TRANSFER_HASH` côté app est recoupé pour P01 et P05).
- `deleteLocalAfterVerifiedReplication` désactivé sur P01 et P04 (nécessaire au relevé du SHA source) : la purge n'est donc validée que sur P02/P03/P05 (réglage `true` reconfirmé sur P05).

---

## 11. Verdict

> **J15 — validation physique : PASS.**
> Les 5 scénarios matériels (P01 nominal, P02 coupure Wi-Fi, P03 redémarrage Storage, P04 deux Takes successifs, P05 suppression post-réplication) sont passés sur 3 appareils Android réels, sans simulation, avec intégrité SHA-256 source/destination égale sur les 7 Takes enregistrés, aucune purge prématurée, aucune exception JS, et reprise automatique observée dans les 5 cas d'interruption (37 à 70 s).
> Reproductible par `MODE=setup|p01|p02|p03|p04|p05 tests/e2e/j15-campaign.sh`.
