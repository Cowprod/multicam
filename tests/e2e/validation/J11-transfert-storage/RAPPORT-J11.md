# J11 — Transfert / Storage / réplication

Transfert HTTP reprenable des médias d'une Capture vers un Storage après STOP,
avec vérification SHA-256 source/destination, suppression locale après
réplication vérifiée, et reprise.

Date de validation : 2026-10-10
Devices :
- Master / Régie : `61cc29567d91` — localDid `91e0d5e6-a086-4c4b-820e-0435b7d97b22`
- Capture : `61d54bba7d91` — localDid `afd69dd6-1409-4d00-b4bc-01318afc22e3`
- Storage : `c0d8514d7d87` — localDid `94a4939e-d09e-4504-86e8-e79751920134`

Campagne reproductible : `tests/e2e/j11-campaign.sh`
Session de référence : `6KYFXZQ4`, name `Regie J11-133655`, PIN `4194`, Take 1.
Fichier source : `videoTmp_5.mp4`, 244 813 234 octets.

---

## 1. Verdict

**PASS.** Sur un enregistrement réel (REC 12 s), la Capture annonce son média,
le Master offre le transfert au Storage, le fichier est téléchargé sur le
Storage puis vérifié (SHA-256 identique source/destination), la progression
est visible (état `done`, `percent=100`), et la suppression locale est
ordonnée UNE fois et exécutée réellement sur la Capture (fichier absent du
disque après coup). Le Réessayer du Master relance une offre ciblée.

---

## 2. Ce qui est démontré sur device

| Critère (CDC J11) | Preuve | Valeur |
|---|---|---|
| Session créée sur le Master | `J11-02-A-created.json` | `sid=6KYFXZQ4`, PIN `4194` |
| Rôles effectifs | logs/rels `J11-01` | A=master, B=capture, C=storage1 |
| B et C rejoignent | logs `J11-03` | `SESSION_JOINED` ×2 |
| Annonce après STOP (défaut n°1 corrigé) | log B `J11-07` | `TRANSFER_ANNOUNCE_TRIGGER sessionId=6KYFXZQ4 take=1` |
| Staging cache → arborescence (défaut n°2 corrigé) | log B `J11-07` | `TRANSFER_STAGE_OK rel=videoTmp_5.mp4 dest=/storage/emulated/0/Android/data/fr.emmanuel.multicam/files/MultiCam/6KYFXZQ4/1/videoTmp_5.mp4` |
| Serveur HTTP démarré sur la Capture | log B `J11-07` | `TRANSFER_SERVE url=http://192.168.92.76:8080 files=1` |
| Une seule offre malgré la double livraison transport | log A `J11-07` | `TRANSFER_OFFER_TX … sent=1` + `MEDIA_READY_NOOP` |
| Vidéo réelle téléchargée sur le Storage | `J11-08-C-listing.json` + `ls` C | `videoTmp_5.mp4` présent, 244 813 234 octets |
| **SHA-256 source = destination** | log A/B/C `J11-07` | `TRANSFER_HASH sourceSha256=e46fabd67323b1b2ae0bfcdeeda4ca7192d8f3e01ac9bbc7178fb73251170aa0 storageSha256=e46fabd67323b1b2ae0bfcdeeda4ca7192d8f3e01ac9bbc7178fb73251170aa0` |
| État `done` source et destination | `J11-07-A-transfers.json` + `J11-07-C-transfers.json` | `state=done, percent=100, bytes=244813234, total=244813234` |
| Progression visible écran 09 | `J11-09-A-screen09.json` | `phase=STOPPED, takeStateText=Terminé, transfers=1` |
| Vue Storage (device Storage listée) | `J11-09-C-storage-dom.json` | `devices=94a4939e…`, `rows=7` |
| Suppression locale ordonnée UNE fois | log A `J11-07` | `TRANSFER_DELETE_TX … sent=1` (unique, visible aussi `logs`) |
| Suppression locale exécutée réellement | log B + `ls` B | `TRANSFER_NATIVE remove … removed=true` ; répertoire `MultiCam/6KYFXZQ4/1/` **vide** sur B |
| ACK retour au Master | log B/A `J11-07` | `TRANSFER_DELETE_ACK … source=afd69dd6-…` |
| Réessayer (reprise offre ciblée) | sortie campagne `J11-10` | `retry(B) sur le Master = "RETRY=1"` |
| Aucune offre/serveur sur un Storage en RECORDING | garde `S6` (tests) | `375 unit tests pass` |

Chronologie reconstituée (log B `J11-07`) :

```
13:50:35  TRANSFER_ANNOUNCE_TRIGGER sessionId=6KYFXZQ4 take=1
13:50:36  TRANSFER_STAGE_OK rel=videoTmp_5.mp4 dest=…/MultiCam/6KYFXZQ4/1/videoTmp_5.mp4
13:51:03  TRANSFER_HASH sourceSha256=e46fab… storageSha256=e46fab…   (A, B, C)
13:51:03  TRANSFER_NATIVE remove path=…/MultiCam/6KYFXZQ4/1/videoTmp_5.mp4 removed=true
13:51:03  TRANSFER_LOCAL_DELETE_NATIVE files=1 removed=1
13:51:03  TRANSFER_LOCAL_DELETED take=1 files=1
13:51:03  TRANSFER_DELETE_ACK take=1 source=afd69dd6-…
```

---

## 3. Défauts trouvés sur device, corrigés

Sans la campagne device, aucun n'aurait été visible sur les tests unitaires.

### 3.1 L'annonce Capture après STOP n'était pas déclenchée par le hub

`transfer-boot.js` s'abonnait au START du hub avec `onStartView` **argument du
hub**, alors que le hub appelle ses listeners **sans argument** et qu'il faut
relire `svc.view()` soi-même. Résultat : jamais d'annonce sur device.
Correctif : `bind()` lit `svc.view()` et se ré-abonne une seule fois.
Régression : test `B2b` (listener appelé sans argument → annonce).

### 3.2 Le média rejouait depuis le cache interne

Le SHA-256 / `serveStart` / SHA-256 du téléchargement lisaient le segment dans
le **cache interne** de l'app (`/data/user/…/cache`), qui ne survit pas aux
rejets mémoire et nuit à la reprise. Correctif : action native **`stage`**
(`MultiCamTransfer.java`, `doStage`) qui déplace le segment cache →
`files/MultiCam/<session>/<take>/`, idempotente ; le service SHA/serve/delete
utilise désormais `paths.stageSegments` (repli `listSegments`).
Régression : `B2c`, `captureAnnounce`/`captureHandleDelete` (S1/S8 adaptés).

### 3.3 Suppression locale « vérifiée » qui ne supprimait rien (`removed=0`)

`deleteLocalFiles` utilisait `root.resolveLocalFileSystemURL(p)` avec un chemin
absolu nu (`/storage/emulated/0/…`) → résolution impossible, `removed=0`,
**fichier conservé** malgré l'ACK. Correctif : action native **`remove`**
(`doRemove`, verdict réel `exists() && delete()`), le File API HTML restant en
repli. Preuve device : `TRANSFER_NATIVE remove … removed=true` et répertoire
B réellement vidé.

### 3.4 Double livraison transport : la même annonce provoquait 2 offres, 2 téléchargements, 2 suppressions

Le transport écrit par **chaque socket** (`serverConns` + `clientConns`) :
chaque pair reçoit 2× chaque broadcast → sur device, `peers=4` pour 3 devices.
Garde `runningRuns` dans `storageRun` (1 téléchargement par source), dedup
`sameManifest()`/`MEDIA_READY_NOOP` (pas de seconde offre), dedup des
`transfer_result` **terminaux identiques** par fichier (le Master n'ordonne
qu'UNE suppression locale). Preuve device : log A/C `MEDIA_READY_NOOP`, un seul
`TRANSFER_DELETE_TX`, un seul `removed=true` (pas de paire `0`/`1`).
Régression : `B2c`, `J11.1b`, `J11.1c`, `S2c`, `S2d`, `S3b`.

Race résiduelle observée en 13:09 (avant `.3`, session `7GBKSA5B`) : deux
`remove` concurrents sur le même fichier → `removed=0` puis `removed=1`
(89 ms), fichier effacé quand même. Éliminée par la dedup des résultats.

*Note d'API (non changée) : `retry(sourceDid)` ré-émet une offre sans vérifier
l'état — l'UI n'expose « Réessayer » que sur les lignes en erreur, la campagne
l'invoque en direct. Conséquence : le retry re-télécharge entièrement
(offset=0), SHA identique après chaque run.*

---

## 4. Observations / limites de cette validation

- **Montage 3 devices.** Le 4e device `R83Y106V1HF` est instable/absent →
  campagnes exécutées avec `HAS_D=0`, un seul Storage (`NSTO_EXPECT=1`).
  L'indépendance entre plusieurs destinations est couverte par les tests
  `J11.7` / `S2` (2 Storage), pas par un run device réel.
- **Reprise réseau (Range/206)** non exercée ici (réseau wifi stable) : couverte
  par les tests `J11.4` / `S4` (offset conservé). La pré-preuve endpoint et les
  logs `TRANSFER_RUN_SKIP`/`TRANSFER_RESULT` sont présents mais pas de coupure
  réelle pendant le 12 s de REC.
- Le staging déplace le segment : le cache interne ne garde plus l'original
  (CHOIX : l'original vit dans `files/MultiCam/…` jusqu'à la suppression
  vérifiée). `listSegments` pointe vers le cache : après staging, la lecture ne
  se fait que via `stageSegments`.
- ADB irrégulier sur ce laboratoire : quelques devices disparaissent/reparaissent
  pendant les runs ; `adb kill-server && adb start-server` rétablit (sinon
  erreur « more than one device » sur `adb reconnect` seul).

---

## 5. Comment reproduire

```bash
cd tests/plugin-lab   # (inutilisé ici : campagnes = adb + CDP, build app/)
cd tests/e2e
J11_SKIP_INSTALL=1 ./j11-campaign.sh
# sortie attendue : SESSION_JOINED ×2, ARM_READY, ALL_TRANSFERS_DONE,
# J11-08 listing non vide, J11-09 screen09 takeStateText=Terminé, retry RETRY=1
```

Tests unitaires : `cd app && node tests/run.js` → **375 passed, 0 failed**
(J11, J11 service : annonce, offre dédupliquée, staging, pull, garde
RECORDING, suppression native unique).

---

## 6. Fichiers de preuve

`tests/e2e/validation/J11-transfert-storage/`
- `dumps/J11-02-A-created.json`, `dumps/J11-04-A-members.json`
- `dumps/J11-07-A-transfers.json`, `dumps/J11-07-C-transfers.json`
- `dumps/J11-08-C-listing.json`, `dumps/J11-09-A-screen09.json`,
  `dumps/J11-09-C-storage-dom.json`
- `logs/<serial>-J11-07.log` (A, B, C) : `TRANSFER_STAGE_OK`,
  `TRANSFER_HASH` (identiques), `TRANSFER_NATIVE remove removed=true`,
  `TRANSFER_DELETE_ACK`
  (*Note harnais : les buffers logcat contiennent la queue des sessions
  précédentes du même matériel ; les lignes de la session validée sont keyées
  `sessionId=6KYFXZQ4` — les artifacts cités dans ce rapport sont tous extraits
  de ces lignes.*)
- `screenshots/J11-02-A-session.png` … `J11-09-c0d8514d7d87-storage-view.png`
- Vérification disque : répertoire local de B vidé ; fichier destination
  présent sur C (`ls` reproduit dans ce rapport).