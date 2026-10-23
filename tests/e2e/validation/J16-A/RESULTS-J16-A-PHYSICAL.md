# J16-A — Validation PHYSIQUE de la consultation des Takes passés (mode archivé)

**État : PASS — 13 critères sur 13, aucun FAIL.**

| | |
|---|---|
| Date | 2026-10-22, 08:43 → 09:07 (heure locale appareils) |
| Branche | `feat/j11-media-transfer` (arbre de travail J16-A, commit à venir) |
| APK testé | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`, md5 `1b84fe822fa5167f0c4da581dc103f02` (**identique sur A, B, C** — vérifié par `pm path` + `md5sum`) |
| Session J16-A | `PT63EPGF` (« Regie J16A-084331 »), PIN `6605`, 3 Takes enregistrés |
| Session antérieure (rétrocompatibilité) | `ZFMYZRAS` (« Regie J14DS2-153027 »), résumé au format **J12** (pas de `stopStates` / `replications`) |
| Pilote | `tests/e2e/j16a-campaign.sh` (CDP + adb, aucun résultat simulé) |
| Rapport implémentation | `docs/J16-A-RESULTS.md` (500 tests unitaires, dont 29 J16-A) |

---

## 1. Montage matériel

| Rôle | Série adb | deviceName | did |
|---|---|---|---|
| **A** — Master / Regie (controller seul) | `61cc29567d91` (Redmi 24075RP89G, USB) | `J16A-A-Master` | `9d714526-9cb5-4e66-a5ab-9886a6117dfa` |
| **B** — Capture seule (capture) | `61d54bba7d91` (USB) | `J16A-B-Capture` | `19848326-0070-44cb-8de3-0d0d4ec7eb19` |
| **C** — Storage seule (storage) | `c0d8514d7d87` (USB) | `J16A-C-Storage` | `ece36247-72e3-4268-a3b7-d0dcf80f4bfa` |

- Wi-Fi commun `192.168.92.0/24`, adb **sur USB** (aucune coupure réseau dans cette campagne).
- Stockage **interne** partout (SAF hors périmètre de vérification SHA — leçon J14-L5).
- Campagne pilotée par CDP (WebView DevTools) + `adb` : le DOM réel de l'application est Piloté et relu, aucune valeur n'est injectée dans les dumps.
- Chaque scénario efface le logcat des 3 appareils, puis archive logcat horodaté, captures d'écran, dumps JSON et chronologie.

**Arborescence des preuves** : `tests/e2e/validation/J16-A/{logs,screenshots,dumps,events}/` — 3,1 Mo, 10 captures d'écran, 18 dumps, 10 logs, 3 chronologies.

---

## 2. Résultat global

| Scénario | Critère | Verdict |
|---|---|---|
| SETUP | Session + rejoindre + membres/rôles | PASS |
| **P01** Take nominal + consultation archivée | faits d'arrêt persistés, réplications persistées, état global non probant, archive ouverte, Capture présente, Storage présent, aucun « indisponible » sur un Take complet, bouton « Retour », retour session, chemin historique | **9/9 PASS** |
| **LEGACY** Take antérieur à J16-A | archive ouverte, Capture identifiée, réplication non inventée, information manquante signalée | **4/4 PASS** |

Fichiers de verdicts : `dumps/verdict-SETUP.txt`, `dumps/verdict-J16A-P01.txt`, `dumps/verdict-J16A-LEGACY.txt`.

---

## 3. SETUP (08:43:07 → 08:43:50)

- 3 appareils vus par `adb devices`, APK md5 identique partout.
- Rôles posés puis application relancée : `A roles=["controller"]`, `B roles=["capture"]`, `C roles=["storage"]`.
- Session créée côté A (`PT63EPGF`, PIN `6605`), B et C rejoignent (`ANNOUNCE_OK` puis `SESSION_JOINED`).
- Membres ajoutés sur A : `["J16A-B-Capture:capture","J16A-C-Storage:storage"]` (`dumps/SETUP-4-A-members.json`).
- Preuves : `screenshots/SETUP-A-session.png`, `SETUP-A-members.png`, `logs/*-SETUP.log`.

---

## 4. P01 — Take nominal puis consultation ARCHIVÉE (08:48 → 09:00, Take 3)

### 4.1 Faits persistés dans le résumé du Take (`dumps/P01-A-summary.json`)

```json
"stopStates": {
  "19848326-…-0d0d4ec7eb19": {
    "state": "STOPPED", "stopId": "PT63EPGF#1#1#1#stop",
    "actualMs": 1792651704097, "localTargetMs": 1792651703632.5,
    "deltaMs": 405.5, "path": "/data/user/0/…/cache/videoTmp_1.mp4",
    "reason": "P01", "receivedAtMs": 1792651704762
  }
},
"replications": {
  "19848326-…-0d0d4ec7eb19|ece36247-…-0dcf80f4bfa": {
    "state": "done", "bytes": 74495151, "total": 74495151, "percent": 100
  }
},
"transferState": "TERMINATED"
```

| Critère | Mesure | Verdict |
|---|---|---|
| Faits d'arrêt **par Capture** persistés | 2 entrées `STOPPED`, dont la Capture avec `deltaMs = 405.5` et son `path` | PASS |
| États de réplication **par couple** persistés | 1 couple `src|sto`, `state=done`, `percent=100` | PASS |
| L'état global n'est jamais probant | `transferState=TERMINATED` — jamais utilisé pour déduire une réplication | PASS |

### 4.2 Consultation de l'archive (écran 03 → Take 003)

Texte réellement affiché par l'application (`dumps/P01-archive-A.txt`) :

```
Regie J16A-084331
Take 003
Terminé
DURÉE DU TAKE
00:00:31
CAPTURES
J16A-B-Capture
Terminé
écart +406 ms
/data/user/0/fr.emmanuel.multicam/cache/videoTmp_1.mp4
J16A-C-Storage
Terminé
73 Mo / 73 Mo · Terminé
Retour à la session
```

| Critère | Mesure | Verdict |
|---|---|---|
| Archive ouverte | `SCREEN09_OPEN_ARCHIVED sessionId=PT63EPGF take=3` puis `SCREEN09_ARCHIVED … state=done unavailable=0` | PASS |
| Capture identifiée | `J16A-B-Capture` + `écart +406 ms` + chemin du média | PASS |
| Storage identifié | `J16A-C-Storage` + `73 Mo / 73 Mo · Terminé` | PASS |
| Aucune information manquante signalée à tort | `unavailable=0`, aucun « Indisponible » | PASS |
| Bouton « Retour à la session » présent et visible | `#tsBack` visible | PASS |
| Retour à la session | `SCREEN09_ARCHIVED_BACK sessionId=PT63EPGF` → panneau `panel-session` | PASS |
| Chemin historique (écran 15) | vue **identique** depuis l'historique (`dumps/P01-archive-A-from-history.txt`, diff vide) | PASS |

Preuves : `screenshots/P01-A-archive.png`, `P01-A-archive-from-history.png`, `logs/A-screen09.log`, `logs/*-J16A-P01.log`.

---

## 5. LEGACY — Take antérieur à J16-A (09:06, session `ZFMYZRAS`, Take 1)

Take enregistré par une version **antérieure** à J16-A : résumé au format J12 (`transfers`), sans `stopStates` ni `replications`.

Texte réellement affiché (`dumps/LEGACY-archive-A.txt`) :

```
Regie J14DS2-153027
Take 001
Information indisponible
DURÉE DU TAKE
00:00:14
CAPTURES
État des réplications indisponible : ce Take a été enregistré avant le suivi des réplications.
Confirmation d'arrêt indisponible pour : J14DS2-B-Capture.
J14DS2-B-Capture
Information indisponible
écart —
Aucune confirmation d'arrêt reçue pour J14DS2-B-Capture
J14DS2-C-Storage
Indisponible
Information de réplication indisponible
Retour à la session
```

| Critère | Mesure | Verdict |
|---|---|---|
| Archive ouverte sur un Take ancien | `Take 001` + durée `00:00:14` (durée persistée) | PASS |
| Capture identifiée | `J14DS2-B-Capture` | PASS |
| Aucune réplication inventée | barre `Indisponible` + `Information de réplication indisponible` | PASS |
| Information manquante signalée explicitement | bandeau « … avant le suivi des réplications » + « Confirmation d'arrêt indisponible » | PASS |

**Lecture** : le mode archivé ne réécrit pas le passé. Un Take sans faits d'arrêt ni états de réplication est affiché comme tel, sans jamais présenter une information absente comme acquise.

Preuves : `screenshots/LEGACY-A-archive.png`, `dumps/LEGACY-archive-A.txt`, `logs/*-J16A-LEGACY.log`.

---

## 6. Anomalie détectée pendant la campagne — **HORS PÉRIMÈTRE J16-A**

### 6.1 Perte de session par écriture non atomique

| | |
|---|---|
| Constat | `files/sessions/DEBNCYNA.json` (session de la campagne J15, 7 Takes) est passé à **0 octet** sur l'appareil A |
| Moment | 08:43:07 — pendant `relaunch` (`am force-stop`) du scénario SETUP |
| Cause | `app/www/js/state/session-store.js:37-49` : `writeFile()` fait `w.truncate(0)` **puis** `w.write(text)`. L'arrêt du processus entre les deux opérations laisse un fichier **vide** : la session entière est perdue (les 7 Takes, le plan, les membres) |
| Portée | **pré-existant** — `session-store.js` n'a pas été modifié par J16-A ; toute session en cours d'écriture est exposée (arrêt de l'app, crash, OOM kill, redémarrage) |
| Effet collatéral | la session J15 `DEBNCYNA` n'est plus listable dans l'historique → le scénario LEGACY a dû viser une autre session antérieure (`ZFMYZRAS`) |

**Correctif recommandé** (non appliqué — hors périmètre J16-A, à arbitrer) : écrire dans un fichier temporaire (`<sid>.json.tmp`) puis le renommer sur `<sid>.json`, afin qu'un arrêt au milieu de l'écriture laisse l'ancien fichier intact. **Le schéma existe déjà dans le dépôt** : `app/www/js/state/transfer-journal.js` écrit via un `.tmp`, relit le contenu (round-trip) puis `moveTo(dir, name)` — il est directement réutilisable pour le manifeste de session.

**Décision attendue** : ouvrir un jalon dédié (correctif P0 de la persistance) — ce défaut contredit l'exigence « les manifests JSON sont la source de vérité ».

### 6.2 Points mineurs relevés

- `wait_arm_ready` (harnais J15 repris) expire en fin de campagne alors que l'enregistrement démarre (`phase=REC`) : le critère de disponibilité de l'ARM est plus strict que l'état réel du service. Sans impact sur le résultat J16-A.
- `#lanCount` inexistant (`home.js:153`) : code mort, sans impact.

---

## 7. Ce que la campagne ne couvre pas

- **Aucun** scénario de panne réseau dans J16-A : la campagne ne teste que la consultation, pas la reprise (couverte par J15).
- Un seul Storage attendu : le cas « une Capture → deux Storage » (2 barres) est couvert par les tests unitaires, pas par la campagne physique.
- La vérification SHA-256 n'est pas rejouée (hors périmètre J16-A ; inchangée depuis J15).
