# J15 — Phase 2 — Résultats d'implémentation

**Périmètre :** résilience des transferts média MultiCam et reprise automatique
persistante (design `CONCEPTION-REPRISE-AUTOMATIQUE.md`, révision `c4da47b`).
**Autorité :** §4, §5, §7, §10, §15, §16. Les §6.2 et §13.1 sont **obsolètes**
et n'ont pas été implémentés.

**Statut :** IMPLÉMENTÉ (code + tests) — **validation physique NON réalisée**.

---

## 1. Rappel des invariants implémentés

| Invariant | Où |
|---|---|
| `waiting_network` NON terminal, **aucune expiration** | `transfer-model.js` (`TERMINAL`, `isTerminalState`) |
| Backoff exponentiel entre séquences : base 5 s, plafond 60 s, jitter 0,5–1,0 | `transfer-service.js` (`RESUME_BASE_MS=5000`, `RESUME_MAX_MS=60000`, `nextBackoffMs`) |
| `MAX_ATTEMPTS=3` = borne de la séquence HTTP courte | `transfer-service.js` |
| 1 run actif par clé, file bornée (défaut 64) | `transfer-boot.js` (`resumeLocks`, `MAX_RESUME_QUEUE`) |
| Verrou acquis AVANT planification, libéré APRÈS résolution (succès **ou** échec) de `runResume` | `transfer-boot.js` (`scheduleResume`) |
| Timers non accumulatifs | `transfer-boot.js` (`TRANSFER_RESUME_SKIP`) |
| Scan de secours 120 s | `transfer-boot.js` (`RECONCILE_CYCLE_MS`) |
| `waiting_network` publié au Master (`transfer_waiting`) | `transfer-model.js` (`K_TRANSFER_WAITING`), routage `session-ws.js` |
| Watchdog Master : JAMAIS `error` sur simple silence Storage | `transfer-boot.js` (`applyMasterStuck`, `TRANSFER_RECONCILE_WAIT`) |
| Journal versionné `(sessionId,takeNumber,storageDeviceId)` | `transfer-journal.js` |
| Écriture `.tmp` + relecture round-trip + `moveTo` atomique | `transfer-journal.js` |
| Coalescé 1000 ms pour progression, immédiat pour done/error | `transfer-journal.js` (`COALESCE_MS`), `transfer-boot.js` |
| Restauration AVANT watchdog/coordinator | `transfer-boot.js` (`restoreEntryFromJournal` dans `ensureFor`) |
| **JAMAIS `done` d'après le journal seul** → tout restauré en `waiting_network` | `transfer-model.js` (`restoreFromJournal`) |
| SAF : reprise du TRAVAIL à zéro (`offset=0`) | `MultiCamTransfer.java` |
| SHA mismatch : jamais `done`, au plus UNE récupération complète | `transfer-service.js` (`integrityRetryDone`) |
| Classification §4.3 (défaut = transitoire) | `transfer-service.js` (`classifyError`, `reconcile416`) |
| Précontrôle d'intégrité par taille RÉELLE + SHA RÉELLEMENT calculé | `transfer-service.js` (`reuseIfIntact`, `statDest`) |

---

## 2. Tests automatisés exécutés (JS, fakes uniquement)

Commande : `cd app && node tests/run.js`

- **Suite complète : 471 PASS / 0 FAIL.**
- Tests J15 dédiés : **41 PASS / 0 FAIL** (`app/tests/j15-resilience.test.js`).

### Scénarios J15 nominaux (§4/§5/§7/§10/§15/§16)

| Test | Objet | Résultat |
|---|---|---|
| J15.1–J15.6 | journal : `buildDoc`, durabilité, absent, corrompu (CONSERVÉ), version inconnue, purge | PASS |
| J15.7–J15.9 | `restoreFromJournal` : restauration, filtre par take, Master ignoré | PASS |
| J15.10–J15.11 | backoff borné 5→60 s + jitter multiplicatif | PASS |
| J15.12–J15.13 | classification : défaut transitoire ; SAF fatal ; range/réseau transitoire | PASS |
| J15.14–J15.16 | attente non terminale ; SAF terminal ; reprise échouée → attente | PASS |
| J15.17–J15.20 | verrou/1-run-par-clé, file bornée, planification, retour réseau | PASS |

### Scénarios A–E (demandés à l'audit)

| Série | Test | Objet | Résultat |
|---|---|---|---|
| **A** | J15.21 | deux reconnexions rapprochées → **une seule** planification par clé | PASS |
| **A** | J15.22 | watchdog + reconnexion concurrents → aucun doublon de run | PASS |
| **B** | J15.23 | nouvelle instance de boot + journal → transfert reconstruit, **jamais `done`**, métadonnées (taille/SHA) conservées | PASS |
| **B** | J15.24 | après restauration, le scan planifie la reprise (sans intervention manuelle) | PASS |
| **C** | J15.25 | HTTP 416 + destination complète conforme → `done` sans nouveau download | PASS |
| **C** | J15.26 | HTTP 416 + destination incohérente → pas de `done` | PASS |
| **C** | J15.27 | 206 `Content-Range` incohérent → restart contrôlé, reste récupérable | PASS |
| **C** | J15.28 | HTTP 200 (Range ignoré côté serveur) → `done` normal | PASS |
| **D** | J15.29 | taille > 2 GiB conservée sans troncature (modèle) | PASS |
| **D** | J15.30 | offset > 2³¹ transmis au natif sans troncature (`expectedBytes`, `offset`) | PASS |
| **E** | J15.31 | fichier complet + taille ET SHA corrects → **AUCUN** download | PASS |
| **E** | J15.32 | même taille mais SHA différent → **retéléchargement** (taille seule non probante) | PASS |
| **E** | J15.33 | fichier absent (`statDest` null) → download normal | PASS |
| **E** | J15.34 | transfert neuf (aucune métadonnée locale) → précontrôle ignoré, download direct | PASS |

**Point clé E :** la réutilisation n'est prononcée que si le **SHA réellement
calculé** de la destination égale l'attendu. Un fichier de même taille mais SHA
différent est rejeté (J15.32).

### Correctifs post-audit (séries F–I)

| Série | Test | Objet | Résultat |
|---|---|---|---|
| **F** | J15.35 | reconnexion **PENDANT** un `storageRun` non résolu → aucun run concurrent | PASS |
| **F** | J15.36 | verrou libéré APRÈS résolution de `storageRun` (échec inclus) | PASS |
| **G** | J15.37 | écriture coalescée antérieure ANNULÉE par un `done` immédiat | PASS |
| **G** | J15.38 | deux terminaux immédiats consécutifs → le DERNIER fait autorité | PASS |
| **H** | J15.39 | file pleine (`maxResumeQueue=1`) → compteur = **1** et `TRANSFER_RESUME_QUEUE_FULL` journalisé | PASS |
| **I** | J15.19 | réception d'offre → endpoint (host/port/token) mémorisé | PASS |
| **I** | J15.19b | reprise → offre `mode=retry` portant le host/port/token **du Take** | PASS |
| **I** | J15.40 | sans endpoint : AUCUN téléchargement, transfert reste `waiting_network` | PASS |

**Les 4 garanties de l'audit :**

1. **Verrou de reprise** — `scheduleResume` ne libère `resumeLocks[rk]` qu'après
   résolution (ou rejet) de la promesse rendue par `runResume`, et non plus au
   retour synchrone de l'appel (J15.35 / J15.36).
2. **Journal protégé** — une écriture `immediate` (done/error) annule la
   progression coalescée en attente pour ce nom (`pending[name]`), qui ne peut
   donc plus écraser un état terminal plus récent (J15.37 / J15.38).
3. **Compteur `resumeScan()` exact** — `scheduleResume` rend désormais un
   booléen ; seules les planifications ACCEPTÉES sont comptées (`SKIP`, file
   pleine ou timer absent = refus) (J15.18 / J15.39).
4. **Endpoint de reprise** — host/port/token sont mémorisés à la réception de
   l'offre et indexés par `(sessionId, takeNumber)` ; sans endpoint
   exploitable, `buildResumeOffer` rend `null` et `runResume` journalise
   `TRANSFER_RESUME_NO_ENDPOINT` sans rien lancer (J15.19 / J15.19b / J15.40).

**Diagnostic J15.39 (session précédente) :** le test observait `n = 1` sans
aucun `QUEUE_FULL`. Cause réelle : le montage faisait transiter `cap-1` par le
canal `_onTransferMessage`, dont le `storageRun` réel menait le transfert à
`done` ; `markTransferWaiting` refuse légitimement de basculer un TERMINAL, si
bien qu'un **seul** candidat atteignait réellement la file. Le compteur était
donc exact — c'était le **montage du test** qui était faux. Corrigé : `cap-1`
sert de prérequis terminal, et **deux** sources distinctes (`cap-2`, `cap-3`)
sont réellement mises en `waiting_network`, avec une garde-fou
`waitingTransfers().length === 2` qui fait échouer le test si le montage se
dégrade à nouveau.

**Défaut structurel corrigé :** les blocs J15-F..I avaient été insérés à
l'intérieur du `it("J15.34")` (deux `});` orphelins en fin de fichier), ce qui
les faisait enregistrer au moment de l'exécution d'un test plutôt qu'à
l'enregistrement de la suite. Refermés et replacés au niveau `describe`.


### Défauts de production corrigés pendant l'implémentation

1. **`resumeScan` utilisait `w.rel`** absent de `waitingTransfers()` →
   `scheduleResume` rejetait silencieusement (`rel` indéfini) alors que le
   compteur annonçait une planification. Corrigé : `waitingTransfers` expose
   désormais `rels[]`, `resumeScan` planifie **par fichier**.
2. **`persistJournalFor` appelait `e.machine.state()`** (inexistant) →
   exception asynchrone. Corrigé : accès à la propriété `state` (avec repli
   fonction).
3. **`buildResumeOffer` traitait `view().transfers[].files` comme une map** et
   recherchait `cand.srcDid` au lieu de `sourceDeviceId` → offre nulle. Corrigé
   selon le contrat réel de `view()` (clé `src|storage`, `files` = tableau de
   projections `{rel,segmentIndex,bytes,received,sha256,state,error}`).

---

## 3. Garanties vérifiées par INSPECTION (non exécutables en JS)

- `MultiCamTransfer.java` :
  - SAF : `if (treeUri.length()>0 && offset>0) offset=0` + log
    `TRANSFER_NATIVE saf_restart_from_zero`.
  - 206 : validation `Content-Range` via `parseContentRangeStart` →
    `download_range_mismatch: requested=… got=…` si `start != offset`.
  - 200 sur Range : `offset=0` (aucun append).
  - Types d'octets en `long` (aucune troncature 32 bits).
- Le **précontrôle d'intégrité** est déclenché uniquement lorsqu'une destination
  locale peut RÉELLEMENT exister (progression, attente ou tentative antérieure
  enregistrée) ; un transfert NEUF ne subit aucun précontrôle (J15.34), et le
  SHA réel reste l'unique preuve.

---

## 4. Comportements nécessitant une VALIDATION PHYSIQUE (non réalisée)

Ces points dépendent du matériel Android / du système de fichiers et **n'ont pas
été validés** (aucune APK construite, aucune campagne physique) :

1. Écriture/rélecture/`moveTo` atomiques réels du journal sur `getExternalFilesDir`.
2. `PixelCopy`/SHA natif sur fichiers > 2 GiB (offsets réels, pas seulement
   transités).
3. Reprise SAF réelle (re-création du fichier, `offset=0`) et vérification du
   SHA final.
4. Comportement réel du serveur NestJS sur 200/206/416 et en-têtes
   `Content-Range`.
5. Survie du journal à un kill/crash réel et reprise automatique au reboot.
6. Coalescence/immédiateté réelles des écritures journal sous charge.

**Aucune de ces validations n'a été tentée.** Elles relèvent de l'audit puis de
la campagne physique à venir.

---

## 5. Fichiers modifiés (périmètre J15)

- `app/www/js/state/transfer-model.js`
- `app/www/js/state/transfer-service.js`
- `app/www/js/state/transfer-boot.js`
- `app/www/js/state/transfer-journal.js` (nouveau)
- `app/www/js/net/discovery.js`
- `app/www/js/net/session-ws.js`
- `app/www/js/ui/take-stopped.js`
- `app/www/js/ui/storage-view-model.js`
- `app/www/index.html`
- `app/local-plugins/cordova-plugin-multicam-transfer/src/android/MultiCamTransfer.java`
- `app/tests/j15-resilience.test.js` (nouveau)
- `app/tests/j11-transfer-service.test.js`
- `app/tests/j14c01-transfer.test.js`

---

## 6. Réserves techniques

- Les scénarios HTTP Range (C) sont testés **côté JS** via le contrat d'erreur
  natif (`download_http_416`, `download_range_mismatch: …`). La **détection**
  réelle des codes HTTP et l'absence d'append après un 200 restent à prouver sur
  appareil (§4 ci-dessus).
- La réutilisation d'intégrité (E) suppose un `statDest` fiable (taille + SHA
  réels). En production, `statDest` délègue au SHA natif ; l'indisponibilité
  native entraîne un repli sûr (pas de réutilisation, download normal).
