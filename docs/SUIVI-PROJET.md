# MultiCam — Suivi du projet

Dernière mise à jour : 2026-10-22. Branche de travail : `feat/j11-media-transfer`.

## État validé

- J03–J14 : historique des campagnes et décisions à consulter dans `tests/e2e/validation/` ; ne pas déduire de ce résumé que tous les scénarios antérieurs sont clos.
- **J15 implémentation : terminé** — commit `0f58f8964a69c0a930b6b558d8611b4025382b16`, 471 tests PASS (41 J15), 0 FAIL. Rapport : `tests/e2e/validation/J15/RESULTS-J15-IMPLEMENTATION.md`.
- **J15 validation physique : PASS sur le périmètre testé** — commit `9d4d2886645e0a3021e70fa26ce49d501fc661bf`. Trois appareils Android réels : A Master, B Capture, C Storage ; 5 scénarios, 30 critères PASS / 0 FAIL / 0 BLOCKED, 7 Takes avec SHA-256 source/destination identiques. Rapport et preuves : `tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md`.
- **J16-A implémentation : terminé** — 500 tests PASS / 0 FAIL (471 antérieurs + 29 J16-A). Consultation des Takes passés (mode archivé de l'écran 09) depuis la session (03) et l'historique (15). Rapport : `docs/J16-A-RESULTS.md`.
- **J16-A validation physique : PASS (13/13)** — 3 appareils Android réels (A Master, B Capture, C Storage), session `PT63EPGF`, 3 Takes enregistrés puis consultés en archive ; faits d'arrêt et états de réplication persistés et relus ; consultation identique depuis l'écran 03 et l'écran 15 ; Take antérieur à J16-A affiché sans information inventée. Rapport et preuves : `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`.

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

### Arbitrage et lot A — J16-A implémenté (2026-10-21)

**Arbitrage : seul le lot A est autorisé.** Les lots B (diagnostic exportable), C
(GPS/GPX + orientation/wake-lock), D (SAF) et E (hygiène optionnelle) ne sont pas
commencés.

- **J16-A — consultation des Takes passés (mode archivé de l'écran 09)** :
  implémentation terminée, **500 tests PASS / 0 FAIL** (471 antérieurs + 29
  nouveaux dans `app/tests/j16-take-archive.test.js`). Rapport :
  `docs/J16-A-RESULTS.md`.
- Contraintes respectées : aucune modification du protocole de transfert, de la
  suppression des sources ni de la reprise J15 ; le mode **direct** de l'écran 09
  est inchangé (non-régression testée).
- Principe structurant : l'**état global** d'un transfert ne prouve jamais qu'une
  réplication Capture → Storage est terminée ; seul l'état du **couple** le
  permet. Un Take ancien affiche donc « indisponible », jamais « Terminé ».
- **Validation physique : PASS (13/13)** — campagne sur 3 appareils Android réels
  (`tests/e2e/j16a-campaign.sh`), session `PT63EPGF` : faits d'arrêt et états de
  réplication persistés puis relus dans l'archive, consultation identique depuis
  l'écran 03 et l'écran 15, lecture d'un Take antérieur à J16-A sans
  information inventée. Rapport :
  `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`.
- **Anomalie P0 hors périmètre** : l'écriture du manifeste de session n'est pas
  atomique (`session-store.js` : `truncate(0)` puis `write`) — un arrêt de
  l'application pendant l'écriture laisse un fichier de session **vide**
  (constaté le 2026-10-22 sur l'appareil A). Correctif à arbitrer dans un jalon
  dédié ; voir `docs/J16-A-RESULTS.md` §6.1.
- `docs/AVANCEMENT-V1.md` a été réconcilié (J12/J13/J14/J15 + ligne J16-A).

## Références

- `README.md` : présentation du dépôt.
- `docs/README.md` : entrée documentation technique.
- `docs/J16-A-RESULTS.md` : rapport d'implémentation J16-A (consultation des Takes passés).
- `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md` : protocole, verdicts et preuves physiques J16-A.
- `tests/e2e/validation/J15/RESULTS-J15-IMPLEMENTATION.md` : résultats automatisés.
- `tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md` : protocole, chronologies, limites et preuves physiques.
- `tests/e2e/j16a-campaign.sh` : reproduction de la campagne J16-A.
- `tests/e2e/j15-campaign.sh` : reproduction de la campagne J15.
