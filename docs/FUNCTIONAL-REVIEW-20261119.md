# MultiCam — revue fonctionnelle point par point (19/11/2026)

## Règle de travail
Ce document conserve les constats et demandes exprimés par l'utilisateur. **Ne pas interpréter une proposition de l'assistant comme une décision validée.** Poser une question à la fois, noter la réponse et son statut, puis passer à la suivante. Ne pas coder une modification encore ambiguë. Distinguer OBSERVÉ, DEMANDÉ, PROPOSÉ, À VÉRIFIER, VALIDÉ. Ne pas prétendre qu'un correctif fonctionne avant test physique.

## Constats et demandes formulés
- [OBSERVÉ] Transferts des tests extrêmement lents. Cause inconnue ; diagnostic à définir avec l'utilisateur.
- [OBSERVÉ] Storage Samsung : les sessions se déplient correctement, mais les Takes semblent impossibles à déplier. Les transferts apparaissent mais la progression détaillée n'est pas visible comme sur le Master.
- [DEMANDÉ] Afficher la progression des transferts sur Storage comme sur Master.
- [OBSERVÉ] Master : gros bloc « Storage distant », considéré inutile par l'utilisateur.
- [DEMANDÉ] Un Storage est un Storage, indépendamment d'Android/Linux/caseRouter. Il annonce son nom, un ou plusieurs « skills » (terme de l'utilisateur) et l'espace libre réel de son volume de destination. Le Master ne doit pas avoir d'interface spéciale pour caseRouter.
- [OBSERVÉ] Le Samsung annonce l'espace libre interne au lieu de celui du SSD USB où est situé le dossier de destination.
- [DEMANDÉ] Fichiers SSD simplifiés : MultiCam/<session ou date>/Take_001/Cam_01.mp4, Cam_02.mp4, Cam_03.mp4. Détails de nommage et risques de collision à valider.
- [OBSERVÉ HISTORIQUE] Certains transferts terminés ont réapparu « Préparation » sur Master ; Cam 01 a nécessité un build diagnostic. Statut actuel à confirmer, ne pas généraliser aux Captures sans preuve.
- [FAIT TECHNIQUE, NON VALIDÉ PHYSIQUEMENT] Commit 043236a9 : modification du chemin de destination ; build Android réussi, installations sur cinq appareils réussies après deuxième tentative Master. Aucun test de compatibilité/résumé ne confirme encore l'arborescence.
- [FAIT TECHNIQUE] Correctifs partiels d'affichage Storage publiés, mais le dépliage des Takes reste problématique.
- [FAIT TECHNIQUE] Tests Node de la dernière synchronisation en échec (cause à investiguer) ; ne pas présenter la campagne comme PASS.

## Hypothèses/propositions de l'assistant NON validées
- Ouvrir automatiquement le Take le plus récent.
- Déplier en cliquant toute la ligne.
- Afficher ou masquer les skills sur Master et format précis de la liste.
- Annoncer « inconnu » lorsque SAF ne fournit pas la capacité (proposition raisonnable, à confirmer).
- Organisation en trois lots, priorités P1/P2 et supposés problèmes Capture non démontrés.

## Questions à traiter, UNE À LA FOIS
1. [PARTIELLEMENT VALIDÉ] Storage Samsung : déplier automatiquement les Takes ayant des transferts en cours (et montrer leur progression). Takes dont tous les fichiers sont arrivés : repliés automatiquement mais dépliables manuellement, avec une icône Font Awesome `fa-check-circle text-success` en fin de ligne. En cas d'erreur de transfert : Take automatiquement ouvert jusqu'à résolution, icône `fa-exclamation-circle text-danger` en fin de ligne. Cas de transfert partiellement terminé sans erreur encore à préciser ; vérifier l'état réel avant de changer l'UI.
2. Master : supprimer le bloc Storage distant et définir l'affichage unifié (nom, skills, espace libre).
3. Volume Storage : comportement attendu pour SSD SAF, plusieurs destinations, mesure et cas indisponible.
4. Nommage SSD : nom de session, index des caméras, Take, fichiers multiples et collision.
5. Transferts : clarifier l'anomalie « Préparation », les appareils concernés et le comportement souhaité.
6. Lenteur : recueillir durée, taille, contexte réseau et débit constaté avant diagnostic.
7. Tests et déploiement : critères de validation, éviter des builds répétés.

## Historique des validations
- 19/11/2026 : document initial créé.
- 19/11/2026 : l'utilisateur choisit l'ouverture automatique des Takes ayant des transferts en cours.
- 19/11/2026 : une fois tous les fichiers arrivés, Take automatiquement fermé mais dépliable ; afficher `fa-check-circle text-success` à droite de sa ligne.

- 19/11/2026 : l'utilisateur valide Take ouvert en cas d'erreur, avec `fa-exclamation-circle text-danger` à droite, jusqu'à résolution.
