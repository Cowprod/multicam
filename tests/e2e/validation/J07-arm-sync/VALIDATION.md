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

## Écarts / notes

- Multi-Master 3 appareils NON testé (A bloqué, comme J05/J06) — DEFERRED.
- Le delta d'horloge ≈ 0,6 s entre B et C est un fait physique ; la mesure,
  sa dispersion (< 50 ms) et son statut WARNING non bloquant sont les résultats
  attendus de la synchro NTP-like portée. L'alignement réel < 50 ms nécessiterait
  un serrage NTP externe (hors périmètre du produit, réglé par l'opérateur).