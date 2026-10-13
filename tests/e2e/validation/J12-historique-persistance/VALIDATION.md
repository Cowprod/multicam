# J12 — Historique et persistance complète — état des validations

**Statut : PARTIAL (audit documentaire indépendant, 2026-10-13).** Ce document consolide les preuves existantes sans prétendre qu'une nouvelle campagne physique a été exécutée. J13 non autorisé.

Référence : `docs/PLAN-DEVELOPPEMENT-V1.md`, section J12. Branche : `feat/j11-media-transfer`.

## Matrice des critères

| Critère | État | Justificatif / limite |
| --- | --- | --- |
| Accueil 01 : quatre sessions récentes | PARTIAL | `app/www/js/ui/home.js` limite à quatre les résultats de `session-store.list()`; démonstration physique avec quatre sessions non retrouvée. |
| Historique écran 15 | PASS (parcours documenté) | `app/www/js/ui/history.js`; `screenshots/j12-history-A.png`, `screenshots/c-hist.png`. |
| Reprise du même sessionId et PIN | PASS sur A/B/C | `bc_api_clean/`, `ui_join/`, `diag2_fix_1791873392/` (PIN identique après restart). |
| Masters conservés | PASS sur A/B/C | `diag1_fix_1791872304/` : trois Masters sur chaque appareil après restart. |
| Membres et rôles Capture/Storage conservés | PARTIAL | Gestion implémentée dans `app/www/js/ui/session.js`, mais dumps récents avec `members: []` : aucune démonstration de reprise avec rôles attribués. |
| Takes accessibles depuis écran 03 | PASS (parcours documenté) | `screenshots/j12-session-03-A.png`, `screenshots/j12-reprise-session-03.png`; code `session.js`. |
| Ancien Take ouvrable sur écran 09 | PASS (parcours documenté) | `screenshots/j12-take-09-A.png`; mode `archived` de `take-stopped.js`. |
| Nouveau Take dans une session reprise | PASS sur A/B/C (données natives) | `diag4_1791879232/`, `diag5_1791881707/` : Take 1 TERMINATED et Take 2 PREPARATION. |
| États des Takes cohérents après restart | PASS sur scénario A/B/C | `diag5_1791881707/` : Take 1 TERMINATED avec summary, Take 2 PREPARATION sans summary. |
| Force-stop / reprise sur au moins deux devices | PASS sur scénarios archivés | `take_full/1791831904/` (états STOP simulés), `diag1_fix_1791872304/`, `diag2_fix_1791873392/`; vérifier la portée de chaque simulation avant d'extrapoler. |
| Aucun doublon de session | PARTIAL | Store indexé par sessionId, mais preuve physique explicite d'absence de doublon à documenter. |
| Membres absents affichés déconnectés | PARTIAL | Affichage prévu dans `session.js`, mais preuve visuelle ciblée après déconnexion absente. |
| Reboot complet d'un device | OPTIONNEL / non prouvé | Le plan demande « si possible ». |

## Diagnostics clos et corrections

1. **diag1** — Appel de `newTake({sessionId})` avec objet incomplet écrasait des champs sur A. `session-ws.js` recharge depuis le store et rejette avec `session_not_found` si absent. Commits `8018396`, `227050e`; preuves `diag1_fix_1791872304/`; test `app/tests/j12-diag1-nr.test.js`.
2. **diag2** — PIN régénéré sur A à la suite du même objet incomplet, non par synchronisation. Preuves de PIN commun A/B/C : `diag2_fix_1791873392/`, commit `0ea8644`.
3. **diag3** — `stoppedAtMs` divergent dans une simulation utilisant `Date.now()` séparément. Pas de défaut de propagation démontré ; l'égalité des horodatages lors d'un STOP réel coordonné reste à démontrer. `diag3_README.txt`, commit `669f6e0`.
4. **diag4** — Régression apparente du Take sur A liée à l'ancien appel incomplet. Scénario corrigé : Take 1 TERMINATED, Take 2 PREPARATION sur A/B/C. `diag4_1791879232/`, commit `7ee9323`.
5. **diag5** — `createNextTake` héritait du summary STOP. Suppression de cet héritage, test `app/tests/j12-diag5-nr.test.js`, preuves `diag5_1791881707/`, commit `526e17a`.

## Limites et décision

Les dumps des scénarios récents attestent la persistance de documents cohérents, mais les Takes utilisés n'ont pas de Capture/Storage affectés et ne démontrent pas un transfert réel. La capture et le transfert réels ont été validés au jalon J11 ; la tentative de revalidation J12 n'a pas abouti faute de configuration des rôles dans le scénario CDP. Ne pas présenter cette tentative comme un PASS.

Les rapports historiques `RAPPORT-J12-FINAL.md`, `RAPPORT-J12-CORRIGE.md` et `VALIDATION-J12-PARTIAL.md` sont conservés comme états intermédiaires et ne remplacent pas la présente synthèse.

**À confirmer avant PASS J12 :** quatre sessions sur 01 ; conservation de membres et rôles après reprise ; absence de doublons ; affichage déconnecté d'un membre absent. Réutiliser les preuves existantes, sans relancer par défaut une campagne complète J11.

**Attention preuves :** certains JSON contiennent des PIN en clair ; masquer ces valeurs dans les futurs exports destinés à être diffusés.
