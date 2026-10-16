# INCIDENT J14-B02 — BLOQUANT

## Tempête d'annonces / re-synchronisation (onChanged → advertiseOpenSessions / reSyncSession)

- **Sévérité** : BLOQUANT (empêche toute campagne d'endurance ≥ 60 min ; bloque le
  pilotage CDP et sature l'UI).
- **Découvert** : campagne J14 (`tests/e2e/validation/J14-endurance/campagne-v1/`),
  15/10, avortée au **Take 2**.
- **Statut** : **diagnostiqué, NON corrigé** (aucune modification de code). En
  attente d'accord explicite avant toute correction.
- **APK** : référence, md5 `316873cd718b9c2894e94fe076162f15` (identique A/B/C/D).
- **Aucune** modification applicative, **aucune** suppression de média/session.

---

## 1. Résumé

Lors d'une session à **4 devices** (A Master, B/D Captures, C Storage), l'app
entre dans une **boucle auto-entretenue** dès ~24 s après la création/jonction de
la session. Chaque changement de session déclenche, sur l'écran Take, des appels
réseau (`advertiseOpenSessions` + `reSyncSession`) ; ces appels — combinés à une
**topologie en maillage complet** (chaque device est « master » et diale tous les
autres) et à des **changements continus** (progression de transfert + télémétrie)
— produisent des dizaines de milliers d'évènements par minute. Le thread JS de la
WebView est saturé, si bien que :

- les évaluations CDP (`Runtime.evaluate`) **expirent** (timeout 120 s) ;
- le harnais n'a **pas pu créer le Take 2** (`newTake` → `out=vide` ×3 → FATAL) ;
- l'UI et les commandes (ARM/REC/STOP) subissent une latence croissante.

La campagne a été **arrêtée** ; preuves et médias préservés.

---

## 2. Reproduction / scénario

1. Session neuve + jonction de **4 devices** (A, B, C, D) — D = tablette en
   Wi-Fi (`192.168.92.103:5555`), B/C en USB.
2. Take 1 (REC 120 s) : fonctionne (REC/STOP OK sur A, B, D).
3. Incident 1 : coupure Wi-Fi de B 30 s puis rétablissement.
4. Tentative de **Take 2** → échec (voir §3).

Repro minimale observée : la tempête démarre **avant** tout incident, peu après
la jonction des 4 devices (elle est donc **structurelle**, l'incident/transferts
ne font que l'amplifier).

---

## 3. Symptômes (extraits du log harnais)

```
### TAKE T2 : nouvel Take ...
  WARN newTake sans numero (att=1 prev=1 out=vide)
  WARN newTake sans numero (att=2 prev=1 out=vide)
  WARN newTake sans numero (att=3 prev=1 out=vide)
  FATAL newTake echoue (prev=1) / ABORT T2 / FATAL T2
```

`newTake` s'exécute côté app mais l'évaluation CDP ne revient jamais (timeout
`CDP_FATAL cdp_timeout`). Le `MultiCamSessionStore.save()` **n'est pas** la cause
(lecture OK ; `save` OK sur B et D). C'est le **thread WebView saturé**.

---

## 4. Preuves (comptages live logcat, buffer 16 Mo)

| Device | SESSION_ADVERTISE_SKIP | RE_SYNC_THROTTLED | Remarque |
|---|---:|---:|---|
| A (Master) | **283 019** | **30 242** | ~531 928 lignes en ~12 min (~700 l/s) |
| C (Storage) | **290 904** | — | le plus chargé |
| B (Capture) | 48 338 | — | |
| D (Capture) | 1 919 | — | |

- Fenêtre glissante de 10 s sur A : **7 456 évènements/10 s**, dont
  `SESSION_ADVERTISE_SKIP` 5 456 (**~545/s**) et `RE_SYNC_THROTTLED` 583.
- Première occurrence sur A : `16:33:29.445 RE_SYNC_THROTTLED sessionId=D98ETUUG dt=818ms`
  (~24 s après création 16:33:05).
- Comparaison **D-SERVE run3** (3 devices, PASS) : A=8 941 `ADVERTISE_SKIP`,
  **0 `RE_SYNC_THROTTLED`** → ×30 en 4 devices, apparition d'un comportement
  **nouveau**.
- Dumps complets : `campagne-v1/dumps/DIAG-A-runaway-loop.log` (A),
  `DIAG-B-full.log`, `DIAG-C-full.log`, `DIAG-D-full.log`.

Origine des évènements sur A (fenêtre 10 s) :

```
TAKE_CHANGED/RECEIVED : from B=233, from D=148, from A=38  (~38 notifications/s)
MEMBER_TELEMETRY      : learned_from B=245, D=121, C=12    (~37/s)
TRANSFER_PROGRESS     : 82/10 s
```

→ Ce sont **les Captures (B et D) qui poussent en continu** les mises à jour, A
les reçoit et réagit.

---

## 5. Chaîne causale (cause racine)

### 5.1 Topologie en maillage complet (amplificateur structurel)

- `handleJoinRequest` ajoute **chaque joignant** comme « master »
  (`session-ws.js:1379` `model().upsertMaster(s, selfInfo)`).
- Résultat : `masters[]` contient **les 4 devices avec `endpoint`** :
  ```
  masters = A(9d714526…:45102), B(19848326…:45102), C(ece36247…:45102), D(d618012d…:45102)
  ```
- Chaque device sert **et** diale tous les autres → **connexions dupliquées** :
  `status()` sur A = `serverConns:3, clientConns:3` → `SYNC_BROADCAST ... peers=6`
  pour 4 devices.
- Conséquence : chaque `broadcast`/`sync_please` part en double vers chaque pair,
  et `reSyncSession` fan-out vers **tous** les autres « masters ».

### 5.2 Effets de bord réseau dans l'abonnement `onChanged` (déclencheur)

`app/www/js/ui/take.js:693-704` (`ensureReactive`) :

```js
global.MultiCamSessionWs.onChanged(function () {
  if (!state.sid) return;
  store().get(state.sid).then(function (s) {
    ...
    if (s.state === "open") {
      global.MultiCamSessionWs.advertiseOpenSessions();   // NON throttlé
      global.MultiCamSessionWs.reSyncSession(s);          // throttlé 1,5 s
    }
    publishSelfTelemetry(false);
  });
});
```

À **chaque** changement de session, l'écran Take ré-émet des annonces et re-diale
les Masters. Or ces opérations **génèrent elles-mêmes des changements** (sync →
`notifyChanged`), donc l'écran se re-déclenche : **boucle**.

### 5.3 Changements continus + convergence imparfaite (moteur)

- **Progression de transfert** écrite dans le Take (B et D servent C) → `take_update`
  → `broadcast` du **sharedView complet** (peers=6) → chaque pair applique →
  `notifyChanged` → `onChanged` → advertise/reSync…
- **Télémétrie** : `semanticEqual` (`session-ws.js:104-106`) traite toute différence
  de `telemetry` comme sémantique ; les `updatedAtMs` propres à chaque publication
  font que les snapshots relus ne « convergent » pas — `MEMBER_TELEMETRY` mesuré à
  **~37/s** alors que la cadence nominale est 1/5 s/device (`0,8/s` attendu).
- Le garde anti-écho `MERGE_NOOP` (`session-ws.js:1288-1292`, via `semanticEqual`)
  **n'arrête que** les échos où *seuls les Takes* changent (il **ignore `takes`**,
  `session-ws.js:83-113`) ; il ne couvre pas le churn télémétrie/`broadcast`.

### 5.4 Pourquoi throttle et dédup ne suffisent pas

- `reSyncSession` est throttlé **1/reSyncSession par 1 500 ms et par session**
  (`session-ws.js:2004-2010`) — mais ce throttle **ne s'applique qu'au re-dial
  `sync_please`**, pas à `advertiseOpenSessions` (appelé juste à côté, **sans
  aucun throttle**), ni à la ré-entrance de l'abonnement `onChanged`.
- `advertiseOne` déduplique l'appel natif via `advertisedKey` (émet
  `SESSION_ADVERTISE_SKIP`), mais **le coût JS** (parcours de 9 sessions × ~58
  `onChanged`/s ≈ **545 appels/s**) reste entier — c'est précisément ce qui sature
  la WebView.
- La télémétrie (service) a bien une cadence 5 s, mais `notifyChanged` est appelé
  à chaque **message entrant** de chaque pair (full mesh) : la cadence de trafic
  n'est bornée par rien côté réception.

---

## 6. Impact

- **CPU / WebView** : thread JS saturé. A ≈ 700 lignes/s ; C encore plus. `Runtime.evaluate`
  (CDP) **timeout** → pilotage de test impossible.
- **UI** : `render()` + `store().get()` sur chaque changement → latence, risque de
  commandes manquées pendant une prise réelle.
- **Réseau** : broadcasts `sync`/`take_update` en **maillage complet** (double
  connexion par pair, `peers=6`), + `sync_please` fan-out. `DNS-SD` : appels
  `advertiseSession` réels dès que la clé change.
- **Stockage** : `SESSION_STORE_SAVE` ×15 621 sur A en ~12 min → écritures
  fréquentes (IO/batterie).
- **REC / STOP** : le Take 1 a fonctionné alors que la tempête montait ; la
  dégradation est **cumulative** → risque de STOP tardif/perdu sur session longue
  (critère J14 non tenable en l'état).
- **Transferts en cours** : voir §7 — la tempête n'empêche pas le transfert natif
  de progresser, mais interfère avec sa comptabilité et a exposé 2 défauts.

---

## 7. Conséquences observées sur les transferts (T1)

- **D → C : `state=done`**, SHA identiques (`e66210d6…`), fichier local D supprimé.
  C contient bien le fichier de D (`806 630 169` o).
- **B → C : `state=error`**. Le téléchargement natif a terminé
  (`TRANSFER_NATIVE download done received=320389134 total=320389134 sha256=354df18d…`)
  **mais** :
  - `TRANSFER_HASH take=1 sourceSha256=2fce5c8b… storageSha256=354df18d…` → **mismatch** ;
  - `TRANSFER_FILE_ERROR ... SocketTimeoutException: timeout` (retry pendant la tempête).
  - Vérification directe : le fichier **local de B** a bien pour SHA-256
    **`2fce5c8b…`** (= `sourceSha256`). Le contenu répliqué (`354df18d…`, **même
    taille**) diffère du fichier source → **intégrité non garantie** (reprise/Range
    suspecte après timeout).
- **Collision de destination** : `transfer-boot.js:121` `destFor(sid, take, rel)`
  → `MultiCam/<sid>/<take>/<rel>` avec `rel = "videoTmp.mp4"` **sans deviceId**.
  B et D visent donc le **même chemin** `D98ETUUG/1/videoTmp.mp4` sur C →
  écrasement. Constaté : C ne contient **qu'un seul** fichier (celui de D, 806 Mo),
  celui de B a disparu.

> Ces 2 points dépassent strictement le périmètre de la boucle (J14-B02) et
> constituent des anomalies **distinctes** à confirmer/classer (proposition :
> **J14-B03 — intégrité/écrasement des transferts multi-captures**). Non traités
> ici (pas de correction sans accord).

---

## 8. Correctif minimal proposé (À NE PAS APPLIQUER sans accord)

Objectif : **casser la boucle** au moindre risque, sans changer le protocole ni
la topologie (réservés à une décision d'architecture).

### 8.1 Correctif testable recommandé (faible risque)

1. **`ui/take.js` — retirer les effets de bord réseau de `onChanged`.**
   `advertiseOpenSessions()` + `reSyncSession()` ne doivent **pas** s'exécuter à
   chaque changement. Les conserver uniquement là où ils ont un sens :
   `afterShow()` (ouverture/retour d'écran) et sur mutations explicites de
   composition (ajout/retrait de membre). Le handler `onChanged` se limite à
   rafraîchir l'affichage (`get`/`render`/télémétrie).

2. **Coalescer les opérations de convergence côté `session-ws.js`.**
   Introduire un **coalesceur** (leading + trailing, intervalle mini, p.ex. 1000-2000 ms,
   par session) pour `advertiseOpenSessions` **et** `reSyncSession` : au plus une
   salve par fenêtre, regroupant les demandes. Cela borne `ADVERTISE_SKIP` et les
   `sync_please` même si `onChanged` reste bavard.

3. **Borner les broadcasts de progression.** Regrouper les `take_update` issus de
   `TRANSFER_PROGRESS` (throttle/coalesce, p.ex. 1/s) et **ne pas** diffuser un
   `sharedView` complet pour un simple avancement (delta ou compteur dédié).

### 8.2 Correctifs structurels (à décider, plus lourds)

4. **Topologie** : ne pas inscrire chaque joignant comme « master ». Un seul
   Master/Controller persistant ; les Captures/Storage sont des **membres**
   (`members[]`), pas des masters. Supprime le maillage complet (`peers=6`),
   les connexions dupliquées et le fan-out `reSync`.
5. **Convergence télémétrie** : rendre le merge **idempotent** (comparer le contenu
   sémantique sans `updatedAtMs` local, ou ne pas re-stamper à la réception) afin
   qu'un même snapshot appliqué deux fois ne produise plus d'évènement.

> La combinaison **8.1 (1+2+3)** suffit a priori à supprimer le blocage observé.
> Les points 8.2 (4+5) traitent la cause de fond et l'amplification multi-devices.

---

## 9. Tests de non-régression nécessaires

**Unitaires (JS, hors device)**
- `mergeSessions` **idempotence** : appliquer 2× le même snapshot distant →
  le 2ᵉ merge ne doit produire **aucun** `changed`/évènement (télémétrie et takes).
- `telemetryWinner` : déterminisme et stabilité (même entrée → même gagnant, aucune
  oscillation entre deux snapshots identiques).
- `semanticEqual` : couvre bien télémétrie/membres ; documenter explicitement le
  traitement des `takes` (actuellement ignorés).
- Coalesceur (nouveau) : N demandes en rafale sur une fenêtre → **1** salve émise.

**Intégration device (harnais)**
- **Repos 4 devices, 120 s, sans prise** : mesurer `SESSION_ADVERTISE_SKIP/s` et
  `RE_SYNC_THROTTLED/s` → doivent être **proches de 0** (seuil p.ex. < 5/s) ;
  parité **3 devices** (D-SERVE) conservée (`RE_SYNC_THROTTLED = 0` attendu).
- **Latence CDP sous charge** : pendant une REC avec **2 captures transférant**,
  `Runtime.evaluate` p95 < 500 ms ; `newTake` d'un Take suivant **réussi** pendant
  qu'un transfert du Take précédent tourne.
- **REC/STOP sous charge** : ARM/REC/STOP dans les bornes nominales sur 4 devices
  pendant 10 min.
- **Transferts multi-captures** (traite aussi J14-B03) : 2 captures → 1 storage,
  même Take → **2 destinations distinctes**, 2 fichiers présents, SHA(source) =
  SHA(destination) pour chacun ; pas d'écrasement.

---

## 10. Annexes (preuves)

- Harnais : `tests/e2e/j14c-campaign.sh` ; log : `campagne-v1/logs/campaign.log`,
  `/tmp/j14c.log`.
- Dumps boucle : `campagne-v1/dumps/DIAG-A-runaway-loop.log`,
  `DIAG-B-full.log`, `DIAG-C-full.log`, `DIAG-D-full.log`.
- Fenêtre analysée : `campagne-v1/dumps/` (comptages §4).
- Rapport d'avortement : `campagne-v1/ABORT-DIAGNOSTIC.md`.
- Session persistée (preuve `masters[]` complet) : `run-as … files/sessions/D98ETUUG.json`.
- Code concerné :
  - `app/www/js/ui/take.js:693-704` (onChanged → advertise/reSync).
  - `app/www/js/net/session-ws.js:1379` (join → upsertMaster),
    `:1897-1914` (broadcast), `:1984-2010` (reSyncSession + throttle),
    `:1964-1972` (advertiseOpenSessions), `:1240-1314` (handleSync/handleSyncPlease).
  - `app/www/js/state/session-model.js:505-519, 650-671` (merge télémétrie).
  - `app/www/js/state/transfer-service.js:217-238`, `transfer-boot.js:121-128`
    (destination de transfert, hors périmètre J14-B02).
