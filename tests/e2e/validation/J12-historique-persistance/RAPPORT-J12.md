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

## Campagne physique J12 (à compléter)
Dispositifs connectés : A=61cc29567d91, B=61d54bba7d91, C=c0d8514d7d87, D=R83Y106V1HF
Montage prévu : A/B/C au minimum (4ème tenté). APK = app/ (vérifié). Preuves à archiver : captures/, logs/, dumps/, screens/.

## Résultats campagne physique J12 (201140)
- APK : app/platforms/android/app/build/outputs/apk/debug/app-debug.apk (installé sur A,B,C,D)
- Session : DSHWRW2J "Hist J12-201140", PIN 4882, sid identique après reprise
- Membres : convergence B,C n'a pas transmis la session complète vers leurs stores via les dumps capturés (B-session-final=null, C-session-final=null) — points à corriger
- Take #1 : présent après reprise, statut PREPARATION, summary absent (STOP a eu lieu mais persistance STOP+summary non constatée dans dumps archivés)
- Navigation : 15→03→09, reprise, nouveau Take (screenshots disponibles)
- Preuves : dumps (A complet, B/C partiels), logs (3 devices), screenshots (8)

## Critères d’acceptation (statut partiel)
- Écran 15 OK (navigation prouvée). 
- Écran 03 avec Takes + Prochain Take OK. 
- Reprise même sid/PIN OK (A). 
- B/C n’ont pas rechargé l’état complet en dumps (store null) — non conforme aux attentes « reprise même sessionId/PIN/membres/rôles » sur tous les Masters. 
- Faits STOP + résumé transferts : code en place, mais Take archivé n’affiche pas summary dans dumps (A après reprise/final) — à approfondir.
- Convergence anti-régression : tests unitaires OK (j12 merge), mais synchronisation physique entre Masters partielle.

STATUT : PARTIAL — preuves manquantes pour B/C (état persistant chargé après reprise) et validation complète des faits STOP+summary.
