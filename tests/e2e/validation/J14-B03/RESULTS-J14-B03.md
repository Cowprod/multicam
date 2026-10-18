# J14-B03 — Intégrité des transferts multi-captures — Résultats complets

Session physique : `sid=G3635MCH` (`Regie J14B03-*`), 4 devices, APK
`db14e5d0cf282b5bb647f01ad65fa322` (installé + MATCH sur A/B/C/D, preuve
`dumps/apk-md5.txt`). Preuves brutes : `dumps/`, `logs/`, `screenshots/`,
`j14b03-run.log`. Aucun MP4 publié (seuls SHA-256 et tailles).

## Objectif
Garantir qu'un Storage (C) reçoive simultanément les médias de plusieurs
Captures (B, D) pour un même Take sans collision, corruption, ou suppression
prématurée de la source.

## Anomalies corrigées (commit applicatif 5b6bc03)
1. **Collision destination** — `destFor` construisait
   `MultiCam/<sessionId>/<take>/<rel>` sans `deviceId` source : B et D visaient
   le même fichier sur C. Fix : `MultiCam/<sessionId>/<take>/<sourceDeviceId>/<rel>`.
2. **SHA-256 mismatch (append non aligné)** — le natif ouvrait en append avec
   l'offset demandé mais écrivait toujours à l'EOF réel → octets dupliqués en
   reprise. Fix natif : réconciliation offset/ taille disque
   (log `TRANSFER_NATIVE resume adjusted requested=… onDisk=…`) + `setLength(offset)`
   avant append.

## Topologie (physique)
- A `61cc29567d91` (Master/controller)
- B `61d54bba7d91` (Capture) — DID `19848326-0070-44cb-8de3-0d0d4ec7eb19`
- C `c0d8514d7d87` (Storage) — DID `ece36247-72e3-4268-a3b7-d0dcf80f4bfa`
- D `R83Y106V1HF` (Capture SM-X110, Wi-Fi TCP) — DID `d618012d-c15b-4a08-8097-88e75f126cd4`

## T1 — anti-collision (B et D vers C, même Take)
État des 4 transferts (`dumps/tr-A-T1.json`, `dumps/tr-C-T1.json`) :
`state=done`, `percent=100` pour les 2 chemins `B|C` et `D|C`.

| Source | Fichier | SHA-256 (source = destination) | Taille | Destination sur C |
|---|---|---|---|---|
| B | videoTmp.mp4 | `1bf09a56cdf607024dbc5f7576492c7425be2b226e614db2c61e26e277670f2e` | 168 666 476 | `MultiCam/G3635MCH/1/19848326-0070-44cb-8de3-0d0d4ec7eb19/videoTmp.mp4` |
| D | videoTmp.mp4 | `7f24ed56d6c9de3e7c1ec35788e9857d0a39ab3479a9df436555a0f6f63339ff` | 427 805 628 | `MultiCam/G3635MCH/1/d618012d-c15b-4a08-8097-88e75f126cd4/videoTmp.mp4` |

Arborescence observée sur C (`dumps/dirs-C-T1.txt`) : sous-dossier par source,
2 fichiers distincts, `chemins_distincts=true` (`dumps/verdict.txt`).

## T2 — coupure Wi-Fi C en plein transfert + reprise
- Coupure exercée : `j14b03-run.log` « C wifi disable (plein transfert) » puis
  « C wifi enable » ; capture du transfert partiel : `dumps/t2-caught-partial.txt`
  → `caught_partial=yes`.
- Échecs observés puis reprise (log C, `logs/c0d8514d7d87-T2.log`) :
  - `TRANSFER_FILE_ERROR file=videoTmp.mp4 attempt=1 error=… SocketException: Software caused connection abort`
  - `TRANSFER_NATIVE resume adjusted requested=4678488 onDisk=7087960 dest=…/MultiCam/G3635MCH/2/19848326-…/videoTmp.mp4` (réconciliation d'offset, preuve du correctif natif)
  - attempts 2 et 3 : `ConnectException: Failed to connect to /192.168.92.76:8080`, puis reprise après réactivation Wi-Fi.

| Source | Fichier | SHA-256 (source = destination) | Taille | Destination sur C | Reprise |
|---|---|---|---|---|---|
| B | videoTmp.mp4 | `9d28667bb558e3449d3fbeab70e64416d12afd6f06c8b4698fbad5ddb8c7b053` | 151 007 518 | `MultiCam/G3635MCH/2/19848326-0070-44cb-8de3-0d0d4ec7eb19/videoTmp.mp4` | coupure + 3 tentatives + reprise OK |
| D | videoTmp.mp4 | `7426790361bdba49b4998e8ceb9ba02f7a23d56345f9c006acdc543f711a94cb` | 380 683 676 | `MultiCam/G3635MCH/2/d618012d-c15b-4a08-8097-88e75f126cd4/videoTmp.mp4` | transfert continu après reprise Wi-Fi OK |

État des 4 transferts (`dumps/tr-A-T2.json`, `dumps/tr-C-T2.json`) :
`state=done`, `percent=100`. Anti-collision : `chemins_distincts=true`.

## Sources non supprimées avant confirmation d'intégrité
Ordre vérifié dans `logs/61cc29567d91-T1.log` et `…-T2.log` (4 transferts) :
`TRANSFER_HASH` (sourceSha256 == storageSha256) **→** `TRANSFER_RESULT state=done`
**→** `TRANSFER_DELETE` + `TRANSFER_DELETE_ACK`. Ex. T1-B : HASH et RESULT ligne 816-817,
DELETE ligne 818-819 ; T2-B : 2277-2278 puis 2280 ; T2-D : 3446-3447 puis 3449.
Inventaires sources (`dumps/local-sha-T{1,2}-{B,D}.txt`, SHA+tailles complets)
capturés **avant** chaque DELETE (mtimes 08:15:37/38 et 08:21:05/06, vs DELETE
08:15:49.320, 08:18:26.375, 08:21:24.487, 08:23:57.407). Inventaires
destination (`dumps/dest-sha-T{1,2}-C.txt`) capturés après completion
(08:18:35, 08:24:08). Les répertoires sources sont aujourd'hui vides sur B et D
(vérification adb post-run) : suppression post-confirmation uniquement, comme
prévu par le modèle (suppression locale après réplication vérifiée).

## Verdicts
- `dumps/verdict.txt` : `VERDICT T1: PASS`, `VERDICT T2: PASS`,
  `VERDICT GLOBAL: PASS` — régénéré **à partir des dumps archivés** par le
  vérificateur corrigé `tests/e2e/j14b03-verify.sh` (rc=0), sans refaire T1/T2.
- Tests JS : `node tests/run.js` → **404 passed, 0 failed** (dont 5 tests
  J14-B03-harnais dans `app/tests/j14b03-harness-verify.test.js`).

## Défaut de harnais corrigé (audit indépendant, round-trip)
L'audit du commit 5b6bc03 a relevé : erreur `tag: unbound variable` (ligne 259
de l'ancien `verify_take`) et `verdict.txt` vide publié. Correctifs (ce tour) :
- Vérification externalisée dans `tests/e2e/j14b03-verify.sh` : `set -euo pipefail`,
  piège `EXIT` installé **avant** toute validation de variable — toute interruption
  (variable non bornée, erreur Node, comparaison ratée) laisse
  `VERDICT GLOBAL: ERREUR|FAIL` explicite et rc != 0 ; jamais de fermeture
  silencieuse. Le harnais appelle ce script et sort en 1 en cas d'échec.
- Tests de non-régression : `app/tests/j14b03-harness-verify.test.js`
  (fixtures PASS, SHA corrompu → FAIL, destination manquante → FAIL,
  variable absente → ERREUR non vide, `bash -n` des deux scripts).

## Limites documentées (aucune lacune masquée)
- Inventaires sources T2 capturés avant la fin du transfert D (08:21:05 vs
  done 08:23:57) : normal (inventaire fait après STOP, avant fin de transfert) ;
  l'intégrité D→C est prouvée par le HASH/RESULT du Master et la comparaison
  source/destination des dumps.
- `manifest_capture` (fallback SHA depuis le manifeste de capture) a renvoyé
  0 segment lors des runs : non utilisé (inventaires locaux présents).
