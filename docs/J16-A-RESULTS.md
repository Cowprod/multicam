# MultiCam — J16-A — Consultation des Takes passés (mode archivé de l'écran 09)

**État : implémentation terminée, tests automatisés verts, validation physique PASS (13/13).**
**Date : 22 octobre 2026.** **Branche : `feat/j11-media-transfer`.**
**Base documentaire : `71e64eb` (inventaire fonctionnel J16 + proposition de périmètre).**
**Preuves physiques : `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`.**

Ce document rend compte de l'implémentation du **lot A du périmètre J16**, tel
qu'arbitré : la consultation fonctionnelle des **Takes précédents**, depuis
l'écran de session (03) et depuis l'historique (15), via le **mode archivé** de
l'écran 09.

Documents de référence : `docs/INVENTAIRE-FONCTIONNEL-J16.md` (écarts constatés,
U24/U25), `docs/PROPOSITION-PERIMETRE-J16.md` (lots A→E), `docs/SUIVI-PROJET.md`
(bilan J15), `MULTICAM_DECISIONS_REFERENCE.md`.

---

## 1. Périmètre réellement traité

| Inclus | Exclu (non commencé) |
|---|---|
| Reconstruction des faits archivés d'un Take (module pur) | J16-B : export / partage du diagnostic |
| Mode archivé de l'écran 09 (affichage) | J16-C : GPS/GPX, orientation verrouillée, wake-lock |
| Persistance des faits d'arrêt **par Capture** | J16-D : sélecteur SAF complet |
| Persistance de l'état de réplication **par couple** Capture → Storage | J16-E : hygiène optionnelle |
| Lecture des **Takes anciens** (rétrocompatibilité) | Refonte du protocole de transfert J15 |
| Corrections structurelles associées (voir §5) | Suppression des sources, reprise J15 : **inchangés** |

**Aucune modification du protocole de transfert**, de la suppression des sources
après réplication vérifiée, ni de la reprise automatique J15. Le mode **direct**
(live) de l'écran 09 est inchangé : c'est un critère de non-régression vérifié par
test.

---

## 2. Le problème constaté (rappel de l'inventaire)

L'écran 09 (« Take arrêté ») affiche **en direct** la vue du service START
(`stopStates`, plan) et la vue du service de transfert (barres par Storage).
Ces trois sources sont **volatiles** : à l'arrêt d'un Take, plus rien n'est
vivant. Un Take ouvert depuis l'historique ou la session n'avait donc, avant
J16-A, **aucune donnée à afficher** — écran vide, durée « 00:00:00 ».

Pire : la seule information persistée, `take.summary.transfers`, mélangeait
deux sémantiques :

- des **entrées d'arrêt par Capture** (`state: "STOPPED"`) écrites par le
  service START ;
- un **état global de transfert** (`transferState`) agrégé, écrit par le boot
  du transfert.

Un état global ne prouve **rien** sur un couple Capture → Storage particulier :
« transfert terminé » ne veut pas dire « *cette* Capture a été répliquée vers
*ce* Storage ». C'est la règle structurante de J16-A.

---

## 3. Ce qui a été construit

### 3.1 Deux faits persistés, additifs et rétrocompatibles

Dans `take.summary` (objet `session.json`), deux champs **facultatifs** ont été
ajoutés, vides par défaut, jamais destructeurs :

| Champ | Clé | Sens | Écrit par |
|---|---|---|---|
| `stopStates` | `deviceId` Capture | fait d'arrêt d'une Capture (état, écart d'horloge, chemin) | `state/start-service.js` |
| `replications` | `src\|storage` | état de réplication d'un **couple** Capture → Storage | `state/transfer-boot.js` |

Règles de persistance appliquées :

- **Jamais d'écrasement croisé** : l'écriture de l'arrêt ne touche pas aux
  réplications, la fin des transferts ne touche pas aux faits d'arrêt.
- **Écriture bornée** : la persistance de l'arrêt ne réécrit le résumé que si
  un **fait nouveau** est apparu (signature des états d'arrêt). Le nombre
  d'écritures est borné par le nombre de Captures du Take — ce n'est pas une
  source d'orage réseau (J14-B02).
- **Rétrocompatibilité** : un Take antérieur à J16-A est assaini en
  `stopStates: {}` / `replications: {}` ; son `summary.transfers` est conservé
  intact. Aucun Take existant n'est invalidé.

### 3.2 Un module pur de reconstruction

`app/www/js/state/take-archive-model.js` — **sans DOM, sans réseau, sans
service** : il transforme des données persistées en faits affichables.

```
MultiCamTakeArchiveModel.reconstruct({ take, session }) → {
  rows[]      : une ligne par Capture (sélection), avec ses destinations
  state       : état global du Take (error / done / running / waiting / partial / unknown / none)
  durationMs  : durée connue ? durationKnown : false
  unavailable : phrases explicites décrivant ce qui n'est PAS connu
  globalTransferState : exposé, JAMAIS utilisé pour dériver un état de réplication
}
```

Règles non négociables implémentées :

1. **Aucune invention.** Ce qui n'est pas dans les données persistées n'est pas
   affiché comme un fait : c'est signalé comme *indisponible*.
2. **L'état global ne prouve pas une fin de réplication.** Seul l'état du
   couple (`summary.replications`) le permet. Un Take ancien affiche donc
   « Information de réplication indisponible », **jamais** « Terminé ».
3. **L'état d'une Capture est déduit de ses réplications**, pas de l'état global.
4. **Rétrocompatibilité** : les faits d'arrêt des Takes anciens sont lus dans
   `summary.transfers` (entrées `STOPPED` indexées par un deviceId de Capture —
   le format J12), les réplications y sont signalées indisponibles.

### 3.3 L'écran 09 en mode archivé

`app/www/js/ui/take-stopped.js` — la **séparation reconstruction / affichage**
est stricte :

- `archivedView(arch)` : projection d'un fait archivé vers une ligne
  d'affichage, de **la même forme** que `view(v)` (mode direct). Le DOM est
  donc identique, seule la provenance des faits change.
- `renderArchived(arch)` : projection DOM.
- `renderFromStore(sid, takeNumber)` : lit le **store** (faits persistés),
  reconstruit, rend. Elle ne lit **ni** le service START, **ni** le service de
  transfert : ce sont des sources vivantes, vides pour un Take passé.

Langage de l'écran : les états du mode direct sont **conservés tels quels**
(`Terminé`, `Erreur`, `En attente`, `Transfert`, `En attente réseau`), complétés
par trois états propres à l'archive — `Enregistré` (Capture arrêtée, réplication
non documentée), `Réplication partielle`, `Information indisponible`.

En archive :

- le bouton **« Réessayer »** n'est **jamais** proposé (le transfert est
  terminé ou inconnu : il n'y a rien à relancer) ;
- « Préparer le Take suivant » est **masqué** (le Take est passé) et remplacé
  par « **Retour à la session** » ;
- un **bandeau** énonce explicitement les informations indisponibles ;
- la durée n'est affichée que si elle est **connue** (sinon `—`, pas `00:00:00`).

### 3.4 Intégration avec le routeur (écart bloquant corrigé)

Deux intégrations auraient annulé la fonctionnalité ; elles sont corrigées :

1. **Le re-rendu vivant écrasait l'archive.** Le routeur (`main.js`) re-rend
   l'écran 09 à chaque révision START et à chaque changement de transfert. En
   mode archivé, ces re-rendus sont désormais **ignorés** (`render()` est sans
   effet si l'écran est en mode archive) : l'écran continue d'afficher le Take
   consulté, pas le Take courant.
2. **La redirection automatique renvoyait vers ARM.** À la fin d'un plan, le
   routeur renvoyait l'opérateur vers l'écran d'armement. En consultation
   d'un Take passé, cela ejectait l'utilisateur de l'écran : le mode archivé
   est désormais exempté de cette redirection (`isArchived()`).

---

## 4. Tests

`app/tests/j16-take-archive.test.js` — 29 tests, en trois niveaux.

| Niveau | Tests | Couverture |
|---|---|---|
| Modèle pur (M1–M11) | 11 | Take ancien, Take nouveau, réplications multiples (2 Captures × 2 Storage), données partielles, règle 2 (état global ≠ état de couple), durée absente, Take sans Capture, entrée illisible |
| Persistance (P1–P9) | 9 | Rétrocompatibilité du résumé, aller-retour store, écriture réelle par `start-service` (faits par Capture + réplications préservées), écriture **bornée**, écriture réelle par `transfer-boot` (état par couple + faits d'arrêt préservés) |
| Écran 09 (E1–E9) | 9 | Affichage archivé ancien/nouveau, « Réessayer » absent, Take absent du store, store en erreur, bandeau, retour à la session, **re-rendu vivant sans effet**, non-régression du mode direct |

Résultat : **`cd app && node tests/run.js` → 500 passed, 0 failed** (471 tests
antérieurs + 29 nouveaux). Les tests antérieurs — dont `j11-take-stopped-state`
et `j11-take-stopped-ui` (mode direct) — sont **inchangés et verts**.

En complément, une **campagne physique** sur 3 appareils Android réels a été
menée (`tests/e2e/j16a-campaign.sh`, 13/13 critères PASS) : faits d'arrêt et
états de réplication persistés puis relus dans l'archive, consultation depuis
l'écran 03 **et** depuis l'écran 15, et lecture d'un Take antérieur à J16-A.
Rapport : `tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md`.

---

## 5. Corrections structurelles associées

Ces écarts relevés dans l'inventaire (§4.1) ont été corrigés **dans le cadre de
J16-A**, parce qu'ils rendaient la consultation inutilisable ou trompeuse :

| Écart | Correction |
|---|---|
| `panel-history` + `js/ui/history.js` placés **après `</html>`** (`index.html:863-873`) | panneau et script replacés dans le flux normal du document ; le doublon `nextTakeCard` qui suivait (hors panneau, donc visible sur tous les écrans) a été supprimé |
| `id="sessionName"` **dupliqué** (`panel-create` et `panel-session`) : `getElementById` renvoyait le champ de saisie de l'écran de création, donc le titre de session de l'écran 03 n'était jamais écrit | le libellé de l'écran 03 est renommé `sessionNameLabel` ; **le champ de création garde `id="sessionName"`** (identifiant contractuel utilisé par les 23 scripts de campagne `tests/e2e/*.sh`) ; l'écran 03 affiche enfin son titre |
| `id="nextTakeCard"` dupliqué | le doublon hors `</html>` est supprimé (le panneau 03 conserve le sien) |
| écran 09 sans issue en mode archivé | bouton « Retour à la session » (`#tsBack`) |

Non traité (hors périmètre J16-A, sans impact sur la consultation) :
`#lanCount` inexistant (`home.js:153`), code mort mais non bloquant.

---

## 6. Limites connues et suites

- **Validation physique RÉALISÉE — PASS (13/13).** Campagne sur 3 appareils
  Android réels (A Master, B Capture, C Storage), session `PT63EPGF` créée et
  3 Takes enregistrés puis consultés : rapport complet, captures d'écran, dumps
  et logcat dans `tests/e2e/validation/J16-A/` (voir
  `RESULTS-J16-A-PHYSICAL.md`). Un Take antérieur à J16-A (session `ZFMYZRAS`,
  résumé au format J12) a également été consulté : il s'affiche avec ses
  informations manquantes **explicitement signalées**, jamais inventées.
- **Les Takes enregistrés avant J16-A** n'ont pas d'état de réplication par
  couple : leur écran affiche « Information de réplication indisponible ». C'est
  un choix assumé (règle 2), pas un défaut ; l'enrichissement progressif se
  fera naturellement pour les Takes suivants.
- **Une session dont le plan est en cours** peut encore être consultée depuis
  l'écran 03 : l'archive est alors lisible, mais les Takes encore en cours
  n'ont pas de faits persistés (ils sont « en direct », pas « passés »).
- La **suppression des sources** et la **reprise J15** n'ont pas été retouchées.
- Les lots **B à E** du périmètre J16 ne sont pas commencés.

### 6.1 Anomalie P0 détectée pendant la campagne — **hors périmètre J16-A**

La campagne a révélé un **défaut de perte de données pré-existant** dans
`app/www/js/state/session-store.js:37-49` : `writeFile()` exécute
`w.truncate(0)` **puis** `w.write(text)`. Un arrêt de l'application entre les
deux opérations laisse un fichier de session **vide** : la session entière est
perdue (Tous ses Takes, le plan, les membres). Constaté sur l'appareil A le
2026-10-22 à 08:43 — la session de la campagne J15 (`DEBNCYNA`, 7 Takes) s'est
réduite à 0 octet lors d'un `am force-stop`.

Ce défaut n'est **pas** introduit par J16-A (`session-store.js` n'a pas été
modifié) et il ne concerne pas spécifiquement la consultation archivée, mais il
contredit l'exigence « les manifests JSON sont la source de vérité ». Correctif
recommandé : écrire dans `<sid>.json.tmp` puis renommer sur `<sid>.json`
(Cordova `file` expose `entry.moveTo`), afin qu'un arrêt en cours d'écriture
laisse l'ancien fichier intact. **Ce schéma existe déjà dans le dépôt** :
`app/www/js/state/transfer-journal.js` écrit via un `.tmp`, relit le contenu
(round-trip) puis `moveTo(dir, name)` — il est directement réutilisable.

**Décision attendue :** ouvrir un jalon dédié (P0 persistance) — hors du lot A.

## 7. Traçabilité

| Élément | Emplacement |
|---|---|
| Module de reconstruction | `app/www/js/state/take-archive-model.js` |
| Écran 09 (mode archivé) | `app/www/js/ui/take-stopped.js` (`archivedView`, `renderArchived`, `renderFromStore`, `isArchived`) |
| Persistance des faits d'arrêt | `app/www/js/state/start-service.js` (`stopStatesSignature`, `stopStatesOf`, `persistStopIfNeeded`) |
| Persistance des réplications | `app/www/js/state/transfer-boot.js` (`replicationsOf`, `updateTakeFromTransfers`) |
| Forme canonique du résumé | `app/www/js/state/take-model.js` (`sanitizeStopStateMap`, `sanitizeReplicationMap`) |
| Routeur (redirection exemptée) | `app/www/js/main.js` (`isArchivedTakeStopped`) |
| Tests | `app/tests/j16-take-archive.test.js` |
