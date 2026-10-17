# J14-B03 — Intégrité des transferts multi-captures

## Objectif
Garantir qu'un Storage (C) reçoive simultanément les médias de plusieurs Captures (B, D) pour un même Take sans collision/corruption/suppression prématurée.

## Anomalies corrigées
1. Collision destination — `destFor` construisait `MultiCam/<sessionId>/<take>/<relativePath>` sans `deviceId` source (B et D visaient le même fichier). Fix: `MultiCam/<sessionId>/<take>/<sourceDeviceId>/<relativePath>`.
2. SHA-256 mismatch B→C — écriture/append non alignée sur l'offset ; risque d'octets dupliqués lors de reprise. Fix natif: alignement taille disque à offset (`setLength`) avant append en reprise ; ajustement de `offset` à la taille sur disque (log `TRANSFER_NATIVE resume adjusted ...`).

## Topologie (physique)
- A `61cc29567d91` (Master/controller)
- B `61d54bba7d91` (Capture)
- C `c0d8514d7d87` (Storage)
- D `R83Y106V1HF` (Capture, SM-X110, Wi-Fi TCP)

## APK
- MD5 local/build : `db14e5d0cf282b5bb647f01ad65fa322` (installé sur A/B/C/D)

## Preuves
- Harnais : `tests/e2e/j14b03-multicapture.sh`
- Preuves : `tests/e2e/validation/J14-B03/` (dumps/, logs/, screenshots/, j14b03-run.log, verdict.txt)
## Résultat (4 devices)
VERDICT T1: PASS
VERDICT T2: PASS
