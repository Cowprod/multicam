# MultiCam UI 07 — Countdown / START synchronisé

## Statut

**VALIDÉ — 16 septembre 2026**

Les trois maquettes de référence sont :

- `index.html` : vue Master ;
- `capture.html` : vue Capture ;
- `storage.html` : vue Storage.

Ce README est la référence fonctionnelle et technique pour les agents de codage.

## Déclenchement du countdown

Quand un Master déclenche REC depuis l'écran 06 et que le countdown configuré est supérieur à 0 :

- l'écran 07 s'ouvre ;
- le countdown démarre immédiatement ;
- aucun bouton de confirmation supplémentaire n'est affiché.

Si le countdown est configuré à `0 s`, l'écran 07 est entièrement sauté et le système passe directement à l'écran 08 / RECORDING.

## Synchronisation du top

Le countdown ne doit pas être implémenté comme un simple `setInterval` indépendant sur chaque device.

Le Master définit un **instant cible absolu commun**. Chaque device calcule localement le temps restant en appliquant l'offset d'horloge estimé pendant l'ARM.

Objectif : tous les devices participants visent le même top réel.

Pour un countdown de 5 s, l'affichage est :

`5 · 4 · 3 · 2 · 1`

Puis démarrage direct au top, sans afficher `0` ni écran `REC` intermédiaire.

Countdown strictement visuel :

- aucun bip ;
- aucune vibration.

## Vue Master — `index.html`

Tous les Masters connectés à la session affichent le countdown en grand, même si un autre Master a déclenché le REC.

La vue Master contient uniquement :

- nom de session ;
- numéro / nom du Take ;
- chiffre géant du countdown ;
- bouton `Annuler`.

Pendant ces quelques secondes, ne pas afficher :

- liste des Captures ;
- état détaillé des autres devices ;
- alertes transitoires de connexion ;
- messages de réintégration.

### Annulation

N'importe quel Master peut annuler le countdown.

L'annulation :

- annule le départ pour tout le Take ;
- renvoie les devices concernés à l'état ARM ;
- ramène les Masters à l'écran 06.

## Vue Capture — `capture.html`

La Capture ne voit que ce qui la concerne elle-même.

La vue Capture comprend :

- vidéo locale plein écran ;
- nom de session ;
- Take ;
- nom du device ;
- countdown en grand ;
- états locaux du device uniquement.

Exemples d'états locaux affichables :

- Capture ;
- Audio ;
- GPS ;
- stockage local ;
- batterie ;
- réseau.

Ne jamais afficher sur une Capture non-Master :

- les autres Captures ;
- les autres devices ;
- les incidents des autres devices ;
- les contrôles Master ;
- le bouton Annuler global.

### Capture écartée pendant le countdown

Si une Capture passe en ERROR ou devient indisponible avant le top :

- elle quitte immédiatement le countdown ;
- elle affiche une grosse icône d'erreur ;
- elle affiche la cause ;
- aucun bouton d'action n'est proposé.

Si elle redevient READY avant le top, elle peut réintégrer automatiquement le départ et reprendre l'affichage du temps restant.

Aucun message de cette sortie/réintégration n'est affiché sur les Masters pendant le countdown.

### Plus aucune Capture démarrable

Si toutes les Captures deviennent indisponibles avant le top :

- annuler automatiquement le countdown ;
- revenir à l'écran 06 ARM.

## Perte de tous les Masters pendant le countdown

La perte de tous les Masters ne doit pas annuler un top déjà programmé.

Les Captures participantes :

- continuent le countdown ;
- démarrent le REC au top prévu.

Une fois en REC, tant qu'aucun Master n'est connecté, chaque Capture affiche un STOP local d'urgence.

Ce STOP :

- demande confirmation avec une modal `Annuler / Confirmer STOP` ;
- arrête uniquement la Capture concernée ;
- ne stoppe pas les autres Captures du Take ;
- place cette Capture en STOPPED local ;
- ne permet pas de redémarrer cette Capture dans le même Take.

Dès qu'un Master revient, le contrôle global redevient prioritaire et le STOP local d'urgence disparaît.

## Vue Storage — `storage.html`

Un Storage peut être rattaché à plusieurs sessions et plusieurs Takes simultanément.

Il n'utilise donc pas une vue countdown plein écran.

### En-tête Storage

Afficher :

- nom du Storage ;
- espace libre ;
- type de réseau : Wi-Fi / Ethernet ;
- qualité du signal Wi-Fi si l'information est disponible.

Pas d'indicateur global supplémentaire du nombre de Takes en cours : la liste suffit.

### Groupement

La liste est groupée par **Session**.

Règles :

- sessions triées selon leur activité la plus récente ;
- session la plus récemment active en premier ;
- groupes Session repliables ;
- session la plus récente ouverte par défaut ;
- dans chaque session, Takes triés du plus récent au plus ancien ;
- tous les Takes restent affichés, même terminés et complets ;
- les Takes sont eux-mêmes repliables indépendamment ;
- plusieurs Takes peuvent rester ouverts simultanément.

### Synchronisation avec l'état du Take

Si le Storage est rattaché à un Take, son état doit refléter l'état courant du Take/Master en temps réel :

- Préparation ;
- ARM ;
- Countdown ;
- REC ;
- STOPPED / Transfert ;
- Complet ;
- Erreur.

Si un countdown est annulé :

- le Take repasse à `ARM` tant que le Master reste sur l'écran ARM ;
- s'il revient en préparation, le Storage affiche `Préparation`.

### Countdown et REC sur Storage

Pour chaque Take actif :

- afficher le countdown dans un badge compact ;
- au top, le badge passe automatiquement à `REC 00:00` ;
- le timer REC progresse ensuite en temps réel ;
- plusieurs Takes peuvent avoir chacun leur timer REC simultanément.

### Après le REC : transferts attendus

Une fois le REC terminé, le Take reste visible avec l'état de ses transferts attendus.

Résumé compact :

- `2/4 reçus` signifie **2 devices reçus sur 4 devices attendus** ;
- un device n'est compté comme reçu que lorsque tous ses clips attendus sont reçus et vérifiés sur ce Storage.

Badges Take :

- `Complet` → `bg-success` ;
- `Transfert` → `bg-warning` ;
- `Erreur` → `bg-danger`.

### Détail des transferts

Chaque Take possède un accordéon de progression, mis à jour en WebSocket.

Afficher d'abord une ligne par device attendu.

Pour chaque device :

- En attente ;
- Transfert x% ;
- Vérification ;
- Reçu ;
- Erreur.

Si plusieurs clips existent pour un device, ils sont détaillables sous sa ligne.

Pendant le REC, les devices/fichiers attendus peuvent déjà être listés en `En attente`, même si aucun transfert média ne démarre encore.

### Progression précise

Avant de connaître la taille finale des clips :

- progression qualitative / par clips / devices.

À la fin du Take, dès que la Capture transmet la taille finale :

- utiliser la progression en octets ;
- exemple : `1,8 / 2,6 Go · 69%`.

La progression est mise à jour en temps réel via WebSocket.

## WebSocket

L'état de l'écran 07 est piloté par les événements de session / Take :

- instant cible du countdown ;
- état READY / ERROR des Captures ;
- réintégration avant top ;
- annulation Master ;
- démarrage REC ;
- état du Take côté Storage ;
- timers REC ;
- progression de transfert ;
- vérification des médias.

Le rendu Master reste volontairement silencieux pendant les quelques secondes de countdown : les événements techniques sont appliqués mais ne génèrent pas d'alertes visuelles sauf annulation globale si aucune Capture ne reste démarrable.

## UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette ;
- countdown Master sur fond sombre statique pour minimiser la charge ;
- Capture : preview locale plein écran ;
- Storage : interface de supervision multi-session / multi-Take.

## Invariants pour l'agent de codage

- Countdown > 0 : écran 07 démarre immédiatement.
- Countdown = 0 : écran 07 sauté.
- Un instant cible absolu commun pilote le top.
- Affichage 5→1 puis REC direct, jamais `0`.
- Aucun son ni vibration.
- Tous les Masters affichent le countdown.
- Seuls les Masters peuvent annuler globalement.
- N'importe quel Master peut annuler.
- Capture : aucune information sur les autres devices.
- Capture écartée : erreur locale + cause.
- Capture READY avant top : réintégration possible.
- Zéro Capture démarrable avant top : countdown annulé et retour ARM.
- Perte de tous les Masters : le REC démarre quand même au top prévu.
- STOP local d'urgence sans Master : confirmation, uniquement sur la Capture locale.
- Une Capture stoppée localement ne redémarre pas dans le même Take.
- Storage peut suivre plusieurs Takes simultanément.
- Storage groupé par Session, Takes en chrono décroissante.
- Storage conserve l'historique visible, y compris `Complet`.
- `2/4 reçus` compte les devices, pas les fichiers.
- Device reçu = tous ses clips reçus et vérifiés.
