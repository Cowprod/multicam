# MultiCam — Plan de vol UI V1

**Dernière mise à jour : 16 septembre 2026**

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

## Prochaine étape immédiate

**Écran 06 — ARM / Contrôle de préparation.**

Une ancienne maquette existe dans `ui/06-arm/`, mais elle doit être reprise avant validation car elle suppose encore que tous les devices doivent être READY pour permettre le START, alors que l'architecture retient qu'une Capture en ERROR ne bloque pas nécessairement le START global.

---

# Décisions structurantes déjà validées

## 01 — Accueil / Découverte

- nom du device toujours visible ;
- affichage des skills supportées ;
- skill désactivée affichée en grisé ;
- modification des skills uniquement depuis Paramètres ;
- sans skill Controller/Master : masquer sessions disponibles et Nouvelle session ;
- avec skill Controller/Master : afficher sessions détectées + Nouvelle session ;
- action session : `Rejoindre` ;
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
- préparation du prochain Take depuis cet écran.

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

Audio :

- Activé / Désactivé.

GPS :

- Off / Éco / Normal / Précis.

Countdown :

- 0 / 3 / 5 / 10 s.

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
- appui sur l'icône = détail du fallback, ex. `Full HD indisponible → HD` ;
- afficher les warnings sur toutes les Captures, même non sélectionnées, afin d'aider au choix ;
- les warnings de liste comparent les capacités du device aux réglages globaux du Take, pas à ses overrides.

---

# Écrans à poursuivre

## 04 — Configuration détaillée d'un device

**Statut : ⚪ À CONCEVOIR / priorité secondaire**

Fonctions possibles :

- nom humain ;
- tags/fonctions ;
- volume de stockage local préféré ;
- paramètres locaux persistants ;
- autres réglages hors Take.

Ne pas y dupliquer les overrides de Take déjà gérés dans l'écran 05.

## 06 — ARM / Contrôle de préparation

**Statut : 🟠 BROUILLON À REPRENDRE**

Pour chaque Capture sélectionnée :

- `ARMING` ;
- `READY` ;
- `WARNING` ;
- `ERROR`.

Vérifications prévues :

- caméra ;
- micro si audio activé ;
- permissions ;
- stockage ;
- configuration applicable ;
- espace disponible.

Point à intégrer dans la prochaine maquette : une Capture en ERROR est clairement signalée mais ne bloque pas automatiquement le START global.

## 07 — Countdown / START synchronisé

**Statut : 🟠 BROUILLON À REPRENDRE**

- countdown visible sur Masters et Captures concernées ;
- instant absolu futur synchronisé ;
- correction par offsets d'horloge ;
- pas de beep/vibration par défaut.

## 08 — Live / Recording

**Statut : 🟠 BROUILLON À REPRENDRE**

Vue Master pendant REC :

- état global du Take ;
- timer ;
- mosaïque des Captures ;
- previews périodiques ;
- batterie / charge ;
- espace disponible ;
- alertes ;
- reconnexion ;
- STOP.

Pendant REC, pas de transfert média entrant/sortant sur un device qui enregistre ; previews, commandes, GPS et télémétrie continuent.

## 09 — STOP_PENDING

**Statut : ⚪ À CONCEVOIR**

- délai d'environ 10 s ;
- Annuler disponible aux Masters ;
- Forcer l'arrêt uniquement pour le Take Owner ;
- probablement modal/overlay plutôt qu'écran autonome.

## 10 — Take arrêté / traitements

**Statut : ⚪ À CONCEVOIR**

État `STOPPED` avant `COMPLETE` :

- hash SHA-256 ;
- transferts ;
- vérifications Storage ;
- files FIFO ;
- erreurs ;
- progression ;
- Take suivant disponible sans attendre COMPLETE.

## 11 — Gestion transferts / Storage

**Statut : ⚪ À CONCEVOIR**

- espace libre ;
- médias attendus ;
- taille + SHA-256 ;
- pending/error/success ;
- Storage disparu ;
- retrait explicite d'un Storage attendu après STOP ;
- pas de Storage -> Storage en V1.

## 12 — Gestion distante des médias

**Statut : ⚪ À CONCEVOIR**

- inventaire médias Captures/Storage ;
- état de réplication ;
- sélection multiple ;
- sélection d'un Take entier ;
- suppression distante avec confirmation.

## 13 — Capture-only / attente

**Statut : ⚪ À CONCEVOIR**

États : disponible, sélectionnée, ARMING/READY/WARNING/ERROR, countdown, RECORDING, STOPPED, offline/reconnexion.

## 14 — Storage-only

**Statut : ⚪ À CONCEVOIR**

Vue minimale : session, espace libre, file de transfert, activité, erreurs, état réseau.

## 15 — Paramètres du device

**Statut : ⚪ À CONCEVOIR**

- nom ;
- infos matériel/app ;
- skills supportées / activées ;
- stockage préféré ;
- diagnostics.

## 16 — Historique des sessions

**Statut : ⚪ À CONCEVOIR — priorité basse**

## 17 — Rejoindre par code / QR

**Statut : ⚪ À CONCEVOIR — fallback découverte LAN**

---

# Ordre de travail

```text
01 ✅
↓
02 ✅
↓
03 ✅
↓
05 ✅
↓
06 🟠  ← PROCHAINE ÉTAPE
↓
07 / 08
↓
09
↓
10
↓
11 / 12
```

Écrans secondaires ensuite : `04, 13, 14, 15, 16, 17`.

---

# Convention de suivi

- `✅ VALIDÉ` : HTML + README archivés dans le repo ;
- `🟠 BROUILLON` : une maquette existe mais doit être reprise/validée ;
- `⚪ À CONCEVOIR` : non travaillé ou pas suffisamment défini.

Toute décision UI structurante doit être reportée ici pour permettre une reprise sans dépendre de l'historique ChatGPT.
