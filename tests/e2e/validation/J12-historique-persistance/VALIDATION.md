# J12 — Historique + persistance complète (validation)

## Statut : PARTIAL

Critères validés :
- [x] Persistance native STOP sur A : status TERMINATED + summary complet (stoppedAtMs, durationMs). Preuves : native_b/A_GK4A99MN_terminated.json, vérification après force-stop/redémarrage (identique).
- [x] Mécanisme de persistance renforcé (rechargement depuis store, triggers, auto-poller). 
- [x] Anti-régression merge (status+summary dans canon) - tests passants.
- [x] Tests unitaires : 379 passed, 0 failed.

Critères non validés (à compléter) :
- [ ] Propagation/persistance B/C natives complètes (lectures natives sur tous les devices après STOP coordonné)
- [ ] Convergence après déconnexion/reconnexion (reprise sans régression) sur tous les devices
- [ ] Reprise session + ajout nouveau Take (preuves complètes 4 devices)

Preuves archivées : store/, native/, native_b/, RAPPORT-J12-FINAL.md, VALIDATION.md
