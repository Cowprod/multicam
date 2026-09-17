# 14 — Paramètres du device

**Statut : ✅ VALIDÉ — 17 septembre 2026**

Référence visuelle : `ui/14-device-settings/index.html`.

## Objet

Écran local de configuration persistante du device. Il est accessible localement quel que soit le rôle courant du device.

Cet écran ne contient pas les réglages propres à un Take ni les overrides Capture, qui restent dans l'écran 05.

## Interface validée

L'écran contient les blocs suivants :

1. Identité ;
2. Skills actives ;
3. Stockage local ;
4. Autorisations ;
5. Informations appareil ;
6. Diagnostic Android.

## Identité

- nom humain du device librement modifiable ;
- valeur persistante ;
- ce nom est celui annoncé sur le LAN et affiché aux Masters.

## Skills actives

Afficher uniquement les skills supportées par le build/device, avec activation locale indépendante :

- Capture — `fa-video` ;
- Storage — `fa-hard-drive` ;
- Master/Controller — `fa-sliders`.

Règles :

- une skill supportée peut être activée ou désactivée localement ;
- une skill non supportée ne doit pas être proposée comme activable ;
- `enabledSkills` est persistant ;
- les skills activées sont celles annoncées lors de la découverte LAN ;
- un Master ne peut attribuer en session qu'une skill supportée et activée.

## Stockage local

Prévoir un emplacement par défaut utilisable automatiquement sans configuration opérateur.

Sur Android, utiliser en priorité un répertoire applicatif accessible en écriture. Le POC a déjà validé l'accès via `cordova-plugin-file`, notamment `externalDataDirectory`, ainsi qu'un test réel d'écriture.

L'UI affiche :

- emplacement courant ;
- espace libre ;
- bouton `Changer`.

Le changement d'emplacement doit permettre à terme de choisir un emplacement Android autorisé, notamment une carte SD, via le mécanisme Android adapté (SAF / sélecteur de dossier). Le POC actuel ne contient pas encore ce sélecteur.

Ne jamais considérer un chemin comme valide sur sa seule existence : vérifier la capacité réelle d'écriture.

## Autorisations

Afficher au minimum les autorisations utiles déjà exercées par le POC :

- caméra ;
- microphone ;
- localisation ;
- notifications ;
- accès effectif au stockage courant.

Chaque ligne affiche son état réel.

Si une autorisation manque et peut être demandée directement, proposer `Autoriser`.

Si Android ne permet plus la demande directe, utiliser `cordova.plugins.diagnostic` pour ouvrir les réglages appropriés de l'application.

Pour la localisation, distinguer la permission Android du fait que le service de localisation/GPS du système soit activé.

## Informations appareil

Bloc en lecture seule. Les informations disponibles dans le POC comprennent notamment :

- constructeur ;
- modèle ;
- version Android ;
- SDK Android ;
- version Cordova ;
- version de l'application ;
- batterie et état de charge ;
- réseau courant ;
- espace libre.

`cordova-plugin-device` fournit déjà constructeur/modèle/Android/SDK/UUID/version Cordova dans le POC.

Ne pas utiliser l'adresse IP comme identité du device : l'identité réseau persistante repose sur le `deviceId` du protocole MultiCam.

## Diagnostic Android

Actions opérateur retenues :

- ouvrir les réglages de localisation ;
- ouvrir les réglages de l'application.

Ces actions s'appuient sur `cordova.plugins.diagnostic`, déjà présent/testé dans le POC.

## Éléments techniques déjà présents dans le POC

Le projet de test Cordova fourni avant l'implémentation V1 contient déjà des briques à réutiliser ou qualifier :

- `cordova-plugin-device` ;
- `cordova-plugin-android-permissions` ;
- `cordova.plugins.diagnostic` ;
- `cordova-plugin-battery-status` ;
- `cordova-plugin-geolocation` ;
- `cordova-plugin-file` ;
- `cordova-plugin-insomnia` ;
- gestion d'orientation écran ;
- plugin de luminosité ;
- `cordova-plugin-zeroconf` ;
- `cordova-plugin-camera-preview` avec patch PixelCopy pour la preview ponctuelle pendant REC.

Insomnia, orientation, luminosité et Zeroconf sont des mécanismes internes et ne sont pas exposés comme réglages opérateur dans cet écran.

## Invariants pour l'agent de codage

- paramètres locaux persistants, indépendants des Takes ;
- ne pas dupliquer les réglages Vidéo/Audio/GPS/Countdown/Transfert de l'écran 05 ;
- les états de permissions et de stockage affichés doivent provenir de contrôles réels, pas d'un état UI mémorisé ;
- le stockage sélectionné doit être réellement testable en écriture ;
- les informations appareil sont en lecture seule ;
- conserver une UI opérateur simple : les détails d'implémentation Cordova/Android ne doivent pas apparaître dans les libellés utilisateur.