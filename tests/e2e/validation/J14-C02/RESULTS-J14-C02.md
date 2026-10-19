# J14-C02 — Validation physique D1 (convergence Master/Storage) et D3 (suppression après réplication)

**Date** : 19 octobre 2026
**Session** : `2HVHJ8VV` — « Regie J14-C02-160330 »
**Harnais** : `tests/e2e/j14c02-campaign.sh`
**APK attesté (md5)** : `a2f292ec4dba10723485ce33c6f36992` sur les 4 appareils
**Git** : branche `feat/j11-media-transfer`, HEAD `0b03aaf`
**Durée campagne** : ~3377 s (~56 min, attente des transferts terminaux incluse)

---

## 1. Objectif

Valider physiquement, de bout en bout sur appareils réels, les correctifs issus de J14-C01 :

- **D1** — Après coupure Wi-Fi de la Storage (C) pendant un transfert : Master (A) et Storage (C)
  **convergent** (reprise **ou** erreur terminale explicite), sans divergence durable ni transfert
  bloqué indéfiniment.
- **D3** — Suppression du Take précédent (T2) une fois sa réplication **confirmée**, y compris
  pendant le REC du Take suivant (T3) : suppression **différée** jusqu'à la fin du REC, cible
  correcte, pas de bug « files=0 », Take courant (T3) préservé.

Sans relancer la campagne d'endurance J14.

## 2. Environnement

| Rôle | Appareil | Serial / adresse | DID |
|------|----------|------------------|-----|
| A — Master / Régie | 24075RP89G | `61cc29567d91` | `9d714526-9cb5-4e66-a5ab-9886a6117dfa` |
| B — Capture | 24075RP89G | `61d54bba7d91` | `19848326-0070-44cb-8de3-0d0d4ec7eb19` |
| C — Storage | 24075RP89G | `c0d8514d7d87` | `ece36247-72e3-4268-a3b7-d0dcf80f4bfa` |
| D — Capture (USB) | SM-X110 | `R83Y106V1HF` / TCP `192.168.92.103:5555` | `d618012d-c15b-4a08-8097-88e75f126cd4` |

- **T1** = Take 1 (120 s), **T2** = Take 2 (300 s), **T3** = Take 3 (300 s).
- Scénario D1 appliqué sur T1 ; scénario D3 sur T2 → T3.

## 3. Résultats D1 — convergence après coupure Wi-Fi de C

- Transfert T1 en cours détecté, puis **Wi-Fi de C coupé 20 s** (jamais D), réactivé, **sans aucune
  intervention manuelle** sur les appareils.
- Réconciliation observée côté C : `RESYNC_RECONNECT=6`, `RESYNC_TRIGGER=2`, `RESYNC=8`.
- Convergence Master/Storage (terminale) : `converged=YES B:A=error/C=error D:A=error/C=error`.
- Aucun `TRANSFER_STUCK_FINAL` ni `TRANSFER_WATCHDOG_ERR` (aucun transfert bloqué indéfiniment).
- Les deux sources (B, D) convergent vers le **même état** des deux côtés ⇒ **aucune divergence durable**.

**Interprétation** : la coupure réseau fait échouer la lecture HTTP en cours ; les tentatives
bornées (`MAX_ATTEMPTS=3`, connect 15 s / read 30 s) s'épuisent pendant la coupure, produisant une
**erreur terminale explicite** des deux côtés. C'est l'un des deux états acceptés par la mission
(« reprise **ou** erreur terminale explicite »). Aucune reprise n'est observée sur ce profil de
panne (coupure > fenêtre de retry) — voir §6.

**Verdict D1 : PASS** (convergence vers erreur terminale explicite, aucune divergence, aucun blocage).

## 4. Résultats D3 — suppression différée pendant le REC suivant

- **T2** répliqué vers C : B `done` puis D `done` (vérifié par SHA, cf. §5).
- Demandes de suppression du Take 2 émises par le Master **pendant le REC de T3** :
  B à `16:14:24`, D à `16:22:48` (`TRANSFER_DELETE`).
- **Fenêtre réelle du REC de T3 : `16:13:22.922` → STOP `16:29:49.9`** (`START_REQUEST` /
  `STOP_REQUEST` / `STOP_STATE`, horodatés A).
- **B** : `TRANSFER_LOCAL_DELETE_DEFER take=2 reason=recording` (observé en direct), puis
  `TRANSFER_LOCAL_DELETED take=2 files=1 removed=1` + `TRANSFER_LOCAL_DELETE_NATIVE files=1 removed=1`
  à `16:29:50.489` — soit **+15 min 26 s après la demande**, 0,6 s **après** le STOP de T3
  (différé jusqu'à la fin du REC, prouvé par horodatage précis).
- **D** : suppression honorée à `16:29:52.770` (ACK maître) — **2,9 s après** le STOP de T3,
  soit **~7 min après** sa demande de `16:22:48`, ce qui atteste la **différation** jusqu'à la fin du
  REC (le logcat de D a été perdu — cf. §6).
- **Aucun bug « files=0 »** : `files=1 removed=1` (suppression réellement effectuée).
- **Ordre HASH → DELETE** respecté (A/B) : `HASH` et `DELETE` Take 2 à `16:14:24.636`.
- **T3 non supprimé prématurément** : T3-B supprimé à `16:34:58`, T3-D à `16:57:03`, seulement
  **après** réplication totalement confirmée de T3.
- Présence physique : T2 supprimé sur B et D ; T3 conservé jusqu'à sa propre réplication.

**Verdict D3 : PASS** (suppression différée hors REC, cible correcte, pas de bug files=0, T3 préservé).

## 5. Intégrité (SHA-256 source vs destination C, transferts DONE)

| Take | Source | src SHA = dst SHA | src octets = dst octets | DONE A/C | Anti-collision | Verdict |
|------|--------|-------------------|-------------------------|----------|----------------|---------|
| T1 | B / D | non (panne D1) | non (partiel) | error/error | distincts | **FAIL (exclu — panne injectée)** |
| T2 | B | oui | oui (768 135 799) | done/done | distincts | **PASS** |
| T2 | D | oui | oui (1 301 903 249) | done/done | distincts | **PASS** |
| T3 | B | oui | oui (2 456 888 998) | done/done | distincts | **PASS** |
| T3 | D | oui | oui (3 361 543 395) | done/done | distincts | **PASS** |

- T1 = Take de la **panne injectée D1** : état terminal `error` (non-DONE) ⇒ **hors du critère
  d'intégrité** défini par la mission (« taille + SHA identiques **pour les transferts DONE** »).
  Résidus partiels laissés sur C (35 584 600 o et 114 392 o) — voir §6.
- T2 et T3 : SHA source = SHA destination **et** tailles identiques pour B **et** D ⇒ intégrité
  byte-exacte prouvée.
- T3-D : le SHA **source** a été reconstruit à partir du log applicatif `TRANSFER_HASH take=3`
  (`sourceSha256 == storageSha256 = 1a20f2823…`) — l'USB de D étant tombé pendant l'inventaire
  harnais. Recoupement : mesure indépendante du harnais sur C = `1a20f2823…`, tailles identiques,
  et garde-fou applicatif `sha256_mismatch` (transfer-model.js) qui n'aurait pas marqué `done` en cas
  d'écart.

**Verdict intégrité (transferts DONE) : PASS.**
`dumps/verdict.txt` (brut) = `FAIL` uniquement à cause de T1 (panne injectée).

## 6. Observations et limitations

1. **D1 = erreur terminale, pas de reprise** : sur une coupure ≥ quelques secondes, les tentatives
   bornées côté Storage s'épuisent (les échecs de connexion sont immédiats interface coupée). Le
   système converge proprement vers `error` au lieu de boucler : conforme à la mission, mais la
   **reprise** n'est pas exercée sur ce profil. À valider séparément si une reprise est souhaitée.
2. **Résidus partiels sur C après échec de T1** : les fichiers partiellement téléchargés
   (35,5 Mo / 114 Ko) ne sont pas nettoyés après erreur. Observation mineure (pas de données
   utilisateur en jeu).
3. **Instabilité du lien USB de D** : D a disparu du bus USB pendant la campagne (devenu joignable en
   TCP `192.168.92.103:5555`). Conséquence : logs finaux de D et inventaire source T3-D non capturés →
   SHA source T3-D reconstruit (§5). *Aucun impact* sur les verdicts (recoupement triple).
4. **`retry()` périodique proscrit** : un « nudge » `MultiCamTransferBootInstance.retry()` répété
   pendant un transfert en cours provoque des `download_http_404` côté source (le flux est offert avec
   un chemin que le serveur source ne sert plus). Le harnais final **n'utilise plus de nudge** ;
   preuve dans `/tmp/J14-C02-aborted-nudge-*`.
5. **Rotation logcat** : les compteurs de la section D3 de `j14c02-evidence.txt` (issus des logs
   *finaux*) sous-estiment certains événements (buffer 16 Mo saturé) ; les preuves de différé
   proviennent du monitor en direct (`J14-C02.log`) et des horodatages `TRANSFER_DELETE` /
   `TRANSFER_DELETE_ACK` maîtres.

## 7. Verdict global

| Critère | Verdict |
|---------|---------|
| D1 — convergence Master/Storage après coupure (erreur terminale explicite, sans divergence ni blocage) | **PASS** |
| D3 — suppression différée pendant REC, cible correcte, sans bug files=0, T3 préservé | **PASS** |
| Intégrité SHA/taille pour les transferts DONE (T2, T3) + ordre HASH→DELETE + suppression effective | **PASS** |
| T1 | non-DONE (panne injectée D1) — exclu du critère, documenté |

**VERDICT J14-C02 : PASS**
(avec les réserves documentées §6 : pas de reprise D1 sur coupure longue ; reconstruction du SHA
source T3-D suite à la perte USB de D.)

## 8. Preuves

- Log de campagne : `logs/campaign.log`
- Verdict intégrité : `dumps/verdict.txt` (brut) et synthèse corrigée `dumps/j14c02-evidence.txt`
- Convergence D1 : `dumps/convergence-T1.txt`, `dumps/tr-A-T1.json`, `dumps/tr-C-T1.json`
- D3 : `dumps/d3-defer-seen.txt`, `dumps/d3-gone.txt`, `dumps/transfer-progress.log`
- Présence physique : `dumps/presence-*.txt`
- Inventaires SHA : `dumps/local-sha-*.txt`, `dumps/sha-c0d8514d7d87.txt`, `dumps/media-c0d8514d7d87.txt`
- Extraits de logs par appareil (événements clés, hors `TRANSFER_PROGRESS`) :
  `logs/{61cc29567d91,61d54bba7d91,c0d8514d7d87}-key.log` ; fenêtre de coupure D1 : `logs/*-D1*.log`
- Logs bruts complets par appareil : `logs/*-final.log` (volumineux, conservés sur disque mais **non
  versionnés** — voir `logs/.gitignore`)
- Captures d'écran : `screenshots/`

Runs antérieurs non validants (pour traçabilité) : `/tmp/J14-C02-aborted-*` (bug join PIN),
`/tmp/J14-C02-aborted2-*` (bug `converged()` pipe-rc), `/tmp/J14-C02-run3-*` (attente transferts
manquante), `/tmp/J14-C02-aborted-nudge-*` (nudge → 404).
