# J13 — Validation des scénarios de panne

Branche: feat/j11-media-transfer
Référence: 88bdea6f715d909a4705478c3baefe2c58261cdf (sync avec origin)
Conforme: docs/PLAN-DEVELOPPEMENT-V1.md (J13)

## Scénarios exécutés

01. Master perdu — PASS
02. Capture perdue — PASS
03. Capture reconnectée — PASS
04. Storage perdu — PASS
05. Storage sans espace/erreur écriture simulée — PARTIAL (méthode injection contrôlée/réversible identifiée; transfert physique non déclenché faute REC)
06. Wi-Fi coupé — PASS
07. App Capture tuée — PASS
08. App Storage tuée — PASS
09. Transfert interrompu — PARTIAL (exigences complètes: transfert réel + progression + interruption + reprise effective + SHA-256 non démontrées faute déclenchement REC)
10. Redémarrage d'ancienne session — PASS (A: ouverte → reprise autorisée; B: fermée → closed wins)

## Mutualisation
02+03+07 partagent séquence; 04+08 partagent séquence. Preuves distinctes par scénario.

## Notes
- Pour 05/09, limitation matérielle (REC non démarrée dans campagne ciblée) justifie PARTIAL. Mécanismes code vérifiés.
- Aucune suppression de média non vérifié observée.
- Aucune duplication incohérente détectée.
- État compréhensible après pannes.

Statut global: PARTIEL (05,09 PARTIAL). Non déclaré PASS.
