# J13 — Validation des scénarios de panne

Branche: feat/j11-media-transfer
Commit: bbb0240
Référence: docs/PLAN-DEVELOPPEMENT-V1.md J13

Statut: CLÔTURÉ AVEC RÉSERVES
Décision: passage à J14 autorisé
Levée des réserves obligatoire avant production

## Scénarios

01. Master perdu — PASS
02. Capture perdue — PASS
03. Capture reconnectée — PASS
04. Storage perdu — PASS
05. Storage sans espace/erreur écriture simulée — PARTIAL (réserve 05: erreur d'écriture Storage non démontrée)
06. Wi-Fi coupé — PASS
07. App Capture tuée — PASS
08. App Storage tuée — PASS
09. Transfert interrompu — PARTIAL (réserve 09: interruption physique et reprise effective du transfert non démontrées)
10. Redémarrage d'ancienne session — PASS (ouverte → reprise autorisée; fermée → closed wins)

## Compléments / Notes
- Flux REC corrigé (sélection participants par Take, ARM, REC, STOP)
- Preuves initiales + complémentaires conservées (scenario-01-cmp, scenario-05-cmp/-final, scenario-09-cmp/-final)
- PARTIAL ne sont pas modifiés en PASS

Réserve 05: erreur d'écriture Storage non démontrée  
Réserve 09: interruption physique et reprise effective du transfert non démontrées
