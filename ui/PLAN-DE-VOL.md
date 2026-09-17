# MultiCam — Plan de vol UI V1

**Dernière mise à jour : 17 septembre 2026**

Ce document sert de point de reprise après interruption. Chaque écran validé doit avoir :

- `index.html` : maquette visuelle de référence ;
- `README.md` : spécification UI + technique pour les agents de codage.

---

# État actuel

## Écrans validés

- **01 — Accueil / Découverte des sessions : ✅ VALIDÉ**
  - `ui/01-session-discovery/`
- **02 — Création / accès Master à une session : ✅ VALIDÉ**
  - `ui/02-master-session/`
- **03 — Session / Vue Master : ✅ VALIDÉ**
  - `ui/03-master-session/`
- **05 — Préparation / Réglages du Take : ✅ VALIDÉ**
  - `ui/05-take-preparation/`
- **06 — ARM / Contrôle de préparation : ✅ VALIDÉ**
  - `ui/06-arm/`
- **07 — Countdown / START synchronisé : ✅ VALIDÉ**
  - `ui/07-countdown/`
- **08 — Live / Recording : ✅ VALIDÉ**
  - `ui/08-live-recording/`
- **09 — Take arrêté / traitements : ✅ VALIDÉ**
  - `ui/09-take-stopped/`
- **14 — Paramètres du device : ✅ VALIDÉ**
  - `ui/14-device-settings/`
- **15 — Historique / Reprise de session : ✅ VALIDÉ**
  - `ui/15-session-history/`

## Prochaine étape immédiate

**La conception des écrans UI V1 est terminée et figée.**

- 10 : retiré, la vue Storage persistante couvre le suivi des transferts ;
- 11 : reporté après V1, pas de gestion distante des médias ;
- 12 : retiré, une Capture hors Take reste simplement en attente ;
- 13 : retiré, la vue Storage persistante de l'écran 07 suffit ;
- 16 : retiré de la V1, pas de QR/code ; découverte LAN par mDNS.

La suite du plan global consiste à reprendre le POC Cordova existant comme base technique, identifier précisément les briques déjà validées/réutilisables et compléter uniquement les qualifications techniques encore manquantes avant l'implémentation de la V1.

---

# Décisions structurantes déjà validées

## 01 — Accueil / Découverte

- nom du device toujours visible ;
- affichage des skills supportées ;
- skill désactivée affichée en grisé ;
- modification des skills uniquement depuis Paramètres ;
- sans skill Controller/Master : masquer sessions disponibles, sessions récentes et Nouvelle session ;
- avec skill Controller/Master : afficher sessions détectées + quatre sessions récentes + Nouvelle session ;
- chaque session récente est un bouton/carte affichant uniquement son nom et ouvre directement la Session 03 correspondante ;
- Historique ouvre l'écran 15 ;
- Paramètres ouvre l'écran 14 ;
- action session LAN : `Rejoindre` ;
- icônes : Capture `fa-video`, Storage `fa-hard-drive`, Master `fa-sliders`.

## 02 — Création / accès Master

- nom de session obligatoire à la création ;
- PIN Master aléatoire à 4 chiffres ;
- création : nom + bouton Créer uniquement ;
- le device créateur devient Master et entre directement dans la session ;
- rejoindre une session existante : nom de session + 4 cases PIN ;
- validation automatique à la saisie du 4e chiffre ;
- PIN incorrect : effacement + message bref + focus première case ;
- les devices Capture/Storage ne se joignent pas eux-mêmes ici.

## 03 — Session / Vue Master

- PIN Master visible en permanence en V1 ;
- barre secondaire compacte sous le header : état session + PIN ;
- liste des devices membres de session ;
- liste des devices disponibles sur le LAN ;
- ajout d'un device initié par le Master ;
- rôles attribuables uniquement parmi les skills supportées + activées + annoncées ;
- édition des rôles via modal ;
- préparation du prochain Take depuis cet écran ;
- liste visuelle des Takes passés dans la Session, du plus récent au plus ancien, y compris transfert en cours ou erreur ;
- clic sur un Take passé → écran 09 correspondant ;
- reprise d'une ancienne session : conserver le même PIN, les mêmes devices membres et leurs rôles ;
- à la reprise, un ancien device absent du LAN reste membre mais apparaît déconnecté, comme après une déconnexion normale.

## 05 — Préparation / Réglages du Take

### Sélections

Premier Take :

- aucune Capture sélectionnée par défaut ;
- aucun Storage sélectionné par défaut.

Takes suivants :

- reprise des Captures du Take précédent ;
- reprise des Storage du Take précédent ;
- reprise des réglages ;
- reprise des overrides par Capture.

Actions de groupe séparées par type :

- Captures : Toutes / Aucune ;
- Storage : Tous / Aucun.

ARM :

- au moins une Capture requise ;
- aucun Storage requis ;
- sans Storage : warning + accordéon Transfert visible mais désactivé.

### Réglages globaux

Tous restent sur l'écran 05 sous forme d'accordéons, un seul ouvert à la fois.

Vidéo :

- HD / Full HD / 4K ;
- Éco / Normal / Haute ;
- caméra Arrière / Avant ;
- Paysage / Portrait.

Audio : Activé / Désactivé.

GPS : Off / Éco / Normal / Précis.

Countdown : 0 / 3 / 5 / 10 s.

Transfert :

- Transfert automatique ON/OFF ;
- Suppression locale après réplication validée ON/OFF.

Valeurs par défaut du premier Take :

- Full HD ;
- Haute ;
- caméra arrière ;
- Paysage ;
- audio ON ;
- GPS Normal ;
- countdown 5 s ;
- transfert automatique ON ;
- suppression locale après réplication validée ON.

### Overrides par Capture

- accessibles via crayon ;
- crayon visible même si Capture non sélectionnée, mais grisé/inactif ;
- actif uniquement sur une Capture sélectionnée ;
- overrides autorisés : Vidéo / Audio / GPS ;
- Countdown et Transfert restent globaux ;
- mécanique `Hériter` par bloc ;
- si `Hériter` est désactivé, afficher les réglages spécifiques ;
- ne proposer dans l'override que les valeurs réellement supportées par le device ;
- si Capture désélectionnée puis resélectionnée dans le même Take, conserver ses overrides.

### Compatibilité / best effort

Les réglages globaux du Take ne sont pas limités au dénominateur commun des Captures.

Si un device ne supporte pas un réglage global :

- appliquer automatiquement la meilleure valeur compatible ;
- afficher un warning indicatif sur l'icône du réglage concerné ;
- appui sur l'icône = détail du fallback ;
- afficher les warnings sur toutes les Captures, même non sélectionnées ;
- les warnings de liste comparent les capacités du device aux réglages globaux du Take, pas à ses overrides.

## 06 — ARM / Contrôle de préparation

- ARM démarre automatiquement à l'entrée ;
- écran en lecture seule ; retour vers 05 pour modifier le Take ;
- retour annule l'ARM en cours ;
- seuls les devices sélectionnés sont affichés ;
- ordre identique à l'écran 05 ;
- un device multi-rôle n'apparaît qu'une fois ;
- ordre des skills : Capture puis Storage ;
- états portés par l'icône de skill et sa couleur ;
- pas de texte READY/WARNING/ERROR dans la liste principale ;
- clic opérateur sur l'icône = accordéon de détail ;
- aucun accordéon ne s'ouvre automatiquement ;
- plusieurs incidents sont affichés séparément ;
- timeout de réponse ARM : 5 s, sans compte à rebours visible ;
- état et récupération pilotés automatiquement par WebSocket ;
- pas de bouton Retry ;
- seuil warning stockage local/Storage : 1 Go libre ;
- contrôle Capture : caméra, audio, permissions, stockage, réglages appliqués, synchronisation ;
- contrôle Storage : connexion, espace libre, accès volume, capacité de recevoir les transferts ;
- synchronisation estimée par échanges horodatés ; objectif pratique V1 ~ ±50 ms ;
- READY et WARNING sont démarrables ;
- ERROR sur une Capture ne bloque pas les autres ;
- incident Storage non bloquant pour REC ;
- REC activable dès qu'au moins une Capture est READY ou WARNING ;
- tout incident au moment de REC ouvre une modal `Annuler / Continuer REC` ;
- la modal se met à jour en temps réel ;
- si tous les incidents disparaissent pendant qu'elle est ouverte, fermeture automatique + lancement immédiat de REC ;
- Capture ARMING au REC : peut rejoindre si READY avant le top, sinon écartée ;
- Capture reconnectée + READY avant le top : réintégration automatique possible ;
- bouton REC fixe en bas ;
- countdown > 0 → écran 07 ; countdown = 0 → écran 08 directement.

## 07 — Countdown / START synchronisé

- countdown lancé immédiatement à l'ouverture ;
- top piloté par un instant cible absolu commun avec correction d'offset d'horloge ;
- affichage `5 · 4 · 3 · 2 · 1`, sans `0`, puis passage direct en REC ;
- countdown strictement visuel, sans son ni vibration ;
- vue Master : fond sombre, session + Take + chiffre géant + bouton Annuler ;
- tous les Masters connectés affichent le countdown ;
- n'importe quel Master peut annuler pour tout le Take ;
- vue Capture : preview locale plein écran, session/Take/device + états locaux uniquement ;
- une Capture non-Master ne voit jamais l'état des autres devices ;
- une Capture écartée affiche une erreur locale + cause ;
- une Capture redevenue READY avant le top peut réintégrer le départ ;
- aucun message d'incident/réintégration n'est affiché aux Masters pendant ces quelques secondes ;
- si aucune Capture ne reste démarrable avant le top : annulation automatique + retour ARM ;
- perte de tous les Masters pendant countdown : le top déjà programmé est conservé ;
- après démarrage sans Master : STOP local d'urgence sur chaque Capture, avec confirmation ;
- le STOP local n'arrête que la Capture concernée ;
- une Capture stoppée localement ne peut pas redémarrer dans le même Take ;
- vue Storage : multi-session / multi-Take, groupée par session ;
- sessions et Takes triés par activité récente / chrono décroissante ;
- Storage affiche état Take synchronisé : Préparation, ARM, Countdown, REC, Transfert, Complet, Erreur ;
- countdown Storage en badge compact puis `REC 00:00` et timer indépendant par Take ;
- après REC, résumé de réplication par devices, ex. `2/4 reçus` ;
- device reçu = tous ses clips attendus reçus et vérifiés ;
- progression détaillée par device puis clips, via WebSocket ;
- dès que la taille finale est connue, progression basée sur les octets ;
- badges : Complet `bg-success`, Transfert `bg-warning`, Erreur `bg-danger`.

## 08 — Live / Recording

- vue Master : timer global unique + mosaïque permanente des Captures ;
- grille adaptative et positions de Captures stables durant tout le Take ;
- preview distante par JPEG périodique ~1 fps, pas de flux vidéo continu ;
- vignette : nom, état, batterie, espace local ;
- le contour coloré indique uniquement le device local ;
- si le Master est aussi Capture, la preview locale sert de fond à l'UI Master ;
- WARNING/ERROR restent localisés à la vignette concernée ;
- clic vignette → grande modal unique avec preview, fonctions actives et détail incident ;
- déconnexion : dernière preview figée, grisée/assombrie, position conservée ;
- reconnexion automatique : retour couleur + reprise previews ;
- Storage du Take affichés sous la mosaïque : nom, état, espace libre, réseau ;
- pas de progression d'anciens Takes sur la vue Master REC ;
- STOP fixe en bas ; confirmation puis arrêt synchronisé immédiat ;
- `STOP_PENDING` supprimé ;
- Capture REC : preview locale plein écran, gros REC, timer, états locaux uniquement ;
- si zéro Master connecté : afficher `Aucun Master connecté` + STOP local d'urgence avec confirmation ;
- STOP local d'urgence = uniquement la Capture locale, sans redémarrage dans le même Take ;
- aucun transfert média entrant/sortant sur un device en RECORDING ;
- contrôle, télémétrie, GPS et previews restent autorisés ;
- transferts automatiquement repris après STOP ;
- Storage-only non-recording peut continuer d'autres transferts.

Référence détaillée : `ui/08-live-recording/README.md`.

## 09 — Take arrêté / traitements

- arrivée directe sur cet écran après le STOP global ;
- interface non technique : états simples et barres de progression ;
- pas de progression globale du Take ;
- une carte par Capture ;
- les destinations Storage sont visibles directement dans chaque carte ;
- une barre distincte par Storage attendu ;
- afficher volume transféré / volume total + pourcentage ;
- une réplication terminée reste visible à `100 % / Terminé` ;
- Capture hors ligne : `En attente de Cam XX`, avec destinations toujours visibles ;
- erreur sur une destination : état `Erreur` + bouton `Réessayer` sur cette destination ;
- pas de retrait d'un Storage attendu en V1 ;
- avec Storage : Take `Terminé` quand toutes les réplications attendues sont terminées et vérifiées ;
- sans Storage : fichiers conservés sur les Captures, Take `Terminé` après finalisation locale ;
- suppression locale après réplication invisible pour l'opérateur ;
- bouton `Préparer le Take suivant` fixe en bas ;
- le Take suivant peut être préparé même si le précédent transfère encore ou comporte une erreur ;
- depuis la Session, les Takes passés restent consultables du plus récent au plus ancien.

Référence détaillée : `ui/09-take-stopped/README.md`.

## 14 — Paramètres du device

- écran local accessible quel que soit le rôle courant du device ;
- nom du device modifiable et persistant ;
- activation/désactivation locale des skills supportées : Capture, Storage, Master ;
- choix d'un emplacement de stockage local, avec emplacement Android par défaut utilisable sans configuration ;
- bouton `Changer` pour sélectionner à terme un autre emplacement autorisé, notamment carte SD ;
- vérification réelle de l'accès en écriture au stockage ;
- autorisations visibles et actionnables : caméra, micro, localisation, notifications, stockage ;
- possibilité d'ouvrir les réglages Android de l'application ou de localisation si nécessaire ;
- informations appareil en lecture seule : constructeur, modèle, Android/SDK, version Cordova/app, réseau, batterie, espace libre ;
- Insomnia, orientation, luminosité et Zeroconf restent des mécanismes internes, pas des réglages opérateur.

Référence détaillée : `ui/14-device-settings/README.md`.

## 15 — Historique / Reprise de session

- l'historique est uniquement un pont vers une Session existante ;
- chaque carte affiche nom de session, dernière activité et nombre de Takes ;
- toute la carte est cliquable ;
- ouverture → écran 03 de cette Session ;
- reprise avec même PIN Master, mêmes devices membres et mêmes rôles ;
- devices actuellement absents affichés déconnectés dans l'écran 03 ;
- la liste des Takes n'est pas dupliquée dans l'historique : elle reste dans la Session 03 ;
- depuis 03, un Take existant ouvre 09 et le prochain Take peut être préparé normalement ;
- accueil 01 : raccourci direct vers les quatre sessions les plus récentes, nom uniquement.

Référence détaillée : `ui/15-session-history/README.md`.

## Organisation des données sur les Storage

Organisation V1 retenue :

```text
<racine-storage>/
└── <session>/
    └── <take>/
        ├── médias…
        └── fichiers JSON associés…
```

Les médias et leurs JSON associés sont donc regroupés physiquement par Session puis par Take sur chaque Storage. La gestion/administration avancée de ces médias sera traitée ultérieurement.

---

# Écrans complémentaires / retirés

## 04 — Configuration détaillée d'un device

**Statut : RETIRÉ / ABSORBÉ PAR 14**

Les paramètres locaux persistants du device sont couverts par l'écran 14. Les réglages propres au Take restent dans l'écran 05.

## 10 — Gestion transferts / Storage

**Statut : RETIRÉ DU PLAN V1**

Pas d'écran séparé : la vue Storage persistante déjà validée dans `ui/07-countdown/storage.html` couvre ce besoin.

## 11 — Gestion distante des médias

**Statut : REPORTÉ APRÈS V1**

Pas d'interface dédiée pour l'instant. Les médias et JSON associés sont accessibles sur les Storage selon l'arborescence Session / Take définie ci-dessus.

## 12 — Capture-only / attente

**Statut : RETIRÉ DU PLAN V1**

Pas d'écran distinct : une Capture hors d'un Take reste simplement en attente. Les états actifs sont déjà couverts par les vues Capture des écrans 07 et 08.

## 13 — Storage-only

**Statut : RETIRÉ DU PLAN V1**

Pas d'écran distinct : la vue Storage persistante de `ui/07-countdown/storage.html` couvre le besoin Storage-only.

## 16 — Rejoindre par code / QR

**Statut : RETIRÉ DU PLAN V1**

Pas de QR ni de code de découverte en V1. Les devices s'annoncent et se découvrent sur le LAN via mDNS. Les Capture/Storage sont ajoutés par un Master. Le PIN à 4 chiffres de l'écran 02 reste le mécanisme d'autorisation permettant à un autre Controller de rejoindre une session comme Master.

---

# Ordre UI V1 final

```text
01 ✅
↓
02 ✅
↓
03 ✅
↓
05 ✅
↓
06 ✅
↓
07 ✅
↓
08 ✅
↓
09 ✅

Écrans transversaux :
14 ✅ Paramètres device
15 ✅ Historique / reprise de session

04 retiré → 14
10 retiré → vue Storage 07
11 reporté après V1
12 retiré → état d'attente existant
13 retiré → vue Storage 07
16 retiré → mDNS uniquement en V1
```

---

# Convention de suivi

- `✅ VALIDÉ` : HTML + README archivés dans le repo ;
- `🟠 BROUILLON` : une maquette existe mais doit être reprise/validée ;
- `⚪ À CONCEVOIR` : non travaillé ou pas suffisamment défini ;
- `RETIRÉ DU PLAN V1` : besoin déjà couvert par un autre écran ou volontairement exclu ;
- `REPORTÉ APRÈS V1` : fonctionnalité conservée comme piste mais hors périmètre courant.

Toute décision UI structurante doit être reportée ici pour permettre une reprise sans dépendre de l'historique ChatGPT.
