# MultiCam UI 06 — ARM / Contrôle de préparation

## Statut

**VALIDÉ — 16 septembre 2026**

`index.html` est la référence visuelle de cet écran. Ce README est la référence fonctionnelle et technique pour les agents de codage.

## Objectif

L'écran ARM vérifie automatiquement l'état réel des devices sélectionnés pour le Take avant REC.

À l'entrée sur l'écran :

- l'ARM démarre automatiquement ;
- aucun bouton intermédiaire n'est requis ;
- seuls les devices sélectionnés dans l'écran 05 sont affichés ;
- leur ordre est conservé exactement comme dans l'écran 05 ;
- les réglages et sélections sont en lecture seule.

Pour modifier le Take, l'opérateur doit revenir à l'écran 05. Ce retour annule l'ARM en cours.

## Devices et skills

Un device n'est affiché qu'une seule fois, même s'il possède plusieurs rôles dans le Take.

Ordre fixe des skills affichées :

1. Capture ;
2. Storage.

Exemple d'un device Capture + Storage : une seule ligne avec deux icônes de skills côte à côte.

Il n'y a pas d'état global agrégé par device.

## Représentation des états

Les états sont portés directement par l'icône de la skill :

- Capture : `fa-video` ;
- Storage : `fa-hard-drive`.

Codage visuel :

- ARMING : spinner / état neutre ;
- READY : success ;
- WARNING : warning ;
- ERROR : danger.

Ne pas ajouter de texte `READY / WARNING / ERROR` à côté des icônes dans la vue principale.

Un clic sur l'icône de skill ouvre l'accordéon de détail correspondant.

Les accordéons ne s'ouvrent jamais automatiquement lorsqu'un incident apparaît : l'opérateur reste maître de l'ouverture.

## ARM Capture

Pour une Capture, les contrôles V1 affichés dans l'accordéon sont au minimum :

- caméra ;
- audio ;
- permissions ;
- stockage local ;
- réglages appliqués ;
- synchronisation.

Chaque contrôle est représenté par une icône colorée success / warning / danger.

Plusieurs incidents simultanés doivent être affichés séparément, une ligne par incident.

## Synchronisation

Le START synchronisé repose sur un instant absolu futur corrigé par l'offset d'horloge de chaque Capture.

Avant REC, le Master estime la qualité de synchronisation par échanges horodatés type NTP via WebSocket.

Objectifs V1 :

- mesurer RTT ;
- estimer l'offset d'horloge ;
- mesurer la stabilité / dispersion de cet offset ;
- viser une synchronisation pratique d'environ ±50 ms entre Captures.

La synchronisation apparaît uniquement dans le détail Capture afin de ne pas encombrer la vue principale.

Une qualité de synchronisation dégradée produit un WARNING ou un incident signalé, sans bloquer automatiquement REC.

## ARM Storage

Tout Storage sélectionné dans le Take apparaît sur cet écran, y compris si le device possède également le rôle Capture.

Pour un Storage, les contrôles V1 affichés dans l'accordéon sont au minimum :

- connexion ;
- espace libre ;
- accès au volume ;
- capacité à recevoir des transferts.

Un incident Storage n'empêche pas automatiquement REC, mais doit être clairement signalé.

## Seuil espace libre

Seuil warning V1 : **1 Go libre**.

Ce seuil s'applique :

- au stockage local des Captures ;
- aux Storage sélectionnés.

Sous 1 Go mais si le volume reste utilisable : WARNING non bloquant.

ERROR uniquement si le stockage est réellement inutilisable, quasi plein au point de ne plus pouvoir fonctionner correctement, non monté, en lecture seule ou autrement indisponible.

La durée finale du Take étant inconnue au moment de l'ARM, ne pas prétendre calculer une capacité suffisante pour toute la durée du Take.

## Timeout ARM

Lors de l'ARM, un device qui ne répond pas est attendu pendant **5 secondes**.

- aucun compteur visible dans l'UI ;
- à expiration, le device passe en incident / déconnecté ;
- s'il répond ensuite, son état est automatiquement remis à jour via WebSocket ;
- il peut redevenir READY avant REC.

Aucun bouton `Réessayer` n'est nécessaire : les devices publient leur état en temps réel et les Masters mettent l'UI à jour automatiquement.

## Règles REC

Le bouton principal est `REC` avec cercle rouge.

Il reste fixe en bas de l'écran pour rester accessible avec une longue liste de devices.

REC est désactivé tant qu'aucune Capture n'est dans un état démarrable.

États Capture démarrables :

- READY ;
- WARNING.

Une Capture en ERROR reste affichée mais ne bloque pas le REC global si au moins une autre Capture est READY ou WARNING.

Une erreur Storage est également non bloquante pour REC.

## Capture encore ARMING au REC

Une Capture encore en ARMING lorsque l'opérateur déclenche REC est considérée comme un incident particulier.

Comportement :

- elle peut encore rejoindre le Take si elle devient READY avant le top réel de départ ;
- si elle est encore ARMING au top, elle est écartée du REC ;
- avec countdown `0 s`, elle est donc écartée immédiatement.

Libellé fonctionnel recommandé :

`ARMING — doit être READY avant le top, sinon écarté du REC.`

## Capture déconnectée

Une Capture déconnectée pendant ARM :

- reste affichée ;
- passe en incident danger ;
- ne bloque pas REC si au moins une autre Capture reste démarrable.

Si elle se reconnecte et repasse READY avant le top, elle peut automatiquement réintégrer le REC.

## Confirmation des incidents avant REC

Si aucun incident n'est présent, REC part directement.

S'il existe au moins un incident sur un device sélectionné, afficher une modal de confirmation avant le countdown.

La modal affiche :

- le device concerné ;
- ses icônes de skills colorées ;
- le détail de l'incident accessible au clic sur l'icône ;
- bouton `Annuler` ;
- bouton `Continuer REC`.

Sont considérés comme incidents :

- WARNING ;
- ERROR ;
- ARMING ;
- déconnexion ;
- incident Storage sélectionné.

La modal est mise à jour en temps réel par WebSocket.

Si tous les incidents disparaissent pendant qu'elle est ouverte :

- fermer automatiquement la modal ;
- lancer REC immédiatement sans redemander de confirmation.

## Transition vers Countdown

Si countdown > 0 :

- REC mène à l'écran 07 Countdown.

Si countdown = 0 :

- ne pas afficher l'écran 07 ;
- passer directement à RECORDING / écran 08.

## Incident pendant le Countdown

Si une Capture qui était prête passe en ERROR ou se déconnecte avant le top :

- l'écarter du REC ;
- continuer le countdown avec les autres Captures ;
- envoyer aux Masters une alerte via WebSocket ;
- l'alerte est dismissable avec le mécanisme Bootstrap ;
- le dismiss est local à chaque Master, jamais global à la session.

Si la Capture revient et repasse READY avant le top, elle peut à nouveau réintégrer le REC.

## État en temps réel

L'écran ARM est piloté par WebSocket.

Événements à refléter immédiatement :

- changement ARMING / READY / WARNING / ERROR ;
- reconnexion / déconnexion ;
- évolution des incidents ;
- espace disque ;
- disponibilité caméra / micro ;
- permissions ;
- accès Storage ;
- état de synchronisation.

## Navigation

- retour → écran 05 ;
- le retour annule l'ARM ;
- REC + countdown > 0 → écran 07 ;
- REC + countdown = 0 → écran 08.

## UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- fond vidéo uniquement pour simuler la preview dans les maquettes ;
- bouton REC fixe en bas ;
- aucune explication pédagogique inutile dans la vue opérateur.

## Invariants pour l'agent de codage

- ARM démarre automatiquement à l'entrée sur l'écran.
- Écran 06 en lecture seule ; modifications uniquement via retour écran 05.
- Afficher uniquement les devices sélectionnés pour le Take.
- Conserver l'ordre des devices de l'écran 05.
- Un device multi-rôle n'apparaît qu'une fois.
- Ordre des skills : Capture puis Storage.
- État représenté par la couleur de l'icône de skill.
- Pas de texte READY/WARNING/ERROR dans la liste principale.
- Clic sur icône de skill = détail en accordéon.
- Une Capture WARNING est démarrable.
- Une Capture ERROR n'empêche pas les autres de démarrer.
- Un incident Storage est non bloquant pour REC.
- REC activable dès qu'au moins une Capture est READY ou WARNING.
- Tout incident sélectionné déclenche une confirmation avant REC.
- Timeout ARM sans réponse : 5 s.
- Seuil warning stockage : 1 Go.
- Pas de bouton Réessayer : état piloté par WebSocket.
- ARMING au top = Capture écartée du REC.
- Reconnexion avant top + READY = réintégration possible.
