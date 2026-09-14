# MultiCam UI 01 — Accueil / Découverte

## Statut

**UI initialement validée, parcours actuellement en révision suite à la séparation skills / rôles de session.**

Ce document décrit la maquette `index.html` située dans ce même dossier.

## Objectif

Écran d’accueil du device sur le LAN. Le device se rend disponible avec ses skills activées. Les Masters peuvent découvrir les devices disponibles et les affecter à une session.

L’accès direct à une session détectée depuis ce device est réservé au cas où l’utilisateur souhaite devenir `Controller/Master`.

## Principes UI

- Bootstrap 5.x à jour.
- Bootswatch **Quartz**.
- Font Awesome.
- jQuery autorisé.
- Interface conçue au-dessus de la preview caméra native lorsqu’elle existe.
- Dans Cordova Android : `cordova-plugin-camera-preview` avec `toBack:true`, WebView transparente et surfaces semi-transparentes.

## Skills : règle d’architecture

Voir également `docs/SKILLS-AND-ROLES.md`.

Il faut impérativement distinguer :

1. `supportedSkills` : skills réellement implémentées par le code de ce client ;
2. `enabledSkills` : sous-ensemble activé localement par l’utilisateur ;
3. `sessionRoles` : rôles effectivement attribués au device dans une session.

### Android V1

L’application Android doit supporter dans son code :

- `controller` ;
- `capture` ;
- `storage`.

L’utilisateur peut activer/désactiver localement ces skills.

### Autres implémentations

Une autre application MultiCam peut exposer un sous-ensemble différent. Exemple : un client Raspberry Pi destiné au stockage peut n’implémenter que `storage`.

Les agents de codage ne doivent donc jamais supposer que tous les clients disposent des trois skills.

## Structure

### Header

- MultiCam ;
- nom du device (`Cam 07` dans la maquette) ;
- menu hamburger.

### Disponibilité du device

L’accueil indique que le device est disponible sur le réseau et affiche de manière synthétique ses `enabledSkills`.

Ces badges sont informatifs. La modification des skills activées appartient aux paramètres du device.

### Sessions disponibles

Les sessions LAN peuvent être affichées pour permettre à un utilisateur autorisé de rejoindre une session **comme Master**.

Ce n’est plus le mécanisme normal permettant à une Capture ou un Storage de s’ajouter à une session.

### Nouvelle session

`Nouvelle session` crée une session dont ce device devient nécessairement Controller/Master.

### Menu secondaire

- Historique des sessions ;
- Paramètres du device / skills activées.

## Modèle minimal du device

```json
{
  "deviceId": "uuid",
  "name": "Cam 07",
  "platform": "android",
  "supportedSkills": ["controller", "capture", "storage"],
  "enabledSkills": ["controller", "capture", "storage"]
}
```

## Découverte réseau

- mDNS / Bonjour en priorité ;
- identité basée sur `deviceId`, jamais sur l’adresse IP ;
- le device annonce ses skills supportées et activées ;
- un Master peut découvrir les devices disponibles sur le LAN.

## Affectation à une session

Pour `capture` et `storage`, le principe retenu est désormais :

- le device se rend disponible sur le LAN ;
- le Master le découvre ;
- le Master l’ajoute à sa session et lui attribue les rôles autorisés par ses `enabledSkills`.

Le device ne doit pas nécessiter une manipulation locale systématique pour rejoindre la session : cela serait impraticable avec une quinzaine de tablettes.

Le détail du mécanisme d’invitation/affectation sera finalisé avec l’écran Master des devices.

## Accès Controller/Master

Un autre Controller peut rejoindre une session existante volontairement.

- accès protégé par PIN 4 chiffres ;
- ce parcours est distinct de l’affectation Capture/Storage par le Master.

## Responsive

Priorité Android tablette/téléphone. Exploitable à partir d’environ 320 px CSS.

## Contraintes Camera Preview

- Ne pas rendre `html`, `body` ou la WebView opaques dans l’application réelle.
- Conserver la perception de la preview sous les cards.
- La preview réelle reste gérée nativement par le plugin.

## Règle agents de codage

`index.html` est la référence visuelle et ce README la référence fonctionnelle de cet écran.

Ne pas confondre `supportedSkills`, `enabledSkills` et `sessionRoles`. Ne jamais permettre à l’utilisateur ou à un Master d’activer un rôle que le code du client ne déclare pas comme supporté.
