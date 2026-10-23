# MultiCam — Inventaire fonctionnel (préparation J16)

**État : inventaire d'analyse — le lot A a été arbitré puis implémenté (J16-A) ; les lots B→E ne sont pas validés.**
**Mise à jour 2026-10-22 : le lot A (U24/U25) a été ARBITRÉ puis IMPLÉMENTÉ (validation physique PASS 13/13) — voir `docs/J16-A-RESULTS.md`. Les constats de cet inventaire sont conservés tels quels (ils décrivent l'état AVANT J16-A) ; le statut de U24/U25 est mis à jour au §3.A.**
**Date : 20 octobre 2026.** **Branche : `feat/j11-media-transfer`.**
**Base documentaire : `bed269e`.** **Base code observée : HEAD `feat/j11-media-transfer`.**

Ce document dresse l'inventaire des fonctionnalités MultiCam en confrontant **les
spécifications validées (`ui/`, `docs/`, décisions)** au **code réellement présent
dans `app/www/`**. Il prépare l'arbitrage du périmètre J16 ; il ne décide rien à la
place du responsable du projet et n'autorise aucun développement.

Documents de référence non dupliqués ici : `MULTICAM_DECISIONS_REFERENCE.md`,
`docs/SKILLS-AND-ROLES.md`, `docs/PLAN-DEVELOPPEMENT-V1.md`,
`docs/QUALIFICATION-TECHNIQUE-V1.md`, `docs/SUIVI-PROJET.md`, les `README` de `ui/`.
La proposition de périmètre J16 est un document distinct : `docs/PROPOSITION-PERIMETRE-J16.md`.

---

## 1. Méthode

1. Synchronisation sur la branche et le commit documentaire attendus.
2. Lecture de la documentation de suivi, du plan, des décisions et des rapports de campagne.
3. Revue de chaque maquette `ui/NN-*` (README + HTML) et de chaque module de `app/www/js/`.
4. Confrontation ligne à ligne : une fonctionnalité « spécifiée » n'est marquée
   **implémentée** que si un module réel la porte, **partielle** si le code la traite
   incomplètement, **absente** si aucun code ne la traite.

Statut attendu par fonctionnalité : `implémentée` / `partielle` / `absente` / `à clarifier`.

---

## 2. Synthèse globale

L'application réelle `app/www/` couvre fonctionnellement l'essentiel des jalons
J02→J15 : découverte mDNS, sessions multi-Master, membres/rôles, Take et réglages,
ARM distribué + synchronisation d'horloge, countdown/START synchronisé, previews
PixelCopy, mosaïque régie, bascule caméra, STOP coordonné, transfert storage avec
reprise automatique J15. Le socle fonctionnel de la V1 est donc en place.

Trois catégories ressortent :

- **Socle fonctionnel solide et validé** (J03–J11, J15) — à préserver, ne pas refondre.
- **Fonctionnalités métier spécifiées mais non abouties côté utilisateur** :
  principalement l'**historique / consultation des Takes passés (écran 09 archivé,
  écran 15)** — le seul manque utilisateur réellement visible.
- **Fonctionnalités transverses prévues par les décisions mais absentes du code**
  (export de diagnostic, GPS/GPX, orientation verrouillée, wake-lock explicite,
  sélecteur SAF complet), à traiter hors du cœur métier.

Écarts structurels mineurs confirmés dans le code (§4) : panneau `history` placé
après `</html>`, compteur LAN jamais affiché (`lanCount` inexistant), identifiants
DOM dupliqués.

---

## 3. Inventaire fonctionnel

### 3.A — Fonctionnalités utilisateur

| # | Fonctionnalité | Objectif utilisateur | Écran / parcours | Statut | Références code / spec | Dépendances | Priorité proposée |
|---|---|---|---|---|---|---|---|
| U01 | Accueil / identité / skills locales | Voir son device et ses skills, entrer en session | 01 (`ui/01-session-discovery`) | implémentée | `js/ui/home.js`, `js/state/config.js`, `js/native/device.js` ; spec `ui/01/README.md` | — | — |
| U02 | Découverte LAN (mDNS) des devices et sessions | Voir les pairs/sessions sans saisir d'IP | 01 | implémentée | `js/net/discovery.js`, `js/net/session-discovery.js` ; J03 PASS | plugin NSD | — |
| U03 | Création de session (PIN Master auto) | Créer et piloter une session | 02 (`ui/02`) | implémentée | `js/ui/session-create.js`, `js/state/session-model.js` ; J04 PASS | — | — |
| U04 | Rejoindre une session (saisie PIN 4 chiffres) | Devenir second Master | 02 | implémentée | `js/ui/session-create.js` ; J04 PASS | WS | — |
| U05 | Vue Master : membres, rôles, PIN visible | Administrer les participants | 03 (`ui/03`) | implémentée | `js/ui/session.js`, `js/state/session-model.js` ; J05 PASS | — | — |
| U06 | Ajout / modification / retrait d'un device (modal rôles annoncés) | Intégrer une Capture ou un Storage | 03 | implémentée | `js/ui/session.js` ; décisions §31 ; J05 PASS | skills annoncées | — |
| U07 | Reprise d'une session depuis l'accueil (4 récentes) | Rouvrir une session connue | 01 → 03 | implémentée | `js/ui/home.js`, `js/state/session-store.js` ; J12 PASS | persistance | — |
| U08 | Préparation du Take (sélections, réglages, overrides, héritage) | Cadrer le tournage avant ARM | 05 (`ui/05`) | implémentée | `js/ui/take.js`, `js/state/take-model.js` ; J06 PASS | capacités natives | — |
| U09 | Warnings de compatibilité / best effort par Capture | Comprendre les capacités réelles | 05 | implémentée | `js/state/take-model.js` (ladders, warnings), `js/native/capture-capabilities.js` ; J06 PASS | spec §32 | — |
| U10 | ARM automatique + états READY/WARNING/ERROR | Vérifier les préconditions avant REC | 06 (`ui/06`) | implémentée | `js/state/arm-model.js`, `js/state/arm-service.js`, `js/ui/arm.js` ; J07 PASS | WS, clock sync | — |
| U11 | Synchronisation d'horloge / confirmation des incidents | Cadrer le top synchronisé | 06 | implémentée | `arm-model.js` (offsets RTT/dispersion), modal incidents | WS | — |
| U12 | Countdown synchronisé (top absolu, Master/Capture/Storage) | Démarrer au même instant | 07 (`ui/07`) | implémentée | `js/state/start-model.js`, `js/ui/countdown.js` ; J08 PASS | clock offsets | — |
| U13 | Annulation globale du countdown par un Master | Interrompre avant le top | 07 | implémentée | `start-model.js` `cancel`/`abortPlan` ; J08 PASS | — | — |
| U14 | REC multicam + timer global | Enregistrer plusieurs caméras | 08 (`ui/08`) | implémentée | `js/native/camera-record.js`, `start-service.js` ; J09 PASS | caméra | — |
| U15 | Mosaïque previews ~1 fps (PixelCopy) | Contrôler les cadrages en direct | 08 | implémentée | `js/state/preview-*.js`, `js/native/pixelcopy.js` ; J09 PASS | patch PixelCopy | — |
| U16 | Modal détail Capture (incidents, skills, batterie) | Diagnostiquer une vignette | 08 | implémentée | `js/ui/live-detail.js` ; J09 PASS | télémétrie | — |
| U17 | Bascule de caméra pendant REC (segmentée) | Changer de cadrage sans couper le Take | 08 | implémentée | `js/state/camera-switch-*.js` ; J09-07/08 PASS | caméra | — |
| U18 | Télémétrie / supervision (batterie, espace, réseau) | Surveiller l'état des devices | 08 / 05 | implémentée | `js/state/telemetry-*.js` ; J09-06 PASS | WS | — |
| U19 | STOP global coordonné + écran Take arrêté (live) | Clore le Take proprement | 08 → 09 (`ui/08`, `ui/09`) | implémentée | `js/state/start-model.js` (`requestStop`), `js/ui/take-stopped.js` ; J10 exercé en J11/J15 | — | — |
| U20 | STOP local d'urgence sans Master | Arrêter une Capture isolée | 07/08 | implémentée | `start-model.js` `stopLocal` ; J07/J08 PASS | — | — |
| U21 | Suivi de transfert par Capture/Storage (barres, %, Réessayer) | Vérifier la réplication | 09 | implémentée | `js/ui/take-stopped.js` (`barsOf`, retry) ; J11 PASS | transfert | — |
| U22 | Vue Storage multi-sessions / multi-Takes | Superviser un Storage partagé | 07 (storage) | implémentée | `js/ui/storage-view.js`, `storage-view-model.js` ; J11 PASS | transfert | — |
| U23 | Reprise automatique des transferts (attente réseau) | Ne jamais perdre un média | 09 / Storage | implémentée | `js/state/transfer-journal.js`, `transfer-boot.js` (ResumeCoordinator) ; **J15 PASS** | réseau | — |
| U24 | **Consultation d'un Take passé depuis la Session / l'historique** | **Revoir un Take terminé** | 03 → 09 (archivé) ; 15 (`ui/15`) | **implémentée (J16-A, 2026-10-21)** — *état avant J16-A : partielle (cassée)* | **J16-A** : `js/state/take-archive-model.js` (reconstruction pure), `js/ui/take-stopped.js` (`archivedView`, `renderArchived`, `renderFromStore`), faits persistés `summary.stopStates` / `summary.replications` ; 29 tests `app/tests/j16-take-archive.test.js` ; rapport `docs/J16-A-RESULTS.md` | store session | **haute** |
| U25 | Historique des sessions (écran 15) | Retrouver une session | 15 (`ui/15`) | **implémentée (J16-A)** — *état avant J16-A : partielle* | `js/ui/history.js` (liste OK) ; **panneau replacé dans `</html>`** (J16-A) ; la consultation des Takes dépend désormais de U24, traitée | U24 | **haute** |
| U26 | Diagnostic device / export / partage | Dépanner à distance | 14 (`ui/14`, décisions §20) | partielle | `js/ui/settings.js` (permissions/switchToSettings OK) ; **pas d'export/partage** dans `app/www` | plugin sharing | moyenne |
| U27 | GPS / GPX (capture pendant le tournage) | Géolocaliser les rushes | décision §11 | **absente (UI seule)** | réglage Take `gpsProfile` et affichage capacités présents ; **aucun `geolocation`/GPX** dans `app/www/js` | plugin geolocation | moyenne |
| U28 | Orientation verrouillée / maintien actif pendant REC | Fiabiliser le tournage | décision §13 | **absente** | aucun `screen.orientation`/`insomnia`/`keepAwake` ; caméra native seulement | plugins orientation/insomnia | moyenne |
| U29 | Sélecteur SAF complet (SD) | Choisir un stockage externe | 14 | partielle | `js/native/saf.js` (`chooseDirectory`) ; `js/ui/settings.js` (`storage.mode==="saf"`) ; microSD non revalidée (qualif.) | SAF | basse |

### 3.B — Composants purement techniques (hors périmètre utilisateur direct)

| # | Composant | Rôle | Statut | Références |
|---|---|---|---|---|
| T01 | Boot / config / identité persistante | Source de vérité locale, `deviceId` immuable | implémenté | `js/main.js`, `js/state/config.js` |
| T02 | WebSocket de session (multi-Master, fusion, reconnexion) | Transport de tous les messages distribués | implémenté | `js/net/session-ws.js` |
| T03 | Modèle de Take versionné | Réglages/overrides/summary | implémenté | `js/state/take-model.js` |
| T04 | Capacités natives Capture (cache, hook DEBUG) | Alimenter best-effort | implémenté | `js/native/capture-capabilities.js` |
| T05 | Modèle ARM + éligibilité REC | Décisions ARM/incidents | implémenté | `js/state/arm-model.js` |
| T06 | Modèle/Service START + plan | Top synchronisé, exclusion/réintégration | implémenté | `js/state/start-model.js`, `start-service.js` |
| T07 | Pipeline preview (sampler/transport/inbox) | ~1 fps, latest-wins | implémenté | `js/state/preview-*.js` |
| T08 | Modèle de bascule caméra (segments) | Segmentation pendant REC | implémenté | `js/state/camera-switch-*.js` |
| T09 | Modèle/Service de transfert (Range, SHA-256, journal) | Réplication vérifiée, reprise J15 | implémenté | `js/state/transfer-*.js`, `js/native/transfer.js` |
| T10 | Journal de transfert (durabilité) | Reprise après crash | implémenté | `js/state/transfer-journal.js` |
| T11 | Ponts natifs (device, platform, storage, SAF, httpd) | Accès Android réel | implémenté | `js/native/*` |
| T12 | Tests unitaires `app/tests/` (~34 fichiers, hors archivage 09) | Garde-fous non-régression | implémenté | `app/tests/` |

**Note** : plusieurs composants techniques vérifiés comme *testés dans le code mais pas
dans le périmètre de la campagne J15* (multi-Storage/file pleine, capture hors ligne,
SAF) restent des réserves de suivi — voir `docs/SUIVI-PROJET.md`.

---

## 4. Écarts entre spécifications et implémentation

### 4.1 Écarts utilisateur visibles

> **État au 2026-10-21 :** les écarts **1**, **2** et **4** ont été **corrigés par
> J16-A** (voir `docs/J16-A-RESULTS.md` §5). Les constats ci-dessous sont
> conservés : ils décrivent l'état **avant** J16-A. L'écart **3** reste ouvert.

1. **Écran 09 mode archivé inutilisable (U24)** — localisé précisément :
   `take-stopped.js:386-392` construit `vstart = { …, active:false, … }` puis
   `render(vstart)` ; or `rowsOf()` (`:149`) retourne `[]` dès que `!v.active`.
   Résultat : **aucune ligne Capture, durée « 00:00:00 »** pour tout Take ouvert
   depuis l'historique (`session.js:228` → `take-stopped` `{ archived:'1' }`).
   Aucun test ne couvre ce mode (`app/tests/` : `j11-take-stopped-*` portent sur
   le mode live) — c'est **le seul vrai manque fonctionnel visible**.
   *À clarifier* : les `stopStates` archivés (`t.summary.transfers`) sont keyés par
   *storage*, alors que `rowsOf` attend un état par *deviceId de Capture* ; le mode
   archivé exige donc une table de correspondance, pas seulement `active:true`.
   Ne pas « corriger » à l'aveugle : faire valider la source de vérité archivée.

2. **Écran 15 / historique (U25)** — la route et la liste des sessions fonctionnent,
   mais la consultation des Takes dépend du point (1). De plus, la section
   `<section id="panel-history">` et son `<script src="ui/history.js">` sont placés
   **après `</html>`** (`index.html:861-873`) : toléré par le navigateur, mais
   fragile et non conforme.

3. **Compteur LAN jamais affiché** — `home.js:153` (`setLanCount`) écrit dans
   `#lanCount`, **id inexistant** dans `index.html` (seul `#devicesCount` existe).
   Code mort non bloquant, mais la maquette 01 prévoit cette information.

4. **Identifiants DOM dupliqués** — `nextTakeCard` et `sessionName` existent à la
   fois dans `panel-session` et `panel-create` ; `getElementById` ne retourne que
   le premier. Risque d'effets croisés entre écrans.

### 4.2 Écarts documentaires de suivi

5. **`docs/AVANCEMENT-V1.md` est en retard** sur `docs/SUIVI-PROJET.md` : il indique
   J12/J13/J14 « en attente », alors que :
   - **J12** : `tests/e2e/validation/J12-historique-persistance/VALIDATION.md` =
     **PASS (audit indépendant, 2026-10-13)** ;
   - **J13** : `tests/e2e/validation/J13-scenarios-panne/VALIDATION.md` =
     **CLÔTURÉ AVEC RÉSERVES** (05 et 09 = PARTIAL, réserves à lever avant production) ;
   - **J14** : campagnes `J14-B01/B02/B03/C01/C02` + `J14-endurance` — verdict
     d'endurance **PARTIAL** ; correctifs D1/D2/D3 validés (C01/C02) ;
   - **J15** : implémentation + validation physique **PASS** (voir `SUIVI-PROJET.md`).
   Ce tableau doit être réconcilié (proposé en §6), sans réécrire l'historique.

6. **Docs non présents localement** — la note `SUIVI-PROJET.md` fait référence à
   `tests/e2e/validation/J15/*` (présents) mais plusieurs jeux de preuves J14
   volumineux sont **non suivis** en git (working tree). Ce n'est pas un écart
   produit ; à signaler pour ne pas les perdre.

### 4.3 Réserves techniques déjà documentées (rappel, non réouvertes ici)

- Restauration Storage hors ligne (vue vide avant reconnexion, journal réappliqué).
- Synchronisation horloges ~280 ms en J15 (WARNING non bloquant).
- ARM Storage hors ligne : `storage=ERROR` mais `recEligible=true` (à clarifier
  fonctionnellement — relève d'une décision, pas d'un correctif technique).
- SAF / multi-Storage / file pleine / capture hors ligne : non exercés physiquement.

---

## 5. Fonctionnalités non développées ou signalées dans les rapports

- **U24/U25** — archivage Take + historique : **traités par J16-A** (2026-10-21) —
  seul manque utilisateur franc, désormais levé ; rapport `docs/J16-A-RESULTS.md`.
  **Validation physique : PASS (13/13)** — campagne sur 3 appareils Android réels
  (`tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`), 2026-10-22.
- **U26** — export/partage de diagnostic (décision §20 : « supprimer toute capacité
  de diagnostic serait une régression ») : présent dans le POC, absent de `app/www`.
- **U27** — GPS/GPX (§11) : réglage et capacités exposés, **aucune acquisition**.
- **U28** — orientation verrouillée / maintien actif (§13) : non câblé.
- **ARM Storage hors ligne** (`SUIVI-PROJET.md`) : comportement à clarifier.
- **Réserves J13** 05 (erreur d'écriture Storage) et 09 (interruption/reprise de
  transfert) : depuis **couverte par J15** pour la reprise ; la réserve « erreur
  d'écriture Storage » reste ouverte.

---

## 6. Note de réconciliation proposée pour `docs/AVANCEMENT-V1.md`

> **Appliquée le 2026-10-21** (J16-A) : le tableau de `docs/AVANCEMENT-V1.md` a été
> réconcilié avec les sources ci-dessous, sans réécrire l'historique. La ligne J16-A
> a été ajoutée.

| Jalon | Statut réel (source) |
|---|---|
| J12 | PASS — `J12-historique-persistance/VALIDATION.md` (audit 2026-10-13) |
| J13 | Clôturé avec réserves — 8 PASS / 2 PARTIAL (05, 09) |
| J14 | Endurance PARTIAL ; correctifs D1/D2/D3 validés (C01/C02) |
| J15 | PASS (implémentation + physique) — voir `SUIVI-PROJET.md` |
| J16 | Lot A (U24/U25) implémenté + **validation physique PASS (13/13)** ; lots B→E non commencés |

---

## 7. Conclusion de l'inventaire

Le socle fonctionnel MultiCam (J03→J11, J15) est implémenté et validé. Le principal
écart *utilisateur* spec ↔ code est la **consultation des Takes passés (écran 09
archivé / écran 15)**, complété par des **éléments transverses différés** (diagnostic
exportable, GPS/GPX, orientation/wake-lock, SAF complet). Trois anomalies structurelles
mineures sans impact métier sont confirmées.

Le périmètre J16 est détaillé dans `docs/PROPOSITION-PERIMETRE-J16.md` — **le lot A
a été arbitré puis implémenté (J16-A, validé physiquement le 2026-10-22) ; les lots
B→E restent à arbitrer**.
