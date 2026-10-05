# RAPPORT J09-08e — validation physique caméra/segment/UI (2 devices réels)

**Résultat : NON CONFORME — 1 défaut bloquant confirmé (9 contrôles sur 72).**
Aucun fichier produit n'a été modifié. Aucune correction n'a été tentée.

---

## 1. Identification

| Élément | Valeur |
|---|---|
| Jalon | J09-08e (validation physique finale de `J09-08c/d`) |
| Branche | `feat/j09-rec-previews` |
| HEAD | `077fe0e` — « J09-08d : l'UI affiche la caméra et le segment RÉELS » |
| APK | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` |
| APK SHA-256 | `7f2a9705480ccaaeb81b35cdfda7ecbe13533fd7f3564aa0856357935c1f41b6` (4 726 137 octets) |
| Session de preuve | `ZU5YMVHB` (pin 9026) |
| Tag d'artefacts | `J0908e-222328` |
| Harness | `tests/e2e/validation/J09-rec-previews/run-j09-08e.sh` |
| Médias (hors Git) | `/Volumes/SSD1TO/testia/openCode/_J09-08e-media` |

## 2. Devices

| Rôle | Série | Modèle | SDK | deviceId | Skills |
|---|---|---|---|---|---|
| A — Master + Capture locale | `61cc29567d91` | 24075RP89G | 36 | `c1e64ce0-59ac-4ffe-831b-34328945147e` | capture, storage, controller |
| B — Capture basculée | `61d54bba7d91` | 24075RP89G | 36 | `24e2b9e2-81d6-476d-a138-113851f8e6fc` | capture, storage |

Wi-Fi `CL07` : A `192.168.92.147/24`, B `192.168.92.162/24`. Endpoint annonceur : `192.168.92.147:45102`.

> Les `deviceId` ont changé pendant la mission : les données applicatives ont été
> réinitialisées (`pm clear`) pour repartir d'un état réellement neuf, ce qui a aussi
> révoqué les permissions — réaccordées ensuite (`CAMERA`, `RECORD_AUDIO`).

## 3. Déroulé de la preuve

72 contrôles : **63 PASS / 9 FAIL / 12 OBS**. Les 9 FAIL proviennent d'une **seule et
même cause** ; les 63 autres contrôles (ségments, deux bascules, STOP, fichiers,
mosaïque, invariants d'UI) sont conformes.

### Segment 1 — conforme côté Capture, MUET côté Master

| Temps | Ce que montre la Capture (B) | Ce que reçoit le Master (A) |
|---|---|---|
| 22:24:16 | `segmentIndex=1`, `segmentState=recording`, `recording=true`, `activeCamera=REAR` (relecture native) | **rien** |
| +40 s (sonde 500 ms) | idem | inbox vide, modal « Caméra inconnue », 0 bouton |
| 22:25:32 (bascule 1) | segment 2 `FRONT` | reçoit enfin l'état (76 s de retard) |

Sortie locale B : `Caméra Arrière` / `Segment 1`.
Sortie locale A (sa propre Capture) : `Caméra Arrière · segment 1 · enregistrement` (conforme).
Modal Master pour B : `Caméra inconnue` + « aucun ordre n'est proposé » (0 bouton).

### Bascules — conformes

| Bascule | Confirmation murale | `swMs` natif | Segment | Gap preview max | Cible présentée avant confirmation |
|---|---|---|---|---|---|
| 1 : REAR → FRONT | 4 461 ms | 1 573 ms | 2 | 1 009 ms | **jamais** (`Bascule vers Selfie…` transient seulement) |
| 2 : FRONT → REAR | 4 410 ms | 1 384 ms | 3 | 1 460 ms | **jamais** (`Bascule vers Arrière…` transient seulement) |

Après chaque bascule, A affiche exactement `Caméra Selfie · segment 2 · enregistrement`
puis `Caméra Arrière · segment 3 · enregistrement`. Le bouton de la caméra active est
seul désactivé (1/2), conformément à `live-detail.js`.

### STOP — conforme

`recording=false`, `segmentIndex=0`, `segmentState` vide, modal Master
`Caméra Arrière · aucun segment actif · n'enregistre pas`, **aucune mention de
« segment 0 »**, `previewKept=1` sur les 3 `CAMERA_REC_STOP_OK`.

### Fichiers — conformes (hors Git)

| Segment | Caméra | Fichier | Durée | Octets | SHA-256 (extrait) |
|---|---|---|---|---|---|
| 1 | REAR | `videoTmp_3.mp4` | 74,048 s | 185 875 678 | `14c38b85e7ebaa8e…` |
| 2 | FRONT | `videoTmp_4.mp4` | 10,517 s | 26 452 014 | `5cc036f4c1762acd…` |
| 3 | REAR | `videoTmp_5.mp4` | 12,608 s | 31 553 080 | `586434ace2f8dcfec…` |

3 fichiers distincts, h264 1920×1080 + aac 48 kHz mono. Attribution
`segmentIndex ↔ caméra ↔ fichier` lue dans l'**état** de B, confirmée par les logs
(`CAMERA_SEGMENT_OPEN/FINAL`, `CAMERA_REC_STOP_OK`).

### Mosaïque — conforme

2 vignettes, 2 deviceIds distincts, aucun doublon de slot. La ligne locale de A est
restée `Caméra Arrière · segment 1 · enregistrement` pendant les deux bascules de B :
**aucun vol de slot**.

---

## 4. LE DÉFAUT (bloquant)

> **Le Master n'apprend jamais l'existence du segment 1.**
> La Capture publie bien son état à l'ouverture du segment 1, mais le message
> **n'atteint aucun Master** : il est produit puis silencieusement abandonné.
> Le Master reste « Caméra inconnue » jusqu'à la **première bascule** (ou le STOP),
> soit **76 s** sur cette prise — et indéfiniment si aucun switch n'a lieu.

### Preuve directe (logs B, `CAMERA_STATE_TX`)

```
22:24:16  CAMERA_STATE_TX sessionId=ZU5YMVHB activeCamera=REAR switchingCamera=— masters=0   ← segment 1 : PERDU
22:25:32  CAMERA_STATE_TX sessionId=ZU5YMVHB activeCamera=FRONT switchingCamera=— masters=1
22:25:45  CAMERA_STATE_TX sessionId=ZU5YMVHB activeCamera=REAR switchingCamera=— masters=1
22:25:59  CAMERA_STATE_TX sessionId=ZU5YMVHB activeCamera=REAR switchingCamera=— masters=1
```

Côté Master, **aucun** `CAMERA_STATE_DROP` ni `CAMERA_TRANSPORT_DROP` : le message
n'est pas rejeté à la réception, il n'a jamais été émis.

### Localisation : locale, pas relayage

Au même instant (22:24:16), le transport de preview Satoit :
`PREVIEW_FRAME_TX sessionId=ZU5YMVHB seq=1 candidates=1 peers=1 nonMastersSkipped=0
otherSessionSkipped=0` — la socket du Master est **connue, dans la session, et
reconnue comme relay-master**. Le relayage est donc sain ; c'est l'appelant qui
échoue.

### Cause (code)

1. `camera-switch-service.js:470-503` — `onRecordingStarted()` ouvre le segment 1
   (`CAMERA_SEGMENT_OPEN segmentIndex=1 camera=REAR`, observé) puis appelle
   `broadcastState("rec_started")`.
2. `camera-switch-service.js:897` — `broadcastState()` passe
   `lastSession || { sessionId: s.sessionId }`.
3. `lastSession` (`:45`) **n'est renseigné que sur le chemin des commandes de bascule**
   (`resolveCurrent()` depuis `requestSwitch`/`requestSwitchRemote` `:594,:703`, et le
   pont `onCameraSwitchRequest` `:826-833` qui recharge explicitement la session).
   **Le chemin d'ouverture du segment 1 ne le renseigne jamais.**
4. `lastSession` est donc `null` → le repli `{ sessionId }` est envoyé, **sans la liste
   `masters`**.
5. `session-ws.js:1145` `isMasterDevice(session, did)` lit `session.masters` → `false`
   pour tous les pairs → `sent = 0` → `CAMERA_STATE_TX … masters=0` → rien n'est
   envoyé, **sans aucun log d'erreur**.

Conséquence de conception : **la première publication d'état de chaque prise est
toujours perdue** ; seules les publications suivantes (confirmations de bascule, STOP)
passent, parce qu'elles passent par le chemin qui recharge la session.

### Défaut secondaire rattaché

Aucun `camera_state` n'est émis au **début** d'une bascule (seuls les 4 TX ci-dessus
existent). Pendant les ~4,5 s de bascule, le Master n'a **aucune** indication
transitoire : il affiche l'état précédent, ou « Caméra inconnue » s'il n'a encore
rien. Le transient `Bascule vers …` n'est visible que sur le device Capture.

---

## 5. Conformité J09-08b/b3/b4 (invariants de caméra et de slot)

| Invariant | Résultat |
|---|---|
| `activeCamera` = relecture native, jamais la cible demandée | **PASS** (`REAR` au segment 1, `FRONT`/`REAR` après bascule) |
| Cible jamais présentée comme active avant confirmation | **PASS** (2/2 bascules) |
| `requestedCamera` jamais promu en actif dans l'UI | **PASS** (modal Master conforme) |
| Ligne locale = faits du device local | **PASS** (A : `Caméra Arrière · segment 1 · enregistrement`) |
| Pas de duplication / vol de slot | **PASS** (mosaïque 2/2, ligne de A inchangée) |
| Reprise de preview après bascule | **PASS** (gap max 1 009 / 1 460 ms) |

## 6. Constats hors périmètre (à arbitrer, non treated comme des défauts)

1. **Flux JPEG vers le Master gelé après le STOP** : la sonde de preview est liée au
   REC par construction (`preview-service.js`, J09-03 : démarrage après l'ACK du REC,
   arrêt sur `stopRecording`). La preview **native** est bien conservée
   (`previewKept=1` ×3). Si « aperçu permanent hors REC » est attendu côté Master,
   c'est un hors-périmètre J09-08 à confirmer.
2. **`requestedCamera` conserve la dernière demande** après confirmation
   (`actif=FRONT demande=FRONT`). L'UI ne s'en sert jamais comme active, mais le
   champ reste ambigu pour un lecteur tiers.
3. **Le Master ne peut pas arrêter sa propre Capture locale** : `liveStopDock` est
   volontairement vide en J09 et `#cdEmergency` est masqué sur la vue Master. Le
   fichier de A n'a donc pas pu être finalisé proprement (arrêt par force-stop).
4. **L'état de phase est persisté** : après un `force-stop`/relance, un device peut
   retrouver `phase=REC` (enregistreur relancé). Une Capture restée liée à une prise
   terminée peut refuser un nouveau START sans remise à zéro.
5. `restart_failed` non injecté : injecter une panne_plugin.exigerait de modifier le
   produit, hors mission.

## 7. Artefacts

```
tests/e2e/validation/J09-rec-previews/
├── RAPPORT-J09-08E.md              ce rapport
├── run-j09-08e.sh                  harness (outil de preuve, non produit)
├── logs/J0908e-222328-*            15 fichiers (checks, mesures, fichiers, par device et par étape)
├── dumps/J0908e-222328-*           15 dumps JSON
└── screenshots/J0908e-222328-*     14 captures
```

Points d'entrée : `logs/J0908e-222328-checks.txt` (63 PASS / 9 FAIL / 12 OBS),
`logs/J0908e-222328-fichiers.txt`, `logs/J0908e-222328-arrivee-master.txt`
(trace d'arrivée de l'état, 40 s), `logs/J0908e-222328-mesures.txt`.

**Aucun MP4 dans le dépôt** : les 3 fichiers sont dans
`/Volumes/SSD1TO/testia/openCode/_J09-08e-media`.

## 8. Reproductibilité

Le défaut a été observé sur **4 exécutions consécutives** de la même séquence
(`J0908e-203254`, `J0908e-220424`, `J0908e-221138`, `J0908e-221915`, `J0908e-222328`),
toujours avec `masters=0` sur la première émission et `masters=1` sur les suivantes.
Il est **déterministe**, pas une course.

## 9. Suite proposée (décision attendue, non exécutée)

Le correctif appartient au chemin d'émission, pas à l'UI :

- recharger la session avant la publication du segment 1 (comme le fait déjà le pont
  des bascules), **ou**
- transporter l'identité du relay-master dans l'enveloppe `camera_state` plutôt que de
  filtrer sur un objet de session mis en cache.

Aucune modification n'a été faite : le choix relève d'une décision produit.