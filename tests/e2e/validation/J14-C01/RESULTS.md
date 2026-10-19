# J14-C01 — Résultats de validation (fiabilisation du cycle de vie des transferts)

> Campagne ciblée **D2** exécutée sur appareils réels. D1 et D3 sont couverts par la
> suite de tests automatisés (`app/tests/j14c01-transfer.test.js` + non-régression).
> **Verdict global : PASS (D2 prouvé bout-en-bout) / PARTIAL (D1, D3 = preuve logique, pas de campagne UI).**

## 1. Contexte

- Branche : `feat/j11-media-transfer` — base validée J14 : `d4e6fb7`.
- Anomalie D2 confirmée dans le code (`DIAGNOSTIC.md` §Phase 3) : corps de réponse borné
  par `data.available()` (`int`, plafond 2 Gio = `Integer.MAX_VALUE`) alors que
  `Content-Length` était annoncé en 64 bits → troncature silencieuse des fichiers > 2 Gio,
  puis `ProtocolException` côté client.
- Correctifs appliqués : `NanoHTTPD.java` (`long pending` borné par `Content-Length`),
  `MultiCamTransfer.java` (échec explicite `download_truncated` si flux incomplet).

## 2. Montage

| Rôle | Appareil | Série adb | IP |
|---|---|---|---|
| Master (référence) | A | `61cc29567d91` | — |
| Source (capture) | B | `61d54bba7d91` | 192.168.92.76 |
| Destination (storage) | C | `c0d8514d7d87` | — |
| Source (capture) | D | `R83Y106V1HF` | 192.168.92.103 |

- APK installé sur A/B/C/D — md5 identique **`a2f292ec4dba10723485ce33c6f36992`** sur les 4.
- Preuve au niveau des briques natives (`CorHttpd` + `MultiCamTransfer`), pilotées par CDP
  (`MultiCamTransferApi.serveStart/serveRegister/download`). Aucun média J14 touché ;
  répertoires synthétiques `_d2c01*/` créés puis **supprimés** en fin de campagne.

## 3. Matrice de tests et résultats

Fichiers synthétiques (zéros, longueur exacte connue) servis par B (et D pour la concurrence).

| Test | Fichier | Taille (octets) | Sens | SHA-256 src == dst | Taille dst | Résultat |
|---|---|---|---|---|---|---|
| tiny | `tiny.bin` | 1 048 576 (1 Mio) | B → C | oui | exacte | **PASS** |
| under | `under.bin` | 2 147 483 000 (juste sous 2 Gio) | B → C | oui | exacte | **PASS** |
| exact | `exact.bin` | 2 147 483 648 (2 Gio **pile**) | B → C | oui | exacte | **PASS** |
| over | `over.bin` | 2 684 354 560 (2,5 Gio) | B → C | oui | exacte | **PASS** |
| resume | `over.bin` (offset 2 362 232 000 = **> 2 Gio**) | complété à 2 684 354 560 | B → C | oui | exacte | **PASS** |
| concurrence | `conc.bin` ×2 | 536 870 912 chacun | B → C **et** D → C simultanés | oui | exacte | **PASS** |

**6 PASS / 0 FAIL.**

Extraits `logcat` (device C, `MultiCamTransfer`) :

```
TRANSFER_NATIVE download done received=2147483000 total=2147483000 sha256=72e631b6…
TRANSFER_NATIVE download done received=2147483648 total=2147483648 sha256=a7c744c1…
TRANSFER_NATIVE download done received=2684354560 total=2684354560 sha256=9679aa8d…
TRANSFER_NATIVE download done received=2684354560 total=2684354560 sha256=9679aa8d…   (reprise offset>2 Gio)
TRANSFER_NATIVE download done received=536870912  total=536870912  sha256=9acca8e8…   (×2, concurrence)
```
Aucune occurrence de `download_truncated` ni de `ProtocolException` dans les journaux.
Détail complet : `campagne/dumps/` (retours natifs JSON + SHA sources), `campagne/logs/`
(extraits `CorHttpd` sur B, `MultiCamTransfer` sur C, journal de campagne).

Note : le `logcat` de D (tablette) n'a pas retenu les lignes du tag `CorHttpd` ; le
téléchargement **depuis D** est néanmoins prouvé par `campagne/dumps/dl-conc.json`
(deux retours `done` simultanés) et par l'égalité SHA-256 avec la source de D
(`9acca8e8…`, même empreinte que `over`/`conc`).

## 4. Couverture D1 / D3 (preuve logique)

- **D1** (convergence Master↔Storage, états terminaux, watchdog) : 11 tests unitaires
  (`app/tests/j14c01-transfer.test.js`, D1.1–D1.11) couvrant monotonie terminale,
  `staleTransfers`, re-diffusion terminale, `markTransferStuck`, hooks
  `onPeerIdentified` / `onTransportReconnect`.
- **D3** (suppression ciblée par (session, Take, Capture), ACK réel, différé, idempotence) :
  8 tests (D3.1–D3.8) + garde statique native (`doRemove` → `existed`).
- Non-régression : suite complète `node tests/run.js` = **427 passed / 0 failed**.

## 5. Réserves / non couvert en campagne physique

- **D3** : la suppression n'a pas été exercée via l'UI de bout en bout (service testé en
  unitaire) ; recommandé une passe UI ciblée lors de la prochaine session d'appareil.
- **D1** : la convergence n'a pas été observée après coupure réseau applicative réelle
  (logique testée en unitaire) ; la concurrence de transport a été prouvée au niveau
  briques natives, pas via l'ordonnanceur de transferts applicatif.
- Ces éléments documentent un verdict **PARTIAL** pour D1/D3 côté physique.

## 6. Rejouabilité

```bash
bash tests/e2e/j14c01-campaign.sh    # refuse d'écraser un dossier de preuves non vide
```
