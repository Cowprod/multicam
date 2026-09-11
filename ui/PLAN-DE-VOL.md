# MultiCam — Plan de vol UI V1

**Dernière mise à jour : 11 septembre 2026**

Ce document sert de point de reprise après interruption. Il indique ce qui est validé, ce qui est en cours et l’ordre de conception restant.

Chaque écran validé doit produire :

- `index.html` : maquette visuelle de référence ;
- `README.md` : spécification UI + technique associée.

---

# État global du projet

## Architecture / règles métier

La phase de conception fonctionnelle est largement avancée : rôles `Controller/Master`, `Capture`, `Storage`, sessions, Takes, ARM, START synchronisé, STOP_PENDING, recovery, stockage, transferts, SHA-256, réplication, suppression, GPS, télémétrie et manifests JSON ont déjà été définis.

## Qualification technique Cordova

Les tests mono-device ont permis de valider une grande partie de la pile :

- permissions Android ;
- batterie ;
- Insomnia ;
- GPS ;
- File ;
- orientation ;
- luminosité ;
- mDNS/Bonjour ;
- Camera Preview ;
- REC vidéo via `cordova-plugin-camera-preview` master GitHub avec permissions Android 13 corrigées ;
- snapshot hors REC.

Point caméra particulier déjà identifié : `takeSnapshot()` n’est pas exploitable pendant REC sur le Samsung de test ; une piste native de capture de preview type PixelCopy a été travaillée dans le lab de référence.

## UI

- **Écran 01 : VALIDÉ et archivé dans le repo.**
- **Écran 02 : BROUILLON VISUEL DÉFINI, mais pas encore validé ni archivé.**
- Tous les autres écrans restent à concevoir.

### Prochaine étape immédiate

**Reprendre l’écran 02 — Entrer dans une session / définir les rôles**, ajuster la maquette, la valider, puis créer :

```text
ui/02-session-roles/
├── index.html
└── README.md
```

---

# Écrans

## 01 — Accueil / Découverte des sessions

**Statut : ✅ VALIDÉ**

Dossier : `ui/01-session-discovery/`

Fonctions :

- nom du device local ;
- découverte des sessions LAN via mDNS/Bonjour ;
- rejoindre une session ;
- rejoindre par code / QR ;
- créer une nouvelle session ;
- accès secondaire à l'historique et aux paramètres du device.

Décision UI importante : l’accueil reste volontairement léger ; les anciennes sessions ne sont pas affichées directement sur l’écran principal.

---

## 02 — Entrer dans une session / Définir les rôles

**Statut : 🟠 BROUILLON À REPRENDRE / VALIDER**

Une première maquette a été définie mais n’a pas été validée définitivement.

Un seul écran doit couvrir deux contextes.

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

### Brouillon UI déjà proposé

- trois cards/choix : `Controller/Master`, `Capture`, `Storage` ;
- en création : Master coché et imposé ;
- Capture cochée par défaut ;
- Storage optionnel ;
- en mode rejoindre : Master facultatif ;
- champ PIN visible uniquement si Master est demandé.

**À faire maintenant : reprendre cette maquette et décider si cette représentation des rôles est validée.**

---

## 03 — Session / Vue Master des devices

**Statut : ⚪ À CONCEVOIR**

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

**Statut : ⚪ À CONCEVOIR**

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

**Statut : ⚪ À CONCEVOIR**

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
- paramètres globaux de preview ;
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

**Statut : ⚪ À CONCEVOIR**

Écran de validation juste avant START.

Pour chaque Capture sélectionnée :

- `ARMING` ;
- `READY` ;
- `WARNING` ;
- `ERROR`.

Vérifications : caméra, micro si audio activé, permissions, stockage, configuration applicable et espace disponible.

Une Capture en ERROR est clairement signalée mais **ne bloque pas le START global**.

---

## 07 — Countdown / START synchronisé

**Statut : ⚪ À CONCEVOIR**

- countdown visible sur Masters et Captures concernées ;
- affichage du Take à démarrer ;
- synchronisation par instant absolu futur corrigé par offsets d'horloge ;
- pas de beep par défaut.

Peut être intégré visuellement à l'écran Live si cela simplifie le parcours.

---

## 08 — Live / Recording

**Statut : ⚪ À CONCEVOIR — écran central du projet**

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

Pendant REC : aucun transfert média entrant/sortant sur un device qui enregistre ; previews, commandes, GPS et télémétrie continuent.

---

## 09 — STOP_PENDING

**Statut : ⚪ À CONCEVOIR**

- compte à rebours d'environ 10 s ;
- `Annuler` disponible aux Masters ;
- `Forcer l'arrêt` uniquement pour le Take Owner ;
- à expiration : STOP propre des Captures encore actives.

Probablement modal/overlay plutôt qu'écran autonome.

---

## 10 — Take arrêté / Traitements en cours

**Statut : ⚪ À CONCEVOIR**

État `STOPPED` avant `COMPLETE` :

- hash SHA-256 ;
- transferts en attente/en cours ;
- vérifications Storage ;
- files FIFO ;
- Storage absent ;
- progression globale ;
- bouton `Take suivant` immédiatement disponible.

Un nouveau REC suspend les transferts/hash qui chargeraient une Capture active.

---

## 11 — Gestion des transferts / Storage

**Statut : ⚪ À CONCEVOIR**

- espace libre ;
- médias attendus ;
- état taille + SHA-256 ;
- pending/error/success ;
- Storage disparu ;
- retrait explicite d'un Storage attendu après STOP ;
- aucun ajout de nouveau Storage après STOP ;
- pas de transfert Storage -> Storage en V1.

---

## 12 — Gestion distante des médias

**Statut : ⚪ À CONCEVOIR**

- lister les médias présents sur Captures/Storage ;
- état de réplication ;
- sélection multiple ;
- sélectionner un Take entier ;
- suppression distante avec confirmation explicite.

Pas de suppression automatique sur les Storage.

---

## 13 — Écran Capture-only / Attente

**Statut : ⚪ À CONCEVOIR**

États : disponible, sélectionnée, ARMING/READY/WARNING/ERROR, countdown, RECORDING, STOPPED, offline/reconnexion.

Pendant REC : écran maintenu actif, luminosité réduite, orientation verrouillée, sortie volontaire bloquée autant que possible.

Si tous les Masters disparaissent pendant un Take, STOP local d'urgence accessible.

---

## 14 — Storage-only / État du stockage

**Statut : ⚪ À CONCEVOIR**

Vue minimale : session, espace libre, files de transfert, activité, erreurs et état réseau.

---

## 15 — Paramètres du device

**Statut : ⚪ À CONCEVOIR**

- nom du device ;
- informations matériel/app ;
- capabilities détectées ;
- volume de stockage préféré ;
- paramètres locaux autorisés hors session ;
- diagnostics utiles.

Le `deviceId` reste généré automatiquement et persistant.

---

## 16 — Historique des sessions

**Statut : ⚪ À CONCEVOIR — priorité basse V1**

Accessible depuis le menu de l'accueil. L'historique ne doit pas encombrer l'accueil principal.

---

## 17 — Rejoindre par code / QR

**Statut : ⚪ À CONCEVOIR**

Fallback à mDNS/Bonjour : scanner un QR ou saisir un code/identifiant puis passer vers l'écran 02 de choix des rôles.

---

# Ordre de travail

## Séquence principale

```text
01 ✅
↓
02 🟠  ← NOUS SOMMES ICI
↓
03
↓
05
↓
06
↓
07 / 08
↓
09
↓
10
↓
11 / 12
```

## Écrans spécialisés à compléter ensuite

```text
04, 13, 14, 15, 16, 17
```

---

# Convention de suivi

- `✅ VALIDÉ` : HTML + README archivés dans le repo.
- `🟠 BROUILLON` : maquette discutée mais pas encore validée.
- `⚪ À CONCEVOIR` : pas encore travaillé.

Toute décision UI structurante ou changement d'ordre doit être reporté ici afin de pouvoir reprendre le projet sans dépendre de l'historique ChatGPT.
