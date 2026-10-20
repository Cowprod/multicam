# MultiCam — Suivi du projet

Dernière mise à jour : 2026-10-20. Branche de travail : `feat/j11-media-transfer`.

## État validé

- J03–J14 : historique des campagnes et décisions à consulter dans `tests/e2e/validation/` ; ne pas déduire de ce résumé que tous les scénarios antérieurs sont clos.
- **J15 implémentation : terminé** — commit `0f58f8964a69c0a930b6b558d8611b4025382b16`, 471 tests PASS (41 J15), 0 FAIL. Rapport : `tests/e2e/validation/J15/RESULTS-J15-IMPLEMENTATION.md`.
- **J15 validation physique : PASS sur le périmètre testé** — commit `9d4d2886645e0a3021e70fa26ce49d501fc661bf`. Trois appareils Android réels : A Master, B Capture, C Storage ; 5 scénarios, 30 critères PASS / 0 FAIL / 0 BLOCKED, 7 Takes avec SHA-256 source/destination identiques. Rapport et preuves : `tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md`.

### Capacités démontrées en J15

1. Transfert nominal B → C et convergence des états Master/Storage.
2. Passage en attente lors d'une coupure Wi-Fi, puis reprise automatique au retour réseau.
3. Persistance du journal et reprise après redémarrage de l'application Storage, avec reconnexion à la session.
4. Deux Takes successifs, le second pouvant être enregistré pendant l'attente réseau du premier.
5. Suppression du fichier source uniquement après réplication vérifiée.

Ces capacités sont **validées dans les conditions de la campagne**, et non pour toutes les topologies ou tous les types de stockage.

## Réserves et points de suivi

| Sujet | Constat | Statut |
|---|---|---|
| Restauration Storage hors ligne | Après redémarrage sans Wi-Fi, vue de transfert vide (`P03-C-after-restart.json` = `null`). Journal conservé et réappliqué après reconnexion WS ; transfert finalement terminé. | Amélioration non bloquante |
| Synchronisation horloges / ARM | Avertissement `capture WARNING check=sync`, décalage ~280 ms, dispersion ~50 ms ; modal incident confirmé avant REC. | UX / diagnostic à traiter ultérieurement |
| ARM Storage hors ligne | Pendant P04, `storage=ERROR` mais `recEligible=true` ; REC autorisée après confirmation de l'incident. | Comportement à clarifier fonctionnellement |
| Journal | ~420 `TRANSFER_JOURNAL_WRITE` pendant la campagne ; optimisation possible sans urgence. | Optimisation |
| Stockage SAF | Non qualifié par la campagne J15 (stockage interne seulement). | Non validé |
| Multi-Storage / file pleine | Non exercé physiquement en J15. | Non validé |
| Capture hors ligne | Coupures J15 provoquées sur C (Storage), pas sur B. | Non validé |
| Ordonnancement des sauvegardes | Tests de régression présents pour coalescence et écritures immédiates, mais tous les entrelacements asynchrones ne sont pas démontrés. | Risque résiduel à surveiller |

## Orientation J16 — Fonctionnel prioritaire

**Décision utilisateur : privilégier les fonctionnalités métier et l'ergonomie plutôt qu'une nouvelle campagne technique générale.**

J16 n'est **pas encore spécifié ni autorisé pour implémentation**. Avant de coder :

1. Faire l'inventaire des fonctionnalités déjà implémentées, des maquettes validées (`ui/`) et des besoins restants dans `docs/` et les rapports.
2. Proposer un petit nombre de lots fonctionnels cohérents, avec bénéfice utilisateur, dépendances et critères d'acceptation observables.
3. Faire arbitrer le périmètre J16 par le responsable du projet : ne pas choisir une fonctionnalité à sa place.
4. Préserver les acquis J15 ; éviter les refontes du transfert hors anomalie reproductible.

### Inventaire et proposition J16 (2026-10-20)

- `docs/INVENTAIRE-FONCTIONNEL-J16.md` — inventaire fonctionnel complet (specs `ui/` vs code `app/www/`), classification, écarts. Constat principal : le socle J03→J15 est implémenté ; le seul manque **utilisateur** visible est la consultation des Takes passés (écran 09 archivé / historique 15).
- `docs/PROPOSITION-PERIMETRE-J16.md` — **proposition non validée** de lots fonctionnels (A : Takes passés ; B : diagnostic exportable ; C : GPS/GPX + orientation/wake-lock ; D : SAF ; E : hygiène optionnelle), en attente d'arbitrage.
- Écart documentaire relevé : `docs/AVANCEMENT-V1.md` indique encore J12/J13/J14 « en attente » alors que J12 est PASS, J13 clôturé avec réserves et J14 l'est en PARTIAL (voir `docs/INVENTAIRE-FONCTIONNEL-J16.md` §4.2 et §6). Réconciliation proposée, non appliquée à ce stade.

## Références

- `README.md` : présentation du dépôt.
- `docs/README.md` : entrée documentation technique.
- `tests/e2e/validation/J15/RESULTS-J15-IMPLEMENTATION.md` : résultats automatisés.
- `tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md` : protocole, chronologies, limites et preuves physiques.
- `tests/e2e/j15-campaign.sh` : reproduction de la campagne.
