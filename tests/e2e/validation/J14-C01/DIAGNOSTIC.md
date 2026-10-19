# J14-C01 — Diagnostic du cycle de vie des transferts

- **Branche** : `feat/j11-media-transfer` — commit de référence : `d4e6fb7` (J14 publié)
- **Session analysée** : `CCQM6BFH` « Regie J14D-210338 » (campagne d'endurance J14 v2)
- **Périmètre** : 3 anomalies révélées par J14 — D1 (blocage/divergence Master↔Storage), D2 (échecs sans récupération automatique), D3 (suppression ACKée mais non effectuée)
- **Méthode** : audit statique du code (lecture seule) + corrélation avec les preuves J14 archivées. **Aucune modification du code applicatif, aucun redémarrage de campagne, aucune écriture sur les appareils.**
- **Statut** : `DIAGNOSTIC VALIDÉ` — D1 **VALIDÉ**, D3 **VALIDÉ**, D2 **cause racine CONFIRMÉE dans le code** (voir « Phase 3 — Confirmation dans le code (D2) »). Corrections Phases 3-6 autorisées (voir `RESULTS.md`).

## Convention de qualification (exigée par la mission)

Chaque affirmation est étiquetée :
- **[OBS]** observation factuelle (preuve reproductible) ;
- **[HYP]** hypothèse (cohérente mais non prouvée par les preuves disponibles) ;
- **[DEM]** cause racine **démontrée** (preuve code + corrélation forte avec les preuves).

---

## Synthèse

| Défaut | Nature | Cause racine | Classification |
|---|---|---|---|
| **D1** | Master bloqué `transferring`, diverge de Storage `error` | Perte du message terminal (WS best-effort) **+** absence de réconciliation d'état de transfert **+** absence de watchdog de progression | **[DEM]** (3 manques cumulés) |
| **D2** | `ProtocolException: unexpected end of stream`, 3 essais puis `error`, aucune récupération | `NanoHTTPD.sendResponse` borne le corps par `int available()` (≤ 2 GiB) alors que `Content-Length` est un `long` (taille réelle) → troncature corps pour tout fichier **> 2 GiB** | **[DEM]** |
| **D3** | `TRANSFER_DELETE` ACKé, média non supprimé (`files=0`) | `listSegments()` lit la vue **courante** du service START (`stopStates`/`localStopInfo`), remise à vide à l'acceptation du Take suivant → liste vide → no-op **+** ACK émis inconditionnellement | **[DEM]** |

**Cause commune : NON.** D1 et D3 relèvent de la même famille (état réparti sans réconciliation / référence d'état volatile), mais D2 est un bug de transport HTTP indépendant (arithmétique 32 bits). La mission interdit de déduire une cause unique : **aucune cause unique démontrée**.

---

## D1 — Master bloqué `transferring` / divergence Master↔Storage (T2-D)

### Symptôme
Sur le Take 2, le Master (A) reste en `transferring 88 %`, alors que le Storage (C) est en `error` :

- État live A : `tr-A-T2.json` → ligne `d618012d…` (D) `state=transferring percent=88 bytes=1713364144 total=1946232248`.
- État live C : `tr-C-T2.json` → même ligne `state=error error=download_failed percent=88`.

### Preuves [OBS]
- C émet **localement** `TRANSFER_RESULT take=2 … state=error` à **21:30:15.182**, alors que **son Wi-Fi est coupé** :
  - `INC2` (coupure Wi-Fi C) à `t0+1641s` ≈ **21:30:13** (`campaign.log`).
  - C journalise `SocketException: Software caused connection abort` ×3 puis `ConnectException: Failed to connect to 192.168.92.103:8080` et `192.168.92.76:8080` entre 21:30:13.985 et 21:30:15.182.
- Le Master A **n'a aucun** `TRANSFER_RESULT take=2 … state=error`. Son **dernier** événement take=2 est `TRANSFER_PROGRESS` à **21:30:13.780** (1713364144 / 1946232248 = 88 %).

### Chemin d'exécution
1. Storage : `reportResult(PH_ERROR)` → état local `error` (dans `transfer-service.js`).
2. Storage : émission `TRANSFER_RESULT` via WS (`session-ws.js` → `sendToDevice`/`sendServer`/`sendOn`).
3. `sendServer`/`sendOn` écrivent sur le socket ; **si le pair est injoignable l'envoi échoue silencieusement** (aucune file d'attente, aucun ack, aucune reprise) : `session-ws.js` (`sendOn`, l.709 ; `sendServer`).
4. Master : `onTransferMessage` → `applyTransferResult` (modèle). **N'est jamais appelé** (message perdu).

### Analyses écartées
- La **persistance** n'est pas en cause : elle enregistre l'état *tel quel*. A persistait `transferring`, C persistait `error` — cohérent avec un Master qui n'a jamais reçu l'état terminal. **[OBS]**
- **Aucune réconciliation** à la reconnexion : `reSyncSessionsFor(key)` (`session-ws.js:667-669`) ne resynchronise que la **présence de session / takes**, pas les transferts. `grep` : aucun `resync`/`reconnect` dans `transfer-boot.js` / `transfer-service.js` / `transfer-model.js`. **[OBS]**
- **Aucun watchdog de progression** : aucun timer de type « pas de progrès depuis N s » dans le service/modèle. **[OBS]**

### Cause racine [DEM]
Trois manques cumulés rendent la perte d'un message terminal **irréversible** :
1. **Transport terminal non fiable** : `TRANSFER_RESULT` est un simple envoi WS best-effort, sans ack ni rejeu. Émis hors-ligne ⇒ perdu définitivement.
2. **Aucune réconciliation d'état de transfert** : à la reconnexion, ni le Storage (ré-annonce de l'état terminal) ni le Master (re-sollicitation) ne reconcilient. L'état terminal perdu n'est jamais reconstruit.
3. **Aucun timeout de progression** : rien ne « débloque » un take non terminal qui ne progresse plus.

### Hypothèse secondaire (non déclenchée dans J14) [HYP] → **traitée en Phase 3** [CORR]
`applyTransferProgress` (`transfer-model.js`, ~l.271-283) n'exige pas l'état `transferring` : un `TRANSFER_PROGRESS` tardif **pourrait** faire régresser `error` → `transferring`. **Non observé** dans J14, mais le risque était réel. **Corrigé** : garde de monotonie terminale ajoutée (voir `RESULTS.md`).

### Impact
Transfert jamais terminal côté Master ⇒ pas de calcul de SHA, pas de `TRANSFER_DELETE`, Take bloqué, divergence durable Master↔Storage.

### Correctif proposé (à valider)
- **Monotonie terminale** : `error` > `done` > `transferring` ; ignorer tout `PROGRESS` postérieur à un état terminal ; rendre le terminal idempotent.
- **Réconciliation** : à la reconnexion (et périodiquement), le Storage re-diffuse l'état de chaque transfert ; le Master re-sollicite si non terminal.
- **Watchdog de progression** : absence de progrès pendant `N` s sur un transfert non terminal ⇒ re-offre **bornée avec backoff**, sinon passage à `error` explicite.
- **Transport des messages terminaux** : au minimum ré-émission à la reconnexion (rejeu/ack).

### Risques de régression
Boucles de re-offer (⇒ backoff strictement borné) ; écrasement d'un `DONE` ; double comptage si rejeu non idempotent.

### Tests nécessaires
Coupure Wi-Fi du Storage pendant un transfert actif → convergence A=C < 30 s ; `PROGRESS` tardif ignoré après terminal ; watchdog déclenché puis reprise bornée.

---

## D2 — `ProtocolException: unexpected end of stream` sans récupération (T3-D, T5-B, T5-D)

### Symptôme
`java.net.ProtocolException: unexpected end of stream` côté Storage, **3 tentatives** puis `error`, sans récupération ; `sourceSha256` connue mais `storageSha256=—`.

### Preuves [OBS]
- Paires d'erreurs (3 tentatives ≈ 2 s d'écart) : **T3-D** 21:25:59.071/.01/.03 ; **T5-B** 21:49:23.022/.058/.092 ; **T5-D** 21:49:54.609/.643/.680.
- **T3-D sans incident réseau** : `INC2` est à 21:30:13 ; T3 STOP 21:24:11, download 21:25:59 ; fichiers stables bien avant.
- `TRANSFER_HASH take=N … storageSha256=—` sur chaque échec (T3-D 21:26:04.329, T5-B 21:49:23.499, T5-D 21:49:55.079).
- **Corrélation taille (100 %)** — tailles sources (volumes J14) :

  | Transfert | Taille source | Résultat |
  |---|---|---|
  | T3-B | 1 519 218 334 (1,52 Go) | ✅ OK |
  | T1-B | 320 202 463 | ✅ OK |
  | T1-D | 808 398 208 | ✅ OK |
  | T4-B | 469 792 477 | ✅ OK |
  | T4-D | 908 016 745 | ✅ OK |
  | T6-B | 768 569 758 | ✅ OK |
  | T6-D | 961 552 107 | ✅ OK |
  | T2-B | 772 539 998 | ✅ OK |
  | **T5-B** | **2 264 233 103 (2,26 Go)** | ❌ ProtocolException |
  | **T3-D** | **3 552 831 571 (3,55 Go)** | ❌ ProtocolException |
  | **T5-D** | **4 381 274 991 (4,38 Go)** | ❌ ProtocolException |

  ⇒ **Tous les échecs ProtocolException sont > 2 GiB ; tous les succès < 2 GiB.**
- Les seuils : 2 GiB = `Integer.MAX_VALUE` = 2 147 483 647.

### Chemin d'exécution
Master offre (via `media_ready`) → Storage `storageRun` (`transfer-service.js:198`) → natif `MultiCamTransfer.download` (`MultiCamTransfer.java:221` `conn.getInputStream()`, lecture l.258) → serveur média NanoHTTPD `serveFile` (`NanoHTTPD.java:936`) / `sendResponse` (`NanoHTTPD.java:823`).

### Cause racine [DEM]
Dans `NanoHTTPD.sendResponse` (`NanoHTTPD.java:856`) :

```java
int pending = data.available();   // int ≤ Integer.MAX_VALUE (2 147 483 647)
while (pending > 0) { … pending -= read; }
```

Le **nombre d'octets du corps** est borné par un `int`, alors que l'en-tête annonce la taille réelle en `long` :
- `Content-Length` = `fileLen` (`long`) au chemin 200 (`NanoHTTPD.java:1121`) ;
- `Content-Length` = `dataLen` (`long`) au chemin Range/206 (`NanoHTTPD.java:1108`).

Pour un fichier **> 2 GiB**, `available()` ne peut pas exprimer la longueur (au mieux plafonnée à `Integer.MAX_VALUE`, sur Android possible valeur négative par overflow). Le serveur émet donc **moins d'octets que le `Content-Length` annoncé**, puis ferme le socket ⇒ le client, qui attend `Content-Length` octets, lève `java.net.ProtocolException: unexpected end of stream`, capturé par le `catch` global (`MultiCamTransfer.java:288-290`) → `cb.error("download_failed: ProtocolException: unexpected end of stream")`.

Le défaut est **déterministe et dépendant de la taille** : il se reproduit aux 3 tentatives (le retry ne change rien). Le chemin Range/resume ne l'évite pas (`fis.skip(startFrom)` puis même `available()`/`sendResponse`). Le natif **ne compare pas** `written === total` en fin (`MultiCamTransfer.java:283-286`) et n'aurait donc pas détecté la troncature côté serveur.

> Détail non déterminant : le nombre exact d'octets émis avant fermeture (0 vs ~2 GiB) selon l'implémentation d'`available()` sur Android. **L'invariant « octets émis < Content-Length » pour tout fichier > 2 GiB suffit** à expliquer l'exception.

### Éléments écartés
- **Ce n'est pas un problème réseau/Wi-Fi** : T3-D échoue sans aucun incident, et les trois échecs sont strictement corrélés à la taille > 2 GiB. ⇒ **Ne pas classer ces `ProtocolException` comme de simples erreurs réseau.**
- La re-offre existe (`TRANSFER_OFFER take=5` observée plusieurs fois) mais ne peut pas réussir : le bug est déterministe.

### Aucune récupération automatique — chemin
`downloadWithRetry` : `MAX_ATTEMPTS = 3` (`transfer-service.js:29`), **retry immédiat sans backoff** (`transfer-service.js:237`). Après le 3ᵉ échec : `reportResult(PH_ERROR)` ⇒ terminal. `retry()` (modèle) **n'est appelé nulle part** (grep). Aucune re-offre contrôlée après échec terminal.

### Impact
Tout média **> 2 GiB** échoue de façon irrécupérable par retry ⇒ séquences longues (Takes longs) jamais répliquées ; complétude Storage compromise.

### Correctif proposé (à valider)
Réécrire `sendResponse` pour streamer le corps avec un **compteur `long` borné par la longueur déclarée** (`Content-Length`), et non par `available()`. Optionnellement, contrôle natif `written === total` après téléchargement (défense en profondeur). Backoff borné + reprise contrôlée après échec.

### Risques de régression
Petits fichiers, Range/206, `ETag`/`If-None-Match`, `Accept-Ranges`. À couvrir par tests.

### Tests nécessaires
Fichier > 2 GiB (p. ex. ~2,5 GiB et ~4,4 GiB) servi puis téléchargé → SHA identique ; non-régression < 2 GiB ; test unitaire serveur sur la longueur du corps = `Content-Length`.

---

## D3 — `TRANSFER_DELETE` ACKé mais média non supprimé (`files=0`)

### Symptôme
Le Master reçoit un ACK de suppression, mais le média reste présent sur la Capture ; le log indique `TRANSFER_LOCAL_DELETED … files=0`.

### Preuves [OBS] — corrélation 100 %
`files=0` ⟺ le DELETE arrive **après** le `START_PLAN_ACCEPTED` du **Take suivant** ; `files=1` ⟺ avant.

**Appareil B `61d54bba7d91`** :

| Take | STOP local | DELETE reçu | `files` | Take suivant accepté |
|---|---|---|---|---|
| T1 | 21:06:42.576 | 21:08:09.440 | **1** | T2 plan à 21:08:21.406 (après) |
| T2 | 21:13:38.156 | 21:15:17.878 | **0** | T3 plan à 21:14:33.613 (avant) |
| T3 | 21:24:50.209 | 21:28:44.071 | **0** | T4 plan à 21:26:21.952 (avant) |
| T4 | 21:29:38.282 | 21:33:14.654 | **1** | T5 plan à 21:33:16.108 (après) |
| T5 | 21:48:31.545 | — (échec) | — | — |
| T6 | 21:55:29.911 | — | — | — |

**Appareil D `R83Y106V1HF`** : T1 STOP 21:06:43.510 → DELETE 21:12:25.150 → **`files=0`**.

Compteurs tous logs : `TRANSFER_LOCAL_DELETED take=1 files=1` ×5, `take=1 files=0` ×1, `take=2 files=0` ×4, `take=3 files=0` ×6, `take=4 files=1` ×3 ; `TRANSFER_LOCAL_DELETE_NATIVE files=1 removed=1` ×8.

### Chemin d'exécution
Master `maybeRequestDelete` (`transfer-boot.js`) → `TRANSFER_DELETE` → Capture `captureHandleDelete` (`transfer-service.js:83` `segmentList`) → `listSegments()` (`transfer-boot.js:151`) → `deleteLocalFiles` → `applyTransferDeleteRequest` (modèle) émet `K_TRANSFER_DELETE_ACK`.

### Cause racine [DEM]
`listSegments()` (`transfer-boot.js:151`) lit la vue **courante** du service START :

```
stopStates[self].path || localStopInfo.path
```

Or `start-model.js` remet `stopStates = {}` et `localStopInfo = null` :
- à `START_PLAN_ACCEPTED` (**l.619/624**),
- à l'abandon/cancel (**l.874/879**).

Conséquence : si le DELETE arrive **après** l'acceptation du Take suivant, `listSegments()` renvoie `[]` → `deleteLocal([])` = **no-op** → log `TRANSFER_LOCAL_DELETED take=N files=0` **mais** `applyTransferDeleteRequest` émet l'**ACK inconditionnellement**, et `captureHandleDelete` appelle `model.onIncoming(env)` (ACK) sans condition de résultat.

`files=N` = **nombre de segments résolus** (trouvés), **pas** le nombre réellement supprimés. La suppression effective n'est visible que via `TRANSFER_LOCAL_DELETE_NATIVE … removed=1`.

### Distinctions exigées
- suppression **demandée** : `TRANSFER_DELETE` (Master) ;
- **acceptée** : `K_TRANSFER_DELETE_ACK` — émis même si rien n'a été supprimé ;
- **réellement effectuée** : seulement si la liste est non vide et que le natif renvoie `removed=1` ;
- **différée** : **NON IMPLÉMENTÉE** ;
- **échouée** : **NON SIGNALÉE** — `deleteLocalFiles` avale les échecs par fichier.

### Éléments écartés
- **Ce n'est PAS un refus lié à l'enregistrement** : la garde REC (`isRecording`/`TRANSFER_PAUSE`) est dans le chemin **Storage download** (`transfer-service.js:198`), **pas** dans la suppression. `files=0` provient de la perte de référence, pas d'une garde REC.
- Le risque « suppression du mauvais Take » n'a pas été observé ici, mais est **latent** si un chemin était réutilisé.

### Impact
Médias non supprimés (fuite d'espace) ; **ACK mensonger** ⇒ le Master croit le média supprimé (`deleted[src]=true`, `transfer-model.js:349`) ; divergence d'inventaire.

### Correctif proposé (à valider)
1. **Supprimer par référence propre au Take** (manifest du Take / `stagedMap`), et **non** la vue courante du START.
2. **Idempotence + file de suppressions différées** si le média est absent/en cours de REC.
3. **ACK porteur du résultat** (`removed`/`failed`) ; ne pas ACK « done » si un média attendu reste présent.
4. **Traçabilité** : fichier, SHA, `removed` dans le log/ACK.

### Risques de régression
Supprimer le mauvais Take ; supprimer un média en cours de REC ; mode **SAF** (non exercé ici — `cfg` Storage = `mode:"internal"`).

### Tests nécessaires
DELETE avant/après `START_PLAN_ACCEPTED` ; DELETE pendant REC ; DELETE d'un fichier déjà supprimé (idempotence) ; DELETE de deux Takes en parallèle ; vérifier l'absence de suppression du mauvais Take.

---

## Ce qui n'est PAS la cause (explicitement écarté)

- **Pas de cause commune unique démontrée** entre D1, D2, D3 (D2 est orthogonal).
- D3 **n'est pas** un refus REC.
- D1 **n'est pas** une réintroduction d'état par la persistance de session.
- D2 **n'est pas** un problème Wi-Fi/réseau ; **ne pas** traiter tous les `ProtocolException` comme de simples erreurs réseau.

## Correctifs proposés — récapitulatif (Phase 3, après validation)

1. **D1** : terminal monotone/idempotent + réconciliation à la reconnexion + watchdog de progression borné.
2. **D2** : `sendResponse` avec compteur `long` (fin de l'arithmétique 32 bits) ; backoff borné + reprise contrôlée ; contrôle `written===total`.
3. **D3** : suppression par référence de Take + file différée + ACK porteur du résultat + traçabilité.

## Preuves utilisées (archives J14, lecture seule)

`tests/e2e/validation/J14-endurance/campagne-v2/` :
- `live/tr-A-T2.json`, `live/tr-C-T2.json` (états figés D1) ;
- `logs/campaign.log` (`INC2`), `logs/*-INC2.log` (coupures Wi-Fi), `logs/*.log` (SocketException/ConnectException, ProtocolException, TRANSFER_* ) ;
- `dumps/` (tailles/SHA sources, `cfg-*.json`, timeline) ;
- `reanalyse/delete-order.txt` (corrélation D3) ;
- `RESULTS-J14-ENDURANCE.md` (synthèse campagne).

Code audité : `app/www/js/state/transfer-{service,model,boot}.js`, `app/www/js/state/start-model.js`, `app/www/js/net/session-ws.js`, `app/local-plugins/cordova-plugin-multicam-transfer/src/android/MultiCamTransfer.java`, `app/local-plugins/cordova-plugin-multicam-httpd/src/android/{NanoHTTPD,AndroidFile,CorHttpd}.java`.

## Phase 3 — Confirmation dans le code (D2)

La mission impose, **avant toute modification**, de confirmer le mécanisme exact dans `NanoHTTPD`. Voici la confirmation ligne à ligne (code de `app/local-plugins/cordova-plugin-multicam-httpd/src/android/NanoHTTPD.java` au commit `d4e6fb7`).

### 1. Initialisation de `pending` (le défaut) [DEM]
`sendResponse(...)` écrit le corps ainsi (l.854-865, avant correction) :

```java
if ( data != null )
{
    int pending = data.available();   // ← TYPE int, ≤ Integer.MAX_VALUE = 2 147 483 647
    byte[] buff = new byte[theBufferSize];
    while (pending>0)
    {
        int read = data.read( buff, 0, ( (pending>theBufferSize) ? theBufferSize : pending ));
        if (read <= 0) break;
        out.write( buff, 0, read );
        pending -= read;
    }
}
```

- `pending` est un **`int`**, initialisé par `data.available()` (l.856). `available()` d'un `InputStream` Java est lui-même un **`int`** : par contrat il ne peut renvoyer que `[0 … Integer.MAX_VALUE]`. Pour un fichier de plus de 2 GiB, il est **structurellement incapable** de représenter la taille réelle.
- Le paramètre `data` est le flux du corps, fourni par `serveFile` : `new FileInputStream(f)` complété par `fis.skip(startFrom)` en reprise Range (voir §3).
- `theBufferSize = 16 * 1024` (l.1172). Le corps est donc bien écrit en **streaming par blocs de 16 Kio** ; le problème n'est pas la mémoire tampon mais **la borne totale `pending`**.

### 2. Calcul de `Content-Length` (déclaré, `long`) [DEM]
Le corps réel est **déclaré** en `long` dans `serveFile` :

- chemin 200 (fichier entier) : `long fileLen = f.length();` (l.1082), puis en-tête
  `header.put( "Content-Length", Long.toString( fileLen ) );` (l.1121) ;
- chemin Range / 206 : `long dataLen = …` (intervalle demandé), puis
  `header.put( "Content-Length", Long.toString( dataLen ) );` (l.1108) et
  `header.put( "Content-Range", "bytes " + startFrom + "-" + endAt + "/" + fileLen );`.

⇒ **Incohérence interne du serveur** : l'en-tête annonce un total en `long`, mais la boucle d'émission plafonne le corps à un `int`. `header` est un `java.util.Properties` (clé sensible à la casse) : la clé est bien `"Content-Length"`.

### 3. Réponses Range / reprise [DEM]
- La demande `Range: bytes=<offset>-` est traduite en `startFrom` ; `serveFile` ouvre le fichier et applique `fis.skip(startFrom)` (nécessaire à la reprise), puis appelle le **même** `sendResponse` avec ce flux déjà décalé.
- Le code 200 renvoie le fichier entier (`fileLen`), le code 206 renvoie `dataLen`. Dans **les deux** chemins, `sendResponse` borne l'émission par `available()` ⇒ le défaut affecte **aussi la reprise** : un fichier > 2 GiB ne peut jamais aboutir, ni en direct ni en Range.
- Côté client, `MultiCamTransfer.download` envoie `Range: bytes=offset-` (l.214) et repart de zéro si le serveur répond 200 alors qu'un Range était demandé (l.219-221) : la reprise ne contourne donc pas le défaut.

### 4. Pourquoi tout fichier > 2 GiB échoue [DEM]
- `available()` ≤ `Integer.MAX_VALUE` < `fileLen` (ou < `dataLen`) ⇒ le serveur écrit **strictement moins d'octets que le `Content-Length` annoncé**, puis `sendResponse` se termine et le socket est fermé.
- `HttpURLConnection` client essaie de lire `Content-Length` octets ; le flux se termine avant ⇒ `java.net.ProtocolException: unexpected end of stream`, déclenché à la première lecture (`MultiCamTransfer.java:221` `conn.getInputStream()` / lecture l.258), capturé par le `catch` global (l.294-296) → `cb.error("download_failed: ProtocolException: unexpected end of stream")`.
- **Déterminisme** : identique aux 3 tentatives (`MAX_ATTEMPTS=3`) → `error` terminal. Corrélation 100 % avec la taille (tableau §D2).
- (Selon l'implémentation Android, `available()` peut aussi renvoyer une valeur tronquée ou négative pour un très gros fichier ; **seul l'invariant « octets émis < `Content-Length` » est nécessaire** — le décompte exact n'est pas déterminant.)

### 5. Chemins internes non concernés
`sendResponse` sert aussi des corps **courts** (erreurs, redirections, 304 au corps vide) dont le `Content-Length` est absent : pour ceux-là `available()` reste un repli **correct** (le corps tient dans un `int`). La correction doit donc **préserver ce repli**.

### 6. Correction appliquée (Phase 3) [CORR]
Dans `sendResponse`, la borne `int pending = data.available()` est remplacée par un compteur **`long`** lu depuis l'en-tête déclaré `Content-Length` (repli `available()` si absent), lu toujours **en streaming** par blocs de `theBufferSize` :

```java
long pending = -1L;
if ( header != null ) {
    String cl = header.getProperty( "Content-Length" );
    if ( cl == null ) cl = header.getProperty( "content-length" );
    if ( cl != null ) { try { pending = Long.parseLong( cl.trim() ); } catch ( NumberFormatException nfe ) { pending = -1L; } }
}
if ( pending < 0L ) pending = data.available();
byte[] buff = new byte[theBufferSize];
while ( pending > 0L ) {
    int want = (int)( ( pending > (long)theBufferSize ) ? (long)theBufferSize : pending );
    int read = data.read( buff, 0, want );
    if (read <= 0) break;
    out.write( buff, 0, read );
    pending -= read;
}
```

Aucun chargement intégral en mémoire ; Range/206, reprise à offset, `Content-Range`, `ETag`/304 et petits fichiers sont inchangés. Défense en profondeur ajoutée côté client (`MultiCamTransfer.download`) : si `total > 0 && written != total`, échec explicite `download_truncated: received=… expected=…` (au lieu d'une empreinte trompeuse).

---

## Décision attendue

**Validation du diagnostic avant toute modification du code applicatif** (Phases 3-6 : corrections, tests automatisés, validation physique ciblée, archivage sous `tests/e2e/validation/J14-C01/`). Aucune modification app, aucun `git add .`, aucune relance d'endurance J14 n'a été effectuée.
