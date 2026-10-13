# RAPPORT J12 — Historique et persistance complète

**Mise à jour documentaire : 2026-10-13 — audit GitHub indépendant.**

## 1. Périmètre

Exigences de `docs/PLAN-DEVELOPPEMENT-V1.md` : quatre sessions récentes sur 01, historique 15, reprise du sessionId/PIN/membres/rôles, Takes sur 03, ancien Take sur 09, nouveau Take dans une session reprise ; force-stop/reprise, absence de doublons, membres absents affichés déconnectés, cohérence des Takes et preuves natives/visuelles.

## 2. Implémentation inspectée

- `app/www/js/ui/home.js` : quatre sessions récentes issues du store.
- `app/www/js/ui/history.js` : historique écran 15 et ouverture de session.
- `app/www/js/ui/session.js` : affichage membres, rôles, présence, Takes et préparation suivante.
- `app/www/js/ui/take-stopped.js` : consultation d'un Take archivé via le store.
- `app/www/js/state/session-store.js` : persistance par sessionId, tri des sessions récentes.
- `app/www/js/net/session-ws.js` : rechargement de session complète pour `newTake`/`upsertTake` ; rejet `session_not_found` si introuvable.
- `app/www/js/state/take-model.js` : le Take suivant n'hérite plus du résumé STOP.

Les composants de persistance STOP et transfert décrits dans les rapports initiaux restent présents ; leur validation physique complète ne doit pas être confondue avec les simulations archivées.

## 3. Évolution des campagnes

Le rapport initial signalait notamment un store absent sur B/C et une persistance STOP incomplète. Ces observations décrivent **une campagne ancienne** ; les preuves ultérieures de JOIN, redémarrage et diagnostics corrigent une partie de ces limitations.

- `bc_api_clean/` et `ui_join/` : synchronisation JOIN, sessionId persistant, y compris parcours UI sur B.
- `take_full/1791831904/` : STOP simulé et état TERMINATED avec summary sur A/B/C après restart ; simulation comportant des divergences de champs.
- `diag1_fix_1791872304/` : trois Masters sur A/B/C après restart.
- `diag2_fix_1791873392/` : PIN identique sur A/B/C.
- `diag3_README.txt` : divergence d'horodatage due à la simulation, non preuve d'un défaut réseau.
- `diag4_1791879232/` : Take 1 TERMINATED et Take 2 PREPARATION cohérents sur A/B/C.
- `diag5_1791881707/` : Take 1 conserve summary STOP ; Take 2 PREPARATION n'en hérite plus.
- `screenshots/` : captures des écrans historique, session, Take et reprise.

Les commits des diagnostics sont `8018396`, `227050e`, `0ea8644`, `669f6e0`, `7ee9323`, `526e17a`.

## 4. Réserves restantes

Le dernier scénario de capture/transfert réel J12 n'a pas démarré l'enregistrement : rôles Capture (B) et Storage (C) non configurés dans l'automatisation CDP. Aucun nouveau défaut applicatif n'a été établi par cette tentative. Les validations de transfert réel du jalon J11 ne doivent pas être présentées comme une validation J12 supplémentaire.

Les preuves restent insuffisantes pour conclure sur quatre sessions effectivement affichées sur 01, conservation de membres avec rôles après restart, absence explicite de doublons, et membre absent affiché déconnecté. Le reboot complet est facultatif. Une égalité des horodatages STOP sur un événement réellement coordonné n'est pas encore établie par la simulation.

## 5. Décision

**Statut J12 : PARTIAL.** Développement des fonctionnalités attendues identifié dans le code ; cinq diagnostics ciblés clôturés ; persistance et cohérence des Takes démontrées sur A/B/C pour les scénarios archivés. Quatre critères fonctionnels restent à confirmer par des preuves ciblées.

Voir `VALIDATION.md` pour la matrice détaillée. **Pas de passage à J13 sans décision explicite.**
