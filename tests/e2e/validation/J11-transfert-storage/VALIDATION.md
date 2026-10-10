# VALIDATION J11 — verdict **PASS**

Campagne physique du jalon **J11 — Transfert / Storage / réplication**
(`docs/PLAN-DEVELOPPEMENT-V1.md` § J11, lignes 469-500) sur 3 Android réels.

> **Résultat : campagne `j11-campaign.sh` J11-00 → J11-10 enchaînée sans
> échec, `ALL_TRANSFERS_DONE`, SHA-256 identique source/destination,
> suppression locale vérifiée, écran 09 « Terminé ». → J11 = CONFORME.**

Rapport détaillé : [`RAPPORT-J11.md`](./RAPPORT-J11.md) (verdict, tableau de
preuves par critère, défauts trouvés/corrigés, observations, repro).

## 1. Identification

| Élément | Valeur |
|---|---|
| Jalon | J11 (campagne « J11-VALIDATION », session `6KYFXZQ4`) |
| Date | 2026-10-10 |
| Branche | `feat/j11-media-transfer` |
| Implémentation testée | `33033c4` (tête `c860cb3`..`33033c4`) |
| Preuves versionnées | `26b07d8` (dumps, logs, screenshots, RAPPORT-J11.md, `tests/e2e/j11-campaign.sh`) |
| Devices | A Master `61cc29567d91`, B Capture `61d54bba7d91`, C Storage `c0d8514d7d87` (D absent) |
| Session | `6KYFXZQ4` — name `Regie J11-133655`, PIN `4194`, Take 1, `videoTmp_5.mp4` 244 813 234 o |
| Tests unitaires | `cd app && node tests/run.js` → **375 passed / 0 failed** |
| MP4 ajoutés au dépôt | **0** (contrôle interne) |

## 2. Critères d'acceptation (CDC)

| Critère | Résultat |
|---|---|
| Checksum identique source/destination | PASS (`TRANSFER_HASH … e46fabd6…` identique A, B, C) |
| Reprise (Range/offset) | PASS (tests J11.4 / S4 ; pas de coupure réelle en 12 s) |
| Progression écran 09 + vue Storage | PASS (`state=done, percent=100`, `takeStateText=Terminé`) |
| Erreur destination = bouton Réessayer | PASS (retry ciblé `RETRY=1`, re-téléchargement SHA identique) |
| Plusieurs destinations indépendantes | PARTIEL (couvert par tests J11.7/S2 ; D absent du run) |
| Suppression locale seulement après réplication vérifiée | PASS (une suppression, `removed=true`, dossier Capture vidé) |
| Pas de transfert média sur device en RECORDING | PASS (garde S6) |

## 3. Défauts trouvés sur device, corrigés (résumé)

1. Annonce Capture non déclenchée au STOP (hub START appelle sans argument) — `bind()` relit `svc.view()`.
2. SHA-256/serve lisaient le cache interne — action native `stage` (cache → `MultiCam/<sid>/<take>/`).
3. Suppression « vérifiée » qui ne supprimait rien (`removed=0`) — action native `remove`.
4. Double livraison transport (2 sockets/pair) → 2 offres/téléchargements/suppressions — dedup `MEDIA_READY_NOOP`, garde `runningRuns`, dedup des `transfer_result` terminaux.

Détails dans `RAPPORT-J11.md` §3.

## 4. Preuves

`tests/e2e/validation/J11-transfert-storage/` : `dumps/` (session, membres,
transfers A/C, listing, screen09, storage-dom), `logs/<serial>-J11-07.log`
(stage, serve, hash, delete), `screenshots/` (12 captures). Harnais
reproductible : `tests/e2e/j11-campaign.sh`.