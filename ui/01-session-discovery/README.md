# MultiCam UI 01 — Accueil / Découverte

## Statut

**VALIDÉ — mis à jour le 17 septembre 2026**

`index.html` est la référence visuelle validée de cet écran. Ce README est sa référence fonctionnelle et technique pour les agents de codage.

## Objectif

Écran d’accueil local d’un device MultiCam. Il montre son identité, sa disponibilité réseau et les skills supportées par cette implémentation. Si le skill `controller` est activé, il donne accès aux sessions détectées, aux quatre dernières sessions utilisées et à la création d’une session.

## Header

- nom de l’application `MultiCam` ;
- nom local du device affiché en permanence ;
- menu hamburger.

## Disponibilité et skills

Le device affiche `Disponible sur le réseau`.

Convention d’icônes :

- Capture : `fa-video` ;
- Storage : `fa-hard-drive` ;
- Master / controller : `fa-sliders`.

Une skill supportée mais désactivée reste visible en grisé. Les badges sont en lecture seule sur l’accueil. La modification se fait uniquement dans Paramètres.

Le code distingue strictement :

1. `supportedSkills` ;
2. `enabledSkills` ;
3. `sessionRoles`.

## Sessions récentes

Si `controller` est actif, l’accueil affiche directement les **4 sessions les plus récentes**.

Pour ce raccourci, chaque carte affiche uniquement le nom de la session et agit comme un bouton. Un appui ouvre directement l’écran Session 03 correspondant, avec sa configuration persistée.

La reprise conserve le PIN Master, les devices précédemment membres et leurs rôles. Leur présence réelle est réévaluée dans l’écran 03 ; un device absent apparaît déconnecté.

## Sessions disponibles sur le LAN

Visible uniquement si `controller` est actif.

Chaque session détectée sur le LAN propose `Rejoindre`. Cette action concerne le parcours Master/Controller. Une Capture ou un Storage attend qu’un Master l’ajoute à la session.

## Nouvelle session

Visible uniquement si `controller` est actif. La création fait de ce device le Master de la nouvelle session.

## Sans skill Controller

Si `controller` est désactivé :

- masquer les sessions récentes ;
- masquer les sessions disponibles ;
- masquer `Nouvelle session` ;
- le device reste disponible selon ses autres skills activées.

## Navigation validée

- Session récente → `ui/03-master-session/` ;
- `Rejoindre` → écran 02 en mode accès ;
- `Nouvelle session` → écran 02 en mode création ;
- `Historique` → `ui/15-session-history/` ;
- `Paramètres` → `ui/14-device-settings/`.

Il n’y a pas de parcours QR/code dans la V1.

## Découverte réseau

- fonctionnement LAN sans backend Internet ;
- mDNS/Bonjour comme mécanisme principal ;
- identité persistante via `deviceId`, jamais via IP ;
- l’annonce fournit au minimum identité + skills supportées/activées.

## Contraintes UI / Cordova

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- interface exploitable à partir d’environ 320 px CSS ;
- dans l’application réelle, la preview caméra native reste derrière la WebView transparente.

## Invariants

- zéro `enabledSkills` est autorisé ;
- une skill non supportée ne peut pas être activée ;
- désactiver `controller` masque toute l’UI de gestion/création/reprise de sessions ;
- conserver les icônes Capture/Storage/Master de façon cohérente dans toute l’application.
