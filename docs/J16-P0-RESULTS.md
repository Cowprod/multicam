# MultiCam — J16-P0 — Persistance sûre des sessions

**État : implémentation terminée, 530 tests PASS / 0 FAIL, validation physique
ciblée PASS. Prêt pour audit.**
**Date : 26 octobre 2026.** **Branche : `feat/j11-media-transfer`.**
**Périmètre : réduit — écriture sûre, récupération `tmp`/`bak`, conservation
des métadonnées de Take, absence de régression.**
**Preuves physiques : `tests/e2e/validation/J16-P0/RESULTS-J16-P0-PHYSICAL.md`.**

Ce document clôt le correctif **P0 de persistance** ouvert par l'anomalie
détectée pendant la campagne J16-A (`docs/J16-A-RESULTS.md` §6.1).

---

## 1. Le défaut corrigé

`app/www/js/state/session-store.js` écrivait le manifeste de session en deux
temps sur le **même fichier** :

1. `writer.truncate(0)` — le fichier passe à 0 octet ;
2. `writer.write(text)` — le contenu est réécrit.

Un arrêt du processus entre les deux opérations laissait un fichier **vide** :
la session entière (membres, plan, Takes) était perdue. Le cas a été observé
sur un appareil réel le 2026-10-22 à 08:43 : `DEBNCYNA.json` (session J15,
7 Takes) est passé à 0 octet pendant un `am force-stop`. Le fichier est
toujours présent sur l'appareil A et sert de **cas de non-régression réel**.

Le défaut est **antérieur** à J16-A et n'était pas introduit par le lot A.

---

## 2. Ce qui a été construit

### 2.1 Écriture sûre (« tmp vérifié + version précédente conservée »)

Une sauvegarde suit désormais ce schéma, par session et **sérialisé** :

| Étape | Opération | Point d'instrumentation |
|---|---|---|
| 1 | `<sid>.json.tmp` reçoit le contenu complet (`truncate(0)` puis `write`) | `tmp_truncated`, `tmp_written` |
| 2 | le tmp est **relu** et comparé **octet par octet** au contenu écrit | `tmp_verified` |
| 3 | l'ancienne version valide est conservée : `<sid>.json` → `<sid>.json.bak` | `bak_removed`, `primary_moved` |
| 4 | `<sid>.json.tmp` remplace `<sid>.json` (`moveTo`) | `committed` |
| 5 | nettoyage best effort des temporaires inutiles | — |

**Invariant central : à aucun instant il n'existe zéro version valide sur
disque.** L'atomicité de Cordova `moveTo` n'est **pas** supposée : sur Android
elle tente `renameTo` puis retombe sur une **copie qui tronque la
destination** (`LocalFilesystem.copyFile`). C'est pourquoi :

- le tmp n'est supprimé qu'après une copie réussie ;
- la récupération préfère un tmp complet à un primaire partiel ;
- un échec d'écriture déclenche une **réparation** avant de rendre la main.

La vérification par relecture est la preuve que l'écriture est **terminée**
(pas seulement « pas d'exception »).

### 2.2 Récupération au démarrage, déterministe

Pour chaque identifiant de session trouvé sur disque, le store lit
`primary`, `tmp` et `bak`, valide chaque version (JSON complet **et**
`sessionId` exactement égal au nom de fichier), puis choisit dans cet ordre :

1. **tmp valide** — écriture complète la plus récente ;
2. **primaire valide** — version confirmée ;
3. **backup valide** — dernière version précédente connue ;
4. sinon : **rien n'est fabriqué**.

Une version n'est retenue que si `sanitizeSession()` restitue le même
`sessionId` : un fichier partiel qui « parse par accident » (ex. `{}`) est
rejeté, jamais réidentifié. La version choisie est matérialisée dans le
primaire, relue et vérifiée ; la source n'est supprimée qu'après succès. En cas
d'échec, les écritures de cette session sont **refusées** jusqu'au prochain
démarrage (`degraded`), et l'incident est journalisé.

Aucune décision ne dépend d'une date de fichier : la politique est uniquement
basée sur la validité et l'ordre `tmp > primary > bak`.

### 2.3 Suppression sans résurrection

- Tombstone **synchrone** : une sauvegarde déjà planifiée est ignorée, une
  sauvegarde en vol ne peut pas recréer la session après la purge.
- `remove()` supprime `primary`, `tmp` **et** `bak`, puis purge le cache.
- Le tombstone survit à `resetCache()` : une session supprimée ne réapparaît
  pas via liste ou rechargement.

### 2.4 Conservation des métadonnées de Take

Aucun champ n'est filtré ni reconstruit lors de l'écriture : le texte persisté
est exactement `JSON.stringify(session, null, 2)`. Les faits J16-A
(`summary.stopStates` par Capture, `summary.replications` par couple
Capture → Storage) sont donc conservés tels quels, y compris après une reprise
depuis `tmp` ou `bak`. C'est vérifié :

- unitairement : `T12`, `T13` (session J12 sans champs J16-A), `T14` ;
- physiquement : BASE et **P6** relisent `stopStates=3` et `replications=1`
  après un kill au cœur de la rotation.

---

## 3. Résultats automatisés

Commande : `cd app && node tests/run.js`

```
530 passed, 0 failed
```

Dont **30 tests J16-P0** (`app/tests/j16-p0-persistence.test.js`), exécutés
contre le **vrai** `session-store.js` et un faux système de fichiers Cordova
(`app/tests/fake-cordova-fs.js`) capable de simuler une mort du processus
(aucun callback exécuté, y compris au milieu d'un `moveTo` en mode copie).

Couverture : écriture nominale, rotation, interruptions à chaque étape
(`before_tmp`, `tmp_truncated`, `tmp_written`, `tmp_verified`, `bak_removed`,
`primary_moved`, `committed`), fallback copie de `moveTo` à mi-copie, primaire
corrompu, backup promu, tmp prioritaire, erreur d'écriture + réparation,
écritures concurrentes, suppression pendant une sauvegarde, redémarrage,
rétrocompatibilité J12, champs J16-A, isolation entre sessions, absence de
fabrication, cohérence `sessionId`/nom de fichier, idempotence de la
récupération, mode web, instrumentation inerte en production.

---

## 4. Validation physique

Rapport détaillé : `tests/e2e/validation/J16-P0/RESULTS-J16-P0-PHYSICAL.md`.

| Scénario | Verdict |
|---|---|
| SETUP (session de test, 2 membres) | **PASS** |
| BASE (Take réel + `stopStates` + `replications` + rotation `bak`) | **PASS** |
| **P6 — kill pendant la rotation (primaire absent, `bak` + `tmp` valides)** | **PASS** (8 critères PASS / 0 FAIL / 1 INFO de convergence WS) |
| P1 — kill avant création du tmp | **FAIL (harnais)** — corrigé, non rejoué → **BLOCKED** comme preuve physique |
| P2, P3, P4, P5, P7, DELETE | **NON EXÉCUTÉES** (périmètre réduit) |

Preuve P6 essentielle, sur appareil A :

```
avant  : primary = bak = 7104f615… (6855 o), pas de tmp
kill   : primary absent — tmp = 55413478… (6855 o, valide) — bak = 7104… (valide)
boot   : SESSION_RECOVER sid=899GJ2SM source=tmp action=promoted
         reason=boot primary=missing tmp=valid backup=valid
après  : takes=1, stopStates=3, replications=1, PIN inchangé, resave OK
```

Preuve de non-fabrication, sur le fichier réel de l'incident :

```
SESSION_RECOVER_NONE sid=DEBNCYNA reason=boot primary=invalid tmp=missing backup=missing
```

Le fichier de 0 octet est **rejeté** et **conservé** ; aucune session n'est
inventée. Les 21 autres sessions de l'appareil sont servies normalement.

### Défaut de harnais corrigé (P1)

`tests/e2e/j16p0-campaign.sh` lisait mal la sortie de `cdp.js` (chaîne JSON
échappée) : l'armation, pourtant réussie, était déclarée `FAIL` et la phase
s'arrêtait avant le `force-stop`. Le décodage a été corrigé ; **aucun code
applicatif n'a été modifié pour ce point**. P1 n'a pas été rejouée (une seule
fenêtre physique autorisée dans ce jalon).

---

## 5. Absence de régression

- **530/530 tests** PASS, dont toutes les suites J04→J16-A.
- Le contrat public du store est inchangé : `loadAll`, `list`, `get`, `save`,
  `remove`, `resetCache`.
- Les appelants (`session-ws.js`, `start-service.js`, `transfer-boot.js`,
  services de télémétrie, écrans 03/09/15) n'ont pas été modifiés.
- Les écritures restent sérialisées par session ; l'ordre des sauvegardes est
  préservé.
- Le schéma J16-A (`stopStates`, `replications`) est conservé tel quel.
- Aucun champ, fichier ou protocole de transfert modifié ; J15 et la
  suppression des sources sont intacts.

---

## 6. Limites et points ouverts (à ne pas surinterpréter)

1. **Validation physique partielle par choix** : seule la fenêtre P6 a été
   rejouée. Les fenêtres P2–P5, P7 et DELETE reposent sur les tests unitaires,
   pas sur une preuve appareil. Une campagne complète reste possible
   (`MODE=all`) mais n'est pas autorisée par le périmètre de reprise.
2. **Snapshots `pull_files` non atomiques** : les trois fichiers sont lus par
   appels adb successifs ; sur une application qui écrit, un snapshot « avant »
   peut mélanger deux instants. Les snapshots **après kill** (app morte) ne
   sont pas concernés. Aucun impact sur les verdicts P6.
3. **Convergence WS** : après relance, une réplication peut réécrire un état
   plus récent avant l'observation. Le harnais classe ce cas `INFO`
   (`P6_AFTER_PRIMARY_CONVERGED`) ; la reprise elle-même est prouvée par le log
   `SESSION_RECOVER … source=tmp action=promoted`.
4. **Durabilité physique (fsync)** : Cordova `file` ne garantit pas un `fsync`
   explicite ; le schéma protège contre la **mort du processus** (le cas
   observé), pas contre une coupure d'alimentation avec perte du cache disque.
5. **Stockage saturé** : non exercé (réserve J13-05, inchangée).
6. **Fichiers illisibles** : une erreur de lecture non « fichier absent »
   interrompt encore le chargement global (comportement antérieur, non modifié
   dans ce jalon).

---

## 7. Traçabilité

| Élément | Emplacement |
|---|---|
| Correctif | `app/www/js/state/session-store.js` |
| Tests unitaires J16-P0 | `app/tests/j16-p0-persistence.test.js` |
| Faux FS Cordova (fautes + mort) | `app/tests/fake-cordova-fs.js` |
| Campagne physique (harnais corrigé) | `tests/e2e/j16p0-campaign.sh` |
| Preuves physiques | `tests/e2e/validation/J16-P0/` |
| Anomalie d'origine | `docs/J16-A-RESULTS.md` §6.1 |
| Suivi projet | `docs/SUIVI-PROJET.md`, `docs/AVANCEMENT-V1.md` |

### Commandes

```bash
cd app && node tests/run.js          # 530 PASS / 0 FAIL
cd app && node tests/run.js j16-p0   # 30 PASS / 0 FAIL
MODE=status tests/e2e/j16p0-campaign.sh
```
