# RAPPORT J12 — Historique et persistance complète

**Mise à jour documentaire : 2026-10-13 — audit GitHub indépendant ; J12 PASS.**

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

## 4. Campagnes de clôture

- `campagne-finale/` (`0718fb1`) : quatre sessions récentes, persistance A/B/C du sessionId/PIN/Masters et absence de doublon pour la session testée. L'essai initial ne prouvait pas les rôles (`members: []`).
- `validation-roles/` (`61b233e`) : B membre `capture`, C membre `storage`, via `MultiCamSessionWs.addMember`. Les six dumps natifs avant/après force-stop et redémarrage démontrent la conservation des membres et de leurs `sessionRoles` sur A/B/C. Capture `screen_a_b_disconnected.png` documentant B déconnecté sur A.
- Les Takes et leurs résumés STOP ont été contrôlés dans `diag4_1791879232/` et `diag5_1791881707/`. Ces campagnes distinctes ne doivent pas être présentées comme une capture/transfert réel J12.

## 5. Verdict

**J12 : PASS pour les critères obligatoires, sur les scénarios physiquement documentés.** Le reboot complet est facultatif et non réalisé. L'absence de doublons est attestée dans le scénario de reprise testé. Aucune nouvelle campagne J12 n'est nécessaire.

Voir `VALIDATION.md` pour la matrice détaillée. **J13 peut démarrer après décision du responsable projet.**
