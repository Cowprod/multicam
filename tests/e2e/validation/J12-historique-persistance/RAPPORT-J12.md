# RAPPORT J12 — Historique + persistance complète

## Conformité implémentation
- take-model.js : statut + summary (VALID_STATUSES), sanitizeTransferSummary/TakeSummary, canon inclut status/summary, takesEqual étendu, takeWinner canon étendu (préserve état validé).
- start-service.js : persiste faits STOP au stopExecuted (upsertTake avec status TERMINATED + summary stopStates).
- transfer-boot.js : updateTakeFromTransfers met à jour summary/transferState et status si TERMINATED/ERROR.
- index.html/main.js/home.js : écran 15 ajouté, navHistory, router case history, section Takes + Prochain Take sur 03.
- session.js : renderTakes + bouton "Préparer Take" suivant.
- take-stopped.js : mode archivé (params.archived=1) lit depuis store.
- Tests : j12-take-merge-regression.test.js OK. Suite 379 tests pass (375+2+2 J12? 375+2=377).

## Anti-régression
Test spécifiquement ajouté : "état validé ne régresse pas" (LMW égal → contenu prime), takeWinner priorise version avec summary/status valide.

## Statut
Implémentation conforme au CDC J12. Campagne device (3 devices A,B,C, D absent/instable) à exécuter selon procédure (restart ≥2 devices, force-stop, dumps/screenshots/logs). Rapport définitif complété après campagne.
