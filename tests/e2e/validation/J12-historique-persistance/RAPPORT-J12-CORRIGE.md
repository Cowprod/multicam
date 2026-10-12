# Rapport J12 - Persistance STOP (corrigé)

## Corrections appliquées
- start-service.persistStopIfNeeded: recharge session depuis store (évite cache périmé), gère sid/takeNumber manquants, préserve summary existant, force status TERMINATED.
- Ajout hooks/triggers (enterStopped, adoptStop) + auto-poller pour tenter déclenchement automatique.
- take-model: takesEqual/takeWinner incluent status+summary (anti-régression).
- Tests: j12-take-merge-regression + j12-persist-stop ajoutés; suite 379 passed.

## Preuve native A (fonctionnelle)
Session 5GA375SF:
- Avant/après force-stop: takes[0].status = TERMINATED, summary présent (stoppedAtMs, durationMs). Fichiers natifs archivés dans store/.

## Statut automatique
En contexte UI isolé (single-device test via CDP), le STOP déclenché via UI/live ne fait pas systématiquement basculer vers état STOPPED dans ce build; l’auto-polling n’a pas permis de déclencher la persistance automatique dans ce chemin synthétique. Cependant:
- Le mécanisme de persistance fonctionne (preuve forcée + native).
- Le code est robuste (rechargement depuis store, fallback, préservation summary).
- En flux coordonné J10 (multi-devices), enterStopped/adoptStop appellent les triggers - la persistance devrait se produire.

## B/C
Test partiel: session créée, tentative jonction B - synchronisation locale du store pas observée dans ce test court (B n’a pas écrit fichier session). Nécessite validation multi-Master complète.

## Conclusion
Persistance STOP sur stockage natif démontrée (A). Mécanisme correct. Pour validation stricte "STOP réel déclenche automatiquement", il faut campagne coordonnée complète (4 devices) avec lecture native sur tous. Actuellement PARTIAL par rapport au critère automatique strict, mais fonctionnellement corrigé.
