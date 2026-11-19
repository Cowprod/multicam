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
2. [VALIDÉ] Master : supprimer le bloc « Storage distant ». Aucune distinction entre Storage Linux (ex. caseRouter) et Android : mêmes découverte, liste, sélection et suivi des transferts. [VALIDÉ] Les informations de périphérique doivent être portées par UN SEUL MODULE réutilisable : preview/vignette (y compris Storage) et popup, dans tous les contextes : accueil, session, préparation du Take, REC, etc. Le module affiche nom, skills, espace libre du volume de destination (pour Storage), disponibilité. Ne pas dupliquer les rendus ou la logique entre écrans.
3. [VALIDÉ] Volume Storage : l'espace libre annoncé doit impérativement être celui du volume qui contient le dossier de destination configuré (SSD USB sur Samsung actuellement), jamais celui du stockage interne lorsqu'un autre volume est sélectionné. [VALIDÉ] Si le système ne permet pas de mesurer la capacité du volume de destination (notamment via SAF), afficher « Espace disponible inconnu » et ne jamais substituer une valeur provenant d'un autre volume ; les transferts restent possibles. Méthode technique SAF à investiguer.
4. [PRIORITÉ CRITIQUE / VALIDÉ PARTIELLEMENT] Nommage SSD : utiliser le NOM HUMAIN de la session défini sur Master comme dossier, et non une date/ID technique imposé. Normaliser systématiquement les caractères spéciaux des noms de session, de Take et de Capture utilisés dans les chemins. L'utilisateur ne peut actuellement pas identifier facilement les fichiers reçus sur le SSD. [VALIDÉ] Les fichiers doivent porter les noms des Captures configurés dans MultiCam (et non `Cam_01` imposé, ni le nom Android du modèle). [OBSERVÉ / À INVESTIGUER] Les Xiaomi semblent toujours remonter le nom du modèle Android plutôt que leur nom personnalisé ; vérifier la source du nom affiché et la persistance des noms MultiCam. Règles précises de normalisation, collisions, noms de Take et fichiers multiples à préciser une par une. Attention : l'implémentation actuellement compilée utilise encore un identifiant de session, elle n'est donc PAS conforme.
5. Transferts : clarifier l'anomalie « Préparation », les appareils concernés et le comportement souhaité.
6. Lenteur : recueillir durée, taille, contexte réseau et débit constaté avant diagnostic.
7. Tests et déploiement : critères de validation, éviter des builds répétés.

## Historique des validations
- 19/11/2026 : document initial créé.
- 19/11/2026 : l'utilisateur choisit l'ouverture automatique des Takes ayant des transferts en cours.
- 19/11/2026 : une fois tous les fichiers arrivés, Take automatiquement fermé mais dépliable ; afficher `fa-check-circle text-success` à droite de sa ligne.

- 19/11/2026 : l'utilisateur valide Take ouvert en cas d'erreur, avec `fa-exclamation-circle text-danger` à droite, jusqu'à résolution.

- 19/11/2026 : l'utilisateur confirme qu'aucune distinction ne doit exister entre Storage Linux et Android côté Master.

- 19/11/2026 : l'utilisateur exige un module unique pour la preview et la popup d'un appareil, Storage compris, réutilisé sur tous les écrans (accueil, session, préparation, REC, etc.).

- 19/11/2026 : l'utilisateur confirme que l'espace libre doit correspondre au volume réel de destination, sinon l'indicateur est inutile.

- 19/11/2026 : l'utilisateur valide « Espace disponible inconnu » si le volume de destination ne permet pas de mesurer l'espace libre, sans bloquer les transferts.

- 19/11/2026 : priorité critique confirmée : répertoire SSD nommé d'après la session Master ; normaliser les caractères spéciaux pour les noms de session, Take et Capture. La version installée n'applique pas encore cette exigence.

- 19/11/2026 : l'utilisateur confirme que les vidéos doivent porter le nom des Captures dans MultiCam. Suspecte un bug Xiaomi : remontée du nom de modèle Android au lieu du nom personnalisé. À diagnostiquer, sans présumer de la cause.

- 19/11/2026 : [VALIDÉ — Q4A] Normalisation des noms de fichiers : retirer les accents, remplacer espaces et caractères interdits (`/`, `\\`, `:`, etc.) par `_`, conserver la casse. Exemple : `Caméra Église / Plan Général` → `Camera_Eglise_Plan_General.mp4`. Règles de collisions encore à définir.

- 19/11/2026 : [VALIDÉ — Q4B] En cas de noms de Capture identiques après normalisation, éviter tout écrasement en ajoutant un suffixe numérique seulement en cas de collision : `Camera_principale.mp4`, `Camera_principale_2.mp4`, etc. Modalités de stabilité des suffixes entre transferts/reprises à préciser techniquement.

- 19/11/2026 : [Q4C — À VÉRIFIER] L'utilisateur ignore si les Takes sont personnalisables et leur nom par défaut. Demande de reprendre sur le SSD exactement le nom affiché sur le Master (après normalisation). Vérifier dans le code les possibilités de renommage, valeur par défaut, persistance historique et collisions avant toute décision d'implémentation. Ne pas considérer le schéma `Take_001` comme validé.

- 19/11/2026 : [OBSERVÉ — Q5] Après STOP, la phase « Préparation » paraît déjà assez longue. Avant de discuter de correctif ou de régression d'état, analyser précisément ce que fait le système pendant cette phase (Capture, Master, Storage, opérations et durées). Aucune cause établie ; demander un diagnostic instrumenté, ne pas présumer qu'il s'agit seulement d'affichage.

- 19/11/2026 : [Q5/Q6 — OBSERVÉ] L'utilisateur ne peut pas distinguer si les Captures commencent les transferts à des moments différents : la préparation et les transferts sont tous deux très longs, et l'interface ne permet pas de suivre précisément la séquence. Ne pas lui demander d'estimer des timings à l'œil ; instrumenter les étapes et relever des horodatages et débits réels avant diagnostic.

- 19/11/2026 : [VALIDÉ — Q6 contexte] Lors des derniers tests, toutes les tablettes étaient sur le même réseau Wi-Fi ; le Samsung avec SSD USB était le Storage. Aucun débit mesuré ni diagnostic causal à ce stade.

- 19/11/2026 : [AUDIT STATIQUE Q5/Q6 TERMINÉ] Rapport : `docs/AUDIT-STOP-TRANSFERS-20261119.md`. Le badge « Préparation » ne mesure pas une étape technique unique ; plusieurs lectures/écritures complètes sont possibles (SHA source, staging conditionnel, export SAF concurrent, SHA destination). Aucune durée ni cause de lenteur établie sans instrumentation/essai physique. Aucun build ni correctif fonctionnel effectué.

- 19/11/2026 : [IMPLÉMENTÉ — Q1 / À TESTER] Première passe ciblée Storage : Takes avec transfert actif ou erreur ouverts par défaut, Takes complets fermés par défaut, icônes `fa-check-circle text-success` et `fa-exclamation-circle text-danger`, correction du bouton de dépliage pour tenir compte de l'état projeté. Fichiers : `app/www/js/ui/storage-view-model.js`, `app/www/js/ui/storage-view.js` ; test de projection ajouté dans `app/tests/j11-storage-view.test.js`. Commits `8ee9cf4`, `8559661`, `d3c1e49`, `e37a0a6`. **Tests non exécutés et aucun build/installation physique : pas de validation PASS.** À vérifier : transitions d'état après ouverture/fermeture manuelle, rendu réel Samsung et progression détaillée.

- 19/11/2026 : [VALIDÉ — RÈGLE DE LIVRAISON] « Une passe » signifie obligatoirement : implémentation complète d'un problème, exécution des tests automatisés, correction des échecs, compilation Android, livraison d'un build installable, puis ARRÊT dans l'attente de la validation physique explicite de l'utilisateur. Aucun problème suivant ne doit être commencé avant cette validation. Si une étape est impossible, déclarer la passe BLOQUÉE et sa raison précise, sans prétendre qu'elle est terminée. Toute remarque ultérieure doit être classifiée et enregistrée dans ce fichier.

- 19/11/2026 : [OBSERVÉ — RETOUR TERRAIN / NOUVELLE QUESTION FONCTIONNELLE] Sur Samsung SM-X110, écran d'accueil MultiCam avec rôle Storage actif, mDNS disponible, mais sans session/Take ouvert, aucun accès apparent à la gestion des médias du Storage. L'utilisateur demande comment gérer le contenu du Storage hors Take, notamment après enregistrement. [PROPOSITION — NON VALIDÉE] Rendre une vue « Stockage local » accessible hors session depuis l'accueil/menu, listant sessions/Takes, transferts, erreurs et fichiers reçus, sans dépendre d'un Take actif. [À DÉCIDER] Périmètre exact des opérations (consultation, reprise, suppression, etc.) et intégration à la passe en cours. Ne pas implémenter sans validation ; conserver la passe 1 ouverte.

- 19/11/2026 : [VALIDÉ — BESOIN FONCTIONNEL] Le Storage doit présenter en permanence, même sans session ni Take actif, un catalogue de son contenu en analysant le dossier de destination configuré (notamment arbre SAF/SSD), plutôt que dépendre uniquement de l'état en mémoire d'une session. [CONFIRMÉ — CONCEPTION EXISTANTE] `docs/schemas/recording-metadata-v1.schema.json` définit des métadonnées JSON portables pour le montage (sessionId, takeNumber, captures, media, SHA-256, horodatages, événements, incertitude d'horloge). [À VÉRIFIER — IMPLÉMENTATION] Vérifier si ces sidecars sont réellement écrits sur le volume Storage, leur emplacement et leur complétude ; la présence du schéma n'en est pas la preuve. [À CONCEVOIR] Scan/index local du dossier choisi, lecture métadonnées existantes et détection des fichiers orphelins/incomplets, sans inventer des Take ou déclarer complets des transferts non vérifiés. [À VALIDER] Actions exactes de gestion disponibles hors session.

- 19/11/2026 : [VALIDÉ — GESTION STORAGE HORS SESSION] L'utilisateur confirme que la page autonome de catalogue Storage doit aussi permettre la suppression de Takes complets, et pas seulement la consultation des fichiers et transferts. [À CONCEVOIR — SÉCURITÉ] Suppression explicitement confirmée, limitée au Take choisi dans le dossier configuré, sans affecter d'autres Takes ni supprimer de transfert actif ; règles de sécurité et interface à détailler avant implémentation.

- 19/11/2026 : [BLOQUANT — PRIORITÉ 1 / RETOUR UTILISATEUR] Les validations physiques du Storage sont impossibles tant que les contenus enregistrés ne sont pas accessibles hors session. L'utilisateur soupçonne que les fichiers JSON de montage ne sont pas générés et signale un défaut de suivi de conception. [AUDIT PARTIEL — CONFIRMÉ] Le schéma `docs/schemas/recording-metadata-v1.schema.json` existe ; `app/www/js/state/transfer-service.js` utilise des manifestes de transfert, mais ce n'est pas une preuve de sidecars de montage écrits sur le SSD. Le plugin `MultiCamSaf.java` contient des opérations d'écriture ; leur présence ne prouve pas la génération des JSON de montage. [NON VÉRIFIÉ] Présence effective de sidecars JSON sur le SSD et couverture de l'inventaire hors session. [DÉCISION] Prioriser l'audit des écritures et du scan du dossier Storage puis rendre le catalogue autonome accessible ; ne pas déclarer la passe 1 validée avant test physique. [À FAIRE] Inspecter code et SSD, implémenter, tests, build, installation, validation utilisateur.

- 19/11/2026 : [VALIDÉ — PRIORITÉ IMMÉDIATE / REMPLACE LE BLOCAGE STORAGE POUR CETTE PASSE] L'utilisateur est disponible pour validation physique et demande de se concentrer MAINTENANT sur UN composant réutilisable preview + popup + télémétrie par appareil, identique sur home, session, préparation Take, REC et post-REC, y compris appareils Storage. Exiger une télémétrie cohérente (source de vérité commune, identité/nom/roles, présence, statut REC/transfert, batterie, espace de destination Storage quand disponible, données absentes explicitement inconnues, pas de valeurs inventées). [À IMPLÉMENTER/TESTER] Auditer les rendus et flux actuels, unifier composant et projection, tester, compiler, installer sur tablettes, attendre validation explicite avant autre sujet. Le catalogue autonome Storage reste [BLOQUANT — REPORTÉ APRÈS CETTE PASSE] sans être abandonné.

- 19/11/2026 : [OBSERVATION / ORIENTATION ARCHITECTURE — À CONFIRMER] L'utilisateur propose que tous les appareils, y compris Storage, utilisent le même contrat de publication télémétrie + disponibilité preview, un Storage indiquant simplement absence d'image. Cela supprime la nécessité de traiter le Storage comme un cas particulier dans la vignette/popup. [PROPOSITION TECHNIQUE — NON ENCORE VALIDÉE] Enveloppe d'état commune avec `preview: null` pour Storage, images JPEG séparées ou événementielles pour ne pas renvoyer le binaire à chaque mesure ; une seule production d'image par Capture, distribution aux abonnés. Ne pas confondre absence de capacité vidéo et perte de preview d'une Capture.
