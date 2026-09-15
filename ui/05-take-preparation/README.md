# MultiCam UI 05 — Préparation / Réglages du Take

## Statut

**VALIDÉ — 16 septembre 2026**

`index.html` est la référence visuelle de cet écran. Ce README est la référence fonctionnelle et technique pour les agents de codage.

## Objectif

Cet écran prépare le prochain Take avant ARM.

Il permet de :

- sélectionner les devices de Capture participants ;
- sélectionner les Storage attendus ;
- définir les réglages globaux du Take ;
- définir des overrides par Capture ;
- visualiser les incompatibilités entre les réglages du Take et les capacités de chaque Capture ;
- passer à ARM dès qu'au moins une Capture est sélectionnée.

## Héritage entre Takes

### Premier Take

Pour le premier Take d'une session :

- aucune Capture n'est sélectionnée par défaut ;
- aucun Storage n'est sélectionné par défaut ;
- les réglages utilisent les valeurs par défaut définies ci-dessous.

### Takes suivants

À partir du Take suivant, reprendre automatiquement le Take précédent :

- sélection des Captures ;
- sélection des Storage ;
- réglages globaux ;
- overrides par Capture.

Si une Capture est désélectionnée puis resélectionnée dans le même Take, conserver ses overrides.

## Sélection des Captures

Chaque Capture disponible affiche au minimum :

- nom ;
- batterie ;
- stockage libre ;
- switch de participation au Take ;
- icônes d'état/compatibilité Vidéo, Audio et GPS ;
- crayon d'override.

Actions de groupe :

- `Toutes` ;
- `Aucune`.

Le crayon reste visible en permanence pour conserver la lisibilité de l'interface, mais il est désactivé/grisé lorsque la Capture n'est pas sélectionnée.

## Sélection des Storage

Chaque Storage disponible affiche au minimum :

- nom ;
- espace libre ;
- switch de participation au Take.

Actions de groupe :

- `Tous` ;
- `Aucun`.

Aucun Storage n'est obligatoire pour lancer un Take.

Si aucun Storage n'est sélectionné :

- afficher un warning indiquant que les médias resteront sur les Captures ;
- l'accordéon `Transfert` reste visible mais désactivé.

## Condition d'accès à ARM

Le bouton `ARM` est actif dès qu'au moins une Capture est sélectionnée.

Avec zéro Capture :

- bouton ARM désactivé ;
- message court demandant de sélectionner au moins une Capture.

L'absence de Storage ne bloque pas ARM.

## Réglages globaux du Take

Les réglages restent sur cet écran afin d'éviter un écran supplémentaire.

Ils sont présentés sous forme d'accordéons Bootstrap ; un seul accordéon est ouvert à la fois.

### Vidéo

Un seul accordéon `Vidéo` regroupe :

- résolution : `HD / Full HD / 4K` ;
- qualité : `Éco / Normal / Haute` ;
- caméra : `Arrière / Avant` ;
- orientation : `Paysage / Portrait`.

Valeurs par défaut du premier Take :

- `Full HD` ;
- `Haute` ;
- `Arrière` ;
- `Paysage`.

### Audio

L'Audio possède son propre accordéon, même si la V1 n'a qu'un réglage :

- `Activé` ;
- `Désactivé`.

Valeur par défaut : `Activé`.

Cette structure doit permettre d'ajouter ultérieurement des paramètres audio sans modifier la logique générale de l'écran.

### GPS

Profils :

- `Off` ;
- `Éco` ;
- `Normal` ;
- `Précis`.

Valeur par défaut : `Normal`.

### Countdown

Valeurs prédéfinies :

- `0 s` ;
- `3 s` ;
- `5 s` ;
- `10 s`.

Valeur par défaut : `5 s`.

Le Countdown est un réglage global du Take. Il ne possède aucun override par device.

### Transfert

L'accordéon `Transfert` regroupe :

- `Transfert automatique` ON/OFF ;
- `Suppression locale` ON/OFF après réplication validée.

Valeurs par défaut du premier Take :

- transfert automatique : ON ;
- suppression locale après réplication validée : ON.

Ces réglages sont globaux au Take et n'ont aucun override par Capture.

Si aucun Storage n'est sélectionné, l'accordéon reste affiché mais désactivé.

## Overrides par Capture

Une Capture sélectionnée peut avoir des réglages spécifiques via le crayon de sa ligne.

Les overrides autorisés sont uniquement :

- Vidéo ;
- Audio ;
- GPS.

Ne pas ajouter :

- Countdown ;
- Transfert.

### Héritage

Chaque bloc d'override utilise la mécanique `Hériter` :

- par défaut, `Hériter` est actif ;
- tant qu'il est actif, le device utilise le réglage global du Take ;
- lorsqu'il est désactivé, les réglages spécifiques du device apparaissent.

Les overrides sont repris du Take précédent.

### Capacités du device

Dans la fenêtre d'override, ne proposer que les valeurs réellement supportées par le device.

Exemple : un device ne supportant que `HD` ne doit pas voir `Full HD` ou `4K` dans son sélecteur d'override.

La fenêtre d'override n'affiche donc pas de warning de capacité : les choix impossibles n'y sont simplement pas proposés.

## Compatibilité globale et best effort

Les réglages globaux du Take ne doivent pas être réduits au plus petit dénominateur commun des Captures.

Exemple : `Full HD` reste sélectionnable même si une Capture ne supporte que `HD`.

Le système applique une stratégie **best effort** par device :

- utiliser la valeur demandée si elle est supportée ;
- sinon choisir automatiquement la meilleure valeur compatible ;
- ne pas bloquer ARM uniquement à cause de cette différence de capacité ;
- signaler le fallback à l'opérateur.

Exemple :

`Full HD indisponible → HD`

Les vérifications ARM réelles peuvent naturellement encore produire `WARNING` ou `ERROR` pour d'autres causes : permissions, caméra indisponible, stockage insuffisant, etc.

## Warnings de compatibilité sur les Captures

Les warnings de compatibilité sont visibles sur **toutes les Captures**, sélectionnées ou non, afin d'aider l'opérateur à choisir ses participants.

Ils sont représentés par l'icône du réglage concerné sur la ligne du device :

- icône Vidéo ;
- icône Audio ;
- icône GPS.

Si une adaptation est nécessaire, l'icône passe en état warning.

Un appui sur l'icône affiche le détail du fallback, par exemple :

`Full HD indisponible → HD`

ou :

`GPS Normal indisponible → Off`

Ces warnings comparent les **réglages globaux du Take** aux capacités du device. Ils ne sont pas recalculés à partir d'un éventuel override du device.

## Modèle de données conceptuel

Exemple :

```json
{
  "takeNumber": 1,
  "status": "PREPARATION",
  "captures": ["device-cam07"],
  "storages": ["device-storage01"],
  "settings": {
    "video": {
      "resolution": "FHD",
      "quality": "HIGH",
      "camera": "REAR",
      "orientation": "LANDSCAPE"
    },
    "audio": true,
    "gpsProfile": "NORMAL",
    "countdownSeconds": 5,
    "transferAuto": true,
    "deleteLocalAfterVerifiedReplication": true
  },
  "captureOverrides": {
    "device-cam07": {
      "video": null,
      "audio": null,
      "gpsProfile": null
    }
  }
}
```

`null` signifie ici : hériter du réglage global du Take.

## Navigation

- retour → écran 03 Session / Vue Master ;
- `ARM` → écran 06 ;
- crayon Capture → modal locale d'override.

## UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- fond vidéo uniquement pour simuler la preview dans les maquettes ;
- éviter les textes pédagogiques qui n'aident pas directement l'opérateur.

## Invariants pour l'agent de codage

- Le premier Take ne sélectionne automatiquement ni Capture ni Storage.
- Les Takes suivants héritent des sélections, réglages et overrides du Take précédent.
- Au moins une Capture est requise pour ARM.
- Aucun Storage n'est requis pour ARM.
- Sans Storage, Transfert reste visible mais désactivé.
- Les réglages restent sur l'écran 05 sous forme d'accordéons.
- Overrides Capture : Vidéo / Audio / GPS uniquement.
- Countdown et Transfert restent globaux au Take.
- Un crayon d'override est visible sur chaque Capture mais n'est actif que si elle est sélectionnée.
- Dans un override, ne proposer que les capacités supportées par le device.
- Les réglages globaux peuvent dépasser les capacités d'un device : appliquer best effort + warning indicatif.
- Les warnings de compatibilité sont visibles même sur les Captures non sélectionnées.
- Les warnings sont calculés par rapport aux réglages globaux du Take.
