# MultiCam UI 01 — Accueil / Découverte des sessions

## Statut

**VALIDÉ comme écran de référence UI.**

Ce document décrit la maquette `index.html` située dans ce même dossier.

## Objectif

Écran d’accueil opérationnel permettant de voir les sessions disponibles sur le LAN, d’en rejoindre une ou d’en créer une nouvelle. Il reste volontairement léger.

## Principes UI

- Bootstrap 5.x à jour.
- Bootswatch **Quartz**.
- Font Awesome.
- jQuery autorisé.
- Interface conçue au-dessus de la preview caméra native.
- Dans Cordova réel : `cordova-plugin-camera-preview` avec `toBack:true`, WebView transparente et surfaces semi-transparentes.

## Structure

### Header
- MultiCam.
- Nom du device (`Cam 07` dans la maquette).
- Menu hamburger.

### Sessions détectées
Chaque session affiche :
- nom ;
- nombre d’appareils présents ;
- bouton `Rejoindre`.

### Fallback
`Rejoindre par code / QR` pour les cas où mDNS/Bonjour ne suffit pas.

### Action principale
`Nouvelle session`, visuellement dominante.

### Menu secondaire
- Historique des sessions.
- Paramètres de ce device.

## Données minimales

```json
{
  "sessionId": "uuid",
  "name": "Captation Salle 2",
  "deviceCount": 12,
  "status": "open"
}
```

Device local :

```json
{
  "deviceId": "uuid",
  "name": "Cam 07"
}
```

## Découverte réseau

- mDNS / Bonjour en priorité.
- Code / QR en fallback.
- Une session détectée n’est jamais rejointe automatiquement depuis cet écran.

## Rejoindre une session

Le clic sur `Rejoindre` mène à l’écran suivant de définition des rôles actifs du device.

Principes déjà validés :
- capacités possibles : `controller`, `capture`, `storage` ;
- capacités et rôles actifs sont distincts ;
- devenir Controller/Master d’une session existante nécessite un PIN 4 chiffres.

## Créer une session

`Nouvelle session` mène à l’écran de création :
- le créateur est nécessairement Controller/Master ;
- Capture et/ou Storage peuvent également être activés selon les capacités ;
- un PIN 4 chiffres aléatoire est créé.

Aucun choix de rôle sur cet écran 01.

## États à prévoir

### Recherche en cours
Le bouton d’actualisation peut afficher un spinner. La liste existante peut rester visible.

### Aucune session
Afficher simplement `Aucune session détectée sur le réseau local.` tout en conservant code/QR et `Nouvelle session`.

### Session disparue
Ne pas rejoindre une session fantôme ; afficher une erreur courte puis actualiser la découverte.

## Responsive

Priorité Android tablette/téléphone. Exploitable à partir d’environ 320 px CSS. Les noms longs sont tronqués sans casser la mise en page.

## Contraintes Camera Preview

- Ne pas rendre `html`, `body` ou la WebView opaques dans l’application réelle.
- Conserver la perception de la preview sous les cards.
- Pas de `z-index` négatif pour la simulation dans les maquettes.
- La preview réelle reste gérée nativement par le plugin.

## Hors périmètre

Ne pas ajouter ici : rôles, PIN, réglages caméra, résolution/qualité, Storage, GPS, batterie, médias, diagnostics plugins, Take, ARM, START ou STOP.

## Règle agents de codage

`index.html` est la référence visuelle ; ce README est la référence fonctionnelle et technique. Ne pas enrichir arbitrairement l’écran ni réintroduire les informations volontairement déplacées vers d’autres écrans.
