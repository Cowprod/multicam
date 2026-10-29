# Parcours REC par les boutons — 29 octobre 2026

## Panne reproduite

Sur le Master 61cc29567d91, le clic sur « Continuer REC » fermait la confirmation puis échouait silencieusement. Log : `START_REJECTED sessionId=ZWASE4WD take=7 reason=local_stopped_take`, suivi de `SCREEN06_REC_KO origin=incident_continue`.

Le Take 7 était déjà arrêté. « Préparer le Take suivant » ouvrait l'écran de préparation sans créer de nouveau Take, et ARM restait proposé sur un Take terminé. Mes essais précédents appelaient le service START via ADB/CDP ; ils n'avaient pas qualifié ce parcours de boutons.

## Correction

- Le bouton suivant relit la session et crée une nouvelle préparation par l'API de production avant de naviguer. Une préparation déjà créée est réutilisée. Double clic neutralisé.
- ARM désactivé sur un Take qui n'est plus en préparation, avec une indication pour créer le suivant.
- « Continuer REC » attend la création du plan avant de fermer la confirmation. Un refus reste visible dans la fenêtre et sur ARM. Double START neutralisé.
- Une erreur de création du Take reste affichée, sans navigation trompeuse.

## Essai matériel

Master mis à jour avec remplacement signé, sans effacement des données. Les trois Captures et Samsung conservent leurs corrections natives précédentes.

Pendant la validation, les cinq tablettes avaient basculé sur le routeur 192.168.40.0/24. Les endpoints persistés du Master pointaient encore sur 192.168.92.57. Reconnexion opérationnelle effectuée vers le Master observé 192.168.40.136:45102, puis relance des quatre autres applications après contrôle natif d'absence de REC. Ceci ne constitue pas une correction générale de la migration automatique entre routeurs.

`ui-rec-validation.json` décrit le test : aucun appel direct à requestStart, requestStop ou newTake dans le pilote de validation. Navigation vers la préparation, clics DOM sur les boutons de production ARM, REC, Continuer REC, STOP, Confirmer STOP et Préparer le Take suivant. Les lectures de service servent uniquement aux assertions. La première création via « Nouveau Take » a également accepté le dialogue JS de confirmation ; l'essai final a réutilisé cette préparation 8.

Résultats :

- La confirmation d'incidents est bien ouverte avant Continuer REC.
- Take 8 en REC ; les trois Captures publient STARTED.
- Trois images décodées de 1339 × 752 dans la mosaïque du Master.
- STOP depuis l'interface : cinq états STOPPED, dont trois chemins MP4 natifs.
- `files.txt` confirme les trois MP4 publics non vides sur les tablettes.
- Le bouton suivant crée Take 9 / PREPARATION, ouvre « Take 009 » et laisse ARM disponible. Aucun REC laissé actif.
- 559 tests réussis, aucun échec, dont quatre nouveaux tests du parcours et une régression adaptée pour la création avant navigation.

Les captures `ui-rec-live.png` et `ui-rec-next.png` documentent l'interface physique du Master. Les avertissements d'espace libre SAF et d'horloge ne sont pas masqués par cette correction.
