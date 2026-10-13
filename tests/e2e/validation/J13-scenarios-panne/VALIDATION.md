# J13 — Validation des scénarios de panne

Branche: feat/j11-media-transfer
Référence: f996c7a (campagne initiale) + campagne complémentaire
Conforme: docs/PLAN-DEVELOPPEMENT-V1.md (J13)

## Scénarios exécutés

01. Master perdu — PASS (complémentaire: REC actif démontré, disparition A pendant REC → B continue, reconnexion/convergence OK)
02. Capture perdue — PASS
03. Capture reconnectée — PASS
04. Storage perdu — PASS
05. Storage sans espace/erreur écriture simulée — PARTIAL (injection contrôlée/réversible chmod 500↔771 testée; efficacité chmod sur files internes documentée)
06. Wi-Fi coupé — PASS
07. App Capture tuée — PASS
08. App Storage tuée — PASS
09. Transfert interrompu — PARTIAL (transfert réel déclenché, interruption appliquée, état persistant, reprise testée; progression/SHA-256 documentés selon timing)
10. Redémarrage d'ancienne session — PASS (ouverte → reprise; fermée → closed wins)

## Compléments
- Flux REC corrigé (sélection captures/storages par Take, ARM, REC, STOP)
- Preuves complémentaires: scenario-01-cmp, scenario-05-cmp, scenario-09-cmp
- Preuves initiales préservées.

Statut global: PARTIEL (05,09 PARTIAL). Non déclaré PASS.
