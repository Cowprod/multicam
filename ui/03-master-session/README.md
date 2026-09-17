# MultiCam UI 03 — Session / Vue Master

## Statut

**VALIDÉ — mis à jour le 17 septembre 2026**

`index.html` est la référence visuelle de cet écran. Ce README est la référence fonctionnelle et technique pour les agents de codage.

## Objectif

Écran principal d'une session lorsqu'un device agit comme Master/Controller.

Il sert à :

- voir l'état général de la session ;
- connaître le PIN Master ;
- voir les devices déjà membres de la session ;
- voir les devices disponibles sur le LAN ;
- ajouter un device à la session ;
- définir ou modifier les rôles de session d'un device ;
- consulter les Takes précédents ;
- accéder à un Take passé ;
- préparer le prochain Take.

## Hiérarchie fonctionnelle

- **Session** : conteneur global ;
- **Take** : cycle de captation ;
- **REC** : état temporaire d'un Take ;
- **Clips** : fichiers produits par les devices de Capture.

Cette explication appartient à la documentation et ne doit pas être affichée comme texte pédagogique dans l'interface opérateur.

## Header

Le header affiche :

- retour accueil via l'icône maison ;
- libellé `Session` ;
- nom de la session ;
- menu secondaire.

Sous le header, une barre fine de contexte regroupe :

- état de la session, ex. `OUVERTE` ;
- PIN Master V1, ex. `PIN 4281`.

### PIN Master

En V1, le PIN est affiché en permanence dans la vue Master. Il est persistant pour une session et reste identique lorsqu'une ancienne session est reprise.

Le PIN autorise un autre Controller à rejoindre la session comme Master via l'écran 02.

## Reprise d'une ancienne session

Une session ouverte depuis l'historique ou depuis les sessions récentes recharge sa configuration persistée :

- même `sessionId` ;
- même nom ;
- même PIN Master ;
- mêmes devices membres ;
- mêmes rôles de session.

La présence réseau est ensuite réévaluée en temps réel. Un ancien device actuellement absent reste membre de la session mais apparaît `Déconnecté`. Il n'est pas supprimé automatiquement de la configuration.

## Prochain Take

La card `Prochain Take` affiche au minimum :

- numéro du prochain Take ;
- état de préparation ;
- état REC courant ;
- action `Préparer Take XXX`.

Le numéro est la suite des Takes existants de la session. L'action mène à l'écran 05.

## Takes précédents

La Session contient la liste de ses Takes, du plus récent au plus ancien.

Chaque ligne affiche au minimum :

- numéro du Take ;
- état utile à l'opérateur ;
- éventuellement heure ou information courte d'activité ;
- chevron indiquant l'accès au détail.

États représentatifs :

- terminé ;
- transfert en cours ;
- erreur de réplication.

Un Take reste accessible même après sa fin, pendant un transfert ou en cas d'erreur.

Un appui sur un Take ouvre l'écran 09 correspondant. L'écran 15 Historique ne duplique pas cette liste : il ouvre d'abord la Session 03.

## Devices dans la session

Chaque device membre affiche au minimum :

- nom ;
- état de connexion ;
- batterie si disponible ;
- espace libre si pertinent ;
- rôles actifs dans cette session ;
- action d'édition.

Les rôles affichés sont des `sessionRoles`, pas les `enabledSkills` globales.

## Devices disponibles sur le LAN

Cette section présente les devices détectés qui ne sont pas encore membres de la session.

Pour chaque device :

- nom ;
- skills activées/annoncées disponibles ;
- bouton `Ajouter`.

La découverte réseau repose sur le `deviceId`, jamais sur l'adresse IP.

## Ajout / modification d'un device

`Ajouter` ou le crayon ouvre une modal.

La modal ne propose que les rôles correspondant aux skills :

- supportées par l'implémentation ;
- activées localement ;
- annoncées au Master.

Au moins un rôle doit être conservé/sélectionné.

Le Master ne doit jamais attribuer un rôle non annoncé par le device.

Les modifications sont synchronisées vers les autres Masters connectés.

## Retrait d'un device

La maquette prévoit une action de retrait. Le Master courant ne doit pas se retirer lui-même si cela rend l'état incohérent.

Le comportement pendant un Take actif suit les règles du cycle Take et ne doit pas être inventé à partir de cet écran.

## Mise à jour temps réel

L'écran reçoit notamment :

- arrivée/disparition de devices LAN ;
- connexion/déconnexion ;
- télémétrie ;
- changement de rôles ;
- ajout/retrait ;
- changement d'état de session ;
- changement d'état des Takes et transferts.

Les Masters connectés doivent converger vers le même état.

## Navigation

- maison → accueil 01 ;
- `Préparer Take` → écran 05 ;
- Take précédent → écran 09 ;
- ajout/édition device → modal locale.

## UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- fond vidéo dans la maquette pour simuler la preview ;
- conserver une interface opérateur concise.

## Invariants pour l'agent de codage

- `enabledSkills` et `sessionRoles` sont distincts ;
- un device ne reçoit qu'un rôle correspondant à une skill activée/annoncée ;
- l'ajout d'un device est initié par un Master ;
- le PIN Master reste visible et persistant pour la session ;
- un device absent lors d'une reprise reste membre mais déconnecté ;
- les Takes historiques restent accessibles depuis la Session ;
- le choix des participants au prochain Take se fait dans l'écran 05.
