# J12 — Historique + persistance complète (validation)

## Objectifs
- STOP persistant (status TERMINATED + summary avec faits) sur document Take.
- Restauré après redémarrage/force-stop.
- Propagation/synchronisation entre Masters.

## Résultats
- [x] Persistance native prouvée sur A (après redémarrage/force-stop identique). Preuves: store/5GA375SF_*.json
- [~] Déclenchement automatique en STOP réel: partiel (chemin coordonné attendu; test synthétique isolé ne déclenche pas systématiquement - mécanisme renforcé mais à valider en campagne coordonnée)
- [ ] B/C: propagation/synchronisation validée nativement (non complété)
- [ ] Convergence (ancien état ne doit pas écraser état terminé) à vérifier
- [ ] Tous critères J12 démontrés sur 4 devices

Statut: PARTIAL

Preuves: store/, native/, RAPPORT-J12-CORRIGE.md
