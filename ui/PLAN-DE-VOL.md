# MultiCam — Plan de vol UI V1

Ce document suit l'ordre proposé pour concevoir et valider les écrans de référence HTML de MultiCam.

Chaque écran validé doit produire :

- `index.html` : maquette visuelle de référence ;
- `README.md` : spécification UI + technique associée.

Le plan est volontairement séquentiel afin de valider les parcours avant d'attaquer les écrans plus complexes de captation.

---

## 01 — Accueil / Découverte des sessions

**Statut : VALIDÉ**

Dossier : `ui/01-session-discovery/`

Fonctions :

- nom du device local ;
- découverte des sessions LAN via mDNS/Bonjour ;
- rejoindre une session ;
- rejoindre par code / QR ;
- créer une nouvelle session ;
- accès secondaire à l'historique et aux paramètres du device.

---

## 02 — Entrer dans une session / Définir les rôles

**Statut : À CONCEVOIR**

Un seul écran doit pouvoir couvrir deux contextes :

### Création d'une session

- saisir/valider le nom de la session ;
- le device créateur est obligatoirement `Controller/Master` ;
- activer en plus `Capture` et/ou `Storage` si le device possède ces capabilities ;
- génération automatique du PIN Master 4 chiffres lors de la création.

### Rejoindre une session existante

- afficher le nom de la session ;
- choisir les rôles actifs du device parmi ses capabilities ;
- rôles possibles : `Capture`, `Storage`, `Controller/Master` ;
- si `Controller/Master` est demandé : saisie obligatoire du PIN 4 chiffres ;
- un device Capture-only ne s'ajoute pas automatiquement à un Take.

Objectif : distinguer clairement **capabilities matérielles** et **rôles actifs dans la session**.

---

## 03 — Session / Vue Master des devices

**Statut : À CONCEVOIR**

Écran principal d'une session lorsque le device est Master.

Fonctions prévues :

- liste des devices découverts/rejoints ;
- nom, rôles, état de connexion ;
- batterie + éclair si charge ;
- stockage libre ;
- éventuel niveau Wi-Fi si disponible ;
- erreurs/warnings visibles ;
- sélectionner les Captures qui participeront au prochain Take ;
- sélectionner les Storage attendus ;
- accès aux réglages du Take ;
- accès à la création/lancement du prochain Take.

Les devices Capture-only ne rejoignent jamais seuls un Take : le Master les sélectionne ici ou dans l'écran de préparation du Take.

---

## 04 — Configuration d'un device dans la session

**Statut : À CONCEVOIR**

Écran ou panneau d'édition d'un device hors REC.

Fonctions :

- nom humain du device ;
- rôle/fonction dans la session ;
- tags multiples (`gauche`, `guitare`, `plan serré`, etc.) ;
- overrides propres au device lorsque nécessaire ;
- choix du volume de stockage local si plusieurs volumes sont disponibles ;
- politique de conservation/suppression locale si override autorisé.

Pas de modification accessoire pendant un Take actif.

---

## 05 — Préparation / Réglages du Take

**Statut : À CONCEVOIR**

Configuration globale du prochain Take avec héritage du précédent.

Réglages V1 prévus :

- Captures participantes ;
- Storage attendus ;
- résolution `HD / Full HD / 4K` ;
- qualité `Éco / Normal / Haute` ;
- caméra avant/arrière ;
- audio ON/OFF ;
- orientation Paysage/Portrait ;
- GPS `Off / Éco / Normal / Précis` ;
- countdown ;
- transfert automatique ;
- suppression locale après réplication validée ;
- paramètres globaux de preview (fréquence + qualité) ;
- overrides par Capture lorsque prévus.

Valeurs par défaut actées :

- Full HD ;
- qualité Haute ;
- caméra arrière ;
- audio ON ;
- Paysage ;
- GPS Normal ;
- transfert automatique ON ;
- suppression automatique locale après transfert validé ON.

---

## 06 — ARM / Contrôle de préparation

**Statut : À CONCEVOIR**

Écran de validation juste avant START.

Pour chaque Capture sélectionnée :

- `ARMING` ;
- `READY` ;
- `WARNING` ;
- `ERROR`.

Vérifications :

- caméra ;
- micro si audio activé ;
- permissions ;
- stockage ;
- configuration applicable ;
- espace disponible.

Une Capture en ERROR est clairement signalée mais **ne bloque pas le START global**.

---

## 07 — Countdown / START synchronisé

**Statut : À CONCEVOIR**

État de transition avant REC.

Fonctions :

- countdown visible sur Masters et Captures concernées ;
- affichage du Take à démarrer ;
- synchronisation par instant absolu futur corrigé par offsets d'horloge ;
- pas de beep par défaut.

Peut être intégré visuellement à l'écran Live si cela simplifie le parcours.

---

## 08 — Live / Recording

**Statut : À CONCEVOIR — écran central du projet**

Vue Master pendant REC.

Fonctions :

- état global du Take ;
- timer ;
- mosaïque des Captures ;
- previews JPEG périodiques ;
- état de chaque Capture ;
- batterie + charge ;
- espace/durée estimée restante ;
- alertes visibles ;
- device déconnecté / reconnecté ;
- ajout/retrait d'une Capture pendant le Take ;
- ajout/retrait d'un Storage pendant le Take ;
- bouton STOP.

Pendant REC :

- aucun transfert média entrant/sortant sur un device qui enregistre ;
- previews, commandes, GPS et télémétrie continuent ;
- configuration accessoire verrouillée.

---

## 09 — STOP_PENDING

**Statut : À CONCEVOIR**

État de sécurité après demande de STOP.

Fonctions :

- compte à rebours d'environ 10 s ;
- `Annuler` disponible aux Masters ;
- `Forcer l'arrêt` uniquement pour le Take Owner ;
- à expiration : STOP propre des Captures encore actives.

Peut être une modal/overlay plutôt qu'un écran autonome.

---

## 10 — Take arrêté / Traitements en cours

**Statut : À CONCEVOIR**

État `STOPPED` avant `COMPLETE`.

Fonctions :

- hash SHA-256 ;
- transferts en attente/en cours ;
- vérifications Storage ;
- files FIFO ;
- Storage absent ;
- progression globale ;
- bouton `Take suivant` immédiatement disponible, même si le Take précédent n'est pas COMPLETE.

Un nouveau REC suspend les transferts/hash qui chargeraient une Capture active.

---

## 11 — Gestion des transferts / Storage

**Statut : À CONCEVOIR**

Vue détaillée des destinations Storage et de la réplication.

Fonctions :

- espace libre ;
- médias attendus ;
- état taille + SHA-256 ;
- pending/error/success ;
- Storage disparu ;
- retrait explicite d'un Storage attendu après STOP pour débloquer la réplication ;
- aucun ajout de nouveau Storage après STOP ;
- pas de transfert Storage -> Storage en V1.

---

## 12 — Gestion distante des médias

**Statut : À CONCEVOIR**

Fonctions Master :

- lister les médias présents sur Captures/Storage ;
- état de réplication ;
- sélection multiple ;
- sélectionner un Take entier ;
- suppression distante avec confirmation explicite.

Pas de suppression automatique sur les Storage.

---

## 13 — Écran Capture-only / Attente

**Statut : À CONCEVOIR**

Vue d'une tablette participant à une session sans rôle Master.

États possibles :

- disponible dans la session ;
- sélectionnée pour prochain Take ;
- ARMING/READY/WARNING/ERROR ;
- countdown ;
- RECORDING ;
- STOPPED ;
- offline/reconnexion.

Pendant REC :

- écran maintenu actif ;
- luminosité réduite automatiquement ;
- orientation verrouillée ;
- sortie volontaire de l'app bloquée autant que possible.

Si tous les Masters disparaissent pendant un Take, un STOP local d'urgence doit devenir accessible.

---

## 14 — Storage-only / État du stockage

**Statut : À CONCEVOIR**

Vue minimale pour un faux client Storage (Raspberry, PC ou tablette).

Fonctions :

- session ;
- espace libre ;
- files de transfert ;
- activité ;
- erreurs ;
- état réseau.

Le client Storage peut être headless à terme ; cette UI sert surtout aux implémentations avec écran.

---

## 15 — Paramètres du device

**Statut : À CONCEVOIR**

Accessible depuis le menu de l'écran 01.

Fonctions prévues :

- nom du device ;
- informations matériel/app ;
- capabilities détectées ;
- volume de stockage préféré ;
- paramètres locaux autorisés hors session ;
- diagnostics utiles.

Le `deviceId` reste généré automatiquement et persistant.

---

## 16 — Historique des sessions

**Statut : À CONCEVOIR — priorité basse V1**

Accessible depuis le menu de l'accueil.

L'historique ne doit pas encombrer l'accueil principal.

Fonctions potentielles :

- sessions connues ;
- ouvertes/clôturées ;
- consultation de métadonnées ;
- réouverture éventuelle d'une session clôturée avec génération d'un nouveau PIN.

Pas d'historique local sophistiqué des médias en V1.

---

## 17 — Rejoindre par code / QR

**Statut : À CONCEVOIR**

Fallback à mDNS/Bonjour.

Fonctions :

- scanner un QR ;
- saisir un code/identifiant de session ;
- résolution vers la session LAN ;
- passage ensuite vers l'écran 02 de choix des rôles.

---

# Ordre de travail recommandé

Pour conserver un parcours cohérent, l'ordre actuel est :

`01 -> 02 -> 03 -> 05 -> 06 -> 07/08 -> 09 -> 10 -> 11/12`

Puis compléter les vues spécialisées :

`04, 13, 14, 15, 16, 17`.

Cet ordre peut évoluer au fil des validations UI. Toute modification structurante doit être reportée dans ce fichier.
