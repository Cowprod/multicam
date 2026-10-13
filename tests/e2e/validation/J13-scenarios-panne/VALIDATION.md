# J13 — Validation des scénarios de panne (final)

Branche: feat/j11-media-transfer
Commit: 82a5c1f
Référence: docs/PLAN-DEVELOPPEMENT-V1.md J13

## Scénarios

01-04,06-08,10: PASS (preuves complètes conservées)
05: PARTIAL - injection contrôlée/réversible tentée (chmod 500↔771). Efficacité non démontrée sans risque sur fichiers internes; chemins natifs identifiés (MultiCamTransfer/Saf). Erreur-paths présents dans code.
09: PARTIAL - procédures tentées; transfert non déclenché dans fenêtre test malgré REC+STOP long. J11 valide déjà transfert physique, progression, reprise HTTP Range/offset, SHA-256, intégrité.

## Compléments
- scenario-01-cmp, scenario-05-cmp, scenario-09-cmp, scenario-05-final, scenario-09-final ajoutés sans écrasement preuves initiales.
- Flux REC corrigé (sélection participants par Take, ARM, REC, STOP).

Statut: PARTIEL (05,09). Non déclaré PASS.
