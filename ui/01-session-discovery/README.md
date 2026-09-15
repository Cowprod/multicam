# MultiCam UI 01 — Accueil / Découverte

## Statut

**VALIDÉ — 15 septembre 2026**

`index.html` est la référence visuelle validée de cet écran. Ce README est sa référence fonctionnelle et technique pour les agents de codage.

## Objectif

Écran d’accueil local d’un device MultiCam. Il montre son identité, sa disponibilité réseau et les skills supportées par cette implémentation. Si le skill `controller` est activé, il donne également accès aux sessions détectées et à la création d’une session.

L’interface opérateur doit rester concise : les explications d’architecture comme « skills annoncées aux Masters » appartiennent à la documentation, pas à l’écran.

## UI validée

### Header

- nom de l’application `MultiCam` ;
- nom local du device affiché en permanence (`Cam 07` dans la maquette) ;
- menu hamburger.

### Disponibilité

Le device affiche son état `Disponible sur le réseau`.

Les trois skills supportées par l’application Android V1 sont toujours représentées par des badges :

- `Capture` : Font Awesome `fa-video` ;
- `Storage` : Font Awesome `fa-hard-drive` ;
- `Master` / `controller` : Font Awesome `fa-sliders`.

Ces icônes constituent la convention UI à réutiliser sur les autres écrans.

Une skill activée est affichée normalement. Une skill supportée mais désactivée reste visible, mais grisée. Il est donc possible d’avoir zéro skill activée sans masquer les capacités que cette version de l’application sait fournir.

Les badges de l’accueil sont en lecture seule. Il ne doit pas y avoir de bouton de modification rapide des skills sur cet écran.

### Paramètres

La modification de `enabledSkills` se fait exclusivement depuis `Paramètres`, accessible par le menu hamburger.

### Sessions

La zone `Sessions disponibles`, son bouton de rafraîchissement et les sessions détectées ne sont visibles que si le skill `controller` est activé localement.

Chaque session détectée propose l’action `Rejoindre`.

`Rejoindre` signifie ici rejoindre la session comme Master/Controller. Une Capture ou un Storage ne se joint pas lui-même à une session depuis cette liste.

### Nouvelle session

Le bouton `Nouvelle session` n’est visible que si le skill `controller` est activé. La création d’une session fait de ce device un Master de cette session.

### Sans skill Controller

Si `controller` est désactivé :

- aucune liste de sessions ;
- aucun bouton `Nouvelle session` ;
- le device reste disponible sur le LAN selon ses autres skills activées ;
- si aucune skill n’est activée, les skills supportées restent simplement affichées grisées.

## Architecture skills

Voir également `docs/SKILLS-AND-ROLES.md`.

Le code doit distinguer strictement :

1. `supportedSkills` : capacités réellement implémentées par ce client ;
2. `enabledSkills` : sous-ensemble que l’utilisateur autorise ce device à fournir/annoncer ;
3. `sessionRoles` : rôles attribués au device dans une session donnée.

### Android V1

Cette implémentation supporte dans son code :

```json
["controller", "capture", "storage"]
```

Cela ne signifie pas que les trois sont obligatoirement activées.

### Autres clients

Ne jamais déduire les skills depuis le type de matériel. Une implémentation Raspberry Pi peut par exemple déclarer uniquement :

```json
["storage"]
```

L’UI doit afficher uniquement les `supportedSkills` déclarées par l’implémentation courante.

## Modèle minimal

```json
{
  "deviceId": "uuid",
  "name": "Cam 07",
  "platform": "android",
  "supportedSkills": ["controller", "capture", "storage"],
  "enabledSkills": ["controller", "capture", "storage"]
}
```

`enabledSkills` peut être un tableau vide.

## Découverte réseau

- fonctionnement LAN sans backend Internet ;
- mDNS/Bonjour en mécanisme principal de découverte ;
- identité persistante basée sur `deviceId`, jamais sur l’adresse IP ;
- l’annonce réseau doit permettre au Master de connaître au minimum l’identité du device ainsi que ses skills supportées et activées.

Une Capture ou un Storage disponible sur le LAN attend qu’un Master l’ajoute à une session. Le bouton `Rejoindre` de cet écran concerne uniquement le parcours Controller/Master.

## Navigation de référence

- `Rejoindre` → écran 02 en mode accès à une session existante ;
- `Nouvelle session` → écran 02 en mode création ;
- `Paramètres` → écran 15 lorsqu’il sera conçu ;
- `Historique` → écran 16 lorsqu’il sera conçu.

Les écrans non encore conçus ne doivent pas être inventés par l’agent pour compléter artificiellement la navigation.

## Contraintes UI / Cordova

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- interface exploitable à partir d’environ 320 px CSS ;
- la maquette HTML utilise une vidéo de fond pour simuler la preview ;
- dans l’application réelle, la preview caméra est native via `cordova-plugin-camera-preview` avec WebView transparente et `toBack:true` ;
- les surfaces Quartz doivent conserver leur transparence au-dessus de la preview.

## Invariants pour l’implémentation

- Zéro `enabledSkills` est autorisé.
- Une skill non présente dans `supportedSkills` ne doit jamais pouvoir être activée.
- Désactiver `controller` masque toute l’UI de gestion/création des sessions sur cet écran.
- Les skills supportées restent visibles même lorsqu’elles sont désactivées.
- Les icônes Capture/Storage/Master validées doivent être conservées de manière cohérente dans l’ensemble de l’application.
- Ne pas ajouter de texte pédagogique ou technique à l’interface lorsqu’il n’aide pas directement l’opérateur ; placer ces explications dans les README.
