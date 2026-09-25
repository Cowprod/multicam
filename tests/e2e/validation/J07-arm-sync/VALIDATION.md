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

- APK (identique B et C) SHA-256 : `30804ec08bf05b394c5491f516afa763e01512d48e560e83217ce600c2592670` (cf. `apk-sha256.txt`)
- Manifeste captures : `png-shas.txt` (13 captures, pas de doublon byte-identique)
- Logs parsables par device/jalon dans `logs/`
- Dumps JSON (vues ARM, horloge, éligibilité, incidents) dans `dumps/`
- Revue 4 devices : `four-devices/png-shas.txt` (27 captures, 0 doublon byte-identique), `four-devices/logs/`, `four-devices/dumps/`

## Écarts / notes

- Multi-Master 3 appareils NON testé (A bloqué, comme J05/J06) — DEFERRED.
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
- D4 (Samsung) : `permissions=pending — Autorisation à demander : ACCESS_FINE_LOCATION` → capture **WARNING** sur la vue D1 (requester injecte la ligne sync) et **ARMING** sur sa propre vue (self : pas de ligne sync, `[ok,pending]` → ARMING). **Les deux vues sont honnêtes** (§33), `recEligible=true` dans les deux cas. Décalage requester/self = artefact de vue, pas un défaut.
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
- Défaut préexistant NOTÉ (hors correctif J07, à documenter) : à l'AJOUT d'un membre,
  la modal affiche le `deviceId` au lieu du nom (lecture `deviceRow.deviceName`,
  clés de découverte `name` — J05). Non bloquant pour ARM.
- Multi-Master 4 devices REC réel : hors périmètre (J08).
- Statut : **PASS technique — en attente revue humaine** (mêmes APK `30804ec0…2670`).