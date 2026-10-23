# MultiCam — Proposition de périmètre J16

> ## ⚠️ ARBITRAGE PARTIEL — lot A autorisé, lots B→E non validés
> Ce document est une **proposition de travail**. Il ne décide pas seul du périmètre
> J16. **Le lot A a été arbitré puis implémenté et validé physiquement** (voir
> `docs/J16-A-RESULTS.md` et
> `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`) ; **les lots B à E ne sont
> pas validés** : aucune ligne de code ne doit être écrite sur la base de ce document
> sans validation explicite. J16 n'est **pas** une nouvelle campagne générale de
> corrections techniques.

**Date : 20 octobre 2026.** **Branche : `feat/j11-media-transfer`.**
**Inventaire de référence : `docs/INVENTAIRE-FONCTIONNEL-J16.md`.**

Principes de sélection retenus (issus de `docs/SUIVI-PROJET.md` et de la mission) :

1. Privilégier les améliorations **directement visibles et utiles à l'exploitation**.
2. **Préserver les acquis J15** ; ne pas refondre le transfert hors anomalie reproductible.
3. Petits lots fonctionnels cohérents, à critères d'acceptation observables.
4. Ne pas tranformer J16 en campagne technique générale.

Les lots sont présentés par ordre de valeur utilisateur décroissante. Le responsable
du projet peut n'en retenir qu'un seul, plusieurs, ou aucun.

---

## 8. Lot A — Consultation des Takes passés (écran 09 archivé + historique 15)

**Fonctionnalités incluses**
- U24 : rendre le mode archivé de l'écran 09 réellement exploitable (une ligne par
  Capture, durées, barres par Storage attendu, état Take).
- U25 : chaîne `Historique 15 → Session 03 → Take passé → 09` complète et fiable.
- Réconciliation de la source de vérité des `summary` archivés (voir inventaire §4.1).

**Bénéfice utilisateur**
Après tournage, l'opérateur peut **rouvrir et vérifier un Take terminé** (état des
réplications, durée, incidents) depuis la session ou l'historique. C'est aujourd'hui
la seule fonction visible proposée par les maquettes qui ne marche pas.

**Complexité estimée** : moyenne. Le bug est localisé (`take-stopped.js`), mais
l'alimentation correcte en mode archivé (correspondance `summary.transfers` ↔ lignes
par Capture) demande de fixer la source de vérité et un test dédié.

**Dépendances** : `js/state/transfer-boot.js` (`updateTakeFromTransfers`) comme source
des `summary` ; store session (`session-store.js`) ; écran 03 (`session.js`) et 15
(`history.js`).

**Critères d'acceptation (observables)**
- Ouvrir un Take terminé depuis 03 et depuis 15 affiche une carte par Capture avec
  leur état final et leurs barres Storage (100 % / Terminé), durée ≠ 00:00:00.
- Aucune régression du **mode live** de l'écran 09 (mode STOP courant).
- Test unitaire dédié au mode archivé ajouté (aujourd'hui inexistant).

**Risques pour l'existant** : faible. Le mode live ne doit pas être touché ; le risque
principal est de mal interpréter les `summary` archivés — d'où l'exigence de fixer la
source de vérité **avant** de corriger.

**Écart structurel associé à corriger si retenu** : déplacer `panel-history` et son
script à l'intérieur de `</html>` (`index.html:861-873`).

---

## 9. Lot B — Diagnostic device exportable (écran 14, décision §20)

**Fonctionnalités incluses**
- U26 : restauration d'une **capacité de diagnostic exportable/partageable** depuis
  les Paramètres (journal technique + identité + versions).
- Correction du compteur LAN mort (`home.js:153` / `#lanCount`) si jugé utile à 01.

**Bénéfice utilisateur**
Dépanner un téléphone caméra à distance, comparer des APK/diagnostics entre devices,
conserver la preuve brute exigée par la philosophie projet (§20, §21). Réintroduit une
capacité qui existe dans le lab mais pas dans `app/www`.

**Complexité estimée** : faible-moyenne. Un export JSON + feuille de partage
(`shareWithOptions`, validé en qualification) suffit ; pas de refonte d'architecture.

**Dépendances** : plugin de partage (retenu en qualification), données déjà
collectées par `js/native/device.js`, `config.js`, télémétrie.

**Critères d'acceptation**
- Bouton « Exporter/Partager le diagnostic » dans 14 générant un fichier lisible
  contenant identité, skills, versions, réseau, stockage, dernières erreurs.
- Le fichier est ouvrable/partageable sur device réel.

**Risques pour l'existant** : très faible (ajout isolé dans l'écran 14).

---

## 10. Lot C — Fonctions d'exploitation du tournage (GPS/GPX + orientation/maintien actif)

**Fonctionnalités incluses**
- U27 : acquisition GPS selon `gpsProfile` du Take (et sortie GPX si retenue).
- U28 : verrouillage d'orientation et maintien actif pendant REC (alignés décisions §13).

**Bénéfice utilisateur**
Tournage plus fiable (écran ne s'éteint pas, orientation stable) et rushes
géolocalisés — fonctions attendues par la décision projet mais non câblées.

**Complexité estimée** : moyenne. Chaque brique existe dans le lab ; l'intégration
au cycle de vie Take/REC et la persistance associée demandent du soin.

**Dépendances** : plugins orientation / insomnia / geolocation (à confirmer dans
`app/config.xml`), modèle de Take (`gpsProfile`), cycle REC (`camera-record.js`).

**Critères d'acceptation**
- Pendant REC, l'écran ne se verrouille pas et l'orientation reste celle du Take.
- Si GPS activé au Take, une trace est produite (ou l'absence est signalée proprement) ;
  si GPS `Off`, aucune acquisition.

**Risques pour l'existant** : modéré. **Cette fonctionnalité entre en concurrence
directe avec l'enregistrement local** (priorité §27). À aborder avec prudence et
mesures (batterie/CPU), idéalement en sous-étapes séparées (orientation/keep-awake
d'abord, GPS/GPX ensuite).

---

## 11. Lot D — Sélecteur SAF complet / stockage externe (écran 14)

**Fonctionnalités incluses**
- U29 : finaliser le choix d'emplacement SAF (SD externe) avec test d'écriture réel.

**Bénéfice utilisateur**
Utiliser une carte SD réelle comme destination Storage/Capture.

**Complexité estimée** : moyenne. Le cœur SAF est qualifié ; il manque la
finalisation du sélecteur et la revalidation sur microSD.

**Dépendances** : plugin SAF, écran 14, transfert/storage.

**Critères d'acceptation**
- Sélection d'un dossier SD, écriture + relecture vérifiées, persistance après restart.

**Risques pour l'existant** : faible, mais dépend de matériel (carte SD) pour la
preuve. Aujourd'hui **non validé** — à ne pas présenter comme acquis.

---

## 12. Lot E (optionnel) — Hygiène structurelle minimale

**Fonctionnalités incluses** (uniquement si le projet le souhaite, sans lien métier)
- `panel-history` dans le document normal ; suppression des ids DOM dupliqués.

**Bénéfice utilisateur** : indirect (robustesse). **Complexité** : faible.
**Risque** : faible. **À écarter si J16 doit rester strictement fonctionnel.**

---

## 13. Ce qui n'est PAS proposé pour J16

- Refonte du transfert / de la reprise automatique (acquis J15, hors anomalie reproductible).
- Nouvelle campagne technique générale de corrections.
- Clôture des réserves techniques J13/J15 restantes (SAF, multi-Storage, écriture
  Storage en erreur), qui relèvent d'une campagne de validation dédiée, pas de J16.
- Toute modification du socle validé sans rapport avec un lot retenu.

---

## 14. Rappel de gouvernance

- **Un seul lot à la fois**, dans l'ordre d'arbitrage retenu.
- Chaque lot retenu doit définir ses preuves device au sens du plan
  (`tests/e2e/validation/J16-<lot>/`), et ne pas rouvrir J15.
- **Le choix du (des) lot(s) appartient au responsable du projet.**

**PROPOSITION NON VALIDÉE — EN ATTENTE D'ARBITRAGE.**
