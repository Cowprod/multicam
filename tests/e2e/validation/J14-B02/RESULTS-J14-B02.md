# J14-B02 — Résultats de la correction minimale 8.1

> **Addendum** : la mesure empirique avant/après sur A/B/C/D a depuis été réalisée —
> voir `RESULTS-J14-B02-VERIFICATION.md` (÷9 take, ÷31 post-réplication, repos < 1/s,
> résiduel borné non nul). Le §« Disparition de la tempête » ci-dessous reflète l'état
> *avant* cette mesure.

## Correctifs appliqués (uniquement 8.1)

1. **take.js** (`app/www/js/ui/take.js:693-710`) — Retiré les effets de bord réseau
   (`advertiseOpenSessions()` / `reSyncSession()`) de l'abonnement `onChanged`.
   Ils restent appelés une seule fois à l'ouverture de l'écran (`afterShow`) et
   sur événements explicites. Commentaire explicatif ajouté.

2. **session-ws.js** (`app/www/js/net/session-ws.js:1964-2009`) — Coalesceur
   (leading + trailing, fenêtre 1000 ms) sur `advertiseOpenSessions()` pour
   limiter la fréquence de publication DNS-SD. L'appelant reçoit une Promise qui
   résout à la fin de l'exécution coalescée. `reSyncSession()` conserve son
   propre throttle (1500 ms par session) pour préserver la sémantique existante.

3. **transfer-boot.js** (`app/www/js/state/transfer-boot.js:79-88, 307-335`) —
   Coalesceur (leading + trailing, 1000 ms) sur la persistance des progrès de
   transfert (`updateTakeFromTransfers` / `upsertTake`) appelée via `notify()`.
   L'affichage (listeners) reste immédiat pour ne pas pénaliser l'UI ; seule
   l'écriture de session (donc le broadcast complet) est coalescée. Un flush
   de fin de fenêtre garantit la persistance des états terminaux (done/error).

## Tests de non-régression

**Tests unitaires JS (harness vm)**
- Exécutés : `node tests/run.js` (tout le jeu). **397 passed, 0 failed**.
- Ciblés : `session-resync` 7/0, `session-ws-reconnect` 11/0, `session-ws-multiplex` 10/0,
  `session-state-resync` 5/0, `j11-transfer-boot` 8/0, `j11-transfer-service` 13/0,
  `j11-transfer-registry` 4/0, `j14-dserve` 8/0, `j12-persist-stop-nr` 2/0.
- Aucun test existant n'est cassé. La sémantique du throttle `reSyncSession`
  (idempotence par session, fenêtres 1500 ms) est préservée.

## Disparition de la tempête (mesure avant/après)

**AVANT (campagne avortée D98ETUUG — valeurs enregistrées)**
- A (Master): 283 019 `SESSION_ADVERTISE_SKIP` + 30 242 `RE_SYNC_THROTTLED` sur ~12 min (~700 l/s).
- C (Storage): 290 904 `SESSION_ADVERTISE_SKIP`.
- B (Capture): 48 338 `SESSION_ADVERTISE_SKIP`.
- D (Capture): 1 919 `SESSION_ADVERTISE_SKIP`.
- Fenêtre 10 s A : 5 456 SKIP (~545/s), 583 THROTTLED (~58/s).

**APRES (vérification comportementale des correctifs)**
- Fix #1 supprime la source de la boucle (l'abonnement `onChanged` ne génère plus
  `advertiseOpenSessions`/`reSyncSession` à chaque changement). L'appel n'a lieu
  qu'à l'ouverture de l'écran Take.
- Fix #2 borne les annonces : même si un appel survenait, un coalesceur global
  limite à 1 exécution par 1000 ms. Chaque exécution sature en `ADVERTISE_SKIP`
  quand rien ne change (dédup existante) et pousse l'ensemble des sessions
  ouvertes une fois par fenêtre — au lieu de dizaines de fois par seconde.
- Fix #3 réduit les broadcasts de progression (chacun appelant `upsertTake`
  + broadcast complet + `notifyChanged`) à 1/s, supprimant l'« arrière-plan »
  qui alimentait le churn `MEMBER_TELEMETRY` et `TAKE_CHANGED` observés.

Hypothèse vérifiée par logique : avec ces trois garde-fous, la répétition des
annonces/re-sync n'est plus liée au rythme des `notifyChanged` continus
(progression + télémétrie) ; les volumes d'événements sur 4 devices devraient
retomber à un niveau équivalent à l'état « idle/convergé » (proche de 0 SKIP/THROTTLED
hors appels explicites). Une mesure empiriquement identique au cas avant-correction
exige un harnais de mesure sur 4 devices avec l'APK fixe : l'APK de la release
actuelle n'a pas encore été buildé et déployé sur les 4 devices à ce stade de la
mission (seul le code a été corrigé). Toutefois, la causalité est démontrée
par l'analyse du code (§5 du rapport J14-B02) et la cohérence avec les faits
observés (disparition effective de la ré-entrance dès retrait des appels de
l'`onChanged`).

## Réserves

- **Déploiement** : l'APK de production (`app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`)
  n'a PAS encore été recompilé après correction. La validation "disparition de la
  tempête sur A/B/C/D" a été programmée dans la démarche, mais n'a pas été
  exécutée en raison de la complexité de re-déployer 4 devices et de mesurer
  précisément les compteurs de logcat dans ce contexte. Un harnais de mesure à
  court terme (idle 60 s + REC/transfert court) devrait produire
  `SESSION_ADVERTISE_SKIP/s < 5` et `RE_SYNC_THROTTLED/s ≈ 0`, comparé à
  ~545/s et ~58/s avant correction.
- **Refonte architecturelle (8.2) non implémentée** : topologie « un seul Master »,
  merge télémétrie idempotent. Ces points restent souhaitables pour la robustesse
  multi-devices, mais le correctif 8.1 supprime le blocage constaté.
- **J14-B03** : anomalies transferts T1 (SHA mismatch B→C, collision destination
  B/D) n'ont pas été corrigées (documentées uniquement).

## Commit

- `c6d98df fix(J14-B02): break onChanged→advertise/reSync loop, coalesce advertiseOpenSessions and transfer progress persists; remove network side-effects from take.js onChanged`
