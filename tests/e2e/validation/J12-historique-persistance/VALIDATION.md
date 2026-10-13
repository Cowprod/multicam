# J12 — Historique et persistance complète — état des validations

**Statut : PASS (audit indépendant, 2026-10-13).** Critères obligatoires J12 couverts par les campagnes archivées ; reboot complet facultatif non effectué. J13 peut être engagé sur décision du responsable projet.

Référence : `docs/PLAN-DEVELOPPEMENT-V1.md`, section J12. Branche : `feat/j11-media-transfer`.

## Matrice des critères

| Critère | État | Justificatif / limite |
| --- | --- | --- |
| Accueil 01 : quatre sessions récentes | PASS | `campagne-finale/captures/home_a.png`, `home_after_restart.png` et comptage de quatre cartes. |
| Historique écran 15 | PASS (parcours documenté) | `app/www/js/ui/history.js`; `screenshots/j12-history-A.png`, `screenshots/c-hist.png`. |
| Reprise du même sessionId et PIN | PASS sur A/B/C | `bc_api_clean/`, `ui_join/`, `diag2_fix_1791873392/` (PIN identique après restart). |
| Masters conservés | PASS sur A/B/C | `diag1_fix_1791872304/` : trois Masters sur chaque appareil après restart. |
| Membres et rôles Capture/Storage conservés | PASS sur A/B/C | `validation-roles/before_1791885921/` et `after_1791885971/` : B `sessionRoles: [capture]`, C `[storage]` sur les six dumps natifs. |
| Takes accessibles depuis écran 03 | PASS (parcours documenté) | `screenshots/j12-session-03-A.png`, `screenshots/j12-reprise-session-03.png`; code `session.js`. |
| Ancien Take ouvrable sur écran 09 | PASS (parcours documenté) | `screenshots/j12-take-09-A.png`; mode `archived` de `take-stopped.js`. |
| Nouveau Take dans une session reprise | PASS sur A/B/C (données natives) | `diag4_1791879232/`, `diag5_1791881707/` : Take 1 TERMINATED et Take 2 PREPARATION. |
| États des Takes cohérents après restart | PASS sur scénario A/B/C | `diag5_1791881707/` : Take 1 TERMINATED avec summary, Take 2 PREPARATION sans summary. |
| Force-stop / reprise sur au moins deux devices | PASS sur scénarios archivés | `take_full/1791831904/` (états STOP simulés), `diag1_fix_1791872304/`, `diag2_fix_1791873392/`; vérifier la portée de chaque simulation avant d'extrapoler. |
| Aucun doublon de session | PASS sur scénario testé | `campagne-finale/captures/home_after_restart.png` ; même sessionId avant/après. |
| Membres absents affichés déconnectés | PASS (preuve de campagne) | `validation-roles/screen_a_b_disconnected.png` ; B arrêté et rôle Capture conservé selon le protocole documenté. |
| Reboot complet d'un device | OPTIONNEL / non prouvé | Le plan demande « si possible ». |

## Diagnostics clos et corrections

1. **diag1** — Appel de `newTake({sessionId})` avec objet incomplet écrasait des champs sur A. `session-ws.js` recharge depuis le store et rejette avec `session_not_found` si absent. Commits `8018396`, `227050e`; preuves `diag1_fix_1791872304/`; test `app/tests/j12-diag1-nr.test.js`.
2. **diag2** — PIN régénéré sur A à la suite du même objet incomplet, non par synchronisation. Preuves de PIN commun A/B/C : `diag2_fix_1791873392/`, commit `0ea8644`.
3. **diag3** — `stoppedAtMs` divergent dans une simulation utilisant `Date.now()` séparément. Pas de défaut de propagation démontré ; l'égalité des horodatages lors d'un STOP réel coordonné reste à démontrer. `diag3_README.txt`, commit `669f6e0`.
4. **diag4** — Régression apparente du Take sur A liée à l'ancien appel incomplet. Scénario corrigé : Take 1 TERMINATED, Take 2 PREPARATION sur A/B/C. `diag4_1791879232/`, commit `7ee9323`.
5. **diag5** — `createNextTake` héritait du summary STOP. Suppression de cet héritage, test `app/tests/j12-diag5-nr.test.js`, preuves `diag5_1791881707/`, commit `526e17a`.

## Clôture et portée des preuves

La campagne `campagne-finale/` (commit `0718fb1`) valide quatre sessions récentes, la reprise A/B/C et l'absence de doublon dans le scénario exécuté. Son premier essai de rôles était insuffisant (`members: []`) : il ne doit pas être confondu avec la validation ultérieure.

La campagne `validation-roles/` (commit `61b233e`) attribue via l'API applicative B=`capture` et C=`storage`. Les six dumps natifs avant/après force-stop et redémarrage présentent le même sessionId, PIN, les trois Masters et les deux membres avec `sessionRoles` inchangés. Le protocole archive également la capture d'un B déconnecté sur A.

Les preuves des Takes TERMINATED et PREPARATION proviennent des diagnostics précédents (`diag4_1791879232/`, `diag5_1791881707/`) : la campagne de rôles n'a pas créé de Take et n'a pas relancé de transfert. Le transfert réel appartient aux preuves J11. Le reboot complet reste facultatif et non démontré. La vérification d'absence de doublon porte sur le scénario testé, pas sur une garantie universelle.

**Verdict : J12 PASS pour les critères obligatoires documentés.** Aucun nouveau test J12 n'est demandé ; passage à J13 autorisable par décision du responsable projet.
