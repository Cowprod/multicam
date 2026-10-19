# J15 — Conception : résilience des transferts et reprise automatique

**Milestone** : J15 — Résilience des transferts et reprise automatique
**Phase** : 1 — Audit et conception (aucune modification applicative)
**Branche** : `feat/j11-media-transfer`
**Commit de référence** : `a548aba` (J14 clôturé)
**Date** : 19 octobre 2026
**Statut** : `EN ATTENTE D'AUDIT CHATGPT ET VALIDATION UTILISATEUR`

---

## Avertissement

Ce document est le **livrable de Phase 1**. Il ne contient **aucune modification
applicative**. Aucune APK n'a été installée, aucune campagne J14 n'a été relancée,
aucun média ni aucune session n'ont été supprimés. L'implémentation (Phase 2) ne
commencera qu'après validation de cette conception et arbitrage des questions
ouvertes (§15).

---

## 1. État actuel du système

### 1.1 Architecture en couches

Le transfert média repose sur trois couches JavaScript et deux plugins natifs :

| Couche | Fichier | Rôle |
|---|---|---|
| Modèle pur | `app/www/js/state/transfer-model.js` (718 l.) | Machine à états, invariants, émission WS |
| Service (effets) | `app/www/js/state/transfer-service.js` (386 l.) | Serveur média, téléchargements natifs, SHA-256, suppression locale, retry |
| Bootstrap (câblage) | `app/www/js/state/transfer-boot.js` (724 l.) | Registre multi-(session,take), transport, watchdog, persistance |
| Natif transfert | `app/local-plugins/.../MultiCamTransfer.java` (330 l.) | `sha256`, `download` (Range/append/SAF), `stage`, `remove` |
| Natif serveur | `app/local-plugins/.../CorHttpd.java` + `NanoHTTPD.java` | Serveur HTTP média unique, tokens par Take, Range/206, fix 64-bit |

### 1.2 Cycle de vie actuel (happy path)

```
Capture STOP → stageSegments → sha256 → ensureServer → serveRegister
  → model.announceMedia() → media_ready (WS broadcast)

Master ← media_ready → masterOffer (si transferAuto)
  → model.offerTransfers() → transfer_offer (sendTo chaque Storage)

Storage ← transfer_offer → storageRun (garde anti-double)
  → downloadWithRetry (MAX_ATTEMPTS=3, backoff 500/1000/2000 ms)
    → native.download({url, token, offset, expectedBytes, dest|treeUri})
    → progress toutes les 250 ms → transfer_progress (WS)
    → sha256 destination → transfer_result state=done (WS)

Master ← transfer_result done (toutes destinations)
  → requestDelete → transfer_delete (sendTo Capture)

Capture ← transfer_delete → captureHandleDelete
  → deferDelete si REC → doCaptureDelete → native.remove
  → transfer_delete_ack (si confirmé)
```

### 1.3 Modèle d'états actuel

**Par fichier** : `pending → transferring → verifying → done | error`
**Par (source × storage)** : `computeTransferState()` → `pending | transferring | error | done`

Invariants J14-C01 :
- **Monotonie terminale** : un fichier `done`/`error` ne régresse jamais vers `transferring`.
- **Idempotence des résultats terminaux** : double livraison WS = no-op.
- **SHA source autoritaire** : `done` avec hash destination différent ⇒ `error: sha256_mismatch`.
- **Déduplication manifeste** : `sameManifest()` rejette la double livraison de `media_ready`.
- **Anti-double-run** : `runningRuns[srcDid]` empêche deux téléchargements concurrents vers la même source.

### 1.4 Mécanismes de reprise existants

| Mécanisme | Localisation | Paramètres |
|---|---|---|
| Retry par fichier | `transfer-service.js` `downloadWithRetry` | `MAX_ATTEMPTS=3`, reprend via `resumeOffset()` |
| Backoff exponentiel | `transfer-boot.js` `delay()` | `min(4000, 500·2^(attempt-1))` → 500/1000/2000 ms |
| Reprise HTTP Range | `MultiCamTransfer.java` | `Range: bytes=N-` ; disque autoritaire (J14-B03) |
| Watchdog anti-blocage | `transfer-boot.js` `watchdogTick` | Tick 5 s ; stale ≥ 45 s ⇒ re-offre bornée (≤3) puis `error` |
| Réconciliation reconnexion | `transfer-boot.js` `onPeerIdentified` | Throttlé 10 s ; Master re-offre, Storage re-diffuse terminaux |
| Reconnexion transport | `transfer-boot.js` `onTransportReconnect` | Storage re-diffuse terminaux |
| Retry manuel | Écran 09 « Réessayer » → `boot.retry()` | Réémet `masterOffer` (Master seulement) |
| Suppressions différées | `transfer-service.js` `deferDelete` | `DELETE_MAX_ATTEMPTS=5`, rejouées par watchdog |
| Backoff WS | `session-ws.js` | `RETRY_STEPS_MS=[500,1000,2000,5000]`, cap 5 s |

### 1.5 Persistance actuelle

- **Store** : `session-store.js` — un fichier `sessions/<sessionId>.json` contenant `takes[]`.
- **État de transfert persisté dans le Take** : `take.summary.{transferState, transferError, transferBytes, transferTotal, transferPercent, transfers}`, coalescé à 1 s (`PERSIST_COALESCE_MS`).
- **Écriture unidirectionnelle** : rien ne recharge l'état de la machine de transfert au redémarrage. Le registre `entries`, `stagedMap`, `announced`, `pausedOffers`, `deferredDeletes`, `runningRuns` est **process-lifetime only**.
- **Fichiers partiels** : restent sur disque après erreur ; le natif reprend via `dest.length()` (J14-B03) **si** une nouvelle offre arrive.
- **Aucun fichier `transfer.json` dédié** n'existe.

### 1.6 Détection réseau actuelle

- **mDNS/NSD** : `discovery.js` + `MultiCamNsd.java` — `serviceFound/Lost`, `reannounced(reason=network_change)`, `netChanged`.
- **WS** : `session-ws.js` — reconnexion par endpoint avec backoff, heartbeat 2 s / timeout 8 s, `reSyncSessionsFor` (présence session, pas transferts).
- **Hooks transfert** : `resyncTransferState` à l'identification d'un pair ; `notifyTransferReconnect` à la réouverture d'un socket local.
- **Aucun écouteur réseau direct** alimentant la couche transfert.

### 1.7 Preuves J14 réutilisées

**J14-C01** (DIAGNOSTIC.md, 322 l.) :
- **D1** [DEM] : perte message terminal (WS best-effort) + absence réconciliation + absence watchdog ⇒ Master bloqué `transferring`, Storage `error`, divergence durable.
- **D2** [DEM] : borne `int available()` dans `NanoHTTPD.sendResponse` ⇒ troncature fichier > 2 GiB. **Corrigé** (fix 64-bit).
- **D3** [DEM] : `listSegments()` lisait la vue courante du Take ⇒ `files=0` + ACK à tort. **Corrigé** (ciblage par `stagedMap`).

**J14-C02** (RESULTS-J14-C02.md, 150 l., verdict PASS) :
- **D1** : coupure Wi-Fi C de 20 s ⇒ convergence Master/Storage vers `error` terminal explicite, **aucune reprise**.
- **D3** : suppression différée pendant REC, cible correcte, T3 préservé.
- **Résidus partiels** : fichiers partiellement téléchargés (35,5 Mo / 114 Ko) non nettoyés après erreur.
- **`retry()` périodique proscrit** : nudge pendant transfert actif ⇒ `download_http_404`.

---

## 2. Causes de l'absence de reprise automatique

### 2.1 Cause A — Épuisement des tentatives HTTP pendant la coupure

**[DEM]** (corrélation code + preuves J14-C02)

Le Storage épuise ses 3 tentatives (`MAX_ATTEMPTS=3`) pendant une coupure de 20 s :

1. La coupure Wi-Fi coupe le flux HTTP en cours → `SocketException` ou `ConnectException` (échec de connexion **immédiat** si l'interface est coupée).
2. `downloadWithRetry` tente 3 fois avec backoff 500/1000/2000 ms (total fenêtre ~3,5 s).
3. Les 3 tentatives échouent pendant les 20 s de coupure.
4. `model.reportResult(PH_ERROR, "download_failed: …")` publie un **état terminal `error`**.
5. L'erreur terminale est appliquée dans le modèle (monotonie terminale : irréversible sans réinitialisation explicite).

**Chronologie J14-C02 D1** : coupure à t0 ; `SocketException ×3` + `ConnectException` en < 2 s ; `TRANSFER_RESULT error` publié localement avant le retour réseau (t0+20 s).

### 2.2 Cause B — Le retour du réseau ne déclenche aucune nouvelle tentative

**[DEM]**

Plusieurs mécanismes existent mais **aucun ne relance un transfert en erreur terminal** :

1. **`onPeerIdentified`** : le Master re-offre les sources **non terminales** (`if (e.machine.state.sources[cameFrom])`). Un transfert marqué `error` est **terminal** ⇒ non re-offert. Le Storage re-diffuse ses **terminaux** (y compris `error`), ce qui **confirme** l'échec au Master au lieu de le corriger.
2. **Watchdog `staleTransfers`** : ne sélectionne que les transferts **non terminaux** (`if (t.state === PH_DONE || t.state === PH_ERROR) return`). Un `error` est ignoré.
3. **`onTransportReconnect`** : Storage re-diffuse terminaux. Même effet : confirme l'échec.
4. **Persistance** : `take.summary.transferState = "ERROR"` est écrit, mais **rien ne le relit** au redémarrage pour relancer.
5. **Retry manuel** : seule voie de reprise (écran 09 « Réessayer »), non automatisée.

**Conséquence** : le `error` est **absorbant**. Une fois atteint, seul un acte humain ou une nouvelle offre (nouveau `media_ready` du même Take) peut le remettre en `pending`.

### 2.3 Cause C — Absence d'état « en attente de réseau »

**[OBS]**

Le modèle ne distingue pas :
- échec **transitoire** (réseau coupé, reprise possible) ;
- échec **définitif** (fichier corrompu, source disparue, limite atteinte).

Tout échec produit `error`, qui est **terminal et absorbant**. Il n'existe pas d'état « en attente de reconnexion » ni de classification des erreurs (transitoire vs permanente).

### 2.4 Cause D — Aucune persistance de la machine de transfert

**[OBS]**

Après redémarrage de l'application ou du Storage :
- le registre `entries` est vide ;
- les fichiers partiels restent sur disque ;
- les SHA-256 sources sont perdus (vivents uniquement dans `state.sources` en mémoire) ;
- aucune relance automatique n'est possible sans une nouvelle `media_ready`.

### 2.5 Cause E — SAF ne supporte pas la reprise

**[OBS]**

En mode SAF (`treeUri`), `MultiCamTransfer.doDownload` **recrée** la destination (`exist.delete()` + `createFile`) à chaque tentative : la reprise Range est **impossible** en SAF. Seul le mode fichier supporte l'append.

### 2.6 Synthèse des causes

| # | Cause | Classification | Impact |
|---|---|---|---|
| A | Épuisement retry pendant coupure > 3,5 s | **[DEM]** | `error` terminal prématuré |
| B | `error` absorbant, aucun relancement | **[DEM]** | Pas de reprise automatique |
| C | Pas d'état « en attente réseau » | **[OBS]** | Pas de distinction transitoire/définitif |
| D | Machine non persistée | **[OBS]** | Pas de reprise après redémarrage |
| E | SAF sans reprise | **[OBS]** | Reprise impossible en mode SAF |

---

## 3. Architecture proposée

### 3.1 Vue d'ensemble

L'architecture préserve le modèle en couches existant et **ajoute** trois mécanismes :

```
┌─────────────────────────────────────────────────────────────────┐
│                    COUCHE BOOT (transfer-boot.js)               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ResumeCoordinator (NOUVEAU)                              │   │
│  │  - Écoute : network_change, reconnexion WS, watchdog      │   │
│  │  - Déclenche : reprise des transferts en attente réseau   │   │
│  │  - Déduplique : par (session, take, source, fichier)      │   │
│  │  - Borné : max reprises, backoff plafonné                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  TransferJournal (NOUVEAU)                                │   │
│  │  - Persiste l'état machine → fichier transfer.json        │   │
│  │  - Restaure au boot (redémarrage app/storage)             │   │
│  └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE SERVICE (transfer-service.js)         │
│  - downloadWithRetry : classification erreur transitoire/déf.  │
│  - Nouveau : resumeDownload (reprise sans re-download complet) │
├─────────────────────────────────────────────────────────────────┤
│                    COUCHE MODÈLE (transfer-model.js)            │
│  - Nouvel état : waiting_network (non terminal)                │
│  - Classification des erreurs (retryable / fatal)               │
│  - Transitions : error(retryable) → waiting_network → pending  │
├─────────────────────────────────────────────────────────────────┤
│                    NATIF (MultiCamTransfer.java)                │
│  - Inchangé pour le mode fichier (Range déjà supporté)         │
│  - SAF : limitation documentée (pas de reprise)                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Principe fondamental

**Un média enregistré reste disponible tant que sa réplication n'est pas confirmée.** La Capture ne supprime jamais avant vérification SHA complète (invariant J14-C01 préservé). Le Storage conserve les fichiers partiels en attente de reprise.

### 3.3 Séparation des responsabilités

| Composant | Responsabilité | Ne fait PAS |
|---|---|---|
| `transfer-model.js` | États, transitions, classification erreurs | I/O, réseau, timers |
| `transfer-service.js` | Exécution downloads, classification erreurs, SHA | Décision de relance |
| `transfer-boot.js` | `ResumeCoordinator` : déclencheurs, dédup, bornes | Exécution downloads |
| `TransferJournal` | Persistance/restauration état machine | Logique de reprise |
| Natif | HTTP Range, écriture disque | Logique métier |

---

## 4. États et transitions

### 4.1 États de fichier (étendus)

```
pending ──→ transferring ──→ verifying ──→ done
   │              │               │
   │              │               └──→ error (sha256_mismatch) [FATAL]
   │              │
   │              └──→ waiting_network (erreur transitoire détectée)
   │                        │
   │                        ├──→ pending (reconnexion / reprise)
   │                        └──→ error (retry_exhausted) [FATAL, après délai max]
   │
   └──→ error (fatal) [FATAL]
```

### 4.2 États de transfert (source × storage)

```
pending ──→ transferring ──→ done
   │              │
   │              ├──→ waiting_network ──→ pending (reconnexion)
   │              │                          │
   │              │                          └──→ error (retry_exhausted)
   │              │
   │              └──→ error (fatal, non retryable)
   │
   └──→ error (fatal)
```

### 4.3 Classification des erreurs

| Catégorie | Codes d'erreur | Transitoire ? | Action |
|---|---|---|---|
| **Réseau coupé** | `ConnectException`, `SocketException`, `SocketTimeoutException` | **OUI** | `waiting_network` |
| **Timeout lecture** | `Read timed out`, `connect_timeout` | **OUI** | `waiting_network` |
| **HTTP transitoire** | `download_http_5xx`, `download_http_429` | **OUI** | `waiting_network` |
| **HTTP définitif** | `download_http_404`, `download_http_403`, `download_http_416` | **NON** | `error` (fatal) |
| **Troncature** | `download_truncated` | **NON** | `error` (fatal, réessai complet) |
| **SHA mismatch** | `sha256_mismatch` | **NON** | `error` (fatal, réessai complet) |
| **Source disparue** | serveur injoignable > délai max | **NON** | `error` (fatal) |
| **Stalled** | watchdog (pas de progrès) | **OUI** (1er), **NON** (exhaustion) | `waiting_network` → `error` |

### 4.4 Règle de transition

```
waiting_network n'est JAMAIS terminal.
Un transfert en waiting_network peut revenir à pending.
Un error (fatal) reste terminal (monotonie terminale préservée).
```

**Contrainte J14-C02 §6.4** : ne **jamais** retransformer arbitrairement un `error` en `pending`. Seuls les `waiting_network` (nouvel état, non terminal) peuvent être relancés. Les `error` historiques (produits avant J15) restent `error`.

---

## 5. Politique de retry / backoff

### 5.1 Philosophie

**Retries courts et bornés** pendant une coupure, puis **attente de reconnexion** (pas de boucle de retry). Le retour réseau déclenche la reprise (événement), pas un timer.

### 5.2 Paramètres proposés

| Paramètre | Valeur proposée | Justification |
|---|---|---|
| `MAX_ATTEMPTS` (par fichier, en continu) | **3** (inchangé) | Fenêtre courte pour absorber micro-coupures |
| `BACKOFF_STEPS_MS` | `[500, 1000, 2000]` (inchangé) | Total ~3,5 s — absorbe coupures < 4 s |
| `WAITING_NETWORK_MAX_MS` | **300 000** (5 min) | Durée max en attente avant `error` fatal |
| `RESUME_BASE_MS` | **5 000** | Backoff de reprise après reconnexion (1re tentative) |
| `RESUME_MAX_MS` | **60 000** (1 min) | Backoff plafonné de reprise |
| `RESUME_MAX_RETRIES` | **10** | Nombre max de reprises après reconnexion |
| `WATCHDOG_TICK_MS` | **5 000** (inchangé) | Fréquence du watchdog |
| `PERIODIC_RESUME_MS` | **120 000** (2 min) | Vérification périodique de secours (très peu fréquente) |

### 5.3 Algorithme de reprise

```
sur erreur transitoire pendant download:
    attempt++
    if attempt < MAX_ATTEMPTS:
        delay(BACKOFF_STEPS_MS[attempt])  # 500/1000/2000 ms
        retry download (Range, offset = taille disque)
    else:
        modèle → waiting_network (enregistré dans TransferJournal)
        return (STOP, pas de boucle)

sur event network_reconnect (WS onopen, network_change, peer_identified):
    ResumeCoordinator.scanWaitingNetwork():
        pour chaque transfert waiting_network:
            if waiting_network_duration < WAITING_NETWORK_MAX_MS:
                if dedup OK (pas déjà en cours):
                    delay(RESUME_BASE_MS * 2^resume_attempt, cap RESUME_MAX_MS)
                    modèle → pending
                    relance storageRun (Range, offset = taille disque)
            else:
                modèle → error("retry_exhausted")  # fatal

sur watchdog tick (PERIODIC_RESUME_MS écoulé depuis dernier scan):
    ResumeCoordinator.scanWaitingNetwork()  # secours, même logique
```

### 5.4 Garde-fous anti-boucle

1. **`waiting_network` est non-terminal mais borné** : après `WAITING_NETWORK_MAX_MS` (5 min), passage à `error` fatal.
2. **`RESUME_MAX_RETRIES`** : nombre max de reprises (10). Au-delà, `error` fatal.
3. **Déduplication** : un transfert déjà `transferring` n'est jamais relancé (garde `runningRuns` existante + garde ResumeCoordinator).
4. **Backoff plafonné** : `RESUME_MAX_MS` (1 min) entre tentatives de reprise.
5. **Pas de retry() périodique** : conformément à J14-C02 §6.4, aucun nudge `retry()` n'est émis pendant un transfert actif.
6. **Vérification périodique de secours** : toutes les 2 min seulement (pas toutes les 5 s).

### 5.5 Pourquoi ne pas utiliser `retry()` existant

`boot.retry()` réémet `masterOffer(sourceDeviceId)`, ce qui :
- crée une **nouvelle offre** (remplace `state.offers[src]`) ;
- réinitialise les offsets à 0 côté modèle (le natif reprend via disque, mais le modèle perd la progression logique) ;
- peut provoquer `download_http_404` si le serveur source ne sert plus le chemin (J14-C02 §6.4).

**La reprise J15 doit utiliser un chemin dédié** (`resumeDownload`) qui préserve l'offset et n'émet pas de nouvelle offre.

---

## 6. Déclencheurs de reprise

### 6.1 Déclencheurs événementiels (priorité haute)

| Événement | Source | Action ResumeCoordinator |
|---|---|---|
| **Retour Wi-Fi** | `network_change` / `NET_CHANGED` (`discovery.js`) | `scanWaitingNetwork()` après `RESUME_BASE_MS` |
| **Réconnexion WS locale** | `session-ws.js` `onopen` → `notifyTransferReconnect` | `scanWaitingNetwork()` |
| **Réidentification pair** | `session-ws.js` → `onPeerIdentified` | Master : re-offre sources non terminales. Storage : `scanWaitingNetwork()` |
| **Fin de REC** | `start-service.js` `isRecording() → false` | `resumePaused()` (existant) + `scanWaitingNetwork()` |
| **Redémarrage app/storage** | Boot → `TransferJournal.restore()` | Restaure `waiting_network` → `pending` → `storageRun` |

### 6.2 Déclencheurs périodiques (secours, priorité basse)

| Déclencheur | Fréquence | Action |
|---|---|---|
| Watchdog tick | 5 s | Scan `waiting_network` dont `WAITING_NETWORK_MAX_MS` expiré → `error` fatal |
| Vérification périodique | 2 min | `scanWaitingNetwork()` (sécurité si événement réseau manqué) |

### 6.3 Anti-tempête (J14-B02)

- **Throttling** : `scanWaitingNetwork()` est throttlé (min `RESUME_BASE_MS` entre deux appels).
- **Coalescence** : plusieurs événements réseau en rafale → un seul scan.
- **Pas de broadcast** : la reprise est locale au Storage ; seul `transfer_progress`/`transfer_result` est diffusé (chemin existant, coalescé J14-B02).
- **Sérialisation** : un seul `storageRun` par source (garde `runningRuns` existante).

---

## 7. Persistance

### 7.1 TransferJournal (nouveau fichier)

**Emplacement** : `cordova.file.dataDirectory/transfers/<sessionId>-<takeNumber>.json`
(web fallback : `localStorage["multicam.transfers.<sid>.<take>"]`)

**Contenu** (par machine de transfert) :

```json
{
  "version": 1,
  "sessionId": "2HVHJ8VV",
  "takeNumber": 1,
  "role": "storage",
  "selfDeviceId": "ece36247-…",
  "updatedAtMs": 1760912345678,
  "sources": {
    "19848326-…": {
      "host": "192.168.92.110",
      "port": 8080,
      "token": "mc-abc123",
      "files": {
        "videoTmp.mp4": {
          "bytes": 2456888998,
          "sha256": "1a20f2823…",
          "received": 35584600,
          "state": "waiting_network"
        }
      }
    }
  },
  "transfers": {
    "src|storage": {
      "srcDid": "19848326-…",
      "storageDid": "ece36247-…",
      "state": "waiting_network",
      "files": { "…": { "…": "…" } },
      "waitingSinceMs": 1760912000000,
      "resumeAttempts": 2
    }
  }
}
```

### 7.2 Cycle de vie du journal

| Événement | Action |
|---|---|
| Changement d'état (progress, result, waiting_network) | Écriture coalescée (1 s, même mécanisme que `PERSIST_COALESCE_MS`) |
| État terminal (`done`/`error`) | Écriture immédiate (flush) |
| Redémarrage app/storage | Lecture au boot → restauration `waiting_network` → `pending` |
| Take terminé (`done` tous fichiers + delete confirmé) | Suppression du fichier journal |
| Session fermée | Suppression des journaux de la session |

### 7.3 Restauration au boot

```
TransferJournal.restore():
    pour chaque fichier transfers/<sid>-<take>.json:
        lire état
        si role=storage ET state=waiting_network:
            vérifier fichiers partiels sur disque (taille)
            si partiel exploitable:
                modèle → pending
                ResumeCoordinator.enqueue(sid, take, srcDid)
            else:
                modèle → error("resume_source_missing")
        si role=master ET state non terminal:
            (le Master n'a pas de fichiers ; il attend les results)
            marquer "en attente" pour re-sollicitation
```

### 7.4 Compatibilité avec la persistance existante

- `take.summary.transfer*` (dans `session-store.js`) **reste inchangé** (affichage écran 09 / 07).
- `TransferJournal` est un **journal technique** séparé, non exposé à l'UI.
- En cas de conflit, le journal technique fait foi pour la reprise ; le summary reste la source d'affichage.

---

## 8. Gestion HTTP Range

### 8.1 Mécanisme existant (inchangé pour le mode fichier)

`MultiCamTransfer.doDownload` supporte déjà la reprise :
- `Range: bytes=N-` si `offset > 0` ;
- **Disque autoritaire** (J14-B03) : `dest.length()` écrase l'offset logique ;
- `RandomAccessFile.setLength(offset)` avant append (trim résiduels) ;
- `FileOutputStream(f, append=offset>0)` ;
- Si serveur ignore Range (HTTP 200 avec offset>0) → restart from 0 ;
- `written != total` → `download_truncated` (J14-C01/D2).

### 8.2 Adaptations J15

| Aspect | Actuel | J15 |
|---|---|---|
| Offset source | `model.resumeOffset()` (received logique) | Idem + vérification disque (déjà fait natif) |
| After `waiting_network` → `pending` | N/A | Relance avec offset = `dest.length()` (disque) |
| Vérification partiel | Non | **Nouveau** : `paths.checkPartial(dest, expectedBytes)` — fichier partiel exploitable si `0 < size < expectedBytes` |
| Restart si partiel corrompu | Non | Si `size >= expectedBytes` ou partiel incohérent → suppression partiel, restart from 0 |
| SAF | Recrée fichier (pas de reprise) | **Limitation documentée** : reprise impossible en SAF (voir §8.3) |

### 8.3 Limitation SAF

En mode SAF (`treeUri`), `doDownload` recrée la destination à chaque tentative (`exist.delete()` + `createFile`). La reprise Range est **impossible** sans réécriture native du mode SAF.

**Décision requise** (§15, Q3) :
- **Option A** : J15 ne supporte la reprise qu'en mode fichier (SAF reste en retry complet).
- **Option B** : Implémenter l'append SAF (plus complexe, risque de régression).

**Recommandation** : Option A (mode fichier prioritaire ; SAF reste fonctionnel mais sans reprise partielle).

### 8.4 Intégrité après reprise

Le SHA-256 est calculé **après écriture complète** (natif `sha256OfFile`). La comparaison source/destination reste identique (modèle `sha256_mismatch`). La reprise ne change rien au contrôle d'intégrité.

---

## 9. Déduplication

### 9.1 Clé de déduplication

```
(sessionId, takeNumber, sourceDeviceId, storageDeviceId, rel)
```

### 9.2 Mécanismes de déduplication

| Couche | Mécanisme | Statut |
|---|---|---|
| **Transport** | `sameManifest()` rejette double `media_ready` | Existant (J14-C01) |
| **Service** | `runningRuns[srcDid]` empêche double `storageRun` | Existant (J14-C01) |
| **Modèle** | Monotonie terminale + idempotence résultats | Existant (J14-C01) |
| **ResumeCoordinator** | **Nouveau** : file d'attente `resumeQueue` indexée par clé complète | Nouveau |
| **Journal** | **Nouveau** : un seul état par clé dans le fichier journal | Nouveau |

### 9.3 Règles ResumeCoordinator

```
enqueue(sid, take, src, storage, rel):
    clé = sid|take|src|storage|rel
    si clé déjà dans resumeQueue:
        mettre à jour (dernière tentative)
        return  # no-op
    si clé déjà "transférant" (runningRuns):
        return  # anti-double
    ajouter à resumeQueue

processQueue():
    pour chaque entrée (séquentiellement):
        si modèle.state = waiting_network:
            relancer downloadWithRetry (Range)
        retirer de la queue
```

### 9.4 Interdépendance Captures

Les transferts de Captures **distinctes** (B, D) vers le même Storage (C) sont **indépendants** :
- chaque source a sa propre offre, son propre `storageRun`, sa propre file ;
- une coupure affecte les transferts en cours vers cette source ;
- la reprise est par source (pas de verrou global).

---

## 10. Convergence Master / Storage

### 10.1 Invariant de convergence

**Master et Storage convergent vers le même état** pour chaque (source × storage) :
- `done` : SHA vérifié des deux côtés ;
- `error` : erreur explicite identique des deux côtés ;
- `waiting_network` : état **local au Storage** (le Master voit `transferring` ou `pending` — le Storage ne publie pas `waiting_network` au Master).

### 10.2 Publication des états

| État | Storage → Master | Master → UI |
|---|---|---|
| `pending` | Pas de message (Master l'a déjà via `ensureTransfer`) | Barre `pending` |
| `transferring` | `transfer_progress` (toutes les 250 ms, coalescé) | Barre progression |
| `waiting_network` | **Pas de message** (reste local) | Barre `transferring` (figée) |
| `done` | `transfer_result state=done` | Barre `done` |
| `error` | `transfer_result state=error` | Barre `error` |

**Rationale** : `waiting_network` est un état **d'exécution** du Storage, pas un résultat. Le Master n'a pas besoin de le connaître (il suit `transferring` jusqu'à `done`/`error`). Cela évite une proliferation d'états sur le wire et préserve la compatibilité J14.

### 10.3 Réconciliation après reprise

Quand le Storage reprend et termine :
- `transfer_progress` repart (le Master voit la progression avancer) ;
- `transfer_result done` confirme la complétion ;
- le Master déclenche `requestDelete` (chemin existant).

Si le `transfer_result` est perdu (coupure pendant la reprise) :
- le Storage re-diffuse au prochain `onPeerIdentified` / `onTransportReconnect` (mécanisme existant J14-C01) ;
- le Master re-offre si non terminal (mécanisme existant).

### 10.4 Cas de non-convergence

| Cas | Comportement |
|---|---|
| Source disparue définitivement (Capture éteinte) | Storage → `waiting_network` → `error("retry_exhausted")` après 5 min. Master reçoit `error`. |
| Storage éteint pendant reprise | Master watchdog → `error("stalled")` après 45 s × 3 re-offers. Storage restaure au boot via journal. |
| SHA mismatch après reprise | `error("sha256_mismatch")` (fatal). Réessai complet si nouvelle offre. |

---

## 11. Compatibilité avec les Takes successifs

### 11.1 Indépendance par Take

Le registre `entries["sid|take"]` (J11-UI-CONFORMANCE) garantit que :
- chaque Take a sa propre machine/service ;
- un Take N+1 n'écrase pas le Take N ;
- les transferts en attente du Take N restent gérés par leur machine dédiée.

### 11.2 Nouveau Take pendant interruption

**Scénario** : Take T2 en `waiting_network`, Take T3 démarre (REC).

| Aspect | Comportement J15 |
|---|---|
| REC T3 | Garde `isRecording()` existante : pause les téléchargements **en cours**. Les `waiting_network` restent en attente. |
| Fin REC T3 | `resumePaused()` rejoue les offres T3. `scanWaitingNetwork()` relance T2. |
| Période T3 | T2 reste en `waiting_network` (pas de consommation ressource). |
| Delete T2 | Le Master ne supprime T2 que si **toutes** les destinations sont `done` (SHA vérifié). En `waiting_network`, pas de delete. |
| Surveillance | Les deux Takes sont surveillés par le watchdog (registre). |

### 11.3 Suppression locale préservée

L'invariant J14-C01 est **strictement préservé** :
- suppression **uniquement** après `allDestinationsDone()` + SHA vérifié ;
- `waiting_network` **n'autorise jamais** la suppression ;
- `deferDelete` reste actif pour les suppressions pendant REC.

### 11.4 Redémarrage Storage pendant T2 (waiting_network) + T3 (REC)

- Storage redémarre → `TransferJournal.restore()` restaure T2 (`waiting_network` → `pending`) ;
- T3 est en REC → garde `isRecording()` → T2 reste `pending` sans téléchargement ;
- Fin REC T3 → `resumePaused()` + `scanWaitingNetwork()` → T2 reprend.

---

## 12. Risques de régression

### 12.1 Risques identifiés

| # | Risque | Probabilité | Impact | Atténuation |
|---|---|---|---|---|
| R1 | Boucle de reprise infinie (panne permanente) | Moyenne | Élevé | `WAITING_NETWORK_MAX_MS` (5 min) + `RESUME_MAX_RETRIES` (10) + backoff plafonné |
| R2 | Saturation WebView (J14-B02) | Faible | Élevé | Dédup, throttling, coalescence existante, pas de broadcast en reprise |
| R3 | `download_http_404` (J14-C02 §6.4) | Faible | Moyen | Pas de `retry()` périodique ; reprise via chemin dédié `resumeDownload` |
| R4 | Régression monotonie terminale | Faible | Élevé | `waiting_network` est **non-terminal** ; `error` reste terminal ; tests unitaires dédiés |
| R5 | Double téléchargement (même fichier) | Faible | Élevé | Garde `runningRuns` + ResumeCoordinator dedup |
| R6 | Perte de fichiers partiels (redémarrage) | Moyenne | Moyen | Journal + disque autoritaire (J14-B03) |
| R7 | Incompatibilité anciennes sessions | Faible | Faible | Journal versionné (`version:1`) ; migration ou fallback |
| R8 | SAF sans reprise (limitation) | Certaine | Faible | Documenté ; Option A (§15 Q3) |
| R9 | Verrou global bloquant toutes Captures | Faible | Élevé | File d'attente par (source, storage) — pas de verrou global |
| R10 | Watchdog trop agressif (force `error` pendant reprise) | Moyenne | Moyen | `staleTransfers` ignore `waiting_network` ; watchdog ne marque que les `transferring` stuck |

### 12.2 Invariants à préserver (tests de non-régression)

1. Monotonie terminale : `done`/`error` ne régresse jamais.
2. SHA source autoritaire : `done` + hash différent ⇒ `error`.
3. Suppression uniquement après `allDestinationsDone()` + SHA vérifié.
4. Anti-double-run : un seul `storageRun` par source.
5. `retry()` périodique proscrit pendant transfert actif.
6. Indépendance par Take (registre `entries`).
7. Coalescence persistance (J14-B02).

---

## 13. Plan de tests automatisés

### 13.1 Tests unitaires (Node, `app/tests/`)

| Test | Fichier proposé | Scénario |
|---|---|---|
| T-U1 | `j15-transfer-waiting-network.test.js` | Erreur transitoire → `waiting_network` (non terminal) |
| T-U2 | `j15-transfer-error-classification.test.js` | Classification transitoire/fatal par code d'erreur |
| T-U3 | `j15-transfer-monotonicity.test.js` | `waiting_network` → `pending` autorisé ; `error` → `pending` interdit |
| T-U4 | `j15-resume-coordinator.test.js` | File d'attente, dedup, backoff, bornes |
| T-U5 | `j15-transfer-journal.test.js` | Écriture/lecture/restauration journal |
| T-U6 | `j15-resume-offset.test.js` | Reprise à offset > 0 (disque autoritaire) |
| T-U7 | `j15-resume-dedup.test.js` | Deux événements réseau rafale → un seul scan |
| T-U8 | `j15-resume-take-independence.test.js` | T2 waiting_network + T3 REC → indépendants |
| T-U9 | `j15-resume-max-retries.test.js` | `RESUME_MAX_RETRIES` atteint → `error` fatal |
| T-U10 | `j15-resume-waiting-timeout.test.js` | `WAITING_NETWORK_MAX_MS` expiré → `error` fatal |
| T-U11 | `j15-transfer-regression-j14.test.js` | Non-régression invariants J14 (voir §12.2) |

### 13.2 Exécution

```bash
cd app
npm test  # ou node --test tests/j15-*.test.js
```

### 13.3 Couverture minimale exigée

- Transitions d'état complètes (pending/transferring/verifying/waiting_network/done/error).
- Classification des erreurs (tous les codes de §4.3).
- Bornes (max retries, max waiting, backoff).
- Déduplication.
- Restauration journal.
- Non-régression J14 (§12.2).

---

## 14. Plan de validation physique

### 14.1 Prérequis

- 4 appareils Android (A=Master, B=Capture, C=Storage, D=Capture) — même topologie que J14-C02.
- APK J15 construite à partir de `feat/j11-media-transfer` (post-implémentation).
- Session de test dédiée (ex. `J15-RESILIENCE`).
- Harnais `tests/e2e/j15-campaign.sh` (à créer en Phase 2).

### 14.2 Scénarios (15 critères)

| # | Scénario | Durée coupure | Appareil | Méthode coupure | Critère de succès |
|---|---|---|---|---|---|
| P1 | Coupure Wi-Fi C de 5 s | 5 s | C | `svc wifi disable/enable` | Reprise auto, SHA identiques, pas de `error` |
| P2 | Coupure Wi-Fi C de 20 s | 20 s | C | idem | Reprise auto après retour, SHA identiques |
| P3 | Coupure Wi-Fi C de 60 s | 60 s | C | idem | Reprise auto (dans `WAITING_NETWORK_MAX_MS`), SHA identiques |
| P4 | Coupure Wi-Fi B pendant transfert | 30 s | B | idem | C → `waiting_network`, reprise après retour B |
| P5 | Retour réseau sans intervention | — | C | coupure 10 s | Aucune intervention humaine, reprise observée |
| P6 | Reprise à offset > 0 | — | C | coupure 30 s à ~50% | Log `resume adjusted` ou offset > 0 dans Range |
| P7 | Fichier > 2 Gio | — | — | coupure 30 s | Reprise Range sur fichier > 2 GiB, SHA identiques |
| P8 | Deux Captures B/D vers C | — | C | coupure 30 s | Les deux transferts reprennent indépendamment |
| P9 | Nouveau Take pendant interruption | — | C | coupure pendant T2, T3 REC | T2 reprend après retour, T3 non affecté |
| P10 | Redémarrage Storage avec transfert incomplet | — | C | `am force-stop` + relance | Journal restaure, reprise auto |
| P11 | Absence de doublons | — | — | — | Un seul fichier destination par (source, segment) |
| P12 | SHA identiques après reprise | — | — | — | `TRANSFER_HASH sourceSha256=… storageSha256=…` identiques |
| P13 | Suppression uniquement après intégrité | — | — | — | `TRANSFER_DELETE` seulement après `done` + SHA vérifié |
| P14 | Absence de saturation WebView | — | — | — | Pas de boucle `advertise`/`reSync` (J14-B02) |
| P15 | Persistance correcte des états | — | C | redémarrage | Journal `transfers/*.json` cohérent après restauration |

### 14.3 Méthode d'injection de coupure

```bash
# Coupure Wi-Fi (C = c0d8514d7d87)
adb -s c0d8514d7d87 shell svc wifi disable
sleep 20
adb -s c0d8514d7d87 shell svc wifi enable

# Vérification reprise (logs parsables)
adb -s c0d8514d7d87 logcat -d | grep -E "TRANSFER_(RESUME|WAITING|FILE_DONE|FILE_ERROR|STUCK)"
```

### 14.4 Collecte de preuves

Structure `tests/e2e/validation/J15-P{n}/` :
- `RESULTS-J15-P{n}.md` (verdict + analyse)
- `logs/` (logcat par appareil, événements clés)
- `dumps/` (états transfert JSON, journaux, SHA locaux)
- `screenshots/` (UI écran 09 / 07 avant/après coupure)

### 14.5 Ordre d'exécution recommandé

1. **Tests unitaires** (Node) — validation logique pure.
2. **P1, P2, P3** (coupures croissantes C) — validation basique reprise.
3. **P5, P6** (retour sans intervention, offset) — validation autonomie.
4. **P4** (coupure B) — validation autre appareil.
5. **P7** (fichier > 2 Gio) — validation gros volumes.
6. **P8, P9** (multi-captures, Takes successifs) — validation indépendance.
7. **P10, P15** (redémarrage, persistance) — validation journal.
8. **P11, P12, P13, P14** (invariants) — validation intégrité.

---

## 15. Questions nécessitant une décision utilisateur

### Q1 — Durée max d'attente réseau (`WAITING_NETWORK_MAX_MS`)

**Question** : Quelle durée max d'attente en `waiting_network` avant de basculer en `error` fatal ?

| Option | Valeur | Avantage | Inconvénient |
|---|---|---|---|
| **A** | 5 min | Couvre coupures longues typiques (tournage) | Un Storage indisponible > 5 min perd la reprise |
| **B** | 15 min | Plus tolérant pour environnements instables | Risque de files d'attente prolongées |
| **C** | Illimité (jusqu'à session fermée) | Aucune perte | Risque de accumulation ressources, états fantômes |

**Recommandation** : **Option A (5 min)**. Une coupure Wi-Fi de tournage dépasse rarement 5 min. Au-delà, un redémarrage ou une nouvelle offre est plus probable.

### Q2 — Nombre max de reprises (`RESUME_MAX_RETRIES`)

**Question** : Combien de tentatives de reprise après reconnexion avant `error` fatal ?

| Option | Valeur | Avantage | Inconvénient |
|---|---|---|---|
| **A** | 10 | Couvre 10 reconnexions | — |
| **B** | 20 | Plus robuste | Plus long avant `error` définitif |
| **C** | 3 | Rapide vers `error` | Peut manquer des reconnexions |

**Recommandation** : **Option A (10)**. Avec backoff plafonné (1 min), 10 reprises couvrent ~10 min de reconnexions instables.

### Q3 — Support de la reprise en mode SAF

**Question** : Faut-il implémenter la reprise Range en mode SAF, ou limiter la reprise au mode fichier ?

| Option | Avantage | Inconvénient |
|---|---|---|
| **A** (recommandée) | Limitation documentée, moins de code, moins de risque | SAF redémarre à 0 en cas de coupure |
| **B** | Reprise complète en SAF | Code natif SAF append complexe, risque de régression |

**Recommandation** : **Option A**. Le mode fichier est le mode principal de production. SAF reste fonctionnel (retry complet) mais sans reprise partielle. La limitation sera documentée dans les Known Limitations.

### Q4 — Persistance du `waiting_network` sur le wire

**Question** : Faut-il publier `waiting_network` au Master, ou le garder local au Storage ?

| Option | Avantage | Inconvénient |
|---|---|---|
| **A** (recommandée) | Master voit `transferring` (figée) ; pas de changement protocole | Master ne sait pas que le Storage attend |
| **B** | Master informé ; UI plus précise | Changement protocole ; risque de régression J14 |

**Recommandation** : **Option A**. `waiting_network` est un état d'exécution local. Le Master suit `transferring` jusqu'à `done`/`error` (comportement J14 inchangé). L'UI peut afficher « en attente réseau » via un champ local si souhaité.

### Q5 — Vérification périodique de secours

**Question** : Faut-il une vérification périodique de secours (au-delà des événements) ?

| Option | Valeur | Avantage | Inconvénient |
|---|---|---|---|
| **A** (recommandée) | 2 min | Sécurise si événement réseau manqué | Consommation minimale |
| **B** | 30 s | Plus réactif | Un peu plus fréquent |
| **C** | Aucune | Zéro coût | Dépend uniquement des événements |

**Recommandation** : **Option A (2 min)**. Fréquence très basse, inoffensive (scan coalescé, pas de broadcast).

### Q6 — Nettoyage des fichiers partiels après `error` fatal

**Question** : Faut-il supprimer les fichiers partiels après un `error` fatal (retry_exhausted, sha256_mismatch) ?

| Option | Avantage | Inconvénient |
|---|---|---|
| **A** (recommandée) | Évite l'accumulation de résidus (observation J14-C02 §6.2) | Un nouveau retry repart de 0 |
| **B** | Conserve les partiels pour un éventuel retry manuel | Accumulation de résidus |

**Recommandation** : **Option A**. Après un `error` fatal, le fichier partiel n'a plus de valeur (SHA ne correspondra jamais sans re-téléchargement complet). Le nettoyage évite l'accumulation observée en J14-C02 (35,5 Mo / 114 Ko résiduels).

### Q7 — Périmètre de la persistance (TransferJournal)

**Question** : Faut-il persister **tous** les états, ou uniquement les états nécessaires à la reprise (`waiting_network`, offsets) ?

| Option | Avantage | Inconvénient |
|---|---|---|
| **A** (recommandée) | Journal minimal (`waiting_network` + offsets) | Moins de traçabilité |
| **B** | Journal complet (tous états) | Plus gros, plus de complexité |

**Recommandation** : **Option A**. Le journal sert à la **reprise**, pas à l'affichage. Persister `waiting_network`, offsets (received), et métadonnées (host/port/token/files SHA) suffit. Les états `done`/`error` sont déjà dans `take.summary`.

---

## Annexe A — Fichiers impactés (Phase 2 prévisionnelle)

| Fichier | Type d'impact | Nature |
|---|---|---|
| `app/www/js/state/transfer-model.js` | Modification | Ajout état `waiting_network`, classification erreurs, transitions |
| `app/www/js/state/transfer-service.js` | Modification | Classification erreurs, `resumeDownload`, nettoyage partiel |
| `app/www/js/state/transfer-boot.js` | Modification | `ResumeCoordinator`, `TransferJournal`, déclencheurs |
| `app/www/js/net/session-ws.js` | Modification (mineure) | Hook `network_change` → ResumeCoordinator |
| `app/www/js/net/discovery.js` | Modification (mineure) | Événement retour réseau → ResumeCoordinator |
| `app/local-plugins/.../MultiCamTransfer.java` | Modification (optionnelle) | SAF append (si Q3=Option B) |
| `app/local-plugins/.../NanoHTTPD.java` | **Inchangé** | — |
| `app/www/js/ui/storage-view*.js` | Modification (optionnelle) | Affichage « en attente réseau » |
| `app/www/js/ui/take-stopped.js` | **Inchangé** | Bouton « Réessayer » existe déjà |
| `app/tests/j15-*.test.js` | **Nouveau** | Tests unitaires (11 fichiers) |
| `tests/e2e/j15-campaign.sh` | **Nouveau** | Harnais validation physique |
| `app/www/js/state/transfer-journal.js` | **Nouveau** | TransferJournal (persistance) |

## Annexe B — Glossaire

| Terme | Définition |
|---|---|
| `waiting_network` | État non-terminal d'un fichier/transfert en attente de retour réseau |
| Reprise | Relance d'un téléchargement interrompu avec HTTP Range (offset > 0) |
| ResumeCoordinator | Composant boot qui déclenche et déduplique les reprises |
| TransferJournal | Fichier de persistance technique de l'état machine (reprise après redémarrage) |
| Fatal | Erreur non-réversible (sha256_mismatch, 404, retry_exhausted) |
| Transitoire | Erreur réversible (réseau coupé, timeout, 5xx) |
| Backoff plafonné | Croissance exponentielle bornée par une valeur max |

## Annexe C — Références

- `MULTICAM_DECISIONS_REFERENCE.md` §28 (hiérarchie des décisions)
- `docs/PLAN-DEVELOPPEMENT-V1.md` (plan J01–J14)
- `tests/e2e/validation/J14-C01/DIAGNOSTIC.md` (causes racines D1/D2/D3)
- `tests/e2e/validation/J14-C02/RESULTS-J14-C02.md` (convergence, résidus, retry proscrit)
- `app/www/js/state/transfer-model.js` (modèle actuel)
- `app/www/js/state/transfer-service.js` (service actuel)
- `app/www/js/state/transfer-boot.js` (boot actuel)
- `app/local-plugins/.../MultiCamTransfer.java` (natif actuel)
