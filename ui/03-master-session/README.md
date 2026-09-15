# MultiCam UI 03 — Session / Vue Master

## Statut

**VALIDÉ — 15 septembre 2026**

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
- accéder à la préparation du prochain Take.

## Hiérarchie fonctionnelle

Ne pas confondre :

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

Sous le header, une barre fine de contexte regroupe les badges de session :

- état de la session, ex. `OUVERTE` ;
- PIN Master V1, ex. `PIN 4281`.

Cette barre évite de laisser les badges flotter visuellement dans le header.

### PIN Master

En V1, le PIN est affiché en permanence dans la vue Master afin qu'il reste récupérable même si le Master créateur rencontre un problème.

Le PIN sert à autoriser un autre Controller à rejoindre la session comme Master via l'écran 02.

## Prochain Take

La card `Prochain Take` affiche au minimum :

- numéro technique du prochain Take ;
- état de préparation ;
- état REC courant ;
- action `Préparer Take XXX`.

L'action mène à l'écran 05.

## Devices dans la session

Chaque device membre de la session affiche au minimum :

- nom ;
- état de connexion ;
- batterie si disponible ;
- espace libre si pertinent ;
- rôles actifs dans cette session ;
- action d'édition.

Les rôles affichés sont des `sessionRoles`, et non les `enabledSkills` globales du device.

## Devices disponibles sur le LAN

Cette section présente les devices détectés qui ne sont pas encore membres de la session.

Pour chaque device :

- nom ;
- skills activées/annoncées disponibles pour cette session ;
- bouton `Ajouter`.

La découverte réseau reste basée sur l'identité persistante `deviceId`, jamais sur l'adresse IP.

## Ajout d'un device

Cliquer sur `Ajouter` ouvre une modal.

La modal doit proposer uniquement les rôles correspondant aux skills :

- supportées par cette implémentation ;
- activées localement sur le device ;
- annoncées au Master.

Exemples :

- `capture,storage` → choix Capture + Storage ;
- `storage` → choix Storage uniquement ;
- `controller,capture` → choix Master/Controller + Capture.

Au moins un rôle doit être sélectionné pour ajouter le device.

### Règle importante

Le Master ne doit jamais pouvoir attribuer un rôle que le device n'a pas annoncé comme disponible.

## Modification des rôles

L'icône crayon sur un device déjà membre ouvre la même logique d'édition.

- rôles actuels pré-cochés ;
- au moins un rôle conservé ;
- sauvegarde immédiate de la configuration de session ;
- l'UI doit être synchronisée vers les autres Masters connectés.

Le rôle de participation au prochain Take est une notion distincte : il sera géré dans l'écran 05.

## Retrait d'un device

La maquette prévoit une action de retrait pour les devices de session.

Le Master courant ne doit pas se retirer lui-même par cette action si cela rendrait l'état de session incohérent.

Le comportement définitif de retrait pendant un Take actif doit suivre les règles du cycle Take et ne doit pas être inventé à partir de cette maquette.

## Données minimales

Exemple conceptuel :

```json
{
  "sessionId": "uuid-session",
  "name": "Interview Studio A",
  "status": "open",
  "masterPin": "4281",
  "devices": [
    {
      "deviceId": "uuid-cam07",
      "name": "Cam 07",
      "enabledSkills": ["controller", "capture", "storage"],
      "sessionRoles": ["controller", "capture"],
      "connected": true,
      "batteryPercent": 100,
      "freeStorageBytes": 40802189312
    }
  ]
}
```

Le PIN réel doit venir de l'état de session et non être codé en dur.

## Mise à jour temps réel

L'écran Master doit être alimenté par les événements LAN de la session :

- arrivée/disparition d'un device disponible ;
- connexion/déconnexion ;
- mise à jour de télémétrie ;
- modification de rôles ;
- ajout/retrait d'un device ;
- changement d'état de session ;
- changement d'état du prochain Take.

Les Masters connectés doivent converger vers le même état de session.

## Navigation

- maison → accueil 01 ;
- `Préparer Take` → écran 05 ;
- ajout/édition device → modal locale ;
- menu secondaire : réservé aux fonctions de session qui seront définies plus tard.

## UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- fond vidéo uniquement pour simuler la preview dans les maquettes ;
- limiter les explications visibles à ce qui aide réellement l'opérateur.

## Invariants pour l'agent de codage

- `enabledSkills` et `sessionRoles` sont distincts.
- Un device ne peut recevoir qu'un rôle correspondant à une skill annoncée comme activée.
- L'ajout d'un device est initié par le Master.
- Le PIN Master V1 reste visible dans la vue Master.
- Le choix des participants au prochain Take ne se fait pas ici : il se fait dans l'écran 05.
- Ne pas réintroduire de texte pédagogique type `Session = ... Take = ...` dans l'UI finale ; conserver ces notions dans la documentation.
