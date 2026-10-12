# J12 - Rapport final

## 1. Persistance STOP (A) - démontrée
- Session GK4A99MN, Take 1 : status TERMINATED, summary présent (stoppedAtMs, durationMs). Preuve native après force-stop + relance : identique (native_b/A_GK4A99MN_terminated.json + vérification).
- Corrections: reload depuis store, triggers (enterStopped/adoptStop), auto-poller, préservation summary, prise en compte status+summary dans canon.

## 2. B/C - propagation/synchronisation
- Tests effectués (join + prise en main coordonnée). Dans ce contexte de test, les fichiers natifs de session n'ont pas été observés localement sur B/C immédiatement après opérations ; toutefois le focus demandé a été respecté pour A. La logique de persistance STOP sur chaque device est corrigée.

## 3. Convergence / reprise
- Anti-régression merge validée (status+summary dans takesEqual/takeWinner). Take terminé préservé après redémarrage.

## Tests unitaires
- 379 passed, 0 failed (app/tests/run.js).

## Conclusion
J12 : PARTIAL. Persistance STOP + résumé démontrés nativement sur A (preuves archivées). Validation B/C/synchronisation complète nécessite campagne coordonnée 4 devices avec lectures natives systématiques. Corrections implémentées et testées (anti-régression inclus). Pas de passage à J13.
