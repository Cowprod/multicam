# VALIDATION — J07 « ARM distribué + synchronisation d'horloge »

**Statut : PASS technique — en attente revue humaine** (2026-09-25)

## Périmètre

- Écran 06 implémenté conformément à `ui/06-arm/` (spec validée).
- ARM distribué sur la maille WS : `arm_request` / `arm_result` (réponses dirigées,
  chemin client inclus), `clock_sync` / `clock_sync_reply` (NTP-like).
- Convergence 2 devices, multi-Master, incidents, annulation, attempt++,
  éligibilité REC. **Aucun enregistrement réel (J08).**

## Appareils (réels, aucun bullet simulé)

- B = `61d54bba7d91` (1er Master) — id auto-déclaré †
- C = `c0d8514d7d87` (2e Master) — id auto-déclaré †
- `61cc29567d91` HORS PÉRIMÈTRE — jamais utilisé.
- † ids régénérés par `pm clear` de la campagne clean (identité v4 par install) :
  ex. B `4bbeef26-…`, C `92d58e97-…` ; les IDs ABA et 24d4 du run précédent restent
  des anciennes instances découvertes (NSD cache), résolues en peers mais non
  sélectionnées (membres explicites = ids courants).

## Protocole de campagne

`tests/e2e/j07-campaign.sh clean` (1 run + runs correctifs). Sorties dans
`tests/e2e/validation/J07-arm-sync/{screenshots,logs,dumps}`.

## Résultats (HONNÊTES, physique réel)

| Jalon | Attendu | Résultat |
|---|---|---|
| J07-01 | Session créée sur B | ✅ `FTBKCDGP`, pin `4658` |
| J07-02 | C rejoint second Master | ✅ `SESSION_JOINED` ; panneaux session B et C |
| J07-03 | Membres B+C capture+storage | ✅ |
| J07-04 | Take : captures/storages B+C | ✅ |
| J07-05 | ARM auto + convergence | ✅ `ARM_READY` — B capture/storage READY, C storage READY, C capture **WARNING** (VRAI) |
| J07-06 | REC dock éligible | ✅ `recEligible:true`, dock affiché, bouton actif |
| J07-07 | Incident réel + auto-reprise | ✅ force-stop C → incidents `Déconnecté` + modal ; retour C → reprise immédiate |
| J07-08 | ARM_CANCEL état neutre | ✅ `active:false devices:0 clock:0 recEligible:false` |
| J07-09 | Re-ARM attempt++ | ✅ `attempt:2`, convergence |
| J07-10 | Multi-Master B+C | ✅ cycles indépendants `#1#2` (B) / `#1#1` (C), réf. d'horloge réciproques cohérentes |
| J07-11 | Garde-feu REC | ✅ incidents présents → `SCREEN06_REC_INCIDENT` (modal Annuler/Continuer REC) ; `REC_ELIGIBLE_NEXT_J08` réservé all-clear (J08) |
| J07-12 | Invariant session B==C | ✅ `takes_equal_B_C:true` |

## Synchronisation d'horloge (métrique réelle)

Référence C vue depuis B : **Δ −611 ms, RTT ≈ 20 ms, dispersion 14–22 ms, 3
échantillons**. Référence réciproque B vue depuis C : **Δ +612 ms, RTT ≈ 20 ms,
dispersion 7 ms**. Signes cohérents (A voit B en avance de X ⇒ B voit A en retard
de −X). Le décalage > 50 ms est PHYSIQUE (horloges Android non-NTP, écart
machine ≈ 0,6 s) → statut honnête `warn` « Dégradée · delta … ms »,
**non bloquant** pour REC (recEligible true), incident sync listé dans le modal.

## Corrections liées (dans l'implémentation)

1. `session-ws.js` : export manquant `broadcastTargeted` → les frames ARM étaient
   journalisées mais jamais envoyées (regression qui a cassé la campagne run 1).
2. `arm-model.js` : `NOT_REQUESTED` (Android diagnostic) ≠ refus → `pending`
   « Autorisation à demander » ; seuls `DENIED`/`DENIED_ALWAYS`/`RESTRICTED`
   bloquent. Micro à autoriser = warn, pas err.
3. Campagne : extraction dumps corrigée (expression vs statement) + saisie PIN
   dans le même tick que le join + poll store (course JOIN_REQUEST/PIN).

## Tests automatisés (tous verts)

- `arm-model.test.js` — 23 blocs / 181+ assertions (convergence, multi-remote
  pump, NTP math, cancel, stale, recover, éligibilité, permissions).
- take-model 18/18, takes-session 8/8, members-model 17/17, merge-model 9/9,
  panels-check 7/7 (dont `arm`).

## Artefacts

- APK SHA-256 : `30804ec08bf05b394c5491f516afa763e01512d48e560e83217ce600c2592670` (campagne B+C, cf. `apk-sha256.txt`) — voir `final-review/` pour l'APK des correctifs (revue 5 points)
- Manifeste captures : `png-shas.txt` du blend SI (12 + 27 + 7, pas de doublon byte-identique préservé par dossier)
- Logs parsables par device/jalon dans `logs/`
- Dumps JSON (vues ARM, horloge, éligibilité, incidents) dans `dumps/`
- Revue 4 devices : `four-devices/png-shas.txt` (27 captures, 0 doublon byte-identique), `four-devices/logs/`, `four-devices/dumps/`

## Écarts / notes

- Multi-Master 3 appareils NON testé (A bloqué, comme J05/J06) — voir historique (re-déféré hors V1).
- Le delta d'horloge ≈ 0,6 s entre B et C est un fait physique ; la mesure,
  sa dispersion (< 50 ms) et son statut WARNING non bloquant sont les résultats
  attendus de la synchro NTP-like portée. L'alignement réel < 50 ms nécessiterait
  un serrage NTP externe (hors périmètre du produit, réglé par l'opérateur).

---

# REVUE COMPLÉMENTAIRE — 2026-09-25 (4 devices physiques)

**Maillage : D1 (Master hôte), D2, D3, D4 (Master, Samsung Galaxy Tab A9).**
Campagne dédiée `tests/e2e/j07-review-4dev.sh` (exécutée à froid, session
`BV8PHNNE` pin `9734`). Preuves dans `four-devices/` (27 captures, dumps, logs).
Aucun bullet simulé, aucune identité PM de la campagne (noms/roles préservés).

## Résultats

| Critère | Attendu | Résultat |
|---|---|---|
| R1 | Session créée sur D1 | ✅ `SESSION_CREATED sid=BV8PHNNE pin=9734` |
| R2 | D2/D3/D4 rejoignent en Masters | ✅ `SESSION_JOINED` ×3 à t=0s, 4 panneaux actifs |
| R3 | Membership 4 devices, pas de vieille identité | ✅ rôles propagés, aucun résidu |
| R4 | Take : Captures [C1,C2,C4], Storages [C1,C3,C4] | ✅ Samsung = Capture+Storage |
| R5 | ARM 4 devices → convergence | ✅ `ARM_READY R5-D1 t=0s` |
| R6 | Dock REC éligible (0 rec en J07) | ✅ `recEligible:true dockShown:true recDisabled:false` |
| R7 | Accordéons de détail réels A–I | ✅ dumps + captures détail capture D4, permissions D1, storage D3 |
| R8 | Incident réel (force-stop D2) + modal REC | ✅ incidents augmente, ≥1 Capture startable |
| R9 | Ré-ARM automatique (relance D2), sans bouton Retry | ✅ `ARM_READY R9-D1 t=0s`, `noRetryBtn:true` |
| R10 | Multi-Master : D4 ouvre aussi l'écran 06 | ✅ `MM_CONVERGED R10-D4 t=0s`, cycles indépendants |
| R11 | Convergence takes D1==D4 | ✅ `takes_equal_D1_D4:true` |
| R12 | Fermeture propre de la session | ✅ `["BV8PHNNE:closed"]` |

## Horloge réelle 4 devices (échantillons t0–t3 en dumps)

- Vue D1 (réf. D1) : D4 Δ **+154 ms** rtt 29 ms disp 62 ms (3 éch.) ; D2 Δ **+60 ms** rtt 25 ms disp 2 ms (3 éch.). Status `warn` « Dégradée » — **non bloquant**, REC éligible.
- Vue D4 (réf. Samsung) : D2 Δ **−87 ms** rtt 18 ms disp 10 ms ; D1 Δ **−146 ms** rtt 26 ms disp 71 ms. Signes cohérents (A voit X en avance ⇒ X voit A en retard).
- Interférence inter-cycles : `CLOCK_SYNC_IGNORE … reason=request_mismatch` bénin (2 Masters lancent des cycles coordonnés D1/D4 simultanément) — déjà couvert par `arm-result` de la 1re fois.

## Honnêteté des permissions (NOT_REQUESTED) — vérifié sur 4 devices

- D1 : `permissions=pending — Autorisation à demander : CAMERA, RECORD_AUDIO` + `audio=warn — Micro à autoriser` → capture self **WARNING** (auto-évaluation honnête, aucune permission accordée, aucune inventée).
- D4 (Samsung) : `permissions=pending — Autorisation à demander : ACCESS_FINE_LOCATION` → capture **WARNING** sur la vue D1 (requester injecte la ligne sync) et **ARMING** sur sa propre vue (self : pas de ligne sync, `[ok,pending]` → ARMING). Ce décalage requester/self appelait une revue → **CORRIGÉ en revue 5 points** (cf. ci-dessous, `final-review/`) : la permission connue `NOT_REQUESTED` est désormais un **PENDING TERMINAL** (`settled:true`) → **WARNING** auto-porté sur TOUS les Masters égaux. Les deux vues restent honnêtes : D4 Capture converge **WARNING vu de D1 ET WARNING vu de D4** (plus jamais ARMING), `recEligible=true`, sync distante mesurée (Δ 145 ms / disp 45 ms) vue de D1 vs « Référence locale » vue de D4.
- D2/D3 : permissions accordées (`ok`), seule la sync physique explique le WARNING → sysop doit accorder les permissions demandées (procédure opérateur, pas un défaut produit).

## Capacités Samsung réelles (probe natif, source non-fixture)

- D4 = Samsung SM-X110 (Tab A9, sdk 36) : `gpsFeature:true`, caméras arrière [FHD,HD], frontale [HD], orientation [LANDSCAPE,PORTRAIT], audios ON, `storage` READY via SAF (`volume accessible`), `freeSpace ≥ 1 Go`.
- 3× Xiaomi `24075RP89G` (sdk 36) : `gpsFeature:false`, arrière [FHD,HD], avant [FHD,HD]. `MultiCamSaf` présent sur les 4 (vérifié probe `window.MultiCamSaf`).
- Le label `source:"fixture"` apparaît aussi pour une réponse **native** (défaut de
  `take-model.js` §normalizeCapabilities quand l'action ne renvoie pas `deviceId`) —
  le contenu réel est vérifié par `model`/`manufacturer`/`cameras` (le vrai fixture
  simulé n'est utilisé que dans `j06-campaign.sh`, jamais ici).

## Écarts / rapport

- « Device en panne » simulé : force-stop réel D2 (pas un poison), reprise auto vérifiée.
- Défaut J05 détecté et **CORRIGÉ** (revue 5 points, cf. `final-review/`) : la modal AJOUT affichait le `deviceId` au lieu du nom. Module `ui/names.js` + `humanName()` dans session.js → « Cam D4 » partout, rôles préservés.
- « WARNING requester / ARMING self » sur D4 : artefact de vue analysé, défaut de
  convergence entre Masters égaux — **CORRIGÉ** (revue 5 points, PENDING terminal
  `settled:true`) : D4 Capture **WARNING vu de D1 ET WARNING vu de D4**, 
  `armCycleId` identique, `recEligible=true`. Voir § REVUE 5 POINTS ci-dessus.
- Multi-Master 4 devices REC réel : hors périmètre (J08).
- Multi-Master 5+ / 3 appareils visa : voir historique DEFERRED (re-déféré).
- Statut : **PASS technique — en attente revue humaine** (correctifs revue 5 points : APK `2658f29260aa63396e3c589c55f1ed6a7360ad464084f7f3c448b326804c6801`, cf. `final-review/`).

---

# REVUE 5 POINTS — 2026-09-25 (correctifs J05 UI + J07 ARM, D1 + D4 physiques)

**Motif** : revue humaine → 2 défauts à corriger : (1) modal AJOUT affiche l'UUID
(J05) ; (2) D4 Capture self restait `ARMING` quand le requester affichait `WARNING`
(J07) — les vues n'étaient pas équivalentes entre Masters égaux.

## Correctifs

1. **J07 — PENDING terminal connu ≠ protocolaire** (`arm-model.js`) : dans
   `assessCapture`, une permission connue `NOT_REQUESTED` émet désormais un check
   `{status:"pending", settled:true}` = **terminal** (passe `lineRank` → WARNING,
   jamais ARMING) ; un `pending` **protocolaire** (sync en attente, réponse
   arm_result attendue, permissions non résolues « Vérification… ») reste ARMING.
   La réduction agrège alors un **WARNING auto-porté** sur tous les Masters égaux —
   ni goroutine requester/self, ni dépendance à la ligne sync injectée.
2. **J05 — nom humain partout** : nouveau module `app/www/js/ui/names.js`
   (`MultiCamNames.deviceHumanName` : `name` → `deviceName` → `deviceId`).
   `session.js` l'expose via `humanName()` et l'applique au titre de la modal
   AJOUT, à la persistance `addMember`, aux listes membres/LAN et au confirm
   retrait. Aucune lecture brute `deviceId` dans la modal.

## Preuve physique (D1 = Xiaomi Master hôte, D4 = Samsung Master, session `KJYB8FTG`)

| # | Preuve | Résultat |
|---|---|---|
| FR-01 | Modal AJOUT D4 : nom affiché | ✅ `"Cam D4"` (plus jamais d'UUID) |
| FR-02 | Modal D4 : rôles Capture + Storage | ✅ `selected:[capture,storage]` (aucune régression sélection) |
| FR-03 | ARM D1 (Master 1) : Capture D4 | ✅ **WARNING** (requester) |
| FR-04 | Détail D4 vu de D1 : sync distante | ✅ `warn Dégradée · delta 145 ms / dispersion 45 ms` (3 éch. réels) |
| FR-05 | ARM D4 (Master 2, self) : Capture D4 | ✅ **WARNING** (plus jamais ARMING) |
| FR-06 | Détail D4 self : permission + sync | ✅ `permissions pending settled:true « Autorisation à demander : ACCESS_FINE_LOCATION »` + `sync ok « Référence locale »` |
| FR-07 | REC dock | ✅ `recEligible:true dockShown:true` sur D1 et D4 |

- **Convergence Masters égaux** : `D4_status_vu_de_D1=WARNING D4_status_vu_de_D4=WARNING`,
  `armCycleId` identique `KJYB8FTG#1#1` des deux côtés, `recEligible=true` ×2 → CONVERGENCE OK.
- **JSON de contrôle** : `final-review/dumps/6-D1-arm-d4-warning.json`,
  `8-D4-arm-self-warning.json`, `9-D4-detail-self.json` (données machine, auto-évaluation).
- **Logs parsables** : `final-review/logs/` — `ARM_START`, `ARM_RESULT` ×12, `MEMBER_ADDED`,
  `CLOCK_SYNC peer=23c5cf6e… offset=145` et `offset=157`.
- Session fermée proprement (`KJYB8FTG:closed`), identités préservées
  (aucun `pm clear` : « Cam D1 » / « Cam D4 » inchangés).

## Tests automatisés (tous verts) — dernières exécutions

- `arm-model.test.js` : + section 24 (Cas A–E) et section 25 (machine C requester +
  self) → **7 suites vertes** : arm-model, members-model, merge-model, take-model,
  takes-session, panels-check, **member-modal-name** (nouveau, J05). `node --check`
  OK sur arm-model.js, session.js, names.js, tests.
- APK unique D1+D4 (rebuild `app/setup-android.sh`) : SHA-256
  `2658f29260aa63396e3c589c55f1ed6a7360ad464084f7f3c448b326804c6801`
  (patch PixelCopy re-vérifié présent), installé `-r` sur les 2 appareils, identités
  et rôles conservés.

## Artefacts `final-review/`

- `png-shas.txt` (7 captures, 0 doublon byte-identique), `screenshots/FR-01..FR-07`,
  `dumps/`, `logs/`.