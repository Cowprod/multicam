# MultiCam — J16-P0 — Validation physique de la persistance des sessions

**Date : 26 octobre 2026.** **Branche : `feat/j11-media-transfer`.**
**Objet : écriture sûre de `sessions/<sid>.json`, récupération depuis
`tmp`/`bak`, conservation des métadonnées de Take, absence de régression.**

Ce document rend compte des preuves **sur appareils Android réels** disponibles
pour J16-P0. Le périmètre de reprise est **réduit** : une seule fenêtre de panne
a été validée physiquement (rotation terminée / primaire absent), les autres
phases de la campagne existante ne sont **pas** rejouées dans ce jalon.

- Résultats automatisés : `docs/J16-P0-RESULTS.md`.
- Harnais de reproduction : `tests/e2e/j16p0-campaign.sh` (script **corrigé**,
  voir §5).
- Instrumentation de test : `window.MultiCamSessionStoreDebug`, injectée par CDP
  dans un build **debug**. En production cet objet n'existe pas : chaque
  `stage()` est un no-op (`app/tests/j16-p0-persistence.test.js`, T23).

---

## 1. Montage

| Rôle | Appareil | Session de test |
|---|---|---|
| A — Master (porteur du manifeste) | `61cc29567d91` | `899GJ2SM` — « Regie P0-171220 », PIN `2076` |
| B — Capture | `61d54bba7d91` | idem (réplication WS) |
| C — Storage | `c0d8514d7d87` | idem (réplication WS) |

Build installé sur A : `session-store.js` identique bit à bit à la version du
dépôt (MD5 `652d1567773dc376ea454172b1cfb50e` sur `app/www` et sur
`platforms/android/app/src/main/assets/www`).

La session de test contient **1 Take arrêté** avec ses métadonnées J16-A :

| Métadonnée | Valeur relue après chaque reprise |
|---|---|
| `takes` | 1 |
| `summary.stopStates` | 3 entrées (3 Captures) |
| `summary.replications` | 1 couple Capture → Storage |
| nom / PIN / état | `Regie P0-171220` / `2076` / `open` |

Le manifeste pèse **6855 octets** ; `primary` et `bak` sont conservés avec le
même contenu lors des sauvegardes ordinaires (rotation).

---

## 2. Résultats par scénario

| Scénario | Ce qui est prouvé | Verdict | Preuves |
|---|---|---|---|
| **SETUP** | création de la session de test, 2 membres, manifeste sur disque | **PASS** | `dumps/verdict-SETUP-J16P0.txt`, `dumps/disk-setup.json`, `screenshots/SETUP-A-session.png`, `screenshots/SETUP-A-members.png` |
| **BASE** | Take réellement arrêté : les faits d'arrêt (`stopStates`) et de réplication (`replications`) sont persistés ; la sauvegarde suivante crée une version précédente (`bak`) | **PASS** | `dumps/verdict-BASE-J16P0.txt`, `dumps/disk-base.json`, `dumps/BASE-base-summary.json`, `screenshots/BASE-A-take.png`, `screenshots/BASE-A-stopped.png` |
| **P1 — kill avant création du tmp** | armation CDP + primaire intact | **FAIL (harnais)** — non rejoué, voir §5 | `dumps/verdict-PHASE-p1 (before_tmp).txt` |
| **P2, P3, P4, P5, P7** | autres fenêtres de panne | **NON EXÉCUTÉES** (hors périmètre réduit ; couvertes par le test unitaire T03→T07) | — |
| **P6 — kill pendant la rotation (primaire déjà déplacé, tmp pas encore publié)** | la fenêtre la plus dangereuse : **aucun primaire**, un `bak` valide et un `tmp` complet | **PASS** (8 critères PASS / 0 FAIL / 1 INFO de convergence WS) | `dumps/verdict-PHASE-p6 (primary_moved).txt`, `dumps/disk-p6-*.json`, `logs/*-PHASE-p6 (primary_moved).log`, `screenshots/p6-A.png` |
| **DELETE** | suppression volontaire sans résurrection | **NON EXÉCUTÉE** | — |

---

## 3. Scénario P6 — chronologie et preuves (validation physique ciblée)

Point d'interruption : `primary_moved`, c'est-à-dire **après** rotation de
l'ancienne version vers `bak`, **avant** publication du `tmp` vérifié vers
`primary`. C'est l'état où le manifeste principal n'existe plus.

| Instant | État sur disque de A | Preuve |
|---|---|---|
| Avant armation | `primary` = `bak` = `7104f615…` (6855 o), pas de `tmp` | `dumps/disk-p6-before.json` |
| Armation | version armée `sha256=554134783c42298e…`, longueur 6855 o, `updatedAtMs=1793000593095` | sortie `arm=` de la timeline |
| `am force-stop` à t=1,5 s | processus mort, **primaire absent** | `PROCESS DEAD`, `dumps/primary-p6-killed.raw` vide |
| Après kill (app morte) | `primary` : absent — `tmp` = `5541…` (6855 o, valide) — `bak` = `7104…` (6855 o, valide) | `dumps/disk-p6-killed.json` |
| Relance | `SESSION_RECOVER sid=899GJ2SM source=tmp action=promoted reason=boot primary=missing tmp=valid backup=valid` | `logs/61cc29567d91-PHASE-p6 (primary_moved).log` |
| Après reprise | au moins une version valide servie : `takes=1`, `stopStates=3`, `replications=1`, PIN inchangé | `dumps/disk-p6-after.json`, verdict `P6_STORE_DATA_INTACT=PASS` |
| Reprise des écritures | sauvegarde ordinaire de consolidation réussie | `P6_RESAVE_OK=PASS` |

### Verdicts P6

| Critère | Verdict |
|---|---|
| `P6_PRIMARY_ABSENT` | **PASS** |
| `P6_BAK_IS_OLD_PRIMARY` | **PASS** |
| `P6_TMP_IS_ARMED` | **PASS** |
| `P6_STORE_DATA_INTACT` | **PASS** |
| `P6_STOPSTATES_SURVIVED` | **PASS** |
| `P6_REPLICATIONS_SURVIVED` | **PASS** |
| `P6_AFTER_PRIMARY_KEEP` (≥ 1 version valide) | **PASS** |
| `P6_RESAVE_OK` | **PASS** |
| `P6_AFTER_PRIMARY_CONVERGED` | **INFO** — le primaire observé 2 s après le boot (`23bb2b4a…`) diffère du tmp promu (`5541…`) : une réplication WS a immédiatement réécrit un état plus récent. Ce n'est pas une perte : le tmp a bien été promu (log ci-dessus) et une version valide est servie. Le harnais classe ce cas `INFO` par construction. |

---

## 4. Preuve de non-fabrication (fichier de l'incident d'origine)

Le fichier `DEBNCYNA.json` — la session J15 réduite à **0 octet** le
2026-10-22 pendant `am force-stop`, incident à l'origine de J16-P0 — est
toujours présent sur A. Après la relance du scénario P6 :

```
SESSION_RECOVER_NONE sid=DEBNCYNA reason=boot primary=invalid tmp=missing backup=missing
```

Le store **ne fabrique aucune session** à partir d'un fichier vide et **ne le
supprime pas** (la donnée reste disponible pour une analyse ultérieure). Les
21 autres sessions présentes sur A sont servies normalement :

```
SESSION_RECOVER sid=<autre> source=primary action=none reason=boot primary=valid tmp=missing backup=valid
```

C'est la preuve, sur le fichier réel de l'incident, que la politique de
récupération ne remplace pas une absence de donnée par une donnée inventée.

---

## 5. Incident de harnais P1 — analyse et correctif

Le 25 octobre, la phase P1 a produit `P1_ARMED=FAIL` alors que l'armation
avait **réussi** côté WebView :

```
{"armed":true,"stage":"before_tmp","delayMs":6000,"len":6855,"sha":"2a87179b…"}
```

**Cause** : `node tests/e2e/lib/cdp.js eval` imprime une **chaîne JSON**
(guillemets externes + échappements internes). `arm_save()` se contentait de
retirer les guillemets externes (`sed 's/^"//; s/"$//'`), laissant
`{\"armed\":true,…}` : le `JSON.parse` suivant échouait, `HN` était vide, la
phase s'arrêtait **avant** le `force-stop`. Le produit n'était pas en cause
(`P1_STORE_DATA_INTACT=PASS`).

**Correctif (harnais uniquement)** : `arm_save()` décode désormais la valeur
CDP (`JSON.parse`) avant de la réémettre. Aucun code applicatif modifié.

**Limite constatée sur ce même essai** : `pull_files` lit `primary`, `tmp`,
`bak` puis `ls` par **quatre appels adb successifs**. Sur une application qui
écrit (télémétrie ~5 s), ces quatre lectures ne sont pas atomiques entre elles.
Le snapshot `P1-before` montre ainsi `primary` vide et `tmp=bak` — cohérent
avec une sauvegarde en vol, pas avec un défaut produit. Les états **après
kill** ne sont pas concernés : l'application est morte, le disque est stable.
Cette limite est explicitement assumée ; elle n'a pas été corrigée dans ce
jalon (aucune incidence sur P6, dont les trois snapshots sont cohérents).

**P1 n'a pas été rejouée** : la mission de reprise limite la validation
physique à **une** fenêtre ciblée. P1 est donc **BLOCKED** en tant que preuve
physique, pas en tant que comportement produit (le cas est couvert par
`T03` et `T04`).

---

## 6. Ce que cette validation ne couvre pas

- Les fenêtres P2 (`tmp_truncated`), P3 (`tmp_written`), P4 (`tmp_verified`),
  P5 (`bak_removed`), P7 (`committed`) et la suppression : **non rejouées**.
  Elles restent couvertes par les tests unitaires sur système de fichiers
  simulé, y compris les morts brutales et le fallback copie de `moveTo`.
- La **suppression durable** (`MODE=delete`) n'a pas été rejouée.
- La performance d'écriture (nombre d'I/O par sauvegarde) n'a pas été mesurée
  sur appareil ; elle reste bornée par le schéma (écriture + relecture de
  vérification + rotation).
- Le comportement sous **stockage saturé** n'est pas exercé (réserve J13-05,
  inchangée).
- Aucun test de panne réseau : hors périmètre (J15 inchangé).

---

## 7. Reproduction

```bash
# Prérequis : 3 appareils connectés, build debug installé, session de test créée.
MODE=setup tests/e2e/j16p0-campaign.sh
MODE=base  tests/e2e/j16p0-campaign.sh
MODE=p6    tests/e2e/j16p0-campaign.sh   # validation ciblée de ce jalon
MODE=status tests/e2e/j16p0-campaign.sh
```

Les campagnes exhaustives (`MODE=all`, P1→P7) ne font pas partie du périmètre
de reprise J16-P0 et ne doivent être relancées que sur décision explicite.
